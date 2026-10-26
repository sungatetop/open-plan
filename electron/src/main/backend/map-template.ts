/**
 * 场景化分析模板（GIS G5-v1：OD 通勤分析）——flag OAW_MAP_TEMPLATES（默认关）。
 * S3-6，自 server/map-template.mjs 全量转录（159 行）。
 *
 * 编排（确定性，复用既有底座，不引入新依赖）：
 *   1. 数据导入：local-file 适配器读工作区 OD CSV（复用 G2/阶段 5 的列识别与脏数据过滤）；
 *   2. 期望线：适配器产出的 OD 流向线（lines FeatureCollection）；
 *   3. 带宽分级：按流量分位数划 N 级（P25/P50/P75/P90 默认 4 级）；
 *   4. 结论要点 + 报告成文：汇总统计经 G8 buildMapReport 落工作区 docx。
 *
 * 纯函数 bandOdFlows 可独立测试；runOdCommuterTemplate 为编排入口（HTTP 路由与
 * Agent 工具 map_template 共用）。
 *
 * 行为保真说明：
 *  - buildMapReport 静态直绑 map-report.ts（S3-5，TS 侧与旧侧依赖链各自独立、行为等价）。
 *  - loadSource 静态换绑 map-visualization.ts（S3-9 已迁，动态 import 过渡债退役；
 *    local-file 适配器由 traffic-sources.ts 导入即注册，注册态由消费面/对拍装配触发，
 *    不在此处理）。
 *  - TS strict 适配（noUncheckedIndexedAccess）：索引访问加 ! 断言（均为基内访问，越界
 *    语义不变）；其余 falsy/截断语义与旧 JS 一致。
 *  - 消费面：create-tools.ts map_template 工具（本批换绑）；旧侧 HTTP 路由
 *    POST /api/map/template/od-commuter + server/agent.mjs 动态 import 随流量切换批切换。
 */
import path from "node:path";
import { buildMapReport } from "./map-report";

export const OD_TEMPLATE_ID = "od-commuter";

/** 分位数（线性插值，与常见统计口径一致）。 */
function quantile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * p;
  const base = Math.floor(pos);
  const rest = pos - base;
  return base + 1 < sorted.length
    ? sorted[base]! + rest * (sorted[base + 1]! - sorted[base]!)
    : sorted[base]!;
}

function flowValueOf(props: any) {
  const raw = props?.flow ?? props?.value;
  const num = Number(raw);
  return Number.isFinite(num) ? num : 0;
}

/** 起点/终点的可读标签：优先名称属性（oname/dname、o/d、起点/终点），否则坐标。 */
function odLabel(feature: any, role: string) {
  const props = feature?.properties || {};
  const named = props[`${role}name`] || props[role === "o" ? "oname" : "dname"] || props[role === "o" ? "起点" : "终点"];
  if (named) return String(named);
  const geometry = feature?.geometry;
  const coords = geometry?.type === "LineString" ? geometry.coordinates[role === "o" ? 0 : geometry.coordinates.length - 1] : null;
  if (Array.isArray(coords)) return `${coords[0]!.toFixed(3)},${coords[1]!.toFixed(3)}`;
  return "(未知)";
}

/**
 * 带宽分级（纯函数）。
 * @param features OD 流向要素（LineString，properties.flow / value 为流量）
 * @param options {{bands?: number, top?: number}}
 * @returns {{edges: number[], levels: Array<{level:number,from:number,to:number|null,count:number}>, topFlows: Array<{label:string,flow:number,index:number}>, totalFlow:number, count:number}}
 */
export function bandOdFlows(features: any[], { bands = 4, top = 10 }: { bands?: number; top?: number } = {}) {
  const list = (Array.isArray(features) ? features : [])
    .map((f: any, index: number) => ({ f, flow: flowValueOf(f?.properties), index }))
    .filter((x: any) => x.f?.geometry?.type === "LineString");
  const count = list.length;
  if (!count) {
    return { edges: [] as number[], levels: [] as any[], topFlows: [] as any[], totalFlow: 0, count: 0 };
  }
  const requestedBands = Number(bands);
  const levelCount = Math.max(2, Math.min(6, Number.isFinite(requestedBands) ? Math.round(requestedBands) : 4));
  const values = list.map((x: any) => x.flow).sort((a: number, b: number) => a - b);
  const totalFlow = values.reduce((sum: number, v: number) => sum + v, 0);
  // 内部分割点：P(1/n)...P((n-1)/n)
  const edges: number[] = [];
  for (let i = 1; i < levelCount; i += 1) edges.push(quantile(values, i / levelCount)!);
  const levels: Array<{ level: number; from: number; to: number | null; count: number }> = [];
  for (let i = 0; i < levelCount; i += 1) {
    const from = i === 0 ? values[0]! : edges[i - 1]!;
    const to = i === levelCount - 1 ? null : edges[i]!;
    const inBand = list.filter((x: any) => (i === 0 ? x.flow <= edges[0]! : i === levelCount - 1 ? x.flow > edges[levelCount - 2]! : x.flow > edges[i - 1]! && x.flow <= edges[i]!));
    levels.push({
      level: i + 1,
      from: Math.round(from * 100) / 100,
      to: to === null ? null : Math.round(to * 100) / 100,
      count: inBand.length,
    });
  }
  const topFlows = [...list]
    .sort((a: any, b: any) => b.flow - a.flow)
    .slice(0, Math.max(1, Math.min(50, Math.round(Number(top) || 10))))
    .map((x: any) => ({ label: `${odLabel(x.f, "o")} → ${odLabel(x.f, "d")}`, flow: x.flow, index: x.index }));
  return { edges: edges.map((e) => Math.round(e * 100) / 100), levels, topFlows, totalFlow, count };
}

/**
 * OD 通勤分析模板（编排入口）。
 * @param options {{workspace: string, path?: string, title?: string, bands?: number, project?: string, fileName?: string}}
 */
export async function runOdCommuterTemplate(options: {
  workspace?: string; path?: string; title?: string; bands?: number; project?: string; fileName?: string;
} = {}) {
  const workspace = String(options.workspace || "");
  const sourcePath = String(options.path || "").trim();
  if (!sourcePath) {
    throw new Error("缺少 path 参数：请指定工作区内的 OD 数据 CSV（起点/终点经纬度 + 流量列）");
  }
  // 1-2. 数据导入 + 期望线（local-file 适配器：列识别 / 越界过滤 / 目录越界拦截都在这里）
  const { loadSource } = await import("./map-visualization");
  const descriptor: any = await loadSource("local-file", { workspace, path: sourcePath });
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
