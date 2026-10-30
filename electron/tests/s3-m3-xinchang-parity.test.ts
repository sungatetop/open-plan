/**
 * S3-9 m3-xinchang 域单侧行为覆盖（R6-7b 对拍退役改写）：4 导出
 * （getBusRoutes/getStationHeatmap/getBusODLines/getBusNetworkStats）读真实
 * xinchang-data（routes.geojson/stations.json/od-flow.json）做结构语义断言
 * （线路分类四类、站点 high/medium/low 阈值、OD 自环过滤与 Top200、线网长度分布）
 * 与关键统计绝对锚点（自真实数据冻结）。与旧 server/m3-xinchang.mjs 的双侧逐字节
 * 互等已在 S3-9 对拍验收冻结（蓝本 scripts/m3-xinchang-test.mjs 已随 R6-6d 根脚本
 * 清理删除）。数据缺失/空数据分支不可达（真实数据在场），有意不做并记台账。
 */
import { describe, expect, it, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as modern from "../src/main/backend/m3-xinchang";
import { setWorkspace, WORKSPACE_DIR } from "../src/main/backend/workspace";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "../..");

beforeAll(() => {
  // 数据锚点随当前工作区（2026-10-30 地图库跟随）：测试固定默认工作区锚，
  // 防 .workspace-state.json 残留切换态干扰真实数据断言
  setWorkspace(WORKSPACE_DIR);
  // 锚点 sanity：真实数据在场（三份源文件同一物理目录；R6 收口后修正起切外部运行时
  // 数据目录 office-workspace/maps/bus-xinchang，与 map.ts busDataDir 同锚，资源包
  // 不再内置业务数据——缺数据时各维度走「数据不存在」错误路径，用户放数据即生效）
  expect(fs.existsSync(path.join(PROJECT_ROOT, "office-workspace/maps/bus-xinchang/routes.geojson"))).toBe(true);
  expect(fs.existsSync(path.join(PROJECT_ROOT, "office-workspace/maps/bus-xinchang/stations.json"))).toBe(true);
  expect(fs.existsSync(path.join(PROJECT_ROOT, "office-workspace/maps/bus-xinchang/od-flow.json"))).toBe(true);
});

describe("S3-9 m3-xinchang 域", () => {
  it("导出面（4 导出锚点）", () => {
    expect(Object.keys(modern).sort()).toEqual(["getBusNetworkStats", "getBusODLines", "getBusRoutes", "getStationHeatmap"]);
  });

  it("getBusRoutes：要素带 route_type/route_color，统计自洽", () => {
    const r: any = modern.getBusRoutes();
    expect(r.error).toBeUndefined();
    expect(r.type).toBe("FeatureCollection");
    expect(r.features.length).toBeGreaterThan(0);
    expect(r.stats.featureCount).toBe(r.features.length);
    expect(r.stats.routeCount).toBeGreaterThan(0);
    for (const f of r.features) {
      expect(["城市公交", "城乡公交", "城际公交", "其他"]).toContain(f.properties.route_type);
      expect(f.properties.route_color).toMatch(/^#[0-9A-F]{6}$/i);
      expect(f.properties.direction).toBe(f.properties.dir || f.properties.方向 || "");
    }
    // byType 计数合计 = 要素数（上下行对半分前）
    const sumByType = r.stats.byType.reduce((s: number, b: any) => s + b.count * 2, 0);
    expect(sumByType).toBe(r.features.length);
  });

  it("getStationHeatmap：level 阈值与 stats 分桶自洽", () => {
    const r: any = modern.getStationHeatmap();
    expect(r.error).toBeUndefined();
    expect(r.stats.stationCount).toBe(r.geojson.features.length);
    expect(r.top20.length).toBe(Math.min(20, r.stats.stationCount));
    for (const f of r.geojson.features) {
      const expected = f.properties.flow > 500 ? "high" : f.properties.flow > 100 ? "medium" : "low";
      expect(f.properties.level).toBe(expected);
    }
    expect(r.stats.highCount + r.stats.mediumCount + r.stats.lowCount).toBe(r.stats.stationCount);
    expect(r.stats.maxFlow).toBeGreaterThanOrEqual(r.stats.minFlow);
  });

  it("getBusODLines：自环过滤、Top 200、level 阈值", () => {
    const r: any = modern.getBusODLines();
    expect(r.error).toBeUndefined();
    expect(r.stats.displayPairs).toBe(r.geojson.features.length);
    expect(r.stats.displayPairs).toBeLessThanOrEqual(200);
    expect(r.stats.displayPairs).toBeLessThanOrEqual(r.stats.totalPairs);
    for (const f of r.geojson.features) {
      // 无自环
      const [o, d] = f.geometry.coordinates;
      expect(Math.abs(o[0] - d[0]) > 0.0001 || Math.abs(o[1] - d[1]) > 0.0001).toBe(true);
      // level 用未取整的 top flow（stats.maxFlow 是 Math.round 口径，直接复算会漂移）
      const maxFlow = r.geojson.features[0].properties.flow;
      const expected = f.properties.flow > maxFlow * 0.5 ? "high" : f.properties.flow > maxFlow * 0.15 ? "medium" : "low";
      expect(f.properties.level).toBe(expected);
    }
    // 流量降序
    for (let i = 1; i < r.geojson.features.length; i++) {
      expect(r.geojson.features[i].properties.flow).toBeLessThanOrEqual(r.geojson.features[i - 1].properties.flow);
    }
  });

  it("getBusNetworkStats：长度分布合计 = 线路数，byType 带配色", () => {
    const r: any = modern.getBusNetworkStats();
    expect(r.error).toBeUndefined();
    expect(r.stats.routeCount).toBeGreaterThan(0);
    const sumDist = r.stats.lengthDist.reduce((s: number, d: any) => s + d.count, 0);
    expect(sumDist).toBe(r.stats.routeCount);
    for (const b of r.stats.byType) expect(b.color).toMatch(/^#[0-9A-F]{6}$/i);
    expect(r.stats.longestRoutes.length).toBeLessThanOrEqual(5);
    // longestRoutes 降序
    for (let i = 1; i < r.stats.longestRoutes.length; i++) {
      expect(r.stats.longestRoutes[i].length).toBeLessThanOrEqual(r.stats.longestRoutes[i - 1].length);
    }
  });

  it("关键统计绝对锚点（真实数据冻结）", () => {
    const routes: any = modern.getBusRoutes();
    expect(routes.stats).toEqual({
      routeCount: 26,
      featureCount: 52,
      totalLength: 384.19,
      byType: [
        { type: "城市公交", color: "#4A90D9", count: 19, length: 283 },
        { type: "其他", color: "#999999", count: 1, length: 9 },
        { type: "城际公交", color: "#FF8C42", count: 3, length: 46 },
        { type: "城乡公交", color: "#50C878", count: 3, length: 46 },
      ],
    });

    const heat: any = modern.getStationHeatmap();
    expect(heat.stats).toEqual({
      stationCount: 425,
      totalFlow: 45866,
      avgFlow: 108,
      maxFlow: 1679,
      minFlow: 1,
      highCount: 10,
      mediumCount: 134,
      lowCount: 281,
    });
    expect(heat.top20.length).toBe(20);

    const od: any = modern.getBusODLines();
    expect(od.stats).toEqual({
      totalPairs: 98,
      displayPairs: 98,
      totalFlow: 7312,
      maxFlow: 627,
      avgFlow: 75,
    });

    const net: any = modern.getBusNetworkStats();
    expect(net.stats.routeCount).toBe(26);
    expect(net.stats.totalRouteLength).toBe(384);
    expect(net.stats.avgRouteLength).toBe(14.8);
    expect(net.stats.lengthDist).toEqual([
      { range: "< 5km", count: 0 },
      { range: "5-10km", count: 5 },
      { range: "10-15km", count: 9 },
      { range: "> 15km", count: 12 },
    ]);
    expect(net.stats.longestRoutes.map((x: any) => x.name)).toEqual(["17路", "6路", "G3路", "18路", "1路"]);
  });
});
