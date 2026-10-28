/**
 * client API 层（F3 批1）：chat 链路端点函数的 TS 迁移。
 *
 * 与 client/src/api.js 的对应关系：
 *   - 函数签名与出参语义逐一对齐：成功返回 data，失败 throw（message = data.error || `HTTP ${status}`，
 *     携带 code/detail，对齐 api.js 的 `if (data.code) error.code = data.code`）；
 *   - 底层从浏览器 fetch 换成桌面 IPC 通道（shared/protocol/channels.ts 清单），
 *     非 2xx 在 main 转发器内保留 HTTP 语义（InvokeResult ok:false），本层转回 throw；
 *   - 仅迁移 39 通道可覆盖的端点；files/models/memory/workspace 等域待扩通道后按批补齐。
 *
 * 刻意的架构性等价替换（BRD-009，SSE/HTTP → IPC）：
 *   - apiControl 的 8s 槽位自愈不再需要：IPC 不占浏览器同源连接池，SSE 已移至 main 侧
 *     事件桥；createAgentThread/resumeAgentThread/deleteSessions 等控制面函数签名保留，
 *     超时由 main 转发器（120s）兜底；
 *   - listRuns/getRun 的 options.signal 参数签名保留（调用方兼容），桌面形态无对应
 *     abort 通道，运行时忽略；
 *   - 转发器按信封约定跳过空串/undefined/null 查询参数，与服务端 `x || ""` 兜底等价。
 */
import type {
  ChannelRequest,
  ChannelResponse,
  DesktopChannelId
} from "../../shared/protocol/channels";
import { invokeChannelRaw } from "./ipc-client";

// 文件身份与预览地址（D01）：与 api.js 同一出口，复用 F1 已迁纯函数层。
export {
  PREVIEW_STATE,
  PREVIEW_STATE_LABEL,
  buildDocUrls,
  makeFileIdentity,
  mergeFileIdentity,
  fileIdentityKey,
  identityMatches,
  readIdentityHeader,
  withRevision,
  looksUnsupported,
  previewStateFromError
} from "../lib/file-urls";

/** API 失败异常：对齐 api.js 的 throw 形状（message + code + detail），附加 status 便于诊断。 */
export class ApiError extends Error {
  status: number;
  code?: string;
  detail?: unknown;

  constructor(message: string, status: number, code?: string, detail?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    // 对齐旧实现的 truthy 赋值：code/detail 缺省（undefined/空串）不挂到 error 上
    if (code) this.code = code;
    if (detail) this.detail = detail;
  }
}

/** 通道调用 + 失败转 throw：invoke 结果信封 → 旧 api() 的「返回 data 或 throw」语义。 */
async function invokeOrThrow<C extends DesktopChannelId>(
  channel: C,
  payload?: ChannelRequest<C>
): Promise<ChannelResponse<C>> {
  const result = await invokeChannelRaw(channel, payload);
  if (!result.ok) {
    throw new ApiError(result.data.error || `HTTP ${result.status}`, result.status, result.data.code, result.data.detail);
  }
  return result.data;
}

// ============================================================================
// 状态族
// ============================================================================

export const getStatus = (): Promise<ChannelResponse<"op:status:get">> => invokeOrThrow("op:status:get");

// ============================================================================
// 会话（线程）族
// ============================================================================

export interface ListSessionsOptions {
  file?: string;
  projectId?: string;
  mode?: string;
  runStatus?: string;
  pinned?: boolean | string;
  frozen?: boolean | string;
}

export function listSessions(fileOrOptions: string | ListSessionsOptions = {}): Promise<ChannelResponse<"op:sessions:list">> {
  const query: NonNullable<ChannelRequest<"op:sessions:list">["query"]> = {};
  if (typeof fileOrOptions === "string") {
    if (fileOrOptions) query.file = fileOrOptions;
  } else {
    const options = fileOrOptions ?? {};
    if (options.file) query.file = options.file;
    if (options.projectId) query.projectId = options.projectId;
    if (options.mode) query.mode = options.mode;
    if (options.runStatus) query.runStatus = options.runStatus;
    // 对齐旧实现 URLSearchParams.set(String(...))：值原样字符串化，不归一化为布尔字面量
    if (options.pinned !== undefined && options.pinned !== null) query.pinned = String(options.pinned) as "true" | "false";
    if (options.frozen !== undefined && options.frozen !== null) query.frozen = String(options.frozen) as "true" | "false";
  }
  return invokeOrThrow("op:sessions:list", { query });
}

export const getSession = (id: string, options: { view?: string; limit?: number; before?: number } = {}): Promise<ChannelResponse<"op:sessions:get">> => {
  // 旧实现跳过 undefined/null/空串；TS 侧 limit/before 收窄为 number，保留 null 防御
  const query: NonNullable<ChannelRequest<"op:sessions:get">["query"]> = {};
  if (options.view) query.view = options.view as "chat";
  if (options.limit !== undefined && options.limit !== null) query.limit = options.limit;
  if (options.before !== undefined && options.before !== null) query.before = options.before;
  return invokeOrThrow("op:sessions:get", { params: { id }, query });
};

export const deleteSession = (id: string): Promise<ChannelResponse<"op:sessions:delete">> =>
  invokeOrThrow("op:sessions:delete", { params: { id } });

export const deleteSessions = (ids: string[]): Promise<ChannelResponse<"op:sessions:batch-delete">> =>
  invokeOrThrow("op:sessions:batch-delete", { body: { ids } });

export const renameSession = (id: string, label: string): Promise<ChannelResponse<"op:sessions:rename">> =>
  invokeOrThrow("op:sessions:rename", { params: { id }, body: { label } });

export const pinSession = (id: string, pinned = true): Promise<ChannelResponse<"op:sessions:pin">> =>
  invokeOrThrow("op:sessions:pin", { params: { id }, body: { pinned } });

export const freezeSession = (id: string, frozen = true, reason = ""): Promise<ChannelResponse<"op:sessions:freeze">> =>
  invokeOrThrow("op:sessions:freeze", { params: { id }, body: { frozen, reason } });

export const forkSession = (id: string, label?: string, options: Record<string, unknown> = {}): Promise<ChannelResponse<"op:sessions:fork">> =>
  invokeOrThrow("op:sessions:fork", { params: { id }, body: { label, ...options } });

// ============================================================================
// 运行（Run）族
// ============================================================================

export interface ListRunsOptions {
  sessionId?: string;
  cwd?: string;
  projectId?: string;
  status?: string;
  mode?: string;
  query?: string;
  includeEvents?: string | boolean;
  fields?: string;
  /** 浏览器形态的取消信号；桌面 IPC 形态无对应通道，签名保留、运行时忽略 */
  signal?: AbortSignal;
}

export function listRuns(thread = "", limit = 50, options: ListRunsOptions = {}): Promise<ChannelResponse<"op:runs:list">> {
  const query: NonNullable<ChannelRequest<"op:runs:list">["query"]> = { limit };
  if (thread) query.thread = thread;
  if (options.sessionId) query.session = options.sessionId;
  if (options.cwd) query.cwd = options.cwd;
  if (options.projectId) query.projectId = options.projectId;
  if (options.status && options.status !== "all") query.status = options.status;
  if (options.mode && options.mode !== "all") query.mode = options.mode;
  if (options.query) query.query = options.query;
  if (options.includeEvents) query.includeEvents = options.includeEvents as "all";
  if (options.fields) query.fields = options.fields as "summary";
  return invokeOrThrow("op:runs:list", { query });
}

export const getRun = (id: string, _options: { signal?: AbortSignal } = {}): Promise<ChannelResponse<"op:runs:get">> =>
  invokeOrThrow("op:runs:get", { params: { id } });

export const cancelRun = (id: string, reason = "用户请求取消"): Promise<ChannelResponse<"op:runs:cancel">> =>
  invokeOrThrow("op:runs:cancel", { params: { id }, body: { reason } });

export const resumeRun = (id: string): Promise<ChannelResponse<"op:runs:resume">> =>
  invokeOrThrow("op:runs:resume", { params: { id }, body: {} });

export const retryRun = (id: string): Promise<ChannelResponse<"op:runs:retry">> =>
  invokeOrThrow("op:runs:retry", { params: { id }, body: {} });

export const rollbackRun = (id: string, paths: string[]): Promise<ChannelResponse<"op:runs:rollback">> =>
  invokeOrThrow("op:runs:rollback", { params: { id }, body: { confirm: true, paths } });

export const updateRunStep = (id: string, stepId: string, patch: Record<string, unknown>): Promise<ChannelResponse<"op:runs:step">> =>
  invokeOrThrow("op:runs:step", { params: { id, stepId }, body: patch || {} });

export const publishArtifact = (runId: string, artifactId: string): Promise<ChannelResponse<"op:runs:artifacts:publish">> =>
  invokeOrThrow("op:runs:artifacts:publish", { params: { id: runId, artifactId }, body: {} });

export const confirmArtifactAcceptance = (runId: string, artifactId: string, note = ""): Promise<ChannelResponse<"op:runs:artifacts:accept">> =>
  invokeOrThrow("op:runs:artifacts:accept", { params: { id: runId, artifactId }, body: { note } });

export const getRunAcceptance = (runId: string): Promise<ChannelResponse<"op:runs:acceptance">> =>
  invokeOrThrow("op:runs:acceptance", { params: { id: runId } });

export const getRunChangeDiff = (runId: string, changeId: string, page = 0): Promise<ChannelResponse<"op:runs:diff">> =>
  invokeOrThrow("op:runs:diff", { params: { id: runId, changeId }, query: page ? { page } : undefined });

export const listArtifacts = (options: { cwd?: string; projectId?: string } = {}): Promise<ChannelResponse<"op:artifacts:list">> => {
  const query: NonNullable<ChannelRequest<"op:artifacts:list">["query"]> = {};
  if (options.cwd) query.cwd = options.cwd;
  if (options.projectId) query.projectId = options.projectId;
  return invokeOrThrow("op:artifacts:list", { query });
};

export const listPublishedArtifacts = (cwd: string, projectId = ""): Promise<ChannelResponse<"op:artifacts:list">> => {
  const query: NonNullable<ChannelRequest<"op:artifacts:list">["query"]> = {};
  if (cwd) query.cwd = cwd;
  if (projectId) query.projectId = projectId;
  return invokeOrThrow("op:artifacts:list", { query });
};

export const rollbackPublishedArtifact = (publicationId: string): Promise<ChannelResponse<"op:artifacts:rollback">> =>
  invokeOrThrow("op:artifacts:rollback", { params: { publicationId }, body: { confirm: true } });

// ============================================================================
// Agent 交互族
// ============================================================================

export const compactAgentContext = (client: string, thread: string, instructions = ""): Promise<ChannelResponse<"op:agent:compact">> =>
  invokeOrThrow("op:agent:compact", { body: { client, thread, instructions } });

/** 发送对话消息（ChatPanel.send：旧内联 fetch("/api/agent/prompt") → IPC 通道；admission 响应，后续状态走事件流）。 */
export const sendAgentPrompt = (body: ChannelRequest<"op:agent:prompt">["body"]): Promise<ChannelResponse<"op:agent:prompt">> =>
  invokeOrThrow("op:agent:prompt", { body });

/** 中止当前运行（ChatPanel.stop：旧内联 fetch("/api/agent/abort") → IPC 通道；result.cancelled === false 语义由调用方判定）。 */
export const abortAgent = (client: string, thread?: string): Promise<ChannelResponse<"op:agent:abort">> =>
  invokeOrThrow("op:agent:abort", { body: { client, thread } });

/** 切换模型（ChatPanel.changeModel：旧 api.js setAgentModel → POST /api/agent/model）。 */
export const setAgentModel = (client: string, model: string, thread?: string): Promise<ChannelResponse<"op:agent:model:set">> =>
  invokeOrThrow("op:agent:model:set", { body: { client, thread, model } });

/** Pi 运行时上下文用量快照（ChatPanel 恢复/切换会话后回填：旧内联 fetch("/api/agent/runtime") → IPC 通道）。 */
export const getAgentRuntime = (client: string, thread?: string): Promise<ChannelResponse<"op:agent:runtime">> =>
  invokeOrThrow("op:agent:runtime", { query: { client, thread } });

/** 控制面（原 apiControl 20s 超时）：桌面形态直通，超时由 main 转发器兜底（见文件头说明）。 */
export const createAgentThread = (client: string, thread: string, cwd: string, options: Record<string, unknown> = {}): Promise<ChannelResponse<"op:agent:new">> =>
  invokeOrThrow("op:agent:new", { body: { client, thread, cwd, ...options } });

/** 控制面（原 apiControl 20s 超时）：桌面形态直通，超时由 main 转发器兜底（见文件头说明）。 */
export const resumeAgentThread = (client: string, thread: string, sessionId: string, cwd: string): Promise<ChannelResponse<"op:agent:resume">> =>
  invokeOrThrow("op:agent:resume", { body: { client, thread, sessionId, cwd } });

export const listPendingQuestions = (client: string, thread: string): Promise<ChannelResponse<"op:agent:pending">> =>
  invokeOrThrow("op:agent:pending", { query: { client, thread } });

export const getApprovalMode = (): Promise<ChannelResponse<"op:agent:approval-mode:get">> =>
  invokeOrThrow("op:agent:approval-mode:get");

export const setApprovalMode = (mode: string): Promise<ChannelResponse<"op:agent:approval-mode:set">> =>
  invokeOrThrow("op:agent:approval-mode:set", { body: { mode: mode as "ask" | "auto" } });

export const markAgentEventsRead = (client: string, seq: number): Promise<ChannelResponse<"op:agent:events-read">> =>
  invokeOrThrow("op:agent:events-read", { body: { client, seq } });

/** 全局事件游标状态（App.jsx 冷启动游标引导：GET /api/agent/events/state → IPC 通道）。 */
export const agentEventsState = (client: string): Promise<ChannelResponse<"op:agent:events-state">> =>
  invokeOrThrow("op:agent:events-state", { query: { client } });

/** 提交工具审批决策（PendingActionBar/ApprovalBlock：旧组件内联 fetch("/api/agent/approval") → IPC 通道）。 */
export const submitAgentApproval = (id: string, decision: "allow" | "always" | "deny"): Promise<ChannelResponse<"op:agent:approval">> =>
  invokeOrThrow("op:agent:approval", { body: { id, decision } });

/** 回答 agent 提问（AskBlock/PendingActionBar：旧组件内联 fetch("/api/agent/answer") → IPC 通道）。
 * thread 允许 null（旧组件在线程未建时传 null，服务端 `thread || ""` 兜底）；404 失效分支由调用方按 ApiError.status 判定。 */
export const answerAgentQuestion = (client: string, thread: string | null, answer: string): Promise<ChannelResponse<"op:agent:answer">> =>
  invokeOrThrow("op:agent:answer", { body: { client, thread: thread ?? undefined, answer } });

// ============================================================================
// 记忆域（F3 批4：MemoryTab；对齐 client/src/api.js 记忆端点族）
// ============================================================================

export const listMemoryFiles = (): Promise<ChannelResponse<"op:memory:list">> => invokeOrThrow("op:memory:list");

export const initMemory = (): Promise<ChannelResponse<"op:memory:init">> => invokeOrThrow("op:memory:init");

export const readMemoryFile = (rel: string): Promise<ChannelResponse<"op:memory:file:get">> =>
  invokeOrThrow("op:memory:file:get", { params: { rel } });

export const saveMemoryFile = (rel: string, content: string): Promise<ChannelResponse<"op:memory:file:save">> =>
  invokeOrThrow("op:memory:file:save", { params: { rel }, body: { content } });

export function listMemoryProposals(workspace = "", status = "", projectId = ""): Promise<ChannelResponse<"op:memory:proposals:list">> {
  // 对齐旧实现 URLSearchParams：仅非空值入串（转发器同样剔除空值，双保险）
  const query: NonNullable<ChannelRequest<"op:memory:proposals:list">["query"]> = {};
  if (workspace) query.workspace = workspace;
  if (status) query.status = status;
  if (projectId) query.projectId = projectId;
  return invokeOrThrow("op:memory:proposals:list", { query });
}

export const approveMemoryProposal = (id: string, payload: Record<string, unknown> = {}): Promise<ChannelResponse<"op:memory:proposals:approve">> =>
  invokeOrThrow("op:memory:proposals:approve", { params: { id }, body: payload || {} });

export const editMemoryProposal = (id: string, payload: Record<string, unknown> = {}): Promise<ChannelResponse<"op:memory:proposals:edit">> =>
  invokeOrThrow("op:memory:proposals:edit", { params: { id }, body: payload || {} });

export const rejectMemoryProposal = (id: string, reason = "用户拒绝该记忆建议"): Promise<ChannelResponse<"op:memory:proposals:reject">> =>
  invokeOrThrow("op:memory:proposals:reject", { params: { id }, body: { reason } });

export const mergeMemoryProposals = (targetId: string, sourceIds: string[] = []): Promise<ChannelResponse<"op:memory:proposals:merge">> =>
  invokeOrThrow("op:memory:proposals:merge", { params: { id: targetId }, body: { sourceIds } });

export const memoryProposalHistory = (id: string): Promise<ChannelResponse<"op:memory:proposals:history">> =>
  invokeOrThrow("op:memory:proposals:history", { params: { id } });

// ============================================================================
// 文件族（F3 批5b-2：SessionSidebar 文件树/上传/搜索；批7b：App 工作区文件列表）
// ============================================================================

/** listFiles（App.jsx 启动加载/目录导航）：旧 api.js 空值参数不进查询串（转发器同口径再剔除）。 */
export function listFiles(dir = "", workspace = ""): Promise<ChannelResponse<"op:files:list">> {
  const query: NonNullable<ChannelRequest<"op:files:list">["query"]> = {};
  if (dir) query.dir = dir;
  if (workspace) query.workspace = workspace;
  return invokeOrThrow("op:files:list", { query });
}

export function searchFiles(query: string, limit = 200, workspace = ""): Promise<ChannelResponse<"op:files:search">> {
  const reqQuery: NonNullable<ChannelRequest<"op:files:search">["query"]> = { q: query, limit };
  if (workspace) reqQuery.workspace = workspace;
  return invokeOrThrow("op:files:search", { query: reqQuery });
}

export const uploadFile = (name: string, base64: string, workspace = ""): Promise<ChannelResponse<"op:files:upload">> =>
  invokeOrThrow("op:files:upload", { body: workspace ? { name, base64, workspace } : { name, base64 } });

export const deleteFile = (name: string, workspace = ""): Promise<ChannelResponse<"op:files:delete">> =>
  invokeOrThrow("op:files:delete", { body: workspace ? { name, workspace } : { name } });

/** 存入知识库（SessionSidebar 右键菜单）：旧组件内联 fetch("/api/kb/ingest") → IPC 通道。 */
export const ingestToKb = (name: string): Promise<ChannelResponse<"op:kb:ingest">> =>
  invokeOrThrow("op:kb:ingest", { body: { name } });

// ============================================================================
// 模型族（listModels 10s 单飞缓存逐行等价；refreshModels 立即失效缓存）
// ============================================================================

let modelsCache: ChannelResponse<"op:models:list"> | null = null;
let modelsCacheAt = 0;
let modelsInflight: Promise<ChannelResponse<"op:models:list">> | null = null;

export function listModels({ maxAgeMs = 10000 } = {}): Promise<ChannelResponse<"op:models:list">> {
  const now = Date.now();
  if (modelsCache && now - modelsCacheAt < maxAgeMs) return Promise.resolve(modelsCache);
  if (modelsInflight) return modelsInflight;
  modelsInflight = invokeOrThrow("op:models:list")
    .then((data) => { modelsCache = data; modelsCacheAt = Date.now(); return data; })
    .finally(() => { modelsInflight = null; });
  return modelsInflight;
}

export const refreshModels = (): Promise<ChannelResponse<"op:models:refresh">> =>
  invokeOrThrow("op:models:refresh").then((data) => { modelsCache = null; return data; });

// ============================================================================
// Agent 配置族（SettingsPanel：鉴权/导入/网络/模型配置/目录/探测/权限）
// ============================================================================

export const agentAuth = (): Promise<ChannelResponse<"op:agent:auth:get">> => invokeOrThrow("op:agent:auth:get");

export const agentAuthSave = (provider: string, key: string): Promise<ChannelResponse<"op:agent:auth:save">> =>
  invokeOrThrow("op:agent:auth:save", { body: { provider, key } });

export const agentAuthRemove = (provider: string): Promise<ChannelResponse<"op:agent:auth:remove">> =>
  invokeOrThrow("op:agent:auth:remove", { body: { provider } });

export const agentCustomProvider = (payload: Record<string, unknown> = {}): Promise<ChannelResponse<"op:agent:custom-provider">> =>
  invokeOrThrow("op:agent:custom-provider", { body: payload });

export const agentConfigStatus = (): Promise<ChannelResponse<"op:agent:config-status">> =>
  invokeOrThrow("op:agent:config-status");

export const agentPlans = (): Promise<ChannelResponse<"op:agent:plans">> => invokeOrThrow("op:agent:plans");

export const agentPlanModels = (planId: string): Promise<ChannelResponse<"op:agent:plans:models">> =>
  invokeOrThrow("op:agent:plans:models", { query: { planId } });

export const agentPlanApply = (payload: Record<string, unknown> = {}): Promise<ChannelResponse<"op:agent:plans:apply">> =>
  invokeOrThrow("op:agent:plans:apply", { body: payload });

export const agentPlanDisconnect = (planId: string): Promise<ChannelResponse<"op:agent:plans:disconnect">> =>
  invokeOrThrow("op:agent:plans:disconnect", { body: { planId } });

export const agentImportPreview = (): Promise<ChannelResponse<"op:agent:import-preview">> =>
  invokeOrThrow("op:agent:import-preview");

export const agentImportConfig = (options: Record<string, unknown> = {}): Promise<ChannelResponse<"op:agent:import-config">> =>
  invokeOrThrow("op:agent:import-config", { body: options });

export function agentDiagnostics(client = "", thread = "", runId = ""): Promise<ChannelResponse<"op:agent:diagnostics">> {
  const query: NonNullable<ChannelRequest<"op:agent:diagnostics">["query"]> = {};
  if (client) query.client = client;
  if (thread) query.thread = thread;
  if (runId) query.runId = runId;
  return invokeOrThrow("op:agent:diagnostics", { query });
}

export const agentNetworkSettings = (): Promise<ChannelResponse<"op:agent:network-settings:get">> =>
  invokeOrThrow("op:agent:network-settings:get");

export const agentNetworkSettingsSave = (settings: Record<string, unknown> = {}): Promise<ChannelResponse<"op:agent:network-settings:save">> =>
  invokeOrThrow("op:agent:network-settings:save", { body: settings });

export const agentModelConfigs = (): Promise<ChannelResponse<"op:agent:model-configs:list">> =>
  invokeOrThrow("op:agent:model-configs:list");

export const saveAgentModelConfig = (payload: Record<string, unknown> = {}): Promise<ChannelResponse<"op:agent:model-configs:save">> =>
  invokeOrThrow("op:agent:model-configs:save", { body: payload });

export const deleteAgentModelConfig = (provider: string): Promise<ChannelResponse<"op:agent:model-configs:delete">> =>
  invokeOrThrow("op:agent:model-configs:delete", { params: { provider } });

export const fetchAgentModels = (payload: Record<string, unknown> = {}): Promise<ChannelResponse<"op:agent:model-configs:fetch-models">> =>
  invokeOrThrow("op:agent:model-configs:fetch-models", { body: payload });

export const agentProviderCatalog = (): Promise<ChannelResponse<"op:agent:provider-catalog">> =>
  invokeOrThrow("op:agent:provider-catalog");

export const agentProviderDetail = (provider: string): Promise<ChannelResponse<"op:agent:provider-catalog:detail">> =>
  invokeOrThrow("op:agent:provider-catalog:detail", { params: { id: provider } });

export const agentProviderImport = (payload: Record<string, unknown> = {}): Promise<ChannelResponse<"op:agent:provider-catalog:import">> =>
  invokeOrThrow("op:agent:provider-catalog:import", { body: payload });

export const agentProviderCatalogRefresh = (): Promise<ChannelResponse<"op:agent:provider-catalog:refresh">> =>
  invokeOrThrow("op:agent:provider-catalog:refresh");

export const agentSetDefaultModel = (provider: string, model: string): Promise<ChannelResponse<"op:agent:default-model:set">> =>
  invokeOrThrow("op:agent:default-model:set", { body: { provider, model } });

export const probeAgentModel = (model: unknown, timeoutMs = 15000): Promise<ChannelResponse<"op:agent:model:probe">> =>
  invokeOrThrow("op:agent:model:probe", { body: { model, timeoutMs } });

export const getPermissionRules = (): Promise<ChannelResponse<"op:agent:permissions:get">> =>
  invokeOrThrow("op:agent:permissions:get");

export const removePermissionRule = (rule: Record<string, unknown>): Promise<ChannelResponse<"op:agent:permissions:rule:remove">> =>
  invokeOrThrow("op:agent:permissions:rule:remove", { body: rule });

// ============================================================================
// 联网搜索配置族
// ============================================================================

export const searchSettings = (): Promise<ChannelResponse<"op:search:settings:get">> =>
  invokeOrThrow("op:search:settings:get");

export const searchSettingsSave = (settings: Record<string, unknown> = {}): Promise<ChannelResponse<"op:search:settings:save">> =>
  invokeOrThrow("op:search:settings:save", { body: settings });

export const searchSettingsTest = (backend = "", draft: unknown = null): Promise<ChannelResponse<"op:search:test">> =>
  invokeOrThrow("op:search:test", { body: draft ? { backend, draft } : { backend } });

// ============================================================================
// 地图设置族
// ============================================================================

export const mapSettings = (): Promise<ChannelResponse<"op:map:settings:get">> => invokeOrThrow("op:map:settings:get");

export const mapSettingsSave = (basemaps: unknown): Promise<ChannelResponse<"op:map:settings:save">> =>
  invokeOrThrow("op:map:settings:save", { body: { basemaps } });

// ============================================================================
// 地图项目/图层族（F5-5 画布层消费端点；对齐 client/src/api.js 同名函数语义）
// ============================================================================

/** mapImportLayer（MapViewer 导入 GeoJSON/SHP）：成功返回 { ok, tiles, ... }。 */
export const mapImportLayer = (name: string, layerId: string, geojson: unknown): Promise<ChannelResponse<"op:map:import">> =>
  invokeOrThrow("op:map:import", { body: { name, layerId, geojson } });

/** mapGetLayer（AttributeTable 属性表 / MapViewer 边界标注数据）：返回 { features, ... }。 */
export const mapGetLayer = (name: string, layerId: string): Promise<ChannelResponse<"op:map:layer:get">> =>
  invokeOrThrow("op:map:layer:get", { query: { name, layer: layerId } });

/** style.json 动态读文本（MapViewer 加载/轮询热更：旧 fetch(STYLE_PATH).text() → IPC 通道）。 */
export const mapDataStyleText = async (project: string): Promise<string> => {
  const r = await invokeOrThrow("op:map:data:style", { query: { project } });
  return String((r as { text?: string }).text ?? "");
};

// ============================================================================
// 地图分析可视化族（F5-6 面板层消费端点；对齐 client/src/api.js 同名函数语义）
// ============================================================================

/** mapVisualSources（VisualPanel 数据源发现）：返回 { sources, planned }。 */
export const mapVisualSources = (): Promise<ChannelResponse<"op:map:visual:sources">> =>
  invokeOrThrow("op:map:visual:sources");

/** mapVisual（统一可视化描述符）：空值参数不进查询串；error 字段抛出 + descriptor 解包。 */
export async function mapVisual(params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const rawQuery: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") rawQuery[k] = String(v);
  }
  const r = await invokeOrThrow("op:map:visual:get", { query: rawQuery as ChannelRequest<"op:map:visual:get">["query"] });
  // 对齐旧实现：描述符失败走 HTTP 200 + error 字段语义（不走失败信封），此处转回 throw；
  // descriptor 缺省时回退整体（旧 `r?.descriptor || r`）
  if (r?.error) throw new Error(r.error);
  return (r?.descriptor || r) as Record<string, unknown>;
}

/** mapDemoAnalysis（演示分析）：query 默认值忠实转录（analysis/region/project/count 字符串化）。 */
export const mapDemoAnalysis = (
  params: { analysis?: string; region?: string; project?: string; count?: string | number } = {}
): Promise<ChannelResponse<"op:map:demo-analysis">> =>
  invokeOrThrow("op:map:demo-analysis", {
    query: {
      analysis: params.analysis || "heatmap",
      region: params.region || "义乌市",
      project: params.project || "zhejiang-map",
      count: String(params.count || 36)
    }
  });

/** mapReport（GIS G8 分析报告一键成文）：POST 载荷整体透传，返回 { fileName, ... }。 */
export const mapReport = (payload: Record<string, unknown> = {}): Promise<ChannelResponse<"op:map:report">> =>
  invokeOrThrow("op:map:report", { body: payload || {} });

// ============================================================================
// 地图项目生命周期/样式配置/导入瓦片族（F5-7 map-panel 消费端点；逐一对齐 client/src/api.js）
// ============================================================================

/** mapProjects（项目清单）：GET /api/map/projects，返回 { projects, ... }。 */
export const mapProjects = (): Promise<ChannelResponse<"op:map:projects:list">> =>
  invokeOrThrow("op:map:projects:list");

/** mapCreateProject：POST { project, name, baseProject }，旧默认 baseProject="zhejiang-map"。 */
export const mapCreateProject = (project: string, name: string, baseProject = "zhejiang-map"): Promise<ChannelResponse<"op:map:projects:create">> =>
  invokeOrThrow("op:map:projects:create", { body: { project, name, baseProject } });

/** mapProject（项目详情 + layerViews 归属视图）：旧实现空值参数不进查询串。 */
export const mapProject = (name: string, workspace = ""): Promise<ChannelResponse<"op:map:project:get">> => {
  const query: NonNullable<ChannelRequest<"op:map:project:get">["query"]> = {};
  if (name) query.name = name;
  // 图层归属视图需要工作区身份：共享数据集 + 本工作区自有图层（阶段 1）。
  if (workspace) query.workspace = workspace;
  return invokeOrThrow("op:map:project:get", { query });
};

/** mapSaveStyle：POST { name, style }（style.json 全量写 + 服务端热更新）。 */
export const mapSaveStyle = (name: string, style: unknown): Promise<ChannelResponse<"op:map:style:save">> =>
  invokeOrThrow("op:map:style:save", { body: { name, style } });

/** mapSaveConfig：POST { name, config }（map.config.json 全量写）。 */
export const mapSaveConfig = (name: string, config: unknown): Promise<ChannelResponse<"op:map:config:save">> =>
  invokeOrThrow("op:map:config:save", { body: { name, config } });

/** mapDeleteLayer：POST { name, layerId }（数据与瓦片一并移除）。 */
export const mapDeleteLayer = (name: string, layerId: string): Promise<ChannelResponse<"op:map:layer:delete">> =>
  invokeOrThrow("op:map:layer:delete", { body: { name, layerId } });

/** mapRebuild：POST { name, layerIds }（旧实现 layerIds 可省略）。 */
export const mapRebuild = (name: string, layerIds?: string[] | null): Promise<ChannelResponse<"op:map:rebuild">> =>
  invokeOrThrow("op:map:rebuild", { body: { name, layerIds: layerIds ?? null } });

/** mapImportBatch：POST { name, items }，返回 { layers, ... }（逐层 ok/tiles/error）。 */
export const mapImportBatch = (name: string, items: unknown[]): Promise<ChannelResponse<"op:map:import:batch">> =>
  invokeOrThrow("op:map:import:batch", { body: { name, items } });

/** mapPrepare（目录一键生成）：POST { srcDir }，返回 { ok, prepare, tiles }。 */
export const mapPrepare = (srcDir: string): Promise<ChannelResponse<"op:map:prepare">> =>
  invokeOrThrow("op:map:prepare", { body: { srcDir } });

/** mapIsochrone（等时圈）：POST { location, mode, range, rangeType }。旧 body 另带 name（项目名，
 *  server /api/map/isochrone 不消费该字段），通道载荷按 schema 只传服务端实际读取的四元组。 */
export const mapIsochrone = (params: { location?: string; mode?: string; range?: number; rangeType?: string }): Promise<ChannelResponse<"op:map:isochrone">> =>
  invokeOrThrow("op:map:isochrone", {
    body: { location: params.location, mode: params.mode, range: params.range, rangeType: params.rangeType }
  });

/** mapRoute（路径规划）：POST { from, to, mode, provider }，返回 { provider, distance, duration, geometry }。 */
export const mapRoute = (params: { from?: string; to?: string; mode?: string; provider?: string }): Promise<ChannelResponse<"op:map:route">> =>
  invokeOrThrow("op:map:route", {
    body: { from: params.from, to: params.to, mode: params.mode, provider: params.provider }
  });

/** mapDuplicateProject：POST { project, name }，返回 { ok, project, config }。 */
export const mapDuplicateProject = (project: string, name: string): Promise<ChannelResponse<"op:map:projects:duplicate">> =>
  invokeOrThrow("op:map:projects:duplicate", { body: { project, name } });

/** mapRenameProject：POST { project, name }。 */
export const mapRenameProject = (project: string, name: string): Promise<ChannelResponse<"op:map:projects:rename">> =>
  invokeOrThrow("op:map:projects:rename", { body: { project, name } });

/** mapArchiveProject：POST { project, archived }，旧默认 archived=true。 */
export const mapArchiveProject = (project: string, archived = true): Promise<ChannelResponse<"op:map:projects:archive">> =>
  invokeOrThrow("op:map:projects:archive", { body: { project, archived } });

/** mapDeleteProject：POST { project }（移入回收目录 .trash）。 */
export const mapDeleteProject = (project: string): Promise<ChannelResponse<"op:map:projects:delete">> =>
  invokeOrThrow("op:map:projects:delete", { body: { project } });

/** mapExportBatch（G7 批量导出·flag OAW_MAP_EXPORT 默认关）：POST 载荷整体透传，返回 { batchId, total, skipped }。 */
export const mapExportBatch = (payload: Record<string, unknown> = {}): Promise<ChannelResponse<"op:map:export:batch:start">> =>
  invokeOrThrow("op:map:export:batch:start", { body: payload || {} });

/** mapExportStatus：GET ?id=，返回 { status, summary, ... }。 */
export const mapExportStatus = (id: string): Promise<ChannelResponse<"op:map:export:batch:status">> =>
  invokeOrThrow("op:map:export:batch:status", { query: { id } });

// ============================================================================
// 项目族
// ============================================================================

/** listProjects（App.jsx 项目列表加载）：旧 api.js 空值参数不进查询串。 */
export function listProjects(options: { type?: string; status?: string; sort?: string; pinned?: boolean | string } = {}): Promise<ChannelResponse<"op:projects:list">> {
  const query: NonNullable<ChannelRequest<"op:projects:list">["query"]> = {};
  if (options.type) query.type = options.type;
  if (options.status) query.status = options.status;
  if (options.sort) query.sort = options.sort;
  // 对齐旧实现 params.set(String(...))：值原样字符串化
  if (options.pinned !== undefined && options.pinned !== null) query.pinned = String(options.pinned);
  return invokeOrThrow("op:projects:list", { query });
}

export const createProject = (payload: Record<string, unknown>): Promise<ChannelResponse<"op:projects:create">> =>
  invokeOrThrow("op:projects:create", { body: payload || {} });

export const classifyProjects = (apply = false): Promise<ChannelResponse<"op:projects:classify">> =>
  invokeOrThrow("op:projects:classify", { body: { apply } });

export const updateProject = (id: string, patch: Record<string, unknown>): Promise<ChannelResponse<"op:projects:update">> =>
  invokeOrThrow("op:projects:update", { params: { id }, body: patch || {} });

export const pinProject = (id: string, pinned = true): Promise<ChannelResponse<"op:projects:pin">> =>
  invokeOrThrow("op:projects:pin", { params: { id }, body: { pinned } });

export const archiveProject = (id: string, archived = true): Promise<ChannelResponse<"op:projects:archive">> =>
  invokeOrThrow("op:projects:archive", { params: { id }, body: { archived } });

export const updateProjectSettings = (id: string, settings: Record<string, unknown>): Promise<ChannelResponse<"op:projects:settings:update">> =>
  invokeOrThrow("op:projects:settings:update", { params: { id }, body: settings || {} });

// ============================================================================
// 工作区族
// ============================================================================

export const listWorkspaces = (): Promise<ChannelResponse<"op:workspaces:list">> =>
  invokeOrThrow("op:workspaces:list");

export const switchWorkspace = (path: string): Promise<ChannelResponse<"op:workspace:switch">> =>
  invokeOrThrow("op:workspace:switch", { body: { path } });

export const validateWorkspace = (path: string): Promise<ChannelResponse<"op:workspace:validate">> =>
  invokeOrThrow("op:workspace:validate", { body: { path } });

export const pickWorkspace = (): Promise<ChannelResponse<"op:workspace:pick">> =>
  invokeOrThrow("op:workspace:pick", { body: {} });

export const cancelWorkspacePick = (): Promise<ChannelResponse<"op:workspace:pick:cancel">> =>
  invokeOrThrow("op:workspace:pick:cancel", { body: {} });

// ============================================================================
// 外部目录（文件根）族
// ============================================================================

export const listFileRoots = (): Promise<ChannelResponse<"op:file-roots:list">> => invokeOrThrow("op:file-roots:list");

export const addFileRoot = (path: string, label?: string): Promise<ChannelResponse<"op:file-roots:add">> =>
  invokeOrThrow("op:file-roots:add", { body: { path, label } });

export const removeFileRoot = (id: string): Promise<ChannelResponse<"op:file-roots:remove">> =>
  invokeOrThrow("op:file-roots:remove", { params: { id } });

// ============================================================================
// 系统集成族
// ============================================================================

export const pickNativeFiles = (options: Record<string, unknown> = {}): Promise<ChannelResponse<"op:system:pick-files">> =>
  invokeOrThrow("op:system:pick-files", { body: options });

export const openInSystem = (path: string): Promise<ChannelResponse<"op:system:open">> =>
  invokeOrThrow("op:system:open", { body: { path } });

export const revealInSystem = (path: string): Promise<ChannelResponse<"op:system:reveal">> =>
  invokeOrThrow("op:system:reveal", { body: { path } });

// ============================================================================
// 文档预览族（F4-3 读路由 + F4-4 写路由：annotations POST / raw-save / cells / edit / office / watch）
// ============================================================================

/** doc 域查询参数族：cwd=预览工作区；client/thread 打开时记录 agent 当前工作文件。 */
export interface DocQueryOptions {
  cwd?: string;
  client?: string;
  thread?: string;
}

const docQuery = (options: DocQueryOptions = {}): NonNullable<ChannelRequest<"op:doc:open">["query"]> => {
  const query: NonNullable<ChannelRequest<"op:doc:open">["query"]> = {};
  if (options.cwd) query.cwd = options.cwd;
  if (options.client) query.client = options.client;
  if (options.thread) query.thread = options.thread;
  return query;
};

/** 打开文档（GET /api/doc/:name）：按扩展名返回 kind 分发响应（server L1069-1111）。 */
export const openDoc = (name: string, options: DocQueryOptions = {}): Promise<ChannelResponse<"op:doc:open">> =>
  invokeOrThrow("op:doc:open", { params: { name }, query: docQuery(options) });

/** 原始字节（GET /api/doc/:name/raw）：base64+mime，渲染层自建 blob URL。 */
export const fetchDocRaw = (name: string, options: DocQueryOptions = {}): Promise<ChannelResponse<"op:doc:raw">> =>
  invokeOrThrow("op:doc:raw", { params: { name }, query: docQuery(options) });

/** docx 纯文本（GET /api/doc/:name/text）。 */
export const fetchDocText = (name: string, options: DocQueryOptions = {}): Promise<ChannelResponse<"op:doc:text">> =>
  invokeOrThrow("op:doc:text", { params: { name }, query: docQuery(options) });

/** 渲染 HTML（GET /api/doc/:name/html）：含注入的身份 postMessage 脚本。 */
export const fetchDocHtml = (name: string, options: DocQueryOptions = {}): Promise<ChannelResponse<"op:doc:html">> =>
  invokeOrThrow("op:doc:html", { params: { name }, query: docQuery(options) });

/** 批注列表（GET /api/doc/:name/comments）。 */
export const fetchDocComments = (name: string, options: DocQueryOptions = {}): Promise<ChannelResponse<"op:doc:comments">> =>
  invokeOrThrow("op:doc:comments", { params: { name }, query: docQuery(options) });

/** 标题大纲（GET /api/doc/:name/outline）。 */
export const fetchDocOutline = (name: string, options: DocQueryOptions = {}): Promise<ChannelResponse<"op:doc:outline">> =>
  invokeOrThrow("op:doc:outline", { params: { name }, query: docQuery(options) });

/** HTML 标注读取（GET /api/doc/:name/annotations）。 */
export const fetchDocAnnotations = (name: string, options: DocQueryOptions = {}): Promise<ChannelResponse<"op:doc:annotations">> =>
  invokeOrThrow("op:doc:annotations", { params: { name }, query: docQuery(options) });

// ---- F4-4 写路由封装 ----

/** 划词标注保存（POST /api/doc/:name/annotations；server L537-549）。 */
export const saveDocAnnotations = (name: string, annotations: unknown[], options: DocQueryOptions = {}): Promise<ChannelResponse<"op:doc:annotations-save">> =>
  invokeOrThrow("op:doc:annotations-save", { params: { name }, query: docQuery(options), body: { annotations } });

/** docx 重打包保存（POST /api/doc/:name/raw-save；server L1334-1352）。 */
export const saveDocRaw = (name: string, base64: string, options: DocQueryOptions = {}): Promise<ChannelResponse<"op:doc:raw-save">> =>
  invokeOrThrow("op:doc:raw-save", { params: { name }, query: docQuery(options), body: { base64 } });

/** Excel 单元格保存（POST /api/doc/:name/cells；server L1242-1262，无显式 cwd）。 */
export const saveDocCells = (name: string, sheet: string, cells: Array<{ ref: string; value: unknown }>): Promise<ChannelResponse<"op:doc:cells">> =>
  invokeOrThrow("op:doc:cells", { params: { name }, body: { sheet, cells } });

/** docx 富文本编辑代理（POST /api/doc/edit；server L1303-1331，无显式 cwd）。 */
export const docEdit = (file: string, commands: Array<Record<string, unknown>>): Promise<ChannelResponse<"op:doc:edit">> =>
  invokeOrThrow("op:doc:edit", { body: { file, commands } });

/** officecli 通用直通（POST /api/office；server L1265-1298）。 */
export const runOffice = (args: unknown[]): Promise<ChannelResponse<"op:office:run">> =>
  invokeOrThrow("op:office:run", { body: { args } });

/** 开启实时预览（GET /api/doc/:name/watch；IPC 形态为 fs.watchFile + op:doc-watch 事件）。 */
export const fetchDocWatch = (name: string, options: DocQueryOptions = {}): Promise<ChannelResponse<"op:doc:watch">> =>
  invokeOrThrow("op:doc:watch", { params: { name }, query: docQuery(options) });

/** 停止实时预览（POST /api/doc/:name/watch/stop）。 */
export const stopDocWatch = (name: string, options: DocQueryOptions = {}): Promise<ChannelResponse<"op:doc:watch-stop">> =>
  invokeOrThrow("op:doc:watch-stop", { params: { name }, query: docQuery(options) });

// ============================================================================
// 本地工具（无 HTTP）
// ============================================================================

export function getClientId(): string {
  let id = localStorage.getItem("oaw_client_id");
  if (!id) {
    id = "client-" + Math.random().toString(36).slice(2, 10);
    localStorage.setItem("oaw_client_id", id);
  }
  return id;
}

export function fileToBase64(file: File): Promise<{ mediaType: string; data: string }> {
  // 大图先压缩，避免把高分辨率截图以超大 Base64 发送给视觉模型。
  if (file?.type?.startsWith("image/") && file.size > 2 * 1024 * 1024 && typeof Image !== "undefined") {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      const cleanup = () => URL.revokeObjectURL(url);
      img.onload = () => {
        try {
          const maxSide = 1800;
          const scale = Math.min(1, maxSide / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round((img.naturalWidth || img.width) * scale));
          canvas.height = Math.max(1, Math.round((img.naturalHeight || img.height) * scale));
          const context = canvas.getContext("2d");
          if (!context) throw new Error("图片压缩失败");
          context.drawImage(img, 0, 0, canvas.width, canvas.height);
          canvas.toBlob((blob) => {
            if (!blob) { cleanup(); reject(new Error("图片压缩失败")); return; }
            const reader = new FileReader();
            reader.onload = () => {
              cleanup();
              const dataUrl = String(reader.result);
              const [head, b64] = dataUrl.split(",");
              resolve({ mediaType: head?.match(/data:(.*?);/)?.[1] || "image/jpeg", data: b64 ?? "" });
            };
            reader.onerror = (e) => { cleanup(); reject(e); };
            reader.readAsDataURL(blob);
          }, "image/jpeg", 0.82);
        } catch (e) { cleanup(); reject(e); }
      };
      img.onerror = (e) => { cleanup(); reject(e); };
      img.src = url;
    });
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const [head, b64] = dataUrl.split(",");
      const mediaType = head?.match(/data:(.*?);/)?.[1] || "application/octet-stream";
      resolve({ mediaType, data: b64 ?? "" });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
