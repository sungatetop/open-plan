/**
 * 独立图片查看器（client/src/components/ImageViewer.jsx 逐行 TS 转录，F4-3）。
 *   - fit（适应窗口）/ 100% / 缩放，打开原图与在文件管理器中显示；
 *   - 明确 loading / ready / failed 状态，SVG 用受控展示（img 通道，不做脚本执行）。
 * 架构性等价替换：doc.url 在 HTTP 形态为 /api/doc/:name/raw 流式地址；IPC 形态由
 * 调用方（DocViewer）经 op:doc:raw base64 建 blob URL 后传入，查看器本身无感知。
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import Icon from "./Icon";
import { openInSystem, revealInSystem } from "../api/client-api";
import { PREVIEW_STATE } from "../lib/file-urls";
import { notifyError } from "./Feedback";

const IMAGE_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

export interface ImageViewerDoc {
  name?: string;
  ext?: string;
  url?: string;
  identity?: Record<string, unknown>;
  [key: string]: unknown;
}

export default function ImageViewer({ doc, onPreviewState, onPreviewError }: {
  doc: ImageViewerDoc;
  onPreviewState?: (state: string) => void;
  onPreviewError?: (message: string) => void;
}) {
  const [state, setState] = useState<string>(PREVIEW_STATE.LOADING);
  const [scale, setScale] = useState<number | "fit">("fit");
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const url = doc?.url || "";
  const generationRef = useRef(0);

  useEffect(() => {
    generationRef.current += 1;
    setState(PREVIEW_STATE.LOADING);
    setNatural(null);
    setScale("fit");
    onPreviewState?.(PREVIEW_STATE.LOADING);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, doc?.identity ? (doc.identity as Record<string, unknown>).relativePath : "", doc?.identity ? (doc.identity as Record<string, unknown>).revision : ""]);

  const markReady = useCallback((event: React.SyntheticEvent<HTMLImageElement>) => {
    const gen = generationRef.current;
    if (gen !== generationRef.current) return;
    const img = event.currentTarget;
    const size = img ? { width: img.naturalWidth, height: img.naturalHeight } : null;
    setNatural(size);
    setState(PREVIEW_STATE.READY);
    onPreviewState?.(PREVIEW_STATE.READY);
  }, [onPreviewState]);

  const markFailed = useCallback(() => {
    setState(PREVIEW_STATE.FAILED);
    onPreviewState?.(PREVIEW_STATE.FAILED);
    onPreviewError?.("图片加载失败：文件可能损坏、格式与扩展名不符，或已不可读");
  }, [onPreviewError, onPreviewState]);

  const step = useCallback((direction: number) => {
    setScale((current) => {
      const numeric = current === "fit" ? 1 : Number(current) || 1;
      const index = IMAGE_STEPS.findIndex((value) => value >= numeric - 0.0001);
      const nextIndex = Math.max(0, Math.min(IMAGE_STEPS.length - 1, (index < 0 ? IMAGE_STEPS.length - 1 : index) + direction));
      return IMAGE_STEPS[nextIndex] ?? 1;
    });
  }, []);

  const handleOpenOriginal = useCallback(() => {
    const rel = (doc?.identity as Record<string, unknown> | undefined)?.relativePath;
    if (rel) openInSystem(String(rel)).catch((error: unknown) => notifyError(`打开失败：${error instanceof Error ? error.message : String(error)}`));
  }, [doc?.identity]);

  const handleReveal = useCallback(() => {
    const rel = (doc?.identity as Record<string, unknown> | undefined)?.relativePath;
    if (rel) revealInSystem(String(rel)).catch((error: unknown) => notifyError(`在文件管理器中显示失败：${error instanceof Error ? error.message : String(error)}`));
  }, [doc?.identity]);

  return (
    <div className="image-viewer">
      <div className="image-viewer-toolbar">
        <span className="badge"><Icon name="image" size={12} /> {doc?.ext ? String(doc.ext).toUpperCase() : "图片"}</span>
        {natural && <span className="image-viewer-size">{natural.width} × {natural.height}</span>}
        <span className="image-viewer-spacer" />
        <button type="button" className={`btn-xs ${scale === "fit" ? "active" : ""}`} onClick={() => setScale("fit")} title="适应窗口">适应窗口</button>
        <button type="button" className={`btn-xs ${scale === 1 ? "active" : ""}`} onClick={() => setScale(1)} title="原始大小（100%）">100%</button>
        <button type="button" className="btn-xs" onClick={() => step(-1)} title="缩小"><Icon name="minus" size={12} /></button>
        <button type="button" className="btn-xs" onClick={() => step(1)} title="放大"><Icon name="plus" size={12} /></button>
        <button type="button" className="btn-xs" onClick={handleOpenOriginal} title="用系统默认应用打开原图"><Icon name="externalLink" size={12} /> 打开原图</button>
        <button type="button" className="btn-xs" onClick={handleReveal} title="在文件管理器中显示"><Icon name="folderOpen" size={12} /></button>
      </div>
      {state === PREVIEW_STATE.FAILED && (
        <div className="image-viewer-error" role="alert">
          <Icon name="warning" size={16} />
          <span>图片加载失败：文件可能损坏、格式与扩展名不符，或已不可读。</span>
          <button type="button" className="btn-xs" onClick={handleOpenOriginal}>用系统应用打开</button>
        </div>
      )}
      {state !== PREVIEW_STATE.FAILED && (
        <div className={`image-viewer-stage scale-${scale === "fit" ? "fit" : "fixed"}`}>
          {state === PREVIEW_STATE.LOADING && <div className="image-viewer-loading">正在加载图片…</div>}
          <img
            src={url}
            alt={doc?.name || "图片预览"}
            onLoad={markReady}
            onError={markFailed}
            style={scale === "fit" ? undefined : { width: `${Math.round(Number(scale) * 100)}%` }}
            draggable={false}
          />
        </div>
      )}
    </div>
  );
}
