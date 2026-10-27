/**
 * 项目管理族通道直调器（D-2，非 agent 域收编第四批）：op:projects:* → 进程内直调
 * project-management 域 + runs/session-files/装配单飞 agentManager 计数聚合。
 *
 * 旧路径：渲染层 invoke → http-forward 转发 sidecar HTTP。本模块把 7 条通道的
 * sidecar 路由编排逐点转录为主进程内直调（行号锚点均指 server/index.mjs）：
 *   - op:projects:list（L3298-3328，最复杂处）：ensureProjectForWorkspace 自动登记
 *     当前工作区（历史 Pi 会话指向临时目录不批量污染）→ runs(200 条)/memoryProposals/
 *     会话文件三源计数聚合 → listProjects(filters) 逐项目投影 sessionCount/runCount/
 *     artifactCount/unresolvedRunCount/pending·approvedMemoryCount/lastMemoryAt →
 *     { projects, types, statuses, profiles, defaultSettings }；
 *   - op:projects:create（L3330-3334）：!ok→400 result 整体透传；
 *   - op:projects:update（L3336-3340）：!ok→404 透传；
 *   - op:projects:settings:update（L3348-3352）：!ok→404 透传；
 *   - op:projects:archive（L3354-3358）：archived: body?.archived !== false，!ok→404 透传；
 *   - op:projects:pin（L3360-3364）：updateProject(id, { pinned })，!ok→404 透传；
 *   - op:projects:classify（L4504-4510）：{ apply: body?.apply === true }，catch 500
 *     { ok:false, error }。
 * （GET /api/projects/:id/settings 无对应 invoke 通道，不转录。）
 *
 * 计数聚合语义逐点对齐：
 *   - sessionCount：session.projectId === project.id || session.cwd === project.rootPath；
 *   - runCount/artifactCount（run.artifactCount 求和）/unresolvedRunCount（五态白名单
 *     running/queued/waiting_user/recovering/cancel_requested）：均按 run.cwd === rootPath；
 *   - pending/approvedMemoryCount：workspace === rootPath 且 status 对应；
 *   - lastMemoryAt：approvedAt || createdAt 取最大（字符串 ISO 排序 pop），空回退 null。
 *
 * 错误形态：list 聚合与 classify 有 try/catch（catch 500 { error } / { ok:false, error }
 * 忠实转录）；create/update/settings/archive/pin 五条薄路由在 sidecar 无 try/catch
 * （异常走 express 默认错误页），直调形态统一由分发器兜底 500 { ok:false, error }。
 *
 * 数据源：backend/project-management.ts（B2-9 直绑）+ backend/runs.ts（B2-4 直绑）+
 * backend/agent/session-files.ts（C-6/C-3 同款）+ 装配单飞 agentManager.memoryProposals。
 *
 * 门控：OP_DESKTOP_PROJECTS_DIRECT 且 OP_DESKTOP_AGENT_DOMAIN 双门控
 * （S4 语义：未设置=默认启用，=0 显式回滚——流量切换评估方案 §4-S4）。
 * 本模块不 import electron（纯逻辑，vitest 可直接测）；注册入口在 main/index.ts。
 */
import type { InvokeEnvelope, InvokeResult } from "../../shared/protocol/channels";

/** 项目管理编排的跨域依赖（生产接线传 backend 真实模块与装配单飞，测试注入桩）。 */
export interface ProjectManagementDirectDeps {
  /** 当前工作区（backend/workspace.ts getWorkspace） */
  getWorkspace: () => string;
  /** 自动登记当前工作区（backend/project-management.ts ensureProjectForWorkspace） */
  ensureProjectForWorkspace: (rootPath: string) => unknown;
  /** 运行摘要清单（backend/runs.ts listRunSummaries） */
  listRunSummaries: (options: { limit?: number }) => Array<Record<string, any>>;
  /** 记忆提案清单（装配单飞 agentManager.memoryProposals） */
  memoryProposals: () => Array<Record<string, any>>;
  /** 会话文件清单（backend/agent/session-files.ts listSessionFiles） */
  listSessionFiles: () => Array<{ fileName: string; fullPath: string; storeDir: string; mtime: number; size: number; sessionId?: string }>;
  /** 会话头读取（backend/agent/session-files.ts readSessionHeader） */
  readSessionHeader: (found: { fileName: string; fullPath: string; storeDir: string; mtime: number; size: number; sessionId?: string } | null) => Record<string, any>;
  /** 项目清单（backend/project-management.ts listProjects） */
  listProjects: (filters: Record<string, any>) => any[];
  listProjectTypes: () => string[];
  listProjectStatuses: () => string[];
  listProjectProfiles: () => Record<string, any>;
  defaultProjectSettings: () => Record<string, any>;
  createProject: (input: Record<string, any>) => { ok: boolean } & Record<string, unknown>;
  updateProject: (id: unknown, patch: Record<string, any>) => { ok: boolean } & Record<string, unknown>;
  getProjectSettings: (id: unknown) => Record<string, any>;
  updateProjectSettings: (id: unknown, patch: Record<string, any>) => { ok: boolean } & Record<string, unknown>;
  archiveProject: (id: unknown, archived: boolean) => { ok: boolean } & Record<string, unknown>;
  classifyProjects: (options: Record<string, any>) => Record<string, unknown>;
}

/** 项目管理族直调 invoke 通道清单（与 DESKTOP_CHANNELS 对应路由一致）。 */
export const PROJECT_MANAGEMENT_DIRECT_CHANNELS = [
  "op:projects:list",
  "op:projects:create",
  "op:projects:classify",
  "op:projects:update",
  "op:projects:pin",
  "op:projects:archive",
  "op:projects:settings:update"
] as const;

export type ProjectManagementDirectChannel = (typeof PROJECT_MANAGEMENT_DIRECT_CHANNELS)[number];

const ok = (data: unknown): InvokeResult<unknown> => ({ ok: true, status: 200, data });

function bodyOf(payload: InvokeEnvelope): Record<string, any> {
  const body = payload.body;
  return body && typeof body === "object" ? (body as Record<string, any>) : {};
}

function paramsOf(payload: InvokeEnvelope): Record<string, unknown> {
  return (payload.params ?? {}) as Record<string, unknown>;
}

/** 非 ok 薄路由透传（create 400 / update·settings·archive·pin 404，result 整体透传）。 */
function thinResult(result: { ok: boolean } & Record<string, unknown>, notOkStatus: number): InvokeResult<unknown> {
  return { ok: Boolean(result.ok), status: result.ok ? 200 : notOkStatus, data: result } as InvokeResult<unknown>;
}

/* ------------------------------ 通道转录 ------------------------------ */

/** GET /api/projects（server L3298-3328 逐点转录：四域计数聚合）。 */
function invokeProjectsList(payload: InvokeEnvelope, deps: ProjectManagementDirectDeps): InvokeResult<unknown> {
  try {
    // 只自动登记当前工作区。历史 Pi 会话可能指向临时目录或用户目录，不能把它们批量污染项目列表。
    deps.ensureProjectForWorkspace(deps.getWorkspace());
    const runs = deps.listRunSummaries({ limit: 200 });
    const proposals = deps.memoryProposals();
    const sessions = deps.listSessionFiles().map((file) => {
      const header = deps.readSessionHeader(file);
      return { cwd: header.cwd || "", projectId: header.projectId || "", id: header.id || header.sessionId || "" };
    }).filter((item) => item.id);
    const query = (payload.query ?? {}) as Record<string, unknown>;
    const projectFilters = {
      type: String(query.type || ""),
      status: String(query.status || ""),
      pinned: query.pinned === undefined ? null : query.pinned === "true",
      sort: String(query.sort || "recent")
    };
    const projects = deps.listProjects(projectFilters).map((project) => ({
      ...project,
      sessionCount: sessions.filter((session) => session.projectId === project.id || session.cwd === project.rootPath).length,
      runCount: runs.filter((run) => run.cwd === project.rootPath).length,
      artifactCount: runs.filter((run) => run.cwd === project.rootPath).reduce((count, run) => count + (run.artifactCount || 0), 0),
      unresolvedRunCount: runs.filter((run) => run.cwd === project.rootPath && ["running", "queued", "waiting_user", "recovering", "cancel_requested"].includes(run.status)).length,
      pendingMemoryCount: proposals.filter((item) => item.workspace === project.rootPath && item.status === "pending").length,
      approvedMemoryCount: proposals.filter((item) => item.workspace === project.rootPath && item.status === "approved").length,
      lastMemoryAt: proposals.filter((item) => item.workspace === project.rootPath).map((item) => item.approvedAt || item.createdAt).sort().pop() || null
    }));
    return ok({
      projects,
      types: deps.listProjectTypes(),
      statuses: deps.listProjectStatuses(),
      profiles: deps.listProjectProfiles(),
      defaultSettings: deps.defaultProjectSettings()
    });
  } catch (error) {
    const e = error as { message?: unknown };
    return { ok: false, status: 500, data: { error: String(e?.message ?? error) } } as InvokeResult<unknown>;
  }
}

/** POST /api/projects（server L3330-3334 逐点转录：!ok→400 透传）。 */
function invokeProjectsCreate(payload: InvokeEnvelope, deps: ProjectManagementDirectDeps): InvokeResult<unknown> {
  const result = deps.createProject(bodyOf(payload) || {});
  return thinResult(result, 400);
}

/** PATCH /api/projects/:id（server L3336-3340 逐点转录：!ok→404 透传）。 */
function invokeProjectsUpdate(payload: InvokeEnvelope, deps: ProjectManagementDirectDeps): InvokeResult<unknown> {
  const result = deps.updateProject(paramsOf(payload).id, bodyOf(payload) || {});
  return thinResult(result, 404);
}

/** PATCH /api/projects/:id/settings（server L3348-3352 逐点转录：!ok→404 透传）。 */
function invokeProjectsSettingsUpdate(payload: InvokeEnvelope, deps: ProjectManagementDirectDeps): InvokeResult<unknown> {
  const result = deps.updateProjectSettings(paramsOf(payload).id, bodyOf(payload) || {});
  return thinResult(result, 404);
}

/** POST /api/projects/:id/archive（server L3354-3358 逐点转录：archived 缺省归档 true）。 */
function invokeProjectsArchive(payload: InvokeEnvelope, deps: ProjectManagementDirectDeps): InvokeResult<unknown> {
  const result = deps.archiveProject(paramsOf(payload).id, bodyOf(payload)?.archived !== false);
  return thinResult(result, 404);
}

/** POST /api/projects/:id/pin（server L3360-3364 逐点转录：pinned 缺省置顶 true）。 */
function invokeProjectsPin(payload: InvokeEnvelope, deps: ProjectManagementDirectDeps): InvokeResult<unknown> {
  const result = deps.updateProject(paramsOf(payload).id, { pinned: bodyOf(payload)?.pinned !== false });
  return thinResult(result, 404);
}

/** POST /api/projects/classify（server L4504-4510 逐点转录：apply 严格 ===true）。 */
function invokeProjectsClassify(payload: InvokeEnvelope, deps: ProjectManagementDirectDeps): InvokeResult<unknown> {
  try {
    return ok(deps.classifyProjects({ apply: bodyOf(payload)?.apply === true }));
  } catch (error) {
    const e = error as { message?: unknown };
    return { ok: false, status: 500, data: { ok: false, error: String(e?.message ?? error) } } as InvokeResult<unknown>;
  }
}

/** 项目管理族直调分发器（unknown channel → 404；薄路由异常统一 500 兜底——语义差异见模块头）。 */
export async function invokeProjectManagementDirect(
  channel: string,
  payload: InvokeEnvelope | undefined,
  deps: ProjectManagementDirectDeps
): Promise<InvokeResult<unknown>> {
  const envelope: InvokeEnvelope = payload ?? {};
  try {
    switch (channel as ProjectManagementDirectChannel) {
      case "op:projects:list":
        return invokeProjectsList(envelope, deps);
      case "op:projects:create":
        return invokeProjectsCreate(envelope, deps);
      case "op:projects:classify":
        return invokeProjectsClassify(envelope, deps);
      case "op:projects:update":
        return invokeProjectsUpdate(envelope, deps);
      case "op:projects:pin":
        return invokeProjectsPin(envelope, deps);
      case "op:projects:archive":
        return invokeProjectsArchive(envelope, deps);
      case "op:projects:settings:update":
        return invokeProjectsSettingsUpdate(envelope, deps);
      default:
        return { ok: false, status: 404, data: { error: `unknown channel: ${channel}` } } as InvokeResult<unknown>;
    }
  } catch (error) {
    // create/update/settings/archive/pin 五条薄路由 sidecar 无 try/catch（express 默认
    // 错误页）；直调形态统一 500 { ok:false, error } JSON 信封，调用方语义等价。
    const e = error as { message?: unknown };
    return { ok: false, status: 500, data: { ok: false, error: String(e?.message ?? error) } } as InvokeResult<unknown>;
  }
}
