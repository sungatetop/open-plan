import React from "react";

/**
 * 阶段条（Qoder 对标 M4.4，纯展示组件）。
 *
 * 只负责把「工作流声明的阶段」渲染成横向阶段格 + 三态状态点
 * （未开始 / 进行中 / 完成，另有失败态），不自己订阅事件、不发请求。
 * 运行期状态由调用方通过 `状态映射` 注入；未注入时一律按「未开始」渲染，
 * 刻意不编造进度（执行侧接线尚未交付，见计划 M4.4）。
 */
const 状态文案 = {
  pending: "未开始",
  running: "进行中",
  done: "完成",
  failed: "失败",
};

export default function 阶段条({ stages = [], 状态映射 = {}, onSelect = null, 当前阶段 = "" }) {
  if (!stages.length) return null;
  return (
    <ol className="wf-stages" aria-label="工作流阶段">
      {stages.map((阶段, 索引) => {
        const 状态 = 状态映射[阶段.id] || "pending";
        const 标签 = 状态文案[状态] || 状态文案.pending;
        const 可点 = typeof onSelect === "function";
        return (
          <li key={阶段.id} className={`wf-stage wf-stage-${状态}${当前阶段 === 阶段.id ? " wf-stage-current" : ""}`}>
            <button
              type="button"
              className="wf-stage-btn"
              onClick={可点 ? () => onSelect(阶段) : undefined}
              disabled={!可点}
              title={`${索引 + 1}. ${阶段.title}（${标签}）${阶段.approval ? " · 需人工确认" : ""}`}
            >
              <i className={`wf-dot wf-dot-${状态}`} aria-hidden="true" />
              <span className="wf-stage-index">{索引 + 1}</span>
              <span className="wf-stage-title">{阶段.title}</span>
              {阶段.approval && <span className="wf-stage-approval" title="该阶段需要人工确认">待确认</span>}
            </button>
          </li>
        );
      })}
    </ol>
  );
}
