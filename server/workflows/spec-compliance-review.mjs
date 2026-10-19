/**
 * 领域工作流声明：规范符合性审查（Qoder 对标 §4.3）。
 *
 * 「批注写回」阶段 approval=true：写回既有文档前必须经用户确认（对上
 * AGENT.MD「创作模式产物必须写入 office-workspace」与既有
 * review_waiting_confirmation 写回保护语义）。
 */
export default {
  id: "standard-compliance-review",
  title: "规范符合性审查",
  description: "材料识别到规范逐条比对、问题清单与批注写回的审查链路",
  budget: { maxTurns: 18, maxToolCalls: 60, maxWallMs: 15 * 60 * 1000 },
  tools: ["read", "ls", "grep", "kb_search", "kb_read", "officecli", "review_copy", "review_source_apply", "write"],
  preflight: ["artifactRoot", "writeBackGuard"],
  stages: [
    { id: "material", title: "材料识别" },
    { id: "source-search", title: "规范检索" },
    { id: "compare", title: "逐条比对" },
    { id: "issue-list", title: "问题清单" },
    { id: "write-back", title: "批注写回", approval: true },
  ],
  artifacts: [
    { id: "issue-list", title: "问题清单", kind: "list", required: true },
    { id: "annotation-marks", title: "批注标记", kind: "mark", required: true },
    { id: "review-doc", title: "审查意见 docx", kind: "doc", required: true },
  ],
};
