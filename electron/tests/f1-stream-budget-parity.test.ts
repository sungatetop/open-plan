import { describe, it, expect, vi } from "vitest";
import {
  MAX_STREAMS,
  streamEvents,
  noteCursorGap,
  cursorGapStats,
  resetCursorGaps,
  streamSnapshot,
  activeStreamCount,
  hasStreamSlot,
  acquireStream,
  closeOptionalStreams,
  releaseStream,
  subscribeStreams,
  waitForStreamSlot,
  resetStreams,
  closeEventSourceQuietly,
} from "../src/renderer/lib/stream-budget";

const clientModule = await import("../../client/src/stream-budget.js");
const client = clientModule as unknown as {
  MAX_STREAMS: number;
  streamEvents: typeof streamEvents;
  noteCursorGap: typeof noteCursorGap;
  cursorGapStats: typeof cursorGapStats;
  resetCursorGaps: typeof resetCursorGaps;
  streamSnapshot: typeof streamSnapshot;
  activeStreamCount: typeof activeStreamCount;
  hasStreamSlot: typeof hasStreamSlot;
  acquireStream: typeof acquireStream;
  closeOptionalStreams: typeof closeOptionalStreams;
  releaseStream: typeof releaseStream;
  subscribeStreams: typeof subscribeStreams;
  waitForStreamSlot: typeof waitForStreamSlot;
  resetStreams: typeof resetStreams;
  closeEventSourceQuietly: typeof closeEventSourceQuietly;
};

type BudgetMod = typeof client;

/** 固定时钟：每次 advance 前进 100ms，让 ageMs/at/updatedAt 全部确定化。 */
function withMockClock<T>(fn: (advance: () => void) => T): T {
  const origNow = Date.now;
  let t = 1_000_000;
  (Date as any).now = () => t;
  try {
    return fn(() => { t += 100; });
  } finally {
    Date.now = origNow;
  }
}

function withWindowStub<T>(fn: () => T): T {
  const desc = Object.getOwnPropertyDescriptor(globalThis, "window");
  (globalThis as any).window = {};
  try {
    return fn();
  } finally {
    if (desc) Object.defineProperty(globalThis, "window", desc);
    else delete (globalThis as any).window;
  }
}

interface ScenarioOut {
  [key: string]: unknown;
}

/** 同一操作序列分别跑在 TS 版与 client 版上，收集全部可观察输出。 */
function runScenario(mod: BudgetMod, advance: () => void): ScenarioOut {
  const out: ScenarioOut = {};
  mod.resetStreams();
  advance();

  const collected: Array<unknown> = [];
  const unsub1 = mod.subscribeStreams((snap: any) => collected.push({ tag: "first", count: snap.length }));
  out.unsub1Result = unsub1();
  let subscribeThrowSync = false;
  try {
    mod.subscribeStreams(() => { throw new Error("boom"); });
  } catch {
    subscribeThrowSync = true;
  }
  out.subscribeThrowSync = subscribeThrowSync; // subscribe 时的立即回调不兜错，直接抛
  const keepUnsub = mod.subscribeStreams((snap: any) => collected.push({ tag: "keep", count: snap.length }));

  out.max = mod.MAX_STREAMS;
  out.hasSlot0 = mod.hasStreamSlot();
  out.count0 = mod.activeStreamCount();
  advance();

  // 满 3 条：两条 essential + 一条 optional
  const chat = mod.acquireStream("chat", { essential: true, priority: 1, label: "对话流" });
  advance();
  const events = mod.acquireStream("events", { essential: true });
  const frame = mod.acquireStream("browser-frame");
  advance();
  out.keys3 = [chat?.key, events?.key, frame?.key];
  out.count3 = mod.activeStreamCount();
  out.hasSlot3 = mod.hasStreamSlot();

  // 第 4 条非必需 → 拒绝
  out.denied = mod.acquireStream("memory");
  advance();
  // 第 4 条必需 → 顶掉唯一可放弃的 browser-frame
  const must = mod.acquireStream("must-have", { essential: true, priority: 0, label: "全局帧" });
  advance();
  out.keysAfterEvict = mod.streamSnapshot().map((s: any) => s.key);
  out.snapAfterEvict = mod.streamSnapshot();
  let evictedClosed = false;
  out.attachFalse = frame!.attach(() => { evictedClosed = true; });
  out.evictedClosed = evictedClosed;

  const closeCalls: string[] = [];
  out.attachTrue = chat!.attach(() => closeCalls.push("chat"));
  advance();

  // waitForStreamSlot：满 → 排队，等 release 让位后回调一次
  const waited: string[] = [];
  mod.waitForStreamSlot(() => waited.push("got"));
  advance();
  out.releaseEvents = mod.releaseStream(events!.key);
  advance();
  out.waited = waited;
  out.countAfterRelease = mod.activeStreamCount();

  // 有空位时 waitForStreamSlot 立即回调
  const waited2: string[] = [];
  mod.waitForStreamSlot(() => waited2.push("now"));
  out.waited2 = waited2;

  // 释放必需流让出第二个槽位，两条 optional 并存（p9 与 p2）
  out.releaseMust = mod.releaseStream(must!.key);
  advance();
  const low = mod.acquireStream("low-p", { priority: 9 });
  const high = mod.acquireStream("high-p", { priority: 2 });
  advance();
  out.keysTwoOptional = mod.streamSnapshot().map((s: any) => s.key);
  // 必需流顶替：p9 的 low-p 先被牺牲
  mod.acquireStream("another-must", { essential: true });
  advance();
  out.afterSecondEvict = mod.streamSnapshot().map((s: any) => s.key);

  // closeOptionalStreams：只回收非必需，close 动作真正执行
  let lowClosed = false;
  low!.attach(() => { lowClosed = true; });
  let highClosed = false;
  high!.attach(() => { highClosed = true; });
  advance();
  out.reclaimClosed = mod.closeOptionalStreams("救援");
  out.lowClosed = lowClosed;
  out.highClosed = highClosed;
  out.countAfterReclaim = mod.activeStreamCount();
  advance();

  out.releaseBogus = mod.releaseStream("nope#999");
  out.releaseChat = mod.releaseStream(chat!.key);
  out.closeCalls = closeCalls;
  advance();

  // 游标缺号记录
  mod.resetCursorGaps();
  out.gap1 = mod.noteCursorGap(3, 7);
  out.gap2 = mod.noteCursorGap(10, 10);
  out.gapStats = mod.cursorGapStats();
  mod.resetCursorGaps();
  out.gapStatsAfterReset = mod.cursorGapStats();
  for (let i = 0; i < 45; i++) mod.noteCursorGap(i, i + 2);
  out.gapCapStats = mod.cursorGapStats();
  out.gapCapLatest = mod.cursorGapStats().latest.map((g: any) => [g.from, g.to]);
  out.gapFirst40Missed = mod.cursorGapStats().missed;

  out.eventsAll = mod.streamEvents(1000);
  out.eventsDefaultCap = mod.streamEvents();
  out.finalSnapshot = mod.streamSnapshot();
  out.finalCount = mod.activeStreamCount();
  out.windowGlobal = (globalThis as any).window?.__oawStreams ?? null;

  keepUnsub();
  mod.resetStreams();
  out.afterResetCount = mod.activeStreamCount();
  out.afterResetEvents = mod.streamEvents();
  out.afterResetHasSlot = mod.hasStreamSlot();
  return out;
}

describe("stream-budget TS 版与 client 版等价（对拍）", () => {
  it("MAX_STREAMS 常量一致", () => {
    expect(MAX_STREAMS).toBe(3);
    expect(MAX_STREAMS).toBe(client.MAX_STREAMS);
  });

  it("预算表全生命周期：申请/拒绝/顶替/attach/release/回收/等待/缺号/事件日志逐字段一致", () => {
    const ts = withWindowStub(() => withMockClock((advance) => runScenario(
      {
        MAX_STREAMS, streamEvents, noteCursorGap, cursorGapStats, resetCursorGaps, streamSnapshot,
        activeStreamCount, hasStreamSlot, acquireStream, closeOptionalStreams, releaseStream,
        subscribeStreams, waitForStreamSlot, resetStreams, closeEventSourceQuietly,
      } as BudgetMod,
      advance,
    )));
    const js = withWindowStub(() => withMockClock((advance) => runScenario(client, advance)));
    expect(ts).toEqual(js);

    // 绝对锚点
    expect(ts.keys3).toEqual(["chat#1", "events#2", "browser-frame#3"]);
    expect(ts.denied).toBeNull();
    expect(ts.keysAfterEvict).toEqual(["chat#1", "events#2", "must-have#4"]);
    expect(ts.attachFalse).toBe(false);
    expect(ts.evictedClosed).toBe(true);
    expect(ts.attachTrue).toBe(true);
    expect(ts.waited).toEqual(["got"]);
    expect(ts.waited2).toEqual(["now"]);
    // p9 与 p2 并存；another-must 顶掉 p9 的 low-p，保留 p2 的 high-p
    expect(ts.releaseMust).toBe(true);
    expect(ts.keysTwoOptional).toEqual(["chat#1", "low-p#5", "high-p#6"]);
    expect(ts.afterSecondEvict).toEqual(["chat#1", "high-p#6", "another-must#7"]);
    expect(ts.reclaimClosed).toBe(1);
    expect(ts.lowClosed).toBe(true);
    expect(ts.highClosed).toBe(true);
    expect(ts.countAfterReclaim).toBe(2);
    expect(ts.releaseBogus).toBe(false);
    expect(ts.releaseChat).toBe(true);
    expect(ts.closeCalls).toEqual(["chat"]);
    expect((ts.gap1 as number)).toBe(1);
    expect((ts.gap2 as number)).toBe(2);
    expect(ts.gapStats).toMatchObject({ count: 2, missed: 3 });
    expect(ts.gapCapStats).toMatchObject({ count: 40, missed: 40 });
    // 40 条上限保留最后 40 条（i=5..44），latest 5 = i=40..44
    expect(ts.gapCapLatest).toEqual([[40, 42], [41, 43], [42, 44], [43, 45], [44, 46]]);
    expect(ts.afterResetCount).toBe(0);
    expect(ts.afterResetEvents).toEqual([]);
    // window 全局镜像（场景结束时仅剩 another-must#7 一条 essential）
    expect((ts.windowGlobal as any).max).toBe(3);
    expect((ts.windowGlobal as any).active).toBe(1);
    expect((ts.windowGlobal as any).items).toHaveLength(1);
    expect((ts.windowGlobal as any).items[0].key).toBe("another-must#7");
  });

  it("事件日志：动作序列与原因文本一致（含 evict/denied/reclaim 文案）", () => {
    const ts = tsScenarioLog();
    const js = jsScenarioLog();
    expect(ts).toEqual(js);
    const actions = (ts as any[]).map((e) => `${e.kind}:${e.action}`);
    expect(actions).toContain("browser-frame:evict");
    expect(actions).toContain("memory:denied");
    expect(actions).toContain("opt:open");
    expect(actions).toContain("optional:reclaim");
    const evict = (ts as any[]).find((e) => e.action === "evict");
    // must 未带 label → reason 回退 kind
    expect(evict.reason).toBe("为必需流「must」让位");
    const denied = (ts as any[]).find((e) => e.action === "denied");
    expect(denied.reason).toBe("长连接预算已满（3/3）");
    const reclaim = (ts as any[]).find((e) => e.action === "reclaim");
    expect(reclaim.kind).toBe("optional");
    expect(reclaim.reason).toBe("救援");
  });

  function tsScenarioLog(): unknown {
    return withWindowStub(() => withMockClock(() => {
      resetStreams();
      const eventsStream = acquireStream("events", { essential: true });
      acquireStream("chat", { essential: true, priority: 1, label: "对话流" });
      acquireStream("browser-frame");
      acquireStream("memory");
      acquireStream("must", { essential: true });
      releaseStream(eventsStream!.key);
      acquireStream("opt");
      closeOptionalStreams("救援");
      const log = streamEvents(100);
      resetStreams();
      return log;
    }));
  }
  function jsScenarioLog(): unknown {
    return withWindowStub(() => withMockClock(() => {
      client.resetStreams();
      const eventsStream = client.acquireStream("events", { essential: true });
      client.acquireStream("chat", { essential: true, priority: 1, label: "对话流" });
      client.acquireStream("browser-frame");
      client.acquireStream("memory");
      client.acquireStream("must", { essential: true });
      client.releaseStream(eventsStream!.key);
      client.acquireStream("opt");
      client.closeOptionalStreams("救援");
      const log = client.streamEvents(100);
      client.resetStreams();
      return log;
    }));
  }
});

type HandlerMap = Record<string, Array<[any, any]>>;

/** 监听器注册形状（函数按"是否函数"比较，避免函数引用不等造成假失败）。 */
function handlerShape(h: HandlerMap): Record<string, Array<{ isFn: boolean; opts: unknown }>> {
  return Object.fromEntries(
    Object.entries(h).map(([key, list]) => [key, list.map(([fn, opts]) => ({ isFn: typeof fn === "function", opts }))]),
  );
}

describe("closeEventSourceQuietly TS 版与 client 版等价（对拍）", () => {
  /** 造一个 fake EventSource 实例，记录 close 与 addEventListener 调用。 */
  function makeEs(readyState: number | undefined): { es: any; closes: () => number; handlers: () => Record<string, Array<[any, any]>> } {
    let closeCount = 0;
    const registered: Record<string, Array<[any, any]>> = {};
    const es = {
      readyState,
      close: () => { closeCount += 1; },
      addEventListener: (type: string, fn: any, opts: any) => {
        (registered[type] ||= []).push([fn, opts]);
      },
    };
    return { es, closes: () => closeCount, handlers: () => registered };
  }

  it("无 EventSource 全局 / null / CLOSED：立即 close，行为一致", () => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
    delete (globalThis as any).EventSource;
    try {
      expect(() => closeEventSourceQuietly(null)).not.toThrow();
      expect(() => client.closeEventSourceQuietly(null)).not.toThrow();
      const d = makeEs(1);
      const s = makeEs(1);
      closeEventSourceQuietly(d.es);
      client.closeEventSourceQuietly(s.es);
      expect(d.closes()).toBe(1);
      expect(s.closes()).toBe(1);
      expect(handlerShape(d.handlers())).toEqual(handlerShape(s.handlers()));
    } finally {
      if (desc) Object.defineProperty(globalThis, "EventSource", desc);
    }
  });

  it("OPEN 分支：注册 error 监听、POST stream/close、error 到达时 close 恰好一次", async () => {
    vi.useFakeTimers();
    const desc = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
    const origFetch = globalThis.fetch;
    (globalThis as any).EventSource = { CLOSED: 3, OPEN: 1, CONNECTING: 0 };
    const fetches: Array<{ url: string; opts: Record<string, any> }> = [];
    globalThis.fetch = (async (url: string, opts: Record<string, any>) => {
      fetches.push({ url, opts });
      return new Response(null, { status: 200 });
    }) as any;
    try {
      const d = makeEs(1);
      const s = makeEs(1);
      closeEventSourceQuietly(d.es, { client: "c1", thread: "t1" });
      client.closeEventSourceQuietly(s.es, { client: "c1", thread: "t1" });
      expect(handlerShape(d.handlers())).toEqual(handlerShape(s.handlers()));
      expect(Object.keys(d.handlers())).toEqual(["error"]);
      expect(d.handlers().error![0]![1]).toEqual({ once: true });
      // error 事件到达 → close；重复到达不重复 close
      d.handlers().error![0]![0]!();
      d.handlers().error![0]![0]!();
      s.handlers().error![0]![0]!();
      s.handlers().error![0]![0]!();
      expect(d.closes()).toBe(1);
      expect(s.closes()).toBe(1);
      // fetch POST 体一致
      expect(fetches).toHaveLength(2);
      expect(fetches[0]).toEqual(fetches[1]);
      expect(fetches[0]!.url).toBe("/api/agent/stream/close");
      expect(fetches[0]!.opts.method).toBe("POST");
      expect(JSON.parse(fetches[0]!.opts.body)).toEqual({ client: "c1", thread: "t1" });
    } finally {
      globalThis.fetch = origFetch;
      if (desc) Object.defineProperty(globalThis, "EventSource", desc);
      vi.useRealTimers();
    }
  });

  it("OPEN 无 meta / CLOSED / CONNECTING→open 回归 / close 抛错被吞：行为一致", () => {
    vi.useFakeTimers();
    const desc = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
    (globalThis as any).EventSource = { CLOSED: 3, OPEN: 1, CONNECTING: 0 };
    try {
      // OPEN 无 meta → 直接 finish
      const a1 = makeEs(1); const a2 = makeEs(1);
      closeEventSourceQuietly(a1.es, {});
      client.closeEventSourceQuietly(a2.es, {});
      expect(a1.closes()).toBe(1);
      expect(a2.closes()).toBe(1);
      // CLOSED → 立即 finish
      const b1 = makeEs(3); const b2 = makeEs(3);
      closeEventSourceQuietly(b1.es);
      client.closeEventSourceQuietly(b2.es);
      expect(b1.closes()).toBe(1);
      expect(b2.closes()).toBe(1);
      // CONNECTING → 注册 open/error；置 readyState=OPEN 后 open 到达，
      // 递归按无 meta 处理 → 直接 close
      const c1 = makeEs(0); const c2 = makeEs(0);
      closeEventSourceQuietly(c1.es, {});
      client.closeEventSourceQuietly(c2.es, {});
      expect(Object.keys(c1.handlers()).sort()).toEqual(["error", "open"]);
      expect(handlerShape(c1.handlers())).toEqual(handlerShape(c2.handlers()));
      c1.es.readyState = 1;
      c2.es.readyState = 1;
      c1.handlers().open![0]![0]!();
      c2.handlers().open![0]![0]!();
      expect(c1.closes()).toBe(1);
      expect(c2.closes()).toBe(1);
      // CONNECTING + meta：open 回归后走 OPEN 分支再注册 error（error 监听变两条）
      const e1 = makeEs(0); const e2 = makeEs(0);
      closeEventSourceQuietly(e1.es, { client: "c" });
      client.closeEventSourceQuietly(e2.es, { client: "c" });
      e1.es.readyState = 1;
      e2.es.readyState = 1;
      e1.handlers().open![0]![0]!();
      e2.handlers().open![0]![0]!();
      expect(Object.keys(e1.handlers()).sort()).toEqual(["error", "open"]);
      expect(handlerShape(e1.handlers())).toEqual(handlerShape(e2.handlers()));
      e1.handlers().error![0]![0]!();
      e2.handlers().error![0]![0]!();
      expect(e1.closes()).toBe(1);
      expect(e2.closes()).toBe(1);
      // close 抛错被吞，不向外抛
      const boom = { readyState: 3, close: () => { throw new Error("destroyed"); } };
      expect(() => closeEventSourceQuietly(boom)).not.toThrow();
      expect(() => client.closeEventSourceQuietly(boom)).not.toThrow();
      // readyState undefined → 三个分支都不命中 → 直接 finish
      const u1 = makeEs(undefined); const u2 = makeEs(undefined);
      closeEventSourceQuietly(u1.es);
      client.closeEventSourceQuietly(u2.es);
      expect(u1.closes()).toBe(1);
      expect(u2.closes()).toBe(1);
    } finally {
      if (desc) Object.defineProperty(globalThis, "EventSource", desc);
      vi.useRealTimers();
    }
  });
});
