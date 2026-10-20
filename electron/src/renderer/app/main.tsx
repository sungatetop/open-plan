import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ThemeProvider } from "./theme";

/**
 * 新 UI 应用入口（F2）。挂载完成后在 <html> 上标记 data-app-ready="1"，
 * 供 OP_DESKTOP_NEW_UI=1 冒烟断言 React 已真实挂载。
 */
const container = document.getElementById("root");
if (!container) throw new Error("缺少 #root 挂载点");

createRoot(container).render(
  <ThemeProvider>
    <App />
  </ThemeProvider>
);

document.documentElement.setAttribute("data-app-ready", "1");
