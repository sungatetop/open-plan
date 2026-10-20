/**
 * 记忆文件变更事件桥（F3 批4 迁移期过渡形态）：把 legacy server 的全局 SSE
 * （/api/memory/stream）翻译成 op:event IPC 推送，取代渲染层 EventSource。
 *
 * 与对话流事件桥（events-bridge.ts）的分工：
 *   - 记忆流是全局单流（无 client/thread 键），帧为纯 data JSON
 *     （{ file, event, preview, time }），无 id/游标/心跳语义；
 *   - 因此这里不做续传去重，只做断线退避重连 + watch 幂等；
 *   - 帧统一包装为 op:memory-change 事件（非 event-registry 生命周期事件，
 *     仅桌面桥内部传输标记，与 op:sse-unknown 同类）。
 *
 * B6 收口后：由主进程域服务的 memory watcher 直接 emit 到 op:event，本模块退役。
 */
import type { DesktopEvent } from "../../shared/protocol/channels";
import type { EventWatchResult } from "../../shared/desktop-protocol";
import { createSseParser } from "./sse-parser";

/** 记忆变更帧的 op:event 类型标记（桌面桥内部约定）。 */
export const MEMORY_CHANGE_EVENT_TYPE = "op:memory-change";

export interface MemoryEventsBridge {
  watch(): Promise<EventWatchResult>;
  stop(): void;
  dispose(): void;
}

export interface MemoryBridgeDeps {
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

const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 15_000];

const defaultDelay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createMemoryEventsBridge(deps: MemoryBridgeDeps): MemoryEventsBridge {
  const fetchImpl = deps.fetchImpl ?? (fetch as unknown as NonNullable<MemoryBridgeDeps["fetchImpl"]>);
  const delay = deps.delay ?? defaultDelay;

  let watching = false;
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

  async function runStream(gen: number): Promise<void> {
    let attempt = 0;
    while (gen === generation) {
      const port = deps.getPort();
      if (port === null) {
        deps.onState?.("retrying", "本地服务未就绪");
        await delay(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] ?? 15_000);
        attempt += 1;
        continue;
      }

      const currentController = new AbortController();
      controller = currentController;
      deps.onState?.(attempt > 0 ? "retrying" : "connecting");

      try {
        const response = await fetchImpl(`http://127.0.0.1:${port}/api/memory/stream`, {
          headers: { accept: "text/event-stream" },
          signal: currentController.signal
        });
        if (gen !== generation) return;

        if (!response.ok || !response.body) {
          const detail = await response.text().catch(() => "");
          deps.onState?.("retrying", `SSE 建连失败 status=${response.status} ${detail.slice(0, 200)}`);
          await delay(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] ?? 15_000);
          attempt += 1;
          continue;
        }

        attempt = 0;
        deps.onState?.("watching");
        const parser = createSseParser((message) => {
          let payload: unknown;
          try {
            payload = JSON.parse(message.data);
          } catch {
            return;
          }
          if (!payload || typeof payload !== "object") return;
          deps.send({
            type: MEMORY_CHANGE_EVENT_TYPE,
            data: payload as Record<string, unknown>
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
        await delay(RETRY_DELAYS_MS[0] ?? 1_000);
      } catch (error) {
        if (gen !== generation) return;
        if (currentController.signal.aborted) return; // stop()/dispose：不再重连
        deps.onState?.("retrying", `SSE 连接异常：${error instanceof Error ? error.message : String(error)}`);
        await delay(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] ?? 15_000);
        attempt += 1;
      }
    }
  }

  return {
    async watch(): Promise<EventWatchResult> {
      if (watching) return { ok: true }; // 全局单流：重复 watch 幂等
      watching = true;
      generation += 1;
      void runStream(generation);
      return { ok: true };
    },

    stop(): void {
      if (!watching) return;
      watching = false;
      generation += 1;
      abortActive();
      deps.onState?.("stopped");
    },

    dispose(): void {
      watching = false;
      generation += 1;
      abortActive();
      deps.onState?.("stopped");
    }
  };
}
