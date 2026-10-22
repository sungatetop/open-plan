/**
 * 界面状态持久化（localStorage）——App.jsx 的 loadUIState/saveUIState 逐行等价迁移。
 * 固化：当前工作区、子目录、侧栏开关、统一模块入口等。
 * 刷新/重开后恢复到上次界面（会话恢复例外：已批准规则不自动恢复旧会话，见 workbench）。
 */

const KEY = "oaw_ui_state_v1";

export interface UIState {
  [key: string]: unknown;
}

export function loadUIState(): UIState | null {
  try {
    const raw = localStorage.getItem(KEY);
    const s: unknown = raw ? JSON.parse(raw) : null;
    if (!s || typeof s !== "object") return null;
    return s as UIState;
  } catch {
    return null;
  }
}

/** 旧实现不校验入参（undefined/null 也会被 String 化写入），对拍测试覆盖该行为。 */
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
  } catch {
    /* 忽略 */
  }
}
