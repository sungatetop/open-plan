import React from "react";
import Icon from "./Icon.jsx";

const ROLE_TEXT = { scout: "资料探索", reviewer: "审阅", planner: "方案拆解", verifier: "独立核验", worker: "执行" };
const STATUS_TEXT = { running: "执行中", completed: "已完成", failed: "失败", cancelled: "已取消", planned: "已编排" };
const VERDICT_TEXT = { pass: "核验通过", revise: "核验需修订", fail: "核验不通过" };

/** 轨迹为空时（旧数据/回放缺 transcript）用工具列表 + 摘要兜底，保证详情不为空。 */
function synthesizeTranscript(block, tools) {
  const entries = [];
  for (const tool of tools) {
    entries.push({ kind: "tool_call", toolName: tool.name || "read", toolCallId: tool.toolCallId, args: tool.args || "" });
    if (tool.status === "done") entries.push({ kind: "tool_result", toolCallId: tool.toolCallId, isError: tool.isError === true, result: tool.result || "" });
  }
  const tail = block.summary || block.preview || "";
  if (tail) entries.push({ kind: "text", text: tail });
  return entries;
}

function TimelineItem({ item }) {
  const kind = item?.kind;
  if (kind === "thinking") {
    return (
      <li className="sa-detail-item thinking">
        <span className="sa-detail-label"><Icon name="brain" size={12} /> 思考</span>
        <div className="sa-detail-text">{item.text}</div>
      </li>
    );
  }
  if (kind === "text") {
    return (
      <li className="sa-detail-item text">
        <span className="sa-detail-label"><Icon name="comment" size={12} /> 回复</span>
        <div className="sa-detail-text">{item.text}</div>
      </li>
    );
  }
  if (kind === "tool_call") {
    return (
      <li className="sa-detail-item tool">
        <span className="sa-detail-label"><Icon name="tool" size={12} /> 调用 {item.toolName || "工具"}</span>
        {item.args ? <pre className="sa-detail-code">{String(item.args)}</pre> : null}
      </li>
    );
  }
  if (kind === "tool_result") {
    return (
      <li className={`sa-detail-item tool-result ${item.isError ? "error" : ""}`}>
        <span className="sa-detail-label"><Icon name={item.isError ? "x" : "check"} size={12} /> 结果</span>
        {item.result ? <pre className="sa-detail-code">{String(item.result)}</pre> : null}
      </li>
    );
  }
  return null;
}

/**
 * 子代理详情：在右侧预览面板展示某个子 Agent 的完整过程
 * （思考 / 回复 / 工具调用与结果），实时与回放共用同一数据（block.transcript）。
 */
export default function 子代理详情面板({ block }) {
  if (!block) {
    return (
      <div className="preview-subagent-panel">
        <div className="subagent-detail-empty">选择对话里的子 Agent 卡片，在这里查看它的完整过程。</div>
      </div>
    );
  }
  const roleText = ROLE_TEXT[block.role] || "只读任务";
  const statusText = STATUS_TEXT[block.status] || "执行中";
  const tools = Array.isArray(block.tools) ? block.tools : [];
  const transcript = Array.isArray(block.transcript) && block.transcript.length
    ? block.transcript
    : synthesizeTranscript(block, tools);
  return (
    <div className="preview-subagent-panel">
      <div className="subagent-detail-head">
        <div className="subagent-detail-title">
          <span className="subagent-detail-icon"><Icon name="flow" size={14} /></span>
          <strong>子 Agent · {roleText}</strong>
          <span className={`subagent-detail-status ${block.status || "running"}`}>{block.status === "running" ? <i /> : null}{statusText}</span>
        </div>
        {block.task ? <div className="subagent-detail-task">{block.task}</div> : null}
        <div className="subagent-detail-meta">
          <span>{tools.length} 次工具调用</span>
          <span>·</span>
          <span>{transcript.filter((item) => item.kind === "thinking").length ? "含思考过程" : "无思考内容"}</span>
        </div>
      </div>
      {block.error ? <div className="subagent-error" role="alert">{block.error}</div> : null}
      {block.verdict ? (
        <div className={`subagent-verdict ${block.verdict}`} role="status">
          <b>对抗式核验</b>
          <span>{VERDICT_TEXT[block.verdict] || block.verdict}</span>
          {Array.isArray(block.checklist) && block.checklist.length ? (
            <ul className="sa-detail-checklist">
              {block.checklist.map((item, index) => (
                <li key={index} className={item.ok === false ? "miss" : "hit"}>
                  <Icon name={item.ok === false ? "x" : "check"} size={12} /> {item.item}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {transcript.length === 0 ? (
        <div className="subagent-detail-empty">子 Agent 尚未产生可展示的过程。</div>
      ) : (
        <ol className="subagent-detail-timeline">
          {transcript.map((item, index) => <TimelineItem key={`${item.kind}-${item.toolCallId || index}`} item={item} />)}
        </ol>
      )}
    </div>
  );
}
