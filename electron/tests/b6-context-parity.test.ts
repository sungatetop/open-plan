import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import XLSX from "xlsx";

// B6-5 对拍：旧 server/context.mjs ↔ 新 electron/src/main/backend/agent/context.ts。
//
// 基建设计（双侧同流，沿 B6-4 假根范式）：
// - vi.mock("node:url") 仅定向 fileURLToPath：旧 workspace.mjs/context.mjs 与新
//   workspace-paths.ts 的 __dirname 分别重定向到两个假根（fakeOld/fakeNew）→ 双侧
//   PROJECT_DIR 各自隔离（fakeOld/server ↔ fakeNew/electron/src/main/backend），
//   .规聚会话 会话夹具与 workspace 状态文件都落在假根下，不触碰真实运行时数据。
// - kb.mjs/tpl.mjs 属独立域（过渡桥动态引用）：vi.mock 按 resolved id 命中——旧侧
//   import("./kb.mjs") 与新侧 6 级上跳变量 import 解析到同一物理文件，mock 双侧生效；
//   测试只对拍 context 侧逻辑（target 解析/rootIdx 查找/文本拼装），域模块本身不在本批范围。
// - vi.mock("node:child_process") 定向 execFile：受控 handler 覆盖 pdftotext 成功/失败兜底/
//   OCR 链（pdftoppm 真建 png、tesseract 成功/失败/空输出），双侧 promisify 包装一致。
// - docx/pptx 夹具用 JSZip 生成、xlsx 夹具用 XLSX.writeFile 生成，双侧各自生成相同内容。
// - mtime/version（含 st.mtimeMs）双侧时钟必异：scrub 删除 mtime、version 归一 "<V>:…"；
//   addFileRoot 的 root.id = sha1(双侧路径) 必异：40 位 hex 的 id/rootId 归一 "<ID>"（沿 B6-4）。
// - fake timers 仅 toFake:["Date"]：readAt/cachedAt 冻结对齐；queueMicrotask 不受影响。

type AnyMod = Record<string, any>;

const hoisted = vi.hoisted(() => {
  const base = (process.env.TEMP || process.env.TMP || "/tmp").replace(/[\\/]+$/, "");
  const stamp = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    fakeOld: `${base}/oaw-b65-old-${stamp}`,
    fakeNew: `${base}/oaw-b65-new-${stamp}`,
    kbState: {
      roots: [{ name: "根甲" }, { name: "根乙" }] as Array<{ name: string }>,
      docsByRoot: {} as Record<number, { title: string; content: string } | undefined>,
      docFallback: null as { title: string; content: string } | null,
      tree: null as { dirs?: Array<{ name?: string; path?: string }>; files?: Array<{ title?: string; name?: string; relPath?: string }> } | null,
    },
    tplState: { path: null as string | null, content: null as any },
    execCalls: [] as Array<{ file: string; args: string[] }>,
    execHandler: null as null | ((file: string, args: string[]) => string),
  };
});

vi.mock("node:url", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:url")>();
  const map: Array<[string, string]> = [
    ["server/workspace.mjs", `${hoisted.fakeOld}/server/workspace.mjs`],
    ["server/context.mjs", `${hoisted.fakeOld}/server/context.mjs`],
    ["electron/src/main/backend/workspace-paths.ts", `${hoisted.fakeNew}/electron/src/main/backend/workspace-paths.ts`],
  ];
  return {
    ...actual,
    fileURLToPath: (url: URL | string) => {
      const s = String(url);
      for (const [suffix, mapped] of map) if (s.endsWith(suffix)) return mapped;
      return actual.fileURLToPath(url as URL);
    },
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (file: string, args: string[], opts?: unknown, cb?: unknown) => {
      const callback = (typeof opts === "function" ? opts : cb) as (err: unknown, out?: { stdout?: string; stderr?: string }) => void;
      hoisted.execCalls.push({ file, args });
      queueMicrotask(() => {
        try {
          const stdout = hoisted.execHandler!(file, args);
          callback(null, { stdout, stderr: "" });
        } catch (err) {
          callback(err);
        }
      });
      return { pid: 0, kill: () => {}, unref: () => {}, on: () => {} };
    },
  };
});

vi.mock("../../server/kb.mjs", () => ({
  scan: async () => {},
  status: () => ({ roots: hoisted.kbState.roots }),
  getDoc: (relPath: string, rootIdx: number | null) => {
    if (rootIdx === null || rootIdx < 0 || rootIdx >= hoisted.kbState.roots.length) return hoisted.kbState.docFallback;
    return hoisted.kbState.docsByRoot[rootIdx] ?? hoisted.kbState.docFallback;
  },
  getTreeLevel: () => hoisted.kbState.tree,
}));

// S3-7 起 context.ts knowledge 分支换绑 TS backend/kb（KB_MODULE_PATH="../kb"），
// 新侧 mock 与旧侧共享同一 kbState，双链各自命中（工厂形态同上，非 getter——
// kbState 字段每用例整体重置，取值时解引用即可）。
vi.mock("../src/main/backend/kb", () => ({
  scan: async () => {},
  status: () => ({ roots: hoisted.kbState.roots }),
  getDoc: (relPath: string, rootIdx: number | null) => {
    if (rootIdx === null || rootIdx < 0 || rootIdx >= hoisted.kbState.roots.length) return hoisted.kbState.docFallback;
    return hoisted.kbState.docsByRoot[rootIdx] ?? hoisted.kbState.docFallback;
  },
  getTreeLevel: () => hoisted.kbState.tree,
}));

vi.mock("../../server/tpl.mjs", () => ({
  resolveTemplatePath: () => hoisted.tplState.path,
  getTemplateContent: () => hoisted.tplState.content,
}));

// S3-10 起 context.ts template 分支换绑 TS backend/tpl（TPL_MODULE_PATH="../tpl"），
// 新侧 mock 与旧侧共享同一 tplState，双链各自命中（kb 先例同款工厂形态）。
vi.mock("../src/main/backend/tpl", () => ({
  resolveTemplatePath: () => hoisted.tplState.path,
  getTemplateContent: () => hoisted.tplState.content,
}));

// 路径归一：假根与其下 PROJECT_DIR 先长后短替换；tempRoot 经 realpath 注册
const ROOTS: Array<[string, string]> = [];

function pushRoot(real: string, tag: string): void {
  ROOTS.push([real, tag]);
  const lower = real.toLowerCase();
  if (lower !== real) ROOTS.push([lower, tag]);
}

function oldProjectDir(): string {
  // 旧 workspace.mjs PROJECT_DIR = resolve(server, "..") = 假根顶层
  return hoisted.fakeOld.replace(/\//g, path.sep);
}

function newProjectDir(): string {
  // 新 workspace-paths.ts PROJECT_DIR = resolve(__dirname, "..","..","..","..") = 假根顶层
  return hoisted.fakeNew.replace(/\//g, path.sep);
}

function resetRoots(): void {
  ROOTS.length = 0;
  pushRoot(hoisted.fakeOld.replace(/\//g, path.sep), "<R>");
  pushRoot(hoisted.fakeNew.replace(/\//g, path.sep), "<R>");
}

resetRoots();

function normalizePaths(value: any): any {
  if (typeof value === "string") {
    let out = value;
    for (const [from, to] of ROOTS) out = out.split(from).join(to);
    return out;
  }
  if (Array.isArray(value)) return value.map((item) => normalizePaths(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizePaths(item)]));
  return value;
}

/** 双侧时钟差异消除：删 mtime；version 首段（size:mtimeMs）归一；40 位 hex 的 id/rootId 归一 <ID>。 */
function scrub(value: any): any {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    const out: any = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === "mtime") continue;
      if (key === "version") { out[key] = String(item).replace(/^\d+:\d+(?:\.\d+)?:/, "<V>:"); continue; }
      // addFileRoot 的 root.id / 引用 rootId = sha1(路径) 截 12 位（双侧必异）→ <ID>；
      // Reference.id = "ref_" + sha1(JSON(ref)) 截 12 位，ref 含 rootId 时双侧必异 → 一并归一；
      // parseReferences 用例单独断言无 rootId 引用的 id 双侧一致，metadata.hash 键名不匹配不受影响
      if ((key === "id" || key === "rootId") && typeof item === "string" && /^(?:ref_)?[0-9a-f]{12}$/.test(item)) { out[key] = "<ID>"; continue; }
      out[key] = scrub(item);
    }
    return out;
  }
  return value;
}

function tempRoot(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `b65-${label}-`));
  pushRoot(fs.realpathSync(dir), "<R>");
  return dir;
}

function expectSame(actual: unknown, expected: unknown): void {
  expect(scrub(normalizePaths(actual))).toEqual(scrub(normalizePaths(expected)));
}

async function loadMods(side: "old" | "nw", env: Record<string, string>): Promise<{ ws: AnyMod; ctx: AnyMod }> {
  vi.unstubAllEnvs();
  vi.resetModules();
  // 状态文件在 PROJECT_DIR（假根顶层）下：清掉避免 roots/hiddenWorkspaces 跨用例残留
  for (const root of [hoisted.fakeOld, hoisted.fakeNew]) {
    fs.rmSync(path.join(root, ".workspace-state.json"), { force: true });
    fs.rmSync(path.join(root, ".file-roots.json"), { force: true });
  }
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  if (side === "old") {
    const ws = (await import("../../server/workspace.mjs")) as unknown as AnyMod;
    const ctx = (await import("../../server/context.mjs")) as unknown as AnyMod;
    return { ws, ctx };
  }
  const ws = (await import("../src/main/backend/workspace")) as unknown as AnyMod;
  const ctx = (await import("../src/main/backend/agent/context")) as unknown as AnyMod;
  return { ws, ctx };
}

type CtxCtx = { ws: string; ext: string; side: "old" | "nw" };

/** 双侧同流：每侧独立工作区/外部根临时目录 + 假根下会话夹具。 */
async function runBoth(env: Record<string, string>, script: (m: { ws: AnyMod; ctx: AnyMod }, c: CtxCtx) => Promise<any> | any): Promise<[any, any]> {
  const results: any[] = [];
  for (const side of ["old", "nw"] as const) {
    const ws = tempRoot("ws");
    const ext = tempRoot("ext");
    const mods = await loadMods(side, { OAW_ENABLE_OCR: "", ...env });
    fs.mkdirSync(path.join(side === "old" ? oldProjectDir() : newProjectDir(), ".规聚会话"), { recursive: true });
    hoisted.execCalls.length = 0;
    results.push(await script(mods, { ws, ext, side }));
  }
  return [results[0], results[1]];
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-22T08:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  hoisted.execCalls.length = 0;
  hoisted.execHandler = null;
  hoisted.tplState.path = null;
  hoisted.tplState.content = null;
  hoisted.kbState.docsByRoot = {};
  hoisted.kbState.docFallback = null;
  hoisted.kbState.tree = null;
  resetRoots();
});

afterAll(() => {
  fs.rmSync(hoisted.fakeOld, { recursive: true, force: true });
  fs.rmSync(hoisted.fakeNew, { recursive: true, force: true });
});

// ── 夹具构造 ──

const MD_TEXT = ["L1 alpha", "L2 beta", "L3 gamma", "L4 Alpha", "L5 omega"].join("\n");

async function buildDocx(file: string): Promise<void> {
  const zip = new JSZip();
  zip.file("word/document.xml", '<w:document><w:body><w:p><w:r><w:t>第一段落</w:t></w:r></w:p><w:p><w:r><w:t>第二段落</w:t><w:t>续</w:t></w:r></w:p></w:body></w:document>');
  zip.file("word/other.xml", "<w:t>忽略</w:t>");
  fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));
}

async function buildPptx(file: string): Promise<void> {
  const zip = new JSZip();
  zip.file("ppt/slides/slide1.xml", '<p:sld><a:t>首页内容</a:t></p:sld>');
  zip.file("ppt/slides/slide2.xml", '<p:sld><a:t>次页内容</a:t></p:sld>');
  zip.file("ppt/notesSlides/notesSlide1.xml", "<a:t>备注忽略</a:t>");
  fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));
}

function buildXlsx(file: string): void {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["名称", "值"], ["甲", 1], ["乙", 2]]), "Sheet1");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["其他"], ["数据B"]]), "第二页");
  XLSX.writeFile(wb, file);
}

/** 工作区夹具：覆盖全部抽取分支与边界（返回关键文件路径）。 */
async function buildFixtures(ws: string): Promise<Record<string, string>> {
  const f: Record<string, string> = {};
  f["md"] = path.join(ws, "报告.md");
  fs.writeFileSync(f["md"], MD_TEXT, "utf8");
  f["big"] = path.join(ws, "大文件.txt");
  fs.writeFileSync(f["big"], "A".repeat(60000), "utf8");
  f["docx"] = path.join(ws, "文档.docx");
  await buildDocx(f["docx"]);
  f["pptx"] = path.join(ws, "演示.pptx");
  await buildPptx(f["pptx"]);
  f["xlsx"] = path.join(ws, "数据.xlsx");
  buildXlsx(f["xlsx"]);
  f["bin"] = path.join(ws, "大.bin");
  fs.writeFileSync(f["bin"], "binary");
  for (const name of ["样例ok", "样例fail", "样例ocr", "样例ocrfail", "样例ocrempty", "样例cache"]) {
    const pdfPath = path.join(ws, `${name}.pdf`);
    f[`pdf-${name}`] = pdfPath;
    fs.writeFileSync(pdfPath, "%PDF-fake");
  }
  const nested = path.join(ws, "sub", "子目录");
  fs.mkdirSync(nested, { recursive: true });
  f["nested"] = path.join(nested, "嵌套.md");
  fs.writeFileSync(f["nested"], "嵌套内容", "utf8");
  return f;
}

function buildSessionFixture(): void {
  // 会话夹具由各用例写入双侧 PROJECT_DIR/.规聚会话（runBoth 已建目录）
}
void buildSessionFixture;

// ── 用例 ──

describe("B6-5 context 对拍：parseReferences", () => {
  it("六类显式标记 + 裸路径矩阵 + 排除 + 尾标点剥离 + 去重（双侧输出逐项相等）", async () => {
    await runBoth({}, ({ ctx }) => {
      const text = [
        "@知识库目录[规划库] 引言",
        "@知识库[规划/总纲.md@根乙]",
        "@模板目录[报告集]",
        "@模板[_报告模板/公文版面/通知.md]",
        "@文件[报告.md]",
        "&会话[会话A]",
        "裸 @子目录/嵌套.md 与",
        "@数据.xlsx#Sheet1!A1:B2 加",
        "@大报告.pdf#page=2-3，另",
        "@普通词 不算",
        "重复 @报告.md，结尾。",
      ].join("\n");
      const out = ctx.parseReferences(text);
      // 旧实现口径：裸路径循环只收"含 / 或 \\ 或扩展名结尾"的 target；
      // cell/locator（#Sheet!A1:B2、#page=…）裸写不以扩展名结尾，不入列（经 @文件[…] 显式入口才解析）。
      expect(out.map((r: any) => [r.kind, r.target, r.source])).toEqual([
        ["knowledge_dir", "规划库", "@知识库目录[规划库]"],
        ["knowledge", "规划/总纲.md@根乙", "@知识库[规划/总纲.md@根乙]"],
        ["template_dir", "报告集", "@模板目录[报告集]"],
        ["template", "_报告模板/公文版面/通知.md", "@模板[_报告模板/公文版面/通知.md]"],
        ["file", "报告.md", "@文件[报告.md]"],
        ["session", "会话A", "&会话[会话A]"],
        ["file", "子目录/嵌套.md", "@子目录/嵌套.md"],
      ]);
      return out;
    }).then(([a, b]) => {
      // id 稳定且双侧一致（sha1(JSON(ref))）
      expect(a.map((r: any) => r.id)).toEqual(b.map((r: any) => r.id));
      expect(a.map((r: any) => r.range ?? null)).toEqual(b.map((r: any) => r.range ?? null));
    });
  });

  it("cell/locator range 形状（经 @文件[] 显式入口）+ 裸路径排除显式标记 + 空输入", async () => {
    await runBoth({}, ({ ctx }) => {
      const cell = ctx.parseReferences("@文件[数据.xlsx#第二页!A1:B2]")[0];
      expect(cell.target).toBe("数据.xlsx");
      expect(cell.range).toEqual({ sheet: "第二页", cell: "A1:B2" });
      const locator = ctx.parseReferences("@文件[报告.pdf#p=2]")[0];
      expect(locator.range).toEqual({ page: 2 });
      const pageEnd = ctx.parseReferences("@文件[大报告.pdf#page=2-3]")[0];
      expect(pageEnd.range).toEqual({ page: 2, end: 3 });
      const slide = ctx.parseReferences("@文件[演示.pptx#slide=2]")[0];
      expect(slide.range).toEqual({ slide: 2 });
      const para = ctx.parseReferences("@文件[文档.docx#paragraph=3-4]")[0];
      expect(para.range).toEqual({ paragraph: 3, end: 4 });
      expect(ctx.parseReferences("没有引用的普通文本")).toEqual([]);
      expect(ctx.parseReferences("")).toEqual([]);
      expect(ctx.parseReferences("@报告.md")).toEqual([expect.objectContaining({ kind: "file", target: "报告.md" })]);
      return null;
    });
  });
});

describe("B6-5 context 对拍：resolveReference", () => {
  it("文件命中：metadata 完整对拍 + hash 锚点 + mime/版本形态", async () => {
    await runBoth({}, async ({ ws, ctx }, c) => {
      ws.setWorkspace(c.ws);
      await buildFixtures(c.ws);
      const resolved = ctx.resolveReference({ kind: "file", target: "报告.md" });
      expect(resolved.status).toBe("resolved");
      expect(resolved.metadata.relativePath).toBe("报告.md");
      expect(resolved.metadata.name).toBe("报告.md");
      expect(resolved.metadata.ext).toBe("md");
      expect(resolved.metadata.mime).toBe("text/markdown");
      expect(resolved.metadata.size).toBe(MD_TEXT.length);
      expect(resolved.metadata.hash).toBe(crypto.createHash("sha1").update(MD_TEXT).digest("hex"));
      expect(resolved.metadata.version).toMatch(/^\d+:\d+(?:\.\d+)?:[0-9a-f]{8}$/);
      return resolved;
    }).then(([a, b]) => expectSame(a, b));
  });

  it("目录引用：isDirectory + files 递归列表；readReference 对目录返回提示文案", async () => {
    await runBoth({}, async ({ ws, ctx }, c) => {
      ws.setWorkspace(c.ws);
      await buildFixtures(c.ws);
      const resolved = ctx.resolveReference({ kind: "file", target: "sub" });
      expect(resolved.status).toBe("resolved");
      expect(resolved.metadata.isDirectory).toBe(true);
      expect(resolved.metadata.files.map((x: any) => x.relativePath)).toEqual(["sub/子目录/嵌套.md"]);
      const read = await ctx.readReference({ kind: "file", target: "sub" });
      expect(read.text).toBe("目录引用需要逐个读取文件");
      return resolved;
    }).then(([a, b]) => expectSame(a, b));
  });

  it("外部根：addFileRoot + rootId 引用，relativePath 相对根", async () => {
    await runBoth({}, async ({ ws, ctx }, c) => {
      ws.setWorkspace(c.ws);
      fs.writeFileSync(path.join(c.ext, "ext-文件.md"), "外部内容", "utf8");
      const added = ws.addFileRoot(c.ext, "外部根");
      expect(added.ok).toBe(true);
      const resolved = ctx.resolveReference({ kind: "file", target: "ext-文件.md", rootId: added.root.id });
      expect(resolved.status).toBe("resolved");
      expect(resolved.metadata.relativePath).toBe("ext-文件.md");
      expect(resolved.metadata.rootId).toBe(added.root.id);
      const roots = ws.listFileRoots();
      expect(roots.map((r: any) => [r.label, r.path])).toEqual([["外部根", c.ext]]);
      return { resolved, roots };
    }).then(([a, b]) => expectSame(a, b));
  });

  it("missing/越界/无效 rootId/unsupported：消息与状态对拍", async () => {
    await runBoth({}, async ({ ws, ctx }, c) => {
      ws.setWorkspace(c.ws);
      await buildFixtures(c.ws);
      const missing = ctx.resolveReference({ kind: "file", target: "没有.md" });
      expect(missing.status).toBe("missing");
      expect(missing.message).toBe("文件不存在或不在已登记目录内");
      const escape = ctx.resolveReference({ kind: "file", target: "../外部.txt" });
      expect(escape.status).toBe("missing");
      const badRoot = ctx.resolveReference({ kind: "file", target: "x.md", rootId: "无此根" });
      expect(badRoot.status).toBe("missing");
      const unsupported = ctx.resolveReference({ kind: "file", target: "大.bin" });
      expect(unsupported.status).toBe("unsupported");
      const readUnsupported = await ctx.readReference({ kind: "file", target: "大.bin" });
      expect(readUnsupported.text).toBe("目录引用需要逐个读取文件");
      return { missing, escape, badRoot, unsupported };
    }).then(([a, b]) => expectSame(a, b));
  });

  it("session 命中/未命中：metadata 与文案对拍", async () => {
    await runBoth({}, async ({ ws, ctx }, c) => {
      ws.setWorkspace(c.ws);
      const sessDir = path.join(c.side === "old" ? oldProjectDir() : newProjectDir(), ".规聚会话");
      fs.writeFileSync(path.join(sessDir, "会话A.jsonl"), [
        JSON.stringify({ type: "other", message: { role: "system", content: "sys" } }),
        JSON.stringify({ type: "message", message: { role: "user", content: "帮我规划交通方案" } }),
        JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "好的，方案如下" }, { type: "text", text: "第二步完善路网" }] } }),
        "not-json-line",
        JSON.stringify({ type: "message", message: { role: "tool", content: "ignored" } }),
      ].join("\n"), "utf8");
      const hit = ctx.resolveReference({ kind: "session", target: "会话A" });
      expect(hit.status).toBe("resolved");
      expect(hit.metadata.name).toBe("会话A.jsonl");
      expect(hit.metadata.mime).toBe("text/plain");
      expect(hit.metadata.sessionId).toBe("会话A");
      const miss = ctx.resolveReference({ kind: "session", target: "不存在" });
      expect(miss.status).toBe("missing");
      expect(miss.message).toBe("未找到该历史会话");
      return { hit, miss };
    }).then(([a, b]) => expectSame(a, b));
  });

  it("knowledge 族 resolveReference 全部 deferred；readReference 对 template_dir 返回提示", async () => {
    await runBoth({}, async ({ ws, ctx }, c) => {
      ws.setWorkspace(c.ws);
      for (const [kind, target] of [["knowledge", "a"], ["knowledge_dir", "b"], ["template", "c"], ["template_dir", "d"]] as const) {
        const resolved = ctx.resolveReference({ kind, target });
        expect(resolved.status).toBe("deferred");
        expect(resolved.message).toBe("由知识库/模板索引解析");
      }
      const read = await ctx.readReference({ kind: "template_dir", target: "报告集" });
      expect(read.status).toBe("deferred");
      expect(read.message).toBe("模板目录引用请先选择具体模板文件");
      return null;
    });
  });

  it("resolveReferences：references + text 混合去重，逐项 resolve", async () => {
    await runBoth({}, async ({ ws, ctx }, c) => {
      ws.setWorkspace(c.ws);
      await buildFixtures(c.ws);
      fs.writeFileSync(path.join(c.ext, "ext-文件.md"), "外部内容", "utf8");
      const added = ws.addFileRoot(c.ext, "外部根");
      const out = ctx.resolveReferences(
        [{ kind: "file", target: "报告.md" }, { kind: "file", target: "报告.md" }, { kind: "file", target: "ext-文件.md", rootId: added.root.id }],
        "@报告.md @sub/子目录/嵌套.md",
      );
      expect(out.map((r: any) => [r.kind, r.target, r.status])).toEqual([
        ["file", "报告.md", "resolved"],
        ["file", "ext-文件.md", "resolved"],
        ["file", "sub/子目录/嵌套.md", "resolved"],
      ]);
      return out;
    }).then(([a, b]) => expectSame(a, b));
  });
});

describe("B6-5 context 对拍：readReference 抽取与编排", () => {
  it("md 直读 + query 过滤（大小写不敏感）", async () => {
    await runBoth({}, async ({ ws, ctx }, c) => {
      ws.setWorkspace(c.ws);
      await buildFixtures(c.ws);
      const full = await ctx.readReference({ kind: "file", target: "报告.md" });
      expect(full.text).toBe(MD_TEXT);
      expect(full.metadata.parser).toBe("md");
      expect(full.metadata.cacheHit).toBe(false);
      expect(full.truncated).toBe(false);
      const filtered = await ctx.readReference({ kind: "file", target: "报告.md" }, "ALPHA");
      expect(filtered.text).toBe(["L1 alpha", "L4 Alpha"].join("\n"));
      return { full, filtered };
    }).then(([a, b]) => expectSame(a, b));
  });

  it("截断：>MAX_READ_CHARS 输出 50000 + truncated", async () => {
    await runBoth({}, async ({ ws, ctx }, c) => {
      ws.setWorkspace(c.ws);
      await buildFixtures(c.ws);
      const out = await ctx.readReference({ kind: "file", target: "大文件.txt" });
      expect(out.text.length).toBe(50000);
      expect(out.truncated).toBe(true);
      return { len: out.text.length, truncated: out.truncated };
    }).then(([a, b]) => {
      expect(a).toEqual(b);
      expect(a.len).toBe(50000);
    });
  });

  it("applyRange：page/page+end/paragraph/slide/startLine+endLine（md + pptx）", async () => {
    await runBoth({}, async ({ ws, ctx }, c) => {
      ws.setWorkspace(c.ws);
      await buildFixtures(c.ws);
      const pageRange = await ctx.readReference({ kind: "file", target: "报告.md" }, "", { page: 2, end: 3 });
      expect(pageRange.text).toBe("L2 beta\nL3 gamma");
      const pageOnly = await ctx.readReference({ kind: "file", target: "报告.md" }, "", { page: 2 });
      expect(pageOnly.text).toBe("L2 beta");
      const paraRange = await ctx.readReference({ kind: "file", target: "报告.md" }, "", { paragraph: 2, end: 4 });
      expect(paraRange.text).toBe("L2 beta\nL3 gamma\nL4 Alpha");
      const lineRange = await ctx.readReference({ kind: "file", target: "报告.md" }, "", { startLine: 2, endLine: 4 });
      expect(lineRange.text).toBe("L2 beta\nL3 gamma\nL4 Alpha");
      const slideAll = await ctx.readReference({ kind: "file", target: "演示.pptx" }, "", { slide: 1, end: 2 });
      expect(slideAll.text).toBe("1. 首页内容\n2. 次页内容");
      const slideOne = await ctx.readReference({ kind: "file", target: "演示.pptx" }, "", { slide: 2 });
      expect(slideOne.text).toBe("2. 次页内容");
      return null;
    });
  });

  it("docx 抽取：仅 document.xml 段落文本", async () => {
    await runBoth({}, async ({ ws, ctx }, c) => {
      ws.setWorkspace(c.ws);
      await buildFixtures(c.ws);
      const out = await ctx.readReference({ kind: "file", target: "文档.docx" });
      expect(out.text).toBe("第一段落\n第二段落续");
      expect(out.metadata.parser).toBe("docx");
      expect(out.metadata.mime).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      return { text: out.text, parser: out.metadata.parser };
    }).then(([a, b]) => expect(a).toEqual(b));
  });

  it("pptx 抽取：slide 序号 + 文本；备注不混入", async () => {
    await runBoth({}, async ({ ws, ctx }, c) => {
      ws.setWorkspace(c.ws);
      await buildFixtures(c.ws);
      const out = await ctx.readReference({ kind: "file", target: "演示.pptx" });
      expect(out.text).toBe("1. 首页内容\n2. 次页内容");
      return out.text;
    }).then(([a, b]) => expect(a).toBe(b));
  });

  it("xlsx：全 sheet / sheet 选择（对象 range）/ cell 范围", async () => {
    await runBoth({}, async ({ ws, ctx }, c) => {
      ws.setWorkspace(c.ws);
      await buildFixtures(c.ws);
      const all = await ctx.readReference({ kind: "file", target: "数据.xlsx" });
      expect(all.text).toBe("## Sheet1\n名称,值\n甲,1\n乙,2\n\n## 第二页\n其他\n数据B");
      const onlySheet = await ctx.readReference({ kind: "file", target: "数据.xlsx", range: { sheet: "第二页" } });
      expect(onlySheet.text).toBe("## 第二页\n其他\n数据B");
      // @ 字符串入口不剥 @（裸路径语义）；cell 语法经 @文件[] 显式标记产出 ref 后读取
      const [cellRef] = ctx.parseReferences("@文件[数据.xlsx#第二页!A1:A2]");
      const cell = await ctx.readReference(cellRef);
      expect(cell.text).toBe("## 第二页!A1:A2\n其他\n数据B");
      return { all: all.text, onlySheet: onlySheet.text, cell: cell.text };
    }).then(([a, b]) => expect(a).toEqual(b));
  });

  it("pdf：pdftotext 成功；失败兜底文案（OCR 关）", async () => {
    await runBoth({}, async ({ ws, ctx }, c) => {
      ws.setWorkspace(c.ws);
      await buildFixtures(c.ws);
      hoisted.execHandler = (file) => {
        if (file === "pdftotext") return "PDF正文A\nPDF正文B";
        throw new Error("unexpected tool");
      };
      const ok = await ctx.readReference({ kind: "file", target: "样例ok.pdf" });
      expect(ok.text).toBe("PDF正文A\nPDF正文B");
      expect(ok.metadata.parser).toBe("pdf");
      expect(hoisted.execCalls.map((x) => x.file)).toEqual(["pdftotext"]);
      expect(hoisted.execCalls[0]!.args).toEqual([path.join(c.ws, "样例ok.pdf"), "-"]);
      hoisted.execHandler = () => { throw new Error("ENOENT"); };
      const fail = await ctx.readReference({ kind: "file", target: "样例fail.pdf" });
      expect(fail.text).toBe("[PDF 文本抽取工具不可用；可安装 poppler，或设置 OAW_ENABLE_OCR=1 启用可选 OCR。]");
      return { ok: ok.text, fail: fail.text };
    }).then(([a, b]) => expect(a).toEqual(b));
  });

  it("pdf OCR 链：pdftoppm 建图 + tesseract 成功/空输出；pdftoppm 失败兜底", async () => {
    await runBoth({ OAW_ENABLE_OCR: "1" }, async ({ ws, ctx }, c) => {
      ws.setWorkspace(c.ws);
      await buildFixtures(c.ws);
      hoisted.execHandler = (file, args) => {
        if (file === "pdftotext") throw new Error("ENOENT");
        if (file === "pdftoppm") {
          const prefix = args[args.length - 1];
          fs.writeFileSync(`${prefix}-1.png`, "png");
          fs.writeFileSync(`${prefix}-2.png`, "png");
          return "";
        }
        if (file === "tesseract") return `OCR(${path.basename(args[0]!)})`;
        throw new Error("unexpected tool");
      };
      const ocr = await ctx.readReference({ kind: "file", target: "样例ocr.pdf" });
      expect(ocr.text).toBe("page-1.png:\nOCR(page-1.png)\n\npage-2.png:\nOCR(page-2.png)");
      const tesseractArgs = hoisted.execCalls.filter((x) => x.file === "tesseract");
      expect(tesseractArgs.length).toBe(2);
      expect(tesseractArgs[0]!.args[2]).toBe("-l");
      expect(tesseractArgs[0]!.args[3]).toBe("eng");
      hoisted.execHandler = (file) => {
        if (file === "pdftotext" || file === "pdftoppm") throw new Error("ENOENT");
        throw new Error("unexpected tool");
      };
      const ocrFail = await ctx.readReference({ kind: "file", target: "样例ocrfail.pdf" });
      expect(ocrFail.text).toBe("[OCR 依赖不可用；请安装 pdftoppm 与 tesseract，或使用 PDF 文本层。]");
      hoisted.execHandler = (file, args) => {
        if (file === "pdftotext") throw new Error("ENOENT");
        if (file === "pdftoppm") {
          fs.writeFileSync(`${args[args.length - 1]}-1.png`, "png");
          return "";
        }
        if (file === "tesseract") return "   ";
        throw new Error("unexpected tool");
      };
      const ocrEmpty = await ctx.readReference({ kind: "file", target: "样例ocrempty.pdf" });
      expect(ocrEmpty.text).toBe("[OCR 未识别到文本；请检查 tesseract 与语言包。]");
      return null;
    });
  });

  it("OCR 语言包环境变量 OAW_OCR_LANG 透传", async () => {
    await runBoth({ OAW_ENABLE_OCR: "1", OAW_OCR_LANG: "chi_sim" }, async ({ ws, ctx }, c) => {
      ws.setWorkspace(c.ws);
      await buildFixtures(c.ws);
      hoisted.execHandler = (file, args) => {
        if (file === "pdftotext") throw new Error("ENOENT");
        if (file === "pdftoppm") {
          fs.writeFileSync(`${args[args.length - 1]}-1.png`, "png");
          return "";
        }
        if (file === "tesseract") return "识别文本";
        throw new Error("unexpected tool");
      };
      const out = await ctx.readReference({ kind: "file", target: "样例ocr.pdf" });
      expect(out.text).toBe("page-1.png:\n识别文本");
      const tesseractArgs = hoisted.execCalls.filter((x) => x.file === "tesseract");
      expect(tesseractArgs[0]!.args[3]).toBe("chi_sim");
      return null;
    });
  });

  it("文档缓存：二次命中 cacheHit + exec 不再调用；clearReadCache 后失效", async () => {
    await runBoth({}, async ({ ws, ctx }, c) => {
      ws.setWorkspace(c.ws);
      await buildFixtures(c.ws);
      hoisted.execHandler = () => "PDF缓存正文";
      const first = await ctx.readReference({ kind: "file", target: "样例cache.pdf" });
      const callsAfterFirst = hoisted.execCalls.length;
      expect(callsAfterFirst).toBe(1);
      expect(first.metadata.cacheHit).toBe(false);
      const second = await ctx.readReference({ kind: "file", target: "样例cache.pdf" });
      expect(second.metadata.cacheHit).toBe(true);
      expect(hoisted.execCalls.length).toBe(callsAfterFirst);
      expect(second.text).toBe(first.text);
      ctx.clearReadCache();
      const third = await ctx.readReference({ kind: "file", target: "样例cache.pdf" });
      expect(third.metadata.cacheHit).toBe(false);
      expect(hoisted.execCalls.length).toBe(callsAfterFirst + 1);
      return { first: first.metadata.readAt, second: second.metadata.readAt, third: third.metadata.readAt };
    }).then(([a, b]) => expect(a).toEqual(b));
  });

  it("template：text 分支 / word 分支（走 docx 抽取 + range）/ missing", async () => {
    await runBoth({}, async ({ ws, ctx }, c) => {
      ws.setWorkspace(c.ws);
      const f = await buildFixtures(c.ws);
      hoisted.tplState = { path: f["md"]!, content: { type: "text", content: "模板正文内容" } };
      const textMode = await ctx.readReference({ kind: "template", target: "公文通知" });
      expect(textMode.status).toBe("resolved");
      expect(textMode.text).toBe("模板正文内容");
      expect(textMode.metadata).toEqual({ relativePath: "公文通知", mime: "text/markdown", parser: "md" });
      hoisted.tplState = { path: f["docx"]!, content: { type: "word" } };
      const wordMode = await ctx.readReference({ kind: "template", target: "公文模板" }, "", { startLine: 1, endLine: 1 });
      expect(wordMode.text).toBe("第一段落");
      expect(wordMode.metadata.mime).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      expect(wordMode.metadata.parser).toBe("docx");
      expect(wordMode.metadata.relativePath).toBe("公文模板");
      hoisted.tplState = { path: null, content: null };
      const miss = await ctx.readReference({ kind: "template", target: "没有的模板" });
      expect(miss.status).toBe("missing");
      expect(miss.message).toBe("未找到模板 没有的模板");
      return { textMode: textMode.text, wordMode: wordMode.text, miss: miss.message };
    }).then(([a, b]) => expect(a).toEqual(b));
  });

  it("session readReference：全文 + query 过滤", async () => {
    await runBoth({}, async ({ ws, ctx }, c) => {
      ws.setWorkspace(c.ws);
      const sessDir = path.join(c.side === "old" ? oldProjectDir() : newProjectDir(), ".规聚会话");
      fs.writeFileSync(path.join(sessDir, "会话A.jsonl"), [
        JSON.stringify({ type: "message", message: { role: "user", content: "帮我规划交通方案" } }),
        JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "好的，方案如下" }, { type: "text", text: "第二步完善路网" }] } }),
      ].join("\n"), "utf8");
      const full = await ctx.readReference({ kind: "session", target: "会话A" });
      expect(full.text).toBe("用户：帮我规划交通方案\n\n助手：好的，方案如下\n第二步完善路网");
      const filtered = await ctx.readReference({ kind: "session", target: "会话A" }, "规划");
      expect(filtered.text).toBe("用户：帮我规划交通方案");
      return { full: full.text, filtered: filtered.text };
    }).then(([a, b]) => expect(a).toEqual(b));
  });

  it("knowledge：命中（rootIdx 按 @根名 定位）/ 未命中根 / 无根默认 / knowledge_dir 树与空目录", async () => {
    await runBoth({}, async ({ ws, ctx }, c) => {
      ws.setWorkspace(c.ws);
      hoisted.kbState.docsByRoot = { 1: { title: "总纲", content: "正文内容\n多行" } };
      const hit = await ctx.readReference({ kind: "knowledge", target: "规划/总纲.md@根乙" });
      expect(hit.status).toBe("resolved");
      expect(hit.text).toBe("# 总纲\n\n正文内容\n多行");
      expect(hit.metadata).toEqual({ relativePath: "规划/总纲.md", rootName: "根乙", mime: "text/markdown" });
      const badRoot = await ctx.readReference({ kind: "knowledge", target: "规划/总纲.md@根丙" });
      expect(badRoot.status).toBe("missing");
      expect(badRoot.message).toBe("未找到知识库文档 规划/总纲.md@根丙");
      const noRoot = await ctx.readReference({ kind: "knowledge", target: "规划/总纲.md" });
      expect(noRoot.status).toBe("missing");
      expect(noRoot.message).toBe("未找到知识库文档 规划/总纲.md");
      hoisted.kbState.tree = { dirs: [{ name: "子目录甲" }], files: [{ title: "文件甲", relPath: "a.md" }] };
      const dir = await ctx.readReference({ kind: "knowledge_dir", target: "规划@根甲" });
      expect(dir.status).toBe("resolved");
      expect(dir.text).toBe("[目录] 子目录甲\n[文件] 文件甲");
      expect(dir.metadata).toEqual({ relativePath: "规划", rootName: "根甲", mime: "text/plain", isDirectory: true });
      hoisted.kbState.tree = null;
      const emptyDir = await ctx.readReference({ kind: "knowledge_dir", target: "空目录@根甲" });
      expect(emptyDir.text).toBe("（目录为空）");
      return null;
    });
  });

  it("contextSummary：混合列表格式化", async () => {
    await runBoth({}, async ({ ws, ctx }, c) => {
      ws.setWorkspace(c.ws);
      await buildFixtures(c.ws);
      const resolved = ctx.resolveReferences([], "@报告.md &会话[会话A] @知识库[总纲]");
      const summary = ctx.contextSummary(resolved);
      expect(summary).toContain("resolved");
      return summary;
    }).then(([a, b]) => expect(a).toBe(b));
  });
});
