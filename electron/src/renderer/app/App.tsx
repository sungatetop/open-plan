import React, { useEffect, useState } from "react";
import { useTheme, SKINS } from "./theme";
import { fetchServerStatus, subscribeServerStatus } from "../api/ipc-client";
import type { ServerStatusPayload } from "../../shared/desktop-protocol";
import "./app.css";

/**
 * 新 UI 应用骨架（F2 范本）。
 *
 * 仅承载：品牌头部（主题/皮肤切换）+ 服务状态行 + 主区占位。
 * chat（F3）等域组件后续挂载于 <main> 占位处，不在此堆积业务。
 */
export default function App(): React.JSX.Element {
  const { theme, toggleTheme, skin, setSkin } = useTheme();
  const [status, setStatus] = useState<ServerStatusPayload | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchServerStatus().then((s) => {
      if (alive) setStatus(s);
    });
    const unsubscribe = subscribeServerStatus((s) => {
      if (alive) setStatus(s);
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  const statusText = (() => {
    switch (status?.phase) {
      case "ready":
        return `本地服务就绪（端口 ${status.port ?? "?"}）`;
      case "failed":
      case "stopped":
        return `本地服务异常：${status.message ?? "未知错误"}`;
      case "starting":
        return "本地服务启动中…";
      default:
        return "等待服务状态…";
    }
  })();

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-brand">规聚</div>
        <div className="app-header-actions">
          <select
            className="app-skin-select"
            value={skin}
            onChange={(event) => setSkin(event.target.value)}
            aria-label="选择皮肤"
          >
            {SKINS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          <button type="button" className="app-theme-toggle" onClick={toggleTheme}>
            {theme === "dark" ? "浅色" : "深色"}
          </button>
        </div>
      </header>
      <div className="app-status" role="status">
        {statusText}
      </div>
      <main className="app-main">
        <div className="app-placeholder">工作台骨架（chat 域将由 F3 挂载于此）</div>
      </main>
    </div>
  );
}
