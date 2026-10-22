import React, { useRef, useState, useEffect, useCallback } from "react";
import { Document, Packer, Paragraph } from "docx";
import {
  uploadFile, deleteFile, fileToBase64, searchFiles, listRuns, listPublishedArtifacts,
  getRunAcceptance, confirmArtifactAcceptance, publishArtifact, rollbackPublishedArtifact,
  validateWorkspace, pickWorkspace, cancelWorkspacePick, listFileRoots, addFileRoot,
  removeFileRoot, pickNativeFiles, openInSystem, revealInSystem, ingestToKb
} from "../api/client-api";
import { sortFiles } from "../lib/FileSorting";
import { artifactTypeInfo } from "../lib/artifact-types";
import {
  RUNNING_SESSION_STATUSES, sameWorkspacePath, samePath, formatTime, shortenCwd, formatSize
} from "../lib/session-list";
import ContextMenu, { type ContextMenuItem } from "./ContextMenu";
import Icon from "./Icon";
import Logo from "./Logo";
import MemoryTab from "./MemoryTab";
import SettingsPanel, { type ModelRecord } from "./SettingsPanel";
import MarqueeText from "./MarqueeText";
import { SessionList, type SessionRecord } from "./SessionList";
import type { RunRecord, RunArtifact, RunAcceptanceInfo } from "../../shared/protocol/channels";
import { notifyError, notifySuccess, askConfirm } from "./Feedback";

/**
 * 侧边栏（F3 批5b-5）：与 client/src/components/SessionSidebar.jsx 逐行等价，对拍强制。
 * 架构性等价替换（BRD-009）：旧组件内联 fetch("/api/kb/ingest") → IPC 通道 op:kb:ingest；
 * 纯函数族（formatTime/shortenCwd/samePath/formatSize/RUNNING_SESSION_STATUSES 等）
 * 自批5b-1 拆出的 lib/session-list.ts 统一复用（旧侧与 SessionList 双份重复定义，等价合并）。
 */

export interface FileRecord {
  name: string;
  isDir?: boolean;
  size?: number;
  mtime?: number | string;
  relPath?: string;
  ext?: string;
  [key: string]: unknown;
}

export interface WorkspaceRecord {
  path: string;
  name: string;
}

export interface ProjectRecord {
  id: string;
  name?: string;
  type?: string;
  status?: string;
  rootPath?: string;
  pendingMemoryCount?: number;
  approvedMemoryCount?: number;
  unresolvedRunCount?: number;
  sessionCount?: number;
  [key: string]: unknown;
}

interface SidebarProps {
  files: FileRecord[];
  currentName: string;
  onOpenFile: (name: string) => void;
  onRefreshFiles: () => void;
  onUploaded: () => void;
  projects?: ProjectRecord[];
  currentProjectId?: string;
  onProjectChange?: (id: string) => void;
  onProjectUpdated?: () => void;
  models?: ModelRecord[];
  clientId?: string;
  threadId?: string;
  activeModel?: string;
  onModelChange?: (model: string) => void;
  workspaces?: WorkspaceRecord[];
  currentWorkspace?: string;
  onWorkspaceChange?: (path: string) => void | Promise<void>;
  currentDir?: string;
  onDirChange?: (dir: string) => void;
  onAtMention?: (filePath: string, isDir?: boolean) => void;
  sessions?: SessionRecordPlus[];
  unreadByThread?: Record<string, number>;
  onSelectSession?: (session: SessionRecord) => void;
  onRefreshSessions?: () => void;
  onDeleteSession?: (id: string) => void | Promise<void>;
  onBatchDeleteSession?: (ids: string[]) => void | Promise<void>;
  onRenameSession?: (id: string, value: string) => void | Promise<void>;
  onForkSession?: (id: string, name: string) => void | Promise<void>;
  onPinSession?: (id: string, pinned: boolean) => void | Promise<void>;
  onFreezeSession?: (id: string, frozen: boolean) => void | Promise<void>;
  onOpenSkills?: () => void;
  onOpenAgents?: () => void;
  onOpenKnowledgeBase?: () => void;
  onOpenTemplates?: () => void;
  onOpenMap?: () => void;
  onOpenTasks?: () => void;
  onOpenMcp?: () => void;
  onOpenPiPlugins?: () => void;
  onOpenSettings?: (section?: string) => void;
  onOpenArtifacts?: () => void;
  onBeforeOpenModal?: () => void;
  onOpenCommandPalette?: () => void;
  onToggleTheme?: () => void;
  theme?: string;
  loadStatus?: Record<string, string> | null;
  changedFiles?: Set<string>;
}

// 问题 6：文件类型表达统一到 artifact-types.js 的单一映射（图标名 + 类型文案），
// 文件树、预览标签、产物卡片、命令面板因此对同一文件给出同一种图形与说法；
// 此前这里另写了一份「彩色字母徽章」，与产物/预览的线性图标互相漂移。
function FileTypeIcon({ file, size = "normal" }: { file: FileRecord | null | undefined; size?: "normal" | "small" }) {
  if (file?.isDir) return <span className="file-type-icon dir" title="文件夹"><Icon name="folder" size={size === "small" ? 11 : 12} /></span>;
  const info = artifactTypeInfo(file?.name || "");
  return (
    <span className={`file-type-icon ${size}`} title={`${info.label}${info.ext ? ` · ${info.ext.toUpperCase()}` : ""}`}>
      <Icon name={info.icon} size={size === "small" ? 11 : 12} />
    </span>
  );
}

// 启动未就绪区域的稳定骨架：静态占位、可被读屏播报，不把"加载中"显示成"空结果"
function SkeletonRows({ rows = 3, label = "正在加载" }: { rows?: number; label?: string }) {
  return (
    <div className="oaw-skeleton" role="status" aria-live="polite" aria-busy="true" aria-label={label}>
      {Array.from({ length: rows }).map((_, index) => (
        <div className="oaw-skeleton-row" key={index} aria-hidden="true">
          <span className="oaw-skeleton-block icon" />
          <span className="oaw-skeleton-block name" />
          <span className="oaw-skeleton-block meta" />
        </div>
      ))}
    </div>
  );
}

interface ArtifactEntry extends RunArtifact {
  run: RunRecord;
}

// 正式成果版本记录：channels 的 RunArtifact 之上补齐发布历史字段（version/status/来源 Run 等）
type PublicationRecord = {
  id?: string;
  artifactId?: string;
  path?: string;
  version?: number | string;
  status?: string;
  sourceRunId?: string;
  runId?: string;
  rollbackTarget?: string;
  diffSummary?: { changeType?: string; [key: string]: unknown };
  [key: string]: unknown;
};

// 宽响应的本地视图：旧 JS 直接消费动态字段，TS 侧在数据边界断言一次，字段访问点保持等价
type ValidateResult = { ok?: boolean; error?: string; writeAccess?: { message?: string } | null };
type PickResult = { ok?: boolean; canceled?: boolean; workspace?: string; error?: string; writeAccess?: { message?: string } | null };
type PickNativeResult = { ok?: boolean; canceled?: boolean; files?: Array<{ insideWorkspace?: boolean; name?: string; path?: string }> };
type OpenResult = { opened?: string };
type CancelPickResult = { cancelled?: boolean };

export interface SessionRecordPlus extends SessionRecord {
  projectId?: string | null;
}

interface ContextMenuState { x: number; y: number; items: ContextMenuItem[] }

export default function SessionSidebar({
  files, currentName, onOpenFile, onRefreshFiles, onUploaded, projects = [], currentProjectId = "", onProjectChange, onProjectUpdated, models = [], clientId = "", threadId = "", activeModel = "", onModelChange, workspaces = [], currentWorkspace = "", onWorkspaceChange, currentDir = "", onDirChange, onAtMention, sessions = [], unreadByThread = {}, onSelectSession, onRefreshSessions, onDeleteSession, onBatchDeleteSession, onRenameSession, onForkSession, onPinSession, onFreezeSession, onOpenSkills, onOpenAgents, onOpenKnowledgeBase, onOpenTemplates, onOpenMap, onOpenTasks, onOpenMcp, onOpenPiPlugins, onOpenSettings, onOpenArtifacts, onBeforeOpenModal, onOpenCommandPalette, onToggleTheme, theme = "dark", loadStatus = {}, changedFiles
}: SidebarProps) {
  const changedFilesSet: Set<string> = changedFiles ?? new Set<string>();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [modal, setModal] = useState<string | null>(null);   // 弹窗：artifacts | settings
  const [modalTab, setModalTab] = useState("settings"); // 设置弹窗子 tab：settings | memory
  const [fileQ, setFileQ] = useState("");    // 文件搜索关键词
  const [fileSort, setFileSort] = useState<string>(() => {
    try { return localStorage.getItem("oaw_file_sort") === "type" ? "type" : "time"; } catch { return "time"; }
  }); // 文件树排序：time=按修改时间，type=按文件类型分组
  const [fileSearchResults, setFileSearchResults] = useState<FileRecord[] | null>(null);
  const [fileSearchLoading, setFileSearchLoading] = useState(false);
  // 搜索失败/身份不一致要能说清原因，不能退化成"没有找到匹配的文件或目录"。
  const [searchError, setSearchError] = useState("");
  const fileSearchSeqRef = useRef(0);
  const fileSearchTimerRef = useRef<number | null>(null);
  const [customMode, setCustomMode] = useState(false);
  const [customPath, setCustomPath] = useState("");
  const [applying, setApplying] = useState(false);
  // 等待系统文件夹对话框的状态：对话框是独立窗口，可能被浏览器挡住，
  // 所以界面必须明说"在等系统对话框"并给一个取消入口，而不是只把按钮变灰。
  const [picking, setPicking] = useState(false);
  const [pickNotice, setPickNotice] = useState("");
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [historyProjectId, setHistoryProjectId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [newFiles] = useState<Set<string>>(new Set()); // 跟踪新创建的文件
  const [rootOpen, setRootOpen] = useState(false);
  const [rootPath, setRootPath] = useState("");
  const [historyEditSessionId, setHistoryEditSessionId] = useState<string | null>(null);
  const [fileRoots, setFileRoots] = useState<Array<{ id?: string; path?: string; label?: string }>>([]);
  const [artifactRuns, setArtifactRuns] = useState<RunRecord[]>([]);
  const [publishedArtifacts, setPublishedArtifacts] = useState<PublicationRecord[]>([]);
  const [artifactLoading, setArtifactLoading] = useState(false);
  const [primaryTab, setPrimaryTab] = useState("project");
  const projectTypes = [...new Set(projects.map((project) => project.type || "综合项目"))];
  const currentProject = projects.find((project) => project.id === currentProjectId) || null;
  const filesLoading = loadStatus?.files === "loading";
  const projectsLoading = loadStatus?.projects === "loading";
  const projectSessions = (project: ProjectRecord) => sessions.filter((session) => session.projectId === project.id || samePath(session.cwd, project.rootPath));
  const historyProject = projects.find((project) => project.id === historyProjectId) || currentProject;
  const historySessions = historyProject ? projectSessions(historyProject) : [];

  useEffect(() => {
    const query = fileQ.trim();
    if (!query) {
      setFileSearchResults(null);
      setFileSearchLoading(false);
      return undefined;
    }
    const requestSeq = ++fileSearchSeqRef.current;
    if (fileSearchTimerRef.current) window.clearTimeout(fileSearchTimerRef.current);
    fileSearchTimerRef.current = window.setTimeout(async () => {
      setFileSearchLoading(true);
      try {
        // 搜索也必须带上当前工作区：否则结果可能来自其他页面切换后的工作区。
        const result = await searchFiles(query, 200, currentWorkspace);
        if (requestSeq !== fileSearchSeqRef.current) return;
        if (result.workspace && currentWorkspace && !sameWorkspacePath(result.workspace, currentWorkspace)) {
          setSearchError(`搜索来源与当前工作区不一致（${result.workspace}）`);
          setFileSearchResults([]);
          return;
        }
        setSearchError("");
        setFileSearchResults((result.files || []) as FileRecord[]);
      } catch (err) {
        if (requestSeq === fileSearchSeqRef.current) {
          setSearchError((err as Error)?.message || "搜索失败");
          setFileSearchResults([]);
        }
      } finally {
        if (requestSeq === fileSearchSeqRef.current) setFileSearchLoading(false);
      }
    }, 180);
    return () => window.clearTimeout(fileSearchTimerRef.current ?? undefined);
  }, [currentWorkspace, fileQ]);

  const navigateDir = useCallback((dir: string) => {
    setFileQ("");
    setFileSearchResults(null);
    onDirChange?.(dir || "");
  }, [onDirChange]);

  // 文件树排序：目录始终在前；时间=按修改时间倒序，类型=按扩展名分组（同组按名称）
  const sortFileList = useCallback((list: FileRecord[]) => sortFiles(list, fileSort) as FileRecord[], [fileSort]);

  const toggleFileSort = () => {
    const next = fileSort === "time" ? "type" : "time";
    setFileSort(next);
    try { localStorage.setItem("oaw_file_sort", next); } catch {}
  };

  const refreshArtifacts = useCallback(async () => {
    setArtifactLoading(true);
    try {
      const [runData, publishedData] = await Promise.all([
        listRuns("", 100, { cwd: currentWorkspace }),
        listPublishedArtifacts(currentWorkspace, currentProjectId),
      ]);
      const runs = (runData.runs || []).filter((run) => run?.artifacts?.length);
      const enrichedRuns = await Promise.all(runs.slice(0, 12).map(async (run) => {
        if (run.acceptance?.artifacts?.length) return run;
        try { return ((await getRunAcceptance(run.id)) as { run?: RunRecord }).run || run; } catch { return run; }
      }));
      setArtifactRuns([...enrichedRuns, ...runs.slice(12)]);
      setPublishedArtifacts((publishedData.artifacts || []) as PublicationRecord[]);
    } catch {}
    setArtifactLoading(false);
  }, [currentWorkspace, currentProjectId]);

  useEffect(() => {
    if (modal === "artifacts") refreshArtifacts();
  }, [modal, refreshArtifacts]);

  const artifactEntries: ArtifactEntry[] = artifactRuns.flatMap((run) => (run.artifacts || [])
    .filter((artifact) => artifact.status !== "deleted")
    .map((artifact) => ({ ...artifact, run })));
  const publishedByArtifact = new Map(publishedArtifacts.map((item) => [item.artifactId, item]));

  const refreshFileRoots = useCallback(async () => {
    try { setFileRoots((await listFileRoots()).roots || []); } catch {}
  }, []);  useEffect(() => { refreshFileRoots(); }, [refreshFileRoots]);

  const registerRoot = async () => {
    const value = rootPath.trim();
    if (!value) return;
    try {
      await addFileRoot(value);
      setRootPath("");
      refreshFileRoots();
    } catch (e) { notifyError("登记失败: " + (e as Error).message); }
  };

  const applyCustom = async () => {
    const dir = customPath.trim();
    if (!dir) return notifyError("请输入文件夹路径");
    setApplying(true);
    try {
      const v = (await validateWorkspace(dir)) as ValidateResult;
      if (!v.ok) {
        const reason = v.writeAccess?.message || v.error || "无效目录";
        notifyError(`无法将此目录用作可写工作区：${reason}`);
        return;
      }
      await onWorkspaceChange?.(dir);
      setCustomMode(false);
      setSwitcherOpen(false);
    } catch (e) { notifyError("验证失败: " + (e as Error).message); }
    finally { setApplying(false); }
  };

  const pickCustomWorkspace = async () => {
    if (applying || picking) return;
    setApplying(true);
    setPicking(true);
    setPickNotice("已打开系统文件夹对话框：请在弹出的窗口里选择文件夹（若没看到，请查看任务栏——它可能被浏览器窗口挡住）。");
    try {
      const result = (await pickWorkspace()) as PickResult;
      if (result.canceled) { setPickNotice("已取消选择。"); return; }
      if (result.workspace) setCustomPath(result.workspace);
      if (!result.ok) {
        const reason = result.writeAccess?.message || result.error || "无效目录";
        setPickNotice("");
        notifyError(`无法将此目录用作可写工作区：${reason}`);
        return;
      }
      setPickNotice("");
      await onWorkspaceChange?.(result.workspace as string);
      setCustomMode(false);
      setSwitcherOpen(false);
    } catch (e) {
      setPickNotice("");
      notifyError("选择工作区失败: " + (e as Error).message);
    }
    finally { setApplying(false); setPicking(false); }
  };

  // 取消等待：把那个已经打开的系统对话框收掉（服务端持有选择器进程）。
  const cancelPick = async () => {
    setPickNotice("正在取消…");
    try {
      const result = (await cancelWorkspacePick()) as CancelPickResult;
      setPickNotice(result.cancelled ? "已取消等待，系统对话框已关闭。" : "当前没有等待中的系统对话框。");
    } catch (e) {
      setPickNotice("取消失败：" + ((e as Error).message || "网络错误"));
    }
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const { data } = await fileToBase64(f);
      const result = await uploadFile(f.name, data, currentWorkspace);
      if (result?.workspace && currentWorkspace && !sameWorkspacePath(result.workspace, currentWorkspace)) {
        throw new Error(`上传落点与当前工作区不一致（${result.workspace}）`);
      }
      onUploaded();
    } catch (err) { notifyError("上传失败: " + (err as Error).message); }
    e.target.value = "";
  };

  // 新建空白 Word 文档（docx 库生成 → 上传工作区 → 刷新列表）
  const [creatingWord, setCreatingWord] = useState(false);
  const handleNewWord = async () => {
    if (creatingWord) return;
    setCreatingWord(true);
    try {
      // 含一个空段落，保证各版本 Word/WPS 正常打开
      const doc = new Document({ sections: [{ children: [new Paragraph("")] }] });
      const blob = await Packer.toBlob(doc);
      // blob → base64（绕开 FileReader，分块避免栈溢出）
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
      }
      const data = btoa(bin);
      // 文件名查重：新建文档.docx / 新建文档 2.docx …
      const names = new Set(files.map((f) => f.name));
      let name = "新建文档.docx";
      let i = 2;
      while (names.has(name)) name = `新建文档 ${i++}.docx`;
      await uploadFile(name, data, currentWorkspace);
      onUploaded();
    } catch (err) { notifyError("新建失败: " + (err as Error).message); }
    setCreatingWord(false);
  };

  const handleDeleteFile = async (name: string) => {
    if (!(await askConfirm(`删除 ${name} ?`))) return;
    try { await deleteFile(name, currentWorkspace); onRefreshFiles(); } catch (err) { notifyError("删除失败: " + (err as Error).message); }
  };

  // 在文件管理器中显示（macOS 为 Finder 中选中该文件）
  const handleRevealInFileManager = async (filePath: string) => {
    try {
      await revealInSystem(filePath);
    } catch (error) {
      try {
        await navigator.clipboard.writeText(filePath);
        notifyError(`无法打开文件管理器（${(error as Error).message}），路径已复制到剪贴板：${filePath}`);
      } catch {
        notifyError(`无法打开文件管理器：${(error as Error).message}`);
      }
    }
  };

  // 用系统默认应用打开（不做 shell 拼接，服务端只接受工作区内/刚选中的路径）
  const handleOpenWithDefaultApp = async (filePath: string) => {
    try {
      const result = await openInSystem(filePath);
      if (result?.opened === "reveal") onRefreshFiles?.();
    } catch (error) {
      notifyError(`用系统应用打开失败：${(error as Error).message}`);
    }
  };

  // 原生文件选择器：工作区内 → 应用内打开；工作区外 → 用系统默认应用打开
  const handlePickNativeFiles = async () => {
    try {
      const result = await pickNativeFiles({ multiple: true, prompt: "选择要打开的文件" });
      if (!result?.ok) {
        if (!result?.canceled) notifyError("选择文件失败");
        return;
      }
      const pickedFiles = Array.isArray(result.files) ? result.files : [];
      if (!pickedFiles.length) return;
      const first = pickedFiles[0];
      if (first.insideWorkspace && first.name) {
        onOpenFile?.(first.name);
      } else {
        await openInSystem(first.path);
      }
      if (pickedFiles.length > 1) {
        notifySuccess(`已选中 ${pickedFiles.length} 个文件，先处理了第 1 个：${first.name || first.path}`);
      }
    } catch (error) {
      notifyError(`原生文件选择器不可用：${(error as Error).message}`);
    }
  };

  // 存入知识库：docx → 服务端转 md 并注册为 kb 根
  const handleIngestToKB = async (name: string) => {
    if (!(await askConfirm(`将「${name}」存入知识库（自动转换为 Markdown 并注册为知识库根）？`))) return;
    try {
      const data = await ingestToKb(name);
      if (data.ok === false) throw new Error(data.error || "存入失败");
      notifySuccess(`已存入知识库：${data.mdName || name}`);
    } catch (err) {
      notifyError("存入失败: " + (err as Error).message);
    }
  };

  // 右键菜单处理
  const handleContextMenu = (e: React.MouseEvent, file: FileRecord) => {
    e.preventDefault();
    e.stopPropagation();
    const filePath = currentDir ? `${currentDir}/${file.name}` : file.name;
    const menuItems: ContextMenuItem[] = [
      ...(file.isDir ? [] as ContextMenuItem[] : [{
        icon: "externalLink",
        label: "用系统默认应用打开",
        onClick: () => handleOpenWithDefaultApp(filePath)
      }]),
      {
        icon: "folderOpen",
        label: "在文件管理器中显示",
        onClick: () => handleRevealInFileManager(filePath)
      },
      {
        icon: "copy",
        label: "复制文件名",
        onClick: () => navigator.clipboard.writeText(file.name)
      },
      { separator: true },
      {
        icon: "at",
        label: "@ 到对话中",
        onClick: () => onAtMention && onAtMention(filePath, file.isDir)
      }
    ];
    if (!file.isDir) {
      menuItems.push({ separator: true });
      if (file.ext === "docx") {
        menuItems.push({
          icon: "book",
          label: "存入知识库",
          onClick: () => handleIngestToKB(file.name)
        });
      }
      menuItems.push(
        {
          icon: "trash",
          label: "删除",
          danger: true,
          onClick: () => handleDeleteFile(filePath)
        }
      );
    }
    setContextMenu({ x: e.clientX, y: e.clientY, items: menuItems });
  };

  return (
    <div className="sidebar">
      <div className="sidebar-brand">
        <Logo size={24} />
        <div className="sidebar-brand-copy">
          <strong>Open Plan</strong>
          <span>规聚工作台</span>
        </div>
        <button className="sidebar-brand-action" onClick={() => onToggleTheme?.()} title={theme === "dark" ? "切换到亮色主题" : "切换到暗色主题"}>
          <Icon name={theme === "dark" ? "sun" : "moon"} size={15} />
        </button>
        <button className="sidebar-brand-action" onClick={() => onOpenCommandPalette?.()} title="命令面板（Ctrl/Cmd+K）"><Icon name="search" size={15} /></button>
      </div>
      <div className="sidebar-primary-tabs" role="tablist" aria-label="工作台导航">
        <button className={primaryTab === "project" ? "active" : ""} onClick={() => setPrimaryTab("project")}><Icon name="folder" size={14} /> 项目</button>
        <button className={primaryTab === "file" ? "active" : ""} onClick={() => setPrimaryTab("file")}><Icon name="file" size={14} /> 文件</button>
        <button className={primaryTab === "tools" ? "active" : ""} onClick={() => setPrimaryTab("tools")}><Icon name="grid" size={14} /> 能力</button>
      </div>
      {/* 顶部：项目 / 工作区选择器 + 新建会话 */}
      <div className="workspace-selector">
        <button
          type="button"
          className="workspace-switcher-trigger"
          onClick={() => setSwitcherOpen(true)}
          title="选择项目和工作区"
        >
          <Icon name="folderOpen" size={14} />
          <span>{currentProject?.name || "选择项目"}</span>
          <small>{currentWorkspace ? shortenCwd(currentWorkspace) : "默认工作区"}</small>
          <Icon name="chevronDown" size={12} />
        </button>
        {projects.length > 0 && (
          <>
            <span className="ws-label">项目</span>
            <select
              className="project-select"
              value={currentProjectId}
              onChange={(e) => onProjectChange?.(e.target.value)}
              title="切换项目（按项目类型分类）"
            >
              {projectTypes.map((type) => (
                <optgroup key={type} label={type}>
                  {projects.filter((project) => (project.type || "综合项目") === type).map((project) => (
                    <option key={project.id} value={project.id}>{project.name} · {project.status}{project.pendingMemoryCount ? ` · 待沉淀 ${project.pendingMemoryCount}` : ""}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </>
        )}
        <span className="ws-label">工作区</span>
        <select
          value={customMode ? "__custom__" : currentWorkspace}
          onChange={(e) => {
            if (e.target.value === "__custom__") {
              setCustomMode(true);
            } else {
              setCustomMode(false);
              onWorkspaceChange && onWorkspaceChange(e.target.value);
            }
          }}
          title="切换工作区目录"
        >
          {workspaces.length === 0 && <option value="">默认工作区</option>}
          {workspaces.map((w) => (
            <option key={w.path} value={w.path}>{w.name}</option>
          ))}
          <option value="__custom__">自定义路径…</option>
        </select>
         {primaryTab === "file" && <button className={`btn-sm sidebar-root-btn ${rootOpen ? "active" : ""}`} onClick={() => setRootOpen((v) => !v)} title="登记工作区外的本地目录">外部目录</button>}
      </div>
      {primaryTab === "file" && rootOpen && (
        <div className="workspace-custom external-roots">
          <div className="external-root-form">
            <input type="text" placeholder="本地目录绝对路径" value={rootPath} onChange={(e) => setRootPath(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") registerRoot(); }} />
            <button className="btn-xs" onClick={registerRoot}>登记</button>
          </div>
          {fileRoots.map((root) => (
            <div className="external-root-item" key={root.id} title={root.path}>
              <span>{root.label || root.path}</span>
              <button className="btn-icon danger" onClick={async () => { if (root.id) await removeFileRoot(root.id); refreshFileRoots(); }} title="移除目录" aria-label="移除目录"><Icon name="close" size={12} /></button>
            </div>
          ))}
          {!fileRoots.length && <div className="external-root-empty">尚未登记外部目录</div>}
        </div>
      )}
      {primaryTab === "file" && customMode && (
        <div className="workspace-custom">
          <input
            type="text"
            placeholder="输入文件夹路径，如 F:\work\docs"
            value={customPath}
            onChange={(e) => setCustomPath(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") applyCustom(); }}
          />
          <button className="btn-xs" onClick={applyCustom} disabled={applying}>
            {applying && !picking ? "验证中..." : "打开"}
          </button>
          <button className="btn-xs" onClick={pickCustomWorkspace} disabled={applying} title="打开系统文件夹选择器">
            <Icon name="folderOpen" size={12} /> {picking ? "等待选择…" : "选择文件夹"}
          </button>
        </div>
      )}
      {(picking || pickNotice) && (
        <div className="workspace-pick-notice" role="status">
          <Icon name={picking ? "loading" : "info"} size={12} className={picking ? "icon-loading" : ""} />
          <span>{pickNotice}</span>
          {picking && <button type="button" className="btn-xs" onClick={cancelPick}>取消等待</button>}
        </div>
      )}
      {switcherOpen && (
        <div className="workspace-switcher-backdrop" onClick={() => setSwitcherOpen(false)}>
          <div className="workspace-switcher-dialog" role="dialog" aria-label="选择项目和工作区" onClick={(e) => e.stopPropagation()}>
            <div className="workspace-switcher-head">
              <div><Icon name="folder" size={14} /><strong>选择项目和工作区</strong></div>
              <button className="mp-op" onClick={() => setSwitcherOpen(false)} title="关闭"><Icon name="close" size={14} /></button>
            </div>
            <div className="workspace-switcher-body">
              <div className="workspace-switcher-section">
                <div className="workspace-switcher-section-title">项目</div>
                {projectTypes.map((type) => (
                  <div key={type}>
                    <div className="workspace-switcher-type">{type}</div>
                    {projects.filter((project) => (project.type || "综合项目") === type).map((project) => (
                      <button type="button" key={project.id} className={"workspace-switcher-option " + (project.id === currentProjectId ? "active" : "")} onClick={() => { onProjectChange?.(project.id); setSwitcherOpen(false); }}>
                        <Icon name="folder" size={14} />
                        <span><strong>{project.name}</strong><small>{project.status || "进行中"} · 会话 {project.sessionCount ?? projectSessions(project).length}</small></span>
                        {(project.pendingMemoryCount ?? 0) > 0 && <em>待沉淀 {project.pendingMemoryCount}</em>}
                      </button>
                    ))}
                  </div>
                ))}
                {!projects.length && <div className="empty">暂无项目</div>}
              </div>
              <div className="workspace-switcher-section">
                <div className="workspace-switcher-section-title">工作区目录</div>
                {workspaces.map((workspaceItem) => (
                  <button type="button" key={workspaceItem.path} className={"workspace-switcher-option " + (samePath(workspaceItem.path, currentWorkspace) ? "active" : "")} onClick={() => { onWorkspaceChange?.(workspaceItem.path); setSwitcherOpen(false); }}>
                    <Icon name="folderOpen" size={14} />
                    <span><strong>{workspaceItem.name}</strong><small>{shortenCwd(workspaceItem.path)}</small></span>
                  </button>
                ))}
                <button type="button" className="workspace-switcher-custom" onClick={() => setCustomMode(true)}><Icon name="plus" size={14} /> 打开自定义目录</button>
                {customMode && (
                  <div className="workspace-switcher-custom-form">
                    <input autoFocus value={customPath} placeholder="输入文件夹绝对路径" onChange={(e) => setCustomPath(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") applyCustom(); }} />
                    <button type="button" className="btn-xs" onClick={applyCustom} disabled={applying}>{applying && !picking ? "验证中…" : "打开"}</button>
                    <button type="button" className="btn-xs" onClick={pickCustomWorkspace} disabled={applying} title="打开系统文件夹选择器"><Icon name="folderOpen" size={12} /> {picking ? "等待选择…" : "选择文件夹"}</button>
                    {(picking || pickNotice) && (
                      <div className="workspace-pick-notice" role="status">
                        <Icon name={picking ? "loading" : "info"} size={12} className={picking ? "icon-loading" : ""} />
                        <span>{pickNotice}</span>
                        {picking && <button type="button" className="btn-xs" onClick={cancelPick}>取消等待</button>}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      {currentProject && primaryTab !== "project" && (
        <div className="project-context-strip" title={`当前项目：${currentProject.name}`}>
          <span className="project-context-name">{currentProject.name}</span>
          <span className="project-context-type">{currentProject.type || "综合项目"}</span>
          {currentProject.status && <span className="project-context-status">{currentProject.status}</span>}
          {(currentProject.pendingMemoryCount ?? 0) > 0 && <span className="project-context-status">待沉淀 {currentProject.pendingMemoryCount}</span>}
          {(currentProject.approvedMemoryCount ?? 0) > 0 && <span className="project-context-status">已沉淀 {currentProject.approvedMemoryCount}</span>}
          {(currentProject.unresolvedRunCount ?? 0) > 0 && <span className="project-context-status">未完成 {currentProject.unresolvedRunCount}</span>}
          <button
            className="project-memory-btn"
            onClick={() => { if (onOpenSettings) onOpenSettings("memory"); else { onBeforeOpenModal?.(); setModal("settings"); setModalTab("memory"); } }}
            title="打开当前工作区的记忆与沉淀"
          ><Icon name="bookmark" size={12} /> 记忆</button>
        </div>
      )}

      {primaryTab === "project" && (
        <div className="sidebar-project-list">
          <div className="sidebar-view-title sidebar-project-heading">
            <span>项目 <em>{projects.length}</em></span>
            <span className="sidebar-project-actions">
              <button type="button" onClick={() => { setSwitcherOpen(true); setCustomMode(true); }} title="打开本地项目"><Icon name="folderOpen" size={12} /></button>
              <button type="button" onClick={() => onOpenSettings?.("project")} title="新建项目"><Icon name="plus" size={12} /></button>
            </span>
          </div>
          {projects.map((project) => (
            <div key={project.id} className={"sidebar-project-card " + (project.id === currentProjectId ? "active" : "")} role="button" tabIndex={0} onClick={() => onProjectChange?.(project.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onProjectChange?.(project.id); }}>
              <Icon name="folder" size={15} />
              <span className="sidebar-project-main">
                <MarqueeText
                  text={project.name || ""}
                  active={projectSessions(project).some((session) => RUNNING_SESSION_STATUSES.has(session.runStatus || ""))}
                  className="sidebar-project-name"
                />
                <small>{project.type || "综合项目"} · {project.status || "进行中"}</small>
              </span>
              {(project.pendingMemoryCount ?? 0) > 0 && <span className="sidebar-project-badge">待沉淀 {project.pendingMemoryCount}</span>}
              <span className="sidebar-project-count">会话 {project.sessionCount ?? projectSessions(project).length}</span>
              {project.id === currentProjectId && projectSessions(project).length > 0 && (
                <div className="project-session-preview" onClick={(e) => e.stopPropagation()}>
                  <div className="project-session-preview-head">
                    <span><Icon name="history" size={12} /> 最近会话</span>
                    <button type="button" onClick={() => { setHistoryProjectId(project.id); setModal("history"); }}>查看全部</button>
                  </div>
                  {projectSessions(project).slice(0, 4).map((session) => (
                    <div className={"project-session-row " + (RUNNING_SESSION_STATUSES.has(session.runStatus || "") ? "is-running" : "")} key={session.id}>
                      <button type="button" className="project-session-open" onClick={() => onSelectSession?.(session)} title="打开会话">
                        <i data-status={session.runStatus || "idle"} />
                        <MarqueeText
                          text={session.title || session.label || "未命名会话"}
                          active={RUNNING_SESSION_STATUSES.has(session.runStatus || "")}
                          className="project-session-name"
                        />
                        <small>{session.runStatus === "running" ? "执行中" : formatTime(session.modified)}</small>
                      </button>
                      <button type="button" className="project-session-edit" onClick={() => { setHistoryProjectId(project.id); setHistoryEditSessionId(session.id); setModal("history"); }} title="编辑会话名称" aria-label="编辑会话名称"><Icon name="penTool" size={12} /></button>
                    </div>
                  ))}
                  {projectSessions(project).length > 4 && <button type="button" className="project-history-more" onClick={() => { setHistoryProjectId(project.id); setModal("history"); }}>还有 {projectSessions(project).length - 4} 个会话</button>}
                </div>
              )}
            </div>
          ))}
          {!projects.length && (projectsLoading
            ? <SkeletonRows rows={3} label="正在加载项目列表" />
            : <div className="empty">暂无项目，可在设置中创建</div>)}
        </div>
      )}

      {primaryTab === "tools" && (
        <div className="sidebar-capabilities">
          <div className="sidebar-view-title"><span>工作能力</span><span>按需打开</span></div>
          <button onClick={() => onOpenKnowledgeBase?.()}><Icon name="book" size={16} /><span><strong>知识库</strong><small>检索与引用</small></span></button>
          <button onClick={() => onOpenSkills?.()}><Icon name="skills" size={16} /><span><strong>Skills</strong><small>技能搜索与调用</small></span></button>
          <button onClick={() => onOpenTemplates?.()}><Icon name="doc" size={16} /><span><strong>模板库</strong><small>结构与样式</small></span></button>
          <button onClick={() => onOpenMap?.()}><Icon name="map" size={16} /><span><strong>地图</strong><small>GIS 分析</small></span></button>
          <button onClick={() => onOpenAgents?.()}><Icon name="robot" size={16} /><span><strong>智能体广场</strong><small>预置 Agent</small></span></button>
          <button onClick={() => onOpenTasks?.()}><Icon name="list" size={16} /><span><strong>任务中心</strong><small>并行任务与历史</small></span></button>
          <button onClick={() => onOpenMcp?.()}><Icon name="plug" size={16} /><span><strong>MCP</strong><small>外部工具与服务</small></span></button>
          <button onClick={() => onOpenPiPlugins?.()}><Icon name="package" size={16} /><span><strong>Pi 插件</strong><small>官方目录与扩展</small></span></button>
        </div>
      )}

      {/* 文件树 */}
      {primaryTab === "file" && <>
      <div className="sidebar-section-head">
        <Icon name="folder" size={12} />
        <span className="section-name">文件</span>
        <button
          className="btn-xs section-sort"
          onClick={toggleFileSort}
          title={fileSort === "time" ? "当前按修改时间排序，点击改为按类型分组" : "当前按文件类型排序，点击改为按修改时间排序"}
        >
          <Icon name={fileSort === "time" ? "history" : "layers"} size={12} />
          <span className="section-sort-text">{fileSort === "time" ? "时间" : "类型"}</span>
        </button>
        <span className="section-count">{files.length}</span>
        {/* 图层入口（阶段 1 · B6 的"工作区入口"）：在工作区语境下也能一步到图层管理。
            与「能力」页的地图入口同源（都打开地图模块），只是就近放在文件页工具条。 */}
        <button className="btn-xs section-layers" onClick={() => onOpenMap?.()} title="图层管理（打开地图模块，查看共享数据集与本工作区图层）">
          <Icon name="layers" size={12} />
        </button>
        <button className="btn-xs section-refresh" onClick={() => onRefreshFiles()} title="刷新文件">
          <Icon name="refresh" size={12} />
        </button>
        <button className="btn-xs section-new" onClick={handleNewWord} disabled={creatingWord} title="新建空白 Word 文档">
          <Icon name="plus" size={12} />
        </button>
        <button className="btn-xs section-pick-native" onClick={handlePickNativeFiles} title="用系统原生选择器打开本机文件（macOS Finder / Windows 资源管理器）">
          <Icon name="folderOpen" size={12} />
        </button>
        <button className="btn-xs section-upload" onClick={() => fileRef.current?.click()} title="上传文件（复制进当前工作区）">
          <Icon name="upload" size={12} />
        </button>
        <input ref={fileRef} type="file" accept=".docx,.xlsx,.pptx,.pdf,.csv,.json,.md,.markdown,.txt,.html,.htm" hidden onChange={handleUpload} />
      </div>
       <div className="sidebar-section files-section">
         {files.length === 0 && (filesLoading
           ? <SkeletonRows rows={4} label="正在加载文件列表" />
           : <div className="empty">暂无文件，点击上传</div>)}
         {currentDir && (
           <div className="crumb-bar">
            <button className="btn-xs" onClick={() => navigateDir(currentDir.split("/").slice(0, -1).join("/"))} title="返回上一级目录">← 上一级</button>
            <button className="btn-xs" onClick={() => navigateDir("")} title="返回工作区根目录">根目录</button>
            <span className="crumb-path">/{currentDir.split("/").pop()}</span>
          </div>
        )}
        <div className="file-search">
          <Icon name="search" size={12} />
          <input
            placeholder="搜索整个工作区的文件和目录…"
            value={fileQ}
            onChange={(e) => setFileQ(e.target.value)}
          />
          {fileQ && <button className="file-search-clear" onClick={() => setFileQ("")} title="清除" aria-label="清除搜索"><Icon name="close" size={12} /></button>}
        </div>
        <div className="file-list">
          {fileSearchLoading && <div className="file-search-status">正在搜索整个工作区…</div>}
          {!fileSearchLoading && searchError && <div className="file-search-status error" role="alert">{searchError}</div>}
          {!fileSearchLoading && !searchError && fileQ.trim() && fileSearchResults?.length === 0 && <div className="file-search-status">没有找到匹配的文件或目录</div>}
          {sortFileList(fileQ.trim() ? (fileSearchResults || []) : files).map((f) => {
            const filePath = f.relPath || (currentDir ? `${currentDir}/${f.name}` : f.name);
            const isNew = newFiles.has(filePath);
            const isChanged = !f.isDir && changedFilesSet.has(f.name);
            return (
              <div
                key={filePath}
                className={`file-item ${!f.isDir && f.name === currentName ? "active" : ""} ${isNew ? "new-file" : ""} ${isChanged ? "changed" : ""}`}
                onClick={() => {
                  if (f.isDir) {
                    navigateDir(filePath);
                  } else {
                    onOpenFile(filePath);
                  }
                }}
                onContextMenu={(e) => handleContextMenu(e, f)}
                title={f.name}
                >
                <FileTypeIcon file={f} />
                <span className="file-name" title={f.name}>{f.isDir ? f.name : f.name}</span>
                <span className="file-meta">
                  {fileQ.trim() ? <span className="file-path-hint" title={filePath}>{filePath}</span> : (f.isDir ? <Icon name="chevronRight" size={12} className="file-dir-chevron" /> : formatSize(f.size))}
                  {!f.isDir && <span className="file-mtime">{formatTime(new Date(f.mtime as number).toISOString())}</span>}
                </span>
                <span
                  className="file-at"
                  onClick={(e) => {
                    e.stopPropagation();
                    onAtMention && onAtMention(filePath, f.isDir);
                  }}
                  title="@ 到对话中作为参考"
                  role="button"
                  aria-label={`引用 ${f.name}`}
                >@</span>
                {!f.isDir && (
                  <span className="file-del" onClick={(e) => { e.stopPropagation(); handleDeleteFile(filePath); }} role="button" aria-label={`删除 ${f.name}`} title={`删除 ${f.name}`}><Icon name="close" size={12} /></span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      </>}

      {/* 底部：产物 / 设置（弹窗） */}
      <div className="sidebar-bottom-tabs">
        <button className={`bt-btn ${modal === "artifacts" ? "active" : ""}`} onClick={() => { if (onOpenArtifacts) onOpenArtifacts(); else { if (modal !== "artifacts") onBeforeOpenModal?.(); setModal(modal === "artifacts" ? null : "artifacts"); } }} title="产物（agent 生成的文件）">
          <Icon name="package" size={14} /> 产物
        </button>
        <button className={`bt-btn ${modal === "settings" ? "active" : ""}`} onClick={() => { if (onOpenSettings) onOpenSettings("settings"); else { if (modal !== "settings") onBeforeOpenModal?.(); setModal(modal === "settings" ? null : "settings"); } }} title="设置（含记忆）">
          <Icon name="gear" size={14} /> 设置
        </button>
      </div>

      {/* 项目会话历史：会话归属项目，不再和文件列表混在一起 */}
      {modal === "history" && (
        <div className="sb-modal-backdrop" onClick={() => { setModal(null); setHistoryEditSessionId(null); }}>
          <div className="sb-modal project-history-modal" onClick={(e) => e.stopPropagation()}>
            <div className="sb-modal-head">
              <Icon name="history" size={14} />
              <span className="sb-modal-title">{historyProject?.name || "项目"} · 会话历史</span>
              <span className="sb-modal-sub">共 {historySessions.length} 个，会话可独立切换、分支和恢复</span>
              <button className="mp-op" onClick={() => setModal(null)} title="关闭"><Icon name="close" size={14} /></button>
            </div>
            <div className="sb-modal-body project-history-body">
              <SessionList
                sessions={historySessions}
                initialEditingId={historyEditSessionId}
                unreadByThread={unreadByThread}
                onSelect={(session) => { setModal(null); setHistoryEditSessionId(null); onSelectSession?.(session); }}
                onDelete={(id) => onDeleteSession?.(id)}
                onBatchDelete={(ids) => onBatchDeleteSession?.(ids)}
                onRename={(id, value) => onRenameSession?.(id, value)}
                onFork={(id, name) => onForkSession?.(id, name)}
                onPin={(id, pinned) => onPinSession?.(id, pinned)}
                onFreeze={(id, frozen) => onFreezeSession?.(id, frozen)}
              />
            </div>
          </div>
        </div>
      )}

      {/* 产物弹窗 */}
      {modal === "artifacts" && (
        <div className="sb-modal-backdrop" onClick={() => setModal(null)}>
          <div className="sb-modal" onClick={(e) => e.stopPropagation()}>
            <div className="sb-modal-head">
              <Icon name="package" size={14} />
              <span className="sb-modal-title">成果（{artifactEntries.length}）</span>
              <span className="sb-modal-sub">按 Run manifest 展示，可固定为项目正式成果</span>
              <button className="mp-op" onClick={() => setModal(null)} title="关闭"><Icon name="close" size={14} /></button>
            </div>
            <div className="sb-modal-body">
              {artifactLoading && <div className="empty">正在读取成果清单…</div>}
              {!artifactLoading && artifactEntries.length === 0 && <div className="empty">暂无已登记成果；完成任务并通过校验后会显示在这里</div>}
              <div className="file-list">
                {[...artifactEntries]
                  .sort((a, b) => String(b.run?.finishedAt || b.run?.startedAt || "").localeCompare(String(a.run?.finishedAt || a.run?.startedAt || "")))
                  .map((item, index) => {
                    const name = String(item.path || "").split(/[\\/]/).pop() || (item.path as string);
                    const published = publishedByArtifact.get(item.artifactId as string);
                    const acceptance = (item.acceptance || item.run?.acceptance?.artifacts?.find((result) => result.path === item.path)) as RunAcceptanceInfo | undefined;
                    const acceptanceStatus = (acceptance?.status as string) || (item.acceptanceStatus as string) || (item.verificationStatus as string) || "not_checked";
                    const canConfirm = item.run?.status === "completed" && !published && acceptance && !acceptance.readyToPublish && acceptanceStatus !== "failed";
                    const canPublish = item.run?.status === "completed" && !published && acceptance?.readyToPublish;
                    return (
                      <div
                        key={`${item.artifactId || item.path}-${index}`}
                        className={`file-item artifact-item ${name === currentName ? "active" : ""}`}
                        onClick={() => {
                          onOpenFile(item.path as string);
                          setModal(null);
                        }}
                        title={`${item.path} · 来源 Run ${item.run?.id || "未知"}`}
                      >
                        <FileTypeIcon file={{ name, ext: name.includes(".") ? (name.split(".").pop() as string) : "" }} size="small" />
                        <span className="file-name" title={item.path}>{name}</span>
                        <span className={`artifact-status ${published ? "published" : acceptanceStatus === "failed" ? "failed" : acceptanceStatus === "passed" ? "ready" : "pending"}`} title={acceptance?.summary || "尚未完成成果验收"}>{published ? `v${published.version} 已固定` : acceptance?.readyToPublish ? "验收通过·待固定" : acceptanceStatus === "failed" ? "验收失败" : "待人工确认"}</span>
                        {canConfirm && <button className="btn-xs artifact-publish-btn" onClick={async (e) => {
                          e.stopPropagation();
                          const note = window.prompt("请输入人工确认说明（可选）", "已检查内容、格式和页面显示");
                          if (note === null) return;
                          try { await confirmArtifactAcceptance(item.run.id as string, item.artifactId as string, note); await refreshArtifacts(); } catch (error) { notifyError("人工确认失败: " + (error as Error).message); }
                        }}>人工确认</button>}
                        {canPublish && <button className="btn-xs artifact-publish-btn" onClick={async (e) => {
                          e.stopPropagation();
                          try { await publishArtifact(item.run.id as string, item.artifactId as string); await refreshArtifacts(); } catch (error) { notifyError("固定成果失败: " + (error as Error).message); }
                        }}>固定成果</button>}
                        {acceptance && <details className="artifact-acceptance-details" onClick={(e) => e.stopPropagation()}>
                          <summary>验收详情</summary>
                          <div>结构：{(acceptance.checks as Record<string, { status?: string }> | undefined)?.structure?.status || "未检查"} · 内容：{(acceptance.checks as Record<string, { status?: string }> | undefined)?.content?.status || "未检查"}</div>
                          <div>视觉：{(acceptance.checks as Record<string, { status?: string }> | undefined)?.visual?.status || "未检查"} · 人工：{(acceptance.checks as Record<string, { status?: string }> | undefined)?.manual?.status || "未检查"}</div>
                        </details>}
                      </div>
                    );
                  })}
              </div>
              {publishedArtifacts.length > 0 && <div className="artifact-history">
                <div className="artifact-history-title">正式成果版本（含来源与回滚）</div>
                {publishedArtifacts.map((item) => <div className="artifact-history-row" key={item.id}>
                  <span className="file-name" title={item.path}>{String(item.path || "").split(/[\\/]/).pop()}</span>
                  <span className="artifact-history-meta">v{item.version} · {item.diffSummary?.changeType || "修改"} · Run {String(item.sourceRunId || item.runId || "").slice(-8)} · {item.status === "rolled_back" ? "已回滚" : "当前版本"}</span>
                  {item.status !== "rolled_back" && item.rollbackTarget && <button className="btn-xs" onClick={async () => {
                    if (!(await askConfirm(`确认将 ${item.path} 回滚到 v${publishedArtifacts.find((entry) => entry.id === item.rollbackTarget)?.version || "历史"}？`))) return;
                    try { await rollbackPublishedArtifact(item.id as string); await refreshArtifacts(); } catch (error) { notifyError("回滚成果失败: " + (error as Error).message); }
                  }}>回滚</button>}
                </div>)}
              </div>}
            </div>
          </div>
        </div>
      )}

      {/* 设置弹窗（含记忆） */}
      {modal === "settings" && (
        <div className="sb-modal-backdrop" onClick={() => setModal(null)}>
          <div className="sb-modal sb-modal-wide" onClick={(e) => e.stopPropagation()}>
            <div className="sb-modal-head">
              <Icon name="gear" size={14} />
              <span className="sb-modal-title">设置</span>
              <div className="sb-subtabs">
                <button className={`sb-subtab ${modalTab === "settings" ? "active" : ""}`} onClick={() => setModalTab("settings")}>设置</button>
                <button className={`sb-subtab ${modalTab === "memory" ? "active" : ""}`} onClick={() => setModalTab("memory")} title="工作区记忆（AGENTS.md + memory/）">记忆</button>
              </div>
              <button className="mp-op" onClick={() => setModal(null)} title="关闭"><Icon name="close" size={14} /></button>
            </div>
            <div className="sb-modal-body">
              {modalTab === "settings" ? <SettingsPanel project={currentProject} projects={projects} currentWorkspace={currentWorkspace} models={models} clientId={clientId} threadId={threadId} activeModel={activeModel} onModelChange={onModelChange} onProjectUpdated={onProjectUpdated} onProjectSelect={onProjectChange} /> : <MemoryTab workspace={currentWorkspace} projectId={currentProjectId} />}
            </div>
          </div>
        </div>
      )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
