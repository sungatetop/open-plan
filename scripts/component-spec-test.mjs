#!/usr/bin/env node
/**
 * §3.3 组件交互规范（Qoder 对标）· opt-in 层守护。
 *
 * 报告 §3.3 让「执行流状态点 / 思考块竖线 / 工具卡片本体 / HITL 形态 / 动效 token」统一到
 * 一套规范。本项目把这些全部落进 `:root[data-oaw-style="qoder"]` 作用域（由既有开关
 * qoderStyle / OAW_QODER_STYLE 控制，默认关），因此本测试守护三件事：
 *   1) 作用域纪律：本段每一条选择器都必须带 `:root[data-oaw-style="qoder"]` 前缀，
 *      否则关闭开关时基线外观会被改动；且本段不得再写一行裸的 `:root[data-oaw-style="qoder"] {`
 *      （会抢在令牌块之前被 :root[data-oaw-style="qoder"] { 的 indexOf 命中，破坏令牌层解析）。
 *   2) 规范到位：状态点五态、思考块 2px/22%、工具卡片中性本体 + 左 3px 边条、审批红描边、
 *      动效 token 暗亮同值。
 *   3) 不破坏既有：基线里工具卡片的状态底色与状态点配色逐字仍在（关闭开关 = 原样），
 *      新增的持续动画已纳入统一动效闸门且定义在闸门之前。
 *
 * 用法：node scripts/component-spec-test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const 样式 = fs.readFileSync(path.join(ROOT, "client", "src", "styles.css"), "utf8");

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); } catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
};

const 段标记 = "§3.3 组件交互规范";
const 闸门标记 = "P3 · 统一动效闸门与一次性反馈";
const 段起 = 样式.indexOf(段标记);
const 闸门起 = 样式.indexOf(闸门标记);
assert.ok(段起 > 0, "styles.css 缺少 §3.3 组件交互规范段落");
assert.ok(闸门起 > 段起, "§3.3 段落必须排在统一动效闸门之前（否则闸门无法用 !important 覆盖其动效）");

const 段 = 样式.slice(段起, 闸门起);
const 段去注释 = 段.replace(/\/\*[\s\S]*?\*\//g, "");
const 规则 = [];
for (const m of 段去注释.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const 选择器 = m[1].replace(/\s+/g, " ").trim();
  if (选择器) 规则.push({ 选择器, 声明: m[2].replace(/\s+/g, " ").trim() });
}
const 取规则 = (选择器含) => 规则.filter((r) => r.选择器.includes(选择器含));
const 取声明 = (选择器含, 属性) => {
  const 命中 = 取规则(选择器含).find((r) => new RegExp(`(^|;)\\s*${属性}\\s*:`).test(r.声明));
  return 命中 ? 命中.声明.match(new RegExp(`(?:^|;)\\s*${属性}\\s*:\\s*([^;]+)`))[1].trim() : null;
};

/* ---------------- 1) 作用域纪律 ---------------- */

test("§3.3 段落每条选择器都限定在 :root[data-oaw-style=\"qoder\"] 作用域内", () => {
  assert.ok(规则.length >= 10, `§3.3 段落解析出的规则过少：${规则.length}`);
  for (const r of 规则) {
    assert.ok(
      r.选择器.includes(':root[data-oaw-style="qoder"]'),
      `选择器未限定作用域（关闭开关后会改到基线）：${r.选择器}`,
    );
  }
});

test("§3.3 段落不出现裸的 :root[data-oaw-style=\"qoder\"] { 声明块（避免抢在令牌块之前被解析）", () => {
  const 首个 = 样式.indexOf(':root[data-oaw-style="qoder"] {');
  assert.ok(首个 > 闸门起, `首个裸块出现在 ${首个}，应仍是文末令牌块（> ${闸门起}）`);
});

test("§3.3 段落内不新增硬编码色值（只能用令牌 / color-mix）", () => {
  const 命中 = 段.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  assert.deepEqual(命中, [], `§3.3 段落里出现了硬编码色值：${命中.join("、")}`);
});

/* ---------------- 2) 规范到位 ---------------- */

test("① 执行流状态点五态齐全，运行态为强调蓝 + 呼吸动画", () => {
  for (const 态 of ["running", "success", "warning", "error"]) {
    assert.ok(
      取声明(`.execution-flow-item.${态} .execution-flow-dot`, "background"),
      `缺少 .execution-flow-item.${态} 的状态点配色`,
    );
  }
  assert.equal(取声明(".execution-flow-item.running .execution-flow-dot", "background"), "var(--accent)");
  const 动画 = 取声明(".execution-flow-item.running .execution-flow-dot", "animation") || "";
  assert.match(动画, /dot-breathe-soft/, "运行态应复用既有呼吸关键帧 dot-breathe-soft");
  assert.match(动画, /infinite/, "运行态呼吸应为持续动画（并已纳入统一闸门）");
  assert.equal(取声明(".execution-flow-item.success .execution-flow-dot", "background"), "var(--success)");
  assert.equal(取声明(".execution-flow-item.error .execution-flow-dot", "background"), "var(--error)");
  assert.equal(取声明(".execution-flow-dot", "background"), "var(--op-gray-600)", "无状态兜底应为中性灰");
});

test("② 思考块左竖线 2px + 强调色 22%，hover 提到 45%", () => {
  const 宽 = 取声明(".thinking-block", "border-left-width");
  assert.equal(宽, "2px", `思考块竖线应为 2px，实际 ${宽}`);
  const 色 = 取声明(".thinking-block", "border-left-color") || "";
  assert.match(色, /color-mix\(in srgb, var\(--accent\) 22%, transparent\)/, `竖线应为 accent 22%：${色}`);
  assert.ok(取声明(".thinking-block:hover", "border-left-color"), "hover 应保留可见反馈");
});

test("③ 工具卡片本体中性 + 左 3px 状态边条", () => {
  for (const 态 of ["pending", "success", "error"]) {
    assert.equal(取声明(`.tool-card.${态}`, "background"), "var(--panel2-bg)", `.tool-card.${态} 本体应中性`);
    const 边 = 取声明(`.tool-card.${态}`, "border-left") || "";
    assert.match(边, /^3px solid var\(--(warning|success|error)\)$/, `.tool-card.${态} 左边条异常：${边}`);
  }
});

test("④ HITL：审批卡左侧强调条 + 拒绝按钮红描边（非实心块）", () => {
  assert.ok(取声明(".approval-block", "border-left"), "审批卡应有左侧形态条");
  assert.equal(取声明(".approval-deny", "background"), "transparent", "拒绝按钮应为描边而非实心块");
  const 边 = 取声明(".approval-deny", "border-color") || "";
  assert.match(边, /var\(--error\)/, `拒绝按钮应有红色描边：${边}`);
});

test("⑥ 动效 token 暗/亮 opt-in 同值齐全（120/200/320ms + ease-out）", () => {
  const 暗块 = 样式.slice(样式.indexOf(':root[data-oaw-style="qoder"] {'), 样式.indexOf('[data-theme="light"][data-oaw-style="qoder"] {'));
  const 亮块 = 样式.slice(样式.indexOf('[data-theme="light"][data-oaw-style="qoder"] {'), 样式.indexOf(':root[data-oaw-style="qoder"] body'));
  const 读 = (块, 名) => (块.match(new RegExp(`${名}\\s*:\\s*([^;]+);`)) || [])[1]?.trim();
  for (const [名, 期望] of [["--dur-fast", "120ms"], ["--dur-base", "200ms"], ["--dur-slow", "320ms"]]) {
    assert.equal(读(暗块, 名), 期望, `暗色 opt-in 的 ${名} 应为 ${期望}`);
    assert.equal(读(亮块, 名), 期望, `亮色 opt-in 的 ${名} 应为 ${期望}`);
  }
  assert.match(读(暗块, "--ease-out") || "", /^cubic-bezier\(/, "--ease-out 应为贝塞尔曲线");
  assert.equal(读(暗块, "--ease-out"), 读(亮块, "--ease-out"), "--ease-out 暗亮应同值");
});

/* ---------------- 3) 不破坏既有 ---------------- */

test("新增持续动画已纳入统一动效闸门，且定义在闸门之前", () => {
  const 宿主 = ".execution-flow-item.running .execution-flow-dot";
  assert.ok(样式.indexOf(宿主) < 闸门起, "宿主定义应在闸门之前");
  const 闸门 = 样式.slice(闸门起);
  assert.ok(闸门.includes(宿主), "闸门（data-reduce-motion / data-motion-level=off）清单应包含该宿主");
  assert.match(闸门, /animation: none !important/, "闸门应用 !important 压过本层动效");
});

test("关闭开关即为基线：工具卡片状态底色与状态点配色逐字仍在", () => {
  for (const 行 of [
    ".tool-card.pending { background: var(--tool-pending); border-color: #3a4a5c; }",
    ".tool-card.success { background: var(--tool-success); border-color: #2a4a2a; }",
    ".tool-card.error { background: var(--tool-error); border-color: #5a2a2a; }",
    ".tool-card.pending { border-left: 3px solid var(--warning); }",
    ".tool-card.success { border-left: 3px solid var(--success); }",
    ".tool-card.error { border-left: 3px solid var(--error); }",
    ".execution-flow-dot { width: 6px; height: 6px; flex: 0 0 auto; border-radius: 50%; background: var(--warning); }",
    ".thinking-block:hover { border-left-color: var(--accent); }",
  ]) {
    assert.ok(样式.includes(行), `基线规则被改动或丢失：${行}`);
  }
  const 基线段 = 样式.slice(0, 段起);
  assert.ok(!基线段.includes(':root[data-oaw-style="qoder"] .tool-card'), "§3.3 规则不得出现在段落之外");
});

console.log(failed ? "\n组件交互规范（§3.3）测试：存在失败" : "\n组件交互规范（§3.3）测试：全部通过");
process.exitCode = failed ? 1 : 0;
