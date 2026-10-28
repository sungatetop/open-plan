/**
 * F4-3 doc 族直调对拍（doc-direct.ts 编排层，D 线模式：deps 全桩不加载域实现）。
 *
 * 覆盖面（行号锚点均指 server/index.mjs）：
 *   - manifest 锚点：7 通道全部在 DESKTOP_CHANNELS 且路由指向已审计路径；
 *     unknown → 404 unknown channel；
 *   - op:doc:open（L1069-1111）：resolvePath null → 404；md/markdown/txt/csv/json →
 *     {kind:"text"} + content + ext；html/htm → {kind:"htmlfile"}；pdf/image →
 *     url=/api/doc/:name/raw(+?cwd)；其余 → {kind:"html",url=…/html}；xlsx/xls →
 *     readWorkbook（depth 1 空 → depth 2 重试；逐表 depth 3；sheet/row/cell 网格投影）；
 *     officecli 双失败 → xlsx 包回退再失败 → 500 合并错误；client/thread →
 *     setCurrentFile(agentKey)，setCurrentFile 抛错吞掉；显式 cwd 进 identity 与 url；
 *   - op:doc:raw（L1006-1044）：404；mimeMap 矩阵（docx/pdf/png/svg/未知扩展名兜底
 *     octet-stream）；base64 载数据（HTTP 流式 → base64 架构等价）；readFileSync 抛错 500；
 *   - op:doc:text（L1047-1066）：非 .docx → 404；真 JSZip 解 docx → 段落 join("\n")
 *     （多 run 合并 / 空白段跳过）；无 word/document.xml → 400；读文件抛错 → 500；
 *   - op:doc:html（L1136-1157）：404；成功 → </body> 前注入 __oawPreview ready 消息；
 *     空渲染 → unsupported 占位页（.doc tips）；renderHtml 抛错 → 500 + error 占位页
 *     （渲染引擎信息 + detail）；
 *   - op:doc:comments（L1161-1216）：404；md/markdown/txt 会话提取（user 消息 /
 *     数组 content 拼接 / 非 user 跳过 / 坏行跳过 / 去重 / 20 条上限 / date 三级回退）；
 *     docx → queryComments results 映射（format.author/date 优先）；queryComments 抛错 →
 *     {comments:[]}；
 *   - op:doc:outline（L1355-1384）：404；runOfficecli get --depth 3 → 标题启发式
 *     （Heading N → level min(6,N)；标题 N；非标题跳过；children 递归；120 截断）；
 *     runOfficecli 抛错 → {outline:[]}；
 *   - op:doc:annotations（L524-535）：basename 防越界（".." → 空列表）；不存在 → 空列表；
 *     存在 → JSON 解析（路径 .annotations/<basename>.json）；坏 JSON → 空列表；
 *     identity.revision 恒空串（server 不 stat）。
 */
import { describe, expect, test, beforeEach, vi } from "vitest";
import { createHash } from "node:crypto";
import path from "node:path";
import type * as DocModule from "../src/main/ipc/doc-direct";
import { DESKTOP_CHANNELS, type InvokeEnvelope } from "../src/shared/protocol/channels";

type Doc = typeof DocModule;
let svc: Doc;

beforeEach(async () => {
  svc = await import("../src/main/ipc/doc-direct");
});

/** statSync 固定值 → revision = sha1("5:100") 前 16 位（与 server previewFileRevision 一致）。 */
const REV = createHash("sha1").update("5:100").digest("hex").slice(0, 16);

function identityOf(relativePath: string, cwd = "D:\\ws", revision = REV) {
  return { workspaceId: cwd, cwd, relativePath: relativePath.replace(/\\/g, "/"), revision };
}

function makeDeps(overrides: Partial<DocModule.DocDirectDeps> = {}) {
  return {
    getWorkspace: vi.fn(() => "D:\\ws"),
    normalizeWorkspace: vi.fn((dir: string) => (dir === "显式" || dir === "E:\\显式ws" ? "E:\\显式ws" : null)),
    resolvePath: vi.fn((rel: string, ws?: string) => (rel === "不存在.md" ? null : path.join(ws || "D:\\ws", rel))),
    setCurrentFile: vi.fn(async () => ({})),
    officeGet: vi.fn(async () => ({ json: { data: { results: [] } } })),
    renderHtml: vi.fn(async () => "<html><body><p>渲染内容</p></body></html>"),
    queryComments: vi.fn(async () => ({ json: { data: { results: [] } } })),
    runOfficecli: vi.fn(async () => ({ json: { data: { results: [] } } })),
    listSessionFiles: vi.fn(() => []),
    readSessionTextCached: vi.fn(() => ""),
    existsSync: vi.fn(() => false),
    statSync: vi.fn(() => ({ mtimeMs: 100.9, size: 5 })),
    readFileSync: vi.fn(() => Buffer.from("")),
    ...overrides
  } as never as DocModule.DocDirectDeps & Record<string, ReturnType<typeof vi.fn>>;
}

function invoke(channel: DocModule.DocDirectChannel, envelope: InvokeEnvelope | undefined, deps = makeDeps()) {
  return svc.invokeDocDirect(channel, envelope, deps);
}

describe("F4-3 manifest 锚点", () => {
  test("14 条通道全部在 DESKTOP_CHANNELS 且路由指向已审计路径（F4-3 读 7 + F4-4 写 7）", () => {
    expect(svc.DOC_DIRECT_CHANNELS).toHaveLength(14);
    const expectedRoutes: Record<string, { method: string; path: string }> = {
      "op:doc:open": { method: "GET", path: "/api/doc/:name" },
      "op:doc:raw": { method: "GET", path: "/api/doc/:name/raw" },
      "op:doc:text": { method: "GET", path: "/api/doc/:name/text" },
      "op:doc:html": { method: "GET", path: "/api/doc/:name/html" },
      "op:doc:comments": { method: "GET", path: "/api/doc/:name/comments" },
      "op:doc:outline": { method: "GET", path: "/api/doc/:name/outline" },
      "op:doc:annotations": { method: "GET", path: "/api/doc/:name/annotations" },
      "op:doc:annotations-save": { method: "POST", path: "/api/doc/:name/annotations" },
      "op:doc:raw-save": { method: "POST", path: "/api/doc/:name/raw-save" },
      "op:doc:cells": { method: "POST", path: "/api/doc/:name/cells" },
      "op:doc:edit": { method: "POST", path: "/api/doc/edit" },
      "op:office:run": { method: "POST", path: "/api/office" },
      "op:doc:watch": { method: "GET", path: "/api/doc/:name/watch" },
      "op:doc:watch-stop": { method: "POST", path: "/api/doc/:name/watch/stop" }
    };
    for (const channel of svc.DOC_DIRECT_CHANNELS) {
      expect(DESKTOP_CHANNELS[channel as keyof typeof DESKTOP_CHANNELS]).toEqual(expectedRoutes[channel]);
    }
  });

  test("unknown channel → 404", async () => {
    const result = await svc.invokeDocDirect("op:doc:nonexistent", {}, makeDeps());
    expect(result).toEqual({ ok: false, status: 404, data: { error: "unknown channel: op:doc:nonexistent" } });
  });
});

describe("F4-3 op:doc:open（L1069-1111）", () => {
  test("resolvePath null → 404 not found", async () => {
    const result = await invoke("op:doc:open", { params: { name: "不存在.md" } });
    expect(result).toEqual({ ok: false, status: 404, data: { error: "not found" } });
  });

  test("md → {kind:text} + content + ext + identity（revision 派生自 stat）", async () => {
    const deps = makeDeps({ readFileSync: vi.fn(() => Buffer.from("# 方案\n内容", "utf8")) });
    const result = await invoke("op:doc:open", { params: { name: "方案.md" } }, deps);
    expect(result).toEqual({
      ok: true, status: 200,
      data: { kind: "text", name: "方案.md", content: "# 方案\n内容", ext: "md", identity: identityOf("方案.md") }
    });
  });

  test("identity.relativePath 反斜杠归一为正斜杠；txt/csv/json/markdown 同分支", async () => {
    const result = await invoke("op:doc:open", { params: { name: "子\\方案.csv" } });
    expect((result.data as any).identity.relativePath).toBe("子/方案.csv");
    for (const name of ["笔记.txt", "数据.json", "说明.markdown"]) {
      const r = await invoke("op:doc:open", { params: { name } });
      expect((r.data as any).kind).toBe("text");
    }
  });

  test("html/htm → {kind:htmlfile}；pdf → url raw；图片 → url raw；docx → url html", async () => {
    const html = await invoke("op:doc:open", { params: { name: "页面.html" } });
    expect((html.data as any).kind).toBe("htmlfile");
    const htm = await invoke("op:doc:open", { params: { name: "页面.htm" } });
    expect((htm.data as any).kind).toBe("htmlfile");

    const pdf = await invoke("op:doc:open", { params: { name: "报告.pdf" } });
    expect((pdf.data as any)).toMatchObject({ kind: "pdf", ext: "pdf", url: "/api/doc/%E6%8A%A5%E5%91%8A.pdf/raw" });

    const img = await invoke("op:doc:open", { params: { name: "图.png" } });
    expect((img.data as any)).toMatchObject({ kind: "image", ext: "png", url: "/api/doc/%E5%9B%BE.png/raw" });

    const docx = await invoke("op:doc:open", { params: { name: "方案.docx" } });
    expect((docx.data as any)).toMatchObject({ kind: "html", ext: "docx", url: "/api/doc/%E6%96%B9%E6%A1%88.docx/html" });
  });

  test("显式 cwd → resolvePath/identity/url 三处一致（?cwd= encodeURIComponent）", async () => {
    const result = await invoke("op:doc:open", { params: { name: "报告.pdf" }, query: { cwd: "显式" } });
    const data = result.data as any;
    expect(data.identity).toEqual(identityOf("报告.pdf", "E:\\显式ws"));
    expect(data.url).toBe(`/api/doc/%E6%8A%A5%E5%91%8A.pdf/raw?cwd=${encodeURIComponent("E:\\显式ws")}`);
    expect(data.identity.workspaceId).toBe("E:\\显式ws");
  });

  test("client/thread → setCurrentFile(agentKey)；无 client 不调；抛错吞掉仍成功", async () => {
    const deps = makeDeps();
    await invoke("op:doc:open", { params: { name: "方案.md" }, query: { client: "c1", thread: "t1" } }, deps);
    expect(deps.setCurrentFile).toHaveBeenCalledWith("c1::t1", "方案.md");

    await invoke("op:doc:open", { params: { name: "方案.md" }, query: { client: "c2" } }, deps);
    expect(deps.setCurrentFile).toHaveBeenLastCalledWith("c2", "方案.md");

    const noClient = makeDeps();
    await invoke("op:doc:open", { params: { name: "方案.md" } }, noClient);
    expect(noClient.setCurrentFile).not.toHaveBeenCalled();

    const throwing = makeDeps({ setCurrentFile: vi.fn(async () => { throw new Error("agent 不在线"); }) });
    const result = await invoke("op:doc:open", { params: { name: "方案.md" }, query: { client: "c1" } }, throwing);
    expect(result.ok).toBe(true);
  });

  test("xlsx：depth1 空 → depth2 重试枚举 sheets；逐表 depth3 取网格（sheet/row/cell 投影）", async () => {
    const sheetNodes = [
      { type: "sheet", path: "/sheet1.xml", preview: "Sheet1" },
      { type: "workbook", children: [{ type: "sheet", path: "/xl/worksheets/sheet2.xml", preview: "表2" }] }
    ];
    const deps = makeDeps({
      officeGet: vi.fn(async (_file: string, target?: string, depth?: number) => {
        if (target === "/") return (depth ?? 0) === 1 ? { json: { data: { results: [] } } } : { json: { data: { results: sheetNodes } } };
        if (target === "/sheet1.xml") {
          return { json: { data: { results: [{ type: "sheet", children: [
            { type: "row", path: "row[1]", children: [
              { type: "cell", path: "A1", text: "方案" },
              { type: "cell", path: "B1", text: "42" }
            ] }
          ] }] } } };
        }
        return { json: { data: { results: [{ type: "sheet", children: [
          { type: "row", path: "row[2]", children: [{ type: "cell", path: "C2", text: "汇总" }] }
        ] }] } } };
      })
    });
    const result = await invoke("op:doc:open", { params: { name: "报表.xlsx" } }, deps);
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      kind: "xlsx", name: "报表.xlsx",
      identity: identityOf("报表.xlsx"),
      sheets: ["Sheet1", "表2"],
      grids: {
        Sheet1: { 1: { cells: { 1: { text: "方案" }, 2: { text: "42" } } } },
        表2: { 2: { cells: { 3: { text: "汇总" } } } }
      }
    });
    const calls = (deps.officeGet as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]).toEqual([path.join("D:\\ws", "报表.xlsx"), "/", 1]);
    expect(calls[1]).toEqual([path.join("D:\\ws", "报表.xlsx"), "/", 2]);
    expect(calls[2]).toEqual([path.join("D:\\ws", "报表.xlsx"), "/sheet1.xml", 3]);
    expect(calls[3]).toEqual([path.join("D:\\ws", "报表.xlsx"), "/xl/worksheets/sheet2.xml", 3]);
  });

  test("officecli 双失败 → xlsx 包回退读失败 → 500 合并错误（officecli: … | xlsx: …）", async () => {
    const result = await invoke("op:doc:open", { params: { name: "报表.xlsx" } }, makeDeps({
      officeGet: vi.fn(async () => { throw new Error("officecli 不可用"); })
    }));
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    const message = (result.data as any).error as string;
    expect(message.startsWith("officecli: ")).toBe(true);
    expect(message).toContain(" | xlsx: ");
  });
});

describe("F4-3 op:doc:raw（L1006-1044）", () => {
  test("resolvePath null → 404；readFileSync 抛错 → 500", async () => {
    expect(await invoke("op:doc:raw", { params: { name: "不存在.md" } }))
      .toEqual({ ok: false, status: 404, data: { error: "not found" } });
    const result = await invoke("op:doc:raw", { params: { name: "方案.md" } }, makeDeps({
      readFileSync: vi.fn(() => { throw new Error("EACCES"); })
    }));
    expect(result).toEqual({ ok: false, status: 500, data: { error: "EACCES" } });
  });

  test("mimeMap 矩阵：docx/pdf/png/svg/未知扩展名兜底 octet-stream；base64 载数据 + 身份", async () => {
    const bytes = Buffer.from([0x01, 0x02, 0x03]);
    const cases: Array<[string, string]> = [
      ["方案.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      ["报告.pdf", "application/pdf"],
      ["图.png", "image/png"],
      ["矢量.svg", "image/svg+xml"],
      ["档案.xyz", "application/octet-stream"]
    ];
    for (const [name, mime] of cases) {
      const result = await invoke("op:doc:raw", { params: { name } }, makeDeps({ readFileSync: vi.fn(() => bytes) }));
      expect(result).toEqual({ ok: true, status: 200, data: { base64: "AQID", mime, identity: identityOf(name) } });
    }
  });
});

describe("F4-3 op:doc:text（L1047-1066）", () => {
  function makeDocxBuffer(xml: string): Promise<Buffer> {
    return (async () => {
      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();
      if (xml !== null) zip.file("word/document.xml", xml);
      else zip.file("word/other.xml", "占位");
      return zip.generateAsync({ type: "nodebuffer" }) as Promise<Buffer>;
    })();
  }

  test("非 .docx 或 resolvePath null → 404", async () => {
    expect((await invoke("op:doc:text", { params: { name: "方案.md" } })).status).toBe(404);
    expect((await invoke("op:doc:text", { params: { name: "不存在.md" } })).status).toBe(404);
  });

  test("真 JSZip 解 docx：段落 join（多 run 合并 / 空白段跳过）", async () => {
    const xml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>`
      + `<w:p><w:r><w:t>第一段</w:t></w:r></w:p>`
      + `<w:p><w:r><w:t>A</w:t></w:r><w:r><w:t>B</w:t></w:r></w:p>`
      + `<w:p><w:r><w:t>   </w:t></w:r></w:p>`
      + `</w:body></w:document>`;
    const buf = await makeDocxBuffer(xml);
    const result = await invoke("op:doc:text", { params: { name: "方案.docx" } }, makeDeps({
      readFileSync: vi.fn(() => buf)
    }));
    expect(result).toEqual({
      ok: true, status: 200,
      data: { name: "方案.docx", text: "第一段\nAB", identity: identityOf("方案.docx") }
    });
  });

  test("无 word/document.xml → 400 no document.xml；读文件抛错 → 500", async () => {
    const buf = await makeDocxBuffer(null as never);
    const noXml = await invoke("op:doc:text", { params: { name: "方案.docx" } }, makeDeps({
      readFileSync: vi.fn(() => buf)
    }));
    expect(noXml).toEqual({ ok: false, status: 400, data: { error: "no document.xml" } });

    const boom = await invoke("op:doc:text", { params: { name: "方案.docx" } }, makeDeps({
      readFileSync: vi.fn(() => { throw new Error("损坏"); })
    }));
    expect(boom.status).toBe(500);
    expect((boom.data as any).error).toBe("损坏");
  });
});

describe("F4-3 op:doc:html（L1136-1157）", () => {
  test("resolvePath null → 404", async () => {
    expect(await invoke("op:doc:html", { params: { name: "不存在.md" } }))
      .toEqual({ ok: false, status: 404, data: { error: "not found" } });
  });

  test("渲染成功 → </body> 前注入 __oawPreview ready 消息（携带身份）", async () => {
    const result = await invoke("op:doc:html", { params: { name: "方案.docx" } });
    expect(result.ok).toBe(true);
    const html = (result.data as any).html as string;
    expect(html.startsWith("<html><body><p>渲染内容</p><script>")).toBe(true);
    expect(html.endsWith("</script></body></html>")).toBe(true);
    expect(html).toContain('"__oawPreview":true');
    expect(html).toContain('"type":"ready"');
    expect(html).toContain(JSON.stringify(identityOf("方案.docx")).slice(1, -1));
    expect((result.data as any).identity).toEqual(identityOf("方案.docx"));
  });

  test("空渲染 → unsupported 占位页（.doc 专用 tips + 注入消息）", async () => {
    const result = await invoke("op:doc:html", { params: { name: "老文档.doc" } }, makeDeps({
      renderHtml: vi.fn(async () => "")
    }));
    expect(result.ok).toBe(true);
    const html = (result.data as any).html as string;
    expect(html).toContain("无法内嵌预览");
    expect(html).toContain(".doc");
    expect(html).toContain("老式 .doc 二进制格式不被预览引擎支持");
    expect(html).toContain('"type":"unsupported"');
  });

  test("renderHtml 抛错 → 500 + error 占位页（渲染引擎信息 + detail 原文）", async () => {
    const result = await invoke("op:doc:html", { params: { name: "演示.pptx" } }, makeDeps({
      renderHtml: vi.fn(async () => { throw new Error("渲染器爆炸"); })
    }));
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    const html = (result.data as any).html as string;
    expect(html).toContain("渲染器爆炸");
    expect(html).toContain("渲染引擎信息");
    expect(html).toContain('"type":"error"');
    expect((result.data as any).identity).toEqual(identityOf("演示.pptx"));
  });
});

describe("F4-3 op:doc:comments（L1161-1216）", () => {
  test("resolvePath null → 404", async () => {
    expect(await invoke("op:doc:comments", { params: { name: "不存在.md" } }))
      .toEqual({ ok: false, status: 404, data: { error: "not found" } });
  });

  test("md 会话提取：user 消息 / 数组 content / 非 user 跳过 / 坏行跳过 / 去重 / date 三级回退", async () => {
    const deps = makeDeps({
      listSessionFiles: vi.fn(() => [
        { fileName: "s1.jsonl", fullPath: "D:\\sessions\\s1.jsonl", storeDir: "D:\\sessions", mtime: 1700000000000, size: 1 },
        { fileName: "s2.jsonl", fullPath: "D:\\sessions\\s2.jsonl", storeDir: "D:\\sessions", mtime: 1700000000000, size: 1 }
      ]),
      readSessionTextCached: vi.fn((f: { fileName: string }) => f.fileName === "s1.jsonl" ? [
        JSON.stringify({ type: "message", message: { role: "user", content: "请修改 方案.md 的第一章" }, timestamp: "2026-01-01T00:00:00Z" }),
        JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "再改 方案.md" }] } }),
        JSON.stringify({ type: "message", message: { role: "assistant", content: "方案.md 已修改" } }),
        JSON.stringify({ type: "message", message: { role: "user", content: "请修改 方案.md 的第一章" } }),
        "not-json"
      ].join("\n") : "别的会话不相关")
    });
    const result = await invoke("op:doc:comments", { params: { name: "方案.md" } }, deps);
    expect(result).toEqual({
      ok: true, status: 200,
      data: {
        comments: [
          { path: "方案.md", author: "用户", text: "请修改 方案.md 的第一章", date: "2026-01-01T00:00:00Z" },
          { path: "方案.md", author: "用户", text: "再改 方案.md", date: new Date(1700000000000).toISOString() }
        ],
        identity: identityOf("方案.md")
      }
    });
  });

  test("md 提取 20 条上限（25 条唯一 → 前 20）", async () => {
    const lines = Array.from({ length: 25 }, (_, i) =>
      JSON.stringify({ type: "message", message: { role: "user", content: `第${i}条 方案.md` } }));
    const result = await invoke("op:doc:comments", { params: { name: "方案.md" } }, makeDeps({
      listSessionFiles: vi.fn(() => [{ fileName: "s.jsonl", fullPath: "s", storeDir: "d", mtime: 0, size: 1 }]),
      readSessionTextCached: vi.fn(() => lines.join("\n"))
    }));
    const comments = (result.data as any).comments as Array<{ text: string }>;
    expect(comments).toHaveLength(20);
    expect(comments[19]!.text).toBe("第19条 方案.md");
  });

  test("docx → queryComments 映射（format.author/date 优先；text→preview 回退）；抛错 → 空列表", async () => {
    const result = await invoke("op:doc:comments", { params: { name: "方案.docx" } }, makeDeps({
      queryComments: vi.fn(async () => ({ json: { data: { results: [
        { path: "p1", format: { author: "张三", date: "2026-01-02" }, text: "注意格式" },
        { path: "p2", author: "李四", date: "2026-01-03", preview: "仅预览" }
      ] } } }))
    }));
    expect(result).toEqual({
      ok: true, status: 200,
      data: {
        comments: [
          { path: "p1", author: "张三", text: "注意格式", date: "2026-01-02" },
          { path: "p2", author: "李四", text: "仅预览", date: "2026-01-03" }
        ],
        identity: identityOf("方案.docx")
      }
    });

    const fallback = await invoke("op:doc:comments", { params: { name: "方案.docx" } }, makeDeps({
      queryComments: vi.fn(async () => { throw new Error("officecli 爆炸"); })
    }));
    expect(fallback).toEqual({ ok: true, status: 200, data: { comments: [], identity: identityOf("方案.docx") } });
  });
});

describe("F4-3 op:doc:outline（L1355-1384）", () => {
  test("resolvePath null → 404", async () => {
    expect(await invoke("op:doc:outline", { params: { name: "不存在.md" } }))
      .toEqual({ ok: false, status: 404, data: { error: "not found" } });
  });

  test("标题启发式：Heading N → level min(6,N)；标题 N；非标题跳过；children 递归；120 截断", async () => {
    const longText = "长".repeat(130);
    const result = await invoke("op:doc:outline", { params: { name: "方案.docx" } }, makeDeps({
      runOfficecli: vi.fn(async () => ({ json: { data: { results: [
        { type: "p", style: "Heading 1", text: "第一章", path: "doc.xml!p1" },
        { type: "paragraph", format: { style: "标题 2" }, preview: "第二节", path: "doc.xml!p2" },
        { type: "p", style: "Normal", text: "正文段落", path: "doc.xml!p3" },
        { type: "p", style: "Heading 9", text: longText, path: "doc.xml!p4" },
        { type: "p", style: "Normal", text: "容器", path: "doc.xml!p5", children: [
          { type: "p", style: "Heading 3", text: "子标题", path: "doc.xml!p5a" }
        ] }
      ] } } }))
    }));
    expect(result).toEqual({
      ok: true, status: 200,
      data: {
        outline: [
          { level: 1, text: "第一章", path: "doc.xml!p1" },
          { level: 2, text: "第二节", path: "doc.xml!p2" },
          { level: 6, text: longText.slice(0, 120), path: "doc.xml!p4" },
          { level: 3, text: "子标题", path: "doc.xml!p5a" }
        ],
        identity: identityOf("方案.docx")
      }
    });
    const deps = makeDeps();
    await invoke("op:doc:outline", { params: { name: "方案.docx" } }, deps);
    expect(deps.runOfficecli).toHaveBeenCalledWith(["get", path.join("D:\\ws", "方案.docx"), "/", "--depth", "3", "--json"]);
  });

  test("runOfficecli 抛错 → {outline:[]}（ok:true 兜底，与 server 一致）", async () => {
    const result = await invoke("op:doc:outline", { params: { name: "方案.docx" } }, makeDeps({
      runOfficecli: vi.fn(async () => { throw new Error("不可用"); })
    }));
    expect(result).toEqual({ ok: true, status: 200, data: { outline: [], identity: identityOf("方案.docx") } });
  });
});

describe("F4-3 op:doc:annotations（L524-535）", () => {
  test("basename 防越界（\"..\" → 空列表且不读盘）；不存在 → 空列表", async () => {
    const deps = makeDeps({ existsSync: vi.fn(() => true) });
    const dotdot = await invoke("op:doc:annotations", { params: { name: ".." } }, deps);
    expect(dotdot).toEqual({ ok: true, status: 200, data: { annotations: [], identity: identityOf("..", "D:\\ws", "") } });
    expect(deps.readFileSync).not.toHaveBeenCalled();

    const missing = await invoke("op:doc:annotations", { params: { name: "页面.html" } }, makeDeps({ existsSync: vi.fn(() => false) }));
    expect(missing.data).toEqual({ annotations: [], identity: identityOf("页面.html", "D:\\ws", "") });
  });

  test("存在 → 读 .annotations/<basename>.json 解析；坏 JSON → 空列表", async () => {
    const deps = makeDeps({
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(() => Buffer.from(JSON.stringify([{ id: 1, label: "高亮" }]), "utf8"))
    });
    const result = await invoke("op:doc:annotations", { params: { name: "页面.html" } }, deps);
    expect(result).toEqual({
      ok: true, status: 200,
      data: { annotations: [{ id: 1, label: "高亮" }], identity: identityOf("页面.html", "D:\\ws", "") }
    });
    expect(deps.readFileSync).toHaveBeenCalledWith(path.join("D:\\ws", ".annotations", "页面.html.json"));

    const bad = await invoke("op:doc:annotations", { params: { name: "页面.html" } }, makeDeps({
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(() => Buffer.from("{坏", "utf8"))
    }));
    expect(bad.data).toEqual({ annotations: [], identity: identityOf("页面.html", "D:\\ws", "") });
  });
});
