import React, { useEffect, useRef } from "react";
import { Map as MapLibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

/**
 * G7 批量导出视图（?export=map）——仅供服务端批量导出任务经内置浏览器打开。
 *
 * 职责（单一）：
 *   1. 按查询参数渲染一张铺满视口的地图（project 必填；layers 逗号分隔白名单，空 = 全部数据图层）；
 *   2. 渲染完成后置 window.__OAW_EXPORT_READY = true，供服务端轮询；
 *   3. 失败时置 window.__OAW_EXPORT_ERROR，服务端据此让该任务失败并给出原因。
 *
 * 服务端负责：视口尺寸（Emulation.setDeviceMetricsOverride）、截图（PNG）与 PDF（printToPDF）。
 * 本页面不做任何交互控件；标题条为 DOM 覆盖层，会一并进入截图/PDF。
 */

const params = new URLSearchParams(window.location.search);
const project = String(params.get("project") || "").trim();
const layerParam = String(params.get("layers") || "").trim();
const LAYER_WHITELIST = layerParam
  ? new Set(layerParam.split(/[,，;；\s]+/).map((s) => s.trim()).filter(Boolean))
  : null;
const title = String(params.get("title") || "").trim();

const stylePath = (p) => `/api/map/data/${p}/style.json?ts=${Date.now()}`;

function markError(message) {
  window.__OAW_EXPORT_ERROR = String(message);
}

export default function 地图导出视图() {
  const containerRef = useRef(null);

  useEffect(() => {
    if (!project || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(project)) {
      markError(`非法项目名：${project || "(空)"}`);
      return;
    }
    if (!LAYER_WHITELIST) document.title = title || `${project} 地图导出`;

    let map = null;
    let cancelled = false;
    let fallbackTimer = null;

    const applyVisibility = (m) => {
      if (!LAYER_WHITELIST) return;
      const style = m.getStyle();
      for (const layer of style.layers || []) {
        if (String(layer.id).startsWith("basemap-")) continue; // 底图保持项目配置
        const baseId = String(layer.id).replace(/-label$/, "");
        const visible = LAYER_WHITELIST.has(baseId);
        m.setLayoutProperty(layer.id, "visibility", visible ? "visible" : "none");
      }
    };

    (async () => {
      let center;
      let zoom;
      try {
        const cfg = await fetch(`/api/map/project?name=${encodeURIComponent(project)}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null));
        if (Array.isArray(cfg?.config?.center) && cfg.config.center.length === 2) center = cfg.config.center;
        if (Number.isFinite(Number(cfg?.config?.zoom))) zoom = Number(cfg.config.zoom);
        if (cfg?.config?.name) document.title = `${cfg.config.name}${title ? ` · ${title}` : ""}`;
      } catch { /* 配置缺失时用 MapLibre 默认视野，不阻断导出 */ }

      if (cancelled || !containerRef.current) return;
      // 服务端先 open 再 resize 视口；这里等视口尺寸稳定后再建图，保证画布一次就是目标尺寸
      // （避免"默认尺寸建图 → metrics override → 画布未跟随"的空白/裁剪图）。
      const stableViewport = async () => {
        let previous = { w: window.innerWidth, h: window.innerHeight };
        for (let i = 0; i < 20; i += 1) {
          await new Promise((r) => setTimeout(r, 250));
          const current = { w: window.innerWidth, h: window.innerHeight };
          if (current.w === previous.w && current.h === previous.h) return current;
          previous = current;
        }
        return previous;
      };
      const viewport = await stableViewport();
      if (cancelled || !containerRef.current) return;
      map = new MapLibreMap({
        container: containerRef.current,
        style: stylePath(project),
        center: center || [120.0, 29.2],
        zoom: Number.isFinite(zoom) ? zoom : 7,
        attributionControl: false,
        interactive: false,
        fadeDuration: 0,
      });
      let readyFired = false;
      const fireReady = () => {
        if (readyFired || cancelled) return;
        readyFired = true;
        // @page 与视口同尺寸：printToPDF(preferCSSPageSize) 产出与截图一致的单页 PDF。
        const pageStyle = document.createElement("style");
        pageStyle.textContent = `@page { size: ${window.innerWidth}px ${window.innerHeight}px; margin: 0; }`;
        document.head.appendChild(pageStyle);
        window.__OAW_EXPORT_READY = true;
      };
      map.on("error", (e) => { markError(e?.error?.message || "地图资源加载失败"); });
      map.on("load", () => {
        applyVisibility(map);
        map.once("idle", fireReady);
        // 瓦片/字形仍在加载时 idle 可能迟到：兜底 20s（服务端另有等待超时）。
        fallbackTimer = setTimeout(fireReady, 20000);
      });
    })();

    return () => {
      cancelled = true;
      if (fallbackTimer) clearTimeout(fallbackTimer);
      map?.remove?.();
      window.__OAW_EXPORT_READY = false;
      window.__OAW_EXPORT_ERROR = "";
    };
  }, []);

  return (
    <div style={{ position: "fixed", inset: 0, overflow: "hidden", background: "#fff" }}>
      {title ? (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            zIndex: 10,
            padding: "22px 0 14px",
            textAlign: "center",
            background: "rgba(255,255,255,0.92)",
            borderBottom: "1px solid #d6dce5",
            font: "bold 30px 'PingFang SC', 'Microsoft YaHei', sans-serif",
            color: "#222",
          }}
        >
          {title}
        </div>
      ) : null}
      <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />
    </div>
  );
}
