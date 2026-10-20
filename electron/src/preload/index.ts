import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { OpDesktopApi, ServerStatusPayload } from "../shared/desktop-protocol";

const api: OpDesktopApi = {
  protocolVersion: 1,
  getServerStatus: (): Promise<ServerStatusPayload> => ipcRenderer.invoke("op:server-status"),
  onServerStatus: (callback: (status: ServerStatusPayload) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, status: ServerStatusPayload) => callback(status);
    ipcRenderer.on("op:server-status", handler);
    return () => ipcRenderer.removeListener("op:server-status", handler);
  }
};

contextBridge.exposeInMainWorld("opDesktop", api);
