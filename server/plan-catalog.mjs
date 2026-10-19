import { readModelsConfig, writeModelsConfig, readCredentials, writeCredentials, ensureConfigDirectory } from "./pi-config-management.mjs";

/**
 * 内置套餐预设：订阅制/套餐制模型供应商的一键接入目录。
 * 新增套餐只需在此登记；接入后写入标准 providers + 凭据，Pi 运行时无感知。
 * planMeta 标记预设来源，便于前端区分「套餐接入」与「手填网关」。
 */
export const PLAN_PRESETS = [
  {
    planId: "opencode-zen-go",
    name: "OpenCode Zen Go",
    vendor: "opencode.ai",
    description: "OpenCode 官方模型网关：按请求计费（$20 起充、零加价），模型经编码代理场景实测调优，支持设置月度上限。",
    api: "openai-completions",
    baseUrl: "https://opencode.ai/zen/go/v1",
    authType: "api_key",
    keyUrl: "https://opencode.ai/zen",
    modelsSource: "remote",
  },
];

function planProviderId(planId) {
  return `PLAN_${String(planId).toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

function presetOf(planId) {
  return PLAN_PRESETS.find((p) => p.planId === planId) || null;
}

/** 套餐目录 + 当前接入状态（不含凭据明文）。 */
export function listPlans() {
  const config = readModelsConfig() || {};
  const credentials = readCredentials() || {};
  return PLAN_PRESETS.map((preset) => {
    const providerId = planProviderId(preset.planId);
    const provider = config.providers?.[providerId];
    const cred = credentials[providerId];
    const models = Array.isArray(provider?.models) ? provider.models : [];
    return {
      ...preset,
      providerId,
      hasKey: Boolean(cred?.key),
      connected: Boolean(provider?.enabled && cred?.key && models.length),
      modelCount: models.filter((m) => m.enabled !== false).length,
      totalModels: models.length,
    };
  });
}

/** 拉取套餐的远程模型目录（OpenAI 兼容 /models，公开接口无需鉴权）。 */
export async function fetchPlanModels(planId) {
  const preset = presetOf(planId);
  if (!preset) throw new Error("未知套餐");
  const url = `${String(preset.baseUrl).replace(/\/+$/, "")}/models`;
  const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`模型目录请求失败 HTTP ${res.status}`);
  const body = await res.json();
  const list = Array.isArray(body?.data) ? body.data : [];
  return list.map((m) => ({ id: String(m.id || ""), name: String(m.name || m.id || "") })).filter((m) => m.id);
}

/** 套餐接入：写标准 provider + 凭据（模型可指定，缺省拉全量目录）。 */
export async function applyPlan({ planId, apiKey, modelIds } = {}) {
  const preset = presetOf(planId);
  if (!preset) return { ok: false, error: "未知套餐" };
  const key = String(apiKey || "").trim();
  if (!key) return { ok: false, error: "缺少 API Key" };
  let ids = Array.isArray(modelIds) ? modelIds.map(String).filter(Boolean) : [];
  if (!ids.length) {
    try { ids = (await fetchPlanModels(planId)).map((m) => m.id); } catch { /* 拉取失败则要求显式指定 */ }
  }
  if (!ids.length) return { ok: false, error: "未获得模型目录，请先获取模型列表并勾选" };
  const models = ids.map((id) => ({ id, name: id, api: preset.api, baseUrl: preset.baseUrl, enabled: true, contextWindow: 128000, reasoning: true, input: ["text"] }));
  const config = readModelsConfig() || {};
  const providerId = planProviderId(planId);
  const providers = {
    ...(config.providers || {}),
    [providerId]: {
      name: preset.name,
      api: preset.api,
      baseUrl: preset.baseUrl,
      enabled: true,
      planMeta: { planId: preset.planId, preset: true, authType: preset.authType },
      models,
    },
  };
  writeModelsConfig({ ...config, providers });
  const credentials = readCredentials() || {};
  credentials[providerId] = { type: "api_key", key };
  ensureConfigDirectory();
  writeCredentials(credentials);
  return { ok: true, providerId, planId: preset.planId, modelCount: models.length };
}

/** 断开套餐：移除 provider 与凭据（保留其他供应商不动）。 */
export function disconnectPlan({ planId } = {}) {
  const preset = presetOf(planId);
  if (!preset) return { ok: false, error: "未知套餐" };
  const providerId = planProviderId(planId);
  const config = readModelsConfig() || {};
  if (config.providers?.[providerId]) {
    const providers = { ...config.providers };
    delete providers[providerId];
    writeModelsConfig({ ...config, providers });
  }
  const credentials = readCredentials() || {};
  if (credentials[providerId]) {
    delete credentials[providerId];
    writeCredentials(credentials);
  }
  return { ok: true, providerId };
}
