/**
 * agent 会话键转录（server/index.mjs L1387-1391 `agentKey` 同名转录）。
 *
 * 键格式 `${client}::${thread}`（thread 为空退化为 client），是 AgentManager
 * sessions map、runs clientId、审批记录、pending asks 等的统一会话标识。
 * S1 直推桥（agent-direct-events）、S2 B 层直调器（agent-direct-invokers）与
 * S3 prompt 编排必须共用本函数，禁止各自内联键拼接；`\u0000` 等私有分隔符
 * 仅限 IPC 桥内部簿记键（不进 manager 键空间）。
 */
export function agentKey(client: unknown, thread: unknown): string {
  const c = String(client || "").trim();
  const t = String(thread || "").trim();
  return t ? `${c}::${t}` : c;
}
