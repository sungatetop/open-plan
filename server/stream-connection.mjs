/**
 * SSE 长连接登记表（服务端侧）。
 *
 * 为什么需要它：浏览器同源 HTTP/1.1 连接池只有 6 个槽位，SSE 长期占位。
 * 客户端反复重连（切换会话/工作区、半开连接、多标签页）时，服务端如果不主动
 * 收掉旧连接，旧连接会一直挂在连接池里——用户看到的就是"整站卡死、切不动"。
 * 这里做两件事：
 *   1. 同键去重：同一个 (path, client, thread) 只保留最新一条流，旧流主动收尾；
 *   2. 诊断：GET /api/diagnostics/streams 能直接看到当前挂了哪些流、各挂了多久。
 */

const streams = new Map();
let seq = 0;

/**
 * 同一 (path, client, thread) 允许同时存活的流条数。
 *
 * 早先是 1（最新者胜）：好处是不累积，但**同一会话的多个读者会互相踢**——
 * 两个标签页共享同一个 client id（存在 localStorage），加上外部监测工具，
 * 会陷入"你连我断、我连你断"的重连循环。放宽到 2：允许一个备用读者并存，
 * 仍由 MAX_PER_CLIENT 与周期清扫兜住上限。
 */
const MAX_SAME_KEY = 2;
/** 同一个 client 允许同时存活的总流条数（多标签页时的兜底）。 */
const MAX_PER_CLIENT = 8;
/**
 * 同 (path, client) 的"最新者胜"规则：页面重载/切会话时浏览器可能已经不用旧连接，
 * 但服务端迟迟收不到 FIN（半开连接），旧流就会一直挂在登记表里。
 * keep 是保留条数；graceMs 内不判旧（覆盖组件切换时新旧流短暂并存）。
 */
const SUPERSEDE = {
  "/api/agent/stream": { keep: 2, graceMs: 60000 },
  "/api/browser/stream": { keep: 2, graceMs: 5000 },
  "/api/agent/events": { keep: 2, graceMs: 5000 },
  "/api/memory/stream": { keep: 1, graceMs: 5000 },
};

export function streamKeyOf({ path, client = "", thread = "" }) {
  return `${path}|${client}|${thread}`;
}

/**
 * P1-5：按 path 的连接配额（是否启用由开关 streamQuota 决定，默认关 = 完全不检查）。
 * 为什么需要：同一浏览器的多标签页共享 client id（存 localStorage），基线只有
 * 「同键去重 + 单 client 上限」，没有按用途的显式配额；多标签页反复重连时
 * 对话流 / 事件流 / 帧流会一起无界增长，最终把浏览器同源连接池占满。
 * 阈值按「单浏览器正常并行阅读」的上限取值：对话流 8（多标签 + 外部监测），其余 4。
 */
const STREAM_QUOTA = {
  "/api/agent/stream": 8,
  "/api/agent/events": 4,
  "/api/browser/stream": 4,
  "/api/memory/stream": 4,
};

/** 某条 path 当前的配额占用；未列入配额表的 path 返回 limit=0（表示不受配额约束）。 */
export function streamQuotaOf(path) {
  const limit = STREAM_QUOTA[path] || 0;
  if (!limit) return { path, limit: 0, current: 0, ok: true };
  const current = [...streams.values()].filter((entry) => entry.path === path).length;
  return { path, limit, current, ok: current < limit };
}

/**
 * 拒绝一条超出配额的流：返回 503 + `Retry-After`（标准退避提示），
 * 与 Qoder 的 `REMOTE_CONTROL_REQUEST_QUEUE_FULL` 语义对齐。
 * 只写响应、不登记流，因此不占用登记表、也不影响既有连接。
 */
export function rejectStreamQuota(res, { path, current, limit, retryAfterSeconds = 5 } = {}) {
  const body = { ok: false, code: "STREAM_QUOTA_EXCEEDED", path: path || "", current: current ?? 0, limit: limit ?? 0 };
  try {
    res.writeHead(503, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Retry-After": String(Math.max(1, Number(retryAfterSeconds) || 5)),
    });
    res.end(JSON.stringify(body));
  } catch {
    try { res.end(); } catch {}
  }
  return body;
}

/**
 * 登记一条流。返回 { id, release }；若触发了去重/超限，会把被顶掉的旧流写进 replaced。
 * @param {{path: string, client?: string, thread?: string, close: () => void, note?: string, probe?: () => boolean}} options
 *        probe 用于判断连接是否还活着（默认看响应/socket 状态），供清扫使用。
 */
export function registerServerStream({ path, client = "", thread = "", close, note = "", probe = null }) {
  const key = streamKeyOf({ path, client, thread });
  const replaced = [];
  // 同键去重：旧连接不主动收掉的话，客户端每次重连都会多占一个池槽位。
  const sameKey = [...streams.values()].filter((entry) => entry.key === key);
  while (sameKey.length >= MAX_SAME_KEY) {
    const victim = sameKey.shift();
    streams.delete(victim.id);
    replaced.push({ id: victim.id, reason: "same-key" });
    safeClose(victim);
  }
  // 同一 client 总量兜底：超过上限时收掉最旧的非最新流。
  const sameClient = [...streams.values()].filter((entry) => entry.client && entry.client === client);
  while (sameClient.length >= MAX_PER_CLIENT) {
    const victim = sameClient.shift();
    streams.delete(victim.id);
    replaced.push({ id: victim.id, reason: "client-limit" });
    safeClose(victim);
  }
  // 最新者胜：同类型同客户端只留最新 keep 条，超宽限期的旧流一律收掉。
  const rule = SUPERSEDE[path];
  if (rule && client) {
    const samePath = [...streams.values()]
      .filter((entry) => entry.path === path && entry.client === client)
      .sort((a, b) => b.openedAt - a.openedAt);
    const now = Date.now();
    for (const entry of samePath.slice(rule.keep)) {
      if (now - entry.openedAt < rule.graceMs) continue;
      streams.delete(entry.id);
      replaced.push({ id: entry.id, reason: "superseded" });
      safeClose(entry);
    }
  }
  const id = `stream-${++seq}`;
  streams.set(id, { id, key, path, client, thread, note, probe, openedAt: Date.now(), bytes: 0, lastWriteAt: 0, close });
  return { id, release: () => releaseServerStream(id), replaced };
}

/**
 * 清扫已经断开的流：客户端被强杀/网络静默断开时不发 FIN，
 * req.on("close") 不会触发，登记表里就留下一条永远"存活"的僵尸流。
 */
export function sweepServerStreams() {
  let closed = 0;
  for (const entry of [...streams.values()]) {
    if (typeof entry.probe !== "function") continue;
    let alive = true;
    try { alive = entry.probe() !== false; } catch { alive = false; }
    if (alive) continue;
    streams.delete(entry.id);
    safeClose(entry);
    closed += 1;
  }
  return closed;
}

export function releaseServerStream(id) {
  const entry = streams.get(id);
  if (!entry) return false;
  streams.delete(id);
  return true;
}

export function listServerStreams() {
  const now = Date.now();
  return [...streams.values()].map((entry) => ({
    id: entry.id,
    path: entry.path,
    client: entry.client,
    thread: entry.thread,
    note: entry.note,
    ageMs: now - entry.openedAt,
    idleMs: entry.lastWriteAt ? now - entry.lastWriteAt : now - entry.openedAt,
    bytes: entry.bytes,
  }));
}

export function serverStreamStats() {
  const items = listServerStreams();
  const byPath = {};
  const byClient = {};
  for (const item of items) {
    byPath[item.path] = (byPath[item.path] || 0) + 1;
    if (item.client) byClient[item.client] = (byClient[item.client] || 0) + 1;
  }
  return { total: items.length, byPath, byClient, maxPerClient: MAX_PER_CLIENT, maxSameKey: MAX_SAME_KEY, supersede: SUPERSEDE };
}

/** 关掉某条流（或某个 client 的全部流）；用于诊断接口与"卡死"时的救援。 */
export function closeServerStreams(filter = {}) {
  let closed = 0;
  for (const entry of [...streams.values()]) {
    if (filter.id && entry.id !== filter.id) continue;
    if (filter.path && entry.path !== filter.path) continue;
    if (filter.client && entry.client !== filter.client) continue;
    streams.delete(entry.id);
    safeClose(entry);
    closed += 1;
  }
  return closed;
}

/** 心跳/写入时记账：诊断里能区分"活着"和"挂死"。 */
export function noteStreamWrite(id, bytes = 0) {
  const entry = streams.get(id);
  if (!entry) return;
  entry.bytes += bytes;
  entry.lastWriteAt = Date.now();
}

function safeClose(entry) {
  try { entry.close?.(); } catch {}
}

/* ===== Qoder P0-2：单帧体积护栏（纯函数，无 I/O、无副作用）=====
   超大 tool_output（例如 officecli 返回的整段 JSON、bash 的巨量 stdout）以单帧下发时，
   会一次性把整帧塞进 SSE 通路：客户端解析一次要整块驻留内存，服务端排空队列也会被顶到上限。
   这里按「单帧 ≤ 上限字节」把文本切成多片，第一片仍走 tool_output（保留 replace 语义），
   其余走增量事件 tool_output_delta（只追加）。
   注意：切分按「码点」推进，不会把多字节字符劈成半个（避免前端拿到乱码）。 */

/** 按 UTF-8 字节上限切分文本；按码点推进，保证每个片段都是合法字符串。 */
export function 按字节切分(文本, 上限字节 = 256 * 1024) {
  const 内容 = String(文本 ?? "");
  const 上限 = Math.max(1024, Number(上限字节) || 256 * 1024);
  if (!内容) return [];
  if (Buffer.byteLength(内容, "utf8") <= 上限) return [内容];
  const 片段 = [];
  let 当前 = "";
  let 当前字节 = 0;
  for (const 字 of 内容) {
    const 字节 = Buffer.byteLength(字, "utf8");
    if (当前 && 当前字节 + 字节 > 上限) {
      片段.push(当前);
      当前 = "";
      当前字节 = 0;
    }
    当前 += 字;
    当前字节 += 字节;
  }
  if (当前) 片段.push(当前);
  return 片段;
}

/**
 * 把一条 tool_output 载荷切成「下发帧」序列。
 * @returns {Array<{type:string, data:object}>} 单帧（未超限）时原样返回一条 tool_output，
 *   保证开关打开但输出不大时与基线**完全同形**。
 */
export function 工具输出分片(载荷 = {}, 上限字节 = 256 * 1024) {
  const 片段 = 按字节切分(载荷?.output, 上限字节);
  if (片段.length <= 1) return [{ type: "tool_output", data: 载荷 }];
  const 帧列表 = [{ type: "tool_output", data: { ...载荷, output: 片段[0] } }];
  for (let i = 1; i < 片段.length; i += 1) {
    帧列表.push({
      type: "tool_output_delta",
      data: { toolCallId: 载荷?.toolCallId ?? null, name: 载荷?.name ?? null, output: 片段[i], index: i, frames: 片段.length },
    });
  }
  return 帧列表;
}

/** 单帧上限（字节）解析：非法值回落到默认 256 KiB。 */
export function 工具输出帧上限(值) {
  const 数 = Number(值);
  return Number.isFinite(数) && 数 >= 1024 ? Math.floor(数) : 256 * 1024;
}
