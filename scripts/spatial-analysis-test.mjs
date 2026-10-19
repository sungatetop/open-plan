/**
 * 空间分析（G1）回归：几何口径、布尔判定、裁剪正确性、性能预算（1 万要素缓冲 ≤2s）。
 * 运行：node scripts/spatial-analysis-test.mjs
 */
import assert from "node:assert/strict";
import { analyzeGeoJSON, bufferGeometry, geometryAreaM2, geometriesIntersect, bboxClipGeometry, bboxOf } from "../server/spatial-analysis.mjs";

const pt = (lng, lat) => ({ type: "Point", coordinates: [lng, lat] });
const square = (x0, y0, x1, y1) => ({ type: "Polygon", coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] });

// 1. 点缓冲：圆环顶点数与半径口径
{
  const buffered = bufferGeometry(pt(120, 30), 500, 48);
  assert.equal(buffered.type, "Polygon");
  assert.equal(buffered.coordinates[0].length, 49);
  const bbox = bboxOf(buffered);
  const spanLat = (bbox[3] - bbox[1]) * 110_540;
  assert.ok(Math.abs(spanLat - 1000) < 1000 * 0.02, `点缓冲南北跨度应≈1000m，实测 ${spanLat.toFixed(1)}m`);
  console.log("  ✓ 点缓冲半径口径（48 段圆环，跨度误差 <2%）");
}

// 2. 折线缓冲：逐段胶囊
{
  const line = { type: "LineString", coordinates: [[120, 30], [120.01, 30], [120.02, 30.01]] };
  const buffered = bufferGeometry(line, 300);
  assert.equal(buffered.type, "MultiPolygon");
  assert.equal(buffered.coordinates.length, 2, "两段折线应产生 2 个胶囊");
  console.log("  ✓ 折线缓冲逐段胶囊口径");
}

// 3. 布尔相交
{
  assert.equal(geometriesIntersect(square(0, 0, 2, 2), square(1, 1, 3, 3)), true);
  assert.equal(geometriesIntersect(square(0, 0, 1, 1), square(2, 2, 3, 3)), false);
  assert.equal(geometriesIntersect(square(0, 0, 10, 10), pt(5, 5)), true, "点在面内应判相交");
  assert.equal(geometriesIntersect(square(0, 0, 10, 10), pt(50, 50)), false);
  console.log("  ✓ 布尔相交判定（重叠/分离/包含）");
}

// 4. bbox 裁剪：输出必须整体落在 bbox 内且面积缩小
{
  const clipped = bboxClipGeometry(square(0, 0, 10, 10), [2, 3, 6, 8]);
  assert.equal(clipped.type, "Polygon");
  const bbox = bboxOf(clipped);
  assert.deepEqual(bbox.map((v) => Math.round(v * 1e6) / 1e6), [2, 3, 6, 8]);
  const original = geometryAreaM2(square(0, 0, 10, 10));
  const clippedArea = geometryAreaM2(clipped);
  assert.ok(clippedArea > 0 && clippedArea < original, "裁剪面积应小于原面积");
  console.log(`  ✓ bbox 裁剪（输出 ${clippedArea.toFixed(0)}m² < 原 ${original.toFixed(0)}m²，bbox 精确）`);
}

// 5. spatial_filter：within 只保留包含要素
{
  const fc = {
    type: "FeatureCollection",
    features: [
      { type: "Feature", properties: { name: "inside" }, geometry: pt(1, 1) },
      { type: "Feature", properties: { name: "outside" }, geometry: pt(9, 9) },
    ],
  };
  const clip = { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: square(0, 0, 5, 5) }] };
  const result = analyzeGeoJSON({ type: "spatial_filter", geojson: fc, clipGeojson: clip, mode: "within" });
  assert.equal(result.stats.count, 1);
  assert.equal(result.geojson.features[0].properties.name, "inside");
  console.log("  ✓ spatial_filter within 语义");
}

// 6. 性能预算：1 万点缓冲 ≤2s
{
  const features = [];
  for (let i = 0; i < 10_000; i += 1) {
    features.push({ type: "Feature", properties: { id: i }, geometry: pt(120 + (i % 100) * 0.001, 29 + Math.floor(i / 100) * 0.001) });
  }
  const startedAt = Date.now();
  const result = analyzeGeoJSON({ type: "buffer", geojson: { type: "FeatureCollection", features }, distanceMeters: 500 });
  const elapsed = Date.now() - startedAt;
  assert.equal(result.stats.count, 10_000);
  assert.ok(elapsed <= 2000, `1 万点缓冲应 ≤2s，实测 ${elapsed}ms`);
  console.log(`  ✓ 性能预算：1 万点缓冲 ${elapsed}ms（≤2000ms）`);
}

console.log("空间分析回归：通过");
