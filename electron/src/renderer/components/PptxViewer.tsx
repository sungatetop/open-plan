/**
 * PPT 专用查看器（client/src/components/PptxViewer.jsx 逐行转录，F4-4 批次）。
 *
 * 行号锚点（L*）均指旧文件 client/src/components/PptxViewer.jsx。
 * 与旧版的全部差异（架构性等价替换，BRD-009：HTTP → IPC）：
 *   - L39 buildDocUrls / L158 readIdentityHeader 删除：raw/HTML 均改经 IPC 封装取回；
 *   - L151 fetch(urls.raw) → fetchDocRaw(name, { cwd })，base64 → atob 转字节
 *     （等价旧 res.arrayBuffer()）；
 *   - L158 响应头身份核对 → 消费 fetchDocRaw 响应自带的 identity 字段，不符仍抛
 *     previewFatal 致命错误（L160 文案原样保留）；
 *   - L164 content-length 判定大文件 → IPC 响应无该头，改为 base64 长度换算
 *     （Math.floor(base64.length * 3 / 4)）；
 *   - L166 res.body?.cancel() 删除：IPC 一次性返回，无流式 body 可取消；
 *   - L151 signal: controller.signal 删除：IPC 通道无 signal 挂点，AbortController
 *     结构保留（卸载时 abort），防串渲染由 generationRef 代际判定 + 高保真拉取前
 *     递增代际（等价旧 abort 语义）保证；
 *   - L257 iframe src={urls.html} → 先经 fetchDocHtml 拉取渲染 HTML，再以 srcDoc
 *     注入（sandbox="allow-scripts allow-same-origin"），onLoad/onError 行为原样保留；
 *   - L183 processor/presentation 内部成员 pptxviewjs 自带 d.ts 未声明：定点断言
 *     取形，运行时行为不变；无需自建类型声明文件；
 *   - 其余渲染行为、类名、DOM 结构、交互逻辑（latest-wins 渲染队列、缩放、回退、
 *     __oawPreview postMessage 身份核对）与旧组件完全一致。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as PPTXViewJS from "pptxviewjs";
import Icon from "./Icon";
import { fetchDocHtml, fetchDocRaw } from "../api/client-api";
import { makeFileIdentity, identityMatches, previewStateFromError, PREVIEW_STATE, type FileIdentity } from "../lib/file-urls";

const LARGE_PPT_BYTES = 100 * 1024 * 1024;

/** 幻灯片尺寸形（pptxviewjs d.ts 未声明 processor/presentation，定点断言用）。 */
type SlideDims = { cx?: number; cy?: number } | null | undefined;

/** 致命预览错误：携带 previewFatal 标记（对齐旧版 fatal.error 形状）。 */
interface PreviewFatalError extends Error {
  previewFatal?: boolean;
}

/** PptxViewer 入参（对齐旧组件解构签名）。 */
export interface PptxViewerProps {
  name: string;
  revision?: string | number;
  identity?: FileIdentity;
  onPreviewState?: (state: string) => void;
  onPreviewError?: (msg: string) => void;
}

/**
 * PPT 预览（D03）：
 *  - 普通文件用 pptxviewjs Canvas 渲染；超大文件或渲染失败自动切换 OfficeCLI 高保真 HTML；
 *  - 同一 viewer 同时只执行一个 renderSlide，页码/缩放请求走 latest-wins 队列，
 *    旧页晚完成不会覆盖新页；
 *  - go/jump 只设置目标页，由统一的渲染 effect 执行（不再按钮 + effect 双重渲染）；
 *  - 卸载、切文档、切实例或切渲染器时中止请求并调用真实释放接口（已核对 pptxviewjs 暴露 destroy()），
 *    同时清空 canvas backing store，避免内存滞留；
 *  - 缩放/窗口变化只重渲染，不重新加载文件。
 * 关键点是给 pptxviewjs 传入明确的 px 尺寸；传入 100% 会被库解析为 100px，导致整页内容缩成一点。
 */
export default function PptxViewer({ name, revision = 0, identity, onPreviewState, onPreviewError }: PptxViewerProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewerRef = useRef<PPTXViewJS.PPTXViewer | null>(null);
  const officeFrameRef = useRef<HTMLIFrameElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [total, setTotal] = useState(0);
  const [current, setCurrent] = useState(0);
  const [zoom, setZoom] = useState(100);
  const [renderer, setRenderer] = useState<"canvas" | "office">("canvas");
  const [largeFile, setLargeFile] = useState(false);
  const [fallbackReason, setFallbackReason] = useState("");
  const [fitWidth, setFitWidth] = useState(960);
  const [slideRatio, setSlideRatio] = useState(16 / 9);
  // 高保真 iframe 的渲染 HTML（旧版 iframe src 直连，IPC 形态改为拉取后 srcDoc 注入）。
  const [officeHtml, setOfficeHtml] = useState("");
  // 统一文件身份 + 渲染 generation：切文件后旧请求结果不得写入。
  const fileIdentity = useMemo(
    () => identity || makeFileIdentity({ relativePath: name, revision }),
    [identity, name, revision],
  );
  const generationRef = useRef(0);

  // 回调经 ref 透传：加载 effect 只依赖文件身份与渲染器，缩放/窗口变化不触发重新加载。
  const callbacksRef = useRef({ onPreviewState, onPreviewError });
  useEffect(() => { callbacksRef.current = { onPreviewState, onPreviewError }; }, [onPreviewState, onPreviewError]);

  // 高保真 iframe 也会上报带身份的就绪/失败消息；onload 本身不代表内容成功。
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event?.data as Record<string, unknown> | null;
      if (!data || data.__oawPreview !== true) return;
      if (officeFrameRef.current && event.source && event.source !== officeFrameRef.current.contentWindow) return;
      if (data.identity && !identityMatches(fileIdentity, data.identity)) {
        setError("预览内容与当前文件身份不一致，已停止展示");
        callbacksRef.current.onPreviewState?.(PREVIEW_STATE.FAILED);
        callbacksRef.current.onPreviewError?.("预览内容与当前文件身份不一致");
        return;
      }
      if (data.type === "unsupported") callbacksRef.current.onPreviewState?.(PREVIEW_STATE.UNSUPPORTED);
      else if (data.type === "error") { callbacksRef.current.onPreviewState?.(PREVIEW_STATE.FAILED); callbacksRef.current.onPreviewError?.(String(data.message || "高保真预览失败")); }
      else if (data.type === "ready") callbacksRef.current.onPreviewState?.(PREVIEW_STATE.READY);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [fileIdentity]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const update = () => setFitWidth(Math.max(320, Math.min(1440, host.clientWidth - 40)));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const canvasSize = useCallback(() => {
    const width = Math.max(320, Math.round(fitWidth * zoom / 100));
    return { width, height: Math.max(180, Math.round(width / slideRatio)) };
  }, [fitWidth, slideRatio, zoom]);
  const canvasSizeRef = useRef(canvasSize);
  canvasSizeRef.current = canvasSize;

  const applyCanvasSize = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { width, height } = canvasSizeRef.current();
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }, []);

  /** 释放 viewer：优先用库的真实释放接口（pptxviewjs 暴露 destroy），再清空引用与 canvas。 */
  const releaseViewer = useCallback(() => {
    const viewer = viewerRef.current;
    viewerRef.current = null;
    try { viewer?.destroy?.(); } catch {}
    const canvas = canvasRef.current;
    if (canvas) {
      try { canvas.width = 0; canvas.height = 0; } catch {}
      const ctx = canvas.getContext?.("2d");
      ctx?.clearRect?.(0, 0, 0, 0);
    }
  }, []);

  // latest-wins 渲染队列：同一时刻只有一个 renderSlide 在跑，旧请求在轮到自己时被跳过。
  const renderSeqRef = useRef(0);
  const renderQueueRef = useRef(Promise.resolve());
  const pendingRenderRef = useRef({ token: 0, index: -1 });

  const renderPage = useCallback((index: number) => {
    const viewer = viewerRef.current;
    if (!viewer || !canvasRef.current || index < 0) return;
    const token = ++renderSeqRef.current;
    pendingRenderRef.current = { token, index };
    renderQueueRef.current = renderQueueRef.current
      .then(async () => {
        const pending = pendingRenderRef.current;
        if (!pending || pending.token !== token) return;      // 已有更新的页码，跳过旧渲染
        if (viewerRef.current !== viewer) return;             // 已切换实例/文档
        applyCanvasSize();
        await viewer.renderSlide(index, canvasRef.current);
      })
      .catch((e) => {
        if (e?.name === "AbortError") return;
        // 浏览器渲染失败不再死路：自动切到 OfficeCLI 高保真，并把原因写给用户。
        if (viewerRef.current === viewer) {
          setFallbackReason(String(e?.message || e));
          setRenderer("office");
          setLoading(false);
          callbacksRef.current.onPreviewState?.(PREVIEW_STATE.PARTIAL);
        }
      });
  }, [applyCanvasSize]);

  useEffect(() => {
    if (renderer === "canvas" && viewerRef.current && current > 0) renderPage(current - 1);
  }, [renderer, current, fitWidth, slideRatio, zoom, renderPage]);

  useEffect(() => {
    if (renderer !== "canvas") { releaseViewer(); return undefined; }
    const generation = ++generationRef.current;
    const controller = new AbortController();
    const live = () => generation === generationRef.current;
    setLoading(true);
    setError("");
    setFallbackReason("");
    setLargeFile(false);
    releaseViewer();
    callbacksRef.current.onPreviewState?.(PREVIEW_STATE.LOADING);
    const load = async () => {
      try {
        const d = await fetchDocRaw(name, { cwd: fileIdentity.cwd || fileIdentity.workspaceId || undefined });
        // 文件身份核对：不符则拒绝渲染，避免同名跨工作区串内容。
        if (d.identity && !identityMatches(fileIdentity, d.identity)) {
          const fatal: PreviewFatalError = new Error("预览内容与打开的文件不一致（文件身份不匹配），已停止渲染");
          fatal.previewFatal = true;
          throw fatal;
        }
        // IPC 响应无 content-length：用 base64 长度换算字节数（约 3/4，padding 误差可忽略）。
        const fileSize = Math.floor(String(d.base64 || "").length * 3 / 4);
        if (fileSize > LARGE_PPT_BYTES) {
          if (live()) {
            setLargeFile(true);
            setFallbackReason(`文件约 ${(fileSize / 1024 / 1024).toFixed(0)}MB，超过浏览器渲染预算`);
            setRenderer("office");
            setLoading(false);
            // 超大文件交给 OfficeCLI 高保真预览，等待其身份消息再判定 ready。
            callbacksRef.current.onPreviewState?.(PREVIEW_STATE.PARTIAL);
          }
          return;
        }
        // base64 → 字节（等价旧 res.arrayBuffer()）。
        const bin = atob(String(d.base64 || ""));
        const data = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
        if (!live()) return;
        const viewer = new PPTXViewJS.PPTXViewer({ canvas: canvasRef.current, renderMode: "canvas", lazyLoad: true });
        await viewer.loadFile(data);
        if (!live()) { try { viewer.destroy?.(); } catch {} return; }
        viewerRef.current = viewer;
        // pptxviewjs d.ts 未声明内部 processor/presentation 成员：定点断言取形（运行时行为不变）。
        const dims = ((viewer as { processor?: { getSlideDimensions?: () => SlideDims } }).processor?.getSlideDimensions?.()
          || (viewer as { presentation?: { slideSize?: SlideDims } }).presentation?.slideSize) as SlideDims;
        const ratio = dims?.cx && dims?.cy ? dims.cx / dims.cy : 16 / 9;
        setSlideRatio(ratio);
        setTotal(viewer.getSlideCount());
        setCurrent(1);   // 由渲染 effect 执行首屏渲染（单一渲染路径）
      } catch (e) {
        if ((e as { name?: string })?.name === "AbortError" || !live()) return;
        if ((e as PreviewFatalError)?.previewFatal) {
          setError((e as Error).message);
          callbacksRef.current.onPreviewError?.((e as Error).message);
          callbacksRef.current.onPreviewState?.(previewStateFromError(e));
        } else {
          // 加载/解码失败同样回退高保真，而不是停在错误页。
          setFallbackReason(String((e as { message?: unknown })?.message || e));
          setRenderer("office");
          callbacksRef.current.onPreviewState?.(PREVIEW_STATE.PARTIAL);
        }
      } finally {
        if (live()) setLoading(false);
      }
    };
    load();
    return () => {
      controller.abort();
      releaseViewer();
    };
  }, [fileIdentity, name, renderer, releaseViewer]);

  // 高保真渲染器：旧版 iframe src 直连服务端渲染 HTML（L257）；IPC 形态改为这里经
  // fetchDocHtml 拉取后 srcDoc 注入。拉取前递增代际，使仍在途的 Canvas 加载结果失效
  // （IPC 无 signal，等价旧 AbortController.abort() 语义）。
  useEffect(() => {
    if (renderer === "canvas") return undefined;
    const generation = ++generationRef.current;
    const live = () => generation === generationRef.current;
    setOfficeHtml("");
    fetchDocHtml(name, { cwd: fileIdentity.cwd || fileIdentity.workspaceId || undefined })
      .then((d) => {
        if (!live()) return;
        setOfficeHtml(String(d.html || ""));
      })
      .catch(() => {
        if (!live()) return;
        // 对齐旧 iframe onError：提示用户切回浏览器渲染。
        setLoading(false);
        setError("OfficeCLI 高保真预览加载失败，请切回浏览器渲染");
        callbacksRef.current.onPreviewState?.(PREVIEW_STATE.FAILED);
        callbacksRef.current.onPreviewError?.("OfficeCLI 高保真预览加载失败");
      });
    return undefined;
  }, [fileIdentity, name, renderer]);

  // 页码导航只设置目标页；执行交给统一渲染 effect（不在此处直接 renderSlide）。
  const go = useCallback((dir: number) => {
    setCurrent((value) => Math.min(total, Math.max(1, value + dir)));
  }, [total]);

  const jump = useCallback((page: number) => {
    const next = Number(page) || 1;
    setCurrent(Math.min(total || next, Math.max(1, next)));
  }, [total]);

  return (
    <div className="oaw-pptx-wrap">
      <div className="oaw-pptx-toolbar">
        {renderer === "canvas" && <>
          <button className="btn-xs" onClick={() => go(-1)} disabled={current <= 1} title="上一页">‹ 上一页</button>
          <span className="oaw-pptx-count">{current} / {total}</span>
          <button className="btn-xs" onClick={() => go(1)} disabled={current >= total} title="下一页">下一页 ›</button>
          <select className="oaw-pptx-jump" value={current} onChange={(e) => jump(Number(e.target.value))} title="跳转到页">
            {Array.from({ length: total }, (_, i) => i + 1).map((n) => <option key={n} value={n}>第 {n} 页</option>)}
          </select>
          <span className="toolbar-sep" />
          <button className="btn-xs" onClick={() => setZoom((v) => Math.max(60, v - 10))} title="缩小幻灯片">−</button>
          <span className="oaw-pptx-zoom">{zoom}%</span>
          <button className="btn-xs" onClick={() => setZoom((v) => Math.min(180, v + 10))} title="放大幻灯片">＋</button>
          <button className="btn-xs" onClick={() => setZoom(100)} title="适合窗口">适合窗口</button>
        </>}
        {renderer === "canvas" ? (
          <button className="btn-xs" onClick={() => { setFallbackReason(""); setRenderer("office"); callbacksRef.current.onPreviewState?.(PREVIEW_STATE.LOADING); }} title="切换到 OfficeCLI 高保真预览">高保真预览</button>
        ) : (
          <>
            <span className="oaw-pptx-high-fidelity">OfficeCLI 高保真渲染{fallbackReason ? `（${fallbackReason}）` : "（适合超大 PPT）"}</span>
            {!largeFile && <button className="btn-xs" onClick={() => { setFallbackReason(""); setRenderer("canvas"); }} title="切换回浏览器 Canvas 渲染">浏览器渲染</button>}
          </>
        )}
        <span className="oaw-pptx-hint">{renderer === "canvas" ? "Canvas" : "HTML"}</span>
      </div>
      {loading && <div className="oaw-pptx-loading"><div className="loading-spinner"></div><div>{renderer === "office" ? "正在准备高保真预览..." : "正在渲染幻灯片..."}</div></div>}
      {error && <div className="oaw-pptx-error"><Icon name="warning" size={14} /> {error}</div>}
      <div className="oaw-pptx-host" ref={hostRef}>
        {renderer === "canvas" ? (
          <div className="oaw-pptx-stage"><canvas ref={canvasRef} /></div>
        ) : (
          <iframe
            ref={officeFrameRef}
            className="oaw-pptx-frame"
            title={`${name} 高保真预览`}
            srcDoc={officeHtml}
            sandbox="allow-scripts allow-same-origin"
            onLoad={() => { setLoading(false); callbacksRef.current.onPreviewState?.(PREVIEW_STATE.PARTIAL); }}
            onError={() => { setLoading(false); setError("OfficeCLI 高保真预览加载失败，请切回浏览器渲染"); callbacksRef.current.onPreviewState?.(PREVIEW_STATE.FAILED); callbacksRef.current.onPreviewError?.("OfficeCLI 高保真预览加载失败"); }}
          />
        )}
      </div>
    </div>
  );
}
