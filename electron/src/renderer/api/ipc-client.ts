import type { OpDesktopApi, ServerStatusPayload } from "../../shared/desktop-protocol";

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
