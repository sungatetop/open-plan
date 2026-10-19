#!/usr/bin/env node
/**
 * 对话流单帧体积护栏（Qoder P0-2）测试。
 *
 * 分两块：
 *   1) 纯函数行为（server/stream-connection.mjs）：按字节切分与下发帧序列的正确性
 *      —— 切片上限、多字节字符不被劈开、拼接可还原、边界值（恰好上限 / 上限+1）；
 *   2) 接线不变式：开关默认关 + 基线分支逐字保留、两个 tool_output 埋点都已收口、
 *      事件已登记为「不落盘增量」、前端归约层认增量帧。
 *
 * 用法：node scripts/chat-flow-backpressure-test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { 按字节切分, 工具输出分片, 工具输出帧上限 } from "../server/stream-connection.mjs";
import { RUNTIME_FLAGS as 原始开关, runtimeFlagsSnapshot as 原始快照 } from "../server/feature-flags.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const 读取 = (...段) => fs.readFileSync(path.join(ROOT, ...段), "utf8");

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); } catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
};

const KB = 1024;
const 上限 = 256 * KB;

/* ---------------- 1) 纯函数行为 ---------------- */

test("按字节切分：小文本原样一片；空文本零片", () => {
  assert.deepEqual(按字节切分("hello", 上限), ["hello"]);
  assert.deepEqual(按字节切分("", 上限), []);
  assert.deepEqual(按字节切分(null, 上限), []);
});

test("按字节切分：恰好等于上限不切、上限+1 字节切两片", () => {
  const 恰 = "a".repeat(4 * KB);
  assert.equal(按字节切分(恰, 4 * KB).length, 1, "恰好等于上限不应切分");
  const 超 = "a".repeat(4 * KB + 1);
  const 片 = 按字节切分(超, 4 * KB);
  assert.equal(片.length, 2, "上限+1 应切为两片");
  assert.equal(片.join(""), 超, "拼接必须可还原");
});

test("按字节切分：每片 ≤ 上限，且多字节字符不被劈开", () => {
  // 中文 3 字节/字，构造 ≈1.5 倍上限的内容
  const 中文 = "交通规划".repeat(60 * KB); // 4 字 × 3B = 12B/组
  const 片 = 按字节切分(中文, 上限);
  assert.ok(片.length > 1, "超限内容应被切分");
  for (const 段 of 片) {
    assert.ok(Buffer.byteLength(段, "utf8") <= 上限, "存在超出上限的片段");
    assert.ok(!段.includes("\uFFFD"), "片段含替换字符（多字节被劈开）");
  }
  assert.equal(片.join(""), 中文, "拼接必须逐字还原");
});

test("按字节切分：非法上限回落默认 256 KiB", () => {
  assert.equal(工具输出帧上限(0), 上限);
  assert.equal(工具输出帧上限("abc"), 上限);
  assert.equal(工具输出帧上限(512), 上限, "小于 1 KiB 视为非法");
  assert.equal(工具输出帧上限(2048), 2048);
});

test("工具输出分片：未超限时与基线完全同形（单帧 tool_output 且对象原样）", () => {
  const 载荷 = { toolCallId: "t1", name: "officecli", output: "短输出", replace: false };
  const 帧 = 工具输出分片(载荷, 上限);
  assert.equal(帧.length, 1);
  assert.equal(帧[0].type, "tool_output");
  assert.equal(帧[0].data, 载荷, "未超限必须原样透传（不得复制改写）");
});

test("工具输出分片：超限时首片保留 replace、其余为增量帧，且可还原", () => {
  const 长文本 = "x".repeat(3 * 上限 + 123);
  const 载荷 = { toolCallId: "t2", name: "bash", output: 长文本, replace: true };
  const 帧 = 工具输出分片(载荷, 上限);
  assert.equal(帧[0].type, "tool_output");
  assert.equal(帧[0].data.replace, true, "首片必须保留 replace 语义");
  assert.equal(帧[0].data.toolCallId, "t2");
  assert.ok(帧.length >= 4, `应切为 ≥4 片，实际 ${帧.length}`);
  for (const 项 of 帧.slice(1)) {
    assert.equal(项.type, "tool_output_delta");
    assert.equal(项.data.replace, undefined, "增量帧不得带 replace");
    assert.ok(Buffer.byteLength(项.data.output, "utf8") <= 上限, "增量帧超出上限");
  }
  assert.equal(帧.map((项) => 项.data.output).join(""), 长文本, "全帧拼接必须还原原文");
  assert.deepEqual(帧.slice(1).map((项) => 项.data.index), 帧.slice(1).map((_, i) => i + 1));
});

test("工具输出分片：>2 MB 大输出不抛错、总字节与原文一致（无 OOM 迹象）", () => {
  const 大 = "字".repeat(800 * KB); // ≈2.4 MB（3 字节/字）
  const 帧 = 工具输出分片({ toolCallId: "big", name: "bash", output: 大, replace: false }, 上限);
  const 总字节 = 帧.reduce((和, 项) => 和 + Buffer.byteLength(项.data.output, "utf8"), 0);
  assert.equal(总字节, Buffer.byteLength(大, "utf8"));
  assert.equal(帧.map((项) => 项.data.output).join(""), 大);
});

/* ---------------- 2) 接线不变式 ---------------- */

const AGENT = 读取("server", "agent.mjs");
const 开关 = 读取("server", "feature-flags.mjs");
const 注册表 = 读取("server", "event-registry.mjs");
const CHAT = 读取("client", "src", "components", "ChatPanel.jsx");
const 轨迹 = 读取("client", "src", "run-trace.js");

test("事件注册表：tool_output_delta 已登记为「不落盘、非生命周期」增量", () => {
  const 行 = 注册表.split("\n").find((项) => 项.includes('type: "tool_output_delta"'));
  assert.ok(行, "缺少 tool_output_delta 登记");
  assert.ok(行.includes("lifecycle: false"), "必须是非生命周期增量（可优先淘汰）");
  assert.ok(行.includes("persist: false"), "不得落盘");
});

test("server：tool_output 埋点全部收口到 emitToolOutput（基线分支逐字保留）", () => {
  // 去掉注释行再统计，避免把文档里提到的调用算成真实埋点。
  const 代码 = AGENT.split("\n").filter((行) => !/^\s*(\*|\/\/|\/\*)/.test(行)).join("\n");
  const 直接发出 = 代码.match(/emit\("tool_output",/g) || [];
  assert.equal(直接发出.length, 1, `emit("tool_output") 只应出现在助手的基线分支，实际 ${直接发出.length} 处`);
  assert.equal(代码.match(/emitToolOutput\(emit, \{/g)?.length, 2, "两处埋点都应改为 emitToolOutput");
  assert.ok(/if \(!RUNTIME_FLAGS\.qoderToolOutputSplit\) \{\s*\n\s*emit\("tool_output", payload\);/.test(代码), "缺少开关关闭时的基线分支（必须逐字 emit 原对象）");
});

test("开关：qoderToolOutputSplit 默认关、上限默认 256 KiB 且已下发", () => {
  assert.ok(/qoderToolOutputSplit: readFlag\("OAW_QODER_TOOL_OUTPUT_SPLIT"\)/.test(开关), "缺少 qoderToolOutputSplit");
  assert.ok(开关.includes("qoderToolOutputSplit: RUNTIME_FLAGS.qoderToolOutputSplit,"), "快照未下发 qoderToolOutputSplit");
  assert.ok(/qoderToolOutputFrameMaxBytes: readPositiveInt\("OAW_QODER_TOOL_OUTPUT_FRAME_MAX_BYTES", 256 \* 1024\)/.test(开关), "单帧上限默认值应为 256 KiB");
});

test("前端：归约层把增量帧当 tool_output 处理（共用分支 + 纯追加）", () => {
  assert.ok(CHAT.includes('case "tool_output_delta":'), "ChatPanel 未识别增量帧");
  assert.ok(轨迹.includes('case "tool_output_delta":'), "运行轨迹未识别增量帧");
  // 两条 case 必须是相邻的 fallthrough（共用同一分支体），否则语义会漂移
  assert.ok(/case "tool_output":\s*\n\s*case "tool_output_delta":/.test(CHAT), "ChatPanel 的分支未与 tool_output 合流");
  assert.ok(/case "tool_output":\s*\n\s*case "tool_output_delta": \{/.test(轨迹), "运行轨迹的分支未与 tool_output 合流");
});

test("开关管线（实测）：默认关，且快照如实下发", () => {
  assert.equal(原始开关.qoderToolOutputSplit, false, "不设环境变量时必须为 false（基线）");
  assert.equal(原始快照().qoderToolOutputSplit, false, "快照必须如实反映默认关");
  assert.equal(原始开关.qoderToolOutputFrameMaxBytes, 256 * 1024, "默认单帧上限应为 256 KiB");
});

// 环境变量 → RUNTIME_FLAGS 是「模块加载时解析一次」的约定，因此用带查询串的
// 新模块实例（?fresh=）重新加载，验证 env 到快照的真实管线。
const 端到端 = async (名字, 函数) => {
  try { await 函数(); console.log(`  ✓ ${名字}`); } catch (error) { failed = 1; console.error(`  ✗ ${名字}: ${error.message}`); }
};

await 端到端("开关管线（实测）：OAW_QODER_TOOL_OUTPUT_SPLIT=1 + 自定义上限被正确解析并下发", async () => {
  process.env.OAW_QODER_TOOL_OUTPUT_SPLIT = "1";
  process.env.OAW_QODER_TOOL_OUTPUT_FRAME_MAX_BYTES = "4096";
  const 新 = await import("../server/feature-flags.mjs?fresh=split-probe");
  assert.equal(新.RUNTIME_FLAGS.qoderToolOutputSplit, true, "环境变量应把开关打开");
  assert.equal(新.RUNTIME_FLAGS.qoderToolOutputFrameMaxBytes, 4096, "数值开关应取环境变量值");
  assert.equal(新.runtimeFlagsSnapshot().qoderToolOutputSplit, true, "快照应下发开启态");
  assert.equal(工具输出帧上限(新.RUNTIME_FLAGS.qoderToolOutputFrameMaxBytes), 4096);
  delete process.env.OAW_QODER_TOOL_OUTPUT_SPLIT;
  delete process.env.OAW_QODER_TOOL_OUTPUT_FRAME_MAX_BYTES;
});

console.log(failed ? "\n对话流背压测试：存在失败" : "\n对话流背压测试：全部通过");
process.exitCode = failed ? 1 : 0;
