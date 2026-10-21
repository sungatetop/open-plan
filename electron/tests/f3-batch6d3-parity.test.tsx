// @vitest-environment jsdom
/**
 * F3 批6d-3 对拍：ChatPanel 主组件编排（panel.tsx，旧 532-4054）全 DOM 双侧同流。
 *
 * 形态（与 6b/6c 的关键差异）：
 *   - 双侧都真实挂载：旧侧 client ChatPanel.jsx（SSE transport + fetch），新侧
 *     features/chat/panel.tsx（IPC transport + window.opDesktop 假桥）——各自走
 *     生产形态的连接层，同一事件流分送两侧（旧 EventSource 帧 / 新 op:event 帧）。
 *   - 对比口径：全 DOM 归一化后逐字节比较（Logo 渐变 ID / newId 消息 id 按首现序
 *     映射），失败给出首个差异位置。
 *   - admission/abort 等控制面语义对齐：旧 fetch !res.ok（json.error）与 IPC
 *     ok:false（data.error → ApiError.message）映射到同一文案（panel.tsx catch
 *     按 ApiError 分支还原旧 !res.ok 分支），两侧 DOM 文案一致。
 *
 * 场景：
 *   A1 挂载空态 + connected 握手 DOM 一致
 *   A2 一轮完整 Run（send admission 成功开场 → run_admitted/agent_started/token/
 *      tool_start/tool_output/tool_end/stats/assistant_final/agent_end/run_finished）
 *      三阶段 DOM 一致
 *   A3 replayRecover 缓冲冲刷（flag 开）：探测窗口内事件入缓冲，probe 返回 live run
 *      后冲刷生效，两侧 DOM 一致（6b 遗留）
 *   A4 中断语义：stop 成功受理 → agent_error("Request aborted") 走 abort 收尾
 *      （无错误徽记、10s 确认定时器被清理），两侧 DOM 一致（6b 遗留）
 *   A5 flushQueued 队列续跑：busy 排队 → run_finished 触发 450ms 续跑 →
 *      admission 失败收尾（6b 遗留）
 *   B1 IPC 形态背书：stop 走 op:agent:abort 通道，不发起 fetch POST（6c 过渡差异）
 *   B2 connecting 态 connected 不即时置 false：watch 未受理期间喂 connected 帧
 *      置真，心跳保活下不闪断；op:stream-state(retrying) 即时断开；桥内重连完成
 *      恢复真值（6c 过渡差异）
 *
 * 确定性：fake timers 冻结 Date/performance（BASE 起步）；rAF 手动队列双侧共用；
 * 每用例累计虚拟时钟 < 20s（静默 watchdog 阈值），仅 B2 按 5s 心跳节奏保活推进。
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

// rAF 手动队列：双侧共用同一队列与时钟（flushFrames 每轮推进 32ms，与 32ms 揭示节流对齐）
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

/** 假 EventSource（仅旧侧 SSE effect 使用）：记录 url/close，可手工驱动帧。 */
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
  close(): void {
    this.closed = true;
  }
}
window.EventSource = FakeEventSource as unknown as typeof EventSource;

/* --------------------- fetch 路由（旧侧）与 opDesktop 假桥（新侧） --------------------- */

interface RawResponse { ok: boolean; status: number; json: () => Promise<unknown> }
interface InvokeResultLike { ok: boolean; status: number; data: unknown }

const fetchCalls: string[] = [];
let statusReply: Record<string, unknown> = {};
// 可控应答（默认 404 基线；各场景按需覆写，beforeEach 复位）
let promptReply: RawResponse = { ok: false, status: 404, json: async () => ({ error: "请求失败" }) };
let abortReply: RawResponse = { ok: true, status: 200, json: async () => ({ cancelled: true }) };
let runsFetchReply: (() => RawResponse) | null = null;

window.fetch = (async (input: unknown) => {
  const url = typeof input === "string" ? input : String((input as { url?: string } | null)?.url ?? input);
  fetchCalls.push(url);
  if (url.includes("/api/status")) {
    return { ok: true, status: 200, json: async () => statusReply } as unknown as Response;
  }
  if (url.includes("/api/agent/prompt")) return promptReply as unknown as Response;
  if (url.includes("/api/agent/abort")) return abortReply as unknown as Response;
  if (url.includes("/api/runs") && runsFetchReply) return runsFetchReply() as unknown as Response;
  return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
}) as typeof fetch;

// 新侧假桥：invoke 按通道给罐头应答（HTTP 语义 ok:false 不 reject）；事件经 onEvent 推送
const bridgeListeners = new Set<(event: Record<string, unknown>) => void>();
const bridgeInvokeCalls: Array<{ channel: string; payload: unknown }> = [];
const bridgeWatchCalls: unknown[] = [];
const bridgeStopCalls: unknown[] = [];
// 可控应答（新侧）：prompt/abort 与旧侧同文案；op:runs:list 可被场景覆写
let runsListInvokeReply: (() => InvokeResultLike) | null = null;
let promptInvokeReply: (() => InvokeResultLike) | null = null;

function defaultInvokeReply(channel: string): InvokeResultLike {
  if (channel === "op:agent:prompt" && promptInvokeReply) return promptInvokeReply();
  if (channel === "op:agent:prompt") return { ok: false, status: 404, data: { error: "请求失败" } };
  if (channel === "op:agent:abort") return { ok: true, status: 200, data: { cancelled: true } };
  if (channel === "op:runs:list" && runsListInvokeReply) return runsListInvokeReply();
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
  watchThreadEvents: async (request: unknown) => {
    bridgeWatchCalls.push(request);
    return { ok: true };
  },
  stopThreadEvents: async (request?: unknown) => {
    bridgeStopCalls.push(request);
  },
  watchMemoryEvents: async () => ({ ok: true }),
  stopMemoryEvents: async () => undefined,
} as unknown as typeof window.opDesktop;

/* ------------------------------ 双侧模块（stub 后加载） ------------------------------ */

const JsPanel = await import("../../client/src/components/ChatPanel.jsx");
const TsPanel = await import("../src/renderer/features/chat/panel");
const JsFlags = await import("../../client/src/feature-flags.js");
const TsFlags = await import("../src/renderer/lib/feature-flags");
const JsStreamBudget = await import("../../client/src/stream-budget.js");
const TsStreamBudget = await import("../src/renderer/lib/stream-budget");

// @ts-expect-error 旧 JS 模块；组件走 Record 宽容视图（JS 边界无静态约束）
const ChatPanelJs: React.ComponentType<Record<string, unknown>> = JsPanel.default;
// @ts-expect-error 测试侧宽松传参（对拍 props 与生产一致，但静态约束从宽）
const ChatPanelTs: React.ComponentType<Record<string, unknown>> = TsPanel.default;

/* --------------------------------- DOM 归一化对比 --------------------------------- */

/**
 * 归一化两类实例级标识（与迁移逻辑无关的测试基建差异）：
 *   - Logo 渐变 ID：useId 实例计数漂移（5b-5 结论）；
 *   - 消息 id：newId 生成 /^m\d+$/，双侧模块各自维护计数器，按各自 DOM 首现序映射 #n。
 */
function normalizeDom(html: string): string {
  let out = html.replace(/open-plan-logo-[A-Za-z0-9]+/g, "open-plan-logo-N");
  const map = new Map<string, string>();
  out = out.replace(/\bm\d+\b/g, (token) => {
    if (!map.has(token)) map.set(token, `#mid${map.size + 1}`);
    return map.get(token)!;
  });
  return out;
}

function expectSameDom(actualNew: string, expectedOld: string, label = "DOM"): void {
  const a = normalizeDom(actualNew);
  const b = normalizeDom(expectedOld);
  if (a === b) return;
  let i = 0;
  const n = Math.min(a.length, b.length);
  while (i < n && a[i] === b[i]) i++;
  const from = Math.max(0, i - 150);
  throw new Error(
    `${label} 不一致（首个差异位置 ${i}）\n--- 旧(JS) ---\n${b.slice(from, i + 260)}\n--- 新(TS) ---\n${a.slice(from, i + 260)}`
  );
}

/* --------------------------------- 挂载与驱动 --------------------------------- */

interface Pair {
  oldHost: HTMLElement;
  newHost: HTMLElement;
  oldEs: () => FakeEventSource;
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
  const oldHost = document.createElement("div");
  const newHost = document.createElement("div");
  document.body.appendChild(oldHost);
  document.body.appendChild(newHost);
  let oldRoot: Root | null = null;
  let newRoot: Root | null = null;
  act(() => {
    oldRoot = createRoot(oldHost);
    oldRoot.render(React.createElement(ChatPanelJs, props));
    newRoot = createRoot(newHost);
    newRoot.render(React.createElement(ChatPanelTs, props));
  });
  // watch/listRuns 等异步链放行（两个宏等待确保 then 链走完）
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  if (!oldRoot || !newRoot) throw new Error("mount 失败");

  const oldEs = (): FakeEventSource => {
    const found = [...FakeEventSource.instances].reverse().find((es) => !es.closed);
    if (!found) throw new Error("旧侧无未关闭的 EventSource");
    return found;
  };
  const emitNew = (frame: Record<string, unknown>): void => {
    for (const listener of [...bridgeListeners]) listener(frame);
  };
  const dispose = (): void => {
    act(() => {
      oldRoot!.unmount();
      newRoot!.unmount();
    });
  };
  activeDisposers.push(dispose);
  return { oldHost, newHost, oldEs, emitNew, dispose };
}

/** 双侧同步握手：心跳刷新 + connected（无 id 帧形态，与线上一致） */
function handshakeBoth(pair: Pair): void {
  act(() => {
    pair.oldEs().heartbeat();
    pair.emitNew({ type: "op:heartbeat", at: "2026-10-21T00:00:00.000Z" });
    pair.oldEs().message(0, { type: "connected", data: { streamId: "s1", cursor: 0 } });
    pair.emitNew({ type: "connected", data: { streamId: "s1", cursor: 0 } });
  });
}

/** 双侧同步喂带游标的事件帧 */
function feedBoth(pair: Pair, eventId: number, payload: Record<string, unknown>): void {
  act(() => {
    pair.oldEs().message(eventId, payload);
    pair.emitNew({ id: eventId, ...payload });
  });
}

/** 流式渲染排空：rAF 揭示 + 80ms 执行流 debounce + 微任务链 */
async function settle(pair: Pair): Promise<void> {
  act(() => {
    flushFrames();
    vi.advanceTimersByTime(120);
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expectSameDom(pair.newHost.innerHTML, pair.oldHost.innerHTML);
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
 * 双侧同步发送一条消息并等待 admission 成功（旧 fetch / 新 IPC 同形应答 accepted+runId）。
 * 事件流开场的正确驱动方式：run_admitted/agent_started 不置 busy，冷态喂 token 会被
 * ensureAssistant 门丢弃、.stop-btn/.pending-send-btn 不渲染——必须经真实发送路径驱动。
 */
async function sendBoth(pair: Pair, text: string): Promise<void> {
  promptReply = { ok: true, status: 200, json: async () => ({ accepted: true, runId: "r1" }) };
  promptInvokeReply = () => ({ ok: true, status: 200, data: { accepted: true, runId: "r1" } });
  typeInto(pair.newHost, text);
  typeInto(pair.oldHost, text);
  clickButton(pair.newHost, ".send-btn");
  clickButton(pair.oldHost, ".send-btn");
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  if (!pair.newHost.querySelector(".stop-btn") || !pair.oldHost.querySelector(".stop-btn")) {
    throw new Error("sendBoth 后 .stop-btn 未渲染（admission 未置 busy）");
  }
}

/* --------------------------------- 事件流样本 --------------------------------- */

const EV_RUN_ADMITTED = { type: "run_admitted", data: { runId: "r1" } };
const EV_AGENT_STARTED = { type: "agent_started", data: {} };
const EV_TOKEN_A = { type: "token", data: { text: "正在整理要点。" } };
const EV_TOKEN_B = { type: "token", data: { text: "第二步执行完成。" } };
const EV_TOOL_START = { type: "tool_start", data: { name: "bash", toolCallId: "t1", input: "ls" } };
const EV_TOOL_OUTPUT = { type: "tool_output", data: { name: "bash", toolCallId: "t1", output: "报告.docx" } };
const EV_TOOL_END = { type: "tool_end", data: { name: "bash", toolCallId: "t1", result: "done" } };
const EV_STATS = { type: "stats", data: { tokens: { input: 1200, output: 3400 }, cost: 0.02 } };
const EV_AGENT_END = { type: "agent_end", data: {} };
const EV_RUN_FINISHED = {
  type: "run_finished",
  data: {
    runId: "r1",
    status: "completed",
    finalText: "正在整理要点。第二步执行完成。",
    artifacts: [{ id: "a1", name: "报告.docx", path: "D:/ws/报告.docx", kind: "docx", published: false }],
    references: [],
    verificationStatus: "not_checked",
  },
};

/* --------------------------------- A：双侧全 DOM 对拍 --------------------------------- */

describe("批6d-3 主组件编排 全 DOM 双侧同流", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: BASE, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
    FakeEventSource.instances.length = 0;
    fetchCalls.length = 0;
    bridgeInvokeCalls.length = 0;
    bridgeWatchCalls.length = 0;
    bridgeStopCalls.length = 0;
    bridgeListeners.clear();
    statusReply = {};
    promptReply = { ok: false, status: 404, json: async () => ({ error: "请求失败" }) };
    abortReply = { ok: true, status: 200, json: async () => ({ cancelled: true }) };
    runsFetchReply = null;
    runsListInvokeReply = null;
    promptInvokeReply = null;
    JsStreamBudget.resetStreams();
    TsStreamBudget.resetStreams();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    while (activeDisposers.length) activeDisposers.pop()!();
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("A1 挂载空态与 connected 握手 DOM 一致", async () => {
    const pair = await mountPair();
    await settle(pair);
    handshakeBoth(pair);
    await settle(pair);
    pair.dispose();
  });

  it("A2 一轮完整 Run：发送 admission 成功 → 流式 / 工具 / 终态三阶段 DOM 一致", async () => {
    const pair = await mountPair();
    handshakeBoth(pair);
    await settle(pair);
    // send 驱动开场：busy 置真 + activeRunIdRef=r1（run_admitted/agent_started 不置 busy，
    // 冷态喂 token 会被 ensureAssistant 门丢弃——必须经真实发送路径驱动）
    await sendBoth(pair, "整理要点");
    feedBoth(pair, 1, EV_RUN_ADMITTED);
    feedBoth(pair, 2, EV_AGENT_STARTED);
    feedBoth(pair, 3, EV_TOKEN_A);
    feedBoth(pair, 4, EV_TOKEN_B);
    await settle(pair); // 流式阶段（揭示排空后对比）
    expect(pair.oldHost.innerHTML).toContain("正在整理要点");
    expect(pair.newHost.innerHTML).toContain("正在整理要点");
    feedBoth(pair, 5, EV_TOOL_START);
    feedBoth(pair, 6, EV_TOOL_OUTPUT);
    feedBoth(pair, 7, EV_TOOL_END);
    feedBoth(pair, 8, EV_STATS);
    await settle(pair); // 工具 + 用量阶段
    feedBoth(pair, 9, { type: "assistant_final", data: { text: EV_RUN_FINISHED.data.finalText } });
    feedBoth(pair, 10, EV_AGENT_END);
    feedBoth(pair, 11, EV_RUN_FINISHED);
    await settle(pair); // 终态 + 结果卡
    pair.dispose();
  });

  it("A3 replayRecover 缓冲冲刷：探测窗口内事件入缓冲，probe 返回 live run 后冲刷生效（6b 遗留）", async () => {
    statusReply = { runtimeFlags: { replayRecover: true } };
    await Promise.all([JsFlags.initRuntimeFlags(), TsFlags.initRuntimeFlags()]);
    // probe 的 listRuns 挂起：旧 /api/runs、新 op:runs:list 各自可控 deferred
    // （旧侧 resolve 值是 res.json() 的 body 形状，非 Response 对象）
    let resolveOldRuns: ((value: Record<string, unknown>) => void) | null = null;
    let resolveNewRuns: ((value: InvokeResultLike) => void) | null = null;
    runsFetchReply = () => ({
      ok: true,
      status: 200,
      json: () => new Promise((resolve) => { resolveOldRuns = resolve; }),
    });
    runsListInvokeReply = () => new Promise((resolve) => { resolveNewRuns = resolve; }) as unknown as InvokeResultLike;

    // probe 返回 live run（clientId 匹配 + running 状态命中 activeStatuses）
    const LIVE_RUN = { id: "r-live", clientId: CLIENT, status: "running", startedAt: "2026-10-21T00:00:00.000Z" };
    const pair = await mountPair();
    handshakeBoth(pair); // connected 帧穿透缓冲（replayProbe 过滤白名单）
    // 探测未返回：事件全部入缓冲，DOM 不出现运行内容
    // （缓冲事件不带 runId：probe 命中后 activeRunIdRef 锚定 r-live，带 r1 的事件会被归属过滤丢弃）
    feedBoth(pair, 1, EV_AGENT_STARTED);
    feedBoth(pair, 2, EV_TOKEN_A);
    await settle(pair);
    expect(pair.newHost.innerHTML).not.toContain("正在整理要点");
    expect(pair.oldHost.innerHTML).not.toContain("正在整理要点");

    // probe 返回 → setBusy(true) + runInProgressRef 置真 → 缓冲冲刷：
    // token 经 replayRecoverGate 过 ensureAssistant 门生效
    await act(async () => {
      resolveOldRuns!({ runs: [LIVE_RUN] });
      resolveNewRuns!({ ok: true, status: 200, data: { runs: [LIVE_RUN] } });
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
    act(() => { flushFrames(); vi.advanceTimersByTime(120); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await settle(pair);
    expect(pair.oldHost.innerHTML).toContain("正在整理要点");
    expect(pair.newHost.innerHTML).toContain("正在整理要点");
    pair.dispose();
  });

  it("A4 中断语义：stop 受理后 agent_error 走 abort 收尾，无错误徽记（6b 遗留）", async () => {
    const pair = await mountPair();
    handshakeBoth(pair);
    await sendBoth(pair, "执行导出");
    feedBoth(pair, 1, EV_RUN_ADMITTED);
    feedBoth(pair, 2, EV_AGENT_STARTED);
    feedBoth(pair, 3, EV_TOKEN_A);
    await settle(pair);
    clickButton(pair.newHost, ".stop-btn");
    clickButton(pair.oldHost, ".stop-btn");
    // abort 受理（cancelled:true 不重置 stopping）：中断中徽记 + 系统提示一致
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    await settle(pair);
    // 9s：10s 确认定时器未到，无 stop-unconfirmed 提示
    act(() => { vi.advanceTimersByTime(9_000); });
    await settle(pair);
    // agent_error（Request aborted）→ abort 分支：finalizeStopped、无错误文案
    feedBoth(pair, 4, { type: "agent_error", data: { message: "Request aborted" } });
    await settle(pair);
    expect(pair.newHost.innerHTML).not.toContain("模型调用失败");
    expect(pair.oldHost.innerHTML).not.toContain("模型调用失败");
    // 再推 2s（越过原 10s 定时点）：abort 收尾已清定时器，不出现未确认提示
    act(() => { vi.advanceTimersByTime(2_000); });
    await settle(pair);
    expect(pair.newHost.innerHTML).not.toContain("10 秒内确认收尾");
    expect(pair.oldHost.innerHTML).not.toContain("10 秒内确认收尾");
    pair.dispose();
  });

  it("A5 flushQueued 队列续跑：busy 排队 → run_finished 触发续跑 → admission 失败收尾（6b 遗留）", async () => {
    const pair = await mountPair();
    handshakeBoth(pair);
    // agent_retry 开场置 busy（setBusy(true) + 建 retry 气泡）：冷态下 .pending-send-btn 不渲染
    feedBoth(pair, 1, { type: "agent_retry", data: { attempt: 1, maxAttempts: 3, category: "network" } });
    await settle(pair);
    typeInto(pair.newHost, "排队消息");
    typeInto(pair.oldHost, "排队消息");
    clickButton(pair.newHost, ".pending-send-btn");
    clickButton(pair.oldHost, ".pending-send-btn");
    await settle(pair); // 排队态：queued 气泡 + 队列条 + 系统提示
    feedBoth(pair, 4, EV_RUN_FINISHED);
    await settle(pair); // run_finished → flushQueued(true) 出队（450ms 定时未到）
    act(() => { vi.advanceTimersByTime(450); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    await settle(pair); // 续跑 send → admission 404 → error 气泡 + 请求失败
    expect(pair.oldHost.innerHTML).toContain("请求失败");
    expect(pair.newHost.innerHTML).toContain("请求失败");
    pair.dispose();
  });
});

/* --------------------------------- B：新侧 IPC 形态背书 --------------------------------- */

describe("批6d-3 新侧 IPC 形态背书（6c 过渡差异）", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: BASE, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
    FakeEventSource.instances.length = 0;
    fetchCalls.length = 0;
    bridgeInvokeCalls.length = 0;
    bridgeWatchCalls.length = 0;
    bridgeStopCalls.length = 0;
    bridgeListeners.clear();
    statusReply = {};
    runsFetchReply = null;
    runsListInvokeReply = null;
    promptInvokeReply = null;
    JsStreamBudget.resetStreams();
    TsStreamBudget.resetStreams();
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
        return states[9] as boolean; // useState 序数 9 = connected（声明序同旧组件，批6b 注记）
      }
      if (fiber.child) queue.push(fiber.child);
      if (fiber.sibling) queue.push(fiber.sibling);
    }
    throw new Error("ChatPanel fiber 未找到");
  }

  it("B1 stop 走 op:agent:abort 通道，不发起 fetch POST", async () => {
    const pair = await mountPair();
    handshakeBoth(pair);
    await sendBoth(pair, "执行导出");
    feedBoth(pair, 1, EV_RUN_ADMITTED);
    feedBoth(pair, 2, EV_AGENT_STARTED);
    feedBoth(pair, 3, EV_TOKEN_A);
    await settle(pair);
    const fetchCallsBefore = fetchCalls.length;
    clickButton(pair.newHost, ".stop-btn");
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(bridgeInvokeCalls.some((call) => call.channel === "op:agent:abort")).toBe(true);
    // 新增 fetch 全部与 abort 无关（旧侧未点 stop，无 /api/agent/abort POST）
    expect(fetchCalls.slice(fetchCallsBefore).some((url) => url.includes("/api/agent/abort"))).toBe(false);
    feedBoth(pair, 4, { type: "agent_error", data: { message: "Request aborted" } });
    // 新侧专属通道背书：旧侧未点 stop（stoppingRef 假），agent_error 走错误分支，
    // 两侧 DOM 有意不同——不做 expectSameDom 对比，只排空渲染后断言新侧无错误徽记
    act(() => { flushFrames(); vi.advanceTimersByTime(120); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(pair.newHost.innerHTML).not.toContain("模型调用失败");
    pair.dispose();
  });

  it("B2 connecting 态 connected 不即时置 false：watch 未受理期间置真且不闪断", async () => {
    // watch 挂起（桥受理延迟）：组件处于 connecting 态
    let resolveWatch: ((value: { ok: boolean }) => void) | null = null;
    const originalWatch = (window.opDesktop as unknown as Record<string, unknown>).watchThreadEvents;
    (window.opDesktop as unknown as Record<string, unknown>).watchThreadEvents = () =>
      new Promise((resolve) => { resolveWatch = resolve; });
    const pair = await mountPair();
    expect(readNewConnected(pair.newHost)).toBe(false);
    // connecting 态喂 connected 帧 → 置真
    act(() => {
      pair.emitNew({ type: "op:heartbeat", at: "2026-10-21T00:00:00.000Z" });
      pair.emitNew({ type: "connected", data: { streamId: "s1", cursor: 0 } });
    });
    expect(readNewConnected(pair.newHost)).toBe(true);
    // 心跳保活推进 25s（5s × 5 tick）：watchdog 安静，connected 不被闪断
    for (let i = 0; i < 5; i++) {
      act(() => {
        pair.emitNew({ type: "op:heartbeat", at: "2026-10-21T00:00:05.000Z" });
        vi.advanceTimersByTime(5_000);
      });
    }
    expect(readNewConnected(pair.newHost)).toBe(true);
    // 桥断线重连窗口（op:stream-state retrying）→ 即时置断开，重连由桥负责
    act(() => {
      pair.emitNew({ type: "op:stream-state", data: { state: "retrying", detail: "SSE 连接被服务端关闭" } });
    });
    expect(readNewConnected(pair.newHost)).toBe(false);
    // 桥内重连完成（watch 受理 + 新 connected 帧）→ 恢复真值
    await act(async () => {
      resolveWatch!({ ok: true });
      await Promise.resolve(); await Promise.resolve();
    });
    act(() => {
      pair.emitNew({ type: "connected", data: { streamId: "s1", cursor: 0 } });
    });
    expect(readNewConnected(pair.newHost)).toBe(true);
    (window.opDesktop as unknown as Record<string, unknown>).watchThreadEvents = originalWatch;
    pair.dispose();
  });
});
