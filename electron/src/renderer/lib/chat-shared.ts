/**
 * ChatPanel 模块级共享层（F3 批6a：自 client/src/components/ChatPanel.jsx
 * 拆出，与原实现逐行等价，对拍强制 tests/f3-batch6a-parity.test.tsx）。
 */
import { associateRunMessages } from "./run-display-projection";

/** 宽松结构类型：历史消息块 / 历史消息 / 模型元数据（已知字段之外全走索引签名）。 */
export interface ChatBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface ChatMessage {
  role?: string;
  text?: string;
  blocks?: ChatBlock[];
  images?: Array<string | { name?: unknown } | null | undefined>;
  runId?: unknown;
  summary?: unknown;
  errorText?: unknown;
  [key: string]: unknown;
}

export interface ChatModel {
  id?: string;
  name?: string;
  provider?: string;
  vision?: boolean;
  contextWindow?: number;
  available?: boolean;
  [key: string]: unknown;
}

export interface ModelProviderMeta {
  label: string;
  icon: string;
}

// O-P3：浏览器"写操作类"工具白名单 —— 只有这些会拉起内置浏览器侧栏；
// browser_close / browser_tabs / browser_snapshot / browser_screenshot 等查看或收尾动作不拉起。
export const BROWSER_PANEL_OPEN_TOOLS = new Set(["browser_open", "browser_click", "browser_type", "browser_press", "browser_scroll"]);

let msgSeq = 0;
export const newId = () => `m${++msgSeq}`;
export const MODEL_KEY = "oaw_model";
export const MODE_KEY = "oaw_chat_mode";
export const THINKING_KEY = "oaw_thinking_level";
export const APPROVAL_MODE_KEY = "oaw_approval_mode";
export const DEFAULT_CONTEXT_WINDOW = 128000;
// 与服务端 Pi 压缩策略保持一致（server/pi-runtime-management.mjs 的 PI_COMPACTION_POLICY）：
// 服务端快照没返回时用作展示兜底，不代表新策略。
export const PI_COMPACTION_RESERVE_TOKENS = 16384;
export const PI_COMPACTION_KEEP_RECENT_TOKENS = 20000;
export const LIVE_RUN_STATUSES = new Set(["running", "queued", "waiting_user", "recovering", "cancel_requested", "finishing"]);
// 提问卡片的时间窗口兜底（服务端 ASK_TIMEOUT_MS = 5 分钟，正常由事件里的 expiresAt 给出）：
// 缺少 expiresAt 时按同一口径计时，到期把卡片置为已超时，不再留下点得动却必然 404 的死卡片。
export const ASK_TIMEOUT_FALLBACK_MS = 5 * 60 * 1000;
export const MAX_VISIBLE_MESSAGES = 120;
export const MESSAGE_PAGE_SIZE = 80;
export const COMPOSER_COMMANDS: Array<{ insert: string; label: string; hint: string }> = [
  { insert: "/compact", label: "压缩上下文", hint: "保留摘要并缩短当前 Pi 会话" },
  { insert: "/new", label: "新建会话", hint: "在当前项目下创建独立会话" },
  { insert: "/chat", label: "切换到 Chat", hint: "只读检索知识库、Skills 和工作区资料" },
  { insert: "/agent", label: "切换到 Agent", hint: "执行任务、调用工具并生成产物" },
  { insert: "/review", label: "切换到 Review", hint: "按规范审查材料，先生成报告和副本" },
  { insert: "/help", label: "查看输入帮助", hint: "显示 /、@、& 的使用方式" },
];
export const THINKING_OPTIONS: Array<{ id: string; label: string; shortLabel: string; desc: string }> = [
  { id: "low", label: "低", shortLabel: "快速", desc: "响应更快，适合简单任务" },
  { id: "medium", label: "标准", shortLabel: "标准", desc: "速度与质量平衡" },
  { id: "high", label: "高", shortLabel: "深度", desc: "适合复杂分析" },
  { id: "max", label: "最大", shortLabel: "最大", desc: "使用模型允许的最高档位" },
];
export const MODEL_PROVIDER_META: Record<string, ModelProviderMeta> = {
  anthropic: { label: "Anthropic", icon: "anthropic" },
  deepseek: { label: "DeepSeek", icon: "deepseek" },
  gemini: { label: "Google", icon: "gemini" },
  google: { label: "Google", icon: "gemini" },
  minimax: { label: "MiniMax", icon: "minimax" },
  "minimax-cn": { label: "MiniMax", icon: "minimax" },
  openai: { label: "OpenAI", icon: "openai" },
  "openai-codex": { label: "OpenAI", icon: "openai" },
  qwen: { label: "Qwen", icon: "qwen" },
  alibaba: { label: "Qwen", icon: "qwen" },
  "opencode-go": { label: "OpenCode Go", icon: "opencode" },
  opencode: { label: "OpenCode Zen", icon: "opencode" },
  "xiaomi-token-plan-cn": { label: "MiMo", icon: "xiaomi" },
  "command-code": { label: "Command Code", icon: "commandcode" },
  "command-code-anthropic": { label: "Command Code", icon: "commandcode" },
  zhipu: { label: "智谱 GLM", icon: "zhipu" },
  zai: { label: "Z.AI", icon: "zhipu" },
  "zai-coding-cn": { label: "Z.AI Coding CN", icon: "zhipu" },
  moonshot: { label: "Moonshot", icon: "moonshot" },
  moonshotai: { label: "Moonshot AI", icon: "moonshot" },
  "moonshotai-cn": { label: "Moonshot AI CN", icon: "moonshot" },
  kimi: { label: "Kimi", icon: "kimi" },
  "kimi-coding": { label: "Kimi For Coding", icon: "kimi" },
  xai: { label: "xAI", icon: "xai" },
  mistral: { label: "Mistral", icon: "mistral" },
  meta: { label: "Meta", icon: "meta" },
  nvidia: { label: "NVIDIA", icon: "nvidia" },
  openrouter: { label: "OpenRouter", icon: "openrouter" },
  huggingface: { label: "Hugging Face", icon: "huggingface" },
  cloudflare: { label: "Cloudflare", icon: "cloudflare" },
  "cloudflare-ai-gateway": { label: "Cloudflare AI Gateway", icon: "cloudflare" },
  "cloudflare-workers-ai": { label: "Cloudflare Workers AI", icon: "cloudflare" },
  "vercel-ai-gateway": { label: "Vercel AI Gateway", icon: "vercel" },
  "amazon-bedrock": { label: "Amazon Bedrock", icon: "bedrock" },
  azure: { label: "Azure OpenAI", icon: "azure" },
  "google-vertex": { label: "Google Vertex AI", icon: "googlecloud" },
};

export function modelProvider(model: ChatModel | null | undefined): string {
  return String(model?.provider || model?.id || "custom").split("/")[0]!.toLowerCase() || "custom";
}

export function modelProviderMeta(model: ChatModel | null | undefined): ModelProviderMeta {
  const provider = modelProvider(model);
  return MODEL_PROVIDER_META[provider] || { label: provider === "custom" ? "自定义供应商" : provider, icon: "custom" };
}

export function modelDisplayName(model: ChatModel | null | undefined): string {
  if (!model) return "按 Pi 配置";
  return model.name || String(model.id || "").split("/").slice(1).join("/") || model.id!;
}

export function eventMessageText(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value.trim() || fallback;
  if (value && typeof value === "object") {
    for (const key of ["message", "error", "detail", "text"]) {
      const nested = eventMessageText((value as Record<string, unknown>)[key], "");
      if (nested) return nested;
    }
    try { return JSON.stringify(value); } catch { return fallback; }
  }
  return value == null ? fallback : String(value);
}

/**
 * 供应商缩写：未知供应商不再显示一个没有信息量的圆点，而是显示可辨认的首字母
 * （command-code → CC，xiaomi-token-plan-cn → XT），并按名称取稳定色相。
 */
export function providerInitials(provider: unknown): string {
  const parts = String(provider || "").split(/[^a-z0-9]+/i).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

export function providerHue(provider: unknown): number {
  const text = String(provider || "");
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) % 360;
  return hash;
}

export interface ModeMetaEntry {
  label: string;
  shortLabel: string;
  icon: string;
  title: string;
  hint: string;
  prefix: string;
}

export const MODE_META: Record<string, ModeMetaEntry> = {
  chat: {
    label: "Chat",
    shortLabel: "Chat",
    icon: "search",
    title: "Chat：只读检索知识库、Skills 和工作区资料，不修改文件",
    hint: "只读检索",
    prefix: "[模式: Chat] 只进行知识库、Skills 和工作区资料检索；不要修改文件、执行脚本或生成产物。若用户要求修改，请转为 Agent 任务。\n",
  },
  agent: {
    label: "Work",
    shortLabel: "Work",
    icon: "tool",
    title: "Work：调用工具执行分析、编辑并生成工作产物，实际权限由运行环境决定",
    hint: "执行与产出",
    prefix: "[模式: Work] 可以调用完整 skills 和工具执行分析、修改并生成新文件（文档/HTML/PPT 等），Office CLI 会按任务需要自动选择；实际写入和联网能力以运行环境预检结果为准。\n",
  },
  review: {
    label: "Review",
    shortLabel: "Review",
    icon: "shield",
    title: "Review：依据实际读取的规范生成审查报告与批注副本，确认后才写回原文",
    hint: "审查与副本",
    prefix: "[模式: Review] 先识别材料并读取规范库中的实际依据，生成审查报告和批注副本；用户明确确认前不得修改原文件。\n",
  },
};

// 空白态按模式给可执行示例：Chat 是只读检索，不能把"改文件"当默认引导，
// 否则用户会在只读模式下发一条注定要转 Agent 的指令。Work/Review 才给出
// 会写文件的示例，并同时说明影响范围与验收方式（对应主路径）。
export interface EmptyExampleEntry {
  title: string;
  steps: string[];
  examples: string[];
}

export const EMPTY_EXAMPLES: Record<string, EmptyExampleEntry> = {
  chat: {
    title: "Chat · 只读问答与资料检索",
    steps: ["选好工作区和资料", "直接提问或 @ 引用文件", "查看回答，全程不会修改文件"],
    examples: ["总结知识库里关于换乘系数的要点", "对比这两份材料在预算口径上的差异", "工作区里哪些文件提到过“建设时序”？" ],
  },
  agent: {
    title: "Work · 执行任务并生成产物",
    steps: ["确认目标工作区和文件", "描述要产出的结果", "按提示审批写入，结束后验收成果"],
    examples: ["把 报告.docx 的一级标题改成红色加粗", "在 数据.xlsx 的 B3 填入 88", "根据 需求.md 生成一份汇报 PPT"],
  },
  review: {
    title: "Review · 按规范审查材料",
    steps: ["打开要审查的材料", "说明审查依据，或让我读取规范库", "确认报告与批注副本，原文默认不动"],
    examples: ["按规范审查 方案.docx，先生成报告和批注副本", "检查 预算表.xlsx 是否符合编制口径", "列出这份方案缺少的必备章节"],
  },
};

// 路径末段：目标标签只显示文件名/目录名，完整路径放 title，避免撑爆输入区。
export function pathBaseName(target: unknown): string {
  const value = String(target || "").replace(/[\\/]+$/, "");
  return value.split(/[\\/]/).pop() || value;
}

// 模型能力标签必须来自真实元数据（vision 布尔、contextWindow 数字），
// 不能靠名称里有没有 "vision"/"vl" 猜。
export function modelCapabilityLabel(model: ChatModel | null | undefined): string {
  if (!model) return "";
  const parts: string[] = [];
  if (typeof model.vision === "boolean") parts.push(model.vision ? "支持图片" : "仅文本");
  const contextWindow = Number(model.contextWindow);
  if (contextWindow > 0) parts.push(`${Math.round(contextWindow / 1000)}k 上下文`);
  if (!parts.length) parts.push("能力未标注");
  return parts.join(" · ");
}

export const MODEL_RECENT_KEY = "oaw_recent_models";
export const MODEL_FAVORITE_KEY = "oaw_favorite_models";
export const MAX_RECENT_MODELS = 5;

// 未发送草稿按 thread 保存在模块级缓存（交互 3）：进入设置/知识库/成果等模块会
// 卸载 ChatPanel，输入框是组件内 state，重挂载就丢了。缓存放在模块作用域可跨挂载
// 存活；按 thread 隔离，切换会话不会把 A 的草稿带到 B，明确发送/新建时才清除。
export const DRAFT_CACHE_LIMIT = 20;
export const draftCache = new Map<unknown, string>();
export function readDraft(threadId: unknown): string {
  return threadId ? draftCache.get(threadId) || "" : "";
}
export function writeDraft(threadId: unknown, value: unknown): void {
  if (!threadId) return;
  const text = String(value ?? "");
  if (!text) draftCache.delete(threadId);
  else {
    // 重新插入以维持 LRU 顺序，避免长会话把活跃草稿挤出缓存。
    draftCache.delete(threadId);
    draftCache.set(threadId, text);
  }
  while (draftCache.size > DRAFT_CACHE_LIMIT) {
    draftCache.delete(draftCache.keys().next().value);
  }
}

export function readStoredModelList(key: string): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(value) ? value.filter((id) => typeof id === "string" && id) : [];
  } catch {
    return [];
  }
}

export function writeStoredModelList(key: string, list: unknown[]): void {
  try { localStorage.setItem(key, JSON.stringify(list)); } catch {}
}

// 中心对话区只保留能解释“任务进行到哪一步”的 SSE 事件；高频 token/thinking
// 仍由消息流渲染，避免把每个 token 都变成一条 UI 记录。运行期间展开，完成后
// 自动收成一行，用户仍可点击核对模型请求、工具调用、写入和收尾是否完整。
// 进入执行流的事件类型来自 ../event-display.js 的注册表（唯一事实来源），
// 不在组件里维护第二份清单。

// 恢复 Pi JSONL 时可能同时存在空 assistant 占位、SSE 重试留下的重复消息，
// 以及同一条最终回复被 assistant_final/run_finished 各写入一次。历史层只做
// 相邻同内容去重，保留原始顺序和真正被工具/用户消息隔开的重复提问。
export function historyMessageFingerprint(message: ChatMessage | null | undefined): string {
  const blocks = Array.isArray(message?.blocks) ? message.blocks : [];
  const compact = (value: unknown) => String(value || "").replace(/\s+/g, " ").trim();
  return JSON.stringify({
    role: message?.role || "",
    text: compact(message?.text),
    images: (message?.images || []).map((item) => typeof item === "string" ? item.slice(0, 80) : item?.name || "image"),
    blocks: blocks.map((block) => ({
      type: block?.type || "",
      text: compact(block?.text),
      name: block?.name || "",
      input: compact(block?.input),
      output: compact(block?.output || block?.result),
      question: compact(block?.question),
      answer: compact(block?.answer),
    })),
    runId: message?.role === "system" ? message?.runId || "" : "",
    summary: Boolean(message?.summary),
  });
}

export function historyMessageScore(message: ChatMessage | null | undefined): number {
  const blocks = Array.isArray(message?.blocks) ? message.blocks : [];
  return String(message?.text || "").length
    + (message?.images?.length || 0) * 100
    + blocks.reduce((sum, block) => sum + String(block?.text || block?.output || block?.result || "").length + 40, 0);
}

export function normalizeHistoryMessages(items: unknown): ChatMessage[] {
  if (!Array.isArray(items)) return [];
  const result: ChatMessage[] = [];
  const assistantFingerprints = new Set<string>();
  for (const message of items) {
    if (!message || !message.role) continue;
    // harness 的轮次/收尾提醒只用于驱动运行边界，不得在恢复会话后显示为“You”消息。
    if (message.role === "user" && /^\s*(?:\[系统提醒\]|系统提醒[：:])/.test(String(message.text || ""))) continue;
    const blocks = Array.isArray(message.blocks) ? message.blocks : [];
    const meaningful = Boolean(
      String(message.text || "").trim()
      || (message.images || []).length
      || blocks.length
      || message.memoryProposal
      || message.summary,
    );
    // Pi 的 assistant 空消息只是占位符，恢复时不应占据一条对话记录。
    if (message.role === "assistant" && !meaningful && !message.errorText) continue;
    const previous = result[result.length - 1];
    const fingerprint = historyMessageFingerprint(message);
    // 一次用户提问可能因恢复/重试生成两条相同 assistant 结论，系统提示夹在
    // 中间时不再是“相邻”重复；直到下一条用户消息前，仅合并相同 assistant 结果。
    if (message.role === "assistant" && assistantFingerprints.has(fingerprint)) continue;
    // 运行总结在实时 SSE 和历史 Run 列表中各有一份；同一 run 只保留一个，
    // 避免恢复会话后“本轮结论”挤在一起或重复出现。
    if (message.role === "system" && message.summary && message.runId) {
      const existingIndex = result.findIndex((item) => item.role === "system" && item.summary && item.runId === message.runId);
      if (existingIndex >= 0) {
        if (historyMessageScore(message) > historyMessageScore(result[existingIndex])) result[existingIndex] = message;
        continue;
      }
    }
    if (previous && historyMessageFingerprint(previous) === fingerprint) {
      if (historyMessageScore(message) > historyMessageScore(previous)) result[result.length - 1] = message;
      continue;
    }
    result.push(message);
    if (message.role === "user") assistantFingerprints.clear();
    if (message.role === "assistant") assistantFingerprints.add(fingerprint);
  }
  return associateRunMessages<ChatMessage>(result);
}

// 事件文案 / 语气 / 阶段统一来自 ../event-display.js（事件展示注册表），
// 这里不再维护第二份 switch，新增事件只需在注册表登记一次。

export interface FlowEventData {
  runId?: unknown;
  files?: unknown[];
  [key: string]: unknown;
}

export interface FlowEvent {
  key: string;
  type: string;
  data?: FlowEventData;
  [key: string]: unknown;
}

export function appendExecutionFlowEvent(previous: FlowEvent[], event: FlowEvent): FlowEvent[] {
  if (previous.some((item) => item.key === event.key)) return previous;
  const sameRun = (item: FlowEvent) => event.data?.runId ? item.data?.runId === event.data.runId : !item.data?.runId;
  const mergeIndex = [...previous].reverse().findIndex((item) => sameRun(item) && item.type === event.type && ["file_changed", "agent_summary", "agent_queue_update"].includes(event.type));
  if (mergeIndex >= 0) {
    const index = previous.length - 1 - mergeIndex;
    const current = previous[index]!;
    if (event.type === "file_changed") {
      const files = [...new Set([...(current.data?.files || []), ...(event.data?.files || [])])];
      return previous.map((item, itemIndex) => itemIndex === index ? { ...event, key: current.key, data: { ...current.data, ...event.data, files } } : item);
    }
    return previous.map((item, itemIndex) => itemIndex === index ? { ...current, ...event, key: current.key } : item);
  }
  return [...previous, event].slice(-300);
}

export interface UsageDetailsResult {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  context: number;
}

export function usageDetails(usage: Record<string, unknown> | null | undefined): UsageDetailsResult {
  const input = Number(usage?.inputTokens ?? usage?.input ?? 0) || 0;
  const output = Number(usage?.outputTokens ?? usage?.output ?? 0) || 0;
  const cacheRead = Number(usage?.cacheReadTokens ?? usage?.cacheRead ?? usage?.cache_read ?? 0) || 0;
  const cacheWrite = Number(usage?.cacheWriteTokens ?? usage?.cacheWrite ?? usage?.cache_write ?? 0) || 0;
  const context = Number(usage?.contextTokens ?? usage?.context ?? 0) || input + cacheRead + cacheWrite;
  return { input, output, cacheRead, cacheWrite, context };
}

// token 文案统一走 run-trace.js 的 formatTokenCount（导入），不再在组件里维护第二份。

// Office 是历史任务/会话的兼容值；用户入口使用 Chat / Work / Review。
export function normalizeUiMode(mode: unknown): string {
  return mode === "review" ? "review" : mode === "office" || mode === "agent" ? "agent" : "chat";
}

export interface ChatReference {
  kind?: string;
  target?: string;
  source?: string;
  [key: string]: unknown;
}

export function referenceMarker(reference: ChatReference | null | undefined): string {
  if (!reference?.target) return "";
  if (reference.kind === "session") return reference.source || "&会话[" + reference.target + "]";
  const kind = reference.kind === "knowledge_dir" ? "知识库目录" : reference.kind === "knowledge" ? "知识库" : reference.kind === "template_dir" ? "模板目录" : reference.kind === "template" ? "模板" : reference.kind === "session" ? "会话" : "文件";
  return reference.source || `@${kind}[${reference.target}]`;
}

export function loadEmbeddedMessages(threadId: string | null | undefined, embedded: unknown): ChatMessage[] {
  if (!embedded || !threadId) return [];
  try {
    const cached = JSON.parse(localStorage.getItem(`oaw_embedded_messages_${threadId}`) || "[]");
    return normalizeHistoryMessages(cached);
  } catch {
    return [];
  }
}

export function formatMsgTime(ts: string | number | null | undefined): string {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const p = (n: number) => String(n).padStart(2, "0");
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return sameYear ? `${p(d.getMonth() + 1)}/${p(d.getDate())} ${hm}` : `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${hm}`;
}

// blocks 辅助：追加/合并文本块、思考块
export function appendTextBlock(blocks: ChatBlock[], text: string): ChatBlock[] {
  const arr = [...blocks];
  const last = arr[arr.length - 1];
  if (last && last.type === "text") {
    last.text = (last.text || "") + text;
    return arr;
  }
  arr.push({ type: "text", text });
  return arr;
}
export function appendAssistantMessageBoundary(blocks: ChatBlock[], messageId = ""): ChatBlock[] {
  const arr = [...blocks];
  const last = arr[arr.length - 1];
  const id = String(messageId || "");
  if (!arr.length || (last?.type === "message_boundary" && (!id || last.id === id))) return arr;
  arr.push({ type: "message_boundary", id: id || newId(), at: Date.now() });
  return arr;
}
export function appendThinkingBlock(blocks: ChatBlock[], text: string): ChatBlock[] {
  const arr = [...blocks];
  const last = arr[arr.length - 1];
  if (last && last.type === "thinking") {
    last.text = (last.text || "") + text;
    return arr;
  }
  arr.push({ type: "thinking", text, startTime: Date.now() });
  return arr;
}

export function referenceId(kind: string, target: string): string {
  let hash = 0;
  for (const ch of `${kind}:${target}`) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
  return `ref_${Math.abs(hash).toString(36)}`;
}

export interface ParsedReference {
  id: string;
  kind: string;
  target: string;
  source?: string;
}

export function parseReferenceMarkers(text = ""): ParsedReference[] {
  const refs: ParsedReference[] = [];
  const seen = new Set<string>();
  const add = (kind: string, target: unknown, source: string | undefined) => {
    const value = String(target || "").trim();
    if (!value) return;
    const id = referenceId(kind, value);
    if (seen.has(id)) return;
    seen.add(id);
    refs.push({ id, kind, target: value, source });
  };
  for (const m of String(text).matchAll(/@知识库目录\[([^\]]+)\]/g)) add("knowledge_dir", m[1], m[0]);
  for (const m of String(text).matchAll(/@知识库\[([^\]]+)\]/g)) add("knowledge", m[1], m[0]);
  for (const m of String(text).matchAll(/@模板目录\[([^\]]+)\]/g)) add("template_dir", m[1], m[0]);
  for (const m of String(text).matchAll(/@模板\[([^\]]+)\]/g)) add("template", m[1], m[0]);
  for (const m of String(text).matchAll(/@文件\[([^\]]+)\]/g)) add("file", m[1], m[0]);
  for (const m of String(text).matchAll(/&会话\[([^\]]+)\]/g)) add("session", m[1], m[0]);
  for (const m of String(text).matchAll(/(^|[\s(])@([^\s@，。！？\]}]+)/g)) {
    const target = m[2]!.replace(/[),;。！？]+$/, "");
    if (/^(?:文件|知识库|模板|模板目录)\[/.test(target)) continue;
    if (target.includes("/") || target.includes("\\") || /\.(docx|xlsx|pptx|pdf|csv|json|md|markdown|txt|html|htm)$/i.test(target)) add("file", target, `@${target}`);
  }
  return refs;
}

/** 子代理轨迹追加：连续同类文本（思考/正文）合并，避免碎片化；有界存储。 */
export interface SubagentTraceItem {
  kind?: string;
  text?: string;
  [key: string]: unknown;
}

export function appendSubagentTrace(list: unknown, item: SubagentTraceItem | null | undefined): SubagentTraceItem[] {
  const next = Array.isArray(list) ? list.slice() : [];
  if (!item) return next;
  const last = next[next.length - 1];
  if ((item.kind === "thinking" || item.kind === "text") && last && last.kind === item.kind) {
    next[next.length - 1] = { ...last, text: `${last.text || ""}${item.text || ""}`.slice(-20000) };
  } else {
    next.push(item);
  }
  if (next.length > 240) next.splice(0, next.length - 240);
  return next;
}
