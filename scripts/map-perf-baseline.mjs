#!/usr/bin/env node
/**
 * 地图性能基线（GIS G12，评审 A7 修正口径：无 CI，先做本地回归脚本）
 *
 * 度量对象：服务端瓦片索引（geojson-vt）对 ≥5 万要素图层的构建与切片耗时 + 内存增量。
 * 做法（确定性，无磁盘写入、不触碰真实项目）：
 *   1. 生成 50 000 个合成点要素（可复现 PRNG）；
 *   2. 按 tiler.mjs 同参构建 geojson-vt 索引并计时；
 *   3. 遍历 z5–z13 瓦片树计数并计时（不落盘）；
 *   4. 断言总耗时在预算内，输出一行 PERF-BASELINE JSON（未来 CI 直接采集）。
 *
 * 运行：node scripts/map-perf-baseline.mjs（或 npm run test:map-perf）
 * 退出码：0 = 基线通过；1 = 超预算（性能回归）。
 */
import geojsonvt from "geojson-vt";

const FEATURE_COUNT = Number(process.env.OAW_PERF_FEATURES || 50000);
const BUDGET_MS = Number(process.env.OAW_PERF_BUDGET_MS || 8000);

// 可复现伪随机（mulberry32）——基线数据必须确定性，否则数字不可比。
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 生成 5 万个点要素（浙江范围 118–123E / 27–31.5N）。 */
function generatePoints(count) {
  const rand = mulberry32(20260101);
  const features = new Array(count);
  for (let i = 0; i < count; i += 1) {
    features[i] = {
      type: "Feature",
      properties: { id: i, flow: Math.round(rand() * 1000), kind: rand() > 0.5 ? "a" : "b" },
      geometry: { type: "Point", coordinates: [118 + rand() * 5, 27 + rand() * 4.5] },
    };
  }
  return { type: "FeatureCollection", features };
}

/** 与 tiler.mjs walk 同构的内存版瓦片树遍历（不写盘，只数非空瓦片）。 */
function countTilesInMemory(index, minz, maxz) {
  let tiles = 0;
  let points = 0;
  const walk = (z, x, y) => {
    let tile;
    try { tile = index.getTile(z, x, y); } catch { return; }
    if (!tile || !tile.features || !tile.features.length) return;
    if (z >= minz) { tiles += 1; points += tile.features.length; }
    if (z >= maxz) return;
    for (const [cx, cy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) walk(z + 1, x * 2 + cx, y * 2 + cy);
  };
  walk(0, 0, 0);
  return { tiles, points };
}

const memoryBefore = process.memoryUsage();
process.stdout.write(`生成 ${FEATURE_COUNT} 个点要素…\n`);
const t0 = Date.now();
const data = generatePoints(FEATURE_COUNT);
const genMs = Date.now() - t0;

process.stdout.write("构建 geojson-vt 索引（与 buildLayerTiles 同参）…\n");
const t1 = Date.now();
const index = new geojsonvt(data, {
  maxZoom: 13,
  tolerance: 0.00001,
  buffer: 64,
  indexMaxZoom: 13,
  indexMaxPoints: 1000000,
});
index.name = "perf-baseline";
const indexMs = Date.now() - t1;

process.stdout.write("遍历 z5–z13 瓦片树（内存，不落盘）…\n");
const t2 = Date.now();
const { tiles, points } = countTilesInMemory(index, 5, 13);
const walkMs = Date.now() - t2;

const memoryAfter = process.memoryUsage();
const heapDeltaMb = (memoryAfter.heapUsed - memoryBefore.heapUsed) / 1024 / 1024;
const rssDeltaMb = (memoryAfter.rss - memoryBefore.rss) / 1024 / 1024;
const totalMs = indexMs + walkMs;

const baseline = {
  features: FEATURE_COUNT,
  genMs,
  indexMs,
  walkMs,
  totalMs,
  budgetMs: BUDGET_MS,
  tiles,
  tilePoints: points,
  heapDeltaMb: Math.round(heapDeltaMb * 10) / 10,
  rssDeltaMb: Math.round(rssDeltaMb * 10) / 10,
  node: process.version,
  at: new Date().toISOString(),
};

console.log("\n▶ 结果");
console.log(`  索引构建：${indexMs}ms`);
console.log(`  瓦片遍历（z5–13，${tiles} 个非空瓦片）：${walkMs}ms`);
console.log(`  合计：${totalMs}ms（预算 ${BUDGET_MS}ms）`);
console.log(`  内存增量：heap ${baseline.heapDeltaMb}MB / rss ${baseline.rssDeltaMb}MB`);
console.log(`\nPERF-BASELINE ${JSON.stringify(baseline)}`);

if (totalMs > BUDGET_MS) {
  console.error(`\n✗ 超出预算：${totalMs}ms > ${BUDGET_MS}ms（瓦片索引性能回归，请排查）`);
  process.exit(1);
}
console.log(`\n地图性能基线：通过（5 万要素索引+切片 ≤ ${BUDGET_MS}ms）`);
