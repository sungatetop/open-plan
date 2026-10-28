/**
 * Word 文档查看器·增强版（client/src/components/DocxViewer.jsx 787 行逐行转录，F4-4 批次）。
 * 行号锚点均指旧 JSX 文件；渲染行为、类名、DOM 结构、交互逻辑与旧版完全一致。
 * 与旧版差异（仅 HTTP → IPC 三处替换与其派生差异，无逻辑改动）：
 *   1. renderDoc：fetch(urls.raw) + readIdentityHeader(res) + res.arrayBuffer()
 *      → fetchDocRaw(name, { cwd })（op:doc:raw base64 信封）+ 响应 identity 核对 +
 *      atob 分块还原为 ArrayBuffer。旧 `加载失败 HTTP ${res.status}` 判定不再需要：
 *      invokeOrThrow 非 ok 直接 reject，由同一 catch 分支承接（AbortError 短路保留）。
 *   2. loadComments：fetch(urls.comments) + 身份头核对
 *      → fetchDocComments(name, { cwd }) + 响应 identity 核对。
 *   3. handleSave：fetch(urls.rawSave, POST { base64 }) → Packer.toBuffer 的 Buffer
 *      分块转 base64（0x8000 分块 String.fromCharCode，避免大文档超栈）
 *      → saveDocRaw(name, base64, { cwd })，ok 兜底判定语义与旧 res.json().ok 一致。
 *   - AbortController：IPC 无 signal 挂点，保留外层 controller 结构与 renderSeqRef
 *     的 isCurrent 代际判定（live()），去掉 signal 传参，代际判定已保证不串渲染；
 *   - buildDocUrls/readIdentityHeader 不再 import；cwd 取
 *     fileIdentity.cwd || fileIdentity.workspaceId || undefined（cwdOf 小辅助）；
 *   - strict 模式定点类型标注（catch 参数断言、dataset/closest 断言、索引兜底 ?? ""、
 *     execCommand value ?? undefined、alignment/heading 断言），运行时语义均不变。
 */
import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { renderAsync } from "docx-preview";
import { Document, Packer, Paragraph, TextRun, AlignmentType, HeadingLevel, type IRunOptions } from "docx";
import Icon from "./Icon";
import CommentMarker from "./CommentMarker";
import { repaginateDocx } from "../lib/DocPagination";
import { extractDocxOutline, type DocxOutlineResult } from "../lib/DocOutline";
import { motionScrollBehavior } from "../lib/ui-appearance";
import { makeFileIdentity, identityMatches, previewStateFromError, PREVIEW_STATE, type FileIdentity } from "../lib/file-urls";
import { fetchDocRaw, fetchDocComments, saveDocRaw } from "../api/client-api";

/**
 * Word 文档查看器（增强版）
 * - 更多字体和颜色选项，颜色直接显示色块
 * - 标注颜色（高亮）支持
 * - 批注显示优化
 * - 表格支持
 * - 目录导航
 */
const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 32, 36, 48, 72];
const FONT_FAMILIES = [
  "宋体", "黑体", "仿宋", "楷体", "微软雅黑", "Arial", "Calibri", "Times New Roman",
  "Helvetica", "Georgia", "Verdana", "Tahoma", "Trebuchet MS", "Courier New", "Monaco"
];
const COLORS = [
  { name: "黑色", value: "#000000" }, { name: "深灰", value: "#404040" }, { name: "灰色", value: "#808080" },
  { name: "浅灰", value: "#C0C0C0" }, { name: "白色", value: "#FFFFFF" }, { name: "红色", value: "#FF0000" },
  { name: "橙红", value: "#FF4500" }, { name: "橙色", value: "#FFA500" }, { name: "金色", value: "#FFD700" },
  { name: "黄色", value: "#FFFF00" }, { name: "绿色", value: "#00FF00" }, { name: "深绿", value: "#008000" },
  { name: "蓝绿", value: "#00CED1" }, { name: "蓝色", value: "#0000FF" }, { name: "天蓝", value: "#87CEEB" },
  { name: "紫色", value: "#800080" }, { name: "紫罗兰", value: "#EE82EE" }, { name: "粉色", value: "#FFC0CB" },
  { name: "棕色", value: "#A52A2A" }, { name: "海军蓝", value: "#000080" }
];
const HIGHLIGHT_COLORS = [
  { name: "黄色", value: "#FFFF00" }, { name: "绿色", value: "#00FF00" }, { name: "青色", value: "#00FFFF" },
  { name: "粉色", value: "#FFC0CB" }, { name: "蓝色", value: "#87CEEB" }, { name: "紫色", value: "#DDA0DD" },
  { name: "橙色", value: "#FFD700" }, { name: "红色", value: "#FF6347" }, { name: "白色", value: "#FFFFFF" },
  { name: "无", value: "transparent" }
];
const HEADING_OPTIONS = [
  { label: "正文", value: "p" },
  { label: "标题 1", value: "h1" },
  { label: "标题 2", value: "h2" },
  { label: "标题 3", value: "h3" },
  { label: "标题 4", value: "h4" },
];
const ZOOM_LEVELS = [50, 75, 100, 125, 150, 200];

/** 目录条目（buildOutline/numberedOutline 产物，与旧代码字段一致）。 */
interface OutlineItem {
  level: number;
  text: string;
  el?: HTMLElement | null;
  page?: number | null;
  number?: string;
}

/** parseHtml 的行内样式累积态（与旧代码字段一致）。 */
interface RunStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  size?: number;
  color?: string;
  font?: string;
  highlight?: string;
  align?: string;
}

/** docx 段落对齐取值（旧代码把 CSS textAlign 字符串直接透传 alignment，按此取形）。 */
type DocxAlignment = (typeof AlignmentType)[keyof typeof AlignmentType];

/** docx 标题级别取值（HeadingLevel 对象的字面量联合，parseHtml 兼容查找用）。 */
type DocxHeadingLevel = (typeof HeadingLevel)[keyof typeof HeadingLevel];

/** 组件 props（与旧版解构参数一致）。 */
export interface DocxViewerProps {
  name: string;
  revision?: string | number;
  identity?: FileIdentity;
  onPreviewState?: (state: string) => void;
  onPreviewError?: (msg: string) => void;
  onInsertContext?: (text: string) => void;
  onSendToAgent?: (text: string) => void;
}

export default function DocxViewer({ name, revision = 0, identity, onPreviewState, onPreviewError, onInsertContext, onSendToAgent }: DocxViewerProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showComments, setShowComments] = useState(true);
  const [showChanges, setShowChanges] = useState(true); // 修订模式默认开启
  const [renderKey, setRenderKey] = useState(0);
  const [mode, setMode] = useState<"preview" | "edit">("preview"); // "preview" | "edit"
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const [outlineOpen, setOutlineOpen] = useState(true);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [outlineW, setOutlineW] = useState(220); // 目录宽度（可拖拽）
  const outlineDragRef = useRef<{ startX: number; startW: number } | null>(null);
  // 文件身份 + 渲染 generation：切文件/刷新时旧渲染结果不得写入新预览。
  const fileIdentity = useMemo(
    () => identity || makeFileIdentity({ relativePath: name, revision }),
    [identity, name, revision],
  );
  // IPC 形态的 cwd 取值：身份 cwd 优先，回退 workspaceId（makeFileIdentity 已做兜底归一）。
  const cwdOf = () => fileIdentity.cwd || fileIdentity.workspaceId || undefined;
  const renderSeqRef = useRef(0);
  const renderAbortRef = useRef<AbortController | null>(null);

  // 目录宽度拖拽（可缩放导航栏）
  const startOutlineDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    outlineDragRef.current = { startX: e.clientX, startW: outlineW };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev: MouseEvent) => {
      const drag = outlineDragRef.current;
      if (!drag) return;
      const next = Math.min(380, Math.max(160, drag.startW + (ev.clientX - drag.startX)));
      setOutlineW(next);
    };
    const onUp = () => {
      outlineDragRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
  const [dirty, setDirty] = useState(false);
  const [comments, setComments] = useState<Array<Record<string, unknown>>>([]);
  const [activeComment, setActiveComment] = useState<unknown>(null);
  const [zoom, setZoom] = useState(100); // 缩放比例
  const [pageCount, setPageCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [selectionMenu, setSelectionMenu] = useState<{ text: string; left: number; top: number; noteMode?: boolean } | null>(null);
  const [selectionNote, setSelectionNote] = useState("");
  const [imageNotice, setImageNotice] = useState("");

  // 选中文档中的文字后显示 Codex 风格操作条：加入上下文、写批注或交给 Agent。
  useEffect(() => {
    const host = hostRef.current;
    const wrap = host?.closest(".oaw-docx-wrap");
    if (!host || !wrap) return undefined;
    const handleMouseUp = () => {
      const sel = window.getSelection?.();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed || !sel.toString().trim()) return;
      const range = sel.getRangeAt(0);
      if (!host.contains(range.commonAncestorContainer)) return;
      const rect = range.getBoundingClientRect();
      if (!rect.width && !rect.height) return;
      setSelectionMenu({
        text: sel.toString().replace(/\s+/g, " ").trim().slice(0, 6000),
        left: Math.max(8, rect.left),
        top: Math.max(8, rect.bottom + 6),
      });
      setSelectionNote("");
    };
    const clearOnDown = (event: MouseEvent) => {
      if (!(event.target as HTMLElement | null)?.closest(".doc-selection-popover")) setSelectionMenu(null);
    };
    host.addEventListener("mouseup", handleMouseUp);
    document.addEventListener("mousedown", clearOnDown);
    return () => {
      host.removeEventListener("mouseup", handleMouseUp);
      document.removeEventListener("mousedown", clearOnDown);
    };
  }, [renderKey, loading]);

  const closeSelectionMenu = () => {
    setSelectionMenu(null);
    setSelectionNote("");
    window.getSelection?.()?.removeAllRanges?.();
  };

  const sendSelectionToContext = (instruction = "") => {
    if (!selectionMenu) return;
    const text = instruction
      ? `文件《${name}》选区：\n${selectionMenu.text}\n\n处理要求：${instruction}`
      : `文件《${name}》选区：\n${selectionMenu.text}`;
    onInsertContext?.(text);
    closeSelectionMenu();
  };

  // 渲染 docx
  // 缩放：优先用 CSS zoom（布局尺寸随之变化，编辑命中与光标位置精确）；
  // 老浏览器回退到 transform（带宽度补偿，保证横向仍可滚动）。zoomRef 供适应宽度读取，
  // 避免把 zoom 放进回调依赖导致每次缩放都重渲染整篇文档。
  const zoomRef = useRef(100);
  const applyZoom = useCallback((level: number) => {
    const next = Math.max(30, Math.min(300, Number(level) || 100));
    zoomRef.current = next;
    setZoom(next);
    const host = hostRef.current;
    if (!host) return;
    const supportsZoom = typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("zoom", "1");
    if (supportsZoom) {
      host.style.zoom = String(next / 100);
      host.style.transform = "";
      host.style.transformOrigin = "";
      host.style.width = "";
    } else {
      host.style.zoom = "";
      host.style.transform = `scale(${next / 100})`;
      host.style.transformOrigin = "top left";
      host.style.width = `${10000 / next}%`;
    }
  }, []);

  /** 适应宽度：按真实页宽与面板可用宽度算档位，避免右侧栏把 Word 正文裁掉。 */
  const applyFitWidth = useCallback((options: { silent?: boolean } = {}) => {
    const host = hostRef.current;
    if (!host) return 0;
    const page = (host.querySelector(".oaw-docx-wrapper > section.oaw-docx") || host.querySelector("section.oaw-docx")) as HTMLElement | null;
    const pageWidth = Number(page?.offsetWidth) || 0;
    const available = Math.max(0, host.clientWidth - 40);
    if (!pageWidth || !available) return 0;
    const ratio = Math.max(0.3, Math.min(3, available / pageWidth));
    const level = Math.max(30, Math.min(300, Math.round((ratio * 100) / 5) * 5));
    // 自动模式只缩小以适应，不主动放大（100% 已是舒适阅读尺寸）
    if (options.silent && level >= zoomRef.current) return level;
    applyZoom(level);
    return level;
  }, [applyZoom]);

  const renderDoc = useCallback(async (options: { isCurrent?: () => boolean } = {}) => {
    const { isCurrent } = options;
    const live = () => (typeof isCurrent === "function" ? isCurrent() : true);
    const host = hostRef.current;
    if (!host) return;
    setLoading(true);
    setError("");
    setImageNotice("");
    onPreviewState?.(PREVIEW_STATE.LOADING);
    try {
      // IPC 形态：op:doc:raw 返回 base64 信封；失败由 invokeOrThrow 直接 reject（旧为 res.ok 判定）
      const d = await fetchDocRaw(name, { cwd: cwdOf() });
      // 服务端返回文件身份：与当前文件不符则拒绝渲染，避免同名跨工作区串内容。
      if (d.identity && !identityMatches(fileIdentity, d.identity)) {
        throw new Error("预览内容与打开的文件不一致（文件身份不匹配），已停止渲染");
      }
      // base64 → 字节（atob 分块还原为 ArrayBuffer，等价旧 res.arrayBuffer()）
      const bin = atob(String(d.base64 || ""));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const buf = bytes.buffer as ArrayBuffer;
      if (!live()) return;

      // docx-preview 的图片是异步取回的，渲染完成后要给它一点时间；个别文档在
      // blob 链路下拿不到图片（src 落空 / 解码失败），这里改用 base64 数据链重渲染一次。
      const paint = async (buffer: ArrayBuffer, { base64URL = false }: { base64URL?: boolean } = {}) => {
        host.innerHTML = "";
        await renderAsync(new Uint8Array(buffer), host, undefined, {
          className: "oaw-docx",
          inWrapper: true,
          breakPages: true,
          // 保留 Word 写入的 lastRenderedPageBreak，避免长文被压成一个连续大页面。
          ignoreLastRenderedPageBreak: false,
          renderComments: showComments, // 批注显示跟随工具栏开关
          renderChanges: showChanges,   // 修订痕迹显示跟随工具栏开关
          useBase64URL: base64URL,
        });
      };
      const brokenImages = async (timeoutMs: number): Promise<HTMLImageElement[]> => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const images = [...host.querySelectorAll("img")];
          if (images.length === 0) return [];
          if (images.every((img) => img.complete)) {
            return images.filter((img) => img.naturalWidth === 0);
          }
          if (Date.now() > deadline) return images.filter((img) => img.complete && img.naturalWidth === 0);
          await new Promise((resolve) => { setTimeout(resolve, 120); });
        }
      };

      await paint(buf);
      if (!live()) return;
      let broken = await brokenImages(6000);
      if (!live()) return;
      if (broken.length) {
        await paint(buf, { base64URL: true });
        if (!live()) return;
        broken = await brokenImages(8000);
        if (!live()) return;
      }
      if (broken.length) setImageNotice(`有 ${broken.length} 张图片未能加载`);

      // 按 A4 页高做二次分页：生成的文档通常没有 Word 的 lastRenderedPageBreak，
      // 只靠 breakPages 会出现 9000+px 的超长"纸"，这里补上逐页切分。
      repaginateDocx(host);
      const pages = host.querySelectorAll("section.oaw-docx");
      // 目录用 docx 内部样式解析（heading N/标题 N），页号取二次分页后的真实页码
      const parsedOutline = await extractDocxOutline(buf);
      if (!live()) return;
      buildOutline(host, parsedOutline);
      setPageCount(pages.length || 1);
      setCurrentPage(1);
      setDirty(false);
      // 右侧栏可能比页面窄：默认适应宽度，保证 Word 正文不被裁切。
      applyFitWidth({ silent: true });
      // 加载批注数据
      loadComments({ isCurrent });
      // 有图片未加载 → partial（页面可读但内容不完整）；否则 ready。
      onPreviewState?.(broken.length ? PREVIEW_STATE.PARTIAL : PREVIEW_STATE.READY);
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError") return;
      if (!live()) return;
      setError((e as Error).message);
      onPreviewError?.((e as Error).message);
      onPreviewState?.(previewStateFromError(e));
    } finally {
      if (live()) setLoading(false);
    }
  }, [fileIdentity, showComments, showChanges, applyFitWidth, onPreviewState, onPreviewError]);

  const loadComments = async (options: { isCurrent?: () => boolean } = {}) => {
    const { isCurrent } = options;
    const live = () => (typeof isCurrent === "function" ? isCurrent() : true);
    try {
      // IPC 形态：op:doc:comments 直接返回批注数组与身份；失败走 catch 日志（旧为 res.ok 判定）
      const d = await fetchDocComments(name, { cwd: cwdOf() });
      if (!live()) return;
      if (d.identity && !identityMatches(fileIdentity, d.identity)) return;
      if (d.comments) setComments(d.comments as Array<Record<string, unknown>>);
    } catch (e) {
      if ((e as { name?: string })?.name !== "AbortError") console.error("加载批注失败:", e);
    }
  };

  useEffect(() => {
    const seq = ++renderSeqRef.current;
    renderAbortRef.current?.abort();
    // IPC 无 signal 挂点：保留 controller 结构与 abort 调用，代际判定（isCurrent/live）承担防串渲染。
    const controller = new AbortController();
    renderAbortRef.current = controller;
    renderDoc({ isCurrent: () => seq === renderSeqRef.current });
    return () => { try { controller.abort(); } catch {} };
  }, [renderDoc, renderKey]);

  // 提取标题大纲：优先使用 docx 内部样式（heading N / 标题 N）解析出的真实层级；
  // 解析不到时才退回"编号开头的短段落"启发式，且不再把加粗正文全部列进来。
  const buildOutline = (host: HTMLElement, parsed: DocxOutlineResult) => {
    const clean = (text: unknown): string => String(text || "").replace(/\s+/g, " ").trim();
    const compact = (text: unknown): string => clean(text).replace(/\s+/g, "");
    const pageOf = (el?: HTMLElement | null): number | null => {
      const section = el?.closest("section.oaw-docx") as HTMLElement | null;
      return section ? Number(section.dataset.page || 0) || null : null;
    };
    const parsedItems = Array.isArray(parsed?.items) ? parsed.items : [];
    const headingClasses = Array.isArray(parsed?.headingClasses) ? parsed.headingClasses : [];

    if (parsedItems.length) {
      const classLevels = new Map(headingClasses.filter((item) => item.className).map((item) => [item.className, item.level]));
      const domHeads = classLevels.size
        ? [...host.querySelectorAll<HTMLElement>("section.oaw-docx p")].filter((el) => [...el.classList].some((cls) => classLevels.has(cls)))
        : [];
      const domText = domHeads.map((el) => compact(el.textContent));
      const exact = domHeads.length === parsedItems.length
        && parsedItems.every((item, index) => domText[index] === compact(item.text));
      const items: OutlineItem[] = [];
      if (exact) {
        parsedItems.forEach((item, index) => items.push({ ...item, el: domHeads[index], page: pageOf(domHeads[index]) }));
      } else {
        // 顺序配对失败（表格/文本框里的标题等）时按文本顺序兜底匹配
        let cursor = 0;
        for (const item of parsedItems) {
          const key = compact(item.text).slice(0, 24);
          let hit: { el: HTMLElement; index: number } | null = null;
          for (let i = cursor; i < domHeads.length; i += 1) {
            const text = domText[i] ?? "";
            if (key && (text.startsWith(key) || text.includes(key))) { hit = { el: domHeads[i] as HTMLElement, index: i }; break; }
          }
          if (hit) { cursor = hit.index + 1; items.push({ ...item, el: hit.el, page: pageOf(hit.el) }); }
          else items.push({ ...item, el: null, page: null });
        }
      }
      setOutline(numberedOutline(items));
      return;
    }

    // 兜底启发式
    const items: OutlineItem[] = [];
    host.querySelectorAll<HTMLElement>("section.oaw-docx [class*=heading], section.oaw-docx h1, section.oaw-docx h2, section.oaw-docx h3, section.oaw-docx h4, section.oaw-docx h5, section.oaw-docx h6").forEach((el) => {
      const cls = el.className || "";
      let level = 3;
      if (/heading1/i.test(cls) || el.tagName === "H1") level = 1;
      else if (/heading2/i.test(cls) || el.tagName === "H2") level = 2;
      else if (/heading3/i.test(cls) || el.tagName === "H3") level = 3;
      else if (/heading4/i.test(cls) || el.tagName === "H4") level = 4;
      else if (/heading5/i.test(cls) || el.tagName === "H5") level = 5;
      else if (/heading6/i.test(cls) || el.tagName === "H6") level = 6;
      const text = clean(el.textContent);
      if (text) items.push({ level, text: text.slice(0, 100), el, page: pageOf(el) });
    });
    if (items.length === 0) {
      const numbered = /^(?:第[一二三四五六七八九十百零\d]+[章节篇部分]|[一二三四五六七八九十百零\d]+、|[（(][一二三四五六七八九十百零\d]+[）)]|\d+(?:\.\d+)+)/;
      host.querySelectorAll<HTMLElement>("section.oaw-docx p").forEach((el) => {
        const text = clean(el.textContent);
        if (!text || text.length > 60 || !numbered.test(text)) return;
        let level = 2;
        if (/^第[一二三四五六七八九十百零\d]+[章节篇部分]|^[一二三四五六七八九十百零\d]+、/.test(text)) level = 1;
        else if (/^\d+(?:\.\d+){2,}/.test(text)) level = 3;
        items.push({ level, text: text.slice(0, 100), el, page: pageOf(el) });
      });
    }
    setOutline(numberedOutline(items));
  };

  // 目录编号：Word 风格的多级序号；标题自带编号（一、/1.1/（一））时不再重复编号
  const numberedOutline = (items: OutlineItem[]): OutlineItem[] => {
    const ownNumber = /^(?:第[一二三四五六七八九十百零\d]+[章节篇部分]|[一二三四五六七八九十百零\d]+[、.．)）]|[（(][一二三四五六七八九十百零\d]+[）)]|\d+(?:\.\d+)+)/;
    const counters: number[] = [];
    return items.map((item) => {
      const level = Math.max(1, Math.min(6, item.level || 1));
      counters[level - 1] = (counters[level - 1] || 0) + 1;
      for (let i = level; i < counters.length; i += 1) counters[i] = 0;
      const parts = counters.slice(0, level);
      const number = ownNumber.test(item.text) || parts.some((value) => !value) ? "" : parts.join(".");
      return { ...item, level, number };
    });
  };

  // 只滚动预览容器，避免把整个工作台一起滚动
  const scrollHostTo = (el: HTMLElement | null | undefined, offset = 16): boolean => {
    const host = hostRef.current;
    if (!host || !el) return false;
    const rect = el.getBoundingClientRect();
    const base = host.getBoundingClientRect();
    host.scrollTo({ top: Math.max(0, host.scrollTop + (rect.top - base.top) - offset), behavior: motionScrollBehavior() });
    const page = Number((el.closest("section.oaw-docx") as HTMLElement | null)?.dataset.page || 0);
    if (page) setCurrentPage(page);
    return true;
  };

  const jumpToHeading = (item: OutlineItem) => {
    if (!scrollHostTo(item.el, 24) && item.page) jumpToPage(item.page);
  };

  const jumpToPage = (page: string | number) => {
    const target = Math.max(1, Math.min(pageCount || 1, Number(page) || 1));
    const el = hostRef.current?.querySelector(`section.oaw-docx[data-page="${target}"]`);
    if (!el) return;
    setCurrentPage(target);
    const host = hostRef.current;
    if (!host) return;
    const rect = el.getBoundingClientRect();
    const base = host.getBoundingClientRect();
    host.scrollTo({ top: Math.max(0, host.scrollTop + (rect.top - base.top) - 8), behavior: motionScrollBehavior() });
  };

  // ===== 编辑模式：contentEditable + execCommand（即时生效，零后端延迟） =====
  const mutationRef = useRef<MutationObserver | null>(null);

  const enterEditMode = () => {
    setMode("edit");
    // 延迟到渲染完成后启用 contentEditable
    setTimeout(() => {
      const host = hostRef.current;
      if (!host) return;
      // 只对文档正文区域启用编辑（不含注入的 style）
      const sections = host.querySelectorAll<HTMLElement>("section.oaw-docx");
      sections.forEach((s) => { s.contentEditable = "true"; });
      // 监听内容变化 → 标记 dirty（保存按钮可用）
      if (mutationRef.current) mutationRef.current.disconnect();
      const observer = new MutationObserver(() => setDirty(true));
      sections.forEach((s) => observer.observe(s, { childList: true, subtree: true, characterData: true }));
      mutationRef.current = observer;
      setSaveMsg("编辑模式：直接点击文档修改，完成后保存");
    }, 300);
  };

  const exitEditMode = () => {
    if (mutationRef.current) { mutationRef.current.disconnect(); mutationRef.current = null; }
    const host = hostRef.current;
    if (host) {
      host.querySelectorAll<HTMLElement>("section.oaw-docx").forEach((s) => { s.contentEditable = "false"; });
    }
    setMode("preview");
  };

  // 工具栏动作（execCommand 即时生效）
  const exec = (cmd: string, value: string | null = null) => {
    document.execCommand(cmd, false, value ?? undefined);
    setDirty(true);
    hostRef.current?.focus();
  };

  const applyColor = (color: string) => {
    document.execCommand("foreColor", false, color);
    setDirty(true);
  };

  const applyHighlight = (color: string) => {
    if (color === "transparent") {
      document.execCommand("hiliteColor", false, "transparent");
    } else {
      document.execCommand("hiliteColor", false, color);
    }
    setDirty(true);
  };

  // 字号：execCommand 生成 font[size=7] 后替换为实际 pt 值（浏览器通用技巧）
  const execFontSize = (pt: string) => {
    document.execCommand("fontSize", false, "7");
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    // 找到 execCommand 生成的 font 元素并设置 style.fontSize
    const container = range.commonAncestorContainer;
    const root = container.nodeType === 3 ? container.parentElement : (container as HTMLElement);
    const fonts = root?.querySelectorAll<HTMLElement>('font[size="7"]') ?? [];
    fonts.forEach((f) => {
      f.style.fontSize = `${pt}pt`;
      f.removeAttribute("size");
    });
    setDirty(true);
  };

  // 标题格式
  const applyHeading = (tag: string) => {
    if (tag === "p") {
      document.execCommand("formatBlock", false, "p");
    } else {
      document.execCommand("formatBlock", false, tag);
    }
    setDirty(true);
    hostRef.current?.focus();
  };

  // ===== 保存：docx 库重打包 =====
  const handleSave = async () => {
    if (!dirty) { setSaveMsg("没有需要保存的修改"); setTimeout(() => setSaveMsg(""), 2000); return; }
    setSaving(true);
    setSaveMsg("保存中...");
    try {
      const host = hostRef.current;
      // 提取编辑后的正文 HTML（各 section）
      const sections = host!.querySelectorAll<HTMLElement>("section.oaw-docx");
      const html = Array.from(sections).map((s) => s.innerHTML).join("");

      // 简易 HTML → docx 转换（支持 p/h1-h6/b/i/u/font-size/font-family/color/table）
      const parseHtml = (htmlStr: string) => {
        const div = document.createElement("div");
        div.innerHTML = htmlStr;
        const paras: Paragraph[] = [];
        const walk = (node: Node, style: RunStyle) => {
          const s = { ...style };
          if (node.nodeType === 3) {
            const t = node.textContent;
            if (t && t.trim()) {
              paras.push(new Paragraph({ children: [new TextRun({ text: t, bold: s.bold, italics: s.italic, underline: s.underline ? {} : undefined, size: s.size ? s.size * 2 : undefined, color: s.color, font: s.font, highlighting: s.highlight } as IRunOptions)], alignment: s.align as DocxAlignment }));
            }
            return;
          }
          if (node.nodeType !== 1) return;
          const element = node as HTMLElement;
          const tag = element.tagName.toLowerCase();
          if (tag === "b" || tag === "strong") s.bold = true;
          if (tag === "i" || tag === "em") s.italic = true;
          if (tag === "u") s.underline = true;
          if (tag === "mark") s.highlight = "#FFFF00";
          if (tag === "span") {
            const st = (element.style || {}) as CSSStyleDeclaration;
            if (st.fontWeight === "bold" || parseInt(st.fontWeight, 10) >= 600) s.bold = true;
            if (st.fontStyle === "italic") s.italic = true;
            if (st.textDecorationLine === "underline") s.underline = true;
            if (st.fontSize) s.size = parseInt(st.fontSize, 10);
            if (st.color) s.color = st.color;
            if (st.fontFamily) s.font = st.fontFamily.replace(/["']/g, "");
            if (st.backgroundColor && st.backgroundColor !== "transparent") s.highlight = st.backgroundColor;
          }
          if (tag === "h1") s.size = 24, s.bold = true;
          if (tag === "h2") s.size = 20, s.bold = true;
          if (tag === "h3") s.size = 16, s.bold = true;
          if (tag === "p" || tag === "div") {
            const st = (element.style || {}) as CSSStyleDeclaration;
            if (st.textAlign) s.align = st.textAlign;
          }
          if (["p", "div", "h1", "h2", "h3", "h4", "h5", "h6"].includes(tag)) {
            // 收集该块内所有文本 run
            const runs: TextRun[] = [];
            const collectRuns = (n: Node, rs: TextRun[]) => {
              for (const child of n.childNodes) {
                if (child.nodeType === 3) {
                  const ctext = child.textContent;
                  if (ctext && ctext.trim()) rs.push(new TextRun({ text: ctext, bold: s.bold, italics: s.italic, underline: s.underline ? {} : undefined, size: s.size ? s.size * 2 : undefined, color: s.color, font: s.font, highlighting: s.highlight } as IRunOptions));
                } else if (child.nodeType === 1) {
                  const cs = { ...s };
                  const ct = (child as HTMLElement).tagName.toLowerCase();
                  if (ct === "b" || ct === "strong") cs.bold = true;
                  if (ct === "i" || ct === "em") cs.italic = true;
                  if (ct === "u") cs.underline = true;
                  if (ct === "mark") cs.highlight = "#FFFF00";
                  const st = ((child as HTMLElement).style || {}) as CSSStyleDeclaration;
                  if (st.fontWeight === "bold") cs.bold = true;
                  if (st.fontStyle === "italic") cs.italic = true;
                  if (st.fontSize) cs.size = parseInt(st.fontSize, 10);
                  if (st.color) cs.color = st.color;
                  if (st.backgroundColor && st.backgroundColor !== "transparent") cs.highlight = st.backgroundColor;
                  collectRuns(child, rs);
                }
              }
            };
            collectRuns(node, runs);
            if (runs.length) {
              // 旧代码 HeadingLevel[tag.toUpperCase()]：键名实为 HEADING_1 等，
              // 运行时取值为 undefined（普通段落），此处按原样保留该行为。
              const heading = tag.startsWith("h") ? { heading: (HeadingLevel as unknown as Record<string, DocxHeadingLevel>)[tag.toUpperCase()] } : {};
              paras.push(new Paragraph({ children: runs, alignment: AlignmentType.LEFT, ...heading }));
            }
            return;
          }
          for (const child of node.childNodes) walk(child, s);
        };
        walk(div, {});
        return paras;
      };

      const paras = parseHtml(html);
      const doc = new Document({ sections: [{ children: paras.length ? paras : [new Paragraph({ text: "(空文档)" })] }] });
      const buffer = await Packer.toBuffer(doc);

      // Buffer → base64：分块拼接避免大文档超栈（旧为 buffer.toString("base64") 直传 HTTP body）
      const bytes = new Uint8Array(buffer);
      const chunks: string[] = [];
      for (let i = 0; i < bytes.length; i += 0x8000) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
      const base64 = btoa(chunks.join(""));
      // IPC 保存（携带同一份文件身份 cwd，避免写错工作区的同名文件）
      const r = await saveDocRaw(name, base64, { cwd: cwdOf() });
      if (!r.ok) throw new Error(String((r.data as { error?: string })?.error || "保存失败"));
      setSaveMsg("保存成功 ✓");
      setDirty(false);
      setTimeout(() => setSaveMsg(""), 2500);
    } catch (e) {
      setSaveMsg("保存失败: " + (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="oaw-docx-wrap">
      {/* 第一行：主工具栏 */}
      <div className="oaw-docx-toolbar">
        <div className="toolbar-seg oaw-docx-mode">
          <button className={`toolbar-seg-btn ${mode === "preview" ? "active" : ""}`} onClick={exitEditMode}>
            <Icon name="eye" size={12} /> 预览
          </button>
          <button className={`toolbar-seg-btn ${mode === "edit" ? "active" : ""}`} onClick={enterEditMode}>
            <Icon name="penTool" size={12} /> 编辑
          </button>
        </div>
        <button className={`toolbar-btn ${showComments ? "active" : ""}`} onClick={() => setShowComments(!showComments)} title="显示批注">
          <Icon name="comment" size={14} />
        </button>
        <button className={`toolbar-btn ${showChanges ? "active" : ""}`} onClick={() => setShowChanges(!showChanges)} title="显示修订">
          <Icon name="history" size={14} />
        </button>
        {outline.length > 0 && (
          <button className={`toolbar-btn ${outlineOpen ? "active" : ""}`} onClick={() => setOutlineOpen(!outlineOpen)} title="目录导航">
            <Icon name="list" size={14} />
          </button>
        )}
        <button className="toolbar-btn" onClick={() => setRenderKey((k) => k + 1)} title="刷新渲染">
          <Icon name="refresh" size={14} />
        </button>
        <span className="toolbar-sep" />
        {pageCount > 0 && (
          <div className="oaw-docx-page-nav" aria-label="Word 分页导航">
            <button className="toolbar-btn" onClick={() => jumpToPage(currentPage - 1)} disabled={currentPage <= 1} title="上一页">‹</button>
            <select className="edit-select page-select" value={currentPage} onChange={(e) => jumpToPage(e.target.value)} title="跳转到页码">
              {Array.from({ length: pageCount }, (_, i) => <option key={i + 1} value={i + 1}>第 {i + 1} 页</option>)}
            </select>
            <button className="toolbar-btn" onClick={() => jumpToPage(currentPage + 1)} disabled={currentPage >= pageCount} title="下一页">›</button>
          </div>
        )}
        <span className="toolbar-sep" />
        {/* 缩放 */}
        <select className="edit-select zoom-select" value={zoom} onChange={(e) => applyZoom(Number(e.target.value))} title="缩放比例">
          {ZOOM_LEVELS.map((z) => <option key={z} value={z}>{z}%</option>)}
        </select>
        <button className="toolbar-btn docx-fit-width" onClick={() => applyFitWidth()} title="适应宽度：让页面宽度匹配当前面板，避免正文被裁切">适应宽度</button>
        {mode === "edit" && (
          <>
            <span className="toolbar-sep" />
            <button className="btn-sm primary" onClick={handleSave} disabled={saving || !dirty} title="保存修改到文档">
              <Icon name="check" size={12} /> {saving ? "保存中..." : "保存"}
            </button>
          </>
        )}
        <span className="oaw-docx-hint" title="预览页由浏览器按 A4 排版计算，不保证与 Word 原始页码一致">{mode === "edit" ? "编辑模式" : "预览模式"}{pageCount ? ` · 共 ${pageCount} 个预览页` : ""}{imageNotice ? ` · ${imageNotice}` : ""}</span>
      </div>

      {/* 第二行：编辑工具栏（仅编辑模式显示） */}
      {mode === "edit" && (
        <div className="oaw-docx-edittoolbar">
          <div className="edit-group">
            <select className="edit-select heading-select" title="标题格式" onChange={(e) => applyHeading(e.target.value)} defaultValue="">
              <option value="" disabled>标题格式</option>
              {HEADING_OPTIONS.map((h) => <option key={h.value} value={h.value}>{h.label}</option>)}
            </select>
          </div>
          <span className="edit-sep" />
          <div className="edit-group">
            <select className="edit-select" title="字号" onChange={(e) => execFontSize(e.target.value)} defaultValue="">
              <option value="" disabled>字号</option>
              {FONT_SIZES.map((s) => <option key={s} value={s}>{s}pt</option>)}
            </select>
            <select className="edit-select" title="字体" onChange={(e) => exec("fontName", e.target.value)} defaultValue="">
              <option value="" disabled>字体</option>
              {FONT_FAMILIES.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
          <span className="edit-sep" />
          <div className="edit-group">
            <button className="edit-btn" title="加粗 (Ctrl+B)" onClick={() => exec("bold")}><b>B</b></button>
            <button className="edit-btn" title="斜体 (Ctrl+I)" onClick={() => exec("italic")}><i>I</i></button>
            <button className="edit-btn" title="下划线 (Ctrl+U)" onClick={() => exec("underline")}><u>U</u></button>
            <button className="edit-btn" title="删除线" onClick={() => exec("strikeThrough")}><s>S</s></button>
          </div>
          <span className="edit-sep" />
          <div className="edit-group">
            <span className="edit-group-label">颜色</span>
            <div className="edit-color-picker">
              {COLORS.map((c) => (
                <button
                  key={c.value}
                  className="edit-color-swatch"
                  title={c.name}
                  style={{ backgroundColor: c.value }}
                  onClick={() => applyColor(c.value)}
                />
              ))}
            </div>
          </div>
          <span className="edit-sep" />
          <div className="edit-group">
            <span className="edit-group-label">标注</span>
            <div className="edit-color-picker">
              {HIGHLIGHT_COLORS.map((c) => (
                <button
                  key={c.value}
                  className={`edit-color-swatch highlight ${c.value === "transparent" ? "transparent" : ""}`}
                  title={c.name}
                  style={{ backgroundColor: c.value === "transparent" ? "transparent" : c.value }}
                  onClick={() => applyHighlight(c.value)}
                />
              ))}
            </div>
          </div>
          <span className="edit-sep" />
          <div className="edit-group">
            <button className="edit-btn" title="左对齐" onClick={() => exec("justifyLeft")}>⇤</button>
            <button className="edit-btn" title="居中" onClick={() => exec("justifyCenter")}>⇹</button>
            <button className="edit-btn" title="右对齐" onClick={() => exec("justifyRight")}>⇥</button>
          </div>
          <span className="edit-sep" />
          <span className={`edit-save-msg ${saveMsg.includes("失败") ? "err" : ""}`}>{saveMsg}</span>
        </div>
      )}

      {selectionMenu && (
        <div
          className="doc-selection-popover"
          style={{ left: selectionMenu.left, top: selectionMenu.top }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {!selectionMenu.noteMode ? (
            <>
              <span className="doc-selection-count">已选 {selectionMenu.text.length} 字</span>
              <button type="button" onClick={() => sendSelectionToContext()} title="把选中文本放入对话输入框">加入上下文</button>
              <button type="button" onClick={() => setSelectionMenu((prev) => (prev ? { ...prev, noteMode: true } : prev))} title="写下批注并注入对话">批注并注入</button>
              <button type="button" onClick={() => sendSelectionToContext("请分析这段内容并告诉我需要如何修改")}>交给 Agent</button>
            </>
          ) : (
            <>
              <textarea
                autoFocus
                value={selectionNote}
                onChange={(event) => setSelectionNote(event.target.value)}
                placeholder="写下对这段文字的批注或修改要求…"
                onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendSelectionToContext(selectionNote.trim()); } }}
              />
              <div className="doc-selection-actions">
                <button type="button" onClick={() => sendSelectionToContext(selectionNote.trim())} disabled={!selectionNote.trim()}>批注并注入</button>
                <button type="button" className="muted" onClick={closeSelectionMenu}>取消</button>
              </div>
            </>
          )}
        </div>
      )}

      {loading && <div className="oaw-docx-loading"><div className="loading-spinner"></div><div>正在渲染文档...</div></div>}
      {error && <div className="oaw-docx-error"><Icon name="warning" size={14} /> {error}</div>}

      <div className="oaw-docx-body">
        {outlineOpen && outline.length > 0 && (
          <div className="oaw-docx-outline" style={{ width: outlineW, minWidth: outlineW, maxWidth: outlineW }}>
            <div className="oaw-docx-outline-head">
              <span><Icon name="list" size={12} /> 目录{outline.length ? ` (${outline.length})` : ""}</span>
              <button className="btn-xs" onClick={() => setOutlineOpen(false)} aria-label="关闭大纲"><Icon name="close" size={12} /></button>
            </div>
            <div className="oaw-docx-outline-list">
              {outline.map((item, i) => (
                <div
                  key={i}
                  className={`oaw-docx-outline-item level-${item.level || 1}`}
                  style={{ paddingLeft: `${(item.level - 1) * 12 + 6}px` }}
                  onClick={() => jumpToHeading(item)}
                  title={item.text}
                >
                  {item.number ? <span className="oaw-docx-outline-index">{item.number}</span> : null}
                  <span className="oaw-docx-outline-text">{item.text}</span>
                  {item.page ? <span className="oaw-docx-outline-page">{item.page}</span> : null}
                </div>
              ))}
            </div>
            <div className="oaw-docx-outline-resizer" onMouseDown={startOutlineDrag} title="拖动调整目录宽度" />
          </div>
        )}
        <div className="oaw-docx-host" ref={hostRef} />
        {showComments && comments.length > 0 && (
          <CommentMarker
            comments={comments}
            containerRef={hostRef}
            activeComment={activeComment}
            setActiveComment={setActiveComment}
          />
        )}
      </div>
    </div>
  );
}
