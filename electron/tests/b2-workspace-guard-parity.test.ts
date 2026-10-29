/**
 * B2-8 workspace-guard 域：isToolGateRejection（装配绑定面纯函数）行为锚点。
 *
 * R6-7a 对拍退役改写：旧侧 server/pi-extensions/workspace-guard.mjs 物理路径
 * 动态 import 随 server/ 退役删除（等价性已在 B2-8 批对拍验收冻结），保留
 * 新侧绝对期望值断言。扩展工厂 workbenchGateExtension 不在装配绑定面。
 */
import { describe, expect, it } from "vitest";
import * as modern from "../src/main/backend/workspace-guard";

describe("B2-8 workspace-guard：isToolGateRejection", () => {
  it("含 [工具门禁] 标记（开头/中间）→ true", () => {
    expect(modern.isToolGateRejection("[工具门禁] GATE_BLOCKED：命中硬预算")).toBe(true);
    expect(modern.isToolGateRejection("工具失败 [工具门禁] TOOL_LOOP：连续失败")).toBe(true);
  });

  it("不含标记/部分标记 → false", () => {
    expect(modern.isToolGateRejection("普通工具执行失败")).toBe(false);
    expect(modern.isToolGateRejection("[工具门")).toBe(false);
    expect(modern.isToolGateRejection("")).toBe(false);
  });

  it("非字符串输入（null/undefined/数字/对象）→ false", () => {
    expect(modern.isToolGateRejection(null)).toBe(false);
    expect(modern.isToolGateRejection(undefined)).toBe(false);
    expect(modern.isToolGateRejection(123)).toBe(false);
    expect(modern.isToolGateRejection({ reason: "[工具门禁]" })).toBe(false);
  });
});
