/**
 * 会话族通道直调器（S3-1，迁移期过渡形态）：op:sessions:* → 进程内直调会话存储域。
 *
 * 旧路径：渲染层 invoke → http-forward 转发 sidecar HTTP（/api/sessions*）。
 * 本模块把会话族 9 条通道的 sidecar 路由编排逐点转录为主进程内直调
 * （行号锚点均指 server/index.mjs）：
 *   - op:sessions:list（L3606-3683）：过滤族（file/projectId/mode/runStatus/pinned/frozen）
 *     + runs 联接（每会话最新一条 Run）+ 项目联接（cwd 记忆化）；
 *   - op:sessions:create（L3686-3712）：header JSONL 原子写入；
 *   - op:sessions:get（L3748-3819）：entries/fork 树/leafId + Chat 视图尾部窗口折叠；
 *   - op:sessions:delete（L3856-3866）/ batch-delete（L3822-3853，活跃 Run 跳过）；
 *   - op:sessions:rename（L3869-3873）/ pin（L3875-3879）/ freeze（L3881-3895）/ fork（L3367-3396）。
 *
 * 与 S2 B 层直调的语义差异：会话族是**文件族共享态**（JSONL 落盘 + runs/projects/
 * workspace 文件域联接），非运行实例态（AgentManager 内存 map）——直调不经过
 * TS AgentManager，读写与 sidecar 同一批文件，跨实例即时一致（fingerprint 缓存自愈），
 * 不存在 S2 "空态过渡"语义。存储层见 backend/agent/session-files.ts（S3-1 转录）。
 *
 * 门控：OP_DESKTOP_AGENT_SESSIONS_DIRECT 且 OP_DESKTOP_AGENT_DOMAIN 双门控（S4 起默认开，
 * =0 显式回滚——流量切换评估方案 §4-S4）。本模块不 import electron（纯逻辑，vitest 可直接测）；
 * 注册入口在 main/index.ts。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { ChannelFailureData, InvokeEnvelope, InvokeResult } from "../../shared/protocol/channels";
import {
  SESSIONS_DIR,
  findSessionFile,
  parseJsonl,
  readSessionHeader,
  readSessionTextCached,
  sessionBaseName,
  sessionMetaFor,
  updateSessionHeader,
  listSessionFiles,
  compactSessionEntryForChat,
  isBootstrapSessionTitle
} from "../backend/agent/session-files";
import { atomicWriteFile } from "../backend/persistence-utils";

/** 会话族编排的跨域依赖（文件域联接面；生产接线传 backend 真实模块，测试注入桩）。 */
export interface AgentSessionsDirectDeps {
  listRunSummaries: (opts?: { limit?: number }) => any[];
  getProject: (id: unknown) => any;
  getProjectForWorkspace: (cwd: unknown) => any;
  getWorkspace: () => string;
  normalizeWorkspace: (dir: unknown) => string | null;
}

/** 会话族直调 invoke 通道清单（与 DESKTOP_CHANNELS 的 op:sessions:* 一致）。 */
export const AGENT_SESSIONS_DIRECT_CHANNELS = [
  "op:sessions:list",
  "op:sessions:create",
  "op:sessions:get",
  "op:sessions:delete",
  "op:sessions:batch-delete",
  "op:sessions:rename",
  "op:sessions:pin",
  "op:sessions:freeze",
  "op:sessions:fork"
] as const;

export type AgentSessionsDirectChannel = (typeof AGENT_SESSIONS_DIRECT_CHANNELS)[number];

const ok = (data: unknown): InvokeResult<unknown> => ({ ok: true, status: 200, data });

const fail = (status: number, error: string): InvokeResult<unknown> => ({
  ok: false,
  status,
  data: { error } as ChannelFailureData
});

function bodyOf(payload: InvokeEnvelope): Record<string, any> {
  const body = payload.body;
  return body && typeof body === "object" ? (body as Record<string, any>) : {};
}

function queryOf(payload: InvokeEnvelope): Record<string, any> {
  return (payload.query ?? {}) as Record<string, any>;
}

/** GET /api/sessions（server L3606-3683 逐点转录）。 */
function invokeSessionsList(payload: InvokeEnvelope, deps: AgentSessionsDirectDeps): InvokeResult<unknown> {
  const query = queryOf(payload);
  const fileFilter = String(query.file || "").trim();
  const projectFilter = String(query.projectId || "").trim();
  const modeFilter = String(query.mode || "").trim();
  const runStatusFilter = String(query.runStatus || "").trim();
  const pinnedFilter = query.pinned === undefined ? null : query.pinned === "true";
  const frozenFilter = query.frozen === undefined ? null : query.frozen === "true";
  try {
    const files = listSessionFiles();
    const recentRuns = deps.listRunSummaries({ limit: 200 });
    // 每个会话只取最新一条 Run；避免 N×M 查找
    const latestRunBySession = new Map<string, any>();
    for (const run of recentRuns) {
      if (run.sessionId && !latestRunBySession.has(run.sessionId)) latestRunBySession.set(run.sessionId, run);
    }
    // 同一 cwd 的项目查询按请求记忆化
    const projectByCwd = new Map<string, any>();
    const projectForCwd = (cwd: string) => {
      const key = cwd || "_";
      if (projectByCwd.has(key)) return projectByCwd.get(key);
      const value = deps.getProjectForWorkspace(cwd || deps.getWorkspace());
      projectByCwd.set(key, value);
      return value;
    };
    const sessions = [];
    for (const f of files) {
      try {
        // 元数据按 mtime+size 指纹缓存：未变化文件不重新读取解析
        const meta = sessionMetaFor(f);
        if (!meta || !meta.isOaw) continue;
        // 按文件过滤：会话内容（用户消息/工具参数）提到该文件才保留（按需全量读取）
        if (fileFilter && !readSessionTextCached(f).includes(fileFilter)) continue;
        const title = meta.label || meta.title;
        // 项目内会话即使尚未发送首条消息也保留，前端才能显示“准备中/运行中”的会话，
        // 也不会因为切换页面而把用户刚创建的对话丢掉。
        if (!meta.hasUserMessage && !meta.label && !meta.isProjectSession) continue;
        if (isBootstrapSessionTitle(title)) continue;
        const id = meta.id;
        const latestRun = latestRunBySession.get(id);
        const project = deps.getProject(meta.projectId) || projectForCwd(meta.cwd);
        if (projectFilter && project?.id !== projectFilter) continue;
        if (modeFilter && (latestRun?.mode || "") !== modeFilter) continue;
        if (runStatusFilter && (latestRun?.status || "idle") !== runStatusFilter) continue;
        if (pinnedFilter !== null && meta.pinned !== pinnedFilter) continue;
        if (frozenFilter !== null && meta.frozen !== frozenFilter) continue;
        sessions.push({
          id,
          threadId: meta.threadId || latestRun?.threadId || id,
          projectId: project?.id || null,
          projectName: project?.name || "",
          projectType: project?.type || "",
          projectStatus: project?.status || "",
          cwd: meta.cwd,
          created: meta.created,
          modified: f.mtime,
          label: meta.label,
          pinned: meta.pinned,
          frozen: meta.frozen,
          freezeReason: meta.freezeReason,
          contextSnapshot: meta.contextSnapshot,
          parentSessionId: meta.parentSessionId,
          branchSourceMessageId: meta.branchSourceMessageId,
          branchPurpose: meta.branchPurpose,
          fileName: f.fileName,
          title,
          runStatus: latestRun?.status || "idle",
          runId: latestRun?.id || null,
          mode: latestRun?.mode || "",
          lastRunAt: latestRun?.finishedAt || latestRun?.startedAt || null,
          artifactCount: latestRun?.artifactCount || 0,
        });
      } catch {}
    }
    return ok({ sessions });
  } catch (e: any) {
    return fail(500, e.message);
  }
}

/** POST /api/sessions（server L3686-3712 逐点转录）。 */
function invokeSessionsCreate(payload: InvokeEnvelope, deps: AgentSessionsDirectDeps): InvokeResult<unknown> {
  try {
    const body = bodyOf(payload);
    const { cwd, projectId, label, frozen = false } = body;
    const workspace = deps.normalizeWorkspace(cwd || deps.getWorkspace()) || deps.getWorkspace();
    const project = deps.getProject(projectId) || deps.getProjectForWorkspace(workspace);
    const id = crypto.randomUUID();
    const created = new Date().toISOString();
    const header = {
      type: "header",
      id,
      sessionId: id,
      threadId: id,
      cwd: workspace,
      projectId: project?.id || null,
      created,
      updatedAt: created,
      label: String(label || "").trim(),
      pinned: false,
      frozen: Boolean(frozen),
    };
    const fileName = id + ".jsonl";
    atomicWriteFile(path.join(SESSIONS_DIR, fileName), JSON.stringify(header) + "\n", "utf8");
    return ok({ id, fileName, cwd: header.cwd, projectId: header.projectId, created, status: "idle", pinned: false, frozen: header.frozen });
  } catch (e: any) {
    return fail(500, e.message);
  }
}

/** GET /api/sessions/:id（server L3748-3819 逐点转录）。 */
function invokeSessionsGet(payload: InvokeEnvelope, deps: AgentSessionsDirectDeps): InvokeResult<unknown> {
  const id = payload.params?.id;
  const found = findSessionFile(id);
  if (!found) return fail(404, "not found");
  try {
    const query = queryOf(payload);
    const text = readSessionTextCached(found);
    const all = parseJsonl(text);
    const header = all.find((e) => e && e.type === "header") || all[0] || {};
    const entries = all.filter((e) => e !== header);
    const chatView = String(query.view || "") === "chat";
    // Chat 视图只服务前端展示，不承担 Pi 会话恢复。恢复仍使用磁盘上的完整
    // JSONL；这里按尾部窗口返回，避免切换一个长会话时把整份工具输出一次性
    // 传到浏览器并触发大批量 JSON/Markdown 解析。
    const chatLimit = chatView
      ? Math.max(80, Math.min(600, Number.parseInt(query.limit, 10) || 360))
      : entries.length;
    const requestedBefore = chatView ? Number.parseInt(query.before, 10) : NaN;
    const historyEnd = Number.isFinite(requestedBefore)
      ? Math.max(0, Math.min(entries.length, requestedBefore))
      : entries.length;
    const historyStart = chatView ? Math.max(0, historyEnd - chatLimit) : 0;
    const chatEntries = chatView ? entries.slice(historyStart, historyEnd) : entries;
    const responseEntries = chatView ? chatEntries.map(compactSessionEntryForChat) : entries;

    // 按 parentId 组织 fork 层级（key 为 parentId，value 为子节点 id 数组）
    const tree: Record<string, string[]> = {};
    for (const e of entries) {
      const pid = (e && e.parentId) || null;
      const bucket = pid == null ? "null" : String(pid);
      if (!tree[bucket]) tree[bucket] = [];
      tree[bucket].push(e.id);
    }

    // 找 leafId：没有任何子节点的 entry（最深的分支末端）
    let leafId: unknown = null;
    for (const e of entries) {
      const kids = tree[e.id];
      if (!kids || kids.length === 0) {
        leafId = e.id;
        break;
      }
    }

    return ok({
      entries: responseEntries,
      // Chat 页面不使用 fork tree；不要把几千个节点再复制一份进响应。
      tree: chatView ? {} : tree,
      leafId,
      info: {
        id: header.sessionId || header.id || sessionBaseName(found.fileName),
        cwd: header.cwd || "",
        projectId: header.projectId || deps.getProjectForWorkspace(header.cwd || deps.getWorkspace())?.id || null,
        created: header.created || "",
        label: header.label || "",
        pinned: Boolean(header.pinned),
        frozen: Boolean(header.frozen),
        freezeReason: header.freezeReason || "",
        contextSnapshot: header.contextSnapshot || null,
        parentSessionId: header.parentSessionId || null,
        branchSourceMessageId: header.branchSourceMessageId || null,
        branchPurpose: header.branchPurpose || "",
        fileName: found.fileName,
        modified: found.mtime,
        chatView,
        historyTotal: chatView ? entries.length : undefined,
        historyStart: chatView ? historyStart : undefined,
        historyEnd: chatView ? historyEnd : undefined,
        historyHasMore: chatView ? historyStart > 0 : false,
      },
    });
  } catch (e: any) {
    return fail(500, e.message);
  }
}

/**
 * POST /api/sessions/batch-delete（server L3822-3853 逐点转录）。
 * 运行中的会话跳过（runs 文件域联接，跨实例共享）。
 */
function invokeSessionsBatchDelete(payload: InvokeEnvelope, deps: AgentSessionsDirectDeps): InvokeResult<unknown> {
  const body = bodyOf(payload);
  const ids = [...new Set((Array.isArray(body?.ids) ? body.ids : [])
    .map((id: unknown) => String(id || "").trim())
    .filter(Boolean))].slice(0, 200);
  if (!ids.length) return fail(400, "ids required");
  const activeSessionIds = new Set(deps.listRunSummaries({ limit: 500 })
    .filter((run: any) => ["running", "queued", "waiting_user", "recovering", "cancel_requested"].includes(run?.status))
    .map((run: any) => String(run.sessionId || ""))
    .filter(Boolean));
  const deleted: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  const missing: string[] = [];
  for (const id of ids) {
    if (activeSessionIds.has(id)) {
      skipped.push({ id, reason: "会话正在运行" });
      continue;
    }
    const found = findSessionFile(id);
    if (!found) {
      missing.push(id);
      continue;
    }
    try {
      fs.unlinkSync(found.fullPath);
      deleted.push(id);
    } catch (error: any) {
      skipped.push({ id, reason: error.message || "删除失败" });
    }
  }
  return ok({ ok: true, deleted, skipped, missing });
}

/** DELETE /api/sessions/:id（server L3856-3866 逐点转录）。 */
function invokeSessionsDelete(payload: InvokeEnvelope): InvokeResult<unknown> {
  const found = findSessionFile(payload.params?.id);
  if (!found) return fail(404, "not found");
  try {
    fs.unlinkSync(found.fullPath);
    return ok({ ok: true });
  } catch (e: any) {
    return fail(500, e.message);
  }
}

/** POST /api/sessions/:id/rename（server L3869-3873 逐点转录）。 */
function invokeSessionsRename(payload: InvokeEnvelope): InvokeResult<unknown> {
  const result = updateSessionHeader(payload.params?.id, { label: String(bodyOf(payload)?.label || "").trim() }) as Record<string, any>;
  if (!result.ok) return { ok: false, status: (result.status as number) || 400, data: result };
  return ok({ ok: true, label: result.header.label });
}

/** POST /api/sessions/:id/pin（server L3875-3879 逐点转录）。 */
function invokeSessionsPin(payload: InvokeEnvelope): InvokeResult<unknown> {
  const result = updateSessionHeader(payload.params?.id, { pinned: bodyOf(payload)?.pinned !== false }) as Record<string, any>;
  if (!result.ok) return { ok: false, status: (result.status as number) || 400, data: result };
  return ok({ ok: true, sessionId: payload.params?.id, pinned: Boolean(result.header.pinned) });
}

/** POST /api/sessions/:id/freeze（server L3881-3895 逐点转录）。 */
function invokeSessionsFreeze(payload: InvokeEnvelope): InvokeResult<unknown> {
  const body = bodyOf(payload);
  const frozen = body?.frozen !== false;
  const found = findSessionFile(payload.params?.id);
  const header = readSessionHeader(found);
  const capturedAt = new Date().toISOString();
  const result = updateSessionHeader(payload.params?.id, {
    frozen,
    freezeReason: frozen ? String(body?.reason || "用户冻结会话") : "",
    contextSnapshot: frozen
      ? (body?.snapshot || { capturedAt, workspace: header.cwd || "", projectId: header.projectId || null, source: "session-freeze" })
      : (header.contextSnapshot || null),
  }) as Record<string, any>;
  if (!result.ok) return { ok: false, status: (result.status as number) || 400, data: result };
  return ok({ ok: true, sessionId: payload.params?.id, frozen: Boolean(result.header.frozen), freezeReason: result.header.freezeReason || "", contextSnapshot: result.header.contextSnapshot || null });
}

/**
 * POST /api/sessions/:id/fork（server L3367-3396 逐点转录）。
 * 注意：本路由 500 错误体带 code/detail 字段（与其他路由不同，忠实转录）。
 */
function invokeSessionsFork(payload: InvokeEnvelope): InvokeResult<unknown> {
  const found = findSessionFile(payload.params?.id);
  if (!found) return fail(404, "not found");
  try {
    const body = bodyOf(payload);
    const source = readSessionTextCached(found);
    const lines = source.split(/\r?\n/).filter(Boolean);
    if (!lines.length) return fail(400, "empty session");
    const header = JSON.parse(lines[0]!);
    const id = crypto.randomUUID();
    const label = String(body?.label || `${header.label || "会话"}（分支）`).trim();
    const nextHeader = {
      ...header,
      id,
      sessionId: id,
      threadId: id,
      parentSessionId: header.sessionId || header.id || payload.params?.id,
      branchSourceMessageId: String(body?.sourceMessageId || "") || null,
      branchPurpose: String(body?.purpose || "") || "从历史会话创建的独立分支",
      created: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      label,
      pinned: false,
      frozen: false,
    };
    lines[0] = JSON.stringify(nextHeader);
    const fileName = `${id}.jsonl`;
    atomicWriteFile(path.join(SESSIONS_DIR, fileName), lines.join("\n") + "\n", "utf8");
    return ok({ ok: true, id, fileName, parentSessionId: nextHeader.parentSessionId, cwd: nextHeader.cwd, threadId: id, label, projectId: nextHeader.projectId || null });
  } catch (e: any) {
    return { ok: false, status: 500, data: { error: e.message, code: e.code || null, detail: e.detail || null } };
  }
}

/**
 * 会话族通道直调分发：channel → 逐通道转录的 sidecar 路由编排。
 * 未知通道不进入本分发（注册面只登记 AGENT_SESSIONS_DIRECT_CHANNELS 清单）；
 * 处理器抛出的意外错误统一 500（对齐 http-forward 网络失败兜底形态）。
 */
export async function invokeAgentSessionsDirect(
  channel: AgentSessionsDirectChannel,
  envelope: InvokeEnvelope | undefined,
  deps: AgentSessionsDirectDeps
): Promise<InvokeResult<unknown>> {
  const payload: InvokeEnvelope = envelope ?? {};
  try {
    switch (channel) {
      case "op:sessions:list": return invokeSessionsList(payload, deps);
      case "op:sessions:create": return invokeSessionsCreate(payload, deps);
      case "op:sessions:get": return invokeSessionsGet(payload, deps);
      case "op:sessions:delete": return invokeSessionsDelete(payload);
      case "op:sessions:batch-delete": return invokeSessionsBatchDelete(payload, deps);
      case "op:sessions:rename": return invokeSessionsRename(payload);
      case "op:sessions:pin": return invokeSessionsPin(payload);
      case "op:sessions:freeze": return invokeSessionsFreeze(payload);
      case "op:sessions:fork": return invokeSessionsFork(payload);
    }
  } catch (error) {
    return fail(500, error instanceof Error ? error.message : String(error));
  }
}
