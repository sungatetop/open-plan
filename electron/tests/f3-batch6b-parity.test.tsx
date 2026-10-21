// @vitest-environment jsdom
/**
 * F3 批6b 对拍：ChatPanel 事件状态机（handleEvent + 流式缓冲回调族）。
 *
 * 覆盖范围（旧源码行号）：
 *   - 流式缓冲回调 patch/flushToolOutput/queueToolOutput/rememberDisplayedText/
 *     cancelTextReveal/enqueueTextReveal/finishTextReveal/scheduleFlush（1233-1445）
 *   - acceptSystemEvent（1843-1854）+ handleEvent 全 switch（1856-2790）
 *   - flushNow/pushSystem/upsertRunSummary/finalizeStopped（2800-2877，工厂内转录）
 *
 * 对拍口径（双侧同流，批6b 特有）：
 *   - 旧侧：真实挂载 client ChatPanel（jsdom）→ window.__oawChatEvents.handle(ev) 喂事件
 *     （与真实 SSE 同一条入口，经「当前 Run 归属」过滤），用 React fiber 走链读 useState
 *     全量快照（读状态本体，比 DOM 投影更精确）。
 *   - 新侧：createChatEventMachine + 模拟 React 批处理的 harness——getter 读 committed
 *     （等价旧渲染闭包「最近一次已提交渲染值」），setter 写 pending，feed = handleEvent
 *     + commit 折叠（等价 React 在事件处理后 flush）。组件级回调
 *     （enqueueExecutionEvent/pushSystemNote/rememberModel/applyModel/setAgentPhase 包装器）
 *     由 harness 逐行复刻旧组件接线（appendExecutionFlowEvent 已 F1 对拍背书）。
 *   - 确定性：fake timers 冻结 Date/performance（BASE=1_700_000_000_000，createdAt/at/
 *     elapsedMs 双侧一致）；rAF 手动队列 flushFrames 驱动（两侧共用同一全局队列与时钟，
 *     揭示节奏逐帧一致）；EventSource/fetch 假类静默 SSE effect。
 *   - 归一化：newId 生成的 /^m\d+$/ id 按两侧各自首现序映射为 #n 后深比较。
 *
 * 未覆盖（说明）：
 *   - replayRecover 缓冲冲刷：旧侧 replayProbeRef 不经 window 钩子暴露，无法从外部置
 *     pending 进入缓冲态；flag 机制已由 f1-feature-flags 对拍，门闩逐行转录，留待
 *     批6d 全 DOM 对拍补验。
 *   - agent_error 的 abort 语义（stoppingRef/stopRequestedRef 命中分支）：ref 置位由
 *     组件 stop() 接线（6d），外部不可达；aborted 事件路径（finalizeStopped）已覆盖。
 *   - flushQueued(true) 调用：旧侧为组件内部函数，无观察点；仅作新侧 spy 记录不比较。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const BASE = 1_700_000_000_000;
const THREAD = "thr-parity";
const WORKSPACE = "D:/ws/parity";

/* ------------------------- stubs（必须先于动态 import 装配） ------------------------- */

// rAF 手动队列：Map 保序 + 递增 id（cancel 语义）；flushFrames 每轮推进 32ms（与
// reveal 的 32ms 节流阈值对齐），上限 240 轮防死循环。
const frameQueue = new Map<number, FrameRequestCallback>();
let frameIdSeq = 0;
window.requestAnimationFrame = ((fn: FrameRequestCallback) => {
  frameIdSeq += 1;
  frameQueue.set(frameIdSeq, fn);
  return frameIdSeq;
}) as typeof requestAnimationFrame;
window.cancelAnimationFrame = ((id: number) => {
  frameQueue.delete(id);
}) as typeof cancelAnimationFrame;

function flushFrames(maxRounds = 240): void {
  let rounds = 0;
  while (frameQueue.size && rounds < maxRounds) {
    rounds += 1;
    const entries = [...frameQueue.entries()];
    frameQueue.clear();
    vi.advanceTimersByTime(32);
    for (const [, fn] of entries) fn(performance.now());
  }
  if (frameQueue.size) throw new Error(`rAF 队列 ${frameQueue.size} 个回调在 ${maxRounds} 轮内未排空`);
}

// jsdom 无滚动 API：ChatPanel 的跟随滚动 effect（scrollTo/scrollIntoView）静默化
(Element.prototype as unknown as Record<string, unknown>).scrollTo = () => {};
(Element.prototype as unknown as Record<string, unknown>).scrollIntoView = () => {};

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  onopen: unknown = null;
  onmessage: unknown = null;
  onerror: unknown = null;
  private listeners = new Map<string, Array<(e: unknown) => void>>();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: unknown) => void): void {
    const list = this.listeners.get(type) || [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  emit(type: string): void {
    for (const fn of this.listeners.get(type) || []) fn({});
  }
  close(): void {
    this.closed = true;
  }
}
window.EventSource = FakeEventSource as unknown as typeof EventSource;

// fetch 路由（/api/status 供 runtimeFlags 场景；其余 404 = 双侧基线一致）
const fetchCalls: string[] = [];
let statusReply: Record<string, unknown> = {};
window.fetch = (async (input: unknown) => {
  const url = typeof input === "string" ? input : String((input as { url?: string } | null)?.url ?? input);
  fetchCalls.push(url);
  if (url.includes("/api/status")) {
    return { ok: true, json: async () => statusReply } as unknown as Response;
  }
  return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
}) as typeof fetch;

/* ------------------------------ 双侧模块（stub 后加载） ------------------------------ */

const TsMachine = await import("../src/renderer/features/chat/event-machine");
const TsFlags = await import("../src/renderer/lib/feature-flags");
const TsShared = await import("../src/renderer/lib/chat-shared");
const TsEventDisplay = await import("../src/renderer/lib/event-display");
const JsPanel = await import("../../client/src/components/ChatPanel.jsx");
const JsFlags = await import("../../client/src/feature-flags.js");
type ChatEventMachineDeps = import("../src/renderer/features/chat/event-machine").ChatEventMachineDeps;
type ChatMachineRefs = import("../src/renderer/features/chat/event-machine").ChatMachineRefs;
type ChatRunState = import("../src/renderer/features/chat/event-machine").ChatRunState;
type ChatEventInput = import("../src/renderer/features/chat/event-machine").ChatEventInput;
type FlowEvent = import("../src/renderer/lib/chat-shared").FlowEvent;

// @ts-expect-error 旧 JS 模块；组件走 Record 宽容视图（JS 边界无静态约束）
const ChatPanelJs: React.ComponentType<Record<string, unknown>> = JsPanel.default;
const { createChatEventMachine } = TsMachine;
const { appendExecutionFlowEvent } = TsShared;

type Mock = ReturnType<typeof vi.fn>;

interface OldStates {
  [key: string]: unknown;
}

/* --------------------------- 旧侧 fiber 走链（useState 快照） --------------------------- */

interface FiberLike {
  tag: number;
  child: FiberLike | null;
  sibling: FiberLike | null;
  memoizedState: unknown;
}

function findPanelFiber(host: HTMLElement): FiberLike | null {
  const key = Object.keys(host).find((k) => k.startsWith("__reactContainer$"));
  if (!key) return null;
  // markContainerAsRoot 存的是 HostRoot fiber 本身（root.current），不是 FiberRootNode
  const rootFiber = (host as unknown as Record<string, FiberLike>)[key];
  if (!rootFiber) return null;
  const queue: FiberLike[] = [rootFiber];
  while (queue.length) {
    const fiber = queue.shift()!;
    const ms = fiber.memoizedState as { next?: unknown } | null;
    // ChatPanel 是 forwardRef（tag 11）；首个带 hook 链的函数组件 fiber 即目标
    if ((fiber.tag === 0 || fiber.tag === 11) && ms && typeof ms === "object" && "next" in ms) return fiber;
    if (fiber.child) queue.push(fiber.child);
    if (fiber.sibling) queue.push(fiber.sibling);
  }
  return null;
}

function readUseStates(fiber: FiberLike): unknown[] {
  interface HookLike { memoizedState: unknown; queue?: unknown; next: HookLike | null }
  const out: unknown[] = [];
  let hook = fiber.memoizedState as HookLike | null;
  while (hook) {
    if (hook.queue) out.push(hook.memoizedState);
    hook = hook.next;
  }
  return out;
}

/**
 * useState 序数按 ChatPanel.jsx 声明序（532-728）：
 *   0 messages / 7 busy / 8 stopping / 9 connected / 11 model / 12 modelVision /
 *   13 modelMsg / 14 lastMapVisual / 15 mapVisualHint / 16 pendingModel /
 *   21 editMode / 27 recentModels / 31 agentPhase；
 * 尾部（runState→todoItems→executionEvents→showScrollToBottom→systemNotes→
 * queuedMessages→injectedContext→connectionNotice）按谓词定位（runState = 同时含
 * status+artifacts+mode+references 的对象，其后连续 7 个）。
 */
function readOldStates(host: HTMLElement): OldStates {
  const fiber = findPanelFiber(host);
  if (!fiber) throw new Error("ChatPanel fiber 未找到（挂载或走链失败）");
  const states = readUseStates(fiber);
  const pick = (i: number) => states[i];
  const runIdx = states.findIndex((s) => s && typeof s === "object" && !Array.isArray(s)
    && "status" in s && "artifacts" in s && "mode" in s && "references" in s);
  if (runIdx < 0) throw new Error("runState hook 未定位到（谓词未命中）");
  return {
    messages: pick(0) as unknown[],
    busy: pick(7) as boolean,
    stopping: pick(8) as boolean,
    connected: pick(9) as boolean,
    model: pick(11) as string,
    modelVision: pick(12) as boolean,
    modelMsg: pick(13) as string,
    lastMapVisual: pick(14),
    mapVisualHint: pick(15) as string,
    pendingModel: pick(16) as string,
    editMode: pick(21) as string,
    agentPhase: pick(31) as string,
    recentModels: pick(27) as string[],
    runState: states[runIdx],
    todoItems: states[runIdx + 1] as unknown[],
    executionEvents: states[runIdx + 2] as unknown[],
    systemNotes: states[runIdx + 4] as unknown[],
    queuedMessages: states[runIdx + 5] as unknown[],
    connectionNotice: states[runIdx + 7],
  };
}

/* --------------------------------- 新侧 harness --------------------------------- */

const COMPARE_KEYS = [
  "messages", "busy", "stopping", "connected", "model", "modelVision", "modelMsg",
  "lastMapVisual", "mapVisualHint", "pendingModel", "editMode", "agentPhase",
  "recentModels", "runState", "todoItems", "executionEvents", "systemNotes",
  "queuedMessages", "connectionNotice",
] as const;

type StateKey = (typeof COMPARE_KEYS)[number];
type HarnessState = Record<StateKey, unknown>;

interface Harness {
  handleEvent: (ev: unknown) => void;
  feed: (ev: unknown) => void;
  commit: () => void;
  refs: ChatMachineRefs;
  spies: Record<string, Mock>;
  snapshot: () => HarnessState;
}

function createHarness(
  initial: HarnessState,
  models: Array<{ id?: string; vision?: boolean }>,
  forcedMode: string | null = null,
): Harness {
  let committed: HarnessState = { ...initial };
  let pending: Partial<HarnessState> | null = null;

  const setState = (key: StateKey, value: unknown): void => {
    pending = { ...(pending || committed), [key]: value } as Partial<HarnessState>;
  };
  // React 语义：函数式更新（setMessages(fn)）收到的是「已排队后的最新值」，
  // 不是最近一次已提交值——否则同一批次内多次 patch（rAF 多轮 reveal / 连续
  // runState 更新）会各自以 committed 为 base 互相覆盖，丢掉前序更新。
  const readLatest = (key: StateKey): unknown => {
    if (pending && key in pending) return (pending as Record<string, unknown>)[key];
    return committed[key];
  };

  const refs: ChatMachineRefs = {
    mountedRef: { current: true },
    activeRunIdRef: { current: null },
    runInProgressRef: { current: false },
    agentEventAtRef: { current: 0 },
    assistantIdRef: { current: null },
    lastAssistantIdRef: { current: null },
    streamingMsgIdRef: { current: null },
    streamBufRef: { current: null },
    rafRef: { current: null },
    toolOutputQueueRef: { current: new Map() },
    toolOutputRafRef: { current: null },
    textRevealRef: { current: null },
    textRevealRafRef: { current: null },
    displayedTextRef: { current: new Map() },
    stoppingRef: { current: false },
    stopRequestedRef: { current: false },
    roundStoppedRef: { current: false },
    stopConfirmTimerRef: { current: null },
    agentErrorRef: { current: false },
    systemEventKeysRef: { current: new Set() },
    replayProbeRef: { current: { pending: false, thread: null } },
    replayBufferRef: { current: [] },
    runtimeConnectingEventRef: { current: null },
    connectionTimerRef: { current: null },
  };

  const spies: Record<string, Mock> = {
    onFileChanged: vi.fn(),
    onMapAction: vi.fn(),
    onRunFinished: vi.fn(),
    onAgentEnd: vi.fn(),
    onBrowserActivity: vi.fn(),
    onModelChange: vi.fn(),
    flushQueued: vi.fn(),
  };

  // 组件级回调复刻（旧 697-706 enqueueExecutionEvent + 687-696 replaceExecutionEvents）
  const executionQueue: unknown[] = [];
  const executionEventsRef = { current: [...(committed.executionEvents as unknown[])] };
  let executionTimer: number | null = null;
  const enqueueExecutionEvent = (event: unknown): void => {
    executionQueue.push(event);
    if (executionTimer !== null) return;
    executionTimer = window.setTimeout(() => {
      executionTimer = null;
      let next = executionEventsRef.current;
      for (const item of executionQueue.splice(0)) next = appendExecutionFlowEvent(next as never, item as never);
      executionEventsRef.current = next as unknown[];
      setState("executionEvents", next);
    }, 80);
  };

  // 旧 711-723 pushSystemNote
  const pushSystemNote = (note: Record<string, unknown>): void => {
    const key = String(note?.key || "").trim();
    if (!key) return;
    setState("systemNotes", (() => {
      const list = [...(readLatest("systemNotes") as Array<Record<string, unknown>>)];
      const index = list.findIndex((item) => item.key === key);
      if (index >= 0) {
        const next = [...list];
        next[index] = { ...next[index]!, ...note, count: Number(next[index]!.count || 1) + 1 };
        return next;
      }
      return [...list, { ...note, count: 1 }].slice(-40);
    })());
  };

  // 旧 832-839 rememberModel（MAX_RECENT_MODELS=5）
  const rememberModel = (id: string): void => {
    if (!id) return;
    setState("recentModels", (() => {
      const list = readLatest("recentModels") as string[];
      return [id, ...list.filter((item) => item !== id)].slice(0, 5);
    })());
  };

  // 旧 1480-1484 applyModel（列表恒为挂载期 models）
  const applyModel = (id: string): void => {
    const m = models.find((x) => x.id === id);
    setState("modelVision", !!m?.vision);
  };

  // 旧 610-615 setAgentPhase 包装器（Object.is 守卫 + agentPhaseRef 同步 + 函数式支持）
  const agentPhaseRef = { current: committed.agentPhase as string };
  const setAgentPhase = (next: string | ((prev: string) => string)): void => {
    const value = typeof next === "function" ? next(agentPhaseRef.current) : next;
    if (Object.is(agentPhaseRef.current, value)) return;
    agentPhaseRef.current = value;
    setState("agentPhase", value);
  };

  const deps: ChatEventMachineDeps = {
    refs,
    getBusy: () => committed.busy as boolean,
    getRunState: () => committed.runState as ChatRunState,
    getModel: () => committed.model as string,
    getForcedMode: () => forcedMode,
    getThreadId: () => THREAD,
    getWorkspace: () => WORKSPACE,
    setMessages: (next) => setState("messages", typeof next === "function" ? (next as (prev: unknown[]) => unknown[])(readLatest("messages") as unknown[]) : next),
    setBusy: (v) => setState("busy", v),
    setRunState: (updater) => setState("runState", updater(readLatest("runState") as ChatRunState)),
    setAgentPhase,
    setConnected: (v) => setState("connected", v),
    setModelMsg: (v) => setState("modelMsg", v),
    setTodoItems: (v) => setState("todoItems", v),
    setEditMode: (v) => setState("editMode", v),
    setStopping: (v) => setState("stopping", v),
    setPendingModel: (v) => setState("pendingModel", v),
    setModel: (v) => setState("model", v),
    setLastMapVisual: (v) => setState("lastMapVisual", v),
    setMapVisualHint: (v) => setState("mapVisualHint", v),
    setConnectionNotice: (v) => setState("connectionNotice", v),
    enqueueExecutionEvent: enqueueExecutionEvent as (event: FlowEvent) => void,
    pushSystemNote,
    clearSystemNotes: () => setState("systemNotes", []),
    rememberModel,
    applyModel,
    flushQueued: (force?: boolean) => spies.flushQueued!(force),
    onFileChanged: (files) => spies.onFileChanged!(files),
    onMapAction: (data) => spies.onMapAction!(data),
    onRunFinished: (data) => spies.onRunFinished!(data),
    onAgentEnd: () => spies.onAgentEnd!(),
    onBrowserActivity: () => spies.onBrowserActivity!(),
    onModelChange: (id) => spies.onModelChange!(id),
  };

  const machine = createChatEventMachine(deps);
  return {
    handleEvent: (ev) => machine.handleEvent(ev as ChatEventInput),
    feed: (ev) => {
      machine.handleEvent(ev as ChatEventInput);
      if (pending) {
        committed = { ...committed, ...pending };
        pending = null;
      }
    },
    commit: () => {
      if (pending) {
        committed = { ...committed, ...pending };
        pending = null;
      }
    },
    refs,
    spies,
    snapshot: () => ({ ...committed }),
  };
}

/* --------------------------------- 挂载与驱动 --------------------------------- */

const MODELS = [
  { id: "deepseek-chat", provider: "deepseek", name: "DeepSeek Chat", contextWindow: 64000 },
  { id: "deepseek-reasoner", provider: "deepseek", name: "DeepSeek Reasoner", contextWindow: 64000, vision: true },
];

interface PanelPair {
  oldHost: HTMLElement;
  oldSpies: Record<string, Mock>;
  oldSpiesOffset: number;
  harness: Harness;
  root: Root;
}

function makeOldProps(spies: Record<string, Mock>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clientId: "parity-client",
    threadId: THREAD,
    workspace: WORKSPACE,
    models: MODELS,
    onFileChanged: spies.onFileChanged,
    onMapAction: spies.onMapAction,
    onRunFinished: spies.onRunFinished,
    onAgentEnd: spies.onAgentEnd,
    onBrowserActivity: spies.onBrowserActivity,
    onModelChange: spies.onModelChange,
    ...extra,
  };
}

async function mountPair(extra: Record<string, unknown> = {}, harnessOverrides: Partial<HarnessState> = {}): Promise<PanelPair> {
  const oldSpies: Record<string, Mock> = {
    onFileChanged: vi.fn(),
    onMapAction: vi.fn(),
    onRunFinished: vi.fn(),
    onAgentEnd: vi.fn(),
    onBrowserActivity: vi.fn(),
    onModelChange: vi.fn(),
  };

  const host = document.createElement("div");
  document.body.appendChild(host);
  let root: Root | null = null;
  act(() => {
    root = createRoot(host);
    root.render(React.createElement(ChatPanelJs, makeOldProps(oldSpies, extra)));
  });
  await act(async () => { await Promise.resolve(); });
  if (!root) throw new Error("mount 失败");

  const base = readOldStates(host);
  const initial = {} as HarnessState;
  for (const key of COMPARE_KEYS) initial[key] = base[key];
  Object.assign(initial, harnessOverrides);
  const harness = createHarness(
    initial,
    MODELS,
    typeof extra.forcedMode === "string" ? extra.forcedMode : null,
  );

  return {
    oldHost: host,
    oldSpies,
    oldSpiesOffset: oldSpies.onModelChange!.mock.calls.length,
    harness,
    root,
  };
}

async function unmountPair(pair: PanelPair): Promise<void> {
  await act(async () => { pair.root.unmount(); });
  pair.oldHost.remove();
}

async function feedPair(pair: PanelPair, events: Array<Record<string, unknown>>): Promise<void> {
  for (const ev of events) {
    act(() => {
      (window as unknown as { __oawChatEvents?: { handle: (e: unknown) => void } }).__oawChatEvents?.handle(ev);
    });
    pair.harness.feed(ev);
  }
  await settlePair(pair);
}

/**
 * 收尾仪式（两侧统一）：
 *   1. advanceTimersByTime(6500)——执行流 80ms 批、model_switched 6000/4000ms 清理、
 *      connectionTimer 3500ms 恢复清理全部到期（不触碰 SSE 50s watchdog）；
 *   2. flushFrames——揭示/流式缓冲/工具输出 rAF 链排空（每轮 +32ms）；
 *   3. act + commit 折叠 pending。
 */
async function settlePair(pair: PanelPair): Promise<void> {
  // 服务端心跳保真：真实 SSE 每 5s 一帧 heartbeat（刷新旧组件 connect 闭包内的
  // lastSignalAt）。不发心跳时多轮 settlePair 累计虚拟时钟会触发 watchdog
  // （静默 >20s 强制重连 → setConnected(false)），而 SSE 重连属组件级接线（6c），
  // 不在 6b 事件状态机对拍口径内。
  for (const es of FakeEventSource.instances) {
    if (!es.closed) es.emit("heartbeat");
  }
  await act(async () => { vi.advanceTimersByTime(6500); });
  pair.harness.commit();
  act(() => { flushFrames(); });
  pair.harness.commit();
  await act(async () => {});
  pair.harness.commit();
  act(() => { flushFrames(); });
  pair.harness.commit();
  await act(async () => {});
  pair.harness.commit();
}

/* ------------------------------- 归一化与断言 ------------------------------- */

function normalizeDeep(value: unknown, map: Map<string, string>): unknown {
  if (typeof value === "string" && /^m\d+$/.test(value)) {
    if (!map.has(value)) map.set(value, `#${map.size + 1}`);
    return map.get(value);
  }
  if (Array.isArray(value)) return value.map((item) => normalizeDeep(item, map));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = normalizeDeep((value as Record<string, unknown>)[key], map);
    }
    return out;
  }
  return value;
}

function expectParity(pair: PanelPair): void {
  const oldStates = readOldStates(pair.oldHost);
  const newStates = pair.harness.snapshot();
  const mapA = new Map<string, string>();
  const mapB = new Map<string, string>();
  for (const key of COMPARE_KEYS) {
    const a = normalizeDeep(oldStates[key], mapA);
    const b = normalizeDeep(newStates[key], mapB);
    expect(b, `状态键「${key}」双侧不一致`).toEqual(a);
  }
  // props spy 调用序列（onModelChange：旧侧挂载 init effect 会先做一次初始选择，
  // 记录 offset 后从旧侧序列截去，再与新侧全量比较——过滤的始终是旧侧挂载期调用）
  expect(pair.harness.spies.onFileChanged!.mock.calls).toEqual(pair.oldSpies.onFileChanged!.mock.calls);
  expect(pair.harness.spies.onMapAction!.mock.calls).toEqual(pair.oldSpies.onMapAction!.mock.calls);
  expect(pair.harness.spies.onRunFinished!.mock.calls).toEqual(pair.oldSpies.onRunFinished!.mock.calls);
  expect(pair.harness.spies.onAgentEnd!.mock.calls).toEqual(pair.oldSpies.onAgentEnd!.mock.calls);
  expect(pair.harness.spies.onBrowserActivity!.mock.calls).toEqual(pair.oldSpies.onBrowserActivity!.mock.calls);
  expect(pair.harness.spies.onModelChange!.mock.calls)
    .toEqual(pair.oldSpies.onModelChange!.mock.calls.slice(pair.oldSpiesOffset));
}

async function initFlags(runtimeFlags: Record<string, unknown>): Promise<void> {
  statusReply = { runtimeFlags };
  await Promise.all([JsFlags.initRuntimeFlags(), TsFlags.initRuntimeFlags()]);
}

/* ---------------------------------- 事件样本 ---------------------------------- */

const RUN_ADMITTED = { type: "run_admitted", data: { runId: "run-1" }, id: 1, at: "2026-10-21T09:00:00.000Z" };
// 进入运行态（token/tool 需 busy || LIVE_RUN_STATUSES）：agent_retry 置 busy(true)+status running
const AGENT_RETRY_BUSY = { type: "agent_retry", data: { attempt: 1, maxAttempts: 3, category: "network" }, id: 2, at: "2026-10-21T09:00:01.000Z" };

/* ---------------------------------- 对拍用例 ---------------------------------- */

beforeEach(() => {
  localStorage.clear();
  frameQueue.clear();
  FakeEventSource.instances.length = 0;
  statusReply = {};
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
  vi.setSystemTime(BASE);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("F3 批6b：ChatPanel 事件状态机与 client/ChatPanel.jsx 对拍", () => {
  it("会话握手与模型恢复：runtime_connecting 双变体 / init_failed / stream_resync / connected（模型恢复+fallback 文案）/ admit 链", async () => {
    const pair = await mountPair();
    try {
      await feedPair(pair, [
        { type: "runtime_connecting", data: {}, id: 1, at: "2026-10-21T09:00:00.000Z" },
        { type: "runtime_connecting", data: { message: "正在拉起 Pi 运行时" }, id: 2, at: "2026-10-21T09:00:00.100Z" },
        { type: "stream_resync", data: {}, id: 3, at: "2026-10-21T09:00:00.200Z" },
        { type: "connected", data: {}, id: 4, at: "2026-10-21T09:00:00.300Z" },
        { type: "run_admitting", data: {}, id: 5, at: "2026-10-21T09:00:00.400Z" },
        { type: "run_admitted", data: { runId: "run-1" }, id: 6, at: "2026-10-21T09:00:00.500Z" },
        { type: "model_request_started", data: {}, id: 7, at: "2026-10-21T09:00:00.600Z" },
        { type: "agent_started", data: {}, id: 8, at: "2026-10-21T09:00:00.700Z" },
        { type: "turn_started", data: {}, id: 9, at: "2026-10-21T09:00:00.800Z" },
      ]);
      // 系统提示先堆一条再被 run_admitted 清空（clearSystemNotes 覆盖）
      await feedPair(pair, [
        { type: "context_compacting", data: {}, id: 10, at: "2026-10-21T09:00:00.900Z" },
        { type: "run_admitted", data: { runId: "run-2" }, id: 11, at: "2026-10-21T09:00:01.000Z" },
      ]);
      expectParity(pair);

      // runtime_init_failed：busy 解除 + 4200ms 后 modelMsg 清空（ritual 6500ms 内触发）
      await feedPair(pair, [
        { type: "agent_started", data: {}, id: 12, at: "2026-10-21T09:00:01.100Z" },
        { type: "runtime_init_failed", data: { message: "模型凭据校验失败" }, id: 13, at: "2026-10-21T09:00:01.200Z" },
      ]);
      expectParity(pair);
      // connected：模型切换（基线 deepseek-chat → reasoner）+ fallback 文案 + 3600ms 清理
      await feedPair(pair, [
        { type: "connected", data: { model: "deepseek-reasoner", modelFallbackFrom: "deepseek-chat" }, id: 14, at: "2026-10-21T09:00:01.300Z" },
      ]);
      expectParity(pair);
      // connected：同模型无操作
      await feedPair(pair, [
        { type: "connected", data: { model: "deepseek-reasoner" }, id: 15, at: "2026-10-21T09:00:01.400Z" },
      ]);
      expectParity(pair);
    } finally {
      await unmountPair(pair);
    }
  });

  it("正文与思考流式 + message 边界族：token 揭示 / thinking 缓冲 / message_start 边界 / text_boundary / agent_queue_update", async () => {
    const pair = await mountPair();
    try {
      await feedPair(pair, [RUN_ADMITTED, AGENT_RETRY_BUSY]);
      expectParity(pair);
      await feedPair(pair, [
        { type: "message_start", data: { role: "assistant", messageId: "msg-1" }, id: 3, at: "2026-10-21T09:00:02.000Z" },
        { type: "thinking", data: { text: "先分析数据结构。" }, id: 4, at: "2026-10-21T09:00:02.100Z" },
        { type: "thinking", data: { text: "再确定输出格式。" }, id: 5, at: "2026-10-21T09:00:02.200Z" },
        { type: "token", data: { text: "根据" }, id: 6, at: "2026-10-21T09:00:02.300Z" },
        { type: "token", data: { text: "现有数据，" }, id: 7, at: "2026-10-21T09:00:02.400Z" },
        { type: "token", data: { text: "客流呈上升趋势。" }, id: 8, at: "2026-10-21T09:00:02.500Z" },
        { type: "text_boundary", data: { phase: "start" }, id: 9, at: "2026-10-21T09:00:02.600Z" },
        { type: "tool_call_progress", data: { name: "read_file" }, id: 10, at: "2026-10-21T09:00:02.700Z" },
        { type: "agent_queue_update", data: { steering: true }, id: 11, at: "2026-10-21T09:00:02.800Z" },
        { type: "agent_turn_end", data: {}, id: 12, at: "2026-10-21T09:00:02.900Z" },
        { type: "message_end", data: {}, id: 13, at: "2026-10-21T09:00:03.000Z" },
      ]);
      expectParity(pair);
    } finally {
      await unmountPair(pair);
    }
  });

  it("工具流：tool_start（browser_open 拉起侧栏回调）/ tool_output 拼接与去重 / tool_output_delta / tool_end", async () => {
    const pair = await mountPair();
    try {
      await feedPair(pair, [RUN_ADMITTED, AGENT_RETRY_BUSY]);
      await feedPair(pair, [
        { type: "tool_start", data: { toolCallId: "tc-1", name: "browser_open", args: { url: "https://example.com" } }, id: 3, at: "2026-10-21T09:00:03.000Z" },
        { type: "tool_output", data: { toolCallId: "tc-1", output: "页面已打开\n" }, id: 4, at: "2026-10-21T09:00:03.100Z" },
        { type: "tool_output", data: { toolCallId: "tc-1", output: "标题：Example\n" }, id: 5, at: "2026-10-21T09:00:03.200Z" },
        { type: "tool_output_delta", data: { toolCallId: "tc-1", output: "更多内容" }, id: 6, at: "2026-10-21T09:00:03.300Z" },
        { type: "tool_end", data: { toolCallId: "tc-1", status: "ok" }, id: 7, at: "2026-10-21T09:00:03.400Z" },
      ]);
      expectParity(pair);
      // 第二个工具：无 toolCallId 依附最后一个未完成工具 + replace 语义
      await feedPair(pair, [
        { type: "tool_start", data: { toolCallId: "tc-2", name: "write_file" }, id: 8, at: "2026-10-21T09:00:03.500Z" },
        { type: "tool_output", data: { toolCallId: "tc-2", output: "旧输出", replace: true }, id: 9, at: "2026-10-21T09:00:03.600Z" },
        { type: "tool_end", data: { toolCallId: "tc-2", status: "ok" }, id: 10, at: "2026-10-21T09:00:03.700Z" },
      ]);
      expectParity(pair);
    } finally {
      await unmountPair(pair);
    }
  });

  it("子代理族：start/planned/started/update(delta 转录)/progress/tool/end/result/verified/closed", async () => {
    const pair = await mountPair();
    try {
      await feedPair(pair, [RUN_ADMITTED, AGENT_RETRY_BUSY]);
      await feedPair(pair, [
        { type: "subagent_start", data: { childId: "sub-1", role: "scout", task: "检索既有规划文本" }, id: 3, at: "2026-10-21T09:00:04.000Z" },
        { type: "subagent_planned", data: { childId: "sub-2", role: "analyst", task: "对比客流口径" }, id: 4, at: "2026-10-21T09:00:04.100Z" },
        { type: "subagent_started", data: { childId: "sub-2" }, id: 5, at: "2026-10-21T09:00:04.200Z" },
        { type: "subagent_update", data: { childId: "sub-1", status: "running", activity: "检索中", delta: { kind: "text", text: "找到 3 份相关文档" } }, id: 6, at: "2026-10-21T09:00:04.300Z" },
        { type: "subagent_progress", data: { childId: "sub-1", preview: "规划文本摘录…" }, id: 7, at: "2026-10-21T09:00:04.400Z" },
        { type: "subagent_tool", data: { childId: "sub-1", name: "read_file", status: "done" }, id: 8, at: "2026-10-21T09:00:04.500Z" },
        { type: "subagent_end", data: { childId: "sub-1", status: "completed", summary: "检索完成" }, id: 9, at: "2026-10-21T09:00:04.600Z" },
        { type: "subagent_result", data: { childId: "sub-2", status: "completed", summary: "口径一致" }, id: 10, at: "2026-10-21T09:00:04.700Z" },
        { type: "subagent_verified", data: { childId: "sub-2", status: "passed" }, id: 11, at: "2026-10-21T09:00:04.800Z" },
        { type: "subagent_closed", data: { childId: "sub-2" }, id: 12, at: "2026-10-21T09:00:04.900Z" },
      ]);
      expectParity(pair);
    } finally {
      await unmountPair(pair);
    }
  });

  it("流水线族：pipeline_started / stage_started / stage_finished / finished", async () => {
    const pair = await mountPair();
    try {
      await feedPair(pair, [RUN_ADMITTED, AGENT_RETRY_BUSY]);
      await feedPair(pair, [
        { type: "pipeline_started", data: { stages: ["检索", "分析"] }, id: 3, at: "2026-10-21T09:00:05.000Z" },
        { type: "pipeline_stage_started", data: { stage: "检索", index: 0 }, id: 4, at: "2026-10-21T09:00:05.100Z" },
        { type: "pipeline_stage_finished", data: { stage: "检索", index: 0, status: "ok" }, id: 5, at: "2026-10-21T09:00:05.200Z" },
        { type: "pipeline_finished", data: { status: "completed" }, id: 6, at: "2026-10-21T09:00:05.300Z" },
      ]);
      expectParity(pair);
    } finally {
      await unmountPair(pair);
    }
  });

  it("ask_user 与工具审批：busy/等待回答 / 超时兜底窗口 / approval_request / resolved", async () => {
    const pair = await mountPair();
    try {
      await feedPair(pair, [RUN_ADMITTED, AGENT_RETRY_BUSY]);
      await feedPair(pair, [
        { type: "ask_user", data: { runId: "run-1", question: "采用哪个口径？", options: ["居住人口", "就业人口"], expiresAt: BASE + 300_000 }, id: 3, at: "2026-10-21T09:00:06.000Z" },
      ]);
      expectParity(pair);
      await feedPair(pair, [
        { type: "tool_approval_request", data: { runId: "run-1", id: "ap-1", tool: "write_file", target: "报告.docx" }, id: 4, at: "2026-10-21T09:00:06.100Z" },
        { type: "tool_approval_resolved", data: { id: "ap-1", decision: "allow" }, id: 5, at: "2026-10-21T09:00:06.200Z" },
      ]);
      expectParity(pair);
    } finally {
      await unmountPair(pair);
    }
  });

  it("小事件族：stats（usage/cost）/ thinking_level / agent_queued / todo_updated", async () => {
    const pair = await mountPair();
    try {
      await feedPair(pair, [RUN_ADMITTED, AGENT_RETRY_BUSY]);
      await feedPair(pair, [
        { type: "stats", data: { tokens: { input: 1200, output: 340, cacheRead: 100 }, cost: 0.02 }, id: 3, at: "2026-10-21T09:00:07.000Z" },
        { type: "thinking_level", data: { effective: "high" }, id: 4, at: "2026-10-21T09:00:07.100Z" },
        { type: "agent_queued", data: { position: 2 }, id: 5, at: "2026-10-21T09:00:07.200Z" },
        { type: "todo_updated", data: { todos: [{ id: "t1", content: "整理数据", status: "done" }, { id: "t2", content: "写结论", status: "pending" }] }, id: 6, at: "2026-10-21T09:00:07.300Z" },
      ]);
      expectParity(pair);
      // stats 缺 tokens → usage null（cost ?? null 保留 JS 语义）
      await feedPair(pair, [
        { type: "stats", data: {}, id: 7, at: "2026-10-21T09:00:07.400Z" },
      ]);
      expectParity(pair);
    } finally {
      await unmountPair(pair);
    }
  });

  it("model_switched 四形态 + 通道回退族：after-run 排队 / now 生效（recentModels+onModelChange）/ failed / 默认生效 / fallback", async () => {
    const pair = await mountPair();
    try {
      await feedPair(pair, [RUN_ADMITTED, AGENT_RETRY_BUSY]);
      await feedPair(pair, [
        { type: "model_switched", data: { to: "deepseek-chat", from: "deepseek-reasoner", effective: "after-run" }, id: 3, at: "2026-10-21T09:00:08.000Z" },
        { type: "model_switched", data: { to: "deepseek-chat", from: "deepseek-reasoner", effective: "failed", message: "供应商拒绝" }, id: 4, at: "2026-10-21T09:00:08.100Z" },
        { type: "model_switched", data: { to: "deepseek-reasoner", from: "deepseek-chat", effective: "now" }, id: 5, at: "2026-10-21T09:00:08.200Z" },
        { type: "model_switched", data: { to: "deepseek-chat", from: "deepseek-reasoner", reason: "fallback" }, id: 6, at: "2026-10-21T09:00:08.300Z" },
        { type: "agent_model_fallback", data: { from: "deepseek-chat", to: "deepseek-reasoner" }, id: 7, at: "2026-10-21T09:00:08.400Z" },
        { type: "agent_model_fallback", data: { from: "x", to: "y", message: "授权已过期" }, id: 8, at: "2026-10-21T09:00:08.500Z" },
        { type: "agent_model_fallback_failed", data: { from: "deepseek-chat" }, id: 9, at: "2026-10-21T09:00:08.600Z" },
      ]);
      expectParity(pair);
      // 6000/4000ms 清理在 ritual 中触发后，modelMsg 应清空（双侧一致）
      expect(readOldStates(pair.oldHost).modelMsg).toBe("");
    } finally {
      await unmountPair(pair);
    }
  });

  it("重试/错误/中断：agent_retry 文案与连接重试 / retry_end 恢复+3500ms 清理 / agent_error(quota) / aborted 收尾", async () => {
    const pair = await mountPair();
    try {
      await feedPair(pair, [RUN_ADMITTED]);
      await feedPair(pair, [
        { type: "agent_retry", data: { attempt: 2, maxAttempts: 5, category: "network" }, id: 2, at: "2026-10-21T09:00:09.000Z" },
        { type: "agent_retry_end", data: { outcome: "recovered", category: "network" }, id: 3, at: "2026-10-21T09:00:09.100Z" },
      ]);
      expectParity(pair);
      await feedPair(pair, [
        { type: "agent_error", data: { runId: "run-1", category: "quota", message: "额度已用尽" }, id: 4, at: "2026-10-21T09:00:09.200Z" },
      ]);
      expectParity(pair);
      // aborted：finalizeStopped 全清（气泡 done+stopped、refs 归零、runState aborted）
      await feedPair(pair, [
        { type: "token", data: { text: "恢复中的输出" }, id: 5, at: "2026-10-21T09:00:09.300Z" },
        { type: "aborted", data: {}, id: 6, at: "2026-10-21T09:00:09.400Z" },
      ]);
      expectParity(pair);
    } finally {
      await unmountPair(pair);
    }
  });

  it("系统事件：file_changed 聚合 + onFileChanged / map_action 生成与清除 + 去重 / steer 双源", async () => {
    const pair = await mountPair();
    try {
      await feedPair(pair, [
        { type: "file_changed", data: { files: ["报告.docx", "数据.xlsx"] }, id: 1, at: "2026-10-21T09:00:10.000Z" },
        { type: "file_changed", data: { files: ["结论.md"] }, id: 2, at: "2026-10-21T09:00:10.100Z" },
        { type: "map_action", data: { id: "map-1", title: "走廊热力分析", stats: { features: 12 }, updatedAt: "2026-10-21T09:00:10.200Z" }, id: 3, at: "2026-10-21T09:00:10.200Z" },
        { type: "map_action", data: { id: "map-1", title: "走廊热力分析", stats: { features: 12 }, updatedAt: "2026-10-21T09:00:10.200Z" }, id: 4, at: "2026-10-21T09:00:10.300Z" },
        { type: "map_action", data: { action: "clear_analysis", id: "map-1" }, id: 5, at: "2026-10-21T09:00:10.400Z" },
        { type: "steer", data: { source: "user", message: "把结论改得更保守一些" }, id: 6, at: "2026-10-21T09:00:10.500Z" },
        { type: "steer", data: { source: "turn-budget", message: "轮次预算提示（内部事件）" }, id: 7, at: "2026-10-21T09:00:10.600Z" },
      ]);
      expectParity(pair);
    } finally {
      await unmountPair(pair);
    }
  });

  it("终态与执行流：agent_end(finishing+onAgentEnd) / agent_summary / run_finished(finalText+artifacts+upsertRunSummary) / FLOW 执行流 / context_compact 族 / memory_proposal / runId 过滤 / cancelled 不 flush", async () => {
    const pair = await mountPair();
    try {
      await feedPair(pair, [
        { type: "capability_plan", data: { plan: JSON.stringify({ steps: ["读取数据", "生成图表"] }) }, id: 1, at: "2026-10-21T09:00:11.000Z" },
        RUN_ADMITTED,
        AGENT_RETRY_BUSY,
        { type: "token", data: { text: "第一轮结论。" }, id: 4, at: "2026-10-21T09:00:11.100Z" },
        { type: "tool_start", data: { toolCallId: "tc-9", name: "list_dir" }, id: 5, at: "2026-10-21T09:00:11.200Z" },
        { type: "tool_output", data: { toolCallId: "tc-9", output: "报告.docx" }, id: 6, at: "2026-10-21T09:00:11.300Z" },
        { type: "agent_end", data: {}, id: 7, at: "2026-10-21T09:00:11.400Z" },
        { type: "context_compacting", data: {}, id: 8, at: "2026-10-21T09:00:11.500Z" },
        { type: "context_compacted", data: { automatic: true, tokensBefore: 92000, estimatedTokensAfter: 41000 }, id: 9, at: "2026-10-21T09:00:11.600Z" },
        { type: "context_compact_warning", data: { message: "压缩超时" }, id: 10, at: "2026-10-21T09:00:11.700Z" },
        { type: "memory_proposal", data: { runId: "run-1", proposal: { id: "mp-1", content: "客流口径偏好" } }, id: 11, at: "2026-10-21T09:00:11.800Z" },
        { type: "memory_proposal_resolved", data: { id: "mp-1" }, id: 12, at: "2026-10-21T09:00:11.900Z" },
        // runId 过滤：锚定 run-1 后，run-2 的过程事件必须整体丢弃
        { type: "tool_start", data: { runId: "run-2", toolCallId: "tc-evil", name: "write_file" }, id: 13, at: "2026-10-21T09:00:12.000Z" },
        { type: "agent_summary", data: { runId: "run-1", summary: "完成走廊分析", products: ["报告.docx"] }, id: 14, at: "2026-10-21T09:00:12.100Z" },
        { type: "run_finished", data: { runId: "run-1", status: "completed", finalText: "第一轮结论。（权威补齐）", artifacts: [{ path: "D:/ws/parity/报告.docx" }] }, id: 15, at: "2026-10-21T09:00:12.200Z" },
      ]);
      expectParity(pair);
      // cancelled：终态照常释放 busy，但不 flushQueued
      await feedPair(pair, [
        { type: "run_admitted", data: { runId: "run-3" }, id: 16, at: "2026-10-21T09:00:12.300Z" },
        { type: "agent_retry", data: { attempt: 1, maxAttempts: 3 }, id: 17, at: "2026-10-21T09:00:12.400Z" },
        { type: "run_finished", data: { runId: "run-3", status: "cancelled" }, id: 18, at: "2026-10-21T09:00:12.500Z" },
      ]);
      expectParity(pair);
      expect(pair.harness.spies.flushQueued!.mock.calls.every((call) => call[0] === true)).toBe(true);
    } finally {
      await unmountPair(pair);
    }
  });

  it("capability_plan + mode_policy（editMode 应用）与 qoderDrainOnAbort flag 开启路径", async () => {
    await initFlags({ qoderDrainOnAbort: true });
    const pair = await mountPair();
    try {
      await feedPair(pair, [
        { type: "capability_plan", data: { plan: JSON.stringify({ capabilities: ["read", "write"] }) }, id: 1, at: "2026-10-21T09:00:13.000Z" },
        { type: "mode_policy", data: { mode: "agent", policy: { write: true } }, id: 2, at: "2026-10-21T09:00:13.100Z" },
        { type: "agent_retry", data: { attempt: 1, maxAttempts: 2 }, id: 3, at: "2026-10-21T09:00:13.200Z" },
        { type: "run_draining", data: {}, id: 4, at: "2026-10-21T09:00:13.300Z" },
      ]);
      expectParity(pair);
      expect(readOldStates(pair.oldHost).agentPhase).toBe("正在收尾（投递在途消息）");
      // mode_policy 再次应用（chat）+ forcedMode 缺省
      await feedPair(pair, [
        { type: "mode_policy", data: { mode: "chat", policy: { write: false } }, id: 5, at: "2026-10-21T09:00:13.400Z" },
      ]);
      expectParity(pair);
    } finally {
      await unmountPair(pair);
    }
  });

  it("mode_policy + forcedMode=review：editMode 锁定 forcedMode", async () => {
    const pair = await mountPair({ forcedMode: "review" });
    try {
      await feedPair(pair, [
        { type: "mode_policy", data: { mode: "agent", policy: { write: true } }, id: 1, at: "2026-10-21T09:00:14.000Z" },
      ]);
      expectParity(pair);
      expect(readOldStates(pair.oldHost).editMode).toBe("review");
    } finally {
      await unmountPair(pair);
    }
  });
});
