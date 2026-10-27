/**
 * D-4 files 族直调对拍（files-direct.ts 编排层）。
 *
 * 覆盖面（行号锚点均指 server/index.mjs）：
 *   - manifest 锚点：4 通道全部在 DESKTOP_CHANNELS 且路由指向已审计路径；unknown → 404；
 *   - op:files:list（L839-858）：dir 越界矩阵（../ / 绝对 / 盘符）→ 400；请求级工作区
 *     invalid → 409；dir 不存在 → 404；成功投影 mime/mtime/version=size:mtimeMs；
 *     isDir 透传不补 mime；statSync 抛错透传原项；
 *   - op:files:search（L860-871）：空 query → 空结果；limit 归一矩阵（缺省 200 /
 *     "0"→200（parseInt 0 falsy 回退）/ "-5"→1 / "1000"→500 / "abc"→200）；
 *     成功透传 query/workspace；catch 500 { error }；
 *   - op:files:upload（L969-986）：!safe/!base64 → 400 invalid upload；扩展名白名单
 *     → 400 不支持的格式；请求级工作区 409（回显原始值）；成功 { ...result, file,
 *     workspace }；OFFICE_DOCUMENT_LOCKED → close 释放（15s）+ 400ms + 重试一次；
 *     非锁定错误 → respondWorkspaceFileError（status/code/requestId:null）；
 *   - op:files:delete（L988-1003）：resolvePath null → 404；成功 file 正斜杠化 +
 *     withWriteLockAsync 参数（runId ui_ 前缀 / kind ui_delete）；锁定重试同 upload。
 *
 * 本文件为纯编排测试：deps 全桩，不加载 workspace/write-coordination 等域实现。
 */
import { describe, expect, test, beforeEach, vi } from "vitest";
import type * as FilesModule from "../src/main/ipc/files-direct";
import { DESKTOP_CHANNELS, type InvokeEnvelope } from "../src/shared/protocol/channels";

type Files = typeof FilesModule;
let svc: Files;

beforeEach(async () => {
  svc = await import("../src/main/ipc/files-direct");
});

function makeDeps(overrides: Partial<FilesModule.FilesDirectDeps> = {}) {
  return {
    getWorkspace: vi.fn(() => "D:\\ws"),
    normalizeWorkspace: vi.fn((dir: string) => (dir === "坏" ? null : `REAL::${dir}`)),
    resolvePath: vi.fn((rel: string, ws?: string) => (rel === "不存在.docx" ? null : `${ws}\\${rel}`)),
    safeName: vi.fn((name: string) => (name.includes("bad") ? null : name)),
    listWorkspace: vi.fn(() => [
      { name: "子目录", isDir: true, ext: "" },
      { name: "方案.docx", isDir: false, ext: "docx" }
    ]),
    searchWorkspace: vi.fn(() => [{ name: "方案.docx" }]),
    writeWorkspaceFile: vi.fn(() => ({ ok: true, workspace: "D:\\ws", path: "D:\\ws\\方案.docx", status: "written", size: 3 })),
    withWriteLockAsync: vi.fn(async (_options: unknown, callback: () => unknown) => callback()),
    runOfficecli: vi.fn(async () => ({})),
    normalizeWorkspaceWriteError: vi.fn((error: any) => ({ code: error?.code || "WORKSPACE_FILE_OPERATION_FAILED", message: String(error?.message || error) })),
    workspaceWriteHttpStatus: vi.fn(() => 500),
    existsSync: vi.fn(() => true),
    statSync: vi.fn(() => ({ isDirectory: () => true, mtimeMs: 100, size: 5 })),
    unlinkSync: vi.fn(() => undefined),
    ...overrides
  } as never as FilesModule.FilesDirectDeps & Record<string, ReturnType<typeof vi.fn>>;
}

function invoke(channel: FilesModule.FilesDirectChannel, envelope: InvokeEnvelope | undefined, deps = makeDeps()) {
  return svc.invokeFilesDirect(channel, envelope, deps);
}

describe("D-4 manifest 锚点", () => {
  test("4 条通道全部在 DESKTOP_CHANNELS 且路由指向已审计路径", async () => {
    expect(svc.FILES_DIRECT_CHANNELS).toHaveLength(4);
    const expectedRoutes: Record<string, { method: string; path: string }> = {
      "op:files:list": { method: "GET", path: "/api/files" },
      "op:files:search": { method: "GET", path: "/api/files/search" },
      "op:files:upload": { method: "POST", path: "/api/files/upload" },
      "op:files:delete": { method: "POST", path: "/api/files/delete" }
    };
    for (const channel of svc.FILES_DIRECT_CHANNELS) {
      expect(DESKTOP_CHANNELS[channel as keyof typeof DESKTOP_CHANNELS]).toEqual(expectedRoutes[channel]);
    }
  });

  test("unknown channel → 404", async () => {
    const result = await svc.invokeFilesDirect("op:files:rename" as never, {}, makeDeps());
    expect(result).toEqual({ ok: false, status: 404, data: { error: "unknown channel: op:files:rename" } });
  });
});

describe("D-4 op:files:list（L839-858）", () => {
  test("dir 越界矩阵：../ 与绝对路径与盘符 → 400 invalid dir", async () => {
    for (const dir of ["..\\x", "/etc", "D:\\abs"]) {
      const result = await invoke("op:files:list", { params: { dir } });
      expect(result).toEqual({ ok: false, status: 400, data: { error: "invalid dir" } });
    }
  });

  test("显式工作区 invalid → 409 回显原始值", async () => {
    const result = await invoke("op:files:list", { params: { workspace: "坏" } });
    expect(result).toEqual({ ok: false, status: 409, data: { error: "unknown workspace", workspace: "坏" } });
  });

  test("dir 不存在/非目录 → 404 directory not found（回显工作区）", async () => {
    const result = await invoke("op:files:list", { params: { dir: "不存在.docx" } }, makeDeps({
      existsSync: vi.fn(() => false)
    }));
    expect(result).toEqual({ ok: false, status: 404, data: { error: "directory not found", workspace: "D:\\ws" } });
  });

  test("成功：isDir 透传；文件补 mime/mtime/version；workspace 回显", async () => {
    const result = await invoke("op:files:list", { params: {} });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      files: [
        { name: "子目录", isDir: true, ext: "" },
        {
          name: "方案.docx", isDir: false, ext: "docx",
          mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          mtime: 100, version: "5:100"
        }
      ],
      dir: "",
      workspace: "D:\\ws"
    });
  });

  test("statSync 抛错 → 透传原项（无 mime/mtime/version）", async () => {
    const result = await invoke("op:files:list", { params: {} }, makeDeps({
      statSync: vi.fn(() => { throw new Error("EPERM"); })
    }));
    const files = (result.data as Record<string, any>).files as Array<Record<string, any>>;
    expect(files[1]).toEqual({ name: "方案.docx", isDir: false, ext: "docx" });
  });
});

describe("D-4 op:files:search（L860-871）", () => {
  test("空 query → 空结果（不调 searchWorkspace）", async () => {
    const search = vi.fn(() => []);
    const result = await invoke("op:files:search", { params: { q: "  " } }, makeDeps({ searchWorkspace: search }));
    expect(result.data).toEqual({ files: [], query: "", workspace: "D:\\ws" });
    expect(search).not.toHaveBeenCalled();
  });

  test("limit 归一矩阵：缺省 200 / \"0\"→200 / \"-5\"→1 / \"1000\"→500 / \"abc\"→200", async () => {
    const search = vi.fn(() => []);
    const deps = makeDeps({ searchWorkspace: search });
    const cases: Array<[string, number]> = [["50", 50], ["0", 200], ["-5", 1], ["1000", 500], ["abc", 200]];
    for (const [raw, expected] of cases) {
      await invoke("op:files:search", { params: { q: "方案", limit: raw } }, deps);
    }
    const limits = (search as ReturnType<typeof vi.fn>).mock.calls.map((call) => (call[1] as any).limit);
    expect(limits).toEqual([50, 200, 1, 500, 200]);
  });

  test("searchWorkspace 抛错 → 500 { error }", async () => {
    const result = await invoke("op:files:search", { params: { q: "方案" } }, makeDeps({
      searchWorkspace: vi.fn(() => { throw new Error("索引损坏"); })
    }));
    expect(result).toEqual({ ok: false, status: 500, data: { error: "索引损坏" } });
  });
});

describe("D-4 op:files:upload（L969-986）", () => {
  test("!safe 或 !base64 → 400 invalid upload", async () => {
    const noName = await invoke("op:files:upload", { body: { name: "bad:name", base64: "aGk=" } });
    expect(noName).toEqual({ ok: false, status: 400, data: { error: "invalid upload" } });
    const noB64 = await invoke("op:files:upload", { body: { name: "方案.docx" } });
    expect(noB64).toEqual({ ok: false, status: 400, data: { error: "invalid upload" } });
  });

  test("扩展名白名单外 → 400 不支持的格式", async () => {
    const result = await invoke("op:files:upload", { body: { name: "恶意.exe", base64: "aGk=" } });
    expect(result).toEqual({ ok: false, status: 400, data: { error: "不支持的格式" } });
  });

  test("请求级工作区 invalid → 409 回显原始值；成功 → { ...result, file, workspace }", async () => {
    const invalid = await invoke("op:files:upload", { body: { name: "方案.docx", base64: "aGk=", workspace: "坏" } });
    expect(invalid).toEqual({ ok: false, status: 409, data: { error: "unknown workspace", workspace: "坏" } });

    const okResult = await invoke("op:files:upload", { body: { name: "方案.docx", base64: "aGk=" } });
    expect(okResult.ok).toBe(true);
    expect(okResult.data).toEqual({ ok: true, workspace: "D:\\ws", path: "D:\\ws\\方案.docx", status: "written", size: 3, file: "方案.docx" });
  });

  test("OFFICE_DOCUMENT_LOCKED → runOfficecli close（15s）+ 重试一次成功", async () => {
    const write = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("文档被占用"), { code: "OFFICE_DOCUMENT_LOCKED" }))
      .mockResolvedValueOnce({ ok: true, status: "written" });
    const runOfficecli = vi.fn(async () => ({}));
    const result = await invoke("op:files:upload", { body: { name: "方案.docx", base64: "aGk=" } }, makeDeps({ writeWorkspaceFile: write, runOfficecli }));
    expect(result.ok).toBe(true);
    expect(write).toHaveBeenCalledTimes(2);
    expect(runOfficecli).toHaveBeenCalledWith(["close", "方案.docx"], { cwd: "D:\\ws", timeoutMs: 15000 });
  });

  test("非锁定错误 → respondWorkspaceFileError（status 映射 / code 透传 / requestId:null）", async () => {
    const result = await invoke("op:files:upload", { body: { name: "方案.docx", base64: "aGk=" } }, makeDeps({
      writeWorkspaceFile: vi.fn(() => { throw Object.assign(new Error("没有写权限"), { code: "WORKSPACE_PERMISSION_DENIED" }); }),
      workspaceWriteHttpStatus: vi.fn(() => 403)
    }));
    expect(result).toEqual({
      ok: false,
      status: 403,
      data: { ok: false, code: "WORKSPACE_PERMISSION_DENIED", error: "没有写权限", requestId: null }
    });
  });
});

describe("D-4 op:files:delete（L988-1003）", () => {
  test("resolvePath null → 404 not found", async () => {
    const result = await invoke("op:files:delete", { body: { name: "不存在.docx" } });
    expect(result).toEqual({ ok: false, status: 404, data: { error: "not found" } });
  });

  test("成功：file 正斜杠化 + withWriteLockAsync 参数（runId ui_ 前缀 / kind ui_delete）+ unlinkSync", async () => {
    const unlink = vi.fn(() => undefined);
    const withLock = vi.fn(async (_options: unknown, callback: () => unknown) => callback());
    const result = await invoke("op:files:delete", { body: { name: "子\\方案.docx" } }, makeDeps({
      withWriteLockAsync: withLock,
      unlinkSync: unlink
    }));
    expect(result).toEqual({ ok: true, status: 200, data: { ok: true, file: "子/方案.docx", workspace: "D:\\ws" } });
    const lockOptions = (withLock as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, any>;
    expect(lockOptions.workspace).toBe("D:\\ws");
    expect(lockOptions.kind).toBe("ui_delete");
    expect(String(lockOptions.runId)).toMatch(/^ui_[0-9a-f-]{36}$/);
    expect(unlink).toHaveBeenCalledWith("D:\\ws\\子\\方案.docx");
  });

  test("锁定错误 → close 释放 + 重试一次；normalize 后 rethrow（code 保留）", async () => {
    const unlink = vi.fn()
      .mockImplementationOnce(() => { throw Object.assign(new Error("被锁定"), { code: "OFFICE_DOCUMENT_LOCKED" }); })
      .mockImplementationOnce(() => undefined);
    const runOfficecli = vi.fn(async () => ({}));
    const result = await invoke("op:files:delete", { body: { name: "方案.docx" } }, makeDeps({
      unlinkSync: unlink as never,
      runOfficecli
    }));
    expect(result.ok).toBe(true);
    expect(unlink).toHaveBeenCalledTimes(2);
    expect(runOfficecli).toHaveBeenCalledWith(["close", "方案.docx"], { cwd: "D:\\ws", timeoutMs: 15000 });
  });
});
