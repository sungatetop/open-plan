/**
 * 领域工作流声明：报告编排（Qoder 对标 §4.3）。
 * 声明式，无执行逻辑；工具白名单取自既有能力集合，不新增工具。
 */
export default {
  id: "report-composition",
  title: "报告编排",
  description: "大纲到分章成文、图表附件与排版质检的报告编排链路",
  budget: { maxTurns: 20, maxToolCalls: 60, maxWallMs: 15 * 60 * 1000 },
  tools: ["read", "ls", "grep", "write", "edit", "officecli"],
  preflight: ["artifactRoot"],
  stages: [
    { id: "outline", title: "大纲" },
    { id: "material", title: "素材" },
    { id: "chapters", title: "分章" },
    { id: "figures", title: "图表" },
    { id: "layout", title: "排版" },
    { id: "qa", title: "质检" },
  ],
  artifacts: [
    { id: "report-doc", title: "多章 docx/pptx", kind: "doc", required: true },
    { id: "figure-attachments", title: "图表附件", kind: "figure", required: false },
    { id: "toc-consistency", title: "目录页码一致性检查", kind: "check", required: true },
  ],
};
