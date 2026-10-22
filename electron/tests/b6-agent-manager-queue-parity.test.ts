/**
 * B6-6-4d 对拍：AgentManager 队列压缩批（server/agent.mjs L3578-3715 + L4370-4401）。
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
 * 旧侧按行号提取类体：L843-1018（类头+构造器+薄方法——sessions 字段初始化在构造器，不可省）
 * + L3578-3715（队列压缩族）+ L4370-4401（usageSnapshot）拼 class 表达式 + new Function 求值。
 * piRuntimeManager（pi 域未迁）、contextTokensFromUsage（pi 域纯函数）、localStoredModels 注入
 * 同一测试 stub 保同流；常量族以 TS 导出值注入旧工厂（AUTO_COMPACT_PROMPT_CHARS 自
 * agent-errors.ts，PI_COMPACTION 两标量自 world.piCompactionPolicy）；turnBudgetPolicy 注入
 * 同一 TS 实现。_promptEntry 未迁（4e 批），两侧实例覆写注入。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import {
  AgentManager,
  type AgentManagerDeps,
  UNKNOWN_MODEL_AUTO_COMPACT_INPUT_TOKENS,
  PI_COMPACTION_POLICY_DEFAULT,
  AUTO_COMPACT_COOLDOWN_MS,
  DEFAULT_CONTEXT_WINDOW,
  ESTIMATED_TOKENS_PER_CHAR,
} from "../src/main/backend/agent/agent-manager";
import { emitChannelSafe } from "../src/main/backend/agent/emit-helpers";
import { AUTO_COMPACT_PROMPT_CHARS } from "../src/main/backend/agent/agent-errors";
import { turnBudgetPolicy } from "../src/shared/runtime/turn-budget";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LINES_AGENT = readFileSync(path.resolve(HERE, "../../server/agent.mjs"), "utf8").split("\n");
const segAgent = (start: number, end: number) => LINES_AGENT.slice(start - 1, end).join("\n").replace(/^export\s+/gm, "");

// 冻结时钟：queueWaitMs/compactionCheckMs/lastCompactionAt 取 Date.now()，emitChannelSafe 信封
// 含 at=ISO 时间戳，双侧跨毫秒即比对失败（4a-4c 同口径）
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

// 行号锚点：源文件结构变动导致偏移时，这里先行失败提醒更新提取区间
expect(segAgent(843, 843)).toContain("class AgentManager extends EventEmitter {");
expect(segAgent(3578, 3578)).toContain("_enqueuePrompt(entry, payload) {");
expect(segAgent(3610, 3610)).toContain("resolveEntryContextWindowInfo(entry) {");
expect(segAgent(3622, 3622)).toContain("resolveEntryContextWindow(entry) {");
expect(segAgent(3626, 3626)).toContain("resolveCompactionPolicy(entry) {");
expect(segAgent(3659, 3659)).toContain("async _maybeCompact(entry, runContext = null) {");
expect(segAgent(3715, 3715)).toContain("}");
expect(segAgent(4370, 4370)).toContain("usageSnapshot(clientId) {");
expect(segAgent(4401, 4401)).toContain("}");

describe("B6-6-4d 常量锚点", () => {
  it("队列压缩族常量逐值对齐旧 agent.mjs L425-430 + PI_COMPACTION_POLICY_DEFAULT 同值", () => {
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

/** _promptEntry 两侧实例覆写（4e 批未迁）；calls 分侧记录，返回值/entry 引用互不串号。 */
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

/** 双侧共享依赖世界：seam stub 记录调用序列（calls 为双侧累加，断言计数 = 两侧之和）。 */
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

/** 旧侧类工厂：4a 段 + 队列压缩族 + usageSnapshot 拼 class，依赖同名参数注入。 */
function makeOldManager(world: ReturnType<typeof makeWorld>) {
  const Ctor = new Function(
    "EventEmitter",
    "RUNTIME_FLAGS",
    "piRuntimeManager",
    "contextTokensFromUsage",
    "localStoredModels",
    "localModelProviders",
    "DEFAULT_CONTEXT_WINDOW",
    "PI_COMPACTION_RESERVE_TOKENS",
    "PI_COMPACTION_KEEP_RECENT_TOKENS",
    "UNKNOWN_MODEL_AUTO_COMPACT_INPUT_TOKENS",
    "AUTO_COMPACT_COOLDOWN_MS",
    "ESTIMATED_TOKENS_PER_CHAR",
    "AUTO_COMPACT_PROMPT_CHARS",
    "emitChannelSafe",
    "emitAbortedOnce",
    "normalizeWorkspace",
    "getWorkspace",
    "configuredModelSpec",
    "findSessionFileForAgent",
    "isAbortLikeError",
    "getRun",
    "readPendingAsks",
    "resolvePendingAsk",
    "listStoredMemoryProposals",
    "approveStoredMemoryProposal",
    "editStoredMemoryProposal",
    "rejectStoredMemoryProposal",
    "mergeMemoryProposals",
    "getMemoryProposalHistory",
    "turnBudgetPolicy",
    `${segAgent(843, 1018)}
${segAgent(3578, 3715)}
${segAgent(4370, 4401)}
}
return AgentManager;`,
  )(
    EventEmitter,
    {}, // RUNTIME_FLAGS：agentBusyWatchdog 默认关，看门狗 interval 空转
    world.deps.piRuntimeManager,
    world.deps.contextTokensFromUsage,
    world.deps.localStoredModels,
    () => new Set<string>(),
    DEFAULT_CONTEXT_WINDOW,
    world.piCompactionPolicy.reserveTokens,
    world.piCompactionPolicy.keepRecentTokens,
    UNKNOWN_MODEL_AUTO_COMPACT_INPUT_TOKENS,
    AUTO_COMPACT_COOLDOWN_MS,
    ESTIMATED_TOKENS_PER_CHAR,
    AUTO_COMPACT_PROMPT_CHARS,
    (entry: any, type: string, data: any, o: any) => emitChannelSafe(entry, type, data, o, world.deps.emitDeps),
    () => false, // emitAbortedOnce（本批不触达，占位满足签名）
    (dir: unknown) => (dir == null || dir === "" ? null : `norm:${String(dir)}`),
    () => "/ws",
    () => "cfg/model-a",
    () => ({ fullPath: "/store/s-1.jsonl" }),
    () => false,
    () => null,
    () => [],
    () => null,
    () => [],
    () => ({ proposal: null }),
    () => ({ proposal: null }),
    () => ({ proposal: null }),
    () => ({}),
    () => [],
    turnBudgetPolicy,
  );
  return new Ctor() as any;
}

/** 新侧实例：AgentManager + 同一 deps。 */
function makeNewManager(world: ReturnType<typeof makeWorld>) {
  return new AgentManager(world.deps);
}

describe("B6-6-4d 对拍：resolveEntryContextWindowInfo / resolveEntryContextWindow", () => {
  it("session_model 直取：contextWindow 优先、contextLength 变体兜底", () => {
    const world = makeWorld();
    const oldMgr = makeOldManager(world);
    const newMgr = makeNewManager(world);
    const oldRes = oldMgr.resolveEntryContextWindowInfo(makeEntry({ session: { model: { contextWindow: 128000 } } }).entry);
    const newRes = newMgr.resolveEntryContextWindowInfo(makeEntry({ session: { model: { contextWindow: 128000 } } }).entry);
    expect(newRes).toEqual(oldRes);
    expect(oldRes).toEqual({ contextWindow: 128000, known: true, source: "session_model" });
    const oldRes2 = oldMgr.resolveEntryContextWindowInfo(makeEntry({ session: { model: { contextLength: 64000 } } }).entry);
    const newRes2 = newMgr.resolveEntryContextWindowInfo(makeEntry({ session: { model: { contextLength: 64000 } } }).entry);
    expect(newRes2).toEqual(oldRes2);
    expect(oldRes2).toEqual({ contextWindow: 64000, known: true, source: "session_model" });
  });

  it("catalog 命中：id 完整匹配 + provider/model 斜杠后缀 pop 匹配", () => {
    const world = makeWorld({ storedModels: [{ id: "prov-b/mdl-b", contextWindow: 64000 }] });
    const oldMgr = makeOldManager(world);
    const newMgr = makeNewManager(world);
    const oldRes = oldMgr.resolveEntryContextWindowInfo(makeEntry({ session: { model: { id: "mdl-b" } } }).entry);
    const newRes = newMgr.resolveEntryContextWindowInfo(makeEntry({ session: { model: { id: "mdl-b" } } }).entry);
    expect(newRes).toEqual(oldRes);
    expect(oldRes).toEqual({ contextWindow: 64000, known: true, source: "model_catalog" });
    // 完整 id 命中
    const oldRes2 = oldMgr.resolveEntryContextWindowInfo(makeEntry({ session: { model: { id: "prov-b/mdl-b" } } }).entry);
    const newRes2 = newMgr.resolveEntryContextWindowInfo(makeEntry({ session: { model: { id: "prov-b/mdl-b" } } }).entry);
    expect(newRes2).toEqual(oldRes2);
    expect(oldRes2.source).toBe("model_catalog");
    // 双侧各两次调用（无参）
    expect(world.calls.localStored).toHaveLength(4);
  });

  it("default_fallback：无 model / modelId 无命中 → DEFAULT_CONTEXT_WINDOW 且 known=false", () => {
    const world = makeWorld({ storedModels: [{ id: "other/m" }] });
    const oldMgr = makeOldManager(world);
    const newMgr = makeNewManager(world);
    const oldRes = oldMgr.resolveEntryContextWindowInfo(makeEntry().entry);
    const newRes = newMgr.resolveEntryContextWindowInfo(makeEntry().entry);
    expect(newRes).toEqual(oldRes);
    expect(oldRes).toEqual({ contextWindow: 1_000_000, known: false, source: "default_fallback" });
    const oldRes2 = oldMgr.resolveEntryContextWindowInfo(makeEntry({ session: { model: { id: "ghost" } } }).entry);
    const newRes2 = newMgr.resolveEntryContextWindowInfo(makeEntry({ session: { model: { id: "ghost" } } }).entry);
    expect(newRes2).toEqual(oldRes2);
    expect(oldRes2).toEqual({ contextWindow: 1_000_000, known: false, source: "default_fallback" });
  });

  it("resolveEntryContextWindow：透传 contextWindow 数值", () => {
    const world = makeWorld();
    const oldMgr = makeOldManager(world);
    const newMgr = makeNewManager(world);
    const seed = { session: { model: { contextWindow: 200000 } } };
    expect(oldMgr.resolveEntryContextWindow(makeEntry(seed).entry)).toBe(200000);
    expect(newMgr.resolveEntryContextWindow(makeEntry(seed).entry)).toBe(200000);
  });
});

describe("B6-6-4d 对拍：resolveCompactionPolicy", () => {
  it("pi-native：known + autoCompaction 未关 → threshold=window-reserveTokens；deps 定制 reserveTokens 生效", () => {
    const world = makeWorld();
    const oldMgr = makeOldManager(world);
    const newMgr = makeNewManager(world);
    const seed = { session: { model: { contextWindow: 128000 } } };
    const oldRes = oldMgr.resolveCompactionPolicy(makeEntry(seed).entry);
    const newRes = newMgr.resolveCompactionPolicy(makeEntry(seed).entry);
    expect(newRes).toEqual(oldRes);
    expect(oldRes).toEqual({
      mode: "pi-native", source: "pi-sdk", enabled: true, contextWindow: 128000,
      threshold: 128000 - 16384, reserveTokens: 16384,
    });
    // deps 注入定制压缩策略（双侧共用同一 piCompactionPolicy）
    const world2 = makeWorld({ piCompaction: { reserveTokens: 100, keepRecentTokens: 50 } });
    const oldMgr2 = makeOldManager(world2);
    const newMgr2 = makeNewManager(world2);
    const oldRes2 = oldMgr2.resolveCompactionPolicy(makeEntry(seed).entry);
    const newRes2 = newMgr2.resolveCompactionPolicy(makeEntry(seed).entry);
    expect(newRes2).toEqual(oldRes2);
    expect(oldRes2).toEqual({
      mode: "pi-native", source: "pi-sdk", enabled: true, contextWindow: 128000,
      threshold: 128000 - 100, reserveTokens: 100,
    });
  });

  it("manual：autoCompactionEnabled=false → enabled=false、threshold/reserveTokens 均 null", () => {
    const world = makeWorld();
    const oldMgr = makeOldManager(world);
    const newMgr = makeNewManager(world);
    const seed = { session: { model: { contextWindow: 128000 }, autoCompactionEnabled: false } };
    const oldRes = oldMgr.resolveCompactionPolicy(makeEntry(seed).entry);
    const newRes = newMgr.resolveCompactionPolicy(makeEntry(seed).entry);
    expect(newRes).toEqual(oldRes);
    expect(oldRes).toEqual({ mode: "manual", source: "disabled", enabled: false, contextWindow: 128000, threshold: null, reserveTokens: null });
  });

  it("app-fallback：unknown + 未关 → threshold=UNKNOWN_MODEL_AUTO_COMPACT_INPUT_TOKENS、source 透传窗口来源", () => {
    const world = makeWorld();
    const oldMgr = makeOldManager(world);
    const newMgr = makeNewManager(world);
    const oldRes = oldMgr.resolveCompactionPolicy(makeEntry().entry);
    const newRes = newMgr.resolveCompactionPolicy(makeEntry().entry);
    expect(newRes).toEqual(oldRes);
    expect(oldRes).toEqual({
      mode: "app-fallback", source: "default_fallback", enabled: true,
      contextWindow: 1_000_000, threshold: 26000, reserveTokens: null,
    });
  });
});

describe("B6-6-4d 对拍：_maybeCompact 前置短路", () => {
  it("promptChars=0 / compacting=true / cooldown 内 → 三不压缩（compact 0 次）", async () => {
    const world = makeWorld();
    const oldMgr = makeOldManager(world);
    const newMgr = makeNewManager(world);
    await oldMgr._maybeCompact(makeEntry({ promptChars: 0 }).entry);
    await newMgr._maybeCompact(makeEntry({ promptChars: 0 }).entry);
    await oldMgr._maybeCompact(makeEntry({ promptChars: 500000, compacting: true }).entry);
    await newMgr._maybeCompact(makeEntry({ promptChars: 500000, compacting: true }).entry);
    await oldMgr._maybeCompact(makeEntry({ promptChars: 500000, lastCompactionAt: Date.now() }).entry);
    await newMgr._maybeCompact(makeEntry({ promptChars: 500000, lastCompactionAt: Date.now() }).entry);
    expect(world.calls.compact).toEqual([]);
    expect(world.calls.getContextUsage).toEqual([]); // 前置短路不触 U1 精确用量
  });

  it("known 模型（未显式关闭）→ 交 Pi SDK，不压缩；显式 autoCompactionEnabled=false → 也不压缩", async () => {
    const world = makeWorld({ contextTokensImpl: () => 999999 });
    const oldMgr = makeOldManager(world);
    const newMgr = makeNewManager(world);
    const knownSeed = { promptChars: 500000, session: { model: { contextWindow: 128000 } } };
    await oldMgr._maybeCompact(makeEntry(knownSeed).entry);
    await newMgr._maybeCompact(makeEntry(knownSeed).entry);
    const disabledSeed = { promptChars: 500000, session: { autoCompactionEnabled: false } };
    await oldMgr._maybeCompact(makeEntry(disabledSeed).entry);
    await newMgr._maybeCompact(makeEntry(disabledSeed).entry);
    expect(world.calls.compact).toEqual([]);
    expect(world.calls.getContextUsage).toEqual([]); // known/disabled 在 U1 之前返回
  });
});

describe("B6-6-4d 对拍：_maybeCompact 压缩路径", () => {
  it("precise 命中：getContextUsage.usage → contextTokensFromUsage ≥ 阈值 → 压缩成功全字段", async () => {
    const world = makeWorld({ contextTokensImpl: () => 30000, getContextUsageOut: { usage: { contextTokens: 30000 } } });
    const oldMgr = makeOldManager(world);
    const newMgr = makeNewManager(world);
    const oldSeed = makeEntry({ promptChars: 350000, lastUsage: { inputTokens: 1 } });
    const newSeed = makeEntry({ promptChars: 350000, lastUsage: { inputTokens: 1 } });
    const runCtx = { runId: "run-1" };
    await oldMgr._maybeCompact(oldSeed.entry, runCtx);
    await newMgr._maybeCompact(newSeed.entry, runCtx);

    expect(world.calls.compact).toHaveLength(2); // 双侧各一次
    expect(world.calls.compact[0]![2]).toBe("保留当前项目事实、用户偏好、已完成产物路径、未完成任务和下一步；删除重复的工具输出与旧过程细节。");
    for (const seed of [oldSeed, newSeed]) {
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
    }
    // 压缩期间 compactionPromise 已置位 + compactionKind/RunId 标记（compactImpl 捕获）
    expect(oldSeed.emitted).toEqual([]);
    expect(newSeed.emitted).toEqual(oldSeed.emitted);
    expect(world.calls.ctxTokens[0]).toEqual({ contextTokens: 30000 }); // preciseUsage?.usage ?? preciseUsage
  });

  it("precise 为空 → observed 三和（input+cacheRead+cacheWrite）命中压缩", async () => {
    const world = makeWorld(); // contextTokensFromUsage 恒 null
    const oldMgr = makeOldManager(world);
    const newMgr = makeNewManager(world);
    const seed = { promptChars: 10, lastUsage: { input: 20000, cacheRead: 8000, cacheWrite: 2000 } };
    await oldMgr._maybeCompact(makeEntry(seed).entry);
    await newMgr._maybeCompact(makeEntry(seed).entry);
    expect(world.calls.compact).toHaveLength(2);
    expect(world.calls.getContextUsage).toHaveLength(2); // 双侧各一次
  });

  it("estimated 兜底：observed 0、promptChars=350000 → estimated=100000 ≥ min(26000, 25715) → 压缩", async () => {
    const world = makeWorld();
    const oldMgr = makeOldManager(world);
    const newMgr = makeNewManager(world);
    await oldMgr._maybeCompact(makeEntry({ promptChars: 350000 }).entry, { runId: "run-2" });
    await newMgr._maybeCompact(makeEntry({ promptChars: 350000 }).entry, { runId: "run-2" });
    expect(world.calls.compact).toHaveLength(2);
    expect(world.calls.compact[0]![2]).toContain("保留当前项目事实");
  });

  it("全低不压缩：observed 与 estimated 均低于 estimatedFallbackThreshold", async () => {
    const world = makeWorld();
    const oldMgr = makeOldManager(world);
    const newMgr = makeNewManager(world);
    await oldMgr._maybeCompact(makeEntry({ promptChars: 1000, lastUsage: { inputTokens: 100 } }).entry);
    await newMgr._maybeCompact(makeEntry({ promptChars: 1000, lastUsage: { inputTokens: 100 } }).entry);
    expect(world.calls.compact).toEqual([]);
  });

  it("压缩失败：context_compact_warning + compaction_failed 双事件、lastCompactionAt 不置、promptChars 保留", async () => {
    const world = makeWorld({ compactImpl: async () => { throw new Error("compact boom"); } });
    const oldMgr = makeOldManager(world);
    const newMgr = makeNewManager(world);
    const oldSeed = makeEntry({ promptChars: 350000, activeRunId: "run-3" });
    const newSeed = makeEntry({ promptChars: 350000, activeRunId: "run-3" });
    await oldMgr._maybeCompact(oldSeed.entry);
    await newMgr._maybeCompact(newSeed.entry);

    expect(oldSeed.emitted.map((e: any) => e.type)).toEqual(["context_compact_warning", "compaction_failed"]);
    expect(newSeed.emitted).toEqual(oldSeed.emitted);
    expect(oldSeed.emitted[0].data).toEqual({ runId: "run-3", message: "compact boom" });
    expect(oldSeed.emitted[1].data).toEqual({ runId: "run-3", reason: "automatic", aborted: false, errorMessage: "compact boom" });
    for (const seed of [oldSeed, newSeed]) {
      expect(seed.entry.lastCompactionAt).toBeUndefined(); // 未压缩成功不置冷却
      expect(seed.entry.promptChars).toBe(350000);
      expect(seed.entry.compacting).toBe(false);
      expect(seed.entry.compactionPromise).toBeNull();
    }
  });
});

describe("B6-6-4d 对拍：_enqueuePrompt", () => {
  it("空闲直通：无 agent_queued、queuedCount 1→0、queueWaitMs/compactionCheckMs=0、参数透传与返回值", async () => {
    const world = makeWorld();
    const oldMgr = makeOldManager(world);
    const newMgr = makeNewManager(world);
    const oldSeed = makeEntry();
    const newSeed = makeEntry();
    const oldCalls = stubPromptEntry(oldMgr);
    const newCalls = stubPromptEntry(newMgr);

    const payload = { text: "hello", images: ["img"], effort: "high", references: ["r1"], runContext: { runId: "run-9" } };
    const oldRes = await oldMgr._enqueuePrompt(oldSeed.entry, payload);
    const newRes = await newMgr._enqueuePrompt(newSeed.entry, payload);

    expect(newRes).toEqual(oldRes);
    expect(oldRes).toEqual({ done: true, text: "hello" });
    expect(oldCalls[0]).toEqual({ ...newCalls[0], entry: oldSeed.entry });
    expect(oldCalls[0].text).toBe("hello");
    expect(oldCalls[0].references).toEqual(["r1"]);
    expect(oldSeed.emitted).toEqual([]); // 空闲不发 agent_queued
    expect(newSeed.emitted).toEqual(oldSeed.emitted);
    expect(oldSeed.entry.queuedCount).toBe(0);
    expect(oldSeed.entry.queueWaitMs).toBe(0); // 冻结时钟
    expect(oldSeed.entry.compactionCheckMs).toBe(0);
  });

  it("busy 排队：agent_queued 信封（runId/position/queued）、queuedCount 复位、等待上一轮", async () => {
    const world = makeWorld();
    const oldMgr = makeOldManager(world);
    const newMgr = makeNewManager(world);
    // 两侧各挂一个 in-flight 链：busy=true + promptChain 悬挂，验证排队后再执行
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const oldSeed = makeEntry({ busy: true, promptChain: gate });
    const newSeed = makeEntry({ busy: true, promptChain: gate });
    const oldCalls = stubPromptEntry(oldMgr);
    const newCalls = stubPromptEntry(newMgr);

    const opOld = oldMgr._enqueuePrompt(oldSeed.entry, { text: "q1", images: [], effort: undefined, references: [], runContext: { runId: "run-q" } });
    const opNew = newMgr._enqueuePrompt(newSeed.entry, { text: "q1", images: [], effort: undefined, references: [], runContext: { runId: "run-q" } });
    expect(oldSeed.entry.queuedCount).toBe(1);
    expect(oldSeed.emitted).toHaveLength(1);
    expect(oldSeed.emitted[0].type).toBe("agent_queued");
    expect(oldSeed.emitted[0].data).toEqual({ runId: "run-q", position: 1, queued: 0 });
    expect(newSeed.emitted).toEqual(oldSeed.emitted);

    release();
    await Promise.all([opOld, opNew]);
    expect(oldSeed.entry.queuedCount).toBe(0);
    expect(oldCalls[0].text).toBe("q1");
    expect(oldSeed.entry.queueWaitMs).toBe(0);
  });

  it("queuedCount>0：position=queuedCount+1 顺延", async () => {
    const world = makeWorld();
    const oldMgr = makeOldManager(world);
    const newMgr = makeNewManager(world);
    const oldSeed = makeEntry({ queuedCount: 2 });
    const newSeed = makeEntry({ queuedCount: 2 });
    stubPromptEntry(oldMgr);
    stubPromptEntry(newMgr);
    const opOld = oldMgr._enqueuePrompt(oldSeed.entry, { text: "x", images: [], effort: undefined, references: [], runContext: null });
    const opNew = newMgr._enqueuePrompt(newSeed.entry, { text: "x", images: [], effort: undefined, references: [], runContext: null });
    expect(oldSeed.emitted[0].data).toEqual({ runId: null, position: 3, queued: 2 });
    expect(newSeed.emitted).toEqual(oldSeed.emitted);
    await Promise.all([opOld, opNew]);
  });

  it("compactionPromise rejected：await 后吞错继续进入压缩检查", async () => {
    const world = makeWorld();
    const oldMgr = makeOldManager(world);
    const newMgr = makeNewManager(world);
    const rejected = Promise.reject(new Error("stale compaction"));
    const oldSeed = makeEntry({ promptChars: 0, compactionPromise: rejected });
    const newSeed = makeEntry({ promptChars: 0, compactionPromise: Promise.reject(new Error("stale compaction")) });
    const oldCalls = stubPromptEntry(oldMgr);
    const newCalls = stubPromptEntry(newMgr);
    const opOld = oldMgr._enqueuePrompt(oldSeed.entry, { text: "t", images: [], effort: undefined, references: [], runContext: null });
    const opNew = newMgr._enqueuePrompt(newSeed.entry, { text: "t", images: [], effort: undefined, references: [], runContext: null });
    await expect(opOld).resolves.toEqual({ done: true, text: "t" });
    await expect(opNew).resolves.toEqual({ done: true, text: "t" });
    expect(oldCalls).toHaveLength(1);
    expect(oldSeed.entry.compactionCheckMs).toBe(0);
  });

  it("前链失败不阻断：第一次 _promptEntry 抛错 → operation reject；第二次排队正常执行", async () => {
    const world = makeWorld();
    const oldMgr = makeOldManager(world);
    const newMgr = makeNewManager(world);
    const oldSeed = makeEntry();
    const newSeed = makeEntry();
    let n = 0;
    const oldCalls = stubPromptEntry(oldMgr, () => { n += 1; if (n === 1) throw new Error("first boom"); return { ok: n }; });
    let m = 0;
    const newCalls = stubPromptEntry(newMgr, () => { m += 1; if (m === 1) throw new Error("first boom"); return { ok: m }; });

    await expect(oldMgr._enqueuePrompt(oldSeed.entry, { text: "a", images: [], effort: undefined, references: [], runContext: null })).rejects.toThrow("first boom");
    await expect(newMgr._enqueuePrompt(newSeed.entry, { text: "a", images: [], effort: undefined, references: [], runContext: null })).rejects.toThrow("first boom");
    const oldRes = await oldMgr._enqueuePrompt(oldSeed.entry, { text: "b", images: [], effort: undefined, references: [], runContext: null });
    const newRes = await newMgr._enqueuePrompt(newSeed.entry, { text: "b", images: [], effort: undefined, references: [], runContext: null });
    expect(newRes).toEqual(oldRes);
    expect(oldRes).toEqual({ ok: 2 });
    expect(oldCalls.map((c: any) => c.text)).toEqual(["a", "b"]);
    expect(newCalls.map((c: any) => c.text)).toEqual(["a", "b"]);
    expect(oldSeed.entry.queuedCount).toBe(0);
  });
});

describe("B6-6-4d 对拍：usageSnapshot", () => {
  it("无 entry → null", () => {
    const world = makeWorld();
    const oldMgr = makeOldManager(world);
    const newMgr = makeNewManager(world);
    expect(oldMgr.usageSnapshot("missing")).toBeNull();
    expect(newMgr.usageSnapshot("missing")).toBeNull();
  });

  it("usage.contextTokens 优先 + pi-native keepRecentTokens + usage 浅拷贝", () => {
    const world = makeWorld();
    const oldMgr = makeOldManager(world);
    const newMgr = makeNewManager(world);
    const seed = {
      promptChars: 35000,
      lastUsage: { contextTokens: 5000, inputTokens: 1 },
      session: { model: { contextWindow: 128000 } },
    };
    const oldRes = oldMgr.usageSnapshot("c1");
    const newRes = newMgr.usageSnapshot("c1");
    oldMgr.sessions.set("c1", makeEntry(seed).entry);
    newMgr.sessions.set("c1", makeEntry(seed).entry);
    const oldRes2 = oldMgr.usageSnapshot("c1");
    const newRes2 = newMgr.usageSnapshot("c1");
    expect(oldRes).toBeNull();
    expect(newRes).toBeNull();
    expect(newRes2).toEqual(oldRes2);
    expect(oldRes2).toEqual({
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
    oldRes2.usage.contextTokens = 999;
    expect(oldMgr.sessions.get("c1").lastUsage.contextTokens).toBe(5000);
  });

  it("usage 无 contextTokens → 三和（cache_read/cache_write 别名变体）", () => {
    const world = makeWorld();
    const oldMgr = makeOldManager(world);
    const newMgr = makeNewManager(world);
    oldMgr.sessions.set("c1", makeEntry({ promptChars: 0, lastUsage: { input: 100, cache_read: 200, cache_write: 50 } }).entry);
    newMgr.sessions.set("c1", makeEntry({ promptChars: 0, lastUsage: { input: 100, cache_read: 200, cache_write: 50 } }).entry);
    const oldRes = oldMgr.usageSnapshot("c1");
    const newRes = newMgr.usageSnapshot("c1");
    expect(newRes).toEqual(oldRes);
    expect(oldRes.contextTokens).toBe(350);
  });

  it("usage null + promptChars → estimated 兜底；manual 模式 keepRecentTokens=null", () => {
    const world = makeWorld();
    const oldMgr = makeOldManager(world);
    const newMgr = makeNewManager(world);
    oldMgr.sessions.set("c1", makeEntry({ promptChars: 70000, session: { autoCompactionEnabled: false } }).entry);
    newMgr.sessions.set("c1", makeEntry({ promptChars: 70000, session: { autoCompactionEnabled: false } }).entry);
    const oldRes = oldMgr.usageSnapshot("c1");
    const newRes = newMgr.usageSnapshot("c1");
    expect(newRes).toEqual(oldRes);
    expect(oldRes.usage).toBeNull();
    expect(oldRes.contextTokens).toBe(Math.ceil(70000 / 3.5));
    expect(oldRes.compactionMode).toBe("manual");
    expect(oldRes.compactionEnabled).toBe(false);
    expect(oldRes.compactionKeepRecentTokens).toBeNull();
    expect(oldRes.compactThreshold).toBeNull();
  });
});
