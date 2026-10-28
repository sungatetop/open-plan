/**
 * 工作流域通道直调器（F6-1）：op:workflows:* 3 条通道 → 进程内直调声明式工作流
 * 注册表与领域工作流预检（server/index.mjs L2536-2581 逐点转录；行号锚点均指
 * server/index.mjs）。
 *
 *   - op:workflows:list（L2536-2549）：{ workflows: listWorkflows(scanSkills()) }；
 *     flag domainWorkflows 开启时追加只读 domain 字段：`await 列出工作流()` 后逐项
 *     剥离 文件 字段（`({ 文件, ...声明 }) => 声明`）；registry 导入失败时 domain=[]
 *     且 domainError=String(error)——既有 workflows 结构不变（开关默认关）。
 *     旧侧无 try/catch 包裹 listWorkflows 本体：域函数抛错时 Express 4 对 rejected
 *     async handler 挂起响应；IPC 直调形态异常沿 dispatcher 传播（形态差异不属减配，
 *     与 kb-direct 头注释同口径）。
 *   - op:workflows:validate（L2551-2555）：getWorkflow(params.id, scanSkills()) →
 *     !workflow 404 { ok:false, error:"workflow not found" } → { ok: workflow.valid,
 *     workflow, message: valid ? "工作流依赖完整" : `缺少技能：${missing.join(", ")}` }。
 *   - op:workflows:preflight（L2560-2581）：!flag → 404 { ok:false, error:"领域工作流
 *     未启用" }（开关关闭时该路径不可见，前端也不渲染入口）；workflowId trim 空判
 *     400 { ok:false, error:"缺少 workflowId" } → 取工作流 → !workflow 404 "工作流
 *     不存在" → 运行预检(workflow, {坐标点,记录数,写回,产物路径}, {跳过校验: body.跳过
 *     校验 === true}) → { ok:true, workflow:{id,title}, 预检 }；catch → 500
 *     { ok:false, error }。
 *
 * 数据源：backend/agent/workflows.ts（listWorkflows/getWorkflow）+
 * backend/agent/skills-catalog.ts（scanSkills）+ backend/workflow-registry.ts
 * （列出工作流/取工作流）+ backend/workflow-validation.ts（运行预检）。
 *
 * 门控：OP_DESKTOP_WORKFLOWS_DIRECT 且 OP_DESKTOP_AGENT_DOMAIN 双门控（S4 语义：未设置=
 * 默认启用，=0 显式回滚）。本模块不 import electron（纯逻辑，vitest 可直接测）；
 * 注册入口在 main/index.ts。
 */
import type { InvokeEnvelope, InvokeResult } from "../../shared/protocol/channels";

/** 工作流域编排的跨域依赖（生产接线传 backend 真实模块，测试注入桩）。 */
export interface WorkflowsDirectDeps {
  /** 声明式工作流视图（backend/agent/workflows.ts listWorkflows） */
  listWorkflows: (skills: Array<{ name?: unknown } | string>) => Array<Record<string, unknown>>;
  /** 按 id 取工作流视图（backend/agent/workflows.ts getWorkflow，未命中 null） */
  getWorkflow: (id: unknown, skills: Array<{ name?: unknown } | string>) => Record<string, unknown> | null;
  /** 技能目录扫描（backend/agent/skills-catalog.ts scanSkills） */
  scanSkills: () => Array<Record<string, unknown>>;
  /** §4 领域工作流开关（feature-flags RUNTIME_FLAGS.domainWorkflows，默认关） */
  domainWorkflowsEnabled: () => boolean;
  /** 领域工作流声明清单（backend/workflow-registry.ts 列出工作流，含内部 文件 字段） */
  listDomainWorkflows: () => Promise<Array<Record<string, unknown>>>;
  /** 按 id 取领域工作流（backend/workflow-registry.ts 取工作流，未命中 null） */
  getDomainWorkflow: (id: unknown) => Promise<Record<string, unknown> | null>;
  /** 预检试算（backend/workflow-validation.ts 运行预检，纯函数只读） */
  runPreflight: (workflow: unknown, context: unknown, options: unknown) => Record<string, unknown>;
}

/** 工作流域直调 invoke 通道清单（与 DESKTOP_CHANNELS 对应路由一致）。 */
export const WORKFLOWS_DIRECT_CHANNELS = [
  "op:workflows:list",
  "op:workflows:validate",
  "op:workflows:preflight"
] as const;

export type WorkflowsDirectChannel = (typeof WORKFLOWS_DIRECT_CHANNELS)[number];

const ok = (data: unknown): InvokeResult<unknown> => ({ ok: true, status: 200, data });
const fail = (status: number, data: unknown): InvokeResult<unknown> => ({ ok: false, status, data } as InvokeResult<unknown>);

const bodyOf = (payload: InvokeEnvelope): Record<string, any> => (payload.body ?? {}) as Record<string, any>;
const queryOf = (payload: InvokeEnvelope): Record<string, string | undefined> => (payload.query ?? {}) as Record<string, string | undefined>;

/** GET /api/workflows（L2536-2549 逐点转录：domain 字段仅开关开启时追加，失败静默置空+错误说明）。 */
async function invokeList(deps: WorkflowsDirectDeps): Promise<InvokeResult<unknown>> {
  const payload: Record<string, unknown> = { workflows: deps.listWorkflows(deps.scanSkills()) };
  // §4 领域工作流（Qoder 对标）：默认关，仅追加只读 domain 字段，既有 workflows 结构不变。
  if (deps.domainWorkflowsEnabled()) {
    try {
      const declared = await deps.listDomainWorkflows();
      payload.domain = declared.map(({ 文件: _文件, ...声明 }) => 声明);
    } catch (error) {
      payload.domain = [];
      payload.domainError = String((error as { message?: unknown })?.message || error);
    }
  }
  return ok(payload);
}

/** GET /api/workflows/:id/validate（L2551-2555 逐点转录：!workflow 404；message 随 valid 分叉）。 */
function invokeValidate(payload: InvokeEnvelope, deps: WorkflowsDirectDeps): InvokeResult<unknown> {
  const params = (payload.params ?? {}) as Record<string, string>;
  const workflow = deps.getWorkflow(params.id, deps.scanSkills());
  if (!workflow) return fail(404, { ok: false, error: "workflow not found" });
  const valid = Boolean((workflow as { valid?: unknown }).valid);
  const missing = (workflow as { missing?: string[] }).missing || [];
  return ok({
    ok: valid,
    workflow,
    message: valid ? "工作流依赖完整" : `缺少技能：${missing.join(", ")}`
  });
}

/** POST /api/domain-workflows/preflight（L2560-2561 / L2563 / L2569-2580 逐点转录：
 * 开关关 404 / workflowId 空 400 / 未命中 404 / 运行预检只读 / catch 500）。 */
async function invokePreflight(payload: InvokeEnvelope, deps: WorkflowsDirectDeps): Promise<InvokeResult<unknown>> {
  if (!deps.domainWorkflowsEnabled()) return fail(404, { ok: false, error: "领域工作流未启用" });
  const body = bodyOf(payload);
  const workflowId = String(body.workflowId || "").trim();
  if (!workflowId) return fail(400, { ok: false, error: "缺少 workflowId" });
  try {
    const workflow = await deps.getDomainWorkflow(workflowId);
    if (!workflow) return fail(404, { ok: false, error: "工作流不存在" });
    const 预检 = deps.runPreflight(workflow, {
      坐标点: body.坐标点,
      记录数: body.记录数,
      写回: body.写回,
      产物路径: body.产物路径
    }, { 跳过校验: body.跳过校验 === true });
    return ok({
      ok: true,
      workflow: { id: (workflow as { id?: unknown }).id, title: (workflow as { title?: unknown }).title },
      预检
    });
  } catch (error) {
    return fail(500, { ok: false, error: String((error as { message?: unknown })?.message || error) });
  }
}

/**
 * 工作流域直调分发入口：ipcMain.handle 注册侧调用（main/index.ts registerWorkflowsDirectInvokers）。
 * list 路由的 listWorkflows 本体异常沿本函数传播（见头注释形态差异声明）。
 */
export async function invokeWorkflowsDirect(
  channel: string,
  payload: InvokeEnvelope | undefined,
  deps: WorkflowsDirectDeps
): Promise<InvokeResult<unknown>> {
  const envelope: InvokeEnvelope = payload ?? {};
  switch (channel as WorkflowsDirectChannel) {
    case "op:workflows:list":
      return invokeList(deps);
    case "op:workflows:validate":
      return invokeValidate(envelope, deps);
    case "op:workflows:preflight":
      return invokePreflight(envelope, deps);
    default:
      return fail(404, { error: `unknown channel: ${channel}` });
  }
}
