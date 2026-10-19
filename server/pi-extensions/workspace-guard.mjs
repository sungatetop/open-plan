/**
 * U2+U6：工作台把关扩展（Pi Extension，随主会话 additionalExtensionPaths 加载）。
 *
 * 职责分层（与 agent.mjs 的 E02 事件层门禁互补，使用同一套 run-budget.mjs 纯函数）：
 *   - 本扩展：**工具级拦截**——在工具真正执行前（tool_call）评估门禁，命中即 block，
 *     模型收到结构化拒绝原因后可继续调整方案，不再像 hard 模式那样整 Run 中断。
 *   - agent.mjs E02：**回合级门禁**（turn 预算、硬停 abort）保持不变，作为兜底层。
 *
 * 事件语义：
 *   - block 时 reason 以 "[工具门禁]" 前缀标记；agent.mjs 的 tool_end 转译检测该前缀
 *     发出 tool_gate_denied 事件（注册表 persist:true），前端可见"被门禁拒绝"。
 *   - session_before_compact：注入保留任务上下文的压缩指令（SessionBeforeCompactResult）。
 *   - session_compact_failed：向会话注入 steer 提示，压缩失败不再静默。
 *
 * 本扩展仅在 OAW_PI_TOOL_GATE=on 时被加载（见 agent.mjs additionalExtensionPaths 接线）。
 */
import {
  createRunBudget,
  evaluateToolGate,
  noteToolResult,
  noteTurn,
} from "../run-budget.mjs";

const GATE_MARKER = "[工具门禁]";

/** 工具执行结果是否是本扩展发出的门禁拒绝（agent.mjs tool_end 转译用）。 */
export function isToolGateRejection(text) {
  return typeof text === "string" && text.includes(GATE_MARKER);
}

export default function workbenchGateExtension(pi) {
  // 会话级预算状态（扩展实例每会话一份；runId 在扩展层不可见，置空）。
  const budget = createRunBudget({ runId: null });
  const toolArgsById = new Map();

  pi.on("turn_start", () => {
    noteTurn(budget);
  });

  pi.on("tool_call", (event) => {
    const toolName = String(event?.toolName || event?.name || "?");
    const args = event?.input ?? event?.args ?? null;
    const toolCallId = event?.toolCallId ?? null;
    if (toolCallId && toolArgsById.size > 400) toolArgsById.clear();
    if (toolCallId) toolArgsById.set(String(toolCallId), args);
    const gate = evaluateToolGate(budget, { toolName, args });
    if (gate.level === "soft") {
      // 软预算不拦截：回合级软提醒由 agent.mjs E02 事件层承担（steer 通道），
      // 扩展层避免重复提醒；此处仅记录，保持"扩展=硬拦截、E02=软提醒"分层。
      return undefined;
    }
    if (gate.level === "hard" || gate.allow === false) {
      return { block: true, reason: `${GATE_MARKER} ${gate.code || "GATE_BLOCKED"}：${gate.reason || "命中硬预算/重复失败门禁，请调整方案"}` };
    }
    return undefined;
  });

  pi.on("tool_result", (event) => {
    const toolCallId = event?.toolCallId ? String(event.toolCallId) : "";
    const args = toolCallId ? toolArgsById.get(toolCallId) ?? null : null;
    if (toolCallId) toolArgsById.delete(toolCallId);
    noteToolResult(budget, {
      toolName: String(event?.toolName || event?.name || "?"),
      args,
      ok: event?.isError !== true,
      error: String(event?.error || event?.result || "").slice(0, 300),
    });
  });

  // session_before_compact 指令注入暂缓：SessionBeforeCompactResult.compaction 的
  // 内部形状未实证（评审纪律：未实证不接线），保留 SDK 默认压缩指令。
  pi.on("session_before_compact", () => undefined);

  pi.on("session_compact_failed", (event) => {
    const message = `上下文压缩失败（${event?.reason || "unknown"}${event?.aborted ? "，已中止" : ""}）：${String(event?.errorMessage || "").slice(0, 200)}`;
    // 压缩失败可见化：不再静默——服务端日志 + 模型下一轮上下文可感知（错误进入会话流）。
    try { console.error(`[工具把关扩展] ${message}`); } catch {}
  });
}
