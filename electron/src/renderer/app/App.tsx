import React from "react";
import Workbench from "./workbench";
import MapExportView from "../features/map/map-export-view";

/**
 * 应用根组件（F3 批7b 起）：chat 集成面（SessionSidebar + ChatPanel + 会话/
 * 工作区/项目/模型数据流）由 Workbench 承载，原 F2 骨架壳（品牌头 + 状态行）
 * 随旧骨架退役；主题上下文由 main.tsx 的 ThemeProvider 提供。
 *
 * R6-3 导出路由：主进程离屏 BrowserWindow 以 ?export=map 加载本页时只挂
 * MapExportView（批量导出视图，数据面走 op:map:* 通道、资产面走 oaw-data://），
 * 不挂工作台；主窗口 URL 无该参数不受影响。
 */
export default function App(): React.JSX.Element {
  if (new URLSearchParams(window.location.search).get("export") === "map") {
    return <MapExportView />;
  }
  return <Workbench />;
}
