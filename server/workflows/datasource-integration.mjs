/**
 * 领域工作流声明：数据源接入（Qoder 对标 §4.3）。
 *
 * 坐标校验为硬约束：经度 73–135°E、纬度 18–54°N，超范围立即阻断
 * （AGENT.MD §坐标与数据校验）；记录数 expected vs actual 不完整不继续。
 */
export default {
  id: "data-source-onboarding",
  title: "数据源接入",
  description: "源探测到字段映射、坐标校验与适配器固化的数据接入链路",
  budget: { maxTurns: 14, maxToolCalls: 45, maxWallMs: 15 * 60 * 1000 },
  tools: ["read", "ls", "grep", "bash", "write", "map_import", "map_datasets"],
  preflight: ["geoRange", "recordCount", "artifactRoot"],
  stages: [
    { id: "probe", title: "源探测" },
    { id: "mapping", title: "字段映射" },
    { id: "geo-check", title: "坐标校验" },
    { id: "trial-import", title: "试导入" },
    { id: "adapter", title: "固化适配器" },
  ],
  artifacts: [
    { id: "adapter-config", title: "适配器配置", kind: "config", required: true },
    { id: "field-mapping", title: "字段映射表", kind: "table", required: true },
    { id: "geo-report", title: "坐标校验报告", kind: "report", required: true },
  ],
};
