/**
 * 地图报告成文（G8）回归：图片尺寸探测、报告组装、docx 内容断言、路径越界拒绝。
 * 运行：node scripts/map-report-test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildMapReport, normalizeSections, probeImageSize } from "../server/map-report.mjs";

// 1x1 PNG / 1x1 JPEG（最小合法字节，用于探测与嵌入断言）
const PNG_1PX_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const JPG_1PX_BASE64 = "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-report-"));
const pngFile = path.join(tempDir, "dot.png");
const jpgFile = path.join(tempDir, "dot.jpg");
fs.writeFileSync(pngFile, Buffer.from(PNG_1PX_BASE64, "base64"));
fs.writeFileSync(jpgFile, Buffer.from(JPG_1PX_BASE64, "base64"));

// 1. 尺寸探测
{
  const png = probeImageSize(pngFile);
  assert.deepEqual([png.width, png.height, png.format], [1, 1, "png"]);
  const jpg = probeImageSize(jpgFile);
  assert.equal(jpg.format, "jpg");
  assert.equal(jpg.width, 1);
  assert.equal(jpg.height, 1);
  assert.equal(probeImageSize(path.join(tempDir, "missing.png")), null);
  console.log("  ✓ 图片尺寸探测（PNG IHDR / JPEG SOF / 缺文件兜底）");
}

// 2. 章节规范化：截断与空值过滤
{
  const blocks = normalizeSections([
    { heading: "结论", bullets: ["  要点一 ", "", "x".repeat(400)], text: "正文", table: { headers: ["指标", "值"], rows: [["要素数", "12"], "非数级行"] } },
    { heading: "" },
  ]);
  assert.equal(blocks[0].type, "h2");
  assert.equal(blocks[1].text, "• 要点一");
  assert.ok(blocks.find((b) => b.type === "table" && b.rows[1][1] === "12"));
  assert.ok(blocks.find((b) => b.type === "table" && b.rows[2][0] === "非数级行"));
  console.log("  ✓ 章节规范化（bullet/表格/空节过滤）");
}

// 3. 报告组装：docx 落盘 + 内容断言（含嵌入图片）
{
  const result = await buildMapReport({
    workspace: tempDir,
    title: "测试标题：通勤分析",
    project: "zhejiang-map",
    sections: [{ heading: "分析结论", text: "核心区覆盖率达 78%。", table: { headers: ["指标", "值"], rows: [["要素数", "12"], ["覆盖率", "78%"]] } }],
    images: ["dot.png", "dot.jpg", "不存在.png"],
  });
  assert.ok(fs.existsSync(result.file));
  assert.equal(result.images, 2, "不存在的图片应被跳过");
  assert.equal(result.engine, "native");

  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(fs.readFileSync(result.file));
  const documentXml = await zip.file("word/document.xml").async("string");
  assert.ok(documentXml.includes("测试标题：通勤分析"), "标题应写入正文");
  assert.ok(documentXml.includes("核心区覆盖率达 78%。"), "段落应写入正文");
  assert.ok(documentXml.includes("覆盖率"), "表格应写入正文");
  assert.ok(documentXml.includes("图集"), "图集清单应写入正文");
  const mediaFiles = Object.keys(zip.files).filter((name) => name.startsWith("word/media/") && !name.endsWith("/"));
  assert.equal(mediaFiles.length, 2, "两张图片应作为 media 嵌入");
  console.log(`  ✓ 报告组装（blocks=${result.blocks}，media=${mediaFiles.length}）`);
}

// 4. 路径越界拒绝
{
  await assert.rejects(
    () => buildMapReport({ workspace: tempDir, title: "越界", images: ["../outside.png"] }),
    /越界/,
  );
  await assert.rejects(
    () => buildMapReport({ workspace: path.join(tempDir, "不存在目录"), title: "x" }),
    /工作区/,
  );
  console.log("  ✓ 路径越界与非法工作区拒绝");
}

fs.rmSync(tempDir, { recursive: true, force: true });
console.log("地图报告回归：通过");
