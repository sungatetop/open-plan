/**
 * 桌面 IPC 请求/响应通道注册表：invoke 通道族的单一事实来源。
 *
 * 与 event-registry.ts 的分工：
 *   - event-registry：事件推送（emitChannel → op:event）的事件类型清单；
 *   - channels.ts：请求/响应通道（op:invoke）的通道清单与请求/响应类型。
 *
 * 迁移期对应关系（BRD-009 绞杀者模式）：每个通道映射 legacy server 的一条 HTTP 路由，
 * main 侧转发器（src/main/ipc/http-forward.ts）把 IPC 调用翻译成对内嵌服务的 HTTP 请求；
 * B6 收口后转发器退役，通道直接调主进程域服务，本文件的通道名与类型保持不变。
 *
 * 对账：tests/channels-manifest.test.ts 校验通道清单与 server/index.mjs 路由面
 * （无幽灵通道、chat 域无缺漏、SSE 替代关系显式声明）。
 *
 * 请求载荷约定（转发器按此组装 HTTP）：
 *   - params：路径参数，填充 path 中的 `:param` 段（encodeURIComponent）；
 *   - query：查询串（undefined/null/空串跳过）；
 *   - body：JSON 请求体（GET 不发送）。
 */

export type HttpMethod = "GET" | "POST" | "DELETE" | "PATCH";

/** 通道请求载荷信封：所有通道 request 类型的公共结构（编译期由 satisfies 链保证兼容）。 */
export interface InvokeEnvelope {
  params?: Record<string, string>;
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
}

/** invoke 结果信封：保留 HTTP 语义，非 2xx 不抛异常，由调用方按 ok 收窄处理。 */
export type InvokeResult<T> =
  | { readonly ok: true; readonly status: number; readonly data: T }
  | { readonly ok: false; readonly status: number; readonly data: ChannelFailureData };

export interface ChannelFailureData {
  error?: string;
  code?: string;
  [key: string]: unknown;
}

/**
 * 通道清单：通道名 → HTTP 路由模板。
 * 通道名以 `op:` 前缀标记桌面桥通道（与 op:server-status / op:event 一致）。
 */
export const DESKTOP_CHANNELS = {
  // ---- 状态族 ----
  "op:status:get": { method: "GET", path: "/api/status" },

  // ---- 会话（线程）族 ----
  "op:sessions:list": { method: "GET", path: "/api/sessions" },
  "op:sessions:create": { method: "POST", path: "/api/sessions" },
  "op:sessions:get": { method: "GET", path: "/api/sessions/:id" },
  "op:sessions:delete": { method: "DELETE", path: "/api/sessions/:id" },
  "op:sessions:batch-delete": { method: "POST", path: "/api/sessions/batch-delete" },
  "op:sessions:rename": { method: "POST", path: "/api/sessions/:id/rename" },
  "op:sessions:pin": { method: "POST", path: "/api/sessions/:id/pin" },
  "op:sessions:freeze": { method: "POST", path: "/api/sessions/:id/freeze" },
  "op:sessions:fork": { method: "POST", path: "/api/sessions/:id/fork" },

  // ---- 运行（Run）族 ----
  "op:runs:list": { method: "GET", path: "/api/runs" },
  "op:runs:get": { method: "GET", path: "/api/runs/:id" },
  "op:runs:cancel": { method: "POST", path: "/api/runs/:id/cancel" },
  "op:runs:rollback": { method: "POST", path: "/api/runs/:id/rollback" },
  "op:runs:step": { method: "POST", path: "/api/runs/:id/steps/:stepId" },
  "op:runs:resume": { method: "POST", path: "/api/runs/:id/resume" },
  "op:runs:retry": { method: "POST", path: "/api/runs/:id/retry" },
  "op:runs:artifacts:publish": { method: "POST", path: "/api/runs/:id/artifacts/:artifactId/publish" },
  "op:runs:artifacts:accept": { method: "POST", path: "/api/runs/:id/artifacts/:artifactId/accept" },
  "op:runs:acceptance": { method: "GET", path: "/api/runs/:id/acceptance" },
  "op:runs:diff": { method: "GET", path: "/api/runs/:id/changes/:changeId/diff" },
  "op:artifacts:list": { method: "GET", path: "/api/artifacts" },
  "op:artifacts:rollback": { method: "POST", path: "/api/artifacts/:publicationId/rollback" },

  // ---- Agent 交互族（对话链路核心） ----
  "op:agent:prompt": { method: "POST", path: "/api/agent/prompt" },
  "op:agent:abort": { method: "POST", path: "/api/agent/abort" },
  "op:agent:model:set": { method: "POST", path: "/api/agent/model" },
  "op:agent:runtime": { method: "GET", path: "/api/agent/runtime" },
  "op:agent:compact": { method: "POST", path: "/api/agent/compact" },
  "op:agent:new": { method: "POST", path: "/api/agent/new" },
  "op:agent:resume": { method: "POST", path: "/api/agent/resume" },
  "op:agent:pending": { method: "GET", path: "/api/agent/pending" },
  "op:agent:answer": { method: "POST", path: "/api/agent/answer" },
  "op:agent:approvals": { method: "GET", path: "/api/agent/approvals" },
  "op:agent:approval": { method: "POST", path: "/api/agent/approval" },
  "op:agent:approval-mode:get": { method: "GET", path: "/api/agent/approval-mode" },
  "op:agent:approval-mode:set": { method: "PATCH", path: "/api/agent/approval-mode" },
  "op:agent:stream-close": { method: "POST", path: "/api/agent/stream/close" },
  "op:agent:session-tree": { method: "GET", path: "/api/agent/session-tree" },
  "op:agent:session-branch": { method: "POST", path: "/api/agent/session-branch" },

  // ---- 事件游标管理（事件桥配套；SSE 本体由 op:event 推送替代） ----
  "op:agent:events-state": { method: "GET", path: "/api/agent/events/state" },
  "op:agent:events-read": { method: "POST", path: "/api/agent/events/read" },

  // ---- 记忆域（F3 批4：MemoryTab；file:get/save 对应 server 正则路由 /^\/api\/memory\/([^/]+)$/） ----
  "op:memory:list": { method: "GET", path: "/api/memory" },
  "op:memory:init": { method: "POST", path: "/api/memory/init" },
  "op:memory:file:get": { method: "GET", path: "/api/memory/:rel" },
  "op:memory:file:save": { method: "POST", path: "/api/memory/:rel" },
  "op:memory:proposals:list": { method: "GET", path: "/api/memory/proposals" },
  "op:memory:proposals:approve": { method: "POST", path: "/api/memory/proposals/:id/approve" },
  "op:memory:proposals:edit": { method: "PATCH", path: "/api/memory/proposals/:id" },
  "op:memory:proposals:reject": { method: "POST", path: "/api/memory/proposals/:id/reject" },
  "op:memory:proposals:history": { method: "GET", path: "/api/memory/proposals/:id/history" },
  "op:memory:proposals:merge": { method: "POST", path: "/api/memory/proposals/:id/merge" },

  // ---- 文件族（F3 批5b-2：SessionSidebar 文件树/上传/搜索） ----
  "op:files:search": { method: "GET", path: "/api/files/search" },
  "op:files:upload": { method: "POST", path: "/api/files/upload" },
  "op:files:delete": { method: "POST", path: "/api/files/delete" },

  // ---- 知识库族（F3 批5b-5：SessionSidebar docx 存入知识库；域内其余路由仍走前缀豁免） ----
  "op:kb:ingest": { method: "POST", path: "/api/kb/ingest" },

  // ---- 模型族（10s 单飞缓存在 renderer API 层，通道只承载传输） ----
  "op:models:list": { method: "GET", path: "/api/models" },
  "op:models:refresh": { method: "POST", path: "/api/models/refresh" },

  // ---- Agent 配置族（SettingsPanel：鉴权/导入/网络/模型配置/目录/探测/权限） ----
  "op:agent:auth:get": { method: "GET", path: "/api/agent/auth" },
  "op:agent:auth:save": { method: "POST", path: "/api/agent/auth" },
  "op:agent:auth:remove": { method: "POST", path: "/api/agent/auth/remove" },
  "op:agent:custom-provider": { method: "POST", path: "/api/agent/custom-provider" },
  "op:agent:config-status": { method: "GET", path: "/api/agent/config-status" },
  "op:agent:import-preview": { method: "GET", path: "/api/agent/import-preview" },
  "op:agent:import-config": { method: "POST", path: "/api/agent/import-config" },
  "op:agent:plans": { method: "GET", path: "/api/agent/plans" },
  "op:agent:plans:models": { method: "GET", path: "/api/agent/plans/models" },
  "op:agent:plans:apply": { method: "POST", path: "/api/agent/plans/apply" },
  "op:agent:plans:disconnect": { method: "POST", path: "/api/agent/plans/disconnect" },
  "op:agent:diagnostics": { method: "GET", path: "/api/agent/diagnostics" },
  "op:agent:network-settings:get": { method: "GET", path: "/api/agent/network-settings" },
  "op:agent:network-settings:save": { method: "PATCH", path: "/api/agent/network-settings" },
  "op:agent:model-configs:list": { method: "GET", path: "/api/agent/model-configs" },
  "op:agent:model-configs:save": { method: "POST", path: "/api/agent/model-configs" },
  "op:agent:model-configs:delete": { method: "DELETE", path: "/api/agent/model-configs/:provider" },
  "op:agent:model-configs:fetch-models": { method: "POST", path: "/api/agent/model-configs/fetch-models" },
  "op:agent:provider-catalog": { method: "GET", path: "/api/agent/provider-catalog" },
  "op:agent:provider-catalog:detail": { method: "GET", path: "/api/agent/provider-catalog/:id" },
  "op:agent:provider-catalog:import": { method: "POST", path: "/api/agent/provider-catalog/import" },
  "op:agent:provider-catalog:refresh": { method: "POST", path: "/api/agent/provider-catalog/refresh" },
  "op:agent:default-model:set": { method: "POST", path: "/api/agent/default-model" },
  "op:agent:model:probe": { method: "POST", path: "/api/agent/model/probe" },
  "op:agent:permissions:get": { method: "GET", path: "/api/agent/permissions" },
  "op:agent:permissions:rule:remove": { method: "DELETE", path: "/api/agent/permissions/rule" },

  // ---- 联网搜索配置族（SettingsPanel 搜索分节） ----
  "op:search:settings:get": { method: "GET", path: "/api/search/settings" },
  "op:search:settings:save": { method: "POST", path: "/api/search/settings" },
  "op:search:test": { method: "POST", path: "/api/search/test" },

  // ---- 地图设置族（SettingsPanel 地图分节） ----
  "op:map:settings:get": { method: "GET", path: "/api/map/settings" },
  "op:map:settings:save": { method: "POST", path: "/api/map/settings" },

  // ---- 项目族（SettingsPanel 项目管理分节） ----
  "op:projects:create": { method: "POST", path: "/api/projects" },
  "op:projects:classify": { method: "POST", path: "/api/projects/classify" },
  "op:projects:update": { method: "PATCH", path: "/api/projects/:id" },
  "op:projects:pin": { method: "POST", path: "/api/projects/:id/pin" },
  "op:projects:archive": { method: "POST", path: "/api/projects/:id/archive" },
  "op:projects:settings:update": { method: "PATCH", path: "/api/projects/:id/settings" },

  // ---- 工作区族（SessionSidebar 工作区切换/验证/系统选择器） ----
  "op:workspace:validate": { method: "POST", path: "/api/workspace/validate" },
  "op:workspace:pick": { method: "POST", path: "/api/workspace/pick" },
  "op:workspace:pick:cancel": { method: "POST", path: "/api/workspace/pick/cancel" },

  // ---- 外部目录（文件根）族 ----
  "op:file-roots:list": { method: "GET", path: "/api/file-roots" },
  "op:file-roots:add": { method: "POST", path: "/api/file-roots" },
  "op:file-roots:remove": { method: "DELETE", path: "/api/file-roots/:id" },

  // ---- 系统集成族（原生文件选择/系统打开/文件管理器显示） ----
  "op:system:pick-files": { method: "POST", path: "/api/system/pick-files" },
  "op:system:open": { method: "POST", path: "/api/system/open" },
  "op:system:reveal": { method: "POST", path: "/api/system/reveal" }
} as const satisfies Record<string, { method: HttpMethod; path: string }>;

export type DesktopChannelId = keyof typeof DESKTOP_CHANNELS;

/** SSE 长连接路由 → op:event 推送的替代关系（对账测试断言其存在于 server 路由面）。 */
export const SSE_REPLACED_ROUTES = ["GET /api/agent/stream", "GET /api/agent/events", "GET /api/memory/stream"] as const;

// ============================================================================
// 领域载荷类型：对齐 server/index.mjs 各路由的实际请求/响应结构。
// 视图类型只声明调用方消费的字段；响应里的未知扩展字段不进类型（F3 消费时按需收紧）。
// ============================================================================

// ---- 状态族 ----

export type StatusGetRequest = { query?: { token?: string } };

export interface ServiceStatusInfo {
  pid: number;
  startedAt: string;
  uptimeSec: number;
  identity: string;
  sandboxIdentity: boolean;
}

export interface StatusInfo {
  ok: true;
  officecli: string;
  version: string;
  piPackageVersion: string;
  host: string;
  authRequired: boolean;
  platform: string;
  native: Record<string, unknown>;
  runtimeFlags: Record<string, unknown>;
  picker: Record<string, unknown> | null;
  service: ServiceStatusInfo;
}

// ---- 会话族 ----

export type SessionListRequest = {
  query?: {
    file?: string;
    projectId?: string;
    mode?: string;
    runStatus?: string;
    pinned?: "true" | "false";
    frozen?: "true" | "false";
  };
};

export interface SessionListItem {
  id: string;
  threadId: string;
  projectId: string | null;
  projectName: string;
  projectType: string;
  projectStatus: string;
  cwd: string;
  created: string;
  modified: number;
  label: string;
  pinned: boolean;
  frozen: boolean;
  freezeReason: string;
  contextSnapshot: Record<string, unknown> | null;
  parentSessionId: string | null;
  branchSourceMessageId: string | null;
  branchPurpose: string;
  fileName: string;
  title: string;
  runStatus: RunStatus | (string & {});
  runId: string | null;
  mode: string;
  lastRunAt: string | null;
  artifactCount: number;
}

export interface SessionListResponse {
  sessions: SessionListItem[];
}

export type SessionCreateRequest = {
  body?: { cwd?: string; projectId?: string | null; label?: string; frozen?: boolean };
};

export interface SessionCreateResponse {
  id: string;
  fileName: string;
  cwd: string;
  projectId: string | null;
  created: string;
  status: string;
  pinned: boolean;
  frozen: boolean;
}

export type SessionGetRequest = {
  params: { id: string };
  query?: { view?: "chat"; limit?: number; before?: number };
};

export interface SessionEntry {
  id: string;
  parentId?: string | null;
  type?: string;
  [key: string]: unknown;
}

export interface SessionInfo {
  id: string;
  cwd: string;
  projectId: string | null;
  created: string;
  label: string;
  pinned: boolean;
  frozen: boolean;
  freezeReason: string;
  contextSnapshot: Record<string, unknown> | null;
  parentSessionId: string | null;
  branchSourceMessageId: string | null;
  branchPurpose: string;
  fileName: string;
  modified: number;
  chatView: boolean;
  historyTotal?: number;
  historyStart?: number;
  historyEnd?: number;
  historyHasMore: boolean;
}

export interface SessionGetResponse {
  entries: SessionEntry[];
  tree: Record<string, string[]>;
  leafId: string | null;
  info: SessionInfo;
}

export type SessionDeleteRequest = { params: { id: string } };
export interface SessionDeleteResponse { ok: true }

export type SessionBatchDeleteRequest = { body: { ids: string[] } };

export interface SessionBatchDeleteResponse {
  ok: true;
  deleted: string[];
  skipped: { id: string; reason: string }[];
  missing: string[];
}

export type SessionRenameRequest = { params: { id: string }; body?: { label?: string } };
export interface SessionRenameResponse { ok: true; label: string }

export type SessionPinRequest = { params: { id: string }; body?: { pinned?: boolean } };
export interface SessionPinResponse { ok: true; sessionId: string; pinned: boolean }

export type SessionFreezeRequest = {
  params: { id: string };
  body?: { frozen?: boolean; reason?: string; snapshot?: Record<string, unknown> };
};

export interface SessionFreezeResponse {
  ok: true;
  sessionId: string;
  frozen: boolean;
  freezeReason: string;
  contextSnapshot: Record<string, unknown> | null;
}

export type SessionForkRequest = {
  params: { id: string };
  body?: { label?: string; sourceMessageId?: string; purpose?: string };
};

export interface SessionForkResponse {
  ok: true;
  id: string;
  fileName: string;
  parentSessionId: string;
  cwd: string;
  threadId: string;
  label: string;
  projectId: string | null;
}

// ---- 运行（Run）族 ----

/** Run 生命周期状态（listRuns/会话徽标所见；容忍服务端扩展值）。 */
export type RunStatus =
  | "idle"
  | "queued"
  | "running"
  | "waiting_user"
  | "recovering"
  | "cancel_requested"
  | "cancelled"
  | "aborted"
  | "failed"
  | "completed";

export interface RunActions {
  canCancel?: boolean;
  canResume?: boolean;
  canRetry?: boolean;
  [key: string]: unknown;
}

/** 验收详情：服务端在 artifact.acceptance / run.acceptance 上都会返回（人工确认/可固定状态）。 */
export interface RunAcceptanceInfo {
  readyToPublish?: boolean;
  status?: string;
  summary?: string;
  checks?: Record<string, { status?: string }>;
  artifacts?: Array<{ path?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface RunArtifact {
  changeId?: string;
  artifactId?: string;
  relativePath?: string;
  path?: string;
  cwd?: string;
  blobs?: { before?: string | boolean | null; after?: string | boolean | null };
  acceptance?: RunAcceptanceInfo;
  acceptanceStatus?: string | null;
  verificationStatus?: string | null;
  [key: string]: unknown;
}

export interface RunEventEntry {
  seq?: number;
  type?: string;
  data?: unknown;
  at?: string;
  [key: string]: unknown;
}

/** Run 记录视图：id 必有，其余字段随记录版本可选（IO 边界数据，调用方做空值兜底）。 */
export interface RunRecord {
  id: string;
  status?: RunStatus | (string & {});
  threadId?: string | null;
  sessionId?: string | null;
  clientId?: string;
  cwd?: string;
  projectId?: string | null;
  mode?: string;
  createdAt?: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  artifactCount?: number;
  error?: string | null;
  summary?: string;
  model?: string | null;
  finalText?: string;
  acceptance?: RunAcceptanceInfo;
  verificationStatus?: string;
  completion?: Record<string, unknown> | null;
  actions?: RunActions;
  steps?: RunEventEntry[];
  events?: RunEventEntry[];
  artifacts?: RunArtifact[];
  task?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export type RunListRequest = {
  query?: {
    thread?: string;
    session?: string;
    cwd?: string;
    projectId?: string;
    status?: string;
    mode?: string;
    query?: string;
    limit?: number;
    fields?: "summary";
    includeEvents?: "all" | "none" | "latest";
  };
};

export interface RunListResponse { runs: RunRecord[] }

export type RunGetRequest = { params: { id: string } };
export interface RunGetResponse { run: RunRecord }

export type RunCancelRequest = { params: { id: string }; body?: { reason?: string } };
export interface RunCancelResponse {
  ok: true;
  run: RunRecord;
  previous: unknown;
  stillQueued: number;
}

export type RunRollbackRequest = { params: { id: string }; body: { confirm: true; paths?: string[] } };
export interface RunRollbackResult { ok: boolean; [key: string]: unknown }

export type RunStepRequest = {
  params: { id: string; stepId: string };
  body?: Record<string, unknown>;
};
export interface RunStepResponse { ok: true; run: RunRecord }

export type RunResumeRetryRequest = { params: { id: string }; body?: Record<string, unknown> };
export interface RunContinuationResponse { ok: true; run: RunRecord; sourceRunId: string }

export type RunArtifactPublishRequest = {
  params: { id: string; artifactId: string };
  body?: { rules?: Record<string, unknown>; operator?: string };
};

export type RunArtifactAcceptRequest = {
  params: { id: string; artifactId: string };
  body?: { note?: string; operator?: string; rules?: Record<string, unknown> };
};

export interface ArtifactOpResult { ok: boolean; [key: string]: unknown }

export type RunAcceptanceRequest = { params: { id: string }; query?: { rules?: string } };

export type RunDiffRequest = {
  params: { id: string; changeId: string };
  query?: { page?: number };
};

export interface RunDiffResponse {
  ok: true;
  change: {
    changeId: string | null;
    relativePath: string;
    changeType: string | null;
    confidence: unknown;
    source: string | null;
    blobs: Record<string, unknown>;
    acceptanceStatus: string | null;
    verificationStatus: string | null;
  };
  diff: Record<string, unknown>;
  limits: {
    maxInputBytes: number;
    maxHunksPerPage: number;
    inputTruncated: boolean;
  };
}

export type ArtifactListRequest = {
  query?: { cwd?: string; projectId?: string; limit?: number };
};
export interface ArtifactListResponse { artifacts: RunArtifact[] }

export type ArtifactRollbackRequest = {
  params: { publicationId: string };
  body: { confirm: true; operator?: string };
};

// ---- Agent 交互族 ----

export interface PromptImage { data?: string; mimeType?: string; [key: string]: unknown }

export interface PromptAttachment { name?: string; data?: string; mimeType?: string; [key: string]: unknown }

export interface PromptTaskInput {
  mode?: string;
  workflowId?: string | null;
  workspace?: string;
  cwd?: string;
  projectId?: string | null;
  skills?: string[];
  goal?: string;
  [key: string]: unknown;
}

export type AgentPromptRequest = {
  body: {
    client: string;
    thread?: string;
    text?: string;
    images?: PromptImage[];
    attachments?: PromptAttachment[];
    references?: unknown[];
    effort?: string;
    model?: string;
    task?: PromptTaskInput;
    latency?: Record<string, unknown>;
  };
};

/** prompt 的 admission 响应：HTTP 只负责"已接收"，后续状态全走 op:event 事件流。 */
export interface PromptAdmissionResponse {
  ok: true;
  accepted: true;
  queued: boolean;
  queuePosition: number;
  changed: string[];
  runId: string | null;
  artifacts: unknown[];
  validations: unknown[];
  verificationStatus: string;
  status: string;
  task: Record<string, unknown> | null;
  sessionId: string | null;
  model: string | null;
  modelFallbackFrom: string | null;
  thread: string | null;
}

export type AgentAbortRequest = { body: { client: string; thread?: string } };
export interface AgentAbortResponse {
  ok?: boolean;
  runId: string | null;
  stillQueued: number;
  [key: string]: unknown;
}

/** POST /api/agent/model：切换模型；运行中受理时 pending=true（排队到本轮结束）。 */
export type AgentModelSetRequest = {
  body: { client: string; thread?: string; model: string };
};
export interface AgentModelSetResponse {
  ok?: boolean;
  pending?: boolean;
  model?: string;
  current?: string;
  [key: string]: unknown;
}

/** GET /api/agent/runtime：Pi 运行时上下文用量快照（恢复/切换会话后回填）。 */
export type AgentRuntimeRequest = { query: { client: string; thread?: string } };
export interface AgentRuntimeResponse {
  usage?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export type AgentCompactRequest = {
  body: { client: string; thread?: string; instructions?: string };
};
export interface AgentCompactResponse { ok?: boolean; [key: string]: unknown }

export type AgentNewRequest = {
  body: { client: string; thread: string; cwd?: string; projectId?: string | null; label?: string };
};
export interface AgentThreadResponse { sessionId: string; [key: string]: unknown }

export type AgentResumeRequest = {
  body: { client: string; thread: string; sessionId: string; cwd?: string };
};

export type AgentPendingRequest = { query: { client: string; thread?: string } };
export interface AgentPendingResponse {
  questions: Record<string, unknown>[];
  pendingMessages: number | null;
}

export type AgentAnswerRequest = {
  body: { client: string; thread?: string; answer: string };
};
export interface AgentAnswerResponse { ok: boolean; [key: string]: unknown }

export interface ApprovalItem {
  id: string;
  tool: string;
  input: string;
  runId: string | null;
  threadId: string | null;
  clientId: string | null;
  status: string;
  createdAt: string;
}

export interface AgentApprovalsResponse { approvals: ApprovalItem[] }

export type AgentApprovalRequest = {
  body: { id: string; decision: "allow" | "always" | "deny" };
};

export type AgentApprovalResponse =
  | { ok: true; id: string; decision: "allow" | "deny"; always?: boolean; recovered?: boolean }
  | { ok: false; error: string };

export type AgentApprovalModeGetResponse = { mode: "ask" | "auto" };

export type AgentApprovalModeSetRequest = { body: { mode: "ask" | "auto" } };
export interface AgentApprovalModeSetResponse { ok?: boolean; [key: string]: unknown }

export type AgentStreamCloseRequest = { body: { client: string; thread?: string } };
export interface AgentStreamCloseResponse { closed: number }

export type AgentSessionTreeRequest = { query: { client: string; thread?: string } };
export interface AgentSessionTreeResponse { ok?: boolean; [key: string]: unknown }

export type AgentSessionBranchRequest = {
  body: {
    client: string;
    thread?: string;
    entryId: string;
    summarize?: boolean;
    label?: string;
  };
};
export interface AgentSessionBranchResponse { ok?: boolean; [key: string]: unknown }

export type AgentEventsStateRequest = { query: { client: string } };
export interface AgentEventsStateResponse { readCursor: number; [key: string]: unknown }

export type AgentEventsReadRequest = { body: { client: string; seq: number } };
export interface AgentEventsReadResponse { ok?: boolean; [key: string]: unknown }

// ---- 记忆域（F3 批4：MemoryTab） ----

export interface MemoryFileInfo {
  rel: string;
  type?: string;
  size?: number;
  [key: string]: unknown;
}

export type MemoryListResponse = { files: MemoryFileInfo[]; memoryDir?: string };

export type MemoryFileGetResponse = { content: string; path: string };

export type MemoryFileSaveRequest = { params: { rel: string }; body?: { content?: string } };

export type MemoryInitResponse = { ok: true; files: MemoryFileInfo[] };

export interface MemoryProposal {
  id: string;
  status?: string;
  category?: string;
  section?: string;
  content?: string;
  source?: { label?: string; [key: string]: unknown } | null;
  runId?: string | null;
  version?: number;
  [key: string]: unknown;
}

export type MemoryProposalListRequest = {
  query?: { workspace?: string; status?: string; projectId?: string; category?: string; client?: string; thread?: string };
};
export type MemoryProposalListResponse = { proposals: MemoryProposal[] };

export type MemoryProposalApproveRequest = {
  params: { id: string };
  body?: { content?: string; category?: string; section?: string; reviewer?: string };
};
export type MemoryProposalEditRequest = {
  params: { id: string };
  body?: { content?: string; category?: string; section?: string };
};
export type MemoryProposalRejectRequest = { params: { id: string }; body?: { reason?: string } };
export type MemoryProposalHistoryRequest = { params: { id: string } };
export type MemoryProposalMergeRequest = { params: { id: string }; body?: { sourceIds?: string[] } };

/** 审批类操作结果（sendMemoryResult 直传 agentManager 结果，失败时调用方走 ApiError）。 */
export type MemoryProposalOpResult = { ok: boolean; [key: string]: unknown };

export interface MemoryProposalHistoryItem {
  version?: number;
  action?: string;
  at?: string;
  [key: string]: unknown;
}

export type MemoryProposalHistoryResponse = {
  ok?: boolean;
  id?: string;
  history?: MemoryProposalHistoryItem[];
  [key: string]: unknown;
};

// ---- 文件族（F3 批5b-2） ----

export type FileSearchRequest = { query: { q: string; limit: number; workspace?: string } };
export type FileSearchResponse = {
  workspace?: string;
  files?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};
export type FileUploadRequest = { body: { name: string; base64: string; workspace?: string } };
export type FileDeleteRequest = { body: { name: string; workspace?: string } };

// ---- 知识库族 ----

export type KbIngestRequest = { body: { name: string } };
export type KbIngestResponse = { ok?: boolean; mdName?: string; error?: string; [key: string]: unknown };

// ---- 模型族 ----

export type ModelsListRequest = Record<string, never>;
export type ModelsListResponse = { models?: Array<Record<string, unknown>>; [key: string]: unknown };

// ---- Agent 配置族（SettingsPanel；响应宽类型，F3 消费时按需收紧） ----

export type AgentAuthSaveRequest = { body: { provider: string; key: string } };
export type AgentAuthRemoveRequest = { body: { provider: string } };
export type AgentPlansModelsRequest = { query: { planId: string } };
export type AgentPlansApplyRequest = { body?: Record<string, unknown> };
export type AgentPlansDisconnectRequest = { body: { planId: string } };
export type AgentCustomProviderRequest = { body?: Record<string, unknown> };
export type AgentImportConfigRequest = { body?: Record<string, unknown> };
export type AgentDiagnosticsRequest = { query?: { client?: string; thread?: string; runId?: string } };
export type AgentNetworkSettingsSaveRequest = { body?: Record<string, unknown> };
export type AgentModelConfigSaveRequest = { body?: Record<string, unknown> };
export type AgentModelConfigDeleteRequest = { params: { provider: string } };
export type AgentModelConfigFetchModelsRequest = { body?: Record<string, unknown> };
export type AgentDefaultModelSetRequest = { body: { provider: string; model: string } };
export type AgentModelProbeRequest = { body: { model: unknown; timeoutMs: number } };
export type AgentPermissionRuleRemoveRequest = { body: Record<string, unknown> };
export type AgentProviderCatalogDetailRequest = { params: { id: string } };
export type AgentProviderCatalogImportRequest = { body?: Record<string, unknown> };

// ---- 联网搜索配置族 ----

export type SearchSettingsSaveRequest = { body?: Record<string, unknown> };
export type SearchSettingsTestRequest = { body: { backend: string; draft?: unknown } };

// ---- 地图设置族 ----

export type MapSettingsSaveRequest = { body: { basemaps: unknown } };

// ---- 项目族 ----

export type ProjectCreateRequest = { body?: Record<string, unknown> };
export type ProjectClassifyRequest = { body: { apply: boolean } };
export type ProjectUpdateRequest = { params: { id: string }; body?: Record<string, unknown> };
export type ProjectPinRequest = { params: { id: string }; body: { pinned: boolean } };
export type ProjectArchiveRequest = { params: { id: string }; body: { archived: boolean } };
export type ProjectSettingsUpdateRequest = { params: { id: string }; body?: Record<string, unknown> };

// ---- 工作区族 ----

export type WorkspaceValidateRequest = { body: { path: string } };
export type WorkspacePickRequest = { body: Record<string, never> };
export type WorkspacePickCancelRequest = { body: Record<string, never> };

// ---- 外部目录（文件根）族 ----

export type FileRootsAddRequest = { body: { path: string; label?: string } };
export type FileRootsRemoveRequest = { params: { id: string } };
export type FileRootsResponse = { roots?: Array<Record<string, unknown>>; [key: string]: unknown };

// ---- 系统集成族 ----

export type SystemPickFilesRequest = { body?: Record<string, unknown> };
export type SystemOpenRequest = { body: { path: string } };
export type SystemRevealRequest = { body: { path: string } };

// ============================================================================
// 通道协议映射：通道名 → 请求/响应类型（renderer 与 main 共用）。
// ============================================================================

export interface DesktopChannelProtocol {
  "op:status:get": { request: StatusGetRequest; response: StatusInfo };

  "op:sessions:list": { request: SessionListRequest; response: SessionListResponse };
  "op:sessions:create": { request: SessionCreateRequest; response: SessionCreateResponse };
  "op:sessions:get": { request: SessionGetRequest; response: SessionGetResponse };
  "op:sessions:delete": { request: SessionDeleteRequest; response: SessionDeleteResponse };
  "op:sessions:batch-delete": { request: SessionBatchDeleteRequest; response: SessionBatchDeleteResponse };
  "op:sessions:rename": { request: SessionRenameRequest; response: SessionRenameResponse };
  "op:sessions:pin": { request: SessionPinRequest; response: SessionPinResponse };
  "op:sessions:freeze": { request: SessionFreezeRequest; response: SessionFreezeResponse };
  "op:sessions:fork": { request: SessionForkRequest; response: SessionForkResponse };

  "op:runs:list": { request: RunListRequest; response: RunListResponse };
  "op:runs:get": { request: RunGetRequest; response: RunGetResponse };
  "op:runs:cancel": { request: RunCancelRequest; response: RunCancelResponse };
  "op:runs:rollback": { request: RunRollbackRequest; response: RunRollbackResult };
  "op:runs:step": { request: RunStepRequest; response: RunStepResponse };
  "op:runs:resume": { request: RunResumeRetryRequest; response: RunContinuationResponse };
  "op:runs:retry": { request: RunResumeRetryRequest; response: RunContinuationResponse };
  "op:runs:artifacts:publish": { request: RunArtifactPublishRequest; response: ArtifactOpResult };
  "op:runs:artifacts:accept": { request: RunArtifactAcceptRequest; response: ArtifactOpResult };
  "op:runs:acceptance": { request: RunAcceptanceRequest; response: ArtifactOpResult };
  "op:runs:diff": { request: RunDiffRequest; response: RunDiffResponse };
  "op:artifacts:list": { request: ArtifactListRequest; response: ArtifactListResponse };
  "op:artifacts:rollback": { request: ArtifactRollbackRequest; response: ArtifactOpResult };

  "op:agent:prompt": { request: AgentPromptRequest; response: PromptAdmissionResponse };
  "op:agent:abort": { request: AgentAbortRequest; response: AgentAbortResponse };
  "op:agent:model:set": { request: AgentModelSetRequest; response: AgentModelSetResponse };
  "op:agent:runtime": { request: AgentRuntimeRequest; response: AgentRuntimeResponse };
  "op:agent:compact": { request: AgentCompactRequest; response: AgentCompactResponse };
  "op:agent:new": { request: AgentNewRequest; response: AgentThreadResponse };
  "op:agent:resume": { request: AgentResumeRequest; response: AgentThreadResponse };
  "op:agent:pending": { request: AgentPendingRequest; response: AgentPendingResponse };
  "op:agent:answer": { request: AgentAnswerRequest; response: AgentAnswerResponse };
  "op:agent:approvals": { request: Record<string, never>; response: AgentApprovalsResponse };
  "op:agent:approval": { request: AgentApprovalRequest; response: AgentApprovalResponse };
  "op:agent:approval-mode:get": { request: Record<string, never>; response: AgentApprovalModeGetResponse };
  "op:agent:approval-mode:set": { request: AgentApprovalModeSetRequest; response: AgentApprovalModeSetResponse };
  "op:agent:stream-close": { request: AgentStreamCloseRequest; response: AgentStreamCloseResponse };
  "op:agent:session-tree": { request: AgentSessionTreeRequest; response: AgentSessionTreeResponse };
  "op:agent:session-branch": { request: AgentSessionBranchRequest; response: AgentSessionBranchResponse };

  "op:agent:events-state": { request: AgentEventsStateRequest; response: AgentEventsStateResponse };
  "op:agent:events-read": { request: AgentEventsReadRequest; response: AgentEventsReadResponse };

  "op:memory:list": { request: Record<string, never>; response: MemoryListResponse };
  "op:memory:init": { request: Record<string, never>; response: MemoryInitResponse };
  "op:memory:file:get": { request: { params: { rel: string } }; response: MemoryFileGetResponse };
  "op:memory:file:save": { request: MemoryFileSaveRequest; response: Record<string, unknown> };
  "op:memory:proposals:list": { request: MemoryProposalListRequest; response: MemoryProposalListResponse };
  "op:memory:proposals:approve": { request: MemoryProposalApproveRequest; response: MemoryProposalOpResult };
  "op:memory:proposals:edit": { request: MemoryProposalEditRequest; response: MemoryProposalOpResult };
  "op:memory:proposals:reject": { request: MemoryProposalRejectRequest; response: MemoryProposalOpResult };
  "op:memory:proposals:history": { request: MemoryProposalHistoryRequest; response: MemoryProposalHistoryResponse };
  "op:memory:proposals:merge": { request: MemoryProposalMergeRequest; response: MemoryProposalOpResult };

  "op:files:search": { request: FileSearchRequest; response: FileSearchResponse };
  "op:files:upload": { request: FileUploadRequest; response: Record<string, unknown> };
  "op:files:delete": { request: FileDeleteRequest; response: Record<string, unknown> };

  "op:kb:ingest": { request: KbIngestRequest; response: KbIngestResponse };

  "op:models:list": { request: ModelsListRequest; response: ModelsListResponse };
  "op:models:refresh": { request: Record<string, never>; response: Record<string, unknown> };

  "op:agent:auth:get": { request: Record<string, never>; response: Record<string, unknown> };
  "op:agent:auth:save": { request: AgentAuthSaveRequest; response: Record<string, unknown> };
  "op:agent:auth:remove": { request: AgentAuthRemoveRequest; response: Record<string, unknown> };
  "op:agent:plans": { request: Record<string, never>; response: Record<string, unknown> };
  "op:agent:plans:models": { request: AgentPlansModelsRequest; response: Record<string, unknown> };
  "op:agent:plans:apply": { request: AgentPlansApplyRequest; response: Record<string, unknown> };
  "op:agent:plans:disconnect": { request: AgentPlansDisconnectRequest; response: Record<string, unknown> };
  "op:agent:custom-provider": { request: AgentCustomProviderRequest; response: Record<string, unknown> };
  "op:agent:config-status": { request: Record<string, never>; response: Record<string, unknown> };
  "op:agent:import-preview": { request: Record<string, never>; response: Record<string, unknown> };
  "op:agent:import-config": { request: AgentImportConfigRequest; response: Record<string, unknown> };
  "op:agent:diagnostics": { request: AgentDiagnosticsRequest; response: Record<string, unknown> };
  "op:agent:network-settings:get": { request: Record<string, never>; response: Record<string, unknown> };
  "op:agent:network-settings:save": { request: AgentNetworkSettingsSaveRequest; response: Record<string, unknown> };
  "op:agent:model-configs:list": { request: Record<string, never>; response: Record<string, unknown> };
  "op:agent:model-configs:save": { request: AgentModelConfigSaveRequest; response: Record<string, unknown> };
  "op:agent:model-configs:delete": { request: AgentModelConfigDeleteRequest; response: Record<string, unknown> };
  "op:agent:model-configs:fetch-models": { request: AgentModelConfigFetchModelsRequest; response: Record<string, unknown> };
  "op:agent:provider-catalog": { request: Record<string, never>; response: Record<string, unknown> };
  "op:agent:provider-catalog:detail": { request: AgentProviderCatalogDetailRequest; response: Record<string, unknown> };
  "op:agent:provider-catalog:import": { request: AgentProviderCatalogImportRequest; response: Record<string, unknown> };
  "op:agent:provider-catalog:refresh": { request: Record<string, never>; response: Record<string, unknown> };
  "op:agent:default-model:set": { request: AgentDefaultModelSetRequest; response: Record<string, unknown> };
  "op:agent:model:probe": { request: AgentModelProbeRequest; response: Record<string, unknown> };
  "op:agent:permissions:get": { request: Record<string, never>; response: Record<string, unknown> };
  "op:agent:permissions:rule:remove": { request: AgentPermissionRuleRemoveRequest; response: Record<string, unknown> };

  "op:search:settings:get": { request: Record<string, never>; response: Record<string, unknown> };
  "op:search:settings:save": { request: SearchSettingsSaveRequest; response: Record<string, unknown> };
  "op:search:test": { request: SearchSettingsTestRequest; response: Record<string, unknown> };

  "op:map:settings:get": { request: Record<string, never>; response: Record<string, unknown> };
  "op:map:settings:save": { request: MapSettingsSaveRequest; response: Record<string, unknown> };

  "op:projects:create": { request: ProjectCreateRequest; response: Record<string, unknown> };
  "op:projects:classify": { request: ProjectClassifyRequest; response: Record<string, unknown> };
  "op:projects:update": { request: ProjectUpdateRequest; response: Record<string, unknown> };
  "op:projects:pin": { request: ProjectPinRequest; response: Record<string, unknown> };
  "op:projects:archive": { request: ProjectArchiveRequest; response: Record<string, unknown> };
  "op:projects:settings:update": { request: ProjectSettingsUpdateRequest; response: Record<string, unknown> };

  "op:workspace:validate": { request: WorkspaceValidateRequest; response: Record<string, unknown> };
  "op:workspace:pick": { request: WorkspacePickRequest; response: Record<string, unknown> };
  "op:workspace:pick:cancel": { request: WorkspacePickCancelRequest; response: Record<string, unknown> };

  "op:file-roots:list": { request: Record<string, never>; response: FileRootsResponse };
  "op:file-roots:add": { request: FileRootsAddRequest; response: Record<string, unknown> };
  "op:file-roots:remove": { request: FileRootsRemoveRequest; response: Record<string, unknown> };

  "op:system:pick-files": { request: SystemPickFilesRequest; response: Record<string, unknown> };
  "op:system:open": { request: SystemOpenRequest; response: Record<string, unknown> };
  "op:system:reveal": { request: SystemRevealRequest; response: Record<string, unknown> };
}

export type ChannelRequest<C extends DesktopChannelId> = DesktopChannelProtocol[C]["request"];
export type ChannelResponse<C extends DesktopChannelId> = DesktopChannelProtocol[C]["response"];

// ============================================================================
// 事件推送通道（op:event）：SSE 的桌面替代。事件桥批次（F3 前置）落地生产侧。
// ============================================================================

export const EVENT_PUSH_CHANNEL = "op:event";

/**
 * 对话流事件信封（server/agent.mjs emit 的通道事件原样转发）。
 * type 取值以 event-registry 登记的事件类型为准；`canonical` 为 U8 规范化视图（flag 开启时附带）。
 */
export interface DesktopEvent {
  /** 通道内序号（对话流为 id，持久事件流为 seq；事件桥统一为该字段） */
  id?: number;
  seq?: number;
  type: string;
  at?: string;
  streamId?: string;
  protocolVersion?: number;
  data: Record<string, unknown>;
  canonical?: unknown;
  [key: string]: unknown;
}

// ============================================================================
// 编译期不变量
// ============================================================================

// 通道协议映射必须与通道清单键集完全一致（多/少键都在这里编译失败）。
type _ProtocolCoversChannels =
  [Exclude<keyof DesktopChannelProtocol, DesktopChannelId>] extends [never]
  ? [Exclude<DesktopChannelId, keyof DesktopChannelProtocol>] extends [never]
    ? true
    : never
  : never;
const _protocolCoversChannels: _ProtocolCoversChannels = true;

// 每个通道的 request 类型必须兼容 InvokeEnvelope（转发器按信封组装 HTTP）。
type _EnvelopeCheck = {
  [C in DesktopChannelId]: ChannelRequest<C> extends InvokeEnvelope ? true : never;
}[DesktopChannelId];
const _envelopeCheck: _EnvelopeCheck = true;
