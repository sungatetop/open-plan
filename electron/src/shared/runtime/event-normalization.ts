/**
 * U8：事件规范化层（PI SDK 事件 → 规范化事件 schema 的纯函数管道）。
 *
 * 定位：规范化是"可测试的纯函数"；映射表是唯一事实来源。
 * 未列出的 Pi 类型映射为 `pi.<原类型>`（保守透传）。
 *
 * 与 server/event-normalization.mjs 逐函数等价（tests/event-normalization-parity.test.ts 对拍强制）。
 */

export const CANONICAL_SCHEMA_VERSION = 1;

/** Pi session 事件 → 规范化 type。 */
export const PI_EVENT_TO_CANONICAL: Readonly<Record<string, string>> = Object.freeze({
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
  queue_update: "queue.updated"
});

export interface PiEventInput {
  type?: string;
  toolCallId?: unknown;
  turnIndex?: unknown;
}

export interface CanonicalEvent {
  schemaVersion?: number;
  type: string;
  status: string;
  toolCallId?: unknown;
  turnId?: unknown;
  replayable: boolean;
  timestamp?: unknown;
  runId?: unknown;
  protocolVersion?: unknown;
  eventId?: unknown;
  sequence?: unknown;
  payload?: unknown;
}

const KNOWN_CANONICAL_STATUSES = new Set(["started", "output", "ended", "delta", "retry", "usage", "updated", "compacting", "compacted"]);

function canonicalTypeFor(piType: unknown): string {
  // 与 JS 版严格等价：查表键走 ToPropertyKey（String 化），回退用真值判断（""/0/false 同样回退）
  const mapped = PI_EVENT_TO_CANONICAL[String(piType)];
  return mapped || `pi.${Boolean(piType) ? String(piType) : "unknown"}`;
}

function canonicalStatusFor(canonicalType: string): string {
  const tail = String(canonicalType ?? "").split(".").pop() ?? "";
  return KNOWN_CANONICAL_STATUSES.has(tail) ? tail : "event";
}

/** 纯函数：Pi 原始事件 → 规范化事件。 */
export function normalizePiEvent(piEvent: PiEventInput | null | undefined, extra: { payload?: unknown } = {}): CanonicalEvent {
  const type = canonicalTypeFor(piEvent?.type);
  return {
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    type,
    status: canonicalStatusFor(type),
    toolCallId: piEvent?.toolCallId ?? null,
    turnId: piEvent?.turnIndex ?? null,
    replayable: false,
    payload: extra?.payload && typeof extra.payload === "object" ? extra.payload : {}
  };
}

/** 把工作台 emit 信封（SSE 形状）转为规范化视图；不改变信封本身。 */
export function canonicalFromEnvelope(ev: unknown): CanonicalEvent | null {
  if (!ev || typeof ev !== "object") return null;
  const envelope = ev as Record<string, unknown>;
  const data = envelope.data && typeof envelope.data === "object" ? (envelope.data as Record<string, unknown>) : {};
  const type = canonicalTypeFor(envelope.type);
  return {
    protocolVersion: envelope.protocolVersion ?? null,
    eventId: envelope.id ?? null,
    sequence: envelope.seq ?? envelope.id ?? null,
    type,
    status: canonicalStatusFor(type),
    replayable: true,
    timestamp: envelope.at ?? null,
    runId: data.runId ?? null,
    turnId: data.turnIndex ?? null,
    toolCallId: data.toolCallId ?? null,
    payload: data
  };
}

/** 运行时断言：DSH 适配产出的对象必须满足本形状。 */
export function assertCanonicalShape(obj: unknown): true {
  if (!obj || typeof obj !== "object") throw new Error("canonical 事件必须是对象");
  const candidate = obj as Record<string, unknown>;
  for (const key of ["type", "status"]) {
    if (typeof candidate[key] !== "string" || !candidate[key]) throw new Error(`canonical 事件缺少 ${key}`);
  }
  if (candidate.schemaVersion !== undefined && candidate.schemaVersion !== CANONICAL_SCHEMA_VERSION) {
    throw new Error(`canonical schemaVersion 不匹配：${String(candidate.schemaVersion)}`);
  }
  return true;
}
