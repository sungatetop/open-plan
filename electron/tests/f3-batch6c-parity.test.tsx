// @vitest-environment jsdom
/**
 * F3 批6c 对拍：ChatPanel 对话流连接层（features/chat/event-stream.ts）。
 *
 * IPC transport 单测（B 部分）：注入 watch/stop/subscribe 假桥，覆盖
 * watch 参数（after/streamId 续传）、帧路由与过滤（op:heartbeat 活性不进事件流、
 * op:memory-change / op:sse-unknown 丢弃）、op:stream-state(retrying) 即时置断开、
 * watchdog 静默重连（stop → 500ms → 携游标重 watch）、清理 stop、watch 拒绝重试。
 *
 * R6-4：A 部分（SSE transport 双侧对拍）随 createSseThreadEventTransport 退役删除。
 *
 * 确定性：fake timers 冻结 Date/performance（BASE 起步）；事件帧手工按序喂入。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";

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
type ChatEventInput = import("../src/renderer/features/chat/event-machine").ChatEventInput;
type ChatStreamReadyEntry = import("../src/renderer/features/chat/event-stream").ChatStreamReadyEntry;

const { createChatEventStreamController, createIpcThreadEventTransport } = TsEventStream;

type Mock = ReturnType<typeof vi.fn>;
// 动态 import 命名空间不能用作类型命名空间（须 `type X = import(...).X` 别名）
type IpcOptions = import("../src/renderer/features/chat/event-stream").IpcThreadEventTransportOptions;
type ThreadEventTransport = import("../src/renderer/features/chat/event-stream").ThreadEventTransport;

/* --------------------------------- 驱动基建 --------------------------------- */

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

/* --------------------------------- B：IPC transport --------------------------------- */

describe("批6c 连接层 IPC transport", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: BASE, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
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
