// @vitest-environment jsdom
/**
 * F3 批7b：App.jsx chat 集成面（workbench.tsx）+ 全局事件流（global-events-feed.ts
 * + main 侧 global-events-bridge）。
 *
 * R6-6c 对拍退役改写：旧侧 readFileSync 抽取 App.jsx 源码原文本执行的双侧 deep-equal
 * （原 A 组）与旧源码文本锚点（原 C 组）随 client 退役删除（等价性已在 F3 批对拍
 * 验收冻结），锚点样本固化为 history-load.ts / feed 常量的直接期望值断言；
 * 通道映射（B）、feed 行为 harness（D）与 workbench 会话域行为（E）为新侧唯一覆盖保留。
 *
 * 覆盖面：
 *   A. history-load 行为锚点（historyReferences / cleanPersistedMessage /
 *      historyImageData / entryCreatedAt / sameWorkspacePath / fileBasename /
 *      buildSessionHistory 重建循环）；
 *   B. workbench 消费面通道映射对齐 server 路由（op:files/projects/workspaces/
 *      workspace:switch/agent:new/agent:resume/sessions:get/events-state/events-read）；
 *   C. feed 常量锚点：GLOBAL_EVENT_NOTICES / artifact 事件表 / 游标键；
 *   D. feed 行为 harness（createGlobalEventFeed + Fake transport + fake timers）：
 *      游标引导（latest/3000ms 超时/已持久化跳过）、seq 推进去重、100ms 批处理、
 *      未读 noticeKey 去重、180ms 防抖 refreshSessions（visibility）、
 *      run_finished 重置 browserAutoOpenBlocked、IPC transport watch 失败重连 +
 *      cleanup stop、cleanup 清定时器（SSE 重连节奏随 client 退役删除，IPC 形态保留）；
 *   E. workbench 会话域行为 harness（window.opDesktop 假桥挂载）：启动加载面 /
 *      新建会话调用序列 / 选择历史会话（get+runs+resume 并行 + 历史重建进 UI）/
 *      切换工作区（switch → new 新 cwd）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// E 组 workbench 全链路挂载用例单跑即达 3~4.6s，整文件串行满载下会越过默认 5s
// 超时并连锁污染同文件后续用例（2026-10-26 甄别：stash 基线同样失败，非功能回归），
// 本文件统一放宽到 30s。
vi.setConfig({ testTimeout: 30_000 });

// jsdom 无滚动 API：ChatPanel 跟随滚动 effect 静默化（沿批7a 基建）
(Element.prototype as unknown as Record<string, unknown>).scrollTo = () => {};
(Element.prototype as unknown as Record<string, unknown>).scrollIntoView = () => {};

// workbench → map-panel → map-viewer 静态 import 链：maplibre-gl 模块顶层
// setWorkerUrl 依赖 window.URL.createObjectURL（jsdom 无此 API，2026-10-26 起
// map-panel 并入 workbench 装载链后 E 组四用例装载即崩）；shpjs 同链静态 import
// 且本组无消费面。沿 f5-map-viewer 惯例全桩：E 组仅验证会话域行为，不触达地图引擎。
vi.mock("shpjs", () => ({ default: vi.fn() }));
vi.mock("maplibre-gl", () => {
  class FakeBounds {
    constructor(private w = 118, private s = 27, private e = 122.5, private n = 31.5) {}
    getWest() { return this.w; }
    getSouth() { return this.s; }
    getEast() { return this.e; }
    getNorth() { return this.n; }
  }
  class FakeMap {
    handlers = new Map<string, Set<(e?: unknown) => void>>();
    layers = new Set<string>();
    sources = new Map<string, Record<string, unknown>>();
    styleLayers: Array<Record<string, unknown>> = [];
    constructor(options: Record<string, unknown>) {
      this.styleLayers = ((options.style as { layers?: Array<Record<string, unknown>> })?.layers ?? []);
      for (const l of this.styleLayers) this.layers.add(String(l.id));
    }
    on(ev: string, fn: (e?: unknown) => void) {
      if (!this.handlers.has(ev)) this.handlers.set(ev, new Set());
      this.handlers.get(ev)!.add(fn);
    }
    once(ev: string, fn: (e?: unknown) => void) { this.on(ev, fn); }
    off(ev: string, fn: (e?: unknown) => void) { this.handlers.get(ev)?.delete(fn); }
    addControl() {}
    removeControl() {}
    remove() {}
    isStyleLoaded() { return true; }
    loaded() { return true; }
    getStyle() { return { layers: this.styleLayers }; }
    getLayer(id: string) { return this.layers.has(id) ? { id } : undefined; }
    getSource(id: string) {
      const def = this.sources.get(id);
      if (!def) return undefined;
      return { ...def, setData: (d: unknown) => { this.sources.set(id, { ...def, data: d }); } };
    }
    addSource(id: string, def: Record<string, unknown>) { this.sources.set(id, { ...def }); }
    addLayer(def: Record<string, unknown>) {
      this.layers.add(String(def.id));
      this.styleLayers = [...this.styleLayers, def];
    }
    removeLayer(id: string) {
      this.layers.delete(id);
      this.styleLayers = this.styleLayers.filter((l) => l.id !== id);
    }
    removeSource(id: string) { this.sources.delete(id); }
    setLayoutProperty() {}
    setPaintProperty() {}
    setFilter() {}
    setStyle(style: unknown) {
      this.styleLayers = ((style as { layers?: Array<Record<string, unknown>> })?.layers ?? []);
      for (const l of this.styleLayers) this.layers.add(String(l.id));
    }
    jumpTo() {}
    fitBounds() {}
    getCenter() { return { lng: 120.0, lat: 29.2 }; }
    getZoom() { return 9; }
    getCanvas() { return document.createElement("canvas"); }
  }
  return {
    Map: FakeMap,
    LngLatBounds: FakeBounds,
    NavigationControl: class {},
    ScaleControl: class {},
    Popup: class {}
  };
});

const M = await import("../src/renderer/features/chat/history-load");
const FEED = await import("../src/renderer/features/chat/global-events-feed");
const { DESKTOP_CHANNELS, SSE_REPLACED_ROUTES } = await import("../src/shared/protocol/channels");

// 动态 import 命名空间不能作类型命名空间（批6b 经验）：类型一律走 import(...) 别名
type GlobalEventFeedDepsT = import("../src/renderer/features/chat/global-events-feed").GlobalEventFeedDeps;
type GlobalEventFeedRefsT = import("../src/renderer/features/chat/global-events-feed").GlobalEventFeedRefs;
type GlobalEventTransportT = import("../src/renderer/features/chat/global-events-feed").GlobalEventTransport;

// workbench 全链（含 map/task/integrations 等重面板）首载 transform+import 实测 ~26s：
// 若计入首个用例（默认 30s 上限）并发满载下必 flake。提升到模块顶层装载，
// 用例内仅计挂载耗时（~3-5s）。
const Workbench = (await import("../src/renderer/app/workbench")).default;

/* ==================== A. history-load 行为锚点 ==================== */

describe("A. history-load 行为锚点", () => {
  it("historyReferences：括号形态/裸词扩展名/会话引用/去重", () => {
    expect(M.historyReferences("")).toEqual([]);
    expect(M.historyReferences("@知识库[交通规范] @模板[汇报模板] &会话[s1] @文件[报告.docx]")).toEqual([
      { id: "history_ref_knowledge_交通规范", kind: "knowledge", target: "交通规范", source: "@知识库[交通规范]" },
      { id: "history_ref_template_汇报模板", kind: "template", target: "汇报模板", source: "@模板[汇报模板]" },
      { id: "history_ref_file_报告.docx", kind: "file", target: "报告.docx", source: "@文件[报告.docx]" },
      { id: "history_ref_file_文件[报告.docx", kind: "file", target: "文件[报告.docx", source: "@文件[报告.docx" },
      { id: "history_ref_session_s1", kind: "session", target: "s1", source: "&会话[s1]" },
    ]);
    expect(M.historyReferences("@报告.docx 与 @子目录/说明.md @ Knowledge")).toEqual([
      { id: "history_ref_file_报告.docx", kind: "file", target: "报告.docx", source: "@报告.docx" },
      { id: "history_ref_file_子目录/说明.md", kind: "file", target: "子目录/说明.md", source: "@子目录/说明.md" },
    ]);
    expect(M.historyReferences("@报告.docx，再看看 @草图.png。")).toEqual([
      { id: "history_ref_file_报告.docx", kind: "file", target: "报告.docx", source: "@报告.docx" },
    ]);
    expect(M.historyReferences("(@括号内.md) @重复.docx @重复.docx")).toEqual([
      { id: "history_ref_file_括号内.md", kind: "file", target: "括号内.md", source: "@括号内.md" },
      { id: "history_ref_file_重复.docx", kind: "file", target: "重复.docx", source: "@重复.docx" },
    ]);
    expect(M.historyReferences("@user @知识库目录[kb-dir] @模板目录[tpl-dir]")).toEqual([
      { id: "history_ref_knowledge_dir_kb-dir", kind: "knowledge_dir", target: "kb-dir", source: "@知识库目录[kb-dir]" },
      { id: "history_ref_template_dir_tpl-dir", kind: "template_dir", target: "tpl-dir", source: "@模板目录[tpl-dir]" },
    ]);
  });

  it("cleanPersistedMessage：内联目标/信封目标/列表目标/边界剥除", () => {
    expect(M.cleanPersistedMessage("普通文本")).toBe("普通文本");
    expect(M.cleanPersistedMessage("## 当前任务目标: 检查交通模型")).toBe("检查交通模型");
    expect(M.cleanPersistedMessage("### 当前任务\n目标：整理数据\n模式：agent\n引用：x")).toBe("整理数据");
    expect(M.cleanPersistedMessage("- 目标: 生成报告\n- 模式: agent")).toBe("生成报告");
    expect(M.cleanPersistedMessage("## 当前任务\n目标：x\n边界：只读\n\n正文保留")).toBe("x\n边界：只读\n\n正文保留");
    expect(M.cleanPersistedMessage("当前打开文件: a.docx\n帮忙检查")).toBe("当前打开文件: a.docx\n帮忙检查");
  });

  it("historyImageData：data URL 直通 / base64 包装 / mediaType 解析", () => {
    expect(M.historyImageData(null)).toBeNull();
    expect(M.historyImageData(undefined)).toBeNull();
    expect(M.historyImageData({})).toBeNull();
    expect(M.historyImageData({ source: { data: "QUJD" } })).toBe("data:image/png;base64,QUJD");
    expect(M.historyImageData({ image: { url: "data:image/webp;base64,xx" } })).toBe("data:image/webp;base64,xx");
    expect(M.historyImageData({ data: "REVG", mimeType: "image/jpeg" })).toBe("data:image/jpeg;base64,REVG");
    expect(M.historyImageData({ url: "R01L" })).toBe("data:image/png;base64,R01L");
    expect(M.historyImageData({ source: { data: "QQ", mediaType: "image/gif" }, mediaType: "image/other" })).toBe("data:image/gif;base64,QQ");
  });

  it("entryCreatedAt / sameWorkspacePath / fileBasename", () => {
    expect(M.entryCreatedAt(null, null)).toBeNull();
    expect(M.entryCreatedAt({ timestamp: 1 }, { createdAt: 2 })).toBe(1);
    expect(M.entryCreatedAt({}, { createdAt: "x" })).toBe("x");
    expect(M.entryCreatedAt({ time: "t" }, null)).toBe("t");
    expect(M.entryCreatedAt({}, {})).toBeNull();
    expect(M.sameWorkspacePath("D:\\a\\b\\", "d:/a/b")).toBe(true);
    expect(M.sameWorkspacePath("", "x")).toBe(false);
    expect(M.sameWorkspacePath(null, null)).toBe(false);
    expect(M.sameWorkspacePath("D:/a/b", "D:/a/b/")).toBe(true);
    expect(M.sameWorkspacePath("D:/a/b", "D:/a/c")).toBe(false);
    expect(M.fileBasename("")).toBe("");
    expect(M.fileBasename("a/b/c.txt")).toBe("c.txt");
    expect(M.fileBasename("D:\\x\\y.png")).toBe("y.png");
    expect(M.fileBasename("/")).toBe("");
    expect(M.fileBasename("a/")).toBe("a");
  });

  it("buildSessionHistory：重建循环 + Run 总结按时间插回（结构锚点）", () => {
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
    const result = M.buildSessionHistory(entries as never, runData.runs as never);
    // 排序：无时间戳的 e6（0）最前 → r1（00:10）→ r2（00:40）→ e1（01:00）→ e2（01:00:05）→ e4（01:01）
    expect(result.map((m) => `${m.role}:${m.id}`)).toEqual([
      "assistant:e6", "system:run-summary-r1", "system:run-summary-r2", "user:e1", "assistant:e2", "user:e4",
    ]);
    // Run 总结消息：状态过滤 + 去重 + running/completed 文案与事件 key
    const r1 = result[1]!;
    expect([r1.text, r1.status, r1.runIndex, r1.runCount, r1.runMode]).toEqual(["本轮任务仍在执行中", "streaming", 1, 2, "agent"]);
    const r2 = result[2]!;
    expect([r2.text, r2.status, r2.products, r2.eventCount]).toEqual(["完成二", "done", ["out/b.docx"], 2]);
    expect((r2.events as Array<{ key: string }> | undefined)?.map((e) => e.key)).toEqual(["history:r2:2", "history:r2:1"]);
    // 用户消息：文本清洗 / 当前文件 / 引用解析
    const e1 = result[3]!;
    expect([e1.text, e1.currentDoc]).toEqual(["当前打开文件: 总体规划.docx\n@报告.docx 帮忙检查", "总体规划.docx"]);
    expect((e1.references as Array<{ target: string }> | undefined)?.map((r) => r.target)).toContain("报告.docx");
    const e4 = result[5]!;
    expect(e4.text).toBe("继续分析");
    // assistant 重建：toolCall 回填 + ghost toolResult 挂最近 assistant + 图像 base64
    const e2 = result[4]!;
    expect(e2.blocks?.map((b) => b.type)).toEqual(["tool", "thinking", "text", "tool"]);
    expect(e2.blocks?.[0]).toMatchObject({ type: "tool", id: "c1", output: "文件内容", done: true, isError: false });
    expect(e2.blocks?.[3]).toMatchObject({ type: "tool", name: "bash", output: "无配对输出", done: true, isError: true });
    const e6 = result[0]!;
    expect(e6.images).toEqual(["data:image/png;base64,QUJD"]);
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

/* ==================== C. feed 常量锚点 ==================== */

describe("C. feed 常量锚点", () => {
  it("GLOBAL_EVENT_NOTICES / artifact 事件表 / 游标键", () => {
    expect([...FEED.GLOBAL_EVENT_NOTICES]).toEqual(["run_finished", "run_recovered", "run_cancel_requested", "agent_error", "ask_user"]);
    expect(FEED.ARTIFACT_EVENT_TYPES).toEqual(["run_finished", "file_changed", "artifact_published"]);
    expect(FEED.EVENT_CURSOR_STORAGE_KEY).toBe("oaw_event_cursor");
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
