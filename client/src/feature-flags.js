/**
 * 前端运行开关（与服务端 feature-flags.mjs 对应的只读消费端）。
 *
 * 服务端经 /api/status 的 runtimeFlags 快照下发（评审 R8 管道）；
 * 快照到达前所有开关按「关闭」处理 —— 关闭即基线行为，因此早期渲染天然安全。
 */

let snapshot = {};

let flagsReadyResolve;
/** 快照就绪信号：initRuntimeFlags 完成（成功或失败）后 resolve，供 mount 期依赖开关的逻辑重试。 */
export const flagsReady = new Promise((resolve) => { flagsReadyResolve = resolve; });

export async function initRuntimeFlags() {
  try {
    const r = await fetch("/api/status", { cache: "no-store" }).then((x) => x.json());
    if (r && typeof r === "object" && r.runtimeFlags && typeof r.runtimeFlags === "object") {
      snapshot = r.runtimeFlags;
    }
  } catch {
    // 拉取失败保持全关 = 基线行为，无需降级逻辑
  } finally {
    try { flagsReadyResolve?.(); } catch {}
  }
}

/** 只读访问；未知开关名一律视为关闭。 */
export function flag(name) {
  return snapshot[name] === true;
}

/**
 * 只读数值开关（如心跳间隔）：快照缺失或值非法时返回 fallback。
 * 与 flag() 共用同一份快照，避免各模块各自解析环境变量造成语义分叉。
 */
export function numberFlag(name, fallback = 0) {
  const value = Number(snapshot[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
