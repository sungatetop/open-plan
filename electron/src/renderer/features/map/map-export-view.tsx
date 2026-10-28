/**
 * G7 批量导出视图（?export=map）——client/src/components/MapExportView.jsx 逐行等价迁移（F5-7，BRD-009）。
 *
 * 旧函数名为中文标识符「地图导出视图」，TS 版按规范命名 MapExportView。
 *
 * 窗口形态（R6-3 定型）：主进程 offscreen BrowserWindow 加载本组件所在导出路由
 * （app/index.html?export=map，dev 走 vite devUrl、打包走 file:// 产物；见
 * main/export-view-window.ts），批量导出队列串行复用。旧 sidecar 导航窗口形态
 * （/?export=map 由 sidecar 服务旧 client 渲染）随 R6 退役。
 *
 * 数据面通道化（R6-3）：旧 fetch("/api/map/project") 与 stylePath("/api/map/data/:project/
 * style.json") 的 sidecar 相对路径 fetch 全部退役——项目配置走 op:map:project:get、
 * style.json 文本走 op:map:data:style（client-api mapProject/mapDataStyleText），
 * 样式内资产 URL 已由通道侧绝对化到 oaw-data://（R6-2）。IPC 每次调用现读文件，
 * 旧 `?ts=` 缓存穿透不再需要。
 *
 * 职责（单一）：
 *   1. 按查询参数渲染一张铺满视口的地图（project 必填；layers 逗号分隔白名单，空 = 全部数据图层）；
 *   2. 渲染完成后置 window.__OAW_EXPORT_READY = true，供主进程轮询；
 *   3. 失败时置 window.__OAW_EXPORT_ERROR，主进程据此让该任务失败并给出原因。
 *
 * 主进程负责：视口尺寸（setContentSize）、截图（capturePage→PNG）与 PDF（printToPDF）。
 * 本页面不做任何交互控件；标题条为 DOM 覆盖层，会一并进入截图/PDF。
 */
import { useEffect, useRef } from "react";
import { Map as MapLibreMap } from "maplibre-gl";
import type { StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { mapDataStyleText, mapProject } from "../../api/client-api";

declare global {
  interface Window {
    __OAW_EXPORT_READY?: boolean;
    __OAW_EXPORT_ERROR?: string;
  }
}

const params = new URLSearchParams(window.location.search);
const project = String(params.get("project") || "").trim();
const layerParam = String(params.get("layers") || "").trim();
const LAYER_WHITELIST: Set<string> | null = layerParam
  ? new Set(layerParam.split(/[,，;；\s]+/).map((s) => s.trim()).filter(Boolean))
  : null;
const title = String(params.get("title") || "").trim();

function markError(message: string): void {
  window.__OAW_EXPORT_ERROR = String(message);
}

export default function MapExportView() {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!project || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(project)) {
      markError(`非法项目名：${project || "(空)"}`);
      return;
    }
    if (!LAYER_WHITELIST) document.title = title || `${project} 地图导出`;

    let map: MapLibreMap | null = null;
    let cancelled = false;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

    const applyVisibility = (m: MapLibreMap): void => {
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
      let center: number[] | undefined;
      let zoom: number | undefined;
      try {
        // op:map:project:get 通道（失败/404 抛错 → catch 保底默认视野，等价旧 r.ok ? json : null）
        const cfg = await mapProject(project);
        const config = (cfg?.config ?? {}) as { center?: unknown; zoom?: unknown; name?: string };
        if (Array.isArray(config.center) && config.center.length === 2) center = config.center as number[];
        if (Number.isFinite(Number(config.zoom))) zoom = Number(config.zoom);
        if (config.name) document.title = `${config.name}${title ? ` · ${title}` : ""}`;
      } catch { /* 配置缺失时用 MapLibre 默认视野，不阻断导出 */ }

      if (cancelled || !containerRef.current) return;
      // 主进程先 open 再 setContentSize 视口；这里等视口尺寸稳定后再建图，保证画布一次就是目标尺寸
      // （避免"默认尺寸建图 → 视口调整 → 画布未跟随"的空白/裁剪图）。
      const stableViewport = async (): Promise<{ w: number; h: number }> => {
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
      // op:map:data:style 通道取 style.json 文本（404/解析失败 → 显式失败原因；
      // 旧形态靠 MapLibre 引擎内部 fetch 失败触发 error 事件，终态等价）
      let style: unknown;
      try {
        style = JSON.parse(await mapDataStyleText(project));
      } catch (e) {
        markError(`样式加载失败：${(e as { message?: unknown })?.message || e}`);
        return;
      }
      map = new MapLibreMap({
        container: containerRef.current,
        style: style as StyleSpecification,
        center: (center as [number, number]) || [120.0, 29.2],
        zoom: Number.isFinite(zoom) ? zoom : 7,
        attributionControl: false,
        interactive: false,
        fadeDuration: 0,
      });
      let readyFired = false;
      const fireReady = (): void => {
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
        applyVisibility(map!);
        map!.once("idle", fireReady);
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
