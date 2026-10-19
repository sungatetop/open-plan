#!/usr/bin/env node
/**
 * 子代理契约与流水线事件归约测试（P0-A / P2-A 前端面）。
 * 覆盖：运行轨迹归约器对 §3.4 契约事件（planned/started/progress/result/verified/closed）
 * 与 pipeline_* 事件的聚合、transcript 透传、摘要统计——实时流与回放共用同一归约器。
 *
 * 用法: node scripts/subagent-event-reduction-test.mjs
 * 退出码: 0 = 全部通过, 1 = 有失败
 */
import assert from "node:assert/strict";
import { createRunTrace, applyRunTraceEvent, reduceRunTrace, summarizeRunTrace, runTraceSummaryText } from "../client/src/run-trace.js";

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

let tick = 0;
const ev = (type, data) => ({ type, data, at: new Date(Date.parse("2026-10-15T10:00:00.000Z") + (tick += 1) * 1000).toISOString() });

console.log("\n▶ §3.4 契约事件聚合");
test("planned→started→progress→result→closed 合成一条子代理记录", () => {
  const trace = createRunTrace("run1");
  applyRunTraceEvent(trace, ev("subagent_planned", { childId: "s1", parentToolCallId: "tc1", role: "worker", task: "统计人口", tools: ["read", "write"] }));
  applyRunTraceEvent(trace, ev("subagent_started", { childId: "s1", parentToolCallId: "tc1", role: "worker" }));
  applyRunTraceEvent(trace, ev("subagent_progress", { childId: "s1", phase: "对抗式核验中", activity: "核验执行结论" }));
  applyRunTraceEvent(trace, ev("subagent_result", { childId: "s1", status: "completed", output: "约 120 万", artifacts: ["结果.md"], toolStats: { rounds: 1 } }));
  applyRunTraceEvent(trace, ev("subagent_closed", { childId: "s1", finalStatus: "completed" }));
  assert.equal(trace.subagents.length, 1);
  const sub = trace.subagents[0];
  assert.equal(sub.id, "s1");
  assert.equal(sub.parentToolCallId, "tc1");
  assert.equal(sub.role, "worker");
  assert.equal(sub.task, "统计人口");
  assert.equal(sub.status, "completed");
  assert.equal(sub.activity, "对抗式核验中");
  assert.equal(sub.summary, "约 120 万");
  assert.deepEqual(sub.artifacts, ["结果.md"]);
});
test("verified 附带判定与检查清单；revise 不改写终态", () => {
  const trace = createRunTrace();
  applyRunTraceEvent(trace, ev("subagent_planned", { childId: "s2", role: "worker", task: "t" }));
  applyRunTraceEvent(trace, ev("subagent_verified", { childId: "s2", verdict: "revise", checklist: [{ item: "数据来源", ok: false }, { item: "结论一致", ok: true }], notes: "补数据" }));
  const sub = trace.subagents[0];
  assert.equal(sub.verdict, "revise");
  assert.equal(sub.checklist.length, 2);
  assert.equal(sub.checklist[0].ok, false);
  assert.equal(sub.verifyNotes, "补数据");
  assert.equal(sub.status, "planned", "verified 不应改写子代理状态");
});
test("planned 先行时状态推进 planned→running；工具白名单预填", () => {
  const trace = createRunTrace();
  applyRunTraceEvent(trace, ev("subagent_planned", { childId: "s3", tools: ["read", "grep"] }));
  assert.equal(trace.subagents[0].status, "planned");
  assert.deepEqual(trace.subagents[0].tools.map((tool) => tool.name), ["read", "grep"]);
  applyRunTraceEvent(trace, ev("subagent_started", { childId: "s3" }));
  assert.equal(trace.subagents[0].status, "running");
});
test("旧版 subagent_start/update/end 事件仍兼容，end 透传 transcript", () => {
  const trace = createRunTrace();
  applyRunTraceEvent(trace, ev("subagent_start", { childId: "s4", role: "scout", task: "读资料" }));
  applyRunTraceEvent(trace, ev("subagent_update", { childId: "s4", activity: "正在读取", preview: "内容…" }));
  applyRunTraceEvent(trace, ev("subagent_end", { childId: "s4", status: "completed", summary: "结论", transcript: [{ kind: "text", text: "结论" }] }));
  const sub = trace.subagents[0];
  assert.equal(sub.status, "completed");
  assert.equal(sub.activity, "正在读取");
  assert.equal(sub.transcript.length, 1);
  assert.equal(sub.transcript[0].kind, "text");
});
test("subagent_tool 按 toolCallId 去重（G3）", () => {
  const trace = createRunTrace();
  applyRunTraceEvent(trace, ev("subagent_start", { childId: "s5" }));
  applyRunTraceEvent(trace, ev("subagent_tool", { childId: "s5", toolCallId: "t9", toolName: "read", status: "start" }));
  applyRunTraceEvent(trace, ev("subagent_tool", { childId: "s5", toolCallId: "t9", toolName: "read", status: "end", isError: false }));
  applyRunTraceEvent(trace, ev("subagent_tool", { childId: "s5", toolCallId: "t9", toolName: "read", status: "end", isError: false }));
  const sub = trace.subagents[0];
  assert.equal(sub.tools.length, 1, "同一子 toolCallId 不应重复建条");
  assert.equal(sub.tools[0].status, "done");
});
test("缺失 childId 时用 parentToolCallId 兜底聚合（回放安全）", () => {
  const trace = createRunTrace();
  applyRunTraceEvent(trace, ev("subagent_start", { parentToolCallId: "only-key", role: "scout" }));
  applyRunTraceEvent(trace, ev("subagent_end", { parentToolCallId: "only-key", status: "completed" }));
  assert.equal(trace.subagents.length, 1);
  assert.equal(trace.subagents[0].id, "only-key");
});

console.log("\n▶ pipeline_* 事件归约（§5.2 阶段条）");
test("started→stage*→finished 重建阶段条，revise 复渲染同阶段只更新状态", () => {
  const trace = reduceRunTrace([
    ev("pipeline_started", { pipelineId: "p1", format: "pptx", deliverable: "汇报.pptx" }),
    ev("pipeline_stage_started", { pipelineId: "p1", stage: "planner", label: "规划结构" }),
    ev("pipeline_stage_finished", { pipelineId: "p1", stage: "planner", status: "done", artifact: ".pipeline/汇报.outline.json" }),
    ev("pipeline_stage_started", { pipelineId: "p1", stage: "formatter", label: "排版生成" }),
    ev("pipeline_stage_finished", { pipelineId: "p1", stage: "formatter", status: "done" }),
    ev("pipeline_stage_finished", { pipelineId: "p1", stage: "evaluator", status: "revise", issues: ["章节未覆盖"] }),
    ev("pipeline_stage_finished", { pipelineId: "p1", stage: "formatter", status: "done" }),
    ev("pipeline_stage_finished", { pipelineId: "p1", stage: "evaluator", status: "done", checks: ["章节覆盖 3/3"] }),
    ev("pipeline_finished", { pipelineId: "p1", status: "completed", deliverable: "汇报.pptx" }),
  ]);
  assert.ok(trace.pipeline, "pipeline 应被重建");
  assert.equal(trace.pipeline.status, "completed");
  assert.equal(trace.pipeline.deliverable, "汇报.pptx");
  const stages = trace.pipeline.stages;
  assert.equal(stages.length, 3, "planner/formatter/evaluator 三个阶段（formatter 复用同一条）");
  assert.equal(stages.find((s) => s.stage === "formatter").status, "done");
  assert.equal(stages.find((s) => s.stage === "evaluator").status, "done");
  assert.equal(stages.find((s) => s.stage === "evaluator").checks.length, 1);
});
test("pipeline 未开始时 stage 事件自建容器（乱序回放安全）", () => {
  const trace = createRunTrace();
  applyRunTraceEvent(trace, ev("pipeline_stage_finished", { stage: "planner", status: "done" }));
  assert.ok(trace.pipeline);
  assert.equal(trace.pipeline.stages[0].status, "done");
});
test("摘要统计包含子代理与流水线", () => {
  const trace = reduceRunTrace([
    ev("subagent_planned", { childId: "a", role: "scout" }),
    ev("subagent_started", { childId: "a" }),
    ev("subagent_planned", { childId: "b", role: "worker" }),
    ev("pipeline_started", { pipelineId: "p" }),
  ]);
  const stats = summarizeRunTrace(trace);
  assert.equal(stats.subagentTotal, 2);
  assert.equal(stats.subagentRunning, 2);
  assert.equal(stats.pipelineRunning, true);
  assert.match(runTraceSummaryText(trace), /子 Agent 2（2 进行中）/);
});

console.log(failed ? "\n子代理事件归约测试：存在失败" : "\n子代理事件归约测试：全部通过");
process.exit(failed);
