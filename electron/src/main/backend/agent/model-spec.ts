/**
 * 本地 Pi 的模型规格族（B6-6-2，自 server/agent.mjs L702-756 逐行转录）。
 *
 * 模型来源：models-store + models.json + auth.json（读径由 pi-config-management 统一解析，B6-3 已对拍）。
 * JSON 形状动态，入参保持宽容类型；resolveInitialModel 的 modelRuntime 由调用方注入。
 */
import { readCredentials, readModelsConfig, readModelsStore, readRuntimeSettings } from "./pi-config-management";

export function localModelProviders(): Set<string> {
  const store = readModelsStore();
  const config = readModelsConfig();
  const auth = readCredentials();
  const providers = new Set<string>([
    ...Object.keys(store || {}),
    ...Object.keys(config?.providers || {}),
    ...Object.keys(auth || {}),
  ]);
  return new Set([...providers].filter((provider) => config?.providers?.[provider]?.enabled !== false && store?.[provider]?.enabled !== false));
}

/**
 * 读取 Pi 的本地动态模型目录。
 * 某些 Pi SDK 版本会因内置目录时间戳较新而忽略 models-store overlay，
 * 但 TUI 仍然会直接使用这份缓存。工作台需要与 TUI 保持同一份目录。
 */
export function localStoredModels(providers: Set<string> = localModelProviders()): any[] {
  const store = readModelsStore();
  const models: any[] = [];
  for (const [provider, entry] of Object.entries(store || {})) {
    if (!providers.has(provider) || !Array.isArray(entry?.models)) continue;
    for (const model of entry.models) {
      if (!model || typeof model !== "object" || model.enabled === false || !String(model.id || "").trim()) continue;
      models.push({ ...model, provider: model.provider || provider });
    }
  }
  return models;
}

export function configuredModelSpec(): string {
  const settings = readRuntimeSettings();
  const provider = String(settings?.defaultProvider || "").trim();
  const model = String(settings?.defaultModel || "").trim();
  return provider && model ? `${provider}/${model}` : "";
}

/** 当前会话实际在用的模型标识（provider/model）；未知时回退到备用模型记录。 */
export function currentModelSpec(entry: any): string {
  const current = entry?.session?.model;
  if (current?.provider && current?.id) return `${current.provider}/${current.id}`;
  return String(entry?.modelFallbackSpec || "");
}

export function resolveInitialModel(modelRuntime: any, requestedSpec = ""): any {
  const spec = String(requestedSpec || configuredModelSpec()).trim();
  const separator = spec.indexOf("/");
  if (separator <= 0 || separator === spec.length - 1) return null;
  const provider = spec.slice(0, separator);
  const id = spec.slice(separator + 1);
  return modelRuntime?.getModel?.(provider, id)
    || localStoredModels().find((item) => item.provider === provider && item.id === id)
    || null;
}
