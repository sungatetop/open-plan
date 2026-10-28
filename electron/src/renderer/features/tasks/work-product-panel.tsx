import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { confirmArtifactAcceptance, getRun, getRunAcceptance, listPublishedArtifacts, listRuns, publishArtifact, rollbackPublishedArtifact } from "../../api/client-api";
import Icon from "../../components/Icon";
import { notifyError } from "../../components/Feedback";
import { artifactStatusInfo } from "../../lib/AcceptanceStatus";
import FileChangesPanel from "./file-changes-panel";
import { projectRunView } from "../../lib/run-display-projection";

/**
 * 工作产物面板（F4-2：与 client/src/components/WorkArtifactPanel.jsx 逐行等价，R11 产物可信度）。
 *
 * 包含三个组件：
 *   - ArtifactPanel（tab="artifacts"）：产物验收与固定（确认/发布/回滚 + 已发布版本列表）；
 *   - RunChangesPanel（tab="changes"）：本轮文件改动（按 Run 归属 + 内容差异分页）；
 *   - WorkProductPanel（默认导出）：右栏页签分发器（document 页签透传 children）。
 *
 * 数据源：client-api.ts 运行/产物族封装（op:runs:list/get/acceptance、op:runs:artifacts:publish/accept、
 * op:artifacts:list/rollback，S3-2 起进程内直调，签名与出参语义对齐旧 api.js）。
 *
 * 桌面形态等价说明：
 *   - 旧 client 刷新由根级事件流的 refreshToken 驱动（artifactVersion），新形态由
 *     createGlobalEventFeed 消费 IPC 全局事件桥后 bump 同名 state，语义一致；
 *   - tab==="subagent" 分支随 SubagentDetailPanel（chat 域组件）迁移后补齐，本批不含；
 *   - onOpenFile 在旧形态指向 App.open（应用内文档查看器），新形态指向 workbench
 *     openDocFile（F4-3 doc 域激活前为 no-op），调用时序与三参签名保持一致。
 */

/** Run/产物记录（协议类型为宽松投影，组件面大量可选字段按 any 宽松访问，与旧 JSX 行为一致）。 */
export type RunRecord = Record<string, any>;

type ArtifactPanelProps = {
  workspace: string;
  projectId: string;
  currentSessionId: string;
  selectedRunId?: string;
  artifactScope?: string;
  onArtifactScopeChange?: (scope: string) => void;
  refreshToken?: number;
  onOpenFile?: (path: string, thread?: string, cwd?: string) => void;
};

const statusText: Record<string, string> = { running: "执行中", queued: "排队中", waiting_user: "等待回答", recovering: "恢复中", completed: "已完成", failed: "失败", cancelled: "已取消", aborted: "已中断" };

function artifactName(path: string): string {
  return String(path || "").split(/[\\/]/).pop() || "未命名产物";
}

// O-P4：原 EventStream 组件（tab === "events"）为不可达死代码，已整体移除；
// 事件轨迹由「改动」页签的 Run 事件与子代理详情面板承接。

function ArtifactPanel({ workspace, projectId, currentSessionId, selectedRunId = "", artifactScope = "session", onArtifactScopeChange, refreshToken = 0, onOpenFile }: ArtifactPanelProps) {
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [published, setPublished] = useState<RunRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState("");
  const [acceptance, setAcceptance] = useState<Record<string, RunRecord | null>>({});
  // 交互 6：读取失败、请求中、确实为空、保留旧数据必须是不同状态。
  // 旧实现把 Promise.all 的失败吞进 catch{}，界面照常显示"暂未生成产物"，
  // 用户无法区分"没做"与"读不到"。
  const [loadError, setLoadError] = useState<{ message: string; source: string } | null>(null); // { message, source }
  const [staleAt, setStaleAt] = useState<number | null>(null); // 保留旧数据时的最后成功时间
  const refreshSeqRef = useRef(0);

  const refresh = async () => {
    const requestSeq = ++refreshSeqRef.current;
    setLoading(true);
    setLoadError(null);
    // 两次读取分开处理：一项失败不应该把另一项的结果也丢掉，失败信息要指明来源。
    const [runResult, publishedResult] = await Promise.allSettled([
      listRuns("", 100, { cwd: workspace, projectId }),
      listPublishedArtifacts(workspace, projectId),
    ]);
    if (requestSeq !== refreshSeqRef.current) return;
    const failures: { source: string; message: string }[] = [];
    if (runResult.status === "rejected") failures.push({ source: "运行记录", message: (runResult.reason as Error | undefined)?.message || "读取失败" });
    if (publishedResult.status === "rejected") failures.push({ source: "已发布成果", message: (publishedResult.reason as Error | undefined)?.message || "读取失败" });
    if (failures.length) {
      setLoadError({ message: failures.map((item) => `${item.source}：${item.message}`).join("；"), source: failures.map((item) => item.source).join("、") });
      // 有旧数据时保留并标记陈旧，而不是清空伪装成"没有产物"。
      if (runs.length || published.length) setStaleAt(Date.now());
      setLoading(false);
      return;
    }
    try {
      // 任一失败已在上方 failures 分支提前返回，此处必为 fulfilled（TS 无法沿
      // failures 聚合收窄，显式断言；与旧 JS 的 .value 直取语义一致）。
      const runData = (runResult as { value: RunRecord }).value;
      const publishedData = (publishedResult as { value: RunRecord }).value;
      // 先锁定当前会话的 Run（包括没有产物的最新一轮），再按范围选择。
      // 否则最新 Run 无文件时会被滤掉，改动面板就会误显上一轮文件。
      const sessionRuns = (runData.runs || []).filter((run: RunRecord) => Boolean(currentSessionId) && run?.sessionId === currentSessionId);
      const latestSessionRunId = sessionRuns[0]?.id || "";
      const scopeRunId = artifactScope === "run" ? (selectedRunId || latestSessionRunId) : "";
      const nextRuns = sessionRuns.filter((run: RunRecord) => !scopeRunId || run.id === scopeRunId);
      setRuns(nextRuns);
      setPublished(publishedData.artifacts || []);
      setStaleAt(null);
      const acceptanceEntries = await Promise.all(nextRuns.slice(0, 12).map(async (run: RunRecord) => {
        try { const result = (await getRunAcceptance(run.id)) as RunRecord; return [run.id, result.run?.acceptance || result.acceptance || null]; } catch { return [run.id, null]; }
      }));
      if (requestSeq !== refreshSeqRef.current) return;
      setAcceptance(Object.fromEntries(acceptanceEntries.filter(([, value]) => value)) as Record<string, RunRecord | null>);
    } catch (error) {
      if (requestSeq === refreshSeqRef.current) setLoadError({ message: (error as Error | undefined)?.message || "成果读取失败", source: "成果" });
    }
    if (requestSeq === refreshSeqRef.current) setLoading(false);
  };

  // 根级事件流每收到一次重要事件都会递增 refreshToken；任务完成后必须立即
  // 重新读取 Run 和固定成果，否则用户会看到旧的"暂无产物"，直到手动刷新。
  useEffect(() => { void refresh(); // eslint-disable-line react-hooks/exhaustive-deps
  }, [workspace, projectId, currentSessionId, selectedRunId, artifactScope, refreshToken]);

  const entries = useMemo(() => runs.flatMap((run) => (run.artifacts || []).filter((item: RunRecord) => item.status !== "deleted").map((artifact: RunRecord) => ({ artifact, run }))), [runs]);
  const publishedByArtifact = useMemo(() => new Map(published.map((item) => [item.artifactId, item])), [published]);
  const readyCount = entries.filter(({ artifact, run }) => {
    const result = acceptance[run.id]?.artifacts?.find((item: RunRecord) => item.path === artifact.path) || artifact.acceptance;
    const resultStatus = result?.status || artifact.acceptanceStatus || "not_checked";
    const publication = publishedByArtifact.get(artifact.artifactId);
    return artifactStatusInfo({ publication, result, resultStatus, runStatus: run.status }).canPublish;
  }).length;
  // 只有「尚未回滚且存在上一正式版本」的成果才真正可回滚；首个版本没有历史版本。
  const rollbackableCount = published.filter((item) => item.status !== "rolled_back" && item.rollbackTarget).length;
  // W3/C02：本轮（最新 Run）的文件改动与内容差异。B03 会把"改动"做成独立右栏页签，
  // 这里先接到产物面板，让用户今天就能打开差异；仍按 runId 归属，不做跨轮聚合。
  const latestRun = useMemo(() => {
    const scoped = (runs || []).filter((run) => Boolean(currentSessionId) && run.sessionId === currentSessionId);
    return scoped[0] || null;
  }, [runs, currentSessionId]);
  const latestChanges = useMemo(() => {
    if (!latestRun) return [];
    const view = projectRunView(latestRun, Array.isArray(latestRun.events) ? latestRun.events : []);
    return view.changes || [];
  }, [latestRun]);

  const runAction = async (key: string, callback: () => Promise<unknown>) => {
    setAction(key);
    try { await callback(); await refresh(); } catch (error) { notifyError((error as Error | undefined)?.message || "成果操作失败"); }
    setAction("");
  };

  return (
    <div className="preview-artifact-panel artifact-workspace">
      <div className="artifact-workspace-head">
        <div><span className="artifact-eyebrow">工作产物 · 当前会话</span><h3>产物验收与固定</h3><p>先打开预览确认内容，再固定为正式成果。只有「文件格式验收通过 + 所属任务成功结束 + 尚未固定」的文件才可固定；格式验收通过不等于任务成功，失败任务的文件不能固定。固定后若存在上一正式版本可一键回滚，首个版本没有历史版本，需手动恢复。</p></div>
        <div className="artifact-scope-switch" role="tablist" aria-label="产物范围">
          <button type="button" className={artifactScope === "run" ? "active" : ""} onClick={() => onArtifactScopeChange?.("run")} role="tab" aria-selected={artifactScope === "run"} title="只看本轮（选中的这一次运行）">本轮</button>
          <button type="button" className={artifactScope === "session" ? "active" : ""} onClick={() => onArtifactScopeChange?.("session")} role="tab" aria-selected={artifactScope === "session"} title="当前会话的全部产出">会话</button>
        </div>
        <button className="btn-sm" onClick={() => void refresh()} disabled={loading} title="刷新产物"><Icon name="refresh" size={12} /> {loading ? "读取中…" : "刷新"}</button>
      </div>
      <div className="artifact-summary-grid">
        <div><strong>{entries.length}</strong><span>{artifactScope === "run" ? "本轮产物" : "会话产物"}</span></div>
        <div title="仅统计：格式验收通过、所属任务成功结束、且尚未固定的文件"><strong>{readyCount}</strong><span>待固定</span></div>
        <div><strong>{published.length}</strong><span>正式版本</span></div>
      </div>
      {latestRun && latestChanges.length > 0 && (
        <div className="artifact-changes-card">
          <FileChangesPanel
            runId={latestRun.id}
            changes={latestChanges}
            detection={{ truncated: Boolean(latestRun.snapshotTruncated) }}
            onOpenFile={(relative: string) => onOpenFile?.(relative)}
          />
        </div>
      )}
      <div className="artifact-list-card">
        <div className="artifact-list-head"><span>{artifactScope === "run" ? "本轮文件" : "会话文件"}</span><small>{currentSessionId ? (artifactScope === "run" ? "已按当前 Run 筛选" : "已按当前会话筛选") : "当前工作区"}</small></div>
        {/* 交互 6：读取失败必须自报家门并给重试，不能退化成"暂未生成产物"。 */}
        {loadError && (
          <div className="preview-empty artifact-load-error" role="alert">
            <Icon name="warning" size={16} />
            <span>读取失败（{loadError.source}）：{loadError.message}</span>
            {staleAt && <small>下方保留的是 {new Date(staleAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 之前读取的数据</small>}
            <button className="btn-xs" onClick={() => void refresh()} disabled={loading}>{loading ? "重试中…" : "重试"}</button>
          </div>
        )}
        {loading && <div className="preview-empty">正在读取产物清单…</div>}
        {!loading && !loadError && !entries.length && <div className="preview-empty"><Icon name="file" size={20} />{artifactScope === "run" ? "本轮暂未生成产物" : "当前会话暂未生成产物"}{runs.some((run) => run.snapshotTruncated) ? "（工作区过大，部分轮次的产物检测可能不完整）" : ""}</div>}
        {entries.map(({ artifact, run }, index) => {
        const name = artifactName(artifact.path);
        const isStaged = artifact.source === "staged"; // O-P1：运行中暂存条目（仅展示，不可打开/固定）
        const publication = publishedByArtifact.get(artifact.artifactId);
        const result = acceptance[run.id]?.artifacts?.find((item: RunRecord) => item.path === artifact.path) || artifact.acceptance;
        const resultStatus = result?.status || artifact.acceptanceStatus || "not_checked";
        const info = artifactStatusInfo({ publication, result, resultStatus, runStatus: run.status });
        const canConfirm = !isStaged && run.status === "completed" && !publication && result && !result.readyToPublish && resultStatus !== "failed";
        const canPublish = !isStaged && info.canPublish;
        return (
          <div className="preview-artifact" key={`${artifact.artifactId || artifact.path}-${index}`}>
            {isStaged ? (
              <span className="preview-artifact-main" title={`${artifact.path}（任务结束后可预览）`}>
                <Icon name="file" size={14} />
                <span><strong>{name}</strong><small>任务执行中 · 暂存未落盘</small></span>
              </span>
            ) : (
              <button className="preview-artifact-main" onClick={() => onOpenFile?.(artifact.path, undefined, run.cwd)} title={artifact.path}>
                <Icon name="file" size={14} />
                <span><strong>{name}</strong><small>{statusText[run.status] || run.status || "已完成"} · {String(artifact.path || "").replace(name, "").replace(/[\\/]$/, "") || "工作区根目录"}</small></span>
              </button>
            )}
            {isStaged && <span className="preview-artifact-status suspect" title="任务仍在执行，文件已暂存、尚未物化到工作区；任务结束后可预览与固定">任务中暂存</span>}
            {!isStaged && artifact.source === "unattributed" && <span className="preview-artifact-status suspect" title="本轮没有写入台账记录该文件，可能来自并发运行；仅作线索，未自动计入交付">未归属线索</span>}
            {!isStaged && artifact.source === "run-window" && <span className="preview-artifact-status suspect" title="本轮确有写入（台账只到工作区级，bash / officecli 不回报具体路径），按“运行窗口内变更”归属到本轮；若同一工作区有并行运行，可能来自它">待确认</span>}
            {!isStaged && <span className={`preview-artifact-status ${info.tone}`} title={info.hint}>{info.label}</span>}
            {canConfirm && <button className="btn-xs" disabled={action === `confirm-${artifact.artifactId}`} onClick={() => void runAction(`confirm-${artifact.artifactId}`, async () => { const note = window.prompt("请输入人工确认说明（可选）", "已检查内容、格式和页面显示"); if (note !== null) await confirmArtifactAcceptance(run.id, artifact.artifactId, note); })}>人工确认</button>}
            {canPublish && <button className="btn-xs" disabled={action === `publish-${artifact.artifactId}`} onClick={() => void runAction(`publish-${artifact.artifactId}`, () => publishArtifact(run.id, artifact.artifactId))}>固定成果</button>}
          </div>
        );
        })}
      </div>
      {published.length > 0 && <div className="preview-publications artifact-publications"><div className="artifact-list-head"><span>正式成果版本</span><small>{rollbackableCount ? `可回滚 ${rollbackableCount} 个（回到上一正式版本）` : "当前没有可回滚的历史版本"}</small></div>{published.map((item) => {
        const rolledBack = item.status === "rolled_back";
        const canRollback = !rolledBack && !!item.rollbackTarget;
        return <div className="preview-publication" key={item.id}><span title={item.path}><Icon name="check" size={12} /> {artifactName(item.path)} · v{item.version}{rolledBack ? " · 已回滚" : ""}</span>{canRollback ? <button className="btn-xs" onClick={() => void runAction(`rollback-${item.id}`, () => rollbackPublishedArtifact(item.id))}>回滚</button> : <small className="preview-publication-note">{rolledBack ? "已回滚" : "首个版本 · 无历史版本可回滚"}</small>}</div>;
      })}</div>}
    </div>
  );
}


/**
 * 改动页签（W3/C02 + C03）："本轮"指一次 Run，不再跨轮聚合。
 * 默认看最新一轮；可在同一会话的运行列表里切换（会话历史独立展示）。
 */
function RunChangesPanel({ workspace, projectId, currentSessionId, selectedRunId = "", refreshToken = 0, onOpenFile }: Omit<ArtifactPanelProps, "artifactScope" | "onArtifactScopeChange">) {
  const [pickedRunId, setPickedRunId] = useState(selectedRunId || "");
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [latestRun, setLatestRun] = useState<RunRecord | null>(null);
  const [detail, setDetail] = useState<RunRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const refreshSeqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => { setPickedRunId(selectedRunId || ""); }, [selectedRunId]);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const requestSeq = ++refreshSeqRef.current;
    const timeoutId = window.setTimeout(() => controller.abort(), 15000);
    setLoading(true);
    setError("");
    try {
      // 改动页只需要当前会话的 Run 清单；不要先下载整个工作区的 SSE 事件再在浏览器筛选。
      const listed = (await listRuns("", 60, {
        cwd: workspace,
        projectId,
        sessionId: currentSessionId,
        includeEvents: "none",
        signal: controller.signal,
      })) as RunRecord;
      if (requestSeq !== refreshSeqRef.current) return;
      const sessionRuns = (listed.runs || []).filter((run: RunRecord) => !currentSessionId || run.sessionId === currentSessionId);
      const scoped = sessionRuns.filter((run: RunRecord) => run?.artifacts?.length);
      const wanted = pickedRunId || scoped[0]?.id || "";
      const fetched = wanted ? await getRun(wanted, { signal: controller.signal }).catch((err: unknown) => {
        if (controller.signal.aborted) throw err;
        return null;
      }) : null;
      if (requestSeq !== refreshSeqRef.current) return;
      setRuns(scoped);
      setLatestRun(sessionRuns[0] || null);
      setDetail((fetched as RunRecord | null)?.run || scoped[0] || null);
    } catch (err) {
      if (requestSeq !== refreshSeqRef.current) return;
      setError(controller.signal.aborted ? "读取本轮改动超时，请检查本地服务后重试。" : (err as Error | undefined)?.message || String(err));
      setRuns([]);
      setLatestRun(null);
      setDetail(null);
    } finally {
      window.clearTimeout(timeoutId);
      if (requestSeq === refreshSeqRef.current) setLoading(false);
    }
  }, [workspace, projectId, currentSessionId, pickedRunId]);

  useEffect(() => {
    void load();
    return () => {
      refreshSeqRef.current += 1;
      abortRef.current?.abort();
    };
  }, [load, refreshToken]);

  const changes = useMemo(() => {
    if (!detail) return [];
    const view = projectRunView(detail, Array.isArray(detail.events) ? detail.events : []);
    return view.changes || [];
  }, [detail]);

  const isLatest = !pickedRunId || (runs[0]?.id && runs[0].id === (detail?.id || ""));

  return (
    <div className="preview-artifact-panel artifact-workspace run-changes-workspace">
      <div className="artifact-workspace-head">
        <div>
          <span className="artifact-eyebrow">文件改动 · {isLatest ? "最新一轮" : "历史某一轮"}</span>
          <h3>本轮文件改动</h3>
          <p>按 Run 归属列出真实改动；点文件名查看内容差异（文本给出行级增删，Office/PDF/图片只给大小与哈希摘要）。</p>
        </div>
        <button className="btn-sm" onClick={() => void load()} disabled={loading} title="刷新改动"><Icon name="refresh" size={12} /> {loading ? "读取中…" : "刷新"}</button>
      </div>
      {runs.length > 1 && (
        <div className="run-changes-picker">
          <label>
            <span>查看哪一轮</span>
            <select className="sp-select" value={detail?.id || ""} onChange={(event) => setPickedRunId(event.target.value)}>
              {runs.map((run) => (
                <option key={run.id} value={run.id}>
                  {`${(run.finishedAt || run.startedAt || "").slice(5, 16).replace("T", " ")} · ${run.status || "?"} · ${(run.artifacts || []).length} 个文件`}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {error && <div className="model-feedback warn">读取改动失败：{error}</div>}
      {loading && <div className="preview-empty">正在读取本轮改动…</div>}
      {!loading && !error && latestRun && (!detail || latestRun.id !== detail.id) && (
        <div className="run-changes-note">
          最近一次运行（{(latestRun.finishedAt || latestRun.startedAt || "").slice(5, 16).replace("T", " ")} · {statusText[latestRun.status] || latestRun.status || "?"}）
          {latestRun.status === "cancelled" ? "被中断" : latestRun.status === "failed" ? "失败" : "没有捕获到文件改动"}
          ，{runs.length ? "下面显示最近有改动的一轮。" : "当前会话还没有可展示的改动记录。"}
        </div>
      )}
      {!loading && !error && !runs.length && (
        <div className="preview-empty"><Icon name="file" size={20} />当前会话还没有捕获到文件改动（运行产生文件后才会记录）</div>
      )}
      {!loading && !error && runs.length > 0 && (
        <FileChangesPanel
          runId={detail?.id || ""}
          changes={changes}
          detection={{ truncated: Boolean(detail?.snapshotTruncated) }}
          onOpenFile={onOpenFile}
        />
      )}
    </div>
  );
}

export interface WorkProductPanelProps extends ArtifactPanelProps {
  clientId?: string;
  threadId?: string;
  /** B03 页签：document（默认，透传 children）/ changes / artifacts；subagent 随 SubagentDetailPanel 迁移后补齐 */
  tab?: string;
  /** 子代理详情数据（subagent 页签消费；本批未启用，保留接口位） */
  subagentBlock?: RunRecord | null;
  children?: React.ReactNode;
}

export default function WorkProductPanel({ tab, workspace, projectId, currentSessionId, selectedRunId = "", artifactScope = "session", onArtifactScopeChange, refreshToken = 0, onOpenFile, children }: WorkProductPanelProps) {
  // B03：右栏页签 —— 预览 / 改动 / 产物；subagent 为按需打开的「子代理详情」页
  //（SubagentDetailPanel 未迁移，分支随其迁移后补齐，见模块头注释）。
  if (tab === "changes") return <RunChangesPanel workspace={workspace} projectId={projectId} currentSessionId={currentSessionId} selectedRunId={selectedRunId} refreshToken={refreshToken} onOpenFile={onOpenFile} />;
  if (tab === "artifacts") return <ArtifactPanel workspace={workspace} projectId={projectId} currentSessionId={currentSessionId} selectedRunId={selectedRunId} artifactScope={artifactScope} onArtifactScopeChange={onArtifactScopeChange} refreshToken={refreshToken} onOpenFile={onOpenFile} />;
  return children;
}
