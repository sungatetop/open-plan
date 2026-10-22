/**
 * B6-6-4e 对拍：AgentManager Prompt 主链批（server/agent.mjs）。
 *
 * 覆盖：
 * - 模块级辅助（L589-679 → prompt-chain.ts）：waitForAgentRetry / waitForPiSessionIdle /
 *   promptWithFirstEventTimeout（首事件超时 MODEL_TIMEOUT + abort + pendingAbortPromise 链 /
 *   firstResponseReceived 撤销超时 / idle 流静默 MODEL_STREAM_TIMEOUT / 正常返回）。
 * - _promptEntry 主链（L3717-4141）：prologue 状态重置 / 当前工作文件 marker / 动态上下文
 *   注入 / review 模式材料分类 / modePolicy 应用与缓存跳过与失败 / thinking level 首设 /
 *   model_request_started / steer 路径 / settled 错误重放与不可重试 / transport 重试 /
 *   模型回退 / "Agent is already processing" 竞态 / continuation 续跑 / completion nudge /
 *   pendingModelSpec 收尾应用成功与失败 / images 归一化 / 恢复应答+引用+task 前缀 /
 *   resource reload / finally 收尾（busy 复位 + runtime_health）。
 *
 * 旧侧按行号提取源段 + new Function 求值：L589-679（模块级辅助）+ L843-1018（类头+构造器
 * +薄方法，构造器字段与 modelRuntime 必需）+ L3717-4141（_promptEntry）+ L4453-4494
 * （applyModelSpec，pendingModelSpec 收尾用）+ L4541-4624（fallbackModel+listModelCatalog，
 * 模型回退用）拼 class 表达式。promptWithFirstEventTimeout 旧侧 3 参（闭包引用工厂参数
 * piRuntimeManager）、新侧 4 参（首参显式传 seam），两侧各自类体源码天然同流。
 * writeContextFile/buildDynamicContext 未迁（4f 批），两侧实例覆写注入同一 stub。
 * promptImpl 的 attempt 按 session 对象分侧计数（两侧 session 实例不同，互不串号；
 * 4c __setModelAttempts 同款先例）；entry 经 session.__entry 反向引用供 stub 改写
 * turnStarted/toolStarted 等字段。emitChannelSafe 旧侧包装绑定同一 emitDeps（4b 口径）；
 * recordRunEvent 双侧共享 stub，world.calls 计数 = 两侧之和。并发断言（calls.prompt/
 * runPrompt 具体下标）只在两侧调用同构时使用，异构断言用 some/all 过滤。
 * fake timers + setSystemTime 冻结（信封 at + Date.now），重试退避用
 * advanceTimersByTimeAsync 分段推进（勿用 runAllTimersAsync）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { AgentManager, type AgentManagerDeps } from "../src/main/backend/agent/agent-manager";
import {
  APP_PROMPT_RETRY_DELAYS,
  SETTLED_AGENT_RETRY_DELAYS,
  MODEL_FALLBACK_LIMIT,
  COMPLETION_NUDGE_PROMPT,
  RESOURCE_RELOAD_INTERVAL_MS,
} from "../src/main/backend/agent/agent-manager";
import { emitChannelSafe } from "../src/main/backend/agent/emit-helpers";
import { classifyAgentError, createSettledAgentError, resolveThinkingLevel } from "../src/main/backend/agent/agent-errors";
import { waitForAgentRetry, waitForPiSessionIdle, promptWithFirstEventTimeout } from "../src/main/backend/agent/prompt-chain";
import { markRunTiming, attachRunTimingSpans } from "../src/shared/runtime/first-token-latency";
import { normalizeTaskMode, modeLabel, modeDescription, taskSummary, toolPolicyForMode } from "../src/shared/runtime/task";
import { contextSummary } from "../src/main/backend/agent/context";
import { getWorkspace } from "../src/main/backend/workspace";
import { currentModelSpec } from "../src/main/backend/agent/model-spec";
import * as nodePath from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LINES_AGENT = readFileSync(path.resolve(HERE, "../../server/agent.mjs"), "utf8").split("\n");
const segAgent = (start: number, end: number) => LINES_AGENT.slice(start - 1, end).join("\n").replace(/^export\s+/gm, "");

// 冻结时钟：emitChannelSafe 信封含 at=ISO 时间戳，双侧执行跨毫秒会比对失败（4a-4d 同口径）
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

// 行号锚点：源文件结构变动导致偏移时，这里先行失败提醒更新提取区间
expect(segAgent(589, 589)).toContain("function waitForAgentRetry(delayMs) {");
expect(segAgent(607, 607)).toContain("async function waitForPiSessionIdle(entry, timeoutMs = 4000) {");
expect(segAgent(625, 625)).toContain("async function promptWithFirstEventTimeout(entry, text, options = {}) {");
expect(segAgent(679, 679)).toContain("}");
expect(segAgent(843, 843)).toContain("class AgentManager extends EventEmitter {");
expect(segAgent(844, 844)).toContain("constructor() {");
expect(segAgent(1018, 1018)).toContain("}");
expect(segAgent(3717, 3717)).toContain("async _promptEntry(entry, text, images = [], effort, references = [], runContext = null) {");
expect(segAgent(4141, 4141)).toContain("}");
expect(segAgent(4453, 4453)).toContain("async applyModelSpec(entry, spec) {");
expect(segAgent(4493, 4493)).toContain("}");
expect(segAgent(4541, 4541)).toContain("async fallbackModel(entry, triedSpecs = []) {");
expect(segAgent(4573, 4573)).toContain("async listModelCatalog() {");
expect(segAgent(4624, 4624)).toContain("}");

// 常量锚点：与 agent.mjs 逐值一致
expect(APP_PROMPT_RETRY_DELAYS).toEqual([2000, 6000, 15000]);
expect(SETTLED_AGENT_RETRY_DELAYS).toEqual([1500, 5000, 12000]);
expect(MODEL_FALLBACK_LIMIT).toBe(2);
expect(RESOURCE_RELOAD_INTERVAL_MS).toBe(30000);
expect(COMPLETION_NUDGE_PROMPT).toContain("请立即调用 complete_task");
expect(segAgent(344, 345).replace(/^const\s+/gm, "")).toContain(COMPLETION_NUDGE_PROMPT);

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

/** 模型目录夹具（fallbackModel/listModelCatalog 依赖，双侧共享）。 */
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

/** 双侧共享依赖世界：seam stub 全量记录调用序列（calls 为双侧累加）。 */
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
    // B6-6-4e 扩员
    prompt: (runtimeId: unknown, session: any, text: unknown, options: any) => {
      calls.prompt.push([runtimeId, session, text, options]);
      // attempt 按 session 对象分侧计数（两侧 session 实例不同，互不串号）
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

/** 旧侧类工厂：模块级辅助段 + 类头构造器段 + _promptEntry + applyModelSpec + 模型族，依赖同名参数注入。 */
function makeOldManager(world: ReturnType<typeof makeWorld>) {
  const Ctor = new Function(
    "EventEmitter",
    "RUNTIME_FLAGS",
    "piRuntimeManager",
    "getWorkspace",
    "configuredModelSpec",
    "localModelProviders",
    "localStoredModels",
    "getCredentialErrors",
    "currentModelSpec",
    "emitChannelSafe",
    "recordRunEvent",
    "consumeRecoveredAnswers",
    "readMemoryContext",
    "markRunTiming",
    "attachRunTimingSpans",
    "classifyAgentError",
    "createSettledAgentError",
    "resolveThinkingLevel",
    "normalizeTaskMode",
    "modeLabel",
    "modeDescription",
    "taskSummary",
    "toolPolicyForMode",
    "contextSummary",
    "path",
    "APP_PROMPT_RETRY_DELAYS",
    "SETTLED_AGENT_RETRY_DELAYS",
    "MODEL_FALLBACK_LIMIT",
    "COMPLETION_NUDGE_PROMPT",
    "RESOURCE_RELOAD_INTERVAL_MS",
    "MODEL_FIRST_EVENT_TIMEOUT_MS",
    "MODEL_IDLE_TIMEOUT_MS",
    `${segAgent(589, 679)}
${segAgent(843, 1018)}
${segAgent(3717, 4141)}
${segAgent(4453, 4494)}
${segAgent(4541, 4624)}
}
return AgentManager;`,
  )(
    EventEmitter,
    {}, // RUNTIME_FLAGS：agentBusyWatchdog 默认关，看门狗 interval 空转
    world.piRuntimeManager,
    getWorkspace,
    world.configuredModelSpec,
    world.localModelProviders,
    world.localStoredModels,
    world.getCredentialErrors,
    currentModelSpec,
    // 旧类三参调用 → 包装绑定同一 emitDeps，与新侧 this.deps.emitDeps 同流
    (entry: any, type: string, data: any) => emitChannelSafe(entry, type, data, {}, world.emitDeps),
    (id: unknown, type: unknown, data: unknown) => world.emitDeps.recordRunEvent!(id, type, data),
    world.consumeRecoveredAnswers,
    world.readMemoryContext,
    markRunTiming,
    attachRunTimingSpans,
    classifyAgentError,
    createSettledAgentError,
    resolveThinkingLevel,
    normalizeTaskMode,
    modeLabel,
    modeDescription,
    taskSummary,
    toolPolicyForMode,
    contextSummary,
    nodePath,
    APP_PROMPT_RETRY_DELAYS,
    SETTLED_AGENT_RETRY_DELAYS,
    MODEL_FALLBACK_LIMIT,
    COMPLETION_NUDGE_PROMPT,
    RESOURCE_RELOAD_INTERVAL_MS,
    45000,
    120000,
  );
  return Ctor;
}

/** 双侧装配：旧工厂 + TS AgentManager，两侧实例覆写同一 writeContextFile/buildDynamicContext stub。 */
function makePair(world: ReturnType<typeof makeWorld>) {
  const Old = makeOldManager(world);
  const old = new Old();
  const ts = new AgentManager(world.deps);
  const stubCtx = (entry: any, file: unknown, memCtx: unknown) => {
    void entry; void file; void memCtx;
    world.calls.writeContextFile += 1;
  };
  const stubDyn = () => {
    world.calls.buildDynamicContext += 1;
    return "[DYN]";
  };
  old.writeContextFile = stubCtx;
  old.buildDynamicContext = stubDyn;
  ts.writeContextFile = stubCtx;
  ts.buildDynamicContext = stubDyn;
  return { old, ts };
}

describe("B6-6-4e promptWithFirstEventTimeout（模块级辅助对拍）", () => {
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

describe("B6-6-4e _promptEntry 主链对拍", () => {
  it("非 streaming 完整链：prologue 重置 + modePolicy 应用 + thinking 首设 + finally 收尾", async () => {
    const world = makeWorld();
    const { old, ts } = makePair(world);
    const { entry: e1 } = makeSession(world.calls, { pendingCompletion: "stale", turnCount: 5, cancelRequested: true });
    const { entry: e2 } = makeSession(world.calls, { pendingCompletion: "stale", turnCount: 5, cancelRequested: true });
    const runContext = { runId: "run-1", task: null };
    await Promise.all([old._promptEntry(e1, "hello", [], "low", [], runContext), ts._promptEntry(e2, "hello", [], "low", [], runContext)]);
    for (const entry of [e1, e2]) {
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
    }
    expect(world.calls.prompt[0]![2]).toBe("[DYN]\n\nhello"); // 两侧同构调用，下标安全
    expect(world.calls.prompt[0]![3]).toEqual({});
    // modePolicy：agent 模式首设（双侧各一次）
    expect(world.calls.setActiveTools.length).toBe(2);
    expect(world.calls.setThinkingLevel.length).toBe(2);
    expect(world.calls.update.length).toBe(4); // 双侧各两次（toolPolicy + thinkingLevel）
    // runPrompt：主链一次/侧，metadata 带 clientId/threadId/runId，steer=false
    expect(world.calls.runPrompt.length).toBe(2);
    expect(world.calls.runPrompt[0]![1]).toEqual({ steer: false, metadata: { clientId: "c1", threadId: "t1", runId: "run-1" } });
    // finally：runtime_health 落 runs 域
    const healthEvents = world.calls.recordRunEvent.filter((r: any[]) => r[1] === "runtime_health");
    expect(healthEvents.length).toBe(2);
    expect(healthEvents[0]![0]).toBe("run-1");
    expect(healthEvents[0]![2]).toEqual({ status: "healthy" });
  });

  it("上下文注入链：当前工作文件 marker + 动态上下文 + 恢复应答 + 引用 + task 前缀", async () => {
    const world = makeWorld({ recoveredAnswers: [{ question: "q1", answer: "a1" }], memoryContext: "[MEM]" });
    const { old, ts } = makePair(world);
    const runContext = { runId: "run-2", task: { title: "T", goal: "G", mode: "agent", currentFile: "doc.docx", agentProfile: "评审员" } };
    const refs = [{ refId: "r1", status: "ready", name: "n", kind: "file", target: "doc.docx", source: "s", content: "c", meta: {} }];
    const base = { busy: false, promptChars: 0, currentFile: "doc.docx" };
    const { entry: e1 } = makeSession(world.calls, base);
    const { entry: e2 } = makeSession(world.calls, base);
    await Promise.all([old._promptEntry(e1, "继续", [], "low", refs, runContext), ts._promptEntry(e2, "继续", [], "low", refs, runContext)]);
    const text1 = String(world.calls.prompt[0]![2]);
    const text2 = String(world.calls.prompt[1]![2]);
    expect(text1).toBe(text2); // 双侧同构
    expect(text1).toContain("[DYN]\n\n");
    expect(text1).toContain("## 恢复的用户回答\n- q1: a1");
    expect(text1).toContain("## 本轮结构化引用");
    expect(text1).toContain("[当前工作文件: doc.docx]");
    expect(text1).toContain("当前对话边界"); // task 前缀 + modeDescription
    expect(text1).toContain("目标：G"); // taskSummary 摘要（goal 字段）
    // 前缀叠加顺序：task → 引用 → 恢复应答 → 动态上下文 → marker（marker 在最内层文本前）
    expect(text1.indexOf("当前对话边界")).toBeLessThan(text1.indexOf("## 本轮结构化引用"));
    expect(text1.indexOf("## 本轮结构化引用")).toBeLessThan(text1.indexOf("## 恢复的用户回答"));
    expect(text1.indexOf("## 恢复的用户回答")).toBeLessThan(text1.indexOf("[DYN]"));
    expect(text1.indexOf("[DYN]")).toBeLessThan(text1.indexOf("[当前工作文件: doc.docx]"));
    // writeContextFile/buildDynamicContext 双侧各一次，共享同一 memCtx
    expect(world.calls.writeContextFile).toBe(2);
    expect(world.calls.buildDynamicContext).toBe(2);
    expect(world.calls.readMemoryContext.length).toBe(2);
    expect(world.calls.readMemoryContext[0]).toBe("norm:/ws/a");
    expect(world.calls.consumeRecovered[0]).toBe("c1");
  });

  it("review 模式：材料分类事件 + reviewProtectedPaths 按工作区归一路径收集", async () => {
    const world = makeWorld();
    const { old, ts } = makePair(world);
    const runContext = { runId: "run-3", task: { mode: "review", currentFile: "D:/ws/a/报告.docx", references: [{ kind: "file", target: "材料.pdf" }, { kind: "text", target: "not-file" }] } };
    const { entry: e1, emitted: em1 } = makeSession(world.calls);
    const { entry: e2, emitted: em2 } = makeSession(world.calls);
    await Promise.all([old._promptEntry(e1, "审", [], "low", [], runContext), ts._promptEntry(e2, "审", [], "low", [], runContext)]);
    for (const [entry, emitted] of [[e1, em1], [e2, em2]] as [any, any[]][]) {
      expect(entry.mode).toBe("review");
      const classified = emitted.filter((ev: any) => ev.type === "review_material_classified");
      expect(classified.length).toBe(1);
      expect(classified[0].data.materialType).toBe("Word 文档");
      expect(classified[0].data.confidence).toBe("high");
      expect(entry.reviewProtectedPaths.has(nodePath.resolve("norm:/ws/a", "D:/ws/a/报告.docx").toLowerCase())).toBe(true);
      expect(entry.reviewProtectedPaths.has(nodePath.resolve("norm:/ws/a", "材料.pdf").toLowerCase())).toBe(true);
      expect(entry.reviewProtectedPaths.has(nodePath.resolve("norm:/ws/a", "not-file").toLowerCase())).toBe(false);
    }
  });

  it("modePolicy 缓存命中：modePolicyKey 相同 → 不再 setActiveTools（仅 thinking 首设 update）", async () => {
    const world = makeWorld();
    const { old, ts } = makePair(world);
    // 与实现同款 key：agent 模式 + 通用 Agent + 空 dynamicTools
    const key = "agent:通用 Agent:";
    const { entry: e1 } = makeSession(world.calls, { modePolicyKey: key });
    const { entry: e2 } = makeSession(world.calls, { modePolicyKey: key });
    await Promise.all([old._promptEntry(e1, "hi"), ts._promptEntry(e2, "hi")]);
    expect(world.calls.setActiveTools.length).toBe(0);
    expect(world.calls.update.length).toBe(2); // 仅 thinkingLevel 一次/侧
  });

  it("modePolicy 应用失败：agent_error(MODE_POLICY_APPLY_FAILED) + rethrow + finally 复位", async () => {
    const world = makeWorld({ setActiveToolsThrows: true });
    const { old, ts } = makePair(world);
    const { entry: e1, emitted: em1 } = makeSession(world.calls);
    const { entry: e2, emitted: em2 } = makeSession(world.calls);
    await expect(old._promptEntry(e1, "hi")).rejects.toThrow("工具边界应用失败");
    await expect(ts._promptEntry(e2, "hi")).rejects.toThrow("工具边界应用失败");
    for (const emitted of [em1, em2]) {
      const err = emitted.filter((ev: any) => ev.type === "agent_error");
      expect(err.length).toBe(1);
      expect(err[0].data.code).toBe("MODE_POLICY_APPLY_FAILED");
      expect(err[0].data.message).toContain("无法应用Agent模式的工具边界");
    }
    expect(e1.busy).toBe(false);
    expect(e2.busy).toBe(false);
    expect(e1.modePolicy).toBe(null);
    expect(e2.modePolicy).toBe(null);
  });

  it("steer 路径：busy 会话投递 → streamingBehavior=steer + steer 事件 + runPrompt steer:true", async () => {
    const world = makeWorld();
    const { old, ts } = makePair(world);
    const { entry: e1, emitted: em1 } = makeSession(world.calls, { busy: true });
    const { entry: e2, emitted: em2 } = makeSession(world.calls, { busy: true });
    await Promise.all([old._promptEntry(e1, "插入指令"), ts._promptEntry(e2, "插入指令")]);
    expect(world.calls.runPrompt.length).toBe(2);
    expect(world.calls.runPrompt[0]![1]).toEqual({ steer: true, metadata: { clientId: "c1", threadId: "t1", runId: null } });
    // steer 路径同样会应用 modePolicy（isStreaming 不跳过工具边界段；entry 无 modePolicyKey → 首设）
    expect(world.calls.setActiveTools.length).toBe(2);
    expect(world.calls.prompt[0]![3]).toEqual({ streamingBehavior: "steer" });
    for (const emitted of [em1, em2]) {
      const steer = emitted.filter((ev: any) => ev.type === "steer");
      expect(steer.length).toBe(1);
      expect(steer[0].data.text).toBe("[DYN]\n\n插入指令"); // buildDynamicContext stub 前缀注入后的最终 text
    }
  });

  it("settled 可重试错误：agent_retry(workbench-settled) → 退避 1500ms → 重放成功 → agent_retry_end", async () => {
    // settled error 由 provider 事件流在首轮 prompt 期间写入（prologue 每轮重置 lastSettledError，
    // 预置会被清空——通过 session.__entry 在 stub 内写入模拟真实时序）
    const world = makeWorld({ promptImpl: (session, _t, _o, attempt) => {
      if (attempt === 1) session.__entry.lastSettledError = new Error("connection error");
      return "ok";
    } });
    const { old, ts } = makePair(world);
    const { entry: e1, emitted: em1 } = makeSession(world.calls);
    const { entry: e2, emitted: em2 } = makeSession(world.calls);
    const p1 = old._promptEntry(e1, "hi");
    const p2 = ts._promptEntry(e2, "hi");
    await vi.advanceTimersByTimeAsync(SETTLED_AGENT_RETRY_DELAYS[0]! + 10);
    await Promise.all([p1, p2]);
    for (const emitted of [em1, em2]) {
      const retries = emitted.filter((ev: any) => ev.type === "agent_retry");
      expect(retries.length).toBe(1);
      expect(retries[0].data.source).toBe("workbench-settled");
      expect(retries[0].data.attempt).toBe(1);
      expect(retries[0].data.delayMs).toBe(1500);
      expect(retries[0].data.maxAttempts).toBe(3);
      const end = emitted.filter((ev: any) => ev.type === "agent_retry_end");
      expect(end.length).toBe(1);
      expect(end[0].data.message).toBe("模型连接已恢复");
    }
    expect(e1.lastSettledError).toBe(null);
    expect(e2.lastSettledError).toBe(null);
  });

  it("settled 不可重试（noRetry）：createSettledAgentError 包装后抛出且只投一次", async () => {
    // noRetry 错误由 prompt stub 执行期写入（prologue 每轮重置 lastSettledError，预置会被清空）；
    // createSettledAgentError 仅保留 message 重新归类，原始 code 不透传 → PI_SETTLED_ERROR
    const world = makeWorld({ promptImpl: (session) => {
      session.__entry.lastSettledError = Object.assign(new Error("首事件超时"), { code: "MODEL_TIMEOUT", noRetry: true });
      return "ok";
    } });
    const { old, ts } = makePair(world);
    const { entry: e1 } = makeSession(world.calls);
    const { entry: e2 } = makeSession(world.calls);
    await expect(old._promptEntry(e1, "hi")).rejects.toMatchObject({ code: "PI_SETTLED_ERROR", message: "首事件超时", noRetry: true });
    await expect(ts._promptEntry(e2, "hi")).rejects.toMatchObject({ code: "PI_SETTLED_ERROR", message: "首事件超时", noRetry: true });
    expect(world.calls.prompt.length).toBe(2); // 只投一次/侧
  });

  it("transport 重试：prompt 抛连接错误 → agent_retry(workbench-transport) → 退避 2000ms → 成功", async () => {
    const world = makeWorld({ promptImpl: (_s, _t, _o, attempt) => {
      if (attempt === 1) throw new Error("network error: connection refused");
      return "recovered";
    } });
    const { old, ts } = makePair(world);
    // 连接错误先走 canFallbackModel 分支；覆写 fallbackModel 返回 null 模拟候选穷尽，
    // 才会掉入 transport replay（否则 fallbackModel 依目录返回 prov-b/mdl-b 走模型回退）
    old.fallbackModel = async () => null;
    ts.fallbackModel = async () => null;
    const { entry: e1, emitted: em1 } = makeSession(world.calls);
    const { entry: e2, emitted: em2 } = makeSession(world.calls);
    const p1 = old._promptEntry(e1, "hi");
    const p2 = ts._promptEntry(e2, "hi");
    await vi.advanceTimersByTimeAsync(APP_PROMPT_RETRY_DELAYS[0]! + 10);
    await Promise.all([p1, p2]);
    for (const emitted of [em1, em2]) {
      const retries = emitted.filter((ev: any) => ev.type === "agent_retry");
      expect(retries.length).toBe(1);
      expect(retries[0].data.source).toBe("workbench-transport");
      expect(retries[0].data.attempt).toBe(1);
      expect(retries[0].data.delayMs).toBe(2000);
      expect(retries[0].data.maxAttempts).toBe(3);
      expect(emitted.filter((ev: any) => ev.type === "agent_retry_end").length).toBe(0); // transport 成功不发 end
    }
    expect(world.calls.prompt.length).toBe(4); // 双侧各两次
  });

  it("模型回退：retryable 且未收到首事件 → fallbackModel 切换 → agent_model_fallback → 重试成功", async () => {
    const world = makeWorld({ promptImpl: (_s, _t, _o, attempt) => {
      if (attempt === 1) throw new Error("network error: fetch failed");
      return "after-fallback";
    } });
    const { old, ts } = makePair(world);
    const { entry: e1, emitted: em1 } = makeSession(world.calls);
    const { entry: e2, emitted: em2 } = makeSession(world.calls);
    const p1 = old._promptEntry(e1, "hi");
    const p2 = ts._promptEntry(e2, "hi");
    await vi.advanceTimersByTimeAsync(APP_PROMPT_RETRY_DELAYS[0]! + 10);
    await Promise.all([p1, p2]);
    expect(world.calls.setModel.length).toBe(2); // 双侧各切换一次
    expect(e1.modelFallbackSpec).toBe("prov-b/mdl-b");
    expect(e2.modelFallbackSpec).toBe("prov-b/mdl-b");
    for (const emitted of [em1, em2]) {
      const fb = emitted.filter((ev: any) => ev.type === "agent_model_fallback");
      expect(fb.length).toBe(1);
      expect(fb[0].data.from).toBe("prov-x/mdl-1");
      expect(fb[0].data.to).toBe("prov-b/mdl-b");
      expect(fb[0].data.attempt).toBe(1);
    }
  });

  it("竞态兜底：'Agent is already processing' → steer 事件 + steer 二次投递后 break", async () => {
    const world = makeWorld({ promptImpl: (_s, _t, _o, attempt) => {
      if (attempt === 1) throw new Error("Agent is already processing");
      return "steered";
    } });
    const { old, ts } = makePair(world);
    const { entry: e1, emitted: em1 } = makeSession(world.calls);
    const { entry: e2, emitted: em2 } = makeSession(world.calls);
    await Promise.all([old._promptEntry(e1, "hi"), ts._promptEntry(e2, "hi")]);
    expect(world.calls.prompt.length).toBe(4); // 双侧各两次
    expect(world.calls.prompt.some((c: any[]) => c[3]?.streamingBehavior === "steer")).toBe(true);
    for (const emitted of [em1, em2]) {
      expect(emitted.filter((ev: any) => ev.type === "steer").length).toBe(1);
      expect(emitted.filter((ev: any) => ev.type === "agent_retry").length).toBe(0);
    }
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
    const { old, ts } = makePair(world);
    const { entry: e1, emitted: em1 } = makeSession(world.calls);
    const { entry: e2, emitted: em2 } = makeSession(world.calls);
    const p1 = old._promptEntry(e1, "hi");
    const p2 = ts._promptEntry(e2, "hi");
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all([p1, p2]);
    const continuationText = "上一个回合的模型连接中断了。请基于当前会话中已经完成的步骤和工具结果，从中断位置继续原任务；不要重复已经成功的副作用操作，完成后给出完整结果。";
    expect(world.calls.prompt.some((c: any[]) => c[2] === continuationText)).toBe(true);
    for (const emitted of [em1, em2]) {
      const retries = emitted.filter((ev: any) => ev.type === "agent_retry");
      expect(retries.length).toBe(1);
      expect(retries[0].data.source).toBe("workbench-continuation");
      expect(retries[0].data.delayMs).toBe(300);
      const end = emitted.filter((ev: any) => ev.type === "agent_retry_end");
      expect(end.length).toBe(1);
      expect(end[0].data.message).toBe("已从当前会话继续");
    }
  });

  it("completion nudge：toolStarted 且无 pendingCompletion → 短回合补声明 + suppressFinalText 恢复", async () => {
    const world = makeWorld({ promptImpl: (session) => { session.__entry.toolStarted = true; return "worked"; } });
    const { old, ts } = makePair(world);
    const { entry: e1, emitted: em1 } = makeSession(world.calls);
    const { entry: e2, emitted: em2 } = makeSession(world.calls);
    await Promise.all([old._promptEntry(e1, "hi"), ts._promptEntry(e2, "hi")]);
    expect(world.calls.runPrompt.length).toBe(4); // 双侧各两次（主链 + nudge）
    expect(world.calls.runPrompt[2]![1]).toEqual({ steer: false, metadata: { clientId: "c1", threadId: "t1", runId: null, purpose: "completion_nudge" } });
    expect(world.calls.prompt[2]![2]).toBe(COMPLETION_NUDGE_PROMPT);
    expect(e1.suppressFinalText).toBe(false);
    expect(e2.suppressFinalText).toBe(false);
    expect(e1.completionNudgeSent).toBe(true);
    expect(e2.completionNudgeSent).toBe(true);
    for (const emitted of [em1, em2]) {
      expect(emitted.filter((ev: any) => ev.type === "completion_nudge").length).toBe(1);
    }
  });

  it("pendingModelSpec 收尾：排队模型切换在本轮结束后应用并广播 model_switched(effective=now)", async () => {
    const world = makeWorld();
    const { old, ts } = makePair(world);
    const { entry: e1, emitted: em1 } = makeSession(world.calls, { pendingModelSpec: "prov-b/mdl-b" });
    const { entry: e2, emitted: em2 } = makeSession(world.calls, { pendingModelSpec: "prov-b/mdl-b" });
    await Promise.all([old._promptEntry(e1, "hi"), ts._promptEntry(e2, "hi")]);
    expect(world.calls.setModel.length).toBe(2);
    expect(e1.pendingModelSpec).toBe("");
    expect(e2.pendingModelSpec).toBe("");
    for (const emitted of [em1, em2]) {
      const switched = emitted.filter((ev: any) => ev.type === "model_switched");
      expect(switched.length).toBe(1);
      expect(switched[0].data.reason).toBe("queued");
      expect(switched[0].data.effective).toBe("now");
      expect(switched[0].data.to).toBe("prov-b/mdl-b");
    }
  });

  it("pendingModelSpec 失败：applyModelSpec 抛错 → model_switched(effective=failed) 带截断消息", async () => {
    const world = makeWorld();
    const { old, ts } = makePair(world);
    const boom = async () => { throw new Error("切换失败原因超长将被截断：" + "x".repeat(300)); };
    old.applyModelSpec = boom;
    ts.applyModelSpec = boom;
    const { entry: e1, emitted: em1 } = makeSession(world.calls, { pendingModelSpec: "bad/spec" });
    const { entry: e2, emitted: em2 } = makeSession(world.calls, { pendingModelSpec: "bad/spec" });
    await Promise.all([old._promptEntry(e1, "hi"), ts._promptEntry(e2, "hi")]);
    for (const emitted of [em1, em2]) {
      const switched = emitted.filter((ev: any) => ev.type === "model_switched");
      expect(switched.length).toBe(1);
      expect(switched[0].data.effective).toBe("failed");
      expect(switched[0].data.message.length).toBe(200);
    }
  });

  it("images 归一化：pi-ai ImageContent {type:image,data,mimeType}，mediaType 缺省 image/png", async () => {
    const world = makeWorld();
    const { old, ts } = makePair(world);
    const images = [{ data: "AAAA", mediaType: "image/webp" }, { data: "BBBB" }];
    const { entry: e1 } = makeSession(world.calls);
    const { entry: e2 } = makeSession(world.calls);
    await Promise.all([old._promptEntry(e1, "看图", images), ts._promptEntry(e2, "看图", images)]);
    expect(world.calls.prompt[0]![3]).toEqual({ images: [{ type: "image", data: "AAAA", mimeType: "image/webp" }, { type: "image", data: "BBBB", mimeType: "image/png" }] });
    expect(world.calls.prompt[1]![3]).toEqual(world.calls.prompt[0]![3]);
  });

  it("resource reload：lastResourceReloadAt 过期触发后台 reload，同轮去重且完成后清 promise", async () => {
    const world = makeWorld();
    const { old, ts } = makePair(world);
    const { entry: e1 } = makeSession(world.calls, { lastResourceReloadAt: Date.now() - RESOURCE_RELOAD_INTERVAL_MS - 1 });
    const { entry: e2 } = makeSession(world.calls, { lastResourceReloadAt: Date.now() - RESOURCE_RELOAD_INTERVAL_MS - 1 });
    await Promise.all([old._promptEntry(e1, "hi"), ts._promptEntry(e2, "hi")]);
    expect(world.calls.reload).toBe(2); // 双侧各一次
    expect(e1.resourceReloadPromise).toBe(null);
    expect(e2.resourceReloadPromise).toBe(null);
    // 二轮（未过期）不再触发
    await Promise.all([old._promptEntry(e1, "again"), ts._promptEntry(e2, "again")]);
    expect(world.calls.reload).toBe(2);
  });

  it("runPrompt 抛错（非 retryable 终态）：原样冒泡且 finally 仍复位 busy + 落 runtime_health", async () => {
    const world = makeWorld({ promptImpl: () => { throw new Error("invalid api key"); } });
    const { old, ts } = makePair(world);
    const { entry: e1 } = makeSession(world.calls);
    const { entry: e2 } = makeSession(world.calls);
    const runContext = { runId: "run-err" };
    await expect(old._promptEntry(e1, "hi", [], "low", [], runContext)).rejects.toThrow("invalid api key");
    await expect(ts._promptEntry(e2, "hi", [], "low", [], runContext)).rejects.toThrow("invalid api key");
    expect(e1.busy).toBe(false);
    expect(e2.busy).toBe(false);
    expect(e1.activeRunId).toBe(null);
    expect(e2.activeRunId).toBe(null);
    const healthEvents = world.calls.recordRunEvent.filter((r: any[]) => r[1] === "runtime_health");
    expect(healthEvents.length).toBe(2);
    expect(healthEvents[0]![0]).toBe("run-err");
  });
});
