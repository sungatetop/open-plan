/**
 * C-7 探测与诊断族直调对拍（agent-probe-diagnostics-direct.ts 编排层）。
 *
 * 覆盖面（行号锚点均指 server/index.mjs）：
 *   - manifest 锚点：2 通道全部在 DESKTOP_CHANNELS 且路由指向已审计路径；unknown → 404；
 *   - probe（L1835-1856）：缺 model → 400 {ok:false, code: MODEL_REQUIRED} /
 *     成功透传 / 抛错 → 200 ok:false + latencyMs + diagnostic 五字段 + 诊断日志落盘；
 *   - diagnostics（L1889-1931）：runtime 有无分支 / catalog 对账（runtime 模型拼接
 *     与 settings 默认回退、selectedInCatalog/selectedAvailable/counts/source）/
 *     catalog 抛错降级 / selectedProvider+authConfigured+authProviders 投影 /
 *     service{version,pid}/requestId null/scheduler/sessions/network 透传 /
 *     recentFailures 过滤 + hint 拼接；
 *   - 本地辅助：readRecentAgentDiagnostics（limit 截断 1..50、非法回退 20、
 *     倒序、坏行跳过、三过滤条件）+ agentFailureHint（凭据/网络两类文案）。
 *
 * 本文件为纯编排测试（deps 全桩 + 临时诊断日志文件），不加载域实现。
 */
import { describe, expect, test, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as ProbeModule from "../src/main/ipc/agent-probe-diagnostics-direct";
import { DESKTOP_CHANNELS, type InvokeEnvelope } from "../src/shared/protocol/channels";

type Probe = typeof ProbeModule;
let svc: Probe;
let logFile: string;

beforeAll(async () => {
  svc = await import("../src/main/ipc/agent-probe-diagnostics-direct");
  logFile = path.join(os.tmpdir(), `oaw-c7-test-${process.pid}-${Date.now()}.log`);
});

afterAll(() => {
  try { fs.unlinkSync(logFile); } catch {}
});

/** 诊断日志桩：写入 JSONL 行。 */
function seedLog(lines: Array<Record<string, unknown> | string>): void {
  fs.writeFileSync(logFile, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n", "utf8");
}

/** deps 桩：AgentManager 面 + 凭据面 + 网络诊断 + 设置 + 诊断日志注入。 */
function makeDeps(overrides: Partial<ProbeModule.AgentProbeDiagnosticsDirectDeps> = {}) {
  const deps = {
    probeModel: vi.fn(async () => ({ ok: true, model: "deepseek/deepseek-chat", latencyMs: 120 })),
    runtimeHealth: vi.fn(() => ({ model: { provider: "deepseek", id: "deepseek-chat" }, state: "idle" })),
    listRuntimes: vi.fn(() => ({ runtimes: [], scheduler: { queued: 0, running: 0 } })),
    listSessionStates: vi.fn(() => [{ key: "web::t1", busy: false, queuedCount: 0 }]),
    listModelCatalog: vi.fn(async () => ({
      models: [{ id: "deepseek/deepseek-chat", available: true }, { id: "qwen/qwen-max", available: false }],
      counts: { total: 2 },
      source: "merged"
    })),
    networkDiagnostics: vi.fn(() => ({ mode: "direct", proxyWorks: null })),
    listAuth: vi.fn(() => ({ deepseek: { type: "api_key", key: "sk-x" }, qwen: { type: "oauth", access: "a" } })),
    getCredentialErrors: vi.fn(() => ({ deepseek: { message: "凭据无效" } })),
    readRuntimeSettings: vi.fn(() => ({ defaultProvider: "deepseek", defaultModel: "deepseek-chat" })),
    agentKey: vi.fn((client: unknown, thread: unknown) => `${String(client)}::${String(thread)}`),
    diagnosticLogPath: vi.fn(() => logFile),
    serviceVersion: vi.fn(() => "0.11.55"),
    ...overrides
  };
  return deps as never as ProbeModule.AgentProbeDiagnosticsDirectDeps & {
    probeModel: ReturnType<typeof vi.fn>;
    runtimeHealth: ReturnType<typeof vi.fn>;
    listRuntimes: ReturnType<typeof vi.fn>;
    listSessionStates: ReturnType<typeof vi.fn>;
    listModelCatalog: ReturnType<typeof vi.fn>;
    networkDiagnostics: ReturnType<typeof vi.fn>;
    listAuth: ReturnType<typeof vi.fn>;
    getCredentialErrors: ReturnType<typeof vi.fn>;
    readRuntimeSettings: ReturnType<typeof vi.fn>;
    agentKey: ReturnType<typeof vi.fn>;
    diagnosticLogPath: ReturnType<typeof vi.fn>;
    serviceVersion: ReturnType<typeof vi.fn>;
  };
}

function invoke(channel: ProbeModule.AgentProbeDiagnosticsDirectChannel, envelope: InvokeEnvelope | undefined, deps = makeDeps()) {
  return svc.invokeAgentProbeDiagnosticsDirect(channel, envelope, deps);
}

describe("C-7 manifest 锚点", () => {
  test("2 条通道全部在 DESKTOP_CHANNELS 且路由指向已审计路径", () => {
    expect(svc.AGENT_PROBE_DIAGNOSTICS_DIRECT_CHANNELS).toHaveLength(2);
    const expectedRoutes: Record<string, { method: string; path: string }> = {
      "op:agent:model:probe": { method: "POST", path: "/api/agent/model/probe" },
      "op:agent:diagnostics": { method: "GET", path: "/api/agent/diagnostics" }
    };
    for (const channel of svc.AGENT_PROBE_DIAGNOSTICS_DIRECT_CHANNELS) {
      expect(DESKTOP_CHANNELS[channel as keyof typeof DESKTOP_CHANNELS]).toEqual(expectedRoutes[channel]);
    }
  });

  test("unknown channel → 404", async () => {
    const result = await svc.invokeAgentProbeDiagnosticsDirect("op:agent:model:probe:all" as never, {}, makeDeps());
    expect(result).toEqual({ ok: false, status: 404, data: { error: "unknown channel: op:agent:model:probe:all" } });
  });
});

describe("C-7 op:agent:model:probe（L1835-1856）", () => {
  test("缺 model → 400 { ok:false, error, code: MODEL_REQUIRED }", async () => {
    expect((await invoke("op:agent:model:probe", { body: {} })).data).toEqual({ ok: false, error: "model required", code: "MODEL_REQUIRED" });
    expect((await invoke("op:agent:model:probe", { body: {} })).status).toBe(400);
  });

  test("成功 → 透传 probeModel 结果（timeoutMs 透传）", async () => {
    const deps = makeDeps();
    const result = await invoke("op:agent:model:probe", { body: { model: "deepseek/deepseek-chat", timeoutMs: 8000 } }, deps);
    expect(deps.probeModel.mock.calls[0]).toEqual(["deepseek/deepseek-chat", { timeoutMs: 8000 }]);
    expect(result).toEqual({ ok: true, status: 200, data: { ok: true, model: "deepseek/deepseek-chat", latencyMs: 120 } });
  });

  test("probe 抛错 → 200 ok:false + latencyMs + diagnostic 五字段（errorCode→code 等）+ 诊断日志落盘（requestId/runId/clientId 置 null）", async () => {
    seedLog([]);
    const deps = makeDeps({
      probeModel: vi.fn(async () => {
        const e = new Error("401 Unauthorized") as Error & { status?: number };
        e.status = 401;
        throw e;
      })
    });
    const result = await invoke("op:agent:model:probe", { body: { model: "deepseek/deepseek-chat" } }, deps);
    expect(result.status).toBe(200);
    const data = result.data as any;
    expect(data.ok).toBe(false);
    expect(data.model).toBe("deepseek/deepseek-chat");
    expect(data.latencyMs).toBeGreaterThanOrEqual(0);
    expect(data.diagnostic.message).toContain("401");

    const line = JSON.parse(fs.readFileSync(logFile, "utf8").trim().split("\n").pop()!);
    expect(line).toMatchObject({ requestId: null, runId: null, clientId: null, threadId: null, model: "deepseek/deepseek-chat" });
    expect(data.diagnostic.code).toBe(line.errorCode);
    expect(data.diagnostic.status).toBe(line.providerStatus);
    expect(typeof data.diagnostic.retryable).toBe("boolean");
  });
});

describe("C-7 op:agent:diagnostics（L1889-1931）", () => {
  test("client 有 → runtimeHealth(agentKey(client, thread))；client 无 → runtime null 且 agentKey 不调用", async () => {
    const deps = makeDeps();
    await invoke("op:agent:diagnostics", { query: { client: "web", thread: "t1" } }, deps);
    expect(deps.agentKey.mock.calls[0]).toEqual(["web", "t1"]);

    const bare = makeDeps();
    const result = await invoke("op:agent:diagnostics", {}, bare);
    expect(bare.agentKey).not.toHaveBeenCalled();
    expect((result.data as any).runtime).toBeNull();
  });

  test("catalog 对账：runtime 模型拼接 selected + selectedInCatalog/selectedAvailable/counts/source；selectedProvider/runtime 优先", async () => {
    const deps = makeDeps();
    const result = await invoke("op:agent:diagnostics", { query: { client: "web" } }, deps);
    const data = result.data as any;
    expect(data.ok).toBe(true);
    expect(data.model.selected).toBe("deepseek/deepseek-chat");
    expect(data.model).toMatchObject({ selectedInCatalog: true, selectedAvailable: true, counts: { total: 2 }, source: "merged", authProvider: "deepseek", authConfigured: true, catalogError: null });
    expect(data.service).toEqual({ version: "0.11.55", pid: process.pid });
    expect(data.requestId).toBeNull();
    expect(data.scheduler).toEqual({ queued: 0, running: 0 });
    expect(data.sessions).toEqual([{ key: "web::t1", busy: false, queuedCount: 0 }]);
    expect(data.network).toEqual({ mode: "direct", proxyWorks: null });
    expect(data.authErrors).toEqual({ deepseek: { message: "凭据无效" } });
    expect(data.authProviders).toEqual({ deepseek: { type: "api_key", set: true }, qwen: { type: "oauth", set: true } });
  });

  test("runtime 无 model → selected 回退 settings 默认（loadSettingsDefault）；authProviders type 缺省 unknown / 值缺省 set:false", async () => {
    const deps = makeDeps({
      runtimeHealth: vi.fn(() => ({ state: "idle" })),
      listAuth: vi.fn(() => ({ legacy: null, broken: {} }))
    });
    const result = await invoke("op:agent:diagnostics", { query: { client: "web" } }, deps);
    const data = result.data as any;
    expect(data.model.selected).toBe("deepseek/deepseek-chat");
    expect(data.model.authProvider).toBe("deepseek");
    expect(data.model.authConfigured).toBe(false); // settings 默认 provider 不在凭据表 → false（server 语义：Boolean(selectedProvider && auth[selectedProvider])）
    expect(data.authProviders).toEqual({ legacy: { type: "unknown", set: false }, broken: { type: "unknown", set: true } });
  });

  test("catalog 抛错 → catalogError + model 兜底形状（selected=settings 默认、selectedInCatalog/selectedAvailable null）", async () => {
    const deps = makeDeps({ listModelCatalog: vi.fn(async () => { throw new Error("目录损坏"); }) });
    const result = await invoke("op:agent:diagnostics", {}, deps);
    const data = result.data as any;
    expect(data.model.catalogError).toBe("目录损坏");
    expect(data.model).toMatchObject({ selected: "deepseek/deepseek-chat", selectedInCatalog: null, selectedAvailable: null, authProvider: "deepseek" });
  });

  test("catalog 抛错（非 Error）→ catalogError = String(值)", async () => {
    const deps = makeDeps({ listModelCatalog: vi.fn(async () => { throw "boom"; }) });
    expect(((await invoke("op:agent:diagnostics", {}, deps)).data as any).model.catalogError).toBe("boom");
  });

  test("authConfigured：selectedProvider 空时 false；selectedProvider 有但凭据缺 → false", async () => {
    const noDefault = makeDeps({
      runtimeHealth: vi.fn(() => ({ state: "idle" })),
      readRuntimeSettings: vi.fn(() => ({})),
      listAuth: vi.fn(() => ({}))
    });
    const data = (await invoke("op:agent:diagnostics", {}, noDefault)).data as any;
    expect(data.model.authProvider).toBeNull();
    expect(data.model.authConfigured).toBe(false);

    const noKey = makeDeps({
      runtimeHealth: vi.fn(() => ({ model: { provider: "openai", id: "gpt" } })),
      listAuth: vi.fn(() => ({}))
    });
    const data2 = (await invoke("op:agent:diagnostics", { query: { client: "web" } }, noKey)).data as any;
    expect(data2.model.authProvider).toBe("openai");
    expect(data2.model.authConfigured).toBe(false);
  });
});

describe("C-7 recentFailures（readRecentAgentDiagnostics L138-153 + agentFailureHint L155-171）", () => {
  test("倒序 + client/thread 过滤 + hint 拼接（401→凭据失效；timeout→网络提示；其余→空串）", async () => {
    seedLog([
      { errorCode: "X1", providerStatus: "200", message: "普通失败", clientId: "web", threadId: "t1" },
      { errorCode: "MODEL_TIMEOUT", providerStatus: "500", message: "超时", clientId: "web", threadId: "t1" },
      { errorCode: "AUTH_ERROR", providerStatus: "401", message: "认证失败", clientId: "cli", threadId: "t9" },
      "not-json"
    ]);
    const deps = makeDeps({ runtimeHealth: vi.fn(() => ({ state: "idle" })) });
    const data = (await invoke("op:agent:diagnostics", { query: { client: "web", thread: "t1", limit: "10" } }, deps)).data as any;
    expect(data.recentFailures).toHaveLength(2);
    expect(data.recentFailures[0]).toMatchObject({ errorCode: "MODEL_TIMEOUT", hint: "模型请求超时：请检查网络或代理设置（设置→模型与连接→模型网络）" });
    expect(data.recentFailures[1]).toMatchObject({ errorCode: "X1", hint: "" });
  });

  test("limit 截断：>50 → 50；非法 → 20；runId 过滤", async () => {
    seedLog(Array.from({ length: 60 }, (_, i) => ({ errorCode: `C${i}`, runId: i < 55 ? "r1" : "r2", clientId: "", threadId: "" })));
    const deps = makeDeps({ runtimeHealth: vi.fn(() => ({ state: "idle" })) });
    const data = (await invoke("op:agent:diagnostics", { query: { limit: "999" } }, deps)).data as any;
    expect(data.recentFailures).toHaveLength(50);

    const bad = makeDeps({ runtimeHealth: vi.fn(() => ({ state: "idle" })) });
    const data2 = (await invoke("op:agent:diagnostics", { query: { limit: "abc", runId: "r1" } }, bad)).data as any;
    expect(data2.recentFailures).toHaveLength(20);
  });

  test("日志文件缺失 → recentFailures []", async () => {
    const deps = makeDeps({ diagnosticLogPath: vi.fn(() => path.join(os.tmpdir(), `oaw-c7-missing-${process.pid}.log`)), runtimeHealth: vi.fn(() => ({ state: "idle" })) });
    expect(((await invoke("op:agent:diagnostics", {}, deps)).data as any).recentFailures).toEqual([]);
  });
});
