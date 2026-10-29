/**
 * B2-11 map-analysis 域：createDemoAnalysis（heatmap 默认 / od / isochrone 全分支 +
 * count·region 参数钳制与回退边界）/ getCambodiaOD（minFlow 过滤与类型归一）/
 * getXinchangBus（routes / stations / od / stats 全 kind）。
 *
 * R6-7a 对拍退役改写：旧侧 server/map-analysis.mjs 物理路径动态 import
 * （pathToFileURL）随 server/ 退役删除（等价性已在 B2-11 批对拍验收冻结），仅保留
 * 新侧静态 import src/main/backend/map-analysis.ts 的同一套绝对断言。
 * 零依赖纯函数域 → 免 stubEnv 简化形态（B2-5/B2-10 先例）。输出确定性（伪随机全部
 * 来自索引运算，无时间/随机源）。
 */
import { describe, expect, it } from "vitest";
import { createDemoAnalysis, getCambodiaOD, getXinchangBus } from "../src/main/backend/map-analysis";

describe("B2-11 map-analysis：createDemoAnalysis", () => {
  it("默认参数（无参与空对象）：heatmap 形态 + source=demo + 36 点", () => {
    const r = createDemoAnalysis() as any;
    expect(r.action).toBe("show_analysis");
    expect(r.analysis).toBe("heatmap");
    expect(r.source).toBe("demo");
    expect(r.geojson.features).toHaveLength(36);
    expect(r.stats).toEqual({ demo: true, region: "义乌市", count: 36 });
    expect(createDemoAnalysis({})).toEqual(createDemoAnalysis());
  });

  it("heatmap 指定 region：title/stats/点位命名跟随 region", () => {
    const r = createDemoAnalysis({ region: "杭州市" }) as any;
    expect(r.title).toBe("杭州市点位热力图");
    expect(r.geojson.features[0].properties.name).toContain("杭州市演示点");
  });

  it("heatmap 未知 region：centerOf 回退义乌市（点位坐标与默认一致）", () => {
    const fallback = createDemoAnalysis() as any;
    const unknown = createDemoAnalysis({ region: "不存在的市" }) as any;
    expect(unknown.geojson.features.map((f: any) => f.geometry.coordinates))
      .toEqual(fallback.geojson.features.map((f: any) => f.geometry.coordinates));
  });

  it("heatmap count 钳制：5→12 / 200→120 / 0→36 / NaN→36 / '50'→50", () => {
    for (const count of [5, 200, 0, NaN, "50"]) {
      const r = createDemoAnalysis({ count } as any) as any;
      const expected = count === 5 ? 12 : count === 200 ? 120 : count === "50" ? 50 : 36;
      expect(r.geojson.features.length, `count=${String(count)}`).toBe(expected);
    }
    expect((createDemoAnalysis({ count: 5 }) as any).geojson.features).toHaveLength(12);
    expect((createDemoAnalysis({ count: 200 }) as any).geojson.features).toHaveLength(120);
    expect((createDemoAnalysis({ count: 0 }) as any).stats.count).toBe(36);
  });

  it("od 默认 region（义乌市）：单目标台州市 + OD 线与统计", () => {
    const r = createDemoAnalysis({ analysis: "od" }) as any;
    expect(r.type).toBe("od");
    expect(r.id).toBe("agent-od-analysis");
    expect(r.title).toBe("义乌市—台州市各县市区出行 OD");
    expect(r.stats.targetCount).toBe(1);
    expect(r.lines.features).toHaveLength(1);
    expect(r.lines.features[0].properties.direction).toBe("outbound");
  });

  it("od region=玉环市/台州市：TAIZHOU_COUNTIES 过滤（玉环市剔自身 8 目标 / 台州市不在县名单 9 目标）", () => {
    for (const region of ["玉环市", "台州市"]) {
      const r = createDemoAnalysis({ analysis: "od", region }) as any;
      expect(r.stats.targetCount, `region=${region}`).toBe(region === "玉环市" ? 8 : 9);
      expect(r.lines.features).toHaveLength(r.stats.targetCount);
    }
  });

  it("od region=台州市：目标不含台州市自身", () => {
    const r = createDemoAnalysis({ analysis: "od", region: "台州市" }) as any;
    const dests = r.lines.features.map((f: any) => f.properties.destination);
    expect(dests).not.toContain("台州市");
    expect(r.geojson.features[0].properties.role).toBe("origin");
  });

  it("isochrone：3 圈层 + ring 闭合 + 颜色族", () => {
    const r = createDemoAnalysis({ analysis: "isochrone" }) as any;
    expect(r.title).toBe("义乌市可达性等时圈");
    expect(r.geojson.features).toHaveLength(3);
    expect(r.stats.ranges).toEqual([15, 30, 45]);
    for (const f of r.geojson.features) {
      const ring = f.geometry.coordinates[0];
      expect(ring[0]).toEqual(ring[ring.length - 1]);
      expect(ring).toHaveLength(49);
    }
  });
});

describe("B2-11 map-analysis：getCambodiaOD", () => {
  it("默认 minFlow=0：全量 demo 行 + stats/topOrigins/topDestinations/topPairs", () => {
    const r = getCambodiaOD() as any;
    expect(r.error).toBeNull();
    expect(r.source).toBe("siem-reap-od-demo.csv");
    expect(r.status).toBe("demo");
    expect(r.topOrigins.length).toBeLessThanOrEqual(8);
    expect(r.topPairs.length).toBeLessThanOrEqual(8);
    expect(r.points.features).toHaveLength(r.stats.records);
  });

  it("minFlow 过滤：300 过滤低流量行，stats.minFlow=300", () => {
    const all = getCambodiaOD() as any;
    const filtered = getCambodiaOD({ minFlow: 300 }) as any;
    expect(filtered.stats.records).toBeLessThan(all.stats.records);
    expect(filtered.stats.records).toBeGreaterThan(0);
    expect(filtered.stats.minFlow).toBe(300);
  });

  it("minFlow 边界：负值钳 0（与默认一致）/ '150' 字符串 Number 归一", () => {
    expect(getCambodiaOD({ minFlow: -5 })).toEqual(getCambodiaOD());
    expect((getCambodiaOD({ minFlow: "150" } as any) as any).stats.minFlow).toBe(150);
  });
});

describe("B2-11 map-analysis：getXinchangBus", () => {
  it("kind='routes'：FeatureCollection 12 条线路 + byType 三类", () => {
    const r = getXinchangBus("routes") as any;
    expect(r.type).toBe("FeatureCollection");
    expect(r.features).toHaveLength(12);
    expect(r.stats.byType).toHaveLength(3);
    expect(r.stats.routeCount).toBe(12);
  });

  it("kind='stations'：48 站 + top20 + 流量分档", () => {
    const r = getXinchangBus("stations") as any;
    expect(r.geojson.features).toHaveLength(48);
    expect(r.top20).toHaveLength(20);
    expect(r.stats.stationCount).toBe(48);
    expect(r.stats.highCount + r.stats.mediumCount + r.stats.lowCount).toBe(48);
  });

  it("kind='od'：10 对 OD + 统计", () => {
    const r = getXinchangBus("od") as any;
    expect(r.stats.totalPairs).toBe(10);
    expect(r.geojson.features).toHaveLength(10);
  });

  it("默认/其它 kind（all 与 stats 等）：汇总 stats 分支", () => {
    const r = getXinchangBus() as any;
    expect(r.status).toBe("demo");
    expect(r.source).toBe("xinchang-bus-demo");
    expect(r.stats.odPairs).toBe(10);
    expect(r.stats.byType).toHaveLength(3);
    expect(r.stats.lengthDist).toHaveLength(4);
    expect(getXinchangBus("stats")).toEqual(getXinchangBus());
  });
});
