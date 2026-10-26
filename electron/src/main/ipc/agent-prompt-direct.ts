/**
 * A 层主链通道直调器（S3-3，迁移期过渡形态）：prompt/abort/answer/compact/new/resume/
 * session-tree/session-branch + runs resume/retry 共 10 条 sidecar 路由编排 → TS 域服务
 * 进程内直调。至此 S3 三批收口：会话族（S3-1）→ 运行族（S3-2）→ prompt 主链（本批）。
 *
 * 旧路径：渲染层 invoke → http-forward 转发 sidecar HTTP（/api/agent/*、/api/runs/:id/(resume|retry)）。
 * 本模块把路由编排逐点转录为主进程内直调，消费面：
 *   - TS AgentManager 单飞（backend/agent/assembly）：ensureRuntime/setModel/
 *     promptWithContext/runtimeSnapshot/runtimeHealth/abort/compact/submitAnswer/
 *     newThread/resumeThread/getOrCreate/sessionTree/branchSession/sessions；
 *   - runs 域（backend/runs.ts，B2-2）：beginRun/getRun/listRuns/finishRun/
 *     requestRunCancellation/recordRunEvent/snapshotWorkspace/filterRunChanges；
 *   - 会话文件域（backend/agent/session-files.ts）：findSessionFile/readSessionHeader/
 *     updateSessionHeader/annotateSessionThread；
 *   - skills/workflows 域（backend/agent/skills-catalog.ts / workflows.ts，本批转录）：
 *     scanSkills/preflightSkills/getWorkflow/workflowIdFromText；
 *   - 写探针域（backend/workspace-write-probe.ts，本批转录）：
 *     requireWorkspaceWriteForTask；
 *   - staging/产物域（write-coordination.ts / artifact-verification.ts）：
 *     stageWrite/listStagedFilesForValidation/validateArtifacts/validateArtifactFile；
 *   - officecli（backend/office.ts，S3-4 起 TS 直绑动态 import）。
 *
 * 进程内 emitChannel（server/index.mjs L5828-5853 转录，与 agent.mjs emitChannelSafe
 * 的差异）：workspace 富化仅限 agent_summary/run_finished；除 capability_plan/run_finished
 * 外全部 appendEvent 进根级事件流（capability_plan/run_finished 已由 recordRunEvent/
 * finishRun 落 Store）；run_finished 结算首字延迟样本。通道事件经 entry.channel.emitter
 * 由 S1 直推桥送渲染层——S1/S3-3 双 flag 同开时对话流全链路进程内闭环。
 *
 * 运行实例归属（S3 收口后语义）：本批通道全部消费 TS AgentManager 单飞的 live 态
 * （busy/activeRunId/queuedCount/pendingCompletion），与 S2/S3-2 直调通道同键空间
 * （agentKey）；sidecar 旧 agentManager 继续服务 legacy-client（F 线收尾前共存）。
 *
 * 门控：OP_DESKTOP_AGENT_PROMPT_DIRECT 且 OP_DESKTOP_AGENT_DOMAIN 双门控（S4 起默认开，
 * =0 显式回滚——流量切换评估方案 §4-S4）。本模块不 import electron（纯逻辑，vitest 可直接测）；
 * 注册入口在 main/index.ts。路由语义锚点：server/index.mjs L3899-4000 / L4194-4503 /
 * L4513-4724 / L5818-5853。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ChannelFailureData, InvokeEnvelope, InvokeResult } from "../../shared/protocol/channels";
import { CHANNEL_HISTORY_LIMIT, PROTOCOL_VERSION, pushChannelEvent } from "../../shared/runtime/event-protocol";
import { attachRunTimingMeta, attachRunTimingSpans, finishRunTiming, markRunTiming } from "../../shared/runtime/first-token-latency";
import { inferCompletion } from "../../shared/runtime/run-trace";
import { createTaskEnvelope, normalizeTaskMode, planTaskCapabilities } from "../../shared/runtime/task";
import { getWorkflow, workflowIdFromText } from "../backend/agent/workflows";
import { agentKey } from "../backend/agent/agent-key";
import { classifyAgentError, isAbortLikeError, isProviderTruncation } from "../backend/agent/agent-errors";
import { workspaceWriteHttpStatus } from "../backend/file-permission-error";

const RUNTIME_INIT_TIMEOUT_MS = 45_000;

// 主链工作区快照（server/index.mjs L5785-5813 转录）：返回 "relpath|mtime|size"
// 行数组供 diffWorkspace/waitForFlush 消费。注意与 backend/runs.ts 的对象形态
// snapshotWorkspace（迁移自 server/runs.mjs，供 Run 存档/before-blob）不是同一函数。
const SNAPSHOT_SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "__pycache__", ".venv", ".oaw", ".cache", "coverage", ".next", ".idea", ".vscode"]);
const SNAPSHOT_SKIP_EXT = /\.(tmp|temp|swp|swo|bak|log|lock|part|crdownload|msi|exe|dll|pyc)$/i;
const SNAPSHOT_MAX_FILES = 30000;
const SNAPSHOT_MAX_DEPTH = 10;

/** 递归快照工作区内的文件（目录 mtime 会在任何写入时变化，不能当作产物）。 */
export function walkWorkspaceSnapshot(dir: string, root: string, depth = 0, count = { n: 0 }): string[] {
  const out: string[] = [];
  if (depth > SNAPSHOT_MAX_DEPTH || count.n >= SNAPSHOT_MAX_FILES) return out;
  let items: fs.Dirent[] = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of items) {
    if (count.n >= SNAPSHOT_MAX_FILES) break;
    if (e.name.startsWith(".") || e.name.startsWith("~$")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SNAPSHOT_SKIP_DIRS.has(e.name)) continue;
      out.push(...walkWorkspaceSnapshot(p, root, depth + 1, count));
    } else {
      if (SNAPSHOT_SKIP_EXT.test(e.name)) continue;
      try {
        const st = fs.statSync(p);
        out.push(`${path.relative(root, p).replace(/\\/g, "/")}|${st.mtimeMs}|${st.size}`);
        count.n += 1;
      } catch { /* 与 server 同款静默 */ }
    }
  }
  return out;
}

/** 主链快照入口（server/index.mjs L5780-5783 同构，供 deps.snapshotWorkspace 组装）。 */
export function snapshotWorkspace(root: string): string[] {
  return walkWorkspaceSnapshot(path.resolve(root), path.resolve(root));
}

/** TS AgentManager 直调消费面（本批 10 通道用到的完整方法视图）。 */
export interface AgentPromptManagerView {
  sessions?: Map<any, any>;
  ensureRuntime(key: unknown, options: any): Promise<any>;
  setModel(key: unknown, spec: unknown): Promise<any>;
  runtimeSnapshot(key: unknown, overrides: any): any;
  runtimeHealth(key: unknown): any;
  promptWithContext(key: unknown, text: unknown, images?: any[], effort?: unknown, references?: any[], runContext?: any): Promise<any>;
  resolveLiveEntry(key: unknown): any;
  abort(key: unknown, options?: any): Promise<any>;
  compact(key: unknown, instructions?: unknown): Promise<any>;
  submitAnswer(key: unknown, answer: unknown): any;
  newThread(key: unknown, threadId: unknown, cwd: unknown): Promise<any>;
  resumeThread(key: unknown, threadId: unknown, sessionPath: unknown, cwd: unknown): Promise<any>;
  getOrCreate(key: unknown, options: any): Promise<any>;
  sessionTree(key: unknown): Promise<any>;
  branchSession(key: unknown, entryId: unknown, options: any): Promise<any>;
}

export interface AgentPromptDirectDeps {
  /** TS AgentManager 单飞（生产传 assembly.getAgentManager；测试注入桩） */
  getManager: () => Promise<AgentPromptManagerView>;
  /** 会话键（默认 backend/agent/agent-key 转录，server L1387-1391） */
  agentKeyOf?: (client: unknown, thread: unknown) => string;
  /** workspace 域（backend/workspace.ts） */
  getWorkspace: () => string;
  normalizeWorkspace: (dir: unknown) => string | null;
  safeName: (name: unknown) => string | null;
  /** project 域（backend/project-management.ts） */
  getProjectForWorkspace: (root: unknown) => any;
  getProject: (id: unknown) => any;
  defaultProjectSettings: () => any;
  /** 会话文件域（backend/agent/session-files.ts） */
  findSessionFile: (id: unknown) => any;
  readSessionHeader: (found: any) => any;
  updateSessionHeader: (id: unknown, patch: any) => any;
  annotateSessionThread: (sessionId: unknown, threadId: unknown) => void;
  /** skills 域（backend/agent/skills-catalog.ts，本批转录） */
  scanSkills: () => any[];
  preflightSkills: (opts: Record<string, unknown>) => any;
  /** 引用域（backend/agent/context.ts） */
  resolveReferences: (references: unknown, text: string, workspace: string) => any[];
  /** 写探针域（backend/workspace-write-probe.ts，本批转录） */
  requireWorkspaceWriteForTask: (plan: any, workspace: string) => any;
  /** officecli 预检（默认 backend/office.ts 动态 import，S3-4 起 TS 直绑） */
  checkOfficecli?: () => Promise<any>;
  /** runs 域（backend/runs.ts，B2-2） */
  beginRun: (input: any) => any;
  getRun: (id: unknown) => any;
  listRuns: (opts: Record<string, any>) => any[];
  finishRun: (id: string, patch: Record<string, any>) => any;
  requestRunCancellation: (id: unknown, reason: unknown) => unknown;
  recordRunEvent: (id: unknown, type: string, data: unknown) => void;
  snapshotWorkspace: (root: string) => string[];
  filterRunChanges: (run: any, changes: unknown) => any[];
  /** staging/产物域（write-coordination.ts / artifact-verification.ts） */
  validateArtifacts: (paths: unknown[], root?: string) => any[];
  validateArtifactFile: (file: string, root?: string, relativePath?: string) => any;
  listStagedFilesForValidation: (runId: string) => any[];
  stageWrite: (opts: Record<string, unknown>) => any;
  /** 其他 Run 暂存清单扫描根（生产传 runs.runsDir()，OAW_RUNS_DIR 同锚点） */
  stagedRunsRoot: () => string;
  /** 根级事件流（backend/event-storage.ts，B2-4 文件族共享态） */
  appendEvent: (evt: Record<string, unknown>) => unknown;
  /** 诊断日志路径（默认 TEMP/open-plan-agent连接诊断.log，server AGENT_DIAGNOSTIC_LOG） */
  diagnosticLogPath?: () => string;
}

/** 主链直调 invoke 通道清单（S3 三批收口批）。 */
export const AGENT_PROMPT_DIRECT_CHANNELS = [
  "op:agent:prompt",
  "op:agent:abort",
  "op:agent:answer",
  "op:agent:compact",
  "op:agent:new",
  "op:agent:resume",
  "op:agent:session-tree",
  "op:agent:session-branch",
  "op:runs:resume",
  "op:runs:retry"
] as const;

export type AgentPromptDirectChannel = (typeof AGENT_PROMPT_DIRECT_CHANNELS)[number];

interface ResolvedDeps extends AgentPromptDirectDeps {
  agentKeyOf: (client: unknown, thread: unknown) => string;
  checkOfficecli: () => Promise<any>;
}

const AGENT_DIAGNOSTIC_LOG_NAME = "open-plan-agent连接诊断.log";

function defaultDiagnosticLogPath(): string {
  return path.join(process.env.TEMP || "", AGENT_DIAGNOSTIC_LOG_NAME);
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

// ---------- 编排层内联助手（server/index.mjs 逐行转录） ----------

/** ensureRuntime 超时包装（server/index.mjs L91-107；后台创建继续）。 */
async function ensureRuntimeWithTimeout(manager: AgentPromptManagerView, key: unknown, options: Record<string, unknown>): Promise<any> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const operation = manager.ensureRuntime(key, options);
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`会话运行时初始化超过 ${Math.round(RUNTIME_INIT_TIMEOUT_MS / 1000)} 秒未完成，已自动取消等待；可重试或检查模型配置与网络`);
      (error as Error & { code?: string; retryable?: boolean }).code = "RUNTIME_INIT_TIMEOUT";
      (error as Error & { code?: string; retryable?: boolean }).retryable = true;
      reject(error);
    }, RUNTIME_INIT_TIMEOUT_MS);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** recordAgentDiagnostic（server/index.mjs L118-137；req → requestId 参数）。 */
function recordAgentDiagnostic(requestId: unknown, details: Record<string, any>, deps: ResolvedDeps): Record<string, unknown> {
  const info = details.error ? classifyAgentError(details.error) : details;
  const record = {
    time: new Date().toISOString(),
    requestId: requestId || null,
    clientId: details.client || null,
    threadId: details.thread || null,
    runId: details.runId || null,
    model: details.model || null,
    providerStatus: info.status ?? null,
    errorCode: info.code ?? null,
    errorCategory: info.category ?? null,
    causeCode: info.causeCode ?? null,
    retryable: Boolean(info.retryable),
    message: info.message || "模型连接失败"
  };
  try { fs.appendFileSync(deps.diagnosticLogPath?.() ?? defaultDiagnosticLogPath(), `${JSON.stringify(record)}\n`, "utf8"); } catch { /* 诊断落盘失败不阻断主流程 */ }
  console.error("[agent] prompt failed", record);
  return record;
}

/** 暂存产物校验（server/index.mjs L112-114）。 */
function validateStagedArtifacts(runId: string, deps: ResolvedDeps): any[] {
  return deps.listStagedFilesForValidation(runId).map((item) => deps.validateArtifactFile(item.file, item.root, item.path));
}

/** 快照差分（server/index.mjs L5814-5817）。 */
function diffWorkspace(before: string[], after: string[]): string[] {
  const b = new Set(before);
  return after.filter((x) => !b.has(x)).map((x) => x.split("|")[0]!);
}

/** officecli 常驻进程落盘刷写等待（server/index.mjs L5818-5827）。 */
async function waitForFlush(before: string[], workspace: string, deps: ResolvedDeps): Promise<string[]> {
  let last = before;
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const snap = deps.snapshotWorkspace(workspace);
    if (JSON.stringify(snap) === JSON.stringify(last)) break;
    last = snap;
  }
  return diffWorkspace(before, last);
}

/**
 * HTTP 层通道事件投递（server/index.mjs L5828-5853 逐行转录）。
 * 与 agent.mjs emitChannelSafe 的差异：workspace 富化仅限 agent_summary/run_finished、
 * 根级事件流 appendEvent（capability_plan/run_finished 除外——已由 recordRunEvent/
 * finishRun 落 Store）、run_finished 结算首字延迟样本。
 */
function emitChannel(entry: any, type: string, data: any, deps: ResolvedDeps): void {
  const id = ++entry.channel.seq;
  const at = new Date().toISOString();
  const workspace = ["agent_summary", "run_finished"].includes(type)
    ? { workspace: data?.workspace ?? entry.workspace ?? null }
    : {};
  const eventData = data && typeof data === "object" && !Array.isArray(data)
    ? { ...data, ...workspace, runId: data.runId ?? entry.activeRunId ?? null }
    : { value: data, ...workspace, runId: entry.activeRunId ?? null };
  const ev = { id, type, at, streamId: entry.channel.streamId || null, protocolVersion: PROTOCOL_VERSION, data: eventData };
  // 与 agent.mjs 的受保护写入一致：高频事件不挤掉工具边界与终态
  if (!entry.channel.historyLimit) entry.channel.historyLimit = CHANNEL_HISTORY_LIMIT;
  pushChannelEvent(entry.channel, ev);
  entry.channel.emitter.emit("event", ev);
  // capability_plan/run_finished 已由 recordRunEvent/finishRun 写入 Store，
  // 其余由 HTTP 层补发的摘要/错误/文件事件在这里进入根级事件流。
  if (!["capability_plan", "run_finished"].includes(type)) {
    deps.appendEvent({ clientId: entry.clientId, threadId: entry.threadId, runId: eventData.runId, type, data: eventData });
  }
  // run_finished 是所有终态路径的收口：在这里结算首字延迟样本，
  // 避免每条失败/取消/成功分支各结算一次或漏结算。
  // 模型与模式已在 beginRun 处通过 attachRunTimingMeta 登记，这里不重复推断。
  if (type === "run_finished" && eventData.runId) {
    finishRunTiming(eventData.runId);
  }
}

/** Run 权威终稿（server/index.mjs L4043-4051）。 */
function getRunFinalText(run: any): string {
  if (run && String(run.finalText || "").trim()) return String(run.finalText);
  return [...(run?.events || [])]
    .reverse()
    .find((item: any) => item?.type === "assistant_final" && String(item?.data?.text || "").trim())
    ?.data?.text || "";
}

/** 其他 run 的暂存清单路径（server/index.mjs L4054-4071；产物统计时排除）。 */
function otherRunsStagedPaths(currentRunId: string, deps: ResolvedDeps): Set<string> {
  const paths = new Set<string>();
  const runsRoot = deps.stagedRunsRoot();
  let names: string[] = [];
  try { names = fs.readdirSync(runsRoot); } catch { return paths; }
  for (const name of names) {
    if (name === currentRunId) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(runsRoot, name, "写入清单.json"), "utf8"));
      if (Array.isArray(manifest.files)) {
        for (const entry of manifest.files) {
          if (typeof entry?.path === "string") paths.add(entry.path.replace(/\\/g, "/"));
        }
      }
    } catch { /* server 同款静默 */ }
  }
  return paths;
}

/** 完成语义（server/index.mjs L4075-4080）：显式 complete_task 优先，否则推断。 */
function resolveRunCompletion(entry: any, runStatus: string, { artifacts = 0, validations = [], runId = null }: { artifacts?: number; validations?: any[]; runId?: string | null } = {}): any {
  const pending = entry?.pendingCompletion && typeof entry.pendingCompletion === "object" ? entry.pendingCompletion : null;
  // 完成声明必须属于当前 Run：同一会话上一轮的声明不能串到本轮（否则会误报 success）。
  const explicit = pending && (!runId || !pending.runId || pending.runId === runId) ? pending : null;
  return explicit || inferCompletion({ runStatus, artifacts, validations });
}

// ---------- 后台 Run 执行（server/index.mjs L4082-4192 逐行转录） ----------

async function executeAgentRun(
  { entry, key, client, thread, normalizedText, images, effort, resolved, task, workflow, run, before, runWorkspace, effectiveModel, capabilityPlan, preflight, requestId, admissionReadyAt = 0 }:
  Record<string, any>,
  deps: ResolvedDeps
): Promise<void> {
  const manager = await deps.getManager();
  const tracksWorkspace = run?.snapshotMode !== "none";
  try {
    await manager.promptWithContext(key, normalizedText, images, effort, resolved, { runId: run.id, task, workflow, admissionReadyAt: Number(admissionReadyAt) || 0 });
  } catch (e: any) {
    const currentModel = entry?.session?.model;
    const diagnostic = recordAgentDiagnostic(requestId, {
      client,
      thread,
      runId: run?.id || null,
      model: effectiveModel || (currentModel?.provider && currentModel?.id ? `${currentModel.provider}/${currentModel.id}` : null),
      error: e,
    }, deps);
    // 与发送路由同一条规矩：用户主动中断时 SDK 会以 "Request aborted" 拒绝这次 prompt，
    // 这不是模型/运行时故障——不发 agent_error、不写 runtime_error
    //（写了会把 Run 标成"需要恢复"、把 Runtime 标成 failed）。
    const cancelRequestedHere = deps.getRun(run.id)?.status === "cancel_requested"
      || Boolean(entry?.cancelRequested)
      || Boolean(entry?.abortRequestedAt && Date.now() - entry.abortRequestedAt < 120000);
    const userAborted = cancelRequestedHere && isAbortLikeError(diagnostic.message);
    if (entry && userAborted) {
      emitChannel(entry, "aborted", { runId: run?.id || null, reason: "用户请求中断" }, deps);
    } else if (entry) {
      emitChannel(entry, "agent_error", { message: diagnostic.message, code: diagnostic.errorCode || e?.code || null, category: diagnostic.errorCategory || null, providerStatus: diagnostic.providerStatus || null, runId: run?.id || null, requestId, retryable: diagnostic.retryable }, deps);
    }
    // 失败前已生成的权威文本也写入 run 记录，供前端断线兜底渲染
    if (run && entry?.lastFinalText) deps.recordRunEvent(run.id, "assistant_final", { text: entry.lastFinalText });
    // 出错也检测产物（agent 可能已部分写入文件）
    const stagedElsewhere = otherRunsStagedPaths(run?.id || "", deps);
    const changed = deps.filterRunChanges(run, (tracksWorkspace ? await waitForFlush(before, runWorkspace, deps) : [])
      .filter((p: string) => !stagedElsewhere.has(String(p).replace(/\\/g, "/"))));
    const validations = deps.validateArtifacts(changed, runWorkspace);
    const stagedValidations = run ? validateStagedArtifacts(run.id, deps) : [];
    if (changed.length && entry) {
      emitChannel(entry, "file_changed", { files: changed, runId: run?.id || null }, deps);
      emitChannel(entry, "agent_summary", {
        products: changed,
        // A02-3：总结正文只给数量，文件清单走 products/artifacts，不再把全部文件名塞进正文
        summary: `对话异常结束，仍处理了 ${changed.length} 个文件`,
        runId: run?.id || null,
        artifacts: [],
      }, deps);
    }
    const runtimeHealth = entry ? manager.runtimeHealth(key) : null;
    // 供应商流截断（未返回 finish_reason）：既不是用户中断，也不该按"模型调用失败"处理——
    // 关键看这一轮有没有客观产出（文件改动 / 暂存产物 / 模型最终文本）。
    const truncatedRecoverable = !userAborted
      && isProviderTruncation(diagnostic.message)
      && (Boolean(entry?.lastFinalText) || changed.length > 0 || stagedValidations.length > 0);
    if (runtimeHealth && !userAborted && !truncatedRecoverable) deps.recordRunEvent(run.id, "runtime_error", { code: diagnostic.errorCode || e?.code || null, message: diagnostic.message, runtime: runtimeHealth });
    const cancelled = userAborted || deps.getRun(run.id)?.status === "cancel_requested";
    // 供应商流截断但活已经干完：按「部分完成」收尾而不是「本轮失败」——
    // 判定必须看客观产物（有改动或有过校验通过）与模型的最终文本，而不是只看调用是否干净收尾。
    const truncationCompletion = truncatedRecoverable
      ? {
        status: "partial",
        source: "inferred",
        summary: `${entry?.lastFinalText ? String(entry.lastFinalText).slice(0, 4000) : run?.task?.goal || "本轮产物已产出"}\n\n⚠ 模型流被供应商截断（未返回 finish_reason，已自动重试并继续），产物已产出并通过校验，请按结果核对。`,
        incomplete: [],
        blockers: [],
        verification: null,
        verificationStatus: "not_checked",
      }
      : null;
    const failureCompletion = truncationCompletion || resolveRunCompletion(entry, cancelled ? "cancelled" : "failed", { artifacts: changed.length, validations: [...validations, ...stagedValidations], runId: run.id });
    const failed = deps.finishRun(run.id, {
      status: cancelled ? "cancelled" : (truncatedRecoverable ? "completed" : "failed"),
      sessionId: entry?.session?.sessionId || null,
      error: cancelled ? "用户请求取消" : (truncatedRecoverable ? "模型流被供应商截断（产物已产出）" : e.message),
      summary: cancelled ? "任务已中断" : (truncatedRecoverable ? "部分完成（模型流被截断）" : "Agent 执行失败"),
      validations: [...validations, ...stagedValidations],
      completion: failureCompletion,
    });
    if (entry) emitChannel(entry, "run_finished", { runId: run.id, task, artifacts: failed?.artifacts || [], references: resolved, reviewSources: entry.reviewSources || [], status: failed?.status || (cancelled ? "cancelled" : "failed"), verificationStatus: failed?.verificationStatus || "not_checked", completion: failed?.completion || failureCompletion, finalText: getRunFinalText(deps.getRun(run.id)), model: deps.getRun(run.id)?.model || null, finalMessageId: deps.getRun(run.id)?.finalMessageId || null }, deps);
    return;
  }

  // officecli keeps files in a resident process — disk writes flush asynchronously.
  // Poll until the workspace snapshot stabilizes, then diff.
  // 把最终权威文本写入 run 记录（assistant_final），前端 run_finished 用它兜底渲染
  if (run && entry?.lastFinalText) deps.recordRunEvent(run.id, "assistant_final", { text: entry.lastFinalText });
  const stagedElsewhere = otherRunsStagedPaths(run?.id || "", deps);
  const changed = deps.filterRunChanges(run, (tracksWorkspace ? await waitForFlush(before, runWorkspace, deps) : [])
    .filter((p: string) => !stagedElsewhere.has(String(p).replace(/\\/g, "/"))));
  const validations = deps.validateArtifacts(changed, runWorkspace);
  const stagedValidations = run ? validateStagedArtifacts(run.id, deps) : [];
  const allValidations = [...validations, ...stagedValidations];
  const publishableStagedValidations = stagedValidations.filter((item: any) => item.status !== "failed");
  const verificationNote = allValidations.some((item: any) => item.status === "failed") ? "，但产物校验发现问题" : allValidations.some((item: any) => item.status === "warning") ? "，产物校验有提示" : "";
  const cancelled = run && deps.getRun(run.id)?.status === "cancel_requested";
  const finalStatus = cancelled ? "cancelled" : "completed";
  const publishPaths = publishableStagedValidations.map((item: any) => item.path).filter(Boolean);
  const publishedCount = changed.length + publishableStagedValidations.length;
  const completed = run ? deps.finishRun(run.id, { status: finalStatus, sessionId: entry?.session?.sessionId || null, summary: cancelled ? "任务已取消" : (publishedCount ? `本轮对话完成，共处理 ${publishedCount} 个文件${verificationNote}` : "本轮对话完成，未检测到文件变更"), validations: allValidations, publishPaths: run ? publishPaths : null, completion: resolveRunCompletion(entry, finalStatus, { artifacts: publishedCount, validations: allValidations }) }) : null;
  if (entry) {
    const productPaths = [...changed, ...publishableStagedValidations.map((item: any) => item.path).filter(Boolean)];
    if (productPaths.length) emitChannel(entry, "file_changed", { files: productPaths, runId: run?.id || null }, deps);
    // 终态总结必须无条件发出：没有文件变更的轮次也要有结果卡（总结 + 本轮过程行），
    // 否则对话看起来“没有总结、折叠过程也没做完”。文案与 run 记录里的 summary 保持一致。
    emitChannel(entry, "agent_summary", {
      products: productPaths,
      // A02-3：正文只保留数量，文件清单走 products/artifacts
      summary: completed?.summary || (cancelled ? "任务已取消" : (publishedCount ? `本轮对话完成，共处理 ${publishedCount} 个文件${verificationNote}` : "本轮对话完成，未检测到文件变更")),
      runId: run?.id || null,
      artifacts: completed?.artifacts || [],
      references: resolved,
      status: completed?.status || finalStatus,
    }, deps);
    if (run) emitChannel(entry, "run_finished", { runId: run.id, task, artifacts: completed?.artifacts || [], references: resolved, reviewSources: entry.reviewSources || [], status: completed?.status || finalStatus, verificationStatus: completed?.verificationStatus || "not_checked", completion: completed?.completion || resolveRunCompletion(entry, finalStatus, { artifacts: publishedCount, validations: allValidations }), finalText: getRunFinalText(deps.getRun(run.id)), model: deps.getRun(run.id)?.model || null, finalMessageId: deps.getRun(run.id)?.finalMessageId || null }, deps);
  }
}

// ---------- POST /api/agent/prompt（server/index.mjs L4194-4503 逐行转录） ----------

async function invokeAgentPrompt(payload: InvokeEnvelope, deps: ResolvedDeps, requestId: string): Promise<InvokeResult<unknown>> {
  const manager = await deps.getManager();
  const admissionStartedAt = new Date().toISOString();
  // 首字延迟分项（方案 §3.5）：服务端收到请求的时刻。runId 要到 beginRun 才有，
  // 因此先在请求作用域内取时间戳，admission 就绪后再连同 runId 一起登记。
  const serverReceivedAt = Date.now();
  const body = bodyOf(payload);
  const { client, thread, text, images, attachments, references, effort, model: requestedModel, task: taskInput } = body as Record<string, any>;
  const hasImages = Array.isArray(images) && images.some((img: any) => img?.data);
  const hasAttachments = Array.isArray(attachments) && attachments.some((att: any) => att?.data);
  if (!client || (!String(text || "").trim() && !hasImages && !hasAttachments)) {
    return fail(400, { error: "text, image, or attachment required" });
  }
  const normalizedText = String(text || "").trim() || (hasImages ? "[图片消息]" : "[附件消息]");
  const key = deps.agentKeyOf(client, thread);
  const requestedWorkspace = deps.normalizeWorkspace(taskInput?.workspace || taskInput?.cwd || deps.getWorkspace()) || deps.getWorkspace();
  // 准入阶段的细分计时：粗分项只说"准入慢"，这里回答"慢在等什么"（运行时/写探针/快照/写记录）。
  const admissionSpans: Record<string, number> = {};
  const timed = async (name: string, fn: () => any) => {
    const started = Date.now();
    try { return await fn(); } finally { admissionSpans[name] = Date.now() - started; }
  };
  const initialWritePlan = planTaskCapabilities({ text: normalizedText, task: taskInput || {}, attachments });
  let writeAccessPreflight: any = null;
  try {
    writeAccessPreflight = await timed("writeProbe", async () => deps.requireWorkspaceWriteForTask(initialWritePlan, requestedWorkspace));
  } catch (error: any) {
    return fail(workspaceWriteHttpStatus(error), {
      error: error.message,
      code: error.code || "WORKSPACE_WRITE_UNAVAILABLE",
      writeAccess: error.writeAccess || null,
      requestId,
    });
  }
  const initialProject = deps.getProjectForWorkspace(requestedWorkspace);
  const initialProjectSettings = initialProject?.settings || deps.defaultProjectSettings();
  const initialModel = String(requestedModel || initialProjectSettings.defaultModel || "").trim();
  let entry: any;
  try {
    entry = await timed("ensureRuntime", () => ensureRuntimeWithTimeout(manager, key, { threadId: thread, cwd: requestedWorkspace, modelSpec: initialModel }));
  } catch (e: any) {
    const diagnostic = recordAgentDiagnostic(requestId, { client, thread, error: e }, deps);
    return fail(500, { error: diagnostic.message, requestId, retryable: diagnostic.retryable });
  }
  emitChannel(entry, "run_admitting", { requestId, startedAt: admissionStartedAt }, deps);
  const runWorkspace = entry.workspace || requestedWorkspace;
  const project = deps.getProjectForWorkspace(runWorkspace) || initialProject;
  const projectSettings = project?.settings || initialProjectSettings;
  // ensureRuntime 可能刚刚从失效 provider 恢复到 Pi 全局默认模型；本轮沿用恢复后的模型，
  // 避免下面的 setModel 又把会话切回刚刚失败的旧模型。
  const effectiveModel = String(entry.modelFallbackSpec || requestedModel || projectSettings.defaultModel || "").trim();
  const sessionHeader = deps.readSessionHeader(deps.findSessionFile(entry.session?.sessionId || ""));
  if (sessionHeader.frozen) {
    return fail(409, { error: "当前会话已冻结，请先解冻后再继续执行", code: "SESSION_FROZEN", sessionId: entry.session?.sessionId || null });
  }
  const projectSkills = Array.isArray(projectSettings.skills) ? projectSettings.skills : [];
  if (effectiveModel) {
    try {
      const current = entry.session?.model;
      const currentSpec = current?.provider && current?.id ? `${current.provider}/${current.id}` : "";
      // ChatPanel 每次发送都会带当前模型；同模型无需再次 setModel，避免重复
      // 触发 Pi 的 provider/model 初始化，把首字节延迟叠加到每一轮。
      if (currentSpec !== effectiveModel) await manager.setModel(key, effectiveModel);
    } catch (e: any) {
      const diagnostic = recordAgentDiagnostic(requestId, { client, thread, model: effectiveModel, error: e }, deps);
      return fail(409, { error: `模型同步失败：${diagnostic.message}`, requestId, retryable: diagnostic.retryable });
    }
  }
  // 插话（steer）：会话正在执行时，新消息并入当前 Run，不再新建。
  // 早先每次插话都 beginRun 出一条新 Run：同一会话会同时出现两条"执行中"，
  // 会话列表与任务中心互相矛盾，而且真正执行的回合结束后插话 Run 仍留在 running
  // （用户反馈的"会话之间切换混乱"）。
  const steeringRun = entry.busy && entry.activeRunId ? deps.getRun(entry.activeRunId) : null;
  let before: string[] = [];
  let run: any = null;
  let resolved: any[] = [];
  let task: any = null;
  let capabilityPlan: any = null;
  let preflight: any = null;
  try {
    resolved = await timed("resolveReferences", async () => deps.resolveReferences(references, normalizedText, runWorkspace));
    const requestedMode = normalizeTaskMode(taskInput?.mode);
    const workflowId = requestedMode === "chat" ? null : (taskInput?.workflowId || workflowIdFromText(normalizedText));
    const mentionedSkills = [...normalizedText.matchAll(/@技能\[([^\]]+)\]/g)].map((match) => match[1]?.trim()).filter(Boolean) as string[];
    // Chat 允许搜索/阅读 Skills，但不把项目默认 Skills 作为执行依赖，避免只读问答
    // 因历史配置缺失而被 Agent 预检拦截。
    const requestedSkills = requestedMode === "chat"
      ? []
      : [...new Set([...projectSkills, ...(Array.isArray(taskInput?.skills) ? taskInput.skills : []), ...mentionedSkills])];
    // 普通 Agent 问答不需要在 admission 阶段扫描所有 SKILL.md；只有显式工作流/技能
    // 依赖才加载技能目录，避免首次对话把本地扫描延迟叠加到模型首事件之前。
    const skills = (workflowId || requestedSkills.length) ? await timed("scanSkills", async () => deps.scanSkills()) : [];
    const workflow = workflowId ? getWorkflow(workflowId, skills) : null;
    preflight = requestedMode === "chat"
      ? { ok: true, workflow: null, required: [], checks: [], missing: [], message: "Chat 不执行 Skills 依赖预检" }
      : deps.preflightSkills({ workflowId, requestedSkills, skills });
    const effectiveTaskInput: Record<string, any> = {
      ...(taskInput || {}),
      projectId: project?.id || taskInput?.projectId || null,
      agentProfile: projectSettings.agentProfile,
      projectSettings,
      profilePolicy: projectSettings.profilePolicy,
      skills: requestedSkills,
      workflowId,
    };
    capabilityPlan = planTaskCapabilities({ text: normalizedText, task: effectiveTaskInput, references: resolved, attachments });
    if (writeAccessPreflight) capabilityPlan.workspaceWrite = writeAccessPreflight;
    if (capabilityPlan.routing.officecli === "preferred") {
      capabilityPlan.officecli = await timed("officecliPrecheck", () => deps.checkOfficecli());
      if (!capabilityPlan.officecli.available) {
        const error = new Error(`Office CLI 预检失败：${capabilityPlan.officecli.message}`) as Error & { code?: string };
        error.code = "OFFICE_PREFLIGHT_FAILED";
        throw error;
      }
    } else if (capabilityPlan.routing.officecli === "lazy") {
      // §5.3：生成类任务不被预检阻塞——预检转后台惰性执行；真正需要 CLI 的高级操作
      // 由 officeTool 内部兜底，失败时照常发 officecli_failed。
      capabilityPlan.officecli = { available: null, deferred: true, message: "生成类任务：原生直写优先，Office CLI 预检延后" };
      void deps.checkOfficecli().then((info: any) => { capabilityPlan.officecli = info; }).catch(() => {});
    }
    if ((workflowId || requestedSkills.length) && !preflight.ok) {
      const error = new Error(preflight.message) as Error & { code?: string };
      error.code = "SKILL_PREFLIGHT_FAILED";
      throw error;
    }
    task = createTaskEnvelope({
      ...effectiveTaskInput,
      text: normalizedText,
      threadId: thread || null,
      currentFile: taskInput?.currentFile || null,
      references: resolved,
      workflowId,
      capabilityPlan,
      constraints: [
        ...(taskInput?.constraints || []),
        ...(workflow && !workflow.valid ? [`工作流缺少技能：${workflow.missing.join(", ")}`] : []),
      ],
    });
    // Chat 没有上传文件时是严格只读模式，不需要为每轮问答扫描工作区。
    // 用户明确上传的附件需要在成功后发布为可追溯文件，因此保留完整快照。
    const tracksWorkspace = task.mode !== "chat" || Boolean(attachments?.length);
    // 插话沿用当前 Run 的"运行前快照"：整个回合（含插话）的改动要在同一个窗口里比对。
    before = steeringRun ? (steeringRun.before || []) : (tracksWorkspace ? await timed("snapshot", async () => deps.snapshotWorkspace(runWorkspace)) : []);
    const runtimeSnapshot = manager.runtimeSnapshot(key, {
      profile: task.agentProfile,
      taskMode: task.mode,
      capabilityPlanVersion: capabilityPlan?.version || null,
    });
    run = steeringRun || await timed("beginRun", async () => deps.beginRun({
      clientId: client,
      threadId: thread || null,
      sessionId: entry.session?.sessionId || null,
      cwd: runWorkspace,
      task,
      references: resolved,
      workflow,
      projectId: project?.id || null,
      capabilityPlan,
      runtimeSnapshot,
      snapshotMode: tracksWorkspace ? "full" : "none",
      beforeSnapshot: tracksWorkspace ? before : null,
      // 本轮实际使用的模型（含刚恢复的备用模型）：会话里按轮显示模型与切换分割线都靠它。
      model: effectiveModel || null,
    }));
    // admission 完成（含快照/运行时准备）——这是服务端可控准备耗时的上界。
    const admissionReadyAt = Date.now();
    // 插话不重写首字打点：当前 Run 的 marks 已经反映它自己的首个回合。
    if (!steeringRun) {
      markRunTiming(run.id, "serverReceivedAt", serverReceivedAt);
      markRunTiming(run.id, "admissionReadyAt", admissionReadyAt);
      // 细分耗时：准入这一段到底慢在等什么（运行时/写探针/引用读取/快照/写 Run 记录）
      attachRunTimingSpans(run.id, { ...admissionSpans, admissionTotal: admissionReadyAt - serverReceivedAt });
    }
    attachRunTimingMeta(run.id, { model: requestedModel || taskInput?.model || null, mode: task.mode });
    // 上传附件先进入当前 Run 的暂存区；Agent 可以通过 staging overlay 读取，成功后才发布到工作区。
    if (Array.isArray(attachments) && attachments.length) {
      for (const att of attachments) {
        const safe = deps.safeName(att.name);
        if (!safe) continue;
        deps.stageWrite({
          runId: run.id,
          workspace: runWorkspace,
          targetPath: path.join(runWorkspace, safe),
          content: Buffer.from(att.data, "base64"),
          threadId: thread || null,
          kind: "attachment",
          onEvent: (type: string, data: any) => emitChannel(entry, type, data, deps),
        });
      }
    }
    deps.recordRunEvent(run.id, "prompt", { text: normalizedText.slice(0, 4000), workflowId, referenceCount: resolved.length, steer: Boolean(steeringRun) });
    if (steeringRun) deps.recordRunEvent(run.id, "steer", { text: normalizedText.slice(0, 2000), source: "user", merged: true });
    deps.recordRunEvent(run.id, "capability_plan", { plan: capabilityPlan, preflight });
    if (runtimeSnapshot) deps.recordRunEvent(run.id, "runtime_health", runtimeSnapshot);
    // 插话已经并入当前回合：不再重复发 capability_plan/run_admitted（那些属于本轮开头的准入）。
    if (!steeringRun) {
      emitChannel(entry, "capability_plan", { plan: capabilityPlan, preflight, runId: run.id }, deps);
      emitChannel(entry, "run_admitted", {
        runId: run.id,
        requestId,
        startedAt: admissionStartedAt,
        admittedAt: new Date().toISOString(),
        snapshotMode: tracksWorkspace ? "full" : "none",
      }, deps);
    }
    // 先启动入队，再返回 admission 响应。executeAgentRun 在现有 entry 上
    // 会同步登记 queuedCount，避免响应里的 queued/queuePosition 与真实状态错位。
    const execution = executeAgentRun({
      entry,
      key,
      client,
      thread,
      normalizedText,
      images,
      effort,
      resolved,
      task,
      workflow,
      run,
      before,
      runWorkspace,
      effectiveModel,
      capabilityPlan,
      preflight,
      admissionReadyAt,
      requestId,
    }, deps);
    execution.catch((error) => {
      console.error("[agent] 后台 Run 收尾失败", error);
    });
    // 参考 pi-web：先返回“已接收”，最终模型/工具/产物状态由 SSE 事件驱动。
    return ok({
      ok: true,
      accepted: true,
      queued: Boolean(entry.busy || entry.compacting || entry.queuedCount > 1),
      queuePosition: Math.max(1, entry.queuedCount || 1),
      changed: [],
      runId: run?.id || null,
      artifacts: [],
      validations: [],
      verificationStatus: "pending",
      status: "accepted",
      task,
      sessionId: entry?.session?.sessionId || null,
      model: effectiveModel || (entry.session?.model?.provider && entry.session?.model?.id ? `${entry.session.model.provider}/${entry.session.model.id}` : null),
      modelFallbackFrom: entry.modelFallbackFrom || null,
      thread: thread || null,
    });
  } catch (e: any) {
    if (e?.code === "SKILL_PREFLIGHT_FAILED" || e?.code === "OFFICE_PREFLIGHT_FAILED") {
      emitChannel(entry, "agent_error", { message: e.message, code: e.code, preflight }, deps);
      return fail(409, { error: e.message, code: e.code, preflight, capabilityPlan, requestId });
    }
    if (["WORKSPACE_PERMISSION_DENIED", "WORKSPACE_WRITE_UNAVAILABLE", "OFFICE_DOCUMENT_LOCKED"].includes(e?.code)) {
      emitChannel(entry, "agent_error", { message: e.message, code: e.code, writeAccess: e.writeAccess || null }, deps);
      return fail(workspaceWriteHttpStatus(e), { error: e.message, code: e.code, writeAccess: e.writeAccess || null, requestId });
    }
    const currentModel = entry?.session?.model;
    const diagnostic = recordAgentDiagnostic(requestId, {
      client,
      thread,
      runId: run?.id || null,
      model: effectiveModel || (currentModel?.provider && currentModel?.id ? `${currentModel.provider}/${currentModel.id}` : null),
      error: e,
    }, deps);
    // 用户主动中断会让 SDK 以 "Request aborted" 拒绝这次 prompt。这不是模型故障：
    // 必须"用户确实请求过中断" + "错误形如中断"同时成立才算中断，避免把真实的
    // 连接中断（socket aborted）误判成用户操作而静默掉。
    const runStatusNow = run ? String(deps.getRun(run.id)?.status || "") : "";
    const cancelRequested = ["cancel_requested", "cancelled", "aborted"].includes(runStatusNow)
      || Boolean(entry?.cancelRequested)
      || Boolean(entry?.abortRequestedAt && Date.now() - entry.abortRequestedAt < 120000);
    const userAborted = cancelRequested && isAbortLikeError(diagnostic.message);
    if (entry && userAborted) {
      // 中断终态：只发 aborted，界面据此进入「本轮已中断」而不是「生成失败」。
      emitChannel(entry, "aborted", { runId: run?.id || null, reason: "用户请求中断" }, deps);
    } else if (entry) {
      emitChannel(entry, "agent_error", { message: diagnostic.message, code: diagnostic.errorCode || e?.code || null, category: diagnostic.errorCategory || null, providerStatus: diagnostic.providerStatus || null, requestId, retryable: diagnostic.retryable }, deps);
    }
    // 出错也检测产物（agent 可能已部分写入文件）
    const changed = run ? deps.filterRunChanges(run, await waitForFlush(before, runWorkspace, deps)) : await waitForFlush(before, runWorkspace, deps);
    const validations = deps.validateArtifacts(changed, runWorkspace);
    const stagedValidations = run ? validateStagedArtifacts(run.id, deps) : [];
    if (changed.length) {
      if (entry) {
        emitChannel(entry, "file_changed", { files: changed, runId: run?.id || null }, deps);
        emitChannel(entry, "agent_summary", {
          products: changed,
          // A02-3：总结正文只给数量，文件清单走 products/artifacts，不再把全部文件名塞进正文
          summary: `对话异常结束，仍处理了 ${changed.length} 个文件`,
          runId: run?.id || null,
          artifacts: [],
        }, deps);
      }
    }
    if (run) {
      const runtimeHealth = entry ? manager.runtimeHealth(key) : null;
      // 用户中断不是运行时故障：不写 runtime_error，否则事件流与诊断里会多出一条
      // 「Request aborted」的假故障，也让 Runtime 被误判为需要重建。
      if (runtimeHealth && !userAborted) deps.recordRunEvent(run.id, "runtime_error", { code: diagnostic.errorCode, message: diagnostic.message, runtime: runtimeHealth });
      const cancelled = userAborted || deps.getRun(run.id)?.status === "cancel_requested";
      const failureCompletion = resolveRunCompletion(entry, cancelled ? "cancelled" : "failed", { artifacts: changed.length, validations: [...validations, ...stagedValidations], runId: run.id });
      const failed = deps.finishRun(run.id, { status: cancelled ? "cancelled" : "failed", sessionId: entry?.session?.sessionId || null, error: cancelled ? "用户请求取消" : e.message, summary: cancelled ? "任务已中断" : "Agent 执行失败", validations: [...validations, ...stagedValidations], completion: failureCompletion });
      if (entry) emitChannel(entry, "run_finished", { runId: run.id, task, artifacts: failed?.artifacts || [], references: resolved, reviewSources: entry.reviewSources || [], status: failed?.status || (cancelled ? "cancelled" : "failed"), verificationStatus: failed?.verificationStatus || "not_checked", completion: failed?.completion || failureCompletion, finalText: getRunFinalText(deps.getRun(run.id)), model: deps.getRun(run.id)?.model || null, finalMessageId: deps.getRun(run.id)?.finalMessageId || null }, deps);
    }
    return fail(500, { error: diagnostic.message, requestId, retryable: diagnostic.retryable });
  }
}

// ---------- resume/retry 恢复链（server/index.mjs L4513-4672 逐行转录） ----------

const CONTINUABLE_RUN_STATUSES = new Set(["recovering", "failed", "cancelled", "aborted"]);

function continuationPrompt(task: any, action: string): string {
  const goal = String(task?.goal || "").trim();
  if (action === "retry") {
    return `请重新执行原任务，遇到上次失败原因时先检查并修正，再完成任务。原任务目标：${goal}`;
  }
  return `请从原任务上次中断的位置继续执行，先检查已经完成的步骤和当前文件状态，不要重复已经成功且无必要重复的副作用操作。原任务目标：${goal}`;
}

async function ensureContinuationAgent(run: any, deps: ResolvedDeps): Promise<{ key: string; entry: any }> {
  const manager = await deps.getManager();
  const key = deps.agentKeyOf(run.clientId, run.threadId);
  const live = manager.sessions?.get(key);
  if (live?.busy) throw new Error("对应对话正在执行其他任务，请等待或先取消当前任务");
  const sessionId = run.sessionId || run.threadId;
  const found = sessionId ? deps.findSessionFile(sessionId) : null;
  // 当前内存会话如果就是该 Run 的 Pi 会话，直接复用；否则优先恢复磁盘会话。
  if (live && (!found || live.session?.sessionId === run.sessionId)) return { key, entry: live };
  if (found) {
    const entry = await manager.resumeThread(key, run.threadId, found.fullPath, run.cwd || deps.getWorkspace());
    deps.annotateSessionThread(entry.sessionId, run.threadId);
    return { key, entry };
  }
  return { key, entry: await manager.getOrCreate(key, { threadId: run.threadId, cwd: run.cwd || deps.getWorkspace() }) };
}

async function executeContinuation({ key, entry, run, task, references, workflow }: Record<string, any>, deps: ResolvedDeps): Promise<any> {
  const manager = await deps.getManager();
  const before = deps.snapshotWorkspace(entry.workspace || run.cwd || deps.getWorkspace());
  try {
    await manager.promptWithContext(key, continuationPrompt(task, task.recoveryAction), [], undefined, references, { runId: run.id, task, workflow });
    if (entry?.lastFinalText) deps.recordRunEvent(run.id, "assistant_final", { text: entry.lastFinalText });
    const changed = deps.filterRunChanges(run, await waitForFlush(before, entry.workspace || run.cwd || deps.getWorkspace(), deps));
    const validations = deps.validateArtifacts(changed, entry.workspace || run.cwd || deps.getWorkspace());
    const stagedValidations = validateStagedArtifacts(run.id, deps);
    const allValidations = [...validations, ...stagedValidations];
    const publishableStagedValidations = stagedValidations.filter((item: any) => item.status !== "failed");
    const cancelled = deps.getRun(run.id)?.status === "cancel_requested";
    const status = cancelled ? "cancelled" : "completed";
    const publishPaths = stagedValidations.filter((item: any) => item.status !== "failed").map((item: any) => item.path).filter(Boolean);
    const finished = deps.finishRun(run.id, {
      status,
      sessionId: entry.session?.sessionId || run.sessionId,
      summary: status === "cancelled" ? "恢复任务已取消" : (changed.length ? `恢复任务完成，共处理 ${changed.length} 个文件` : "恢复任务完成，未检测到文件变更"),
      validations: allValidations,
      publishPaths,
      completion: resolveRunCompletion(entry, status, { artifacts: changed.length + publishableStagedValidations.length, validations: allValidations, runId: run.id }),
    });
    const productPaths = [...changed, ...publishableStagedValidations.map((item: any) => item.path).filter(Boolean)];
    if (productPaths.length) emitChannel(entry, "file_changed", { files: productPaths, runId: run.id }, deps);
    // 恢复路径同样无条件发终态总结（没有文件变更也要有结果卡）
    emitChannel(entry, "agent_summary", {
      products: productPaths,
      // A02-3：恢复路径同样只保留数量
      summary: finished?.summary || (status === "cancelled" ? "恢复任务已取消" : (productPaths.length ? `恢复任务完成，共处理 ${productPaths.length} 个文件` : "恢复任务完成，未检测到文件变更")),
      runId: run.id,
      artifacts: finished?.artifacts || [],
      references,
      status: finished?.status || status,
    }, deps);
    emitChannel(entry, "run_finished", { runId: run.id, task, artifacts: finished?.artifacts || [], references, reviewSources: entry.reviewSources || [], status: finished?.status || status, verificationStatus: finished?.verificationStatus || "not_checked", completion: finished?.completion || null, finalText: getRunFinalText(deps.getRun(run.id)), model: deps.getRun(run.id)?.model || null, finalMessageId: deps.getRun(run.id)?.finalMessageId || null }, deps);
    return finished;
  } catch (error: any) {
    const cancelled = deps.getRun(run.id)?.status === "cancel_requested";
    const message = classifyAgentError(error).message;
    emitChannel(entry, "agent_error", { message, runId: run.id, retryable: !cancelled }, deps);
    const finished = deps.finishRun(run.id, {
      status: cancelled ? "cancelled" : "failed",
      sessionId: entry.session?.sessionId || run.sessionId,
      error: message,
      summary: cancelled ? "恢复任务已取消" : "恢复任务失败",
      completion: resolveRunCompletion(entry, cancelled ? "cancelled" : "failed", { runId: run.id }),
    });
    emitChannel(entry, "run_finished", { runId: run.id, task, artifacts: finished?.artifacts || [], references, reviewSources: entry.reviewSources || [], status: finished?.status || "failed", verificationStatus: finished?.verificationStatus || "not_checked", completion: finished?.completion || null, finalText: getRunFinalText(deps.getRun(run.id)), model: deps.getRun(run.id)?.model || null, finalMessageId: deps.getRun(run.id)?.finalMessageId || null }, deps);
    return finished;
  }
}

async function startContinuation(sourceRun: any, action: string, deps: ResolvedDeps): Promise<any> {
  const manager = await deps.getManager();
  if (!CONTINUABLE_RUN_STATUSES.has(sourceRun.status)) throw new Error(`任务当前状态不可${action === "retry" ? "重试" : "继续"}：${sourceRun.status}`);
  if (!sourceRun.task?.goal) throw new Error("原任务缺少可恢复的目标文本");
  const { key, entry } = await ensureContinuationAgent(sourceRun, deps);
  const oldTask = sourceRun.task;
  const goal = String(oldTask.goal || "").trim();
  const references = deps.resolveReferences(oldTask.references || sourceRun.references || [], goal, entry.workspace || sourceRun.cwd || deps.getWorkspace());
  const workflowId = oldTask.workflowId || null;
  const skills = deps.scanSkills();
  const workflow = workflowId ? getWorkflow(workflowId, skills) : null;
  const preflight = deps.preflightSkills({ workflowId, requestedSkills: [], skills });
  if ((workflowId || oldTask.workflowId) && !preflight.ok) {
    const error = new Error(preflight.message) as Error & { code?: string };
    error.code = "SKILL_PREFLIGHT_FAILED";
    throw error;
  }
  const capabilityPlan = planTaskCapabilities({ text: goal, task: { ...oldTask, mode: oldTask.mode, workflowId }, references });
  deps.requireWorkspaceWriteForTask(capabilityPlan, entry.workspace || sourceRun.cwd || deps.getWorkspace());
  if (capabilityPlan.routing.officecli === "preferred") {
    const officecliInfo = await deps.checkOfficecli();
    capabilityPlan.officecli = officecliInfo;
    if (!officecliInfo.available) {
      const error = new Error(`Office CLI 预检失败：${officecliInfo.message}`) as Error & { code?: string };
      error.code = "OFFICE_PREFLIGHT_FAILED";
      throw error;
    }
  } else if (capabilityPlan.routing.officecli === "lazy") {
    // 恢复路径同样惰性：生成类任务不因预检阻塞恢复
    capabilityPlan.officecli = { available: null, deferred: true, message: "生成类任务：原生直写优先，Office CLI 预检延后" };
    void deps.checkOfficecli().then((info: any) => { capabilityPlan.officecli = info; }).catch(() => {});
  }
  const task = createTaskEnvelope({
    ...oldTask,
    id: undefined,
    goal,
    text: goal,
    threadId: sourceRun.threadId,
    references,
    workflowId,
    capabilityPlan,
    recoveryOf: sourceRun.id,
    recoveryAction: action,
    constraints: [...(oldTask.constraints || []), `${action === "retry" ? "重试" : "继续"}自 Run ${sourceRun.id}`],
  });
  const project = deps.getProjectForWorkspace(entry.workspace || sourceRun.cwd || deps.getWorkspace());
  const run = deps.beginRun({
    clientId: sourceRun.clientId,
    threadId: sourceRun.threadId,
    sessionId: entry.session?.sessionId || sourceRun.sessionId,
    cwd: entry.workspace || sourceRun.cwd || deps.getWorkspace(),
    task,
    references,
    workflow,
    projectId: project?.id || sourceRun.projectId || null,
    capabilityPlan,
    runtimeSnapshot: manager.runtimeSnapshot(key, {
      profile: task.agentProfile,
      taskMode: task.mode,
      capabilityPlanVersion: capabilityPlan?.version || null,
    }),
    recoveryChain: [{ sourceRunId: sourceRun.id, action }],
  });
  deps.recordRunEvent(run.id, "run_recovery_started", { sourceRunId: sourceRun.id, action, preflight });
  void executeContinuation({ key, entry, run, task: { ...task, recoveryAction: action }, references, workflow }, deps);
  return run;
}

/** POST /api/runs/:id/(resume|retry)（server/index.mjs L4657-4669 逐行转录）。 */
async function invokeRunsContinuation(payload: InvokeEnvelope, deps: ResolvedDeps, action: "resume" | "retry"): Promise<InvokeResult<unknown>> {
  const sourceRun = deps.getRun(paramsOf(payload).id);
  if (!sourceRun) return fail(404, { error: "run not found" });
  const allowed = action === "retry" ? sourceRun.actions?.canRetry : sourceRun.actions?.canResume;
  if (!allowed) return fail(409, { error: `任务当前状态不可${action === "retry" ? "重试" : "继续"}：${sourceRun.status}`, run: sourceRun });
  try {
    const run = await startContinuation(sourceRun, action, deps);
    return ok({ ok: true, run: deps.getRun(run.id), sourceRunId: sourceRun.id });
  } catch (error: any) {
    const status = ["SKILL_PREFLIGHT_FAILED", "OFFICE_PREFLIGHT_FAILED"].includes(error?.code) ? 409 : 500;
    return fail(status, { error: error.message, code: error.code || "RUN_RECOVERY_FAILED", sourceRunId: sourceRun.id });
  }
}

// ---------- 其余主链通道（server/index.mjs L3899-3977 / L4674-4708 逐行转录） ----------

/** POST /api/agent/abort（server/index.mjs L3899-3921）。 */
async function invokeAgentAbort(payload: InvokeEnvelope, deps: ResolvedDeps): Promise<InvokeResult<unknown>> {
  const { client, thread } = bodyOf(payload);
  if (!client) return fail(400, { error: "client required" });
  try {
    const key = deps.agentKeyOf(client, thread);
    const manager = await deps.getManager();
    const live = manager.resolveLiveEntry(key);
    // 双保险：内存里的活跃会话可能因为重载/切会话换了 key，而 Run 记录里还留着
    // 真正在跑的那条。按 client(+thread) 兜底标记取消，避免"界面说停了、任务还在跑"。
    let runId = live?.activeRunId || "";
    if (!runId) {
      const running = deps.listRuns({ limit: 20 }).find((item: any) => ["running", "queued", "waiting_user"].includes(item.status)
        && item.clientId === client && (!thread || !item.threadId || item.threadId === thread));
      runId = running?.id || "";
    }
    if (runId) deps.requestRunCancellation(runId, "用户在对话栏请求中断");
    const result = await manager.abort(key, { runId }) as Record<string, any>;
    // P2-3：一并回执「取消后仍排队的轮次数量」，前端据此区分「已停」与「排队中已停」
    //（基线只返回 ok/runId，无法判断是否还有排队的轮次）。字段为新增，不影响既有消费方。
    return ok({ ...result, runId: result.runId || runId || null, stillQueued: Number(live?.queuedCount || 0) });
  } catch (e: any) {
    return fail(500, { error: e.message });
  }
}

/** POST /api/agent/compact（server/index.mjs L3924-3932）。 */
async function invokeAgentCompact(payload: InvokeEnvelope, deps: ResolvedDeps): Promise<InvokeResult<unknown>> {
  const { client, thread, instructions } = bodyOf(payload);
  if (!client) return fail(400, { error: "client required" });
  try {
    const manager = await deps.getManager();
    return ok(await manager.compact(deps.agentKeyOf(client, thread), instructions));
  } catch (e: any) {
    return fail(409, { error: e.message });
  }
}

/** POST /api/agent/answer（server/index.mjs L3994-4000）。 */
async function invokeAgentAnswer(payload: InvokeEnvelope, deps: ResolvedDeps): Promise<InvokeResult<unknown>> {
  const { client, thread, answer } = bodyOf(payload);
  if (!client || !answer) return fail(400, { error: "client and answer required" });
  const manager = await deps.getManager();
  const result = manager.submitAnswer(deps.agentKeyOf(client, thread), String(answer).slice(0, 2000)) as Record<string, any>;
  if (!result.ok) return fail(404, { error: "no pending question" });
  return ok(result);
}

/** POST /api/agent/new（server/index.mjs L4674-4685）。 */
async function invokeAgentNew(payload: InvokeEnvelope, deps: ResolvedDeps): Promise<InvokeResult<unknown>> {
  const { client, thread, cwd, projectId, label } = bodyOf(payload);
  if (!client || !thread) return fail(400, { error: "client and thread required" });
  try {
    const workspace = deps.normalizeWorkspace(cwd || deps.getWorkspace()) || deps.getWorkspace();
    const manager = await deps.getManager();
    const result = await manager.newThread(deps.agentKeyOf(client, thread), thread, workspace) as Record<string, any>;
    deps.annotateSessionThread(result.sessionId, thread);
    const project = deps.getProject(projectId) || deps.getProjectForWorkspace(workspace);
    deps.updateSessionHeader(result.sessionId, { projectId: project?.id || null, label: String(label || "").trim() });
    return ok(result);
  } catch (e: any) {
    return fail(500, { error: e.message, code: e.code || null, detail: e.detail || null });
  }
}

/** POST /api/agent/resume（server/index.mjs L4687-4708）。 */
async function invokeAgentResume(payload: InvokeEnvelope, deps: ResolvedDeps): Promise<InvokeResult<unknown>> {
  const { client, thread, sessionId, cwd } = bodyOf(payload);
  if (!client || !thread || !sessionId) return fail(400, { error: "client, thread and sessionId required" });
  const found = deps.findSessionFile(sessionId);
  if (!found) return fail(404, { error: "session not found" });
  try {
    const workspace = deps.normalizeWorkspace(cwd || deps.getWorkspace()) || deps.getWorkspace();
    // 会话的工作区归属在创建时固定：禁止用 B 工作区恢复 A 工作区的历史，
    // 否则会串工具根目录、记忆与产物归属。
    const header = deps.readSessionHeader(found);
    const sessionWorkspace = deps.normalizeWorkspace(header?.cwd || "");
    if (sessionWorkspace && workspace && sessionWorkspace !== workspace) {
      return fail(409, {
        error: `该会话属于工作区「${sessionWorkspace}」，不能在「${workspace}」恢复；请先切换回原工作区。`,
        code: "SESSION_WORKSPACE_MISMATCH",
      });
    }
    const manager = await deps.getManager();
    const result = await manager.resumeThread(deps.agentKeyOf(client, thread), thread, found.fullPath, workspace) as Record<string, any>;
    deps.annotateSessionThread(result.sessionId, thread);
    return ok(result);
  } catch (e: any) {
    return fail(500, { error: e.message, code: e.code || null, detail: e.detail || null });
  }
}

/** GET /api/agent/session-tree（server/index.mjs L3952-3961）。 */
async function invokeAgentSessionTree(payload: InvokeEnvelope, deps: ResolvedDeps): Promise<InvokeResult<unknown>> {
  const query = queryOf(payload);
  const client = String(query.client || "");
  const thread = String(query.thread || "");
  if (!client) return fail(400, { error: "client required" });
  try {
    const manager = await deps.getManager();
    return ok(await manager.sessionTree(deps.agentKeyOf(client, thread)));
  } catch (e: any) {
    return fail(409, { error: e.message });
  }
}

/** POST /api/agent/session-branch（server/index.mjs L3965-3977）。 */
async function invokeAgentSessionBranch(payload: InvokeEnvelope, deps: ResolvedDeps): Promise<InvokeResult<unknown>> {
  const { client, thread, entryId, summarize, label } = bodyOf(payload);
  if (!client) return fail(400, { error: "client required" });
  if (!entryId) return fail(400, { error: "entryId required" });
  try {
    const manager = await deps.getManager();
    return ok(await manager.branchSession(deps.agentKeyOf(client, thread), String(entryId), {
      summarize: summarize !== false,
      label: label ? String(label).slice(0, 120) : undefined,
    }));
  } catch (e: any) {
    return fail(409, { error: e.message });
  }
}

// ---------- 分发 ----------

interface RouteEntry {
  invoke: (payload: InvokeEnvelope, deps: ResolvedDeps, requestId: string) => Promise<InvokeResult<unknown>>;
}

const ROUTES: Record<AgentPromptDirectChannel, RouteEntry> = {
  "op:agent:prompt": { invoke: (p, d, req) => invokeAgentPrompt(p, d, req) },
  "op:agent:abort": { invoke: (p, d) => invokeAgentAbort(p, d) },
  "op:agent:answer": { invoke: (p, d) => invokeAgentAnswer(p, d) },
  "op:agent:compact": { invoke: (p, d) => invokeAgentCompact(p, d) },
  "op:agent:new": { invoke: (p, d) => invokeAgentNew(p, d) },
  "op:agent:resume": { invoke: (p, d) => invokeAgentResume(p, d) },
  "op:agent:session-tree": { invoke: (p, d) => invokeAgentSessionTree(p, d) },
  "op:agent:session-branch": { invoke: (p, d) => invokeAgentSessionBranch(p, d) },
  "op:runs:resume": { invoke: (p, d) => invokeRunsContinuation(p, d, "resume") },
  "op:runs:retry": { invoke: (p, d) => invokeRunsContinuation(p, d, "retry") },
};

/**
 * 主链通道直调分发：channel → 逐通道转录的 sidecar 路由语义。
 * requestId 对齐 sidecar 中间件语义（每请求一个 uuid，进入 admission 打点与错误回执）；
 * 处理器抛出的意外错误统一 500（对齐 http-forward 网络失败兜底形态）。
 */
export async function invokeAgentPromptDirect(
  channel: AgentPromptDirectChannel,
  envelope: InvokeEnvelope | undefined,
  deps: AgentPromptDirectDeps
): Promise<InvokeResult<unknown>> {
  const payload: InvokeEnvelope = envelope ?? {};
  const resolved: ResolvedDeps = {
    ...deps,
    agentKeyOf: deps.agentKeyOf ?? agentKey,
    checkOfficecli: deps.checkOfficecli ?? (async () => (await import("../backend/office")).checkOfficecli()),
  };
  const route = ROUTES[channel];
  if (!route) return fail(404, { error: `unknown channel: ${channel}` });
  const requestId = crypto.randomUUID();
  try {
    return await route.invoke(payload, resolved, requestId);
  } catch (error) {
    return fail(500, { error: error instanceof Error ? error.message : String(error) });
  }
}
