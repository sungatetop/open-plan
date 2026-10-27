/**
 * D-1a 文件根目录与系统原生面直调对拍（native-system-direct.ts 编排层）。
 *
 * 覆盖面（行号锚点均指 server/index.mjs）：
 *   - manifest 锚点：6 通道全部在 DESKTOP_CHANNELS 且路由指向已审计路径；unknown → 404；
 *   - file-roots 3 条（L918-926）：list 透传 / add ok?200:400 / remove ok?200:404（整体透传）；
 *   - reveal（L5653-5665）：白名单放行 + fileManager 拼接 / 相对路径解析 /
 *     FILE_NOT_FOUND 404 / PATH_OUTSIDE_WORKSPACE 403；
 *   - open（L5667-5682）：目录退化 reveal（opened:"reveal"）/ 文件 default-app /
 *     statSync 抛错走 default-app；
 *   - pick-files（L5684-5712）：canceled 短路 / 工作区内相对路径反斜杠归一 /
 *     区外 name null / rememberNativePick TTL 白名单跨通道放行 / extensions 归一 /
 *     PICKER_FAILED 500 与 PICKER_UNSUPPORTED 501 / finally cancelActivePicker 兜底。
 *
 * 本文件为纯编排测试：不加载 workspace/native-files/project-management 域实现
 * （deps 全桩；fs 面注入 realpathSync/statSync）。
 */
import { describe, expect, test, beforeAll, beforeEach, vi } from "vitest";
import type * as NativeSystemModule from "../src/main/ipc/native-system-direct";
import { DESKTOP_CHANNELS, type InvokeEnvelope } from "../src/shared/protocol/channels";

type NativeSystem = typeof NativeSystemModule;
let svc: NativeSystem;

beforeAll(async () => {
  svc = await import("../src/main/ipc/native-system-direct");
});

/** deps 桩：workspace 三源白名单（D:\ws + D:\roots\r1 + D:\proj\p1）+ native 面注入。 */
function makeDeps(overrides: Partial<NativeSystemModule.NativeSystemDirectDeps> = {}) {
  const deps = {
    listFileRoots: vi.fn(() => [{ path: "D:\\roots\\r1" }]),
    addFileRoot: vi.fn((_dir: unknown, _label?: unknown) => ({ ok: true, roots: [{ path: "D:\\roots\\r1" }] })),
    removeFileRoot: vi.fn((_id: unknown) => ({ ok: true, roots: [] })),
    getWorkspace: vi.fn(() => "D:\\ws"),
    resolvePath: vi.fn((rel: string) => (rel === "a.txt" ? "D:\\ws\\a.txt" : null)),
    isInside: vi.fn((root: string, target: string) => target.startsWith(root)),
    listProjects: vi.fn((_filters: Record<string, unknown>) => [{ rootPath: "D:\\proj\\p1" }]),
    revealInFileManager: vi.fn(async (absPath: unknown) => ({ ok: true, path: String(absPath) })),
    openWithDefaultApp: vi.fn(async (absPath: unknown) => ({ ok: true, path: String(absPath) })),
    pickFiles: vi.fn(async (_options: { prompt: string; multiple: boolean; extensions: unknown[] }) => ({ canceled: false, paths: ["D:\\ws\\pick.txt"] })),
    nativeCapabilities: vi.fn(() => ({ fileManagerName: "资源管理器", picker: true, pickerKind: "powershell" })),
    cancelActivePicker: vi.fn(() => false),
    realpathSync: vi.fn((p: string) => p),
    statSync: vi.fn((p: string) => ({ isDirectory: () => false })),
    ...overrides
  };
  return deps as never as NativeSystemModule.NativeSystemDirectDeps & Record<string, ReturnType<typeof vi.fn>>;
}

function invoke(channel: NativeSystemModule.NativeSystemDirectChannel, envelope: InvokeEnvelope | undefined, deps = makeDeps()) {
  return svc.invokeNativeSystemDirect(channel, envelope, deps);
}

beforeEach(() => {
  svc.resetNativePickRecordForTest();
});

describe("D-1a manifest 锚点", () => {
  test("6 条通道全部在 DESKTOP_CHANNELS 且路由指向已审计路径", () => {
    expect(svc.NATIVE_SYSTEM_DIRECT_CHANNELS).toHaveLength(6);
    const expectedRoutes: Record<string, { method: string; path: string }> = {
      "op:file-roots:list": { method: "GET", path: "/api/file-roots" },
      "op:file-roots:add": { method: "POST", path: "/api/file-roots" },
      "op:file-roots:remove": { method: "DELETE", path: "/api/file-roots/:id" },
      "op:system:reveal": { method: "POST", path: "/api/system/reveal" },
      "op:system:open": { method: "POST", path: "/api/system/open" },
      "op:system:pick-files": { method: "POST", path: "/api/system/pick-files" }
    };
    for (const channel of svc.NATIVE_SYSTEM_DIRECT_CHANNELS) {
      expect(DESKTOP_CHANNELS[channel as keyof typeof DESKTOP_CHANNELS]).toEqual(expectedRoutes[channel]);
    }
  });

  test("unknown channel → 404", async () => {
    const result = await svc.invokeNativeSystemDirect("op:system:pick-folder" as never, {}, makeDeps());
    expect(result).toEqual({ ok: false, status: 404, data: { error: "unknown channel: op:system:pick-folder" } });
  });
});

describe("D-1a op:file-roots:*（L918-926）", () => {
  test("list → { roots } 透传", async () => {
    const roots = [{ path: "D:\\roots\\r1", label: "资料" }];
    const result = await invoke("op:file-roots:list", {}, makeDeps({ listFileRoots: vi.fn(() => roots) }));
    expect(result).toEqual({ ok: true, status: 200, data: { roots } });
  });

  test("add：ok → 200 result 整体透传；!ok → 400", async () => {
    const okResult = await invoke("op:file-roots:add", { body: { path: "D:\\new", label: "新根" } });
    expect(okResult.status).toBe(200);
    expect(okResult.data).toEqual({ ok: true, roots: [{ path: "D:\\roots\\r1" }] });
    const failResult = await invoke("op:file-roots:add", { body: { path: "D:\\new" } }, makeDeps({
      addFileRoot: vi.fn(() => ({ ok: false, error: "目录不存在" }))
    }));
    expect(failResult).toEqual({ ok: false, status: 400, data: { ok: false, error: "目录不存在" } });
  });

  test("remove：ok → 200；!ok → 404（params.id 传参）", async () => {
    const removeFn = vi.fn((id: unknown) => (id === "r1" ? { ok: true, roots: [] } : { ok: false, error: "根目录不存在" }));
    const okResult = await invoke("op:file-roots:remove", { params: { id: "r1" } }, makeDeps({ removeFileRoot: removeFn }));
    expect(okResult.status).toBe(200);
    const failResult = await invoke("op:file-roots:remove", { params: { id: "ghost" } }, makeDeps({ removeFileRoot: removeFn }));
    expect(failResult).toEqual({ ok: false, status: 404, data: { ok: false, error: "根目录不存在" } });
  });
});

describe("D-1a op:system:reveal（L5653-5665）", () => {
  test("白名单内绝对路径 → ok:true + result 展开 + fileManager", async () => {
    const result = await invoke("op:system:reveal", { body: { path: "D:\\ws\\报告.docx" } });
    expect(result).toEqual({ ok: true, status: 200, data: { ok: true, path: "D:\\ws\\报告.docx", fileManager: "资源管理器" } });
  });

  test("工作区相对路径 → resolvePath 解析后放行", async () => {
    const result = await invoke("op:system:reveal", { body: { name: "a.txt" } });
    expect(result).toEqual({ ok: true, status: 200, data: { ok: true, path: "D:\\ws\\a.txt", fileManager: "资源管理器" } });
  });

  test("路径不存在 → 404 { ok:false, code: FILE_NOT_FOUND }（真实 fs realpathSync 对不存在路径抛错 → null）", async () => {
    const result = await invoke("op:system:reveal", { body: { path: "D:\\ws\\不存在.txt" } }, makeDeps({
      realpathSync: vi.fn((p: string) => { if (p.includes("不存在")) throw new Error("ENOENT: no such file"); return p; })
    }));
    expect(result).toEqual({ ok: false, status: 404, data: { ok: false, error: "文件不存在或无法解析路径", code: "FILE_NOT_FOUND" } });
  });

  test("白名单外 → 403 { ok:false, code: PATH_OUTSIDE_WORKSPACE }", async () => {
    const result = await invoke("op:system:reveal", { body: { path: "D:\\outside\\x.txt" } });
    expect(result).toEqual({ ok: false, status: 403, data: { ok: false, error: "该路径不在任何工作区内，也不在本机选择器的最近选择中", code: "PATH_OUTSIDE_WORKSPACE" } });
  });

  test("白名单外但为本机选择器最近选择（TTL 内）→ 放行", async () => {
    await invoke("op:system:pick-files", {}, makeDeps({
      pickFiles: vi.fn(async () => ({ canceled: false, paths: ["D:\\outside\\picked.txt"] }))
    }));
    const result = await invoke("op:system:reveal", { body: { path: "D:\\outside\\picked.txt" } });
    expect(result.status).toBe(200);
  });
});

describe("D-1a op:system:open（L5667-5682）", () => {
  test("文件 → openWithDefaultApp + opened:default-app", async () => {
    const result = await invoke("op:system:open", { body: { path: "D:\\ws\\a.txt" } });
    expect(result).toEqual({ ok: true, status: 200, data: { ok: true, path: "D:\\ws\\a.txt", opened: "default-app" } });
  });

  test("目录 → 退化 reveal + opened:reveal + fileManager", async () => {
    const result = await invoke("op:system:open", { body: { path: "D:\\ws\\子目录" } }, makeDeps({
      statSync: vi.fn(() => ({ isDirectory: () => true }))
    }));
    expect(result).toEqual({ ok: true, status: 200, data: { ok: true, path: "D:\\ws\\子目录", opened: "reveal", fileManager: "资源管理器" } });
  });

  test("statSync 抛错（目标不存在）→ 走 default-app 分支", async () => {
    const result = await invoke("op:system:open", { body: { path: "D:\\ws\\a.txt" } }, makeDeps({
      statSync: vi.fn(() => { throw new Error("ENOENT"); })
    }));
    expect(result).toEqual({ ok: true, status: 200, data: { ok: true, path: "D:\\ws\\a.txt", opened: "default-app" } });
  });
});

describe("D-1a op:system:pick-files（L5684-5712）", () => {
  test("canceled → { ok:false, canceled:true, files:[] }（不查 workspace）", async () => {
    const realpathFn = vi.fn((p: string) => p);
    const result = await invoke("op:system:pick-files", {}, makeDeps({
      pickFiles: vi.fn(async () => ({ canceled: true, paths: [] })),
      realpathSync: realpathFn
    }));
    expect(result).toEqual({ ok: true, status: 200, data: { ok: false, canceled: true, files: [] } });
    expect(realpathFn).not.toHaveBeenCalled();
  });

  test("工作区内选择 → name 相对路径反斜杠归一 + insideWorkspace", async () => {
    const result = await invoke("op:system:pick-files", {}, makeDeps({
      pickFiles: vi.fn(async () => ({ canceled: false, paths: ["D:\\ws\\子\\文件.md"] }))
    }));
    expect(result).toEqual({
      ok: true,
      status: 200,
      data: { ok: true, canceled: false, files: [{ path: "D:\\ws\\子\\文件.md", name: "子/文件.md", insideWorkspace: true }], fileManager: "资源管理器" }
    });
  });

  test("工作区外选择 → name null（白名单路径不被记录为工作区内）", async () => {
    const result = await invoke("op:system:pick-files", {}, makeDeps({
      pickFiles: vi.fn(async () => ({ canceled: false, paths: ["D:\\roots\\r1\\外部.txt"] }))
    }));
    expect((result.data as any).files[0]).toEqual({ path: "D:\\roots\\r1\\外部.txt", name: null, insideWorkspace: false });
  });

  test("extensions 非数组 → 传 []；multiple 缺省 true；prompt 缺省文案", async () => {
    const pickFn = vi.fn(async (options: { prompt: string; multiple: boolean; extensions: unknown[] }) => ({ canceled: true, paths: [] }));
    await invoke("op:system:pick-files", { body: { extensions: "txt" } }, makeDeps({ pickFiles: pickFn }));
    expect(pickFn).toHaveBeenCalledWith({ prompt: "选择要打开的文件", multiple: true, extensions: [] });
    await invoke("op:system:pick-files", { body: { prompt: "选图", multiple: false, extensions: ["png", "jpg"] } }, makeDeps({ pickFiles: pickFn }));
    expect(pickFn).toHaveBeenLastCalledWith({ prompt: "选图", multiple: false, extensions: ["png", "jpg"] });
  });

  test("pickFiles 抛错 → 500 { ok:false, code: PICKER_FAILED }；PICKER_UNSUPPORTED → 501", async () => {
    const failResult = await invoke("op:system:pick-files", {}, makeDeps({
      pickFiles: vi.fn(async () => { throw Object.assign(new Error("选择器执行失败：boom"), { code: "PICKER_FAILED" }); })
    }));
    expect(failResult).toEqual({ ok: false, status: 500, data: { ok: false, error: "选择器执行失败：boom", code: "PICKER_FAILED" } });
    const unsupported = await invoke("op:system:pick-files", {}, makeDeps({
      pickFiles: vi.fn(async () => { throw Object.assign(new Error("当前平台没有可用的原生文件选择器"), { code: "PICKER_UNSUPPORTED" }); })
    }));
    expect(unsupported).toEqual({ ok: false, status: 501, data: { ok: false, error: "当前平台没有可用的原生文件选择器", code: "PICKER_UNSUPPORTED" } });
  });

  test("finally cancelActivePicker 兜底：成功路径也调用（no-op 语义等价保留）", async () => {
    const cancelFn = vi.fn(() => false);
    await invoke("op:system:pick-files", {}, makeDeps({ cancelActivePicker: cancelFn }));
    expect(cancelFn).toHaveBeenCalledTimes(1);
  });
});
