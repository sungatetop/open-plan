/**
 * AgentManager Prompt 主链批（prompt-chain.ts + agent-manager.ts）单侧行为覆盖。
 * R6-6b 对拍退役改写：原 B6-6-4e 与旧 server/agent.mjs 的双侧对拍机制（行号提取 +
 * new Function 求值旧类）移除，TS 侧行为断言保留为该域深行为的唯一覆盖。
 *
 * 覆盖：
 * - 模块级辅助（prompt-chain.ts）：waitForAgentRetry（经 _promptEntry 重试路径触达）/
 *   waitForPiSessionIdle / promptWithFirstEventTimeout（首事件超时 MODEL_TIMEOUT + abort +
 *   pendingAbortPromise 链 / firstResponseReceived 撤销超时 / idle 流静默
 *   MODEL_STREAM_TIMEOUT / 正常返回）。
 * - _promptEntry 主链：prologue 状态重置 / 当前工作文件 marker / 动态上下文注入 /
 *   review 模式材料分类 / modePolicy 应用与缓存跳过与失败 / thinking level 首设 /
 *   model_request_started / steer 路径 / settled 错误重放与不可重试 / transport 重试 /
 *   模型回退 / "Agent is already processing" 竞态 / continuation 续跑 / completion nudge /
 *   pendingModelSpec 收尾应用成功与失败 / images 归一化 / 恢复应答+引用+task 前缀 /
 *   resource reload / finally 收尾（busy 复位 + runtime_health）。
 *
 * 装配：makeTs 构造 AgentManager（deps 注入 seam stub），实例覆写
 * writeContextFile/buildDynamicContext 注入 stub；piRuntimeManager.prompt 的 attempt 按
 * session 实例计数（不同用例的 session 实例互不串号）；entry 经 session.__entry 反向引用
 * 供 stub 改写 turnStarted/toolStarted 等字段。
 * fake timers + setSystemTime 冻结（信封 at + Date.now），重试退避用
 * advanceTimersByTimeAsync 分段推进（勿用 runAllTimersAsync）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager, type AgentManagerDeps } from "../src/main/backend/agent/agent-manager";
import {
  APP_PROMPT_RETRY_DELAYS,
  SETTLED_AGENT_RETRY_DELAYS,
  MODEL_FALLBACK_LIMIT,
  COMPLETION_NUDGE_PROMPT,
  RESOURCE_RELOAD_INTERVAL_MS,
} from "../src/main/backend/agent/agent-manager";
import { waitForPiSessionIdle, promptWithFirstEventTimeout } from "../src/main/backend/agent/prompt-chain";
import * as nodePath from "node:path";

// 冻结时钟：emitChannelSafe 信封含 at=ISO 时间戳，跨毫秒会比对失败（4a-4d 同口径）
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

// 常量锚点：硬编码期望值（R6-6b 前与旧 agent.mjs 逐值对齐，现保留为新侧口径）
expect(APP_PROMPT_RETRY_DELAYS).toEqual([2000, 6000, 15000]);
expect(SETTLED_AGENT_RETRY_DELAYS).toEqual([1500, 5000, 12000]);
expect(MODEL_FALLBACK_LIMIT).toBe(2);
expect(RESOURCE_RELOAD_INTERVAL_MS).toBe(30000);
expect(COMPLETION_NUDGE_PROMPT).toContain("请立即调用 complete_task");

/**
 * 会话 entry 种子。session.__entry 反向引用 entry（stub 在 pi.prompt 回调里改写
 * entry.turnStarted/toolStarted 等字段用）；channel.emitter 捕获 emit 信封到独立 emitted。
 */
function makeSession(calls: any, overrides: Record<string, unknown> = {}) {
  const emitted: any[] = [];
  const session: any = { sessionId: "s-1", sessionFile: "/store/s-1.jsonl", model: { provider: "prov-x", id: "mdl-1" } };
  const entry: any = {
    runtimeId: "rt1",
    clientId: "c1",
    threadId: "t1",
    workspace: "norm:/ws/a",
    currentFile: "",
    busy: false,
    promptChars: 0,
    session,
    sessionManager: { sm: 1 },
    loader: { reload: async () => { calls.reload += 1; } },
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
  if (overrides.session) (overrides.session as any).__entry = entry;
  session.__entry = entry;
  return { entry, emitted };
}

/** 模型目录夹具（fallbackModel/listModelCatalog 依赖）。 */
function makeCatalog() {
  return {
    providers: new Set(["prov-x", "prov-b"]),
    runtimeModels: [
      { provider: "prov-x", id: "mdl-1", name: "Runtime One", contextWindow: 128000 },
      { provider: "prov-b", id: "mdl-b", contextWindow: 64000 },
    ],
    stored: [
      { provider: "prov-x", id: "mdl-1", name: "Stored One", contextWindow: 99000 },
      { provider: "prov-b", id: "mdl-b", name: "Stored B", contextWindow: 64000 },
    ],
    available: [
      { provider: "prov-x", id: "mdl-1", name: "Avail One" },
      { provider: "prov-b", id: "mdl-b", name: "Avail B" },
    ],
  };
}

/** 依赖世界：seam stub 全量记录调用序列。 */
function makeWorld(opts: {
  promptImpl?: (session: any, text: string, options: any, attempt: number) => any;
  setActiveToolsThrows?: boolean;
  recoveredAnswers?: any[];
  memoryContext?: string;
} = {}) {
  const catalog = makeCatalog();
  const calls = {
    prompt: [] as any[][],
    runPrompt: [] as any[][],
    abort: [] as any[][],
    setActiveTools: [] as any[][],
    update: [] as any[][],
    setThinkingLevel: [] as any[][],
    setModel: [] as any[][],
    health: [] as any[][],
    recordRunEvent: [] as any[][],
    reload: 0,
    writeContextFile: 0,
    buildDynamicContext: 0,
    readMemoryContext: [] as unknown[],
    consumeRecovered: [] as unknown[],
  };
  const mr = {
    getModel: (provider: string, id: string) => catalog.stored.find((m) => m.provider === provider && m.id === id) || null,
    getModels: () => catalog.runtimeModels,
    getAvailable: async () => catalog.available,
    refresh: async () => {},
  };
  const piRuntimeManager: any = {
    modelRuntime: async () => mr,
    dispose: () => {},
    getSessionTree: () => null,
    navigateSessionTree: async () => ({}),
    abort: async (runtimeId: unknown, session: unknown) => { calls.abort.push([runtimeId, session]); },
    compact: async () => ({}),
    health: (runtimeId: unknown, session: unknown) => { calls.health.push([runtimeId, session]); return { status: "healthy" }; },
    markRecovery: () => {},
    listSnapshots: () => [{ id: "rt1" }],
    schedulerSnapshot: () => ({ queue: 0 }),
    setModel: async (runtimeId: unknown, session: unknown, model: unknown) => { calls.setModel.push([runtimeId, session, model]); },
    probeModel: async () => ({}),
    resetModelRuntime: () => {},
    disposeAll: async () => {},
    getContextUsage: () => null,
    prompt: (runtimeId: unknown, session: any, text: unknown, options: any) => {
      calls.prompt.push([runtimeId, session, text, options]);
      // attempt 按 session 实例计数（不同用例的 session 实例互不串号）
      const attempts: Map<unknown, number> = piRuntimeManager.__promptAttempts;
      const attempt = (attempts.get(session) || 0) + 1;
      attempts.set(session, attempt);
      if (opts.promptImpl) return opts.promptImpl(session, text as string, options, attempt);
      return "ok";
    },
    runPrompt: async (runtimeId: unknown, operation: () => Promise<any>, options: any) => {
      calls.runPrompt.push([runtimeId, options]);
      return operation();
    },
    setActiveTools: (runtimeId: unknown, session: unknown, tools: unknown) => {
      if (opts.setActiveToolsThrows) throw new Error("工具边界应用失败");
      calls.setActiveTools.push([runtimeId, session, tools]);
    },
    update: (runtimeId: unknown, patch: any) => { calls.update.push([runtimeId, patch]); },
    setThinkingLevel: (runtimeId: unknown, session: unknown, level: unknown) => { calls.setThinkingLevel.push([runtimeId, session, level]); },
  };
  piRuntimeManager.__promptAttempts = new Map();
  const configuredModelSpec = () => "prov-b/mdl-b";
  const localModelProviders = () => new Set(catalog.providers);
  const localStoredModels = () => catalog.stored.map((m) => ({ ...m }));
  const getCredentialErrors = () => ({});
  const consumeRecoveredAnswers = (clientId: unknown) => { calls.consumeRecovered.push(clientId); return opts.recoveredAnswers ?? []; };
  const readMemoryContext = (workspace: unknown) => { calls.readMemoryContext.push(workspace); return opts.memoryContext ?? "[MEM]"; };
  const emitDeps = { recordRunEvent: (id: unknown, type: unknown, data: unknown) => { calls.recordRunEvent.push([id, type, data]); } };
  const deps: AgentManagerDeps = {
    piRuntimeManager,
    getRun: () => null,
    listStoredMemoryProposals: () => [],
    approveStoredMemoryProposal: () => ({ proposal: null }),
    editStoredMemoryProposal: () => ({ proposal: null }),
    rejectStoredMemoryProposal: () => ({ proposal: null }),
    mergeMemoryProposals: () => ({}),
    getMemoryProposalHistory: () => [],
    configuredModelSpec,
    localModelProviders,
    localStoredModels,
    getCredentialErrors,
    consumeRecoveredAnswers,
    readMemoryContext,
    contextTokensFromUsage: () => null,
    emitDeps,
  };
  return { deps, calls, emitDeps, piRuntimeManager, configuredModelSpec, localModelProviders, localStoredModels, getCredentialErrors, consumeRecoveredAnswers, readMemoryContext };
}

/** TS 侧装配：构造 AgentManager 并覆写 writeContextFile/buildDynamicContext stub。 */
function makeTs(world: ReturnType<typeof makeWorld>) {
  const ts = new AgentManager(world.deps);
  const stubCtx = (entry: any, file: unknown, memCtx: unknown) => {
    void entry; void file; void memCtx;
    world.calls.writeContextFile += 1;
  };
  const stubDyn = () => {
    world.calls.buildDynamicContext += 1;
    return "[DYN]";
  };
  ts.writeContextFile = stubCtx;
  ts.buildDynamicContext = stubDyn;
  return ts;
}

describe("promptWithFirstEventTimeout（模块级辅助）", () => {
  it("首事件超时：prompt 挂起 → MODEL_TIMEOUT 拒绝 + abort + pendingAbortPromise 链清理", async () => {
    const world = makeWorld({ promptImpl: () => new Promise(() => {}) }); // 永不返回
    const { entry } = makeSession(world.calls);
    const p = promptWithFirstEventTimeout(world.piRuntimeManager, entry, "hi", {});
    const assertion = expect(p).rejects.toMatchObject({ code: "MODEL_TIMEOUT", noRetry: true });
    await vi.advanceTimersByTimeAsync(45000);
    await assertion;
    expect(world.calls.abort).toEqual([["rt1", entry.session]]);
    expect(entry.pendingAbortPromise).toBe(null); // abort resolve 后 finally 清链
  });

  it("首事件撤销：firstResponseReceived 置位后 probe 清定时器，prompt 正常返回", async () => {
    const world = makeWorld({ promptImpl: () => new Promise((resolve) => setTimeout(() => resolve("done"), 1000)) });
    const { entry } = makeSession(world.calls);
    const p = promptWithFirstEventTimeout(world.piRuntimeManager, entry, "hi", {});
    await vi.advanceTimersByTimeAsync(300); // probe 周期 250ms
    entry.firstResponseReceived = true;
    await vi.advanceTimersByTimeAsync(60000); // 越过 45s 超时窗口不触发
    await expect(p).resolves.toBe("done");
    expect(world.calls.abort).toEqual([]);
  });

  it("idle 流静默：首事件后 120s 无新事件且无活跃工具 → MODEL_STREAM_TIMEOUT", async () => {
    const world = makeWorld({ promptImpl: () => new Promise(() => {}) });
    const { entry } = makeSession(world.calls);
    entry.firstResponseReceived = true;
    entry.lastPiEventAt = Date.now() - 121000;
    entry.activeToolCount = 0;
    const p = promptWithFirstEventTimeout(world.piRuntimeManager, entry, "hi", {});
    const assertion = expect(p).rejects.toMatchObject({ code: "MODEL_STREAM_TIMEOUT", noRetry: true });
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
    expect(world.calls.abort).toEqual([["rt1", entry.session]]);
  });

  it("waitForPiSessionIdle：isIdle 非函数直返 / 已空闲直返 / 超时 4s 上限", async () => {
    expect(await waitForPiSessionIdle({ session: {} } as any)).toBeUndefined();
    expect(await waitForPiSessionIdle({ session: { isIdle: () => true } } as any)).toBeUndefined();
    const entry = { session: { isIdle: () => false } };
    const p = waitForPiSessionIdle(entry as any);
    const assertion = expect(p).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(4200);
    await assertion;
  });
});

describe("_promptEntry 主链", () => {
  it("非 streaming 完整链：prologue 重置 + modePolicy 应用 + thinking 首设 + finally 收尾", async () => {
    const world = makeWorld();
    const ts = makeTs(world);
    const { entry } = makeSession(world.calls, { pendingCompletion: "stale", turnCount: 5, cancelRequested: true });
    const runContext = { runId: "run-1", task: null };
    await ts._promptEntry(entry, "hello", [], "low", [], runContext);
    // prologue 重置
    expect(entry.busy).toBe(false); // finally 复位
    expect(entry.activeRunId).toBe(null);
    expect(entry.pendingCompletion).toBe(null);
    expect(entry.turnCount).toBe(0);
    expect(entry.cancelRequested).toBe(false);
    expect(entry.task).toBe(null);
    expect(entry.mode).toBe("agent");
    expect(entry.requestedThinkingLevel).toBe("low");
    expect(entry.effectiveThinkingLevel).toBe("low");
    expect(entry.sdkDispatchedRunId).toBe("run-1");
    // buildDynamicContext stub 注入 "[DYN]" → text = "[DYN]\n\nhello"（11 字符）
    expect(entry.promptChars).toBe("[DYN]\n\nhello".length);
    expect(world.calls.prompt[0]![2]).toBe("[DYN]\n\nhello");
    expect(world.calls.prompt[0]![3]).toEqual({});
    // modePolicy：agent 模式首设
    expect(world.calls.setActiveTools.length).toBe(1);
    expect(world.calls.setThinkingLevel.length).toBe(1);
    expect(world.calls.update.length).toBe(2); // toolPolicy + thinkingLevel 各一次
    // runPrompt：主链一次，metadata 带 clientId/threadId/runId，steer=false
    expect(world.calls.runPrompt.length).toBe(1);
    expect(world.calls.runPrompt[0]![1]).toEqual({ steer: false, metadata: { clientId: "c1", threadId: "t1", runId: "run-1" } });
    // finally：runtime_health 落 runs 域
    const healthEvents = world.calls.recordRunEvent.filter((r: any[]) => r[1] === "runtime_health");
    expect(healthEvents.length).toBe(1);
    expect(healthEvents[0]![0]).toBe("run-1");
    expect(healthEvents[0]![2]).toEqual({ status: "healthy" });
  });

  it("上下文注入链：当前工作文件 marker + 动态上下文 + 恢复应答 + 引用 + task 前缀", async () => {
    const world = makeWorld({ recoveredAnswers: [{ question: "q1", answer: "a1" }], memoryContext: "[MEM]" });
    const ts = makeTs(world);
    const runContext = { runId: "run-2", task: { title: "T", goal: "G", mode: "agent", currentFile: "doc.docx", agentProfile: "评审员" } };
    const refs = [{ refId: "r1", status: "ready", name: "n", kind: "file", target: "doc.docx", source: "s", content: "c", meta: {} }];
    const base = { busy: false, promptChars: 0, currentFile: "doc.docx" };
    const { entry } = makeSession(world.calls, base);
    await ts._promptEntry(entry, "继续", [], "low", refs, runContext);
    const text = String(world.calls.prompt[0]![2]);
    expect(text).toContain("[DYN]\n\n");
    expect(text).toContain("## 恢复的用户回答\n- q1: a1");
    expect(text).toContain("## 本轮结构化引用");
    expect(text).toContain("[当前工作文件: doc.docx]");
    expect(text).toContain("当前对话边界"); // task 前缀 + modeDescription
    expect(text).toContain("目标：G"); // taskSummary 摘要（goal 字段）
    // 前缀叠加顺序：task → 引用 → 恢复应答 → 动态上下文 → marker（marker 在最内层文本前）
    expect(text.indexOf("当前对话边界")).toBeLessThan(text.indexOf("## 本轮结构化引用"));
    expect(text.indexOf("## 本轮结构化引用")).toBeLessThan(text.indexOf("## 恢复的用户回答"));
    expect(text.indexOf("## 恢复的用户回答")).toBeLessThan(text.indexOf("[DYN]"));
    expect(text.indexOf("[DYN]")).toBeLessThan(text.indexOf("[当前工作文件: doc.docx]"));
    // writeContextFile/buildDynamicContext 各一次
    expect(world.calls.writeContextFile).toBe(1);
    expect(world.calls.buildDynamicContext).toBe(1);
    expect(world.calls.readMemoryContext.length).toBe(1);
    expect(world.calls.readMemoryContext[0]).toBe("norm:/ws/a");
    expect(world.calls.consumeRecovered[0]).toBe("c1");
  });

  it("review 模式：材料分类事件 + reviewProtectedPaths 按工作区归一路径收集", async () => {
    const world = makeWorld();
    const ts = makeTs(world);
    const runContext = { runId: "run-3", task: { mode: "review", currentFile: "D:/ws/a/报告.docx", references: [{ kind: "file", target: "材料.pdf" }, { kind: "text", target: "not-file" }] } };
    const { entry, emitted } = makeSession(world.calls);
    await ts._promptEntry(entry, "审", [], "low", [], runContext);
    expect(entry.mode).toBe("review");
    const classified = emitted.filter((ev: any) => ev.type === "review_material_classified");
    expect(classified.length).toBe(1);
    expect(classified[0].data.materialType).toBe("Word 文档");
    expect(classified[0].data.confidence).toBe("high");
    expect(entry.reviewProtectedPaths.has(nodePath.resolve("norm:/ws/a", "D:/ws/a/报告.docx").toLowerCase())).toBe(true);
    expect(entry.reviewProtectedPaths.has(nodePath.resolve("norm:/ws/a", "材料.pdf").toLowerCase())).toBe(true);
    expect(entry.reviewProtectedPaths.has(nodePath.resolve("norm:/ws/a", "not-file").toLowerCase())).toBe(false);
  });

  it("modePolicy 缓存命中：modePolicyKey 相同 → 不再 setActiveTools（仅 thinking 首设 update）", async () => {
    const world = makeWorld();
    const ts = makeTs(world);
    // 与实现同款 key：agent 模式 + 通用 Agent + 空 dynamicTools
    const key = "agent:通用 Agent:";
    const { entry } = makeSession(world.calls, { modePolicyKey: key });
    await ts._promptEntry(entry, "hi");
    expect(world.calls.setActiveTools.length).toBe(0);
    expect(world.calls.update.length).toBe(1); // 仅 thinkingLevel 一次
  });

  it("modePolicy 应用失败：agent_error(MODE_POLICY_APPLY_FAILED) + rethrow + finally 复位", async () => {
    const world = makeWorld({ setActiveToolsThrows: true });
    const ts = makeTs(world);
    const { entry, emitted } = makeSession(world.calls);
    await expect(ts._promptEntry(entry, "hi")).rejects.toThrow("工具边界应用失败");
    const err = emitted.filter((ev: any) => ev.type === "agent_error");
    expect(err.length).toBe(1);
    expect(err[0].data.code).toBe("MODE_POLICY_APPLY_FAILED");
    expect(err[0].data.message).toContain("无法应用Agent模式的工具边界");
    expect(entry.busy).toBe(false);
    expect(entry.modePolicy).toBe(null);
  });

  it("steer 路径：busy 会话投递 → streamingBehavior=steer + steer 事件 + runPrompt steer:true", async () => {
    const world = makeWorld();
    const ts = makeTs(world);
    const { entry, emitted } = makeSession(world.calls, { busy: true });
    await ts._promptEntry(entry, "插入指令");
    expect(world.calls.runPrompt.length).toBe(1);
    expect(world.calls.runPrompt[0]![1]).toEqual({ steer: true, metadata: { clientId: "c1", threadId: "t1", runId: null } });
    // steer 路径同样会应用 modePolicy（isStreaming 不跳过工具边界段；entry 无 modePolicyKey → 首设）
    expect(world.calls.setActiveTools.length).toBe(1);
    expect(world.calls.prompt[0]![3]).toEqual({ streamingBehavior: "steer" });
    const steer = emitted.filter((ev: any) => ev.type === "steer");
    expect(steer.length).toBe(1);
    expect(steer[0].data.text).toBe("[DYN]\n\n插入指令"); // buildDynamicContext stub 前缀注入后的最终 text
  });

  it("settled 可重试错误：agent_retry(workbench-settled) → 退避 1500ms → 重放成功 → agent_retry_end", async () => {
    // settled error 由 provider 事件流在首轮 prompt 期间写入（prologue 每轮重置 lastSettledError，
    // 预置会被清空——通过 session.__entry 在 stub 内写入模拟真实时序）
    const world = makeWorld({ promptImpl: (session, _t, _o, attempt) => {
      if (attempt === 1) session.__entry.lastSettledError = new Error("connection error");
      return "ok";
    } });
    const ts = makeTs(world);
    const { entry, emitted } = makeSession(world.calls);
    const p = ts._promptEntry(entry, "hi");
    await vi.advanceTimersByTimeAsync(SETTLED_AGENT_RETRY_DELAYS[0]! + 10);
    await p;
    const retries = emitted.filter((ev: any) => ev.type === "agent_retry");
    expect(retries.length).toBe(1);
    expect(retries[0].data.source).toBe("workbench-settled");
    expect(retries[0].data.attempt).toBe(1);
    expect(retries[0].data.delayMs).toBe(1500);
    expect(retries[0].data.maxAttempts).toBe(3);
    const end = emitted.filter((ev: any) => ev.type === "agent_retry_end");
    expect(end.length).toBe(1);
    expect(end[0].data.message).toBe("模型连接已恢复");
    expect(entry.lastSettledError).toBe(null);
  });

  it("settled 不可重试（noRetry）：createSettledAgentError 包装后抛出且只投一次", async () => {
    // noRetry 错误由 prompt stub 执行期写入（prologue 每轮重置 lastSettledError，预置会被清空）；
    // createSettledAgentError 仅保留 message 重新归类，原始 code 不透传 → PI_SETTLED_ERROR
    const world = makeWorld({ promptImpl: (session) => {
      session.__entry.lastSettledError = Object.assign(new Error("首事件超时"), { code: "MODEL_TIMEOUT", noRetry: true });
      return "ok";
    } });
    const ts = makeTs(world);
    const { entry } = makeSession(world.calls);
    await expect(ts._promptEntry(entry, "hi")).rejects.toMatchObject({ code: "PI_SETTLED_ERROR", message: "首事件超时", noRetry: true });
    expect(world.calls.prompt.length).toBe(1); // 只投一次
  });

  it("transport 重试：prompt 抛连接错误 → agent_retry(workbench-transport) → 退避 2000ms → 成功", async () => {
    const world = makeWorld({ promptImpl: (_s, _t, _o, attempt) => {
      if (attempt === 1) throw new Error("network error: connection refused");
      return "recovered";
    } });
    const ts = makeTs(world);
    // 连接错误先走 canFallbackModel 分支；覆写 fallbackModel 返回 null 模拟候选穷尽，
    // 才会掉入 transport replay（否则 fallbackModel 依目录返回 prov-b/mdl-b 走模型回退）
    ts.fallbackModel = async () => null;
    const { entry, emitted } = makeSession(world.calls);
    const p = ts._promptEntry(entry, "hi");
    await vi.advanceTimersByTimeAsync(APP_PROMPT_RETRY_DELAYS[0]! + 10);
    await p;
    const retries = emitted.filter((ev: any) => ev.type === "agent_retry");
    expect(retries.length).toBe(1);
    expect(retries[0].data.source).toBe("workbench-transport");
    expect(retries[0].data.attempt).toBe(1);
    expect(retries[0].data.delayMs).toBe(2000);
    expect(retries[0].data.maxAttempts).toBe(3);
    expect(emitted.filter((ev: any) => ev.type === "agent_retry_end").length).toBe(0); // transport 成功不发 end
    expect(world.calls.prompt.length).toBe(2); // 首投 + 重试一次
  });

  it("模型回退：retryable 且未收到首事件 → fallbackModel 切换 → agent_model_fallback → 重试成功", async () => {
    const world = makeWorld({ promptImpl: (_s, _t, _o, attempt) => {
      if (attempt === 1) throw new Error("network error: fetch failed");
      return "after-fallback";
    } });
    const ts = makeTs(world);
    const { entry, emitted } = makeSession(world.calls);
    const p = ts._promptEntry(entry, "hi");
    await vi.advanceTimersByTimeAsync(APP_PROMPT_RETRY_DELAYS[0]! + 10);
    await p;
    expect(world.calls.setModel.length).toBe(1); // 切换一次
    expect(entry.modelFallbackSpec).toBe("prov-b/mdl-b");
    const fb = emitted.filter((ev: any) => ev.type === "agent_model_fallback");
    expect(fb.length).toBe(1);
    expect(fb[0].data.from).toBe("prov-x/mdl-1");
    expect(fb[0].data.to).toBe("prov-b/mdl-b");
    expect(fb[0].data.attempt).toBe(1);
  });

  it("竞态兜底：'Agent is already processing' → steer 事件 + steer 二次投递后 break", async () => {
    const world = makeWorld({ promptImpl: (_s, _t, _o, attempt) => {
      if (attempt === 1) throw new Error("Agent is already processing");
      return "steered";
    } });
    const ts = makeTs(world);
    const { entry, emitted } = makeSession(world.calls);
    await ts._promptEntry(entry, "hi");
    expect(world.calls.prompt.length).toBe(2); // 首投 + steer 二次投递
    expect(world.calls.prompt.some((c: any[]) => c[3]?.streamingBehavior === "steer")).toBe(true);
    expect(emitted.filter((ev: any) => ev.type === "steer").length).toBe(1);
    expect(emitted.filter((ev: any) => ev.type === "agent_retry").length).toBe(0);
  });

  it("continuation 续跑：turnStarted 后连接中断 → waitForPiSessionIdle → 固定续跑文本 → agent_retry_end", async () => {
    const world = makeWorld({ promptImpl: (session, _t, _o, attempt) => {
      if (attempt === 1) {
        const entry = session.__entry;
        entry.turnStarted = true; // 模拟已开轮
        entry.lastAssistantText = "部分输出";
        throw new Error("network error: other side closed");
      }
      return "continued";
    } });
    const ts = makeTs(world);
    const { entry, emitted } = makeSession(world.calls);
    const p = ts._promptEntry(entry, "hi");
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    const continuationText = "上一个回合的模型连接中断了。请基于当前会话中已经完成的步骤和工具结果，从中断位置继续原任务；不要重复已经成功的副作用操作，完成后给出完整结果。";
    expect(world.calls.prompt.some((c: any[]) => c[2] === continuationText)).toBe(true);
    const retries = emitted.filter((ev: any) => ev.type === "agent_retry");
    expect(retries.length).toBe(1);
    expect(retries[0].data.source).toBe("workbench-continuation");
    expect(retries[0].data.delayMs).toBe(300);
    const end = emitted.filter((ev: any) => ev.type === "agent_retry_end");
    expect(end.length).toBe(1);
    expect(end[0].data.message).toBe("已从当前会话继续");
  });

  it("completion nudge：toolStarted 且无 pendingCompletion → 短回合补声明 + suppressFinalText 恢复", async () => {
    const world = makeWorld({ promptImpl: (session) => { session.__entry.toolStarted = true; return "worked"; } });
    const ts = makeTs(world);
    const { entry, emitted } = makeSession(world.calls);
    await ts._promptEntry(entry, "hi");
    expect(world.calls.runPrompt.length).toBe(2); // 主链 + nudge
    expect(world.calls.runPrompt[1]![1]).toEqual({ steer: false, metadata: { clientId: "c1", threadId: "t1", runId: null, purpose: "completion_nudge" } });
    expect(world.calls.prompt[1]![2]).toBe(COMPLETION_NUDGE_PROMPT);
    expect(entry.suppressFinalText).toBe(false);
    expect(entry.completionNudgeSent).toBe(true);
    expect(emitted.filter((ev: any) => ev.type === "completion_nudge").length).toBe(1);
  });

  it("pendingModelSpec 收尾：排队模型切换在本轮结束后应用并广播 model_switched(effective=now)", async () => {
    const world = makeWorld();
    const ts = makeTs(world);
    const { entry, emitted } = makeSession(world.calls, { pendingModelSpec: "prov-b/mdl-b" });
    await ts._promptEntry(entry, "hi");
    expect(world.calls.setModel.length).toBe(1);
    expect(entry.pendingModelSpec).toBe("");
    const switched = emitted.filter((ev: any) => ev.type === "model_switched");
    expect(switched.length).toBe(1);
    expect(switched[0].data.reason).toBe("queued");
    expect(switched[0].data.effective).toBe("now");
    expect(switched[0].data.to).toBe("prov-b/mdl-b");
  });

  it("pendingModelSpec 失败：applyModelSpec 抛错 → model_switched(effective=failed) 带截断消息", async () => {
    const world = makeWorld();
    const ts = makeTs(world);
    const boom = async () => { throw new Error("切换失败原因超长将被截断：" + "x".repeat(300)); };
    ts.applyModelSpec = boom;
    const { entry, emitted } = makeSession(world.calls, { pendingModelSpec: "bad/spec" });
    await ts._promptEntry(entry, "hi");
    const switched = emitted.filter((ev: any) => ev.type === "model_switched");
    expect(switched.length).toBe(1);
    expect(switched[0].data.effective).toBe("failed");
    expect(switched[0].data.message.length).toBe(200);
  });

  it("images 归一化：pi-ai ImageContent {type:image,data,mimeType}，mediaType 缺省 image/png", async () => {
    const world = makeWorld();
    const ts = makeTs(world);
    const images = [{ data: "AAAA", mediaType: "image/webp" }, { data: "BBBB" }];
    const { entry } = makeSession(world.calls);
    await ts._promptEntry(entry, "看图", images);
    expect(world.calls.prompt[0]![3]).toEqual({ images: [{ type: "image", data: "AAAA", mimeType: "image/webp" }, { type: "image", data: "BBBB", mimeType: "image/png" }] });
  });

  it("resource reload：lastResourceReloadAt 过期触发后台 reload，同轮去重且完成后清 promise", async () => {
    const world = makeWorld();
    const ts = makeTs(world);
    const { entry } = makeSession(world.calls, { lastResourceReloadAt: Date.now() - RESOURCE_RELOAD_INTERVAL_MS - 1 });
    await ts._promptEntry(entry, "hi");
    expect(world.calls.reload).toBe(1);
    expect(entry.resourceReloadPromise).toBe(null);
    // 二轮（未过期）不再触发
    await ts._promptEntry(entry, "again");
    expect(world.calls.reload).toBe(1);
  });

  it("runPrompt 抛错（非 retryable 终态）：原样冒泡且 finally 仍复位 busy + 落 runtime_health", async () => {
    const world = makeWorld({ promptImpl: () => { throw new Error("invalid api key"); } });
    const ts = makeTs(world);
    const { entry } = makeSession(world.calls);
    const runContext = { runId: "run-err" };
    await expect(ts._promptEntry(entry, "hi", [], "low", [], runContext)).rejects.toThrow("invalid api key");
    expect(entry.busy).toBe(false);
    expect(entry.activeRunId).toBe(null);
    const healthEvents = world.calls.recordRunEvent.filter((r: any[]) => r[1] === "runtime_health");
    expect(healthEvents.length).toBe(1);
    expect(healthEvents[0]![0]).toBe("run-err");
  });
});
