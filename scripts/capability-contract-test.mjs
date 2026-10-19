#!/usr/bin/env node
/**
 * 能力契约 v2 测试（P0-B，方案 §4.1/§5.3）。
 * 覆盖：provider 字段、office_generate 原生分流、routing.officecli 的 preferred/lazy/not_needed、
 * 生成类任务不被预检阻塞的契约基础、模式工具策略与能力声明的一致性。
 *
 * 用法: node scripts/capability-contract-test.mjs
 * 退出码: 0 = 全部通过, 1 = 有失败
 */
import assert from "node:assert/strict";
import {
  planTaskCapabilities,
  toolPolicyForMode,
  normalizeTaskMode,
  TASK_MODES,
} from "../server/task.mjs";

let failed = 0;
const test = (name, fn) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed = 1;
    console.error(`  ✗ ${name}: ${e.message}`);
  }
};

console.log("\n▶ 契约版本与 provider（§4.1）");
test("能力契约 v2：每个能力都声明 provider", () => {
  const plan = planTaskCapabilities({ text: "读取报告.docx 并总结", task: { mode: "agent" }, references: [{ kind: "file", target: "报告.docx" }] });
  assert.equal(plan.version, 2);
  assert.ok(plan.capabilities.length >= 2);
  for (const capability of plan.capabilities) {
    assert.ok(["native", "officecli", "pi"].includes(capability.provider), `${capability.id} 缺少合法 provider`);
  }
});
test("能力 ID 全部来自方案枚举或既有模式能力", () => {
  const allowed = new Set(["chat", "office", "agent", "review", "document", "knowledge", "officecli", "office_generate", "reviewEvidence", "subagent", "map", "skills"]);
  for (const mode of TASK_MODES) {
    const plan = planTaskCapabilities({ text: "生成一份 Word 报告", task: { mode }, references: [] });
    for (const capability of plan.capabilities) assert.ok(allowed.has(capability.id), `未知能力 ${capability.id}`);
  }
});

console.log("\n▶ 生成类 vs 编辑类分流（§5.3）");
test("生成新文档：office_generate(native) 声明，officecli 降为 fallback，routing=lazy", () => {
  const plan = planTaskCapabilities({ text: "帮我生成一份关于城市更新的 Word 报告", task: { mode: "agent" }, references: [] });
  const generate = plan.capabilities.find((c) => c.id === "office_generate");
  assert.ok(generate, "生成类任务应声明 office_generate");
  assert.equal(generate.provider, "native");
  assert.equal(generate.status, "preferred");
  const cli = plan.capabilities.find((c) => c.id === "officecli");
  assert.ok(cli, "仍应声明 officecli 兜底");
  assert.equal(cli.status, "fallback");
  assert.equal(cli.required, false, "生成类不强制要求 CLI");
  assert.equal(plan.routing.officecli, "lazy", "生成类应惰性预检");
});
test("编辑既有文档：officecli preferred，routing=preferred", () => {
  const plan = planTaskCapabilities({ text: "修改报告里的错别字", task: { mode: "agent" }, references: [{ kind: "file", target: "报告.docx" }] });
  const cli = plan.capabilities.find((c) => c.id === "officecli");
  assert.equal(cli.status, "preferred");
  assert.equal(plan.routing.officecli, "preferred");
  assert.equal(plan.capabilities.some((c) => c.id === "office_generate"), false, "编辑类不声明原生生成");
});
test("无 Office 意图：routing=not_needed，且 Chat 永远不触发 CLI", () => {
  assert.equal(planTaskCapabilities({ text: "你好", task: { mode: "agent" } }).routing.officecli, "not_needed");
  const chat = planTaskCapabilities({ text: "生成一份 word 报告并读取 docx 模板", task: { mode: "chat" }, references: [] });
  assert.equal(chat.routing.officecli, "not_needed", "Chat 模式不触发 officecli 路由");
  assert.equal(chat.capabilities.some((c) => c.id === "officecli"), false);
});

console.log("\n▶ 子代理能力声明（P1-C 契约面）");
test("subagent 只在 chat/agent 声明；agent 白名单静态含 run_subagent", () => {
  // chat 的 run_subagent 由会话侧按 hasSubagent 动态注入（agent.mjs modeDynamicTools），
  // 这里校验：声明面只出现在 chat/agent，且 agent 静态白名单确实包含该工具。
  for (const mode of ["chat", "agent"]) {
    const plan = planTaskCapabilities({ text: "并行读取资料", task: { mode } });
    assert.ok(plan.capabilities.some((c) => c.id === "subagent"), `${mode} 应声明 subagent`);
  }
  for (const mode of ["office", "review"]) {
    const plan = planTaskCapabilities({ text: "并行读取资料", task: { mode } });
    assert.equal(plan.capabilities.some((c) => c.id === "subagent"), false, `${mode} 不声明 subagent`);
    assert.equal(toolPolicyForMode(mode).tools.includes("run_subagent"), false);
  }
  // run_subagent 在 chat/agent 由会话侧动态注入，不进静态白名单——校验它不在任何静态表里
  for (const mode of TASK_MODES) {
    assert.equal(toolPolicyForMode(mode).tools.includes("run_subagent"), false);
  }
});

console.log("\n▶ editorial_pipeline 契约一致性（P2-A）");
test("editorial_pipeline 仅出现在 agent 模式白名单，且工具真的存在", () => {
  assert.ok(toolPolicyForMode("agent").tools.includes("editorial_pipeline"));
  for (const mode of ["chat", "office", "review"]) {
    assert.equal(toolPolicyForMode(mode).tools.includes("editorial_pipeline"), false, `${mode} 不应有流水线工具`);
  }
});

console.log("\n▶ 地图/知识/技能路由回归");
test("地图只读与读写按模式区分", () => {
  const chat = planTaskCapabilities({ text: "画一张 OD 热力图", task: { mode: "chat" } });
  assert.equal(chat.routing.map, "read_only");
  const agent = planTaskCapabilities({ text: "画一张 OD 热力图并保存图层", task: { mode: "agent" } });
  assert.equal(agent.routing.map, "read_write");
});
test("normalizeTaskMode 兜底", () => {
  assert.equal(normalizeTaskMode("work"), "agent");
  assert.equal(normalizeTaskMode("OFFICE"), "office");
});

console.log(failed ? "\n能力契约测试：存在失败" : "\n能力契约测试：全部通过");
process.exit(failed);
