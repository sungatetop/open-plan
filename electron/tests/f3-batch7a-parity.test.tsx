// @vitest-environment jsdom
/**
 * F3 批7a 对拍：SearchChat.jsx（RetrievalChat，知识库 / Skills 入口共用的只读 Chat）逐行等价迁移。
 *
 * 形态（沿 6d-3 双侧同流基建）：
 *   - 旧侧 client/components/SearchChat.jsx（内含旧 ChatPanel.jsx，SSE transport + fetch），
 *     新侧 features/chat/retrieval-chat.tsx（内含 features/chat/panel.tsx，IPC transport +
 *     window.opDesktop 假桥）——同一 props 同流分送，全 DOM 归一化逐字节比较。
 *   - RetrievalChat 是 ChatPanel 的薄包装（thread 持久化 / referenceKey 记忆 / promote 合并），
 *     对拍重点是包装语义而非 ChatPanel 内部（6d-3 已覆盖）。
 *
 * 场景：
 *   A1 挂载空态（预置 thread）+ connected 握手全 DOM 一致（含壳/标题/副标题/关闭按钮/
 *      面板标题 Chat / chat 模式徽记）
 *   A2 embedded 历史派生 lastPrompt → promote 合并语义：payload.references 为空回退
 *      initialReferences、contextText 以 \n\n 拼接，双侧 payload deep-equal
 *   A3 payload.references 非空时保留原引用不回退
 *   A4 onClose 有无的关闭按钮渲染与点击回调
 *   A5 thread 生成与持久化（storageKey 按 scope 分键，两侧同前缀格式）
 *   A6 references 变化（referenceKey 变）→ promote 使用新 initialReferences
 *
 * 确定性：fake timers 冻结 Date/performance；rAF 手动队列双侧共用；每用例累计虚拟
 * 时钟 < 20s（静默 watchdog 阈值）；thread 一律预置固定值防两侧各自生成漂移。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const BASE = 1_700_000_000_000;
const CLIENT = "parity-client";
const WORKSPACE = "D:/ws/parity";
const RTHREAD = "retrieval-fixed";
const USER_TEXT = "这条意见的依据是什么";

const MODELS = [
  { id: "deepseek-chat", provider: "deepseek", name: "DeepSeek Chat", contextWindow: 64000 },
];
const REFS_A = [{ id: "r1", kind: "file", target: "docs/总规.txt" }];
const REFS_B = [{ id: "r2", kind: "file", target: "docs/控规.txt" }];
const SEED_TS = "2026-10-21T09:00:00.000Z";

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
let runsFetchReply: (() => RawResponse) | null = null;

window.fetch = (async (input: unknown) => {
  const url = typeof input === "string" ? input : String((input as { url?: string } | null)?.url ?? input);
  fetchCalls.push(url);
  if (url.includes("/api/status")) {
    return { ok: true, status: 200, json: async () => statusReply } as unknown as Response;
  }
  if (url.includes("/api/runs") && runsFetchReply) return runsFetchReply() as unknown as Response;
  return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
}) as typeof fetch;

// 新侧假桥：invoke 按通道给罐头应答（HTTP 语义 ok:false 不 reject）；事件经 onEvent 推送
const bridgeListeners = new Set<(event: Record<string, unknown>) => void>();
const bridgeInvokeCalls: Array<{ channel: string; payload: unknown }> = [];
const bridgeWatchCalls: unknown[] = [];
const bridgeStopCalls: unknown[] = [];
let runsListInvokeReply: (() => InvokeResultLike) | null = null;

function defaultInvokeReply(channel: string): InvokeResultLike {
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

const JsSearchChat = await import("../../client/src/components/SearchChat.jsx");
const TsRetrievalChat = await import("../src/renderer/features/chat/retrieval-chat");
const JsStreamBudget = await import("../../client/src/stream-budget.js");
const TsStreamBudget = await import("../src/renderer/lib/stream-budget");

// @ts-expect-error 旧 JS 模块；组件走 Record 宽容视图（JS 边界无静态约束）
const RetrievalChatJs: React.ComponentType<Record<string, unknown>> = JsSearchChat.default;
// 强约束组件经 unknown 二次转换到宽容视图（测试传参与生产一致，静态约束从宽）
const RetrievalChatTs = TsRetrievalChat.default as unknown as React.ComponentType<Record<string, unknown>>;

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

interface RetrievalPair {
  oldHost: HTMLElement;
  newHost: HTMLElement;
  oldEs: () => FakeEventSource;
  emitNew: (frame: Record<string, unknown>) => void;
  rerender: (shared: Record<string, unknown>) => void;
  oldPromote: ReturnType<typeof vi.fn>;
  newPromote: ReturnType<typeof vi.fn>;
  oldClose: ReturnType<typeof vi.fn>;
  newClose: ReturnType<typeof vi.fn>;
  dispose: () => void;
}

const activeDisposers: Array<() => void> = [];

/**
 * 双侧挂载 RetrievalChat（对拍 props 完全同流，promote/onClose 各侧独立 spy 便于
 * 断言合并语义）。shared 覆盖默认 props；onClose: undefined 可显式关掉关闭按钮。
 */
async function mountRetrievalPair(shared: Record<string, unknown> = {}): Promise<RetrievalPair> {
  const oldPromote = vi.fn();
  const newPromote = vi.fn();
  const oldClose = vi.fn();
  const newClose = vi.fn();
  const build = (promote: unknown, close: unknown, override: Record<string, unknown> = {}): Record<string, unknown> => ({
    clientId: CLIENT,
    workspace: WORKSPACE,
    models: MODELS,
    contextLabel: "规划文本.docx",
    contextText: "以下是当前章节内容。",
    references: REFS_A,
    onClose: close,
    onPromoteToAgent: promote,
    ...override,
  });
  const oldHost = document.createElement("div");
  const newHost = document.createElement("div");
  document.body.appendChild(oldHost);
  document.body.appendChild(newHost);
  let oldRoot: Root | null = null;
  let newRoot: Root | null = null;
  act(() => {
    oldRoot = createRoot(oldHost);
    oldRoot.render(React.createElement(RetrievalChatJs, build(oldPromote, oldClose, shared)));
    newRoot = createRoot(newHost);
    newRoot.render(React.createElement(RetrievalChatTs, build(newPromote, newClose, shared)));
  });
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
  const rerender = (next: Record<string, unknown>): void => {
    act(() => {
      oldRoot!.render(React.createElement(RetrievalChatJs, build(oldPromote, oldClose, next)));
      newRoot!.render(React.createElement(RetrievalChatTs, build(newPromote, newClose, next)));
    });
  };
  const dispose = (): void => {
    act(() => {
      oldRoot!.unmount();
      newRoot!.unmount();
    });
  };
  activeDisposers.push(dispose);
  return { oldHost, newHost, oldEs, emitNew, rerender, oldPromote, newPromote, oldClose, newClose, dispose };
}

/** 双侧同步握手：心跳刷新 + connected（无 id 帧形态，与线上一致） */
function handshakeBoth(pair: RetrievalPair): void {
  act(() => {
    pair.oldEs().heartbeat();
    pair.emitNew({ type: "op:heartbeat", at: "2026-10-21T00:00:00.000Z" });
    pair.oldEs().message(0, { type: "connected", data: { streamId: "s1", cursor: 0 } });
    pair.emitNew({ type: "connected", data: { streamId: "s1", cursor: 0 } });
  });
}

/** 流式渲染排空：rAF 揭示 + 80ms 执行流 debounce + 微任务链，随后全 DOM 对比 */
async function settle(pair: RetrievalPair): Promise<void> {
  act(() => {
    flushFrames();
    vi.advanceTimersByTime(120);
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expectSameDom(pair.newHost.innerHTML, pair.oldHost.innerHTML);
}

function clickButton(host: HTMLElement, selector: string): void {
  const button = host.querySelector(selector);
  if (!button) throw new Error(`按钮未找到: ${selector}`);
  act(() => {
    (button as HTMLButtonElement).click();
  });
}

/** 双侧 promote 合并 payload（toEqual 比较，noUncheckedIndexedAccess 下取参用可选链） */
function firstPayload(spy: ReturnType<typeof vi.fn>): unknown {
  return spy.mock.calls[0]?.[0];
}

function payloadAt(spy: ReturnType<typeof vi.fn>, index: number): unknown {
  return spy.mock.calls[index]?.[0];
}

/** 预置固定 retrieval thread + embedded 历史消息（双侧同流读取同一份存储） */
function seedThread(messages: unknown[]): void {
  localStorage.setItem(`oaw_retrieval_thread_knowledge`, RTHREAD);
  localStorage.setItem(`oaw_embedded_messages_${RTHREAD}`, JSON.stringify(messages));
}

/* --------------------------------- A：双侧全 DOM 对拍 --------------------------------- */

describe("批7a RetrievalChat 双侧同流", () => {
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
    localStorage.clear();
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

  it("A1 挂载空态与 connected 握手全 DOM 一致（壳/标题/副标题/关闭按钮/面板标题）", async () => {
    seedThread([]);
    const pair = await mountRetrievalPair();
    await settle(pair);
    expect(pair.oldHost.querySelector(".retrieval-chat-shell")).toBeTruthy();
    expect(pair.oldHost.querySelector(".retrieval-chat-title")?.textContent).toBe("检索 Chat");
    expect(pair.oldHost.querySelector(".retrieval-chat-subtitle")?.textContent).toBe("只读搜索与说明 · 不修改文件");
    expect(pair.oldHost.querySelector(".retrieval-chat-head .btn-xs")?.textContent).toBe("关闭");
    expect(pair.oldHost.textContent).toContain("Chat");
    handshakeBoth(pair);
    await settle(pair);
    pair.dispose();
  });

  it("A2 embedded 历史派生 lastPrompt：promote 合并语义（引用回退 initialReferences、contextText 拼接）双侧一致", async () => {
    seedThread([
      { id: "m1", role: "user", text: USER_TEXT, ts: SEED_TS },
      { id: "m2", role: "assistant", text: "依据是规划文本第 3 章。", ts: SEED_TS },
    ]);
    const pair = await mountRetrievalPair();
    handshakeBoth(pair);
    await settle(pair);
    expect(pair.oldHost.querySelector(".chat-promote-btn")).toBeTruthy();
    expect(pair.newHost.querySelector(".chat-promote-btn")).toBeTruthy();
    clickButton(pair.oldHost, ".chat-promote-btn");
    clickButton(pair.newHost, ".chat-promote-btn");
    expect(pair.oldPromote).toHaveBeenCalledTimes(1);
    expect(pair.newPromote).toHaveBeenCalledTimes(1);
    expect(pair.newPromote.mock.calls[0]?.[0]).toEqual(pair.oldPromote.mock.calls[0]?.[0]);
    // 合并语义：lastPrompt.references 为空 → 回退 initialReferences；contextText 以 \n\n 拼接
    expect(pair.newPromote.mock.calls[0]?.[0]).toEqual({
      text: USER_TEXT,
      references: REFS_A,
      contextText: "以下是当前章节内容。\n\n以下是当前章节内容。",
    });
    pair.dispose();
  });

  it("A3 lastPrompt 自带引用时保留原引用不回退", async () => {
    const ownRefs = [{ id: "r9", kind: "file", target: "docs/意见.txt" }];
    seedThread([
      { id: "m1", role: "user", text: USER_TEXT, references: ownRefs, ts: SEED_TS },
      { id: "m2", role: "assistant", text: "见引用文件。", ts: SEED_TS },
    ]);
    const pair = await mountRetrievalPair();
    handshakeBoth(pair);
    await settle(pair);
    clickButton(pair.oldHost, ".chat-promote-btn");
    clickButton(pair.newHost, ".chat-promote-btn");
    expect(pair.newPromote.mock.calls[0]?.[0]).toEqual(pair.oldPromote.mock.calls[0]?.[0]);
    expect((firstPayload(pair.newPromote) as { references: unknown }).references).toEqual(ownRefs);
    pair.dispose();
  });

  it("A4 onClose 有无的关闭按钮渲染与点击回调", async () => {
    seedThread([]);
    const pair = await mountRetrievalPair();
    await settle(pair);
    clickButton(pair.oldHost, ".retrieval-chat-head .btn-xs");
    clickButton(pair.newHost, ".retrieval-chat-head .btn-xs");
    expect(pair.oldClose).toHaveBeenCalledTimes(1);
    expect(pair.newClose).toHaveBeenCalledTimes(1);
    pair.dispose();
    // 不传 onClose：头部无关闭按钮（两侧一致）
    const pair2 = await mountRetrievalPair({ onClose: undefined });
    await settle(pair2);
    expect(pair2.oldHost.querySelector(".retrieval-chat-head .btn-xs")).toBeNull();
    expect(pair2.newHost.querySelector(".retrieval-chat-head .btn-xs")).toBeNull();
    pair2.dispose();
  });

  it("A5 thread 生成与持久化：storageKey 按 scope 分键、两侧同前缀格式（分侧单测防 id 漂移）", async () => {
    // 旧侧：清空存储后挂载 → 生成并落盘
    localStorage.clear();
    const oldHost = document.createElement("div");
    document.body.appendChild(oldHost);
    let oldRoot: Root | null = null;
    act(() => {
      oldRoot = createRoot(oldHost);
      oldRoot!.render(React.createElement(RetrievalChatJs, { clientId: CLIENT }));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const oldSaved = localStorage.getItem("oaw_retrieval_thread_knowledge");
    expect(oldSaved).toMatch(/^retrieval-knowledge-.+/);
    act(() => { oldRoot!.unmount(); });
    localStorage.clear();
    document.body.innerHTML = "";

    // 新侧：同样的清空 → 生成 → 落盘，格式同前缀
    const newHost = document.createElement("div");
    document.body.appendChild(newHost);
    let newRoot: Root | null = null;
    act(() => {
      newRoot = createRoot(newHost);
      newRoot!.render(React.createElement(RetrievalChatTs, { clientId: CLIENT }));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const newSaved = localStorage.getItem("oaw_retrieval_thread_knowledge");
    expect(newSaved).toMatch(/^retrieval-knowledge-.+/);
    act(() => { newRoot!.unmount(); });
    document.body.innerHTML = "";

    // scope 分键：scope="skills" → oaw_retrieval_thread_skills
    const skillsHost = document.createElement("div");
    document.body.appendChild(skillsHost);
    let skillsRoot: Root | null = null;
    act(() => {
      skillsRoot = createRoot(skillsHost);
      skillsRoot!.render(React.createElement(RetrievalChatTs, { clientId: CLIENT, scope: "skills", title: "Skills 检索" }));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(localStorage.getItem("oaw_retrieval_thread_skills")).toMatch(/^retrieval-skills-.+/);
    act(() => { skillsRoot!.unmount(); });
    document.body.innerHTML = "";
  });

  it("A6 references 变化（referenceKey 变）→ promote 使用新 initialReferences", async () => {
    seedThread([{ id: "m1", role: "user", text: USER_TEXT, ts: SEED_TS }]);
    const pair = await mountRetrievalPair();
    handshakeBoth(pair);
    await settle(pair);
    clickButton(pair.oldHost, ".chat-promote-btn");
    clickButton(pair.newHost, ".chat-promote-btn");
    expect((firstPayload(pair.newPromote) as { references: unknown }).references).toEqual(REFS_A);
    // rerender：references 换成 REFS_B（referenceKey 变 → initialReferences 更新）
    pair.rerender({ references: REFS_B });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    clickButton(pair.oldHost, ".chat-promote-btn");
    clickButton(pair.newHost, ".chat-promote-btn");
    expect(pair.newPromote).toHaveBeenCalledTimes(2);
    expect((payloadAt(pair.newPromote, 1) as { references: unknown }).references).toEqual(REFS_B);
    expect(pair.oldPromote).toHaveBeenCalledTimes(2);
    expect((payloadAt(pair.oldPromote, 1) as { references: unknown }).references).toEqual(REFS_B);
    expect(payloadAt(pair.newPromote, 1)).toEqual(payloadAt(pair.oldPromote, 1));
    pair.dispose();
  });
});
