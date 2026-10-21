/**
 * 消息与结果卡（F3 批6d-2）：自 client/src/components/ChatPanel.jsx 4101-4905
 * 拆出的产物投影函数（artifactsFromView）/ 结果卡（RunSummary）/ 消息组件
 * （Message）/ 记忆化包装（MemoMessage），与原实现逐行等价，对拍强制
 * tests/f3-batch6d2-parity.test.tsx。叶子展示件复用批6d-1 的
 * message-parts / interaction-parts / execution-flow。
 */
import React, { useState, useRef, useEffect, useLayoutEffect, useMemo } from "react";
import Icon from "../../components/Icon";
import ToolIdentityIcon from "../../components/SemanticToolIcon";
import Logo from "../../components/Logo";
import {
  SafeMarkdown,
  ThinkingBlock,
  ToolCard,
  SubagentCard,
  PipelineCard,
  ReferenceChips,
  StreamingDot,
  StreamingActivityLabel,
  readableProgressText,
  type ReferenceItem,
  type SubagentBlock,
} from "./message-parts";
import { AskBlock, ApprovalBlock } from "./interaction-parts";
import { ExecutionFlow } from "./execution-flow";
import { LIVE_RUN_STATUSES, formatMsgTime, type ChatBlock, type ChatMessage } from "../../lib/chat-shared";
import {
  completionLabel,
  formatDuration,
  formatTokenCount,
  reduceRunTrace,
  reduceTurnMetrics,
  runToolDetailText,
  summarizeTurnMetrics,
  turnMetricsText,
  verificationLabel,
} from "../../lib/run-trace";
import { projectLegacyRunSummary, type RunView, type FileChange } from "../../lib/run-display-projection";
import { buildArtifactIndex } from "../../lib/artifact-types";
import { useAppearance } from "../../lib/ui-appearance";
import { markFirstDomText } from "../../lib/first-token-latency-tracker";

/** 宽松结构类型（已知字段之外全走索引签名，对齐 chat-shared 的视图类型约定）。 */
type LooseRecord = Record<string, unknown>;

type ExecutionFlowInput = Partial<Parameters<typeof ExecutionFlow>[0]>;

/** artifactsFromView 的产物条目（icon/name/typeLabel 等由 buildArtifactIndex 补齐，走索引签名）。 */
export interface ArtifactRef {
  path: string;
  deliverable: boolean;
  size: unknown;
  confirmed: boolean;
  attributed: boolean;
  [key: string]: unknown;
}

export function artifactsFromView(view: unknown): ArtifactRef[] | null {
  if (!view) return null;
  const record = view as LooseRecord;
  const byPath = new Map<string, ArtifactRef>();
  const pick = (change: LooseRecord | null | undefined) => String(change?.relativePath || change?.path || change?.name || "").replace(/\\/g, "/").trim();
  const confirmedOf = (change: LooseRecord | null | undefined) => change?.source === "write-ledger" || change?.role === "deliverable";
  const attributedOf = (change: LooseRecord | null | undefined) => change?.attributed !== false && change?.source !== "unattributed";
  const put = (change: LooseRecord | null | undefined, deliverable: boolean) => {
    const path = pick(change);
    if (!path) return;
    byPath.set(path, {
      path,
      deliverable,
      size: (change?.after as LooseRecord | null | undefined)?.size ?? null,
      confirmed: confirmedOf(change),
      attributed: attributedOf(change),
    });
  };
  for (const change of (record.deliverables as unknown[] | null | undefined) || []) {
    const item = change as LooseRecord | null | undefined;
    if (item?.role === "internal") continue;
    put(item, true);
  }
  for (const change of (record.changes as unknown[] | null | undefined) || []) {
    const item = change as LooseRecord | null | undefined;
    if (item?.role === "internal" || byPath.has(pick(item))) continue;
    put(item, false);
  }
  return byPath.size ? [...byPath.values()] : null;
}

export function RunSummary({ m, onOpenFile, onRollbackRun, onOpenChanges, onOpenArtifacts, view: viewOverride = null, embedded = false }: {
  m: ChatMessage;
  onOpenFile?: (path: string) => void;
  onRollbackRun?: (runId: unknown, paths: string[]) => void;
  onOpenChanges?: () => void;
  onOpenArtifacts?: () => void;
  view?: RunView | null;
  embedded?: boolean;
}) {
  // W1/A01：结果卡只消费「统一展示投影」，实时构建的消息与旧历史走同一条路径，
  // 不再各自拼装状态 / 产物 / 文件清单（R01/R02 的重复展示即源于此）。
  // 消息层已算过的投影直接复用（viewOverride），避免同一条消息归约两遍事件流。
  const view = useMemo(
    () => viewOverride || projectLegacyRunSummary(m, Array.isArray(m.events) ? m.events : []),
    [viewOverride, m],
  );
  const statusLabel = view.lifecycleLabel; // R04：状态缺失显示“状态待同步”，不默认“运行结束”
  const completion = (view.outcome || m.completion || null) as LooseRecord | null;
  const finalAnswer = String(view.answer?.text || m.authoritativeFinalText || "").trim();
  const fallbackSummary = finalAnswer ? "" : String(completion?.summary || "").trim();
  // 标题只用于非嵌入的历史摘要，优先取权威最终答复；收尾摘要只作为兼容标题。
  const conclusionSource = String(view.answer?.text || m.authoritativeFinalText || completion?.summary || m.text || (m.task as LooseRecord | null | undefined)?.text || (m.task as LooseRecord | null | undefined)?.goal || "").trim();
  const titleLine = conclusionSource.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] || "";
  const title = String(m.conclusion || titleLine || "本轮任务")
    .replace(/^\s*#{1,6}\s*/, "")
    .replace(/^[>*\-+\s]+/, "")
    .replace(/[*`_]/g, "")
    .slice(0, 140)
    .trim() || "本轮任务";
  // 工具明细与折叠摘要：沿用轨迹归约与统一投影，避免直接统计重复事件。
  const trace = useMemo(() => (Array.isArray(m.events) && m.events.length ? reduceRunTrace(m.events, m.runId as string | null) : null), [m.events, m.runId]);
  // 每轮用时与 token：来自持久化的 turn_started/turn_ended 与 stats 事件，实时与历史一致。
  const turnMetrics = useMemo(() => (Array.isArray(m.events) && m.events.length ? reduceTurnMetrics(m.events) : []), [m.events]);
  const turnTotals = useMemo(() => summarizeTurnMetrics(turnMetrics), [turnMetrics]);
  const metricsText = useMemo(() => turnMetricsText(turnTotals, { durationMs: trace?.durationMs }), [turnTotals, trace?.durationMs]);
  // 单一份文件集合：投影已按 runId 归并、去重并按语义标角色
  const changes = view.changes || [];
  const fileChanges = useMemo(() => changes.filter((change) => change.role !== "internal"), [changes]);
  const deliverables = view.deliverables || [];
  // A03：待审核记忆建议的入口（实时挂在消息上，历史从事件投影得到）
  const memoryProposalIds = useMemo(() => [...new Set([
    ...(view.memoryProposalIds || []),
    ...(Array.isArray(m.memoryProposalIds) ? (m.memoryProposalIds as unknown[]) : []),
  ])] as string[], [view.memoryProposalIds, m.memoryProposalIds]);
  const rollbackableCount = fileChanges.filter((change) => change.before?.reversible).length;
  // 只有真实需要用户行动时才提示（计划 A02-4：删除通用“下一步”）
  const actionNeeded = view.lifecycle === "waiting_approval"
    ? { kind: "approval", text: view.progress.waitingReason || "等待你审批后继续" }
    : view.lifecycle === "waiting_user"
      ? { kind: "ask", text: view.progress.waitingReason || "等待你回答后继续" }
      : completion?.status === "blocked"
        ? { kind: "blocked", text: "有受阻项需要你先处理" }
        : completion?.status === "partial"
          ? { kind: "partial", text: "有未完成项，需要你决定是否继续" }
          : view.lifecycle === "failed"
            ? { kind: "failed", text: "本轮失败，可重试或调整要求" }
            : null;
  const reviewSources = useMemo(() => {
    const sourceMap = new Map<unknown, LooseRecord>((Array.isArray(m.reviewSources) ? (m.reviewSources as LooseRecord[]) : []).map((item) => [item.sourceId, { ...item }]));
    for (const event of Array.isArray(m.events) ? (m.events as unknown[]) : []) {
      const record = event as LooseRecord | null | undefined;
      const data = (record?.data || {}) as LooseRecord;
      if (record?.type === "review_source_read" && data.sourceId) sourceMap.set(data.sourceId, { ...(sourceMap.get(data.sourceId) || {}), ...data });
      if (["review_source_applied", "review_source_unused"].includes(record?.type as string) && data.sourceId) {
        sourceMap.set(data.sourceId, { ...(sourceMap.get(data.sourceId) || {}), ...data, status: record?.type === "review_source_applied" ? "applied" : "read-not-applied" });
      }
    }
    return [...sourceMap.values()].filter((item) => item.sourceId);
  }, [m.events, m.reviewSources]);
  // 未完成/受阻清单（宽松字段收窄为列表；运行时与旧实现的真值判定一致）
  const incompleteList = (completion?.incomplete as string[] | null | undefined) || [];
  const blockersList = (completion?.blockers as string[] | null | undefined) || [];
  // 结果卡只在有文件、审查依据或需要用户处理的终态出现。
  // 单纯存在 completion/summary 不代表用户需要看到一张“0 项”卡。
  // 例外：被中断的一轮必须留下终态说明——否则用户只看到"话说了一半就没了"，
  // 分不清是中断、失败还是正常结束（实测用户反馈"中断后不对劲"的根因之一）。
  const interrupted = view.lifecycle === "cancelled" || completion?.status === "cancelled";
  const showResultCard = fileChanges.length > 0
    || deliverables.length > 0
    || reviewSources.length > 0
    || Boolean(actionNeeded)
    || interrupted
    || Boolean(incompleteList.length || blockersList.length);
  // 单一产物集合（交付优先、路径去重）＋ 类型/大小，供「本轮产物」tab 的卡片使用。
  const products = useMemo(() => artifactsFromView(view) || [], [view]);
  // 归到本轮的产物（含"待确认"）与"完全没有写入证据"的线索分开：后者不参与产物计数。
  const attributedProducts = useMemo(() => products.filter((item) => item.attributed), [products]);
  const confirmedProducts = useMemo(() => products.filter((item) => item.confirmed), [products]);
  const leadProducts = useMemo(() => products.filter((item) => !item.attributed), [products]);
  const productCards = useMemo(() => (attributedProducts.length ? buildArtifactIndex(attributedProducts).list : []), [attributedProducts]);
  // 结果区页签：本轮产物 / 文件改动 / 依据（依据仅在 Review 轮次有）
  const [resultTab, setResultTab] = useState("products");
  useEffect(() => {
    // 当前页签的数据不存在时（例如历史轮次没有依据）自动回到产物页
    if (resultTab === "sources" && !reviewSources.length) setResultTab(products.length ? "products" : "changes");
  }, [resultTab, reviewSources.length, products.length]);
  const runIsLive = LIVE_RUN_STATUSES.has(String(m.runStatus || ""));
  const [summaryOpen, setSummaryOpen] = useState(runIsLive);
  useEffect(() => setSummaryOpen(runIsLive), [runIsLive]);
  const hasRunDetails = showResultCard;
  // 单一文件清单的行类名：角色 + 内部弱化 + “本轮刚结束”的短时高亮（历史回放不重播）
  const changeClass = (change: FileChange) => `summary-product clickable role-${change.role}${change.role === "internal" ? " internal" : ""}${m.flashFiles ? " fresh" : ""}`;
  // 每轮用时与 token 是独立于"有没有产物"的记录：纯问答轮也保留一行实测指标，不弹空结果卡。
  const hasTurnMetrics = turnMetrics.length > 0;
  if (!showResultCard && !hasTurnMetrics) return null;
  return (
    <div className={`msg system summary-msg ${embedded ? "embedded-run-summary" : ""}`}>
      <div className="bubble run-summary-bubble">
        {!embedded && <div className="run-summary-header">
          <span className={`run-summary-dot ${m.runStatus || "done"}`} />
          <span className="run-summary-title" title={title}>{title}</span>
          <span className="run-summary-meta">
            {statusLabel}
            {completion && (
              <span
                className={`flow-completion ${completion.status}`}
                title={completion.source === "inferred" ? "由回合结束推断（模型未显式声明完成状态）" : `模型显式声明${completion.summary ? `：${completion.summary}` : ""}`}
              >
                {completionLabel(completion.status)}{completion.source === "inferred" ? "（推断）" : ""}
              </span>
            )}
          </span>
        </div>}
        {hasRunDetails && (
        <details className={`run-result-fold ${embedded ? "embedded" : ""}`} open={summaryOpen} onToggle={(event) => setSummaryOpen(event.currentTarget.open)}>
          <summary>
            <Icon name="flow" size={12} />
            <span>{embedded ? "本轮状态" : "运行结果"}</span>
            <span className="run-result-fold-meta">
              {completion ? completionLabel(completion.status) : statusLabel}
              {products.length ? ` · ${products.length} 个文件` : ""}
              {view.progress.toolTotal ? ` · ${view.progress.toolTotal} 次工具调用` : ""}
            </span>
          </summary>
        <div className="run-result" aria-label="本轮结论与执行过程">
          <div className="run-result-grid">
            <div className="run-result-cell">
              <span className="run-result-label">目标达成</span>
              <b className={`run-result-value completion-${completion?.status || "unknown"}`}>
                {completion ? completionLabel(completion.status) : "模型未声明"}
              </b>
              {completion?.source === "inferred" && (
                <small className="run-result-flag" title="模型未显式声明完成状态，由回合结束推断">推断</small>
              )}
            </div>
            <div className="run-result-cell">
              <span className="run-result-label">文件变更</span>
              <b className="run-result-value">{fileChanges.length} 项</b>
              {rollbackableCount > 0 && (
                <small className="run-result-flag" title="其中可回滚的变更数量">可回滚 {rollbackableCount}</small>
              )}
            </div>
            <div className="run-result-cell">
              <span className="run-result-label">验证</span>
              <b className="run-result-value">{verificationLabel(trace?.verification || "not_checked")}</b>
              {(completion?.verification as string | undefined) && (
                <small className="run-result-flag" title={String((completion as LooseRecord).verification)}>模型声明</small>
              )}
            </div>
          </div>
          {fallbackSummary && (
            <div className="run-result-fallback">
              <strong>运行摘要</strong>
              <SafeMarkdown text={fallbackSummary} onOpenFile={onOpenFile} artifacts={products.length ? products : null} />
            </div>
          )}
          {!!incompleteList.length && <div className="run-result-note warn">未完成：{incompleteList.join("；")}</div>}
          {!!blockersList.length && <div className="run-result-note warn">受阻：{blockersList.join("；")}</div>}
          {!embedded && ((trace?.tools?.length ?? 0) > 0 || view.progress.toolTotal > 0) && (
            <section className="run-process-details" aria-label="工具调用明细">
              <div className="run-process-heading"><Icon name="flow" size={12} /> 执行过程</div>
              <div className="run-trace-timeline" role="list" aria-label="按顺序排列的工具调用">
                {(trace?.tools || []).map((tool, index) => {
                  const detail = runToolDetailText(tool as unknown as LooseRecord);
                  const preview = detail.length > 240 ? `${detail.slice(0, 240)}…` : detail;
                  const state = tool.status !== "done" ? "running" : tool.isError ? "error" : "ok";
                  const stateLabel = state === "running" ? "进行中" : state === "error" ? "失败" : "完成";
                  const duration = Number(tool.duration);
                  return (
                    <div key={tool.id || `${tool.name}-${index}`} className={`run-trace-step ${state}`} role="listitem">
                      <span className="run-trace-step-index">{index + 1}</span>
                      <div className="run-trace-step-content">
                        <div className="run-trace-step-heading">
                          <ToolIdentityIcon name={tool.name} size={12} />
                          <strong>{tool.name}{tool.startMissing ? "（恢复）" : ""}</strong>
                          <span className={`run-trace-step-status ${state}`}>{stateLabel}</span>
                          {Number.isFinite(duration) && duration >= 0 && <time>{formatDuration(duration * 1000)}</time>}
                        </div>
                        {preview && <p title={detail}>{preview}</p>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
          {!embedded && <details className="run-result-tech">
            <summary>技术详情（运行 ID、事件与原始错误）</summary>
            <pre>{JSON.stringify({
              runId: m.runId || null,
              status: m.runStatus || null,
              mode: m.runMode || null,
              workspace: m.workspace || null,
              eventCount: m.eventCount || 0,
              completion,
              errors: ((Array.isArray(m.events) ? m.events : []) as unknown[])
                .filter((event) => /error|failed/i.test(String((event as LooseRecord | null | undefined)?.type || "")))
                .slice(-5)
                .map((event) => { const record = event as LooseRecord | null | undefined; return { type: record?.type, at: record?.at, data: record?.data }; }),
            }, null, 2)}</pre>
          </details>}
        </div>
        </details>
        )}
        {actionNeeded && <div className={`run-result-action ${actionNeeded.kind}`}><Icon name="arrowRight" size={12} /> {actionNeeded.text}</div>}
        {/* 被中断的轮次：明确写出终态与可继续的方式，不靠"内容戛然而止"让用户猜 */}
        {interrupted && !actionNeeded && (
          <div className="run-result-action cancelled" role="status">
            <Icon name="stop" size={12} /> 本轮已中断，已保留生成到一半的内容；可以重新发送、补充要求，或直接继续提问。
          </div>
        )}
        {/* 本轮用时与 token：明确到每一轮（回合）——总量常驻可见，逐轮明细一键展开 */}
        {hasTurnMetrics && (
          <div className="run-metrics" aria-label="本轮用时与 token">
            {/* 一行小字：用时 · 轮数 · 输入/输出 token · 上下文；逐轮明细收在后面的小折叠里 */}
            <span className="run-metrics-text" title={metricsText}>
              用时 <b>{formatDuration(trace?.durationMs || turnTotals.durationMs || 0)}</b>
              <i>·</i><b>{turnMetrics.length}</b> 轮
              {Number.isFinite(turnTotals.input) && <><i>·</i>输入 <b>{formatTokenCount(turnTotals.input)}</b></>}
              {Number.isFinite(turnTotals.output) && <><i>·</i>输出 <b>{formatTokenCount(turnTotals.output)}</b> tokens</>}
              {Number.isFinite(turnTotals.context) && <><i>·</i>上下文 {formatTokenCount(turnTotals.context)}</>}
            </span>
            <details className="run-turns">
              <summary title="每轮用时来自回合开始/结束事件，token 来自每回合一次的用量事件（输入不含缓存读；上下文是该回合结束时的规模）">每轮明细</summary>
              <div className="run-turns-table" role="table" aria-label="每轮用时与 token">
                <div className="run-turns-row head" role="row">
                  <span role="columnheader">回合</span>
                  <span role="columnheader">用时</span>
                  <span role="columnheader">输出</span>
                  <span role="columnheader">输入</span>
                  <span role="columnheader">缓存读</span>
                  <span role="columnheader">上下文</span>
                  <span role="columnheader">工具</span>
                </div>
                {turnMetrics.map((turn) => (
                  <div className="run-turns-row" role="row" key={turn.index}>
                    <span role="cell">#{turn.index}</span>
                    <span role="cell">{Number.isFinite(turn.durationMs) ? formatDuration(turn.durationMs) : "—"}</span>
                    <span role="cell">{turn.tokens && Number.isFinite(turn.tokens.output) ? formatTokenCount(turn.tokens.output) : "—"}</span>
                    <span role="cell">{turn.tokens && Number.isFinite(turn.tokens.input) ? formatTokenCount(turn.tokens.input) : "—"}</span>
                    <span role="cell">{turn.tokens && Number.isFinite(turn.tokens.cacheRead) ? formatTokenCount(turn.tokens.cacheRead) : "—"}</span>
                    <span role="cell">{turn.tokens && Number.isFinite(turn.tokens.context) ? formatTokenCount(turn.tokens.context) : "—"}</span>
                    <span role="cell">{Number.isFinite(turn.toolCount) ? turn.toolCount : "—"}</span>
                  </div>
                ))}
              </div>
            </details>
          </div>
        )}
        {/* 本轮产物 tab：产物卡片 / 文件改动 / 依据，同一份投影的单一文件区域 */}
        {(products.length > 0 || fileChanges.length > 0 || reviewSources.length > 0) && (
          <div className="result-tabbed" aria-label="本轮结果">
            <div className="result-tabs" role="tablist" aria-label="本轮结果视图">
              {products.length > 0 && (
                <button type="button" role="tab" aria-selected={resultTab === "products"} className={`result-tab ${resultTab === "products" ? "active" : ""}`} onClick={() => setResultTab("products")}>
                  <Icon name="folder" size={12} /> 本轮产物 <span className="result-tab-count">{attributedProducts.length}</span>
                </button>
              )}
              {fileChanges.length > 0 && (
                <button type="button" role="tab" aria-selected={resultTab === "changes"} className={`result-tab ${resultTab === "changes" ? "active" : ""}`} onClick={() => setResultTab("changes")}>
                  <Icon name="edit" size={12} /> 文件改动 <span className="result-tab-count">{fileChanges.length}</span>
                </button>
              )}
              {reviewSources.length > 0 && (
                <button type="button" role="tab" aria-selected={resultTab === "sources"} className={`result-tab ${resultTab === "sources" ? "active" : ""}`} onClick={() => setResultTab("sources")}>
                  <Icon name="shield" size={12} /> 依据 <span className="result-tab-count">{reviewSources.length}</span>
                </button>
              )}
            </div>
            {resultTab === "products" && products.length > 0 && (
              <div className="result-tab-panel" role="tabpanel" aria-label="本轮产物">
                <div className="product-cards-head">
                  <span>
                    <Icon name="folder" size={12} /> 交付产物 {deliverables.length} · 已确认 {confirmedProducts.length}
                    {attributedProducts.length > confirmedProducts.length ? ` · 待确认 ${attributedProducts.length - confirmedProducts.length}` : ""}
                    {leadProducts.length ? ` · 未归属线索 ${leadProducts.length}` : ""}
                  </span>
                  {onOpenArtifacts && <button type="button" className="product-cards-link" onClick={() => onOpenArtifacts()} title="在右侧“产物”面板查看版本与固定">在产物面板查看</button>}
                </div>
                {productCards.length > 0 && (
                  <div className="product-cards">
                    {productCards.map((item) => (
                      <div className={`product-card${item.deliverable ? " deliverable" : ""}${item.confirmed ? "" : " provisional"}`} key={item.path}>
                        <button type="button" className="product-card-main" onClick={() => onOpenFile?.(item.path)} title={item.path}>
                          <span className={`product-card-icon artifact-kind-${item.icon}`}><Icon name={item.icon} size={15} /></span>
                          <span className="product-card-meta">
                            <strong>{item.name}</strong>
                            <small>{item.typeLabel}{item.sizeText ? ` · ${item.sizeText}` : ""}</small>
                          </span>
                          {item.deliverable && <span className="product-card-badge">交付</span>}
                          {!item.confirmed && (
                            <span
                              className="product-card-badge provisional"
                              title="本轮没有把该文件写进台账（bash / officecli 写文件不回报路径），按“本轮确有写入 + 文件在运行窗口内变化”归属到本轮；若同一工作区有并行运行，也可能来自它"
                            >待确认</span>
                          )}
                        </button>
                        <button type="button" className="product-card-open" onClick={() => onOpenFile?.(item.path)} title={`打开 ${item.path}`}>打开</button>
                      </div>
                    ))}
                  </div>
                )}
                {/* 未归属线索：本轮没有任何写入证据（纯读取的一轮）时，快照差异无法证明属于本轮，
                    只作线索列出，不参与"本轮产物"计数。 */}
                {leadProducts.length > 0 && (
                  <details className="product-leads">
                    <summary title="本轮没有写入台账（工具通过命令行写文件）时，快照差异无法证明文件归属；可能是并行运行或其他轮次写入的">
                      未归属线索 {leadProducts.length} · 可能来自其他运行，需人工确认
                    </summary>
                    <div className="product-leads-list">
                      {leadProducts.map((item) => (
                        <button type="button" className="product-lead" key={item.path} onClick={() => onOpenFile?.(item.path)} title={`${item.path}（未归属线索）`}>
                          <Icon name={(item.icon as string) || "file"} size={12} />
                          <span>{item.name as React.ReactNode}</span>
                          {(item.sizeText as string | undefined) && <em>{item.sizeText as React.ReactNode}</em>}
                        </button>
                      ))}
                    </div>
                    <p className="product-leads-note">这些文件在本轮前后的工作区快照里有变化，但本轮没有写入台账记录它们；同一工作区并行运行时会互相出现，请以文件树与“文件改动”页签为准。</p>
                  </details>
                )}
              </div>
            )}
            {resultTab === "changes" && fileChanges.length > 0 && (
              <div className="result-tab-panel" role="tabpanel" aria-label="文件改动">
                <div className="file-change-summary">
                  <span className="file-change-label">
                    <Icon name="folder" size={12} /> 本轮文件（{fileChanges.length}）
                    {deliverables.length ? ` · 交付 ${deliverables.length}` : ""}
                  </span>
                  {(m.workspace as string | undefined) && <small className="summary-workspace" title={m.workspace as string | undefined}>工作区：{m.workspace as React.ReactNode}</small>}
                  <div className="summary-products">
                    {fileChanges.map((change) => (
                      <span
                        key={change.relativePath}
                        className={changeClass(change)}
                        onClick={() => onOpenFile?.(change.relativePath)}
                        title={`${change.changeType} · ${change.confidence === "suspected" ? "疑似变更" : "已确认"} · ${change.relativePath}`}
                      >
                        <Icon name={change.changeType === "deleted" ? "trash" : "file"} size={12} /> {change.relativePath}
                      </span>
                    ))}
                  </div>
                </div>
                {/* 单一份文件清单：不再与 m.artifacts 各行重复；只保留“回滚本轮”这个真实动作 */}
                {(m.runId && rollbackableCount > 0) || onOpenChanges ? (
                  <div className="run-artifacts">
                    {(m.runId as string | null | undefined) && rollbackableCount > 0 && (
                      <button className="btn-xs" onClick={() => onRollbackRun?.(m.runId, fileChanges.filter((change) => change.before?.reversible).map((change) => change.relativePath))}>回滚本轮（{rollbackableCount} 项）</button>
                    )}
                    {onOpenChanges && <button className="btn-xs" onClick={() => onOpenChanges()} title="在右侧“改动”面板查看内容差异">查看内容差异</button>}
                  </div>
                ) : null}
              </div>
            )}
            {resultTab === "sources" && reviewSources.length > 0 && (
              <div className="result-tab-panel" role="tabpanel" aria-label="规范依据">
                <div className="review-source-summary">
                  <div className="file-change-label"><Icon name="shield" size={12} /> 规范依据（已读取 {reviewSources.length}）</div>
                  <div className="review-source-list">
                    {reviewSources.map((source) => (
                      <div className="review-source-row" key={String(source.sourceId)}>
                        <strong>{source.sourceId as React.ReactNode}</strong>
                        <span title={`${source.relPath || ""}${source.rootName ? ` @ ${source.rootName}` : ""}`}>{(source.title || source.relPath) as React.ReactNode}</span>
                        <em className={`review-source-status ${source.status || "read"}`}>{source.status === "applied" ? "已采用" : source.status === "read-not-applied" ? "未采用" : source.status === "failed" ? "读取失败" : "已读取"}</em>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
        {memoryProposalIds.length > 0 && (
          <div className="run-result-links">
            <span className="run-result-chip muted" title={`有 ${memoryProposalIds.length} 条待审核记忆建议，在「设置 → 记忆」中确认或拒绝`}><Icon name="book" size={12} /> 记忆建议 {memoryProposalIds.length}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ========== 消息组件（Proma 风格：头部 + 无气泡长文 AI / 淡色气泡用户） ==========
export function Message({ m, model, onToggleTool, onOpenFile, onMemoryApprove, onMemoryReject, onRollbackRun, onOpenRunChanges, onOpenRunArtifacts, onOpenSubagent, onAskAnswered, onAskExpired, onResend, index, prevRole, clientId, threadId, runSummary = null, executionFlow = null }: {
  m: ChatMessage;
  model?: string | null;
  onToggleTool?: (messageId: unknown, blockId: unknown) => void;
  onOpenFile?: (path: string) => void;
  onMemoryApprove?: (id: unknown) => void;
  onMemoryReject?: (id: unknown) => void;
  onRollbackRun?: (runId: unknown, paths: string[]) => void;
  onOpenRunChanges?: (runId: unknown) => void;
  onOpenRunArtifacts?: (runId: unknown) => void;
  onOpenSubagent?: (block: SubagentBlock) => void;
  onAskAnswered?: (messageId: unknown, blockId: unknown, answer: string) => void;
  onAskExpired?: (messageId: unknown, blockId: unknown) => void;
  onResend?: (text: unknown) => void;
  index?: number;
  prevRole?: string | null;
  clientId?: string | null;
  threadId?: string | null;
  runSummary?: ChatMessage | null;
  executionFlow?: ExecutionFlowInput | null;
}) {
  if (m.role === "system") {
    if (m.summary) {
      const runId = m.runId || null;
      return (
        <RunSummary
          m={m}
          onOpenFile={onOpenFile}
          onRollbackRun={onRollbackRun}
          onOpenChanges={onOpenRunChanges ? () => onOpenRunChanges(runId) : undefined}
          onOpenArtifacts={onOpenRunArtifacts ? () => onOpenRunArtifacts(runId) : undefined}
        />
      );
    }
    const proposal = m.memoryProposal as LooseRecord | null | undefined;
    return (
      <div className="msg system">
        <div className="bubble">
          {m.text}
          {proposal && (
            <div className="memory-proposal-card" role="note">
              <div><strong>{proposal.section as React.ReactNode}</strong>：{proposal.content as React.ReactNode}</div>
              {proposal.status === "pending" ? (
                <><button className="btn-xs primary" onClick={() => onMemoryApprove?.(proposal.id)}>确认写入记忆</button><button className="btn-xs" onClick={() => onMemoryReject?.(proposal.id)}>拒绝</button></>
              ) : <span className="memory-proposal-state">{proposal.status === "approved" ? "✓ 已写入" : "未写入"}</span>}
            </div>
          )}
        </div>
      </div>
    );
  }
  const isUser = m.role === "user";
  const blocks = m.blocks || [];
  const streaming = m.status === "streaming";
  const finalEventRecord = ([...(Array.isArray(runSummary?.events) ? (runSummary.events as unknown[]) : [])]
    .reverse()
    .find((event) => {
      const record = event as LooseRecord | null | undefined;
      return record?.type === "assistant_final" && String((record.data as LooseRecord | null | undefined)?.text || "").trim();
    })) as LooseRecord | undefined;
  const authoritativeFinalText = String(
    m.authoritativeFinalText
      || (finalEventRecord?.data as LooseRecord | null | undefined)?.text
      || "",
  ).trim();
  // 本轮展示投影只算一次：结论内嵌产物与结果卡（tab）共用，避免重复归约事件流。
  const runCardSource = useMemo<ChatMessage & { authoritativeFinalText: string } | null>(
    () => (runSummary ? { ...runSummary, authoritativeFinalText } : null),
    [runSummary, authoritativeFinalText],
  );
  const runCardView = useMemo(
    () => (runCardSource ? projectLegacyRunSummary(runCardSource, Array.isArray(runCardSource.events) ? runCardSource.events : []) : null),
    [runCardSource],
  );
  // 结论里可点击的产物：交付物优先，其余文件改动跟随；同一路径只留一条。
  const answerArtifacts = useMemo(() => artifactsFromView(runCardView), [runCardView]);
  // 最后一段文本块：无论最终答复是否已单独渲染，都不折进“执行过程”
  let lastTextBlockIndex = -1;
  blocks.forEach((block, blockIndex) => { if (block?.type === "text") lastTextBlockIndex = blockIndex; });
  let finalTextBlockIndex = -1;
  if (authoritativeFinalText) {
    const normalizedFinal = authoritativeFinalText.replace(/\s+/g, " ").trim();
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
      const candidate = blocks[i];
      const blockText = candidate?.type === "text" ? String(candidate.text || "").replace(/\s+/g, " ").trim() : "";
      if (blockText && (blockText === normalizedFinal || blockText.endsWith(normalizedFinal) || normalizedFinal.endsWith(blockText))) {
        finalTextBlockIndex = i;
        break;
      }
    }
  }
  // 无权威终稿时，最后一个文本块是旧消息的答案候选；有终稿时使用匹配到的文本块。
  const finalAnswerBlockIndex = finalTextBlockIndex >= 0 ? finalTextBlockIndex : lastTextBlockIndex;
  const replaceLegacyFinalCandidate = Boolean(authoritativeFinalText && !streaming && finalTextBlockIndex < 0 && lastTextBlockIndex >= 0);
  // B02 回答详细程度：唯一答案出口在消息气泡，因此收窄只作用于此处，且只在非流式时生效。
  const answerDetail = useAppearance().answerDetail;
  const [answerExpanded, setAnswerExpanded] = useState(false);
  const clampAnswer = (value: string): string => {
    const lines = String(value || "").split(/\r?\n/).filter((line) => line.trim());
    return answerDetail === "brief" && !answerExpanded && lines.length > 3 ? `${lines.slice(0, 3).join("\n")}\n\n…` : value;
  };
  const answerClamped = answerDetail === "brief" && String(authoritativeFinalText || "").split(/\r?\n/).filter((line) => line.trim()).length > 3;
  const isTaskActivity = !isUser && Boolean(m.runId || runSummary || executionFlow);
  // 本轮是否被中断：本地标记只管当下，刷新/切回会话后靠 Run 终态
  const runInterrupted = /^(cancelled|aborted)$/.test(String(runSummary?.runStatus || m.runStatus || ""));
  const isTaskLive = streaming || Boolean(executionFlow?.running) || LIVE_RUN_STATUSES.has(String(runSummary?.runStatus || ""));
  const processBlockTypes = new Set(["thinking", "tool", "subagent", "pipeline", "ask", "approval", "process_note"]);
  // 模型发言（text）不再归入过程区：它是这一小节的结论，必须留在消息正文里。
  // 过去只有"最后一个文本块"能留在外面，于是每写一段新小结，上一段就被折进
  // "思考与工具过程"，折叠后整轮只剩最终答复。现在只把思考、工具、审批、
  // 子代理与系统提醒收进可折叠的过程区。
  const isProcessBlock = (block: ChatBlock | null | undefined): block is ChatBlock => (block ? processBlockTypes.has(block.type) : false);
  const foldedProcessBlocks = blocks.filter(isProcessBlock);
  const lastThinkingBlockIndex = foldedProcessBlocks.reduce((last, block, blockIndex) => block.type === "thinking" ? blockIndex : last, -1);
  // 工具既有富交互 block，也会出现在 SSE 轨迹中；保留工具卡，只让轨迹补充缺少卡片的调用。
  const processToolIds = new Set(foldedProcessBlocks
    .filter((block) => block.type === "tool")
    .map((block) => String(block.toolCallId || block.id || "").trim())
    .filter(Boolean));
  const processToolNames = new Set<string>();
  foldedProcessBlocks.filter((block) => block.type === "tool").forEach((block) => {
    const name = String(block.name || "").trim();
    if (name) processToolNames.add(name);
  });
  const processAskIds = new Set(foldedProcessBlocks
    .filter((block) => block.type === "ask")
    .map((block) => String(block.id || "").trim())
    .filter(Boolean));
  const processApprovalIds = new Set(foldedProcessBlocks
    .filter((block) => block.type === "approval")
    .map((block) => String(block.id || "").trim())
    .filter(Boolean));
  const processSubagentIds = new Set(foldedProcessBlocks
    .filter((block) => block.type === "subagent")
    .map((block) => String(block.id || "").trim())
    .filter(Boolean));
  const toolEventTypes = new Set(["tool_start", "tool_end"]);
  const visibleExecutionEvents = (executionFlow?.events || []).filter((event) => {
    const data = (event?.data || {}) as LooseRecord;
    if (toolEventTypes.has(event?.type)) {
      const id = String(data.toolCallId || "").trim();
      if (id) return !processToolIds.has(id);
      const name = String(data.name || "").trim();
      return !(name && processToolNames.has(name));
    }
    if (event?.type === "ask_user") {
      const id = String(data.askId || `${data.runId || "ask"}:${data.question || ""}`).trim();
      return !processAskIds.has(id);
    }
    if (["tool_approval_request", "tool_approval_resolved"].includes(event?.type)) {
      const id = String(data.id || `${data.runId || "approval"}:${data.tool || ""}:${data.input || ""}`).trim();
      return !processApprovalIds.has(id);
    }
    if (["subagent_start", "subagent_tool", "subagent_update", "subagent_end"].includes(event?.type)) {
      const id = String(data.childId || data.parentToolCallId || "").trim();
      return !processSubagentIds.has(id);
    }
    return true;
  });
  const messageExecutionFlow = executionFlow ? { ...executionFlow, events: visibleExecutionEvents } : null;
  // 权威终稿若与某个文本块对应，该块由"最终答复"通道单独渲染，避免重复一份。
  const hiddenFinalTextIndex = authoritativeFinalText && !streaming && finalTextBlockIndex >= 0 ? finalTextBlockIndex : -1;
  const visibleBlocks = blocks.filter((block, blockIndex) => {
    if (block?.type === "message_boundary" || isProcessBlock(block)) return false;
    return blockIndex !== hiddenFinalTextIndex;
  });
  // 有序片段：连续的过程块合成一个可折叠区，模型发言（小节结论）留在原位置可见。
  // 于是渲染顺序就是模型真实的输出顺序——过程区 → 小节结论 → 新的过程区 → ……
  // 折叠只收起思考与工具，小节结论不会被后面的小节吞掉。
  type ProcessItem = { block: ChatBlock; blockIndex: number; processOrder: number };
  type RenderSegment = { kind: "process"; items: ProcessItem[]; flowOnly?: boolean } | { kind: "block"; block: ChatBlock; blockIndex: number };
  const renderSegments: RenderSegment[] = [];
  let processOrder = -1;
  blocks.forEach((block, blockIndex) => {
    if (block?.type === "message_boundary" || blockIndex === hiddenFinalTextIndex) return;
    if (isProcessBlock(block)) {
      processOrder += 1;
      const item: ProcessItem = { block, blockIndex, processOrder };
      const tail = renderSegments[renderSegments.length - 1];
      if (tail?.kind === "process") tail.items.push(item);
      else renderSegments.push({ kind: "process", items: [item] });
      return;
    }
    renderSegments.push({ kind: "block", block, blockIndex });
  });
  // SSE 轨迹（事件流）挂在最后一个过程区里；没有过程块时单独补一个，保证轨迹仍可回看。
  if (messageExecutionFlow && !renderSegments.some((segment) => segment.kind === "process")) {
    renderSegments.push({ kind: "process", items: [], flowOnly: true });
  }
  const lastProcessSegmentIndex = renderSegments.reduce((last, segment, segmentIndex) => (segment.kind === "process" ? segmentIndex : last), -1);
  const renderProcessBlock = ({ block, blockIndex, processOrder }: ProcessItem) => {
    const key = (block.id || `block-${blockIndex}`) as string | number;
    if (block.type === "thinking") return <ThinkingBlock key={key} text={block.text} startTime={block.startTime} streaming={streaming && processOrder === lastThinkingBlockIndex} embedded />;
    if (block.type === "tool") return <ToolCard key={key} tool={block} onToggle={() => onToggleTool?.(m.id, block.id || blockIndex)} />;
    if (block.type === "subagent") return <SubagentCard key={key} block={block} onOpenDetail={onOpenSubagent} />;
    if (block.type === "pipeline") return <PipelineCard key={key} block={block} onOpenFile={onOpenFile} />;
    if (block.type === "ask") return <AskBlock key={key} block={block} clientId={clientId} threadId={threadId} onAnswered={(blockId, answer) => onAskAnswered?.(m.id, blockId, answer)} onExpired={(blockId) => onAskExpired?.(m.id, blockId)} />;
    if (block.type === "approval") return <ApprovalBlock key={key} block={block} />;
    if (block.type === "process_note") return (
      <div className="flow-markdown process-narration process-note" key={key}>
        <SafeMarkdown text={String(block.text || "").replace(/^\s*\[系统提醒\]\s*/, "")} />
      </div>
    );
    return null;
  };
  // 渲染时才读取 processOpenMap（状态声明在后面），因此这里是函数而不是常量数组。
  const renderMessageBlocks = () => renderSegments.map((segment, segmentIndex) => {
    if (segment.kind === "block") {
      const block = segment.block;
      if (block?.type !== "text") return null;
      // 旧消息没有权威终稿时，最后一个文本块承担最终答复，按回答详细程度收窄。
      const isFinalAnswerBlock = replaceLegacyFinalCandidate && block === blocks[lastTextBlockIndex];
      const shown = isFinalAnswerBlock ? clampAnswer(authoritativeFinalText) : block.text;
      return (
        <div className="flow-markdown" key={(block.id || `text-${segment.blockIndex}`) as string | number}>
          {streaming
            ? <div className="flow-stream-text" aria-live="polite">{readableProgressText(block.text)}</div>
            : <SafeMarkdown text={shown} onOpenFile={onOpenFile} artifacts={answerArtifacts} />}
        </div>
      );
    }
    const isLastProcess = segmentIndex === lastProcessSegmentIndex;
    const isLiveFold = isTaskLive && isLastProcess;
    const foldKey = `process-${segment.items[0]?.blockIndex ?? "flow"}`;
    const override = processOpenMap[foldKey];
    const open = typeof override === "boolean" ? override : isLiveFold;
    return (
      <details
        className={`message-process-fold ${isTaskActivity ? "run-activity-fold" : ""} ${isLiveFold ? "is-live" : ""}`}
        key={foldKey}
        open={open}
        onToggle={(event) => {
          const next = event.currentTarget.open;
          // <details> 的 toggle 对"用户点击"和"React 改 open 属性"都会触发。
          // 只把与本次渲染值不同的变化记为用户偏好，否则运行中自动展开的
          // 过程区会被记成"用户要它开着"，小节结束后再也收不回去。
          if (next === open) return;
          setProcessOpenMap((state) => (state[foldKey] === next ? state : { ...state, [foldKey]: next }));
          if (next && isLiveFold) followProcessTailRef.current = true;
        }}
      >
        <summary>
          <Icon name="flow" size={12} />
          {isTaskActivity ? "执行过程" : foldedProcessBlocks.some((block) => block.type === "tool") ? "思考与工具过程" : "思考记录"}
          {isLiveFold && <span>实时</span>}
        </summary>
        <div className="message-process-fold-body">
          <div className="message-process-scroll" ref={isLastProcess ? processScrollRef : undefined} onScroll={isLastProcess ? handleProcessScroll : undefined}>
            {segment.items.map(renderProcessBlock)}
            {isLastProcess && messageExecutionFlow && <ExecutionFlow {...messageExecutionFlow} embedded />}
          </div>
        </div>
      </details>
    );
  });
  // 相邻同角色消息精简头部（连续 AI 回复/连续用户消息不再重复显示作者与时间）
  const hideHeader = prevRole === m.role;
  const images = m.images || [];
  const references = (m.references as ReferenceItem[] | null | undefined) || [];
  const hasContent = blocks.length > 0 || images.length > 0;
  const [copied, setCopied] = useState(false);
  const [waitSec, setWaitSec] = useState(0);
  // 每个过程区各自开合：默认只有"最新（运行中）"的那一个展开，其余收成一行摘要，
  // 用户点过的过程区按用户选择保持（与事件流阶段分组同一套约定）。
  const [processOpenMap, setProcessOpenMap] = useState<Record<string, boolean>>({});
  const processWasLiveRef = useRef(isTaskLive);
  const processScrollRef = useRef<HTMLDivElement | null>(null);
  const followProcessTailRef = useRef(true);

  useEffect(() => {
    if (isTaskLive && !processWasLiveRef.current) {
      followProcessTailRef.current = true;
      setProcessOpenMap({});
    } else if (!isTaskLive && processWasLiveRef.current) {
      // 运行结束：全部过程区收回一行摘要，只留小节结论与最终答复。
      setProcessOpenMap({});
    }
    processWasLiveRef.current = isTaskLive;
  }, [isTaskLive]);

  useLayoutEffect(() => {
    const list = processScrollRef.current;
    if (!isTaskLive || !list || !followProcessTailRef.current) return;
    list.scrollTop = list.scrollHeight;
  }, [blocks, messageExecutionFlow?.events, runSummary, isTaskLive, processOpenMap]);

  const handleProcessScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const list = event.currentTarget;
    followProcessTailRef.current = list.scrollHeight - list.scrollTop - list.clientHeight <= 28;
  };

  // 等待首个内容块：显示"正在思考..." + 耗时计时
  useEffect(() => {
    if (!streaming || hasContent) return;
    setWaitSec(0);
    const t = window.setInterval(() => setWaitSec((s) => s + 1), 1000);
    return () => window.clearInterval(t);
  }, [streaming, hasContent]);

  const copyText = async () => {
    try {
      const allText = blocks.map((b) => b.type === "text" ? b.text : b.type === "tool" ? (String(b.name) + " " + String(b.input || "")) : "").join("\n");
      await navigator.clipboard.writeText(allText || m.text || "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  const actionsVisible = (hasContent || m.errorText || m.stopped) && !streaming;
  // 首字延迟的最后一跳：正文真的出现在 DOM 里（方案 §3.5 预算：token→DOM P95 <100ms）。
  // 用 commit 后的 effect 打点，量到的是“用户能看见”，而不是“token 到了内存”。
  useEffect(() => {
    if (!streaming) return;
    const hasVisibleAnswer = visibleBlocks.some((block) => block?.type === "text" && String(block.text || "").trim());
    if (hasVisibleAnswer) markFirstDomText();
  }, [streaming, visibleBlocks]);
  return (
    <div className={`msg ${isUser ? "user" : "assistant"} ${m.status || ""}`} data-msg-index={index}>
      <div className={`avatar ${isUser ? "user-avatar" : "agent-avatar"} ${!isUser && streaming ? "is-streaming" : ""}`}>
        {isUser
          ? <Icon name="user" size={14} />
          : <Logo size={22} withBackground={false} markColor="#fff" className="agent-avatar-mark" />}
      </div>
      <div className="msg-main">
        {/* 消息头：作者 + 时间（相邻同角色消息省略，减少重复气泡头部） */}
        {!hideHeader && (
        <div className="msg-header">
          <span className="msg-author">{isUser ? "You" : (model || "Agent")}</span>
          <span className="msg-time">{formatMsgTime((m.createdAt || Date.now()) as string | number)}</span>
          {!isUser && m.status === "error" && <span className="msg-error-badge">生成失败</span>}
          {/* 中断既要认本地标记，也要认 Run 的终态：刷新/切回会话后本地标记会丢，只有 runStatus 还在 */}
          {!isUser && (m.stopped as boolean | undefined || runInterrupted) && <span className="msg-stopped-badge">{m.stopped ? "已停止生成" : "本轮已中断"}</span>}
        </div>
        )}
        {isUser ? (
          <div className="bubble user-bubble">
            {images.length > 0 && (
              <div className="msg-images">{images.map((src, i) => <img key={i} src={src as string} alt="" />)}</div>
            )}
            {(m.currentDoc as string | undefined) && <div className="msg-context">当前文件: {m.currentDoc as React.ReactNode}</div>}
            {references.length > 0 && <ReferenceChips references={references} onOpenFile={onOpenFile} />}
            {m.text && <div className="msg-text">{m.text}</div>}
          </div>
        ) : (
          <>
            {images.length > 0 && (
              <div className="msg-images assistant-images">{images.map((src, i) => <img key={i} src={src as string} alt="Agent 附图" />)}</div>
            )}
            {/* 顺序即模型真实输出顺序：过程区（思考/工具）→ 小节结论（模型发言）→ 新的过程区。
                折叠只收起思考与工具，小节结论始终可见，不会被后面的小节替代。 */}
            <div className="msg-blocks">
              {renderMessageBlocks()}
              {answerClamped && (
                <button type="button" className="answer-detail-toggle" onClick={() => setAnswerExpanded((value) => !value)} aria-expanded={answerExpanded}>
                  {answerExpanded ? "收起完整答案" : "展开完整答案"}
                </button>
              )}
            </div>
            {!streaming && authoritativeFinalText && !replaceLegacyFinalCandidate && (
              <>
                <div className="flow-markdown assistant-final-answer"><SafeMarkdown text={clampAnswer(authoritativeFinalText)} onOpenFile={onOpenFile} artifacts={answerArtifacts} /></div>
                {answerClamped && (
                  <button type="button" className="answer-detail-toggle" onClick={() => setAnswerExpanded((value) => !value)} aria-expanded={answerExpanded}>
                    {answerExpanded ? "收起完整答案" : "展开完整答案"}
                  </button>
                )}
              </>
            )}
            {/* 规范顺序：执行过程（可折叠）在上，结论与产物在下，且不随过程折叠隐藏 */}
            {runSummary && (
              <RunSummary
                m={runCardSource || runSummary}
                view={runCardView}
                embedded
                onOpenFile={onOpenFile}
                onRollbackRun={onRollbackRun}
                onOpenChanges={onOpenRunChanges ? () => onOpenRunChanges(runSummary.runId || m.runId) : undefined}
                onOpenArtifacts={onOpenRunArtifacts ? () => onOpenRunArtifacts(runSummary.runId || m.runId) : undefined}
              />
            )}
            {references.length > 0 && <ReferenceChips references={references} onOpenFile={onOpenFile} />}
            {/* 状态固定在消息内容下方：等待首字和持续生成共用同一组四瓣与状态短句 */}
            {streaming && (
              <div className="msg-streaming-status" role="status" aria-live="off">
                <StreamingDot />
                <StreamingActivityLabel />
                {!hasContent && waitSec > 0 && <span className="msg-streaming-elapsed">{waitSec}s</span>}
              </div>
            )}
            {/* 已停止 / 错误标记 */}
            {m.status === "error" && <div className="err-badge" title={m.errorText as string | undefined}>{m.errorText as React.ReactNode}</div>}
          </>
        )}
        {/* 操作条：常显微透明，hover 加深（Proma MessageActions 风格） */}
        {(actionsVisible as boolean | undefined) && (
          <div className="msg-actions">
            <button className="msg-action" onClick={copyText} title="复制">
              {copied ? <Icon name="check" size={12} /> : <Icon name="copy" size={12} />}
              <span>{copied ? "已复制" : "复制"}</span>
            </button>
            {isUser && (
              <button className="msg-action" onClick={() => onResend && onResend(m.text)} title="重新发送">
                <Icon name="refresh" size={12} />
                <span>重发</span>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// 流式消息变化时只重新计算被 patch 的那一条；长会话的历史 Markdown、工具卡
// 不应随每个 token 一起重新渲染。操作回调保持稳定，工作区/线程真正变化时
// 则仍由 onOpenFile、threadId 等关键属性触发必要更新。
export const MemoMessage = React.memo(Message, (previous, next) => {
  return previous.m === next.m
    && previous.model === next.model
    && previous.index === next.index
    && previous.prevRole === next.prevRole
    && previous.clientId === next.clientId
    && previous.threadId === next.threadId
    && previous.onOpenFile === next.onOpenFile
    && previous.onOpenSubagent === next.onOpenSubagent;
});