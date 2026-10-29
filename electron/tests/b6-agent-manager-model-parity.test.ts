/**
 * B6-6-4c 单侧行为覆盖：AgentManager 模型族批。
 *
 * R6-6b 对拍退役改写：旧 server/agent.mjs 对拍机制（行号提取 + new Function 求值）移除，
 * 保留 TS 侧行为断言。
 *
 * 覆盖：setModel（空闲直通/busy 排队/回退生效/不可重试原样抛/无 entry 经 getOrCreate 创建）/
 * applyModelSpec（无效 spec/目录外/model not found/无默认模型原样抛/回退即目标原样抛/成功清
 * 回退字段）/ probeModel（三错误分支 + 成功归一：text 提取截断/usage 补零/responseModel 回退）/
 * fallbackModel（跨 provider 优先/同 provider 回退缺失→null/全 tried 无候选/空 tried 成功链）/
 * listModelCatalog（Runtime→stored→available 合并覆盖序/normalize 上下文窗口取值链/deny 过滤/
 * authError 标记与 available 剔除/counts）/ listModels / refreshModels（成功/网络失败续用/
 * AbortError 静默 + resetModelRuntime）/ disposeAll。
 *
 * piRuntimeManager（pi 域未迁）、findSessionFileForAgent（4f 批）经 AgentManagerDeps 注入；
 * localModelProviders/localStoredModels/configuredModelSpec/getCredentialErrors 注入测试 stub。
 * _create 未迁（4i 批），实例覆写注入。setModelImpl 的 attempt 按 session 对象计数
 * （per-session Map 互不串号）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager, type AgentManagerDeps } from "../src/main/backend/agent/agent-manager";

// 冻结时钟：emitChannelSafe 信封含 at=ISO 时间戳，跨毫秒会比对失败（4a/4b 同口径）
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

/** 目录夹具：providers/runtimeModels/available 三源 + deny/authError 场景。 */
function makeCatalog() {
  const providers = new Set(["prov-x", "prov-b", "new-provider", "xiaomi-token-plan-cn"]);
  const runtimeModels = [
    { provider: "prov-x", id: "mdl-1", name: "Runtime One", vision: true, contextWindow: 128000 },
    { provider: "prov-b", id: "mdl-b", contextLength: 64000 },
    { provider: "prov-b", id: "mdl-b2", limit: { context: 32000 } },
    { provider: "prov-b", id: "mdl-off", enabled: false },
    { provider: "prov-rt-only", id: "m1" },
  ];
  const stored = [
    { provider: "prov-x", id: "mdl-1", name: "Stored One", contextWindow: 99000 },
    { provider: "prov-b", id: "mdl-new", name: "Stored New", vision: false },
    { provider: "new-provider", id: "step-3.7-flash" },
    { provider: "xiaomi-token-plan-cn", id: "mimo-v2.5-pro" },
    { provider: "xiaomi-token-plan-cn", id: "mimo-x" },
  ];
  const available = [
    { provider: "prov-b", id: "mdl-b", name: "Avail B" },
    { provider: "prov-x", id: "mdl-x" },
  ];
  return { providers, runtimeModels, stored, available };
}

/** 会话 entry 种子（model 字段喂 currentModelSpec；channel.emitter 捕获 emit 信封到独立 emitted）。 */
function makeEntry(overrides: Record<string, unknown> = {}) {
  const emitted: any[] = [];
  const entry: any = {
    runtimeId: "rt1",
    session: { sessionId: "s-1", sessionFile: "/store/s-1.jsonl", model: { provider: "prov-x", id: "mdl-1" } },
    sessionManager: { sm: 1 },
    workspace: "norm:/ws/a",
    threadId: "t1",
    channel: {
      streamId: "stream_test",
      seq: 0,
      history: [] as any[],
      historyLimit: 0,
      lastEmitAt: 0,
      emitter: { emit: (_type: string, ev: any) => { emitted.push(ev); return true; } },
    },
    ...overrides,
  };
  return { entry, emitted };
}

/** 依赖世界：目录夹具 + seam stub 全量记录调用序列（calls 为单侧调用序列）。 */
function makeWorld(opts: {
  catalog?: ReturnType<typeof makeCatalog>;
  configuredModel?: any;
  credentialErrors?: any;
  getModelOut?: any;
  setModelImpl?: (call: { runtimeId: unknown; session: unknown; model: unknown }, attempt: number) => any;
  probeOut?: any;
  refreshImpl?: () => Promise<any>;
} = {}) {
  const catalog = opts.catalog ?? makeCatalog();
  const calls = {
    modelRuntime: 0,
    setModel: [] as any[][],
    probeModel: [] as any[][],
    resetModelRuntime: 0,
    disposeAll: [] as any[][],
    localStored: [] as unknown[],
    configuredModel: 0,
    credErrors: 0,
    refresh: [] as any[],
  };
  const mr = {
    getModel: (provider: string, id: string) => {
      if ("getModelOut" in opts) return opts.getModelOut;
      return catalog.runtimeModels.find((m) => m.provider === provider && m.id === id && m.enabled !== false) || null;
    },
    getModels: () => catalog.runtimeModels,
    getAvailable: async () => catalog.available,
    refresh: async (args: any) => {
      calls.refresh.push(args);
      if (opts.refreshImpl) return opts.refreshImpl();
    },
  };
  const piRuntimeManager = {
    modelRuntime: async () => { calls.modelRuntime += 1; return mr; },
    dispose: (_runtimeId: unknown, _session: unknown) => {},
    getSessionTree: () => null,
    navigateSessionTree: async () => ({}),
    abort: async () => {},
    compact: async () => ({}),
    health: () => null,
    markRecovery: () => {},
    listSnapshots: () => [{ id: "rt1" }],
    schedulerSnapshot: () => ({ queue: 0 }),
    setModel: async (runtimeId: unknown, session: unknown, model: unknown) => {
      calls.setModel.push([runtimeId, session, model]);
      if (opts.setModelImpl) {
        // attempt 按 session 对象计数（per-session Map 互不串号）
        const attempts = (piRuntimeManager as any).__setModelAttempts as Map<unknown, number>;
        const attempt = (attempts.get(session) || 0) + 1;
        attempts.set(session, attempt);
        return opts.setModelImpl({ runtimeId, session, model }, attempt);
      }
    },
    probeModel: async (model: unknown, options: any) => { calls.probeModel.push([model, options]); return opts.probeOut ?? {}; },
    resetModelRuntime: () => { calls.resetModelRuntime += 1; },
    disposeAll: async (entries: unknown[]) => { calls.disposeAll.push(entries); },
    // B6-6-4d 扩员的 seam 方法：本批场景不触达，no-op 满足 AgentPiRuntimeSeam 类型
    getContextUsage: () => null,
    // B6-6-4e 扩员的 seam 方法：本批场景不触达，no-op 满足 AgentPiRuntimeSeam 类型
    prompt: () => {},
    runPrompt: async (_runtimeId: unknown, operation: () => Promise<any>) => operation(),
    setActiveTools: () => {},
    update: () => {},
    setThinkingLevel: () => {},
  };
  (piRuntimeManager as any).__setModelAttempts = new Map();
  const localModelProviders = () => new Set(catalog.providers);
  const localStoredModels = (p?: Set<string>) => { calls.localStored.push(p); return catalog.stored.map((m) => ({ ...m })); };
  const configuredModelSpec = () => { calls.configuredModel += 1; return "configuredModel" in opts ? opts.configuredModel : "cfg/fb-a"; };
  const getCredentialErrors = () => { calls.credErrors += 1; return opts.credentialErrors ?? {}; };
  const findSessionFileForAgent = () => ({ fullPath: "/store/s-1.jsonl" });
  // 幂等归一化（norm: 前缀），与 lifecycle 批同口径
  const normalize = (dir: unknown) => {
    if (dir === undefined || dir === null || dir === "") return null;
    const s = String(dir);
    return s.startsWith("norm:") ? s : `norm:${s}`;
  };
  const emitDeps = { recordRunEvent: () => {} };
  const deps: AgentManagerDeps = {
    piRuntimeManager: piRuntimeManager as any,
    getRun: () => null,
    listStoredMemoryProposals: () => [],
    approveStoredMemoryProposal: () => ({ proposal: null }),
    editStoredMemoryProposal: () => ({ proposal: null }),
    rejectStoredMemoryProposal: () => ({ proposal: null }),
    mergeMemoryProposals: () => ({}),
    getMemoryProposalHistory: () => [],
    normalizeWorkspace: normalize,
    findSessionFileForAgent,
    configuredModelSpec,
    localModelProviders,
    localStoredModels,
    getCredentialErrors,
    // B6-6-4d 必填 deps：本批场景不触达，恒 null stub
    contextTokensFromUsage: () => null,
    emitDeps,
  };
  return { deps, calls, emitDeps, normalize, catalog, mr };
}

/** 实例：AgentManager + 同一 deps。 */
function makeMgr(world: ReturnType<typeof makeWorld>) {
  return new AgentManager(world.deps);
}

/** 实例覆写 _create（4i 批未迁；回填 sessions 模拟真实创建，workspace 透传 options.cwd）。 */
function stubCreate(mgr: any) {
  mgr._create = async (clientId: unknown, options: any) => {
    const { entry } = makeEntry({ workspace: options.cwd });
    mgr.sessions.set(clientId, entry);
    return entry;
  };
}

describe("B6-6-4c 模型族：setModel", () => {
  it("空闲直通：ensureRuntime 复用现有 entry，applyModelSpec 成功 + model_switched(now/user)", async () => {
    const world = makeWorld();
    const mgr = makeMgr(world);
    const seed = makeEntry();
    mgr.sessions.set("c1", seed.entry);

    const res = await mgr.setModel("c1", "prov-x/mdl-1");

    expect(res).toEqual({ ok: true, model: "prov-x/mdl-1", from: "prov-x/mdl-1" });
    expect(seed.emitted).toHaveLength(1);
    expect(seed.emitted[0].type).toBe("model_switched");
    // 单侧一次 setModel，解析模型为共享 runtimeModels 的 mdl-1 实例
    expect(world.calls.setModel).toHaveLength(1);
    expect(world.calls.setModel[0]![2]).toEqual({ provider: "prov-x", id: "mdl-1", name: "Runtime One", vision: true, contextWindow: 128000 });
  });

  it("busy 排队：pendingModelSpec 落 entry + model_switched(queued/after-run)，不触 seam.setModel", async () => {
    const world = makeWorld();
    const mgr = makeMgr(world);
    const seed = makeEntry({ busy: true });
    mgr.sessions.set("c1", seed.entry);

    const res = await mgr.setModel("c1", "prov-b/mdl-b");

    expect(res).toEqual({ ok: true, model: "prov-b/mdl-b", pending: true, current: "prov-x/mdl-1" });
    expect(seed.entry.pendingModelSpec).toBe("prov-b/mdl-b");
    expect(seed.emitted).toHaveLength(1);
    expect(seed.emitted[0].type).toBe("model_switched");
    expect(world.calls.setModel).toEqual([]);
  });

  it("回退生效：首选 setModel 可重试失败 → configured 回退成功，reason=fallback + modelFallbackSpec/from 落 entry", async () => {
    const world = makeWorld({
      configuredModel: "prov-b/mdl-b",
      setModelImpl: (_call, attempt) => { if (attempt === 1) { const e = new Error("boom"); (e as any).status = 503; throw e; } },
    });
    const mgr = makeMgr(world);
    const seed = makeEntry();
    mgr.sessions.set("c1", seed.entry);

    const res = await mgr.setModel("c1", "prov-x/mdl-1");

    expect(res).toEqual({ ok: true, model: "prov-b/mdl-b", from: "prov-x/mdl-1", modelFallbackFrom: "prov-x/mdl-1", fallback: true });
    expect(seed.entry.modelFallbackSpec).toBe("prov-b/mdl-b");
    expect(seed.entry.modelFallbackFrom).toBe("prov-x/mdl-1");
    expect(seed.emitted).toHaveLength(1);
    // 首选失败 + 回退成功各一次
    expect(world.calls.setModel).toHaveLength(2);
    expect(world.calls.setModel[0]![2]).toEqual({ provider: "prov-x", id: "mdl-1", name: "Runtime One", vision: true, contextWindow: 128000 });
    expect(world.calls.setModel[1]![2]).toEqual({ provider: "prov-b", id: "mdl-b", contextLength: 64000 });
  });

  it("不可重试（认证错误）：applyModelSpec 原样抛出，无 model_switched 事件", async () => {
    const world = makeWorld({
      configuredModel: "prov-b/mdl-b",
      setModelImpl: () => { throw new Error("401 invalid api key"); },
    });
    const mgr = makeMgr(world);
    const seed = makeEntry();
    mgr.sessions.set("c1", seed.entry);

    await expect(mgr.setModel("c1", "prov-x/mdl-1")).rejects.toThrow("401 invalid api key");
    expect(seed.emitted).toEqual([]);
    expect(world.calls.setModel).toHaveLength(1); // 单侧一次，无回退
  });

  it("无 entry：经 getOrCreate → _create 创建后应用（cwd 兜底 getWorkspace 透传 _create）", async () => {
    const world = makeWorld();
    const mgr = makeMgr(world);
    stubCreate(mgr);

    const res = await mgr.setModel("c9", "prov-b/mdl-new");

    expect(res).toEqual({ ok: true, model: "prov-b/mdl-new", from: "prov-x/mdl-1" });
    expect(mgr.sessions.has("c9")).toBe(true);
  });
});

describe("B6-6-4c 模型族：applyModelSpec", () => {
  it("无效 spec 四样本：无斜线/空 provider/尾斜线/空串 → MODEL_SPEC_INVALID", async () => {
    const world = makeWorld();
    const mgr = makeMgr(world);
    for (const spec of ["nodash", "prov/", "/model", ""]) {
      await expect(mgr.applyModelSpec(makeEntry().entry, spec)).rejects.toMatchObject({ code: "MODEL_SPEC_INVALID" });
    }
    expect(world.calls.setModel).toEqual([]);
  });

  it("provider 不在本地目录：原样抛 model is not in local Pi catalog", async () => {
    const world = makeWorld();
    const mgr = makeMgr(world);
    await expect(mgr.applyModelSpec(makeEntry().entry, "ghost/m1")).rejects.toThrow("model is not in local Pi catalog: ghost/m1");
  });

  it("model not found：目录内有 provider 但 runtime+stored 均无该 id", async () => {
    const world = makeWorld({ getModelOut: null });
    const mgr = makeMgr(world);
    await expect(mgr.applyModelSpec(makeEntry().entry, "prov-b/missing")).rejects.toThrow("model not found: prov-b/missing");
  });

  it("无默认模型（configured 为空串）：失败后原样抛，不回退", async () => {
    const world = makeWorld({
      configuredModel: "",
      setModelImpl: () => { const e = new Error("boom"); (e as any).status = 503; throw e; },
    });
    const mgr = makeMgr(world);
    await expect(mgr.applyModelSpec(makeEntry().entry, "prov-x/mdl-1")).rejects.toThrow("boom");
    expect(world.calls.setModel).toHaveLength(1); // 单侧一次
  });

  it("回退即目标（configured === specText）：失败后原样抛，不重复 setModel", async () => {
    const world = makeWorld({
      configuredModel: "prov-x/mdl-1",
      setModelImpl: () => { const e = new Error("boom"); (e as any).status = 503; throw e; },
    });
    const mgr = makeMgr(world);
    await expect(mgr.applyModelSpec(makeEntry().entry, "prov-x/mdl-1")).rejects.toThrow("boom");
    expect(world.calls.setModel).toHaveLength(1);
  });

  it("成功：清空 modelFallback 字段并返回 { ok, model, from }", async () => {
    const world = makeWorld();
    const mgr = makeMgr(world);
    const seed = makeEntry({ modelFallbackSpec: "stale/spec", modelFallbackFrom: "old/m" });
    const res = await mgr.applyModelSpec(seed.entry, "prov-x/mdl-1");
    expect(res).toEqual({ ok: true, model: "prov-x/mdl-1", from: "prov-x/mdl-1" });
    expect(seed.entry.modelFallbackSpec).toBe("");
    expect(seed.entry.modelFallbackFrom).toBeNull();
  });
});

describe("B6-6-4c 模型族：probeModel", () => {
  it("成功归一：text 提取合并截断 80、usage 补零、responseModel 回退 model 字段", async () => {
    const world = makeWorld({
      probeOut: {
        latencyMs: 1234,
        response: {
          stopReason: "stop",
          model: "fallback-response-model",
          content: [
            { type: "text", text: "x".repeat(100) },
            { type: "thinking", text: "should be ignored" },
            { type: "text", text: "y" },
          ],
          usage: { input: 10, totalTokens: 30 },
        },
      },
    });
    const mgr = makeMgr(world);
    const res = await mgr.probeModel("prov-x/mdl-1", { timeoutMs: 5000 });
    expect(res).toEqual({
      ok: true,
      model: "prov-x/mdl-1",
      provider: "prov-x",
      latencyMs: 1234,
      response: {
        stopReason: "stop",
        responseModel: "fallback-response-model",
        preview: "x".repeat(80),
        usage: { input: 10, output: 0, totalTokens: 30 },
      },
    });
    expect(world.calls.probeModel).toHaveLength(1); // 单侧一次
    expect(world.calls.probeModel[0]![1]).toEqual({ timeoutMs: 5000 });
  });

  it("无 content / 无 usage：preview 空串、usage/stopReason/responseModel null", async () => {
    const world = makeWorld({ probeOut: { latencyMs: 5, response: {} } });
    const mgr = makeMgr(world);
    const res = await mgr.probeModel("prov-x/mdl-1");
    expect(res.response.preview).toBe("");
    expect(res.response.usage).toBeNull();
    expect(res.response.stopReason).toBeNull();
    expect(res.response.responseModel).toBeNull();
  });

  it("三错误分支：INVALID / NOT_IN_CATALOG / NOT_FOUND", async () => {
    const world = makeWorld({ getModelOut: null });
    const mgr = makeMgr(world);
    await expect(mgr.probeModel("bad")).rejects.toMatchObject({ code: "MODEL_SPEC_INVALID" });
    await expect(mgr.probeModel("ghost/m1")).rejects.toMatchObject({ code: "MODEL_NOT_IN_CATALOG" });
    await expect(mgr.probeModel("prov-b/missing")).rejects.toMatchObject({ code: "MODEL_NOT_FOUND" });
    expect(world.calls.probeModel).toEqual([]);
  });
});

describe("B6-6-4c 模型族：fallbackModel", () => {
  it("跨 provider 优先：tried prov-x → 选 configured 命中的 prov-b 模型并落 entry", async () => {
    const world = makeWorld({ configuredModel: "prov-b/mdl-b" });
    const mgr = makeMgr(world);
    const seed = makeEntry();
    const res = await mgr.fallbackModel(seed.entry, ["prov-x/mdl-1"]);
    expect(res).toBe("prov-b/mdl-b");
    expect(seed.entry.modelFallbackSpec).toBe("prov-b/mdl-b");
    expect(seed.entry.modelFallbackFrom).toBe("prov-x/mdl-1");
    expect(world.calls.setModel).toHaveLength(1); // 单侧一次
  });

  it("同 provider 回退：available 仅 prov-x 且 runtime+stored 均缺失 → null；单字符串 triedSpecs 兼容", async () => {
    const world = makeWorld({
      configuredModel: "nope/none",
      catalog: (() => {
        const base = makeCatalog();
        return { ...base, available: [{ provider: "prov-x", id: "mdl-x" }] };
      })(),
      getModelOut: null,
    });
    const mgr = makeMgr(world);
    const res = await mgr.fallbackModel(makeEntry().entry, "prov-b/mdl-b");
    expect(res).toBeNull();
  });

  it("全部 tried → 无候选返回 null", async () => {
    const world = makeWorld({ configuredModel: "prov-x/mdl-x" });
    const mgr = makeMgr(world);
    const tried = ["prov-x/mdl-x", "prov-b/mdl-b", "prov-b/mdl-new", "prov-b/mdl-b2", "prov-x/mdl-1"];
    const res = await mgr.fallbackModel(makeEntry().entry, tried);
    expect(res).toBeNull();
    expect(world.calls.setModel).toEqual([]);
  });

  it("成功链：tried 空 → configured 首选命中 available，failedProvider 为空串放行", async () => {
    const world = makeWorld({ configuredModel: "prov-b/mdl-b" });
    const mgr = makeMgr(world);
    const res = await mgr.fallbackModel(makeEntry().entry, []);
    expect(res).toBe("prov-b/mdl-b");
  });
});

describe("B6-6-4c 模型族：listModelCatalog / listModels", () => {
  it("合并覆盖序 + normalize 取值链 + deny 过滤 + counts 全形状", async () => {
    const world = makeWorld();
    const mgr = makeMgr(world);
    const res = await mgr.listModelCatalog();
    // 关键聚合显式断言。现状固化：isDenied 作用于 normalize 后条目（id 已含
    // provider 前缀），DENY_MODELS 的单前缀键永不命中，实际仅 DENY_PROVIDERS（new-provider）过滤生效。
    expect(res.counts).toEqual({ available: 2, configured: 6, stored: 5, listed: 7 });
    expect(res.source).toBe("pi-model-runtime+models-store");
    expect(res.models.map((m: any) => m.id)).toEqual([
      "prov-x/mdl-1",       // stored 覆盖 runtime（contextWindow 99000/name Stored One）
      "prov-b/mdl-b",       // available 覆盖 runtime（name Avail B，contextLength 64000）
      "prov-b/mdl-b2",      // limit.context 32000
      "prov-b/mdl-new",
      "xiaomi-token-plan-cn/mimo-v2.5-pro",
      "xiaomi-token-plan-cn/mimo-x",
      "prov-x/mdl-x",
    ]);
    expect(res.models[0]).toEqual({ id: "prov-x/mdl-1", provider: "prov-x", name: "Stored One", vision: false, available: false, contextWindow: 99000 });
    expect(res.configured.map((m: any) => m.id)).toEqual(["prov-x/mdl-1", "prov-b/mdl-b", "prov-b/mdl-b2", "prov-b/mdl-new", "xiaomi-token-plan-cn/mimo-v2.5-pro", "xiaomi-token-plan-cn/mimo-x"]);
    expect(res.available.map((m: any) => m.id)).toEqual(["prov-b/mdl-b", "prov-x/mdl-x"]);
    expect(res.authErrors).toEqual({});
  });

  it("authError 注入：条目标记 authError、available 置 false、catalog.available 剔除该 provider", async () => {
    const world = makeWorld({
      credentialErrors: { "prov-b": { at: "2026-01-01T00:00:00.000Z", message: "401 unauthorized" } },
    });
    const mgr = makeMgr(world);
    const res = await mgr.listModelCatalog();
    const b = res.models.find((m: any) => m.id === "prov-b/mdl-b");
    expect(b.authError).toBe("401 unauthorized");
    expect(b.available).toBe(false);
    expect(res.available.map((m: any) => m.id)).toEqual(["prov-x/mdl-x"]);
    expect(res.authErrors).toEqual({ "prov-b": { at: "2026-01-01T00:00:00.000Z", message: "401 unauthorized" } });
  });

  it("listModels：与 catalog.models 同一数组", async () => {
    const world = makeWorld();
    const mgr = makeMgr(world);
    const res = await mgr.listModels();
    expect(res).toEqual((await mgr.listModelCatalog()).models);
  });
});

describe("B6-6-4c 模型族：refreshModels / disposeAll", () => {
  it("refreshModels：resetModelRuntime 先行、refresh 携 allowNetwork+signal、返回 catalog.models", async () => {
    const world = makeWorld();
    const mgr = makeMgr(world);
    const res = await mgr.refreshModels();
    expect(res).toEqual((await mgr.listModelCatalog()).models);
    expect(world.calls.resetModelRuntime).toBe(1); // 单侧一次
    expect(world.calls.refresh).toHaveLength(1);
    expect(world.calls.refresh[0].allowNetwork).toBe(true);
    expect(world.calls.refresh[0].signal).toBeInstanceOf(AbortSignal);
  });

  it("refreshModels：网络失败续用本地缓存（warn 不抛）+ AbortError 静默", async () => {
    const warnCalls: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: any[]) => warnCalls.push(args.join(" "));
    try {
      const world = makeWorld({ refreshImpl: async () => { throw new Error("getaddrinfo ENOTFOUND"); } });
      const mgr = makeMgr(world);
      const res = await mgr.refreshModels();
      expect(res).toEqual((await mgr.listModelCatalog()).models);
      expect(warnCalls.length).toBeGreaterThanOrEqual(1);
      expect(warnCalls[0]).toContain("[models] 远程目录刷新失败");

      warnCalls.length = 0;
      const world2 = makeWorld({ refreshImpl: async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; } });
      const mgr2 = makeMgr(world2);
      const res2 = await mgr2.refreshModels();
      expect(res2).toEqual((await mgr2.listModelCatalog()).models);
      expect(warnCalls).toEqual([]);
    } finally {
      console.warn = origWarn;
    }
  });

  it("disposeAll：seam 收到 entries 快照，sessions 清空", async () => {
    const world = makeWorld();
    const mgr = makeMgr(world);
    mgr.sessions.set("c1", makeEntry().entry);
    await mgr.disposeAll();
    expect(mgr.sessions.size).toBe(0);
    expect(world.calls.disposeAll).toHaveLength(1); // 单侧一次
    expect(world.calls.disposeAll[0]).toHaveLength(1);
    expect(world.calls.disposeAll[0]![0].runtimeId).toBe("rt1");
  });
});
