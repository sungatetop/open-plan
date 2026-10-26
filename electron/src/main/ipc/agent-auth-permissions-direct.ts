/**
 * 凭据与权限族通道直调器（C-2，迁移期过渡形态）：op:agent:auth* / op:agent:permissions* →
 * 进程内直调凭据域与权限规则域。
 *
 * 旧路径：渲染层 invoke → http-forward 转发 sidecar HTTP。本模块把 5 条通道的
 * sidecar 路由编排逐点转录为主进程内直调（行号锚点均指 server/index.mjs）：
 *   - op:agent:auth:get（L1968-1976）：凭据掩码投影（maskKey L1963-1966 本地转录）+ 凭据错误表；
 *   - op:agent:auth:save（L1978-1986）：provider/key 校验 400 → setApiKey；
 *   - op:agent:auth:remove（L1988-1992）：provider 校验 400 → removeApiKey（无 try/catch，忠实转录）；
 *   - op:agent:permissions:get（L4006-4008）：listPermissionRules 原样响应（无包裹）；
 *   - op:agent:permissions:rule:remove（L4011-4014）：removeUserRule → ok?200:409。
 *
 * 数据源：backend/agent/provider-auth.ts（B6-6-4f 转录；setApiKey/removeApiKey 的
 * runtime seam 由生产接线绑定 piRuntimeManager 对应方法——旧闭包版隐式引用模块级
 * agentManager/piRuntimeManager，electron 侧显式传参，行为不变）+ agent-errors.ts
 * getCredentialErrors（invalidCredentials 模块级 Map）+ approval-policy.ts 权限规则族
 * （文件族共享态）。均无 live 会话态依赖（C 层配置族口径）。
 *
 * 门控：OP_DESKTOP_AGENT_AUTH_PERMISSIONS_DIRECT 且 OP_DESKTOP_AGENT_DOMAIN 双门控
 * （S4 起默认开，=0 显式回滚——流量切换评估方案 §4-S4）。本模块不 import electron（纯逻辑，
 * vitest 可直接测）；注册入口在 main/index.ts。
 */
import type { ChannelFailureData, InvokeEnvelope, InvokeResult } from "../../shared/protocol/channels";

/** 凭据与权限族编排的跨域依赖（生产接线传 backend 真实模块，测试注入桩）。 */
export interface AgentAuthPermissionsDirectDeps {
  /** 凭据域（backend/agent/provider-auth.ts；runtime seam 已由生产接线绑定） */
  listAuth: () => Record<string, any>;
  setApiKey: (provider: unknown, key: unknown) => Promise<any>;
  removeApiKey: (provider: unknown) => Promise<any>;
  /** 凭据错误域（backend/agent/agent-errors.ts，invalidCredentials 模块级 Map） */
  getCredentialErrors: () => Record<string, unknown>;
  /** 权限规则域（backend/agent/approval-policy.ts，permissions.json 文件族共享态） */
  listPermissionRules: () => unknown;
  removeUserRule: (rule: unknown) => any;
}

/** 凭据与权限族直调 invoke 通道清单（与 DESKTOP_CHANNELS 对应通道一致）。 */
export const AGENT_AUTH_PERMISSIONS_DIRECT_CHANNELS = [
  "op:agent:auth:get",
  "op:agent:auth:save",
  "op:agent:auth:remove",
  "op:agent:permissions:get",
  "op:agent:permissions:rule:remove"
] as const;

export type AgentAuthPermissionsDirectChannel = (typeof AGENT_AUTH_PERMISSIONS_DIRECT_CHANNELS)[number];

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

/** maskKey 转录（server/index.mjs L1963-1966 逐行）。 */
function maskKey(key: unknown): string {
  const k = String(key || "");
  return k.length <= 8 ? "****" : k.slice(0, 3) + "****" + k.slice(-4);
}

/** GET /api/agent/auth（server L1968-1976 逐点转录；无 try/catch，抛错走 dispatcher 500）。 */
function invokeAuthGet(_payload: InvokeEnvelope, deps: AgentAuthPermissionsDirectDeps): InvokeResult<unknown> {
  const auth = deps.listAuth();
  return ok({
    providers: Object.fromEntries(
      Object.entries(auth).map(([p, v]) => [p, { type: v.type, masked: maskKey(v.key), set: true }])
    ),
    authErrors: deps.getCredentialErrors()
  });
}

/** POST /api/agent/auth（server L1978-1986 逐点转录）。 */
async function invokeAuthSave(payload: InvokeEnvelope, deps: AgentAuthPermissionsDirectDeps): Promise<InvokeResult<unknown>> {
  const body = bodyOf(payload);
  const { provider, key } = body;
  if (!provider || !key) return fail(400, { error: "provider and key required" });
  try {
    return ok(await deps.setApiKey(provider, key));
  } catch (e: any) {
    return fail(500, { error: e.message });
  }
}

/** POST /api/agent/auth/remove（server L1988-1992 逐点转录；无 try/catch，忠实转录）。 */
async function invokeAuthRemove(payload: InvokeEnvelope, deps: AgentAuthPermissionsDirectDeps): Promise<InvokeResult<unknown>> {
  const body = bodyOf(payload);
  const { provider } = body;
  if (!provider) return fail(400, { error: "provider required" });
  return ok(await deps.removeApiKey(provider));
}

/** GET /api/agent/permissions（server L4006-4008 逐点转录；响应即规则表原样，无包裹）。 */
function invokePermissionsGet(_payload: InvokeEnvelope, deps: AgentAuthPermissionsDirectDeps): InvokeResult<unknown> {
  return ok(deps.listPermissionRules());
}

/** DELETE /api/agent/permissions/rule（server L4011-4014 逐点转录；ok?200:409）。 */
function invokePermissionsRuleRemove(payload: InvokeEnvelope, deps: AgentAuthPermissionsDirectDeps): InvokeResult<unknown> {
  const result = deps.removeUserRule(bodyOf(payload));
  return result?.ok ? ok(result) : fail(409, result);
}

/**
 * 凭据与权限族通道直调分发：channel → 逐通道转录的 sidecar 路由编排。
 * 未知通道不进入本分发（注册面只登记 AGENT_AUTH_PERMISSIONS_DIRECT_CHANNELS 清单）；
 * 处理器抛出的意外错误统一 500（对齐 http-forward 网络失败兜底形态）。
 */
export async function invokeAgentAuthPermissionsDirect(
  channel: AgentAuthPermissionsDirectChannel,
  envelope: InvokeEnvelope | undefined,
  deps: AgentAuthPermissionsDirectDeps
): Promise<InvokeResult<unknown>> {
  const payload: InvokeEnvelope = envelope ?? {};
  try {
    switch (channel) {
      case "op:agent:auth:get": return invokeAuthGet(payload, deps);
      case "op:agent:auth:save": return await invokeAuthSave(payload, deps);
      case "op:agent:auth:remove": return await invokeAuthRemove(payload, deps);
      case "op:agent:permissions:get": return invokePermissionsGet(payload, deps);
      case "op:agent:permissions:rule:remove": return invokePermissionsRuleRemove(payload, deps);
    }
  } catch (error) {
    return fail(500, { error: error instanceof Error ? error.message : String(error) });
  }
  return fail(404, { error: `unknown channel: ${channel}` });
}
