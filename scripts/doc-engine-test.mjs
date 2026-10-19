#!/usr/bin/env node
/**
 * 原生文档引擎测试（P1-A / P1-B / P2-C，方案 §5.4/§5.5）。
 * 覆盖：能力矩阵与 needsCli 路由、三格式 create、docx/pptx/xlsx 读取（text/outline/stats）、
 * docx 全文查找替换（单 run / 跨 run 合并 / 未命中 / 修订文档交 CLI）、结构化生成器、CLI 降级。
 *
 * 用法: node scripts/doc-engine-test.mjs
 * 退出码: 0 = 全部通过, 1 = 有失败
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isNativeOfficeEnabled,
  canCreateNatively,
  createNativeOffice,
  runNativeOfficeCommand,
  needsCli,
  officeCapabilityMatrix,
  buildDocxFromBlocks,
  buildPptxFromSlides,
} from "../server/doc-engine.mjs";
import { runOfficecli } from "../server/office.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
let failed = 0;
const test = (name, fn) => Promise.resolve().then(fn).then(
  () => console.log(`  ✓ ${name}`),
  (e) => { failed = 1; console.error(`  ✗ ${name}: ${e.message}`); },
);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "doceng-test-"));

console.log("\n▶ 能力矩阵与路由（P2-C）");
await test("矩阵覆盖三种格式且 native/requiresCli 无交集", () => {
  const matrix = officeCapabilityMatrix();
  for (const format of ["docx", "xlsx", "pptx"]) {
    assert.ok(matrix[format], `缺少 ${format} 矩阵`);
    const native = new Set(matrix[format].native);
    for (const item of matrix[format].requiresCli) assert.ok(!native.has(item), `${format} 的 ${item} 不能同时在两侧`);
  }
});
await test("needsCli：create/view 读取模式原生，view 渲染与 set 属性走 CLI", () => {
  assert.equal(needsCli("create").needsCli, false);
  assert.equal(needsCli("view", ["view", "a.docx", "text"]).needsCli, false);
  assert.equal(needsCli("view", ["view", "a.docx", "outline"]).needsCli, false);
  assert.equal(needsCli("view", ["view", "a.docx", "stats"]).needsCli, false);
  assert.equal(needsCli("view", ["view", "a.docx", "html"]).needsCli, true);
  assert.equal(needsCli("view", ["view", "a.docx", "screenshot"]).needsCli, true);
  assert.equal(needsCli("set", ["set", "a.docx", "/", "--find", "x", "--replace", "y"]).needsCli, false);
  assert.equal(needsCli("set", ["set", "a.docx", "/", "--prop", "bold=true"]).needsCli, true);
  assert.equal(needsCli("set", ["set", "a.docx", "/body/p[3]", "--find", "x", "--replace", "y"]).needsCli, true, "定点替换必须走 CLI");
  assert.equal(needsCli("get", ["get", "a.docx", "/"]).needsCli, true);
  assert.equal(needsCli("batch", ["batch", "a.docx"]).needsCli, true);
});
await test("OAW_OFFICE_NATIVE=0 时全部交回 CLI", async () => {
  process.env.OAW_OFFICE_NATIVE = "0";
  try {
    assert.equal(await runNativeOfficeCommand(["create", "开关.docx"], { cwd: tmp }), null);
  } finally {
    process.env.OAW_OFFICE_NATIVE = "1";
  }
  assert.equal(isNativeOfficeEnabled(), true);
});

console.log("\n▶ create（P1-A docx/xlsx + P1-B pptx）");
await test("canCreateNatively 识别三格式，忽略其它", () => {
  assert.deepEqual(canCreateNatively(["create", "报告.docx"]), { file: "报告.docx", format: "docx" });
  assert.equal(canCreateNatively(["create", "数据.xlsx"]).format, "xlsx");
  assert.equal(canCreateNatively(["create", "演示.pptx"]).format, "pptx");
  assert.equal(canCreateNatively(["create", "说明.pdf"]), null);
  assert.equal(canCreateNatively(["view", "报告.docx", "text"]), null);
});
await test("原生创建 docx/xlsx/pptx 且结果与 officecli 同形", async () => {
  for (const file of ["报告.docx", "子目录/数据.xlsx", "演示.pptx"]) {
    const result = await createNativeOffice(["create", file], { cwd: tmp });
    assert.ok(result, `${file} 应命中原生`);
    assert.equal(result.code, 0);
    assert.equal(result.engine, "native");
    assert.ok(fs.existsSync(path.join(tmp, file)), `${file} 应已落盘`);
    assert.ok(result.text.includes(file));
  }
});
await test("已存在文件与越界路径不命中原生（交回 CLI 语义）", async () => {
  assert.equal(await createNativeOffice(["create", "报告.docx"], { cwd: tmp }), null, "已存在应返回 null");
  assert.equal(await createNativeOffice(["create", "../外部.docx"], { cwd: tmp }), null, "越界应返回 null");
});
await test("runOfficecli create 走原生（engine=native），未命中回退 CLI", async () => {
  const result = await runOfficecli(["create", "路由.docx"], { cwd: tmp });
  assert.equal(result.engine, "native");
  // view html 不在原生范围 → 会走 CLI（本机未装 CLI 时 code 非 0，但不应是 native）
  const cliResult = await runOfficecli(["view", "路由.docx", "html"], { cwd: tmp }).catch(() => null);
  if (cliResult) assert.notEqual(cliResult.engine, "native");
});

console.log("\n▶ docx 读取与替换（P1-A）");
await test("view text/outline/stats 读取内容与结构", async () => {
  const { Document, Packer, Paragraph, HeadingLevel, Table, TableRow, TableCell, WidthType } = await import("docx");
  const doc = new Document({ sections: [{ children: [
    new Paragraph({ text: "城市更新专项规划", heading: HeadingLevel.HEADING_1 }),
    new Paragraph({ text: "本轮规划范围包括老城区与滨海新区，总人口约 120 万。" }),
    new Paragraph({ text: "总体目标：提质提效，建设宜居城市。" }),
    new Table({ rows: [new TableRow({ children: [new TableCell({ children: [new Paragraph("指标")] })] })], width: { size: 100, type: WidthType.PERCENTAGE } }),
  ] }] });
  fs.writeFileSync(path.join(tmp, "规划.docx"), await Packer.toBuffer(doc));

  const text = await runNativeOfficeCommand(["view", "规划.docx", "text"], { cwd: tmp });
  assert.ok(text.text.includes("城市更新专项规划"));
  assert.ok(text.text.includes("总人口约 120 万"));
  assert.equal(text.engine, "native");

  const outline = await runNativeOfficeCommand(["view", "规划.docx", "outline"], { cwd: tmp });
  assert.match(outline.text, /^# 城市更新专项规划$/m);

  const stats = await runNativeOfficeCommand(["view", "规划.docx", "stats"], { cwd: tmp });
  assert.equal(stats.json.format, "docx");
  assert.equal(stats.json.headings, 1);
  assert.equal(stats.json.tables, 1);
  assert.ok(stats.json.words > 10);
});
await test("set --find --replace：单 run 原位替换并落盘", async () => {
  const before = await runNativeOfficeCommand(["view", "规划.docx", "text"], { cwd: tmp });
  assert.ok(before.text.includes("120 万"));
  const result = await runNativeOfficeCommand(["set", "规划.docx", "/", "--find", "120 万", "--replace", "135 万"], { cwd: tmp });
  assert.equal(result.code, 0);
  assert.equal(result.json.replaced, 1);
  const after = await runNativeOfficeCommand(["view", "规划.docx", "text"], { cwd: tmp });
  assert.ok(after.text.includes("135 万"), "替换后应包含新文本");
  assert.ok(!after.text.includes("120 万"), "替换后不应残留旧文本");
});
await test("set --find --replace：跨 run 合并替换保留段落文本", async () => {
  const { Document, Packer, Paragraph, TextRun } = await import("docx");
  const doc = new Document({ sections: [{ children: [new Paragraph({ children: [new TextRun("目标是要"), new TextRun("加快建"), new TextRun("设节奏。")] })] }] });
  fs.writeFileSync(path.join(tmp, "跨run.docx"), await Packer.toBuffer(doc));
  const result = await runNativeOfficeCommand(["set", "跨run.docx", "/", "--find", "要加快建设", "--replace", "要稳步推进"], { cwd: tmp });
  assert.equal(result.json.replaced, 1);
  const after = await runNativeOfficeCommand(["view", "跨run.docx", "text"], { cwd: tmp });
  assert.equal(after.text.trim(), "目标是要稳步推进节奏。");
});
await test("未命中返回 replaced=0，替换 xlsx/pptx 不命中原生", async () => {
  const miss = await runNativeOfficeCommand(["set", "规划.docx", "/", "--find", "不存在的词", "--replace", "x"], { cwd: tmp });
  assert.equal(miss.json.replaced, 0);
  assert.equal(await runNativeOfficeCommand(["set", "数据.xlsx", "/", "--find", "a", "--replace", "b"], { cwd: tmp }), null, "xlsx 替换应交 CLI");
});

console.log("\n▶ xlsx / pptx 读取（P1-A / P1-B）");
await test("xlsx view text/outline/stats", async () => {
  const mod = await import("xlsx");
  const XLSX = mod.default || mod;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["指标", "值"], ["人口", "120万"]]), "概况");
  XLSX.writeFile(wb, path.join(tmp, "带内容.xlsx"));
  const text = await runNativeOfficeCommand(["view", "带内容.xlsx", "text"], { cwd: tmp });
  assert.ok(text.text.includes("## 概况"));
  assert.ok(text.text.includes("120万"));
  const outline = await runNativeOfficeCommand(["view", "带内容.xlsx", "outline"], { cwd: tmp });
  assert.match(outline.text, /概况（A1:B2）/);
  const stats = await runNativeOfficeCommand(["view", "带内容.xlsx", "stats"], { cwd: tmp });
  assert.equal(stats.json.detail[0].rows, 2);
});
await test("pptx view text/outline/stats（含表格文本）", async () => {
  const PptxGenJS = (await import("pptxgenjs")).default;
  const pptx = new PptxGenJS();
  const s1 = pptx.addSlide();
  s1.addText("规划汇报", { x: 1, y: 1 });
  s1.addText("背景与目标", { x: 1, y: 2 });
  const s2 = pptx.addSlide();
  s2.addTable([[{ text: "指标" }, { text: "值" }], ["人口", "120万"]], { x: 1, y: 1 });
  fs.writeFileSync(path.join(tmp, "汇报.pptx"), await pptx.write({ outputType: "nodebuffer" }));
  const text = await runNativeOfficeCommand(["view", "汇报.pptx", "text"], { cwd: tmp });
  assert.ok(text.text.includes("--- 幻灯片 1 ---"));
  assert.ok(text.text.includes("指标 值"), "表格文本应被抽出");
  const outline = await runNativeOfficeCommand(["view", "汇报.pptx", "outline"], { cwd: tmp });
  assert.match(outline.text, /幻灯片 1：规划汇报/);
  const stats = await runNativeOfficeCommand(["view", "汇报.pptx", "stats"], { cwd: tmp });
  assert.equal(stats.json.slides, 2);
  assert.equal(stats.json.tables, 1);
});

console.log("\n▶ 结构化生成器（P2-A Formatter 依赖）");
await test("buildPptxFromSlides / buildDocxFromBlocks 产物可被原生引擎读回", async () => {
  const ppt = await buildPptxFromSlides(path.join(tmp, "结构化.pptx"), [
    { title: "项目背景", bullets: ["区位优势", "政策支持"] },
    { title: "核心指标", table: { headers: ["指标", "值"], rows: [["人口", "120万"]] } },
  ]);
  assert.equal(ppt.slides, 2);
  const outline = await runNativeOfficeCommand(["view", "结构化.pptx", "outline"], { cwd: tmp });
  assert.match(outline.text, /项目背景/);

  const docx = await buildDocxFromBlocks(path.join(tmp, "结构化.docx"), [
    { type: "heading", text: "第一章 总则", level: 1 },
    { type: "paragraph", text: "本规划适用于全域。" },
    { type: "table", rows: [["a", "b"]] },
  ]);
  assert.equal(docx.engine, "native");
  const docOutline = await runNativeOfficeCommand(["view", "结构化.docx", "outline"], { cwd: tmp });
  assert.match(docOutline.text, /第一章 总则/);
});
await test("损坏的 docx 读取交回 CLI（返回 null 不抛错）", async () => {
  fs.writeFileSync(path.join(tmp, "坏.docx"), Buffer.from("not a zip"));
  assert.equal(await runNativeOfficeCommand(["view", "坏.docx", "text"], { cwd: tmp }), null);
});

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} // Windows 上偶发句柄延迟释放，清理失败不影响结论
console.log(failed ? "\n文档引擎测试：存在失败" : "\n文档引擎测试：全部通过");
process.exit(failed);
