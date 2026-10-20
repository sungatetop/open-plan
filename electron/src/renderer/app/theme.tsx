import React, { createContext, useContext, useEffect, useState, useCallback } from "react";

/**
 * 主题与皮肤（F2 范本，等价迁移 client/src/theme.jsx 的逻辑与常量）。
 * 持久化键与旧 client 相同（oaw_theme / oaw_skin），两形态共享用户偏好。
 * 对拍：tests/f2-theme.test.ts（常量逐项 + jsdom 行为）。
 */

const THEME_KEY = "oaw_theme";
const THEMES = ["dark", "light"] as const;
export type Theme = (typeof THEMES)[number];

export interface Skin {
  readonly id: string;
  readonly label: string;
}
const SKINS: readonly Skin[] = [
  { id: "proma", label: "Proma 清晰" },
  { id: "glass", label: "磨玻璃 · Open Plan" },
  { id: "default", label: "默认（青绿）" },
  { id: "ocean", label: "海洋蓝" },
  { id: "forest", label: "森林绿" },
  { id: "sunset", label: "暖橙" },
  { id: "violet", label: "紫罗兰" },
];

const SKIN_KEY = "oaw_skin";

export interface ThemeContextValue {
  theme: Theme;
  setTheme: (t: string) => void;
  toggleTheme: () => void;
  skin: string;
  setSkin: (s: string) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "dark",
  setTheme: () => {},
  toggleTheme: () => {},
  skin: "default",
  setSkin: () => {}
});

function readStored(key: string, valid: readonly string[], fallback: string): string {
  try {
    const saved = localStorage.getItem(key);
    return saved !== null && valid.includes(saved) ? saved : fallback;
  } catch {
    return fallback;
  }
}

function persist(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 忽略持久化失败（隐私模式等） */
  }
}

export function ThemeProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [theme, setThemeState] = useState<Theme>(() => readStored(THEME_KEY, THEMES, "dark") as Theme);
  const [skin, setSkinState] = useState<string>(() => readStored(SKIN_KEY, SKINS.map((s) => s.id), "default"));

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    persist(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.setAttribute("data-skin", skin);
    persist(SKIN_KEY, skin);
  }, [skin]);

  const setTheme = useCallback((t: string) => {
    if ((THEMES as readonly string[]).includes(t)) setThemeState(t as Theme);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((t) => (t === "dark" ? "light" : "dark"));
  }, []);

  const setSkin = useCallback((s: string) => {
    if (SKINS.some((x) => x.id === s)) setSkinState(s);
  }, []);

  return <ThemeContext.Provider value={{ theme, setTheme, toggleTheme, skin, setSkin }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
export { SKINS };
