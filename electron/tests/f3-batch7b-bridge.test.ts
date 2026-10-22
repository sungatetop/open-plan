/**
 * 全局 Agent 事件桥单测（F3 批7b-4）：帧转发 / {event} 信封拆包 / id 游标续传 /
 * open+heartbeat 忽略 / 重连退避 800→×2→5000 封顶+成功复位 / 同 client 幂等 /
 * 换 client 重开 / stop 匹配 / port 未就绪退避 / dispose。
 * fetch 与 delay 均以 stub 注入，不发真实请求、不真等待（沿 F2c events-bridge 测试基建）。
 */
import { describe, expect, it } from "vitest";
import { createGlobalEventsBridge } from "../src/main/ipc/global-events-bridge";
import type { DesktopEvent } from "../src/shared/protocol/channels";

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

/** 可控 SSE 响应：chunks 依次吐出后 done（模拟服务端收流/断开） */
function sseResponse(chunks: string[], status = 200) {
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
function hangingResponse() {
  return {
    ok: true,
    status: 200,
    body: { getReader: () => ({ read: () => new Promise<{ done: boolean; value?: Uint8Array }>(() => {}) }) },
    text: async () => ""
  };
}

/** 记录毫秒并手动放行的 delay：断言重连退避序列，杜绝真实等待 */
function recordedDelay() {
  const history: number[] = [];
  const pending: Array<() => void> = [];
  return {
    delay: (ms: number) => {
      history.push(ms);
      return new Promise<void>((resolve) => pending.push(resolve));
    },
    release: () => pending.shift()?.(),
    recorded: () => history,
    pendingCount: () => pending.length
  };
}

/** 不需要验证重试节奏的用例用它屏蔽真实 setTimeout */
const neverDelay = (): Promise<void> => new Promise<void>(() => {});

interface Call { url: string; init?: { headers?: Record<string, string>; signal?: AbortSignal } }

/** 按 URL 分发的 fetch stub：recorder 记录全部调用 */
function makeFetch(handler: (url: URL, call: Call) => ReturnType<typeof sseResponse> | ReturnType<typeof hangingResponse>) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init?: Call["init"]) => {
    calls.push({ url, init });
    return handler(new URL(url), calls[calls.length - 1] as Call);
  };
  return { fetchImpl, calls };
}

/** legacy /api/agent/events 帧形态：`id: <seq>` + `data: {"event":{...}}` 信封 */
function frame(id: number, event: Record<string, unknown>): string {
  return `id: ${id}\ndata: ${JSON.stringify({ event })}\n\n`;
}

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe("createGlobalEventsBridge", () => {
  it("缺 client：拒绝且不发起请求", async () => {
    const { fetchImpl, calls } = makeFetch(() => hangingResponse());
    const bridge = createGlobalEventsBridge({ getPort: () => 3003, send: () => {}, fetchImpl, delay: neverDelay });
    const result = await bridge.watch({ client: "" });
    expect(result).toEqual({ ok: false, error: "client required" });
    expect(calls).toHaveLength(0);
  });

  it("建连 URL 组装：client 编码；after=0 不带续传参数", async () => {
    const { fetchImpl, calls } = makeFetch(() => hangingResponse());
    const bridge = createGlobalEventsBridge({ getPort: () => 3003, send: () => {}, fetchImpl, delay: neverDelay });
    const result = await bridge.watch({ client: "web 1", after: 0 });
    expect(result).toEqual({ ok: true });
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:3003/api/agent/events?client=web%201");
    expect(calls[0]?.init?.headers?.accept).toBe("text/event-stream");
  });

  it("watch 携带 after：建流起点带续传参数（渲染层游标引导）", async () => {
    const { fetchImpl, calls } = makeFetch(() => hangingResponse());
    const bridge = createGlobalEventsBridge({ getPort: () => 3003, send: () => {}, fetchImpl, delay: neverDelay });
    await bridge.watch({ client: "web", after: 42 });
    await settle();
    expect(new URL(calls[0]?.url ?? "").searchParams.get("after")).toBe("42");
  });

  it("帧转发：{event} 信封拆包为 op:agent-event，data=event 本体，id=帧号", async () => {
    const chunks = [
      frame(1, { seq: 1, type: "run_finished", threadId: "t1", runId: "r1" }),
      frame(2, { seq: 2, type: "agent_error", threadId: "t2" })
    ];
    const sent: DesktopEvent[] = [];
    const { fetchImpl } = makeFetch(() => sseResponse(chunks));
    const bridge = createGlobalEventsBridge({ getPort: () => 3003, send: (e) => sent.push(e), fetchImpl, delay: neverDelay });
    await bridge.watch({ client: "web" });
    await settle();
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual({ id: 1, type: "op:agent-event", data: { seq: 1, type: "run_finished", threadId: "t1", runId: "r1" } });
    expect(sent[1]?.type).toBe("op:agent-event");
    expect(sent[1]?.data).toEqual({ seq: 2, type: "agent_error", threadId: "t2" });
  });

  it("open / heartbeat 应用层帧（event 字段非空）不进事件流", async () => {
    const chunks = [
      `event: open\ndata: ${JSON.stringify({ type: "open" })}\n\n`,
      `event: heartbeat\ndata: ${JSON.stringify({ type: "heartbeat", at: "2026-10-22T00:00:00.000Z" })}\n\n`,
      frame(3, { seq: 3, type: "run_finished", threadId: "t1" })
    ];
    const sent: DesktopEvent[] = [];
    const { fetchImpl } = makeFetch(() => sseResponse(chunks));
    const bridge = createGlobalEventsBridge({ getPort: () => 3003, send: (e) => sent.push(e), fetchImpl, delay: neverDelay });
    await bridge.watch({ client: "web" });
    await settle();
    expect(sent).toHaveLength(1);
    expect((sent[0]?.data as { seq?: number }).seq).toBe(3);
  });

  it("坏 JSON / 无 event 信封帧：忽略且不推进游标", async () => {
    const chunks = [
      "id: 5\ndata: not-json\n\n",
      `id: 6\ndata: ${JSON.stringify({ no: "envelope" })}\n\n`,
      frame(7, { seq: 7, type: "run_finished", threadId: "t1" })
    ];
    const { delay, release } = recordedDelay();
    const sent: DesktopEvent[] = [];
    let callCount = 0;
    const { fetchImpl, calls } = makeFetch(() => {
      callCount += 1;
      return callCount === 1 ? sseResponse(chunks) : hangingResponse();
    });
    const bridge = createGlobalEventsBridge({ getPort: () => 3003, send: (e) => sent.push(e), fetchImpl, delay });
    await bridge.watch({ client: "web" });
    await settle();
    expect(sent).toHaveLength(1);
    release();
    await settle();
    // 坏帧未推进 lastId：重连不带 after=5/6，只带最后有效帧号 7
    expect(new URL(calls[1]?.url ?? "").searchParams.get("after")).toBe("7");
  });

  it("无 id 帧：转发事件但不携带 id 字段、游标不推进", async () => {
    const sent: DesktopEvent[] = [];
    const { delay, release } = recordedDelay();
    let callCount = 0;
    const { fetchImpl, calls } = makeFetch(() => {
      callCount += 1;
      return callCount === 1 ? sseResponse([`data: ${JSON.stringify({ event: { seq: 1, type: "run_finished" } })}\n\n`]) : hangingResponse();
    });
    const bridge = createGlobalEventsBridge({ getPort: () => 3003, send: (e) => sent.push(e), fetchImpl, delay });
    await bridge.watch({ client: "web" });
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.id).toBeUndefined();
    release();
    await settle();
    expect(new URL(calls[1]?.url ?? "").searchParams.get("after")).toBeNull();
  });

  it("游标续传：重复 id 不推进，重连 after=最后有效帧号", async () => {
    const { delay, release } = recordedDelay();
    let callCount = 0;
    const { fetchImpl, calls } = makeFetch(() => {
      callCount += 1;
      if (callCount === 1) return sseResponse([frame(5, { seq: 5, type: "x" }), frame(5, { seq: 5, type: "x" }), frame(9, { seq: 9, type: "x" })]);
      return hangingResponse();
    });
    const bridge = createGlobalEventsBridge({ getPort: () => 3003, send: () => {}, fetchImpl, delay });
    await bridge.watch({ client: "web" });
    await settle();
    release();
    await settle();
    expect(new URL(calls[1]?.url ?? "").searchParams.get("after")).toBe("9");
  });

  it("重连退避：800 → ×2 → 5000 封顶（非 2xx 连败序列）", async () => {
    const { delay, release, recorded } = recordedDelay();
    let callCount = 0;
    const { fetchImpl } = makeFetch(() => {
      callCount += 1;
      return callCount <= 5 ? sseResponse([], 503) : hangingResponse();
    });
    const bridge = createGlobalEventsBridge({ getPort: () => 3003, send: () => {}, fetchImpl, delay });
    await bridge.watch({ client: "web" });
    await settle();
    expect(recorded()).toEqual([800]);
    release(); await settle();
    release(); await settle();
    release(); await settle();
    expect(recorded()).toEqual([800, 1600, 3200, 5000]); // 3200×2 已被 5000 封顶
    release(); await settle();
    expect(recorded()).toEqual([800, 1600, 3200, 5000, 5000]);
    bridge.stop();
  });

  it("建连成功复位退避：失败(800) → 成功后断开 → 再等 800 而非 1600", async () => {
    const { delay, release, recorded } = recordedDelay();
    let callCount = 0;
    const { fetchImpl } = makeFetch(() => {
      callCount += 1;
      if (callCount === 1) return sseResponse([], 503);
      return sseResponse([frame(1, { seq: 1, type: "x" })]); // 建连成功后立即收流（done）
    });
    const bridge = createGlobalEventsBridge({ getPort: () => 3003, send: () => {}, fetchImpl, delay });
    await bridge.watch({ client: "web" });
    await settle();
    expect(recorded()).toEqual([800]);
    release();
    await settle();
    bridge.stop();
    expect(recorded()).toEqual([800, 800]);
  });

  it("同 client 重复 watch 幂等：不重建流", async () => {
    const { fetchImpl, calls } = makeFetch(() => hangingResponse());
    const bridge = createGlobalEventsBridge({ getPort: () => 3003, send: () => {}, fetchImpl, delay: neverDelay });
    await bridge.watch({ client: "web" });
    await settle();
    const result = await bridge.watch({ client: "web" });
    await settle();
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
  });

  it("换 client：旧流 abort，新流建连", async () => {
    const { fetchImpl, calls } = makeFetch(() => hangingResponse());
    const bridge = createGlobalEventsBridge({ getPort: () => 3003, send: () => {}, fetchImpl, delay: neverDelay });
    await bridge.watch({ client: "web" });
    await settle();
    const oldSignal = calls[0]?.init?.signal;
    await bridge.watch({ client: "web-2" });
    await settle();
    expect(oldSignal?.aborted).toBe(true);
    expect(new URL(calls[1]?.url ?? "").searchParams.get("client")).toBe("web-2");
  });

  it("stop：匹配 client 才停（abort 后不重连）；非当前 client 忽略", async () => {
    const { fetchImpl, calls } = makeFetch(() => hangingResponse());
    const bridge = createGlobalEventsBridge({ getPort: () => 3003, send: () => {}, fetchImpl, delay: neverDelay });
    await bridge.watch({ client: "web" });
    await settle();
    bridge.stop({ client: "other" });
    await settle();
    expect(calls[0]?.init?.signal?.aborted).toBe(false);
    bridge.stop({});
    await settle();
    expect(calls[0]?.init?.signal?.aborted).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("服务未就绪：挂起重试，端口就绪后自动建连", async () => {
    const { delay, release, pendingCount } = recordedDelay();
    let port: number | null = null;
    const { fetchImpl, calls } = makeFetch(() => hangingResponse());
    const bridge = createGlobalEventsBridge({ getPort: () => port, send: () => {}, fetchImpl, delay });
    await bridge.watch({ client: "web" });
    await settle();
    expect(calls).toHaveLength(0);
    expect(pendingCount()).toBe(1);
    port = 3004;
    release();
    await settle();
    expect(calls[0]?.url).toContain("127.0.0.1:3004");
  });

  it("dispose：终止一切且不再重连", async () => {
    const { delay, release, pendingCount } = recordedDelay();
    let callCount = 0;
    const { fetchImpl, calls } = makeFetch(() => {
      callCount += 1;
      return callCount === 1 ? sseResponse([]) : hangingResponse();
    });
    const bridge = createGlobalEventsBridge({ getPort: () => 3003, send: () => {}, fetchImpl, delay });
    await bridge.watch({ client: "web" });
    await settle();
    bridge.dispose();
    expect(pendingCount()).toBe(1);
    release();
    await settle();
    expect(calls).toHaveLength(1);
  });

  it("异常响应体（body 缺失）：走退避而非崩溃", async () => {
    const { delay, pendingCount } = recordedDelay();
    const { fetchImpl } = makeFetch(() => ({ ok: true, status: 200, body: null, text: async () => "" }) as never);
    const bridge = createGlobalEventsBridge({ getPort: () => 3003, send: () => {}, fetchImpl, delay });
    await bridge.watch({ client: "web" });
    await settle();
    expect(pendingCount()).toBe(1);
  });
});
