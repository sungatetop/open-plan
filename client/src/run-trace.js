// 运行轨迹归约：把原始事件流（SSE 实时事件或 Run.events 历史）归约为
// 可渲染的执行轨迹。实时流与历史恢复共用同一归约器，保证两侧展示一致。
//
// 归约产物：
//   - tools：按 toolCallId 聚合的工具记录（start/output/end 合成一条）
//   - files：本轮文件变更（去重）
//   - errors：模型/工具错误
//   - completion：完成语义（显式 task_completed 优先，否则按 run_finished 推断）
//   - phase：准备 → 执行 → 整理产物 → 完成/失败/取消

export const COMPLETION_LABELS = Object.freeze({
  success: "已完成",
  partial: "部分完成",
  blocked: "受阻",
  failed: "失败",
  cancelled: "已取消",
});

export const PHASE_LABELS = Object.freeze({
  idle: "等待",
  planning: "计划",
  executing: "执行",
  verifying: "验证",
  delivering: "交付",
  done: "完成",
  failed: "失败",
  cancelled: "已取消",
  // 兼容旧数据/旧事件（preparing 曾用于 run_admitting 阶段）
  preparing: "计划",
  finishing: "交付",
});

export function completionLabel(status) {
  return COMPLETION_LABELS[status] || "已结束";
}

export function createRunTrace(runId = null) {
  return {
    runId,
    phase: "idle",
    phases: [],
    tools: [],
    // 子代理：按 childId 聚合（planned/started/progress/tool/result/verified/closed 合成一条）
    subagents: [],
    // Editorial Pipeline（§5.2）：阶段条（planner→writer→formatter→evaluator），可折叠展示
    pipeline: null,
    files: [],
    errors: [],
    todos: [],
    // 进度叙事：模型回合数、周期进度小结（steer）与耗时，供「执行过程」头行展示
    turns: 0,
    notes: [],
    durationMs: null,
    verification: null,
    completion: null,
    startedAt: null,
    endedAt: null,
  };
}

function eventKey(event) {
  if (event?.key) return String(event.key);
  const at = event?.at || "";
  const seq = event?.seq ?? event?.id ?? "";
  return `${event?.type || "?"}|${at}|${seq}|${event?.data?.toolCallId || ""}`;
}

function setPhase(trace, phase, at) {
  if (trace.phase === phase) return;
  trace.phase = phase;
  trace.phases.push({ phase, at: at || new Date().toISOString() });
}

/** 阶段只能前进（计划 → 执行 → 验证 → 交付）：后到的早期事件不把阶段拉回去。 */
export const PHASE_ORDER = Object.freeze(["idle", "planning", "executing", "verifying", "delivering", "done"]);
function advancePhase(trace, phase, at) {
  const current = PHASE_ORDER.indexOf(trace.phase === "preparing" ? "planning" : trace.phase === "finishing" ? "delivering" : trace.phase);
  const next = PHASE_ORDER.indexOf(phase);
  if (next < 0) return;
  if (current >= 0 && current >= next) return;
  setPhase(trace, phase, at);
}

/** 子代理按 childId 聚合；缺失时用 parentToolCallId 兜底，保证回放也能重建卡片。 */
function upsertSubagent(trace, data, at, { status = "running" } = {}) {
  const id = String(data?.childId || data?.parentToolCallId || `subagent:${trace.subagents.length}`);
  let sub = trace.subagents.find((item) => item.id === id);
  if (!sub) {
    sub = {
      id,
      parentToolCallId: data?.parentToolCallId ? String(data.parentToolCallId) : null,
      role: String(data?.role || "scout"),
      task: String(data?.task || ""),
      status,
      activity: "",
      thinking: "",
      preview: "",
      summary: "",
      output: "",
      error: "",
      verdict: null,
      checklist: [],
      tools: [],
      transcript: [],
      startAt: at,
      endAt: null,
    };
    trace.subagents.push(sub);
  } else {
    if (data?.parentToolCallId && !sub.parentToolCallId) sub.parentToolCallId = String(data.parentToolCallId);
    // planned → running 只前进；status=null 表示本次事件不改写状态（如 verified）；
    // closed 的 finalStatus 在调用方显式写入，是权威终态
    if (status === "planned" && sub.status === "planned") sub.status = "planned";
    else if (status && status !== "planned" && sub.status === "planned") sub.status = status;
  }
  return sub;
}

function findTool(trace, data) {
  const toolCallId = data?.toolCallId ? String(data.toolCallId) : "";
  if (toolCallId) {
    const byId = trace.tools.find((tool) => tool.toolCallId === toolCallId);
    if (byId) return byId;
  }
  if (data?.name) {
    for (let i = trace.tools.length - 1; i >= 0; i -= 1) {
      const tool = trace.tools[i];
      if (tool.name === data.name && !tool.toolCallId) return tool;
    }
  }
  return null;
}

export function applyRunTraceEvent(trace, event) {
  const type = String(event?.type || "");
  const data = event?.data || {};
  const at = event?.at || new Date().toISOString();
  switch (type) {
    case "run_admitting":
    case "run_admitted":
      if (!trace.startedAt) trace.startedAt = at;
      setPhase(trace, "planning", at);
      break;
    case "turn_started":
      // 模型回合计数：进度行用它表达"第 N 轮"，跨实时流与历史回放一致
      trace.turns = Number(trace.turns || 0) + 1;
      break;
    case "steer": {
      // 周期进度播报与轮次预算提醒：作为进度时间线上的里程碑保留
      const source = String(data.source || "user");
      if (source === "turn-progress" || source.startsWith("turn-budget")) {
        trace.notes.push({
          id: `${source}:${data.turnCount ?? trace.turns}:${String(data.message || "").slice(0, 40)}`,
          source,
          message: String(data.message || "").slice(0, 300),
          turnCount: Number(data.turnCount || trace.turns || 0),
          at,
        });
      }
      break;
    }
    case "capability_plan":
    case "mode_policy":
      if (!trace.startedAt) trace.startedAt = at;
      advancePhase(trace, "planning", at);
      break;
    case "tool_start": {
      if (!trace.startedAt) trace.startedAt = at;
      advancePhase(trace, "executing", at);
      const existing = findTool(trace, data);
      if (existing) {
        if (existing.status !== "done") existing.status = "running";
        if (!existing.startAt) existing.startAt = at;
        break;
      }
      trace.tools.push({
        id: data.toolCallId || `${data.name || "tool"}:${trace.tools.length}`,
        toolCallId: data.toolCallId ? String(data.toolCallId) : null,
        name: data.name || "tool",
        input: data.input || "",
        output: "",
        result: "",
        isError: false,
        status: "running",
        startAt: at,
        endAt: null,
        duration: null,
        startMissing: false,
      });
      break;
    }
    // tool_output_delta 为 P0-2 单帧护栏的增量帧（服务端开关打开时才出现）：
    // 不带 replace，走到下面的 `data.replace ? ... : 追加` 分支即「纯追加」，与 tool_output 同义。
    case "tool_output":
    case "tool_output_delta": {
      const tool = findTool(trace, data);
      if (!tool) break;
      const chunk = runToolDetailText({ output: data.output ?? data.text });
      if (!chunk) break;
      tool.output = data.replace ? chunk : (tool.output || "") + chunk;
      break;
    }
    case "tool_end": {
      let tool = findTool(trace, data);
      if (!tool) {
        // start 事件已被历史淘汰或重连丢失：创建带恢复标记的记录，
        // 保证工具数量与实际执行一致。
        tool = {
          id: data.toolCallId || `${data.name || "tool"}:${trace.tools.length}`,
          toolCallId: data.toolCallId ? String(data.toolCallId) : null,
          name: data.name || "tool",
          input: "",
          output: "",
          result: "",
          isError: false,
          status: "running",
          startAt: null,
          endAt: null,
          duration: null,
          startMissing: true,
        };
        trace.tools.push(tool);
      }
      tool.status = "done";
      tool.isError = !!data.isError;
      if (data.result !== undefined && data.result !== null) tool.result = runToolDetailText({ result: data.result }).slice(0, 4000);
      tool.endAt = at;
      if (tool.startAt) {
        const ms = new Date(at).getTime() - new Date(tool.startAt).getTime();
        if (Number.isFinite(ms) && ms >= 0) tool.duration = Number((ms / 1000).toFixed(1));
      }
      break;
    }
    case "subagent_planned": {
      // 方案 §3.4：编排器先发 planned（roster 持久化锚点），此后 started/progress/tool/result 跟进
      if (!trace.startedAt) trace.startedAt = at;
      advancePhase(trace, "executing", at);
      upsertSubagent(trace, data, at, { status: "planned" });
      if (Array.isArray(data.tools)) {
        const sub = upsertSubagent(trace, data, at, { status: "planned" });
        sub.tools = data.tools.map((name, index) => ({ toolCallId: null, name: String(name || "tool"), status: "planned", isError: false, order: index }));
      }
      break;
    }
    case "subagent_start":
    case "subagent_started": {
      if (!trace.startedAt) trace.startedAt = at;
      advancePhase(trace, "executing", at);
      const sub = upsertSubagent(trace, data, at);
      if (sub.status === "planned") sub.status = "running";
      break;
    }
    case "subagent_update":
    case "subagent_progress": {
      const sub = upsertSubagent(trace, data, at);
      if (sub.status === "planned") sub.status = "running";
      if (data.activity) sub.activity = String(data.activity).slice(0, 200);
      if (data.phase) sub.activity = String(data.phase).slice(0, 200);
      if (data.thinking) sub.thinking = String(data.thinking).slice(-600);
      if (data.preview) sub.preview = String(data.preview).slice(-600);
      break;
    }
    case "subagent_tool": {
      const sub = upsertSubagent(trace, data, at);
      const childToolCallId = data.toolCallId ? String(data.toolCallId) : null;
      let tool = childToolCallId ? sub.tools.find((item) => item.toolCallId === childToolCallId) : null;
      if (!tool) {
        tool = { toolCallId: childToolCallId, name: String(data.toolName || "read"), status: "running", isError: false };
        sub.tools.push(tool);
      }
      if (data.status === "end") {
        tool.status = "done";
        tool.isError = data.isError === true;
      } else {
        tool.status = "running";
      }
      break;
    }
    case "subagent_end": {
      const sub = upsertSubagent(trace, data, at);
      sub.status = String(data.status || "completed");
      if (data.summary) sub.summary = String(data.summary);
      if (data.error) sub.error = String(data.error).slice(0, 600);
      if (Array.isArray(data.transcript)) sub.transcript = data.transcript.slice(-40);
      sub.endAt = at;
      break;
    }
    case "subagent_result": {
      // §3.4：结构化结果（status/output/artifacts/toolStats）；同一 childId 可能因 revise 回环多次 result，取最后一次
      const sub = upsertSubagent(trace, data, at);
      sub.status = String(data.status || sub.status || "completed");
      if (data.output !== undefined && data.output !== null) sub.summary = String(data.output).slice(0, 9000);
      if (Array.isArray(data.artifacts)) sub.artifacts = data.artifacts.map((item) => String(item?.path || item || "")).filter(Boolean);
      if (data.toolStats && typeof data.toolStats === "object") sub.toolStats = data.toolStats;
      if (Array.isArray(data.transcript)) sub.transcript = data.transcript.slice(-40);
      break;
    }
    case "subagent_verified": {
      // 核验结论不改写子代理状态（revise 回环由编排器事件推进；closed 才是终态）
      const sub = upsertSubagent(trace, data, at, { status: null });
      sub.verdict = String(data.verdict || "");
      sub.checklist = Array.isArray(data.checklist) ? data.checklist.slice(0, 40).map((item) => ({
        item: String(item?.item || item || "").slice(0, 300),
        ok: item?.ok !== false,
      })) : [];
      if (data.notes) sub.verifyNotes = String(data.notes).slice(0, 1200);
      break;
    }
    case "subagent_closed": {
      const sub = upsertSubagent(trace, data, at);
      sub.status = String(data.finalStatus || sub.status || "completed");
      sub.endAt = at;
      break;
    }
    case "file_changed": {
      const files = Array.isArray(data.files) ? data.files : [];
      for (const file of files) {
        const value = String(file || "").replace(/\\/g, "/");
        if (value && !trace.files.includes(value)) trace.files.push(value);
      }
      break;
    }
    // ---- Editorial Pipeline（§5.2）：阶段条归约，实时与回放共用 ----
    case "pipeline_started": {
      if (!trace.startedAt) trace.startedAt = at;
      advancePhase(trace, "executing", at);
      trace.pipeline = { id: String(data.pipelineId || "pipeline"), stages: [], status: "running", deliverable: null, startedAt: at, endedAt: null };
      break;
    }
    case "pipeline_stage_started":
    case "pipeline_stage_finished": {
      const started = type === "pipeline_stage_started";
      if (!trace.pipeline) {
        trace.pipeline = { id: String(data.pipelineId || "pipeline"), stages: [], status: "running", deliverable: null, startedAt: at, endedAt: null };
      }
      const stageId = String(data.stage || `stage${trace.pipeline.stages.length + 1}`);
      let stage = trace.pipeline.stages.find((item) => item.stage === stageId);
      if (!stage) {
        stage = { stage: stageId, label: String(data.label || ""), status: "running", artifact: "", checks: [], startedAt: at, endedAt: null };
        trace.pipeline.stages.push(stage);
      }
      if (started) {
        stage.status = "running";
        stage.startedAt = at;
        if (data.label) stage.label = String(data.label);
      } else {
        stage.status = String(data.status || "done");
        stage.endedAt = at;
        if (data.artifact) stage.artifact = String(data.artifact);
        if (Array.isArray(data.checks)) stage.checks = data.checks.slice(0, 30).map((item) => String(item).slice(0, 200));
        if (data.error) stage.error = String(data.error).slice(0, 400);
      }
      break;
    }
    case "pipeline_finished": {
      if (trace.pipeline) {
        trace.pipeline.status = String(data.status || "completed");
        trace.pipeline.endedAt = at;
        if (data.deliverable) trace.pipeline.deliverable = String(data.deliverable);
      }
      break;
    }
    case "officecli_failed":
      trace.errors.push({ message: String(data.message || "Office CLI 失败").slice(0, 300), at, type });
      break;
    case "agent_error":
      trace.errors.push({ message: String(data.message || "模型调用失败").slice(0, 300), at, type });
      break;
    case "todo_updated": {
      advancePhase(trace, "planning", at);
      // 计划进度：最后一次完整快照即当前计划（服务端每次提交完整清单）
      const items = Array.isArray(data.items) ? data.items : [];
      trace.todos = items.map((item, index) => ({
        id: String(item?.id || `t${index + 1}`),
        title: String(item?.title || "").slice(0, 120),
        status: String(item?.status || "planned"),
      }));
      break;
    }
    case "task_completed":
      if (data.status) {
        trace.completion = {
          status: String(data.status),
          source: data.source || "explicit",
          summary: String(data.summary || ""),
          incomplete: Array.isArray(data.incomplete) ? data.incomplete : [],
          blockers: Array.isArray(data.blockers) ? data.blockers : [],
          verification: data.verification || null,
          at,
        };
      }
      break;
    case "artifacts_validated":
      trace.verification = data.status || trace.verification || "not_checked";
      advancePhase(trace, "verifying", at);
      break;
    case "artifact_staged":
    case "artifact_materialized":
    case "artifact_published":
      advancePhase(trace, "delivering", at);
      break;
    case "agent_end":
      if (!trace.completion) advancePhase(trace, "delivering", at);
      // 服务端 agent_end 带上本轮轮次/工具/耗时；旧服务端没有该字段时保留本地统计
      if (Number(data.turns) > 0) trace.turns = Math.max(Number(trace.turns || 0), Number(data.turns));
      if (Number(data.durationMs) > 0) trace.durationMs = Number(data.durationMs);
      break;
    case "run_finished": {
      trace.endedAt = at;
      if (!(Number(trace.durationMs) > 0) && trace.startedAt) {
        const ms = new Date(at).getTime() - new Date(trace.startedAt).getTime();
        if (Number.isFinite(ms) && ms > 0) trace.durationMs = ms;
      }
      const status = String(data.status || "completed");
      // 验收状态：发布前预检 + 显式校验的结果，未检查时如实显示
      trace.verification = data.verificationStatus || trace.verification || "not_checked";
      // 服务端 run_finished 携带的 completion 是权威结果（显式或推断），优先采用；
      // 旧服务端没有该字段时才本地推断。
      if (data.completion && typeof data.completion === "object" && data.completion.status) {
        trace.completion = { ...data.completion, at };
      } else if (!trace.completion) {
        trace.completion = {
          status: status === "completed" ? "success" : status === "cancelled" || status === "aborted" ? "cancelled" : "failed",
          source: "inferred",
          summary: String(data.summary || ""),
          incomplete: [],
          blockers: [],
          verification: data.verificationStatus && data.verificationStatus !== "not_checked" ? data.verificationStatus : null,
          at,
        };
      }
      const phase = trace.completion.status === "failed"
        ? "failed"
        : trace.completion.status === "cancelled"
          ? "cancelled"
          : "done";
      setPhase(trace, phase, at);
      break;
    }
    default:
      break;
  }
  return trace;
}

/** 从事件数组重建运行轨迹；重复事件按 key 幂等去重（重连回放安全）。 */
export function reduceRunTrace(events = [], runId = null) {
  const trace = createRunTrace(runId);
  const seen = new Set();
  for (const event of events) {
    const key = eventKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    applyRunTraceEvent(trace, event);
  }
  return trace;
}

/** 折叠态聚合统计：工具数量、成功/失败/执行中、文件与错误计数、计划进度与验收。 */
export function summarizeRunTrace(trace) {
  const tools = trace?.tools || [];
  const ok = tools.filter((tool) => tool.status === "done" && !tool.isError).length;
  const failed = tools.filter((tool) => tool.status === "done" && tool.isError).length;
  const running = tools.filter((tool) => tool.status !== "done").length;
  const todos = trace?.todos || [];
  const todoDone = todos.filter((todo) => todo.status === "completed").length;
  const todoUnfinished = todos.filter((todo) => !["completed", "skipped"].includes(todo.status)).length;
  return {
    toolTotal: tools.length,
    toolOk: ok,
    toolFailed: failed,
    toolRunning: running,
    subagentTotal: (trace?.subagents || []).length,
    subagentRunning: (trace?.subagents || []).filter((item) => !["completed", "failed", "cancelled"].includes(item.status)).length,
    pipelineStages: (trace?.pipeline?.stages || []).length,
    pipelineRunning: (trace?.pipeline?.status || "idle") === "running",
    fileCount: (trace?.files || []).length,
    errorCount: (trace?.errors || []).length,
    todoTotal: todos.length,
    todoDone,
    todoUnfinished,
    turns: Number(trace?.turns || 0),
    noteCount: (trace?.notes || []).length,
    durationMs: Number(trace?.durationMs || 0),
    startedAt: trace?.startedAt || null,
    verification: trace?.verification || "not_checked",
    completion: trace?.completion || null,
    phase: trace?.phase || "idle",
  };
}

/**
 * 回合级指标（每轮用时与 token）。
 *
 * 数据来源：服务端持久化的 turn_started / turn_ended（时间戳、工具数）与 stats
 * （每回合一次的 usage：输入/输出/缓存/上下文）。两者都在 Run.events 里，因此
 * 实时流与历史回放算出来一致——这正是"每一轮用时 + token 数"要记录的东西。
 * 缺失的字段保持 null，不编造数字。
 */
export function reduceTurnMetrics(events = []) {
  const turns = [];
  const current = () => turns[turns.length - 1] || null;
  const ensureTurn = (at) => {
    if (!current()) turns.push({ index: 1, startedAt: at || null, endedAt: null, toolCount: null, tokens: null });
    return current();
  };
  for (const event of Array.isArray(events) ? events : []) {
    const at = event?.at || null;
    const data = event?.data || {};
    switch (String(event?.type || "")) {
      case "turn_started":
        turns.push({ index: turns.length + 1, startedAt: at, endedAt: null, toolCount: null, tokens: null });
        break;
      case "stats": {
        const tokens = normalizeTurnTokens(data.tokens || data.usage);
        if (!tokens) break;
        const target = ensureTurn(at);
        // 同一回合可能收到多条 stats（重试/多次 usage），保留信息更全的一条。
        target.tokens = target.tokens && Number(target.tokens.output) > Number(tokens.output) ? target.tokens : tokens;
        break;
      }
      case "turn_ended": {
        const target = current();
        if (!target) break;
        target.endedAt = at;
        target.toolCount = Number.isFinite(Number(data.toolCount)) ? Number(data.toolCount) : null;
        break;
      }
      case "agent_end":
      case "run_finished": {
        const target = current();
        if (target && !target.endedAt) target.endedAt = at;
        break;
      }
      default:
        break;
    }
  }
  return turns.map((turn) => ({
    ...turn,
    durationMs: turn.startedAt && turn.endedAt
      ? Math.max(0, new Date(turn.endedAt).getTime() - new Date(turn.startedAt).getTime())
      : null,
  }));
}

/** stats.tokens → 只保留可用的数字字段（缺失为 null，不用 0 冒充）。 */
function normalizeTurnTokens(input) {
  if (!input || typeof input !== "object") return null;
  const pick = (...keys) => {
    for (const key of keys) {
      const value = Number(input[key]);
      if (Number.isFinite(value)) return value;
    }
    return null;
  };
  const tokens = {
    input: pick("inputTokens", "input"),
    output: pick("outputTokens", "output"),
    cacheRead: pick("cacheReadTokens", "cacheRead"),
    cacheWrite: pick("cacheWriteTokens", "cacheWrite"),
    context: pick("context", "contextTokens"),
    total: pick("totalTokens", "total"),
  };
  return Object.values(tokens).some((value) => value !== null) ? tokens : null;
}

/** 回合指标合计：轮数、用时、输入/输出/缓存/上下文（只累加真实存在的值）。 */
export function summarizeTurnMetrics(turns = []) {
  const list = Array.isArray(turns) ? turns : [];
  const sum = (key) => {
    const values = list.map((turn) => turn?.tokens?.[key]).filter((value) => Number.isFinite(value));
    return values.length ? values.reduce((total, value) => total + value, 0) : null;
  };
  const durations = list.map((turn) => turn?.durationMs).filter((value) => Number.isFinite(value));
  return {
    turnCount: list.length,
    durationMs: durations.length ? durations.reduce((total, value) => total + value, 0) : null,
    input: sum("input"),
    output: sum("output"),
    cacheRead: sum("cacheRead"),
    cacheWrite: sum("cacheWrite"),
    // 上下文是"每回合结束时的规模"，合计没有意义，取最后一轮的实测值。
    context: [...list].reverse().map((turn) => turn?.tokens?.context).find((value) => Number.isFinite(value)) ?? null,
    measuredTurns: list.filter((turn) => turn?.tokens).length,
  };
}

/** token 数文案：292 / 1.2k / 184.2k（超过 100 万才用 M）；未知值返回空串。 */
export function formatTokenCount(value) {
  if (value === null || value === undefined || value === "") return "";
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return "";
  if (number < 1000) return String(Math.round(number));
  if (number < 1000000) {
    const k = number / 1000;
    return `${k < 10 ? k.toFixed(1).replace(/\.0$/, "") : Math.round(k)}k`;
  }
  const m = number / 1000000;
  return `${m < 10 ? m.toFixed(1).replace(/\.0$/, "") : Math.round(m)}M`;
}

/** 本轮指标文案：用时 3 分 12 秒 · 13 轮 · 输入 26.2k tokens · 输出 1.4k tokens */
export function turnMetricsText(totals, { durationMs = null } = {}) {
  if (!totals) return "";
  const parts = [];
  const elapsed = Number(durationMs ?? totals.durationMs);
  if (Number.isFinite(elapsed) && elapsed > 0) parts.push(`用时 ${formatDuration(elapsed)}`);
  if (totals.turnCount) parts.push(`${totals.turnCount} 轮`);
  if (Number.isFinite(totals.input)) parts.push(`输入 ${formatTokenCount(totals.input)} tokens`);
  if (Number.isFinite(totals.output)) parts.push(`输出 ${formatTokenCount(totals.output)} tokens`);
  if (Number.isFinite(totals.cacheRead) && totals.cacheRead > 0) parts.push(`缓存读 ${formatTokenCount(totals.cacheRead)} tokens`);
  return parts.join(" · ");
}

/** 耗时文案：45 秒 / 3 分 12 秒 / 1 小时 2 分 */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms || 0) / 1000));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

/** 运行中进度行只保留用户可行动的工具、待办与耗时，不暴露 harness 轮次计数。 */
export function runTraceProgressText(trace, { now = Date.now(), running = false } = {}) {
  const stats = summarizeRunTrace(trace);
  const parts = [];
  if (stats.toolTotal) parts.push(`工具 ${stats.toolTotal}`);
  if (stats.todoTotal) parts.push(`待办 ${stats.todoDone}/${stats.todoTotal}`);
  const startedAt = stats.startedAt ? new Date(stats.startedAt).getTime() : 0;
  const elapsed = running && startedAt ? now - startedAt : stats.durationMs;
  if (elapsed > 0) parts.push(`用时 ${formatDuration(elapsed)}`);
  if (stats.noteCount) parts.push(`进度小结 ${stats.noteCount} 次`);
  return parts.join(" · ");
}

/** 验收状态文案：与产物验证（发布前预检、显式校验）保持一致。 */
export function verificationLabel(status) {
  return {
    passed: "验收通过",
    warning: "验收有提示",
    failed: "验收失败",
    manual_review: "待人工确认",
    pending: "验证中",
    not_checked: "未验收",
  }[String(status || "not_checked")] || "未验收";
}

/** 工具时间线的紧凑明细：兼容文本与结构化输入/输出，不出现 [object Object]。 */
export function runToolDetailText(tool = {}) {
  for (const value of [tool.output, tool.result, tool.input]) {
    if (value === undefined || value === null) continue;
    let text = "";
    if (typeof value === "string") text = value;
    else {
      try { text = JSON.stringify(value, null, 2) ?? String(value); }
      catch { text = String(value); }
    }
    text = text.trim();
    if (text && text !== "[object Object]") return text;
  }
  return "";
}

/** 折叠态一行摘要，例如：已调用 6 个工具 · 5 成功 · 待办 3/4 · 验收通过 · 2 个文件变更 */
export function runTraceSummaryText(trace) {
  const stats = summarizeRunTrace(trace);
  const parts = [];
  if (stats.toolTotal) {
    parts.push(`已调用 ${stats.toolTotal} 个工具`);
    const details = [];
    if (stats.toolOk) details.push(`${stats.toolOk} 成功`);
    if (stats.toolFailed) details.push(`${stats.toolFailed} 失败`);
    if (stats.toolRunning) details.push(`${stats.toolRunning} 执行中`);
    if (details.length) parts.push(details.join(" · "));
  }
  if (stats.todoTotal) {
    parts.push(`待办 ${stats.todoDone}/${stats.todoTotal}${stats.todoUnfinished ? `（未完成 ${stats.todoUnfinished}）` : ""}`);
  }
  if (stats.subagentTotal) {
    parts.push(`子 Agent ${stats.subagentTotal}${stats.subagentRunning ? `（${stats.subagentRunning} 进行中）` : ""}`);
  }
  if (stats.fileCount) parts.push(`${stats.fileCount} 个文件变更`);
  if (stats.errorCount) parts.push(`${stats.errorCount} 次错误`);
  // 验收只在有产物或明确校验过时展示，避免每个纯问答回合都写"未验收"
  if (stats.fileCount || stats.verification !== "not_checked") parts.push(verificationLabel(stats.verification));
  if (stats.completion) parts.push(completionLabel(stats.completion.status));
  return parts.join(" · ");
}
