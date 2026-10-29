/**
 * B6-6-4b 行为覆盖：AgentManager 会话生命周期批（server/agent.mjs 四段类体的 TS 转录）。
 *
 * 覆盖：prompt / promptWithContext（健康/failed 恢复/无 entry）/ sessionTree / branchSession /
 * ensureRuntime（复用/工作区替换/恢复链/单飞/stale code）/ abort（正常/异常/abort-like/
 * runId 兜底）/ resolveLiveEntry / compact / newThread / resumeThread（单飞 + _sessionBusyError
 * 现状缺陷固化）/ setCurrentFile / runtimeSnapshot / runtimeHealth / restartRuntime / listRuntimes。
 *
 * R6-6b 对拍退役改写：旧侧行号提取类体（L843-1018 等五段 + new Function 求值）随
 * server/agent.mjs 退役删除，仅保留 TS AgentManager 单侧行为断言。
 * _create/_enqueuePrompt/writeContextFile 为领域内私有方法，实例覆写注入；
 * usageSnapshot 依赖 4d 解析器，随 4d 批覆盖。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager, type AgentManagerDeps } from "../src/main/backend/agent/agent-manager";

/** 通道 entry mock（emitter 落点捕获 abort/agent_error 信封事件）。 */
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

/** 会话 entry 种子（可覆写）。 */
function makeSession(overrides: Record<string, unknown> = {}): any {
  return {
    runtimeId: "rt1",
    session: { sessionId: "s-1", sessionFile: "/store/s-1.jsonl", isIdle: () => true, model: { provider: "prov-x", id: "mdl-1" } },
    sessionManager: { sm: 1 },
    workspace: "norm:/ws/a",
    threadId: "t1",
    ...overrides,
  };
}

/** 依赖世界：stub 全部 seam，记录调用序列。 */
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
    // B6-6-4c/4d 扩员的 seam 方法：lifecycle 批场景不触达，no-op 满足 AgentPiRuntimeSeam 类型
    setModel: async () => {},
    probeModel: async () => ({}),
    resetModelRuntime: () => {},
    disposeAll: async () => {},
    getContextUsage: () => null,
    // B6-6-4e 扩员的 seam 方法：lifecycle 批场景不触达，no-op 满足 AgentPiRuntimeSeam 类型
    prompt: () => {},
    runPrompt: async (_runtimeId: unknown, operation: () => Promise<any>) => operation(),
    setActiveTools: () => {},
    update: () => {},
    setThinkingLevel: () => {},
  };
  const configuredModelSpec = () => { calls.configuredModel += 1; return opts.configuredModel ?? "cfg/model-a"; };
  const findSessionFileForAgent = (sessionId: unknown) => { calls.findSessionFile.push(sessionId); return "sessionFileFound" in opts ? opts.sessionFileFound : { fullPath: "/store/s-1.jsonl" }; };
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
    // B6-6-4d 必填 deps：本批场景不触达，恒 null stub
    contextTokensFromUsage: () => null,
    emitDeps,
  };
  return { deps, calls };
}

/** 实例覆写未迁移方法（_create 回填 sessions 模拟真实 _create 行为）。 */
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
    const mgr = new AgentManager(world.deps);
    const calls = { _create: [] as any[][], _enqueue: [] as any[][], _writeCtx: [] as any[][] };
    stubUnmigrated(mgr, calls, makeSession());
    mgr.sessions.set("c1", makeSession());
    const res = await mgr.prompt("c1", "你好", ["img1"], "high");
    expect(res).toEqual({ enqueued: true, entry: mgr.sessions.get("c1"), payload: { text: "你好", images: ["img1"], effort: "high", references: [], runContext: null } });
    expect(calls._enqueue).toHaveLength(1);
    expect(calls._create).toEqual([]);
  });

  it("promptWithContext 健康：直接以当前 entry 入队（含 references/runContext 原样）", async () => {
    const world = makeWorld({ healthOuts: [{ status: "ok" }] });
    const mgr = new AgentManager(world.deps);
    const calls = { _create: [] as any[][], _enqueue: [] as any[][], _writeCtx: [] as any[][] };
    stubUnmigrated(mgr, calls, makeSession());
    mgr.sessions.set("c1", makeSession());
    const res = mgr.promptWithContext("c1", "hi", [], "low", ["ref1"], { run: 1 });
    expect(calls._enqueue).toEqual([
      [mgr.sessions.get("c1"), { text: "hi", images: [], effort: "low", references: ["ref1"], runContext: { run: 1 } }],
    ]);
    void res;
  });

  it("promptWithContext failed：ensureRuntime 恢复链（findSessionFileForAgent/restartRuntime 参数/回退置位）后入队新 entry", async () => {
    const world = makeWorld({
      healthOuts: [{ status: "failed" }, { status: "failed" }], // 外层体检与恢复链二次体检均为 failed
      configuredModel: "cfg/model-a",
    });
    const mgr = new AgentManager(world.deps);
    const calls = { _create: [] as any[][], _enqueue: [] as any[][], _writeCtx: [] as any[][] };
    stubUnmigrated(mgr, calls, makeSession());
    mgr.sessions.set("c1", makeSession());
    await mgr.promptWithContext("c1", "hi", [], undefined, [], null);
    // restartRuntime → _create 收到 {cwd, threadId, sessionPath, modelSpec}
    expect(calls._create).toEqual([
      ["c1", { cwd: "norm:/ws/a", threadId: "t1", sessionPath: "/store/s-1.jsonl", modelSpec: "cfg/model-a" }],
    ]);
    expect(world.calls.findSessionFile).toEqual(["s-1"]);
    // 回退置位：modelSpec ≠ failedModel(prov-x/mdl-1)
    expect(mgr.sessions.get("c1").modelFallbackSpec).toBe("cfg/model-a");
    expect(mgr.sessions.get("c1").modelFallbackFrom).toBe("prov-x/mdl-1");
    expect(calls._enqueue).toHaveLength(1);
  });

  it("promptWithContext 无 entry：getOrCreate 建新后入队", async () => {
    const world = makeWorld({ healthOuts: [{ status: "ok" }] });
    const mgr = new AgentManager(world.deps);
    const calls = { _create: [] as any[][], _enqueue: [] as any[][], _writeCtx: [] as any[][] };
    stubUnmigrated(mgr, calls, makeSession());
    await mgr.promptWithContext("c1", "hi", [], undefined, [], null);
    expect(calls._create).toHaveLength(1);
    expect(calls._enqueue).toHaveLength(1);
  });
});

describe("B6-6-4b 会话树", () => {
  it("sessionTree：树列表形状；不可用抛错文案", async () => {
    const tree = [{ id: "n1" }, { id: "n2" }];
    const world = makeWorld({ sessionTreeOut: tree });
    const mgr = new AgentManager(world.deps);
    mgr.sessions.set("c1", makeSession());
    expect(await mgr.sessionTree("c1")).toEqual({ sessionId: "s-1", sessionFile: "/store/s-1.jsonl", nodeCount: 2, tree });
    const world2 = makeWorld({ sessionTreeOut: null });
    const mgr2 = new AgentManager(world2.deps);
    mgr2.sessions.set("c1", makeSession());
    await expect(mgr2.sessionTree("c1")).rejects.toThrow("当前会话不支持会话树读取（sessionManager.getTree 不可用）");
  });

  it("branchSession：busy 拒绝；navigate 调用形态（summarize/label 默认与自定义）与返回形状", async () => {
    const world = makeWorld({ navigateOut: { summaryEntry: { id: "sum" }, cancelled: false, aborted: false } });
    const mgr = new AgentManager(world.deps);
    mgr.sessions.set("c1", makeSession({ busy: true }));
    await expect(mgr.branchSession("c1", "n1")).rejects.toThrow("会话正在执行任务，不能切换分支；请先停止当前任务");
    mgr.sessions.set("c1", makeSession());
    const res = await mgr.branchSession("c1", "n1", { label: "我的分支" });
    expect(res).toEqual({ sessionId: "s-1", navigatedTo: "n1", summarize: true, summaryEntry: { id: "sum" }, cancelled: false, aborted: false });
    expect(world.calls.navigate).toEqual([
      ["rt1", mgr.sessions.get("c1").session, "n1", { summarize: true, label: "我的分支" }],
    ]);
    // summarize: false 与 entryId 缺失
    const world2 = makeWorld({ navigateOut: null });
    const mgr2 = new AgentManager(world2.deps);
    mgr2.sessions.set("c1", makeSession());
    const res2 = await mgr2.branchSession("c1", 42, { summarize: false });
    expect(res2.summarize).toBe(false);
    expect(res2.summaryEntry).toBeNull();
    await expect(mgr2.branchSession("c1", "")).rejects.toThrow("entryId required");
  });
});

describe("B6-6-4b ensureRuntime 恢复链", () => {
  it("无 existing / 工作区不一致：走 getOrCreate 路径", async () => {
    const world = makeWorld({ healthOuts: [{ status: "ok" }] });
    const mgr = new AgentManager(world.deps);
    const calls = { _create: [] as any[][], _enqueue: [] as any[][], _writeCtx: [] as any[][] };
    stubUnmigrated(mgr, calls, makeSession());
    expect(await mgr.ensureRuntime("c1")).toBe(mgr.sessions.get("c1"));
    mgr.sessions.set("c2", makeSession());
    expect(await mgr.ensureRuntime("c2", { cwd: "/ws/other" })).toBe(mgr.sessions.get("c2"));
    // 工作区不一致 → getOrCreate 替换（dispose+重建一次）
    expect(world.calls.dispose).toHaveLength(1);
    expect(world.calls.dispose.every((d) => d[0] === "rt1")).toBe(true);
    expect(calls._create).toHaveLength(2);
  });

  it("健康直返 existing；stale error code 触发恢复", async () => {
    const world = makeWorld({ healthOuts: [{ status: "ok" }] });
    const mgr = new AgentManager(world.deps);
    const calls = { _create: [] as any[][], _enqueue: [] as any[][], _writeCtx: [] as any[][] };
    stubUnmigrated(mgr, calls, makeSession());
    mgr.sessions.set("c1", makeSession());
    expect(await mgr.ensureRuntime("c1", { cwd: "/ws/a" })).toBe(mgr.sessions.get("c1"));
    expect(calls._create).toEqual([]);
    // error.code 命中 stale 名录（恢复链二次体检同 stale 才会真正重建）
    const world2 = makeWorld({ healthOuts: [{ status: "ok", error: { code: "PI_SETTLED_ERROR" } }, { status: "ok", error: { code: "PI_SETTLED_ERROR" } }] });
    const mgr2 = new AgentManager(world2.deps);
    const calls2 = { _create: [] as any[][], _enqueue: [] as any[][], _writeCtx: [] as any[][] };
    stubUnmigrated(mgr2, calls2, makeSession());
    mgr2.sessions.set("c1", makeSession());
    await mgr2.ensureRuntime("c1", { cwd: "/ws/a" });
    expect(calls2._create).toHaveLength(1);
  });

  it("恢复链单飞：并发共享 recovery promise，restartRuntime 仅一次", async () => {
    const world = makeWorld({ healthOuts: [{ status: "failed" }, { status: "failed" }] });
    const mgr = new AgentManager(world.deps);
    const calls = { _create: [] as any[][], _enqueue: [] as any[][], _writeCtx: [] as any[][] };
    stubUnmigrated(mgr, calls, makeSession());
    mgr.sessions.set("c1", makeSession());
    const [r1, r2] = await Promise.all([mgr.ensureRuntime("c1"), mgr.ensureRuntime("c1")]);
    expect(r1).toBe(r2);
    expect(calls._create).toHaveLength(1);
  });

  it("恢复链参数回退：fallbackModel 与 failedModel 相同走 options.modelSpec；found 缺失 sessionPath null", async () => {
    const world = makeWorld({
      healthOuts: [{ status: "failed" }, { status: "failed" }],
      configuredModel: "prov-x/mdl-1", // 与 failedModel 相同
      sessionFileFound: null,
    });
    const mgr = new AgentManager(world.deps);
    const calls = { _create: [] as any[][], _enqueue: [] as any[][], _writeCtx: [] as any[][] };
    stubUnmigrated(mgr, calls, makeSession());
    mgr.sessions.set("c1", makeSession());
    await mgr.ensureRuntime("c1", { cwd: "/ws/a", modelSpec: "  manual/model  " });
    expect(calls._create).toEqual([
      ["c1", { cwd: "/ws/a", threadId: "t1", sessionPath: null, modelSpec: "manual/model" }],
    ]);
    // modelSpec(manual/model) ≠ failedModel → 回退标记置位为实际采用的 spec
    expect(mgr.sessions.get("c1").modelFallbackSpec).toBe("manual/model");
    expect(mgr.sessions.get("c1").modelFallbackFrom).toBe("prov-x/mdl-1");
  });
});

describe("B6-6-4b abort 与 resolveLiveEntry", () => {
  it("无 live entry：返回 no-live-session 不投递", async () => {
    const world = makeWorld();
    const mgr = new AgentManager(world.deps);
    const res = await mgr.abort("c1");
    expect(res).toEqual({ ok: true, cancelled: false, reason: "no-live-session" });
    expect(world.calls.abort).toEqual([]);
  });

  it("abort 正常：字段置位 + aborted 终态事件一次 + busy 清零 + 返回形状", async () => {
    const world = makeWorld();
    const mgr = new AgentManager(world.deps);
    const t1 = makeChannelEntry(makeSession({ activeRunId: "run-1", busy: true }));
    mgr.sessions.set("c1", t1.entry);
    const res = await mgr.abort("c1");
    expect(res).toEqual({ ok: true, cancelled: true, runId: "run-1", runtimeAborted: true, thread: "t1", emitted: true });
    expect(t1.entry.cancelRequested).toBe(true);
    expect(t1.entry.abortRequestedAt).toBe(Date.now());
    expect(t1.entry.runStopCache).toBe(true);
    expect(t1.entry.busy).toBe(false);
    expect(t1.emitted.map((ev: any) => ev.type)).toEqual(["aborted"]);
    expect(t1.emitted[0].data).toEqual({ runId: "run-1", reason: "用户请求中断" });
    expect(world.calls.recordRunEvent).toEqual([
      ["run-1", "aborted", { runId: "run-1", reason: "用户请求中断" }],
    ]);
  });

  it("abort runtime 抛普通错：agent_error 事件 + 仍发 aborted；abort-like 错不发 agent_error", async () => {
    // 普通错：消息不得命中 ABORT_LIKE_PATTERN（abort/中断/取消等词），否则误判 abort-like
    const boom = new Error("boom");
    const world = makeWorld({ abortImpl: async () => { throw boom; } });
    const mgr = new AgentManager(world.deps);
    const t1 = makeChannelEntry(makeSession({ activeRunId: "run-1" }));
    mgr.sessions.set("c1", t1.entry);
    const res = await mgr.abort("c1");
    expect(res.runtimeAborted).toBe(false);
    expect(t1.emitted.map((ev: any) => ev.type)).toEqual(["agent_error", "aborted"]);
    // runId 由 emitChannelSafe 投递层注入（data.runId ?? entry.activeRunId），abort 调用点本身不带
    expect(t1.emitted[0].data).toEqual({ message: "boom", code: "RUNTIME_ABORT_FAILED", runId: "run-1" });
    // abort-like（消息命中中断词表）：不投 agent_error，但 aborted 终态仍发
    const world2 = makeWorld({ abortImpl: async () => { throw new Error("request aborted by user"); } });
    const mgr2 = new AgentManager(world2.deps);
    const t2 = makeChannelEntry(makeSession({ activeRunId: "run-1" }));
    mgr2.sessions.set("c1", t2.entry);
    await mgr2.abort("c1");
    expect(t2.emitted.map((ev: any) => ev.type)).toEqual(["aborted"]);
  });

  it("abort runId 兜底：entry 无 activeRunId 时取 options.runId", async () => {
    const world = makeWorld();
    const mgr = new AgentManager(world.deps);
    mgr.sessions.set("c1", makeSession({ activeRunId: null }));
    const res = await mgr.abort("c1", { runId: "r2" });
    expect(res.runId).toBe("r2");
  });

  it("resolveLiveEntry：exact 命中；前缀兜底 busy 优先；miss/无 key 为 null", () => {
    const world = makeWorld();
    const mgr = new AgentManager(world.deps);
    const idle = makeSession();
    const busy = makeSession({ runtimeId: "rt2", busy: true }); // 判据：busy || activeRunId
    mgr.sessions.set("c1::t1", makeSession());
    mgr.sessions.set("c2::tA", idle);
    mgr.sessions.set("c2::tB", busy);
    expect(mgr.resolveLiveEntry("c1::t1")).toBe(mgr.sessions.get("c1::t1"));
    expect(mgr.resolveLiveEntry("c2::tZ")).toBe(busy);
    // 全空闲 → 返回首个前缀命中
    busy.busy = false;
    expect(mgr.resolveLiveEntry("c2::tZ")).toBe(idle);
    expect(mgr.resolveLiveEntry("missing")).toBeNull();
    expect(mgr.resolveLiveEntry("")).toBeNull();
  });
});

describe("B6-6-4b compact / newThread / resumeThread", () => {
  it("compact 忙时拒绝（busy/compacting/queued/isIdle false）", async () => {
    for (const seed of [{ busy: true }, { compacting: true }, { queuedCount: 1 }, { session: { isIdle: () => false } }]) {
      const world = makeWorld({ compactOut: { tokensBefore: 10, estimatedTokensAfter: 5 } });
      const mgr = new AgentManager(world.deps);
      mgr.sessions.set("c1", makeSession(seed));
      await expect(mgr.compact("c1")).rejects.toThrow("agent busy — wait for the current task to finish");
    }
  });

  it("compact 成功：置位/调用形态（指令 trim）/结果/用量清零/finally 清理", async () => {
    const world = makeWorld({ compactOut: { tokensBefore: 100, estimatedTokensAfter: 40 } });
    const mgr = new AgentManager(world.deps);
    const entrySeed = { activeRunId: "run-1", promptChars: 1234, lastUsage: { input: 1 } };
    mgr.sessions.set("c1", makeSession(entrySeed));
    const res = await mgr.compact("c1", "  保留结论  ");
    expect(res).toEqual({ ok: true, tokensBefore: 100, estimatedTokensAfter: 40 });
    expect(world.calls.compact).toEqual([
      ["rt1", mgr.sessions.get("c1").session, "保留结论"],
    ]);
    const e = mgr.sessions.get("c1");
    expect(e.lastCompactionAt).toBe(Date.now());
    expect(e.promptChars).toBe(0);
    expect(e.lastUsage).toBeNull();
    expect(e.compacting).toBe(false);
    expect(e.compactionPromise).toBeNull();
    expect(e.compactionRunId).toBeNull();
    expect(e.compactionKind).toBeNull();
  });

  it("compact 失败：错误传播且 finally 仍清理", async () => {
    const world = makeWorld({ compactImpl: async () => { throw new Error("compact boom"); } });
    const mgr = new AgentManager(world.deps);
    mgr.sessions.set("c1", makeSession());
    await expect(mgr.compact("c1")).rejects.toThrow("compact boom");
    const e = mgr.sessions.get("c1");
    expect(e.compacting).toBe(false);
    expect(e.compactionRunId).toBeNull();
  });

  it("newThread：无旧/旧空闲 dispose 重建/旧忙拒绝/工作区缺失拒绝", async () => {
    const world = makeWorld();
    const mgr = new AgentManager(world.deps);
    const calls = { _create: [] as any[][], _enqueue: [] as any[][], _writeCtx: [] as any[][] };
    stubUnmigrated(mgr, calls, makeSession());
    const res = await mgr.newThread("c1", "t9", "/ws/b");
    expect(res).toEqual({ ok: true, threadId: "t9", sessionId: "s-1", runtimeId: "rt1", cwd: "norm:/ws/b" });
    expect(calls._create).toEqual([
      ["c1", { cwd: "norm:/ws/b", threadId: "t9" }],
    ]);
    // 旧忙拒绝
    mgr.sessions.set("c2", makeSession({ busy: true }));
    await expect(mgr.newThread("c2", "t9", "/ws/b")).rejects.toThrow("当前会话仍有任务排队，不能替换活动会话");
    // 工作区缺失
    const world2 = makeWorld({ normalize: () => null });
    const mgr2 = new AgentManager(world2.deps);
    await expect(mgr2.newThread("c1", "t9", "/ws/b")).rejects.toThrow("当前工作区不存在或不是文件夹");
  });

  it("resumeThread：单飞共享在途；旧忙抛 TypeError（_sessionBusyError 现状缺陷固化）", async () => {
    const world = makeWorld();
    const mgr = new AgentManager(world.deps);
    const calls = { _create: [] as any[][], _enqueue: [] as any[][], _writeCtx: [] as any[][] };
    stubUnmigrated(mgr, calls, makeSession());
    const [r1, r2] = await Promise.all([mgr.resumeThread("c1", "t9", "/store/s-1.jsonl", "/ws/b"), mgr.resumeThread("c1", "t9", "/store/s-1.jsonl", "/ws/b")]);
    expect(r1).toEqual(r2);
    expect(r1).toEqual({ ok: true, threadId: "t9", sessionId: "s-1", runtimeId: "rt1", cwd: "norm:/ws/b" });
    expect(calls._create).toEqual([
      ["c1", { cwd: "norm:/ws/b", sessionPath: "/store/s-1.jsonl", threadId: "t9" }],
    ]);
    // 旧忙：抛 TypeError（旧代码 _sessionBusyError 未定义的固有现状）
    mgr.sessions.set("c2", makeSession({ busy: true }));
    const err = await mgr.resumeThread("c2", "t9", null, "/ws/b").catch((e: any) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(err.message).toContain("_sessionBusyError");
    // dispose 未触发（抛错在 dispose 之前）
    expect(world.calls.dispose).toEqual([]);
  });

  it("setCurrentFile：既有 entry 置位并同步 writeContextFile；无 entry 走 getOrCreate", async () => {
    const world = makeWorld();
    const mgr = new AgentManager(world.deps);
    const calls = { _create: [] as any[][], _enqueue: [] as any[][], _writeCtx: [] as any[][] };
    stubUnmigrated(mgr, calls, makeSession());
    mgr.sessions.set("c1", makeSession());
    const res = await mgr.setCurrentFile("c1", "docs/a.md");
    expect(res).toEqual({ ok: true, currentFile: "docs/a.md" });
    expect(calls._writeCtx).toEqual([
      [mgr.sessions.get("c1"), "docs/a.md", null],
    ]);
    // file 空串 → null
    const res2 = await mgr.setCurrentFile("c1", "");
    expect(res2.currentFile).toBeNull();
    // 无 entry → getOrCreate
    await mgr.setCurrentFile("c9", "x.md");
    expect(calls._create).toHaveLength(1);
  });
});

describe("B6-6-4b 快照与重启", () => {
  it("runtimeSnapshot：无 entry null；health 调用形态（profile/toolPolicy/overrides 展开）", () => {
    const world = makeWorld({ healthOuts: [{ status: "ok", marker: "snap" }] });
    const mgr = new AgentManager(world.deps);
    expect(mgr.runtimeSnapshot("c1")).toBeNull();
    mgr.sessions.set("c1", makeSession());
    expect(mgr.runtimeSnapshot("c1")).toEqual({ status: "ok", marker: "snap" });
    // modePolicy → toolPolicy 快照（tools 数组拷贝）
    mgr.sessions.get("c1").modePolicy = { mode: "ask", tools: ["read", "write"] };
    mgr.runtimeSnapshot("c1");
    expect(world.calls.health[1]![2]).toEqual({ profile: "通用 Agent", toolPolicy: { mode: "ask", tools: ["read", "write"] } });
    // overrides 覆盖 profile 与 toolPolicy
    mgr.runtimeSnapshot("c1", { profile: "自定义", toolPolicy: null });
    expect(world.calls.health[2]![2]).toEqual({ profile: "自定义", toolPolicy: null });
  });

  it("runtimeHealth：无 entry 返回 missing 兜底形状；有 entry 透传快照", () => {
    const world = makeWorld({ healthOuts: [{ status: "degraded" }] });
    const mgr = new AgentManager(world.deps);
    expect(mgr.runtimeHealth("c1")).toEqual({ status: "missing", health: { status: "unknown", message: "Runtime 尚未创建" } });
    mgr.sessions.set("c1", makeSession());
    expect(mgr.runtimeHealth("c1")).toEqual({ status: "degraded" });
  });

  it("restartRuntime：忙拒绝；空闲 markRecovery+dispose+重建，返回 jsonl_reopen 形状", async () => {
    const world = makeWorld();
    const mgr = new AgentManager(world.deps);
    const calls = { _create: [] as any[][], _enqueue: [] as any[][], _writeCtx: [] as any[][] };
    stubUnmigrated(mgr, calls, makeSession());
    mgr.sessions.set("c1", makeSession({ busy: true }));
    await expect(mgr.restartRuntime("c1", {})).rejects.toThrow("当前 Runtime 仍有任务排队，不能重启");
    mgr.sessions.set("c1", makeSession());
    const res = await mgr.restartRuntime("c1", { threadId: "t2", sessionPath: "/store/s-1.jsonl", cwd: "/ws/b", modelSpec: "m/1" });
    // 返回 cwd 取 entry.workspace（stub _create 原样回填 options.cwd，restartRuntime 不再归一）
    expect(res).toEqual({ ok: true, threadId: "t2", sessionId: "s-1", runtimeId: "rt1", cwd: "/ws/b", recovery: "jsonl_reopen" });
    expect(world.calls.markRecovery).toEqual([["rt1", "manual_runtime_restart"]]);
    expect(calls._create).toEqual([
      ["c1", { cwd: "/ws/b", threadId: "t2", sessionPath: "/store/s-1.jsonl", modelSpec: "m/1" }],
    ]);
  });

  it("listRuntimes：snapshots/scheduler 透传", () => {
    const world = makeWorld({ listSnapshots: [{ id: "rt-a" }], schedulerSnapshots: { pending: 2 } });
    const mgr = new AgentManager(world.deps);
    expect(mgr.listRuntimes()).toEqual({ runtimes: [{ id: "rt-a" }], scheduler: { pending: 2 } });
  });
});
