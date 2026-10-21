/**
 * 对话交互卡片族（F3 批6d-1）：自 client/src/components/ChatPanel.jsx 拆出的
 * 交互层叶子组件（待处理条 / 提问卡 / 审批卡 / 上下文用量圈 / 审批模式开关 /
 * 任务进度卡），与原实现逐行等价，对拍强制 tests/f3-batch6d1-parity.test.tsx。
 *
 * 架构性等价替换（BRD-009）：旧组件内联 fetch("/api/agent/approval"、"/api/agent/answer")
 * → IPC 通道 op:agent:approval / op:agent:answer；404 失效分支按 ApiError.status 判定，
 * 失败文案形状（服务端 error → 「label（status）」→「label，请重试」）保持一致。
 */
import React, { useState, useRef, useEffect, useLayoutEffect } from "react";
import Icon from "../../components/Icon";
import { submitAgentApproval, answerAgentQuestion, ApiError } from "../../api/client-api";
import { usageDetails, modelDisplayName } from "../../lib/chat-shared";
import { formatTokenCount } from "../../lib/run-trace";

/** 宽松结构类型（已知字段之外全走索引签名，对齐 chat-shared 的视图类型约定）。 */
export interface ApprovalLike {
  id?: string;
  tool?: string;
  input?: string;
  decision?: string;
  owner?: InteractionOwner | null;
  [key: string]: unknown;
}

export interface AskLike {
  id?: string;
  question?: string;
  answer?: string;
  options?: string[];
  expired?: boolean;
  owner?: InteractionOwner | null;
  [key: string]: unknown;
}

export interface InteractionOwner {
  kind?: string;
  id?: string;
  [key: string]: unknown;
}

/** 旧内联 fetch 的失败文案形状：服务端 error 文案 → 「label（status）」（error 缺省时）→「label，请重试」（message 为空时）。 */
function inlineFetchErrorText(error: unknown, label: string): string {
  if (error instanceof ApiError) {
    // invokeOrThrow 对缺省 error 的信封给「HTTP <status>」占位，映射回旧文案形状
    return /^HTTP \d+$/.test(error.message) ? `${label}（${error.status}）` : error.message;
  }
  return (error instanceof Error && error.message) || `${label}，请重试`;
}

// ============================================================================
// 输入栏常驻待处理条：待审批可直接允许/拒绝，待回答可直接提交；
// 折叠过程收起或正在回看历史时，不必先找到卡片再操作。
// ============================================================================

export function PendingActionBar({ approval, ask, onLocateApproval, onLocateAsk, clientId, threadId, onAnswered, onExpired }: {
  approval?: ApprovalLike | null;
  ask?: AskLike | null;
  onLocateApproval?: () => void;
  onLocateAsk?: () => void;
  clientId?: string | null;
  threadId?: string | null;
  onAnswered?: (askId: unknown, answer: string) => void;
  onExpired?: (askId: unknown) => void;
}) {
  const [sending, setSending] = useState("");
  const [error, setError] = useState("");
  const [answer, setAnswer] = useState("");
  if (!approval && !ask) return null;
  const toolNames: Record<string, string> = { officecli: "Office CLI", bash: "命令", write: "写入文件", map_edit: "地图样式编辑", map_import: "地图数据导入" };
  const approvalLabel = toolNames[String(approval?.tool || "").toLowerCase()] || approval?.tool || "工具";

  const decide = async (decision: "allow" | "deny") => {
    if (sending || !approval?.id) return;
    setSending("approval");
    setError("");
    try {
      await submitAgentApproval(approval.id, decision);
    } catch (e) {
      setError(inlineFetchErrorText(e, "审批提交失败"));
    }
    setSending("");
  };

  const submitAnswer = async (text?: string) => {
    const value = String(text ?? answer).trim();
    if (!value || sending) return;
    setSending("ask");
    setError("");
    try {
      await answerAgentQuestion(String(clientId ?? ""), threadId ?? null, value);
      onAnswered?.(ask?.id, value);
      setAnswer("");
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        // 服务端已无该问题（5 分钟窗口已过或已在别处回答）：收起卡片，
        // 而不是留一张点得动、一发就报 no pending question 的死卡片。
        onExpired?.(ask?.id);
        setError("该问题已失效（超过 5 分钟未回答或已在别处回答），回答未提交");
      } else {
        setError(inlineFetchErrorText(e, "回答失败"));
      }
    }
    setSending("");
  };

  return (
    <div className="pending-action-bar" role="status" aria-live="polite">
      {approval && (
        <>
          <span className="pending-action-label"><Icon name="shield" size={12} /> 待审批：{approvalLabel}</span>
          <span className="pending-action-command" title={String(approval.input || "")}>{String(approval.input || "").slice(0, 80)}</span>
          <span className="pending-action-buttons">
            <button className="btn primary" onClick={() => decide("allow")} disabled={Boolean(sending)}>允许一次</button>
            <button className="btn" onClick={() => decide("deny")} disabled={Boolean(sending)}>拒绝</button>
            <button className="btn-xs" onClick={onLocateApproval} title="滚动到审批卡片">定位</button>
          </span>
        </>
      )}
      {ask && (
        <>
          <span className="pending-action-label"><Icon name="comment" size={12} /> 待回答：{String(ask.question || "").slice(0, 120)}</span>
          {(ask.options?.length ?? 0) > 0 && (
            <span className="pending-action-buttons">
              {ask.options!.map((opt, i) => <button key={i} className="btn-xs" onClick={() => submitAnswer(opt)} disabled={Boolean(sending)}>{opt}</button>)}
            </span>
          )}
          <input
            className="pending-action-input"
            placeholder="输入你的回答…"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submitAnswer(); } }}
          />
          <span className="pending-action-buttons">
            <button className="btn primary" onClick={() => submitAnswer()} disabled={Boolean(sending) || !answer.trim()}>{sending === "ask" ? "…" : "发送"}</button>
            <button className="btn-xs" onClick={onLocateAsk} title="滚动到提问卡片">定位</button>
          </span>
        </>
      )}
      {error && <span className="pending-action-error" role="alert">{error}</span>}
    </div>
  );
}

// ============================================================================
// 主动提问卡片（ask_user：agent 遇不明确处询问用户）
// ============================================================================

export function AskBlock({ block, clientId, threadId, onAnswered, onExpired }: {
  block: AskLike;
  clientId?: string | null;
  threadId?: string | null;
  onAnswered?: (askId: unknown, answer: string) => void;
  onExpired?: (askId: unknown) => void;
}) {
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  // 提问有 5 分钟时间窗口：服务端超时后按假设继续，卡片必须同步失效而不是继续接受输入。
  const expired = Boolean(block.expired);

  const submit = async (text?: string) => {
    const answer = (text || "").trim();
    if (!answer || sending || expired) return;
    setSending(true);
    setError("");
    try {
      await answerAgentQuestion(String(clientId ?? ""), threadId ?? null, answer);
      onAnswered?.(block.id, answer);
      setInput("");
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        onExpired?.(block.id);
        setError("该问题已失效（超过 5 分钟未回答或已在别处回答），回答未提交");
      } else {
        setError(inlineFetchErrorText(e, "回答失败"));
      }
    }
    setSending(false);
  };

  return (
    <div className={`ask-block ${block.answer ? "answered" : ""} ${expired ? "expired" : ""}`}>
      <div className="ask-head">
        <Icon name="comment" size={12} />
        <span className="ask-title">需要你确认</span>
        {(() => { const 归属 = 交互归属文案(block.owner); return 归属 ? <span className="interaction-owner" title={归属.title}>{归属.text}</span> : null; })()}
        {block.answer && <span className="ask-status">✓ 已回答</span>}
        {!block.answer && expired && <span className="ask-status expired">已超时</span>}
      </div>
      <div className="ask-question">{block.question}</div>
      {block.answer ? (
        <div className="ask-answer">你的回答：{block.answer}</div>
      ) : expired ? (
        <div className="ask-expired" role="status">
          超过 5 分钟未回答，Agent 已按自己的假设继续（本轮不再接受该问题的回答）。如需修正，请直接在下方输入消息说明。
        </div>
      ) : (
        <>
          {(block.options?.length ?? 0) > 0 && (
            <div className="ask-options">
              {block.options!.map((opt, i) => (
                <button key={i} className="ask-opt" onClick={() => submit(opt)}>{opt}</button>
              ))}
            </div>
          )}
          <div className="ask-input-row">
            <input
              className="ask-input"
              placeholder="输入你的回答…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(input); } }}
            />
            <button className="btn primary ask-submit" onClick={() => submit(input)} disabled={sending}>
              {sending ? "…" : "发送"}
            </button>
          </div>
          {error && <div className="ask-error" role="alert">{error}</div>}
        </>
      )}
    </div>
  );
}

// ============================================================================
// 工具审批卡片（opencode 式：允许一次 / 总是允许 / 拒绝）
// ============================================================================

/**
 * Qoder P1-4：交互归属文案。仅在服务端开关 qoderInteractionOwner 打开时，
 * ask_user / tool_approval_request 载荷才带 owner；关闭时 block.owner 为 null，不渲染标签。
 */
export function 交互归属文案(owner: InteractionOwner | null | undefined): { text: string; title: string } | null {
  const kind = String(owner?.kind || "");
  const id = String(owner?.id || "");
  const short = id.length > 18 ? `${id.slice(0, 15)}…` : id;
  if (kind === "subagent") return { text: `来自子代理${short ? ` · ${short}` : ""}`, title: `该交互由子代理 ${id} 发起` };
  if (kind === "turn") return { text: "来自本轮任务", title: `该交互属于本轮 Run ${id}` };
  if (kind === "session") return { text: "来自会话", title: `该交互属于会话 ${id}` };
  return null;
}

export function ApprovalBlock({ block }: {
  block: ApprovalLike;
}) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const toolNames: Record<string, string> = {
    officecli: "Office CLI", bash: "命令", write: "写入文件", map_edit: "地图样式编辑", map_import: "地图数据导入",
  };
  const toolLabel = toolNames[String(block.tool).toLowerCase()] || block.tool || "工具";

  const decide = async (decision: "allow" | "always" | "deny") => {
    if (sending || block.decision) return;
    setSending(true);
    setError("");
    try {
      // 旧实现 body.id 原样透传（block.id 缺失时 JSON.stringify 丢弃该键，此处 cast 保真）
      await submitAgentApproval(block.id as string, decision);
    } catch (e) {
      setError(inlineFetchErrorText(e, "审批提交失败"));
    }
    setSending(false);
  };

  return (
    <div className={`approval-block ${block.decision ? "resolved" : ""}`} data-approval-id={block.id || ""} tabIndex={-1}>
      <div className="approval-head">
        <Icon name="shield" size={12} />
        <span className="approval-title">需要审批：{toolLabel}</span>
        {(() => { const 归属 = 交互归属文案(block.owner); return 归属 ? <span className="interaction-owner" title={归属.title}>{归属.text}</span> : null; })()}
        {block.decision === "allow" && <span className="approval-status">✓ 已允许（仅本次）</span>}
        {block.decision === "always" && <span className="approval-status">✓ 已总是允许（全局规则）</span>}
        {block.decision === "deny" && <span className="approval-status denied">✕ 已拒绝</span>}
      </div>
      <div className="approval-command">{block.input}</div>
      {block.decision && (
        <div className="approval-scope resolved-scope">
          {block.decision === "always"
            ? "已写入本机全局规则：同类命令跨会话、跨项目、跨工作区不再询问，可在「设置 → 审批与权限」撤销。"
            : block.decision === "allow"
              ? "只放行本次调用，不影响后续同类命令。"
              : "已拒绝本次调用，Agent 不会再执行这条命令。"}
        </div>
      )}
      {!block.decision && (
        <>
          <div className="approval-actions">
            <button className="btn primary approval-allow" onClick={() => decide("allow")} disabled={sending}>允许一次</button>
            <button className="btn approval-always" onClick={() => decide("always")} disabled={sending} title="写入本机全局权限规则：同一工具的同类命令不再逐次询问，跨会话、跨项目立即生效，可在设置中撤销">总是允许</button>
            <button className="btn approval-deny" onClick={() => decide("deny")} disabled={sending}>拒绝</button>
          </div>
          <div className="approval-scope">
            「总是允许」会把规则写入本机全局配置（跨会话、跨项目、跨工作区生效），可在「设置 → 审批与权限」随时撤销。
          </div>
          {error && <div className="ask-error" role="alert">{error}</div>}
        </>
      )}
    </div>
  );
}

// ============================================================================
// Proma 风格上下文用量圈
// ============================================================================

export interface CompactionInfo {
  count?: number;
  at?: string;
  tokensBefore?: number;
  [key: string]: unknown;
}

export function ContextUsageRing({ usage, contextWindow, contextTokens, compactThreshold, compactionMode, compactionReserveTokens, compactionKeepRecentTokens, compaction, model, compacting, busy, onCompact }: {
  usage: Record<string, unknown> | null | undefined;
  contextWindow: number;
  contextTokens: number;
  compactThreshold?: unknown;
  compactionMode?: string | null;
  compactionReserveTokens?: unknown;
  compactionKeepRecentTokens?: unknown;
  compaction?: CompactionInfo | null;
  model?: Record<string, unknown> | null;
  compacting?: boolean;
  busy?: boolean;
  onCompact?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const percentage = Math.min(100, Math.round((contextTokens / Math.max(1, contextWindow)) * 100));
  const hasThreshold = Number(compactThreshold) > 0;
  const thresholdPercentage = hasThreshold ? Math.min(100, Math.round((Number(compactThreshold) / Math.max(1, contextWindow)) * 100)) : null;
  const tone = percentage >= 85 ? "danger" : percentage >= 60 ? "warning" : "ok";
  const reserveTokens = Number(compactionReserveTokens) > 0 ? Number(compactionReserveTokens) : 0;
  const keepRecentTokens = Number(compactionKeepRecentTokens) > 0 ? Number(compactionKeepRecentTokens) : 0;
  const compactCount = Number(compaction?.count || 0);
  const radius = 14;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (circumference * percentage) / 100;
  const details = usageDetails(usage);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  return (
    <div className={`context-ring-wrap ${open ? "open" : ""}`} ref={wrapRef}>
      <button
        type="button"
        className={`context-ring-button ${tone}`}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        title={`上下文 ${formatTokenCount(contextTokens)} / ${formatTokenCount(contextWindow)} tokens${hasThreshold ? ` · 压缩线 ${formatTokenCount(compactThreshold)}` : ""}`}
      >
        <span className="context-ring-svg" aria-hidden="true">
          <svg viewBox="0 0 36 36">
            <circle className="context-ring-track" cx="18" cy="18" r={radius} />
            <circle className="context-ring-progress" cx="18" cy="18" r={radius} style={{ strokeDasharray: circumference, strokeDashoffset: offset }} />
          </svg>
          <strong>{percentage}%</strong>
        </span>
        <span className="context-ring-label"><b>上下文</b><small>{formatTokenCount(contextTokens)}</small></span>
      </button>
      {open && (
        <div className="context-ring-pop" role="dialog" aria-label="上下文用量">
          <div className="context-ring-pop-head">
            <span><strong>上下文记录</strong><small>{modelDisplayName(model)}</small></span>
            <span className={`context-ring-percent ${tone}`}>{percentage}%</span>
          </div>
          <div className="context-ring-meter">
            <i style={{ width: `${percentage}%` }} />
            {hasThreshold && thresholdPercentage !== null && thresholdPercentage < 100 && <em className="context-ring-marker" style={{ left: `${thresholdPercentage}%` }} title={`压缩线 ${thresholdPercentage}%`} />}
          </div>
          <div className="context-ring-stats">
            <span>当前 <b>{contextTokens.toLocaleString()}</b></span>
            <span>上限 <b>{contextWindow.toLocaleString()}</b></span>
            <span>压缩机制 <b>{compactionMode === "pi-native" ? "Pi 自动" : compactionMode === "app-fallback" ? "未知模型兜底" : "手动"}</b></span>
          </div>
          <div className="context-ring-budget">
            <div className="crb-row">
              <span>压缩线</span>
              <b>{hasThreshold ? `${Number(compactThreshold).toLocaleString()} tokens（${thresholdPercentage}%）` : "已关闭"}</b>
            </div>
            <div className="crb-hint">
              {hasThreshold && reserveTokens > 0
                ? `= 窗口 ${contextWindow.toLocaleString()} − 预留 ${reserveTokens.toLocaleString()} tokens（留给回复与工具调用）`
                : "当前模型没有自动压缩线，需要手动压缩。"}
            </div>
            <div className="crb-row">
              <span>压缩后保留</span>
              <b>{keepRecentTokens > 0 ? `最近 ${keepRecentTokens.toLocaleString()} tokens` : "由服务端决定"}</b>
            </div>
            <div className="crb-row">
              <span>上次压缩</span>
              <b>
                {compactCount > 0
                  ? `${compactCount} 次${compaction?.at ? ` · ${new Date(compaction.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}` : ""}${compaction?.tokensBefore ? ` · 压缩前 ${Number(compaction.tokensBefore).toLocaleString()}` : ""}`
                  : "本次会话尚未压缩"}
              </b>
            </div>
            <div className="crb-hint">进度圈变色（60% 提醒 / 85% 偏高）只是观感提示；真正触发压缩的是压缩线，不是这两个颜色。</div>
          </div>
          <div className="context-ring-breakdown">
            <span>输入 {details.input.toLocaleString()}</span>
            <span>缓存读 {details.cacheRead.toLocaleString()}</span>
            <span>缓存写 {details.cacheWrite.toLocaleString()}</span>
            <span>输出 {details.output.toLocaleString()}</span>
          </div>
          <button type="button" className="context-ring-compact" onClick={onCompact} disabled={busy || compacting}>
            <Icon name={compacting ? "loading" : "layers"} size={12} className={compacting ? "icon-loading" : ""} />
            {compacting ? "压缩中…" : busy ? "任务完成后可压缩" : "压缩上下文"}
          </button>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Codex 风格审批模式按钮
// ============================================================================

export function ApprovalModeControl({ mode, saving, onChange }: {
  mode: string;
  saving?: boolean;
  onChange?: (mode: "auto" | "ask") => void;
}) {
  const automatic = mode === "auto";
  return (
    <button
      type="button"
      className={`approval-mode-control ${automatic ? "auto" : "ask"}`}
      onClick={() => onChange?.(automatic ? "ask" : "auto")}
      disabled={saving}
      aria-pressed={automatic}
      title={automatic ? "当前：自动批准。会自动放行原本需要逐次询问的操作，deny 规则仍然生效；该模式保存在本机全局配置，跨会话/项目生效，可在设置中改回" : "当前：每次询问。工具写入或危险操作需要逐次确认。点击启用自动批准（本机全局，可随时关闭）"}
    >
      <Icon name={automatic ? "check" : "shield"} size={14} />
      <span>{automatic ? "自动批准" : "每次询问"}</span>
      <i className="approval-mode-dot" />
    </button>
  );
}

// ============================================================================
// 输入框上方任务入口：点击查看，离开后自动收起
// ============================================================================

export interface TaskItem {
  id?: string;
  done?: boolean;
  status?: string;
  title?: string;
  name?: string;
  text?: string;
  note?: string;
  [key: string]: unknown;
}

export function TaskProgressCard({ tasks, running = false }: {
  tasks: TaskItem[];
  running?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [panelMaxHeight, setPanelMaxHeight] = useState(260);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const done = tasks.filter((t) => t.done || ["completed", "skipped"].includes(t.status as string)).length;
  const failed = tasks.filter((t) => t.status === "failed").length;

  useEffect(() => {
    if (!running) setOpen(false);
  }, [running]);
  useEffect(() => () => {
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
  }, []);
  useEffect(() => {
    if (!open) return undefined;
    const handleOutsidePointer = (event: PointerEvent) => {
      if (!cardRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", handleOutsidePointer);
    return () => document.removeEventListener("pointerdown", handleOutsidePointer);
  }, [open]);
  // 清单从卡片向上弹出，而外层容器（.center-chat-slot）是 overflow:hidden：
  // 矮窗口下按"卡片上方可用空间"夹取高度，否则清单顶部会被裁掉（实测 420px 窗口裁 25px、360px 裁 85px）。
  // 窗口尺寸变化会改变可用空间，所以要跟着 resize 重算，不能只在打开那一刻算一次。
  useLayoutEffect(() => {
    if (!open) return undefined;
    const measure = () => {
      const card = cardRef.current;
      if (!card) return;
      let clipTop = 8;
      let node = card.parentElement;
      while (node && node !== document.body) {
        const style = getComputedStyle(node);
        if (style.overflowY !== "visible" || style.overflow !== "visible") {
          clipTop = Math.max(clipTop, node.getBoundingClientRect().top);
        }
        node = node.parentElement;
      }
      const available = card.getBoundingClientRect().top - clipTop - 12;
      // 下限 96px：够显示 3 条左右（清单内部可滚动），同时在极矮窗口下也不会把面板顶出容器。
      setPanelMaxHeight(Math.max(96, Math.min(260, Math.round(available))));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open, tasks.length]);
  const keepOpen = () => {
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
  };
  const scheduleClose = () => {
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(() => setOpen(false), 350);
  };

  return (
    <div className={`task-card ${open ? "open" : ""}`} ref={cardRef} onMouseEnter={keepOpen} onMouseLeave={scheduleClose}>
      <button type="button" className="task-head" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label="查看任务进度">
        <span className="task-chevron">{open ? "▾" : "▸"}</span>
        <Icon name="list" size={12} />
        <span className="task-title">任务</span>
        <span className="task-progress">{done}/{tasks.length} 完成{failed ? ` · ${failed} 失败` : ""}</span>
      </button>
      {open && (
        <div className="task-body" style={{ maxHeight: panelMaxHeight }}>
          <div className="task-bar">
            <div className="task-bar-fill" style={{ width: `${(done / tasks.length) * 100}%` }} />
          </div>
          {tasks.map((t, i) => (
            <div key={t.id || i} className={`task-item ${t.done || ["completed", "skipped"].includes(t.status as string) ? "done" : ""} ${t.status === "failed" ? "failed" : ""}`}>
              <span className="task-status">{t.status === "failed" ? <Icon name="warning" size={12} /> : (t.done || ["completed", "skipped"].includes(t.status as string) ? <Icon name="check" size={12} /> : <span className="task-pending-dot" />)}</span>
              <span className="task-text">{t.title || t.name || t.text || "执行 Agent 任务"}</span>
              {t.note && <small title={t.note}>{t.note}</small>}
              {t.status === "running" || t.status === "in_progress" ? <small>进行中</small> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
