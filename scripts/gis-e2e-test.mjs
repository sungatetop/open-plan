/**
 * GIS 新能力端到端验收（G8 / G7 / G2 / G9 / G5-v1）——需要服务以新 flag 全开启动。
 *
 * 前置：
 *   1. 服务端启动时带：
 *      OAW_MAP_REPORT=1 OAW_MAP_EXPORT=1 OAW_DATA_ADAPTERS=1 OAW_AMAP_MCP_BRIDGE=1
 *      OAW_MAP_PACK=1 OAW_MAP_TEMPLATES=1 OAW_MAP_BOOKMARKS=1
 *   2. BASE 环境变量指向服务（默认 http://127.0.0.1:3099）。
 *
 * 覆盖（HTTP 层端到端，真实服务进程）：
 *   - /api/status 下发全部新 flag
 *   - /api/map/visual/sources 含两个新适配器
 *   - live-traffic-api / sql-database 经 /api/map/visual 出真实描述符（本地夹具端点/库）
 *   - /api/map/report 生成 docx
 *   - /api/map/template/od-commuter 全链路（CSV → 分级 → docx）
 *   - /api/map/project/export 产出 zip
 *   - /api/map/export/batch 走真实内置浏览器队列（1 项目×1 尺寸×PNG）
 *
 * 运行：node scripts/gis-e2e-test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const BASE = process.env.BASE || "http://127.0.0.1:3099";
const passed = [];
async function check(name, fn) {
  try { await fn(); passed.push(name); console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

async function api(pathname, options = {}) {
  const resp = await fetch(`${BASE}${pathname}`, options);
  const text = await resp.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: resp.status, body, headers: resp.headers };
}

const json = (payload) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });

// ---------- 夹具：临时工作区 + OD CSV + SQLite 库 + 本地 HTTP 数据端点 ----------
const workspace = path.join(os.tmpdir(), `oaw-gis-e2e-${Date.now()}`);
fs.mkdirSync(workspace, { recursive: true });
const OD_CSV = [
  "oname,olng,olat,dname,dlng,dlat,flow",
  "义乌,120.07,29.31,金华,119.65,29.08,300",
  "义乌,120.07,29.31,杭州,120.16,30.29,520",
  "义乌,120.07,29.31,绍兴,120.58,30.05,180",
  "杭州,120.16,30.29,宁波,121.55,29.87,410",
].join("\n");
fs.writeFileSync(path.join(workspace, "e2e-od.csv"), OD_CSV);

let dbFile = "";
try {
  const { DatabaseSync } = await import("node:sqlite");
  dbFile = path.join(workspace, "e2e.db");
  const db = new DatabaseSync(dbFile);
  db.exec("CREATE TABLE stations (name TEXT, lng REAL, lat REAL, volume INTEGER)");
  db.prepare("INSERT INTO stations VALUES ('A', 120.1, 29.3, 120)").run();
  db.prepare("INSERT INTO stations VALUES ('B', 120.2, 29.4, 80)").run();
  db.close();
} catch { /* Node<22.5 跳过 sql 用例 */ }

const fixtureServer = http.createServer((req, res) => {
  if (new URL(req.url, "http://x").pathname === "/points") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify([
      { name: "P1", lng: 120.05, lat: 29.25, volume: 42 },
      { name: "P2", lng: 120.35, lat: 29.55, volume: 77 },
    ]));
  } else { res.statusCode = 404; res.end("{}"); }
});
await new Promise((r) => fixtureServer.listen(0, "127.0.0.1", r));
const fixtureUrl = `http://127.0.0.1:${fixtureServer.address().port}/points`;

console.log(`▶ 服务与 flag（${BASE}）`);
await check("服务可达且全部新 flag 已下发", async () => {
  const { status, body } = await api("/api/status");
  assert.equal(status, 200, `status=${status}`);
  const flags = body.runtimeFlags || {};
  for (const key of ["mapReport", "mapExport", "dataAdapters", "amapMcpBridge", "mapPack", "mapTemplates", "mapBookmarks"]) {
    assert.equal(flags[key], true, `runtimeFlags.${key} 应为 true（实际 ${JSON.stringify(flags[key])}）`);
  }
});

console.log("▶ G2 外部数据适配器（经 /api/map/visual）");
await check("适配器出现在数据源清单", async () => {
  const { status, body } = await api("/api/map/visual/sources");
  assert.equal(status, 200);
  const ids = (body.sources || []).map((s) => s.id);
  assert.ok(ids.includes("live-traffic-api"), `live-traffic-api 缺失：${ids.join(",")}`);
  assert.ok(ids.includes("sql-database"), `sql-database 缺失：${ids.join(",")}`);
});
await check("live-traffic-api 拉本地端点 → 点描述符", async () => {
  const qs = new URLSearchParams({ dataset: "live-traffic-api", url: fixtureUrl, workspace });
  const { status, body } = await api(`/api/map/visual?${qs}`);
  assert.equal(status, 200, JSON.stringify(body).slice(0, 200));
  assert.ok(!body.descriptor?.error, body.descriptor?.error);
  assert.equal(body.descriptor.kind, "points");
  assert.equal(body.descriptor.geojson.features.length, 2);
});
await check("sql-database 只读查询 → 点描述符", async () => {
  if (!dbFile) { console.log("    （Node 不支持 node:sqlite，跳过）"); return; }
  const qs = new URLSearchParams({ dataset: "sql-database", db: "e2e.db", sql: "SELECT name, lng, lat, volume FROM stations", workspace });
  const { status, body } = await api(`/api/map/visual?${qs}`);
  assert.equal(status, 200, JSON.stringify(body).slice(0, 200));
  assert.ok(!body.descriptor?.error, body.descriptor?.error);
  assert.equal(body.descriptor.kind, "points");
  assert.equal(body.descriptor.geojson.features.length, 2);
});
await check("sql-database 写语句被拒（400，不落库）", async () => {
  if (!dbFile) return;
  const qs = new URLSearchParams({ dataset: "sql-database", db: "e2e.db", sql: "DELETE FROM stations", workspace });
  const { status, body } = await api(`/api/map/visual?${qs}`);
  // visual 路由把适配器的 error 描述符转为 HTTP 400（与 local-file 错误同一条路径）
  assert.equal(status, 400, `应拒绝写语句（实际 ${status}）`);
  assert.match(body?.error || body?.descriptor?.error || "", /只允许|拒绝/);
});

console.log("▶ G8 报告成文");
await check("/api/map/report → docx 落盘", async () => {
  const { status, body } = await api("/api/map/report", json({
    workspace,
    project: "zhejiang-map",
    title: "E2E 验收报告",
    sections: [{ heading: "摘要", bullets: ["端到端验收自动生成", "两项断言：落盘 + 内容"] }],
  }));
  assert.equal(status, 200, JSON.stringify(body).slice(0, 200));
  assert.ok(body.ok && fs.existsSync(body.file), `报告不存在：${body.file}`);
  assert.match(body.fileName, /^E2E 验收报告-.*\.docx$/);
});

console.log("▶ G5-v1 OD 通勤模板");
await check("/api/map/template/od-commuter → 分级 + docx", async () => {
  const { status, body } = await api("/api/map/template/od-commuter", json({
    workspace, path: "e2e-od.csv", project: "zhejiang-map", title: "E2E OD 通勤分析",
  }));
  assert.equal(status, 200, JSON.stringify(body).slice(0, 300));
  assert.equal(body.bands.count, 4);
  assert.equal(body.bands.topFlows[0].label, "义乌 → 杭州");
  assert.ok(fs.existsSync(body.report.file), "模板报告 docx 应落盘");
});
await check("缺 path → 400 可读错误", async () => {
  const { status, body } = await api("/api/map/template/od-commuter", json({ workspace }));
  assert.equal(status, 400);
  assert.match(body.error, /缺少 path/);
});

console.log("▶ G9 项目打包");
await check("/api/map/project/export → zip 下载", async () => {
  const { status, body, headers } = await api("/api/map/project/export?name=zhejiang-map");
  assert.equal(status, 200, JSON.stringify(body).slice(0, 200));
  assert.match(String(headers.get("content-type") || ""), /application\/zip/);
  const buffer = Buffer.from(body);
  assert.ok(buffer.length > 1000, `zip 太小：${buffer.length}`);
  assert.equal(buffer.readUInt32LE(0), 0x04034b50, "应为 zip 魔数");
});
await check("不存在的项目 → 404", async () => {
  const { status } = await api("/api/map/project/export?name=no-such-map-xyz");
  assert.equal(status, 404);
});

console.log("▶ G7 批量导出（真实内置浏览器队列）");
await check("提交 1 项目×1 尺寸×PNG → 队列完成且产物落盘", async () => {
  const started = await api("/api/map/export/batch", json({
    workspace, projects: ["zhejiang-map"], sizes: ["a4l"], formats: ["png"], title: "E2E 批量",
  }));
  assert.equal(started.status, 200, JSON.stringify(started.body).slice(0, 300));
  assert.equal(started.body.total, 1);
  const batchId = started.body.batchId;
  // 轮询上限 3 分钟（冷启动浏览器 + 首次渲染可能较慢）
  const deadline = Date.now() + 180000;
  let status = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const poll = await api(`/api/map/export/batch?id=${encodeURIComponent(batchId)}`);
    assert.equal(poll.status, 200);
    status = poll.body;
    if (status.status !== "running") break;
  }
  assert.ok(status, "未取到批次状态");
  assert.equal(status.status, "completed", `批次终态：${status.status}，明细：${JSON.stringify(status.summary?.results)}`);
  assert.equal(status.summary.done, 1);
  const file = status.summary.results[0].file;
  assert.ok(fs.existsSync(file), `产物不存在：${file}`);
  const buf = fs.readFileSync(file);
  assert.equal(buf.readUInt32BE(0), 0x89504e47, "产物应为 PNG");
  assert.ok(buf.length > 10000, `PNG 过小（${buf.length}B），疑似空白图`);
}, 240000);

fixtureServer.close();
console.log(`\n夹具工作区：${workspace}（保留供人工核验，可手动删除）`);
console.log(process.exitCode ? "GIS 端到端验收：存在失败用例" : `GIS 端到端验收：通过（${passed.length} 项）`);
