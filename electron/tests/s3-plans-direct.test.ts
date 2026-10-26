/**
 * C-1 套餐族直调对拍（agent-plans-direct.ts 编排层）。
 *
 * 覆盖面（行号锚点均指 server/index.mjs）：
 *   - manifest 锚点：op:agent:plans* 4 通道全部在 DESKTOP_CHANNELS 且路由指向已审计路径；
 *   - 逐通道编排语义（deps 全注入桩，plan-catalog 域行为由 b2-plan-catalog 对拍覆盖）：
 *     plans list（{plans} 包裹 / 500 code 错误体无 ok 字段）/ models（planId String 化
 *     缺省空串 / 502 code）/ apply（body 透传 / !ok 400 整体透传 / 成功路径 reset→status
 *     调用序与展开形态 / 500 code）/ disconnect（同步语义 / 成功 result 原样不包 status /
 *     500 code）/ dispatcher（unknown channel 404）。
 *
 * 本文件为纯编排测试：不加载 plan-catalog/pi-runtime/pi-config-management 域实现
 * （无 env 隔离需求），域行为由各域自有对拍覆盖。
 */
import { describe, expect, test, beforeAll, vi } from "vitest";
import type * as PlansDirectModule from "../src/main/ipc/agent-plans-direct";
import { DESKTOP_CHANNELS, type InvokeEnvelope } from "../src/shared/protocol/channels";

type PlansDirect = typeof PlansDirectModule;
let svc: PlansDirect;

beforeAll(async () => {
  svc = await import("../src/main/ipc/agent-plans-direct");
});

/** deps 桩：plan-catalog / pi-runtime / pi-config 三域注入面。 */
function makeDeps(overrides: Partial<PlansDirectModule.AgentPlansDirectDeps> = {}): PlansDirectModule.AgentPlansDirectDeps & {
  resetModelRuntime: ReturnType<typeof vi.fn>;
  getConfigStatus: ReturnType<typeof vi.fn>;
} {
  const deps = {
    listPlans: vi.fn(() => [{ id: "pro", name: "Pro 套餐" }]),
    fetchPlanModels: vi.fn(async () => [{ id: "m1" }]),
    applyPlan: vi.fn(async () => ({ ok: true, applied: "pro" })),
    disconnectPlan: vi.fn(() => ({ ok: true, disconnected: "pro" })),
    resetModelRuntime: vi.fn(() => undefined),
    getConfigStatus: vi.fn(() => ({ provider: "pro", defaultModel: "pro/m1" })),
    ...overrides
  };
  return deps as never;
}

function invoke(channel: PlansDirectModule.AgentPlansDirectChannel, envelope: InvokeEnvelope | undefined, deps = makeDeps()) {
  return svc.invokeAgentPlansDirect(channel, envelope, deps);
}

describe("C-1 manifest 锚点", () => {
  test("4 条通道全部在 DESKTOP_CHANNELS 且路由指向 /api/agent/plans* 已审计路径", () => {
    expect(svc.AGENT_PLANS_DIRECT_CHANNELS).toHaveLength(4);
    const expectedRoutes: Record<string, { method: string; path: string }> = {
      "op:agent:plans": { method: "GET", path: "/api/agent/plans" },
      "op:agent:plans:models": { method: "GET", path: "/api/agent/plans/models" },
      "op:agent:plans:apply": { method: "POST", path: "/api/agent/plans/apply" },
      "op:agent:plans:disconnect": { method: "POST", path: "/api/agent/plans/disconnect" }
    };
    for (const channel of svc.AGENT_PLANS_DIRECT_CHANNELS) {
      expect(DESKTOP_CHANNELS[channel as keyof typeof DESKTOP_CHANNELS]).toEqual(expectedRoutes[channel]);
    }
  });

  test("unknown channel → 404（注册面只登记清单内通道）", async () => {
    const result = await svc.invokeAgentPlansDirect("op:agent:plans:unknown" as never, {}, makeDeps());
    expect(result).toEqual({ ok: false, status: 404, data: { error: "unknown channel: op:agent:plans:unknown" } });
  });
});

describe("C-1 op:agent:plans（server L2316-2322）", () => {
  test("listPlans 结果以 { plans } 包裹", async () => {
    const result = await invoke("op:agent:plans", {});
    expect(result).toEqual({ ok: true, status: 200, data: { plans: [{ id: "pro", name: "Pro 套餐" }] } });
  });

  test("listPlans 抛错 → 500 错误体 { error, code }（无 ok 字段，忠实转录）", async () => {
    const deps = makeDeps({ listPlans: vi.fn(() => { throw new Error("目录读取失败"); }) });
    const result = await invoke("op:agent:plans", {}, deps);
    expect(result).toEqual({ ok: false, status: 500, data: { error: "目录读取失败", code: "PLANS_FAILED" } });
  });
});

describe("C-1 op:agent:plans:models（server L2324-2331）", () => {
  test("query.planId String 化透传；缺参 → 空串", async () => {
    const deps = makeDeps();
    await invoke("op:agent:plans:models", { query: { planId: "pro" } }, deps);
    expect(deps.fetchPlanModels).toHaveBeenCalledWith("pro");
    await invoke("op:agent:plans:models", {}, deps);
    expect(deps.fetchPlanModels).toHaveBeenLastCalledWith("");
    expect(deps.fetchPlanModels).toHaveBeenLastCalledWith(expect.any(String));
  });

  test("成功 → { models }；抛错 → 502 { error, code: PLAN_MODELS_FAILED }", async () => {
    const okResult = await invoke("op:agent:plans:models", { query: { planId: "pro" } });
    expect(okResult).toEqual({ ok: true, status: 200, data: { models: [{ id: "m1" }] } });
    const deps = makeDeps({ fetchPlanModels: vi.fn(async () => { throw new Error("上游超时"); }) });
    const result = await invoke("op:agent:plans:models", { query: { planId: "pro" } }, deps);
    expect(result).toEqual({ ok: false, status: 502, data: { error: "上游超时", code: "PLAN_MODELS_FAILED" } });
  });
});

describe("C-1 op:agent:plans:apply（server L2333-2342）", () => {
  test("body 整体透传 applyPlan；成功 → reset 先于 getConfigStatus，响应 { ...result, status }", async () => {
    const deps = makeDeps();
    const order: string[] = [];
    deps.resetModelRuntime.mockImplementation(() => { order.push("reset"); return undefined; });
    deps.getConfigStatus.mockImplementation(() => { order.push("status"); return { provider: "pro" }; });
    const body = { planId: "pro", apiKey: "sk-x", modelIds: ["m1"] };
    const result = await invoke("op:agent:plans:apply", { body }, deps);
    expect(deps.applyPlan).toHaveBeenCalledWith(body);
    expect(order).toEqual(["reset", "status"]);
    expect(result).toEqual({ ok: true, status: 200, data: { ok: true, applied: "pro", status: { provider: "pro" } } });
  });

  test("!result.ok → 400 且 result 整体透传（不重包），不触发 reset", async () => {
    const deps = makeDeps({ applyPlan: vi.fn(async () => ({ ok: false, error: "套餐不可用", code: "PLAN_INVALID" })) });
    const result = await invoke("op:agent:plans:apply", { body: { planId: "bad" } }, deps);
    expect(result).toEqual({ ok: false, status: 400, data: { ok: false, error: "套餐不可用", code: "PLAN_INVALID" } });
    expect(deps.resetModelRuntime).not.toHaveBeenCalled();
    expect(deps.getConfigStatus).not.toHaveBeenCalled();
  });

  test("applyPlan 抛错 → 500 { ok:false, error, code: PLAN_APPLY_FAILED }", async () => {
    const deps = makeDeps({ applyPlan: vi.fn(async () => { throw new Error("写入失败"); }) });
    const result = await invoke("op:agent:plans:apply", { body: { planId: "pro" } }, deps);
    expect(result).toEqual({ ok: false, status: 500, data: { ok: false, error: "写入失败", code: "PLAN_APPLY_FAILED" } });
    expect(deps.resetModelRuntime).not.toHaveBeenCalled();
  });
});

describe("C-1 op:agent:plans:disconnect（server L2344-2353）", () => {
  test("同步语义：body 透传；成功 → reset 调用且 result 原样响应（不附 status）", async () => {
    const deps = makeDeps();
    const body = { planId: "pro" };
    const result = await invoke("op:agent:plans:disconnect", { body }, deps);
    expect(deps.disconnectPlan).toHaveBeenCalledWith(body);
    expect(deps.resetModelRuntime).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, status: 200, data: { ok: true, disconnected: "pro" } });
  });

  test("!result.ok → 400 整体透传，不触发 reset；抛错 → 500 { ok:false, error, code: PLAN_DISCONNECT_FAILED }", async () => {
    const failDeps = makeDeps({ disconnectPlan: vi.fn(() => ({ ok: false, error: "未接入套餐" })) });
    const failed = await invoke("op:agent:plans:disconnect", { body: {} }, failDeps);
    expect(failed).toEqual({ ok: false, status: 400, data: { ok: false, error: "未接入套餐" } });
    expect(failDeps.resetModelRuntime).not.toHaveBeenCalled();

    const throwDeps = makeDeps({ disconnectPlan: vi.fn(() => { throw new Error("清理失败"); }) });
    const thrown = await invoke("op:agent:plans:disconnect", { body: {} }, throwDeps);
    expect(thrown).toEqual({ ok: false, status: 500, data: { ok: false, error: "清理失败", code: "PLAN_DISCONNECT_FAILED" } });
  });
});
