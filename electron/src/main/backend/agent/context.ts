import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import JSZip from "jszip";
import XLSX from "xlsx";
// 逐行等价迁移自 server/context.mjs（B6-5，agent 域直接上游，B2 收编时随域校正）。
// 注意：当前仅对拍覆盖、未装配运行时；旧 JS 实现保留至域退役。
import { PROJECT_DIR, getWorkspace, resolveExternalPath, resolvePath, listFileRoots } from "../workspace";

// 过渡桥：knowledge/template 分支仍动态引用旧 server 模块（kb.mjs / tpl.mjs 属独立域，
// 待其 TS 化批次收编后替换为本域模块；模块未装配运行时，装配前必已替换）。
// @legacy-server/* 别名解析到 electron 外物理文件，与旧侧 import("./kb.mjs") 同一模块 id
// （vite/vitest alias + tsconfig paths 三处已同步；electron.vite.config.ts 装配时补齐）。
const KB_MODULE_PATH = "@legacy-server/kb.mjs";
const TPL_MODULE_PATH = "@legacy-server/tpl.mjs";
const execFileAsync = promisify(execFile) as (file: string, args: string[], opts?: Record<string, unknown>) => Promise<{ stdout: string; stderr: string }>;
const MAX_READ_CHARS = 50000;
const SUPPORTED = new Set(["docx", "xlsx", "pptx", "pdf", "csv", "json", "md", "markdown", "txt", "html", "htm"]);
const MAX_DOCUMENT_CACHE_ENTRIES = 32;
const MAX_DOCUMENT_CACHE_CHARS = 2_000_000;
const documentReadCache = new Map<string, { text: string; cachedAt: string }>();
let documentCacheChars = 0;

export interface Reference {
  kind: string;
  target: string;
  id?: string;
  rootId?: string | null;
  range?: Record<string, unknown>;
  source?: string;
  [key: string]: unknown;
}

export interface ReferenceMetadata {
  path?: string;
  relativePath?: string;
  rootId?: string | null;
  name?: string;
  ext?: string;
  mime?: string;
  size?: number;
  mtime?: number;
  hash?: string | null;
  version?: string;
  isDirectory?: boolean;
  sessionId?: string;
  parser?: string;
  cacheHit?: boolean;
  readAt?: string;
  files?: ReferenceMetadata[];
  [key: string]: unknown;
}

export interface ResolvedReference extends Reference {
  status: "resolved" | "missing" | "unsupported" | "deferred";
  metadata: ReferenceMetadata | null;
  message?: string;
  text?: string;
  truncated?: boolean;
}

function cacheKeyFor(file: string, version: string, range: Record<string, unknown> | null): string {
  return `${file}|${version}|${JSON.stringify(range || {})}`;
}

function readCachedDocument(key: string): string | null {
  const hit = documentReadCache.get(key);
  if (!hit) return null;
  documentReadCache.delete(key);
  documentReadCache.set(key, hit);
  return hit.text;
}

function cacheDocument(key: string, text: unknown): void {
  const value = String(text || "");
  if (!value || value.length > MAX_DOCUMENT_CACHE_CHARS) return;
  const old = documentReadCache.get(key);
  if (old) documentCacheChars -= old.text.length;
  documentReadCache.delete(key);
  documentReadCache.set(key, { text: value, cachedAt: new Date().toISOString() });
  documentCacheChars += value.length;
  while (documentReadCache.size > MAX_DOCUMENT_CACHE_ENTRIES || documentCacheChars > MAX_DOCUMENT_CACHE_CHARS) {
    const first = documentReadCache.keys().next().value as string;
    const item = documentReadCache.get(first);
    documentReadCache.delete(first);
    documentCacheChars -= item?.text?.length || 0;
  }
}

export function clearReadCache(): void {
  documentReadCache.clear();
  documentCacheChars = 0;
}

function idFor(ref: Record<string, unknown>): string {
  return "ref_" + crypto.createHash("sha1").update(JSON.stringify(ref)).digest("hex").slice(0, 12);
}

function makeRef(kind: string, target: unknown, extra: Record<string, unknown> = {}): Reference {
  let cleanTarget = String(target || "").trim();
  const cell = kind === "file" ? cleanTarget.match(/^(.*?)#([^!]+)!([A-Z]+\d+(?::[A-Z]+\d+)?)$/i) : null;
  const locator = kind === "file" ? cleanTarget.match(/^(.*?)#(page|p|slide|paragraph)=(\d+)(?:-(\d+))?$/i) : null;
  const range = cell
    ? { ...((extra.range as Record<string, unknown>) || {}), sheet: cell[2], cell: cell[3] }
    : locator
      ? { ...((extra.range as Record<string, unknown>) || {}), [(locator[2] as string).toLowerCase() === "p" ? "page" : (locator[2] as string).toLowerCase()]: Number(locator[3]), ...(locator[4] ? { end: Number(locator[4]) } : {}) }
      : extra.range;
  if (cell) cleanTarget = cell[1] as string;
  if (locator) cleanTarget = locator[1] as string;
  const ref: Reference = { kind, target: cleanTarget, ...extra };
  if (range) ref.range = range as Record<string, unknown>;
  ref.id = idFor(ref as unknown as Record<string, unknown>);
  return ref;
}

/** Parse the user-facing @ syntax into stable, serialisable Reference objects. */
export function parseReferences(text = ""): Reference[] {
  const out: Reference[] = [];
  const seen = new Set<string>();
  const add = (ref: Reference | null) => {
    if (!(ref as Reference | null)?.target) return;
    const key = JSON.stringify({ kind: ref!.kind, target: ref!.target, rootId: ref!.rootId, range: ref!.range });
    if (!seen.has(key)) { seen.add(key); out.push({ ...ref!, id: idFor(ref as unknown as Record<string, unknown>) }); }
  };
  const source = String(text || "");
  for (const m of source.matchAll(/@知识库目录\[([^\]]+)\]/g)) add(makeRef("knowledge_dir", m[1], { source: m[0] }));
  for (const m of source.matchAll(/@知识库\[([^\]]+)\]/g)) add(makeRef("knowledge", m[1], { source: m[0] }));
  for (const m of source.matchAll(/@模板目录\[([^\]]+)\]/g)) add(makeRef("template_dir", m[1], { source: m[0] }));
  for (const m of source.matchAll(/@模板\[([^\]]+)\]/g)) add(makeRef("template", m[1], { source: m[0] }));
  for (const m of source.matchAll(/@文件\[([^\]]+)\]/g)) add(makeRef("file", m[1], { source: m[0] }));
  for (const m of source.matchAll(/&会话\[([^\]]+)\]/g)) add(makeRef("session", m[1], { source: m[0] }));
  const ext = /\.(docx|xlsx|pptx|pdf|csv|json|md|markdown|txt|html|htm)$/i;
  for (const m of source.matchAll(/(^|[\s(])@([^\s@，。！？\]}]+)/g)) {
    const target = (m[2] as string).replace(/[),;。！？]+$/, "");
    if (/^(?:文件|知识库|模板|模板目录)\[/.test(target)) continue;
    if (target.includes("/") || target.includes("\\") || ext.test(target)) add(makeRef("file", target, { source: `@${target}` }));
  }
  return out;
}

function findSessionReferenceFile(target: unknown): string | null {
  const wanted = String(target || "").trim();
  if (!wanted) return null;
  const roots = [path.join(PROJECT_DIR, ".规聚会话")];
  const files: string[] = [];
  const walk = (dir: string, depth = 0): void => {
    if (depth > 4) return;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && /\.jsonl$/i.test(entry.name)) files.push(full);
    }
  };
  roots.forEach((root) => walk(root));
  const byName = files.find((file) => {
    const name = path.basename(file);
    return name === wanted + ".jsonl" || name === wanted + ".json" || name.startsWith(wanted);
  });
  if (byName) return byName;
  for (const file of files) {
    try {
      const header = JSON.parse(fs.readFileSync(file, "utf8").split(/\r?\n/)[0] as string);
      if (String(header?.id || header?.sessionId || "") === wanted) return file;
    } catch {}
  }
  return null;
}

function sessionMessageText(message: { content?: unknown } | null | undefined): string {
  const content = message?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return (content as Array<{ type?: string; text?: string; content?: string }>)
    .filter((part) => part?.type === "text" || part?.type === "input_text")
    .map((part) => part.text || part.content || "").join("\n").trim();
}

function readSessionReference(target: unknown): { file: string; text: string } | null {
  const file = findSessionReferenceFile(target);
  if (!file) return null;
  const chunks: string[] = [];
  try {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      let entry: any;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.type !== "message") continue;
      const role = entry.message?.role;
      if (role !== "user" && role !== "assistant") continue;
      const text = sessionMessageText(entry.message);
      if (text) chunks.push((role === "user" ? "用户" : "助手") + "：" + text);
    }
  } catch { return null; }
  return { file, text: chunks.join("\n\n").slice(0, MAX_READ_CHARS) };
}

function metadata(file: string, rootId: string | null = null, workspace: string = getWorkspace()): ReferenceMetadata {
  const st = fs.statSync(file);
  // 目录引用只需要用于展示和版本判断，不能把目录交给 readFileSync。
  // Windows 上对目录调用 readFileSync 会抛出 EISDIR，导致整个 Agent 请求失败。
  const hash = st.isDirectory()
    ? null
    : crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex");
  return {
    path: file,
    relativePath: rootId ? path.relative(listFileRoots().find((r) => r.id === rootId)?.path || file, file).replace(/\\/g, "/") : path.relative(workspace, file).replace(/\\/g, "/"),
    rootId,
    name: path.basename(file),
    ext: path.extname(file).slice(1).toLowerCase(),
    mime: mimeFor(file),
    size: st.size,
    mtime: st.mtimeMs,
    hash,
    version: st.isDirectory() ? `${st.size}:${st.mtimeMs}:directory` : `${st.size}:${st.mtimeMs}:${(hash as string).slice(0, 8)}`,
  };
}

function mimeFor(file: string): string {
  const ext = path.extname(file).slice(1).toLowerCase();
  return ({
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    pdf: "application/pdf", csv: "text/csv", json: "application/json",
    md: "text/markdown", markdown: "text/markdown", txt: "text/plain", html: "text/html", htm: "text/html",
  } as Record<string, string>)[ext] || "application/octet-stream";
}

function resolveFile(ref: Reference, workspace: string = getWorkspace()): string | null {
  if (ref.rootId) return resolveExternalPath(ref.rootId, ref.target);
  return resolvePath(ref.target, workspace);
}

export function resolveReference(input: unknown, workspace: string = getWorkspace()): ResolvedReference {
  const ref: Reference = typeof input === "string" ? makeRef("file", input) : { ...(input as Reference) };
  ref.id ||= idFor(ref as unknown as Record<string, unknown>);
  if (["knowledge", "knowledge_dir", "template", "template_dir"].includes(ref.kind)) {
    return { ...ref, status: "deferred", message: "由知识库/模板索引解析", metadata: null } as ResolvedReference;
  }
  if (ref.kind === "session") {
    const session = readSessionReference(ref.target);
    return session
      ? { ...ref, status: "resolved", metadata: { path: session.file, name: path.basename(session.file), mime: "text/plain", sessionId: ref.target } } as ResolvedReference
      : { ...ref, status: "missing", metadata: null, message: "未找到该历史会话" } as ResolvedReference;
  }
  const file = resolveFile(ref, workspace);
  if (!file) return { ...ref, status: "missing", metadata: null, message: "文件不存在或不在已登记目录内" } as ResolvedReference;
  const stat = fs.statSync(file);
  if (stat.isDirectory()) {
    const files: ReferenceMetadata[] = [];
    const walk = (dir: string, depth = 0): void => {
      if (depth > 3 || files.length >= 100) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p, depth + 1);
        else if (SUPPORTED.has(path.extname(entry.name).slice(1).toLowerCase())) files.push(metadata(p, ref.rootId || null, workspace));
      }
    };
    walk(file);
    return { ...ref, status: "resolved", metadata: { ...metadata(file, ref.rootId || null, workspace), isDirectory: true, files } } as ResolvedReference;
  }
  return { ...ref, status: SUPPORTED.has(path.extname(file).slice(1).toLowerCase()) ? "resolved" : "unsupported", metadata: metadata(file, ref.rootId || null, workspace) } as ResolvedReference;
}

export function resolveReferences(references: unknown = [], text = "", workspace: string = getWorkspace()): ResolvedReference[] {
  const refs: Reference[] = [...(Array.isArray(references) ? references : []), ...parseReferences(text)];
  const seen = new Set<string>();
  return refs.map((r) => ({ ...r, id: r.id || idFor(r as unknown as Record<string, unknown>) })).filter((r) => {
    const key = `${r.kind}:${r.target}:${r.rootId || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((ref) => resolveReference(ref, workspace));
}

async function extractDocx(file: string): Promise<string> {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const xml = await zip.file("word/document.xml")?.async("string");
  if (!xml) return "";
  return [...xml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)].map((m) => [...m[0].matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((x) => x[1]).join("").trim()).filter(Boolean).join("\n");
}

async function extractPptx(file: string): Promise<string> {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort();
  const chunks: string[] = [];
  for (const name of slides) {
    const xml = await zip.file(name)!.async("string");
    const text = [...xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)].map((m) => m[1]).join("").trim();
    if (text) chunks.push(`${name.match(/slide(\d+)/)?.[1] || "?"}. ${text}`);
  }
  return chunks.join("\n");
}

async function extractPdf(file: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("pdftotext", [file, "-"], { timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
    return stdout;
  } catch {
    if (process.env.OAW_ENABLE_OCR !== "1") return "[PDF 文本抽取工具不可用；可安装 poppler，或设置 OAW_ENABLE_OCR=1 启用可选 OCR。]";
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-pdf-"));
    try {
      const prefix = path.join(tmp, "page");
      await execFileAsync("pdftoppm", ["-f", "1", "-l", "5", "-png", "-r", "150", file, prefix], { timeout: 60000 });
      const pages = fs.readdirSync(tmp).filter((name) => name.endsWith(".png")).sort();
      const chunks: string[] = [];
      for (const page of pages) {
        try {
          const { stdout } = await execFileAsync("tesseract", [path.join(tmp, page), "stdout", "-l", process.env.OAW_OCR_LANG || "eng"], { timeout: 60000, maxBuffer: 5 * 1024 * 1024 });
          if (stdout.trim()) chunks.push(`${page}:\n${stdout.trim()}`);
        } catch {}
      }
      return chunks.join("\n\n") || "[OCR 未识别到文本；请检查 tesseract 与语言包。]";
    } catch {
      return "[OCR 依赖不可用；请安装 pdftoppm 与 tesseract，或使用 PDF 文本层。]";
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  }
}

async function extractFile(file: string, range: Record<string, unknown> | null = null): Promise<string> {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (["md", "markdown", "txt", "html", "htm", "csv", "json"].includes(ext)) return fs.readFileSync(file, "utf8");
  if (ext === "docx") return extractDocx(file);
  if (ext === "pptx") return extractPptx(file);
  if (ext === "xlsx") {
    const wb = XLSX.readFile(file, { cellText: true, cellDates: true });
    const cellRange = range as { sheet?: string; cell?: string } | null;
    const names = cellRange?.sheet && wb.SheetNames.includes(cellRange.sheet) ? [cellRange.sheet] : wb.SheetNames;
    return names.map((name) => {
      const sheet = wb.Sheets[name]!;
      if (cellRange?.cell && name === cellRange.sheet) {
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" }) as unknown[][];
        const decoded = XLSX.utils.decode_range(cellRange.cell);
        const selected = rows.slice(decoded.s.r, decoded.e.r + 1).map((row) => row.slice(decoded.s.c, decoded.e.c + 1).join("\t"));
        return `## ${name}!${cellRange.cell}\n${selected.join("\n")}`;
      }
      return `## ${name}\n${XLSX.utils.sheet_to_csv(sheet)}`;
    }).join("\n\n");
  }
  if (ext === "pdf") return extractPdf(file);
  return "";
}

function applyRange(text: unknown, range: Record<string, unknown> = {}): string {
  let out = String(text || "");
  if (range?.slide || range?.page || range?.paragraph) {
    const n = Number(range.slide || range.page || range.paragraph);
    const end = Number(range.end || n);
    const lines = out.split(/\r?\n/);
    if (range.slide) out = lines.filter((line) => { const m = line.match(/^(\d+)\./); return m && Number(m[1]) >= n && Number(m[1]) <= end; }).join("\n");
    else out = lines.slice(Math.max(0, n - 1), Math.max(0, end)).join("\n");
  }
  if (range?.startLine || range?.endLine) {
    const lines = out.split(/\r?\n/);
    const start = Math.max(1, Number(range.startLine || 1));
    const end = Math.min(lines.length, Number(range.endLine || lines.length));
    out = lines.slice(start - 1, end).join("\n");
  }
  return out;
}

export async function readReference(input: unknown, query = "", range: Record<string, unknown> | null = null, workspace: string = getWorkspace()): Promise<ResolvedReference> {
  const resolved = resolveReference(input, workspace);
  if (resolved.kind === "session") {
    const session = readSessionReference(resolved.target);
    if (!session) return { ...resolved, status: "missing", message: "未找到该历史会话" };
    const q = String(query || "").trim().toLowerCase();
    const text = q ? session.text.split(/\r?\n/).filter((line) => line.toLowerCase().includes(q)).join("\n") : session.text;
    return { ...resolved, status: "resolved", text: text.slice(0, MAX_READ_CHARS), truncated: text.length > MAX_READ_CHARS } as ResolvedReference;
  }
  if (resolved.kind === "knowledge") {
    const kb: any = await import(KB_MODULE_PATH);
    await kb.scan();
    const [relPath, rootName] = String(resolved.target).split("@").map((s) => s.trim());
    const rootIdx = rootName ? kb.status().roots.findIndex((r: { name: string }) => r.name === rootName) : null;
    const doc = kb.getDoc(relPath, rootIdx >= 0 ? rootIdx : null);
    if (!doc) return { ...resolved, status: "missing", message: `未找到知识库文档 ${resolved.target}` };
    const text = applyRange(`# ${doc.title}\n\n${doc.content}`, range || undefined);
    return { ...resolved, status: "resolved", metadata: { relativePath: relPath, rootName, mime: "text/markdown" }, text: text.slice(0, MAX_READ_CHARS), truncated: text.length > MAX_READ_CHARS } as ResolvedReference;
  }
  if (resolved.kind === "knowledge_dir") {
    const kb: any = await import(KB_MODULE_PATH);
    await kb.scan();
    const [relPath, rootName] = String(resolved.target).split("@").map((s) => s.trim());
    const rootIdx = rootName ? kb.status().roots.findIndex((r: { name: string }) => r.name === rootName) : null;
    const tree = kb.getTreeLevel(rootIdx >= 0 ? rootIdx : 0, relPath || "");
    const text = [...(tree?.dirs || []).map((d: { name?: string; path?: string }) => `[目录] ${d.name || d.path}`), ...(tree?.files || []).map((f: { title?: string; name?: string; relPath?: string }) => `[文件] ${f.title || f.name || f.relPath}`)].join("\n");
    return { ...resolved, status: "resolved", metadata: { relativePath: relPath, rootName, mime: "text/plain", isDirectory: true }, text: text || "（目录为空）" } as ResolvedReference;
  }
  if (resolved.kind === "template") {
    const tpl: any = await import(TPL_MODULE_PATH);
    const templatePath = tpl.resolveTemplatePath(resolved.target);
    const doc = tpl.getTemplateContent(resolved.target);
    if (!doc || !templatePath) return { ...resolved, status: "missing", message: `未找到模板 ${resolved.target}` };
    // 文本模板由 tpl 直接读取；Office/PDF 模板需要走统一抽取器，
    // 否则 context_read 只能返回文件元数据，Agent 无法真正参考模板结构。
    const rawText = doc.content ?? await extractFile(templatePath, range);
    const text = applyRange(rawText, range || undefined);
    return { ...resolved, status: "resolved", metadata: { relativePath: resolved.target, mime: mimeFor(templatePath), parser: path.extname(templatePath).slice(1).toLowerCase() }, text: text.slice(0, MAX_READ_CHARS), truncated: text.length > MAX_READ_CHARS } as ResolvedReference;
  }
  if (resolved.kind === "template_dir") return { ...resolved, status: "deferred", message: "模板目录引用请先选择具体模板文件" } as ResolvedReference;
  if (resolved.status !== "resolved" || resolved.metadata?.isDirectory) return { ...resolved, text: resolved.message || "目录引用需要逐个读取文件" } as ResolvedReference;
  const extractionRange = range || (resolved.range as Record<string, unknown>) || null;
  const cacheKey = cacheKeyFor(resolved.metadata!.path as string, resolved.metadata!.version as string, extractionRange);
  let text = readCachedDocument(cacheKey);
  const cacheHit = text !== null;
  if (!cacheHit) {
    text = await extractFile(resolved.metadata!.path as string, extractionRange);
    cacheDocument(cacheKey, text);
  }
  text = applyRange(text, extractionRange || undefined);
  const q = String(query || "").trim();
  const result = q ? text.split(/\r?\n/).filter((line) => line.toLowerCase().includes(q.toLowerCase())).join("\n") : text;
  return {
    ...resolved,
    metadata: { ...resolved.metadata, parser: path.extname(resolved.metadata!.path as string).slice(1).toLowerCase(), cacheHit, readAt: new Date().toISOString() },
    text: result.slice(0, MAX_READ_CHARS),
    truncated: result.length > MAX_READ_CHARS,
  } as ResolvedReference;
}

export function contextSummary(resolved: ResolvedReference[] = []): string {
  return resolved.map((r) => `- ${r.id}: ${r.kind} ${r.target} → ${r.status}${r.metadata?.relativePath ? ` (${r.metadata.relativePath})` : ""}`).join("\n");
}
