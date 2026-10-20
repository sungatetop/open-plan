/**
 * 界面状态持久化（localStorage）
 * 固化：打开的文档 tabs、激活 tab、统一模块入口（知识库/模版库/地图/设置等）、
 *       当前工作区、子目录、侧栏开关、最后会话 id。
 * 刷新/重开浏览器后恢复到上次界面。
 *
 * 与 client/src/persist-ui.js 逐函数等价（tests/f1-persist-ui-parity.test.ts 对拍强制）。
 */
const KEY = "oaw_ui_state_v1";

export function loadUIState(): unknown {
  try {
    const s: unknown = JSON.parse(localStorage.getItem(KEY) as string);
    if (!s || typeof s !== "object") return null;
    return s;
  } catch {
    return null;
  }
}

export function saveUIState(state: unknown): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* localStorage 不可用时静默降级 */
  }
}

export function clearUIState(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {}
}
