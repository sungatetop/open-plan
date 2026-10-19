/**
 * 领域工作流声明：路网评估（Qoder 对标 §4.3）。
 * 声明式，无执行逻辑；工具白名单取自既有能力集合，不新增工具。
 */
export default {
  id: "road-network-evaluation",
  title: "路网评估",
  description: "路网数据装配到饱和度分级、拥堵识别与评估报告的完整链路",
  budget: { maxTurns: 16, maxToolCalls: 50, maxWallMs: 15 * 60 * 1000 },
  tools: ["read", "ls", "grep", "map_read", "map_analyze", "map_datasets", "write", "officecli"],
  preflight: ["artifactRoot"],
  stages: [
    { id: "assemble", title: "数据装配" },
    { id: "metrics", title: "指标计算" },
    { id: "congestion", title: "拥堵识别" },
    { id: "grading", title: "分级" },
    { id: "report", title: "报告" },
  ],
  artifacts: [
    { id: "density-layer", title: "路网密度/饱和度图层", kind: "map", required: true },
    { id: "congestion-list", title: "拥堵清单", kind: "list", required: true },
    { id: "evaluation-doc", title: "评估报告 docx", kind: "doc", required: true },
  ],
};
