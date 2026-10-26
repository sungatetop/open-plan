/**
 * S3-9 traffic-sources 域对拍：3 导出面一致 + PLANNED_SOURCES / detectColumns 全分支
 * （点/OD/中英别名/x-y 精确匹配防 max_value 误判/unknown）/ inChinaRange 边界与 NaN /
 * local-file 适配器经 loadSource 全分支（geojson 直读与 FeatureCollection 校验、.json
 * 扩展名、自动挑选最新 mtime（utimesSync 显式设置）、path.relative 目录越界含同前缀
 * 兄弟目录、文件不存在、CSV 无数据行、列识别失败表头逐字、OD/点两模式几何与 carry
 * 属性、measure 指定与 numeric[0] 兜底、越界 skipped 计数与文案、引号转义、制表符
 * 分隔、无任何数值列）/ bundled-xinchang 四 kind + 非法 kind 默认（与 map-visualization
 * 对拍互为印证）。
 *
 * 真实 IO 双跑：legacy pathToFileURL 物理加载 server/traffic-sources.mjs + map-visualization.mjs，
 * modern 静态 import TS 两模块；适配器用例经各侧 loadSource("local-file") 驱动，临时
 * 工作区双侧共享（适配器纯读，输出无绝对路径）。fake timers 冻结 Date（provenance.at）。
 * 有意不做：空 workspace → "没有当前工作区"（getWorkspace() 恒有真值，分支不可达）；
 * "检查经纬度列是否为数字" 文案（skipped=0 且 features=0 的组合在循环语义下不可达，
 * 旧侧死分支）；bundled-xinchang 演示回退（真实数据在场不可达）——均记台账。
 */
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as modernVis from "../src/main/backend/map-visualization";
import * as modernTraffic from "../src/main/backend/traffic-sources";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "../..");

type VisModule = typeof modernVis;
type TrafficModule = typeof modernTraffic;

const mod = {} as Record<"legacy" | "modern", { vis: VisModule; traffic: TrafficModule }>;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-24T02:00:00Z"));
  // legacy 链：物理 traffic-sources.mjs 导入即注册进物理 map-visualization.mjs 实例
  await import(pathToFileURL(path.join(PROJECT_ROOT, "server/traffic-sources.mjs")).href);
  mod.legacy = {
    vis: await import(pathToFileURL(path.join(PROJECT_ROOT, "server/map-visualization.mjs")).href) as VisModule,
    traffic: await import(pathToFileURL(path.join(PROJECT_ROOT, "server/traffic-sources.mjs")).href) as TrafficModule,
  };
  // modern 链：TS traffic-sources 导入即注册进 TS map-visualization 实例
  await import("../src/main/backend/traffic-sources");
  mod.modern = { vis: modernVis, traffic: modernTraffic };
});

afterAll(() => {
  vi.useRealTimers();
});

const mkWs = () => fs.mkdtempSync(path.join(os.tmpdir(), "s3-9-ts-"));
const rmWs = (ws: string) => fs.rmSync(ws, { recursive: true, force: true });

async function loadBoth(ws: string, params: Record<string, unknown>) {
  const legacy = await mod.legacy.vis.loadSource("local-file", { workspace: ws, ...params });
  const modern = await mod.modern.vis.loadSource("local-file", { workspace: ws, ...params });
  return { legacy, modern };
}

function expectJsonEqual(a: unknown, b: unknown) {
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));
}

describe("S3-9 traffic-sources 对拍", () => {
  it("导出面一致（3 导出）+ PLANNED_SOURCES 相等", () => {
    expect(Object.keys(mod.legacy.traffic).sort()).toEqual(Object.keys(mod.modern.traffic).sort());
    expect(Object.keys(mod.modern.traffic).sort()).toEqual(["PLANNED_SOURCES", "detectColumns", "inChinaRange"]);
    expectJsonEqual(mod.legacy.traffic.PLANNED_SOURCES, mod.modern.traffic.PLANNED_SOURCES);
    expect(mod.modern.traffic.PLANNED_SOURCES).toEqual([
      { id: "gps-trajectory", label: "车载 GPS 轨迹", kind: "flow", note: expect.stringContaining("prepare-map-data") },
    ]);
    expect(Object.isFrozen(mod.modern.traffic.PLANNED_SOURCES)).toBe(true);
  });

  it("detectColumns 全分支双侧逐字节（点/OD/中英别名/x-y 精确/unknown）", () => {
    const cases: string[][] = [
      [],
      ["name", "经度", "纬度", "客流"],
      ["olng", "olat", "dlng", "dlat"],
      ["起点经度", "起点纬度", "终点经度", "终点纬度"],
      ["出发经", "出发纬", "到达经", "到达纬"],
      ["from_lon", "from_lat", "to_lon", "to_lat"],
      ["origin_lng", "origin_lat", "dest_lng", "dest_lat"],
      ["x", "y", "max_value"], // x/y 仅精确匹配
      ["lon_x", "lat_y"], // x/y 精确匹配不适用，但 lon/lat 子串别名仍命中 → points
      ["LNG", "LAT"], // includes 大小写不敏感
      ["o_lon", "o_lat", "d_lon", "d_lat"],
      ["start_lon", "start_lat", "dest_lon", "dest_lat"],
      ["流量", "value_avg", "经度", "纬度"],
      ["tel", "name"], // unknown
    ];
    for (const c of cases) {
      expectJsonEqual(mod.legacy.traffic.detectColumns(c), mod.modern.traffic.detectColumns(c));
    }
    // 关键语义锚点
    expect(mod.modern.traffic.detectColumns(["x", "y", "max_value"])).toEqual({
      lng: "x", lat: "y", olng: "", olat: "", dlng: "", dlat: "", flow: "max_value", mode: "points",
    });
    // lon_x/lat_y：x/y 别名精确匹配不误命中，但 lon/lat 子串别名命中 → points（lng=lon_x / lat=lat_y）
    const lonLat = mod.modern.traffic.detectColumns(["lon_x", "lat_y"]);
    expect(lonLat.mode).toBe("points");
    expect(lonLat.lng).toBe("lon_x");
    expect(lonLat.lat).toBe("lat_y");
    expect(mod.modern.traffic.detectColumns(["起点经度", "起点纬度", "终点经度", "终点纬度"]).mode).toBe("od");
  });

  it("inChinaRange 边界与 NaN 双侧一致", () => {
    const cases: Array<[number, number]> = [
      [120, 29], [70, 15], [140, 56], [69.9, 29], [140.1, 29],
      [120, 14.9], [120, 56.1], [NaN, 29], [120, NaN], [70, 56], [140, 15],
    ];
    for (const [a, b] of cases) {
      expect(mod.legacy.traffic.inChinaRange(a, b)).toBe(mod.modern.traffic.inChinaRange(a, b));
    }
    expect(mod.modern.traffic.inChinaRange(70, 15)).toBe(true);
    expect(mod.modern.traffic.inChinaRange(69.999, 29)).toBe(false);
  });

  describe("local-file 适配器（经 loadSource，临时工作区双侧共享）", () => {
    it("geojson 直读：FC 描述符 + measure 自动识别；非 FC 拒绝；.json 同通道", async () => {
      const ws = mkWs();
      try {
        const fc = {
          type: "FeatureCollection",
          features: [
            { type: "Feature", properties: { value: 3, name: "a" }, geometry: { type: "Point", coordinates: [120.1, 29.3] } },
            { type: "Feature", properties: { value: 8 }, geometry: { type: "Point", coordinates: [120.2, 29.4] } },
          ],
        };
        fs.writeFileSync(path.join(ws, "pts.geojson"), JSON.stringify(fc));
        fs.writeFileSync(path.join(ws, "bad.geojson"), JSON.stringify({ type: "Feature" }));
        fs.writeFileSync(path.join(ws, "asjson.json"), JSON.stringify(fc));

        const ok = await loadBoth(ws, { path: "pts.geojson" });
        expectJsonEqual(ok.legacy, ok.modern);
        expect((ok.legacy as any).id).toBe("file-pts");
        expect((ok.legacy as any).title).toBe("pts");
        expect((ok.legacy as any).kind).toBe("points");
        expect((ok.legacy as any).styleHint.field).toBe("value");
        expect((ok.legacy as any).provenance.generatedBy).toBe("traffic-sources.mjs");

        const bad = await loadBoth(ws, { path: "bad.geojson" });
        expectJsonEqual(bad.legacy, bad.modern);
        expect((bad.legacy as any).error).toBe("GeoJSON 需要是 FeatureCollection");

        const asJson = await loadBoth(ws, { path: "asjson.json" });
        expectJsonEqual(asJson.legacy, asJson.modern);
        expect((asJson.legacy as any).id).toBe("file-asjson");

        // measure 指定覆盖自动识别
        const forced = await loadBoth(ws, { path: "pts.geojson", measure: "name" });
        expectJsonEqual(forced.legacy, forced.modern);
        expect((forced.legacy as any).styleHint.field).toBe("name");
      } finally { rmWs(ws); }
    });

    it("OD CSV：点+线、carry 属性、measure 列同名写入、越界 skipped", async () => {
      const ws = mkWs();
      try {
        fs.writeFileSync(path.join(ws, "od.csv"), [
          "oname,olng,olat,dname,dlng,dlat,flow",
          "义乌,120.07,29.31,金华,119.65,29.08,300",
          "义乌,120.07,29.31,杭州,120.16,30.29,520",
          "越界,200,29,宁波,121.5,29.8,50",
        ].join("\n"));
        const r = await loadBoth(ws, { path: "od.csv" });
        expectJsonEqual(r.legacy, r.modern);
        const d: any = r.legacy;
        expect(d.kind).toBe("flow");
        expect(d.id).toBe("file-od");
        expect(d.stats.rowCount).toBe(3);
        expect(d.stats.skipped).toBe(1);
        expect(d.lines.features.length).toBe(2);
        expect(d.geojson.features.length).toBe(2);
        expect(d.geojson.features[0].properties.role).toBe("origin");
        expect(d.geojson.features[0].properties.oname).toBe("义乌");
        expect(d.geojson.features[0].properties.flow).toBe(300);
        expect(d.lines.features[0].properties.flow).toBe(300);
        expect(d.styleHint).toEqual({ field: "flow", ramp: "ramp", widthRange: [0.7, 4.5] });
        // carried 排除坐标列与 measure 列（仅名称列透传）
        expect(d.stats.columns).toEqual({ mode: "od", measure: "flow", numeric: ["olng", "olat", "dlng", "dlat", "flow"], carried: ["oname", "dname"] });
      } finally { rmWs(ws); }
    });

    it("点 CSV：缺 measure 行 value=1、carry 保留、全非数字坐标 skipped 文案逐字", async () => {
      const ws = mkWs();
      try {
        fs.writeFileSync(path.join(ws, "pts.csv"), [
          "名称,经度,纬度,客流",
          "A,120.1,29.3,10",
          "B,120.2,29.4,",
          "C,20,29,5", // 经度 20 越界（<70）
        ].join("\n"));
        const r = await loadBoth(ws, { path: "pts.csv" });
        expectJsonEqual(r.legacy, r.modern);
        const d: any = r.legacy;
        expect(d.kind).toBe("points");
        expect(d.geojson.features.length).toBe(2);
        expect(d.geojson.features[0].properties.名称).toBe("A");
        expect(d.geojson.features[0].properties.客流).toBe(10);
        expect(d.geojson.features[1].properties.客流).toBe(1); // 空单元格 → value 1
        expect(d.stats.skipped).toBe(1);
        expect(d.styleHint.ramp).toBe("warm");
        expect(d.styleHint.radiusRange).toEqual([3, 12]);

        // 全部越界 → skipped 文案逐字（带数字）
        fs.writeFileSync(path.join(ws, "out.csv"), [
          "经度,纬度",
          "200,29",
          "121,90",
        ].join("\n"));
        const all = await loadBoth(ws, { path: "out.csv" });
        expectJsonEqual(all.legacy, all.modern);
        expect((all.legacy as any).error).toBe("没有解析到有效坐标行（2 行坐标缺失或超出中国范围 70–140E / 15–56N）");
        expect((all.legacy as any).skipped).toBe(2);
      } finally { rmWs(ws); }
    });

    it("x/y 精确匹配（max_value 不当 x 列）+ numeric[0] 兜底 measure", async () => {
      const ws = mkWs();
      try {
        fs.writeFileSync(path.join(ws, "xy.csv"), [
          "x,y,max_value",
          "120.1,29.3,5",
          "120.2,29.4,7",
        ].join("\n"));
        const r = await loadBoth(ws, { path: "xy.csv" });
        expectJsonEqual(r.legacy, r.modern);
        const d: any = r.legacy;
        expect(d.kind).toBe("points");
        expect(d.geojson.features[0].geometry.coordinates).toEqual([120.1, 29.3]);
        expect(d.geojson.features[0].properties.max_value).toBe(5);
        expect(d.stats.columns.measure).toBe("max_value");
        expect(d.styleHint.field).toBe("max_value");

        // 无 flow 别名列 → measure 取 numeric[0]；坐标列本身算数值列，故兜底为 "经度"
        // （value 取 measure 列的数值 → 120.1，speed 等其余列以字符串透传 carry）
        fs.writeFileSync(path.join(ws, "noscale.csv"), [
          "名称,经度,纬度,speed",
          "A,120.1,29.3,40",
          "B,120.2,29.4,55",
        ].join("\n"));
        const r2 = await loadBoth(ws, { path: "noscale.csv" });
        expectJsonEqual(r2.legacy, r2.modern);
        expect((r2.legacy as any).stats.columns.measure).toBe("经度");
        expect((r2.legacy as any).stats.columns.numeric).toEqual(["经度", "纬度", "speed"]);
        expect((r2.legacy as any).stats.columns.carried).toEqual(["名称", "speed"]);
        expect((r2.legacy as any).geojson.features[0].properties.经度).toBe(120.1);
        expect((r2.legacy as any).geojson.features[0].properties.speed).toBe("40");
        expect((r2.legacy as any).styleHint.field).toBe("经度");

        // 同语义最小表头：无任何业务数值列时 measure 仍兜底坐标列 "经度"
        fs.writeFileSync(path.join(ws, "plain.csv"), [
          "名称,经度,纬度",
          "A,120.1,29.3",
          "B,120.2,29.4",
        ].join("\n"));
        const r3 = await loadBoth(ws, { path: "plain.csv" });
        expectJsonEqual(r3.legacy, r3.modern);
        expect((r3.legacy as any).stats.columns.measure).toBe("经度");
        expect((r3.legacy as any).geojson.features[0].properties.value).toBe(120.1);
        expect((r3.legacy as any).styleHint.field).toBe("经度");
      } finally { rmWs(ws); }
    });

    it("错误分支逐字：越界/同前缀兄弟目录/文件不存在/无数据行/列识别失败", async () => {
      const ws = mkWs();
      try {
        fs.writeFileSync(path.join(ws, "od.csv"), "oname,olng,olat,dname,dlng,dlat,flow\n义乌,120.07,29.31,金华,119.65,29.08,300\n");
        // 相对越界
        const up = await loadBoth(ws, { path: "../outside.csv" });
        expect((up.legacy as any).error).toBe("path 必须在工作区内");
        expectJsonEqual(up.legacy, up.modern);
        // 同前缀兄弟目录（path.relative 边界语义）
        const siblingDir = `${ws}2`;
        fs.mkdirSync(siblingDir, { recursive: true });
        fs.writeFileSync(path.join(siblingDir, "f.csv"), "经度,纬度\n120,29\n");
        const sib = await loadBoth(ws, { path: "../" + path.basename(siblingDir) + "/f.csv" });
        expect((sib.legacy as any).error).toBe("path 必须在工作区内");
        expectJsonEqual(sib.legacy, sib.modern);
        // 文件不存在
        const miss = await loadBoth(ws, { path: "nope.csv" });
        expect((miss.legacy as any).error).toBe("文件不存在：nope.csv");
        expectJsonEqual(miss.legacy, miss.modern);
        // CSV 无数据行
        fs.writeFileSync(path.join(ws, "empty.csv"), "a,b\n");
        const empty = await loadBoth(ws, { path: "empty.csv" });
        expect((empty.legacy as any).error).toBe("CSV 没有数据行");
        expectJsonEqual(empty.legacy, empty.modern);
        // 列识别失败（表头逐字 + header 回传）
        fs.writeFileSync(path.join(ws, "unknown.csv"), "name,tel\nA,1\nB,2\n");
        const unknown = await loadBoth(ws, { path: "unknown.csv" });
        expectJsonEqual(unknown.legacy, unknown.modern);
        expect((unknown.legacy as any).error).toBe("无法识别坐标列。表头：name、tel（需要 经度/纬度，或 起点+终点 经纬度）");
        expect((unknown.legacy as any).header).toEqual(["name", "tel"]);
      } finally {
        rmWs(ws);
        fs.rmSync(`${ws}2`, { recursive: true, force: true });
      }
    });

    it("引号转义 + 制表符分隔 + 自动挑选最新 mtime", async () => {
      const ws = mkWs();
      try {
        // 引号内逗号不切列；引号内双引号转义
        fs.writeFileSync(path.join(ws, "quoted.csv"), [
          '名称,经度,纬度',
          '"A,B",120.1,29.3',
          '"C""D",120.2,29.4',
        ].join("\n"));
        const q = await loadBoth(ws, { path: "quoted.csv" });
        expectJsonEqual(q.legacy, q.modern);
        expect((q.legacy as any).geojson.features[0].properties.名称).toBe("A,B");
        expect((q.legacy as any).geojson.features[1].properties.名称).toBe('C"D');

        // 制表符
        fs.writeFileSync(path.join(ws, "tsv.csv"), [
          "名称\t经度\t纬度",
          "A\t120.1\t29.3",
          "B\t120.2\t29.4",
        ].join("\n"));
        const t = await loadBoth(ws, { path: "tsv.csv" });
        expectJsonEqual(t.legacy, t.modern);
        expect((t.legacy as any).geojson.features.length).toBe(2);

        // 自动挑选：a.csv 先写、b.geojson 后写（mtime 更新），省略 path 应选 b
        fs.writeFileSync(path.join(ws, "a.csv"), "经度,纬度\n120,29\n120.1,29.1\n");
        fs.writeFileSync(path.join(ws, "b.geojson"), JSON.stringify({ type: "FeatureCollection", features: [] }));
        fs.utimesSync(path.join(ws, "a.csv"), new Date(1000000000000), new Date(1000000000000));
        fs.utimesSync(path.join(ws, "b.geojson"), new Date(2000000000000), new Date(2000000000000));
        const auto = await loadBoth(ws, {});
        expectJsonEqual(auto.legacy, auto.modern);
        expect((auto.legacy as any).title).toBe("b");
        // 交换 mtime → 选 a
        fs.utimesSync(path.join(ws, "a.csv"), new Date(3000000000000), new Date(3000000000000));
        const auto2 = await loadBoth(ws, {});
        expect((auto2.legacy as any).title).toBe("a");
        expectJsonEqual(auto2.legacy, auto2.modern);
      } finally { rmWs(ws); }
    });

    it("空 workspace 参数 → 双侧一致（同 getWorkspace 语义）", async () => {
      const l = await mod.legacy.vis.loadSource("local-file", { workspace: "" });
      const m = await mod.modern.vis.loadSource("local-file", { workspace: "" });
      expectJsonEqual(l, m);
      // 当前真实工作区根目录无 CSV/GeoJSON 时给出明确错误；有则双侧产出同一描述符
      expect((l as any).error === undefined || typeof (l as any).error === "string").toBe(true);
    });
  });

  it("bundled-xinchang：四 kind + 非法 kind 默认 stations 双侧逐字节", async () => {
    for (const kind of ["routes", "stations", "od", "stats", undefined, "bogus"]) {
      const l = await mod.legacy.vis.loadSource("bundled-xinchang", { kind });
      const m = await mod.modern.vis.loadSource("bundled-xinchang", { kind });
      expectJsonEqual(l, m);
      expect((l as any).error).toBeUndefined();
    }
    const stations: any = await mod.modern.vis.loadSource("bundled-xinchang", { kind: "stations" });
    expect(stations.id).toBe("m3-bus-stations");
    expect(stations.kind).toBe("points");
    expect(stations.geojson.features.length).toBeGreaterThan(0);
  });
});
