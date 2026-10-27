/**
 * C-4 供应商目录族直调对拍（agent-provider-catalog-direct.ts 编排层）。
 *
 * 覆盖面（行号锚点均指 server/index.mjs）：
 *   - manifest 锚点：6 通道全部在 DESKTOP_CHANNELS 且路由指向已审计路径；unknown → 404；
 *   - 本地辅助转录：providerCatalogPayload 聚合形状（L1604-1647，OAuth 凭据四键判定、
 *     summary 统计、isDefault 拼接）；
 *   - 逐通道编排语义（deps 全注入桩，provider-catalog/models-dev 域行为由既有 b2
 *     对拍覆盖）：detail 404 与 configured 投影 / import 同名模型合并保留用户编辑 +
 *     setDefault + 凭据写入 / refresh 失败降级缓存不 500 / custom-provider 校验矩阵 +
 *     内置目录补全 + 密钥字段清理 / fetch-models URL/Key 校验 + oawNetwork 错误体 +
 *     HTTP 状态映射 + data[] 去重对账 + adapter.close finally。
 *
 * 本文件为纯编排测试：不加载 provider-catalog 等域实现（无 env 隔离需求）。
 */
import { describe, expect, test, beforeAll, vi } from "vitest";
import type * as ProviderCatalogModule from "../src/main/ipc/agent-provider-catalog-direct";
import { DESKTOP_CHANNELS, type InvokeEnvelope } from "../src/shared/protocol/channels";

type ProviderCatalog = typeof ProviderCatalogModule;
let svc: ProviderCatalog;

beforeAll(async () => {
  svc = await import("../src/main/ipc/agent-provider-catalog-direct");
});

/** deps 桩：provider-catalog / models-dev / pi-network-proxy / pi-config / 凭据面注入。 */
function makeDeps(overrides: Partial<ProviderCatalogModule.AgentProviderCatalogDirectDeps> = {}) {
  const deps = {
    builtinProviderList: vi.fn(() => ({
      generatedAt: "G0",
      error: null,
      totalModels: 42,
      loginOnly: [],
      providers: [
        { id: "deepseek", name: "DeepSeek", auth: { oauth: false }, importable: true },
        { id: "qwen", name: "Qwen", auth: { oauth: true }, importable: true }
      ]
    })),
    builtinProviderDetail: vi.fn(() => ({ id: "deepseek", name: "DeepSeek", models: [{ id: "deepseek-chat", contextWindow: 128000 }] })),
    buildBuiltinImport: vi.fn(() => ({
      provider: "deepseek", name: "DeepSeek", api: "openai-completions", baseUrl: "https://api.deepseek.com",
      enabled: true, auth: [{ method: "api_key" }],
      models: [{ id: "deepseek-chat", name: "DeepSeek Chat", api: "openai-completions", baseUrl: "https://api.deepseek.com", reasoning: true, input: ["text"], enabled: true }]
    })),
    findBuiltinModel: vi.fn((id: unknown) => (id === "deepseek-chat" ? { id: "deepseek-chat", name: "DeepSeek Chat", contextWindow: 128000, vision: true, reasoning: true, provider: "deepseek" } : null)),
    fetchModelsDevCatalog: vi.fn(async () => ({ fetchedAt: "F0", providerCount: 12, modelCount: 900 })),
    readModelsDevCache: vi.fn(() => ({ fetchedAt: "P0", providerCount: 11, modelCount: 880 })),
    writeModelsDevCache: vi.fn(() => undefined),
    invalidateMergedCatalog: vi.fn(() => undefined),
    createPiNetworkAdapter: vi.fn(() => ({ fetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: "deepseek-chat" }, { id: "m2" }, { id: "deepseek-chat" }] }) })), close: vi.fn(() => undefined) })),
    readModelsConfig: vi.fn(() => ({ providers: { deepseek: { name: "DeepSeek", api: "openai-completions", baseUrl: "https://api.deepseek.com", enabled: true, models: [{ id: "deepseek-chat", name: "用户改的名", contextWindow: 99000, reasoning: false, input: ["text"], enabled: true }] } } })),
    writeModelsConfig: vi.fn(() => undefined),
    readRuntimeSettings: vi.fn(() => ({ defaultProvider: "deepseek", defaultModel: "deepseek-chat" })),
    writeDefaultModel: vi.fn(() => ({ defaultProvider: "deepseek", defaultModel: "deepseek-chat" })),
    listAuth: vi.fn(() => ({ deepseek: { type: "api_key", key: "sk-x" } })),
    getCredentialErrors: vi.fn(() => ({})),
    setApiKey: vi.fn(async () => ({ ok: true })),
    resetModelRuntime: vi.fn(() => undefined),
    ...overrides
  };
  return deps as never as ProviderCatalogModule.AgentProviderCatalogDirectDeps & {
    // 测试内需访问 vi.fn 的 mock 记录；接口签名的纯函数视图供 invoke 使用
    builtinProviderList: ReturnType<typeof vi.fn>;
    builtinProviderDetail: ReturnType<typeof vi.fn>;
    buildBuiltinImport: ReturnType<typeof vi.fn>;
    findBuiltinModel: ReturnType<typeof vi.fn>;
    fetchModelsDevCatalog: ReturnType<typeof vi.fn>;
    readModelsDevCache: ReturnType<typeof vi.fn>;
    writeModelsDevCache: ReturnType<typeof vi.fn>;
    invalidateMergedCatalog: ReturnType<typeof vi.fn>;
    createPiNetworkAdapter: ReturnType<typeof vi.fn>;
    readModelsConfig: ReturnType<typeof vi.fn>;
    writeModelsConfig: ReturnType<typeof vi.fn>;
    readRuntimeSettings: ReturnType<typeof vi.fn>;
    writeDefaultModel: ReturnType<typeof vi.fn>;
    listAuth: ReturnType<typeof vi.fn>;
    getCredentialErrors: ReturnType<typeof vi.fn>;
    setApiKey: ReturnType<typeof vi.fn>;
    resetModelRuntime: ReturnType<typeof vi.fn>;
  };
}

function invoke(channel: ProviderCatalogModule.AgentProviderCatalogDirectChannel, envelope: InvokeEnvelope | undefined, deps = makeDeps()) {
  return svc.invokeAgentProviderCatalogDirect(channel, envelope, deps);
}

describe("C-4 manifest 锚点", () => {
  test("6 条通道全部在 DESKTOP_CHANNELS 且路由指向已审计路径", () => {
    expect(svc.AGENT_PROVIDER_CATALOG_DIRECT_CHANNELS).toHaveLength(6);
    const expectedRoutes: Record<string, { method: string; path: string }> = {
      "op:agent:provider-catalog": { method: "GET", path: "/api/agent/provider-catalog" },
      "op:agent:provider-catalog:detail": { method: "GET", path: "/api/agent/provider-catalog/:id" },
      "op:agent:provider-catalog:import": { method: "POST", path: "/api/agent/provider-catalog/import" },
      "op:agent:provider-catalog:refresh": { method: "POST", path: "/api/agent/provider-catalog/refresh" },
      "op:agent:custom-provider": { method: "POST", path: "/api/agent/custom-provider" },
      "op:agent:model-configs:fetch-models": { method: "POST", path: "/api/agent/model-configs/fetch-models" }
    };
    for (const channel of svc.AGENT_PROVIDER_CATALOG_DIRECT_CHANNELS) {
      expect(DESKTOP_CHANNELS[channel as keyof typeof DESKTOP_CHANNELS]).toEqual(expectedRoutes[channel]);
    }
  });

  test("unknown channel → 404", async () => {
    const result = await svc.invokeAgentProviderCatalogDirect("op:agent:provider-catalog:remove" as never, {}, makeDeps());
    expect(result).toEqual({ ok: false, status: 404, data: { error: "unknown channel: op:agent:provider-catalog:remove" } });
  });
});

describe("C-4 op:agent:provider-catalog（L1649-1655，providerCatalogPayload L1604-1647）", () => {
  test("聚合形状：configured/modelsConfigured/keyConfigured（OAuth 四键判定）/authError/isDefault/summary", async () => {
    const deps = makeDeps({
      listAuth: vi.fn(() => ({ deepseek: { type: "api_key", key: "sk-x" }, qwen: { type: "oauth", access: "a", refresh: "r" } })),
      getCredentialErrors: vi.fn(() => ({ deepseek: { message: "凭据无效" } }))
    });
    const result = await invoke("op:agent:provider-catalog", {}, deps);
    const data = result.data as any;
    expect(data.ok).toBe(true);
    expect(data.defaultModel).toBe("deepseek/deepseek-chat");
    const deepseek = data.providers[0];
    expect(deepseek).toMatchObject({ id: "deepseek", configured: true, modelsConfigured: true, enabled: true, keyConfigured: true, credentialType: "api_key", configuredModelCount: 1, authError: "凭据无效", isDefault: true });
    const qwen = data.providers[1];
    expect(qwen).toMatchObject({ configured: true, modelsConfigured: false, enabled: null, keyConfigured: true, credentialType: "oauth", configuredModelCount: 0, isDefault: false });
    expect(data.summary).toEqual({ total: 2, importable: 2, configured: 2, oauth: 1 });
  });

  test("无凭据无配置 → configured:false；listAuth 抛错 → 500 code PROVIDER_CATALOG_FAILED", async () => {
    const deps = makeDeps({ listAuth: vi.fn(() => ({})), readModelsConfig: vi.fn(() => ({})), readRuntimeSettings: vi.fn(() => ({})) });
    const data = ((await invoke("op:agent:provider-catalog", {}, deps)).data as any);
    expect(data.providers[0]).toMatchObject({ configured: false, modelsConfigured: false, enabled: null, keyConfigured: false, isDefault: false });
    expect(data.defaultModel).toBe("");

    const errDeps = makeDeps({ builtinProviderList: vi.fn(() => { throw new Error("目录损坏"); }) });
    expect((await invoke("op:agent:provider-catalog", {}, errDeps)).data).toEqual({ ok: false, error: "目录损坏", code: "PROVIDER_CATALOG_FAILED" });
  });
});

describe("C-4 op:agent:provider-catalog:detail（L1658-1667）", () => {
  test("不存在 → 404 code PROVIDER_CATALOG_MISSING；成功 → { provider, configured }", async () => {
    const missing = await invoke("op:agent:provider-catalog:detail", { params: { id: "nope" } }, makeDeps({ builtinProviderDetail: vi.fn(() => null) }));
    expect(missing).toEqual({ ok: false, status: 404, data: { ok: false, error: "内置供应商不存在", code: "PROVIDER_CATALOG_MISSING" } });

    const result = await invoke("op:agent:provider-catalog:detail", { params: { id: "deepseek" } });
    expect(result.data).toMatchObject({ ok: true, provider: { id: "deepseek" }, configured: { provider: "deepseek", keyConfigured: true } });
  });
});

describe("C-4 op:agent:provider-catalog:import（L1671-1729）", () => {
  const importBody = { provider: "deepseek", apiKey: "sk-new", setDefault: true };

  test("合并语义：同名模型保留用户编辑（name 回退、其余 user 字段覆盖），新模型 added 计数；响应形状", async () => {
    const deps = makeDeps();
    const result = await invoke("op:agent:provider-catalog:import", { body: importBody }, deps);
    const written = deps.writeModelsConfig.mock.calls[0]![0] as any;
    const model = written.providers.deepseek.models[0];
    expect(model).toMatchObject({ id: "deepseek-chat", name: "用户改的名", contextWindow: 99000, reasoning: false });
    expect(deps.setApiKey).toHaveBeenCalledWith("deepseek", "sk-new");
    expect(deps.writeDefaultModel).toHaveBeenCalledWith({ provider: "deepseek", model: "deepseek-chat" });
    expect(deps.resetModelRuntime).toHaveBeenCalledTimes(1);
    expect(result.data).toMatchObject({ ok: true, provider: "deepseek", added: 0, total: 1, keyConfigured: true, defaultModel: "deepseek/deepseek-chat", loginMethods: [{ method: "api_key" }] });
  });

  test("新模型 added 计数 + setDefault 缺省不写默认 + buildBuiltinImport 抛错 → 400 code PROVIDER_IMPORT_FAILED", async () => {
    const deps = makeDeps({
      readModelsConfig: vi.fn(() => ({})),
      buildBuiltinImport: vi.fn(() => ({
        provider: "newprov", name: "New", api: "openai-completions", baseUrl: "https://x", enabled: true,
        auth: [], models: [{ id: "a" }, { id: "b" }]
      }))
    });
    const result = await invoke("op:agent:provider-catalog:import", { body: { provider: "newprov" } }, deps);
    expect(result.data).toMatchObject({ ok: true, provider: "newprov", added: 2, total: 2, keyConfigured: false, defaultModel: null });
    expect(deps.writeDefaultModel).not.toHaveBeenCalled();

    const errDeps = makeDeps({ buildBuiltinImport: vi.fn(() => { throw new Error("未知供应商"); }) });
    expect((await invoke("op:agent:provider-catalog:import", { body: { provider: "x" } }, errDeps)).data).toEqual({ ok: false, error: "未知供应商", code: "PROVIDER_IMPORT_FAILED" });
  });
});

describe("C-4 op:agent:provider-catalog:refresh（L1733-1750）", () => {
  test("成功 → fromCache:false + 重建合并目录；失败降级缓存 → ok:true fromCache:true 不 500", async () => {
    const deps = makeDeps();
    const result = await invoke("op:agent:provider-catalog:refresh", {}, deps);
    expect(result.status).toBe(200);
    expect(result.data).toEqual({ ok: true, fromCache: false, fetchedAt: "F0", providerCount: 12, modelCount: 900 });
    expect(deps.invalidateMergedCatalog).toHaveBeenCalledTimes(1);

    const failDeps = makeDeps({ fetchModelsDevCatalog: vi.fn(async () => { throw new Error("网络超时".repeat(50)); }) });
    const failed = await invoke("op:agent:provider-catalog:refresh", {}, failDeps);
    expect(failed.status).toBe(200);
    const data = failed.data as any;
    expect(data).toMatchObject({ ok: true, fromCache: true, fetchedAt: "P0", providerCount: 11, modelCount: 880 });
    expect(data.error.length).toBeLessThanOrEqual(200);
    expect(failDeps.writeModelsDevCache).not.toHaveBeenCalled();
  });
});

describe("C-4 op:agent:custom-provider（L1789-1832）", () => {
  const validBody = { provider: "deepseek", baseUrl: "https://api.deepseek.com/", modelId: "deepseek-chat" };

  test("校验矩阵：provider/baseUrl/api/modelId 各自 400 code", async () => {
    expect(((await invoke("op:agent:custom-provider", { body: { ...validBody, provider: "x" } })).data as any).code).toBe("CUSTOM_PROVIDER_INVALID");
    expect(((await invoke("op:agent:custom-provider", { body: { ...validBody, baseUrl: "ftp://x" } })).data as any).code).toBe("CUSTOM_BASE_URL_INVALID");
    expect(((await invoke("op:agent:custom-provider", { body: { ...validBody, api: "grpc" } })).data as any).code).toBe("CUSTOM_API_INVALID");
    expect(((await invoke("op:agent:custom-provider", { body: { ...validBody, modelId: "a b" } })).data as any).code).toBe("CUSTOM_MODEL_INVALID");
  });

  test("成功链：known 补全（contextWindow/vision 默认/reasoning 默认）+ previousModel 合并 + 密钥字段清理 + 旧模型替换", async () => {
    const deps = makeDeps();
    const result = await invoke("op:agent:custom-provider", { body: validBody }, deps);
    const written = deps.writeModelsConfig.mock.calls[0]![0] as any;
    const provider = written.providers.deepseek;
    expect(provider.models).toHaveLength(1);
    const model = provider.models[0];
    expect(model).toMatchObject({ id: "deepseek-chat", name: "deepseek-chat", api: "openai-completions", baseUrl: "https://api.deepseek.com", contextWindow: 128000, reasoning: true, input: ["text", "image"] });
    expect(model.apiKey).toBeUndefined();
    expect(model.api_key).toBeUndefined();
    expect(deps.resetModelRuntime).toHaveBeenCalledTimes(1);
    expect(result.data).toEqual({ ok: true, provider: "deepseek", model: "deepseek/deepseek-chat", modelName: "deepseek-chat", api: "openai-completions", baseUrl: "https://api.deepseek.com" });
  });

  test("vision 显式 false → input:['text']；写失败 → 500 code CUSTOM_PROVIDER_SAVE_FAILED", async () => {
    const deps = makeDeps();
    await invoke("op:agent:custom-provider", { body: { ...validBody, vision: false, contextWindow: 4096 } }, deps);
    const model = ((deps.writeModelsConfig.mock.calls[0]![0] as any).providers.deepseek.models[0]);
    expect(model.input).toEqual(["text"]);
    expect(model.contextWindow).toBe(4096);

    const errDeps = makeDeps({ writeModelsConfig: vi.fn(() => { throw new Error("磁盘只读"); }) });
    expect((await invoke("op:agent:custom-provider", { body: validBody }, errDeps)).data).toEqual({ ok: false, error: "磁盘只读", code: "CUSTOM_PROVIDER_SAVE_FAILED" });
  });
});

describe("C-4 op:agent:model-configs:fetch-models（L1537-1598）", () => {
  test("URL/Key 校验：无 baseUrl 无 provider → INVALID_URL；provider 回退链 config.baseUrl + auth.key/apiKey/token；无 key → NO_KEY", async () => {
    expect(((await invoke("op:agent:model-configs:fetch-models", { body: {} })).data as any).code).toBe("MODELS_FETCH_INVALID_URL");

    const deps = makeDeps({
      readModelsConfig: vi.fn(() => ({ providers: { deepseek: { baseUrl: "https://api.deepseek.com" } } })),
      listAuth: vi.fn(() => ({ deepseek: { token: "tok-x" } }))
    });
    await invoke("op:agent:model-configs:fetch-models", { body: { provider: "deepseek" } }, deps);
    const fetchCall = (deps.createPiNetworkAdapter.mock.results[0]!.value as any).fetch.mock.calls[0]![0];
    expect(fetchCall).toBe("https://api.deepseek.com/models");

    const noKey = await invoke("op:agent:model-configs:fetch-models", { body: { baseUrl: "https://x.com" } }, makeDeps({ listAuth: vi.fn(() => ({})) }));
    expect(noKey.data).toEqual({ ok: false, error: "缺少 API Key：请先保存凭据，或临时填写 Key", code: "MODELS_FETCH_NO_KEY" });
  });

  test("网络异常 → 502 oawNetwork 优先截 300；HTTP 401 → MODELS_FETCH_AUTH；非 ok → MODELS_FETCH_FAILED；data[] 空 → 422", async () => {
    const netErr = makeDeps({ createPiNetworkAdapter: vi.fn(() => ({ fetch: vi.fn(async () => { const e: any = new Error("连接失败"); e.oawNetwork = { message: "代理拒绝", code: "OAW_PROXY" }; throw e; }), close: vi.fn() })) });
    expect((await invoke("op:agent:model-configs:fetch-models", { body: { baseUrl: "https://x.com", apiKey: "k" } }, netErr)).data).toEqual({ ok: false, error: "代理拒绝", code: "OAW_PROXY" });

    const http401 = makeDeps({ createPiNetworkAdapter: vi.fn(() => ({ fetch: vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: { message: "bad key" } }) })), close: vi.fn() })) });
    const r401 = (await invoke("op:agent:model-configs:fetch-models", { body: { baseUrl: "https://x.com", apiKey: "k" } }, http401)).data as any;
    expect(r401).toMatchObject({ ok: false, error: "接口返回 401：bad key", code: "MODELS_FETCH_AUTH" });

    const http500 = makeDeps({ createPiNetworkAdapter: vi.fn(() => ({ fetch: vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })), close: vi.fn() })) });
    expect((((await invoke("op:agent:model-configs:fetch-models", { body: { baseUrl: "https://x.com", apiKey: "k" } }, http500)).data) as any).code).toBe("MODELS_FETCH_FAILED");

    const empty = makeDeps({ createPiNetworkAdapter: vi.fn(() => ({ fetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) })), close: vi.fn() })) });
    expect((await invoke("op:agent:model-configs:fetch-models", { body: { baseUrl: "https://x.com", apiKey: "k" } }, empty)).status).toBe(422);
  });

  test("去重 + findBuiltinModel 对账 + fetchedAt + adapter.close finally 必调", async () => {
    const close = vi.fn(() => undefined);
    const deps = makeDeps({ createPiNetworkAdapter: vi.fn(() => ({ fetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: "deepseek-chat" }, { id: "m2" }, { id: "deepseek-chat" }] }) })), close })) });
    const result = await invoke("op:agent:model-configs:fetch-models", { body: { baseUrl: "https://x.com", apiKey: "k" } }, deps);
    const data = result.data as any;
    expect(data.ids).toEqual(["deepseek-chat", "m2"]);
    expect(data.count).toBe(2);
    expect(data.models[0]).toEqual({ id: "deepseek-chat", name: "DeepSeek Chat", contextWindow: 128000, vision: true, reasoning: true, matchedProvider: "deepseek" });
    expect(data.models[1]).toEqual({ id: "m2", name: "m2", contextWindow: null, vision: null, reasoning: null, matchedProvider: null });
    expect(data.matched).toBe(1);
    expect(typeof data.fetchedAt).toBe("string");
    expect(close).toHaveBeenCalledTimes(1);
  });
});
