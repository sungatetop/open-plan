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
}
