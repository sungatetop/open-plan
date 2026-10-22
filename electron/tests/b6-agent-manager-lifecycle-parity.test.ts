/**
 * B6-6-4b 对拍：AgentManager 会话生命周期批（server/agent.mjs 四段类体）。
 *
 * 覆盖：prompt / promptWithContext（健康/failed 恢复/无 entry）/ sessionTree / branchSession /
 * ensureRuntime（复用/工作区替换/恢复链/单飞/stale code）/ abort（正常/异常/abort-like/
 * runId 兜底）/ resolveLiveEntry / compact / newThread / resumeThread（单飞 + _sessionBusyError
 * 现状缺陷固化）/ setCurrentFile / runtimeSnapshot / runtimeHealth / restartRuntime / listRuntimes。
 *
 * 旧侧按行号提取类体（L843-1018 类头+构造器+getOrCreate 与 L3461-3576、L4151-4253、
 * L4347-4367、L4403-4417 四段生命周期方法）拼成 class 表达式 + new Function 求值——
 * 构造器段不可省：sessions/resumePromises/recoveryPromises 字段初始化与 getOrCreate
 * （ensureRuntime/promptWithContext 依赖）都在该段。piRuntimeManager（pi 域未迁）、
 * findSessionFileForAgent（4f 批迁移）以同名参数注入旧工厂，
 * isAbortLikeError/configuredModelSpec/getWorkspace/normalizeWorkspace 注入
 * 同一 TS 实现保同流，新侧走 AgentManagerDeps。_create/_enqueuePrompt/writeContextFile 未迁，
 * 两侧实例覆写注入。usageSnapshot 依赖 4d 解析器，随 4d 批对拍。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { AgentManager, type AgentManagerDeps } from "../src/main/backend/agent/agent-manager";
import { emitChannelSafe, emitAbortedOnce } from "../src/main/backend/agent/emit-helpers";
import { isAbortLikeError as isAbortLikeErrorDefault } from "../src/main/backend/agent/agent-errors";
import { configuredModelSpec as configuredModelSpecDefault } from "../src/main/backend/agent/model-spec";
import { getWorkspace, normalizeWorkspace as normalizeWorkspaceDefault } from "../src/main/backend/workspace";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LINES_AGENT = readFileSync(path.resolve(HERE, "../../server/agent.mjs"), "utf8").split("\n");
const segAgent = (start: number, end: number) => LINES_AGENT.slice(start - 1, end).join("\n").replace(/^export\s+/gm, "");

// 行号锚点：源文件结构变动导致偏移时，这里先行失败提醒更新提取区间
expect(segAgent(843, 843)).toContain("class AgentManager extends EventEmitter {");
expect(segAgent(844, 844)).toContain("constructor() {");
expect(segAgent(991, 991)).toContain("async getOrCreate(clientId, options = {}) {");
expect(segAgent(3461, 3461)).toContain("async prompt(clientId, text, images = [], effort) {");
expect(segAgent(3556, 3556)).toContain("promptWithContext(clientId, text, images = [], effort, references = [], runContext = null) {");
expect(segAgent(3576, 3576)).toContain("}");
expect(segAgent(4151, 4151)).toContain("async abort(clientId, options = {}) {");
expect(segAgent(4240, 4240)).toContain("_sessionBusyError(old)");
expect(segAgent(4253, 4253)).toContain("}");
expect(segAgent(4347, 4347)).toContain("async setCurrentFile(clientId, file) {");
expect(segAgent(4365, 4365)).toContain("runtimeHealth(clientId) {");
expect(segAgent(4367, 4367)).toContain("}");
expect(segAgent(4403, 4403)).toContain('async restartRuntime(clientId, { threadId = null, sessionPath = null, cwd = getWorkspace(), modelSpec = "" } = {}) {');
expect(segAgent(4415, 4415)).toContain("listRuntimes() {");
expect(segAgent(4417, 4417)).toContain("}");

/** 双侧共享的通道 entry mock（emitAbortedOnce/emitChannelSafe 信封落点）。 */
function makeChannelEntry(overrides: Record<string, unknown> = {}) {
  const emitted: any[] = [];
  const entry: any = {
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

/** 会话 entry 种子（可覆写）；isIdle 用共享引用保证双侧深比对可过。 */
const SHARED_IS_IDLE = () => true;
function makeSession(overrides: Record<string, unknown> = {}): any {
  return {
    runtimeId: "rt1",
    session: { sessionId: "s-1", sessionFile: "/store/s-1.jsonl", isIdle: SHARED_IS_IDLE, model: { provider: "prov-x", id: "mdl-1" } },
    sessionManager: { sm: 1 },
    workspace: "norm:/ws/a",
    threadId: "t1",
    ...overrides,
  };
}

/** 双侧共享依赖世界：stub 全部 seam，记录调用序列。 */
function makeWorld(opts: {
  healthOuts?: any[];
  abortImpl?: () => Promise<void>;
  compactOut?: any;
  compactImpl?: () => Promise<any>;
  sessionTreeOut?: any;
  navigateOut?: any;
  listSnapshots?: any;
  schedulerSnapshots?: any;
  configuredModel?: any;
  sessionFileFound?: any;
  normalize?: (dir: unknown) => string | null;
} = {}) {
  const calls = {
    dispose: [] as any[][],
    markRecovery: [] as any[][],
    health: [] as any[][],
    abort: [] as any[][],
    compact: [] as any[][],
    getSessionTree: [] as any[][],
    navigate: [] as any[][],
    listSnapshots: 0,
    configuredModel: 0,
    findSessionFile: [] as unknown[],
    recordRunEvent: [] as any[],
  };
  const nextHealth = () => (opts.healthOuts && opts.healthOuts.length > 1 ? opts.healthOuts.shift() : (opts.healthOuts?.[0] ?? null));
  const piRuntimeManager = {
    modelRuntime: async () => ({ marker: "model-runtime" }),
    dispose: (runtimeId: unknown, session: unknown) => { calls.dispose.push([runtimeId, session]); },
    getSessionTree: (runtimeId: unknown, session: unknown) => { calls.getSessionTree.push([runtimeId, session]); return opts.sessionTreeOut ?? null; },
    navigateSessionTree: async (runtimeId: unknown, session: unknown, entryId: unknown, options: any) => {
      calls.navigate.push([runtimeId, session, entryId, options]);
      return opts.navigateOut ?? {};
    },
    abort: async (runtimeId: unknown, session: unknown) => {
      calls.abort.push([runtimeId, session]);
      if (opts.abortImpl) { await opts.abortImpl(); return; }
    },
    compact: async (runtimeId: unknown, session: unknown, instructions: string) => {
      calls.compact.push([runtimeId, session, instructions]);
      if (opts.compactImpl) return opts.compactImpl();
      return opts.compactOut ?? {};
    },
    health: (runtimeId: unknown, session: unknown, options: any) => { calls.health.push([runtimeId, session, options]); return nextHealth(); },
    markRecovery: (runtimeId: unknown, reason: unknown) => { calls.markRecovery.push([runtimeId, reason]); },
    listSnapshots: () => { calls.listSnapshots += 1; return opts.listSnapshots ?? [{ id: "rt1" }]; },
    schedulerSnapshot: () => opts.schedulerSnapshots ?? { queue: 0 },
  };
  const configuredModelSpec = () => { calls.configuredModel += 1; return opts.configuredModel ?? "cfg/model-a"; };
  const findSessionFileForAgent = (sessionId: unknown) => { calls.findSessionFile.push(sessionId); return "sessionFileFound" in opts ? opts.sessionFileFound : { fullPath: "/store/s-1.jsonl" }; };
  // 同流口径：旧工厂与新侧注入同一 TS 实现（旧 agent.mjs isAbortLikeError 已由 B6-6-1 对拍等价）
  const isAbortLikeError = isAbortLikeErrorDefault;
  // 幂等归一化：真实 normalizeWorkspace 对已归一路径再归一结果不变（promptWithContext 会把
  // 已归一的 current.workspace 再传回 ensureRuntime，stub 不幂等会误入工作区替换分支）
  const normalize = opts.normalize ?? ((dir: unknown) => {
    if (dir === undefined || dir === null || dir === "") return null;
    const s = String(dir);
    return s.startsWith("norm:") ? s : `norm:${s}`;
  });
  const emitDeps = { recordRunEvent: (id: unknown, type: unknown, data: unknown) => { calls.recordRunEvent.push([id, type, data]); } };
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
    emitDeps,
  };
  return { deps, calls, emitDeps, normalize, isAbortLikeError };
}

/** 旧侧类工厂：4a 段（类头+构造器+getOrCreate）+ 四段生命周期方法拼 class，依赖同名参数注入。 */
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
${segAgent(3461, 3576)}
${segAgent(4151, 4253)}
${segAgent(4347, 4367)}
${segAgent(4403, 4417)}
}
return AgentManager;`,
  )(
    EventEmitter,
    {}, // RUNTIME_FLAGS：agentBusyWatchdog 默认关，看门狗 interval 空转
    world.deps.piRuntimeManager,
    world.deps.normalizeWorkspace,
    getWorkspace,
    world.deps.configuredModelSpec,
    world.deps.findSessionFileForAgent,
    world.isAbortLikeError,
    // 旧类三参调用 → 包装绑定同一 emitDeps，与新侧 this.deps.emitDeps 同流
    (entry: any, type: string, data: any, o: any) => emitChannelSafe(entry, type, data, o, world.deps.emitDeps),
    (entry: any, reason?: string) => emitAbortedOnce(entry, reason, world.deps.emitDeps),
    world.deps.getRun,
    world.deps.listStoredMemoryProposals,
    world.deps.approveStoredMemoryProposal,
    world.deps.editStoredMemoryProposal,
    world.deps.rejectStoredMemoryProposal,
    world.deps.mergeMemoryProposals,
    world.deps.getMemoryProposalHistory,
    () => [], // readPendingAsks（submitAnswer/pendingQuestions 4b 场景不触达）
    () => null, // resolvePendingAsk（同上）
  );
  return new Ctor() as any;
}

/** 两侧实例覆写未迁移方法（_create 回填 sessions 模拟真实 _create L3456 行为）。 */
function stubUnmigrated(mgr: any, calls: { _create: any[][]; _enqueue: any[][]; _writeCtx: any[][] }, built: Record<string, unknown>) {
  mgr._create = async (clientId: unknown, options: any) => {
    calls._create.push([clientId, options]);
    const entry = { ...built, workspace: options.cwd };
    mgr.sessions.set(clientId, entry);
    return entry;
  };
  mgr._enqueuePrompt = (entry: unknown, payload: unknown) => {
    calls._enqueue.push([entry, payload]);
    return { enqueued: true, entry, payload };
  };
  mgr.writeContextFile = (entry: unknown, file: unknown, sharedMemCtx: unknown = null) => {
    calls._writeCtx.push([entry, file, sharedMemCtx]);
    return { wrote: true };
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("B6-6-4b prompt 族", () => {
  it("prompt：既有 entry 直接入队，payload 固定 references:[]/runContext:null，返回透传", async () => {
    const world = makeWorld();
    const oldMgr = makeOldManager(world);
    const newMgr = new AgentManager(world.deps);
    const calls = { _create: [] as any[][], _enqueue: [] as any[][], _writeCtx: [] as any[][] };
    stubUnmigrated(oldMgr, calls, makeSession());
    stubUnmigrated(newMgr, calls, makeSession());
    oldMgr.sessions.set("c1", makeSession());
    newMgr.sessions.set("c1", makeSession());
    const newRes = await newMgr.prompt("c1", "你好", ["img1"], "high");
    const oldRes = await oldMgr.prompt("c1", "你好", ["img1"], "high");
    expect(newRes).toEqual(oldRes);
    expect(newRes).toEqual({ enqueued: true, entry: newMgr.sessions.get("c1"), payload: { text: "你好", images: ["img1"], effort: "high", references: [], runContext: null } });
    expect(calls._enqueue).toHaveLength(2);
    expect(calls._create).toEqual([]);
  });

  it("promptWithContext 健康：直接以当前 entry 入队（含 references/runContext 原样）", async () => {
    const world = makeWorld({ healthOuts: [{ status: "ok" }] });
    const oldMgr = makeOldManager(world);
    const newMgr = new AgentManager(world.deps);
    const calls = { _create: [] as any[][], _enqueue: [] as any[][], _writeCtx: [] as any[][] };
    stubUnmigrated(oldMgr, calls, makeSession());
    stubUnmigrated(newMgr, calls, makeSession());
    oldMgr.sessions.set("c1", makeSession());
    newMgr.sessions.set("c1", makeSession());
    const newRes = newMgr.promptWithContext("c1", "hi", [], "low", ["ref1"], { run: 1 });
    const oldRes = oldMgr.promptWithContext("c1", "hi", [], "low", ["ref1"], { run: 1 });
    expect(newRes).toEqual(oldRes);
    expect(calls._enqueue).toEqual([
      [newMgr.sessions.get("c1"), { text: "hi", images: [], effort: "low", references: ["ref1"], runContext: { run: 1 } }],
      [oldMgr.sessions.get("c1"), { text: "hi", images: [], effort: "low", references: ["ref1"], runContext: { run: 1 } }],
    ]);
  });

  it("promptWithContext failed：ensureRuntime 恢复链（findSessionFileForAgent/restartRuntime 参数/回退置位）后入队新 entry", async () => {
    const world = makeWorld({
      healthOuts: [{ status: "failed" }, { status: "failed" }], // 外层体检与恢复链二次体检均为 failed
      configuredModel: "cfg/model-a",
    });
    const oldMgr = makeOldManager(world);
    const newMgr = new AgentManager(world.deps);
    const calls = { _create: [] as any[][], _enqueue: [] as any[][], _writeCtx: [] as any[][] };
    stubUnmigrated(oldMgr, calls, makeSession());
    stubUnmigrated(newMgr, calls, makeSession());
    oldMgr.sessions.set("c1", makeSession());
    newMgr.sessions.set("c1", makeSession());
    const newRes = await newMgr.promptWithContext("c1", "hi", [], undefined, [], null);
    const oldRes = await oldMgr.promptWithContext("c1", "hi", [], undefined, [], null);
    expect(newRes).toEqual(oldRes);
    // restartRuntime → _create 收到 {cwd, threadId, sessionPath, modelSpec}
    expect(calls._create).toEqual([
      ["c1", { cwd: "norm:/ws/a", threadId: "t1", sessionPath: "/store/s-1.jsonl", modelSpec: "cfg/model-a" }],
      ["c1", { cwd: "norm:/ws/a", threadId: "t1", sessionPath: "/store/s-1.jsonl", modelSpec: "cfg/model-a" }],
    ]);
    expect(world.calls.findSessionFile).toEqual(["s-1", "s-1"]);
    // 回退置位：modelSpec ≠ failedModel(prov-x/mdl-1)
    expect(newMgr.sessions.get("c1").modelFallbackSpec).toBe("cfg/model-a");
    expect(newMgr.sessions.get("c1").modelFallbackFrom).toBe("prov-x/mdl-1");
    expect(oldMgr.sessions.get("c1").modelFallbackSpec).toBe("cfg/model-a");
    expect(oldMgr.sessions.get("c1").modelFallbackFrom).toBe("prov-x/mdl-1");
    expect(calls._enqueue).toHaveLength(2);
  });

  it("promptWithContext 无 entry：getOrCreate 建新后入队", async () => {
    const world = makeWorld({ healthOuts: [{ status: "ok" }] });
    const oldMgr = makeOldManager(world);
    const newMgr = new AgentManager(world.deps);
    const calls = { _create: [] as any[][], _enqueue: [] as any[][], _writeCtx: [] as any[][] };
    stubUnmigrated(oldMgr, calls, makeSession());
    stubUnmigrated(newMgr, calls, makeSession());
    const newRes = await newMgr.promptWithContext("c1", "hi", [], undefined, [], null);
    const oldRes = await oldMgr.promptWithContext("c1", "hi", [], undefined, [], null);
    expect(newRes).toEqual(oldRes);
    expect(calls._create).toHaveLength(2);
    expect(calls._enqueue).toHaveLength(2);
  });
});

describe("B6-6-4b 会话树", () => {
  it("sessionTree：树列表形状对拍；不可用抛错文案一致", async () => {
    const tree = [{ id: "n1" }, { id: "n2" }];
    const world = makeWorld({ sessionTreeOut: tree });
    const oldMgr = makeOldManager(world);
    const newMgr = new AgentManager(world.deps);
    oldMgr.sessions.set("c1", makeSession());
    newMgr.sessions.set("c1", makeSession());
    const newTree = await newMgr.sessionTree("c1");
    const oldTree = await oldMgr.sessionTree("c1");
    expect(newTree).toEqual(oldTree);
    expect(newTree).toEqual({ sessionId: "s-1", sessionFile: "/store/s-1.jsonl", nodeCount: 2, tree });
    const world2 = makeWorld({ sessionTreeOut: null });
    const oldMgr2 = makeOldManager(world2);
    const newMgr2 = new AgentManager(world2.deps);
    oldMgr2.sessions.set("c1", makeSession());
    newMgr2.sessions.set("c1", makeSession());
    await expect(newMgr2.sessionTree("c1")).rejects.toThrow("当前会话不支持会话树读取（sessionManager.getTree 不可用）");
    await expect(oldMgr2.sessionTree("c1")).rejects.toThrow("当前会话不支持会话树读取（sessionManager.getTree 不可用）");
  });

  it("branchSession：busy 拒绝；navigate 调用形态（summarize/label 默认与自定义）与返回形状", async () => {
    const world = makeWorld({ navigateOut: { summaryEntry: { id: "sum" }, cancelled: false, aborted: false } });
    const oldMgr = makeOldManager(world);
    const newMgr = new AgentManager(world.deps);
    oldMgr.sessions.set("c1", makeSession({ busy: true }));
    newMgr.sessions.set("c1", makeSession({ busy: true }));
    await expect(newMgr.branchSession("c1", "n1")).rejects.toThrow("会话正在执行任务，不能切换分支；请先停止当前任务");
    await expect(oldMgr.branchSession("c1", "n1")).rejects.toThrow("会话正在执行任务，不能切换分支；请先停止当前任务");
    oldMgr.sessions.set("c1", makeSession());
    newMgr.sessions.set("c1", makeSession());
    const newRes = await newMgr.branchSession("c1", "n1", { label: "我的分支" });
    const oldRes = await oldMgr.branchSession("c1", "n1", { label: "我的分支" });
    expect(newRes).toEqual(oldRes);
    expect(newRes).toEqual({ sessionId: "s-1", navigatedTo: "n1", summarize: true, summaryEntry: { id: "sum" }, cancelled: false, aborted: false });
    expect(world.calls.navigate).toEqual([
      ["rt1", newMgr.sessions.get("c1").session, "n1", { summarize: true, label: "我的分支" }],
      ["rt1", oldMgr.sessions.get("c1").session, "n1", { summarize: true, label: "我的分支" }],
    ]);
    // summarize: false 与 entryId 缺失
    const world2 = makeWorld({ navigateOut: null });
    const oldMgr2 = makeOldManager(world2);
    const newMgr2 = new AgentManager(world2.deps);
    oldMgr2.sessions.set("c1", makeSession());
    newMgr2.sessions.set("c1", makeSession());
    const newRes2 = await newMgr2.branchSession("c1", 42, { summarize: false });
    const oldRes2 = await oldMgr2.branchSession("c1", 42, { summarize: false });
    expect(newRes2).toEqual(oldRes2);
    expect(newRes2.summarize).toBe(false);
    expect(newRes2.summaryEntry).toBeNull();
    await expect(newMgr2.branchSession("c1", "")).rejects.toThrow("entryId required");
    await expect(oldMgr2.branchSession("c1", "")).rejects.toThrow("entryId required");
  });
});

describe("B6-6-4b ensureRuntime 恢复链", () => {
  it("无 existing / 工作区不一致：走 getOrCreate 路径", async () => {
    const world = makeWorld({ healthOuts: [{ status: "ok" }] });
    const oldMgr = makeOldManager(world);
    const newMgr = new AgentManager(world.deps);
    const calls = { _create: [] as any[][], _enqueue: [] as any[][], _writeCtx: [] as any[][] };
    stubUnmigrated(oldMgr, calls, makeSession());
    stubUnmigrated(newMgr, calls, makeSession());
    expect(await newMgr.ensureRuntime("c1")).toBe(newMgr.sessions.get("c1"));
    expect(await oldMgr.ensureRuntime("c1")).toBe(oldMgr.sessions.get("c1"));
    oldMgr.sessions.set("c2", makeSession());
    newMgr.sessions.set("c2", makeSession());
    expect(await newMgr.ensureRuntime("c2", { cwd: "/ws/other" })).toBe(newMgr.sessions.get("c2"));
    expect(await oldMgr.ensureRuntime("c2", { cwd: "/ws/other" })).toBe(oldMgr.sessions.get("c2"));
    // 工作区不一致 → getOrCreate 替换（dispose+重建，两侧各一次）
    expect(world.calls.dispose).toHaveLength(2);
    expect(world.calls.dispose.every((d) => d[0] === "rt1")).toBe(true);
    expect(calls._create).toHaveLength(4);
  });

  it("健康直返 existing；stale error code 触发恢复", async () => {
    const world = makeWorld({ healthOuts: [{ status: "ok" }] });
    const oldMgr = makeOldManager(world);
    const newMgr = new AgentManager(world.deps);
    const calls = { _create: [] as any[][], _enqueue: [] as any[][], _writeCtx: [] as any[][] };
    stubUnmigrated(oldMgr, calls, makeSession());
    stubUnmigrated(newMgr, calls, makeSession());
    oldMgr.sessions.set("c1", makeSession());
    newMgr.sessions.set("c1", makeSession());
    expect(await newMgr.ensureRuntime("c1", { cwd: "/ws/a" })).toBe(newMgr.sessions.get("c1"));
    expect(await oldMgr.ensureRuntime("c1", { cwd: "/ws/a" })).toBe(oldMgr.sessions.get("c1"));
    expect(calls._create).toEqual([]);
    // error.code 命中 stale 名录（恢复链二次体检同 stale 才会真正重建）
    const world2 = makeWorld({ healthOuts: [{ status: "ok", error: { code: "PI_SETTLED_ERROR" } }, { status: "ok", error: { code: "PI_SETTLED_ERROR" } }] });
    const oldMgr2 = makeOldManager(world2);
    const newMgr2 = new AgentManager(world2.deps);
    const calls2 = { _create: [] as any[][], _enqueue: [] as any[][], _writeCtx: [] as any[][] };
    stubUnmigrated(oldMgr2, calls2, makeSession());
    stubUnmigrated(newMgr2, calls2, makeSession());
    oldMgr2.sessions.set("c1", makeSession());
    newMgr2.sessions.set("c1", makeSession());
    await newMgr2.ensureRuntime("c1", { cwd: "/ws/a" });
    await oldMgr2.ensureRuntime("c1", { cwd: "/ws/a" });
    expect(calls2._create).toHaveLength(2);
  });

  it("恢复链单飞：并发共享 recovery promise，restartRuntime 仅一次", async () => {
    const world = makeWorld({ healthOuts: [{ status: "failed" }, { status: "failed" }] });
    const oldMgr = makeOldManager(world);
    const newMgr = new AgentManager(world.deps);
    const calls = { _create: [] as any[][], _enqueue: [] as any[][], _writeCtx: [] as any[][] };
    stubUnmigrated(oldMgr, calls, makeSession());
    stubUnmigrated(newMgr, calls, makeSession());
    oldMgr.sessions.set("c1", makeSession());
    newMgr.sessions.set("c1", makeSession());
    const [n1, n2] = await Promise.all([newMgr.ensureRuntime("c1"), newMgr.ensureRuntime("c1")]);
    const [o1, o2] = await Promise.all([oldMgr.ensureRuntime("c1"), oldMgr.ensureRuntime("c1")]);
    expect(n1).toBe(n2);
    expect(o1).toBe(o2);
    expect(calls._create).toHaveLength(2); // 两侧各一次
  });

  it("恢复链参数回退：fallbackModel 与 failedModel 相同走 options.modelSpec；found 缺失 sessionPath null", async () => {
    const world = makeWorld({
      healthOuts: [{ status: "failed" }, { status: "failed" }],
      configuredModel: "prov-x/mdl-1", // 与 failedModel 相同
      sessionFileFound: null,
    });
    const oldMgr = makeOldManager(world);
    const newMgr = new AgentManager(world.deps);
    const calls = { _create: [] as any[][], _enqueue: [] as any[][], _writeCtx: [] as any[][] };
    stubUnmigrated(oldMgr, calls, makeSession());
    stubUnmigrated(newMgr, calls, makeSession());
    oldMgr.sessions.set("c1", makeSession());
    newMgr.sessions.set("c1", makeSession());
    await newMgr.ensureRuntime("c1", { cwd: "/ws/a", modelSpec: "  manual/model  " });
    await oldMgr.ensureRuntime("c1", { cwd: "/ws/a", modelSpec: "  manual/model  " });
    expect(calls._create).toEqual([
      ["c1", { cwd: "/ws/a", threadId: "t1", sessionPath: null, modelSpec: "manual/model" }],
      ["c1", { cwd: "/ws/a", threadId: "t1", sessionPath: null, modelSpec: "manual/model" }],
    ]);
    // modelSpec(manual/model) ≠ failedModel → 回退标记置位为实际采用的 spec
    expect(newMgr.sessions.get("c1").modelFallbackSpec).toBe("manual/model");
    expect(newMgr.sessions.get("c1").modelFallbackFrom).toBe("prov-x/mdl-1");
    expect(oldMgr.sessions.get("c1").modelFallbackSpec).toBe("manual/model");
  });
});

describe("B6-6-4b abort 与 resolveLiveEntry", () => {
  it("无 live entry：返回 no-live-session 不投递", async () => {
    const world = makeWorld();
    const oldMgr = makeOldManager(world);
    const newMgr = new AgentManager(world.deps);
    const newRes = await newMgr.abort("c1");
    const oldRes = await oldMgr.abort("c1");
    expect(newRes).toEqual(oldRes);
    expect(newRes).toEqual({ ok: true, cancelled: false, reason: "no-live-session" });
    expect(world.calls.abort).toEqual([]);
  });

  it("abort 正常：字段置位 + aborted 终态事件一次 + busy 清零 + 返回形状", async () => {
    const world = makeWorld();
    const oldMgr = makeOldManager(world);
    const newMgr = new AgentManager(world.deps);
    const oldT1 = makeChannelEntry(makeSession({ activeRunId: "run-1", busy: true }));
    const newT1 = makeChannelEntry(makeSession({ activeRunId: "run-1", busy: true }));
    oldMgr.sessions.set("c1", oldT1.entry);
    newMgr.sessions.set("c1", newT1.entry);
    const newRes = await newMgr.abort("c1");
    const oldRes = await oldMgr.abort("c1");
    expect(newRes).toEqual(oldRes);
    expect(newRes).toEqual({ ok: true, cancelled: true, runId: "run-1", runtimeAborted: true, thread: "t1", emitted: true });
    expect(newT1.entry.cancelRequested).toBe(true);
    expect(newT1.entry.abortRequestedAt).toBe(Date.now());
    expect(newT1.entry.runStopCache).toBe(true);
    expect(newT1.entry.busy).toBe(false);
    expect(newT1.emitted).toEqual(oldT1.emitted);
    expect(newT1.emitted.map((ev: any) => ev.type)).toEqual(["aborted"]);
    expect(newT1.emitted[0].data).toEqual({ runId: "run-1", reason: "用户请求中断" });
    expect(world.calls.recordRunEvent).toEqual([
      ["run-1", "aborted", { runId: "run-1", reason: "用户请求中断" }],
      ["run-1", "aborted", { runId: "run-1", reason: "用户请求中断" }],
    ]);
  });

  it("abort runtime 抛普通错：agent_error 事件 + 仍发 aborted；abort-like 错不发 agent_error", async () => {
    // 普通错：消息不得命中 ABORT_LIKE_PATTERN（abort/中断/取消等词），否则两侧同判 abort-like
    const boom = new Error("boom");
    const world = makeWorld({ abortImpl: async () => { throw boom; } });
    const oldMgr = makeOldManager(world);
    const newMgr = new AgentManager(world.deps);
    const oldT1 = makeChannelEntry(makeSession({ activeRunId: "run-1" }));
    const newT1 = makeChannelEntry(makeSession({ activeRunId: "run-1" }));
    oldMgr.sessions.set("c1", oldT1.entry);
    newMgr.sessions.set("c1", newT1.entry);
    const newRes = await newMgr.abort("c1");
    const oldRes = await oldMgr.abort("c1");
    expect(newRes).toEqual(oldRes);
    expect(newRes.runtimeAborted).toBe(false);
    expect(newT1.emitted.map((ev: any) => ev.type)).toEqual(["agent_error", "aborted"]);
    expect(newT1.emitted).toEqual(oldT1.emitted);
    // runId 由 emitChannelSafe 投递层注入（data.runId ?? entry.activeRunId），abort 调用点本身不带
    expect(newT1.emitted[0].data).toEqual({ message: "boom", code: "RUNTIME_ABORT_FAILED", runId: "run-1" });
    // abort-like（消息命中中断词表）：不投 agent_error，但 aborted 终态仍发
    const world2 = makeWorld({ abortImpl: async () => { throw new Error("request aborted by user"); } });
    const oldMgr2 = makeOldManager(world2);
    const newMgr2 = new AgentManager(world2.deps);
    const oldT2 = makeChannelEntry(makeSession({ activeRunId: "run-1" }));
    const newT2 = makeChannelEntry(makeSession({ activeRunId: "run-1" }));
    oldMgr2.sessions.set("c1", oldT2.entry);
    newMgr2.sessions.set("c1", newT2.entry);
    const newRes2 = await newMgr2.abort("c1");
    const oldRes2 = await oldMgr2.abort("c1");
    expect(newRes2).toEqual(oldRes2);
    expect(newT2.emitted.map((ev: any) => ev.type)).toEqual(["aborted"]);
    expect(newT2.emitted).toEqual(oldT2.emitted);
  });

  it("abort runId 兜底：entry 无 activeRunId 时取 options.runId", async () => {
    const world = makeWorld();
    const oldMgr = makeOldManager(world);
    const newMgr = new AgentManager(world.deps);
    oldMgr.sessions.set("c1", makeSession({ activeRunId: null }));
    newMgr.sessions.set("c1", makeSession({ activeRunId: null }));
    const newRes = await newMgr.abort("c1", { runId: "r2" });
    const oldRes = await oldMgr.abort("c1", { runId: "r2" });
    expect(newRes).toEqual(oldRes);
    expect(newRes.runId).toBe("r2");
  });

  it("resolveLiveEntry：exact 命中；前缀兜底 busy 优先；miss/无 key 为 null", () => {
    const world = makeWorld();
    const oldMgr = makeOldManager(world);
    const newMgr = new AgentManager(world.deps);
    const idle = makeSession();
    const busy = makeSession({ runtimeId: "rt2", busy: true }); // 判据：busy || activeRunId
    for (const mgr of [oldMgr, newMgr]) {
      mgr.sessions.set("c1::t1", makeSession());
      mgr.sessions.set("c2::tA", idle);
      mgr.sessions.set("c2::tB", busy);
    }
    expect(newMgr.resolveLiveEntry("c1::t1")).toBe(newMgr.sessions.get("c1::t1"));
    expect(oldMgr.resolveLiveEntry("c1::t1")).toBe(oldMgr.sessions.get("c1::t1"));
    expect(newMgr.resolveLiveEntry("c2::tZ")).toBe(busy);
    expect(oldMgr.resolveLiveEntry("c2::tZ")).toBe(busy);
    // 全空闲 → 返回首个前缀命中
    busy.busy = false;
    expect(newMgr.resolveLiveEntry("c2::tZ")).toBe(idle);
    expect(oldMgr.resolveLiveEntry("c2::tZ")).toBe(idle);
    expect(newMgr.resolveLiveEntry("missing")).toBeNull();
    expect(oldMgr.resolveLiveEntry("missing")).toBeNull();
    expect(newMgr.resolveLiveEntry("")).toBeNull();
    expect(oldMgr.resolveLiveEntry("")).toBeNull();
  });
});

describe("B6-6-4b compact / newThread / resumeThread", () => {
  it("compact 忙时拒绝（busy/compacting/queued/isIdle false）", async () => {
    for (const seed of [{ busy: true }, { compacting: true }, { queuedCount: 1 }, { session: { isIdle: () => false } }]) {
      const world = makeWorld({ compactOut: { tokensBefore: 10, estimatedTokensAfter: 5 } });
      const oldMgr = makeOldManager(world);
      const newMgr = new AgentManager(world.deps);
      oldMgr.sessions.set("c1", makeSession(seed));
      newMgr.sessions.set("c1", makeSession(seed));
      await expect(newMgr.compact("c1")).rejects.toThrow("agent busy — wait for the current task to finish");
      await expect(oldMgr.compact("c1")).rejects.toThrow("agent busy — wait for the current task to finish");
    }
  });

  it("compact 成功：置位/调用形态（指令 trim）/结果/用量清零/finally 清理", async () => {
    const world = makeWorld({ compactOut: { tokensBefore: 100, estimatedTokensAfter: 40 } });
    const oldMgr = makeOldManager(world);
    const newMgr = new AgentManager(world.deps);
    const entrySeed = { activeRunId: "run-1", promptChars: 1234, lastUsage: { input: 1 } };
    oldMgr.sessions.set("c1", makeSession(entrySeed));
    newMgr.sessions.set("c1", makeSession(entrySeed));
    const newRes = await newMgr.compact("c1", "  保留结论  ");
    const oldRes = await oldMgr.compact("c1", "  保留结论  ");
    expect(newRes).toEqual(oldRes);
    expect(newRes).toEqual({ ok: true, tokensBefore: 100, estimatedTokensAfter: 40 });
    expect(world.calls.compact).toEqual([
      ["rt1", newMgr.sessions.get("c1").session, "保留结论"],
      ["rt1", oldMgr.sessions.get("c1").session, "保留结论"],
    ]);
    const e = newMgr.sessions.get("c1");
    expect(e.lastCompactionAt).toBe(Date.now());
    expect(e.promptChars).toBe(0);
    expect(e.lastUsage).toBeNull();
    expect(e.compacting).toBe(false);
    expect(e.compactionPromise).toBeNull();
    expect(e.compactionRunId).toBeNull();
    expect(e.compactionKind).toBeNull();
    expect(oldMgr.sessions.get("c1").lastCompactionAt).toBe(Date.now());
  });

  it("compact 失败：错误传播且 finally 仍清理", async () => {
    const world = makeWorld({ compactImpl: async () => { throw new Error("compact boom"); } });
    const oldMgr = makeOldManager(world);
    const newMgr = new AgentManager(world.deps);
    oldMgr.sessions.set("c1", makeSession());
    newMgr.sessions.set("c1", makeSession());
    await expect(newMgr.compact("c1")).rejects.toThrow("compact boom");
    await expect(oldMgr.compact("c1")).rejects.toThrow("compact boom");
    const e = newMgr.sessions.get("c1");
    expect(e.compacting).toBe(false);
    expect(e.compactionRunId).toBeNull();
    expect(oldMgr.sessions.get("c1").compacting).toBe(false);
  });

  it("newThread：无旧/旧空闲 dispose 重建/旧忙拒绝/工作区缺失拒绝", async () => {
    const world = makeWorld();
    const oldMgr = makeOldManager(world);
    const newMgr = new AgentManager(world.deps);
    const calls = { _create: [] as any[][], _enqueue: [] as any[][], _writeCtx: [] as any[][] };
    stubUnmigrated(oldMgr, calls, makeSession());
    stubUnmigrated(newMgr, calls, makeSession());
    const newRes = await newMgr.newThread("c1", "t9", "/ws/b");
    const oldRes = await oldMgr.newThread("c1", "t9", "/ws/b");
    expect(newRes).toEqual(oldRes);
    expect(newRes).toEqual({ ok: true, threadId: "t9", sessionId: "s-1", runtimeId: "rt1", cwd: "norm:/ws/b" });
    expect(calls._create).toEqual([
      ["c1", { cwd: "norm:/ws/b", threadId: "t9" }],
      ["c1", { cwd: "norm:/ws/b", threadId: "t9" }],
    ]);
    // 旧忙拒绝
    oldMgr.sessions.set("c2", makeSession({ busy: true }));
    newMgr.sessions.set("c2", makeSession({ busy: true }));
    await expect(newMgr.newThread("c2", "t9", "/ws/b")).rejects.toThrow("当前会话仍有任务排队，不能替换活动会话");
    await expect(oldMgr.newThread("c2", "t9", "/ws/b")).rejects.toThrow("当前会话仍有任务排队，不能替换活动会话");
    // 工作区缺失
    const world2 = makeWorld({ normalize: () => null });
    const oldMgr2 = makeOldManager(world2);
    const newMgr2 = new AgentManager(world2.deps);
    await expect(newMgr2.newThread("c1", "t9", "/ws/b")).rejects.toThrow("当前工作区不存在或不是文件夹");
    await expect(oldMgr2.newThread("c1", "t9", "/ws/b")).rejects.toThrow("当前工作区不存在或不是文件夹");
  });

  it("resumeThread：单飞共享在途；旧忙抛 TypeError（_sessionBusyError 现状缺陷固化，双侧同文案）", async () => {
    const world = makeWorld();
    const oldMgr = makeOldManager(world);
    const newMgr = new AgentManager(world.deps);
    const calls = { _create: [] as any[][], _enqueue: [] as any[][], _writeCtx: [] as any[][] };
    stubUnmigrated(oldMgr, calls, makeSession());
    stubUnmigrated(newMgr, calls, makeSession());
    const [n1, n2] = await Promise.all([newMgr.resumeThread("c1", "t9", "/store/s-1.jsonl", "/ws/b"), newMgr.resumeThread("c1", "t9", "/store/s-1.jsonl", "/ws/b")]);
    const [o1, o2] = await Promise.all([oldMgr.resumeThread("c1", "t9", "/store/s-1.jsonl", "/ws/b"), oldMgr.resumeThread("c1", "t9", "/store/s-1.jsonl", "/ws/b")]);
    expect(n1).toEqual(n2);
    expect(o1).toEqual(o2);
    expect(n1).toEqual({ ok: true, threadId: "t9", sessionId: "s-1", runtimeId: "rt1", cwd: "norm:/ws/b" });
    expect(calls._create).toEqual([
      ["c1", { cwd: "norm:/ws/b", sessionPath: "/store/s-1.jsonl", threadId: "t9" }],
      ["c1", { cwd: "norm:/ws/b", sessionPath: "/store/s-1.jsonl", threadId: "t9" }],
    ]);
    // 旧忙：两侧均抛 TypeError（旧代码 _sessionBusyError 未定义的固有现状）
    oldMgr.sessions.set("c2", makeSession({ busy: true }));
    newMgr.sessions.set("c2", makeSession({ busy: true }));
    const newErr = await newMgr.resumeThread("c2", "t9", null, "/ws/b").catch((e: any) => e);
    const oldErr = await oldMgr.resumeThread("c2", "t9", null, "/ws/b").catch((e: any) => e);
    expect(newErr).toBeInstanceOf(TypeError);
    expect(oldErr).toBeInstanceOf(TypeError);
    expect(newErr.message).toBe(oldErr.message);
    expect(newErr.message).toContain("_sessionBusyError");
    // dispose 未触发（抛错在 dispose 之前）
    expect(world.calls.dispose).toEqual([]);
  });

  it("setCurrentFile：既有 entry 置位并同步 writeContextFile；无 entry 走 getOrCreate", async () => {
    const world = makeWorld();
    const oldMgr = makeOldManager(world);
    const newMgr = new AgentManager(world.deps);
    const calls = { _create: [] as any[][], _enqueue: [] as any[][], _writeCtx: [] as any[][] };
    stubUnmigrated(oldMgr, calls, makeSession());
    stubUnmigrated(newMgr, calls, makeSession());
    oldMgr.sessions.set("c1", makeSession());
    newMgr.sessions.set("c1", makeSession());
    const newRes = await newMgr.setCurrentFile("c1", "docs/a.md");
    const oldRes = await oldMgr.setCurrentFile("c1", "docs/a.md");
    expect(newRes).toEqual(oldRes);
    expect(newRes).toEqual({ ok: true, currentFile: "docs/a.md" });
    expect(calls._writeCtx).toEqual([
      [newMgr.sessions.get("c1"), "docs/a.md", null],
      [oldMgr.sessions.get("c1"), "docs/a.md", null],
    ]);
    // file 空串 → null
    const newRes2 = await newMgr.setCurrentFile("c1", "");
    const oldRes2 = await oldMgr.setCurrentFile("c1", "");
    expect(newRes2).toEqual(oldRes2);
    expect(newRes2.currentFile).toBeNull();
    // 无 entry → getOrCreate
    await newMgr.setCurrentFile("c9", "x.md");
    await oldMgr.setCurrentFile("c9", "x.md");
    expect(calls._create).toHaveLength(2);
  });
});

describe("B6-6-4b 快照与重启", () => {
  it("runtimeSnapshot：无 entry null；health 调用形态（profile/toolPolicy/overrides 展开）", () => {
    const world = makeWorld({ healthOuts: [{ status: "ok", marker: "snap" }] });
    const oldMgr = makeOldManager(world);
    const newMgr = new AgentManager(world.deps);
    expect(newMgr.runtimeSnapshot("c1")).toBeNull();
    expect(oldMgr.runtimeSnapshot("c1")).toBeNull();
    oldMgr.sessions.set("c1", makeSession());
    newMgr.sessions.set("c1", makeSession());
    expect(newMgr.runtimeSnapshot("c1")).toEqual({ status: "ok", marker: "snap" });
    expect(oldMgr.runtimeSnapshot("c1")).toEqual({ status: "ok", marker: "snap" });
    // modePolicy → toolPolicy 快照（tools 数组拷贝）
    newMgr.sessions.get("c1").modePolicy = { mode: "ask", tools: ["read", "write"] };
    oldMgr.sessions.get("c1").modePolicy = { mode: "ask", tools: ["read", "write"] };
    newMgr.runtimeSnapshot("c1");
    oldMgr.runtimeSnapshot("c1");
    expect(world.calls.health[2]![2]).toEqual({ profile: "通用 Agent", toolPolicy: { mode: "ask", tools: ["read", "write"] } });
    expect(world.calls.health[3]![2]).toEqual({ profile: "通用 Agent", toolPolicy: { mode: "ask", tools: ["read", "write"] } });
    // overrides 覆盖 profile 与 toolPolicy
    newMgr.runtimeSnapshot("c1", { profile: "自定义", toolPolicy: null });
    oldMgr.runtimeSnapshot("c1", { profile: "自定义", toolPolicy: null });
    expect(world.calls.health[4]![2]).toEqual({ profile: "自定义", toolPolicy: null });
    expect(world.calls.health[5]![2]).toEqual({ profile: "自定义", toolPolicy: null });
  });

  it("runtimeHealth：无 entry 返回 missing 兜底形状；有 entry 透传快照", () => {
    const world = makeWorld({ healthOuts: [{ status: "degraded" }] });
    const oldMgr = makeOldManager(world);
    const newMgr = new AgentManager(world.deps);
    expect(newMgr.runtimeHealth("c1")).toEqual({ status: "missing", health: { status: "unknown", message: "Runtime 尚未创建" } });
    expect(oldMgr.runtimeHealth("c1")).toEqual({ status: "missing", health: { status: "unknown", message: "Runtime 尚未创建" } });
    oldMgr.sessions.set("c1", makeSession());
    newMgr.sessions.set("c1", makeSession());
    expect(newMgr.runtimeHealth("c1")).toEqual({ status: "degraded" });
    expect(oldMgr.runtimeHealth("c1")).toEqual({ status: "degraded" });
  });

  it("restartRuntime：忙拒绝；空闲 markRecovery+dispose+重建，返回 jsonl_reopen 形状", async () => {
    const world = makeWorld();
    const oldMgr = makeOldManager(world);
    const newMgr = new AgentManager(world.deps);
    const calls = { _create: [] as any[][], _enqueue: [] as any[][], _writeCtx: [] as any[][] };
    stubUnmigrated(oldMgr, calls, makeSession());
    stubUnmigrated(newMgr, calls, makeSession());
    oldMgr.sessions.set("c1", makeSession({ busy: true }));
    newMgr.sessions.set("c1", makeSession({ busy: true }));
    await expect(newMgr.restartRuntime("c1", {})).rejects.toThrow("当前 Runtime 仍有任务排队，不能重启");
    await expect(oldMgr.restartRuntime("c1", {})).rejects.toThrow("当前 Runtime 仍有任务排队，不能重启");
    oldMgr.sessions.set("c1", makeSession());
    newMgr.sessions.set("c1", makeSession());
    const newRes = await newMgr.restartRuntime("c1", { threadId: "t2", sessionPath: "/store/s-1.jsonl", cwd: "/ws/b", modelSpec: "m/1" });
    const oldRes = await oldMgr.restartRuntime("c1", { threadId: "t2", sessionPath: "/store/s-1.jsonl", cwd: "/ws/b", modelSpec: "m/1" });
    expect(newRes).toEqual(oldRes);
    // 返回 cwd 取 entry.workspace（stub _create 原样回填 options.cwd，restartRuntime 不再归一）
    expect(newRes).toEqual({ ok: true, threadId: "t2", sessionId: "s-1", runtimeId: "rt1", cwd: "/ws/b", recovery: "jsonl_reopen" });
    expect(world.calls.markRecovery).toEqual([["rt1", "manual_runtime_restart"], ["rt1", "manual_runtime_restart"]]);
    expect(calls._create).toEqual([
      ["c1", { cwd: "/ws/b", threadId: "t2", sessionPath: "/store/s-1.jsonl", modelSpec: "m/1" }],
      ["c1", { cwd: "/ws/b", threadId: "t2", sessionPath: "/store/s-1.jsonl", modelSpec: "m/1" }],
    ]);
  });

  it("listRuntimes：snapshots/scheduler 透传", () => {
    const world = makeWorld({ listSnapshots: [{ id: "rt-a" }], schedulerSnapshots: { pending: 2 } });
    const oldMgr = makeOldManager(world);
    const newMgr = new AgentManager(world.deps);
    expect(newMgr.listRuntimes()).toEqual({ runtimes: [{ id: "rt-a" }], scheduler: { pending: 2 } });
    expect(oldMgr.listRuntimes()).toEqual({ runtimes: [{ id: "rt-a" }], scheduler: { pending: 2 } });
  });
});
