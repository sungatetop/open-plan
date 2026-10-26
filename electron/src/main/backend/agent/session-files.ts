/**
 * 会话文件存储域（S3-1，自 server/index.mjs 内联会话助手逐行转录）。
 *
 * 覆盖面（行号锚点均指 server/index.mjs）：
 *   - 常量与指纹缓存体系（L1994-2044）：SESSIONS_DIR / 文本·头部·元数据三级
 *     mtime+size 指纹缓存 / sessionIdIndex / 元数据磁盘持久化（.oaw/sessions-meta.json，
 *     服务重启免冷扫描）；
 *   - 存储助手（L2739-3034）：sessionBaseName / listSessionFiles（同 id 去重、新目录
 *     优先）/ readSessionTextCached / readFileHead（只读前 N 字节）/ readSessionHeaderCached /
 *     sessionMetaFor（元数据提取 + 磁盘缓存回填）/ buildSessionMeta / findSessionFile /
 *     materializeWritableSession / readSessionHeader / updateSessionHeader / parseJsonl /
 *     annotateSessionThread；
 *   - 标题助手（L3547-3602）：cleanSessionTitle（前端注入前缀清洗 + 句子边界截断）/
 *     isSystemHintMessage / messageText / isBootstrapSessionTitle；
 *   - Chat 视图折叠（L3714-3745）：compactSessionEntryForChat。
 *
 * 与旧实现的差异（可测性扩展，B2-2 runs 先例）：SESSIONS_DIR / SESSION_META_STORE
 * 支持 env 覆盖（OAW_SESSIONS_DIR / OAW_SESSIONS_META_STORE），缺省锚点与旧实现一致
 * （PROJECT_DIR/.规聚会话、PROJECT_DIR/.oaw/sessions-meta.json）。函数体逐行转录，
 * 无行为差异。路由编排消费面见 ipc/agent-sessions-direct.ts（S3-1）。
 *
 * 本模块不 import electron（纯逻辑，vitest 可直接测）。
 */
import fs from "node:fs";
import path from "node:path";
import { PROJECT_DIR } from "../workspace";
import { atomicWriteFile, atomicWriteJson } from "../persistence-utils";

// 会话文件是跨版本持久化的动态结构，历史文件里字段可有可无，保持动态面。
type SessionRecord = Record<string, any>;
type SessionFileEntry = { fileName: string; fullPath: string; storeDir: string; mtime: number; size: number; sessionId?: string };
type Fingerprinted<T> = { fingerprint: string; value: T };
// meta 缓存值形状（server L2874-2880/L2935-2953）：字段名 meta 是磁盘持久化契约
// （.oaw/sessions-meta.json entries 值 = {fingerprint, meta}，与 sidecar 跨进程共享），不可改名。
type CachedMeta = { fingerprint: string; meta: SessionRecord };

// ---------- sessions（server L1994-2044）----------
// 新会话和显式导入的旧会话都只存放在项目目录；常态运行不扫描本地 Pi 会话。
export const SESSIONS_DIR = process.env.OAW_SESSIONS_DIR || path.join(PROJECT_DIR, ".规聚会话");
const SESSION_READ_DIRS = [SESSIONS_DIR];
fs.mkdirSync(SESSIONS_DIR, { recursive: true });
const SESSION_TEXT_CACHE_LIMIT = 400;
const sessionTextCache = new Map<string, Fingerprinted<string>>();
const sessionIdIndex = new Map<string, SessionFileEntry>();
// 会话头部（首行 64KB）与元数据（标题/归属/标记）的指纹缓存：
// 会话列表热调用只需要 stat 比对指纹，不再全量读取 200+ 个 JSONL。
// 元数据同时持久化到磁盘（.oaw/sessions-meta.json），服务重启后无需冷扫描。
const SESSION_HEADER_BYTES = 65536;
const SESSION_HEAD_SCAN_BYTES = 512 * 1024;
const SESSION_CACHE_LIMIT = 800;
export const SESSION_META_STORE =
  process.env.OAW_SESSIONS_META_STORE || path.join(PROJECT_DIR, ".oaw", "sessions-meta.json");
const sessionHeaderCache = new Map<string, Fingerprinted<SessionRecord | null>>();
const sessionMetaCache = new Map<string, CachedMeta>();
const persistedSessionMeta = new Map<string, CachedMeta>();
let sessionMetaStoreLoaded = false;
let sessionMetaDirty = false;
let sessionMetaFlushTimer: NodeJS.Timeout | null = null;

function loadPersistedSessionMeta(): void {
  if (sessionMetaStoreLoaded) return;
  sessionMetaStoreLoaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(SESSION_META_STORE, "utf8"));
    for (const [key, value] of Object.entries(raw?.entries || {}) as Array<[string, CachedMeta]>) {
      if (value?.fingerprint && value?.meta) persistedSessionMeta.set(key, value);
    }
  } catch {}
}

function scheduleSessionMetaFlush(): void {
  sessionMetaDirty = true;
  if (sessionMetaFlushTimer) return;
  sessionMetaFlushTimer = setTimeout(() => {
    sessionMetaFlushTimer = null;
    if (!sessionMetaDirty) return;
    sessionMetaDirty = false;
    try {
      const alive = new Set(listSessionFiles().map((file) => file.fullPath));
      const entries: Record<string, unknown> = {};
      for (const [key, value] of sessionMetaCache.entries()) {
        if (alive.has(key)) entries[key] = { fingerprint: value.fingerprint, meta: value.meta };
      }
      fs.mkdirSync(path.dirname(SESSION_META_STORE), { recursive: true });
      atomicWriteJson(SESSION_META_STORE, { version: 1, savedAt: new Date().toISOString(), entries });
    } catch {}
  }, 1500);
}

export function sessionBaseName(fileName: unknown): string {
  return String(fileName || "").replace(/\.(?:jsonl|json)$/i, "");
}

// 递归扫描规聚项目会话目录；旧 Pi 会话只有显式导入后才会进入这里。
export function listSessionFiles(): SessionFileEntry[] {
  const candidates: SessionFileEntry[] = [];
  function walk(dir: string, depth: number, storeDir: string): void {
    if (depth > 4) return;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1, storeDir);
      } else if (e.isFile() && /\.jsonl$/i.test(e.name)) {
        try {
          const st = fs.statSync(full);
          candidates.push({ fileName: e.name, fullPath: full, storeDir, mtime: st.mtimeMs, size: st.size });
        } catch {}
      }
    }
  }
  for (const dir of SESSION_READ_DIRS) walk(dir, 0, dir);
  // 同一个会话迁移后可能同时存在于新旧目录；按 session id 去重，
  // 但保留旧目录中不同子目录下同名的独立会话。
  sessionIdIndex.clear();
  const preferred = candidates.sort((a, b) => {
    const aCurrent = a.storeDir === SESSIONS_DIR ? 1 : 0;
    const bCurrent = b.storeDir === SESSIONS_DIR ? 1 : 0;
    return bCurrent - aCurrent || b.mtime - a.mtime;
  });
  const seenIds = new Set<string>();
  const out: SessionFileEntry[] = [];
  for (const f of preferred) {
    let identity = `file:${f.fullPath}`;
    try {
      const h = readSessionHeaderCached(f);
      const sessionId = h?.id || h?.sessionId;
      if (sessionId) {
        identity = `id:${sessionId}`;
        f.sessionId = sessionId;
        if (!sessionIdIndex.has(sessionId)) sessionIdIndex.set(sessionId, f);
      }
    } catch {}
    if (seenIds.has(identity)) continue;
    seenIds.add(identity);
    out.push(f);
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

export function readSessionTextCached(foundOrPath: SessionFileEntry | string): string {
  const fullPath = typeof foundOrPath === "string" ? foundOrPath : foundOrPath?.fullPath;
  if (!fullPath) return "";
  let stat: fs.Stats;
  try {
    stat = fs.statSync(fullPath);
  } catch {
    sessionTextCache.delete(fullPath);
    return "";
  }
  const fingerprint = `${stat.mtimeMs}:${stat.size}`;
  const cached = sessionTextCache.get(fullPath);
  if (cached?.fingerprint === fingerprint) return cached.value;
  const text = fs.readFileSync(fullPath, "utf8");
  sessionTextCache.set(fullPath, { fingerprint, value: text });
  while (sessionTextCache.size > SESSION_TEXT_CACHE_LIMIT) {
    const oldest = sessionTextCache.keys().next().value;
    if (oldest === undefined) break;
    sessionTextCache.delete(oldest);
  }
  return text;
}

// 只读文件开头的前 N 字节（会话头部很小，无需为拿 header 全量读文件）
function readFileHead(fullPath: string, stat: fs.Stats, maxBytes: number): string {
  const size = Math.min(maxBytes, stat.size);
  if (size <= 0) return "";
  const buffer = Buffer.alloc(size);
  let fd: number | null = null;
  try {
    fd = fs.openSync(fullPath, "r");
    const read = fs.readSync(fd, buffer, 0, size, 0);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

export function readSessionHeaderCached(foundOrPath: SessionFileEntry | string): SessionRecord | null {
  const fullPath = typeof foundOrPath === "string" ? foundOrPath : foundOrPath?.fullPath;
  if (!fullPath) return null;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(fullPath);
  } catch {
    sessionHeaderCache.delete(fullPath);
    return null;
  }
  const fingerprint = `${stat.mtimeMs}:${stat.size}`;
  const cached = sessionHeaderCache.get(fullPath);
  if (cached?.fingerprint === fingerprint) return cached.value;
  let header: SessionRecord | null = null;
  try {
    const head = readFileHead(fullPath, stat, SESSION_HEADER_BYTES);
    const firstLine = head.indexOf("\n") >= 0 ? head.slice(0, head.indexOf("\n")) : head;
    header = JSON.parse(firstLine) || null;
  } catch {}
  sessionHeaderCache.set(fullPath, { fingerprint, value: header });
  while (sessionHeaderCache.size > SESSION_CACHE_LIMIT) {
    const oldest = sessionHeaderCache.keys().next().value;
    if (oldest === undefined) break;
    sessionHeaderCache.delete(oldest);
  }
  return header;
}

/**
 * 会话元数据（归属、标题、标记）：按 mtime+size 指纹缓存。
 * 只有文件变化时才重新扫描；标题扫描最多读取前 2MB，避免大文件全量解析。
 */
export function sessionMetaFor(f: SessionFileEntry): SessionRecord | null {
  loadPersistedSessionMeta();
  let stat: fs.Stats;
  try {
    stat = fs.statSync(f.fullPath);
  } catch {
    sessionMetaCache.delete(f.fullPath);
    return null;
  }
  const fingerprint = `${stat.mtimeMs}:${stat.size}`;
  const cached = sessionMetaCache.get(f.fullPath);
  if (cached?.fingerprint === fingerprint) return cached.meta;
  // 服务重启后优先使用磁盘缓存：指纹一致则完全跳过文件解析
  const persisted = persistedSessionMeta.get(f.fullPath);
  if (persisted?.fingerprint === fingerprint) {
    sessionMetaCache.set(f.fullPath, persisted);
    return persisted.meta;
  }
  const header = readSessionHeaderCached(f) || {};
  const needsDeepScan = stat.size > SESSION_HEAD_SCAN_BYTES;
  let meta: SessionRecord | null = null;
  try {
    const headText = readFileHead(f.fullPath, stat, Math.min(stat.size, SESSION_HEAD_SCAN_BYTES));
    meta = buildSessionMeta(f, header, headText, { truncated: needsDeepScan });
    // 标题区通常在文件前部；只有截断扫描未发现用户消息的大文件才回退全文读取
    if (needsDeepScan && !meta.foundUserMessage) {
      meta = buildSessionMeta(f, header, readSessionTextCached(f), { truncated: false });
    }
  } catch {
    meta = meta || buildSessionMeta(f, header, "", { truncated: false });
  }
  sessionMetaCache.set(f.fullPath, { fingerprint, meta });
  while (sessionMetaCache.size > SESSION_CACHE_LIMIT) {
    const oldest = sessionMetaCache.keys().next().value;
    if (oldest === undefined) break;
    sessionMetaCache.delete(oldest);
  }
  scheduleSessionMetaFlush();
  return meta;
}

export function buildSessionMeta(f: SessionFileEntry, h: SessionRecord, text: string, { truncated = false } = {}): SessionRecord {
  const cwd = h.cwd || "";
  const isProjectSession = path.resolve(f.storeDir) === path.resolve(SESSIONS_DIR);
  const cwdLower = cwd.toLowerCase();
  const isOpenPlan = isProjectSession || cwdLower.includes("open plan") || cwdLower.includes("open-plan") || cwd.includes(PROJECT_DIR) || cwd === path.dirname(PROJECT_DIR);
  let title = "";
  let hasUserMessage = false;
  if (isOpenPlan && text) {
    let from = text.indexOf("\n");
    from = from >= 0 ? from + 1 : text.length;
    while (from < text.length) {
      let to = text.indexOf("\n", from);
      if (to === -1) to = text.length;
      const line = text.slice(from, to);
      from = to + 1;
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === "message" && entry.message?.role === "user") {
          const raw = messageText(entry);
          if (isSystemHintMessage(raw)) continue;
          hasUserMessage = true;
          const cleaned = cleanSessionTitle(raw);
          if (cleaned) { title = cleaned; break; }
        }
      } catch {}
    }
  }
  const foundUserMessage = hasUserMessage;
  // 截断扫描窗口内未找到时不轻易判定“没有用户消息”，避免长会话被隐藏
  if (truncated && !hasUserMessage) hasUserMessage = true;
  return {
    id: h.id || h.sessionId || sessionBaseName(f.fileName),
    threadId: h.threadId || null,
    cwd,
    isOaw: isOpenPlan,
    isProjectSession,
    label: h.label ? String(h.label).trim() : "",
    pinned: Boolean(h.pinned),
    frozen: Boolean(h.frozen),
    freezeReason: h.freezeReason || "",
    contextSnapshot: h.contextSnapshot || null,
    parentSessionId: h.parentSessionId || null,
    branchSourceMessageId: h.branchSourceMessageId || null,
    branchPurpose: h.branchPurpose || "",
    created: h.created || "",
    title,
    hasUserMessage,
    foundUserMessage,
  };
}

// 根据 id 查找对应的会话文件（先按文件名匹配，再按首行 session id 匹配）
export function findSessionFile(id: unknown): SessionFileEntry | null {
  const files = listSessionFiles();
  const byName = files.find((f) => f.fileName === id + ".jsonl" || f.fileName === id + ".json" || f.fileName.startsWith(id as string));
  if (byName) return byName;
  const indexed = sessionIdIndex.get(String(id));
  if (indexed && files.some((f) => f.fullPath === indexed.fullPath)) return indexed;
  for (const f of files) {
    try {
      const text = readSessionTextCached(f);
      const firstLine = text.split(/\r?\n/)[0]!;
      if (!firstLine) continue;
      const h = JSON.parse(firstLine);
      if (h && (h.id === id || h.sessionId === id)) return f;
    } catch {}
  }
  return null;
}

function materializeWritableSession(found: SessionFileEntry): SessionFileEntry {
  if (!found || found.storeDir === SESSIONS_DIR) return found;
  const target = path.join(SESSIONS_DIR, found.fileName);
  try {
    fs.copyFileSync(found.fullPath, target);
    return { ...found, fullPath: target, storeDir: SESSIONS_DIR };
  } catch (e: any) {
    throw new Error(`无法将旧 Pi 会话迁移到项目内可写目录：${e.message}`);
  }
}

export function readSessionHeader(found: SessionFileEntry | null): SessionRecord {
  if (!found?.fullPath) return {};
  try {
    const firstLine = readSessionTextCached(found).split(/\r?\n/)[0]!;
    return firstLine ? JSON.parse(firstLine) : {};
  } catch {
    return {};
  }
}

export function updateSessionHeader(id: unknown, patch: SessionRecord = {}): SessionRecord {
  const found = findSessionFile(id);
  if (!found) return { ok: false, status: 404, error: "not found" };
  try {
    const writable = materializeWritableSession(found);
    const lines = fs.readFileSync(writable.fullPath, "utf8").split(/\r?\n/);
    if (!lines[0]) return { ok: false, status: 400, error: "empty file" };
    const header = JSON.parse(lines[0]!);
    const next = { ...header, ...patch, updatedAt: new Date().toISOString() };
    lines[0] = JSON.stringify(next);
    atomicWriteFile(writable.fullPath, lines.join("\n"), "utf8");
    sessionTextCache.delete(writable.fullPath);
    return { ok: true, header: next };
  } catch (error: any) {
    return { ok: false, status: 500, error: error.message };
  }
}

// 解析 JSONL 文件所有行（每行一个 JSON 对象，跳过空行和解析失败的行）
export function parseJsonl(text: string): SessionRecord[] {
  const out: SessionRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {}
  }
  return out;
}

export function annotateSessionThread(sessionId: unknown, threadId: unknown): void {
  if (!sessionId || !threadId) return;
  const found = findSessionFile(sessionId);
  if (!found) return;
  const header = readSessionHeader(found);
  if (header.threadId === threadId) return;
  updateSessionHeader(sessionId, { threadId });
}

/**
 * 清空会话文本缓存与 ID 索引（可测性扩展，B2-2 先例口径）。
 * 等价旧 server/index.mjs L2366-2367：import-config 导入会话后失效模块级缓存，
 * 使后续 listSessionFiles/findSessionFile 重新扫描磁盘。
 */
export function clearSessionCaches(): void {
  sessionTextCache.clear();
  sessionIdIndex.clear();
}

// ---------- 标题助手（server L3547-3602）----------
// 清洗会话标题：去掉前端注入的前缀标记（[当前打开文件]/[模式]/[已上传附件]），按句子智能截断
export function cleanSessionTitle(raw: unknown): string {
  let t = String(raw || "").trim();
  // 兼容旧版本把任务目标直接写成“## 当前任务目标：...”的会话首条消息。
  // 这类标题是内部封装，不应污染项目列表和会话历史。
  const inlineTaskGoal = t.match(/^#{1,6}\s*当前任务目标\s*[:：]\s*([^\n]+)/i);
  if (inlineTaskGoal?.[1]) t = inlineTaskGoal[1].trim();
  // 新版 agent 会把用户原始指令包在 TaskEnvelope 中；优先取“目标”字段，
  // 否则整段动态上下文会被误判为系统提示，历史列表就只剩“空会话”。
  const envelopeGoal = t.match(/^\s*#{1,6}\s*当前任务(?:\s+|\n)+(?:目标|任务目标)\s*[:：]\s*([\s\S]*?)(?=(?:\s+|\n)-?\s*(?:模式|引用数|输出要求|本轮结构化引用|动态上下文)\s*[:：]|$)/i);
  if (envelopeGoal?.[1]) t = envelopeGoal[1].trim();
  const goal = t.match(/(?:^|\n)\s*-?\s*(?:目标|任务目标)\s*[:：]\s*([\s\S]*?)(?=\n\s*-?\s*(?:模式|引用数|输出要求|本轮结构化引用|动态上下文)\s*[:：]|$)/i);
  if (goal?.[1]) t = goal[1].trim();
  t = t.replace(/^##\s*任务封装\s*/i, "").trim();
  t = t.replace(/^#{1,6}\s*当前任务目标\s*[:：]?\s*/i, "").trim();
  // 动态上下文可能包含整份 AGENTS.md；只保留模式标记之后的用户指令。
  t = t.replace(/^\[动态上下文\][\s\S]*?\[模式:\s*[^\]]*\]\s*/i, "");
  t = t.replace(/^\[当前打开文件:[^\]]*\]\s*/g, "");
  t = t.replace(/^\[当前工作文件:[^\]]*\]\s*/g, "");
  t = t.replace(/^\[模式:\s*[^\]]*\]\s*/g, "");
  t = t.replace(/^\[已上传附件:[^\]]*\]\s*/g, "");
  t = t.replace(/\n\s*##\s*本轮结构化引用[\s\S]*$/i, "");
  t = t.replace(/\n\s*\[动态上下文\][\s\S]*$/i, "");
  t = t.replace(/@(?:知识库|模板|文件)\[[^\]]*\]/g, " ");
  t = t.replace(/@[^\s@，。！？]+\.(?:docx|xlsx|pptx|pdf|md|txt|html?)\b/gi, " ");
  t = t.replace(/你可以调用所有 skills 和工具生成新文件（文档\/HTML\/PPT等），产物保存到当前工作区。?/g, " ");
  t = t.replace(/优先用 officecli 工具对当前文档做精准文本\/样式修改，不要创建新文件。?/g, " ");
  t = t.replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").replace(/^[,，:：;；、\s]+/, "").trim();
  if (t.length <= 50) return t;
  // 按句子边界截断
  const m = t.match(/^.{0,48}[。！？.!?]/);
  if (m) return m[0]!;
  return t.slice(0, 50) + "…";
}

// 判断消息是否为前端注入的系统提示（模式说明/上下文标记），此类消息不适合做会话标题
const SYSTEM_HINTS = ["[动态上下文]", "[当前工作文件:", "[当前打开文件:", "[模式:", "[当前文档:", "优先用 officecli 工具对当前文档做精准文本"];
export function isSystemHintMessage(raw: unknown): boolean {
  const t = String(raw || "").trim();
  if (!t) return true;
  // 只要消息中还包含实际任务，就不能因为它同时带有上下文前缀而跳过。
  const cleaned = cleanSessionTitle(t);
  if (!cleaned) return true;
  const startsHint = SYSTEM_HINTS.some((h) => t.startsWith(h));
  return startsHint && /^(?:优先用 officecli|你可以调用所有 skills|当前工作区|Office 文档一律)/i.test(cleaned);
}

export function messageText(entry: SessionRecord | null | undefined): string {
  const c = entry?.message?.content;
  if (typeof c === "string") return c.trim();
  if (!Array.isArray(c)) return "";
  return c.filter((b: any) => b?.type === "text" || b?.type === "input_text").map((b: any) => b.text || b.content || "").join("\n").trim();
}

export function isBootstrapSessionTitle(title: unknown): boolean {
  return /^"?[a-z]:\\.*\\\.venv\\Scripts\\activate(?:\.bat)?"?$/i.test(String(title || "").trim());
}

// ---------- Chat 视图折叠（server L3714-3745）----------
export function compactSessionEntryForChat(entry: SessionRecord): SessionRecord {
  if (!entry || entry.type !== "message" || !entry.message) return entry;
  const message = { ...entry.message };
  const compactText = (value: unknown, limit = 12000): string => {
    const text = String(value ?? "");
    return text.length > limit ? `${text.slice(0, limit)}\n…[历史输出已折叠]` : text;
  };
  if (Array.isArray(message.content)) {
    message.content = message.content.map((block: any) => {
      if (!block || typeof block !== "object") return block;
      if (block.type === "image" || block.type === "input_image") {
        return { type: "text", text: "[历史图片已省略，可重新打开原会话查看]" };
      }
      if (block.type === "text" || block.type === "input_text") {
        return { ...block, text: compactText(block.text || block.content || "") };
      }
      if (block.type === "toolCall" || block.type === "tool_call") {
        const input = typeof block.input === "string" ? compactText(block.input) : block.input;
        return input === block.input ? block : { ...block, input };
      }
      return block;
    });
  } else if (typeof message.content === "string") {
    message.content = compactText(message.content);
  }
  if (message.role === "toolResult" || message.role === "tool_result") {
    message.content = Array.isArray(message.content)
      ? message.content.filter((block: any) => block?.type === "text").map((block: any) => ({ ...block, text: compactText(block.text || block.content || "") }))
      : compactText(message.content || message.output || "");
  }
  return { ...entry, message };
}
