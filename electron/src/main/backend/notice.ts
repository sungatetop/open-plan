/**
 * 红头会议通知生成器（notice.ts，S3-13 转录）。
 *
 * 逐行等价迁移自 server/notice.mjs；消费面：旧 index.mjs L437 动态 import
 * （POST /api/templates/generate-notice）。getWorkspace 直绑 TS workspace（B6-4 先例）。
 * 注意：当前仅对拍覆盖、未装配运行时；旧 JS 实现保留至域退役。
 *
 * 按公文版面规范（GB/T 9704 简化）用 docx 库生成红头会议通知：
 *   - 版头：发文机关全称 + 标题（红色 · 方正小标宋简体 · 加粗 · 居中）
 *   - 红线：版头下方红色下边框
 *   - 发文字号（居中）→ 主送机关（顶格）→ 正文（首行缩进 2 字符）
 *   - 通知事项（一、二、三、四…）→ 落款（右对齐机关 + 日期）
 * 输出：docx Buffer 写入当前工作区（文件名自动查重）
 */
import fs from "node:fs";
import path from "node:path";
import { Document, Packer, Paragraph, TextRun, AlignmentType, BorderStyle } from "docx";
import { getWorkspace } from "./workspace";

// 公文页边距（GB/T 9704-2012 近似，twips）：上 3.7cm 下 3.5cm 左 2.8cm 右 2.6cm
const MARGIN = { top: 2098, bottom: 1984, left: 1587, right: 1474 };

const RED = "E50000";
const BODY_SIZE = 32; // 3 号字 16pt = 32 half-points
const HEAD_SIZE = 44; // 版头 22pt
const TITLE_SIZE = 40; // 标题 20pt

// 旧模块为无类型 .mjs，入参形态宽松（对拍含 null/非数组 items 等防御形态），保持 any 入口
function redText(text: string, size: number, bold = true, font = "方正小标宋简体"): TextRun {
  return new TextRun({ text, bold, size, color: RED, font: { ascii: "Times New Roman", eastAsia: font } });
}

function bodyText(text: string, opts: { bold?: boolean; align?: (typeof AlignmentType)[keyof typeof AlignmentType]; indent?: boolean } = {}): Paragraph {
  const { bold = false, align, indent = true } = opts;
  return new Paragraph({
    alignment: align,
    indent: indent ? { firstLine: 640 } : undefined, // 首行缩进 2 字符（16pt×2=640 twips 近似）
    spacing: { line: 360 }, // 1.5 倍行距
    children: [new TextRun({ text, bold, size: BODY_SIZE, font: { ascii: "Times New Roman", eastAsia: "仿宋_GB2312" } })],
  });
}

/**
 * 生成红头会议通知 docx
 * @param p 入参（字段宽松，逐行语义见旧 notice.mjs JSDoc）：
 *   orgName 发文机关全称（版头红字）/ title 标题（默认「会议通知」）/
 *   docNo 发文字号 / recipients 主送机关 / intro 引言段（可选）/ items 通知事项数组 /
 *   signer 落款机关 / date 落款日期 / filePrefix 输出文件名前缀（默认「红头会议通知」）
 * @returns {name, absPath}
 */
export async function generateNotice(p: any): Promise<{ name: string; absPath: string }> {
  const orgName = String(p?.orgName || "").trim() || "××市人民政府办公室";
  const title = String(p?.title || "").trim() || "会议通知";
  const docNo = String(p?.docNo || "").trim();
  const recipients = String(p?.recipients || "").trim();
  const intro = String(p?.intro || "").trim() ||
    "为深入贯彻落实上级决策部署，经研究决定召开专题会议。现将有关事项通知如下：";
  const items = (Array.isArray(p?.items) ? p.items : []).map((x: any) => String(x).trim()).filter(Boolean);
  const signer = String(p?.signer || "").trim() || orgName;
  const now = new Date();
  const date = String(p?.date || "").trim() || `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
  const prefix = String(p?.filePrefix || "").trim() || "红头会议通知";

  const children: Paragraph[] = [
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { line: 400 }, children: [redText(orgName, HEAD_SIZE)] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { line: 400 }, children: [redText(title, TITLE_SIZE)] }),
    // 红线
    new Paragraph({
      border: { bottom: { style: BorderStyle.SINGLE, size: 18, color: RED } },
      spacing: { after: 240 },
    }),
  ];
  if (docNo) {
    children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 }, children: [new TextRun({ text: docNo, size: 22, font: { ascii: "Times New Roman", eastAsia: "仿宋_GB2312" } })] }));
  }
  if (recipients) children.push(bodyText(recipients, { indent: false }));
  children.push(bodyText(intro));
  const cnNums = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
  items.forEach((it: string, i: number) => {
    children.push(bodyText(`${cnNums[i] || i + 1}、${it}`));
  });
  children.push(new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { before: 300, line: 360 }, children: [new TextRun({ text: signer, size: BODY_SIZE, font: { ascii: "Times New Roman", eastAsia: "仿宋_GB2312" } })] }));
  children.push(new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { line: 360 }, children: [new TextRun({ text: date, size: BODY_SIZE, font: { ascii: "Times New Roman", eastAsia: "仿宋_GB2312" } })] }));

  const doc = new Document({
    sections: [{ properties: { page: { margin: MARGIN } }, children }],
  });
  const buf = await Packer.toBuffer(doc);

  // 写入工作区，文件名查重
  const ws = getWorkspace();
  const existing = fs.existsSync(ws) ? fs.readdirSync(ws) : [];
  let name = `${prefix}.docx`;
  let i = 2;
  while (existing.includes(name)) name = `${prefix} ${i++}.docx`;
  const absPath = path.join(ws, name);
  fs.writeFileSync(absPath, buf);
  return { name, absPath };
}
