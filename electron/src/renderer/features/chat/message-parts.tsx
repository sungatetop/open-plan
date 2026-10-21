/**
 * 对话消息叶子展示件（F3 批6d-1）：自 client/src/components/ChatPanel.jsx
 * 拆出的展示层叶子组件族（SafeMarkdown / 流式指示 / 思考块 / 工具卡 / 流水线卡 /
 * 子代理卡 / 引用条），与原实现逐行等价，对拍强制 tests/f3-batch6d1-parity.test.tsx。
 *
 * 消息组件（Message）与结果卡（RunSummary）由批6d-2 迁移；主组件编排由批6d-3 接线。
 */
import React, { useState, useRef, useEffect } from "react";
import MarkdownBody from "../../components/MarkdownBody";
import Icon from "../../components/Icon";
import ToolIdentityIcon from "../../components/SemanticToolIcon";
import Logo from "../../components/Logo";
import { toolIdentity } from "../../lib/event-display";
import { isMotionReduced } from "../../lib/ui-appearance";
import { loadSettings } from "../../lib/settings";
import { flag } from "../../lib/feature-flags";
import { getBrowserStreamState } from "../../lib/browser-linkage";

/** 宽松结构类型：块 / 引用条目（已知字段之外全走索引签名，对齐 chat-shared 的视图类型约定）。 */
export interface ToolBlock {
  id?: string;
  type?: string;
  name?: string;
  input?: unknown;
  output?: string | null;
  result?: string | null;
  done?: boolean;
  isError?: boolean;
  expanded?: boolean;
  duration?: number | string;
  startMissing?: boolean;
  toolCallId?: string;
  [key: string]: unknown;
}

export interface ReferenceItem {
  id?: string;
  kind?: string;
  status?: string;
  target?: string;
  message?: string;
  metadata?: { name?: string; relativePath?: string } | null;
  [key: string]: unknown;
}

// ============================================================================
// SafeMarkdown（大文本降级 + 流式进行中的轻量可读文本）
// ============================================================================

const MAX_MARKDOWN_CHARS = 100000;

/** 流式输出尚未闭合的 Markdown 可能暂时暴露 `##`、`**` 等标记；
 * 进行中先用轻量清理显示可读文本，结束后仍由 SafeMarkdown 完整排版。 */
export function readableProgressText(value: unknown): string {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line
      .replace(/^\s{0,3}#{1,6}\s+/, "")
      .replace(/^\s*>+\s?/, "")
      .replace(/^\s*(?:[-+*]|\d+[.)])\s+/, "")
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/\*\*|__|~~/g, "")
      .replace(/(^|[\s\p{P}])\*(?=\S)|(?<=\S)\*(?=$|[\s\p{P}])/gu, "$1")
      .replace(/(^|[\s\p{P}])_(?=\S)|(?<=\S)_(?=$|[\s\p{P}])/gu, "$1")
      .replace(/`{1,3}/g, "")
      .replace(/^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/, "")
      .replace(/\s*\|\s*/g, " · ")
      .trimEnd())
    .join("\n");
}

export function SafeMarkdown({ text, onOpenFile, artifacts }: {
  text?: string | null;
  onOpenFile?: (path: string) => void;
  artifacts?: unknown[] | null;
}) {
  const [showRaw, setShowRaw] = useState(false);
  if (!text) return null;
  // artifacts 旧侧可传 null（无产物），MarkdownBody 内部按 falsy 处理，null→undefined 等价
  if (text.length <= MAX_MARKDOWN_CHARS) return <MarkdownBody onOpenFile={onOpenFile} artifacts={artifacts ?? undefined}>{text}</MarkdownBody>;
  if (!showRaw) {
    return (
      <button className="large-msg-reveal" onClick={() => setShowRaw(true)}>
        ⚠ 内容过长（{(text.length / 1024).toFixed(0)} KB），点击查看全文
      </button>
    );
  }
  return <pre className="large-msg-raw">{text}</pre>;
}

// ============================================================================
// 引用条（@ 文件引用）
// ============================================================================

export function ReferenceChips({ references = [], onOpenFile }: {
  references?: ReferenceItem[];
  onOpenFile?: (path: string) => void;
}) {
  if (!references.length) return null;
  return (
    <div className="msg-references" aria-label="本轮引用">
      {references.map((r) => {
        const label = r.metadata?.name || r.metadata?.relativePath || r.target;
        const canOpen = r.kind === "file" && !!onOpenFile && r.status !== "missing";
        const content = <><Icon name="file" size={12} /> @{label}</>;
        return canOpen ? (
          <button type="button" className={`msg-reference-chip ${r.status || ""}`} key={r.id} onClick={() => onOpenFile((r.metadata?.relativePath || r.target) as string)} title={`打开引用：${label}`}>{content}</button>
        ) : (
          <span className={`msg-reference-chip ${r.status || ""}`} key={r.id} title={r.message || label}>{content}</span>
        );
      })}
    </div>
  );
}

// ============================================================================
// 流式指示器（四瓣 Logo + 轮换活动短语）
// ============================================================================

const STREAMING_ACTIVITY_LABELS = [
  "正在聚合资料", "正在梳理需求", "正在检索规范", "正在调查现状",
  "正在比对数据", "正在提炼要点", "正在搭建分析框架", "正在开展专题分析",
  "正在核对关键结论", "正在整理图表", "正在撰写章节", "正在合并稿件",
  "正在统一口径", "正在校对格式", "正在检查引用", "正在生成成果",
];

export function StreamingActivityLabel() {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (isMotionReduced()) return undefined;
    const timer = window.setInterval(() => setIndex((value) => (value + 1) % STREAMING_ACTIVITY_LABELS.length), 4200);
    return () => window.clearInterval(timer);
  }, []);
  return <span className="msg-streaming-label" aria-live="off">{STREAMING_ACTIVITY_LABELS[index]}</span>;
}

export function StreamingDot() {
  return (
    <span className="streaming-dot" title="正在处理" aria-hidden="true">
      <Logo size={16} withBackground={false} markColor="currentColor" className="streaming-dot-mark" />
    </span>
  );
}

// ============================================================================
// 思考过程块（证据层，默认收起；真按钮 + ARIA，键盘可展开）
// ============================================================================

export function ThinkingBlock({ text, startTime, streaming, embedded = false }: {
  text?: string | null;
  startTime?: unknown;
  streaming?: boolean;
  embedded?: boolean;
}) {
  // 结论优先：思考属于可展开的证据层，默认收起；默认值尊重设置面板的 thinkingDefaultOpen。
  const [expanded, setExpanded] = useState(() => loadSettings().thinkingDefaultOpen === true);
  const [duration, setDuration] = useState<string | null>(null);
  const idRef = useRef<string | null>(null);
  if (idRef.current === null) idRef.current = `thinking-${Math.random().toString(36).slice(2, 9)}`;

  // 流式结束时：计算耗时
  useEffect(() => {
    if (streaming) return;
    if (startTime) setDuration(((Date.now() - (startTime as number)) / 1000).toFixed(1));
  }, [streaming, startTime]);

  if (embedded) {
    return (
      <section className={`thinking-process-inline ${streaming ? "is-streaming" : ""}`}>
        <div className="thinking-process-heading">
          <ToolIdentityIcon name="__thinking__" size={12} />
          <span>思考</span>
          {streaming ? <span>思考中…</span> : duration ? <span>思考了 {duration}s</span> : <span>{String(text || "").length} 字</span>}
        </div>
        <div className="thinking-text">{text}</div>
      </section>
    );
  }

  return (
    <div className={`thinking-block ${expanded ? "expanded" : ""}`}>
      <button
        type="button"
        className="thinking-header"
        aria-expanded={expanded}
        aria-controls={idRef.current}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="thinking-icon" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
        <span className="thinking-label"><ToolIdentityIcon name="__thinking__" size={12} /> 思考</span>
        {streaming && <span className="thinking-status">思考中…</span>}
        {!streaming && duration && <span className="thinking-status">思考了 {duration}s</span>}
        {!streaming && !duration && <span className="thinking-status">{text?.length ?? 0} 字</span>}
      </button>
      {expanded && <div className="thinking-text" id={idRef.current}>{text}</div>}
    </div>
  );
}

// ============================================================================
// 编辑流水线阶段条（P2-A，方案 §5.2）
// ============================================================================

export interface PipelineStage {
  stage?: string;
  label?: string;
  status?: string;
  artifact?: string;
  issues?: string[];
  [key: string]: unknown;
}

export interface PipelineBlock {
  status?: string;
  format?: string;
  stages?: PipelineStage[];
  deliverable?: string;
  issues?: string[];
  [key: string]: unknown;
}

export function PipelineCard({ block, onOpenFile }: {
  block: PipelineBlock;
  onOpenFile?: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(block.status === "running");
  const stages = Array.isArray(block.stages) ? block.stages : [];
  const runningStage = stages.find((stage) => stage.status === "running");
  const failed = stages.some((stage) => stage.status === "failed") || block.status === "failed";
  const statusText = block.status === "completed" ? "已交付" : block.status === "failed" ? "未通过验收" : block.status === "cancelled" ? "已取消" : runningStage ? `进行中：${runningStage.label || runningStage.stage}` : "进行中";
  return (
    <section className={`pipeline-card ${block.status || "running"}`} aria-label={`编辑流水线（${block.format === "pptx" ? "PPT" : "Word"}）`}>
      <button type="button" className="pipeline-card-head" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
        <span className="pipeline-card-icon"><Icon name={failed ? "x" : block.status === "completed" ? "check" : "flow"} size={14} /></span>
        <span className="pipeline-card-title">
          <strong>编辑流水线 · {block.format === "pptx" ? "PPT" : "Word"}</strong>
          <small>{stages.length ? stages.map((stage) => stage.label || stage.stage).join(" → ") : "规划 → 撰写 → 排版 → 验收"}</small>
        </span>
        <span className="pipeline-card-status">{block.status === "running" && <i />} {statusText}</span>
        <span className={`pipeline-card-chevron ${expanded ? "open" : ""}`}>▸</span>
      </button>
      {expanded && <div className="pipeline-card-body">
        <ol className="pipeline-stages">
          {stages.map((stage) => (
            <li key={stage.stage} className={`pipeline-stage ${stage.status || "running"}`}>
              <span className="pipeline-stage-icon"><Icon name={stage.status === "done" || stage.status === "pass" || stage.status === "completed" ? "check" : stage.status === "running" ? "flow" : "x"} size={12} /></span>
              <div className="pipeline-stage-info">
                <b>{stage.label || stage.stage}</b>
                <em>{stage.status === "done" || stage.status === "pass" || stage.status === "completed" ? "完成" : stage.status === "revise" ? "需修订" : stage.status === "failed" ? "失败" : "进行中"}{stage.artifact ? ` · ${stage.artifact}` : ""}</em>
                {(stage.issues?.length ?? 0) > 0 && <span className="pipeline-stage-issues">{stage.issues!.slice(0, 3).join("；")}</span>}
              </div>
            </li>
          ))}
        </ol>
        {block.deliverable && (
          <div className="pipeline-deliverable">
            <b>产物</b>
            {onOpenFile
              ? <button type="button" className="pipeline-open" onClick={() => onOpenFile(block.deliverable!)}>{block.deliverable}</button>
              : <span>{block.deliverable}</span>}
          </div>
        )}
        {(block.issues?.length ?? 0) > 0 && <div className="pipeline-issues" role="status">待改进：{block.issues!.slice(0, 4).join("；")}</div>}
      </div>}
    </section>
  );
}

// ============================================================================
// 子代理卡
// ============================================================================

export interface SubagentTool {
  toolCallId?: string;
  name?: string;
  status?: string;
  isError?: boolean;
  [key: string]: unknown;
}

export interface SubagentBlock {
  status?: string;
  role?: string;
  summary?: string;
  preview?: string;
  tools?: SubagentTool[];
  verdict?: string;
  activity?: string;
  task?: string;
  thinking?: string;
  error?: string;
  [key: string]: unknown;
}

const SUBAGENT_ROLE_TEXT: Record<string, string> = { scout: "资料探索", reviewer: "审阅", planner: "方案拆解", verifier: "独立核验", worker: "执行" };
const SUBAGENT_VERDICT_TEXT: Record<string, string> = { pass: "核验通过", revise: "核验需修订", fail: "核验不通过" };

export function SubagentCard({ block, onOpenDetail }: {
  block: SubagentBlock;
  onOpenDetail?: (block: SubagentBlock) => void;
}) {
  const [expanded, setExpanded] = useState(block.status === "running");
  const statusText = block.status === "completed" ? "已完成" : block.status === "failed" ? "失败" : block.status === "cancelled" ? "已取消" : block.status === "planned" ? "已编排" : "执行中";
  const roleText = SUBAGENT_ROLE_TEXT[block.role || ""] || "只读任务";
  const content = block.summary || block.preview || "";
  const tools = Array.isArray(block.tools) ? block.tools : [];
  const runningTools = tools.filter((tool) => tool.status !== "done").length;
  const verdictText = SUBAGENT_VERDICT_TEXT[block.verdict || ""] || "";
  return (
    <section className={`subagent-card ${block.status || "running"}`} aria-label={`子 Agent：${roleText}`}>
      <button type="button" className="subagent-card-head" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
        <span className="subagent-card-icon"><Icon name={block.status === "completed" ? "check" : block.status === "failed" ? "x" : "robot"} size={14} /></span>
        <span className="subagent-card-title"><strong>子 Agent · {roleText}</strong><small>{block.activity || "隔离上下文 · 不继承主对话"}</small></span>
        {tools.length > 0 && <span className="subagent-card-toolcount">{runningTools ? `${tools.length} 个工具 · ${runningTools} 进行中` : `${tools.length} 个工具`}</span>}
        <span className="subagent-card-status">{block.status === "running" && <i />} {statusText}</span>
        <span className={`subagent-card-chevron ${expanded ? "open" : ""}`}>▸</span>
      </button>
      {expanded && <div className="subagent-card-body">
        <div className="subagent-card-actions">
          <button type="button" className="subagent-open-detail" onClick={() => onOpenDetail?.(block)}>
            <Icon name="file" size={12} /> 在右侧查看完整过程
          </button>
        </div>
        {block.task && <div className="subagent-task"><b>子任务</b><span>{block.task}</span></div>}
        {block.thinking && <div className="subagent-thinking"><b>思考</b><span>{block.thinking}</span></div>}
        {tools.length > 0 && <div className="subagent-tools">
          <b>工具调用</b>
          <div className="subagent-tool-list">
            {tools.map((tool, index) => (
              <span key={tool.toolCallId || `${tool.name}-${index}`} className={`subagent-tool ${tool.status === "done" ? (tool.isError ? "error" : "done") : tool.status === "planned" ? "planned" : "running"}`}>
                <Icon name={toolIdentity(tool.name).icon} size={12} />
                <em>{tool.name}</em>
                <i>{tool.status === "done" ? (tool.isError ? "失败" : "完成") : tool.status === "planned" ? "计划" : "执行中"}</i>
              </span>
            ))}
          </div>
        </div>}
        {verdictText && <div className={`subagent-verdict ${block.verdict}`}><b>核验</b><span>{verdictText}</span></div>}
        {block.error && <div className="subagent-error" role="alert">{block.error}</div>}
        {content && <div className={`subagent-result ${block.status === "running" ? "preview" : ""}`}>{block.status === "running" ? readableProgressText(content) : <SafeMarkdown text={content} />}</div>}
        {!content && !block.error && <div className="subagent-placeholder">子任务使用隔离上下文与受权工具执行，不继承主对话内容。</div>}
      </div>}
    </section>
  );
}

// ============================================================================
// 工具语义短语 + 工具卡（Proma ToolUseBlock：状态图标 + 语义短语 + 展开详情）
// ============================================================================

export function toolPhrase(name: unknown, input: unknown, done: unknown): string {
  let arg: unknown = "";
  try {
    // 旧实现：typeof input === "object" 时不做 JSON 解析（含 null，取属性抛错走 catch）
    const obj = (typeof input === "object" ? input : JSON.parse((input as string) || "{}")) as Record<string, unknown> | null;
    arg = obj?.args || obj?.file_path || obj?.filePath || obj?.path || obj?.pattern || obj?.query || obj?.cwd || "";
  } catch {}
  arg = String(arg || "").trim();
  const tail = arg ? ` ${(arg as string).slice(0, 60)}` : "";
  const loading = done ? "" : "正在";
  switch (name) {
    case "read": return `${loading}读取文件${tail}`;
    case "write": return `${loading}写入文件${tail}`;
    case "edit": return `${loading}编辑文件${tail}`;
    case "bash": return `执行命令${tail}`;
    case "officecli": return `操作 Office 文档${tail}`;
    case "todo": return `${loading}更新任务清单`;
    case "grep": return `${loading}搜索内容${tail}`;
    case "kb_search": return `${loading}搜索知识库${tail}`;
    case "kb_read": return `${loading}读取知识库${tail}`;
    case "skills_search": return `${loading}搜索 Skills${tail}`;
    case "skills_read": return `${loading}读取 Skill 说明${tail}`;
    case "find": case "ls": return `${loading}查看文件列表${tail}`;
    case "glob": return `${loading}查找文件${tail}`;
    case "webSearch": return `${loading}联网搜索${tail}`;
    case "webFetch": return `${loading}抓取网页${tail}`;
    case "TaskCreate": return `创建任务${tail}`;
    case "TaskUpdate": return `更新任务${tail}`;
    default: return `${loading}调用 ${name}${tail}`;
  }
}

export function ToolCard({ tool, onToggle }: {
  tool: ToolBlock;
  onToggle?: () => void;
}) {
  const { name, input, output, done, isError, expanded, duration } = tool;
  // 命令预览：bash/officecli 等命令行工具显示 $ 前缀
  // 注意：JSON.stringify(undefined) 返回 undefined，历史会话中 tool.input 可能缺失
  let inputStr = typeof input === "string" ? input : (input != null ? JSON.stringify(input, null, 2) : "");
  try {
    if (typeof input === "object" && input != null && (input as Record<string, unknown>).args) {
      const args = (input as Record<string, unknown>).args;
      inputStr = typeof args === "string" ? args : JSON.stringify(args);
    }
  } catch {}
  const isCmd = name === "bash" || name === "officecli" || name === "find" || name === "grep" || name === "ls" || name === "cat";
  // 阶段 4.3：地图工具与普通文件工具区分（左侧色条 + 可读徽标）。
  // 判定沿用工具语义图标的同一来源（map_* 前缀），不另建映射。
  const isMapTool = /^map_/.test(String(name || ""));
  const fullInput = inputStr.replace(/\s+/g, " ").trim();
  const cmdPreview = isCmd ? `${fullInput.slice(0, 96)}${fullInput.length > 96 ? "…" : ""}` : fullInput.slice(0, 80);
  const outputPreview = output && output.length > 300 ? output.slice(0, 300) + "..." : output;
  // O-P5：browser_screenshot 结果内嵌截图回看（结果 JSON 的 details.file 指向服务端落盘文件）
  let shotInfo: { name: string } | null = null;
  if (done && !isError && name === "browser_screenshot") {
    const raw = String(output || tool.result || "");
    const matched = raw.match(/"file"\s*:\s*"([^"]*?(?:shot|page)-[\w-]+\.(?:jpg|pdf))"/i);
    const captured = matched?.[1];
    if (captured) shotInfo = { name: captured.split(/[\\/]/).pop() || "" };
  }
  // O-P8（OAW_RECONCILE_HINT，默认关）：browser_* 工具报成功但面板帧流仍在重连时，追加对账提示
  const reconcilePending = done && !isError && flag("reconcileHint")
    && /^browser_/.test(String(name || ""))
    && getBrowserStreamState().status === "reconnecting"
    && Date.now() - getBrowserStreamState().since > 3000;

  return (
    <div className={`tool-card ${done ? (isError ? "error" : "success") : "pending"} ${isMapTool ? "tool-card-map" : ""}`} onClick={onToggle}>
      <div className="tool-header">
        <span className={`tool-icon ${done ? (isError ? "err" : "ok") : "run"}`}>
          {done ? (isError ? <Icon name="x" size={12} /> : <Icon name="check" size={12} />) : <Icon name="loading" size={12} className="icon-loading" />}
        </span>
        <ToolIdentityIcon name={name as string} size={12} className="tool-identity-inline" />
        {isMapTool && <span className="tool-map-badge" title="地图操作：结果会实时反映到地图上">地图</span>}
        <span className="tool-phrase" title={inputStr}>{toolPhrase(name, input, done)}</span>
        {tool.startMissing && <span className="tool-recovered" title="开始事件已丢失，状态由结束事件恢复">已恢复</span>}
        {isCmd && <code className="cmd-code" title={fullInput}>$ {cmdPreview}</code>}
        {duration && <span className="tool-duration">{duration}s</span>}
        <span className={`tool-chevron ${expanded ? "open" : ""}`}>{expanded ? "▾" : "▸"}</span>
      </div>
      {expanded && (
        <div className="tool-detail">
          {shotInfo && (
            <div className="tool-section tool-shot-preview">
              <div className="tool-section-label">截图回看</div>
              <img className="tool-shot-thumb" src={`/api/browser/shot?file=${encodeURIComponent(shotInfo.name)}`} alt="浏览器截图" loading="lazy" />
              <div><a className="btn-xs" href={`/api/browser/shot?file=${encodeURIComponent(shotInfo.name)}`} download={shotInfo.name}>下载截图</a></div>
            </div>
          )}
          {reconcilePending && (
            <div className="tool-section tool-reconcile-hint" role="status">画面暂不可达（面板重连中），操作已生效。</div>
          )}
          {/* 输入参数 */}
          {inputStr && (
            <div className="tool-section">
              <div className="tool-section-label">输入</div>
              <pre className={`tool-code ${isCmd ? "cmd" : ""}`}>{inputStr}</pre>
            </div>
          )}
          {/* 配对结果（按 toolCallId 配对，pi PairedResult 风格） */}
          {(output || tool.result) && (
            <div className="tool-section">
              <div className="tool-section-label">{done ? "结果" : "输出"}</div>
              <pre className={`tool-code ${isError ? "err" : ""}`}>{expanded ? (output || tool.result) : outputPreview}</pre>
            </div>
          )}
          {done && !output && !tool.result && (
            <div className="tool-section">
              <div className="tool-section-label">结果</div>
              <pre className="tool-code empty">(no output)</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
