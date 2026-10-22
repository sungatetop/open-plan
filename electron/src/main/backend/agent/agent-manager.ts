/**
 * AgentManager 类体（B6-6-4a 起，自 server/agent.mjs L843 类逐批转录）。
 *
 * 拆批口径（绞杀者逐小批，类体逐批生长，agent.mjs 保持不动）：
 *   - 4a 本批：L843-1018 薄方法（构造/看门狗/状态快照/ask_user 应答/记忆族/getOrCreate 单飞）
 *   - 4b：prompt/sessionTree/branchSession/ensureRuntime/newThread/resumeThread/compact/
 *     setCurrentFile/快照族/restartRuntime/listRuntimes
 *   - 4c：setModel/applyModelSpec/probeModel/fallbackModel
 *   - 4d：_enqueuePrompt/上下文窗口/压缩策略族
 *   - 4e：_promptEntry 主链 + abort/resolveLiveEntry
 *   - 4f：buildDynamicContext/writeContextFile + 模块级残余小函数族
 *   - 4g：_create 中段工具定义工厂（managedBash/内置工具族）
 *   - 4h：createSubagentRunner 工厂
 *   - 4i：_create 主体收口（loader/review/mcp/emit/事件 switch/entry 组装）
 *
 * 依赖口径：已迁 TS 模块直接 import（normalizeWorkspace/readPendingAsks/resolvePendingAsk/
 * emitChannelSafe/RUNTIME_FLAGS）；未迁域以 seam 注入（piRuntimeManager/getRun/memory-management
 * 六函数），接线时由 B2 装配传入真实实现。constructor 增收 deps 参数是唯一的结构性偏差
 * （旧 JS 无参构造），行为不变。
 */
import { EventEmitter } from "node:events";
import { RUNTIME_FLAGS } from "../../../shared/runtime/feature-flags";
import { normalizeWorkspace as normalizeWorkspaceDefault } from "../workspace";
import { emitChannelSafe, type EmitDeps } from "./emit-helpers";
import { readPendingAsks as readPendingAsksDefault, resolvePendingAsk as resolvePendingAskDefault } from "./pending-asks";

/** Pi Runtime 管理器 seam（server/pi-runtime-management.mjs 域未迁；随 B6 后续批扩员）。 */
export interface AgentPiRuntimeSeam {
  modelRuntime(): Promise<any>;
  dispose(runtimeId: unknown, session: unknown): void;
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
}
