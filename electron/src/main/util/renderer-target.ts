/**
 * 渲染层目标解析（F2a）。
 *
 * OP_DESKTOP_NEW_UI=1 时新窗口加载新 UI 应用页（app.html，F3 chat 域将挂载于此）；
 * 默认（flag 未开，BRD-003 默认关）维持现状加载旧 client，功能不变。
 */
export type RendererTarget = "legacy-client" | "app";

export function resolveRendererTarget(env: NodeJS.ProcessEnv = process.env): RendererTarget {
  return env.OP_DESKTOP_NEW_UI === "1" ? "app" : "legacy-client";
}
