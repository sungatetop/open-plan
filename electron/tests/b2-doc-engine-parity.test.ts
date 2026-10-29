/**
 * B2-13 doc-engine 域对拍：能力矩阵与 needsCli 路由 / OAW_OFFICE_NATIVE 总开关 /
 * canCreateNatively 五态 / createNativeOffice 三格式落盘+同形结果+已存在·越界拒绝 /
 * docx view text·outline·stats / set --find --replace（单 run 原位·跨 run 合并·未命中·
 * xlsx 交 CLI）/ xlsx·pptx view 三模式（pptx 含表格文本抽出）/ 结构化生成器
 * buildPptxFromSlides·buildDocxFromBlocks 生成+原生读回 / 损坏 docx 交回 CLI。
 *
 * 真实 IO（蓝本 scripts/doc-engine-test.mjs）：R6-7a 对拍退役改写——legacy 物理路径
 * 动态 import server/doc-engine.mjs 随 server/ 退役删除（等价性已在 B2-13 批对拍
 * 验收冻结），仅保留 modern 静态 import src/main/backend/doc-engine.ts 的同一套
 * 绝对断言。doc-engine 无模块加载期 env 锚点依赖（OAW_OFFICE_NATIVE/
 * OAW_DOC_ENGINE_DEBUG 均运行时读），免 stubEnv。fixture 用 docx/xlsx/pptxgenjs 纯 JS
 * 生成（electron 侧 docx/xlsx 为自身依赖，pptxgenjs 变量间接动态 import 从根
 * node_modules 解析）。蓝本的 runOfficecli 路由用例属 office 域接线，不在本域。
 * 断言读回的 text/json 行为而非产物字节（OOXML 容器内嵌时间戳双侧必不同）。
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as modern from "../src/main/backend/doc-engine";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const IMPLS = ["modern"] as const;
type ImplKind = (typeof IMPLS)[number];

describe.each(IMPLS)("doc-engine: %s", (kind: ImplKind) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), `b2de-${kind}-`));
  let impl: any;

  beforeAll(async () => {
    impl = modern;
    // ---- fixtures（与蓝本同构）----
    const { Document, Packer, Paragraph, HeadingLevel, Table, TableRow, TableCell, WidthType, TextRun } = await import("docx");
    fs.writeFileSync(path.join(ws, "规划.docx"), await Packer.toBuffer(new Document({ sections: [{ children: [
      new Paragraph({ text: "城市更新专项规划", heading: HeadingLevel.HEADING_1 }),
      new Paragraph({ text: "本轮规划范围包括老城区与滨海新区，总人口约 120 万。" }),
      new Paragraph({ text: "总体目标：提质提效，建设宜居城市。" }),
      new Table({ rows: [new TableRow({ children: [new TableCell({ children: [new Paragraph("指标")] })] })], width: { size: 100, type: WidthType.PERCENTAGE } }),
    ] }] })));
    fs.writeFileSync(path.join(ws, "跨run.docx"), await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph({ children: [new TextRun("目标是要"), new TextRun("加快建"), new TextRun("设节奏。")] })] }] })));
    const xlsxMod: any = await import("xlsx");
    const XLSX = xlsxMod.default || xlsxMod;
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["指标", "值"], ["人口", "120万"]]), "概况");
    XLSX.writeFile(wb, path.join(ws, "带内容.xlsx"));
    const pptxPkg = "pptxgenjs";
    const pptxMod: any = await import(pptxPkg);
    const PptxGenJS = pptxMod.default || pptxMod;
    const pptx = new PptxGenJS();
    const s1 = pptx.addSlide();
    s1.addText("规划汇报", { x: 1, y: 1 });
    s1.addText("背景与目标", { x: 1, y: 2 });
    const s2 = pptx.addSlide();
    s2.addTable([[{ text: "指标" }, { text: "值" }], ["人口", "120万"]], { x: 1, y: 1 });
    fs.writeFileSync(path.join(ws, "汇报.pptx"), await pptx.write({ outputType: "nodebuffer" }));
    fs.writeFileSync(path.join(ws, "坏.docx"), Buffer.from("not a zip"));
  });

  afterAll(() => {
    // Windows 上偶发句柄延迟释放，清理失败不影响结论
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
  });

  const run = (args: unknown[], cwd: string = ws): Promise<any> => impl.runNativeOfficeCommand(args, { cwd });

  it("矩阵覆盖三种格式且 native/requiresCli 无交集", () => {
    const matrix = impl.officeCapabilityMatrix();
    for (const format of ["docx", "xlsx", "pptx"]) {
      expect(matrix[format]).toBeTruthy();
      const native = new Set<string>(matrix[format].native);
      for (const item of matrix[format].requiresCli) expect(native.has(item)).toBe(false);
    }
  });

  it("needsCli：create/view 读取模式原生，view 渲染与 set 属性走 CLI", () => {
    expect(impl.needsCli("create").needsCli).toBe(false);
    expect(impl.needsCli("view", ["view", "a.docx", "text"]).needsCli).toBe(false);
    expect(impl.needsCli("view", ["view", "a.docx", "outline"]).needsCli).toBe(false);
    expect(impl.needsCli("view", ["view", "a.docx", "stats"]).needsCli).toBe(false);
    expect(impl.needsCli("view", ["view", "a.docx", "html"]).needsCli).toBe(true);
    expect(impl.needsCli("view", ["view", "a.docx", "screenshot"]).needsCli).toBe(true);
    expect(impl.needsCli("set", ["set", "a.docx", "/", "--find", "x", "--replace", "y"]).needsCli).toBe(false);
    expect(impl.needsCli("set", ["set", "a.docx", "/", "--prop", "bold=true"]).needsCli).toBe(true);
    expect(impl.needsCli("set", ["set", "a.docx", "/body/p[3]", "--find", "x", "--replace", "y"]).needsCli, "定点替换必须走 CLI").toBe(true);
    expect(impl.needsCli("get", ["get", "a.docx", "/"]).needsCli).toBe(true);
    expect(impl.needsCli("batch", ["batch", "a.docx"]).needsCli).toBe(true);
  });

  it("OAW_OFFICE_NATIVE=0 时全部交回 CLI，恢复后开关为 true", async () => {
    process.env.OAW_OFFICE_NATIVE = "0";
    try {
      expect(await run(["create", "开关.docx"])).toBeNull();
    } finally {
      process.env.OAW_OFFICE_NATIVE = "1";
    }
    expect(impl.isNativeOfficeEnabled()).toBe(true);
  });

  it("canCreateNatively 识别三格式，忽略其它", () => {
    expect(impl.canCreateNatively(["create", "报告.docx"])).toEqual({ file: "报告.docx", format: "docx" });
    expect(impl.canCreateNatively(["create", "数据.xlsx"]).format).toBe("xlsx");
    expect(impl.canCreateNatively(["create", "演示.pptx"]).format).toBe("pptx");
    expect(impl.canCreateNatively(["create", "说明.pdf"])).toBeNull();
    expect(impl.canCreateNatively(["view", "报告.docx", "text"])).toBeNull();
  });

  it("原生创建 docx/xlsx/pptx 且结果与 officecli 同形", async () => {
    for (const file of ["报告.docx", "子目录/数据.xlsx", "演示.pptx"]) {
      const result = await impl.createNativeOffice(["create", file], { cwd: ws });
      expect(result, `${file} 应命中原生`).toBeTruthy();
      expect(result.code).toBe(0);
      expect(result.engine).toBe("native");
      expect(fs.existsSync(path.join(ws, file)), `${file} 应已落盘`).toBe(true);
      expect(result.text).toContain(file);
    }
  });

  it("已存在文件与越界路径不命中原生（交回 CLI 语义）", async () => {
    expect(await impl.createNativeOffice(["create", "报告.docx"], { cwd: ws })).toBeNull();
    expect(await impl.createNativeOffice(["create", "../外部.docx"], { cwd: ws })).toBeNull();
  });

  it("docx view text/outline/stats 读取内容与结构", async () => {
    const text = await run(["view", "规划.docx", "text"]);
    expect(text.text).toContain("城市更新专项规划");
    expect(text.text).toContain("总人口约 120 万");
    expect(text.engine).toBe("native");

    const outline = await run(["view", "规划.docx", "outline"]);
    expect(outline.text).toMatch(/^# 城市更新专项规划$/m);

    const stats = await run(["view", "规划.docx", "stats"]);
    expect(stats.json.format).toBe("docx");
    expect(stats.json.headings).toBe(1);
    expect(stats.json.tables).toBe(1);
    expect(stats.json.words).toBeGreaterThan(10);
  });

  it("set --find --replace：单 run 原位替换并落盘", async () => {
    const before = await run(["view", "规划.docx", "text"]);
    expect(before.text).toContain("120 万");
    const result = await run(["set", "规划.docx", "/", "--find", "120 万", "--replace", "135 万"]);
    expect(result.code).toBe(0);
    expect(result.json.replaced).toBe(1);
    const after = await run(["view", "规划.docx", "text"]);
    expect(after.text).toContain("135 万");
    expect(after.text).not.toContain("120 万");
  });

  it("set --find --replace：跨 run 合并替换保留段落文本", async () => {
    const result = await run(["set", "跨run.docx", "/", "--find", "要加快建设", "--replace", "要稳步推进"]);
    expect(result.json.replaced).toBe(1);
    const after = await run(["view", "跨run.docx", "text"]);
    expect(after.text.trim()).toBe("目标是要稳步推进节奏。");
  });

  it("未命中返回 replaced=0，替换 xlsx 不命中原生", async () => {
    const miss = await run(["set", "规划.docx", "/", "--find", "不存在的词", "--replace", "x"]);
    expect(miss.json.replaced).toBe(0);
    expect(await run(["set", "数据.xlsx", "/", "--find", "a", "--replace", "b"])).toBeNull();
  });

  it("xlsx view text/outline/stats", async () => {
    const text = await run(["view", "带内容.xlsx", "text"]);
    expect(text.text).toContain("## 概况");
    expect(text.text).toContain("120万");
    const outline = await run(["view", "带内容.xlsx", "outline"]);
    expect(outline.text).toMatch(/概况（A1:B2）/);
    const stats = await run(["view", "带内容.xlsx", "stats"]);
    expect(stats.json.detail[0].rows).toBe(2);
  });

  it("pptx view text/outline/stats（含表格文本抽出）", async () => {
    const text = await run(["view", "汇报.pptx", "text"]);
    expect(text.text).toContain("--- 幻灯片 1 ---");
    expect(text.text).toContain("指标 值");
    const outline = await run(["view", "汇报.pptx", "outline"]);
    expect(outline.text).toMatch(/幻灯片 1：规划汇报/);
    const stats = await run(["view", "汇报.pptx", "stats"]);
    expect(stats.json.slides).toBe(2);
    expect(stats.json.tables).toBe(1);
  });

  it("buildPptxFromSlides / buildDocxFromBlocks 产物可被原生引擎读回", async () => {
    const ppt = await impl.buildPptxFromSlides(path.join(ws, "结构化.pptx"), [
      { title: "项目背景", bullets: ["区位优势", "政策支持"] },
      { title: "核心指标", table: { headers: ["指标", "值"], rows: [["人口", "120万"]] } },
    ]);
    expect(ppt.slides).toBe(2);
    const outline = await run(["view", "结构化.pptx", "outline"]);
    expect(outline.text).toMatch(/项目背景/);

    const docx = await impl.buildDocxFromBlocks(path.join(ws, "结构化.docx"), [
      { type: "heading", text: "第一章 总则", level: 1 },
      { type: "paragraph", text: "本规划适用于全域。" },
      { type: "table", rows: [["a", "b"]] },
    ]);
    expect(docx.engine).toBe("native");
    const docOutline = await run(["view", "结构化.docx", "outline"]);
    expect(docOutline.text).toMatch(/第一章 总则/);
  });

  it("损坏的 docx 读取交回 CLI（返回 null 不抛错）", async () => {
    expect(await run(["view", "坏.docx", "text"])).toBeNull();
  });
});
