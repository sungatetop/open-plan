import React, { lazy, Suspense, useState, useCallback, useEffect, useRef } from "react";
import SessionSidebar from "./components/SessionSidebar.jsx";
import ChatPanel, { normalizeHistoryMessages } from "./components/ChatPanel.jsx";
import Resizer from "./components/Resizer.jsx";
const SkillsManager = lazy(() => import("./components/SkillsManager.jsx"));
const AgentMarket = lazy(() => import("./components/AgentMarket.jsx"));
const IntegrationsCenter = lazy(() => import("./components/IntegrationsCenter.jsx"));
const KnowledgeBase = lazy(() => import("./components/KnowledgeBase.jsx"));
const TemplateLibrary = lazy(() => import("./components/TemplateLibrary.jsx"));
const MapPanel = lazy(() => import("./components/MapPanel.jsx"));
const CommandPalette = lazy(() => import("./components/CommandPalette.jsx"));
// 文档预览依赖 docx-preview / pptxviewjs / x-data-spreadsheet 等重库，按需加载
const DocViewer = lazy(() => import("./components/DocViewer.jsx"));
import Icon from "./components/Icon.jsx";
import { isMotionReduced, useAppearance } from "./ui-appearance.js";
import Logo from "./components/Logo.jsx";
import TaskCenter from "./components/TaskCenter.jsx";
import WorkProductPanel from "./components/WorkArtifactPanel.jsx";
import BrowserPanel from "./components/BuiltinBrowserPanel.jsx";
import SettingsPanel from "./components/SettingsPanel.jsx";
import MemoryTab from "./components/MemoryTab.jsx";
import 对象栏 from "./components/ObjectBar.jsx";
import 工作流启动器 from "./components/WorkflowLauncher.jsx";
import { useTheme } from "./theme.jsx";
import { loadUIState, saveUIState } from "./persist-ui.js";
import { acquireStream } from "./stream-budget.js";
import { listFiles, listModels, refreshModels, listSessions, listProjects, listRuns, listWorkspaces, switchWorkspace, deleteSession, deleteSessions, renameSession, getSession, getClientId, createAgentThread, resumeAgentThread, markAgentEventsRead, forkSession, pinSession, freezeSession, cancelRun } from "./api.js";
import { buildDocUrls, makeFileIdentity, mergeFileIdentity, fileIdentityKey, identityMatches } from "./file-urls.js";
import FeedbackHost, { notifyError } from "./components/Feedback.jsx";
import { initRuntimeFlags, flag, flagsReady } from "./feature-flags.js";

function historyReferences(text = "") {
  const refs = [];
  const seen = new Set();
  const add = (kind, target, source) => {
    const value = String(target || "").trim();
    if (!value) return;
    const id = `history_ref_${kind}_${value}`;
    if (seen.has(id)) return;
    seen.add(id);
    refs.push({ id, kind, target: value, source });
  };
  for (const m of String(text).matchAll(/@(知识库目录|知识库|模板目录|模板|文件)\[([^\]]+)\]/g)) {
    add({"知识库目录":"knowledge_dir", "知识库":"knowledge", "模板目录":"template_dir", "模板":"template", "文件":"file"}[m[1]], m[2], m[0]);
  }
  for (const m of String(text).matchAll(/(^|[\s(])@([^\s@，。！？\]}]+)/g)) {
    const target = m[2].replace(/[),;。！？]+$/, "");
    if (target.includes("/") || target.includes("\\") || /\.(docx|xlsx|pptx|pdf|csv|json|md|markdown|txt|html|htm)$/i.test(target)) add("file", target, `@${target}`);
  }
  for (const m of String(text).matchAll(/&会话\[([^\]]+)\]/g)) add("session", m[1], m[0]);
  return refs;
}

function cleanPersistedMessage(text = "") {
  const source = String(text || "");
  const inlineTaskGoal = source.match(/^#{1,6}\s*当前任务目标\s*[:：]\s*([^\n]+)/i);
  if (inlineTaskGoal?.[1]) return inlineTaskGoal[1].trim();
  const envelopeGoal = source.match(/^\s*#{1,6}\s*当前任务(?:\s+|\n)+(?:目标|任务目标)\s*[:：]\s*([\s\S]*?)(?=(?:\s+|\n)-?\s*(?:模式|引用|输出要求|当前文件|工作流)\s*[:：]|$)/i);
  if (envelopeGoal?.[1]) return envelopeGoal[1].trim();
  const goal = source.match(/(?:^|\n)\s*-?\s*(?:目标|任务目标)\s*[:：]\s*([\s\S]*?)(?=\n\s*-?\s*(?:模式|引用|输出要求|当前文件|工作流)\s*[:：]|$)/i);
  if (goal?.[1]) return goal[1].trim();
  return source.replace(/^##\s*当前任务[\s\S]*?\n边界：[^\n]+\n\n?/i, "").trim();
}

function DeferredModule({ children, label = "模块" }) {
  return <Suspense fallback={<div className="module-loading">正在加载{label}…</div>}>{children}</Suspense>;
}

function RefreshBloom() {
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
class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("App error:", error, errorInfo);
  }

  render() {
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

let histSeq = 0;
const histId = () => `h${++histSeq}`;

function historyImageData(block) {
  if (!block) return null;
  const source = block.source || block.image || block;
  const data = source?.data || block.data || source?.url || block.url;
  if (!data) return null;
  if (String(data).startsWith("data:")) return String(data);
  const mediaType = source?.mediaType || source?.mimeType || block.mediaType || block.mimeType || "image/png";
  return `data:${mediaType};base64,${data}`;
}

function entryCreatedAt(entry, message) {
  return entry?.timestamp || entry?.createdAt || entry?.time || message?.timestamp || message?.createdAt || null;
}

function sameWorkspacePath(a, b) {
  if (!a || !b) return false;
  const normalize = (value) => String(value).replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase();
  return normalize(a) === normalize(b);
}

// 取路径末段作为文件树匹配键：Agent 产物路径可能是绝对/相对/带子目录，
// 文件树只显示当前目录的文件，用末段名做短时高亮匹配最稳（仅用于视觉提示，不参与业务判断）。
function fileBasename(value) {
  const parts = String(value || "").replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

const GLOBAL_EVENT_NOTICES = new Set(["run_finished", "run_recovered", "run_cancel_requested", "agent_error", "ask_user"]);
// 启动加载分区文案：失败提示与重试按钮按分区说明，避免只报一句笼统错误。
const LOAD_SCOPE_LABELS = { files: "文件列表", sessions: "会话列表", projects: "项目列表", workspaces: "工作区列表" };

export default function App() {
  const [files, setFiles] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [unreadByThread, setUnreadByThread] = useState({});
  const [eventVersion, setEventVersion] = useState(0);
  const [artifactVersion, setArtifactVersion] = useState(0);
  const [tabs, setTabs] = useState([]); // [{ id, name, identity, kind, url?, sheets?, grids?, content? }]
  const [activeTab, setActiveTab] = useState(null); // 当前激活标签的 id（工作区 + 相对路径）
  const current = activeTab ? tabs.find((t) => (t.id || t.name) === activeTab) || null : null;
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activeModule, setActiveModule] = useState(null); // 0.10 统一模块入口
  const [settingsModuleTab, setSettingsModuleTab] = useState("settings");
  const [settingsSection, setSettingsSection] = useState("model");
  const [previewOpen, setPreviewOpen] = useState(false); // 默认不打开右侧预览：没有内容时不显示空面板（打开文件/产物时才展开）
  const [previewLayout, setPreviewLayout] = useState(0); // 0=默认，1=50%，2=100%
  const [mapChatVisible, setMapChatVisible] = useState(true); // 地图模式保留 Agent 对话，可独立隐藏
  const [previewTab, setPreviewTab] = useState("document");
  // B03：右栏三页签（预览 / 改动 / 产物）；改动与产物默认看“本轮”，可切回“会话”
  const [changesRunId, setChangesRunId] = useState("");
  const [artifactScope, setArtifactScope] = useState("session");
  const [browserPanelOpen, setBrowserPanelOpen] = useState(false); // 内置浏览器独立侧栏
  const [browserFullscreen, setBrowserFullscreen] = useState(false);
  const [subagentDetail, setSubagentDetail] = useState(null); // 点开子代理卡片后，右栏展示的该子代理完整过程
  // 用户手动关掉浏览器侧栏后，本轮不再自动弹开（否则每个 browser_* 工具都会把它重新拉起来）。
  const browserAutoOpenBlockedRef = useRef(false);
  // 运行开关快照到达后的重渲染触发器（值本身不参与渲染，只用来让 flag() 派生的状态重算）。
  const [, setFlagsTick] = useState(0);

  // 反馈基座/运行开关：挂载即拉取 /api/status 的 runtimeFlags 快照；拉取失败保持全关（= 基线行为）。
  useEffect(() => {
    initRuntimeFlags().then(() => {
      // Qoder P0-4（开关 qoderStyle，默认关）：仅在开关打开时给 <html> 打标，
      // 由 styles.css 末尾的 opt-in 令牌层接管配色；关掉即移除标记，外观立即回到 pi-dark 基线。
      const root = document.documentElement;
      if (flag("qoderStyle")) root.setAttribute("data-oaw-style", "qoder");
      else root.removeAttribute("data-oaw-style");
      // P2-4（开关 visualEffectsOff，默认关）：打开时给 <html> 打标，
      // 由 styles.css 末尾的特效降级块去掉背景模糊与长动效；关掉即移除标记、特效立即恢复。
      if (flag("visualEffectsOff")) root.setAttribute("data-visual-effects", "off");
      else root.removeAttribute("data-visual-effects");
      // 快照到达后触发一次重渲染：P1-8 对象栏等由 flag() 派生出的 React 状态需要重算
      // （快照到达前 flag() 一律为关，不重算就会一直停在「关闭」分支）。
      setFlagsTick((value) => value + 1);
    });
  }, []);

  useEffect(() => {
    if (!browserPanelOpen) setBrowserFullscreen(false);
  }, [browserPanelOpen]);

  // 窄屏防挤压（P1）：右侧只保留一列面板。窗口变窄或打开浏览器栏时自动收起预览，
  // 避免「侧栏 + 对话 + 预览 + 浏览器」四条最小宽度之和超过视口把对话挤成细条。
  // ≤768px 时侧栏与右侧面板都是覆盖层（抽屉），因此还要收起侧栏抽屉：
  // 否则打开时它会整屏盖住对话，用户看不到输入框与发送键。
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const enforceNarrowLayout = () => {
      if (window.innerWidth > 1024) return;
      setPreviewOpen((open) => (open && browserPanelOpen ? false : open));
      if (window.innerWidth <= 768) setSidebarOpen(false);
    };
    enforceNarrowLayout();
    window.addEventListener("resize", enforceNarrowLayout);
    return () => window.removeEventListener("resize", enforceNarrowLayout);
  }, [browserPanelOpen]);
  const [conversationMode, setConversationMode] = useState("chat");
  const [conversationPhase, setConversationPhase] = useState("");
  const [paletteOpen, setPaletteOpen] = useState(false); // 命令面板（Ctrl/Cmd+K）
  const [clientId] = useState(getClientId);
  const [threadId, setThreadId] = useState(() => {
    const saved = localStorage.getItem("oaw_thread_id");
    if (saved) return saved;
    const id = `thread-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
    localStorage.setItem("oaw_thread_id", id);
    return id;
  });
  const [mapContexts, setMapContexts] = useState({});
  const currentMapContext = mapContexts[threadId] || null;
  const currentMapProject = currentMapContext?.mapProject || "zhejiang-map";

  // Agent 调用 browser_* 时自动打开浏览器侧栏。信号来自对话流里的工具事件
  // （ChatPanel 的 tool_start），不再为此常驻一条 /api/browser/stream：
  // 每条长连接都占一个同源连接槽位，槽位被占满会让切工作区/切会话永远排队。
  const previewOpenRef = useRef(previewOpen);
  previewOpenRef.current = previewOpen;
  const previewOpenBeforeBrowserRef = useRef(false); // O-P7：窄屏让位前的预览栏状态
  const previewTabManualAtRef = useRef(0); // O-P2：用户最近一次手动切换右栏页签的时间
  const [browserActivityPing, setBrowserActivityPing] = useState(0); // O-P3：手关浏览器后的活动徽标
  const handleBrowserActivity = useCallback(() => {
    if (browserAutoOpenBlockedRef.current) {
      // O-P3（OAW_BROWSER_BADGE，默认关）：手关后不再静默丢弃本轮浏览器活动，顶栏开关亮徽标
      if (flag("browserBadge")) setBrowserActivityPing((value) => value + 1);
      return;
    }
    // O-P7（OAW_NARROW_RESTORE，默认关）：窄屏弹开浏览器让位预览栏前记住状态，关闭后恢复
    if (flag("narrowRestore") && typeof window !== "undefined" && window.innerWidth <= 1024 && previewOpenRef.current) {
      previewOpenBeforeBrowserRef.current = true;
    }
    setBrowserActivityPing(0);
    setWorkspaceTabPref("browser");
    setBrowserPanelOpen(true);
  }, []);
  const closeBrowserPanel = useCallback(() => {
    browserAutoOpenBlockedRef.current = true;
    setBrowserPanelOpen(false);
    if (previewOpenBeforeBrowserRef.current) {
      previewOpenBeforeBrowserRef.current = false;
      if (flag("narrowRestore") && typeof window !== "undefined" && window.innerWidth <= 1024) setPreviewOpen(true);
    }
  }, []);

  // P10 工作区画布：工作产物与内置浏览器合并为一个 tab 化容器（proma 式画布）。
  // 两个 open flag 语义保持不变（自动打开 / 窄屏恢复 / 徽标逻辑零改动），
  // 只新增「当前激活页签」偏好：打开谁就激活谁；关闭激活页签时自动回退到另一个仍打开的面板。
  const [workspaceTabPref, setWorkspaceTabPref] = useState("preview");
  const workspaceOpen = previewOpen || browserPanelOpen;
  // P1-8 对象栏：作为画布第三个页签接入（开关关闭时 objectsOpen 恒为 false，
  // 下面 workspaceTab 的取值与基线逐字一致——`x || false === x`）。
  const [objectsOpenState, setObjectsOpenState] = useState(false);
  const objectsOpen = flag("qoderObjectBar") ? objectsOpenState : false;
  // M4.4 领域工作流：作为画布第四个页签接入（同样的门控手法——开关关闭时
  // workflowsOpen 恒为 false，下面 workspaceTab 的取值与接入前逐字一致）。
  const [workflowsOpenState, setWorkflowsOpenState] = useState(false);
  const workflowsOpen = flag("domainWorkflows") ? workflowsOpenState : false;
  const workspaceTab = workspaceTabPref === "workflows" && workflowsOpen ? "workflows"
    : workspaceTabPref === "objects" && objectsOpen ? "objects"
      : workspaceTabPref === "browser" && browserPanelOpen ? "browser"
        : workspaceTabPref === "preview" && previewOpen ? "preview"
          : objectsOpen ? "objects" : workflowsOpen ? "workflows" : browserPanelOpen ? "browser" : "preview";

  const [models, setModels] = useState([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [selectedModel, setSelectedModel] = useState(() => localStorage.getItem("oaw_model") || "");
  const [workspaces, setWorkspaces] = useState([]);
  const [projects, setProjects] = useState([]);
  const [currentWorkspace, setCurrentWorkspace] = useState("");
  // 启动加载状态：files/sessions/projects/workspaces 各自记录 ready/error，
  // 失败时保留上一次可用数据并给出可重试的提示，而不是静默伪装成空结果。
  const [loadStatus, setLoadStatus] = useState({ files: "loading", sessions: "loading", projects: "loading", workspaces: "loading" });
  const [loadErrors, setLoadErrors] = useState({});
  const currentProject = projects.find((project) => sameWorkspacePath(project.rootPath, currentWorkspace)) || null;
  const [currentDir, setCurrentDir] = useState(""); // 相对路径子目录
  const currentDirRef = useRef(""); // 与 currentDir 同步的最新值，供无参 refreshFiles 使用
  const currentWorkspaceRef = useRef(""); // 与 currentWorkspace 同步：文件请求必须带上它，避免用旧闭包值
  const filesRef = useRef([]); // 与 files 同步：工作区切换失败时用它恢复原列表，不给回调加 files 依赖
  const [changedFiles, setChangedFiles] = useState(() => new Set()); // 本轮刚被改动的文件名（短时高亮文件树）
  const [historyMessages, setHistoryMessages] = useState(null); // 加载的历史会话消息
  const [historyThreadId, setHistoryThreadId] = useState(null); // 当前历史消息对应的 thread，避免切换 effect 覆盖恢复内容
  // OAW_REPLAY_RECOVER（F2，默认关）：冷启动探测到保存的 thread 仍有执行中的 Run 时，
  // 提示用户可加载该会话完整历史（不改动「刷新不自动恢复会话」的已批准规则，仅补运行中例外入口）。
  const [restoredRunHint, setRestoredRunHint] = useState(null);
  const restoredRunProbedRef = useRef(false);
  const [historyWindow, setHistoryWindow] = useState(null); // 服务端为长会话返回的展示窗口信息
  const [sessionResumeError, setSessionResumeError] = useState(null); // { sessionId, message } Agent 恢复失败时历史只读
  // 新建会话的进行中/失败状态（交互 2）：失败必须可见，且不得清空旧会话。
  const [creatingSession, setCreatingSession] = useState(false);
  const [newSessionError, setNewSessionError] = useState(null); // { message, workspace }
  // 工作区切换失败（交互 8）：保留原状态并提示原因，不再静默 refreshFiles。
  const [workspaceSwitchError, setWorkspaceSwitchError] = useState(null); // { message, workspace }
  const [sessionResumeRetrying, setSessionResumeRetrying] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState(null); // 当前会话 id（用于界面恢复）
  const currentSession = sessions.find((session) => session.id === currentSessionId) || null;
  const [docLoading, setDocLoading] = useState(false); // 文档加载中
  const restoredRef = useRef(false); // 界面状态恢复标记（避免重复/过早保存）
  const sessionsRef = useRef([]);
  const sessionsRefreshRef = useRef(null);
  const projectsRefreshRef = useRef(null);
  const eventRefreshTimerRef = useRef(null);
  const eventBatchTimerRef = useRef(null);
  const eventBatchRef = useRef({ updates: 0, artifacts: 0 });
  const sessionHistoryCacheRef = useRef(new Map());
  const sessionHistoryMetaRef = useRef(new Map());
  const chatInputRef = useRef(null); // 引用 ChatPanel 输入框（@ 按钮插入）
  const mapBridgeRef = useRef(null); // 地图模式复用同一个 ChatPanel，保持消息与 SSE 事件流连续
  const sessionLoadSeqRef = useRef(0);
  const workspaceSwitchSeqRef = useRef(0);
  // 统一导航代际（交互 8）：项目/工作区/会话/新建共享一条失效边界；
  // 任一导航都会推进它，异步返回后若不匹配就丢弃，避免逆序响应互相覆盖。
  const navGenerationRef = useRef(0);
  const newSessionInFlightRef = useRef(false);
  const filesRequestSeqRef = useRef(0);
  const docRequestSeqRef = useRef(0);
  const docAbortRef = useRef(null); // 打开文件请求的中止器：切文件/关标签/切工作区时取消旧请求
  const currentThreadRef = useRef(threadId);
  const eventCursorRef = useRef(Number(localStorage.getItem("oaw_event_cursor") || 0));
  const eventNoticeKeysRef = useRef(new Set());
  const autoOpenedRunRef = useRef(new Set());
  const changedFilesTimerRef = useRef(null);
  const previewToggleRef = useRef(null);
  const taskCenterRef = useRef(null);
  const topbarToolsRef = useRef(null);
  const [topbarMenuOpen, setTopbarMenuOpen] = useState(false);
  const pendingChatInsertRef = useRef([]);
  const { theme, toggleTheme } = useTheme();

  // 所有功能模块共用一个互斥入口，避免知识库、地图、智能体广场等弹层叠在一起。
  const closeExternalModules = useCallback(() => {
    setActiveModule(null);
  }, []);
  const openExternalModule = useCallback((module) => {
    setActiveModule(module);
  }, []);

  // 外部模块打开时主 ChatPanel 会卸载；先暂存 @ 引用，待回到对话后再写入，
  // 避免“点击调用但输入框没有任何内容”的竞态。
  const insertChatText = useCallback((value) => {
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
      pending.forEach((text) => chatInputRef.current.insertText(text));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeModule]);

  // 设置面板的“刷新模型”需要走一次供应商网络刷新；启动、定时轮询和切回标签页
  // 只读已缓存目录：POST /api/models/refresh 会重置共享 ModelRuntime 并等待网络
  // 往返（实测约 1 秒），既拖慢首屏，也会在会话进行中打断运行时预热。
  const refreshModelCatalog = useCallback(async () => {
    const data = await refreshModels();
    setModels(data.models || []);
    setDefaultModel(data.default || "");
    return data;
  }, []);

  const syncModelCatalog = useCallback(async () => {
    const data = await listModels();
    setModels(data.models || []);
    setDefaultModel(data.default || "");
    return data;
  }, []);

  useEffect(() => {
    currentThreadRef.current = threadId;
  }, [threadId]);

  // @ 按钮：把文件/文件夹路径插入到对话输入框
  const handleAtMention = useCallback((rel, isDir) => {
    const marker = isDir ? rel + "/" : rel;
    insertChatText(`@${marker}`);
  }, [insertChatText]);

  // 知识库 / Skills 的只读 Chat 转 Agent：关闭入口后把问题、引用和上下文
  // 交给主 ChatPanel，用户确认后再发送，避免检索入口隐式产生写入。
  const handlePromoteToAgent = useCallback((payload = {}) => {
    closeExternalModules();
    window.setTimeout(() => chatInputRef.current?.startAgentTask?.(payload), 120);
  }, [closeExternalModules]);

  // 新建会话：清空历史消息和当前文档。
  // 交互 2：所有 UI 入口统一零参数调用；历史实现直接把入口当 workspace 传，
  // React 点击事件被序列化成 cwd，抛出 "Converting circular structure to JSON"，
  // 而失败又被吞掉、界面照常切换，用户看到的是"清空了但没有新会话"。
  // 现在：只接受字符串工作区，连续点击去重，失败保留旧会话与草稿并给出可重试提示，
  // 成功后才提交 thread 与清空旧上下文。
  const handleNewSession = useCallback(async (workspaceArg) => {
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
    let created = null;
    try {
      // 先让后端创建并固定 session/workspace，再切换前端 thread，避免 SSE 先创建一个错误 cwd 的空 Agent。
      const project = projects.find((item) => sameWorkspacePath(item.rootPath, targetWorkspace));
      created = await createAgentThread(clientId, next, targetWorkspace || undefined, { projectId: project?.id || null });
    } catch (e) {
      newSessionInFlightRef.current = false;
      setCreatingSession(false);
      if (generation === navGenerationRef.current) {
        // 保留旧会话、标签与未发送输入，只提示失败原因并提供重试。
        setNewSessionError({ message: e?.message || "创建新会话失败", workspace: targetWorkspace || "" });
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
    window.setTimeout(() => refreshSessions(), 600);
    setThreadId(next);
    localStorage.setItem("oaw_thread_id", next);
    setHistoryMessages(null);
    setHistoryThreadId(null);
    setHistoryWindow(null);
    setSessionResumeError(null);
    // 切会话时丢弃在途的文件打开请求与已打开标签，避免旧结果写入新会话预览。
    docRequestSeqRef.current += 1;
    if (docAbortRef.current) { try { docAbortRef.current.abort(); } catch {} docAbortRef.current = null; }
    setTabs([]);
    setActiveTab(null);
    // 交互 5：目录归根必须与列表同一次导航——清掉旧子目录项并读根列表，
    // 否则根目录下仍显示旧子目录内容，点开会按新的根路径解释。
    currentDirRef.current = "";
    setCurrentDir("");
    setFiles([]);
    void refreshFiles("");
    setCurrentSessionId(created?.sessionId || null);
    setMapContexts((prev) => ({ ...prev, [next]: null }));
    lastSessionIdRef.current = created?.sessionId || null;
    newSessionInFlightRef.current = false;
    setCreatingSession(false);
    return created;
    // 不把 refreshFiles / refreshSessions 列入依赖：它们在下方才声明，依赖数组在
    // 渲染期求值会命中 TDZ；两者都是依赖稳定的 useCallback，闭包捕获始终有效。
  }, [clientId, currentWorkspace, projects]);

  const setScopeStatus = useCallback((scope, status) => {
    setLoadStatus((prev) => (prev[scope] === status ? prev : { ...prev, [scope]: status }));
  }, []);

  const setScopeError = useCallback((scope, error) => {
    const message = error ? (error.message || "网络请求失败") : "";
    setLoadErrors((prev) => {
      if (!message) return prev[scope] ? { ...prev, [scope]: "" } : prev;
      return prev[scope] === message ? prev : { ...prev, [scope]: message };
    });
  }, []);

  const refreshFiles = useCallback(async (dir) => {
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
      setFiles(result.files || []);
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
  // 同理同步文件列表：切换失败要能恢复原列表，但不能让回调依赖 files 频繁重建。
  useEffect(() => { filesRef.current = files; }, [files]);

  const refreshSessions = useCallback(async () => {
    if (sessionsRefreshRef.current) return sessionsRefreshRef.current;
    setScopeStatus("sessions", "loading");
    const request = listSessions()
      .then((data) => {
        const next = data.sessions || [];
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

  // 根级事件订阅：当前对话继续使用原有 thread SSE，App 额外监听所有 thread 的重要状态，
  // 让切换后的后台任务仍能刷新历史和未读提示。
  useEffect(() => {
    let source;
    let reconnectTimer = null;
    let retryDelay = 800;
    let cancelled = false;
    // 全局事件流是核心长连接（必需）：槽位不足时优先保证它和对话流。
    const slot = acquireStream("agent-events", { essential: true, priority: 2, label: "全局事件流" });
    const cursorKey = "oaw_event_cursor";
    const flushEventBatch = () => {
      eventBatchTimerRef.current = null;
      const pending = eventBatchRef.current;
      eventBatchRef.current = { updates: 0, artifacts: 0 };
      if (pending.updates) setEventVersion((value) => value + pending.updates);
      if (pending.artifacts) setArtifactVersion((value) => value + pending.artifacts);
    };
    const scheduleEventBatch = (artifact = false) => {
      eventBatchRef.current.updates += 1;
      if (artifact) eventBatchRef.current.artifacts += 1;
      if (!eventBatchTimerRef.current) eventBatchTimerRef.current = window.setTimeout(flushEventBatch, 100);
    };
    const scheduleReconnect = () => {
      if (cancelled || reconnectTimer) return;
      try { source?.close(); } catch {}
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, retryDelay);
      retryDelay = Math.min(5000, retryDelay * 2);
    };
    const connect = async () => {
      let cursor = eventCursorRef.current;
      if (!localStorage.getItem(cursorKey)) {
        try {
          const state = await fetch(`/api/agent/events/state?client=${encodeURIComponent(clientId)}`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json());
          if (Number.isFinite(Number(state.latest))) cursor = Number(state.latest);
          eventCursorRef.current = cursor;
          localStorage.setItem(cursorKey, String(cursor));
        } catch {}
      }
      if (cancelled) return;
      source = new EventSource(`/api/agent/events?client=${encodeURIComponent(clientId)}&after=${encodeURIComponent(cursor)}`);
      slot?.attach(() => source?.close());
      source.onopen = () => { retryDelay = 800; };
      source.onmessage = (message) => {
        try {
          const payload = JSON.parse(message.data || "{}");
          const event = payload.event || payload;
          const seq = Number(event.seq || 0);
          if (!seq || seq <= eventCursorRef.current) return;
          eventCursorRef.current = seq;
          localStorage.setItem(cursorKey, String(seq));
          const isCurrentThread = !event.threadId || event.threadId === currentThreadRef.current;
          scheduleEventBatch(isCurrentThread && ["run_finished", "file_changed", "artifact_published", ...(flag("stagedVisible") ? ["artifact_staged"] : [])].includes(event.type));
          const thread = event.threadId || "";
          const noticeKey = `${thread}:${event.runId || "event"}:${event.type}`;
          if (thread && thread !== currentThreadRef.current && GLOBAL_EVENT_NOTICES.has(event.type) && !eventNoticeKeysRef.current.has(noticeKey)) {
            eventNoticeKeysRef.current.add(noticeKey);
            setUnreadByThread((prev) => ({ ...prev, [thread]: (prev[thread] || 0) + 1 }));
          }
          if (["run_finished", "run_recovered", "run_cancel_requested", "agent_error"].includes(event.type)) {
            // 新一轮开始前恢复"浏览器侧栏可自动展开"：用户上一轮手动关掉的状态不跨轮传递。
            if (event.type === "run_finished") browserAutoOpenBlockedRef.current = false;
            if (!eventRefreshTimerRef.current) {
              eventRefreshTimerRef.current = window.setTimeout(() => {
                eventRefreshTimerRef.current = null;
                if (document.visibilityState === "visible") refreshSessions();
              }, 180);
            }
          }
        } catch {}
      };
      source.onerror = scheduleReconnect;
    };
    connect();
    return () => {
      cancelled = true;
      source?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (eventBatchTimerRef.current) {
        clearTimeout(eventBatchTimerRef.current);
        eventBatchTimerRef.current = null;
      }
      eventBatchRef.current = { updates: 0, artifacts: 0 };
      if (eventRefreshTimerRef.current) {
        clearTimeout(eventRefreshTimerRef.current);
        eventRefreshTimerRef.current = null;
      }
      slot?.release();
    };
  }, [clientId, refreshSessions]);

  const refreshProjects = useCallback(async () => {
    if (projectsRefreshRef.current) return projectsRefreshRef.current;
    setScopeStatus("projects", "loading");
    const request = listProjects()
      .then((data) => {
        const next = data.projects || [];
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

  const refreshWorkspaces = useCallback(async () => {
    setScopeStatus("workspaces", "loading");
    try {
      const data = await listWorkspaces();
      const list = data.workspaces || [];
      setWorkspaces(list);
      setScopeStatus("workspaces", "ready");
      setScopeError("workspaces", null);
      const savedWorkspace = loadUIState()?.workspace;
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
    if (!failed.length || failed.includes("files")) refreshFiles();
    if (!failed.length || failed.includes("sessions")) refreshSessions();
    if (!failed.length || failed.includes("projects")) refreshProjects();
    if (!failed.length || failed.includes("workspaces")) refreshWorkspaces();
  }, [loadErrors, refreshFiles, refreshSessions, refreshProjects, refreshWorkspaces]);

  useEffect(() => {
    refreshFiles();
    refreshSessions();
    refreshProjects();
    let modelTimer;
    const sessionTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") refreshSessions();
    }, 15000);
    const projectTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") refreshProjects();
    }, 30000);
    const syncModels = async () => {
      try {
        await syncModelCatalog();
      } catch {
        // 扫描失败时保留上一次列表，避免模型下拉框瞬间清空。
      }
    };
    syncModels();
    modelTimer = window.setInterval(syncModels, 60_000);
    const onVisibility = () => { if (document.visibilityState === "visible") syncModels(); };
    document.addEventListener("visibilitychange", onVisibility);
    refreshWorkspaces();
    return () => {
      window.clearInterval(modelTimer);
      window.clearInterval(sessionTimer);
      window.clearInterval(projectTimer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refreshFiles, refreshSessions, refreshProjects, refreshWorkspaces, syncModelCatalog]);

  // 全局 Ctrl/Cmd+K 切换命令面板
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 切换工作区
  const handleWorkspaceChange = useCallback(async (dir) => {
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
    // 切工作区时中止在途打开请求并清空标签，旧工作区的预览结果不得写入。
    docRequestSeqRef.current += 1;
    if (docAbortRef.current) { try { docAbortRef.current.abort(); } catch {} docAbortRef.current = null; }
    setTabs([]);
    setActiveTab(null);
    setHistoryMessages(null);
    setHistoryWindow(null);
    setCurrentSessionId(null);
    try {
      const r = await switchWorkspace(requestedPath);
      if (switchSeq !== workspaceSwitchSeqRef.current) return;
      // 先同步 ref 再触发任何文件请求：refreshFiles 与 handleNewSession 都从
      // currentWorkspaceRef 取身份，晚一拍就会把新工作区的请求发到旧路径上。
      currentWorkspaceRef.current = r.workspace;
      setCurrentWorkspace(r.workspace);
      // 新工作区加入下拉列表（自定义路径切换后也能在下拉中看到）
      setWorkspaces((prev) => {
        if (prev.some((w) => w.path === r.workspace)) return prev;
        const name = String(r.workspace).split(/[\\/]/).filter(Boolean).pop() || r.workspace;
        return [...prev, { path: r.workspace, name }];
      });
      setFiles(r.files || []);
      // 工作区切换后异步刷新项目：让新打开的本地目录立即出现在项目栏，且不阻塞文件视图。
      void refreshProjects();
      void handleNewSession(r.workspace);
    } catch (e) {
      if (switchSeq === workspaceSwitchSeqRef.current) {
        // 切换失败保留原有效状态：恢复原目录与文件列表，只提示失败原因。
        currentDirRef.current = previousDir;
        setCurrentDir(previousDir);
        setFiles(previousFiles);
        setWorkspaceSwitchError({ message: e?.message || "切换工作区失败", workspace: requestedPath });
      }
    }
  }, [currentWorkspace, handleNewSession, refreshFiles, refreshProjects]);

  const visibleSessions = currentWorkspace
    ? sessions.filter((session) => !session.cwd || sameWorkspacePath(session.cwd, currentWorkspace))
    : sessions;
  // 启动加载失败提示：按分区列出，提供统一重试；失败期间保留上一次可用数据。
  const loadFailures = Object.entries(loadErrors).filter(([, message]) => Boolean(message));
  const loadFailureText = loadFailures.length
    ? `${loadFailures.map(([scope]) => LOAD_SCOPE_LABELS[scope] || scope).join("、")}读取失败，已保留上一次可用数据`
    : "";
  const loadRetrying = loadFailures.some(([scope]) => loadStatus[scope] === "loading");
  const handleProjectChange = useCallback((id) => {
    const project = projects.find((item) => item.id === id);
    if (project?.rootPath) handleWorkspaceChange(project.rootPath);
  }, [projects, handleWorkspaceChange]);

// 进入/返回子目录
  const handleDirChange = useCallback((dir) => {
    const nextDir = String(dir || "");
    currentDirRef.current = nextDir;
    setCurrentDir(nextDir);
    void refreshFiles(nextDir);
  }, [refreshFiles]);

  const open = useCallback(async (name, thread = threadId, cwd = currentWorkspace) => {
    const requestSeq = ++docRequestSeqRef.current;
    // 中止上一次未完成的打开请求：旧响应（可能来自另一个工作区的同名文件）不得写入新预览。
    docAbortRef.current?.abort();
    const controller = new AbortController();
    docAbortRef.current = controller;
    setDocLoading(true);
    // 容错：调用方可能只传了工作区（例如产物跨工作区打开），thread 缺失时回退到当前会话
    const effectiveThread = thread || threadId;
    const effectiveCwd = cwd || currentWorkspace;
    // 打开前先构造本地身份（workspaceId + relativePath），后续所有预览请求都用它。
    const localIdentity = makeFileIdentity({ workspaceId: effectiveCwd, cwd: effectiveCwd, relativePath: name });
    try {
      const urls = buildDocUrls(localIdentity);
      const params = new URLSearchParams({ client: clientId, thread: effectiveThread || "" });
      const response = await fetch(`${urls.open}&${params.toString()}`, { cache: "no-store", signal: controller.signal });
      const doc = await response.json();
      if (!response.ok || doc?.error) throw new Error(doc?.error || `加载失败 HTTP ${response.status}`);
      if (requestSeq !== docRequestSeqRef.current) return null;
      // 服务端返回的文件身份（含真实 version/hash）优先；前端核对一致后才使用，不一致则标记 failed。
      const identity = mergeFileIdentity(localIdentity, doc?.identity);
      const identityVerified = doc?.identity ? identityMatches(localIdentity, doc.identity) : true;
      const resolvedUrls = buildDocUrls(identity);
      // 预览地址一律由本地身份重建（带上 cwd + revision），不直接信任 doc.url。
      const previewUrl = doc.kind === "pdf" ? resolvedUrls.raw : doc.kind === "html" ? resolvedUrls.html : (doc.url || "");
      const id = fileIdentityKey(identity);
      const nextDoc = {
        ...doc,
        identity,
        id,
        url: previewUrl,
        previewRevision: identity.revision,
        identityVerified,
      };
      // 文件从“本轮产物”或 Agent 自动产出打开时，直接切到文档预览，
      // 避免用户还停留在产物列表而误以为文件没有打开。
      setPreviewOpen(true);
      setWorkspaceTabPref("preview");
      setPreviewTab("document");
      // 单次 setTabs：按「工作区 + 相对路径」去重，不同工作区的同名文件是不同标签。
      setTabs((prev) => {
        const exists = prev.find((t) => (t.id || t.name) === id);
        if (exists) return prev.map((t) => ((t.id || t.name) === id ? { ...t, ...nextDoc, name } : t));
        return [...prev, { name, ...nextDoc }];
      });
      setActiveTab(id);
      setDocLoading(false);
      return id;
    } catch (e) {
      // 被更新请求取代：静默丢弃，不弹窗、不清 loading（由新请求负责）。
      if (e?.name === "AbortError") return null;
      const message = String(e?.message || "");
      // 文件被移动/删除，或文件列表还是切换工作区之前的旧数据时，不弹生硬的 "not found"，
      // 而是刷新列表并提示重新选择。
      if (/not found|enoent|http 404/i.test(message)) {
        try { await refreshFiles?.(); } catch {}
        notifyError(`文件不存在或已被移动：${name}\n已刷新文件列表，请重新选择。`);
      } else {
        notifyError("打开失败: " + message);
      }
      setDocLoading(false);
      return null;
    }
  }, [clientId, threadId, currentWorkspace]);

  const handleChatOpenFile = useCallback((name) => {
    if (activeModule === "map") mapBridgeRef.current?.onOpenFile?.(name);
    else open(name);
  }, [activeModule, open]);

  // 子代理卡片 → 右栏「子代理」页：展示该子代理的思考 / 回复 / 工具调用完整过程。
  // 传入的是点击时刻的 block 快照；运行中想看最新过程可再次点击卡片。
  const openSubagentDetail = useCallback((block) => {
    setSubagentDetail(block || null);
    setPreviewOpen(true);
    setWorkspaceTabPref("preview");
    setPreviewTab("subagent");
  }, []);

  // 子代理运行中：ChatPanel 推送最新 block，若正是右栏正在看的那个则原地刷新（实时更新思考/回复/工具）
  const handleSubagentUpdate = useCallback((_thread, block) => {
    if (!block?.id) return;
    setSubagentDetail((prev) => (prev && prev.id === block.id ? block : prev));
  }, []);

  // 关闭 tab（按标签 id；关闭当前标签时中止在途打开请求，避免旧结果写入已关闭的预览）
  const closeTab = useCallback((id) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => (t.id || t.name) === id);
      if (idx === -1) return prev;
      const next = prev.filter((t) => (t.id || t.name) !== id);
      if (activeTab === id) {
        // 激活相邻 tab
        const neighbor = next[Math.min(idx, next.length - 1)];
        setActiveTab(neighbor ? (neighbor.id || neighbor.name) : null);
      }
      return next;
    });
    if (activeTab === id) {
      if (docAbortRef.current) { try { docAbortRef.current.abort(); } catch {} docAbortRef.current = null; }
      docRequestSeqRef.current += 1;
    }
  }, [activeTab]);

  // 点击历史会话：加载该会话的消息记录，并尝试打开关联文件
  const handleSelectSession = useCallback(async (session) => {
    // 会话切换：重置右栏“改动/产物”的 runId 与范围，
    // 避免上一个会话的“本轮产物”污染到当前会话（用户反馈的跨会话污染）。
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
        resumedWorkspace = switched.workspace;
        setCurrentWorkspace(switched.workspace);
        currentDirRef.current = "";
        setCurrentDir("");
        setFiles(switched.files || []);
        docRequestSeqRef.current += 1;
        if (docAbortRef.current) { try { docAbortRef.current.abort(); } catch {} docAbortRef.current = null; }
        setTabs([]);
        setActiveTab(null);
      } catch (e) {
        console.warn("切换到会话工作区失败，仍尝试加载历史:", e.message);
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
    // 但在 resume 完成前不切换 thread，避免 SSE 先创建一个新的空会话并与恢复竞态。
    const historyPromise = Promise.all([
      getSession(session.id, { view: "chat", limit: 360 }),
      listRuns("", 50, { sessionId: session.id }).catch(() => ({ runs: [] })),
    ]);
    const resumePromise = resumeAgentThread(clientId, conversationId, session.id, resumedWorkspace)
      .then(() => ({ ok: true }))
      .catch((e) => { console.warn("恢复 Agent 会话失败，历史按只读展示:", e.message); return { ok: false, error: e.message || "恢复失败" }; });
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
      localStorage.setItem("oaw_thread_id", conversationId);
      // 按原始 JSONL 顺序重建消息。toolResult 是工具输出，不能渲染成 You 的用户气泡；
      // 它要按 toolCallId 回填到对应 Agent 工具卡，否则 Word/PPT 读取结果会被误认为用户输入。
      const msgs = [];
      const toolBlocks = new Map();
      for (const e of (d.entries || [])) {
        if (e.type !== "message" || !e.message) continue;
        const m = e.message;
        const role = m.role === "assistant" ? "assistant" : m.role === "user" ? "user" : m.role;
        if (role === "toolResult" || role === "tool_result") {
          const output = typeof m.content === "string"
            ? m.content
            : Array.isArray(m.content)
              ? m.content.filter((b) => b?.type === "text").map((b) => b.text || "").join("\n")
              : JSON.stringify(m.content || m.output || "", null, 2);
          const block = toolBlocks.get(m.toolCallId);
          if (block) {
            block.output = output;
            block.result = output;
            block.done = true;
            block.isError = !!m.isError;
          } else {
            // 老会话可能没有可配对的 toolCallId：挂到最近一条 Agent 消息，仍不显示为用户消息。
            const lastAssistant = [...msgs].reverse().find((item) => item.role === "assistant");
            if (lastAssistant) lastAssistant.blocks.push({
              type: "tool", id: histId(), name: m.toolName || "tool result", input: "",
              output, result: output, done: true, isError: !!m.isError, expanded: false, duration: null,
            });
          }
          continue;
        }
        if (role !== "assistant" && role !== "user") continue;
        let text = "";
        const blocks = [];
        const images = [];
        if (typeof m.content === "string") text = m.content;
        else if (Array.isArray(m.content)) {
          for (const b of m.content) {
            if (b.type === "text" || b.type === "input_text") text += (text ? "\n" : "") + (b.text || b.content || "");
            else if (b.type === "image" || b.type === "input_image") {
              const src = historyImageData(b);
              if (src) images.push(src);
            } else if (b.type === "thinking") blocks.push({ type: "thinking", text: b.thinking || "" });
            else if (b.type === "toolCall") {
              const callId = b.id || b.toolCallId || histId();
              const rawInput = b.input ?? b.arguments ?? b.params ?? "";
              const input = typeof rawInput === "string" ? rawInput : JSON.stringify(rawInput, null, 2);
              const block = {
                type: "tool", id: callId, name: b.toolName || b.name || "tool", input,
                output: "", result: "", done: false, isError: false, expanded: false, duration: null,
              };
              blocks.push(block);
              toolBlocks.set(callId, block);
            }
          }
        }
        // 若 assistant 有纯文本且没有 text block，追加为文本块；用户消息仍保留原始文本。
        if (role === "assistant" && text && !blocks.some((b) => b.type === "text")) blocks.push({ type: "text", text });
        const displayText = role === "user" ? cleanPersistedMessage(text) : text;
        const currentDocMatch = text.match(/当前(?:打开|工作)文件:\s*([^\]\n]+)/);
        msgs.push({
          id: e.id, role, text: displayText, images, blocks, references: historyReferences(text),
          currentDoc: currentDocMatch?.[1]?.trim() || null, status: "done", createdAt: entryCreatedAt(e, m),
        });
      }
      const runMessages = [...(runData?.runs || [])]
        .filter((run) => run?.status)
        .filter((run, index, list) => list.findIndex((item) => item.id === run.id) === index)
        .sort((a, b) => String(a.startedAt || "").localeCompare(String(b.startedAt || "")))
        .map((run, index, list) => ({
          id: `run-summary-${run.id}`,
          role: "system",
          text: run.summary || (run.status === "running" ? "本轮任务仍在执行中" : `本轮任务${run.status === "failed" ? "失败" : run.status === "cancelled" ? "已取消" : "完成"}，处理 ${run.artifacts?.length || 0} 个文件`),
          products: (run.artifacts || []).map((a) => a.path).filter(Boolean),
          artifacts: run.artifacts || [],
          runId: run.id,
          runStatus: run.status,
          references: run.references || [],
          task: run.task || null,
          status: run.status === "running" ? "streaming" : "done",
          summary: true,
          runIndex: index + 1,
          runCount: list.length,
          runMode: run.task?.mode || "agent",
          // 完成语义：显式 complete_task 或服务端推断结果
          completion: run.completion || null,
          eventCount: Array.isArray(run.events) ? run.events.length : 0,
          events: Array.isArray(run.events) ? run.events.map((event, eventIndex) => ({
            ...event,
            key: `history:${run.id}:${event.seq || eventIndex}`,
          })) : [],
          expanded: true,
          createdAt: run.finishedAt || run.startedAt || null,
        }));
      // Run 总结按完成/开始时间插回原始消息流。之前把所有 Run 总结直接
      // append 到消息末尾，恢复会话后就会出现“对话一坨、产物一坨”。
      const loadedHistory = normalizeHistoryMessages([...msgs, ...runMessages].sort((a, b) => {
        const left = Date.parse(a.createdAt || "") || 0;
        const right = Date.parse(b.createdAt || "") || 0;
        return left - right;
      }));
      sessionHistoryCacheRef.current.set(session.id, loadedHistory);
      sessionHistoryMetaRef.current.set(session.id, d.info?.historyHasMore ? {
        total: Number(d.info.historyTotal || 0),
        start: Number(d.info.historyStart || 0),
        end: Number(d.info.historyEnd || 0),
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
      // 从消息里解析会话关联的文件，尝试打开
      const fileMatch = msgs.find((m) => m.role === "user" && m.text && m.text.includes("当前打开文件"));
      if (fileMatch) {
        const fn = fileMatch.text.match(/当前打开文件:\s*([^\]\n]+)/);
        if (fn?.[1]) {
          // 历史文本先显示，关联文档在后台打开，不再阻塞会话切换。
          // 交互 9：必须显式传本次恢复后的工作区——setCurrentWorkspace 还没让
          // 正在执行的 open 闭包看到新值，否则跨工作区会在旧目录取同名文件或 404。
          void open(fn[1].trim(), conversationId, resumedWorkspace || undefined).catch(() => {});
        }
      }
    } catch (e) {
      if (loadSeq === sessionLoadSeqRef.current) notifyError("加载会话失败: " + e.message);
    }
  }, [clientId, currentWorkspace, open, refreshProjects]);

  // 重试恢复当前历史会话的 Agent：成功后才允许继续对话。
  const retrySessionResume = useCallback(async (silentFlag) => {
    const silent = silentFlag === true; // onClick 会把事件对象当首参传入，仅显式 true 才算静默
    const targetId = sessionResumeError?.sessionId || currentSessionId;
    if (!targetId) return;
    const conversationId = threadId || targetId;
    if (!silent) setSessionResumeRetrying(true);
    try {
      await resumeAgentThread(clientId, conversationId, targetId, currentWorkspace);
      setSessionResumeError(null);
    } catch (error) {
      setSessionResumeError({
        sessionId: targetId,
        message: error.message || "Agent 会话恢复失败",
        code: error.code || "",
        detail: error.detail || null,
      });
    }
    if (!silent) setSessionResumeRetrying(false);
  }, [clientId, currentSessionId, currentWorkspace, sessionResumeError, threadId]);

  // A2（OAW_RESUME_AUTO_RETRY，默认关）：恢复遇忙（SESSION_BUSY）时自动等待任务结束后重试，
  // 上限 10 分钟；等待时长在横幅展示，并提供"取消当前任务"直达入口。
  const resumeWaitStartRef = useRef(0);
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

  const handleForkSession = useCallback(async (id, label) => {
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

  const handlePinSession = useCallback(async (id, pinned) => {
    await pinSession(id, pinned);
    await refreshSessions();
  }, [refreshSessions]);

  const handleDeleteSession = useCallback(async (id) => {
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

  const handleBatchDeleteSessions = useCallback(async (ids) => {
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

  const handleRenameSession = useCallback(async (id, label) => {
    await renameSession(id, label);
    await refreshSessions();
  }, [refreshSessions]);

  const handleFreezeSession = useCallback(async (id, frozen) => {
    await freezeSession(id, frozen);
    await refreshSessions();
  }, [refreshSessions]);

  const handleOpenRun = useCallback((run) => {
    const id = run?.sessionId || run?.threadId;
    if (!id) return;
    return handleSelectSession({
      id,
      threadId: run.threadId || id,
      cwd: run.cwd || currentWorkspace,
      projectId: run.projectId || currentProject?.id || null,
      title: run.task?.goal || "任务对应会话",
      label: run.task?.goal || "任务对应会话",
    });
  }, [currentProject?.id, currentWorkspace, handleSelectSession]);

  const handleFileChanged = useCallback((changed) => {
    const changedPaths = new Set((Array.isArray(changed) ? changed : []).map((item) => String(item || "").replace(/\\/g, "/")));
    refreshFiles();
    const active = tabs.find((t) => (t.id || t.name) === activeTab);
    if (active && changedPaths.has(String(active.name).replace(/\\/g, "/"))) {
      // 添加延迟避免与 agent_end 竞态
      setTimeout(() => {
        open(active.name, undefined, active.identity?.cwd || active.identity?.workspaceId || currentWorkspace);
      }, 100);
    }
  }, [activeTab, tabs, currentWorkspace, refreshFiles, open]);

  // 暴露 refreshSessions 给 ChatPanel（agent_end 时刷新）
  const handleAgentEnd = useCallback(() => {
    // 添加延迟让文件变更事件先处理
    setTimeout(() => {
      refreshSessions();
    }, 200);
  }, [refreshSessions]);

  // 一轮任务以 run_finished 为权威结束点：刷新产物列表，并自动打开本轮首个产物。
  // 用 runId 去重，避免 SSE 重连回放导致同一个文件重复打开或反复刷新。
  // B02：自动打开预览的策略来自外观设置（共享订阅，改设置立即生效）
  const appearance = useAppearance();
  const previewAutoOpen = appearance.previewAutoOpen;

  // B03：结果卡的交付入口 → 右栏对应页签（带 runId，保证“本轮”语义）
  const openChangesForRun = useCallback((runId = "") => {
    setChangesRunId(String(runId || ""));
    setPreviewOpen(true);
    setWorkspaceTabPref("preview");
    setPreviewTab("changes");
  }, []);
  const openArtifactsForRun = useCallback((runId = "") => {
    setChangesRunId(String(runId || ""));
    setArtifactScope(runId ? "run" : "session");
    setPreviewOpen(true);
    setWorkspaceTabPref("preview");
    setPreviewTab("artifacts");
  }, []);

  const handleRunFinished = useCallback((result = {}) => {
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
      .map((item) => typeof item === "string" ? { path: item } : item)
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
    // 用户 10s 内手动切换过页签视为锁定，不抢用户主动权。
    if (flag("autoTab") && artifacts.length && Date.now() - previewTabManualAtRef.current > 10000) {
      openArtifactsForRun(runId);
      return;
    }
    const firstArtifact = artifacts[0];
    if (!firstArtifact) return;
    // B02 自动打开预览：never 从不；deliverable 仅通过验收的交付文件；requested 本轮有产物就打开
    if (previewAutoOpen === "never") return;
    if (previewAutoOpen === "deliverable") {
      const acceptanceStatus = String(firstArtifact.acceptanceStatus || firstArtifact.acceptance?.status || "");
      if (!["passed", "warning", "manual_review"].includes(acceptanceStatus)) return;
    }
    setPreviewOpen(true);
    setWorkspaceTabPref("preview");
    setPreviewTab("document");
    void open(firstArtifact.path, result.threadId || threadId, result.cwd || currentWorkspace);
  }, [currentWorkspace, open, previewAutoOpen, threadId]);

  // 关闭右预览后把焦点还给顶栏的预览开关，键盘用户不丢位置（对应计划 4.2 面板/命令入口）
  const closePreview = useCallback(() => {
    setPreviewLayout(0);
    setPreviewOpen(false);
    requestAnimationFrame(() => previewToggleRef.current?.focus());
  }, []);
  // P1-8 对象栏关闭：与关闭预览同样把焦点还给顶栏入口，键盘用户不丢位置。
  const closeObjects = useCallback(() => {
    setObjectsOpenState(false);
    requestAnimationFrame(() => previewToggleRef.current?.focus());
  }, []);
  // M4.4 领域工作流面板关闭：同上，焦点还给顶栏入口。
  const closeWorkflows = useCallback(() => {
    setWorkflowsOpenState(false);
    requestAnimationFrame(() => previewToggleRef.current?.focus());
  }, []);
  // 顶栏整合菜单：点击外部 / Escape 关闭
  useEffect(() => {
    if (!topbarMenuOpen) return undefined;
    const onPointerDown = (event) => {
      if (!topbarToolsRef.current?.contains(event.target)) setTopbarMenuOpen(false);
    };
    const onKeyDown = (event) => { if (event.key === "Escape") setTopbarMenuOpen(false); };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [topbarMenuOpen]);
  useEffect(() => () => { if (changedFilesTimerRef.current) window.clearTimeout(changedFilesTimerRef.current); }, []);

  // ChatPanel 上报 pi 会话 id → 持久化（刷新后恢复当前对话）
  const handleSessionChange = useCallback((id) => {
    if (id) setCurrentSessionId(id);
  }, []);

  // ===== 界面状态固化（localStorage）=====
  const [uiRestored, setUiRestored] = useState(false); // 恢复是否完成（完成后才允许保存）
  const restoredSessionRef = useRef(false); // 会话恢复只执行一次
  // 上次会话 id 缓存：刷新后会话恢复前，保存逻辑不覆盖 lastSessionId（避免恢复竞态）
  const lastSessionIdRef = useRef(null);
  useEffect(() => {
    lastSessionIdRef.current = loadUIState()?.lastSessionId || null;
  }, []);

  // 恢复：只恢复工作区与必要的视图偏好。
  // 已批准规则（交接文档交互 4）：刷新/服务重启后停留在工作区根目录的空白新会话，
  // 不自动恢复旧子目录、旧会话或旧文件；历史会话与旧文件只走手动入口。
  useEffect(() => {
    if (uiRestored) return;
    if (!currentWorkspace) return; // 等待工作区列表就绪
    const saved = loadUIState();
    if (!saved) { setUiRestored(true); return; }
    (async () => {
      try {
        if (saved.workspace && !sameWorkspacePath(saved.workspace, currentWorkspace)) {
          const switched = await switchWorkspace(saved.workspace);
          setCurrentWorkspace(switched.workspace);
          setFiles(switched.files || []);
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
    const probe = async () => {
      if (cancelled || restoredRunProbedRef.current || !flag("replayRecover")) return;
      restoredRunProbedRef.current = true;
      const savedThreadId = localStorage.getItem("oaw_thread_id") || "";
      if (!savedThreadId) return;
      try {
        const result = await listRuns(savedThreadId, 5, { cwd: currentWorkspace || undefined });
        if (cancelled) return;
        const live = (result?.runs || []).find((item) => ["running", "queued", "waiting_user", "recovering", "cancel_requested", "finishing"].includes(item?.status));
        if (live) setRestoredRunHint({ threadId: savedThreadId });
      } catch {}
    };
    void probe();
    // 开关快照异步到达（初始全关）：就绪后再探测一次
    let off = false;
    flagsReady.then(() => { if (!off && !cancelled) void probe(); });
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
  }, [tabs, activeTab, activeModule, currentWorkspace, currentDir, sidebarOpen, currentSessionId, uiRestored]);

  const sharedChatPanel = (
      <ChatPanel
      ref={chatInputRef}
      clientId={clientId}
      threadId={threadId}
      workspace={currentWorkspace}
      project={currentProject}
      frozen={Boolean(currentSession?.frozen)}
      // 阶段 4：地图模式下用紧凑呈现（地图是主角，对话是辅助）。
      // 只影响视觉密度与能力预览折叠块，不动消息流、SSE 与工具栏功能。
      compact={activeModule === "map"}
      onFileChanged={(changed) => {
        handleFileChanged(changed);
        mapBridgeRef.current?.onFileChanged?.(changed);
      }}
      onMapAction={(action) => mapBridgeRef.current?.onMapAction?.(action)}
       currentDoc={activeModule === "map" ? `地图项目:${currentMapProject}` : current?.name}
       mapContext={activeModule === "map" ? currentMapContext : null}
       mapProject={activeModule === "map" ? currentMapProject : null}
      models={models}
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
      onOpenSubagent={openSubagentDetail}
      onSubagentUpdate={handleSubagentUpdate}
      onModeChange={setConversationMode}
      onPhaseChange={setConversationPhase}
      onBrowserActivity={handleBrowserActivity}
      historyMessages={historyMessages}
      historyThreadId={historyThreadId}
      historyWindow={historyWindow}
      onNewSession={() => handleNewSession()}
      onOpenFile={handleChatOpenFile}
      referenceFiles={files.map((file) => currentDir ? currentDir + "/" + file.name : file.name)}
      sessions={visibleSessions}
      onSelectSession={handleSelectSession}
      onSessionChange={handleSessionChange}
      onRefreshSessions={refreshSessions}
      onDeleteSession={handleDeleteSession}
      onBatchDeleteSession={handleBatchDeleteSessions}
      unreadByThread={unreadByThread}
      onForkSession={handleForkSession}
      onPinSession={handlePinSession}
      onFreezeSession={handleFreezeSession}
    />
  );

  return (
    <AppErrorBoundary>
      <div className={`app ${previewLayout === 1 ? "preview-half" : previewLayout === 2 ? "preview-maximized" : ""} ${browserFullscreen ? "browser-fullscreen" : ""} ${sidebarOpen ? "sidebar-expanded" : "sidebar-collapsed"}`}>
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
        {activeModule === "knowledge" && (
          <DeferredModule label="知识库">
          <KnowledgeBase
            clientId={clientId}
            workspace={currentWorkspace}
            project={currentProject}
            models={models}
            defaultModel={defaultModel}
            onPromoteToAgent={handlePromoteToAgent}
            onExit={(marks) => {
              closeExternalModules();
              if (marks?.length) {
                setTimeout(() => {
                  for (const m of marks) chatInputRef.current?.insertText(m + " ");
                }, 120);
              }
            }}
            onAtMention={insertChatText}
          />
          </DeferredModule>
        )}
        {activeModule === "templates" && (
          <DeferredModule label="模板库">
          <TemplateLibrary
            onExit={(marks) => {
              // 返回时统一把累积的 @标记 插入对话（支持一次多个）
              closeExternalModules();
              if (marks?.length) {
                setTimeout(() => {
                  for (const m of marks) insertChatText(m);
                }, 120);
              }
            }}
            onOpenFile={open}
            onAtMention={insertChatText}
          />
          </DeferredModule>
        )}
        {activeModule === "map" && (
          <DeferredModule label="地图">
          <MapPanel
            onExit={closeExternalModules}
            onOpenFile={open}
            clientId={clientId}
            threadId={threadId}
            workspace={currentWorkspace}
            models={models}
            defaultModel={defaultModel}
            onAgentEnd={handleAgentEnd}
            onNewSession={() => handleNewSession()}
            historyMessages={historyMessages}
            sessions={visibleSessions}
            currentSessionId={currentSessionId}
            onSelectSession={handleSelectSession}
            onSessionChange={handleSessionChange}
            onRefreshSessions={refreshSessions}
            onFocusRun={(run) => chatInputRef.current?.focusRun?.(run?.id)}
            onProjectChange={(name) => setMapContexts((prev) => ({ ...prev, [threadId]: { ...(prev[threadId] || {}), mapProject: name } }))}
            conversationMode={conversationMode}
            onModeChange={(next) => {
              // 与主对话的模式切换同源：先让 ChatPanel 真正切模式，成功后再更新状态，
              // 避免"按钮变了但 Agent 还是旧模式"。
              const switched = chatInputRef.current?.setMode?.(next);
              if (switched !== false) setConversationMode(next);
            }}
            hideChat
            chatVisible={mapChatVisible}
            onToggleChat={() => setMapChatVisible((value) => !value)}
            bridgeRef={mapBridgeRef}
            onViewportChange={(context) => setMapContexts((prev) => ({ ...prev, [threadId]: context }))}
            // 阶段 2：可视面板的"交给 Agent"把意图填进全局对话栏输入框（复用同一实例，消息流连续）
            insertChatText={insertChatText}
          />
          </DeferredModule>
        )}
        {activeModule === "map" && mapChatVisible && (
          <div className="app-chat-slot map">
            {sharedChatPanel}
          </div>
        )}
        {activeModule === "map" && mapChatVisible && (
          <Resizer
            className="map-chat-resizer"
            side="right"
            min={300}
            max={620}
            cssVar="--map-chat-w"
          />
        )}
        {!["knowledge", "templates", "map"].includes(activeModule) && (
        <>
        {sidebarOpen && (
          <>
            <SessionSidebar
              files={files}
              currentName={current?.name}
              onOpenFile={open}
              onRefreshFiles={refreshFiles}
              onUploaded={refreshFiles}
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
              onProjectUpdated={refreshProjects}
              models={models}
              clientId={clientId}
              threadId={threadId}
              activeModel={selectedModel}
              onModelChange={setSelectedModel}
              sessions={sessions}
              unreadByThread={unreadByThread}
              onSelectSession={handleSelectSession}
              onRefreshSessions={refreshSessions}
              onDeleteSession={handleDeleteSession}
              onBatchDeleteSession={handleBatchDeleteSessions}
              onRenameSession={handleRenameSession}
              onForkSession={handleForkSession}
              onPinSession={handlePinSession}
              onFreezeSession={handleFreezeSession}
              onOpenSkills={() => openExternalModule("skills")}
              onOpenAgents={() => openExternalModule("agents")}
              onOpenKnowledgeBase={() => openExternalModule("knowledge")}
              onOpenTemplates={() => openExternalModule("templates")}
              onOpenMap={() => openExternalModule("map")}
               onOpenTasks={() => openExternalModule("tasks")}
               onOpenMcp={() => openExternalModule("mcp")}
               onOpenPiPlugins={() => openExternalModule("piPlugins")}
               onOpenSettings={(tab = "settings") => { if (tab === "memory") setSettingsModuleTab("memory"); else { setSettingsModuleTab("settings"); setSettingsSection(tab === "project" ? "project" : "model"); } openExternalModule("settings"); }}
               onOpenArtifacts={() => openExternalModule("artifacts")}
              onBeforeOpenModal={closeExternalModules}
              onOpenCommandPalette={() => setPaletteOpen(true)}
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
              {current?.name && <span className="topbar-file"> · {current.name}</span>}
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
            <div className="topbar-tools" ref={topbarToolsRef}>
              <button
                ref={previewToggleRef}
                className={`btn-sm topbar-tools-toggle ${topbarMenuOpen ? "active" : ""}`}
                onClick={() => setTopbarMenuOpen((v) => !v)}
                title="工作区工具：新建对话 / 工作产物 / 内置浏览器 / 任务中心"
                aria-label="工作区工具"
                aria-expanded={topbarMenuOpen}
                aria-haspopup="menu"
              >
                <Icon name="more" size={14} />
                {Object.values(unreadByThread).reduce((sum, count) => sum + Number(count || 0), 0) > 0 && <i className="topbar-tools-dot" aria-hidden="true" />}
              </button>
              {topbarMenuOpen && (
                <div className="topbar-tools-menu" role="menu" aria-label="工作区工具菜单">
                  <button role="menuitem" onClick={() => { setTopbarMenuOpen(false); handleNewSession(); }} disabled={creatingSession} title="新建对话">
                    <Icon name="chatPlus" size={14} /><span>新建对话</span>
                  </button>
                  <button role="menuitemcheckbox" aria-checked={previewOpen && workspaceTab === "preview"} className={previewOpen && workspaceTab === "preview" ? "on" : ""} onClick={() => { if (previewOpen) setPreviewLayout(0); else setWorkspaceTabPref("preview"); setPreviewOpen((v) => !v); }} title={previewOpen && workspaceTab === "preview" ? "隐藏工作产物画布" : "显示工作产物画布"}>
                    <Icon name="package" size={14} /><span>工作产物</span>
                  </button>
                  <button role="menuitemcheckbox" aria-checked={browserPanelOpen} className={browserPanelOpen ? "on" : ""} onClick={() => { if (browserPanelOpen) closeBrowserPanel(); else { browserAutoOpenBlockedRef.current = false; if (flag("narrowRestore") && typeof window !== "undefined" && window.innerWidth <= 1024 && previewOpenRef.current) previewOpenBeforeBrowserRef.current = true; setBrowserActivityPing(0); setWorkspaceTabPref("browser"); setBrowserPanelOpen(true); } }} title={browserPanelOpen ? "隐藏内置浏览器" : "显示内置浏览器"}>
                    <Icon name="globe" size={14} /><span>内置浏览器</span>{browserActivityPing > 0 && !browserPanelOpen && <i className="browser-activity-dot" aria-hidden="true" />}
                  </button>
                  {flag("qoderObjectBar") && (
                    <button role="menuitemcheckbox" aria-checked={objectsOpen} className={objectsOpen ? "on" : ""} onClick={() => { setWorkspaceTabPref("objects"); setObjectsOpenState((value) => !value); }} title={objectsOpen ? "隐藏对象栏" : "显示对象栏：本轮产出 / 来源 / 技能 / 记忆汇总"}>
                      <Icon name="layers" size={14} /><span>对象栏</span>
                    </button>
                  )}
                  {flag("domainWorkflows") && (
                    <button role="menuitemcheckbox" aria-checked={workflowsOpen} className={workflowsOpen ? "on" : ""} onClick={() => { setWorkspaceTabPref("workflows"); setWorkflowsOpenState((value) => !value); }} title={workflowsOpen ? "隐藏领域工作流" : "显示领域工作流：交通规划工作流的阶段 / 工具白名单 / 预算 / 产物契约与预检试算"}>
                      <Icon name="flow" size={14} /><span>领域工作流</span>
                    </button>
                  )}
                  <button role="menuitem" onClick={() => { setTopbarMenuOpen(false); taskCenterRef.current?.open(); }} title="任务中心：并行任务、运行状态与历史会话">
                    <Icon name="list" size={14} /><span>任务中心</span>
                  </button>
                </div>
              )}
              <TaskCenter
                ref={taskCenterRef}
                sessions={visibleSessions}
                projects={projects}
                currentProjectId={currentProject?.id || ""}
                currentWorkspace={currentWorkspace}
                currentThreadId={threadId}
                currentSessionId={currentSessionId}
                unreadCount={Object.values(unreadByThread).reduce((sum, count) => sum + Number(count || 0), 0)}
                onSelectSession={handleSelectSession}
                onFocusRun={(run) => chatInputRef.current?.focusRun?.(run?.id)}
                onOpenRun={handleOpenRun}
                eventVersion={eventVersion}
                anchorRef={previewToggleRef}
                hideTrigger
              />
            </div>
            </div>
            {!activeModule && sessionResumeError && (
              <div className="session-resume-warning" role="alert">
                <Icon name="warning" size={14} />
                <span>
                  历史已加载为只读：Agent 会话恢复失败（{sessionResumeError.message}），继续对话前请先重试恢复。
                  {sessionResumeError.code === "SESSION_BUSY" && flag("resumeAutoRetry") && (
                    <> 已等待 {resumeWaitSec}s，当前任务结束后将自动恢复{sessionResumeError.detail?.busyForMs ? `（任务已运行 ${Math.round(sessionResumeError.detail.busyForMs / 1000)}s）` : ""}。</>
                  )}
                </span>
                {sessionResumeError.code === "SESSION_BUSY" && sessionResumeError.detail?.activeRunId && (
                  <button className="btn-xs" onClick={async () => { try { await cancelRun(sessionResumeError.detail.activeRunId, "用户请求取消以恢复会话"); } catch {}}}>取消当前任务</button>
                )}
                <button className="btn-xs" onClick={() => retrySessionResume()} disabled={sessionResumeRetrying}>{sessionResumeRetrying ? "恢复中…" : "重试恢复"}</button>
              </div>
            )}
            {/* 交互 2：新建失败必须可见。旧实现只 console.warn，界面照常清空，
                用户以为已建好新会话。现在保留旧会话与草稿，并给出重试入口。 */}
            {!activeModule && newSessionError && (
              <div className="session-resume-warning" role="alert">
                <Icon name="warning" size={14} />
                <span>新建会话失败：{newSessionError.message}（已保留当前会话与未发送内容）</span>
                <button className="btn-xs" onClick={() => handleNewSession()} disabled={creatingSession}>{creatingSession ? "创建中…" : "重试新建"}</button>
                <button className="btn-xs" onClick={() => setNewSessionError(null)}>忽略</button>
              </div>
            )}
            {/* 交互 8：工作区切换失败保留原目录与列表，说明失败原因并允许重试。 */}
            {!activeModule && workspaceSwitchError && (
              <div className="session-resume-warning" role="alert">
                <Icon name="warning" size={14} />
                <span>切换工作区失败：{workspaceSwitchError.message}（已保留原工作区与文件列表）</span>
                <button className="btn-xs" onClick={() => { const target = workspaceSwitchError.workspace; setWorkspaceSwitchError(null); handleWorkspaceChange(target); }}>重试切换</button>
                <button className="btn-xs" onClick={() => setWorkspaceSwitchError(null)}>忽略</button>
              </div>
            )}
            {/* OAW_REPLAY_RECOVER（F2，默认关）：运行中刷新后提示可加载完整历史（复用现有横幅样式，零新样式） */}
            {!activeModule && restoredRunHint && (
              <div className="session-resume-warning" role="status">
                <Icon name="warning" size={14} />
                <span>检测到该会话仍有任务在执行，实时进度已恢复；可加载该会话的完整历史上下文。</span>
                <button className="btn-xs" onClick={() => {
                  const target = sessions.find((s) => (s.threadId || s.id) === restoredRunHint.threadId);
                  setRestoredRunHint(null);
                  if (target) handleSelectSession(target);
                }}>加载完整历史</button>
                <button className="btn-xs" onClick={() => setRestoredRunHint(null)}>忽略</button>
              </div>
            )}
            <div className="center-chat-slot">{!activeModule && sharedChatPanel}</div>
          </div>
        </div>
        {previewOpen && workspaceTab === "preview" && <Resizer side="right" min={280} max={680} cssVar="--preview-w" />}
        {objectsOpen && workspaceTab === "objects" && <Resizer side="right" min={260} max={620} cssVar="--objects-w" />}
        {workflowsOpen && workspaceTab === "workflows" && <Resizer side="right" min={280} max={720} cssVar="--workflows-w" />}
        {(previewOpen || browserPanelOpen || objectsOpen || workflowsOpen) && (
          <aside className={`app-canvas-slot ${workspaceTab === "browser" ? "canvas-tab-browser" : workspaceTab === "objects" ? "canvas-tab-objects" : workspaceTab === "workflows" ? "canvas-tab-workflows" : "canvas-tab-preview"}`}>
            <div className="preview-panel-head app-canvas-head">
              <div className="app-canvas-tabs" role="tablist" aria-label="工作区画布">
                <button
                  role="tab"
                  aria-selected={workspaceTab === "preview"}
                  className={workspaceTab === "preview" ? "active" : ""}
                  onClick={() => { previewTabManualAtRef.current = Date.now(); setPreviewOpen(true); setWorkspaceTabPref("preview"); }}
                  title="工作产物：文件预览 / 改动 / 产物"
                >
                  <Icon name="package" size={13} /> 工作产物
                </button>
                <button
                  role="tab"
                  aria-selected={workspaceTab === "browser"}
                  className={workspaceTab === "browser" ? "active" : ""}
                  onClick={() => { setBrowserActivityPing(0); setBrowserPanelOpen(true); setWorkspaceTabPref("browser"); }}
                  title="内置浏览器"
                >
                  <Icon name="globe" size={13} /> 浏览器
                  {browserActivityPing > 0 && workspaceTab !== "browser" && <i className="browser-activity-dot" aria-hidden="true" />}
                </button>
                {flag("qoderObjectBar") && (
                  <button
                    role="tab"
                    aria-selected={workspaceTab === "objects"}
                    className={workspaceTab === "objects" ? "active" : ""}
                    onClick={() => { setWorkspaceTabPref("objects"); setObjectsOpenState(true); }}
                    title="对象栏：本轮产出 / 来源 / 技能 / 记忆汇总"
                  >
                    <Icon name="layers" size={13} /> 对象
                  </button>
                )}
                {flag("domainWorkflows") && (
                  <button
                    role="tab"
                    aria-selected={workspaceTab === "workflows"}
                    className={workspaceTab === "workflows" ? "active" : ""}
                    onClick={() => { setWorkspaceTabPref("workflows"); setWorkflowsOpenState(true); }}
                    title="领域工作流：阶段 / 工具白名单 / 预算 / 产物契约与预检试算"
                  >
                    <Icon name="flow" size={13} /> 工作流
                  </button>
                )}
              </div>
              <span className="preview-panel-actions">
                {workspaceTab === "preview" ? (
                  <>
                    <button
                      className="btn-icon preview-layout-button"
                      onClick={() => setPreviewLayout((value) => (value + 1) % 3)}
                      title={`工作产物布局：${previewLayout === 0 ? "默认" : previewLayout === 1 ? "50%" : "100%"}，点击切换`}
                      aria-label={`工作产物布局：${previewLayout === 0 ? "默认" : previewLayout === 1 ? "50%" : "100%"}，点击切换`}
                    >
                      <Icon name={previewLayout === 2 ? "minimize" : "maximize"} size={14} />
                      <span className="preview-layout-label">{previewLayout === 0 ? "默认" : `${previewLayout * 50}%`}</span>
                    </button>
                    <button className="btn-icon" onClick={closePreview} title="隐藏工作产物" aria-label="隐藏工作产物"><Icon name="close" size={14} /></button>
                  </>
                ) : workspaceTab === "objects" ? (
                  <button className="btn-icon" onClick={closeObjects} title="隐藏对象栏" aria-label="隐藏对象栏"><Icon name="close" size={14} /></button>
                ) : workspaceTab === "workflows" ? (
                  <button className="btn-icon" onClick={closeWorkflows} title="隐藏领域工作流" aria-label="隐藏领域工作流"><Icon name="close" size={14} /></button>
                ) : (
                  <>
                    <button
                      className="btn-icon"
                      onClick={() => setBrowserFullscreen((value) => !value)}
                      title={browserFullscreen ? "退出浏览器全屏" : "浏览器铺满工作区"}
                      aria-label={browserFullscreen ? "退出浏览器全屏" : "浏览器铺满工作区"}
                    >
                      <Icon name={browserFullscreen ? "minimize" : "maximize"} size={14} />
                    </button>
                    <button className="btn-icon" onClick={closeBrowserPanel} title="隐藏内置浏览器" aria-label="隐藏内置浏览器"><Icon name="close" size={14} /></button>
                  </>
                )}
              </span>
            </div>
            {/* 两个页签体都保持挂载、用 CSS 显隐：切换不卸载，DocViewer/浏览器状态零丢失 */}
            {previewOpen && (
              <div className={`app-canvas-body canvas-body-preview ${workspaceTab === "preview" ? "" : "canvas-hidden"}`}>
                <div className="preview-panel-tabs">
                  {[['document', '预览'], ['changes', '改动'], ['artifacts', '产物'], ...(subagentDetail ? [['subagent', '子代理']] : [])].map(([id, label]) => (
                    <button key={id} className={previewTab === id ? "active" : ""} onClick={() => { previewTabManualAtRef.current = Date.now(); setPreviewTab(id); }}>{label}</button>
                  ))}
                </div>
                <WorkProductPanel
                  tab={previewTab === "document" ? "document" : previewTab}
                  clientId={clientId}
                  threadId={threadId}
                  workspace={currentWorkspace}
                  projectId={currentProject?.id || ""}
                  currentSessionId={currentSessionId}
                  selectedRunId={changesRunId}
                  artifactScope={artifactScope}
                  onArtifactScopeChange={setArtifactScope}
                  refreshToken={artifactVersion}
                  onOpenFile={open}
                  subagentBlock={subagentDetail}
                >
                  <Suspense fallback={<div className="module-loading">正在加载文档预览…</div>}>
                    <DocViewer
                      tabs={tabs}
                      activeTab={activeTab}
                      onSwitchTab={(n) => setActiveTab(n)}
                      onCloseTab={closeTab}
                      onOpenFile={open}
                      loading={docLoading}
                      onSendToAgent={insertChatText}
                      onInsertContext={(t) => chatInputRef.current?.insertContext(t)}
                    />
                  </Suspense>
                </WorkProductPanel>
              </div>
            )}
            {browserPanelOpen && (
              <div className={`app-canvas-body canvas-body-browser ${workspaceTab === "browser" ? "" : "canvas-hidden"}`}>
                <BrowserPanel clientId={clientId} threadId={threadId} fullscreen={browserFullscreen} onToggleFullscreen={() => setBrowserFullscreen((value) => !value)} />
              </div>
            )}
            {objectsOpen && (
              <div className={`app-canvas-body canvas-body-objects ${workspaceTab === "objects" ? "" : "canvas-hidden"}`}>
                <对象栏
                  workspace={currentWorkspace}
                  projectId={currentProject?.id || ""}
                  model={selectedModel || defaultModel}
                  references={tabs.map((tab) => ({ label: tab.name, kind: "文件" }))}
                  clientId={clientId}
                  threadId={threadId}
                  onClose={closeObjects}
                />
              </div>
            )}
            {workflowsOpen && (
              <div className={`app-canvas-body canvas-body-workflows ${workspaceTab === "workflows" ? "" : "canvas-hidden"}`}>
                <工作流启动器 onClose={closeWorkflows} />
              </div>
            )}
          </aside>
        )}
        {browserPanelOpen && workspaceTab === "browser" && <Resizer side="right" min={340} max={960} cssVar="--browser-w" />}
        <DeferredModule label="技能管理">
        <SkillsManager
          open={activeModule === "skills"}
          fullPage
          onClose={closeExternalModules}
          clientId={clientId}
          workspace={currentWorkspace}
          project={currentProject}
          models={models}
          defaultModel={defaultModel}
          selectedModel={selectedModel}
          onModelChange={setSelectedModel}
          onPromoteToAgent={handlePromoteToAgent}
          onAtMention={(value) => insertChatText(String(value || "").startsWith("@") ? value : `@${value}`)}
        />
        </DeferredModule>
        <DeferredModule label="智能体广场">
        <AgentMarket
          open={activeModule === "agents"}
          fullPage
          onClose={closeExternalModules}
          onAtMention={insertChatText}
          onPromoteToAgent={handlePromoteToAgent}
          workspace={currentWorkspace}
        />
        </DeferredModule>
        <DeferredModule label={activeModule === "mcp" ? "MCP" : "Pi 插件"}>
        <IntegrationsCenter kind={activeModule === "mcp" ? "mcp" : "pi"} open={activeModule === "mcp" || activeModule === "piPlugins"} onClose={closeExternalModules} />
        </DeferredModule>
        </>
        )}
        {/* 重复入口已整合：预览/浏览器的唯一开关在顶栏，打开内容统一进入右侧画布页签 */}
         <DeferredModule label="命令面板">
        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          onOpenFile={open}
          onKb={() => openExternalModule("knowledge")}
          onTpl={() => openExternalModule("templates")}
          onMap={() => openExternalModule("map")}
          onSession={handleSelectSession}
        />
         </DeferredModule>
         {activeModule === "settings" && (
           <div className="module-view">
             <div className="module-head">
               <button className="module-back" onClick={closeExternalModules} title="返回对话"><Icon name="back" size={15} /></button>
               <div className="module-brand-heading"><Logo size={22} /><span><h2>设置</h2><p>外观、模型、项目运行和工作区记忆</p></span></div>
               <div className="module-head-tabs">
                 <button className={settingsModuleTab === "settings" ? "active" : ""} onClick={() => setSettingsModuleTab("settings")}>设置</button>
                 <button className={settingsModuleTab === "memory" ? "active" : ""} onClick={() => setSettingsModuleTab("memory")}>记忆与沉淀</button>
               </div>
             </div>
             <div className="module-body module-settings-body">
               {settingsModuleTab === "memory"
                 ? <MemoryTab workspace={currentWorkspace} projectId={currentProject?.id || ""} />
                 : <SettingsPanel project={currentProject} projects={projects} currentWorkspace={currentWorkspace} models={models} defaultModel={defaultModel} activeModel={selectedModel} clientId={clientId} threadId={threadId} initialSection={settingsSection} onModelChange={setSelectedModel} onModelsRefresh={refreshModelCatalog} onProjectUpdated={refreshProjects} onProjectSelect={(id) => { closeExternalModules(); handleProjectChange(id); }} />}
             </div>
           </div>
         )}
         {activeModule === "artifacts" && (
           <div className="module-view">
             <div className="module-head">
               <button className="module-back" onClick={closeExternalModules} title="返回对话"><Icon name="back" size={15} /></button>
               <div className="module-brand-heading"><Logo size={22} /><span><h2>成果</h2><p>查看、验收、固定和回滚工作产物</p></span></div>
             </div>
             <div className="module-body module-artifacts-body">
               <WorkProductPanel tab="artifacts" clientId={clientId} threadId={threadId} workspace={currentWorkspace} projectId={currentProject?.id || ""} currentSessionId={currentSessionId} refreshToken={artifactVersion} onOpenFile={(name, thread, cwd) => { closeExternalModules(); open(name, thread, cwd); }} />
             </div>
           </div>
         )}
         {activeModule === "tasks" && (
           <DeferredModule label="任务中心"><TaskCenter
             fullPage
             onClose={closeExternalModules}
             sessions={visibleSessions}
             projects={projects}
             currentProjectId={currentProject?.id || ""}
             currentWorkspace={currentWorkspace}
             currentThreadId={threadId}
             currentSessionId={currentSessionId}
             unreadCount={Object.values(unreadByThread).reduce((sum, count) => sum + Number(count || 0), 0)}
             onSelectSession={handleSelectSession}
             onFocusRun={(run) => chatInputRef.current?.focusRun?.(run?.id)}
             onOpenRun={handleOpenRun}
             eventVersion={eventVersion}
           /></DeferredModule>
         )}
       </div>
    </AppErrorBoundary>
  );
}
