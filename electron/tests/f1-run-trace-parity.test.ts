import { describe, it, expect } from "vitest";
import {
  COMPLETION_LABELS, PHASE_LABELS, PHASE_ORDER,
  completionLabel, createRunTrace, applyRunTraceEvent, reduceRunTrace, summarizeRunTrace,
  reduceTurnMetrics, summarizeTurnMetrics, formatTokenCount, turnMetricsText, formatDuration,
  runTraceProgressText, verificationLabel, runToolDetailText, runTraceSummaryText,
  type RunTrace,
} from "../src/renderer/lib/run-trace";

const clientModule = await import("../../client/src/run-trace.js");
const client = clientModule as any;

/** 固定时间轴：所有事件带显式 at，避免两侧 Date.now() 漂移 */
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

function ev(type: string, data: unknown = {}, seconds = 0, extra: Record<string, unknown> = {}) {
  return { type, data, at: at(seconds), ...extra };
}

describe("run-trace(client) TS 版与 client 版等价（对拍）", () => {
  it("常量表与基础函数", () => {
    expect(COMPLETION_LABELS).toEqual(client.COMPLETION_LABELS);
    expect(PHASE_LABELS).toEqual(client.PHASE_LABELS);
    expect([...PHASE_ORDER]).toEqual([...client.PHASE_ORDER]);
    for (const status of ["success", "partial", "blocked", "failed", "cancelled", "unknown", "", 42, null, undefined, { a: 1 }]) {
      expect(completionLabel(status)).toBe(client.completionLabel(status));
    }
    expect(createRunTrace()).toEqual(client.createRunTrace());
    expect(createRunTrace("run-1")).toEqual(client.createRunTrace("run-1"));
  });

  it("生命周期事件：run_admitting/turn_started/steer/capability_plan/mode_policy/todo_updated", () => {
    const events = [
      ev("run_admitting", {}, 0),
      ev("turn_started", {}, 1),
      ev("steer", { source: "turn-progress", message: "正在检索资料", turnCount: 1 }, 2),
      ev("steer", { source: "turn-budget:warn", message: "轮次预算告警", turnCount: 2 }, 3),
      ev("steer", { source: "user", message: "用户插话不进 notes" }, 4),
      ev("steer", { message: "缺 source 视为 user" }, 5),
      ev("capability_plan", {}, 6),
      ev("mode_policy", {}, 7),
      ev("todo_updated", { items: [{ id: "t1", title: "第一步", status: "completed" }, { title: "第二步" }, null, "raw"] }, 8),
      ev("todo_updated", { items: [] }, 9),
    ];
    const d = reduceRunTrace(events, "run-a");
    const s = client.reduceRunTrace(events, "run-a");
    expect(d).toEqual(s);
    expect(d.turns).toBe(1);
    expect(d.notes).toHaveLength(2);
    expect(d.todos).toEqual([]);
  });

  it("工具轨迹：tool_start/output/delta/end（replace、追加、对象 result、start 丢失恢复）", () => {
    const events = [
      ev("tool_start", { toolCallId: "c1", name: "read", input: { path: "a.txt" } }, 0),
      ev("tool_start", { toolCallId: "c1", name: "read" }, 1), // 重复 start 不新建
      ev("tool_output", { toolCallId: "c1", output: "第一段" }, 2),
      ev("tool_output", { toolCallId: "c1", output: "第二段", replace: true }, 3),
      ev("tool_output_delta", { toolCallId: "c1", text: "增量" }, 4),
      ev("tool_output", { toolCallId: "c1", output: { json: true } }, 5),
      ev("tool_output", { toolCallId: "missing", output: "孤儿输出" }, 6),
      ev("tool_end", { toolCallId: "c1", isError: false, result: { ok: 1 } }, 7),
      ev("tool_start", { name: "bash" }, 8), // 无 toolCallId
      ev("tool_end", { name: "bash", isError: true, result: "boom" }, 9),
      ev("tool_end", { toolCallId: "lost", name: "grep", isError: false, result: "x" }, 10), // start 丢失
      ev("tool_end", { toolCallId: "c1", isError: false }, 11), // 重复 end：duration 基于原 startAt
    ];
    const d = reduceRunTrace(events);
    const s = client.reduceRunTrace(events);
    expect(d).toEqual(s);
    expect(d.tools).toHaveLength(3);
    expect(d.tools[0]).toMatchObject({ status: "done", isError: false, duration: 11 }); // 重复 end 以最新 endAt 计时长
    expect(d.tools[1]).toMatchObject({ name: "bash", isError: true, toolCallId: null });
    expect(d.tools[2]).toMatchObject({ toolCallId: "lost", startMissing: true });
  });

  it("子代理全生命周期：planned/start/progress/tool/result/verified/closed", () => {
    const events = [
      ev("subagent_planned", { childId: "s1", role: "scout", task: "调研", tools: ["read", "grep"] }, 0),
      ev("subagent_started", { childId: "s1" }, 1),
      ev("subagent_progress", { childId: "s1", activity: "检索中", phase: "search", thinking: "思考内容", preview: "预览" }, 2),
      ev("subagent_tool", { childId: "s1", toolCallId: "st1", toolName: "read", status: "start" }, 3),
      ev("subagent_tool", { childId: "s1", toolCallId: "st1", status: "end", isError: true }, 4),
      ev("subagent_result", { childId: "s1", status: "completed", output: "结论", artifacts: [{ path: "out.md" }, "raw.txt", 42, null], toolStats: { read: 2 }, transcript: [{ i: 1 }, { i: 2 }] }, 5),
      ev("subagent_verified", { childId: "s1", verdict: "通过", checklist: [{ item: "要点1", ok: true }, { item: "要点2", ok: false }, "原始串", null, { ok: false }], notes: "备注" }, 6),
      ev("subagent_closed", { childId: "s1", finalStatus: "completed" }, 7),
      // 缺 childId 用 parentToolCallId 兜底 + verified 乱序新建（status null 透传）
      ev("subagent_end", { parentToolCallId: "pt9", status: "failed", summary: "失败", error: "err", transcript: [1, 2, 3] }, 8),
      ev("subagent_verified", { childId: "orphan" }, 9),
    ];
    const d = reduceRunTrace(events);
    const s = client.reduceRunTrace(events);
    expect(d).toEqual(s);
    expect(d.subagents).toHaveLength(3);
    expect(d.subagents[0]).toMatchObject({ id: "s1", status: "completed", verdict: "通过" });
    expect(d.subagents[1]).toMatchObject({ id: "pt9", status: "failed" });
  });

  it("文件/Pipeline/错误/验收/终态：file_changed、pipeline_*、officecli_failed、agent_error、task_completed、artifacts_validated、artifact_*、agent_end、run_finished", () => {
    const events = [
      ev("run_admitting", {}, 0),
      ev("file_changed", { files: ["a\\b.txt", "a/b.txt", "", "docs/中文.md"] }, 1),
      ev("file_changed", { files: "不是数组" }, 2),
      ev("pipeline_started", { pipelineId: "p1" }, 3),
      ev("pipeline_stage_started", { stage: "planner", label: "规划" }, 4),
      ev("pipeline_stage_finished", { stage: "planner", status: "done", artifact: "plan.md", checks: ["c1", "c2"], error: "" }, 5),
      ev("pipeline_stage_started", { stage: "writer" }, 6),
      ev("pipeline_stage_finished", { stage: "writer", status: "failed", error: "写作失败" }, 7),
      ev("pipeline_finished", { status: "partial", deliverable: "out.md" }, 8),
      ev("officecli_failed", { message: "转换失败" }, 9),
      ev("agent_error", { message: "模型超时" }, 10),
      ev("task_completed", { status: "partial", summary: "部分完成", incomplete: ["b"], blockers: [], verification: "failed" }, 11),
      ev("artifacts_validated", { status: "failed" }, 12),
      ev("artifact_staged", {}, 13),
      ev("artifact_materialized", {}, 14),
      ev("artifact_published", {}, 15),
      ev("agent_end", { turns: 5, durationMs: 15000 }, 16),
      ev("run_finished", { status: "completed" }, 17),
    ];
    const d = reduceRunTrace(events, "run-b");
    const s = client.reduceRunTrace(events, "run-b");
    expect(d).toEqual(s);
    expect(d.phase).toBe("done");
    expect(d.completion).toMatchObject({ status: "partial", source: "explicit" });
    expect(d.verification).toBe("failed");
    expect(d.durationMs).toBe(15000);
  });

  it("run_finished 权威 completion / 推断 / 取消 / 失败 / verificationStatus 矩阵", () => {
    const groups: Array<[string, unknown[]]> = [
      ["无 completion → 推断 completed", [ev("run_admitting", {}, 0), ev("run_finished", { status: "completed", summary: "收尾" }, 10)]],
      ["取消", [ev("run_finished", { status: "cancelled" }, 0)]],
      ["中断", [ev("run_finished", { status: "aborted" }, 0)]],
      ["失败", [ev("run_finished", { status: "failed" }, 0)]],
      ["显式 completed 优先", [ev("task_completed", { status: "success", summary: "显式" }, 1), ev("run_finished", { status: "completed" }, 2)]],
      ["服务端 completion 权威", [ev("task_completed", { status: "success", summary: "显式" }, 1), ev("run_finished", { status: "completed", completion: { status: "partial", summary: "服务端" } }, 2)]],
      ["服务端 completion 无 status 不采用", [ev("run_finished", { status: "completed", completion: { summary: "无状态" } }, 0)]],
      ["completion 非对象", [ev("run_finished", { status: "failed", completion: "x" }, 0)]],
      ["verificationStatus 透传", [ev("run_finished", { status: "completed", verificationStatus: "passed" }, 0)]],
      ["verificationStatus not_checked 兜底", [ev("run_finished", { status: "completed", verificationStatus: "not_checked" }, 0)]],
      ["早于 startedAt 不算 duration", [ev("run_finished", { status: "completed" }, 0)]],
    ];
    for (const [name, events] of groups) {
      const d = reduceRunTrace(events);
      const s = client.reduceRunTrace(events);
      expect(d, name).toEqual(s);
    }
  });

  it("reduceRunTrace 幂等去重与 key 规则", () => {
    const base = [ev("tool_start", { toolCallId: "c1", name: "read" }, 0), ev("tool_end", { toolCallId: "c1" }, 1)];
    // 显式 key 幂等
    const withKey = [ev("tool_start", { toolCallId: "c2", name: "ls" }, 0, { key: "k1" }), ev("tool_start", { toolCallId: "c3", name: "ls" }, 1, { key: "k1" })];
    const d = reduceRunTrace(withKey);
    const s = client.reduceRunTrace(withKey);
    expect(d).toEqual(s);
    expect(d.tools).toHaveLength(1); // 同 key 幂等：第二个事件被跳过
    // 重复流回放安全：base 只含 1 条聚合工具记录（start+end），回放后仍 1 条
    const replay = [...base, ...base];
    expect(reduceRunTrace(replay)).toEqual(client.reduceRunTrace(replay));
    expect(reduceRunTrace(replay).tools).toHaveLength(1);
    // seq=0 / seq=1 key 不同，但同 toolCallId 的 tool_start 只会更新同一条
    const seqEvents = [ev("tool_start", { toolCallId: "x" }, 0, { seq: 0 }), ev("tool_start", { toolCallId: "x" }, 0, { seq: 1 })];
    expect(reduceRunTrace(seqEvents).tools).toHaveLength(1);
    // 畸形事件不抛错（无 at 兜底为调用时刻 new Date()，两侧毫秒可能跨 tick：剥时间后比较）
    const junk: unknown[] = [null, undefined, 42, "str", {}, { type: "tool_start" }, { type: "", data: null }];
    const stripClockFields = (trace: unknown): Record<string, unknown> => {
      const plain = JSON.parse(JSON.stringify(trace)) as Record<string, unknown>;
      delete plain.startedAt;
      plain.phases = (plain.phases as Record<string, unknown>[]).map((phase) => {
        const { at: _at, ...rest } = phase;
        return rest;
      });
      plain.tools = (plain.tools as Record<string, unknown>[]).map((tool) => {
        const { startAt: _startAt, endAt: _endAt, ...rest } = tool;
        return rest;
      });
      return plain;
    };
    expect(stripClockFields(reduceRunTrace(junk))).toEqual(stripClockFields(client.reduceRunTrace(junk)));
    // runId 透传 + 空事件
    expect(reduceRunTrace([], "r1").runId).toBe("r1");
    expect(reduceRunTrace().runId).toBeNull();
  });

  it("applyRunTraceEvent 无 at 兜底（结构断言，不比时间）", () => {
    const d = reduceRunTrace([{ type: "run_admitting", data: {} }]);
    const s = client.reduceRunTrace([{ type: "run_admitting", data: {} }]);
    expect(typeof d.startedAt).toBe("string");
    expect(typeof s.startedAt).toBe("string");
    expect(d.phases).toHaveLength(1);
    expect(s.phases).toHaveLength(1);
    expect(d.phase).toBe(s.phase);
  });

  it("summarizeRunTrace / runTraceSummaryText / runTraceProgressText", () => {
    const events = [
      ev("run_admitting", {}, 0),
      ev("tool_start", { toolCallId: "c1", name: "read" }, 1),
      ev("tool_end", { toolCallId: "c1" }, 2),
      ev("tool_start", { toolCallId: "c2", name: "bash" }, 3),
      ev("tool_end", { toolCallId: "c2", isError: true }, 4),
      ev("tool_start", { toolCallId: "c3", name: "write" }, 5),
      ev("subagent_start", { childId: "s1" }, 6),
      ev("subagent_end", { childId: "s1", status: "completed" }, 7),
      ev("subagent_start", { childId: "s2" }, 8),
      ev("file_changed", { files: ["a.txt", "b.txt"] }, 9),
      ev("agent_error", { message: "e" }, 10),
      ev("todo_updated", { items: [{ id: "t1", status: "completed" }, { id: "t2", status: "planned" }, { id: "t3", status: "skipped" }] }, 11),
      ev("artifacts_validated", { status: "passed" }, 12),
      ev("run_finished", { status: "completed" }, 13),
    ];
    const dTrace = reduceRunTrace(events);
    const sTrace = client.reduceRunTrace(events);
    expect(summarizeRunTrace(dTrace)).toEqual(client.summarizeRunTrace(sTrace));
    expect(runTraceSummaryText(dTrace)).toBe(client.runTraceSummaryText(sTrace));
    const now = T0 + 60 * 1000;
    expect(runTraceProgressText(dTrace, { now })).toBe(client.runTraceProgressText(sTrace, { now }));
    expect(runTraceProgressText(dTrace, { now, running: true })).toBe(client.runTraceProgressText(sTrace, { now, running: true }));
    expect(runTraceProgressText(dTrace, { now, running: true })).toContain("用时");
    // 空迹/null
    expect(summarizeRunTrace(null)).toEqual(client.summarizeRunTrace(null));
    expect(runTraceSummaryText(null)).toBe(client.runTraceSummaryText(null));
    expect(runTraceProgressText(null, { now })).toBe(client.runTraceProgressText(null, { now }));
  });

  it("回合指标：reduceTurnMetrics / summarizeTurnMetrics / turnMetricsText", () => {
    const events = [
      ev("turn_started", {}, 0),
      ev("stats", { tokens: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, context: 1000 } }, 1),
      ev("stats", { tokens: { inputTokens: 200, outputTokens: 80 } }, 2), // output 更大者保留
      ev("turn_ended", { toolCount: 3 }, 3),
      ev("turn_started", {}, 4),
      ev("stats", { usage: { outputTokens: 10 } }, 5),
      ev("turn_ended", { toolCount: "abc" }, 6),
      ev("agent_end", {}, 7),
      ev("turn_started", {}, 8),
      ev("run_finished", {}, 9),
    ];
    const d = reduceTurnMetrics(events);
    const s = client.reduceTurnMetrics(events);
    expect(d).toEqual(s);
    expect(d).toHaveLength(3);
    const dTotals = summarizeTurnMetrics(d);
    const sTotals = client.summarizeTurnMetrics(s);
    expect(dTotals).toEqual(sTotals);
    expect(dTotals.context).toBeNull(); // turn1 的 stats 被 output 更大的 turn2 替换，此后无实测 context
    expect(dTotals.measuredTurns).toBe(2);
    // 畸形 tokens / 空 turns
    const junk: unknown[] = [ev("stats", { tokens: "x" }), ev("stats", { tokens: {} }), ev("stats", {}), "junk", null];
    expect(reduceTurnMetrics(junk)).toEqual(client.reduceTurnMetrics(junk));
    expect(summarizeTurnMetrics([])).toEqual(client.summarizeTurnMetrics([]));
    expect(summarizeTurnMetrics(null)).toEqual(client.summarizeTurnMetrics(null));
    // 文案
    expect(turnMetricsText(dTotals)).toBe(client.turnMetricsText(sTotals));
    expect(turnMetricsText(dTotals, { durationMs: 192000 })).toBe(client.turnMetricsText(sTotals, { durationMs: 192000 }));
    expect(turnMetricsText(null)).toBe("");
    expect(turnMetricsText(undefined)).toBe(client.turnMetricsText(undefined));
  });

  it("formatTokenCount / formatDuration / verificationLabel / runToolDetailText", () => {
    const numbers = [0, 292, 999, 1000, 1234, 10000, 184200, 999999, 1000000, 1234567, -5, NaN, null, undefined, "", "1.2k", "abc", Infinity, {}];
    for (const n of numbers) {
      expect(formatTokenCount(n)).toBe(client.formatTokenCount(n));
    }
    expect(formatTokenCount(1500)).toBe("1.5k");
    expect(formatTokenCount(1000)).toBe("1k");
    const durations = [0, 45000, 59000, 60000, 192000, 3600000, 3720000, null, undefined, "x", -100];
    for (const d of durations) {
      expect(formatDuration(d)).toBe(client.formatDuration(d));
    }
    const statuses = ["passed", "warning", "failed", "manual_review", "pending", "not_checked", "unknown", "", null, undefined, 42];
    for (const st of statuses) {
      expect(verificationLabel(st)).toBe(client.verificationLabel(st));
    }
    const tools: Array<Record<string, unknown> | undefined> = [
      { output: "文本输出" },
      { result: { structured: true } },
      { input: { prompt: "输入" } },
      { output: { a: 1 }, result: "优先 output" },
      { output: { toString: 1 } },
      { output: [1, 2, 3] },
      { output: "" },
      { output: null, result: null, input: null },
      {},
      undefined,
    ];
    for (const t of tools) {
      expect(runToolDetailText(t as Record<string, unknown>)).toBe(client.runToolDetailText(t));
    }
    // 循环引用：JSON.stringify 抛错 → String → "[object Object]" → 兜底 ""
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(runToolDetailText({ output: cyclic })).toBe("");
    expect(runToolDetailText({ output: cyclic })).toBe(client.runToolDetailText(cyclic as Record<string, unknown>));
  });

  it("综合回归：整段事件流投影一致（阶段只前进）", () => {
    const events: unknown[] = [
      ev("run_admitting", {}, 0),
      ev("todo_updated", { items: [{ id: "t1", title: "a", status: "completed" }] }, 1),
      ev("tool_start", { toolCallId: "c1", name: "write", input: "x" }, 2),
      ev("artifacts_validated", { status: "passed" }, 3), // verifying
      ev("tool_end", { toolCallId: "c1" }, 4), // 回退 executing（验证→执行视为重试路径，但 trace 阶段只前进）
      ev("artifact_published", {}, 5),
      ev("run_finished", { status: "completed" }, 6),
      ev("run_admitting", {}, 7), // setPhase 直接赋值：此事件会把 phase 拉回 planning（与 client 版一致）
      ev("turn_started", {}, 8),
    ];
    const d = reduceRunTrace(events, "run-z") as RunTrace;
    const s = client.reduceRunTrace(events, "run-z");
    expect(d).toEqual(s);
    // setPhase 是直接赋值：run_finished → done 后，后到的 run_admitting 会把 phase 拉回 planning
    expect(d.phase).toBe("planning");
    expect(d.phases.map((p) => p.phase)).toEqual(["planning", "executing", "verifying", "delivering", "done", "planning"]);
  });
});
