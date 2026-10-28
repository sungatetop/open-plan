/**
 * F6-2 内置浏览器域直调器对拍（browser-direct.ts ↔ server/index.mjs 路由语义）。
 *
 * 锚点行号均指 server/index.mjs：
 *   - state（L2084-2090）/ open（L2092-2102）/ stream-pause（L2105-2114）/
 *     fullpage+pdf（L2117-2138）/ input（L2271-2280）/ close（L2282-2291）/ reset（L2295-2305）；
 *   - GET /api/browser/stream（L2165-2269）→ createBrowserWatchRegistry：
 *     同键去重 / 初始 state 帧 / refreshTabs / frame 快照 / noteSubscribers / unwatch 幂等。
 *
 * 与既有 b2-builtin-browser-parity 互补：b2 对拍 builtin-browser 内部常量，本文件
 * 对拍通道层的信封语义（HTTP status 保留 / error code 保留 / body 透传形状）。
 */
import { describe, expect, it, vi } from "vitest";
import {
  BROWSER_DIRECT_CHANNELS,
  createBrowserWatchRegistry,
  invokeBrowserDirect,
  type BrowserDirectDeps
} from "../src/main/ipc/browser-direct";
import { BROWSER_INACTIVE_STATE, BROWSER_STREAM_EVENT_TYPE } from "../src/shared/protocol/channels";

const INACTIVE = { active: false, url: "", title: "", loading: false, hasFrame: false, ownership: { owner: "agent", reason: "", leaseExpiresAt: 0, secondsRemaining: 0 } };

function baseDeps(overrides: Partial<BrowserDirectDeps> = {}): BrowserDirectDeps {
  const session = {
    state: { active: true, viewport: { width: 1280, height: 800 } },
    frame: null,
    stateView: () => ({ active: true, url: "https://example.com" }),
    refreshTabs: vi.fn(async () => ({})),
    captureFrame: vi.fn(async () => ({})),
    noteSubscribers: vi.fn(async () => undefined)
  };
  return {
    browserSessionKey: (clientId, threadId) => `${clientId || ""}#${threadId || ""}`,
    getBrowserSession: (key) => (key === "c1#" ? session : null),
    browserOpen: vi.fn(async () => ({ active: true, url: "https://cn.bing.com" })),
    browserUserInput: vi.fn(async () => ({ ok: true })),
    browserClose: vi.fn(async () => ({ closed: true })),
    resetBrowserSession: vi.fn(async () => ({ closed: true })),
    browserSetStreamPaused: vi.fn(async () => undefined),
    browserFullpageScreenshot: vi.fn(async () => ({ file: "f.png", base64: "abc", bytes: 3, url: "u" })),
    browserPrintToPdf: vi.fn(async () => ({ file: "f.pdf", base64: "pdf", bytes: 3, url: "u" })),
    subscribeBrowser: vi.fn(() => () => undefined),
    browserSubscriberCount: vi.fn(() => 1),
    ...overrides
  };
}

describe("BROWSER_DIRECT_CHANNELS", () => {
  it("8 条通道与 channels.ts 清单对应路由一致", () => {
    expect(BROWSER_DIRECT_CHANNELS).toHaveLength(8);
    expect([...BROWSER_DIRECT_CHANNELS].sort()).toEqual([
      "op:browser:close",
      "op:browser:fullpage",
      "op:browser:input",
      "op:browser:open",
      "op:browser:pdf",
      "op:browser:reset",
      "op:browser:state",
      "op:browser:stream-pause"
    ]);
  });

  it("BROWSER_INACTIVE_STATE 与 server 默认 inactive 形状一致（L2088-2089）", () => {
    expect(BROWSER_INACTIVE_STATE).toEqual(INACTIVE);
  });
});

describe("invokeBrowserDirect 通道语义", () => {
  it("state：有会话回 stateView，无会话回 inactive 默认", async () => {
    const deps = baseDeps();
    expect(invokeBrowserDirect("op:browser:state", { query: { client: "c1", thread: "" } }, deps)).toEqual({
      ok: true,
      status: 200,
      data: { ok: true, state: { active: true, url: "https://example.com" } }
    });
    expect((await invokeBrowserDirect("op:browser:state", { query: { client: "ghost", thread: "t" } }, deps)).data).toEqual({
      ok: true,
      state: INACTIVE
    });
  });

  it("open：!client 400；url trim 空回退必应；失败 400 保留 code", async () => {
    const deps = baseDeps();
    expect((await invokeBrowserDirect("op:browser:open", { body: { thread: "t" } }, deps)).status).toBe(400);
    await invokeBrowserDirect("op:browser:open", { body: { client: "c1", url: "  " } }, deps);
    expect(deps.browserOpen).toHaveBeenCalledWith("c1#", "https://cn.bing.com");
    const failing = baseDeps({ browserOpen: vi.fn(async () => { throw Object.assign(new Error("导航失败"), { code: "NAV_FAILED" }); }) });
    const bad = await invokeBrowserDirect("op:browser:open", { body: { client: "c1" } }, failing);
    expect(bad).toMatchObject({ ok: false, status: 400, data: { ok: false, error: "导航失败", code: "NAV_FAILED" } });
  });

  it("stream-pause：!client 400；成功 ok；失败 400 无 code（L2113）", async () => {
    const deps = baseDeps();
    expect((await invokeBrowserDirect("op:browser:stream-pause", { body: {} }, deps)).status).toBe(400);
    expect((await invokeBrowserDirect("op:browser:stream-pause", { body: { client: "c1", paused: true } }, deps)).data).toEqual({ ok: true });
    expect(deps.browserSetStreamPaused).toHaveBeenCalledWith("c1#", true);
    const failing = baseDeps({ browserSetStreamPaused: vi.fn(async () => { throw new Error("boom"); }) });
    const bad = await invokeBrowserDirect("op:browser:stream-pause", { body: { client: "c1" } }, failing);
    expect(bad).toMatchObject({ ok: false, status: 400, data: { ok: false, error: "boom" } });
    expect((bad.data as { code?: string }).code).toBeUndefined();
  });

  it("fullpage/pdf：成功回 file/base64/bytes/url 四元组；失败 400+code", async () => {
    const deps = baseDeps();
    const shot = await invokeBrowserDirect("op:browser:fullpage", { body: { client: "c1", thread: "t" } }, deps);
    expect(shot.data).toEqual({ ok: true, file: "f.png", base64: "abc", bytes: 3, url: "u" });
    const pdf = await invokeBrowserDirect("op:browser:pdf", { body: { client: "c1", thread: "t" } }, deps);
    expect((pdf.data as { file: string }).file).toBe("f.pdf");
    const failing = baseDeps({ browserFullpageScreenshot: vi.fn(async () => { throw Object.assign(new Error("无帧"), { code: "NO_FRAME" }); }) });
    expect(await invokeBrowserDirect("op:browser:fullpage", { body: { client: "c1" } }, failing)).toMatchObject({ status: 400, data: { code: "NO_FRAME" } });
  });

  it("input：无 !client 守卫、body 透传（client/thread 剥离）、失败 400+code", async () => {
    const deps = baseDeps();
    await invokeBrowserDirect("op:browser:input", { body: { thread: "t", x: 1, y: 2, kind: "click" } }, deps);
    expect(deps.browserUserInput).toHaveBeenCalledWith("#t", { x: 1, y: 2, kind: "click" });
    const failing = baseDeps({ browserUserInput: vi.fn(async () => { throw Object.assign(new Error("接管中"), { code: "OWNERSHIP" }); }) });
    expect(await invokeBrowserDirect("op:browser:input", { body: { client: "c1" } }, failing)).toMatchObject({ status: 400, data: { code: "OWNERSHIP" } });
  });

  it("close：force 归一化 + reason 缺省空串；失败 500 无 code（重置判定靠 message）", async () => {
    const deps = baseDeps();
    await invokeBrowserDirect("op:browser:close", { body: { client: "c1", force: "yes" } }, deps);
    expect(deps.browserClose).toHaveBeenCalledWith("c1#", { force: false, reason: "" });
    const failing = baseDeps({ browserClose: vi.fn(async () => { throw new Error("单例锁被占用"); }) });
    const bad = await invokeBrowserDirect("op:browser:close", { body: { client: "c1" } }, failing);
    expect(bad).toMatchObject({ ok: false, status: 500, data: { ok: false, error: "单例锁被占用" } });
    expect((bad.data as { code?: string }).code).toBeUndefined();
  });

  it("reset：!client 400；失败 500 无 code", async () => {
    const deps = baseDeps();
    expect((await invokeBrowserDirect("op:browser:reset", { body: {} }, deps)).status).toBe(400);
    const failing = baseDeps({ resetBrowserSession: vi.fn(async () => { throw new Error("CDP 端点不可用"); }) });
    expect(await invokeBrowserDirect("op:browser:reset", { body: { client: "c1", thread: "t" } }, failing)).toMatchObject({ status: 500, data: { error: "CDP 端点不可用" } });
  });

  it("未知通道 404", () => {
    expect(invokeBrowserDirect("op:browser:unknown", {}, baseDeps())).toMatchObject({ ok: false, status: 404 });
  });
});

describe("createBrowserWatchRegistry（GET /api/browser/stream 推桥）", () => {
  it("watch 序：初始 state 帧 → refreshTabs（active 时）→ frame 快照（withFrames）→ 订阅 → noteSubscribers", () => {
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const deps = baseDeps({
      getBrowserSession: (key) => ({
        state: { active: true, viewport: { width: 1280, height: 800 } },
        frame: { data: "data:image/png;base64,xyz", at: 1, width: 0, height: 0 },
        stateView: () => ({ active: true, url: "https://example.com" }),
        refreshTabs: vi.fn(async () => ({})),
        captureFrame: vi.fn(async () => ({})),
        noteSubscribers: vi.fn(async () => undefined)
      })
    });
    const registry = createBrowserWatchRegistry(deps, (event) => emitted.push({ event: event.data.event, payload: event.data.payload }));
    registry.watch({ client: "c1", thread: "t" });
    expect(emitted.map((item) => item.event)).toEqual(["state", "frame"]);
    // 帧宽高缺省回退 state.viewport（L2247-2251）
    expect(emitted[1]!.payload).toMatchObject({ data: "data:image/png;base64,xyz", width: 1280, height: 800 });
    expect(deps.subscribeBrowser).toHaveBeenCalledWith("c1#t", expect.any(Function));
    expect(deps.browserSubscriberCount).toHaveBeenCalledWith("c1#t");
  });

  it("同键重复 watch：先退订再重订阅并重发快照（同键去重）", () => {
    const emitted: string[] = [];
    const unsubscribes: Array<() => void> = [];
    const deps = baseDeps({
      subscribeBrowser: vi.fn(() => {
        const unsubscribe = vi.fn();
        unsubscribes.push(unsubscribe);
        return unsubscribe;
      })
    });
    const registry = createBrowserWatchRegistry(deps, (event) => emitted.push(event.data.event));
    registry.watch({ client: "c1" });
    registry.watch({ client: "c1" });
    expect(unsubscribes[0]!).toHaveBeenCalled();
    expect(deps.subscribeBrowser).toHaveBeenCalledTimes(2);
    expect(emitted).toEqual(["state", "state"]);
    expect(registry.size()).toBe(1);
  });

  it("subscribe 回调按 (client, thread) 与 frames 偏好过滤转发", () => {
    const emitted: Array<{ event: string; payload: unknown }> = [];
    let handler: ((type: string, data: unknown) => void) | null = null;
    const deps = baseDeps({
      getBrowserSession: () => null,
      subscribeBrowser: vi.fn((_key, fn) => { handler = fn; return () => undefined; })
    });
    const registry = createBrowserWatchRegistry(deps, (event) => emitted.push({ event: event.data.event, payload: event.data.payload }));
    registry.watch({ client: "c1", thread: "t", frames: false });
    handler!("frame", { data: "img" });
    handler!("tabs", { tabs: [] });
    expect(emitted.map((item) => item.event)).toEqual(["state", "tabs"]);
    registry.unwatch({ client: "c1", thread: "t" });
    expect(registry.size()).toBe(0);
  });

  it("unwatch 未知键幂等；!client 的 watch 直接幂等返回", () => {
    const deps = baseDeps({ getBrowserSession: () => null });
    const registry = createBrowserWatchRegistry(deps, () => undefined);
    expect(registry.unwatch({ client: "ghost" })).toEqual({ ok: true });
    expect(registry.watch({ client: "" })).toEqual({ ok: true });
    expect(deps.subscribeBrowser).not.toHaveBeenCalled();
  });

  it("事件出口使用 BROWSER_STREAM_EVENT_TYPE（op:browser-stream）", () => {
    expect(BROWSER_STREAM_EVENT_TYPE).toBe("op:browser-stream");
  });
});
