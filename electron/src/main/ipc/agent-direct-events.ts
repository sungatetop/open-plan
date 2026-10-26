/**
 * 对话流直推桥（S1，迁移期过渡形态）：TS AgentManager 通道事件 → op:event 进程内直推。
 *
 * 旧路径：渲染层 watch → events-bridge 消费 legacy sidecar 的 per-thread SSE
 * （/api/agent/stream）翻译成 op:event。本模块把同一帧编排转录为主进程内直推，
 * 数据源从 sidecar SSE 换为 TS AgentManager（backend/agent/assembly 装配单飞实例）
 * 的通道 emitter/history——语义与 server/index.mjs L4727-4970 逐点对齐：
 *   - watch 受理即推 runtime_connecting；心跳转发为 op:heartbeat 活性帧
 *     （与 events-bridge 对 SSE heartbeat 帧的转发形态一致）；
 *   - ensureRuntime 加 45s 超时（RUNTIME_INIT_TIMEOUT，后台创建继续），超时/失败推
 *     runtime_init_failed / agent_error 应用层帧（classifyAgentError 分类）；
 *   - 先挂实时订阅再回放历史（防漏事件），以最大已发送 id 做幂等门闩
 *     （断线重连只补缺失、不重复）；游标经 resolveReplayCursor 做代际清零；
 *   - connected 帧带 cursor/earliest/latest/truncated；历史不连续补 stream_resync；
 *   - 首连（无游标）只回放最近 300 条，OAW_REPLAY_RECOVER 打开时活跃 Run 整段回放。
 *
 * 与 SSE 路由的显式差异（均不影响渲染层语义）：
 *   - 不发 SSE 传输层 `event: open` 帧：渲染层把该帧转发形态 op:sse-unknown 列入
 *     NON_THREAD_FRAME_TYPES 过滤，直推省略等价；
 *   - 无 SSE 重连循环：进程内订阅不存在断线，stop() 即终结；渲染层 op:stream-state
 *     仅收到 watching/stopped（无 retrying）。
 *
 * 门控：OP_DESKTOP_AGENT_EVENT_DIRECT 且 OP_DESKTOP_AGENT_DOMAIN 双门控（S4 起默认开，
 * =0 显式回滚——流量切换评估方案 §4-S4）。仅 app 形态可受益；prompt 流量切至 TS 实例前，
 * 本桥只有握手与心跳帧（通道无事件产生），故两 flag 需同开。
 *
 * 本模块不 import electron（纯逻辑，vitest 可直接测）；注册入口在 main/index.ts。
 */
import type { DesktopEvent } from "../../shared/protocol/channels";
import type { ThreadEventWatchRequest } from "../../shared/desktop-protocol";
import { isHistoryTruncated, PROTOCOL_VERSION, resolveReplayCursor } from "../../shared/runtime/event-protocol";
import { RUNTIME_FLAGS } from "../../shared/runtime/feature-flags";
import { classifyAgentError } from "../backend/agent/agent-errors";
import { agentKey } from "../backend/agent/agent-key";

/** 直推桥消费的通道条目最小视图（AgentManager entry 的结构化子集）。 */
export interface DirectChannelView {
  streamId: string;
  seq: number;
  history: Array<{ id: number; type: string; at?: string; streamId?: string; data?: unknown }>;
  emitter: {
    on(evt: "event", fn: (ev: unknown) => void): unknown;
    off(evt: "event", fn: (ev: unknown) => void): unknown;
  };
}

export interface DirectEntryView {
  channel: DirectChannelView;
  session?: { sessionId?: string; model?: { provider?: string; id?: string } | null } | null;
  modelFallbackSpec?: string;
  modelFallbackFrom?: string | null;
}

export interface DirectAgentManagerView {
  ensureRuntime(clientId: unknown, options: unknown): Promise<DirectEntryView>;
}

/** RUNTIME_INIT_TIMEOUT（server/index.mjs L89 同值）。 */
const RUNTIME_INIT_TIMEOUT_MS = 45_000;

const REPLAY_FIRST_CONNECT_LIMIT = 300;
const REPLAY_RECOVER_HARD_LIMIT = 4000;

export type DirectBridgeState = "watching" | "stopped";

export interface DirectEventsDeps {
  /** TS AgentManager 单飞（生产传 assembly.getAgentManager；测试注入桩） */
  getManager: () => Promise<DirectAgentManagerView>;
  /** 事件出口（main 侧广播到各窗口 op:event） */
  send: (event: DesktopEvent) => void;
  /** 状态回调（诊断用，与 events-bridge.onState 同形子集） */
  onState?: (state: DirectBridgeState, detail?: string) => void;
  /** manager 键解析（默认 server agentKey 转录 `${client}::${thread}`，S2 直调/S3 prompt 共用同键空间） */
  agentKeyOf?: (client: string, thread: string) => string;
  /** 工作区解析（默认 cwd ?? ""；SSE 路由为 normalizeWorkspace(cwd || getWorkspace())） */
  resolveWorkspace?: (cwd?: string) => string;
  /** 默认模型解析（SSE 路由为 project.settings.defaultModel；默认空 = 不覆盖） */
  resolveDefaultModel?: (workspace: string) => string;
  /** ensureRuntime 超时（默认 45000） */
  timeoutMs?: number;
  /** 心跳间隔（默认 RUNTIME_FLAGS.heartbeatChatMs = 基线 5000） */
  heartbeatMs?: number;
}

export interface AgentDirectEventsBridge {
  watch(request: ThreadEventWatchRequest): Promise<{ ok: boolean; error?: string }>;
  stop(request?: { client?: string; thread?: string }): void;
  dispose(): void;
}

export function createAgentDirectEventsBridge(deps: DirectEventsDeps): AgentDirectEventsBridge {
  const agentKeyOf = deps.agentKeyOf ?? agentKey;
  const resolveWorkspace = deps.resolveWorkspace ?? ((cwd) => String(cwd ?? ""));
  const resolveDefaultModel = deps.resolveDefaultModel ?? (() => "");
  const timeoutMs = deps.timeoutMs ?? RUNTIME_INIT_TIMEOUT_MS;
  const heartbeatMs = deps.heartbeatMs ?? RUNTIME_FLAGS.heartbeatChatMs;

  let activeKey: string | null = null;
  let activeClient = "";
  let activeThread = "";
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;

  const keyOf = (request: ThreadEventWatchRequest): string => `${request.client}\u0000${request.thread ?? ""}`;

  const push = (event: DesktopEvent): void => {
    deps.send(event);
  };

  const pushAppFrame = (type: string, data: Record<string, unknown>): void => {
    push({ type, at: new Date().toISOString(), data });
  };

  const startHeartbeat = (): void => {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      push({ type: "op:heartbeat", at: new Date().toISOString(), data: {} });
    }, heartbeatMs);
  };

  const stopHeartbeat = (): void => {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const detachActive = (): void => {
    if (unsubscribe) {
      try { unsubscribe(); } catch { /* 防御异常实现 */ }
      unsubscribe = null;
    }
    stopHeartbeat();
  };

  const stop = (request?: { client?: string; thread?: string }): void => {
    if (!activeKey) return;
    if (request && request.client) {
      const key = `${request.client}\u0000${request.thread ?? ""}`;
      if (key !== activeKey) return; // 非当前键：忽略
    }
    detachActive();
    activeKey = null;
    activeClient = "";
    activeThread = "";
    deps.onState?.("stopped");
  };

  /** ensureRuntime 超时包装（server/index.mjs L91-107 逐点转录；后台创建继续）。 */
  const ensureRuntimeWithTimeout = async (
    manager: DirectAgentManagerView,
    key: string,
    options: Record<string, unknown>
  ): Promise<DirectEntryView> => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const operation = manager.ensureRuntime(key, options);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(
          `会话运行时初始化超过 ${Math.round(timeoutMs / 1000)} 秒未完成，已自动取消等待；可重试或检查模型配置与网络`
        );
        (error as Error & { code?: string; retryable?: boolean }).code = "RUNTIME_INIT_TIMEOUT";
        (error as Error & { code?: string; retryable?: boolean }).retryable = true;
        reject(error);
      }, timeoutMs);
    });
    try {
      return await Promise.race([operation, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  /** 首连回放窗（server/index.mjs L4916-4937 转录：300 截尾 + OAW_REPLAY_RECOVER 活跃 Run 整段）。 */
  const selectReplayWindow = (
    history: DirectChannelView["history"],
    lastId: number
  ): DirectChannelView["history"] => {
    if (lastId === 0 && history.length > REPLAY_FIRST_CONNECT_LIMIT) {
      let replay = history.slice(-REPLAY_FIRST_CONNECT_LIMIT);
      if (RUNTIME_FLAGS.replayRecover) {
        let runStartIdx = -1;
        for (let i = history.length - 1; i >= 0; i -= 1) {
          const type = history[i]?.type;
          if (type === "run_finished") break;
          if (type === "run_admitted" || type === "run_admitting") { runStartIdx = i; break; }
        }
        if (runStartIdx >= 0) {
          replay = history.slice(Math.max(runStartIdx, history.length - REPLAY_RECOVER_HARD_LIMIT));
        }
      }
      return replay;
    }
    return history;
  };

  const watch = async (request: ThreadEventWatchRequest): Promise<{ ok: boolean; error?: string }> => {
    const client = String(request.client ?? "");
    const thread = String(request.thread ?? "");
    if (!client) return { ok: false, error: "client required" };

    const key = keyOf({ client, thread });
    if (activeKey === key) return { ok: true }; // 同键幂等：重复 watch 保护

    // 切键：进程内直接摘除旧订阅（无 SSE 半开连接，无需 gracefulClose）
    detachActive();
    activeKey = key;
    activeClient = client;
    activeThread = thread;
    deps.onState?.("watching");

    pushAppFrame("runtime_connecting", { client, thread });
    startHeartbeat();

    let entry: DirectEntryView;
    try {
      const manager = await deps.getManager();
      entry = await ensureRuntimeWithTimeout(manager, agentKeyOf(client, thread), {
        threadId: thread,
        cwd: resolveWorkspace(request.cwd),
        modelSpec: resolveDefaultModel(resolveWorkspace(request.cwd))
      });
    } catch (error) {
      if (activeKey !== key) return { ok: true }; // watch 已切换/停止：不再推送
      stopHeartbeat();
      const code = (error as Error & { code?: string })?.code;
      const message = error instanceof Error ? error.message : String(error);
      if (code === "RUNTIME_INIT_TIMEOUT") {
        pushAppFrame("runtime_init_failed", {
          client, thread, code, retryable: true, message: String(message).slice(0, 500)
        });
      } else {
        const diagnostic = classifyAgentError(error);
        pushAppFrame("agent_error", {
          code: diagnostic.code || "RUNTIME_CONNECT_FAILED",
          message: diagnostic.message || "Agent Runtime 连接失败",
          retryable: Boolean(diagnostic.retryable),
          client,
          thread
        });
      }
      return { ok: true }; // 受理成功；失败经应用层帧告知（对齐 SSE 路由推帧后收流）
    }
    if (activeKey !== key) return { ok: true }; // ensureRuntime 期间已切换/停止

    // 游标与代际（server/index.mjs L4849-4867 转录）：watch 请求携带 after/streamId；
    // 代际不一致时 resolveReplayCursor 将游标清零（全量回放）。
    const channelStreamId = entry.channel.streamId || "";
    const requestedCursor = Number(request.after ?? 0) || 0;
    const lastId = resolveReplayCursor({
      clientStreamId: typeof request.streamId === "string" ? request.streamId : "",
      channelStreamId,
      lastId: requestedCursor,
      channelSeq: Number(entry.channel.seq || 0)
    });
    const earliestId = entry.channel.history.length ? Number(entry.channel.history[0]?.id || 0) : 0;
    const latestId = Number(entry.channel.seq || 0);
    const historyTruncated = isHistoryTruncated({ lastId, earliestId });

    // 幂等门闩：先挂实时订阅再回放（server/index.mjs L4877-4881 顺序语义），
    // 回放窗口内新产生的事件不重复、不遗漏。
    let lastSentId = lastId;
    const forwardLive = (raw: unknown): void => {
      const ev = raw as { id?: number; type?: string; at?: string; streamId?: string; data?: unknown } | null;
      const id = Number(ev?.id || 0);
      if (!ev || id <= lastSentId) return;
      push({
        id,
        type: typeof ev.type === "string" ? ev.type : "op:sse-unknown",
        at: typeof ev.at === "string" ? ev.at : undefined,
        streamId: ev.streamId || channelStreamId || undefined,
        protocolVersion: PROTOCOL_VERSION,
        data: (ev.data ?? {}) as Record<string, unknown>
      });
      lastSentId = id;
    };
    entry.channel.emitter.on("event", forwardLive);
    unsubscribe = () => entry.channel.emitter.off("event", forwardLive);

    // connected 帧只能确认客户端请求的游标（回放尚未写入），cursor 取当前门闩值。
    const connectedModel = entry.modelFallbackSpec
      || (entry.session?.model?.provider && entry.session?.model?.id
        ? `${entry.session.model.provider}/${entry.session.model.id}`
        : null);
    pushAppFrame("connected", {
      client,
      thread,
      protocolVersion: PROTOCOL_VERSION,
      streamId: channelStreamId,
      sessionId: entry.session?.sessionId ?? null,
      model: connectedModel,
      modelFallbackFrom: entry.modelFallbackFrom ?? null,
      cursor: lastSentId,
      earliest: earliestId,
      latest: latestId,
      truncated: historyTruncated,
      serverAt: new Date().toISOString()
    });
    if (historyTruncated) {
      pushAppFrame("stream_resync", {
        client, thread, streamId: channelStreamId, cursor: lastId, earliest: earliestId, latest: latestId
      });
    }
    for (const ev of selectReplayWindow(entry.channel.history, lastId)) {
      if (Number(ev.id || 0) > lastId) forwardLive(ev);
    }
    return { ok: true };
  };

  return {
    watch,
    stop,
    dispose(): void {
      detachActive();
      activeKey = null;
      activeClient = "";
      activeThread = "";
      deps.onState?.("stopped");
    }
  };
}
