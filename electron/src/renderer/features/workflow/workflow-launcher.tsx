/**
 * 工作流启动器（Qoder 对标 M4.4，只读版）—— WorkflowLauncher.jsx 逐行等价 TS 化
 * （F6-1，BRD-009）。
 *
 * 消费 `GET /api/workflows` 在开关打开时追加的 `domain` 字段（§4.3 六个交通
 * 规划领域工作流声明），把声明式契约摊开给用户看：阶段 / 工具白名单 / 预算 /
 * 产物契约 / 前置硬约束，并可用「预检试算」把坐标、记录数、产物路径交给服务端
 * 的纯函数检查器跑一遍（`POST /api/domain-workflows/preflight`，只读、无副作用）。
 *
 * 边界（刻意不做）：
 *   - 不猜测、不伪造运行进度：阶段条一律按「未开始」渲染，运行期状态要等执行侧接线；
 *   - 不发任务、不改任何运行状态：本面板只读，不碰 ChatPanel 与 Run 链路。
 *
 * 迁移留档：
 * - 数据通道：api.js 的 listWorkflows/preflightDomainWorkflow 改走 api/client-api
 *   的 op:workflows:list / op:workflows:preflight（IPC 通道），
 *   「成功返回 data、失败 throw」语义与旧 api() 一致。
 * - 由 App 侧 `flag("domainWorkflows")` 门控：开关关闭时该组件不会被渲染
 *   （desktop 侧为 workbench 挂载点的 flag 门控，行为一致）。
 * - 旧 JSX 对声明式契约字段（budget/preflight/stages/tools/artifacts）取值无空值
 *   防护（畸形声明会抛 TypeError 白屏）；TS 严格下按 evident intent 补 `?.`/`??`
 *   空值收口，well-formed 声明下渲染逐字节等价。
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import Icon from "../../components/Icon";
import 阶段条 from "./stage-bar";
import { listWorkflows, preflightDomainWorkflow } from "../../api/client-api";
import type { DomainWorkflowRecord } from "../../../shared/protocol/channels";

const 预检标签: Record<string, string> = {
  geoRange: "坐标范围",
  recordCount: "记录数一致性",
  writeBackGuard: "写回确认",
  artifactRoot: "产物根目录",
};

/** 预检试算结果（运行预检纯函数的返回视图，字段为中文键）。 */
interface 预检视图 {
  ok?: boolean;
  摘要?: string;
  检查结果?: Array<{
    检查项?: string;
    ok?: boolean;
    摘要?: string;
    违规?: Array<{ 原因?: string }>;
  }>;
  [key: string]: unknown;
}

function 解析坐标点(文本: unknown): Array<{ 经度?: number; 纬度?: number }> {
  return String(文本 || "")
    .split(/[\n;；]+/)
    .map((行) => 行.trim())
    .filter(Boolean)
    .map((行) => {
      const 段 = 行.split(/[,，\s]+/).map((值) => Number(值));
      return { 经度: 段[0], 纬度: 段[1] };
    });
}

function 格式预算(毫秒: unknown): string {
  const 分钟 = Math.round(Number(毫秒) / 60000);
  return Number.isFinite(分钟) && 分钟 > 0 ? `${分钟} 分钟` : "—";
}

export interface 工作流启动器Props {
  onClose?: () => void;
}

export default function 工作流启动器({ onClose }: 工作流启动器Props): React.JSX.Element {
  const [列表, set列表] = useState<DomainWorkflowRecord[]>([]);
  const [选中, set选中] = useState("");
  const [读取失败, set读取失败] = useState("");
  const [试算中, set试算中] = useState(false);
  const [试算结果, set试算结果] = useState<预检视图 | null>(null);
  const [试算失败, set试算失败] = useState("");
  const [坐标文本, set坐标文本] = useState("120.1, 30.2");
  const [声明数, set声明数] = useState("1000");
  const [实际数, set实际数] = useState("1000");
  const [写回工具, set写回工具] = useState("officecli");
  const [已确认, set已确认] = useState(false);
  const [产物路径, set产物路径] = useState("报告/评估.docx");

  const 刷新 = useCallback(async () => {
    set读取失败("");
    try {
      const data = await listWorkflows();
      const domain = Array.isArray(data?.domain) ? data.domain : [];
      set列表(domain);
      if (data?.domainError) set读取失败(String(data.domainError));
      set选中((当前) => (当前 && domain.some((项) => 项.id === 当前) ? 当前 : domain[0]?.id || ""));
    } catch (error) {
      set列表([]);
      set读取失败(String((error as { message?: unknown })?.message || error));
    }
  }, []);

  useEffect(() => { void 刷新(); }, [刷新]);

  const 当前 = useMemo(() => 列表.find((项) => 项.id === 选中) || null, [列表, 选中]);

  // 选中工作流变化时清掉上一次的试算结果，避免把 A 的结果看成 B 的。
  useEffect(() => { set试算结果(null); set试算失败(""); }, [选中]);

  const 试算 = useCallback(async () => {
    if (!当前) return;
    set试算中(true);
    set试算失败("");
    try {
      const 结果 = await preflightDomainWorkflow({
        workflowId: 当前.id,
        坐标点: 解析坐标点(坐标文本),
        记录数: { 声明数: Number(声明数), 实际数: Number(实际数), 名称: "OD 记录集" },
        写回: { 工具: 写回工具, 已确认 },
        产物路径,
      });
      set试算结果((结果?.预检 as 预检视图 | undefined) ?? null);
    } catch (error) {
      set试算结果(null);
      set试算失败(String((error as { message?: unknown })?.message || error));
    } finally {
      set试算中(false);
    }
  }, [当前, 坐标文本, 声明数, 实际数, 写回工具, 已确认, 产物路径]);

  if (读取失败 && !列表.length) {
    return (
      <div className="wf-panel">
        <p className="wf-empty"><Icon name="info" size={14} /> 领域工作流不可用：{读取失败}</p>
        <button className="btn-xs" onClick={() => void 刷新()}><Icon name="refresh" size={12} /> 重新读取</button>
      </div>
    );
  }

  if (!列表.length) {
    return (
      <div className="wf-panel">
        <p className="wf-empty"><Icon name="info" size={14} /> 领域工作流未启用（服务端开关 OAW_DOMAIN_WORKFLOWS 关闭时此处为空）。</p>
      </div>
    );
  }

  return (
    <div className="wf-panel">
      <div className="wf-picker" role="tablist" aria-label="领域工作流">
        {列表.map((项) => (
          <button
            key={项.id}
            role="tab"
            aria-selected={项.id === 选中}
            className={`wf-picker-item${项.id === 选中 ? " active" : ""}`}
            onClick={() => set选中(项.id)}
            title={`${项.title} · ${项.id}`}
          >
            <Icon name="flow" size={13} />
            <span>{项.title}</span>
          </button>
        ))}
      </div>

      {当前 && (
        <>
          <p className="wf-desc">{当前.description}</p>
          <div className="wf-meta">
            <span className="wf-chip" title="预算上限：模型回合 / 工具调用 / 墙钟时长">
              <Icon name="route" size={12} /> {当前.budget?.maxTurns} 回合 · {当前.budget?.maxToolCalls} 次工具 · {格式预算(当前.budget?.maxWallMs)}
            </span>
            <span className="wf-chip" title="前置硬约束（失败即阻断）">
              <Icon name="lock" size={12} /> {(当前.preflight ?? []).map((项) => 预检标签[项] || 项).join(" / ") || "无"}
            </span>
          </div>

          <h4 className="wf-title">阶段</h4>
          <阶段条 stages={(当前.stages ?? []).map((s) => ({ ...s, id: s.id ?? "" }))} />

          <h4 className="wf-title">工具白名单（{(当前.tools ?? []).length}）</h4>
          <div className="wf-tools">
            {(当前.tools ?? []).map((工具) => <code key={工具} className="wf-tool">{工具}</code>)}
          </div>

          <h4 className="wf-title">产物契约</h4>
          <ul className="wf-artifacts">
            {(当前.artifacts ?? []).map((产物) => (
              <li key={产物.id} className={产物.required ? "wf-artifact required" : "wf-artifact"}>
                <Icon name={产物.required ? "check" : "doc"} size={12} />
                <span className="wf-artifact-title">{产物.title}</span>
                <span className="wf-artifact-kind">{产物.kind}</span>
                {产物.required && <span className="wf-artifact-flag">必需</span>}
              </li>
            ))}
          </ul>

          <h4 className="wf-title">预检试算（只读，不产生任何副作用）</h4>
          <div className="wf-form">
            <label className="wf-field">
              <span>坐标点（每行 <code>经度,纬度</code>）</span>
              <textarea value={坐标文本} onChange={(事件) => set坐标文本(事件.target.value)} rows={2} spellCheck={false} />
            </label>
            <div className="wf-field-row">
              <label className="wf-field">
                <span>声明记录数</span>
                <input value={声明数} onChange={(事件) => set声明数(事件.target.value)} inputMode="numeric" />
              </label>
              <label className="wf-field">
                <span>实际记录数</span>
                <input value={实际数} onChange={(事件) => set实际数(事件.target.value)} inputMode="numeric" />
              </label>
            </div>
            <div className="wf-field-row">
              <label className="wf-field">
                <span>写回工具</span>
                <input value={写回工具} onChange={(事件) => set写回工具(事件.target.value)} />
              </label>
              <label className="wf-field wf-field-check">
                <input type="checkbox" checked={已确认} onChange={(事件) => set已确认(事件.target.checked)} />
                <span>用户已确认写回</span>
              </label>
            </div>
            <label className="wf-field">
              <span>产物路径（相对工作区）</span>
              <input value={产物路径} onChange={(事件) => set产物路径(事件.target.value)} />
            </label>
            <div className="wf-form-actions">
              <button className="btn-xs" onClick={() => void 试算()} disabled={试算中}>
                <Icon name={试算中 ? "loading" : "flow"} size={12} /> {试算中 ? "试算中…" : "运行预检"}
              </button>
            </div>
          </div>

          {试算失败 && <p className="wf-error"><Icon name="warning" size={12} /> {试算失败}</p>}

          {试算结果 && (
            <div className="wf-result" role="status">
              <p className={试算结果.ok ? "wf-result-head ok" : "wf-result-head bad"}>
                <Icon name={试算结果.ok ? "check" : "warning"} size={13} /> {试算结果.摘要}
              </p>
              <ul className="wf-checks">
                {(试算结果.检查结果 ?? []).map((检查, 检查索引) => (
                  <li key={检查.检查项 ?? 检查索引} className={检查.ok ? "wf-check ok" : "wf-check bad"}>
                    <i className={`wf-dot wf-dot-${检查.ok ? "done" : "failed"}`} aria-hidden="true" />
                    <span className="wf-check-name">{预检标签[检查.检查项 ?? ""] || 检查.检查项}</span>
                    <span className="wf-check-msg">{检查.摘要}</span>
                    {!检查.ok && (检查.违规 ?? []).length > 0 && (
                      <ul className="wf-violations">
                        {检查.违规!.slice(0, 3).map((违规, 索引) => <li key={索引}>{违规.原因}</li>)}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {onClose && (
        <div className="wf-foot">
          <button className="btn-xs" onClick={onClose}><Icon name="close" size={12} /> 关闭</button>
        </div>
      )}
    </div>
  );
}
