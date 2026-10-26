/**
 * Pi 配置族通道直调器（C-3，迁移期过渡形态）：op:models:list /
 * op:agent:model-configs:list/save/delete / op:agent:default-model:set /
 * op:agent:config-status / op:agent:import-preview / op:agent:import-config →
 * 进程内直调 Pi 配置域。
 *
 * 旧路径：渲染层 invoke → http-forward 转发 sidecar HTTP。本模块把 8 条通道的
 * sidecar 路由编排逐点转录为主进程内直调（行号锚点均指 server/index.mjs）：
 *   - op:models:list（L1461-1476）：模型目录 + models-store 视觉标志 enrich + 默认模型；
 *   - op:agent:model-configs:list（L1478-1480）：公开脱敏配置投影；
 *   - op:agent:model-configs:save（L1482-1522）：输入校验 → 目录补全上下文窗口 →
 *     写配置 → 凭据保存/清除 → 运行时重置 → 投影单条回显；
 *   - op:agent:model-configs:delete（L1524-1534）：删配置 + 删凭据 + 运行时重置；
 *   - op:agent:default-model:set（L1753-1764）：默认模型写入 + 运行时重置；
 *   - op:agent:config-status（L2046-2052）：配置状态；
 *   - op:agent:import-preview（L2306-2312）：本地 Pi 配置导入预览；
 *   - op:agent:import-config（L2354-2373）：预览可用性校验 404 → 配置导入 →
 *     按开关导入会话 → 清会话缓存 → 运行时重置 → 附带配置状态。
 *
 * 本地辅助转录（服务端闭包 → 本模块纯函数，行为逐行等价）：
 *   - MODEL_CONFIG_APIS（L1393-1402）+ validateModelConfigInput（L1404-1436）；
 *   - publicModelConfigs（L1438-1459）；
 *   - loadSettingsDefault（L4975-4978，经 readRuntimeSettings 投影）。
 *
 * 数据源：backend/agent/pi-config-management.ts（B6 域对拍覆盖）+ provider-auth.ts
 * （runtime seam 由生产接线绑定 piRuntimeManager 对应方法——C-2 同口径）+
 * agent-errors.ts getCredentialErrors + session-files.ts（SESSIONS_DIR 与
 * clearSessionCaches，导入会话后失效缓存）。均无 live 会话态依赖（C 层配置族口径）。
 *
 * 门控：OP_DESKTOP_AGENT_PI_CONFIG_DIRECT 且 OP_DESKTOP_AGENT_DOMAIN 双门控
 * （S4 起默认开，=0 显式回滚——流量切换评估方案 §4-S4）。本模块不 import electron（纯逻辑，
 * vitest 可直接测）；注册入口在 main/index.ts。
 */
import type { ChannelFailureData, InvokeEnvelope, InvokeResult } from "../../shared/protocol/channels";

/** Pi 配置族编排的跨域依赖（生产接线传 backend 真实模块，测试注入桩）。 */
export interface AgentPiConfigDirectDeps {
  listModelCatalog: () => Promise<any>;
  readModelsStore: () => Record<string, any>;
  readRuntimeSettings: () => Record<string, any>;
  readModelsConfig: () => Record<string, any>;
  writeModelsConfig: (value: unknown) => unknown;
  listAuth: () => Record<string, any>;
  getCredentialErrors: () => Record<string, unknown>;
  setApiKey: (provider: unknown, key: unknown) => Promise<any>;
  removeApiKey: (provider: unknown) => Promise<any>;
  resetModelRuntime: () => unknown;
  writeDefaultModel: (input: unknown) => any;
  getConfigStatus: () => unknown;
  previewLocalPiConfig: () => any;
  importLocalPiConfig: (options: unknown) => any;
  importLocalPiSessions: (options: unknown) => any;
  /** 项目会话目录（backend/agent/session-files.ts SESSIONS_DIR） */
  sessionsDir: () => string;
  /** 会话缓存失效（backend/agent/session-files.ts clearSessionCaches） */
  clearSessionCaches: () => void;
}

/** Pi 配置族直调 invoke 通道清单（与 DESKTOP_CHANNELS 对应通道一致）。 */
export const AGENT_PI_CONFIG_DIRECT_CHANNELS = [
  "op:models:list",
  "op:agent:model-configs:list",
  "op:agent:model-configs:save",
  "op:agent:model-configs:delete",
  "op:agent:default-model:set",
  "op:agent:config-status",
  "op:agent:import-preview",
  "op:agent:import-config"
] as const;

export type AgentPiConfigDirectChannel = (typeof AGENT_PI_CONFIG_DIRECT_CHANNELS)[number];

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

// ---------- 本地辅助转录（server/index.mjs 闭包 → 纯函数） ----------

/** server L1393-1402 逐行转录。 */
const MODEL_CONFIG_APIS = new Set([
  "openai-completions",
  "anthropic-messages",
  "openai-codex-responses",
  // Pi 运行时原生支持这三种协议；内置目录里 openai / google / mistral 走的就是它们，
  // 一键导入后用户再编辑该供应商时不能被协议校验挡住。
  "openai-responses",
  "google-generative-ai",
  "mistral-conversations",
]);

/** server L1404-1436 逐行转录。 */
function validateModelConfigInput(input: Record<string, any> = {}) {
  const provider = String(input.provider || "").trim();
  const baseUrl = String(input.baseUrl || "").trim().replace(/\/+$/, "");
  const api = String(input.api || "openai-completions").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(provider)) throw new Error("供应商 ID 需为 2-64 位英文、数字、点、下划线或短横线");
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error("接口地址必须以 http:// 或 https:// 开头");
  if (!MODEL_CONFIG_APIS.has(api)) throw new Error("不支持的供应商协议");
  const models = Array.isArray(input.models) ? input.models : [];
  if (!models.length) throw new Error("至少配置一个模型");
  const normalizedModels = models.slice(0, 100).map((item: any) => {
    const id = String(item?.id || "").trim();
    if (!/^[^/\\\s]{1,160}$/.test(id)) throw new Error("模型 ID 不能为空，且不能包含斜线或空格");
    const contextWindow = Number(item?.contextWindow);
    return {
      id,
      name: String(item?.name || id).trim().slice(0, 160) || id,
      ...(contextWindow > 0 ? { contextWindow: Math.floor(contextWindow) } : {}),
      reasoning: item?.reasoning !== false,
      input: item?.vision === true ? ["text", "image"] : ["text"],
      enabled: item?.enabled !== false,
    };
  });
  return {
    provider,
    name: String(input.name || provider).trim().slice(0, 160) || provider,
    api,
    baseUrl,
    enabled: input.enabled !== false,
    models: normalizedModels,
    apiKey: String(input.apiKey || "").trim(),
    clearApiKey: input.clearApiKey === true,
  };
}

/** server L1438-1459 逐行转录（公开脱敏投影，无 try/catch 忠实转录）。C-4 providerCatalogPayload 复用。 */
export function publicModelConfigs(
  deps: Pick<AgentPiConfigDirectDeps, "readModelsConfig" | "listAuth" | "getCredentialErrors">
) {
  const config = deps.readModelsConfig() || {};
  const auth = deps.listAuth() || {};
  const credentialErrors = deps.getCredentialErrors();
  return Object.entries(config.providers || {}).map(([provider, value]) => ({
    provider,
    name: (value as any)?.name || provider,
    api: (value as any)?.api || "openai-completions",
    baseUrl: (value as any)?.baseUrl || "",
    enabled: (value as any)?.enabled !== false,
    keyConfigured: Boolean((auth as any)[provider]?.key || (auth as any)[provider]?.token || (auth as any)[provider]?.secret),
    authError: (credentialErrors as any)[provider]?.message || null,
    models: (Array.isArray((value as any)?.models) ? (value as any).models : []).map((model: any) => ({
      id: model.id,
      name: model.name || model.id,
      contextWindow: Number(model.contextWindow || model.contextLength || 0) || null,
      reasoning: model.reasoning !== false,
      vision: Array.isArray(model.input) && model.input.includes("image"),
      enabled: model.enabled !== false,
    })),
  }));
}

/** server L4975-4978 逐行转录（运行时设置默认模型投影）。C-4 providerCatalogPayload 复用。 */
export function loadSettingsDefault(deps: Pick<AgentPiConfigDirectDeps, "readRuntimeSettings">): string {
  const settings = deps.readRuntimeSettings();
  return (settings.defaultProvider ? settings.defaultProvider + "/" : "") + (settings.defaultModel || "");
}

// ---------- 逐通道编排 ----------

/** GET /api/models（server L1461-1476 逐点转录）。 */
async function invokeModelsList(_payload: InvokeEnvelope, deps: AgentPiConfigDirectDeps): Promise<InvokeResult<unknown>> {
  try {
    const catalog = await deps.listModelCatalog();
    const models = catalog.models;
    // enrich vision flags from models-store.json (input includes "image")
    const store = deps.readModelsStore();
    for (const m of models) {
      const provCfg = store[m.provider];
      const cfg = provCfg?.models?.find((x: any) => x.id === String(m.id).slice(String(m.id).indexOf("/") + 1));
      if (cfg) m.vision = (cfg.input || []).includes("image") || !!m.vision;
    }
    return ok({ ...catalog, models, default: loadSettingsDefault(deps) });
  } catch (e: any) {
    return fail(500, { error: e.message });
  }
}

/** GET /api/agent/model-configs（server L1478-1480；无 try/catch 忠实转录）。 */
function invokeModelConfigsList(_payload: InvokeEnvelope, deps: AgentPiConfigDirectDeps): InvokeResult<unknown> {
  return ok({ configs: publicModelConfigs(deps) });
}

/** POST /api/agent/model-configs（server L1482-1522 逐点转录）。 */
async function invokeModelConfigsSave(payload: InvokeEnvelope, deps: AgentPiConfigDirectDeps): Promise<InvokeResult<unknown>> {
  try {
    const input = validateModelConfigInput(bodyOf(payload));
    // 模型未填上下文窗口时，从 Pi 目录按同名模型自动补全，让压缩阈值按真实窗口计算
    if (input.models.some((model: any) => !model.contextWindow)) {
      try {
        const catalog = await deps.listModelCatalog();
        const known = new Map<string, number>((catalog.models || []).map((m: any) => [String(m.id).split("/").pop(), Number(m.contextWindow || m.contextLength || 0)]));
        for (const model of input.models) {
          const key = String(model.id).split("/").pop() ?? "";
          const window = known.get(key);
          if (!model.contextWindow && known.has(key)) {
            if (window !== undefined && window > 0) model.contextWindow = window;
          }
        }
      } catch { /* 目录补全失败不阻断保存 */ }
    }
    const config = deps.readModelsConfig() || {};
    const providers = config.providers && typeof config.providers === "object" ? config.providers : {};
    const previous = providers[input.provider] && typeof providers[input.provider] === "object" ? providers[input.provider] : {};
    deps.writeModelsConfig({
      ...config,
      providers: {
        ...providers,
        [input.provider]: {
          ...previous,
          name: input.name,
          api: input.api,
          baseUrl: input.baseUrl,
          enabled: input.enabled,
          models: input.models.map(({ id, name, contextWindow, reasoning, input: modelInput, enabled }: any) => ({ id, name, api: input.api, baseUrl: input.baseUrl, ...(contextWindow ? { contextWindow } : {}), reasoning, input: modelInput, enabled })),
        },
      },
    });
    if (input.apiKey) await deps.setApiKey(input.provider, input.apiKey);
    else if (input.clearApiKey) await deps.removeApiKey(input.provider);
    deps.resetModelRuntime();
    return ok({ ok: true, config: publicModelConfigs(deps).find((item) => item.provider === input.provider) || null });
  } catch (error: any) {
    return fail(400, { ok: false, error: error.message, code: "MODEL_CONFIG_INVALID" });
  }
}

/** DELETE /api/agent/model-configs/:provider（server L1524-1534 逐点转录；无 try/catch 忠实转录）。 */
async function invokeModelConfigsDelete(payload: InvokeEnvelope, deps: AgentPiConfigDirectDeps): Promise<InvokeResult<unknown>> {
  const params = (payload.params ?? {}) as Record<string, any>;
  const provider = String(params.provider || "").trim();
  const config = deps.readModelsConfig() || {};
  const providers = config.providers && typeof config.providers === "object" ? { ...config.providers } : {};
  if (!providers[provider]) return fail(404, { ok: false, error: "供应商不存在" });
  delete providers[provider];
  deps.writeModelsConfig({ ...config, providers });
  await deps.removeApiKey(provider);
  deps.resetModelRuntime();
  return ok({ ok: true, provider });
}

/** POST /api/agent/default-model（server L1753-1764 逐点转录）。 */
function invokeDefaultModelSet(payload: InvokeEnvelope, deps: AgentPiConfigDirectDeps): InvokeResult<unknown> {
  const body = bodyOf(payload);
  const provider = String(body?.provider || "").trim();
  const model = String(body?.model || "").trim();
  if (!provider || !model) return fail(400, { ok: false, error: "provider 和 model 都需要", code: "DEFAULT_MODEL_INVALID" });
  try {
    const saved = deps.writeDefaultModel({ provider, model });
    deps.resetModelRuntime();
    return ok({ ok: true, ...saved, defaultModel: `${saved.defaultProvider}/${saved.defaultModel}` });
  } catch (error: any) {
    return fail(500, { ok: false, error: String(error?.message || error), code: "DEFAULT_MODEL_FAILED" });
  }
}

/** GET /api/agent/config-status（server L2046-2052 逐点转录）。 */
function invokeConfigStatus(_payload: InvokeEnvelope, deps: AgentPiConfigDirectDeps): InvokeResult<unknown> {
  try {
    return ok(deps.getConfigStatus());
  } catch (error: any) {
    return fail(500, { error: error.message, code: "CONFIG_STATUS_FAILED" });
  }
}

/** GET /api/agent/import-preview（server L2306-2312 逐点转录）。 */
function invokeImportPreview(_payload: InvokeEnvelope, deps: AgentPiConfigDirectDeps): InvokeResult<unknown> {
  try {
    return ok(deps.previewLocalPiConfig());
  } catch (error: any) {
    return fail(500, { error: error.message, code: "IMPORT_PREVIEW_FAILED" });
  }
}

/** POST /api/agent/import-config（server L2354-2373 逐点转录）。 */
async function invokeImportConfig(payload: InvokeEnvelope, deps: AgentPiConfigDirectDeps): Promise<InvokeResult<unknown>> {
  try {
    const body = bodyOf(payload);
    const preview = deps.previewLocalPiConfig();
    if (!preview.available) return fail(404, { ok: false, error: "未检测到可导入的本地 Pi 配置", code: "LOCAL_PI_NOT_FOUND" });
    const enabled = (name: string, fallback = true) => body?.[name] === undefined ? fallback : body[name] === true;
    const result = deps.importLocalPiConfig({
      includeModels: enabled("includeModels"),
      includeSettings: enabled("includeSettings"),
      includeCredentials: enabled("includeCredentials"),
    });
    if (!result.ok) return fail(409, result);
    const sessions = enabled("includeSessions") ? deps.importLocalPiSessions({ targetDir: deps.sessionsDir() }) : { ok: true, imported: 0, files: [] };
    deps.clearSessionCaches();
    deps.resetModelRuntime();
    return ok({ ...result, sessions, status: deps.getConfigStatus() });
  } catch (error: any) {
    return fail(500, { ok: false, error: error.message, code: "PI_IMPORT_FAILED" });
  }
}

/**
 * Pi 配置族通道直调分发：channel → 逐通道转录的 sidecar 路由编排。
 * 未知通道不进入本分发（注册面只登记 AGENT_PI_CONFIG_DIRECT_CHANNELS 清单）；
 * 处理器抛出的意外错误统一 500（对齐 http-forward 网络失败兜底形态）。
 */
export async function invokeAgentPiConfigDirect(
  channel: AgentPiConfigDirectChannel,
  envelope: InvokeEnvelope | undefined,
  deps: AgentPiConfigDirectDeps
): Promise<InvokeResult<unknown>> {
  const payload: InvokeEnvelope = envelope ?? {};
  try {
    switch (channel) {
      case "op:models:list": return await invokeModelsList(payload, deps);
      case "op:agent:model-configs:list": return invokeModelConfigsList(payload, deps);
      case "op:agent:model-configs:save": return await invokeModelConfigsSave(payload, deps);
      case "op:agent:model-configs:delete": return await invokeModelConfigsDelete(payload, deps);
      case "op:agent:default-model:set": return invokeDefaultModelSet(payload, deps);
      case "op:agent:config-status": return invokeConfigStatus(payload, deps);
      case "op:agent:import-preview": return invokeImportPreview(payload, deps);
      case "op:agent:import-config": return await invokeImportConfig(payload, deps);
    }
  } catch (error) {
    return fail(500, { error: error instanceof Error ? error.message : String(error) });
  }
  return fail(404, { error: `unknown channel: ${channel}` });
}
