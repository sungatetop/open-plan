#!/usr/bin/env node
/**
 * 领域工作流界面接线测试（Qoder 对标 M4.4）。
 *
 * 覆盖两类断言：
 *   1) 「默认关 = 基线不变」不变式：前端门控写法、服务端 404 门控、样式纯追加，
 *      任何一处被误删都会让开关关闭时的行为偏离基线；
 *   2) 跨层字段契约：组件提交的 payload 字段名 == 服务端读取并传给检查器的字段名。
 *
 * 用法：node scripts/workflow-ui-wiring-test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const 读取 = (...段) => fs.readFileSync(path.join(ROOT, ...段), "utf8");

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); } catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
};

const 启动器 = 读取("client", "src", "components", "WorkflowLauncher.jsx");
const 阶段条 = 读取("client", "src", "components", "StageBar.jsx");
const APP = 读取("client", "src", "App.jsx");
const 服务端 = 读取("server", "index.mjs");
const 样式 = 读取("client", "src", "styles.css");
const API = 读取("client", "src", "api.js");

test("组件存在且复用既有只读出入口", () => {
  assert.ok(启动器.includes("listWorkflows"), "启动器未复用 listWorkflows（应读 /api/workflows 的 domain 字段）");
  assert.ok(启动器.includes("preflightDomainWorkflow"), "启动器未调用 preflightDomainWorkflow");
  assert.ok(启动器.includes("阶段条"), "启动器未使用阶段条组件");
  assert.ok(API.includes("/api/domain-workflows/preflight"), "api.js 未封装预检端点");
});

test("阶段条为纯展示：不发起请求、不订阅事件", () => {
  assert.ok(!/fetch\(|api\(|EventSource|useEffect/.test(阶段条), "阶段条不应发起请求或订阅事件");
  for (const 状态 of ["pending", "running", "done", "failed"]) {
    assert.ok(阶段条.includes(状态), `阶段条缺少状态 ${状态}`);
  }
});

test("前端门控：开关关闭时不渲染任何入口", () => {
  const 门控 = APP.match(/flag\("domainWorkflows"\)/g) || [];
  assert.ok(门控.length >= 3, `App.jsx 门控点不足（状态派生 / 顶栏菜单 / 画布页签），实际 ${门控.length}`);
  assert.ok(APP.includes("{workflowsOpen && ("), "缺少受 workflowsOpen 门控的画布页签体");
  assert.ok(
    /const workflowsOpen = flag\("domainWorkflows"\) \? workflowsOpenState : false;/.test(APP),
    "缺少 workflowsOpen 的门控派生写法（关闭时必须恒为 false）",
  );
  assert.ok(APP.includes('setWorkspaceTabPref("workflows")'), "缺少工作流页签激活路径");
  assert.ok(APP.includes("canvas-tab-workflows"), "缺少画布页签样式类");
});

test("服务端门控：开关关闭时端点返回 404（不暴露）", () => {
  assert.ok(服务端.includes('"/api/domain-workflows/preflight"'), "未注册预检端点");
  assert.ok(
    /if \(!RUNTIME_FLAGS\.domainWorkflows\) return res\.status\(404\)/.test(服务端),
    "预检端点缺少开关门控（关闭时必须 404）",
  );
  assert.ok(服务端.includes("跳过校验: req.body?.跳过校验 === true"), "端点未透传「跳过校验」降级分支");
});

test("样式为纯追加：只新增 canvas-tab-workflows / wf-* 选择器", () => {
  const 起点 = 样式.indexOf("M4.4 · 领域工作流面板");
  assert.ok(起点 > 0, "styles.css 缺少 M4.4 追加块");
  // 断言只针对 M4.4 这一个追加块：从它的横幅注释到下一个同级横幅为止。
  // （此前 slice 到文件末尾，会把后续批次追加的独立块也算进来，导致误判"覆盖既有选择器"。）
  const 横幅结束 = 样式.indexOf("*/", 起点);
  assert.ok(横幅结束 > 起点, "M4.4 追加块横幅注释未闭合");
  const 下一块起点 = 样式.indexOf("/* ===", 横幅结束);
  const 追加块 = 样式.slice(起点, 下一块起点 > 0 ? 下一块起点 : 样式.length);
  assert.ok(追加块.includes(".app-canvas-slot.canvas-tab-workflows"), "缺少画布宽度声明");
  // 追加块内不得出现对既有选择器的覆写（只允许 .wf-* 与新页签类）
  const 越界 = [...追加块.matchAll(/^([.#][A-Za-z0-9_-]+)[^{]*\{/gm)]
    .map((m) => m[1])
    .filter((选择器) => !选择器.startsWith(".wf-") && !选择器.includes("canvas-tab-workflows") && !选择器.includes("canvas-body-workflows") && !选择器.includes("app-canvas-slot"));
  assert.deepEqual(越界, [], `追加块覆盖了既有选择器：${越界.join("、")}`);
});

test("跨层字段契约：组件 payload 字段名 == 端点读取字段名", () => {
  const 字段 = ["坐标点", "记录数", "写回", "产物路径"];
  for (const 名 of 字段) {
    assert.ok(启动器.includes(名), `组件未提交字段 ${名}`);
    assert.ok(服务端.includes(`${名}: req.body?.${名}`), `端点未读取字段 ${名}`);
  }
  assert.ok(启动器.includes("workflowId: 当前.id"), "组件未提交 workflowId");
  assert.ok(服务端.includes('req.body?.workflowId'), "端点未读取 workflowId");
});

// 端到端（进程内）断言需要 await，因此放在同步断言之后单独执行并单独计失败。
const 端到端 = async (名字, 函数) => {
  try { await 函数(); console.log(`  ✓ ${名字}`); } catch (error) { failed = 1; console.error(`  ✗ ${名字}: ${error.message}`); }
};

await 端到端("端到端：默认试算输入通过（六个声明中的 OD 需求分析）", async () => {
  const { 取工作流 } = await import("../server/workflow-registry.mjs");
  const { 运行预检 } = await import("../server/workflow-validation.mjs");
  const 工作流 = await 取工作流("od-demand-analysis");
  const 正向 = 运行预检(工作流, {
    坐标点: [{ 经度: 120.1, 纬度: 30.2 }],
    记录数: { 声明数: 1000, 实际数: 1000, 名称: "OD 记录集" },
    写回: { 工具: "officecli", 已确认: false },
    产物路径: "报告/评估.docx",
  });
  assert.equal(正向.ok, true, `默认输入应通过：${正向.摘要}`);
});

await 端到端("端到端：越界输入整体阻断并给出三类事件", async () => {
  const { 取工作流 } = await import("../server/workflow-registry.mjs");
  const { 运行预检 } = await import("../server/workflow-validation.mjs");
  const 工作流 = await 取工作流("od-demand-analysis");
  const 越界 = 运行预检(工作流, {
    坐标点: [{ 经度: 140, 纬度: 30 }],
    记录数: { 声明数: 1000, 实际数: 998, 名称: "OD 记录集" },
    写回: { 工具: "officecli", 已确认: false },
    产物路径: "../escape.docx",
  });
  assert.equal(越界.ok, false);
  assert.deepEqual(
    [...越界.阻断事件].sort(),
    ["artifact_root_violation", "data_integrity_failed", "geo_out_of_range"],
  );
});

console.log(failed ? "\n领域工作流界面接线测试：存在失败" : "\n领域工作流界面接线测试：全部通过");
process.exitCode = failed ? 1 : 0;
