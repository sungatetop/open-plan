/**
 * 对话流事件桥单测（F2c）：watch/unwatch 生命周期、幂等、优雅收流、
 * 退避重连、after/stream 续传去重、心跳过滤。
 * fetch 与 delay 均以 stub 注入，不发真实请求、不真等待。
 */
import { describe, expect, it } from "vitest";
import { createEventStreamBridge, type EventStreamFetch, type EventStreamResponse } from "../src/main/ipc/events-bridge";
import type { DesktopEvent } from "../src/shared/protocol/channels";

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

/** 可控 SSE 响应：chunks 依次吐出后 done（模拟服务端收流/断开） */
function sseResponse(chunks: string[], status = 200): EventStreamResponse {
  let i = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    body: {
      getReader() {
        return {
          read: async () => {
            if (i < chunks.length) return { done: false, value: enc(chunks[i++] as string) };
            return { done: true, value: undefined };
          }
        };
      }
    },
    text: async () => (status >= 200 && status < 300 ? "" : "boom")
  };
}

/** 挂起不结束的 SSE 响应（模拟长连接） */
function hangingResponse(): EventStreamResponse {
  return {
    ok: true,
    status: 200,
    body: { getReader: () => ({ read: () => new Promise<{ done: boolean; value?: Uint8Array }>(() => {}) }) },
    text: async () => ""
  };
}

/** 手动放行的 delay：测试显式 release 才继续，杜绝真实等待与失控重试循环 */
function manualDelay() {
  const pending: (() => void)[] = [];
  return {
    delay: () => new Promise<void>((resolve) => pending.push(resolve)),
    release: () => pending.shift()?.(),
    pendingCount: () => pending.length
  };
}

/** 永不 resolve 的 delay：不需要验证重试节奏的用例用它屏蔽真实 setTimeout */
const neverDelay = (): Promise<void> => new Promise<void>(() => {});

interface Call { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal } }

/** 按 URL 分发的 fetch stub：recorder 记录全部调用 */
function makeFetch(handler: (url: URL, call: Call) => EventStreamResponse) {
  const calls: Call[] = [];
  const fetch: EventStreamFetch = async (url, init) => {
    calls.push({ url, init });
    return handler(new URL(url), calls[calls.length - 1] as Call);
  };
  return { fetch, calls };
}

function frame(id: number, type: string, streamId: string, data: Record<string, unknown> = {}): string {
  return `id: ${id}\ndata: ${JSON.stringify({ id, type, streamId, ...data })}\n\n`;
}

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe("createEventStreamBridge", () => {
  it("缺 client：拒绝且不发起请求", async () => {
    const { fetch, calls } = makeFetch(() => hangingResponse());
    const bridge = createEventStreamBridge({ getPort: () => 3003, send: () => {}, fetchImpl: fetch, delay: neverDelay });
    const result = await bridge.watch({ client: "" });
    expect(result).toEqual({ ok: false, error: "client required" });
    expect(calls).toHaveLength(0);
  });

  it("建连 URL 组装：client/thread/cwd 编码，无 after/stream 时不带续传参数", async () => {
    const { fetch, calls } = makeFetch(() => hangingResponse());
    const bridge = createEventStreamBridge({ getPort: () => 3003, send: () => {}, fetchImpl: fetch, delay: neverDelay });
    const result = await bridge.watch({ client: "web 1", thread: "t/2", cwd: "d:\\x y" });
    expect(result).toEqual({ ok: true });
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:3003/api/agent/stream?client=web%201&thread=t%2F2&cwd=d%3A%5Cx%20y");
    expect(calls[0]?.init?.headers?.accept).toBe("text/event-stream");
  });

  it("转发数据帧、心跳转 op:heartbeat 活性帧、应用层握手帧（无 id）原样透传", async () => {
    const chunks = [
      // 对齐 legacy server/index.mjs 实际线上形态：type 在 JSON 体内，无 SSE event 字段
      `data: ${JSON.stringify({ type: "runtime_connecting", at: "2026-10-20T00:00:00.000Z", data: { client: "web", thread: "t1" } })}\n\n`,
      `data: ${JSON.stringify({ type: "runtime_connected", at: "2026-10-20T00:00:00.100Z" })}\n\n`,
      `event: heartbeat\ndata: ${JSON.stringify({ type: "heartbeat", at: "2026-10-20T00:00:01.000Z" })}\n\n`,
      frame(7, "message.delta", "s1", { data: { text: "hi" } })
    ];
    const sent: DesktopEvent[] = [];
    const { fetch } = makeFetch(() => sseResponse(chunks));
    const bridge = createEventStreamBridge({ getPort: () => 3003, send: (e) => sent.push(e), fetchImpl: fetch, delay: neverDelay });
    await bridge.watch({ client: "web", thread: "t1" });
    await settle();
    expect(sent.map((e) => e.type)).toEqual(["runtime_connecting", "runtime_connected", "op:heartbeat", "message.delta"]);
    expect(sent[2]?.at).toBe("2026-10-20T00:00:01.000Z");
    expect(sent[3]?.id).toBe(7);
    expect(sent[3]?.streamId).toBe("s1");
    expect(sent[3]?.data).toEqual({ text: "hi" });
    expect(sent[0]?.id).toBeUndefined();
    expect(sent[0]?.at).toBe("2026-10-20T00:00:00.000Z");
  });

  it("watch 请求携带 after/streamId：建流起点带续传参数（渲染层换线程/强制重连回放）", async () => {
    const { fetch, calls } = makeFetch(() => hangingResponse());
    const bridge = createEventStreamBridge({ getPort: () => 3003, send: () => {}, fetchImpl: fetch, delay: neverDelay });
    await bridge.watch({ client: "web", thread: "t1", after: 42, streamId: "gen-X" });
    await settle();
    const params = new URL(calls[0]?.url ?? "").searchParams;
    expect(params.get("after")).toBe("42");
    expect(params.get("stream")).toBe("gen-X");
    expect(calls[0]?.init?.headers?.["last-event-id"]).toBe("42");
  });

  it("同键重复 watch 幂等：不重建流", async () => {
    const { fetch, calls } = makeFetch(() => hangingResponse());
    const bridge = createEventStreamBridge({ getPort: () => 3003, send: () => {}, fetchImpl: fetch, delay: neverDelay });
    await bridge.watch({ client: "web", thread: "t1" });
    await settle();
    const result = await bridge.watch({ client: "web", thread: "t1" });
    await settle();
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
  });

  it("切换线程：旧流 abort + 优雅收流 POST /api/agent/stream/close，再建新流", async () => {
    const { fetch, calls } = makeFetch((url) =>
      url.pathname === "/api/agent/stream/close"
        ? ({ ok: true, status: 200, body: null, text: async () => "" } as EventStreamResponse)
        : hangingResponse()
    );
    const bridge = createEventStreamBridge({ getPort: () => 3003, send: () => {}, fetchImpl: fetch, delay: neverDelay });
    await bridge.watch({ client: "web", thread: "t1" });
    await settle();
    const oldSignal = calls[0]?.init?.signal;
    await bridge.watch({ client: "web", thread: "t2" });
    await settle();
    expect(oldSignal?.aborted).toBe(true);
    const close = calls.find((c) => c.url.includes("/api/agent/stream/close"));
    expect(close?.init?.method).toBe("POST");
    expect(close?.init?.body).toBe(JSON.stringify({ client: "web", thread: "t1" }));
    expect(calls.filter((c) => c.url.includes("/api/agent/stream?")).map((c) => new URL(c.url).searchParams.get("thread"))).toEqual(["t1", "t2"]);
  });

  it("stop：abort 后不重连", async () => {
    const { fetch, calls } = makeFetch(() => hangingResponse());
    const bridge = createEventStreamBridge({ getPort: () => 3003, send: () => {}, fetchImpl: fetch, delay: neverDelay });
    await bridge.watch({ client: "web", thread: "t1" });
    await settle();
    bridge.stop({});
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.signal?.aborted).toBe(true);
  });

  it("stop 带非当前键：忽略", async () => {
    const { fetch, calls } = makeFetch(() => hangingResponse());
    const bridge = createEventStreamBridge({ getPort: () => 3003, send: () => {}, fetchImpl: fetch, delay: neverDelay });
    await bridge.watch({ client: "web", thread: "t1" });
    await settle();
    bridge.stop({ client: "other", thread: "t1" });
    await settle();
    expect(calls[0]?.init?.signal?.aborted).toBe(false);
  });

  it("服务端断开：进入退避，重连携带 after + stream 续传参数与 last-event-id 头", async () => {
    const { delay, release, pendingCount } = manualDelay();
    let callCount = 0;
    const { fetch, calls } = makeFetch(() => {
      callCount += 1;
      if (callCount === 1) return sseResponse([frame(10, "message.delta", "gen-A")]);
      return hangingResponse();
    });
    const bridge = createEventStreamBridge({ getPort: () => 3003, send: () => {}, fetchImpl: fetch, delay });
    await bridge.watch({ client: "web", thread: "t1" });
    await settle();
    expect(pendingCount()).toBe(1); // 第一流被服务端关闭 → 退避挂起
    release();
    await settle();
    const second = calls[1];
    expect(second).toBeDefined();
    const params = new URL(second?.url ?? "").searchParams;
    expect(params.get("after")).toBe("10");
    expect(params.get("stream")).toBe("gen-A");
    expect(second?.init?.headers?.["last-event-id"]).toBe("10");
  });

  it("非 2xx：退避重试，不带 last-event-id（lastId 未推进）", async () => {
    const { delay, release, pendingCount } = manualDelay();
    let callCount = 0;
    const { fetch, calls } = makeFetch(() => {
      callCount += 1;
      if (callCount === 1) return sseResponse([], 503);
      return hangingResponse();
    });
    const bridge = createEventStreamBridge({ getPort: () => 3003, send: () => {}, fetchImpl: fetch, delay });
    await bridge.watch({ client: "web", thread: "t1" });
    await settle();
    expect(pendingCount()).toBe(1);
    release();
    await settle();
    expect(calls[1]?.init?.headers?.["last-event-id"]).toBeUndefined();
    expect(new URL(calls[1]?.url ?? "").searchParams.get("after")).toBeNull();
  });

  it("服务未就绪：挂起重试，端口就绪后自动建连", async () => {
    const { delay, release, pendingCount } = manualDelay();
    let port: number | null = null;
    const { fetch, calls } = makeFetch(() => hangingResponse());
    const bridge = createEventStreamBridge({ getPort: () => port, send: () => {}, fetchImpl: fetch, delay });
    await bridge.watch({ client: "web", thread: "t1" });
    await settle();
    expect(calls).toHaveLength(0);
    expect(pendingCount()).toBe(1);
    port = 3004;
    release();
    await settle();
    expect(calls[0]?.url).toContain("127.0.0.1:3004");
  });

  it("dispose：终止一切且不再重连", async () => {
    const { delay, release, pendingCount } = manualDelay();
    let callCount = 0;
    const { fetch, calls } = makeFetch(() => {
      callCount += 1;
      if (callCount === 1) return sseResponse([]);
      return hangingResponse();
    });
    const bridge = createEventStreamBridge({ getPort: () => 3003, send: () => {}, fetchImpl: fetch, delay });
    await bridge.watch({ client: "web", thread: "t1" });
    await settle();
    bridge.dispose();
    expect(pendingCount()).toBe(1);
    release();
    await settle();
    expect(calls).toHaveLength(1);
  });

  it("游标不回退：重复 id 帧不推进 lastId（续传去重语义）", async () => {
    const { delay, release, pendingCount } = manualDelay();
    let callCount = 0;
    const { fetch, calls } = makeFetch(() => {
      callCount += 1;
      if (callCount === 1) return sseResponse([frame(5, "message.delta", "s1"), frame(5, "message.delta", "s1"), frame(9, "message.delta", "s1")]);
      return hangingResponse();
    });
    const bridge = createEventStreamBridge({ getPort: () => 3003, send: () => {}, fetchImpl: fetch, delay });
    await bridge.watch({ client: "web", thread: "t1" });
    await settle();
    release();
    await settle();
    expect(new URL(calls[1]?.url ?? "").searchParams.get("after")).toBe("9");
  });

  it("异常响应体（body 缺失）：走退避而非崩溃", async () => {
    const { delay, pendingCount } = manualDelay();
    const { fetch } = makeFetch(() => ({ ok: true, status: 200, body: null, text: async () => "" }));
    const bridge = createEventStreamBridge({ getPort: () => 3003, send: () => {}, fetchImpl: fetch, delay });
    await bridge.watch({ client: "web", thread: "t1" });
    await settle();
    expect(pendingCount()).toBe(1);
  });
});
