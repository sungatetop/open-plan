/**
 * 全局事件流连接与消费层（F3 批7b）：App.jsx 根级事件订阅 effect
 * （client/src/App.jsx 563-654）的 TS 迁移，传输层抽象为双形态：
 *
 *   - SSE transport：逐行等价旧 EventSource 用法（web / 无桥降级形态）；
 *   - IPC transport：经 op:agent-events:watch / op:agent-event（main 侧
 *     global-events-bridge 消费 legacy /api/agent/events 后转发），
 *     新 UI 的主路径（方案 §3：新 renderer 只走 IPC）。
 *
 * 消费语义与旧实现逐行同构：
 *   - 游标：event.seq 判定推进（seq <= cursor 丢弃），localStorage
 *     "oaw_event_cursor" 持久化；localStorage 无游标时先经
 *     /api/agent/events/state（旧为 fetch，新为 op:agent:events-state IPC，
 *     3000ms 超时）引导起点；
 *   - 100ms 批处理：eventVersion / artifactVersion 合并自增；
 *   - 未读：跨 thread 且命中 GLOBAL_EVENT_NOTICES 的去重计数（noticeKey）；
 *   - 180ms 防抖 refreshSessions（仅页面可见时）；run_finished 重置
 *     browserAutoOpenBlocked（浏览器侧栏自动展开不跨轮传递）。
 *
 * 重连分工：SSE 形态由本层自带 800ms 起指数翻倍、5000ms 封顶、onopen 复位；
 * IPC 形态 main 侧桥自持同节奏重连，本层仅在 watch 受理失败时按同节奏重试。
 */
import { acquireStream } from "../../lib/stream-budget";
import { flag } from "../../lib/feature-flags";
import { subscribeDesktopEvents, stopAgentEvents, watchAgentEvents } from "../../api/ipc-client";
import { agentEventsState } from "../../api/client-api";

// ============================================================================
// 常量（App.jsx 158 行与 effect 内字面量逐行转录）
// ============================================================================

/** 跨线程未读提示关注的事件类型（App.jsx GLOBAL_EVENT_NOTICES）。 */
export const GLOBAL_EVENT_NOTICES = new Set(["run_finished", "run_recovered", "run_cancel_requested", "agent_error", "ask_user"]);

/** 会话刷新防抖关注的事件类型（App.jsx onmessage 内字面量）。 */
const SESSION_REFRESH_EVENT_TYPES = ["run_finished", "run_recovered", "run_cancel_requested", "agent_error"];

/** 当前线程产物计数事件类型（artifact 事件追加 artifact_staged 需 flag("stagedVisible")）。 */
export const ARTIFACT_EVENT_TYPES = ["run_finished", "file_changed", "artifact_published"];

/** 游标持久化键（旧 cursorKey 字面量）。 */
export const EVENT_CURSOR_STORAGE_KEY = "oaw_event_cursor";

// ============================================================================
// 类型
// ============================================================================

/** 全局事件载荷（legacy /api/agent/events 的 event 本体，seq/threadId/type 等索引字段）。 */
export type AgentEventPayload = Record<string, unknown> & { seq?: unknown; type?: unknown; threadId?: unknown; runId?: unknown };

/** 传输层收到的单条消息帧（data = event 本体）。 */
export interface GlobalEventFrame {
  /** 游标序号（SSE last-event-id / 桥转发的 id；seq 以载荷自身 seq 为准，仅诊断用） */
  eventId: number;
  data: AgentEventPayload;
}

/** 一条全局事件流连接（对应旧代码里的单个 EventSource 实例）。 */
export interface GlobalEventConnection {
  /** 传输层通道打开（SSE onopen / IPC watch 受理）。 */
  onOpen(callback: () => void): void;
  /** 应用层消息帧。 */
  onMessage(callback: (frame: GlobalEventFrame) => void): void;
  /** 连接错误（SSE onerror；IPC 形态由 main 侧桥内部重连，不回调）。 */
  onError(callback: () => void): void;
  /** 关闭连接（SSE 直接 close；IPC 停止桥订阅）。 */
  close(): void;
}

/** 全局事件流传输层（连接控制器经由它建连/收帧/关闭）。 */
export interface GlobalEventTransport {
  connect(params: { client: string; after: number }): GlobalEventConnection;
}

/** 控制器持有的 App 级 ref（对应旧 App.jsx 状态区声明，workbench 注入）。 */
export interface GlobalEventFeedRefs {
  currentThreadRef: { current: string | null };
  eventCursorRef: { current: number };
  eventNoticeKeysRef: { current: Set<string> };
  browserAutoOpenBlockedRef: { current: boolean };
  eventBatchTimerRef: { current: number | null };
  eventBatchRef: { current: { updates: number; artifacts: number } };
  eventRefreshTimerRef: { current: number | null };
}

export interface GlobalEventFeedDeps {
  clientId: string;
  refs: GlobalEventFeedRefs;
  setEventVersion(updater: (value: number) => number): void;
  setArtifactVersion(updater: (value: number) => number): void;
  setUnreadByThread(updater: (prev: Record<string, number>) => Record<string, number>): void;
  /** 会话列表刷新（失败容忍：调用方 App 层自行兜底） */
  refreshSessions(): void | Promise<unknown>;
  transport: GlobalEventTransport;
  /** 游标引导（默认 op:agent:events-state IPC；SSE 形态可注入 fetch 版） */
  loadEventState?: (client: string) => Promise<{ latest?: unknown } | null>;
}

// ============================================================================
// SSE transport（web / 无桥降级形态：逐行等价旧 EventSource 用法）
// ============================================================================

export interface SseGlobalEventTransportOptions {
  /** 测试注入；默认 window.EventSource */
  createEventSource?: (url: string) => EventSource;
}

export function createSseGlobalEventTransport(
  options: SseGlobalEventTransportOptions = {}
): GlobalEventTransport {
  const createEventSource =
    options.createEventSource ?? ((url: string) => new EventSource(url));
  return {
    connect(params: { client: string; after: number }): GlobalEventConnection {
      const source = createEventSource(
        `/api/agent/events?client=${encodeURIComponent(params.client)}&after=${encodeURIComponent(params.after)}`
      );
      const connection: GlobalEventConnection = {
        onOpen(callback) {
          source.onopen = () => callback();
        },
        onMessage(callback) {
          source.onmessage = (event) => {
            let payload: unknown;
            try {
              payload = JSON.parse((event as MessageEvent).data || "{}");
            } catch {
              return;
            }
            // 旧 onmessage：payload.event || payload 信封拆包
            const record = (payload && typeof payload === "object" ? payload : {}) as { event?: unknown };
            const data = (record.event && typeof record.event === "object" ? record.event : payload) as AgentEventPayload;
            callback({ eventId: Number((event as MessageEvent).lastEventId || 0), data });
          };
        },
        onError(callback) {
          source.onerror = () => callback();
        },
        close() {
          try {
            source.close();
          } catch {
            /* 已销毁，忽略 */
          }
        }
      };
      return connection;
    }
  };
}

// ============================================================================
// IPC transport（新 UI 主路径：main 侧 global-events-bridge → op:agent-event）
// ============================================================================

export interface IpcGlobalEventTransportOptions {
  /** 测试注入；默认 ipc-client 封装 */
  watch?: typeof watchAgentEvents;
  stop?: typeof stopAgentEvents;
  subscribe?: typeof subscribeDesktopEvents;
}

export function createIpcGlobalEventTransport(
  options: IpcGlobalEventTransportOptions = {}
): GlobalEventTransport {
  const watch = options.watch ?? watchAgentEvents;
  const stop = options.stop ?? stopAgentEvents;
  const subscribe = options.subscribe ?? subscribeDesktopEvents;
  return {
    connect(params: { client: string; after: number }): GlobalEventConnection {
      let openCallback: (() => void) | null = null;
      let messageCallback: ((frame: GlobalEventFrame) => void) | null = null;
      let errorCallback: (() => void) | null = null;
      let closed = false;
      // 先订阅后 watch：保证 watch 受理后的首帧不丢失（与旧 EventSource 同建连顺序）
      const unsubscribe = subscribe((event) => {
        if (closed) return;
        if (event.type !== "op:agent-event") return;
        messageCallback?.({
          eventId: Number(event.id ?? 0),
          data: (event.data ?? {}) as AgentEventPayload
        });
      });
      void watch({ client: params.client, after: params.after }).then((result) => {
        if (closed) return;
        if (result.ok) openCallback?.();
        else errorCallback?.();
      });
      const connection: GlobalEventConnection = {
        onOpen(callback) {
          openCallback = callback;
        },
        onMessage(callback) {
          messageCallback = callback;
        },
        onError(callback) {
          errorCallback = callback;
        },
        close() {
          if (closed) return;
          closed = true;
          unsubscribe();
          void stop({ client: params.client });
        }
      };
      return connection;
    }
  };
}

// ============================================================================
// 连接 + 消费控制器（旧 effect 563-654 逐行转录，transport 注入）
// ============================================================================

const defaultLoadEventState = async (client: string): Promise<{ latest?: unknown } | null> => {
  const data = await agentEventsState(client);
  return data as { latest?: unknown };
};

/** 状态引导 3000ms 超时（对齐旧 AbortSignal.timeout(3000)，失败静默保留现有游标）。 */
const withTimeout = <T,>(promise: Promise<T>, ms: number): Promise<T | null> =>
  Promise.race([
    promise,
    new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), ms);
    })
  ]);

/**
 * 创建全局事件流控制器。返回清理函数（等价旧 effect 的 cleanup），
 * workbench 以 `useEffect(() => createGlobalEventFeed(deps), [clientId, refreshSessions])` 接线。
 */
export function createGlobalEventFeed(deps: GlobalEventFeedDeps): () => void {
  const { refs } = deps;
  const cursorKey = EVENT_CURSOR_STORAGE_KEY;
  // 全局事件流是核心长连接（必需）：槽位不足时优先保证它和对话流。
  const slot = acquireStream("agent-events", { essential: true, priority: 2, label: "全局事件流" });

  let conn: GlobalEventConnection | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let retryDelay = 800;
  let stopped = false;

  const flushEventBatch = (): void => {
    refs.eventBatchTimerRef.current = null;
    const pending = refs.eventBatchRef.current;
    refs.eventBatchRef.current = { updates: 0, artifacts: 0 };
    if (pending.updates) deps.setEventVersion((value) => value + pending.updates);
    if (pending.artifacts) deps.setArtifactVersion((value) => value + pending.artifacts);
  };
  const scheduleEventBatch = (artifact = false): void => {
    refs.eventBatchRef.current.updates += 1;
    if (artifact) refs.eventBatchRef.current.artifacts += 1;
    if (!refs.eventBatchTimerRef.current) {
      refs.eventBatchTimerRef.current = window.setTimeout(flushEventBatch, 100);
    }
  };
  const scheduleReconnect = (): void => {
    if (stopped || reconnectTimer) return;
    conn?.close();
    conn = null;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, retryDelay);
    retryDelay = Math.min(5000, retryDelay * 2);
  };

  const consume = (event: AgentEventPayload): void => {
    const seq = Number(event.seq || 0);
    if (!seq || seq <= refs.eventCursorRef.current) return;
    refs.eventCursorRef.current = seq;
    try {
      localStorage.setItem(cursorKey, String(seq));
    } catch {
      /* localStorage 不可用时静默降级 */
    }
    const isCurrentThread = !event.threadId || event.threadId === refs.currentThreadRef.current;
    scheduleEventBatch(
      isCurrentThread &&
        [...ARTIFACT_EVENT_TYPES, ...(flag("stagedVisible") ? ["artifact_staged"] : [])].includes(String(event.type))
    );
    const thread = String(event.threadId || "");
    const noticeKey = `${thread}:${event.runId || "event"}:${event.type}`;
    if (
      thread &&
      thread !== refs.currentThreadRef.current &&
      GLOBAL_EVENT_NOTICES.has(String(event.type)) &&
      !refs.eventNoticeKeysRef.current.has(noticeKey)
    ) {
      refs.eventNoticeKeysRef.current.add(noticeKey);
      deps.setUnreadByThread((prev) => ({ ...prev, [thread]: (prev[thread] || 0) + 1 }));
    }
    if (SESSION_REFRESH_EVENT_TYPES.includes(String(event.type))) {
      // 新一轮开始前恢复"浏览器侧栏可自动展开"：用户上一轮手动关掉的状态不跨轮传递。
      if (event.type === "run_finished") refs.browserAutoOpenBlockedRef.current = false;
      if (!refs.eventRefreshTimerRef.current) {
        refs.eventRefreshTimerRef.current = window.setTimeout(() => {
          refs.eventRefreshTimerRef.current = null;
          if (document.visibilityState === "visible") void deps.refreshSessions();
        }, 180);
      }
    }
  };

  const connect = async (): Promise<void> => {
    let cursor = refs.eventCursorRef.current;
    let bootstrapped = false;
    try {
      bootstrapped = !localStorage.getItem(cursorKey);
    } catch {
      /* localStorage 不可用：跳过引导，按现有游标建流 */
    }
    if (bootstrapped) {
      const loader = deps.loadEventState ?? defaultLoadEventState;
      const state = await withTimeout(loader(deps.clientId), 3000).catch(() => null);
      if (stopped) return;
      if (state && Number.isFinite(Number(state.latest))) {
        cursor = Number(state.latest);
        refs.eventCursorRef.current = cursor;
        try {
          localStorage.setItem(cursorKey, String(cursor));
        } catch {
          /* 静默降级 */
        }
      }
    }
    if (stopped) return;
    const next = deps.transport.connect({ client: deps.clientId, after: cursor });
    conn = next;
    slot?.attach(() => next.close());
    next.onOpen(() => {
      retryDelay = 800;
    });
    next.onMessage((frame) => {
      try {
        consume(frame.data);
      } catch {
        /* 单帧异常不中断连接（旧 try/catch 同口径） */
      }
    });
    next.onError(() => {
      scheduleReconnect();
    });
  };

  void connect();
  return () => {
    stopped = true;
    conn?.close();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (refs.eventBatchTimerRef.current) {
      clearTimeout(refs.eventBatchTimerRef.current);
      refs.eventBatchTimerRef.current = null;
    }
    refs.eventBatchRef.current = { updates: 0, artifacts: 0 };
    if (refs.eventRefreshTimerRef.current) {
      clearTimeout(refs.eventRefreshTimerRef.current);
      refs.eventRefreshTimerRef.current = null;
    }
    slot?.release();
  };
}
