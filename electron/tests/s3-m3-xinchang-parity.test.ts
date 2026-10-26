/**
 * S3-9 m3-xinchang 域对拍：4 导出（getBusRoutes/getStationHeatmap/getBusODLines/
 * getBusNetworkStats）读真实 server/xinchang-data 双侧同源互等。
 *
 * 双侧 DATA_DIR 物理同目录（legacy __dirname 锚 server/、modern PROJECT_DIR/server 锚），
 * 纯计算无时间戳，结果逐字节 JSON 相等；另做导出面一致（4 导出）与域语义结构断言
 * （线路分类四类、站点 high/medium/low 阈值、OD 自环过滤与 Top200、线网长度分布）。
 * 数据缺失/空数据分支不可达（真实数据在场），有意不做并记台账。蓝本
 * scripts/m3-xinchang-test.mjs（旧回归脚本不迁移，随域退役）。
 */
import { describe, expect, it, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as modern from "../src/main/backend/m3-xinchang";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "../..");

const IMPLS = ["legacy", "modern"] as const;
type ImplKind = (typeof IMPLS)[number];
type M3Module = typeof modern;

const mod = {} as Record<ImplKind, M3Module>;

beforeAll(async () => {
  mod.legacy = await import(pathToFileURL(path.join(PROJECT_ROOT, "server/m3-xinchang.mjs")).href) as M3Module;
  mod.modern = modern;
  // 锚点 sanity：真实数据在场（三份源文件同一物理目录）
  expect(fs.existsSync(path.join(PROJECT_ROOT, "server/xinchang-data/routes.geojson"))).toBe(true);
  expect(fs.existsSync(path.join(PROJECT_ROOT, "server/xinchang-data/stations.json"))).toBe(true);
  expect(fs.existsSync(path.join(PROJECT_ROOT, "server/xinchang-data/od-flow.json"))).toBe(true);
});

describe("S3-9 m3-xinchang 对拍", () => {
  it("导出面一致（4 导出，双侧 keys 集合相等）", () => {
    expect(Object.keys(mod.legacy).sort()).toEqual(Object.keys(mod.modern).sort());
    expect(Object.keys(mod.modern).sort()).toEqual(["getBusNetworkStats", "getBusODLines", "getBusRoutes", "getStationHeatmap"]);
  });

  describe.each(IMPLS)("结构语义 %s", (kindI: ImplKind) => {
    it("getBusRoutes：要素带 route_type/route_color，统计自洽", () => {
      const r: any = mod[kindI].getBusRoutes();
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
      const r: any = mod[kindI].getStationHeatmap();
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
      const r: any = mod[kindI].getBusODLines();
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
      const r: any = mod[kindI].getBusNetworkStats();
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
  });

  it("四函数全量双侧逐字节 JSON 相等（真实数据同源）", () => {
    for (const fn of ["getBusRoutes", "getStationHeatmap", "getBusODLines", "getBusNetworkStats"]) {
      const legacyJson = JSON.stringify((mod.legacy as any)[fn]());
      const modernJson = JSON.stringify((mod.modern as any)[fn]());
      expect(legacyJson).toBe(modernJson);
    }
  });
});
