/**
 * 浏览器面板 ↔ 对话工具卡 联动注册表（O-P8 双通道对账）。
 *
 * 内置浏览器面板把帧流连接状态发布到这里；ChatPanel 的 browser_* 工具卡在完成时读取，
 * 用于「工具报成功但面板重连中」的对账提示（开关 OAW_RECONCILE_HINT，默认关）。
 * 纯内存模块：不持久化、不跨页签同步。
 *
 * 与 client/src/browser-linkage.js 逐函数等价（tests/f1-browser-linkage-parity.test.ts 对拍强制）。
 */

let streamState = { status: "idle", since: 0 };

export function setBrowserStreamState(status: unknown): void {
  const next = String(status || "idle");
  if (streamState.status === next) return;
  streamState = { status: next, since: Date.now() };
}

export function getBrowserStreamState(): { status: string; since: number } {
  return streamState;
}
