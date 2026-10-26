/**
 * S3-10 spatial-analysis 域对拍：legacy 物理加载 server/spatial-analysis.mjs vs
 * modern 静态 import TS backend/spatial-analysis。
 *
 * 覆盖：导出面 8；纯函数全量语义（bboxOf/bboxesIntersect/geometryAreaM2 精确梯形
 * 公式闭环/geometryLengthM/geometriesIntersect 边相交与包含退化/bufferGeometry 四
 * 形态/bboxClipGeometry 三形态）；analyzeGeoJSON 三类型分流 + 统计字段（stats 中
 * elapsedMs 为计时量，双侧归一后互等）。
 */
import { describe, it, expect, beforeAll } from "vitest";

type ModernSpatial = typeof import("../src/main/backend/spatial-analysis");

// legacy 侧经 any 载体调用：旧 .mjs 无类型标注，tsc 对解构默认值（clipBbox = null
// 等）推断出 null|undefined 的形参类型，直接传参会误报。
let legacy: any;
let modern: ModernSpatial;

beforeAll(async () => {
  legacy = await import("@legacy-server/spatial-analysis.mjs");
  modern = await import("../src/main/backend/spatial-analysis");
});

/** 计时量归一：stats.elapsedMs 双侧必不同，置 0 后 JSON 互等。 */
function normalize<T>(v: T): T {
  return JSON.parse(JSON.stringify(v, (_k, val) => (_k === "elapsedMs" ? 0 : val)));
}

describe("s3-spatial-analysis-parity 导出面", () => {
  it("导出面一致（8 项）", () => {
    expect(Object.keys(modern).sort()).toEqual(Object.keys(legacy).sort());
  });
});

describe("s3-spatial-analysis-parity 纯函数", () => {
  it("bboxOf：Point/LineString/Polygon/空坐标/undefined", () => {
    const cases: any[] = [
      { type: "Point", coordinates: [120, 30] },
      { type: "LineString", coordinates: [[0, 0], [10, 5], [3, -8]] },
      { type: "Polygon", coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] },
      { type: "Point", coordinates: [] },
      { type: "MultiPolygon", coordinates: [] },
      undefined,
    ];
    for (const g of cases) {
      expect(normalize(modern.bboxOf(g))).toEqual(normalize(legacy.bboxOf(g)));
    }
    expect(modern.bboxOf(cases[3])).toBeNull();
    expect(modern.bboxOf(undefined)).toBeNull();
  });

  it("bboxesIntersect：相交/边界贴齐/分离/null", () => {
    expect(modern.bboxesIntersect([0, 0, 1, 1], [1, 0, 2, 1])).toBe(true);
    expect(modern.bboxesIntersect([0, 0, 1, 1], [1.1, 0, 2, 1])).toBe(false);
    expect(modern.bboxesIntersect([0, 0, 10, 10], [2, 2, 3, 3])).toBe(true);
    expect(modern.bboxesIntersect(null, [0, 0, 1, 1])).toBe(false);
    for (const [a, b] of [[[0, 0, 1, 1], [1, 0, 2, 1]], [[0, 0, 1, 1], [2, 2, 3, 3]]] as const) {
      expect(modern.bboxesIntersect([...a], [...b])).toBe(legacy.bboxesIntersect([...a], [...b]));
    }
  });

  it("geometryAreaM2：矩形梯形公式精确闭环（1km²）+ 带洞 + 非面几何 0", () => {
    const lat = 30;
    const lngSpan = 1000 / (111_320 * Math.cos((lat * Math.PI) / 180));
    const latSpan = 1000 / 110_540;
    const square = {
      type: "Polygon",
      coordinates: [[
        [120 - lngSpan / 2, lat - latSpan / 2],
        [120 + lngSpan / 2, lat - latSpan / 2],
        [120 + lngSpan / 2, lat + latSpan / 2],
        [120 - lngSpan / 2, lat + latSpan / 2],
        [120 - lngSpan / 2, lat - latSpan / 2],
      ]],
    };
    const areaL = legacy.geometryAreaM2(square);
    const areaM = modern.geometryAreaM2(square);
    expect(areaM).toBe(areaL);
    expect(Math.abs(areaM - 1_000_000)).toBeLessThan(1e-6);
    // 带洞：外环 1km² - 内环（半边长 → 0.25km²）
    const withHole = {
      type: "Polygon",
      coordinates: [
        [...square.coordinates[0]!],
        [
          [120 - lngSpan / 4, lat - latSpan / 4],
          [120 + lngSpan / 4, lat - latSpan / 4],
          [120 + lngSpan / 4, lat + latSpan / 4],
          [120 - lngSpan / 4, lat + latSpan / 4],
          [120 - lngSpan / 4, lat - latSpan / 4],
        ],
      ],
    };
    expect(modern.geometryAreaM2(withHole)).toBe(legacy.geometryAreaM2(withHole));
    expect(Math.abs(modern.geometryAreaM2(withHole) - 750_000)).toBeLessThan(1e-6);
    expect(modern.geometryAreaM2({ type: "Point", coordinates: [120, 30] })).toBe(0);
    expect(modern.geometryAreaM2(undefined)).toBe(0);
  });

  it("geometryLengthM：LineString 精确 1km / MultiLineString 累加 / 非线 0", () => {
    const lat = 30;
    const dx = 1000 / (111_320 * Math.cos((lat * Math.PI) / 180));
    const line = { type: "LineString", coordinates: [[120, lat], [120 + dx, lat]] };
    expect(modern.geometryLengthM(line)).toBe(legacy.geometryLengthM(line));
    expect(Math.abs(modern.geometryLengthM(line) - 1000)).toBeLessThan(1e-6);
    const multi = { type: "MultiLineString", coordinates: [[[120, lat], [120 + dx, lat]], [[120, lat], [120 + dx, lat]]] };
    expect(modern.geometryLengthM(multi)).toBe(legacy.geometryLengthM(multi));
    expect(Math.abs(modern.geometryLengthM(multi) - 2000)).toBeLessThan(1e-6);
    expect(modern.geometryLengthM({ type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] })).toBe(0);
  });

  it("geometriesIntersect：边相交/包含退化/分离", () => {
    const a = { type: "Polygon", coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] };
    const cross = { type: "Polygon", coordinates: [[[8, 8], [12, 8], [12, 12], [8, 12], [8, 8]]] };
    const inside = { type: "Polygon", coordinates: [[[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]]] };
    const apart = { type: "Polygon", coordinates: [[[20, 20], [22, 20], [22, 22], [20, 22], [20, 20]]] };
    expect(modern.geometriesIntersect(a, cross)).toBe(true);
    expect(modern.geometriesIntersect(a, inside)).toBe(true);
    expect(modern.geometriesIntersect(a, apart)).toBe(false);
    for (const [x, y] of [[a, cross], [a, inside], [a, apart]] as const) {
      expect(modern.geometriesIntersect(x, y)).toBe(legacy.geometriesIntersect(x, y));
      expect(modern.geometriesIntersect(y, x)).toBe(legacy.geometriesIntersect(y, x));
    }
  });

  it("bufferGeometry：Point 圆 / MultiPoint / Polygon 环偏移 / LineString 胶囊 / 退化段", () => {
    const point = { type: "Point", coordinates: [120, 30] };
    const bufP = modern.bufferGeometry(point, 500) as any;
    expect(normalize(bufP)).toEqual(normalize(legacy.bufferGeometry(point, 500)));
    expect(bufP.type).toBe("Polygon");
    expect(bufP.coordinates[0]).toHaveLength(49);
    expect(bufP.coordinates[0]![0]).toEqual(bufP.coordinates[0]![48]);

    const multi = { type: "MultiPoint", coordinates: [[120, 30], [121, 31]] };
    expect(normalize(modern.bufferGeometry(multi, 200))).toEqual(normalize(legacy.bufferGeometry(multi, 200)));

    const poly = { type: "Polygon", coordinates: [[[120, 30], [120.01, 30], [120.01, 30.01], [120, 30.01], [120, 30]]] };
    const bufPoly = modern.bufferGeometry(poly, 300) as any;
    expect(normalize(bufPoly)).toEqual(normalize(legacy.bufferGeometry(poly, 300)));
    expect(bufPoly.type).toBe("Polygon");
    expect(modern.geometryAreaM2(bufPoly)).toBeGreaterThan(modern.geometryAreaM2(poly));

    const line = { type: "LineString", coordinates: [[120, 30], [120.02, 30], [120.02, 30.02]] };
    const bufLine = modern.bufferGeometry(line, 150) as any;
    expect(normalize(bufLine)).toEqual(normalize(legacy.bufferGeometry(line, 150)));
    expect(bufLine.type).toBe("MultiPolygon");
    expect(bufLine.coordinates).toHaveLength(2);
    // capSteps=max(8, floor(48/4))=12 → 两侧半圆 13+13 顶点 + 闭合 1 = 27
    expect(bufLine.coordinates[0]![0]).toHaveLength(27);

    // 退化段（零长度）跳过 + 空环
    const degenerate = { type: "LineString", coordinates: [[120, 30], [120, 30]] };
    expect(normalize(modern.bufferGeometry(degenerate, 100))).toEqual(normalize(legacy.bufferGeometry(degenerate, 100)));
    expect(modern.bufferGeometry({ type: "GeometryCollection", geometries: [] }, 100)).toBeNull();
  });

  it("bboxClipGeometry：多边形裁剪/完全在外/折线横穿/多段拼接", () => {
    const bbox = [100, 20, 110, 40];
    const poly = {
      type: "Polygon",
      coordinates: [[[105, 15], [115, 15], [115, 25], [105, 25], [105, 15]]],
    };
    const clipped = modern.bboxClipGeometry(poly, bbox) as any;
    expect(normalize(clipped)).toEqual(normalize(legacy.bboxClipGeometry(poly, bbox)));
    expect(clipped.type).toBe("Polygon");
    for (const [x, y] of clipped.coordinates[0]!) {
      expect(x).toBeGreaterThanOrEqual(100);
      expect(x).toBeLessThanOrEqual(110);
      expect(y).toBeGreaterThanOrEqual(20);
      expect(y).toBeLessThanOrEqual(40);
    }

    const outside = { type: "Polygon", coordinates: [[[120, 50], [130, 50], [130, 60], [120, 60], [120, 50]]] };
    expect(modern.bboxClipGeometry(outside, bbox)).toBeNull();

    const crossing = { type: "LineString", coordinates: [[90, 30], [120, 30]] };
    const clippedLine = modern.bboxClipGeometry(crossing, bbox) as any;
    expect(normalize(clippedLine)).toEqual(normalize(legacy.bboxClipGeometry(crossing, bbox)));
    expect(clippedLine.type).toBe("LineString");

    // 折线折返 bbox 内部：三段裁剪片首尾连续（p2 终点与 p3 起点浮点相等）→ 单条 LineString 5 顶点
    const weaving = { type: "LineString", coordinates: [[95, 30], [105, 30], [105, 50], [105, 35], [95, 35]] };
    const woven = modern.bboxClipGeometry(weaving, bbox) as any;
    expect(normalize(woven)).toEqual(normalize(legacy.bboxClipGeometry(weaving, bbox)));
    expect(woven.type).toBe("LineString");
    expect(woven.coordinates).toEqual([[100, 30], [105, 30], [105, 40], [105, 35], [100, 35]]);

    expect(modern.bboxClipGeometry({ type: "Point", coordinates: [105, 30] }, bbox)).toBeNull();
  });
});

describe("s3-spatial-analysis-parity analyzeGeoJSON", () => {
  const pointFc = {
    type: "FeatureCollection",
    features: [
      { type: "Feature", properties: { name: "站点甲" }, geometry: { type: "Point", coordinates: [120, 30] } },
      { type: "Feature", properties: { name: "区乙" }, geometry: { type: "Polygon", coordinates: [[[120, 30], [120.01, 30], [120.01, 30.01], [120, 30.01], [120, 30]]] } },
      { type: "Feature", properties: { name: "空要素" }, geometry: null },
    ],
  };

  it("buffer：逐要素缓冲 + 统计 + properties 注入 bufferDistanceM", () => {
    const rL = legacy.analyzeGeoJSON({ type: "buffer", geojson: pointFc, distanceMeters: 500 });
    const rM = modern.analyzeGeoJSON({ type: "buffer", geojson: pointFc, distanceMeters: 500 });
    expect(normalize(rM)).toEqual(normalize(rL));
    expect(rM.stats.count).toBe(2);
    expect(rM.stats.inputCount).toBe(3);
    expect(rM.stats.planarApprox).toBe(true);
    expect((rM.geojson.features[0] as any).properties.bufferDistanceM).toBe(500);
  });

  it("bbox_clip：省略 clipBbox 逐要素自裁；Point 无裁剪算子被跳过", () => {
    const rL = legacy.analyzeGeoJSON({ type: "bbox_clip", geojson: pointFc });
    const rM = modern.analyzeGeoJSON({ type: "bbox_clip", geojson: pointFc });
    expect(normalize(rM)).toEqual(normalize(rL));
    expect(rM.stats.count).toBe(1); // Point/空 geometry 均无算子命中，仅 Polygon 自裁保留
    expect((rM.geojson.features[0] as any).geometry.type).toBe("Polygon");
  });

  it("spatial_filter：intersects / within / 空 refs 提示", () => {
    const refs = {
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[119.5, 29.5], [120.5, 29.5], [120.5, 30.5], [119.5, 30.5], [119.5, 29.5]]] } },
      ],
    };
    for (const mode of ["intersects", "within"] as const) {
      const rL = legacy.analyzeGeoJSON({ type: "spatial_filter", geojson: pointFc, clipGeojson: refs, mode });
      const rM = modern.analyzeGeoJSON({ type: "spatial_filter", geojson: pointFc, clipGeojson: refs, mode });
      expect(normalize(rM)).toEqual(normalize(rL));
      expect(rM.stats.count).toBe(2);
    }
    const empty = legacy.analyzeGeoJSON({ type: "spatial_filter", geojson: pointFc, clipGeojson: { type: "FeatureCollection", features: [] } });
    const emptyM = modern.analyzeGeoJSON({ type: "spatial_filter", geojson: pointFc, clipGeojson: { type: "FeatureCollection", features: [] } });
    expect(normalize(emptyM)).toEqual(normalize(empty));
    expect(emptyM.stats).toMatchObject({ count: 0, note: "无裁剪参照要素" });
  });

  it("未知类型抛错文案逐字", () => {
    const msg = "未知的空间分析类型：frobnicate";
    expect(() => legacy.analyzeGeoJSON({ type: "frobnicate", geojson: pointFc } as any)).toThrow(msg);
    expect(() => modern.analyzeGeoJSON({ type: "frobnicate", geojson: pointFc } as any)).toThrow(msg);
  });
});
