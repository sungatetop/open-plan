/**
 * Agent 通道 emit 助手族（B6-6-3，自 server/agent.mjs L4684-4758 逐行转录）。
 *
 * - emitChannelSafe：通道事件投递（信封组装 + 历史缓冲 + 在途静默记账 + 持久化），
 *   全程 try/catch 吞错——投递失败不允许打断 Agent 主流程。
 * - emitToolOutput：Qoder P0-2 单帧体积护栏（开关 qoderToolOutputSplit 默认关，关闭时
 *   执行的就是基线那一句 `emit("tool_output", payload)`，逐字未变）。
 * - emitAbortedOnce：中断终态事件幂等（同一 Run 只发一次 aborted）+ Qoder P0-3 有界排空
 *   （开关 qoderDrainOnAbort 默认关）。
 *
 * recordRunEvent 属 runs 域（server/runs.mjs，未迁），经 deps 注入；flags 经 deps 注入
 * 以支持对拍切场景，缺省用 RUNTIME_FLAGS。收尾批接线时由 AgentManager 闭包提供。
 */
import { CHANNEL_HISTORY_LIMIT, PROTOCOL_VERSION, pushChannelEvent } from "../../../shared/runtime/event-protocol";
import { RUNTIME_FLAGS } from "../../../shared/runtime/feature-flags";
import { 工具输出分片, 工具输出帧上限 } from "./tool-output-split";

/** 本批消费的运行开关子集（宽容类型，真值语义与旧 JS 一致）。 */
export interface EmitFlags {
  qoderToolOutputSplit?: unknown;
  qoderToolOutputFrameMaxBytes?: unknown;
  qoderDrainOnAbort?: unknown;
  qoderDrainMaxMs?: unknown;
  qoderDrainQuietMs?: unknown;
}

/** runs 域持久化 seam（server/runs.mjs 的 recordRunEvent，B6 后续批次迁移）。 */
export type EmitRecordRunEvent = (id: unknown, type: unknown, data: unknown) => void;

export interface EmitDeps {
  recordRunEvent?: EmitRecordRunEvent;
  flags?: EmitFlags;
}

export function emitChannelSafe(entry: any, type: string, data: any, { persist = true }: { persist?: boolean } = {}, deps: EmitDeps = {}) {
  try {
    const id = ++entry.channel.seq;
    const at = new Date().toISOString();
    const eventData = data && typeof data === "object" && !Array.isArray(data)
      ? { ...data, runId: data.runId ?? entry?.activeRunId ?? null }
      : { value: data, runId: entry?.activeRunId ?? null };
    const ev = { id, type, at, streamId: entry.channel.streamId, protocolVersion: PROTOCOL_VERSION, data: eventData };
    if (!entry.channel.historyLimit) entry.channel.historyLimit = CHANNEL_HISTORY_LIMIT;
    pushChannelEvent(entry.channel, ev);
    // Qoder P0-3：记录通道最近一次事件投递时刻，供中断排空判定「在途消息是否已静默」。
    entry.channel.lastEmitAt = Date.now();
    entry.channel.emitter.emit("event", ev);
    if (persist && entry.activeRunId) {
      try { deps.recordRunEvent?.(entry.activeRunId, type, data || {}); } catch {}
    }
  } catch {}
}

/**
 * Qoder P0-2（开关 qoderToolOutputSplit，默认关）：工具输出「单帧体积护栏」。
 *
 * 开关关闭时执行的就是基线那一句 `emit("tool_output", payload)`（逐字未变）；
 * 打开且输出超过单帧上限时，首片仍是 tool_output（保留 replace 语义），
 * 其余切为 tool_output_delta 增量帧——避免一整帧超大输出把 SSE 通路与客户端内存顶爆。
 */
export function emitToolOutput(emit: (type: string, data: any) => void, payload: any, deps: EmitDeps = {}) {
  const flags = deps.flags ?? RUNTIME_FLAGS;
  if (!flags.qoderToolOutputSplit) {
    emit("tool_output", payload);
    return 1;
  }
  const 帧列表 = 工具输出分片(payload, 工具输出帧上限(flags.qoderToolOutputFrameMaxBytes));
  帧列表.forEach((帧) => emit(帧.type, 帧.data));
  return 帧列表.length;
}

/**
 * 中断终态事件幂等：同一 Run 只发一次 aborted。
 * 中断可能从两条路收尾（abort() 主动发 / agent_settled 发现 SDK 以中断收尾），
 * 不幂等的话客户端会收到两次「本轮已中断」。
 */
export function emitAbortedOnce(entry: any, reason = "", deps: EmitDeps = {}) {
  if (!entry) return false;
  const flags = deps.flags ?? RUNTIME_FLAGS;
  const runId = entry.activeRunId || null;
  const token = runId || `no-run:${entry.abortRequestedAt || 0}`;
  if (entry.abortedEmittedRunId === token) return false;
  entry.abortedEmittedRunId = token;
  // Qoder P0-3（开关 qoderDrainOnAbort，默认关）：
  // 基线立即发 aborted；此时仍在途的 token/tool_output 会晚于终态到达，被前端 generation
  // 守卫丢弃——表现为「半句话丢失」或被下一轮吞并。
  // 打开后先发 run_draining 并做有界排空：等到通道静默（默认 300ms 无新事件）或达到上限
  // （默认 1500ms）再发 aborted，让在途消息先落进当前轮次。幂等令牌在上方已置位，
  // 因此排空期间若有第二条收尾路径调用本函数，不会重复排空或重复发终态。
  if (!flags.qoderDrainOnAbort) {
    emitChannelSafe(entry, "aborted", { runId, reason }, {}, deps);
    return true;
  }
  const drainMaxMs = Math.max(100, Number(flags.qoderDrainMaxMs) || 1500);
  const drainQuietMs = Math.max(50, Number(flags.qoderDrainQuietMs) || 300);
  emitChannelSafe(entry, "run_draining", { runId, reason, quietMs: drainQuietMs, maxMs: drainMaxMs }, {}, deps);
  const startedAt = Date.now();
  const settle = () => {
    entry.drainTimer = null;
    const lastEmitAt = Number(entry.channel?.lastEmitAt || 0);
    const idleFor = Date.now() - Math.max(lastEmitAt, startedAt);
    const elapsed = Date.now() - startedAt;
    if (idleFor < drainQuietMs && elapsed < drainMaxMs) {
      entry.drainTimer = setTimeout(settle, 100);
      return;
    }
    emitChannelSafe(entry, "aborted", { runId, reason, drained: idleFor >= drainQuietMs }, {}, deps);
  };
  entry.drainTimer = setTimeout(settle, drainQuietMs);
  return true;
}
