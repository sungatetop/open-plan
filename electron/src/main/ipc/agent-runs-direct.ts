/**
 * 运行族通道直调器（S3-2，迁移期过渡形态）：op:runs:* / op:artifacts:* 13 通道中
 * 11 条 sidecar 路由编排 → TS 域服务进程内直调。
 *
 * 旧路径：渲染层 invoke → http-forward 转发 sidecar HTTP（/api/runs* /api/artifacts*）。
 * 本模块把路由编排逐点转录为主进程内直调，底层域全部消费 TS 已迁件：
 *   - runs 域（backend/runs.ts，B2-2）：listRuns/getRun/updateRunStep/finishRun/
 *     requestRunCancellation/awaitBeforeBlobs/rollbackRun/runSummaryView；
 *   - artifact 域（backend/artifact-management.ts，本批转录）：listPublishedArtifacts/
 *     publishArtifact/confirmArtifactAcceptance/inspectRunAcceptance/rollbackPublishedArtifact；
 *   - diff 域（backend/file-diff.ts，本批转录）：DIFF_LIMITS/diffFileContents；
 *   - workspace 域（backend/workspace.ts）：normalizeWorkspace/isInside；
 *   - cancel 的 live 态消费 TS AgentManager（sessions map / abort）。
 * resume/retry 不在本分发（依赖 executeContinuation = S3-3 prompt 主链），继续转发 sidecar。
 *
 * 文件族共享态语义（与 S3-1 会话族同构）：runs/发布台账/after blob 均为文件族，
 * 与 sidecar 同 env 锚点（OAW_RUNS_DIR），跨实例即时一致；唯 cancel 的 live.busy
 * 判定消费运行实例内存态——S3-3 prompt 流量切换前直调读到 TS 实例空态（busy 恒 false →
 * 走 finishRun cancelled 分支），与 S2 运行实例归属过渡语义同构（评估方案 §4-S2/S3）。
 *
 * 门控：OP_DESKTOP_AGENT_RUNS_DIRECT 且 OP_DESKTOP_AGENT_DOMAIN 双门控（S4 起默认开，
 * =0 显式回滚——流量切换评估方案 §4-S4）。本模块不 import electron（纯逻辑，vitest 可直接测）；
 * 注册入口在 main/index.ts。路由语义锚点：server/index.mjs L3037-3295 / L3177-3203。
 */
import fs from "node:fs";
import path from "node:path";
import type { ChannelFailureData, InvokeEnvelope, InvokeResult } from "../../shared/protocol/channels";
import { agentKey } from "../backend/agent/agent-key";

/** TS AgentManager 直调消费面（cancel 路由的 live 态视图）。 */
export interface AgentRunsManagerView {
  sessions?: Map<any, any>;
  abort(key: unknown): Promise<unknown>;
}

export interface AgentRunsDirectDeps {
  /** TS AgentManager 单飞（生产传 assembly.getAgentManager；测试注入桩） */
  getManager: () => Promise<AgentRunsManagerView>;
  /** 会话键（默认 backend/agent/agent-key 转录，server L1387-1391） */
  agentKeyOf?: (client: unknown, thread: unknown) => string;
  /** runs 域（backend/runs.ts，B2-2） */
  getRun: (id: unknown) => any;
  listRuns: (opts: Record<string, any>) => any[];
  runSummaryView: (run: any) => any;
  updateRunStep: (id: unknown, stepId: unknown, patch: Record<string, any>) => any;
  finishRun: (id: string, patch: Record<string, any>) => any;
  requestRunCancellation: (id: unknown, reason: unknown) => unknown;
  awaitBeforeBlobs: (runId: unknown) => Promise<unknown>;
  rollbackRun: (id: unknown, paths?: string[]) => any;
  /** artifact 域（backend/artifact-management.ts，本批转录） */
  listPublishedArtifacts: (opts?: Record<string, unknown>) => any[];
  publishArtifact: (runId: unknown, artifactId: unknown, opts?: Record<string, unknown>) => Promise<any>;
  confirmArtifactAcceptance: (runId: unknown, artifactId: unknown, opts?: Record<string, unknown>) => Promise<any>;
  inspectRunAcceptance: (runId: unknown, rules?: Record<string, unknown>) => Promise<any>;
  rollbackPublishedArtifact: (publicationId: unknown, opts?: Record<string, unknown>) => any;
  /** diff 域（backend/file-diff.ts，本批转录） */
  diffFileContents: (input: Record<string, unknown>) => any;
  diffLimits: { maxInputBytes: number; maxHunksPerPage: number };
  /** Run 的 after blob 目录（OAW_RUNS_DIR 同锚点，runs.ts runsDir） */
  runsChangesDir: () => string;
  /** workspace 域（backend/workspace.ts） */
  normalizeWorkspace: (dir: unknown) => string | null;
  isInside: (root: string, target: string) => boolean;
}

/** 运行族直调 invoke 通道清单（resume/retry 除外——依赖 S3-3 prompt 主链）。 */
export const AGENT_RUNS_DIRECT_CHANNELS = [
  "op:runs:list",
  "op:runs:get",
  "op:runs:cancel",
  "op:runs:rollback",
  "op:runs:step",
  "op:runs:artifacts:publish",
  "op:runs:artifacts:accept",
  "op:runs:acceptance",
  "op:runs:diff",
  "op:artifacts:list",
  "op:artifacts:rollback"
] as const;

export type AgentRunsDirectChannel = (typeof AGENT_RUNS_DIRECT_CHANNELS)[number];

/** 解析默认值后的 deps（agentKeyOf 默认 backend/agent/agent-key）。 */
interface ResolvedDeps extends AgentRunsDirectDeps {
  agentKeyOf: (client: unknown, thread: unknown) => string;
}

const ok = (data: unknown): InvokeResult<unknown> => ({ ok: true, status: 200, data });

const fail = (status: number, data: unknown): InvokeResult<unknown> => ({
  ok: false,
  status,
  data: data as ChannelFailureData
});

function bodyOf(payload: InvokeEnvelope): Record<string, unknown> {
  const body = payload.body;
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

function queryOf(payload: InvokeEnvelope): Record<string, unknown> {
  return (payload.query ?? {}) as Record<string, unknown>;
}

function paramsOf(payload: InvokeEnvelope): Record<string, unknown> {
  return (payload.params ?? {}) as Record<string, unknown>;
}

/** query 取参：与 http-forward 组串（String(value)）→ express 解析后的字符串语义一致。 */
function queryString(query: Record<string, unknown>, key: string): string {
  return String(query[key] ?? "");
}

// ---------- diff 路由内联助手（server/index.mjs L3217-3241 逐行转录） ----------

/** 读文件前 N 字节（大文件不整读，避免阻塞 Node 主线程）。 */
function readCappedBuffer(file: string, maxBytes: unknown): { buffer: Buffer; size: number; truncated: boolean } | null {
  let fd: number | null = null;
  try {
    const stat = fs.statSync(file);
    const size = Number(stat.size) || 0;
    const toRead = Math.min(size, Math.max(0, Number(maxBytes) || 0));
    fd = fs.openSync(file, "r");
    const buffer = Buffer.allocUnsafe(toRead);
    const read = toRead > 0 ? fs.readSync(fd, buffer, 0, toRead, 0) : 0;
    return { buffer: buffer.subarray(0, read), size, truncated: size > toRead };
  } catch {
    return null;
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch {} }
  }
}

function runChangeById(run: any, changeId: unknown) {
  const wanted = String(changeId || "");
  return (Array.isArray(run?.artifacts) ? run.artifacts : [])
    .find((item: any) => item.changeId === wanted || item.artifactId === wanted) || null;
}

// ---------- 逐通道转录（锚点 server/index.mjs 各路由） ----------

/** GET /api/runs（server L3037-3059 逐点转录）。 */
function invokeRunsList(payload: InvokeEnvelope, deps: ResolvedDeps): InvokeResult<unknown> {
  const query = queryOf(payload);
  const rawCwd = queryString(query, "cwd");
  const cwd = rawCwd ? (deps.normalizeWorkspace(rawCwd) || "__invalid_workspace__") : "";
  // fields=summary：任务中心列表/徽标只消费状态摘要，不需要步骤、待办与事件；
  // 省下的解析与传输对首屏和高频轮询都直接可见（明细仍由 /api/runs/:id 单条加载）。
  const summaryOnly = queryString(query, "fields") === "summary";
  const requestedEvents = ["all", "none", "latest"].includes(queryString(query, "includeEvents"))
    ? queryString(query, "includeEvents")
    : "latest";
  const includeEvents = summaryOnly ? "none" : requestedEvents;
  const runs = deps.listRuns({
    threadId: queryString(query, "thread"),
    sessionId: queryString(query, "session"),
    cwd,
    projectId: queryString(query, "projectId"),
    status: queryString(query, "status"),
    mode: queryString(query, "mode"),
    query: queryString(query, "query"),
    limit: Number.parseInt(queryString(query, "limit"), 10) || 50,
    includeEvents,
  });
  return ok({ runs: summaryOnly ? runs.map((run) => deps.runSummaryView(run)) : runs });
}

/** GET /api/runs/:id（server L3136-3140 逐点转录）。 */
function invokeRunsGet(payload: InvokeEnvelope, deps: ResolvedDeps): InvokeResult<unknown> {
  const run = deps.getRun(paramsOf(payload).id);
  if (!run) return fail(404, { error: "run not found" });
  return ok({ run });
}

/** POST /api/runs/:id/cancel（server L3142-3160 逐点转录）。 */
async function invokeRunsCancel(payload: InvokeEnvelope, deps: ResolvedDeps): Promise<InvokeResult<unknown>> {
  const id = paramsOf(payload).id;
  const run = deps.getRun(id);
  if (!run) return fail(404, { error: "run not found" });
  if (!run.actions?.canCancel) return fail(409, { error: `任务当前状态不可取消：${run.status}`, run });
  const pending = deps.requestRunCancellation(run.id, String(bodyOf(payload).reason || "用户请求取消"));
  const key = deps.agentKeyOf(run.clientId, run.threadId);
  const manager = await deps.getManager();
  const live = manager.sessions?.get(key);
  try {
    if (live?.busy) {
      await manager.abort(key);
    } else {
      deps.finishRun(run.id, { status: "cancelled", sessionId: run.sessionId, error: "任务在恢复前被取消", summary: "任务已取消" });
    }
    // P2-3：同上，回执仍排队的轮次数量（取消发生在排队期时该值 > 0）。
    return ok({ ok: true, run: deps.getRun(run.id), previous: pending, stillQueued: Number(live?.queuedCount || 0) });
  } catch (error: any) {
    return fail(409, { error: error.message, run: deps.getRun(run.id) });
  }
}

/** POST /api/runs/:id/rollback（server L3162-3169 逐点转录）。 */
async function invokeRunsRollback(payload: InvokeEnvelope, deps: ResolvedDeps): Promise<InvokeResult<unknown>> {
  const body = bodyOf(payload);
  if (body.confirm !== true) return fail(400, { error: "rollback requires confirm=true" });
  // 回滚底稿是后台复制的：先确保它落地，再按它还原（否则会"回滚了但没内容可还原"）。
  try { await deps.awaitBeforeBlobs(paramsOf(payload).id); } catch {}
  const result = deps.rollbackRun(paramsOf(payload).id, body.paths as string[] | undefined);
  if (!result.ok) return fail(400, result);
  return ok(result);
}

/** POST /api/runs/:id/steps/:stepId（server L3171-3175 逐点转录）。 */
function invokeRunsStep(payload: InvokeEnvelope, deps: ResolvedDeps): InvokeResult<unknown> {
  const params = paramsOf(payload);
  const run = deps.updateRunStep(params.id, params.stepId, bodyOf(payload));
  if (!run) return fail(404, { error: "run or step not found" });
  return ok({ ok: true, run: deps.getRun(params.id) });
}

/** GET /api/artifacts（server L3177-3180 逐点转录）。 */
function invokeArtifactsList(payload: InvokeEnvelope, deps: ResolvedDeps): InvokeResult<unknown> {
  const query = queryOf(payload);
  const rawCwd = query.cwd;
  const cwd = rawCwd ? (deps.normalizeWorkspace(String(rawCwd)) || "__invalid_workspace__") : "";
  return ok({ artifacts: deps.listPublishedArtifacts({ cwd, projectId: queryString(query, "projectId"), limit: Number.parseInt(queryString(query, "limit"), 10) || 200 }) });
}

/** POST /api/runs/:id/artifacts/:artifactId/publish（server L3182-3186 逐点转录）。 */
async function invokeArtifactPublish(payload: InvokeEnvelope, deps: ResolvedDeps): Promise<InvokeResult<unknown>> {
  const params = paramsOf(payload);
  const body = bodyOf(payload);
  const result = await deps.publishArtifact(params.id, params.artifactId, { rules: body.rules || {}, operator: body.operator });
  if (!result.ok) return fail(result.status || 400, result);
  return ok(result);
}

/** POST /api/runs/:id/artifacts/:artifactId/accept（server L3188-3196 逐点转录）。 */
async function invokeArtifactAccept(payload: InvokeEnvelope, deps: ResolvedDeps): Promise<InvokeResult<unknown>> {
  const params = paramsOf(payload);
  const body = bodyOf(payload);
  const result = await deps.confirmArtifactAcceptance(params.id, params.artifactId, {
    note: body.note as string | undefined,
    operator: body.operator as string | undefined,
    rules: body.rules || {},
  });
  if (!result.ok) return fail(result.status || 400, result);
  return ok(result);
}

/** POST /api/artifacts/:publicationId/rollback（server L3198-3203 逐点转录）。 */
function invokeArtifactRollback(payload: InvokeEnvelope, deps: ResolvedDeps): InvokeResult<unknown> {
  const body = bodyOf(payload);
  if (body.confirm !== true) return fail(400, { error: "rollback requires confirm=true" });
  const result = deps.rollbackPublishedArtifact(paramsOf(payload).publicationId, { operator: body.operator });
  if (!result.ok) return fail(result.status || 400, result);
  return ok(result);
}

/** GET /api/runs/:id/acceptance（server L3205-3211 逐点转录）。 */
async function invokeRunsAcceptance(payload: InvokeEnvelope, deps: ResolvedDeps): Promise<InvokeResult<unknown>> {
  let rules: Record<string, unknown> = {};
  try { rules = queryString(queryOf(payload), "rules") ? JSON.parse(queryString(queryOf(payload), "rules")) : {}; } catch { return fail(400, { error: "rules 参数不是有效 JSON" }); }
  const result = await deps.inspectRunAcceptance(paramsOf(payload).id, rules);
  if (!result.ok) return fail(result.status || 400, result);
  return ok(result);
}

/** GET /api/runs/:id/changes/:changeId/diff（server L3243-3295 逐点转录）。 */
function invokeRunsDiff(payload: InvokeEnvelope, deps: ResolvedDeps): InvokeResult<unknown> {
  const params = paramsOf(payload);
  const run = deps.getRun(params.id);
  if (!run) return fail(404, { ok: false, error: "run not found", code: "RUN_NOT_FOUND" });
  const change = runChangeById(run, params.changeId);
  if (!change) return fail(404, { ok: false, error: "该 Run 记录里没有这个变更", code: "CHANGE_NOT_FOUND" });
  const relativePath = String(change.relativePath || change.path || "").replace(/\\/g, "/");
  const cwd = String(change.cwd || run.cwd || "");
  const page = Math.max(0, Number.parseInt(queryString(queryOf(payload), "page") || "0", 10) || 0);

  // before：Run 的 before blob（只有明确标记可用时才读）
  let before: ReturnType<typeof readCappedBuffer> = null;
  if (change.blobs?.before) {
    const file = path.join(deps.runsChangesDir(), run.id, "before", relativePath);
    before = readCappedBuffer(file, deps.diffLimits.maxInputBytes + 1);
  }
  // after：优先 Run 的 after blob，其次当前工作区文件（必须仍在工作区内）
  let after: ReturnType<typeof readCappedBuffer> = null;
  if (change.blobs?.after) {
    const file = path.join(deps.runsChangesDir(), run.id, "after", relativePath);
    after = readCappedBuffer(file, deps.diffLimits.maxInputBytes + 1);
  }
  if (!after && cwd && relativePath) {
    const target = path.resolve(cwd, relativePath);
    if (deps.isInside(cwd, target)) after = readCappedBuffer(target, deps.diffLimits.maxInputBytes + 1);
  }
  const diff = deps.diffFileContents({
    relativePath,
    beforeBuffer: before?.buffer ?? null,
    afterBuffer: after?.buffer ?? null,
    before: { size: before?.size ?? change.before?.size ?? null, hash: change.before?.hash ?? null },
    after: { size: after?.size ?? change.after?.size ?? null, hash: change.after?.hash ?? null },
    page,
  });
  return ok({
    ok: true,
    change: {
      changeId: change.changeId || null,
      relativePath,
      changeType: change.changeType || change.status || null,
      confidence: change.confidence || null,
      source: change.source || null,
      blobs: change.blobs || { before: false, after: false },
      acceptanceStatus: change.acceptanceStatus || null,
      verificationStatus: change.verificationStatus || null,
    },
    diff,
    limits: {
      maxInputBytes: deps.diffLimits.maxInputBytes,
      maxHunksPerPage: deps.diffLimits.maxHunksPerPage,
      inputTruncated: Boolean(before?.truncated || after?.truncated),
    },
  });
}

interface RouteEntry {
  invoke: (payload: InvokeEnvelope, deps: ResolvedDeps) => Promise<InvokeResult<unknown>> | InvokeResult<unknown>;
}

const ROUTES: Record<AgentRunsDirectChannel, RouteEntry> = {
  "op:runs:list": { invoke: (p, d) => invokeRunsList(p, d) },
  "op:runs:get": { invoke: (p, d) => invokeRunsGet(p, d) },
  "op:runs:cancel": { invoke: (p, d) => invokeRunsCancel(p, d) },
  "op:runs:rollback": { invoke: (p, d) => invokeRunsRollback(p, d) },
  "op:runs:step": { invoke: (p, d) => invokeRunsStep(p, d) },
  "op:runs:artifacts:publish": { invoke: (p, d) => invokeArtifactPublish(p, d) },
  "op:runs:artifacts:accept": { invoke: (p, d) => invokeArtifactAccept(p, d) },
  "op:runs:acceptance": { invoke: (p, d) => invokeRunsAcceptance(p, d) },
  "op:runs:diff": { invoke: (p, d) => invokeRunsDiff(p, d) },
  "op:artifacts:list": { invoke: (p, d) => invokeArtifactsList(p, d) },
  "op:artifacts:rollback": { invoke: (p, d) => invokeArtifactRollback(p, d) },
};

/**
 * 运行族通道直调分发：channel → 逐通道转录的 sidecar 路由语义。
 * 未知通道不进入本分发（注册面只登记 AGENT_RUNS_DIRECT_CHANNELS 清单）；
 * 处理器抛出的意外错误统一 500（对齐 http-forward 网络失败兜底形态）。
 */
export async function invokeAgentRunsDirect(
  channel: AgentRunsDirectChannel,
  envelope: InvokeEnvelope | undefined,
  deps: AgentRunsDirectDeps
): Promise<InvokeResult<unknown>> {
  const payload: InvokeEnvelope = envelope ?? {};
  const resolved: ResolvedDeps = { agentKeyOf: agentKey, ...deps };
  const route = ROUTES[channel];
  if (!route) return fail(404, { error: `unknown channel: ${channel}` });
  try {
    return await route.invoke(payload, resolved);
  } catch (error) {
    return fail(500, { error: error instanceof Error ? error.message : String(error) });
  }
}
