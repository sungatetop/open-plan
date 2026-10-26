/**
 * 模版库服务（tpl 域）
 *
 * 逐行等价迁移自 server/tpl.mjs（S3-10，绞杀者分域 S3 批次）。
 *
 * 扫描本地交通规划模版目录，提供分类列表和内容预览。
 * 模版来源：
 *   - .claude/skills/ 下的交通报告写作 SKILL.md（真模板）
 *   - _报告模板/ 下的 docx/pdf/md 实例
 *   - 零碳货运白皮书/1会前/ 下的行政模板
 *   - 义乌物流项目/04_调研执行/ 下的调研模板
 *   - 衢州多式联运项目/ 下的研究框架
 *
 * 路径锚定：旧侧 __dirname（fileURLToPath(import.meta.url)，server/ 源码目录）上跳
 * 两级得 ROOT、一级得 PROJECT_DIR——即 ROOT = resolve(PROJECT_DIR, "..")。TS 侧
 * PROJECT_DIR 直绑 workspace-paths（仓库根锚点，B2 收编时按打包产物统一校正层级），
 * ROOT 由 PROJECT_DIR 推导，与旧侧数学等价。当前消费面：agent context.ts 的
 * template 引用分支（动态 import ../tpl，S3-10 起替换 @legacy-server/tpl.mjs）；
 * 旧侧 server/context.mjs / index.mjs 消费点随流量切换批退役。
 */
import fs from "node:fs";
import path from "node:path";
import { PROJECT_DIR } from "./workspace-paths";

const ROOT = path.resolve(PROJECT_DIR, ".."); // 仓库根上一级（历史工作目录，_报告模板 等相对其下）

// ── 模版分类定义 ──
const CATEGORIES = [
  { id: "gongwen",   name: "公文版面", icon: "📋", dirs: ["_报告模板/公文版面", ".claude/skills/gongwen-banmian"], exts: [".md", ".docx", ".doc", ".pdf"] },
  { id: "huibao",    name: "工作汇报", icon: "📊", dirs: [".claude/skills/gongzuo-huibao", "_报告模板/工作汇报"], exts: [".md", ".docx", ".doc", ".pdf"] },
  { id: "yanjiu",    name: "研究报告", icon: "📑", dirs: [".claude/skills/yanjiu-baogao", "_报告模板/研究报告"], exts: [".md", ".docx", ".doc", ".pdf"] },
  { id: "guihua",    name: "规划报告", icon: "🗺️", dirs: [".claude/skills/guihua-baogao", "_报告模板/规划报告"], exts: [".md", ".docx", ".doc", ".pdf"] },
  { id: "hangye",    name: "行业研究", icon: "📈", dirs: [".claude/skills/hangye-yanjiu-baogao"], exts: [".md", ".docx", ".doc", ".pdf"] },
  { id: "lunwen",    name: "论文写作", icon: "📝", dirs: [".claude/skills/lunwen", ".claude/skills/academic-writing", "_报告模板/论文"], exts: [".md", ".docx", ".doc", ".pdf"] },
  { id: "huiyi",     name: "会议通知/纪要", icon: "📅", dirs: ["零碳货运白皮书/1会前", "义乌物流专题资料"], exts: [".md", ".docx", ".doc", ".pdf"] },
  { id: "diaoyan",   name: "调研问卷", icon: "❓", dirs: ["义乌物流项目/04_调研执行/docs/superpowers/specs", "义乌物流专题资料"], exts: [".md", ".docx", ".doc"] },
  { id: "kuangjia",  name: "研究框架", icon: "🏗️", dirs: ["衢州多式联运项目", "柬埔寨公交项目"], exts: [".md"] },
  { id: "tubiao",    name: "图表/地图", icon: "📊", dirs: ["交通规划工作台/模板/图表模板", "交通规划工作台/模板/HTML模板", ".claude/skills/traffic-charts-template", ".claude/skills/traffic-map-template"], exts: [".md", ".html", ".js"] },
  { id: "htmlppt",   name: "HTML PPT（OpenDesign）", icon: "📽️", dirs: [path.join(PROJECT_DIR, "templates/opendesign")], exts: [".html"], depth: 5, folderTitle: true, skipDirs: ["assets", "themes", "animations", "fonts", "scripts", "docs", "references", "examples"] },
  { id: "sucaiku",   name: "规划素材库", icon: "📚", dirs: [path.join(PROJECT_DIR, "templates/traffic-material")], exts: [".md"] },
];

const SKIP_DIRS = new Set(["node_modules", ".git", ".venv", "__pycache__", ".obsidian", "dist", "build"]);

let _cache: any[] | null = null;

function walkDir(dir: string, baseRel: string, out: { abs: string; rel: string; name: string }[], maxDepth = 3, depth = 0, skipDirs: string[] = []): void {
  if (depth > maxDepth) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const abs = path.join(dir, e.name);
    const rel = baseRel ? `${baseRel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || skipDirs.includes(e.name)) continue;
      walkDir(abs, rel, out, maxDepth, depth + 1, skipDirs);
    } else if (e.isFile()) {
      out.push({ abs, rel, name: e.name });
    }
  }
}

function parseTitle(absPath: string, name: string, folderTitle = false): string {
  const ext = path.extname(name).toLowerCase();
  if (folderTitle) {
    // HTML 模板：用模板目录名 + 文件名作为标题（如 html-ppt-zhangzara-studio / example.html）
    const dirName = path.basename(path.dirname(absPath));
    const base = name.replace(/\.[^.]+$/, "");
    if (base === "index" || base === "example") return dirName.replace(/^html-ppt-?/i, "");
    return `${dirName.replace(/^html-ppt-?/i, "")} / ${base}`;
  }
  if (ext === ".md" || ext === ".markdown") {
    try {
      const content = fs.readFileSync(absPath, "utf8").slice(0, 2000);
      const fm = content.match(/^---\s*\n([\s\S]*?)\n---/);
      if (fm) {
        const titleLine = fm[1]!.split("\n").find((l) => /^\s*title\s*:/i.test(l));
        if (titleLine) return titleLine.replace(/^\s*title\s*:\s*/i, "").replace(/^['"]|['"]$/g, "").trim();
      }
      const h1 = content.match(/^#\s+(.+)$/m);
      if (h1) return h1[1]!.trim();
    } catch {}
  }
  return name.replace(/\.[^.]+$/, "").replace(/_/g, " ");
}

function scanTemplates(): any[] {
  const templates: any[] = [];
  for (const cat of CATEGORIES) {
    for (const dir of cat.dirs) {
      const absDir = path.isAbsolute(dir) ? dir : path.join(ROOT, dir);
      if (!fs.existsSync(absDir)) continue;
      const files: { abs: string; rel: string; name: string }[] = [];
      walkDir(absDir, dir, files, cat.depth ?? 2, 0, cat.skipDirs ?? []);
      for (const f of files) {
        const ext = path.extname(f.name).toLowerCase();
        if (!cat.exts.includes(ext)) continue;
        // HTML PPT（OpenDesign）分类：只收录 example.html（每个模板的唯一可预览入口），
        // 排除集合页/子页面/占位 html，避免"假模板"出现在列表
        if (cat.id === "htmlppt" && f.name !== "example.html") continue;
        // 归一化 relPath：绝对路径 → 相对项目根 + 正斜杠（前端 URL 传递与文件路由解析需要）
        let rel = f.rel;
        if (path.isAbsolute(rel)) rel = path.relative(PROJECT_DIR, rel);
        rel = rel.split(path.sep).join("/");
        const st = fs.statSync(f.abs);
        templates.push({
          id: `${cat.id}/${rel}`,
          category: cat.id,
          name: f.name,
          relPath: rel,
          title: parseTitle(f.abs, f.name, cat.folderTitle),
          ext: ext.slice(1),
          size: st.size,
          mtime: st.mtimeMs,
          type: ext === ".md" || ext === ".markdown" ? "markdown" : ext === ".html" || ext === ".htm" ? "html" : ext === ".docx" || ext === ".doc" ? "word" : ext === ".pdf" ? "pdf" : ext === ".pptx" || ext === ".ppt" ? "ppt" : ext === ".xlsx" || ext === ".xls" ? "xls" : "other",
        });
      }
    }
  }
  // 去重（同一 relPath 出现在多个分类时保留第一个）
  const seen = new Set<string>();
  const deduped: any[] = [];
  for (const t of templates) {
    if (seen.has(t.relPath)) continue;
    seen.add(t.relPath);
    deduped.push(t);
  }
  return deduped;
}

export function getTemplates(): any[] {
  if (!_cache) _cache = scanTemplates();
  return _cache;
}

export function getCategories(): { id: string; name: string; icon: string }[] {
  return CATEGORIES.map((c) => ({ id: c.id, name: c.name, icon: c.icon }));
}

export function getTemplatesByCategory(categoryId: string): any[] {
  const all = getTemplates();
  if (!categoryId || categoryId === "all") return all;
  return all.filter((t) => t.category === categoryId);
}

export function resolveTemplatePath(relPath: string): string | null {
  // 模板可能相对工作目录（ROOT，_报告模板 等）或项目根（PROJECT_DIR，templates/），双根尝试
  let absPath: string;
  if (path.isAbsolute(relPath)) {
    absPath = relPath;
  } else {
    const c1 = path.join(ROOT, relPath);
    const c2 = path.join(PROJECT_DIR, relPath);
    absPath = fs.existsSync(c1) ? c1 : fs.existsSync(c2) ? c2 : c1;
  }
  if (!fs.existsSync(absPath)) return null;
  try { if (!fs.statSync(absPath).isFile()) return null; } catch { return null; }
  return absPath;
}

export function getTemplateContent(relPath: string): any {
  const absPath = resolveTemplatePath(relPath);
  if (!absPath) return null;
  const ext = path.extname(absPath).toLowerCase();
  const st = fs.statSync(absPath);
  if (ext === ".md" || ext === ".markdown" || ext === ".txt" || ext === ".html" || ext === ".htm") {
    try {
      const content = fs.readFileSync(absPath, "utf8");
      return { type: "text", content, ext: ext.slice(1), size: st.size };
    } catch { return null; }
  }
  // 二进制文件：返回类型信息（前端用 iframe 渲染）
  if (ext === ".docx" || ext === ".doc") return { type: "word", ext: ext.slice(1), size: st.size, relPath };
  if (ext === ".pdf") return { type: "pdf", ext: ext.slice(1), size: st.size, relPath };
  if (ext === ".pptx" || ext === ".ppt") return { type: "ppt", ext: ext.slice(1), size: st.size, relPath };
  if (ext === ".xlsx" || ext === ".xls") return { type: "xls", ext: ext.slice(1), size: st.size, relPath };
  return { type: "binary", ext: ext.slice(1), size: st.size, relPath };
}

// 重新扫描（目录变更后调用）
export function refresh(): void { _cache = null; }
