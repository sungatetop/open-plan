import { describe, it, expect } from "vitest";
import {
  COMPLETION_STATUSES,
  completionStatusLabel,
  normalizeCompletion,
  applyObjectiveDowngrade,
  inferCompletion
} from "../src/shared/runtime/run-trace";
import type { CompletionRecord } from "../src/shared/runtime/run-trace";

const serverModule = await import("../../server/run-trace.mjs");
// server 版为 JS 推断签名，测试用宽容视图以覆盖 null/undefined/异型输入
const js = serverModule as unknown as {
  COMPLETION_STATUSES: string[];
  completionStatusLabel(status: unknown): string;
  normalizeCompletion(raw?: unknown): CompletionRecord | null;
  applyObjectiveDowngrade(completion?: unknown, options?: { runStatus?: string; verificationStatus?: string }): unknown;
  inferCompletion(input?: unknown): CompletionRecord;
};
const server = js;

const stripAt = (value: unknown) => {
  if (!value || typeof value !== "object") return value;
  const { at, ...rest } = value as Record<string, unknown>;
  void at;
  return rest;
};

describe("run-trace TS 版与 server 版等价（对拍）", () => {
  it("完成状态常量一致", () => {
    expect([...COMPLETION_STATUSES]).toEqual([...server.COMPLETION_STATUSES]);
  });

  it("completionStatusLabel 各状态文案一致", () => {
    for (const status of ["success", "partial", "blocked", "failed", "cancelled", "unknown", "", null, undefined]) {
      expect(completionStatusLabel(status)).toBe(server.completionStatusLabel(status));
    }
  });

  it("normalizeCompletion 合法/非法入参结果一致（除时间戳）", () => {
    const cases = [
      { status: "success", summary: "完成了" },
      { status: "SUCCESS ", summary: "  大写与空白  ", incomplete: ["a", "", 42], blockers: ["b"], verification: " 已核验 " },
      { status: "partial", summary: "x".repeat(4100), incomplete: Array.from({ length: 30 }, (_, i) => `item-${i}`) },
      { status: "unknown", summary: "x" },
      { summary: "缺少状态" },
      null,
      undefined
    ];
    for (const input of cases) {
      const tsResult = normalizeCompletion(input);
      const jsResult = server.normalizeCompletion(input);
      expect(tsResult === null).toBe(jsResult === null);
      if (tsResult && jsResult) expect(stripAt(tsResult)).toEqual(stripAt(jsResult));
    }
  });

  it("applyObjectiveDowngrade 降级矩阵一致", () => {
    const base: Record<string, unknown> = { status: "success", summary: "s", incomplete: [], blockers: [], verification: null };
    const cases: Array<[string, string]> = [
      ["completed", "not_checked"],
      ["completed", "failed"],
      ["cancelled", "not_checked"],
      ["aborted", "not_checked"],
      ["failed", "not_checked"]
    ];
    for (const [runStatus, verificationStatus] of cases) {
      const tsResult = applyObjectiveDowngrade({ ...base }, { runStatus, verificationStatus });
      const jsResult = server.applyObjectiveDowngrade({ ...base }, { runStatus, verificationStatus });
      expect(tsResult).toEqual(jsResult);
    }
    // 非对象/缺 status 原样返回
    expect(applyObjectiveDowngrade(null)).toBeNull();
    expect(applyObjectiveDowngrade(undefined)).toBeUndefined();
    expect(applyObjectiveDowngrade({})).toEqual(server.applyObjectiveDowngrade({}));
  });

  it("inferCompletion 推断矩阵一致（除时间戳）", () => {
    const cases = [
      { runStatus: "completed", artifacts: 3 },
      { runStatus: "completed", artifacts: 0 },
      { runStatus: "cancelled" },
      { runStatus: "aborted" },
      { runStatus: "failed" },
      { runStatus: "completed", validations: [{ status: "failed" }] },
      { runStatus: "completed", validations: [{ status: "passed" }, null] }
    ];
    for (const input of cases) {
      const tsResult: CompletionRecord = inferCompletion(input as never);
      const jsResult = server.inferCompletion(input);
      expect(stripAt(tsResult)).toEqual(stripAt(jsResult));
    }
  });
});
