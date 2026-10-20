// @vitest-environment jsdom
/**
 * F3 批4 对拍：settings 拆出 + 记忆域通道/API + 记忆事件桥 + MemoryTab 组件。
 *
 * 对拍口径（同输入同流）：
 *   - settings：client SettingsPanel.jsx 的 loadSettings/useSetting 与 electron lib/settings
 *     在同一 localStorage 输入下输出/落盘逐字节一致；
 *   - memory API：旧侧 stub fetch 捕获 method/url/body，新侧 stub window.opDesktop.invoke
 *     捕获 channel/payload，HTTP 形态与通道模板逐项对账（含 throw 形状）；
 *   - memory bridge：stub SSE 流，帧包装/幂等/重连/停止语义逐项断言；
 *   - MemoryTab：双侧同挂载（旧 fetch + EventSource stub / 新 opDesktop stub），
 *     DOM innerHTML 逐字节一致，交互传输调用序列等价。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DESKTOP_CHANNELS, type DesktopChannelId } from "../src/shared/protocol/channels";
import { createMemoryEventsBridge, MEMORY_CHANGE_EVENT_TYPE, type MemoryBridgeDeps } from "../src/main/ipc/memory-events-bridge";
import { resetStreams, activeStreamCount } from "../src/renderer/lib/stream-budget";
import { MEMORY_CHANGE_EVENT_TYPE as REEXPORTED_TYPE } from "../src/main/ipc/memory-events-bridge";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// 第一部分：settings 拆出对拍
// ---------------------------------------------------------------------------

import { loadSettings as loadSettingsTs, useSetting as useSettingTs } from "../src/renderer/lib/settings";

const settingsPanelJs = await import("../../client/src/components/SettingsPanel.jsx");
const loadSettingsJs = settingsPanelJs.loadSettings as typeof loadSettingsTs;
const useSettingJs = settingsPanelJs.useSetting as typeof useSettingTs;

const SETTINGS_KEY = "oaw_settings";

function resetSettingsStorage(): void {
  localStorage.removeItem(SETTINGS_KEY);
}

describe("loadSettings TS 版与 SettingsPanel.jsx 输出等价", () => {
  afterEach(() => resetSettingsStorage());

  it("空存储返回默认值（深等）", () => {
    resetSettingsStorage();
    expect(loadSettingsTs()).toEqual(loadSettingsJs());
    expect(loadSettingsTs()).toMatchObject({ msgFontSize: "medium", commentHighlightMs: 20000, thinkingDefaultOpen: false, showTimeline: true });
  });

  it("部分存储值合并默认值（不落盘污染默认表）", () => {
    resetSettingsStorage();
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ msgFontSize: "large", custom: 1 }));
    const ts = loadSettingsTs();
    const js = loadSettingsJs();
    expect(ts).toEqual(js);
    expect(ts.msgFontSize).toBe("large");
    expect(ts.custom).toBe(1);
    // 默认表未被污染（展开合并而非引用合并）
    expect(loadSettingsTs().msgFontSize).toBe("large");
    localStorage.setItem(SETTINGS_KEY, "{}");
    expect(loadSettingsTs().msgFontSize).toBe("medium");
    expect(loadSettingsJs().msgFontSize).toBe("medium");
  });

  it("损坏 JSON 回退默认值", () => {
    resetSettingsStorage();
    localStorage.setItem(SETTINGS_KEY, "{oops");
    expect(loadSettingsTs()).toEqual(loadSettingsJs());
    expect(loadSettingsTs().showTimeline).toBe(true);
  });
});

describe("useSetting TS 版与 SettingsPanel.jsx 行为等价", () => {
  afterEach(() => {
    resetSettingsStorage();
    document.body.innerHTML = "";
  });

  function mountHook(useHook: () => [unknown, (next: unknown) => void]) {
    const captured: { value?: unknown; set?: (next: unknown) => void } = {};
    const host = document.createElement("div");
    document.body.appendChild(host);
    let root: Root | null = null;
    function Probe() {
      const [v, set] = useHook();
      captured.value = v;
      captured.set = set;
      return null;
    }
    root = createRoot(host);
    act(() => { root!.render(<Probe />); });
    return { captured, unmount: () => { act(() => { root!.unmount(); }); host.remove(); } };
  }

  it("初始值 + set 落盘合并 JSON 逐字节一致", () => {
    // 旧侧
    resetSettingsStorage();
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ commentHighlightMs: 5000 }));
    const js = mountHook(() => useSettingJs("msgFontSize"));
    expect(js.captured.value).toBe("medium");
    act(() => { js.captured.set!("large"); });
    expect(js.captured.value).toBe("large");
    const jsSnapshot = localStorage.getItem(SETTINGS_KEY);
    js.unmount();

    // 新侧（同一输入序列）
    resetSettingsStorage();
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ commentHighlightMs: 5000 }));
    const ts = mountHook(() => useSettingTs("msgFontSize"));
    expect(ts.captured.value).toBe("medium");
    act(() => { ts.captured.set!("large"); });
    expect(ts.captured.value).toBe("large");
    const tsSnapshot = localStorage.getItem(SETTINGS_KEY);
    ts.unmount();

    expect(tsSnapshot).toBe(jsSnapshot);
    // 两侧写盘均先 loadSettings() 合并默认值再覆盖单键
    expect(JSON.parse(tsSnapshot ?? "{}")).toEqual({
      theme: null,
      msgFontSize: "large",
      commentHighlightMs: 5000,
      thinkingDefaultOpen: false,
      showTimeline: true
    });
  });

  it("showTimeline 布尔反转落盘一致", () => {
    resetSettingsStorage();
    const js = mountHook(() => useSettingJs("showTimeline"));
    act(() => { js.captured.set!(false); });
    const jsSnapshot = localStorage.getItem(SETTINGS_KEY);
    js.unmount();

    resetSettingsStorage();
    const ts = mountHook(() => useSettingTs("showTimeline"));
    act(() => { ts.captured.set!(false); });
    const tsSnapshot = localStorage.getItem(SETTINGS_KEY);
    ts.unmount();

    expect(tsSnapshot).toBe(jsSnapshot);
  });
});

// ---------------------------------------------------------------------------
// 第二部分：memory API 传输形态对拍
// ---------------------------------------------------------------------------

const clientApi = await import("../../client/src/api.js");
const desktopApi = await import("../src/renderer/api/client-api");

interface HttpCall { method: string; url: string; body?: string }
interface IpcCall { channel: string; payload?: Record<string, unknown> }

const SAMPLE_DATA = { sample: "ok", items: [1, 2] };

function setupApiParity(): { httpCalls: HttpCall[]; ipcCalls: IpcCall[] } {
  const httpCalls: HttpCall[] = [];
  const ipcCalls: IpcCall[] = [];
  vi.stubGlobal("fetch", async (path: string | URL, opts?: RequestInit) => {
    httpCalls.push({
      method: opts?.method ?? "GET",
      url: String(path),
      body: typeof opts?.body === "string" ? opts.body : undefined
    });
    return { ok: true, status: 200, json: async () => SAMPLE_DATA };
  });
  (window as unknown as { opDesktop: unknown }).opDesktop = {
    invoke: async (channel: string, payload?: Record<string, unknown>) => {
      ipcCalls.push({ channel, payload });
      return { ok: true, status: 200, data: SAMPLE_DATA };
    }
  };
  return { httpCalls, ipcCalls };
}

function expandPath(template: string, params?: Record<string, string>): string {
  let path = template;
  for (const [key, value] of Object.entries(params ?? {})) path = path.replace(`:${key}`, encodeURIComponent(value));
  return path;
}

function assertApiParity(httpCalls: HttpCall[], ipcCalls: IpcCall[], callIndex: number, channel: DesktopChannelId): void {
  const http = httpCalls[callIndex];
  const ipc = ipcCalls[callIndex];
  const route = DESKTOP_CHANNELS[channel];
  if (!http || !ipc) throw new Error(`第 ${callIndex} 次调用缺失：http=${httpCalls.length} ipc=${ipcCalls.length}`);
  expect(ipc.channel, `第 ${callIndex} 次调用通道不符（http=${httpCalls.length} ipc=${ipcCalls.length}）`).toBe(channel);
  expect(http.method).toBe(route.method);
  const url = new URL(http.url, "http://legacy");
  expect(url.pathname).toBe(expandPath(route.path, ipc.payload?.params as Record<string, string> | undefined));
  const newQuery = (ipc.payload?.query ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(newQuery)) {
    expect(url.searchParams.get(key), `query.${key} 不等`).toBe(String(value));
  }
  expect([...url.searchParams.keys()].sort()).toEqual(Object.keys(newQuery).sort());
  if (ipc.payload?.body === undefined) {
    expect(http.body).toBeUndefined();
  } else {
    expect(JSON.parse(http.body ?? "null")).toEqual(ipc.payload.body);
  }
}

describe("memory 端点族：旧 api.js（fetch）与 client-api.ts（通道）形态等价", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (window as unknown as { opDesktop?: unknown }).opDesktop;
  });

  it("文件读写 + 初始化 + 列表：method/路径/body 逐项一致", async () => {
    const { httpCalls, ipcCalls } = setupApiParity();

    await clientApi.listMemoryProposals("ws-a", "pending", "proj-1");
    await desktopApi.listMemoryProposals("ws-a", "pending", "proj-1");
    await clientApi.listMemoryProposals();
    await desktopApi.listMemoryProposals();
    await clientApi.approveMemoryProposal("p1");
    await desktopApi.approveMemoryProposal("p1");
    await clientApi.approveMemoryProposal("p1", { reviewer: "user" });
    await desktopApi.approveMemoryProposal("p1", { reviewer: "user" });
    await clientApi.editMemoryProposal("p2", { content: "内容", category: "work_rule" });
    await desktopApi.editMemoryProposal("p2", { content: "内容", category: "work_rule" });
    await clientApi.rejectMemoryProposal("p3");
    await desktopApi.rejectMemoryProposal("p3");
    await clientApi.rejectMemoryProposal("p3", "不符合要求");
    await desktopApi.rejectMemoryProposal("p3", "不符合要求");
    await clientApi.mergeMemoryProposals("p1", ["p2", "p3"]);
    await desktopApi.mergeMemoryProposals("p1", ["p2", "p3"]);
    await clientApi.memoryProposalHistory("p4");
    await desktopApi.memoryProposalHistory("p4");
    // 含斜杠 rel 的编码路径两侧一致
    await desktopApi.readMemoryFile("memory/MEMORY.md");
    await desktopApi.saveMemoryFile("MEMORY.md", "正文");
    await desktopApi.initMemory();
    await desktopApi.listMemoryFiles();

    // 旧 api.js 仅导出 proposals 族 9 端点：旧/新严格交替调用，httpCalls[i] ↔ ipcCalls[i] 同索引成对
    const pairedChannels: DesktopChannelId[] = [
      "op:memory:proposals:list", "op:memory:proposals:list",
      "op:memory:proposals:approve", "op:memory:proposals:approve",
      "op:memory:proposals:edit",
      "op:memory:proposals:reject", "op:memory:proposals:reject",
      "op:memory:proposals:merge",
      "op:memory:proposals:history"
    ];
    pairedChannels.forEach((channel, i) => assertApiParity(httpCalls, ipcCalls, i, channel));

    // desktop-only 4 通道（旧 api.js 无导出，旧侧形态是 MemoryTab.jsx 直连 fetch）：仅新侧发出
    expect(httpCalls).toHaveLength(9);
    expect(ipcCalls).toHaveLength(13);
    const desktopOnly: Array<[IpcCall | undefined, DesktopChannelId]> = [
      [ipcCalls[9], "op:memory:file:get"],
      [ipcCalls[10], "op:memory:file:save"],
      [ipcCalls[11], "op:memory:init"],
      [ipcCalls[12], "op:memory:list"]
    ];
    for (const [call, channel] of desktopOnly) {
      expect(call?.channel, `desktop-only ${channel} 通道不符`).toBe(channel);
      expect(DESKTOP_CHANNELS[channel]?.method).toBeDefined();
    }

    // workspace/status/projectId 空值剔除一致（新通道无幽灵 query 键）
    expect(ipcCalls[0]?.payload?.query).toEqual({ workspace: "ws-a", status: "pending", projectId: "proj-1" });
    expect(ipcCalls[1]?.payload?.query).toEqual({});
    // 默认拒绝原因与显式原因两侧一致
    expect(JSON.parse(httpCalls[5]?.body ?? "{}")).toEqual({ reason: "用户拒绝该记忆建议" });
    expect((ipcCalls[5]?.payload?.body as { reason: string }).reason).toBe("用户拒绝该记忆建议");
    expect(JSON.parse(httpCalls[6]?.body ?? "{}")).toEqual({ reason: "不符合要求" });
    expect((ipcCalls[6]?.payload?.body as { reason: string }).reason).toBe("不符合要求");
    // 含斜杠 rel：通道模板展开与 MemoryTab.jsx 直连 fetch 的 encodeURIComponent 形态一致
    expect(expandPath(DESKTOP_CHANNELS["op:memory:file:get"].path, { rel: "memory/MEMORY.md" }))
      .toBe(`/api/memory/${encodeURIComponent("memory/MEMORY.md")}`);
    expect((ipcCalls[9]?.payload?.params as { rel: string }).rel).toBe("memory/MEMORY.md");
    // 保存：method/body 对齐 MemoryTab.jsx saveFile（POST + JSON.stringify({ content })）
    expect(DESKTOP_CHANNELS["op:memory:file:save"].method).toBe("POST");
    expect(ipcCalls[10]?.payload?.body).toEqual({ content: "正文" });
    // 初始化/列表无 body（payload 缺省）
    expect(ipcCalls[11]?.payload).toBeUndefined();
    expect(ipcCalls[12]?.payload).toBeUndefined();
  });

  it("失败 throw 形状逐字段一致", async () => {
    const { httpCalls, ipcCalls } = setupApiParity();
    // 覆写为失败响应
    vi.stubGlobal("fetch", async () => ({
      ok: false, status: 400,
      json: async () => ({ error: "缺少参数", code: "NO_PARAM", detail: { field: "id" } })
    }));
    (window as unknown as { opDesktop: unknown }).opDesktop = {
      invoke: async (channel: string, payload?: Record<string, unknown>) => {
        ipcCalls.push({ channel, payload });
        return { ok: false, status: 400, data: { error: "缺少参数", code: "NO_PARAM", detail: { field: "id" } } };
      }
    };

    const oldError = await clientApi.rejectMemoryProposal("p9").then(() => null, (e: Error) => e);
    const newError = await desktopApi.rejectMemoryProposal("p9").then(() => null, (e: Error) => e);
    expect(oldError).not.toBeNull();
    expect(newError).not.toBeNull();
    expect(newError?.message).toBe(oldError?.message);
    expect(newError?.message).toBe("缺少参数");
    expect((newError as { code?: string }).code).toBe((oldError as { code?: string }).code);
    expect((newError as { code?: string }).code).toBe("NO_PARAM");
    expect((newError as { detail?: unknown }).detail).toEqual((oldError as { detail?: unknown }).detail);
    expect(httpCalls).toHaveLength(0); // 失败覆写后旧侧未再调用
    expect(ipcCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 第三部分：memory 事件桥单测
// ---------------------------------------------------------------------------

expect(REEXPORTED_TYPE).toBe(MEMORY_CHANGE_EVENT_TYPE);

interface BridgeFetchResponse {
  ok: boolean;
  status: number;
  body: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } } | null;
  text: () => Promise<string>;
}

function sseBody(frames: string[]): BridgeFetchResponse["body"] {
  const chunks = frames.map((frame) => new TextEncoder().encode(frame));
  let index = 0;
  return {
    getReader: () => ({
      read: async () => (index < chunks.length ? { done: false, value: chunks[index++] } : { done: true, value: undefined })
    })
  };
}

async function settle(times = 12): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function makeBridgeDeps(responses: BridgeFetchResponse[]): {
  deps: MemoryBridgeDeps;
  sent: Array<{ type: string; data: unknown }>;
  fetchUrls: string[];
  states: string[];
  delayCount: { n: number };
  /** 放行当前被挂起的退避等待（delay 采用手动放行模式，避免纯微任务死循环饿死事件循环） */
  flushDelay: () => Promise<void>;
  drainDelays: () => Promise<void>;
} {
  const sent: Array<{ type: string; data: unknown }> = [];
  const fetchUrls: string[] = [];
  const states: string[] = [];
  const delayCount = { n: 0 };
  const queue = [...responses];
  const pendingDelays: Array<() => void> = [];
  const deps: MemoryBridgeDeps = {
    getPort: () => 4599,
    send: (event) => sent.push({ type: event.type as string, data: event.data }),
    onState: (state) => states.push(state),
    fetchImpl: async (url) => {
      fetchUrls.push(url);
      return queue.shift() ?? { ok: false, status: 500, body: null, text: async () => "no more" };
    },
    delay: () =>
      new Promise<void>((resolve) => {
        pendingDelays.push(resolve);
        delayCount.n += 1;
      })
  };
  const drainDelays = async (): Promise<void> => {
    while (pendingDelays.length > 0) {
      const resolve = pendingDelays.shift();
      resolve?.();
      await settle(6);
    }
    await settle(6);
  };
  const flushDelay = async (): Promise<void> => {
    const resolve = pendingDelays.shift();
    resolve?.();
    await settle(6);
  };
  return { deps, sent, fetchUrls, states, delayCount, flushDelay, drainDelays };
}

describe("memory 事件桥", () => {
  it("帧包装为 op:memory-change 推送；重复 watch 幂等", async () => {
    const { deps, sent, fetchUrls, drainDelays } = makeBridgeDeps([
      { ok: true, status: 200, body: sseBody(['data: {"file":"MEMORY.md","event":"change","preview":"预览","time":123}\n\n']), text: async () => "" }
    ]);
    const bridge = createMemoryEventsBridge(deps);
    const first = await bridge.watch();
    const second = await bridge.watch();
    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    await settle();
    expect(fetchUrls).toHaveLength(1); // 帧消费完后挂起在退避等待，不重连
    expect(fetchUrls[0]).toBe("http://127.0.0.1:4599/api/memory/stream");
    expect(sent).toEqual([{ type: "op:memory-change", data: { file: "MEMORY.md", event: "change", preview: "预览", time: 123 } }]);
    bridge.dispose();
    await drainDelays();
  });

  it("非 JSON / 非对象帧不推送", async () => {
    const { deps, sent, drainDelays } = makeBridgeDeps([
      { ok: true, status: 200, body: sseBody(["data: not-json\n\n", "data: 42\n\n", 'data: {"file":"a.md"}\n\n']), text: async () => "" }
    ]);
    const bridge = createMemoryEventsBridge(deps);
    await bridge.watch();
    await settle();
    expect(sent).toEqual([{ type: "op:memory-change", data: { file: "a.md" } }]);
    bridge.dispose();
    await drainDelays();
  });

  it("流被服务端关闭后退避重连；stop 后不再重连", async () => {
    const { deps, fetchUrls, delayCount, flushDelay, drainDelays } = makeBridgeDeps([
      { ok: true, status: 200, body: sseBody([]), text: async () => "" },
      { ok: true, status: 200, body: sseBody([]), text: async () => "" }
    ]);
    const bridge = createMemoryEventsBridge(deps);
    await bridge.watch();
    await settle();
    expect(fetchUrls).toHaveLength(1); // 第一条流结束，挂起在退避等待
    expect(delayCount.n).toBe(1);
    await flushDelay(); // 放行退避 → 第二次建连
    expect(fetchUrls).toHaveLength(2);
    expect(delayCount.n).toBe(2);
    bridge.stop();
    await drainDelays(); // 放行挂起的退避 → generation 已变，不再重连
    expect(fetchUrls).toHaveLength(2); // stop 后无新增连接
  });

  it("建连失败走退避重试", async () => {
    const { deps, fetchUrls, states, flushDelay, drainDelays } = makeBridgeDeps([
      { ok: false, status: 429, body: null, text: async () => "quota" }
    ]);
    const bridge = createMemoryEventsBridge(deps);
    await bridge.watch();
    await settle();
    expect(fetchUrls).toHaveLength(1);
    expect(states).toContain("retrying");
    expect(states.some((s) => s === "retrying")).toBe(true);
    await flushDelay(); // 放行退避 → 重试建连（队列已空，返回兜底 500）
    expect(fetchUrls).toHaveLength(2);
    bridge.dispose();
    await drainDelays();
  });
});

// ---------------------------------------------------------------------------
// 第四部分：MemoryTab 组件对拍
// ---------------------------------------------------------------------------

const clientMemoryTab = (await import("../../client/src/components/MemoryTab.jsx")).default;
const MemoryTabTs = (await import("../src/renderer/components/MemoryTab")).default;

type AnyComp = React.ComponentType<Record<string, unknown>>;

const FILES = [
  { rel: "MEMORY.md", type: "memory", size: 2048 },
  { rel: "AGENTS.md", type: "agents", size: 1024 },
];
const PROPOSALS = [
  { id: "p1", status: "pending", category: "work_rule", content: "地图图层写入前先确认", source: { label: "Agent" }, runId: "run-1", version: 2 },
  { id: "p2", status: "approved", category: "user_preference", content: "偏好简洁结论", source: { label: "用户" }, runId: null, version: 1 },
];
const FILE_CONTENT = "# 记忆索引\n\n## 项目信息\n";

interface FakeEventSourceLike {
  url: string;
  onmessage: ((e: { data: string }) => void) | null;
  onerror: (() => void) | null;
  closed: boolean;
  emit(data: string): void;
}
let fakeEventSources: FakeEventSourceLike[] = [];

class FakeEventSource {
  url: string;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    fakeEventSources.push(this);
  }
  emit(data: string): void {
    this.onmessage?.({ data });
  }
  close(): void {
    this.closed = true;
  }
}

function dataResponse(data: unknown) {
  return { ok: true, status: 200, json: async () => data };
}

function setupComponentParity(): {
  oldCalls: Array<{ method: string; url: string; body?: string }>;
  newCalls: Array<{ channel: string; payload?: Record<string, unknown> }>;
  newEventListeners: Array<(event: { type: string; data?: unknown }) => void>;
  newMemoryStops: { n: number };
  emitMemoryChange: (change: Record<string, unknown>) => void;
} {
  const oldCalls: Array<{ method: string; url: string; body?: string }> = [];
  const newCalls: Array<{ channel: string; payload?: Record<string, unknown> }> = [];
  const newEventListeners: Array<(event: { type: string; data?: unknown }) => void> = [];
  const newMemoryStops = { n: 0 };

  // 每用例内 stub：上方 API 对拍 describe 的 afterEach 会 unstubAllGlobals，
  // 模块级 stub 会被提前拆除，EventSource 必须在此重新挂上。
  vi.stubGlobal("EventSource", FakeEventSource);

  vi.stubGlobal("fetch", async (path: string | URL, opts?: RequestInit) => {
    const url = String(path);
    const method = opts?.method ?? "GET";
    oldCalls.push({ method, url, body: typeof opts?.body === "string" ? opts.body : undefined });
    if (method === "GET" && url === "/api/memory") return dataResponse({ files: FILES, memoryDir: "/ws/memory" });
    if (method === "GET" && url.startsWith("/api/memory/proposals")) return dataResponse({ proposals: PROPOSALS });
    if (method === "GET" && url === "/api/memory/MEMORY.md") return dataResponse({ content: FILE_CONTENT, path: "MEMORY.md" });
    if (method === "GET" && url === "/api/memory/AGENTS.md") return dataResponse({ content: "# AGENTS.md", path: "AGENTS.md" });
    if (method === "POST" && url.endsWith("/approve")) return dataResponse({ ok: true });
    return dataResponse({ ok: true });
  });

  (window as unknown as { opDesktop: unknown }).opDesktop = {
    invoke: async (channel: string, payload?: Record<string, unknown>) => {
      newCalls.push({ channel, payload });
      switch (channel) {
        case "op:memory:list": return { ok: true, status: 200, data: { files: FILES, memoryDir: "/ws/memory" } };
        case "op:memory:proposals:list": return { ok: true, status: 200, data: { proposals: PROPOSALS } };
        case "op:memory:file:get": return { ok: true, status: 200, data: { content: FILE_CONTENT, path: (payload?.params as { rel: string }).rel } };
        default: return { ok: true, status: 200, data: { ok: true } };
      }
    },
    onEvent: (listener: (event: { type: string; data?: unknown }) => void) => {
      newEventListeners.push(listener);
      return () => {
        const index = newEventListeners.indexOf(listener);
        if (index >= 0) newEventListeners.splice(index, 1);
      };
    },
    watchMemoryEvents: async () => ({ ok: true }),
    stopMemoryEvents: async () => { newMemoryStops.n += 1; }
  };

  return {
    oldCalls,
    newCalls,
    newEventListeners,
    newMemoryStops,
    emitMemoryChange: (change) => {
      for (const es of fakeEventSources) {
        if (es.url === "/api/memory/stream") es.emit(JSON.stringify(change));
      }
      for (const listener of [...newEventListeners]) listener({ type: "op:memory-change", data: change });
    }
  };
}

async function flushDom(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (check()) return;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 4)); });
  }
  if (!check()) throw new Error(`等待条件超时：${label}`);
}

async function mountBoth(messages: Record<string, unknown> = {}): Promise<{
  oldHost: HTMLElement; newHost: HTMLElement;
  unmount: () => void;
}> {
  void messages;
  const oldHost = document.createElement("div");
  const newHost = document.createElement("div");
  document.body.appendChild(oldHost);
  document.body.appendChild(newHost);
  let oldRoot: Root | null = null;
  let newRoot: Root | null = null;
  await act(async () => {
    oldRoot = createRoot(oldHost);
    newRoot = createRoot(newHost);
    oldRoot!.render(React.createElement(clientMemoryTab as AnyComp, {}));
    newRoot!.render(React.createElement(MemoryTabTs as AnyComp, {}));
    await Promise.resolve();
  });
  return {
    oldHost,
    newHost,
    unmount: () => {
      act(() => { oldRoot!.unmount(); newRoot!.unmount(); });
      oldHost.remove();
      newHost.remove();
    }
  };
}

describe("MemoryTab TS 版与 client MemoryTab.jsx 渲染等价", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (window as unknown as { opDesktop?: unknown }).opDesktop;
    fakeEventSources = [];
    document.body.innerHTML = "";
    resetStreams();
  });

  it("初始渲染：文件列表 + 记忆治理 DOM 逐字节一致", async () => {
    const env = setupComponentParity();
    const { oldHost, newHost, unmount } = await mountBoth();
    try {
      await flushDom(() => oldHost.querySelectorAll(".memory-file-item").length === 2 && newHost.querySelectorAll(".memory-file-item").length === 2, "初始文件列表");
      expect(newHost.innerHTML).toBe(oldHost.innerHTML);
      expect(newHost.textContent).toContain("记忆治理（2）");
      // 传输调用对账：双侧各一次列表调用
      expect(oldCallsCount(env.oldCalls, "GET", "/api/memory")).toBe(1);
      expect(env.newCalls.filter((c) => c.channel === "op:memory:list")).toHaveLength(1);
    } finally {
      unmount();
    }
  });

  it("点击文件加载内容：DOM 一致 + 传输形态一致", async () => {
    const env = setupComponentParity();
    const { oldHost, newHost, unmount } = await mountBoth();
    try {
      await flushDom(() => newHost.querySelectorAll(".memory-file-item").length === 2, "文件列表就绪");
      const itemOld = oldHost.querySelectorAll(".memory-file-item")[0] as HTMLElement;
      const itemNew = newHost.querySelectorAll(".memory-file-item")[0] as HTMLElement;
      await act(async () => {
        itemOld.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
        itemNew.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      });
      await flushDom(() => (newHost.querySelector(".memory-textarea") as HTMLTextAreaElement | null)?.value === FILE_CONTENT, "文件内容加载");
      expect(newHost.innerHTML).toBe(oldHost.innerHTML);
      expect((newHost.querySelector(".memory-textarea") as HTMLTextAreaElement).value).toBe(FILE_CONTENT);
      // 旧侧 GET /api/memory/MEMORY.md；新侧 op:memory:file:get params.rel=MEMORY.md
      expect(oldCallsCount(env.oldCalls, "GET", "/api/memory/MEMORY.md")).toBe(1);
      const fileGet = env.newCalls.filter((c) => c.channel === "op:memory:file:get");
      expect(fileGet).toHaveLength(1);
      expect((fileGet[0]?.payload?.params as { rel: string }).rel).toBe("MEMORY.md");
    } finally {
      unmount();
    }
  });

  it("待沉淀建议渲染 + 确认写入调用形态一致", async () => {
    const env = setupComponentParity();
    const { oldHost, newHost, unmount } = await mountBoth();
    try {
      await flushDom(() => oldHost.querySelectorAll(".memory-proposal-row").length === 2, "建议列表");
      expect(newHost.innerHTML).toBe(oldHost.innerHTML);
      const approveOld = [...oldHost.querySelectorAll(".memory-proposal-actions .btn-xs.primary")][0] as HTMLElement;
      const approveNew = [...newHost.querySelectorAll(".memory-proposal-actions .btn-xs.primary")][0] as HTMLElement;
      await act(async () => {
        approveOld.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
        approveNew.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      });
      await flushDom(() =>
        env.oldCalls.some((c) => c.method === "POST" && c.url === "/api/memory/proposals/p1/approve") &&
        env.newCalls.some((c) => c.channel === "op:memory:proposals:approve"),
        "approve 调用");
      expect(oldCallsCount(env.oldCalls, "POST", "/api/memory/proposals/p1/approve")).toBe(1);
      expect(env.oldCalls.find((c) => c.url === "/api/memory/proposals/p1/approve")?.body).toBe("{}");
      const approves = env.newCalls.filter((c) => c.channel === "op:memory:proposals:approve");
      expect(approves).toHaveLength(1);
      expect(approves[0]?.payload?.params).toEqual({ id: "p1" });
      expect(approves[0]?.payload?.body).toEqual({});
    } finally {
      unmount();
    }
  });

  it("记忆变更事件：Dock 渲染一致；查看中文件自动刷新；卸载释放流槽位", async () => {
    const env = setupComponentParity();
    const { oldHost, newHost, unmount } = await mountBoth();
    try {
      await flushDom(() => newHost.querySelectorAll(".memory-file-item").length === 2, "文件列表就绪");
      // 打开 MEMORY.md 后推送变更 → Dock 出现 + 自动重新加载
      const itemOld = oldHost.querySelectorAll(".memory-file-item")[0] as HTMLElement;
      const itemNew = newHost.querySelectorAll(".memory-file-item")[0] as HTMLElement;
      await act(async () => {
        itemOld.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
        itemNew.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      });
      await flushDom(() => Boolean(newHost.querySelector(".memory-textarea")), "内容加载");
      const before = oldCallsCount(env.oldCalls, "GET", "/api/memory/MEMORY.md");
      const beforeNew = env.newCalls.filter((c) => c.channel === "op:memory:file:get").length;
      await act(async () => {
        env.emitMemoryChange({ file: "MEMORY.md", event: "change", preview: "新预览", time: 123 });
      });
      await flushDom(() => Boolean(newHost.querySelector(".memory-dock")), "Dock 出现");
      expect(newHost.innerHTML).toBe(oldHost.innerHTML);
      expect(newHost.textContent).toContain("MEMORY.md");
      await flushDom(() =>
        oldCallsCount(env.oldCalls, "GET", "/api/memory/MEMORY.md") === before + 1 &&
        env.newCalls.filter((c) => c.channel === "op:memory:file:get").length === beforeNew + 1,
        "自动刷新触发");
      // 卸载释放
      unmount();
      expect(activeStreamCount()).toBe(0);
      expect(env.newMemoryStops.n).toBeGreaterThanOrEqual(1);
      return;
    } finally {
      // unmount 已在 try 内调用；兜底清理宿主
      oldHost.remove();
      newHost.remove();
    }
  });

  function oldCallsCount(calls: Array<{ method: string; url: string }>, method: string, url: string): number {
    return calls.filter((c) => c.method === method && c.url === url).length;
  }
});
