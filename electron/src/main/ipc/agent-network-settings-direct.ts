/**
 * 网络设置族通道直调器（C-5，迁移期过渡形态）：op:agent:network-settings* →
 * 进程内直调网络设置域。
 *
 * 旧路径：渲染层 invoke → http-forward 转发 sidecar HTTP（/api/agent/network-settings）。
 * 本模块把网络设置族 2 条通道的 sidecar 路由编排逐点转录为主进程内直调
 * （行号锚点均指 server/index.mjs）：
 *   - op:agent:network-settings:get（L2376-2382）：读取网络设置（脱敏投影）；
 *   - op:agent:network-settings:save（L2384-2399）：校验 mode 三值 + manual 代理
 *     地址必填（keepExistingProxy 时认可存量代理）→ 持久化 → 重载并应用到
 *     piRuntimeManager（关闭旧网络适配器）→ 响应拼接运行时诊断。
 *
 * 数据源：backend/agent/pi-config-management.ts（readNetworkSettings 脱敏投影 /
 * loadNetworkSettings 解析态 / saveNetworkSettings 持久化，B6 对拍覆盖）+
 * piRuntimeManager.updateNetworkSettings（进程内单例态）——无 live 会话态依赖，
 * 与 C 层配置族同批口径。
 *
 * 错误体形状忠实转录（http-forward 非 2xx 同形：data = 服务端 JSON 错误体）：
 *   - GET/SAVE 的 catch 分支错误体为 { error, code }（不带 ok:false，与旧路由一致）；
 *   - mode 非法（400 NETWORK_MODE_INVALID）与 manual 缺代理（400 PROXY_REQUIRED）
 *     同为 { error, code } 形状。
 *
 * 门控：OP_DESKTOP_AGENT_NETWORK_SETTINGS_DIRECT 且 OP_DESKTOP_AGENT_DOMAIN 双门控
 * （S4 起默认开，=0 显式回滚——流量切换评估方案 §4-S4）。本模块不 import electron（纯逻辑，
 * vitest 可直接测）；注册入口在 main/index.ts。
 */
import type { ChannelFailureData, InvokeEnvelope, InvokeResult } from "../../shared/protocol/channels";

/** 网络设置族编排的跨域依赖（生产接线传 backend 真实模块，测试注入桩）。 */
export interface AgentNetworkSettingsDirectDeps {
  /** 网络设置读取（backend/agent/pi-config-management.ts readNetworkSettings，脱敏投影含 hasProxy） */
  readNetworkSettings: () => unknown;
  /** 网络设置持久化（backend/agent/pi-config-management.ts saveNetworkSettings） */
  saveNetworkSettings: (value: unknown, options: { preserveProxy?: boolean }) => unknown;
  /** 网络设置解析态（backend/agent/pi-config-management.ts loadNetworkSettings） */
  loadNetworkSettings: () => Record<string, any>;
  /** 运行时应用（agent/pi-runtime.ts piRuntimeManager.updateNetworkSettings，返回网络诊断） */
  updateNetworkSettings: (settings: Record<string, any>) => unknown;
}

/** 网络设置族直调 invoke 通道清单（与 DESKTOP_CHANNELS 的 op:agent:network-settings* 一致）。 */
export const AGENT_NETWORK_SETTINGS_DIRECT_CHANNELS = [
  "op:agent:network-settings:get",
  "op:agent:network-settings:save"
] as const;

export type AgentNetworkSettingsDirectChannel = (typeof AGENT_NETWORK_SETTINGS_DIRECT_CHANNELS)[number];

const ok = (data: unknown): InvokeResult<unknown> => ({ ok: true, status: 200, data });

/** 非 2xx 信封（http-forward 非 2xx 同形：data = 服务端 JSON 错误体，含 code 等字段）。 */
const fail = (status: number, data: unknown): InvokeResult<unknown> => ({
  ok: false,
  status,
  data: data as ChannelFailureData
});

function bodyOf(payload: InvokeEnvelope): Record<string, any> {
  const body = payload.body;
  return body && typeof body === "object" ? (body as Record<string, any>) : {};
}

/** GET /api/agent/network-settings（server L2376-2382 逐点转录）。 */
function invokeNetworkSettingsGet(_payload: InvokeEnvelope, deps: AgentNetworkSettingsDirectDeps): InvokeResult<unknown> {
  try {
    return ok(deps.readNetworkSettings());
  } catch (error) {
    return fail(500, { error: (error as Error).message, code: "NETWORK_SETTINGS_READ_FAILED" });
  }
}

/** PATCH /api/agent/network-settings（server L2384-2399 逐点转录）。 */
function invokeNetworkSettingsSave(payload: InvokeEnvelope, deps: AgentNetworkSettingsDirectDeps): InvokeResult<unknown> {
  try {
    const body = bodyOf(payload);
    const mode = String(body?.mode || "").trim().toLowerCase();
    if (!["direct", "system", "manual"].includes(mode)) {
      return fail(400, { error: "连接方式必须是 direct、system 或 manual", code: "NETWORK_MODE_INVALID" });
    }
    const current = deps.readNetworkSettings() as any;
    const keepExistingProxy = body?.keepExistingProxy === true;
    if (mode === "manual" && !String(body?.proxyUrl || "").trim() && !(keepExistingProxy && current?.hasProxy)) {
      return fail(400, { error: "手动代理模式需要填写代理地址", code: "PROXY_REQUIRED" });
    }
    const saved = deps.saveNetworkSettings(body || {}, { preserveProxy: keepExistingProxy });
    const runtime = deps.updateNetworkSettings(deps.loadNetworkSettings());
    return ok({ ...(saved as any), runtime });
  } catch (error) {
    return fail(500, { error: (error as Error).message, code: "NETWORK_SETTINGS_SAVE_FAILED" });
  }
}

/** 网络设置族直调分发器（unknown channel → 404，与 http-forward catch-all 行为对齐）。 */
export async function invokeAgentNetworkSettingsDirect(
  channel: string,
  payload: InvokeEnvelope | undefined,
  deps: AgentNetworkSettingsDirectDeps
): Promise<InvokeResult<unknown>> {
  const envelope: InvokeEnvelope = payload ?? {};
  switch (channel as AgentNetworkSettingsDirectChannel) {
    case "op:agent:network-settings:get":
      return invokeNetworkSettingsGet(envelope, deps);
    case "op:agent:network-settings:save":
      return invokeNetworkSettingsSave(envelope, deps);
    default:
      return fail(404, { error: `unknown channel: ${channel}` });
  }
}
