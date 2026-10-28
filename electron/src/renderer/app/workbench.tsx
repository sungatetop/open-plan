import React, { useCallback, useEffect, useRef, useState } from "react";
import SessionSidebar, { type FileRecord, type ProjectRecord, type WorkspaceRecord } from "../components/SessionSidebar";
import type { ModelRecord } from "../components/SettingsPanel";
import Resizer from "../components/Resizer";
import Icon from "../components/Icon";
import Logo from "../components/Logo";
import FeedbackHost, { notifyError } from "../components/Feedback";
import DocViewer, { type DocRecord } from "../components/DocViewer";
import ChatPanel, { type ChatPanelImperativeHandle } from "../features/chat/panel";
import MapPanel, { type MapBridgeHandlers } from "../features/map/map-panel";
import TaskCenter from "../features/tasks/task-center";
import WorkProductPanel from "../features/tasks/work-product-panel";
import type { SessionRecord } from "../components/SessionList";
import {
  normalizeHistoryMessages,
  type ChatMessage,
  type ChatModel
} from "../lib/chat-shared";
import { isMotionReduced, useAppearance } from "../lib/ui-appearance";
import { loadUIState, saveUIState } from "../lib/persist-ui";
import { initRuntimeFlags, flag, flagsReady } from "../lib/feature-flags";
import { createGlobalEventFeed, createIpcGlobalEventTransport, type GlobalEventFeedRefs } from "../features/chat/global-events-feed";
import "../../../../client/src/styles.css";
import {
  listFiles,
  listModels,
  listSessions,
  listProjects,
  listRuns,
  listWorkspaces,
  switchWorkspace,
  deleteSession,
  deleteSessions,
  renameSession,
  getSession,
  getClientId,
  createAgentThread,
  resumeAgentThread,
  markAgentEventsRead,
  forkSession,
  pinSession,
  freezeSession,
  cancelRun,
  openDoc,
  makeFileIdentity,
  mergeFileIdentity,
  identityMatches,
  fileIdentityKey
} from "../api/client-api";
import {
  sameWorkspacePath,
  fileBasename,
  reconstructSessionMessages,
  runSummariesToMessages,
  findSessionFileMatch,
  type PersistedHistoryEntry,
  type RunSummaryLike,
  type HistoryWindowInfo
} from "../features/chat/history-load";
import { useTheme } from "./theme";

/**
 * 工作台主组件（F3 批7b：App.jsx chat 集成面逐行转录）。
 *
 * 覆盖旧 App.jsx 的 chat 域职责：sessions/workspaces/projects/models/files
 * 数据流 + 会话恢复/切换/新建 + 历史消息加载 + 全局事件订阅（unreadByThread），
 * 挂载 SessionSidebar + ChatPanel。
 *
 * 迁移期偏差（后续域收口后接线，均已在调用点批注）：
 *   - open()/文档标签/预览画布 → F4-3 已激活（op:doc:open + DocViewer 模块视图）；
 *   - onBrowserActivity/浏览器侧栏/工作区画布 → F4+；
 *   - CommandPalette（Ctrl+K）/SettingsPanel/TaskCenter 挂载 → F5/F4；
 *   - MapPanel/mapContexts/mapBridge → F5-7 已激活（地图模块 + 共享 ChatPanel 桥接）；activeModule 模块面板 → 随各域收口补挂。
 */

// 启动加载分区文案：失败提示与重试按钮按分区说明，避免只报一句笼统错误。
const LOAD_SCOPE_LABELS: Record<string, string> = { files: "文件列表", sessions: "会话列表", projects: "项目列表", workspaces: "工作区列表" };

function RefreshBloom(): React.ReactElement | null {
  const [visible, setVisible] = useState(() => !isMotionReduced());
  const [opened, setOpened] = useState(false);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (!visible) return undefined;
    const frame = window.requestAnimationFrame(() => setOpened(true));
    const closeTimer = window.setTimeout(() => setClosing(true), 850);
    const removeTimer = window.setTimeout(() => setVisible(false), 1200);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(closeTimer);
      window.clearTimeout(removeTimer);
    };
  }, [visible]);

  if (!visible) return null;
  return (
    <div className={`app-refresh-bloom ${opened ? "is-open" : ""} ${closing ? "is-closing" : ""}`} aria-hidden="true">
      <Logo size={56} withBackground={false} markColor="currentColor" className="app-refresh-bloom-mark" />
    </div>
  );
}

// 全局错误边界
class AppErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean; error: Error | null }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): { hasError: boolean; error: Error } {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error("App error:", error, errorInfo);
  }

  override render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <div className="app-error">
          <div className="app-error-content">
            <div className="app-error-icon">⚠</div>
            <div className="app-error-title">应用出错</div>
            <div className="app-error-text">{this.state.error?.message || "未知错误"}</div>
            <button className="btn primary" onClick={() => window.location.reload()}>
              刷新页面
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function Workbench(): React.ReactElement {
  // ============================================================================
  // refs（先于回调声明，避免 use-before-declare）
  // ============================================================================
  const currentWorkspaceRef = useRef(""); // 与 currentWorkspace 同步：文件请求必须带上它，避免用旧闭包值
  const currentDirRef = useRef(""); // 与 currentDir 同步，供无参 refreshFiles 使用
  const filesRef = useRef<FileRecord[]>([]); // 与 files 同步：工作区切换失败时用它恢复原列表
  const sessionsRef = useRef<SessionRecord[]>([]);
  const sessionsRefreshRef = useRef<Promise<SessionRecord[] | null> | null>(null);
  const projectsRefreshRef = useRef<Promise<ProjectRecord[] | null> | null>(null);
  const eventRefreshTimerRef = useRef<number | null>(null);
  const eventBatchTimerRef = useRef<number | null>(null);
  const eventBatchRef = useRef({ updates: 0, artifacts: 0 });
  const sessionHistoryCacheRef = useRef(new Map<string, ChatMessage[]>());
  const sessionHistoryMetaRef = useRef(new Map<string, HistoryWindowInfo | null>());
  const chatInputRef = useRef<ChatPanelImperativeHandle | null>(null); // 引用 ChatPanel 输入框（@ 按钮插入）
  const sessionLoadSeqRef = useRef(0);
  const workspaceSwitchSeqRef = useRef(0);
  // 统一导航代际（交互 8）：项目/工作区/会话/新建共享一条失效边界；
  // 任一导航都会推进它，异步返回后若不匹配就丢弃，避免逆序响应互相覆盖。
  const navGenerationRef = useRef(0);
  const newSessionInFlightRef = useRef(false);
  const filesRequestSeqRef = useRef(0);
  const currentThreadRef = useRef<string | null>(null);
  let initialCursor = 0;
  try {
    initialCursor = Number(localStorage.getItem("oaw_event_cursor") || 0);
  } catch {
    /* localStorage 不可用时从 0 起步 */
  }
  const eventCursorRef = useRef(initialCursor);
  const eventNoticeKeysRef = useRef(new Set<string>());
  const autoOpenedRunRef = useRef(new Set<string>());
  const changedFilesTimerRef = useRef<number | null>(null);
  const pendingChatInsertRef = useRef<string[]>([]);
  const browserAutoOpenBlockedRef = useRef(false); // 浏览器侧栏自动展开阻断（F4 消费，feed 负责重置）
  const restoredRunProbedRef = useRef(false);
  const restoredSessionRef = useRef(false); // 会话恢复只执行一次
  // 上次会话 id 缓存：刷新后会话恢复前，保存逻辑不覆盖 lastSessionId（避免恢复竞态）
  const lastSessionIdRef = useRef<string | null>(null);
  const resumeWaitStartRef = useRef(0);

  // ============================================================================
  // 状态区（App.jsx 162-360 chat 集成面子集，逐条对应）
  // ============================================================================
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [unreadByThread, setUnreadByThread] = useState<Record<string, number>>({});
  // eventVersion/artifactVersion：F4-1 起 eventVersion 值由 TaskCenter 消费（列表与
  // 明细随全局事件即时刷新）；F4-2 起 artifactVersion 值由 WorkProductPanel 消费
  // （产物/改动面板的 refreshToken，bump 源不变：createGlobalEventFeed + run_finished）。
  const [eventVersion, setEventVersion] = useState(0);
  const [artifactVersion, setArtifactVersion] = useState(0);
  // 右栏「改动/产物」的 runId 与范围（App.jsx:180-181）：chat 结果卡交付入口带 runId 打开。
  const [changesRunId, setChangesRunId] = useState("");
  const [artifactScope, setArtifactScope] = useState("session");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activeModule, setActiveModule] = useState<string | null>(null); // 模块面板挂载随 F4/F5/F6 补齐，状态先行保留
  // F4-3 doc 域·预览画布（App.jsx tabs/activeTab/docLoading 逐行转录；旧形态落在
  // 预览画布右栏，新 UI 以 activeModule="doc" 模块视图承接）：
  const [docTabs, setDocTabs] = useState<DocRecord[]>([]);
  const [docActiveTab, setDocActiveTab] = useState<string | null>(null);
  const [docLoading, setDocLoading] = useState(false);
  const docRequestSeqRef = useRef(0); // 打开请求代际：切文件/切工作区后旧响应一律丢弃
  const previewTabManualAtRef = useRef(0); // O-P2：用户最近一次手动切换右栏页签的时间（页签栏随 F4-4）
  // 运行开关快照到达后的重渲染触发器（值本身不参与渲染，只用来让 flag() 派生的状态重算）。
  const [, setFlagsTick] = useState(0);
  const [conversationMode, setConversationMode] = useState("chat");
  const [conversationPhase, setConversationPhase] = useState("");
  // F5-7 地图模块（App.jsx 177/238/335 转录）：地图模式保留 Agent 对话（共享 ChatPanel，
  // 消息与事件流连续）；按线程记忆地图项目与视口上下文；bridgeRef 把 ChatPanel 的
  // onMapAction/onFileChanged/onAgentEnd 回调转发给挂载中的 MapPanel。
  const [mapContexts, setMapContexts] = useState<Record<string, { mapProject?: string } & Record<string, unknown>>>({});
  const [mapChatVisible, setMapChatVisible] = useState(true); // 地图模式对话栏可独立隐藏
  const mapBridgeRef = useRef<MapBridgeHandlers | null>(null);
  const [clientId] = useState(getClientId);
  const [threadId, setThreadId] = useState<string>(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem("oaw_thread_id");
    } catch {
      /* localStorage 不可用时新建 */
    }
    if (saved) return saved;
    const id = `thread-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
    try {
      localStorage.setItem("oaw_thread_id", id);
    } catch {
      /* 静默降级 */
    }
    return id;
  });
  const [models, setModels] = useState<Array<Record<string, unknown>>>([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [selectedModel, setSelectedModel] = useState(() => {
    try {
      return localStorage.getItem("oaw_model") || "";
    } catch {
      return "";
    }
  });
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [currentWorkspace, setCurrentWorkspace] = useState("");
  // 启动加载状态：files/sessions/projects/workspaces 各自记录 ready/error，
  // 失败时保留上一次可用数据并给出可重试的提示，而不是静默伪装成空结果。
  const [loadStatus, setLoadStatus] = useState<Record<string, string>>({ files: "loading", sessions: "loading", projects: "loading", workspaces: "loading" });
  const [loadErrors, setLoadErrors] = useState<Record<string, string>>({});
  const currentProject = projects.find((project) => sameWorkspacePath(project.rootPath, currentWorkspace)) || null;
  const [currentDir, setCurrentDir] = useState(""); // 相对路径子目录
  const [changedFiles, setChangedFiles] = useState(() => new Set<string>()); // 本轮刚被改动的文件名（短时高亮文件树）
  const [historyMessages, setHistoryMessages] = useState<ChatMessage[] | null>(null); // 加载的历史会话消息
  const [historyThreadId, setHistoryThreadId] = useState<string | null>(null); // 当前历史消息对应的 thread
  // OAW_REPLAY_RECOVER（F2，默认关）：冷启动探测到保存的 thread 仍有执行中的 Run 时，
  // 提示用户可加载该会话完整历史（不改动「刷新不自动恢复会话」的已批准规则，仅补运行中例外入口）。
  const [restoredRunHint, setRestoredRunHint] = useState<{ threadId: string } | null>(null);
  const [historyWindow, setHistoryWindow] = useState<HistoryWindowInfo | null>(null); // 服务端为长会话返回的展示窗口信息
  const [sessionResumeError, setSessionResumeError] = useState<{ sessionId: string; message: string; code?: string; detail?: unknown } | null>(null); // Agent 恢复失败时历史只读
  // 新建会话的进行中/失败状态（交互 2）：失败必须可见，且不得清空旧会话。
  const [creatingSession, setCreatingSession] = useState(false);
  const [newSessionError, setNewSessionError] = useState<{ message: string; workspace: string } | null>(null);
  // 工作区切换失败（交互 8）：保留原状态并提示原因，不再静默 refreshFiles。
  const [workspaceSwitchError, setWorkspaceSwitchError] = useState<{ message: string; workspace: string } | null>(null);
  const [sessionResumeRetrying, setSessionResumeRetrying] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null); // 当前会话 id
  const currentSession = sessions.find((session) => session.id === currentSessionId) || null;

  const { theme, toggleTheme } = useTheme();

  // ============================================================================
  // 全局功能开关 / 布局 / 输入插入
  // ============================================================================

  // 反馈基座/运行开关：挂载即拉取 /api/status 的 runtimeFlags 快照；拉取失败保持全关（= 基线行为）。
  useEffect(() => {
    void initRuntimeFlags().then(() => {
      const root = document.documentElement;
      // Qoder P0-4（开关 qoderStyle，默认关）：仅在开关打开时给 <html> 打标。
      if (flag("qoderStyle")) root.setAttribute("data-oaw-style", "qoder");
      else root.removeAttribute("data-oaw-style");
      // P2-4（开关 visualEffectsOff，默认关）：特效降级标记。
      if (flag("visualEffectsOff")) root.setAttribute("data-visual-effects", "off");
      else root.removeAttribute("data-visual-effects");
      setFlagsTick((value) => value + 1);
    });
  }, []);

  // 窄屏防挤压（P1，批7b 精简形态）：≤768px 时侧栏为覆盖层，自动收起避免整屏遮挡对话。
  // （预览/浏览器让位逻辑随 F4 画布域补齐。）
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const enforceNarrowLayout = (): void => {
      if (window.innerWidth <= 768) setSidebarOpen(false);
    };
    enforceNarrowLayout();
    window.addEventListener("resize", enforceNarrowLayout);
    return () => window.removeEventListener("resize", enforceNarrowLayout);
  }, []);

  // 外部模块打开时主 ChatPanel 会卸载；先暂存 @ 引用，待回到对话后再写入，
  // 避免“点击调用但输入框没有任何内容”的竞态。
  const insertChatText = useCallback((value: unknown): void => {
    const text = String(value || "").trim();
    if (!text) return;
    if (chatInputRef.current?.insertText) {
      chatInputRef.current.insertText(text);
      return;
    }
    pendingChatInsertRef.current.push(text);
  }, []);

  useEffect(() => {
    if (activeModule || !pendingChatInsertRef.current.length) return undefined;
    const timer = window.setTimeout(() => {
      const pending = pendingChatInsertRef.current.splice(0);
      if (!chatInputRef.current?.insertText) {
        pendingChatInsertRef.current.unshift(...pending);
        return;
      }
      pending.forEach((text) => chatInputRef.current?.insertText(text));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeModule]);

  // @ 按钮：把文件/文件夹路径插入到对话输入框
  const handleAtMention = useCallback((rel: string, isDir?: boolean) => {
    const marker = isDir ? rel + "/" : rel;
    insertChatText(`@${marker}`);
  }, [insertChatText]);

  useEffect(() => {
    currentThreadRef.current = threadId;
  }, [threadId]);

  // 设置面板的“刷新模型”走一次供应商网络刷新（SettingsPanel 挂载随 F5 补齐；
  // 启动、定时轮询和切回标签页只读已缓存目录）。
  const syncModelCatalog = useCallback(async () => {
    const data = await listModels();
    setModels((data.models || []) as Array<Record<string, unknown>>);
    setDefaultModel(String(data.default || ""));
    return data;
  }, []);

  // ============================================================================
  // 新建会话（App.jsx 430-488 逐行转录）
  // ============================================================================

  const handleNewSession = useCallback(async (workspaceArg?: unknown) => {
    const requested = typeof workspaceArg === "string" ? workspaceArg.trim() : "";
    const targetWorkspace = requested || currentWorkspaceRef.current || currentWorkspace;
    if (newSessionInFlightRef.current) return null;
    newSessionInFlightRef.current = true;
    // 导航代际（交互 8）：与工作区切换、选择历史共享同一条失效边界，
    // await 返回后若用户已经做了别的导航，这次结果必须丢弃。
    const generation = ++navGenerationRef.current;
    setCreatingSession(true);
    setNewSessionError(null);
    const next = `thread-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
    let created: Record<string, unknown> | null = null;
    try {
      // 先让后端创建并固定 session/workspace，再切换前端 thread，避免事件流先创建一个错误 cwd 的空 Agent。
      const project = projects.find((item) => sameWorkspacePath(item.rootPath, targetWorkspace));
      const response = await createAgentThread(clientId, next, targetWorkspace || "", { projectId: project?.id || null });
      created = response as Record<string, unknown>;
    } catch (e) {
      newSessionInFlightRef.current = false;
      setCreatingSession(false);
      if (generation === navGenerationRef.current) {
        // 保留旧会话、标签与未发送输入，只提示失败原因并提供重试。
        setNewSessionError({ message: (e as Error)?.message || "创建新会话失败", workspace: targetWorkspace || "" });
      }
      return null;
    }
    if (generation !== navGenerationRef.current) {
      newSessionInFlightRef.current = false;
      setCreatingSession(false);
      return null;
    }
    // 新会话已经由当前 Chat 状态立即接管；历史列表刷新延后，避免工作区切换
    // 立刻触发一次全量 JSONL 扫描，阻塞刚完成的界面切换。
    window.setTimeout(() => { void refreshSessions(); }, 600);
    setThreadId(next);
    try {
      localStorage.setItem("oaw_thread_id", next);
    } catch {
      /* 静默降级 */
    }
    setHistoryMessages(null);
    setHistoryThreadId(null);
    setHistoryWindow(null);
    setSessionResumeError(null);
    // 交互 5：目录归根必须与列表同一次导航——清掉旧子目录项并读根列表，
    // 否则根目录下仍显示旧子目录内容，点开会按新的根路径解释。
    currentDirRef.current = "";
    setCurrentDir("");
    setFiles([]);
    void refreshFiles("");
    const createdSessionId = String((created as { sessionId?: unknown } | null)?.sessionId || "");
    setCurrentSessionId(createdSessionId || null);
    lastSessionIdRef.current = createdSessionId || null;
    newSessionInFlightRef.current = false;
    setCreatingSession(false);
    return created;
    // 不把 refreshFiles / refreshSessions 列入依赖：两者都是依赖稳定的 useCallback，闭包捕获始终有效。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, currentWorkspace, projects]);

  // ============================================================================
  // 启动加载族（App.jsx 490-561 / 656-738 逐行转录）
  // ============================================================================

  const setScopeStatus = useCallback((scope: string, status: string) => {
    setLoadStatus((prev) => (prev[scope] === status ? prev : { ...prev, [scope]: status }));
  }, []);

  const setScopeError = useCallback((scope: string, error: unknown) => {
    const message = error ? ((error as Error).message || "网络请求失败") : "";
    setLoadErrors((prev) => {
      if (!message) return prev[scope] ? { ...prev, [scope]: "" } : prev;
      return prev[scope] === message ? prev : { ...prev, [scope]: message };
    });
  }, []);

  const refreshFiles = useCallback(async (dir?: string) => {
    const requestedDir = typeof dir === "string" ? dir : currentDirRef.current;
    // 工作区身份必须显式传给服务端并在响应里核对：只传 dir 时，服务端会用
    // 自己的全局工作区解析相对路径，页面显示 A、列表来自 B（交接文档交互 1）。
    const requestedWorkspace = currentWorkspaceRef.current;
    const requestSeq = ++filesRequestSeqRef.current;
    setScopeStatus("files", "loading");
    try {
      const result = await listFiles(requestedDir, requestedWorkspace);
      // 目录已切换、工作区已切换或本次请求不是最新时，过期响应不得覆盖列表
      const stale = requestSeq !== filesRequestSeqRef.current
        || requestedDir !== currentDirRef.current
        || !sameWorkspacePath(requestedWorkspace, currentWorkspaceRef.current);
      if (stale) return;
      // 服务端回显的来源与页面不一致：判定为身份错位，阻止把它当当前目录展示。
      if (result.workspace && requestedWorkspace && !sameWorkspacePath(result.workspace, requestedWorkspace)) {
        setScopeStatus("files", "error");
        setScopeError("files", new Error(`文件列表来源与当前工作区不一致（${result.workspace}）`));
        return;
      }
      setFiles((result.files || []) as unknown as FileRecord[]);
      setScopeStatus("files", "ready");
      setScopeError("files", null);
    } catch (error) {
      if (requestSeq === filesRequestSeqRef.current) {
        setScopeStatus("files", "error");
        setScopeError("files", error);
      }
    }
  }, [setScopeError, setScopeStatus]);

  // 同步工作区 ref：文件请求由回调发起，若只依赖闭包里的 currentWorkspace，
  // 工作区刚切换时仍可能用旧值（交互 8 的失效边界之一）。
  useEffect(() => { currentWorkspaceRef.current = currentWorkspace; }, [currentWorkspace]);
  useEffect(() => { filesRef.current = files; }, [files]);

  const refreshSessions = useCallback(async (): Promise<SessionRecord[] | null> => {
    if (sessionsRefreshRef.current) return sessionsRefreshRef.current;
    setScopeStatus("sessions", "loading");
    const request = listSessions()
      .then((data) => {
        const next = (data.sessions || []) as unknown as SessionRecord[];
        setSessions(next);
        setScopeStatus("sessions", "ready");
        setScopeError("sessions", null);
        return next;
      })
      .catch((error) => {
        // 保留上一次可用会话列表，不用空数组冒充“没有会话”。
        setScopeStatus("sessions", "error");
        setScopeError("sessions", error);
        return null;
      });
    sessionsRefreshRef.current = request;
    try { return await request; }
    finally {
      if (sessionsRefreshRef.current === request) sessionsRefreshRef.current = null;
    }
  }, [setScopeError, setScopeStatus]);

  // 根级事件订阅：当前对话继续使用对话流事件桥，App 额外监听所有 thread 的重要状态，
  // 让切换后的后台任务仍能刷新历史和未读提示（App.jsx 563-654 → createGlobalEventFeed）。
  const feedRefs: GlobalEventFeedRefs = {
    currentThreadRef,
    eventCursorRef,
    eventNoticeKeysRef,
    browserAutoOpenBlockedRef,
    eventBatchTimerRef,
    eventBatchRef,
    eventRefreshTimerRef
  };
  useEffect(() => {
    return createGlobalEventFeed({
      clientId,
      refs: feedRefs,
      setEventVersion,
      setArtifactVersion,
      setUnreadByThread,
      refreshSessions,
      transport: createIpcGlobalEventTransport()
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, refreshSessions]);

  const refreshProjects = useCallback(async (): Promise<ProjectRecord[] | null> => {
    if (projectsRefreshRef.current) return projectsRefreshRef.current;
    setScopeStatus("projects", "loading");
    const request = listProjects()
      .then((data) => {
        const next = (data.projects || []) as unknown as ProjectRecord[];
        setProjects(next);
        setScopeStatus("projects", "ready");
        setScopeError("projects", null);
        return next;
      })
      .catch((error) => {
        // 保留上一次可用项目列表，不把失败表现成“没有项目”。
        setScopeStatus("projects", "error");
        setScopeError("projects", error);
        return null;
      });
    projectsRefreshRef.current = request;
    try { return await request; }
    finally {
      if (projectsRefreshRef.current === request) projectsRefreshRef.current = null;
    }
  }, [setScopeError, setScopeStatus]);

  const refreshWorkspaces = useCallback(async (): Promise<WorkspaceRecord[] | null> => {
    setScopeStatus("workspaces", "loading");
    try {
      const data = await listWorkspaces();
      const list = (data.workspaces || []) as unknown as WorkspaceRecord[];
      setWorkspaces(list);
      setScopeStatus("workspaces", "ready");
      setScopeError("workspaces", null);
      const savedWorkspace = loadUIState()?.workspace as string | undefined;
      const restored = list.find((item) => sameWorkspacePath(item.path, savedWorkspace));
      if (restored) setCurrentWorkspace(restored.path);
      else if (list[0]) setCurrentWorkspace(list[0].path);
      return list;
    } catch (error) {
      // 保留上一次可用工作区，避免界面卡在“等待工作区列表就绪”。
      setScopeStatus("workspaces", "error");
      setScopeError("workspaces", error);
      return null;
    }
  }, [setScopeError, setScopeStatus]);

  const retryStartupLoads = useCallback(() => {
    const failed = Object.keys(loadErrors).filter((scope) => loadErrors[scope]);
    if (!failed.length || failed.includes("files")) void refreshFiles();
    if (!failed.length || failed.includes("sessions")) void refreshSessions();
    if (!failed.length || failed.includes("projects")) void refreshProjects();
    if (!failed.length || failed.includes("workspaces")) void refreshWorkspaces();
  }, [loadErrors, refreshFiles, refreshSessions, refreshProjects, refreshWorkspaces]);

  useEffect(() => {
    void refreshFiles();
    void refreshSessions();
    void refreshProjects();
    let modelTimer: number;
    const sessionTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshSessions();
    }, 15000);
    const projectTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshProjects();
    }, 30000);
    const syncModels = async (): Promise<void> => {
      try {
        await syncModelCatalog();
      } catch {
        // 扫描失败时保留上一次列表，避免模型下拉框瞬间清空。
      }
    };
    void syncModels();
    modelTimer = window.setInterval(() => { void syncModels(); }, 60_000);
    const onVisibility = (): void => { if (document.visibilityState === "visible") void syncModels(); };
    document.addEventListener("visibilitychange", onVisibility);
    void refreshWorkspaces();
    return () => {
      window.clearInterval(modelTimer);
      window.clearInterval(sessionTimer);
      window.clearInterval(projectTimer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refreshFiles, refreshSessions, refreshProjects, refreshWorkspaces, syncModelCatalog]);

  // ============================================================================
  // 工作区切换（App.jsx 753-822 逐行转录）
  // ============================================================================

  const handleWorkspaceChange = useCallback(async (dir: string) => {
    const requestedPath = String(dir || "").trim();
    if (!requestedPath || sameWorkspacePath(requestedPath, currentWorkspace)) return;
    const switchSeq = ++workspaceSwitchSeqRef.current;
    // 工作区切换同样推进统一导航代际：在途的新建/历史加载结果不得再写入。
    navGenerationRef.current += 1;
    // 记下失败时要恢复的原状态：切换未成功前不应让用户丢掉当前目录。
    const previousDir = currentDirRef.current;
    const previousFiles = filesRef.current;
    // 先清空旧工作区的视图，避免等待服务端时继续操作旧文件。
    currentDirRef.current = "";
    setCurrentDir("");
    setFiles([]);
    // 切工作区时中止在途打开请求并清空标签（App.jsx 766-770），旧工作区的预览结果不得写入。
    docRequestSeqRef.current += 1;
    setDocTabs([]);
    setDocActiveTab(null);
    setHistoryMessages(null);
    setHistoryWindow(null);
    setCurrentSessionId(null);
    try {
      const r = await switchWorkspace(requestedPath);
      if (switchSeq !== workspaceSwitchSeqRef.current) return;
      // 先同步 ref 再触发任何文件请求：refreshFiles 与 handleNewSession 都从
      // currentWorkspaceRef 取身份，晚一拍就会把新工作区的请求发到旧路径上。
      const nextWorkspace = r.workspace || requestedPath;
      currentWorkspaceRef.current = nextWorkspace;
      setCurrentWorkspace(nextWorkspace);
      // 新工作区加入下拉列表（自定义路径切换后也能在下拉中看到）
      setWorkspaces((prev) => {
        if (prev.some((w) => w.path === nextWorkspace)) return prev;
        const name = String(nextWorkspace).split(/[\\/]/).filter(Boolean).pop() || nextWorkspace;
        return [...prev, { path: nextWorkspace, name }];
      });
      setFiles((r.files || []) as unknown as FileRecord[]);
      // 工作区切换后异步刷新项目：让新打开的本地目录立即出现在项目栏，且不阻塞文件视图。
      void refreshProjects();
      void handleNewSession(nextWorkspace);
    } catch (e) {
      if (switchSeq === workspaceSwitchSeqRef.current) {
        // 切换失败保留原有效状态：恢复原目录与文件列表，只提示失败原因。
        currentDirRef.current = previousDir;
        setCurrentDir(previousDir);
        setFiles(previousFiles);
        setWorkspaceSwitchError({ message: (e as Error)?.message || "切换工作区失败", workspace: requestedPath });
      }
    }
  }, [currentWorkspace, handleNewSession, refreshProjects]);

  const visibleSessions = currentWorkspace
    ? sessions.filter((session) => !session.cwd || sameWorkspacePath(session.cwd, currentWorkspace))
    : sessions;
  // 启动加载失败提示：按分区列出，提供统一重试；失败期间保留上一次可用数据。
  const loadFailures = Object.entries(loadErrors).filter(([, message]) => Boolean(message));
  const loadFailureText = loadFailures.length
    ? `${loadFailures.map(([scope]) => LOAD_SCOPE_LABELS[scope] || scope).join("、")}读取失败，已保留上一次可用数据`
    : "";
  const loadRetrying = loadFailures.some(([scope]) => loadStatus[scope] === "loading");
  const handleProjectChange = useCallback((id: string) => {
    const project = projects.find((item) => item.id === id);
    if (project?.rootPath) void handleWorkspaceChange(project.rootPath);
  }, [projects, handleWorkspaceChange]);

  // 进入/返回子目录
  const handleDirChange = useCallback((dir: string) => {
    const nextDir = String(dir || "");
    currentDirRef.current = nextDir;
    setCurrentDir(nextDir);
    void refreshFiles(nextDir);
  }, [refreshFiles]);

  // F4-3 doc 域·预览画布激活（App.jsx 824-887 open() 逐行转录；IPC 形态经 op:doc:open）。
  const openDocFile = useCallback(async (name: string, thread?: string, cwd?: string): Promise<string | null> => {
    const requestSeq = ++docRequestSeqRef.current;
    // IPC 无在途可中止请求：以代际丢弃旧响应（可能来自另一个工作区的同名文件）。
    setDocLoading(true);
    // 容错：调用方可能只传了工作区（例如产物跨工作区打开），thread 缺失时回退到当前会话
    const effectiveThread = thread || threadId;
    const effectiveCwd = cwd || currentWorkspace;
    // 打开前先构造本地身份（workspaceId + relativePath），后续所有预览请求都用它。
    const localIdentity = makeFileIdentity({ workspaceId: effectiveCwd, cwd: effectiveCwd, relativePath: name });
    try {
      const doc = await openDoc(name, { cwd: effectiveCwd || undefined, client: clientId, thread: effectiveThread || "" });
      if (requestSeq !== docRequestSeqRef.current) return null;
      // 服务端返回的文件身份（含真实 version/hash）优先；前端核对一致后才使用，不一致则标记 failed。
      const identity = mergeFileIdentity(localIdentity, doc?.identity);
      const identityVerified = doc?.identity ? identityMatches(localIdentity, doc.identity) : true;
      const id = fileIdentityKey(identity);
      const nextDoc: DocRecord = {
        ...doc,
        name,
        identity,
        id,
        previewRevision: identity.revision,
        identityVerified,
      };
      // 文件从“本轮产物”或 Agent 自动产出打开时，直接切到文档预览，
      // 避免用户还停留在产物列表而误以为文件没有打开。
      setActiveModule("doc");
      // 单次 setTabs：按「工作区 + 相对路径」去重，不同工作区的同名文件是不同标签。
      setDocTabs((prev) => {
        const exists = prev.find((t) => (t.id || t.name) === id);
        if (exists) return prev.map((t) => ((t.id || t.name) === id ? { ...t, ...nextDoc } : t));
        return [...prev, nextDoc];
      });
      setDocActiveTab(id);
      setDocLoading(false);
      return id;
    } catch (e) {
      const message = String((e as Error)?.message || "");
      // 文件被移动/删除，或文件列表还是切换工作区之前的旧数据时，不弹生硬的 "not found"，
      // 而是刷新列表并提示重新选择。
      if (/not found|enoent|http 404/i.test(message)) {
        try { await refreshFiles?.(); } catch {}
        notifyError(`文件不存在或已被移动：${name}\n已刷新文件列表，请重新选择。`);
      } else {
        notifyError("打开失败: " + message);
      }
      if (requestSeq === docRequestSeqRef.current) setDocLoading(false);
      return null;
    }
  }, [clientId, threadId, currentWorkspace, refreshFiles]);

  // O-P2：用户主动打开/切换预览时记录时间戳，autoTab 10s 内不抢用户主动权（L1025 消费）。
  const markPreviewManual = useCallback(() => { previewTabManualAtRef.current = Date.now(); }, []);

  // 点击文档 tab 切换（App.jsx 1944 onSwitchTab 直传；页签切换视为用户主动操作，O-P2 记时戳）。
  const switchDocTab = useCallback((tabId: string) => {
    markPreviewManual();
    setDocActiveTab(tabId);
  }, [markPreviewManual]);

  // 关闭文档 tab（App.jsx 909-926 closeTab 逐行转录；IPC 形态以代际递增替代 abort）。
  const closeDocTab = useCallback((tabId: string) => {
    setDocTabs((prev) => {
      const idx = prev.findIndex((t) => (t.id || t.name) === tabId);
      if (idx === -1) return prev;
      const next = prev.filter((t) => (t.id || t.name) !== tabId);
      if (docActiveTab === tabId) {
        // 激活相邻 tab
        const neighbor = next[Math.min(idx, next.length - 1)];
        setDocActiveTab(neighbor ? (neighbor.id || neighbor.name) : null);
      }
      return next;
    });
    if (docActiveTab === tabId) {
      docRequestSeqRef.current += 1;
    }
  }, [docActiveTab]);

  // ============================================================================
  // 会话选择（App.jsx 929-1122 逐行转录，历史重建走 history-load 共享层）
  // ============================================================================

  const handleSelectSession = useCallback(async (session: SessionRecord) => {
    // 会话切换：重置右栏"改动/产物"的 runId 与范围，
    // 避免上一个会话的"本轮产物"污染到当前会话（用户反馈的跨会话污染）。
    setChangesRunId("");
    setArtifactScope("session");
    const loadSeq = ++sessionLoadSeqRef.current;
    // 选择历史同样推进统一导航代际：在途的新建/工作区切换不得覆盖本次结果。
    navGenerationRef.current += 1;
    // 会话自带工作区归属；先切换文件视图，再切换 thread，避免历史会话在另一个项目目录下恢复。
    const targetWorkspace = session.cwd || currentWorkspace;
    let resumedWorkspace = targetWorkspace;
    if (targetWorkspace && !sameWorkspacePath(targetWorkspace, currentWorkspace)) {
      try {
        const switched = await switchWorkspace(targetWorkspace);
        if (loadSeq !== sessionLoadSeqRef.current) return;
        resumedWorkspace = switched.workspace || "";
        setCurrentWorkspace(switched.workspace || "");
        currentDirRef.current = "";
        setCurrentDir("");
        setFiles((switched.files || []) as unknown as FileRecord[]);
        // 切换工作区后中止在途打开并清空标签（App.jsx 949-952）。
        docRequestSeqRef.current += 1;
        setDocTabs([]);
        setDocActiveTab(null);
      } catch (e) {
        console.warn("切换到会话工作区失败，仍尝试加载历史:", (e as Error).message);
      }
    }
    const conversationId = session.threadId || session.id;
    const cachedHistory = sessionHistoryCacheRef.current.get(session.id);
    if (cachedHistory) {
      setHistoryThreadId(conversationId);
      setHistoryMessages(cachedHistory);
      setHistoryWindow(sessionHistoryMetaRef.current.get(session.id) || null);
    } else {
      setHistoryThreadId(null);
      setHistoryMessages(null);
      setHistoryWindow(null);
    }
    // 恢复 Agent 与读取历史互不依赖；并行执行可明显缩短点击历史后的空白等待。
    // 但在 resume 完成前不切换 thread，避免事件流先创建一个新的空会话并与恢复竞态。
    const historyPromise = Promise.all([
      getSession(session.id, { view: "chat", limit: 360 }),
      listRuns("", 50, { sessionId: session.id }).catch(() => ({ runs: [] })),
    ]);
    const resumePromise = resumeAgentThread(clientId, conversationId, session.id, resumedWorkspace || "")
      .then(() => ({ ok: true as const }))
      .catch((e) => { console.warn("恢复 Agent 会话失败，历史按只读展示:", (e as Error).message); return { ok: false as const, error: (e as Error).message || "恢复失败" }; });
    setUnreadByThread((prev) => {
      if (!prev[conversationId]) return prev;
      const next = { ...prev };
      delete next[conversationId];
      return next;
    });
    markAgentEventsRead(clientId, eventCursorRef.current).catch(() => {});
    try {
      const [[d, runData], resumeResult] = await Promise.all([historyPromise, resumePromise]);
      if (loadSeq !== sessionLoadSeqRef.current) return;
      // 恢复失败时仍展示历史，但明确标注为只读并提供重试，避免用户误以为可以继续对话。
      setSessionResumeError(resumeResult?.ok ? null : { sessionId: session.id, message: resumeResult?.error || "Agent 会话恢复失败" });
      setCurrentSessionId(session.id);
      setThreadId(conversationId);
      try {
        localStorage.setItem("oaw_thread_id", conversationId);
      } catch {
        /* 静默降级 */
      }
      // 按原始 JSONL 顺序重建消息（toolResult 回填工具卡 / Run 总结按时间插回），
      // 与旧 handleSelectSession 内联循环逐行等价，抽至 history-load 共享层供对拍。
      const msgs = reconstructSessionMessages(d.entries as unknown as PersistedHistoryEntry[]);
      const runMessages = runSummariesToMessages(((runData as { runs?: unknown })?.runs || []) as unknown as RunSummaryLike[]);
      const loadedHistory = normalizeHistoryMessages([...msgs, ...runMessages].sort((a, b) => {
        const left = Date.parse(String(a.createdAt || "")) || 0;
        const right = Date.parse(String(b.createdAt || "")) || 0;
        return left - right;
      }));
      sessionHistoryCacheRef.current.set(session.id, loadedHistory);
      const info = d.info;
      sessionHistoryMetaRef.current.set(session.id, info?.historyHasMore ? {
        total: Number(info.historyTotal || 0),
        start: Number(info.historyStart || 0),
        end: Number(info.historyEnd || 0),
        hasMore: true,
      } : null);
      // 只保留最近几条缓存，避免长会话历史常驻内存；再次点击时仍可先显示缓存。
      while (sessionHistoryCacheRef.current.size > 8) {
        const first = sessionHistoryCacheRef.current.keys().next().value;
        if (first === undefined) break;
        sessionHistoryCacheRef.current.delete(first);
      }
      setHistoryMessages(loadedHistory);
      setHistoryWindow(sessionHistoryMetaRef.current.get(session.id) || null);
      setHistoryThreadId(conversationId);
      // 从消息里解析会话关联的文件，尝试打开（历史文本先显示，关联文档后台打开，
      // 不阻塞会话切换；文档预览随 F4-3 激活（openDocFile）。
      const fileMatch = findSessionFileMatch(msgs);
      if (fileMatch) {
        markPreviewManual(); // 用户主动选择会话触发的文件打开
        void openDocFile(fileMatch.trim(), conversationId, resumedWorkspace || undefined);
      }
    } catch (e) {
      if (loadSeq === sessionLoadSeqRef.current) notifyError("加载会话失败: " + (e as Error).message);
    }
  }, [clientId, currentWorkspace, markPreviewManual, openDocFile]);

  // 重试恢复当前历史会话的 Agent：成功后才允许继续对话。
  const retrySessionResume = useCallback(async (silentFlag?: unknown) => {
    const silent = silentFlag === true; // onClick 会把事件对象当首参传入，仅显式 true 才算静默
    const targetId = sessionResumeError?.sessionId || currentSessionId;
    if (!targetId) return;
    const conversationId = threadId || targetId;
    if (!silent) setSessionResumeRetrying(true);
    try {
      await resumeAgentThread(clientId, conversationId, targetId, currentWorkspace || "");
      setSessionResumeError(null);
    } catch (error) {
      setSessionResumeError({
        sessionId: targetId,
        message: (error as Error).message || "Agent 会话恢复失败",
        code: (error as { code?: string }).code || "",
        detail: (error as { detail?: unknown }).detail ?? null,
      });
    }
    if (!silent) setSessionResumeRetrying(false);
  }, [clientId, currentSessionId, currentWorkspace, sessionResumeError, threadId]);

  // A2（OAW_RESUME_AUTO_RETRY，默认关）：恢复遇忙（SESSION_BUSY）时自动等待任务结束后重试，
  // 上限 10 分钟；等待时长在横幅展示，并提供"取消当前任务"直达入口。
  const [resumeWaitSec, setResumeWaitSec] = useState(0);
  useEffect(() => {
    const busy = flag("resumeAutoRetry") && sessionResumeError?.code === "SESSION_BUSY";
    if (!busy) {
      resumeWaitStartRef.current = 0;
      setResumeWaitSec(0);
      return undefined;
    }
    if (!resumeWaitStartRef.current) resumeWaitStartRef.current = Date.now();
    const timer = window.setInterval(() => {
      const elapsed = Math.floor((Date.now() - resumeWaitStartRef.current) / 1000);
      setResumeWaitSec(elapsed);
      if (elapsed > 600) { window.clearInterval(timer); return; }
      void retrySessionResume(true);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [sessionResumeError?.code, sessionResumeError?.sessionId, retrySessionResume]);

  // ============================================================================
  // 会话族 handlers（App.jsx 1166-1256 逐行转录）
  // ============================================================================

  const handleForkSession = useCallback(async (id: string, label?: string) => {
    const source = sessions.find((item) => item.id === id);
    const result = await forkSession(id, label, {
      purpose: "从历史会话创建独立分析分支",
      sourceMessageId: null,
    });
    await refreshSessions();
    await handleSelectSession({
      id: result.id,
      threadId: result.threadId || result.id,
      cwd: result.cwd || source?.cwd || currentWorkspace,
      projectId: result.projectId || source?.projectId || currentProject?.id || null,
      parentSessionId: result.parentSessionId || id,
      label: result.label || label || "会话分支",
      title: result.label || label || "会话分支",
      pinned: false,
      frozen: false,
    });
    return result;
  }, [currentProject?.id, currentWorkspace, handleSelectSession, refreshSessions, sessions]);

  const handlePinSession = useCallback(async (id: string, pinned: boolean) => {
    await pinSession(id, pinned);
    await refreshSessions();
  }, [refreshSessions]);

  const handleDeleteSession = useCallback(async (id: string) => {
    await deleteSession(id);
    sessionHistoryCacheRef.current.delete(id);
    sessionHistoryMetaRef.current.delete(id);
    if (currentSessionId === id) {
      setHistoryMessages(null);
      setHistoryWindow(null);
      setCurrentSessionId(null);
    }
    await refreshSessions();
  }, [currentSessionId, refreshSessions]);

  const handleBatchDeleteSessions = useCallback(async (ids: string[]) => {
    const result = await deleteSessions(ids);
    for (const id of ids || []) {
      sessionHistoryCacheRef.current.delete(id);
      sessionHistoryMetaRef.current.delete(id);
    }
    if (currentSessionId && result.deleted?.includes(currentSessionId)) {
      setHistoryMessages(null);
      setHistoryWindow(null);
      setCurrentSessionId(null);
    }
    await refreshSessions();
    if (result.skipped?.length) {
      const names = result.skipped.map((item) => item.reason).filter(Boolean);
      if (names.length) window.setTimeout(() => notifyError(`部分会话未删除：${names.join("、")}`), 0);
    }
    return result;
  }, [currentSessionId, refreshSessions]);

  const handleRenameSession = useCallback(async (id: string, label: string) => {
    await renameSession(id, label);
    await refreshSessions();
  }, [refreshSessions]);

  const handleFreezeSession = useCallback(async (id: string, frozen: boolean) => {
    await freezeSession(id, frozen);
    await refreshSessions();
  }, [refreshSessions]);

  const handleOpenRun = useCallback((run: Record<string, unknown> | null | undefined) => {
    const id = String(run?.sessionId || run?.threadId || "");
    if (!id) return;
    return handleSelectSession({
      id,
      threadId: String(run?.threadId || id),
      cwd: String(run?.cwd || currentWorkspace),
      projectId: (run?.projectId as string | null) || currentProject?.id || null,
      title: String((run?.task as Record<string, unknown> | undefined)?.goal || "任务对应会话"),
      label: String((run?.task as Record<string, unknown> | undefined)?.goal || "任务对应会话"),
    });
  }, [currentProject?.id, currentWorkspace, handleSelectSession]);

  const handleFileChanged = useCallback((changed: unknown) => {
    // 旧实现含激活标签自动重开（doc 域 F4）；批7b 保留文件刷新。
    void changed;
    void refreshFiles();
  }, [refreshFiles]);

  // 暴露 refreshSessions 给 ChatPanel（agent_end 时刷新）
  const handleAgentEnd = useCallback(() => {
    // 添加延迟让文件变更事件先处理
    setTimeout(() => {
      void refreshSessions();
    }, 200);
  }, [refreshSessions]);

  // B03：结果卡的交付入口 → 对应模块面板（带 runId，保证"本轮"语义；App.jsx 1271-1284）。
  // 旧形态落在预览画布右栏页签；新 UI 预览画布随 F4-3（DocViewer）补挂，本批先以
  // activeModule 模块视图承接，RunChangesPanel/ArtifactPanel 的 props 语义不变。
  const openChangesForRun = useCallback((runId: unknown = "") => {
    setChangesRunId(String(runId || ""));
    setActiveModule("changes");
  }, []);
  const openArtifactsForRun = useCallback((runId: unknown = "") => {
    setChangesRunId(String(runId || ""));
    setArtifactScope(runId ? "run" : "session");
    setActiveModule("artifacts");
  }, []);

  // ============================================================================
  // run_finished 消费（App.jsx 1287-1329 逐行转录，预览打开随 F4 裁剪）
  // ============================================================================

  // 一轮任务以 run_finished 为权威结束点：刷新产物计数，并做文件树短时高亮。
  // 用 runId 去重，避免事件重连回放导致重复刷新（B02 自动打开预览随 F4 接线）。
  const appearance = useAppearance();
  const previewAutoOpenRef = useRef(appearance.previewAutoOpen);
  previewAutoOpenRef.current = appearance.previewAutoOpen;

  const handleRunFinished = useCallback((result: Record<string, unknown> = {}) => {
    const runId = String(result.runId || "");
    if (runId && autoOpenedRunRef.current.has(runId)) return;
    if (runId) {
      autoOpenedRunRef.current.add(runId);
      if (autoOpenedRunRef.current.size > 80) {
        const first = autoOpenedRunRef.current.values().next().value;
        if (first) autoOpenedRunRef.current.delete(first);
      }
    }
    setArtifactVersion((value) => value + 1);
    const artifacts = (Array.isArray(result.artifacts) ? result.artifacts : [])
      .map((item) => typeof item === "string" ? { path: item } : (item ?? {}) as Record<string, unknown>)
      .filter((item) => item?.path && item.status !== "deleted");
    // 文件树的短时高亮：本轮确实改了文件就打标（部分失败也算），
    // 由上面的 runId 去重保证重连回放不重播；2.6s 后自动清除，不常驻。
    if (artifacts.length) {
      const changed = new Set(artifacts.map((item) => fileBasename(item.path)).filter(Boolean));
      setChangedFiles(changed);
      if (changedFilesTimerRef.current) window.clearTimeout(changedFilesTimerRef.current);
      changedFilesTimerRef.current = window.setTimeout(() => setChangedFiles(new Set()), 2600);
    }
    const status = String(result.status || "completed").toLowerCase();
    if (!["completed", "success"].includes(status)) return;
    // O-P2（OAW_AUTO_TAB，默认关）：本轮产生文件产物时直达「产物」页签；
    // 用户 10s 内手动切换过页签/打开过预览视为锁定，不抢用户主动权
    // （手动时间戳由 markPreviewManual 在各用户入口记录，自动路径不记）。
    if (flag("autoTab") && artifacts.length && Date.now() - previewTabManualAtRef.current > 10000) {
      openArtifactsForRun(runId);
      return;
    }
    const firstArtifact = artifacts[0];
    if (!firstArtifact) return;
    // B02 自动打开预览：never 从不；deliverable 仅通过验收的交付文件；requested 本轮有产物就打开
    if (previewAutoOpenRef.current === "never") return;
    if (previewAutoOpenRef.current === "deliverable") {
      const acceptanceStatus = String(firstArtifact.acceptanceStatus || (firstArtifact.acceptance as Record<string, unknown> | undefined)?.status || "");
      if (!["passed", "warning", "manual_review"].includes(acceptanceStatus)) return;
    }
    void openDocFile(String(firstArtifact.path), result.threadId ? String(result.threadId) : threadId, result.cwd ? String(result.cwd) : currentWorkspace);
  }, [currentWorkspace, openDocFile, threadId]);

  useEffect(() => () => { if (changedFilesTimerRef.current) window.clearTimeout(changedFilesTimerRef.current); }, []);

  // ============================================================================
  // 会话上报与界面状态固化（App.jsx 1363-1455 逐行转录）
  // ============================================================================

  // ChatPanel 上报 pi 会话 id → 持久化（刷新后恢复当前对话）
  const handleSessionChange = useCallback((id: string) => {
    if (id) setCurrentSessionId(id);
  }, []);

  // ===== 界面状态固化（localStorage）=====
  const [uiRestored, setUiRestored] = useState(false); // 恢复是否完成（完成后才允许保存）
  useEffect(() => {
    let savedLast: unknown = null;
    try {
      savedLast = loadUIState()?.lastSessionId ?? null;
    } catch {
      /* 静默降级 */
    }
    lastSessionIdRef.current = (savedLast as string | null) || null;
  }, []);

  // 恢复：只恢复工作区与必要的视图偏好。
  // 已批准规则（交接文档交互 4）：刷新/服务重启后停留在工作区根目录的空白新会话，
  // 不自动恢复旧子目录、旧会话或旧文件；历史会话与旧文件只走手动入口。
  useEffect(() => {
    if (uiRestored) return;
    if (!currentWorkspace) return; // 等待工作区列表就绪
    const saved = loadUIState();
    if (!saved) { setUiRestored(true); return; }
    void (async () => {
      try {
        if (saved.workspace && !sameWorkspacePath(saved.workspace as string, currentWorkspace)) {
          const switched = await switchWorkspace(String(saved.workspace));
          setCurrentWorkspace(switched.workspace || "");
          setFiles((switched.files || []) as unknown as FileRecord[]);
        }
      } catch {}
      // 目录一律回到工作区根：上一次的子目录不再恢复（曾被保存值带回旧列表）。
      currentDirRef.current = "";
      setCurrentDir("");
      void refreshFiles("");
      setActiveModule(null);
      setSidebarOpen(saved.sidebarOpen !== false);
      // 清掉会触发旧行为的持久化字段，避免遗留值继续自动恢复。
      saveUIState({ ...saved, currentDir: "", lastSessionId: null });
      setUiRestored(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentWorkspace]);

  // 已批准规则：刷新不再自动恢复上次会话。会话 id 与 thread 只在用户手动
  // 选择历史时使用；这里保留 ref 同步，但不再触发 handleSelectSession。
  useEffect(() => {
    sessionsRef.current = sessions;
    restoredSessionRef.current = true;
    lastSessionIdRef.current = null;
  }, [sessions]);

  // OAW_REPLAY_RECOVER（F2，默认关）：冷启动探测保存的 thread 是否仍有执行中的 Run。
  // 只提示 + 提供加载完整历史的入口，不自动恢复，符合已批准规则的语义边界。
  useEffect(() => {
    if (!uiRestored || !sessions.length) return undefined;
    let cancelled = false;
    const probe = async (): Promise<void> => {
      if (cancelled || restoredRunProbedRef.current || !flag("replayRecover")) return;
      restoredRunProbedRef.current = true;
      let savedThreadId = "";
      try {
        savedThreadId = localStorage.getItem("oaw_thread_id") || "";
      } catch {
        /* 静默降级 */
      }
      if (!savedThreadId) return;
      try {
        const result = await listRuns(savedThreadId, 5, { cwd: currentWorkspace || undefined });
        if (cancelled) return;
        const live = (((result as { runs?: Array<Record<string, unknown>> })?.runs || []) as Array<Record<string, unknown>>)
          .find((item) => ["running", "queued", "waiting_user", "recovering", "cancel_requested", "finishing"].includes(String(item?.status)));
        if (live) setRestoredRunHint({ threadId: savedThreadId });
      } catch {}
    };
    void probe();
    // 开关快照异步到达（初始全关）：就绪后再探测一次
    let off = false;
    void flagsReady.then(() => { if (!off && !cancelled) void probe(); });
    return () => { cancelled = true; off = true; };
  }, [uiRestored, sessions.length, currentWorkspace]);

  // 用户已通过任意入口加载该会话历史后，提示自动消失
  useEffect(() => {
    if (restoredRunHint && historyThreadId === restoredRunHint.threadId) setRestoredRunHint(null);
  }, [historyThreadId, restoredRunHint]);

  // 保存：界面状态变化时写入 localStorage。
  // 只持久化工作区、目录与侧栏开关；不再写入 lastSessionId —— 刷新后必须进入
  // 空白新会话，旧会话只从历史列表手动打开（交接文档交互 4）。
  useEffect(() => {
    if (!uiRestored) return;
    saveUIState({
      // 不再持久化打开的标签与激活标签：刷新后回到主对话页，不自动恢复上次预览内容
      activeModule,
      workspace: currentWorkspace,
      currentDir,
      sidebarOpen,
    });
  }, [activeModule, currentWorkspace, currentDir, sidebarOpen, uiRestored]);

  // ============================================================================
  // 渲染（App.jsx 1511-1514 / 1616-1833 chat 集成面子集）
  // ============================================================================

  // SESSION_BUSY 恢复等待横幅的 detail 预取（旧 JSX 内联取值，TS 需显式收窄）
  const busyDetail = (sessionResumeError?.detail ?? null) as Record<string, unknown> | null;
  const busyForMs = Number(busyDetail?.busyForMs ?? 0);
  const busyActiveRunId = String(busyDetail?.activeRunId || "");
  // F5-7 地图模块（App.jsx 239-240 转录）：当前线程的地图视口上下文与项目名。
  const currentMapContext = mapContexts[threadId] || null;
  const currentMapProject = String(currentMapContext?.mapProject || "zhejiang-map");

  return (
    <AppErrorBoundary>
      <div className={`app ${sidebarOpen ? "sidebar-expanded" : "sidebar-collapsed"}`}>
        <RefreshBloom />
        <FeedbackHost />
        {loadFailureText && (
          <div
            className="load-recovery"
            role="alert"
            title={loadFailures.map(([scope, message]) => `${LOAD_SCOPE_LABELS[scope] || scope}：${message}`).join("\n")}
          >
            <Icon name="warning" size={14} />
            <span>{loadFailureText}</span>
            <button className="btn-xs" onClick={retryStartupLoads} disabled={loadRetrying}>{loadRetrying ? "重试中…" : "重试"}</button>
          </div>
        )}
        {/* F4-2：改动/产物模块视图（App.jsx 2041-2051 逐行转录）。旧形态的 chat 结果卡
            交付入口开在预览画布右栏页签（openChangesForRun/openArtifactsForRun），新 UI
            预览画布随 F4-3（DocViewer）补挂，先以模块视图承接——产物视图补充
            selectedRunId/artifactScope/onArtifactScopeChange 以承载「本轮」范围语义。
            fullPage 任务中心模块随 F5/F6 模块导航再挂。 */}
        {activeModule === "artifacts" && (
          <div className="module-view">
            <div className="module-head">
              <button className="module-back" onClick={() => setActiveModule(null)} title="返回对话"><Icon name="back" size={15} /></button>
              <div className="module-brand-heading"><Logo size={22} /><span><h2>成果</h2><p>查看、验收、固定和回滚工作产物</p></span></div>
            </div>
            <div className="module-body module-artifacts-body">
              <WorkProductPanel tab="artifacts" clientId={clientId} threadId={threadId} workspace={currentWorkspace} projectId={currentProject?.id || ""} currentSessionId={currentSessionId || ""} selectedRunId={changesRunId} artifactScope={artifactScope} onArtifactScopeChange={setArtifactScope} refreshToken={artifactVersion} onOpenFile={(name: string, thread?: string, cwd?: string) => { markPreviewManual(); setActiveModule(null); void openDocFile(name, thread, cwd); }} />
            </div>
          </div>
        )}
        {activeModule === "changes" && (
          <div className="module-view">
            <div className="module-head">
              <button className="module-back" onClick={() => setActiveModule(null)} title="返回对话"><Icon name="back" size={15} /></button>
              <div className="module-brand-heading"><Logo size={22} /><span><h2>改动</h2><p>按 Run 归属查看本轮文件改动与内容差异</p></span></div>
            </div>
            <div className="module-body module-artifacts-body">
              <WorkProductPanel tab="changes" clientId={clientId} threadId={threadId} workspace={currentWorkspace} projectId={currentProject?.id || ""} currentSessionId={currentSessionId || ""} selectedRunId={changesRunId} refreshToken={artifactVersion} onOpenFile={(name: string, thread?: string, cwd?: string) => { markPreviewManual(); setActiveModule(null); void openDocFile(name, thread, cwd); }} />
            </div>
          </div>
        )}
        {/* F4-3：doc 域·预览画布（App.jsx 预览画布 document 页签 → 新 UI 模块视图）。
            openDocFile 打开成功即 setActiveModule("doc")，产物面板/文件树/历史会话三入口共用。 */}
        {activeModule === "doc" && (
          <div className="module-view module-doc-view">
            <div className="module-head">
              <button className="module-back" onClick={() => setActiveModule(null)} title="返回对话"><Icon name="back" size={15} /></button>
              <div className="module-brand-heading"><Logo size={22} /><span><h2>文档</h2><p>预览工作区文档与产物，支持多标签打开</p></span></div>
            </div>
            <div className="module-body module-doc-body">
              <DocViewer
                tabs={docTabs}
                activeTab={docActiveTab || ""}
                onSwitchTab={switchDocTab}
                onCloseTab={closeDocTab}
                loading={docLoading}
                onSendToAgent={insertChatText}
                onInsertContext={(text: string) => {
                  // 标注「发给 Agent」：优先写入 ChatPanel 输入框的选区上下文；
                  // 输入框句柄不可用时降级为纯文本插入（保底不丢内容）。
                  if (chatInputRef.current?.insertContext) {
                    chatInputRef.current.insertContext(text);
                    return;
                  }
                  insertChatText(`[选区上下文]\n${text}\n[/选区上下文]`);
                }}
              />
            </div>
          </div>
        )}
        {/* F5-7 地图模块（App.jsx 1565-1615 逐点转录）：MapPanel 全屏（hideChat 分支，
            不内嵌 ChatPanel），共享 ChatPanel 常驻 .app-chat-slot.map，右缘 Resizer 调宽。
            桥接语义与旧版一致：onFileChanged/onAgentEnd 双路（工作台状态 + mapBridge），
            onMapAction/onOpenFile 纯桥接；onViewportChange 整体替换线程上下文（旧语义）。 */}
        {activeModule === "map" && (
          <MapPanel
            onExit={() => setActiveModule(null)}
            onOpenFile={(...args: unknown[]) => { markPreviewManual(); void openDocFile(String(args[0] ?? "")); }}
            clientId={clientId}
            threadId={threadId}
            workspace={currentWorkspace}
            models={models as unknown as ChatModel[]}
            defaultModel={defaultModel}
            onAgentEnd={handleAgentEnd}
            onNewSession={() => void handleNewSession()}
            historyMessages={historyMessages}
            sessions={visibleSessions}
            currentSessionId={currentSessionId}
            onSelectSession={handleSelectSession}
            onSessionChange={handleSessionChange}
            onRefreshSessions={() => void refreshSessions()}
            onFocusRun={() => { chatInputRef.current?.focusRun?.(); }}
            onProjectChange={(name) => setMapContexts((prev) => ({ ...prev, [threadId]: { ...(prev[threadId] || {}), mapProject: name } }))}
            conversationMode={conversationMode}
            onModeChange={(next) => {
              // 与主对话的模式切换同源：先让 ChatPanel 真正切模式，成功后再更新状态，
              // 避免"按钮变了但 Agent 还是旧模式"（App.jsx 1586-1591 原样转录）。
              const switched = chatInputRef.current?.setMode?.(next);
              if (switched !== false) setConversationMode(next);
            }}
            hideChat
            chatVisible={mapChatVisible}
            onToggleChat={() => setMapChatVisible((value) => !value)}
            bridgeRef={mapBridgeRef}
            onViewportChange={(context) => setMapContexts((prev) => ({ ...prev, [threadId]: context }))}
            insertChatText={insertChatText}
          />
        )}
        {activeModule === "map" && mapChatVisible && (
          <div className="app-chat-slot map">
            <ChatPanel
              ref={chatInputRef}
              clientId={clientId}
              threadId={threadId}
              workspace={currentWorkspace}
              project={currentProject as unknown as Record<string, unknown> | null}
              frozen={Boolean(currentSession?.frozen)}
              compact
              onFileChanged={(changed) => {
                handleFileChanged(changed);
                mapBridgeRef.current?.onFileChanged?.(changed);
              }}
              onMapAction={(action) => mapBridgeRef.current?.onMapAction?.(action)}
              currentDoc={`地图项目:${currentMapProject}`}
              mapContext={currentMapContext}
              mapProject={currentMapProject}
              models={models as unknown as ChatModel[]}
              defaultModel={defaultModel}
              selectedModel={selectedModel}
              onModelChange={setSelectedModel}
              onAgentEnd={() => {
                handleAgentEnd();
                mapBridgeRef.current?.onAgentEnd?.();
              }}
              onRunFinished={handleRunFinished}
              onOpenRunChanges={openChangesForRun}
              onOpenRunArtifacts={openArtifactsForRun}
              onModeChange={setConversationMode}
              onPhaseChange={setConversationPhase}
              historyMessages={historyMessages}
              historyThreadId={historyThreadId}
              historyWindow={historyWindow}
              onNewSession={() => void handleNewSession()}
              onOpenFile={(...args: unknown[]) => { mapBridgeRef.current?.onOpenFile?.(...args); }}
              referenceFiles={files.map((file) => currentDir ? currentDir + "/" + file.name : file.name)}
              sessions={visibleSessions}
              onSelectSession={handleSelectSession}
              onSessionChange={handleSessionChange}
              onRefreshSessions={() => void refreshSessions()}
              onDeleteSession={handleDeleteSession}
              onBatchDeleteSession={async (ids: string[]) => { await handleBatchDeleteSessions(ids); }}
              unreadByThread={unreadByThread}
              onForkSession={async (id: string) => { await handleForkSession(id); }}
              onPinSession={handlePinSession}
              onFreezeSession={handleFreezeSession}
            />
          </div>
        )}
        {activeModule === "map" && mapChatVisible && (
          <Resizer className="map-chat-resizer" side="right" min={300} max={620} cssVar="--map-chat-w" />
        )}
        {sidebarOpen && (
          <>
            <SessionSidebar
              files={files}
              currentName=""
              onOpenFile={(name) => { markPreviewManual(); openDocFile(name); }}
              onRefreshFiles={() => void refreshFiles()}
              onUploaded={() => void refreshFiles()}
              projects={projects}
              currentProjectId={currentProject?.id || ""}
              onProjectChange={handleProjectChange}
              workspaces={workspaces}
              currentWorkspace={currentWorkspace}
              onWorkspaceChange={handleWorkspaceChange}
              currentDir={currentDir}
              onDirChange={handleDirChange}
              onAtMention={handleAtMention}
              loadStatus={loadStatus}
              changedFiles={changedFiles}
              onProjectUpdated={() => void refreshProjects()}
              models={models as unknown as ModelRecord[]}
              clientId={clientId}
              threadId={threadId}
              activeModel={selectedModel}
              onModelChange={setSelectedModel}
              sessions={sessions}
              unreadByThread={unreadByThread}
              onSelectSession={handleSelectSession}
              onRefreshSessions={() => void refreshSessions()}
              onDeleteSession={handleDeleteSession}
              onBatchDeleteSession={async (ids: string[]) => { await handleBatchDeleteSessions(ids); }}
              onRenameSession={handleRenameSession}
              onForkSession={async (id: string, name: string) => { await handleForkSession(id, name); }}
              onPinSession={handlePinSession}
              onFreezeSession={handleFreezeSession}
              onBeforeOpenModal={() => setActiveModule(null)}
              onOpenMap={() => setActiveModule("map")}
              onToggleTheme={toggleTheme}
              theme={theme}
            />
            <Resizer side="left" min={180} max={400} cssVar="--sidebar-w" />
          </>
        )}
        <div className="center-area">
          {!sidebarOpen && (
            <button className="sidebar-toggle" onClick={() => setSidebarOpen(true)} title="展开侧栏" aria-label="展开侧栏">
              <Icon name="chevronRight" size={14} />
            </button>
          )}
          <div className="center-content">
            <div className="topbar">
              {sidebarOpen && (
                <button className="btn-sm sidebar-collapse" onClick={() => setSidebarOpen(false)} title="收起侧栏" aria-label="收起侧栏"><Icon name="chevronLeft" size={14} /></button>
              )}
              <span className="topbar-title">
                <Icon name="comment" size={16} />
                <span>{currentSession?.title || currentSession?.label || currentProject?.name || "新建 Agent 会话"}</span>
              </span>
              <div className="conversation-mode-switch" role="group" aria-label="对话工作模式">
                <button
                  type="button"
                  className={`conversation-mode-option ${conversationMode === "chat" ? "active" : ""}`}
                  aria-pressed={conversationMode === "chat"}
                  title="Chat：只读问答和资料检索"
                  onClick={() => {
                    const switched = chatInputRef.current?.setMode?.("chat");
                    if (switched !== false) setConversationMode("chat");
                  }}
                >
                  <Icon name="comment" size={15} />
                  <span>Chat</span>
                </button>
                <button
                  type="button"
                  className={`conversation-mode-option work ${conversationMode === "agent" ? "active" : ""}`}
                  aria-pressed={conversationMode === "agent"}
                  title="Work：允许 Agent 调用编辑工具；实际读写与联网仍受运行环境权限限制"
                  onClick={() => {
                    const switched = chatInputRef.current?.setMode?.("agent");
                    if (switched !== false) setConversationMode("agent");
                  }}
                >
                  <Icon name="tool" size={15} />
                  <span>Work</span>
                </button>
                <button
                  type="button"
                  className={`conversation-mode-option review ${conversationMode === "review" ? "active" : ""}`}
                  aria-pressed={conversationMode === "review"}
                  title="Review：先依据实际读取的规范生成审查报告与安全副本，确认后才写回原文"
                  onClick={() => {
                    const switched = chatInputRef.current?.setMode?.("review");
                    if (switched !== false) setConversationMode("review");
                  }}
                >
                  <Icon name="shield" size={15} />
                  <span>Review</span>
                </button>
              </div>
              <span className={`conversation-status ${conversationPhase ? "working" : ""}`}><i /> {conversationPhase || "待命"}</span>
              {/* F4-1：任务中心（R11 任务运行面）——触发钮常驻 topbar，浮层 Portal 定位；
                  会话匹配打开对应对话，onFocusRun 等价滚动到最新运行处（新 ChatPanel focusRun
                  无 runId 参数）。fullPage 模块视图随模块导航（F5/F6）再挂。 */}
              <TaskCenter
                sessions={sessions}
                projects={projects}
                currentProjectId={currentProject?.id || ""}
                currentWorkspace={currentWorkspace}
                currentThreadId={threadId}
                currentSessionId={currentSessionId || ""}
                unreadCount={Object.values(unreadByThread).reduce((sum, count) => sum + Number(count || 0), 0)}
                onSelectSession={handleSelectSession}
                onFocusRun={() => { chatInputRef.current?.focusRun?.(); }}
                onOpenRun={handleOpenRun}
                eventVersion={eventVersion}
              />
            </div>
            {sessionResumeError && (
              <div className="session-resume-warning" role="alert">
                <Icon name="warning" size={14} />
                <span>
                  历史已加载为只读：Agent 会话恢复失败（{sessionResumeError.message}），继续对话前请先重试恢复。
                  {sessionResumeError.code === "SESSION_BUSY" && flag("resumeAutoRetry") && (
                    <> 已等待 {resumeWaitSec}s，当前任务结束后将自动恢复{busyForMs > 0 ? `（任务已运行 ${Math.round(busyForMs / 1000)}s）` : ""}。</>
                  )}
                </span>
                {sessionResumeError.code === "SESSION_BUSY" && busyActiveRunId && (
                  <button className="btn-xs" onClick={async () => { try { await cancelRun(busyActiveRunId, "用户请求取消以恢复会话"); } catch {}}}>取消当前任务</button>
                )}
                <button className="btn-xs" onClick={() => void retrySessionResume()} disabled={sessionResumeRetrying}>{sessionResumeRetrying ? "恢复中…" : "重试恢复"}</button>
              </div>
            )}
            {/* 交互 2：新建失败必须可见。旧实现只 console.warn，界面照常清空，
                用户以为已建好新会话。现在保留旧会话与草稿，并给出重试入口。 */}
            {newSessionError && (
              <div className="session-resume-warning" role="alert">
                <Icon name="warning" size={14} />
                <span>新建会话失败：{newSessionError.message}（已保留当前会话与未发送内容）</span>
                <button className="btn-xs" onClick={() => void handleNewSession()} disabled={creatingSession}>{creatingSession ? "创建中…" : "重试新建"}</button>
                <button className="btn-xs" onClick={() => setNewSessionError(null)}>忽略</button>
              </div>
            )}
            {/* 交互 8：工作区切换失败保留原目录与列表，说明失败原因并允许重试。 */}
            {workspaceSwitchError && (
              <div className="session-resume-warning" role="alert">
                <Icon name="warning" size={14} />
                <span>切换工作区失败：{workspaceSwitchError.message}（已保留原工作区与文件列表）</span>
                <button className="btn-xs" onClick={() => { const target = workspaceSwitchError.workspace; setWorkspaceSwitchError(null); void handleWorkspaceChange(target); }}>重试切换</button>
                <button className="btn-xs" onClick={() => setWorkspaceSwitchError(null)}>忽略</button>
              </div>
            )}
            {/* OAW_REPLAY_RECOVER（F2，默认关）：运行中刷新后提示可加载完整历史（复用现有横幅样式，零新样式） */}
            {restoredRunHint && (
              <div className="session-resume-warning" role="status">
                <Icon name="warning" size={14} />
                <span>检测到该会话仍有任务在执行，实时进度已恢复；可加载该会话的完整历史上下文。</span>
                <button className="btn-xs" onClick={() => {
                  const target = sessions.find((s) => (s.threadId || s.id) === restoredRunHint.threadId);
                  setRestoredRunHint(null);
                  if (target) void handleSelectSession(target);
                }}>加载完整历史</button>
                <button className="btn-xs" onClick={() => setRestoredRunHint(null)}>忽略</button>
              </div>
            )}
            {/* F5-7：地图模式下主聊天槽卸载（App.jsx 1616 条件挂载语义等价）——共享 ChatPanel
                已迁至 .app-chat-slot.map，主槽退场保证 chatInputRef 挂到地图槽实例上。 */}
            {activeModule !== "map" && (
            <div className="center-chat-slot">
              <ChatPanel
                ref={chatInputRef}
                clientId={clientId}
                threadId={threadId}
                workspace={currentWorkspace}
                project={currentProject as unknown as Record<string, unknown> | null}
                frozen={Boolean(currentSession?.frozen)}
                onFileChanged={handleFileChanged}
                models={models as unknown as ChatModel[]}
                defaultModel={defaultModel}
                selectedModel={selectedModel}
                onModelChange={setSelectedModel}
                onAgentEnd={handleAgentEnd}
                onRunFinished={handleRunFinished}
                onOpenRunChanges={openChangesForRun}
                onOpenRunArtifacts={openArtifactsForRun}
                onModeChange={setConversationMode}
                onPhaseChange={setConversationPhase}
                historyMessages={historyMessages}
                historyThreadId={historyThreadId}
                historyWindow={historyWindow}
                onNewSession={() => void handleNewSession()}
                onOpenFile={(...args: unknown[]) => { markPreviewManual(); openDocFile(String(args[0] ?? "")); }}
                referenceFiles={files.map((file) => currentDir ? currentDir + "/" + file.name : file.name)}
                sessions={visibleSessions}
                onSelectSession={handleSelectSession}
                onSessionChange={handleSessionChange}
                onRefreshSessions={() => void refreshSessions()}
                onDeleteSession={handleDeleteSession}
                onBatchDeleteSession={async (ids: string[]) => { await handleBatchDeleteSessions(ids); }}
                unreadByThread={unreadByThread}
                onForkSession={async (id: string) => { await handleForkSession(id); }}
                onPinSession={handlePinSession}
                onFreezeSession={handleFreezeSession}
              />
            </div>
            )}
          </div>
        </div>
      </div>
    </AppErrorBoundary>
  );
}
