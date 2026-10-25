/**
 * B2-8 workspace-guard 域对拍：isToolGateRejection（装配绑定面纯函数）。
 *
 * 旧模块 pi-extensions/workspace-guard.mjs 顶层 import run-budget.mjs（纯函数库、
 * 模块级无状态无 IO）→ 动态加载安全、无 env 锚点 → 免 stubEnv 简化形态（B2-5 起
 * 同型）：旧侧物理路径动态 import + 新侧静态 import，逐用例同入参双侧执行 toEqual
 * + 绝对断言锚定。扩展工厂 workbenchGateExtension 不在装配绑定面，不迁移不对拍。
 */
import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as modern from "../src/main/backend/workspace-guard";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "../..");

const legacy = (await import(
  pathToFileURL(path.join(PROJECT_ROOT, "server", "pi-extensions", "workspace-guard.mjs")).href
)) as unknown as typeof modern;

describe("B2-8 对拍：isToolGateRejection", () => {
  /** 同入参双侧执行 + 比对，返回新侧结果。 */
  function both(text: unknown): boolean {
    const oldOut = legacy.isToolGateRejection(text);
    const newOut = modern.isToolGateRejection(text);
    expect(newOut).toBe(oldOut);
    return newOut;
  }

  it("含 [工具门禁] 标记（开头/中间）→ true", () => {
    expect(both("[工具门禁] GATE_BLOCKED：命中硬预算")).toBe(true);
    expect(both("工具失败 [工具门禁] TOOL_LOOP：连续失败")).toBe(true);
  });

  it("不含标记/部分标记 → false", () => {
    expect(both("普通工具执行失败")).toBe(false);
    expect(both("[工具门")).toBe(false);
    expect(both("")).toBe(false);
  });

  it("非字符串输入（null/undefined/数字/对象）→ false", () => {
    expect(both(null)).toBe(false);
    expect(both(undefined)).toBe(false);
    expect(both(123)).toBe(false);
    expect(both({ reason: "[工具门禁]" })).toBe(false);
  });
});
