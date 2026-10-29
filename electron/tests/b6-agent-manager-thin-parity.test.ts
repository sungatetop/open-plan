/**
 * B6-6-4a 单侧行为覆盖：AgentManager 类体薄方法批。
 *
 * R6-6b 对拍退役改写：旧 server/agent.mjs 对拍机制（行号提取 + new Function 求值）移除，
 * 保留 TS 侧行为断言。
 *
 * 覆盖：constructor 状态字段 / startBusyWatchdog 看门狗 / listSessionStates / askPending /
 * submitAnswer 三路径 / isRunStopping 快慢路径与 5s 缓存 / memory 族透传与事件投递 /
 * pendingQuestions / modelRuntime / getOrCreate 工作区归属校验与单飞。
 *
 * piRuntimeManager（pi 域未迁）、getRun（runs 域未迁）、memory-management 六函数（未迁）
 * 经 AgentManagerDeps 注入 stub。_create 未迁（4i 批接管），实例覆写注入。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { AgentManager, type AgentFlags, type AgentManagerDeps } from "../src/main/backend/agent/agent-manager";

/** 通道 entry mock（emitChannelSafe 信封落点）。 */
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

/** 依赖世界：stub 全部 seam，记录调用序列。 */
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
    // B6-6-4b/4c 扩员的 seam 方法：thin 批场景不触达，no-op 满足 AgentPiRuntimeSeam 类型
    getSessionTree: () => null,
    navigateSessionTree: async () => ({}),
    abort: async () => {},
    compact: async () => ({}),
    health: () => null,
    markRecovery: () => {},
    listSnapshots: () => [],
    schedulerSnapshot: () => ({}),
    setModel: async () => {},
    probeModel: async () => ({}),
    resetModelRuntime: () => {},
    disposeAll: async () => {},
    // B6-6-4d 扩员的 seam 方法：本批场景不触达，no-op 满足 AgentPiRuntimeSeam 类型
    getContextUsage: () => null,
    // B6-6-4e 扩员的 seam 方法：thin 批场景不触达，no-op 满足 AgentPiRuntimeSeam 类型
    prompt: () => {},
    runPrompt: async (_runtimeId: unknown, operation: () => Promise<any>) => operation(),
    setActiveTools: () => {},
    update: () => {},
    setThinkingLevel: () => {},
    // B6-6-4i 扩员的 seam 方法：thin 批场景不触达，no-op 满足 AgentPiRuntimeSeam 类型
    beginRuntime: (args: any) => ({ runtimeId: "rt_thin", ...args }),
    markFailure: () => {},
    createSession: async () => ({}),
    bindSession: () => {},
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
    // B6-6-4d 必填 deps：本批场景不触达，恒 null stub
    contextTokensFromUsage: () => null,
    emitDeps,
  };
  return { deps, calls, emitDeps, normalize };
}

/** _create 实例覆写（4i 未收口，行为注入）。 */
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
  it("构造状态字段与 EventEmitter 继承；creates 按需惰性创建", () => {
    const world = makeWorld();
    const mgr = new AgentManager(world.deps);
    expect(mgr).toBeInstanceOf(EventEmitter);
    expect(mgr.sessions).toBeInstanceOf(Map);
    expect(mgr.sessions.size).toBe(0);
    expect(mgr.pendingAsks).toBeInstanceOf(Map);
    expect(mgr.resumePromises).toBeInstanceOf(Map);
    expect(mgr.recoveryPromises).toBeInstanceOf(Map);
    expect(mgr.creates).toBeUndefined();
    expect(typeof mgr.busyWatchdogTimer).not.toBe("undefined");
  });

  it("startBusyWatchdog 单例：已持有定时器时二次调用不重建", () => {
    const world = makeWorld();
    const mgr = new AgentManager(world.deps);
    const before = mgr.busyWatchdogTimer;
    mgr.startBusyWatchdog();
    expect(mgr.busyWatchdogTimer).toBe(before);
  });
});

describe("B6-6-4a busy 看门狗", () => {
  it("开关默认关：busy 永不过期放行，无告警", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const world = makeWorld({ flags: {} });
    const mgr = new AgentManager(world.deps);
    mgr.sessions.set("c1", { busy: true, busyStartedAt: Date.now() - 999_999 });
    vi.advanceTimersByTime(60_000);
    expect(mgr.sessions.get("c1").busy).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("开关开启：超阈值无事件活动放行（busy=false + busyWatchdogClearedAt + 告警文案），新近活动不受影响", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // tick 固定 60s 间隔：阈值取 70s，fresh 在 tick 时空闲 60s 不放行，stale 空闲 80s 放行
    const world = makeWorld({ flags: { agentBusyWatchdog: true, agentBusyWatchdogMs: 70_000 } });
    const mgr = new AgentManager(world.deps);
    const staleStartedAt = Date.now() - 20_000;
    mgr.sessions.set("stale", { busy: true, busyStartedAt: staleStartedAt });
    mgr.sessions.set("fresh", { busy: true, busyStartedAt: Date.now(), lastPiEventAt: Date.now() });
    vi.advanceTimersByTime(60_000);
    const stale = mgr.sessions.get("stale");
    expect(stale.busy).toBe(false);
    expect(stale.busyWatchdogClearedAt).toBe(Date.now());
    expect(mgr.sessions.get("fresh").busy).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("[agent] busy 看门狗放行：stale 已 80s 无事件活动");
  });
});

describe("B6-6-4a 会话状态快照与 ask_user 应答", () => {
  it("listSessionStates 快照形状（busyForMs 冻结时钟下确定）", () => {
    const world = makeWorld();
    const mgr = new AgentManager(world.deps);
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
    mgr.sessions.set("c1:t1", { ...seed });
    const states = mgr.listSessionStates();
    expect(states[0]).toMatchObject({
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
    const mgr = new AgentManager(world.deps);
    const received: string[] = [];
    mgr.sessions.set("c1", { cancelRequested: true });
    mgr.pendingAsks.set("c1", (answer: string) => received.push(answer));
    expect(mgr.askPending("c1")).toBeTypeOf("function");
    expect(mgr.pendingAsks.has("c1")).toBe(false);
    // 重新放置后走取消路径（askPending 已在上方验证读取即清除，此处 pendingAsks 重新持有）
    const live = (answer: string) => received.push(answer);
    mgr.pendingAsks.set("c1", live);
    const SYSTEM_TEXT = "[系统提醒] 本轮任务已被用户取消，请立即停止执行，不要再调用工具，直接在正文里说明本轮已取消。";
    expect(mgr.submitAnswer("c1", "继续")).toEqual({ ok: true, mode: "cancelled", cancelled: true });
    expect(received).toEqual([SYSTEM_TEXT]);
  });

  it("submitAnswer live 路径回传原文字；queued 路径走 resolvePendingAsk(\"queued\")；无待答返回 ok:false", () => {
    const world = makeWorld({ resolveAskResult: { id: "q1", status: "queued" } });
    const mgr = new AgentManager(world.deps);
    const live = vi.fn();
    mgr.pendingAsks.set("c1", live);
    expect(mgr.submitAnswer("c1", "好的")).toEqual({ ok: true, mode: "live" });
    expect(live).toHaveBeenCalledWith("好的");
    expect(world.calls.resolveAsk).toEqual([]);
    // live 已消费，走 queued
    expect(mgr.submitAnswer("c2", 42)).toEqual({ ok: true, mode: "queued", questionId: "q1" });
    expect(world.calls.resolveAsk).toEqual([["c2", "42", "queued"]]);
    // 无待答且 resolve 落空
    world.calls.resolveAsk.length = 0;
    const miss = makeWorld({ resolveAskResult: null });
    const missMgr = new AgentManager(miss.deps);
    expect(missMgr.submitAnswer("c3", "x")).toEqual({ ok: false });
  });

  it("isRunStopping 矩阵：无 entry/快速路径/兜底回读/抛错吞掉/5s 缓存窗口", () => {
    const world = makeWorld({
      runs: { "run-y": { status: "cancel_requested" }, "run-n": { status: "running" } },
    });
    const mgr = new AgentManager(world.deps);
    const seed = (extra: Record<string, unknown> = {}) => ({ ...extra });
    mgr.sessions.set("none", {});
    mgr.sessions.set("fast", seed({ cancelRequested: true, activeRunId: "run-y" }));
    mgr.sessions.set("stop", seed({ activeRunId: "run-y" }));
    mgr.sessions.set("cont", seed({ activeRunId: "run-n" }));
    mgr.sessions.set("norun", seed({ activeRunId: null }));
    mgr.sessions.set("boom", seed({ activeRunId: "run-boom" }));
    expect(mgr.isRunStopping("missing")).toBe(false);
    expect(mgr.isRunStopping("fast")).toBe(true);
    expect(world.calls.getRun).toEqual([]); // 快速路径不回读
    expect(mgr.isRunStopping("stop")).toBe(true);
    expect(mgr.isRunStopping("cont")).toBe(false);
    expect(mgr.isRunStopping("norun")).toBe(false);
    expect(mgr.isRunStopping("boom")).toBe(false);
    // 兜底路径每 5 秒最多一次回读：同 key 第二次在 5s 窗口内走缓存
    const before = world.calls.getRun.length;
    expect(mgr.isRunStopping("stop")).toBe(true);
    expect(world.calls.getRun.length).toBe(before);
    vi.advanceTimersByTime(5001);
    expect(mgr.isRunStopping("stop")).toBe(true);
    expect(world.calls.getRun.length).toBe(before + 1);
  });
});

describe("B6-6-4a 记忆族与问答清单", () => {
  it("memoryProposals 透传并合并 threadKey；merge/history 透传", () => {
    const world = makeWorld({ memory: { list: [{ id: "m1" }], merge: { ok: 1 }, history: [{ id: "h1" }] } });
    const mgr = new AgentManager(world.deps);
    expect(mgr.memoryProposals("t1", { status: "pending" })).toEqual([{ id: "m1" }]);
    expect(world.calls.listMem).toEqual([{ status: "pending", threadKey: "t1" }]);
    expect(mgr.memoryProposals()).toEqual([{ id: "m1" }]);
    expect(world.calls.listMem[1]).toEqual({ threadKey: "" });
    expect(mgr.mergeMemoryProposals("a", ["b", "c"])).toEqual({ ok: 1 });
    expect(world.calls.mergeMem).toEqual([["a", ["b", "c"]]]);
    expect(mgr.memoryProposalHistory("h1")).toEqual([{ id: "h1" }]);
  });

  it("approve/edit/reject 投递事件到对应 threadKey 会话，未命中会话不投递", () => {
    const world = makeWorld({
      memory: {
        approve: { proposal: { id: "p1", threadKey: "t1" } },
        edit: { proposal: { id: "p1", threadKey: "t1" } },
        reject: { proposal: { id: "p1", threadKey: "missing" } },
      },
    });
    const mgr = new AgentManager(world.deps);
    const t1 = makeChannelEntry();
    mgr.sessions.set("t1", t1.entry);
    const approved = mgr.approveMemoryProposal("p1", { note: "ok" });
    expect(approved).toEqual({ proposal: { id: "p1", threadKey: "t1" } });
    expect(world.calls.approveMem).toEqual([["p1", { note: "ok" }]]);
    expect(t1.emitted.map((ev: any) => ({ type: ev.type, data: ev.data }))).toEqual([
      { type: "memory_proposal_resolved", data: { proposal: { id: "p1", threadKey: "t1" }, runId: null } },
    ]);
    const edited = mgr.editMemoryProposal("p1", { text: "x" });
    expect(edited).toEqual({ proposal: { id: "p1", threadKey: "t1" } });
    expect(t1.emitted[1].type).toBe("memory_proposal_updated");
    // reject 命中未注册会话 → 无投递；缺省 reason 兜底文案
    const rejected = mgr.rejectMemoryProposal("p1");
    expect(rejected).toEqual({ proposal: { id: "p1", threadKey: "missing" } });
    expect(world.calls.rejectMem).toEqual([["p1", "用户拒绝该记忆建议"]]);
    expect(t1.emitted).toHaveLength(2);
  });

  it("记忆事件经 emitDeps 持久化（activeRunId 绑定 run 时 recordRunEvent 同流）", () => {
    const world = makeWorld({ memory: { approve: { proposal: { id: "p1", threadKey: "t1" } } } });
    const mgr = new AgentManager(world.deps);
    const t1 = makeChannelEntry({ activeRunId: "run-9" });
    mgr.sessions.set("t1", t1.entry);
    mgr.approveMemoryProposal("p1");
    expect(world.calls.recordRunEvent).toEqual([
      ["run-9", "memory_proposal_resolved", { proposal: { id: "p1", threadKey: "t1" } }],
    ]);
    expect(t1.emitted[0].type).toBe("memory_proposal_resolved");
  });

  it("pendingQuestions 按 clientId 过滤（空 clientId 返回全部）", () => {
    const asks = [
      { clientId: "c1", question: "a" },
      { clientId: "c2", question: "b" },
    ];
    const world = makeWorld({ asks });
    const mgr = new AgentManager(world.deps);
    expect(mgr.pendingQuestions("c1")).toEqual([{ clientId: "c1", question: "a" }]);
    expect(mgr.pendingQuestions()).toEqual(asks);
    expect(world.calls.readAsks).toBe(2);
  });

  it("modelRuntime 透传 piRuntimeManager.modelRuntime()（async）", async () => {
    const marker = { runtime: true };
    const world = makeWorld({ modelRuntime: marker });
    const mgr = new AgentManager(world.deps);
    expect(await mgr.modelRuntime()).toBe(marker);
    expect(world.calls.modelRuntime).toBe(1);
  });
});

describe("B6-6-4a getOrCreate 工作区归属校验与单飞", () => {
  const norm = (dir: unknown) => (dir === undefined || dir === null || dir === "" ? null : `norm:${String(dir)}`);

  it("已存在且工作区一致 / 无 requested / entry 无 workspace：直接复用不 dispose", async () => {
    const world = makeWorld({ normalize: norm });
    const mgr = new AgentManager(world.deps);
    mgr.sessions.set("c1", { workspace: "norm:/ws/a", busy: false, runtimeId: "rt1", session: { s: 1 } });
    mgr.sessions.set("c2", { workspace: "norm:/ws/a" });
    mgr.sessions.set("c3", { workspace: null });
    const e1 = mgr.sessions.get("c1");
    expect(await mgr.getOrCreate("c1", { cwd: "/ws/a" })).toBe(e1);
    expect(await mgr.getOrCreate("c2", {})).toBe(mgr.sessions.get("c2"));
    expect(await mgr.getOrCreate("c3", { cwd: "/ws/other" })).toBe(mgr.sessions.get("c3"));
    expect(world.calls.dispose).toEqual([]);
    expect(mgr.creates).toBeUndefined();
  });

  it("工作区不一致且占用中（busy/compacting/queued）：抛 WORKSPACE_BUSY，不 dispose 不删除", async () => {
    for (const 占用 of [{ busy: true }, { compacting: true }, { queuedCount: 3 }]) {
      const world = makeWorld({ normalize: norm });
      const mgr = new AgentManager(world.deps);
      mgr.sessions.set("c1", { workspace: "norm:/ws/a", runtimeId: "rt1", session: { s: 1 }, ...占用 });
      const err = await mgr.getOrCreate("c1", { cwd: "/ws/b" }).catch((e: any) => e);
      expect(err.code).toBe("WORKSPACE_BUSY");
      expect(err.message).toBe("当前会话正在其他工作区的任务中执行，请等待完成或先取消任务");
      expect(world.calls.dispose).toEqual([]);
      expect(mgr.sessions.has("c1")).toBe(true);
    }
  });

  it("工作区不一致且空闲：dispose(runtimeId, session) → 删除旧 entry → _create 重建并返回", async () => {
    const world = makeWorld({ normalize: norm });
    const mgr = new AgentManager(world.deps);
    const createCalls: any[][] = [];
    const built = { workspace: "norm:/ws/b", fresh: true };
    stubCreate(mgr, createCalls, async () => built);
    mgr.sessions.set("c1", { workspace: "norm:/ws/a", runtimeId: "rt1", session: { s: 1 } });
    const entry = await mgr.getOrCreate("c1", { cwd: "/ws/b" });
    expect(entry).toBe(built);
    expect(createCalls).toEqual([["c1", { cwd: "/ws/b" }]]);
    expect(world.calls.dispose).toEqual([["rt1", { s: 1 }]]);
    // stub _create 未回填 sessions（与旧 JS 一致，sessions.set 发生在真实 _create 内）
    expect(mgr.sessions.has("c1")).toBe(false);
    expect(mgr.creates!.size).toBe(0);
  });

  it("dispose 抛错被吞掉，仍继续重建", async () => {
    const world = makeWorld({ normalize: norm });
    world.deps.piRuntimeManager.dispose = () => { throw new Error("dispose boom"); };
    const mgr = new AgentManager(world.deps);
    const built = { fresh: true };
    const createCalls: any[][] = [];
    stubCreate(mgr, createCalls, async () => built);
    mgr.sessions.set("c1", { workspace: "norm:/ws/a", runtimeId: "rt1", session: { s: 1 } });
    expect(await mgr.getOrCreate("c1", { cwd: "/ws/b" })).toBe(built);
    expect(createCalls).toHaveLength(1);
  });

  it("单飞：并发 getOrCreate 共享同一 Promise，收尾清锁，后续调用重走 _create", async () => {
    const world = makeWorld({ normalize: norm });
    const mgr = new AgentManager(world.deps);
    const createCalls: any[][] = [];
    let release!: (v: any) => void;
    const gate = new Promise((resolve) => { release = resolve; });
    const built = { created: true };
    stubCreate(mgr, createCalls, async () => gate.then(() => built));
    const p1 = mgr.getOrCreate("c1", { cwd: "/ws/b" });
    const p2 = mgr.getOrCreate("c1", { cwd: "/ws/b" });
    // 单飞语义：第二次调用直接返回锁内 Promise 的解析值（async 外层每次新 Promise，验证锁持有与调用次数）
    expect(mgr.creates!.get("c1")).toBeInstanceOf(Promise);
    expect(createCalls).toHaveLength(1);
    release(built);
    expect(await p1).toBe(built);
    expect(await p2).toBe(built);
    expect(mgr.creates!.size).toBe(0);
    // 锁已清：再次调用重走 _create
    stubCreate(mgr, createCalls, async () => ({ second: true }));
    expect(await mgr.getOrCreate("c1", { cwd: "/ws/b" })).toEqual({ second: true });
    expect(createCalls).toHaveLength(2);
  });

  it("_create 拒绝时 finally 清锁，后续调用可重试", async () => {
    const world = makeWorld({ normalize: norm });
    const mgr = new AgentManager(world.deps);
    const createCalls: any[][] = [];
    stubCreate(mgr, createCalls, async () => { throw new Error("create boom"); });
    await expect(mgr.getOrCreate("c1", { cwd: "/ws/b" })).rejects.toThrow("create boom");
    expect(mgr.creates!.size).toBe(0);
    stubCreate(mgr, createCalls, async () => ({ retry: true }));
    expect(await mgr.getOrCreate("c1", { cwd: "/ws/b" })).toEqual({ retry: true });
  });
});
