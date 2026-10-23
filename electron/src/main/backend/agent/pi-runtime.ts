/**
 * Pi Runtime 管理域（B6-7 批，自 server/pi-runtime-management.mjs 全量转录，668 行）。
 *
 * 转录范围（与旧模块逐行对齐）：
 *  - 模块级常量：RUNTIME_RECORD_FILE / PI_PACKAGE_VERSION / PI_COMPACTION_POLICY（pi 域
 *    单一事实源，agent-manager.ts PI_COMPACTION_POLICY_DEFAULT 与 subagent-tools.ts 本地
 *    副本自本批起收敛为 import）/ RUNTIME_RECORD_LIMIT=120 / DEFAULT_AGENT_CONCURRENCY=2 /
 *    DEFAULT_OFFICE_CONCURRENCY=1；
 *  - 辅助函数族：now/positiveInteger/readCredentials/readCredentialsFromConfig/
 *    localCredentialStore/modelSnapshot/safeRuntimeRecord；
 *  - AsyncLimiter（异步资源闸门）；
 *  - runtimeCapabilities（U3 能力声明）/ contextTokensFromUsage（U1 精确上下文纯函数）；
 *  - PiRuntimeManager（~35 方法：会话生命周期/记录台账/网络适配/模型探测/abort 识别/
 *    会话树导航/持久化）；
 *  - 尾部单例：piRuntimeManager / officeLimiter + Pi SDK 构造器 re-export（agent 业务层
 *    统一从本模块取 Pi 依赖）。
 *
 * 行为保真说明：
 *  - 模块级单例 piRuntimeManager 在 import 时构造（与旧模块一致）：读 OAW_RUNTIME_RECORD_FILE
 *    环境变量、loadNetworkSettings()（AGENT_DIR 下网络代理.json，缺省回落）、加载既有运行时
 *    记录并把活跃态标记为 recovering。测试须先 stub OAW_DATA_DIR/OAW_RUNTIME_RECORD_FILE
 *    再动态 import（b6-pi-runtime-parity.test.ts beforeAll 同口径）。
 *  - Pi SDK 的动态调用面（SessionManager.open/create、SettingsManager.inMemory、
 *    ModelRuntime.create、createAgentSession）旧 JS 为全动态形状，TS 侧以 any 断言调用，
 *    行为不变；modelRuntime/createSession/probeModel 依赖真实 SDK 运行时与网络，对拍测试
 *    不覆盖（签名已按 AgentPiRuntimeSeam 17 方法核对）。
 *  - error 附加字段（code/provider/model/errorCategory/oawClassification）旧 JS 直接挂在
 *    Error 上，TS 侧经 any 断言补齐，语义一致。
 */
import path from "node:path";
import crypto from "node:crypto";
import {
  calculateContextTokens,
  createBashToolDefinition,
  createEditToolDefinition,
  createLocalBashOperations,
  createReadToolDefinition,
  createWriteToolDefinition,
  DefaultResourceLoader,
  createAgentSession,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { PROJECT_DIR, AGENT_DIR } from "../workspace";
import { RUNTIME_FLAGS } from "../../../shared/runtime/feature-flags";
import { getPiConfigPaths, loadNetworkSettings, readCredentials as readConfigCredentials, writeCredentials as writeConfigCredentials } from "./pi-config-management";
import { atomicWriteJson, ensureDirectory, readJsonFile } from "../persistence-utils";
import {
  classifyPiError,
  createPiNetworkAdapter,
  redactProxyUrl,
  resolvePiNetworkSettings,
  wrapPiAgentStreamFunction,
  type PiNetworkAdapter,
  type PiNetworkSettings,
} from "./pi-network-proxy";

const RUNTIME_RECORD_FILE = process.env.OAW_RUNTIME_RECORD_FILE || path.join(PROJECT_DIR, ".oaw", "运行时记录.json");
export const PI_PACKAGE_VERSION = "1.1.0";
/**
 * Pi 原生上下文压缩策略（唯一事实来源）。
 * reserveTokens：接近窗口上限时预留的输出/工具空间，压缩线 = contextWindow − reserveTokens；
 * keepRecentTokens：压缩后保留的最近上下文，保证任务连续性。
 * 前端「上下文」浮层直接展示这两个数字，避免用户误以为 UI 的 60%/85% 颜色阈值就是压缩线。
 */
export const PI_COMPACTION_POLICY: Readonly<{ reserveTokens: number; keepRecentTokens: number }> =
  Object.freeze({ reserveTokens: 16384, keepRecentTokens: 20000 });
const RUNTIME_RECORD_LIMIT = 120;
const DEFAULT_AGENT_CONCURRENCY = 2;
const DEFAULT_OFFICE_CONCURRENCY = 1;

function now(): string {
  return new Date().toISOString();
}

function positiveInteger(value: unknown, fallback: number): number {
  const number = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function readCredentials(): Record<string, any> {
  return readCredentialsFromConfig();
}

function readCredentialsFromConfig(): Record<string, any> {
  return readConfigCredentials({ dir: AGENT_DIR });
}

function localCredentialStore() {
  return {
    read: async (provider: string) => readCredentials()[provider],
    list: async () => Object.entries(readCredentials()).map(([providerId, value]) => ({ providerId, type: value?.type })),
    modify: async (provider: string, fn: (current: any) => any) => {
      const auth = readCredentials();
      const next = await fn(auth[provider]);
      if (next === undefined) return auth[provider];
      auth[provider] = next;
      writeConfigCredentials(auth, { dir: AGENT_DIR });
      return next;
    },
    delete: async (provider: string) => {
      const auth = readCredentials();
      delete auth[provider];
      writeConfigCredentials(auth, { dir: AGENT_DIR });
    },
  };
}

export interface RuntimeModelSnapshot {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  vision: boolean;
  contextWindow?: number;
}

export interface RuntimeHealth {
  status: string;
  checkedAt: string | null;
  message: string | null;
  category?: string;
}

export interface RuntimeRecord {
  version: number;
  runtimeId: string;
  key: string | null;
  clientId: string | null;
  threadId: string | null;
  cwd: string | null;
  status: string;
  health: RuntimeHealth;
  provider: string | null;
  model: RuntimeModelSnapshot | null;
  profile: string;
  toolPolicyVersion: string;
  toolPolicy: unknown;
  piPackageVersion: string;
  capabilities: typeof runtimeCapabilities;
  recoveryChain: Array<Record<string, unknown>>;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  networkMode: string;
  errorCategory: string | null;
  error: Record<string, unknown> | null;
  sessionId?: string | null;
  abortRequestedAt?: number;
  thinkingLevel?: unknown;
  scheduler?: Record<string, unknown>;
  [key: string]: unknown;
}

function modelSnapshot(model: any): RuntimeModelSnapshot | null {
  if (!model) return null;
  const contextWindow = Number(model.contextWindow || model.contextLength || model.limit?.context);
  return {
    provider: String(model.provider || ""),
    id: String(model.id || ""),
    name: String(model.name || model.id || ""),
    reasoning: model.reasoning === true,
    vision: model.vision === true,
    ...(contextWindow > 0 ? { contextWindow: Math.floor(contextWindow) } : {}),
  };
}

function safeRuntimeRecord(record: any): Record<string, unknown> | null {
  if (!record || typeof record !== "object") return null;
  const { session, modelRuntime, error, ...publicRecord } = record;
  const classification = error?.classification || null;
  return {
    ...publicRecord,
    error: error ? {
      code: error.code || null,
      category: error.category || classification?.code || null,
      retryable: error.retryable ?? classification?.retryable ?? false,
      status: error.status ?? classification?.status ?? null,
      message: String(error.message || classification?.message || error).slice(0, 500),
    } : null,
  };
}

/**
 * 一个小型异步资源闸门。它只限制"正在调用模型/Office 子进程"的数量，
 * 不限制 SSE、历史读取和已存在会话的切换，因此不会把多子对话误认为互斥。
 */
export class AsyncLimiter {
  limit: number;
  name: string;
  active = 0;
  queue: Array<{ metadata: Record<string, unknown>; queuedAt: string; resolve?: (release: () => void) => void }> = [];
  started = 0;
  completed = 0;

  constructor(limit: number | string | null | undefined = 1, name = "resource") {
    this.limit = positiveInteger(limit, 1);
    this.name = name;
    this.active = 0;
    this.queue = [];
    this.started = 0;
    this.completed = 0;
  }

  async acquire(metadata: Record<string, unknown> = {}): Promise<() => void> {
    const item: { metadata: Record<string, unknown>; queuedAt: string; resolve?: (release: () => void) => void } = { metadata, queuedAt: now() };
    if (this.active < this.limit) {
      this.active += 1;
      this.started += 1;
      return this.release.bind(this);
    }
    return new Promise((resolve) => {
      item.resolve = resolve;
      this.queue.push(item);
    });
  }

  release(): void {
    if (this.active > 0) this.active -= 1;
    this.completed += 1;
    const next = this.queue.shift();
    if (!next) return;
    this.active += 1;
    this.started += 1;
    next.resolve!(this.release.bind(this));
  }

  async run<T>(fn: () => Promise<T> | T, metadata: Record<string, unknown> = {}): Promise<T> {
    const release = await this.acquire(metadata);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  snapshot(): { name: string; limit: number; active: number; queued: number; started: number; completed: number } {
    return {
      name: this.name,
      limit: this.limit,
      active: this.active,
      queued: this.queue.length,
      started: this.started,
      completed: this.completed,
    };
  }
}

export const runtimeCapabilities = Object.freeze({
  // U3：会话树导航已接线（navigateTree/getTree 经 PiRuntimeManager 透传）。
  nativeFork: { status: "available", message: "会话树导航（navigateTree）已绑定工作台分支端点；文件级 fork 由会话树承载。" },
  nativeCheckpoint: { status: "unsupported", message: "当前没有 token 级检查点；使用 JSONL 会话重开 + 恢复提示词。" },
  replay: { status: "fallback", message: "支持从 JSONL 会话文件恢复，并由 Run 恢复链重新执行未完成目标。" },
});

/**
 * U1（上下文预算精确化）：Pi SDK 原生 compaction 纯函数 `calculateContextTokens(usage)`
 * （compaction.d.ts L38）的容错包装。usage 缺失/形状异常时返回 null，调用方回落估算。
 */
export function contextTokensFromUsage(usage: unknown): number | null {
  try {
    if (!usage || typeof usage !== "object") return null;
    const tokens = calculateContextTokens(usage as any);
    return Number.isFinite(tokens) && tokens >= 0 ? tokens : null;
  } catch {
    return null;
  }
}

export interface PiRuntimeManagerOptions {
  recordFile?: string;
  agentConcurrency?: number | string | null;
  officeConcurrency?: number | string | null;
  network?: Record<string, any>;
}

/**
 * Pi 的唯一生命周期入口。业务层只通过本类创建、恢复、停止、压缩和调用会话，
 * Pi SDK 的依赖、凭据目录以及能力降级都集中在这里，后续可以替换为 Pi 原生 runtime。
 */
export class PiRuntimeManager {
  recordFile: string;
  networkSettings: PiNetworkSettings;
  networkAdapterInstance: PiNetworkAdapter | null;
  modelRuntimePromise: Promise<any> | null;
  records: RuntimeRecord[];
  agentLimiter: AsyncLimiter;
  officeLimiter: AsyncLimiter;

  constructor({ recordFile = RUNTIME_RECORD_FILE, agentConcurrency = process.env.OAW_MAX_AGENT_RUNS, officeConcurrency = process.env.OAW_MAX_OFFICECLI, network = {} }: PiRuntimeManagerOptions = {}) {
    this.recordFile = recordFile;
    this.networkSettings = resolvePiNetworkSettings(Object.keys(network || {}).length ? network : loadNetworkSettings());
    this.networkAdapterInstance = null;
    this.modelRuntimePromise = null;
    this.records = loadRuntimeRecordsFrom(recordFile);
    this.agentLimiter = new AsyncLimiter(positiveInteger(agentConcurrency, DEFAULT_AGENT_CONCURRENCY), "agent");
    this.officeLimiter = new AsyncLimiter(positiveInteger(officeConcurrency, DEFAULT_OFFICE_CONCURRENCY), "officecli");
    this.markPersistedRuntimesRecovering();
  }

  networkAdapter(): PiNetworkAdapter {
    if (!this.networkAdapterInstance) this.networkAdapterInstance = createPiNetworkAdapter(this.networkSettings);
    return this.networkAdapterInstance;
  }

  networkDiagnostics(): Record<string, any> {
    return this.networkAdapterInstance?.diagnostics?.() || {
      mode: this.networkSettings.mode,
      noProxy: this.networkSettings.noProxy,
      proxy: redactProxyUrl(this.networkSettings.mode === "manual"
        ? this.networkSettings.proxyUrl
        : this.networkSettings.httpsProxy || this.networkSettings.httpProxy),
      hasProxy: Boolean(this.networkSettings.proxyUrl || this.networkSettings.httpsProxy || this.networkSettings.httpProxy),
      closed: false,
    };
  }

  /** 更新网络配置时先关闭旧连接池；会话通过动态 fetch 在下一次请求使用新配置。 */
  updateNetworkSettings(settings: Record<string, any> = loadNetworkSettings() as Record<string, any>): Record<string, any> {
    this.networkAdapterInstance?.close?.();
    this.networkAdapterInstance = null;
    this.networkSettings = resolvePiNetworkSettings(settings || {});
    return this.networkDiagnostics();
  }

  modelRuntime(): Promise<any> {
    if (!this.modelRuntimePromise) {
      const paths = getPiConfigPaths(AGENT_DIR);
      const promise = (ModelRuntime as any).create({
        authPath: paths.authPath,
        modelsPath: paths.modelsPath,
        modelsStorePath: paths.modelsStorePath,
        credentials: localCredentialStore(),
      }).catch((error: any) => {
        this.modelRuntimePromise = null;
        throw error;
      });
      this.modelRuntimePromise = promise;
    }
    return this.modelRuntimePromise!;
  }

  resetModelRuntime(): void {
    this.modelRuntimePromise = null;
  }

  async createSession(args: any = {}): Promise<any> {
    const { cwd, sessionPath = null, sessionStore = null, ...options } = args;
    const sessionManager = sessionPath
      ? (SessionManager as any).open(sessionPath, sessionStore || undefined, cwd)
      : (SessionManager as any).create(cwd, sessionStore || undefined);
    const settingsManager = options.settingsManager || (SettingsManager as any).inMemory({
      // 上下文压缩交给 Pi 按当前模型的 contextWindow 自动判断；
      // 明确保留输出/工具调用空间，避免工作台另设固定 token 线与 Pi 竞争。
      compaction: { enabled: true, reserveTokens: PI_COMPACTION_POLICY.reserveTokens, keepRecentTokens: PI_COMPACTION_POLICY.keepRecentTokens },
      // U10（flag 控制）：Pi 原生 CacheWarmer——Run 进行中以一次 1-token 请求保活
      // 提示词缓存（streaming 模式），用户思考/审批期间缓存不失效，下一请求省去
      // 全量 cache miss 重算。off（默认）不配置，行为与基线一致。
      ...(RUNTIME_FLAGS.cacheWarming ? { cacheWarming: "streaming" } : {}),
      // 工作台自己负责备用模型和最终失败收敛；Pi 只保留一次短重试，
      // 避免供应商不可达时叠加多层指数退避，把界面长时间卡
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 800, provider: { maxRetries: 0 } },
    });
    const modelRuntime = options.modelRuntime || await this.modelRuntime();
    const result = await (createAgentSession as any)({ ...options, cwd, modelRuntime, sessionManager, settingsManager });
    const dynamicFetch = (...fetchArgs: Parameters<PiNetworkAdapter["fetch"]>) => this.networkAdapter().fetch(...fetchArgs);
    if (!wrapPiAgentStreamFunction(result.session, dynamicFetch)) {
      throw new Error("Pi AgentSession 未提供可注入网络适配器的 agent.streamFunction");
    }
    return { ...result, sessionManager };
  }

  beginRuntime({ key, clientId, threadId, cwd, profile = "通用 Agent", toolPolicyVersion = "task-tool-policy-v1" }: any = {}): RuntimeRecord {
    const previous = [...this.records].reverse().find((item) => item.key === key);
    const record: RuntimeRecord = {
      version: 1,
      runtimeId: `runtime_${crypto.randomUUID()}`,
      key: key || null,
      clientId: clientId || null,
      threadId: threadId || null,
      cwd: cwd || null,
      status: "creating",
      health: { status: "starting", checkedAt: null, message: null },
      provider: null,
      model: null,
      profile: profile || "通用 Agent",
      toolPolicyVersion,
      toolPolicy: null,
      piPackageVersion: PI_PACKAGE_VERSION,
      capabilities: runtimeCapabilities,
      recoveryChain: previous?.runtimeId ? [{ runtimeId: previous.runtimeId, reason: "previous_runtime" }] : [],
      createdAt: now(),
      updatedAt: now(),
      lastActivityAt: now(),
      networkMode: this.networkSettings.mode,
      errorCategory: null,
      error: null,
    };
    this.records.push(record);
    this.trimAndPersist();
    return record;
  }

  bindSession(runtimeId: string, { session, profile, toolPolicyVersion, toolPolicy }: any = {}): RuntimeRecord | null {
    const record = this.find(runtimeId);
    if (!record) return null;
    record.status = "idle";
    record.health = { status: "healthy", checkedAt: now(), message: null };
    record.sessionId = session?.sessionId || null;
    record.provider = session?.model?.provider || null;
    record.model = modelSnapshot(session?.model);
    record.profile = profile || record.profile || "通用 Agent";
    record.toolPolicyVersion = toolPolicyVersion || record.toolPolicyVersion;
    record.toolPolicy = toolPolicy || record.toolPolicy || null;
    record.updatedAt = now();
    record.lastActivityAt = record.updatedAt;
    this.trimAndPersist();
    return record;
  }

  update(runtimeId: string, patch: Record<string, any> = {}): RuntimeRecord | null {
    const record = this.find(runtimeId);
    if (!record) return null;
    Object.assign(record, patch, { updatedAt: now(), lastActivityAt: now() });
    if (patch.model) record.model = modelSnapshot(patch.model);
    this.trimAndPersist();
    return record;
  }

  markFailure(runtimeId: string, error: unknown, { recovering = false, reason = "runtime_error" }: { recovering?: boolean; reason?: string } = {}): RuntimeRecord | null {
    const record = this.find(runtimeId);
    if (!record) return null;
    const err = error as any;
    const classification = classifyPiError(error, {
      mode: this.networkSettings.mode,
      provider: record.provider,
      model: record.model?.id,
    });
    record.status = recovering ? "recovering" : "failed";
    record.health = {
      status: recovering ? "degraded" : "failed",
      checkedAt: now(),
      message: classification.message,
      category: classification.code,
    };
    record.errorCategory = classification.code;
    record.error = {
      code: err?.code && ["PI_SETTLED_ERROR", "MODEL_TIMEOUT", "MODEL_STREAM_TIMEOUT", "MODEL_PROBE_TIMEOUT"].includes(String(err.code))
        ? String(err.code)
        : classification.code,
      category: classification.code,
      retryable: classification.retryable,
      status: classification.status,
      message: classification.message,
      classification,
    };
    record.recoveryChain = [...(record.recoveryChain || []), { at: now(), reason, status: record.status }].slice(-20);
    this.trimAndPersist();
    return record;
  }

  markRecovery(runtimeId: string, reason = "manual_recovery"): RuntimeRecord | null {
    const record = this.find(runtimeId);
    if (!record) return null;
    record.status = "recovering";
    record.health = { status: "degraded", checkedAt: now(), message: "等待恢复入口" };
    record.recoveryChain = [...(record.recoveryChain || []), { at: now(), reason, status: "recovering" }].slice(-20);
    this.trimAndPersist();
    return record;
  }

  async runPrompt(runtimeId: string, operation: () => Promise<any>, { steer = false, metadata = {} }: { steer?: boolean; metadata?: Record<string, unknown> } = {}): Promise<any> {
    const record = this.find(runtimeId);
    if (record) this.update(runtimeId, { status: steer ? "running" : "queued", health: { status: "healthy", checkedAt: now(), message: null }, error: null });
    const execute = async (): Promise<any> => {
      if (record) this.update(runtimeId, { status: "running" });
      try {
        return await operation();
      } catch (error: any) {
        // 用户主动中断会让进行中的 prompt 以 "Request aborted" 拒绝：
        // 这不是运行时故障，不能标成 failed——否则下一次发送会把它当作失效
        // 运行时重建，用户看到的是"中断之后下一条消息启动特别慢"。
        if (this.isUserAbort(record, error)) {
          this.update(runtimeId, {
            status: "idle",
            health: { status: "healthy", checkedAt: now(), message: null },
            error: null,
            recoveryChain: [...(record?.recoveryChain || []), { at: now(), reason: "user_abort", status: "idle" }].slice(-20),
          });
          throw error;
        }
        this.markFailure(runtimeId, error, { recovering: false });
        throw error;
      } finally {
        const current = this.find(runtimeId);
        if (current && current.status === "running") this.update(runtimeId, { status: "idle", health: { status: "healthy", checkedAt: now(), message: null } });
      }
    };
    return steer ? execute() : this.agentLimiter.run(execute, { runtimeId, ...metadata });
  }

  prompt(_runtimeId: string, session: any, text: unknown, options: any = {}): any {
    return session.prompt(text, options);
  }

  async abort(runtimeId: string, session: any): Promise<void> {
    const record = this.find(runtimeId);
    if (record) {
      // 打上中断标记：随后 prompt 以 "Request aborted" 收尾时要能识别成"用户中断"而非故障。
      record.abortRequestedAt = Date.now();
      this.update(runtimeId, { status: "aborting" });
    }
    try {
      await session?.abort?.();
      if (record) this.update(runtimeId, { status: "idle", health: { status: "healthy", checkedAt: now(), message: null } });
    } catch (error: any) {
      if (this.isUserAbort(record, error)) {
        if (record) this.update(runtimeId, { status: "idle", health: { status: "healthy", checkedAt: now(), message: null }, error: null });
        return;
      }
      this.markFailure(runtimeId, error, { reason: "abort_failed" });
      throw error;
    }
  }

  /** 这次收尾是否属于"用户主动中断"（中断标记 + 错误形如中断）。 */
  isUserAbort(record: RuntimeRecord | null | undefined, error: any): boolean {
    if (!record) return false;
    const requested = record.status === "aborting"
      || (record.abortRequestedAt && Date.now() - record.abortRequestedAt < 120000);
    if (!requested) return false;
    const message = String(error?.message || error?.cause?.message || error || "");
    return /(?:request\s+aborted|aborted|aborting|\babort\b|cancelled|canceled|interrupted|用户请求中断|已中断|已取消)/i.test(message);
  }

  async compact(runtimeId: string, session: any, instructions = ""): Promise<any> {
    const record = this.find(runtimeId);
    if (record) this.update(runtimeId, { status: "compacting" });
    try {
      const result = await session.compact(instructions || undefined);
      if (record) this.update(runtimeId, { status: "idle", health: { status: "healthy", checkedAt: now(), message: null } });
      return result;
    } catch (error: any) {
      this.markFailure(runtimeId, error, { recovering: true, reason: "compact_failed" });
      throw error;
    }
  }

  async setModel(runtimeId: string, session: any, model: any): Promise<void> {
    try {
      await session.setModel(model);
      this.update(runtimeId, { provider: model?.provider || null, model: modelSnapshot(model), status: "idle" });
    } catch (error: any) {
      this.markFailure(runtimeId, error, { recovering: false, reason: "model_switch_failed" });
      throw error;
    }
  }

  /**
   * 只探测 provider 的真实请求链路，不创建/改写用户会话。
   * 模型目录可见、凭据已配置并不等于当前网络和网关真的可用；
   * 连接测试必须走和 Agent 相同的 Pi ModelRuntime。
   */
  async probeModel(model: any, { timeoutMs = 15000 }: { timeoutMs?: number | string } = {}): Promise<any> {
    const runtime = await this.modelRuntime();
    const limit = Math.max(5000, Math.min(30000, Number.parseInt(String(timeoutMs), 10) || 15000));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limit);
    const startedAt = Date.now();
    const sessionId = `probe-${crypto.randomUUID()}`;
    try {
      const response = await runtime.completeSimple(model, {
        messages: [{ role: "user", content: "Reply with OK only.", timestamp: Date.now() }],
      }, {
        signal: controller.signal,
        timeoutMs: limit,
        maxRetries: 0,
        maxRetryDelayMs: 1000,
        // Anthropic Messages 传输在 reasoning="off" 时算不出思考预算（budget 未定义），
        // max_tokens 会变成 null 而被网关判为非法参数，把真实错误（如套餐不含该模型）掩盖掉。
        reasoning: model?.api === "anthropic-messages" ? "low" : "off",
        maxTokens: 16,
        fetch: this.networkAdapter().fetch,
        // OpenCode Go 要求 x-opencode-session；Pi Agent 本身会自动传递
        // SessionManager 的 ID，这个独立探测也必须保持同一请求语义。
        sessionId,
        ...(model?.provider === "opencode" || model?.provider === "opencode-go"
          ? { headers: { "x-opencode-session": sessionId, "x-opencode-client": "pi" } }
          : {}),
      });
      if (response?.stopReason === "error" || response?.errorMessage) {
        const error: any = new Error(response.errorMessage || "模型返回错误");
        error.code = "PI_SETTLED_ERROR";
        error.provider = model?.provider || null;
        error.model = model?.id || null;
        throw error;
      }
      return { response, latencyMs: Date.now() - startedAt };
    } catch (error: any) {
      if (controller.signal.aborted && error?.name !== "AbortError") {
        error.code = error.code || "MODEL_PROBE_TIMEOUT";
      } else if (controller.signal.aborted) {
        const timeoutError: any = new Error(`模型连接测试超过 ${Math.round(limit / 1000)} 秒没有响应`);
        timeoutError.code = "MODEL_PROBE_TIMEOUT";
        timeoutError.provider = model?.provider || null;
        timeoutError.model = model?.id || null;
        throw timeoutError;
      }
      const classification = classifyPiError(error, { mode: this.networkSettings.mode, provider: model?.provider, model: model?.id });
      error.errorCategory = classification.code;
      error.oawClassification = classification;
      if (!error.code || !["PI_SETTLED_ERROR", "MODEL_PROBE_TIMEOUT"].includes(String(error.code))) error.code = classification.code;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  setActiveTools(runtimeId: string, session: any, tools: unknown): void {
    try {
      session.setActiveToolsByName([...new Set(Array.isArray(tools) ? tools : [])]);
      this.update(runtimeId, { toolPolicy: { tools: [...new Set(Array.isArray(tools) ? tools : [])] } });
    } catch (error: any) {
      this.markFailure(runtimeId, error, { recovering: false, reason: "tool_policy_apply_failed" });
      throw error;
    }
  }

  setThinkingLevel(runtimeId: string, session: any, level: unknown): void {
    try {
      session.setThinkingLevel(level);
      this.update(runtimeId, { thinkingLevel: level });
    } catch (error: any) {
      this.markFailure(runtimeId, error, { recovering: false, reason: "thinking_level_apply_failed" });
      throw error;
    }
  }

  /**
   * U1（上下文预算精确化）：读取 Pi SDK 原生上下文用量（agent-session.d.ts L874
   * `getContextUsage(): ContextUsage | undefined`）。无 usage（非流式/新会话/极端
   * 路径）时返回 null，调用方回落到既有估算逻辑。
   */
  getContextUsage(_runtimeId: string, session: any): any {
    try {
      const usage = typeof session?.getContextUsage === "function" ? session.getContextUsage() : undefined;
      return usage && typeof usage === "object" ? usage : null;
    } catch {
      return null;
    }
  }

  /** U3：读取会话树（session-manager.d.ts L340 `getTree(): SessionTreeNode[]`）。 */
  getSessionTree(_runtimeId: string, sessionManager: any): any {
    try {
      return typeof sessionManager?.getTree === "function" ? sessionManager.getTree() : null;
    } catch {
      return null;
    }
  }

  /**
   * U3：会话树导航（agent-session.d.ts L850 `navigateTree(targetId, options)`）。
   * 同一会话文件内切换到目标节点（分支切换，可带被弃分支摘要）；不创建新文件。
   * options: { summarize?: boolean, customInstructions?: string, label?: string }
   */
  async navigateSessionTree(_runtimeId: string, session: any, targetId: unknown, options: any = {}): Promise<any> {
    if (typeof session?.navigateTree !== "function") {
      throw new Error("当前 Pi 会话不支持会话树导航（navigateTree 不可用）");
    }
    return session.navigateTree(String(targetId || ""), options);
  }

  health(runtimeId: string, session: any, overrides: Record<string, any> = {}): Record<string, unknown> | null {
    const record = this.find(runtimeId);
    if (!record) return null;
    const streaming = Boolean(session?.isStreaming);
    const idle = typeof session?.isIdle === "boolean" ? session.isIdle : !streaming;
    const status = record.status === "failed" ? "failed" : streaming ? "running" : idle ? "healthy" : "degraded";
    const next: Record<string, any> = {
      ...record,
      status: record.status === "failed" ? "failed" : streaming ? "running" : "idle",
      health: { status, checkedAt: now(), message: record.health?.message || null },
      sessionId: session?.sessionId || record.sessionId || null,
      provider: session?.model?.provider || record.provider || null,
      model: modelSnapshot(session?.model) || record.model || null,
      ...overrides,
      scheduler: this.agentLimiter.snapshot(),
    };
    this.update(runtimeId, next);
    return safeRuntimeRecord(next);
  }

  snapshot(runtimeId: string, overrides: Record<string, any> = {}): Record<string, unknown> | null {
    const record = this.find(runtimeId);
    if (!record) return null;
    return safeRuntimeRecord({ ...record, ...overrides, capabilities: record.capabilities || runtimeCapabilities });
  }

  listSnapshots(): Array<Record<string, unknown>> {
    return this.records.map((record) => safeRuntimeRecord(record)).filter((item): item is Record<string, unknown> => Boolean(item)).reverse();
  }

  schedulerSnapshot(): { agent: ReturnType<AsyncLimiter["snapshot"]>; officecli: ReturnType<AsyncLimiter["snapshot"]> } {
    return { agent: this.agentLimiter.snapshot(), officecli: this.officeLimiter.snapshot() };
  }

  dispose(runtimeId: string, session: any): void {
    try { session?.dispose?.(); } catch (error: any) { this.markFailure(runtimeId, error, { reason: "dispose_failed" }); }
    const record = this.find(runtimeId);
    if (record) {
      record.status = "disposed";
      record.health = { status: "stopped", checkedAt: now(), message: null };
      record.updatedAt = now();
      this.trimAndPersist();
    }
  }

  async disposeAll(entries: Array<{ runtimeId: string; session?: any }> = []): Promise<void> {
    for (const entry of entries) this.dispose(entry.runtimeId, entry.session);
    this.modelRuntimePromise = null;
    this.networkAdapterInstance?.close?.();
    this.networkAdapterInstance = null;
  }

  find(runtimeId: string): RuntimeRecord | null {
    return this.records.find((item) => item.runtimeId === runtimeId) || null;
  }

  markPersistedRuntimesRecovering(): void {
    let changed = false;
    for (const record of this.records) {
      if (["creating", "queued", "running", "aborting", "compacting"].includes(record.status)) {
        record.status = "recovering";
        record.health = { status: "degraded", checkedAt: now(), message: "服务重启后等待显式恢复" };
        record.recoveryChain = [...(record.recoveryChain || []), { at: now(), reason: "process_restart", status: "recovering" }].slice(-20);
        changed = true;
      }
    }
    if (changed) this.trimAndPersist();
  }

  trimAndPersist(): void {
    this.records = this.records.slice(-RUNTIME_RECORD_LIMIT);
    ensureDirectory(path.dirname(this.recordFile));
    try { atomicWriteJson(this.recordFile, this.records.map((record) => safeRuntimeRecord(record))); } catch {}
  }
}

function loadRuntimeRecordsFrom(file: string): RuntimeRecord[] {
  const value = readJsonFile<unknown>(file, []);
  return Array.isArray(value) ? (value as RuntimeRecord[]) : [];
}

export const piRuntimeManager = new PiRuntimeManager();
export const officeLimiter = piRuntimeManager.officeLimiter;

// Agent 业务层只从本适配层取得 Pi 构造器，避免在业务模块散落 Pi SDK 依赖。
export {
  createBashToolDefinition,
  createEditToolDefinition,
  createLocalBashOperations,
  createReadToolDefinition,
  createWriteToolDefinition,
  DefaultResourceLoader,
  defineTool,
};
