/**
 * 地图分析报告一键成文（G8，L3 交付层）。
 *
 * 口径：分析结论（sections：标题/要点/段落/数据表）+ 图集（工作区内已导出的报告图/截图）
 * → 复用原生文档引擎 buildDocxFromBlocks 直写 .docx，产物落在工作区根目录。
 * 路径安全：图片路径必须是工作区内相对路径（拒绝穿越）；尺寸探测零依赖（PNG IHDR / JPEG SOF 扫描）。
 */

import path from "node:path";
import fs from "node:fs";
import { buildDocxFromBlocks } from "./doc-engine.mjs";

/** 零依赖图片尺寸探测：PNG 读 IHDR，JPEG 逐段扫 SOF0/1/2。失败返回 null（引擎用默认 480x320）。 */
export function probeImageSize(file) {
  let buf;
  try {
    const fd = fs.openSync(file, "r");
    buf = Buffer.alloc(Math.min(64 * 1024, fs.fstatSync(fd).size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
  } catch {
    return null;
  }
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), format: "png" };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) { offset += 1; continue; }
      const marker = buf[offset + 1];
      const length = buf.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7), format: "jpg" };
      }
      offset += 2 + length;
    }
  }
  return null;
}

function sanitizeFileName(value) {
  return String(value || "地图分析报告")
    .replace(/[\\/:*?"<>|\r\n]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60) || "地图分析报告";
}

/** 章节规范化：[{heading, bullets[], text, table{headers,rows}}] → 引擎 blocks（含越界内容截断）。 */
export function normalizeSections(sections = []) {
  const blocks = [];
  for (const section of sections.slice(0, 20)) {
    const heading = String(section?.heading || "").trim().slice(0, 80);
    if (heading) blocks.push({ type: "h2", text: heading });
    const bullets = (Array.isArray(section?.bullets) ? section.bullets : []).slice(0, 12);
    for (const bullet of bullets) {
      const text = String(bullet ?? "").trim().slice(0, 300);
      if (text) blocks.push({ type: "paragraph", text: `• ${text}` });
    }
    const text = String(section?.text ?? "").trim().slice(0, 2000);
    if (text) blocks.push({ type: "paragraph", text });
    const table = section?.table;
    if (table && Array.isArray(table.headers) && Array.isArray(table.rows) && table.headers.length) {
      blocks.push({
        type: "table",
        rows: [
          table.headers.slice(0, 8).map((cell) => String(cell ?? "").slice(0, 40)),
          ...table.rows.slice(0, 50).map((row) => (Array.isArray(row) ? row : [row]).slice(0, 8).map((cell) => String(cell ?? "").slice(0, 40))),
        ],
      });
    }
  }
  return blocks;
}

/**
 * 组装并直写报告 docx。
 * @param {{workspace:string, title?:string, project?:string, sections?:Array, images?:string[], fileName?:string}} options
 * @returns {Promise<{file:string, blocks:number, images:number, engine:"native"}>}
 */
export async function buildMapReport(options = {}) {
  const workspace = path.resolve(String(options.workspace || ""));
  if (!workspace || !fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
    throw new Error("工作区不存在或不是文件夹");
  }
  const title = sanitizeFileName(options.title);
  const project = String(options.project || "").trim();
  const sections = Array.isArray(options.sections) ? options.sections : [];
  const imageEntries = [];
  for (const relative of (Array.isArray(options.images) ? options.images : []).slice(0, 12)) {
    const target = path.resolve(workspace, String(relative || ""));
    if (!target.startsWith(workspace)) throw new Error(`图片路径越界：${relative}`);
    if (!fs.existsSync(target)) continue;
    const size = probeImageSize(target);
    if (!size) continue;
    const scale = Math.min(1, 480 / Math.max(1, size.width));
    imageEntries.push({ relative: String(relative), path: target, width: Math.round(size.width * scale), height: Math.round(size.height * scale), format: size.format });
  }

  const blocks = [{ type: "h1", text: title }];
  const metaCells = [["项目", project || "（未指定）"], ["生成时间", new Date().toLocaleString("zh-CN", { hour12: false })], ["图集数量", String(imageEntries.length)]];
  blocks.push({ type: "table", rows: metaCells });

  const contentBlocks = normalizeSections(sections);
  if (contentBlocks.length) blocks.push(...contentBlocks);

  if (imageEntries.length) {
    blocks.push({ type: "h2", text: "图集" });
    blocks.push({ type: "table", rows: [["#", "文件", "尺寸"], ...imageEntries.map((item, index) => [String(index + 1), item.relative, `${item.width}×${item.height}`])] });
    for (const item of imageEntries) {
      blocks.push({ type: "image", path: item.path, width: item.width, height: item.height, format: item.format });
    }
  } else {
    blocks.push({ type: "paragraph", text: "（本轮未附带图集；可在导出报告图或截图后再次生成报告以嵌入图集。）" });
  }

  const fileName = `${options.fileName ? sanitizeFileName(options.fileName) : title}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.docx`;
  const target = path.join(workspace, fileName);
  const result = await buildDocxFromBlocks(target, blocks);
  return { ...result, images: imageEntries.length };
}
