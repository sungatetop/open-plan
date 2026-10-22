/**
 * B6-6-4c 对拍：AgentManager 模型族批（server/agent.mjs L4419-4653 类体收尾段）。
 *
 * 覆盖：setModel（空闲直通/busy 排队/回退生效/不可重试原样抛/无 entry 经 getOrCreate 创建）/
 * applyModelSpec（无效 spec/目录外/model not found/无默认模型原样抛/回退即目标原样抛/成功清
 * 回退字段）/ probeModel（三错误分支 + 成功归一：text 提取截断/usage 补零/responseModel 回退）/
 * fallbackModel（跨 provider 优先/同 provider 回退缺失→null/全 tried 无候选/空 tried 成功链）/
 * listModelCatalog（Runtime→stored→available 合并覆盖序/normalize 上下文窗口取值链/deny 过滤/
 * authError 标记与 available 剔除/counts）/ listModels / refreshModels（成功/网络失败续用/
 * AbortError 静默 + resetModelRuntime）/ disposeAll。
 *
 * 旧侧按行号提取类体：L843-1018（类头+构造器+薄方法+getOrCreate+modelRuntime，setModel 经
 * ensureRuntime → getOrCreate 依赖该段）+ L3501-3553（ensureRuntime）+ L4347-4367
 * （setCurrentFile/runtimeSnapshot/runtimeHealth）+ L4403-4417（restartRuntime/listRuntimes）
 * + L4419-4653（模型族）拼 class 表达式 + new Function 求值。piRuntimeManager（pi 域未迁）、
 * findSessionFileForAgent（4f 批）以同名参数注入旧工厂；currentModelSpec/classifyAgentError/
 * clearInvalidCredential 注入同一 TS 实现保同流，localModelProviders/localStoredModels/
 * configuredModelSpec/getCredentialErrors 双侧注入同一测试 stub（新侧走 AgentManagerDeps）。
 * _create 未迁（4i 批），两侧实例覆写注入。注意：world.calls 为双侧共享，断言计数 = 两侧之和。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { AgentManager, type AgentManagerDeps } from "../src/main/backend/agent/agent-manager";
import { emitChannelSafe, emitAbortedOnce } from "../src/main/backend/agent/emit-helpers";
import {
  classifyAgentError as classifyAgentErrorReal,
  clearInvalidCredential as clearInvalidCredentialReal,
} from "../src/main/backend/agent/agent-errors";
import { currentModelSpec as currentModelSpecReal } from "../src/main/backend/agent/model-spec";
import { getWorkspace } from "../src/main/backend/workspace";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LINES_AGENT = readFileSync(path.resolve(HERE, "../../server/agent.mjs"), "utf8").split("\n");
const segAgent = (start: number, end: number) => LINES_AGENT.slice(start - 1, end).join("\n").replace(/^export\s+/gm, "");

// 冻结时钟：emitChannelSafe 信封含 at=ISO 时间戳，双侧执行跨毫秒会比对失败（4a/4b 同口径）
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

// 行号锚点：源文件结构变动导致偏移时，这里先行失败提醒更新提取区间
expect(segAgent(843, 843)).toContain("class AgentManager extends EventEmitter {");
expect(segAgent(3507, 3507)).toContain("async ensureRuntime(clientId, options = {}) {");
expect(segAgent(3554, 3554)).toContain("}");
expect(segAgent(4347, 4347)).toContain("async setCurrentFile(clientId, file) {");
expect(segAgent(4367, 4367)).toContain("}");
expect(segAgent(4403, 4403)).toContain("async restartRuntime(clientId");
expect(segAgent(4417, 4417)).toContain("}");
expect(segAgent(4419, 4419)).toContain("async setModel(clientId, spec) {");
expect(segAgent(4453, 4453)).toContain("async applyModelSpec(entry, spec) {");
expect(segAgent(4495, 4495)).toContain("async probeModel(spec, options = {}) {");
expect(segAgent(4541, 4541)).toContain("async fallbackModel(entry, triedSpecs = []) {");
expect(segAgent(4573, 4573)).toContain("async listModelCatalog() {");
expect(segAgent(4626, 4626)).toContain("async listModels() {");
expect(segAgent(4631, 4631)).toContain("async refreshModels() {");
expect(segAgent(4650, 4650)).toContain("async disposeAll() {");
expect(segAgent(4653, 4653)).toContain("}");

/** 目录夹具：providers/runtimeModels/available 三源 + deny/authError 场景，双侧共享。 */
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

/** 双侧共享依赖世界：目录夹具 + seam stub 全量记录调用序列（calls 为双侧累加）。 */
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
        // attempt 按 session 对象分侧计数（两侧 session 实例不同，互不串号）
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

/** 旧侧类工厂：4a 段 + ensureRuntime + runtimeHealth + restartRuntime + 模型族拼 class。 */
function makeOldManager(world: ReturnType<typeof makeWorld>) {
  const Ctor = new Function(
    "EventEmitter",
    "RUNTIME_FLAGS",
    "piRuntimeManager",
    "normalizeWorkspace",
    "getWorkspace",
    "configuredModelSpec",
    "findSessionFileForAgent",
    "isAbortLikeError",
    "emitChannelSafe",
    "emitAbortedOnce",
    "currentModelSpec",
    "localModelProviders",
    "localStoredModels",
    "classifyAgentError",
    "clearInvalidCredential",
    "getCredentialErrors",
    "getRun",
    "listStoredMemoryProposals",
    "approveStoredMemoryProposal",
    "editStoredMemoryProposal",
    "rejectStoredMemoryProposal",
    "mergeMemoryProposals",
    "getMemoryProposalHistory",
    "readPendingAsks",
    "resolvePendingAsk",
    `${segAgent(843, 1018)}
${segAgent(3502, 3554)}
${segAgent(4347, 4367)}
${segAgent(4403, 4417)}
${segAgent(4419, 4653)}
}
return AgentManager;`,
  )(
    EventEmitter,
    {}, // RUNTIME_FLAGS：agentBusyWatchdog 默认关
    world.deps.piRuntimeManager,
    world.deps.normalizeWorkspace,
    getWorkspace,
    world.deps.configuredModelSpec,
    world.deps.findSessionFileForAgent,
    () => false, // isAbortLikeError（模型族不触达，占位满足签名）
    (entry: any, type: string, data: any, o: any) => emitChannelSafe(entry, type, data, o, world.deps.emitDeps),
    (entry: any, reason?: string) => emitAbortedOnce(entry, reason, world.deps.emitDeps),
    currentModelSpecReal,
    world.deps.localModelProviders,
    world.deps.localStoredModels,
    classifyAgentErrorReal,
    clearInvalidCredentialReal,
    world.deps.getCredentialErrors,
    world.deps.getRun,
    world.deps.listStoredMemoryProposals,
    world.deps.approveStoredMemoryProposal,
    world.deps.editStoredMemoryProposal,
    world.deps.rejectStoredMemoryProposal,
    world.deps.mergeMemoryProposals,
    world.deps.getMemoryProposalHistory,
    () => [],
    () => null,
  );
  return new Ctor() as any;
}

/** 新侧实例：AgentManager + 同一 deps（TS 类自持 ensureRuntime/restartRuntime/runtimeHealth）。 */
function makeNewManager(world: ReturnType<typeof makeWorld>) {
  return new AgentManager(world.deps);
}

/** 两侧实例覆写 _create（4i 批未迁；回填 sessions 模拟真实创建，workspace 透传 options.cwd）。 */
function stubCreate(mgr: any) {
  mgr._create = async (clientId: unknown, options: any) => {
    const { entry } = makeEntry({ workspace: options.cwd });
    mgr.sessions.set(clientId, entry);
    return entry;
  };
}

describe("B6-6-4c 模型族对拍：setModel", () => {
  it("空闲直通：ensureRuntime 复用现有 entry，applyModelSpec 成功 + model_switched(now/user)", async () => {
    const world = makeWorld();
    const oldMgr = makeOldManager(world);
    const newMgr = makeNewManager(world);
    const oldSeed = makeEntry();
    const newSeed = makeEntry();
    oldMgr.sessions.set("c1", oldSeed.entry);
    newMgr.sessions.set("c1", newSeed.entry);

    const oldRes = await oldMgr.setModel("c1", "prov-x/mdl-1");
    const newRes = await newMgr.setModel("c1", "prov-x/mdl-1");

    expect(newRes).toEqual(oldRes);
    expect(oldRes).toEqual({ ok: true, model: "prov-x/mdl-1", from: "prov-x/mdl-1" });
    expect(newSeed.emitted).toEqual(oldSeed.emitted);
    expect(oldSeed.emitted).toHaveLength(1);
    expect(oldSeed.emitted[0].type).toBe("model_switched");
    // 双侧各一次 setModel（2 次），解析模型为共享 runtimeModels 的 mdl-1 实例
    expect(world.calls.setModel).toHaveLength(2);
    expect(world.calls.setModel[0]![2]).toEqual(world.calls.setModel[1]![2]);
    expect(world.calls.setModel[1]![2]).toEqual({ provider: "prov-x", id: "mdl-1", name: "Runtime One", vision: true, contextWindow: 128000 });
  });

  it("busy 排队：pendingModelSpec 落 entry + model_switched(queued/after-run)，不触 seam.setModel", async () => {
    const world = makeWorld();
    const oldMgr = makeOldManager(world);
    const newMgr = makeNewManager(world);
    const oldSeed = makeEntry({ busy: true });
    const newSeed = makeEntry({ busy: true });
    oldMgr.sessions.set("c1", oldSeed.entry);
    newMgr.sessions.set("c1", newSeed.entry);

    const oldRes = await oldMgr.setModel("c1", "prov-b/mdl-b");
    const newRes = await newMgr.setModel("c1", "prov-b/mdl-b");

    expect(newRes).toEqual(oldRes);
    expect(oldRes).toEqual({ ok: true, model: "prov-b/mdl-b", pending: true, current: "prov-x/mdl-1" });
    expect(oldSeed.entry.pendingModelSpec).toBe("prov-b/mdl-b");
    expect(newSeed.entry.pendingModelSpec).toBe("prov-b/mdl-b");
    expect(newSeed.emitted).toEqual(oldSeed.emitted);
    expect(oldSeed.emitted).toHaveLength(1);
    expect(oldSeed.emitted[0].type).toBe("model_switched");
    expect(world.calls.setModel).toEqual([]);
  });

  it("回退生效：首选 setModel 可重试失败 → configured 回退成功，reason=fallback + modelFallbackSpec/from 落 entry", async () => {
    const world = makeWorld({
      configuredModel: "prov-b/mdl-b",
      setModelImpl: (_call, attempt) => { if (attempt === 1) { const e = new Error("boom"); (e as any).status = 503; throw e; } },
    });
    const oldMgr = makeOldManager(world);
    const newMgr = makeNewManager(world);
    const oldSeed = makeEntry();
    const newSeed = makeEntry();
    oldMgr.sessions.set("c1", oldSeed.entry);
    newMgr.sessions.set("c1", newSeed.entry);

    const oldRes = await oldMgr.setModel("c1", "prov-x/mdl-1");
    const newRes = await newMgr.setModel("c1", "prov-x/mdl-1");

    expect(newRes).toEqual(oldRes);
    expect(oldRes).toEqual({ ok: true, model: "prov-b/mdl-b", from: "prov-x/mdl-1", modelFallbackFrom: "prov-x/mdl-1", fallback: true });
    expect(oldSeed.entry.modelFallbackSpec).toBe("prov-b/mdl-b");
    expect(oldSeed.entry.modelFallbackFrom).toBe("prov-x/mdl-1");
    expect(newSeed.entry.modelFallbackSpec).toBe(oldSeed.entry.modelFallbackSpec);
    expect(newSeed.entry.modelFallbackFrom).toBe(oldSeed.entry.modelFallbackFrom);
    expect(newSeed.emitted).toEqual(oldSeed.emitted);
    expect(oldSeed.emitted).toHaveLength(1);
    // 双侧各两次（首选失败 + 回退成功）：[0]/[2] 首选同流，[1]/[3] 回退同流
    expect(world.calls.setModel).toHaveLength(4);
    const setModelCalls = world.calls.setModel;
    expect(setModelCalls[0]![2]).toEqual(setModelCalls[2]![2]);
    expect(setModelCalls[1]![2]).toEqual(setModelCalls[3]![2]);
    expect(setModelCalls[3]![2]).toEqual({ provider: "prov-b", id: "mdl-b", contextLength: 64000 });
  });

  it("不可重试（认证错误）：applyModelSpec 原样抛出，无 model_switched 事件", async () => {
    const world = makeWorld({
      configuredModel: "prov-b/mdl-b",
      setModelImpl: () => { throw new Error("401 invalid api key"); },
    });
    const oldMgr = makeOldManager(world);
    const newMgr = makeNewManager(world);
    const oldSeed = makeEntry();
    const newSeed = makeEntry();
    oldMgr.sessions.set("c1", oldSeed.entry);
    newMgr.sessions.set("c1", newSeed.entry);

    await expect(oldMgr.setModel("c1", "prov-x/mdl-1")).rejects.toThrow("401 invalid api key");
    await expect(newMgr.setModel("c1", "prov-x/mdl-1")).rejects.toThrow("401 invalid api key");
    expect(oldSeed.emitted).toEqual([]);
    expect(newSeed.emitted).toEqual(oldSeed.emitted);
    expect(world.calls.setModel).toHaveLength(2); // 双侧各一次，无回退
  });

  it("无 entry：经 getOrCreate → _create 创建后应用（cwd 兜底 getWorkspace 透传 _create）", async () => {
    const world = makeWorld();
    const oldMgr = makeOldManager(world);
    const newMgr = makeNewManager(world);
    stubCreate(oldMgr);
    stubCreate(newMgr);

    const oldRes = await oldMgr.setModel("c9", "prov-b/mdl-new");
    const newRes = await newMgr.setModel("c9", "prov-b/mdl-new");

    expect(newRes).toEqual(oldRes);
    expect(oldRes).toEqual({ ok: true, model: "prov-b/mdl-new", from: "prov-x/mdl-1" });
    expect(oldMgr.sessions.has("c9")).toBe(true);
    expect(newMgr.sessions.has("c9")).toBe(true);
  });
});

describe("B6-6-4c 模型族对拍：applyModelSpec", () => {
  it("无效 spec 四样本：无斜线/空 provider/尾斜线/空串 → MODEL_SPEC_INVALID", async () => {
    const world = makeWorld();
    const oldMgr = makeOldManager(world);
    const newMgr = makeNewManager(world);
    for (const spec of ["nodash", "prov/", "/model", ""]) {
      await expect(oldMgr.applyModelSpec(makeEntry().entry, spec)).rejects.toMatchObject({ code: "MODEL_SPEC_INVALID" });
      await expect(newMgr.applyModelSpec(makeEntry().entry, spec)).rejects.toMatchObject({ code: "MODEL_SPEC_INVALID" });
    }
    expect(world.calls.setModel).toEqual([]);
  });

  it("provider 不在本地目录：原样抛 model is not in local Pi catalog", async () => {
    const world = makeWorld();
    const oldMgr = makeOldManager(world);
    const newMgr = makeNewManager(world);
    await expect(oldMgr.applyModelSpec(makeEntry().entry, "ghost/m1")).rejects.toThrow("model is not in local Pi catalog: ghost/m1");
    await expect(newMgr.applyModelSpec(makeEntry().entry, "ghost/m1")).rejects.toThrow("model is not in local Pi catalog: ghost/m1");
  });

  it("model not found：目录内有 provider 但 runtime+stored 均无该 id", async () => {
    const world = makeWorld({ getModelOut: null });
    const oldMgr = makeOldManager(world);
    const newMgr = makeNewManager(world);
    await expect(oldMgr.applyModelSpec(makeEntry().entry, "prov-b/missing")).rejects.toThrow("model not found: prov-b/missing");
    await expect(newMgr.applyModelSpec(makeEntry().entry, "prov-b/missing")).rejects.toThrow("model not found: prov-b/missing");
  });

  it("无默认模型（configured 为空串）：失败后原样抛，不回退", async () => {
    const world = makeWorld({
      configuredModel: "",
      setModelImpl: () => { const e = new Error("boom"); (e as any).status = 503; throw e; },
    });
    const oldMgr = makeOldManager(world);
    const newMgr = makeNewManager(world);
    await expect(oldMgr.applyModelSpec(makeEntry().entry, "prov-x/mdl-1")).rejects.toThrow("boom");
    await expect(newMgr.applyModelSpec(makeEntry().entry, "prov-x/mdl-1")).rejects.toThrow("boom");
    expect(world.calls.setModel).toHaveLength(2); // 双侧各一次
  });

  it("回退即目标（configured === specText）：失败后原样抛，不重复 setModel", async () => {
    const world = makeWorld({
      configuredModel: "prov-x/mdl-1",
      setModelImpl: () => { const e = new Error("boom"); (e as any).status = 503; throw e; },
    });
    const oldMgr = makeOldManager(world);
    const newMgr = makeNewManager(world);
    await expect(oldMgr.applyModelSpec(makeEntry().entry, "prov-x/mdl-1")).rejects.toThrow("boom");
    await expect(newMgr.applyModelSpec(makeEntry().entry, "prov-x/mdl-1")).rejects.toThrow("boom");
    expect(world.calls.setModel).toHaveLength(2);
  });

  it("成功：清空 modelFallback 字段并返回 { ok, model, from }", async () => {
    const world = makeWorld();
    const oldMgr = makeOldManager(world);
    const newMgr = makeNewManager(world);
    const oldSeed = makeEntry({ modelFallbackSpec: "stale/spec", modelFallbackFrom: "old/m" });
    const newSeed = makeEntry({ modelFallbackSpec: "stale/spec", modelFallbackFrom: "old/m" });
    const oldRes = await oldMgr.applyModelSpec(oldSeed.entry, "prov-x/mdl-1");
    const newRes = await newMgr.applyModelSpec(newSeed.entry, "prov-x/mdl-1");
    expect(newRes).toEqual(oldRes);
    expect(oldRes).toEqual({ ok: true, model: "prov-x/mdl-1", from: "prov-x/mdl-1" });
    expect(oldSeed.entry.modelFallbackSpec).toBe("");
    expect(oldSeed.entry.modelFallbackFrom).toBeNull();
    expect(newSeed.entry.modelFallbackSpec).toBe("");
    expect(newSeed.entry.modelFallbackFrom).toBeNull();
  });
});

describe("B6-6-4c 模型族对拍：probeModel", () => {
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
    const oldMgr = makeOldManager(world);
    const newMgr = makeNewManager(world);
    const oldRes = await oldMgr.probeModel("prov-x/mdl-1", { timeoutMs: 5000 });
    const newRes = await newMgr.probeModel("prov-x/mdl-1", { timeoutMs: 5000 });
    expect(newRes).toEqual(oldRes);
    expect(oldRes).toEqual({
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
    expect(world.calls.probeModel).toHaveLength(2); // 双侧各一次
    expect(world.calls.probeModel[0]![1]).toEqual({ timeoutMs: 5000 });
  });

  it("无 content / 无 usage：preview 空串、usage/stopReason/responseModel null", async () => {
    const world = makeWorld({ probeOut: { latencyMs: 5, response: {} } });
    const oldMgr = makeOldManager(world);
    const newMgr = makeNewManager(world);
    const oldRes = await oldMgr.probeModel("prov-x/mdl-1");
    const newRes = await newMgr.probeModel("prov-x/mdl-1");
    expect(newRes).toEqual(oldRes);
    expect(oldRes.response.preview).toBe("");
    expect(oldRes.response.usage).toBeNull();
    expect(oldRes.response.stopReason).toBeNull();
    expect(oldRes.response.responseModel).toBeNull();
  });

  it("三错误分支：INVALID / NOT_IN_CATALOG / NOT_FOUND", async () => {
    const world = makeWorld({ getModelOut: null });
    const oldMgr = makeOldManager(world);
    const newMgr = makeNewManager(world);
    await expect(oldMgr.probeModel("bad")).rejects.toMatchObject({ code: "MODEL_SPEC_INVALID" });
    await expect(newMgr.probeModel("bad")).rejects.toMatchObject({ code: "MODEL_SPEC_INVALID" });
    await expect(oldMgr.probeModel("ghost/m1")).rejects.toMatchObject({ code: "MODEL_NOT_IN_CATALOG" });
    await expect(newMgr.probeModel("ghost/m1")).rejects.toMatchObject({ code: "MODEL_NOT_IN_CATALOG" });
    await expect(oldMgr.probeModel("prov-b/missing")).rejects.toMatchObject({ code: "MODEL_NOT_FOUND" });
    await expect(newMgr.probeModel("prov-b/missing")).rejects.toMatchObject({ code: "MODEL_NOT_FOUND" });
    expect(world.calls.probeModel).toEqual([]);
  });
});

describe("B6-6-4c 模型族对拍：fallbackModel", () => {
  it("跨 provider 优先：tried prov-x → 选 configured 命中的 prov-b 模型并落 entry", async () => {
    const world = makeWorld({ configuredModel: "prov-b/mdl-b" });
    const oldMgr = makeOldManager(world);
    const newMgr = makeNewManager(world);
    const oldSeed = makeEntry();
    const newSeed = makeEntry();
    const oldRes = await oldMgr.fallbackModel(oldSeed.entry, ["prov-x/mdl-1"]);
    const newRes = await newMgr.fallbackModel(newSeed.entry, ["prov-x/mdl-1"]);
    expect(newRes).toEqual(oldRes);
    expect(oldRes).toBe("prov-b/mdl-b");
    expect(oldSeed.entry.modelFallbackSpec).toBe("prov-b/mdl-b");
    expect(oldSeed.entry.modelFallbackFrom).toBe("prov-x/mdl-1");
    expect(newSeed.entry.modelFallbackSpec).toBe(oldSeed.entry.modelFallbackSpec);
    expect(newSeed.entry.modelFallbackFrom).toBe(oldSeed.entry.modelFallbackFrom);
    expect(world.calls.setModel).toHaveLength(2); // 双侧各一次
    expect(world.calls.setModel[0]![2]).toEqual(world.calls.setModel[1]![2]);
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
    const oldMgr = makeOldManager(world);
    const newMgr = makeNewManager(world);
    const oldRes = await oldMgr.fallbackModel(makeEntry().entry, "prov-b/mdl-b");
    const newRes = await newMgr.fallbackModel(makeEntry().entry, "prov-b/mdl-b");
    expect(newRes).toEqual(oldRes);
    expect(oldRes).toBeNull();
  });

  it("全部 tried → 无候选返回 null", async () => {
    const world = makeWorld({ configuredModel: "prov-x/mdl-x" });
    const oldMgr = makeOldManager(world);
    const newMgr = makeNewManager(world);
    const tried = ["prov-x/mdl-x", "prov-b/mdl-b", "prov-b/mdl-new", "prov-b/mdl-b2", "prov-x/mdl-1"];
    const oldRes = await oldMgr.fallbackModel(makeEntry().entry, tried);
    const newRes = await newMgr.fallbackModel(makeEntry().entry, tried);
    expect(newRes).toEqual(oldRes);
    expect(oldRes).toBeNull();
    expect(world.calls.setModel).toEqual([]);
  });

  it("成功链：tried 空 → configured 首选命中 available，failedProvider 为空串放行", async () => {
    const world = makeWorld({ configuredModel: "prov-b/mdl-b" });
    const oldMgr = makeOldManager(world);
    const newMgr = makeNewManager(world);
    const oldRes = await oldMgr.fallbackModel(makeEntry().entry, []);
    const newRes = await newMgr.fallbackModel(makeEntry().entry, []);
    expect(newRes).toEqual(oldRes);
    expect(oldRes).toBe("prov-b/mdl-b");
  });
});

describe("B6-6-4c 模型族对拍：listModelCatalog / listModels", () => {
  it("合并覆盖序 + normalize 取值链 + deny 过滤 + counts 全形状对拍", async () => {
    const world = makeWorld();
    const oldMgr = makeOldManager(world);
    const newMgr = makeNewManager(world);
    const oldRes = await oldMgr.listModelCatalog();
    const newRes = await newMgr.listModelCatalog();
    expect(newRes).toEqual(oldRes);
    // 关键聚合显式断言（防两侧同错）。现状固化：isDenied 作用于 normalize 后条目（id 已含
    // provider 前缀），DENY_MODELS 的单前缀键永不命中，实际仅 DENY_PROVIDERS（new-provider）过滤生效。
    expect(oldRes.counts).toEqual({ available: 2, configured: 6, stored: 5, listed: 7 });
    expect(oldRes.source).toBe("pi-model-runtime+models-store");
    expect(oldRes.models.map((m: any) => m.id)).toEqual([
      "prov-x/mdl-1",       // stored 覆盖 runtime（contextWindow 99000/name Stored One）
      "prov-b/mdl-b",       // available 覆盖 runtime（name Avail B，contextLength 64000）
      "prov-b/mdl-b2",      // limit.context 32000
      "prov-b/mdl-new",
      "xiaomi-token-plan-cn/mimo-v2.5-pro",
      "xiaomi-token-plan-cn/mimo-x",
      "prov-x/mdl-x",
    ]);
    expect(oldRes.models[0]).toEqual({ id: "prov-x/mdl-1", provider: "prov-x", name: "Stored One", vision: false, available: false, contextWindow: 99000 });
    expect(oldRes.configured.map((m: any) => m.id)).toEqual(["prov-x/mdl-1", "prov-b/mdl-b", "prov-b/mdl-b2", "prov-b/mdl-new", "xiaomi-token-plan-cn/mimo-v2.5-pro", "xiaomi-token-plan-cn/mimo-x"]);
    expect(oldRes.available.map((m: any) => m.id)).toEqual(["prov-b/mdl-b", "prov-x/mdl-x"]);
    expect(oldRes.authErrors).toEqual({});
  });

  it("authError 注入：条目标记 authError、available 置 false、catalog.available 剔除该 provider", async () => {
    const world = makeWorld({
      credentialErrors: { "prov-b": { at: "2026-01-01T00:00:00.000Z", message: "401 unauthorized" } },
    });
    const oldMgr = makeOldManager(world);
    const newMgr = makeNewManager(world);
    const oldRes = await oldMgr.listModelCatalog();
    const newRes = await newMgr.listModelCatalog();
    expect(newRes).toEqual(oldRes);
    const b = oldRes.models.find((m: any) => m.id === "prov-b/mdl-b");
    expect(b.authError).toBe("401 unauthorized");
    expect(b.available).toBe(false);
    expect(oldRes.available.map((m: any) => m.id)).toEqual(["prov-x/mdl-x"]);
    expect(oldRes.authErrors).toEqual({ "prov-b": { at: "2026-01-01T00:00:00.000Z", message: "401 unauthorized" } });
  });

  it("listModels：与 catalog.models 同一数组", async () => {
    const world = makeWorld();
    const oldMgr = makeOldManager(world);
    const newMgr = makeNewManager(world);
    const oldRes = await oldMgr.listModels();
    const newRes = await newMgr.listModels();
    expect(newRes).toEqual(oldRes);
    expect(oldRes).toEqual((await oldMgr.listModelCatalog()).models);
  });
});

describe("B6-6-4c 模型族对拍：refreshModels / disposeAll", () => {
  it("refreshModels：resetModelRuntime 先行、refresh 携 allowNetwork+signal、返回 catalog.models", async () => {
    const world = makeWorld();
    const oldMgr = makeOldManager(world);
    const newMgr = makeNewManager(world);
    const oldRes = await oldMgr.refreshModels();
    const newRes = await newMgr.refreshModels();
    expect(newRes).toEqual(oldRes);
    expect(oldRes).toEqual((await oldMgr.listModelCatalog()).models);
    expect(world.calls.resetModelRuntime).toBe(2); // 双侧各一次
    expect(world.calls.refresh).toHaveLength(2);
    expect(world.calls.refresh[0].allowNetwork).toBe(true);
    expect(world.calls.refresh[0].signal).toBeInstanceOf(AbortSignal);
  });

  it("refreshModels：网络失败续用本地缓存（warn 不抛）+ AbortError 静默", async () => {
    const warnCalls: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: any[]) => warnCalls.push(args.join(" "));
    try {
      const world = makeWorld({ refreshImpl: async () => { throw new Error("getaddrinfo ENOTFOUND"); } });
      const oldMgr = makeOldManager(world);
      const newMgr = makeNewManager(world);
      const oldRes = await oldMgr.refreshModels();
      const newRes = await newMgr.refreshModels();
      expect(newRes).toEqual(oldRes);
      expect(oldRes).toEqual((await oldMgr.listModelCatalog()).models);
      expect(warnCalls.length).toBeGreaterThanOrEqual(2);
      expect(warnCalls[0]).toContain("[models] 远程目录刷新失败");

      warnCalls.length = 0;
      const world2 = makeWorld({ refreshImpl: async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; } });
      const oldMgr2 = makeOldManager(world2);
      const newMgr2 = makeNewManager(world2);
      const oldRes2 = await oldMgr2.refreshModels();
      const newRes2 = await newMgr2.refreshModels();
      expect(newRes2).toEqual(oldRes2);
      expect(warnCalls).toEqual([]);
    } finally {
      console.warn = origWarn;
    }
  });

  it("disposeAll：seam 收到 entries 快照，sessions 清空", async () => {
    const world = makeWorld();
    const oldMgr = makeOldManager(world);
    const newMgr = makeNewManager(world);
    oldMgr.sessions.set("c1", makeEntry().entry);
    newMgr.sessions.set("c1", makeEntry().entry);
    await oldMgr.disposeAll();
    await newMgr.disposeAll();
    expect(oldMgr.sessions.size).toBe(0);
    expect(newMgr.sessions.size).toBe(0);
    expect(world.calls.disposeAll).toHaveLength(2); // 双侧各一次
    expect(world.calls.disposeAll[0]).toHaveLength(1);
    // channel 含独立 emitter 闭包，剔除后对拍结构
    const strip = (e: any) => { const { channel, ...rest } = e; void channel; return rest; };
    expect(strip(world.calls.disposeAll[0]![0])).toEqual(strip(world.calls.disposeAll[1]![0]));
    expect(world.calls.disposeAll[1]![0].runtimeId).toBe("rt1");
  });
});
