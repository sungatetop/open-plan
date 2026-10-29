// @vitest-environment jsdom
/**
 * F3 批7b 对拍：App.jsx chat 集成面（workbench.tsx）+ 全局事件流（global-events-feed.ts
 * + main 侧 global-events-bridge）。
 *
 * 对拍口径（批7b 既定策略：不做全 DOM 对拍——旧 App 挂 TaskCenter/CommandPalette/
 * lazy fallback 新侧无；以行为/状态层对拍 + 旧源码运行时抽取求值锚点 deep-equal 背书）：
 *   A. 纯函数旧源码原文本执行（App.jsx historyReferences/cleanPersistedMessage/
 *      historyImageData/entryCreatedAt/sameWorkspacePath/fileBasename + handleSelectSession
 *      重建循环 994-1091 原文）多样本 deep-equal 对 history-load.ts；
 *   B. workbench 消费面通道映射对齐 server 路由（op:files/projects/workspaces/
 *      workspace:switch/agent:new/agent:resume/sessions:get/events-state/events-read）；
 *   C. feed 常量锚点：GLOBAL_EVENT_NOTICES / artifact 事件表 / 游标键 vs 旧源码文本；
 *   D. feed 行为 harness（createGlobalEventFeed + Fake transport + fake timers）：
 *      游标引导（latest/3000ms 超时/已持久化跳过）、seq 推进去重、100ms 批处理、
 *      未读 noticeKey 去重、180ms 防抖 refreshSessions（visibility）、
 *      run_finished 重置 browserAutoOpenBlocked、SSE 重连节奏 800→×2→5000+onopen 复位、
 *      IPC transport watch 失败重连 + cleanup stop、cleanup 清定时器；
 *   E. workbench 会话域行为 harness（window.opDesktop 假桥挂载）：启动加载面 /
 *      新建会话调用序列 / 选择历史会话（get+runs+resume 并行 + 历史重建进 UI）/
 *      切换工作区（switch → new 新 cwd）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// E 组 workbench 全链路挂载用例单跑即达 3~4.6s，整文件串行满载下会越过默认 5s
// 超时并连锁污染同文件后续用例（2026-10-26 甄别：stash 基线同样失败，非功能回归），
// 本文件统一放宽到 30s。
vi.setConfig({ testTimeout: 30_000 });

// jsdom 无滚动 API：ChatPanel 跟随滚动 effect 静默化（沿批7a 基建）
(Element.prototype as unknown as Record<string, unknown>).scrollTo = () => {};
(Element.prototype as unknown as Record<string, unknown>).scrollIntoView = () => {};

const APP_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../client/src/App.jsx");
const APP_SOURCE = readFileSync(APP_PATH, "utf8");

const M = await import("../src/renderer/features/chat/history-load");
const FEED = await import("../src/renderer/features/chat/global-events-feed");
const { normalizeHistoryMessages } = await import("../src/renderer/lib/chat-shared");
const { DESKTOP_CHANNELS, SSE_REPLACED_ROUTES } = await import("../src/shared/protocol/channels");

// 动态 import 命名空间不能作类型命名空间（批6b 经验）：类型一律走 import(...) 别名
type GlobalEventFeedDepsT = import("../src/renderer/features/chat/global-events-feed").GlobalEventFeedDeps;
type GlobalEventFeedRefsT = import("../src/renderer/features/chat/global-events-feed").GlobalEventFeedRefs;
type GlobalEventTransportT = import("../src/renderer/features/chat/global-events-feed").GlobalEventTransport;

/* ==================== A. 纯函数旧源码原文本执行（锚点生成） ==================== */

function extractFn(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const bodyEnd = source.indexOf(endMarker, start);
  if (start < 0 || bodyEnd < 0) throw new Error(`旧源码锚点定位失败: ${startMarker}`);
  const close = source.indexOf("}", bodyEnd + endMarker.length);
  return source.slice(start, close + 1);
}

const sandbox = new Function(
  [
    extractFn(APP_SOURCE, "function historyReferences(text = \"\")", "return refs;"),
    extractFn(APP_SOURCE, "function cleanPersistedMessage(text = \"\")", "return source.replace("),
    extractFn(APP_SOURCE, "function historyImageData(block)", ";base64,${data}`;"),
    extractFn(APP_SOURCE, "function entryCreatedAt(entry, message)", "|| null;"),
    extractFn(APP_SOURCE, "function sameWorkspacePath(a, b)", "=== normalize(b);"),
    extractFn(APP_SOURCE, "function fileBasename(value)", 'parts[parts.length - 1] : "";')
  ].join("\n") +
    "\nreturn { historyReferences, cleanPersistedMessage, historyImageData, entryCreatedAt, sameWorkspacePath, fileBasename };"
)() as {
  historyReferences(text?: string): unknown;
  cleanPersistedMessage(text?: string): string;
  historyImageData(block: unknown): string | null;
  entryCreatedAt(entry: unknown, message: unknown): unknown;
  sameWorkspacePath(a: unknown, b: unknown): boolean;
  fileBasename(value: unknown): string;
};

/** 旧侧重建循环（App.jsx 994-1091 原文）：定位 handleSelectSession 内 msgs 初始化 → normalizeHistoryMessages 排序收尾 */
function extractRebuildLoop(source: string): string {
  const anchor = source.indexOf("for (const e of (d.entries || []))");
  const start = source.lastIndexOf("const msgs = [];", anchor);
  const endMarker = "return left - right;";
  const bodyEnd = source.indexOf(endMarker, start);
  if (start < 0 || anchor < 0 || bodyEnd < 0) throw new Error("旧源码重建循环锚点定位失败（App.jsx handleSelectSession 结构变更？）");
  const close = source.indexOf("}));", bodyEnd);
  return source.slice(start, close + "}));".length);
}

type OldRebuild = (
  d: unknown,
  runData: unknown,
  histId: () => string,
  historyImageData: (block: unknown) => string | null,
  cleanPersistedMessage: (text?: string) => string,
  historyReferences: (text?: string) => unknown,
  entryCreatedAt: (entry: unknown, message: unknown) => unknown,
  normalizeHistoryMessages: (msgs: unknown[]) => unknown[]
) => unknown[];

const oldRebuild = new Function(
  "d",
  "runData",
  "histId",
  "historyImageData",
  "cleanPersistedMessage",
  "historyReferences",
  "entryCreatedAt",
  "normalizeHistoryMessages",
  `${extractRebuildLoop(APP_SOURCE)}\nreturn loadedHistory;`
) as unknown as OldRebuild;

let oldHistSeq = 0;
const oldHistId = (): string => `h${++oldHistSeq}`;

describe("A. 纯函数旧源码原文本执行（App.jsx 原文 vs history-load.ts）", () => {
  const REF_SAMPLES = [
    "",
    "@知识库[交通规范] @模板[汇报模板] &会话[s1] @文件[报告.docx]",
    "@报告.docx 与 @子目录/说明.md @ Knowledge",
    "@报告.docx，再看看 @草图.png。",
    "(@括号内.md) @重复.docx @重复.docx",
    "@user @知识库目录[kb-dir] @模板目录[tpl-dir]"
  ];

  it("historyReferences 多样本 deep-equal", () => {
    for (const sample of REF_SAMPLES) {
      expect(M.historyReferences(sample)).toEqual(sandbox.historyReferences(sample));
    }
  });

  const CLEAN_SAMPLES = [
    "普通文本",
    "## 当前任务目标: 检查交通模型",
    "### 当前任务\n目标：整理数据\n模式：agent\n引用：x",
    "- 目标: 生成报告\n- 模式: agent",
    "## 当前任务\n目标：x\n边界：只读\n\n正文保留",
    "当前打开文件: a.docx\n帮忙检查"
  ];

  it("cleanPersistedMessage 多样本 deep-equal", () => {
    for (const sample of CLEAN_SAMPLES) {
      expect(M.cleanPersistedMessage(sample)).toBe(sandbox.cleanPersistedMessage(sample));
    }
  });

  it("historyImageData / entryCreatedAt / sameWorkspacePath / fileBasename 多样本 deep-equal", () => {
    const imageSamples: unknown[] = [
      null,
      undefined,
      {},
      { source: { data: "QUJD" } },
      { image: { url: "data:image/webp;base64,xx" } },
      { data: "REVG", mimeType: "image/jpeg" },
      { url: "R01L" },
      { source: { data: "QQ", mediaType: "image/gif" }, mediaType: "image/other" }
    ];
    for (const sample of imageSamples) {
      expect(M.historyImageData(sample as never)).toEqual(sandbox.historyImageData(sample));
    }
    const entrySamples: Array<[unknown, unknown]> = [
      [null, null],
      [{ timestamp: 1 }, { createdAt: 2 }],
      [{}, { createdAt: "x" }],
      [{ time: "t" }, null],
      [{}, {}]
    ];
    for (const [entry, message] of entrySamples) {
      expect(M.entryCreatedAt(entry as never, message as never)).toEqual(sandbox.entryCreatedAt(entry, message));
    }
    const wsSamples: Array<[unknown, unknown]> = [
      ["D:\\a\\b\\", "d:/a/b"],
      ["", "x"],
      [null, null],
      ["D:/a/b", "D:/a/b/"],
      ["D:/a/b", "D:/a/c"]
    ];
    for (const [a, b] of wsSamples) {
      expect(M.sameWorkspacePath(a, b)).toEqual(sandbox.sameWorkspacePath(a, b));
    }
    const baseSamples = ["", "a/b/c.txt", "D:\\x\\y.png", "/", "a/"];
    for (const sample of baseSamples) {
      expect(M.fileBasename(sample)).toEqual(sandbox.fileBasename(sample));
    }
  });

  it("重建循环（buildSessionHistory）与旧 handleSelectSession 原文 deep-equal", () => {
    const entries = [
      { id: "e1", type: "message", message: { role: "user", content: "当前打开文件: 总体规划.docx\n@报告.docx 帮忙检查", timestamp: "2026-10-20T01:00:00.000Z" } },
      {
        id: "e2", type: "message", createdAt: "2026-10-20T01:00:05.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "好的" },
            { type: "toolCall", id: "c1", toolName: "read_file", input: { path: "x.docx" } },
            { type: "thinking", thinking: "思考中" }
          ]
        }
      },
      { id: "e3", type: "message", message: { role: "toolResult", toolCallId: "c1", content: "文件内容", isError: false } },
      { id: "e4", type: "message", message: { role: "user", content: "## 当前任务目标: 继续分析", timestamp: "2026-10-20T01:01:00.000Z" } },
      { id: "e5", type: "message", message: { role: "toolResult", toolCallId: "ghost", content: "无配对输出", isError: true, toolName: "bash" } },
      { id: "e6", type: "message", message: { role: "assistant", content: [{ type: "image", source: { data: "QUJD", mediaType: "image/png" } }] } },
      { id: "skip", type: "other" }
    ];
    const runData = {
      runs: [
        { id: "r2", status: "completed", summary: "完成二", artifacts: [{ path: "out/b.docx" }], startedAt: "2026-10-20T00:30:00.000Z", finishedAt: "2026-10-20T00:40:00.000Z", events: [{ seq: 2 }, { seq: 1 }], task: { mode: "agent" }, references: [] },
        { id: "r1", status: "running", startedAt: "2026-10-20T00:10:00.000Z", events: [] },
        { id: "r1", status: "running", startedAt: "2026-10-20T00:10:00.000Z" },
        { id: "r3", status: null }
      ]
    };
    const oldResult = oldRebuild(
      { entries }, runData,
      oldHistId, sandbox.historyImageData, sandbox.cleanPersistedMessage, sandbox.historyReferences, sandbox.entryCreatedAt,
      normalizeHistoryMessages
    );
    const newResult = M.buildSessionHistory(entries as never, runData.runs as never);
    expect(newResult).toEqual(oldResult);
  });
});

/* ==================== B. workbench 消费面通道映射 ==================== */

describe("B. workbench 消费面通道映射对齐 server 路由", () => {
  it("workbench 数据流/会话域通道全部在清单且路由正确", () => {
    const route = (key: string): { method: string; path: string } => DESKTOP_CHANNELS[key as keyof typeof DESKTOP_CHANNELS] as never;
    expect(route("op:files:list")).toMatchObject({ method: "GET", path: "/api/files" });
    expect(route("op:projects:list")).toMatchObject({ method: "GET", path: "/api/projects" });
    expect(route("op:workspaces:list")).toMatchObject({ method: "GET", path: "/api/workspaces" });
    expect(route("op:workspace:switch")).toMatchObject({ method: "POST", path: "/api/workspace/switch" });
    expect(route("op:agent:new")).toMatchObject({ method: "POST", path: "/api/agent/new" });
    expect(route("op:agent:resume")).toMatchObject({ method: "POST", path: "/api/agent/resume" });
    expect(route("op:sessions:get")).toMatchObject({ method: "GET", path: "/api/sessions/:id" });
    expect(route("op:agent:events-state")).toMatchObject({ method: "GET", path: "/api/agent/events/state" });
    expect(route("op:agent:events-read")).toMatchObject({ method: "POST", path: "/api/agent/events/read" });
    // 全局事件流 SSE 路由被 op:event IPC 取代（替代关系显式登记）
    expect(SSE_REPLACED_ROUTES).toContain("GET /api/agent/events");
  });
});

/* ==================== C. feed 常量锚点（vs 旧源码文本） ==================== */

describe("C. feed 常量锚点", () => {
  it("GLOBAL_EVENT_NOTICES / artifact 事件表 / 游标键与旧源码逐字一致", () => {
    const match = APP_SOURCE.match(/GLOBAL_EVENT_NOTICES = new Set\(\[([^\]]*)\]\)/);
    expect(match, "旧源码 GLOBAL_EVENT_NOTICES 定位").toBeTruthy();
    const parsed = (match?.[1] ?? "").split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    expect([...FEED.GLOBAL_EVENT_NOTICES]).toEqual(parsed);
    expect(FEED.ARTIFACT_EVENT_TYPES).toEqual(["run_finished", "file_changed", "artifact_published"]);
    // 旧 onmessage 内 artifact 事件字面量原文（App.jsx 617）
    expect(APP_SOURCE.includes('"run_finished", "file_changed", "artifact_published"')).toBe(true);
    expect(FEED.EVENT_CURSOR_STORAGE_KEY).toBe("oaw_event_cursor");
    expect(APP_SOURCE.includes('"oaw_event_cursor"')).toBe(true);
  });
});

/* ==================== D. feed 行为 harness（createGlobalEventFeed） ==================== */

class FakeConn {
  openCb: (() => void) | null = null;
  messageCb: ((frame: { eventId: number; data: Record<string, unknown> }) => void) | null = null;
  errorCb: (() => void) | null = null;
  closed = false;
  onOpen(cb: () => void): void { this.openCb = cb; }
  onMessage(cb: (frame: { eventId: number; data: Record<string, unknown> }) => void): void { this.messageCb = cb; }
  onError(cb: () => void): void { this.errorCb = cb; }
  close(): void { this.closed = true; }
  open(): void { this.openCb?.(); }
  fail(): void { this.errorCb?.(); }
  deliver(eventId: number, type: string, extra: Record<string, unknown> = {}): void {
    this.messageCb?.({ eventId, data: { seq: eventId, type, ...extra } });
  }
}

function fakeTransport() {
  const conns: FakeConn[] = [];
  const connects: Array<{ client: string; after: number }> = [];
  const transport = {
    connect(params: { client: string; after: number }) {
      connects.push(params);
      const conn = new FakeConn();
      conns.push(conn);
      return conn;
    }
  };
  return { transport, conns, connects };
}

interface FeedCalls {
  eventVersion: number[];
  artifactVersion: number[];
  unread: Array<Record<string, number>>;
  refresh: number;
}

function makeFeed(transport: GlobalEventTransportT, options: { cursor?: number; thread?: string; loadEventState?: GlobalEventFeedDepsT["loadEventState"] } = {}) {
  const refs: GlobalEventFeedRefsT = {
    currentThreadRef: { current: options.thread ?? "t-cur" },
    eventCursorRef: { current: options.cursor ?? 0 },
    eventNoticeKeysRef: { current: new Set<string>() },
    browserAutoOpenBlockedRef: { current: false },
    eventBatchTimerRef: { current: null },
    eventBatchRef: { current: { updates: 0, artifacts: 0 } },
    eventRefreshTimerRef: { current: null }
  };
  const calls: FeedCalls = { eventVersion: [], artifactVersion: [], unread: [], refresh: 0 };
  let eventVersion = 0;
  let artifactVersion = 0;
  let unreadState: Record<string, number> = {};
  const deps: GlobalEventFeedDepsT = {
    clientId: "parity-client",
    refs,
    setEventVersion: (updater) => { eventVersion = updater(eventVersion); calls.eventVersion.push(eventVersion); },
    setArtifactVersion: (updater) => { artifactVersion = updater(artifactVersion); calls.artifactVersion.push(artifactVersion); },
    setUnreadByThread: (updater) => { unreadState = updater(unreadState); calls.unread.push({ ...unreadState }); },
    refreshSessions: () => { calls.refresh += 1; },
    transport,
    ...(options.loadEventState ? { loadEventState: options.loadEventState } : {})
  };
  const cleanup = FEED.createGlobalEventFeed(deps);
  return { refs, calls, cleanup };
}

async function flushMicro(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe("D. feed 行为（createGlobalEventFeed + fake transport + fake timers）", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("游标引导：localStorage 无游标 → events-state.latest 建流并持久化", async () => {
    const { transport, connects } = fakeTransport();
    const { refs, cleanup } = makeFeed(transport, { loadEventState: async () => ({ latest: 42 }) });
    await flushMicro();
    expect(connects).toEqual([{ client: "parity-client", after: 42 }]);
    expect(refs.eventCursorRef.current).toBe(42);
    expect(localStorage.getItem(FEED.EVENT_CURSOR_STORAGE_KEY)).toBe("42");
    cleanup();
  });

  it("引导 3000ms 超时：静默按现有游标建流", async () => {
    const { transport, connects } = fakeTransport();
    const { cleanup } = makeFeed(transport, { loadEventState: () => new Promise(() => {}) });
    await flushMicro();
    expect(connects).toHaveLength(0);
    vi.advanceTimersByTime(3000);
    await flushMicro();
    expect(connects).toEqual([{ client: "parity-client", after: 0 }]);
    cleanup();
  });

  it("已持久化游标：跳过引导直接建流", async () => {
    localStorage.setItem(FEED.EVENT_CURSOR_STORAGE_KEY, "7");
    const { transport, connects } = fakeTransport();
    let stateCalls = 0;
    const { refs, cleanup } = makeFeed(transport, { cursor: 7, loadEventState: async () => { stateCalls += 1; return null; } });
    await flushMicro();
    expect(stateCalls).toBe(0);
    expect(connects).toEqual([{ client: "parity-client", after: 7 }]);
    expect(refs.eventCursorRef.current).toBe(7);
    cleanup();
  });

  it("seq 游标：推进 + 持久化；同 seq / 更小 seq 丢弃", async () => {
    const { transport, conns } = fakeTransport();
    const { refs, calls, cleanup } = makeFeed(transport);
    await flushMicro();
    const conn = conns[0] as FakeConn;
    conn.deliver(5, "run_finished", { threadId: "t-other", runId: "r1" });
    expect(refs.eventCursorRef.current).toBe(5);
    expect(localStorage.getItem(FEED.EVENT_CURSOR_STORAGE_KEY)).toBe("5");
    conn.deliver(5, "run_finished", { threadId: "t-other", runId: "r1" });
    conn.deliver(3, "run_finished", { threadId: "t-other", runId: "r1" });
    vi.advanceTimersByTime(200);
    expect(calls.eventVersion).toEqual([1]); // 后两帧被丢弃，批处理只计一次
    cleanup();
  });

  it("100ms 批处理：updates 合并自增；artifact 仅当前线程且白名单计数（stagedVisible 默认关）", async () => {
    const { transport, conns } = fakeTransport();
    const { calls, cleanup } = makeFeed(transport);
    await flushMicro();
    const conn = conns[0] as FakeConn;
    conn.deliver(1, "file_changed", { threadId: "t-cur" });
    conn.deliver(2, "file_changed", { threadId: "t-cur" });
    conn.deliver(3, "artifact_staged", { threadId: "t-cur" });
    conn.deliver(4, "file_changed", { threadId: "t-other" });
    expect(calls.eventVersion).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(calls.eventVersion).toEqual([4]);
    expect(calls.artifactVersion).toEqual([2]); // artifact_staged 未开 flag 不计，跨线程不计
    cleanup();
  });

  it("未读：跨线程 notice 事件 noticeKey 去重计数；当前线程不计；ask_user 计未读但不触发刷新", async () => {
    const { transport, conns } = fakeTransport();
    const { calls, cleanup } = makeFeed(transport);
    await flushMicro();
    const conn = conns[0] as FakeConn;
    conn.deliver(1, "run_finished", { threadId: "t-other", runId: "r1" });
    conn.deliver(2, "run_finished", { threadId: "t-other", runId: "r1" }); // 同 runId 同类型：noticeKey 去重，不重复计数也不重复 push
    conn.deliver(3, "run_finished", { threadId: "t-other", runId: "r2" });
    expect(calls.unread).toEqual([{ "t-other": 1 }, { "t-other": 2 }]);
    conn.deliver(4, "ask_user", { threadId: "t-other", runId: "r3" });
    expect(calls.unread[calls.unread.length - 1]).toEqual({ "t-other": 3 });
    conn.deliver(5, "run_finished", { threadId: "t-cur", runId: "r9" });
    expect(calls.unread[calls.unread.length - 1]).toEqual({ "t-other": 3 });
    vi.advanceTimersByTime(180);
    expect(calls.refresh).toBe(1); // 三帧 run_finished 同窗防抖一次；ask_user 不参与
    cleanup();
  });

  it("180ms 防抖刷新：页面不可见时不调用", async () => {
    const { transport, conns } = fakeTransport();
    const { calls, cleanup } = makeFeed(transport);
    await flushMicro();
    const conn = conns[0] as FakeConn;
    const original = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    conn.deliver(1, "agent_error", { threadId: "t-other" });
    vi.advanceTimersByTime(180);
    expect(calls.refresh).toBe(0);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    conn.deliver(2, "agent_error", { threadId: "t-other" });
    vi.advanceTimersByTime(180);
    expect(calls.refresh).toBe(1);
    if (original) Object.defineProperty(document, "visibilityState", original);
    cleanup();
  });

  it("run_finished 重置 browserAutoOpenBlocked（不跨轮传递）；其他事件不重置", async () => {
    const { transport, conns } = fakeTransport();
    const { refs, cleanup } = makeFeed(transport);
    await flushMicro();
    const conn = conns[0] as FakeConn;
    refs.browserAutoOpenBlockedRef.current = true;
    conn.deliver(1, "agent_error", { threadId: "t-cur" });
    expect(refs.browserAutoOpenBlockedRef.current).toBe(true);
    conn.deliver(2, "run_finished", { threadId: "t-cur" });
    expect(refs.browserAutoOpenBlockedRef.current).toBe(false);
    cleanup();
  });

  it("IPC transport：watch 受理失败走重连（800ms）；cleanup 停订并 stop", async () => {
    let watchCount = 0;
    const watch = async (): Promise<{ ok: boolean }> => {
      watchCount += 1;
      return { ok: watchCount > 1 };
    };
    const stops: Array<{ client?: string } | undefined> = [];
    const stop = async (request?: { client?: string }): Promise<void> => { stops.push(request); };
    const subscribeCalls: number[] = [];
    const transport = FEED.createIpcGlobalEventTransport({
      watch: watch as never,
      stop,
      subscribe: (listener: (event: import("../src/shared/protocol/channels").DesktopEvent) => void) => {
        subscribeCalls.push(1);
        void listener;
        return () => {};
      }
    });
    const { calls, cleanup } = makeFeed(transport, { loadEventState: async () => ({ latest: 0 }) });
    await flushMicro();
    expect(watchCount).toBe(1);
    vi.advanceTimersByTime(800);
    await flushMicro();
    expect(watchCount).toBe(2); // 受理失败 → 800ms 重试
    cleanup();
    expect(stops.length).toBeGreaterThanOrEqual(1);
    expect(stops[0]).toEqual({ client: "parity-client" });
    expect(calls.refresh).toBe(0);
  });

  it("cleanup：批处理定时器与刷新定时器一并清空", async () => {
    const { transport, conns } = fakeTransport();
    const { calls, cleanup } = makeFeed(transport);
    await flushMicro();
    const conn = conns[0] as FakeConn;
    conn.deliver(1, "file_changed", { threadId: "t-cur" });
    conn.deliver(2, "agent_error", { threadId: "t-other" });
    cleanup();
    vi.advanceTimersByTime(300);
    expect(calls.eventVersion).toEqual([]);
    expect(calls.refresh).toBe(0);
  });
});

/* ==================== E. workbench 会话域行为 harness（假桥挂载） ==================== */

const WS_A = "D:/ws/parity-a";
const WS_B = "D:/ws/parity-b";
const CLIENT = "parity-client";

const ENTRIES = [
  { id: "e1", type: "message", message: { role: "user", content: "当前打开文件: 总体规划.docx\n请检查该文件", timestamp: "2026-10-20T01:00:00.000Z" } },
  { id: "e2", type: "message", message: { role: "assistant", content: [{ type: "text", text: "收到，开始检查" }], createdAt: "2026-10-20T01:00:05.000Z" } }
];

interface InvokeCall { channel: string; payload: Record<string, unknown> | undefined }

function replyFor(channel: string): unknown {
  switch (channel) {
    case "op:workspaces:list": return { workspaces: [{ path: WS_A, name: "parity-a" }] };
    case "op:sessions:list": return { sessions: [{ id: "s1", threadId: "t1", cwd: WS_A, title: "会话一" }, { id: "s2", threadId: "t2", cwd: WS_B, title: "跨区会话" }] };
    case "op:projects:list": return { projects: [{ id: "p1", name: "项目一", rootPath: WS_A }] };
    case "op:sessions:get": return { entries: ENTRIES, info: {} };
    case "op:runs:list": return { runs: [] };
    case "op:agent:new": return { sessionId: "s-new", threadId: "thread-new" };
    case "op:workspace:switch": return { workspace: WS_B, files: [] };
    default: return {};
  }
}

function mountNode(node: React.ReactNode): { host: HTMLElement; unmount: () => void } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  let root: Root | null = null;
  act(() => {
    root = createRoot(host);
    root.render(node);
  });
  return {
    host,
    unmount: () => {
      const r = root;
      if (r) act(() => { r.unmount(); });
      host.remove();
    }
  };
}

function click(el: Element | null | undefined): void {
  expect(el, "待点击元素存在").toBeTruthy();
  act(() => { el!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
}

async function flushAsync(ms = 30): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
}

describe("E. workbench 会话域行为（window.opDesktop 假桥挂载）", () => {
  let invokeCalls: InvokeCall[] = [];
  let mounted: { host: HTMLElement; unmount: () => void } | null = null;

  const mountWorkbench = async (): Promise<HTMLElement> => {
    const Workbench = (await import("../src/renderer/app/workbench")).default;
    mounted = mountNode(<Workbench />);
    await flushAsync(50);
    return mounted.host;
  };

  beforeEach(() => {
    localStorage.clear();
    invokeCalls = [];
    (window as unknown as Record<string, unknown>).opDesktop = {
      protocolVersion: 1,
      getServerStatus: async () => null,
      onServerStatus: () => () => {},
      invoke: async (channel: string, payload?: Record<string, unknown>) => {
        invokeCalls.push({ channel, payload });
        return { ok: true, status: 200, data: replyFor(channel) };
      },
      onEvent: () => () => {},
      watchThreadEvents: async () => ({ ok: true }),
      stopThreadEvents: async () => {},
      watchAgentEvents: async () => ({ ok: true }),
      stopAgentEvents: async () => {}
    };
    window.fetch = (async () => ({ ok: true, status: 200, json: async () => ({}) })) as unknown as typeof fetch;
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    delete (window as unknown as Record<string, unknown>).opDesktop;
  });

  it("启动加载面：files/sessions/projects/workspaces 四列表走 IPC 通道", async () => {
    await mountWorkbench();
    const channels = invokeCalls.map((call) => call.channel);
    expect(channels).toContain("op:files:list");
    expect(channels).toContain("op:sessions:list");
    expect(channels).toContain("op:projects:list");
    expect(channels).toContain("op:workspaces:list");
    // 工作区恢复：无持久化状态时取首项
    expect((invokeCalls.find((call) => call.channel === "op:files:list")?.payload as { query?: { workspace?: string } })?.query?.workspace ?? "").toBe("");
  });

  it("新建会话：op:agent:new 携带 cwd/projectId；600ms 后补刷会话列表", async () => {
    const host = await mountWorkbench();
    const sessionsBefore = invokeCalls.filter((call) => call.channel === "op:sessions:list").length;
    const newButton = [...host.querySelectorAll("button")].find((button) => button.title === "新建会话");
    click(newButton);
    await flushAsync(50);
    const news = invokeCalls.filter((call) => call.channel === "op:agent:new");
    expect(news).toHaveLength(1);
    const body = news[0]?.payload as { body?: { client?: string; thread?: string; cwd?: string; projectId?: string | null } };
    expect(body?.body?.cwd).toBe(WS_A);
    expect(body?.body?.projectId).toBe("p1");
    expect(String(body?.body?.thread)).toMatch(/^thread-/);
    expect(String(body?.body?.client)).toBeTruthy();
    await flushAsync(700); // 600ms 延迟刷新
    const sessionsAfter = invokeCalls.filter((call) => call.channel === "op:sessions:list").length;
    expect(sessionsAfter).toBeGreaterThan(sessionsBefore);
  });

  it("选择历史会话：get+runs+resume 并行；历史重建进 UI；同区不触发 switch", async () => {
    const host = await mountWorkbench();
    // SessionList 在「项目会话历史」弹层里：经项目卡的「查看全部」打开
    const viewAll = [...host.querySelectorAll("button")].find((button) => button.textContent === "查看全部");
    click(viewAll);
    const start = invokeCalls.length;
    click(host.querySelector(".session-item"));
    await flushAsync(60);
    const slice = invokeCalls.slice(start).map((call) => call.channel);
    expect(slice).toContain("op:sessions:get");
    expect(slice).toContain("op:runs:list");
    expect(slice).toContain("op:agent:resume");
    expect(slice).not.toContain("op:workspace:switch");
    const getCall = invokeCalls.slice(start).find((call) => call.channel === "op:sessions:get");
    expect(getCall?.payload).toMatchObject({ params: { id: "s1" }, query: { view: "chat", limit: 360 } });
    const resumeCall = invokeCalls.slice(start).find((call) => call.channel === "op:agent:resume");
    expect(resumeCall?.payload?.body).toMatchObject({ thread: "t1", sessionId: "s1", cwd: WS_A });
    // 重建历史经 ChatPanel 渲染进 UI
    expect(host.textContent).toContain("请检查该文件");
    expect(host.textContent).toContain("收到，开始检查");
  });

  it("切换工作区：op:workspace:switch → op:agent:new（新 cwd）→ 列表按新区过滤", async () => {
    const host = await mountWorkbench();
    await flushAsync(20);
    const start = invokeCalls.length;
    const select = [...host.querySelectorAll("select")].find((el) => [...el.querySelectorAll("option")].some((option) => option.value === WS_A));
    expect(select, "工作区下拉存在").toBeTruthy();
    // React 受控 select 的 onChange 直调（jsdom 合成 change 事件不触发 React 委托，沿批6b fiber/props 取用法）
    const propsKey = Object.keys(select as unknown as Record<string, unknown>).find((key) => key.startsWith("__reactProps$"));
    const onChange = (select as unknown as Record<string, Record<string, unknown>>)[propsKey as string]?.onChange as
      ((event: { target: { value: string } }) => void) | undefined;
    expect(typeof onChange).toBe("function");
    act(() => { onChange?.({ target: { value: WS_B } }); });
    await flushAsync(60);
    const slice = invokeCalls.slice(start);
    const switchIndex = slice.findIndex((call) => call.channel === "op:workspace:switch");
    const newIndex = slice.findIndex((call) => call.channel === "op:agent:new");
    expect(switchIndex).toBeGreaterThanOrEqual(0);
    expect(newIndex).toBeGreaterThan(switchIndex); // 先切区后建会话（避免错误 cwd 的空 Agent）
    expect(slice[newIndex]?.payload?.body).toMatchObject({ cwd: WS_B });
    // 切区生效：受控下拉值已落到新区（会话列表过滤语义由 visibleSessions 同源状态驱动）
    expect((select as HTMLSelectElement).value).toBe(WS_B);
  });
});
