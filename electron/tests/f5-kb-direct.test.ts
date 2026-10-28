/**
 * F5-4 知识库域直调对拍（kb-direct.ts 编排层）。
 *
 * 覆盖面（行号锚点均指 server/index.mjs）：
 *   - manifest 锚点：12 通道全部在 DESKTOP_CHANNELS 且路由指向 /api/kb/* 已审计路径；
 *     unknown → 404；op:kb:ingest 归 system-status-direct（D-1b）不在本清单（无重复收编）；
 *   - status/roots/tree/search/graph/doc（L359-405）：scan 先行语义（每请求先重扫、
 *     roots 变更后强制全量）、rootIdx parseInt 归一（非法回退 0/null 分族）、
 *     limit/max/include 缺省值、doc 404、roots:add !ok 400 整体透传 + fileCount 投影；
 *   - ima 4 件套（L408-411）：q/kb/media_id 缺省空串透传；
 *   - export-docx（L458-467）：rootIdx 归一、!ok 400、catch 500 { ok:false, error }；
 *   - 无 try/catch 路由的异常传播语义（L359-411）：域函数抛错 → dispatcher 原样
 *     传播（ipcMain.handle rejected），与 Express 4 挂起响应的形态差异声明见
 *     kb-direct.ts 头注释。
 *
 * 本文件为纯编排测试：deps 全桩，不加载 backend/kb 域实现。
 */
import { describe, expect, test, vi } from "vitest";
import { DESKTOP_CHANNELS } from "../src/shared/protocol/channels";
import * as svc from "../src/main/ipc/kb-direct";
import type { KbDirectDeps } from "../src/main/ipc/kb-direct";
import type { InvokeEnvelope, InvokeResult } from "../src/shared/protocol/channels";

function makeDeps(overrides: Partial<KbDirectDeps> = {}): KbDirectDeps {
  return {
    scan: vi.fn(async () => ({ size: 3 })),
    status: vi.fn(() => ({ fileCount: 42, roots: ["W:\\notes"] })),
    addRoot: vi.fn(() => ({ ok: true, roots: ["W:\\notes", "N:\\kb"] })),
    removeRoot: vi.fn(() => ({ ok: true, roots: ["W:\\notes"] })),
    getTreeLevel: vi.fn(() => ({ dirs: [{ name: "a" }], files: [{ name: "b.md" }] })),
    search: vi.fn(() => [{ path: "a.md", score: 1 }]),
    getGraph: vi.fn(() => ({ nodes: [], links: [] })),
    getDoc: vi.fn(() => ({ content: "# t", backlinks: [] })),
    imaStatus: vi.fn(async () => ({ configured: false })),
    imaListBases: vi.fn(async () => ({ bases: [] })),
    imaSearch: vi.fn(async () => ({ items: [] })),
    imaDoc: vi.fn(async () => ({ title: "x" })),
    exportDocx: vi.fn(async () => ({ ok: true, name: "导出.docx" })),
    ...overrides
  };
}

async function invoke(
  channel: string,
  payload: InvokeEnvelope | undefined,
  deps: KbDirectDeps
): Promise<InvokeResult<unknown>> {
  return svc.invokeKbDirect(channel, payload, deps);
}

describe("F5-4 manifest 锚点", () => {
  test("12 条通道全部在 DESKTOP_CHANNELS 且路由指向 /api/kb/* 审计路径", () => {
    expect(svc.KB_DIRECT_CHANNELS).toHaveLength(12);
    const expected: Record<string, { method: string; path: string }> = {
      "op:kb:status": { method: "GET", path: "/api/kb/status" },
      "op:kb:roots:add": { method: "POST", path: "/api/kb/roots" },
      "op:kb:roots:remove": { method: "DELETE", path: "/api/kb/roots" },
      "op:kb:tree": { method: "GET", path: "/api/kb/tree" },
      "op:kb:search": { method: "GET", path: "/api/kb/search" },
      "op:kb:graph": { method: "GET", path: "/api/kb/graph" },
      "op:kb:doc": { method: "GET", path: "/api/kb/doc" },
      "op:kb:ima:status": { method: "GET", path: "/api/kb/ima/status" },
      "op:kb:ima:bases": { method: "GET", path: "/api/kb/ima/bases" },
      "op:kb:ima:search": { method: "GET", path: "/api/kb/ima/search" },
      "op:kb:ima:doc": { method: "GET", path: "/api/kb/ima/doc" },
      "op:kb:export-docx": { method: "POST", path: "/api/kb/export-docx" }
    };
    for (const channel of svc.KB_DIRECT_CHANNELS) {
      expect(DESKTOP_CHANNELS[channel]).toEqual(expected[channel]);
    }
  });

  test("op:kb:ingest 归 system-status-direct（D-1b），不在 kb-direct 清单（无重复收编）", () => {
    expect(svc.KB_DIRECT_CHANNELS).not.toContain("op:kb:ingest");
  });

  test("unknown 通道 → 404", async () => {
    const result = await invoke("op:kb:nope", {}, makeDeps());
    expect(result).toEqual({ ok: false, status: 404, data: { error: "unknown channel: op:kb:nope" } });
  });
});

describe("F5-4 status/roots（L359-375）", () => {
  test("status：scan 先行 → status 投影", async () => {
    const deps = makeDeps();
    const result = await invoke("op:kb:status", {}, deps);
    expect(deps.scan).toHaveBeenCalledWith();
    expect(deps.status).toHaveBeenCalled();
    const scanFn = deps.scan as ReturnType<typeof vi.fn>;
    const statusFn = deps.status as ReturnType<typeof vi.fn>;
    expect(scanFn.mock.invocationCallOrder[0]!).toBeLessThan(statusFn.mock.invocationCallOrder[0]!);
    expect(result).toEqual({ ok: true, status: 200, data: { fileCount: 42, roots: ["W:\\notes"] } });
  });

  test("roots:add：!ok → 400 整体透传（不触发 scan）", async () => {
    const deps = makeDeps({ addRoot: vi.fn(() => ({ ok: false, error: "目录不存在" })) });
    const result = await invoke("op:kb:roots:add", { body: { path: "N:\\missing" } }, deps);
    expect(result).toEqual({ ok: false, status: 400, data: { ok: false, error: "目录不存在" } });
    expect(deps.scan).not.toHaveBeenCalled();
  });

  test("roots:add：ok → scan(true) 强制重扫 + fileCount 取自 status", async () => {
    const deps = makeDeps();
    const result = await invoke("op:kb:roots:add", { body: { path: "N:\\kb" } }, deps);
    expect(deps.addRoot).toHaveBeenCalledWith("N:\\kb");
    expect(deps.scan).toHaveBeenCalledWith(true);
    expect(result).toEqual({ ok: true, status: 200, data: { ok: true, roots: ["W:\\notes", "N:\\kb"], fileCount: 42 } });
  });

  test("roots:remove：body.path 透传（DELETE 带 body）→ scan(true) → r 整体透传", async () => {
    const deps = makeDeps();
    const result = await invoke("op:kb:roots:remove", { body: { path: "N:\\kb" } }, deps);
    expect(deps.removeRoot).toHaveBeenCalledWith("N:\\kb");
    expect(deps.scan).toHaveBeenCalledWith(true);
    expect(result).toEqual({ ok: true, status: 200, data: { ok: true, roots: ["W:\\notes"] } });
  });
});

describe("F5-4 tree/search/graph/doc（L377-405）", () => {
  test("tree：rootIdx 非法回退 0、合法透传；dir 缺省空串", async () => {
    const deps = makeDeps();
    await invoke("op:kb:tree", { query: {} }, deps);
    expect(deps.getTreeLevel).toHaveBeenCalledWith(0, "");
    await invoke("op:kb:tree", { query: { root: "2", dir: "sub" } }, deps);
    expect(deps.getTreeLevel).toHaveBeenCalledWith(2, "sub");
    await invoke("op:kb:tree", { query: { root: "abc" } }, deps);
    expect(deps.getTreeLevel).toHaveBeenLastCalledWith(0, "");
  });

  test("search：rootIdx 非法回退 null、limit parseInt 缺省 30、q 缺省空串", async () => {
    const deps = makeDeps();
    const result = await invoke("op:kb:search", { query: {} }, deps);
    expect(deps.search).toHaveBeenCalledWith("", null, 30);
    expect(result).toEqual({ ok: true, status: 200, data: { results: [{ path: "a.md", score: 1 }] } });
    await invoke("op:kb:search", { query: { q: "gis", root: "1", limit: "5" } }, deps);
    expect(deps.search).toHaveBeenLastCalledWith("gis", 1, 5);
    await invoke("op:kb:search", { query: { q: "gis", root: "x", limit: "zz" } }, deps);
    expect(deps.search).toHaveBeenLastCalledWith("gis", null, 30);
  });

  test("graph：include 缺省 links 逗号分裂去空、maxNodes 缺省 800、rootIdx 归一", async () => {
    const deps = makeDeps();
    await invoke("op:kb:graph", { query: {} }, deps);
    expect(deps.getGraph).toHaveBeenCalledWith({ rootIdx: null, include: ["links"], maxNodes: 800 });
    await invoke("op:kb:graph", { query: { root: "3", include: "links,tags,,backlinks", max: "99" } }, deps);
    expect(deps.getGraph).toHaveBeenLastCalledWith({ rootIdx: 3, include: ["links", "tags", "backlinks"], maxNodes: 99 });
  });

  test("doc：命中透传；未命中 404 { error: not found }", async () => {
    const deps = makeDeps();
    const hit = await invoke("op:kb:doc", { query: { path: "a.md", root: "0" } }, deps);
    expect(deps.getDoc).toHaveBeenCalledWith("a.md", 0);
    expect(hit).toEqual({ ok: true, status: 200, data: { content: "# t", backlinks: [] } });
    const miss = await invoke("op:kb:doc", { query: { path: "nope.md" } }, makeDeps({ getDoc: vi.fn(() => null) }));
    expect(miss).toEqual({ ok: false, status: 404, data: { error: "not found" } });
  });
});

describe("F5-4 ima 4 件套（L408-411）", () => {
  test("status/bases 无参直调；search q/kb 缺省空串；doc media_id 缺省空串", async () => {
    const deps = makeDeps();
    await invoke("op:kb:ima:status", {}, deps);
    expect(deps.imaStatus).toHaveBeenCalledTimes(1);
    await invoke("op:kb:ima:bases", {}, deps);
    expect(deps.imaListBases).toHaveBeenCalledTimes(1);
    await invoke("op:kb:ima:search", { query: {} }, deps);
    expect(deps.imaSearch).toHaveBeenCalledWith("", "");
    await invoke("op:kb:ima:search", { query: { q: "od", kb: "kb-1" } }, deps);
    expect(deps.imaSearch).toHaveBeenLastCalledWith("od", "kb-1");
    await invoke("op:kb:ima:doc", { query: {} }, deps);
    expect(deps.imaDoc).toHaveBeenCalledWith("");
    await invoke("op:kb:ima:doc", { query: { media_id: "m-9" } }, deps);
    expect(deps.imaDoc).toHaveBeenLastCalledWith("m-9");
  });
});

describe("F5-4 export-docx（L458-467）", () => {
  test("rootIdx parseInt 归一（非法回退 null）→ ok 200 / !ok 400 / catch 500 { ok:false, error }", async () => {
    const deps = makeDeps();
    const good = await invoke("op:kb:export-docx", { body: { relPath: "a.md", rootIdx: "1" } }, deps);
    expect(deps.exportDocx).toHaveBeenCalledWith("a.md", 1);
    expect(good).toEqual({ ok: true, status: 200, data: { ok: true, name: "导出.docx" } });
    await invoke("op:kb:export-docx", { body: { relPath: "a.md", rootIdx: "zz" } }, deps);
    expect(deps.exportDocx).toHaveBeenLastCalledWith("a.md", null);
    const bad = await invoke("op:kb:export-docx", { body: {} }, makeDeps({
      exportDocx: vi.fn(async () => ({ ok: false, error: "文档不存在" }))
    }));
    expect(bad).toEqual({ ok: false, status: 400, data: { ok: false, error: "文档不存在" } });
    const boom = await invoke("op:kb:export-docx", { body: {} }, makeDeps({
      exportDocx: vi.fn(async () => { throw new Error("docx 引擎崩溃"); })
    }));
    expect(boom).toEqual({ ok: false, status: 500, data: { ok: false, error: "docx 引擎崩溃" } });
  });
});

describe("F5-4 异常传播语义（L359-411 无 try/catch 路由）", () => {
  test("域函数抛错沿 dispatcher 传播（不吞不兜底）", async () => {
    const deps = makeDeps({ scan: vi.fn(async () => { throw new Error("索引目录不可读"); }) });
    await expect(invoke("op:kb:status", {}, deps)).rejects.toThrow("索引目录不可读");
    await expect(invoke("op:kb:tree", { query: {} }, deps)).rejects.toThrow("索引目录不可读");
  });
});
