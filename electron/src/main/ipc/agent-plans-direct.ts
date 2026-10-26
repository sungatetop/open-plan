/**
 * 套餐族通道直调器（C-1，迁移期过渡形态）：op:agent:plans* → 进程内直调套餐目录域。
 *
 * 旧路径：渲染层 invoke → http-forward 转发 sidecar HTTP（/api/agent/plans*）。
 * 本模块把套餐族 4 条通道的 sidecar 路由编排逐点转录为主进程内直调
 * （行号锚点均指 server/index.mjs）：
 *   - op:agent:plans（L2316-2322）：套餐预设清单；
 *   - op:agent:plans:models（L2324-2331）：按 planId 拉取模型列表（远端 API）；
 *   - op:agent:plans:apply（L2333-2342）：应用套餐 → 重置模型运行时 → 附带配置状态；
 *   - op:agent:plans:disconnect（L2344-2353）：断开套餐 → 重置模型运行时。
 *
 * 数据源：backend/plan-catalog.ts（B2 域对拍覆盖）+ piRuntimeManager.resetModelRuntime
 * （模型目录缓存失效，进程内单例态）+ getConfigStatus（backend/agent/pi-config-management.ts，
 * 文件族共享态）——均无 live 会话态依赖，与 S2/S3 各族同批口径。
 *
 * 错误体形状忠实转录（http-forward 非 2xx 同形：data = 服务端 JSON 错误体）：
 *   - list/models/apply/disconnect 的 catch 分支错误体带 code 字段；
 *   - apply/disconnect 的业务失败（!result.ok）原样透传 result 整体（400）。
 *
 * 门控：OP_DESKTOP_AGENT_PLANS_DIRECT 且 OP_DESKTOP_AGENT_DOMAIN 双门控（S4 起默认开，
 * =0 显式回滚——流量切换评估方案 §4-S4）。本模块不 import electron（纯逻辑，vitest 可直接测）；
 * 注册入口在 main/index.ts。
 */
import type { ChannelFailureData, InvokeEnvelope, InvokeResult } from "../../shared/protocol/channels";

/** 套餐族编排的跨域依赖（生产接线传 backend 真实模块，测试注入桩）。 */
export interface AgentPlansDirectDeps {
  /** 套餐目录域（backend/plan-catalog.ts） */
  listPlans: () => unknown;
  fetchPlanModels: (planId: unknown) => Promise<unknown>;
  applyPlan: (body: unknown) => Promise<any>;
  disconnectPlan: (body: unknown) => any;
  /** 模型运行时缓存失效（agent/pi-runtime.ts piRuntimeManager.resetModelRuntime） */
  resetModelRuntime: () => unknown;
  /** 配置状态（backend/agent/pi-config-management.ts getConfigStatus） */
  getConfigStatus: () => unknown;
}

/** 套餐族直调 invoke 通道清单（与 DESKTOP_CHANNELS 的 op:agent:plans* 一致）。 */
export const AGENT_PLANS_DIRECT_CHANNELS = [
  "op:agent:plans",
  "op:agent:plans:models",
  "op:agent:plans:apply",
  "op:agent:plans:disconnect"
] as const;

export type AgentPlansDirectChannel = (typeof AGENT_PLANS_DIRECT_CHANNELS)[number];

const ok = (data: unknown): InvokeResult<unknown> => ({ ok: true, status: 200, data });

/** 非 2xx 信封（http-forward 非 2xx 同形：data = 服务端 JSON 错误体，含 code 等字段）。 */
const fail = (status: number, data: unknown): InvokeResult<unknown> => ({
  ok: false,
  status,
  data: data as ChannelFailureData
});

function bodyOf(payload: InvokeEnvelope): Record<string, any> {
  const body = payload.body;
  return body && typeof body === "object" ? (body as Record<string, any>) : {};
}

function queryOf(payload: InvokeEnvelope): Record<string, any> {
  return (payload.query ?? {}) as Record<string, any>;
}

/** GET /api/agent/plans（server L2316-2322 逐点转录）。 */
function invokePlansList(_payload: InvokeEnvelope, deps: AgentPlansDirectDeps): InvokeResult<unknown> {
  try {
    return ok({ plans: deps.listPlans() });
  } catch (error: any) {
    return fail(500, { error: error.message, code: "PLANS_FAILED" });
  }
}

/** GET /api/agent/plans/models（server L2324-2331 逐点转录）。 */
async function invokePlansModels(payload: InvokeEnvelope, deps: AgentPlansDirectDeps): Promise<InvokeResult<unknown>> {
  try {
    const query = queryOf(payload);
    const models = await deps.fetchPlanModels(String(query.planId || ""));
    return ok({ models });
  } catch (error: any) {
    return fail(502, { error: error.message, code: "PLAN_MODELS_FAILED" });
  }
}

/** POST /api/agent/plans/apply（server L2333-2342 逐点转录）。 */
async function invokePlansApply(payload: InvokeEnvelope, deps: AgentPlansDirectDeps): Promise<InvokeResult<unknown>> {
  try {
    const result = await deps.applyPlan(bodyOf(payload));
    if (!result.ok) return fail(400, result);
    deps.resetModelRuntime();
    return ok({ ...result, status: deps.getConfigStatus() });
  } catch (error: any) {
    return fail(500, { ok: false, error: error.message, code: "PLAN_APPLY_FAILED" });
  }
}

/** POST /api/agent/plans/disconnect（server L2344-2353 逐点转录）。 */
function invokePlansDisconnect(payload: InvokeEnvelope, deps: AgentPlansDirectDeps): InvokeResult<unknown> {
  try {
    const result = deps.disconnectPlan(bodyOf(payload));
    if (!result.ok) return fail(400, result);
    deps.resetModelRuntime();
    return ok(result);
  } catch (error: any) {
    return fail(500, { ok: false, error: error.message, code: "PLAN_DISCONNECT_FAILED" });
  }
}

/**
 * 套餐族通道直调分发：channel → 逐通道转录的 sidecar 路由编排。
 * 未知通道不进入本分发（注册面只登记 AGENT_PLANS_DIRECT_CHANNELS 清单）；
 * 处理器抛出的意外错误统一 500（对齐 http-forward 网络失败兜底形态）。
 */
export async function invokeAgentPlansDirect(
  channel: AgentPlansDirectChannel,
  envelope: InvokeEnvelope | undefined,
  deps: AgentPlansDirectDeps
): Promise<InvokeResult<unknown>> {
  const payload: InvokeEnvelope = envelope ?? {};
  switch (channel) {
    case "op:agent:plans": return invokePlansList(payload, deps);
    case "op:agent:plans:models": return await invokePlansModels(payload, deps);
    case "op:agent:plans:apply": return await invokePlansApply(payload, deps);
    case "op:agent:plans:disconnect": return invokePlansDisconnect(payload, deps);
  }
  return fail(404, { error: `unknown channel: ${channel}` });
}
