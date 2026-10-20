import { describe, it, expect } from "vitest";
import {
  TURN_BUDGET_SOFT,
  TURN_BUDGET_HARD,
  TOOL_BUDGET_SOFT,
  TOOL_BUDGET_HARD,
  EFFECTIVE_MS_SOFT,
  EFFECTIVE_MS_HARD,
  REPEAT_LIMIT,
  FAILURE_LIMIT,
  READ_POLL_LIMIT,
  stableStringify,
  fingerprintArgs,
  readVersionToken,
  createRunBudget,
  noteTurn,
  noteWaiting,
  noteEffective,
  grantBudget,
  evaluateToolGate,
  noteToolResult,
  evaluateTurnGate,
  budgetSnapshot
} from "../src/shared/runtime/run-budget";

const serverModule = await import("../../server/run-budget.mjs");
const server = serverModule as unknown as typeof import("../src/shared/runtime/run-budget");

describe("run-budget TS 版与 server 版等价（对拍）", () => {
  it("常量一致", () => {
    expect(TURN_BUDGET_SOFT).toBe(server.TURN_BUDGET_SOFT);
    expect(TURN_BUDGET_HARD).toBe(server.TURN_BUDGET_HARD);
    expect(TOOL_BUDGET_SOFT).toBe(server.TOOL_BUDGET_SOFT);
    expect(TOOL_BUDGET_HARD).toBe(server.TOOL_BUDGET_HARD);
    expect(EFFECTIVE_MS_SOFT).toBe(server.EFFECTIVE_MS_SOFT);
    expect(EFFECTIVE_MS_HARD).toBe(server.EFFECTIVE_MS_HARD);
    expect(REPEAT_LIMIT).toBe(server.REPEAT_LIMIT);
    expect(FAILURE_LIMIT).toBe(server.FAILURE_LIMIT);
    expect(READ_POLL_LIMIT).toBe(server.READ_POLL_LIMIT);
  });

  it("stableStringify 键排序/循环引用/边界值一致", () => {
    const circular: Record<string, unknown> = { name: "a", list: [1, { z: 1, y: 2 }] };
    circular.self = circular;
    const cases: unknown[] = [
      { b: 2, a: 1 },
      [3, 1, { z: 1, y: 2 }],
      circular,
      { nested: { d: 4, c: [true, false] } },
      undefined,
      null,
      0,
      NaN,
      "x",
      true
    ];
    for (const input of cases) {
      expect(stableStringify(input)).toBe(server.stableStringify(input));
    }
  });

  it("fingerprintArgs 与 readVersionToken 一致", () => {
    expect(fingerprintArgs({ b: 2, a: 1 })).toBe(server.fingerprintArgs({ a: 1, b: 2 }));
    expect(fingerprintArgs({ a: 1 })).toBe(server.fingerprintArgs({ a: 1 }));
    expect(fingerprintArgs({ a: 1 })).not.toBe(fingerprintArgs({ a: 2 }));
    expect(fingerprintArgs(null)).toBe(server.fingerprintArgs(undefined));
    expect(fingerprintArgs("s")).toBe(server.fingerprintArgs("s"));
    expect(readVersionToken({ version: "v2" })).toBe(server.readVersionToken({ version: "v2" }));
    expect(readVersionToken({ mtime: 123 })).toBe(server.readVersionToken({ mtime: 123 }));
    expect(readVersionToken({ path: "a" })).toBe(server.readVersionToken({ path: "a" }));
    expect(readVersionToken(null)).toBe(server.readVersionToken(null));
    expect(readVersionToken("str")).toBe(server.readVersionToken("str"));
  });

  it("createRunBudget 默认与自定义 limits 一致", () => {
    expect(budgetSnapshot(createRunBudget({ runId: "r1" }))).toEqual(server.budgetSnapshot(server.createRunBudget({ runId: "r1" })));
    const limits = { turnSoft: 3, toolSoft: 2, toolHard: 4, turnHard: 5, repeatLimit: 1, readPollLimit: 2, failureLimit: 1, effectiveSoftMs: 1000, effectiveHardMs: 2000 };
    expect(createRunBudget({ limits }).limits).toEqual(server.createRunBudget({ limits }).limits);
    expect(budgetSnapshot(createRunBudget())).toEqual(server.budgetSnapshot(server.createRunBudget()));
  });

  it("read 同版本轮询放行、超限拦截逐次一致", () => {
    const a = createRunBudget();
    const b = server.createRunBudget();
    const args = { path: "docs/a.md" };
    const ts: unknown[] = [];
    const js: unknown[] = [];
    for (let i = 0; i < 7; i++) {
      ts.push(evaluateToolGate(a, { toolName: "read", args }));
      js.push(server.evaluateToolGate(b, { toolName: "read", args }));
      noteToolResult(a, { toolName: "read", args, ok: true });
      server.noteToolResult(b, { toolName: "read", args, ok: true });
    }
    expect(ts).toEqual(js);
    expect(budgetSnapshot(a)).toEqual(server.budgetSnapshot(b));
  });

  it("read 版本变化放行；write 重复与连续失败拦截一致", () => {
    const a = createRunBudget();
    const b = server.createRunBudget();
    const run = (toolName: string, args: unknown, ok: boolean) => {
      const d1 = evaluateToolGate(a, { toolName, args });
      const d2 = server.evaluateToolGate(b, { toolName, args });
      noteToolResult(a, { toolName, args, ok, error: ok ? "" : "boom" });
      server.noteToolResult(b, { toolName, args, ok, error: ok ? "" : "boom" });
      expect(d1).toEqual(d2);
      return d1;
    };
    run("read", { path: "x.md", version: "v1" }, true);
    run("read", { path: "x.md", version: "v1" }, true);
    run("read", { path: "x.md", version: "v2" }, true);
    run("write", { p: 1 }, true);
    run("write", { p: 1 }, true);
    expect(run("write", { p: 1 }, true)).toMatchObject({ allow: false, code: "REPEAT_NO_PROGRESS", level: "soft" });
    run("bash", { cmd: "x" }, false);
    run("bash", { cmd: "x" }, false);
    expect(run("bash", { cmd: "x" }, false)).toMatchObject({ allow: false, code: "REPEAT_FAILURE", level: "hard" });
    expect(budgetSnapshot(a)).toEqual(server.budgetSnapshot(b));
  });

  it("硬预算（hardStopped/时长）与 grantBudget 重置一致", () => {
    const a = createRunBudget();
    const b = server.createRunBudget();
    a.hardStopped = true;
    b.hardStopped = true;
    expect(evaluateToolGate(a, { toolName: "write", args: {} })).toEqual(server.evaluateToolGate(b, { toolName: "write", args: {} }));
    expect(grantBudget(a, { turns: 10, tools: 5 })).toEqual(server.grantBudget(b, { turns: 10, tools: 5 }));
    expect(evaluateToolGate(a, { toolName: "write", args: {} })).toEqual(server.evaluateToolGate(b, { toolName: "write", args: {} }));
    a.effectiveMs = EFFECTIVE_MS_HARD;
    b.effectiveMs = EFFECTIVE_MS_HARD;
    expect(evaluateToolGate(a, { toolName: "write", args: {} })).toEqual(server.evaluateToolGate(b, { toolName: "write", args: {} }));
    expect(noteWaiting(a, 1000)).toBe(server.noteWaiting(b, 1000));
    expect(noteWaiting(a, -5)).toBe(server.noteWaiting(b, -5));
    expect(noteEffective(a, 500)).toBe(server.noteEffective(b, 500));
    expect(budgetSnapshot(a)).toEqual(server.budgetSnapshot(b));
  });

  it("回合门禁 1..47 全序列一致（软预算一次、硬预算收尾）", () => {
    const a = createRunBudget();
    const b = server.createRunBudget();
    const ts: unknown[] = [];
    const js: unknown[] = [];
    for (let t = 1; t <= 47; t++) {
      expect(noteTurn(a)).toBe(server.noteTurn(b));
      ts.push(evaluateTurnGate(a));
      js.push(server.evaluateTurnGate(b));
    }
    expect(ts).toEqual(js);
    expect(ts[TURN_BUDGET_SOFT - 1]).toMatchObject({ level: "soft", code: "TURN_BUDGET_SOFT" });
    expect(ts[TURN_BUDGET_HARD - 1]).toMatchObject({ level: "hard", code: "TURN_BUDGET_HARD" });
    expect(budgetSnapshot(a)).toEqual(server.budgetSnapshot(b));
  });

  it("自定义 limits 下回合/工具门禁与加预算一致", () => {
    const limits = { turnSoft: 3, turnHard: 5, toolSoft: 2, toolHard: 4 };
    const a = createRunBudget({ limits });
    const b = server.createRunBudget({ limits });
    const ts: unknown[] = [];
    const js: unknown[] = [];
    for (let t = 1; t <= 7; t++) {
      noteTurn(a);
      server.noteTurn(b);
      ts.push(evaluateTurnGate(a));
      js.push(server.evaluateTurnGate(b));
      noteToolResult(a, { toolName: "write", args: { i: t }, ok: true });
      server.noteToolResult(b, { toolName: "write", args: { i: t }, ok: true });
    }
    expect(ts).toEqual(js);
    grantBudget(a, { turns: 2, tools: 2 });
    server.grantBudget(b, { turns: 2, tools: 2 });
    expect(evaluateTurnGate(a)).toEqual(server.evaluateTurnGate(b));
    expect(budgetSnapshot(a)).toEqual(server.budgetSnapshot(b));
  });
});
