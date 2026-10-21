/**
 * 对话流事件桥（F2c 迁移期过渡形态）：把 legacy server 的 per-thread SSE
 * （/api/agent/stream）翻译成 op:event IPC 推送，取代渲染层 EventSource。
 *
 * 语义对齐旧客户端（client/src ChatPanel 的 EventSource 用法）：
 *   - 同键重复 watch 幂等；切换线程先走 /api/agent/stream/close 优雅收流再建新流；
 *   - 断线按退避重连，携带 after（last-event-id）+ stream（通道代际）续传去重；
 *   - 心跳帧（event: heartbeat）不进事件流，转发为 op:heartbeat 活性帧供渲染层
 *     连接层的静默 watchdog 判活（与旧客户端把心跳当存活信号同语义）；
 *   - 连接建立的应用层握手（runtime_connecting/connected 帧）原样转发，
 *     渲染层与旧客户端一样以 `connected` 帧确认 Agent 就绪。
 *
 * B6 收口后：事件由主进程域服务直接 emit 到 op:event，本模块退役。
 */
import type { DesktopEvent } from "../../shared/protocol/channels";
import type { ThreadEventWatchRequest } from "../../shared/desktop-protocol";
import { createSseParser, type SseParser } from "./sse-parser";

export interface EventWatchResult {
  ok: boolean;
  error?: string;
}

export interface EventStreamResponse {
  ok: boolean;
  status: number;
  body: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } } | null;
  text(): Promise<string>;
}

export type EventStreamFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }
) => Promise<EventStreamResponse>;

export type EventBridgeState = "watching" | "connecting" | "retrying" | "stopped";

export interface EventStreamBridge {
  watch(request: ThreadEventWatchRequest): Promise<EventWatchResult>;
  stop(request: { client?: string; thread?: string }): void;
  dispose(): void;
}

export interface EventBridgeDeps {
  /** 当前 legacy server 端口（未就绪返回 null，桥持续退避重试） */
  getPort: () => number | null;
  /** 事件出口（main 侧广播到各窗口 op:event） */
  send: (event: DesktopEvent) => void;
  /** 状态回调（诊断用，可选） */
  onState?: (state: EventBridgeState, detail?: string) => void;
  fetchImpl?: EventStreamFetch;
  /** 重连等待（默认 setTimeout；测试注入立即 resolve） */
  delay?: (ms: number) => Promise<void>;
}

const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 15_000];

const defaultDelay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const defaultFetch: EventStreamFetch = (url, init) =>
  fetch(url, init) as unknown as Promise<EventStreamResponse>;

export function createEventStreamBridge(deps: EventBridgeDeps): EventStreamBridge {
  const fetchImpl = deps.fetchImpl ?? defaultFetch;
  const delay = deps.delay ?? defaultDelay;

  let activeKey: string | null = null;
  let activeClient = "";
  let activeThread = "";
  let generation = 0;
  let controller: AbortController | null = null;

  const keyOf = (request: ThreadEventWatchRequest): string => `${request.client}\u0000${request.thread ?? ""}`;

  const setState = (state: EventBridgeState, detail?: string): void => {
    deps.onState?.(state, detail);
  };

  /** 优雅收流：服务端把该键最旧的 SSE 响应正常 end，避免半开连接（对齐旧客户端切会话语义）。 */
  const gracefulClose = async (port: number, client: string, thread: string): Promise<void> => {
    try {
      await fetchImpl(`http://127.0.0.1:${port}/api/agent/stream/close`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client, thread })
      });
    } catch {
      // 收流失败不阻塞切换：本地 abort 后由服务端流探测/清扫兜底
    }
  };

  const abortActive = (): void => {
    const current = controller;
    controller = null;
    try {
      current?.abort();
    } catch {
      // 已 abort 的控制器重复 abort 不抛错；防御异常实现
    }
  };

  async function runStream(
    gen: number,
    request: ThreadEventWatchRequest,
    resume: { after: number; streamId: string }
  ): Promise<void> {
    let lastId = resume.after;
    let lastStreamId = resume.streamId;
    let attempt = 0;
    let sawFrame = false;

    while (gen === generation) {
      const port = deps.getPort();
      if (port === null) {
        setState("retrying", "本地服务未就绪");
        await delay(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] ?? 15_000);
        attempt += 1;
        continue;
      }

      const url =
        `http://127.0.0.1:${port}/api/agent/stream` +
        `?client=${encodeURIComponent(request.client)}` +
        `&thread=${encodeURIComponent(request.thread ?? "")}` +
        (request.cwd ? `&cwd=${encodeURIComponent(request.cwd)}` : "") +
        (lastId > 0 ? `&after=${lastId}` : "") +
        (lastStreamId ? `&stream=${encodeURIComponent(lastStreamId)}` : "");
      const currentController = new AbortController();
      controller = currentController;
      setState(sawFrame ? "retrying" : "connecting");

      try {
        const response = await fetchImpl(url, {
          headers: {
            accept: "text/event-stream",
            ...(lastId > 0 ? { "last-event-id": String(lastId) } : {})
          },
          signal: currentController.signal
        });
        if (gen !== generation) return;

        if (!response.ok || !response.body) {
          const detail = await response.text().catch(() => "");
          setState("retrying", `SSE 建连失败 status=${response.status} ${detail.slice(0, 200)}`);
          await delay(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] ?? 15_000);
          attempt += 1;
          continue;
        }

        attempt = 0;
        let parser: SseParser | null = null;
        const forward = (event: DesktopEvent): void => {
          if (gen !== generation) return;
          deps.send(event);
        };
        parser = createSseParser((message) => {
          if (message.event === "heartbeat") {
            // 传输层心跳不进事件流，但转发为 op:heartbeat 活性帧：渲染层连接层
            // 的静默 watchdog（旧 ChatPanel 同款）以心跳为存活信号——Runtime 冷
            // 启动期间只有心跳帧，不转发会导致渲染层误判断线反复重建连接。
            const heartbeatEnvelope = parseJson(message.data) as Record<string, unknown> | null;
            forward({
              type: "op:heartbeat",
              at: heartbeatEnvelope && typeof heartbeatEnvelope.at === "string" ? heartbeatEnvelope.at : undefined,
              data: {}
            });
            return;
          }
          const payload = parseJson(message.data);
          if (!payload || typeof payload !== "object") return;
          const envelope = payload as Record<string, unknown>;
          // 通道事件帧带 id（SSE id: 与载荷 id 一致）；应用层帧（runtime_connecting/connected）无 id
          const frameId = message.id !== null ? Number(message.id) : Number(envelope.id ?? 0);
          if (Number.isFinite(frameId) && frameId > lastId) lastId = frameId;
          const streamId = typeof envelope.streamId === "string" ? envelope.streamId : "";
          if (streamId) lastStreamId = streamId;
          sawFrame = true;
          forward({
            ...(Number.isFinite(frameId) && frameId > 0 ? { id: frameId } : {}),
            type: typeof envelope.type === "string" ? envelope.type : "op:sse-unknown",
            at: typeof envelope.at === "string" ? envelope.at : undefined,
            streamId: streamId || undefined,
            protocolVersion: typeof envelope.protocolVersion === "number" ? envelope.protocolVersion : undefined,
            data: (envelope.data ?? {}) as Record<string, unknown>
          });
        });

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (gen !== generation) return;
          if (done) break;
          parser.push(decoder.decode(value, { stream: true }));
        }
        parser.push(decoder.decode());
        parser.end();
        // 服务端正常 end（收流/收尾）→ 视为流关闭，进入重连循环
        if (gen !== generation) return;
        setState("retrying", "SSE 连接被服务端关闭");
        await delay(RETRY_DELAYS_MS[0] ?? 1_000);
      } catch (error) {
        if (gen !== generation) return;
        if (currentController.signal.aborted) return; // stop()/切换：不再重连
        setState("retrying", `SSE 连接异常：${error instanceof Error ? error.message : String(error)}`);
        await delay(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] ?? 15_000);
        attempt += 1;
      }
    }
  }

  return {
    async watch(request: ThreadEventWatchRequest): Promise<EventWatchResult> {
      const client = String(request.client ?? "");
      const thread = String(request.thread ?? "");
      if (!client) return { ok: false, error: "client required" };

      const key = keyOf({ client, thread });
      if (activeKey === key) return { ok: true }; // 同键幂等：EventSource 重复创建保护

      const previousPort = deps.getPort();
      const previousKey = activeKey;
      abortActive();
      activeKey = key;
      activeClient = client;
      activeThread = thread;
      generation += 1;
      const gen = generation;

      if (previousKey !== null && previousPort !== null) {
        // 旧键解析：previousKey 形如 `${client}\u0000${thread}`
        const separator = previousKey.indexOf("\u0000");
        const previousThread = separator >= 0 ? previousKey.slice(separator + 1) : "";
        await gracefulClose(previousPort, previousKey.slice(0, separator), previousThread);
      }

      setState("watching");
      // 建流起点携带渲染层游标/代际（watch 请求的 after/streamId）：换线程或
      // 强制重连时服务端据此回放补齐；桥内部断线重连仍自持 lastId 续传。
      void runStream(
        gen,
        { client, thread, cwd: request.cwd },
        { after: Number(request.after ?? 0), streamId: typeof request.streamId === "string" ? request.streamId : "" }
      );
      return { ok: true };
    },

    stop(request: { client?: string; thread?: string }): void {
      const client = String(request?.client ?? activeClient);
      const thread = String(request?.thread ?? activeThread);
      if (!activeKey) return;
      if (client && `${client}\u0000${thread}` !== activeKey) return; // 非当前键：忽略
      abortActive();
      activeKey = null;
      activeClient = "";
      activeThread = "";
      generation += 1;
      setState("stopped");
    },

    dispose(): void {
      abortActive();
      activeKey = null;
      generation += 1;
      setState("stopped");
    }
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
