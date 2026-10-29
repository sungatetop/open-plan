/**
 * S3-5 map-report 域：probeImageSize 零依赖尺寸探测（PNG IHDR / JPEG SOF 直命中·
 * 跳段后命中·损坏·缺失）/ normalizeSections 章节规范化全分支（截断/空跳过/非串归一/
 * 表格三拒绝）/ buildMapReport 报告组装（工作区校验·越界拒绝·图集缩放与缺图跳过·
 * 文件名清洗与时间戳）。
 *
 * R6-7a 对拍退役改写：旧侧 server/map-report.mjs 物理路径动态 import
 * （pathToFileURL）随 server/ 退役删除（等价性已在 S3-5 批对拍验收冻结），仅保留
 * modern 静态 import src/main/backend/map-report.ts 的同一套绝对断言。
 * 真实 IO tmp 工作区。map-report 无模块加载期 env 锚点依赖，免 stubEnv。
 * 文件名时间戳与 meta 生成时间冻结 Date（fake timers toFake:["Date"]）；断言读回结构
 * 而非产物字节（OOXML 容器内嵌时间戳必不同）。蓝本 scripts/map-report-test.mjs
 * （旧回归脚本不迁移，随域退役）。
 */
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as modern from "../src/main/backend/map-report";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const IMPLS = ["modern"] as const;
type ImplKind = (typeof IMPLS)[number];

function pngBuffer(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  Buffer.from("IHDR", "ascii").copy(buf, 12);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf[24] = 8; // bit depth
  return buf;
}

function jpegBuffer(width: number, height: number, { appSegment = false } = {}): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  if (appSegment) {
    const app0 = Buffer.alloc(18);
    app0[0] = 0xff; app0[1] = 0xe0; // APP0，长度 16，SOF 扫描应跳过
    app0.writeUInt16BE(16, 2);
    Buffer.from("JFIF\0", "ascii").copy(app0, 4);
    parts.push(app0);
  }
  const sof = Buffer.alloc(15);
  sof[0] = 0xff; sof[1] = 0xc0; // SOF0
  sof.writeUInt16BE(0x11, 2);
  sof[4] = 8; // precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  parts.push(sof);
  return Buffer.concat(parts);
}

describe.each(IMPLS)("map-report: %s", (kind: ImplKind) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), `s3mr-${kind}-`));
  let impl: any;

  beforeAll(async () => {
    impl = modern;
    fs.writeFileSync(path.join(ws, "大图.png"), pngBuffer(960, 400));
    fs.writeFileSync(path.join(ws, "小图.png"), pngBuffer(100, 50));
    fs.writeFileSync(path.join(ws, "照片.jpg"), jpegBuffer(500, 300));
    fs.writeFileSync(path.join(ws, "带段.jpg"), jpegBuffer(640, 480, { appSegment: true }));
    fs.writeFileSync(path.join(ws, "非图.txt"), Buffer.from("plain text, not an image"));
    // 文件名时间戳与 meta「生成时间」双侧一致：冻结 Date（toLocaleString/toISOString 同源）
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-24T02:00:00Z"));
  });

  afterAll(() => {
    vi.useRealTimers();
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
  });

  // ---- probeImageSize ----
  it("probeImageSize：PNG IHDR / JPEG SOF 直命中与跳段命中", () => {
    expect(impl.probeImageSize(path.join(ws, "大图.png"))).toEqual({ width: 960, height: 400, format: "png" });
    expect(impl.probeImageSize(path.join(ws, "小图.png"))).toEqual({ width: 100, height: 50, format: "png" });
    expect(impl.probeImageSize(path.join(ws, "照片.jpg"))).toEqual({ width: 500, height: 300, format: "jpg" });
    expect(impl.probeImageSize(path.join(ws, "带段.jpg"))).toEqual({ width: 640, height: 480, format: "jpg" });
  });

  it("probeImageSize：非图/空文件/缺失 → null", () => {
    expect(impl.probeImageSize(path.join(ws, "非图.txt"))).toBeNull();
    const empty = path.join(ws, "空.png");
    fs.writeFileSync(empty, Buffer.alloc(0));
    expect(impl.probeImageSize(empty)).toBeNull();
    expect(impl.probeImageSize(path.join(ws, "不存在.png"))).toBeNull();
  });

  // ---- normalizeSections ----
  it("normalizeSections：空输入/全字段章节/空标题跳过/空要点跳过", () => {
    expect(impl.normalizeSections([])).toEqual([]);
    expect(impl.normalizeSections()).toEqual([]);
    const full = [{ heading: "现状评估", bullets: ["人口 120 万", 42], text: "  结论段落。  ", table: { headers: ["指标", "值"], rows: [["人口", "120 万"], [null, "—"]] } }];
    expect(impl.normalizeSections(full as any)).toEqual([
      { type: "h2", text: "现状评估" },
      { type: "paragraph", text: "• 人口 120 万" },
      { type: "paragraph", text: "• 42" },
      { type: "paragraph", text: "结论段落。" },
      { type: "table", rows: [["指标", "值"], ["人口", "120 万"], ["", "—"]] },
    ]);
    expect(impl.normalizeSections([{ heading: "   " }, { bullets: ["", null], text: "" }, { table: { headers: [], rows: [["x"]] } }, { table: { headers: ["a"], rows: "not-array" } }] as any)).toEqual([]);
  });

  it("normalizeSections：越界截断（21 章节/80 标题/12 要点/300 要点/2000 文本/8 表头/50 行/8 单元格/非数组行归一）", () => {
    const heading = "标".repeat(100);
    const bullet = "要".repeat(400);
    const text = "文".repeat(3000);
    const cell = "格".repeat(60);
    const sections: any[] = Array.from({ length: 21 }, () => ({ heading, bullets: Array.from({ length: 13 }, () => bullet), text, table: { headers: Array.from({ length: 9 }, () => cell), rows: Array.from({ length: 51 }, () => Array.from({ length: 9 }, () => cell).concat(["extra"])) } }));
    sections.push({ heading: "第 21 节" });
    const blocks = impl.normalizeSections(sections);
    // 20 章节 ×（1 h2 + 12 要点 + 1 段落 + 1 表格块） = 300
    expect(blocks.length).toBe(300);
    expect(blocks[0]).toEqual({ type: "h2", text: "标".repeat(80) });
    expect(blocks[1]).toEqual({ type: "paragraph", text: `• ${"要".repeat(300)}` });
    expect(blocks[13]).toEqual({ type: "paragraph", text: "文".repeat(2000) });
    expect(blocks[14]).toEqual({
      type: "table",
      rows: [Array.from({ length: 8 }, () => "格".repeat(40)), ...Array.from({ length: 50 }, () => Array.from({ length: 8 }, () => "格".repeat(40)))],
    });
    expect(blocks.filter((b: any) => b.type === "h2" && b.text === "第 21 节").length).toBe(0);
    // 非数组行 → [row] 单列归一，截 8
    const ragged = impl.normalizeSections([{ table: { headers: ["h1", "h2", "h3"], rows: ["标量行", ["a", "b"]] } }] as any);
    expect(ragged).toEqual([{ type: "table", rows: [["h1", "h2", "h3"], ["标量行"], ["a", "b"]] }]);
  });

  // ---- buildMapReport ----
  it("buildMapReport：工作区不存在/是文件 → 拒绝；图片越界 → 拒绝（文案逐字）", async () => {
    await expect(impl.buildMapReport({ workspace: path.join(ws, "不存在目录") })).rejects.toThrow("工作区不存在或不是文件夹");
    await expect(impl.buildMapReport({ workspace: path.join(ws, "非图.txt") })).rejects.toThrow("工作区不存在或不是文件夹");
    await expect(impl.buildMapReport({ workspace: ws, images: ["../越界.png"] })).rejects.toThrow("图片路径越界：../越界.png");
  });

  it("buildMapReport：无图集 → h1+meta+提示段，文件名含冻结时间戳", async () => {
    const result = await impl.buildMapReport({ workspace: ws, title: "现状评估报告", project: "城市更新", sections: [{ heading: "结论", bullets: ["推进有序"], text: "总体可控。" }] });
    expect(result.engine).toBe("native");
    expect(result.images).toBe(0);
    expect(result.blocks).toBe(6); // h1 + meta 表 + h2 + 要点 + 段落 + 无图集提示
    // 旧码仅剥 [:T]，日期连字符保留：2026-10-24T02:00:00 → 2026-10-24020000
    expect(path.basename(result.file)).toBe(`现状评估报告-2026-10-24020000.docx`);
    expect(fs.existsSync(result.file)).toBe(true);
    expect(fs.statSync(result.file).size).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(ws, path.basename(result.file)))).toBe(true);
  });

  it("buildMapReport：图集缩放（960→480 等比）与小图原尺寸、缺图/非图跳过、fileName 清洗", async () => {
    const result = await impl.buildMapReport({
      workspace: ws,
      project: "演示",
      images: ["大图.png", "小图.png", "照片.jpg", "带段.jpg", "缺失.png", "非图.txt", "子目录/../大图.png"],
      fileName: "报 告/ v1:终*.docx",
      sections: [],
    });
    expect(result.engine).toBe("native");
    expect(result.images).toBe(5); // 4 张真实图 + 子目录穿越归一后的重复大图
    expect(result.blocks).toBe(9); // h1 + meta 表 + 图集 h2 + 图集表 + 5 image
    expect(path.basename(result.file)).toBe(`报 告- v1-终-.docx-2026-10-24020000.docx`);
    expect(fs.existsSync(result.file)).toBe(true);
    expect(fs.statSync(result.file).size).toBeGreaterThan(0);
  });

  it("buildMapReport：默认标题/空 sections（结果形状锚点）", async () => {
    const result = await impl.buildMapReport({ workspace: ws, images: ["小图.png"] });
    expect(result.images).toBe(1);
    expect(result.blocks).toBe(5); // h1 + meta + 图集 h2 + 图集表 + 1 image（无 sections 无提示段）
    expect(Object.keys(result).sort()).toEqual(["blocks", "engine", "file", "images"]);
    expect(path.basename(result.file)).toMatch(/^地图分析报告-\d{4}-\d{2}-\d{2}\d{6}\.docx$/);
  });
});
