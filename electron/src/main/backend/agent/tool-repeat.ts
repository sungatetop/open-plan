/**
 * 重复工具调用提醒（B6-6-4f，自 server/agent.mjs L357-362/L406-422 逐行转录）。
 *
 * 同一 Run 内同一「工具+参数指纹」连续第 REPEATED_TOOL_WARN_AT 次调用且没有进展时，
 * 产出 tool_repeat_warning 事件并向 Pi 会话注入 steer 提醒，督促模型换方案；
 * 提醒失败不影响工具执行（整段 try/catch 吞错）。
 */

/** 同一操作第 N 次重复时提醒（agent.mjs L357）。 */
export const REPEATED_TOOL_WARN_AT = 3;

/** 工具调用指纹（agent.mjs L359-362）：name + 归一化参数文本前 300 字符。 */
export function toolFingerprint(name: unknown, args: unknown): string {
  const text = typeof args === "string" ? args : JSON.stringify(args ?? {});
  return `${String(name || "?")}::${String(text || "").replace(/\s+/g, " ").trim().slice(0, 300)}`;
}

/** 记录一次工具调用并在达到重复阈值时提醒（agent.mjs L406-422，旧侧 export）。 */
export function noteRepeatedToolCall(entry: any, session: any, ev: any, emit: (type: string, data: any) => void): void {
  try {
    const name = String(ev?.toolName || "?");
    const runId = entry?.activeRunId || "none";
    if (!entry.toolRepeat || entry.toolRepeat.runId !== runId) {
      entry.toolRepeat = { runId, counts: new Map(), warned: new Set() };
    }
    const key = toolFingerprint(name, ev?.args);
    const count = (entry.toolRepeat.counts.get(key) || 0) + 1;
    entry.toolRepeat.counts.set(key, count);
    if (count < REPEATED_TOOL_WARN_AT || entry.toolRepeat.warned.has(key)) return;
    entry.toolRepeat.warned.add(key);
    emit("tool_repeat_warning", { name, count, input: key.slice(0, 220) });
    const notice = `[系统提醒] 「${name}」的同一操作已第 ${count} 次用相同参数调用且没有进展。请立即改变方案：换工具、换参数、先诊断失败原因，或调用 ask_user 询问用户；不要继续用相同参数重试。`;
    Promise.resolve(session?.steer?.(notice)).catch(() => {});
  } catch { /* 提醒失败不影响工具执行 */ }
}
