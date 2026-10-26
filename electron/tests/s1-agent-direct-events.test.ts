/**
 * S1 对话流直推桥对拍（agent-direct-events.ts）。
 *
 * 覆盖面：
 *   - 帧序列与字段对齐 server/index.mjs /api/agent/stream 的推送语义
 *     （runtime_connecting → 订阅 → connected → 可选 stream_resync → 历史回放 → 实时）；
 *   - 幂等门闩（重放/实时不重复）、游标续传与代际清零、truncated → stream_resync；
 *   - ensureRuntime 45s 超时转录（runtime_init_failed + retryable）与失败分类帧；
 *   - watch/stop 生命周期（同键幂等、切键摘除旧订阅、非当前键 stop 忽略）；
 *   - 心跳 → op:heartbeat 活性帧（与 events-bridge 对 SSE heartbeat 的转发同形）；
 *   - 对拍锚点：同一逻辑通道事件经 events-bridge（SSE 桥）与直推桥的
 *     op:event 通道事件帧逐一相等（id/type/at/streamId/protocolVersion/data）。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createAgentDirectEventsBridge, type DirectAgentManagerView, type DirectEntryView } from "../src/main/ipc/agent-direct-events";
import { createEventStreamBridge, type EventStreamFetch, type EventStreamResponse } from "../src/main/ipc/events-bridge";
import { PROTOCOL_VERSION } from "../src/shared/runtime/event-protocol";
import type { DesktopEvent } from "../src/shared/protocol/channels";

interface ChannelStub {
  streamId: string;
  history: Array<{ id: number; type: string; at?: string; streamId?: string; data?: unknown }>;
  seq: number;
  emit(ev: unknown): void;
  listenerCount(): number;
}

type EnsureCall = { key: string; options: Record<string, unknown> };

function makeManager(channels: Map<string, ChannelStub>, calls: EnsureCall[]): DirectAgentManagerView {
  return {
    async ensureRuntime(key, options) {
      calls.push({ key: String(key), options: (options ?? {}) as Record<string, unknown> });
      const channel = channels.get(String(key));
      if (!channel) throw new Error(`entry not found: ${key}`);
      return {
        channel: {
          streamId: channel.streamId,
          seq: channel.seq,
          history: channel.history,
          emitter: {
            on: (_evt, fn) => { listenersOf(channel).add(fn); },
            off: (_evt, fn) => { listenersOf(channel).delete(fn); }
          }
        },
        session: { sessionId: "sess-1", model: { provider: "prov", id: "model-a" } },
        modelFallbackSpec: "prov/model-x",
        modelFallbackFrom: null
      } as Awaited<ReturnType<DirectAgentManagerView["ensureRuntime"]>>;
    }
  };
}

/** 通道 emitter 监听器注册表（WeakMap 持有，结构化访问 listenerCount）。 */
const listenerMaps = new WeakMap<ChannelStub, Set<(ev: unknown) => void>>();
function listenersOf(channel: ChannelStub): Set<(ev: unknown) => void> {
  let set = listenerMaps.get(channel);
  if (!set) {
    set = new Set();
    listenerMaps.set(channel, set);
  }
  return set;
}

function makeChannel(streamId: string, history: ChannelStub["history"] = []): ChannelStub {
  const listeners: Set<(ev: unknown) => void> = new Set();
  const channel: ChannelStub = {
    streamId,
    history,
    seq: history.length ? Number(history[history.length - 1]?.id || 0) : 0,
    emit(ev) {
      for (const fn of [...listeners]) fn(ev);
    },
    listenerCount() {
      return listeners.size;
    }
  };
  listenerMaps.set(channel, listeners);
  return channel;
}

function ev(id: number, type = "token", data: Record<string, unknown> = { value: `v${id}` }): ChannelStub["history"][number] {
  return { id, type, at: `2026-01-01T00:00:0${id % 10}.000Z`, streamId: "S1", data };
}

async function until(assert: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!assert()) {
    if (Date.now() > deadline) throw new Error("until: condition not met");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("S1 agent 直推桥：帧编排对齐 SSE 路由语义", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("首连帧序列：connecting → connected(cursor/earliest/latest/truncated) → 全量回放", async () => {
    const channel = makeChannel("S1", [ev(1, "run_admitted"), ev(2), ev(3)]);
    const calls: EnsureCall[] = [];
    const frames: DesktopEvent[] = [];
    const bridge = createAgentDirectEventsBridge({
      getManager: async () => makeManager(new Map([["c1::t1", channel]]), calls),
      send: (event) => frames.push(event),
      resolveWorkspace: () => "D:/ws",
      resolveDefaultModel: () => ""
    });
    const result = await bridge.watch({ client: "c1", thread: "t1" });
    expect(result).toEqual({ ok: true });

    expect(frames[0]).toMatchObject({ type: "runtime_connecting", data: { client: "c1", thread: "t1" } });
    const connected = frames[1] as NonNullable<typeof frames[1]>;
    expect(connected.type).toBe("connected");
    expect(connected.data).toMatchObject({
      client: "c1",
      thread: "t1",
      protocolVersion: PROTOCOL_VERSION,
      streamId: "S1",
      sessionId: "sess-1",
      model: "prov/model-x",
      modelFallbackFrom: null,
      cursor: 0,
      earliest: 1,
      latest: 3,
      truncated: false
    });
    const replayed = frames.slice(2).filter((f) => typeof f.id === "number");
    expect(replayed.map((f) => f.id)).toEqual([1, 2, 3]);
    expect(replayed[0]).toMatchObject({
      id: 1, type: "run_admitted", at: "2026-01-01T00:00:01.000Z",
      streamId: "S1", protocolVersion: PROTOCOL_VERSION, data: { value: "v1" }
    });
    // ensureRuntime 收到 manager 键（server agentKey 转录 `::` 分隔）与 cwd/modelSpec（SSE 路由同参）
    expect(calls[0] as NonNullable<typeof calls[0]>).toMatchObject({ key: "c1::t1", options: { threadId: "t1", cwd: "D:/ws", modelSpec: "" } });
    bridge.dispose();
  });

  test("实时事件经订阅转发；重复 id 被门闩抑制", async () => {
    const channel = makeChannel("S1", [ev(1)]);
    const frames: DesktopEvent[] = [];
    const bridge = createAgentDirectEventsBridge({
      getManager: async () => makeManager(new Map([["c1::t1", channel]]), []),
      send: (event) => frames.push(event)
    });
    await bridge.watch({ client: "c1", thread: "t1" });
    const base = frames.filter((f) => typeof f.id === "number").length;
    expect(base).toBe(1);
    // 重复 id（已回放过）不重复转发
    channel.emit(ev(1));
    expect(frames.filter((f) => f.id === 1).length).toBe(1);
    // 新事件转发一次
    channel.history.push(ev(2));
    channel.emit(ev(2));
    const forwarded = frames.filter((f) => f.id === 2);
    expect(forwarded.length).toBe(1);
    expect(forwarded[0]).toMatchObject({ id: 2, type: "token", data: { value: "v2" } });
    bridge.dispose();
  });

  test("游标续传：after=5 只回放 id>5", async () => {
    const history = [ev(4), ev(5), ev(6), ev(7)];
    const channel = makeChannel("S1", history);
    const frames: DesktopEvent[] = [];
    const bridge = createAgentDirectEventsBridge({
      getManager: async () => makeManager(new Map([["c1::t1", channel]]), []),
      send: (event) => frames.push(event)
    });
    await bridge.watch({ client: "c1", thread: "t1", after: 5, streamId: "S1" });
    expect(frames.filter((f) => typeof f.id === "number").map((f) => f.id)).toEqual([6, 7]);
    bridge.dispose();
  });

  test("代际清零：换线程重连携带旧代际 → 全量回放", async () => {
    const channelA = makeChannel("S1", [ev(1), ev(2)]);
    const channelB = makeChannel("S2", [ev(101), ev(102)]);
    const channels = new Map([
      ["c1::t1", channelA],
      ["c1::t2", channelB]
    ]);
    const frames: DesktopEvent[] = [];
    const bridge = createAgentDirectEventsBridge({
      getManager: async () => makeManager(channels, []),
      send: (event) => frames.push(event)
    });
    await bridge.watch({ client: "c1", thread: "t1", streamId: "S1" });
    frames.length = 0;
    await bridge.watch({ client: "c1", thread: "t2", after: 100, streamId: "S1" });
    expect(frames.filter((f) => typeof f.id === "number").map((f) => f.id)).toEqual([101, 102]);
    const connected = frames.find((f) => f.type === "connected");
    expect(connected?.data).toMatchObject({ streamId: "S2", cursor: 0 });
    bridge.dispose();
  });

  test("truncated → stream_resync 帧（回放窗外的游标）", async () => {
    const channel = makeChannel("S1", [ev(50)]); // 早期事件被淘汰，历史从 50 起
    const frames: DesktopEvent[] = [];
    const bridge = createAgentDirectEventsBridge({
      getManager: async () => makeManager(new Map([["c1::t1", channel]]), []),
      send: (event) => frames.push(event)
    });
    await bridge.watch({ client: "c1", thread: "t1", after: 10, streamId: "S1" });
    expect(frames.find((f) => f.type === "stream_resync")?.data).toMatchObject({
      cursor: 10, earliest: 50, latest: 50
    });
    expect(frames.filter((f) => typeof f.id === "number").map((f) => f.id)).toEqual([50]);
    bridge.dispose();
  });

  test("首连 300 条截尾；replayRecover 关（基线）", async () => {
    const history = Array.from({ length: 305 }, (_, i) => ev(i + 1));
    const channel = makeChannel("S1", history);
    const frames: DesktopEvent[] = [];
    const bridge = createAgentDirectEventsBridge({
      getManager: async () => makeManager(new Map([["c1::t1", channel]]), []),
      send: (event) => frames.push(event)
    });
    await bridge.watch({ client: "c1", thread: "t1" });
    const ids = frames.filter((f) => typeof f.id === "number").map((f) => f.id);
    expect(ids.length).toBe(300);
    expect(ids[0]).toBe(6);
    bridge.dispose();
  });

  test("ensureRuntime 超时：runtime_init_failed 帧 + retryable，后台操作继续", async () => {
    vi.useFakeTimers();
    const channel = makeChannel("S1", [ev(1)]);
    const frames: DesktopEvent[] = [];
    const release: { resolve?: (entry: DirectEntryView) => void } = {};
    const bridge = createAgentDirectEventsBridge({
      getManager: async () => ({
        ensureRuntime: async () => new Promise<DirectEntryView>((resolve) => { release.resolve = resolve; })
      }),
      send: (event) => frames.push(event),
      timeoutMs: 30
    });
    const pending = bridge.watch({ client: "c1", thread: "t1" });
    await vi.advanceTimersByTimeAsync(31);
    await pending;
    const failed = frames.find((f) => f.type === "runtime_init_failed");
    expect(failed?.data).toMatchObject({ client: "c1", thread: "t1", code: "RUNTIME_INIT_TIMEOUT", retryable: true });
    // 后台创建继续：释放后不产生新帧、不抛未处理拒绝
    release.resolve?.({
      channel: { streamId: "S1", seq: 1, history: [ev(1)], emitter: { on() {}, off() {} } }
    });
    await Promise.resolve();
    bridge.dispose();
  });

  test("ensureRuntime 失败：agent_error 帧（classifyAgentError 分类）", async () => {
    const frames: DesktopEvent[] = [];
    const bridge = createAgentDirectEventsBridge({
      getManager: async () => ({
        ensureRuntime: async () => { throw new Error("boom"); }
      }),
      send: (event) => frames.push(event)
    });
    const result = await bridge.watch({ client: "c1", thread: "t1" });
    expect(result).toEqual({ ok: true });
    const errorFrame = frames.find((f) => f.type === "agent_error");
    expect(errorFrame?.data).toMatchObject({ client: "c1", thread: "t1" });
    expect(String(errorFrame?.data?.message ?? "")).not.toBe("");
    bridge.dispose();
  });

  test("watch/stop 生命周期：同键幂等、切键摘除旧订阅、非当前键 stop 忽略", async () => {
    const channelA = makeChannel("S1", [ev(1)]);
    const channelB = makeChannel("S2", [ev(101)]);
    const channels = new Map([
      ["c1::t1", channelA],
      ["c1::t2", channelB]
    ]);
    const calls: EnsureCall[] = [];
    const frames: DesktopEvent[] = [];
    const states: string[] = [];
    const bridge = createAgentDirectEventsBridge({
      getManager: async () => makeManager(channels, calls),
      send: (event) => frames.push(event),
      onState: (state) => states.push(state)
    });
    // 无 client 拒绝
    expect(await bridge.watch({ client: "" })).toMatchObject({ ok: false });
    await bridge.watch({ client: "c1", thread: "t1" });
    const connectingCount = frames.filter((f) => f.type === "runtime_connecting").length;
    // 同键幂等：不再建连、不再调 ensureRuntime
    await bridge.watch({ client: "c1", thread: "t1" });
    expect(frames.filter((f) => f.type === "runtime_connecting").length).toBe(connectingCount);
    expect(calls.length).toBe(1);
    // 切键：旧通道订阅摘除
    await bridge.watch({ client: "c1", thread: "t2" });
    expect(channelA.listenerCount()).toBe(0);
    expect(channelB.listenerCount()).toBe(1);
    // 非当前键 stop 忽略
    bridge.stop({ client: "c1", thread: "t9" });
    channelB.history.push(ev(102));
    channelB.emit(ev(102));
    expect(frames.filter((f) => f.id === 102).length).toBe(1);
    // 当前键 stop：订阅摘除 + stopped
    bridge.stop({ client: "c1", thread: "t2" });
    expect(channelB.listenerCount()).toBe(0);
    channelB.emit(ev(103));
    expect(frames.filter((f) => typeof f.id === "number" && f.id === 103).length).toBe(0);
    expect(states).toEqual(["watching", "watching", "stopped"]);
    bridge.dispose();
  });

  test("心跳：op:heartbeat 活性帧按间隔推送，stop 后停止", async () => {
    vi.useFakeTimers();
    const channel = makeChannel("S1", [ev(1)]);
    const frames: DesktopEvent[] = [];
    const bridge = createAgentDirectEventsBridge({
      getManager: async () => makeManager(new Map([["c1::t1", channel]]), []),
      send: (event) => frames.push(event),
      heartbeatMs: 20
    });
    await bridge.watch({ client: "c1", thread: "t1" });
    await vi.advanceTimersByTimeAsync(45);
    const heartbeats = frames.filter((f) => f.type === "op:heartbeat");
    expect(heartbeats.length).toBeGreaterThanOrEqual(2);
    bridge.stop();
    const count = frames.filter((f) => f.type === "op:heartbeat").length;
    await vi.advanceTimersByTimeAsync(60);
    expect(frames.filter((f) => f.type === "op:heartbeat").length).toBe(count);
  });
});

describe("S1 对拍锚点：直推桥与 events-bridge（SSE 桥）通道事件帧逐一相等", () => {
  test("同一逻辑事件序列：SSE 转发帧 == 直推帧（id/type/at/streamId/protocolVersion/data）", async () => {
    const logical = [ev(1, "run_admitted"), ev(2, "token"), ev(3, "tool_output", { chunk: "x" }), ev(4, "run_finished", { summary: "done" })];
    const channel = makeChannel("S1", logical.slice(0, 3));

    // ── 路径 A：SSE 桥（模拟 server send() 的 SSE 字节流：前 3 条 history + 第 4 条实时） ──
    const sseSent: DesktopEvent[] = [];
    const encoder = new TextEncoder();
    const frames: string[] = [];
    frames.push(`data: ${JSON.stringify({ type: "runtime_connecting", at: "2026-01-01T00:00:00.000Z", data: { client: "c1", thread: "t1" } })}\n\n`);
    for (const item of logical.slice(0, 3)) {
      frames.push(`id: ${item.id}\ndata: ${JSON.stringify({
        id: item.id, protocolVersion: PROTOCOL_VERSION, streamId: item.streamId,
        type: item.type, at: item.at ?? null, data: item.data
      })}\n\n`);
    }
    frames.push(`event: heartbeat\ndata: ${JSON.stringify({ type: "heartbeat", at: "2026-01-01T00:00:09.000Z" })}\n\n`);
    const liveItem = logical[3] as NonNullable<typeof logical[3]>;
    frames.push(`id: ${liveItem.id}\ndata: ${JSON.stringify({
      id: liveItem.id, protocolVersion: PROTOCOL_VERSION, streamId: liveItem.streamId,
      type: liveItem.type, at: liveItem.at ?? null, data: liveItem.data
    })}\n\n`);

    const sseFetch: EventStreamFetch = async () => {
      let index = 0;
      const body = {
        getReader() {
          return {
            read: async (): Promise<{ done: boolean; value?: Uint8Array }> => {
              if (index < frames.length) {
                const value = encoder.encode(frames[index]);
                index += 1;
                return { done: false, value };
              }
              // 末帧消费后挂起：桥停留在读取态（不触发重连循环）
              return new Promise(() => {});
            }
          };
        }
      };
      return { ok: true, status: 200, body, text: async () => frames.join("") } as unknown as EventStreamResponse;
    };
    const sseBridge = createEventStreamBridge({
      getPort: () => 3003,
      send: (event) => sseSent.push(event),
      fetchImpl: sseFetch,
      delay: async () => {}
    });
    await sseBridge.watch({ client: "c1", thread: "t1" });
    await until(() => sseSent.filter((f) => typeof f.id === "number").length >= 4);

    // ── 路径 B：直推桥（同一通道：3 条 history + 第 4 条实时 emit） ──
    const directSent: DesktopEvent[] = [];
    const directBridge = createAgentDirectEventsBridge({
      getManager: async () => makeManager(new Map([["c1::t1", channel]]), []),
      send: (event) => directSent.push(event)
    });
    await directBridge.watch({ client: "c1", thread: "t1" });
    channel.history.push(liveItem);
    channel.emit(liveItem);

    // ── 对拍：通道事件帧（带 id）逐一相等 ──
    const sseEvents = sseSent.filter((f) => typeof f.id === "number");
    const directEvents = directSent.filter((f) => typeof f.id === "number");
    expect(JSON.parse(JSON.stringify(directEvents))).toEqual(JSON.parse(JSON.stringify(sseEvents)));

    // 心跳同形（type + data 空；at 各自生成不比较）
    const sseHeartbeat = sseSent.find((f) => f.type === "op:heartbeat");
    expect(sseHeartbeat).toBeDefined();
    const directHeartbeat = { type: "op:heartbeat", data: {} };
    expect({ type: sseHeartbeat?.type, data: sseHeartbeat?.data }).toEqual(directHeartbeat);

    sseBridge.dispose();
    directBridge.dispose();
  });
});
