/**
 * 对话流连接层（F3 批6c）：ChatPanel SSE effect（client/src/components/
 * ChatPanel.jsx 1515-1696）的 TS 迁移，传输层抽象为双形态：
 *
 *   - SSE transport：逐行等价旧 EventSource 用法（web / 无桥降级形态）；
 *   - IPC transport：经 op:events:watch / op:event（main 侧事件桥消费 legacy
 *     SSE 后转发），新 UI 的主路径（方案 §3：新 renderer 只走 IPC）。
 *
 * 连接状态机（重连退避 / 静默 watchdog / 游标与代际管理 / 握手就绪承诺 /
 * 缺号诊断 / 槽位预算）与旧实现逐行同构，transport 仅替换「建连 + 收帧 +
 * 关闭」三个动作，保证任一形态下行为一致。
 *
 * 事件消费侧（handleEvent 状态机）由批6b 的 createChatEventMachine 承担，
 * 本层只负责把帧递入 deps.refs.eventHandlerRef。
 */
import { acquireStream, closeEventSourceQuietly, noteCursorGap } from "../../lib/stream-budget";
import { flag, numberFlag } from "../../lib/feature-flags";
import { subscribeDesktopEvents, stopThreadEvents, watchThreadEvents } from "../../api/ipc-client";
import type { ChatEventEnvelope, ChatEventInput } from "./event-machine";

// ============================================================================
// 类型
// ============================================================================

/** streamReadyRef 条目：连接握手就绪承诺（发送路径等待其落定或 600ms 超时）。 */
export interface ChatStreamReadyEntry {
  promise: Promise<boolean>;
  resolve?: (value: boolean) => void;
  streamKey: string;
  generation: number;
}

/** 连接层持有的组件级 ref（对应旧组件 766-790 的声明，6d 接线时注入）。 */
export interface ChatEventStreamRefs {
  mountedRef: { current: boolean };
  handshakeDoneRef: { current: boolean };
  eventCursorRef: { current: number };
  eventCursorsRef: { current: Map<string, number> };
  streamIdsRef: { current: Map<string, string> };
  streamReadyRef: { current: ChatStreamReadyEntry | null };
  streamGenerationRef: { current: number };
  eventHandlerRef: { current: ((event: ChatEventInput) => void) | null };
}

/** 建连参数（对齐旧 connect() 的 EventSource URL 查询参数族）。 */
export interface ThreadEventConnectParams {
  client: string;
  /** 线程 id（空串 = 无线程，与旧 threadId || "" 同形） */
  thread: string;
  /** 工作区（空串 = 不携带） */
  cwd: string;
  /** 续传游标（0 = 不携带 after，服务端从头回放） */
  after: number;
  /** 已知通道代际 id（空串 = 不携带 stream） */
  streamId: string;
}

/** 传输层收到的单条消息帧。 */
export interface ThreadEventFrame {
  /** 游标序号（SSE last-event-id / 桥转发的 id；应用层握手帧为 0） */
  eventId: number;
  /** 帧载荷：SSE 形态为未解析的 JSON 文本，IPC 形态为已解析信封 */
  data: string | ChatEventEnvelope;
}

/** 一条对话流连接（对应旧代码里的单个 EventSource 实例）。 */
export interface ThreadEventConnection {
  /** 传输层通道打开（SSE onopen / IPC watch 受理）；不代表 Agent 已握手。 */
  onOpen(callback: () => void): void;
  /** 传输层心跳（SSE heartbeat 帧 / IPC op:heartbeat 活性帧）。 */
  onHeartbeat(callback: () => void): void;
  /** 应用层消息帧（含握手帧 connected/runtime_connecting 等）。 */
  onMessage(callback: (frame: ThreadEventFrame) => void): void;
  /** 连接错误（SSE onerror；IPC 形态由 main 侧桥内部重连，不回调）。 */
  onError(callback: () => void): void;
  /**
   * 断连通知（仅 IPC 形态：桥进入 retrying 状态帧时触发）。连接层据此即时
   * 置断开并解除握手等待，与旧 SSE onerror 的用户可见语义对齐；重连由桥负责。
   */
  onInterrupt(callback: () => void): void;
  /** 关闭连接（SSE 走安静关闭；IPC 停止桥订阅）。 */
  close(): void;
}

/** 对话流传输层（连接状态机经由它建连/收帧/关闭）。 */
export interface ThreadEventTransport {
  connect(params: ThreadEventConnectParams): ThreadEventConnection;
}

export interface ChatEventStreamDeps {
  clientId: string;
  threadId: string | null;
  workspace: string | null;
  refs: ChatEventStreamRefs;
  setConnected(value: boolean): void;
  transport: ThreadEventTransport;
}

// ============================================================================
// SSE transport（web / 无桥降级形态：逐行等价旧 EventSource 用法）
// ============================================================================

export interface SseThreadEventTransportOptions {
  /** 测试注入；默认 window.EventSource */
  createEventSource?: (url: string) => EventSource;
}

export function createSseThreadEventTransport(
  options: SseThreadEventTransportOptions = {}
): ThreadEventTransport {
  const createEventSource =
    options.createEventSource ?? ((url: string) => new EventSource(url));
  return {
    connect(params: ThreadEventConnectParams): ThreadEventConnection {
      const workspaceQuery = params.cwd ? `&cwd=${encodeURIComponent(params.cwd)}` : "";
      const cursorQuery = params.after ? `&after=${params.after}` : "";
      const streamQuery = params.streamId ? `&stream=${encodeURIComponent(params.streamId)}` : "";
      const source = createEventSource(
        `/api/agent/stream?client=${encodeURIComponent(params.client)}&thread=${encodeURIComponent(params.thread)}${workspaceQuery}${cursorQuery}${streamQuery}`
      );
      type MessageEventLike = { lastEventId?: unknown; data?: unknown };
      const connection: ThreadEventConnection = {
        onOpen(callback) {
          source.onopen = () => callback();
        },
        onHeartbeat(callback) {
          source.addEventListener("heartbeat", () => callback());
        },
        onMessage(callback) {
          source.onmessage = (event) => {
            const like = event as unknown as MessageEventLike;
            callback({
              eventId: Number(like.lastEventId || 0),
              data: typeof like.data === "string" ? like.data : String(like.data ?? "")
            });
          };
        },
        onError(callback) {
          source.onerror = () => callback();
        },
        onInterrupt() {
          // SSE 形态无桥状态帧；断连走 onError
        },
        close() {
          closeEventSourceQuietly(source, { client: params.client, thread: params.thread });
        }
      };
      return connection;
    }
  };
}

// ============================================================================
// IPC transport（新 UI 主路径：main 侧事件桥 → op:event 推送）
// ============================================================================

export interface IpcThreadEventTransportOptions {
  /** 测试注入；默认 ipc-client 封装 */
  watch?: typeof watchThreadEvents;
  stop?: typeof stopThreadEvents;
  subscribe?: typeof subscribeDesktopEvents;
}

/** op:event 中非对话流帧（记忆变更桥 / doc 实时预览 watch / SSE 命名事件 open 的降级形态）。 */
const NON_THREAD_FRAME_TYPES = new Set(["op:memory-change", "op:sse-unknown", "op:doc-watch", "op:browser-stream"]);

export function createIpcThreadEventTransport(
  options: IpcThreadEventTransportOptions = {}
): ThreadEventTransport {
  const watch = options.watch ?? watchThreadEvents;
  const stop = options.stop ?? stopThreadEvents;
  const subscribe = options.subscribe ?? subscribeDesktopEvents;
  return {
    connect(params: ThreadEventConnectParams): ThreadEventConnection {
      let openCallback: (() => void) | null = null;
      let heartbeatCallback: (() => void) | null = null;
      let messageCallback: ((frame: ThreadEventFrame) => void) | null = null;
      let errorCallback: (() => void) | null = null;
      let interruptCallback: (() => void) | null = null;
      let closed = false;
      // 先订阅后 watch：保证 watch 受理后的首帧不丢失（与旧 EventSource 同建连顺序）
      const unsubscribe = subscribe((event) => {
        if (closed) return;
        if (event.type === "op:heartbeat") {
          heartbeatCallback?.();
          return;
        }
        if (event.type === "op:stream-state") {
          // 桥断线重连窗口（retrying）：即时置断开并解除握手等待；重连由桥负责
          if (event.data.state === "retrying") interruptCallback?.();
          return;
        }
        if (NON_THREAD_FRAME_TYPES.has(event.type)) return;
        messageCallback?.({ eventId: Number(event.id ?? 0), data: event });
      });
      void watch({
        client: params.client,
        thread: params.thread,
        cwd: params.cwd || undefined,
        after: params.after,
        streamId: params.streamId
      }).then((result) => {
        if (closed) return;
        if (result.ok) openCallback?.();
        else errorCallback?.();
      });
      const connection: ThreadEventConnection = {
        onOpen(callback) {
          openCallback = callback;
        },
        onHeartbeat(callback) {
          heartbeatCallback = callback;
        },
        onMessage(callback) {
          messageCallback = callback;
        },
        onError(callback) {
          errorCallback = callback;
        },
        onInterrupt(callback) {
          interruptCallback = callback;
        },
        close() {
          if (closed) return;
          closed = true;
          unsubscribe();
          void stop({ client: params.client, thread: params.thread });
        }
      };
      return connection;
    }
  };
}

// ============================================================================
// 连接状态机（旧 SSE effect 1515-1696 逐行转录，transport 注入）
// ============================================================================

/**
 * 创建对话流连接控制器。返回清理函数（等价旧 effect 的 cleanup），
 * 6d 以 `useEffect(() => createChatEventStreamController(deps), [clientId, threadId, workspace])` 接线。
 */
export function createChatEventStreamController(deps: ChatEventStreamDeps): () => void {
  const { refs } = deps;
  const generation = refs.streamGenerationRef.current + 1;
  refs.streamGenerationRef.current = generation;
  let conn: ThreadEventConnection | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let retryDelay = 500;
  let retryAttempt = 0;
  let connectionSerial = 0;
  // Qoder P0-1（开关 qoderSseBackoff，默认关）：
  // 基线为固定倍增 500ms → 5s 封顶且无抖动，服务端重启时 N 个标签页会同相位重连形成风暴。
  // 打开后改为指数退避 800ms → 30s 封顶 + 0.5~1.0× 抖动：失败次数越多退避越久，且各标签页错峰。
  // 关闭时走下方原基线分支（逐字保持历史行为），因此开关关闭 = 与优化前完全一致。
  const computeRetryDelay = (): number => {
    if (!flag("qoderSseBackoff")) return Math.min(5000, retryDelay * 2);
    const BASE = 800;
    const MAX = 30000;
    const exponential = Math.min(MAX, BASE * (2 ** retryAttempt));
    const jitter = 0.5 + Math.random() * 0.5;
    return Math.max(1, Math.round(exponential * jitter));
  };
  let watchdogTimer: ReturnType<typeof setInterval> | null = null;
  // 对话流是核心长连接（必需）：申请槽位时若超预算会顶掉可放弃的面板流，
  // 保证"切工作区/切会话"这类控制面请求永远有槽位可用。
  const slot = acquireStream("chat", { essential: true, priority: 1, label: "对话流" });

  const streamKey = `${deps.clientId}::${deps.threadId || ""}`;
  const isCurrentGeneration = (): boolean =>
    !stopped && refs.mountedRef.current && generation === refs.streamGenerationRef.current;
  const resetReady = (): void => {
    let resolve: ((value: boolean) => void) | undefined;
    const promise = new Promise<boolean>((done) => {
      resolve = done;
    });
    refs.streamReadyRef.current = { promise, resolve, streamKey, generation };
  };
  refs.handshakeDoneRef.current = false;
  refs.eventCursorRef.current = refs.eventCursorsRef.current.get(streamKey) || 0;
  resetReady();
  const markReady = (value: boolean): void => {
    const entry = refs.streamReadyRef.current;
    if (entry?.generation === generation && entry?.streamKey === streamKey) {
      entry.resolve?.(value);
    }
  };

  const scheduleReconnect = (source: ThreadEventConnection | null): void => {
    if (!isCurrentGeneration() || !source || source !== conn) return;
    deps.setConnected(false);
    markReady(false);
    source.close();
    conn = null;
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, retryDelay);
    retryDelay = computeRetryDelay();
    retryAttempt += 1;
  };

  const connect = (): void => {
    if (!isCurrentGeneration()) return;
    resetReady();
    const serial = ++connectionSerial;
    let lastSignalAt = Date.now();

    const next = deps.transport.connect({
      client: deps.clientId,
      thread: deps.threadId || "",
      cwd: deps.workspace || "",
      after: refs.eventCursorRef.current,
      // 携带已知代际 ID：服务端据此判断游标是否属于旧通道并清零，
      // 否则 Runtime 重建后新通道的前 N 个事件会被旧游标整段过滤。
      streamId: refs.streamIdsRef.current.get(streamKey) || ""
    });
    conn = next;
    slot?.attach(() => next.close());

    next.onOpen(() => {
      // 仅表示传输层通道打开；Agent 是否已就绪由服务端 connected 握手确认。
      // 运行时冷启动可能需要几十秒；不能在 Pi 还在初始化时 5 秒就反复重建连接。
      window.setTimeout(() => {
        if (isCurrentGeneration() && serial === connectionSerial && conn === next && !refs.handshakeDoneRef.current) {
          scheduleReconnect(next);
        }
      }, 50000);
    });
    refs.handshakeDoneRef.current = false;

    next.onHeartbeat(() => {
      if (!isCurrentGeneration() || serial !== connectionSerial || conn !== next) return;
      // 心跳只证明传输层通道仍存活；"Agent 已连接"由 connected 握手确认，
      // 避免 Runtime 还在初始化时提前显示为已连接。
      lastSignalAt = Date.now();
    });

    next.onMessage((frame) => {
      if (!isCurrentGeneration() || serial !== connectionSerial || conn !== next) return;
      lastSignalAt = Date.now();
      const eventId = frame.eventId;
      // P2-1（开关 qoderSeqGapAlert，默认关）：发现游标跳变即记一条诊断。
      // 缺号一般源于服务端增量淘汰或回放窗口截断（截断另有 truncated / stream_resync 兜底），
      // 因此这里只做可观测记录，不改变重连与消费行为；仅首次缺号打一条 console 警告，避免刷屏。
      if (flag("qoderSeqGapAlert") && eventId > 0 && refs.eventCursorRef.current > 0 && eventId > refs.eventCursorRef.current + 1) {
        const gapCount = noteCursorGap(refs.eventCursorRef.current, eventId);
        if (gapCount === 1) {
          console.warn(`[oaw] SSE 事件缺号：${refs.eventCursorRef.current} → ${eventId}（缺 ${eventId - refs.eventCursorRef.current - 1} 帧），已记入长连接诊断`);
        }
      }
      let payload: ChatEventInput;
      if (typeof frame.data === "string") {
        try {
          payload = JSON.parse(frame.data) as ChatEventInput;
        } catch (err) {
          console.error("SSE message parse error:", err);
          return;
        }
      } else {
        payload = frame.data;
      }
      if (payload?.type === "connected") {
        refs.handshakeDoneRef.current = true;
        const data = (payload.data ?? {}) as Record<string, unknown>;
        const rawStreamId: unknown = data.streamId;
        const connectedStreamId = rawStreamId ? String(rawStreamId) : "";
        const previousStreamId = refs.streamIdsRef.current.get(streamKey) || "";
        // 代际变化：Runtime/会话重建后服务端序号从 1 重新开始，
        // 旧游标必须废弃，否则新通道事件会被整段过滤。
        if (connectedStreamId && previousStreamId && connectedStreamId !== previousStreamId) {
          refs.eventCursorRef.current = 0;
          refs.eventCursorsRef.current.delete(streamKey);
        }
        if (connectedStreamId) refs.streamIdsRef.current.set(streamKey, connectedStreamId);
        const rawCursor: unknown = data.cursor;
        const connectedCursor = Number(rawCursor ? rawCursor : 0);
        if (connectedCursor > refs.eventCursorRef.current) {
          refs.eventCursorRef.current = connectedCursor;
          refs.eventCursorsRef.current.set(streamKey, connectedCursor);
        }
        // 只有应用层握手成功后才清除退避；HTTP onopen 过早重置会让
        // Runtime 初始化失败时进入 500ms 高频重连循环。
        retryDelay = 500;
        retryAttempt = 0;
        markReady(true);
      }
      // 事件处理成功后才提交应用层游标：单条事件处理器异常时游标不前进，
      // 重连后该事件会被重新回放，而不是被静默跳过。
      refs.eventHandlerRef.current?.(payload);
      if (eventId > refs.eventCursorRef.current) {
        refs.eventCursorRef.current = eventId;
        refs.eventCursorsRef.current.set(streamKey, eventId);
      }
    });

    next.onError(() => {
      if (isCurrentGeneration() && serial === connectionSerial && conn === next) {
        scheduleReconnect(next);
      }
    });
    // IPC 形态：桥断线重连窗口即时置断开（旧 onerror 的用户可见语义）；
    // 与 onError 不同——不关闭本连接、不触发渲染层重连，重连由桥内部负责。
    next.onInterrupt(() => {
      if (!isCurrentGeneration() || serial !== connectionSerial || conn !== next) return;
      deps.setConnected(false);
      markReady(false);
    });
    // P2-2：静默阈值由服务端心跳间隔派生（默认心跳 5s → 阈值 20s，与基线完全一致）；
    // 若把心跳调大（低功耗 / 远程 SSH 场景），阈值随之放大，避免把正常的慢心跳误判成断线。
    const silenceLimit = Math.max(20000, numberFlag("heartbeatChatMs", 5000) * 2.5);
    watchdogTimer = setInterval(() => {
      // 某些代理/浏览器会保持 TCP 为 open，却不再触发 EventSource.onerror；
      // 服务端 heartbeat 正常时不会触发这里，超过静默阈值才强制重连。
      if (isCurrentGeneration() && Date.now() - lastSignalAt > silenceLimit) scheduleReconnect(next);
    }, 5000);
  };

  connect();
  // 发送后长时间无事件（半开连接/重连失败）时强制重连，用服务端回放补齐内容
  const onForceReconnect = (): void => {
    if (conn && !stopped && refs.mountedRef.current) scheduleReconnect(conn);
  };
  window.addEventListener("oaw:force-reconnect", onForceReconnect);

  return () => {
    stopped = true;
    connectionSerial += 1;
    window.removeEventListener("oaw:force-reconnect", onForceReconnect);
    if (conn) conn.close();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (watchdogTimer) clearInterval(watchdogTimer);
    slot?.release();
    markReady(false);
    const entry = refs.streamReadyRef.current;
    if (entry?.generation === generation && entry?.streamKey === streamKey) {
      refs.streamReadyRef.current = null;
    }
  };
}
