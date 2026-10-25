/**
 * U2+U6 工作台把关扩展——装配绑定面（B2-8，等价迁移自 server/pi-extensions/workspace-guard.mjs）。
 *
 * 本批只迁移装配层消费的 isToolGateRejection（纯函数，agent.mjs tool_end 转译用）；
 * Pi 扩展工厂 workbenchGateExtension 依赖 ../run-budget.mjs（待迁域），暂留旧模块承载
 * （旧 agent.mjs additionalExtensionPaths 接线与 OAW_PI_TOOL_GATE=on 门控均走旧路径，
 * 默认路径行为不变）。run-budget 域迁移后本模块整体补齐扩展工厂并退役旧 .mjs。
 *
 * 事件语义背景：block 时 reason 以 "[工具门禁]" 前缀标记，agent.mjs 的 tool_end 转译
 * 检测该前缀发出 tool_gate_denied 事件（注册表 persist:true），前端可见"被门禁拒绝"。
 */

const GATE_MARKER = "[工具门禁]";

/** 工具执行结果是否是本扩展发出的门禁拒绝（agent.mjs tool_end 转译用）。 */
export function isToolGateRejection(text: unknown): boolean {
  return typeof text === "string" && text.includes(GATE_MARKER);
}
