/**
 * S3-7 kb 域对拍：配置（loadConfig/status 与真实根 kb.json 同锚点）/ 空输入行为
 * （search 空查询与 limit=0 / getDoc 缺文档 / getTree/getTreeLevel 越界 rootIdx /
 * getGraph 空索引平凡结构）/ 真实扫描面（getFileList 投影 + 逐文档 content 抽样）/
 * 搜索加权（动态取词 + 固定词，含 rootIdx 过滤与 limit 截断）/ getDoc 链接反链提及 /
 * getTree 树形与 getTreeLevel 懒加载 subCount / getGraph 全 include（links/tags/
 * folders/similar 相似边 simCache 确定性）/ ingestDocx（构造最小 docx 入库 + addRoot
 * 幂等）/ exportDocx（标题层级映射 + 同名避让）。
 *
 * 真实 IO 双跑：legacy pathToFileURL 物理加载 server/kb.mjs、modern 静态 import
 * src/main/backend/kb.ts。kb.mjs 模块加载期即以项目根 kb.json 为锚点（CONFIG_FILE）
 * 并启动预扫描——两侧同锚点同配置文件，天然一致。roots 指向外部盘（F:\ 等），
 * 断言一律「双侧互等」不硬编码内容；外部盘缺失时退化为空索引对拍（同样有效）。
 *
 * ima 系仅对拍 imaStatus（纯探测无外部调用）；imaListBases/imaSearch/imaDoc 依赖
 * 外部 CLI（execFile ima_api.cjs），测试不得真实外呼，留域退役前联调（有意不做）。
 * ingest/export 涉及真实工作区写盘与 kb.json addRoot：beforeAll 记工作区快照，
 * afterAll 差集清理 + removeRoot 成对恢复 kb.json。addRoot/removeRoot 写盘路径
 * 经 ingest/export 用例间接覆盖，不做独立写盘对拍（避免二次污染）。
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as modern from "../src/main/backend/kb";
import { getWorkspace } from "../src/main/backend/workspace";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "../..");

const IMPLS = ["legacy", "modern"] as const;
type ImplKind = (typeof IMPLS)[number];
type KbModule = typeof modern;

const mod = {} as Record<ImplKind, KbModule>;
let wsBefore: string[] = [];

beforeAll(async () => {
  mod.legacy = await import(pathToFileURL(path.join(PROJECT_ROOT, "server/kb.mjs")).href) as unknown as KbModule;
  mod.modern = modern;
  const ws = getWorkspace();
  wsBefore = fs.existsSync(ws) ? fs.readdirSync(ws) : [];
  // force 重扫：预扫描为非 force 首扫，这里强制双侧同起点（同 roots 同磁盘状态）
  await mod.legacy.scan(true);
  await mod.modern.scan(true);
}, 120000);

afterAll(() => {
  // 差集清理工作区测试产物；removeRoot 成对恢复 kb.json（roots 原本不含工作区）
  const ws = getWorkspace();
  const after = fs.existsSync(ws) ? fs.readdirSync(ws) : [];
  for (const f of after) {
    if (!wsBefore.includes(f)) {
      try { fs.unlinkSync(path.join(ws, f)); } catch {}
    }
  }
  try { mod.legacy?.removeRoot(ws); } catch {}
  try { mod.modern?.removeRoot(ws); } catch {}
});

describe("S3-7 kb 对拍", () => {
  it("导出面一致（17 导出）", () => {
    expect(Object.keys(mod.modern).sort()).toEqual(Object.keys(mod.legacy).sort());
    for (const k of Object.keys(mod.modern)) {
      expect(typeof (mod.modern as any)[k]).toBe(typeof (mod.legacy as any)[k]);
    }
  });

  it("工作区锚点双侧一致（ingest/export 前置 sanity）", async () => {
    const legacyWs = await import(pathToFileURL(path.join(PROJECT_ROOT, "server/workspace.mjs")).href);
    expect(String((legacyWs as any).getWorkspace())).toBe(getWorkspace());
  });

  it("loadConfig / status / imaStatus 双侧深等（同锚点 kb.json）", async () => {
    expect(mod.legacy.loadConfig()).toEqual(mod.modern.loadConfig());
    expect(mod.legacy.status()).toEqual(mod.modern.status());
    expect(await mod.legacy.imaStatus()).toEqual(await mod.modern.imaStatus());
  });

  describe("空输入行为（双侧）", () => {
    it.each(IMPLS)("search 空查询与 limit=0 → []（%s）", (kind) => {
      expect(mod[kind].search("", null, 30)).toEqual([]);
      expect(mod[kind].search(null as any, null, 30)).toEqual([]);
      expect(mod[kind].search("知识", null, 0)).toEqual([]);
    });

    it.each(IMPLS)("getDoc 缺文档 → null（%s）", (kind) => {
      expect(mod[kind].getDoc("no-such-doc-xyz.md", null)).toBeNull();
    });

    it.each(IMPLS)("getTree/getTreeLevel 越界 rootIdx → 空（%s）", (kind) => {
      expect(mod[kind].getTree(9999)).toEqual([]);
      expect(mod[kind].getTreeLevel(9999, "")).toEqual({ dirs: [], files: [] });
    });

    it.each(IMPLS)("getGraph 空索引平凡结构（%s）", (kind) => {
      const r = mod[kind].getGraph({ rootIdx: 9999 });
      expect(r.nodes).toEqual([]);
      expect(r.edges).toEqual([]);
      expect(r.meta).toEqual({ total: 0, capped: false });
      expect(r.stats).toEqual({ nodes: 0, edges: 0, isolated: 0, brokenLinks: 0, edgeTypes: {}, totalNodes: 0, totalEdges: 0 });
    });
  });

  it("scan 后文件列表双侧投影深等", () => {
    const proj = (list: any[]) => list
      .map((f) => ({ relPath: f.relPath, rootIdx: f.rootIdx, size: f.size, mtimeMs: f.mtimeMs, title: f.doc.title, tags: f.doc.tags, headings: f.doc.headings, links: f.doc.links, contentLen: f.doc.content.length }))
      .sort((a, b) => `${a.rootIdx}/${a.relPath}`.localeCompare(`${b.rootIdx}/${b.relPath}`));
    expect(proj(mod.legacy.getFileList())).toEqual(proj(mod.modern.getFileList()));
  });

  it("逐文档 content 抽样双侧逐字节相等（前 3 篇 + rootIdx=0 首/末篇）", () => {
    const list = mod.legacy.getFileList();
    expect(mod.modern.getFileList().length).toBe(list.length);
    const picks = list.slice(0, 3);
    if (list.length) {
      picks.push(list.find((f) => f.rootIdx === 0)!);
      picks.push(list.filter((f) => f.rootIdx === 0).slice(-1)[0]!);
    }
    for (const f of picks) {
      if (!f) continue;
      const find = (m: KbModule) => m.getFileList().find((x: any) => x.abs === f.abs);
      expect(find(mod.modern)?.doc.content).toBe(find(mod.legacy)?.doc.content);
    }
  });

  it("search 加权打分双侧深等（动态取词 + 固定词 + rootIdx 过滤）", () => {
    const list = mod.legacy.getFileList();
    // 动态词：从首篇正文提取首个 2+ 字母/数字串；无索引时退化为固定词（空结果对拍）
    let word = "知识";
    const first = list[0];
    if (first) {
      const m = String(first.doc.content).match(/[\p{L}\p{N}]{2,}/u);
      if (m) word = m[0];
    }
    const modernResults = mod.modern.search(word, null, 30);
    expect(modernResults).toEqual(mod.legacy.search(word, null, 30));
    // rootIdx 过滤 + limit 截断
    expect(mod.modern.search(word, 0, 5)).toEqual(mod.legacy.search(word, 0, 5));
    expect(mod.modern.search(word, 9999, 30)).toEqual(mod.legacy.search(word, 9999, 30));
    expect(mod.modern.search(word, null, 1)).toEqual(mod.legacy.search(word, null, 1));
  });

  it("getDoc 首文档双侧深等（含链接/反链/提及）", () => {
    const first = mod.legacy.getFileList()[0];
    if (!first) return;
    expect(mod.modern.getDoc(first.relPath, first.rootIdx)).toEqual(mod.legacy.getDoc(first.relPath, first.rootIdx));
    expect(mod.modern.getDoc(first.relPath, null)).toEqual(mod.legacy.getDoc(first.relPath, null));
  });

  it("getTree / getTreeLevel 双侧深等（树形 + 懒加载 subCount/linkCount）", () => {
    const roots = mod.legacy.status().roots;
    for (let i = 0; i < roots.length; i++) {
      expect(mod.modern.getTree(i)).toEqual(mod.legacy.getTree(i));
      expect(mod.modern.getTreeLevel(i, "")).toEqual(mod.legacy.getTreeLevel(i, ""));
      // 逐一级目录下钻
      for (const d of mod.legacy.getTreeLevel(i, "").dirs) {
        expect(mod.modern.getTreeLevel(i, d.path)).toEqual(mod.legacy.getTreeLevel(i, d.path));
      }
    }
  });

  it("getGraph 双侧深等（默认 + include 全开 + maxNodes 钳制）", () => {
    expect(mod.modern.getGraph()).toEqual(mod.legacy.getGraph());
    const all = { include: ["links", "tags", "folders", "similar"] };
    expect(mod.modern.getGraph(all)).toEqual(mod.legacy.getGraph(all));
    expect(mod.modern.getGraph({ ...all, maxNodes: 3 })).toEqual(mod.legacy.getGraph({ ...all, maxNodes: 3 }));
    expect(mod.modern.getGraph({ include: "links" })).toEqual(mod.legacy.getGraph({ include: "links" }));
  });

  it("ingestDocx 双侧深等：最小 docx 入库并注册工作区根", async () => {
    const ws = getWorkspace();
    fs.mkdirSync(ws, { recursive: true });
    // 构造最小 docx（word/document.xml：heading1 + 正文 + heading2 + 正文）
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    zip.file("word/document.xml", [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>',
      '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>S3-7 对拍文档</w:t></w:r></w:p>',
      '<w:p><w:r><w:t>第一段正文，包含关键词 银川 </w:t></w:r></w:p>',
      '<w:p><w:pPr><w:pStyle w:val="2"/></w:pPr><w:r><w:t>二级标题</w:t></w:r></w:p>',
      '<w:p><w:r><w:t>第二段正文</w:t></w:r></w:p>',
      '</w:body></w:document>',
    ].join(""));
    const buf = await zip.generateAsync({ type: "nodebuffer" });
    fs.writeFileSync(path.join(ws, "s3-kb-parity-test.docx"), buf);
    // 工作区中可能残留同名 md（前次中断），先清
    const mdPath = path.join(ws, "s3-kb-parity-test.md");
    if (fs.existsSync(mdPath)) fs.unlinkSync(mdPath);

    const legacyR = await mod.legacy.ingestDocx("s3-kb-parity-test.docx");
    const modernR = await mod.modern.ingestDocx("s3-kb-parity-test.docx");
    expect(modernR).toEqual(legacyR);
    expect(legacyR.ok).toBe(true);
    expect(legacyR.mdName).toBe("s3-kb-parity-test.md");
    // 入库产物 md 双侧逐字节一致；新根注册后文档可检索
    expect(fs.readFileSync(mdPath, "utf8")).toBe(
      "# S3-7 对拍文档\n\n第一段正文，包含关键词 银川\n\n## 二级标题\n\n第二段正文\n"
    );
    await mod.legacy.scan(true);
    await mod.modern.scan(true);
    const legacyDoc = mod.legacy.getDoc("s3-kb-parity-test.md", null);
    expect(mod.modern.getDoc("s3-kb-parity-test.md", null)).toEqual(legacyDoc);
    expect(legacyDoc?.title).toBe("S3-7 对拍文档");
    expect(mod.legacy.status().roots.some((r: any) => path.resolve(r.path) === path.resolve(ws))).toBe(true);
    expect(mod.modern.status().roots.some((r: any) => path.resolve(r.path) === path.resolve(ws))).toBe(true);
  }, 60000);

  it("exportDocx 双侧深等：标题层级映射与落盘（同名避让经清理后可复现）", async () => {
    const ws = getWorkspace();
    const target = mod.legacy.getDoc("s3-kb-parity-test.md", null);
    if (!target) return; // 前置 ingest 失败时本用例无从展开（上一用例已报）
    const run = async (kind: ImplKind) => {
      // 清同名产物，保证 existing 快照一致、返回名可复现
      const m = /^(.*)\.docx$/.exec(`${target.title}.docx`);
      for (const cand of [`${m![1]}.docx`, `${m![1]} 2.docx`, `${m![1]} 3.docx`]) {
        const p = path.join(ws, cand);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
      const r = await (mod[kind] as any).exportDocx("s3-kb-parity-test.md", null);
      const produced = r.ok ? path.join(ws, r.name!) : null;
      const exists = produced ? fs.existsSync(produced) : false;
      return { r, exists };
    };
    const legacyRun = await run("legacy");
    const modernRun = await run("modern");
    expect(modernRun.r).toEqual(legacyRun.r);
    expect(legacyRun.r.ok).toBe(true);
    expect(legacyRun.r.name).toBe(`${target.title}.docx`);
    expect(legacyRun.exists).toBe(true);
    expect(modernRun.exists).toBe(true);
    // 非法字符替换：title 含文件系统保留字符时以 _ 落盘（双侧同规则）
    expect(legacyRun.r.name).not.toMatch(/[\\/:*?"<>|]/);
  }, 60000);
});
