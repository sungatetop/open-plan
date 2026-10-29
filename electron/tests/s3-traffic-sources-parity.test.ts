/**
 * S3-9 traffic-sources 域单侧测试：3 导出 + PLANNED_SOURCES / detectColumns 全分支
 * 绝对期望（点/OD/中英别名/x-y 精确匹配防 max_value 误判/unknown，含 lng 子串别名对
 * OD 列表的先命中语义）/ inChinaRange 边界与 NaN / local-file 适配器经 loadSource 全
 * 分支（geojson 直读与 FeatureCollection 校验、.json 扩展名、自动挑选最新 mtime
 * （utimesSync 显式设置）、path.relative 目录越界含同前缀兄弟目录、文件不存在、CSV 无
 * 数据行、列识别失败表头逐字、OD/点两模式几何与 carry 属性、measure 指定与 numeric[0]
 * 兜底、越界 skipped 计数与文案、引号转义、制表符分隔、无任何数值列）/ bundled-xinchang
 * 四 kind + 非法 kind 默认（与 map-visualization 测试互为印证）。
 *
 * 真实 IO：modern 静态 import TS 两模块；适配器用例经 loadSource("local-file") 驱动，
 * 临时工作区（适配器纯读，输出无绝对路径）。fake timers 冻结 Date（provenance.at）。
 * 有意不做：空 workspace → "没有当前工作区"（getWorkspace() 恒有真值，分支不可达）；
 * "检查经纬度列是否为数字" 文案（skipped=0 且 features=0 的组合在循环语义下不可达，
 * 死分支）；bundled-xinchang 演示回退（真实数据在场不可达）——均记台账。
 */
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as modernVis from "../src/main/backend/map-visualization";
import * as modernTraffic from "../src/main/backend/traffic-sources";

const mod = { vis: modernVis, traffic: modernTraffic };

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-24T02:00:00Z"));
  // modern 链：TS traffic-sources 导入即注册进 TS map-visualization 实例
  await import("../src/main/backend/traffic-sources");
});

afterAll(() => {
  vi.useRealTimers();
});

const mkWs = () => fs.mkdtempSync(path.join(os.tmpdir(), "s3-9-ts-"));
const rmWs = (ws: string) => fs.rmSync(ws, { recursive: true, force: true });

async function loadOne(ws: string, params: Record<string, unknown>) {
  return mod.vis.loadSource("local-file", { workspace: ws, ...params });
}

describe("S3-9 traffic-sources", () => {
  it("导出面（3 导出）+ PLANNED_SOURCES", () => {
    expect(Object.keys(mod.traffic).sort()).toEqual(["PLANNED_SOURCES", "detectColumns", "inChinaRange"]);
    expect(mod.traffic.PLANNED_SOURCES).toEqual([
      { id: "gps-trajectory", label: "车载 GPS 轨迹", kind: "flow", note: expect.stringContaining("prepare-map-data") },
    ]);
    expect(Object.isFrozen(mod.traffic.PLANNED_SOURCES)).toBe(true);
  });

  it("detectColumns 全分支绝对期望（点/OD/中英别名/x-y 精确/unknown）", () => {
    const cases: Array<[string[], any]> = [
      // 空表头 → unknown
      [[], { lng: "", lat: "", olng: "", olat: "", dlng: "", dlat: "", flow: "", mode: "unknown" }],
      // 点模式：中文表头 + 客流 flow
      [["name", "经度", "纬度", "客流"], { lng: "经度", lat: "纬度", olng: "", olat: "", dlng: "", dlat: "", flow: "客流", mode: "points" }],
      // OD 表头：lng 别名 "lng" 为 "olng"/"dlng" 子串，先命中 olng 列（includes 语义）
      [["olng", "olat", "dlng", "dlat"], { lng: "olng", lat: "olat", olng: "olng", olat: "olat", dlng: "dlng", dlat: "dlat", flow: "", mode: "od" }],
      // 中文 OD：经度/纬度 别名先命中起点列（起点经度 含 "经度"）
      [["起点经度", "起点纬度", "终点经度", "终点纬度"], { lng: "起点经度", lat: "起点纬度", olng: "起点经度", olat: "起点纬度", dlng: "终点经度", dlat: "终点纬度", flow: "", mode: "od" }],
      // 出发/到达 别名：不含 "经度" → lng/lat 空，mode 仍 od
      [["出发经", "出发纬", "到达经", "到达纬"], { lng: "", lat: "", olng: "出发经", olat: "出发纬", dlng: "到达经", dlat: "到达纬", flow: "", mode: "od" }],
      // "to_lon"/"to_lat" 含 "o_lon"/"o_lat" 子串，olng/olat 别名序先命中 to 列
      [["from_lon", "from_lat", "to_lon", "to_lat"], { lng: "from_lon", lat: "from_lat", olng: "to_lon", olat: "to_lat", dlng: "to_lon", dlat: "to_lat", flow: "", mode: "od" }],
      [["origin_lng", "origin_lat", "dest_lng", "dest_lat"], { lng: "origin_lng", lat: "origin_lat", olng: "origin_lng", olat: "origin_lat", dlng: "dest_lng", dlat: "dest_lat", flow: "", mode: "od" }],
      // x/y 仅精确匹配；max_value 经 "value" 子串别名命中 flow
      [["x", "y", "max_value"], { lng: "x", lat: "y", olng: "", olat: "", dlng: "", dlat: "", flow: "max_value", mode: "points" }],
      // x/y 精确匹配不适用，但 lon/lat 子串别名仍命中 → points
      [["lon_x", "lat_y"], { lng: "lon_x", lat: "lat_y", olng: "", olat: "", dlng: "", dlat: "", flow: "", mode: "points" }],
      // includes 大小写不敏感（lower 化后匹配，返回原表头写法）
      [["LNG", "LAT"], { lng: "LNG", lat: "LAT", olng: "", olat: "", dlng: "", dlat: "", flow: "", mode: "points" }],
      [["o_lon", "o_lat", "d_lon", "d_lat"], { lng: "o_lon", lat: "o_lat", olng: "o_lon", olat: "o_lat", dlng: "d_lon", dlat: "d_lat", flow: "", mode: "od" }],
      [["start_lon", "start_lat", "dest_lon", "dest_lat"], { lng: "start_lon", lat: "start_lat", olng: "start_lon", olat: "start_lat", dlng: "dest_lon", dlat: "dest_lat", flow: "", mode: "od" }],
      // flow 优先序：流量 先于 value（value_avg 含 "value" 但流量列在前）
      [["流量", "value_avg", "经度", "纬度"], { lng: "经度", lat: "纬度", olng: "", olat: "", dlng: "", dlat: "", flow: "流量", mode: "points" }],
      // unknown
      [["tel", "name"], { lng: "", lat: "", olng: "", olat: "", dlng: "", dlat: "", flow: "", mode: "unknown" }],
    ];
    for (const [header, expected] of cases) {
      expect(mod.traffic.detectColumns(header)).toEqual(expected);
    }
    // 起点终点中文 OD 模式锚点
    expect(mod.traffic.detectColumns(["起点经度", "起点纬度", "终点经度", "终点纬度"]).mode).toBe("od");
  });

  it("inChinaRange 边界与 NaN（70–140E / 15–56N 闭区间）", () => {
    const cases: Array<[number, number, boolean]> = [
      [120, 29, true],
      [70, 15, true], // 双下界含
      [140, 56, true], // 双上界含
      [69.9, 29, false],
      [140.1, 29, false],
      [120, 14.9, false],
      [120, 56.1, false],
      [NaN, 29, false],
      [120, NaN, false],
      [70, 56, true],
      [140, 15, true],
      [69.999, 29, false],
    ];
    for (const [a, b, expected] of cases) {
      expect(mod.traffic.inChinaRange(a, b)).toBe(expected);
    }
  });

  describe("local-file 适配器（经 loadSource，临时工作区）", () => {
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

        const ok: any = await loadOne(ws, { path: "pts.geojson" });
        expect(ok.id).toBe("file-pts");
        expect(ok.title).toBe("pts");
        expect(ok.kind).toBe("points");
        expect(ok.styleHint.field).toBe("value");
        expect(ok.provenance.generatedBy).toBe("traffic-sources.mjs");

        const bad: any = await loadOne(ws, { path: "bad.geojson" });
        expect(bad.error).toBe("GeoJSON 需要是 FeatureCollection");

        const asJson: any = await loadOne(ws, { path: "asjson.json" });
        expect(asJson.id).toBe("file-asjson");

        // measure 指定覆盖自动识别
        const forced: any = await loadOne(ws, { path: "pts.geojson", measure: "name" });
        expect(forced.styleHint.field).toBe("name");
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
        const d: any = await loadOne(ws, { path: "od.csv" });
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
        const d: any = await loadOne(ws, { path: "pts.csv" });
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
        const all: any = await loadOne(ws, { path: "out.csv" });
        expect(all.error).toBe("没有解析到有效坐标行（2 行坐标缺失或超出中国范围 70–140E / 15–56N）");
        expect(all.skipped).toBe(2);
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
        const d: any = await loadOne(ws, { path: "xy.csv" });
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
        const r2: any = await loadOne(ws, { path: "noscale.csv" });
        expect(r2.stats.columns.measure).toBe("经度");
        expect(r2.stats.columns.numeric).toEqual(["经度", "纬度", "speed"]);
        expect(r2.stats.columns.carried).toEqual(["名称", "speed"]);
        expect(r2.geojson.features[0].properties.经度).toBe(120.1);
        expect(r2.geojson.features[0].properties.speed).toBe("40");
        expect(r2.styleHint.field).toBe("经度");

        // 同语义最小表头：无任何业务数值列时 measure 仍兜底坐标列 "经度"
        fs.writeFileSync(path.join(ws, "plain.csv"), [
          "名称,经度,纬度",
          "A,120.1,29.3",
          "B,120.2,29.4",
        ].join("\n"));
        const r3: any = await loadOne(ws, { path: "plain.csv" });
        expect(r3.stats.columns.measure).toBe("经度");
        expect(r3.geojson.features[0].properties.value).toBe(120.1);
        expect(r3.styleHint.field).toBe("经度");
      } finally { rmWs(ws); }
    });

    it("错误分支逐字：越界/同前缀兄弟目录/文件不存在/无数据行/列识别失败", async () => {
      const ws = mkWs();
      try {
        fs.writeFileSync(path.join(ws, "od.csv"), "oname,olng,olat,dname,dlng,dlat,flow\n义乌,120.07,29.31,金华,119.65,29.08,300\n");
        // 相对越界
        const up: any = await loadOne(ws, { path: "../outside.csv" });
        expect(up.error).toBe("path 必须在工作区内");
        // 同前缀兄弟目录（path.relative 边界语义）
        const siblingDir = `${ws}2`;
        fs.mkdirSync(siblingDir, { recursive: true });
        fs.writeFileSync(path.join(siblingDir, "f.csv"), "经度,纬度\n120,29\n");
        const sib: any = await loadOne(ws, { path: "../" + path.basename(siblingDir) + "/f.csv" });
        expect(sib.error).toBe("path 必须在工作区内");
        // 文件不存在
        const miss: any = await loadOne(ws, { path: "nope.csv" });
        expect(miss.error).toBe("文件不存在：nope.csv");
        // CSV 无数据行
        fs.writeFileSync(path.join(ws, "empty.csv"), "a,b\n");
        const empty: any = await loadOne(ws, { path: "empty.csv" });
        expect(empty.error).toBe("CSV 没有数据行");
        // 列识别失败（表头逐字 + header 回传）
        fs.writeFileSync(path.join(ws, "unknown.csv"), "name,tel\nA,1\nB,2\n");
        const unknown: any = await loadOne(ws, { path: "unknown.csv" });
        expect(unknown.error).toBe("无法识别坐标列。表头：name、tel（需要 经度/纬度，或 起点+终点 经纬度）");
        expect(unknown.header).toEqual(["name", "tel"]);
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
        const q: any = await loadOne(ws, { path: "quoted.csv" });
        expect(q.geojson.features[0].properties.名称).toBe("A,B");
        expect(q.geojson.features[1].properties.名称).toBe('C"D');

        // 制表符
        fs.writeFileSync(path.join(ws, "tsv.csv"), [
          "名称\t经度\t纬度",
          "A\t120.1\t29.3",
          "B\t120.2\t29.4",
        ].join("\n"));
        const t: any = await loadOne(ws, { path: "tsv.csv" });
        expect(t.geojson.features.length).toBe(2);

        // 自动挑选：a.csv 先写、b.geojson 后写（mtime 更新），省略 path 应选 b
        fs.writeFileSync(path.join(ws, "a.csv"), "经度,纬度\n120,29\n120.1,29.1\n");
        fs.writeFileSync(path.join(ws, "b.geojson"), JSON.stringify({ type: "FeatureCollection", features: [] }));
        fs.utimesSync(path.join(ws, "a.csv"), new Date(1000000000000), new Date(1000000000000));
        fs.utimesSync(path.join(ws, "b.geojson"), new Date(2000000000000), new Date(2000000000000));
        const auto: any = await loadOne(ws, {});
        expect(auto.title).toBe("b");
        // 交换 mtime → 选 a
        fs.utimesSync(path.join(ws, "a.csv"), new Date(3000000000000), new Date(3000000000000));
        const auto2: any = await loadOne(ws, {});
        expect(auto2.title).toBe("a");
      } finally { rmWs(ws); }
    });

    it("空 workspace 参数回落真实工作区（getWorkspace 兜底语义）", async () => {
      const r: any = await mod.vis.loadSource("local-file", { workspace: "" });
      // 当前真实工作区根目录无 CSV/GeoJSON 时给出明确错误；有则产出描述符
      expect(r.error === undefined || typeof r.error === "string").toBe(true);
    });
  });

  it("bundled-xinchang：四 kind + 非法 kind 默认 stations", async () => {
    for (const kind of ["routes", "stations", "od", "stats", undefined, "bogus"]) {
      const r: any = await mod.vis.loadSource("bundled-xinchang", { kind });
      expect(r.error).toBeUndefined();
    }
    const stations: any = await mod.vis.loadSource("bundled-xinchang", { kind: "stations" });
    expect(stations.id).toBe("m3-bus-stations");
    expect(stations.kind).toBe("points");
    expect(stations.geojson.features.length).toBeGreaterThan(0);
  });
});
