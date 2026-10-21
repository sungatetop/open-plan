/**
 * 执行流展示件（F3 批6d-1）：自 client/src/components/ChatPanel.jsx 拆出的
 * SSE 执行流组件（运行时跟随消息流，完成后可折叠回看），与原实现逐行等价，
 * 对拍强制 tests/f3-batch6d1-parity.test.tsx。轨迹归约/阶段标签复用 F1 已迁层。
 */
import React, { useState, useRef, useEffect, useMemo } from "react";
import Icon from "../../components/Icon";
import ToolIdentityIcon from "../../components/SemanticToolIcon";
import AgentBrainGraph from "../../components/AgentBrainGraph";
import { STAGE_ONLY_EVENTS, PHASE_LABELS, flowEventLabel, flowEventTone } from "../../lib/event-display";
import { reduceRunTrace, summarizeRunTrace, runTraceSummaryText, runTraceProgressText, completionLabel } from "../../lib/run-trace";

/** 宽松结构类型（已知字段之外全走索引签名，对齐 chat-shared 的视图类型约定）。 */
export interface FlowEventItem {
  key?: string;
  type: string;
  data?: {
    message?: string;
    name?: string;
    toolCallId?: string;
    files?: string[];
    source?: string;
    [key: string]: unknown;
  } | null;
  at?: string;
  seq?: number;
  id?: number;
  [key: string]: unknown;
}

export interface ExecutionNote {
  key: string;
  kind?: string;
  text?: string;
  count?: number | string;
  [key: string]: unknown;
}

export interface StatusChip {
  key: string;
  label?: string;
  title?: string;
  [key: string]: unknown;
}

export interface PendingApprovalInfo {
  tool?: string;
  [key: string]: unknown;
}

export function ExecutionFlow({ events = [], running = false, onFocusTool, notes = [], note = "", compaction = null, hidden = false, defaultExpanded = false, onHiddenChange, statusText = "", statusChips = [], statusDotClass = "", nextStep = "", pendingApproval = null, onLocateApproval, embedded = false }: {
  events?: FlowEventItem[];
  running?: boolean;
  onFocusTool?: (toolCallId: string) => void;
  notes?: ExecutionNote[];
  note?: string;
  compaction?: { count?: number | string; [key: string]: unknown } | null;
  hidden?: boolean;
  defaultExpanded?: boolean;
  onHiddenChange?: (hidden: boolean) => void;
  statusText?: string;
  statusChips?: StatusChip[];
  statusDotClass?: string;
  nextStep?: string;
  pendingApproval?: PendingApprovalInfo | null;
  onLocateApproval?: (approval: PendingApprovalInfo) => void;
  embedded?: boolean;
}) {
  // 运行时自动展开并跟随最新事件；结束后收束为一行，可随时展开回看。
  // 隐藏状态仍由用户设置控制；折叠/展开偏好只影响空闲时和下一轮启动前。
  const [expanded, setExpanded] = useState(Boolean(defaultExpanded || running));
  const defaultExpandedRef = useRef(Boolean(defaultExpanded));
  useEffect(() => {
    if (defaultExpandedRef.current === Boolean(defaultExpanded)) return;
    defaultExpandedRef.current = Boolean(defaultExpanded);
    setExpanded(Boolean(defaultExpanded));
  }, [defaultExpanded]);
  const [notesOpen, setNotesOpen] = useState(false);
  // 事件明细列表默认折叠（只保留一行摘要）；运行中的过程内容由消息级区域平铺展示
  const executionListRef = useRef<HTMLDivElement | null>(null);
  const followExecutionTailRef = useRef(true);
  const wasRunningRef = useRef(running);
  // 纯阶段状态事件（准备/受理/请求模型/回合切换等）合并为一行，不逐条刷屏；清单来自事件展示注册表
  const contentEvents = events.filter((event) => !STAGE_ONLY_EVENTS.has(event.type));
  const latest = contentEvents[contentEvents.length - 1] || events[events.length - 1];
  const visibleEvents: FlowEventItem[] = contentEvents.length > 0
    ? contentEvents
    : (running ? [{ key: "local:stream_waiting", type: "stream_waiting", data: {}, at: new Date().toISOString() }] : []);
  // 归约为执行轨迹：工具按 toolCallId 聚合，折叠态展示聚合统计而不是最后一条事件
  const runTrace = useMemo(() => reduceRunTrace(contentEvents), [contentEvents]);
  const traceStats = summarizeRunTrace(runTrace);
  const traceSummary = runTraceSummaryText(runTrace);
  const completion = traceStats.completion;
  const handleExecutionScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const list = event.currentTarget;
    followExecutionTailRef.current = list.scrollHeight - list.scrollTop - list.clientHeight <= 28;
  };
  const toggleExpanded = () => {
    setExpanded((value) => {
      const next = !value;
      if (next && running) followExecutionTailRef.current = true;
      return next;
    });
  };
  useEffect(() => {
    const wasRunning = wasRunningRef.current;
    if (running && !wasRunning) {
      followExecutionTailRef.current = true;
      setExpanded(true);
    } else if (!running && wasRunning) {
      setExpanded(false);
    }
    wasRunningRef.current = running;
  }, [running]);
  useEffect(() => {
    const list = executionListRef.current;
    if (!expanded || !running || !list || !followExecutionTailRef.current) return;
    list.scrollTop = list.scrollHeight;
  }, [visibleEvents, expanded, running]);
  // 运行中的进度行：秒级刷新"用时"，让长任务一眼看出进行到哪一步
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  const progressText = runTraceProgressText(runTrace, { now, running });
  // 去重：同一工具的“调用/完成”只保留一行（完成行），避免同一动作刷三条。
  const endedToolCalls = new Set(contentEvents.filter((event) => event.type === "tool_end")
    .map((event) => String(event.data?.toolCallId || "")).filter(Boolean));
  const endedToolNames = new Set(contentEvents.filter((event) => event.type === "tool_end")
    .map((event) => String(event.data?.name || "")).filter(Boolean));
  const dedupedEvents = visibleEvents.filter((event, index, list) => {
    // 连接重试：连续重试只保留最后一条；“已恢复”不再单独成行（由输入框旁状态点承担）
    if (event.type === "agent_retry_end") return false;
    if (event.type === "agent_retry") return !(list[index + 1]?.type === "agent_retry");
    if (event.type !== "tool_start") return true;
    const id = String(event.data?.toolCallId || "");
    if (id) return !endedToolCalls.has(id);
    const name = String(event.data?.name || "");
    return !(name && endedToolNames.has(name));
  });
  // 事件行：文案/明细/语气/时间（只服务非嵌入的独立执行流；消息流不再摊开事件时间线）。
  const eventRow = (event: FlowEventItem, index: number) => {
    const data = event.data || {};
    const internalProgressSignal = event.type === "steer" && /^(turn-progress|turn-budget)/.test(String(data.source || ""));
    const detail = internalProgressSignal ? "" : data.message || (event.type === "tool_start" ? "" : event.type === "file_changed" ? (data.files || []).join(", ") : "");
    const label = flowEventLabel(event);
    const showDetail = detail && String(detail).trim() !== String(label).trim();
    return (
      <div className={`execution-flow-item ${flowEventTone(event)}`} key={event.key || `${event.seq || event.id || index}:${event.type}`}>
        <span className="execution-flow-dot" />
        {(event.type === "tool_start" || event.type === "tool_end") && data.name && <ToolIdentityIcon name={data.name} size={12} className="tool-identity-inline" />}
        <span className="execution-flow-label">{label}</span>
        {showDetail && <span className="execution-flow-detail" title={detail}>{String(detail).slice(0, 100)}</span>}
        <time>{event.at ? new Date(event.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : ""}</time>
      </div>
    );
  };
  const eventRows = dedupedEvents.map((event, index) => eventRow(event, index));
  if (!visibleEvents.length) return null;
  if (hidden) {
    return (
      <div className="execution-flow execution-flow-hidden">
        <button type="button" onClick={() => onHiddenChange?.(false)}>
          <Icon name="eye" size={12} /> 显示执行流 <span>{events.length ? `${events.length} 个事件` : "等待首个事件"}</span>
        </button>
      </div>
    );
  }
  if (embedded) {
    // 消息流里不再摊开 SSE 事件时间线（计划/执行/验证/交付 逐条事件属于诊断信息，
    // 右栏「事件」页签与任务中心保留完整轨迹）。这里只留需要用户知道的系统提示；
    // 每轮用时与 token 由结果卡的「每轮明细」承担。
    if (!notes.length) return null;
    return (
      <div className="execution-flow-embedded" aria-label="系统提示">
        <div className="execution-flow-embedded-notes">
          {notes.map((item) => <div key={item.key} className={`efn-item kind-${item.kind || "info"}`}><span className="efn-text">{item.text}</span>{Number(item.count) > 1 && <span className="efn-count">×{item.count}</span>}</div>)}
        </div>
      </div>
    );
  }
  const phaseLabel = (PHASE_LABELS as Record<string, string>)[runTrace.phase] || "执行";
  return (
    <div className={`execution-flow ${expanded ? "expanded" : ""} ${running ? "live" : ""}`}>
      <div className="execution-flow-head">
        <button type="button" className="execution-flow-toggle" onClick={toggleExpanded} aria-expanded={expanded}>
          <span className="execution-flow-chevron">{expanded ? "▾" : "▸"}</span>
          <Icon name="flow" size={12} />
          <strong>执行过程</strong>
          <span className="execution-flow-count">{contentEvents.length ? `${contentEvents.length} 个事件` : "等待首个事件"}</span>
          <span className="execution-flow-current">{traceSummary || flowEventLabel(latest || visibleEvents[0])}</span>
          {completion && (
            <span
              className={`flow-completion ${completion.status}`}
              title={completion.source === "inferred" ? "由回合结束推断（模型未显式声明完成状态）" : `模型显式声明${completion.summary ? `：${completion.summary}` : ""}`}
            >
              {completionLabel(completion.status)}
            </span>
          )}
          {running && <span className="execution-flow-live"><i /> 实时</span>}
        </button>
        <button type="button" className="execution-flow-hide" onClick={() => onHiddenChange?.(true)} title="隐藏当前执行过程" aria-label="隐藏执行流"><Icon name="eyeOff" size={12} /></button>
      </div>
      {/* 运行状态行：并入原独立状态栏，只占一条，避免上下两条横栏重复 */}
      {(statusText || statusChips.length > 0 || pendingApproval) && (
        <div className="execution-flow-status" role="status" aria-live="polite">
          <span className={`task-status-dot ${statusDotClass}`} />
          <span className="efs-text">{statusText}</span>
          {statusChips.map((chip) => (
            <span className="efs-chip" key={chip.key} title={chip.title || ""}>{chip.label}</span>
          ))}
          {pendingApproval && (
            <button
              type="button"
              className="efs-approval"
              onClick={() => onLocateApproval?.(pendingApproval)}
              title="定位到需要你审批的工具卡片；任务中心里也能打开同一条运行"
            >
              <Icon name="shield" size={12} /> 待批准：{pendingApproval.tool || "工具"} · 去处理
            </button>
          )}
        </div>
      )}
      {/* 只显示当前关键步骤与下一步；详细事件留在可展开的执行轨迹里 */}
      {running && nextStep && (
        <div className="execution-flow-next" role="status" aria-live="polite">
          <span className="efn-next"><Icon name="arrowRight" size={12} /> {nextStep}</span>
        </div>
      )}
      {/* 进度行：只在运行中出现——"现在到哪一步 / 还要多久 / 最近说了什么" */}
      {running && (progressText || note) && (
        <div className={`execution-flow-progress phase-${runTrace.phase}`} title={note ? `最近小结：${note}` : progressText}>
          <span className="efp-pulse" aria-hidden="true" />
          <span className="efp-phase">{phaseLabel}</span>
          {progressText && <span className="efp-items">{progressText}</span>}
          {note && <span className="efp-note">{note}</span>}
        </div>
      )}
      {/* 系统提示聚合：压缩 / 文件变更等只留一条可展开摘要，不再逐条堆气泡 */}
      {notes.length > 0 && (
        <div className={`execution-flow-notes ${notesOpen ? "open" : ""}`}>
          <button type="button" className="efn-toggle" onClick={() => setNotesOpen((value) => !value)} aria-expanded={notesOpen}>
            <Icon name="info" size={12} />
            <span>系统提示 {notes.length} 条</span>
            {Number(compaction?.count) > 0 && <span className="efn-chip">上下文压缩 {compaction!.count} 次</span>}
            {notes.some((item) => item.kind === "file") && <span className="efn-chip">文件变更</span>}
            {notes.some((item) => item.kind === "progress") && <span className="efn-chip">进度播报</span>}
            <span className="efn-chevron">{notesOpen ? "▾" : "▸"}</span>
          </button>
          {notesOpen && (
            <div className="efn-list">
              {notes.map((item) => (
                <div className={`efn-item kind-${item.kind || "info"}`} key={item.key}>
                  <span className="efn-text">{item.text}</span>
                  {Number(item.count) > 1 && <span className="efn-count">×{item.count}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {expanded && (
        <>
          {/* 脑回路执行图：工具按类别聚合，点击可在消息流中定位工具卡 */}
          <AgentBrainGraph trace={runTrace} running={running} onFocusTool={onFocusTool} />
          <div className="execution-flow-list" ref={executionListRef} onScroll={handleExecutionScroll}>
          {eventRows}
          </div>
        </>
      )}
    </div>
  );
}
