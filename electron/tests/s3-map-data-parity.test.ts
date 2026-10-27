/**
 * S3-14 三域对拍：legacy 物理加载 server/{migrate-legacy-data,project-pack,datasource-adapter-ext}.mjs
 * vs modern 静态 import TS backend/{同名}.ts。
 *
 * 锚定说明：
 *   - migrate-legacy-data：无导出面的独立 CLI（index.mjs 无消费面），导入即执行 main()
 *     输出报告 → 经 console.log 捕获对拍；PROJECT_DIR 两侧同为 d:\open-plan（读真实
 *     .规聚会话/.oaw 数据，只读）。人读报告逐行互等（生成时间除外）；--json 经
 *     process.argv 注入 + vi.resetModules 重导，JSON 全量互等（generatedAt 除外）。
 *   - project-pack：MAPS_ROOT 为模块加载期常量（office-workspace/maps），无注入点 →
 *     在真实 maps/ 下建一次性对拍项目（beforeAll 建目录 + map.config/style/图层/瓦片，
 *     afterAll 删除）；zip 产物经 JSZip 解包逐文件比对（MANIFEST 的 exportedAt 除外，
 *     zip 二进制因时间戳不比字节，比内容）。错误分支 message+code 逐字。
 *   - datasource-adapter-ext：模块加载期 registerSource 副作用 → 两侧各自注册进
 *     各自的 map-visualization 注册表（vitest 每文件独立模块图，互不污染）；经
 *     loadSource 调 load 对拍。HTTP 用本地 node:http 端点（同端点两侧各拉一次）；
 *     SQLite 用 node:sqlite 现场建库；描述符仅 provenance.at（Date.now）需剔除。
 * 覆盖：迁移报告人读/JSON 全结构；打包 manifest/stats/解包内容/tilesIndex/错误码；
 * 适配器注册面、行数组/包装解包/FeatureCollection 直通/错误文案逐字、SQL 只读校验
 * 全分支（注释剥离、多语句、写关键词、路径越界、空结果 header）。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import JSZip from "jszip";
import { PROJECT_DIR } from "../src/main/backend/workspace-paths";

const execFileP = promisify(execFile);

// legacy 侧经 any 载体调用：旧 .mjs 无类型标注（S3-10/S3-11 先例）。
let legacyMig: any;
let modernMig: any;
let legacyPack: any;
let modernPack: any;
let legacyVisual: any;
let modernVisual: any;

function normalize<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

/** 描述符剔除 provenance.at（Date.now，非契约字段）后比对。 */
function stripAt(v: any) {
  const c = normalize(v);
  if (c?.provenance) delete c.provenance.at;
  return c;
}

/* ===== migrate-legacy-data（CLI，无导出面，经 console 输出对拍） ===== */

const ORIG_ARGV = [...process.argv];

async function captureMainOutput(loader: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  });
  try {
    await loader();
  } finally {
    spy.mockRestore();
  }
  return lines;
}

describe("s3-map-data-parity migrate-legacy-data", () => {
  afterEach(() => {
    process.argv = [...ORIG_ARGV];
  });

  // legacy 侧经子进程跑真实 CLI（shebang 文件无法经 vitest 管道加载，且 CLI 本就以
  // `node server/migrate-legacy-data.mjs` 方式运行）；modern 侧捕获 console 输出。
  async function runLegacyCli(args: string[]): Promise<string> {
    const { stdout } = await execFileP(process.execPath, [path.join(PROJECT_DIR, "server", "migrate-legacy-data.mjs"), ...args], {
      cwd: PROJECT_DIR,
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  }

  // 环境稳定重试：真实运行态数据（.规聚会话/.oaw/runs 等）可能被本机存活的 sidecar
  // （node server/index.mjs）在 legacy 子进程扫描与 modern 进程内扫描的窗口之间并发
  // 写入，造成偶发误报（全量并发跑时签名：同文件不同用例间歇性失败、隔离跑恒绿）。
  // 不等则隔 400ms 重测一次，仍不等才是真分叉——两侧实现的转录分叉是确定性的，
  // 不会因重试消失，契约不弱化。
  const ENV_RETRY_GAP_MS = 400;

  it("人读报告：两侧输出互等（生成时间行除外）且非空", async () => {
    const stripTime = (s: string) => s.split("\n").filter((l) => !l.startsWith("生成时间:")).join("\n");
    const once = async () => {
      const outL = await runLegacyCli([]);
      vi.resetModules();
      const linesM = await captureMainOutput(() => import("../src/main/backend/migrate-legacy-data"));
      expect(linesM.length).toBe(1);
      return { legacy: stripTime(outL.trimEnd()), modern: stripTime(linesM[0]!), raw: outL };
    };
    let a = await once();
    if (a.legacy !== a.modern) {
      await new Promise((r) => setTimeout(r, ENV_RETRY_GAP_MS));
      a = await once();
    }
    expect(a.modern).toBe(a.legacy);
    expect(a.raw).toContain("历史数据迁移审查（只读，不修改任何数据）");
    expect(a.raw).toContain("默认工作区: ");
  });

  it("JSON 报告：--json 时两侧 JSON 全量互等（generatedAt 除外）", async () => {
    const once = async () => {
      const outL = await runLegacyCli(["--json"]);
      process.argv = [...ORIG_ARGV, "--json"];
      vi.resetModules();
      const linesM = await captureMainOutput(() => import("../src/main/backend/migrate-legacy-data"));
      expect(linesM.length).toBe(1);
      const a = JSON.parse(outL);
      const b = JSON.parse(linesM[0]!);
      delete a.generatedAt;
      delete b.generatedAt;
      return { a, b };
    };
    let { a, b } = await once();
    if (JSON.stringify(b) !== JSON.stringify(a)) {
      await new Promise((r) => setTimeout(r, ENV_RETRY_GAP_MS));
      ({ a, b } = await once());
    }
    expect(b).toEqual(a);
    // 结构抽查（真实数据形态）
    expect(a.projectDir).toBeTruthy();
    expect(Array.isArray(a.workspaces)).toBe(true);
    expect(typeof a.orphanTotal).toBe("number");
    expect(a.sessions).toHaveProperty("byWorkspace");
    expect(a.runs).toHaveProperty("byStatus");
    expect(a.maps).toHaveProperty("projects");
  });
});

/* ===== project-pack ===== */

describe("s3-map-data-parity project-pack", () => {
  const PROJ = `paritypack${Date.now().toString(36)}`;
  const PROJ_DIR = path.join(PROJECT_DIR, "office-workspace", "maps", PROJ);
  const PBF_A = Buffer.from("fake-pbf-payload-for-parity-test");
  const PBF_B = Buffer.from("fake-pbf-zoom5");

  beforeAll(async () => {
    // 一次性对拍项目：config + style + 图层 + 瓦片（结构 tiles/<layer>/<zoom>/，afterAll 删除）
    fs.rmSync(PROJ_DIR, { recursive: true, force: true });
    fs.mkdirSync(path.join(PROJ_DIR, "layers"), { recursive: true });
    fs.mkdirSync(path.join(PROJ_DIR, "tiles", "base", "2"), { recursive: true });
    fs.mkdirSync(path.join(PROJ_DIR, "tiles", "base", "5"), { recursive: true });
    fs.writeFileSync(path.join(PROJ_DIR, "map.config.json"), JSON.stringify({ project: PROJ, name: "对拍打包项目", archived: false }, null, 2));
    fs.writeFileSync(path.join(PROJ_DIR, "style.json"), JSON.stringify({ version: 8, sources: {}, layers: [] }, null, 2));
    fs.writeFileSync(path.join(PROJ_DIR, "layers", "a.geojson"), JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature", properties: { n: 1 }, geometry: { type: "Point", coordinates: [120, 30] } }] }));
    fs.writeFileSync(path.join(PROJ_DIR, "tiles", "base", "2", "0_0_0.pbf"), PBF_A);
    fs.writeFileSync(path.join(PROJ_DIR, "tiles", "base", "5", "1_1_1.pbf"), PBF_B);
    legacyPack = await import("@legacy-server/project-pack.mjs");
    modernPack = await import("../src/main/backend/project-pack");
  });

  afterAll(() => {
    try { fs.rmSync(PROJ_DIR, { recursive: true, force: true }); } catch {}
  });

  it("项目不存在：两侧错误互等（message + code 逐字）", async () => {
    const errOf = async (mod: any, project: string) => mod.buildProjectZip({ project }).then(() => null, (e: any) => ({ message: e.message, code: e.code }));
    const errL = await errOf(legacyPack, "__no_such__");
    const errM = await errOf(modernPack, "__no_such__");
    expect(errL).toEqual({ message: "地图项目不存在：__no_such__", code: "MAP_PROJECT_NOT_FOUND" });
    expect(errM).toEqual(errL);
    // 空 project 兜底文案
    const emptyL = await errOf(legacyPack, "   ");
    const emptyM = await errOf(modernPack, "   ");
    expect(emptyL).toEqual({ message: "地图项目不存在：(空)", code: "MAP_PROJECT_NOT_FOUND" });
    expect(emptyM).toEqual(emptyL);
  });

  it("基础打包（不带瓦片）：manifest（exportedAt 除外）/stats.files/fileName 互等 + 解包逐文件互等", async () => {
    const outL = await legacyPack.buildProjectZip({ project: PROJ });
    const outM = await modernPack.buildProjectZip({ project: PROJ });
    // manifest 全量互等（exportedAt 为时间戳）
    const { exportedAt: _a, ...manL } = outL.manifest;
    const { exportedAt: _b, ...manM } = outM.manifest;
    expect(manM).toEqual(manL);
    expect(manL.config).toBe("对拍打包项目");
    expect(manL.tilesIncluded).toBe(false);
    expect(manL.layerCount).toBe(1);
    // stats：files 互等；bytes 与各自 buffer 一致（zip 压缩字节因时间戳不强制相等）
    expect(outM.stats.files).toBe(outL.stats.files);
    expect(outM.stats.bytes).toBe(outM.buffer.length);
    expect(outM.fileName).toBe(outL.fileName);
    expect(outM.fileName).toBe(`${PROJ}-map-${new Date().toISOString().slice(0, 10)}.zip`);
    // 解包：文件清单与内容互等（JSZip 根侧版本会自动补目录条目，dir 项过滤后比对）；
    // MANIFEST.json 解析后（除 exportedAt）互等
    const zipL = await JSZip.loadAsync(outL.buffer);
    const zipM = await JSZip.loadAsync(outM.buffer);
    const names = Object.keys(zipL.files).filter((n) => !zipL.files[n]!.dir).sort();
    expect(Object.keys(zipM.files).filter((n) => !zipM.files[n]!.dir).sort()).toEqual(names);
    for (const name of names) {
      if (zipL.files[name]!.dir) continue;
      if (name === "MANIFEST.json") {
        const mL = JSON.parse(await zipL.files[name]!.async("string"));
        const mM = JSON.parse(await zipM.files[name]!.async("string"));
        delete mL.exportedAt;
        delete mM.exportedAt;
        expect(mM).toEqual(mL);
      } else {
        const bufL = await zipL.files[name]!.async("nodebuffer");
        const bufM = await zipM.files[name]!.async("nodebuffer");
        expect(bufM.equals(bufL)).toBe(true);
      }
    }
    expect(names).toEqual(["MANIFEST.json", "layers/a.geojson", "map.config.json", "style.json"]);
  });

  it("includeTiles：瓦片进包 + tilesIndex 互等 + restoreHint 为重建版本", async () => {
    const outL = await legacyPack.buildProjectZip({ project: PROJ, includeTiles: true });
    const outM = await modernPack.buildProjectZip({ project: PROJ, includeTiles: true });
    expect(outM.manifest.tilesIncluded).toBe(true);
    expect(outM.manifest.restoreHint).toBe(outL.manifest.restoreHint);
    expect(outM.manifest.restoreHint).toContain("重启服务即可使用"); // includeTiles=true：瓦片已随包，无需重建
    expect(normalize(outM.manifest.tilesIndex)).toEqual(normalize(outL.manifest.tilesIndex));
    expect(outM.manifest.tilesIndex).toEqual({ base: { files: 2, bytes: PBF_A.length + PBF_B.length, maxZoom: 5 } });
    expect(outM.stats.files).toBe(outL.stats.files); // 核心 3 文件 + 2 瓦片
    const zipL = await JSZip.loadAsync(outL.buffer);
    const zipM = await JSZip.loadAsync(outM.buffer);
    const bufL = await zipL.files["tiles/base/2/0_0_0.pbf"]!.async("nodebuffer");
    const bufM = await zipM.files["tiles/base/2/0_0_0.pbf"]!.async("nodebuffer");
    expect(bufM.equals(bufL)).toBe(true);
    expect(bufM.equals(PBF_A)).toBe(true);
    const bufL5 = await zipL.files["tiles/base/5/1_1_1.pbf"]!.async("nodebuffer");
    const bufM5 = await zipM.files["tiles/base/5/1_1_1.pbf"]!.async("nodebuffer");
    expect(bufM5.equals(bufL5)).toBe(true);
    expect(bufM5.equals(PBF_B)).toBe(true);
  });
});

/* ===== datasource-adapter-ext ===== */

describe("s3-map-data-parity datasource-adapter-ext", () => {
  const TMP_WS = fs.mkdtempSync(path.join(os.tmpdir(), "s3l14ws-"));
  let base = "";
  let server: http.Server;

  beforeAll(async () => {
    legacyVisual = await import("@legacy-server/map-visualization.mjs");
    modernVisual = await import("../src/main/backend/map-visualization");
    await import("@legacy-server/datasource-adapter-ext.mjs");
    await import("../src/main/backend/datasource-adapter-ext");

    const ROWS = [
      { name: "站点A", lng: 120.1, lat: 30.2, flow: 12 },
      { name: "站点B", lng: 121.5, lat: 31.1, flow: 0 },
      { name: "境外", lng: 10, lat: 10, flow: 5 },
      { name: "缺坐标", lng: "", lat: "", flow: 3 },
    ];
    server = http.createServer((req, res) => {
      const u = new URL(req.url || "/", "http://x");
      const send = (obj: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(obj)); };
      switch (u.pathname) {
        case "/rows": send(ROWS); break;
        case "/wrapped": send({ data: ROWS.slice(0, 2) }); break;
        case "/fc": send({
          type: "FeatureCollection",
          features: [
            { type: "Feature", properties: { flow: 5, label: "a" }, geometry: { type: "Point", coordinates: [120.1, 30.2] } },
            { type: "Feature", properties: { flow: 8, label: "b" }, geometry: { type: "Point", coordinates: [121.5, 31.1] } },
          ],
        }); break;
        case "/bad": res.end("not json"); break;
        case "/err": res.statusCode = 500; res.end("boom"); break;
        case "/nonobj": send([1, 2]); break;
        case "/empty": send([]); break;
        default: res.statusCode = 404; res.end("{}");
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as any).port}`;

    // SQLite 现场建库：点表 + OD 表 + 空表 + 非法扩展名文件
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(TMP_WS, "test.db"));
    db.exec("CREATE TABLE t (name TEXT, lng REAL, lat REAL, flow REAL)");
    db.exec("INSERT INTO t VALUES ('站点A', 120.1, 30.2, 12), ('站点B', 121.5, 31.1, 0)");
    db.exec("CREATE TABLE od (o_label TEXT, olng REAL, olat REAL, d_label TEXT, dlng REAL, dlat REAL, cnt REAL)");
    db.exec("INSERT INTO od VALUES ('A', 120.1, 30.2, 'B', 121.5, 31.1, 7), ('C', 119.9, 30.0, 'D', 120.4, 30.5, 3), ('X', 10, 10, 'Y', 121, 31, 1)");
    db.exec("CREATE TABLE empty_t (name TEXT, lng REAL, lat REAL)");
    db.close();
    fs.writeFileSync(path.join(TMP_WS, "notes.txt"), "x");
  });

  afterAll(() => {
    server?.close();
    try { fs.rmSync(TMP_WS, { recursive: true, force: true }); } catch {}
  });

  it("注册面：两 ext 适配器进两侧注册表，id/label/kind/paramsSchema/readOnly 互等", () => {
    const idsOf = (m: any) => m.listSources().map((s: any) => s.id).sort();
    expect(idsOf(modernVisual)).toEqual(idsOf(legacyVisual));
    expect(idsOf(modernVisual)).toEqual(expect.arrayContaining(["live-traffic-api", "sql-database"]));
    const extIds = ["live-traffic-api", "sql-database"];
    const pick = (m: any) => m.listSources().filter((s: any) => extIds.includes(s.id)).sort((a: any, b: any) => a.id.localeCompare(b.id));
    expect(pick(modernVisual)).toEqual(pick(legacyVisual));
  });

  it("live-traffic-api 错误分支：文案逐字互等", async () => {
    const cases: any[] = [
      {},
      { url: "::bad" },
      { url: "ftp://example.com/x" },
      { url: `${base}/bad` },
      { url: `${base}/err` },
      { url: `${base}/nonobj` },
      { url: `${base}/empty` },
      { url: `${base}/nothere` }, // 404：!resp.ok 分支
    ];
    for (const params of cases) {
      const a = await legacyVisual.loadSource("live-traffic-api", params);
      const b = await modernVisual.loadSource("live-traffic-api", params);
      expect(b).toEqual(a);
      expect(a).toHaveProperty("error");
    }
    expect((await modernVisual.loadSource("live-traffic-api", {})).error).toBe("缺少 url 参数（HTTP(S) 端点）");
    expect((await modernVisual.loadSource("live-traffic-api", { url: "::bad" })).error).toBe("url 无法解析：::bad");
    expect((await modernVisual.loadSource("live-traffic-api", { url: "ftp://example.com/x" })).error).toBe("只允许 http/https 端点（收到：ftp://）");
    expect((await modernVisual.loadSource("live-traffic-api", { url: `${base}/bad` })).error).toBe("响应不是合法 JSON");
    expect((await modernVisual.loadSource("live-traffic-api", { url: `${base}/nonobj` })).error).toBe("行数组元素需要是对象（键为列名）");
  });

  it("live-traffic-api 行数组：描述符互等（含 skip 行 / flow=0 保留 / carry 列）", async () => {
    const a = await legacyVisual.loadSource("live-traffic-api", { url: `${base}/rows`, measure: "flow" });
    const b = await modernVisual.loadSource("live-traffic-api", { url: `${base}/rows`, measure: "flow" });
    expect(stripAt(b)).toEqual(stripAt(a));
    expect(a.kind).toBe("points");
    expect(a.stats).toMatchObject({ rowCount: 4, skipped: 2, measure: "flow" });
    expect(a.geojson.features.length).toBe(2);
    expect(a.geojson.features[0].properties).toEqual({ name: "站点A", value: 12, flow: 12 });
    expect(a.geojson.features[1].properties.value).toBe(0); // falsy 但非 null：保留 0 而非回退 1
    expect(a.styleHint).toEqual({ field: "flow", ramp: "warm", radiusRange: [3, 12] });
    expect(a.provenance.generatedBy).toBe("datasource-adapter-ext.mjs");
  });

  it("live-traffic-api 包装解包与 query 拼接：{data:[...]} + params.params", async () => {
    const a = await legacyVisual.loadSource("live-traffic-api", { url: `${base}/wrapped`, params: { k: "v" } });
    const b = await modernVisual.loadSource("live-traffic-api", { url: `${base}/wrapped`, params: { k: "v" } });
    expect(stripAt(b)).toEqual(stripAt(a));
    expect(a.stats.rowCount).toBe(2);
    expect(a.title).toBe("127.0.0.1");
  });

  it("live-traffic-api FeatureCollection 直通：detectMeasureField 自动识别 + 描述符互等", async () => {
    const a = await legacyVisual.loadSource("live-traffic-api", { url: `${base}/fc` });
    const b = await modernVisual.loadSource("live-traffic-api", { url: `${base}/fc` });
    expect(stripAt(b)).toEqual(stripAt(a));
    expect(a.styleHint.field).toBe("flow");
    expect(a.styleHint.widthRange).toEqual([0.7, 4.5]);
    expect(a.provenance.dataset).toBe("live-traffic-api"); // toDescriptor 白名单化 provenance，url 等额外键被丢弃
  });

  it("sql-database 点表/OD 表：描述符互等（含 OD lines 与 skip 行）", async () => {
    const a1 = await legacyVisual.loadSource("sql-database", { workspace: TMP_WS, db: "test.db", sql: "SELECT * FROM t ORDER BY flow DESC", measure: "flow" });
    const b1 = await modernVisual.loadSource("sql-database", { workspace: TMP_WS, db: "test.db", sql: "SELECT * FROM t ORDER BY flow DESC", measure: "flow" });
    expect(stripAt(b1)).toEqual(stripAt(a1));
    expect(a1.kind).toBe("points");
    expect(a1.geojson.features.map((f: any) => f.properties.name)).toEqual(["站点A", "站点B"]);
    expect(a1.title).toBe("test.db");

    const a2 = await legacyVisual.loadSource("sql-database", { workspace: TMP_WS, db: "test.db", sql: "SELECT * FROM od", measure: "cnt" });
    const b2 = await modernVisual.loadSource("sql-database", { workspace: TMP_WS, db: "test.db", sql: "SELECT * FROM od", measure: "cnt" });
    expect(stripAt(b2)).toEqual(stripAt(a2));
    expect(a2.kind).toBe("flow");
    expect(a2.stats).toMatchObject({ rowCount: 3, skipped: 1, measure: "cnt" });
    expect(a2.lines.features.length).toBe(2);
    expect(a2.geojson.features[0].properties.role).toBe("origin");
    expect(a2.styleHint).toEqual({ field: "cnt", ramp: "ramp", widthRange: [0.7, 4.5] });
  });

  it("sql-database 只读校验全分支：错误文案逐字互等", async () => {
    const run = async (params: any) => {
      const a = await legacyVisual.loadSource("sql-database", params);
      const b = await modernVisual.loadSource("sql-database", params);
      expect(b).toEqual(a);
      return a;
    };
    expect((await run({ workspace: TMP_WS, db: "test.db" })).error).toBe("缺少 sql 参数（只读 SELECT 查询）");
    expect((await run({ workspace: TMP_WS, sql: "SELECT 1" })).error).toBe("缺少 db 参数（工作区内 SQLite 文件相对路径）");
    expect((await run({ workspace: TMP_WS, db: "nope.db", sql: "SELECT 1" })).error).toBe("数据库文件不存在：nope.db");
    expect((await run({ workspace: TMP_WS, db: "notes.txt", sql: "SELECT 1" })).error).toBe("只支持 .db/.sqlite/.sqlite3/.db3 文件");
    expect((await run({ workspace: TMP_WS, db: "../evil.db", sql: "SELECT 1" })).error).toBe("路径必须在工作区内");
    expect((await run({ workspace: TMP_WS, db: "test.db", sql: "UPDATE t SET name = 'x'" })).error).toBe("只允许 SELECT / WITH 查询语句");
    expect((await run({ workspace: TMP_WS, db: "test.db", sql: "SELECT 1; SELECT 2" })).error).toBe("不允许一次执行多条语句（sql 中出现多余分号）");
    expect((await run({ workspace: TMP_WS, db: "test.db", sql: "SELECT 1; DROP TABLE t" })).error).toBe("不允许一次执行多条语句（sql 中出现多余分号）");
    expect((await run({ workspace: TMP_WS, db: "test.db", sql: "INSERT INTO t VALUES (1)" })).error).toBe("只允许 SELECT / WITH 查询语句");
    expect((await run({ workspace: TMP_WS, db: "test.db", sql: "SELECT * FROM t WHERE name = 'a' OR drop = 1" })).error).toBe("查询中包含写操作关键词，已拒绝（只读数据源）");
    const empty = await run({ workspace: TMP_WS, db: "test.db", sql: "SELECT * FROM empty_t" });
    expect(empty).toEqual({ error: "查询结果为空（0 行）", header: ["name", "lng", "lat"] });
    const bad = await run({ workspace: TMP_WS, db: "test.db", sql: "SELECT * FROM no_such_table" });
    expect(bad.error).toContain("SQL 执行失败：");
  });

  it("sql-database 注释剥离：块注释含写关键词仍放行（两侧互等）", async () => {
    const sql = "SELECT /* delete drop */ * FROM t WHERE 1=1 -- update";
    const a = await legacyVisual.loadSource("sql-database", { workspace: TMP_WS, db: "test.db", sql, measure: "flow" });
    const b = await modernVisual.loadSource("sql-database", { workspace: TMP_WS, db: "test.db", sql, measure: "flow" });
    expect(stripAt(b)).toEqual(stripAt(a));
    expect(a.geojson.features.length).toBe(2);
  });
});
