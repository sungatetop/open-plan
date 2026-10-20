// @vitest-environment jsdom
/**
 * client API 层对拍（F3 批5b-2）：files/models/agent 配置/搜索设置/地图设置/
 * 项目/工作区/文件根/系统集成 9 域 47 端点，client/src/api.js（浏览器 fetch）与
 * electron/src/renderer/api/client-api.ts（IPC 通道）的语义等价。
 *
 * 对拍口径同 f3-client-api-parity（批1）：
 *   - 旧侧 stub global fetch 捕获 method/url/body；新侧 stub window.opDesktop.invoke 捕获 channel/payload；
 *   - HTTP 形态/查询串（空值剔除规则）/body 深等/失败 throw 形状逐字段相等；
 *   - listModels 的 10s 单飞缓存与 refreshModels 失效语义：两侧调用序列一致。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { DESKTOP_CHANNELS, type DesktopChannelId } from "../src/shared/protocol/channels";

const clientApi = await import("../../client/src/api.js");
const desktopApi = await import("../src/renderer/api/client-api");

interface HttpCall { method: string; url: string; body?: string }
interface IpcCall { channel: string; payload?: Record<string, unknown> }

const SAMPLE_DATA = { sample: "ok", items: [1, 2] };

function setupParity(): { httpCalls: HttpCall[]; ipcCalls: IpcCall[] } {
  const httpCalls: HttpCall[] = [];
  const ipcCalls: IpcCall[] = [];
  vi.stubGlobal("fetch", async (path: string | URL, opts?: RequestInit) => {
    httpCalls.push({
      method: opts?.method ?? "GET",
      url: String(path),
      body: typeof opts?.body === "string" ? opts.body : undefined
    });
    return { ok: true, status: 200, json: async () => SAMPLE_DATA };
  });
  (window as unknown as { opDesktop: unknown }).opDesktop = {
    invoke: async (channel: string, payload?: Record<string, unknown>) => {
      ipcCalls.push({ channel, payload });
      return { ok: true, status: 200, data: SAMPLE_DATA };
    }
  };
  return { httpCalls, ipcCalls };
}

function setupFailing(): void {
  const failData = { error: "失败", code: "E_X", detail: { k: 1 } };
  vi.stubGlobal("fetch", async () => ({ ok: false, status: 500, json: async () => failData }));
  (window as unknown as { opDesktop: unknown }).opDesktop = {
    invoke: async () => ({ ok: false, status: 500, data: failData })
  };
}

/** 模板路径代入 params（路径参数按转发器语义 encodeURIComponent，与旧侧 api.js 模板内编码一致） */
function expandPath(template: string, params?: Record<string, string>): string {
  let path = template;
  for (const [key, value] of Object.entries(params ?? {})) path = path.replace(`:${key}`, encodeURIComponent(value));
  return path;
}

function assertParity(httpCalls: HttpCall[], ipcCalls: IpcCall[], callIndex: number, channel: DesktopChannelId): void {
  const http = httpCalls[callIndex];
  const ipc = ipcCalls[callIndex];
  const route = DESKTOP_CHANNELS[channel];
  if (!http || !ipc) throw new Error(`第 ${callIndex} 次调用缺失：http=${httpCalls.length} ipc=${ipcCalls.length}`);
  expect(ipc.channel).toBe(channel);
  expect(http.method).toBe(route.method);
  const url = new URL(http.url, "http://legacy");
  expect(url.pathname).toBe(expandPath(route.path, ipc.payload?.params as Record<string, string> | undefined));

  const newQuery = (ipc.payload?.query ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(newQuery)) {
    expect(value, `新侧 ${channel} query.${key} 不应为空值`).not.toStrictEqual("");
    expect(value).not.toBe(undefined);
    expect(value).not.toBe(null);
    expect(url.searchParams.get(key), `query.${key} 不等`).toBe(String(value));
  }
  expect([...url.searchParams.keys()].sort()).toEqual(Object.keys(newQuery).sort());

  if (ipc.payload?.body === undefined) {
    expect(http.body).toBeUndefined();
  } else {
    expect(JSON.parse(http.body ?? "null")).toEqual(ipc.payload.body);
  }
}

/** 双侧同流调用一组函数并逐次断言形态等价 */
async function parity(
  calls: Array<{ old: () => Promise<unknown>; neo: () => Promise<unknown>; channel: DesktopChannelId }>
): Promise<void> {
  const { httpCalls, ipcCalls } = setupParity();
  for (const [index, call] of calls.entries()) {
    const [oldData, newData] = await Promise.all([call.old(), call.neo()]);
    expect(newData).toEqual(oldData);
    assertParity(httpCalls, ipcCalls, index, call.channel);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as { opDesktop?: unknown }).opDesktop;
});

describe("文件族与 client/api.js 等价（对拍）", () => {
  it("searchFiles/uploadFile/deleteFile：workspace 可选参数两分支", async () => {
    await parity([
      { old: () => clientApi.searchFiles("规划"), neo: () => desktopApi.searchFiles("规划"), channel: "op:files:search" },
      { old: () => clientApi.searchFiles("路", 50, "F:\\w"), neo: () => desktopApi.searchFiles("路", 50, "F:\\w"), channel: "op:files:search" },
      { old: () => clientApi.uploadFile("a.docx", "AAAA"), neo: () => desktopApi.uploadFile("a.docx", "AAAA"), channel: "op:files:upload" },
      { old: () => clientApi.uploadFile("a.docx", "AAAA", "F:\\w"), neo: () => desktopApi.uploadFile("a.docx", "AAAA", "F:\\w"), channel: "op:files:upload" },
      { old: () => clientApi.deleteFile("a.docx"), neo: () => desktopApi.deleteFile("a.docx"), channel: "op:files:delete" },
      { old: () => clientApi.deleteFile("a.docx", "F:\\w"), neo: () => desktopApi.deleteFile("a.docx", "F:\\w"), channel: "op:files:delete" }
    ]);
  });
});

describe("模型族与 client/api.js 等价（对拍）", () => {
  it("listModels：10s 缓存命中 + refreshModels 失效", async () => {
    const { httpCalls, ipcCalls } = setupParity();
    const [a, b] = await Promise.all([clientApi.listModels(), desktopApi.listModels()]);
    expect(b).toEqual(a);
    assertParity(httpCalls, ipcCalls, 0, "op:models:list");

    // 立即再调：双侧都命中缓存，无新调用
    const [a2, b2] = await Promise.all([clientApi.listModels(), desktopApi.listModels()]);
    expect(b2).toEqual(a2);
    expect(httpCalls.length).toBe(1);
    expect(ipcCalls.length).toBe(1);

    // refreshModels：POST 无 body；之后缓存失效
    await Promise.all([clientApi.refreshModels(), desktopApi.refreshModels()]);
    assertParity(httpCalls, ipcCalls, 1, "op:models:refresh");
    expect(httpCalls[1]?.body).toBeUndefined();

    await Promise.all([clientApi.listModels(), desktopApi.listModels()]);
    assertParity(httpCalls, ipcCalls, 2, "op:models:list");
  });

  it("listModels：并发单飞（inflight 共享，只发一次）", async () => {
    const { httpCalls, ipcCalls } = setupParity();
    // maxAgeMs:0 绕过模块级缓存（跨用例共享，前一用例可能已缓存），单飞语义与默认参数一致
    await Promise.all([
      clientApi.listModels({ maxAgeMs: 0 }),
      clientApi.listModels({ maxAgeMs: 0 }),
      desktopApi.listModels({ maxAgeMs: 0 }),
      desktopApi.listModels({ maxAgeMs: 0 })
    ]);
    expect(httpCalls.length).toBe(1);
    expect(ipcCalls.length).toBe(1);
  });
});

describe("Agent 配置族与 client/api.js 等价（对拍）", () => {
  it("鉴权与导入：auth get/save/remove、custom-provider、config-status、import-preview/import-config", async () => {
    await parity([
      { old: () => clientApi.agentAuth(), neo: () => desktopApi.agentAuth(), channel: "op:agent:auth:get" },
      { old: () => clientApi.agentAuthSave("anthropic", "sk-1"), neo: () => desktopApi.agentAuthSave("anthropic", "sk-1"), channel: "op:agent:auth:save" },
      { old: () => clientApi.agentAuthRemove("openai"), neo: () => desktopApi.agentAuthRemove("openai"), channel: "op:agent:auth:remove" },
      { old: () => clientApi.agentCustomProvider({ provider: "gw", models: [] }), neo: () => desktopApi.agentCustomProvider({ provider: "gw", models: [] }), channel: "op:agent:custom-provider" },
      { old: () => clientApi.agentCustomProvider(), neo: () => desktopApi.agentCustomProvider(), channel: "op:agent:custom-provider" },
      { old: () => clientApi.agentConfigStatus(), neo: () => desktopApi.agentConfigStatus(), channel: "op:agent:config-status" },
      { old: () => clientApi.agentImportPreview(), neo: () => desktopApi.agentImportPreview(), channel: "op:agent:import-preview" },
      { old: () => clientApi.agentImportConfig({ dryRun: true }), neo: () => desktopApi.agentImportConfig({ dryRun: true }), channel: "op:agent:import-config" },
      { old: () => clientApi.agentImportConfig(), neo: () => desktopApi.agentImportConfig(), channel: "op:agent:import-config" }
    ]);
  });

  it("接入计划：plans / planModels（planId 编码）/ planApply / planDisconnect", async () => {
    await parity([
      { old: () => clientApi.agentPlans(), neo: () => desktopApi.agentPlans(), channel: "op:agent:plans" },
      { old: () => clientApi.agentPlanModels("p/1 x"), neo: () => desktopApi.agentPlanModels("p/1 x"), channel: "op:agent:plans:models" },
      { old: () => clientApi.agentPlanApply({ planId: "p1" }), neo: () => desktopApi.agentPlanApply({ planId: "p1" }), channel: "op:agent:plans:apply" },
      { old: () => clientApi.agentPlanApply(), neo: () => desktopApi.agentPlanApply(), channel: "op:agent:plans:apply" },
      { old: () => clientApi.agentPlanDisconnect("p1"), neo: () => desktopApi.agentPlanDisconnect("p1"), channel: "op:agent:plans:disconnect" }
    ]);
  });

  it("诊断：client/thread/runId 空值剔除三形态", async () => {
    await parity([
      { old: () => clientApi.agentDiagnostics(), neo: () => desktopApi.agentDiagnostics(), channel: "op:agent:diagnostics" },
      { old: () => clientApi.agentDiagnostics("c1"), neo: () => desktopApi.agentDiagnostics("c1"), channel: "op:agent:diagnostics" },
      { old: () => clientApi.agentDiagnostics("c1", "t1", "r1"), neo: () => desktopApi.agentDiagnostics("c1", "t1", "r1"), channel: "op:agent:diagnostics" }
    ]);
  });

  it("网络设置与模型配置：network get/save、model-configs list/save/delete/fetch-models", async () => {
    await parity([
      { old: () => clientApi.agentNetworkSettings(), neo: () => desktopApi.agentNetworkSettings(), channel: "op:agent:network-settings:get" },
      { old: () => clientApi.agentNetworkSettingsSave({ proxy: "http://x" }), neo: () => desktopApi.agentNetworkSettingsSave({ proxy: "http://x" }), channel: "op:agent:network-settings:save" },
      { old: () => clientApi.agentNetworkSettingsSave(), neo: () => desktopApi.agentNetworkSettingsSave(), channel: "op:agent:network-settings:save" },
      { old: () => clientApi.agentModelConfigs(), neo: () => desktopApi.agentModelConfigs(), channel: "op:agent:model-configs:list" },
      { old: () => clientApi.saveAgentModelConfig({ provider: "gw", models: [{ id: "m1" }] }), neo: () => desktopApi.saveAgentModelConfig({ provider: "gw", models: [{ id: "m1" }] }), channel: "op:agent:model-configs:save" },
      { old: () => clientApi.saveAgentModelConfig(), neo: () => desktopApi.saveAgentModelConfig(), channel: "op:agent:model-configs:save" },
      { old: () => clientApi.deleteAgentModelConfig("gw/1"), neo: () => desktopApi.deleteAgentModelConfig("gw/1"), channel: "op:agent:model-configs:delete" },
      { old: () => clientApi.fetchAgentModels({ provider: "gw", baseUrl: "u" }), neo: () => desktopApi.fetchAgentModels({ provider: "gw", baseUrl: "u" }), channel: "op:agent:model-configs:fetch-models" },
      { old: () => clientApi.fetchAgentModels(), neo: () => desktopApi.fetchAgentModels(), channel: "op:agent:model-configs:fetch-models" }
    ]);
  });

  it("目录/默认模型/探测/权限：provider-catalog、default-model、probe（model 传对象）、permissions rule（DELETE 带 body）", async () => {
    await parity([
      { old: () => clientApi.agentProviderCatalog(), neo: () => desktopApi.agentProviderCatalog(), channel: "op:agent:provider-catalog" },
      { old: () => clientApi.agentSetDefaultModel("gw", "m1"), neo: () => desktopApi.agentSetDefaultModel("gw", "m1"), channel: "op:agent:default-model:set" },
      { old: () => clientApi.probeAgentModel({ id: "m1" }, 3000), neo: () => desktopApi.probeAgentModel({ id: "m1" }, 3000), channel: "op:agent:model:probe" },
      { old: () => clientApi.probeAgentModel("m1"), neo: () => desktopApi.probeAgentModel("m1"), channel: "op:agent:model:probe" },
      { old: () => clientApi.getPermissionRules(), neo: () => desktopApi.getPermissionRules(), channel: "op:agent:permissions:get" },
      { old: () => clientApi.removePermissionRule({ tool: "bash", path: "F:\\w" }), neo: () => desktopApi.removePermissionRule({ tool: "bash", path: "F:\\w" }), channel: "op:agent:permissions:rule:remove" }
    ]);
  });
});

describe("搜索/地图设置与 client/api.js 等价（对拍）", () => {
  it("联网搜索：settings get/save/test（draft 分支）", async () => {
    await parity([
      { old: () => clientApi.searchSettings(), neo: () => desktopApi.searchSettings(), channel: "op:search:settings:get" },
      { old: () => clientApi.searchSettingsSave({ backend: "tavily", key: "k" }), neo: () => desktopApi.searchSettingsSave({ backend: "tavily", key: "k" }), channel: "op:search:settings:save" },
      { old: () => clientApi.searchSettingsSave(), neo: () => desktopApi.searchSettingsSave(), channel: "op:search:settings:save" },
      { old: () => clientApi.searchSettingsTest("tavily"), neo: () => desktopApi.searchSettingsTest("tavily"), channel: "op:search:test" },
      // 旧侧 draft 默认 null 使 TS 推断第二参为 null，窄化以传入草稿对象（JS 运行时本就支持）
      { old: () => (clientApi.searchSettingsTest as (backend: string, draft?: unknown) => Promise<unknown>)("tavily", { key: "draft" }), neo: () => desktopApi.searchSettingsTest("tavily", { key: "draft" }), channel: "op:search:test" }
    ]);
  });

  it("地图设置：get/save", async () => {
    await parity([
      { old: () => clientApi.mapSettings(), neo: () => desktopApi.mapSettings(), channel: "op:map:settings:get" },
      { old: () => clientApi.mapSettingsSave([{ id: "osm", url: "u" }]), neo: () => desktopApi.mapSettingsSave([{ id: "osm", url: "u" }]), channel: "op:map:settings:save" }
    ]);
  });
});

describe("项目族与 client/api.js 等价（对拍）", () => {
  it("create/classify/update/pin/archive/settings-update", async () => {
    await parity([
      { old: () => clientApi.createProject({ name: "项目A", type: "综合项目" }), neo: () => desktopApi.createProject({ name: "项目A", type: "综合项目" }), channel: "op:projects:create" },
      { old: () => clientApi.createProject(), neo: () => desktopApi.createProject({}), channel: "op:projects:create" },
      { old: () => clientApi.classifyProjects(true), neo: () => desktopApi.classifyProjects(true), channel: "op:projects:classify" },
      { old: () => clientApi.classifyProjects(), neo: () => desktopApi.classifyProjects(), channel: "op:projects:classify" },
      { old: () => clientApi.updateProject("p/1", { name: "改名" }), neo: () => desktopApi.updateProject("p/1", { name: "改名" }), channel: "op:projects:update" },
      { old: () => clientApi.updateProject("p/1"), neo: () => desktopApi.updateProject("p/1", {}), channel: "op:projects:update" },
      { old: () => clientApi.pinProject("p1", false), neo: () => desktopApi.pinProject("p1", false), channel: "op:projects:pin" },
      { old: () => clientApi.pinProject("p1"), neo: () => desktopApi.pinProject("p1"), channel: "op:projects:pin" },
      { old: () => clientApi.archiveProject("p1", false), neo: () => desktopApi.archiveProject("p1", false), channel: "op:projects:archive" },
      { old: () => clientApi.updateProjectSettings("p1", { defaultModel: "m" }), neo: () => desktopApi.updateProjectSettings("p1", { defaultModel: "m" }), channel: "op:projects:settings:update" }
    ]);
  });
});

describe("工作区/文件根/系统族与 client/api.js 等价（对拍）", () => {
  it("工作区：validate/pick/pick-cancel（pick POST body {}）", async () => {
    await parity([
      { old: () => clientApi.validateWorkspace("F:\\w"), neo: () => desktopApi.validateWorkspace("F:\\w"), channel: "op:workspace:validate" },
      { old: () => clientApi.pickWorkspace(), neo: () => desktopApi.pickWorkspace(), channel: "op:workspace:pick" },
      { old: () => clientApi.cancelWorkspacePick(), neo: () => desktopApi.cancelWorkspacePick(), channel: "op:workspace:pick:cancel" }
    ]);
  });

  it("文件根：list/add（label 可选）/remove（id 编码）", async () => {
    await parity([
      { old: () => clientApi.listFileRoots(), neo: () => desktopApi.listFileRoots(), channel: "op:file-roots:list" },
      { old: () => clientApi.addFileRoot("F:\\w", "工作区"), neo: () => desktopApi.addFileRoot("F:\\w", "工作区"), channel: "op:file-roots:add" },
      { old: () => clientApi.addFileRoot("F:\\w"), neo: () => desktopApi.addFileRoot("F:\\w"), channel: "op:file-roots:add" },
      { old: () => clientApi.removeFileRoot("r/1"), neo: () => desktopApi.removeFileRoot("r/1"), channel: "op:file-roots:remove" }
    ]);
  });

  it("系统集成：pick-files（options 可选）/open/reveal", async () => {
    await parity([
      { old: () => clientApi.pickNativeFiles({ multiple: true }), neo: () => desktopApi.pickNativeFiles({ multiple: true }), channel: "op:system:pick-files" },
      { old: () => clientApi.pickNativeFiles(), neo: () => desktopApi.pickNativeFiles(), channel: "op:system:pick-files" },
      { old: () => clientApi.openInSystem("F:\\w\\a.docx"), neo: () => desktopApi.openInSystem("F:\\w\\a.docx"), channel: "op:system:open" },
      { old: () => clientApi.revealInSystem("F:\\w\\a.docx"), neo: () => desktopApi.revealInSystem("F:\\w\\a.docx"), channel: "op:system:reveal" }
    ]);
  });
});

describe("失败路径与 client/api.js 等价（对拍）", () => {
  it("非 2xx：throw 形状（message/code/detail）逐字段相等", async () => {
    setupFailing();
    const oldError = await clientApi.uploadFile("a.docx", "AAAA").then(
      () => { throw new Error("旧侧未抛错"); },
      (e: unknown) => e as Error
    );
    const newError = await desktopApi.uploadFile("a.docx", "AAAA").then(
      () => { throw new Error("新侧未抛错"); },
      (e: unknown) => e as Error
    );
    expect(newError.message).toBe(oldError.message);
    expect(newError.message).toBe("失败");
    expect((newError as { code?: string }).code).toBe("E_X");
    expect((newError as { detail?: unknown }).detail).toEqual({ k: 1 });
  });
});
