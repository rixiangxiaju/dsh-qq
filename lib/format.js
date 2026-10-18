/**
 * 消息文本的进出转换：QQ 富文本 → 模型可读文本，模型文本 → OneBot 消息段。
 *
 * 出站协议（写进人设提示词，模型照做即可）：
 *   [face:微笑]        发一个 QQ 小黄脸（也接受 face id：[face:14]）
 *   [[sticker:猫猫]]   发一张配置好的图片表情包
 * 其余文本原样发送，颜文字本身就是普通文本。
 *
 * @module dsh-qq/format
 */

/** 常用 QQ 小黄脸：中文情绪 → face id。 id 取自 QQ 经典表情表。 */
export const DEFAULT_FACE_MAP = Object.freeze({
  "惊讶": 0,
  "撇嘴": 1,
  "色": 2,
  "发呆": 3,
  "得意": 4,
  "流泪": 5,
  "害羞": 6,
  "闭嘴": 7,
  "睡": 8,
  "大哭": 9,
  "尴尬": 10,
  "发怒": 11,
  "调皮": 12,
  "呲牙": 13,
  "微笑": 14,
  "难过": 15,
  "酷": 16,
  "抓狂": 18,
  "吐": 19,
  "偷笑": 20,
  "可爱": 21,
  "白眼": 22,
  "傲慢": 23,
  "饥饿": 24,
  "困": 25,
  "惊恐": 26,
  "流汗": 27,
  "憨笑": 28,
  "悠闲": 29,
  "奋斗": 30,
  "咒骂": 31,
  "疑问": 32,
  "嘘": 33,
  "晕": 34,
  "折磨": 35,
  "衰": 36,
  "骷髅": 37,
  "敲打": 38,
  "再见": 39,
  "发抖": 41,
  "爱情": 42,
  "跳跳": 43,
  "猪头": 46,
  "拥抱": 49,
  "蛋糕": 53,
  "炸弹": 55,
  "刀": 56,
  "便便": 59,
  "咖啡": 60,
  "玫瑰": 63,
  "凋谢": 64,
  "爱心": 66,
  "心碎": 67,
  "太阳": 74,
  "月亮": 75,
  "赞": 76,
  "踩": 77,
  "握手": 78,
  "胜利": 79,
  "飞吻": 85,
  "怄火": 86,
  "西瓜": 89,
  "冷汗": 96,
  "擦汗": 97,
  "抠鼻": 98,
  "鼓掌": 99,
  "糗大了": 100,
  "坏笑": 101,
  "左哼哼": 102,
  "右哼哼": 103,
  "哈欠": 104,
  "鄙视": 105,
  "委屈": 106,
  "快哭了": 107,
  "阴险": 108,
  "左亲亲": 109,
  "吓": 110,
  "可怜": 111,
  "菜刀": 112,
  "篮球": 114,
  "示爱": 116,
  "抱拳": 118,
  "勾引": 119,
  "拳头": 120,
  "差劲": 121,
  "爱你": 122,
  "NO": 123,
  "OK": 124,
  "转圈": 125,
  "挥手": 129,
  "鞭炮": 137,
  "喝彩": 144,
  "爆筋": 146,
  "棒棒糖": 147,
  "喝奶": 148,
  "手枪": 169,
  "茶": 171,
  "眨眼睛": 172,
  "泪奔": 173,
  "无奈": 174,
  "卖萌": 175,
  "小纠结": 176,
  "喷血": 177,
  "斜眼笑": 178,
  "doge": 179,
  "惊喜": 180,
  "戳一戳": 181,
  "笑哭": 182,
  "我最美": 183,
  "羊驼": 185,
  "幽灵": 187,
  "大笑": 193,
  "不开心": 194,
  "呃": 198,
  "求求": 200,
  "点赞": 201,
  "无聊": 202,
  "托脸": 203,
  "吃": 204,
  "害怕": 206,
  "飙泪": 210,
  "我不看": 211,
  "托腮": 212,
  "啵啵": 214,
  "糊脸": 215,
  "拍头": 216,
  "扯一扯": 217,
  "舔一舔": 218,
  "蹭一蹭": 219,
  "顶呱呱": 221,
  "抱抱": 222,
  "暴击": 223,
  "开枪": 224,
  "撩一撩": 225,
  "拍桌": 226,
  "拍手": 227,
  "干杯": 229,
  "嘲讽": 230,
  "哼": 231,
  "佛系": 232,
  "掐一掐": 233,
  "颤抖": 235,
  "偷看": 237,
  "扇脸": 238,
  "原谅": 239,
  "喷脸": 240,
  "生日快乐": 241,
  "甩头": 243,
  "扔狗": 244,
  "脑阔疼": 262,
  "沧桑": 263,
  "捂脸": 264,
  "辣眼睛": 265,
  "哦哟": 266,
  "头秃": 267,
  "问号脸": 268,
  "暗中观察": 269,
  "emm": 270,
  "吃瓜": 271,
  "呵呵哒": 272,
  "我酸了": 273,
  "汪汪": 277,
  "汗": 278,
  "无眼笑": 281,
  "敬礼": 282,
  "狂笑": 283,
  "面无表情": 284,
  "摸鱼": 285,
  "魔鬼笑": 286,
  "哦": 287,
  "请": 288,
  "睁眼": 289,
  "敲开心": 290,
  "让我康康": 292,
  "摸锦鲤": 293,
  "期待": 294,
  "拿到红包": 295,
  "拜谢": 297,
  "元宝": 298,
  "牛啊": 299,
  "胖三斤": 300,
  "好闪": 301,
  "左拜年": 302,
  "右拜年": 303,
  "右亲亲": 305,
  "牛气冲天": 306,
  "喵喵": 307,
  "打call": 311,
  "变形": 312,
  "仔细分析": 314,
  "菜汪": 317,
  "崇拜": 318,
  "比心": 319,
  "庆祝": 320,
  "拒绝": 322,
  "嫌弃": 323,
  "吃糖": 324,
  "惊吓": 325,
  "生气": 326,
  "举牌牌": 332,
  "烟花": 333,
  "虎虎生威": 334,
  "豹富": 336,
  "花朵脸": 337,
  "我想开了": 338,
  "舔屏": 339,
  "打招呼": 341,
  "酸Q": 342,
  "我方了": 343,
  "大怨种": 344,
  "红包多多": 345,
  "你真棒棒": 346,
  "大展宏兔": 347,
  "福萝卜": 348,
  "坚强": 349,
  "贴贴": 350,
  "敲敲": 351,
  "咦": 352,
  "拜托": 353,
  "尊嘟假嘟": 354,
  "耶": 355,
  "666": 356,
  "裂开": 357,
  "骰子": 358,
  "包剪锤": 359,
  "亲亲": 360,
  "狗狗笑哭": 361,
  "好兄弟": 362,
  "狗狗可怜": 363,
  "超级赞": 364,
  "狗狗生气": 365,
  "芒狗": 366,
  "狗狗疑问": 367,
  "奥特笑哭": 368,
  "彩虹": 369,
  "祝贺": 370,
  "冒泡": 371,
  "气呼呼": 372,
  "忙": 373,
  "波波流泪": 374,
  "超级鼓掌": 375,
  "跺脚": 376,
  "嗨": 377,
  "企鹅笑哭": 378,
  "企鹅流泪": 379,
  "真棒": 380,
  "路过": 381,
  "emo": 382,
  "企鹅爱心": 383,
  "晚安": 384,
  "太气了": 385,
  "呜呜呜": 386,
  "太好笑": 387,
  "太头疼": 388,
  "太赞了": 389,
  "太头秃": 390,
  "太沧桑": 391,
  "龙年快乐": 392,
  "新年中龙": 393,
  "新年大龙": 394,
  "略略略": 395,
  "狼狗": 396,
  "抛媚眼": 397,
  "超级ok": 398,
  "tui": 399,
  "快乐": 400,
  "超级转圈": 401,
  "别说话": 402,
  "出去玩": 403,
  "闪亮登场": 404,
  "好运来": 405,
  "姐是女王": 406,
  "我听听": 407,
  "臭美": 408,
  "送你花花": 409,
  "么么哒": 410,
  "一起嗨": 411,
  "开心": 412,
  "摇起来": 413,
  "划龙舟": 415,
  "中龙舟": 416,
  "大龙舟": 417,
  "火车": 419,
  "中火车": 420,
  "大火车": 421,
  "粽于等到你": 422,
  "复兴号": 423,
  "续标识": 424,
  "求放过": 425,
  "玩火": 426,
  "偷感": 427,
  "收到": 428,
  "蛇年快乐": 429,
  "蛇身": 430,
  "蛇尾": 431,
  "灵蛇献瑞": 432,
  "我吗": 458,
  "优雅": 459,
  "硬撑": 460,
  "宕机": 461,
  "无语": 462,
  "新年快乐": 463,
  "马上到": 464,
  "拆红包": 465,
  "羞羞哒": 466,
  "摇花手": 467,
  "失眠": 468,
  "坚毅": 469,
  "马到成功": 470,
  "心动": 472,
  "给你一拳": 474,
  "干饭": 475,
  "不是吧": 476,
  "你懂的": 477,
  "对的对的": 478,
  "不对不对": 479,
  "散味儿": 480,
  "学习": 481,
  "热化了": 482,
  "略": 483,
  "比爱心": 484,
});

/** 默认颜文字池（按情绪分组，提示词里只给示例，实际随机池更大）。 */
export const DEFAULT_KAOMOJI = [
  '(＾▽＾)',
  '(๑•̀ㅂ•́)و✧',
  '(｡･ω･｡)',
  '(=^･ω･^=)',
  '(๑´ω`๑)',
  '(*/ω＼*)',
  '(￣▽￣)',
  '(・ω・)',
  '(；´д｀)ゞ',
  '(´；ω；`)',
  '(╯°□°）╯︵ ┻━┻',
  '┐(´・д・｀)┌',
  '(。•́︿•̀。)',
  '(๑•́ ₃ •̀๑)',
  'ヾ(≧▽≦*)o',
  '(๑>؂<๑)',
  '(￣ε￣)',
  '(๑• . •๑)',
  '(*≧ω≦)',
  '(≧∇≦)ﾉ',
  '(๑¯ω¯๑)',
  '(´･_･`)',
  '(＾ω＾)',
  '(•̀ᴗ•́)و',
];

/** 出站标记：[[sticker:名字]]（单层方括号也认）或 [face:名字/id]。 */
const MARKER_PATTERN = /\[{1,2}\s*(?:sticker|表情包)\s*[:：]\s*([^\]\r\n]{1,40}?)\s*\]{1,2}|\[\s*(?:face|小黄脸)\s*[:：]\s*([^\]\r\n]{1,24}?)\s*\]/gi;

/** 句末标点：用于把长回复切成多条气泡。 */
const SENTENCE_END = /([。！？!?；;…~～\n])/;

/** 判断一段文本里是否已经有颜文字。 */
const KAOMOJI_HINT = /[（(][^（）()\n]{0,12}[ω・▽∀≧≦ㅂ´`＾^*≧∇°□︿][^（）()\n]{0,12}[）)]|[（(]\s*[^）)]{0,3}[╯┐┻]\s*[）)]/;

/**
 * 解析「每行 名字=id」形式的自定义表情映射。
 * @param text - 用户填写的多行文本。
 * @returns 合并默认表后的映射。
 */
export function parseFaceMap(text) {
  const map = { ...DEFAULT_FACE_MAP };
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^(.+?)\s*[=＝:：]\s*(\d{1,3})$/);
    if (match === null) continue;
    map[match[1].trim()] = Number(match[2]);
  }
  return map;
}

/**
 * 反查 face id 的中文名（收消息时把 [CQ:face,id=14] 变成 [微笑]）。
 * @param map - 情绪 → id 的映射。
 * @returns id → 名字的映射。
 */
export function reverseFaceMap(map) {
  const reverse = new Map();
  for (const [name, id] of Object.entries(map)) {
    if (!reverse.has(id)) reverse.set(id, name);
  }
  return reverse;
}

/**
 * 解析「每行 名字=路径或URL」形式的表情包表。
 * @param text - 用户填写的多行文本。
 * @returns 表情名 → 来源。
 */
export function parseStickerMap(text) {
  const map = new Map();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^(.+?)\s*[=＝:：]\s*(.+)$/);
    if (match === null) continue;
    map.set(match[1].trim(), match[2].trim());
  }
  return map;
}

/**
 * 把模型产出的文本解析成待发送的消息段。
 * 未知标记按普通文本保留，避免模型写错就整条消息发不出去。
 * @param text - 模型回复。
 * @param options - face 映射与是否启用对应能力。
 * @returns 消息段数组：{type:'text'|'face'|'sticker', ...}。
 */
export function parseOutbound(text, options) {
  const segments = [];
  const faceMap = options.faceMap;
  const pushText = (value) => {
    if (value === '') return;
    const last = segments.at(-1);
    if (last !== undefined && last.type === 'text') last.text += value;
    else segments.push({ type: 'text', text: value });
  };
  let cursor = 0;
  for (const match of String(text ?? '').matchAll(MARKER_PATTERN)) {
    const start = match.index ?? 0;
    pushText(String(text).slice(cursor, start));
    cursor = start + match[0].length;
    const stickerName = match[1];
    const faceName = match[2];
    if (stickerName !== undefined) {
      const name = stickerName.trim();
      if (options.stickers.has(name) && options.stickerEnabled) {
        segments.push({ type: 'sticker', name });
      } else if (options.stickerPacks !== undefined && options.stickerPacks.has(name) && options.stickerEnabled) {
        // 整包发送：包内随机挑一张。
        segments.push({ type: 'sticker', name });
      } else if (options.faceEnabled && faceMap[name] !== undefined) {
        // 模型偶尔把「小黄脸」的名字写进表情包标记里，能救就救回来。
        segments.push({ type: 'face', id: faceMap[name] });
      }
      // 两边都对不上就当没写：原样发出去只会让 QQ 上出现一串方括号。
      continue;
    }
    if (faceName === undefined) continue;
    const raw = faceName.trim();
    if (!options.faceEnabled) continue;
    let id = /^\d{1,3}$/.test(raw) ? Number(raw) : faceMap[raw];
    if (id === undefined) {
      // 名字大小写不敏感：模型可能写 [face:no] 而表里是 NO。
      const lower = raw.toLowerCase();
      for (const [key, value] of Object.entries(faceMap)) {
        if (key.toLowerCase() === lower) {
          id = value;
          break;
        }
      }
    }
    if (id === undefined) {
      pushText(`[${raw}]`);
      continue;
    }
    segments.push({ type: 'face', id });
  }
  pushText(String(text).slice(cursor));
  return segments.filter((segment) => segment.type !== 'text' || segment.text !== '');
}

/** 去掉 QQ 不渲染的 Markdown 外壳。 */
export function stripMarkdown(text) {
  return String(text ?? '')
    .replace(/```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/(^|\n)[ \t]*#{1,6}[ \t]*/g, '$1')
    .replace(/(^|\n)[ \t]*[-*+][ \t]+/g, '$1')
    .replace(/(^|\n)[ \t]*>[ \t]?/g, '$1')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1')
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '$1 $2')
    .replace(/^---+$/gm, '')
    .trim();
}

/**
 * 清掉「出戏」的机制话术：表情包列表里没有 / 标记写法 / 系统提示 这类。
 * 模型偶尔会把内部规则说给用户听，发到 QQ 上就非常破坏人设。
 * @param text - 待清洗的正文。
 * @returns 干净的正文。
 */
export function stripMetaTalk(text) {
  let result = String(text ?? '');
  const patterns = [
    // 括号里在聊表情包/列表/系统/规则（不含 sticker/face，避免误伤真正的标记）
    /[（(\[【][^）)\]】\n]{0,30}(?:表情包|表情|小黄脸|列表|库存|系统|规则|提示词|模型)[^）)\]】\n]{0,40}[）)\]】]/gi,
    // 整句在说「表情包里没有 / 找不到」
    /[^。！？\n]{0,25}(?:表情包|表情)[^。！？\n]{0,20}(?:没有|没找到|找不到|不存在|不在|没配|缺)[^。！？\n]{0,30}[。！？]?/gi,
    // 「列表/库里没有…」这类不带主语的说法
    /(?:列表|库存|库里)(?:里|中)?(?:没有|找不到|不存在|还没配)[^。！？\n]{0,30}[。！？]?/gi,
    // 「（发送表情包）」这种动作说明
    /[（(]\s*(?:发送|发|补|附)[^）)\n]{0,20}表情[^）)\n]{0,10}[）)]/gi,
    // 「表情包列表里没有这种话」这类用户提到的原句
    /(?:表情包|表情)(?:列表|库|包里)?(?:里|中)?(?:没有|找不到|没有这种)[^。！？\n]{0,20}[。！？]?/gi,
  ];
  for (const pattern of patterns) result = result.replace(pattern, '');
  // 括号被清空后留下的空壳、
  result = result.replace(/[（(\[【]\s*[）)\]】]/g, '');
  // 尾巴上挂着的连接词
  result = result.replace(/[，,、\s]*(?:但是|可是|不过|所以|然后|而且|反正|就)$/g, '');
  return result.trim();
}

/**
 * 把消息段切成多条气泡。
 * 文本优先在句末标点处断开，单句过长时按字数硬切；标记段跟随当前气泡。
 * @param segments - parseOutbound 的结果。
 * @param limit - 单条气泡字数上限。
 * @returns 气泡数组（每个气泡是消息段数组）。
 */
export function splitBubbles(segments, limit) {
  const max = Math.max(20, Number(limit) || 120);
  const bubbles = [];
  let current = [];
  let length = 0;
  const flush = () => {
    if (current.length > 0) bubbles.push(current);
    current = [];
    length = 0;
  };
  const pushText = (value) => {
    if (value === '') return;
    const last = current.at(-1);
    if (last !== undefined && last.type === 'text') last.text += value;
    else current.push({ type: 'text', text: value });
    length += value.length;
  };
  for (const segment of segments) {
    if (segment.type !== 'text') {
      current.push(segment);
      length += 1;
      continue;
    }
    // 空行是硬分段：模型按人设提示「用空行分段」写出来的每一段单独发一条。
    const paragraphs = String(segment.text).split(/\n{2,}/);
    for (let index = 0; index < paragraphs.length; index += 1) {
      if (index > 0) flush();
      const pieces = paragraphs[index].split(SENTENCE_END);
      for (const piece of pieces) {
        if (piece === '') continue;
        if (length + piece.length > max && current.length > 0) flush();
        if (piece.length > max) {
          for (let offset = 0; offset < piece.length; offset += max) {
            if (current.length > 0) flush();
            pushText(piece.slice(offset, offset + max));
            flush();
          }
          continue;
        }
        pushText(piece);
      }
    }
  }
  flush();
  return bubbles;
}

/**
 * 判断文本里是否已含颜文字。
 * @param text - 待检查文本。
 * @returns 是否含颜文字。
 */
export function hasKaomoji(text) {
  return KAOMOJI_HINT.test(String(text ?? ''));
}

/**
 * 从池子里取一个颜文字（空池返回空串）。
 * @param pool - 颜文字池。
 * @returns 一个颜文字。
 */
export function pickKaomoji(pool) {
  if (pool.length === 0) return '';
  return pool[Math.floor(Math.random() * pool.length)];
}

/** 解析颜文字池（每行一个）。 */
export function parseKaomojiPool(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return lines.length > 0 ? lines : [...DEFAULT_KAOMOJI];
}

/**
 * 把 OneBot 消息内容转成模型可读文本。
 * @param message - 消息段数组或 CQ 码字符串。
 * @param options - face 反查表。
 * @returns 单行文本（图片/语音以占位符表示）。
 */
export function messageToText(message, options) {
  const faceNames = options?.faceNames ?? new Map();
  if (typeof message === 'string') return cqToText(message, faceNames);
  if (!Array.isArray(message)) return '';
  const parts = [];
  for (const segment of message) {
    if (segment === null || typeof segment !== 'object') continue;
    const data = segment.data ?? {};
    switch (segment.type) {
      case 'text':
        parts.push(String(data.text ?? ''));
        break;
      case 'face': {
        const name = faceNames.get(Number(data.id));
        parts.push(name === undefined ? '（表情）' : `（${name}表情）`);
        break;
      }
      case 'at':
        parts.push(String(data.qq ?? '') === 'all' ? '@全体成员 ' : '@某人 ');
        break;
      case 'image':
        parts.push('（图片）');
        break;
      case 'record':
        parts.push('（语音）');
        break;
      case 'video':
        parts.push('（视频）');
        break;
      case 'file':
        parts.push('（文件）');
        break;
      case 'mface':
        parts.push('（表情包）');
        break;
      case 'forward':
        parts.push('（合并转发）');
        break;
      case 'reply':
        break;
      case 'json':
      case 'xml':
        break;
      default:
        break;
    }
  }
  return parts.join('').replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * CQ 码字符串 → 文本（部分实现用 string 格式上报）。
 * @param text - CQ 码字符串。
 * @param faceNames - id → 名字。
 * @returns 可读文本。
 */
function cqToText(text, faceNames) {
  return String(text)
    .replace(/\[CQ:face,id=(\d+)[^\]]*\]/g, (_all, id) => {
      const name = faceNames.get(Number(id));
      return name === undefined ? '（表情）' : `（${name}表情）`;
    })
    .replace(/\[CQ:image,[^\]]*\]/g, '（图片）')
    .replace(/\[CQ:record,[^\]]*\]/g, '（语音）')
    .replace(/\[CQ:video,[^\]]*\]/g, '（视频）')
    .replace(/\[CQ:at,qq=(\w+)[^\]]*\]/g, (_all, qq) => (qq === 'all' ? '@全体成员 ' : '@某人 '))
    .replace(/\[CQ:[^\]]*\]/g, '')
    .trim();
}

/**
 * 从消息段里取出 @ 到机器人的信息（群聊里判断是否被点名）。
 * @param message - 消息段数组。
 * @param selfId - 机器人 QQ 号。
 * @returns 是否 @ 了机器人。
 */
export function mentionsSelf(message, selfId) {
  if (selfId === '') return false;
  if (typeof message === 'string') return message.includes(`[CQ:at,qq=${selfId}]`);
  if (!Array.isArray(message)) return false;
  return message.some((segment) => segment?.type === 'at' && String(segment.data?.qq ?? '') === selfId);
}

/**
 * 去掉消息段里 @机器人 的部分，避免模型看到「@某人」。
 * @param message - 消息段数组。
 * @param selfId - 机器人 QQ 号。
 * @returns 过滤后的消息段数组。
 */
export function stripSelfMention(message, selfId) {
  if (!Array.isArray(message)) return message;
  return message.filter((segment) => !(segment?.type === 'at' && String(segment.data?.qq ?? '') === selfId));
}
