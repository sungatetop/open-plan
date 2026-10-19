#!/usr/bin/env node
/**
 * 领域工作流契约测试（Qoder 对标 §4.1 / §4.2）。
 *
 * 1) 六个交通规划领域工作流声明可加载、字段齐全、id 唯一；
 * 2) 非法声明被 校验工作流() 拒绝并给出明确错误；
 * 3) 工具白名单判定（检查工具权限）生效。
 *
 * 用法：node scripts/workflow-contract-test.mjs
 */
import assert from "node:assert/strict";
import { 列出工作流, 取工作流, 校验工作流, 注册表概览, 已知预检项 } from "../server/workflow-registry.mjs";
import { 检查工具权限 } from "../server/workflow-validation.mjs";

let failed = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
};

const 期望编号 = [
  "od-demand-analysis",
  "road-network-evaluation",
  "accessibility-analysis",
  "standard-compliance-review",
  "report-composition",
  "data-source-onboarding",
];

function 合法声明(覆盖 = {}) {
  return {
    id: "sample-workflow",
    title: "样例工作流",
    description: "仅用于契约测试",
    budget: { maxTurns: 1, maxToolCalls: 1, maxWallMs: 1000 },
    tools: ["read"],
    preflight: ["artifactRoot"],
    stages: [{ id: "only", title: "唯一步骤" }],
    artifacts: [{ id: "out", title: "产物", kind: "doc", required: true }],
    ...覆盖,
  };
}

await test("六个领域工作流全部加载且字段齐全", async () => {
  const 列表 = await 列出工作流();
  assert.equal(列表.length, 6, `声明数量应为 6，实际 ${列表.length}`);
  for (const 声明 of 列表) {
    assert.ok(期望编号.includes(声明.id), `未预期的 id：${声明.id}`);
    assert.ok(声明.title && 声明.description, `${声明.id} 缺少 title/description`);
    for (const 键 of ["maxTurns", "maxToolCalls", "maxWallMs"]) {
      assert.ok(Number.isInteger(声明.budget[键]) && 声明.budget[键] > 0, `${声明.id} budget.${键} 非法`);
    }
    assert.ok(Array.isArray(声明.tools) && 声明.tools.length, `${声明.id} tools 为空`);
    for (const 项 of 声明.preflight) assert.ok(已知预检项.includes(项), `${声明.id} 预检项未知：${项}`);
    assert.ok(声明.stages.length > 0, `${声明.id} 无阶段`);
    assert.ok(声明.artifacts.length > 0, `${声明.id} 无产物契约`);
    for (const 产物 of 声明.artifacts) assert.equal(typeof 产物.required, "boolean", `${声明.id}/${产物.id} required 非布尔`);
  }
});

await test("声明 id 唯一且注册表概览一致", async () => {
  const 概览 = await 注册表概览();
  assert.equal(概览.total, 6);
  assert.equal(new Set(概览.ids).size, 概览.ids.length, "存在重复 id");
  assert.deepEqual([...概览.已知预检项], ["geoRange", "recordCount", "writeBackGuard", "artifactRoot"]);
});

await test("注册表加载期已通过结构校验（自身校验必须 ok）", async () => {
  for (const 声明 of await 列出工作流()) {
    const 结论 = 校验工作流(声明);
    assert.ok(结论.ok, `${声明.id} 未通过校验：${结论.错误.join("；")}`);
  }
});

await test("按 id 取工作流；未命中返回 null", async () => {
  const 命中 = await 取工作流("od-demand-analysis");
  assert.equal(命中.title, "OD 需求分析");
  assert.equal(await 取工作流("不存在的id"), null);
});

await test("阶段 approval 声明正确（规范符合性审查的批注写回需确认）", async () => {
  const 审查 = await 取工作流("standard-compliance-review");
  const 写回 = 审查.stages.find((阶段) => 阶段.id === "write-back");
  assert.equal(写回.approval, true, "批注写回阶段应标记 approval:true");
});

await test("非法声明被拒：缺 title", async () => {
  const 结论 = 校验工作流(合法声明({ title: "" }));
  assert.equal(结论.ok, false);
  assert.ok(结论.错误.some((项) => 项.includes("title")), `错误未指明 title：${结论.错误}`);
});

await test("非法声明被拒：budget 非正整数", async () => {
  const 结论 = 校验工作流(合法声明({ budget: { maxTurns: 0, maxToolCalls: 1, maxWallMs: 1000 } }));
  assert.equal(结论.ok, false);
  assert.ok(结论.错误.some((项) => 项.includes("maxTurns")));
});

await test("非法声明被拒：未知 preflight 检查项", async () => {
  const 结论 = 校验工作流(合法声明({ preflight: ["geoRange", "不存在检查"] }));
  assert.equal(结论.ok, false);
  assert.ok(结论.错误.some((项) => 项.includes("不存在检查")));
});

await test("非法声明被拒：stages / artifacts 重复 id 与未知 kind", async () => {
  const 重复阶段 = 校验工作流(合法声明({ stages: [{ id: "a", title: "甲" }, { id: "a", title: "乙" }] }));
  assert.equal(重复阶段.ok, false);
  const 略图 = 校验工作流(合法声明({ artifacts: [{ id: "x", title: "甲", kind: "未知", required: true }] }));
  assert.equal(略图.ok, false);
  const 重复产物 = 校验工作流(合法声明({ artifacts: [{ id: "x", title: "甲", kind: "doc", required: true }, { id: "x", title: "乙", kind: "doc", required: true }] }));
  assert.equal(重复产物.ok, false);
});

await test("非法声明被拒：非对象输入", async () => {
  assert.equal(校验工作流(null).ok, false);
  assert.equal(校验工作流([]).ok, false);
});

await test("工具白名单判定生效", async () => {
  const 工作流 = await 取工作流("od-demand-analysis");
  assert.equal(检查工具权限(工作流, "map_analyze"), true);
  assert.equal(检查工具权限(工作流, "bash"), false);
  assert.equal(检查工具权限(工作流, ""), false);
});

console.log(failed ? "\n工作流契约测试：存在失败" : "\n工作流契约测试：全部通过");
process.exitCode = failed ? 1 : 0;
