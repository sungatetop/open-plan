/**
 * C-3 Pi 配置族直调对拍（agent-pi-config-direct.ts 编排层）。
 *
 * 覆盖面（行号锚点均指 server/index.mjs）：
 *   - manifest 锚点：8 通道全部在 DESKTOP_CHANNELS 且路由指向已审计路径；unknown → 404；
 *   - 本地辅助转录边界：validateModelConfigInput 校验矩阵（L1404-1436）、
 *     publicModelConfigs 投影形状（L1438-1459）、loadSettingsDefault 拼接（L4975-4978）；
 *   - 逐通道编排语义（deps 全注入桩，pi-config-management/provider-auth 域行为由
 *     b6 系列对拍覆盖）：models:list vision enrich 与 default 拼接 / model-configs:list
 *     平铺投影 / save 校验→目录补全→写配置→凭据→reset→单条回显 / delete 404 与
 *     成功链 / default-model:set 校验与拼接 / config-status、import-preview 透传 /
 *     import-config 404→开关→409→清缓存→reset→status 附加。
 *
 * 本文件为纯编排测试：不加载 pi-config-management 等域实现（无 env 隔离需求）。
 */
import { describe, expect, test, beforeAll, vi } from "vitest";
import type * as PiConfigModule from "../src/main/ipc/agent-pi-config-direct";
import { DESKTOP_CHANNELS, type InvokeEnvelope } from "../src/shared/protocol/channels";

type PiConfig = typeof PiConfigModule;
let svc: PiConfig;

beforeAll(async () => {
  svc = await import("../src/main/ipc/agent-pi-config-direct");
});

/** deps 桩：pi-config / provider-auth / agent-errors / session-files / pi-runtime / assembly 注入面。 */
function makeDeps(overrides: Partial<PiConfigModule.AgentPiConfigDirectDeps> = {}) {
  const deps = {
    listModelCatalog: vi.fn(async () => ({ models: [{ id: "deepseek/deepseek-chat", provider: "deepseek", vision: false, contextWindow: 128000 }], provider: "deepseek" })),
    readModelsStore: vi.fn(() => ({ deepseek: { models: [{ id: "deepseek-chat", input: ["text", "image"] }] } })),
    readRuntimeSettings: vi.fn(() => ({ defaultProvider: "deepseek", defaultModel: "deepseek-chat" })),
    readModelsConfig: vi.fn(() => ({ providers: { deepseek: { name: "DeepSeek", api: "openai-completions", baseUrl: "https://api.deepseek.com", enabled: true, models: [{ id: "deepseek-chat", name: "DeepSeek Chat", contextWindow: 128000, input: ["text", "image"], reasoning: true, enabled: true }] } } })),
    writeModelsConfig: vi.fn(() => "written"),
    listAuth: vi.fn(() => ({ deepseek: { type: "api_key", key: "sk-x" } })),
    getCredentialErrors: vi.fn(() => ({ deepseek: { at: "T0", message: "凭据无效" } })),
    setApiKey: vi.fn(async () => ({ ok: true, providers: ["deepseek"] })),
    removeApiKey: vi.fn(async () => ({ ok: true, providers: [] })),
    resetModelRuntime: vi.fn(() => undefined),
    writeDefaultModel: vi.fn(() => ({ defaultProvider: "deepseek", defaultModel: "deepseek-chat" })),
    getConfigStatus: vi.fn(() => ({ provider: "deepseek", defaultModel: "deepseek/deepseek-chat" })),
    previewLocalPiConfig: vi.fn(() => ({ available: true, models: 3, credentials: 1 })),
    importLocalPiConfig: vi.fn(() => ({ ok: true, imported: ["config.json"], skipped: [] })),
    importLocalPiSessions: vi.fn(() => ({ ok: true, imported: 2, files: ["a.jsonl", "b.jsonl"] })),
    sessionsDir: vi.fn(() => "SESSIONS_DIR"),
    clearSessionCaches: vi.fn(() => undefined),
    ...overrides
  };
  return deps as never as PiConfigModule.AgentPiConfigDirectDeps & {
    // 测试内需访问 vi.fn 的 mock 记录；接口签名的纯函数视图供 invoke 使用
    listModelCatalog: ReturnType<typeof vi.fn>;
    readModelsStore: ReturnType<typeof vi.fn>;
    readRuntimeSettings: ReturnType<typeof vi.fn>;
    readModelsConfig: ReturnType<typeof vi.fn>;
    writeModelsConfig: ReturnType<typeof vi.fn>;
    listAuth: ReturnType<typeof vi.fn>;
    getCredentialErrors: ReturnType<typeof vi.fn>;
    setApiKey: ReturnType<typeof vi.fn>;
    removeApiKey: ReturnType<typeof vi.fn>;
    resetModelRuntime: ReturnType<typeof vi.fn>;
    writeDefaultModel: ReturnType<typeof vi.fn>;
    getConfigStatus: ReturnType<typeof vi.fn>;
    previewLocalPiConfig: ReturnType<typeof vi.fn>;
    importLocalPiConfig: ReturnType<typeof vi.fn>;
    importLocalPiSessions: ReturnType<typeof vi.fn>;
    sessionsDir: ReturnType<typeof vi.fn>;
    clearSessionCaches: ReturnType<typeof vi.fn>;
  };
}

function invoke(channel: PiConfigModule.AgentPiConfigDirectChannel, envelope: InvokeEnvelope | undefined, deps = makeDeps()) {
  return svc.invokeAgentPiConfigDirect(channel, envelope, deps);
}

describe("C-3 manifest 锚点", () => {
  test("8 条通道全部在 DESKTOP_CHANNELS 且路由指向已审计路径", () => {
    expect(svc.AGENT_PI_CONFIG_DIRECT_CHANNELS).toHaveLength(8);
    const expectedRoutes: Record<string, { method: string; path: string }> = {
      "op:models:list": { method: "GET", path: "/api/models" },
      "op:agent:model-configs:list": { method: "GET", path: "/api/agent/model-configs" },
      "op:agent:model-configs:save": { method: "POST", path: "/api/agent/model-configs" },
      "op:agent:model-configs:delete": { method: "DELETE", path: "/api/agent/model-configs/:provider" },
      "op:agent:default-model:set": { method: "POST", path: "/api/agent/default-model" },
      "op:agent:config-status": { method: "GET", path: "/api/agent/config-status" },
      "op:agent:import-preview": { method: "GET", path: "/api/agent/import-preview" },
      "op:agent:import-config": { method: "POST", path: "/api/agent/import-config" }
    };
    for (const channel of svc.AGENT_PI_CONFIG_DIRECT_CHANNELS) {
      expect(DESKTOP_CHANNELS[channel as keyof typeof DESKTOP_CHANNELS]).toEqual(expectedRoutes[channel]);
    }
  });

  test("unknown channel → 404", async () => {
    const result = await svc.invokeAgentPiConfigDirect("op:agent:pi-config:export" as never, {}, makeDeps());
    expect(result).toEqual({ ok: false, status: 404, data: { error: "unknown channel: op:agent:pi-config:export" } });
  });
});

describe("C-3 op:models:list（server L1461-1476）", () => {
  test("vision enrich：store input 含 image → true；default = provider/model 拼接", async () => {
    const result = await invoke("op:models:list", {});
    const data = result.data as any;
    expect(data.models[0].vision).toBe(true);
    expect(data.default).toBe("deepseek/deepseek-chat");
    expect(data.provider).toBe("deepseek");
  });

  test("default 投影：无 defaultProvider → 仅 defaultModel；两者皆空 → 空串", async () => {
    const deps = makeDeps({ readRuntimeSettings: vi.fn(() => ({ defaultModel: "m1" })) });
    expect(((await invoke("op:models:list", {}, deps)).data as any).default).toBe("m1");
    const emptyDeps = makeDeps({ readRuntimeSettings: vi.fn(() => ({})) });
    expect(((await invoke("op:models:list", {}, emptyDeps)).data as any).default).toBe("");
  });

  test("listModelCatalog 抛错 → 500 { error }（无 code，忠实转录）", async () => {
    const deps = makeDeps({ listModelCatalog: vi.fn(async () => { throw new Error("目录读取失败"); }) });
    const result = await invoke("op:models:list", {}, deps);
    expect(result).toEqual({ ok: false, status: 500, data: { error: "目录读取失败" } });
  });
});

describe("C-3 op:agent:model-configs:list（server L1478-1480，publicModelConfigs L1438-1459）", () => {
  test("投影形状：keyConfigured/authError/models 投影（contextWindow 回退 contextLength、vision 由 input 判定）", async () => {
    const result = await invoke("op:agent:model-configs:list", {});
    expect(result.data).toEqual({
      configs: [{
        provider: "deepseek",
        name: "DeepSeek",
        api: "openai-completions",
        baseUrl: "https://api.deepseek.com",
        enabled: true,
        keyConfigured: true,
        authError: "凭据无效",
        models: [{ id: "deepseek-chat", name: "DeepSeek Chat", contextWindow: 128000, reasoning: true, vision: true, enabled: true }]
      }]
    });
  });

  test("keyConfigured 覆盖 token/secret 分支；无凭据 → false；contextWindow/contextLength 皆缺 → null", async () => {
    const deps = makeDeps({
      listAuth: vi.fn(() => ({ deepseek: { token: "tok" } })),
      getCredentialErrors: vi.fn(() => ({})),
      readModelsConfig: vi.fn(() => ({ providers: { deepseek: { models: [{ id: "m1" }] }, empty: {} } }))
    });
    const configs = ((await invoke("op:agent:model-configs:list", {}, deps)).data as any).configs;
    expect(configs[0].keyConfigured).toBe(true);
    expect(configs[0].authError).toBeNull();
    expect(configs[0].models[0]).toMatchObject({ contextWindow: null, vision: false, reasoning: true, enabled: true, name: "m1" });
    expect(configs[1].keyConfigured).toBe(false);
  });
});

describe("C-3 op:agent:model-configs:save（server L1482-1522）", () => {
  const validBody = {
    provider: "deepseek", name: "DeepSeek", api: "openai-completions", baseUrl: "https://api.deepseek.com",
    apiKey: "sk-new", models: [{ id: "deepseek-chat", name: "Chat" }]
  };

  test("校验矩阵：provider/baseUrl/协议/models/模型 ID 非法 → 400 code MODEL_CONFIG_INVALID", async () => {
    expect(((await invoke("op:agent:model-configs:save", { body: { ...validBody, provider: "x" } })).data as any).code).toBe("MODEL_CONFIG_INVALID");
    expect(((await invoke("op:agent:model-configs:save", { body: { ...validBody, baseUrl: "ftp://x" } })).data as any).code).toBe("MODEL_CONFIG_INVALID");
    expect(((await invoke("op:agent:model-configs:save", { body: { ...validBody, api: "grpc" } })).data as any).code).toBe("MODEL_CONFIG_INVALID");
    expect(((await invoke("op:agent:model-configs:save", { body: { ...validBody, models: [] } })).data as any).code).toBe("MODEL_CONFIG_INVALID");
    expect(((await invoke("op:agent:model-configs:save", { body: { ...validBody, models: [{ id: "a b" }] } })).data as any).code).toBe("MODEL_CONFIG_INVALID");
  });

  test("成功路径：目录补全未填窗口 → 写配置（previous 合并 + models 平铺 api/baseUrl）→ setApiKey → reset → 单条回显", async () => {
    const deps = makeDeps();
    const result = await invoke("op:agent:model-configs:save", { body: validBody }, deps);
    const written = deps.writeModelsConfig.mock.calls[0]![0] as any;
    expect(written.providers.deepseek.models[0]).toMatchObject({ id: "deepseek-chat", api: "openai-completions", baseUrl: "https://api.deepseek.com", contextWindow: 128000 });
    expect(deps.setApiKey).toHaveBeenCalledWith("deepseek", "sk-new");
    expect(deps.resetModelRuntime).toHaveBeenCalledTimes(1);
    expect(result.data).toEqual({ ok: true, config: { provider: "deepseek", name: "DeepSeek", api: "openai-completions", baseUrl: "https://api.deepseek.com", enabled: true, keyConfigured: true, authError: "凭据无效", models: [expect.objectContaining({ id: "deepseek-chat", vision: true })] } });
  });

  test("clearApiKey → removeApiKey；两者皆无 → 不调凭据；目录补全抛错静默（try{}catch{} 忠实转录）", async () => {
    const deps = makeDeps({ listModelCatalog: vi.fn(async () => { throw new Error("目录故障"); }) });
    await invoke("op:agent:model-configs:save", { body: { ...validBody, apiKey: "", clearApiKey: true } }, deps);
    expect(deps.removeApiKey).toHaveBeenCalledWith("deepseek");
    expect(deps.setApiKey).not.toHaveBeenCalled();
    expect(deps.resetModelRuntime).toHaveBeenCalledTimes(1);
  });
});

describe("C-3 op:agent:model-configs:delete（server L1524-1534）", () => {
  test("不存在 → 404 { ok:false, error:'供应商不存在' }（无 code，忠实转录）", async () => {
    const result = await invoke("op:agent:model-configs:delete", { params: { provider: "missing" } });
    expect(result).toEqual({ ok: false, status: 404, data: { ok: false, error: "供应商不存在" } });
    expect((result.data as any).code).toBeUndefined();
  });

  test("成功链：写配置（删除该 provider）→ removeApiKey → reset → { ok:true, provider }", async () => {
    const deps = makeDeps();
    const result = await invoke("op:agent:model-configs:delete", { params: { provider: "deepseek" } }, deps);
    const written = deps.writeModelsConfig.mock.calls[0]![0] as any;
    expect(written.providers.deepseek).toBeUndefined();
    expect(deps.removeApiKey).toHaveBeenCalledWith("deepseek");
    expect(deps.resetModelRuntime).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, status: 200, data: { ok: true, provider: "deepseek" } });
  });
});

describe("C-3 op:agent:default-model:set（server L1753-1764）", () => {
  test("缺参 → 400 code DEFAULT_MODEL_INVALID；成功 → writeDefaultModel + reset + defaultModel 拼接", async () => {
    expect((await invoke("op:agent:default-model:set", { body: { provider: "p" } })).data).toEqual({ ok: false, error: "provider 和 model 都需要", code: "DEFAULT_MODEL_INVALID" });
    const deps = makeDeps();
    const result = await invoke("op:agent:default-model:set", { body: { provider: "deepseek", model: "deepseek-chat" } }, deps);
    expect(deps.writeDefaultModel).toHaveBeenCalledWith({ provider: "deepseek", model: "deepseek-chat" });
    expect(deps.resetModelRuntime).toHaveBeenCalledTimes(1);
    expect(result.data).toEqual({ ok: true, defaultProvider: "deepseek", defaultModel: "deepseek/deepseek-chat" });
  });

  test("writeDefaultModel 抛错 → 500 code DEFAULT_MODEL_FAILED", async () => {
    const deps = makeDeps({ writeDefaultModel: vi.fn(() => { throw new Error("写入失败"); }) });
    const result = await invoke("op:agent:default-model:set", { body: { provider: "p", model: "m" } }, deps);
    expect(result.data).toEqual({ ok: false, error: "写入失败", code: "DEFAULT_MODEL_FAILED" });
  });
});

describe("C-3 op:agent:config-status / import-preview（server L2046-2052、L2306-2312）", () => {
  test("透传 + 抛错 → 500 各自 code", async () => {
    expect((await invoke("op:agent:config-status", {})).data).toEqual({ provider: "deepseek", defaultModel: "deepseek/deepseek-chat" });
    expect((await invoke("op:agent:config-status", {}, makeDeps({ getConfigStatus: vi.fn(() => { throw new Error("状态失败"); }) }))).data).toEqual({ error: "状态失败", code: "CONFIG_STATUS_FAILED" });
    expect((await invoke("op:agent:import-preview", {})).data).toEqual({ available: true, models: 3, credentials: 1 });
    expect((await invoke("op:agent:import-preview", {}, makeDeps({ previewLocalPiConfig: vi.fn(() => { throw new Error("预览失败"); }) }))).data).toEqual({ error: "预览失败", code: "IMPORT_PREVIEW_FAILED" });
  });
});

describe("C-3 op:agent:import-config（server L2354-2373）", () => {
  test("preview 不可用 → 404 code LOCAL_PI_NOT_FOUND；result.ok false → 409 整体透传", async () => {
    const noPi = await invoke("op:agent:import-config", { body: {} }, makeDeps({ previewLocalPiConfig: vi.fn(() => ({ available: false })) }));
    expect(noPi).toEqual({ ok: false, status: 404, data: { ok: false, error: "未检测到可导入的本地 Pi 配置", code: "LOCAL_PI_NOT_FOUND" } });

    const conflict = await invoke("op:agent:import-config", { body: {} }, makeDeps({ importLocalPiConfig: vi.fn(() => ({ ok: false, error: "目标占用" })) }));
    expect(conflict).toEqual({ ok: false, status: 409, data: { ok: false, error: "目标占用" } });
  });

  test("开关语义：四开关缺省均为 true（server enabled() 统一 fallback）；成功链 清缓存→reset→status 附加", async () => {
    const deps = makeDeps();
    const result = await invoke("op:agent:import-config", { body: {} }, deps);
    expect(deps.importLocalPiConfig).toHaveBeenCalledWith({ includeModels: true, includeSettings: true, includeCredentials: true });
    expect(deps.importLocalPiSessions).toHaveBeenCalledWith({ targetDir: "SESSIONS_DIR" });
    expect(deps.clearSessionCaches).toHaveBeenCalledTimes(1);
    expect(deps.resetModelRuntime).toHaveBeenCalledTimes(1);
    expect(result.data).toEqual({ ok: true, imported: ["config.json"], skipped: [], sessions: { ok: true, imported: 2, files: ["a.jsonl", "b.jsonl"] }, status: { provider: "deepseek", defaultModel: "deepseek/deepseek-chat" } });

    const deps2 = makeDeps();
    await invoke("op:agent:import-config", { body: { includeModels: false, includeSettings: false, includeCredentials: false, includeSessions: false } }, deps2);
    expect(deps2.importLocalPiConfig).toHaveBeenCalledWith({ includeModels: false, includeSettings: false, includeCredentials: false });
    expect(deps2.importLocalPiSessions).not.toHaveBeenCalled();
    expect((await svc.invokeAgentPiConfigDirect("op:agent:import-config", { body: { includeSessions: false } }, makeDeps())).data as any).toMatchObject({ sessions: { ok: true, imported: 0, files: [] } });
  });

  test("preview/import 抛错 → 500 code PI_IMPORT_FAILED", async () => {
    const deps = makeDeps({ previewLocalPiConfig: vi.fn(() => { throw new Error("读取失败"); }) });
    const result = await invoke("op:agent:import-config", { body: {} }, deps);
    expect(result.data).toEqual({ ok: false, error: "读取失败", code: "PI_IMPORT_FAILED" });
  });
});
