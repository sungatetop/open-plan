/**
 * B2-11 map-analysis 域对拍：createDemoAnalysis（heatmap 默认 / od / isochrone 全分支 +
 * count·region 参数钳制与回退边界）/ getCambodiaOD（minFlow 过滤与类型归一）/
 * getXinchangBus（routes / stations / od / stats 全 kind）。
 *
 * 零依赖纯函数域 → 免 stubEnv 简化形态（B2-5/B2-10 先例）：旧侧 pathToFileURL 物理路径
 * 动态 import + 新侧静态 import。输出确定性（伪随机全部来自索引运算，无时间/随机源），
 * vitest toEqual 结构比较（键序无关）逐字段深比较。
 */
import { describe, expect, it, beforeAll } from "vitest";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDemoAnalysis, getCambodiaOD, getXinchangBus } from "../src/main/backend/map-analysis";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// tests → electron → 项目根（旧 server 锚定真实仓库）
const PROJECT_ROOT = path.resolve(HERE, "../..");

type Legacy = typeof import("../src/main/backend/map-analysis");
let legacy: Legacy;

beforeAll(async () => {
  legacy = (await import(pathToFileURL(path.join(PROJECT_ROOT, "server", "map-analysis.mjs")).href)) as Legacy;
});

describe("B2-11 对拍：createDemoAnalysis", () => {
  it("默认参数（无参与空对象）：heatmap 形态 + source=demo + 36 点", () => {
    expect(createDemoAnalysis()).toEqual(legacy.createDemoAnalysis());
    expect(createDemoAnalysis({})).toEqual(legacy.createDemoAnalysis({}));
    const r = createDemoAnalysis() as any;
    expect(r.action).toBe("show_analysis");
    expect(r.analysis).toBe("heatmap");
    expect(r.source).toBe("demo");
    expect(r.geojson.features).toHaveLength(36);
    expect(r.stats).toEqual({ demo: true, region: "义乌市", count: 36 });
  });

  it("heatmap 指定 region：title/stats/点位命名跟随 region", () => {
    expect(createDemoAnalysis({ region: "杭州市" })).toEqual(legacy.createDemoAnalysis({ region: "杭州市" }));
    const r = createDemoAnalysis({ region: "杭州市" }) as any;
    expect(r.title).toBe("杭州市点位热力图");
    expect(r.geojson.features[0].properties.name).toContain("杭州市演示点");
  });

  it("heatmap 未知 region：centerOf 回退义乌市（点位坐标与默认一致）", () => {
    expect(createDemoAnalysis({ region: "不存在的市" })).toEqual(legacy.createDemoAnalysis({ region: "不存在的市" }));
    const fallback = createDemoAnalysis() as any;
    const unknown = createDemoAnalysis({ region: "不存在的市" }) as any;
    expect(unknown.geojson.features.map((f: any) => f.geometry.coordinates))
      .toEqual(fallback.geojson.features.map((f: any) => f.geometry.coordinates));
  });

  it("heatmap count 钳制：5→12 / 200→120 / 0→36 / NaN→36 / '50'→50", () => {
    for (const count of [5, 200, 0, NaN, "50"]) {
      const ts = createDemoAnalysis({ count } as any);
      const js = legacy.createDemoAnalysis({ count } as any);
      expect((ts as any).geojson.features.length, `count=${String(count)}`).toBe((js as any).geojson.features.length);
      expect(ts).toEqual(js);
    }
    expect((createDemoAnalysis({ count: 5 }) as any).geojson.features).toHaveLength(12);
    expect((createDemoAnalysis({ count: 200 }) as any).geojson.features).toHaveLength(120);
    expect((createDemoAnalysis({ count: 0 }) as any).stats.count).toBe(36);
  });

  it("od 默认 region（义乌市）：单目标台州市 + OD 线与统计", () => {
    expect(createDemoAnalysis({ analysis: "od" })).toEqual(legacy.createDemoAnalysis({ analysis: "od" }));
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
      const ts = createDemoAnalysis({ analysis: "od", region });
      const js = legacy.createDemoAnalysis({ analysis: "od", region });
      expect(ts).toEqual(js);
      expect((ts as any).stats.targetCount, `region=${region}`).toBe(region === "玉环市" ? 8 : 9);
      expect((ts as any).lines.features).toHaveLength((ts as any).stats.targetCount);
    }
  });

  it("od region=台州市：目标不含台州市自身", () => {
    const r = createDemoAnalysis({ analysis: "od", region: "台州市" }) as any;
    const dests = r.lines.features.map((f: any) => f.properties.destination);
    expect(dests).not.toContain("台州市");
    expect(r.geojson.features[0].properties.role).toBe("origin");
  });

  it("isochrone：3 圈层 + ring 闭合 + 颜色族", () => {
    expect(createDemoAnalysis({ analysis: "isochrone" })).toEqual(legacy.createDemoAnalysis({ analysis: "isochrone" }));
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

describe("B2-11 对拍：getCambodiaOD", () => {
  it("默认 minFlow=0：全量 demo 行 + stats/topOrigins/topDestinations/topPairs", () => {
    expect(getCambodiaOD()).toEqual(legacy.getCambodiaOD());
    expect(getCambodiaOD({})).toEqual(legacy.getCambodiaOD({}));
    const r = getCambodiaOD() as any;
    expect(r.error).toBeNull();
    expect(r.source).toBe("siem-reap-od-demo.csv");
    expect(r.status).toBe("demo");
    expect(r.topOrigins.length).toBeLessThanOrEqual(8);
    expect(r.topPairs.length).toBeLessThanOrEqual(8);
    expect(r.points.features).toHaveLength(r.stats.records);
  });

  it("minFlow 过滤：300 过滤低流量行，stats.minFlow=300", () => {
    expect(getCambodiaOD({ minFlow: 300 })).toEqual(legacy.getCambodiaOD({ minFlow: 300 }));
    const all = getCambodiaOD() as any;
    const filtered = getCambodiaOD({ minFlow: 300 }) as any;
    expect(filtered.stats.records).toBeLessThan(all.stats.records);
    expect(filtered.stats.records).toBeGreaterThan(0);
    expect(filtered.stats.minFlow).toBe(300);
  });

  it("minFlow 边界：负值钳 0（与默认一致）/ '150' 字符串 Number 归一", () => {
    expect(getCambodiaOD({ minFlow: -5 })).toEqual(getCambodiaOD());
    expect(getCambodiaOD({ minFlow: -5 })).toEqual(legacy.getCambodiaOD({ minFlow: -5 }));
    expect(getCambodiaOD({ minFlow: "150" } as any)).toEqual(legacy.getCambodiaOD({ minFlow: "150" } as any));
    expect((getCambodiaOD({ minFlow: "150" } as any) as any).stats.minFlow).toBe(150);
  });
});

describe("B2-11 对拍：getXinchangBus", () => {
  it("kind='routes'：FeatureCollection 12 条线路 + byType 三类", () => {
    expect(getXinchangBus("routes")).toEqual(legacy.getXinchangBus("routes"));
    const r = getXinchangBus("routes") as any;
    expect(r.type).toBe("FeatureCollection");
    expect(r.features).toHaveLength(12);
    expect(r.stats.byType).toHaveLength(3);
    expect(r.stats.routeCount).toBe(12);
  });

  it("kind='stations'：48 站 + top20 + 流量分档", () => {
    expect(getXinchangBus("stations")).toEqual(legacy.getXinchangBus("stations"));
    const r = getXinchangBus("stations") as any;
    expect(r.geojson.features).toHaveLength(48);
    expect(r.top20).toHaveLength(20);
    expect(r.stats.stationCount).toBe(48);
    expect(r.stats.highCount + r.stats.mediumCount + r.stats.lowCount).toBe(48);
  });

  it("kind='od'：10 对 OD + 统计", () => {
    expect(getXinchangBus("od")).toEqual(legacy.getXinchangBus("od"));
    const r = getXinchangBus("od") as any;
    expect(r.stats.totalPairs).toBe(10);
    expect(r.geojson.features).toHaveLength(10);
  });

  it("默认/其它 kind（all 与 stats 等）：汇总 stats 分支", () => {
    expect(getXinchangBus()).toEqual(legacy.getXinchangBus());
    expect(getXinchangBus("stats")).toEqual(legacy.getXinchangBus("stats"));
    const r = getXinchangBus() as any;
    expect(r.status).toBe("demo");
    expect(r.source).toBe("xinchang-bus-demo");
    expect(r.stats.odPairs).toBe(10);
    expect(r.stats.byType).toHaveLength(3);
    expect(r.stats.lengthDist).toHaveLength(4);
  });
});
