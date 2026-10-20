import { describe, it, expect } from "vitest";
import {
  TURN_BUDGET_SOFT,
  TURN_BUDGET_HARD,
  TURN_PROGRESS_INTERVAL,
  TURN_PROGRESS_MIN_TURNS,
  turnNoticeKind,
  turnNoticeText,
  turnBudgetPolicy
} from "../src/shared/runtime/turn-budget";

const serverModule = await import("../../server/turn-budget.mjs");
// server 版为 JS 推断签名，测试用宽容视图以覆盖 null/undefined/字符串输入
const server = serverModule as unknown as {
  TURN_BUDGET_SOFT: number;
  TURN_BUDGET_HARD: number;
  TURN_PROGRESS_INTERVAL: number;
  TURN_PROGRESS_MIN_TURNS: number;
  turnNoticeKind(turnCount: unknown, options?: Record<string, number>): string | null;
  turnNoticeText(kind: unknown, turnCount: unknown, options?: { interval?: number }): string;
  turnBudgetPolicy(): Record<string, unknown>;
};

describe("turn-budget TS 版与 server 版等价（对拍）", () => {
  it("常量一致（同进程读同一 env）", () => {
    expect(TURN_BUDGET_SOFT).toBe(server.TURN_BUDGET_SOFT);
    expect(TURN_BUDGET_HARD).toBe(server.TURN_BUDGET_HARD);
    expect(TURN_PROGRESS_INTERVAL).toBe(server.TURN_PROGRESS_INTERVAL);
    expect(TURN_PROGRESS_MIN_TURNS).toBe(server.TURN_PROGRESS_MIN_TURNS);
  });

  it("turnNoticeKind 判定矩阵一致", () => {
    const cases = [
      0, -3, 1, 5, 6, 12, 18, 24, 25, 26, 30, 36, 44, 45, 46, 50, "12", "abc", null, undefined, NaN
    ];
    for (const turn of cases) {
      expect(turnNoticeKind(turn)).toBe(server.turnNoticeKind(turn));
    }
    // 显式参数：周期关闭 / 非默认间隔 / minTurns 提高
    const optionCases: Array<[number, Record<string, number>]> = [
      [12, { interval: 0 }],
      [9, { interval: 3, minTurns: 10 }],
      [15, { interval: 5 }],
      [25, { soft: 30 }],
      [45, { hard: 60 }]
    ];
    for (const [turn, options] of optionCases) {
      expect(turnNoticeKind(turn, options)).toBe(server.turnNoticeKind(turn, options));
    }
  });

  it("turnNoticeText 三类文案与兜底一致", () => {
    for (const kind of ["turn-progress", "turn-budget", "turn-budget-hard", "other", null, undefined]) {
      expect(turnNoticeText(kind, 12)).toBe(server.turnNoticeText(kind, 12));
      expect(turnNoticeText(kind, 0)).toBe(server.turnNoticeText(kind, 0));
    }
  });

  it("turnBudgetPolicy 快照一致", () => {
    expect(turnBudgetPolicy()).toEqual(server.turnBudgetPolicy());
  });
});
