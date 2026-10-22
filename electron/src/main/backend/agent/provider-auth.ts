/**
 * 供应商凭据 API（B6-6-4f，自 server/agent.mjs L4656-4682 逐行转录）。
 *
 * 旧实现闭包引用模块级单例 agentManager/piRuntimeManager（HTTP 路由域消费）；
 * electron 侧无模块级单例，改为 runtime seam 参数显式传入（B2 装配时绑定
 * AgentManager 实例与 piRuntimeManager 对应方法）。行为不变：setApiKey 运行时
 * 注入失败静默吞掉，removeApiKey 无条件重置模型运行时。
 */
import { readCredentials, writeCredentials } from "./pi-config-management";
import { clearInvalidCredential } from "./agent-errors";

/** 读取全部 provider key（掩码展示用）。 */
export function listAuth(): Record<string, any> {
  return readCredentials();
}

/** 保存/更新 provider 的 API Key（写规聚配置中的凭据文件 + 运行时注入）。 */
export async function setApiKey(provider: unknown, key: unknown, runtime: { modelRuntime(): Promise<any> }): Promise<any> {
  const auth = listAuth();
  auth[provider as string] = { type: "api_key", key: String(key).trim() };
  writeCredentials(auth);
  clearInvalidCredential(provider);
  try {
    const mr = await runtime.modelRuntime();
    await mr.setRuntimeApiKey(provider, String(key).trim(), { allowNetwork: false });
  } catch { /* 运行时注入失败不阻断保存 */ }
  return { ok: true, providers: Object.keys(auth) };
}

/** 删除 provider 的 API Key。 */
export async function removeApiKey(provider: unknown, runtime: { resetModelRuntime(): void }): Promise<any> {
  const auth = listAuth();
  if (auth[provider as string]) delete auth[provider as string];
  writeCredentials(auth);
  clearInvalidCredential(provider);
  runtime.resetModelRuntime();
  return { ok: true, providers: Object.keys(auth) };
}
