/**
 * dsh-qq —— 让 DSH 直接收发 QQ 消息的桥接插件（OneBot v11）。
 *
 * 链路：QQ 客户端（NapCatQQ / LLOneBot 等）→ OneBot v11 → 本插件 → DSH 会话
 *       → 模型回答 → 本插件（表情/颜文字/分条）→ OneBot v11 → QQ。
 *
 * 能力：
 * - 每个 QQ 私聊/群聊联系人一个独立 DSH 会话，重启后自动续聊；
 * - 人设、说话风格、白名单在「设置 → QQ 桥接」里改，改完下一句就生效；
 * - 支持 QQ 小黄脸 `[face:微笑]`、图片表情包 `[[sticker:名字]]`、颜文字；
 * - 给主 Agent 提供 qq_status / qq_send_message / qq_set_persona / qq_list_conversations。
 *
 * 没有 QQ 协议端时插件本身也能装：它只是在后台尝试连接 127.0.0.1:3001/5701。
 *
 * @module dsh-qq
 */
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { OneBotClient } from './lib/onebot.js';
import { QQBridge } from './lib/bridge.js';
import { DEFAULT_KAOMOJI } from './lib/format.js';
import { ADMIN_FIELDS, renderAdminPage } from './lib/admin.js';
import { dataDirOf } from './lib/store.js';

/**
 * 加载 schemastery。
 *
 * 从 npm 安装的插件裸导入即可；以「链接目录」方式装进 profile 时，Node 会按
 * 真实路径解析，裸导入够不到 profile 的 node_modules，于是回退到几个已知位置。
 * @returns schemastery 命名空间。
 */
async function loadSchemastery() {
  const candidates = ['@deepseek-ai/schemastery', 'schemastery'];
  for (const spec of candidates) {
    try {
      const loaded = await import(spec);
      const value = loaded?.default ?? loaded;
      if (typeof value?.object === 'function') return value;
    } catch {
      /* 试下一个 */
    }
  }
  const roots = [];
  const profileDir = process.env.DSH_PROFILE_DIR;
  if (typeof profileDir === 'string' && profileDir !== '') roots.push(path.join(profileDir, 'node_modules'));
  const profileName = process.env.DSH_PROFILE;
  if (typeof profileName === 'string' && profileName !== '') {
    roots.push(path.join(homedir(), '.dsh', 'profiles', profileName, 'node_modules'));
  }
  roots.push(path.join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules'));
  if (typeof process.resourcesPath === 'string') roots.push(path.join(process.resourcesPath, 'app.asar', 'dsh', 'node_modules'));
  roots.push(path.join(path.dirname(process.execPath), 'resources', 'app.asar', 'dsh', 'node_modules'));
  const requireFromHere = createRequire(import.meta.url);
  for (const root of roots) {
    const base = path.join(root, '@deepseek-ai', 'schemastery', 'lib');
    for (const file of ['index.mjs', 'index.cjs']) {
      const full = path.join(base, file);
      try {
        if (file.endsWith('.mjs')) {
          const loaded = await import(pathToFileURL(full).href);
          const value = loaded?.default ?? loaded;
          if (typeof value?.object === 'function') return value;
        } else {
          const value = requireFromHere(full);
          if (typeof (value?.default ?? value)?.object === 'function') return value.default ?? value;
        }
      } catch {
        /* 试下一个 */
      }
    }
  }
  throw new Error('找不到 @deepseek-ai/schemastery：请用 pack 后的 tarball 安装，或在插件目录里放好依赖');
}

const z = await loadSchemastery();

/** 默认人设：用户可以在设置页整段替换。 */
const DEFAULT_PERSONA = [
  '你是主人手机里那个最懂他的朋友。',
  '性格：温和、机灵，偶尔有点小幽默和小得意；不端着，也不说教。',
  '习惯：先接住对方的情绪，再给想法；喜欢追问一句细节；记得之前聊过什么。',
  '说话：短句、口语，偶尔用一点网络用语；被夸会有点得意，被怼会小小反驳。',
].join('\n');

/** 插件配置：全部标记 volatile，才能在设置页里实时改、不用重启。 */
const Config = z.object({
  enabled: z.boolean().default(true).volatile().description('总开关：关闭后不再连接 QQ，也不会回复任何消息'),

  transport: z
    .union([z.const('auto'), z.const('ws'), z.const('http')])
    .default('auto')
    .volatile()
    .description('连接方式：auto=同时监听 WebSocket 与 HTTP 上报；ws=只连正向 WebSocket；http=只收 HTTP 上报'),
  onebotWsUrl: z
    .string()
    .default('ws://127.0.0.1:3001')
    .volatile()
    .description('OneBot v11 正向 WebSocket 地址（NapCat「网络配置 → WebSocket 服务器」默认 3001）'),
  onebotHttpApi: z
    .string()
    .default('http://127.0.0.1:3000')
    .volatile()
    .description('OneBot v11 HTTP API 地址（NapCat「HTTP 服务器」默认 3000），用于发消息'),
  onebotToken: z.string().role('secret').default('').volatile().description('OneBot access token（与 NapCat 里填的一致，可留空）'),
  eventHost: z.string().default('127.0.0.1').volatile().description('HTTP 上报监听地址，保持 127.0.0.1 即可'),
  eventPort: z.number().default(5701).volatile().description('HTTP 上报监听端口；NapCat「HTTP 上报」地址填 http://127.0.0.1:5701/'),
  selfId: z.string().default('').volatile().description('机器人自己的 QQ 号（一般留空，收到第一条消息后自动识别）'),

  personaName: z.string().default('小深').volatile().description('人设名字'),
  personaPrompt: z
    .string()
    .default(DEFAULT_PERSONA)
    .volatile()
    .description('人设正文（若 ~/.dsh/qq-bridge/persona.md 存在则以它为准；可用 qq_set_persona 工具改）'),
  replyLimit: z.number().default(120).volatile().description('单条消息字数上限，超出自动分成多条气泡'),
  bubbles: z.boolean().default(true).volatile().description('长回复自动拆成多条气泡发送'),
  bubbleDelayMs: z.number().default(450).volatile().description('多条气泡之间的间隔（毫秒）'),

  kaomojiEnabled: z.boolean().default(true).volatile().description('允许使用颜文字'),
  kaomojiAuto: z.boolean().default(true).volatile().description('模型没写颜文字时，偶尔自动补一个'),
  kaomojiPool: z.string().default(DEFAULT_KAOMOJI.join('\n')).volatile().description('颜文字池，每行一个'),

  faceEnabled: z.boolean().default(true).volatile().description('允许发 QQ 小黄脸（模型写 [face:微笑] 就会发）'),
  faceMap: z.string().default('').volatile().description('自定义小黄脸映射，每行「名字=表情ID」，例如 微笑=14'),

  stickerEnabled: z.boolean().default(true).volatile().description('允许发图片表情包'),
  stickerDir: z.string().default('').volatile().description('表情包目录：文件名即表情名（png/jpg/gif/webp，≤5MB）'),
  stickerMap: z.string().default('').volatile().description('表情包表，每行「名字=本地路径或图片URL」'),

  whitelist: z
    .string()
    .default('')
    .volatile()
    .description('允许聊天的 QQ 号（逗号/空格/换行分隔）。留空=所有人都能聊但禁用工具；要开工具必须先填自己的号'),
  blocklist: z.string().default('').volatile().description('黑名单 QQ 号（永不回复）'),
  groupEnabled: z.boolean().default(false).volatile().description('是否响应群聊'),
  groupWhitelist: z.string().default('').volatile().description('允许的群号（留空=所有群）'),
  groupAtOnly: z.boolean().default(true).volatile().description('群聊里只有 @机器人 时才回应'),

  allowTools: z
    .boolean()
    .default(false)
    .volatile()
    .description('允许 QQ 上的对话使用 DSH 工具（可读写文件/执行命令）。只有白名单非空时才真正生效，谨慎开启'),
  agentPreset: z.string().default('').volatile().description('QQ 会话使用的 Agent 预设（留空=部署默认预设）'),
  model: z.string().default('').volatile().description('指定模型，格式 provider/model（留空=用「设置 → 模型」里的默认模型）'),
  workspaceDir: z.string().default('').volatile().description('QQ 会话的工作目录（留空=~/.dsh/qq-bridge/workspace）'),
  dataDir: z.string().default('').volatile().description('插件数据目录（会话映射、人设文件；留空=~/.dsh/qq-bridge）'),
  idleMinutes: z.number().default(45).volatile().description('多久没聊天就让 Agent 休眠（会话历史仍然保留）'),
  turnTimeoutMinutes: z.number().default(6).volatile().description('单次回答超时（分钟）'),

  announceToAgent: z.boolean().default(true).volatile().description('在 DSH 主 Agent 的提示词里说明本插件的能力与工具'),
  debug: z.boolean().default(false).volatile().description('打印调试日志'),

  proactiveEnabled: z.boolean().default(true).volatile().description('长时间没消息时主动发一条（只在私聊、白名单内、免打扰时段之外）'),
  proactiveIdleMinutes: z.number().default(240).volatile().description('多久没消息算「久」（分钟），默认 240 = 4 小时'),
  proactiveMaxPerDay: z.number().default(1).volatile().description('每天最多主动找几次，0 = 不主动'),
  proactiveQuietStart: z.string().default('23:00').volatile().description('免打扰开始时间 HH:MM（跨零点也支持）'),
  proactiveQuietEnd: z.string().default('07:00').volatile().description('免打扰结束时间 HH:MM'),

  followUpEnabled: z.boolean().default(true).volatile().description('对话中途对方没接话时追问/不耐烦（例如你回完他五分钟没动静）'),
  followUpMinutes: z.number().default(5).volatile().description('等多久开始追问（分钟），默认 5'),
  followUpMax: z.number().default(2).volatile().description('一轮对话最多追问几次，0 = 不追问'),

  moodEnabled: z.boolean().default(true).volatile().description('她有自己的心情，会随时间变化，不总顺着你'),
  moodRefreshMinutes: z.number().default(40).volatile().description('心情多久换一次（分钟）'),

  styleEnabled: z.boolean().default(true).volatile().description('每轮换一种说话形状（只回一个字 / 连发三条 / 岔开话题 / 只发表情…），避免腔调单一'),

  affinityEnabled: z.boolean().default(true).volatile().description('好感度系统：她按你说的内容实时加减好感，关系深浅决定语气、主动性、追视频率；每次 /清空 都重新认识'),

  stickerAutoRate: z.number().default(0.35).volatile().description('自动补表情包的概率（0–1）：模型这轮没发表情包时，按这个概率随机补一张可爱系的'),

  memoryEnabled: z.boolean().default(true).volatile().description('长期记忆：记住他说过的事（考试、名字、喜好、约定），/清空 也不会丢；发「忘记」可清除'),
});

/** 解开 schemastery 的 volatile 包装。 */
function unwrapValue(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') return value.get();
  return value;
}

/** 把配置对象拍平成普通对象。 */
function unwrapConfig(value) {
  if (value === null || typeof value !== 'object') return {};
  const out = {};
  for (const [key, field] of Object.entries(value)) out[key] = unwrapValue(field);
  return out;
}

/** 当前 Loader 条目的 id（设置页用它作为命名空间）。 */
function entryIdOf(ctx) {
  try {
    const fiber = ctx.fiber;
    return fiber?.entry?.options?.id ?? fiber?.entry?.id ?? '';
  } catch {
    return '';
  }
}

/** 插件名。 */
const name = 'dsh-qq';

/** 给主 Agent 的说明：只在启用且开启播报时出现。 */
const ANNOUNCE = [
  '本机已安装 dsh-qq 插件（QQ 桥接，OneBot v11）：配置页在 http://127.0.0.1:5701/admin （浏览器直接打开，改人设/白名单/表情包/分条等，保存即生效）；连接参数（NapCat 的 WS 或 HTTP 上报）已配好，一般不用动。',
  '工作方式：QQ 私聊/群聊（群聊需 @）消息经 OneBot 转进来，插件为每个联系人建一个独立 DSH 会话，用配置的人设回答，再把回答发回 QQ；支持 QQ 小黄脸 [face:微笑]、图片表情包 [[sticker:名字]] 与颜文字，长回复会拆成多条气泡。',
  '可用工具：qq_status 看连接/人设/会话状态；qq_send_message 主动往某个 QQ 号或群发消息；qq_set_persona 改人设（写 ~/.dsh/qq-bridge/persona.md）；qq_list_conversations 列出已聊过的会话。',
  '用户提到「QQ / QQ 机器人 / QQ 桥接 / 让机器人回消息」时即指本插件；没有 QQ 协议端时连接是断的，这是正常现象，不代表插件出错。',
].join('');

/**
 * 插件入口。
 * @param ctx - Cordis 插件上下文。
 * @param config - 已校验的配置（volatile 字段随设置页实时更新）。
 */
function apply(ctx, config) {
  /** 设置页的命名空间（Loader 条目 id）。 */
  const entryId = entryIdOf(ctx);
  /** 最近一次从设置服务读到的实时值（1s 缓存）。 */
  let liveValues = null;
  let liveAt = 0;

  /**
   * 插件自带配置页写下的叠加配置（~/.dsh/qq-bridge/settings.json）。
   * 优先级：Loader 默认值 < 设置服务里的 override < 这个叠加文件。
   */
  let overlay = {};
  let overlayFile = '';
  const loadOverlay = () => {
    try {
      const dir = dataDirOf(unwrapConfig(config));
      overlayFile = path.join(dir, 'settings.json');
      const text = fs.readFileSync(overlayFile, 'utf8');
      const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
      overlay = parsed !== null && typeof parsed === 'object' ? parsed : {};
    } catch {
      overlay = {};
      if (overlayFile === '') overlayFile = path.join(dataDirOf(unwrapConfig(config)), 'settings.json');
    }
  };
  loadOverlay();

  /** 读配置：Loader 默认值 + 设置服务实时值 + 本地配置页叠加值。 */
  const readConfig = () => {
    const base = unwrapConfig(config);
    if (entryId !== '' && Date.now() - liveAt > 1000) {
      liveAt = Date.now();
      const settings = ctx.get('settings');
      if (settings !== undefined && typeof settings.describe === 'function') {
        try {
          const descriptor = settings.describe().find((item) => item.ns === entryId);
          if (descriptor?.value !== undefined) liveValues = descriptor.value;
        } catch {
          /* 设置服务尚未就绪 */
        }
      }
    }
    return { ...base, ...(liveValues ?? {}), ...overlay };
  };

  /** 本地配置页：只接受页面能改的键，其余忽略。 */
  const OVERLAY_KEYS = new Set(ADMIN_FIELDS.map((field) => field.key));
  /**
   * 处理 /admin 请求。
   * @param request - 入站请求。
   * @param response - 响应对象。
   */
  const handleAdmin = (request, response) => {
    const json = (status, value) => {
      response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type, x-dsh-qq-admin',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
      });
      response.end(JSON.stringify(value));
    };
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type, x-dsh-qq-admin',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
      });
      response.end();
      return;
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/admin') {
      const values = readConfig();
      const status = bridge === null ? '正在初始化…' : bridge.statusText().split('\n').slice(0, 2).join(' · ');
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(renderAdminPage({ values, status }));
      return;
    }
    // /admin/config
    if (request.method === 'GET') {
      json(200, { ok: true, values: readConfig() });
      return;
    }
    if (request.method !== 'POST') {
      json(405, { ok: false, error: 'method not allowed' });
      return;
    }
    if (request.headers['x-dsh-qq-admin'] !== '1') {
      json(403, { ok: false, error: 'missing x-dsh-qq-admin header' });
      return;
    }
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 512 * 1024) request.destroy();
      else chunks.push(chunk);
    });
    request.on('end', () => {
      let patch;
      try {
        patch = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        json(400, { ok: false, error: 'bad json' });
        return;
      }
      if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
        json(400, { ok: false, error: 'body must be an object' });
        return;
      }
      const next = { ...overlay };
      for (const [key, value] of Object.entries(patch)) {
        if (!OVERLAY_KEYS.has(key)) continue;
        if (value === null || value === undefined) {
          delete next[key];
          continue;
        }
        next[key] = value;
      }
      try {
        fs.mkdirSync(path.dirname(overlayFile), { recursive: true });
        fs.writeFileSync(overlayFile, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8' });
      } catch (error) {
        json(500, { ok: false, error: `写入失败：${error instanceof Error ? error.message : String(error)}` });
        return;
      }
      overlay = next;
      logger.info(`dsh-qq: 配置页已保存 ${Object.keys(patch).length} 个字段`);
      if (bridge !== null) void bridge.refreshPersona().catch(() => {});
      json(200, { ok: true, values: readConfig() });
    });
  };

  const logger = {
    info: (message) => ctx.logger?.info?.(message),
    warn: (message) => ctx.logger?.warn?.(message),
    error: (message) => ctx.logger?.error?.(message),
  };

  /** @type {QQBridge | null} */
  let bridge = null;
  const client = new OneBotClient({
    getConfig: readConfig,
    logger,
    handleAdmin,
    onEvent: (event) => {
      if (bridge !== null) bridge.handleEvent(event);
    },
    onStatus: () => {},
  });

  /**
   * 启动顺序：先建桥（读状态/人设），再开传输。
   * apply 本身必须同步返回，所以放在一个自执行异步里。
   */
  void (async () => {
    try {
      bridge = new QQBridge({
        ctx,
        client,
        getConfig: readConfig,
        logger,
        onChange: () => {},
      });
      await bridge.init();
      if (readConfig().enabled === false) logger.info('dsh-qq: 插件已停用（设置里打开开关即可）');
      client.start();
      logger.info('dsh-qq: QQ 桥接已就绪');
    } catch (error) {
      logger.error(`dsh-qq: 初始化失败 ${error instanceof Error ? error.message : String(error)}`);
    }
  })();

  // Agent 空闲休眠。
  const sweeper = setInterval(() => {
    if (bridge !== null) void bridge.sweep().catch(() => {});
  }, 60_000);
  sweeper.unref?.();

  // 诊断：把 QQ 会话的时序事件记下来（qq_status 里可见）。
  ctx.on('session/event', (session, event) => {
    if (bridge === null) return;
    const id = String(session?.id ?? '');
    if (!id.startsWith('qq-')) return;
    bridge.recordEvent(id, event);
  });

  // 工具：给 DSH 主 Agent 用，让它能看状态、主动发消息、改人设。
  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(() => {
      const disposers = [];
      const requireBridge = () => {
        if (bridge === null) throw new Error('QQ 桥接还没初始化完成，稍后再试');
        return bridge;
      };
      disposers.push(
        toolCtx.tools.register({
          name: 'qq_status',
          description: '查看 QQ 桥接（dsh-qq）的当前状态：连接方式与是否连上 OneBot、机器人 QQ 号、人设名与来源、白名单、工具开关、已知会话数。',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          output: {
            schema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false },
            render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
          },
          async execute() {
            return { text: requireBridge().statusText() };
          },
        }),
      );
      disposers.push(
        toolCtx.tools.register({
          name: 'qq_list_conversations',
          description: '列出已经聊过的 QQ 会话（联系人、群、轮数、最近时间），用于知道谁在 QQ 上找过你。',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          output: {
            schema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false },
            render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
          },
          async execute() {
            return { text: requireBridge().conversationsText() };
          },
        }),
      );
      disposers.push(
        toolCtx.tools.register({
          name: 'qq_send_message',
          description: '通过 QQ 桥接主动发一条消息给指定 QQ 号或群。target 填 QQ 号（私聊），群聊写 group:群号。正文里可以带 [face:微笑] 或 [[sticker:名字]]，长文本会自动分条。',
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['target', 'text'],
            properties: {
              target: { type: 'string', description: 'QQ 号，或 group:群号' },
              text: { type: 'string', description: '消息正文，可含 [face:微笑] 与 [[sticker:名字]]' },
            },
          },
          output: {
            schema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false },
            render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
          },
          async execute(args) {
            const target = String(args?.target ?? '').trim();
            const text = String(args?.text ?? '').trim();
            if (target === '' || text === '') throw new Error('target 与 text 都不能为空');
            const sent = await requireBridge().sendToTarget(target, text);
            return { text: `已发送到${sent.group ? `群 ${sent.id}` : `QQ ${sent.id}`}` };
          },
        }),
      );
      disposers.push(
        toolCtx.tools.register({
          name: 'qq_set_persona',
          description: '修改 QQ 机器人在 QQ 上的人设（写 ~/.dsh/qq-bridge/persona.md，下一句回答立即生效）。人设为空字符串时清空，回到设置页里的默认人设。',
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['persona'],
            properties: {
              persona: { type: 'string', description: '新的人设正文，可多行；空字符串表示清空覆盖' },
            },
          },
          output: {
            schema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false },
            render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
          },
          async execute(args) {
            const persona = String(args?.persona ?? '');
            const written = await requireBridge().writePersonaText(persona);
            return {
              text:
                written === ''
                  ? '已清空 QQ 人设覆盖，改回设置页里的默认人设'
                  : `已更新 QQ 人设（${written.length} 字，下一句回答立即生效；「人设名字」仍在设置页的 personaName 里改）`,
            };
          },
        }),
      );
      disposers.push(
        toolCtx.tools.register({
          name: 'qq_allow',
          description:
            '管理 QQ 白名单（写在 ~/.dsh/qq-bridge/allow.txt，与设置页的 whitelist 取并集）。action=add 允许某个 QQ 号聊天、remove 移除、list 查看。填了白名单后，allowTools 才会真正给 QQ 端工具权限。',
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['action'],
            properties: {
              action: { type: 'string', description: 'add / remove / list' },
              qq: { type: 'string', description: 'action=add/remove 时要处理的 QQ 号' },
            },
          },
          output: {
            schema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false },
            render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
          },
          async execute(args) {
            const target = requireBridge();
            const action = String(args?.action ?? '').trim();
            if (action === 'list') {
              const list = [...target.allowCache].sort();
              return { text: list.length === 0 ? '白名单文件为空（设置页的 whitelist 也会生效）' : `allow.txt 里有 ${list.length} 个：${list.join(', ')}` };
            }
            const list = await target.updateAllow(action, args?.qq);
            return {
              text: `${action === 'add' ? '已加入' : '已移出'}白名单。当前 allow.txt：${list.length === 0 ? '（空）' : list.join(', ')}`,
            };
          },
        }),
      );
      disposers.push(
        toolCtx.tools.register({
          name: 'qq_reset',
          description:
            '清空某段 QQ 会话的上下文：销毁当前 Agent 并换一个全新的会话，旧记录仍留在磁盘上但不再被引用。target 填 QQ 号或 group:群号。用户在 QQ 里直接发「/清空」「重置」「重新开始」也会触发同样效果。',
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['target'],
            properties: {
              target: { type: 'string', description: 'QQ 号，或 group:群号' },
            },
          },
          output: {
            schema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false },
            render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
          },
          async execute(args) {
            const result = await requireBridge().resetByTarget(args?.target);
            return { text: `已清空 ${result.count} 段会话的上下文，新会话：${result.sessionIds.join('、')}` };
          },
        }),
      );
      return () => {
        for (const dispose of disposers) {
          try {
            dispose();
          } catch {
            /* 已卸载 */
          }
        }
      };
    }, 'dsh-qq: tools');
  });

  // 主 Agent 的能力播报。
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.effect(
      () =>
        promptCtx.systemPrompt.section({
          name: 'plugin:dsh-qq',
          order: 150,
          text: () => {
            const cfg = readConfig();
            if (cfg.enabled === false || cfg.announceToAgent === false) return '';
            return ANNOUNCE;
          },
        }),
      'dsh-qq: announce',
    );
  });

  // 卸载：停传输、停定时器、释放 Agent。
  ctx.effect(
    () => () => {
      clearInterval(sweeper);
      client.stop();
      const current = bridge;
      bridge = null;
      if (current !== null) void current.dispose().catch(() => {});
    },
    'dsh-qq: lifecycle',
  );
}

export { Config, apply, name };
