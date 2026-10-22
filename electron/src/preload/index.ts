import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  EVENT_PUSH_CHANNEL,
  type ChannelRequest,
  type ChannelResponse,
  type DesktopChannelId,
  type DesktopEvent,
  type InvokeResult
} from "../shared/protocol/channels";
import type {
  AgentEventWatchRequest,
  EventWatchResult,
  OpDesktopApi,
  ServerStatusPayload,
  ThreadEventWatchRequest
} from "../shared/desktop-protocol";

const api: OpDesktopApi = {
  protocolVersion: 2,
  getServerStatus: (): Promise<ServerStatusPayload> => ipcRenderer.invoke("op:server-status"),
  onServerStatus: (callback: (status: ServerStatusPayload) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, status: ServerStatusPayload) => callback(status);
    ipcRenderer.on("op:server-status", handler);
    return () => ipcRenderer.removeListener("op:server-status", handler);
  },
  invoke: <C extends DesktopChannelId>(
    channel: C,
    payload?: ChannelRequest<C>
  ): Promise<InvokeResult<ChannelResponse<C>>> =>
    ipcRenderer.invoke(channel, payload) as Promise<InvokeResult<ChannelResponse<C>>>,
  onEvent: (listener: (event: DesktopEvent) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, evt: DesktopEvent) => listener(evt);
    ipcRenderer.on(EVENT_PUSH_CHANNEL, handler);
    return () => ipcRenderer.removeListener(EVENT_PUSH_CHANNEL, handler);
  },
  watchThreadEvents: (request: ThreadEventWatchRequest): Promise<EventWatchResult> =>
    ipcRenderer.invoke("op:events:watch", request),
  stopThreadEvents: (request?: { client?: string; thread?: string }): Promise<void> =>
    ipcRenderer.invoke("op:events:unwatch", request ?? {}),
  watchMemoryEvents: (): Promise<EventWatchResult> => ipcRenderer.invoke("op:memory:watch"),
  stopMemoryEvents: (): Promise<void> => ipcRenderer.invoke("op:memory:unwatch"),
  watchAgentEvents: (request: AgentEventWatchRequest): Promise<EventWatchResult> =>
    ipcRenderer.invoke("op:agent-events:watch", request),
  stopAgentEvents: (request?: { client?: string }): Promise<void> =>
    ipcRenderer.invoke("op:agent-events:unwatch", request ?? {})
};

contextBridge.exposeInMainWorld("opDesktop", api);
