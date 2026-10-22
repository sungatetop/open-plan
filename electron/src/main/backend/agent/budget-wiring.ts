/**
 * E02 运行预算接线（B6-6-4f，自 server/agent.mjs L364-394 逐行转录）。
 *
 * 把 shared/runtime/run-budget 的纯逻辑接入真实工具/回合路径：按 Run 维护 entry 上的
 * 预算状态、产出可见的预算事件（默认 soft 只提醒；OAW_RUN_BUDGET_ENFORCE=hard 时
 * 硬预算命中用 abort 硬停本 Run）。
 */
import { createRunBudget, budgetSnapshot } from "../../../shared/runtime/run-budget";

// 默认 soft：只产出可见的预算事件与提醒；设为 hard 时，硬预算命中会用 abort 停止本 Run。
export const RUN_BUDGET_ENFORCE = String(process.env.OAW_RUN_BUDGET_ENFORCE || "soft").toLowerCase();

/** 取（或按新 Run 重建）当前 entry 的预算状态。 */
export function ensureRunBudget(entry: any): any {
  if (!entry) return null;
  const runId = entry.activeRunId || null;
  if (!entry.runBudget || entry.runBudgetRunId !== runId) {
    entry.runBudget = createRunBudget({ runId });
    entry.runBudgetRunId = runId;
    entry.budgetStopped = false;
    entry.toolArgsById = entry.toolArgsById || new Map();
    entry.toolArgsById.clear();
  }
  return entry.runBudget;
}

/** 预算事件：soft → run_budget_notice，hard → run_budget_blocked（均带诊断快照）。 */
export function emitBudgetEvent(entry: any, emit: (type: string, data: any) => void, level: unknown, code: unknown, reason: unknown): void {
  if (!level || !code) return;
  const type = level === "hard" ? "run_budget_blocked" : "run_budget_notice";
  emit(type, { level, code, reason, snapshot: entry?.runBudget ? budgetSnapshot(entry.runBudget) : null });
}

/** 硬预算停止：同一 Run 只触发一次 abort。 */
export function stopRunByBudget(entry: any): void {
  if (!entry || entry.budgetStopped || RUN_BUDGET_ENFORCE !== "hard") return;
  entry.budgetStopped = true;
  try { void entry.session?.abort?.(); } catch {}
}
