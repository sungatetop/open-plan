/**
 * 事件注册表（TS 基座）：事件流的唯一事实来源。
 *
 * 与 server/event-registry.mjs 保持逐条等价（由 tests/event-registry-parity.test.ts 对拍强制）：
 *   - server 版为迁移期权威（B1 批次按域绞杀，此模块先作为协议类型与校验基座）；
 *   - 迁移完成后 server 版退役，本模块成为唯一实现。
 *
 * 约定（沿用 BRD-005 事件治理）：
 *   1. persist 的事件必须同时 lifecycle（能落盘的就值得保护）；
 *   2. 代码里 emit/recordRunEvent/appendEvent/writeEvent 用到的事件类型必须登记。
 */

export type EventSchemaType = "string" | "number" | "boolean" | "object" | "array";

export interface EventSchema {
  required: string[];
  types: Partial<Record<string, EventSchemaType>>;
}

export interface EventSpec {
  type: string;
  lifecycle: boolean;
  persist: boolean;
  note: string;
  schema?: EventSchema;
}

const REGISTRY = [
  // ---- 运行生命周期 ----
  { type: "run_admitting", lifecycle: true, persist: true, note: "Run 建档中" },
  { type: "run_admitted", lifecycle: true, persist: true, note: "Run 建档完成（前端锚点）" },
  { type: "run_started", lifecycle: true, persist: true, note: "Run 开始" },
  { type: "prompt", lifecycle: true, persist: true, note: "用户输入进模型" },
  { type: "capability_plan", lifecycle: true, persist: true, note: "本轮能力计划" },
  { type: "mode_policy", lifecycle: true, persist: true, note: "模式工具策略快照" },
  { type: "thinking_level", lifecycle: true, persist: true, note: "思考深度设置" },
  { type: "run_checkpoint_updated", lifecycle: true, persist: true, note: "恢复检查点更新" },
  { type: "run_cancel_requested", lifecycle: true, persist: true, note: "收到取消请求" },
  { type: "run_draining", lifecycle: true, persist: true, note: "中断后残余消息排空窗口（Qoder P0-3，默认关）", schema: { required: ["runId"], types: { runId: "string", reason: "string" } } },
  { type: "run_recovered", lifecycle: true, persist: true, note: "服务重启后标记恢复" },
  { type: "run_recovery_started", lifecycle: true, persist: true, note: "用户选择继续该 Run" },
  { type: "run_finished", lifecycle: true, persist: true, note: "Run 终态（权威完成语义）", schema: { required: ["runId", "status"], types: { runId: "string", status: "string", artifacts: "array" } } },
  { type: "aborted", lifecycle: true, persist: true, note: "回合被中断", schema: { required: ["runId"], types: { runId: "string" } } },

  // ---- 回合 / 消息边界 ----
  { type: "agent_started", lifecycle: true, persist: true, note: "Agent 回合开始" },
  { type: "agent_turn_end", lifecycle: true, persist: true, note: "Agent 回合收尾统计" },
  { type: "turn_started", lifecycle: true, persist: true, note: "模型回合开始" },
  { type: "turn_ended", lifecycle: true, persist: true, note: "模型回合结束" },
  { type: "message_start", lifecycle: true, persist: true, note: "助手消息开始" },
  { type: "message_end", lifecycle: true, persist: true, note: "助手消息结束" },

  // ---- 工具与写入 ----
  { type: "tool_start", lifecycle: true, persist: true, note: "工具调用开始" },
  { type: "tool_end", lifecycle: true, persist: true, note: "工具调用结束", schema: { required: ["name"], types: { name: "string", isError: "boolean" } } },
  { type: "tool_call_progress", lifecycle: true, persist: false, note: "工具分段进度（高频）" },
  { type: "tool_repeat_warning", lifecycle: true, persist: true, note: "同参数重复调用提醒" },
  { type: "completion_nudge", lifecycle: true, persist: true, note: "收尾强制完成声明提醒" },
  { type: "write_started", lifecycle: true, persist: true, note: "写入开始（含锁）" },
  { type: "write_locked", lifecycle: true, persist: false, note: "写入已加锁（与 write_started 恒成对，不落盘省冗余）" },
  { type: "write_rejected", lifecycle: true, persist: true, note: "写入被拒（含失败码）" },
  { type: "write_cleaned", lifecycle: true, persist: true, note: "临时产物清理" },
  { type: "artifact_staged", lifecycle: true, persist: true, note: "产物暂存" },
  { type: "artifacts_validated", lifecycle: true, persist: true, note: "产物验收结果（发布前预检）" },
  { type: "artifact_materialized", lifecycle: true, persist: true, note: "产物落盘发布" },
  { type: "artifact_published", lifecycle: true, persist: true, note: "产物固定/发布" },
  { type: "artifact_rolled_back", lifecycle: true, persist: true, note: "产物回滚" },
  { type: "file_changed", lifecycle: true, persist: true, note: "工作区文件变更" },

  // ---- 子代理（Subagent）----
  { type: "subagent_planned", lifecycle: true, persist: true, note: "子代理编排计划（含角色/任务/工具白名单/预算）" },
  { type: "subagent_start", lifecycle: true, persist: true, note: "子代理启动（含角色/子任务；执行器兼容事件）" },
  { type: "subagent_started", lifecycle: true, persist: true, note: "子代理会话已建立（含模型与播种引用）" },
  { type: "subagent_tool", lifecycle: true, persist: true, note: "子代理工具调用（start/end，含子 toolCallId）" },
  { type: "subagent_update", lifecycle: true, persist: false, note: "子代理进度/思考节流（高频，不落盘，对齐 tool_call_progress）" },
  { type: "subagent_progress", lifecycle: true, persist: false, note: "子代理阶段进度（orchestrator 契约，节流高频不落盘）" },
  { type: "subagent_end", lifecycle: true, persist: true, note: "子代理结束（含结论摘要/错误）" },
  { type: "subagent_result", lifecycle: true, persist: true, note: "子代理结构化结果（status/output/artifacts/toolStats）" },
  { type: "subagent_verified", lifecycle: true, persist: true, note: "子代理对抗式核验结论（verdict/checklist）" },
  { type: "subagent_closed", lifecycle: true, persist: true, note: "子代理关账（finalStatus/parentToolCallId，roster 持久化锚点）" },

  // ---- Editorial Pipeline ----
  { type: "pipeline_started", lifecycle: true, persist: true, note: "编辑流水线开始（Planner→Writer→Formatter→Evaluator）" },
  { type: "pipeline_stage_started", lifecycle: true, persist: true, note: "流水线阶段开始（含 stage/目标/中间产物路径）" },
  { type: "pipeline_stage_finished", lifecycle: true, persist: true, note: "流水线阶段完成（含产物路径与检查结论）" },
  { type: "pipeline_finished", lifecycle: true, persist: true, note: "编辑流水线结束（交付产物/回环/失败终态）" },

  // ---- 审批 / 提问 ----
  { type: "ask_user", lifecycle: true, persist: true, note: "向用户提问", schema: { required: ["askId", "question"], types: { askId: "string", question: "string", options: "array" } } },
  { type: "tool_approval_request", lifecycle: true, persist: true, note: "工具审批请求", schema: { required: ["id", "tool"], types: { id: "string", tool: "string", action: "string" } } },
  { type: "interaction_owner_changed", lifecycle: true, persist: true, note: "交互归属变更（Qoder P1-4 子代理接管，默认关）", schema: { required: ["owner"], types: { owner: "object", status: "string" } } },
  { type: "tool_approval_resolved", lifecycle: true, persist: true, note: "工具审批结果" },

  // ---- 通道与重试 ----
  { type: "model_request_started", lifecycle: true, persist: true, note: "向模型发起请求（回合锚点）" },
  { type: "agent_retry", lifecycle: true, persist: true, note: "模型重试" },
  { type: "agent_retry_end", lifecycle: true, persist: true, note: "模型重试结束" },
  { type: "agent_model_fallback", lifecycle: true, persist: true, note: "通道切换到备用模型" },
  { type: "agent_model_fallback_failed", lifecycle: true, persist: true, note: "通道切换失败" },
  { type: "model_switched", lifecycle: true, persist: true, note: "模型切换（用户切换/排队生效/通道回退），界面据此画切换分割线" },
  { type: "agent_queued", lifecycle: true, persist: true, note: "任务排队" },
  { type: "agent_queue_update", lifecycle: true, persist: true, note: "队列状态更新" },
  { type: "steer", lifecycle: true, persist: true, note: "运行中插话/系统提醒" },

  // ---- 运行预算（E02）----
  { type: "run_budget_notice", lifecycle: true, persist: true, note: "运行预算软提醒（回合/工具接近软预算）" },
  { type: "run_budget_blocked", lifecycle: true, persist: true, note: "运行预算硬阻断（硬预算/重复无进展/连续失败）" },
  { type: "tool_gate_denied", lifecycle: true, persist: true, note: "工具被把关扩展单点拒绝（U2，扩展 tool_call 拦截，Run 继续执行）" },

  // ---- 上下文预算（U1/U6）----
  { type: "context_usage", lifecycle: true, persist: false, note: "回合边界精确上下文用量（U1，getContextUsage 实测，高频不落盘）" },
  { type: "compaction_failed", lifecycle: true, persist: true, note: "上下文压缩失败（U6，含原因与是否中止，不再静默）" },

  // ---- 上下文与错误 ----
  { type: "context_compacting", lifecycle: true, persist: true, note: "开始压缩上下文" },
  { type: "context_compacted", lifecycle: true, persist: true, note: "压缩完成" },
  { type: "context_compact_warning", lifecycle: true, persist: true, note: "压缩告警" },
  { type: "agent_error", lifecycle: true, persist: true, note: "模型/Agent 错误" },
  { type: "runtime_error", lifecycle: true, persist: true, note: "运行环境错误" },
  { type: "runtime_health", lifecycle: true, persist: true, note: "运行健康快照" },
  { type: "officecli_failed", lifecycle: true, persist: true, note: "Office CLI 失败" },
  { type: "review_write_blocked", lifecycle: true, persist: true, note: "Review 原文写回被保护拦截" },

  // ---- 完成语义与总结 ----
  { type: "task_completed", lifecycle: true, persist: true, note: "显式完成声明" },
  { type: "agent_summary", lifecycle: true, persist: true, note: "本轮总结" },
  { type: "assistant_final", lifecycle: true, persist: true, note: "最终回答文本" },
  { type: "agent_end", lifecycle: true, persist: true, note: "Agent 收尾" },
  { type: "todo_updated", lifecycle: true, persist: true, note: "待办更新" },
  { type: "step_updated", lifecycle: true, persist: true, note: "步骤状态更新" },
  { type: "stats", lifecycle: true, persist: false, note: "用量统计（每回合一次，不落盘）" },

  // ---- Review 证据链 ----
  { type: "map_action", lifecycle: true, persist: false, note: "地图分析/样式动作（前端实时更新，不落盘）" },
  { type: "review_material_classified", lifecycle: true, persist: true, note: "审查材料识别" },
  { type: "review_source_search_started", lifecycle: true, persist: true, note: "规范检索开始" },
  { type: "review_source_search_result", lifecycle: true, persist: true, note: "规范候选返回" },
  { type: "review_source_read_started", lifecycle: true, persist: true, note: "规范读取开始" },
  { type: "review_source_read", lifecycle: true, persist: true, note: "规范全文读取成功" },
  { type: "review_source_applied", lifecycle: true, persist: true, note: "规范被采用" },
  { type: "review_source_unused", lifecycle: true, persist: true, note: "规范读过未采用" },
  { type: "review_waiting_confirmation", lifecycle: true, persist: true, note: "等待写回确认" },
  { type: "review_confirmed", lifecycle: true, persist: true, note: "用户确认写回" },
  { type: "review_confirmation_rejected", lifecycle: true, persist: true, note: "用户拒绝写回" },

  // ---- 领域工作流硬约束（默认关）----
  { type: "geo_out_of_range", lifecycle: true, persist: true, note: "坐标越出中国范围（经度 73–135°E / 纬度 18–54°N）" },
  { type: "data_integrity_failed", lifecycle: true, persist: true, note: "记录数 expected vs actual 不一致" },
  { type: "artifact_root_violation", lifecycle: true, persist: true, note: "产物路径越出工作区" },
  { type: "preflight_skipped", lifecycle: true, persist: true, note: "用户显式跳过 preflight 硬约束校验" },

  // ---- 记忆治理 ----
  { type: "memory_proposal", lifecycle: true, persist: true, note: "记忆建议提交（UI 事件）" },
  { type: "memory_proposal_updated", lifecycle: true, persist: true, note: "记忆建议内容更新" },
  { type: "memory_proposal_resolved", lifecycle: true, persist: true, note: "记忆建议审核完成" },
  { type: "memory_proposal_created", lifecycle: true, persist: true, note: "记忆建议创建" },
  { type: "memory_proposal_edited", lifecycle: true, persist: true, note: "记忆建议编辑" },
  { type: "memory_proposal_approved", lifecycle: true, persist: true, note: "记忆建议通过" },
  { type: "memory_proposal_rejected", lifecycle: true, persist: true, note: "记忆建议拒绝" },
  { type: "memory_proposal_merged", lifecycle: true, persist: true, note: "记忆建议合并" },
  { type: "memory_proposal_failed", lifecycle: true, persist: true, note: "记忆建议失败" },
  { type: "memory_written", lifecycle: true, persist: true, note: "记忆写入" },
  { type: "memory_file_edited", lifecycle: true, persist: true, note: "记忆文件编辑" },
  { type: "memory_initialized", lifecycle: true, persist: true, note: "记忆初始化" },

  // ---- 高频增量（只走实时推送，可优先淘汰）----
  { type: "token", lifecycle: false, persist: false, note: "回答流式文本" },
  { type: "thinking", lifecycle: false, persist: false, note: "思考流" },
  { type: "tool_output", lifecycle: false, persist: false, note: "工具输出流" },
  { type: "tool_output_delta", lifecycle: false, persist: false, note: "工具输出增量分片（Qoder P0-2 单帧护栏，默认关）", schema: { required: ["output"], types: { output: "string", index: "number", frames: "number" } } },
  { type: "text_boundary", lifecycle: false, persist: false, note: "文本段落边界（打字机）" },
  { type: "thinking_boundary", lifecycle: false, persist: false, note: "思考段落边界" },
] as const satisfies readonly EventSpec[];

export type EventType = (typeof REGISTRY)[number]["type"];

const byType: ReadonlyMap<string, EventSpec> = new Map(REGISTRY.map((item) => [item.type, item as EventSpec]));

export const EVENT_REGISTRY: readonly EventSpec[] = Object.freeze(REGISTRY.map((item) => Object.freeze({ ...item })));
export const EVENT_TYPES = REGISTRY.map((item) => item.type) as EventType[];
/** 生命周期事件：通道历史中不被增量挤出 */
export const LIFECYCLE_EVENT_TYPES: ReadonlySet<EventType> = new Set(EVENT_REGISTRY.filter((item) => item.lifecycle).map((item) => item.type as EventType));
/** 高频增量：不落盘、可优先淘汰 */
export const DELTA_EVENT_TYPES: ReadonlySet<EventType> = new Set(EVENT_REGISTRY.filter((item) => !item.lifecycle && !item.persist).map((item) => item.type as EventType));
/** 需要写入 .oaw/events 事件流的事件 */
export const PERSISTED_TYPES: ReadonlySet<EventType> = new Set(EVENT_REGISTRY.filter((item) => item.persist).map((item) => item.type as EventType));

const SCHEMA_TYPE_CHECKS: Record<EventSchemaType, (value: unknown) => boolean> = {
  string: (value) => typeof value === "string",
  number: (value) => typeof value === "number" && Number.isFinite(value),
  boolean: (value) => typeof value === "boolean",
  object: (value) => value !== null && typeof value === "object" && !Array.isArray(value),
  array: (value) => Array.isArray(value)
};

export interface PayloadValidation {
  ok: boolean;
  skipped: boolean;
  type: string;
  missing: string[];
  wrongType: string[];
}

/** 事件负载结构校验（纯函数：不抛错、不写日志），语义与 server 版一致 */
export function validateEventPayload(type: unknown, data: unknown = {}): PayloadValidation {
  const name = String(type ?? "");
  const schema = byType.get(name)?.schema ?? null;
  if (!schema) return { ok: true, skipped: true, type: name, missing: [], wrongType: [] };
  const payload = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const missing = schema.required.filter((key) => payload[key] === undefined || payload[key] === null);
  const wrongType: string[] = [];
  for (const [key, kind] of Object.entries(schema.types)) {
    if (payload[key] === undefined || !kind) continue;
    if (!SCHEMA_TYPE_CHECKS[kind](payload[key])) wrongType.push(`${key} 期望 ${kind}`);
  }
  return { ok: missing.length === 0 && wrongType.length === 0, skipped: false, type: name, missing, wrongType };
}

export function eventSpec(type: unknown): EventSpec | null {
  return byType.get(String(type ?? "")) ?? null;
}

export function isRegisteredEvent(type: unknown): boolean {
  return byType.has(String(type ?? ""));
}

export function registrySummary(): { total: number; lifecycle: number; persisted: number; delta: number } {
  return {
    total: EVENT_REGISTRY.length,
    lifecycle: LIFECYCLE_EVENT_TYPES.size,
    persisted: PERSISTED_TYPES.size,
    delta: DELTA_EVENT_TYPES.size
  };
}
