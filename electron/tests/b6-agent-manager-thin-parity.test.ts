/**
 * B6-6-4a 对拍：AgentManager 类体薄方法批（server/agent.mjs L843-1018）。
 *
 * 覆盖：constructor 状态字段 / startBusyWatchdog 看门狗 / listSessionStates / askPending /
 * submitAnswer 三路径 / isRunStopping 快慢路径与 5s 缓存 / memory 族透传与事件投递 /
 * pendingQuestions / modelRuntime / getOrCreate 工作区归属校验与单飞。
 *
 * 旧侧按行号提取类体源段 + new Function 求值（补右花括号成类）；piRuntimeManager（pi 域未迁）、
 * getRun（runs 域未迁）、memory-management 六函数（未迁）以同名参数注入旧工厂，新侧走
 * AgentManagerDeps 注入，双侧共享同一批 stub 实例同流对拍。_create 未迁（4i 批接管），
 * 两侧均实例覆写注入。行号锚点断言保证源文件变动时先行失败提醒。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { AgentManager, type AgentFlags, type AgentManagerDeps } from "../src/main/backend/agent/agent-manager";
import { emitChannelSafe } from "../src/main/backend/agent/emit-helpers";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LINES_AGENT = readFileSync(path.resolve(HERE, "../../server/agent.mjs"), "utf8").split("\n");
const segAgent = (start: number, end: number) => LINES_AGENT.slice(start - 1, end).join("\n").replace(/^export\s+/gm, "");

// 行号锚点：源文件结构变动导致偏移时，这里先行失败提醒更新提取区间
expect(segAgent(843, 843)).toContain("class AgentManager extends EventEmitter {");
expect(segAgent(844, 844)).toContain("constructor() {");
expect(segAgent(861, 861)).toContain("startBusyWatchdog() {");
expect(segAgent(880, 880)).toContain("listSessionStates() {");
expect(segAgent(904, 904)).toContain("submitAnswer(clientId, answer) {");
expect(segAgent(921, 921)).toContain("isRunStopping(clientId) {");
expect(segAgent(975, 975)).toContain("mergeMemoryProposals(targetId, sourceIds = []) {");
expect(segAgent(991, 991)).toContain("async getOrCreate(clientId, options = {}) {");
expect(segAgent(1018, 1018)).toContain("}");

/** 双侧共享的通道 entry mock（emitChannelSafe 信封落点）。 */
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

/** 双侧共享依赖世界：stub 全部 seam，记录调用序列。 */
function makeWorld(opts: {
  flags?: AgentFlags;
  runs?: Record<string, any>;
  getRunThrows?: boolean;
  asks?: any[];
  resolveAskResult?: any;
  memory?: { list?: any; approve?: any; edit?: any; reject?: any; merge?: any; history?: any };
  normalize?: (dir: unknown) => string | null;
  modelRuntime?: any;
} = {}) {
  const calls = {
    dispose: [] as any[][],
    getRun: [] as unknown[],
    listMem: [] as any[],
    approveMem: [] as any[],
    editMem: [] as any[],
    rejectMem: [] as any[],
    mergeMem: [] as any[],
    historyMem: [] as unknown[],
    readAsks: 0,
    resolveAsk: [] as any[],
    modelRuntime: 0,
    recordRunEvent: [] as any[],
  };
  const piRuntimeManager = {
    modelRuntime: async () => { calls.modelRuntime += 1; return opts.modelRuntime ?? { marker: "model-runtime" }; },
    dispose: (runtimeId: unknown, session: unknown) => { calls.dispose.push([runtimeId, session]); },
    // B6-6-4b 扩员的 seam 方法：thin 批场景不触达，no-op 满足 AgentPiRuntimeSeam 类型
    getSessionTree: () => null,
    navigateSessionTree: async () => ({}),
    abort: async () => {},
    compact: async () => ({}),
    health: () => null,
    markRecovery: () => {},
    listSnapshots: () => [],
    schedulerSnapshot: () => ({}),
  };
  const getRun = (id: unknown) => {
    calls.getRun.push(id);
    if (opts.getRunThrows) throw new Error("run boom");
    return (opts.runs ?? {})[String(id)];
  };
  const listStoredMemoryProposals = (filters: any) => { calls.listMem.push(filters); return opts.memory?.list ?? []; };
  const approveStoredMemoryProposal = (id: unknown, options: any) => { calls.approveMem.push([id, options]); return opts.memory?.approve ?? { proposal: null }; };
  const editStoredMemoryProposal = (id: unknown, options: any) => { calls.editMem.push([id, options]); return opts.memory?.edit ?? { proposal: null }; };
  const rejectStoredMemoryProposal = (id: unknown, reason: unknown) => { calls.rejectMem.push([id, reason]); return opts.memory?.reject ?? { proposal: null }; };
  const mergeMemoryProposals = (targetId: unknown, sourceIds?: unknown[]) => { calls.mergeMem.push([targetId, sourceIds]); return opts.memory?.merge ?? {}; };
  const getMemoryProposalHistory = (id: unknown) => { calls.historyMem.push(id); return opts.memory?.history ?? []; };
  const readPendingAsks = () => { calls.readAsks += 1; return opts.asks ?? []; };
  const resolvePendingAsk = (clientId: unknown, answer: unknown, status: unknown) => { calls.resolveAsk.push([clientId, answer, status]); return opts.resolveAskResult; };
  const emitDeps = { recordRunEvent: (id: unknown, type: unknown, data: unknown) => { calls.recordRunEvent.push([id, type, data]); } };
  const normalize = opts.normalize ?? ((dir: unknown) => (dir === undefined || dir === null || dir === "" ? null : `norm:${String(dir)}`));
  const deps: AgentManagerDeps = {
    piRuntimeManager,
    getRun,
    listStoredMemoryProposals,
    approveStoredMemoryProposal,
    editStoredMemoryProposal,
    rejectStoredMemoryProposal,
    mergeMemoryProposals,
    getMemoryProposalHistory,
    flags: opts.flags ?? {},
    normalizeWorkspace: normalize,
    readPendingAsks,
    resolvePendingAsk,
    emitDeps,
  };
  return { deps, calls, emitDeps, normalize };
}

/** 旧侧类工厂：seg 提取 + 补右花括号，依赖同名参数注入。 */
function makeOldManager(world: ReturnType<typeof makeWorld>) {
  const Ctor = new Function(
    "EventEmitter",
    "RUNTIME_FLAGS",
    "getRun",
    "listStoredMemoryProposals",
    "approveStoredMemoryProposal",
    "editStoredMemoryProposal",
    "rejectStoredMemoryProposal",
    "mergeMemoryProposals",
    "getMemoryProposalHistory",
    "readPendingAsks",
    "resolvePendingAsk",
    "emitChannelSafe",
    "piRuntimeManager",
    "normalizeWorkspace",
    `${segAgent(843, 1018)}\n}\nreturn AgentManager;`,
  )(
    EventEmitter,
    world.deps.flags,
    world.deps.getRun,
    world.deps.listStoredMemoryProposals,
    world.deps.approveStoredMemoryProposal,
    world.deps.editStoredMemoryProposal,
    world.deps.rejectStoredMemoryProposal,
    world.deps.mergeMemoryProposals,
    world.deps.getMemoryProposalHistory,
    world.deps.readPendingAsks,
    world.deps.resolvePendingAsk,
    // 旧类三参调用 → 包装绑定同一 emitDeps，与新侧 this.deps.emitDeps 同流
    (entry: any, type: string, data: any, opts: any) => emitChannelSafe(entry, type, data, opts, world.deps.emitDeps),
    world.deps.piRuntimeManager,
    world.deps.normalizeWorkspace,
  );
  return new Ctor() as any;
}

/** 两侧 _create 实例覆写（4i 未收口，行为对拍注入）。 */
function stubCreate(mgr: any, calls: any[][], impl: (clientId: unknown, options: any) => Promise<any>) {
  mgr._create = (clientId: unknown, options: any) => {
    calls.push([clientId, options]);
    return impl(clientId, options);
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

describe("B6-6-4a 构造与状态字段", () => {
  it("构造状态字段与 EventEmitter 继承双侧同流；creates 按需惰性创建", () => {
    const world = makeWorld();
    const oldMgr = makeOldManager(world);
    const newMgr = new AgentManager(world.deps);
    for (const mgr of [oldMgr, newMgr]) {
      expect(mgr).toBeInstanceOf(EventEmitter);
      expect(mgr.sessions).toBeInstanceOf(Map);
      expect(mgr.sessions.size).toBe(0);
      expect(mgr.pendingAsks).toBeInstanceOf(Map);
      expect(mgr.resumePromises).toBeInstanceOf(Map);
      expect(mgr.recoveryPromises).toBeInstanceOf(Map);
      expect(mgr.creates).toBeUndefined();
      expect(typeof mgr.busyWatchdogTimer).not.toBe("undefined");
    }
  });

  it("startBusyWatchdog 单例：已持有定时器时二次调用不重建", () => {
    const world = makeWorld();
    const oldMgr = makeOldManager(world);
    const newMgr = new AgentManager(world.deps);
    const oldBefore = oldMgr.busyWatchdogTimer;
    const newBefore = newMgr.busyWatchdogTimer;
    oldMgr.startBusyWatchdog();
    newMgr.startBusyWatchdog();
    expect(newMgr.busyWatchdogTimer).toBe(newBefore);
    expect(oldMgr.busyWatchdogTimer).toBe(oldBefore);
  });
});

describe("B6-6-4a busy 看门狗", () => {
  it("开关默认关：busy 永不过期放行，无告警", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const world = makeWorld({ flags: {} });
    const oldMgr = makeOldManager(world);
    const newMgr = new AgentManager(world.deps);
    for (const mgr of [oldMgr, newMgr]) mgr.sessions.set("c1", { busy: true, busyStartedAt: Date.now() - 999_999 });
    vi.advanceTimersByTime(60_000);
    expect(newMgr.sessions.get("c1").busy).toBe(true);
    expect(oldMgr.sessions.get("c1").busy).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("开关开启：超阈值无事件活动放行（busy=false + busyWatchdogClearedAt + 告警文案），新近活动不受影响", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // tick 固定 60s 间隔：阈值取 70s，fresh 在 tick 时空闲 60s 不放行，stale 空闲 80s 放行
    const world = makeWorld({ flags: { agentBusyWatchdog: true, agentBusyWatchdogMs: 70_000 } });
    const oldMgr = makeOldManager(world);
    const newMgr = new AgentManager(world.deps);
    const staleStartedAt = Date.now() - 20_000;
    for (const mgr of [oldMgr, newMgr]) {
      mgr.sessions.set("stale", { busy: true, busyStartedAt: staleStartedAt });
      mgr.sessions.set("fresh", { busy: true, busyStartedAt: Date.now(), lastPiEventAt: Date.now() });
    }
    vi.advanceTimersByTime(60_000);
    const newStale = newMgr.sessions.get("stale");
    const oldStale = oldMgr.sessions.get("stale");
    expect(newStale.busy).toBe(false);
    expect(newStale.busyWatchdogClearedAt).toBe(Date.now());
    expect(newStale).toEqual(oldStale);
    expect(newMgr.sessions.get("fresh").busy).toBe(true);
    expect(oldMgr.sessions.get("fresh").busy).toBe(true);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]![0]).toBe(warn.mock.calls[1]![0]);
    expect(String(warn.mock.calls[0]![0])).toContain("[agent] busy 看门狗放行：stale 已 80s 无事件活动");
  });
});

describe("B6-6-4a 会话状态快照与 ask_user 应答", () => {
  it("listSessionStates 快照形状双侧同流（busyForMs 冻结时钟下确定）", () => {
    const world = makeWorld();
    const oldMgr = makeOldManager(world);
    const newMgr = new AgentManager(world.deps);
    const seed = {
      clientId: "c1",
      threadId: "t1",
      workspace: "/ws/a",
      busy: true,
      compacting: false,
      queuedCount: 2,
      activeRunId: "run-1",
      lastPiEventAt: Date.now() - 100,
      busyStartedAt: Date.now() - 5000,
    };
    for (const mgr of [oldMgr, newMgr]) mgr.sessions.set("c1:t1", { ...seed });
    const newStates = newMgr.listSessionStates();
    const oldStates = oldMgr.listSessionStates();
    expect(newStates).toEqual(oldStates);
    expect(newStates[0]).toMatchObject({
      key: "c1:t1",
      clientId: "c1",
      threadId: "t1",
      workspace: "/ws/a",
      busy: true,
      compacting: false,
      queuedCount: 2,
      activeRunId: "run-1",
      busyForMs: 5000,
      busyWatchdogClearedAt: null,
    });
  });

  it("askPending 读取即清除；submitAnswer 取消路径回填系统话术", () => {
    const world = makeWorld();
    const oldMgr = makeOldManager(world);
    const newMgr = new AgentManager(world.deps);
    const received: string[] = [];
    for (const mgr of [oldMgr, newMgr]) {
      mgr.sessions.set("c1", { cancelRequested: true });
      mgr.pendingAsks.set("c1", (answer: string) => received.push(answer));
    }
    expect(newMgr.askPending("c1")).toBeTypeOf("function");
    expect(oldMgr.askPending("c1")).toBeTypeOf("function");
    expect(newMgr.pendingAsks.has("c1")).toBe(false);
    expect(oldMgr.pendingAsks.has("c1")).toBe(false);
    // 重新放置后走取消路径（askPending 已在上方验证读取即清除，此处 pendingAsks 各自持有）
    const oldLive = (answer: string) => received.push(`old:${answer}`);
    const newLive = (answer: string) => received.push(`new:${answer}`);
    oldMgr.pendingAsks.set("c1", oldLive);
    newMgr.pendingAsks.set("c1", newLive);
    const SYSTEM_TEXT = "[系统提醒] 本轮任务已被用户取消，请立即停止执行，不要再调用工具，直接在正文里说明本轮已取消。";
    expect(newMgr.submitAnswer("c1", "继续")).toEqual({ ok: true, mode: "cancelled", cancelled: true });
    expect(oldMgr.submitAnswer("c1", "继续")).toEqual({ ok: true, mode: "cancelled", cancelled: true });
    expect(received).toEqual([`new:${SYSTEM_TEXT}`, `old:${SYSTEM_TEXT}`]);
  });

  it("submitAnswer live 路径回传原文字；queued 路径走 resolvePendingAsk(\"queued\")；无待答返回 ok:false", () => {
    const world = makeWorld({ resolveAskResult: { id: "q1", status: "queued" } });
    const oldMgr = makeOldManager(world);
    const newMgr = new AgentManager(world.deps);
    const oldLive = vi.fn();
    const newLive = vi.fn();
    oldMgr.pendingAsks.set("c1", oldLive);
    newMgr.pendingAsks.set("c1", newLive);
    expect(newMgr.submitAnswer("c1", "好的")).toEqual({ ok: true, mode: "live" });
    expect(oldMgr.submitAnswer("c1", "好的")).toEqual({ ok: true, mode: "live" });
    expect(newLive).toHaveBeenCalledWith("好的");
    expect(oldLive).toHaveBeenCalledWith("好的");
    expect(world.calls.resolveAsk).toEqual([]);
    // live 均已消费，走 queued
    expect(newMgr.submitAnswer("c2", 42)).toEqual({ ok: true, mode: "queued", questionId: "q1" });
    expect(oldMgr.submitAnswer("c2", 42)).toEqual({ ok: true, mode: "queued", questionId: "q1" });
    expect(world.calls.resolveAsk).toEqual([
      ["c2", "42", "queued"],
      ["c2", "42", "queued"],
    ]);
    // 无待答且 resolve 落空
    world.calls.resolveAsk.length = 0;
    const miss = makeWorld({ resolveAskResult: null });
    const oldMiss = makeOldManager(miss);
    const newMiss = new AgentManager(miss.deps);
    expect(newMiss.submitAnswer("c3", "x")).toEqual({ ok: false });
    expect(oldMiss.submitAnswer("c3", "x")).toEqual({ ok: false });
  });

  it("isRunStopping 矩阵：无 entry/快速路径/兜底回读/抛错吞掉/5s 缓存窗口", () => {
    const world = makeWorld({
      runs: { "run-y": { status: "cancel_requested" }, "run-n": { status: "running" } },
    });
    const oldMgr = makeOldManager(world);
    const newMgr = new AgentManager(world.deps);
    const seed = (extra: Record<string, unknown> = {}) => ({ ...extra });
    for (const mgr of [oldMgr, newMgr]) {
      mgr.sessions.set("none", {});
      mgr.sessions.set("fast", seed({ cancelRequested: true, activeRunId: "run-y" }));
      mgr.sessions.set("stop", seed({ activeRunId: "run-y" }));
      mgr.sessions.set("cont", seed({ activeRunId: "run-n" }));
      mgr.sessions.set("norun", seed({ activeRunId: null }));
      mgr.sessions.set("boom", seed({ activeRunId: "run-boom" }));
    }
    expect(newMgr.isRunStopping("missing")).toBe(false);
    expect(oldMgr.isRunStopping("missing")).toBe(false);
    expect(newMgr.isRunStopping("fast")).toBe(true);
    expect(oldMgr.isRunStopping("fast")).toBe(true);
    expect(world.calls.getRun).toEqual([]); // 快速路径不回读
    expect(newMgr.isRunStopping("stop")).toBe(true);
    expect(oldMgr.isRunStopping("stop")).toBe(true);
    expect(newMgr.isRunStopping("cont")).toBe(false);
    expect(oldMgr.isRunStopping("cont")).toBe(false);
    expect(newMgr.isRunStopping("norun")).toBe(false);
    expect(oldMgr.isRunStopping("norun")).toBe(false);
    expect(newMgr.isRunStopping("boom")).toBe(false);
    expect(oldMgr.isRunStopping("boom")).toBe(false);
    // 兜底路径每 5 秒最多一次回读：同 key 第二次在 5s 窗口内走缓存
    const before = world.calls.getRun.length;
    expect(newMgr.isRunStopping("stop")).toBe(true);
    expect(oldMgr.isRunStopping("stop")).toBe(true);
    expect(world.calls.getRun.length).toBe(before);
    vi.advanceTimersByTime(5001);
    expect(newMgr.isRunStopping("stop")).toBe(true);
    expect(oldMgr.isRunStopping("stop")).toBe(true);
    expect(world.calls.getRun.length).toBe(before + 2);
  });
});

describe("B6-6-4a 记忆族与问答清单", () => {
  it("memoryProposals 透传并合并 threadKey；merge/history 透传", () => {
    const world = makeWorld({ memory: { list: [{ id: "m1" }], merge: { ok: 1 }, history: [{ id: "h1" }] } });
    const oldMgr = makeOldManager(world);
    const newMgr = new AgentManager(world.deps);
    expect(newMgr.memoryProposals("t1", { status: "pending" })).toEqual([{ id: "m1" }]);
    expect(oldMgr.memoryProposals("t1", { status: "pending" })).toEqual([{ id: "m1" }]);
    expect(world.calls.listMem).toEqual([{ status: "pending", threadKey: "t1" }, { status: "pending", threadKey: "t1" }]);
    expect(newMgr.memoryProposals()).toEqual([{ id: "m1" }]);
    expect(world.calls.listMem[2]).toEqual({ threadKey: "" });
    expect(newMgr.mergeMemoryProposals("a", ["b", "c"])).toEqual({ ok: 1 });
    expect(oldMgr.mergeMemoryProposals("a", ["b", "c"])).toEqual({ ok: 1 });
    expect(world.calls.mergeMem).toEqual([["a", ["b", "c"]], ["a", ["b", "c"]]]);
    expect(newMgr.memoryProposalHistory("h1")).toEqual([{ id: "h1" }]);
    expect(oldMgr.memoryProposalHistory("h1")).toEqual([{ id: "h1" }]);
  });

  it("approve/edit/reject 投递事件到对应 threadKey 会话（信封双侧同流），未命中会话不投递", () => {
    const world = makeWorld({
      memory: {
        approve: { proposal: { id: "p1", threadKey: "t1" } },
        edit: { proposal: { id: "p1", threadKey: "t1" } },
        reject: { proposal: { id: "p1", threadKey: "missing" } },
      },
    });
    const oldMgr = makeOldManager(world);
    const newMgr = new AgentManager(world.deps);
    const oldT1 = makeChannelEntry();
    const newT1 = makeChannelEntry();
    oldMgr.sessions.set("t1", oldT1.entry);
    newMgr.sessions.set("t1", newT1.entry);
    const newApproved = newMgr.approveMemoryProposal("p1", { note: "ok" });
    const oldApproved = oldMgr.approveMemoryProposal("p1", { note: "ok" });
    expect(newApproved).toEqual(oldApproved);
    expect(world.calls.approveMem).toEqual([["p1", { note: "ok" }], ["p1", { note: "ok" }]]);
    expect(newT1.emitted.map((ev: any) => ({ type: ev.type, data: ev.data }))).toEqual([
      { type: "memory_proposal_resolved", data: { proposal: { id: "p1", threadKey: "t1" }, runId: null } },
    ]);
    expect(newT1.emitted).toEqual(oldT1.emitted);
    const newEdited = newMgr.editMemoryProposal("p1", { text: "x" });
    const oldEdited = oldMgr.editMemoryProposal("p1", { text: "x" });
    expect(newEdited).toEqual(oldEdited);
    expect(newT1.emitted[1].type).toBe("memory_proposal_updated");
    expect(newT1.emitted[1]).toEqual(oldT1.emitted[1]);
    // reject 命中未注册会话 → 无投递；缺省 reason 兜底文案
    const newRejected = newMgr.rejectMemoryProposal("p1");
    const oldRejected = oldMgr.rejectMemoryProposal("p1");
    expect(newRejected).toEqual(oldRejected);
    expect(world.calls.rejectMem).toEqual([["p1", "用户拒绝该记忆建议"], ["p1", "用户拒绝该记忆建议"]]);
    expect(newT1.emitted).toHaveLength(2);
    expect(oldT1.emitted).toHaveLength(2);
  });

  it("记忆事件经 emitDeps 持久化（activeRunId 绑定 run 时 recordRunEvent 同流）", () => {
    const world = makeWorld({ memory: { approve: { proposal: { id: "p1", threadKey: "t1" } } } });
    const oldMgr = makeOldManager(world);
    const newMgr = new AgentManager(world.deps);
    const oldT1 = makeChannelEntry({ activeRunId: "run-9" });
    const newT1 = makeChannelEntry({ activeRunId: "run-9" });
    oldMgr.sessions.set("t1", oldT1.entry);
    newMgr.sessions.set("t1", newT1.entry);
    newMgr.approveMemoryProposal("p1");
    oldMgr.approveMemoryProposal("p1");
    expect(world.calls.recordRunEvent).toEqual([
      ["run-9", "memory_proposal_resolved", { proposal: { id: "p1", threadKey: "t1" } }],
      ["run-9", "memory_proposal_resolved", { proposal: { id: "p1", threadKey: "t1" } }],
    ]);
    expect(newT1.emitted).toEqual(oldT1.emitted);
  });

  it("pendingQuestions 按 clientId 过滤（空 clientId 返回全部）", () => {
    const asks = [
      { clientId: "c1", question: "a" },
      { clientId: "c2", question: "b" },
    ];
    const world = makeWorld({ asks });
    const oldMgr = makeOldManager(world);
    const newMgr = new AgentManager(world.deps);
    expect(newMgr.pendingQuestions("c1")).toEqual([{ clientId: "c1", question: "a" }]);
    expect(oldMgr.pendingQuestions("c1")).toEqual([{ clientId: "c1", question: "a" }]);
    expect(newMgr.pendingQuestions()).toEqual(asks);
    expect(oldMgr.pendingQuestions()).toEqual(asks);
    expect(world.calls.readAsks).toBe(4);
  });

  it("modelRuntime 透传 piRuntimeManager.modelRuntime()（async）", async () => {
    const marker = { runtime: true };
    const world = makeWorld({ modelRuntime: marker });
    const oldMgr = makeOldManager(world);
    const newMgr = new AgentManager(world.deps);
    expect(await newMgr.modelRuntime()).toBe(marker);
    expect(await oldMgr.modelRuntime()).toBe(marker);
    expect(world.calls.modelRuntime).toBe(2);
  });
});

describe("B6-6-4a getOrCreate 工作区归属校验与单飞", () => {
  const norm = (dir: unknown) => (dir === undefined || dir === null || dir === "" ? null : `norm:${String(dir)}`);

  it("已存在且工作区一致 / 无 requested / entry 无 workspace：直接复用不 dispose", async () => {
    const world = makeWorld({ normalize: norm });
    const oldMgr = makeOldManager(world);
    const newMgr = new AgentManager(world.deps);
    for (const mgr of [oldMgr, newMgr]) {
      mgr.sessions.set("c1", { workspace: "norm:/ws/a", busy: false, runtimeId: "rt1", session: { s: 1 } });
      mgr.sessions.set("c2", { workspace: "norm:/ws/a" });
      mgr.sessions.set("c3", { workspace: null });
    }
    const e1 = newMgr.sessions.get("c1");
    expect(await newMgr.getOrCreate("c1", { cwd: "/ws/a" })).toBe(e1);
    expect(await oldMgr.getOrCreate("c1", { cwd: "/ws/a" })).toBe(oldMgr.sessions.get("c1"));
    expect(await newMgr.getOrCreate("c2", {})).toBe(newMgr.sessions.get("c2"));
    expect(await oldMgr.getOrCreate("c2", {})).toBe(oldMgr.sessions.get("c2"));
    expect(await newMgr.getOrCreate("c3", { cwd: "/ws/other" })).toBe(newMgr.sessions.get("c3"));
    expect(await oldMgr.getOrCreate("c3", { cwd: "/ws/other" })).toBe(oldMgr.sessions.get("c3"));
    expect(world.calls.dispose).toEqual([]);
    expect(newMgr.creates).toBeUndefined();
    expect(oldMgr.creates).toBeUndefined();
  });

  it("工作区不一致且占用中（busy/compacting/queued）：抛 WORKSPACE_BUSY，不 dispose 不删除", async () => {
    for (const 占用 of [{ busy: true }, { compacting: true }, { queuedCount: 3 }]) {
      const world = makeWorld({ normalize: norm });
      const oldMgr = makeOldManager(world);
      const newMgr = new AgentManager(world.deps);
      for (const mgr of [oldMgr, newMgr]) mgr.sessions.set("c1", { workspace: "norm:/ws/a", runtimeId: "rt1", session: { s: 1 }, ...占用 });
      const newErr = await newMgr.getOrCreate("c1", { cwd: "/ws/b" }).catch((e: any) => e);
      const oldErr = await oldMgr.getOrCreate("c1", { cwd: "/ws/b" }).catch((e: any) => e);
      expect(newErr.code).toBe("WORKSPACE_BUSY");
      expect(oldErr.code).toBe("WORKSPACE_BUSY");
      expect(newErr.message).toBe(oldErr.message);
      expect(newErr.message).toBe("当前会话正在其他工作区的任务中执行，请等待完成或先取消任务");
      expect(world.calls.dispose).toEqual([]);
      expect(newMgr.sessions.has("c1")).toBe(true);
      expect(oldMgr.sessions.has("c1")).toBe(true);
    }
  });

  it("工作区不一致且空闲：dispose(runtimeId, session) → 删除旧 entry → _create 重建并返回", async () => {
    const world = makeWorld({ normalize: norm });
    const oldMgr = makeOldManager(world);
    const newMgr = new AgentManager(world.deps);
    const createCalls: any[][] = [];
    const built = { workspace: "norm:/ws/b", fresh: true };
    stubCreate(oldMgr, createCalls, async () => built);
    stubCreate(newMgr, createCalls, async () => built);
    for (const mgr of [oldMgr, newMgr]) mgr.sessions.set("c1", { workspace: "norm:/ws/a", runtimeId: "rt1", session: { s: 1 } });
    const newEntry = await newMgr.getOrCreate("c1", { cwd: "/ws/b" });
    const oldEntry = await oldMgr.getOrCreate("c1", { cwd: "/ws/b" });
    expect(newEntry).toBe(built);
    expect(oldEntry).toBe(built);
    expect(createCalls).toEqual([["c1", { cwd: "/ws/b" }], ["c1", { cwd: "/ws/b" }]]);
    expect(world.calls.dispose).toEqual([["rt1", { s: 1 }], ["rt1", { s: 1 }]]);
    // stub _create 未回填 sessions（与旧 JS 一致，sessions.set 发生在真实 _create 内）
    expect(newMgr.sessions.has("c1")).toBe(false);
    expect(oldMgr.sessions.has("c1")).toBe(false);
    expect(newMgr.creates!.size).toBe(0);
    expect(oldMgr.creates.size).toBe(0);
  });

  it("dispose 抛错被吞掉，仍继续重建", async () => {
    const world = makeWorld({ normalize: norm });
    world.deps.piRuntimeManager.dispose = () => { throw new Error("dispose boom"); };
    const oldMgr = makeOldManager(world);
    const newMgr = new AgentManager(world.deps);
    const built = { fresh: true };
    const createCalls: any[][] = [];
    stubCreate(oldMgr, createCalls, async () => built);
    stubCreate(newMgr, createCalls, async () => built);
    for (const mgr of [oldMgr, newMgr]) mgr.sessions.set("c1", { workspace: "norm:/ws/a", runtimeId: "rt1", session: { s: 1 } });
    expect(await newMgr.getOrCreate("c1", { cwd: "/ws/b" })).toBe(built);
    expect(await oldMgr.getOrCreate("c1", { cwd: "/ws/b" })).toBe(built);
    expect(createCalls).toHaveLength(2);
  });

  it("单飞：并发 getOrCreate 共享同一 Promise，收尾清锁，后续调用重走 _create", async () => {
    const world = makeWorld({ normalize: norm });
    const oldMgr = makeOldManager(world);
    const newMgr = new AgentManager(world.deps);
    const createCalls: any[][] = [];
    let release!: (v: any) => void;
    const gate = new Promise((resolve) => { release = resolve; });
    const built = { created: true };
    stubCreate(oldMgr, createCalls, async () => gate.then(() => built));
    stubCreate(newMgr, createCalls, async () => gate.then(() => built));
    const newP1 = newMgr.getOrCreate("c1", { cwd: "/ws/b" });
    const newP2 = newMgr.getOrCreate("c1", { cwd: "/ws/b" });
    const oldP1 = oldMgr.getOrCreate("c1", { cwd: "/ws/b" });
    const oldP2 = oldMgr.getOrCreate("c1", { cwd: "/ws/b" });
    // 单飞语义：第二次调用直接返回锁内 Promise 的解析值（async 外层每次新 Promise，验证锁持有与调用次数）
    expect(newMgr.creates!.get("c1")).toBeInstanceOf(Promise);
    expect(oldMgr.creates.get("c1")).toBeInstanceOf(Promise);
    expect(createCalls).toHaveLength(2); // 两侧各一次
    release(built);
    expect(await newP1).toBe(built);
    expect(await newP2).toBe(built);
    expect(await oldP1).toBe(built);
    expect(await oldP2).toBe(built);
    expect(newMgr.creates!.size).toBe(0);
    expect(oldMgr.creates.size).toBe(0);
    // 锁已清：再次调用重走 _create
    stubCreate(newMgr, createCalls, async () => ({ second: true }));
    stubCreate(oldMgr, createCalls, async () => ({ second: true }));
    expect(await newMgr.getOrCreate("c1", { cwd: "/ws/b" })).toEqual({ second: true });
    expect(await oldMgr.getOrCreate("c1", { cwd: "/ws/b" })).toEqual({ second: true });
    expect(createCalls).toHaveLength(4);
  });

  it("_create 拒绝时 finally 清锁，后续调用可重试", async () => {
    const world = makeWorld({ normalize: norm });
    const oldMgr = makeOldManager(world);
    const newMgr = new AgentManager(world.deps);
    const createCalls: any[][] = [];
    stubCreate(oldMgr, createCalls, async () => { throw new Error("create boom"); });
    stubCreate(newMgr, createCalls, async () => { throw new Error("create boom"); });
    await expect(newMgr.getOrCreate("c1", { cwd: "/ws/b" })).rejects.toThrow("create boom");
    await expect(oldMgr.getOrCreate("c1", { cwd: "/ws/b" })).rejects.toThrow("create boom");
    expect(newMgr.creates!.size).toBe(0);
    expect(oldMgr.creates.size).toBe(0);
    stubCreate(newMgr, createCalls, async () => ({ retry: true }));
    stubCreate(oldMgr, createCalls, async () => ({ retry: true }));
    expect(await newMgr.getOrCreate("c1", { cwd: "/ws/b" })).toEqual({ retry: true });
    expect(await oldMgr.getOrCreate("c1", { cwd: "/ws/b" })).toEqual({ retry: true });
  });
});
