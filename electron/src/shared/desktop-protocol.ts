import type {
  ChannelRequest,
  ChannelResponse,
  DesktopChannelId,
  DesktopEvent,
  InvokeResult
} from "./protocol/channels";

/** 桌面平台协议 v2：v1 仅服务状态；v2 扩展 invoke 通道族（shared/protocol/channels.ts）与事件推送。 */
export interface ServerStatusPayload {
  phase: "starting" | "ready" | "failed" | "stopped";
  port?: number;
  message?: string;
  logTail?: string[];
}

export interface OpDesktopApi {
  /** 协议版本，前端可据此协商与降级 */
  readonly protocolVersion: number;
  getServerStatus(): Promise<ServerStatusPayload>;
  onServerStatus(callback: (status: ServerStatusPayload) => void): () => void;
  /**
   * 调用请求/响应通道（shared/protocol/channels.ts 清单）。
   * 结果保留 HTTP 语义：非 2xx 返回 ok:false 而非 reject；桥缺失/传输异常才 reject。
   */
  invoke<C extends DesktopChannelId>(
    channel: C,
    payload?: ChannelRequest<C>
  ): Promise<InvokeResult<ChannelResponse<C>>>;
  /** 订阅事件推送（op:event）；返回退订函数。 */
  onEvent(listener: (event: DesktopEvent) => void): () => void;
  /**
   * 订阅某线程的对话流事件（main 侧消费 legacy SSE → op:event 推送）。
   * 同键幂等；切换线程由 main 侧优雅收旧流。ok=false 表示请求被拒（缺参等）。
   */
  watchThreadEvents(request: ThreadEventWatchRequest): Promise<EventWatchResult>;
  /** 停止事件订阅（省略参数 = 停当前订阅）。 */
  stopThreadEvents(request?: { client?: string; thread?: string }): Promise<void>;
  /**
   * 订阅记忆文件变更流（main 侧消费 legacy /api/memory/stream SSE → op:event，
   * 帧类型 op:memory-change，data 为 { file, event, preview, time }）。
   * 全局单流，重复 watch 幂等。ok=false 表示请求被拒。
   */
  watchMemoryEvents(): Promise<EventWatchResult>;
  /** 停止记忆变更流订阅。 */
  stopMemoryEvents(): Promise<void>;
  /**
   * 订阅全局 Agent 事件流（main 侧消费 legacy /api/agent/events SSE → op:event，
   * 帧类型 op:agent-event，data 为事件本体 { seq, type, threadId, ... }）。
   * 桥内部断线重连自持游标续传；after 只作用于 watch 建流起点（渲染层冷启动
   * 未知游标时先拉 events/state 再带参 watch）。同 client 幂等。ok=false 表示请求被拒。
   */
  watchAgentEvents(request: AgentEventWatchRequest): Promise<EventWatchResult>;
  /** 停止全局 Agent 事件流订阅（省略参数 = 停当前订阅）。 */
  stopAgentEvents(request?: { client?: string }): Promise<void>;
  /**
   * 订阅内置浏览器帧流（F6-2：main 侧 subscribeBrowser 推桥 → op:browser-stream 事件，
   * 替代旧 EventSource GET /api/browser/stream 建立序）。注册表同 (client, thread)
   * 去重并重发初始 state/frame 快照；重复 watch 以最新 frames 偏好重订阅。
   * ok=false 表示请求被拒。
   */
  watchBrowserStream(request: BrowserStreamWatchRequest): Promise<EventWatchResult>;
  /** 停止浏览器帧流订阅（订阅者数量递减语义，对齐 SSE req close）。 */
  stopBrowserStream(request?: { client?: string; thread?: string }): Promise<void>;
}

/** 浏览器帧流订阅请求（对齐 SSE 建立参数 client/thread/frames）。 */
export interface BrowserStreamWatchRequest {
  client: string;
  thread?: string;
  /** 是否推送画面帧（默认 true；false = 仅 state/tabs/closed 控制帧）。 */
  frames?: boolean;
}

/** 对话流事件订阅请求（对齐 /api/agent/stream 查询参数）。 */
export interface ThreadEventWatchRequest {
  client: string;
  thread?: string;
  cwd?: string;
  /**
   * 续传游标（对齐 /api/agent/stream 的 after 查询参数，0/省略 = 从头回放）。
   * 桥内部断线重连自持游标；该字段只作用于 watch 建流起点（渲染层换线程/
   * 强制重连时携带，服务端据此回放补齐缺失事件）。
   */
  after?: number;
  /** 已知通道代际 id（对齐 stream 查询参数）：代际不一致时服务端将游标清零。 */
  streamId?: string;
}

export interface EventWatchResult {
  ok: boolean;
  error?: string;
}

/** 全局 Agent 事件流订阅请求（对齐 /api/agent/events 查询参数）。 */
export interface AgentEventWatchRequest {
  client: string;
  /**
   * 续传游标（对齐 after 查询参数，0/省略 = 从服务端最早可回放处开始）。
   * 桥内部断线重连自持游标；该字段只作用于 watch 建流起点。
   */
  after?: number;
}
