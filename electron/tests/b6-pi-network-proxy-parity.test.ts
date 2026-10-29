import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// B6-3 行为覆盖：pi-network-proxy（模式归一/代理脱敏/设置解析/错误分类与文案/网络适配器）。
//
// R6-6b 对拍退役改写：旧侧 server/pi-network-proxy.mjs 动态 import 与 runBoth 双跑互等
// 随 server 退役删除，仅保留 TS 侧断言（期望值此前已经双侧对拍固化）。
//
// 适配器基建设计：
// - 真实 undici 适配器，所有网络目标都指向 127.0.0.1:1 / 127.0.0.2:1（立即 ECONNREFUSED，
//   不触外网）；手动代理探测也经 ProxyAgent 走同一个不可达代理，因此 probe 必然本地失败。
// - fake timers 仅冻结 Date（toFake:["Date"]）：proxyFallback 的 at/retryAt 由 Date.now 派生，
//   冻结后可整体断言；真实 setTimeout 不受影响（探测超时定时器在 finally 清掉）。

type AnyMod = Record<string, any>;

async function loadMods(): Promise<AnyMod> {
  vi.resetModules();
  return (await import("../src/main/backend/agent/pi-network-proxy")) as unknown as AnyMod;
}

describe("pi-network-proxy 纯函数", () => {
  it("normalizePiNetworkMode 矩阵", async () => {
    const mod = await loadMods();
    const samples = ["direct", "SYSTEM", "Manual", " auto ", "", null, undefined, "walk", "DIRECT\n"];
    const results = samples.map((s) => mod.normalizePiNetworkMode(s));
    expect(results).toEqual(["direct", "system", "manual", "direct", "direct", "direct", "direct", "direct", "direct"]);
  });

  it("redactProxyUrl 矩阵（含 @ 凭据回退分支）", async () => {
    const mod = await loadMods();
    const samples = ["", "   ", "http://user:pass@h:8080", "https://h", "not a url", "socks5://u@h:1080/path", "http://h"];
    const results = samples.map((s) => mod.redactProxyUrl(s));
    expect(results).toEqual([null, null, "http://h:8080", "https://h", "not a url", "socks5://h:1080", "http://h"]);
  });

  it("resolvePiNetworkSettings 矩阵", async () => {
    const mod = await loadMods();
    const samples = [
      {},
      { environment: {} },
      { environment: { OAW_MODEL_NETWORK_MODE: "manual", OAW_MODEL_PROXY_URL: "http://envp:9" } },
      { mode: "system", environment: { HTTP_PROXY: "http://1.2.3.4:8080", HTTPS_PROXY: "https://h:443", NO_PROXY: "a.b,c" } },
      { mode: "manual", proxyUrl: "http://p:1", connectTimeoutMs: "700", timeoutMs: 0, bodyTimeoutMs: -5 },
      { mode: "manual", proxyUrl: "", environment: { HTTP_PROXY: "http://e:1" } },
      { timeoutMs: "abc" },
      { connectTimeoutMs: undefined },
      { timeoutMs: 900, connectTimeoutMs: 100, bodyTimeoutMs: 42, environment: {} },
    ];
    const results = samples.map((s) => mod.resolvePiNetworkSettings(s));
    const direct = results[1] as Record<string, unknown>;
    const manual = results[4] as Record<string, unknown>;
    expect(direct).toMatchObject({ mode: "direct", httpProxy: "", timeoutMs: 30000, bodyTimeoutMs: 0 });
    expect(manual).toMatchObject({ mode: "manual", proxyUrl: "http://p:1", connectTimeoutMs: 1000, timeoutMs: 30000, bodyTimeoutMs: 0 });
    expect(results[2]).toMatchObject({ mode: "manual", proxyUrl: "http://envp:9" });
    expect(results[3]).toMatchObject({ mode: "system", httpProxy: "http://1.2.3.4:8080", httpsProxy: "https://h:443", noProxy: "a.b,c" });
  });

  it("classifyPiError 矩阵", async () => {
    const mod = await loadMods();
    const samples: Array<[string, any, any?]> = [
      ["401", { status: 401 }],
      ["403 文案", { statusCode: 403, message: "forbidden" }],
      ["invalid api key", { message: "invalid api key provided" }],
      ["no api key", { message: "No api key configured for provider" }],
      ["429", { status: 429 }],
      ["too many requests", { message: "too many requests, slow down" }],
      ["overloaded", { status: 500, message: "provider overloaded" }],
      ["529", { status: 529 }],
      ["body rate limit", { status: 500, message: "boom" }, { body: "rate limit exceeded" }],
      ["504", { status: 504 }],
      ["408", { status: 408 }],
      ["timed out", { message: "request timed out after 30s" }],
      ["aborted", { message: "operation was aborted" }],
      ["stream timeout code", { code: "MODEL_STREAM_TIMEOUT", message: "stream idle" }],
      ["context limit en", { message: "maximum context length exceeded" }],
      ["context limit zh", { responseBody: "上下文过长" }],
      ["404 model not found", { status: 404 }],
      ["deployment unknown", { message: "deployment abc unknown" }],
      ["ECONNREFUSED", { cause: { code: "ECONNREFUSED" }, message: "connect failed" }],
      ["ENOTFOUND", { code: "ENOTFOUND", message: "getaddrinfo failure" }],
      ["socket hang up", { message: "socket hang up" }],
      ["fetch failed", { message: "fetch failed" }],
      ["host restricted flag", { message: "network error happened" }, { hostNetworkRestricted: true }],
      ["host restricted env", { message: "fetch failed" }, { hostNetworkRestrictedEnv: true }],
      ["host restricted code", { cause: { code: "EACCES" }, message: "connection error" }],
      ["host denied by context", { cause: { code: "ECONNRESET" }, message: "connection reset" }, { hostNetworkRestricted: false }],
      ["wrapped passthrough", { oawNetwork: { code: "NETWORK_UNREACHABLE", retryable: true, mode: "manual" }, provider: "deepseek" }],
      ["wrapped rate limit", { oawNetwork: { code: "RATE_LIMIT", retryable: false } }],
      ["status regex fallback", { message: "Response 502 status code from upstream" }],
      ["provider/model", { provider: "p1", model: { id: "m1", provider: "p2" } }, { provider: "cp", model: "cm" }],
      ["model string", { model: "qwen" }],
      ["sandbox env", { message: "network error while sandbox active" }, { sandboxEnv: true }],
      ["secret redaction", { message: "api_key=sk-abc123 authorization: Bearer eyj password: hunter2 http://user:pass@host/path" }],
      ["800 slice", { message: "x".repeat(1000) }],
    ];
    const results = samples.map(([, error, context]) => mod.classifyPiError(error, context ?? {}));
    expect(results[0]).toMatchObject({ code: "AUTH_ERROR", retryable: false, status: 401 });
    expect(results[7]).toMatchObject({ code: "RATE_LIMIT", retryable: true });
    expect(results[12]).toMatchObject({ code: "MODEL_TIMEOUT", retryable: true });
    expect(results[14]).toMatchObject({ code: "CONTEXT_LIMIT" });
    expect(results[16]).toMatchObject({ code: "MODEL_NOT_FOUND" });
    expect(results[18]).toMatchObject({ code: "NETWORK_UNREACHABLE", retryable: true, causeCode: "ECONNREFUSED" });
    expect(results[22]).toMatchObject({ code: "HOST_NETWORK_RESTRICTED" });
    expect(results[25]).toMatchObject({ code: "NETWORK_UNREACHABLE" });
    expect(results[26]).toMatchObject({ code: "NETWORK_UNREACHABLE", retryable: true, mode: "manual", provider: "deepseek" });
    expect(results[28]).toMatchObject({ status: 502, code: "REQUEST_ERROR" });
    expect(results[29]).toMatchObject({ provider: "p1", model: "m1" });
    expect(results[30]).toMatchObject({ model: "qwen" });
    expect(String(results[32].message)).not.toContain("sk-abc123");
    expect(results[32].message).toContain("[已隐藏]");
    expect(results[33].message).toHaveLength(800);
  });

  it("classifyPiError 宿主受限环境变量分支", async () => {
    const mod = await loadMods();
    vi.stubEnv("OAW_HOST_NETWORK_RESTRICTED", "1");
    try {
      const result = mod.classifyPiError({ message: "fetch failed" }, {});
      expect(result.code).toBe("HOST_NETWORK_RESTRICTED");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("classifyPiResponse 矩阵", async () => {
    const mod = await loadMods();
    const samples = [
      [{ status: 429 }, { body: "too many requests" }],
      [{ status: 401 }, { body: "", provider: "p", model: "m" }],
      [{ status: 500 }, { body: "上下文超限" }],
      [undefined, {}],
    ];
    const results = samples.map(([response, context]) => mod.classifyPiResponse(response, context));
    expect(results[0]).toMatchObject({ code: "RATE_LIMIT", retryable: true });
    expect(results[1]).toMatchObject({ code: "AUTH_ERROR", provider: "p", model: "m" });
  });

  it("networkErrorMessage 矩阵", async () => {
    const mod = await loadMods();
    const codes = ["HOST_NETWORK_RESTRICTED", "NETWORK_UNREACHABLE", "AUTH_ERROR", "RATE_LIMIT", "MODEL_TIMEOUT", "MODEL_STREAM_TIMEOUT", "CONTEXT_LIMIT", "MODEL_NOT_FOUND", "REQUEST_ERROR"];
    const results = [...codes.map((code) => mod.networkErrorMessage({ code })), mod.networkErrorMessage(null), mod.networkErrorMessage({}), mod.networkErrorMessage({ code: "nope" })];
    expect(results[0]).toBe("宿主网络受限，无法访问模型供应商");
    expect(results[10]).toBe("模型请求失败");
  });

  it("wrapPiAgentStreamFunction 行为", async () => {
    const mod = await loadMods();
    const log: any[] = [];
    const noAgent = mod.wrapPiAgentStreamFunction(null, () => {});
    const noStream = mod.wrapPiAgentStreamFunction({ agent: {} }, () => {});
    const badFetch = mod.wrapPiAgentStreamFunction({ agent: { streamFunction() {} } }, "nope");
    const sentinel = () => "injected";
    const kept = () => "kept";
    const original = (model: any, context: any, options: any) => {
      log.push([model, context, { a: options?.a, hasFetch: typeof options?.fetch === "function", fetchIsSentinel: options?.fetch === sentinel, fetchIsKept: options?.fetch === kept }]);
      return "ran";
    };
    const session: any = { agent: { streamFunction: original } };
    const first = mod.wrapPiAgentStreamFunction(session, sentinel);
    const wrapped = session.agent.streamFunction;
    const second = mod.wrapPiAgentStreamFunction(session, () => "other");
    const unchangedAfterSecond = session.agent.streamFunction === wrapped;
    const ran1 = wrapped("m1", { c: 1 }, { a: 1 });
    const ran2 = wrapped("m2", { c: 2 }, { fetch: kept });
    expect({ noAgent, noStream, badFetch, first, second, unchangedAfterSecond, ran1, ran2 }).toMatchObject({ noAgent: false, noStream: false, badFetch: false, first: true, second: true, unchangedAfterSecond: true, ran1: "ran", ran2: "ran" });
    expect(log[0][2]).toMatchObject({ a: 1, hasFetch: true, fetchIsSentinel: true });
    expect(log[1][2]).toMatchObject({ hasFetch: true, fetchIsKept: true });
  });
});

describe("pi-network-proxy 适配器（真实 undici，本地不可达端口）", () => {
  const REFUSED_URL = "http://127.0.0.1:1/oaw-parity";
  const REFUSED_PROXY_HOST_URL = "http://127.0.0.2:1/oaw-parity";

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_700_000_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function stripVolatile(error: any) {
    return {
      name: error?.name,
      message: error?.message,
      code: error?.code,
      oawNetwork: error?.oawNetwork ? JSON.parse(JSON.stringify(error.oawNetwork)) : undefined,
    };
  }

  it("direct 模式：settings/diagnostics/close", async () => {
    const mod = await loadMods();
    const adapter = mod.createPiNetworkAdapter({ mode: "direct", environment: {} });
    const before = adapter.diagnostics();
    const beforeSettings = JSON.parse(JSON.stringify(adapter.settings));
    adapter.close();
    const after = adapter.diagnostics();
    adapter.close();
    expect(before).toMatchObject({ mode: "direct", proxy: null, hasProxy: false, proxyFallback: null, closed: false });
    expect(beforeSettings).toMatchObject({ mode: "direct", httpProxy: "" });
    expect(after.closed).toBe(true);
  });

  it("direct 模式：拒绝连接错误的分类与包装", async () => {
    const mod = await loadMods();
    const adapter = mod.createPiNetworkAdapter({ mode: "direct", environment: {} });
    try {
      let thrown: any;
      try { await adapter.fetch(REFUSED_URL); } catch (error) { thrown = stripVolatile(error); }
      expect(thrown?.name).toBe("PiNetworkError");
      expect(thrown?.code).toBe("NETWORK_UNREACHABLE");
      expect(thrown?.oawNetwork).toMatchObject({ code: "NETWORK_UNREACHABLE", retryable: true, mode: "direct", status: null });
      expect(thrown?.message).toContain("fetch failed");
    } finally {
      adapter.close();
    }
  });

  it("manual 模式：noProxy 命中直连，不产生回退记录", async () => {
    const mod = await loadMods();
    const adapter = mod.createPiNetworkAdapter({ mode: "manual", proxyUrl: "http://127.0.0.1:1", environment: {} });
    try {
      let thrown: any;
      try { await adapter.fetch(REFUSED_URL); } catch (error) { thrown = stripVolatile(error); }
      expect(adapter.diagnostics()).toMatchObject({ mode: "manual", proxy: "http://127.0.0.1:1", hasProxy: true, proxyFallback: null });
      expect(thrown?.code).toBe("NETWORK_UNREACHABLE");
    } finally {
      adapter.close();
    }
  });

  it("manual 模式：代理选中失败 → 回退 → 重试探测刷新", async () => {
    const mod = await loadMods();
    const adapter = mod.createPiNetworkAdapter({ mode: "manual", proxyUrl: "http://127.0.0.1:1", environment: {} });
    try {
      const grab = async () => {
        try { await adapter.fetch(REFUSED_PROXY_HOST_URL); } catch { /* 网络失败即预期 */ }
        return adapter.diagnostics();
      };
      const first = await grab();
      expect(first.proxyFallback).toMatchObject({
        at: new Date(1_700_000_000_000).toISOString(),
        retryAt: 1_700_000_010_000,
        message: "代理请求失败，已临时回退直连，稍后自动重试代理",
      });

      // retryAt 未到：第二次请求直接走直连回退，回退记录保持不变。
      const second = await grab();
      expect(second).toEqual(first);

      // 越过 retryAt：先探测代理（本地失败），刷新回退记录，再走直连。
      vi.setSystemTime(1_700_000_010_001);
      const third = await grab();
      expect(third.proxyFallback).toMatchObject({
        at: new Date(1_700_000_010_001).toISOString(),
        retryAt: 1_700_000_020_001,
        message: "代理暂时不可达，已临时回退直连，稍后自动重试代理",
      });
    } finally {
      adapter.close();
    }
  });

  it("system 模式：环境变量代理解析", async () => {
    const mod = await loadMods();
    const adapter = mod.createPiNetworkAdapter({ mode: "system", environment: { HTTP_PROXY: "http://127.0.0.1:1", NO_PROXY: "a.b" } });
    const diagnostics = adapter.diagnostics();
    const settings = JSON.parse(JSON.stringify(adapter.settings));
    adapter.close();
    expect(settings).toMatchObject({ mode: "system", httpProxy: "http://127.0.0.1:1", httpsProxy: "http://127.0.0.1:1", noProxy: "a.b" });
    expect(diagnostics).toMatchObject({ proxy: "http://127.0.0.1:1", hasProxy: true });
  });

  it("关闭后 fetch 抛固定文案", async () => {
    const mod = await loadMods();
    const adapter = mod.createPiNetworkAdapter({ environment: {} });
    adapter.close();
    let message: string | null = null;
    try { await adapter.fetch(REFUSED_URL); } catch (error: any) { message = error.message; }
    expect(message).toBe("Pi 网络适配器已关闭");
  });
});
