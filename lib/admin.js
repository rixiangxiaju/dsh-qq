/**
 * 插件自带的本地配置页：`http://127.0.0.1:<eventPort>/admin`
 *
 * DSH 0.2.1 的 settings 服务只给「顶层插件行」自动生成表单，bundle 安装的插件
 * 拿不到 schema（读的是 include 组的 fiber），所以这里自带一个零依赖的页面：
 * GET /admin 返回 HTML，GET/POST /admin/config 读写叠加配置（settings.json）。
 *
 * 安全：只绑 127.0.0.1；写操作要求 `x-dsh-qq-admin: 1` 请求头，普通网页表单
 * 无法伪造自定义头，能挡住跨站表单提交。
 *
 * @module dsh-qq/admin
 */

/** 页面里可编辑的字段（顺序即渲染顺序）。 */
export const ADMIN_FIELDS = [
  { key: 'personaName', label: '人设名字', type: 'text', hint: 'QQ 上的自称，例如「小深」' },
  { key: 'personaPrompt', label: '人设正文', type: 'textarea', rows: 8, hint: '写清楚性格、说话方式、口头禅。留空则用人设文件的默认值。' },
  { key: 'whitelist', label: '白名单 QQ 号', type: 'text', hint: '逗号/空格/换行分隔。留空 = 谁都能聊但工具全关；这里和 ~/.dsh/qq-bridge/allow.txt 取并集。' },
  { key: 'blocklist', label: '黑名单 QQ 号', type: 'text', hint: '永不回复的号。' },
  { key: 'allowTools', label: '允许 QQ 端使用工具', type: 'checkbox', hint: '能读写文件/执行命令。白名单非空才真正生效；改完对「新建的会话」生效。' },
  { key: 'groupEnabled', label: '响应群聊', type: 'checkbox', hint: '默认关闭。' },
  { key: 'groupWhitelist', label: '群白名单', type: 'text', hint: '留空 = 所有群（前提是打开了群聊）。' },
  { key: 'groupAtOnly', label: '群里只有 @ 我才回', type: 'checkbox', hint: '建议保持开启。' },
  { key: 'replyLimit', label: '单条字数上限', type: 'number', hint: '超出自动分条。' },
  { key: 'bubbles', label: '长回复自动分条', type: 'checkbox', hint: '' },
  { key: 'bubbleDelayMs', label: '分条间隔（毫秒）', type: 'number', hint: '450 左右比较像真人。' },
  { key: 'kaomojiEnabled', label: '使用颜文字', type: 'checkbox', hint: '' },
  { key: 'kaomojiAuto', label: '模型没写时偶尔补一个颜文字', type: 'checkbox', hint: '' },
  { key: 'kaomojiPool', label: '颜文字池', type: 'textarea', rows: 5, hint: '每行一个。' },
  { key: 'faceEnabled', label: '发 QQ 小黄脸', type: 'checkbox', hint: '模型写 [face:微笑] 时真的发出来。' },
  { key: 'faceMap', label: '自定义小黄脸映射', type: 'textarea', rows: 3, hint: '每行「名字=表情ID」，例如 微笑=14。留空用内置表。' },
  { key: 'stickerDir', label: '表情包目录', type: 'text', hint: '目录里每个图片文件名就是一个表情名（png/jpg/gif/webp，≤5MB）。' },
  { key: 'stickerMap', label: '表情包表', type: 'textarea', rows: 3, hint: '每行「名字=本地路径或图片URL」。' },
  { key: 'idleMinutes', label: '空闲休眠（分钟）', type: 'number', hint: '多久没聊让 Agent 休眠，历史仍保留。' },
  { key: 'turnTimeoutMinutes', label: '单次回答超时（分钟）', type: 'number', hint: '' },
  { key: 'proactiveEnabled', label: '会主动找你', type: 'checkbox', hint: '长时间没消息时，她会先开口（只私聊、白名单内、免打扰时段之外）。' },
  { key: 'proactiveIdleMinutes', label: '多久没消息算「久」（分钟）', type: 'number', hint: '默认 240 = 4 小时。' },
  { key: 'proactiveMaxPerDay', label: '每天最多主动几次', type: 'number', hint: '0 = 不主动；默认 1。' },
  { key: 'proactiveQuietStart', label: '免打扰开始 / 结束', type: 'text', hint: '格式 HH:MM，例如 23:00 / 07:00（跨零点支持）。开始和结束要分两个字段改，这里填开始。' },
  { key: 'proactiveQuietEnd', label: '免打扰结束时间', type: 'text', hint: '例如 07:00' },
  { key: 'followUpEnabled', label: '没接话会追问', type: 'checkbox', hint: '她刚说完一句、你几分钟没回，就会追问或开始不耐烦。' },
  { key: 'followUpMinutes', label: '等你多久开始追问（分钟）', type: 'number', hint: '默认 5。' },
  { key: 'followUpMax', label: '一轮最多追问几次', type: 'number', hint: '默认 2（先追问、再赌气），0 = 不追问。' },
  { key: 'moodEnabled', label: '她有自己的心情', type: 'checkbox', hint: '心情会自己变，语气跟着变，不总顺着你。' },
  { key: 'moodRefreshMinutes', label: '心情多久换一次（分钟）', type: 'number', hint: '默认 40。' },
  { key: 'styleEnabled', label: '每轮换说话形状', type: 'checkbox', hint: '只回几个字 / 连发三条 / 岔开话题 / 只发一个表情……避免腔调单一。' },
  { key: 'affinityEnabled', label: '好感度系统', type: 'checkbox', hint: '按你说的内容实时加减好感；关系深浅决定语气和主动性；/清空 后重新认识。' },
  { key: 'model', label: '指定模型', type: 'text', hint: '格式 provider/model，留空用 DSH 默认模型。' },
  { key: 'agentPreset', label: 'Agent 预设', type: 'text', hint: '留空用部署默认预设。' },
  { key: 'debug', label: '调试日志', type: 'checkbox', hint: '打开后 qq_status 会带最近时序事件。' },
];

/** 只读展示的连接信息。 */
const READONLY_FIELDS = [
  ['onebotWsUrl', 'OneBot WebSocket'],
  ['onebotHttpApi', 'OneBot HTTP API'],
  ['eventPort', '本地上报端口'],
  ['transport', '传输方式'],
];

/** 转义 HTML。 */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 渲染配置页。
 * @param options - 当前值、只读连接信息与状态行。
 * @returns 完整 HTML。
 */
export function renderAdminPage(options) {
  const values = options.values ?? {};
  const status = options.status ?? '';
  const rows = ADMIN_FIELDS.map((field) => {
    const value = values[field.key];
    let control;
    if (field.type === 'checkbox') {
      control = `<input type="checkbox" data-key="${field.key}" ${value === true ? 'checked' : ''}>`;
    } else if (field.type === 'textarea') {
      control = `<textarea data-key="${field.key}" rows="${field.rows ?? 4}">${esc(value ?? '')}</textarea>`;
    } else if (field.type === 'number') {
      control = `<input type="number" data-key="${field.key}" value="${esc(value ?? '')}">`;
    } else {
      control = `<input type="text" data-key="${field.key}" value="${esc(value ?? '')}">`;
    }
    return `<tr>
      <th><label>${esc(field.label)}</label>${field.hint === '' ? '' : `<small>${esc(field.hint)}</small>`}</th>
      <td>${control}</td>
    </tr>`;
  }).join('\n');

  const readonly = READONLY_FIELDS.map(([key, label]) => `<div class="ro"><span>${esc(label)}</span><code>${esc(values[key] ?? '')}</code></div>`).join('');

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QQ 桥接 · 配置</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.6 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; background: #f6f7f9; color: #1b1f24; }
  header { position: sticky; top: 0; backdrop-filter: blur(8px); background: rgba(246,247,249,.86); border-bottom: 1px solid #e3e6ea; padding: 14px 20px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  h1 { font-size: 16px; margin: 0; font-weight: 600; }
  .status { margin-left: auto; font-size: 12px; color: #5b6270; }
  main { max-width: 860px; margin: 18px auto 60px; padding: 0 16px; }
  .card { background: #fff; border: 1px solid #e3e6ea; border-radius: 12px; padding: 6px 16px; margin-bottom: 16px; box-shadow: 0 1px 2px rgba(16,24,40,.04); }
  table { width: 100%; border-collapse: collapse; }
  tr + tr td, tr + tr th { border-top: 1px solid #eef0f3; }
  th { text-align: left; width: 34%; padding: 12px 12px 12px 0; vertical-align: top; font-weight: 500; }
  th small { display: block; font-weight: 400; color: #6b7280; font-size: 12px; margin-top: 2px; }
  td { padding: 12px 0; }
  input[type=text], input[type=number], textarea { width: 100%; padding: 8px 10px; border: 1px solid #d5d9e0; border-radius: 8px; font: inherit; background: #fff; }
  input[type=text]:focus, input[type=number]:focus, textarea:focus { outline: 2px solid #2f7cf6; outline-offset: -1px; border-color: transparent; }
  textarea { resize: vertical; font-family: ui-monospace, Consolas, monospace; font-size: 13px; }
  input[type=checkbox] { width: 18px; height: 18px; }
  .ro { display: flex; gap: 10px; padding: 8px 0; font-size: 13px; color: #4b5563; border-top: 1px solid #eef0f3; }
  .ro span { width: 34%; }
  .ro code { font-family: ui-monospace, Consolas, monospace; }
  button { font: inherit; padding: 8px 16px; border-radius: 8px; border: 1px solid #d5d9e0; background: #fff; cursor: pointer; }
  button.primary { background: #2f7cf6; border-color: #2f7cf6; color: #fff; font-weight: 500; }
  button:disabled { opacity: .55; cursor: default; }
  .hint { color: #6b7280; font-size: 12px; }
  @media (prefers-color-scheme: dark) {
    body { background: #16181d; color: #e6e8ea; }
    header { background: rgba(22,24,29,.86); border-color: #2a2e35; }
    .card { background: #1d2026; border-color: #2a2e35; }
    th small, .hint, .status { color: #9aa3af; }
    tr + tr td, tr + tr th, .ro { border-color: #2a2e35; }
    input[type=text], input[type=number], textarea, button { background: #23272e; color: #e6e8ea; border-color: #363b44; }
  }
</style></head>
<body>
<header>
  <h1>QQ 桥接 · 配置</h1>
  <span class="status">${esc(status)}</span>
  <button id="save" class="primary">保存</button>
</header>
<main>
  <div class="card"><table>${rows}</table></div>
  <div class="card">
    <p class="hint">连接参数（只读，改这里请在 DSH 侧设置或编辑 profile）：</p>
    ${readonly}
  </div>
  <p class="hint">保存后立即生效：人设、白名单、表情包、分条、颜文字都影响下一条消息；<code>allowTools</code> 对新建会话生效。</p>
  <p class="hint">想清空某段 QQ 对话的上下文：在 QQ 里对机器人发 <code>/清空</code>（或 <code>重置</code>、<code>重新开始</code>），下一句就是全新会话。</p>
</main>
<script>
const $ = (s) => document.querySelector(s);
const HEADERS = { 'content-type': 'application/json', 'x-dsh-qq-admin': '1' };
async function load() {
  const res = await fetch('/admin/config', { headers: { 'x-dsh-qq-admin': '1' } });
  const data = await res.json();
  for (const el of document.querySelectorAll('[data-key]')) {
    const key = el.dataset.key;
    const value = data.values?.[key];
    if (el.type === 'checkbox') el.checked = value === true;
    else el.value = value ?? '';
  }
}
function collect() {
  const out = {};
  for (const el of document.querySelectorAll('[data-key]')) {
    const key = el.dataset.key;
    if (el.type === 'checkbox') out[key] = el.checked;
    else if (el.type === 'number') out[key] = el.value === '' ? null : Number(el.value);
    else out[key] = el.value;
  }
  return out;
}
async function save() {
  const button = $('#save');
  button.disabled = true;
  button.textContent = '保存中…';
  try {
    const res = await fetch('/admin/config', { method: 'POST', headers: HEADERS, body: JSON.stringify(collect()) });
    const data = await res.json();
    if (!res.ok || data.ok !== true) throw new Error(data.error ?? ('HTTP ' + res.status));
    button.textContent = '已保存 ✓';
    setTimeout(() => { button.textContent = '保存'; button.disabled = false; }, 1400);
  } catch (error) {
    button.textContent = '保存失败';
    alert('保存失败：' + error.message);
    button.disabled = false;
    setTimeout(() => { button.textContent = '保存'; }, 1400);
  }
}
$('#save').addEventListener('click', save);
load().catch((error) => { document.querySelector('.status').textContent = '读取失败：' + error.message; });
</script>
</body></html>`;
}
