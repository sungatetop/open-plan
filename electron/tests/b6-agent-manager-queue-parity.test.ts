/**
 * B6-6-4d 单侧行为覆盖：AgentManager 队列压缩批。
 *
 * R6-6b 对拍退役改写：旧 server/agent.mjs 对拍机制（行号提取 + new Function 求值）移除，
 * 保留 TS 侧行为断言。
 *
 * 覆盖：_enqueuePrompt（空闲直通/busy 排队信封/queuedCount 顺延/compactionPromise 吞错/
 * 前链失败不阻断/参数透传与返回值）/ resolveEntryContextWindowInfo（session_model 直取含
 * contextLength 变体/catalog 命中含 id 后缀 pop/default_fallback）/ resolveEntryContextWindow /
 * resolveCompactionPolicy（pi-native 含 deps 定制 reserveTokens/manual 关闭/app-fallback）/
 * _maybeCompact（promptChars=0/compacting/cooldown 三不压缩/known 交 Pi SDK/显式关闭/
 * precise 命中压缩全字段/observed 三和/estimated 兜底/全低不压缩/压缩失败双事件 + 不置
 * lastCompactionAt）/ usageSnapshot（null/usage.contextTokens 优先 + 浅拷贝/三和含 cache_read
 * 别名/estimated 兜底/pi-native keepRecentTokens/manual null）。
 *
 * piRuntimeManager（pi 域未迁）、contextTokensFromUsage（pi 域纯函数）、localStoredModels
 * 经 AgentManagerDeps 注入测试 stub。_promptEntry 未迁（4e 批），实例覆写注入。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentManager,
  type AgentManagerDeps,
  UNKNOWN_MODEL_AUTO_COMPACT_INPUT_TOKENS,
  PI_COMPACTION_POLICY_DEFAULT,
  AUTO_COMPACT_COOLDOWN_MS,
  DEFAULT_CONTEXT_WINDOW,
  ESTIMATED_TOKENS_PER_CHAR,
} from "../src/main/backend/agent/agent-manager";
import { AUTO_COMPACT_PROMPT_CHARS } from "../src/main/backend/agent/agent-errors";
import { turnBudgetPolicy } from "../src/shared/runtime/turn-budget";

// 冻结时钟：queueWaitMs/compactionCheckMs/lastCompactionAt 取 Date.now()，emitChannelSafe 信封
// 含 at=ISO 时间戳（4a-4c 同口径）
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("B6-6-4d 常量锚点", () => {
  it("队列压缩族常量逐值锚定 + PI_COMPACTION_POLICY_DEFAULT 同值", () => {
    expect(UNKNOWN_MODEL_AUTO_COMPACT_INPUT_TOKENS).toBe(26000);
    expect(AUTO_COMPACT_COOLDOWN_MS).toBe(10000);
    expect(DEFAULT_CONTEXT_WINDOW).toBe(1_000_000);
    expect(ESTIMATED_TOKENS_PER_CHAR).toBe(3.5);
    expect(AUTO_COMPACT_PROMPT_CHARS).toBe(90000);
    expect(PI_COMPACTION_POLICY_DEFAULT).toEqual({ reserveTokens: 16384, keepRecentTokens: 20000 });
    expect(Object.isFrozen(PI_COMPACTION_POLICY_DEFAULT)).toBe(true);
  });
});

/** 会话 entry 种子（无 model 字段 = unknown 模型；promptChain/queuedCount 为 _enqueuePrompt 前置字段）。 */
function makeEntry(overrides: Record<string, unknown> = {}) {
  const emitted: any[] = [];
  const entry: any = {
    runtimeId: "rt1",
    session: { sessionId: "s-1", sessionFile: "/store/s-1.jsonl" },
    channel: {
      streamId: "stream_test",
      seq: 0,
      history: [] as any[],
      historyLimit: 0,
      lastEmitAt: 0,
      emitter: { emit: (_type: string, ev: any) => { emitted.push(ev); return true; } },
    },
    promptChain: Promise.resolve(),
    queuedCount: 0,
    promptChars: 0,
    lastUsage: null,
    ...overrides,
  };
  return { entry, emitted };
}

/** _promptEntry 实例覆写（4e 批未迁）；calls 记录调用序列。 */
function stubPromptEntry(mgr: any, impl?: (call: any) => any) {
  const calls: any[] = [];
  mgr._promptEntry = async (entry: any, text: unknown, images: unknown, effort: unknown, references: unknown, runContext: unknown) => {
    const call = { entry, text, images, effort, references, runContext };
    calls.push(call);
    if (impl) return impl(call);
    return { done: true, text };
  };
  return calls;
}

/** 依赖世界：seam stub 记录调用序列（calls 为单侧调用序列）。 */
function makeWorld(opts: {
  piCompaction?: { reserveTokens: number; keepRecentTokens: number };
  contextTokensImpl?: (usage: any) => number | null;
  getContextUsageOut?: any;
  compactOut?: any;
  compactImpl?: (entry: any) => Promise<any>;
  storedModels?: any[];
} = {}) {
  const calls = {
    getContextUsage: [] as any[][],
    compact: [] as any[][],
    localStored: [] as unknown[],
    ctxTokens: [] as unknown[],
  };
  const piRuntimeManager = {
    getContextUsage: (runtimeId: unknown, session: unknown) => {
      calls.getContextUsage.push([runtimeId, session]);
      return "getContextUsageOut" in opts ? opts.getContextUsageOut : null;
    },
    compact: async (runtimeId: unknown, session: unknown, instructions: string) => {
      calls.compact.push([runtimeId, session, instructions]);
      if (opts.compactImpl) return opts.compactImpl((piRuntimeManager as any).__lastEntry ?? null);
      return opts.compactOut ?? { ok: true };
    },
    // 其余 seam 方法：本批场景不触达，no-op 满足 AgentPiRuntimeSeam 类型
    modelRuntime: async () => ({}),
    dispose: () => {},
    getSessionTree: () => null,
    navigateSessionTree: async () => ({}),
    abort: async () => {},
    health: () => null,
    markRecovery: () => {},
    listSnapshots: () => [],
    schedulerSnapshot: () => ({}),
    setModel: async () => {},
    probeModel: async () => ({}),
    resetModelRuntime: () => {},
    disposeAll: async () => {},
    // B6-6-4e 扩员的 seam 方法：queue 批场景不触达，no-op 满足 AgentPiRuntimeSeam 类型
    prompt: () => {},
    runPrompt: async (_runtimeId: unknown, operation: () => Promise<any>) => operation(),
    setActiveTools: () => {},
    update: () => {},
    setThinkingLevel: () => {},
  };
  const piCompactionPolicy = opts.piCompaction ?? { reserveTokens: 16384, keepRecentTokens: 20000 };
  const contextTokensFromUsage = (usage: unknown) => {
    calls.ctxTokens.push(usage);
    return opts.contextTokensImpl ? opts.contextTokensImpl(usage) : null;
  };
  const localStoredModels = (p?: Set<string>) => { calls.localStored.push(p); return opts.storedModels ?? []; };
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
    contextTokensFromUsage,
    piCompactionPolicy,
    localStoredModels,
    emitDeps,
  };
  (piRuntimeManager as any).__lastEntry = null;
  return { deps, calls, emitDeps, piCompactionPolicy, piRuntimeManager };
}

/** 实例：AgentManager + 同一 deps。 */
function makeMgr(world: ReturnType<typeof makeWorld>) {
  return new AgentManager(world.deps);
}

describe("B6-6-4d resolveEntryContextWindowInfo / resolveEntryContextWindow", () => {
  it("session_model 直取：contextWindow 优先、contextLength 变体兜底", () => {
    const world = makeWorld();
    const mgr = makeMgr(world);
    const res = mgr.resolveEntryContextWindowInfo(makeEntry({ session: { model: { contextWindow: 128000 } } }).entry);
    expect(res).toEqual({ contextWindow: 128000, known: true, source: "session_model" });
    const res2 = mgr.resolveEntryContextWindowInfo(makeEntry({ session: { model: { contextLength: 64000 } } }).entry);
    expect(res2).toEqual({ contextWindow: 64000, known: true, source: "session_model" });
  });

  it("catalog 命中：id 完整匹配 + provider/model 斜杠后缀 pop 匹配", () => {
    const world = makeWorld({ storedModels: [{ id: "prov-b/mdl-b", contextWindow: 64000 }] });
    const mgr = makeMgr(world);
    const res = mgr.resolveEntryContextWindowInfo(makeEntry({ session: { model: { id: "mdl-b" } } }).entry);
    expect(res).toEqual({ contextWindow: 64000, known: true, source: "model_catalog" });
    // 完整 id 命中
    const res2 = mgr.resolveEntryContextWindowInfo(makeEntry({ session: { model: { id: "prov-b/mdl-b" } } }).entry);
    expect(res2.source).toBe("model_catalog");
    // 单侧两次调用（无参）
    expect(world.calls.localStored).toHaveLength(2);
  });

  it("default_fallback：无 model / modelId 无命中 → DEFAULT_CONTEXT_WINDOW 且 known=false", () => {
    const world = makeWorld({ storedModels: [{ id: "other/m" }] });
    const mgr = makeMgr(world);
    const res = mgr.resolveEntryContextWindowInfo(makeEntry().entry);
    expect(res).toEqual({ contextWindow: 1_000_000, known: false, source: "default_fallback" });
    const res2 = mgr.resolveEntryContextWindowInfo(makeEntry({ session: { model: { id: "ghost" } } }).entry);
    expect(res2).toEqual({ contextWindow: 1_000_000, known: false, source: "default_fallback" });
  });

  it("resolveEntryContextWindow：透传 contextWindow 数值", () => {
    const world = makeWorld();
    const mgr = makeMgr(world);
    const seed = { session: { model: { contextWindow: 200000 } } };
    expect(mgr.resolveEntryContextWindow(makeEntry(seed).entry)).toBe(200000);
  });
});

describe("B6-6-4d resolveCompactionPolicy", () => {
  it("pi-native：known + autoCompaction 未关 → threshold=window-reserveTokens；deps 定制 reserveTokens 生效", () => {
    const world = makeWorld();
    const mgr = makeMgr(world);
    const seed = { session: { model: { contextWindow: 128000 } } };
    const res = mgr.resolveCompactionPolicy(makeEntry(seed).entry);
    expect(res).toEqual({
      mode: "pi-native", source: "pi-sdk", enabled: true, contextWindow: 128000,
      threshold: 128000 - 16384, reserveTokens: 16384,
    });
    // deps 注入定制压缩策略
    const world2 = makeWorld({ piCompaction: { reserveTokens: 100, keepRecentTokens: 50 } });
    const mgr2 = makeMgr(world2);
    const res2 = mgr2.resolveCompactionPolicy(makeEntry(seed).entry);
    expect(res2).toEqual({
      mode: "pi-native", source: "pi-sdk", enabled: true, contextWindow: 128000,
      threshold: 128000 - 100, reserveTokens: 100,
    });
  });

  it("manual：autoCompactionEnabled=false → enabled=false、threshold/reserveTokens 均 null", () => {
    const world = makeWorld();
    const mgr = makeMgr(world);
    const seed = { session: { model: { contextWindow: 128000 }, autoCompactionEnabled: false } };
    const res = mgr.resolveCompactionPolicy(makeEntry(seed).entry);
    expect(res).toEqual({ mode: "manual", source: "disabled", enabled: false, contextWindow: 128000, threshold: null, reserveTokens: null });
  });

  it("app-fallback：unknown + 未关 → threshold=UNKNOWN_MODEL_AUTO_COMPACT_INPUT_TOKENS、source 透传窗口来源", () => {
    const world = makeWorld();
    const mgr = makeMgr(world);
    const res = mgr.resolveCompactionPolicy(makeEntry().entry);
    expect(res).toEqual({
      mode: "app-fallback", source: "default_fallback", enabled: true,
      contextWindow: 1_000_000, threshold: 26000, reserveTokens: null,
    });
  });
});

describe("B6-6-4d _maybeCompact 前置短路", () => {
  it("promptChars=0 / compacting=true / cooldown 内 → 三不压缩（compact 0 次）", async () => {
    const world = makeWorld();
    const mgr = makeMgr(world);
    await mgr._maybeCompact(makeEntry({ promptChars: 0 }).entry);
    await mgr._maybeCompact(makeEntry({ promptChars: 500000, compacting: true }).entry);
    await mgr._maybeCompact(makeEntry({ promptChars: 500000, lastCompactionAt: Date.now() }).entry);
    expect(world.calls.compact).toEqual([]);
    expect(world.calls.getContextUsage).toEqual([]); // 前置短路不触 U1 精确用量
  });

  it("known 模型（未显式关闭）→ 交 Pi SDK，不压缩；显式 autoCompactionEnabled=false → 也不压缩", async () => {
    const world = makeWorld({ contextTokensImpl: () => 999999 });
    const mgr = makeMgr(world);
    const knownSeed = { promptChars: 500000, session: { model: { contextWindow: 128000 } } };
    await mgr._maybeCompact(makeEntry(knownSeed).entry);
    const disabledSeed = { promptChars: 500000, session: { autoCompactionEnabled: false } };
    await mgr._maybeCompact(makeEntry(disabledSeed).entry);
    expect(world.calls.compact).toEqual([]);
    expect(world.calls.getContextUsage).toEqual([]); // known/disabled 在 U1 之前返回
  });
});

describe("B6-6-4d _maybeCompact 压缩路径", () => {
  it("precise 命中：getContextUsage.usage → contextTokensFromUsage ≥ 阈值 → 压缩成功全字段", async () => {
    const world = makeWorld({ contextTokensImpl: () => 30000, getContextUsageOut: { usage: { contextTokens: 30000 } } });
    const mgr = makeMgr(world);
    const seed = makeEntry({ promptChars: 350000, lastUsage: { inputTokens: 1 } });
    const runCtx = { runId: "run-1" };
    await mgr._maybeCompact(seed.entry, runCtx);

    expect(world.calls.compact).toHaveLength(1);
    expect(world.calls.compact[0]![2]).toBe("保留当前项目事实、用户偏好、已完成产物路径、未完成任务和下一步；删除重复的工具输出与旧过程细节。");
    const e = seed.entry;
    expect(e.promptChars).toBe(0);
    expect(e.lastUsage).toBeNull();
    expect(e.lastCompactionAt).toBe(Date.now());
    // finally 复位
    expect(e.compactionPromise).toBeNull();
    expect(e.compactionRunId).toBeNull();
    expect(e.compactionKind).toBeNull();
    expect(e.autoCompacting).toBe(false);
    expect(e.compacting).toBe(false);
    expect(seed.emitted).toEqual([]);
    expect(world.calls.ctxTokens[0]).toEqual({ contextTokens: 30000 }); // preciseUsage?.usage ?? preciseUsage
  });

  it("precise 为空 → observed 三和（input+cacheRead+cacheWrite）命中压缩", async () => {
    const world = makeWorld(); // contextTokensFromUsage 恒 null
    const mgr = makeMgr(world);
    const seed = { promptChars: 10, lastUsage: { input: 20000, cacheRead: 8000, cacheWrite: 2000 } };
    await mgr._maybeCompact(makeEntry(seed).entry);
    expect(world.calls.compact).toHaveLength(1);
    expect(world.calls.getContextUsage).toHaveLength(1);
  });

  it("estimated 兜底：observed 0、promptChars=350000 → estimated=100000 ≥ min(26000, 25715) → 压缩", async () => {
    const world = makeWorld();
    const mgr = makeMgr(world);
    await mgr._maybeCompact(makeEntry({ promptChars: 350000 }).entry, { runId: "run-2" });
    expect(world.calls.compact).toHaveLength(1);
    expect(world.calls.compact[0]![2]).toContain("保留当前项目事实");
  });

  it("全低不压缩：observed 与 estimated 均低于 estimatedFallbackThreshold", async () => {
    const world = makeWorld();
    const mgr = makeMgr(world);
    await mgr._maybeCompact(makeEntry({ promptChars: 1000, lastUsage: { inputTokens: 100 } }).entry);
    expect(world.calls.compact).toEqual([]);
  });

  it("压缩失败：context_compact_warning + compaction_failed 双事件、lastCompactionAt 不置、promptChars 保留", async () => {
    const world = makeWorld({ compactImpl: async () => { throw new Error("compact boom"); } });
    const mgr = makeMgr(world);
    const seed = makeEntry({ promptChars: 350000, activeRunId: "run-3" });
    await mgr._maybeCompact(seed.entry);

    expect(seed.emitted.map((e: any) => e.type)).toEqual(["context_compact_warning", "compaction_failed"]);
    expect(seed.emitted[0].data).toEqual({ runId: "run-3", message: "compact boom" });
    expect(seed.emitted[1].data).toEqual({ runId: "run-3", reason: "automatic", aborted: false, errorMessage: "compact boom" });
    expect(seed.entry.lastCompactionAt).toBeUndefined(); // 未压缩成功不置冷却
    expect(seed.entry.promptChars).toBe(350000);
    expect(seed.entry.compacting).toBe(false);
    expect(seed.entry.compactionPromise).toBeNull();
  });
});

describe("B6-6-4d _enqueuePrompt", () => {
  it("空闲直通：无 agent_queued、queuedCount 1→0、queueWaitMs/compactionCheckMs=0、参数透传与返回值", async () => {
    const world = makeWorld();
    const mgr = makeMgr(world);
    const seed = makeEntry();
    const calls = stubPromptEntry(mgr);

    const payload = { text: "hello", images: ["img"], effort: "high", references: ["r1"], runContext: { runId: "run-9" } };
    const res = await mgr._enqueuePrompt(seed.entry, payload);

    expect(res).toEqual({ done: true, text: "hello" });
    expect(calls[0]).toEqual({ entry: seed.entry, text: "hello", images: ["img"], effort: "high", references: ["r1"], runContext: { runId: "run-9" } });
    expect(calls[0].text).toBe("hello");
    expect(calls[0].references).toEqual(["r1"]);
    expect(seed.emitted).toEqual([]); // 空闲不发 agent_queued
    expect(seed.entry.queuedCount).toBe(0);
    expect(seed.entry.queueWaitMs).toBe(0); // 冻结时钟
    expect(seed.entry.compactionCheckMs).toBe(0);
  });

  it("busy 排队：agent_queued 信封（runId/position/queued）、queuedCount 复位、等待上一轮", async () => {
    const world = makeWorld();
    const mgr = makeMgr(world);
    // 挂一个 in-flight 链：busy=true + promptChain 悬挂，验证排队后再执行
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const seed = makeEntry({ busy: true, promptChain: gate });
    const calls = stubPromptEntry(mgr);

    const op = mgr._enqueuePrompt(seed.entry, { text: "q1", images: [], effort: undefined, references: [], runContext: { runId: "run-q" } });
    expect(seed.entry.queuedCount).toBe(1);
    expect(seed.emitted).toHaveLength(1);
    expect(seed.emitted[0].type).toBe("agent_queued");
    expect(seed.emitted[0].data).toEqual({ runId: "run-q", position: 1, queued: 0 });

    release();
    await op;
    expect(seed.entry.queuedCount).toBe(0);
    expect(calls[0].text).toBe("q1");
    expect(seed.entry.queueWaitMs).toBe(0);
  });

  it("queuedCount>0：position=queuedCount+1 顺延", async () => {
    const world = makeWorld();
    const mgr = makeMgr(world);
    const seed = makeEntry({ queuedCount: 2 });
    stubPromptEntry(mgr);
    const op = mgr._enqueuePrompt(seed.entry, { text: "x", images: [], effort: undefined, references: [], runContext: null });
    expect(seed.emitted[0].data).toEqual({ runId: null, position: 3, queued: 2 });
    await op;
  });

  it("compactionPromise rejected：await 后吞错继续进入压缩检查", async () => {
    const world = makeWorld();
    const mgr = makeMgr(world);
    const rejected = Promise.reject(new Error("stale compaction"));
    const seed = makeEntry({ promptChars: 0, compactionPromise: rejected });
    const calls = stubPromptEntry(mgr);
    const op = mgr._enqueuePrompt(seed.entry, { text: "t", images: [], effort: undefined, references: [], runContext: null });
    await expect(op).resolves.toEqual({ done: true, text: "t" });
    expect(calls).toHaveLength(1);
    expect(seed.entry.compactionCheckMs).toBe(0);
  });

  it("前链失败不阻断：第一次 _promptEntry 抛错 → operation reject；第二次排队正常执行", async () => {
    const world = makeWorld();
    const mgr = makeMgr(world);
    const seed = makeEntry();
    let n = 0;
    const calls = stubPromptEntry(mgr, () => { n += 1; if (n === 1) throw new Error("first boom"); return { ok: n }; });

    await expect(mgr._enqueuePrompt(seed.entry, { text: "a", images: [], effort: undefined, references: [], runContext: null })).rejects.toThrow("first boom");
    const res = await mgr._enqueuePrompt(seed.entry, { text: "b", images: [], effort: undefined, references: [], runContext: null });
    expect(res).toEqual({ ok: 2 });
    expect(calls.map((c: any) => c.text)).toEqual(["a", "b"]);
    expect(seed.entry.queuedCount).toBe(0);
  });
});

describe("B6-6-4d usageSnapshot", () => {
  it("无 entry → null", () => {
    const world = makeWorld();
    const mgr = makeMgr(world);
    expect(mgr.usageSnapshot("missing")).toBeNull();
  });

  it("usage.contextTokens 优先 + pi-native keepRecentTokens + usage 浅拷贝", () => {
    const world = makeWorld();
    const mgr = makeMgr(world);
    const seed = {
      promptChars: 35000,
      lastUsage: { contextTokens: 5000, inputTokens: 1 },
      session: { model: { contextWindow: 128000 } },
    };
    expect(mgr.usageSnapshot("c1")).toBeNull();
    mgr.sessions.set("c1", makeEntry(seed).entry);
    const res = mgr.usageSnapshot("c1");
    expect(res).toEqual({
      usage: { contextTokens: 5000, inputTokens: 1 },
      contextChars: 35000,
      estimatedContextTokens: Math.ceil(35000 / 3.5),
      contextTokens: Math.max(5000, Math.ceil(35000 / 3.5)),
      contextWindow: 128000,
      compactThreshold: 128000 - 16384,
      compactThresholdSource: "pi-sdk",
      compactionMode: "pi-native",
      compactionEnabled: true,
      compactionReserveTokens: 16384,
      compactionKeepRecentTokens: 20000,
      turnBudget: turnBudgetPolicy(),
    });
    // usage 是浅拷贝：改快照不影响 entry.lastUsage
    res!.usage.contextTokens = 999;
    expect(mgr.sessions.get("c1").lastUsage.contextTokens).toBe(5000);
  });

  it("usage 无 contextTokens → 三和（cache_read/cache_write 别名变体）", () => {
    const world = makeWorld();
    const mgr = makeMgr(world);
    mgr.sessions.set("c1", makeEntry({ promptChars: 0, lastUsage: { input: 100, cache_read: 200, cache_write: 50 } }).entry);
    const res = mgr.usageSnapshot("c1");
    expect(res!.contextTokens).toBe(350);
  });

  it("usage null + promptChars → estimated 兜底；manual 模式 keepRecentTokens=null", () => {
    const world = makeWorld();
    const mgr = makeMgr(world);
    mgr.sessions.set("c1", makeEntry({ promptChars: 70000, session: { autoCompactionEnabled: false } }).entry);
    const res = mgr.usageSnapshot("c1");
    expect(res!.usage).toBeNull();
    expect(res!.contextTokens).toBe(Math.ceil(70000 / 3.5));
    expect(res!.compactionMode).toBe("manual");
    expect(res!.compactionEnabled).toBe(false);
    expect(res!.compactionKeepRecentTokens).toBeNull();
    expect(res!.compactThreshold).toBeNull();
  });
});
