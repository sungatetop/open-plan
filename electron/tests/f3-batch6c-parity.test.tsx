// @vitest-environment jsdom
/**
 * F3 批6c 对拍：ChatPanel 对话流连接层（features/chat/event-stream.ts 双 transport）。
 *
 * A 部分（SSE transport，双侧同流）：
 *   - 旧侧：真实挂载 client ChatPanel（jsdom），SSE effect（1515-1696）经
 *     window.EventSource 假类驱动，React fiber 走链读 connected 快照。
 *   - 新侧：createChatEventStreamController + createSseThreadEventTransport
 *     （注入同一假类工厂），refs/setConnected 直接断言。
 *   - 场景：建连 URL、connected 握手（游标/代际/markReady）、静默 watchdog
 *     重连与退避节奏（500→1000ms 倍增）、50s 握手超时（心跳保活下）、
 *     oaw:force-reconnect、缺号诊断（qoderSeqGapAlert 开）、清理释放。
 *
 * B 部分（IPC transport，新侧单测）：注入 watch/stop/subscribe 假桥，覆盖
 * watch 参数（after/streamId 续传）、帧路由与过滤（op:heartbeat 活性不进事件流、
 * op:memory-change / op:sse-unknown 丢弃）、op:stream-state(retrying) 即时置断开、
 * watchdog 静默重连（stop → 500ms → 携游标重 watch）、清理 stop、watch 拒绝重试。
 *
 * 确定性：fake timers 冻结 Date/performance（BASE 起步）；事件帧手工按序喂入；
 * 两侧同一假 EventSource 类与同一时钟，行为差异即对拍失败。
 */
import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const BASE = 1_700_000_000_000;
const CLIENT = "parity-client";
const THREAD = "thr-parity";
const WORKSPACE = "D:/ws/parity";
const STREAM_KEY = `${CLIENT}::${THREAD}`;

/* ------------------------- stubs（必须先于动态 import 装配） ------------------------- */

// rAF 手动队列（旧组件挂载期效果可能引用；本批无流式揭示，保底静默）
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

// jsdom 无滚动 API：静默化
(Element.prototype as unknown as Record<string, unknown>).scrollTo = () => {};
(Element.prototype as unknown as Record<string, unknown>).scrollIntoView = () => {};

/** 假 EventSource：记录 url/close，可手工触发 open/heartbeat/message/error。 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  side: "old" | "new" = "old";
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
  open(): void {
    (this.onopen as ((e: unknown) => void) | null)?.({});
  }
  heartbeat(): void {
    for (const fn of this.listeners.get("heartbeat") || []) fn({});
  }
  message(eventId: number, data: unknown): void {
    (this.onmessage as ((e: unknown) => void) | null)?.({
      lastEventId: String(eventId),
      data: typeof data === "string" ? data : JSON.stringify(data)
    });
  }
  error(): void {
    (this.onerror as ((e: unknown) => void) | null)?.({});
  }
  close(): void {
    this.closed = true;
  }
}
window.EventSource = FakeEventSource as unknown as typeof EventSource;

// fetch 路由：/api/status 供 runtimeFlags 快照；其余 404（挂载期其余 effect 静默收敛）
let statusReply: Record<string, unknown> = {};
window.fetch = (async (input: unknown) => {
  const url = typeof input === "string" ? input : String((input as { url?: string } | null)?.url ?? input);
  if (url.includes("/api/status")) {
    return { ok: true, status: 200, json: async () => statusReply } as unknown as Response;
  }
  return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
}) as typeof fetch;

// 新侧假桥（R6-1 起 TS feature-flags 快照走 op:status:get 通道；statusReply 取当前值）
(window as unknown as Record<string, unknown>).opDesktop = {
  invoke: async (channel: string) =>
    channel === "op:status:get"
      ? { ok: true, status: 200, data: statusReply }
      : { ok: false, status: 404, data: {} }
};

/* ------------------------------ 双侧模块（stub 后加载） ------------------------------ */

const TsEventStream = await import("../src/renderer/features/chat/event-stream");
const TsStreamBudget = await import("../src/renderer/lib/stream-budget");
const TsFlags = await import("../src/renderer/lib/feature-flags");
const JsPanel = await import("../../client/src/components/ChatPanel.jsx");
const JsFlags = await import("../../client/src/feature-flags.js");
const JsStreamBudget = await import("../../client/src/stream-budget.js");
type ChatEventInput = import("../src/renderer/features/chat/event-machine").ChatEventInput;
type ChatStreamReadyEntry = import("../src/renderer/features/chat/event-stream").ChatStreamReadyEntry;

// @ts-expect-error 旧 JS 模块；组件走 Record 宽容视图（JS 边界无静态约束）
const ChatPanelJs: React.ComponentType<Record<string, unknown>> = JsPanel.default;
const { createChatEventStreamController, createSseThreadEventTransport, createIpcThreadEventTransport } = TsEventStream;

type Mock = ReturnType<typeof vi.fn>;
// 动态 import 命名空间不能用作类型命名空间（须 `type X = import(...).X` 别名）
type IpcOptions = import("../src/renderer/features/chat/event-stream").IpcThreadEventTransportOptions;
type ThreadEventTransport = import("../src/renderer/features/chat/event-stream").ThreadEventTransport;

/* --------------------------- 旧侧 fiber 走链（connected 快照） --------------------------- */

interface FiberLike {
  tag: number;
  child: FiberLike | null;
  sibling: FiberLike | null;
  memoizedState: unknown;
}

function findPanelFiber(host: HTMLElement): FiberLike | null {
  const key = Object.keys(host).find((k) => k.startsWith("__reactContainer$"));
  if (!key) return null;
  const rootFiber = (host as unknown as Record<string, FiberLike>)[key];
  if (!rootFiber) return null;
  const queue: FiberLike[] = [rootFiber];
  while (queue.length) {
    const fiber = queue.shift()!;
    const ms = fiber.memoizedState as { next?: unknown } | null;
    if ((fiber.tag === 0 || fiber.tag === 11) && ms && typeof ms === "object" && "next" in ms) return fiber;
    if (fiber.child) queue.push(fiber.child);
    if (fiber.sibling) queue.push(fiber.sibling);
  }
  return null;
}

function readOldConnected(host: HTMLElement): boolean {
  const fiber = findPanelFiber(host);
  if (!fiber) throw new Error("ChatPanel fiber 未找到（挂载或走链失败）");
  interface HookLike { memoizedState: unknown; queue?: unknown; next: HookLike | null }
  const states: unknown[] = [];
  let hook = fiber.memoizedState as HookLike | null;
  while (hook) {
    if (hook.queue) states.push(hook.memoizedState);
    hook = hook.next;
  }
  return states[9] as boolean; // useState 序数 9 = connected（声明序见批6b 对拍注记）
}

/* --------------------------------- 驱动基建 --------------------------------- */

const MODELS = [
  { id: "deepseek-chat", provider: "deepseek", name: "DeepSeek Chat", contextWindow: 64000 },
];

function currentEs(side: "old" | "new"): FakeEventSource {
  const found = [...FakeEventSource.instances].reverse().find((es) => es.side === side && !es.closed);
  if (!found) throw new Error(`side=${side} 无未关闭的 EventSource`);
  return found;
}

function latestEs(side: "old" | "new"): FakeEventSource {
  const found = [...FakeEventSource.instances].reverse().find((es) => es.side === side);
  if (!found) throw new Error(`side=${side} 无 EventSource 实例`);
  return found;
}

interface NewSide {
  cleanup: () => void;
  refs: {
    mountedRef: { current: boolean };
    handshakeDoneRef: { current: boolean };
    eventCursorRef: { current: number };
    eventCursorsRef: { current: Map<string, number> };
    streamIdsRef: { current: Map<string, string> };
    streamReadyRef: { current: ChatStreamReadyEntry | null };
    streamGenerationRef: { current: number };
    eventHandlerRef: { current: ((event: ChatEventInput) => void) | null };
  };
  setConnected: Mock;
  handler: Mock;
}

function createNewSide(transport: ThreadEventTransport): NewSide {
  const refs: NewSide["refs"] = {
    mountedRef: { current: true },
    handshakeDoneRef: { current: false },
    eventCursorRef: { current: 0 },
    eventCursorsRef: { current: new Map() },
    streamIdsRef: { current: new Map() },
    streamReadyRef: { current: null },
    streamGenerationRef: { current: 0 },
    eventHandlerRef: { current: null }
  };
  const setConnected = vi.fn();
  // 最小事件消费侧：复刻旧 handleEvent connected 分支的 setConnected(true) 契约
  const handler = vi.fn((payload: ChatEventInput) => {
    if (payload?.type === "connected") setConnected(true);
  });
  refs.eventHandlerRef.current = handler;
  const cleanup = createChatEventStreamController({
    clientId: CLIENT,
    threadId: THREAD,
    workspace: WORKSPACE,
    refs,
    setConnected: setConnected as (value: boolean) => void,
    transport
  });
  return { cleanup, refs, setConnected, handler };
}

interface FakeBridge {
  watch: Mock;
  stop: Mock;
  subscribe: Mock;
  emit: (event: Record<string, unknown>) => void;
  listenerCount: () => number;
}

function createFakeBridge(watchResult: { ok: boolean; error?: string } = { ok: true }): FakeBridge {
  const listeners = new Set<(event: Record<string, unknown>) => void>();
  return {
    watch: vi.fn(async () => watchResult),
    stop: vi.fn(async () => undefined),
    subscribe: vi.fn((listener: (event: Record<string, unknown>) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
    emit: (event) => {
      for (const listener of [...listeners]) listener(event);
    },
    listenerCount: () => listeners.size
  };
}

function sideWithBridge(bridge: FakeBridge): NewSide {
  return createNewSide(createIpcThreadEventTransport({
    watch: bridge.watch as unknown as NonNullable<IpcOptions["watch"]>,
    stop: bridge.stop as unknown as NonNullable<IpcOptions["stop"]>,
    subscribe: bridge.subscribe as unknown as NonNullable<IpcOptions["subscribe"]>
  }));
}

interface Pair {
  oldHost: HTMLElement;
  newSide: NewSide;
  oldConnected: () => boolean;
  unmountOld: () => void;
}

async function mountPair(): Promise<Pair> {
  const oldHost = document.createElement("div");
  document.body.appendChild(oldHost);
  let oldRoot: Root | null = null;
  act(() => {
    oldRoot = createRoot(oldHost);
    oldRoot.render(
      React.createElement(ChatPanelJs, {
        clientId: CLIENT,
        threadId: THREAD,
        workspace: WORKSPACE,
        models: MODELS,
        onFileChanged: () => {},
        onMapAction: () => {},
        onRunFinished: () => {},
        onAgentEnd: () => {},
        onBrowserActivity: () => {},
        onModelChange: () => {}
      })
    );
  });
  await act(async () => { await Promise.resolve(); });
  if (!oldRoot) throw new Error("mount 失败");
  const newSide = createNewSide(
    createSseThreadEventTransport({
      createEventSource: (url: string): EventSource => {
        const es = new FakeEventSource(url);
        es.side = "new";
        return es as unknown as EventSource;
      }
    })
  );
  return {
    oldHost,
    newSide,
    oldConnected: () => readOldConnected(oldHost),
    unmountOld: () => {
      act(() => { oldRoot!.unmount(); });
    }
  };
}

const CONNECTED_S1 = { type: "connected", data: { streamId: "s1", cursor: 5 } };
const CONNECTED_S2 = { type: "connected", data: { streamId: "s2", cursor: 3 } };

/** 双侧同步握手：心跳刷新 + 喂 connected（无 id 帧形态，与线上一致） */
function handshake(pair: Pair, payload: Record<string, unknown> = CONNECTED_S1): void {
  act(() => {
    currentEs("old").heartbeat();
    currentEs("new").heartbeat();
    currentEs("old").message(0, payload);
    currentEs("new").message(0, payload);
  });
}

/** 双侧同步喂带游标的事件帧 */
function feedEvent(pair: Pair, eventId: number, payload: Record<string, unknown>): void {
  act(() => {
    currentEs("old").message(eventId, payload);
    currentEs("new").message(eventId, payload);
  });
}

/* --------------------------------- A：SSE 对拍 --------------------------------- */

describe("批6c 连接层 SSE transport 对拍", () => {
  let warnSpy: MockInstance<typeof console.warn>;

  beforeEach(() => {
    vi.useFakeTimers({ now: BASE, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
    FakeEventSource.instances.length = 0;
    statusReply = {};
    JsStreamBudget.resetStreams();
    TsStreamBudget.resetStreams();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("建连 URL 逐字节一致（client/thread/cwd，无游标代）", async () => {
    const pair = await mountPair();
    expect(latestEs("old").url).toBe(latestEs("new").url);
    expect(latestEs("old").url).toBe(
      `/api/agent/stream?client=${encodeURIComponent(CLIENT)}&thread=${encodeURIComponent(THREAD)}&cwd=${encodeURIComponent(WORKSPACE)}`
    );
    pair.unmountOld();
    pair.newSide.cleanup();
  });

  it("connected 握手：置真、游标/代际登记、ready 承诺落定 true、游标随帧推进", async () => {
    const pair = await mountPair();
    const entryBefore = pair.newSide.refs.streamReadyRef.current;
    expect(entryBefore).not.toBeNull();
    handshake(pair);
    expect(pair.oldConnected()).toBe(true);
    expect(pair.newSide.setConnected.mock.calls.at(-1)).toEqual([true]);
    expect(pair.newSide.refs.eventCursorRef.current).toBe(5);
    expect(pair.newSide.refs.streamIdsRef.current.get(STREAM_KEY)).toBe("s1");
    await expect(entryBefore!.promise).resolves.toBe(true);
    feedEvent(pair, 7, { type: "message.delta", data: {} });
    expect(pair.newSide.refs.eventCursorRef.current).toBe(7);
    pair.unmountOld();
    pair.newSide.cleanup();
  });

  it("静默 watchdog 重连：setConnected(false)、关旧连、500ms 后携游标重连", async () => {
    const pair = await mountPair();
    handshake(pair);
    feedEvent(pair, 7, { type: "message.delta", data: {} });
    const oldEs = currentEs("old");
    const newEs = currentEs("new");
    act(() => { vi.advanceTimersByTime(25_000); }); // 25s tick：25000 > 20000 阈值
    expect(oldEs.closed).toBe(true);
    expect(newEs.closed).toBe(true);
    expect(pair.oldConnected()).toBe(false);
    expect(pair.newSide.setConnected).toHaveBeenCalledWith(false);
    act(() => { vi.advanceTimersByTime(499); });
    expect(latestEs("old")).toBe(oldEs); // 尚未建新连
    expect(latestEs("new")).toBe(newEs);
    act(() => { vi.advanceTimersByTime(1); });
    expect(latestEs("old")).not.toBe(oldEs);
    expect(latestEs("new")).not.toBe(newEs);
    expect(latestEs("old").url).toBe(latestEs("new").url);
    expect(latestEs("old").url).toContain("after=7");
    expect(latestEs("old").url).toContain(`stream=${encodeURIComponent("s1")}`);
    pair.unmountOld();
    pair.newSide.cleanup();
  });

  it("退避节奏逐拍一致：首次 500ms、二次 1000ms（基线倍增，flag 关）", async () => {
    const pair = await mountPair();
    handshake(pair);
    // 第一轮静默重连（500ms）
    const firstOld = currentEs("old");
    const firstNew = currentEs("new");
    act(() => { vi.advanceTimersByTime(25_000); });
    expect(firstOld.closed).toBe(true);
    expect(firstNew.closed).toBe(true);
    act(() => { vi.advanceTimersByTime(499); });
    expect(latestEs("old")).toBe(firstOld);
    expect(latestEs("new")).toBe(firstNew);
    act(() => { vi.advanceTimersByTime(1); });
    expect(latestEs("old")).not.toBe(firstOld);
    expect(latestEs("new")).not.toBe(firstNew);
    // 第二轮静默重连（1000ms）
    const secondOld = currentEs("old");
    const secondNew = currentEs("new");
    act(() => { vi.advanceTimersByTime(25_000); });
    expect(secondOld.closed).toBe(true);
    expect(secondNew.closed).toBe(true);
    act(() => { vi.advanceTimersByTime(999); });
    expect(latestEs("old")).toBe(secondOld);
    expect(latestEs("new")).toBe(secondNew);
    act(() => { vi.advanceTimersByTime(1); });
    expect(latestEs("old")).not.toBe(secondOld);
    expect(latestEs("new")).not.toBe(secondNew);
    expect(latestEs("old").url).toBe(latestEs("new").url);
    pair.unmountOld();
    pair.newSide.cleanup();
  });

  it("代际切换：streamId 变化重置游标，重连 URL 换新代际", async () => {
    const pair = await mountPair();
    handshake(pair, CONNECTED_S1);
    feedEvent(pair, 7, { type: "message.delta", data: {} });
    // 静默重连 → after=7&stream=s1
    act(() => { vi.advanceTimersByTime(25_000); });
    act(() => { vi.advanceTimersByTime(500); });
    expect(latestEs("old").url).toBe(latestEs("new").url);
    expect(latestEs("old").url).toContain("after=7");
    expect(latestEs("old").url).toContain(`stream=${encodeURIComponent("s1")}`);
    // 新代际 connected：旧游标废弃后取 connected cursor=3
    handshake(pair, CONNECTED_S2);
    expect(pair.newSide.refs.eventCursorRef.current).toBe(3);
    expect(pair.newSide.refs.streamIdsRef.current.get(STREAM_KEY)).toBe("s2");
    // 再次静默重连 → after=3&stream=s2
    act(() => { vi.advanceTimersByTime(25_000); });
    act(() => { vi.advanceTimersByTime(500); });
    expect(latestEs("old").url).toBe(latestEs("new").url);
    expect(latestEs("old").url).toContain("after=3");
    expect(latestEs("old").url).toContain(`stream=${encodeURIComponent("s2")}`);
    pair.unmountOld();
    pair.newSide.cleanup();
  });

  it("50s 握手超时：onopen 后无 connected 帧 → 心跳保活下 50s 强制重连", async () => {
    const pair = await mountPair();
    act(() => {
      currentEs("old").open();
      currentEs("new").open();
    });
    const oldEs = currentEs("old");
    const newEs = currentEs("new");
    // 心跳先喂再推进：watchdog 全程安静，50s 超时独占触发
    for (let i = 0; i < 10; i++) {
      act(() => {
        currentEs("old").heartbeat();
        currentEs("new").heartbeat();
        vi.advanceTimersByTime(5_000);
      });
    }
    expect(oldEs.closed).toBe(true);
    expect(newEs.closed).toBe(true);
    act(() => { vi.advanceTimersByTime(500); });
    expect(latestEs("old").url).toBe(latestEs("new").url);
    pair.unmountOld();
    pair.newSide.cleanup();
  });

  it("oaw:force-reconnect：立即收流并按退避节奏重连", async () => {
    const pair = await mountPair();
    handshake(pair);
    const oldEs = currentEs("old");
    const newEs = currentEs("new");
    act(() => {
      window.dispatchEvent(new Event("oaw:force-reconnect"));
    });
    expect(oldEs.closed).toBe(true);
    expect(newEs.closed).toBe(true);
    expect(pair.oldConnected()).toBe(false);
    expect(pair.newSide.setConnected).toHaveBeenCalledWith(false);
    act(() => { vi.advanceTimersByTime(500); });
    expect(latestEs("old").url).toBe(latestEs("new").url);
    expect(latestEs("old").url).toContain("after=5");
    pair.unmountOld();
    pair.newSide.cleanup();
  });

  it("缺号诊断（qoderSeqGapAlert 开）：首次缺号各告警一次，两侧文案一致", async () => {
    statusReply = { runtimeFlags: { qoderSeqGapAlert: true } };
    await Promise.all([JsFlags.initRuntimeFlags(), TsFlags.initRuntimeFlags()]);
    const pair = await mountPair();
    handshake(pair); // cursor=5
    feedEvent(pair, 9, { type: "message.delta", data: {} }); // 5 → 9 缺 6/7/8
    feedEvent(pair, 13, { type: "message.delta", data: {} }); // 再次缺号，不重复告警
    const warns = warnSpy.mock.calls.filter((call) => String(call[0]).includes("SSE 事件缺号"));
    expect(warns).toHaveLength(2); // 旧侧 1 + 新侧 1
    expect(String(warns[0]?.[0])).toBe(String(warns[1]?.[0]));
    expect(String(warns[0]?.[0])).toContain("5 → 9");
    pair.unmountOld();
    pair.newSide.cleanup();
  });

  it("清理：停流释放槽位、定时器清空、ready 条目按代际作废", async () => {
    const pair = await mountPair();
    handshake(pair);
    expect(JsStreamBudget.activeStreamCount()).toBe(1);
    expect(TsStreamBudget.activeStreamCount()).toBe(1);
    expect(pair.newSide.refs.streamReadyRef.current).not.toBeNull();
    pair.unmountOld();
    pair.newSide.cleanup();
    expect(latestEs("old").closed).toBe(true);
    expect(latestEs("new").closed).toBe(true);
    expect(JsStreamBudget.activeStreamCount()).toBe(0);
    expect(TsStreamBudget.activeStreamCount()).toBe(0);
    expect(pair.newSide.refs.streamReadyRef.current).toBeNull();
    const count = FakeEventSource.instances.length;
    act(() => { vi.advanceTimersByTime(120_000); }); // 无任何重连/watchdog 复活
    expect(FakeEventSource.instances).toHaveLength(count);
  });
});

/* --------------------------------- B：IPC transport --------------------------------- */

describe("批6c 连接层 IPC transport", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: BASE, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
    FakeEventSource.instances.length = 0;
    JsStreamBudget.resetStreams();
    TsStreamBudget.resetStreams();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  /** watch 微任务放行（假桥 watch 为 async，两个宏等待确保 then 链走完） */
  async function flushWatch(): Promise<void> {
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  }

  it("watch 参数携带续传游标与代际；受理后进入 50s 握手窗，超时强制重连", async () => {
    const bridge = createFakeBridge();
    const side = sideWithBridge(bridge);
    expect(bridge.watch).toHaveBeenCalledTimes(1);
    expect(bridge.watch.mock.calls[0]?.[0]).toEqual({
      client: CLIENT,
      thread: THREAD,
      cwd: WORKSPACE,
      after: 0,
      streamId: ""
    });
    await flushWatch();
    act(() => { vi.advanceTimersByTime(50_000); }); // 无 connected 帧 → 握手超时
    expect(bridge.stop).toHaveBeenCalledWith({ client: CLIENT, thread: THREAD });
    act(() => { vi.advanceTimersByTime(500); });
    expect(bridge.watch).toHaveBeenCalledTimes(2);
    side.cleanup();
  });

  it("帧路由：消息帧递入事件处理器并推进游标；connected 帧登记代际并落定 ready", async () => {
    const bridge = createFakeBridge();
    const side = sideWithBridge(bridge);
    const entry = side.refs.streamReadyRef.current;
    expect(entry).not.toBeNull();
    await flushWatch();
    bridge.emit({ id: 7, type: "message.delta", streamId: "s1", data: { text: "hi" } });
    expect(side.handler).toHaveBeenCalledTimes(1);
    expect(side.refs.eventCursorRef.current).toBe(7);
    bridge.emit({ type: "connected", data: { streamId: "s1", cursor: 9 } });
    expect(side.refs.streamIdsRef.current.get(STREAM_KEY)).toBe("s1");
    expect(side.refs.eventCursorRef.current).toBe(9);
    expect(side.refs.handshakeDoneRef.current).toBe(true);
    await expect(entry!.promise).resolves.toBe(true);
    // 非对话流帧：直接丢弃（connected 帧本身也经 handler 递入，故取相对计数）
    const callsBeforeJunk = side.handler.mock.calls.length;
    bridge.emit({ type: "op:memory-change", data: { file: "x" } });
    bridge.emit({ type: "op:sse-unknown", data: { historyId: 1 } });
    expect(side.handler).toHaveBeenCalledTimes(callsBeforeJunk);
    side.cleanup();
  });

  it("op:heartbeat 只作活性：不进事件流，且喂饱静默 watchdog", async () => {
    const bridge = createFakeBridge();
    const side = sideWithBridge(bridge);
    await flushWatch();
    for (let i = 0; i < 5; i++) {
      act(() => {
        vi.advanceTimersByTime(5_000);
        bridge.emit({ type: "op:heartbeat", at: "2026-10-21T00:00:00.000Z" });
      });
    }
    expect(side.handler).not.toHaveBeenCalled(); // 心跳不进事件流
    expect(bridge.stop).not.toHaveBeenCalled(); // watchdog 未触发
    side.cleanup();
  });

  it("op:stream-state(retrying)：即时置断开并解除握手等待（不触发渲染层重连）", async () => {
    const bridge = createFakeBridge();
    const side = sideWithBridge(bridge);
    const entry = side.refs.streamReadyRef.current;
    await flushWatch();
    act(() => {
      bridge.emit({ type: "op:stream-state", data: { state: "retrying", detail: "SSE 连接被服务端关闭" } });
    });
    expect(side.setConnected).toHaveBeenCalledWith(false);
    await expect(entry!.promise).resolves.toBe(false);
    expect(bridge.stop).not.toHaveBeenCalled(); // 重连由桥负责
    side.cleanup();
  });

  it("静默 watchdog 重连：stop 当前流 → 500ms → 携游标/代际重 watch", async () => {
    const bridge = createFakeBridge();
    const side = sideWithBridge(bridge);
    await flushWatch();
    bridge.emit({ type: "connected", data: { streamId: "s1", cursor: 3 } });
    bridge.emit({ id: 7, type: "message.delta", streamId: "s1", data: {} });
    act(() => { vi.advanceTimersByTime(25_000); });
    expect(bridge.stop).toHaveBeenCalledWith({ client: CLIENT, thread: THREAD });
    act(() => { vi.advanceTimersByTime(500); });
    expect(bridge.watch).toHaveBeenCalledTimes(2);
    expect(bridge.watch.mock.calls[1]?.[0]).toEqual({
      client: CLIENT,
      thread: THREAD,
      cwd: WORKSPACE,
      after: 7,
      streamId: "s1"
    });
    side.cleanup();
  });

  it("watch 拒绝（ok:false）：走渲染层退避重试", async () => {
    const bridge = createFakeBridge({ ok: false, error: "client required" });
    const side = sideWithBridge(bridge);
    await flushWatch();
    act(() => { vi.advanceTimersByTime(500); });
    expect(bridge.watch).toHaveBeenCalledTimes(2);
    side.cleanup();
  });

  it("清理：退订 op:event 并停流，定时器不复活", async () => {
    const bridge = createFakeBridge();
    const side = sideWithBridge(bridge);
    await flushWatch();
    expect(bridge.listenerCount()).toBe(1);
    side.cleanup();
    expect(bridge.listenerCount()).toBe(0);
    expect(bridge.stop).toHaveBeenCalledWith({ client: CLIENT, thread: THREAD });
    expect(TsStreamBudget.activeStreamCount()).toBe(0);
    const watchCalls = bridge.watch.mock.calls.length;
    act(() => { vi.advanceTimersByTime(120_000); });
    expect(bridge.watch.mock.calls).toHaveLength(watchCalls);
  });
});
