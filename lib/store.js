/**
 * 本机持久化：数据目录、人设文件、会话映射、表情包目录索引。
 *
 * 所有状态都放在 ~/.dsh/qq-bridge（或配置的 dataDir）下，不碰 profile：
 *   persona.md      当前人设正文（优先于设置页里的 personaPrompt）
 *   state.json      QQ 会话 → DSH 会话 的映射与最近活跃时间
 *   workspace/      每个 QQ 会话 Agent 的工作目录
 *
 * @module dsh-qq/store
 */
import os from 'node:os';
import path from 'node:path';
import { mkdir, readFile, readdir, stat, writeFile, rename } from 'node:fs/promises';

/** 表情包支持的图片扩展名。 */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

/**
 * 解析数据目录。
 * @param config - 插件配置。
 * @returns 绝对路径。
 */
export function dataDirOf(config) {
  const configured = String(config.dataDir ?? '').trim();
  if (configured !== '') return path.resolve(configured);
  return path.join(os.homedir(), '.dsh', 'qq-bridge');
}

/**
 * 解析 QQ 会话的工作目录（默认在数据目录下）。
 * @param config - 插件配置。
 * @returns 绝对路径。
 */
export function workspaceDirOf(config) {
  const configured = String(config.workspaceDir ?? '').trim();
  if (configured !== '') return path.resolve(configured);
  return path.join(dataDirOf(config), 'workspace');
}

/** 确保目录存在。 */
export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
  return dir;
}

/** 读 JSON，失败返回 fallback。 */
export async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 原子写 JSON。 */
export async function writeJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, file);
}

/** 读取人设文件（不存在返回 undefined）。 */
export async function readPersona(dir) {
  try {
    const text = await readFile(path.join(dir, 'persona.md'), 'utf8');
    return text.trim() === '' ? undefined : text.trim();
  } catch {
    return undefined;
  }
}

/** 写入人设文件；空内容等于删除。 */
export async function writePersona(dir, text) {
  const file = path.join(dir, 'persona.md');
  await mkdir(dir, { recursive: true });
  const trimmed = String(text ?? '').trim();
  if (trimmed === '') {
    await writeFile(file, '', 'utf8');
    return;
  }
  await writeFile(file, `${trimmed}\n`, 'utf8');
}

/**
 * 扫描表情包目录：文件名（去扩展名）即表情名。
 * @param dir - 表情包目录。
 * @returns 表情名 → 绝对路径。
 */
export async function scanStickerDir(dir) {
  const map = new Map();
  if (dir === '') return map;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return map;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const extension = path.extname(entry.name).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(extension)) continue;
    const info = await stat(path.join(dir, entry.name)).catch(() => undefined);
    if (info === undefined || info.size === 0 || info.size > 5 * 1024 * 1024) continue;
    map.set(path.basename(entry.name, extension), path.join(dir, entry.name));
  }
  return map;
}

/**
 * 递归扫描表情包目录：
 *   - 根目录下的图片 → 具名表情（文件名 = 表情名）
 *   - 子目录 → 一个「风格包」（目录名 = 包名），包内图片随机取一张
 * @param dir - 表情包根目录。
 * @returns {files: Map<string,string>, packs: Map<string,string[]>}
 */
export async function scanStickerTree(dir) {
  const files = new Map();
  const packs = new Map();
  if (dir === '') return { files, packs };

  /** 收集一个目录（可递归）下的图片路径。 */
  const collect = async (current, depth) => {
    const found = [];
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return found;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (depth < 2) found.push(...(await collect(full, depth + 1)));
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = path.extname(entry.name).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(extension)) continue;
      const info = await stat(full).catch(() => undefined);
      if (info === undefined || info.size === 0 || info.size > 5 * 1024 * 1024) continue;
      found.push(full);
    }
    return found;
  };

  let rootEntries;
  try {
    rootEntries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { files, packs };
  }
  for (const entry of rootEntries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const images = await collect(full, 0);
      if (images.length > 0) packs.set(entry.name, images);
      continue;
    }
    if (!entry.isFile()) continue;
    const extension = path.extname(entry.name).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(extension)) continue;
    const info = await stat(full).catch(() => undefined);
    if (info === undefined || info.size === 0 || info.size > 5 * 1024 * 1024) continue;
    files.set(path.basename(entry.name, extension), full);
  }
  return { files, packs };
}

/**
 * 长期记忆文件路径：一个 QQ 会话一个文件，放在 memory/ 下。
 * @param dir - 数据目录。
 * @param key - 会话键（private:xxx / group:xxx:user）。
 * @returns 绝对路径。
 */
export function memoryFileOf(dir, key) {
  const safe = String(key ?? '').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80) || 'default';
  return path.join(dir, 'memory', `${safe}.md`);
}

/**
 * 读长期记忆（Markdown 列表行）。
 * @param file - 记忆文件路径。
 * @returns 记忆条目数组（不含 "- " 前缀）。
 */
export async function readMemory(file) {
  try {
    const text = await readFile(file, 'utf8');
    return text
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*[-*]\s*/, '').trim())
      .filter((line) => line !== '' && !line.startsWith('#'));
  } catch {
    return [];
  }
}

/**
 * 写长期记忆。
 * @param file - 记忆文件路径。
 * @param items - 条目数组。
 */
export async function writeMemory(file, items) {
  await ensureDir(path.dirname(file));
  const body = ['# 长期记忆', '', ...items.map((item) => `- ${item}`), ''].join('\n');
  await writeFile(file, body, 'utf8');
}

/**
 * 把一条表情包来源解析成可直接发送的 OneBot image 段。
 * URL 直接交给实现端下载；本地文件转 base64，避免路径权限问题。
 * @param source - 本地路径或 http(s) 地址。
 * @returns image 消息段，或 undefined（读不到）。
 */
export async function stickerSegment(source) {
  const value = String(source ?? '').trim();
  if (value === '') return undefined;
  if (/^https?:\/\//i.test(value)) {
    return { type: 'image', data: { file: value, sub_type: 1, summary: '[表情包]' } };
  }
  const file = path.resolve(value);
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size === 0) return undefined;
    if (info.size > 5 * 1024 * 1024) return undefined;
    const buffer = await readFile(file);
    return { type: 'image', data: { file: `base64://${buffer.toString('base64')}`, sub_type: 1, summary: '[表情包]' } };
  } catch {
    return undefined;
  }
}
