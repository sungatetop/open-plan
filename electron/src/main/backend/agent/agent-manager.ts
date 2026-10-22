/**
 * AgentManager 类体（B6-6-4a 起，自 server/agent.mjs L843 类逐批转录）。
 *
 * 拆批口径（绞杀者逐小批，类体逐批生长，agent.mjs 保持不动）：
 *   - 4a 已收口：L843-1018 薄方法（构造/看门狗/状态快照/ask_user 应答/记忆族/getOrCreate 单飞）
 *   - 4b 已收口：prompt/promptWithContext/sessionTree/branchSession/ensureRuntime/abort/
 *     resolveLiveEntry/compact/newThread/resumeThread/setCurrentFile/runtimeSnapshot/
 *     runtimeHealth/restartRuntime/listRuntimes
 *   - 4c 已收口：模型族 setModel/applyModelSpec/probeModel/fallbackModel/listModelCatalog/
 *     listModels/refreshModels/disposeAll（L4419-4653，类体收尾段）
 *   - 4d 已收口：_enqueuePrompt/上下文窗口解析/压缩策略/_maybeCompact 队列压缩族
 *     （L3578-3715）+ usageSnapshot（L4370-4401）
 *   - 4e 已收口：_promptEntry 主链（L3717-4141）+ 模块级 prompt 链辅助（waitForAgentRetry/
 *     waitForPiSessionIdle/promptWithFirstEventTimeout → prompt-chain.ts）
 *   - 4f 已收口：buildDynamicContext/writeContextFile 转正（L4260-4345）+ 模块级残余
 *     小函数族（buildOutputPolicyLines→prompt-chain / findSessionFileForAgent 族→
 *     session-store / toolFingerprint+noteRepeatedToolCall→tool-repeat / 预算接线→
 *     budget-wiring / listAuth 族→provider-auth / ensureContextFile→context /
 *     ASK_TIMEOUT_MS→pending-asks）
 *   - 4g：_create 中段工具定义工厂（managedBash/内置工具族）
 *   - 4h：createSubagentRunner 工厂
 *   - 4i：_create 主体收口（loader/review/mcp/emit/事件 switch/entry 组装）
 *
 * 依赖口径：已迁 TS 模块直接 import（normalizeWorkspace/getWorkspace/readPendingAsks/
 * resolvePendingAsk/emitChannelSafe/emitAbortedOnce/isAbortLikeError/configuredModelSpec/
 * AUTO_COMPACT_PROMPT_CHARS/turnBudgetPolicy/RUNTIME_FLAGS/readMemoryContext/
 * findSessionFileForAgent）；未迁域以 seam 注入
 * （piRuntimeManager 含 getContextUsage/getRun/memory-management 六函数/
 * contextTokensFromUsage/piCompactionPolicy），接线时由 B2 装配传入真实实现。
 * constructor 增收 deps 参数是唯一的结构性偏差（旧 JS 无参构造），行为不变。
 */
import { EventEmitter } from "node:events";
import { RUNTIME_FLAGS } from "../../../shared/runtime/feature-flags";
import { isAbortLikeError, AUTO_COMPACT_PROMPT_CHARS } from "./agent-errors";
import { normalizeWorkspace as normalizeWorkspaceDefault, getWorkspace } from "../workspace";
import { emitChannelSafe, emitAbortedOnce, type EmitDeps } from "./emit-helpers";
import { configuredModelSpec as configuredModelSpecDefault, currentModelSpec, localModelProviders as localModelProvidersDefault, localStoredModels as localStoredModelsDefault } from "./model-spec";
import { classifyAgentError, clearInvalidCredential, createSettledAgentError, getCredentialErrors as getCredentialErrorsDefault, resolveThinkingLevel } from "./agent-errors";
import { readPendingAsks as readPendingAsksDefault, resolvePendingAsk as resolvePendingAskDefault, consumeRecoveredAnswers as consumeRecoveredAnswersDefault } from "./pending-asks";
import { turnBudgetPolicy } from "../../../shared/runtime/turn-budget";
import { normalizeTaskMode, modeLabel, modeDescription, taskSummary, toolPolicyForMode } from "../../../shared/runtime/task";
import { markRunTiming, attachRunTimingSpans } from "../../../shared/runtime/first-token-latency";
import { contextSummary } from "./context";
import { readMemoryContext as readMemoryContextDefault } from "./memory-layers";
import { waitForAgentRetry, waitForPiSessionIdle, promptWithFirstEventTimeout } from "./prompt-chain";
import { findSessionFileForAgent as findSessionFileForAgentDefault } from "./session-store";
import { atomicWriteFile } from "../persistence-utils";
import path from "node:path";
import fs from "node:fs";

/** Pi Runtime 管理器 seam（server/pi-runtime-management.mjs 域未迁；随 B6 后续批扩员）。 */
export interface AgentPiRuntimeSeam {
  modelRuntime(): Promise<any>;
  dispose(runtimeId: unknown, session: unknown): void;
  getSessionTree(runtimeId: unknown, session: unknown): any;
  navigateSessionTree(runtimeId: unknown, session: unknown, entryId: unknown, options: any): Promise<any>;
  abort(runtimeId: unknown, session: unknown): Promise<void>;
  compact(runtimeId: unknown, session: unknown, instructions: string): Promise<any>;
  health(runtimeId: unknown, session: unknown, options?: any): any;
  markRecovery(runtimeId: unknown, reason: unknown): void;
  listSnapshots(): any;
  schedulerSnapshot(): any;
  setModel(runtimeId: unknown, session: unknown, model: unknown): Promise<void>;
  probeModel(model: unknown, options: any): Promise<any>;
  resetModelRuntime(): void;
  disposeAll(entries: unknown[]): Promise<void>;
  /** Pi SDK 精确上下文用量（同步快照；_maybeCompact U1 路径入口）。 */
  getContextUsage(runtimeId: unknown, session: unknown): any;
  /** Pi 会话投递（B6-6-4e 扩员：promptWithFirstEventTimeout watchdog 内调用）。 */
  prompt(runtimeId: unknown, session: unknown, text: unknown, options: any): any;
  /** runPrompt 串行化门（B6-6-4e 扩员：_promptEntry 主链/收尾 nudge 依赖）。 */
  runPrompt(runtimeId: unknown, operation: () => Promise<any>, options: any): Promise<any>;
  /** 模式工具边界应用（B6-6-4e 扩员：_promptEntry modePolicy 段）。 */
  setActiveTools(runtimeId: unknown, session: unknown, tools: unknown): void;
  /** Runtime 元数据更新（B6-6-4e 扩员：工具策略/思考档位登记）。 */
  update(runtimeId: unknown, patch: any): void;
  /** 思考档位设置（B6-6-4e 扩员：_promptEntry thinkingChanged 分支）。 */
  setThinkingLevel(runtimeId: unknown, session: unknown, level: unknown): void;
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
  /** 恢复应答消费（agent.mjs L833，B6-6-4e 扩员；缺省 TS pending-asks 实现）。 */
  consumeRecoveredAnswers?: (clientId: unknown) => any[];
  /** 记忆上下文拼接（agent.mjs L801，B6-6-4e 扩员；缺省 TS memory-layers 实现）。 */
  readMemoryContext?: (workspace: unknown) => any;
  /** 会话文件定位（agent.mjs L173，B6-6-4f 实体迁移；缺省 TS session-store 实现，测试注入切场景）。 */
  findSessionFileForAgent?: (sessionId: unknown) => any;
  /** 默认模型规格（缺省 TS model-spec 实现）。 */
  configuredModelSpec?: () => any;
  /** 本地模型目录（读 models-store/models.json/auth.json，缺省 TS model-spec 实现）。 */
  localModelProviders?: () => Set<string>;
  localStoredModels?: (providers?: Set<string>) => any[];
  /** 凭据错误快照（内存态，缺省 TS agent-errors 实现；测试注入切场景）。 */
  getCredentialErrors?: () => Record<string, any>;
  /** Pi 压缩策略常量（pi-runtime-management.mjs PI_COMPACTION_POLICY；缺省同值冻结副本，B2 装配绑定原对象）。 */
  piCompactionPolicy?: { reserveTokens: number; keepRecentTokens: number };
  /** Pi usage → 上下文 token 纯函数（pi 域未迁，无 TS 缺省实现；装配层绑定 pi-runtime-management 同名导出）。 */
  contextTokensFromUsage: (usage: unknown) => number | null;
  /** emitChannelSafe 透传 deps（runs 域 recordRunEvent seam）。 */
  emitDeps?: EmitDeps;
}

// ==================== 队列压缩族常量（自 agent.mjs L425-430 逐值转录） ====================
/** 未知模型自动压缩输入 token 阈值（U1 前旧基线）。 */
export const UNKNOWN_MODEL_AUTO_COMPACT_INPUT_TOKENS = 26000;
/** Pi 压缩策略缺省副本（pi-runtime-management.mjs L37 PI_COMPACTION_POLICY 冻结常量同值；pi 域迁移后收敛为单一事实源）。 */
export const PI_COMPACTION_POLICY_DEFAULT: Readonly<{ reserveTokens: number; keepRecentTokens: number }> =
  Object.freeze({ reserveTokens: 16384, keepRecentTokens: 20000 });
/** 自动压缩冷却窗口：压缩成功后 10s 内不重复触发。 */
export const AUTO_COMPACT_COOLDOWN_MS = 10000;
/** 未知模型兜底上下文窗口（known=false 时不代表模型真实能力）。 */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000;
/** 字符→token 保守估算系数。 */
export const ESTIMATED_TOKENS_PER_CHAR = 3.5;

// ==================== Prompt 主链常量（自 agent.mjs L339-345/L423 逐值转录，B6-6-4e） ====================
// Pi 已经负责一次短重试；工作台再补一层：无工具副作用的失败回合按退避重放，
// 并在连接类故障时按候选链切换模型。已开始工具执行的回合绝不重放，避免
// Office 写入等副作用被重复执行。
/** 工作台传输层重试退避表。 */
export const APP_PROMPT_RETRY_DELAYS = [2000, 6000, 15000];
/** settled 错误重放退避表。 */
export const SETTLED_AGENT_RETRY_DELAYS = [1500, 5000, 12000];
/** 模型回退候选链上限。 */
export const MODEL_FALLBACK_LIMIT = 2;
// 收尾强制完成声明：本轮确实调用过工具、但没有 complete_task 时，追加一个短回合
// 让模型显式声明完成状态（否则 Run 只能靠推断，用户无法区分"回答完了"与"任务完成了"）。
/** 收尾强制完成声明短回合提示词。 */
export const COMPLETION_NUDGE_PROMPT =
  "系统提醒：本轮工具执行已经结束，但还没有声明完成状态。请立即调用 complete_task，如实填写 status（success/partial/blocked/failed）、summary、未完成项 incomplete 或阻塞原因 blockers、以及验证方式 verification。不要再执行新的工具调用，也不要扩展任务范围。";
/** Skills/上下文目录 reload 间隔（同回合内复用一次 reload，不阻塞首事件）。 */
export const RESOURCE_RELOAD_INTERVAL_MS = 30000;

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

  // ==================== B6-6-4d 队列压缩批（自 agent.mjs L3578-3715 + L4370-4401 逐行转录） ====================

  _enqueuePrompt(entry: any, payload: any): any {
    const wasOccupied = entry.busy || entry.compacting || entry.queuedCount > 0;
    if (wasOccupied) {
      const position = entry.queuedCount + 1;
      emitChannelSafe(entry, "agent_queued", {
        runId: payload.runContext?.runId || null,
        position,
        queued: entry.queuedCount,
      });
    }
    entry.queuedCount += 1;
    const queuedAt = Date.now();
    const operation = entry.promptChain.then(async () => {
      entry.queuedCount = Math.max(0, entry.queuedCount - 1);
      // 排队等待时长：上一轮还没收尾（或正在压缩）时，这段时间会直接叠加到本轮首字延迟上。
      entry.queueWaitMs = Date.now() - queuedAt;
      // 手动压缩不在 promptChain 内执行；新消息必须等它完成后再进入 Runtime。
      if (entry.compactionPromise) await entry.compactionPromise.catch(() => {});
      const compactionStartedAt = Date.now();
      await this._maybeCompact(entry, payload.runContext);
      entry.compactionCheckMs = Date.now() - compactionStartedAt;
      return this._promptEntry(entry, payload.text, payload.images, payload.effort, payload.references, payload.runContext);
    });
    // 保留链路继续执行，同时不让前一个失败阻断后续排队请求。
    entry.promptChain = operation.catch(() => {});
    return operation;
  }

  /**
   * 解析当前模型的实际上下文窗口。
   * known=false 时不能把默认值当成模型真实能力，只能启用未知模型兜底。
   */
  resolveEntryContextWindowInfo(entry: any) {
    const fromSession = Number(entry?.session?.model?.contextWindow || entry?.session?.model?.contextLength || 0);
    if (fromSession > 0) return { contextWindow: fromSession, known: true, source: "session_model" };
    const modelId = String(entry?.session?.model?.id || "").trim();
    if (modelId) {
      const localStoredModels = this.deps.localStoredModels ?? localStoredModelsDefault;
      const match = localStoredModels().find((item: any) => String(item?.id) === modelId || String(item?.id).split("/").pop() === modelId);
      const fromCatalog = Number(match?.contextWindow || match?.contextLength || 0);
      if (fromCatalog > 0) return { contextWindow: fromCatalog, known: true, source: "model_catalog" };
    }
    return { contextWindow: DEFAULT_CONTEXT_WINDOW, known: false, source: "default_fallback" };
  }

  resolveEntryContextWindow(entry: any) {
    return this.resolveEntryContextWindowInfo(entry).contextWindow;
  }

  resolveCompactionPolicy(entry: any) {
    const piCompactionPolicy = this.deps.piCompactionPolicy ?? PI_COMPACTION_POLICY_DEFAULT;
    const windowInfo = this.resolveEntryContextWindowInfo(entry);
    const piAutoCompactionEnabled = entry?.session?.autoCompactionEnabled !== false;
    if (windowInfo.known && piAutoCompactionEnabled) {
      return {
        mode: "pi-native",
        source: "pi-sdk",
        enabled: true,
        contextWindow: windowInfo.contextWindow,
        threshold: Math.max(0, windowInfo.contextWindow - piCompactionPolicy.reserveTokens),
        reserveTokens: piCompactionPolicy.reserveTokens,
      };
    }
    if (!piAutoCompactionEnabled) {
      return {
        mode: "manual",
        source: "disabled",
        enabled: false,
        contextWindow: windowInfo.contextWindow,
        threshold: null,
        reserveTokens: null,
      };
    }
    return {
      mode: "app-fallback",
      source: windowInfo.source,
      enabled: true,
      contextWindow: windowInfo.contextWindow,
      threshold: UNKNOWN_MODEL_AUTO_COMPACT_INPUT_TOKENS,
      reserveTokens: null,
    };
  }

  async _maybeCompact(entry: any, runContext: any = null) {
    if (entry.compacting || !entry.promptChars) return;
    if (entry.lastCompactionAt && Date.now() - entry.lastCompactionAt < AUTO_COMPACT_COOLDOWN_MS) return;
    const contextTokensFromUsage = this.deps.contextTokensFromUsage;
    const windowInfo = this.resolveEntryContextWindowInfo(entry);
    // 已知模型交给 Pi SDK：它会在安全的回合边界按 contextWindow 自动压缩，
    // 并在真正溢出时负责恢复/重试。工作台不能再用固定 2.6 万 token 抢先压缩。
    if (windowInfo.known && entry?.session?.autoCompactionEnabled !== false) return;
    // 用户显式关闭 Pi 自动压缩时，不用工作台偷偷改回自动模式。
    if (entry?.session?.autoCompactionEnabled === false) return;
    // U1：优先用 Pi SDK 精确上下文用量（getContextUsage + calculateContextTokens），
    // 取不到时回落到既有 usage 观测/字符估算（历史 fallback 行为保持不变）。
    const preciseUsage = this.deps.piRuntimeManager.getContextUsage(entry.runtimeId, entry.session);
    const preciseContextTokens = contextTokensFromUsage(preciseUsage?.usage ?? preciseUsage);
    const inputTokens = Number(entry.lastUsage?.inputTokens ?? entry.lastUsage?.input ?? 0);
    const cacheReadTokens = Number(entry.lastUsage?.cacheReadTokens ?? entry.lastUsage?.cacheRead ?? entry.lastUsage?.cache_read ?? 0);
    const cacheWriteTokens = Number(entry.lastUsage?.cacheWriteTokens ?? entry.lastUsage?.cacheWrite ?? entry.lastUsage?.cache_write ?? 0);
    // Pi 的 usage.input 只包含未命中缓存的 token；长会话的大部分上下文会
    // 出现在 cacheRead 中。只看 input 会让 4 万 token 的会话误判为很短。
    const observedContextTokens = preciseContextTokens ?? (inputTokens + cacheReadTokens + cacheWriteTokens);
    // usage 可能只覆盖最近一次请求，服务重启后甚至暂时没有 usage；用累计
    // prompt 字符数作保守下限，避免把恢复后的长 JSONL 会话误判为空。
    const estimatedContextTokens = Math.ceil(Number(entry.promptChars || 0) / ESTIMATED_TOKENS_PER_CHAR);
    const estimatedFallbackThreshold = Math.min(
      UNKNOWN_MODEL_AUTO_COMPACT_INPUT_TOKENS,
      Math.ceil(AUTO_COMPACT_PROMPT_CHARS / ESTIMATED_TOKENS_PER_CHAR),
    );
    const shouldCompact = observedContextTokens >= estimatedFallbackThreshold || estimatedContextTokens >= estimatedFallbackThreshold;
    if (!shouldCompact) return;
    entry.compacting = true;
    entry.autoCompacting = true;
    entry.compactionKind = "automatic";
    const runId = runContext?.runId || entry.activeRunId || null;
    entry.compactionRunId = runId;
    let compacted = false;
    try {
      const compactPromise = this.deps.piRuntimeManager.compact(entry.runtimeId, entry.session, "保留当前项目事实、用户偏好、已完成产物路径、未完成任务和下一步；删除重复的工具输出与旧过程细节。");
      entry.compactionPromise = compactPromise;
      await compactPromise;
      compacted = true;
      // 不依赖某个 Pi 版本是否发出 compaction_end；成功的 Promise 本身就是
      // 本地计数器的权威边界，防止下一轮再次按旧预算触发压缩。
      entry.promptChars = 0;
      entry.lastUsage = null;
    } catch (error: any) {
      // 自动压缩失败不阻断任务；下一轮仍会保留预算告警并可手动压缩。
      emitChannelSafe(entry, "context_compact_warning", { runId, message: String(error?.message || error).slice(0, 300) });
      // U6：压缩失败显式落盘（compaction_failed），跨会话回放可审计，不再只靠瞬时 warning。
      emitChannelSafe(entry, "compaction_failed", { runId, reason: "automatic", aborted: false, errorMessage: String(error?.message || error).slice(0, 300) });
    } finally {
      if (compacted) entry.lastCompactionAt = Date.now();
      entry.compactionPromise = null;
      entry.compactionRunId = null;
      entry.compactionKind = null;
      entry.autoCompacting = false;
      entry.compacting = false;
    }
  }

  usageSnapshot(clientId: unknown) {
    const entry = this.sessions.get(clientId);
    if (!entry) return null;
    const usage = entry.lastUsage ? { ...entry.lastUsage } : null;
    const contextChars = Number(entry.promptChars || 0);
    const usageContextBase = usage ? Number(usage.contextTokens ?? usage.context ?? 0) : 0;
    const usageContextTokens = usageContextBase > 0
      ? usageContextBase
      : usage
        ? Number(usage.inputTokens ?? usage.input ?? 0)
          + Number(usage.cacheReadTokens ?? usage.cacheRead ?? usage.cache_read ?? 0)
          + Number(usage.cacheWriteTokens ?? usage.cacheWrite ?? usage.cache_write ?? 0)
        : 0;
    const estimatedContextTokens = Math.ceil(contextChars / ESTIMATED_TOKENS_PER_CHAR);
    const contextWindow = this.resolveEntryContextWindow(entry);
    const compactionPolicy = this.resolveCompactionPolicy(entry);
    const piCompactionPolicy = this.deps.piCompactionPolicy ?? PI_COMPACTION_POLICY_DEFAULT;
    return {
      usage,
      contextChars,
      estimatedContextTokens,
      contextTokens: Math.max(usageContextTokens, estimatedContextTokens),
      contextWindow,
      compactThreshold: compactionPolicy.threshold,
      compactThresholdSource: compactionPolicy.source,
      compactionMode: compactionPolicy.mode,
      compactionEnabled: compactionPolicy.enabled,
      compactionReserveTokens: compactionPolicy.reserveTokens,
      compactionKeepRecentTokens: compactionPolicy.mode === "pi-native" ? piCompactionPolicy.keepRecentTokens : null,
      // 轮次预算策略（进度播报间隔 + 25/45 关键点），设置页/诊断可直接读取
      turnBudget: turnBudgetPolicy(),
    };
  }

  /**
   * 动态上下文构建（agent.mjs L4260-4300，B6-6-4f 转正）：随每轮注入系统提示的动态
   * 词条——工作区/当前文件/上下文文件名 + 按 mode（chat/review/其余）分支工具纪律 +
   * 工作区记忆摘要（chat 截 800、其余 1500）。构建失败返回空串（调用方有 try/catch）。
   */
  buildDynamicContext(entry: any, file: unknown, sharedMemCtx: any = null): string {
    try {
      const readMemoryContext = this.deps.readMemoryContext ?? readMemoryContextDefault;
      const ws = entry?.workspace || getWorkspace();
      const memCtx = sharedMemCtx ?? readMemoryContext(ws);
      const mode = normalizeTaskMode(entry?.mode || "agent");
      const ctxFile = entry?.threadId ? `.agent-context.${entry.threadId}.md` : ".agent-context.md";
      const lines = [
        "[动态上下文]",
        `- 当前工作区（绝对路径）: ${ws}`,
        `- 当前工作文件: ${file || "（无）"}`,
        `- 工作区上下文文件: ${ctxFile}（权威版本；旧版 .agent-context.md 可能被其他会话覆盖，仅作兼容）`,
      ];
      if (mode === "chat") {
        lines.push("- 当前为 Chat：只读检索、解释与引用；不得修改文件、执行脚本、调用 Office CLI 或写入长期记忆。");
      } else if (mode === "review") {
        lines.push(
          "- 当前为 Review：先识别材料类型，再用 kb_search 查找候选规范；只有实际调用 kb_read 并成功返回全文的规范才能作为依据。",
          "- 必须维护规范依据台账：读取规范后使用系统分配的 R-* 编号；每条问题使用 F-* 编号，并在报告中写明 R-* 依据。搜索命中但未 kb_read 的文件只能标记为候选/未采用。",
          "- 审查默认生成审查报告和批注副本。优先用 review_copy 复制原文件，再对副本使用 officecli 添加批注；不得在用户明确确认前修改当前工作文件。",
          "- 报告生成并回读验证后，必须调用 ask_user 询问是否写回原文件；只有用户明确确认后系统才会解除原文保护。拒绝或超时就保留报告/副本并说明未写回。",
          "- 聊天收尾先用 1-3 句直接给审查结论（通过/有风险/受阻、关键影响、是否已写回），不要输出固定 Markdown 五段总结或重复过程；详细依据与审查问题写入报告/台账，用户需要时再展开。最后调用 complete_task。",
          "- Review 禁止使用 bash、地图编辑、浏览器自动化和 memory_update；Office 文档一律用 officecli，文本报告用 write/edit。",
        );
      } else {
        lines.push(
        "- Office 文档一律用 officecli 工具操作；新建或修改文件必须写入当前工作区。",
        "- 工具使用纪律：读取/编辑文件前先用 ls 或列目录确认真实文件名，不要凭记忆拼路径（实测 13 次 read/ls 因文件名不存在失败）；搜索、遍历、批量命令必须限定在当前工作区内，禁止从系统盘根目录全盘扫描；bash 默认 120 秒超时，长任务请显式传 timeout（最多 600 秒）或拆成小步执行。",
        "- 同一个操作连续失败两次就停止重试：先看错误里的 code 与建议（例如 sharing violation 让用户关闭 WPS/Word，decompression_bomb 说明文件过大需要拆分），必要时用 ask_user 询问，而不是重复提交同一条命令。",
        "- Word 批注必须先 get/query 找到真实 `/body/p[...]` 路径，再用 `add <file> /body/p[N] --type comment --prop author=\\\"规聚 Agent\\\" --prop initials=OA --prop text=\\\"...\\\" --json`，一次 get 只传一个路径，完成后 query comment 回读。sharing violation 或另一个进程占用才表示文件锁；Access denied、is denied、EPERM 或 EACCES 表示当前服务进程缺少系统写权限。",
          "- 面向用户的进度与收尾总结先直说阶段/最终结论，默认 1-3 句自然语言；不要按 Markdown 的‘读取来源/修改文件/产物/假设/下一步’模板列项。只在影响用户判断时简要提及关键产物、未完成项或阻塞；详细过程留在任务记录中。收尾必须调用 complete_task 声明 success/partial/blocked/failed。",
          "- 复杂任务先调用 todo 创建 2-6 项结构化待办；每完成一项就用完整快照更新 todo。只有稳定的新项目事实或偏好才提交 memory_update 建议。",
          "- 计划触发条件（满足任一就必须先建计划再动手）：① 本轮会新增或修改文件；② 预计工具调用 ≥5 次；③ 涉及多份材料或多个相互依赖的步骤；④ 用户要求整理、审查、生成、批量处理。短问答与单次查询不要建计划。",
          "- 收尾时若待办仍有未完成项，必须在 complete_task 的 incomplete 里逐条写明原因；系统会把未完成待办计入完成状态，不要用 success 掩盖半成品。",
        );
      }
      if (memCtx) lines.push("- 工作区记忆摘要：\n" + memCtx.slice(0, mode === "chat" ? 800 : 1500));
      return lines.join("\n");
    } catch {
      return "";
    }
  }

  // ==================== B6-6-4e Prompt 主链批（自 agent.mjs L3717 起逐行转录） ====================

  async _promptEntry(entry: any, text: any, images: any[] = [], effort?: unknown, references: unknown[] = [], runContext: any = null) {
    const prologueStartedAt = Date.now();
    const isStreaming = entry.busy;
    entry.busy = true;
    entry.busyStartedAt = Date.now();
    entry.references = Array.isArray(references) ? references : [];
    entry.activeRunId = runContext?.runId || null;
    // 每轮独立计数：上一轮的完成声明、轮次预算与提醒标记都不能串到本轮
    entry.pendingCompletion = null;
    // 终稿缓存按 Run 隔离：新 Run 开始即清空，旧 Run 迟到文本不会串入本轮。
    entry.lastFinalText = "";
    entry.suppressFinalText = false;
    entry.turnCount = 0;
    entry.runToolCount = 0;
    entry.runStartedAt = Date.now();
    // 新一轮任务：取消标记与 Run 状态缓存都重置
    entry.cancelRequested = false;
    entry.abortRequestedAt = 0;
    entry.abortedEmittedRunId = null;
    entry.runStopCache = false;
    entry.runStopCheckedAt = 0;
    entry.completionNudgeSent = false;
    entry.officeLockFailures = new Map();
    entry.task = runContext?.task || null;
    entry.mode = normalizeTaskMode(runContext?.task?.mode || entry.mode || "agent");
    if (!isStreaming) {
      entry.reviewConfirmed = false;
      entry.reviewAwaitingConfirmation = false;
      entry.reviewSources = [];
      const reviewTargets = [
        runContext?.task?.currentFile,
        ...(Array.isArray(runContext?.task?.references) ? runContext.task.references.filter((item: any) => item?.kind === "file").map((item: any) => item.target) : []),
      ].filter(Boolean);
      entry.reviewProtectedPaths = new Set(reviewTargets.map((value: any) => {
        try { return path.resolve(entry.workspace, String(value)).toLowerCase(); } catch { return String(value); }
      }).filter(Boolean));
      if (entry.mode === "review") {
        const material = String(reviewTargets[0] || "附件材料");
        const ext = path.extname(material).toLowerCase();
        const materialType = ext === ".docx" || ext === ".doc" ? "Word 文档"
          : [".xlsx", ".xls", ".csv"].includes(ext) ? "表格材料"
            : ext === ".pptx" ? "演示文稿"
              : [".md", ".markdown", ".txt"].includes(ext) ? "文字稿"
                : ext === ".pdf" ? "PDF 材料" : "待确认材料";
        emitChannelSafe(entry, "review_material_classified", {
          runId: entry.activeRunId,
          materialType,
          confidence: materialType === "待确认材料" ? "medium" : "high",
          targets: reviewTargets,
        }, {}, this.deps.emitDeps);
      }
    }
    entry.lastAgentError = null;
    entry.lastSettledError = null;
    entry.lastAssistantText = "";
    entry.lastPiEventAt = Date.now();
    // 只有尚未收到本轮模型/工具事件时，才允许对抛出的传输异常重放 prompt。
    // 一旦已经开始工具调用，绝不重复提交，避免副作用被执行两次。
    if (!isStreaming) {
      entry.turnStarted = false;
      entry.toolStarted = false;
      entry.firstResponseReceived = false;
      entry.activeToolCount = 0;
    }
    try {
      // Skills/上下文目录在同一回合内不会变化；短时间内复用一次 reload，
      // 仍保留每轮动态记忆注入，避免高频请求重复扫描本地目录拖慢首字节。
      const nowMs = Date.now();
      if (nowMs - (entry.lastResourceReloadAt || 0) >= RESOURCE_RELOAD_INTERVAL_MS && !entry.resourceReloadPromise) {
        entry.lastResourceReloadAt = nowMs;
        entry.resourceReloadPromise = Promise.resolve()
          .then(() => entry.loader.reload())
          .catch(() => {})
          .finally(() => { entry.resourceReloadPromise = null; });
      }
      // reload 采用后台刷新，不阻塞本轮模型首事件。Agent 工具清单在会话创建时
      // 已完成，动态上下文仍在本轮同步注入；这样长时间空闲后的第一条消息不会
      // 因重新扫描资源目录额外等待。
      // 按本轮模式收缩 Pi 的可用工具集合。该策略必须在 prompt 前应用，
      // Chat/Office 发生异常时直接中止，避免以更宽权限继续执行。
      const baseModePolicy = toolPolicyForMode(entry.mode);
      const modeDynamicTools = entry.mode === "chat"
        ? [...(entry.mcpReadOnlyToolNames || []), ...(entry.hasSubagent ? ["run_subagent"] : [])]
        : entry.mode === "agent"
          ? [...(entry.mcpToolNames || []), ...(entry.piExtensionToolNames || []), ...(entry.hasSubagent ? ["run_subagent"] : [])]
          : [];
      const modePolicy = { ...baseModePolicy, tools: [...new Set([...baseModePolicy.tools, ...modeDynamicTools])] };
      // 从 _promptEntry 进入到工具边界之前的所有同步/异步准备（模式、review 目标、资源刷新登记）
      entry.promptPrologueMs = Date.now() - prologueStartedAt;
      const modePolicyStartedAt = Date.now();
      let modePolicyApplied = 0;
      try {
        const modePolicyKey = `${modePolicy.mode}:${entry.task?.agentProfile || "通用 Agent"}:${modeDynamicTools.join(",")}`;
        if (entry.modePolicyKey !== modePolicyKey) {
          modePolicyApplied = 1;
          this.deps.piRuntimeManager.setActiveTools(entry.runtimeId, entry.session, modePolicy.tools);
          entry.modePolicy = modePolicy;
          entry.modePolicyKey = modePolicyKey;
          this.deps.piRuntimeManager.update(entry.runtimeId, {
            profile: entry.task?.agentProfile || "通用 Agent",
            toolPolicyVersion: "task-tool-policy-v1",
            toolPolicy: { mode: modePolicy.mode, tools: [...modePolicy.tools] },
          });
          emitChannelSafe(entry, "mode_policy", {
            runId: entry.activeRunId,
            mode: modePolicy.mode,
            label: modePolicy.label,
            description: modePolicy.description,
            tools: modePolicy.tools,
          }, {}, this.deps.emitDeps);
        }
      } catch (error: any) {
        entry.modePolicy = null;
        emitChannelSafe(entry, "agent_error", {
          message: `无法应用${modeLabel(entry.mode)}模式的工具边界：${error?.message || String(error)}`,
          code: "MODE_POLICY_APPLY_FAILED",
        }, {}, this.deps.emitDeps);
        throw error;
      }
      // 刷新 .agent-context.md（当前工作区路径/记忆/当前文件动态注入）
      // T3（首字优化）：同一轮内 writeContextFile 与 buildDynamicContext 只读一次记忆目录，
      // 显式传参复用，消除每轮重复的 memory/*.md 目录扫描与文件拼接 IO。
      const contextFileStartedAt = Date.now();
      const readMemoryContext = this.deps.readMemoryContext ?? readMemoryContextDefault;
      const sharedMemCtx = readMemoryContext(entry?.workspace || getWorkspace());
      this.writeContextFile(entry, entry.currentFile, sharedMemCtx);
      const contextFileMs = Date.now() - contextFileStartedAt;
      // 按 Pi 模型目录归一化推理档位；不支持的 medium 优先降到 low，避免
      // UI 显示标准但 SDK 实际沿用高延迟默认档位。
      const requestedThinkingLevel = effort || "low";
      const effectiveThinkingLevel = resolveThinkingLevel(entry.session?.model, requestedThinkingLevel);
      const thinkingChanged = entry.requestedThinkingLevel !== requestedThinkingLevel || entry.effectiveThinkingLevel !== effectiveThinkingLevel;
      if (thinkingChanged) {
        try {
          this.deps.piRuntimeManager.setThinkingLevel(entry.runtimeId, entry.session, effectiveThinkingLevel);
          this.deps.piRuntimeManager.update(entry.runtimeId, { requestedThinkingLevel, thinkingLevel: effectiveThinkingLevel });
          emitChannelSafe(entry, "thinking_level", { requested: requestedThinkingLevel, effective: effectiveThinkingLevel, model: entry.session?.model?.id || null }, {}, this.deps.emitDeps);
        } catch {}
      }
      entry.requestedThinkingLevel = requestedThinkingLevel;
      entry.effectiveThinkingLevel = effectiveThinkingLevel;
      // 强制注入当前工作文件声明（兜底，防止 agent 不知道在改哪个文档）
      if (entry.currentFile) {
        const marker = `[当前工作文件: ${entry.currentFile}]\n`;
        if (!text.includes("当前工作文件") && !text.includes(entry.currentFile)) {
          text = marker + text;
        }
      }
      // 每次对话前注入动态上下文（当前工作区绝对路径 + 记忆摘要）——直接进 prompt 文本，
      // 不依赖 agent 主动 read .agent-context.md（agentsFiles 注入的是会话创建时的静态快照，会过时）
      const dynamicContextStartedAt = Date.now();
      let dynamicContextMs = 0;
      try {
        const dyn = this.buildDynamicContext(entry, entry.currentFile, sharedMemCtx);
        dynamicContextMs = Date.now() - dynamicContextStartedAt;
        if (dyn) text = dyn + "\n\n" + text;
      } catch { dynamicContextMs = Date.now() - dynamicContextStartedAt; }
      const consumeRecoveredAnswers = this.deps.consumeRecoveredAnswers ?? consumeRecoveredAnswersDefault;
      const recoveredAnswers = consumeRecoveredAnswers(entry.clientId || "");
      if (recoveredAnswers.length) {
        text = `## 恢复的用户回答\n${recoveredAnswers.map((a: any) => `- ${a.question}: ${a.answer}`).join("\n")}\n请把这些回答视为对上次中断提问的确认，并继续原任务。\n\n${text}`;
      }
      if (entry.references.length) {
        text = `## 本轮结构化引用\n${contextSummary(entry.references)}\n请使用 context_read(refId) 按需读取引用内容；若状态为 missing/deferred，应明确告诉用户。\n\n${text}`;
      }
      if (entry.task) text = `${taskSummary(entry.task)}\n- 当前对话边界：${modeDescription(entry.mode)}\n\n${text}`;
      entry.promptChars += text.length;
      // 首字延迟分项（方案 §3.5）：真正把请求交给 SDK 的时刻。
      // 它在 runPrompt 之前，因此到首个 provider 事件之间的等待包含 SDK 准备、
      // 网络与网关，不能整体算成 SSE 传输延迟。
      markRunTiming(entry.activeRunId, "sdkRequestDispatchedAt");
      // 派发阶段细分：排队等待 / 压缩检查 / 工具边界 / 上下文文件 / 动态上下文各占多少
      attachRunTimingSpans(entry.activeRunId, {
        queueWait: Number(entry.queueWaitMs || 0),
        compactionCheck: Number(entry.compactionCheckMs || 0),
        prologue: Number(entry.promptPrologueMs || 0),
        modePolicy: Date.now() - modePolicyStartedAt,
        modePolicyApplied,
        contextFile: contextFileMs,
        dynamicContext: dynamicContextMs,
        dispatchTotal: runContext?.admissionReadyAt ? Date.now() - runContext.admissionReadyAt : undefined,
      });
      // 记录"本轮已派发"，供 provider 事件按 Run 幂等打点使用（见 session.subscribe）。
      entry.sdkDispatchedRunId = entry.activeRunId;
      entry.firstProviderEventRunId = null;
      emitChannelSafe(entry, "model_request_started", {
        runId: entry.activeRunId,
        mode: entry.mode,
        contextChars: text.length,
      }, {}, this.deps.emitDeps);
      const opts: any = {};
      if (images && images.length) {
        // pi-ai v0.83 ImageContent: { type: "image", data, mimeType }
        opts.images = images.map((img: any) => ({
          type: "image",
          data: img.data,
          mimeType: img.mediaType || "image/png",
        }));
      }
      await this.deps.piRuntimeManager.runPrompt(entry.runtimeId, async () => {
        if (isStreaming) {
          // 打断当前回合并插入新指令（steer 在 agent 停止后生效，或中断当前工具调用）
          opts.streamingBehavior = "steer";
          emitChannelSafe(entry, "steer", { text: text.slice(0, 80) }, {}, this.deps.emitDeps);
          await promptWithFirstEventTimeout(this.deps.piRuntimeManager, entry, text, opts);
          return;
        }
        let transportAttempt = 0;
        let settledReplayAttempt = 0;
        const modelFallbackTried: string[] = [];
        let modelFallbackAttempted = false;
        let continuationAttempted = false;
        while (true) {
          try {
            await promptWithFirstEventTimeout(this.deps.piRuntimeManager, entry, text, opts);
            const settledError = entry.lastSettledError;
            entry.lastSettledError = null;
            if (settledError) {
              const info = classifyAgentError(settledError);
              const canReplay = info.retryable && !settledError?.noRetry && !entry.toolStarted && settledReplayAttempt < SETTLED_AGENT_RETRY_DELAYS.length;
              if (!canReplay) throw createSettledAgentError(settledError);
              const delayMs = SETTLED_AGENT_RETRY_DELAYS[settledReplayAttempt]!;
              settledReplayAttempt += 1;
              emitChannelSafe(entry, "agent_retry", {
                message: info.message,
                category: info.category,
                code: info.code,
                retryable: info.retryable,
                attempt: settledReplayAttempt,
                maxAttempts: SETTLED_AGENT_RETRY_DELAYS.length,
                delayMs,
                source: "workbench-settled",
                willRetry: true,
              }, {}, this.deps.emitDeps);
              entry.lastAgentError = null;
              entry.lastAssistantText = "";
              entry.turnStarted = false;
              entry.toolStarted = false;
              entry.firstResponseReceived = false;
              await waitForAgentRetry(delayMs);
              continue;
            }
            if (settledReplayAttempt > 0) {
              emitChannelSafe(entry, "agent_retry_end", {
                success: true,
                attempt: settledReplayAttempt,
                message: "模型连接已恢复",
                source: "workbench-settled",
              }, {}, this.deps.emitDeps);
            }
            break;
          } catch (e: any) {
            // 竞态兜底：entry.busy=false 但 pi 内部仍在收尾（compaction/post-run），
            // 此时 pi 的 isStreaming 仍为 true，重试走 steer 队列。
            if (e && typeof e.message === "string" && e.message.includes("Agent is already processing")) {
              emitChannelSafe(entry, "steer", { text: text.slice(0, 80) }, {}, this.deps.emitDeps);
              await promptWithFirstEventTimeout(this.deps.piRuntimeManager, entry, text, { ...opts, streamingBehavior: "steer" });
              break;
            }

            const info = classifyAgentError(e);
            const canContinueFromPartialRun = !continuationAttempted
              && info.retryable
              && !entry.activeToolCount
              && (entry.toolStarted || entry.turnStarted || Boolean(entry.lastAssistantText));
            if (canContinueFromPartialRun) {
              continuationAttempted = true;
              emitChannelSafe(entry, "agent_retry", {
                message: "模型连接中断，正在从当前会话继续",
                attempt: 1,
                maxAttempts: 1,
                delayMs: 300,
                source: "workbench-continuation",
                willRetry: true,
              }, {}, this.deps.emitDeps);
              await waitForPiSessionIdle(entry);
              entry.lastAgentError = null;
              entry.lastSettledError = null;
              entry.lastAssistantText = "";
              entry.turnStarted = false;
              entry.firstResponseReceived = false;
              entry.lastPiEventAt = Date.now();
              await waitForAgentRetry(300);
              try {
                await promptWithFirstEventTimeout(this.deps.piRuntimeManager, entry,
                  "上一个回合的模型连接中断了。请基于当前会话中已经完成的步骤和工具结果，从中断位置继续原任务；不要重复已经成功的副作用操作，完成后给出完整结果。",
                  {},
                );
                const continuationError = entry.lastSettledError;
                entry.lastSettledError = null;
                if (continuationError) throw createSettledAgentError(continuationError);
                emitChannelSafe(entry, "agent_retry_end", {
                  success: true,
                  attempt: 1,
                  message: "已从当前会话继续",
                  source: "workbench-continuation",
                }, {}, this.deps.emitDeps);
                break;
              } catch (continuationError: any) {
                throw continuationError;
              }
            }
            const currentSpec = entry.session?.model?.provider && entry.session?.model?.id
              ? `${entry.session.model.provider}/${entry.session.model.id}`
              : "";
            const canFallbackModel = modelFallbackTried.length < MODEL_FALLBACK_LIMIT
              && !entry.toolStarted
              && !entry.firstResponseReceived
              && info.retryable;
            if (canFallbackModel) {
              try {
                // watchdog 会先 abort 当前 Pi 回合；等待其彻底收尾后再 setModel，
                // 否则新的 provider 请求可能撞上旧的 isStreaming 状态。
                if (entry.pendingAbortPromise) {
                  await Promise.race([
                    entry.pendingAbortPromise,
                    waitForAgentRetry(3000),
                  ]);
                  entry.pendingAbortPromise = null;
                }
                if (currentSpec && !modelFallbackTried.includes(currentSpec)) modelFallbackTried.push(currentSpec);
                const fallback = await this.fallbackModel(entry, modelFallbackTried);
                if (fallback) {
                  modelFallbackAttempted = true;
                  entry.lastAgentError = null;
                  entry.lastSettledError = null;
                  entry.turnStarted = false;
                  entry.toolStarted = false;
                  entry.firstResponseReceived = false;
                  emitChannelSafe(entry, "agent_model_fallback", {
                    from: currentSpec,
                    to: fallback,
                    attempt: modelFallbackTried.length,
                    message: `模型连接失败，已切换到 ${fallback}（第 ${modelFallbackTried.length} 次切换，最多 ${MODEL_FALLBACK_LIMIT} 次）`,
                  }, {}, this.deps.emitDeps);
                  await waitForAgentRetry(300);
                  continue;
                }
              } catch (fallbackError: any) {
                emitChannelSafe(entry, "agent_model_fallback_failed", {
                  from: currentSpec,
                  message: String(fallbackError?.message || fallbackError).slice(0, 300),
                }, {}, this.deps.emitDeps);
              }
            }
            const canReplay = info.retryable && !e?.noRetry && !entry.toolStarted && transportAttempt < APP_PROMPT_RETRY_DELAYS.length;
            if (!canReplay) throw e;

            const delayMs = APP_PROMPT_RETRY_DELAYS[transportAttempt]!;
            transportAttempt += 1;
            emitChannelSafe(entry, "agent_retry", {
              message: info.message,
              attempt: transportAttempt,
              maxAttempts: APP_PROMPT_RETRY_DELAYS.length,
              delayMs,
              source: "workbench-transport",
              willRetry: true,
            }, {}, this.deps.emitDeps);
            entry.firstResponseReceived = false;
            await waitForAgentRetry(delayMs);
          }
        }
      }, {
        steer: isStreaming,
        metadata: { clientId: entry.clientId, threadId: entry.threadId, runId: entry.activeRunId },
      });
      const settledError = entry.lastSettledError;
      entry.lastSettledError = null;
      if (settledError) throw createSettledAgentError(settledError);
      // 收尾强制完成声明：本轮确实执行过工具、但没有调用 complete_task 时，追加一个
      // 只做声明的短回合（每轮最多一次），让 Run 的完成语义可判定而不是靠推断。
      if (!entry.pendingCompletion && entry.toolStarted && !entry.completionNudgeSent) {
        entry.completionNudgeSent = true;
        emitChannelSafe(entry, "completion_nudge", {
          runId: entry.activeRunId,
          message: "本轮工具执行已结束但未声明完成状态，已请求模型补充 complete_task",
        }, {}, this.deps.emitDeps);
        // 提醒回合只用于补 complete_task：不得覆盖主回合终稿，也不得产生第二份用户终稿。
        const previousSuppressFinalText = entry.suppressFinalText;
        entry.suppressFinalText = true;
        try {
          await this.deps.piRuntimeManager.runPrompt(entry.runtimeId, async () => {
            await promptWithFirstEventTimeout(this.deps.piRuntimeManager, entry, COMPLETION_NUDGE_PROMPT, {});
          }, { steer: false, metadata: { clientId: entry.clientId, threadId: entry.threadId, runId: entry.activeRunId, purpose: "completion_nudge" } });
        } catch (nudgeError: any) {
          emitChannelSafe(entry, "agent_error", {
            runId: entry.activeRunId,
            message: `补充完成状态失败：${String(nudgeError?.message || nudgeError).slice(0, 200)}`,
            code: "COMPLETION_NUDGE_FAILED",
            retryable: false,
          }, {}, this.deps.emitDeps);
        } finally {
          entry.suppressFinalText = previousSuppressFinalText;
        }
      }
    } finally {
      const activeRunId = entry.activeRunId;
      if (activeRunId) {
        try { this.deps.emitDeps?.recordRunEvent?.(activeRunId, "runtime_health", this.deps.piRuntimeManager.health(entry.runtimeId, entry.session)); } catch {}
      }
      entry.busy = false;
      entry.activeRunId = null;
      // 排队中的模型切换在本轮结束后生效：运行中的任务始终用旧模型跑完，
      // 结束后把用户选择的模型真正应用上，并广播一条 model_switched 供界面画分割线。
      if (entry.pendingModelSpec) {
        const pendingSpec = entry.pendingModelSpec;
        entry.pendingModelSpec = "";
        try {
          const applied = await this.applyModelSpec(entry, pendingSpec);
          emitChannelSafe(entry, "model_switched", {
            from: applied.from || null,
            to: applied.model,
            reason: "queued",
            effective: "now",
          }, {}, this.deps.emitDeps);
        } catch (error: any) {
          emitChannelSafe(entry, "model_switched", {
            from: null,
            to: pendingSpec,
            reason: "queued",
            effective: "failed",
            message: String(error?.message || error).slice(0, 200),
          }, {}, this.deps.emitDeps);
        }
      }
    }
  }

  /**
   * 上下文文件写入（agent.mjs L4302-4345，B6-6-4f 转正）：每次对话前刷新工作区
   * 上下文文件——线程级 `.agent-context.<threadId>.md` 是权威版本（同工作区多会话
   * 并发不互相覆盖），同时写旧文件名 `.agent-context.md` 兼容外部读取习惯；内容没变
   * 不落盘（每轮同步磁盘写的成本护栏）。T3：sharedMemCtx 可由调用方传入，同一轮内
   * 与 buildDynamicContext 共享一次记忆读取。整段失败静默吞错。
   */
  writeContextFile(entry: any, file: unknown, sharedMemCtx: any = null): void {
    try {
      const readMemoryContext = this.deps.readMemoryContext ?? readMemoryContextDefault;
      const ws = entry?.workspace || getWorkspace();
      const memCtx = sharedMemCtx ?? readMemoryContext(ws);
      const ctx = [
        "# Open Plan（规聚）Workspace",
        "",
        `- **当前工作区（绝对路径）**: ${ws}`,
        "- Office files live in the current workspace folder above. ALWAYS operate on office documents through the `officecli` tool — it resolves file names relative to the current workspace. NEVER try to run `officecli` via the bash tool.",
        "- Word 批注：先 get/query 找真实 `/body/p[...]` 路径，再用 `add <file> /body/p[N] --type comment --prop author=\\\"规聚 Agent\\\" --prop initials=OA --prop text=\\\"...\\\" --json`，完成后 query comment 校验。仅在 sharing violation 或明确的进程占用错误时关闭 WPS/Word/OfficeCLI 预览；Access denied/is denied/EPERM/EACCES 应说明服务进程写权限受限。",
        "- The bash tool may run inside WSL: Windows paths like `F:\\...` are not directly valid there; prefer the officecli tool for documents and `read`/`write` for text.",
        "- **写文件规范**: 创建任何新文件（HTML/文档/图表等）时，必须写入当前工作区（绝对路径见上），禁止写入项目目录。否则产物不会被前端检测到。",
        "- **临时文件**: 中间工作文件（脚本、JSON 片段、解包目录、备份等）请集中放在工作区内以点开头的临时目录（如 `.work/`），并在任务收尾时删除；不要把中间文件留在用户的工作区里（用户目录只应留交付产物）。",
        "- **地图（GIS）**: 地图项目位于 `" + ws + "/maps/{project}/`（默认项目 zhejiang-map 浙江省交通地图）。用户在地图模式下对话时用 map_read/map_edit/map_import 工具。",
        "",
        "## 当前工作文件（用户正在查看/编辑的文档）",
        file ? `- 当前工作文件: ${file}` : "- 当前没有打开文档",
        file
          ? "- 用户的操作默认针对此文件。修改它时直接用 officecli 操作（文件名相对工作区根目录，含子目录路径）。完成后告知用户已修改。"
          : "- 如果用户提到要修改某个文档，先用 officecli view 确认内容再操作。",
        "",
        memCtx ? "## 工作区记忆（每次任务开始前阅读；沉淀新经验请用 memory_update 工具，勿直接写文件）\n" + memCtx : "",
        "",
        "- When the user asks to modify a document, make the changes, then confirm what changed. Files are auto-refreshed in the browser.",
      ].join("\n");
      // 线程级上下文文件是权威版本（同工作区多会话并发时不互相覆盖）；
      // 同时写一份旧文件名兼容外部读取习惯。
      const threadFile = entry?.threadId ? path.join(ws, `.agent-context.${entry.threadId}.md`) : null;
      const compatFile = path.join(ws, ".agent-context.md");
      // 内容没变就不要写：这是每轮都跑的同步磁盘写（两次原子写 ≈ 0.1–0.4 秒），
      // 而绝大多数轮次的工作区/当前文件/记忆都没变。读两份小文件比写两份便宜得多。
      const sameContent = (file: string) => {
        try { return fs.existsSync(file) && fs.readFileSync(file, "utf8") === ctx; } catch { return false; }
      };
      if ((!threadFile || sameContent(threadFile)) && sameContent(compatFile)) return;
      if (threadFile) atomicWriteFile(threadFile, ctx, "utf8");
      atomicWriteFile(compatFile, ctx, "utf8");
    } catch {}
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
      const findSessionFileForAgent = this.deps.findSessionFileForAgent ?? findSessionFileForAgentDefault;
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

  // ==================== B6-6-4c 模型族批（自 agent.mjs L4419 起逐行转录） ====================

  async setModel(clientId: unknown, spec: unknown) {
    const existing = this.sessions.get(clientId);
    const entry = await this.ensureRuntime(clientId, {
      threadId: existing?.threadId || null,
      cwd: existing?.workspace || getWorkspace(),
      modelSpec: spec,
    });
    const nextSpec = String(spec || "").trim();
    if (entry.busy || entry.compacting || entry.queuedCount > 0) {
      // 运行中的任务继续用旧模型跑完（Pi 会话不支持中途换模型），把切换排队到本轮结束，
      // 不再用 "agent busy" 直接失败——那样用户会以为切换没生效，实际是"稍后生效"。
      entry.pendingModelSpec = nextSpec;
      emitChannelSafe(entry, "model_switched", {
        from: currentModelSpec(entry),
        to: nextSpec,
        reason: "queued",
        effective: "after-run",
      }, {}, this.deps.emitDeps);
      return { ok: true, model: nextSpec, pending: true, current: currentModelSpec(entry) };
    }
    const applied = await this.applyModelSpec(entry, nextSpec);
    emitChannelSafe(entry, "model_switched", {
      from: applied.from || null,
      to: applied.model,
      reason: applied.fallback ? "fallback" : "user",
      effective: "now",
    }, {}, this.deps.emitDeps);
    return applied;
  }

  /**
   * 解析并应用模型（不含忙碌排队）：成功返回 { ok, model, from, fallback? }。
   * 连接类失败时按既有策略回退 Pi 全局默认模型；认证等不可重试错误原样抛出。
   */
  async applyModelSpec(entry: any, spec: unknown) {
    // 模型 id 本身可能含斜线（如 command-code 的 deepseek/deepseek-v4-flash）：
    // 只能按第一个斜线切分 provider，否则 id 会被截断成 deepseek 并报 model not found。
    const specText = String(spec || "").trim();
    const specSeparator = specText.indexOf("/");
    if (specSeparator <= 0 || specSeparator === specText.length - 1) {
      const error = new Error("模型标识必须是 provider/model");
      (error as any).code = "MODEL_SPEC_INVALID";
      throw error;
    }
    const from = currentModelSpec(entry);
    const provider = specText.slice(0, specSeparator);
    const id = specText.slice(specSeparator + 1);
    const localModelProviders = this.deps.localModelProviders ?? localModelProvidersDefault;
    if (!localModelProviders().has(provider)) throw new Error("model is not in local Pi catalog: " + specText);
    const mr = await this.modelRuntime();
    const localStoredModels = this.deps.localStoredModels ?? localStoredModelsDefault;
    // 优先使用 Pi Runtime；当 SDK 忽略了较新的 models-store overlay 时，
    // 回退到同一份本地缓存，保证列表中的模型都可以被实际选中。
    const model = mr.getModel(provider, id) || localStoredModels().find((item: any) => item.provider === provider && item.id === id);
    if (!model) throw new Error("model not found: " + specText);
    try {
      await this.deps.piRuntimeManager.setModel(entry.runtimeId, entry.session, model);
      entry.modelFallbackSpec = "";
      entry.modelFallbackFrom = null;
      return { ok: true, model: specText, from };
    } catch (error) {
      // provider 目录可见不代表当前网络/授权可用。连接类失败时自动退回 Pi
      // 全局默认模型，避免会话再次卡在“连接模型”。认证错误等不可重试错误原样抛出。
      const configuredModelSpec = this.deps.configuredModelSpec ?? configuredModelSpecDefault;
      const fallback = configuredModelSpec();
      const info = classifyAgentError(error);
      if (!fallback || fallback === specText || !info.retryable) throw error;
      const [fallbackProvider, ...fallbackIdParts] = fallback.split("/");
      const fallbackId = fallbackIdParts.join("/");
      const fallbackModel = mr.getModel(fallbackProvider, fallbackId)
        || localStoredModels().find((item: any) => item.provider === fallbackProvider && item.id === fallbackId);
      if (!fallbackModel) throw error;
      await this.deps.piRuntimeManager.setModel(entry.runtimeId, entry.session, fallbackModel);
      entry.modelFallbackSpec = fallback;
      entry.modelFallbackFrom = specText;
      return { ok: true, model: fallback, from, modelFallbackFrom: specText, fallback: true };
    }
  }

  async probeModel(spec: unknown, options: any = {}) {
    const value = String(spec || "").trim();
    const separator = value.indexOf("/");
    if (separator <= 0 || separator === value.length - 1) {
      const error = new Error("模型标识必须是 provider/model");
      (error as any).code = "MODEL_SPEC_INVALID";
      throw error;
    }
    const provider = value.slice(0, separator);
    const id = value.slice(separator + 1);
    const localModelProviders = this.deps.localModelProviders ?? localModelProvidersDefault;
    if (!localModelProviders().has(provider)) {
      const error = new Error("模型不在 Pi 本地目录中：" + value);
      (error as any).code = "MODEL_NOT_IN_CATALOG";
      throw error;
    }
    const runtime = await this.modelRuntime();
    const localStoredModels = this.deps.localStoredModels ?? localStoredModelsDefault;
    const model = runtime.getModel(provider, id)
      || localStoredModels().find((item: any) => item.provider === provider && item.id === id);
    if (!model) {
      const error = new Error("模型未找到：" + value);
      (error as any).code = "MODEL_NOT_FOUND";
      throw error;
    }
    const result = await this.deps.piRuntimeManager.probeModel(model, options);
    clearInvalidCredential(provider);
    const text = Array.isArray(result.response?.content)
      ? result.response.content.filter((item: any) => item?.type === "text").map((item: any) => item.text || "").join("").trim().slice(0, 80)
      : "";
    return {
      ok: true,
      model: value,
      provider,
      latencyMs: result.latencyMs,
      response: {
        stopReason: result.response?.stopReason || null,
        responseModel: result.response?.responseModel || result.response?.model || null,
        preview: text,
        usage: result.response?.usage ? {
          input: result.response.usage.input || 0,
          output: result.response.usage.output || 0,
          totalTokens: result.response.usage.totalTokens || 0,
        } : null,
      },
    };
  }

  async fallbackModel(entry: any, triedSpecs: unknown = []) {
    const configuredModelSpec = this.deps.configuredModelSpec ?? configuredModelSpecDefault;
    const tried = new Set((Array.isArray(triedSpecs) ? triedSpecs : [triedSpecs]).filter(Boolean));
    const catalog = await this.listModelCatalog();
    const available = new Map((catalog.available || []).map((item: any) => [item.id, item] as [string, any]));
    const preferred = [
      configuredModelSpec(),
      "minimax-cn/MiniMax-M2.7-highspeed",
      "minimax-cn/MiniMax-M2.7",
      "deepseek/deepseek-v4-flash",
      "opencode-go/mimo-v2.5",
      "opencode-go/hy3",
    ];
    // 先排除已经试过的 provider/model，并优先换到另一个 provider；
    // 同一 provider 下没有别的可用模型时，才退回该 provider 的其他模型。
    const failedProvider = String([...tried].pop() || "").split("/")[0];
    const candidates = [...new Set([...preferred, ...available.keys()])]
      .map((specId) => available.get(specId))
      .filter((item: any) => item && !tried.has(item.id));
    const candidate = candidates.find((item: any) => item.provider !== failedProvider) || candidates[0];
    if (!candidate) return null;
    const [provider, ...idParts] = candidate.id.split("/");
    const id = idParts.join("/");
    const runtime = await this.modelRuntime();
    const localStoredModels = this.deps.localStoredModels ?? localStoredModelsDefault;
    const model = runtime.getModel(provider, id)
      || localStoredModels().find((item: any) => item.provider === provider && item.id === id);
    if (!model) return null;
    await this.deps.piRuntimeManager.setModel(entry.runtimeId, entry.session, model);
    entry.modelFallbackSpec = candidate.id;
    entry.modelFallbackFrom = [...tried].pop() || null;
    return candidate.id;
  }

  async listModelCatalog() {
    const mr = await this.modelRuntime();
    const localModelProviders = this.deps.localModelProviders ?? localModelProvidersDefault;
    const providers = localModelProviders();
    const localStoredModels = this.deps.localStoredModels ?? localStoredModelsDefault;
    const stored = localStoredModels(providers);
    const runtimeModels = [...mr.getModels()].filter((m: any) => providers.has(m.provider) && m.enabled !== false);
    const configured = [...runtimeModels];
    const available = [...await mr.getAvailable()].filter((m: any) => providers.has(m.provider) && m.enabled !== false);
    const availableKeys = new Set(available.map((m: any) => `${m.provider}/${m.id}`));
    const getCredentialErrors = this.deps.getCredentialErrors ?? getCredentialErrorsDefault;
    const authErrors = getCredentialErrors();
    const normalize = (m: any) => {
      const authError = authErrors[m.provider] || null;
      return {
        id: m.provider + "/" + m.id,
        provider: m.provider,
        name: m.name || m.id,
        vision: !!m.vision,
        available: availableKeys.has(`${m.provider}/${m.id}`) && !authError,
        ...(authError ? { authError: authError.message } : {}),
        ...(Number(m.contextWindow || m.contextLength || m.limit?.context) > 0
          ? { contextWindow: Math.floor(Number(m.contextWindow || m.contextLength || m.limit.context)) }
          : {}),
      };
    };
    const merged = new Map<any, any>();
    for (const model of configured) merged.set(`${model.provider}/${model.id}`, normalize(model));
    // Pi TUI 读取 models-store 中的动态目录；放在 Runtime 后合并，
    // 让本地缓存中的新名称、能力和计费信息覆盖旧内置条目。
    for (const model of stored) merged.set(`${model.provider}/${model.id}`, normalize(model));
    for (const model of available) merged.set(`${model.provider}/${model.id}`, normalize(model));
    const configuredCatalog = [...new Map([
      ...configured.map((model: any) => [`${model.provider}/${model.id}`, normalize(model)] as [string, any]),
      ...stored.map((model: any) => [`${model.provider}/${model.id}`, normalize(model)] as [string, any]),
    ]).values()];
    // 过滤已知无效/无订阅的模型，避免被误选后触发 400 报错（连接稳定性）
    const DENY_MODELS = new Set([
      "new-provider/step-3.7-flash",        // stepfun 无有效订阅
      "xiaomi-token-plan-cn/mimo-v2.5-pro", // 端点不支持 -pro 变种
    ]);
    const DENY_PROVIDERS = new Set(["new-provider"]);
    const isDenied = (m: any) => DENY_MODELS.has(`${m.provider}/${m.id}`) || DENY_PROVIDERS.has(m.provider);
    const models = [...merged.values()].filter((m) => !isDenied(m));
    const configuredFiltered = configuredCatalog.filter((m: any) => !isDenied(m));
    return {
      // 下拉框展示 Pi 已配置目录中的全部模型；available 只表示当前运行时已确认可用。
      models,
      configured: configuredFiltered,
      available: available.map(normalize).filter((m: any) => !isDenied(m) && !authErrors[m.provider]),
      counts: { available: available.length, configured: configuredFiltered.length, stored: stored.length, listed: models.length },
      source: "pi-model-runtime+models-store",
      authErrors,
    };
  }

  async listModels() {
    return (await this.listModelCatalog()).models;
  }

  /** 重新扫描模型：重置 ModelRuntime 缓存并重新构建（模型配置变更后调用） */
  async refreshModels() {
    this.deps.piRuntimeManager.resetModelRuntime();
    const mr = await this.modelRuntime();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      // 与 Pi TUI 的目录刷新保持一致：优先从供应商更新 models-store，
      // 网络不可达时由 SDK 恢复本地缓存，不能阻塞模型选择和离线功能。
      await mr.refresh({ allowNetwork: true, signal: controller.signal });
    } catch (error: any) {
      if (error?.name !== "AbortError") {
        console.warn("[models] 远程目录刷新失败，继续使用 Pi 本地缓存：", error?.message || error);
      }
    } finally {
      clearTimeout(timeout);
    }
    return (await this.listModelCatalog()).models;
  }

  async disposeAll() {
    await this.deps.piRuntimeManager.disposeAll([...this.sessions.values()]);
    this.sessions.clear();
  }
}
