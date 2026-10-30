/**
 * D-3 workspace 族直调对拍（workspace-direct.ts 编排层）。
 *
 * 覆盖面（行号锚点均指 server/index.mjs）：
 *   - manifest 锚点：5 通道全部在 DESKTOP_CHANNELS 且路由指向已审计路径；unknown → 404；
 *   - op:workspaces:list（L3406-3448）：缓存 TTL 命中（第二次调用不再扫描）；会话扫描
 *     聚合（默认工作区置顶 / canonical realpath 归一 / hasOffice 过滤 / 隐藏过滤 /
 *     canonical 去重 / 首行 JSON 解析抛错 continue）；
 *   - op:workspace:switch（L3466-3482）：!path→400 / invalid→400 WORKSPACE_INVALID /
 *     写探针失败→403（writeAccess 整体透传）/ setWorkspace false→400
 *     WORKSPACE_SWITCH_FAILED / 成功 ok+files；
 *   - op:workspace:validate（L3520-3545）：!path→400 / invalid 200 ok:false /
 *     officecli passed·failed 两态 checks 形状（version||path 文案）/ ok=write.status；
 *   - op:workspace:pick（L3485-3506）：canceled 短路 / invalid / 写探针失败 / 成功 /
 *     PICKER_UNSUPPORTED→501 FOLDER_PICKER_UNAVAILABLE / PICKER_TIMEOUT→500
 *     FOLDER_PICKER_TIMEOUT / 其他→500 FOLDER_PICKER_FAILED / finally cancel 兜底；
 *   - op:workspace:pick:cancel（L3509-3512）：先快照 picker 再 cancelled（顺序忠实）。
 *
 * 本文件为纯编排测试：deps 全桩，不加载 workspace/native-files 等域实现。
 */
import { describe, expect, test, beforeEach, vi } from "vitest";
import type * as WorkspaceModule from "../src/main/ipc/workspace-direct";
import { DESKTOP_CHANNELS, type InvokeEnvelope } from "../src/shared/protocol/channels";

type Workspace = typeof WorkspaceModule;
let svc: Workspace;

beforeEach(async () => {
  svc = await import("../src/main/ipc/workspace-direct");
  svc.resetWorkspacesCacheForTest();
});

function makeDeps(overrides: Partial<WorkspaceModule.WorkspaceDirectDeps> = {}) {
  return {
    WORKSPACE_DIR: "D:\\ws\\默认",
    getWorkspace: vi.fn(() => "D:\\ws\\默认"),
    setWorkspace: vi.fn(() => true),
    listWorkspace: vi.fn(() => [{ name: "a.docx", path: "a.docx" }]),
    normalizeWorkspace: vi.fn((dir: string) => (dir === "坏路径" ? null : `REAL::${dir}`)),
    getHiddenWorkspaces: vi.fn(() => [] as string[]),
    evaluateWorkspaceWrite: vi.fn(() => ({ id: "workspace_write", label: "工作区写入", status: "passed", message: "写入正常", details: {} })),
    checkOfficecli: vi.fn(async () => ({ available: true, path: "officecli", version: "1.2.3", code: null })),
    pickFolder: vi.fn(async () => ({ canceled: false, path: "D:\\ws\\picked" })),
    cancelActivePicker: vi.fn(() => false),
    activePickerInfo: vi.fn(() => null),
    listSessionFiles: vi.fn(() => []),
    readSessionTextCached: vi.fn(() => "{}"),
    existsSync: vi.fn(() => true),
    readdirSync: vi.fn(() => [] as string[]),
    realpathSync: vi.fn((p: string) => p),
    ...overrides
  } as never as WorkspaceModule.WorkspaceDirectDeps & Record<string, ReturnType<typeof vi.fn>>;
}

function invoke(channel: WorkspaceModule.WorkspaceDirectChannel, envelope: InvokeEnvelope | undefined, deps = makeDeps()) {
  return svc.invokeWorkspaceDirect(channel, envelope, deps);
}

describe("D-3 manifest 锚点", () => {
  test("5 条通道全部在 DESKTOP_CHANNELS 且路由指向已审计路径", async () => {
    expect(svc.WORKSPACE_DIRECT_CHANNELS).toHaveLength(5);
    const expectedRoutes: Record<string, { method: string; path: string }> = {
      "op:workspaces:list": { method: "GET", path: "/api/workspaces" },
      "op:workspace:switch": { method: "POST", path: "/api/workspace/switch" },
      "op:workspace:validate": { method: "POST", path: "/api/workspace/validate" },
      "op:workspace:pick": { method: "POST", path: "/api/workspace/pick" },
      "op:workspace:pick:cancel": { method: "POST", path: "/api/workspace/pick/cancel" }
    };
    for (const channel of svc.WORKSPACE_DIRECT_CHANNELS) {
      expect(DESKTOP_CHANNELS[channel as keyof typeof DESKTOP_CHANNELS]).toEqual(expectedRoutes[channel]);
    }
  });

  test("unknown channel → 404", async () => {
    const result = await svc.invokeWorkspaceDirect("op:workspace:delete" as never, {}, makeDeps());
    expect(result).toEqual({ ok: false, status: 404, data: { error: "unknown channel: op:workspace:delete" } });
  });
});

describe("D-3 op:workspaces:list（L3406-3448）", () => {
  test("默认工作区置顶 + 会话扫描收录办公目录（hasOffice 过滤）", async () => {
    const deps = makeDeps({
      listSessionFiles: vi.fn(() => [{ fileName: "s1.json", fullPath: "D:\\hist\\s1.json", storeDir: "D:\\hist", mtime: 1, size: 10 }]),
      readSessionTextCached: vi.fn(() => '{"cwd":"D:\\\\ws\\\\office1"}'),
      readdirSync: vi.fn((p: string) => (p.includes("office1") ? ["方案.docx", "readme.txt"] : []))
    });
    const result = await invoke("op:workspaces:list", undefined, deps);
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      workspaces: [
        { name: "默认工作区", path: "D:\\ws\\默认" },
        { name: "office1", path: "D:\\ws\\office1" }
      ]
    });
  });

  test("无 office 文件的会话 cwd 不收录；首行 JSON 解析抛错 continue 不崩", async () => {
    const deps = makeDeps({
      listSessionFiles: vi.fn(() => [
        { fileName: "s1.json", fullPath: "D:\\hist\\s1.json", storeDir: "D:\\hist", mtime: 1, size: 10 },
        { fileName: "s2.json", fullPath: "D:\\hist\\s2.json", storeDir: "D:\\hist", mtime: 2, size: 10 }
      ]),
      readSessionTextCached: vi.fn((f: any) =>
        f.fileName === "s1.json" ? '{"cwd":"D:\\\\ws\\\\plain"}' : "not-json-first-line"
      ),
      readdirSync: vi.fn(() => ["readme.txt"])
    });
    const result = await invoke("op:workspaces:list", undefined, deps);
    expect(result.data).toEqual({ workspaces: [{ name: "默认工作区", path: "D:\\ws\\默认" }] });
  });

  test("隐藏工作区过滤（realpath 归一比对）+ canonical 去重", async () => {
    const deps = makeDeps({
      listSessionFiles: vi.fn(() => [
        { fileName: "s1.json", fullPath: "D:\\hist\\s1.json", storeDir: "D:\\hist", mtime: 1, size: 10 },
        { fileName: "s2.json", fullPath: "D:\\hist\\s2.json", storeDir: "D:\\hist", mtime: 2, size: 10 }
      ]),
      readSessionTextCached: vi.fn((f: any) =>
        f.fileName === "s1.json" ? '{"cwd":"D:\\\\ws\\\\office1"}' : '{"cwd":"D:\\\\ws\\\\office1"}'
      ),
      getHiddenWorkspaces: vi.fn(() => ["D:\\ws\\office1"])
    });
    const result = await invoke("op:workspaces:list", undefined, deps);
    expect(result.data).toEqual({ workspaces: [{ name: "默认工作区", path: "D:\\ws\\默认" }] });
  });

  test("缓存 TTL 命中：第二次调用不再扫描会话", async () => {
    const listSessionFiles = vi.fn(() => []);
    const deps = makeDeps({ listSessionFiles });
    await invoke("op:workspaces:list", undefined, deps);
    await invoke("op:workspaces:list", undefined, deps);
    expect(listSessionFiles).toHaveBeenCalledTimes(1);
  });
});

describe("D-3 op:workspace:switch（L3466-3482）", () => {
  test("!path → 400 { error: path required }", async () => {
    const result = await invoke("op:workspace:switch", { body: {} });
    expect(result).toEqual({ ok: false, status: 400, data: { error: "path required" } });
  });

  test("路径不存在 → 400 WORKSPACE_INVALID", async () => {
    const result = await invoke("op:workspace:switch", { body: { path: "坏路径" } });
    expect(result).toEqual({ ok: false, status: 400, data: { error: "路径不存在或不是可访问的文件夹", code: "WORKSPACE_INVALID" } });
  });

  test("写探针失败 → 403（writeAccess 整体透传，code 顶层透传）", async () => {
    // server 原文 `code: write.code || "WORKSPACE_WRITE_UNAVAILABLE"` 取 write 顶层 code
    //（EvaluationCheck 本身无顶层字段——生产 evaluateWorkspaceWrite 返回值无 code 时恒回退，
    // 回退语义已由 pick 写探针失败用例覆盖）；桩给顶层 code 验证透传分支。
    const write = { id: "workspace_write", label: "工作区写入", status: "failed", message: "只读目录", code: "EACCES", details: { code: "EACCES" } };
    const result = await invoke("op:workspace:switch", { body: { path: "D:\\ws\\x" } }, makeDeps({
      evaluateWorkspaceWrite: vi.fn(() => write)
    }));
    expect(result).toEqual({
      ok: false,
      status: 403,
      data: {
        error: "无法将此目录用作可写工作区：只读目录",
        code: "EACCES",
        workspace: "REAL::D:\\ws\\x",
        writeAccess: write
      }
    });
  });

  test("setWorkspace 失败 → 400 WORKSPACE_SWITCH_FAILED；成功 → ok+files", async () => {
    const fail = await invoke("op:workspace:switch", { body: { path: "D:\\ws\\x" } }, makeDeps({ setWorkspace: vi.fn(() => false) }));
    expect(fail).toEqual({ ok: false, status: 400, data: { error: "工作区切换失败", code: "WORKSPACE_SWITCH_FAILED" } });

    const okResult = await invoke("op:workspace:switch", { body: { path: "D:\\ws\\x" } });
    expect(okResult.ok).toBe(true);
    expect(okResult.data).toEqual({ ok: true, workspace: "D:\\ws\\默认", files: [{ name: "a.docx", path: "a.docx" }] });
  });

  test("切换成功触发 onSwitched（getWorkspace() 值）；失败与前置校验路径不触发", async () => {
    const onSwitched = vi.fn();
    await invoke("op:workspace:switch", { body: { path: "D:\\ws\\x" } }, makeDeps({ onSwitched }));
    expect(onSwitched).toHaveBeenCalledTimes(1);
    expect(onSwitched).toHaveBeenCalledWith("D:\\ws\\默认");

    const notFired = vi.fn();
    await invoke("op:workspace:switch", { body: { path: "D:\\ws\\x" } }, makeDeps({ setWorkspace: vi.fn(() => false), onSwitched: notFired }));
    await invoke("op:workspace:switch", { body: { path: "坏路径" } }, makeDeps({ onSwitched: notFired }));
    await invoke("op:workspace:switch", { body: {} }, makeDeps({ onSwitched: notFired }));
    expect(notFired).not.toHaveBeenCalled();
  });
});

describe("D-3 op:workspace:validate（L3520-3545）", () => {
  test("!path → 400；路径不存在 → 200 ok:false WORKSPACE_INVALID", async () => {
    const missing = await invoke("op:workspace:validate", { body: {} });
    expect(missing).toEqual({ ok: false, status: 400, data: { error: "path required" } });

    const invalid = await invoke("op:workspace:validate", { body: { path: "坏路径" } });
    expect(invalid.ok).toBe(true);
    expect(invalid.data).toEqual({
      ok: false,
      code: "WORKSPACE_INVALID",
      workspace: "坏路径",
      error: "路径不存在或不是可访问的文件夹"
    });
  });

  test("officecli 可用 → checks[1] passed（version||path 文案）+ ok=write.status", async () => {
    const result = await invoke("op:workspace:validate", { body: { path: "D:\\ws\\x" } });
    expect(result.ok).toBe(true);
    const data = result.data as Record<string, any>;
    expect(data.ok).toBe(true);
    expect(data.workspace).toBe("REAL::D:\\ws\\x");
    expect(data.writeAccess.status).toBe("passed");
    expect(data.officecli).toEqual({
      id: "officecli",
      label: "Office CLI",
      status: "passed",
      message: "Office CLI 可运行：1.2.3",
      details: { path: "officecli", version: "1.2.3", code: null }
    });
    expect(data.checks).toHaveLength(2);
    expect(data.note).toContain("探针以当前服务进程身份执行");
  });

  test("officecli 不可用 → failed（message 回退）+ version 缺省回退 path 文案", async () => {
    const result = await invoke("op:workspace:validate", { body: { path: "D:\\ws\\x" } }, makeDeps({
      checkOfficecli: vi.fn(async () => ({ available: false, path: "C:\\bin\\officecli.exe", message: "无法启动", code: "SPAWN_ERROR" }))
    }));
    const data = result.data as Record<string, any>;
    expect(data.ok).toBe(true); // ok 只看写探针
    expect(data.officecli.status).toBe("failed");
    expect(data.officecli.message).toBe("无法启动");
    expect(data.officecli.details).toEqual({ path: "C:\\bin\\officecli.exe", version: null, code: "SPAWN_ERROR" });
  });
});

describe("D-3 op:workspace:pick（L3485-3506）", () => {
  test("canceled → 200 { ok:false, canceled:true } 短路（不查写探针）", async () => {
    const evaluate = vi.fn(() => ({ status: "passed" }));
    const result = await invoke("op:workspace:pick", {}, makeDeps({
      pickFolder: vi.fn(async () => ({ canceled: true, path: "" })),
      evaluateWorkspaceWrite: evaluate as never
    }));
    expect(result).toEqual({ ok: true, status: 200, data: { ok: false, canceled: true } });
    expect(evaluate).not.toHaveBeenCalled();
  });

  test("选中路径无效 → 200 ok:false WORKSPACE_INVALID（workspace 透传原始值）", async () => {
    const result = await invoke("op:workspace:pick", {}, makeDeps({
      pickFolder: vi.fn(async () => ({ canceled: false, path: "坏路径" }))
    }));
    expect(result.data).toEqual({ ok: false, workspace: "坏路径", code: "WORKSPACE_INVALID", error: "路径不存在或不是可访问的文件夹" });
  });

  test("写探针失败 → 200 ok:false（code 回退 + writeAccess 透传）；成功 → ok:true", async () => {
    const write = { id: "workspace_write", label: "工作区写入", status: "failed", message: "只读", details: {} };
    const failed = await invoke("op:workspace:pick", {}, makeDeps({
      evaluateWorkspaceWrite: vi.fn(() => write)
    }));
    expect(failed.data).toEqual({ ok: false, workspace: "REAL::D:\\ws\\picked", code: "WORKSPACE_WRITE_UNAVAILABLE", error: "只读", writeAccess: write });

    const okResult = await invoke("op:workspace:pick", {});
    expect(okResult.data).toEqual({ ok: true, workspace: "REAL::D:\\ws\\picked", writeAccess: { id: "workspace_write", label: "工作区写入", status: "passed", message: "写入正常", details: {} } });
  });

  test("catch 三态映射：UNSUPPORTED→501 UNAVAILABLE / TIMEOUT→500 / 其他→500 FAILED", async () => {
    const unsupported = await invoke("op:workspace:pick", {}, makeDeps({
      pickFolder: vi.fn(async () => { const e = new Error("没有选择器"); (e as any).code = "PICKER_UNSUPPORTED"; throw e; })
    }));
    expect(unsupported).toEqual({ ok: false, status: 501, data: { error: "文件夹选择器不可用：没有选择器", code: "FOLDER_PICKER_UNAVAILABLE" } });

    const timeout = await invoke("op:workspace:pick", {}, makeDeps({
      pickFolder: vi.fn(async () => { const e = new Error("超时"); (e as any).code = "PICKER_TIMEOUT"; throw e; })
    }));
    expect(timeout).toEqual({ ok: false, status: 500, data: { error: "文件夹选择器不可用：超时", code: "FOLDER_PICKER_TIMEOUT" } });

    const other = await invoke("op:workspace:pick", {}, makeDeps({
      pickFolder: vi.fn(async () => { throw new Error("boom"); })
    }));
    expect(other).toEqual({ ok: false, status: 500, data: { error: "文件夹选择器不可用：boom", code: "FOLDER_PICKER_FAILED" } });
  });

  test("finally cancelActivePicker 兜底调用（成功路径也执行）", async () => {
    const cancel = vi.fn(() => false);
    await invoke("op:workspace:pick", {}, makeDeps({ cancelActivePicker: cancel }));
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe("D-3 op:workspace:pick:cancel（L3509-3512）", () => {
  test("先快照 picker 再 cancelled（顺序忠实）", async () => {
    const info = { kind: "folder", startedAt: 1, pid: 123 };
    const deps = makeDeps({
      activePickerInfo: vi.fn(() => info),
      cancelActivePicker: vi.fn(() => true)
    });
    const result = await invoke("op:workspace:pick:cancel", {}, deps);
    expect(result).toEqual({ ok: true, status: 200, data: { ok: true, cancelled: true, picker: info } });
    const infoOrder = (deps.activePickerInfo as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!;
    const cancelOrder = (deps.cancelActivePicker as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!;
    expect(infoOrder).toBeLessThan(cancelOrder);
  });
});
