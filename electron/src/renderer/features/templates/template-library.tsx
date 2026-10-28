/**
 * 模版库全屏模式（交通规划产出文件模板）—— TemplateLibrary.jsx 逐行等价 TS 化
 * （F6-1，BRD-009）。
 *
 * 左栏：分类列表；中栏：模板卡片网格/列表（支持搜索+排序）；右栏：模板预览
 * （Markdown/HTML/Word/Excel/PDF/PPT 渲染）。
 *
 * 迁移留档（桌面形态的架构性等价替换，BRD-009 HTTP/iframe → IPC）：
 * - 数据通道：api.js 的 tplList/tplContent 改走 api/client-api 的
 *   op:templates:list/content；内联 fetch("/api/templates/generate-notice") 改走
 *   generateNotice 封装（「成功返回 data、失败 throw」语义与旧 api() 一致）。
 * - 文件流通道化：旧 iframe src=/api/templates/file(s)/<encodeURIComponent(relPath)>
 *   改为 op:templates:file(s) 通道取 { mime, base64 } 后拼 data URL 渲染
 *   （params.path 承载捕获组原文，IPC 无 URL 编码层，调用方传 relPath 原文）。
 *   HTML 预览的「新窗口打开 ↗」链接随 data: URL 顶层导航被 Chromium 阻止而删除，
 *   其余预览分支渲染逐字节等价。
 */
import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import Icon from "../../components/Icon";
import MarkdownBody from "../../components/MarkdownBody";
import DocxViewer from "../../components/DocxViewer";
import { tplList, tplContent, generateNotice, tplFile, tplFiles } from "../../api/client-api";
import type { TemplateCategory, TemplateItem } from "../../../shared/protocol/channels";

// 文件类型排序权重
const TYPE_ORDER: Record<string, number> = { markdown: 0, html: 1, word: 2, pdf: 3, ppt: 4, xls: 5, other: 9 };

/** 预览态：tpl 条目与 content 响应的合并视图（setPreview({ ...tpl, ...c })）。 */
interface PreviewState extends TemplateItem {
  type?: string;
  content?: string;
  error?: string;
  [key: string]: unknown;
}

export interface TemplateLibraryProps {
  onExit?: (marks?: string[]) => void;
  onOpenFile?: (path: string) => void;
  onAtMention?: (text: string) => void;
}

export default function TemplateLibrary({ onExit, onOpenFile, onAtMention }: TemplateLibraryProps): React.JSX.Element {
  const [atMarks, setAtMarks] = useState<string[]>([]); // 已选模板标记；有主输入框时立即插入，兼容无回调时返回传递
  const [genOpen, setGenOpen] = useState(false); // 一键生成弹窗
  const [genTopic, setGenTopic] = useState("");
  const [categories, setCategories] = useState<TemplateCategory[]>([]);
  const [templates, setTemplates] = useState<TemplateItem[]>([]);
  const [activeCategory, setActiveCategory] = useState("all");
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [viewMode, setViewMode] = useState("grid");
  const [sortBy, setSortBy] = useState("type");
  const [search, setSearch] = useState("");
  // 红头会议通知生成弹窗
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [noticeBusy, setNoticeBusy] = useState(false);
  const [noticeDone, setNoticeDone] = useState("");
  const [noticeErr, setNoticeErr] = useState("");
  const [nOrg, setNOrg] = useState("");
  const [nTitle, setNTitle] = useState("");
  const [nDocNo, setNDocNo] = useState("");
  const [nRecipients, setNRecipients] = useState("");
  const [nIntro, setNIntro] = useState("");
  const [nItems, setNItems] = useState("");
  const [nSigner, setNSigner] = useState("");
  const [nDate, setNDate] = useState("");
  const [nPrefix, setNPrefix] = useState("");

  // 文件流 data URL（HTML/PDF/PPT/Excel 预览；旧 iframe HTTP src 的 IPC 等价）
  const [previewDataUrl, setPreviewDataUrl] = useState("");
  const [previewFileError, setPreviewFileError] = useState("");

  const doGenerateNotice = async () => {
    if (noticeBusy) return;
    setNoticeBusy(true);
    setNoticeDone("");
    setNoticeErr("");
    try {
      const items = nItems.split(/\n+/).map((s) => s.trim()).filter(Boolean);
      const d = await generateNotice({
        orgName: nOrg,
        title: nTitle,
        docNo: nDocNo,
        recipients: nRecipients,
        intro: nIntro,
        items,
        signer: nSigner,
        date: nDate,
        filePrefix: nPrefix,
      });
      if (!d.ok) throw new Error(d.error || "生成失败");
      setNoticeDone(d.name);
    } catch (e) {
      setNoticeErr(String((e as { message?: unknown }).message || e));
    }
    setNoticeBusy(false);
  };
  const previewSeq = useRef(0); // 竞态保护
  const [leftW, setLeftW] = useState(200);   // 左栏分类宽度（可拖拽）
  const [rightW, setRightW] = useState(440); // 右栏预览宽度（可拖拽）
  const paneDragRef = useRef<{ side: string; startX: number; startW: number } | null>(null);

  // 左右栏宽度拖拽
  const startPaneDrag = (e: React.MouseEvent, side: string) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = side === "left" ? leftW : rightW;
    paneDragRef.current = { side, startX, startW };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev: MouseEvent) => {
      const drag = paneDragRef.current;
      if (!drag) return;
      const delta = ev.clientX - drag.startX;
      const next = Math.min(side === "left" ? 320 : 720, Math.max(side === "left" ? 140 : 260, drag.startW + (drag.side === "left" ? delta : -delta)));
      if (drag.side === "left") setLeftW(next);
      else setRightW(next);
    };
    const onUp = () => {
      paneDragRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const r = await tplList();
        setCategories(r.categories || []);
        setTemplates(r.items || []);
      } catch (e) { console.error(e); }
      setLoading(false);
    })();
  }, []);

  // 文件流取数：HTML → file 路由（双根候选），PDF/PPT/Excel → files 路由（工作目录根）；
  // 旧 iframe 的 encodeURIComponent 在 IPC 形态下不存在，relPath 原文直传。
  useEffect(() => {
    let cancelled = false;
    setPreviewDataUrl("");
    setPreviewFileError("");
    const relPath = preview?.relPath;
    if (!preview || !relPath) return;
    const isHtml = (preview.type === "markdown" || preview.type === "text") && preview.ext === "html";
    const isPdf = preview.type === "pdf" || preview.ext === "pdf";
    const isPpt = preview.type === "ppt" || preview.ext === "pptx" || preview.ext === "ppt";
    const isXls = preview.type === "xls" || preview.ext === "xlsx" || preview.ext === "xls";
    if (!isHtml && !isPdf && !isPpt && !isXls) return;
    void (async () => {
      try {
        const r = (isHtml ? await tplFile(relPath) : await tplFiles(relPath)) as { mime: string; base64: string };
        if (cancelled) return;
        setPreviewDataUrl(`data:${r.mime};base64,${r.base64}`);
      } catch (e) {
        if (cancelled) return;
        setPreviewFileError(String((e as { message?: unknown }).message || e));
      }
    })();
    return () => { cancelled = true; };
  }, [preview]);

  // 排序 + 过滤 + 搜索
  const filtered = useMemo(() => {
    let list = activeCategory === "all" ? templates : templates.filter((t) => t.category === activeCategory);
    // 搜索
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((t) => t.title.toLowerCase().includes(q) || (t.name || "").toLowerCase().includes(q) || t.ext.toLowerCase().includes(q));
    }
    // 排序
    list = [...list].sort((a, b) => {
      if (sortBy === "type") {
        const oa = TYPE_ORDER[a.type ?? ""] ?? 9;
        const ob = TYPE_ORDER[b.type ?? ""] ?? 9;
        if (oa !== ob) return oa - ob;
        return a.title.localeCompare(b.title, "zh");
      }
      if (sortBy === "name") return a.title.localeCompare(b.title, "zh");
      if (sortBy === "size") return (b.size || 0) - (a.size || 0);
      return 0;
    });
    return list;
  }, [templates, activeCategory, sortBy, search]);

  const openPreview = useCallback(async (tpl: TemplateItem) => {
    const seq = ++previewSeq.current; // 每次点击递增
    setPreviewLoading(true);
    setPreview(tpl); // 先显示标题信息
    try {
      const c = await tplContent(tpl.relPath ?? "");
      if (seq !== previewSeq.current) return; // 已过期，丢弃
      setPreview({ ...tpl, ...c });
    } catch (e) {
      if (seq !== previewSeq.current) return;
      setPreview({ ...tpl, type: "error", content: "加载失败: " + String((e as { message?: unknown }).message) });
    }
    setPreviewLoading(false);
  }, []);

  const closePreview = useCallback(() => setPreview(null), []);

  const addAtMark = useCallback((marker: string) => {
    const value = String(marker || "").trim();
    if (!value) return;
    setAtMarks((marks) => (marks.includes(value) ? marks : [...marks, value]));
    onAtMention?.(`${value} `);
  }, [onAtMention]);

  // 文件类型图标
  const extIcon = (ext?: string) => {
    const map: Record<string, string> = { md: "md", docx: "doc", doc: "doc", pdf: "pdf", pptx: "ppt", ppt: "ppt", html: "html", xlsx: "xls", xls: "xls" };
    return map[ext ?? ""] || "file";
  };

  // 文件大小格式化
  const formatSize = (bytes?: number) => {
    const n = Number(bytes || 0);
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / (1024 * 1024)).toFixed(1) + " MB";
  };

  // 文件类型中文名
  const typeName = (type?: string) => {
    const map: Record<string, string> = { markdown: "Markdown", html: "HTML", word: "Word", pdf: "PDF", ppt: "PPT", xls: "Excel", binary: "二进制", error: "错误", text: "文本" };
    return map[type ?? ""] || type;
  };

  // 预览内容渲染
  const renderPreview = () => {
    if (previewLoading) return <div className="tpl-loading">加载预览…</div>;
    if (!preview) return <div className="tpl-empty">选择模板查看预览</div>;
    if (preview.type === "error") return <div className="tpl-empty">{preview.content}</div>;

    // Markdown / 文本
    if (preview.type === "markdown" || preview.type === "text") {
      if (preview.ext === "html") {
        // HTML 模板：data URL iframe 直接渲染首页效果（旧 /api/templates/file iframe 的 IPC 等价）
        return (
          <div className="tpl-preview-body tpl-docx-preview">
            {previewFileError ? <div className="tpl-empty">预览加载失败：{previewFileError}</div> : previewDataUrl ? (
              <iframe
                className="tpl-preview-iframe"
                src={previewDataUrl}
                title={preview.title}
                sandbox="allow-scripts"
              />
            ) : <div className="tpl-loading">加载预览…</div>}
          </div>
        );
      }
      return (
        <div className="tpl-preview-body">
          <MarkdownBody>{preview.content || ""}</MarkdownBody>
        </div>
      );
    }

    // Word - 用 DocxViewer 渲染
    if (preview.type === "word" || preview.ext === "docx" || preview.ext === "doc") {
      return (
        <div className="tpl-preview-body tpl-docx-preview">
          <DocxViewer name={preview.relPath ?? preview.name ?? ""} />
        </div>
      );
    }

    // PDF - 用 pdf.js 或 embed 渲染（旧 /api/templates/files iframe 的 data URL 等价）
    if (preview.type === "pdf" || preview.ext === "pdf") {
      return (
        <div className="tpl-preview-body tpl-docx-preview">
          {previewFileError ? <div className="tpl-empty">预览加载失败：{previewFileError}</div> : (
            <iframe
              key={preview.relPath}
              src={previewDataUrl || undefined}
              className="tpl-preview-iframe"
              title={preview.title}
            />
          )}
        </div>
      );
    }

    // PPT / Excel - iframe 渲染（同上通道化）
    if (preview.type === "ppt" || preview.ext === "pptx" || preview.ext === "ppt" ||
        preview.type === "xls" || preview.ext === "xlsx" || preview.ext === "xls") {
      return (
        <div className="tpl-preview-body tpl-docx-preview">
          {previewFileError ? <div className="tpl-empty">预览加载失败：{previewFileError}</div> : (
            <iframe
              key={preview.relPath}
              src={previewDataUrl || undefined}
              className="tpl-preview-iframe"
              title={preview.title}
            />
          )}
        </div>
      );
    }

    // 其他二进制文件
    return (
      <div className="tpl-preview-body tpl-binary-note">
        <Icon name={extIcon(preview.ext)} size={48} />
        <p><b>{preview.ext?.toUpperCase()}</b> 文件（{formatSize(preview.size)}）</p>
        <p>{typeName(preview.type)} 格式</p>
        {onOpenFile && (
          <button className="btn-sm primary" onClick={() => { onOpenFile(preview.relPath ?? preview.name ?? ""); onExit?.(); }}>
            在办公模式中打开
          </button>
        )}
      </div>
    );
  };

  // 一键生成：携带主题指令返回对话（复用 @模板 标记机制）
  const confirmGenerate = () => {
    if (!genTopic.trim() || !preview) return;
    const ref = preview.relPath || preview.name;
    const prompt = `@模板[${ref}] 请参考该模板的风格与结构，生成主题为「${genTopic.trim()}」的 HTML PPT，保存到工作区后告诉我文件名`;
    if (onAtMention) {
      onAtMention(prompt);
      onExit?.();
    } else {
      onExit?.([prompt]);
    }
    setGenOpen(false);
  };

  return (
    <div className="tpl">
      {/* 顶栏 */}
      <div className="tpl-topbar">
        <button className="btn-sm" onClick={() => onExit?.(onAtMention ? [] : atMarks)}><Icon name="back" size={14} /> 返回</button>
        <span className="tpl-title">📋 模版库</span>
        <span className="tpl-count">{filtered.length} 个模版</span>
        {atMarks.length > 0 && (
          <span className="tpl-at-badge" title="已选模板，已插入或将在返回后插入对话">
            @已选 {atMarks.length} 项
            <button className="btn-xs" onClick={(e) => { e.stopPropagation(); setAtMarks([]); }}>清除</button>
          </span>
        )}
        <div className="tpl-search">
          <Icon name="search" size={12} />
          <input
            type="text"
            className="tpl-search-input"
            placeholder="搜索模板名称…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && <button className="tpl-search-clear" onClick={() => setSearch("")} aria-label="清除搜索"><Icon name="close" size={12} /></button>}
        </div>
        <div className="tpl-sort">
          <label className="tpl-sort-label">排序：</label>
          <select className="tpl-sort-select" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
            <option value="type">按类型</option>
            <option value="name">按名称</option>
            <option value="size">按大小</option>
          </select>
        </div>
        <div className="tpl-view-toggle">
          <button className={"btn-sm" + (viewMode === "grid" ? " active" : "")} onClick={() => setViewMode("grid")}><Icon name="grid" size={14} /></button>
          <button className={"btn-sm" + (viewMode === "list" ? " active" : "")} onClick={() => setViewMode("list")}><Icon name="list" size={14} /></button>
        </div>
        <button className="btn-sm primary tpl-notice-btn" onClick={() => setNoticeOpen(true)} title="按公文规范生成红头会议通知">
          <Icon name="doc" size={14} /> 生成红头通知
        </button>
      </div>

      {/* 红头会议通知生成弹窗 */}
      {noticeOpen && (
        <div className="tpl-modal-mask" onClick={() => setNoticeOpen(false)}>
          <div className="tpl-modal" onClick={(e) => e.stopPropagation()}>
            <div className="tpl-modal-head">
              <b>生成红头会议通知</b>
              <button className="btn-sm" onClick={() => setNoticeOpen(false)}><Icon name="close" size={14} /></button>
            </div>
            <div className="tpl-modal-body">
              <label className="tpl-f"><span>发文机关（版头红字）</span>
                <input value={nOrg} onChange={(e) => setNOrg(e.target.value)} placeholder="××市人民政府办公室" /></label>
              <label className="tpl-f"><span>标题</span>
                <input value={nTitle} onChange={(e) => setNTitle(e.target.value)} placeholder="会议通知" /></label>
              <label className="tpl-f"><span>发文字号</span>
                <input value={nDocNo} onChange={(e) => setNDocNo(e.target.value)} placeholder="×政办函〔2026〕12号" /></label>
              <label className="tpl-f"><span>主送机关</span>
                <input value={nRecipients} onChange={(e) => setNRecipients(e.target.value)} placeholder="各县（市、区）人民政府，市直有关单位：" /></label>
              <label className="tpl-f"><span>引言段（可选）</span>
                <textarea value={nIntro} onChange={(e) => setNIntro(e.target.value)} rows={2} placeholder="留空使用默认引言" /></label>
              <label className="tpl-f"><span>通知事项（每行一项 → 一、二、三…）</span>
                <textarea value={nItems} onChange={(e) => setNItems(e.target.value)} rows={4} placeholder={"会议时间：2026年8月15日（星期六）上午9:00\n会议地点：市政府二楼第一会议室\n参会人员：各单位分管负责同志\n其他事项：请各单位于会前3天报送参会回执"} /></label>
              <label className="tpl-f"><span>落款机关</span>
                <input value={nSigner} onChange={(e) => setNSigner(e.target.value)} placeholder="默认同发文机关" /></label>
              <label className="tpl-f"><span>落款日期</span>
                <input value={nDate} onChange={(e) => setNDate(e.target.value)} placeholder="2026年8月15日" /></label>
              <label className="tpl-f"><span>文件前缀</span>
                <input value={nPrefix} onChange={(e) => setNPrefix(e.target.value)} placeholder="红头会议通知" /></label>
            </div>
            <div className="tpl-modal-foot">
              <span className={"tpl-gen-status" + (noticeDone ? " ok" : "")}>
                {noticeDone ? `已生成：${noticeDone}（在文件区可打开）` : noticeErr || "生成后自动保存到当前工作区"}
              </span>
              <button className="btn-sm primary" onClick={() => void doGenerateNotice()} disabled={noticeBusy}>
                {noticeBusy ? "生成中…" : "生成"}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="tpl-body">
        {/* 左栏：分类 */}
        <div className="tpl-left" style={{ width: leftW, minWidth: leftW, maxWidth: leftW }}>
          <div className="tpl-cat-title">分类</div>
          <div className={"tpl-cat-item" + (activeCategory === "all" ? " active" : "")} onClick={() => setActiveCategory("all")}>
            <span className="tpl-cat-icon">📁</span>
            <span>全部</span>
            <span className="tpl-cat-count">{templates.length}</span>
          </div>
          {categories.map((c) => {
            const count = templates.filter((t) => t.category === c.id).length;
            return (
              <div key={c.id} className={"tpl-cat-item" + (activeCategory === c.id ? " active" : "")} onClick={() => setActiveCategory(c.id)}>
                <span className="tpl-cat-icon">{c.icon}</span>
                <span>{c.name}</span>
                <span className="tpl-cat-count">{count}</span>
              </div>
            );
          })}
        </div>
        <div className="tpl-hresize left" onMouseDown={(e) => startPaneDrag(e, "left")} title="拖动调整分类栏宽度" />

        {/* 中栏：模板网格/列表 */}
        <div className="tpl-center">
          {loading && <div className="tpl-loading">加载中…</div>}
          {!loading && filtered.length === 0 && <div className="tpl-empty">{search ? "无匹配结果" : "该分类暂无模版"}</div>}
          {viewMode === "grid" ? (
            <div className="tpl-grid">
              {filtered.map((t) => (
                <div key={t.id} className={"tpl-card" + (preview?.relPath === t.relPath ? " active" : "")} onClick={() => void openPreview(t)}>
                  <div className="tpl-card-icon"><Icon name={extIcon(t.ext)} size={32} /></div>
                  <div className="tpl-card-title">{t.title}</div>
                  <div className="tpl-card-meta">
                    <span className="tpl-card-ext">{t.ext.toUpperCase()}</span>
                    <span className="tpl-card-size">{formatSize(t.size)}</span>
                  </div>
                  <div className="tpl-card-cat">{categories.find((c) => c.id === t.category)?.name || t.category}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="tpl-list">
              {filtered.map((t) => (
                <div key={t.id} className={"tpl-list-item" + (preview?.relPath === t.relPath ? " active" : "")} onClick={() => void openPreview(t)}>
                  <Icon name={extIcon(t.ext)} size={16} />
                  <span className="tpl-list-title">{t.title}</span>
                  <span className="tpl-list-ext">{t.ext.toUpperCase()}</span>
                  <span className="tpl-list-size">{formatSize(t.size)}</span>
                  <span className="tpl-list-cat">{categories.find((c) => c.id === t.category)?.icon}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="tpl-hresize right" onMouseDown={(e) => startPaneDrag(e, "right")} title="拖动调整预览宽度" />

        {/* 右栏：预览 */}
        {preview && (
          <div className="tpl-preview" style={{ width: rightW, minWidth: rightW, maxWidth: rightW }}>
            <div className="tpl-preview-head">
              <div className="tpl-preview-title">{preview.title}</div>
              <div className="tpl-preview-meta">
                <span className="tpl-preview-ext">{preview.ext?.toUpperCase()}</span>
                <span>{formatSize(preview.size || 0)}</span>
                <span>{categories.find((c) => c.id === preview.category)?.name}</span>
              </div>
              <button
                className="btn-sm tpl-preview-at"
                title="把该模板 @到对话；引用使用完整路径，Agent 可准确定位模板文件"
                onClick={() => addAtMark(`@模板[${preview.relPath || preview.name}]`)}
              >@ 模板</button>
              <button
                className="btn-sm primary"
                title="一键让 agent 按该模板风格生成作品（输入主题后自动带入对话）"
                onClick={() => setGenOpen(true)}
              >
                <Icon name="penTool" size={12} /> 用此模板生成
              </button>
              {preview.relPath?.includes("/") && (
                <button
                  className="btn-sm tpl-preview-at-dir"
                  title="@整个模板目录"
                  onClick={() => {
                    const relDir = String(preview.relPath).split("/").slice(0, -1).join("/");
                    addAtMark(`@模板目录[${relDir}]`);
                  }}
                >@📁 目录</button>
              )}
              <button className="btn-sm" onClick={closePreview} title="关闭预览" aria-label="关闭预览"><Icon name="close" size={14} /></button>
            </div>
            {renderPreview()}
          </div>
        )}
      </div>

      {/* 一键生成弹窗：输入主题 → 返回对话并预填生成指令 */}
      {genOpen && (
        <div className="tpl-gen-backdrop" onClick={() => setGenOpen(false)}>
          <div className="tpl-gen" onClick={(e) => e.stopPropagation()}>
            <div className="tpl-gen-head">
              <span><Icon name="penTool" size={14} /> 用模板生成</span>
              <button className="mp-op" onClick={() => setGenOpen(false)} title="关闭"><Icon name="close" size={14} /></button>
            </div>
            <div className="tpl-gen-body">
              <div className="tpl-gen-note">将按「{preview?.title}」的风格生成作品，并自动带入对话让 agent 执行。</div>
              <input
                className="tpl-gen-input"
                placeholder="输入作品主题，如：松阳县停车设施规划汇报"
                value={genTopic}
                onChange={(e) => setGenTopic(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") confirmGenerate(); }}
                autoFocus
              />
              <div className="tpl-gen-actions">
                <button className="btn-sm" onClick={() => setGenOpen(false)}>取消</button>
                <button
                  className="btn-sm primary"
                  disabled={!genTopic.trim()}
                  onClick={confirmGenerate}
                >生成</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
