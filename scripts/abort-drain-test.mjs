#!/usr/bin/env node
/**
 * 中断排空（Qoder P0-3）契约与不变式测试。
 *
 * 覆盖三块：
 *   1) 事件注册表：run_draining 已登记且为生命周期事件；
 *   2) 服务端排空状态机（server/agent.mjs 的 emitAbortedOnce）：开关关闭时逐字走基线的
 *      「立即 aborted」，打开时「先 run_draining → 静默/超窗 → aborted(drained)」，且
 *      幂等令牌保证第二条收尾路径不会重复排空；
 *   3) 前端收尾态（ChatPanel）：收到 run_draining 且开关打开时把状态行切成「正在收尾」，
 *      且不改 runState.status（对账/LIVE_RUN_STATUSES 判定口径不变）。
 *
 * 说明：真实的排空时序需要一次带在途消息的中断（依赖真实模型调用），
 * 因此本脚本按「不变式 + 结构契约」做静态断言；运行时 A/B 由 `OAW_DRAIN_ON_ABORT` 开关实测补充。
 *
 * 用法：node scripts/abort-drain-test.mjs
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

const AGENT = 读取("server", "agent.mjs");
const 开关 = 读取("server", "feature-flags.mjs");
const CHAT = 读取("client", "src", "components", "ChatPanel.jsx");
const 展示 = 读取("client", "src", "event-display.js");

test("事件注册表：run_draining 已登记且为生命周期事件", () => {
  // 用同步静态断言避免顶层 await 干扰；具体注册内容由 test:event-registry 守护。
  const 注册表 = 读取("server", "event-registry.mjs");
  const 行 = 注册表.split("\n").find((item) => item.includes('type: "run_draining"'));
  assert.ok(行, "事件注册表缺少 run_draining");
  assert.ok(行.includes("lifecycle: true"), "run_draining 必须是生命周期事件");
  assert.ok(行.includes("persist: true"), "run_draining 应落盘");
});

test("服务端：开关关闭时逐字走基线「立即 aborted」", () => {
  const 函数体 = AGENT.slice(AGENT.indexOf("function emitAbortedOnce"));
  const 基线分支 = 函数体.indexOf("if (!RUNTIME_FLAGS.qoderDrainOnAbort) {");
  assert.ok(基线分支 > 0, "缺少 qoderDrainOnAbort 的基线分支");
  const 基线片段 = 函数体.slice(基线分支, 基线分支 + 200);
  assert.ok(/emitChannelSafe\(entry, "aborted", \{ runId, reason \}\);/.test(基线片段), "基线分支必须是「立即发 aborted」");
  assert.ok(基线片段.includes("return true;"), "基线分支必须直接返回（不进入排空）");
});

test("服务端：打开时先 run_draining 再 aborted，且顺序不可颠倒", () => {
  const 函数体 = AGENT.slice(AGENT.indexOf("function emitAbortedOnce"));
  const 排空起点 = 函数体.indexOf('emitChannelSafe(entry, "run_draining"');
  assert.ok(排空起点 > 0, "缺少 run_draining 投递");
  const 之后 = 函数体.slice(排空起点);
  const 终态 = 之后.indexOf('emitChannelSafe(entry, "aborted"');
  assert.ok(终态 > 0, "排空后必须在同一分支内发 aborted");
  assert.ok(之后.includes("drained:"), "aborted 必须带 drained 标记（区分是否排空完成）");
});

test("服务端：排空窗口有界（静默阈值 + 上限，均有下限钳制）", () => {
  const 函数体 = AGENT.slice(AGENT.indexOf("function emitAbortedOnce"));
  assert.ok(函数体.includes("RUNTIME_FLAGS.qoderDrainMaxMs"), "缺少排空上限读取");
  assert.ok(函数体.includes("RUNTIME_FLAGS.qoderDrainQuietMs"), "缺少静默阈值读取");
  assert.ok(/Math\.max\(100, Number\(RUNTIME_FLAGS\.qoderDrainMaxMs\) \|\| 1500\)/.test(函数体), "排空上限缺少钳制/默认值");
  assert.ok(/Math\.max\(50, Number\(RUNTIME_FLAGS\.qoderDrainQuietMs\) \|\| 300\)/.test(函数体), "静默阈值缺少钳制/默认值");
  assert.ok(函数体.includes("if (idleFor < drainQuietMs && elapsed < drainMaxMs)"), "缺少静默/超窗判定");
});

test("服务端：幂等令牌在最前面置位（第二条收尾路径不重复排空）", () => {
  const 函数体 = AGENT.slice(AGENT.indexOf("function emitAbortedOnce"));
  const 令牌 = 函数体.indexOf("entry.abortedEmittedRunId = token;");
  const 基线 = 函数体.indexOf("if (!RUNTIME_FLAGS.qoderDrainOnAbort) {");
  assert.ok(令牌 > 0 && 基线 > 0, "缺少幂等令牌或基线分支");
  assert.ok(令牌 < 基线, "幂等令牌必须先于分支置位，否则并发收尾会重复排空");
});

test("开关：qoderDrainOnAbort 默认关，数值位默认 1500 / 300 且已下发", () => {
  assert.ok(/qoderDrainOnAbort: readFlag\("OAW_QODER_DRAIN_ON_ABORT"\)/.test(开关), "缺少 qoderDrainOnAbort 开关");
  assert.ok(开关.includes("qoderDrainOnAbort: RUNTIME_FLAGS.qoderDrainOnAbort,"), "快照未下发 qoderDrainOnAbort");
  assert.ok(/qoderDrainMaxMs: readPositiveInt\("OAW_QODER_DRAIN_MAX_MS", 1500\)/.test(开关), "排空上限默认值应为 1500");
  assert.ok(/qoderDrainQuietMs: readPositiveInt\("OAW_QODER_DRAIN_QUIET_MS", 300\)/.test(开关), "静默阈值默认值应为 300");
});

test("前端：收到 run_draining 且开关打开时显示「正在收尾」", () => {
  assert.ok(CHAT.includes('case "run_draining":'), "ChatPanel 未处理 run_draining");
  const 起 = CHAT.indexOf('case "run_draining":');
  const 止 = CHAT.indexOf('case "', 起 + 10);
  const 片段 = CHAT.slice(起, 止 > 起 ? 止 : 起 + 600);
  assert.ok(片段.includes('flag("qoderDrainOnAbort")'), "前端收尾态必须由开关门控");
  assert.ok(片段.includes("正在收尾"), "缺少「正在收尾」状态文案");
  assert.ok(片段.includes("setAgentPhase"), "收尾态应通过状态行文案（setAgentPhase）表达");
  assert.ok(!片段.includes("setRunState"), "收尾态不得改 runState.status（对账口径必须保持原样）");
  assert.ok(片段.trimEnd().endsWith("break;"), "case 必须以 break 收尾");
});

test("前端：事件时间线保留 run_draining 文案", () => {
  assert.ok(展示.includes('case "run_draining": return "正在收尾'), "事件展示缺少 run_draining 文案");
});

console.log(failed ? "\n中断排空测试：存在失败" : "\n中断排空测试：全部通过");
process.exitCode = failed ? 1 : 0;
