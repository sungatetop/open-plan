/**
 * 场景化分析模板（G5-v1 OD 通勤分析）回归：带宽分级纯函数 + 模板端到端 + flag/工具注册断言。
 * 运行：node scripts/map-template-test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.OAW_MAP_TEMPLATES = "1";

const { bandOdFlows, runOdCommuterTemplate, OD_TEMPLATE_ID } = await import("../server/map-template.mjs");
const { loadSource } = await import("../server/map-visualization.mjs");
await import("../server/traffic-sources.mjs");

const passed = [];
async function check(name, fn) {
  try { await fn(); passed.push(name); console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const mkLine = (o, d, flow, names = {}) => ({
  type: "Feature",
  properties: { flow, ...names },
  geometry: { type: "LineString", coordinates: [o, d] },
});

console.log("▶ bandOdFlows 带宽分级（纯函数）");
await check("空输入 → 全零结构", async () => {
  const r = bandOdFlows([]);
  assert.equal(r.count, 0);
  assert.deepEqual(r.levels, []);
  assert.deepEqual(r.edges, []);
});
await check("分位数边界与分级计数自洽", async () => {
  const flows = [10, 20, 30, 40, 50, 60, 70, 80];
  const features = flows.map((flow, i) => mkLine([120, 29 + i * 0.01], [121, 30], flow));
  const r = bandOdFlows(features, { bands: 4 });
  assert.equal(r.count, 8);
  assert.equal(r.levels.length, 4);
  assert.equal(r.levels.reduce((s, l) => s + l.count, 0), 8, "各级计数之和 = 总数");
  assert.equal(r.edges.length, 3);
  assert.ok(r.edges.every((e, i) => i === 0 || e >= r.edges[i - 1]), "分割点单调不减");
  assert.equal(r.levels[0].from, 10);
  assert.equal(r.levels[3].to, null, "最高级无上限");
});
await check("TOP 流向按流量降序且带可读标签", async () => {
  const features = [
    mkLine([120, 29], [119.6, 29.1], 50, { oname: "义乌", dname: "金华" }),
    mkLine([120, 29], [120.2, 30.3], 300, { oname: "义乌", dname: "杭州" }),
    mkLine([120, 29], [121, 29.5], 120, { oname: "义乌", dname: "绍兴" }),
  ];
  const r = bandOdFlows(features, { top: 2 });
  assert.equal(r.topFlows.length, 2);
  assert.equal(r.topFlows[0].label, "义乌 → 杭州");
  assert.equal(r.topFlows[0].flow, 300);
  assert.equal(r.topFlows[1].flow, 120);
});
await check("无名流向回退坐标标签", async () => {
  const r = bandOdFlows([mkLine([120.05, 29.05], [121, 30], 9)], {});
  assert.match(r.topFlows[0].label, /^120\.050,29\.050 → 121\.000,30\.000$/);
});
await check("bands 参数被钳制到 2-6", async () => {
  const features = Array.from({ length: 12 }, (_, i) => mkLine([120, 29], [121, 30], i + 1));
  assert.equal(bandOdFlows(features, { bands: 99 }).levels.length, 6);
  assert.equal(bandOdFlows(features, { bands: 0 }).levels.length, 2);
});
await check("非 LineString 要素被忽略", async () => {
  const r = bandOdFlows([
    { type: "Feature", properties: { flow: 5 }, geometry: { type: "Point", coordinates: [120, 29] } },
    mkLine([120, 29], [121, 30], 7),
  ]);
  assert.equal(r.count, 1);
});

console.log("▶ runOdCommuterTemplate 端到端");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-g5-"));
await check("OD CSV → 分级 + TOP + Word 报告落盘", async () => {
  const csv = [
    "oname,olng,olat,dname,dlng,dlat,flow",
    "义乌,120.07,29.31,金华,119.65,29.08,300",
    "义乌,120.07,29.31,杭州,120.16,30.29,520",
    "义乌,120.07,29.31,绍兴,120.58,30.05,180",
    "杭州,120.16,30.29,宁波,121.55,29.87,410",
    "金华,119.65,29.08,温州,120.70,28.00,90",
  ].join("\n");
  fs.writeFileSync(path.join(tmp, "od.csv"), csv);
  const result = await runOdCommuterTemplate({ workspace: tmp, path: "od.csv", project: "zhejiang-map" });
  assert.equal(result.template, OD_TEMPLATE_ID);
  assert.equal(result.bands.count, 5);
  assert.equal(result.bands.topFlows[0].label, "义乌 → 杭州");
  assert.ok(fs.existsSync(result.report.file), "报告 docx 应落盘");
  assert.match(result.report.fileName, /^OD通勤分析-od-/);
  // 报告内容应包含标题与章节（docx zip 内 text 断言）
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(fs.readFileSync(result.report.file));
  const docXml = await zip.file("word/document.xml").async("string");
  assert.ok(docXml.includes("OD 通勤分析"), "报告应含标题");
  assert.ok(docXml.includes("带宽分级"), "报告应含带宽分级节");
  assert.ok(docXml.includes("义乌 → 杭州"), "报告应含 TOP 流向");
  assert.ok(docXml.includes("结论要点"), "报告应含结论节");
});
await check("缺 path / 点数据（非 OD）→ 可读错误", async () => {
  await assert.rejects(() => runOdCommuterTemplate({ workspace: tmp }), /缺少 path/);
  fs.writeFileSync(path.join(tmp, "points.csv"), "name,lng,lat,flow\nA,120.1,29.3,10\nB,120.2,29.4,20\n");
  await assert.rejects(() => runOdCommuterTemplate({ workspace: tmp, path: "points.csv" }), /不是 OD 形状/);
});
await check("路径越界由适配器拒绝", async () => {
  await assert.rejects(() => runOdCommuterTemplate({ workspace: tmp, path: "../outside.csv" }), /工作区内|不存在/);
});
await check("无效工作区 → 明确报错", async () => {
  await assert.rejects(() => runOdCommuterTemplate({ workspace: path.join(tmp, "nope"), path: "od.csv" }), /不存在|无法识别/);
});

console.log("▶ flag 与工具注册（源码断言）");
await check("路由 / Agent 工具 / 运行开关三处口径一致", () => {
  const root = path.join(import.meta.dirname, "..");
  const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
  assert.match(read("server/index.mjs"), /app\.post\("\/api\/map\/template\/od-commuter"/);
  assert.match(read("server/index.mjs"), /RUNTIME_FLAGS\.mapTemplates/);
  assert.match(read("server/agent.mjs"), /name: "map_template"/);
  assert.match(read("server/agent.mjs"), /mapAnalyzeTool, mapTemplateTool, mapSaveAnalysisTool/);
  assert.match(read("server/agent.mjs"), /"map_analyze", "map_template", "map_save_analysis"/);
  assert.match(read("server/feature-flags.mjs"), /mapTemplates: readFlag\("OAW_MAP_TEMPLATES"\)/);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(process.exitCode ? "地图模板回归：存在失败用例" : `地图模板回归：通过（${passed.length} 项）`);
