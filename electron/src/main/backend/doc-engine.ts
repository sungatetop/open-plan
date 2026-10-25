/**
 * B2-13：原生文档引擎（P1-A / P1-B / P2-C，方案 §5.4/§5.5）——逐行等价迁移自
 * server/doc-engine.mjs。
 *
 * 用 Node 侧 OOXML 能力直接处理 .docx / .xlsx / .pptx，把最高频的
 * 「新建文档 / 读取文本大纲统计 / 全文查找替换」从外部 officecli 二进制分流出来
 * （消除进程冷启动与并发 1 瓶颈）；图表、透视表、修订跟踪、Morph 等长尾仍由 CLI 兜底。
 *
 * 对外契约（对模型透明）：
 *   - 工具名仍是 officecli，参数形状不变；本模块只做"这条命令能否原生执行"的判定与执行。
 *   - 结果与 runOfficecli 同形：{ code, stdout, stderr, text, json, command, engine:"native" }。
 *   - 未命中 / 原生异常一律返回 null（或由调用方回退 officecli），保证不因原生失败而中断。
 *
 * 路由矩阵（officeCapabilityMatrix，P2-C）：
 *   native: create(docx/xlsx/pptx)、view text|outline|stats(docx/pptx/xlsx)、
 *           set / --find --replace（docx，无修订跟踪时）
 *   cli:    get/query/batch/add/remove/move/swap/delete/import/export/open/close/save/
 *           validate/refresh/dump/watch、view 其余模式（html/svg/screenshot/annotated/
 *           issues/forms）、set 的属性/样式操作，以及图表/透视表/修订/Morph 等高级能力
 */
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";

/**
 * 变量间接动态 import（xlsx/docx/pptxgenjs）：保持与旧模块一致的运行时解析
 * （非字面量动态 import 不进 rollup bundle，electron 运行时从 node_modules 向上解析，
 * pptxgenjs 在根 node_modules）；TS 侧返回 any 不做静态类型解析。
 */
function importPkg(name: string): Promise<any> {
  return import(name);
}

const DOCX_EXT = /\.docx$/i;
const XLSX_EXT = /\.(?:xlsx|xls)$/i;
const PPTX_EXT = /\.pptx$/i;

/** 原生 Office 路径总开关；OAW_OFFICE_NATIVE=0 可完全退回 officecli。 */
export function isNativeOfficeEnabled(): boolean {
  return String(process.env.OAW_OFFICE_NATIVE || "1") !== "0";
}

/** 原生读取/写入的输出上限（防大文件淹没模型上下文）。 */
const MAX_NATIVE_TEXT_CHARS = 400_000;

// ---------------------------------------------------------------------------
// 能力矩阵（P2-C）：哪个格式、哪类操作原生 / 哪类必须 CLI
// ---------------------------------------------------------------------------

const NATIVE_VIEW_MODES = new Set(["text", "outline", "stats"]);

const CAPABILITY_MATRIX = Object.freeze({
  docx: Object.freeze({
    native: Object.freeze(["create", "view:text", "view:outline", "view:stats", "set:find_replace"]),
    requiresCli: Object.freeze(["get", "query", "batch", "add", "remove", "move", "swap", "delete", "import", "export", "open", "close", "save", "validate", "refresh", "dump", "watch", "view:html", "view:svg", "view:screenshot", "view:annotated", "view:issues", "view:forms", "set:style", "set:prop", "chart", "revision", "comment", "form", "protect", "pdf_export"]),
  }),
  xlsx: Object.freeze({
    native: Object.freeze(["create", "view:text", "view:outline", "view:stats"]),
    requiresCli: Object.freeze(["get", "query", "batch", "add", "remove", "move", "swap", "delete", "import", "export", "open", "close", "save", "validate", "refresh", "dump", "watch", "view:html", "view:svg", "view:screenshot", "view:annotated", "view:issues", "view:forms", "set", "chart", "pivot", "formula", "conditional_format", "sparkline", "pdf_export"]),
  }),
  pptx: Object.freeze({
    native: Object.freeze(["create", "view:text", "view:outline", "view:stats"]),
    requiresCli: Object.freeze(["get", "query", "batch", "add", "remove", "move", "swap", "delete", "import", "export", "open", "close", "save", "validate", "refresh", "dump", "watch", "view:html", "view:svg", "view:screenshot", "view:annotated", "view:issues", "view:forms", "set", "chart", "morph", "smartart", "ole", "media", "pdf_export"]),
  }),
});

/** 能力矩阵快照（诊断/路由说明用，P2-C）。 */
export function officeCapabilityMatrix(): any {
  return JSON.parse(JSON.stringify(CAPABILITY_MATRIX));
}

/**
 * 路由判定（P2-C）：这条命令是否必须交给 officecli。
 * @returns {{needsCli: boolean, reason: string}}
 */
export function needsCli(command: unknown, args: unknown[] = []): { needsCli: boolean; reason: string } {
  const cmd = String(command || "").trim().toLowerCase();
  const list = Array.isArray(args) ? args.map(String) : [];
  switch (cmd) {
    case "create":
      // create 全格式原生（docx/xlsx/pptx）
      return { needsCli: false, reason: "create 原生直写" };
    case "view": {
      const mode = String(list[2] || "").trim().toLowerCase();
      if (NATIVE_VIEW_MODES.has(mode)) return { needsCli: false, reason: `view ${mode} 原生读取` };
      return { needsCli: true, reason: `view ${mode || "(缺省)"} 需要 CLI 渲染/高保真输出` };
    }
    case "set": {
      // 仅支持目标路径为 "/"（或省略）的 --find/--replace 全文替换；属性/样式/定点编辑走 CLI
      const target = String(list[2] || "/").trim();
      const hasFind = list.some((t) => t === "--find");
      const hasReplace = list.some((t) => t === "--replace");
      const hasProps = list.some((t) => t === "--prop");
      if ((target === "/" || target === "") && hasFind && hasReplace && !hasProps) {
        return { needsCli: false, reason: "set 全文查找替换走原生（docx）" };
      }
      return { needsCli: true, reason: "set 属性/样式/定点编辑需要 CLI 精确定位" };
    }
    default:
      return { needsCli: true, reason: `${cmd || "(未知)"} 由 officecli 兜底` };
  }
}

// ---------------------------------------------------------------------------
// 结果构造：与 runOfficecliOnce 同形
// ---------------------------------------------------------------------------

interface NativeResult {
  code: number;
  stdout: string;
  stderr: string;
  text: string;
  json: any;
  command: string[];
  engine: "native";
}

function nativeResult(command: unknown[], { text = "", json = null, code = 0 }: { text?: string; json?: any; code?: number } = {}): NativeResult {
  return {
    code,
    stdout: text,
    stderr: "",
    text,
    json,
    command: command.map(String),
    engine: "native",
  };
}

function xmlEscape(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function xmlUnescape(value: unknown): string {
  return String(value ?? "")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** 工作区内相对路径解析；越界返回 null（交回上层 CLI 校验报错）。 */
function resolveInWorkspace(file: unknown, cwd: string): string | null {
  const root = path.resolve(cwd);
  const target = path.resolve(root, String(file || ""));
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) return null;
  return target;
}

function capText(text: unknown): string {
  const value = String(text || "");
  if (value.length <= MAX_NATIVE_TEXT_CHARS) return value;
  return `${value.slice(0, MAX_NATIVE_TEXT_CHARS)}\n…（原生读取截断：全文 ${value.length} 字符，仅显示前 ${MAX_NATIVE_TEXT_CHARS}）`;
}

// ---------------------------------------------------------------------------
// docx：段落抽取 / 大纲 / 统计 / 全文替换
// ---------------------------------------------------------------------------

/** 解析 word/document.xml 的段落序列：文本 + 段落样式（大纲级别判定用）。 */
function docxParagraphs(documentXml: unknown): { text: string; style: string; hasRevision: boolean }[] {
  const paragraphs: { text: string; style: string; hasRevision: boolean }[] = [];
  const pattern = /<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
  for (const match of String(documentXml || "").matchAll(pattern)) {
    const block = match[0]!;
    const texts = [...block.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]!);
    const style = block.match(/<w:pStyle\s+w:val="([^"]+)"/)?.[1] || "";
    const hasRevision = /<w:(?:ins|del)\s/.test(block);
    paragraphs.push({ text: texts.join(""), style, hasRevision });
  }
  return paragraphs;
}

function headingLevel(style: unknown): number {
  const match = String(style || "").match(/^(?:heading|Heading|标题)\s*([1-9])$/i) || String(style || "").match(/^Heading([1-9])$/i);
  return match ? Number(match[1]) : 0;
}

function countWords(text: unknown): number {
  const cjk = (String(text).match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const latin = (String(text).match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || []).length;
  return cjk + latin;
}

function docxViewText(documentXml: string): string {
  const paragraphs = docxParagraphs(documentXml);
  return capText(paragraphs.map((p) => p.text).join("\n").replace(/\n{3,}/g, "\n\n").trimEnd());
}

function docxViewOutline(documentXml: string): string {
  const lines: string[] = [];
  for (const p of docxParagraphs(documentXml)) {
    const level = headingLevel(p.style);
    if (level && p.text.trim()) lines.push(`${"#".repeat(Math.min(level, 6))} ${p.text.trim()}`);
  }
  return capText(lines.join("\n"));
}

function docxViewStats(documentXml: string): { text: string; json: any } {
  const paragraphs = docxParagraphs(documentXml);
  const fullText = paragraphs.map((p) => p.text).join("\n");
  const stats = {
    format: "docx",
    paragraphs: paragraphs.length,
    nonEmptyParagraphs: paragraphs.filter((p) => p.text.trim()).length,
    words: countWords(fullText),
    characters: fullText.length,
    headings: paragraphs.filter((p) => headingLevel(p.style)).length,
    tables: (String(documentXml).match(/<w:tbl>/g) || []).length,
    images: (String(documentXml).match(/<w:drawing[ >]/g) || []).length,
    comments: (String(documentXml).match(/<w:commentReference\s/g) || []).length,
    revisions: /<w:(?:ins|del)\s/.test(String(documentXml)) ? true : false,
  };
  return { text: JSON.stringify(stats, null, 2), json: stats };
}

/**
 * docx 全文查找替换（run 感知）：
 *  - 查找词落在单个 w:t 内 → 原位替换（最常见，零格式损耗）；
 *  - 跨 run（被拼写检查/输入法切散）→ 段落合并为单 run（保留首个 run 的 rPr）；
 *    段内含图片/OLE/修订标记时放弃原生（返回 null，交 CLI），避免破坏内容。
 * @returns {Promise<null|{code,text,json,command,engine}>} null = 原生不支持，交回 CLI
 */
async function docxReplaceText(file: string, findText: string, replaceText: string): Promise<NativeResult | null> {
  const buffer = await fs.promises.readFile(file);
  const zip = await JSZip.loadAsync(buffer);
  const entry = zip.file("word/document.xml");
  if (!entry) return null;
  const xml = await entry.async("string");
  if (/<w:(?:ins|del)\s/.test(xml)) return null; // 修订跟踪文档交 CLI（能力矩阵：revision→cli）

  let replaced = 0;
  const findEscaped = xmlEscape(findText);
  const replaceEscaped = xmlEscape(replaceText);

  const rewritten = xml.replace(/<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (paragraph) => {
    const texts = [...paragraph.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]!);
    const fullText = xmlUnescape(texts.join(""));
    if (!fullText || !fullText.includes(findText)) return paragraph;

    // 情形 1：单个 w:t 原位替换
    if (texts.some((t) => xmlUnescape(t).includes(findText))) {
      replaced += 1;
      return paragraph.replace(/(<w:t(?:\s[^>]*)?>)([\s\S]*?)(<\/w:t>)/g, (whole, open, content, close) => {
        const plain = xmlUnescape(content);
        if (!plain.includes(findText)) return whole;
        return `${open}${xmlEscape(plain.split(findText).join(replaceText))}${close}`;
      });
    }

    // 情形 2：跨 run 替换 —— 段内有图片/OLE 等非文本内容时放弃，避免合并丢内容
    if (/<w:(?:drawing|pict|object|hyperlink)[ >/]/.test(paragraph)) return paragraph;

    // 合并段落 runs 为单 run（保留首个带 rPr 的 run 属性与段落属性 pPr）
    replaced += 1;
    const pPr = paragraph.match(/<w:pPr\b[\s\S]*?<\/w:pPr>/)?.[0] || "";
    const rPr = paragraph.match(/<w:rPr\b[\s\S]*?<\/w:rPr>/)?.[0] || "";
    const preserve = /\s/.test(fullText) ? ' xml:space="preserve"' : "";
    const openTag = paragraph.match(/^<w:p\b[^>]*>/)?.[0] || "<w:p>";
    return `${openTag}${pPr}<w:r>${rPr}<w:t${preserve}>${xmlEscape(fullText.split(findText).join(replaceText))}</w:t></w:r></w:p>`;
  });

  if (!replaced) {
    return nativeResult(["set", path.basename(file), "/", "--find", findText, "--replace", replaceText], {
      text: `未找到需要替换的文本：${findText}`,
      json: { engine: "native", file: path.basename(file), replaced: 0 },
    });
  }
  // 把改写后的 document.xml 写回 ZIP（关键步骤：只在内存里替换不会落盘）
  zip.file("word/document.xml", rewritten);
  const output = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await fs.promises.writeFile(file, output);
  return nativeResult(["set", path.basename(file), "/", "--find", findText, "--replace", replaceText], {
    text: `已完成原生替换：${replaced} 个段落（find=${findText} → replace=${replaceText}）`,
    json: { engine: "native", file: path.basename(file), replaced, find: findText, replace: replaceText },
  });
}

// ---------------------------------------------------------------------------
// pptx：幻灯片文本抽取
// ---------------------------------------------------------------------------

async function pptxSlides(file: string): Promise<{ index: number; texts: string[]; tables: number; images: number }[]> {
  const zip = await JSZip.loadAsync(await fs.promises.readFile(file));
  const names = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/slide(\d+)/)?.[1] || 0) - Number(b.match(/slide(\d+)/)?.[1] || 0));
  const slides: { index: number; texts: string[]; tables: number; images: number }[] = [];
  for (const name of names) {
    const xml = await zip.file(name)!.async("string");
    const shapes = [...xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)].map((m) => [...m[0]!.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((t) => xmlUnescape(t[1])).join(""));
    // 表格文本（a:tbl 内的 a:t 不在 p:sp 里，读取时一并抽出）
    const tableTexts = [...xml.matchAll(/<a:tbl\b[\s\S]*?<\/a:tbl>/g)].map((m) =>
      [...m[0]!.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((t) => xmlUnescape(t[1])).join(" ").trim());
    const texts = [...shapes, ...tableTexts].filter((t) => t.trim());
    const tables = (xml.match(/<a:tbl>/g) || []).length;
    const images = (xml.match(/<p:pic\b/g) || []).length;
    slides.push({ index: Number(name.match(/slide(\d+)/)?.[1] || 0), texts, tables, images });
  }
  return slides;
}

async function pptxViewText(file: string): Promise<string> {
  const slides = await pptxSlides(file);
  const lines: string[] = [];
  for (const slide of slides) {
    lines.push(`--- 幻灯片 ${slide.index} ---`);
    lines.push(...slide.texts);
  }
  return capText(lines.join("\n"));
}

async function pptxViewOutline(file: string): Promise<string> {
  const slides = await pptxSlides(file);
  const lines = slides.map((slide) => `- 幻灯片 ${slide.index}：${(slide.texts[0] || "（无标题）").trim().slice(0, 80)}`);
  return capText(lines.join("\n"));
}

async function pptxViewStats(file: string): Promise<{ text: string; json: any }> {
  const slides = await pptxSlides(file);
  const stats = {
    format: "pptx",
    slides: slides.length,
    shapes: slides.reduce((sum, s) => sum + s.texts.length + s.images, 0),
    textItems: slides.reduce((sum, s) => sum + s.texts.length, 0),
    tables: slides.reduce((sum, s) => sum + s.tables, 0),
    images: slides.reduce((sum, s) => sum + s.images, 0),
  };
  return { text: JSON.stringify(stats, null, 2), json: stats };
}

// ---------------------------------------------------------------------------
// xlsx：工作表读取
// ---------------------------------------------------------------------------

async function loadWorkbook(file: string): Promise<{ XLSX: any; workbook: any }> {
  const mod: any = await importPkg("xlsx");
  const XLSX = mod.default || mod;
  return { XLSX, workbook: XLSX.readFile(file, { cellText: true, cellDates: true }) };
}

async function xlsxViewText(file: string): Promise<string> {
  const { XLSX, workbook } = await loadWorkbook(file);
  const sections = workbook.SheetNames.map((name: any) => {
    const sheet = workbook.Sheets[name];
    return `## ${name}\n${XLSX.utils.sheet_to_csv(sheet, { FS: "\t" })}`;
  });
  return capText(sections.join("\n\n").trimEnd());
}

async function xlsxViewOutline(file: string): Promise<string> {
  const { workbook } = await loadWorkbook(file);
  const lines = workbook.SheetNames.map((name: any) => {
    const ref = workbook.Sheets[name]?.["!ref"] || "空表";
    return `- ${name}（${ref}）`;
  });
  return capText(lines.join("\n"));
}

async function xlsxViewStats(file: string): Promise<{ text: string; json: any }> {
  const { XLSX, workbook } = await loadWorkbook(file);
  const sheets = workbook.SheetNames.map((name: any) => {
    const sheet = workbook.Sheets[name] || {};
    const ref = String(sheet["!ref"] || "");
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
    return {
      name,
      range: ref || null,
      rows: rows.length,
      cols: rows.reduce((max: number, row: any) => Math.max(max, row.length), 0),
      cells: rows.reduce((sum: number, row: any) => sum + row.filter((cell: any) => String(cell ?? "").trim()).length, 0),
    };
  });
  const stats = { format: "xlsx", sheets: sheets.length, detail: sheets };
  return { text: JSON.stringify(stats, null, 2), json: stats };
}

// ---------------------------------------------------------------------------
// create：docx（docx@9）/ xlsx（xlsx@0.18）/ pptx（pptxgenjs，P1-B）
// ---------------------------------------------------------------------------

/** 仅拦截"新建文档/表格/演示文稿"纯创建命令；其它命令返回 null 交给 officecli。 */
export function canCreateNatively(args: unknown): { file: string; format: string } | null {
  if (!Array.isArray(args) || !args.length) return null;
  if (String(args[0] || "").trim().toLowerCase() !== "create") return null;
  const file = String(args[1] || "").trim();
  if (!file) return null;
  if (DOCX_EXT.test(file)) return { file, format: "docx" };
  if (XLSX_EXT.test(file)) return { file, format: "xlsx" };
  if (PPTX_EXT.test(file)) return { file, format: "pptx" };
  return null;
}

async function createNativeDocx(target: string): Promise<void> {
  const { Document, Packer, Paragraph }: any = await importPkg("docx");
  const buffer = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph("")] }] }));
  await fs.promises.writeFile(target, buffer);
}

async function createNativeXlsx(target: string): Promise<void> {
  const mod: any = await importPkg("xlsx");
  const XLSX = mod.default || mod;
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([[]]), "Sheet1");
  XLSX.writeFile(workbook, target);
}

async function createNativePptx(target: string): Promise<void> {
  // P1-B：pptxgenjs 生成有效的基础 .pptx（零幻灯片的空演示文稿）。
  const mod: any = await importPkg("pptxgenjs");
  const PptxGenJS = mod.default || mod;
  const pptx = new PptxGenJS();
  pptx.author = "Open Plan";
  pptx.company = "Open Plan";
  pptx.title = path.basename(target).replace(/\.pptx$/i, "");
  const buffer = await pptx.write({ outputType: "nodebuffer" });
  await fs.promises.writeFile(target, Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
}

/**
 * P2-A Formatter：按结构化大纲（每页 { title, bullets[], table?{headers,rows} }）原生生成 .pptx。
 * 这是"生成 PPT 初稿"高频场景的原生直写路径——每步产物可检查，Evaluator 复用 view stats 校验。
 * @returns {{file:string, slides:number, engine:"native"}}
 */
export async function buildPptxFromSlides(target: string, slides: any[] = []): Promise<{ file: string; slides: number; engine: "native" }> {
  const mod: any = await importPkg("pptxgenjs");
  const PptxGenJS = mod.default || mod;
  const pptx = new PptxGenJS();
  pptx.author = "Open Plan";
  pptx.company = "Open Plan";
  pptx.title = path.basename(target).replace(/\.pptx$/i, "");
  for (const slide of slides) {
    const page = pptx.addSlide();
    const title = String(slide?.title || "").trim();
    if (title) page.addText(title, { x: 0.6, y: 0.4, w: 8.8, h: 0.9, fontSize: 28, bold: true });
    const bullets = (Array.isArray(slide?.bullets) ? slide.bullets : []).map((item: any) => String(item || "").trim()).filter(Boolean);
    if (bullets.length) {
      page.addText(bullets.map((text: any) => ({ text, options: { bullet: true, breakLine: true } })), {
        x: 0.9, y: 1.5, w: 8.2, h: 3.6, fontSize: 16, lineSpacingMultiple: 1.2,
      });
    }
    const table = slide?.table;
    if (table && Array.isArray(table.headers) && Array.isArray(table.rows)) {
      page.addTable(
        [table.headers.map((cell: any) => ({ text: String(cell ?? ""), options: { bold: true } })),
         ...table.rows.map((row: any) => (Array.isArray(row) ? row : [row]).map((cell: any) => ({ text: String(cell ?? "") })))],
        { x: 0.9, y: bullets.length ? 4.2 : 1.6, w: 8.2, fontSize: 12, border: { type: "solid", color: "D9D9D9" } },
      );
    }
    if (!title && !bullets.length && !table) page.addText("", { x: 0.6, y: 0.4 });
  }
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const buffer = await pptx.write({ outputType: "nodebuffer" });
  await fs.promises.writeFile(target, Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
  return { file: target, slides: slides.length, engine: "native" };
}

/**
 * P2-A Formatter：按结构化大纲生成 .docx（标题/段落/表格）。
 * @returns {{file:string, blocks:number, engine:"native"}}
 */
export async function buildDocxFromBlocks(target: string, blocks: any[] = []): Promise<{ file: string; blocks: number; engine: "native" }> {
  const { Document, Packer, Paragraph, HeadingLevel, Table, TableRow, TableCell, WidthType }: any = await importPkg("docx");
  const children: any[] = [];
  for (const block of blocks) {
    const kind = String(block?.type || "paragraph").toLowerCase();
    const text = String(block?.text ?? "").trim();
    if (!text && kind !== "image") continue;
    if (kind === "heading" || kind === "h1" || kind === "h2" || kind === "h3") {
      const level = kind === "h1" || block?.level === 1 ? HeadingLevel.HEADING_1
        : kind === "h3" || block?.level === 3 ? HeadingLevel.HEADING_3 : HeadingLevel.HEADING_2;
      children.push(new Paragraph({ text, heading: level }));
    } else if (kind === "table" && Array.isArray(block?.rows)) {
      const rows = block.rows.map((row: any) => new TableRow({
        children: (Array.isArray(row) ? row : [row]).map((cell: any) => new TableCell({
          children: [new Paragraph(String(cell ?? ""))],
        })),
      }));
      children.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
    } else if (kind === "image" && block?.path) {
      // G8：图集嵌入——读取本地图片（相对/绝对路径均可，调用方负责路径安全），
      // 尺寸由调用方以 transformation 传入（等比缩放由 probeImageSize 提供）。
      const { ImageRun }: any = await importPkg("docx");
      const data = await fs.promises.readFile(block.path);
      children.push(new Paragraph({
        children: [new ImageRun({
          type: block.format === "png" ? "png" : "jpg",
          data,
          transformation: { width: Number(block.width) || 480, height: Number(block.height) || 320 },
        })],
      }));
    } else {
      children.push(new Paragraph(text));
    }
  }
  if (!children.length) children.push(new Paragraph(""));
  const doc = new Document({ sections: [{ children }] });
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(target, await Packer.toBuffer(doc));
  return { file: target, blocks: blocks.length, engine: "native" };
}

function nativeCreateResult(command: string[], file: string, format: string): NativeResult {
  const label = ({ docx: "Word 文档", xlsx: "Excel 表格", pptx: "PPT 演示文稿" } as Record<string, string>)[format] || format;
  const text = `已创建 ${file}（${label}，原生引擎直写，无需 Office CLI 冷启动）`;
  return { code: 0, stdout: text, stderr: "", text, json: { engine: "native", file, format }, command, engine: "native" };
}

/**
 * 原生创建：命中并成功时返回与 officecli 同形的结果，
 * 未命中（含已存在文件、越界路径）返回 null（由调用方走 officecli）。
 */
export async function createNativeOffice(args: unknown, { cwd = process.cwd() }: { cwd?: string } = {}): Promise<NativeResult | null> {
  if (!isNativeOfficeEnabled()) return null;
  const spec = canCreateNatively(args);
  if (!spec) return null;
  const root = path.resolve(cwd);
  const target = resolveInWorkspace(spec.file, root);
  // 越界路径不做原生处理，交回 officecli（那里有工作区边界校验与报错语义）。
  if (!target) return null;
  // 已存在文件语义归 officecli（原生只负责新建空文件）。
  if (fs.existsSync(target)) return null;
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  if (spec.format === "docx") await createNativeDocx(target);
  else if (spec.format === "xlsx") await createNativeXlsx(target);
  else await createNativePptx(target);
  return nativeCreateResult((args as unknown[]).map(String), spec.file, spec.format);
}

// ---------------------------------------------------------------------------
// 统一路由入口：runNativeOfficeCommand
// ---------------------------------------------------------------------------

/**
 * 尝试用原生引擎执行一条 officecli 形状的命令（P1-A/P1-B/P2-C）。
 *
 * @returns {Promise<null|object>} null = 原生不支持（或总开关关闭），调用方回退 officecli；
 *          否则返回与 runOfficecli 同形结果（engine:"native"）。
 */
export async function runNativeOfficeCommand(args: unknown, { cwd = process.cwd() }: { cwd?: string } = {}): Promise<NativeResult | null> {
  if (!isNativeOfficeEnabled()) return null;
  const list = Array.isArray(args) ? args.map(String) : [];
  const command = String(list[0] || "").trim().toLowerCase();
  const file = String(list[1] || "").trim();
  // 文件参数是工作区相对路径：一律先解析到 cwd 内，避免误读进程工作目录。
  const target = file ? resolveInWorkspace(file, cwd) : null;
  try {
    // ---- create（docx/xlsx/pptx）----
    if (command === "create") {
      return await createNativeOffice(list, { cwd });
    }

    // ---- view text|outline|stats ----
    if (command === "view" && target) {
      const mode = String(list[2] || "").trim().toLowerCase();
      if (!NATIVE_VIEW_MODES.has(mode)) return null;
      if (!fs.existsSync(target)) return null; // 让 CLI 报标准错误语义
      let result: { text: string; json: any } | null = null;
      if (DOCX_EXT.test(target)) {
        const zip = await JSZip.loadAsync(await fs.promises.readFile(target));
        const xml = await zip.file("word/document.xml")?.async("string");
        if (!xml) return null;
        if (mode === "text") result = { text: docxViewText(xml), json: null };
        else if (mode === "outline") result = { text: docxViewOutline(xml), json: null };
        else result = docxViewStats(xml);
      } else if (PPTX_EXT.test(target)) {
        if (mode === "text") result = { text: await pptxViewText(target), json: null };
        else if (mode === "outline") result = { text: await pptxViewOutline(target), json: null };
        else result = await pptxViewStats(target);
      } else if (XLSX_EXT.test(target)) {
        if (mode === "text") result = { text: await xlsxViewText(target), json: null };
        else if (mode === "outline") result = { text: await xlsxViewOutline(target), json: null };
        else result = await xlsxViewStats(target);
      } else {
        return null;
      }
      return nativeResult(list, result);
    }

    // ---- set / --find --replace（docx 全文替换）----
    if (command === "set" && target) {
      const gate = needsCli(command, list);
      if (gate.needsCli) return null;
      const findIndex = list.indexOf("--find");
      const replaceIndex = list.indexOf("--replace");
      const findText = findIndex >= 0 ? String(list[findIndex + 1] ?? "") : "";
      const replaceText = replaceIndex >= 0 ? String(list[replaceIndex + 1] ?? "") : "";
      if (!findText) return null;
      if (!DOCX_EXT.test(target)) return null; // xlsx/pptx 替换仍走 CLI
      if (!fs.existsSync(target)) return null;
      return await docxReplaceText(target, findText, replaceText);
    }
    return null;
  } catch (error) {
    // 原生路径任何异常都交回 CLI 兜底（§5.5 降级策略），不向上抛错；
    // OAW_DOC_ENGINE_DEBUG=1 时输出原因，便于排查"为什么这条走了 CLI"。
    if (String(process.env.OAW_DOC_ENGINE_DEBUG || "") === "1") {
      console.warn(`[文档引擎] 原生执行失败（${command} ${file}）：${(error as any)?.stack || error}`);
    }
    return null;
  }
}
