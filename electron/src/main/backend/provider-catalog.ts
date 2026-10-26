/**
 * Pi 内置供应商目录（由 scripts/tools/extract-pi-provider-catalog.mjs 从 SDK bundle 固化）。
 *
 * 逐行等价迁移自 server/provider-catalog.mjs（S3-11，绞杀者分域 S3 批次，catalog 族批）。
 *
 * 这一层只做三件事，都不读凭据、不碰网络：
 *   1. 把内置目录整理成界面能直接渲染的摘要（含登录方式：账号登录 / API Key）；
 *   2. 按模型 ID 反查能力（上下文窗口、是否支持图片/思考），
 *      这样用户手填网关时不必逐个模型配能力；
 *   3. 生成"一键添加"要写入 models.json 的供应商配置（能力自动带出）。
 *
 * 路径锚定：旧侧 __dirname（server/ 源码目录）上跳一级得项目根，目录文件固定为
 * <项目根>/server/pi-builtin-providers.json（由固化脚本持续产出，物理文件不搬家，
 * 单一事实源保留）——TS 侧 PROJECT_DIR 直绑 workspace-paths（仓库根锚点，B2 收编
 * 时按打包产物统一校正层级），路径拼接与旧侧数学等价。
 * 依赖绑定：modelsDevCacheStatus/readModelsDevCache 静态直绑同批 models-dev-catalog.ts。
 * 当前消费面：旧侧 server/index.mjs L61 路由（provider-catalog 四通道）随流量切换
 * 批退役；桌面端 IPC 通道（shared/protocol/channels.ts op:agent:provider-catalog 族）
 * 已先行定义，main 侧 handler 装配属后续批次。缓存三件（catalogCache/modelIndexCache/
 * mergedCache）为模块态，invalidateMergedCatalog 与 models-dev 缓存刷新联动。
 */
import fs from "node:fs";
import path from "node:path";
import { modelsDevCacheStatus, readModelsDevCache } from "./models-dev-catalog";
import { PROJECT_DIR } from "./workspace-paths";

const CATALOG_FILE = path.join(PROJECT_DIR, "server", "pi-builtin-providers.json");

// 一键导入只支持"公开 HTTP 端点 + 单一 API Key"的协议；
// Bedrock/Vertex 走云凭证、Azure 需要资源名、Radius 走网关登录，都不在这里导入。
const IMPORTABLE_APIS = new Set([
  "openai-completions",
  "anthropic-messages",
  "openai-responses",
  "openai-codex-responses",
  "google-generative-ai",
  "mistral-conversations",
]);

const API_LABELS: Record<string, string> = {
  "openai-completions": "OpenAI 兼容",
  "anthropic-messages": "Anthropic 协议",
  "openai-responses": "OpenAI Responses",
  "openai-codex-responses": "OpenAI Codex Responses",
  "google-generative-ai": "Google Gemini 协议",
  "mistral-conversations": "Mistral 协议",
  "azure-openai-responses": "Azure OpenAI",
  "google-vertex": "Google Vertex",
  "bedrock-converse-stream": "AWS Bedrock",
  "pi-messages": "Pi 网关协议",
};

// 能力反查的优先级：第一方供应商在前，网关类在后，避免同一个模型 ID 被网关里的副本覆盖。
const FIRST_PARTY = [
  "anthropic", "openai", "openai-codex", "google", "deepseek", "xai", "mistral", "meta",
  "moonshotai", "moonshotai-cn", "kimi-coding", "minimax", "minimax-cn", "qwen-token-plan",
  "zai", "zai-coding-cn", "groq", "cerebras", "nvidia", "together", "fireworks", "baseten",
  "huggingface", "xiaomi", "ant-ling", "opencode", "opencode-go",
];

let catalogCache: any = null;
let modelIndexCache: any = null;

export function loadBuiltinCatalog(): any {
  if (catalogCache) return catalogCache;
  let parsed: any = null;
  try {
    parsed = JSON.parse(fs.readFileSync(CATALOG_FILE, "utf8"));
  } catch (error: any) {
    catalogCache = { generatedAt: null, providers: [], loginOnly: [], error: String(error?.message || error) };
    return catalogCache;
  }
  const providers = (Array.isArray(parsed?.providers) ? parsed.providers : []).map((provider: any) => ({
    id: String(provider.id || ""),
    name: String(provider.name || provider.id || ""),
    api: String(provider.api || ""),
    baseUrl: String(provider.baseUrl || ""),
    auth: {
      apiKey: provider.auth?.apiKey ? {
        name: String(provider.auth.apiKey.name || "API key"),
        envVars: Array.isArray(provider.auth.apiKey.envVars) ? provider.auth.apiKey.envVars.map(String) : [],
      } : null,
      oauth: provider.auth?.oauth ? {
        name: String(provider.auth.oauth.name || ""),
        isSubscription: provider.auth.oauth.isSubscription === true,
        loginLabel: provider.auth.oauth.loginLabel ? String(provider.auth.oauth.loginLabel) : null,
      } : null,
    },
    models: (Array.isArray(provider.models) ? provider.models : []).map((model: any) => ({
      id: String(model.id || ""),
      name: String(model.name || model.id || ""),
      contextWindow: Number(model.contextWindow) > 0 ? Math.floor(Number(model.contextWindow)) : null,
      maxTokens: Number(model.maxTokens) > 0 ? Math.floor(Number(model.maxTokens)) : null,
      vision: model.vision === true,
      reasoning: model.reasoning === true,
    })).filter((model: any) => model.id),
  })).filter((provider: any) => provider.id);
  catalogCache = {
    generatedAt: parsed?.generatedAt || null,
    loginOnly: Array.isArray(parsed?.loginOnly) ? parsed.loginOnly.map(String) : [],
    providers,
    error: null,
  };
  return catalogCache;
}

// ---------- 合并层：Pi 快照（元数据与已验证能力优先） + models.dev 目录 ----------

let mergedCache: any = null;

/** models.dev 缓存刷新后调用：清掉合并结果与模型能力索引，下次访问重建。 */
export function invalidateMergedCatalog(): void {
  mergedCache = null;
  modelIndexCache = null;
}

/**
 * 合并目录：Pi 快照为基底，models.dev 缓存补充供应商与最新模型。
 *   - 同 id 供应商：保留快照的元数据（名称/协议/登录方式/OAuth 声明）与已验证的
 *     模型能力，只补充快照缺失的模型 id；快照模型缺 contextWindow 时用 models.dev 补。
 *   - 快照外供应商：整条来自 models.dev，标记 source: "models-dev"；
 *     无 baseUrl / 占位符 / 协议不白名单的由 importBlockReason 原样拦截为手动填写。
 * models.dev 缓存不存在时直接退回快照（offline），接口不报错。
 */
export function loadMergedCatalog(): any {
  if (mergedCache) return mergedCache;
  const builtin = loadBuiltinCatalog();
  const snapshot = readModelsDevCache();
  if (!snapshot || !Array.isArray(snapshot.providers) || !snapshot.providers.length) {
    mergedCache = {
      generatedAt: builtin.generatedAt,
      loginOnly: builtin.loginOnly,
      error: builtin.error,
      providers: builtin.providers.map((provider: any) => ({ ...provider, source: "builtin" })),
      sources: {
        builtin: { generatedAt: builtin.generatedAt, count: builtin.providers.length },
        modelsDev: { fetchedAt: null, count: 0, status: modelsDevCacheStatus(null) },
      },
    };
    return mergedCache;
  }
  const byId = new Map<string, any>(builtin.providers.map((provider: any): [string, any] => [provider.id, { ...provider, source: "builtin" }]));
  for (const dev of snapshot.providers) {
    if (!dev || !dev.id) continue;
    const existing = byId.get(dev.id);
    if (!existing) {
      byId.set(dev.id, { ...dev, source: "models-dev" });
      continue;
    }
    const known = new Set(existing.models.map((model: any) => model.id));
    const additions = dev.models.filter((model: any) => !known.has(model.id));
    const devById = new Map<string, any>(dev.models.map((model: any): [string, any] => [model.id, model]));
    const patched = existing.models.map((model: any) => {
      if (model.contextWindow || !devById.has(model.id)) return model;
      const contextWindow = devById.get(model.id).contextWindow;
      return contextWindow ? { ...model, contextWindow } : model;
    });
    byId.set(dev.id, { ...existing, models: [...patched, ...additions] });
  }
  const providers = [...byId.values()];
  mergedCache = {
    generatedAt: builtin.generatedAt,
    loginOnly: builtin.loginOnly,
    error: builtin.error,
    providers,
    sources: {
      builtin: { generatedAt: builtin.generatedAt, count: builtin.providers.length },
      modelsDev: {
        fetchedAt: snapshot.fetchedAt || null,
        count: Number(snapshot.providerCount) || providers.length - builtin.providers.length,
        status: modelsDevCacheStatus(snapshot),
      },
    },
  };
  return mergedCache;
}

/** 某个内置供应商为什么不能一键导入（能导入时返回 null）。 */
function importBlockReason(provider: any): string | null {
  if (!provider.baseUrl) return "该供应商的接口地址由运行环境决定（如 Azure 需要资源名），请手动填写";
  if (/\{[^}]+\}/.test(provider.baseUrl)) return "接口地址含账号占位符（需要额外的账号 / 网关 ID），请手动填写";
  if (!IMPORTABLE_APIS.has(provider.api)) {
    return provider.api === "bedrock-converse-stream" || provider.api === "google-vertex"
      ? "使用云平台凭证（AWS / GCP）授权，不走 API Key，请用对应云平台配置"
      : `协议 ${API_LABELS[provider.api] || provider.api} 暂不支持一键导入，请手动填写`;
  }
  if (!provider.auth.apiKey && !provider.auth.oauth) return "没有可用的登录方式声明";
  return null;
}

function providerSummary(provider: any): any {
  const models = provider.models;
  const capabilities = {
    visionCount: models.filter((model: any) => model.vision).length,
    reasoningCount: models.filter((model: any) => model.reasoning).length,
    maxContext: models.reduce((max: number, model: any) => Math.max(max, model.contextWindow || 0), 0),
  };
  const blockReason = importBlockReason(provider);
  return {
    id: provider.id,
    name: provider.name,
    api: provider.api,
    apiLabel: API_LABELS[provider.api] || provider.api,
    baseUrl: provider.baseUrl,
    source: provider.source || "builtin",
    modelCount: models.length,
    auth: provider.auth,
    loginMethods: [
      ...(provider.auth.oauth ? ["oauth"] : []),
      ...(provider.auth.apiKey ? ["apiKey"] : []),
    ],
    importable: !blockReason,
    importBlockReason: blockReason,
    capabilities,
    sampleModels: models
      .slice()
      .sort((a: any, b: any) => (b.contextWindow || 0) - (a.contextWindow || 0) || a.id.localeCompare(b.id))
      .slice(0, 5)
      .map((model: any) => ({ id: model.id, name: model.name, contextWindow: model.contextWindow, vision: model.vision })),
  };
}

export function builtinProviderList(): any {
  const catalog = loadMergedCatalog();
  return {
    generatedAt: catalog.generatedAt,
    error: catalog.error || null,
    providers: catalog.providers.map(providerSummary),
    totalModels: catalog.providers.reduce((n: number, provider: any) => n + provider.models.length, 0),
    loginOnly: catalog.loginOnly,
    sources: catalog.sources,
  };
}

export function builtinProviderDetail(id: any): any {
  const catalog = loadMergedCatalog();
  const provider = catalog.providers.find((item: any) => item.id === String(id || ""));
  if (!provider) return null;
  return { ...providerSummary(provider), models: provider.models };
}

/** 模型 ID → 能力索引（精确 + 去供应商前缀），用于给手填网关的模型自动补能力。 */
function modelIndex(): Map<string, any> {
  if (modelIndexCache) return modelIndexCache;
  const catalog = loadMergedCatalog();
  const index = new Map();
  const order = [
    ...FIRST_PARTY.map((id) => catalog.providers.find((provider: any) => provider.id === id)).filter(Boolean),
    ...catalog.providers.filter((provider: any) => !FIRST_PARTY.includes(provider.id)),
  ];
  for (const provider of order) {
    for (const model of provider.models) {
      if (!index.has(model.id)) index.set(model.id, { ...model, provider: provider.id, providerName: provider.name });
    }
  }
  modelIndexCache = index;
  return index;
}

/** 按模型 ID 查内置能力；查不到返回 null。支持 "openai/gpt-4o" 这类带前缀的写法。 */
export function findBuiltinModel(modelId: any): any {
  const index = modelIndex();
  const raw = String(modelId || "").trim();
  if (!raw) return null;
  const bare = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw;
  return index.get(raw) || index.get(bare) || null;
}

/**
 * 生成写入 models.json 的供应商配置：Base URL / 协议 / 模型能力全部来自内置目录，
 * 用户只需要补一个 API Key。
 */
export function buildBuiltinImport(id: any, options: any = {}): any {
  const catalog = loadMergedCatalog();
  const provider = catalog.providers.find((item: any) => item.id === String(id || ""));
  if (!provider) throw new Error(`内置供应商不存在：${id}`);
  const blockReason = importBlockReason(provider);
  if (blockReason) throw new Error(blockReason);
  const wanted = Array.isArray(options.modelIds) && options.modelIds.length
    ? new Set(options.modelIds.map(String))
    : null;
  const models = (wanted ? provider.models.filter((model: any) => wanted.has(model.id)) : provider.models)
    .slice(0, 200)
    .map((model: any) => ({
      id: model.id,
      name: model.name || model.id,
      ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
      reasoning: model.reasoning,
      input: model.vision ? ["text", "image"] : ["text"],
      enabled: true,
    }));
  if (!models.length) throw new Error("没有可导入的模型");
  return {
    provider: provider.id,
    name: options.name ? String(options.name).slice(0, 160) : provider.name,
    api: provider.api,
    baseUrl: options.baseUrl ? String(options.baseUrl).trim().replace(/\/+$/, "") : provider.baseUrl,
    enabled: options.enabled !== false,
    models,
    auth: provider.auth,
  };
}

/** 供应商摘要里能直接给界面的登录方式文案（账号登录 / API Key）。 */
export function describeLoginMethods(provider: any): any[] {
  const methods: any[] = [];
  if (provider?.auth?.oauth) methods.push({ type: "oauth", label: provider.auth.oauth.name || "账号登录" });
  if (provider?.auth?.apiKey) methods.push({ type: "apiKey", label: provider.auth.apiKey.envVars?.[0] || provider.auth.apiKey.name || "API Key" });
  return methods;
}
