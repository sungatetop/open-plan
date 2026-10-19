/**
 * 外部数据源适配器（G2）回归：live-traffic-api（HTTP 端点）与 sql-database（node:sqlite 只读）。
 * 运行：node scripts/datasource-adapter-test.mjs
 *
 * live-traffic-api 用本地 http.createServer 起真实端点（无需外网）；
 * sql-database 用 node:sqlite 造临时库（零新增依赖）。
 */
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 先开关再 import（适配器注册发生在模块加载时；flag 关闭则不注册）。
process.env.OAW_DATA_ADAPTERS = "1";

const passed = [];
async function check(name, fn) {
  try { await fn(); passed.push(name); console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

// ---------- 测试夹具：临时工作区 + 临时 SQLite 库 ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-g2-"));
fs.writeFileSync(path.join(tmp, "说明.txt"), "测试工作区");

const POINTS_ROWS = [
  { name: "断面A", lng: 120.1, lat: 29.3, volume: 120 },
  { name: "断面B", lng: 120.2, lat: 29.4, volume: 80 },
  { name: "坏行", lng: 999, lat: 29.5, volume: 5 }, // 越界坐标应被丢弃
];
const OD_ROWS = [
  { oname: "义乌", olng: 120.07, olat: 29.31, dname: "金华", dlng: 119.65, dlat: 29.08, flow: 300 },
  { oname: "义乌", olng: 120.07, olat: 29.31, dname: "杭州", dlng: 120.16, dlat: 30.29, flow: 500 },
];

let makeSqlite = async () => { throw new Error("node:sqlite 不可用"); };
try {
  const { DatabaseSync } = await import("node:sqlite");
  makeSqlite = async () => {
    const dbFile = path.join(tmp, "test.db");
    if (fs.existsSync(dbFile)) fs.rmSync(dbFile);
    const db = new DatabaseSync(dbFile);
    db.exec("CREATE TABLE points (name TEXT, lng REAL, lat REAL, volume INTEGER)");
    db.exec("CREATE TABLE od (oname TEXT, olng REAL, olat REAL, dname TEXT, dlng REAL, dlat REAL, flow INTEGER)");
    for (const r of POINTS_ROWS) db.prepare("INSERT INTO points VALUES (?, ?, ?, ?)").run(r.name, r.lng, r.lat, r.volume);
    for (const r of OD_ROWS) db.prepare("INSERT INTO od VALUES (?, ?, ?, ?, ?, ?, ?)").run(r.oname, r.olng, r.olat, r.dname, r.dlng, r.dlat, r.flow);
    db.close();
    return dbFile;
  };
} catch { /* Node < 22.5：SQL 用例将断言可读降级错误 */ }

// ---------- 测试夹具：本地 HTTP 端点 ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/points") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(POINTS_ROWS));
  } else if (url.pathname === "/wrapped") {
    res.end(JSON.stringify({ code: 0, data: OD_ROWS }));
  } else if (url.pathname === "/geojson") {
    res.end(JSON.stringify({
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: { name: "x", volume: 3 }, geometry: { type: "Point", coordinates: [120.1, 29.3] } }],
    }));
  } else if (url.pathname === "/bad-json") {
    res.end("not-json{");
  } else if (url.pathname === "/wrong-shape") {
    res.end(JSON.stringify({ hello: "world" }));
  } else if (url.pathname === "/slow") {
    setTimeout(() => { res.end("[]"); }, 15000);
  } else if (url.pathname === "/echo") {
    // 把收到的 region 参数回显到行数据里，验证"附加查询参数"真的拼到了 URL。
    res.end(JSON.stringify([{ name: url.searchParams.get("region"), lng: 120.1, lat: 29.3 }]));
  } else {
    res.statusCode = 404;
    res.end("{}");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

// flag 开启下导入（注册 live-traffic-api / sql-database）
const { loadSource, listSources } = await import("../server/map-visualization.mjs");
await import("../server/datasource-adapter-ext.mjs");

console.log("▶ 注册与发现");
await check("flag 开启时两个适配器出现在清单", async () => {
  const ids = listSources().map((s) => s.id);
  assert.ok(ids.includes("live-traffic-api"), `live-traffic-api 缺失（实际：${ids.join(",")}）`);
  assert.ok(ids.includes("sql-database"), `sql-database 缺失（实际：${ids.join(",")}）`);
});

console.log("▶ live-traffic-api");
await check("裸行数组 → 点描述符（越界坐标剔除）", async () => {
  const d = await loadSource("live-traffic-api", { url: `${base}/points` });
  assert.ok(!d.error, d.error);
  assert.equal(d.kind, "points");
  assert.equal(d.geojson.features.length, 2);
  assert.equal(d.stats.skipped, 1);
  assert.ok(!d.error);
});
await check("{data:[...]} 包装 → OD 流向描述符", async () => {
  const d = await loadSource("live-traffic-api", { url: `${base}/wrapped` });
  assert.ok(!d.error, d.error);
  assert.equal(d.kind, "flow");
  assert.equal(d.lines.features.length, 2);
});
await check("GeoJSON FeatureCollection 端点直通", async () => {
  const d = await loadSource("live-traffic-api", { url: `${base}/geojson` });
  assert.ok(!d.error, d.error);
  assert.equal(d.geojson.features.length, 1);
  assert.equal(d.geojson.features[0].geometry.type, "Point");
});
await check("附加查询参数拼接到 URL", async () => {
  const d = await loadSource("live-traffic-api", { url: `${base}/echo`, params: { region: "zj" } });
  assert.ok(!d.error, d.error);
  assert.equal(d.geojson.features[0].properties.name, "zj");
});
await check("非 JSON / 形状不符 / 404 / 缺 url → 可读错误", async () => {
  assert.match((await loadSource("live-traffic-api", { url: `${base}/bad-json` })).error, /不是合法 JSON/);
  assert.match((await loadSource("live-traffic-api", { url: `${base}/wrong-shape` })).error, /没有行数组/);
  assert.match((await loadSource("live-traffic-api", { url: `${base}/missing` })).error, /404/);
  assert.match((await loadSource("live-traffic-api", {})).error, /缺少 url/);
});
await check("file:// 与非 http 协议拒绝", async () => {
  assert.match((await loadSource("live-traffic-api", { url: "file:///c:/windows/win.ini" })).error, /http\/https/);
});
await check("超时（10s）有明确报错", async () => {
  const d = await loadSource("live-traffic-api", { url: `${base}/slow` });
  assert.match(d.error, /超时/);
}, 20000);

console.log("▶ sql-database");
await check("SELECT 点表 → 点描述符", async () => {
  const dbFile = await makeSqlite();
  const d = await loadSource("sql-database", { workspace: tmp, db: "test.db", sql: "SELECT name, lng, lat, volume FROM points" });
  assert.ok(!d.error, d.error);
  assert.equal(d.kind, "points");
  assert.equal(d.geojson.features.length, 2);
  assert.equal(d.stats.skipped, 1);
});
await check("WITH/SELECT OD 表 → 流向描述符", async () => {
  const dbFile = await makeSqlite();
  const d = await loadSource("sql-database", { workspace: tmp, db: dbFile, sql: "SELECT * FROM od" });
  assert.ok(!d.error, d.error);
  assert.equal(d.kind, "flow");
  assert.equal(d.lines.features.length, 2);
  assert.equal(d.geojson.features.length, 2);
});
await check("INSERT / UPDATE / PRAGMA / 多语句全部拒绝", async () => {
  const dbFile = await makeSqlite();
  for (const sql of [
    "INSERT INTO points VALUES ('x',1,2,3)",
    "UPDATE points SET volume = 0",
    "DROP TABLE points",
    "PRAGMA journal_mode = WAL",
    "SELECT 1; DROP TABLE points",
    "ATTACH DATABASE 'x.db' AS x",
  ]) {
    const d = await loadSource("sql-database", { workspace: tmp, db: dbFile, sql });
    assert.match(d.error, /只允许|拒绝|多条语句/, `应拒绝：${sql}`);
  }
});
await check("路径越界 / 文件不存在 / 非库扩展名拒绝", async () => {
  assert.match((await loadSource("sql-database", { workspace: tmp, db: "../outside.db", sql: "SELECT 1" })).error, /工作区内/);
  assert.match((await loadSource("sql-database", { workspace: tmp, db: "missing.db", sql: "SELECT 1" })).error, /不存在/);
  assert.match((await loadSource("sql-database", { workspace: tmp, db: "说明.txt", sql: "SELECT 1" })).error, /\.db|\.sqlite/);
});
await check("空结果 / 缺参数 → 可读错误", async () => {
  const dbFile = await makeSqlite();
  assert.match((await loadSource("sql-database", { workspace: tmp, db: dbFile, sql: "SELECT * FROM points WHERE 1=0" })).error, /查询结果为空/);
  assert.match((await loadSource("sql-database", { workspace: tmp, db: dbFile })).error, /缺少 sql/);
  assert.match((await loadSource("sql-database", { workspace: tmp, sql: "SELECT 1" })).error, /缺少 db/);
});

server.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log("▶ flag 基线");
await check("OAW_DATA_ADAPTERS 关闭时不注册（基线行为零变化）", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const code = `
const { listSources } = await import("./server/map-visualization.mjs");
await import("./server/traffic-sources.mjs");
const ids = listSources().map((s) => s.id);
if (ids.includes("live-traffic-api") || ids.includes("sql-database")) {
  throw new Error("flag 关闭时不应注册外部适配器：" + ids.join(","));
}
console.log("baseline-ok:" + ids.length);
`;
  const run = promisify(execFile);
  const { stdout } = await run(process.execPath, ["--input-type=module", "-e", code], {
    cwd: path.join(import.meta.dirname, ".."),
    env: { ...process.env, OAW_DATA_ADAPTERS: "" },
    timeout: 30000,
  });
  assert.match(stdout, /baseline-ok:\d+/);
});

console.log("▶ 参数透传（HTTP 路由与 Agent 工具）");
await check("/api/map/visual 与 map_analyze 都透传 url/db/sql", async () => {
  const read = (rel) => fs.readFileSync(path.join(import.meta.dirname, "..", rel), "utf8");
  const indexSrc = read("server/index.mjs");
  assert.match(indexSrc, /url: req\.query\.url/, "visual 路由应透传 url");
  assert.match(indexSrc, /db: req\.query\.db/, "visual 路由应透传 db");
  assert.match(indexSrc, /sql: req\.query\.sql/, "visual 路由应透传 sql");
  const agentSrc = read("server/agent.mjs");
  assert.match(agentSrc, /url: Type\.Optional\(Type\.String/, "map_analyze 应有 url 参数");
  assert.match(agentSrc, /db: Type\.Optional\(Type\.String/, "map_analyze 应有 db 参数");
  assert.match(agentSrc, /sql: params\.sql/, "loadSource 调用应透传 sql");
});

console.log(process.exitCode ? "数据源适配器回归：存在失败用例" : `数据源适配器回归：通过（${passed.length} 项）`);
