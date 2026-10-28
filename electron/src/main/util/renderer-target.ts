/**
 * 渲染层目标解析（F2a / R6-1 门控退役）。
 *
 * R6 起新 UI 应用页（app.html）为唯一形态：主窗口与冒烟一律加载 app 页。
 * 原 OP_DESKTOP_NEW_UI 门控退役（BRD-003 默认关的历史门控，评审见 R6 执行计划）；
 * "legacy-client" 分支值保留待 R6-4 随 sidecar/legacy-server 退役一并收敛删除。
 */
export type RendererTarget = "legacy-client" | "app";

export function resolveRendererTarget(): RendererTarget {
  return "app";
}
