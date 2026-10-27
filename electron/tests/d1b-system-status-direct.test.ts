/**
 * D-1b 状态与知识库摄取、模型刷新直调对拍（system-status-direct.ts 编排层）。
 *
 * 覆盖面（行号锚点均指 server/index.mjs）：
 *   - manifest 锚点：3 通道全部在 DESKTOP_CHANNELS 且路由指向已审计路径；unknown → 404；
 *   - status（L317-340）：全字段投影（officecli basename 双斜杠归一 / version /
 *     piPackageVersion 静态常量 / host:null 与 authRequired:false 语义差异声明 /
 *     native·picker·runtimeFlags 透传 / service 五字段：pid·startedAt·uptimeSec·
 *     identity·sandboxIdentity 正则判定）；
 *   - kb:ingest（L447-455）：ok?200:400 result 整体透传；抛错 500 {ok:false,error}；
 *   - models:refresh（L1767-1775）：{ok:true,...catalog,models,count}；
 *     抛错 500 {error}（无 ok:false——忠实转录断言）。
 *
 * 本文件为纯编排测试：deps 全桩，不加载 workspace/kb/assembly 等域实现。
 */
import { describe, expect, test, beforeAll, vi } from "vitest";
import type * as SystemStatusModule from "../src/main/ipc/system-status-direct";
import { DESKTOP_CHANNELS, type InvokeEnvelope } from "../src/shared/protocol/channels";
import { PI_PACKAGE_VERSION } from "../src/main/backend/agent/pi-runtime";

type SystemStatus = typeof SystemStatusModule;
let svc: SystemStatus;

beforeAll(async () => {
  svc = await import("../src/main/ipc/system-status-direct");
});

function makeDeps(overrides: Partial<SystemStatusModule.SystemStatusDirectDeps> = {}) {
  return {
    officecliPath: "D:\\tools\\office\\officecli.exe",
    serviceVersion: vi.fn(() => "0.11.55"),
    nativeCapabilities: vi.fn(() => ({ picker: true, pickerKind: "powershell", fileManagerName: "资源管理器" })),
    activePickerInfo: vi.fn(() => ({ active: false, kind: null })),
    runtimeFlagsSnapshot: vi.fn(() => ({ OP_OFFICE_PARAMS_V2: true })),
    ingestDocx: vi.fn(async (name: unknown) => ({ ok: true, name, docId: "doc-1" })),
    refreshModels: vi.fn(async () => [{ id: "deepseek" }, { id: "qwen" }]),
    listModelCatalog: vi.fn(async () => ({ providers: [{ id: "deepseek" }], models: [] })),
    identity: vi.fn(() => "tester"),
    startedAt: "2026-10-25T00:00:00.000Z",
    ...overrides
  } as never as SystemStatusModule.SystemStatusDirectDeps & Record<string, ReturnType<typeof vi.fn>>;
}

function invoke(channel: SystemStatusModule.SystemStatusDirectChannel, envelope: InvokeEnvelope | undefined, deps = makeDeps()) {
  return svc.invokeSystemStatusDirect(channel, envelope, deps);
}

describe("D-1b manifest 锚点", () => {
  test("3 条通道全部在 DESKTOP_CHANNELS 且路由指向已审计路径", () => {
    expect(svc.SYSTEM_STATUS_DIRECT_CHANNELS).toHaveLength(3);
    const expectedRoutes: Record<string, { method: string; path: string }> = {
      "op:status:get": { method: "GET", path: "/api/status" },
      "op:kb:ingest": { method: "POST", path: "/api/kb/ingest" },
      "op:models:refresh": { method: "POST", path: "/api/models/refresh" }
    };
    for (const channel of svc.SYSTEM_STATUS_DIRECT_CHANNELS) {
      expect(DESKTOP_CHANNELS[channel as keyof typeof DESKTOP_CHANNELS]).toEqual(expectedRoutes[channel]);
    }
  });

  test("unknown channel → 404", async () => {
    const result = await svc.invokeSystemStatusDirect("op:status:history" as never, {}, makeDeps());
    expect(result).toEqual({ ok: false, status: 404, data: { error: "unknown channel: op:status:history" } });
  });
});

describe("D-1b op:status:get（L317-340）", () => {
  test("全字段投影形状（officecli basename / host:null / authRequired:false / service 五字段）", async () => {
    const result = await invoke("op:status:get", {});
    expect(result.ok).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.officecli).toBe("officecli.exe");
    expect(data.version).toBe("0.11.55");
    expect(data.piPackageVersion).toBe(PI_PACKAGE_VERSION);
    expect(data.host).toBeNull();
    expect(data.authRequired).toBe(false);
    expect(data.platform).toBe(process.platform);
    expect(data.native).toEqual({ picker: true, pickerKind: "powershell", fileManagerName: "资源管理器" });
    expect(data.picker).toEqual({ active: false, kind: null });
    expect(data.runtimeFlags).toEqual({ OP_OFFICE_PARAMS_V2: true });
    const service = data.service as Record<string, unknown>;
    expect(service.pid).toBe(process.pid);
    expect(service.startedAt).toBe("2026-10-25T00:00:00.000Z");
    expect(service.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(service.identity).toBe("tester");
    expect(service.sandboxIdentity).toBe(false);
  });

  test("officecli 路径反斜杠与正斜杠均取 basename", async () => {
    const forward = await invoke("op:status:get", {}, makeDeps({ officecliPath: "/usr/local/bin/officecli" }));
    expect((forward.data as Record<string, unknown>).officecli).toBe("officecli");
  });

  test("sandboxIdentity：身份含 sandbox/CodexSandbox（忽略大小写）→ true", async () => {
    const sandboxed = await invoke("op:status:get", {}, makeDeps({ identity: vi.fn(() => "CodexSandboxOffline") }));
    const service = (sandboxed.data as Record<string, unknown>).service as Record<string, unknown>;
    expect(service.sandboxIdentity).toBe(true);
  });
});

describe("D-1b op:kb:ingest（L447-455）", () => {
  test("ok → 200 result 整体透传（body.name 传参）", async () => {
    const ingestFn = vi.fn(async () => ({ ok: true, name: "方案.docx", docId: "doc-1" }));
    const result = await invoke("op:kb:ingest", { body: { name: "方案.docx" } }, makeDeps({ ingestDocx: ingestFn }));
    expect(ingestFn).toHaveBeenCalledWith("方案.docx");
    expect(result).toEqual({ ok: true, status: 200, data: { ok: true, name: "方案.docx", docId: "doc-1" } });
  });

  test("!ok → 400 result 整体透传", async () => {
    const result = await invoke("op:kb:ingest", { body: { name: "坏.docx" } }, makeDeps({
      ingestDocx: vi.fn(async () => ({ ok: false, error: "不是有效的 docx 文件" }))
    }));
    expect(result).toEqual({ ok: false, status: 400, data: { ok: false, error: "不是有效的 docx 文件" } });
  });

  test("抛错 → 500 { ok:false, error }", async () => {
    const result = await invoke("op:kb:ingest", { body: { name: "x.docx" } }, makeDeps({
      ingestDocx: vi.fn(async () => { throw new Error("ingest boom"); })
    }));
    expect(result).toEqual({ ok: false, status: 500, data: { ok: false, error: "ingest boom" } });
  });
});

describe("D-1b op:models:refresh（L1767-1775）", () => {
  test("成功 → { ok:true, ...catalog, models, count }", async () => {
    const result = await invoke("op:models:refresh", {});
    expect(result).toEqual({
      ok: true,
      status: 200,
      data: { ok: true, providers: [{ id: "deepseek" }], models: [{ id: "deepseek" }, { id: "qwen" }], count: 2 }
    });
  });

  test("抛错 → 500 { error }（无 ok:false——忠实转录）", async () => {
    const result = await invoke("op:models:refresh", {}, makeDeps({
      refreshModels: vi.fn(async () => { throw new Error("models.json 解析失败"); })
    }));
    expect(result).toEqual({ ok: false, status: 500, data: { error: "models.json 解析失败" } });
    expect((result.data as Record<string, unknown>).ok).toBeUndefined();
  });
});
