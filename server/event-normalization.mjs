/**
 * U8：事件规范化层（PI SDK 事件 → 规范化事件 schema 的纯函数管道）。
 *
 * 定位（评审后收敛）：
 *   - 规范化是"可测试的纯函数"，不是运行时总线；SSE 协议 / 事件注册表 / 前端投影
 *     契约零改动。flag（OAW_EVENT_NORMALIZE）开启时，emit 信封额外携带 canonical
 *     视图（内存态，不落盘），供内部观测与第二阶段 DSH 适配（normalizeDshEvent
 *     的对偶实现）复用同一 schema。
 *   - 映射表是唯一事实来源：Pi 事件类型 → 规范化 type。新增映射不改调用方。
 *
 * 规范化 schema（《适配方案》§1 信封 + canonical 字段）：
 *   { protocolVersion, eventId, sequence, type, status, replayable, timestamp,
 *     runId, turnId, toolCallId, payload }
 */

export const CANONICAL_SCHEMA_VERSION = 1;

/** Pi session 事件 → 规范化 type。未列出的类型映射为 `pi.<原类型>`（保守透传）。 */
export const PI_EVENT_TO_CANONICAL = Object.freeze({
  agent_start: "agent.started",
  turn_start: "turn.started",
  turn_end: "turn.ended",
  message_start: "message.started",
  message_end: "message.ended",
  message_update: "message.delta",
  tool_execution_start: "tool.started",
  tool_execution_update: "tool.output",
  tool_execution_end: "tool.ended",
  compaction_start: "context.compacting",
  compaction_end: "context.compacted",
  auto_retry_start: "agent.retry",
  agent_end: "agent.ended",
  usage: "stats.usage",
  stats: "stats.usage",
  queue_update: "queue.updated",
});

const KNOWN_CANONICAL_STATUSES = new Set(["started", "output", "ended", "delta", "retry", "usage", "updated", "compacting", "compacted"]);

function canonicalTypeFor(piType) {
  return PI_EVENT_TO_CANONICAL[piType] || `pi.${String(piType || "unknown")}`;
}

function canonicalStatusFor(canonicalType) {
  const tail = String(canonicalType || "").split(".").pop();
  return KNOWN_CANONICAL_STATUSES.has(tail) ? tail : "event";
}

/**
 * 纯函数：Pi 原始事件 → 规范化事件。
 * @param {{ type?: string, toolCallId?: string|null, turnIndex?: number|null }} piEvent
 * @param {{ payload?: object }} extra 附加载荷（可选）
 */
export function normalizePiEvent(piEvent, extra = {}) {
  const type = canonicalTypeFor(piEvent?.type);
  return {
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    type,
    status: canonicalStatusFor(type),
    toolCallId: piEvent?.toolCallId ?? null,
    turnId: piEvent?.turnIndex ?? null,
    replayable: false,
    payload: extra?.payload && typeof extra.payload === "object" ? extra.payload : {},
  };
}

/**
 * 把工作台 emit 信封（SSE 形状，见 agent.mjs emit）转为规范化视图。
 * 不改变信封本身；产物用于内部观测/测试/未来多内核事件桥。
 */
export function canonicalFromEnvelope(ev) {
  if (!ev || typeof ev !== "object") return null;
  const data = ev.data && typeof ev.data === "object" ? ev.data : {};
  return {
    protocolVersion: ev.protocolVersion ?? null,
    eventId: ev.id ?? null,
    sequence: ev.seq ?? ev.id ?? null,
    type: canonicalTypeFor(ev.type),
    status: canonicalStatusFor(canonicalTypeFor(ev.type)),
    replayable: true,
    timestamp: ev.at ?? null,
    runId: data.runId ?? null,
    turnId: data.turnIndex ?? null,
    toolCallId: data.toolCallId ?? null,
    payload: data,
  };
}

/** 运行时断言：第二阶段 DSH 适配（normalizeDshEvent）产出的对象必须满足本形状。 */
export function assertCanonicalShape(obj) {
  if (!obj || typeof obj !== "object") throw new Error("canonical 事件必须是对象");
  for (const key of ["type", "status"]) {
    if (typeof obj[key] !== "string" || !obj[key]) throw new Error(`canonical 事件缺少 ${key}`);
  }
  if (obj.schemaVersion !== undefined && obj.schemaVersion !== CANONICAL_SCHEMA_VERSION) {
    throw new Error(`canonical schemaVersion 不匹配：${obj.schemaVersion}`);
  }
  return true;
}
