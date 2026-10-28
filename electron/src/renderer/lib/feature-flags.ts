/**
 * 前端运行开关（与服务端 feature-flags.mjs 对应的只读消费端）。
 *
 * 快照经 op:status:get 通道下发（评审 R8 管道；BRD-009 架构性等价替换：
 * 旧内联 fetch("/api/status") → IPC 通道，client/src/feature-flags.js 仍走 HTTP 对拍）。
 * 快照到达前所有开关按「关闭」处理 —— 关闭即基线行为，因此早期渲染天然安全。
 */
import { getStatus } from "../api/client-api";

let snapshot: Record<string, unknown> = {};

let flagsReadyResolve: (() => void) | undefined;
/** 快照就绪信号：initRuntimeFlags 完成（成功或失败）后 resolve，供 mount 期依赖开关的逻辑重试。 */
export const flagsReady: Promise<void> = new Promise((resolve) => { flagsReadyResolve = resolve; });

export async function initRuntimeFlags(): Promise<void> {
  try {
    const status = await getStatus();
    const flags: unknown = status.runtimeFlags;
    if (flags && typeof flags === "object") {
      snapshot = flags as Record<string, unknown>;
    }
  } catch {
    // 拉取失败保持全关 = 基线行为，无需降级逻辑
  } finally {
    try { flagsReadyResolve?.(); } catch {}
  }
}

/** 只读访问；未知开关名一律视为关闭。 */
export function flag(name: unknown): boolean {
  return (snapshot as Record<PropertyKey, unknown>)[name as PropertyKey] === true;
}

/**
 * 只读数值开关（如心跳间隔）：快照缺失或值非法时返回 fallback。
 * 与 flag() 共用同一份快照，避免各模块各自解析环境变量造成语义分叉。
 */
export function numberFlag(name: unknown, fallback = 0): number {
  const value = Number((snapshot as Record<PropertyKey, unknown>)[name as PropertyKey]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
