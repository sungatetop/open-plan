/**
 * S3-10 tpl 域对拍：legacy 物理加载 server/tpl.mjs vs modern 静态 import TS
 * backend/tpl。双侧 PROJECT_DIR 同锚 {仓库根}（TS 侧经 workspace-paths，ROOT 同为
 * 其上一级），扫描同一物理模板文件集合——getTemplates 全量（含 mtime/size/title）
 * JSON 互等，无 fixture 落盘（只读域）。
 *
 * 覆盖：导出面 6；getCategories 常量投影；getTemplates 全量互等与结构不变式
 * （id 前缀/type 投影/htmlppt 只收 example.html）；getTemplatesByCategory 过滤与
 * all 直通；resolveTemplatePath 双根尝试/绝对路径/目录拒绝/缺失 null；
 * getTemplateContent 文本/二进制元数据/缺失；refresh 缓存重扫互等。
 */
import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";

type ModernTpl = typeof import("../src/main/backend/tpl");

// legacy 侧经 any 载体调用（旧 .mjs 无类型标注，tsc 推断局限）；modern 保持具体类型。
let legacy: any;
let modern: ModernTpl;

beforeAll(async () => {
  legacy = await import("@legacy-server/tpl.mjs");
  modern = await import("../src/main/backend/tpl");
  // 双侧各自预热缓存（模块级 _cache，扫描同一物理文件集合）
  legacy.getTemplates();
  modern.getTemplates();
});

function normalize<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

describe("s3-tpl-parity 导出面与常量", () => {
  it("导出面一致（6 项）", () => {
    expect(Object.keys(modern).sort()).toEqual(Object.keys(legacy).sort());
  });

  it("getCategories：12 分类投影互等（id/name/icon）", () => {
    const catsM = modern.getCategories();
    const catsL = legacy.getCategories();
    expect(catsM).toEqual(catsL);
    expect(catsM).toHaveLength(12);
    expect(catsM.map((c) => c.id)).toEqual(["gongwen", "huibao", "yanjiu", "guihua", "hangye", "lunwen", "huiyi", "diaoyan", "kuangjia", "tubiao", "htmlppt", "sucaiku"]);
  });
});

describe("s3-tpl-parity getTemplates", () => {
  it("全量模板列表 JSON 互等（同锚物理扫描，含 size/mtime/title）", () => {
    const allM = modern.getTemplates();
    const allL = legacy.getTemplates();
    expect(normalize(allM)).toEqual(normalize(allL));
    expect(allM.length).toBeGreaterThan(0);
  });

  it("结构不变式：id 前缀/type 投影/去重/htmlppt 只收 example.html", () => {
    const all = modern.getTemplates();
    for (const t of all) {
      expect(t.id).toBe(`${t.category}/${t.relPath}`);
      expect(t.ext).not.toMatch(/^\./);
      const markdownExts = ["md", "markdown"];
      const expectedType = markdownExts.includes(t.ext) ? "markdown"
        : t.ext === "html" || t.ext === "htm" ? "html"
        : t.ext === "docx" || t.ext === "doc" ? "word"
        : t.ext === "pdf" ? "pdf"
        : t.ext === "pptx" || t.ext === "ppt" ? "ppt"
        : t.ext === "xlsx" || t.ext === "xls" ? "xls"
        : "other";
      expect(t.type).toBe(expectedType);
      expect(typeof t.size).toBe("number");
      expect(typeof t.mtime).toBe("number");
    }
    // relPath 去重（同一 relPath 只出现一次）
    const relPaths = all.map((t) => t.relPath);
    expect(new Set(relPaths).size).toBe(relPaths.length);
    // htmlppt 分类只收 example.html
    const htmlppt = all.filter((t) => t.category === "htmlppt");
    for (const t of htmlppt) expect(t.name).toBe("example.html");
    // sucaiku 只收 .md
    for (const t of all.filter((x) => x.category === "sucaiku")) expect(t.ext).toBe("md");
  });

  it("getTemplatesByCategory：过滤与 all 直通/空值直通", () => {
    const all = modern.getTemplates();
    expect(modern.getTemplatesByCategory("all")).toEqual(all);
    expect(modern.getTemplatesByCategory("")).toEqual(all);
    expect(normalize(modern.getTemplatesByCategory("sucaiku"))).toEqual(normalize(legacy.getTemplatesByCategory("sucaiku")));
    expect(normalize(modern.getTemplatesByCategory("htmlppt"))).toEqual(normalize(legacy.getTemplatesByCategory("htmlppt")));
    for (const t of modern.getTemplatesByCategory("sucaiku")) expect(t.category).toBe("sucaiku");
  });
});

describe("s3-tpl-parity resolveTemplatePath / getTemplateContent", () => {
  it("resolveTemplatePath：相对双根 / 绝对 / 目录拒绝 / 缺失 null", () => {
    const md = modern.getTemplates().find((t) => t.ext === "md")!;
    const resolvedM = modern.resolveTemplatePath(md.relPath);
    const resolvedL = legacy.resolveTemplatePath(md.relPath);
    expect(resolvedM).toBe(resolvedL);
    expect(resolvedM).toBeTruthy();
    expect(path.isAbsolute(resolvedM!)).toBe(true);
    // 绝对路径直通
    expect(modern.resolveTemplatePath(resolvedM!)).toBe(resolvedL);
    // 目录 → isFile false → null
    expect(modern.resolveTemplatePath("templates/traffic-material")).toBeNull();
    expect(modern.resolveTemplatePath("templates/traffic-material")).toBe(legacy.resolveTemplatePath("templates/traffic-material"));
    // 缺失 → null（双根都不存在时回落 c1 但 existsSync false）
    expect(modern.resolveTemplatePath("__no_such__/file.md")).toBeNull();
  });

  it("getTemplateContent：markdown 文本读取互等", () => {
    const md = modern.getTemplates().find((t) => t.ext === "md")!;
    const cL = legacy.getTemplateContent(md.relPath);
    const cM = modern.getTemplateContent(md.relPath);
    expect(normalize(cM)).toEqual(normalize(cL));
    expect(cM.type).toBe("text");
    expect(typeof (cM as any).content).toBe("string");
  });

  it("getTemplateContent：html 文本 / 缺失 null", () => {
    const html = modern.getTemplates().find((t) => t.ext === "html");
    if (html) {
      const cM = modern.getTemplateContent(html.relPath);
      expect(cM.type).toBe("text");
    }
    expect(modern.getTemplateContent("__no_such__/x.md")).toBeNull();
  });

  it("refresh 后重扫互等", () => {
    legacy.refresh();
    modern.refresh();
    expect(normalize(modern.getTemplates())).toEqual(normalize(legacy.getTemplates()));
  });
});
