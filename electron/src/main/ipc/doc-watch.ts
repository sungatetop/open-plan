/**
 * doc 实时预览文件监听注册表（F4-4）：fs.watchFile 轮询 + 变化事件回调。
 *
 * 语义差异（对照 server/office.mjs startWatch，行号锚点指 server/index.mjs watch 路由）：
 *   - HTTP 形态（server L1218-1230）：startWatch 启动 officecli watch 子进程，
 *     返回渲染服务 URL（http://localhost:port）由旧客户端 iframe 直接加载；
 *   - IPC 形态：渲染层 CSP default-src 'self' 禁止 http://localhost iframe，且桌面端
 *     禁 HTTP 通道原则 —— 改为 fs.watchFile（800ms，对齐 office.mjs startWatch 的
 *     轮询口径）检测 mtime 变化，经 op:doc-watch 事件推送 files 列表，渲染层收到后
 *     重拉 op:doc:html 刷新 srcDoc。「agent 改文件 → 预览自动刷新」语义等价。
 *
 * 事件形态对齐 agent-prompt-direct.ts 的 file_changed 推送（{files: [relativePath]}），
 * 但使用独立事件类型 op:doc-watch：不进对话流（event-stream.ts NON_THREAD_FRAME_TYPES
 * 排除），避免污染会话时间线。
 *
 * 纯 Node 模块（不 import electron，vitest 可注入 fs 面直接测）；注册入口在
 * main/index.ts registerDocDirectInvokers（emit 回调绑 broadcastEvent）。
 */
import fs from "node:fs";
import { DOC_WATCH_EVENT_TYPE } from "../../shared/protocol/channels";

export { DOC_WATCH_EVENT_TYPE };

/** 轮询间隔（对齐 server/office.mjs startWatch 的 800ms 口径）。 */
export const DOC_WATCH_POLL_MS = 800;

export interface DocWatchRegistryOptions {
  /** fs 面（注入便于测试） */
  watchFile: (path: string, options: { interval: number }, listener: (curr: { mtimeMs: number }) => void) => void;
  unwatchFile: (path: string) => void;
  statSync: (path: string) => { mtimeMs: number };
}

export interface DocWatchHandle {
  stop: () => void;
}

/**
 * 创建 watch 注册表。emit 为事件出口（生产传 broadcastEvent 组装 DesktopEvent）。
 * 同一文件重复 start 幂等（已监听则直接返回，不叠加监听器）。
 */
export function createDocWatchRegistry(
  emit: (event: { type: string; data: { files: string[] } }) => void,
  options: DocWatchRegistryOptions
): {
  start: (absPath: string, relativePath: string) => DocWatchHandle;
  stop: (absPath: string) => void;
  has: (absPath: string) => boolean;
} {
  const entries = new Map<string, { stop: () => void }>();
  const start = (absPath: string, relativePath: string): DocWatchHandle => {
    const existing = entries.get(absPath);
    if (existing) return existing;
    // 以注册时的 mtime 为基线：注册本身不触发事件，文件被改写后才推送。
    let lastMtime = -1;
    try { lastMtime = options.statSync(absPath).mtimeMs; } catch {}
    const listener = (curr: { mtimeMs: number }): void => {
      if (!curr || curr.mtimeMs === lastMtime) return;
      lastMtime = curr.mtimeMs;
      emit({ type: DOC_WATCH_EVENT_TYPE, data: { files: [relativePath] } });
    };
    options.watchFile(absPath, { interval: DOC_WATCH_POLL_MS }, listener);
    const handle: DocWatchHandle = {
      stop: () => {
        options.unwatchFile(absPath);
        entries.delete(absPath);
      },
    };
    entries.set(absPath, handle);
    return handle;
  };
  const stop = (absPath: string): void => {
    entries.get(absPath)?.stop();
  };
  return { start, stop, has: (absPath: string) => entries.has(absPath) };
}
