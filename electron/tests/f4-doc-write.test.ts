/**
 * F4-4 doc 族写路由直调对拍（doc-direct.ts 编排层，D 线模式：deps 全桩不加载域实现）。
 *
 * 覆盖面（行号锚点均指 server/index.mjs）：
 *   - manifest 锚点：7 条写通道全部在 DOC_DIRECT_CHANNELS；
 *   - op:doc:annotations-save（L537-549）：basename 防越界 → 400 invalid name；
 *     正常落盘 writeWorkspaceFile(kind:"ui_annotations") + JSON.stringify(list,null,2)；
 *     非数组 annotations → 空列表写入 count=0；落盘抛错 → workspaceFileError；
 *     显式 cwd → workspace 用显式工作区；
 *   - op:doc:watch（L1218-1230）：resolvePath null → 404；成功 → startDocWatch +
 *     {ok:true,identity}（IPC 无 url/port，语义差异见模块头）；startDocWatch 抛错 → 500；
 *   - op:doc:watch-stop（L1233-1239）：有路径 → stopDocWatch；无路径不调；恒 {ok:true}；
 *   - op:doc:cells（L1242-1262）：404；bad payload → 400；ref（COL_RE）→ batch set 命令
 *     （值 String 归一，非法 ref 过滤）；写锁 kind:"office_ui" + runId ui_ 前缀；
 *     成功 → {ok, result}；json.error 判定 → normalizeOfficeFailure + workspaceFileError；
 *     officeBatch 抛错 → workspaceFileError；
 *   - op:office:run（L1265-1298）：args 非数组 → 400；白名单外命令 → 400 + allowed；
 *     args[1] 绝对路径/含 .. → 400；DOM 路径 "/" 不算绝对路径；mutating（set/batch）
 *     文件越界 → 400 WRITE_SCOPE_ERROR；mutating 加写锁 + runOfficecli cwd=workspace；
 *     非 mutating 直接执行；非零退出码 → workspaceFileError；OFFICECLI_TIMEOUT → 504；
 *   - op:doc:edit（L1303-1331）：缺参 → 400；文件不存在 → 404；props 全值 String 归一
 *     （officecli 需要 "true"/"false"）；成功 → {ok:true, result}；失败 → workspaceFileError；
 *   - op:doc:raw-save（L1334-1352）：404；缺 base64 → 400；非 PK 头 → 400 不是有效的
 *     docx 文件；PK 头 → writeWorkspaceFile(kind:"ui_docx_save") + size + identity；
 *   - workspaceFileError（L928-936）：status=workspaceWriteHttpStatus(归一化错误)、
 *     data={ok:false,code,error}（IPC 无 requestId，语义差异见模块头）。
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

/** 写路由桩默认成功面：writeWorkspaceFile 返回 written，withWriteLockAsync 直通 callback。 */
function makeDeps(overrides: Partial<DocModule.DocDirectDeps> = {}) {
  return {
    getWorkspace: vi.fn(() => "D:\\ws"),
    normalizeWorkspace: vi.fn((dir: string) => (dir === "显式" || dir === "E:\\显式ws" ? "E:\\显式ws" : null)),
    resolvePath: vi.fn((rel: string, ws?: string) => (rel === "不存在.md" ? null : path.join(ws || "D:\\ws", rel))),
    setCurrentFile: vi.fn(async () => ({})),
    officeGet: vi.fn(async () => ({ json: { data: { results: [] } } })),
    renderHtml: vi.fn(async () => "<html><body></body></html>"),
    queryComments: vi.fn(async () => ({ json: { data: { results: [] } } })),
    runOfficecli: vi.fn(async () => ({ code: 0, stdout: "", stderr: "", json: { data: { results: [] } } })),
    listSessionFiles: vi.fn(() => []),
    readSessionTextCached: vi.fn(() => ""),
    existsSync: vi.fn(() => false),
    statSync: vi.fn(() => ({ mtimeMs: 100.9, size: 5 })),
    readFileSync: vi.fn(() => Buffer.from("")),
    // ---- F4-4 写路由桩 ----
    writeWorkspaceFile: vi.fn((options: { workspace: string; targetPath: string; content: string | Buffer; kind?: string }) => ({
      ok: true, workspace: options.workspace, path: options.targetPath, status: "written", size: 11
    })),
    withWriteLockAsync: vi.fn(async (_options: unknown, callback: () => unknown) => callback()),
    officeBatch: vi.fn(async () => ({ json: { data: { results: [{ ok: true }] } } })),
    normalizeOfficeFailure: vi.fn((error: unknown) => ({ code: "OFFICECLI_FAILED", message: String((error as Error)?.message || "Office CLI 执行失败") })),
    normalizeWorkspaceWriteError: vi.fn((error: unknown) => {
      const err = error as Error;
      return { code: (err as { code?: string })?.code || "WORKSPACE_FILE_OPERATION_FAILED", message: String(err?.message || "工作区文件操作失败") };
    }),
    workspaceWriteHttpStatus: vi.fn((error: unknown) => {
      const code = (error as { code?: string })?.code;
      if (code === "OFFICE_DOCUMENT_LOCKED" || code === "WRITE_CONFLICT") return 409;
      if (code === "WORKSPACE_PERMISSION_DENIED") return 403;
      if (code === "WORKSPACE_WRITE_UNAVAILABLE") return 503;
      return 500;
    }),
    startDocWatch: vi.fn(() => undefined),
    stopDocWatch: vi.fn(() => undefined),
    ...overrides
  } as never as DocModule.DocDirectDeps & Record<string, ReturnType<typeof vi.fn>>;
}

type WriteChannel = Extract<DocModule.DocDirectChannel,
  "op:doc:annotations-save" | "op:doc:raw-save" | "op:doc:cells" | "op:doc:edit" | "op:office:run" | "op:doc:watch" | "op:doc:watch-stop">;

function invoke(channel: WriteChannel, envelope: InvokeEnvelope | undefined, deps = makeDeps()) {
  return svc.invokeDocDirect(channel, envelope, deps);
}

describe("F4-4 manifest 锚点", () => {
  test("7 条写通道全部在 DESKTOP_CHANNELS 且路由与 server 一致", () => {
    const writeChannels: WriteChannel[] = [
      "op:doc:annotations-save", "op:doc:raw-save", "op:doc:cells",
      "op:doc:edit", "op:office:run", "op:doc:watch", "op:doc:watch-stop"
    ];
    for (const channel of writeChannels) {
      expect(DESKTOP_CHANNELS[channel]).toBeDefined();
      expect(svc.DOC_DIRECT_CHANNELS).toContain(channel);
    }
    expect(DESKTOP_CHANNELS["op:doc:annotations-save"]).toEqual({ method: "POST", path: "/api/doc/:name/annotations" });
    expect(DESKTOP_CHANNELS["op:office:run"]).toEqual({ method: "POST", path: "/api/office" });
    expect(DESKTOP_CHANNELS["op:doc:watch"]).toEqual({ method: "GET", path: "/api/doc/:name/watch" });
  });
});

describe("F4-4 op:doc:annotations-save（L537-549）", () => {
  test("basename 防越界：\"..\" → 400 invalid name 且不落盘", async () => {
    const deps = makeDeps();
    const result = await invoke("op:doc:annotations-save", { params: { name: ".." }, body: { annotations: [] } }, deps);
    expect(result).toEqual({ ok: false, status: 400, data: { error: "invalid name" } });
    expect(deps.writeWorkspaceFile).not.toHaveBeenCalled();
  });

  test("正常：writeWorkspaceFile(kind:ui_annotations) + stringify(list,2) → {...result,count,identity}", async () => {
    const annotations = [{ id: "a1", type: "comment", text: "高亮", note: "注意" }];
    const deps = makeDeps();
    const result = await invoke("op:doc:annotations-save", { params: { name: "页面.html" }, body: { annotations } }, deps);
    expect(result.ok).toBe(true);
    expect(deps.writeWorkspaceFile).toHaveBeenCalledWith({
      workspace: "D:\\ws",
      targetPath: path.join("D:\\ws", ".annotations", "页面.html.json"),
      content: JSON.stringify(annotations, null, 2),
      kind: "ui_annotations"
    });
    const data = result.data as Record<string, unknown>;
    expect(data.count).toBe(1);
    expect(data.status).toBe("written");
    expect(data.identity).toEqual(identityOf("页面.html", "D:\\ws", ""));
  });

  test("body.annotations 非数组 → 空列表写入 count=0（server 同语义）", async () => {
    const deps = makeDeps();
    const result = await invoke("op:doc:annotations-save", { params: { name: "页面.html" }, body: { annotations: "坏" } }, deps);
    expect(result.ok).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.count).toBe(0);
    expect((deps.writeWorkspaceFile as ReturnType<typeof vi.fn>).mock.calls[0]![0].content).toBe("[]");
  });

  test("落盘抛错 → workspaceFileError：status 按归一化 code 映射，data={ok:false,code,error}", async () => {
    const boom = Object.assign(new Error("目标文件正被其他程序占用"), { code: "OFFICE_DOCUMENT_LOCKED" });
    const result = await invoke("op:doc:annotations-save", { params: { name: "页面.html" }, body: { annotations: [] } }, makeDeps({
      writeWorkspaceFile: vi.fn(() => { throw boom; })
    }));
    expect(result.ok).toBe(false);
    expect(result.status).toBe(409);
    expect(result.data).toMatchObject({ ok: false, code: "OFFICE_DOCUMENT_LOCKED" });
    expect(String((result.data as Record<string, unknown>).error)).toContain("占用");
  });

  test("显式 cwd → workspace 用显式工作区（normalizeWorkspace 校验通过）", async () => {
    const deps = makeDeps();
    await invoke("op:doc:annotations-save", { params: { name: "页面.html" }, query: { cwd: "显式" }, body: { annotations: [] } }, deps);
    expect(deps.writeWorkspaceFile).toHaveBeenCalledWith(expect.objectContaining({ workspace: "E:\\显式ws" }));
  });
});

describe("F4-4 op:doc:watch / watch-stop（L1218-1230 / L1233-1239）", () => {
  test("watch：resolvePath null → 404", async () => {
    expect(await invoke("op:doc:watch", { params: { name: "不存在.md" } }))
      .toEqual({ ok: false, status: 404, data: { error: "not found" } });
  });

  test("watch 成功：startDocWatch(absPath, fileName) + {ok:true,identity}（IPC 无 url/port）", async () => {
    const deps = makeDeps();
    const result = await invoke("op:doc:watch", { params: { name: "方案.docx" } }, deps);
    expect(result).toEqual({ ok: true, status: 200, data: { ok: true, identity: identityOf("方案.docx") } });
    expect(deps.startDocWatch).toHaveBeenCalledWith(path.join("D:\\ws", "方案.docx"), "方案.docx");
    expect(JSON.stringify(result.data)).not.toContain("url");
    expect(JSON.stringify(result.data)).not.toContain("port");
  });

  test("watch：startDocWatch 抛错 → 500 {ok:false,error}", async () => {
    const result = await invoke("op:doc:watch", { params: { name: "方案.docx" } }, makeDeps({
      startDocWatch: vi.fn(() => { throw new Error("watch 注册失败"); })
    }));
    expect(result).toEqual({ ok: false, status: 500, data: { ok: false, error: "watch 注册失败" } });
  });

  test("watch-stop：有路径 → stopDocWatch + 恒 {ok:true}；无路径不调仍 ok", async () => {
    const deps = makeDeps();
    expect(await invoke("op:doc:watch-stop", { params: { name: "方案.docx" } }, deps))
      .toEqual({ ok: true, status: 200, data: { ok: true } });
    expect(deps.stopDocWatch).toHaveBeenCalledWith(path.join("D:\\ws", "方案.docx"));

    const missing = makeDeps();
    expect(await invoke("op:doc:watch-stop", { params: { name: "不存在.md" } }, missing))
      .toEqual({ ok: true, status: 200, data: { ok: true } });
    expect(missing.stopDocWatch).not.toHaveBeenCalled();
  });
});

describe("F4-4 op:doc:cells（L1242-1262）", () => {
  test("404（单参 resolvePath，无显式 cwd）；bad payload → 400", async () => {
    expect((await invoke("op:doc:cells", { params: { name: "不存在.md" }, body: { sheet: "S", cells: [{ ref: "A1", value: 1 }] } })).status).toBe(404);
    expect((await invoke("op:doc:cells", { params: { name: "表.xlsx" }, body: {} })).data).toEqual({ error: "bad payload" });
    expect((await invoke("op:doc:cells", { params: { name: "表.xlsx" }, body: { sheet: "S", cells: [] } })).data).toEqual({ error: "bad payload" });
  });

  test("ref → batch set 命令：值 String 归一、非法 ref 过滤、写锁 office_ui + runId ui_ 前缀", async () => {
    const deps = makeDeps();
    const result = await invoke("op:doc:cells", {
      params: { name: "表.xlsx" },
      body: { sheet: "Sheet1", cells: [{ ref: "A1", value: 42 }, { ref: "B2", value: true }, { ref: "非法", value: 1 }] }
    }, deps);
    expect(result).toEqual({ ok: true, status: 200, data: { ok: true, result: { data: { results: [{ ok: true }] } } } });
    expect(deps.officeBatch).toHaveBeenCalledWith(path.join("D:\\ws", "表.xlsx"), [
      { command: "set", path: "/Sheet1/A1", props: { value: "42" } },
      { command: "set", path: "/Sheet1/B2", props: { value: "true" } }
    ]);
    expect(deps.withWriteLockAsync).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: "D:\\ws", targetPath: path.join("D:\\ws", "表.xlsx"), kind: "office_ui" }),
      expect.any(Function)
    );
    const lockOptions = (deps.withWriteLockAsync as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { runId: string };
    expect(lockOptions.runId.startsWith("ui_")).toBe(true);
  });

  test("batch 结果 json.error 判定失败 → normalizeOfficeFailure + workspaceFileError", async () => {
    const result = await invoke("op:doc:cells", {
      params: { name: "表.xlsx" },
      body: { sheet: "Sheet1", cells: [{ ref: "A1", value: 1 }] }
    }, makeDeps({
      officeBatch: vi.fn(async () => ({ code: 1, stderr: "cell write boom", json: { error: "cell write boom" } }))
    }));
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect(result.data).toMatchObject({ ok: false, code: "OFFICECLI_FAILED", error: "cell write boom" });
  });

  test("任一 result.error 判定失败（json 无 error 但 results 内有 error）", async () => {
    // 真实 normalizeOfficeFailure 会从第三参 result 深挖 results 内 error 文本
    // （file-permission-error.ts collect(result?.json)）；桩模拟该行为验证 r 确实传入。
    const result = await invoke("op:doc:cells", {
      params: { name: "表.xlsx" },
      body: { sheet: "Sheet1", cells: [{ ref: "A1", value: 1 }] }
    }, makeDeps({
      officeBatch: vi.fn(async () => ({ json: { data: { results: [{ error: "cell locked" }] } } })),
      normalizeOfficeFailure: vi.fn((_error: unknown, _args: unknown[], r: unknown) => {
        const results = (r as { json?: { data?: { results?: Array<{ error?: string }> } } })?.json?.data?.results;
        const inner = Array.isArray(results) ? results.find((item) => item?.error)?.error : null;
        return { code: "OFFICECLI_FAILED", message: String(inner || (_error as Error)?.message || "Office CLI 执行失败") };
      })
    }));
    expect(result.ok).toBe(false);
    expect(String((result.data as Record<string, unknown>).error)).toBe("cell locked");
  });

  test("officeBatch 抛错 → workspaceFileError", async () => {
    const result = await invoke("op:doc:cells", {
      params: { name: "表.xlsx" },
      body: { sheet: "Sheet1", cells: [{ ref: "A1", value: 1 }] }
    }, makeDeps({
      officeBatch: vi.fn(async () => { throw Object.assign(new Error("EACCES: 拒绝访问"), { code: "WORKSPACE_PERMISSION_DENIED" }); })
    }));
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    expect(result.data).toMatchObject({ ok: false, code: "WORKSPACE_PERMISSION_DENIED" });
  });
});

describe("F4-4 op:office:run（L1265-1298）", () => {
  test("args 非数组 → 400；白名单外命令 → 400 + allowed", async () => {
    expect((await invoke("op:office:run", { body: {} })).data).toEqual({ error: "args required" });
    const denied = await invoke("op:office:run", { body: { args: ["convert", "a.xlsx"] } });
    expect(denied.status).toBe(400);
    expect(denied.data).toMatchObject({ error: "unsupported office command" });
    expect((denied.data as Record<string, unknown>).allowed).toContain("batch");
  });

  test("args[1] 绝对路径或含 .. → 400（只校验文件参数；DOM 路径 / 合法）", async () => {
    const abs = await invoke("op:office:run", { body: { args: ["view", "C:\\abs\\a.xlsx"] } });
    expect(abs.data).toEqual({ error: "office paths must stay inside the workspace" });
    const dotdot = await invoke("op:office:run", { body: { args: ["get", "..\\偷.xlsx"] } });
    expect(dotdot.status).toBe(400);
    // DOM 路径 /：path.isAbsolute("/") 在 win32 为 false，合法放行
    const ok = await invoke("op:office:run", { body: { args: ["get", "表.xlsx", "/", "--depth", "1", "--json"] } });
    expect(ok.ok).toBe(true);
  });

  test("mutating（set/batch）文件越界 → 400 WRITE_SCOPE_ERROR", async () => {
    const result = await invoke("op:office:run", { body: { args: ["set", "不存在.md"] } });
    expect(result).toEqual({
      ok: false, status: 400,
      data: { ok: false, code: "WRITE_SCOPE_ERROR", error: "Office 文件必须是当前工作区内的现有文件" }
    });
  });

  test("mutating 成功：withWriteLockAsync(office_ui) + runOfficecli(args, cwd=workspace)", async () => {
    const deps = makeDeps();
    const result = await invoke("op:office:run", { body: { args: ["batch", "表.xlsx"] } }, deps);
    expect(result.ok).toBe(true);
    expect(deps.resolvePath).toHaveBeenCalledWith("表.xlsx", "D:\\ws");
    expect(deps.withWriteLockAsync).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: "D:\\ws", targetPath: path.join("D:\\ws", "表.xlsx"), kind: "office_ui" }),
      expect.any(Function)
    );
    expect(deps.runOfficecli).toHaveBeenCalledWith(["batch", "表.xlsx"], { cwd: "D:\\ws" });
    expect(result.data).toMatchObject({ ok: true, code: 0 });
  });

  test("非 mutating（view/get/query/watch/close）不加锁直接执行", async () => {
    const deps = makeDeps();
    await invoke("op:office:run", { body: { args: ["view", "表.xlsx"] } }, deps);
    expect(deps.withWriteLockAsync).not.toHaveBeenCalled();
    expect(deps.resolvePath).not.toHaveBeenCalled();
    expect(deps.runOfficecli).toHaveBeenCalledWith(["view", "表.xlsx"], { cwd: "D:\\ws" });
  });

  test("非零退出码 → normalizeOfficeFailure + workspaceFileError", async () => {
    const result = await invoke("op:office:run", { body: { args: ["set", "表.xlsx"] } }, makeDeps({
      runOfficecli: vi.fn(async () => ({ code: 2, stdout: "", stderr: "officecli 爆炸", json: null }))
    }));
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect(result.data).toMatchObject({ ok: false, code: "OFFICECLI_FAILED", error: "officecli 爆炸" });
  });

  test("OFFICECLI_TIMEOUT → 504（code 字符串化）", async () => {
    const result = await invoke("op:office:run", { body: { args: ["get", "表.xlsx", "/"] } }, makeDeps({
      runOfficecli: vi.fn(async () => { throw Object.assign(new Error("Office CLI 超时"), { code: "OFFICECLI_TIMEOUT" }); })
    }));
    expect(result.ok).toBe(false);
    expect(result.status).toBe(504);
    expect(result.data).toEqual({ ok: false, code: "OFFICECLI_TIMEOUT", error: "Office CLI 超时" });
  });
});

describe("F4-4 op:doc:edit（L1303-1331）", () => {
  test("缺 file/commands → 400；文件不存在 → 404", async () => {
    expect((await invoke("op:doc:edit", { body: {} })).data).toEqual({ error: "file and commands required" });
    expect((await invoke("op:doc:edit", { body: { file: "方案.docx", commands: [] } })).data).toEqual({ error: "file and commands required" });
    expect((await invoke("op:doc:edit", { body: { file: "不存在.md", commands: [{ command: "set" }] } })).data).toEqual({ error: "file not found" });
  });

  test("props 全值 String 归一（true→\"true\"、42→\"42\"）→ 写锁 office_batch → {ok:true,result}", async () => {
    const deps = makeDeps();
    const result = await invoke("op:doc:edit", {
      body: {
        file: "方案.docx",
        commands: [
          { command: "set", path: "/body/p[1]", props: { bold: true, size: 42, text: "标题" } },
          { command: "get", path: "/" }
        ]
      }
    }, deps);
    expect(result).toEqual({ ok: true, status: 200, data: { ok: true, result: { data: { results: [{ ok: true }] } } } });
    expect(deps.officeBatch).toHaveBeenCalledWith(path.join("D:\\ws", "方案.docx"), [
      { command: "set", path: "/body/p[1]", props: { bold: "true", size: "42", text: "标题" } },
      { command: "get", path: "/" }
    ]);
    expect(deps.withWriteLockAsync).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: "D:\\ws", targetPath: path.join("D:\\ws", "方案.docx"), kind: "office_ui" }),
      expect.any(Function)
    );
  });

  test("batch 失败判定 → workspaceFileError；officeBatch 抛错 → workspaceFileError", async () => {
    const failed = await invoke("op:doc:edit", {
      body: { file: "方案.docx", commands: [{ command: "set", path: "/p", props: { text: "x" } }] }
    }, makeDeps({
      officeBatch: vi.fn(async () => ({ code: 1, text: "编辑失败 boom", json: null }))
    }));
    expect(failed.ok).toBe(false);
    expect(failed.data).toMatchObject({ ok: false, code: "OFFICECLI_FAILED", error: "编辑失败 boom" });

    const thrown = await invoke("op:doc:edit", {
      body: { file: "方案.docx", commands: [{ command: "set", path: "/p", props: { text: "x" } }] }
    }, makeDeps({
      officeBatch: vi.fn(async () => { throw Object.assign(new Error("占用"), { code: "OFFICE_DOCUMENT_LOCKED" }); })
    }));
    expect(thrown.ok).toBe(false);
    expect(thrown.status).toBe(409);
  });
});

describe("F4-4 op:doc:raw-save（L1334-1352）", () => {
  test("404；缺 base64 → 400；非 PK 头 → 400 不是有效的 docx 文件", async () => {
    expect((await invoke("op:doc:raw-save", { params: { name: "不存在.md" }, body: { base64: "UEsDBA==" } })).status).toBe(404);
    expect((await invoke("op:doc:raw-save", { params: { name: "方案.docx" }, body: {} })).data).toEqual({ error: "base64 required" });
    const bad = await invoke("op:doc:raw-save", { params: { name: "方案.docx" }, body: { base64: Buffer.from("nope").toString("base64") } });
    expect(bad).toEqual({ ok: false, status: 400, data: { error: "不是有效的 docx 文件" } });
  });

  test("PK 头 → writeWorkspaceFile(kind:ui_docx_save, content=buf) + size + identity", async () => {
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
    const deps = makeDeps();
    const result = await invoke("op:doc:raw-save", {
      params: { name: "方案.docx" },
      body: { base64: bytes.toString("base64") }
    }, deps);
    expect(result.ok).toBe(true);
    expect(deps.writeWorkspaceFile).toHaveBeenCalledWith({
      workspace: "D:\\ws",
      targetPath: path.join("D:\\ws", "方案.docx"),
      content: bytes,
      kind: "ui_docx_save"
    });
    const data = result.data as Record<string, unknown>;
    expect(data.size).toBe(bytes.length);
    expect(data.status).toBe("written");
    expect(data.identity).toEqual(identityOf("方案.docx"));
  });

  test("落盘抛错 → workspaceFileError；显式 cwd 传入 workspace", async () => {
    const failed = await invoke("op:doc:raw-save", {
      params: { name: "方案.docx" },
      body: { base64: Buffer.from([0x50, 0x4b, 0x03, 0x04]).toString("base64") }
    }, makeDeps({
      writeWorkspaceFile: vi.fn(() => { throw Object.assign(new Error("503 不可用"), { code: "WORKSPACE_WRITE_UNAVAILABLE" }); })
    }));
    expect(failed.ok).toBe(false);
    expect(failed.status).toBe(503);

    const deps = makeDeps();
    await invoke("op:doc:raw-save", { params: { name: "方案.docx" }, query: { cwd: "显式" }, body: { base64: Buffer.from([0x50, 0x4b, 0x03, 0x04]).toString("base64") } }, deps);
    expect(deps.writeWorkspaceFile).toHaveBeenCalledWith(expect.objectContaining({ workspace: "E:\\显式ws" }));
  });
});
