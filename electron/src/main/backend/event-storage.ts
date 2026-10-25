/**
 * 根级事件流存储（B1-1 备料批，自 server/event-storage.mjs 354 行逐行转录）。
 *
 * 职责：根级事件流（.oaw/events/事件流.jsonl）的落盘、内存窗口（最近 20000 条）、
 * 归档切片（MAX_ACTIVE_BYTES）、跨进程文件锁、增量读取（activeFileOffset 偏移量，
 * 避免每条事件追加整读大文件——首字延迟优化）、阅读游标、以及 Qoder P1-2（事件
 * 负载 schema 校验告警计数）与 P2-5（按类型投递/落盘量统计）两个进程内诊断面。
 *
 * PERSISTED_TYPES 来自 shared/protocol/event-registry（115 事件注册表单一事实源，
 * BRD-009；旧侧引 server/event-registry.mjs 的同名导出，同一数据不同副本）。
 * PROJECT_DIR 经 ../workspace 锚定（bundle 态 out/main 上跳三级，与 session-store
 * 先例一致），OAW_EVENT_DIR 可覆盖落点。
 *
 * 模块级状态（emitter/nextSeq/events/activeFileOffset/两个诊断 Map）与旧一致；
 * 模块未接入运行时（runs 域 TS 化批次经装配接线），旧 JS 实现保留至域收编后退役。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { RUNTIME_FLAGS } from "../../shared/runtime/feature-flags";
import { appendJsonLine, atomicWriteJson, ensureDirectory, readJsonFile } from "./persistence-utils";
import { PERSISTED_TYPES as PERSISTED_REGISTRY, validateEventPayload } from "../../shared/protocol/event-registry";
import { PROJECT_DIR } from "./workspace";

const EVENT_DIR = path.resolve(process.env.OAW_EVENT_DIR || path.join(PROJECT_DIR, ".oaw", "events"));
const EVENT_FILE = path.join(EVENT_DIR, "事件流.jsonl");
const READ_CURSOR_FILE = path.join(EVENT_DIR, "阅读游标.json");
const EVENT_LOCK_FILE = path.join(EVENT_DIR, "事件流写入.lock");
const MAX_MEMORY_EVENTS = 20000;
const MAX_DATA_STRING = 8000;
const EVENT_LOCK_TIMEOUT_MS = 3000;
// 事件流归档：活动文件超过该体量就切片到 事件流-<时间戳>.jsonl，并写 事件流索引.json。
// 避免单个 jsonl 无限增长（读取路径是把活动文件整读进内存）。
const MAX_ACTIVE_BYTES = Math.max(256 * 1024, Number(process.env.OAW_EVENT_ROTATE_BYTES || 8 * 1024 * 1024) || 8 * 1024 * 1024);
const EVENT_INDEX_FILE = path.join(EVENT_DIR, "事件流索引.json");
const ARCHIVE_KEEP_ENTRIES = 400;

// token/thinking/tool_output 属于高频流式事件，仍由当前会话 SSE 实时发送，
// 但不写入根级 Store，避免长任务把持久日志膨胀成不可用的副作用。
// 具体清单来自 event-registry（唯一事实来源，新增事件必须登记）。
// 旧侧为 string 集合语义，has() 入参任意字符串，故放宽类型面。
const PERSISTED_TYPES = PERSISTED_REGISTRY as ReadonlySet<string>;

const emitter = new EventEmitter();
emitter.setMaxListeners(0);
let loaded = false;
let nextSeq = 0;
let events: any[] = [];
// 活动事件文件的已读字节偏移（增量读取用；归档/替换时回退为整读）
let activeFileOffset = 0;

function ensureStore() {
  ensureDirectory(EVENT_DIR);
}

function safeJson(value: unknown) {
  try {
    return JSON.parse(JSON.stringify(value ?? {}, (_key, item) => {
      if (typeof item === "string" && item.length > MAX_DATA_STRING) return `${item.slice(0, MAX_DATA_STRING)}…[截断]`;
      return item;
    }));
  } catch {
    return { text: String(value ?? "") };
  }
}

function loadStore(force = false) {
  if (loaded && !force) return;
  loaded = true;
  ensureStore();
  nextSeq = 0;
  // 活动文件 +（按需）最新归档：保证内存窗口里始终保留最近的 MAX_MEMORY_EVENTS 条
  const collected = readEventFile(EVENT_FILE);
  const index = readEventIndex();
  for (const entry of [...index.files].reverse()) {
    if (collected.length >= MAX_MEMORY_EVENTS) break;
    const file = path.join(EVENT_DIR, String(entry?.file || ""));
    if (!fs.existsSync(file)) continue;
    collected.unshift(...readEventFile(file));
  }
  events = collected.slice(-MAX_MEMORY_EVENTS);
  for (const item of collected) nextSeq = Math.max(nextSeq, Number(item.seq) || 0);
  activeFileOffset = fileSizeOf(EVENT_FILE);
}

function fileSizeOf(file: string): number {
  try { return fs.statSync(file).size; } catch { return 0; }
}

/**
 * 只读取活动文件在 offset 之后新增的部分。
 *
 * 早先每次 appendEvent 都 `loadStore(true)` 整读活动文件：事件流涨到几 MB 后，
 * 每条事件追加都要读+解析整个文件，一轮对话开头几次追加就叠加出秒级延迟
 * （首字延迟实测里"准入/派发"两段的大头）。这里改为按字节偏移增量读取：
 * 文件被归档/替换（体积回退）时才退回整读。
 */
function syncAppendedEvents() {
  const size = fileSizeOf(EVENT_FILE);
  if (size < activeFileOffset) { loadStore(true); return; }
  if (size === activeFileOffset) return;
  let chunk = "";
  try {
    const fd = fs.openSync(EVENT_FILE, "r");
    try {
      const length = size - activeFileOffset;
      const buffer = Buffer.allocUnsafe(length);
      fs.readSync(fd, buffer, 0, length, activeFileOffset);
      chunk = buffer.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    loadStore(true);
    return;
  }
  activeFileOffset = size;
  // 最后一行可能正在写入：只消费完整行，剩余部分下次再读。
  const lastBreak = chunk.lastIndexOf("\n");
  if (lastBreak < 0) { activeFileOffset = size - Buffer.byteLength(chunk, "utf8"); return; }
  const complete = chunk.slice(0, lastBreak);
  activeFileOffset = size - Buffer.byteLength(chunk.slice(lastBreak + 1), "utf8");
  for (const line of complete.split(/\r?\n/)) {
    if (!line) continue;
    try {
      const item = JSON.parse(line);
      if (!item || item.seq === undefined) continue;
      events.push(item);
      nextSeq = Math.max(nextSeq, Number(item.seq) || 0);
    } catch {}
  }
  if (events.length > MAX_MEMORY_EVENTS) events = events.slice(-MAX_MEMORY_EVENTS);
}

/** 读取一个事件文件（容错：坏行跳过） */
function readEventFile(file: string): any[] {
  if (!file || !fs.existsSync(file)) return [];
  const parsed: any[] = [];
  try {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        if (item && item.seq !== undefined) parsed.push(item);
      } catch {}
    }
  } catch {}
  return parsed;
}

function readEventIndex(): { version?: number; files: any[]; updatedAt?: string } {
  const value = readJsonFile<any>(EVENT_INDEX_FILE, null);
  return value && Array.isArray(value.files) ? value : { version: 1, files: [] };
}

/**
 * 事件流归档切片：活动文件超过 MAX_ACTIVE_BYTES（或 force）时改名归档并写索引。
 * @returns {{file:string, count:number, bytes:number}|null} 归档信息（未触发返回 null）
 */
export function rotateEventLog({ force = false }: { force?: boolean } = {}): { file: string; count: number; bytes: number } | null {
  ensureStore();
  let stat: fs.Stats;
  try { stat = fs.statSync(EVENT_FILE); } catch { return null; }
  if (!stat.isFile() || stat.size === 0) return null;
  if (!force && stat.size < MAX_ACTIVE_BYTES) return null;
  const parsed = readEventFile(EVENT_FILE);
  if (!parsed.length) return null;
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const archive = path.join(EVENT_DIR, `事件流-${stamp}.jsonl`);
  try {
    if (fs.existsSync(archive)) fs.rmSync(archive, { force: true });
    fs.renameSync(EVENT_FILE, archive);
  } catch (error) {
    console.warn("[events] 归档事件流失败：", (error as Error)?.message || error);
    return null;
  }
  const index = readEventIndex();
  index.version = 1;
  index.files = [...index.files, {
    file: path.basename(archive),
    count: parsed.length,
    bytes: stat.size,
    fromSeq: parsed[0]?.seq ?? null,
    toSeq: parsed[parsed.length - 1]?.seq ?? null,
    fromAt: parsed[0]?.at ?? null,
    toAt: parsed[parsed.length - 1]?.at ?? null,
    archivedAt: new Date().toISOString(),
  }].slice(-ARCHIVE_KEEP_ENTRIES);
  index.updatedAt = new Date().toISOString();
  atomicWriteJson(EVENT_INDEX_FILE, index);
  loaded = false;
  loadStore(true);
  return { file: path.basename(archive), count: parsed.length, bytes: stat.size };
}

function processAlive(pid: unknown): boolean {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  if (Number(pid) === process.pid) return true;
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

function acquireEventLock(): number {
  ensureStore();
  const startedAt = Date.now();
  while (Date.now() - startedAt < EVENT_LOCK_TIMEOUT_MS) {
    try {
      const fd = fs.openSync(EVENT_LOCK_FILE, "wx");
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, lockedAt: new Date().toISOString() }) + "\n", "utf8");
      return fd;
    } catch (error) {
      if ((error as any)?.code !== "EEXIST") throw error;
      try {
        const record = JSON.parse(fs.readFileSync(EVENT_LOCK_FILE, "utf8"));
        if (!processAlive(Number(record.pid))) fs.rmSync(EVENT_LOCK_FILE, { force: true });
      } catch {
        // 创建者可能还没写完锁内容；只有明显超时的损坏锁才回收。
        try {
          const stat = fs.statSync(EVENT_LOCK_FILE);
          if (Date.now() - stat.mtimeMs > EVENT_LOCK_TIMEOUT_MS) fs.rmSync(EVENT_LOCK_FILE, { force: true });
        } catch {}
      }
      if (fs.existsSync(EVENT_LOCK_FILE)) {
        // appendEvent 是同步边界；短暂让出线程，避免多个服务进程忙等。
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8);
      }
    }
  }
  throw new Error("事件流写入锁超时");
}

function releaseEventLock(fd: number) {
  try { fs.closeSync(fd); } catch {}
  try { fs.rmSync(EVENT_LOCK_FILE, { force: true }); } catch {}
}

export function shouldPersistEvent(type: unknown): boolean {
  return PERSISTED_TYPES.has(String(type || ""));
}

export function appendEvent({ clientId = null, threadId = null, runId = null, type, data = {}, at = new Date().toISOString() }: { clientId?: string | null; threadId?: string | null; runId?: string | null; type?: unknown; data?: unknown; at?: string } = {}) {
  // Qoder P1-2（开关 eventSchemaCheck，默认关）：只对「在注册表里声明了 schema 的事件」做结构校验。
  // 打开后仅告警 + 计数，不改变落盘与投递行为；默认关时该分支不进入，行为与基线完全一致。
  if ((RUNTIME_FLAGS as any).eventSchemaCheck) noteEventSchemaCheck(type, data);
  // Qoder P2-5：先记量级（含未落盘的增量事件），再走原有落盘判定。
  if (!shouldPersistEvent(type)) { noteEventTypeStat(type, false); return null; }
  noteEventTypeStat(type, true);
  loadStore();
  let lockFd: number | undefined;
  try {
    lockFd = acquireEventLock();
      // 归档检查：活动文件超过阈值先切片，避免单文件无限增长
      try { rotateEventLog(); } catch (error) { console.warn("[events] 归档检查失败：", (error as Error)?.message || error); }
      // 另一进程可能在当前进程上次读取后追加过事件，分配序号前必须同步新增部分。
      // 只读新增字节（早先是整读活动文件，几 MB 的事件流会让每次追加都变成百毫秒级）。
      syncAppendedEvents();
    const event: any = {
      eventId: `event_${crypto.randomUUID()}`,
      seq: ++nextSeq,
      at,
      clientId: clientId || null,
      threadId: threadId || null,
      runId: runId || null,
      type: String(type),
      data: safeJson(data),
    };
    appendJsonLine(EVENT_FILE, event);
    // 自己刚追加的字节也算已读：否则下次增量同步会把这一行再读一遍，内存里出现重复事件。
    activeFileOffset = fileSizeOf(EVENT_FILE);
    events.push(event);
    if (events.length > MAX_MEMORY_EVENTS) events = events.slice(-MAX_MEMORY_EVENTS);
    releaseEventLock(lockFd);
    lockFd = undefined;
    emitter.emit("event", event);
    return event;
  } catch (error) {
    // Store 写入失败不能阻断 Agent 当前回合；当前会话事件仍由独立通道负责。
    console.warn("[events] 持久化事件失败：", (error as Error)?.message || error);
    return null;
  } finally {
    if (lockFd !== undefined) releaseEventLock(lockFd);
  }
}

export function listEvents({ after = 0, clientId = "", threadId = "", runId = "", limit = 500 }: { after?: unknown; clientId?: string; threadId?: string; runId?: string; limit?: unknown } = {}) {
  loadStore();
  const n = Number(after) || 0;
  const filtered = events.filter((event) =>
    Number(event.seq) > n &&
    (!clientId || event.clientId === clientId) &&
    (!threadId || event.threadId === threadId) &&
    (!runId || event.runId === runId)
  );
  const max = Math.max(1, Math.min(2000, Number(limit) || 500));
  return {
    events: filtered.slice(-max),
    latest: nextSeq,
    earliest: events[0]?.seq || nextSeq,
    truncated: n > 0 && events.length > 0 && n < Number(events[0].seq),
  };
}

export function subscribeEvents(listener: (...args: any[]) => void): () => void {
  loadStore();
  emitter.on("event", listener);
  return () => emitter.off("event", listener);
}

function readCursors(): Record<string, number> {
  try { return JSON.parse(fs.readFileSync(READ_CURSOR_FILE, "utf8")) || {}; } catch { return {}; }
}

export function getReadCursor(clientId = ""): number {
  if (!clientId) return 0;
  return Number(readCursors()[clientId] || 0);
}

export function markReadCursor(clientId = "", seq: unknown = 0) {
  if (!clientId) return { ok: false, error: "clientId required" };
  loadStore();
  ensureStore();
  const cursors = readCursors();
  const requested = Math.max(0, Number(seq) || 0);
  cursors[clientId] = Math.max(Number(cursors[clientId] || 0), Math.min(requested, nextSeq));
  atomicWriteJson(READ_CURSOR_FILE, cursors);
  return { ok: true, clientId, seq: cursors[clientId] };
}

/**
 * Qoder P1-2：事件负载结构校验的告警计数（进程内诊断，不落盘、不改变任何事件语义）。
 * 每种类型最多告警一次，避免高频事件在控制台刷屏；计数经 eventStoreInfo() 暴露。
 */
const eventSchemaViolations = new Map<string, { count: number; warned: boolean; missing: string[]; wrongType: string[] }>();

function noteEventSchemaCheck(type: unknown, data: unknown) {
  let result: ReturnType<typeof validateEventPayload>;
  try { result = validateEventPayload(type, data); } catch { return; }
  if (result.ok) return;
  const key = String(type || "unknown");
  const current = eventSchemaViolations.get(key) || { count: 0, warned: false, missing: [], wrongType: [] };
  current.count += 1;
  current.missing = result.missing as string[];
  current.wrongType = result.wrongType as string[];
  if (!current.warned) {
    current.warned = true;
    console.warn(`[events] 事件负载不符合 schema：${key}｜缺失 ${result.missing.join(",") || "无"}｜类型不符 ${result.wrongType.join(",") || "无"}`);
  }
  eventSchemaViolations.set(key, current);
}

/** 事件负载校验告警快照（诊断面板用，按次数倒序）。 */
export function eventSchemaViolationsSnapshot() {
  return [...eventSchemaViolations.entries()]
    .map(([type, value]) => ({ type, ...value }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Qoder P2-5：按事件类型累计「投递量 / 落盘量 / 未落盘量」。
 * 进程内诊断计数，只读暴露给 /api/agent/events/state，不落盘、不参与任何业务判定，
 * 因此不会改变事件语义与回放行为。
 */
const eventTypeStats = new Map<string, { total: number; persisted: number; skipped: number }>();

function noteEventTypeStat(type: unknown, persisted: boolean) {
  const key = String(type || "unknown");
  const current = eventTypeStats.get(key) || { total: 0, persisted: 0, skipped: 0 };
  current.total += 1;
  if (persisted) current.persisted += 1;
  else current.skipped += 1;
  eventTypeStats.set(key, current);
}

/** 按投递量倒序返回各事件类型的量级统计（诊断面板用）。 */
export function eventTypeStatsSnapshot({ limit = 60 }: { limit?: unknown } = {}) {
  const size = Number.isFinite(limit) && Number(limit) > 0 ? Number(limit) : 60;
  return [...eventTypeStats.entries()]
    .map(([type, value]) => ({ type, total: value.total, persisted: value.persisted, skipped: value.skipped }))
    .sort((a, b) => b.total - a.total || a.type.localeCompare(b.type))
    .slice(0, size);
}

export function eventStoreInfo() {
  loadStore();
  const index = readEventIndex();
  return {
    file: EVENT_FILE,
    latest: nextSeq,
    earliest: events[0]?.seq || nextSeq,
    count: events.length,
    rotateBytes: MAX_ACTIVE_BYTES,
    archives: index.files.length,
    latestArchive: index.files[index.files.length - 1]?.file || null,
    // P2-5：事件量级遥测（按类型统计投递/落盘/未落盘），只读诊断字段。
    typeStats: eventTypeStatsSnapshot(),
    // P1-2：事件负载校验告警（仅在开关 eventSchemaCheck 打开时才会累积），只读诊断字段。
    schemaViolations: eventSchemaViolationsSnapshot(),
  };
}
