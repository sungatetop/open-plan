/**
 * B 层通道直调器（S2，迁移期过渡形态）：op:agent:* 薄映射通道 → TS AgentManager 进程内直调。
 *
 * 旧路径：渲染层 invoke → http-forward 转发 sidecar HTTP（/api/agent/*）。
 * 本模块把 B 层 10 条通道的 sidecar 路由语义逐点转录为主进程内直调，数据源从
 * sidecar agentManager 换为 TS AgentManager（backend/agent/assembly 装配单飞实例）：
 *   - 9 条 invoke 通道（model:set / runtime / pending / approvals / approval /
 *     approval-mode:get / approval-mode:set / events-state / events-read）：
 *     与 server/index.mjs 各路由逐点对齐（校验规则 / 错误码 / 响应形状）；
 *   - stream-close 单独导出（注册条件更严）：S1 直推接管对话流事件面后 app 形态
 *     不存在 /api/agent/stream SSE，直调等价于 no-op {closed:0}（server L4715-4724
 *     语义：无匹配流即 closed:0）；S1 未接管时不得直调（须转发 sidecar 关闭真实 SSE）。
 *
 * 运行实例归属（与 S1 直推"握手帧-only"同构的过渡语义）：model:set / runtime /
 * pending / approvals(approval) 消费的会话态（sessions map）与审批态
 * （pendingApprovals map）归属运行实例——prompt 流量切至 TS 实例（S3）前，这些
 * 通道直调读到的是 TS 实例的空态；events-state / events-read / approval-mode 为
 * 文件族共享态（B2-4 同一 env 锚点），跨实例即时一致。
 *
 * 门控：OP_DESKTOP_AGENT_B_DIRECT 且 OP_DESKTOP_AGENT_DOMAIN 双门控（S4 起默认开，
 * =0 显式回滚——流量切换评估方案 §4-S4）。本模块不 import electron（纯逻辑，vitest 可直接测）；
 * 注册入口在 main/index.ts。
 */
import fs from "node:fs";
import path from "node:path";
import type { ChannelFailureData, InvokeEnvelope, InvokeResult } from "../../shared/protocol/channels";
import { classifyAgentError } from "../backend/agent/agent-errors";
import { agentKey } from "../backend/agent/agent-key";

/** TS AgentManager 直调消费面（结构化最小视图，装配单飞实例满足）。 */
export interface DirectInvokerAgentManagerView {
  setModel(clientId: unknown, spec: unknown): Promise<unknown>;
  runtimeHealth(clientId: unknown): unknown;
  usageSnapshot(clientId: unknown): unknown;
  resolveLiveEntry(clientId: unknown): unknown;
  pendingQuestions(clientId?: unknown): unknown;
}

/** setModel 失败诊断明细（server recordAgentDiagnostic 调用点同参）。 */
export interface AgentDiagnosticDetails {
  client?: unknown;
  thread?: unknown;
  model?: unknown;
  error: unknown;
}

export interface AgentDirectInvokerDeps {
  /** TS AgentManager 单飞（生产传 assembly.getAgentManager；测试注入桩） */
  getManager: () => Promise<DirectInvokerAgentManagerView>;
  /** 审批域（approval-policy.ts 同名转录，文件/内存态单实例） */
  listPendingApprovals: () => unknown;
  getApprovalMode: () => unknown;
  setApprovalMode: (mode: unknown) => unknown;
  resolveToolApproval: (id: unknown, decision: unknown) => unknown;
  /** 事件游标域（event-storage.ts，B2-4 文件族共享态） */
  eventStoreInfo: () => Record<string, unknown>;
  getReadCursor: (clientId: string) => unknown;
  markReadCursor: (clientId: string, seq: unknown) => unknown;
  /** 会话键（默认 backend/agent/agent-key 转录，server L1387-1391） */
  agentKeyOf?: (client: unknown, thread: unknown) => string;
  /** setModel 失败诊断（默认落盘 TEMP 诊断日志，server L118-136 转录） */
  recordDiagnostic?: (details: AgentDiagnosticDetails) => void;
  /** 诊断日志路径（默认 TEMP/open-plan-agent连接诊断.log；生产接线传 projectRoot 回退） */
  diagnosticLogPath?: () => string;
}

/** B 层直调 invoke 通道清单（stream-close 除外，见 invokeAgentStreamCloseDirect）。 */
export const AGENT_DIRECT_INVOKE_CHANNELS = [
  "op:agent:model:set",
  "op:agent:runtime",
  "op:agent:pending",
  "op:agent:approvals",
  "op:agent:approval",
  "op:agent:approval-mode:get",
  "op:agent:approval-mode:set",
  "op:agent:events-state",
  "op:agent:events-read"
] as const;

export type AgentDirectInvokeChannel = (typeof AGENT_DIRECT_INVOKE_CHANNELS)[number];

/** stream-close 通道（注册条件含 S1 直推，独立于其余 9 条）。 */
export const AGENT_STREAM_CLOSE_CHANNEL = "op:agent:stream-close";

const AGENT_DIAGNOSTIC_LOG_NAME = "open-plan-agent连接诊断.log";

function defaultDiagnosticLogPath(): string {
  return path.join(process.env.TEMP || "", AGENT_DIAGNOSTIC_LOG_NAME);
}

/** recordAgentDiagnostic 转录（server/index.mjs L118-136；无 req → requestId/runId=null）。 */
function recordAgentDiagnosticDefault(logPath: string, details: AgentDiagnosticDetails): void {
  const info = classifyAgentError(details.error);
  const record = {
    time: new Date().toISOString(),
    requestId: null,
    clientId: details.client || null,
    threadId: details.thread || null,
    runId: null,
    model: details.model || null,
    providerStatus: info.status ?? null,
    errorCode: info.code ?? null,
    errorCategory: info.category ?? null,
    causeCode: info.causeCode ?? null,
    retryable: Boolean(info.retryable),
    message: info.message || "模型连接失败"
  };
  try { fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf8"); } catch { /* 诊断落盘失败不阻断主流程 */ }
  console.error("[agent] prompt failed", record);
}

const ok = (data: unknown): InvokeResult<unknown> => ({ ok: true, status: 200, data });

const fail = (status: number, error: string): InvokeResult<unknown> => ({
  ok: false,
  status,
  data: { error } as ChannelFailureData
});

function bodyOf(payload: InvokeEnvelope): Record<string, unknown> {
  const body = payload.body;
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

function queryOf(payload: InvokeEnvelope): Record<string, unknown> {
  return (payload.query ?? {}) as Record<string, unknown>;
}

/** POST /api/agent/model（server L1777-1786 逐点转录）。 */
async function invokeModelSet(payload: InvokeEnvelope, deps: ResolvedDeps): Promise<InvokeResult<unknown>> {
  const body = bodyOf(payload);
  const { client, thread, model } = body;
  if (!client || !model) return fail(400, "client and model required");
  const manager = await deps.getManager();
  try {
    return ok(await manager.setModel(deps.agentKeyOf(client, thread), model));
  } catch (error) {
    deps.recordDiagnostic({ client, thread, model: String(model), error });
    return fail(500, error instanceof Error ? error.message : String(error));
  }
}

/** GET /api/agent/runtime（server L1863-1868 逐点转录）。 */
async function invokeRuntime(payload: InvokeEnvelope, deps: ResolvedDeps): Promise<InvokeResult<unknown>> {
  const query = queryOf(payload);
  const client = String(query.client || "").trim();
  if (!client) return fail(400, "client required");
  const manager = await deps.getManager();
  const key = deps.agentKeyOf(client, query.thread);
  return ok({ runtime: manager.runtimeHealth(key), usage: manager.usageSnapshot(key) });
}

/** GET /api/agent/pending（server L3979-3991 逐点转录；client/thread 不 trim）。 */
async function invokePending(payload: InvokeEnvelope, deps: ResolvedDeps): Promise<InvokeResult<unknown>> {
  const query = queryOf(payload);
  const client = String(query.client || "");
  const thread = String(query.thread || "");
  const key = client && thread ? deps.agentKeyOf(client, thread) : "";
  const manager = await deps.getManager();
  const entry = key ? (manager.resolveLiveEntry(key) as { session?: { pendingMessageCount?: unknown } } | null) : null;
  // U7：会话内待投递消息（steering/followUp 队列），前端可显示"待投递 N 条"徽标。
  let pendingMessages: unknown = null;
  try {
    const session = entry?.session;
    pendingMessages = typeof session?.pendingMessageCount === "number" ? session.pendingMessageCount : null;
  } catch { /* server 同款静默 */ }
  return ok({ questions: manager.pendingQuestions(key), pendingMessages });
}

/** POST /api/agent/approval（server L4028-4036 逐点转录）。 */
function invokeApproval(payload: InvokeEnvelope, deps: ResolvedDeps): InvokeResult<unknown> {
  const body = bodyOf(payload);
  const { id, decision } = body;
  if (!id || !["allow", "always", "deny"].includes(String(decision || ""))) {
    return fail(400, "id and decision (allow/always/deny) required");
  }
  const result = deps.resolveToolApproval(id, decision) as { ok?: boolean } & Record<string, unknown>;
  if (!result.ok) return { ok: false, status: 404, data: result };
  return ok(result);
}

/** PATCH /api/agent/approval-mode（server L4021-4025 逐点转录）。 */
function invokeApprovalModeSet(payload: InvokeEnvelope, deps: ResolvedDeps): InvokeResult<unknown> {
  const body = bodyOf(payload);
  const mode = String(body.mode || "ask");
  if (!["ask", "auto"].includes(mode)) return fail(400, "mode must be ask or auto");
  return ok(deps.setApprovalMode(mode));
}

/** GET /api/agent/events/state（server L3124-3128 逐点转录）。 */
async function invokeEventsState(payload: InvokeEnvelope, deps: ResolvedDeps): Promise<InvokeResult<unknown>> {
  const query = queryOf(payload);
  const clientId = String(query.client || "").trim();
  if (!clientId) return fail(400, "client required");
  return ok({ ...deps.eventStoreInfo(), readCursor: deps.getReadCursor(clientId) });
}

/** POST /api/agent/events/read（server L3130-3134 逐点转录；错误文案与 server 一致只查 client）。 */
async function invokeEventsRead(payload: InvokeEnvelope, deps: ResolvedDeps): Promise<InvokeResult<unknown>> {
  const body = bodyOf(payload);
  const { client, seq } = body;
  if (!client) return fail(400, "client and seq required");
  return ok(deps.markReadCursor(String(client), seq));
}

interface ResolvedDeps extends AgentDirectInvokerDeps {
  agentKeyOf: (client: unknown, thread: unknown) => string;
  recordDiagnostic: (details: AgentDiagnosticDetails) => void;
}

/**
 * B 层通道直调分发：channel → 逐通道转录的 sidecar 路由语义。
 * 未知通道不进入本分发（注册面只登记 AGENT_DIRECT_INVOKE_CHANNELS 清单）；
 * 处理器抛出的意外错误统一 500（对齐 http-forward 网络失败兜底形态）。
 */
export async function invokeAgentDirect(
  channel: AgentDirectInvokeChannel,
  envelope: InvokeEnvelope | undefined,
  deps: AgentDirectInvokerDeps
): Promise<InvokeResult<unknown>> {
  const payload: InvokeEnvelope = envelope ?? {};
  const resolved: ResolvedDeps = {
    ...deps,
    agentKeyOf: deps.agentKeyOf ?? agentKey,
    recordDiagnostic:
      deps.recordDiagnostic ??
      ((details) => recordAgentDiagnosticDefault(deps.diagnosticLogPath?.() ?? defaultDiagnosticLogPath(), details))
  };
  try {
    switch (channel) {
      case "op:agent:model:set": return await invokeModelSet(payload, resolved);
      case "op:agent:runtime": return await invokeRuntime(payload, resolved);
      case "op:agent:pending": return await invokePending(payload, resolved);
      case "op:agent:approvals": return ok({ approvals: resolved.listPendingApprovals() });
      case "op:agent:approval": return invokeApproval(payload, resolved);
      case "op:agent:approval-mode:get": return ok({ mode: resolved.getApprovalMode() });
      case "op:agent:approval-mode:set": return invokeApprovalModeSet(payload, resolved);
      case "op:agent:events-state": return await invokeEventsState(payload, resolved);
      case "op:agent:events-read": return await invokeEventsRead(payload, resolved);
    }
  } catch (error) {
    return fail(500, error instanceof Error ? error.message : String(error));
  }
}

/**
 * stream-close 直调（server L4715-4724 直推态等价）：S1 直推接管对话流事件面后，
 * app 形态不存在 /api/agent/stream SSE（直推无传输层连接），无匹配流即 {closed:0}。
 * 仅 AGENT_DOMAIN + AGENT_B_DIRECT + AGENT_EVENT_DIRECT 三 flag 同开时注册
 * （S1 未接管时本通道必须继续转发 sidecar 关闭真实 SSE）。
 */
export function invokeAgentStreamCloseDirect(): InvokeResult<unknown> {
  return ok({ closed: 0 });
}
