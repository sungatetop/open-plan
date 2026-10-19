/**
 * 领域工作流声明：可达性分析（Qoder 对标 §4.3）。
 * 声明式，无执行逻辑；工具白名单取自既有能力集合，不新增工具。
 */
export default {
  id: "accessibility-analysis",
  title: "可达性分析",
  description: "起终点确认到等时圈、覆盖率与专题地图的可达性分析链路",
  budget: { maxTurns: 14, maxToolCalls: 45, maxWallMs: 15 * 60 * 1000 },
  tools: ["read", "ls", "grep", "map_read", "map_analyze", "map_datasets", "write"],
  preflight: ["geoRange", "artifactRoot"],
  stages: [
    { id: "endpoints", title: "起终点确认" },
    { id: "isochrone", title: "等时圈" },
    { id: "coverage", title: "覆盖率" },
    { id: "map", title: "地图" },
    { id: "conclusion", title: "结论" },
  ],
  artifacts: [
    { id: "isochrone-geojson", title: "等时圈 GeoJSON", kind: "map", required: true },
    { id: "coverage-table", title: "覆盖率表", kind: "table", required: true },
    { id: "thematic-map", title: "专题图", kind: "map", required: false },
  ],
};
