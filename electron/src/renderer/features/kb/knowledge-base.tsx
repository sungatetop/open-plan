/**
 * 知识库全屏模式（Obsidian 风格）—— KnowledgeBase.jsx 逐行等价 TS 化（F5-8，BRD-009）。
 *
 * 布局：
 *   左栏（260px）：上=文件树/搜索，下=路径+标题结构（可拖拽分割）
 *   中栏：顶部 tab 栏 + Markdown 预览 或 图谱
 *   右栏（220px）：双向链接/反链 + @ 到对话
 *
 * @ 引用：点击「到对话」→ 累积标记 → onExit 退出 kbMode → 延迟插入文本到 ChatPanel
 *
 * 迁移留档：
 * - 数据通道：api.js 的 11 个 kb 导出 + 内联 fetch("/api/kb/export-docx") 全部改走
 *   api/client-api 的 op:kb:* IPC 封装（kbStatus/kbAddRoot/kbRemoveRoot/kbTree/
 *   kbSearch/kbGraph/kbDoc/kbImaStatus/kbImaBases/kbImaSearch/kbImaDoc/kbExportDocx），
 *   「成功返回 data、失败 throw」语义与旧 api() 一致。
 * - L388 旧端 bug 语义修正：移除最后一个根目录分支的 `setTree([])` 为未定义标识符
 *   （运行时 ReferenceError 被本层 catch 吞掉 → 弹「移除失败: setTree is not defined」
 *   且树/tab 状态不清空）；TS 严格下按 evident intent 修正为 `setTreeRoot(null)`，
 *   除该分支外其余逻辑逐行对齐（差异已在 R9 核对与提交 body 留档）。
 * - onAtMention prop 在旧组件中声明未使用（死参数），TS 侧移除不影响行为。
 * - window.prompt 沿用 map-panel.tsx（F5-7）同款形态。
 */
import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import Icon from "../../components/Icon";
import MarkdownBody from "../../components/MarkdownBody";
import KnowledgeGraph, { type KbGraphData } from "./knowledge-graph";
import MindMap from "./mind-map";
import RetrievalChat from "../chat/retrieval-chat";
import type { ChatModel, ChatReference } from "../../lib/chat-shared";
import {
  kbStatus, kbAddRoot, kbRemoveRoot, kbTree, kbSearch, kbGraph, kbDoc,
  kbImaStatus, kbImaBases, kbImaSearch, kbImaDoc, kbExportDocx,
} from "../../api/client-api";
import { notifyError, notifySuccess, askConfirm } from "../../components/Feedback";
import type { KbDoc, KbDirItem, KbFileItem, KbRootMeta, KbSearchResult, KbTreeLevel, ImaBase, ImaResultItem, ImaDocView } from "./types";

interface KbTab { relPath: string; rootIdx: number; title?: string }

interface WikiPreview { title: string; snippet: string; x: number; y: number }

export interface KnowledgeBaseProps {
  onExit?: (marks: string[]) => void;
  clientId: string;
  workspace?: string;
  project?: Record<string, unknown> | null;
  models?: ChatModel[];
  defaultModel?: string;
  onPromoteToAgent?: (payload: Record<string, unknown>) => void;
}

export default function KnowledgeBase({ onExit, clientId, workspace = "", project = null, models = [], defaultModel = "", onPromoteToAgent }: KnowledgeBaseProps): React.JSX.Element {
  const [roots, setRoots] = useState<KbRootMeta[]>([]);
  const [rootIdx, setRootIdx] = useState(0);
  const [treeRoot, setTreeRoot] = useState<KbTreeLevel | null>(null); // 根级 {dirs, files}（懒加载）
  const [treeCache, setTreeCache] = useState<Record<string, KbTreeLevel>>({}); // dirPath -> {dirs, files}
  const [treeSort, setTreeSort] = useState("name"); // name | mtime
  const [view, setView] = useState("browse"); // browse | graph
  const [searchQ, setSearchQ] = useState("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<KbSearchResult[] | null>(null);
  const [graphData, setGraphData] = useState<KbGraphData | null>(null);
  const [graphInc, setGraphInc] = useState<string[]>(["links", "tags"]);
  const [graphLocal, setGraphLocal] = useState(false); // 局部图谱（聚焦当前文档 1-hop）
  const graphRequestRef = useRef(0);
  const rootIdxRef = useRef(0);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({}); // 持久化（localStorage）
  const [backOpen, setBackOpen] = useState<Record<string, boolean>>({}); // 反链展开上下文
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false); // 导出 Word 按钮的 loading
  const [chatOpen, setChatOpen] = useState(false);

  // Obsidian tabs: {relPath, rootIdx, title}
  const [tabs, setTabs] = useState<KbTab[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null); // relPath key
  const [docCache, setDocCache] = useState<Record<string, KbDoc>>({}); // relPath -> doc

  // 左栏分割比例（文件树 / 信息区）
  const [leftSplit, setLeftSplit] = useState(0.65); // 65% 给树，35% 给信息
  const [leftW, setLeftW] = useState(260);  // 左栏宽度（可拖拽）
  const [rightW, setRightW] = useState(240); // 右栏宽度（可拖拽）
  const paneDragRef = useRef<{ side: "left" | "right"; startX: number; startW: number } | null>(null);

  // 左右栏宽度拖拽
  const startPaneDrag = (e: React.MouseEvent, side: "left" | "right"): void => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = side === "left" ? leftW : rightW;
    paneDragRef.current = { side, startX, startW };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev: MouseEvent): void => {
      const drag = paneDragRef.current;
      if (!drag) return;
      const delta = ev.clientX - drag.startX;
      const next = Math.min(420, Math.max(180, drag.startW + (drag.side === "left" ? delta : -delta)));
      if (drag.side === "left") setLeftW(next);
      else setRightW(next);
    };
    const onUp = (): void => {
      paneDragRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
  const leftRef = useRef<HTMLDivElement | null>(null);
  // splitDragRef 为旧文件残留声明（声明后未使用），忠实保留形态并就地 void 抑制 noUnusedLocals
  const splitDragRef = useRef<null>(null);
  void splitDragRef;

  // IMA 云端
  const [imaOpen, setImaOpen] = useState(false);
  const [imaConfigured, setImaConfigured] = useState(false);
  const [imaBases, setImaBases] = useState<ImaBase[]>([]);
  const [imaQ, setImaQ] = useState("");
  const [imaResults, setImaResults] = useState<ImaResultItem[] | null>(null);
  const [imaDocView, setImaDocView] = useState<(ImaDocView & { ok?: boolean }) | null>(null);

  const rootName = useMemo(() => roots[rootIdx]?.name || "", [roots, rootIdx]);

  const currentDoc = useMemo(() => {
    if (!activeTab) return null;
    return docCache[activeTab] || null;
  }, [activeTab, docCache]);

  // 初始化
  useEffect(() => {
    (async () => {
      try {
        const st = await kbStatus();
        setRoots(st.roots || []);
        const i = await kbImaStatus();
        setImaConfigured(!!(i as { configured?: unknown }).configured);
      } catch {}
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 切换根目录 → 懒加载根级 + 恢复展开状态（seq 防快速切换竞态）
  const loadSeqRef = useRef(0);
  const loadRoot = useCallback(async (idx: number): Promise<void> => {
    const seq = ++loadSeqRef.current;
    const rootChanged = idx !== rootIdxRef.current;
    rootIdxRef.current = idx;
    setRootIdx(idx);
    if (rootChanged) graphRequestRef.current += 1;
    setGraphData(null);
    setGraphLocal(false);
    setResults(null);
    setTabs([]);
    setActiveTab(null);
    setDocCache({});
    setTreeRoot(null);
    setTreeCache({});
    setExpanded({});
    try {
      const t = (await kbTree(idx)) as unknown as KbTreeLevel;
      if (seq !== loadSeqRef.current) return; // 已有更新的切换
      setTreeRoot(t);
      // 恢复展开状态（localStorage 持久化）
      try {
        const saved = JSON.parse(localStorage.getItem(`oaw_kb_expand_${idx}`) || "[]") as unknown;
        if (Array.isArray(saved) && saved.length > 0) {
          const exp: Record<string, boolean> = {};
          for (const d of saved as string[]) exp[d] = true;
          setExpanded(exp);
          // 重新懒加载已展开目录的子级
          const c: Record<string, KbTreeLevel> = {};
          await Promise.all((saved as string[]).map(async (d) => {
            try { c[d] = (await kbTree(idx, d)) as unknown as KbTreeLevel; } catch {}
          }));
          if (seq !== loadSeqRef.current) return;
          setTreeCache(c);
        }
      } catch {}
    } catch {}
  }, []);

  // 首次加载根 0（仅一次，避免 loadRoot 清空 treeRoot 时反复触发）
  const initRef = useRef(false);
  useEffect(() => {
    if (roots.length > 0 && !initRef.current) {
      initRef.current = true;
      void loadRoot(0);
    }
  }, [roots, loadRoot]);

  // 懒加载指定目录子级
  const loadLevel = useCallback(async (dirPath: string): Promise<void> => {
    try {
      const lvl = (await kbTree(rootIdx, dirPath || "")) as unknown as KbTreeLevel;
      setTreeCache((prev) => ({ ...prev, [dirPath || ""]: lvl }));
    } catch {}
  }, [rootIdx]);

  // 展开/收起目录（展开时懒加载，状态持久化）
  const toggleDir = useCallback((dirPath: string): void => {
    const isOpen = !!expanded[dirPath];
    setExpanded((prev) => {
      const next = { ...prev, [dirPath]: !isOpen };
      try {
        localStorage.setItem(`oaw_kb_expand_${rootIdx}`, JSON.stringify(Object.keys(next).filter((k) => next[k])));
      } catch {}
      return next;
    });
    if (!isOpen) void loadLevel(dirPath);
  }, [expanded, rootIdx, loadLevel]);

  // 打开文档时自动展开祖先链（对齐 siyuan selectItem）
  const ensureVisible = useCallback(async (relPath: string): Promise<void> => {
    const parts = relPath.split("/");
    const dirs = parts.slice(0, -1);
    if (dirs.length === 0) return;
    const toOpen: Record<string, boolean> = {};
    const c: Record<string, KbTreeLevel> = {};
    let cur = "";
    for (const d of dirs) {
      const next = cur ? `${cur}/${d}` : d;
      try {
        if (!(cur ? treeCache[cur] : treeRoot)) c[cur || ""] = (await kbTree(rootIdx, cur || "")) as unknown as KbTreeLevel;
      } catch {}
      toOpen[next] = true;
      cur = next;
    }
    if (Object.keys(c).length > 0) setTreeCache((prev) => ({ ...prev, ...c }));
    setExpanded((prev) => {
      const next = { ...prev, ...toOpen };
      try {
        localStorage.setItem(`oaw_kb_expand_${rootIdx}`, JSON.stringify(Object.keys(next).filter((k) => next[k])));
      } catch {}
      return next;
    });
  }, [treeCache, treeRoot, rootIdx]);

  // 面包屑导航：展开树到指定目录（复用 ensureVisible 祖先展开）
  const onDirNavigate = useCallback((dirPath: string): void => {
    if (!dirPath) return;
    void ensureVisible(dirPath + "/x.md");
  }, [ensureVisible]);

  // 选中文档滚动定位（对齐 siyuan setCurrent）
  useEffect(() => {
    if (!activeTab) return;
    const el = document.querySelector(".kb-tree-row.active");
    el?.scrollIntoView?.({ block: "center" });
  }, [activeTab]);

  // 打开文档（Obsidian tab 逻辑）
  const openDoc = useCallback(async (relPath: string, idx = rootIdx): Promise<void> => {
    const tabKey = relPath;
    // 已在缓存中 → 直接切 tab（并确保树中可见）
    if (docCache[tabKey]) {
      setActiveTab(tabKey);
      void ensureVisible(relPath);
      return;
    }
    void ensureVisible(relPath);
    setLoading(true);
    try {
      const d = (await kbDoc(relPath, idx)) as unknown as KbDoc;
      if (!d) { setLoading(false); return; }
      setDocCache((prev) => ({ ...prev, [tabKey]: d }));
      setTabs((prev) => {
        if (prev.some((t) => t.relPath === tabKey)) return prev;
        return [...prev, { relPath: tabKey, rootIdx: idx, title: d.title }];
      });
      setActiveTab(tabKey);
    } catch (e) { console.error(e); }
    setLoading(false);
  }, [rootIdx, docCache, ensureVisible]);

  // 引用悬浮预览（siyuan 式）：hover [[目标]] → 读取目标文档并弹窗预览
  const [wikiPreview, setWikiPreview] = useState<WikiPreview | null>(null); // { title, snippet, x, y }
  const wikiTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleWikilinkHover = useCallback(async (target: string, e: React.MouseEvent): Promise<void> => {
    const targetName = target.split("|")[0]?.trim() ?? "";
    if (!targetName) return;
    const rect = (e?.currentTarget as HTMLElement | undefined)?.getBoundingClientRect?.();
    // 延迟 400ms 再请求（避免快速扫过触发过多请求）
    if (wikiTimerRef.current) clearTimeout(wikiTimerRef.current);
    wikiTimerRef.current = setTimeout(async () => {
      try {
        // 目标可能是纯文件名或含路径；依次尝试 原名 / 原名+".md" / 文件名 / 文件名+".md"
        const base = targetName.split("/").pop() || targetName;
        const candidates = [targetName, targetName.endsWith(".md") ? targetName : targetName + ".md", base, base.endsWith(".md") ? base : base + ".md"];
        let d: KbDoc | null = null;
        for (const p of candidates) {
          d = await kbDoc(p, rootIdx).catch(() => null) as KbDoc | null;
          if (d) break;
        }
        if (d) {
          setWikiPreview({
            title: d.title || targetName,
            snippet: String(d.content || "").replace(/[#*_`>|]/g, "").slice(0, 260),
            x: rect?.left ?? 200,
            y: (rect?.bottom ?? 200) + 6,
          });
        }
      } catch {}
    }, 400);
  }, [rootIdx]);
  const hideWikiPreview = useCallback((): void => {
    if (wikiTimerRef.current) clearTimeout(wikiTimerRef.current);
    setWikiPreview(null);
  }, []);

  // 关闭 tab
  const closeTab = useCallback((relPath: string): void => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.relPath === relPath);
      if (idx === -1) return prev;
      const next = prev.filter((t) => t.relPath !== relPath);
      if (activeTab === relPath) {
        const neighbor = next[Math.min(idx, next.length - 1)];
        setActiveTab(neighbor ? neighbor.relPath : null);
      }
      return next;
    });
    setDocCache((prev) => { const n = { ...prev }; delete n[relPath]; return n; });
  }, [activeTab]);

  // 搜索
  const doSearch = useCallback(async (q: string): Promise<void> => {
    const query = q.trim();
    if (!query) { setResults(null); return; }
    setSearching(true);
    try {
      const r = await kbSearch(query, rootIdx) as { results?: KbSearchResult[] };
      setResults(r.results || []);
    } catch {}
    setSearching(false);
  }, [rootIdx]);

  // 图谱
  const loadGraph = useCallback(async (): Promise<void> => {
    const requestId = ++graphRequestRef.current;
    setLoading(true);
    try {
      const g = await kbGraph(rootIdx, graphInc, 800) as unknown as KbGraphData;
      if (requestId === graphRequestRef.current) setGraphData(g);
    } catch {}
    setLoading(false);
  }, [rootIdx, graphInc]);

  useEffect(() => {
    if (view === "graph" && !graphData) void loadGraph();
  }, [view, graphData, loadGraph]);

  // 图谱节点点击 → 文件打开 tab；tag 节点 → 搜索（对齐 siyuan 点击标签全局搜索）
  const handleGraphSelect = useCallback((node: { type?: string; label?: string; relPath?: string; rootIdx?: number }): void => {
    if (!node) return;
    if (node.type === "tag") {
      const t = String(node.label || "").replace(/^#/, "");
      if (t) void doSearch(t);
      return;
    }
    if (node.relPath) void openDoc(node.relPath, node.rootIdx);
  }, [openDoc, doSearch]);

  // @ 到对话：累积标记（不立即退出，支持一次 @ 多个），返回时统一插入
  const [atMarks, setAtMarks] = useState<string[]>([]);
  const addMark = useCallback((marker: string): void => {
    setAtMarks((m) => [...m, marker]);
  }, []);
  const handleAtMention = useCallback((): void => {
    if (!currentDoc) return;
    addMark(`@知识库[${currentDoc.relPath}@${rootName}]`);
  }, [currentDoc, rootName, addMark]);

  // 文件树行 @ 到对话（文件/文件夹均可，文件夹 @ 目录）
  const onAtMentionFromDoc = useCallback((relPath: string, isDir: boolean): void => {
    if (isDir) {
      addMark(`@知识库目录[${relPath}@${rootName}]`);
    } else {
      addMark(`@知识库[${relPath}@${rootName}]`);
    }
  }, [rootName, addMark]);

  // 导出当前文档为 Word（服务端从 md 生成 docx，写入工作区）
  const handleExportDocx = useCallback(async (): Promise<void> => {
    if (!currentDoc || exporting) return;
    setExporting(true);
    try {
      const data = await kbExportDocx(currentDoc.relPath, currentDoc.rootIdx ?? rootIdx);
      notifySuccess(`已导出：${data.name}（保存到工作区）`);
    } catch (err) {
      notifyError("导出失败: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setExporting(false);
    }
  }, [currentDoc, exporting, rootIdx]);

  // 根目录管理
  const handleAddRoot = useCallback(async (): Promise<void> => {
    const p = window.prompt("输入知识库根目录绝对路径（例如 F:\\Claude code本地文件\\义乌物流项目）");
    if (!p) return;
    try {
      await kbAddRoot(p);
      const st = await kbStatus();
      const list = st.roots || [];
      setRoots(list);
      if (list.length > 0) void loadRoot(list.length - 1);
    } catch (e) { notifyError("添加失败: " + (e instanceof Error ? e.message : String(e))); }
  }, [loadRoot]);

  const handleRemoveRoot = useCallback(async (i: number): Promise<void> => {
    if (!(await askConfirm(`移除根目录「${roots[i]?.name}」？（仅移出索引，不删除文件）`))) return;
    try {
      await kbRemoveRoot(roots[i]?.path || "");
      const st = await kbStatus();
      const list = st.roots || [];
      setRoots(list);
      if (list.length > 0) void loadRoot(0);
      // 旧端此处为 `setTree([])`（未定义标识符，ReferenceError 被吞 → 提示「移除失败」
      // 且树/tab 残留）；按 evident intent 修正为清空树态，见文件头迁移留档。
      else { setTreeRoot(null); setTabs([]); setActiveTab(null); setDocCache({}); }
    } catch (e) { notifyError("移除失败: " + (e instanceof Error ? e.message : String(e))); }
  }, [roots, loadRoot]);

  // IMA
  const loadImaBases = useCallback(async (): Promise<void> => {
    try {
      const r = await kbImaBases() as { ok?: boolean; bases?: ImaBase[]; error?: string };
      if (r.ok) setImaBases(r.bases || []);
      else notifyError(r.error || "获取知识库列表失败");
    } catch {}
  }, []);
  const doImaSearch = useCallback(async (): Promise<void> => {
    if (!imaQ.trim()) return;
    try {
      const r = await kbImaSearch(imaQ.trim(), "") as { ok?: boolean; items?: ImaResultItem[]; error?: string };
      if (r.ok) setImaResults(r.items || []);
      else notifyError(r.error || "搜索失败");
    } catch {}
  }, [imaQ]);
  const openImaDoc = useCallback(async (mediaId: string): Promise<void> => {
    try {
      const r = await kbImaDoc(mediaId) as (ImaDocView & { ok?: boolean; error?: string });
      if (r.ok) setImaDocView(r);
      else notifyError(r.error || "获取内容失败");
    } catch {}
  }, []);

  // 左栏下部分割拖拽
  const handleSplitMouseDown = useCallback((e: React.MouseEvent): void => {
    e.preventDefault();
    const el = leftRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const onMove = (ev: MouseEvent): void => {
      const y = ev.clientY - rect.top;
      const ratio = Math.max(0.3, Math.min(0.85, y / rect.height));
      setLeftSplit(ratio);
    };
    const onUp = (): void => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  // 渲染目录树（懒加载：按 treeCache/treeRoot 分层渲染）
  const sortLevel = useCallback((lvl: KbTreeLevel): { dirs: KbDirItem[]; files: KbFileItem[] } => {
    const dirs = [...(lvl?.dirs || [])].sort((a, b) => a.name.localeCompare(b.name, "zh"));
    const files = [...(lvl?.files || [])];
    if (treeSort === "mtime") files.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
    else files.sort((a, b) => a.name.localeCompare(b.name, "zh"));
    return { dirs, files };
  }, [treeSort]);

  const renderLevel = (dirPath: string): React.JSX.Element | null => {
    const lvl = dirPath ? treeCache[dirPath] : treeRoot;
    if (!lvl) return null;
    const { dirs, files } = sortLevel(lvl);
    return (
      <ul className="kb-tree" style={{ paddingLeft: dirPath ? 12 : 0 }}>
        {dirs.map((d) => (
          <li key={"d" + d.path} className="kb-tree-item kb-tree-dir">
            <div className="kb-tree-row" onClick={() => toggleDir(d.path || "")} title={d.name}>
              <span className="kb-tree-caret">{expanded[d.path || ""] ? "▾" : "▸"}</span>
              <Icon name="folder" size={12} />
              <span className="kb-tree-label">{d.name}</span>
              {(d.subCount || 0) > 0 && <span className="kb-tree-count" title={`${d.subCount} 个子项`}>{d.subCount}</span>}
              <span
                className="kb-tree-at"
                onClick={(e) => { e.stopPropagation(); onAtMentionFromDoc(d.path || "", true); }}
                title="@ 该文件夹到对话（agent 读取目录下所有文档）"
              >@</span>
            </div>
            {expanded[d.path || ""] && renderLevel(d.path || "")}
          </li>
        ))}
        {files.map((f) => (
          <li key={"f" + f.relPath} className="kb-tree-item">
            <div
              className={"kb-tree-row" + (activeTab === f.relPath ? " active" : "")}
              onClick={() => void openDoc(f.relPath)}
              title={f.relPath}
            >
              <span className="kb-tree-caret" />
              <Icon name="md" size={12} />
              <span className="kb-tree-label">{f.name}</span>
              {(f.linkCount || 0) > 0 && <span className="kb-tree-count" title={`${f.linkCount} 条引用`}>{f.linkCount}</span>}
              <span
                className="kb-tree-at"
                onClick={(e) => { e.stopPropagation(); onAtMentionFromDoc(f.relPath, false); }}
                title="@ 到对话"
              >@</span>
            </div>
          </li>
        ))}
      </ul>
    );
  };

  const doc = currentDoc;
  const docRootIdx = doc?.rootIdx ?? rootIdx;
  const retrievalReferences: ChatReference[] = doc ? [{
    id: `kb_${docRootIdx}_${doc.relPath}`,
    kind: "knowledge",
    target: `${doc.relPath}@${rootName}`,
    source: `@知识库[${doc.relPath}@${rootName}]`,
  }] : [];
  const retrievalContext = doc
    ? `当前选中文档：${doc.title}\n知识库根目录：${rootName}\n相对路径：${doc.relPath}\n请优先使用知识库只读能力回答，并在回答中标明来源。`
    : `当前知识库：${rootName}\n当前未选中文档。请先搜索知识库，再回答并标明来源。`;

  const docTags = doc?.tags || [];
  const docHeadings = doc?.headings || [];
  const docLinks = doc?.links || [];
  const docBacklinks = doc?.backlinks || [];
  const docMentions = doc?.mentions || [];

  return (
    <div className="kb">
      {/* 顶栏 */}
      <div className="kb-topbar">
        <button className="btn-sm" onClick={() => onExit?.(atMarks)} title="返回主工作区（@选中的内容将插入对话）">
          <Icon name="back" size={12} /> 返回{atMarks.length > 0 ? ` · @${atMarks.length}项` : ""}
        </button>
        <span className="kb-title">📚 知识库</span>
        <select className="kb-root-select" value={rootIdx} onChange={(e) => void loadRoot(parseInt(e.target.value, 10))}>
          {roots.map((r, i) => (
            <option key={i} value={i}>{r.name}{r.exists ? "" : "（缺失）"}</option>
          ))}
        </select>
        <button className="btn-sm" onClick={() => void handleAddRoot()} title="添加知识库根目录" aria-label="添加知识库根目录"><Icon name="plus" size={12} /></button>
        {roots.length > 1 && <button className="btn-sm" onClick={() => void handleRemoveRoot(rootIdx)} title="移除当前根目录" aria-label="移除当前根目录"><Icon name="trash" size={12} /></button>}
        <div className="kb-search">
          <input placeholder="搜索知识库…" value={searchQ} onChange={(e) => setSearchQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void doSearch(searchQ)} />
          <button className="btn-sm" onClick={() => void doSearch(searchQ)} disabled={searching} aria-label="搜索知识库">
            {searching ? "…" : <Icon name="search" size={12} />}
          </button>
          {searchQ && <button className="btn-sm" onClick={() => { setSearchQ(""); setResults(null); }} aria-label="清除搜索"><Icon name="close" size={12} /></button>}
        </div>
        <div className="kb-view-toggle">
          <button className={"btn-sm" + (view === "browse" ? " active" : "")} onClick={() => setView("browse")}>浏览</button>
          <button className={"btn-sm" + (view === "graph" ? " active" : "")} onClick={() => setView("graph")}>思维图谱</button>
          <button className={"btn-sm" + (view === "mind" ? " active" : "")} onClick={() => setView("mind")}>脑图</button>
        </div>
        <button className={`btn-sm kb-chat-btn${chatOpen ? " active" : ""}`} onClick={() => setChatOpen((value) => !value)} title="打开知识库只读 Chat">
          <Icon name="comment" size={12} /> Chat
        </button>
        <button className={"btn-sm kb-ima-btn" + (imaOpen ? " active" : "")}
          onClick={() => { setImaOpen((v) => !v); if (!imaOpen && !imaBases.length) void loadImaBases(); }}
          title="IMA 云端知识库"><Icon name="cloud" size={14} /> IMA{imaConfigured ? "" : " ⚠"}</button>
      </div>

      {chatOpen && (
        <div className="kb-chat-drawer">
          <RetrievalChat
            scope="knowledge"
            title="知识库 Chat"
            clientId={clientId}
            workspace={workspace}
            project={project}
            models={models}
            defaultModel={defaultModel}
            contextLabel={doc ? `${rootName} / ${doc.relPath}` : rootName}
            contextText={retrievalContext}
            references={retrievalReferences}
            onClose={() => setChatOpen(false)}
            onPromoteToAgent={(payload) => onPromoteToAgent?.(payload as unknown as Record<string, unknown>)}
          />
        </div>
      )}

      {/* IMA 弹层 */}
      {imaOpen && (
        <div className="kb-ima-panel">
          <div className="kb-ima-head">
            <b>IMA 云端知识库</b>
            {!imaConfigured && <span className="kb-ima-hint">未配置凭证：在 ima.qq.com/agent-interface 获取 ClientID/APIKey，写入 <code>~/.config/ima/client_id</code> 与 <code>api_key</code> 后刷新。</span>}
          </div>
          <div className="kb-ima-search">
            <input placeholder="搜索云端知识库…" value={imaQ} onChange={(e) => setImaQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void doImaSearch()} />
            <button className="btn-sm" onClick={() => void doImaSearch()}>搜索</button>
          </div>
          {imaBases.length > 0 && <div className="kb-ima-bases">知识库：{imaBases.map((b, bi) => <span key={String(b.id ?? bi)} className="tag">{b.name}</span>)}</div>}
          {imaResults && (
            <ul className="kb-ima-results">
              {imaResults.map((r) => (
                <li key={r.media_id} onClick={() => void openImaDoc(r.media_id || "")}>
                  <b>{r.title || "(未命名)"}</b>
                  <div className="kb-ima-snippet">{r.snippet || ""}</div>
                </li>
              ))}
            </ul>
          )}
          {imaDocView && (
            <div className="kb-ima-doc">
              <div className="kb-ima-doc-head"><b>{imaDocView.title}</b><button className="btn-sm" onClick={() => setImaDocView(null)}>关闭</button></div>
              <pre>{imaDocView.content || imaDocView.url || "(该类型暂不支持预览原文)"}</pre>
            </div>
          )}
        </div>
      )}

      {view === "browse" ? (
        <div className="kb-body">
          {/* ── 左栏：上=文件树/搜索，下=信息 ── */}
          <div className="kb-left" ref={leftRef} style={{ width: leftW, minWidth: leftW, maxWidth: leftW }}>
            {/* 上：树 / 搜索结果 */}
            <div className="kb-left-top" style={{ flex: `0 0 ${leftSplit * 100}%` }}>
              {results ? (
                <>
                  <div className="kb-left-title">搜索结果（{results.length}）</div>
                  <ul className="kb-results">
                    {results.map((r, i) => (
                      <li key={i} onClick={() => void openDoc(r.relPath)} className={activeTab === r.relPath ? "active" : ""}>
                        <div className="kb-result-title">{r.title}</div>
                        <div className="kb-result-snippet">{r.snippet}</div>
                        {(r.tags || []).length > 0 && <div className="kb-result-tags">{(r.tags || []).map((t) => <span key={t} className="tag kb-tag-click" onClick={(e) => { e.stopPropagation(); setSearchQ(t); void doSearch(t); }}>#{t}</span>)}</div>}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <>
                  <div className="kb-left-title">
                    {rootName}{treeRoot ? "" : "（空目录）"}
                    <span className="kb-tree-sort" title="排序">
                      <select value={treeSort} onChange={(e) => setTreeSort(e.target.value)} onClick={(e) => e.stopPropagation()}>
                        <option value="name">按名称</option>
                        <option value="mtime">按修改时间</option>
                      </select>
                    </span>
                  </div>
                  <div className="kb-tree-wrap">{renderLevel("")}</div>
                </>
              )}
            </div>
            {/* 拖拽分割条 */}
            <div className="kb-split-handle" onMouseDown={handleSplitMouseDown} />
            {/* 下：当前文档信息（路径 + 标题结构 + 标签） */}
            <div className="kb-left-bottom">
              {doc ? (
                <>
                  <div className="kb-right-section">
                    <div className="kb-right-title">📄 {doc.title}</div>
                    <div className="kb-meta-path">{doc.rootIdx !== undefined ? roots[doc.rootIdx]?.name + " / " : ""}{doc.relPath}</div>
                    {docTags.length > 0 && <div className="kb-doc-tags">{docTags.map((t) => <span key={t} className="tag kb-tag-click" onClick={() => { setSearchQ(t); void doSearch(t); }}>#{t}</span>)}</div>}
                  </div>
                  <div className="kb-right-section">
                    <div className="kb-right-title">标题结构</div>
                    <ul className="kb-headings">
                      {docHeadings.slice(0, 25).map((h, i) => <li key={i}>{h}</li>)}
                    </ul>
                  </div>
                </>
              ) : (
                <div className="kb-right-empty">选择文档后显示信息</div>
              )}
                </div>
          </div>
          {/* ── 中栏：tab 栏 + 预览 ── */}
          <div className="kb-center">
            {/* Obsidian tab 栏 */}
            {tabs.length > 0 && (
              <div className="kb-tabbar">
                {tabs.map((t) => (
                  <div key={t.relPath} className={"kb-tab" + (activeTab === t.relPath ? " active" : "")} onClick={() => setActiveTab(t.relPath)} title={t.relPath}>
                    <span className="kb-tab-title">{t.title}</span>
                    <span className="kb-tab-close" role="button" aria-label={`关闭 ${t.title}`} onClick={(e) => { e.stopPropagation(); closeTab(t.relPath); }}><Icon name="close" size={12} /></span>
                  </div>
                ))}
              </div>
            )}
            {loading && <div className="kb-loading">加载中…</div>}
            {!doc && !loading && <div className="kb-empty">← 从左侧选择一篇文档，或在图谱中点击节点</div>}
            {doc && !loading && (
              <div className="kb-doc-body">
                {/* 标题栏 + 面包屑（对齐 siyuan Title + Breadcrumb） */}
                <div className="kb-doc-titlebar">
                  <div className="kb-doc-titlebar-head">
                    <h2 className="kb-doc-title">{doc.title}</h2>
                    <button
                      className="btn-sm kb-export-btn"
                      onClick={() => void handleExportDocx()}
                      disabled={exporting}
                      title="导出为 Word 文档（保存到工作区）"
                    >
                      <Icon name="download" size={12} /> {exporting ? "导出中…" : "导出 Word"}
                    </button>
                  </div>
                  <div className="kb-doc-breadcrumb">
                    <span className="kb-crumb" onClick={() => onDirNavigate("")} title={rootName}>{rootName}</span>
                    {doc.relPath.split("/").slice(0, -1).map((d, i, arr) => {
                      const dirPath = arr.slice(0, i + 1).join("/");
                      return (
                        <span key={dirPath}>
                          <span className="kb-crumb-sep">/</span>
                          <span className="kb-crumb" onClick={() => onDirNavigate(dirPath)}>{d}</span>
                        </span>
                      );
                    })}
                    <span className="kb-crumb-sep">/</span>
                    <span className="kb-crumb-current">{doc.relPath.split("/").pop()}</span>
                  </div>
                </div>
                <MarkdownBody
                  onTagClick={(t) => { setSearchQ(t); void doSearch(t); }}
                  onWikilinkHover={(target, e) => { void handleWikilinkHover(target, e); }}
                >{doc.content}</MarkdownBody>
                {/* 文档底部反链区块（siyuan 式：正文下方显示引用来源） */}
                {(docBacklinks.length > 0 || docMentions.length > 0) && (
                  <div className="kb-doc-backlinks">
                    <div className="kb-doc-backlinks-title">
                      <Icon name="backlink" size={12} /> 反向链接（{docBacklinks.length}）· 提及（{docMentions.length}）
                    </div>
                    {docBacklinks.length > 0 && (
                      <ul className="kb-doc-backlinks-list">
                        {docBacklinks.slice(0, 12).map((b, i) => (
                          <li key={i} className="kb-doc-backlink-item" onClick={() => void openDoc(b.relPath || "", b.rootIdx)} title={b.snippet}>
                            <span className="kb-backlink-title">{b.title}</span>
                            <span className="kb-backlink-snippet">{b.snippet}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {docMentions.length > 0 && (
                      <ul className="kb-doc-backlinks-list">
                        {docMentions.slice(0, 6).map((m, i) => (
                          <li key={"m" + i} className="kb-doc-backlink-item" onClick={() => void openDoc(m.relPath || "", m.rootIdx)} title={m.snippet}>
                            <span className="kb-backlink-title">{m.title} <span className="kb-backlink-tag">提及</span></span>
                            <span className="kb-backlink-snippet">{m.snippet}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="kb-hresize left" onMouseDown={(e) => startPaneDrag(e, "left")} title="拖动调整左栏宽度" />
          {/* ── 右栏：链接 + @ 到对话 ── */}
          <div className="kb-right" style={{ width: rightW, minWidth: rightW, maxWidth: rightW }}>
            {doc ? (
              <>
                <div className="kb-right-section">
                  <button className="btn-sm primary kb-at-btn" onClick={handleAtMention} title="插入 @ 引用到主 Chat 对话">
                    <Icon name="at" size={14} /> @ 到对话
                  </button>
                </div>
                <div className="kb-right-section">
                  <div className="kb-right-title">双向链接（{docLinks.length}）</div>
                  {docLinks.length === 0 && <div className="kb-meta-muted">无 [[链接]]</div>}
                  <ul className="kb-links">
                    {docLinks.map((l, i) => (
                      <li key={i} onClick={() => void openDoc(l.relPath || "", l.rootIdx)} title={l.relPath}>
                        <Icon name="link" size={12} /> {l.alias || l.title}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="kb-right-section">
                  <div className="kb-right-title">反向链接（{docBacklinks.length}）</div>
                  {docBacklinks.length === 0 && <div className="kb-meta-muted">暂无引用</div>}
                  <ul className="kb-links kb-backlinks">
                    {docBacklinks.map((b, i) => (
                      <li key={i} className={backOpen[b.relPath || ""] ? "open" : ""}>
                        <div className="kb-backlink-title" onClick={() => void openDoc(b.relPath || "", b.rootIdx)} title={b.relPath}>
                          <Icon name="backlink" size={12} /> {b.title}
                        </div>
                        {b.snippet && (
                          <div
                            className="kb-backlink-snippet"
                            onClick={(e) => { e.stopPropagation(); setBackOpen((o) => ({ ...o, [b.relPath || ""]: !o[b.relPath || ""] })); }}
                            title={backOpen[b.relPath || ""] ? "收起" : "展开引用上下文"}
                          >
                            {backOpen[b.relPath || ""] ? b.snippet : (b.snippet.length > 40 ? b.snippet.slice(0, 40) + "…" : b.snippet)}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="kb-right-section">
                  <div className="kb-right-title">提及（{docMentions.length}）</div>
                  {docMentions.length === 0 && <div className="kb-meta-muted">正文出现但未建链接</div>}
                  <ul className="kb-links kb-backlinks">
                    {docMentions.map((m, i) => (
                      <li key={i} className={backOpen["m" + (m.relPath || "")] ? "open" : ""}>
                        <div className="kb-backlink-title" onClick={() => void openDoc(m.relPath || "", m.rootIdx)} title={m.relPath}>
                          <Icon name="file" size={12} /> {m.title}
                        </div>
                        {m.snippet && (
                          <div
                            className="kb-backlink-snippet"
                            onClick={(e) => { e.stopPropagation(); setBackOpen((o) => ({ ...o, ["m" + (m.relPath || "")]: !o["m" + (m.relPath || "")] })); }}
                            title={backOpen["m" + (m.relPath || "")] ? "收起" : "展开提及上下文"}
                          >
                            {backOpen["m" + (m.relPath || "")] ? m.snippet : (m.snippet.length > 40 ? m.snippet.slice(0, 40) + "…" : m.snippet)}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            ) : (
              <div className="kb-right-empty">选择文档后显示链接</div>
            )}
          </div>
          <div className="kb-hresize right" onMouseDown={(e) => startPaneDrag(e, "right")} title="拖动调整右栏宽度" />
        </div>
      ) : view === "mind" ? (
        <MindMap
          roots={roots}
          onSelectDoc={(relPath, idx) => void openDoc(relPath, idx ?? rootIdx)}
          highlightPath={currentDoc?.relPath}
          rootIdx={rootIdx}
          doc={currentDoc}
        />
      ) : (
        <div className="kb-body kb-graph-body">
          <div className="kb-graph-toolbar">
            <span>节点关系</span>
            {["links", "similar", "tags", "folders"].map((t) => (
              <label key={t} className="kb-check">
                <input type="checkbox" checked={graphInc.includes(t)}
                  onChange={(e) => { setGraphInc(e.target.checked ? [...graphInc, t] : graphInc.filter((x) => x !== t)); setGraphData(null); }} />
                {t === "links" ? "双向链接" : t === "similar" ? "内容相似" : t === "tags" ? "标签" : "目录"}
              </label>
            ))}
            <button className="btn-sm" onClick={() => void loadGraph()} disabled={loading}>重新布局</button>
            <button
              className={"btn-sm" + (graphLocal && doc ? " active" : "")}
              onClick={() => setGraphLocal((v) => !v)}
              disabled={!doc}
              title={graphLocal ? "退出局部图谱，显示全图" : "仅显示当前文档的直接关联（1-hop 局部图）"}
            >{graphLocal ? "全图" : "局部图谱"}</button>
            <span className="kb-graph-meta" title="当前图谱统计">
              {(graphData as { stats?: { nodes?: number; edges?: number; isolated?: number; brokenLinks?: number } } | null)?.stats
                ? `节点 ${(graphData as { stats: { nodes?: number } }).stats.nodes} · 边 ${(graphData as { stats: { edges?: number } }).stats.edges} · 孤立 ${(graphData as { stats: { isolated?: number } }).stats.isolated}`
                : ((graphData as { meta?: { total?: number } } | null)?.meta?.total ? `${(graphData as { meta: { total?: number } }).meta.total} 篇文档` : "")}
              {(graphData as { stats?: { brokenLinks?: number } } | null)?.stats?.brokenLinks ? ` · 断链 ${(graphData as { stats: { brokenLinks?: number } }).stats.brokenLinks}` : ""}
              {(graphData as { meta?: { capped?: unknown; totalNodes?: number } } | null)?.meta?.capped ? `（已截断${(graphData as { meta: { totalNodes?: number } }).meta.totalNodes ? `，全量 ${(graphData as { meta: { totalNodes?: number } }).meta.totalNodes} 节点` : ""}）` : ""}
            </span>
          </div>
          {graphData ? (
            <KnowledgeGraph data={graphData} onOpenNode={handleGraphSelect} highlightId={doc ? `n${docRootIdx}/${doc.relPath}` : null} focusId={graphLocal && doc ? `n${docRootIdx}/${doc.relPath}` : null} />
          ) : (
            <div className="kb-loading">图谱加载中…</div>
          )}
        </div>
      )}

      {/* 引用悬浮预览弹窗（siyuan 式） */}
      {wikiPreview && (
        <div
          className="kb-wiki-preview"
          style={{ left: Math.min(wikiPreview.x, window.innerWidth - 320), top: wikiPreview.y }}
          onMouseEnter={() => { if (wikiTimerRef.current) clearTimeout(wikiTimerRef.current); }}
          onMouseLeave={hideWikiPreview}
        >
          <div className="kb-wiki-preview-title">{wikiPreview.title}</div>
          <div className="kb-wiki-preview-snippet">{wikiPreview.snippet}</div>
        </div>
      )}
    </div>
  );
}
