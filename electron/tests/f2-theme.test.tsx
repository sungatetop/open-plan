// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThemeProvider, useTheme, SKINS, type ThemeContextValue } from "../src/renderer/app/theme";

// R6-6c 对拍退役改写：旧侧 client/src/theme.jsx import 与 SKINS 互等随 client 退役删除
// （等价性已在 F2 批对拍验收冻结），改为 TS 侧直接锚点断言 + 行为断言。

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: ThemeContextValue | null = null;

function Probe(): null {
  latest = useTheme();
  return null;
}

function mount(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container!);
  act(() => {
    root!.render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    );
  });
}

describe("theme TS 版（F2 范本）", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-skin");
    latest = null;
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    container = null;
    root = null;
  });

  it("SKINS 常量锚点（7 皮肤，id 顺序与 label 逐项）", () => {
    expect(SKINS.map((s) => s.id)).toEqual(["proma", "glass", "default", "ocean", "forest", "sunset", "violet"]);
    expect(SKINS.map((s) => s.label)).toEqual([
      "Proma 清晰", "磨玻璃 · Open Plan", "默认（青绿）", "海洋蓝", "森林绿", "暖橙", "紫罗兰",
    ]);
  });

  it("空存储初始值：dark / default，并立即挂载 data 属性与持久化", () => {
    mount();
    expect(latest?.theme).toBe("dark");
    expect(latest?.skin).toBe("default");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.documentElement.getAttribute("data-skin")).toBe("default");
    expect(localStorage.getItem("oaw_theme")).toBe("dark");
    expect(localStorage.getItem("oaw_skin")).toBe("default");
  });

  it("已保存合法值：恢复保存的主题与皮肤", () => {
    localStorage.setItem("oaw_theme", "light");
    localStorage.setItem("oaw_skin", "ocean");
    mount();
    expect(latest?.theme).toBe("light");
    expect(latest?.skin).toBe("ocean");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.documentElement.getAttribute("data-skin")).toBe("ocean");
  });

  it("已保存非法值：回退 dark / default", () => {
    localStorage.setItem("oaw_theme", "blue");
    localStorage.setItem("oaw_skin", "not-a-skin");
    mount();
    expect(latest?.theme).toBe("dark");
    expect(latest?.skin).toBe("default");
  });

  it("toggleTheme：dark→light→dark 往返并持久化", () => {
    mount();
    act(() => latest!.toggleTheme());
    expect(latest?.theme).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem("oaw_theme")).toBe("light");
    act(() => latest!.toggleTheme());
    expect(latest?.theme).toBe("dark");
    expect(localStorage.getItem("oaw_theme")).toBe("dark");
  });

  it("setTheme 非法值忽略、合法值生效；setSkin 同口径", () => {
    mount();
    act(() => latest!.setTheme("blue"));
    expect(latest?.theme).toBe("dark");
    act(() => latest!.setTheme("light"));
    expect(latest?.theme).toBe("light");
    act(() => latest!.setSkin("glass"));
    expect(latest?.skin).toBe("glass");
    expect(document.documentElement.getAttribute("data-skin")).toBe("glass");
    act(() => latest!.setSkin("nope"));
    expect(latest?.skin).toBe("glass");
  });
});
