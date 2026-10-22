import React from "react";
import Workbench from "./workbench";

/**
 * 应用根组件（F3 批7b 起）：chat 集成面（SessionSidebar + ChatPanel + 会话/
 * 工作区/项目/模型数据流）由 Workbench 承载，原 F2 骨架壳（品牌头 + 状态行）
 * 随旧骨架退役；主题上下文由 main.tsx 的 ThemeProvider 提供。
 */
export default function App(): React.JSX.Element {
  return <Workbench />;
}
