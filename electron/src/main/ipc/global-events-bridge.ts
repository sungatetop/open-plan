/**
 * 全局 Agent 事件桥（F3 批7b 迁移期过渡形态）：把 legacy server 的根级持久事件流
 * （/api/agent/events）翻译成 op:event IPC 推送，取代旧客户端 App.jsx 的 EventSource。
 *
 * 与对话流事件桥（events-bridge.ts）的分工：
 *   - 全局流按 client 订阅、跨所有 thread（旧客户端语义：当前对话走 per-thread 流，
 *     App 根级额外监听所有 thread 的重要状态以刷新历史与未读提示）；
 *   - 服务端帧为 `id: <seq>` + `data: {"event":{...}}` 信封，另有 event:open /
 *     event:heartbeat 应用层帧——旧客户端 onmessage 只收默认 message 帧
 *     （open/heartbeat 不触发 onmessage），因此桥同样忽略这两类帧；
 *   - 心跳不转发 op:heartbeat：per-thread 流的连接层 watchdog 以它判活，全局流
 *     若也转发会让 watchdog 在线程流断连时误判存活（语义污染）；
 *   - 无优雅收流（旧客户端从不显式关闭全局流，只有 onerror → 重连）；
 *     断线重连节奏对齐旧 App.jsx：800ms 起指数翻倍、5000ms 封顶、建连成功复位。
 *
 * B6 收口后：事件由主进程域服务直接 emit 到 op:event，本模块退役。
 */
import type { DesktopEvent } from "../../shared/protocol/channels";
import type { AgentEventWatchRequest } from "../../shared/desktop-protocol";
import { createSseParser } from "./sse-parser";

/** 全局事件帧的 op:event 类型标记（桌面桥内部约定，与 op:memory-change 同类）。 */
export const AGENT_EVENT_TYPE = "op:agent-event";

export interface GlobalEventWatchResult {
  ok: boolean;
  error?: string;
}

export interface GlobalEventsBridge {
  watch(request: AgentEventWatchRequest): Promise<GlobalEventWatchResult>;
  stop(request?: { client?: string }): void;
  dispose(): void;
}

export interface GlobalEventsBridgeDeps {
  /** 当前 legacy server 端口（未就绪返回 null，桥持续退避重试） */
  getPort: () => number | null;
  /** 事件出口（main 侧广播到各窗口 op:event） */
  send: (event: DesktopEvent) => void;
  /** 状态回调（诊断用，可选） */
  onState?: (state: "watching" | "connecting" | "retrying" | "stopped", detail?: string) => void;
  fetchImpl?: (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
    ok: boolean;
    status: number;
    body: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } } | null;
    text(): Promise<string>;
  }>;
  /** 重连等待（默认 setTimeout；测试注入立即 resolve） */
  delay?: (ms: number) => Promise<void>;
}

/** 对齐旧 App.jsx：初始 800ms，指数翻倍，5000ms 封顶，建连成功后复位。 */
const RECONNECT_INITIAL_MS = 800;
const RECONNECT_MAX_MS = 5000;

const defaultDelay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createGlobalEventsBridge(deps: GlobalEventsBridgeDeps): GlobalEventsBridge {
  const fetchImpl = deps.fetchImpl ?? (fetch as unknown as NonNullable<GlobalEventsBridgeDeps["fetchImpl"]>);
  const delay = deps.delay ?? defaultDelay;

  let activeClient = "";
  let generation = 0;
  let controller: AbortController | null = null;

  const abortActive = (): void => {
    const current = controller;
    controller = null;
    try {
      current?.abort();
    } catch {
      // 已 abort 的控制器重复 abort 不抛错；防御异常实现
    }
  };

  async function runStream(gen: number, client: string, resumeAfter: number): Promise<void> {
    let lastId = resumeAfter;
    let retryDelay = RECONNECT_INITIAL_MS;
    while (gen === generation) {
      const port = deps.getPort();
      if (port === null) {
        deps.onState?.("retrying", "本地服务未就绪");
        await delay(retryDelay);
        retryDelay = Math.min(RECONNECT_MAX_MS, retryDelay * 2);
        continue;
      }

      const url =
        `http://127.0.0.1:${port}/api/agent/events` +
        `?client=${encodeURIComponent(client)}` +
        (lastId > 0 ? `&after=${lastId}` : "");
      const currentController = new AbortController();
      controller = currentController;
      deps.onState?.("connecting");

      try {
        const response = await fetchImpl(url, {
          headers: { accept: "text/event-stream" },
          signal: currentController.signal
        });
        if (gen !== generation) return;

        if (!response.ok || !response.body) {
          const detail = await response.text().catch(() => "");
          deps.onState?.("retrying", `SSE 建连失败 status=${response.status} ${detail.slice(0, 200)}`);
          await delay(retryDelay);
          retryDelay = Math.min(RECONNECT_MAX_MS, retryDelay * 2);
          continue;
        }

        // 建连成功：对齐旧客户端 onopen 复位重连节奏
        retryDelay = RECONNECT_INITIAL_MS;
        deps.onState?.("watching");
        const parser = createSseParser((message) => {
          if (message.event !== null) return; // open/heartbeat 应用层帧不进事件流（旧 onmessage 只收默认帧，同口径）
          let payload: unknown;
          try {
            payload = JSON.parse(message.data || "{}");
          } catch {
            return;
          }
          if (!payload || typeof payload !== "object") return;
          const envelope = payload as { event?: unknown };
          const event = envelope.event && typeof envelope.event === "object" ? envelope.event : null;
          if (!event) return;
          const frameId = message.id !== null ? Number(message.id) : 0;
          if (Number.isFinite(frameId) && frameId > lastId) lastId = frameId;
          deps.send({
            ...(Number.isFinite(frameId) && frameId > 0 ? { id: frameId } : {}),
            type: AGENT_EVENT_TYPE,
            data: event as Record<string, unknown>
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
        // 服务端正常 end → 视为流关闭，进入重连循环
        if (gen !== generation) return;
        deps.onState?.("retrying", "SSE 连接被服务端关闭");
        await delay(retryDelay);
        retryDelay = Math.min(RECONNECT_MAX_MS, retryDelay * 2);
      } catch (error) {
        if (gen !== generation) return;
        if (currentController.signal.aborted) return; // stop()/切换：不再重连
        deps.onState?.("retrying", `SSE 连接异常：${error instanceof Error ? error.message : String(error)}`);
        await delay(retryDelay);
        retryDelay = Math.min(RECONNECT_MAX_MS, retryDelay * 2);
      }
    }
  }

  return {
    async watch(request: AgentEventWatchRequest): Promise<GlobalEventWatchResult> {
      const client = String(request.client ?? "");
      if (!client) return { ok: false, error: "client required" };

      if (activeClient === client) return { ok: true }; // 同 client 幂等：EventSource 重复创建保护

      abortActive();
      activeClient = client;
      generation += 1;
      const gen = generation;
      deps.onState?.("watching");
      // 建流起点携带渲染层游标（watch 请求的 after，0 = 服务端最早可回放处）；
      // 桥内部断线重连自持 lastId 续传。
      void runStream(gen, client, Number(request.after ?? 0));
      return { ok: true };
    },

    stop(request?: { client?: string }): void {
      const client = String(request?.client ?? activeClient);
      if (!activeClient) return;
      if (client && client !== activeClient) return; // 非当前 client：忽略
      abortActive();
      activeClient = "";
      generation += 1;
      deps.onState?.("stopped");
    },

    dispose(): void {
      abortActive();
      activeClient = "";
      generation += 1;
      deps.onState?.("stopped");
    }
  };
}
