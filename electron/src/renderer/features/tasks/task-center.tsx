import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cancelRun, getRun, getRunAcceptance, listRuns, resumeRun, retryRun } from "../../api/client-api";
import { verificationLabel } from "../../lib/run-trace";
import Icon from "../../components/Icon";
import MarqueeText from "../../components/MarqueeText";
import MarkdownBody from "../../components/MarkdownBody";
import { artifactAcceptanceText, acceptanceSummaryText } from "../../lib/AcceptanceStatus";
import type { SessionRecord } from "../../components/SessionList";
import type { ProjectRecord } from "../../components/SessionSidebar";

/**
 * 任务中心（F4-1：与 client/src/components/TaskCenter.jsx 逐行等价，R11 任务运行面）。
 *
 * 数据源：client-api.ts 运行族封装（op:runs:list/get/cancel/resume/retry/acceptance，
 * S3-2 起进程内直调，签名与出参语义对齐旧 api.js——成功返回 data、失败 throw ApiError）。
 * 纯函数依赖为 F1 已迁层：run-trace.verificationLabel / AcceptanceStatus 两个投影函数。
 *
 * 桌面形态等价说明：
 *   - 旧 client 刷新由 SSE 事件驱动（eventVersion prop 由 App 在 agent 事件时自增），
 *     新形态由 createGlobalEventFeed 消费 IPC 全局事件桥后 bump 同名 state，语义一致；
 *   - 列表与徽标只读状态摘要（fields:"summary"），明细点击后由 getRun 单条加载——
 *     旧实现的带宽护栏原样保留；
 *   - onFocusRun 调用 ChatPanel.focusRun()（滚动到最新运行处）：新 ChatPanel 的
 *     focusRun 无 runId 参数（对话流已按 thread 全量装载），等价可用。
 */

/** Run 记录（协议类型为宽松投影，组件面大量可选字段按 any 宽松访问，与旧 JSX 行为一致）。 */
export type RunRecord = Record<string, any>;

export interface TaskCenterImperativeHandle {
  open(): void;
  close(): void;
}

export interface TaskCenterProps {
  sessions?: SessionRecord[];
  projects?: ProjectRecord[];
  currentProjectId?: string;
  currentWorkspace?: string;
  currentThreadId?: string;
  currentSessionId?: string;
  eventVersion?: number;
  unreadCount?: number;
  onSelectSession?: (session: SessionRecord) => unknown;
  onFocusRun?: (run: RunRecord | null | undefined) => void;
  onOpenRun?: (run: RunRecord | null | undefined) => unknown;
  fullPage?: boolean;
  onClose?: () => void;
  /** 浮层锚点（贴该元素下方）；缺省用内置触发按钮自身定位 */
  anchorRef?: { current: HTMLElement | null } | null;
  hideTrigger?: boolean;
}

const ACTIVE = new Set(["running", "queued", "waiting_user", "recovering", "cancel_requested"]);
const statusText: Record<string, string> = {
  running: "执行中",
  queued: "排队中",
  waiting_user: "等待回答",
  recovering: "恢复中",
  cancel_requested: "正在中断",
  completed: "运行结束",
  failed: "失败",
  cancelled: "已取消",
  aborted: "已中断",
};

function modeText(run: RunRecord | null | undefined) {
  const mode = run?.task?.mode;
  return mode === "chat" ? "Chat" : mode === "office" ? "Office" : mode === "agent" ? "Agent" : "未标记";
}

/** 事件摘要：把 run 级原始事件压成一行可读文本（保留技术细节在 title 里）。 */
function eventDigest(event: RunRecord | null | undefined) {
  const data = event?.data || {};
  const text = data.summary || data.message || data.detail || data.toolName || data.stepName || "";
  return String(text).replace(/\s+/g, " ").trim().slice(0, 120);
}

function taskTitle(run: RunRecord | null | undefined) {
  return String(run?.task?.goal || run?.task?.title || run?.summary || "未命名任务")
    .replace(/^\[(?:模式|当前打开文件)[^\n]*\]\s*/g, "")
    .trim()
    .slice(0, 80);
}

// 运行生命周期（服务端 run.status）与"任务是否达成"是两回事：
// 运行结束 ≠ 任务达成，必须分开表达，避免都显示成"已完成"。
function lifecycleText(run: RunRecord | null | undefined) {
  const status = run?.status || "completed";
  return statusText[status] || status;
}

// 任务达成：模型 complete_task 声明（explicit）或按终态推断（inferred）。
function completionText(run: RunRecord | null | undefined) {
  const completion = run?.completion;
  if (!completion?.status) return "";
  const base: Record<string, string> = {
    success: "任务已达成",
    partial: "部分达成",
    blocked: "任务受阻",
    failed: "任务未达成",
    cancelled: "任务已取消",
  };
  return completion.source === "inferred" ? `${base[completion.status] || "已结束"}（推断）` : base[completion.status] || "已结束";
}

// 步骤完成数（待办优先，其次执行步骤）。
function stepsText(run: RunRecord | null | undefined) {
  const progress = run?.todoProgress?.total ? run.todoProgress : run?.progress;
  if (!progress?.total) return "";
  return `步骤 ${progress.completed || 0}/${progress.total}`;
}

// 验收/验证结果（成果验收优先，其次产物校验）。
function verificationText(run: RunRecord | null | undefined) {
  const acceptance = run?.acceptanceStatus;
  if (acceptance && acceptance !== "not_checked") return verificationLabel(acceptance);
  const verification = run?.verificationStatus;
  if (verification && verification !== "not_checked" && verification !== "pending") return verificationLabel(verification);
  return "";
}

function taskMetaParts(run: RunRecord | null | undefined, projectName = "") {
  return [projectName, modeText(run), lifecycleText(run), completionText(run), stepsText(run), verificationText(run)].filter(Boolean);
}

function TaskCard({ run, selected = false, onSelect, projectName = "" }: { run: RunRecord; selected?: boolean; onSelect: (id: string) => void; projectName?: string }) {
  const status = run?.status || "completed";
  return (
    <button className={`task-center-item ${selected ? "selected" : ""}`} onClick={() => onSelect(run.id)}>
      <span className={`task-center-dot ${status}`} />
      <span className="task-center-item-main">
        <MarqueeText
          text={taskTitle(run)}
          active={ACTIVE.has(status)}
          className="task-center-item-title"
        />
      <span className="task-center-item-meta">{taskMetaParts(run, projectName).join(" · ")}</span>
      </span>
      <Icon name="chevronRight" size={12} />
    </button>
  );
}

function TaskCenterInternal({ sessions = [], projects = [], currentProjectId = "", currentWorkspace = "", currentThreadId = "", currentSessionId = "", eventVersion = 0, unreadCount = 0, onSelectSession, onFocusRun, onOpenRun, fullPage = false, onClose, anchorRef = null, hideTrigger = false }: TaskCenterProps, ref: React.ForwardedRef<TaskCenterImperativeHandle>) {
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunRecord | null>(null);
  const [error, setError] = useState("");
  const [action, setAction] = useState("");
  const [projectScope, setProjectScope] = useState("current");
  const [statusFilter, setStatusFilter] = useState("all");
  const [modeFilter, setModeFilter] = useState("all");
  const [queryFilter, setQueryFilter] = useState("");
  const [opening, setOpening] = useState(false);
  const refreshInFlightRef = useRef<Promise<unknown> | null>(null);
  const refreshQueuedRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  // B04：弹层通过 Portal 挂到应用浮层根（body），固定定位并随触发按钮/视口边缘更新，
  // 不再受祖先堆叠上下文或 overflow 影响。窄屏（≤560px）仍交给 CSS 的贴边抽屉。
  const [floatingRect, setFloatingRect] = useState<{ left: number; top: number; width: number } | null>(null);

  const updateFloatingRect = useCallback(() => {
    if (typeof window === "undefined") return;
    if (window.innerWidth <= 560) { setFloatingRect(null); return; }
    const rect = (anchorRef && anchorRef.current || triggerRef.current)?.getBoundingClientRect();
    if (!rect) return;
    const width = 344;
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    const top = Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - 160));
    setFloatingRect({ left, top, width });
    // 旧实现 deps 为 []（anchorRef 闭包陈旧可接受），逐行等价保留。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!open || fullPage) return undefined;
    updateFloatingRect();
    window.addEventListener("resize", updateFloatingRect);
    window.addEventListener("scroll", updateFloatingRect, true);
    return () => {
      window.removeEventListener("resize", updateFloatingRect);
      window.removeEventListener("scroll", updateFloatingRect, true);
    };
  }, [open, fullPage, updateFloatingRect]);

  const closePanel = useCallback(({ returnFocus = true } = {}) => {
    setOpen(false);
    setSelectedId(null);
    setDetail(null);
    // 关闭弹层后把焦点还给触发按钮，键盘用户不丢位置（对应计划 4.2 面板/命令入口）
    if (returnFocus) requestAnimationFrame(() => { const anchor = (anchorRef && anchorRef.current) || triggerRef.current; anchor?.focus?.(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 顶栏入口整合后触发钮不再常驻：外部菜单通过 ref 直接开合任务中心
  useImperativeHandle(ref, () => ({
    open: () => { setOpen(true); setSelectedId(null); setDetail(null); },
    close: () => closePanel({ returnFocus: false }),
  }), [closePanel]);

  useEffect(() => {
    if (!open || fullPage) return undefined;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") closePanel(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, fullPage, closePanel]);

  useEffect(() => {
    if (fullPage) setOpen(true);
  }, [fullPage]);

  const refresh = useCallback(async () => {
    if (refreshInFlightRef.current) {
      // SSE/IPC 事件可能在上一次列表请求返回前连续到达；记住这次刷新，
      // 否则旧响应会覆盖最新状态，任务中心要等到下一轮轮询才同步。
      refreshQueuedRef.current = true;
      return refreshInFlightRef.current;
    }
    try {
      const options = {
        cwd: projectScope === "current" ? currentWorkspace : "",
        projectId: projectScope === "current" ? currentProjectId : projectScope !== "all" ? projectScope : "",
        status: statusFilter,
        mode: modeFilter,
        query: queryFilter.trim(),
        // 列表与徽标只读状态摘要（明细点击后由 getRun 单条加载）：
        // 完整 Run 视图带步骤/待办/事件，50 条即可达 1MB 级。
        fields: "summary",
      };
      const request = listRuns("", 50, options)
        .then((result) => {
          setRuns(Array.isArray(result.runs) ? result.runs.filter(Boolean) : []);
          setError("");
        })
        .catch((e: unknown) => {
          setError((e instanceof Error ? e.message : String(e)) || "任务状态暂不可用");
        })
        .finally(() => {
          refreshInFlightRef.current = null;
          if (refreshQueuedRef.current) {
            refreshQueuedRef.current = false;
            window.setTimeout(() => { void refresh(); }, 0);
          }
        });
      refreshInFlightRef.current = request;
      return request;
    } catch (e) {
      refreshInFlightRef.current = null;
      setError((e instanceof Error ? e.message : String(e)) || "任务状态暂不可用");
      return null;
    }
  }, [currentProjectId, currentWorkspace, eventVersion, modeFilter, projectScope, queryFilter, statusFilter]);

  useEffect(() => {
    void refresh();
    // 任务状态通过事件即时刷新；轮询只作为断线兜底，避免打开面板时
    // 每 1.5 秒重复扫描服务端的全部任务记录。
    const timer = window.setInterval(() => { void refresh(); }, open ? 3000 : 10000);
    return () => window.clearInterval(timer);
  }, [open, refresh]);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    const load = async () => {
      try {
        const result = await getRun(selectedId);
        let nextRun = (result.run || result) as RunRecord;
        if (nextRun?.status === "completed" && nextRun.artifacts?.length && !nextRun.acceptance) {
          try { nextRun = ((await getRunAcceptance(selectedId)).run || nextRun) as RunRecord; } catch {}
        }
        if (!cancelled) setDetail(nextRun);
      } catch (e) {
        if (!cancelled) setError((e instanceof Error ? e.message : String(e)) || "任务详情加载失败");
      }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, 3000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [selectedId, eventVersion]);

  const runAction = useCallback(async (type: "cancel" | "resume" | "retry") => {
    if (!detail?.id || action) return;
    setAction(type);
    setError("");
    try {
      let result: RunRecord;
      if (type === "cancel") result = (await cancelRun(detail.id)) as RunRecord;
      else if (type === "resume") result = (await resumeRun(detail.id)) as RunRecord;
      else result = (await retryRun(detail.id)) as RunRecord;
      await refresh();
      const nextRun = result?.run || result;
      setDetail(nextRun?.id ? nextRun : ((await getRun(detail.id)).run as RunRecord));
      if (type !== "cancel" && nextRun?.id) onOpenRun?.(nextRun);
    } catch (e) {
      setError((e instanceof Error ? e.message : String(e)) || "任务操作失败");
    } finally {
      setAction("");
    }
  }, [detail, action, onOpenRun, refresh]);

  const counts = useMemo(() => runs.filter(Boolean).reduce((acc: Record<string, number>, run) => {
    const status = run.status || "completed";
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {}), [runs]);
  const activeCount = [...ACTIVE].reduce((total, status) => total + (counts[status] || 0), 0);
  const visibleRuns = runs.filter(Boolean).slice(0, 12);

  const openRunConversation = useCallback(async (run: RunRecord | null) => {
    if (opening) return;
    setOpening(true);
    setError("");
    const session = sessions.find((item) => item?.id && (
      item.id === run?.sessionId || item.id === run?.threadId
    ));
    try {
      if (session) {
        await onSelectSession?.(session);
      } else if (run?.threadId && (run.threadId === currentThreadId || run.sessionId === currentSessionId)) {
        // 运行中的任务在 session 文件尚未刷新时通常只有 threadId；
        // 如果正好是当前对话，直接聚焦即可。
        onFocusRun?.(run);
      } else if (run?.sessionId || run?.threadId) {
        await onOpenRun?.(run);
      } else {
        throw new Error("任务没有关联的会话");
      }
      if (fullPage) onClose?.();
      else closePanel({ returnFocus: false });
      setSelectedId(null);
      setDetail(null);
    } catch (e) {
      setError((e instanceof Error ? e.message : String(e)) || "对应会话打开失败");
    } finally {
      setOpening(false);
    }
  }, [opening, sessions, currentThreadId, currentSessionId, onSelectSession, onFocusRun, onOpenRun, fullPage, onClose, closePanel]);

  const projectNameFor = (run: RunRecord | null | undefined) => projects.find((item) => item.id === run?.projectId)?.name || "";

  const trigger = !fullPage && !hideTrigger && (
    <button
      ref={triggerRef}
      className={`btn-sm task-center-trigger ${open ? "active" : ""}`}
      onClick={() => { if (open) { closePanel(); } else { setOpen(true); setSelectedId(null); setDetail(null); } }}
      title={`任务：执行中 ${counts.running || 0}，恢复中 ${counts.recovering || 0}，运行结束 ${counts.completed || 0}`}
      aria-expanded={open}
      aria-haspopup="dialog"
    >
      <span className="task-center-trigger-icon"><Icon name="list" size={14} /></span>
      <span className="task-center-trigger-label">任务</span>
      {activeCount > 0 && <span className="task-center-badge">{activeCount}</span>}
      {unreadCount > 0 && <span className="task-center-unread" title="后台会话有新的任务状态">{unreadCount > 99 ? "99+" : unreadCount}</span>}
    </button>
  );

  const panel = (fullPage || open) && (
        <div className={`task-center-panel ${fullPage ? "task-center-page-panel" : ""}`}>
          {fullPage && <div className="module-head task-center-page-head">
            <button className="module-back" onClick={onClose} title="返回对话"><Icon name="back" size={15} /></button>
            <div><h2>任务中心</h2><p>并行任务、运行状态与历史会话</p></div>
          </div>}
          <div className="task-center-head">
            <span><Icon name="list" size={14} /> 并行任务</span>
            <button className="btn-xs" onClick={() => { void refresh(); }} title="刷新任务状态"><Icon name="refresh" size={12} /></button>
          </div>
          <div className="task-center-filters">
            <select value={projectScope} onChange={(e) => setProjectScope(e.target.value)} title="项目范围">
              <option value="current">当前项目</option>
              <option value="all">全部项目</option>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} title="任务状态">
              <option value="all">全部状态</option>
              {Object.entries(statusText).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
            <select value={modeFilter} onChange={(e) => setModeFilter(e.target.value)} title="任务模式">
              <option value="all">全部模式</option><option value="chat">Chat</option><option value="office">Office</option><option value="agent">Agent</option>
            </select>
            <input value={queryFilter} onChange={(e) => setQueryFilter(e.target.value)} placeholder="搜索任务或失败原因" title="搜索任务目标、摘要或失败原因" />
          </div>
          <div className="task-center-summary">
            <span>执行中 {counts.running || 0}</span>
            <span>排队中 {counts.queued || 0}</span>
            <span>运行结束 {counts.completed || 0}</span>
          </div>
          {error && <div className="task-center-error">{error}</div>}
          {!detail ? (
            <div className="task-center-list">
              {visibleRuns.length ? visibleRuns.map((run) => <TaskCard key={run.id} run={run} projectName={projectNameFor(run)} onSelect={(id) => {
                setSelectedId(id);
              }} />) : <div className="task-center-empty">暂无任务记录</div>}
            </div>
          ) : (
            <div className="task-center-detail">
              <button className="task-center-back" onClick={() => { setSelectedId(null); setDetail(null); }}><Icon name="back" size={12} /> 返回任务列表</button>
              <div className="task-center-detail-title">{taskTitle(detail)}</div>
              <div className="task-center-detail-meta">{taskMetaParts(detail, projectNameFor(detail) || "当前项目").join(" · ")}</div>
              <div className="task-center-status">
                <div className="task-center-status-row"><span>运行状态</span><b>{lifecycleText(detail)}</b></div>
                <div className="task-center-status-row"><span>任务达成</span><b>{detail.completion ? completionText(detail) : "模型未声明"}</b></div>
                <div className="task-center-status-row"><span>步骤进度</span><b>{stepsText(detail) || "无步骤记录"}</b></div>
                <div className="task-center-status-row"><span>验收结果</span><b>{verificationText(detail) || "未验收"}</b></div>
              </div>
              {detail.completion?.summary && <div className="task-center-completion-note task-center-completion-markdown"><div className="task-center-completion-label">完成说明</div><MarkdownBody>{detail.completion.summary}</MarkdownBody></div>}
              {!!detail.completion?.incomplete?.length && <div className="task-center-completion-note warn">未完成项：{detail.completion.incomplete.join("；")}</div>}
              {!!detail.completion?.blockers?.length && <div className="task-center-completion-note warn">受阻项：{detail.completion.blockers.join("；")}</div>}
              {detail.completion?.verification && <div className="task-center-completion-note">验证说明：{detail.completion.verification}</div>}
              <button className="btn-xs task-center-open-chat" onClick={() => { void openRunConversation(detail); }} disabled={opening}>{opening ? "切换中…" : "打开对应对话"}</button>
              <div className="task-center-actions">
                {detail.actions?.canCancel && <button className="btn-xs danger" onClick={() => { void runAction("cancel"); }} disabled={!!action}>{action === "cancel" ? "取消中…" : "取消任务"}</button>}
                {detail.actions?.canResume && <button className="btn-xs" onClick={() => { void runAction("resume"); }} disabled={!!action}>{action === "resume" ? "继续中…" : "继续任务"}</button>}
                {detail.actions?.canRetry && <button className="btn-xs" onClick={() => { void runAction("retry"); }} disabled={!!action}>{action === "retry" ? "重试中…" : "重试任务"}</button>}
              </div>
              {detail.error && <div className="task-center-detail-error">失败原因：{detail.error}</div>}
              {detail.todoVersion === 1 && <div className="task-center-todos">
                <div className="task-center-section-title">
                  <span>任务清单</span>
                  <small>{detail.todoProgress?.completed || 0}/{detail.todoProgress?.total || 0} 完成</small>
                </div>
                {(detail.todos || []).map((todo: RunRecord) => (
                  <div className={`task-center-todo ${todo.status}`} key={todo.id}>
                    <span>{["completed", "skipped"].includes(todo.status) ? "✓" : todo.status === "failed" ? "!" : todo.status === "blocked" ? "×" : todo.status === "in_progress" ? "•" : "○"}</span>
                    <span>{todo.title}</span>
                    {todo.note && <small title={todo.note}>{todo.note}</small>}
                  </div>
                ))}
              </div>}
              <div className="task-center-steps">
                <div className="task-center-section-title"><span>执行步骤</span><small>{detail.steps?.length || 0} 项</small></div>
                {(detail.steps || []).map((step: RunRecord) => (
                  <div className={`task-center-step ${step.status}`} key={step.id}>
                    <span>{step.status === "completed" ? "✓" : ["running", "in_progress"].includes(step.status) ? "•" : step.status === "failed" ? "!" : "○"}</span>
                    <span>{step.name}</span>
                    {step.error && <small>{step.error}</small>}
                  </div>
                ))}
              </div>
              {!!detail.artifacts?.length && <div className="task-center-artifacts">
                <div>{acceptanceSummaryText(detail.acceptanceStatus, detail.status)} · 产物 {detail.artifacts.length} 个</div>
                {detail.acceptance?.artifacts?.map((item: RunRecord) => <div className="task-center-artifact-check" key={item.path}><span>{String(item.path || "").split(/[\\/]/).pop()}</span><small>{artifactAcceptanceText(item.status)}</small></div>)}
              </div>}
              <div className="task-center-events">
                {(detail.events || []).slice(-12).reverse().map((event: RunRecord, index: number) => (
                  <div key={`${event.seq || "event"}-${index}`}>
                    <span>{event.type}</span>
                    {eventDigest(event) && <small className="task-center-event-digest" title={eventDigest(event)}>{eventDigest(event)}</small>}
                    <small>{event.at ? new Date(event.at).toLocaleTimeString() : ""}</small>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      );

  if (fullPage) return <div className="module-view task-center-module">{panel}</div>;
  // 浮层走 Portal：trigger 留在原位负责定位与焦点归还，面板挂到 body
  const floatingPanel = floatingRect && open && typeof document !== "undefined"
    ? createPortal(
      <div className="task-center-float" style={{ left: floatingRect.left, top: floatingRect.top, width: floatingRect.width }}>{panel}</div>,
      document.body,
    )
    : (open ? panel : null);
  return <div className="task-center-wrap">{trigger}{floatingPanel}</div>;
}

const TaskCenter = forwardRef(TaskCenterInternal);
export default TaskCenter;
