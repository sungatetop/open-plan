/**
 * 场景化分析模板（GIS G5-v1：OD 通勤分析）——flag OAW_MAP_TEMPLATES（默认关）。
 *
 * 编排（确定性，复用既有底座，不引入新依赖）：
 *   1. 数据导入：local-file 适配器读工作区 OD CSV（复用 G2/阶段 5 的列识别与脏数据过滤）；
 *   2. 期望线：适配器产出的 OD 流向线（lines FeatureCollection）；
 *   3. 带宽分级：按流量分位数划 N 级（P25/P50/P75/P90 默认 4 级）；
 *   4. 结论要点 + 报告成文：汇总统计经 G8 buildMapReport 落工作区 docx。
 *
 * 纯函数 bandOdFlows 可独立测试；runOdCommuterTemplate 为编排入口（HTTP 路由与
 * Agent 工具 map_template 共用）。
 */
import path from "node:path";
import { loadSource } from "./map-visualization.mjs";
import { buildMapReport } from "./map-report.mjs";

export const OD_TEMPLATE_ID = "od-commuter";

/** 分位数（线性插值，与常见统计口径一致）。 */
function quantile(sorted, p) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * p;
  const base = Math.floor(pos);
  const rest = pos - base;
  return base + 1 < sorted.length
    ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
    : sorted[base];
}

function flowValueOf(props) {
  const raw = props?.flow ?? props?.value;
  const num = Number(raw);
  return Number.isFinite(num) ? num : 0;
}

/** 起点/终点的可读标签：优先名称属性（oname/dname、o/d、起点/终点），否则坐标。 */
function odLabel(feature, role) {
  const props = feature?.properties || {};
  const named = props[`${role}name`] || props[role === "o" ? "oname" : "dname"] || props[role === "o" ? "起点" : "终点"];
  if (named) return String(named);
  const geometry = feature?.geometry;
  const coords = geometry?.type === "LineString" ? geometry.coordinates[role === "o" ? 0 : geometry.coordinates.length - 1] : null;
  if (Array.isArray(coords)) return `${coords[0].toFixed(3)},${coords[1].toFixed(3)}`;
  return "(未知)";
}

/**
 * 带宽分级（纯函数）。
 * @param {Array} features OD 流向要素（LineString，properties.flow / value 为流量）
 * @param {{bands?: number, top?: number}} options
 * @returns {{edges: number[], levels: Array<{level:number,from:number,to:number|null,count:number}>, topFlows: Array<{label:string,flow:number,index:number}>, totalFlow:number, count:number}}
 */
export function bandOdFlows(features, { bands = 4, top = 10 } = {}) {
  const list = (Array.isArray(features) ? features : [])
    .map((f, index) => ({ f, flow: flowValueOf(f?.properties), index }))
    .filter((x) => x.f?.geometry?.type === "LineString");
  const count = list.length;
  if (!count) {
    return { edges: [], levels: [], topFlows: [], totalFlow: 0, count: 0 };
  }
  const requestedBands = Number(bands);
  const levelCount = Math.max(2, Math.min(6, Number.isFinite(requestedBands) ? Math.round(requestedBands) : 4));
  const values = list.map((x) => x.flow).sort((a, b) => a - b);
  const totalFlow = values.reduce((sum, v) => sum + v, 0);
  // 内部分割点：P(1/n)...P((n-1)/n)
  const edges = [];
  for (let i = 1; i < levelCount; i += 1) edges.push(quantile(values, i / levelCount));
  const levels = [];
  for (let i = 0; i < levelCount; i += 1) {
    const from = i === 0 ? values[0] : edges[i - 1];
    const to = i === levelCount - 1 ? null : edges[i];
    const inBand = list.filter((x) => (i === 0 ? x.flow <= edges[0] : i === levelCount - 1 ? x.flow > edges[levelCount - 2] : x.flow > edges[i - 1] && x.flow <= edges[i]));
    levels.push({
      level: i + 1,
      from: Math.round(from * 100) / 100,
      to: to === null ? null : Math.round(to * 100) / 100,
      count: inBand.length,
    });
  }
  const topFlows = [...list]
    .sort((a, b) => b.flow - a.flow)
    .slice(0, Math.max(1, Math.min(50, Math.round(Number(top) || 10))))
    .map((x) => ({ label: `${odLabel(x.f, "o")} → ${odLabel(x.f, "d")}`, flow: x.flow, index: x.index }));
  return { edges: edges.map((e) => Math.round(e * 100) / 100), levels, topFlows, totalFlow, count };
}

/**
 * OD 通勤分析模板（编排入口）。
 * @param {{workspace: string, path?: string, title?: string, bands?: number, project?: string, fileName?: string}} options
 */
export async function runOdCommuterTemplate(options = {}) {
  const workspace = String(options.workspace || "");
  const sourcePath = String(options.path || "").trim();
  if (!sourcePath) {
    throw new Error("缺少 path 参数：请指定工作区内的 OD 数据 CSV（起点/终点经纬度 + 流量列）");
  }
  // 1-2. 数据导入 + 期望线（local-file 适配器：列识别 / 越界过滤 / 目录越界拦截都在这里）
  const descriptor = await loadSource("local-file", { workspace, path: sourcePath });
  if (descriptor?.error) throw new Error(`数据导入失败：${descriptor.error}`);
  if (descriptor.kind !== "flow" || !descriptor.lines?.features?.length) {
    throw new Error("数据不是 OD 形状（需要起点/终点经纬度列）；单点数据请用热力图分析，不适用本模板");
  }

  // 3. 带宽分级
  const bands = bandOdFlows(descriptor.lines.features, { bands: options.bands, top: 10 });
  if (!bands.count) throw new Error("没有可分级的 OD 流向线");

  // 4. 报告成文（G8）
  const stats = descriptor.stats || {};
  const title = String(options.title || "").trim() || `OD 通勤分析（${bands.count} 对流向）`;
  const report = await buildMapReport({
    workspace,
    project: options.project || "",
    title,
    fileName: options.fileName || `OD通勤分析-${path.basename(sourcePath).replace(/\.[^.]+$/, "")}`,
    sections: [
      {
        heading: "数据概览",
        bullets: [
          `数据文件：${sourcePath}`,
          `OD 流向：${bands.count} 对`,
          `流量合计：${Math.round(bands.totalFlow)}`,
          stats.skipped ? `已剔除无效/越界行：${stats.skipped}` : "无剔除行",
          `带宽分级：${bands.levels.length} 级（按流量分位数）`,
        ],
      },
      {
        heading: "带宽分级",
        table: {
          headers: ["级别", "流量范围", "流向数"],
          rows: bands.levels.map((l) => [`L${l.level}`, l.to === null ? `> ${l.from}` : `${l.from} – ${l.to}`, String(l.count)]),
        },
      },
      {
        heading: `TOP ${bands.topFlows.length} 流向`,
        table: {
          headers: ["起点 → 终点", "流量"],
          rows: bands.topFlows.map((t) => [t.label, String(Math.round(t.flow * 100) / 100)]),
        },
      },
      {
        heading: "结论要点",
        bullets: [
          `最高流量出现在：${bands.topFlows[0]?.label || "—"}（${Math.round(bands.topFlows[0]?.flow || 0)}）`,
          `前 ${Math.min(3, bands.topFlows.length)} 大流向占总量 ${(bands.topFlows.slice(0, 3).reduce((s, t) => s + t.flow, 0) / (bands.totalFlow || 1) * 100).toFixed(1)}%`,
          "建议结合带宽分级图核对主要走廊的设施配置与瓶颈段。",
        ],
      },
    ],
  });

  return {
    template: OD_TEMPLATE_ID,
    title,
    descriptor: { id: descriptor.id, kind: descriptor.kind, count: bands.count },
    bands,
    report: { file: report.file, fileName: path.basename(report.file), blocks: report.blocks },
  };
}
