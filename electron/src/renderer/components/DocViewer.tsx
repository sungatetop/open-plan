/**
 * 文档预览画布（client/src/components/DocViewer.jsx TS 转录，F4-3 读面 + F4-4 写面收齐）。
 *
 * 覆盖（F4-3）：外层标签栏 + 本机原生操作条 + DocContent 分发器 + 轻量查看器
 *   - kind text → MarkdownToc + MarkdownBody（md/markdown/txt/csv/json）
 *   - kind htmlfile → iframe srcDoc（HTML 文件直读）
 *   - kind html（非 docx/pptx）→ 渲染 HTML（op:doc:html）srcDoc + 身份 postMessage 核对
 *   - kind pdf / image → op:doc:raw base64 → blob URL（HTTP 形态为 raw 流式地址，
 *     架构性等价替换；blob URL 在切文件/卸载时 revoke）
 *   - 批注列表（op:doc:comments GET）+ 头部批注面板
 * 覆盖（F4-4，client/src/components/DocViewer.jsx 行号锚点）：
 *   - 专用查看器挂载：docx → DocxViewer / pptx → PptxViewer / xlsx → ExcelGrid
 *     （L601-606/L706；占位卡删除）
 *   - 标注模式（L15/L17-83/L98-104/L187-242/L276-510）：annotations 读写
 *     （op:doc:annotations GET + op:doc:annotations-save POST 防抖 800ms）、
 *     划词浮动工具条（高亮/批注/交给agent）、iframe 内 restore 包裹恢复
 *   - 实时预览（L244-269/L535-547/L583）：watch/watch-stop → fs.watchFile +
 *     op:doc-watch 事件推送重拉 HTML（IPC 形态无 officecli watch 渲染服务 URL，
 *     「agent 改文件 → 预览自动刷新」语义等价；语义差异见 main/ipc/doc-watch.ts）
 *   - CommentMarker 批注定位面板（L682-689/L783-808）+ activeComment 状态
 *   - onSendToAgent/onInsertContext 透传（L1948-1949 workbench 接线）
 *
 * 数据源：renderer/api/client-api.ts doc 族（op:doc:*，D 线直调器转录 server 路由）
 *   + lib/file-urls.ts（F1 已迁身份/地址纯函数，对拍强制勿改）。
 * 请求代际：切文件递增 generation，旧响应（即使已完成）一律丢弃，防串内容。
 */
import React, { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { openInSystem, revealInSystem, fetchDocHtml, fetchDocRaw, fetchDocComments, fetchDocAnnotations, saveDocAnnotations, fetchDocWatch, stopDocWatch } from "../api/client-api";
import { subscribeDesktopEvents } from "../api/ipc-client";
import { DOC_WATCH_EVENT_TYPE } from "../../shared/protocol/channels";
import { notifyError } from "./Feedback";
import { makeFileIdentity, identityMatches, PREVIEW_STATE, PREVIEW_STATE_LABEL, type FileIdentity } from "../lib/file-urls";
import MarkdownBody from "./MarkdownBody";
import MarkdownToc from "./MarkdownToc";
import ImageViewer, { type ImageViewerDoc } from "./ImageViewer";
import CommentMarker from "./CommentMarker";
import ExcelGrid from "./ExcelGrid";
import DocxViewer from "./DocxViewer";
import PptxViewer from "./PptxViewer";
import Icon from "./Icon";

const ICONS: Record<string, string> = { docx: "doc", xlsx: "xls", xls: "xls", pptx: "ppt", md: "md", html: "html", htm: "html", txt: "txt", pdf: "pdf", png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", bmp: "image", svg: "image", avif: "image" };
const ANNO_SAVE_DEBOUNCE = 800;

/** 划词标注记录（server .annotations/<name>.json 数组项，client DocViewer.jsx L416-422/L485-491）。 */
interface DocAnnotation {
  id?: string;
  type?: string;
  text?: string;
  note?: string;
  created?: number;
  [key: string]: unknown;
}

/** 标注浮动工具条定位（client DocViewer.jsx L103）。 */
interface AnnoToolbar {
  x: number;
  y: number;
  width?: number;
  height?: number;
  text: string;
}

/** 标注内联输入态（client DocViewer.jsx L104）。 */
interface AnnoInputState {
  mode: "comment" | "agent";
  text: string;
  value: string;
}

// 在 iframe 文档的 body 中查找首个匹配 text 的文本节点并按 wrapType 包裹
// （client DocViewer.jsx L18-54 逐行转录）
function wrapFirstTextMatch(rootDoc: Document | null, text: string, wrapType: "highlight" | "comment", note: string | null): boolean {
  if (!rootDoc || !rootDoc.body || !text) return false;
  const className = wrapType === "highlight" ? "oa-anno-hl" : "oa-anno-cm";
  const tag = wrapType === "highlight" ? "mark" : "u";
  const walker = rootDoc.createTreeWalker(rootDoc.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      if (!node.nodeValue || !node.nodeValue.includes(text)) return NodeFilter.FILTER_REJECT;
      // 已包裹则跳过（防止重复包裹）
      let p: Node | null = node.parentNode;
      while (p && p !== rootDoc.body) {
        if (p.nodeType === 1 && (p as HTMLElement).classList) {
          if ((p as HTMLElement).classList.contains("oa-anno-hl") || (p as HTMLElement).classList.contains("oa-anno-cm")) {
            return NodeFilter.FILTER_REJECT;
          }
        }
        p = p.parentNode;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const node = walker.nextNode();
  if (!node || node.nodeValue == null) return false;
  const idx = node.nodeValue.indexOf(text);
  if (idx < 0) return false;
  const range = rootDoc.createRange();
  try {
    range.setStart(node, idx);
    range.setEnd(node, idx + text.length);
    const wrap = rootDoc.createElement(tag);
    wrap.className = className;
    if (wrapType === "comment" && note) wrap.title = note;
    range.surroundContents(wrap);
    return true;
  } catch {
    return false;
  }
}

// 在 iframe load 时按 annotations 列表逐个恢复 DOM 包裹（client DocViewer.jsx L57-67）
function restoreAnnotationsInDoc(rootDoc: Document | null, annotations: DocAnnotation[]): void {
  if (!rootDoc || !rootDoc.body || !annotations || !annotations.length) return;
  for (const a of annotations) {
    if (!a || !a.text) continue;
    if (a.type === "highlight") {
      wrapFirstTextMatch(rootDoc, a.text, "highlight", null);
    } else if (a.type === "comment") {
      wrapFirstTextMatch(rootDoc, a.text, "comment", a.note || "");
    }
  }
}

// 把 range.getBoundingClientRect() 转换为 iframe 父容器 (docframe-container) 内的坐标
// （client DocViewer.jsx L70-83 逐行转录）
function selectionToContainerCoords(iframe: HTMLIFrameElement | null, range: Range): { x: number; y: number; width: number; height: number } | null {
  if (!iframe || !range) return null;
  const container = iframe.parentElement;
  if (!container) return null;
  const iframeRect = iframe.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  const r = range.getBoundingClientRect();
  return {
    x: iframeRect.left - containerRect.left + r.left,
    y: iframeRect.top - containerRect.top + (r.top - iframeRect.height > 0 ? 0 : r.top), // 选区在 iframe 视口内
    width: r.width,
    height: r.height,
  };
}

/** 预览文档记录（App.jsx open() 的 nextDoc 形状，workbench openDocFile 组装）。 */
export interface DocRecord {
  name: string;
  kind?: string;
  ext?: string;
  content?: string;
  url?: string;
  identity: FileIdentity;
  id: string;
  previewRevision?: string;
  identityVerified?: boolean;
  sheets?: unknown;
  grids?: Record<string, unknown>;
  [key: string]: unknown;
}

/** 单文件内容渲染（DocContent，client DocViewer.jsx L86-814 逐行转录）。 */
function DocContent({ doc, loading, onSendToAgent, onInsertContext }: {
  doc: DocRecord;
  loading?: boolean;
  onSendToAgent?: (text: string) => void;
  onInsertContext?: (text: string) => void;
}) {
  const [comments, setComments] = useState<Array<Record<string, unknown>>>([]);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const [activeComment, setActiveComment] = useState<unknown>(null);
  // 统一预览状态：loading | ready | partial | unsupported | failed（子查看器一致消费）
  const [previewState, setPreviewState] = useState<string>(PREVIEW_STATE.LOADING);
  const [previewErr, setPreviewErr] = useState("");

  // 实时预览（F4-4）：IPC 形态无 watchUrl，watchActive + 事件重拉（语义差异见模块头）
  const [watchActive, setWatchActive] = useState(false);
  const [watchLoading, setWatchLoading] = useState(false);
  const [watchErr, setWatchErr] = useState("");
  const [watchReloadTick, setWatchReloadTick] = useState(0);

  // 标注模式相关状态（client DocViewer.jsx L98-108）
  const [annoMode, setAnnoMode] = useState(false);
  const [annotations, setAnnotations] = useState<DocAnnotation[]>([]);
  const [annoLoaded, setAnnoLoaded] = useState(false); // 服务端 annotations 已加载
  const [iframeReady, setIframeReady] = useState(false); // iframe 已 onload
  const [annoToolbar, setAnnoToolbar] = useState<AnnoToolbar | null>(null); // {x,y,text}
  const [annoInput, setAnnoInput] = useState<AnnoInputState | null>(null); // {mode:'comment'|'agent', text, value}

  // IPC 形态的子资源（渲染 HTML / raw 字节）与请求代际
  const [docHtml, setDocHtml] = useState("");
  const [blobUrl, setBlobUrl] = useState("");
  const generationRef = useRef(0);
  const docKeyRef = useRef("");
  const docNameRef = useRef("");
  // 标注保存防抖与 iframe 就绪镜像（client DocViewer.jsx L537-560 saveAnnotations 防抖语义）
  const iframeReadyRef = useRef(false);
  const lastSavedJsonRef = useRef("[]");
  const saveTimerRef = useRef<number | null>(null);
  const identityRef = useRef<FileIdentity>(doc.identity);
  identityRef.current = doc.identity;
  docNameRef.current = doc?.name ?? "";

  // 文件身份：所有预览请求都显式带同一份 { cwd, relativePath, revision }。
  const identity = useMemo(
    () => doc?.identity || makeFileIdentity({ relativePath: doc?.name }),
    [doc?.identity, doc?.name],
  );
  const docKey = `${identity.workspaceId}::${identity.relativePath}`;
  docKeyRef.current = docKey;
  const docCwd = identity.cwd || identity.workspaceId || undefined;

  // 响应身份核对：服务端返回 identity 与当前文件不符则丢弃（防止串内容）。
  const identityOk = useCallback((serverIdentity: unknown) => {
    if (!serverIdentity) return true;
    return identityMatches(identityRef.current, serverIdentity);
  }, []);

  const isHtmlKind = doc?.kind === "html" || doc?.kind === "htmlfile";
  // DOCX/PPTX 使用各自的专用查看器；通用 HTML 工具栏对这两类文件不生效。
  const isOfficePreview = doc?.kind === "html" && (doc.ext === "docx" || doc.ext === "pptx");
  const isGenericHtml = doc?.kind === "html" && !isOfficePreview;

  // blob URL 生命周期：重建前释放旧的（切文件/卸载）。
  useEffect(() => () => {
    if (blobUrl) { try { URL.revokeObjectURL(blobUrl); } catch {} }
  }, [blobUrl]);

  // iframe 内容通过 postMessage 上报身份与就绪状态：onload 只代表页面已加载。
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event?.data as Record<string, unknown> | null;
      if (!data || (data as any).__oawPreview !== true) return;
      // 只接受来自当前预览 iframe 的消息，忽略其它来源。
      if (htmlFrameRef.current && event.source && event.source !== htmlFrameRef.current.contentWindow) return;
      // 身份不符：内容来自别的文件/工作区，直接判定失败，不展示。
      if (data.identity && !identityMatches(identityRef.current, data.identity)) {
        setPreviewState(PREVIEW_STATE.FAILED);
        setPreviewErr("预览内容与当前文件身份不一致，已停止展示");
        return;
      }
      if (data.type === "unsupported") { setPreviewState(PREVIEW_STATE.UNSUPPORTED); setPreviewErr(""); }
      else if (data.type === "error") { setPreviewState(PREVIEW_STATE.FAILED); setPreviewErr(String(data.message || "预览渲染失败")); }
      else if (data.type === "ready") { setPreviewState(PREVIEW_STATE.READY); setPreviewErr(""); }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [docKey]);

  const fetchComments = useCallback(async () => {
    if (!doc) return;
    const gen = generationRef.current;
    const key = docKeyRef.current;
    setCommentsLoading(true);
    try {
      const d = await fetchDocComments(doc.name, { cwd: identityRef.current.cwd || identityRef.current.workspaceId });
      if (gen !== generationRef.current || key !== docKeyRef.current) return;
      if (!identityOk(d?.identity)) {
        setPreviewState(PREVIEW_STATE.FAILED);
        setPreviewErr("批注响应与当前文件身份不一致，已丢弃");
        return;
      }
      setComments((d.comments || []) as Array<Record<string, unknown>>);
    } catch (e) {
      console.error("获取批注失败:", e);
    } finally {
      if (gen === generationRef.current && key === docKeyRef.current) setCommentsLoading(false);
    }
  }, [doc, identityOk]);

  // 实时预览 watch 生命周期：停止当前文件的 watch（静默；watchActiveRef 防重复）。
  const watchActiveRef = useRef(false);
  const watchTargetRef = useRef<{ name: string; cwd?: string } | null>(null);
  const stopWatchQuiet = useCallback(() => {
    if (!watchActiveRef.current) return;
    watchActiveRef.current = false;
    const target = watchTargetRef.current;
    watchTargetRef.current = null;
    if (target?.name) {
      stopDocWatch(target.name, { cwd: target.cwd }).catch(() => {});
    }
  }, []);

  // 切换/打开文件时重置状态（标注/实时预览随 F4-4 重置面补齐，client DocViewer.jsx L187-242）
  useEffect(() => {
    // 进入新文件：递增 generation，旧请求结果不得写入。
    generationRef.current += 1;
    // 实时预览：切文件即停 watch（client DocViewer.jsx setWatchUrl(null) 语义 + 服务端进程回收）
    stopWatchQuiet();
    setWatchActive(false);
    setWatchLoading(false);
    setWatchErr("");
    setWatchReloadTick(0);
    // text / xlsx / htmlfile 的内容已随 open 响应返回并经身份核对，可直接 ready；
    // 其余格式（docx/pptx/pdf/html）还要经过渲染或子资源加载，先置 loading。
    const localReady = doc?.kind === "text" || doc?.kind === "xlsx" || doc?.kind === "htmlfile";
    setPreviewState(localReady ? PREVIEW_STATE.READY : PREVIEW_STATE.LOADING);
    setPreviewErr("");
    setComments([]);
    setDocHtml("");
    if (blobUrl) { try { URL.revokeObjectURL(blobUrl); } catch {} }
    setBlobUrl("");
    // 标注状态重置（client DocViewer.jsx L203-211）
    setAnnoMode(false);
    setAnnoToolbar(null);
    setAnnoInput(null);
    setAnnoLoaded(false);
    setIframeReady(false);
    iframeReadyRef.current = false;
    lastSavedJsonRef.current = "[]";
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    // DOCX/PPTX 由专用查看器自己读取批注/原始文件；这里不要再触发一轮
    // OfficeCLI 查询，否则每次点击 Word 预览都会重复启动一次读取进程。
    if (isGenericHtml || doc?.kind === "text") {
      fetchComments();
    }
    // 标注读取：仅 html/htmlfile（非 docx/pptx 专用查看器）走服务端 annotations
    if (isHtmlKind && !isOfficePreview) {
      const gen = generationRef.current;
      const key = docKeyRef.current;
      fetchDocAnnotations(doc.name, { cwd: docCwd })
        .then((d) => {
          if (gen !== generationRef.current || key !== docKeyRef.current) return;
          if (!identityOk(d?.identity)) {
            setPreviewState(PREVIEW_STATE.FAILED);
            setPreviewErr("标注响应与当前文件身份不一致，已丢弃");
            return;
          }
          const list = (d.annotations || []) as DocAnnotation[];
          setAnnotations(list);
          setAnnoLoaded(true);
          lastSavedJsonRef.current = JSON.stringify(list);
        })
        .catch((e) => console.error("加载标注失败:", e));
    } else {
      setAnnotations([]);
      setAnnoLoaded(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey, doc?.kind]);

  // 卸载兜底：停 watch（切文件路径已由上方 effect 承担）
  useEffect(() => () => { stopWatchQuiet(); }, [stopWatchQuiet]);

  // kind html（非 docx/pptx）：拉取渲染 HTML（含身份注入消息），srcDoc 呈现。
  // watchReloadTick：实时预览变化事件 → 重拉（agent 改文件 → 预览自动刷新）。
  useEffect(() => {
    if (!isGenericHtml) return;
    const gen = generationRef.current;
    const key = docKeyRef.current;
    let cancelled = false;
    fetchDocHtml(doc.name, { cwd: identityRef.current.cwd || identityRef.current.workspaceId })
      .then((d) => {
        if (cancelled || gen !== generationRef.current || key !== docKeyRef.current) return;
        if (!identityOk(d?.identity)) {
          setPreviewState(PREVIEW_STATE.FAILED);
          setPreviewErr("预览响应与当前文件身份不一致，已丢弃");
          return;
        }
        setDocHtml(String(d.html || ""));
      })
      .catch((e) => {
        if (cancelled || gen !== generationRef.current || key !== docKeyRef.current) return;
        setPreviewState(PREVIEW_STATE.FAILED);
        setPreviewErr(`预览渲染失败：${e?.message || e}`);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey, isGenericHtml, watchReloadTick]);

  // 实时预览事件订阅：op:doc-watch 命中当前文件 → 重拉渲染 HTML（F4-4）
  useEffect(() => {
    if (!watchActive || !isGenericHtml) return undefined;
    return subscribeDesktopEvents((event) => {
      if (event.type !== DOC_WATCH_EVENT_TYPE) return;
      const files = (event.data as { files?: unknown } | undefined)?.files;
      if (Array.isArray(files) && files.some((f) => String(f) === doc.name)) {
        setWatchReloadTick((t) => t + 1);
      }
    });
  }, [watchActive, isGenericHtml, doc?.name]);

  // 开启实时预览（client DocViewer.jsx L244-263 startLive 转录；IPC 无 watchUrl）
  const startLive = useCallback(async () => {
    if (!doc) return;
    const gen = generationRef.current;
    const key = docKeyRef.current;
    setWatchLoading(true);
    setWatchErr("");
    try {
      const d = await fetchDocWatch(doc.name, { cwd: identityRef.current.cwd || identityRef.current.workspaceId });
      if (gen !== generationRef.current || key !== docKeyRef.current) return;
      if (d.ok) {
        watchActiveRef.current = true;
        watchTargetRef.current = { name: doc.name, cwd: docCwd };
        setWatchActive(true);
      } else {
        setWatchErr(String((d as { error?: string }).error || "启动实时预览失败"));
      }
    } catch (e) {
      if (gen === generationRef.current && key === docKeyRef.current) {
        setWatchErr("启动实时预览失败: " + (e instanceof Error ? e.message : String(e)));
      }
    } finally {
      if (gen === generationRef.current && key === docKeyRef.current) setWatchLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, docCwd]);

  // 停止实时预览（client DocViewer.jsx L265-269 stopLive 转录）
  const stopLive = useCallback(() => {
    stopWatchQuiet();
    setWatchActive(false);
  }, [stopWatchQuiet]);

  // annotations 变化 → 防抖保存（带文件身份，切文件后不再写回旧文件；client DocViewer.jsx L277-292）
  useEffect(() => {
    if (!isHtmlKind || !annoLoaded) return;
    const json = JSON.stringify(annotations);
    if (json === lastSavedJsonRef.current) return;
    const key = docKey;
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      if (key !== docKeyRef.current) return;
      lastSavedJsonRef.current = json;
      saveDocAnnotations(docNameRef.current, annotations, { cwd: identityRef.current.cwd || identityRef.current.workspaceId })
        .catch((e) => console.error("保存标注失败:", e));
    }, ANNO_SAVE_DEBOUNCE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotations, docKey, isHtmlKind, annoLoaded]);

  // iframe onload → 只代表页面已加载（partial）；内容身份由 postMessage 确认后才 ready。
  const handleIframeLoad = useCallback(() => {
    iframeReadyRef.current = true;
    setIframeReady(true);
    setPreviewState((prev) => (prev === PREVIEW_STATE.FAILED ? prev : PREVIEW_STATE.PARTIAL));
  }, []);

  // ready + annotations 变化都触发恢复（首次 + 新增项；client DocViewer.jsx L302-320）
  useEffect(() => {
    if (!iframeReady || !annoLoaded || !isHtmlKind) return;
    const iframe = htmlFrameRef.current;
    if (!iframe) return;
    let innerDoc: Document | null = null;
    try {
      innerDoc = iframe.contentDocument;
    } catch {
      return;
    }
    if (!innerDoc || !innerDoc.body) return;
    // 恢复函数本身有"已包裹跳过"逻辑，重复调用安全
    const restore = () => restoreAnnotationsInDoc(innerDoc, annotations);
    restore();
    // 下一次微任务再补一次，规避某些浏览器首次挂载时机问题
    const raf = requestAnimationFrame(restore);
    return () => cancelAnimationFrame(raf);
  }, [iframeReady, annoLoaded, annotations, isHtmlKind]);

  // 标注模式开启 → 在 iframe 文档内绑定 mouseup/scroll 监听（client DocViewer.jsx L323-383）
  useEffect(() => {
    if (!annoMode || !isHtmlKind) {
      setAnnoToolbar(null);
      setAnnoInput(null);
      return;
    }
    const iframe = htmlFrameRef.current;
    if (!iframe) return;
    let innerDoc: Document | null = null;
    try {
      innerDoc = iframe.contentDocument;
    } catch {
      return;
    }
    if (!innerDoc || !innerDoc.body) return;

    const onMouseUp = () => {
      const sel = innerDoc && innerDoc.getSelection ? innerDoc.getSelection() : null;
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        setAnnoToolbar(null);
        return;
      }
      const text = sel.toString();
      if (!text || !text.trim()) {
        setAnnoToolbar(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const coords = selectionToContainerCoords(iframe, range);
      if (!coords) {
        setAnnoToolbar(null);
        return;
      }
      setAnnoInput(null);
      setAnnoToolbar({ ...coords, text: text.trim() });
    };

    const onScroll = () => {
      setAnnoToolbar(null);
      setAnnoInput(null);
    };

    innerDoc.addEventListener("mouseup", onMouseUp);
    innerDoc.addEventListener("scroll", onScroll, true);
    if (iframe.contentWindow) {
      iframe.contentWindow.addEventListener("scroll", onScroll, true);
    }

    return () => {
      innerDoc?.removeEventListener("mouseup", onMouseUp);
      innerDoc?.removeEventListener("scroll", onScroll, true);
      if (iframe.contentWindow) {
        iframe.contentWindow.removeEventListener("scroll", onScroll, true);
      }
    };
  }, [annoMode, isHtmlKind]);

  // 标注模式切换（关闭时清空工具条；client DocViewer.jsx L386-394）
  const toggleAnnoMode = useCallback(() => {
    setAnnoMode((v) => {
      if (v) {
        setAnnoToolbar(null);
        setAnnoInput(null);
      }
      return !v;
    });
  }, []);

  // 高亮：包 mark.oa-anno-hl（client DocViewer.jsx L397-427）
  const handleHighlight = useCallback(() => {
    if (!annoToolbar) return;
    const iframe = htmlFrameRef.current;
    if (!iframe) return;
    let innerDoc: Document | null = null;
    try {
      innerDoc = iframe.contentDocument;
    } catch {
      return;
    }
    if (!innerDoc) return;
    const sel = innerDoc.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    try {
      const wrap = innerDoc.createElement("mark");
      wrap.className = "oa-anno-hl";
      range.surroundContents(wrap);
      sel.removeAllRanges();
      const newAnno: DocAnnotation = {
        id: `${Date.now()}-h${Math.random().toString(36).slice(2, 6)}`,
        type: "highlight",
        text: annoToolbar.text,
        created: Date.now(),
      };
      setAnnotations((prev) => [...prev, newAnno]);
      setAnnoToolbar(null);
    } catch (e) {
      console.warn("高亮包裹失败（选区可能跨元素）:", e);
    }
  }, [annoToolbar]);

  // 进入批注输入态（client DocViewer.jsx L430-433）
  const handleCommentClick = useCallback(() => {
    if (!annoToolbar) return;
    setAnnoInput({ mode: "comment", text: annoToolbar.text, value: "" });
  }, [annoToolbar]);

  // 进入交给 agent 输入态（client DocViewer.jsx L436-439）
  const handleAgentClick = useCallback(() => {
    if (!annoToolbar) return;
    setAnnoInput({ mode: "agent", text: annoToolbar.text, value: "" });
  }, [annoToolbar]);

  // 提交内联输入（client DocViewer.jsx L442-510）
  const submitInput = useCallback(() => {
    if (!annoInput) return;
    const val = (annoInput.value || "").trim();
    if (annoInput.mode === "comment") {
      if (!val) {
        setAnnoInput(null);
        setAnnoToolbar(null);
        return;
      }
      const iframe = htmlFrameRef.current;
      let innerDoc: Document | null = null;
      try {
        innerDoc = iframe?.contentDocument ?? null;
      } catch {
        innerDoc = null;
      }
      if (innerDoc) {
        const sel = innerDoc.getSelection();
        if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
          const range = sel.getRangeAt(0);
          let wrapped = false;
          // 尝试直接包裹 u.oa-anno-cm
          try {
            const wrap = innerDoc.createElement("u");
            wrap.className = "oa-anno-cm";
            wrap.title = val;
            range.surroundContents(wrap);
            wrapped = true;
          } catch {
            // 选区可能跨元素或已被高亮包裹；尝试退而求其次
            try {
              const wrap = innerDoc.createElement("u");
              wrap.className = "oa-anno-cm";
              wrap.title = val;
              wrap.textContent = annoInput.text;
              range.extractContents();
              range.insertNode(wrap);
              wrapped = true;
            } catch (e2) {
              console.warn("批注包裹失败:", e2);
            }
          }
          if (wrapped) sel.removeAllRanges();
        }
      }
      const newAnno: DocAnnotation = {
        id: `${Date.now()}-c${Math.random().toString(36).slice(2, 6)}`,
        type: "comment",
        text: annoInput.text,
        note: val,
        created: Date.now(),
      };
      setAnnotations((prev) => [...prev, newAnno]);
    } else if (annoInput.mode === "agent") {
      if (!val) {
        setAnnoInput(null);
        setAnnoToolbar(null);
        return;
      }
      const sendFn = onInsertContext || onSendToAgent;
      if (sendFn) {
        const msg = `在当前打开的 ${doc.name} 中，对选中内容「${annoInput.text}」做修改：${val}`;
        try {
          sendFn(msg);
        } catch (e) {
          console.error("onSendToAgent 调用失败:", e);
        }
      }
    }
    setAnnoInput(null);
    setAnnoToolbar(null);
  }, [annoInput, doc, onInsertContext, onSendToAgent]);

  const mdContentRef = useRef<HTMLDivElement | null>(null);
  const htmlFrameRef = useRef<HTMLIFrameElement | null>(null);

  // 浮动工具条按钮样式辅助（client DocViewer.jsx L524）
  const agentDisabled = !onSendToAgent;

  // 标注浮动工具条 + 内联输入（client DocViewer.jsx L616-681/L717-782 两分支共用结构）
  const annoFloating = (
    <>
      {annoMode && annoToolbar && !annoInput && (
        <div
          className="oa-anno-toolbar"
          style={{
            left: Math.max(0, annoToolbar.x),
            top: Math.max(0, annoToolbar.y - 36),
          }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <button className="oa-anno-btn" onClick={handleHighlight} title="高亮">
            <Icon name="penTool" size={12} />
            <span>高亮</span>
          </button>
          <button className="oa-anno-btn" onClick={handleCommentClick} title="批注">
            <Icon name="comment" size={12} />
            <span>批注</span>
          </button>
          <button
            className="oa-anno-btn"
            onClick={handleAgentClick}
            disabled={agentDisabled}
            title={agentDisabled ? "未连接 agent" : "交给 agent"}
          >
            <Icon name="robot" size={12} />
            <span>交给agent</span>
          </button>
        </div>
      )}
      {annoMode && annoInput && (
        <div
          className="oa-anno-input"
          style={{
            left: Math.max(0, annoToolbar?.x ?? 0),
            top: Math.max(0, (annoToolbar?.y ?? 0) - 56),
          }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="oa-anno-input-head">
            {annoInput.mode === "comment" ? "添加批注" : "交给 agent 的指令"}
          </div>
          <div className="oa-anno-input-body">
            <input
              type="text"
              autoFocus
              value={annoInput.value}
              placeholder={annoInput.mode === "comment" ? "写下你的批注..." : "例如：把这段改成红色加粗"}
              onChange={(e) =>
                setAnnoInput((prev) => (prev ? { ...prev, value: e.target.value } : prev))
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") submitInput();
                else if (e.key === "Escape") {
                  setAnnoInput(null);
                  setAnnoToolbar(null);
                }
              }}
            />
            <button className="oa-anno-btn oa-anno-primary" onClick={submitInput}>
              确定
            </button>
          </div>
          <div className="oa-anno-input-hint">
            选中：「{annoInput.text.slice(0, 30)}{annoInput.text.length > 30 ? "..." : ""}」
          </div>
        </div>
      )}
    </>
  );

  if (loading && !doc.kind) {
    return (
      <div className="docview-body">
        <div className="empty-view">
          <div className="loading-spinner"></div>
          <div>正在加载文件...</div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="docview-head">
        <span className="doc-title">{doc.name}</span>
        <span className={`badge preview-state preview-state-${previewState}`} title={previewErr || ""}>
          {previewState === PREVIEW_STATE.LOADING && <Icon name="loading" size={12} />}
          {previewState === PREVIEW_STATE.FAILED && <Icon name="warning" size={12} />}
          {PREVIEW_STATE_LABEL[previewState] || previewState}
        </span>
        {doc.kind === "html" && !isOfficePreview && (
          <>
            <span className="badge">{watchActive ? "实时预览" : "静态预览"}</span>
            {!watchActive && (
              <button className="btn-sm" onClick={() => void startLive()} disabled={watchLoading}>
                {watchLoading ? "启动中..." : "开启实时预览"}
              </button>
            )}
            {watchActive && (
              <button className="btn-sm" onClick={stopLive}>静态预览</button>
            )}
          </>
        )}
        {isOfficePreview && <span className="badge">专用预览工具栏</span>}
        {doc.kind === "xlsx" && <span className="badge">可编辑</span>}
        {doc.kind === "htmlfile" && <span className="badge">HTML 页面</span>}
        {doc.kind === "pdf" && <span className="badge">PDF</span>}
        {doc.kind === "text" && <span className="badge">{doc.ext === "md" || doc.ext === "markdown" ? "Markdown" : "文本"}</span>}
        {isHtmlKind && !isOfficePreview && (
          <button
            className={`btn-sm oa-anno-toggle ${annoMode ? "active" : ""}`}
            onClick={toggleAnnoMode}
            title="标注模式：划词高亮/批注"
          >
            <Icon name={annoMode ? "pin" : "comment"} size={12} />
            {annoMode ? "退出标注" : "标注"}
          </button>
        )}
        {(doc.kind === "text" || (doc.kind === "html" && !isOfficePreview)) && (
          <>
            <button
              className="btn-sm"
              onClick={() => void fetchComments()}
              disabled={commentsLoading}
              title="刷新批注"
            >
              <Icon name={commentsLoading ? "loading" : "refresh"} size={12} />
            </button>
            <button
              className={`btn-sm comment-btn ${showComments ? "active" : ""}`}
              onClick={() => setShowComments(!showComments)}
            >
              <Icon name="comment" size={12} /> 批注 ({comments.length})
            </button>
          </>
        )}
        {watchErr && <span className="badge err-badge"><Icon name="warning" size={12} /> {watchErr}</span>}
        {previewErr && <span className="badge err-badge"><Icon name="warning" size={12} /> {previewErr}</span>}
        {watchActive && <span className="badge ws-hint">可点选元素，配合右侧 agent 修改</span>}
      </div>
      <div className="docview-body">
        {doc.kind === "html" && doc.ext === "docx" && (
          <DocxViewer name={doc.name} revision={doc.previewRevision} identity={identity} onPreviewState={setPreviewState} onPreviewError={setPreviewErr} onSendToAgent={onSendToAgent} onInsertContext={onInsertContext} />
        )}
        {doc.kind === "html" && doc.ext === "pptx" && (
          <PptxViewer name={doc.name} revision={doc.previewRevision} identity={identity} onPreviewState={setPreviewState} onPreviewError={setPreviewErr} />
        )}
        {isGenericHtml && (
          <div className="docframe-container">
            <iframe
              ref={htmlFrameRef}
              title={doc.name}
              srcDoc={docHtml}
              className="docframe"
              sandbox="allow-scripts allow-same-origin"
              onLoad={handleIframeLoad}
            />
            {annoFloating}
            {showComments && comments.length > 0 && (
              <CommentMarker
                comments={comments}
                containerRef={htmlFrameRef}
                activeComment={activeComment}
                setActiveComment={setActiveComment}
              />
            )}
          </div>
        )}
        {doc.kind === "image" && (
          <ImageViewer
            doc={{ ...doc, url: blobUrl } as unknown as ImageViewerDoc}
            onPreviewState={setPreviewState}
            onPreviewError={setPreviewErr}
          />
        )}
        {doc.kind === "pdf" && (
          <div className="docframe-container">
            <iframe
              title={doc.name}
              src={blobUrl}
              className="docframe"
              onLoad={() => setPreviewState((prev) => (prev === PREVIEW_STATE.FAILED ? prev : PREVIEW_STATE.PARTIAL))}
              onError={() => { setPreviewState(PREVIEW_STATE.FAILED); setPreviewErr("PDF 预览加载失败，可用系统应用打开"); }}
            />
          </div>
        )}
        {doc.kind === "xlsx" && <ExcelGrid name={doc.name} sheets={(doc.sheets as string[]) || []} grids={(doc.grids || {}) as Record<string, unknown>} />}
        {doc.kind === "htmlfile" && (
          <div className="docframe-container">
            <iframe
              ref={htmlFrameRef}
              title={doc.name}
              srcDoc={doc.content || ""}
              className="docframe"
              sandbox="allow-scripts allow-same-origin"
              onLoad={() => { handleIframeLoad(); setPreviewState(PREVIEW_STATE.READY); }}
            />
            {annoFloating}
            {showComments && comments.length > 0 && (
              <CommentMarker
                comments={comments}
                containerRef={htmlFrameRef}
                activeComment={activeComment}
                setActiveComment={setActiveComment}
              />
            )}
          </div>
        )}
        {doc.kind === "text" && (
          <div className="mdview-container">
            <MarkdownToc content={doc.content} targetRef={mdContentRef} />
            <div className="mdview" ref={mdContentRef}>
              <div className="markdown-body">
                <MarkdownBody withToc>{doc.content || ""}</MarkdownBody>
              </div>
            </div>
            {showComments && comments.length > 0 && (
              <CommentMarker
                comments={comments}
                containerRef={mdContentRef}
                activeComment={activeComment}
                setActiveComment={setActiveComment}
              />
            )}
          </div>
        )}
      </div>
    </>
  );
}

export default function DocViewer({ tabs = [], activeTab, onSwitchTab, onCloseTab, loading, onSendToAgent, onInsertContext }: {
  tabs?: DocRecord[];
  activeTab?: string;
  onSwitchTab?: (tabId: string) => void;
  onCloseTab?: (tabId: string) => void;
  loading?: boolean;
  onSendToAgent?: (text: string) => void;
  onInsertContext?: (text: string) => void;
}) {
  // activeTab 是标签 id（工作区 + 相对路径），兼容旧数据仍可能传文件名。
  const doc = tabs.find((t) => (t.id || t.name) === activeTab) || null;
  const tabId = (t: DocRecord) => t.id || t.name;
  // 标签副标题：不同工作区的同名文件用工作区末段提示，便于区分。
  const workspaceHint = (t: DocRecord) => {
    const ws = t.identity?.workspaceId || t.identity?.cwd || "";
    const parts = String(ws).replace(/\\/g, "/").split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1] : "";
  };

  // 本机原生操作：用系统默认应用打开 / 在文件管理器中显示（服务端做路径白名单校验）
  const handleNative = async (action: "open" | "reveal") => {
    if (!doc?.name) return;
    try {
      if (action === "reveal") await revealInSystem(doc.name);
      else await openInSystem(doc.name);
    } catch (error) {
      notifyError(`${action === "reveal" ? "在文件管理器中显示" : "用系统应用打开"}失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <div className="docview">
      {/* 文件 tab 栏（类似浏览器标签页） */}
      {tabs.length > 0 && (
        <div className="doc-tabs">
          {tabs.map((t) => (
            <div
              key={tabId(t)}
              role="tab"
              tabIndex={0}
              aria-selected={tabId(t) === activeTab}
              className={`doc-tab ${tabId(t) === activeTab ? "active" : ""}`}
              onClick={() => onSwitchTab && onSwitchTab(tabId(t))}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSwitchTab && onSwitchTab(tabId(t)); }
              }}
              title={workspaceHint(t) ? `${t.name} — ${workspaceHint(t)}` : t.name}
            >
              <span className="doc-tab-icon"><Icon name={ICONS[t.ext ?? ""] || "file"} size={12} /></span>
              <span className="doc-tab-name">{t.name}</span>
              <button
                type="button"
                className="doc-tab-close"
                aria-label={`关闭 ${t.name}`}
                title={`关闭 ${t.name}`}
                onClick={(e) => { e.stopPropagation(); onCloseTab && onCloseTab(tabId(t)); }}
              ><Icon name="close" size={12} /></button>
            </div>
          ))}
        </div>
      )}
      {/* 本机原生操作条：与预览器无关，任何格式都可用（图片/Excel/PDF 等用系统应用打开） */}
      {doc && (
        <div className="doc-native-actions">
          <span className="doc-native-name" title={doc.name}><Icon name={ICONS[doc.ext ?? ""] || "file"} size={12} /> {doc.name}</span>
          <span className="doc-native-spacer" />
          <button type="button" className="btn-xs" onClick={() => handleNative("open")} title="用系统默认应用打开（例如 WPS/Word/预览/浏览器）">
            <Icon name="externalLink" size={12} /> 用系统应用打开
          </button>
          <button type="button" className="btn-xs" onClick={() => handleNative("reveal")} title="在文件管理器中显示该文件">
            <Icon name="folderOpen" size={12} /> 在文件管理器中显示
          </button>
        </div>
      )}
      {!doc ? (
        <div className="docview-body">
          <div className="empty-view">
            <div>从左侧选择一个文件</div>
            <div className="hint">.docx / .xlsx / .pptx / .md / .html — 支持多标签打开</div>
          </div>
        </div>
      ) : (
        <DocContent doc={doc} loading={loading} onSendToAgent={onSendToAgent} onInsertContext={onInsertContext} />
      )}
    </div>
  );
}
