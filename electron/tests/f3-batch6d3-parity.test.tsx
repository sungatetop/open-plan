// @vitest-environment jsdom
/**
 * F3 批6d-3：ChatPanel 主组件编排（panel.tsx，旧 532-4054）新侧 IPC 形态背书。
 *
 * R6-6c 对拍退役改写：旧侧 client ChatPanel.jsx 双侧同流全 DOM 对拍（A1-A5）随
 * client 退役删除（等价性已在 F3 批对拍验收冻结）；保留新侧 IPC 形态独立断言：
 *   B1 stop 走 op:agent:abort 通道，不发起 fetch POST；
 *   B2 connecting 态 connected 不即时置 false：watch 未受理期间喂 connected 帧
 *      置真，心跳保活下不闪断；op:stream-state(retrying) 即时断开；桥内重连完成
 *      恢复真值。
 *
 * 确定性：fake timers 冻结 Date/performance（BASE 起步）；rAF 手动队列；
 * 累计虚拟时钟 < 20s（静默 watchdog 阈值），B2 按 5s 心跳节奏保活推进。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const BASE = 1_700_000_000_000;
const CLIENT = "parity-client";
const THREAD = "thr-parity";
const WORKSPACE = "D:/ws/parity";

const MODELS = [
  { id: "deepseek-chat", provider: "deepseek", name: "DeepSeek Chat", contextWindow: 64000 },
  { id: "deepseek-reasoner", provider: "deepseek", name: "DeepSeek Reasoner", contextWindow: 64000, vision: true },
];

/* ------------------------- stubs（必须先于动态 import 装配） ------------------------- */

// rAF 手动队列（flushFrames 每轮推进 32ms，与 32ms 揭示节流对齐）
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

// jsdom 无滚动 API：ChatPanel 跟随滚动 effect 静默化
(Element.prototype as unknown as Record<string, unknown>).scrollTo = () => {};
(Element.prototype as unknown as Record<string, unknown>).scrollIntoView = () => {};

/* --------------------- fetch 记录（B1 断言不发起 abort POST）与 opDesktop 假桥 --------------------- */

const fetchCalls: string[] = [];
let statusReply: Record<string, unknown> = {};

window.fetch = (async (input: unknown) => {
  const url = typeof input === "string" ? input : String((input as { url?: string } | null)?.url ?? input);
  fetchCalls.push(url);
  if (url.includes("/api/status")) {
    return { ok: true, status: 200, json: async () => statusReply } as unknown as Response;
  }
  return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
}) as typeof fetch;

// 假桥：invoke 按通道给罐头应答（HTTP 语义 ok:false 不 reject）；事件经 onEvent 推送
const bridgeListeners = new Set<(event: Record<string, unknown>) => void>();
const bridgeInvokeCalls: Array<{ channel: string; payload: unknown }> = [];
let promptInvokeReply: (() => InvokeResultLike) | null = null;

interface InvokeResultLike { ok: boolean; status: number; data: unknown }

function defaultInvokeReply(channel: string): InvokeResultLike {
  // R6-1 起 TS feature-flags 快照走 op:status:get 通道（statusReply 同源）
  if (channel === "op:status:get") return { ok: true, status: 200, data: statusReply };
  if (channel === "op:agent:prompt" && promptInvokeReply) return promptInvokeReply();
  if (channel === "op:agent:prompt") return { ok: false, status: 404, data: { error: "请求失败" } };
  if (channel === "op:agent:abort") return { ok: true, status: 200, data: { cancelled: true } };
  return { ok: false, status: 404, data: { error: "请求失败（404）" } };
}

(window as unknown as Record<string, unknown>).opDesktop = {
  protocolVersion: 1,
  getServerStatus: async () => null,
  onServerStatus: () => () => {},
  invoke: async (channel: string, payload?: unknown) => {
    bridgeInvokeCalls.push({ channel, payload });
    return defaultInvokeReply(channel);
  },
  onEvent: (listener: (event: Record<string, unknown>) => void) => {
    bridgeListeners.add(listener);
    return () => {
      bridgeListeners.delete(listener);
    };
  },
  watchThreadEvents: async () => ({ ok: true }),
  stopThreadEvents: async () => undefined,
  watchMemoryEvents: async () => ({ ok: true }),
  stopMemoryEvents: async () => undefined,
} as unknown as typeof window.opDesktop;

/* ------------------------------ 新侧模块（stub 后加载） ------------------------------ */

const TsPanel = await import("../src/renderer/features/chat/panel");
const TsFlags = await import("../src/renderer/lib/feature-flags");
const TsStreamBudget = await import("../src/renderer/lib/stream-budget");

// @ts-expect-error 测试侧宽松传参（props 与生产一致，但静态约束从宽）
const ChatPanelTs: React.ComponentType<Record<string, unknown>> = TsPanel.default;

/* --------------------------------- 挂载与驱动 --------------------------------- */

interface Pair {
  host: HTMLElement;
  emitNew: (frame: Record<string, unknown>) => void;
  dispose: () => void;
}

const activeDisposers: Array<() => void> = [];

function noop(): void {}

async function mountPair(extra: Record<string, unknown> = {}): Promise<Pair> {
  const props: Record<string, unknown> = {
    clientId: CLIENT,
    threadId: THREAD,
    workspace: WORKSPACE,
    models: MODELS,
    onFileChanged: noop,
    onMapAction: noop,
    onRunFinished: noop,
    onAgentEnd: noop,
    onBrowserActivity: noop,
    onModelChange: noop,
    ...extra,
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  let root: Root | null = null;
  act(() => {
    root = createRoot(host);
    root.render(React.createElement(ChatPanelTs, props));
  });
  // watch/listRuns 等异步链放行（两个宏等待确保 then 链走完）
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  if (!root) throw new Error("mount 失败");

  const emitNew = (frame: Record<string, unknown>): void => {
    for (const listener of [...bridgeListeners]) listener(frame);
  };
  const dispose = (): void => {
    act(() => {
      root!.unmount();
    });
  };
  activeDisposers.push(dispose);
  return { host, emitNew, dispose };
}

/** 握手：心跳刷新 + connected（无 id 帧形态，与线上一致） */
function handshake(pair: Pair): void {
  act(() => {
    pair.emitNew({ type: "op:heartbeat", at: "2026-10-21T00:00:00.000Z" });
    pair.emitNew({ type: "connected", data: { streamId: "s1", cursor: 0 } });
  });
}

/** 喂带游标的事件帧 */
function feedNew(pair: Pair, eventId: number, payload: Record<string, unknown>): void {
  act(() => {
    pair.emitNew({ id: eventId, ...payload });
  });
}

/** 流式渲染排空：rAF 揭示 + 80ms 执行流 debounce + 微任务链 */
async function settle(): Promise<void> {
  act(() => {
    flushFrames();
    vi.advanceTimersByTime(120);
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

/** 输入框输入（React 受控组件原生 setter 惯用法） */
function typeInto(host: HTMLElement, text: string): void {
  const textarea = host.querySelector("textarea");
  if (!textarea) throw new Error("textarea 未找到");
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function clickButton(host: HTMLElement, selector: string): void {
  const button = host.querySelector(selector);
  if (!button) throw new Error(`按钮未找到: ${selector}`);
  act(() => {
    (button as HTMLButtonElement).click();
  });
}

/**
 * 发送一条消息并等待 admission 成功（IPC 应答 accepted+runId）。
 * 事件流开场的正确驱动方式：run_admitted/agent_started 不置 busy，冷态喂 token 会被
 * ensureAssistant 门丢弃、.stop-btn 不渲染——必须经真实发送路径驱动。
 */
async function sendNew(pair: Pair, text: string): Promise<void> {
  promptInvokeReply = () => ({ ok: true, status: 200, data: { accepted: true, runId: "r1" } });
  typeInto(pair.host, text);
  clickButton(pair.host, ".send-btn");
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  if (!pair.host.querySelector(".stop-btn")) {
    throw new Error("sendNew 后 .stop-btn 未渲染（admission 未置 busy）");
  }
}

/* --------------------------------- 事件流样本 --------------------------------- */

const EV_RUN_ADMITTED = { type: "run_admitted", data: { runId: "r1" } };
const EV_AGENT_STARTED = { type: "agent_started", data: {} };
const EV_TOKEN_A = { type: "token", data: { text: "正在整理要点。" } };

/* --------------------------------- B：新侧 IPC 形态背书 --------------------------------- */

describe("批6d-3 新侧 IPC 形态背书（6c 过渡差异）", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: BASE, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
    fetchCalls.length = 0;
    bridgeInvokeCalls.length = 0;
    bridgeListeners.clear();
    statusReply = {};
    promptInvokeReply = null;
    TsStreamBudget.resetStreams();
    TsFlags.initRuntimeFlags();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    while (activeDisposers.length) activeDisposers.pop()!();
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  interface FiberLike { tag: number; child: FiberLike | null; sibling: FiberLike | null; memoizedState: unknown }

  function readNewConnected(host: HTMLElement): boolean {
    const key = Object.keys(host).find((k) => k.startsWith("__reactContainer$"));
    if (!key) throw new Error("fiber 容器未找到");
    // markContainerAsRoot 存的是 HostRoot fiber 本身；首个带 hook 链的函数组件 fiber 即目标
    const queue: FiberLike[] = [(host as unknown as Record<string, FiberLike>)[key]!];
    while (queue.length) {
      const fiber = queue.shift()!;
      const ms = fiber.memoizedState as { next?: unknown } | null;
      if ((fiber.tag === 0 || fiber.tag === 11) && ms && typeof ms === "object" && "next" in ms) {
        interface HookLike { memoizedState: unknown; queue?: unknown; next: HookLike | null }
        const states: unknown[] = [];
        let hook = fiber.memoizedState as HookLike | null;
        while (hook) {
          if (hook.queue) states.push(hook.memoizedState);
          hook = hook.next;
        }
        return states[9] as boolean; // useState 序数 9 = connected
      }
      if (fiber.child) queue.push(fiber.child);
      if (fiber.sibling) queue.push(fiber.sibling);
    }
    throw new Error("ChatPanel fiber 未找到");
  }

  it("B1 stop 走 op:agent:abort 通道，不发起 fetch POST", async () => {
    const pair = await mountPair();
    handshake(pair);
    await sendNew(pair, "执行导出");
    feedNew(pair, 1, EV_RUN_ADMITTED);
    feedNew(pair, 2, EV_AGENT_STARTED);
    feedNew(pair, 3, EV_TOKEN_A);
    await settle();
    const fetchCallsBefore = fetchCalls.length;
    clickButton(pair.host, ".stop-btn");
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(bridgeInvokeCalls.some((call) => call.channel === "op:agent:abort")).toBe(true);
    // 不发起 fetch POST（无 /api/agent/abort）
    expect(fetchCalls.slice(fetchCallsBefore).some((url) => url.includes("/api/agent/abort"))).toBe(false);
    feedNew(pair, 4, { type: "agent_error", data: { message: "Request aborted" } });
    // abort 受理（stoppingRef 真）：agent_error 走 abort 分支收尾，无错误徽记
    await settle();
    expect(pair.host.innerHTML).not.toContain("模型调用失败");
    pair.dispose();
  });

  it("B2 connecting 态 connected 不即时置 false：watch 未受理期间置真且不闪断", async () => {
    // watch 挂起（桥受理延迟）：组件处于 connecting 态
    let resolveWatch: ((value: { ok: boolean }) => void) | null = null;
    const originalWatch = (window.opDesktop as unknown as Record<string, unknown>).watchThreadEvents;
    (window.opDesktop as unknown as Record<string, unknown>).watchThreadEvents = () =>
      new Promise((resolve) => { resolveWatch = resolve; });
    const pair = await mountPair();
    expect(readNewConnected(pair.host)).toBe(false);
    // connecting 态喂 connected 帧 → 置真
    act(() => {
      pair.emitNew({ type: "op:heartbeat", at: "2026-10-21T00:00:00.000Z" });
      pair.emitNew({ type: "connected", data: { streamId: "s1", cursor: 0 } });
    });
    expect(readNewConnected(pair.host)).toBe(true);
    // 心跳保活推进 25s（5s × 5 tick）：watchdog 安静，connected 不被闪断
    for (let i = 0; i < 5; i++) {
      act(() => {
        pair.emitNew({ type: "op:heartbeat", at: "2026-10-21T00:00:05.000Z" });
        vi.advanceTimersByTime(5_000);
      });
    }
    expect(readNewConnected(pair.host)).toBe(true);
    // 桥断线重连窗口（op:stream-state retrying）→ 即时置断开，重连由桥负责
    act(() => {
      pair.emitNew({ type: "op:stream-state", data: { state: "retrying", detail: "SSE 连接被服务端关闭" } });
    });
    expect(readNewConnected(pair.host)).toBe(false);
    // 桥内重连完成（watch 受理 + 新 connected 帧）→ 恢复真值
    await act(async () => {
      resolveWatch!({ ok: true });
      await Promise.resolve(); await Promise.resolve();
    });
    act(() => {
      pair.emitNew({ type: "connected", data: { streamId: "s1", cursor: 0 } });
    });
    expect(readNewConnected(pair.host)).toBe(true);
    (window.opDesktop as unknown as Record<string, unknown>).watchThreadEvents = originalWatch;
    pair.dispose();
  });
});
