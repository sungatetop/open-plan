/**
 * 会话历史重建（F3 批7b：自 client/src/App.jsx 拆出，与原实现逐行等价）。
 *
 * 覆盖 App.jsx 的三段纯逻辑：
 *   - 历史引用/持久化文本清洗等工具（historyReferences / cleanPersistedMessage，
 *     源 32-63 行）；
 *   - 历史消息工具（histId / historyImageData / entryCreatedAt / sameWorkspacePath /
 *     fileBasename，源 128-156 行）；
 *   - handleSelectSession 内的 JSONL 条目重建循环与 Run 总结插回（源 994-1091 行）。
 *
 * 对拍口径：工具函数以旧源码运行时抽取求值（tests/f3-batch7b-parity）多样本 deep-equal；
 * 重建主循环行为与旧侧同流样本比对。
 */
import { normalizeHistoryMessages, type ChatBlock, type ChatMessage } from "../../lib/chat-shared";

// ============================================================================
// 历史引用与文本清洗（App.jsx 32-63 行逐行转录）
// ============================================================================

export function historyReferences(text = ""): Array<{ id: string; kind: string; target: string; source: string }> {
  const refs: Array<{ id: string; kind: string; target: string; source: string }> = [];
  const seen = new Set<string>();
  const add = (kind: string, target: unknown, source: string): void => {
    const value = String(target || "").trim();
    if (!value) return;
    const id = `history_ref_${kind}_${value}`;
    if (seen.has(id)) return;
    seen.add(id);
    refs.push({ id, kind, target: value, source });
  };
  for (const m of String(text).matchAll(/@(知识库目录|知识库|模板目录|模板|文件)\[([^\]]+)\]/g)) {
    add(
      ({ 知识库目录: "knowledge_dir", 知识库: "knowledge", 模板目录: "template_dir", 模板: "template", 文件: "file" } as Record<string, string>)[m[1] ?? ""] ?? "",
      m[2],
      m[0]
    );
  }
  for (const m of String(text).matchAll(/(^|[\s(])@([^\s@，。！？\]}]+)/g)) {
    const target = (m[2] ?? "").replace(/[),;。！？]+$/, "");
    if (target.includes("/") || target.includes("\\") || /\.(docx|xlsx|pptx|pdf|csv|json|md|markdown|txt|html|htm)$/i.test(target)) add("file", target, `@${target}`);
  }
  for (const m of String(text).matchAll(/&会话\[([^\]]+)\]/g)) add("session", m[1], m[0]);
  return refs;
}

export function cleanPersistedMessage(text = ""): string {
  const source = String(text || "");
  const inlineTaskGoal = source.match(/^#{1,6}\s*当前任务目标\s*[:：]\s*([^\n]+)/i);
  if (inlineTaskGoal?.[1]) return inlineTaskGoal[1].trim();
  const envelopeGoal = source.match(/^\s*#{1,6}\s*当前任务(?:\s+|\n)+(?:目标|任务目标)\s*[:：]\s*([\s\S]*?)(?=(?:\s+|\n)-?\s*(?:模式|引用|输出要求|当前文件|工作流)\s*[:：]|$)/i);
  if (envelopeGoal?.[1]) return envelopeGoal[1].trim();
  const goal = source.match(/(?:^|\n)\s*-?\s*(?:目标|任务目标)\s*[:：]\s*([\s\S]*?)(?=\n\s*-?\s*(?:模式|引用|输出要求|当前文件|工作流)\s*[:：]|$)/i);
  if (goal?.[1]) return goal[1].trim();
  return source.replace(/^##\s*当前任务[\s\S]*?\n边界：[^\n]+\n\n?/i, "").trim();
}

// ============================================================================
// 历史消息工具（App.jsx 128-156 行逐行转录）
// ============================================================================

let histSeq = 0;
export const histId = (): string => `h${++histSeq}`;

interface HistoryImageBlock {
  source?: { data?: unknown; url?: unknown; mediaType?: unknown; mimeType?: unknown } | null;
  image?: { data?: unknown; url?: unknown; mediaType?: unknown; mimeType?: unknown } | null;
  data?: unknown;
  url?: unknown;
  mediaType?: unknown;
  mimeType?: unknown;
}

export function historyImageData(block: HistoryImageBlock | null | undefined): string | null {
  if (!block) return null;
  const source = block.source || block.image || block;
  const data = source?.data || block.data || source?.url || block.url;
  if (!data) return null;
  if (String(data).startsWith("data:")) return String(data);
  const mediaType = source?.mediaType || source?.mimeType || block.mediaType || block.mimeType || "image/png";
  return `data:${mediaType};base64,${data}`;
}

interface EntryLike {
  timestamp?: unknown;
  createdAt?: unknown;
  time?: unknown;
  [key: string]: unknown;
}

interface MessageLike {
  timestamp?: unknown;
  createdAt?: unknown;
  [key: string]: unknown;
}

export function entryCreatedAt(entry: EntryLike | null | undefined, message: MessageLike | null | undefined): string | null {
  const value = entry?.timestamp || entry?.createdAt || entry?.time || message?.timestamp || message?.createdAt || null;
  return value == null ? null : (value as string | number) as string;
}

export function sameWorkspacePath(a: unknown, b: unknown): boolean {
  if (!a || !b) return false;
  const normalize = (value: unknown): string => String(value).replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase();
  return normalize(a) === normalize(b);
}

/** 取路径末段作为文件树匹配键：仅用于视觉提示，不参与业务判断。 */
export function fileBasename(value: unknown): string {
  const parts = String(value || "").replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length ? (parts[parts.length - 1] ?? "") : "";
}

// ============================================================================
// JSONL 条目重建 + Run 总结插回（App.jsx handleSelectSession 994-1091 行逐行转录）
// ============================================================================

export interface PersistedHistoryEntry {
  id?: string;
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
    toolCallId?: unknown;
    toolName?: unknown;
    isError?: unknown;
    output?: unknown;
    [key: string]: unknown;
  } | null;
  timestamp?: unknown;
  createdAt?: unknown;
  time?: unknown;
  [key: string]: unknown;
}

export interface RunSummaryLike {
  id?: string;
  status?: string;
  summary?: string;
  artifacts?: Array<{ path?: string; [key: string]: unknown }>;
  references?: unknown[];
  task?: Record<string, unknown> | null;
  completion?: unknown;
  events?: Array<Record<string, unknown>>;
  startedAt?: string | null;
  finishedAt?: string | null;
  [key: string]: unknown;
}

/** 长会话展示窗口信息（GET /api/sessions/:id?view=chat 的 info.historyWindow）。 */
export interface HistoryWindowInfo {
  total?: number;
  start?: number;
  end?: number;
  hasMore?: boolean;
  [key: string]: unknown;
}

/**
 * 从 JSONL 条目重建对话消息：toolResult 按 toolCallId 回填到对应 Agent 工具卡，
 * 不渲染成用户气泡；老会话没有可配对的 toolCallId 时挂到最近一条 Agent 消息。
 */
export function reconstructSessionMessages(entries: PersistedHistoryEntry[] | undefined | null): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  const toolBlocks = new Map<unknown, ChatBlock>();
  for (const e of entries || []) {
    if (e.type !== "message" || !e.message) continue;
    const m = e.message;
    const role = m.role === "assistant" ? "assistant" : m.role === "user" ? "user" : (m.role as string);
    if (role === "toolResult" || role === "tool_result") {
      const output =
        typeof m.content === "string"
          ? m.content
          : Array.isArray(m.content)
            ? (m.content as Array<Record<string, unknown>>)
                .filter((b) => b?.type === "text")
                .map((b) => (b?.text as string) || "")
                .join("\n")
            : JSON.stringify(m.content || m.output || "", null, 2);
      const block = toolBlocks.get(m.toolCallId);
      if (block) {
        block.output = output;
        block.result = output;
        block.done = true;
        block.isError = !!m.isError;
      } else {
        // 老会话可能没有可配对的 toolCallId：挂到最近一条 Agent 消息，仍不显示为用户消息。
        const lastAssistant = [...msgs].reverse().find((item) => item.role === "assistant");
        if (lastAssistant)
          (lastAssistant.blocks ??= []).push({
            type: "tool", id: histId(), name: (m.toolName as string) || "tool result", input: "",
            output, result: output, done: true, isError: !!m.isError, expanded: false, duration: null,
          } as ChatBlock);
      }
      continue;
    }
    if (role !== "assistant" && role !== "user") continue;
    let text = "";
    const blocks: ChatBlock[] = [];
    const images: string[] = [];
    if (typeof m.content === "string") text = m.content;
    else if (Array.isArray(m.content)) {
      for (const b of m.content as Array<Record<string, unknown>>) {
        if (b.type === "text" || b.type === "input_text") text += (text ? "\n" : "") + ((b.text || b.content || "") as string);
        else if (b.type === "image" || b.type === "input_image") {
          const src = historyImageData(b as HistoryImageBlock);
          if (src) images.push(src);
        } else if (b.type === "thinking") blocks.push({ type: "thinking", text: (b.thinking as string) || "" });
        else if (b.type === "toolCall") {
          const callId = b.id || b.toolCallId || histId();
          const rawInput = b.input ?? b.arguments ?? b.params ?? "";
          const input = typeof rawInput === "string" ? rawInput : JSON.stringify(rawInput, null, 2);
          const block: ChatBlock = {
            type: "tool", id: callId as string, name: ((b.toolName || b.name) as string) || "tool", input,
            output: "", result: "", done: false, isError: false, expanded: false, duration: null,
          };
          blocks.push(block);
          toolBlocks.set(callId, block);
        }
      }
    }
    // 若 assistant 有纯文本且没有 text block，追加为文本块；用户消息仍保留原始文本。
    if (role === "assistant" && text && !blocks.some((b) => b.type === "text")) blocks.push({ type: "text", text });
    const displayText = role === "user" ? cleanPersistedMessage(text) : text;
    const currentDocMatch = text.match(/当前(?:打开|工作)文件:\s*([^\]\n]+)/);
    msgs.push({
      id: e.id, role, text: displayText, images, blocks, references: historyReferences(text),
      currentDoc: currentDocMatch?.[1]?.trim() || null, status: "done", createdAt: entryCreatedAt(e, m),
    } as ChatMessage);
  }
  return msgs;
}

/** Run 总结映射为 system 消息（状态过滤 + 去重 + 按 startedAt 排序）。 */
export function runSummariesToMessages(runs: RunSummaryLike[] | undefined | null): ChatMessage[] {
  return [...(runs || [])]
    .filter((run) => run?.status)
    .filter((run, index, list) => list.findIndex((item) => item.id === run.id) === index)
    .sort((a, b) => String(a.startedAt || "").localeCompare(String(b.startedAt || "")))
    .map((run, index, list) => ({
      id: `run-summary-${run.id}`,
      role: "system",
      text: run.summary || (run.status === "running" ? "本轮任务仍在执行中" : `本轮任务${run.status === "failed" ? "失败" : run.status === "cancelled" ? "已取消" : "完成"}，处理 ${run.artifacts?.length || 0} 个文件`),
      products: (run.artifacts || []).map((a) => a.path).filter(Boolean),
      artifacts: run.artifacts || [],
      runId: run.id,
      runStatus: run.status,
      references: run.references || [],
      task: run.task || null,
      status: run.status === "running" ? "streaming" : "done",
      summary: true,
      runIndex: index + 1,
      runCount: list.length,
      runMode: run.task?.mode || "agent",
      // 完成语义：显式 complete_task 或服务端推断结果
      completion: run.completion || null,
      eventCount: Array.isArray(run.events) ? run.events.length : 0,
      events: Array.isArray(run.events)
        ? run.events.map((event, eventIndex) => ({
            ...event,
            key: `history:${run.id}:${(event as { seq?: unknown }).seq || eventIndex}`,
          }))
        : [],
      expanded: true,
      createdAt: run.finishedAt || run.startedAt || null,
    } as ChatMessage));
}

/**
 * 按原始 JSONL 顺序重建消息流：Run 总结按完成/开始时间插回原始消息之间
 * （此前把 Run 总结直接 append 到末尾，恢复会话后会出现"对话一坨、产物一坨"）。
 */
export function buildSessionHistory(
  entries: PersistedHistoryEntry[] | undefined | null,
  runs: RunSummaryLike[] | undefined | null
): ChatMessage[] {
  const msgs = reconstructSessionMessages(entries);
  const runMessages = runSummariesToMessages(runs);
  return normalizeHistoryMessages([...msgs, ...runMessages].sort((a, b) => {
    const left = Date.parse(String((a.createdAt as string) || "")) || 0;
    const right = Date.parse(String((b.createdAt as string) || "")) || 0;
    return left - right;
  }));
}

/** 历史里解析会话关联文件（App.jsx 1109-1111）：返回第一个"当前打开文件"引用的路径。 */
export function findSessionFileMatch(msgs: ChatMessage[]): string | null {
  const fileMatch = msgs.find((m) => m.role === "user" && m.text && m.text.includes("当前打开文件"));
  if (!fileMatch?.text) return null;
  const fn = fileMatch.text.match(/当前打开文件:\s*([^\]\n]+)/);
  return fn?.[1] ? fn[1] : null;
}
