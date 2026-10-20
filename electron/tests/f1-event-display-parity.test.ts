import { describe, it, expect } from "vitest";
import {
  PHASE_LABELS, PHASE_ORDER, STAGE_ONLY_EVENTS, EVENT_UI, FLOW_EVENT_TYPES,
  phaseForEvent, flowEventLabel, flowEventTone, runConclusion, toolIdentity,
} from "../src/renderer/lib/event-display";

const clientModule = await import("../../client/src/event-display.js");
const client = clientModule as any;

/** flowEventLabel 全 case 用例：[说明, 事件] */
const LABEL_CASES: Array<[string, unknown]> = [
  ["传输类", { type: "runtime_connecting" }],
  ["run_admitting", { type: "run_admitting" }],
  ["stream_waiting", { type: "stream_waiting" }],
  ["stream_resync", { type: "stream_resync" }],
  ["run_admitted", { type: "run_admitted" }],
  ["model_request_started", { type: "model_request_started" }],
  ["agent_started", { type: "agent_started" }],
  ["turn_started", { type: "turn_started" }],
  ["turn_ended", { type: "turn_ended" }],
  ["write_started", { type: "write_started" }],
  ["write_locked", { type: "write_locked" }],
  ["artifact_staged", { type: "artifact_staged" }],
  ["artifact_materialized", { type: "artifact_materialized" }],
  ["artifact_published", { type: "artifact_published" }],
  ["write_cleaned", { type: "write_cleaned" }],
  ["验收失败", { type: "artifacts_validated", data: { status: "failed", failed: 2, checked: 5 } }],
  ["验收通过", { type: "artifacts_validated", data: { checked: "3" } }],
  ["验收零值", { type: "artifacts_validated", data: {} }],
  ["steer 进度", { type: "steer", data: { source: "turn-progress" } }],
  ["steer 收束", { type: "steer", data: { source: "turn-budget-hard" } }],
  ["steer 检查", { type: "steer", data: { source: "turn-budget" } }],
  ["steer 默认", { type: "steer", data: {} }],
  ["重复提醒", { type: "tool_repeat_warning", data: { name: "bash", count: 5 } }],
  ["重复提醒兜底", { type: "tool_repeat_warning", data: {} }],
  ["预算提醒长文", { type: "run_budget_notice", data: { reason: "长".repeat(100) } }],
  ["预算提醒兜底", { type: "run_budget_notice", data: {} }],
  ["预算阻断长文", { type: "run_budget_blocked", data: { reason: "budget" } }],
  ["预算阻断兜底", { type: "run_budget_blocked" }],
  ["completion_nudge", { type: "completion_nudge" }],
  ["tool_start 已知", { type: "tool_start", data: { name: "READ" } }],
  ["tool_start 未知", { type: "tool_start", data: { toolName: "custom_tool" } }],
  ["tool_start 无名", { type: "tool_start" }],
  ["tool_end 完成", { type: "tool_end", data: { name: "grep", isError: false } }],
  ["tool_end 失败", { type: "tool_end", data: { name: "bash", isError: 1 } }],
  ["subagent_start 已知", { type: "subagent_start", data: { role: "scout" } }],
  ["subagent_start 未知", { type: "subagent_start", data: { role: "wizard" } }],
  ["subagent_start 空", { type: "subagent_start" }],
  ["subagent_planned task", { type: "subagent_planned", data: { task: "长".repeat(60) } }],
  ["subagent_planned role", { type: "subagent_planned", data: { role: "reviewer" } }],
  ["subagent_planned 空", { type: "subagent_planned", data: {} }],
  ["subagent_started model", { type: "subagent_started", data: { model: "m".repeat(40) } }],
  ["subagent_started 空", { type: "subagent_started" }],
  ["subagent_progress phase", { type: "subagent_progress", data: { phase: "读取中" } }],
  ["subagent_progress activity", { type: "subagent_progress", data: { activity: "扫描" } }],
  ["subagent_progress 空", { type: "subagent_progress" }],
  ["subagent_result 完成", { type: "subagent_result", data: { status: "completed" } }],
  ["subagent_result 其他", { type: "subagent_result", data: { status: "partial" } }],
  ["subagent_result 空", { type: "subagent_result" }],
  ["subagent_verified pass", { type: "subagent_verified", data: { verdict: "pass" } }],
  ["subagent_verified revise", { type: "subagent_verified", data: { verdict: "revise" } }],
  ["subagent_verified fail", { type: "subagent_verified", data: { verdict: "fail" } }],
  ["subagent_verified 未知", { type: "subagent_verified", data: { verdict: "maybe" } }],
  ["subagent_verified 空", { type: "subagent_verified" }],
  ["subagent_closed", { type: "subagent_closed", data: { finalStatus: "done" } }],
  ["subagent_closed 空", { type: "subagent_closed" }],
  ["pipeline_started", { type: "pipeline_started" }],
  ["pipeline 阶段 label", { type: "pipeline_stage_started", data: { label: "撰写" } }],
  ["pipeline 阶段 stage", { type: "pipeline_stage_started", data: { stage: "acceptance" } }],
  ["pipeline 阶段空", { type: "pipeline_stage_started" }],
  ["pipeline 阶段完成", { type: "pipeline_stage_finished", data: { label: "排版", artifact: "a.docx" } }],
  ["pipeline 完成 deliverable", { type: "pipeline_finished", data: { deliverable: "说明书.docx" } }],
  ["pipeline 完成 status", { type: "pipeline_finished", data: { status: "failed" } }],
  ["subagent_tool end 失败", { type: "subagent_tool", data: { toolName: "bash", status: "end", isError: true } }],
  ["subagent_tool end 完成", { type: "subagent_tool", data: { toolName: "read", status: "end" } }],
  ["subagent_tool 开始", { type: "subagent_tool", data: { toolName: "custom" } }],
  ["subagent_update", { type: "subagent_update", data: { activity: "写文档" } }],
  ["subagent_update 空", { type: "subagent_update" }],
  ["subagent_end 完成", { type: "subagent_end", data: { status: "completed" } }],
  ["subagent_end 取消", { type: "subagent_end", data: { status: "cancelled" } }],
  ["subagent_end 失败", { type: "subagent_end", data: { status: "failed" } }],
  ["todo 更新", { type: "todo_updated", data: { todoProgress: { completed: "2", total: 5 } } }],
  ["todo 更新空", { type: "todo_updated" }],
  ["officecli 失败", { type: "officecli_failed", data: { message: "长".repeat(80) } }],
  ["officecli 失败空", { type: "officecli_failed" }],
  ["ask_user", { type: "ask_user" }],
  ["审批请求", { type: "tool_approval_request", data: { name: "write" } }],
  ["审批通过", { type: "tool_approval_resolved", data: { decision: "allow" } }],
  ["审批拒绝", { type: "tool_approval_resolved", data: { decision: "deny" } }],
  ["agent_retry", { type: "agent_retry" }],
  ["retry 恢复", { type: "agent_retry_end", data: { success: true } }],
  ["retry 结束", { type: "agent_retry_end", data: {} }],
  ["模型回退", { type: "agent_model_fallback", data: { to: "deepseek" } }],
  ["模型回退空", { type: "agent_model_fallback" }],
  ["回退失败", { type: "agent_model_fallback_failed" }],
  ["切换失败", { type: "model_switched", data: { effective: "failed", to: "m1" } }],
  ["切换排队", { type: "model_switched", data: { reason: "queued", effective: "after-run", to: "m1" } }],
  ["切换排队空", { type: "model_switched", data: { reason: "queued", effective: "after-run" } }],
  ["通道回退", { type: "model_switched", data: { reason: "fallback", to: "m2" } }],
  ["通道回退空", { type: "model_switched", data: { reason: "fallback" } }],
  ["切换默认", { type: "model_switched", data: { to: " m3 " } }],
  ["切换全空", { type: "model_switched" }],
  ["压缩中", { type: "context_compacting" }],
  ["压缩完成", { type: "context_compacted" }],
  ["压缩提示", { type: "context_compact_warning" }],
  ["模型收尾", { type: "agent_turn_end" }],
  ["agent_error 消息", { type: "agent_error", data: { message: " ".repeat(200) } }],
  ["agent_error quota", { type: "agent_error", data: { category: "quota" } }],
  ["agent_error 默认", { type: "agent_error" }],
  ["runtime_error 消息", { type: "runtime_error", data: { message: "boom" } }],
  ["runtime_error 默认", { type: "runtime_error" }],
  ["恢复中", { type: "run_recovery_started" }],
  ["已恢复", { type: "run_recovered" }],
  ["取消请求", { type: "run_cancel_requested" }],
  ["run_draining", { type: "run_draining" }],
  ["step title", { type: "step_updated", data: { title: "导入底图" } }],
  ["step name", { type: "step_updated", data: { name: "长".repeat(60) } }],
  ["step 空", { type: "step_updated" }],
  ["产物回滚", { type: "artifact_rolled_back" }],
  ["地图操作", { type: "map_action", data: { action: "长".repeat(40) } }],
  ["地图操作空", { type: "map_action" }],
  ["记忆初始化", { type: "memory_initialized" }],
  ["记忆建议", { type: "memory_proposal" }],
  ["建议创建", { type: "memory_proposal_created" }],
  ["建议更新", { type: "memory_proposal_updated" }],
  ["建议编辑", { type: "memory_proposal_edited" }],
  ["建议处理", { type: "memory_proposal_resolved" }],
  ["建议通过", { type: "memory_proposal_approved" }],
  ["建议拒绝", { type: "memory_proposal_rejected" }],
  ["建议合并", { type: "memory_proposal_merged" }],
  ["建议失败", { type: "memory_proposal_failed" }],
  ["记忆写入", { type: "memory_written" }],
  ["记忆文件", { type: "memory_file_edited" }],
  ["写入拒绝", { type: "write_rejected", data: { message: "被拦截" } }],
  ["写入拒绝空", { type: "write_rejected" }],
  ["文件更新", { type: "file_changed", data: { files: ["a", "b", "c"] } }],
  ["文件更新空", { type: "file_changed", data: {} }],
  ["任务总结", { type: "agent_summary" }],
  ["最终回复", { type: "assistant_final" }],
  ["agent_end", { type: "agent_end" }],
  ["run_finished 成功", { type: "run_finished", data: { status: "completed" } }],
  ["run_finished 失败", { type: "run_finished", data: { status: "failed" } }],
  ["run_finished 取消", { type: "run_finished", data: { status: "cancelled" } }],
  ["run_finished 中断", { type: "run_finished", data: { status: "aborted" } }],
  ["run_finished 默认", { type: "run_finished" }],
  ["task_completed", { type: "task_completed", data: { status: "success", summary: "长".repeat(60) } }],
  ["task_completed blocked", { type: "task_completed", data: { status: "blocked" } }],
  ["task_completed 未知状态", { type: "task_completed", data: {} }],
  ["aborted", { type: "aborted" }],
  ["capability_plan 有", { type: "capability_plan", data: { plan: { capabilities: ["a", "b"] } } }],
  ["capability_plan 空", { type: "capability_plan" }],
  ["mode chat", { type: "mode_policy", data: { mode: "CHAT" } }],
  ["mode agent", { type: "mode_policy", data: { mode: "agent" } }],
  ["mode office", { type: "mode_policy", data: { mode: "office" } }],
  ["mode review", { type: "mode_policy", data: { mode: "review" } }],
  ["mode 未知", { type: "mode_policy", data: {} }],
  ["材料识别", { type: "review_material_classified", data: { materialType: "shp" } }],
  ["材料识别空", { type: "review_material_classified" }],
  ["搜索规范", { type: "review_source_search_started" }],
  ["规范候选", { type: "review_source_search_result", data: { candidates: [1, 2] } }],
  ["规范候选空", { type: "review_source_search_result" }],
  ["读取规范开始", { type: "review_source_read_started", data: { sourceId: "S1" } }],
  ["读取规范开始空", { type: "review_source_read_started" }],
  ["读取规范失败", { type: "review_source_read", data: { status: "failed", sourceId: "S1" } }],
  ["读取规范成功", { type: "review_source_read", data: { sourceId: "S1" } }],
  ["采用规范", { type: "review_source_applied", data: { sourceId: "S2" } }],
  ["规范未采用", { type: "review_source_unused", data: { sourceId: "S3" } }],
  ["等待确认", { type: "review_waiting_confirmation" }],
  ["已确认", { type: "review_confirmed" }],
  ["拒绝写回", { type: "review_confirmation_rejected" }],
  ["写回保护", { type: "review_write_blocked" }],
  ["思考深度", { type: "thinking_level", data: { effective: "high" } }],
  ["思考深度 requested", { type: "thinking_level", data: { requested: "low" } }],
  ["思考深度空", { type: "thinking_level" }],
  ["任务排队", { type: "agent_queued", data: { position: 3 } }],
  ["任务排队空", { type: "agent_queued" }],
  ["队列调整", { type: "agent_queue_update", data: { steering: true } }],
  ["队列等待", { type: "agent_queue_update", data: {} }],
  ["未知类型", { type: "totally_unknown_event" }],
  ["未知类型 data", { type: "custom_thing", data: { a: 1 } }],
  ["null 事件", null],
  ["undefined 事件", undefined],
  ["字符串事件", "not-an-object"],
  ["数字事件", 42],
  ["事件无 type", { data: { name: "x" } }],
];

describe("event-display TS 版与 client 版等价（对拍）", () => {
  it("常量表：阶段标签/顺序/登记表/集合逐字段一致", () => {
    expect(PHASE_LABELS).toEqual(client.PHASE_LABELS);
    expect(PHASE_ORDER).toEqual(client.PHASE_ORDER);
    expect([...STAGE_ONLY_EVENTS].sort()).toEqual([...client.STAGE_ONLY_EVENTS].sort());
    expect(EVENT_UI).toEqual(client.EVENT_UI);
    expect([...FLOW_EVENT_TYPES].sort()).toEqual([...client.FLOW_EVENT_TYPES].sort());
    // 绝对锚点：阶段推进链与登记规模
    expect(PHASE_ORDER).toEqual(["idle", "planning", "executing", "verifying", "delivering", "done"]);
    expect(Object.keys(EVENT_UI)).toHaveLength(81);
    expect(FLOW_EVENT_TYPES.size).toBe(Object.keys(EVENT_UI).length + 13);
  });

  it("phaseForEvent：run_finished 状态矩阵、登记事件、未登记兜底、异常入参", () => {
    const cases: Array<[unknown, unknown]> = [
      [{ type: "run_finished", data: { status: "completed" } }, "done"],
      [{ type: "run_finished", data: { status: "failed" } }, "failed"],
      [{ type: "run_finished", data: { status: "cancelled" } }, "cancelled"],
      [{ type: "run_finished", data: { status: "aborted" } }, "cancelled"],
      [{ type: "run_finished" }, "done"],
      [{ type: "tool_start" }, "executing"],
      [{ type: "subagent_verified" }, "verifying"],
      [{ type: "artifact_published" }, "delivering"],
      [{ type: "run_cancel_requested" }, null],
      [{ type: "unknown_event" }, null],
      [null, null],
      [42, null],
    ];
    for (const [event, expected] of cases) {
      expect(phaseForEvent(event)).toBe(expected);
      expect(phaseForEvent(event)).toEqual(client.phaseForEvent(event));
    }
  });

  it("flowEventLabel：全 case 逐条与 client 版一致（含兜底与异常入参）", () => {
    expect(LABEL_CASES.length).toBeGreaterThanOrEqual(150);
    for (const [name, event] of LABEL_CASES) {
      const d = flowEventLabel(event);
      const s = client.flowEventLabel(event);
      if (d !== s) throw new Error(`case「${name}」不一致: TS=${JSON.stringify(d)} client=${JSON.stringify(s)}`);
      expect(d).toEqual(s);
    }
  });

  it("flowEventTone：error/success/warning/running 全路径", () => {
    const cases: Array<[unknown, string]> = [
      [{ type: "agent_error" }, "error"],
      [{ type: "agent_model_fallback_failed" }, "error"],
      [{ type: "write_rejected" }, "error"],
      [{ type: "officecli_failed" }, "error"],
      [{ type: "review_write_blocked" }, "error"],
      [{ type: "review_confirmation_rejected" }, "error"],
      [{ type: "stream_resync" }, "error"],
      [{ type: "runtime_error" }, "error"],
      [{ type: "memory_proposal_failed" }, "error"],
      [{ type: "tool_end", data: { isError: "truthy" } }, "error"],
      [{ type: "subagent_end", data: { status: "cancelled" } }, "error"],
      [{ type: "subagent_tool", data: { isError: true } }, "error"],
      [{ type: "subagent_tool", data: { isError: "x" } }, "error"], // 宽松 truthy 判定（与第一段 data?.isError 一致）
      [{ type: "pipeline_stage_finished", data: { status: "revise" } }, "error"],
      [{ type: "pipeline_finished", data: { status: "failed" } }, "error"],
      [{ type: "artifacts_validated", data: { status: "failed" } }, "error"],
      [{ type: "artifacts_validated", data: {} }, "success"],
      [{ type: "run_finished", data: { status: "failed" } }, "error"],
      [{ type: "run_finished", data: { status: "cancelled" } }, "warning"],
      [{ type: "run_finished", data: { status: "completed" } }, "success"],
      [{ type: "task_completed", data: { status: "failed" } }, "error"],
      [{ type: "task_completed", data: { status: "success" } }, "success"],
      [{ type: "task_completed", data: { status: "partial" } }, "warning"],
      [{ type: "agent_end" }, "success"],
      [{ type: "tool_end", data: {} }, "success"],
      [{ type: "run_recovered" }, "success"],
      [{ type: "tool_start" }, "running"],
      [{ type: "unknown" }, "running"],
      [null, "running"],
    ];
    for (const [event, expected] of cases) {
      expect(flowEventTone(event)).toBe(expected);
      expect(flowEventTone(event)).toEqual(client.flowEventTone(event));
    }
  });

  it("runConclusion：生命周期 status 与 completion 全矩阵", () => {
    const cases: unknown[] = [
      { type: "run_finished", data: { status: "cancelled" } },
      { type: "run_finished", data: { status: "aborted" } },
      { type: "run_finished", data: { status: "failed" } },
      { type: "run_finished", data: { status: "completed", completion: { status: "failed" } } },
      { type: "run_finished", data: { status: "completed", completion: { status: "partial" } } },
      { type: "run_finished", data: { status: "completed", completion: { status: "blocked" } } },
      { type: "run_finished", data: { status: "completed", completion: { status: "cancelled" } } },
      { type: "run_finished", data: { status: "completed", completion: { status: "success" } } },
      { type: "run_finished", data: { status: "completed", completion: "not-object" } },
      { type: "run_finished" },
      { type: "run_finished", data: {} },
      null,
    ];
    for (const event of cases) {
      const d = runConclusion(event);
      const s = client.runConclusion(event);
      expect(d).toEqual(s);
    }
    // 绝对锚点：success 文案是“运行结束”，失败/部分完成不得是 success 色
    expect(runConclusion({ type: "run_finished" })).toEqual({ status: "success", label: "运行结束", tone: "success" });
    expect(runConclusion({ type: "run_finished", data: { status: "completed", completion: { status: "partial" } } })).toEqual({ status: "partial", label: "部分完成", tone: "warning" });
  });

  it("toolIdentity：空值/__thinking__/每条规则代表/大小写/前缀规则/未知回退", () => {
    const names = [
      "", "   ", "__thinking__",
      "browser_navigate", "browserOpen", "web_search", "webFetch", "grep", "GLOB",
      "kb_search", "memory_update", "skills_read", "read", "context_read",
      "map_edit", "map_save_analysis", "write", "review_source_apply", "officecli", "OFFICECLI",
      "bash", "Terminal", "todo", "taskupdate", "run_subagent", "editorial_pipeline",
      "tool_approval_request", "approval", "review_copy_stage", "ask_user", "complete_task",
      "unknown_tool", 42, null,
    ];
    for (const name of names) {
      const d = toolIdentity(name);
      const s = client.toolIdentity(name);
      expect(d).toEqual(s);
    }
    expect(toolIdentity("")).toEqual({ icon: "tool", category: "generic" });
    expect(toolIdentity("__thinking__")).toEqual({ icon: "brain", category: "thinking" });
    expect(toolIdentity("map_read")).toEqual({ icon: "map", category: "map" });
    // 前缀规则（无 $）能匹配扩展名
    expect(toolIdentity("browserClickAndType")).toEqual({ icon: "globe", category: "globe" });
    expect(toolIdentity(null)).toEqual({ icon: "tool", category: "generic" });
  });
});
