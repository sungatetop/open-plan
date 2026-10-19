import React, { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
// F4：桌面原型仅 ?prototype=desktop 可达，lazy 化后不进入主 bundle（按需 chunk 加载）。
const DesktopAgentPrototype = lazy(() => import("./components/DesktopAgentPrototype.jsx"));
// G7：批量导出视图仅 ?export=map 可达（服务端经内置浏览器打开），同样 lazy 按需加载。
const MapExportView = lazy(() => import("./components/MapExportView.jsx"));
import { ThemeProvider } from "./theme.jsx";
import "./styles.css";

// 某些第三方库会在 bundle 加载时把 window.FileReader 覆盖为自己的空壳类，
// 导致图片/附件导入的 FileReader.readAsDataURL 不可用。index.html 已保存原生引用，
// 这里恢复，并轮询防止后续懒加载 chunk 再次覆盖。
const restoreNativeFileApis = () => {
  if (window.__oawNativeFileReader && window.FileReader !== window.__oawNativeFileReader) window.FileReader = window.__oawNativeFileReader;
  if (window.__oawNativeFile && window.File !== window.__oawNativeFile) window.File = window.__oawNativeFile;
  if (window.__oawNativeBlob && window.Blob !== window.__oawNativeBlob) window.Blob = window.__oawNativeBlob;
  if (window.__oawNativeFileList && window.FileList !== window.__oawNativeFileList) window.FileList = window.__oawNativeFileList;
};
restoreNativeFileApis();
window.setInterval(restoreNativeFileApis, 1000);

const isDesktopPrototype = new URLSearchParams(window.location.search).get("prototype") === "desktop";
const isMapExportView = new URLSearchParams(window.location.search).get("export") === "map";

createRoot(document.getElementById("root")).render(
  <ThemeProvider>
    <Suspense fallback={null}>
      {isMapExportView ? <MapExportView /> : isDesktopPrototype ? <DesktopAgentPrototype /> : <App />}
    </Suspense>
  </ThemeProvider>
);
