/**
 * 供应商目录族通道直调器（C-4，迁移期过渡形态）：op:agent:provider-catalog* /
 * op:agent:custom-provider / op:agent:model-configs:fetch-models → 进程内直调
 * 供应商目录域。
 *
 * 旧路径：渲染层 invoke → http-forward 转发 sidecar HTTP。本模块把 6 条通道的
 * sidecar 路由编排逐点转录为主进程内直调（行号锚点均指 server/index.mjs）：
 *   - op:agent:provider-catalog（L1649-1655）：目录 + 已配置状态聚合（辅助
 *     providerCatalogPayload L1604-1647 本地转录）；
 *   - op:agent:provider-catalog:detail（L1658-1667）：单供应商完整模型清单 + 已配置投影；
 *   - op:agent:provider-catalog:import（L1671-1729）：一键导入（同名模型合并保留用户
 *     编辑）→ 凭据写入 → 可选默认模型 → 运行时重置；
 *   - op:agent:provider-catalog:refresh（L1733-1750）：models.dev 目录刷新，失败降级
 *     缓存（ok:true, fromCache:true，不 500）；
 *   - op:agent:custom-provider（L1789-1832）：自定义供应商校验 + 内置目录补全能力位 +
 *     凭据字段清理 + 运行时重置；
 *   - op:agent:model-configs:fetch-models（L1537-1598）：OpenAI 兼容 /models 拉取
 *     （AbortController 15s 超时）+ 内置目录对账（上下文窗口/图片/思考/匹配供应商）。
 *
 * 数据源：backend/provider-catalog.ts（B2 域对拍覆盖）+ models-dev-catalog.ts +
 * pi-network-proxy.ts createPiNetworkAdapter（模块级网络适配器）+ pi-config-management
 * 读写族 + provider-auth/agent-errors（凭据面，runtime seam C-2 同口径）+
 * agent-pi-config-direct 导出的 publicModelConfigs/loadSettingsDefault 转录复用
 * （C-3 同源，避免双份转录漂移）。均无 live 会话态依赖（C 层配置族口径）。
 *
 * 门控：OP_DESKTOP_AGENT_PROVIDER_CATALOG_DIRECT 且 OP_DESKTOP_AGENT_DOMAIN 双门控
 * （S4 起默认开，=0 显式回滚——流量切换评估方案 §4-S4）。本模块不 import electron（纯逻辑，
 * vitest 可直接测）；注册入口在 main/index.ts。
 */
import type { ChannelFailureData, InvokeEnvelope, InvokeResult } from "../../shared/protocol/channels";
import { loadSettingsDefault, publicModelConfigs } from "./agent-pi-config-direct";

/** 供应商目录族编排的跨域依赖（生产接线传 backend 真实模块，测试注入桩）。 */
export interface AgentProviderCatalogDirectDeps {
  /** 目录域（backend/provider-catalog.ts） */
  builtinProviderList: () => any;
  builtinProviderDetail: (id: unknown) => any;
  buildBuiltinImport: (provider: unknown, options: unknown) => any;
  findBuiltinModel: (id: unknown) => any;
  /** models.dev 目录域（backend/models-dev-catalog.ts） */
  fetchModelsDevCatalog: () => Promise<any>;
  readModelsDevCache: () => any;
  writeModelsDevCache: (data: unknown) => unknown;
  invalidateMergedCatalog: () => void;
  /** 网络适配器（backend/agent/pi-network-proxy.ts createPiNetworkAdapter） */
  createPiNetworkAdapter: () => { fetch: (url: string, init: unknown) => Promise<any>; close: () => unknown };
  /** 配置读写族（backend/agent/pi-config-management.ts） */
  readModelsConfig: () => Record<string, any>;
  writeModelsConfig: (value: unknown) => unknown;
  readRuntimeSettings: () => Record<string, any>;
  writeDefaultModel: (input: unknown) => any;
  /** 凭据面（provider-auth runtime seam C-2 同口径 + agent-errors 模块级 Map） */
  listAuth: () => Record<string, any>;
  getCredentialErrors: () => Record<string, unknown>;
  setApiKey: (provider: unknown, key: unknown) => Promise<any>;
  resetModelRuntime: () => unknown;
}

/** 供应商目录族直调 invoke 通道清单（与 DESKTOP_CHANNELS 对应通道一致）。 */
export const AGENT_PROVIDER_CATALOG_DIRECT_CHANNELS = [
  "op:agent:provider-catalog",
  "op:agent:provider-catalog:detail",
  "op:agent:provider-catalog:import",
  "op:agent:provider-catalog:refresh",
  "op:agent:custom-provider",
  "op:agent:model-configs:fetch-models"
] as const;

export type AgentProviderCatalogDirectChannel = (typeof AGENT_PROVIDER_CATALOG_DIRECT_CHANNELS)[number];

const ok = (data: unknown): InvokeResult<unknown> => ({ ok: true, status: 200, data });

/** 非 2xx 信封（http-forward 非 2xx 同形：data = 服务端 JSON 错误体）。 */
const fail = (status: number, data: unknown): InvokeResult<unknown> => ({
  ok: false,
  status,
  data: data as ChannelFailureData
});

function bodyOf(payload: InvokeEnvelope): Record<string, any> {
  const body = payload.body;
  return body && typeof body === "object" ? (body as Record<string, any>) : {};
}

// ---------- 本地辅助转录 ----------

/** server L1604-1647 逐行转录（目录 + 已配置状态聚合，复用 C-3 投影辅助）。 */
function providerCatalogPayload(deps: AgentProviderCatalogDirectDeps) {
  const list = deps.builtinProviderList();
  const configs = publicModelConfigs(deps);
  const configuredMap = new Map(configs.map((item: any) => [item.provider, item]));
  const auth = deps.listAuth() || {};
  const credentialErrors = deps.getCredentialErrors();
  const defaultModel = String(loadSettingsDefault(deps) || "");
  const defaultProvider = defaultModel.includes("/") ? defaultModel.split("/")[0] : "";
  const providers = list.providers.map((provider: any) => {
    const existing = configuredMap.get(provider.id);
    const credential = auth[provider.id] || {};
    // 账号登录（OAuth）凭据存的是 access/refresh，不是 key，判定要一起看，
    // 否则已授权的供应商会被显示成"未添加"。
    const credentialSet = Boolean(credential.key || credential.access || credential.refresh || credential.token || credential.secret);
    const keyConfigured = Boolean(existing?.keyConfigured || credentialSet);
    return {
      ...provider,
      configured: Boolean(existing) || keyConfigured,
      modelsConfigured: Boolean(existing),
      enabled: existing ? existing.enabled : null,
      keyConfigured,
      credentialType: credential.type || null,
      configuredModelCount: existing ? existing.models.length : 0,
      authError: (credentialErrors as any)[provider.id]?.message || existing?.authError || null,
      isDefault: defaultProvider === provider.id,
    };
  });
  return {
    ok: true,
    generatedAt: list.generatedAt,
    error: list.error,
    totalModels: list.totalModels,
    sources: list.sources || null,
    summary: {
      total: providers.length,
      importable: providers.filter((provider: any) => provider.importable).length,
      configured: providers.filter((provider: any) => provider.configured).length,
      oauth: providers.filter((provider: any) => provider.auth.oauth).length,
    },
    providers,
    loginOnly: list.loginOnly,
    defaultModel,
  };
}

// ---------- 逐通道编排 ----------

/** GET /api/agent/provider-catalog（server L1649-1655 逐点转录）。 */
function invokeProviderCatalog(_payload: InvokeEnvelope, deps: AgentProviderCatalogDirectDeps): InvokeResult<unknown> {
  try {
    return ok(providerCatalogPayload(deps));
  } catch (error: any) {
    return fail(500, { ok: false, error: String(error?.message || error), code: "PROVIDER_CATALOG_FAILED" });
  }
}

/** GET /api/agent/provider-catalog/:id（server L1658-1667 逐点转录）。 */
function invokeProviderCatalogDetail(payload: InvokeEnvelope, deps: AgentProviderCatalogDirectDeps): InvokeResult<unknown> {
  try {
    const params = (payload.params ?? {}) as Record<string, any>;
    const detail = deps.builtinProviderDetail(params.id);
    if (!detail) return fail(404, { ok: false, error: "内置供应商不存在", code: "PROVIDER_CATALOG_MISSING" });
    const existing = publicModelConfigs(deps).find((item: any) => item.provider === detail.id) || null;
    return ok({ ok: true, provider: detail, configured: existing });
  } catch (error: any) {
    return fail(500, { ok: false, error: String(error?.message || error), code: "PROVIDER_CATALOG_FAILED" });
  }
}

/** POST /api/agent/provider-catalog/import（server L1671-1729 逐点转录）。 */
async function invokeProviderCatalogImport(payload: InvokeEnvelope, deps: AgentProviderCatalogDirectDeps): Promise<InvokeResult<unknown>> {
  const body = bodyOf(payload);
  const provider = String(body?.provider || "").trim();
  try {
    const built = deps.buildBuiltinImport(provider, {
      modelIds: body?.modelIds,
      name: body?.name,
      baseUrl: body?.baseUrl,
      enabled: body?.enabled,
    });
    const config = deps.readModelsConfig() || {};
    const providers = config.providers && typeof config.providers === "object" ? config.providers : {};
    const previous = providers[built.provider] && typeof providers[built.provider] === "object" ? providers[built.provider] : {};
    const previousModels = Array.isArray(previous.models) ? previous.models : [];
    const merged = previousModels.map((model: any) => ({ ...model }));
    let added = 0;
    for (const model of built.models) {
      const index = merged.findIndex((item: any) => item?.id === model.id);
      if (index >= 0) {
        // 保留用户对已有模型的编辑（名称、上下文、能力开关）
        merged[index] = { ...model, ...merged[index], name: merged[index].name || model.name };
      } else {
        merged.push(model);
        added += 1;
      }
    }
    const nextProvider = {
      ...previous,
      name: built.name,
      api: built.api,
      baseUrl: built.baseUrl,
      enabled: built.enabled,
      models: merged.slice(0, 200),
    };
    delete nextProvider.apiKey;
    delete nextProvider.api_key;
    deps.writeModelsConfig({ ...config, providers: { ...providers, [built.provider]: nextProvider } });
    const apiKey = String(body?.apiKey || "").trim();
    if (apiKey) await deps.setApiKey(built.provider, apiKey);
    let defaultModel = null;
    if (body?.setDefault === true) {
      const target = String(body?.defaultModel || built.models[0].id);
      deps.writeDefaultModel({ provider: built.provider, model: target });
      defaultModel = `${built.provider}/${target}`;
    }
    deps.resetModelRuntime();
    return ok({
      ok: true,
      provider: built.provider,
      name: built.name,
      added,
      total: nextProvider.models.length,
      keyConfigured: Boolean(apiKey) || Boolean(publicModelConfigs(deps).find((item: any) => item.provider === built.provider)?.keyConfigured),
      defaultModel,
      loginMethods: built.auth,
    });
  } catch (error: any) {
    return fail(400, { ok: false, error: String(error?.message || error), code: "PROVIDER_IMPORT_FAILED" });
  }
}

/**
 * POST /api/agent/provider-catalog/refresh（server L1733-1750 逐点转录）。
 * 拉取失败时降级用上次缓存（ok:true, fromCache:true），设置界面永远可用，不 500。
 */
async function invokeProviderCatalogRefresh(_payload: InvokeEnvelope, deps: AgentProviderCatalogDirectDeps): Promise<InvokeResult<unknown>> {
  const previous = deps.readModelsDevCache();
  try {
    const data = await deps.fetchModelsDevCatalog();
    deps.writeModelsDevCache(data);
    deps.invalidateMergedCatalog();
    return ok({ ok: true, fromCache: false, fetchedAt: data.fetchedAt, providerCount: data.providerCount, modelCount: data.modelCount });
  } catch (error: any) {
    return ok({
      ok: true,
      fromCache: true,
      fetchedAt: previous?.fetchedAt || null,
      providerCount: previous?.providerCount || 0,
      modelCount: previous?.modelCount || 0,
      error: String(error?.message || error).slice(0, 200),
    });
  }
}

/** POST /api/agent/custom-provider（server L1789-1832 逐点转录）。 */
function invokeCustomProvider(payload: InvokeEnvelope, deps: AgentProviderCatalogDirectDeps): InvokeResult<unknown> {
  const body = bodyOf(payload);
  const provider = String(body?.provider || "").trim();
  const baseUrl = String(body?.baseUrl || "").trim().replace(/\/+$/, "");
  const api = String(body?.api || "openai-completions").trim();
  const modelId = String(body?.modelId || "").trim();
  const modelName = String(body?.modelName || modelId).trim() || modelId;
  const allowedApis = new Set(["openai-completions", "anthropic-messages", "openai-codex-responses"]);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(provider)) return fail(400, { ok: false, error: "供应商 ID 需为 2-64 位英文、数字、点、下划线或短横线", code: "CUSTOM_PROVIDER_INVALID" });
  if (!/^https?:\/\//i.test(baseUrl)) return fail(400, { ok: false, error: "接口地址必须以 http:// 或 https:// 开头", code: "CUSTOM_BASE_URL_INVALID" });
  if (!allowedApis.has(api)) return fail(400, { ok: false, error: "暂只支持 OpenAI Completions、Anthropic Messages 或 OpenAI Responses", code: "CUSTOM_API_INVALID" });
  if (!/^[^/\\\s]{1,160}$/.test(modelId)) return fail(400, { ok: false, error: "模型 ID 不能为空，且不能包含斜线或空格", code: "CUSTOM_MODEL_INVALID" });
  try {
    const config = deps.readModelsConfig() || {};
    const providers = config.providers && typeof config.providers === "object" ? config.providers : {};
    const previous = providers[provider] && typeof providers[provider] === "object" ? providers[provider] : {};
    const previousModels = Array.isArray(previous.models) ? previous.models : [];
    const previousModel = previousModels.find((item: any) => item?.id === modelId) || {};
    // 没填上下文窗口 / 图片能力时，去 Pi 内置目录按模型 ID 补全，避免用户逐个模型手配。
    const known = deps.findBuiltinModel(modelId);
    const requestedContext = Number(body?.contextWindow);
    const contextWindow = requestedContext > 0 ? Math.floor(requestedContext) : (known?.contextWindow || 0);
    const vision = body?.vision === true || (body?.vision === undefined && known?.vision === true);
    const model = {
      ...previousModel,
      id: modelId,
      name: modelName.slice(0, 160),
      api,
      baseUrl,
      reasoning: body?.reasoning === undefined ? (known?.reasoning ?? true) : body?.reasoning !== false,
      ...(vision ? { input: ["text", "image"] } : { input: ["text"] }),
      ...(contextWindow > 0 ? { contextWindow } : {}),
    };
    // 凭据只允许进入 auth.json；即使更新旧模型，也清理历史上可能残留的密钥字段。
    delete model.apiKey;
    delete model.api_key;
    const nextProvider = { ...previous, api, baseUrl, models: [...previousModels.filter((item: any) => item?.id !== modelId), model] };
    delete nextProvider.apiKey;
    deps.writeModelsConfig({ ...config, providers: { ...providers, [provider]: nextProvider } });
    deps.resetModelRuntime();
    return ok({ ok: true, provider, model: `${provider}/${modelId}`, modelName: model.name, api, baseUrl });
  } catch (error: any) {
    return fail(500, { ok: false, error: error.message, code: "CUSTOM_PROVIDER_SAVE_FAILED" });
  }
}

/** POST /api/agent/model-configs/fetch-models（server L1537-1598 逐点转录）。 */
async function invokeFetchModels(payload: InvokeEnvelope, deps: AgentProviderCatalogDirectDeps): Promise<InvokeResult<unknown>> {
  const body = bodyOf(payload);
  const { provider, baseUrl, apiKey } = body || {};
  let url = String(baseUrl || "").trim().replace(/\/+$/, "");
  let key = String(apiKey || "").trim();
  if (!url && provider) {
    const config = deps.readModelsConfig() || {};
    const entry = config.providers?.[provider];
    url = String(entry?.baseUrl || "").trim().replace(/\/+$/, "");
    const auth = deps.listAuth() || {};
    key = String(auth[provider]?.key || auth[provider]?.apiKey || auth[provider]?.token || "").trim();
  }
  if (!/^https?:\/\//i.test(url)) return fail(400, { ok: false, error: "接口地址必须以 http:// 或 https:// 开头", code: "MODELS_FETCH_INVALID_URL" });
  if (!key) return fail(400, { ok: false, error: "缺少 API Key：请先保存凭据，或临时填写 Key", code: "MODELS_FETCH_NO_KEY" });
  const adapter = deps.createPiNetworkAdapter();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let response: any;
    try {
      response = await adapter.fetch(`${url}/models`, {
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        signal: controller.signal,
      });
    } catch (error: any) {
      clearTimeout(timer);
      const message = String(error?.oawNetwork?.message || error?.message || error).slice(0, 300);
      const code = error?.oawNetwork?.code || "MODELS_FETCH_NETWORK";
      return fail(502, { ok: false, error: message, code });
    }
    clearTimeout(timer);
    const responseBody = await response.json().catch(() => null);
    if (!response.ok) {
      const message = String(responseBody?.error?.message || responseBody?.message || responseBody?.detail || `HTTP ${response.status}`).slice(0, 300);
      return fail(502, {
        ok: false,
        error: `接口返回 ${response.status}：${message}`,
        code: response.status === 401 || response.status === 403 ? "MODELS_FETCH_AUTH" : "MODELS_FETCH_FAILED",
      });
    }
    const ids = Array.isArray(responseBody?.data) ? responseBody.data.map((item: any) => String(item?.id || "").trim()).filter(Boolean) : [];
    if (!ids.length) return fail(422, { ok: false, error: "接口未返回模型列表（响应缺少 data[]）", code: "MODELS_FETCH_EMPTY" });
    const unique = [...new Set(ids)];
    // 拉到的模型 ID 去 Pi 内置目录里对一遍：对上的直接带出上下文窗口 / 图片 / 思考能力，
    // 前端就不用一个个手填（对不上的仍可手填）。
    const models = unique.map((id) => {
      const known = deps.findBuiltinModel(id);
      return {
        id,
        name: known?.name || id,
        contextWindow: known?.contextWindow || null,
        vision: known ? known.vision : null,
        reasoning: known ? known.reasoning : null,
        matchedProvider: known?.provider || null,
      };
    });
    return ok({ ok: true, models, ids: unique, count: unique.length, matched: models.filter((model: any) => model.matchedProvider).length, fetchedAt: new Date().toISOString() });
  } catch (error: any) {
    return fail(500, { ok: false, error: String(error?.message || error).slice(0, 300), code: "MODELS_FETCH_UNEXPECTED" });
  } finally {
    adapter.close();
  }
}

/**
 * 供应商目录族通道直调分发：channel → 逐通道转录的 sidecar 路由编排。
 * 未知通道不进入本分发（注册面只登记 AGENT_PROVIDER_CATALOG_DIRECT_CHANNELS 清单）；
 * 处理器抛出的意外错误统一 500（对齐 http-forward 网络失败兜底形态）。
 */
export async function invokeAgentProviderCatalogDirect(
  channel: AgentProviderCatalogDirectChannel,
  envelope: InvokeEnvelope | undefined,
  deps: AgentProviderCatalogDirectDeps
): Promise<InvokeResult<unknown>> {
  const payload: InvokeEnvelope = envelope ?? {};
  try {
    switch (channel) {
      case "op:agent:provider-catalog": return invokeProviderCatalog(payload, deps);
      case "op:agent:provider-catalog:detail": return invokeProviderCatalogDetail(payload, deps);
      case "op:agent:provider-catalog:import": return await invokeProviderCatalogImport(payload, deps);
      case "op:agent:provider-catalog:refresh": return await invokeProviderCatalogRefresh(payload, deps);
      case "op:agent:custom-provider": return invokeCustomProvider(payload, deps);
      case "op:agent:model-configs:fetch-models": return await invokeFetchModels(payload, deps);
    }
  } catch (error) {
    return fail(500, { error: error instanceof Error ? error.message : String(error) });
  }
  return fail(404, { error: `unknown channel: ${channel}` });
}
