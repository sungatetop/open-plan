/**
 * 任务模式、能力计划与任务信封（纯函数）。
 *
 * 四种后端模式：chat（只读检索）/ office（Office CLI）/ agent（完整工具链）/ review（审查）。
 * capabilityPlan 契约 v2：能力声明带 provider（native/officecli/pi），可据以分派。
 *
 * 与 server/task.mjs 逐函数等价（tests/task-parity.test.ts 对拍强制）。
 */
import crypto from "node:crypto";

const OFFICE_EXTENSIONS = /\.(?:docx|xlsx|pptx|xls|doc)$/i;
const DOCUMENT_EXTENSIONS = /\.(?:docx|xlsx|pptx|xls|doc|pdf|csv|json|md|markdown|txt|html|htm)$/i;

/** 工作台保留四种后端模式值。office 是历史兼容值，前端主入口展示 Chat / Work / Review。 */
export const TASK_MODES: readonly string[] = Object.freeze(["chat", "office", "agent", "review"]);

export type TaskMode = "chat" | "office" | "agent" | "review";

// Chat 只读能力：只做查询、读取、分析总结，不落盘。
const READ_ONLY_TOOLS: readonly string[] = Object.freeze([
  "read", "grep", "find", "ls", "ask_user", "kb_search", "kb_read", "context_read", "skills_search", "skills_read",
  "web_search", "web_fetch",
  "map_read", "map_analyze", "map_clear_analysis", "map_datasets"
]);
// Office 模式专注文档处理，不暴露地图工具。
const OFFICE_TOOLS: readonly string[] = Object.freeze([
  ...READ_ONLY_TOOLS.filter((name) => !name.startsWith("map_")), "officecli"
]);
// Review 只依赖本地材料与规范库，不暴露联网搜索能力。
const REVIEW_TOOLS: readonly string[] = Object.freeze([
  "read", "grep", "find", "ls", "ask_user", "kb_search", "kb_read", "context_read", "skills_search", "skills_read",
  "officecli", "write", "edit", "review_copy", "review_source_apply", "todo", "complete_task"
]);
// Work 模式持有全部地图工具（含只读四件套与三个写工具）。
const AGENT_TOOLS: readonly string[] = Object.freeze([
  ...OFFICE_TOOLS,
  "bash", "write", "edit",
  "map_read", "map_analyze", "map_clear_analysis", "map_datasets",
  "map_edit", "map_import", "map_save_analysis",
  "memory_update", "todo", "complete_task",
  "editorial_pipeline",
  "browser_open", "browser_snapshot", "browser_click", "browser_type", "browser_press", "browser_scroll", "browser_screenshot", "browser_tabs", "browser_back", "browser_close"
]);

export function normalizeTaskMode(mode: unknown): TaskMode {
  const value = String(mode || "").trim().toLowerCase();
  return (TASK_MODES.includes(value) ? value : "agent") as TaskMode;
}

const MODE_LABELS: Record<TaskMode, string> = { chat: "Chat", office: "Office", agent: "Agent", review: "Review" };
const MODE_DESCRIPTIONS: Record<TaskMode, string> = {
  chat: "只读检索知识库、Skills 和工作区资料，不修改文件",
  office: "通过 Office CLI 精准编辑 Office 文档，不开放通用脚本写入",
  agent: "可调用完整工具链，执行分析、修改并生成工作产物",
  review: "依据知识库规范审查材料，生成报告和副本；确认后才写回原文"
};

export function modeLabel(mode: unknown): string {
  return MODE_LABELS[normalizeTaskMode(mode)];
}

export function modeDescription(mode: unknown): string {
  return MODE_DESCRIPTIONS[normalizeTaskMode(mode)];
}

export interface ToolPolicy {
  mode: TaskMode;
  label: string;
  description: string;
  tools: string[];
}

export function toolPolicyForMode(mode: unknown): ToolPolicy {
  const normalized = normalizeTaskMode(mode);
  const tools = normalized === "chat"
    ? READ_ONLY_TOOLS
    : normalized === "office"
      ? OFFICE_TOOLS
      : normalized === "review"
        ? REVIEW_TOOLS
        : AGENT_TOOLS;
  return {
    mode: normalized,
    label: modeLabel(normalized),
    description: modeDescription(normalized),
    tools: [...tools]
  };
}

function containsAny(text: string, words: string[]): boolean {
  return words.some((word) => text.includes(String(word).toLowerCase()));
}

export interface PlanTaskReference {
  kind?: string;
  target?: unknown;
  [key: string]: unknown;
}

export interface PlanTaskInput {
  text?: unknown;
  task?: { mode?: unknown; currentFile?: unknown; workflowId?: unknown; output?: { saveToWorkspace?: unknown } };
  references?: unknown;
  attachments?: unknown;
}

export interface TaskCapability {
  id: string;
  label: string;
  status: string;
  required: boolean;
  provider: string;
  reason: string;
}

export interface CapabilityPlan {
  version: number;
  mode: TaskMode;
  capabilities: TaskCapability[];
  routing: { officecli: string; documentRead: string; knowledge: string; map: string; skills: string };
  output: { expected: boolean; saveToWorkspace: boolean };
}

/** 根据输入和引用生成可解释的本轮能力计划，供 Run、前端和 Pi prompt 共用。 */
export function planTaskCapabilities({ text = "", task = {}, references = [], attachments = [] }: PlanTaskInput = {}): CapabilityPlan {
  const mode = normalizeTaskMode(task.mode);
  const source = String(text || "").toLowerCase();
  const refList = (Array.isArray(references) ? references : []) as PlanTaskReference[];
  const attachmentNames = ((Array.isArray(attachments) ? attachments : []) as unknown[]).map((item) => {
    const record = item as { name?: unknown } | null | undefined;
    return String(record?.name || item || "");
  });
  const refTargets = refList.map((item) => String(item?.target || "")).join(" ");
  const files = [String(task.currentFile || ""), refTargets, ...attachmentNames].join(" ");
  const document = DOCUMENT_EXTENSIONS.test(files) || refList.some((item) => item.kind === "file" || item.kind === "template");
  const office = OFFICE_EXTENSIONS.test(files) || containsAny(source, ["officecli", "word", "excel", "ppt", "docx", "xlsx", "pptx", "表格", "文档排版", "修改文档"]);
  const knowledge = refList.some((item) => ["knowledge", "knowledge_dir"].includes(item.kind as string)) || containsAny(source, ["知识库", "知识库搜索", "知识检索", "参考资料"]);
  const map = containsAny(source, ["地图", "图层", "geojson", "等时圈", "热力图", "od图", "空间分析"]) || /(?:^|[\\/])maps(?:[\\/]|$)/i.test(files);
  const workflow = Boolean(task.workflowId) || /@工作流\[|@技能\[|工作流|skill|workflow/i.test(String(text || ""));
  const output = containsAny(source, ["生成", "创建", "导出", "写入", "制作", "修改", "编辑", "排版"]);
  // 把"生成新文档"与"精确编辑既有文档"分流：生成类原生 OOXML 直写，编辑类保留 CLI 精确定位。
  const officeRefExists = OFFICE_EXTENSIONS.test(files);
  const officeGenerate = office && output && !officeRefExists;
  const capabilities: TaskCapability[] = [
    mode === "chat"
      ? { id: "chat", label: "Chat 检索", status: "ready", required: true, provider: "pi", reason: "只读检索知识库、Skills 和工作区资料" }
      : mode === "office"
        ? { id: "office", label: "Office 对话", status: "ready", required: true, provider: "pi", reason: "通过 Office CLI 精准处理 Office 文档" }
        : mode === "review"
          ? { id: "review", label: "Review 审查", status: "ready", required: true, provider: "pi", reason: "依据规范生成审查报告和安全副本" }
          : { id: "agent", label: "Agent 对话", status: "ready", required: true, provider: "pi", reason: "处理本轮任务并保持会话上下文" }
  ];
  if (document) capabilities.push({ id: "document", label: "文档读取", status: "planned", required: true, provider: "native", reason: "本轮存在文档、文件引用或附件" });
  if (knowledge) capabilities.push({ id: "knowledge", label: "知识库检索", status: "planned", required: false, provider: "native", reason: "本轮出现知识库引用或检索意图" });
  // Chat 只负责检索与解释，不能触发 Office CLI 预检或写入路由。
  if (office && mode !== "chat") {
    capabilities.push({
      id: "officecli",
      label: "Office CLI",
      status: officeRefExists ? "preferred" : "fallback",
      required: Boolean(output) && officeRefExists,
      provider: "officecli",
      reason: officeRefExists
        ? "本轮涉及编辑既有 Office 文档，需要 CLI 精确定位能力"
        : "生成类任务优先原生直写，Office CLI 仅兜底高级操作"
    });
  }
  // 原生 Office 生成能力：新建 Word/Excel/PPT 走工作台内置 OOXML 引擎。
  if (officeGenerate && mode !== "chat" && mode !== "review") {
    capabilities.push({ id: "office_generate", label: "Office 原生生成", status: "preferred", required: false, provider: "native", reason: "新建 Word/Excel/PPT 由内置 OOXML 引擎直写，无需外部二进制预检" });
  }
  if (mode === "review") capabilities.push({ id: "reviewEvidence", label: "规范依据台账", status: "required", required: true, provider: "native", reason: "每条审查结论必须绑定实际读取的规范文件" });
  // 子代理能力只在 Chat 与 Work 声明，与 toolPolicyForMode 白名单保持一致。
  if (mode === "chat" || mode === "agent") capabilities.push({ id: "subagent", label: "子代理", status: "available", required: false, provider: "pi", reason: "可派发隔离的只读子 Agent 并行处理资料阅读/审阅" });
  // 地图能力只在 Chat（只读）与 Work（可写）声明。
  const mapAvailable = map && (mode === "chat" || mode === "agent");
  if (mapAvailable) {
    // JS 原样保留 `mode !== "review"`（mapAvailable 时恒为 true 的守卫）；cast 避免 TS 字面量收窄误报
    const mapWritable = (mode as string) !== "chat" && (mode as string) !== "review";
    capabilities.push({
      id: "map",
      label: "地图工具",
      status: "ready",
      required: false,
      provider: "native",
      reason: mapWritable
        ? "地图查询、分析与图层写入（写操作需审批）"
        : "地图只读查询与临时可视化（不落盘；保存图层需切到 Work 模式）"
    });
  }
  if (workflow) capabilities.push({ id: "skills", label: "Skills / 工作流", status: "planned", required: Boolean(task.workflowId), provider: "native", reason: task.workflowId ? `工作流 ${String(task.workflowId)} 声明了技能依赖` : "本轮出现工作流或技能意图" });
  return {
    version: 2,
    mode,
    capabilities,
    routing: {
      officecli: office && mode !== "chat" ? (officeRefExists ? "preferred" : "lazy") : "not_needed",
      documentRead: document ? "enabled" : "not_needed",
      knowledge: knowledge ? "enabled" : "not_needed",
      map: mapAvailable ? (mode === "chat" ? "read_only" : "read_write") : "not_needed",
      skills: workflow ? "preflight" : "available_on_demand"
    },
    output: { expected: mode !== "chat" && output, saveToWorkspace: mode !== "chat" && task.output?.saveToWorkspace !== false }
  };
}

export interface TaskEnvelopeReference {
  id: unknown;
  kind: unknown;
  target: unknown;
  status: unknown;
}

export interface TaskEnvelope {
  version: number;
  id: string;
  goal: string;
  mode: TaskMode;
  modeLabel: string;
  modeDescription: string;
  workflowId: unknown;
  recoveryOf: unknown;
  recoveryAction: unknown;
  projectId: unknown;
  mapProject: unknown;
  agentProfile: unknown;
  projectSettings: unknown;
  profilePolicy: unknown;
  workspaceId: unknown;
  threadId: unknown;
  currentFile: unknown;
  references: TaskEnvelopeReference[];
  capabilityPlan: unknown;
  constraints: unknown[];
  output: { format: unknown; saveToWorkspace: boolean; requireSources: boolean };
  createdAt: unknown;
}

export interface TaskEnvelopeInput {
  id?: unknown;
  goal?: unknown;
  text?: unknown;
  mode?: unknown;
  workflowId?: unknown;
  recoveryOf?: unknown;
  recoveryAction?: unknown;
  projectId?: unknown;
  mapProject?: unknown;
  agentProfile?: unknown;
  projectSettings?: { profilePolicy?: unknown } | null;
  profilePolicy?: unknown;
  workspaceId?: unknown;
  threadId?: unknown;
  currentFile?: unknown;
  references?: unknown;
  capabilityPlan?: unknown;
  constraints?: unknown;
  output?: { format?: unknown; saveToWorkspace?: unknown; requireSources?: unknown } | null;
  createdAt?: unknown;
}

export function createTaskEnvelope(input: TaskEnvelopeInput = {}): TaskEnvelope {
  const references = (Array.isArray(input.references) ? input.references : []) as PlanTaskReference[];
  const mode = normalizeTaskMode(input.mode);
  return {
    version: 1,
    id: (input.id || `task_${crypto.randomUUID()}`) as string,
    goal: String(input.goal || input.text || "").trim(),
    mode,
    modeLabel: modeLabel(input.mode),
    modeDescription: modeDescription(input.mode),
    workflowId: input.workflowId || null,
    recoveryOf: input.recoveryOf || null,
    recoveryAction: input.recoveryAction || null,
    projectId: input.projectId || null,
    mapProject: input.mapProject || null,
    agentProfile: input.agentProfile || "通用 Agent",
    projectSettings: input.projectSettings || null,
    profilePolicy: input.profilePolicy || input.projectSettings?.profilePolicy || null,
    workspaceId: input.workspaceId || null,
    threadId: input.threadId || null,
    currentFile: input.currentFile || null,
    references: references.map((r) => ({ id: r.id, kind: r.kind, target: r.target, status: r.status })),
    capabilityPlan: input.capabilityPlan || null,
    constraints: Array.isArray(input.constraints) ? input.constraints : [],
    output: {
      format: input.output?.format || "markdown",
      saveToWorkspace: mode !== "chat" && input.output?.saveToWorkspace !== false,
      requireSources: input.output?.requireSources !== false
    },
    createdAt: input.createdAt || new Date().toISOString()
  };
}

function mapCapabilityHint(task: { capabilityPlan?: unknown } = {}): string {
  const plan = task.capabilityPlan as { routing?: { map?: unknown } } | null | undefined;
  const routing = plan?.routing?.map;
  if (routing !== "read_only" && routing !== "read_write") return "";
  if (routing === "read_write") {
    return "地图能力：可查询数据集与图层、生成临时可视化，并可将结果保存为正式图层（写操作需用户审批）。";
  }
  return [
    "地图能力（只读）：可查询数据集与图层、生成临时可视化（如热力图 / OD 流向 / 等时圈）、清除临时结果。",
    "不可执行：新增、修改、删除图层，或把分析结果保存为正式图层——这些需要用户切换到 Work 模式。",
    "当用户要求写操作时，明确说明需要切到 Work 模式，不要尝试绕过，也不要假装已完成。"
  ].join("\n");
}

export interface TaskSummaryInput {
  goal?: unknown;
  mode?: unknown;
  modeLabel?: unknown;
  workflowId?: unknown;
  currentFile?: unknown;
  mapProject?: unknown;
  references?: { length?: unknown } | null;
  capabilityPlan?: unknown;
  [key: string]: unknown;
}

export function taskSummary(task: TaskSummaryInput | null | undefined): string {
  if (!task) return "";
  const refs = task.references as { length?: unknown } | null | undefined;
  return [
    "当前任务",
    `目标：${task.goal || "（未提供）"}`,
    `模式：${task.modeLabel || modeLabel(task.mode)}`,
    task.workflowId ? `工作流：${String(task.workflowId)}` : "",
    task.currentFile ? `当前文件：${String(task.currentFile)}` : "",
    task.mapProject ? `当前地图项目：${String(task.mapProject)}` : "",
    mapCapabilityHint(task),
    refs?.length ? `引用：${String(refs.length)} 项` : "",
    task.mode === "chat" ? "边界：只读检索，不修改文件。" : "边界：按任务执行工具，面向用户直接给出结论；过程与产物详情留在任务记录中，按需说明。"
  ].filter(Boolean).join("\n");
}
