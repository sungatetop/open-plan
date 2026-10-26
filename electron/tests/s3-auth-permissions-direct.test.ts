/**
 * C-2 凭据与权限族直调对拍（agent-auth-permissions-direct.ts 编排层）。
 *
 * 覆盖面（行号锚点均指 server/index.mjs）：
 *   - manifest 锚点：op:agent:auth* / op:agent:permissions* 5 通道全部在
 *     DESKTOP_CHANNELS 且路由指向已审计路径；unknown channel → 404；
 *   - 逐通道编排语义（deps 全注入桩，provider-auth/approval-policy 域行为由
 *     b6 系列对拍覆盖）：auth:get 掩码投影（maskKey L1963-1966 边界：≤8 → ****，
 *     >8 → 前3+****+后4）+ authErrors 透传 / auth:save 校验 400 与 setApiKey 透传 /
 *     auth:remove 校验 400 与无 try/catch 忠实转录（抛错走 dispatcher 500）/
 *     permissions:get 原样响应无包裹 / permissions:rule:remove ok?200:409。
 *
 * 本文件为纯编排测试：不加载 provider-auth/approval-policy 域实现（无 env 隔离需求）。
 */
import { describe, expect, test, beforeAll, vi } from "vitest";
import type * as AuthPermModule from "../src/main/ipc/agent-auth-permissions-direct";
import { DESKTOP_CHANNELS, type InvokeEnvelope } from "../src/shared/protocol/channels";

type AuthPerm = typeof AuthPermModule;
let svc: AuthPerm;

beforeAll(async () => {
  svc = await import("../src/main/ipc/agent-auth-permissions-direct");
});

/** deps 桩：provider-auth / agent-errors / approval-policy 三域注入面。 */
function makeDeps(overrides: Partial<AuthPermModule.AgentAuthPermissionsDirectDeps> = {}): AuthPermModule.AgentAuthPermissionsDirectDeps & {
  setApiKey: ReturnType<typeof vi.fn>;
  removeApiKey: ReturnType<typeof vi.fn>;
  removeUserRule: ReturnType<typeof vi.fn>;
} {
  const deps = {
    listAuth: vi.fn(() => ({ deepseek: { type: "api_key", key: "sk-1234567890abcdef" }, qwen: { type: "api_key", key: "short" } })),
    setApiKey: vi.fn(async () => ({ ok: true, providers: ["deepseek"] })),
    removeApiKey: vi.fn(async () => ({ ok: true, providers: [] })),
    getCredentialErrors: vi.fn(() => ({ deepseek: { at: "T0", message: "凭据无效" } })),
    listPermissionRules: vi.fn(() => ({ mode: "ask", defaults: [], user: [{ tool: "bash", pattern: "git *", action: "allow" }] })),
    removeUserRule: vi.fn(() => ({ ok: true, removed: 1 })),
    ...overrides
  };
  return deps as never;
}

function invoke(channel: AuthPermModule.AgentAuthPermissionsDirectChannel, envelope: InvokeEnvelope | undefined, deps = makeDeps()) {
  return svc.invokeAgentAuthPermissionsDirect(channel, envelope, deps);
}

describe("C-2 manifest 锚点", () => {
  test("5 条通道全部在 DESKTOP_CHANNELS 且路由指向已审计路径", () => {
    expect(svc.AGENT_AUTH_PERMISSIONS_DIRECT_CHANNELS).toHaveLength(5);
    const expectedRoutes: Record<string, { method: string; path: string }> = {
      "op:agent:auth:get": { method: "GET", path: "/api/agent/auth" },
      "op:agent:auth:save": { method: "POST", path: "/api/agent/auth" },
      "op:agent:auth:remove": { method: "POST", path: "/api/agent/auth/remove" },
      "op:agent:permissions:get": { method: "GET", path: "/api/agent/permissions" },
      "op:agent:permissions:rule:remove": { method: "DELETE", path: "/api/agent/permissions/rule" }
    };
    for (const channel of svc.AGENT_AUTH_PERMISSIONS_DIRECT_CHANNELS) {
      expect(DESKTOP_CHANNELS[channel as keyof typeof DESKTOP_CHANNELS]).toEqual(expectedRoutes[channel]);
    }
  });

  test("unknown channel → 404（注册面只登记清单内通道）", async () => {
    const result = await svc.invokeAgentAuthPermissionsDirect("op:agent:auth:list" as never, {}, makeDeps());
    expect(result).toEqual({ ok: false, status: 404, data: { error: "unknown channel: op:agent:auth:list" } });
  });
});

describe("C-2 op:agent:auth:get（server L1968-1976，maskKey L1963-1966）", () => {
  test("凭据掩码投影：>8 前3+****+后4，≤8 ****；type/set 透传 + authErrors", async () => {
    const result = await invoke("op:agent:auth:get", {});
    expect(result).toEqual({
      ok: true,
      status: 200,
      data: {
        providers: {
          deepseek: { type: "api_key", masked: "sk-****cdef", set: true },
          qwen: { type: "api_key", masked: "****", set: true }
        },
        authErrors: { deepseek: { at: "T0", message: "凭据无效" } }
      }
    });
  });

  test("maskKey 边界：恰好 8 字符 → ****；9 字符 → 前3+****+后4；空 key → ****", async () => {
    const deps = makeDeps({
      listAuth: vi.fn(() => ({
        a: { type: "api_key", key: "12345678" },
        b: { type: "api_key", key: "123456789" },
        c: { type: "api_key", key: "" }
      })),
      getCredentialErrors: vi.fn(() => ({}))
    });
    const result = await invoke("op:agent:auth:get", {}, deps);
    const providers = (result.data as any).providers;
    expect(providers.a.masked).toBe("****");
    expect(providers.b.masked).toBe("123****6789");
    expect(providers.c.masked).toBe("****");
  });

  test("listAuth 抛错（无 try/catch 忠实转录）→ dispatcher 500", async () => {
    const deps = makeDeps({ listAuth: vi.fn(() => { throw new Error("凭据文件损坏"); }) });
    const result = await invoke("op:agent:auth:get", {}, deps);
    expect(result).toEqual({ ok: false, status: 500, data: { error: "凭据文件损坏" } });
  });
});

describe("C-2 op:agent:auth:save（server L1978-1986）", () => {
  test("缺 provider 或 key → 400 {error}（无 code 字段，忠实转录）", async () => {
    expect(await invoke("op:agent:auth:save", { body: {} })).toEqual({ ok: false, status: 400, data: { error: "provider and key required" } });
    expect(await invoke("op:agent:auth:save", { body: { provider: "deepseek" } })).toEqual({ ok: false, status: 400, data: { error: "provider and key required" } });
    expect(await invoke("op:agent:auth:save", { body: { key: "sk-x" } })).toEqual({ ok: false, status: 400, data: { error: "provider and key required" } });
  });

  test("成功 → setApiKey(provider, key) 透传调用，响应原样；抛错 → 500 {error}（无 code）", async () => {
    const deps = makeDeps();
    const result = await invoke("op:agent:auth:save", { body: { provider: "deepseek", key: "sk-new" } }, deps);
    expect(deps.setApiKey).toHaveBeenCalledWith("deepseek", "sk-new");
    expect(result).toEqual({ ok: true, status: 200, data: { ok: true, providers: ["deepseek"] } });

    const errDeps = makeDeps({ setApiKey: vi.fn(async () => { throw new Error("写入失败"); }) });
    const failed = await invoke("op:agent:auth:save", { body: { provider: "deepseek", key: "sk-new" } }, errDeps);
    expect(failed).toEqual({ ok: false, status: 500, data: { error: "写入失败" } });
  });
});

describe("C-2 op:agent:auth:remove（server L1988-1992）", () => {
  test("缺 provider → 400；成功 → removeApiKey 透传，响应原样；抛错走 dispatcher 500（无 try/catch 忠实转录）", async () => {
    expect(await invoke("op:agent:auth:remove", { body: {} })).toEqual({ ok: false, status: 400, data: { error: "provider required" } });

    const deps = makeDeps();
    const result = await invoke("op:agent:auth:remove", { body: { provider: "deepseek" } }, deps);
    expect(deps.removeApiKey).toHaveBeenCalledWith("deepseek");
    expect(result).toEqual({ ok: true, status: 200, data: { ok: true, providers: [] } });

    const errDeps = makeDeps({ removeApiKey: vi.fn(async () => { throw new Error("删除失败"); }) });
    const failed = await invoke("op:agent:auth:remove", { body: { provider: "deepseek" } }, errDeps);
    expect(failed).toEqual({ ok: false, status: 500, data: { error: "删除失败" } });
  });
});

describe("C-2 op:agent:permissions:get / rule:remove（server L4006-4014）", () => {
  test("get：listPermissionRules 原样响应（mode/defaults/user 平铺，无包裹）", async () => {
    const result = await invoke("op:agent:permissions:get", {});
    expect(result).toEqual({
      ok: true,
      status: 200,
      data: { mode: "ask", defaults: [], user: [{ tool: "bash", pattern: "git *", action: "allow" }] }
    });
  });

  test("rule:remove：ok → 200 result 原样；!ok → 409 result 整体透传", async () => {
    const deps = makeDeps();
    const body = { tool: "bash", pattern: "git *" };
    const result = await invoke("op:agent:permissions:rule:remove", { body }, deps);
    expect(deps.removeUserRule).toHaveBeenCalledWith(body);
    expect(result).toEqual({ ok: true, status: 200, data: { ok: true, removed: 1 } });

    const failDeps = makeDeps({ removeUserRule: vi.fn(() => ({ ok: false, error: "规则不存在" })) });
    const failed = await invoke("op:agent:permissions:rule:remove", { body }, failDeps);
    expect(failed).toEqual({ ok: false, status: 409, data: { ok: false, error: "规则不存在" } });
  });
});
