/**
 * AgentManager 类体（B6-6-4a 起，自 server/agent.mjs L843 类逐批转录）。
 *
 * 拆批口径（绞杀者逐小批，类体逐批生长，agent.mjs 保持不动）：
 *   - 4a 已收口：L843-1018 薄方法（构造/看门狗/状态快照/ask_user 应答/记忆族/getOrCreate 单飞）
 *   - 4b 本批：prompt/promptWithContext/sessionTree/branchSession/ensureRuntime/abort/
 *     resolveLiveEntry/compact/newThread/resumeThread/setCurrentFile/runtimeSnapshot/
 *     runtimeHealth/restartRuntime/listRuntimes（usageSnapshot 依赖 4d 解析器随 4d 批）
 *   - 4c：setModel/applyModelSpec/probeModel/fallbackModel
 *   - 4d：_enqueuePrompt/上下文窗口/压缩策略族 + usageSnapshot
 *   - 4e：_promptEntry 主链
 *   - 4f：buildDynamicContext/writeContextFile + 模块级残余小函数族
 *   - 4g：_create 中段工具定义工厂（managedBash/内置工具族）
 *   - 4h：createSubagentRunner 工厂
 *   - 4i：_create 主体收口（loader/review/mcp/emit/事件 switch/entry 组装）
 *
 * 依赖口径：已迁 TS 模块直接 import（normalizeWorkspace/getWorkspace/readPendingAsks/
 * resolvePendingAsk/emitChannelSafe/emitAbortedOnce/isAbortLikeError/configuredModelSpec/
 * RUNTIME_FLAGS）；未迁域以 seam 注入（piRuntimeManager/getRun/memory-management 六函数/
 * findSessionFileForAgent），接线时由 B2 装配传入真实实现。constructor 增收 deps 参数是
 * 唯一的结构性偏差（旧 JS 无参构造），行为不变。
 */
import { EventEmitter } from "node:events";
import { RUNTIME_FLAGS } from "../../../shared/runtime/feature-flags";
import { isAbortLikeError } from "./agent-errors";
import { normalizeWorkspace as normalizeWorkspaceDefault, getWorkspace } from "../workspace";
import { emitChannelSafe, emitAbortedOnce, type EmitDeps } from "./emit-helpers";
import { configuredModelSpec as configuredModelSpecDefault } from "./model-spec";
import { readPendingAsks as readPendingAsksDefault, resolvePendingAsk as resolvePendingAskDefault } from "./pending-asks";

/** Pi Runtime 管理器 seam（server/pi-runtime-management.mjs 域未迁；随 B6 后续批扩员）。 */
export interface AgentPiRuntimeSeam {
  modelRuntime(): Promise<any>;
  dispose(runtimeId: unknown, session: unknown): void;
  getSessionTree(runtimeId: unknown, session: unknown): any;
  navigateSessionTree(runtimeId: unknown, session: unknown, entryId: unknown, options: any): Promise<any>;
  abort(runtimeId: unknown, session: unknown): Promise<void>;
  compact(runtimeId: unknown, session: unknown, instructions: string): Promise<any>;
  health(runtimeId: unknown, session: unknown, options: any): any;
  markRecovery(runtimeId: unknown, reason: unknown): void;
  listSnapshots(): any;
  schedulerSnapshot(): any;
}

/** 本批消费的运行开关子集（宽容类型，真值语义与旧 JS 一致）。 */
export interface AgentFlags {
  agentBusyWatchdog?: unknown;
  agentBusyWatchdogMs?: unknown;
}

export interface AgentManagerDeps {
  /** Pi Runtime 管理器 seam（必填，运行时由装配层提供）。 */
  piRuntimeManager: AgentPiRuntimeSeam;
  /** runs 域 seam（server/runs.mjs 未迁）。 */
  getRun: (id: unknown) => any;
  /** memory-management 域 seam（未迁；键名沿用 agent.mjs 的导入别名）。 */
  listStoredMemoryProposals: (filters: any) => any;
  approveStoredMemoryProposal: (id: unknown, options?: any) => any;
  editStoredMemoryProposal: (id: unknown, options?: any) => any;
  rejectStoredMemoryProposal: (id: unknown, reason?: unknown) => any;
  mergeMemoryProposals: (targetId: unknown, sourceIds?: unknown[]) => any;
  getMemoryProposalHistory: (id: unknown) => any;
  /** 运行开关（缺省 RUNTIME_FLAGS，测试注入切场景）。 */
  flags?: AgentFlags;
  /** 工作区归一（缺省 TS workspace 实现）。 */
  normalizeWorkspace?: (dir?: unknown, options?: any) => string | null;
  /** pending-asks（缺省 TS pending-asks 实现）。 */
  readPendingAsks?: () => any[];
  resolvePendingAsk?: (clientId: unknown, answer: unknown, status?: string) => any;
  /** 会话文件定位（agent.mjs L173，B6-6-4f 批迁移；此前为 seam）。 */
  findSessionFileForAgent?: (sessionId: unknown) => any;
  /** 默认模型规格（缺省 TS model-spec 实现）。 */
  configuredModelSpec?: () => any;
  /** emitChannelSafe 透传 deps（runs 域 recordRunEvent seam）。 */
  emitDeps?: EmitDeps;
}

/** Per-client agent sessions. Emits events to SSE subscribers. */
export class AgentManager extends EventEmitter {
  readonly deps: AgentManagerDeps;
  sessions: Map<any, any>; // agentKey(clientId:threadId) -> session entry
  pendingAsks: Map<any, any>; // agentKey -> resolve(回答)（ask_user 工具阻塞等待）
  // 同一会话的 SSE、恢复和发送请求可能同时触发 Runtime 初始化；
  // 单飞锁避免两个 Pi Runtime 互相覆盖，导致新事件通道被替换。
  resumePromises: Map<any, any>;
  recoveryPromises: Map<any, any>;
  busyWatchdogTimer?: any;
  // 与旧 JS 一致：getOrCreate 内按需创建（构造函数不初始化）
  creates?: Map<any, Promise<any>>;

  constructor(deps: AgentManagerDeps) {
    super();
    this.deps = deps;
    this.sessions = new Map(); // agentKey(clientId:threadId) -> session entry
    this.pendingAsks = new Map(); // agentKey -> resolve(回答)（ask_user 工具阻塞等待）
    // 同一会话的 SSE、恢复和发送请求可能同时触发 Runtime 初始化；
    // 单飞锁避免两个 Pi Runtime 互相覆盖，导致新事件通道被替换。
    this.resumePromises = new Map();
    this.recoveryPromises = new Map();
    this.startBusyWatchdog();
  }

  private get flags(): AgentFlags {
    return this.deps.flags ?? RUNTIME_FLAGS;
  }

  /**
   * A3 busy 看门狗（OAW_BUSY_WATCHDOG，默认关）：
   * busy 依赖任务正常收尾清零；若 Runtime 异常退出/流挂起未走收尾分支，busy 会永久卡死，
   * 表现为"切换任何会话都报任务排队"。看门狗在 busy 期间超过阈值（默认 15 分钟）无任何
   * Pi 事件活动时强制放行，并把清除时间记录到诊断快照供确认。
   */
  startBusyWatchdog() {
    if (this.busyWatchdogTimer) return;
    this.busyWatchdogTimer = setInterval(() => {
      if (!this.flags.agentBusyWatchdog) return;
      const now = Date.now();
      for (const [key, entry] of this.sessions) {
        if (!entry?.busy) continue;
        const lastActivity = Math.max(entry.lastPiEventAt || 0, entry.busyStartedAt || 0);
        if (lastActivity && now - lastActivity > Number(this.flags.agentBusyWatchdogMs)) {
          entry.busy = false;
          entry.busyWatchdogClearedAt = now;
          console.warn(`[agent] busy 看门狗放行：${key} 已 ${Math.round((now - lastActivity) / 1000)}s 无事件活动`);
        }
      }
    }, 60_000);
    if (typeof this.busyWatchdogTimer.unref === "function") this.busyWatchdogTimer.unref();
  }

  /** A4：per-client 会话占用快照（/api/agent/diagnostics 暴露），区分"正常占用"与"卡死"。 */
  listSessionStates() {
    const now = Date.now();
    return [...this.sessions.entries()].map(([key, entry]) => ({
      key,
      clientId: entry.clientId || key,
      threadId: entry.threadId || null,
      workspace: entry.workspace || null,
      busy: Boolean(entry.busy),
      compacting: Boolean(entry.compacting),
      queuedCount: entry.queuedCount || 0,
      activeRunId: entry.activeRunId || null,
      lastPiEventAt: entry.lastPiEventAt || null,
      busyForMs: entry.busyStartedAt ? now - entry.busyStartedAt : null,
      busyWatchdogClearedAt: entry.busyWatchdogClearedAt || null,
    }));
  }

  /** 读取并清除待回答的问题（返回 resolve 函数） */
  askPending(clientId: unknown) {
    const ask = this.pendingAsks.get(clientId);
    if (ask) this.pendingAsks.delete(clientId);
    return ask;
  }

  submitAnswer(clientId: unknown, answer: unknown) {
    // 取消后仍停在 ask_user 等待回答时，继续执行会与取消意图相反：
    // 这里直接把"已取消"作为回答回填，让模型收尾而不是继续扩大任务。
    if (this.isRunStopping(clientId)) {
      const live = this.askPending(clientId);
      if (live) {
        live("[系统提醒] 本轮任务已被用户取消，请立即停止执行，不要再调用工具，直接在正文里说明本轮已取消。");
        return { ok: true, mode: "cancelled", cancelled: true };
      }
    }
    const live = this.askPending(clientId);
    if (live) { live(String(answer || "")); return { ok: true, mode: "live" }; }
    const resolvePendingAsk = this.deps.resolvePendingAsk ?? resolvePendingAskDefault;
    const recovered = resolvePendingAsk(clientId, String(answer || ""), "queued");
    return recovered ? { ok: true, mode: "queued", questionId: recovered.id } : { ok: false };
  }

  /** 当前 Run 是否已进入取消/终态：用于抑制提醒与停止 ask_user 后的继续执行。 */
  isRunStopping(clientId: unknown) {
    const entry = this.sessions.get(clientId);
    if (!entry) return false;
    // 快速路径：取消请求会直接在 entry 上打标（abort 路径）
    if (entry.cancelRequested) return true;
    const runId = entry.activeRunId;
    if (!runId) return false;
    const now = Date.now();
    // 兜底路径回读 Run 状态，但每 5 秒最多一次，避免每个回合都解析 Run JSON
    if (entry.runStopCheckedAt && now - entry.runStopCheckedAt < 5000) return Boolean(entry.runStopCache);
    entry.runStopCheckedAt = now;
    try {
      const status = String(this.deps.getRun(runId)?.status || "");
      entry.runStopCache = ["cancel_requested", "cancelled", "aborted"].includes(status);
    } catch {
      entry.runStopCache = false;
    }
    return entry.runStopCache;
  }

  memoryProposals(threadId = "", filters: any = {}) {
    return this.deps.listStoredMemoryProposals({ ...filters, threadKey: threadId });
  }

  approveMemoryProposal(id: unknown, options: any = {}) {
    const result = this.deps.approveStoredMemoryProposal(id, options);
    const proposal = result.proposal;
    if (proposal?.threadKey) {
      const entry = this.sessions.get(proposal.threadKey);
      if (entry) emitChannelSafe(entry, "memory_proposal_resolved", { proposal }, {}, this.deps.emitDeps);
    }
    return result;
  }

  editMemoryProposal(id: unknown, options: any = {}) {
    const result = this.deps.editStoredMemoryProposal(id, options);
    const proposal = result.proposal;
    if (proposal?.threadKey) {
      const entry = this.sessions.get(proposal.threadKey);
      if (entry) emitChannelSafe(entry, "memory_proposal_updated", { proposal }, {}, this.deps.emitDeps);
    }
    return result;
  }

  rejectMemoryProposal(id: unknown, reason: unknown = "用户拒绝该记忆建议") {
    const result = this.deps.rejectStoredMemoryProposal(id, reason);
    const proposal = result.proposal;
    if (proposal?.threadKey) {
      const entry = this.sessions.get(proposal.threadKey);
      if (entry) emitChannelSafe(entry, "memory_proposal_resolved", { proposal }, {}, this.deps.emitDeps);
    }
    return result;
  }

  mergeMemoryProposals(targetId: unknown, sourceIds: unknown[] = []) {
    return this.deps.mergeMemoryProposals(targetId, sourceIds);
  }

  memoryProposalHistory(id: unknown) {
    return this.deps.getMemoryProposalHistory(id);
  }

  pendingQuestions(clientId = "") {
    const readPendingAsks = this.deps.readPendingAsks ?? readPendingAsksDefault;
    return readPendingAsks().filter((q: any) => !clientId || q.clientId === clientId);
  }

  modelRuntime(): Promise<any> {
    return this.deps.piRuntimeManager.modelRuntime();
  }

  async getOrCreate(clientId: unknown, options: any = {}) {
    const existing = this.sessions.get(clientId);
    if (existing) {
      const normalizeWorkspace = this.deps.normalizeWorkspace ?? normalizeWorkspaceDefault;
      const requested = normalizeWorkspace(options.cwd);
      // 工作区归属校验：同一 client::thread 不允许静默跨工作区复用运行时，
      // 否则会串会话、工具根目录、记忆和资源加载器。
      if (requested && existing.workspace && requested !== existing.workspace) {
        if (existing.busy || existing.compacting || existing.queuedCount > 0) {
          const error = new Error("当前会话正在其他工作区的任务中执行，请等待完成或先取消任务");
          (error as any).code = "WORKSPACE_BUSY";
          throw error;
        }
        try { this.deps.piRuntimeManager.dispose(existing.runtimeId, existing.session); } catch {}
        this.sessions.delete(clientId);
      } else {
        return existing;
      }
    }
    if (!this.creates) this.creates = new Map();
    if (this.creates.has(clientId)) return this.creates.get(clientId);
    const p = this._create(clientId, options);
    this.creates.set(clientId, p);
    try {
      return await p;
    } finally {
      this.creates.delete(clientId);
    }
  }

  /**
   * 会话创建主流程（_create，agent.mjs L1020-3458）由 B6-6-4g/h/i 批接管；
   * 4a 阶段仅保留占位，getOrCreate 相关对拍经实例覆写注入。
   */
  async _create(_clientId: unknown, _options: any = {}): Promise<any> {
    throw new Error("B6-6-4i 未收口：_create 尚未迁移");
  }

  /**
   * 入队主流程（agent.mjs L3578-3609）由 B6-6-4d 批接管；占位同 _create 口径。
   */
  _enqueuePrompt(_entry: any, _payload: any): any {
    throw new Error("B6-6-4d 未收口：_enqueuePrompt 尚未迁移");
  }

  /**
   * 上下文文件写入（agent.mjs L4307-4346）由 B6-6-4f 批接管；占位同 _create 口径。
   */
  writeContextFile(_entry: any, _file: unknown, _sharedMemCtx: unknown = null): any {
    throw new Error("B6-6-4f 未收口：writeContextFile 尚未迁移");
  }

  // ==================== B6-6-4b 会话生命周期批（自 agent.mjs L3461 起逐行转录） ====================

  async prompt(clientId: unknown, text: unknown, images: any[] = [], effort?: unknown) {
    const entry = await this.getOrCreate(clientId);
    return this._enqueuePrompt(entry, { text, images, effort, references: [], runContext: null });
  }

  /** U3：读取当前会话的 Pi 会话树（分支节点列表，供前端选择分叉点）。 */
  async sessionTree(clientId: unknown) {
    const entry = await this.getOrCreate(clientId);
    const tree = this.deps.piRuntimeManager.getSessionTree(entry.runtimeId, entry.sessionManager);
    if (!tree) throw new Error("当前会话不支持会话树读取（sessionManager.getTree 不可用）");
    return {
      sessionId: entry.session?.sessionId || null,
      sessionFile: entry.session?.sessionFile || null,
      nodeCount: Array.isArray(tree) ? tree.length : 0,
      tree,
    };
  }

  /**
   * U3：会话树导航（分支回退/切换）。导航后下一次 prompt 在目标节点分支继续；
   * 被弃分支默认生成摘要（summarize，Pi 原生 generateBranchSummary）。
   */
  async branchSession(clientId: unknown, entryId: unknown, options: any = {}) {
    const entry = await this.getOrCreate(clientId);
    if (entry.busy) throw new Error("会话正在执行任务，不能切换分支；请先停止当前任务");
    if (!entryId) throw new Error("entryId required");
    const summarize = options.summarize !== false;
    const result = await this.deps.piRuntimeManager.navigateSessionTree(entry.runtimeId, entry.session, entryId, {
      summarize,
      label: options.label || "工作台分支",
    });
    return {
      sessionId: entry.session?.sessionId || null,
      navigatedTo: String(entryId),
      summarize,
      summaryEntry: result?.summaryEntry || null,
      cancelled: Boolean(result?.cancelled),
      aborted: Boolean(result?.aborted),
    };
  }

  /**
   * 失败的 Pi runtime 不能继续复用：它通常已经持有失效的 provider 连接，
   * 继续向同一个 session 投递只会让前端一直停在“连接模型”。
   * 优先用原 JSONL 文件重开；如果历史文件不存在，则创建一个新 runtime。
   */
  async ensureRuntime(clientId: unknown, options: any = {}) {
    const existing = this.sessions.get(clientId);
    if (!existing) return this.getOrCreate(clientId, options);
    // 请求的工作区与现有运行时不一致时交给 getOrCreate 替换（含忙时拒绝）。
    const normalizeWorkspace = this.deps.normalizeWorkspace ?? normalizeWorkspaceDefault;
    const requested = normalizeWorkspace(options.cwd);
    if (requested && existing.workspace && requested !== existing.workspace) {
      return this.getOrCreate(clientId, options);
    }
    const health = this.runtimeHealth(clientId);
    const staleError = ["PI_SETTLED_ERROR", "MODEL_TIMEOUT", "PI_RUNTIME_FAILED"].includes(String(health?.error?.code || ""));
    if (health?.status !== "failed" && health?.health?.status !== "failed" && !staleError) return existing;
    const inFlight = this.recoveryPromises.get(clientId);
    if (inFlight) return inFlight;
    const recovery = (async () => {
      // 重新读取当前 entry：等待单飞锁期间可能已经被另一条路径恢复。
      const current = this.sessions.get(clientId);
      if (!current) return this.getOrCreate(clientId, options);
      const currentHealth = this.runtimeHealth(clientId);
      const currentStale = ["PI_SETTLED_ERROR", "MODEL_TIMEOUT", "PI_RUNTIME_FAILED"].includes(String(currentHealth?.error?.code || ""));
      if (currentHealth?.status !== "failed" && currentHealth?.health?.status !== "failed" && !currentStale) return current;
      const failedModel = current.session?.model?.provider && current.session?.model?.id
        ? `${current.session.model.provider}/${current.session.model.id}`
        : "";
      const configuredModelSpec = this.deps.configuredModelSpec ?? configuredModelSpecDefault;
      const fallbackModel = configuredModelSpec();
      const modelSpec = fallbackModel && fallbackModel !== failedModel
        ? fallbackModel
        : String(options.modelSpec || "").trim();
      const findSessionFileForAgent = this.deps.findSessionFileForAgent!;
      const found = findSessionFileForAgent(current.session?.sessionId || "");
      await this.restartRuntime(clientId, {
        threadId: options.threadId || current.threadId || null,
        sessionPath: found?.fullPath || null,
        cwd: options.cwd || current.workspace,
        modelSpec,
      });
      const entry = this.sessions.get(clientId);
      if (entry && modelSpec && modelSpec !== failedModel) {
        entry.modelFallbackSpec = modelSpec;
        entry.modelFallbackFrom = failedModel || null;
      }
      return entry || this.getOrCreate(clientId, options);
    })();
    this.recoveryPromises.set(clientId, recovery);
    try {
      return await recovery;
    } finally {
      if (this.recoveryPromises.get(clientId) === recovery) this.recoveryPromises.delete(clientId);
    }
  }

  promptWithContext(clientId: unknown, text: unknown, images: any[] = [], effort?: unknown, references: any[] = [], runContext: any = null) {
    // 已完成 admission 的 entry 直接入队，不要等一个多余的 await。
    // 这样 /api/agent/prompt 返回时就能准确知道本轮是执行中还是排队中，
    // 也避免前端看到“已接收”但服务端尚未建立队列的竞态窗口。
    const current = this.sessions.get(clientId);
    if (current) {
      // 长时间空闲后 Pi runtime 可能已失效（provider 连接失效/会话过期）：
      // 先体检，failed/stale 时用原 JSONL 自动重启，避免本轮直接失败。
      const health = this.runtimeHealth(clientId);
      const staleError = ["PI_SETTLED_ERROR", "MODEL_TIMEOUT", "PI_RUNTIME_FAILED"].includes(String(health?.error?.code || ""));
      if (health?.status === "failed" || health?.health?.status === "failed" || staleError) {
        return this.ensureRuntime(clientId, {
          threadId: current.threadId || null,
          cwd: current.workspace || getWorkspace(),
          profile: current.task?.agentProfile || null,
        }).then((entry) => this._enqueuePrompt(entry, { text, images, effort, references, runContext }));
      }
      return this._enqueuePrompt(current, { text, images, effort, references, runContext });
    }
    return this.getOrCreate(clientId).then((entry) => this._enqueuePrompt(entry, { text, images, effort, references, runContext }));
  }

  async abort(clientId: unknown, options: any = {}) {
    const entry = this.resolveLiveEntry(clientId);
    if (!entry) return { ok: true, cancelled: false, reason: "no-live-session" };
    // 打标：后续的轮次提醒与 ask_user 续跑都要据此停止
    entry.cancelRequested = true;
    entry.abortRequestedAt = Date.now();
    entry.runStopCache = true;
    entry.runStopCheckedAt = Date.now();
    const runId = entry.activeRunId || options.runId || null;
    let runtimeAborted = false;
    try {
      await this.deps.piRuntimeManager.abort(entry.runtimeId, entry.session);
      runtimeAborted = true;
    } catch (error: any) {
      if (!isAbortLikeError(error)) {
        emitChannelSafe(entry, "agent_error", { message: error?.message || String(error), code: "RUNTIME_ABORT_FAILED" }, {}, this.deps.emitDeps);
      }
    }
    // 只要确实有在跑的运行，就发出中断终态事件（幂等：同一 Run 只发一次）。
    const aborted = emitAbortedOnce(entry, "用户请求中断", this.deps.emitDeps);
    entry.busy = false;
    return { ok: true, cancelled: true, runId, runtimeAborted, thread: entry.threadId || null, emitted: aborted };
  }

  /** 按 key 找活跃会话；key 不匹配时按 client 前缀兜底（页面 thread 标识可能已变）。 */
  resolveLiveEntry(key: unknown) {
    if (!key) return null;
    const exact = this.sessions.get(key);
    if (exact) return exact;
    const prefix = `${String(key).split("::")[0]}::`;
    let fallback: any = null;
    for (const [sessionKey, candidate] of this.sessions) {
      if (!sessionKey.startsWith(prefix)) continue;
      if (!fallback) fallback = candidate;
      if (candidate.busy || candidate.activeRunId) return candidate;
    }
    return fallback;
  }

  /** 手动压缩当前会话上下文。压缩属于 pi session 能力，不通过伪造 /compact 文本实现。 */
  async compact(clientId: unknown, customInstructions: unknown = "") {
    const entry = await this.getOrCreate(clientId);
    if (entry.busy || entry.compacting || entry.queuedCount > 0 || (typeof entry.session.isIdle === "function" && !entry.session.isIdle())) {
      throw new Error("agent busy — wait for the current task to finish");
    }
    entry.compacting = true;
    entry.compactionKind = "manual";
    entry.compactionRunId = entry.activeRunId || null;
    const compactPromise = this.deps.piRuntimeManager.compact(entry.runtimeId, entry.session, String(customInstructions || "").trim());
    entry.compactionPromise = compactPromise;
    try {
      const result = await compactPromise;
      entry.lastCompactionAt = Date.now();
      entry.promptChars = 0;
      entry.lastUsage = null;
      return {
        ok: true,
        tokensBefore: result?.tokensBefore || 0,
        estimatedTokensAfter: result?.estimatedTokensAfter || 0,
      };
    } finally {
      entry.compactionPromise = null;
      entry.compactionRunId = null;
      entry.compactionKind = null;
      entry.compacting = false;
    }
  }

  async newThread(clientId: unknown, threadId: unknown, cwd: any = getWorkspace()) {
    const normalizeWorkspace = this.deps.normalizeWorkspace ?? normalizeWorkspaceDefault;
    const workspace = normalizeWorkspace(cwd) || normalizeWorkspace(getWorkspace());
    if (!workspace) throw new Error("当前工作区不存在或不是文件夹");
    const old = this.sessions.get(clientId);
    if (old) {
      if (old.busy || old.compacting || old.queuedCount > 0) throw new Error("当前会话仍有任务排队，不能替换活动会话");
      this.deps.piRuntimeManager.dispose(old.runtimeId, old.session);
      this.sessions.delete(clientId);
    }
    const entry = await this._create(clientId, { cwd: workspace, threadId });
    return { ok: true, threadId, sessionId: entry.session.sessionId, runtimeId: entry.runtimeId, cwd: workspace };
  }

  async resumeThread(clientId: unknown, threadId: unknown, sessionPath: unknown, cwd: any = getWorkspace()) {
    const inFlight = this.resumePromises.get(clientId);
    if (inFlight) return inFlight;
    const resume = (async () => {
      const normalizeWorkspace = this.deps.normalizeWorkspace ?? normalizeWorkspaceDefault;
      const workspace = normalizeWorkspace(cwd) || normalizeWorkspace(getWorkspace());
      if (!workspace) throw new Error("当前工作区不存在或不是文件夹");
      const old = this.sessions.get(clientId);
      if (old) {
        // 旧代码现状事实：_sessionBusyError 全仓仅有此一处调用且从未定义，
        // busy 时 resumeThread 实际抛 TypeError —— 1:1 固化，不做修复。
        if (old.busy || old.compacting || old.queuedCount > 0) throw (this as any)._sessionBusyError(old);
        this.deps.piRuntimeManager.dispose(old.runtimeId, old.session);
        this.sessions.delete(clientId);
      }
      const entry = await this._create(clientId, { cwd: workspace, sessionPath, threadId });
      return { ok: true, threadId, sessionId: entry.session.sessionId, runtimeId: entry.runtimeId, cwd: workspace };
    })();
    this.resumePromises.set(clientId, resume);
    try {
      return await resume;
    } finally {
      if (this.resumePromises.get(clientId) === resume) this.resumePromises.delete(clientId);
    }
  }

  /** 记录当前工作文件，并同步到 agent 上下文（agent 通过读 .agent-context.md 感知）。 */
  async setCurrentFile(clientId: unknown, file: unknown) {
    let entry = this.sessions.get(clientId);
    if (!entry) entry = await this.getOrCreate(clientId);
    entry.currentFile = file || null;
    this.writeContextFile(entry, entry.currentFile);
    return { ok: true, currentFile: entry.currentFile };
  }

  runtimeSnapshot(clientId: unknown, overrides: any = {}) {
    const entry = this.sessions.get(clientId);
    if (!entry) return null;
    return this.deps.piRuntimeManager.health(entry.runtimeId, entry.session, {
      profile: entry.task?.agentProfile || overrides.profile || "通用 Agent",
      toolPolicy: entry.modePolicy ? { mode: entry.modePolicy.mode, tools: [...entry.modePolicy.tools] } : overrides.toolPolicy || null,
      ...overrides,
    });
  }

  runtimeHealth(clientId: unknown) {
    return this.runtimeSnapshot(clientId) || { status: "missing", health: { status: "unknown", message: "Runtime 尚未创建" } };
  }

  async restartRuntime(clientId: unknown, { threadId = null, sessionPath = null, cwd = getWorkspace(), modelSpec = "" }: any = {}) {
    const old = this.sessions.get(clientId);
    if (old?.busy || old?.compacting || old?.queuedCount > 0) throw new Error("当前 Runtime 仍有任务排队，不能重启");
    if (old) {
      this.deps.piRuntimeManager.markRecovery(old.runtimeId, "manual_runtime_restart");
      this.deps.piRuntimeManager.dispose(old.runtimeId, old.session);
      this.sessions.delete(clientId);
    }
    const entry = await this._create(clientId, { cwd, threadId, sessionPath, modelSpec });
    return { ok: true, threadId, sessionId: entry.session.sessionId, runtimeId: entry.runtimeId, cwd: entry.workspace, recovery: "jsonl_reopen" };
  }

  listRuntimes() {
    return { runtimes: this.deps.piRuntimeManager.listSnapshots(), scheduler: this.deps.piRuntimeManager.schedulerSnapshot() };
  }
}
