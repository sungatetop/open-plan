/**
 * C-5 网络设置族直调对拍（agent-network-settings-direct.ts 编排层）。
 *
 * 覆盖面（行号锚点均指 server/index.mjs）：
 *   - manifest 锚点：2 通道全部在 DESKTOP_CHANNELS 且路由指向已审计路径；unknown → 404；
 *   - GET（L2376-2382）：投影透传 / 抛错 → 500 { error, code }（无 ok:false，忠实转录）；
 *   - PATCH（L2384-2399）：mode 三值校验（大小写归一）/ manual 缺代理的
 *     keepExistingProxy × hasProxy 判定矩阵 / preserveProxy 透传 / 成功响应
 *     { ...saved, runtime } 拼接 / catch → 500 NETWORK_SETTINGS_SAVE_FAILED。
 *
 * 本文件为纯编排测试：不加载 pi-config-management 等域实现（无 env 隔离需求）。
 */
import { describe, expect, test, beforeAll, vi } from "vitest";
import type * as NetworkSettingsModule from "../src/main/ipc/agent-network-settings-direct";
import { DESKTOP_CHANNELS, type InvokeEnvelope } from "../src/shared/protocol/channels";

type NetworkSettings = typeof NetworkSettingsModule;
let svc: NetworkSettings;

beforeAll(async () => {
  svc = await import("../src/main/ipc/agent-network-settings-direct");
});

/** deps 桩：pi-config-management 读写族 + pi-runtime 运行时应用注入。 */
function makeDeps(overrides: Partial<NetworkSettingsModule.AgentNetworkSettingsDirectDeps> = {}) {
  const deps = {
    readNetworkSettings: vi.fn(() => ({ mode: "direct", proxy: "", hasProxy: false, proxyUrl: "", httpProxy: "", httpsProxy: "", noProxy: [] })),
    saveNetworkSettings: vi.fn((_value: unknown, _options: { preserveProxy?: boolean }) => ({ mode: "manual", proxy: "http://127.0.0.1:7890", hasProxy: true })),
    loadNetworkSettings: vi.fn(() => ({ mode: "manual", proxyUrl: "http://127.0.0.1:7890" })),
    updateNetworkSettings: vi.fn((settings: Record<string, any>) => ({ mode: settings?.mode, proxyWorks: true, notes: [] })),
    ...overrides
  };
  return deps as never as NetworkSettingsModule.AgentNetworkSettingsDirectDeps & {
    // 测试内需访问 vi.fn 的 mock 记录；接口签名的纯函数视图供 invoke 使用
    readNetworkSettings: ReturnType<typeof vi.fn>;
    saveNetworkSettings: ReturnType<typeof vi.fn>;
    loadNetworkSettings: ReturnType<typeof vi.fn>;
    updateNetworkSettings: ReturnType<typeof vi.fn>;
  };
}

function invoke(channel: NetworkSettingsModule.AgentNetworkSettingsDirectChannel, envelope: InvokeEnvelope | undefined, deps = makeDeps()) {
  return svc.invokeAgentNetworkSettingsDirect(channel, envelope, deps);
}

describe("C-5 manifest 锚点", () => {
  test("2 条通道全部在 DESKTOP_CHANNELS 且路由指向已审计路径", () => {
    expect(svc.AGENT_NETWORK_SETTINGS_DIRECT_CHANNELS).toHaveLength(2);
    const expectedRoutes: Record<string, { method: string; path: string }> = {
      "op:agent:network-settings:get": { method: "GET", path: "/api/agent/network-settings" },
      "op:agent:network-settings:save": { method: "PATCH", path: "/api/agent/network-settings" }
    };
    for (const channel of svc.AGENT_NETWORK_SETTINGS_DIRECT_CHANNELS) {
      expect(DESKTOP_CHANNELS[channel as keyof typeof DESKTOP_CHANNELS]).toEqual(expectedRoutes[channel]);
    }
  });

  test("unknown channel → 404", async () => {
    const result = await svc.invokeAgentNetworkSettingsDirect("op:agent:network-settings:remove" as never, {}, makeDeps());
    expect(result).toEqual({ ok: false, status: 404, data: { error: "unknown channel: op:agent:network-settings:remove" } });
  });
});

describe("C-5 op:agent:network-settings:get（L2376-2382）", () => {
  test("成功 → 透传 readNetworkSettings 脱敏投影（原样不包裹）", async () => {
    const projection = { mode: "system", proxy: "", hasProxy: false, proxyUrl: "", httpProxy: "", httpsProxy: "", noProxy: ["localhost"] };
    const result = await invoke("op:agent:network-settings:get", {}, makeDeps({ readNetworkSettings: vi.fn(() => projection) }));
    expect(result).toEqual({ ok: true, status: 200, data: projection });
  });

  test("读取抛错 → 500 { error, code: NETWORK_SETTINGS_READ_FAILED }（错误体无 ok:false，忠实转录）", async () => {
    const result = await invoke("op:agent:network-settings:get", {}, makeDeps({ readNetworkSettings: vi.fn(() => { throw new Error("网络配置损坏"); }) }));
    expect(result).toEqual({ ok: false, status: 500, data: { error: "网络配置损坏", code: "NETWORK_SETTINGS_READ_FAILED" } });
  });
});

describe("C-5 op:agent:network-settings:save（L2384-2399）", () => {
  test("mode 缺省/非法 → 400 NETWORK_MODE_INVALID；大小写归一后合法", async () => {
    const deps = makeDeps();
    expect((await invoke("op:agent:network-settings:save", { body: {} }, deps)).data)
      .toEqual({ error: "连接方式必须是 direct、system 或 manual", code: "NETWORK_MODE_INVALID" });
    expect((await invoke("op:agent:network-settings:save", { body: { mode: "proxy" } }, deps)).status).toBe(400);

    const normalized = await invoke("op:agent:network-settings:save", { body: { mode: "  MANUAL ", proxyUrl: "http://127.0.0.1:7890" } }, deps);
    expect(normalized.status).toBe(200);
  });

  test("manual 缺代理判定矩阵：缺 proxyUrl 且无存量 → 400；keepExistingProxy+hasProxy → 通过且 preserveProxy:true", async () => {
    // 缺 proxyUrl、keepExistingProxy 缺省 → 400 PROXY_REQUIRED
    const noProxy = await invoke("op:agent:network-settings:save", { body: { mode: "manual" } });
    expect(noProxy).toEqual({ ok: false, status: 400, data: { error: "手动代理模式需要填写代理地址", code: "PROXY_REQUIRED" } });

    // keepExistingProxy=true 但存量无代理（hasProxy:false）→ 仍 400
    const keepNoExisting = await invoke(
      "op:agent:network-settings:save",
      { body: { mode: "manual", keepExistingProxy: true } },
      makeDeps({ readNetworkSettings: vi.fn(() => ({ hasProxy: false })) })
    );
    expect(keepNoExisting).toEqual({ ok: false, status: 400, data: { error: "手动代理模式需要填写代理地址", code: "PROXY_REQUIRED" } });

    // keepExistingProxy=true 且存量有代理 → 通过；saveNetworkSettings 收到 preserveProxy:true 与原始 body
    const deps = makeDeps({ readNetworkSettings: vi.fn(() => ({ hasProxy: true })) });
    const kept = await invoke("op:agent:network-settings:save", { body: { mode: "manual", keepExistingProxy: true } }, deps);
    expect(kept.status).toBe(200);
    expect(deps.saveNetworkSettings.mock.calls[0]).toEqual([{ mode: "manual", keepExistingProxy: true }, { preserveProxy: true }]);
  });

  test("keepExistingProxy 仅严格 === true（字符串 'true' 不触发）", async () => {
    const result = await invoke("op:agent:network-settings:save", { body: { mode: "manual", keepExistingProxy: "true" } }, makeDeps());
    expect(result).toEqual({ ok: false, status: 400, data: { error: "手动代理模式需要填写代理地址", code: "PROXY_REQUIRED" } });
  });

  test("成功 → saveNetworkSettings(body, { preserveProxy }) → updateNetworkSettings(loadNetworkSettings()) → { ...saved, runtime }", async () => {
    const deps = makeDeps();
    const body = { mode: "manual", proxyUrl: "http://127.0.0.1:7890" };
    const result = await invoke("op:agent:network-settings:save", { body }, deps);
    expect(deps.saveNetworkSettings.mock.calls[0]).toEqual([body, { preserveProxy: false }]);
    expect(deps.updateNetworkSettings.mock.calls[0]).toEqual([{ mode: "manual", proxyUrl: "http://127.0.0.1:7890" }]);
    expect(result).toEqual({
      ok: true,
      status: 200,
      data: { mode: "manual", proxy: "http://127.0.0.1:7890", hasProxy: true, runtime: { mode: "manual", proxyWorks: true, notes: [] } }
    });
  });

  test("save 抛错 → 500 { error, code: NETWORK_SETTINGS_SAVE_FAILED }", async () => {
    const result = await invoke(
      "op:agent:network-settings:save",
      { body: { mode: "direct" } },
      makeDeps({ saveNetworkSettings: vi.fn(() => { throw new Error("配置文件只读"); }) })
    );
    expect(result).toEqual({ ok: false, status: 500, data: { error: "配置文件只读", code: "NETWORK_SETTINGS_SAVE_FAILED" } });
  });

  test("body 缺省 → 按 {} 编排（mode 校验先于读取，empty body → 400）", async () => {
    const result = await invoke("op:agent:network-settings:save", undefined, makeDeps());
    expect(result.status).toBe(400);
    expect((result.data as any).code).toBe("NETWORK_MODE_INVALID");
  });
});
