/**
 * S3-9 map-visualization 域单侧测试：12 导出面 / numericStats 分位（空/单值/常规/负数
 * 与 Number 强转语义：null→0 参与、NaN/undefined/非数值字符串剔除）/ detectMeasureField
 * （hint 命中优先、退化多数数值列、空集合、采样前 50）/ toDescriptor（kind 几何推断、
 * mergedStats count 恒要素数 + valueCount + stats 展开覆盖序、styleHint 兜底 warm/ramp/
 * widthRange/radiusRange、id/title falsy 默认、provenance 默认与显式、缺 features FC 抛
 * TypeError）/ from* 适配器五族全分支（demoAnalysis 三 kind、trafficBandwidth、odLines、
 * cambodiaOd、bus 四分支 + geojson 缺省兜底，各 case 绝对期望固化）/ 数据源注册表
 * （listSources 初始内置两源、registerSource 校验与只读默认、loadSource 未知 id、
 * out.error 透传、throw 包装文案、v===1 直返、裸 GeoJSON 包装、bundled-xinchang 真实数据
 * 四 kind + 非法 kind 默认）/ _resetSources 清空与空表可用清单。
 *
 * 真实 IO：modern 静态 import TS 两模块（traffic-sources 导入即注册进 map-visualization
 * 实例）。fake timers 冻结 Date（provenance.at 用 Date.now() 对照断言）。注册表用例序
 * 敏感：listSources 初始断言在前、registerSource 用唯一测试 id 不污染内置源、
 * _resetSources 置于套件末尾。bundled-xinchang 演示回退分支（catch → getXinchangBus）
 * 真实数据在场不可达，有意不做记台账；local-file 适配器分支矩阵在
 * s3-traffic-sources-parity.test.ts 覆盖，此处仅经注册表面做冒烟。
 */
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import * as modernVis from "../src/main/backend/map-visualization";

const mod = modernVis;

function captureSync(fn: () => unknown): any {
  try { fn(); } catch (e) { return e; }
  return null;
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-24T02:00:00Z"));
  // modern 链：TS traffic-sources 导入即注册进 TS map-visualization 实例
  await import("../src/main/backend/traffic-sources");
});

afterAll(() => {
  vi.useRealTimers();
});

// ---- 测试几何常量 ----
const fcPoints = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", properties: { flow: 3, name: "a" }, geometry: { type: "Point", coordinates: [120, 29] } },
    { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [121, 30] } },
  ],
};
const fcPoly = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", properties: { value: 7 }, geometry: { type: "Polygon", coordinates: [[[120, 29], [121, 29], [121, 30], [120, 29]]] } },
  ],
};
const fcLine = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", properties: { flow: 9 }, geometry: { type: "LineString", coordinates: [[120, 29], [121, 30]] } },
  ],
};
const fcEmpty = { type: "FeatureCollection", features: [] };

describe("S3-9 map-visualization", () => {
  it("导出面（12 导出）", () => {
    expect(Object.keys(mod).sort()).toEqual([
      "_resetSources", "detectMeasureField", "fromBus", "fromCambodiaOd", "fromDemoAnalysis",
      "fromOdLines", "fromTrafficBandwidth", "listSources", "loadSource", "numericStats",
      "registerSource", "toDescriptor",
    ]);
  });

  describe("纯函数绝对期望", () => {
    it("numericStats：空/单值/常规/负数与 Number 强转（null→0 参与、NaN/undefined/字符串剔除）", () => {
      // 空：无分位键，min/max/avg 为 null
      expect(mod.numericStats([])).toEqual({ count: 0, min: null, max: null, avg: null, sum: 0 });
      // 单值
      expect(mod.numericStats([5])).toEqual({ count: 1, min: 5, max: 5, avg: 5, sum: 5, p25: 5, p50: 5, p75: 5 });
      // 常规：at(q) 为 ROUND 索引取整（round(0.5)=1 → p25=2；round(1)=1 → p50=2；round(1.5)=2 → p75=3）
      expect(mod.numericStats([3, 1, 2])).toEqual({ count: 3, min: 1, max: 3, avg: 2, sum: 6, p25: 2, p50: 2, p75: 3 });
      // 负数与小数：avg 四舍五入两位（3.125 → 3.13），sum 保留两位
      expect(mod.numericStats([10, -5, 0.5, 7])).toEqual({ count: 4, min: -5, max: 10, avg: 3.13, sum: 12.5, p25: 0.5, p50: 7, p75: 7 });
      // 混合：Number 强转语义 —— null→0 参与、"2"→2 参与、NaN/undefined/"abc" 剔除
      expect(mod.numericStats([1, "2", NaN, null, undefined, 4, "abc"])).toEqual({ count: 4, min: 0, max: 4, avg: 1.75, sum: 7, p25: 1, p50: 2, p75: 2 });
      // 分位取值锚点（排序后 at(q) 语义）：round(0.75)=1→20 / round(1.5)=2→30 / round(2.25)=2→30
      const r: any = mod.numericStats([10, 20, 30, 40]);
      expect(r.min).toBe(10);
      expect(r.max).toBe(40);
      expect(r.p25).toBe(20);
      expect(r.p50).toBe(30);
      expect(r.p75).toBe(30);
    });

    it("detectMeasureField：hint 命中优先 / 退化多数数值 / 空集合 / 采样前 50", () => {
      expect(mod.detectMeasureField({})).toBe("");
      expect(mod.detectMeasureField(fcEmpty)).toBe("");
      // hint 优先序：flow 先于 value（两列同时在 → flow）
      const bothHints = { type: "FeatureCollection", features: [{ type: "Feature", properties: { value: 1, flow: 2 }, geometry: { type: "Point", coordinates: [120, 29] } }] };
      expect(mod.detectMeasureField(bothHints as any)).toBe("flow");
      // 退化：多数样本数值列（非 hint 命名）
      const degenerate = { type: "FeatureCollection", features: [1, 2, 3].map((n) => ({ type: "Feature", properties: { custom_num: n, label: `x${n}` }, geometry: { type: "Point", coordinates: [120, 29] } })) };
      expect(mod.detectMeasureField(degenerate as any)).toBe("custom_num");
      // 退化失败：3 要素中数值样本不足 3
      const degenerateMiss = { type: "FeatureCollection", features: [1, 2, "x"].map((n) => ({ type: "Feature", properties: { num: n }, geometry: { type: "Point", coordinates: [120, 29] } })) };
      expect(mod.detectMeasureField(degenerateMiss as any)).toBe("");
      // 采样前 50：第 51 个要素的 hint 列 flow 不参与采样（否则 hint 命中会返回 "flow"）；
      // 前 50 个 plain 全数值 → 退化分支命中 "plain"
      const sampled = { type: "FeatureCollection", features: Array.from({ length: 51 }, (_, i) => ({ type: "Feature", properties: i === 50 ? { flow: 1 } : { plain: i }, geometry: { type: "Point", coordinates: [120, 29] } })) };
      expect(mod.detectMeasureField(sampled as any)).toBe("plain");
    });

    it("toDescriptor：kind 推断 / mergedStats / hint 兜底 / 默认值 全分支", () => {
      // 全默认：空 FC → flow、ramp ramp、widthRange [0.7,4.5]
      const d1: any = mod.toDescriptor({});
      expect(d1).toEqual({
        v: 1, id: "visual", title: "可视化", kind: "flow",
        geojson: { type: "FeatureCollection", features: [] },
        lines: null,
        stats: { count: 0, valueCount: 0 },
        styleHint: { field: null, ramp: "ramp", widthRange: [0.7, 4.5], radiusRange: null },
        provenance: { dataset: "", generatedBy: "map-visual", runId: null, at: Date.now(), demo: false },
      });
      // 点几何 → points + radiusRange、measure hint 命中 flow（valueCount=1：仅第一个要素有 flow）
      const d2: any = mod.toDescriptor({ geojson: fcPoints });
      expect(d2.kind).toBe("points");
      expect(d2.stats).toEqual({ count: 2, valueCount: 1, min: 3, max: 3, avg: 3, sum: 3, p25: 3, p50: 3, p75: 3 });
      expect(d2.styleHint).toEqual({ field: "flow", ramp: "ramp", widthRange: null, radiusRange: [3, 10] });
      // 显式 kind 覆盖 + heatmap → warm、value hint 命中
      const d3: any = mod.toDescriptor({ geojson: fcPoly, kind: "heatmap" });
      expect(d3.kind).toBe("heatmap");
      expect(d3.stats).toEqual({ count: 1, valueCount: 1, min: 7, max: 7, avg: 7, sum: 7, p25: 7, p50: 7, p75: 7 });
      expect(d3.styleHint).toEqual({ field: "value", ramp: "warm", widthRange: null, radiusRange: null });
      // id=0 / title="" falsy 默认；线几何 → flow + widthRange
      const d4: any = mod.toDescriptor({ geojson: fcLine, id: 0, title: "" });
      expect(d4.id).toBe("visual");
      expect(d4.title).toBe("可视化");
      expect(d4.kind).toBe("flow");
      expect(d4.stats).toEqual({ count: 1, valueCount: 1, min: 9, max: 9, avg: 9, sum: 9, p25: 9, p50: 9, p75: 9 });
      expect(d4.styleHint).toEqual({ field: "flow", ramp: "ramp", widthRange: [0.7, 4.5], radiusRange: null });
      // styleHint 透传（自定义对象原样，不补键）；measure 用其 field，列缺失 → 零值统计（无分位键）
      const d5: any = mod.toDescriptor({ geojson: fcPoints, styleHint: { field: "自定义" } });
      expect(d5.styleHint).toEqual({ field: "自定义" });
      expect(d5.stats).toEqual({ count: 2, valueCount: 0, min: null, max: null, avg: null, sum: 0 });
      // stats 展开覆盖：count 恒要素数（尾覆盖后强制回写），custom 追加
      const d6: any = mod.toDescriptor({ geojson: fcPoints, stats: { custom: 9, count: 99 } });
      expect(d6.stats).toEqual({ count: 2, valueCount: 1, min: 3, max: 3, avg: 3, sum: 3, p25: 3, p50: 3, p75: 3, custom: 9 });
      // provenance 显式全字段（demo=1 → true、at 显式）
      const d7: any = mod.toDescriptor({ geojson: fcPoints, provenance: { dataset: "d", generatedBy: "g", runId: "r", at: 123, demo: 1 } });
      expect(d7.provenance).toEqual({ dataset: "d", generatedBy: "g", runId: "r", at: 123, demo: true });
      // lines 兜底：measure 从 lines 探测（main 空表 → fieldStats 零值统计），lines 透传
      const d8: any = mod.toDescriptor({ lines: fcLine });
      expect(d8.lines).toEqual(fcLine);
      expect(d8.stats).toEqual({ count: 0, valueCount: 0, min: null, max: null, avg: null, sum: 0 });
      expect(d8.styleHint).toEqual({ field: "flow", ramp: "ramp", widthRange: [0.7, 4.5], radiusRange: null });
      // 非 FC geojson（裸对象）→ 空 FC
      const d9: any = mod.toDescriptor({ geojson: { type: "Feature", properties: {} } });
      expect(d9.geojson).toEqual({ type: "FeatureCollection", features: [] });
      // 缺 features 的 FC → 抛 TypeError（main.features.length）
      const e1 = captureSync(() => mod.toDescriptor({ geojson: { type: "FeatureCollection" } }));
      expect(e1).toBeInstanceOf(Error);
      expect((e1 as Error).message).toContain("length");
    });

    it("from* 适配器五族全分支（绝对期望固化）", () => {
      const now = Date.now();
      // fromDemoAnalysis：heatmap（fcPoints + stats.a + demo）
      expect(mod.fromDemoAnalysis({ analysis: "heatmap", id: "a1", title: "T", geojson: fcPoints, stats: { a: 1 }, source: "demo" } as any)).toEqual({
        v: 1, id: "a1", title: "T", kind: "heatmap",
        geojson: fcPoints, lines: null,
        stats: { count: 2, valueCount: 1, min: 3, max: 3, avg: 3, sum: 3, p25: 3, p50: 3, p75: 3, a: 1 },
        styleHint: { field: "flow", ramp: "warm", widthRange: null, radiusRange: null },
        provenance: { dataset: "demo-analysis", generatedBy: "map-analysis.mjs", runId: null, at: now, demo: true },
      });
      // fromDemoAnalysis：od（flow + 显式 styleHint 无 radiusRange 键 + lines 透传）
      expect(mod.fromDemoAnalysis({ analysis: "od", geojson: fcLine, lines: fcLine } as any)).toEqual({
        v: 1, id: "agent-analysis", title: "演示分析", kind: "flow",
        geojson: fcLine, lines: fcLine,
        stats: { count: 1, valueCount: 1, min: 9, max: 9, avg: 9, sum: 9, p25: 9, p50: 9, p75: 9 },
        styleHint: { field: "flow", ramp: "ramp", widthRange: [0.7, 4.5] },
        provenance: { dataset: "demo-analysis", generatedBy: "map-analysis.mjs", runId: null, at: now, demo: false },
      });
      // fromDemoAnalysis：isochrone（fcPoly → value hint、默认 hint 兜底 ramp）
      expect(mod.fromDemoAnalysis({ analysis: "isochrone", geojson: fcPoly } as any)).toEqual({
        v: 1, id: "agent-analysis", title: "演示分析", kind: "isochrone",
        geojson: fcPoly, lines: null,
        stats: { count: 1, valueCount: 1, min: 7, max: 7, avg: 7, sum: 7, p25: 7, p50: 7, p75: 7 },
        styleHint: { field: "value", ramp: "ramp", widthRange: null, radiusRange: null },
        provenance: { dataset: "demo-analysis", generatedBy: "map-analysis.mjs", runId: null, at: now, demo: false },
      });
      // fromDemoAnalysis：空 action（heatmap 兜底、空 FC）
      expect(mod.fromDemoAnalysis({} as any)).toEqual({
        v: 1, id: "agent-analysis", title: "演示分析", kind: "heatmap",
        geojson: { type: "FeatureCollection", features: [] }, lines: null,
        stats: { count: 0, valueCount: 0 },
        styleHint: { field: null, ramp: "warm", widthRange: null, radiusRange: null },
        provenance: { dataset: "demo-analysis", generatedBy: "map-analysis.mjs", runId: null, at: now, demo: false },
      });
      // fromTrafficBandwidth：stats 键名透传 + flow_avg 字段缺失 → 零值统计
      expect(mod.fromTrafficBandwidth({ geojson: fcLine, stats: { withTraffic: 2, max: 5, min: 1, avg: 3 } } as any)).toEqual({
        v: 1, id: "m2-traffic-bandwidth", title: "高速路段流量带宽", kind: "flow",
        geojson: fcLine, lines: null,
        stats: { count: 1, valueCount: 0, min: 1, max: 5, avg: 3, sum: 0, withTraffic: 2 },
        styleHint: { field: "flow_avg", ramp: "traffic", widthRange: [0.7, 6] },
        provenance: { dataset: "m2-traffic-bandwidth", generatedBy: "map.mjs", runId: null, at: now, demo: false },
      });
      // fromTrafficBandwidth：空 action（默认空 FC）
      expect(mod.fromTrafficBandwidth({} as any)).toEqual({
        v: 1, id: "m2-traffic-bandwidth", title: "高速路段流量带宽", kind: "flow",
        geojson: { type: "FeatureCollection", features: [] }, lines: null,
        stats: { count: 0, valueCount: 0, sum: 0, withTraffic: undefined, max: undefined, min: undefined, avg: undefined },
        styleHint: { field: "flow_avg", ramp: "traffic", widthRange: [0.7, 6] },
        provenance: { dataset: "m2-traffic-bandwidth", generatedBy: "map.mjs", runId: null, at: now, demo: false },
      });
      // fromOdLines：volumeStats → volume 重命名透传
      expect(mod.fromOdLines({ geojson: fcLine, stats: { levels: [1], volumeStats: { a: 1 } } } as any)).toEqual({
        v: 1, id: "m2-od-lines", title: "市—县 OD 期望线", kind: "flow",
        geojson: fcLine, lines: null,
        stats: { count: 1, valueCount: 0, min: null, max: null, avg: null, sum: 0, levels: [1], volume: { a: 1 } },
        styleHint: { field: "volume", ramp: "ramp", widthRange: [0.7, 4.5] },
        provenance: { dataset: "m2-od-lines", generatedBy: "map.mjs", runId: null, at: now, demo: false },
      });
      // fromOdLines：空 action
      expect(mod.fromOdLines({} as any)).toEqual({
        v: 1, id: "m2-od-lines", title: "市—县 OD 期望线", kind: "flow",
        geojson: { type: "FeatureCollection", features: [] }, lines: null,
        stats: { count: 0, valueCount: 0, min: null, max: null, avg: null, sum: 0, levels: undefined, volume: undefined },
        styleHint: { field: "volume", ramp: "ramp", widthRange: [0.7, 4.5] },
        provenance: { dataset: "m2-od-lines", generatedBy: "map.mjs", runId: null, at: now, demo: false },
      });
      // fromCambodiaOd：points 主几何 + lines + stats 展开 + demo 标记
      expect(mod.fromCambodiaOd({ points: fcPoints, lines: fcLine, stats: { totalFlow: 9, other: 1 }, status: "demo" } as any)).toEqual({
        v: 1, id: "cambodia-od", title: "暹粒 OD 流向", kind: "flow",
        geojson: fcPoints, lines: fcLine,
        stats: { count: 2, valueCount: 0, min: null, max: null, avg: null, sum: 0, other: 1, totalFlow: 9 },
        styleHint: { field: "value", ramp: "ramp", widthRange: [0.7, 4.5], radiusRange: [3, 10] },
        provenance: { dataset: "cambodia-od", generatedBy: "cambodia-od.mjs", runId: null, at: now, demo: true },
      });
      // fromCambodiaOd：空 action（points/lines 默认空 FC）
      expect(mod.fromCambodiaOd({} as any)).toEqual({
        v: 1, id: "cambodia-od", title: "暹粒 OD 流向", kind: "flow",
        geojson: { type: "FeatureCollection", features: [] },
        lines: { type: "FeatureCollection", features: [] },
        stats: { count: 0, valueCount: 0, min: null, max: null, avg: null, sum: 0, totalFlow: undefined },
        styleHint: { field: "value", ramp: "ramp", widthRange: [0.7, 4.5], radiusRange: [3, 10] },
        provenance: { dataset: "cambodia-od", generatedBy: "cambodia-od.mjs", runId: null, at: now, demo: false },
      });
      // fromBus：routes（categorical + route_type hint）
      expect(mod.fromBus("routes", { geojson: fcLine, stats: { a: 1 } } as any)).toEqual({
        v: 1, id: "m3-bus-routes", title: "新昌公交线路", kind: "categorical",
        geojson: fcLine, lines: null,
        stats: { count: 1, valueCount: 0, min: null, max: null, avg: null, sum: 0, a: 1 },
        styleHint: { field: "route_type", ramp: "categorical", widthRange: [1.5, 3.5] },
        provenance: { dataset: "m3-bus-routes", generatedBy: "m3", runId: null, at: now, demo: false },
      });
      // fromBus：stations（points + flow hint + radiusRange）
      expect(mod.fromBus("stations", { geojson: fcPoints, stats: {} } as any)).toEqual({
        v: 1, id: "m3-bus-stations", title: "新昌站点客流", kind: "points",
        geojson: fcPoints, lines: null,
        stats: { count: 2, valueCount: 1, min: 3, max: 3, avg: 3, sum: 3, p25: 3, p50: 3, p75: 3 },
        styleHint: { field: "flow", ramp: "warm", radiusRange: [3, 12] },
        provenance: { dataset: "m3-bus-stations", generatedBy: "m3", runId: null, at: now, demo: false },
      });
      // fromBus：od（flow + 无 stats 传入）
      expect(mod.fromBus("od", { geojson: fcLine } as any)).toEqual({
        v: 1, id: "m3-bus-od", title: "新昌公交 OD", kind: "flow",
        geojson: fcLine, lines: null,
        stats: { count: 1, valueCount: 1, min: 9, max: 9, avg: 9, sum: 9, p25: 9, p50: 9, p75: 9 },
        styleHint: { field: "flow", ramp: "ramp", widthRange: [0.7, 4.5] },
        provenance: { dataset: "m3-bus-od", generatedBy: "m3", runId: null, at: now, demo: false },
      });
      // fromBus：stats（空几何 → mergedStats 只剩 count/valueCount 零值 + 传入 stats）
      expect(mod.fromBus("stats", { stats: { k: 1 } } as any)).toEqual({
        v: 1, id: "m3-bus-stats", title: "新昌公交网络统计", kind: "categorical",
        geojson: { type: "FeatureCollection", features: [] }, lines: null,
        stats: { count: 0, valueCount: 0, k: 1 },
        styleHint: { field: null, ramp: "ramp", widthRange: null, radiusRange: null },
        provenance: { dataset: "m3-bus-stats", generatedBy: "m3", runId: null, at: now, demo: false },
      });
      // fromBus：other → 兜底分支（stats = result 本体）
      expect(mod.fromBus("other", { raw: 1 } as any)).toEqual({
        v: 1, id: "m3-bus-stats", title: "新昌公交网络统计", kind: "categorical",
        geojson: { type: "FeatureCollection", features: [] }, lines: null,
        stats: { count: 0, valueCount: 0, raw: 1 },
        styleHint: { field: null, ramp: "ramp", widthRange: null, radiusRange: null },
        provenance: { dataset: "m3-bus-stats", generatedBy: "m3", runId: null, at: now, demo: false },
      });
      // fromBus：无 geojson → result 本体非 FC → 空 FC
      expect(mod.fromBus("routes", { anyField: 1 } as any).geojson).toEqual({ type: "FeatureCollection", features: [] });
    });
  });

  describe("数据源注册表", () => {
    it("listSources 初始内置两源（local-file / bundled-xinchang）", () => {
      const sources: any[] = mod.listSources();
      expect(sources.map((s) => s.id)).toEqual(["local-file", "bundled-xinchang"]);
      expect(sources[0]).toEqual({
        id: "local-file",
        label: "工作区数据文件（CSV / GeoJSON）",
        kind: "*",
        paramsSchema: { path: "相对工作区的文件路径；省略时自动选工作区里最新的 CSV/GeoJSON", measure: "可选：指定数值列" },
        readOnly: true,
      });
      expect(sources[1].label).toBe("新昌公交（内置）");
      expect(sources[1].kind).toBe("od-flow");
      expect(sources[1].readOnly).toBe(true);
    });

    it("loadSource 未知 id：可读错误 + available 清单", async () => {
      const miss: any = await mod.loadSource("nope-xyz");
      expect(miss.error).toContain("未知数据源：nope-xyz（可用：");
      expect(miss.available).toContain("local-file");
      expect(miss.available).toContain("bundled-xinchang");
    });

    it("registerSource 校验：无 id / 无 load throw、readOnly 默认 true、缺省 label/kind", () => {
      expect(() => mod.registerSource({ label: "无id" })).toThrow("数据源适配器必须有 id");
      expect(() => mod.registerSource({ id: "t-noload" })).toThrow("数据源 t-noload 必须有 load()");
      const entry: any = mod.registerSource({ id: "t-ro", load: async () => ({}) });
      expect(entry.readOnly).toBe(true);
      expect(entry.label).toBe("t-ro");
      expect(entry.kind).toBe("*");
      expect(entry.paramsSchema).toEqual({});
      const entry2: any = mod.registerSource({ id: "t-w", load: async () => ({}), readOnly: false, label: "可写", kind: "flow", paramsSchema: { a: 1 } });
      expect(entry2.readOnly).toBe(false);
      expect(entry2.kind).toBe("flow");
      // 注册后可在 listSources 中发现
      expect(mod.listSources().map((s: any) => s.id)).toContain("t-ro");
    });

    it("loadSource：out.error 透传 / throw 包装 / v===1 直返 / 裸 GeoJSON 包装", async () => {
      // error 透传
      mod.registerSource({ id: "t-err", load: async () => ({ error: "自定义错误" }) });
      expect((await mod.loadSource("t-err") as any).error).toBe("自定义错误");
      // throw → 包装文案
      mod.registerSource({ id: "t-throw", load: async () => { throw new Error("炸了"); } });
      expect((await mod.loadSource("t-throw") as any).error).toBe("数据源 t-throw 加载失败：炸了");
      // v===1 且有 kind → 直返
      const v1 = { v: 1, kind: "heatmap", id: "x", title: "X", geojson: fcEmpty, stats: {}, styleHint: null, provenance: { at: 5 } };
      mod.registerSource({ id: "t-v1", load: async () => v1 });
      expect(await mod.loadSource("t-v1")).toEqual(v1);
      // 裸 FeatureCollection → 包装成描述符
      mod.registerSource({
        id: "t-raw",
        label: "裸GeoJSON",
        load: async () => ({ type: "FeatureCollection", features: [{ type: "Feature", properties: { value: 3 }, geometry: { type: "Point", coordinates: [120, 29] } }] }),
      });
      const raw: any = await mod.loadSource("t-raw");
      expect(raw.kind).toBe("points");
      expect(raw.id).toBe("t-raw");
      expect(raw.title).toBe("裸GeoJSON");
      expect(raw.geojson.features.length).toBe(1);
      expect(raw.provenance.dataset).toBe("t-raw");
      expect(raw.provenance.generatedBy).toBe("adapter");
      // 裸非 FC 对象 → 空 FC 包装
      mod.registerSource({ id: "t-junk", load: async () => ({ foo: 1 }) });
      const junk: any = await mod.loadSource("t-junk");
      expect(junk.kind).toBe("flow");
      expect(junk.geojson.features.length).toBe(0);
    });

    it("loadSource bundled-xinchang：真实数据四 kind + 非法 kind 默认 stations", async () => {
      const routes: any = await mod.loadSource("bundled-xinchang", { kind: "routes" });
      expect(routes.id).toBe("m3-bus-routes");
      expect(routes.kind).toBe("categorical");
      expect(routes.error).toBeUndefined();
      const stations: any = await mod.loadSource("bundled-xinchang", { kind: "stations" });
      expect(stations.id).toBe("m3-bus-stations");
      expect(stations.kind).toBe("points");
      expect(stations.geojson.features.length).toBeGreaterThan(0);
      const od: any = await mod.loadSource("bundled-xinchang", { kind: "od" });
      expect(od.id).toBe("m3-bus-od");
      expect(od.kind).toBe("flow");
      const stats: any = await mod.loadSource("bundled-xinchang", { kind: "stats" });
      expect(stats.id).toBe("m3-bus-stats");
      expect(stats.geojson.features.length).toBe(0);
      expect(Object.keys(stats.stats).length).toBeGreaterThan(0);
      const fallback: any = await mod.loadSource("bundled-xinchang", { kind: "bogus" });
      expect(fallback.id).toBe("m3-bus-stations");
      // local-file 冒烟：经注册表面走通（分支矩阵在 s3-traffic-sources-parity）
      const smoke = await mod.loadSource("local-file", { path: "definitely-missing.csv" });
      expect((smoke as any).error).toBe("文件不存在：definitely-missing.csv");
    });

    it("_resetSources 清空 + 空表可用清单（套件末尾）", async () => {
      mod._resetSources();
      expect(mod.listSources()).toEqual([]);
      const miss: any = await mod.loadSource("nope");
      expect(miss.error).toBe("未知数据源：nope（可用：无）");
      expect(miss.available).toEqual([]);
    });
  });
});
