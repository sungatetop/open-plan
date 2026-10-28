/**
 * 智能体广场通道直调器（F6-1）：op:agents:* 4 条通道 → 进程内直调自定义 Agent
 * CRUD（server/index.mjs L2584-2601 逐点转录；行号锚点均指 server/index.mjs）。
 *
 *   - op:agents:list（L2584-2586）：{ agents: listAgents() }；
 *   - op:agents:create（L2588-2591）：result = createAgent(req.body || {}) →
 *     status = result.ok ? 201 : 400，result 整体作为响应体（成功含 agent，
 *     失败含 error）；
 *   - op:agents:update（L2593-2596）：result = updateAgent(params.id, req.body || {})
 *     → status = result.ok ? 200 : 400；
 *   - op:agents:delete（L2598-2601）：result = deleteAgent(params.id) →
 *     status = result.ok ? 200 : 400。
 *
 * 数据源：backend/agent-management.ts（listAgents/createAgent/updateAgent/
 * deleteAgent，内置 Agent 只读、自定义 Agent 写项目 .oaw 配置）。
 *
 * 门控：OP_DESKTOP_AGENTS_DIRECT 且 OP_DESKTOP_AGENT_DOMAIN 双门控（S4 语义：
 * 未设置=默认启用，=0 显式回滚）。本模块不 import electron（纯逻辑，vitest 可
 * 直接测）；注册入口在 main/index.ts。
 */
import type { InvokeEnvelope, InvokeResult } from "../../shared/protocol/channels";

/** 智能体广场的跨域依赖（生产接线传 agent-management 真实模块，测试注入桩）。 */
export interface AgentsDirectDeps {
  /** 全量 Agent 清单（backend/agent-management.ts listAgents，含内置与自定义） */
  listAgents: () => Array<Record<string, unknown>>;
  /** 新建自定义 Agent（backend/agent-management.ts createAgent） */
  createAgent: (input: Record<string, unknown>) => { ok: boolean; error?: string; agent?: Record<string, unknown> };
  /** 更新自定义 Agent（backend/agent-management.ts updateAgent） */
  updateAgent: (id: unknown, patch: Record<string, unknown>) => { ok: boolean; error?: string; agent?: Record<string, unknown> };
  /** 删除自定义 Agent（backend/agent-management.ts deleteAgent） */
  deleteAgent: (id: unknown) => { ok: boolean; error?: string; id?: string };
}

/** 智能体广场直调 invoke 通道清单（与 DESKTOP_CHANNELS 对应路由一致）。 */
export const AGENTS_DIRECT_CHANNELS = [
  "op:agents:list",
  "op:agents:create",
  "op:agents:update",
  "op:agents:delete"
] as const;

export type AgentsDirectChannel = (typeof AGENTS_DIRECT_CHANNELS)[number];

const ok = (data: unknown, status = 200): InvokeResult<unknown> => ({ ok: true, status, data });
const fail = (status: number, data: unknown): InvokeResult<unknown> => ({ ok: false, status, data } as InvokeResult<unknown>);

const bodyOf = (payload: InvokeEnvelope): Record<string, any> => (payload.body ?? {}) as Record<string, any>;

/** GET /api/agents（L2584-2586 逐点转录）。 */
function invokeList(deps: AgentsDirectDeps): InvokeResult<unknown> {
  return ok({ agents: deps.listAgents() });
}

/** POST /api/agents（L2588-2591 逐点转录：result 整体透传，ok→201 / !ok→400）。 */
function invokeCreate(payload: InvokeEnvelope, deps: AgentsDirectDeps): InvokeResult<unknown> {
  const result = deps.createAgent(bodyOf(payload));
  return result.ok ? ok(result, 201) : fail(400, result);
}

/** PATCH /api/agents/:id（L2593-2596 逐点转录：result 整体透传，ok→200 / !ok→400）。 */
function invokeUpdate(payload: InvokeEnvelope, deps: AgentsDirectDeps): InvokeResult<unknown> {
  const params = (payload.params ?? {}) as Record<string, string>;
  const result = deps.updateAgent(params.id, bodyOf(payload));
  return result.ok ? ok(result) : fail(400, result);
}

/** DELETE /api/agents/:id（L2598-2601 逐点转录：result 整体透传，ok→200 / !ok→400）。 */
function invokeDelete(payload: InvokeEnvelope, deps: AgentsDirectDeps): InvokeResult<unknown> {
  const params = (payload.params ?? {}) as Record<string, string>;
  const result = deps.deleteAgent(params.id);
  return result.ok ? ok(result) : fail(400, result);
}

/**
 * 智能体广场直调分发入口：ipcMain.handle 注册侧调用（main/index.ts
 * registerAgentsDirectInvokers）。全部路由均为同步域调用，异常面与 server 一致。
 */
export function invokeAgentsDirect(
  channel: string,
  payload: InvokeEnvelope | undefined,
  deps: AgentsDirectDeps
): InvokeResult<unknown> {
  const envelope: InvokeEnvelope = payload ?? {};
  switch (channel as AgentsDirectChannel) {
    case "op:agents:list":
      return invokeList(deps);
    case "op:agents:create":
      return invokeCreate(envelope, deps);
    case "op:agents:update":
      return invokeUpdate(envelope, deps);
    case "op:agents:delete":
      return invokeDelete(envelope, deps);
    default:
      return fail(404, { error: `unknown channel: ${channel}` });
  }
}
