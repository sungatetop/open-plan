import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPiNetworkAdapter } from "./pi-network-proxy.mjs";
import { AGENT_DIR, loadNetworkSettings } from "./pi-config-management.mjs";

/**
 * models.dev 供应商目录数据层（opencode 同款数据源）。
 *
 * 职责只有两件事，都不碰凭据：
 *   1. 拉取 https://models.dev/api.json 并归一化为「Pi 内置供应商快照」同形结构，
 *      供 provider-catalog.mjs 的合并层与现有导入管线直接消费；
 *   2. 把最近一次成功拉取的结果落盘缓存（server/models-dev-目录.json），
 *      离线 / 拉取失败时目录照常用缓存，不让设置界面 500。
 *
 * 归一化要点：
 *   - models.dev 的 `api` 字段存的是接口地址（相当于快照的 baseUrl），
 *     `npm` 字段才是协议归属 → 通过 NPM_API_MAP 映射为快照的 api 取值；
 *   - 模型字段防御式读取（limit.context / limit.output / attachment / reasoning），
 *     缺失一律置 null，绝不让目录渲染或导入因单个字段缺失而失败；
 *   - OAuth 元数据 models.dev 不携带，由合并层从 Pi 快照继承，这里不伪造。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_FILE = path.join(ROOT, "server", "models-dev-目录.json");
const MODELS_DEV_URL = "https://models.dev/api.json";

/** models.dev 缓存视为「过期」的阈值（超过只影响状态展示，不影响可用性）。 */
export const MODELS_DEV_STALE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * npm SDK 包 → 快照协议（provider-catalog.mjs 的 api 取值）。
 * OpenAI 兼容系统一映射 openai-completions；云平台类映射为对应协议后，
 * 由 importBlockReason 的 IMPORTABLE_APIS 白名单拦截成「手动填写」。
 */
const NPM_API_MAP = {
  "@ai-sdk/openai-compatible": "openai-completions",
  "@ai-sdk/openai": "openai-completions",
  "@openrouter/ai-sdk-provider": "openai-completions",
  "@ai-sdk/xai": "openai-completions",
  "@ai-sdk/groq": "openai-completions",
  "@ai-sdk/cerebras": "openai-completions",
  "@ai-sdk/togetherai": "openai-completions",
  "@ai-sdk/deepinfra": "openai-completions",
  "@ai-sdk/perplexity": "openai-completions",
  "@ai-sdk/cohere": "openai-completions",
  "@ai-sdk/anthropic": "anthropic-messages",
  "@ai-sdk/google": "google-generative-ai",
  "@ai-sdk/mistral": "mistral-conversations",
  // 云平台 / 特殊凭证类：不给一键导入，展示后引导手动配置。
  "@ai-sdk/amazon-bedrock": "bedrock-converse-stream",
  "@ai-sdk/google-vertex": "google-vertex",
  "@ai-sdk/google-vertex/anthropic": "google-vertex",
  "@ai-sdk/azure": "azure-openai-responses",
};

/** 未识别 npm 包的默认协议：绝大多数长尾网关都是 OpenAI 兼容端点。 */
const DEFAULT_API = "openai-completions";

function toPositiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function normalizeModel(modelId, raw) {
  if (!modelId || !raw || typeof raw !== "object") return null;
  const inputs = Array.isArray(raw?.modalities?.input) ? raw.modalities.input.filter(Boolean) : null;
  return {
    id: String(modelId),
    name: String(raw.name || modelId),
    contextWindow: toPositiveInt(raw?.limit?.context),
    maxTokens: toPositiveInt(raw?.limit?.output),
    vision: raw.attachment === true || Boolean(inputs && inputs.some((item) => item !== "text")),
    reasoning: raw.reasoning === true,
  };
}

/** 把 models.dev 的一个供应商条目归一化为快照同形结构；无可用模型时返回 null。 */
export function normalizeModelsDevProvider(id, raw) {
  const providerId = String(id || "").trim();
  if (!providerId || !raw || typeof raw !== "object") return null;
  const npm = String(raw.npm || "");
  const baseUrl = String(raw.api || "").trim().replace(/\/+$/, "");
  const models = Object.entries(raw.models && typeof raw.models === "object" ? raw.models : {})
    .map(([modelId, model]) => normalizeModel(modelId, model))
    .filter(Boolean);
  if (!models.length) return null;
  return {
    id: providerId,
    name: String(raw.name || providerId),
    api: NPM_API_MAP[npm] || DEFAULT_API,
    baseUrl,
    auth: {
      apiKey: {
        name: "API key",
        envVars: Array.isArray(raw.env) ? raw.env.map((item) => String(item)).filter(Boolean) : [],
      },
      oauth: null,
    },
    models,
    npm: npm || null,
    doc: String(raw.doc || "") || null,
  };
}

/** 拉取 models.dev 目录并归一化；网络/解析失败时抛错，由调用方决定降级。 */
export async function fetchModelsDevCatalog({ timeoutMs = 30000 } = {}) {
  // 与 pi包目录 一致：携带用户网络设置（设置面板里配置的代理 / 直连模式才会生效）。
  const adapter = createPiNetworkAdapter(loadNetworkSettings({ dir: AGENT_DIR }));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await adapter.fetch(MODELS_DEV_URL, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`models.dev 返回 HTTP ${response.status}`);
    const raw = await response.json();
    if (!raw || typeof raw !== "object") throw new Error("models.dev 响应不是对象");
    const providers = [];
    let modelCount = 0;
    for (const [id, value] of Object.entries(raw)) {
      const provider = normalizeModelsDevProvider(id, value);
      if (!provider) continue;
      providers.push(provider);
      modelCount += provider.models.length;
    }
    if (!providers.length) throw new Error("models.dev 未解析出任何供应商");
    return {
      fetchedAt: new Date().toISOString(),
      source: MODELS_DEV_URL,
      providerCount: providers.length,
      modelCount,
      providers,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 读取上次成功拉取的缓存；不存在或损坏返回 null（调用方按离线处理）。 */
export function readModelsDevCache() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    if (!parsed || !Array.isArray(parsed.providers) || !parsed.fetchedAt) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 落盘缓存：先写临时文件再 rename，避免半写导致下次启动解析失败。 */
export function writeModelsDevCache(data) {
  const tmp = `${CACHE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, CACHE_FILE);
}

/** 缓存状态：无缓存 offline；按拉取时间判断 fresh / stale。 */
export function modelsDevCacheStatus(cache = readModelsDevCache()) {
  if (!cache) return "offline";
  const fetchedAt = Date.parse(cache.fetchedAt);
  if (!Number.isFinite(fetchedAt)) return "stale";
  return Date.now() - fetchedAt <= MODELS_DEV_STALE_MS ? "fresh" : "stale";
}
