/** 桌面平台协议 v1：R0/R1 阶段仅服务状态；R2 起按通道族扩展（对齐 shared/protocol 规划）。 */
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
}
