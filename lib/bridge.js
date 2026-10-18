/**
 * QQ ↔ DSH 会话桥接。
 *
 * 每个 QQ 会话（私聊=一个人；群聊=群 × 人）映射到一个独立的 DSH Session：
 *   - 第一次收到消息时 `agents.resume()` 恢复上次的会话，恢复不了就 `agents.create()` 新建；
 *   - 人设与聊天规则通过 Agent 作用域的提示词段注入（所以改人设不用重建会话）；
 *   - 回答从会话消息里取最后一条 assistant 文本，解析 [face:…] / [[sticker:…]] 标记后发回 QQ。
 *
 * @module dsh-qq/bridge
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { ensureDir, readJson, readPersona, readMemory, memoryFileOf, scanStickerTree, stickerSegment, workspaceDirOf, writeJson, writeMemory, writePersona, dataDirOf } from './store.js';
import {
  hasKaomoji,
  messageToText,
  mentionsSelf,
  parseFaceMap,
  parseKaomojiPool,
  parseOutbound,
  parseStickerMap,
  pickKaomoji,
  reverseFaceMap,
  splitBubbles,
  stripMarkdown,
  stripMetaTalk,
  stripSelfMention,
} from './format.js';
import { annotateIncoming, buildChatRules, buildPersona } from './prompt.js';
import { sleep } from './onebot.js';

/** 人设段的段名：与部署级人设同名，作用域内遮蔽。 */
const PERSONA_SECTION = 'deployment:persona-prefix';
/** 聊天规则段的段名与排序（工具说明带）。 */
const CHAT_SECTION = 'plugin:dsh-qq:qq-chat';
const CHAT_SECTION_ORDER = 150;
/** 被拒绝的陌生人提示的冷却时间。 */
const HINT_COOLDOWN_MS = 10 * 60_000;
/** 状态文件写盘防抖。 */
const PERSIST_DEBOUNCE_MS = 1_500;
/** 状态输出里的版本标记，用于确认宿主加载的是不是最新代码。 */
const BUILD = 'dsh-qq 0.1.0';

/** 停止类指令：直接中断当前回答。 */
const STOP_PATTERN = /^[/／]?(停止|停下|别说了|闭嘴|打断|stop)$/i;
/** 重置类指令：丢掉当前会话的上下文，下一句开新会话。 */
const RESET_PATTERN = /^[/／]?\s*(重置|清空|清空上下文|清空对话|重新开始|新对话|重开|从头开始|reset|new|clear)$/i;

/** 闲着太久时主动开口的句子（傲娇高中生口吻，短）。 */
const PROACTIVE_LINES = [
  '喂',
  '在干嘛',
  '……你是不是把我忘了',
  '刚下课，好无聊',
  '作业写完了吗',
  '你怎么不说话了',
  '哼',
  '今天好热',
  '在等一个人回消息',
  '算了，随便你',
  '在吗',
  '突然想起来你说过的话',
  '困死了，还被物理老师拖了半节课',
  '你忙你的吧',
  '八点又把我笔袋扒地上了',
];

/** 对话里对方没接话时的第一轮追问（在意 / 催）。 */
const FOLLOW_UP_LINES_1 = [
  '人呢',
  '？',
  '在吗',
  '喂，说话啊',
  '你是不是又忙去了',
  '我刚才说的你看了没',
  '怎么突然没声了',
  '……你还在吗',
];

/** 第二轮：开始不耐烦 / 赌气。 */
const FOLLOW_UP_LINES_2 = [
  '算了，不回就不回',
  '哦，那你先忙',
  '哼',
  '我等了你好久了',
  '……那我去写作业了',
  '你倒是说句话啊',
  '行吧，随便你',
  '不回算了',
];

/** 她自己的心情池：换着来，回话不必跟着对方的情绪走。 */
const MOOD_POOL = [
  '还行，就是有点懒',
  '有点烦，不想多说',
  '困，脑子转不动',
  '心情不错，话比平时多',
  '有点想闹，故意跟他作对',
  '淡淡的，懒得解释',
  '刚被老师说了，心里还憋着气',
  '饿，注意力集中不起来',
  '有点小得意',
  '闷闷的，不太想接话',
  '刚跟阿肖闹了点别扭',
  '作业没写完，心里发虚',
];

/** 随机挑一个心情。 */
function pickMood() {
  return MOOD_POOL[Math.floor(Math.random() * MOOD_POOL.length)];
}

/** 心情 → 发表情包的倾向倍数（心情好更爱发，烦/困更少）。 */
const MOOD_STICKER_FACTOR = new Map([
  ['心情不错，话比平时多', 2.0],
  ['有点小得意', 1.6],
  ['有点想闹，故意跟他作对', 1.5],
  ['还行，就是有点懒', 1.0],
  ['作业没写完，心里发虚', 0.8],
  ['刚跟阿肖闹了点别扭', 0.7],
  ['饿，注意力集中不起来', 0.6],
  ['困，脑子转不动', 0.5],
  ['刚被老师说了，心里还憋着气', 0.4],
  ['闷闷的，不太想接话', 0.4],
  ['有点烦，不想多说', 0.35],
  ['淡淡的，懒得解释', 0.3],
]);

/**
 * 按心情和好感算这一轮自动补表情包的实际概率。
 * @param base - 配置里的基准概率。
 * @param mood - 当前心情。
 * @param affinity - 好感度 0–100。
 * @returns 0–1 的概率。
 */
function stickerRateFor(base, mood, affinity) {
  const safeBase = Number.isFinite(Number(base)) ? Number(base) : 0.35;
  const factor = MOOD_STICKER_FACTOR.get(String(mood ?? '').trim()) ?? 1;
  const rawAffinity = Number(affinity);
  const trust = Number.isFinite(rawAffinity) ? Math.max(0, Math.min(100, rawAffinity)) / 100 : 0.15;
  const affinityFactor = 0.6 + 0.8 * trust; // 0.6 ~ 1.4
  return Math.max(0, Math.min(1, safeBase * factor * affinityFactor));
}

/**
 * 「这一条怎么回」的轮盘：每轮随机换一种说话形状，避免永远一个腔调。
 * 只给方向和形状，不写死内容。
 */
const STYLE_POOL = [
  '只回一句很短的话，不超过 10 个字，不解释',
  '用空行分成两条发：第一条很短，第二条补一句',
  '用空行分成三条发，像在连着打字',
  '先反问一句，再随便回一句',
  '别回答他的问题，说一件你自己的小事（作业、八点、地铁、阿肖）',
  '只发一个表情包，不要写文字',
  '有点不耐烦，回两三个字就够了',
  '认真回一次，两三句，把话说清楚',
  '答非所问，把话题岔开',
  '语气软一点，但内容敷衍',
  '带点错别字或者语病，像随手打的',
  '先回一句「等下」，再补一句正经的',
  '拿他之前说过的话噎他一句',
  '只说半截，像发出去才想起来还没说完',
  '用「……」开头，然后一句话',
];

/**
 * 挑一个本轮风格，尽量不和上一轮重复。
 * @param previous - 上一轮用的下标。
 * @returns 风格下标。
 */
function pickStyle(previous) {
  if (STYLE_POOL.length < 2) return 0;
  for (;;) {
    const index = Math.floor(Math.random() * STYLE_POOL.length);
    if (index !== previous) return index;
  }
}

/** 每轮随机抽两条的「生活细节」，让人物有厚度又不撑爆提示词。 */
const FLAVOR_POOL = [
  '口袋里有一颗不知道哪来的薄荷糖',
  '草稿纸角落画了一个很小的自己',
  '昨天晚上十二点还在想白天一句话该怎么说',
  '手机壳里面塞了一张小纸条',
  '最近鞋带老是开',
  '刚被班主任叫去说了一通，其实没什么事',
  '桌上摊着一本翻到卷边的练习册',
  '中午在食堂吃到一根没熟的豆角，郁闷了一下午',
  '数学课代表把作业收错了，她白早读了十分钟',
  '今天有体育课，但是被换成了数学',
  '教室后墙的黑板报是她画的，没人知道',
  '耳机一只没电了，只能单边听',
  '下雨天鞋子湿了，袜子一直黏糊糊的',
  '刚发现校服袖口磨破了',
  '书包里有一包吃了两口的饼干',
  '物理老师今天穿了件特别花的衬衫',
  '她记得别人不吃香菜，自己不吃葱',
  '同桌借了她的笔还没还',
  '上周的听写本发下来，错了一个字',
  '手机里存着一张没来得及发的晚霞照片',
  '刚在楼梯间看到有人在偷偷谈恋爱',
  '她讨厌别人说「你怎么这么懂事」',
  '早上差点迟到，一路小跑进来的',
  '课桌里有半瓶放凉的矿泉水',
  '昨天熬夜看完了那部剧的最后一集，眼睛肿了',
  '她觉得自己的字像小学生',
  '阿肖今天心情不好，她没敢问',
  '数学卷子上有一道题她其实会，但写错了',
  '刚被夸奖了一句，假装不在乎',
  '路过小卖部没买那包饼干，但犹豫了很久',
  '上课偷偷吃了颗糖，怕老师回头',
  '她想起来昨天忘了喂八点',
  '最近在追的剧明天更新',
  '看到有人被起外号，她不舒服了一整节课',
  '她把喜欢的句子截图存进了备忘录',
  '今天的风很大，她头发被吹乱了',
  '板擦灰落在她袖子上',
  '老师点了她旁边的人回答问题，她松了口气',
  '突然发现自己的手很好看',
  '她算好了下课的动线，但没走那条路',
];

/**
 * 抽 n 条不重复的生活细节。
 * @param n - 条数。
 * @returns 细节数组。
 */
function pickFlavor(n = 2) {
  const pool = [...FLAVOR_POOL];
  const picked = [];
  for (let i = 0; i < n && pool.length > 0; i += 1) {
    const index = Math.floor(Math.random() * pool.length);
    picked.push(pool.splice(index, 1)[0]);
  }
  return picked;
}

/**
 * 从回复里抠出隐藏的长期记忆标记（[[记住:...]]），返回干净文本与条目。
 * @param text - 模型回复。
 * @returns {text: string, items: string[]}
 */
function extractMemoryMarkers(text) {
  const items = [];
  const cleaned = String(text ?? '').replace(/\[\[\s*(?:记住|记下|memory)\s*[:：]\s*([^\]\n]{1,120})\]\]/gi, (_all, value) => {
    const item = String(value ?? '').trim();
    if (item !== '') items.push(item);
    return '';
  });
  return { text: cleaned, items };
}

/** 长期记忆最多保留多少条（防无限增长）。 */
const MEMORY_MAX = 60;

/** 新认识时的好感度。 */
const AFFINITY_START = 15;
/** 单轮好感度最大变化。 */
const AFFINITY_MAX_DELTA = 5;

/**
 * 好感度 + 认识时长 → 关系描述与行为约束。
 * @param affinity - 0–100。
 * @param days - 认识多少天（可带小数）。
 * @returns 关系标签与行为规则。
 */
function relationshipOf(affinity, days) {
  if (affinity <= 20) {
    return {
      label: '刚认识，还很生分',
      rules:
        '话少，礼貌里带距离；不主动分享自己的事（猫、阿肖、家里都不提），不关心他的私事；不用昵称、不撒娇、不开玩笑式损人；他套近乎会觉得莫名其妙甚至烦。',
    };
  }
  if (affinity <= 40) {
    return {
      label: '有点熟了，但还是收着',
      rules:
        '会接话、会吐槽两句，但还端着；偶尔提一句自己的事（作业、老师），不深入；被夸会别扭地不接；不会主动找他。',
    };
  }
  if (affinity <= 60) {
    return {
      label: '有点在意了',
      rules:
        '开始会顺着话题多说两句，会问他"你呢"；被冷落会不高兴但不明说；愿意说自己的小事（猫、地铁、阿肖），嘴还是硬。',
    };
  }
  if (affinity <= 80) {
    return {
      label: '明显亲近',
      rules:
        '会主动关心他、会记住他之前说过的细节并提起；会撒娇、会闹、会吃醋；损完人会补一句软话；他冷淡时她会明显不高兴。',
    };
  }
  return {
    label: '很黏',
    rules:
      '很自在地黏人：会抱怨他回得慢、会主动找他、会分享琐碎到无聊的事；被冷落会直接说出来；偶尔露出很软的一面（但还是嘴硬）。',
  };
}

/**
 * 从回复里抠出隐藏的好感度标记，返回干净文本与变化量。
 * @param text - 模型回复。
 * @returns {text: string, delta: number}
 */
function extractAffinityDelta(text) {
  let delta = 0;
  const cleaned = String(text ?? '').replace(/\[\[\s*(?:好感度?|affinity)\s*[:：]?\s*([+-]?\d{1,2})\s*\]\]/gi, (_all, value) => {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) delta += parsed;
    return '';
  });
  const clamped = Math.max(-AFFINITY_MAX_DELTA, Math.min(AFFINITY_MAX_DELTA, delta));
  return { text: cleaned, delta: clamped };
}

/** 把 "HH:MM" 转成分钟数。 */
function minutesOfClock(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (match === null) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return undefined;
  return hours * 60 + minutes;
}

/** 当前是否落在免打扰时段（支持跨零点，例如 23:00–07:00）。 */
function inQuietHours(start, end, now = new Date()) {
  const from = minutesOfClock(start);
  const to = minutesOfClock(end);
  if (from === undefined || to === undefined || from === to) return false;
  const current = now.getHours() * 60 + now.getMinutes();
  return from < to ? current >= from && current < to : current >= from || current < to;
}

/**
 * 用固定输入得到稳定的会话 id（重启后仍能 resume）。
 * @param key - QQ 会话键。
 * @param generation - 重置代数，每重置一次 +1，换一个全新的会话。
 * @returns DSH SessionId。
 */
function sessionIdOf(key, generation = 0) {
  const seed = generation === 0 ? key : `${key}#${generation}`;
  return `qq-${createHash('sha1').update(seed).digest('hex').slice(0, 16)}`;
}

/** 空格、换行归整。 */
function tidy(text) {
  return String(text ?? '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 每行 逗号/空格 分隔的数字集合。 */
function numberSet(text) {
  const set = new Set();
  for (const token of String(text ?? '').split(/[\s,，、;；]+/)) {
    const value = token.trim();
    if (/^\d{4,12}$/.test(value)) set.add(value);
  }
  return set;
}

/**
 * QQ 会话桥。
 */
export class QQBridge {
  /**
   * @param options - 宿主上下文、传输层、配置读取与人设读写。
   */
  constructor(options) {
    this.ctx = options.ctx;
    this.client = options.client;
    this.getConfig = options.getConfig;
    this.getPersona = options.getPersona;
    this.setPersona = options.setPersona;
    this.logger = options.logger;
    this.onChange = options.onChange ?? (() => {});

    /** @type {Map<string, any>} QQ 会话键 → 会话记录。 */
    this.conversations = new Map();
    /** 已处理过的 message_id，防止重复上报。 */
    this.seen = new Set();
    this.hints = new Map();
    this.personaCache = '';
    this.allowCache = new Set();
    this.allowAt = 0;
    this.stickerCache = { at: 0, files: new Map(), packs: new Map(), dir: '' };
    this.persistTimer = null;
    this.stateFile = '';
    this.turnCount = 0;
    this.lastTurnAt = 0;
    this.lastError = '';
    this.lastErrorAt = 0;
    this.lastTurnError = '';
    this.trace = [];
  }

  /** 记录一条 QQ 会话的时序事件（debug 时输出），并捕获模型/会话错误。 */
  recordEvent(sessionId, event) {
    const type = String(event?.type ?? '?');
    let extra = '';
    if (type === 'turn/end') {
      const reason = event.data?.reason;
      extra = `(${JSON.stringify(reason ?? null).slice(0, 120)})`;
      if (reason?.kind === 'error') {
        const failure = reason.error ?? {};
        this.lastTurnError = `${failure.code ?? 'ERROR'} ${failure.message ?? '模型调用失败'}`.trim();
      }
    }
    if (type === 'agent/inbox/spliced') extra = `(${event.data?.target} +${event.data?.inserted?.length ?? 0})`;
    this.trace.push(`${type}${extra}`);
    if (this.trace.length > 24) this.trace.shift();
  }

  /** 记下一条失败原因，供 qq_status 查看。 */
  noteError(message) {
    this.lastError = String(message ?? '').slice(0, 400);
    this.lastErrorAt = Date.now();
    this.logger.warn(`dsh-qq: ${this.lastError}`);
  }

  /** 初始化：数据目录、人设、会话映射。 */
  async init() {
    const config = this.getConfig();
    const dir = dataDirOf(config);
    await ensureDir(dir);
    await ensureDir(workspaceDirOf(config));
    this.dataDir = dir;
    this.stateFile = path.join(dir, 'state.json');
    this.allowFile = path.join(dir, 'allow.txt');
    this.personaCache = (await readPersona(dir)) ?? '';
    await this.refreshAllow();
    const state = await readJson(this.stateFile, { conversations: {} });
    for (const [key, record] of Object.entries(state?.conversations ?? {})) {
      if (record === null || typeof record !== 'object') continue;
      const generation = Number(record.generation ?? 0) || 0;
      const sessionId = typeof record.sessionId === 'string' && record.sessionId !== '' ? record.sessionId : sessionIdOf(key, generation);
      this.conversations.set(key, {
        key,
        sessionId,
        generation,
        kind: record.kind === 'group' ? 'group' : 'private',
        userId: String(record.userId ?? ''),
        groupId: String(record.groupId ?? ''),
        name: String(record.name ?? ''),
        lastAt: Number(record.lastAt ?? 0) || 0,
        turns: Number(record.turns ?? 0) || 0,
        lastProactiveAt: Number(record.lastProactiveAt ?? 0) || 0,
        proactiveDay: typeof record.proactiveDay === 'string' ? record.proactiveDay : '',
        proactiveCount: Number(record.proactiveCount ?? 0) || 0,
        lastProactiveText: typeof record.lastProactiveText === 'string' ? record.lastProactiveText : undefined,
        waitingSince: Number(record.waitingSince ?? 0) || undefined,
        followUps: Number(record.followUps ?? 0) || 0,
        mood: typeof record.mood === 'string' && record.mood !== '' ? record.mood : pickMood(),
        moodAt: Number(record.moodAt ?? 0) || Date.now(),
        affinity: Number.isFinite(Number(record.affinity)) ? Number(record.affinity) : AFFINITY_START,
        firstMetAt: Number(record.firstMetAt ?? 0) || Date.now(),
        agent: undefined,
        handle: undefined,
        queue: Promise.resolve(),
        hintAt: 0,
      });
    }
    this.logger.info(`dsh-qq: 已加载 ${this.conversations.size} 个 QQ 会话`);
  }

  /** 配置快照：把设置页的原始值整理成运行时结构。 */
  snapshot() {
    const raw = this.getConfig();
    const faceMap = parseFaceMap(raw.faceMap);
    const stickers = new Map();
    const stickerPacks = new Map();
    if (raw.stickerEnabled !== false) {
      for (const [name, source] of parseStickerMap(raw.stickerMap)) stickers.set(name, source);
      const dir = String(raw.stickerDir ?? '').trim();
      if (dir !== '') {
        // 目录扫描是异步的：先给出上次结果，再后台刷新。
        for (const [name, file] of this.stickerCache.files) if (!stickers.has(name)) stickers.set(name, file);
        for (const [label, list] of this.stickerCache.packs) stickerPacks.set(label, list);
        if (this.stickerCache.dir !== dir || Date.now() - this.stickerCache.at > 60_000) void this.refreshStickers(dir);
      }
    }
    const whitelist = numberSet(raw.whitelist);
    for (const value of this.allowCache) whitelist.add(value);
    const groupWhitelist = numberSet(raw.groupWhitelist);
    return {
      raw,
      enabled: raw.enabled !== false,
      personaName: String(raw.personaName ?? '').trim(),
      persona: this.personaCache.trim() !== '' ? this.personaCache.trim() : String(raw.personaPrompt ?? '').trim(),
      personaSource: this.personaCache.trim() !== '' ? 'persona.md' : '设置页',
      replyLimit: Math.max(20, Math.min(2000, Number(raw.replyLimit) || 120)),
      bubbles: raw.bubbles !== false,
      bubbleDelayMs: Math.max(0, Math.min(10_000, Number(raw.bubbleDelayMs) || 0)),
      faceEnabled: raw.faceEnabled !== false,
      faceMap,
      faceNames: reverseFaceMap(faceMap),
      stickerEnabled: raw.stickerEnabled !== false,
      stickers,
      stickerPacks,
      kaomojiEnabled: raw.kaomojiEnabled !== false,
      kaomojiAuto: raw.kaomojiAuto !== false,
      kaomoji: parseKaomojiPool(raw.kaomojiPool),
      whitelist,
      blocklist: numberSet(raw.blocklist),
      groupEnabled: raw.groupEnabled === true,
      groupWhitelist,
      groupAtOnly: raw.groupAtOnly !== false,
      toolsAllowed: raw.allowTools === true && whitelist.size > 0,
      turnTimeoutMs: Math.max(30_000, (Number(raw.turnTimeoutMinutes) || 6) * 60_000),
      idleMs: Math.max(60_000, (Number(raw.idleMinutes) || 45) * 60_000),
      agentPreset: String(raw.agentPreset ?? '').trim(),
      model: String(raw.model ?? '').trim(),
      debug: raw.debug === true,
      proactiveEnabled: raw.proactiveEnabled === true,
      proactiveIdleMs: Math.max(10 * 60_000, (Number(raw.proactiveIdleMinutes) || 240) * 60_000),
      proactiveMaxPerDay: Math.max(0, Math.min(5, Number(raw.proactiveMaxPerDay) || 1)),
      proactiveQuietStart: String(raw.proactiveQuietStart ?? '23:00').trim(),
      proactiveQuietEnd: String(raw.proactiveQuietEnd ?? '07:00').trim(),
      followUpEnabled: raw.followUpEnabled !== false,
      followUpMs: Math.max(60_000, (Number(raw.followUpMinutes) || 5) * 60_000),
      followUpMax: Math.max(0, Math.min(4, Number(raw.followUpMax) || 2)),
      moodEnabled: raw.moodEnabled !== false,
      moodRefreshMs: Math.max(5 * 60_000, (Number(raw.moodRefreshMinutes) || 40) * 60_000),
      styleEnabled: raw.styleEnabled !== false,
      affinityEnabled: raw.affinityEnabled !== false,
      stickerAutoRate: Math.max(0, Math.min(1, Number(raw.stickerAutoRate ?? 0.35))),
      memoryEnabled: raw.memoryEnabled !== false,
    };
  }

  /** 后台刷新表情包目录（根目录=具名表情，子目录=风格包）。 */
  async refreshStickers(dir) {
    const tree = await scanStickerTree(dir);
    this.stickerCache = { at: Date.now(), files: tree.files, packs: tree.packs, dir };
    this.onChange();
  }

  /** 读 allow.txt（每行一个 QQ 号），作为设置页白名单之外的补充。 */
  async refreshAllow() {
    if (this.allowFile === undefined) return;
    const set = new Set();
    try {
      const text = await readFile(this.allowFile, 'utf8');
      for (const token of text.split(/[\s,，、;；]+/)) {
        const value = token.trim();
        if (/^\d{4,12}$/.test(value)) set.add(value);
      }
    } catch {
      /* 文件不存在就是空 */
    }
    this.allowCache = set;
    this.allowAt = Date.now();
  }

  /** 增/删 allow.txt 里的号码，返回当前内容。 */
  async updateAllow(action, qq) {
    const number = String(qq ?? '').trim();
    if (!/^\d{4,12}$/.test(number)) throw new Error(`QQ 号不合法：${qq}`);
    const set = new Set(this.allowCache);
    if (action === 'add') set.add(number);
    else if (action === 'remove') set.delete(number);
    else throw new Error(`不认识的动作：${action}`);
    await ensureDir(this.dataDir ?? dataDirOf(this.getConfig()));
    await writeFile(this.allowFile, [...set].sort().join('\n') + (set.size > 0 ? '\n' : ''), 'utf8');
    await this.refreshAllow();
    this.onChange();
    return [...set].sort();
  }

  /** 当前人设（供工具与人设段读取）。 */
  personaText() {
    return this.personaCache.trim() !== '' ? this.personaCache.trim() : String(this.getConfig().personaPrompt ?? '').trim();
  }

  /** 重新读一次 persona.md（配置页保存后调用）。 */
  async refreshPersona() {
    this.personaCache = (await readPersona(dataDirOf(this.getConfig()))) ?? '';
    this.onChange();
    return this.personaCache;
  }

  /** 写入人设（工具调用；下一轮回答立即生效）。 */
  async writePersonaText(text) {
    await writePersona(dataDirOf(this.getConfig()), text);
    this.personaCache = String(text ?? '').trim();
    this.onChange();
    return this.personaCache;
  }

  /** 判断某个 QQ 号是否允许聊天。 */
  isAllowed(userId, cfg) {
    if (cfg.blocklist.has(userId)) return false;
    if (cfg.whitelist.size === 0) return true;
    return cfg.whitelist.has(userId);
  }

  /**
   * 处理一条 OneBot 事件。
   * @param event - OneBot v11 事件。
   */
  handleEvent(event) {
    const cfg = this.snapshot();
    if (!cfg.enabled) return;
    if (event?.post_type !== 'message') return;
    const selfId = this.client.selfId || String(cfg.raw.selfId ?? '');
    const userId = String(event.user_id ?? '');
    if (userId === '' || userId === selfId) return;
    if (event.message_id !== undefined) {
      const signature = `${event.message_type}:${event.group_id ?? ''}:${userId}:${event.message_id}`;
      if (this.seen.has(signature)) return;
      this.seen.add(signature);
      if (this.seen.size > 400) {
        const oldest = this.seen.values().next().value;
        this.seen.delete(oldest);
      }
    }
    if (event.message_type === 'private') {
      this.onPrivate(event, userId, cfg);
      return;
    }
    if (event.message_type === 'group') this.onGroup(event, userId, selfId, cfg);
  }

  /** 私聊：白名单/黑名单 → 排队 → 回答。 */
  onPrivate(event, userId, cfg) {
    if (!this.isAllowed(userId, cfg)) {
      this.maybeHint(userId, event);
      return;
    }
    const text = messageToText(event.message, { faceNames: cfg.faceNames });
    if (text.trim() === '') return;
    const name = String(event.sender?.card ?? '').trim() || String(event.sender?.nickname ?? '').trim() || userId;
    const conversation = this.ensureConversation({
      key: `private:${userId}`,
      kind: 'private',
      userId,
      groupId: '',
      name,
    });
    this.enqueue(conversation, { text, raw: text, senderName: name, group: false });
  }

  /** 群聊：群开关 → 群白名单 → 是否 @ 机器人 → 排队。 */
  onGroup(event, userId, selfId, cfg) {
    if (!cfg.groupEnabled) return;
    const groupId = String(event.group_id ?? '');
    if (groupId === '') return;
    if (cfg.groupWhitelist.size > 0 && !cfg.groupWhitelist.has(groupId)) return;
    if (!this.isAllowed(userId, cfg)) return;
    if (cfg.groupAtOnly && !mentionsSelf(event.message, selfId)) return;
    const message = stripSelfMention(event.message, selfId);
    const text = messageToText(message, { faceNames: cfg.faceNames });
    if (text.trim() === '') return;
    const name = String(event.sender?.card ?? '').trim() || String(event.sender?.nickname ?? '').trim() || userId;
    const conversation = this.ensureConversation({
      key: `group:${groupId}:${userId}`,
      kind: 'group',
      userId,
      groupId,
      name,
    });
    conversation.groupName = String(event.group_name ?? '').trim();
    this.enqueue(conversation, { text, raw: text, senderName: name, group: true });
  }

  /** 取或建一条会话记录（不建 Agent）。 */
  ensureConversation(meta) {
    const existing = this.conversations.get(meta.key);
    if (existing !== undefined) {
      existing.name = meta.name || existing.name;
      if (meta.kind === 'group' && meta.groupId !== '') existing.groupId = meta.groupId;
      return existing;
    }
    const record = {
      key: meta.key,
      sessionId: sessionIdOf(meta.key),
      generation: 0,
      kind: meta.kind,
      userId: meta.userId,
      groupId: meta.groupId,
      name: meta.name,
      lastAt: Date.now(),
      turns: 0,
      lastProactiveAt: 0,
      proactiveDay: '',
      proactiveCount: 0,
      mood: pickMood(),
      moodAt: Date.now(),
      affinity: AFFINITY_START,
      firstMetAt: Date.now(),
      agent: undefined,
      handle: undefined,
      queue: Promise.resolve(),
      hintAt: 0,
    };
    this.conversations.set(meta.key, record);
    return record;
  }

  /**
   * 清空一段 QQ 会话的上下文：销毁当前 Agent、换一个新的会话 id，
   * 下一句消息从全新的 DSH 会话开始。旧会话记录仍留在磁盘上，但不再被引用。
   * @param conversation - 目标会话。
   * @returns 新会话 id。
   */
  async resetConversation(conversation) {
    const handle = conversation.handle;
    conversation.handle = undefined;
    conversation.agent = undefined;
    if (handle !== undefined) await handle.dispose().catch(() => {});
    conversation.generation = (conversation.generation ?? 0) + 1;
    conversation.sessionId = sessionIdOf(conversation.key, conversation.generation);
    conversation.turns = 0;
    conversation.lastAt = Date.now();
    // 新对话 = 重新认识：好感度和认识时间都归零。
    conversation.affinity = AFFINITY_START;
    conversation.firstMetAt = Date.now();
    this.persistSoon();
    this.logger.info(`dsh-qq: 已重置会话 ${conversation.name} → ${conversation.sessionId}`);
    return conversation.sessionId;
  }

  /** 按 QQ 号 / group:群号 找到会话并重置（工具用）。 */
  async resetByTarget(target) {
    const value = String(target ?? '').trim();
    const group = /^(group|群)[:：]/.test(value);
    const id = value.replace(/^(group|private|群|私聊)[:：]/i, '').trim();
    if (!/^\d{4,12}$/.test(id)) throw new Error(`目标不合法：${value}（填 QQ 号，或 group:群号）`);
    const key = group ? [`group:${id}:`] : [`private:${id}`];
    const found = [...this.conversations.values()].filter((item) => (group ? item.key.startsWith(key[0]) : item.key === key[0]));
    if (found.length === 0) throw new Error(`没有找到会话 ${value}（对方还没跟机器人说过话）`);
    const results = [];
    for (const conversation of found) results.push(await this.resetConversation(conversation));
    return { count: found.length, sessionIds: results };
  }

  /** 把一轮对话排到该会话的串行队列里。 */
  enqueue(conversation, payload) {    conversation.queue = conversation.queue
      .then(() => this.runTurn(conversation, payload))
      .catch((error) => {
        this.logger.warn(`dsh-qq: 队列执行失败 ${error instanceof Error ? error.message : String(error)}`);
      });
  }

  /** 执行一轮：拿 Agent → 提问 → 取回答 → 发回 QQ。 */
  async runTurn(conversation, payload) {
    const cfg = this.snapshot();
    if (!cfg.enabled) return;
    conversation.lastAt = Date.now();
    if (conversation.memory === undefined) {
      conversation.memory = await readMemory(memoryFileOf(this.dataDir ?? dataDirOf(this.getConfig()), conversation.key)).catch(() => []);
    }
    // 「忘记」：清掉长期记忆，但保留当前会话。
    if (/^[/／]?\s*(忘记|忘掉|清空记忆|忘了|forget)$/i.test(payload.text.trim())) {
      conversation.memory = [];
      await writeMemory(memoryFileOf(this.dataDir ?? dataDirOf(this.getConfig()), conversation.key), []).catch(() => {});
      await this.deliver(conversation, '……好。忘了。', cfg, { silent: true });
      return;
    }
    // 对方开口了，追问计时归零；这一轮换一种说话形状，别总是同一个腔调。
    conversation.waitingSince = undefined;
    conversation.followUps = 0;
    conversation.styleIndex = pickStyle(conversation.styleIndex);
    conversation.flavor = pickFlavor(2);
    // 重置指令优先于停止指令：清空上下文，下一句是全新会话。
    if (RESET_PATTERN.test(payload.text.trim())) {
      try {
        await this.resetConversation(conversation);
        await this.deliver(conversation, '好，上下文清空了～我们重新认识一下（现在是一段全新的对话）', cfg, { silent: true });
      } catch (error) {
        this.noteError(`重置会话失败（${conversation.key}）：${error instanceof Error ? error.message : String(error)}`);
        await this.deliver(conversation, '（刚才没清干净，再发一次试试）', cfg, { silent: true }).catch(() => {});
      }
      return;
    }
    if (STOP_PATTERN.test(payload.text.trim())) {
      const agent = conversation.agent;
      if (agent !== undefined && typeof agent.cancel === 'function') {
        try {
          agent.cancel({ kind: 'user' });
        } catch {
          /* 已经空闲 */
        }
        await this.deliver(conversation, '好，停下啦～', cfg, { silent: true });
      }
      return;
    }
    try {
      const agent = await this.ensureAgent(conversation, cfg);
      const turn = await this.converse(agent, payload, cfg, conversation);
      // 模型会在回复末尾带隐藏的好感度/记忆标记；先摘掉再发。
      const affinity = extractAffinityDelta(turn.text);
      if (affinity.delta !== 0 && cfg.affinityEnabled) {
        conversation.affinity = Math.max(0, Math.min(100, (conversation.affinity ?? AFFINITY_START) + affinity.delta));
        this.logger.info(`dsh-qq: 好感度 ${affinity.delta > 0 ? '+' : ''}${affinity.delta} → ${conversation.affinity}（${conversation.name}）`);
      }
      const remembered = extractMemoryMarkers(affinity.text);
      if (cfg.memoryEnabled && remembered.items.length > 0) {
        const next = Array.isArray(conversation.memory) ? [...conversation.memory] : [];
        let changed = false;
        for (const item of remembered.items) {
          if (next.includes(item)) continue;
          next.push(item);
          changed = true;
          this.logger.info(`dsh-qq: 记住（${conversation.name}）：${item}`);
        }
        if (changed) {
          conversation.memory = next.slice(-MEMORY_MAX);
          void writeMemory(memoryFileOf(this.dataDir ?? dataDirOf(this.getConfig()), conversation.key), conversation.memory).catch(() => {});
        }
      }
      let text = this.finalize(remembered.text, cfg);
      if (text === '') {
        const reason = this.lastTurnError;
        this.lastTurnError = '';
        this.noteError(
          `${conversation.key} 这轮没有文本回复（消息 ${turn.before}→${turn.after}，新增角色 ${turn.roles || '无'}，${turn.trace}）${reason === '' ? '' : `；会话报错：${reason}`}`,
        );
        if (reason !== '') {
          await this.deliver(conversation, this.failureText(cfg, reason), cfg, { silent: true }).catch(() => {});
        }
        return;
      }
      this.lastTurnError = '';
      // 模型不爱主动发表情包：按概率兜底补一张；概率随心情和好感浮动。
      if (cfg.stickerEnabled && cfg.stickerPacks.size > 0 && !/\[\[?sticker:/i.test(text)) {
        const rate = stickerRateFor(cfg.stickerAutoRate, conversation.mood, conversation.affinity);
        if (Math.random() < rate) {
          const cute = ['可爱', '猫猫', '熊熊', '狗狗', '仓鼠', '爱心', '皮卡丘'].filter((label) => cfg.stickerPacks.has(label));
          const pool = [...cfg.stickerPacks.keys(), ...cute, ...cute];
          const pick = pool[Math.floor(Math.random() * pool.length)];
          text = `${text}\n\n[[sticker:${pick}]]`;
        }
      }
      await this.deliver(conversation, text, cfg);
      conversation.turns += 1;
      this.turnCount += 1;
      this.lastTurnAt = Date.now();
      // 机器人说完这句就在等对方接了：几分钟没动静会追问（见 maybeProactive）。
      conversation.waitingSince = Date.now();
      conversation.followUps = 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.noteError(`回答失败（${conversation.key}）：${message}`);
      if (cfg.debug && error instanceof Error && error.stack !== undefined) this.logger.warn(error.stack);
      try {
        await this.deliver(conversation, this.failureText(cfg, message), cfg, { silent: true });
      } catch (sendError) {
        this.noteError(`回答失败（${conversation.key}）：${message}；连道歉都发不出去：${sendError instanceof Error ? sendError.message : String(sendError)}`);
      }
    } finally {
      conversation.lastAt = Date.now();
      this.persistSoon();
    }
  }

  /** 回答失败时给 QQ 的话。 */
  failureText(cfg, message) {
    if (/模型/.test(message)) return '（我这边还没配置好模型，去 DSH 设置里挑一个吧）';
    if (/超时/.test(message)) return '（想太久了，脑子打结了……再说一次？）';
    return '（刚刚走神了，再说一次好不好）';
  }

  /** 确保该会话有一个活的 Agent。 */
  async ensureAgent(conversation, cfg) {
    if (conversation.agent !== undefined) return conversation.agent;
    const agents = this.ctx.get('agents');
    if (agents === undefined || typeof agents.create !== 'function') {
      throw new Error('当前 Host 没有可用的 Agent 服务：请确认部署里加载了 agent-loop');
    }
    const presets = this.ctx.get('agentPresets');
    let presetId;
    if (presets !== undefined) {
      try {
        presetId = (await presets.resolve(cfg.agentPreset === '' ? undefined : cfg.agentPreset)).id;
      } catch (error) {
        this.logger.warn(`dsh-qq: 解析 Agent 预设失败，改用默认：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const agentOptions = this.resolveModel(cfg);
    // 两段提示词都在每次组装时重新取快照：表情包、人设、字数上限这些
    // 配置改了不用重建会话就生效（之前闭包捕获了创建时的快照，导致
    // 后来加的表情包模型根本看不见）。
    const personaSection = {
      name: PERSONA_SECTION,
      order: 0,
      text: () => {
        const live = this.snapshot();
        return buildPersona({
          personaName: live.personaName,
          persona: this.personaText(),
          contactName: conversation.name,
        });
      },
    };
    const chatSection = {
      name: CHAT_SECTION,
      order: CHAT_SECTION_ORDER,
      text: () => {
        const live = this.snapshot();
        return buildChatRules({
          replyLimit: live.replyLimit,
          scene:
            conversation.kind === 'group'
              ? `QQ 群 ${conversation.groupName || conversation.groupId} 里，${conversation.name} 在跟你说话`
              : `QQ 私聊，对方是 ${conversation.name}`,
          relationship: live.affinityEnabled
            ? (() => {
                const days = Math.max(0, (Date.now() - (conversation.firstMetAt ?? Date.now())) / 86_400_000);
                const band = relationshipOf(conversation.affinity ?? AFFINITY_START, days);
                const duration = days < 1 ? '不到一天' : days < 2 ? '一天' : `${Math.floor(days)} 天`;
                return {
                  affinity: conversation.affinity ?? AFFINITY_START,
                  days,
                  text: `你们认识 ${duration}，好感度 ${Math.round(conversation.affinity ?? AFFINITY_START)}/100，现在的关系是「${band.label}」。${band.rules}`,
                };
              })()
            : undefined,
          faceEnabled: live.faceEnabled,
          faceNames: [...live.faceNames.values()],
          stickerEnabled: live.stickerEnabled,
          stickerNames: [...live.stickers.keys()],
          stickerPacks: [...live.stickerPacks.entries()].map(([label, list]) => ({ label, count: list.length })),
          kaomojiEnabled: live.kaomojiEnabled,
          kaomoji: live.kaomoji,
          mood: live.moodEnabled ? (conversation.mood ?? '') : '',
          style: live.styleEnabled ? (typeof conversation.styleIndex === 'number' ? STYLE_POOL[conversation.styleIndex] : '') : '',
          flavor: Array.isArray(conversation.flavor) ? conversation.flavor : [],
          memory: live.memoryEnabled && Array.isArray(conversation.memory) ? conversation.memory.slice(-40) : [],
        });
      },
    };
    const setup = async (agentCtx) => {
      if (presets !== undefined && presetId !== undefined && typeof presets.mount === 'function') {
        await presets.mount(agentCtx, presetId);
      }
      agentCtx.systemPrompt.section(personaSection);
      agentCtx.systemPrompt.section(chatSection);
      if (!cfg.toolsAllowed) {
        try {
          agentCtx.tools.restrict({ allow: [] });
        } catch (error) {
          this.logger.warn(`dsh-qq: 关闭 QQ 会话的工具失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    };
    const cwd = await ensureDir(workspaceDirOf(cfg.raw));
    const meta = { cwd, ...(presetId === undefined ? {} : { agentPreset: presetId }) };
    let handle;
    try {
      handle = await agents.resume({ resumeSessionId: conversation.sessionId, agentOptions, setup });
      this.logger.info(`dsh-qq: 继续会话 ${conversation.sessionId}（${conversation.name}）`);
    } catch {
      handle = await agents.create({ sessionId: conversation.sessionId, meta, agentOptions, setup });
      this.logger.info(`dsh-qq: 新建会话 ${conversation.sessionId}（${conversation.name}）`);
    }
    conversation.agent = handle.agent;
    conversation.handle = handle;
    this.onChange();
    return handle.agent;
  }

  /** 解析 provider/model：优先配置，其次部署默认模型。 */
  resolveModel(cfg) {
    const configured = cfg.model;
    if (configured.includes('/')) {
      const index = configured.indexOf('/');
      const provider = configured.slice(0, index).trim();
      const model = configured.slice(index + 1).trim();
      if (provider !== '' && model !== '') return { provider, model };
    }
    const selection = this.ctx.get('agentDefaultModel')?.currentSelection?.();
    const provider = typeof selection?.provider === 'string' ? selection.provider.trim() : '';
    const model = typeof selection?.model === 'string' ? selection.model.trim() : '';
    if (provider === '' || model === '') {
      throw new Error('没有可用的模型：请在「设置 → 模型」里选一个默认模型，或在 QQ 桥接设置里填 模型（provider/model）');
    }
    return { provider, model };
  }

  /** 一轮提问：投递 → 等空闲 → 取最后一条 assistant 文本。 */
  async converse(agent, payload, cfg, conversation) {
    const session = agent.session;
    const before = this.messageList(session).length;
    const trace = [];
    trace.push(`followup=${typeof agent.followup}`, `status0=${String(agent.status)}`, `inbox0=${String(agent.inbox?.hasPending)}`);
    let text = annotateIncoming(payload.text, payload.senderName, payload.group);
    // 上次是「她主动开的口」时，给模型补一句上下文，别让对话接不上。
    if (conversation !== undefined && typeof conversation.lastProactiveText === 'string' && Date.now() - (conversation.lastProactiveAt ?? 0) < 3 * 3_600_000) {
      text = `（你 ${Math.max(1, Math.round((Date.now() - conversation.lastProactiveAt) / 60_000))} 分钟前主动跟他说的是：「${conversation.lastProactiveText}」）\n${text}`;
      conversation.lastProactiveText = undefined;
    }
    const message = {
      id: `qq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'user',
      content: [{ type: 'text', text }],
      // v4 会话格式只接受生产者自有的来源类型；QQ 消息就是一条用户消息。
      source: { kind: 'user' },
    };
    agent.followup(message);
    trace.push(`status1=${String(agent.status)}`, `inbox1=${String(agent.inbox?.hasPending)}`, `act=${agent.activityDone === undefined ? 'unset' : 'set'}`);
    await this.waitIdle(agent, cfg.turnTimeoutMs);
    const messages = this.messageList(session);
    const fresh = messages.slice(before);
    trace.push(`status2=${String(agent.status)}`, `inbox2=${String(agent.inbox?.hasPending)}`, `msgs=${messages.length}`);
    return {
      text: this.lastAssistantText(fresh),
      before,
      after: messages.length,
      roles: fresh.map((item) => String(item?.role ?? '?')).join(','),
      status: String(agent.status ?? '?'),
      trace: trace.join(' '),
    };
  }

  /** 安全读会话消息（deriveMessages 可能不存在）。 */
  messageList(session) {
    try {
      const messages = session?.deriveMessages?.();
      return Array.isArray(messages) ? messages : [];
    } catch {
      return [];
    }
  }

  /** 等 Agent 空闲；超时就取消这一轮。 */
  async waitIdle(agent, timeoutMs) {
    let timer;
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(Object.assign(new Error('回答超时'), { dshQqTimeout: true }));
      }, timeoutMs);
      timer.unref?.();
    });
    try {
      await Promise.race([agent.whenIdle(), timeout]);
    } catch (error) {
      if (error?.dshQqTimeout === true) {
        try {
          agent.cancel({ kind: 'hook', reason: 'dsh-qq turn timeout' });
        } catch {
          /* 已结束 */
        }
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 取最后一条有文本的 assistant 消息。 */
  lastAssistantText(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message === null || typeof message !== 'object') continue;
      if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
      const text = message.content
        .flatMap((block) => (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
        .join('')
        .trim();
      if (text !== '') return text;
    }
    return '';
  }

  /** 清洗模型回复：去 Markdown、去机制话术、去自称前缀、必要时补一个颜文字。 */
  finalize(raw, cfg) {
    let text = tidy(raw);
    if (text === '') return '';
    text = stripMarkdown(text);
    const before = text;
    text = tidy(stripMetaTalk(text));
    // 整句都是机制话术、被清空了：给个极短的自然反应，别让这轮变成"没有回复"。
    if (text === '' && before.trim() !== '') {
      const fallback = ['嗯', '哦', '……', '算了'][Math.floor(Math.random() * 4)];
      return fallback;
    }
    const name = cfg.personaName;
    if (name !== '') {
      const prefix = new RegExp(`^\\s*[「『"']?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[」』"']?\\s*[:：]\\s*`);
      text = text.replace(prefix, '');
    }
    text = text.replace(/^\s*assistant\s*[:：]\s*/i, '');
    text = tidy(text.replace(/^[「『"]|[」』"]$/g, ''));
    if (text === '') return '';
    if (cfg.kaomojiEnabled && cfg.kaomojiAuto && !hasKaomoji(text) && text.length <= cfg.replyLimit && Math.random() < 0.35) {
      const kaomoji = pickKaomoji(cfg.kaomoji);
      if (kaomoji !== '') text = `${text} ${kaomoji}`;
    }
    return text;
  }

  /** 发一条（可能分多条气泡的）消息。 */
  async deliver(conversation, text, cfg, options = {}) {
    const parsed = parseOutbound(text, {
      faceMap: cfg.faceMap,
      stickers: cfg.stickers,
      stickerPacks: new Set(cfg.stickerPacks.keys()),
      faceEnabled: cfg.faceEnabled,
      stickerEnabled: cfg.stickerEnabled,
    });
    if (parsed.length === 0) return;
    // 一条回复最多两张表情包、两个小黄脸：模型偶尔会连发一串，QQ 上就是刷屏。
    let stickerCount = 0;
    let faceCount = 0;
    const segments = parsed.filter((segment) => {
      if (segment.type === 'sticker') {
        stickerCount += 1;
        return stickerCount <= 2;
      }
      if (segment.type === 'face') {
        faceCount += 1;
        return faceCount <= 2;
      }
      return true;
    });
    const bubbles = cfg.bubbles ? splitBubbles(segments, cfg.replyLimit) : splitBubbles(segments, Math.max(cfg.replyLimit, 1800));
    const slice = bubbles.length > 6 ? bubbles.slice(0, 6) : bubbles;
    for (let index = 0; index < slice.length; index += 1) {
      await this.sendSegments(conversation, slice[index], cfg);
      if (index < slice.length - 1 && cfg.bubbleDelayMs > 0) await sleep(cfg.bubbleDelayMs);
    }
    if (options.silent !== true && cfg.debug) this.logger.info(`dsh-qq: 已回复 ${conversation.name}（${slice.length} 条）`);
  }

  /** 把消息段数组发给 QQ。 */
  async sendSegments(conversation, segments, cfg) {
    const message = [];
    for (const segment of segments) {
      if (segment.type === 'text') {
        const value = segment.text.replace(/\s+$/, '');
        if (value !== '') message.push({ type: 'text', data: { text: value } });
        continue;
      }
      if (segment.type === 'face') {
        message.push({ type: 'face', data: { id: String(segment.id) } });
        continue;
      }
      if (segment.type === 'sticker') {
        // 先按具名表情找；找不到再看是不是风格包（包内随机一张）。
        let source = cfg.stickers.get(segment.name);
        if (source === undefined) {
          const pool = cfg.stickerPacks.get(segment.name);
          if (pool !== undefined && pool.length > 0) source = pool[Math.floor(Math.random() * pool.length)];
        }
        const image = await stickerSegment(source);
        if (image !== undefined) message.push(image);
      }
    }
    if (message.length === 0) return;
    try {
      if (conversation.kind === 'group') {
        await this.client.call('send_group_msg', { group_id: conversation.groupId, message, auto_escape: false });
      } else {
        await this.client.call('send_private_msg', { user_id: conversation.userId, message, auto_escape: false });
      }
    } catch (error) {
      this.noteError(`发送失败（${conversation.key}）：${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /** 陌生人/非白名单提示（限频）。 */
  maybeHint(userId, event) {
    const now = Date.now();
    const last = this.hints.get(userId) ?? 0;
    if (now - last < HINT_COOLDOWN_MS) return;
    this.hints.set(userId, now);
    const conversation = this.ensureConversation({ key: `private:${userId}`, kind: 'private', userId, groupId: '', name: userId });
    void this.deliver(conversation, '（我还不在你的白名单里～去 DSH「设置 → QQ 桥接」把我的 QQ 号加进去就能聊了）', this.snapshot(), { silent: true }).catch(() => {});
  }

  /** 工具用：主动发一条消息到指定目标。 */
  async sendToTarget(target, text) {
    const cfg = this.snapshot();
    const value = String(target ?? '').trim();
    const group = /^(group|群)[:：]/.test(value);
    const id = value.replace(/^(group|private|群|私聊)[:：]/i, '').trim();
    if (!/^\d{4,12}$/.test(id)) throw new Error(`目标不合法：${value}（应填 QQ 号，或 group:群号）`);
    const conversation = this.ensureConversation({
      key: group ? `group:${id}:system` : `private:${id}`,
      kind: group ? 'group' : 'private',
      userId: id,
      groupId: group ? id : '',
      name: group ? `群 ${id}` : id,
    });
    if (group) conversation.groupId = id;
    await this.deliver(conversation, text, cfg);
    return { group, id };
  }

  /** 工具用：一句话状态。 */
  statusText() {
    const cfg = this.snapshot();
    const status = this.client.status();
    const link = status.wsOpen
      ? `WebSocket 已连接（${status.wsUrl}）`
      : status.httpListening
        ? `HTTP 上报监听中（${status.eventPort}）`
        : '未连接';
    const recent = [...this.conversations.values()]
      .filter((item) => item.lastAt > 0)
      .sort((a, b) => b.lastAt - a.lastAt)[0];
    const lines = [
      `QQ 桥接：${cfg.enabled ? '已启用' : '已停用'}`,
      `连接：${link}${status.selfId === '' ? '' : ` · 机器人 QQ ${status.selfId}`}`,
      `人设：${cfg.personaName || '（未命名）'}（${cfg.persona.length} 字，来自 ${cfg.personaSource}）`,
      `白名单：${cfg.whitelist.size === 0 ? '未设置（只允许纯聊天）' : `${cfg.whitelist.size} 个 QQ`} · 工具：${cfg.toolsAllowed ? '开启' : '关闭'}`,
      `表情包：${cfg.stickers.size} 个具名 + ${cfg.stickerPacks.size} 个风格包（${[...cfg.stickerPacks.values()].reduce((n, list) => n + list.length, 0)} 张）· 小黄脸：${cfg.faceEnabled ? '开' : '关'} · 颜文字：${cfg.kaomojiEnabled ? '开' : '关'}`,
      `已知会话：${this.conversations.size} 个${recent === undefined ? '' : `（最近：${recent.name}）`}`,
      ...(recent === undefined
        ? []
        : [
            `好感度：${Math.round(recent.affinity ?? AFFINITY_START)}/100 · 认识 ${Math.max(0, Math.floor((Date.now() - (recent.firstMetAt ?? Date.now())) / 86_400_000))} 天 · ${relationshipOf(recent.affinity ?? AFFINITY_START, 0).label}`,
          ]),
      `配置页：http://127.0.0.1:${String(this.getConfig().eventPort ?? 5701)}/admin`,
      `版本：${BUILD}`,
    ];
    if (status.lastError !== '') lines.push(`最近错误：${status.lastError}`);
    if (this.lastError !== '') {
      const when = new Date(this.lastErrorAt).toLocaleTimeString('zh-CN', { hour12: false });
      lines.push(`最近失败（${when}）：${this.lastError}`);
    }
    if (cfg.debug && this.trace.length > 0) lines.push(`时序：${this.trace.slice(-10).join(' → ')}`);
    return lines.join('\n');
  }

  /** 工具用：会话列表。 */
  conversationsText() {
    if (this.conversations.size === 0) return '还没有任何 QQ 会话。';
    const rows = [...this.conversations.values()]
      .sort((a, b) => b.lastAt - a.lastAt)
      .slice(0, 20)
      .map((item) => {
        const when = item.lastAt === 0 ? '从未' : new Date(item.lastAt).toLocaleString('zh-CN', { hour12: false });
        const kind = item.kind === 'group' ? `群 ${item.groupId}` : '私聊';
        return `- ${item.name}（${kind}，${item.userId}）· ${item.turns} 轮 · 最近 ${when}`;
      });
    return `共 ${this.conversations.size} 个 QQ 会话：\n${rows.join('\n')}`;
  }

  /**
   * 空闲主动找人：一段时间没消息，就按人设口吻先发一句（傲娇高中生的味儿）。
   * 只在私聊、白名单内、非免打扰时段、且当天没超过上限时发。
   */
  async maybeProactive() {
    const cfg = this.snapshot();
    if (this.client.status === undefined || this.client.online !== true) return;
    if (inQuietHours(cfg.proactiveQuietStart, cfg.proactiveQuietEnd)) return;
    const now = Date.now();
    const today = new Date().toDateString();
    const selfId = this.client.selfId || String(cfg.raw.selfId ?? '');

    // 对话内追问：上一句是机器人说的，对方几分钟没接，就开始追问/不耐烦。
    if (cfg.followUpEnabled && cfg.followUpMax > 0) {
      for (const conversation of this.conversations.values()) {
        if (conversation.kind !== 'private') continue;
        if (conversation.waitingSince === undefined) continue;
        if (conversation.userId === selfId) continue;
        if (!this.isAllowed(conversation.userId, cfg)) continue;
        const waited = now - conversation.waitingSince;
        // 等太久（40 分钟）就当对话结束了，交给"久未联系"那套逻辑。
        if (waited > 40 * 60_000) {
          conversation.waitingSince = undefined;
          continue;
        }
        // 好感越高，越沉不住气：等得越短、追问次数越多。
        const trust = (conversation.affinity ?? AFFINITY_START) / 100;
        const followUpMs = Math.max(3 * 60_000, Math.min(20 * 60_000, cfg.followUpMs * (1.6 - 0.9 * trust)));
        const followUpMax = trust < 0.25 ? 1 : cfg.followUpMax;
        if (waited < followUpMs) continue;
        if ((conversation.followUps ?? 0) >= followUpMax) continue;
        const pool = (conversation.followUps ?? 0) === 0 ? FOLLOW_UP_LINES_1 : FOLLOW_UP_LINES_2;
        const text = pool[Math.floor(Math.random() * pool.length)];
        try {
          await this.deliver(conversation, text, cfg, { silent: true });
          conversation.followUps = (conversation.followUps ?? 0) + 1;
          conversation.waitingSince = now;
          conversation.lastAt = now;
          conversation.lastProactiveAt = now;
          conversation.lastProactiveText = text;
          this.persistSoon();
          this.logger.info(`dsh-qq: 追问 ${conversation.name}（第 ${conversation.followUps} 次）：「${text}」`);
        } catch (error) {
          this.noteError(`追问发送失败（${conversation.key}）：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    if (!cfg.proactiveEnabled || cfg.proactiveMaxPerDay <= 0) return;
    if (inQuietHours(cfg.proactiveQuietStart, cfg.proactiveQuietEnd)) return;
    for (const conversation of this.conversations.values()) {
      if (conversation.kind !== 'private') continue;
      if (conversation.userId === selfId) continue;
      if (!this.isAllowed(conversation.userId, cfg)) continue;
      // 好感越高，越沉不住气、越早主动开口。
      const trust = (conversation.affinity ?? AFFINITY_START) / 100;
      const idleMs = Math.max(40 * 60_000, Math.min(12 * 3_600_000, cfg.proactiveIdleMs * (1.8 - 1.1 * trust)));
      const maxPerDay = trust < 0.2 ? 0 : Math.min(cfg.proactiveMaxPerDay, trust < 0.55 ? 1 : 2);
      if (maxPerDay <= 0) continue;
      if (now - conversation.lastAt < idleMs) continue;
      // 太久没聊（>3 天）就别硬戳了，像个陌生人。
      if (now - conversation.lastAt > 3 * 86_400_000) continue;
      const sameDay = conversation.proactiveDay === today;
      if (sameDay && (conversation.proactiveCount ?? 0) >= maxPerDay) continue;
      if (now - (conversation.lastProactiveAt ?? 0) < 6 * 3_600_000) continue;
      const text = PROACTIVE_LINES[Math.floor(Math.random() * PROACTIVE_LINES.length)];
      try {
        await this.deliver(conversation, text, cfg, { silent: true });
        conversation.lastProactiveAt = now;
        conversation.lastProactiveText = text;
        conversation.proactiveDay = today;
        conversation.proactiveCount = sameDay ? (conversation.proactiveCount ?? 0) + 1 : 1;
        // 主动发过话也算"最近有动静"，否则下一分钟又会触发。
        conversation.lastAt = now;
        this.persistSoon();
        this.logger.info(`dsh-qq: 主动找 ${conversation.name}：「${text}」`);
      } catch (error) {
        this.noteError(`主动消息发送失败（${conversation.key}）：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** 休眠长时间没动静的 Agent（会话历史保留，下次自动 resume）。 */
  async sweep() {
    if (this.allowAt === 0 || Date.now() - this.allowAt > 30_000) await this.refreshAllow().catch(() => {});
    await this.maybeProactive().catch(() => {});
    const cfg = this.snapshot();
    // 心情会随时间自己换，不跟对方的情绪绑定。
    if (cfg.moodEnabled) {
      const now = Date.now();
      let changed = false;
      for (const conversation of this.conversations.values()) {
        if (now - (conversation.moodAt ?? 0) < cfg.moodRefreshMs) continue;
        conversation.mood = pickMood();
        conversation.moodAt = now;
        changed = true;
      }
      if (changed) this.persistSoon();
    }
    const now = Date.now();
    for (const conversation of this.conversations.values()) {
      if (conversation.handle === undefined) continue;
      if (now - conversation.lastAt < cfg.idleMs) continue;
      const handle = conversation.handle;
      conversation.handle = undefined;
      conversation.agent = undefined;
      try {
        await handle.dispose();
        this.logger.info(`dsh-qq: 会话 ${conversation.name} 空闲休眠`);
      } catch (error) {
        this.logger.warn(`dsh-qq: 休眠会话失败 ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** 防抖写状态文件。 */
  persistSoon() {
    if (this.stateFile === '') return;
    if (this.persistTimer !== null) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persist();
    }, PERSIST_DEBOUNCE_MS);
    this.persistTimer.unref?.();
  }

  /** 写状态文件。 */
  async persist() {
    const conversations = {};
    for (const [key, item] of this.conversations) {
      conversations[key] = {
        sessionId: item.sessionId,
        generation: item.generation ?? 0,
        kind: item.kind,
        userId: item.userId,
        groupId: item.groupId,
        name: item.name,
        lastAt: item.lastAt,
        turns: item.turns,
        lastProactiveAt: item.lastProactiveAt ?? 0,
        proactiveDay: item.proactiveDay ?? '',
        proactiveCount: item.proactiveCount ?? 0,
        ...(typeof item.lastProactiveText === 'string' ? { lastProactiveText: item.lastProactiveText } : {}),
        ...(item.waitingSince === undefined ? {} : { waitingSince: item.waitingSince }),
        followUps: item.followUps ?? 0,
        mood: item.mood ?? '',
        moodAt: item.moodAt ?? 0,
        affinity: item.affinity ?? AFFINITY_START,
        firstMetAt: item.firstMetAt ?? 0,
      };
    }
    try {
      await writeJson(this.stateFile, { version: 1, conversations });
    } catch (error) {
      this.logger.warn(`dsh-qq: 写状态文件失败 ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 卸载：停掉所有 Agent 与写盘。 */
  async dispose() {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await this.persist().catch(() => {});
    for (const conversation of this.conversations.values()) {
      const handle = conversation.handle;
      conversation.handle = undefined;
      conversation.agent = undefined;
      if (handle !== undefined) await handle.dispose().catch(() => {});
    }
    this.conversations.clear();
  }
}
