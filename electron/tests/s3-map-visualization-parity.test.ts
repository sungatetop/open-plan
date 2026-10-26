/**
 * S3-9 map-visualization 域对拍：12 导出面一致 / numericStats 分位（空/单值/常规/负数
 * 与 NaN 字符串过滤）/ detectMeasureField（hint 命中优先、退化多数数值列、空集合、采样
 * 前 50）/ toDescriptor（kind 几何推断、mergedStats count 恒要素数 + valueCount + stats
 * 展开覆盖序、styleHint 兜底 warm/ramp/widthRange/radiusRange、id/title 默认、provenance
 * 默认与显式）/ from* 适配器五族全分支（demoAnalysis 三 kind、trafficBandwidth、odLines、
 * cambodiaOd、bus 四分支 + geojson 缺省兜底）/ 数据源注册表（listSources 初始内置两源、
 * registerSource 校验与只读默认、loadSource 未知 id、out.error 透传、throw 包装文案、
 * v===1 直返、裸 GeoJSON 包装、bundled-xinchang 真实数据四 kind + 非法 kind 默认）/
 * _resetSources 清空与空表可用清单。
 *
 * 真实 IO 双跑：legacy pathToFileURL 物理加载 server/map-visualization.mjs + traffic-sources.mjs
 * （导入即注册），modern 静态 import TS 两模块（同样导入即注册）。fake timers 冻结 Date
 * （provenance.at 双侧一致）。注册表用例序敏感：listSources 初始断言在前、registerSource
 * 用唯一测试 id 不污染内置源、_resetSources 置于套件末尾。bundled-xinchang 演示回退分支
 * （catch → getXinchangBus）真实数据在场不可达，有意不做记台账；local-file 适配器分支
 * 矩阵在 s3-traffic-sources-parity.test.ts 覆盖，此处仅经注册表面做冒烟。
 */
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as modernVis from "../src/main/backend/map-visualization";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "../..");

const IMPLS = ["legacy", "modern"] as const;
type ImplKind = (typeof IMPLS)[number];
type VisModule = typeof modernVis;

const mod = {} as Record<ImplKind, VisModule>;

function captureSync(fn: () => unknown): any {
  try { fn(); } catch (e) { return e; }
  return null;
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-24T02:00:00Z"));
  // legacy 链：物理 traffic-sources.mjs 导入即注册进物理 map-visualization.mjs 实例
  await import(pathToFileURL(path.join(PROJECT_ROOT, "server/traffic-sources.mjs")).href);
  mod.legacy = await import(pathToFileURL(path.join(PROJECT_ROOT, "server/map-visualization.mjs")).href) as VisModule;
  // modern 链：TS traffic-sources 导入即注册进 TS map-visualization 实例
  await import("../src/main/backend/traffic-sources");
  mod.modern = modernVis;
});

afterAll(() => {
  vi.useRealTimers();
});

// ---- 测试几何（双侧共用同一批常量对象） ----
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

describe("S3-9 map-visualization 对拍", () => {
  it("导出面一致（12 导出，双侧 keys 集合相等）", () => {
    expect(Object.keys(mod.legacy).sort()).toEqual(Object.keys(mod.modern).sort());
    expect(Object.keys(mod.modern).sort()).toEqual([
      "_resetSources", "detectMeasureField", "fromBus", "fromCambodiaOd", "fromDemoAnalysis",
      "fromOdLines", "fromTrafficBandwidth", "listSources", "loadSource", "numericStats",
      "registerSource", "toDescriptor",
    ]);
  });

  describe("纯函数双侧逐字节", () => {
    it("numericStats：空/单值/常规/负数与 NaN 字符串 null 过滤", () => {
      const cases: any[][] = [
        [],
        [5],
        [3, 1, 2],
        [10, -5, 0.5, 7],
        [1, "2", NaN, null, undefined, 4, "abc"],
      ];
      for (const c of cases) {
        expect(JSON.stringify(mod.legacy.numericStats(c))).toBe(JSON.stringify(mod.modern.numericStats(c)));
      }
      // 分位取值锚点（排序后 at(q) 语义）
      const r: any = mod.modern.numericStats([10, 20, 30, 40]);
      expect(r.min).toBe(10);
      expect(r.max).toBe(40);
      // at(q) 为 ROUND 索引取整、非线性插值：round(0.75)=1→20 / round(1.5)=2→30 / round(2.25)=2→30
      expect(r.p25).toBe(20);
      expect(r.p50).toBe(30);
      expect(r.p75).toBe(30);
    });

    it("detectMeasureField：hint 命中优先 / 退化多数数值 / 空集合 / 采样前 50", () => {
      expect(mod.legacy.detectMeasureField({})).toBe("");
      expect(mod.modern.detectMeasureField({})).toBe("");
      expect(mod.legacy.detectMeasureField(fcEmpty)).toBe("");
      expect(mod.modern.detectMeasureField(fcEmpty)).toBe("");
      // hint 优先序：flow 先于 value（两列同时在 → flow）
      const bothHints = { type: "FeatureCollection", features: [{ type: "Feature", properties: { value: 1, flow: 2 }, geometry: { type: "Point", coordinates: [120, 29] } }] };
      expect(mod.legacy.detectMeasureField(bothHints as any)).toBe("flow");
      expect(mod.modern.detectMeasureField(bothHints as any)).toBe("flow");
      // 退化：多数样本数值列（非 hint 命名）
      const degenerate = { type: "FeatureCollection", features: [1, 2, 3].map((n) => ({ type: "Feature", properties: { custom_num: n, label: `x${n}` }, geometry: { type: "Point", coordinates: [120, 29] } })) };
      expect(mod.legacy.detectMeasureField(degenerate as any)).toBe("custom_num");
      expect(mod.modern.detectMeasureField(degenerate as any)).toBe("custom_num");
      // 退化失败：3 要素中数值样本不足 3
      const degenerateMiss = { type: "FeatureCollection", features: [1, 2, "x"].map((n) => ({ type: "Feature", properties: { num: n }, geometry: { type: "Point", coordinates: [120, 29] } })) };
      expect(mod.legacy.detectMeasureField(degenerateMiss as any)).toBe("");
      expect(mod.modern.detectMeasureField(degenerateMiss as any)).toBe("");
      // 采样前 50：第 51 个要素的 hint 列 flow 不参与采样（否则 hint 命中会返回 "flow"）；
      // 前 50 个 plain 全数值 → 退化分支命中 "plain"
      const sampled = { type: "FeatureCollection", features: Array.from({ length: 51 }, (_, i) => ({ type: "Feature", properties: i === 50 ? { flow: 1 } : { plain: i }, geometry: { type: "Point", coordinates: [120, 29] } })) };
      expect(mod.legacy.detectMeasureField(sampled as any)).toBe("plain");
      expect(mod.modern.detectMeasureField(sampled as any)).toBe("plain");
    });

    it("toDescriptor：kind 推断 / mergedStats / hint 兜底 / 默认值 全分支", () => {
      const cases: any[] = [
        // 全默认：空 FC → flow、ramp ramp、widthRange [0.7,4.5]
        {},
        // 点几何 → points + radiusRange、measure hint 命中 flow
        { geojson: fcPoints },
        // 显式 kind 覆盖 + heatmap → warm
        { geojson: fcPoly, kind: "heatmap" },
        // id=0 / title="" falsy 默认
        { geojson: fcLine, id: 0, title: "" },
        // styleHint 透传（自定义对象原样）
        { geojson: fcPoints, styleHint: { field: "自定义" } },
        // stats 展开覆盖：count 恒要素数，stats 键追加在后
        { geojson: fcPoints, stats: { custom: 9, count: 99 } },
        // provenance 显式全字段（demo=1 → true、at 显式）
        { geojson: fcPoints, provenance: { dataset: "d", generatedBy: "g", runId: "r", at: 123, demo: 1 } },
        // lines 兜底：measure 从 lines 探测
        { lines: fcLine },
        // 非 FC geojson（裸对象）→ 空 FC
        { geojson: { type: "Feature", properties: {} } },
      ];
      for (const c of cases) {
        expect(JSON.stringify(mod.legacy.toDescriptor(c))).toBe(JSON.stringify(mod.modern.toDescriptor(c)));
      }
      // 关键语义锚点：count 恒要素数、valueCount 有值数、stats 键展开追加（custom）
      const r: any = mod.modern.toDescriptor({ geojson: fcPoints, stats: { count: 99, custom: 9 } });
      expect(r.stats.count).toBe(2);
      expect(r.stats.valueCount).toBe(1);
      expect(r.stats.custom).toBe(9);
      // 缺 features 的 FC → 旧侧抛 TypeError（main.features.length），双侧错误信息一致
      const e1 = captureSync(() => mod.legacy.toDescriptor({ geojson: { type: "FeatureCollection" } }));
      const e2 = captureSync(() => mod.modern.toDescriptor({ geojson: { type: "FeatureCollection" } }));
      expect(e1).toBeInstanceOf(Error);
      expect((e1 as Error).message).toBe((e2 as Error).message);
    });

    it("from* 适配器五族全分支", () => {
      const cases: Array<[string, any, any]> = [
        ["fromDemoAnalysis", { analysis: "heatmap", id: "a1", title: "T", geojson: fcPoints, stats: { a: 1 }, source: "demo" }, undefined],
        ["fromDemoAnalysis", { analysis: "od", geojson: fcLine, lines: fcLine }, undefined],
        ["fromDemoAnalysis", { analysis: "isochrone", geojson: fcPoly }, undefined],
        ["fromDemoAnalysis", {}, undefined],
        ["fromTrafficBandwidth", { geojson: fcLine, stats: { withTraffic: 2, max: 5, min: 1, avg: 3 } }, undefined],
        ["fromTrafficBandwidth", {}, undefined],
        ["fromOdLines", { geojson: fcLine, stats: { levels: [1], volumeStats: { a: 1 } } }, undefined],
        ["fromOdLines", {}, undefined],
        ["fromCambodiaOd", { points: fcPoints, lines: fcLine, stats: { totalFlow: 9, other: 1 }, status: "demo" }, undefined],
        ["fromCambodiaOd", {}, undefined],
        ["fromBus", "routes", { geojson: fcLine, stats: { a: 1 } }],
        ["fromBus", "stations", { geojson: fcPoints, stats: {} }],
        ["fromBus", "od", { geojson: fcLine }],
        ["fromBus", "stats", { stats: { k: 1 } }],
        ["fromBus", "other", { raw: 1 }],
        ["fromBus", "routes", { anyField: 1 }], // 无 geojson → result 本体非 FC → 空 FC
      ];
      for (const [fn, a, b] of cases) {
        const legacyJson = JSON.stringify((mod.legacy as any)[fn](a, b));
        const modernJson = JSON.stringify((mod.modern as any)[fn](a, b));
        expect(legacyJson).toBe(modernJson);
      }
      // 关键锚点：demo 标记与固定 id
      expect((mod.modern.fromDemoAnalysis({ source: "demo" }) as any).provenance.demo).toBe(true);
      expect((mod.modern.fromTrafficBandwidth({}) as any).id).toBe("m2-traffic-bandwidth");
      // fromBus("stats") → toDescriptor 空几何：mergedStats 只剩 count/valueCount 零值
      expect((mod.modern.fromBus("stats", {}) as any).stats).toEqual({ count: 0, valueCount: 0 });
    });
  });

  // 跨侧对比置于 describe.each 注册表套件之前：legacy 套件末尾的 _resetSources 会清空
  // legacy 注册表，若对比放在 modern 套件内，legacy 侧已无 bundled-xinchang 可加载。
  describe("bundled-xinchang 跨侧对比（注册表未被 _resetSources 触达前）", () => {
    it("四 kind + 非法 kind 默认 stations 双侧逐字节", async () => {
      for (const kind of ["routes", "stations", "od", "stats", undefined, "bogus"]) {
        const l = await mod.legacy.loadSource("bundled-xinchang", { kind });
        const m = await mod.modern.loadSource("bundled-xinchang", { kind });
        expect(JSON.stringify(l)).toBe(JSON.stringify(m));
        expect((l as any).error).toBeUndefined();
      }
    });
  });

  describe.each(IMPLS)("数据源注册表 %s", (kindI: ImplKind) => {
    it("listSources 初始内置两源（local-file / bundled-xinchang）", () => {
      const sources: any[] = mod[kindI].listSources();
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
      const miss: any = await mod[kindI].loadSource("nope-xyz");
      expect(miss.error).toContain("未知数据源：nope-xyz（可用：");
      expect(miss.available).toContain("local-file");
      expect(miss.available).toContain("bundled-xinchang");
    });

    it("registerSource 校验：无 id / 无 load throw、readOnly 默认 true、缺省 label/kind", () => {
      expect(() => mod[kindI].registerSource({ label: "无id" })).toThrow("数据源适配器必须有 id");
      expect(() => mod[kindI].registerSource({ id: "t-noload" })).toThrow("数据源 t-noload 必须有 load()");
      const entry: any = mod[kindI].registerSource({ id: "t-ro", load: async () => ({}) });
      expect(entry.readOnly).toBe(true);
      expect(entry.label).toBe("t-ro");
      expect(entry.kind).toBe("*");
      expect(entry.paramsSchema).toEqual({});
      const entry2: any = mod[kindI].registerSource({ id: "t-w", load: async () => ({}), readOnly: false, label: "可写", kind: "flow", paramsSchema: { a: 1 } });
      expect(entry2.readOnly).toBe(false);
      expect(entry2.kind).toBe("flow");
      // 注册后可在 listSources 中发现
      expect(mod[kindI].listSources().map((s: any) => s.id)).toContain("t-ro");
    });

    it("loadSource：out.error 透传 / throw 包装 / v===1 直返 / 裸 GeoJSON 包装", async () => {
      // error 透传
      mod[kindI].registerSource({ id: "t-err", load: async () => ({ error: "自定义错误" }) });
      expect((await mod[kindI].loadSource("t-err") as any).error).toBe("自定义错误");
      // throw → 包装文案
      mod[kindI].registerSource({ id: "t-throw", load: async () => { throw new Error("炸了"); } });
      expect((await mod[kindI].loadSource("t-throw") as any).error).toBe("数据源 t-throw 加载失败：炸了");
      // v===1 且有 kind → 直返
      const v1 = { v: 1, kind: "heatmap", id: "x", title: "X", geojson: fcEmpty, stats: {}, styleHint: null, provenance: { at: 5 } };
      mod[kindI].registerSource({ id: "t-v1", load: async () => v1 });
      expect(await mod[kindI].loadSource("t-v1")).toEqual(v1);
      // 裸 FeatureCollection → 包装成描述符
      mod[kindI].registerSource({
        id: "t-raw",
        label: "裸GeoJSON",
        load: async () => ({ type: "FeatureCollection", features: [{ type: "Feature", properties: { value: 3 }, geometry: { type: "Point", coordinates: [120, 29] } }] }),
      });
      const raw: any = await mod[kindI].loadSource("t-raw");
      expect(raw.kind).toBe("points");
      expect(raw.id).toBe("t-raw");
      expect(raw.title).toBe("裸GeoJSON");
      expect(raw.geojson.features.length).toBe(1);
      expect(raw.provenance.dataset).toBe("t-raw");
      expect(raw.provenance.generatedBy).toBe("adapter");
      // 裸非 FC 对象 → 空 FC 包装
      mod[kindI].registerSource({ id: "t-junk", load: async () => ({ foo: 1 }) });
      const junk: any = await mod[kindI].loadSource("t-junk");
      expect(junk.kind).toBe("flow");
      expect(junk.geojson.features.length).toBe(0);
    });

    it("loadSource bundled-xinchang：真实数据四 kind + 非法 kind 默认 stations（单侧，跨侧对比见套件外）", async () => {
      const routes: any = await mod[kindI].loadSource("bundled-xinchang", { kind: "routes" });
      expect(routes.id).toBe("m3-bus-routes");
      expect(routes.kind).toBe("categorical");
      const stations: any = await mod[kindI].loadSource("bundled-xinchang", { kind: "stations" });
      expect(stations.id).toBe("m3-bus-stations");
      expect(stations.kind).toBe("points");
      expect(stations.geojson.features.length).toBeGreaterThan(0);
      const od: any = await mod[kindI].loadSource("bundled-xinchang", { kind: "od" });
      expect(od.id).toBe("m3-bus-od");
      expect(od.kind).toBe("flow");
      const stats: any = await mod[kindI].loadSource("bundled-xinchang", { kind: "stats" });
      expect(stats.id).toBe("m3-bus-stats");
      expect(stats.geojson.features.length).toBe(0);
      expect(Object.keys(stats.stats).length).toBeGreaterThan(0);
      const fallback: any = await mod[kindI].loadSource("bundled-xinchang", { kind: "bogus" });
      expect(fallback.id).toBe("m3-bus-stations");
      // local-file 冒烟：经注册表面走通（分支矩阵在 s3-traffic-sources-parity）
      const smoke = await mod[kindI].loadSource("local-file", { path: "definitely-missing.csv" });
      expect((smoke as any).error).toBe("文件不存在：definitely-missing.csv");
    });

    it("_resetSources 清空 + 空表可用清单（套件末尾）", async () => {
      mod[kindI]._resetSources();
      expect(mod[kindI].listSources()).toEqual([]);
      const miss: any = await mod[kindI].loadSource("nope");
      expect(miss.error).toBe("未知数据源：nope（可用：无）");
      expect(miss.available).toEqual([]);
    });
  });
});
