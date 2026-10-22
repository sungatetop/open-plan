/**
 * Agent 用量/文本归一工具族（B6-6-1，自 server/agent.mjs L227-288 逐行转录）。
 *
 * - limitToolText：工具输出首尾保留截断（16k 预算，头 72% / 尾 28%）
 * - assistantText / eventValueText：消息与事件负载的文本抽取
 * - normalizeUsage / usageFromEvent：跨供应商 usage 字段归一
 */
export const TOOL_OUTPUT_MAX_CHARS = 16000;

export function limitToolText(value: unknown, max = TOOL_OUTPUT_MAX_CHARS): string {
  const text = String(value ?? "");
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.72);
  const tail = max - head;
  return `${text.slice(0, head)}\n\n...[输出已截断，原始长度 ${text.length} 字符；请使用分段读取继续获取]...\n\n${text.slice(-tail)}`;
}

export function assistantText(message: unknown): string {
  const content = (message as { content?: unknown } | null | undefined)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => (part as { type?: unknown } | null)?.type === "text")
    .map((part) => String((part as { text?: unknown })?.text || ""))
    .join("");
}

export function eventValueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try { return limitToolText(JSON.stringify(value, null, 2)); } catch { return limitToolText(String(value)); }
}

export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  context: number;
  totalTokens: number;
}

export function normalizeUsage(raw: unknown): NormalizedUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const pick = (...keys: string[]): number => {
    for (const key of keys) {
      const value = Number(record[key]);
      if (Number.isFinite(value) && value >= 0) return value;
    }
    return 0;
  };
  const input = pick("inputTokens", "input_tokens", "input");
  const output = pick("outputTokens", "output_tokens", "output");
  const cacheRead = pick("cacheReadTokens", "cache_read_input_tokens", "cacheRead", "cache_read");
  const cacheWrite = pick("cacheWriteTokens", "cache_creation_input_tokens", "cacheWrite", "cache_write");
  const context = pick("contextTokens", "context_tokens", "context") || input + cacheRead + cacheWrite;
  const total = pick("totalTokens", "total_tokens", "total") || input + output + cacheRead + cacheWrite;
  if (!(input || output || cacheRead || cacheWrite || context || total)) return null;
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    input,
    output,
    cacheRead,
    cacheWrite,
    context,
    totalTokens: total,
  };
}

export function usageFromEvent(event: unknown): NormalizedUsage | null {
  const e = event as { usage?: unknown; tokens?: unknown; message?: { usage?: unknown; tokens?: unknown }; response?: { usage?: unknown }; result?: { usage?: unknown } } | null | undefined;
  const candidates = [e?.usage, e?.tokens, e?.message?.usage, e?.message?.tokens, e?.response?.usage, e?.result?.usage];
  for (const candidate of candidates) {
    const usage = normalizeUsage(candidate);
    if (usage) return usage;
  }
  return null;
}
