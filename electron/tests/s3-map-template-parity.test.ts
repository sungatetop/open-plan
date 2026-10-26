/**
 * S3-6 map-template 域对拍：OD_TEMPLATE_ID / bandOdFlows 带宽分级纯函数（空输入 /
 * 分位数边界与计数自洽 / TOP 降序标签 / 无名坐标回退 / bands 钳制 2-6 / 非 LineString
 * 忽略、非数值流量归零）/ runOdCommuterTemplate 编排端到端（OD CSV → 分级 + TOP +
 * Word 报告落盘 / 缺 path / 点数据拒绝 / 路径越界 / 无效工作区）。
 *
 * 真实 IO 双跑：legacy pathToFileURL 物理加载 server/map-template.mjs、modern 静态
 * import src/main/backend/map-template.ts，双侧各自 tmp 工作区同套断言。local-file
 * 适配器经 traffic-sources 导入即注册（registerSource 按 id set 幂等），beforeAll
 * 物理路径注册 legacy 链（相对 import 同实例）、TS traffic-sources 注册 modern 链
 * （S3-9 起 modern map-template 走 TS map-visualization）。report.file/fileName 含
 * 时间戳，仅逐侧断言格式与落盘（docx zip 内文本）；bands/descriptor/title/blocks
 * 确定性面做双侧同输入 deep-equal（descriptor.id 由文件名派生，确定性）。无模块加载
 * 期 env 锚点，免 stubEnv。蓝本 scripts/map-template-test.mjs（旧回归脚本不迁移，
 * 随域退役）。
 */
import { describe, expect, it, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as modern from "../src/main/backend/map-template";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "../..");

const IMPLS = ["legacy", "modern"] as const;
type ImplKind = (typeof IMPLS)[number];
type TplModule = typeof modern;

const mod = {} as Record<ImplKind, TplModule>;

beforeAll(async () => {
  // local-file 适配器注册（幂等）：物理路径注册 legacy 链（相对 import 同实例）、
  // TS traffic-sources 注册 modern 链（S3-9 起 modern 走 TS map-visualization）
  await import(pathToFileURL(path.join(PROJECT_ROOT, "server/traffic-sources.mjs")).href);
  await import("../src/main/backend/traffic-sources");
  mod.legacy = await import(pathToFileURL(path.join(PROJECT_ROOT, "server/map-template.mjs")).href) as TplModule;
  mod.modern = modern;
});

const OD_CSV = [
  "oname,olng,olat,dname,dlng,dlat,flow",
  "义乌,120.07,29.31,金华,119.65,29.08,300",
  "义乌,120.07,29.31,杭州,120.16,30.29,520",
  "义乌,120.07,29.31,绍兴,120.58,30.05,180",
  "杭州,120.16,30.29,宁波,121.55,29.87,410",
  "金华,119.65,29.08,温州,120.70,28.00,90",
].join("\n");

const mkLine = (o: number[], d: number[], flow: unknown, names: Record<string, unknown> = {}) => ({
  type: "Feature",
  properties: { flow, ...names },
  geometry: { type: "LineString", coordinates: [o, d] },
});

describe("S3-6 map-template 对拍", () => {
  it("OD_TEMPLATE_ID 双侧一致", () => {
    expect(mod.modern.OD_TEMPLATE_ID).toBe("od-commuter");
    expect(mod.legacy.OD_TEMPLATE_ID).toBe(mod.modern.OD_TEMPLATE_ID);
  });

  describe("bandOdFlows 带宽分级（纯函数，双侧）", () => {
    it.each(IMPLS)("空输入 → 全零结构（%s）", (kind) => {
      const r = mod[kind].bandOdFlows([]);
      expect(r.count).toBe(0);
      expect(r.levels).toEqual([]);
      expect(r.edges).toEqual([]);
      expect(r.topFlows).toEqual([]);
      expect(r.totalFlow).toBe(0);
    });

    it.each(IMPLS)("分位数边界与分级计数自洽（%s）", (kind) => {
      const flows = [10, 20, 30, 40, 50, 60, 70, 80];
      const features = flows.map((flow, i) => mkLine([120, 29 + i * 0.01], [121, 30], flow));
      const r = mod[kind].bandOdFlows(features, { bands: 4 });
      expect(r.count).toBe(8);
      expect(r.levels).toHaveLength(4);
      expect(r.levels.reduce((s: number, l: any) => s + l.count, 0)).toBe(8);
      expect(r.edges).toHaveLength(3);
      r.edges.forEach((e: number, i: number) => {
        if (i > 0) expect(e).toBeGreaterThanOrEqual(r.edges[i - 1]!);
      });
      expect(r.levels[0]!.from).toBe(10);
      expect(r.levels[3]!.to).toBeNull();
    });

    it.each(IMPLS)("TOP 流向按流量降序且带可读标签（%s）", (kind) => {
      const features = [
        mkLine([120, 29], [119.6, 29.1], 50, { oname: "义乌", dname: "金华" }),
        mkLine([120, 29], [120.2, 30.3], 300, { oname: "义乌", dname: "杭州" }),
        mkLine([120, 29], [121, 29.5], 120, { oname: "义乌", dname: "绍兴" }),
      ];
      const r = mod[kind].bandOdFlows(features, { top: 2 });
      expect(r.topFlows).toHaveLength(2);
      expect(r.topFlows[0]!.label).toBe("义乌 → 杭州");
      expect(r.topFlows[0]!.flow).toBe(300);
      expect(r.topFlows[1]!.flow).toBe(120);
    });

    it.each(IMPLS)("无名流向回退坐标标签（%s）", (kind) => {
      const r = mod[kind].bandOdFlows([mkLine([120.05, 29.05], [121, 30], 9)], {});
      expect(r.topFlows[0]!.label).toMatch(/^120\.050,29\.050 → 121\.000,30\.000$/);
    });

    it.each(IMPLS)("bands 参数被钳制到 2-6（%s）", (kind) => {
      const features = Array.from({ length: 12 }, (_, i) => mkLine([120, 29], [121, 30], i + 1));
      expect(mod[kind].bandOdFlows(features, { bands: 99 }).levels).toHaveLength(6);
      expect(mod[kind].bandOdFlows(features, { bands: 0 }).levels).toHaveLength(2);
    });

    it.each(IMPLS)("非 LineString 要素被忽略（%s）", (kind) => {
      const r = mod[kind].bandOdFlows([
        { type: "Feature", properties: { flow: 5 }, geometry: { type: "Point", coordinates: [120, 29] } },
        mkLine([120, 29], [121, 30], 7),
      ]);
      expect(r.count).toBe(1);
    });
  });

  it("bandOdFlows 双侧同输入逐字节 JSON 相等（全分支矩阵）", () => {
    const quantileCase = [10, 20, 30, 40, 50, 60, 70, 80].map((flow, i) => mkLine([120, 29 + i * 0.01], [121, 30], flow));
    const namedCase = [
      mkLine([120, 29], [119.6, 29.1], 50, { oname: "义乌", dname: "金华" }),
      mkLine([120, 29], [120.2, 30.3], 300, { oname: "义乌", dname: "杭州" }),
      mkLine([120, 29], [121, 29.5], 120, { o: "义乌", d: "绍兴" }),
      mkLine([120, 29], [121.4, 30.8], 80, { 起点: "义乌", 终点: "湖州" }),
      mkLine([120, 29], [119.8, 30.9], 5),
    ];
    const mixedCase = [
      { type: "Feature", properties: { flow: 5 }, geometry: { type: "Point", coordinates: [120, 29] } },
      mkLine([120, 29], [121, 30], null),
      mkLine([120, 29], [121, 30.1], "42"),
      mkLine([120, 29], [121, 30.2], undefined),
      { type: "Feature", properties: { value: 66 }, geometry: { type: "LineString", coordinates: [[120, 29], [121.5, 30.5]] } },
      mkLine([120, 29], [121, 30.3], Number.NaN),
    ];
    const clampCase = Array.from({ length: 12 }, (_, i) => mkLine([120, 29], [121, 30], i + 1));
    const cases: Array<[any[], { bands?: number; top?: number } | undefined]> = [
      [[], undefined],
      [quantileCase, { bands: 4 }],
      [namedCase, { top: 3 }],
      [namedCase, undefined],
      [mixedCase, { bands: 5 }],
      [clampCase, { bands: 99 }],
      [clampCase, { bands: 0 }],
      [clampCase, { bands: 2 }],
      [clampCase, { bands: 6 }],
    ];
    for (const [features, opts] of cases) {
      const legacyJson = JSON.stringify(mod.legacy.bandOdFlows(features, opts as any));
      const modernJson = JSON.stringify(mod.modern.bandOdFlows(features, opts));
      expect(legacyJson).toBe(modernJson);
    }
  });

  describe("runOdCommuterTemplate 端到端（双侧真实 IO）", () => {
    it.each(IMPLS)("OD CSV → 分级 + TOP + Word 报告落盘（%s）", async (kind) => {
      const ws = fs.mkdtempSync(path.join(os.tmpdir(), `s3-6-${kind}-`));
      try {
        fs.writeFileSync(path.join(ws, "od.csv"), OD_CSV);
        const result = await mod[kind].runOdCommuterTemplate({ workspace: ws, path: "od.csv", project: "zhejiang-map" });
        expect(result.template).toBe("od-commuter");
        expect(result.title).toBe("OD 通勤分析（5 对流向）");
        expect(result.bands.count).toBe(5);
        expect(result.bands.topFlows[0]!.label).toBe("义乌 → 杭州");
        expect(result.descriptor).toEqual({ id: "file-od", kind: "flow", count: 5 });
        expect(fs.existsSync(result.report.file)).toBe(true);
        expect(result.report.fileName).toMatch(/^OD通勤分析-od-\d{4}-\d{2}-\d{2}\d{6}\.docx$/);
        expect(path.dirname(result.report.file)).toBe(ws);
        // 报告内容（docx zip 内文本断言，蓝本旧回归）
        const JSZip = (await import("jszip")).default;
        const zip = await JSZip.loadAsync(fs.readFileSync(result.report.file));
        const docXml = await zip.file("word/document.xml")!.async("string");
        expect(docXml).toContain("OD 通勤分析");
        expect(docXml).toContain("带宽分级");
        expect(docXml).toContain("义乌 → 杭州");
        expect(docXml).toContain("结论要点");
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });

    it.each(IMPLS)("缺 path → 可读错误（%s）", async (kind) => {
      const ws = fs.mkdtempSync(path.join(os.tmpdir(), `s3-6-${kind}-`));
      try {
        await expect(mod[kind].runOdCommuterTemplate({ workspace: ws })).rejects.toThrow(/缺少 path/);
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });

    it.each(IMPLS)("点数据（非 OD）→ 拒绝（%s）", async (kind) => {
      const ws = fs.mkdtempSync(path.join(os.tmpdir(), `s3-6-${kind}-`));
      try {
        fs.writeFileSync(path.join(ws, "points.csv"), "name,lng,lat,flow\nA,120.1,29.3,10\nB,120.2,29.4,20\n");
        await expect(mod[kind].runOdCommuterTemplate({ workspace: ws, path: "points.csv" })).rejects.toThrow(/不是 OD 形状/);
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });

    it.each(IMPLS)("路径越界由适配器拒绝（%s）", async (kind) => {
      const ws = fs.mkdtempSync(path.join(os.tmpdir(), `s3-6-${kind}-`));
      try {
        await expect(mod[kind].runOdCommuterTemplate({ workspace: ws, path: "../outside.csv" })).rejects.toThrow(/工作区内|不存在/);
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });

    it.each(IMPLS)("无效工作区 → 明确报错（%s）", async (kind) => {
      const ws = fs.mkdtempSync(path.join(os.tmpdir(), `s3-6-${kind}-`));
      try {
        await expect(mod[kind].runOdCommuterTemplate({ workspace: path.join(ws, "nope"), path: "od.csv" })).rejects.toThrow(/不存在|无法识别/);
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });

    it("确定性面双侧 deep-equal（template/title/bands/descriptor/blocks）", async () => {
      const results: Record<ImplKind, any> = {} as any;
      for (const kind of IMPLS) {
        const ws = fs.mkdtempSync(path.join(os.tmpdir(), `s3-6-x-${kind}-`));
        try {
          fs.writeFileSync(path.join(ws, "od.csv"), OD_CSV);
          const result = await mod[kind].runOdCommuterTemplate({ workspace: ws, path: "od.csv", project: "zhejiang-map" });
          results[kind] = {
            template: result.template,
            title: result.title,
            bands: result.bands,
            descriptor: result.descriptor,
            blocks: result.report.blocks,
          };
        } finally {
          fs.rmSync(ws, { recursive: true, force: true });
        }
      }
      expect(results.modern).toEqual(results.legacy);
    });
  });
});
