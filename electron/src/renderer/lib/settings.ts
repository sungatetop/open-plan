/**
 * 全局设置存取（F3 批4 从 SettingsPanel.jsx 拆出）：
 * 持久化到 localStorage `oaw_settings`（组件通过 useSetting 读取）。
 *
 * 与 client/src/components/SettingsPanel.jsx 的 loadSettings/useSetting 逐行等价
 * （tests/f3-batch4-parity.test.tsx 对拍强制）。
 */
import { useCallback, useState } from "react";

export const SETTINGS_KEY = "oaw_settings";

export const DEFAULT_SETTINGS: Record<string, unknown> = {
  theme: null, // null = 跟随当前主题按钮
  msgFontSize: "medium", // small | medium | large
  commentHighlightMs: 20000, // 批注高亮时长
  thinkingDefaultOpen: false, // 思考块默认收起（结论优先，证据层按需展开）
  showTimeline: true, // 消息目录栏
};

export function loadSettings(): Record<string, unknown> {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function useSetting(key: string): [unknown, (next: unknown) => void] {
  const [v, setV] = useState(() => loadSettings()[key]);
  const set = useCallback((next: unknown) => {
    setV(next);
    try {
      const s = loadSettings();
      s[key] = next;
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    } catch {}
  }, [key]);
  return [v, set];
}
