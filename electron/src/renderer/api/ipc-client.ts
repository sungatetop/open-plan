import type {
  ChannelRequest,
  ChannelResponse,
  DesktopChannelId,
  DesktopEvent,
  InvokeResult
} from "../../shared/protocol/channels";
import type {
  AgentEventWatchRequest,
  EventWatchResult,
  OpDesktopApi,
  ServerStatusPayload,
  ThreadEventWatchRequest
} from "../../shared/desktop-protocol";

/**
 * 桌面 IPC client 范本（F2）。
 *
 * 约定：`api/` 目录按通道族分文件封装 `window.opDesktop`，类型一律来自
 * `shared/desktop-protocol` 与 `shared/protocol`；新 UI 禁止引入 HTTP/SSE 通道。
 * web/降级形态（无 preload 注入）返回 null，由调用方决定兜底 UI。
 */

declare global {
  interface Window {
    opDesktop?: OpDesktopApi;
  }
}

export function getDesktopApi(): OpDesktopApi | null {
  return typeof window !== "undefined" ? (window.opDesktop ?? null) : null;
}

export function requireDesktopApi(): OpDesktopApi {
  const api = getDesktopApi();
  if (!api) throw new Error("桌面桥未就绪（window.opDesktop 不存在），请在 Electron 环境内运行");
  return api;
}

export function fetchServerStatus(): Promise<ServerStatusPayload | null> {
  const api = getDesktopApi();
  if (!api) return Promise.resolve(null);
  return api.getServerStatus().catch(() => null);
}

/** 订阅服务状态推送；返回退订函数。无桥时返回空退订。 */
export function subscribeServerStatus(callback: (status: ServerStatusPayload) => void): () => void {
  const api = getDesktopApi();
  if (!api) return () => {};
  return api.onServerStatus(callback);
}

/**
 * 调用请求/响应通道（通道清单见 shared/protocol/channels.ts）。
 * 非 2xx 不抛异常：返回 ok:false（error 信息在 data.error）；桥缺失才抛错。
 */
export async function invokeChannel<C extends DesktopChannelId>(
  channel: C,
  ...args: ChannelRequest<C> extends Record<string, never> ? [] : [payload: ChannelRequest<C>]
): Promise<InvokeResult<ChannelResponse<C>>> {
  const api = requireDesktopApi();
  return api.invoke(channel, ...(args as [payload?: ChannelRequest<C>])) as Promise<InvokeResult<ChannelResponse<C>>>;
}

/**
 * invokeChannel 的直通形态（payload 可选传）：供 api 层泛型封装使用，
 * 规避条件元组变参在泛型转发处的类型摩擦。语义与 invokeChannel 完全一致。
 */
export async function invokeChannelRaw<C extends DesktopChannelId>(
  channel: C,
  payload?: ChannelRequest<C>
): Promise<InvokeResult<ChannelResponse<C>>> {
  const api = requireDesktopApi();
  return api.invoke(channel, payload) as Promise<InvokeResult<ChannelResponse<C>>>;
}

/** 订阅事件推送（op:event）；无桥时返回空退订。 */
export function subscribeDesktopEvents(listener: (event: DesktopEvent) => void): () => void {
  const api = getDesktopApi();
  if (!api) return () => {};
  return api.onEvent(listener);
}

/**
 * 订阅线程对话流（main 侧消费 legacy SSE → op:event）。
 * 无桥（web 形态）返回 ok:false，由调用方决定是否走 HTTP/SSE 兜底。
 */
export async function watchThreadEvents(request: ThreadEventWatchRequest): Promise<EventWatchResult> {
  const api = getDesktopApi();
  if (!api) return { ok: false, error: "桌面桥未就绪" };
  return api.watchThreadEvents(request).catch((error: unknown) => ({
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  }));
}

/** 停止线程对话流订阅；无桥时为空操作。 */
export async function stopThreadEvents(request?: { client?: string; thread?: string }): Promise<void> {
  const api = getDesktopApi();
  if (!api) return;
  await api.stopThreadEvents(request).catch(() => undefined);
}

/**
 * 订阅记忆文件变更流（main 侧消费 legacy SSE → op:event，帧类型 op:memory-change）。
 * 无桥（web 形态）返回 ok:false。
 */
export async function watchMemoryEvents(): Promise<EventWatchResult> {
  const api = getDesktopApi();
  if (!api) return { ok: false, error: "桌面桥未就绪" };
  return api.watchMemoryEvents().catch((error: unknown) => ({
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  }));
}

/** 停止记忆变更流订阅；无桥时为空操作。 */
export async function stopMemoryEvents(): Promise<void> {
  const api = getDesktopApi();
  if (!api) return;
  await api.stopMemoryEvents().catch(() => undefined);
}

/**
 * 订阅全局 Agent 事件流（main 侧消费 legacy SSE → op:event，帧类型 op:agent-event）。
 * 无桥（web 形态）返回 ok:false。
 */
export async function watchAgentEvents(request: AgentEventWatchRequest): Promise<EventWatchResult> {
  const api = getDesktopApi();
  if (!api) return { ok: false, error: "桌面桥未就绪" };
  return api.watchAgentEvents(request).catch((error: unknown) => ({
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  }));
}

/** 停止全局 Agent 事件流订阅；无桥时为空操作。 */
export async function stopAgentEvents(request?: { client?: string }): Promise<void> {
  const api = getDesktopApi();
  if (!api) return;
  await api.stopAgentEvents(request).catch(() => undefined);
}
