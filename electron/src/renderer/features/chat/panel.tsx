/**
 * ChatPanel 主组件（F3 批6d-3）：client/src/components/ChatPanel.jsx 532-4054
 * 的 TS 迁移 + 编排接线，与原实现逐行等价（对拍强制 tests/f3-batch6d3-parity.test.tsx）。
 *
 * 编排架构（与旧实现的差异只有形态、没有语义）：
 *   - 事件状态机（流式缓冲回调族 + handleEvent 49 分支 + flushNow/pushSystem/
 *     upsertRunSummary/finalizeStopped）由批6b createChatEventMachine 承担；
 *   - 对话流连接层（重连退避/watchdog/游标代际）由批6c createChatEventStreamController
 *     承担，传输层按桥可用性选择 IPC（新 UI 主路径）或 SSE（web/无桥降级）；
 *   - 旧 handleEvent 是渲染闭包，读取 busy/runState/model/forcedMode/threadId/workspace
 *     的「最近一次已提交渲染值」——这里经 latestRef 注入同一语义；
 *   - 旧 handleEvent 每 render 重定义（读取最新 models/回调）——这里机器单次创建，
 *     每 render 更新 implRef，deps 经 implRef 间接调用最新实现；
 *   - 旧内联 fetch（prompt/abort/model/runtime）替换为 IPC 通道（op:agent:prompt 等），
 *     失败语义按 ApiError 映射回旧 !res.ok / catch 两分支（见 send/stop 内注释）。
 */
import React, {
  forwardRef,
  Fragment,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import Icon from "../../components/Icon";
import Logo from "../../components/Logo";
import ChatErrorBoundary from "../../components/ChatErrorBoundary";
import ChatTimeline from "../../components/ChatTimeline";
import ModelProviderMark, { ModelOptionRow } from "../../components/ModelProviderMark";
import { SessionList, type SessionRecord } from "../../components/SessionList";
import { notifyError, askConfirm } from "../../components/Feedback";
import {
  APPROVAL_MODE_KEY,
  COMPOSER_COMMANDS,
  DEFAULT_CONTEXT_WINDOW,
  EMPTY_EXAMPLES,
  LIVE_RUN_STATUSES,
  MAX_RECENT_MODELS,
  MAX_VISIBLE_MESSAGES,
  MESSAGE_PAGE_SIZE,
  MODE_KEY,
  MODE_META,
  MODEL_FAVORITE_KEY,
  MODEL_KEY,
  MODEL_RECENT_KEY,
  PI_COMPACTION_KEEP_RECENT_TOKENS,
  PI_COMPACTION_RESERVE_TOKENS,
  THINKING_KEY,
  THINKING_OPTIONS,
  appendExecutionFlowEvent,
  appendTextBlock,
  loadEmbeddedMessages,
  modelProvider,
  modelProviderMeta,
  normalizeHistoryMessages,
  normalizeUiMode,
  newId,
  parseReferenceMarkers,
  pathBaseName,
  readDraft,
  readStoredModelList,
  referenceMarker,
  usageDetails,
  writeDraft,
  writeStoredModelList,
  type ChatBlock,
  type ChatMessage,
  type ChatModel,
  type ChatReference,
  type FlowEvent,
  type ParsedReference,
} from "../../lib/chat-shared";
import { FLOW_EVENT_TYPES, STAGE_ONLY_EVENTS, flowEventLabel } from "../../lib/event-display";
import { flag, flagsReady } from "../../lib/feature-flags";
import { startLatencyProbe, patchLatencyMeta } from "../../lib/first-token-latency-tracker";
import { 计算展示字符数, 提取消息展示文本 } from "../../lib/StreamingTextQueue";
import { isMotionReduced, motionScrollBehavior, useAppearance, useAppearanceSetter } from "../../lib/ui-appearance";
import { associateRunMessages } from "../../lib/run-display-projection";
import { loadSettings } from "../../lib/settings";
import {
  ApiError,
  abortAgent,
  approveMemoryProposal,
  compactAgentContext,
  deleteSession,
  deleteSessions,
  fileToBase64,
  forkSession,
  getAgentRuntime,
  getApprovalMode,
  getRun,
  listModels,
  listRuns,
  refreshModels,
  rejectMemoryProposal,
  renameSession,
  rollbackRun,
  // 旧 ChatPanel.jsx 以别名 saveApprovalMode 引用 setApprovalMode，保持调用点符号不变。
  setApprovalMode as saveApprovalMode,
  sendAgentPrompt,
  setAgentModel,
} from "../../api/client-api";
import { getDesktopApi } from "../../api/ipc-client";
import { createChatEventMachine, type ChatEventInput, type ChatRunState } from "./event-machine";
import {
  createChatEventStreamController,
  createIpcThreadEventTransport,
  createSseThreadEventTransport,
} from "./event-stream";
import { MemoMessage } from "./message";
import {
  ApprovalModeControl,
  ContextUsageRing,
  PendingActionBar,
  TaskProgressCard,
  type CompactionInfo,
  type TaskItem,
} from "./interaction-parts";
import { ExecutionFlow, type FlowEventItem, type ExecutionNote, type PendingApprovalInfo } from "./execution-flow";

// ============================================================================
// 宽松视图类型
// ============================================================================

interface ImageAttachment {
  mediaType: string;
  data: string;
  dataUrl: string;
  name: string;
}

interface ContextNote {
  text: string;
  images?: ImageAttachment[];
  attachments?: ImageAttachment[];
}

interface QueuedItem {
  messageId: string;
  rawText: string;
  images: ImageAttachment[];
  attachments: ImageAttachment[];
  references: ChatReference[];
  contextNotes: ContextNote[];
  currentDoc: unknown;
  editMode: string;
  effort: string;
}

interface ModelPopRect {
  left: number;
  width: number;
  maxHeight: number;
  bottom?: number;
  top?: number;
}

interface ComposerMenu {
  symbol: string;
  query: string;
  start: number;
}

interface ComposerItem {
  insert: string;
  label: string;
  hint: string;
  session?: SessionRecord;
}

export interface LastPromptInfo {
  text: string;
  references: ChatReference[];
  contextText: string;
  skills?: unknown[];
}

interface HistoryWindowInfo {
  hasMore?: unknown;
  end?: unknown;
  start?: unknown;
  [key: string]: unknown;
}

interface MapContextInfo {
  center?: unknown;
  zoom?: unknown;
  bounds?: unknown;
  regionName?: unknown;
  updatedAt?: unknown;
  [key: string]: unknown;
}

interface ModelSection {
  key: string;
  title: string;
  items: ChatModel[];
}

export interface ChatPanelProps {
  clientId: string;
  threadId: string | null;
  workspace?: string;
  project?: Record<string, unknown> | null;
  mapProject?: string | null;
  frozen?: boolean;
  onFileChanged?: (files: unknown) => void;
  onMapAction?: (data: Record<string, unknown>) => void;
  currentDoc?: string | null;
  mapContext?: MapContextInfo | null;
  models?: ChatModel[];
  defaultModel?: string;
  selectedModel?: string;
  onModelChange?: (id: string) => void;
  onAgentEnd?: () => void;
  onRunFinished?: (data: Record<string, unknown>) => void;
  onOpenRunChanges?: (data: unknown) => void;
  onOpenRunArtifacts?: (data: unknown) => void;
  historyMessages?: unknown;
  historyThreadId?: string | null;
  historyWindow?: HistoryWindowInfo | null;
  onNewSession?: (workspace?: string | null) => void;
  onOpenFile?: (...args: unknown[]) => void;
  referenceFiles?: unknown[];
  sessions?: SessionRecord[];
  unreadByThread?: Record<string, number>;
  onSelectSession?: (session: SessionRecord) => void | Promise<void>;
  onSessionChange?: (sessionId: string) => void;
  onRefreshSessions?: () => void;
  onDeleteSession?: (id: string) => void | Promise<void>;
  onBatchDeleteSession?: (ids: string[]) => void | Promise<void>;
  onForkSession?: (id: string) => void | Promise<void>;
  onPinSession?: (id: string, pinned: boolean) => void | Promise<void>;
  onFreezeSession?: (id: string, frozen: boolean) => void | Promise<void>;
  embedded?: boolean;
  compact?: boolean;
  forcedMode?: string | null;
  initialReferences?: ChatReference[];
  contextText?: string;
  panelTitle?: string;
  onPromoteToAgent?: (prompt: LastPromptInfo) => void;
  onModeChange?: (mode: string) => void;
  onPhaseChange?: (phase: string) => void;
  onBrowserActivity?: () => void;
  onOpenSubagent?: (data: unknown) => void;
  onSubagentUpdate?: (threadId: string | null, block: unknown) => void;
}

/** 每 render 更新的「最近一次已提交渲染」闭包值（机器 getter 读取源）。 */
interface LatestRenderValues {
  busy: boolean;
  runState: ChatRunState;
  model: string;
  forcedMode: string | null | undefined;
  threadId: string | null | undefined;
  workspace: string | null | undefined;
}

/** 每 render 更新的组件级实现（机器 deps 经此间接调用最新实现）。 */
interface ImplBag {
  applyModel(id: string, list?: ChatModel[]): void;
  flushQueued(force?: boolean): void;
  onFileChanged?: (files: unknown) => void;
  onMapAction?: (data: Record<string, unknown>) => void;
  onRunFinished?: (data: Record<string, unknown>) => void;
  onAgentEnd?: () => void;
  onBrowserActivity?: () => void;
  onModelChange?: (id: string) => void;
}

/** useImperativeHandle 暴露给外层（App / 图层面板）的命令式句柄。 */
export interface ChatPanelImperativeHandle {
  setMode(mode: string): boolean;
  insertText(text: string): void;
  insertContext(text: string): void;
  startAgentTask(payload?: Record<string, unknown>): void;
  focusRun(): void;
}

/** send 的第二参数：force 绕过 busy 排队；payload 来自队列回放（flushQueued）或外部任务。 */
export interface SendOptions {
  force?: boolean;
  payload?: {
    images?: ImageAttachment[];
    attachments?: ImageAttachment[];
    references?: ChatReference[];
    rawText?: unknown;
    contextNotes?: ContextNote[];
    currentDoc?: unknown;
    editMode?: string;
    effort?: string;
    messageId?: string;
    skills?: unknown[];
  };
}

/** Run 对账 / 冷启动探测里的 Run 视图（GET /api/runs 宽松形状）。 */
interface ReconcileRun {
  id?: string;
  status?: string;
  startedAt?: unknown;
  finishedAt?: unknown;
  updatedAt?: unknown;
  clientId?: unknown;
  task?: Record<string, unknown> | null;
  artifacts?: unknown[];
  references?: unknown[];
  todoVersion?: number;
  todos?: unknown[];
  steps?: unknown[];
  events?: unknown[];
  verificationStatus?: unknown;
  [key: string]: unknown;
}

const ChatPanel = forwardRef(function ChatPanel({
  clientId, threadId, workspace = "", project = null, mapProject = null, frozen = false, onFileChanged, onMapAction, currentDoc, mapContext, models: modelsProp, defaultModel, selectedModel = "", onModelChange, onAgentEnd, onRunFinished, onOpenRunChanges, onOpenRunArtifacts, historyMessages, historyThreadId = null, historyWindow = null, onNewSession, onOpenFile, referenceFiles = [], sessions = [], unreadByThread = {}, onSelectSession, onSessionChange, onRefreshSessions = () => {}, onDeleteSession, onBatchDeleteSession, onForkSession, onPinSession, onFreezeSession, embedded = false, compact = false, forcedMode = null, initialReferences = [], contextText = "", panelTitle = "Open Plan", onPromoteToAgent, onModeChange, onPhaseChange, onBrowserActivity, onOpenSubagent, onSubagentUpdate,
}: ChatPanelProps, ref: React.ForwardedRef<ChatPanelImperativeHandle>) {
  const [messages, setMessages] = useState<ChatMessage[]>(() => loadEmbeddedMessages(threadId, embedded));
  const [messageWindowSize, setMessageWindowSize] = useState(MAX_VISIBLE_MESSAGES);
  // 草稿按 thread 恢复（交互 3）：模块导航会卸载本组件，重挂载时从缓存取回未发送内容。
  const [input, setInput] = useState(() => readDraft(threadId));
  // 输入变化即写回草稿缓存：模块导航导致的卸载不会丢掉未发送内容。
  const updateInput = useCallback((value: string | ((previous: string) => string)) => {
    setInput((previous) => {
      const next = typeof value === "function" ? value(previous) : value;
      writeDraft(threadId, next);
      return next;
    });
  }, [threadId]);
  // 子代理详情实时更新：把最新的子代理 block 推给外层（App 右栏详情按 id 订阅）。
  useEffect(() => {
    if (!onSubagentUpdate) return;
    for (const message of messages) {
      for (const block of (message?.blocks || [])) {
        if (block?.type === "subagent") onSubagentUpdate(threadId, block);
      }
    }
  }, [messages, threadId, onSubagentUpdate]);

  // 发送成功、切换/新建会话、执行斜杠命令时才清空草稿。
  const clearInput = useCallback(() => {
    writeDraft(threadId, "");
    setInput("");
  }, [threadId]);
  const [references, setReferences] = useState<ChatReference[]>([]);
  const [histOpen, setHistOpen] = useState(false); // 会话历史抽屉（默认隐藏，点击展开）
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]); // 非图片附件
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [connected, setConnected] = useState(false);
  const [models, setModels] = useState<ChatModel[]>(modelsProp || []);
  const [model, setModel] = useState("");
  const [modelVision, setModelVision] = useState(false);
  const [modelMsg, setModelMsg] = useState("");
  // 阶段 4.4：最近一次地图可视化（来自 map_action 事件）。用于结果区提示
  // "已在地图上显示（临时，未保存）"——临时层不落盘，Run 的 artifacts 为空，
  // 用户会问"我刚画的那层呢"。这里只做展示与引导保存，不改事件链路。
  const [lastMapVisual, setLastMapVisual] = useState<Record<string, unknown> | null>(null);
  // 地图可视化的就地提示（如"保存需切 Work"）：显示在提示条内，比工具栏的 modelMsg 更醒目。
  const [mapVisualHint, setMapVisualHint] = useState("");
  // 运行中切换模型会排队到本轮结束（Pi 会话不支持中途换模型）：这里记住"待切换"的目标，
  // 收到 model_switched(effective=now) 后再清掉。
  const [pendingModel, setPendingModel] = useState("");
  const [modelCounts, setModelCounts] = useState({ available: 0, configured: 0 });
  const [compacting, setCompacting] = useState(false);
  const [approvalMode, setApprovalModeState] = useState(() => localStorage.getItem(APPROVAL_MODE_KEY) === "auto" ? "auto" : "ask");
  const [approvalModeSaving, setApprovalModeSaving] = useState(false);
  const [editMode, setEditMode] = useState(() => {
    const saved = localStorage.getItem(MODE_KEY);
    return forcedMode ? normalizeUiMode(forcedMode) : normalizeUiMode(saved);
  }); // Chat 只读检索 / Agent 完整执行与产出
  const [lastPrompt, setLastPrompt] = useState<LastPromptInfo | null>(null);
  const [effort, setEffort] = useState(() => {
    const saved = localStorage.getItem(THINKING_KEY);
    return THINKING_OPTIONS.some((item) => item.id === saved) ? (saved as string) : "low";
  }); // Pi 标准推理档位：low/medium/high/max
  const [modelOpen, setModelOpen] = useState(false); // 模型选择浮层
  // 模型弹层曾用 right:0 贴着窄触发器向左伸，在 1440px 三栏布局下被
  // .center-chat-slot 的 overflow:hidden 裁掉左侧（交接文档问题 2）。改为
  // Portal 到 body + 视口定位：先按触发器算位置，再按可用空间夹取边界。
  const modelTriggerRef = useRef<HTMLButtonElement | null>(null);
  const modelPopRef = useRef<HTMLDivElement | null>(null);
  const [modelPopRect, setModelPopRect] = useState<ModelPopRect | null>(null);
  const [modelQ, setModelQ] = useState(""); // 模型搜索
  // 模型选择收敛为“当前 / 最近 / 收藏 / 全部搜索”：最近与收藏只存本地轻量偏好，
  // 不复制密钥或凭据；完整列表仍保留为可展开的高级入口。
  const [recentModels, setRecentModels] = useState(() => readStoredModelList(MODEL_RECENT_KEY));
  const [favoriteModels, setFavoriteModels] = useState(() => readStoredModelList(MODEL_FAVORITE_KEY));
  const [allModelsOpen, setAllModelsOpen] = useState(false);
  // 目标上下文里的当前文件可以按轮移除：移除只影响本轮的 [当前打开文件] 注入，
  // 不改变真正打开的文件，也不代表授权写入。
  const [contextFileDismissed, setContextFileDismissed] = useState(false);
  const [agentPhase, setAgentPhaseState] = useState("");
  const agentPhaseRef = useRef("");
  const setAgentPhase = useCallback((next: string | ((prev: string) => string)) => {
    const value = typeof next === "function" ? next(agentPhaseRef.current) : next;
    if (Object.is(agentPhaseRef.current, value)) return;
    agentPhaseRef.current = value;
    setAgentPhaseState(value);
  }, []);
  const [historyLoading, setHistoryLoading] = useState(false);
  // B02：执行过程显示由外观设置驱动（compact | expanded | hidden），走共享订阅立即生效；
  // 旧版独立的 oaw_execution_flow_hidden 已由 ui-appearance.js 一次性迁移。
  const appearance = useAppearance();
  const setAppearance = useAppearanceSetter();
  const flowHidden = appearance.activityDisplay === "hidden";
  const setFlowHidden = useCallback((next: boolean) => {
    setAppearance({ activityDisplay: next ? "hidden" : "compact" });
  }, [setAppearance]);
  const flowDefaultExpanded = appearance.activityDisplay === "expanded";
  // 弹层定位：以触发器为锚点向上展开（原本 bottom:34px 的语义），
  // 再按视口与安全边距夹取，保证任何一栏布局下四边都在可视范围内。
  const positionModelPop = useCallback(() => {
    const trigger = modelTriggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const margin = 8;
    const width = Math.min(360, Math.max(280, window.innerWidth - margin * 2));
    // 高度必须真正夹住：展开「全部模型」（100+ 行）时弹层会长到数千像素，
    // 外层没有高度上限就会被撑开、顶出屏幕（列表自身的 max-height 挡不住）。
    const spaceAbove = rect.top - margin - 6;
    const spaceBelow = window.innerHeight - rect.bottom - margin - 6;
    const flip = spaceAbove < 200 && spaceBelow > spaceAbove;
    const maxHeight = Math.max(180, Math.min(flip ? spaceBelow : spaceAbove, window.innerHeight - margin * 2));
    const left = Math.max(margin, Math.min(rect.right - width, window.innerWidth - width - margin));
    setModelPopRect({
      left,
      width,
      maxHeight,
      // 默认向上展开；上方空间不够（触发器贴顶）时改为向下展开。
      bottom: flip ? undefined : Math.max(margin, window.innerHeight - rect.top + 6),
      top: flip ? Math.round(rect.bottom + 6) : undefined,
    });
  }, []);
  // 交互 7：模型菜单此前只能靠再次点触发器关闭，Escape 与外部点击都无效。
  // 统一为：Escape 关闭并把焦点还给触发器；指针落在弹层/触发器之外时关闭。
  useEffect(() => {
    if (!modelOpen) return undefined;
    positionModelPop();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setModelOpen(false);
      requestAnimationFrame(() => modelTriggerRef.current?.focus());
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (modelPopRef.current?.contains(target as Node) || modelTriggerRef.current?.contains(target as Node)) return;
      setModelOpen(false);
    };
    const onReflow = () => positionModelPop();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", onReflow);
    window.addEventListener("scroll", onReflow, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    };
  }, [modelOpen, positionModelPop]);
  const closeModelPop = useCallback(({ returnFocus = true }: { returnFocus?: boolean } = {}) => {
    setModelOpen(false);
    if (returnFocus) requestAnimationFrame(() => modelTriggerRef.current?.focus());
  }, []);
  const [runState, setRunState] = useState<ChatRunState>({ status: "idle", runId: null, artifacts: [], references: [], task: null, mode: "chat" });
  const [todoItems, setTodoItems] = useState<unknown[]>([]);
  const [executionEvents, setExecutionEvents] = useState<FlowEvent[]>([]);
  const executionEventsRef = useRef<FlowEvent[]>([]);
  const executionEventQueueRef = useRef<FlowEvent[]>([]);
  const executionEventTimerRef = useRef<number | null>(null);
  const replaceExecutionEvents = useCallback((nextOrUpdater: FlowEvent[] | ((prev: FlowEvent[]) => FlowEvent[])) => {
    if (executionEventTimerRef.current) {
      clearTimeout(executionEventTimerRef.current);
      executionEventTimerRef.current = null;
    }
    executionEventQueueRef.current = [];
    const next = typeof nextOrUpdater === "function" ? nextOrUpdater(executionEventsRef.current) : nextOrUpdater;
    executionEventsRef.current = next || [];
    setExecutionEvents(executionEventsRef.current);
  }, []);
  const enqueueExecutionEvent = useCallback((event: FlowEvent) => {
    executionEventQueueRef.current.push(event);
    if (executionEventTimerRef.current) return;
    executionEventTimerRef.current = window.setTimeout(() => {
      executionEventTimerRef.current = null;
      let next = executionEventsRef.current;
      for (const item of executionEventQueueRef.current.splice(0)) next = appendExecutionFlowEvent(next, item);
      replaceExecutionEvents(next);
    }, 80);
  }, [replaceExecutionEvents]);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  // 本轮系统提示（上下文压缩 / 文件变更等）：聚合为一条可展开摘要，
  // 不再往对话流里逐条堆气泡——那些气泡既不会随回合结束清理，刷新回放时还会重复出现。
  const [systemNotes, setSystemNotes] = useState<Array<Record<string, unknown>>>([]);
  const pushSystemNote = useCallback((note: Record<string, unknown>) => {
    const key = String(note?.key || "").trim();
    if (!key) return;
    setSystemNotes((list) => {
      const index = list.findIndex((item) => item.key === key);
      if (index >= 0) {
        const next = [...list];
        next[index] = { ...next[index], ...note, count: Number(next[index]?.count || 1) + 1 };
        return next;
      }
      return [...list, { ...note, count: 1 }].slice(-40);
    });
  }, []);
  const clearSystemNotes = useCallback(() => setSystemNotes([]), []);
  const [queuedMessages, setQueuedMessages] = useState<QueuedItem[]>([]); // 当前任务完成后顺序执行
  const [injectedContext, setInjectedContext] = useState<ContextNote[]>([]); // 等待下一轮发送的上下文片段
  // 模型连接状态：重试中/已恢复（输入框旁小状态点；过程区不再堆这类提示）
  const [connectionNotice, setConnectionNotice] = useState<{ state?: unknown; message?: unknown } | null>(null);
  const connectionTimerRef = useRef<number | null>(null);
  const [busyInputMode, setBusyInputMode] = useState("queue"); // "queue" | "context"
  const [composerMenu, setComposerMenu] = useState<ComposerMenu | null>(null);
  const [composerIndex, setComposerIndex] = useState(0);

  useEffect(() => { onModeChange?.(normalizeUiMode(editMode)); }, [editMode, onModeChange]);
  useEffect(() => { onPhaseChange?.(busy ? (agentPhase || "正在处理") : ""); }, [agentPhase, busy, onPhaseChange]);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const followLatestRef = useRef(true);
  const assistantIdRef = useRef<string | null>(null);
  // agent_end 可能先于 run_finished 到达；保留本轮最后一个气泡，
  // 让服务端补发的权威全文继续写入原气泡，避免出现两条结论。
  const lastAssistantIdRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const attInputRef = useRef<HTMLInputElement | null>(null);
  // streaming 累积缓冲（性能优化：避免每 token setState）
  const streamBufRef = useRef<{ text: string; thinking: string } | null>(null);
  const rafRef = useRef<number | null>(null);
  const toolOutputQueueRef = useRef(new Map<string, { messageId: string; toolCallId: string | null; name: string; output: string; replace: boolean }>());
  const toolOutputRafRef = useRef<number | null>(null);
  const textRevealRef = useRef<{ id: string; fullText: string; pending: string; lastAt: number; completeWhenDrained: boolean; instant: boolean } | null>(null);
  // 保留已经真正展示到消息气泡中的文本。agent_end 清理动画状态后，
  // run_finished 仍可能补发同一份最终全文，不能因此重新追加一遍。
  const displayedTextRef = useRef(new Map<string, string>());
  const textRevealRafRef = useRef<number | null>(null);
  const streamingMsgIdRef = useRef<string | null>(null);
  const stoppingRef = useRef(false);
  // 本轮是否发出过中断请求：中断后到达的 agent_error（SDK 以 "Request aborted" 收尾）
  // 要按中断处理，而不是当成"生成失败"。
  const stopRequestedRef = useRef(false);
  // 本轮是否已经按"中断"收尾：agent_end 常晚于 aborted 到达，早先它会把 busy 再拉回 true，
  // 于是徽记已经写着「已停止生成」，输入区却还停在「中断」——用户以为没停住。
  const roundStoppedRef = useRef(false);
  const stopConfirmTimerRef = useRef<number | null>(null);
  const agentErrorRef = useRef(false);
  const queueRef = useRef<QueuedItem[]>([]);
  // 组件挂载状态追踪，防止卸载后更新状态
  const mountedRef = useRef(true);
  // SSE 重连可能重放同一事件；按运行/文件/摘要去重，避免对话栏污染。
  const systemEventKeysRef = useRef(new Set<string>());
  // 每个 SSE 事件都有单调递增的 channel id；重连从游标之后回放，避免旧事件污染当前回合。
  const eventCursorRef = useRef(0);
  const eventCursorsRef = useRef(new Map<string, number>());
  // SSE 通道代际：Runtime/会话重建后服务端序号从 1 重新开始，游标必须按代际隔离
  const streamIdsRef = useRef(new Map<string, string>());
  const activeRunIdRef = useRef<string | null>(null);
  const runtimeConnectingEventRef = useRef<FlowEvent | null>(null);
  // 发送请求后立即标记运行态，不能等 React 的 busy 状态提交；
  // 否则首批 run_admitted/model_request_started 事件会被误当成历史事件丢弃。
  const runInProgressRef = useRef(false);
  const agentEventAtRef = useRef(0);
  const streamReadyRef = useRef<{ promise: Promise<boolean>; resolve?: (value: boolean) => void; streamKey: string; generation: number } | null>(null);
  const handshakeDoneRef = useRef(false);
  // SSE 连接会在切换会话时重建。旧 EventSource 即使已经 close，浏览器仍可能
  // 把队列中的最后一条消息回调出来；用代际号挡住旧连接，避免旧会话污染新会话。
  const streamGenerationRef = useRef(0);
  const eventHandlerRef = useRef<((event: unknown) => void) | null>(null);
  const reconciledRunIdsRef = useRef(new Set<string>());
  // OAW_REPLAY_RECOVER：冷启动 Run 探测与回放缓冲（恢复差异报告 F1/F4，默认关）
  const replayProbeRef = useRef({ pending: false, thread: null as string | null });
  const replayBufferRef = useRef<unknown[]>([]);
  const replayProbedThreadsRef = useRef(new Set<string>());
  const [replayFlagsTick, setReplayFlagsTick] = useState(0); // 开关快照就绪后重跑一次探测
  // ChatPanel 本身持续挂载时，按 thread 保存界面状态，切换子对话不会把原对话的流式内容丢掉。
  const threadCacheRef = useRef(new Map<string | null, { messages: ChatMessage[]; runState: ChatRunState; todoItems: unknown[]; busy: boolean; editMode: string } | undefined>());
  const previousThreadRef = useRef<string | null>(threadId);
  // 机器闭包值与最新实现的中转（声明于 refs 区，赋值于每 render 接线块）。
  const latestRef = useRef<LatestRenderValues>({ busy, runState, model, forcedMode, threadId, workspace });
  const implRef = useRef<ImplBag>(null as unknown as ImplBag);

  const currentMode = MODE_META[normalizeUiMode(editMode)] || MODE_META.chat!;
  const selectedModelInfo = models.find((item) => item.id === model) || null;
  const selectedProviderMeta = modelProviderMeta(selectedModelInfo);
  const selectedEffort = THINKING_OPTIONS.find((item) => item.id === effort) || THINKING_OPTIONS[0]!;
  const selectedEffortIndex = Math.max(0, THINKING_OPTIONS.findIndex((item) => item.id === selectedEffort.id));
  const selectedContextWindow = Number(selectedModelInfo?.contextWindow) || DEFAULT_CONTEXT_WINDOW;
  const usageView = (runState.usage ?? null) as Record<string, unknown> | null;
  const selectedUsage = usageDetails(usageView);
  const selectedContextRatio = Math.min(1, selectedUsage.context / selectedContextWindow);
  // 已知模型由 Pi 按 contextWindow 自动压缩；服务端快照存在时优先显示
  // 运行时实际策略，避免前端继续把旧的 78% 固定线展示成真实阈值。
  const selectedCompactThreshold = Number(usageView?.compactThreshold) > 0
    ? Number(usageView!.compactThreshold)
    : Math.max(0, selectedContextWindow - PI_COMPACTION_RESERVE_TOKENS);
  const selectedCompactionMode = (usageView?.compactionMode as string | undefined) || "pi-native";
  // 压缩预算明细：预留空间与"压缩后保留最近多少"，用于浮层里解释压缩线怎么来的
  const selectedCompactionReserve = Number(usageView?.compactionReserveTokens) > 0
    ? Number(usageView!.compactionReserveTokens)
    : PI_COMPACTION_RESERVE_TOKENS;
  const selectedCompactionKeepRecent = Number(usageView?.compactionKeepRecentTokens) > 0
    ? Number(usageView!.compactionKeepRecentTokens)
    : PI_COMPACTION_KEEP_RECENT_TOKENS;
  const modelGroups = useMemo(() => {
    const query = modelQ.trim().toLowerCase();
    const groups = new Map<string, ChatModel[]>();
    for (const item of models) {
      const searchable = `${item.id || ""} ${item.name || ""} ${item.provider || ""}`.toLowerCase();
      if (query && !searchable.includes(query)) continue;
      const provider = modelProvider(item);
      if (!groups.has(provider)) groups.set(provider, []);
      groups.get(provider)!.push(item);
    }
    return [...groups.entries()];
  }, [models, modelQ]);

  // 切换模型时记入“最近”，并在选中失败回退时也记录实际生效的那个。
  const rememberModel = useCallback((id: string) => {
    if (!id) return;
    setRecentModels((list) => {
      const next = [id, ...list.filter((item) => item !== id)].slice(0, MAX_RECENT_MODELS);
      writeStoredModelList(MODEL_RECENT_KEY, next);
      return next;
    });
  }, []);

  // 模型标识 → 展示名（能查到目录就用名称，否则原样显示 provider/model）。
  const modelDisplayName = useCallback((spec: ChatModel | string | null | undefined) => {
    // 兼容两种调用方：模型对象（输入栏触发器、弹层）与模型 id 字符串（模型切换提示）。
    // 本函数在组件内遮蔽了模块级同名函数，若只接受字符串，传对象会显示成 "[object Object]"。
    if (spec && typeof spec === "object") {
      return spec.name || String(spec.id || "").split("/").slice(1).join("/") || String(spec.id || "").trim();
    }
    const value = String(spec || "").trim();
    if (!value) return "";
    const found = (models || []).find((item) => item.id === value);
    return found?.name || value;
  }, [models]);

  const toggleFavoriteModel = useCallback((id: string | undefined) => {
    if (!id) return;
    setFavoriteModels((list) => {
      const next = list.includes(id) ? list.filter((item) => item !== id) : [id, ...list];
      writeStoredModelList(MODEL_FAVORITE_KEY, next);
      return next;
    });
  }, []);

  // 模型选择分区：搜索时有结果就直接铺全量，无搜索时按 当前/最近/收藏/全部 分区，
  // 每个分区按 id 去重且保留真实元数据标签。
  const modelSections = useMemo<ModelSection[]>(() => {
    const byId = new Map(models.map((item) => [item.id, item] as [string, ChatModel]));
    const pick = (ids: string[]) => ids.map((id) => byId.get(id)).filter(Boolean) as ChatModel[];
    if (modelQ.trim()) {
      return [{ key: "search", title: `搜索结果（${modelGroups.reduce((sum, [, list]) => sum + list.length, 0)}）`, items: modelGroups.flatMap(([, list]) => list) }];
    }
    const sections: ModelSection[] = [];
    const current = selectedModelInfo || byId.get(model);
    if (current) sections.push({ key: "current", title: "当前使用", items: [current] });
    const recent = pick(recentModels.filter((id) => id !== model));
    if (recent.length) sections.push({ key: "recent", title: "最近使用", items: recent });
    const favorites = pick(favoriteModels);
    if (favorites.length) sections.push({ key: "favorites", title: "收藏", items: favorites });
    return sections;
  }, [models, modelGroups, modelQ, model, recentModels, favoriteModels, selectedModelInfo]);

  // 打开的当前文件发生变化时，恢复“本轮带上当前文件”的默认行为。
  useEffect(() => { setContextFileDismissed(false); }, [currentDoc]);

  const composerItems = useMemo<ComposerItem[]>(() => {
    if (!composerMenu) return [];
    const query = composerMenu.query.toLowerCase();
    if (composerMenu.symbol === "/") {
      return COMPOSER_COMMANDS.filter((item) => !query || (item.insert + " " + item.label + " " + item.hint).toLowerCase().includes(query));
    }
    if (composerMenu.symbol === "@") {
      return [...new Set(referenceFiles.map((file) => String(file || "").trim()).filter(Boolean))]
        .filter((file) => !query || file.toLowerCase().includes(query))
        .slice(0, 12)
        .map((file) => ({ insert: "@" + file, label: file, hint: "引用当前工作区文件" }));
    }
    return sessions
      .filter((session) => !query || String(session.title || "").concat(" ", session.label || "", " ", session.id).toLowerCase().includes(query))
      .slice(0, 12)
      .map((session) => ({ insert: "&会话[" + session.id + "]", label: session.title || session.label || "未命名会话", hint: "引用这段历史会话", session }));
  }, [composerMenu, referenceFiles, sessions]);

  useEffect(() => {
    if (composerItems.length === 0) setComposerIndex(0);
    else setComposerIndex((index) => Math.min(index, composerItems.length - 1));
  }, [composerItems]);

  const composerTrigger = (value: string): ComposerMenu | null => {
    const match = String(value || "").match(/(?:^|\s)([\/@&])([^\s]*)$/);
    if (!match) return null;
    return { symbol: match[1]!, query: match[2] || "", start: value.length - match[0].length + (match[0].startsWith(" ") ? 1 : 0) };
  };

  const insertComposerItem = (item: ComposerItem | null | undefined) => {
    if (!composerMenu || !item) return;
    updateInput((value) => value.slice(0, composerMenu.start) + item.insert + " " + value.slice(value.length));
    setComposerMenu(null);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  useEffect(() => {
    if (!embedded || lastPrompt || !messages.length) return;
    const lastUser = [...messages].reverse().find((item) => item?.role === "user" && item?.text);
    if (lastUser) setLastPrompt({ text: lastUser.text!, references: (lastUser.references as ChatReference[] | undefined) || [], contextText });
  }, [contextText, embedded, lastPrompt, messages]);

  useEffect(() => {
    if (forcedMode) setEditMode(normalizeUiMode(forcedMode));
  }, [forcedMode]);

  useEffect(() => {
    let cancelled = false;
    getApprovalMode().then((result) => {
      const mode = (result as { mode?: unknown } | null | undefined)?.mode;
      if (cancelled || !["ask", "auto"].includes(String(mode))) return;
      setApprovalModeState(mode as string);
      localStorage.setItem(APPROVAL_MODE_KEY, mode as string);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const changeApprovalMode = useCallback(async (nextMode: string) => {
    if (approvalModeSaving || !["ask", "auto"].includes(nextMode)) return;
    const previous = approvalMode;
    setApprovalModeState(nextMode);
    localStorage.setItem(APPROVAL_MODE_KEY, nextMode);
    setApprovalModeSaving(true);
    try {
      await saveApprovalMode(nextMode);
    } catch (error) {
      setApprovalModeState(previous);
      localStorage.setItem(APPROVAL_MODE_KEY, previous);
      const approvalEndpointMissing = /(?:HTTP\s+404|api endpoint not found|cannot\s+(?:patch|post|get)\s+.*approval)/i.test(String((error as Error).message || ""));
      setModelMsg(approvalEndpointMissing
        ? "审批接口不存在：服务端未重启或前后端版本不一致，请重启规聚服务"
        : `审批模式切换失败：${(error as Error).message}`);
    } finally {
      setApprovalModeSaving(false);
    }
  }, [approvalMode, approvalModeSaving]);

  useEffect(() => {
    const mode = normalizeUiMode(editMode);
    if (MODE_META[mode] && !forcedMode) localStorage.setItem(MODE_KEY, mode);
  }, [editMode, forcedMode]);

  const initialReferenceKey = initialReferences.map((r) => `${r.id || ""}:${r.kind || ""}:${r.target || ""}`).join("|");
  useEffect(() => {
    setReferences(initialReferences.filter((item) => item?.target));
    // 旧实现以 initialReferenceKey 为唯一依赖：键不变时不重置用户手动增删的引用。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialReferenceKey]);

  useEffect(() => {
    if (!embedded || !threadId) return;
    try {
      localStorage.setItem(`oaw_embedded_messages_${threadId}`, JSON.stringify(messages.slice(-80)));
    } catch {}
  }, [embedded, messages, threadId]);

  useEffect(() => {
    const found = parseReferenceMarkers(input);
    if (!found.length) return;
    setReferences((prev) => {
      const merged = [...found, ...prev.filter((r) => input.includes(r.source || `@${r.target}`))] as ChatReference[];
      return merged.filter((r, i, arr) => arr.findIndex((x) => x.id === r.id) === i);
    });
  }, [input]);

  // 组件卸载时标记
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // 清理定时器和动画帧
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (textRevealRafRef.current) {
        cancelAnimationFrame(textRevealRafRef.current);
        textRevealRafRef.current = null;
      }
      if (toolOutputRafRef.current) {
        cancelAnimationFrame(toolOutputRafRef.current);
        toolOutputRafRef.current = null;
      }
      if (connectionTimerRef.current) {
        window.clearTimeout(connectionTimerRef.current);
        connectionTimerRef.current = null;
      }
      toolOutputQueueRef.current.clear();
      textRevealRef.current = null;
    };
  }, []);

  // 加载历史会话消息（点击历史列表时触发）
  useEffect(() => {
    // 另一线程的历史不能替换当前线程的消息：切换线程时会先收到新的
    // historyMessages，而 threadId 在恢复完成后才更新，中间渲染必须忽略。
    if (historyThreadId && historyThreadId !== threadId) return;
    if (historyMessages) {
      followLatestRef.current = true;
      const normalizedHistory = normalizeHistoryMessages(historyMessages);
      setMessages(normalizedHistory);
      const latestRun = [...normalizedHistory].reverse().find((item) => item?.runId && item?.runStatus);
      const isLiveRun = Boolean(latestRun && LIVE_RUN_STATUSES.has(latestRun.runStatus as string));
      const latestAssistant = [...normalizedHistory].reverse().find((item) => item?.role === "assistant");
      for (const message of normalizedHistory) {
        if (message?.role === "assistant" && message?.id) {
          displayedTextRef.current.set(message.id as string, 提取消息展示文本(message));
        }
      }
      setMessageWindowSize(MAX_VISIBLE_MESSAGES);
      setBusy(isLiveRun);
      const latestRunTask = (latestRun?.task ?? null) as Record<string, unknown> | null;
      setRunState({
        status: (latestRun?.runStatus as string | undefined) || "idle",
        runId: latestRun?.runId || null,
        artifacts: (latestRun?.artifacts as unknown[] | undefined) || [],
        references: (latestRun?.references as unknown[] | undefined) || [],
        task: latestRun?.task || null,
        mode: normalizeUiMode(latestRunTask?.mode),
      });
      setTodoItems([]);
      const latestRunEvents = (Array.isArray(latestRun?.events) ? (latestRun!.events as FlowEvent[]) : []);
      const historyFlowEvents = latestRunEvents
        .filter((event) => FLOW_EVENT_TYPES.has(event?.type as string))
        .map((event, eventIndex) => ({
          ...event,
          key: event.key || `history:${latestRun!.runId}:${(event as { seq?: unknown }).seq || eventIndex}`,
          data: (event as { data?: Record<string, unknown> }).data || {},
          at: event.at || new Date().toISOString(),
        }))
        .reduce((items, event) => appendExecutionFlowEvent(items, event), [] as FlowEvent[]);
      replaceExecutionEvents(historyFlowEvents);
      // 已完成历史只用于展示，不能成为 SSE 的当前运行锚点；否则下一轮
      // 的 run_finished/token 会被旧 runId 过滤掉。
      activeRunIdRef.current = isLiveRun ? (latestRun!.runId as string) : null;
      runInProgressRef.current = isLiveRun;
        if (latestRunTask?.mode) setEditMode(normalizeUiMode(latestRunTask.mode));
        stoppingRef.current = false;
        stopRequestedRef.current = false;
        roundStoppedRef.current = false;
        setStopping(false);
      // OAW_REPLAY_RECOVER（F4）：恢复水合场景不锚定历史最后一条 assistant 气泡——
      // 运行中那条消息尚未落盘，锚定会把回放 token 拼进上一轮气泡；改为由
      // ensureAssistant 新建气泡承载恢复的流式内容（flag 关 = 基线锚定）。
      assistantIdRef.current = isLiveRun ? (flag("replayRecover") ? null : ((latestAssistant?.id as string | undefined) || null)) : null;
      lastAssistantIdRef.current = (latestAssistant?.id as string | undefined) || null;
      streamBufRef.current = null;
      streamingMsgIdRef.current = assistantIdRef.current;
      if (textRevealRafRef.current) cancelAnimationFrame(textRevealRafRef.current);
      textRevealRafRef.current = null;
      textRevealRef.current = null;
      systemEventKeysRef.current.clear();
      queueRef.current = [];
      setQueuedMessages([]);
      setInjectedContext([]);
      setAgentPhase("");
      agentEventAtRef.current = 0;
      agentErrorRef.current = false;
    }
    // 旧实现仅依赖 historyMessages。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyMessages]);

  // 切换子对话时只切换本地视图，不销毁其它会话的消息/运行状态。
  // 后端 SSE 会随 thread 重连；旧 thread 的任务继续由任务中心跟踪。
  useEffect(() => {
    const previous = previousThreadRef.current;
    if (previous === threadId) return;
    followLatestRef.current = true;
    runtimeConnectingEventRef.current = null;
    const hydratingHistory = Boolean(historyMessages && historyThreadId === threadId);
    const hydratedMessages = hydratingHistory ? normalizeHistoryMessages(historyMessages) : [];
    const hydratedRun = [...hydratedMessages].reverse().find((item) => item?.runId && item?.runStatus);
    const hydratedIsLive = Boolean(hydratedRun && LIVE_RUN_STATUSES.has(hydratedRun.runStatus as string));
    const hydratedAssistant = [...hydratedMessages].reverse().find((item) => item?.role === "assistant");
    threadCacheRef.current.set(previous, {
      messages,
      runState,
      todoItems,
      busy,
      editMode,
    });
    const cached = threadCacheRef.current.get(threadId);
    if (!hydratingHistory) {
      setMessages(cached?.messages || []);
      setMessageWindowSize(MAX_VISIBLE_MESSAGES);
      setRunState(cached?.runState ? { ...cached.runState, mode: normalizeUiMode(cached.runState.mode) } : { status: "idle", runId: null, artifacts: [], references: [], task: null, mode: normalizeUiMode(editMode) });
      setTodoItems(cached?.todoItems || []);
      replaceExecutionEvents([]);
      activeRunIdRef.current = cached?.runState && LIVE_RUN_STATUSES.has(cached.runState.status)
        ? ((cached.runState.runId as string | null) || null)
        : null;
      if (cached?.editMode) setEditMode(normalizeUiMode(cached.editMode));
      setBusy(Boolean(cached?.busy));
    }
      setStopping(false);
      stoppingRef.current = false;
      stopRequestedRef.current = false;
      roundStoppedRef.current = false;
      // OAW_REPLAY_RECOVER（F4）：同上，恢复水合时不锚定历史气泡（flag 关 = 基线锚定）。
      assistantIdRef.current = hydratedIsLive ? (flag("replayRecover") ? null : ((hydratedAssistant?.id as string | undefined) || null)) : null;
    lastAssistantIdRef.current = hydratingHistory ? ((hydratedAssistant?.id as string | undefined) || null) : null;
    streamBufRef.current = null;
    streamingMsgIdRef.current = assistantIdRef.current;
    if (textRevealRafRef.current) cancelAnimationFrame(textRevealRafRef.current);
    textRevealRafRef.current = null;
    textRevealRef.current = null;
    if (hydratingHistory) activeRunIdRef.current = hydratedIsLive ? ((hydratedRun?.runId as string | null) || null) : null;
    runInProgressRef.current = hydratingHistory ? hydratedIsLive : Boolean(cached?.busy);
    queueRef.current = [];
    setQueuedMessages([]);
    setInjectedContext([]);
    setReferences([]);
    setImages([]);
    setAttachments([]);
    // 交互 3：切会话时先把 A 的未发送内容存进 A 的草稿位，再取回 B 自己的草稿；
    // 这样既不丢草稿，也不会把 A 的内容带到 B。
    if (input) writeDraft(previous, input);
    setInput(readDraft(threadId));
    if (!hydratingHistory) {
      setLastPrompt(null);
      setAgentPhase("");
      agentEventAtRef.current = 0;
    }
    agentErrorRef.current = false;
    systemEventKeysRef.current.clear();
    previousThreadRef.current = threadId;
    // 旧实现依赖 [historyMessages, historyThreadId, threadId]。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyMessages, historyThreadId, threadId]);

  // 新建会话：清空消息
    const handleNewSession = useCallback(() => {
      setMessages([]);
      setMessageWindowSize(MAX_VISIBLE_MESSAGES);
      setBusy(false);
      stoppingRef.current = false;
      stopRequestedRef.current = false;
      roundStoppedRef.current = false;
      setStopping(false);
    assistantIdRef.current = null;
    lastAssistantIdRef.current = null;
    streamBufRef.current = null;
    streamingMsgIdRef.current = null;
    if (textRevealRafRef.current) cancelAnimationFrame(textRevealRafRef.current);
    textRevealRafRef.current = null;
    textRevealRef.current = null;
    setInput("");
    writeDraft(threadId, "");
    setLastPrompt(null);
    setAgentPhase("");
    agentEventAtRef.current = 0;
    agentErrorRef.current = false;
    setReferences([]);
    setImages([]);
    setAttachments([]);
    queueRef.current = [];
    setQueuedMessages([]);
    setInjectedContext([]);
    setRunState({ status: "idle", runId: null, artifacts: [], references: [], task: null, mode: normalizeUiMode(editMode) });
    setTodoItems([]);
    replaceExecutionEvents([]);
    activeRunIdRef.current = null;
    runInProgressRef.current = false;
    systemEventKeysRef.current.clear();
    if (onNewSession) onNewSession();
  }, [onNewSession, replaceExecutionEvents, threadId]);

  // 暴露插入文本方法（供 @ 按钮调用）
  useImperativeHandle(ref, () => ({
    setMode(mode: string) {
      if (forcedMode) return false;
      const nextMode = normalizeUiMode(mode);
      setEditMode(nextMode);
      setRunState((state) => ({ ...state, mode: nextMode }));
      return true;
    },
    insertText(text: string) {
      const found = parseReferenceMarkers(text);
      if (found.length) setReferences((prev) => [...prev, ...found.filter((r) => !prev.some((p) => p.id === r.id))] as ChatReference[]);
      updateInput((v) => {
        const sep = v && !v.endsWith(" ") ? " " : "";
        return v + sep + text;
      });
    },
    insertContext(text: string) {
      const value = String(text || "").trim();
      if (!value) return;
      updateInput((v) => {
        const prefix = v && !v.endsWith("\n") ? "\n\n" : "";
        return `${v}${prefix}[选区上下文]\n${value}\n[/选区上下文]`;
      });
      setModelMsg("已加入选区上下文，请补充指令后发送");
      window.setTimeout(() => setModelMsg(""), 2600);
    },
    startAgentTask(payload: Record<string, unknown> = {}) {
      const taskText = String(payload.text || "").trim();
      const nextReferences = Array.isArray(payload.references) ? (payload.references as ChatReference[]).filter((item) => item?.target) : [];
      const markers = nextReferences.map(referenceMarker).filter(Boolean);
      const skillMarkers = (Array.isArray(payload.skills) ? (payload.skills as unknown[]) : []).map((name) => `@技能[${String(name).trim()}]`).filter((name) => name !== "@技能[]");
      const workflowMarker = payload.workflowId ? `@工作流[${String(payload.workflowId)}]` : "";
      const prompt = [taskText, ...markers, ...skillMarkers, workflowMarker].filter(Boolean).join(" ");
      if (!prompt) return;
      setEditMode("agent");
      setReferences(nextReferences);
      setInjectedContext(payload.contextText ? [{ text: String(payload.contextText) }] : []);
      updateInput(prompt);
      setRunState((state) => ({ ...state, mode: "agent" }));
      setModelMsg("已转为 Agent 任务，请确认后发送");
      window.setTimeout(() => setModelMsg(""), 3200);
    },
    focusRun() {
      const el = bodyRef.current;
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: motionScrollBehavior() });
    },
  }));

  // 同步外部 models
  useEffect(() => { if (modelsProp?.length) setModels(modelsProp); }, [modelsProp]);

  // 初始化模型：等待真实列表后再选择，避免 App 首次传入空数组时选中失效模型。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let d: { models?: ChatModel[]; default?: string; counts?: { available?: number; configured?: number } } = { models: modelsProp || [], default: defaultModel || "" };
      if (!modelsProp?.length) {
        try { d = (await listModels()) as typeof d; } catch {}
      }
      if (cancelled) return;
      const nextModels = d.models || [];
      setModels(nextModels);
      if (d.counts) setModelCounts(d.counts as { available: number; configured: number });
      const saved = localStorage.getItem(MODEL_KEY);
      const preferred = saved || d.default || "";
      const cur = nextModels.some((m) => m.id === preferred) ? preferred : (nextModels[0]?.id || "");
      setModel(cur);
      applyModel(cur, nextModels);
      onModelChange?.(cur);
      // 初始化只读取本地偏好，不主动触发 provider 初始化。真正发送时由服务端
      // 在同一个 admission 链路同步模型，避免页面加载/切换会话与 Agent 运行竞态。
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelsProp, defaultModel, clientId, threadId, onModelChange]);

  // 设置面板与输入框共用同一个当前模型；真正切换仍沿用原有 Pi/Agent API。
  useEffect(() => {
    if (!selectedModel || selectedModel === model || !models.some((item) => item.id === selectedModel)) return;
    void changeModel(selectedModel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedModel, model, models]);

  function applyModel(id: string, list?: ChatModel[]) {
    const m = (list || models).find((x) => x.id === id);
    setModelVision(!!m?.vision);
    localStorage.setItem(MODEL_KEY, id);
  }

  const changeModel = async (id: string) => {
    setModel(id);
    applyModel(id);
    onModelChange?.(id);
    rememberModel(id);
    setModelMsg("切换中...");
    try {
      const result = await setAgentModel(clientId, id, threadId || undefined);
      const resultView = result as { pending?: unknown; model?: string; current?: string };
      // 运行中切换：服务端把切换排队到本轮结束（本轮仍由旧模型跑完），
      // 这里保持提示可见，等 model_switched(effective=now) 再收尾。
      if (resultView?.pending) {
        setPendingModel(resultView.model || id);
        setModelMsg(`本轮仍由 ${resultView.current || "当前模型"} 执行；已排队，本轮结束后切换为 ${resultView.model || id}`);
        return;
      }
      setPendingModel("");
      if (resultView?.model && resultView.model !== id) {
        setModel(resultView.model);
        applyModel(resultView.model);
        onModelChange?.(resultView.model);
        rememberModel(resultView.model);
        setModelMsg(`连接失败，已切换到 ${resultView.model}`);
      } else setModelMsg("ok");
    }
    catch (e) { setModelMsg("失败: " + (e as Error).message); }
    setTimeout(() => setModelMsg(""), 2500);
  };

  // ============================================================================
  // 事件状态机（批6b）与对话流连接层（批6c）的编排接线
  // ============================================================================

  // 机器单次创建：闭包值经 latestRef 读取「最近一次已提交渲染」，组件级回调经
  // implRef 间接调用最新实现——等价旧 handleEvent 每 render 重定义的语义。
  const machine = useMemo(() => createChatEventMachine({
    refs: {
      mountedRef, activeRunIdRef, runInProgressRef, agentEventAtRef, assistantIdRef, lastAssistantIdRef,
      streamingMsgIdRef, streamBufRef, rafRef, toolOutputQueueRef, toolOutputRafRef, textRevealRef,
      textRevealRafRef, displayedTextRef, stoppingRef, stopRequestedRef, roundStoppedRef, stopConfirmTimerRef,
      agentErrorRef, systemEventKeysRef, replayProbeRef, replayBufferRef, runtimeConnectingEventRef, connectionTimerRef,
    },
    getBusy: () => latestRef.current.busy,
    getRunState: () => latestRef.current.runState,
    getModel: () => latestRef.current.model,
    getForcedMode: () => latestRef.current.forcedMode,
    getThreadId: () => latestRef.current.threadId,
    getWorkspace: () => latestRef.current.workspace,
    setMessages,
    setBusy,
    setRunState: (updater) => setRunState(updater),
    setAgentPhase,
    setConnected,
    setModelMsg,
    setTodoItems,
    setEditMode,
    setStopping,
    setPendingModel,
    setModel,
    setLastMapVisual: (value) => setLastMapVisual(value as Record<string, unknown> | null),
    setMapVisualHint,
    setConnectionNotice: (value) => setConnectionNotice(value as { state?: unknown; message?: unknown } | null),
    enqueueExecutionEvent,
    pushSystemNote,
    clearSystemNotes,
    rememberModel,
    applyModel: (id) => implRef.current.applyModel(id),
    flushQueued: (force) => implRef.current.flushQueued(force),
    onFileChanged: (files) => implRef.current.onFileChanged?.(files),
    onMapAction: (data) => implRef.current.onMapAction?.(data),
    onRunFinished: (data) => implRef.current.onRunFinished?.(data),
    onAgentEnd: () => implRef.current.onAgentEnd?.(),
    onBrowserActivity: () => implRef.current.onBrowserActivity?.(),
    onModelChange: (id) => implRef.current.onModelChange?.(id),
    // 机器无自有状态（refs/deps 全稳定），单次创建即可。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);
  const { handleEvent, patch, cancelTextReveal, flushNow, pushSystem, upsertRunSummary, finalizeStopped } = machine;

  // 对话流连接：桥可用走 IPC transport（新 UI 主路径），否则 SSE transport
  // （web / 无桥降级，jsdom 对拍同走此形态）。连接状态机与旧 SSE effect 逐行同构。
  useEffect(() => {
    const transport = getDesktopApi() ? createIpcThreadEventTransport() : createSseThreadEventTransport();
    return createChatEventStreamController({
      clientId,
      threadId,
      workspace,
      refs: {
        mountedRef,
        handshakeDoneRef,
        eventCursorRef,
        eventCursorsRef,
        streamIdsRef,
        streamReadyRef,
        streamGenerationRef,
        eventHandlerRef: eventHandlerRef as { current: ((event: ChatEventInput) => void) | null },
      },
      setConnected,
      transport,
    });
  }, [clientId, threadId, workspace]);

  // 恢复/切换会话后拉取服务端保存的上下文用量，避免刷新后一直显示 0
  useEffect(() => {
    let cancelled = false;
    if (!clientId) return undefined;
    (async () => {
      try {
        // 旧实现 fetch /api/agent/runtime；桌面形态走 IPC op:agent:runtime（非 2xx throw）。
        const data = await getAgentRuntime(clientId, threadId || undefined);
        if (cancelled) return;
        const snapshot = (data as { usage?: Record<string, unknown> | null }).usage;
        if (!snapshot) return;
        const snapshotUsage = (snapshot.usage
          ? { ...(snapshot.usage as Record<string, unknown>) }
          : Number(snapshot.estimatedContextTokens) > 0
            ? { context: Number(snapshot.estimatedContextTokens) }
            : null) as Record<string, unknown> | null;
        if (snapshotUsage) {
          snapshotUsage.contextWindow = snapshot.contextWindow;
          snapshotUsage.compactThreshold = snapshot.compactThreshold;
          snapshotUsage.compactionMode = snapshot.compactionMode;
          snapshotUsage.compactThresholdSource = snapshot.compactThresholdSource;
          snapshotUsage.compactionReserveTokens = snapshot.compactionReserveTokens;
          snapshotUsage.compactionKeepRecentTokens = snapshot.compactionKeepRecentTokens;
          setRunState((s) => (s.usage ? s : { ...s, usage: snapshotUsage }));
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [clientId, threadId]);

  // Run 的 steps 是 Todo 的唯一事实来源。对话事件只负责实时刷新，
  // 这里在拿到 runId 后立即拉取，并在执行期间短轮询，避免 Todo 只存在于任务中心。
  // 同时覆盖“后端已完成但 SSE 终结事件丢失”的情况：用当前 thread 找回 Run，
  // 再注入一个幂等的 run_finished，让输入框和状态栏恢复可用。
  // OAW_REPLAY_RECOVER：开关快照异步到达（初始全关），就绪后重跑一次冷启动探测。
  useEffect(() => {
    let active = true;
    flagsReady.then(() => { if (active) setReplayFlagsTick((t) => t + 1); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    const runId = runState.runId as string | null;
    const activeStatuses = ["running", "queued", "waiting_user", "recovering", "cancel_requested", "finishing"];
    const shouldReconcile = busy || activeStatuses.includes(runState.status);
    if (!runId && !shouldReconcile) {
      // OAW_REPLAY_RECOVER（F1）：冷启动（无历史水合、本地 idle）时探测本 thread 是否
      // 仍有执行中的 Run；命中则恢复运行上下文并冲刷探测期间缓冲的回放事件，使刷新后
      // 的对话能重建“运行中”的实时内容。探测每 thread 仅一次，flag 关 = 基线行为。
      if (flag("replayRecover") && threadId && !replayProbedThreadsRef.current.has(threadId)) {
        replayProbedThreadsRef.current.add(threadId);
        replayProbeRef.current = { pending: true, thread: threadId };
        replayBufferRef.current = [];
        const probeThread = threadId;
        void (async () => {
          try {
            const result = await listRuns(probeThread, 12, { cwd: workspace });
            if (replayProbeRef.current.thread !== probeThread) return; // 已切走：新探测接管
            const live = ((result as { runs?: ReconcileRun[] }).runs || [])
              .filter((item) => item?.clientId === clientId && activeStatuses.includes(item.status as string))
              .sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")))[0] || null;
            if (live) {
              // F4：恢复的流式内容进新气泡，不续写历史最后一条 assistant（防跨轮拼接）
              assistantIdRef.current = null;
              runInProgressRef.current = true;
              activeRunIdRef.current = live.id as string;
              setBusy(true);
              setRunState((s) => ({ ...s, status: live.status as string, runId: live.id, task: live.task || s.task, artifacts: live.artifacts || s.artifacts, references: live.references || s.references, mode: normalizeUiMode((live.task as { mode?: unknown } | null | undefined)?.mode) }));
              const nextTodos = live.todoVersion === 1 && Array.isArray(live.todos) ? live.todos : (Array.isArray(live.steps) ? live.steps : []);
              if (nextTodos.length) setTodoItems(nextTodos);
            }
          } catch {}
          replayProbeRef.current = { pending: false, thread: null };
          const buffered = replayBufferRef.current;
          replayBufferRef.current = [];
          for (const ev of buffered) eventHandlerRef.current?.(ev);
        })();
      } else {
        setTodoItems([]);
      }
      return undefined;
    }
    let cancelled = false;
    let inFlight = false;
    const refresh = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        let run: ReconcileRun | null = null;
        if (runId) {
          run = ((await getRun(runId)) as { run?: ReconcileRun | null }).run || null;
        } else {
          const result = await listRuns(threadId || "", 12, { cwd: workspace });
          run = ((result as { runs?: ReconcileRun[] }).runs || [])
            .filter((item) => item?.clientId === clientId && activeStatuses.includes(item.status as string))
            .sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")))[0] || null;
        }
        if (cancelled || !run) return;
        const nextTodos = run.todoVersion === 1 && Array.isArray(run.todos)
          ? run.todos
          : (Array.isArray(run.steps) ? run.steps : []);
        setTodoItems(nextTodos);
        const terminal = ["completed", "failed", "cancelled", "aborted"].includes(run.status as string);
        // 只有活动 Run 才能成为 SSE 过滤锚点；历史终态 Run 只用于展示，
        // 否则切回历史会话后，下一轮新 Run 的事件会被旧 ID 丢弃。
        if (!terminal && !activeRunIdRef.current && run.id) activeRunIdRef.current = run.id;
        if (terminal && activeRunIdRef.current === run.id) activeRunIdRef.current = null;
        if (run.id !== (runState.runId as string | null)) {
          setRunState((state) => ({ ...state, runId: run!.id, status: run!.status as string, task: run!.task || state.task, artifacts: run!.artifacts || state.artifacts, references: run!.references || state.references }));
        }
        if (terminal && !reconciledRunIdsRef.current.has(run.id as string)) {
          reconciledRunIdsRef.current.add(run.id as string);
          eventHandlerRef.current?.({
            id: `reconcile-${run.id}`,
            type: "run_finished",
            at: run.finishedAt || run.updatedAt || new Date().toISOString(),
            data: {
              runId: run.id,
              status: run.status,
              artifacts: run.artifacts || [],
              references: run.references || [],
              verificationStatus: run.verificationStatus || "not_checked",
              finalText: (([...(Array.isArray(run.events) ? (run.events as Array<Record<string, unknown> | null | undefined>) : [])].reverse().find((item) => item?.type === "assistant_final" && String((item?.data as Record<string, unknown> | null | undefined)?.text || "").trim())?.data as Record<string, unknown> | null | undefined)?.text as string | undefined) || "",
              // 带上本轮事件：结果卡的「用时 / 每轮 token」明细由回合与用量事件归约而来，
              // SSE 的 run_finished 不带事件（体积考虑），只有这条对账路径能补齐，
              // 否则刚跑完的一轮要等重开会话才看得到指标。
              events: Array.isArray(run.events) ? run.events : [],
              recovered: true,
            },
          });
        }
      } catch {} finally {
        inFlight = false;
      }
    };
    void refresh();
    // stream_resync 等场景要求立即对账一次，不等下一个轮询周期
    const onForceReconcile = () => { void refresh(); };
    window.addEventListener("oaw:force-reconcile", onForceReconcile);
    const timer = shouldReconcile ? window.setInterval(refresh, 900) : null;
    return () => {
      cancelled = true;
      window.removeEventListener("oaw:force-reconcile", onForceReconcile);
      if (timer) window.clearInterval(timer);
    };
    // 旧实现依赖 [clientId, threadId, workspace, runState.runId, runState.status, busy, replayFlagsTick]。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, threadId, workspace, runState.runId, runState.status, busy, replayFlagsTick]);

  // 脑图点击工具节点：在消息流中展开对应工具卡（工具卡默认折叠）
  const focusTool = useCallback((toolId: unknown) => {
    const value = String(toolId || "");
    if (!value) return;
    setMessages((list) => list.map((message) => {
      if (!Array.isArray(message.blocks)) return message;
      let changed = false;
      const blocks = message.blocks.map((block) => {
        if (block.type === "tool" && (block.id === value || block.toolCallId === value)) {
          if (block.expanded) return block;
          changed = true;
          return { ...block, expanded: true };
        }
        return block;
      });
      return changed ? { ...message, blocks } : message;
    }));
  }, []);

  const send = async (overrideText?: string, options: SendOptions = {}) => {
    if (frozen) {
      setModelMsg("当前会话已冻结，可查看历史或新建分支；如需继续请先解冻。");
      window.setTimeout(() => setModelMsg(""), 3200);
      return;
    }
    if (stoppingRef.current) return;
    const source = options.payload || ({} as NonNullable<SendOptions["payload"]>);
    const sourceImages = source.images || images;
    const sourceAttachments = source.attachments || attachments;
    const sourceReferences = source.references || references;
    const rawText = String(source.rawText ?? overrideText ?? input).trim();
    if (!rawText && sourceImages.length === 0 && sourceAttachments.length === 0) return;
    if (!options.payload && /^\/(?:compact|new|chat|agent|review|help)$/i.test(rawText)) {
      const command = rawText.toLowerCase();
      clearInput();
      setComposerMenu(null);
      if (command === "/compact") return compactContext();
      if (command === "/new") { onNewSession?.(workspace); return; }
      if (["/chat", "/agent", "/review"].includes(command)) {
        const mode = command.slice(1);
        setEditMode(mode);
        pushSystem("已切换到 " + (mode === "chat" ? "Chat（只读检索）" : mode === "review" ? "Review（审查与安全副本）" : "Work（执行与产出）") + "。");
        return;
      }
      pushSystem("输入帮助：/compact 压缩上下文；/new 新建会话；/chat、/agent 或 /review 切换模式；@ 选择文件；& 选择历史会话。", "composer-help");
      return;
    }
    const text = rawText || (sourceImages.length ? "（图片消息）" : "（附件消息）");
    followLatestRef.current = true;
    const contextNotes = source.contextNotes || injectedContext;
    const contextImages = contextNotes.flatMap((note) => note.images || []);
    const contextAttachments = contextNotes.flatMap((note) => note.attachments || []);
    const allImages = [...contextImages, ...sourceImages];
    const allAttachments = [...contextAttachments, ...sourceAttachments];
    const imgs = allImages.map((i) => ({ mediaType: i.mediaType, data: i.data }));
    const atts = allAttachments.map((a) => ({ name: a.name, mediaType: a.mediaType, data: a.data }));
    const sendReferences = [...sourceReferences, ...parseReferenceMarkers(text)].filter((r, i, arr) => arr.findIndex((x) => x.id === r.id) === i);

    // 当前任务执行中：默认排队，另一种选择是只保存为下一轮上下文，不再隐式 steer 打断当前回复。
    if (busy && !options.force) {
      if (busyInputMode === "context") {
        setInjectedContext((prev) => [...prev, { text, images: sourceImages, attachments: sourceAttachments }]);
        clearInput();
        setImages([]);
        setAttachments([]);
        pushSystem("已加入待注入上下文，不会打断当前任务。", `context:${Date.now()}:${text.slice(0, 40)}`);
        return;
      }
      if (busyInputMode === "queue") {
        const messageId = newId();
        const item: QueuedItem = {
          messageId,
          rawText,
          images: sourceImages,
          attachments: sourceAttachments,
          references: sourceReferences,
          contextNotes,
          currentDoc,
          editMode,
          effort,
        };
        const nextQueue = [...queueRef.current, item];
        queueRef.current = nextQueue;
        setQueuedMessages(nextQueue);
        setMessages((ms) => [...ms, {
          id: messageId, role: "user", text,
          images: sourceImages.map((i) => i.dataUrl).filter(Boolean),
          attachments: sourceAttachments.map((a) => a.name),
          references: sendReferences,
          status: "queued", queued: true, currentDoc,
          createdAt: Date.now(),
        }]);
        clearInput();
        setImages([]);
        setAttachments([]);
        setInjectedContext([]);
        pushSystem(`已排队第 ${nextQueue.length} 条，当前任务完成后自动执行。`, `queue:${messageId}`);
        return;
      }
      // busyInputMode === "steer"：立即插入新指令（服务端 streamingBehavior=steer 打断当前回合）
      pushSystem("正在插入新指令，当前回合将被打断…", `steer_send:${Date.now()}:${rawText.slice(0, 40)}`);
    }

    // 注入当前文件上下文。用户在本轮目标标签里移除当前文件后，本轮不再注入，
    // 但真正打开的文件和后续轮次不受影响。
    const selectedCurrentDoc = source.currentDoc ?? (contextFileDismissed ? null : currentDoc);
    const selectedEditMode = normalizeUiMode(forcedMode || source.editMode || editMode);
    const selectedEffort = source.effort ?? effort;
    if (selectedEditMode === "review" && !selectedCurrentDoc && !sendReferences.some((item) => item?.kind === "file") && !allAttachments.length) {
      setModelMsg("Review 需要先打开、@ 引用或上传一份材料");
      window.setTimeout(() => setModelMsg(""), 3200);
      return;
    }
    const contextPrefix = selectedCurrentDoc ? `[当前打开文件: ${selectedCurrentDoc}]\n` : "";
    // mapContext 的 center/bounds 在宽松视图类型里是 unknown，模板插值前按数组收窄（运行时形状不变）。
    const mapCenter = mapContext?.center as number[] | undefined;
    const mapBounds = mapContext?.bounds as number[] | undefined | null;
    const mapContextPrefix = mapProject
      ? `[当前地图项目: ${mapProject}${mapCenter ? `；视图中心 ${mapCenter[0]},${mapCenter[1]}；缩放 ${mapContext?.zoom}；可视范围 ${mapBounds?.join(",") || "未知"}` : ""}]\n`
      : mapCenter
        ? `[当前地图视图: 中心 ${mapCenter[0]},${mapCenter[1]}；缩放 ${mapContext?.zoom}；可视范围 ${mapBounds?.join(",") || "未知"}]\n`
        : "";
    const contextPrefixText = [
      contextText ? `## 当前检索上下文\n${contextText}` : "",
      contextNotes.length ? `## 已注入上下文\n${contextNotes.map((note) => note.text).join("\n\n")}` : "",
    ].filter(Boolean).join("\n\n");
    const contextPrefixWithSpacing = contextPrefixText ? `${contextPrefixText}\n\n` : "";
    const attachPrefix = allAttachments.length > 0
      ? `[已上传附件: ${allAttachments.map((a) => a.name).join(", ")}，文件已保存到工作区，可读取处理]\n`
      : "";
    // 能力规划必须只基于用户的原始意图、显式引用和结构化 task 字段。
    // 不能把“Agent 可以使用 Skills / Office CLI”之类的 UI 说明混入 text，
    // 否则普通输入也会被关键词规划器误判为 Office / Skills 任务。
    const fullText = contextPrefix + mapContextPrefix + contextPrefixWithSpacing + attachPrefix + (rawText || text);

    if (!mountedRef.current) return;

    const queuedMessageId = source.messageId;
    if (queuedMessageId) {
      patch(queuedMessageId, (m) => ({ ...m, status: "done", queued: false, references: sendReferences }));
    } else {
      setMessages((ms) => [...ms, {
        id: newId(), role: "user", text,
        images: sourceImages.map((i) => i.dataUrl).filter(Boolean),
        attachments: sourceAttachments.map((a) => a.name),
        references: sendReferences,
        status: "done", currentDoc: selectedCurrentDoc,
        createdAt: Date.now(),
      }]);
    }
    setLastPrompt({ text: rawText || text, references: sendReferences as ChatReference[], contextText, skills: source.skills || [] });
    const aid = newId();
    cancelTextReveal({ preserveText: true });
    lastAssistantIdRef.current = null;
    assistantIdRef.current = aid;
    lastAssistantIdRef.current = aid;
    streamingMsgIdRef.current = aid;
    streamBufRef.current = { text: "", thinking: "" };
    setMessages((ms) => [...ms, {
      id: aid, role: "assistant", blocks: [],
      // 记下本轮实际发出的模型：流式期间就能按轮显示"由谁执行"，也是切换分割线的依据。
      model: model || "",
      status: "streaming", images: [],
      createdAt: Date.now(),
    }]);
    clearInput();
    setImages([]);
    setAttachments([]);
    setInjectedContext([]);
    setContextFileDismissed(false);
    setBusy(true);
    runInProgressRef.current = true;
    agentErrorRef.current = false;
    roundStoppedRef.current = false;
    activeRunIdRef.current = null;
    agentEventAtRef.current = 0;
    replaceExecutionEvents(runtimeConnectingEventRef.current ? [runtimeConnectingEventRef.current] : []);
    // 提交即显示"思考中"：用户按下回车后需要立刻看到模型在工作，
    // 而不是先看到一串"准备…"。后续阶段事件会把这个措辞细化（等待首个事件/正在生成）。
    setAgentPhase("思考中");
    setRunState({ status: "running", runId: null, artifacts: [], references: sendReferences, mode: selectedEditMode });
    // 请求失败（网络/服务端拒绝）时把草稿放回输入框，用户可以直接重试，
    // 不用重新打一遍；队列来源的 payload 不属于草稿，不重复回填。
    const restoreDraft = () => {
      if (options.payload) return;
      updateInput((value) => (value ? value : rawText));
      if (mountedRef.current) requestAnimationFrame(() => textareaRef.current?.focus());
    };
    try {
      // 首字延迟分项（方案 §3.5）：提交即开始计时。
      startLatencyProbe({ model: model || null, mode: selectedEditMode || null, reducedMotion: isMotionReduced() });
      // prompt 是异步 admission；SSE 未完成握手时，本轮最早的 run_admitting/首个 token
      // 可能先于 EventSource 到达。但已经建立的连接没有任何理由再等——
      // 新连接的事件由服务端 channel.history 按游标回放补齐，不必用固定 3 秒门槛拦住发送。
      const currentStreamKey = `${clientId}::${threadId || ""}`;
      const streamReady = streamReadyRef.current?.streamKey === currentStreamKey
        ? streamReadyRef.current.promise
        : null;
      let handshakeWaitMs = 0;
      if (streamReady && !connected) {
        // 早先这里等满 3 秒才开始 POST：SSE 没握手时用户每轮都要多等 3 秒才看到模型动。
        // 其实不需要等——服务端 channel.history 会按游标把错过的事件补回来，
        // 这里只留一个很短的窗口（连接刚好在建时避免重复建连）。
        const waitStartedAt = Date.now();
        await Promise.race([
          streamReady,
          new Promise((resolve) => window.setTimeout(resolve, 600)),
        ]);
        handshakeWaitMs = Date.now() - waitStartedAt;
      }
      patchLatencyMeta({ handshakeWaitMs, streamReadyAtSend: Boolean(connected) });
      // 旧内联 fetch("/api/agent/prompt") → IPC 通道；admission 响应即旧 res.json()。
      // 非 2xx 由 invokeOrThrow 转 throw ApiError，catch 里按 ApiError 分支映射旧 !res.ok 语义。
      const d = await sendAgentPrompt({
        client: clientId,
        thread: threadId || undefined,
        text: fullText,
        images: imgs,
        attachments: atts,
        references: sendReferences,
        model,
        effort: selectedEffort,
        task: {
          goal: text,
          mode: selectedEditMode,
          workspace,
          projectId: (project?.id as string | undefined) || null,
          mapProject: mapProject || null,
          currentFile: selectedCurrentDoc || null,
          references: sendReferences,
          workflowId: text.match(/@工作流\[([^\]]+)\]/)?.[1] || null,
        },
      });
      if (!mountedRef.current) return;
      if (d.model && d.model !== model) {
        setModel(d.model);
        applyModel(d.model);
        if (d.modelFallbackFrom) {
          setModelMsg(`旧模型连接失败，已恢复到 ${d.model}`);
          window.setTimeout(() => setModelMsg(""), 3600);
        }
      }
      // 上报 pi 会话 id（App 持久化，刷新后恢复当前对话）
      if (d.sessionId) onSessionChange?.(d.sessionId);
      if (d.accepted) {
        if (d.queued) setAgentPhase(`已排队（第 ${d.queuePosition || 1} 项）`);
        else if (!agentEventAtRef.current) {
          setAgentPhase("已接收，等待模型首个事件");
          // 10 秒内没有收到任何 SSE 事件（半开连接/重连失败）：强制重连拉取回放
          const sentAt = agentEventAtRef.current;
          window.setTimeout(() => {
            if (mountedRef.current && agentEventAtRef.current === sentAt && runInProgressRef.current) {
              window.dispatchEvent(new CustomEvent("oaw:force-reconnect"));
            }
          }, 10000);
        }
      }
      if (d.runId) {
        activeRunIdRef.current = d.runId;
        patch(aid, (m) => ({ ...m, runId: d.runId, task: d.task || null, references: d.task?.references || sendReferences }));
        setRunState((s) => ({ ...s, runId: d.runId, references: d.task?.references || sendReferences, task: d.task || s.task }));
      }
    } catch (e) {
      if (!mountedRef.current) return;
      if (e instanceof ApiError) {
        // 旧 !res.ok 分支：转发器保留 HTTP 语义，ApiError.message = 服务端 error 文本。
        patch(aid, (m) => ({ ...m, status: "error", errorText: e.message || "请求失败" }));
        assistantIdRef.current = null;
        lastAssistantIdRef.current = null;
        if (mountedRef.current) setBusy(false);
        setAgentPhase("请求失败");
        setRunState((s) => ({ ...s, status: "failed" }));
      } else {
        // 旧 catch 分支（网络层失败）。
        patch(aid, (m) => ({ ...m, status: "error", errorText: "请求未完成：" + (e as Error).message }));
        assistantIdRef.current = null;
        lastAssistantIdRef.current = null;
        if (mountedRef.current) setBusy(false);
        setAgentPhase("网络请求失败");
      }
      restoreDraft();
    }
  };

  // 中止当前 agent 运行
  const stop = async () => {
    if (!busy || stoppingRef.current) return;
    stoppingRef.current = true;
    stopRequestedRef.current = true;
    setStopping(true);
    // 服务端收尾可能要等模型响应中断（实测数秒）。这里给 10 秒确认窗口：
    // 期间保持「中断中」而不是立刻假装停住——早先 1.2 秒就本地收尾，
    // 会出现"界面说停了、模型还在输出"的错觉。
    if (stopConfirmTimerRef.current) window.clearTimeout(stopConfirmTimerRef.current);
    stopConfirmTimerRef.current = window.setTimeout(() => {
      stopConfirmTimerRef.current = null;
      if (!stoppingRef.current) return;
      finalizeStopped();
      pushSystem("已请求中断，但服务端未在 10 秒内确认收尾（可能卡在不响应中断的工具里）；如仍在输出可再点一次中断或刷新页面。", "stop-unconfirmed");
    }, 10000);
    try {
      // 旧内联 fetch("/api/agent/abort") → IPC 通道；非 2xx 由 invokeOrThrow 转 throw ApiError。
      const result = await abortAgent(clientId, threadId || undefined);
      // 服务端如实返回是否真的取消了：没有在跑的任务时不要谎报"已中断"。
      if (result && result.cancelled === false) {
        if (stopConfirmTimerRef.current) {
          window.clearTimeout(stopConfirmTimerRef.current);
          stopConfirmTimerRef.current = null;
        }
        stoppingRef.current = false;
        stopRequestedRef.current = false;
        setStopping(false);
        pushSystem("没有找到正在运行的任务，可能这一轮已经结束了。", "stop-nothing");
      }
    } catch (e) {
      if (stopConfirmTimerRef.current) {
        window.clearTimeout(stopConfirmTimerRef.current);
        stopConfirmTimerRef.current = null;
      }
      stoppingRef.current = false;
      stopRequestedRef.current = false;
      setStopping(false);
      // 旧 `请求失败（${res.status}）` 文案形态：ApiError 携带 status 时按同构重建。
      const message = e instanceof ApiError && e.status ? `请求失败（${e.status}）` : ((e as Error).message || "网络错误");
      pushSystem(`中断失败：${message}`, "stop-failed");
    }
  };

  // 当前回合结束后只启动一条队列消息，避免多个请求同时争抢同一个 Pi 会话。
  const flushQueued = (force = false) => {
    if (stoppingRef.current || (!force && busy) || !queueRef.current.length) return;
    const next = queueRef.current[0]!;
    const rest = queueRef.current.slice(1);
    queueRef.current = rest;
    setQueuedMessages(rest);
    // agent_end 事件先于服务端 prompt finally 到达，留出收尾时间再发下一条，避免被误判为 steer。
    window.setTimeout(() => send(undefined, { force: true, payload: next }), 450);
  };

  // 每 render 接线：机器闭包值（等价旧 handleEvent 读取「最近一次已提交渲染」）与最新实现
  // （等价旧 handleEvent 每 render 重定义）。旧 2792-2797 的位置在 send 之前，这里移到
  // flushQueued 声明之后——接线块只在 render 期执行，时序语义不变。
  latestRef.current = { busy, runState, model, forcedMode, threadId, workspace };
  implRef.current = { applyModel, flushQueued, onFileChanged, onMapAction, onRunFinished, onAgentEnd, onBrowserActivity, onModelChange };
  // SSE 回调始终转发到最新的处理器，避免切换会话或模型后仍使用旧闭包。
  eventHandlerRef.current = handleEvent as unknown as (event: unknown) => void;
  // 测试钩子：把同一套事件处理器暴露到 window，供 L3 场景在真实事件路径上注入
  // （与 MapPanel 的 window.__oawMapBridge 同类：只读引用，不参与业务逻辑）。
  // 注意：handler 会先经 handleEvent 的"当前 Run 归属"过滤，行为与真实 SSE 一致。
  try { (window as unknown as { __oawChatEvents?: { handle: (event: unknown) => void } }).__oawChatEvents = { handle: handleEvent as unknown as (event: unknown) => void }; } catch {}

  const handleMemoryApprove = async (id: unknown) => {
    try {
      const d = await approveMemoryProposal(id as string) as { proposal?: Record<string, unknown> | null };
      const proposal = d.proposal;
      if (proposal) setMessages((ms) => ms.map((m) => (m.memoryProposal as { id?: string } | undefined)?.id === id ? { ...m, memoryProposal: proposal, text: "长期记忆建议已写入。" } : m));
    } catch (e) {
      setMessages((ms) => ms.map((m) => (m.memoryProposal as { id?: string } | undefined)?.id === id ? { ...m, text: `记忆写入失败：${(e as Error).message}` } : m));
    }
  };

  const handleRollbackRun = async (runId: unknown, paths: string[]) => {
    if (!runId || !(await askConfirm("确认回滚本轮产物？这会恢复修改前的文件内容。"))) return;
    try {
      await rollbackRun(runId as string, paths);
      pushSystem("已回滚本轮可恢复的文件变更。");
      onFileChanged?.(paths || []);
    } catch (e) { pushSystem(`回滚失败：${(e as Error).message}`); }
  };

  const handleFiles = async (list: FileList | File[] | null) => {
    const addedImgs: ImageAttachment[] = [];
    const addedAtts: ImageAttachment[] = [];
    const ALLOWED_EXT = /\.(docx|xlsx|pptx|md|markdown|txt|pdf|html|htm|csv|json)$/i;
    for (const f of Array.from(list || []).slice(0, 6)) {
      if (f.type.startsWith("image/")) {
        try {
          const { mediaType, data } = await fileToBase64(f);
          addedImgs.push({ mediaType, data, dataUrl: `data:${mediaType};base64,${data}`, name: f.name });
        } catch {}
      } else if (ALLOWED_EXT.test(f.name)) {
        try {
          const { mediaType, data } = await fileToBase64(f);
          addedAtts.push({ mediaType, data, dataUrl: `data:${mediaType};base64,${data}`, name: f.name });
        } catch {}
      }
    }
    if (addedImgs.length) setImages((im) => [...im, ...addedImgs]);
    if (addedAtts.length) setAttachments((at) => [...at, ...addedAtts]);
    const count = addedImgs.length + addedAtts.length;
    if (count) {
      setModelMsg(`已加入上下文 ${count} 个文件`);
      window.setTimeout(() => setModelMsg(""), 2200);
    }
  };

  const handleClipboardPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.items || [])
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter(Boolean) as File[];
    if (!files.length) return;
    e.preventDefault();
    handleFiles(files);
  };

  const compactContext = async () => {
    if (busy || compacting) return;
    setCompacting(true);
    setModelMsg("正在压缩上下文…");
    try {
      const result = await compactAgentContext(clientId, threadId || "");
      setRunState((state) => ({ ...state, usage: null }));
      const before = result.tokensBefore ? `，压缩前约 ${result.tokensBefore.toLocaleString()} tokens` : "";
      setModelMsg(`压缩完成${before}`);
    } catch (e) {
      setModelMsg(`压缩失败：${(e as Error).message}`);
    } finally {
      setCompacting(false);
      window.setTimeout(() => setModelMsg(""), 2800);
    }
  };

  const handleMemoryReject = async (id: unknown) => {
    const reason = window.prompt("拒绝原因（可选）", "用户拒绝该记忆建议");
    if (reason === null) return;
    try {
      const d = await rejectMemoryProposal(id as string, reason) as { proposal?: Record<string, unknown> | null };
      const proposal = d.proposal;
      if (proposal) setMessages((ms) => ms.map((m) => (m.memoryProposal as { id?: string } | undefined)?.id === id ? { ...m, memoryProposal: proposal, text: "长期记忆建议已拒绝。" } : m));
    } catch (e) {
      setMessages((ms) => ms.map((m) => (m.memoryProposal as { id?: string } | undefined)?.id === id ? { ...m, text: `记忆拒绝失败：${(e as Error).message}` } : m));
    }
  };

  const injectMapContext = () => {
    if (!mapContext?.center) return;
    const center = mapContext.center as number[];
    const bounds = mapContext.bounds as number[] | undefined | null;
    const text = `当前地图视图：中心 ${center[0]},${center[1]}，缩放 ${mapContext.zoom}，可视范围 ${bounds?.join(",") || "未知"}。`;
    setInjectedContext((prev) => [...prev, { text }]);
    pushSystem("已将当前地图视图加入待注入上下文。", `map_context:${mapContext.updatedAt || text}`);
  };

  // 消息列表把这些操作作为稳定回调传入 memo 子项；否则每个 SSE 事件都会
  // 生成一组新函数，抵消长历史消息的 memo 优化。
  const handleMessageAskAnswered = useCallback((messageId: unknown, blockId: unknown, answer: string) => {
    patch(messageId as string | null, (msg) => ({ ...msg, blocks: (msg.blocks || []).map((block) => block.id === blockId ? { ...block, answer } : block) }));
    setBusy(true);
    setAgentPhase("继续执行");
    setRunState((state) => ({ ...state, status: "running" }));
  }, [patch, setAgentPhase]);

  // 提问超时（服务端 5 分钟窗口已过）或回答被服务端拒绝时，把卡片标记为失效：
  // 卡片不再提供输入，输入栏的待处理条也随之收起。
  const markAskExpired = useCallback((messageId: unknown, blockId: unknown) => {
    if (!messageId || !blockId) return;
    patch(messageId as string, (msg) => (msg.blocks || []).some((block) => block.id === blockId && block.expired)
      ? msg
      : { ...msg, blocks: (msg.blocks || []).map((block) => (block.id === blockId ? { ...block, expired: true } : block)) });
  }, [patch]);

  const handleMessageToggleTool = useCallback((messageId: unknown, toolId: unknown) => {
    patch(messageId as string | null, (msg) => {
      const blocks = (msg.blocks || []).map((block, index) => {
        if (block.type === "tool" && (block.id === toolId || (block.id === undefined && index === toolId))) {
          return { ...block, expanded: !block.expanded };
        }
        return block;
      });
      return { ...msg, blocks };
    });
  }, [patch]);

  const resendRef = useRef<((overrideText?: string, options?: SendOptions) => Promise<void>) | null>(null);
  resendRef.current = send;
  const handleMessageResend = useCallback((text: unknown) => { void resendRef.current?.(text as string); }, []);

  // 滚动：用户向上滑动查看历史时暂停自动滚动；在底部才自动滚到最新
  const scrollTimerRef = useRef<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const updateScrollFollowState = () => {
    const el = bodyRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    followLatestRef.current = atBottom;
    setShowScrollToBottom(!atBottom && el.scrollHeight > el.clientHeight + 80);
  };
  const scrollToLatest = () => {
    const el = bodyRef.current;
    if (!el) return;
    followLatestRef.current = true;
    setShowScrollToBottom(false);
    el.scrollTo({ top: el.scrollHeight, behavior: motionScrollBehavior() });
  };
  useEffect(() => {
    if (scrollTimerRef.current) window.clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = window.setTimeout(() => {
      const el = bodyRef.current;
      if (!el || !followLatestRef.current) return;
      // 用用户滚动时记录的跟随意图，而不是在流式内容增高后重新判断距离。
      // 否则回复变长就会让滚动距离超过阈值，后续 token 留在视口外。
      el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
    }, 60);
    return () => { if (scrollTimerRef.current) window.clearTimeout(scrollTimerRef.current); };
  }, [messages]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const maxHeight = 190;
    textarea.style.height = "0px";
    const nextHeight = Math.min(maxHeight, Math.max(70, textarea.scrollHeight));
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [input]);

  // ============================================================================
  // 派生展示值（旧 3361-3473）
  // ============================================================================

  const hint = currentDoc || "未打开文件";
  const emptyExample = EMPTY_EXAMPLES[normalizeUiMode(editMode)] || EMPTY_EXAMPLES.chat!;
  // 目标上下文标签：只显示会随本轮发送的范围信息，且明确“引用≠授权写入”。
  const targetContextFile = contextFileDismissed ? "" : (currentDoc || "");
  const targetReferenceCount = references.length;
  // project 设置视图（旧 3589-3591 的收窄预计算，运行时同值）。
  const projectSettingsView = (project?.settings || null) as { agentProfile?: unknown; skills?: unknown[] } | null;
  const projectType = project?.type as string | undefined;
  const projectAgentProfile = (projectSettingsView?.agentProfile || (project?.agentProfile as string | undefined) || "通用 Agent") as string;
  const projectSkillCount = projectSettingsView?.skills?.length || 0;
  // 待审批卡片：审批是阻塞动作，运行态需要能一键定位到同一张卡片，
  // 不能只在对话流深处静静躺着。
  const pendingApproval = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const blocks = messages[index]?.blocks;
      if (!Array.isArray(blocks)) continue;
      const found = blocks.find((block) => block?.type === "approval" && !block.decision);
      if (found) return found;
    }
    return null;
  }, [messages]);
  // 输入栏常驻入口：折叠过程收起时也要能直接处理待审批/待回答（计划 B01）。
  // 已超时的提问不再进入待处理条：服务端已按假设继续，此时提交必然返回 no pending question。
  const pendingAsk = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const blocks = messages[index]?.blocks;
      if (!Array.isArray(blocks)) continue;
      const found = blocks.find((block) => block?.type === "ask" && !block.answer && !block.expired);
      if (found) return { ...found, messageId: messages[index]?.id } as ChatBlock & { messageId: unknown };
    }
    return null;
  }, [messages]);
  // 提问时间窗口（服务端 ASK_TIMEOUT_MS）：到点把卡片标记为已超时，不再等用户去撞 404。
  useEffect(() => {
    if (!pendingAsk?.expiresAt) return undefined;
    const remain = Number(pendingAsk.expiresAt) - Date.now();
    if (remain <= 0) {
      markAskExpired(pendingAsk.messageId, pendingAsk.id);
      return undefined;
    }
    const timer = setTimeout(() => markAskExpired(pendingAsk.messageId, pendingAsk.id), remain + 50);
    return () => clearTimeout(timer);
  }, [pendingAsk, markAskExpired]);
  const locateApproval = useCallback(() => {
    const container = bodyRef.current;
    if (!container) return;
    const pending = container.querySelector(".approval-block:not(.resolved)");
    if (!pending) return;
    pending.scrollIntoView({ behavior: motionScrollBehavior(), block: "center" });
    requestAnimationFrame(() => (pending.querySelector(".approval-allow") as HTMLElement | null)?.focus?.());
  }, []);
  const locateAsk = useCallback(() => {
    const container = bodyRef.current;
    if (!container) return;
    const pending = container.querySelector(".ask-block:not(.answered)");
    if (!pending) return;
    pending.scrollIntoView({ behavior: motionScrollBehavior(), block: "center" });
    requestAnimationFrame(() => (pending.querySelector(".ask-input") as HTMLElement | null)?.focus?.());
  }, []);
  // 新审批到达时只在用户本来就跟在底部时自动定位，避免把正在回看历史的用户拽走。
  const locatedApprovalRef = useRef("");
  useEffect(() => {
    const id = String(pendingApproval?.id || "");
    if (!id || id === locatedApprovalRef.current) return;
    locatedApprovalRef.current = id;
    if (followLatestRef.current) requestAnimationFrame(() => locateApproval());
  }, [pendingApproval, locateApproval]);
  // 运行态只讲“当前关键步骤 + 下一步”，详细事件留给可展开轨迹。
  const nextStepText = useMemo(() => {
    if (pendingApproval) return `等待你批准「${pendingApproval.tool || "工具"}」，批准后继续`;
    if (runState.status === "waiting_user") return "等待你的回答后继续";
    const nextTodo = todoItems.find((item) => {
      const view = item as { done?: unknown; status?: unknown };
      return !(view.done || ["completed", "skipped"].includes(view.status as string));
    }) as { title?: unknown; name?: unknown } | undefined;
    const label = String(nextTodo?.title || nextTodo?.name || "").trim();
    return label ? `下一步：${label}` : "";
  }, [pendingApproval, runState.status, todoItems]);
  const hasDraft = Boolean(input.trim() || images.length || attachments.length);
  const visibleStart = Math.max(0, messages.length - messageWindowSize);
  const visibleMessages = useMemo<ChatMessage[]>(
    () => associateRunMessages(messages.slice(visibleStart)),
    [messages, visibleStart],
  );
  const hiddenMessageCount = visibleStart;
  const runSummaryById = new Map(visibleMessages
    .filter((message) => message?.role === "system" && message.summary && message.runId)
    .map((message) => [message.runId, message] as [unknown, ChatMessage]));
  const assistantRunIds = new Set(visibleMessages
    .filter((message) => message?.role === "assistant" && message.runId)
    .map((message) => message.runId));
  const runActivityMessagesById = new Map();
  visibleMessages.forEach((message, index) => {
    if (!message?.runId || (message.role !== "assistant" && !message.internalProcess)) return;
    const items = runActivityMessagesById.get(message.runId) || [];
    items.push({ message, index });
    runActivityMessagesById.set(message.runId, items);
  });
  const executionAnchorId = streamingMsgIdRef.current
    || lastAssistantIdRef.current
    || [...visibleMessages].reverse().find((message) => message?.role === "assistant")?.id
    || "";
  // 实时事件属于当前消息流，不做固定在对话上方的第二条状态栏；终态轨迹由 RunSummary 收纳。
  const showExecutionFlow = busy && (executionEvents.length > 0 || runInProgressRef.current);
  // 最近一段"像进度小结"的模型正文：进度行右侧展示"最近小结"，
  // 只在正文出现进度关键词时摘取首行，避免把普通正文误当小结。
  // E03：进度文本只来自结构化事件（待办 / 工具边界 / 阶段），
  // 不再用正则从模型正文里猜“进度句”，避免把结论误当进度、也避免每轮重复叙述。
  const recentNarration = useMemo(() => {
    const active = (Array.isArray(todoItems) ? todoItems : [])
      .find((item) => ["in_progress", "running"].includes(String((item as { status?: unknown } | null | undefined)?.status || ""))) as { title?: unknown } | undefined;
    if (active?.title) return String(active.title).slice(0, 68);
    for (let index = executionEvents.length - 1; index >= 0; index -= 1) {
      const event = executionEvents[index];
      const type = String(event?.type || "");
      if (!type || STAGE_ONLY_EVENTS.has(type) || type === "stats" || type === "token") continue;
      const label = String(flowEventLabel(event) || "").trim();
      if (label) return label.length > 68 ? `${label.slice(0, 68)}…` : label;
    }
    return "";
  }, [executionEvents, todoItems]);

  return (
    <ChatErrorBoundary>
      <div className={`chat${embedded ? " chat-embedded" : ""}${compact ? " chat-compact" : ""}`}>
        {/* 会话历史抽屉（对话栏一侧，可折叠隐藏） */}
        <div className={`chat-hist ${histOpen ? "open" : ""}`}>
          <div className="chat-hist-head" onClick={() => setHistOpen((v) => !v)}>
            <span className="chat-hist-chevron">{histOpen ? "▾" : "▸"}</span>
            <Icon name="history" size={12} />
            <span className="chat-hist-title">{historyLoading ? "切换中…" : "历史"}</span>
            <span className="chat-hist-count">{sessions.length}</span>
            <button
              className="btn-xs chat-hist-refresh"
              onClick={(e) => { e.stopPropagation(); onRefreshSessions(); }}
              title="刷新会话"
            ><Icon name="refresh" size={12} /></button>
          </div>
          {histOpen && (
            <div className="chat-hist-list">
              <SessionList
                sessions={sessions}
                unreadByThread={unreadByThread}
                onSelect={async (s) => {
                  if (!onSelectSession || historyLoading) return;
                  setHistoryLoading(true);
                  try { await onSelectSession(s); setHistOpen(false); }
                  finally { setHistoryLoading(false); }
                }}
                onDelete={async (id) => { try { if (onDeleteSession) await onDeleteSession(id); else await deleteSession(id); onRefreshSessions(); } catch (e) { notifyError("删除失败: " + (e as Error).message); } }}
                onBatchDelete={onBatchDeleteSession || (async (ids) => { await deleteSessions(ids); onRefreshSessions(); })}
                onRename={async (id, label) => { try { await renameSession(id, label); onRefreshSessions(); } catch (e) { notifyError("重命名失败: " + (e as Error).message); } }}
                onFork={onForkSession || (async (id) => { try { await forkSession(id); onRefreshSessions(); } catch (e) { notifyError("创建分支失败: " + (e as Error).message); } })}
                onPin={onPinSession}
                onFreeze={onFreezeSession}
              />
            </div>
          )}
        </div>
        <div className="chat-head">
          <span className="chat-title"><Logo size={16} /> {panelTitle}</span>
          <span className={`chat-mode-badge mode-${editMode}`} title={currentMode.title}>
            <Icon name={currentMode.icon} size={12} /> {currentMode.label}
          </span>
          {onPromoteToAgent && lastPrompt && editMode === "chat" && (
            <button
              className="btn-xs chat-promote-btn"
              onClick={() => onPromoteToAgent(lastPrompt)}
              title="保留本轮问题与引用，转到 Agent 执行"
            >转为 Agent</button>
          )}
          {projectType && <span className="chat-project-badge" title={`项目分类：${projectType}`}>
            {projectType}
          </span>}
          <span className={`conn ${connected ? "on" : ""}`}>{connected ? "已连接" : "连接中..."}</span>
          <span className="doc-hint" title={hint}>{hint}</span>
        </div>
        {/* 阶段 4.2：地图场景常驻显示当前地图状态。
            用户要知道 Agent"看得见"当前地图，才敢说"就画这里"。
            数据来自既有 props（mapProject / mapContext），不新增状态。 */}
        {mapProject && (
          <div className="chat-map-status" title="Agent 会读到当前地图项目与视口范围">
            <Icon name="map" size={12} />
            <span className="cms-project">{mapProject}</span>
            {Boolean(mapContext?.center) && (
              <>
                <span className="cms-sep">·</span>
                <span className="cms-view">
                  {mapContext?.regionName ? `${mapContext.regionName}附近 · ` : ""}缩放 {Math.round(Number(mapContext?.zoom) || 0)}
                </span>
              </>
            )}
            <button
              type="button"
              className="cms-pin"
              onClick={injectMapContext}
              disabled={!mapContext?.center}
              title={mapContext?.center ? "将当前地图视图加入下一轮上下文" : "地图就绪后可固定当前视图"}
            >
              <Icon name="pin" size={12} /> 固定视图
            </button>
          </div>
        )}
        {/* 阶段 4.4：地图可视化是"不落盘"的临时层，Run 的 artifacts 里看不到。
            这里明确告知"临时，未保存"并给出保存入口，避免用户以为结果丢了。 */}
        {mapProject && lastMapVisual && (
          <div className="chat-map-visual" role="status">
            <div className="cmv-row">
              <Icon name="star" size={12} />
              <span className="cmv-text">
                已在地图上显示「{(lastMapVisual.title as string)}」<em>（临时，未保存）</em>
              </span>
              <button
                type="button"
                className="cmv-save"
                title={editMode === "chat" ? "保存正式图层需要切换到 Work 模式" : "保存为正式图层（Agent 会请求确认后写入项目）"}
                onClick={() => {
                  if (editMode === "chat") {
                    // 就地提示（不写 modelMsg——那在工具栏，地图紧凑模式下不显眼）
                    setMapVisualHint("保存正式图层需要切换到 Work 模式（临时可视化不会写入项目）");
                    return;
                  }
                  // Work 模式：把保存意图交给 Agent（走 map_save_analysis 与审批链路）
                  send(`把刚才的地图分析「${lastMapVisual.title}」保存为正式图层。`);
                }}
              >
                <Icon name="download" size={12} /> 保存为图层
              </button>
            </div>
            {mapVisualHint && <div className="cmv-hint" role="alert">{mapVisualHint}</div>}
          </div>
        )}
        {!compact && (editMode === "agent" || editMode === "review") && (
          <details className="agent-capability-preview" title="本轮 Agent 启动前能力预览">
            <summary><span>{editMode === "review" ? "Review" : "Work"}</span><span>能力已就绪 · 点击查看配置</span></summary>
            <div className="agent-capability-details">
              <span>Profile：{projectAgentProfile}</span>
              <span>模型：{model || defaultModel || "按 Pi 配置"}</span>
              <span>Skills：{projectSkillCount ? `${projectSkillCount} 项` : "按任务加载"}</span>
              <span>Office CLI：{editMode === "review" ? "读取材料/副本批注" : "自动判断"}</span>
              <span>写入：{editMode === "review" ? "确认前保护原文" : "受运行环境权限控制"}</span>
            </div>
          </details>
        )}

        <div className="chat-stream-shell">
          <div className="chat-topbar">
            <div className="chat-top-controls" aria-label="会话控制">
              <ContextUsageRing
                usage={usageView}
                contextWindow={selectedContextWindow}
                contextTokens={selectedUsage.context}
                compactThreshold={selectedCompactThreshold}
                compactionMode={selectedCompactionMode}
                compactionReserveTokens={selectedCompactionReserve}
                compactionKeepRecentTokens={selectedCompactionKeepRecent}
                compaction={(runState.compaction || null) as CompactionInfo | null}
                model={selectedModelInfo}
                compacting={compacting}
                busy={busy}
                onCompact={compactContext}
              />
              <ApprovalModeControl mode={approvalMode} saving={approvalModeSaving} onChange={changeApprovalMode} />
            </div>
          </div>
          <div className="chat-body" ref={bodyRef} onScroll={updateScrollFollowState}>
          {messages.length === 0 && (
            <div className={`chat-empty mode-${normalizeUiMode(editMode)}`}>
              <div className="chat-empty-title">{emptyExample.title}</div>
              <ol className="chat-empty-steps">
                {emptyExample.steps.map((step) => <li key={step}>{step}</li>)}
              </ol>
              <div className="chat-empty-examples" aria-label="可执行示例">
                {emptyExample.examples.map((example) => (
                  <button
                    key={example}
                    type="button"
                    className="chat-empty-example"
                    title="点一下填入输入框，可再修改"
                    onClick={() => { updateInput(example); setComposerMenu(null); textareaRef.current?.focus(); }}
                  >
                    {example}
                  </button>
                ))}
              </div>
              <div className="hint">
                {editMode === "chat"
                  ? "Chat 只读：不会修改或生成文件；需要产出时切到 Work。"
                  : editMode === "review"
                    ? "请先打开或 @ 引用要审查的材料，原文默认不改，只生成报告与批注副本。"
                    : "会写入工作区，按审批提示确认；结束时以验收结果为准。"}
                <br />
                @ 引用文件，/ 调用 Skill，# 使用能力，& 引用会话；粘贴图片可辅助说明（需选择支持图片的模型）
              </div>
            </div>
          )}
          {hiddenMessageCount > 0 && (
            <button className="chat-load-older" type="button" onClick={() => setMessageWindowSize((size) => size + MESSAGE_PAGE_SIZE)}>
              加载更早的 {Math.min(MESSAGE_PAGE_SIZE, hiddenMessageCount)} 条消息（前面还有 {hiddenMessageCount} 条）
            </button>
          )}
          {Boolean(historyWindow?.hasMore) && (
            <div className="chat-history-window-note" role="status">
              历史较长，当前先加载最近 {Number(historyWindow?.end) - Number(historyWindow?.start)} 条以保持切换流畅；模型仍使用完整 Pi 会话上下文。
            </div>
          )}
           {(() => { let previousRoundModel = ""; return visibleMessages.map((originalMessage, i) => {
            if (originalMessage?.role === "system" && originalMessage.summary && originalMessage.runId && assistantRunIds.has(originalMessage.runId)) return null;
            let m = originalMessage;
            let firstIndex = i;
            if (m?.runId && (m.role === "assistant" || m.internalProcess)) {
              const runItems = runActivityMessagesById.get(m.runId) || [];
              if (!runItems.length || runItems[0].index !== i) return null;
              firstIndex = runItems[0].index;
              const assistantMessages = runItems.filter(({ message }: { message: ChatMessage }) => message.role === "assistant").map(({ message }: { message: ChatMessage }) => message);
              const runSummaryForGroup = runSummaryById.get(m.runId) || null;
              // 系统轮次/收尾提醒只是 harness 指令：用它们识别 Run 边界，但不暴露原始提示词。
              const blocks = runItems.flatMap(({ message }: { message: ChatMessage }) => message.role === "assistant"
                ? (Array.isArray(message.blocks) ? message.blocks : [])
                : []);
              const groupEvents = (Array.isArray(runSummaryForGroup?.events) ? runSummaryForGroup.events : []) as Array<Record<string, unknown> | null | undefined>;
              const foundFinal = [...groupEvents].reverse().find((event) => event?.type === "assistant_final" && String((event?.data as Record<string, unknown> | null | undefined)?.text || "").trim());
              const eventFinalText = ((foundFinal?.data as Record<string, unknown> | null | undefined)?.text as string | undefined) || "";
              const latestAssistant = assistantMessages[assistantMessages.length - 1] || m;
              const authoritativeFinalText = [...assistantMessages].reverse().find((message) => String(message.authoritativeFinalText || "").trim())?.authoritativeFinalText
                || (runSummaryForGroup?.finalText as string | undefined)
                || eventFinalText;
              m = { ...latestAssistant, runId: originalMessage.runId, blocks, authoritativeFinalText };
            }
            // 兜底：没有 runId/未被分组消费的提醒消息同样不渲染（例如终态后才到达的收尾提醒）。
            if (m?.role === "user" && /^\s*(?:\[系统提醒\]|系统提醒[：:])/.test(String(m.text || ""))) return null;
            const runSummary = m?.role === "assistant" && m.runId ? runSummaryById.get(m.runId) || null : null;
            // 本轮实际使用的模型（服务端 run.model 优先，其次消息自带），用于按轮显示"由谁执行"。
            const roundModel = m?.role === "assistant" ? String(m.model || runSummary?.model || "") : "";
            // 相邻两轮的模型不同 → 中间插一条分割线，明确"从这里开始换了模型"。
            const showModelDivider = Boolean(roundModel) && Boolean(previousRoundModel) && roundModel !== previousRoundModel;
            previousRoundModel = roundModel || previousRoundModel;
            const summaryEvents = (Array.isArray(runSummary?.events) ? runSummary.events : []) as FlowEventItem[];
            const isExecutionAnchor = m.id === executionAnchorId || runActivityMessagesById.get(m.runId)?.some(({ message }: { message: ChatMessage }) => message.id === executionAnchorId);
            const eventsForMessage = isExecutionAnchor && showExecutionFlow ? (executionEvents as unknown as FlowEventItem[]) : summaryEvents;
            const attachExecutionFlow = isExecutionAnchor && showExecutionFlow || summaryEvents.length > 0;
            const executionFlow: React.ComponentProps<typeof MemoMessage>["executionFlow"] = attachExecutionFlow ? {
              events: eventsForMessage,
              running: isExecutionAnchor && showExecutionFlow ? busy : false,
              onFocusTool: focusTool,
              notes: (isExecutionAnchor ? systemNotes : []) as ExecutionNote[],
              note: isExecutionAnchor ? recentNarration : "",
              compaction: (isExecutionAnchor ? runState.compaction || null : null) as CompactionInfo | null,
              hidden: isExecutionAnchor ? flowHidden : false,
              defaultExpanded: isExecutionAnchor && flowDefaultExpanded,
              onHiddenChange: setFlowHidden,
              statusText: frozen ? "会话已冻结" : agentPhase || "任务执行中",
              nextStep: nextStepText,
              pendingApproval: (isExecutionAnchor ? pendingApproval : null) as PendingApprovalInfo | null,
              onLocateApproval: locateApproval,
            } : null;
            return (
              <Fragment key={m.id as string}>
                {showModelDivider && (
                  <div className="model-switch-divider" role="separator" aria-label={`模型切换为 ${roundModel}`}>
                    <span>模型切换为 <b>{modelDisplayName(roundModel)}</b></span>
                  </div>
                )}
                <MemoMessage m={m} index={visibleStart + firstIndex} prevRole={visibleMessages[firstIndex - 1]?.role} model={roundModel || model} clientId={clientId} threadId={threadId} onOpenFile={onOpenFile} onMemoryApprove={handleMemoryApprove} onMemoryReject={handleMemoryReject} onRollbackRun={handleRollbackRun} onOpenRunChanges={onOpenRunChanges} onOpenRunArtifacts={onOpenRunArtifacts} onOpenSubagent={onOpenSubagent} onAskAnswered={handleMessageAskAnswered} onAskExpired={markAskExpired} onResend={handleMessageResend} onToggleTool={handleMessageToggleTool} runSummary={runSummary} executionFlow={executionFlow} />
              </Fragment>
            );
           }); })()}
          </div>
          {showScrollToBottom && (
            <button type="button" className="chat-scroll-latest" onClick={scrollToLatest} title="回到底部" aria-label="回到底部">
              <Icon name="chevronDown" size={14} />
              <span>回到底部</span>
            </button>
          )}
          {/* 会话消息目录栏：收纳在聊天滚动区右侧，靠近滚动条；悬停显示摘要 */}
          {loadSettings().showTimeline !== false && <ChatTimeline messages={visibleMessages} containerRef={bodyRef} />}
        </div>

        {images.length > 0 && !modelVision && (
          <div className="vision-hint">当前模型可能不支持图片，建议切换 [V] 模型</div>
        )}
        {images.length > 0 && (
          <div className="img-preview-row">
            {images.map((img, i) => (
              <div className="img-chip" key={i}>
                <img src={img.dataUrl} alt={img.name} />
                <button onClick={() => setImages((im) => im.filter((_, j) => j !== i))}>x</button>
              </div>
            ))}
          </div>
        )}
        {attachments.length > 0 && (
          <div className="att-preview-row">
            {attachments.map((att, i) => (
              <div className="att-chip" key={i} title={att.name}>
                <Icon name="file" size={14} />
                <span className="att-name">{att.name}</span>
                <button className="att-remove" onClick={() => setAttachments((at) => at.filter((_, j) => j !== i))}>
                  <Icon name="x" size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        {references.length > 0 && (
          <div className="reference-bar" aria-label="本轮引用">
            <span className="reference-bar-label">引用</span>
            {references.map((ref) => (
              <span className="reference-chip" key={ref.id as string} title={ref.target}>
                <span className="reference-chip-kind">{ref.kind === "session" ? "&" : "@"}</span>{ref.target}
                <button type="button" onClick={() => setReferences((prev) => prev.filter((r) => r.id !== ref.id))} aria-label={`移除引用 ${ref.target}`}>×</button>
              </span>
            ))}
          </div>
        )}
        {(queuedMessages.length > 0 || injectedContext.length > 0) && (
          <div className="chat-pending-bar" aria-live="polite">
            {queuedMessages.length > 0 && <span><Icon name="list" size={12} /> 待执行 {queuedMessages.length} 条</span>}
            {injectedContext.length > 0 && <span><Icon name="layers" size={12} /> 待注入上下文 {injectedContext.length} 条</span>}
            {queuedMessages.length > 0 && !busy && <button type="button" onClick={() => flushQueued()} title="继续执行队列">继续队列</button>}
            {queuedMessages.length > 0 && <button type="button" onClick={() => { queueRef.current = []; setQueuedMessages([]); }} title="清空待执行消息">清空</button>}
          </div>
        )}
        {/* 任务卡放在输入框之外：它表达的是"本轮进度"，不是输入内容。
            放在 .chat-input 里面时会被读成"被输入框吞掉的一块"，而且输入框按内容撑高，
            忙时状态会把对话区压到几十像素（实测 720px 窗口只剩 364px、420px 只剩 95px）。 */}
        <div className="chat-compose">
          {todoItems.length > 0 && <TaskProgressCard tasks={todoItems as TaskItem[]} running={busy} />}
          <div className="chat-input">
          {busy && (
            <div className="busy-input-mode" role="group" aria-label="当前任务中的新输入处理方式">
              <span>当前任务中新输入：</span>
              <button type="button" className={busyInputMode === "steer" ? "active" : ""} onClick={() => setBusyInputMode("steer")} title="打断当前回合，立即执行新指令">立即执行</button>
              <button type="button" className={busyInputMode === "queue" ? "active" : ""} onClick={() => setBusyInputMode("queue")}>排队执行</button>
              <button type="button" className={busyInputMode === "context" ? "active" : ""} onClick={() => setBusyInputMode("context")}>注入上下文</button>
              <small>{busyInputMode === "steer" ? "打断当前回合，插入新指令" : busyInputMode === "queue" ? "本轮完成后自动开始" : "保存到下一轮，不打断当前任务"}</small>
            </div>
          )}
          {/* 目标范围：发送前可检查这轮用哪个工作区、带上哪个文件、会不会写盘 */}
          <div className="chat-target-bar" aria-label="本轮目标范围">
            <span className="chat-target-label">本轮目标</span>
            {workspace ? (
              <span className="chat-target-chip scope" title={`会话工作区（跨轮生效，在左侧会话栏切换）：${workspace}`}>
                <Icon name="folder" size={12} /> 工作区 {pathBaseName(workspace)}
              </span>
            ) : (
              <span className="chat-target-chip muted" title="尚未选择工作区，Agent 只能处理引用/上传的材料">未选择工作区</span>
            )}
            {targetContextFile && (
              <span className="chat-target-chip file" title={`本轮会带上当前打开文件：${targetContextFile}`}>
                <Icon name="file" size={12} /> {pathBaseName(targetContextFile)}
                <button
                  type="button"
                  onClick={() => setContextFileDismissed(true)}
                  aria-label={`本轮不再带上当前文件 ${pathBaseName(targetContextFile)}`}
                  title="本轮不带当前文件（不改变已打开的文件）"
                >×</button>
              </span>
            )}
            {targetReferenceCount > 0 && (
              <span className="chat-target-chip ref" title="引用只作为参考上下文，不等于授权写入；写入仍受工作区与审批控制">
                <Icon name="link" size={12} /> 参考文件 {targetReferenceCount}
              </span>
            )}
          </div>
          {connectionNotice && (
            <div className={`conn-status ${connectionNotice.state}`} role="status" aria-live="polite">
              <i /> {(connectionNotice.message || (connectionNotice.state === "retrying" ? "模型正在重试…" : "连接已恢复")) as string}
            </div>
          )}
          <PendingActionBar
            approval={pendingApproval}
            ask={pendingAsk}
            onLocateApproval={locateApproval}
            onLocateAsk={locateAsk}
            clientId={clientId}
            threadId={threadId}
            onAnswered={(blockId, answer) => handleMessageAskAnswered(pendingAsk?.messageId, blockId, answer)}
            onExpired={(blockId) => markAskExpired(pendingAsk?.messageId, blockId)}
          />
          <div className="chat-input-row">
            {composerMenu && composerItems.length > 0 && (
              <div className="composer-suggestions" role="listbox" aria-label="输入建议">
                {composerItems.map((item, index) => (
                  <button
                    key={item.insert}
                    type="button"
                    role="option"
                    aria-selected={index === composerIndex}
                    className={index === composerIndex ? "active" : ""}
                    onMouseDown={(e) => { e.preventDefault(); insertComposerItem(item); }}
                  >
                    <span className="composer-suggestion-main">{item.insert}</span>
                    <span className="composer-suggestion-label">{item.label}</span>
                    <small>{item.hint}</small>
                  </button>
                ))}
              </div>
            )}
            <textarea
              ref={textareaRef}
              value={input}
              disabled={frozen}
              placeholder={frozen ? "会话已冻结，可新建分支继续分析" : busy ? "输入后可排队执行，或仅注入下一轮上下文…" : "输入消息…"}
              onKeyDown={(e) => {
                if (composerMenu && composerItems.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                  e.preventDefault();
                  setComposerIndex((index) => (index + (e.key === "ArrowDown" ? 1 : -1) + composerItems.length) % composerItems.length);
                  return;
                }
                if (composerMenu && composerItems.length && e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  insertComposerItem(composerItems[composerIndex]);
                  return;
                }
                if (composerMenu && e.key === "Escape") {
                  e.preventDefault();
                  setComposerMenu(null);
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
              onCompositionEnd={() => {}}
              onPaste={(e) => {
                handleClipboardPaste(e);
              }}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
              onDrop={(e) => { e.preventDefault(); handleFiles(e.dataTransfer?.files || []); }}
              onChange={(e) => {
                const value = e.target.value;
                updateInput(value);
                setComposerMenu(composerTrigger(value));
              }}
            />
            <div className="input-send">
              {busy ? (
                <>
                  {hasDraft && <button className="btn primary pending-send-btn" onClick={() => send()} title={busyInputMode === "steer" ? "打断当前回合立即执行（Enter）" : busyInputMode === "queue" ? "排队执行（Enter）" : "注入上下文（Enter）"}>
                    <Icon name={busyInputMode === "steer" ? "send" : busyInputMode === "queue" ? "list" : "layers"} size={14} />
                    <span>{busyInputMode === "steer" ? "立即" : busyInputMode === "queue" ? "排队" : "注入"}</span>
                  </button>}
                  <button className="btn danger stop-btn" onClick={stop} disabled={stopping} title={stopping ? "正在中断当前回复" : "中断当前回复"} aria-label={stopping ? "正在中断当前回复" : "中断当前回复"}>
                    <Icon name={stopping ? "loading" : "stop"} size={14} className={stopping ? "icon-loading" : ""} />
                    <span>{stopping ? "中断中" : "中断"}</span>
                  </button>
                </>
              ) : (
                <button className="btn primary send-btn" onClick={() => send()} disabled={frozen} title={frozen ? "会话已冻结" : "发送 (Enter)"}><Icon name="send" size={14} /></button>
              )}
            </div>
          </div>
          {/* 工具栏按“上下文 / Agent 设置 / 会话”分组；Chat / Work 已移到顶栏 */}
          <div className="chat-toolbar">
            <input ref={fileInputRef} type="file" accept="image/*" multiple hidden onChange={(e) => { handleFiles(e.target.files); e.target.value = ""; }} />
            <input ref={attInputRef} type="file" accept=".docx,.xlsx,.pptx,.md,.markdown,.txt,.pdf,.html,.htm,.csv,.json" multiple hidden onChange={(e) => { handleFiles(e.target.files); e.target.value = ""; }} />
            <div className="chat-toolbar-group toolbar-context-group" title="上下文工具">
              <span className="chat-toolbar-label">上下文</span>
              <button className="ct-btn" title="上传图片" onClick={() => fileInputRef.current?.click()}>
                <Icon name="image" size={14} />
              </button>
              <button className="ct-btn" title="上传附件（docx/xlsx/pdf/md/txt 等）" onClick={() => attInputRef.current?.click()}>
                <Icon name="link" size={14} />
              </button>
              {Boolean(mapContext?.center) && <button className="ct-btn" title="将当前地图视图加入下一轮上下文" onClick={injectMapContext}>
                <Icon name="locate" size={14} />
              </button>}
              <button className={`ct-btn ct-context-btn ${compacting ? "active" : ""}`} title={busy ? "当前任务完成后才能压缩上下文" : "压缩当前 Pi 会话上下文，保留任务摘要"} onClick={compactContext} disabled={busy || compacting}>
                <Icon name={compacting ? "loading" : "layers"} size={14} />
                <span>压缩</span>
              </button>
            </div>
            <span className="ct-sep" />
            {/* 模型与思考程度：一个 Proma 式统一入口，底层仍使用 Pi 配置 */}
            <div className="chat-toolbar-group toolbar-agent-group" title="Agent 设置：模型与思考程度">
              <span className="chat-toolbar-label">Agent</span>
              <div className="ct-popwrap model-control-wrap">
                <button
                  ref={modelTriggerRef}
                  className={`model-control-trigger ${modelOpen ? "active" : ""}`}
                  onClick={() => setModelOpen((value) => !value)}
                  aria-haspopup="dialog"
                  aria-expanded={modelOpen}
                  title={model ? `模型：${modelDisplayName(selectedModelInfo)}，思考：${selectedEffort.shortLabel}` : "选择模型与思考程度"}
                >
                  <ModelProviderMark model={selectedModelInfo} size={18} />
                  <span className="model-control-current">
                    <strong>{modelDisplayName(selectedModelInfo)}</strong>
                    <small>{selectedEffort.shortLabel}</small>
                  </span>
                  <Icon name="chevronDown" size={12} />
                </button>
                {modelOpen && createPortal(
                  <div
                    className="ct-pop model-control-pop"
                    ref={modelPopRef}
                    role="dialog"
                    aria-label="选择模型与思考程度"
                    style={modelPopRect ? { position: "fixed", left: modelPopRect.left, ...(modelPopRect.top != null ? { top: modelPopRect.top } : { bottom: modelPopRect.bottom }), width: modelPopRect.width, maxWidth: "calc(100vw - 16px)", maxHeight: modelPopRect.maxHeight, right: "auto", zIndex: 400 } : { visibility: "hidden" }}
                  >
                    <div className="model-control-head">
                      <div><ModelProviderMark model={selectedModelInfo} size={22} /><span><strong>{selectedProviderMeta.label}</strong><small>{model || "按 Pi 配置"}</small></span></div>
                      <span className="model-control-status">{selectedModelInfo?.available === false ? "不可用" : "可用"}</span>
                    </div>
                    <input
                      className="ct-pop-search"
                      placeholder="搜索模型…"
                      value={modelQ}
                      onChange={(e) => setModelQ(e.target.value)}
                      autoFocus
                    />
                    <div className="ct-pop-list model-control-list">
                      <button type="button" className="ct-pop-refresh" onClick={async (e) => { e.stopPropagation(); setModelMsg("扫描中…"); try { const d = await refreshModels() as { ok?: boolean; models?: ChatModel[]; counts?: { available?: number; configured?: number }; error?: string; count?: number }; if (d.ok) { setModels(d.models || []); if (d.counts) setModelCounts(d.counts as { available: number; configured: number }); setModelMsg(`可用 ${d.counts?.available ?? d.count ?? 0} / 配置 ${d.counts?.configured ?? "?"}`); } else setModelMsg("扫描失败: " + (d.error || "")); } catch (err) { setModelMsg("扫描失败: " + (err as Error).message); } setTimeout(() => setModelMsg(""), 2500); }} title="重新扫描 Pi 模型目录与可用模型">
                        <Icon name="refresh" size={12} /> 重新扫描模型 <small>可用 {modelCounts.available || "—"}</small>
                      </button>
                      {modelSections.map((section) => (
                        <div className="model-pinned-section" key={section.key}>
                          <div className="model-provider-heading"><span>{section.title}</span><small>{section.items.length}</small></div>
                          {section.items.map((m) => (
                            <ModelOptionRow
                              key={`${section.key}:${m.id}`}
                              model={m}
                              current={m.id === model}
                              favorite={favoriteModels.includes(m.id as string)}
                              onPick={(id) => { changeModel(id as string); setModelOpen(false); }}
                              onToggleFavorite={toggleFavoriteModel}
                            />
                          ))}
                        </div>
                      ))}
                      {!modelQ.trim() && (
                        <>
                          <button
                            type="button"
                            className="ct-pop-refresh model-all-toggle"
                            onClick={() => setAllModelsOpen((value) => !value)}
                            aria-expanded={allModelsOpen}
                            title="展开全部模型列表（按供应商分组）"
                          >
                            <Icon name={allModelsOpen ? "chevronDown" : "chevronRight"} size={12} /> 全部模型（{models.length}）
                            <small>可用 {modelCounts.available || "—"}</small>
                          </button>
                          {allModelsOpen && (
                            <>
                              {modelGroups.map(([provider, providerModels]) => (
                                <div className="model-provider-group" key={provider}>
                                  <div className="model-provider-heading"><span><ModelProviderMark model={providerModels[0]} size={15} /> {modelProviderMeta(providerModels[0]).label}</span><small>{providerModels.length}</small></div>
                                  {providerModels.map((m) => (
                                    <ModelOptionRow
                                      key={`all:${m.id}`}
                                      model={m}
                                      current={m.id === model}
                                      favorite={favoriteModels.includes(m.id as string)}
                                      onPick={(id) => { changeModel(id as string); setModelOpen(false); }}
                                      onToggleFavorite={toggleFavoriteModel}
                                    />
                                  ))}
                                </div>
                              ))}
                            </>
                          )}
                        </>
                      )}
                      {modelQ.trim() && !modelGroups.length && <div className="ct-pop-empty">没有匹配的模型</div>}
                    </div>
                    <div className="model-thinking-control">
                      <div className="model-thinking-head"><span><Icon name="info" size={12} /> 思考深度</span><strong>{selectedEffort.label}</strong></div>
                      <input
                        type="range"
                        min="0"
                        max={THINKING_OPTIONS.length - 1}
                        step="1"
                        value={selectedEffortIndex}
                        aria-label="思考深度"
                        aria-valuetext={`${selectedEffort.label}（${selectedEffort.desc}）`}
                        onChange={(e) => { const next = THINKING_OPTIONS[Number(e.target.value)] || THINKING_OPTIONS[0]!; setEffort(next.id); localStorage.setItem(THINKING_KEY, next.id); }}
                      />
<div className="model-thinking-scale">{THINKING_OPTIONS.map((item) => <span key={item.id} className={item.id === effort ? "active" : ""}>{item.label}</span>)}</div>
                      <small className="model-thinking-desc">{selectedEffort.desc}</small>
                      <small className="model-thinking-hint">高/最大档位会让模型首响应明显变慢，适合复杂任务；简单问答建议用低/标准</small>
                    </div>
                  </div>,
                  document.body,
                )}
              </div>
            </div>
            <span className="chat-toolbar-spacer" />
            <div className="chat-toolbar-group toolbar-session-group">
              <button className="ct-btn" onClick={handleNewSession} title="新建会话">
                <Icon name="chatPlus" size={14} />
              </button>
            </div>
            {modelMsg && <span className={`model-msg${pendingModel ? " pending" : ""}`} title={pendingModel ? `已排队：本轮结束后切换为 ${pendingModel}` : undefined}>{modelMsg}</span>}
          </div>
          </div>
        </div>
      </div>
    </ChatErrorBoundary>
  );
});

export default ChatPanel;

