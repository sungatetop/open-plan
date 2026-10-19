/**
 * 领域工作流声明：OD 需求分析（Qoder 对标 §4.3）。
 *
 * 声明式：只描述「预算 / 工具白名单 / 前置硬约束 / 阶段 / 产物契约」，
 * 不含任何执行逻辑（复杂逻辑一律下沉到工具实现，见 AGENT.MD §编码准则）。
 * 工具名一律取自既有能力集合（server/task.mjs 的只读/办公/地图工具），**不新增工具**。
 */
export default {
  id: "od-demand-analysis",
  title: "OD 需求分析",
  description: "从 OD 客流数据到出行矩阵、指标与可视化结论的完整分析链路",
  budget: { maxTurns: 12, maxToolCalls: 40, maxWallMs: 15 * 60 * 1000 },
  tools: ["read", "ls", "grep", "map_read", "map_analyze", "map_datasets", "write"],
  preflight: ["geoRange", "recordCount", "artifactRoot"],
  stages: [
    { id: "validate", title: "数据校验" },
    { id: "matrix", title: "矩阵构建" },
    { id: "metrics", title: "指标计算" },
    { id: "visualize", title: "可视化" },
    { id: "conclusion", title: "结论" },
  ],
  artifacts: [
    { id: "od-matrix", title: "OD 矩阵（校验记录数一致）", kind: "data", required: true },
    { id: "flow-heatmap", title: "客流热力图", kind: "map", required: true },
    { id: "od-metrics", title: "指标表", kind: "table", required: true },
  ],
};
