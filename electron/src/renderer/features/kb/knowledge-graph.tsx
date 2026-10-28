/**
 * 知识图谱（antv G6 v5 力导向图，Obsidian/siyuan 风格）—— KnowledgeGraph.jsx 逐行等价 TS 化（F5-8，BRD-009）。
 *
 * 布局：
 *   顶栏工具条：搜索定位 / 适配视图 / 重置 / 返回 / 回全图 / 隐藏孤立 / 类型三开关 / minRefs / 密度
 *   图容器：G6 画布 + 错误提示 + 边型图例 + 当前探索关系侧栏
 *
 * 迁移留档：
 * - 数据入参 loose typed（KbGraphData）：kbGraph 通道响应为宽松形状，节点/边字段契约
 *   与 server/kb.mjs getGraph 一致（id/label/type/relPath/rootIdx/group；source/target/type）。
 * - G6 v5 样式回调参数为 NodeData（data 为 Record<string, unknown>）：统一经 kgDatum()
 *   收窄为本文件局部数据视图（KgNodeValue），不引入 any。
 * - EDGE_COLORS/RELATION_LABELS 显式 Record<string, string> 注解：旧 JS 对 data.type 的
 *   宽松索引（任意串/undefined 命中即回退默认色）在 TS 下需索引签名对齐。
 * - G6 v5.1.1 版本与 client/package.json ^5.1.1 原样对齐（R5 计划风险对策）。
 */
import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { Graph } from "@antv/g6";
import type { NodeData, EdgeData } from "@antv/g6";

/** kbGraph 通道响应宽松视图（字段契约 = server/kb.mjs getGraph）。 */
export interface KbGraphData {
  nodes?: Array<{
    id?: string;
    label?: string;
    type?: string;
    relPath?: string;
    rootIdx?: number;
    group?: string;
  }>;
  edges?: Array<{ source?: string; target?: string; type?: string }>;
  [key: string]: unknown;
}

/** 图节点 data 字段视图（G6 NodeData.data 的运行时形状，handleGraphSelect 消费方同构）。 */
export interface KgNodeValue {
  label?: string;
  type?: string;
  relPath?: string;
  rootIdx?: number;
  group?: string;
}

/** G6 NodeData/EdgeData → KgNodeValue 收窄（样式回调统一入口；data 字段两类节点同构）。 */
function kgDatum(d: { data?: Record<string, unknown> }): KgNodeValue {
  return (d.data || {}) as KgNodeValue;
}

/** G6 事件 → 目标节点 id 收窄（v5 事件对象无公开 target 契约，运行时形状 { target: { id } }）。 */
function evtNodeId(evt: unknown): string | undefined {
  return (evt as { target?: { id?: string } } | null)?.target?.id;
}

// 分组调色板（Obsidian 式：同组同色相，组间区分）
const GROUP_COLORS = ["#7aa2f7", "#9ece6a", "#e0af68", "#bb9af7", "#f7768e", "#73daca", "#2ac3de", "#ff9e64", "#c0caf5", "#a9b1d6"];
const TAG_COLOR = "#e8c547";
const FOLDER_COLOR = "#6a9bc7";

// 稳定 hash：同一组名永远映射到同一颜色
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

const EDGE_COLORS: Record<string, string> = {
  link: "#5a8a7c",
  similar: "#4a6d8c",
  tag: "#b8952e",
  folder: "#3d6080",
};

const BATCH_SIZE = 500; // 分批渲染阈值

const GRAPH_SETTINGS_KEY = "oaw_graph_settings";
interface GraphSettings { minRefs: number; showTags: boolean; showFiles: boolean; showFolders: boolean }
function loadGraphSettings(): GraphSettings {
  try {
    return { minRefs: 0, showTags: true, showFiles: true, showFolders: true, ...JSON.parse(localStorage.getItem(GRAPH_SETTINGS_KEY) || "{}") };
  } catch {
    return { minRefs: 0, showTags: true, showFiles: true, showFolders: true };
  }
}
function saveGraphSettings(s: GraphSettings): void {
  try { localStorage.setItem(GRAPH_SETTINGS_KEY, JSON.stringify(s)); } catch {}
}

/**
 * 知识图谱（antv G6 v5 力导向图，Obsidian/siyuan 风格）
 * - 边 = 真实关系（wikilink/标签/目录），similar 相似边默认关闭由上层控制
 * - hover 节点 → 邻接节点+边高亮，非邻接降透明（Obsidian 聚焦）
 * - 节点大小 ∝ 连接度（Obsidian：关联越多越大）
 * - file 节点按顶层目录分组着色（Obsidian 颜色分组）
 * - 缩放联动：缩小到阈值以下自动隐藏标签文字（防密）
 * - 控制条：搜索定位节点 / 隐藏孤立节点（对齐 siyuan pruneUnref）
 * - minRefs 过滤（siyuan）：引用数低于阈值的文件节点剔除
 * - 按类型过滤（siyuan）：文档/标签/目录独立开关
 * - 配置持久化到 localStorage（oaw_graph_settings）
 * - 大数据量分批渲染（对齐 siyuan 分批策略）
 */
const RELATION_LABELS: Record<string, string> = {
  link: "双向链接",
  similar: "内容相似",
  tag: "标签",
  folder: "目录",
};

export interface KnowledgeGraphProps {
  data: KbGraphData | null;
  onOpenNode?: (node: KgNodeValue) => void;
  highlightId?: string | null;
  focusId?: string | null;
}

export default function KnowledgeGraph({ data, onOpenNode, highlightId, focusId }: KnowledgeGraphProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<Graph | null>(null);
  const [graphError, setGraphError] = useState("");
  const [graphReady, setGraphReady] = useState(false);
  const [hideIsolated, setHideIsolated] = useState(false);
  const [density, setDensity] = useState(1); // 布局密度（0.6 紧凑 ~ 1.8 舒展）
  const [query, setQuery] = useState("");
  const [minRefs, setMinRefs] = useState(() => loadGraphSettings().minRefs);
  const [showTags, setShowTags] = useState(() => loadGraphSettings().showTags);
  const [showFiles, setShowFiles] = useState(() => loadGraphSettings().showFiles);
  const [showFolders, setShowFolders] = useState(() => loadGraphSettings().showFolders);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [exploreHistory, setExploreHistory] = useState<string[]>([]);
  // 配置持久化（siyuan：图谱配置保存，刷新不丢）
  useEffect(() => {
    saveGraphSettings({ minRefs, showTags, showFiles, showFolders });
  }, [minRefs, showTags, showFiles, showFolders]);

  const adjMapRef = useRef<Map<string, Set<string>>>(new Map());
  const degreeMapRef = useRef<Map<string, number>>(new Map());
  const allNodesRef = useRef<Array<{ id: string; data: KgNodeValue }>>([]);
  const allEdgesRef = useRef<Array<{ id: string; source: string; target: string; data: { type?: string } }>>([]);
  const selectedIdRef = useRef<string | null>(null);
  const historyRef = useRef<string[]>([]);
  const highlightIdRef = useRef(highlightId);

  useEffect(() => {
    highlightIdRef.current = highlightId;
  }, [highlightId]);

  // 预处理：度、邻接表、分组色
  const prepared = useMemo(() => {
    const nodes = (data?.nodes || []).map((n) => ({
      id: String(n.id ?? ""),
      data: { label: n.label, type: n.type || "file", relPath: n.relPath, rootIdx: n.rootIdx, group: n.group || "root" },
    }));
    const edges = (data?.edges || []).map((e, i) => ({
      id: `e${i}`,
      source: String(e.source ?? ""),
      target: String(e.target ?? ""),
      data: { type: e.type || "link" },
    }));
    const adj = new Map<string, Set<string>>();
    const deg = new Map<string, number>();
    for (const n of nodes) adj.set(n.id, new Set<string>());
    for (const e of edges) {
      const s = adj.get(e.source);
      const t = adj.get(e.target);
      if (s) s.add(e.target);
      if (t) t.add(e.source);
      deg.set(e.source, (deg.get(e.source) || 0) + 1);
      deg.set(e.target, (deg.get(e.target) || 0) + 1);
    }
    const groupColor = new Map<string, string>();
    for (const n of nodes) {
      if (n.data.type !== "file") continue;
      const g = n.data.group || "root";
      if (!groupColor.has(g)) groupColor.set(g, GROUP_COLORS[hashStr(g) % GROUP_COLORS.length] || GROUP_COLORS[0] || "#7aa2f7");
    }
    return { nodes, edges, adj, deg, groupColor };
  }, [data]);

  const { nodes: allNodes, edges: allEdges } = prepared;

  const nodeById = useMemo(() => new Map(allNodes.map((n) => [n.id, n])), [allNodes]);

  // 当前探索中心的一跳关系，供右侧面板使用；只计算当前节点的关联边。
  const relationGroups = useMemo(() => {
    if (!selectedId) return [];
    const groups = new Map<string, Array<{ edge: { id: string; source: string; target: string; data: { type?: string } }; node: { id: string; data: KgNodeValue } }>>();
    for (const e of allEdges) {
      if (e.source !== selectedId && e.target !== selectedId) continue;
      const nodeId = e.source === selectedId ? e.target : e.source;
      const node = nodeById.get(nodeId);
      if (!node) continue;
      const type = e.data.type || "link";
      if (!groups.has(type)) groups.set(type, []);
      if (!groups.get(type)?.some((item) => item.node.id === node.id)) {
        groups.get(type)?.push({ edge: e, node });
      }
    }
    return [...groups.entries()]
      .map(([type, items]) => ({ type, label: RELATION_LABELS[type] || type, items }))
      .sort((a, b) => (Object.keys(RELATION_LABELS).indexOf(a.type) - Object.keys(RELATION_LABELS).indexOf(b.type)));
  }, [allEdges, nodeById, selectedId]);

  // 局部图谱：focusId 非空时只渲染其 1-hop 子图（对齐 siyuan 局部图）
  const subSet = useMemo(() => {
    if (!focusId) return null;
    const adj = prepared.adj.get(focusId);
    if (!adj) return null;
    return new Set([focusId, ...adj]);
  }, [focusId, prepared]);

  // 记录全量（分批渲染时用）
  useEffect(() => {
    allNodesRef.current = allNodes;
    allEdgesRef.current = allEdges;
    adjMapRef.current = prepared.adj;
    degreeMapRef.current = prepared.deg;
  }, [allNodes, allEdges, prepared]);

  // 主题色（渲染时读取 CSS 变量，跟随暗/亮主题）
  const cs = typeof document !== "undefined" ? getComputedStyle(document.documentElement) : null;
  const themeTextColor = cs?.getPropertyValue("--text").trim() || "#d4d4d4";
  const themeMutedColor = cs?.getPropertyValue("--muted").trim() || "#a0a0b0";
  const themeAccentColor = cs?.getPropertyValue("--accent").trim() || "#8abeb7";

  const nodeSize = useCallback((d: NodeData): number => {
    const t = kgDatum(d).type;
    if (t === "tag") return 7;
    if (t === "folder") return 9;
    // 对数缩放（对齐 siyuan getGraphNodeSize：log2(被引用数+1)+1）× base，避免大度节点尺寸爆炸
    const deg = degreeMapRef.current.get(d.id) || 0;
    return Math.min(56, (Math.log2(deg + 1) + 0.6) * 12);
  }, []);

  const nodeFill = useCallback((d: NodeData): string => {
    if (kgDatum(d).type === "tag") return TAG_COLOR;
    if (kgDatum(d).type === "folder") return FOLDER_COLOR;
    return prepared.groupColor.get(kgDatum(d).group || "root") || GROUP_COLORS[0] || "#7aa2f7";
  }, [prepared]);

  const labelText = useCallback((d: NodeData): string => {
    const label = kgDatum(d).label || "";
    return label.length > 18 ? label.slice(0, 17) + "…" : label;
  }, []);

  const fitGraph = useCallback((): void => {
    const g = graphRef.current;
    if (!g) return;
    g.fitView({ when: "always", direction: "both" }, { duration: 300, easing: "ease-in-out" }).catch(() => {});
  }, []);

  // 只更新元素状态，不重建 G6 实例；这是点击探索保持布局稳定的关键。
  const applyExploreState = useCallback((id: string | null): void => {
    const g = graphRef.current;
    if (!g) return;
    const adj = id ? (adjMapRef.current.get(id) || new Set<string>()) : new Set<string>();
    for (const n of allNodesRef.current) {
      const states = !id
        ? (n.id === highlightIdRef.current ? ["focus"] : [])
        : n.id === id
          ? ["focus"]
          : adj.has(n.id)
            ? ["neighbor"]
            : ["dim"];
      try { void g.setElementState(n.id, states); } catch {}
    }
    for (const e of allEdgesRef.current) {
      const near = !!id && (e.source === id || e.target === id);
      try { void g.setElementState(e.id, near ? ["near"] : id ? ["dim-edge"] : []); } catch {}
    }
  }, []);

  const selectNode = useCallback((id: string | null, { pushHistory = true, focus = true } = {}): void => {
    if (!id) return;
    const g = graphRef.current;
    const current = selectedIdRef.current;
    if (current === id) {
      if (focus) {
        try { void g?.focusElement(id, { duration: 260 }); } catch {}
      }
      applyExploreState(id);
      return;
    }
    if (pushHistory && current) {
      historyRef.current = [...historyRef.current, current].slice(-30);
      setExploreHistory(historyRef.current);
    }
    selectedIdRef.current = id;
    setSelectedId(id);
    applyExploreState(id);
    if (focus) {
      try { void g?.focusElement(id, { duration: 260 }); } catch {}
    }
  }, [applyExploreState]);

  const clearSelection = useCallback((): void => {
    selectedIdRef.current = null;
    historyRef.current = [];
    setSelectedId(null);
    setExploreHistory([]);
    applyExploreState(null);
  }, [applyExploreState]);

  const goBack = useCallback((): void => {
    const history = [...historyRef.current];
    const previous = history.pop();
    if (!previous) return;
    historyRef.current = history;
    setExploreHistory(history);
    selectedIdRef.current = previous;
    setSelectedId(previous);
    applyExploreState(previous);
    try { void graphRef.current?.focusElement(previous, { duration: 260 }); } catch {}
  }, [applyExploreState]);

  // 已选中节点被过滤移除时清空探索态（数据/过滤器变化后）
  useEffect(() => {
    if (selectedId && !nodeById.has(selectedId)) clearSelection();
  }, [clearSelection, nodeById, selectedId]);

  // 创建图谱
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setGraphError("");
    setGraphReady(false);

    const visibleNodes = allNodes.filter((n) => {
      const t = n.data.type;
      if (t === "tag" && !showTags) return false;
      if (t === "folder" && !showFolders) return false;
      if (t === "file" && !showFiles) return false;
      // minRefs：引用数低于阈值的文件节点剔除（局部图谱聚焦节点保留）
      if (t === "file" && minRefs > 0) {
        const deg = degreeMapRef.current.get(n.id) || 0;
        if (deg < minRefs && !subSet?.has(n.id)) return false;
      }
      if (hideIsolated && t === "file" && (degreeMapRef.current.get(n.id) || 0) <= 0) return false;
      return true;
    });
    const localIds = subSet || null;
    const scopeNodes = localIds ? visibleNodes.filter((n) => localIds.has(n.id)) : visibleNodes;
    const scopeIds = new Set(scopeNodes.map((n) => n.id));
    const scopeEdges = allEdges.filter((e) => scopeIds.has(e.source) && scopeIds.has(e.target));

    const batch = scopeNodes.length > BATCH_SIZE;
    const initialNodes = batch ? scopeNodes.slice(0, BATCH_SIZE) : scopeNodes;
    const initialEdgeIds = new Set<string>();
    if (batch) {
      const ids = new Set(initialNodes.map((n) => n.id));
      for (const e of scopeEdges) if (ids.has(e.source) && ids.has(e.target)) initialEdgeIds.add(e.id);
    }
    const initialEdges = batch ? scopeEdges.filter((e) => initialEdgeIds.has(e.id)) : scopeEdges;

    const g = new Graph({
      container: el,
      autoResize: true,
      data: {
        // 黄金角螺旋初始布局（对齐 siyuan createInitialPositions：均匀展开，避免初始化堆叠）
        nodes: initialNodes.map((n, i) => {
          const golden = Math.PI * (3 - Math.sqrt(5));
          let hash = 2166136261;
          for (let j = 0; j < n.id.length; j++) { hash ^= n.id.charCodeAt(j); hash = Math.imul(hash, 16777619); }
          hash >>>= 0;
          const angle = i * golden + (hash % 1024) / 1024;
          const radius = Math.sqrt(i + 1) * Math.max(40, 220 * 0.35);
          return { ...n, x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
        }),
        edges: initialEdges,
      },
      node: {
        style: {
          size: nodeSize,
          fill: nodeFill,
          labelText,
          labelPlacement: "bottom",
          labelFontSize: (d: NodeData) => (kgDatum(d).type === "file" ? 11 : 9),
          labelFill: (d: NodeData) => (kgDatum(d).type === "file" ? themeTextColor : themeMutedColor),
          labelMaxWidth: 160,
          labelWordWrap: true,
          lineWidth: 1.5,
          stroke: (d: NodeData) => (d.id === highlightIdRef.current ? themeTextColor : "rgba(255,255,255,0.08)"),
          cursor: (d: NodeData) => (kgDatum(d).type === "file" || kgDatum(d).type === "tag" ? "pointer" : "default"),
        },
        animation: {
          update: [{ fields: ["x", "y", "fill", "stroke"], duration: 400, easing: "ease-out" }],
          enter: [{ fields: ["x", "y", "opacity"], duration: 300, easing: "ease-out" }],
        },
        state: {
          dim: { opacity: 0.12 },
          neighbor: { lineWidth: 2, stroke: themeTextColor },
          hover: { shadowBlur: 12, shadowColor: themeAccentColor },
          focus: { lineWidth: 2.5, stroke: themeTextColor, shadowBlur: 16, shadowColor: themeAccentColor },
        },
      },
      edge: {
        style: {
          stroke: (d: EdgeData) => EDGE_COLORS[kgDatum(d).type ?? ""] || "#33415c",
          lineWidth: (d: EdgeData) => (kgDatum(d).type === "link" ? 1.2 : kgDatum(d).type === "similar" ? 0.5 : 0.7),
          opacity: (d: EdgeData) => (kgDatum(d).type === "similar" ? 0.25 : 0.55),
          endArrow: false,
        },
        animation: {
          update: [{ fields: ["sourceNode", "targetNode", "stroke"], duration: 400, easing: "ease-out" }],
          enter: [{ fields: ["sourceNode", "targetNode", "opacity"], duration: 300, easing: "ease-out" }],
        },
        state: {
          "dim-edge": { opacity: 0.04 },
          near: { opacity: 0.95 },
        },
      },
      layout: {
        // 使用 d3-force 的 Barnes-Hut 近似，避免自定义 force 在大图上长期占满主线程
        type: "d3-force",
        linkDistance: 190 * density,
        nodeStrength: -220 * density,
        edgeStrength: 0.16 / density,
        theta: 0.9,
        distanceMax: 1200,
        preventOverlap: true,
        nodeSize: 22 * density,
        nodeSpacing: 8 * density,
        collideStrength: 0.65,
        collideIterations: 1,
        alpha: 0.8,
        alphaDecay: 0.08,
        alphaMin: 0.03,
        velocityDecay: 0.7,
      },
      behaviors: [
        "drag-canvas",
        "zoom-canvas",
        "drag-element",
      ],
    });

    let fitTimer: ReturnType<typeof setTimeout> | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    const scheduleFit = (delay = 60): void => {
      if (fitTimer) clearTimeout(fitTimer);
      fitTimer = setTimeout(() => {
        if (!disposed) fitGraph();
      }, delay);
    };
    try { g.once?.("afterlayout", () => scheduleFit(60)); } catch {}
    const resizeObserver = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => scheduleFit(80), 80);
      })
      : null;
    resizeObserver?.observe(el);

    // 分批渲染：稳定后再追加剩余节点/边（对齐 siyuan 分批策略）
    g.render().then(() => {
      if (disposed) return;
      setGraphReady(true);
      const canvases = el.querySelectorAll("canvas");
      canvases.forEach((c) => { c.style.background = "transparent"; });
      if (batch && scopeNodes.length > BATCH_SIZE) {
        const restNodes = scopeNodes.slice(BATCH_SIZE);
        const restIds = new Set(restNodes.map((n) => n.id));
        // 追加节点时保留跨批次边，避免首批节点与后续节点的关系丢失
        const restEdges = scopeEdges.filter((e) => restIds.has(e.source) || restIds.has(e.target));
        g.addData({ nodes: restNodes, edges: restEdges });
      }
      // afterlayout 未触发时的兜底适配；分批图等待追加布局完成
      scheduleFit(batch ? 800 : 180);
      // 局部图谱：聚焦中心节点
      if (focusId) {
        try { void g.focusElement(focusId, { duration: 300 }); } catch {}
      }
    }).catch((e: unknown) => {
      if (disposed) return;
      console.error("G6 render error:", e);
      setGraphError("关系图谱渲染失败，请点击“重新布局”重试。");
      setGraphReady(false);
    });

    // hover 只做轻量临时提示；持久化的邻接高亮由单击探索负责。
    const hoverActivate = (id: string): void => {
      const selected = selectedIdRef.current;
      try { void g.setElementState(id, id === selected ? ["focus", "hover"] : ["hover"]); } catch {}
    };
    const clearHover = (): void => {
      applyExploreState(selectedIdRef.current);
    };

    g.on("node:pointerenter", (evt: unknown) => {
      const id = evtNodeId(evt);
      if (id) hoverActivate(id);
    });
    g.on("node:pointerleave", clearHover);

    // 单击进入探索态；双击才打开文档，避免打开文档触发图谱重建。
    g.on("node:click", (evt: unknown) => {
      const id = evtNodeId(evt);
      if (!id) return;
      selectNode(id);
    });
    g.on("node:dblclick", (evt: unknown) => {
      const id = evtNodeId(evt);
      const nodeData = allNodesRef.current.find((n) => n.id === id)?.data;
      if (nodeData) onOpenNode?.(nodeData);
    });
    g.on("canvas:click", clearSelection);

    // 缩放联动：只在跨过阈值时批量更新一次标签，避免每个 wheel 事件逐节点更新。
    let zoomLabelFrame: number | null = null;
    let zoomLabelsVisible = true;
    const requestFrame = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (cb: () => void) => setTimeout(cb, 0) as unknown as number;
    const cancelFrame = typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : ((id: number) => clearTimeout(id)) as typeof cancelAnimationFrame;
    const applyZoomLabels = (): void => {
      const zoom = g.getZoom();
      const show = zoom > 0.55;
      if (show === zoomLabelsVisible) return;
      zoomLabelsVisible = show;
      if (zoomLabelFrame) cancelFrame(zoomLabelFrame);
      zoomLabelFrame = requestFrame(() => {
        zoomLabelFrame = null;
        try {
          g.updateNodeData(allNodesRef.current.map((n) => ({
            id: n.id,
            style: { labelText: show ? labelText({ id: n.id, data: n.data as Record<string, unknown> }) : "" },
          })));
        } catch {}
      });
    };
    g.on("wheel", applyZoomLabels);

    graphRef.current = g;
    return () => {
      disposed = true;
      if (fitTimer) clearTimeout(fitTimer);
      if (resizeTimer) clearTimeout(resizeTimer);
      if (zoomLabelFrame) cancelFrame(zoomLabelFrame);
      resizeObserver?.disconnect();
      try { g.destroy(); } catch {}
      graphRef.current = null;
      setGraphReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, hideIsolated, focusId, subSet, density, minRefs, showTags, showFiles, showFolders, applyExploreState, selectNode, clearSelection, onOpenNode]);

  // 高亮定位（外部选中文档时）
  useEffect(() => {
    const g = graphRef.current;
    if (!g || !highlightId) return;
    try {
      void g.focusElement(highlightId, { duration: 300 });
      if (selectedIdRef.current) applyExploreState(selectedIdRef.current);
      else void g.setElementState(highlightId, ["focus"]);
    } catch {}
  }, [applyExploreState, highlightId]);

  // 搜索定位节点
  const doFocus = useCallback((): void => {
    const g = graphRef.current;
    if (!g || !query.trim()) return;
    const q = query.trim().toLowerCase();
    const n = allNodesRef.current.find((x) => String(x.data.label || "").toLowerCase().includes(q));
    if (!n) return;
    selectNode(n.id, { pushHistory: true, focus: true });
    try {
      void g.focusElement(n.id, { duration: 300 });
    } catch {}
  }, [query, selectNode]);

  const selectedNode = selectedId ? nodeById.get(selectedId) : null;
  const relationCount = relationGroups.reduce((sum, group) => sum + group.items.length, 0);

  return (
    <div className="kb-graph-wrap">
      <div className="kb-graph-tools">
        <input
          className="kb-graph-search"
          placeholder="搜索节点定位…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && doFocus()}
        />
        <button className="btn-sm" onClick={fitGraph} disabled={!graphReady}>适配视图</button>
        <button className="btn-sm" onClick={() => { setQuery(""); fitGraph(); }} disabled={!graphReady}>重置视图</button>
        <button className="btn-sm" onClick={goBack} disabled={!exploreHistory.length} title="回到上一个探索节点">← 返回</button>
        <button className="btn-sm" onClick={clearSelection} disabled={!selectedId} title="清除探索状态并恢复全图">回到全图</button>
        <label className="kb-check">
          <input type="checkbox" checked={hideIsolated} onChange={(e) => setHideIsolated(e.target.checked)} />
          隐藏孤立节点
        </label>
        <span className="kb-filter-block" title="按类型过滤（siyuan 式）">
          <label className="kb-check kb-type-check"><input type="checkbox" checked={showFiles} onChange={(e) => setShowFiles(e.target.checked)} />文档</label>
          <label className="kb-check kb-type-check"><input type="checkbox" checked={showTags} onChange={(e) => setShowTags(e.target.checked)} />标签</label>
          <label className="kb-check kb-type-check"><input type="checkbox" checked={showFolders} onChange={(e) => setShowFolders(e.target.checked)} />目录</label>
        </span>
        <span className="kb-minrefs" title="最小引用数过滤（siyuan minRefs）：引用数低于阈值的文档节点隐藏">
          <span className="kb-density-label">最少引用</span>
          <input
            type="range"
            min="0" max="8" step="1"
            value={minRefs}
            onChange={(e) => setMinRefs(Number(e.target.value))}
          />
          <span className="kb-density-val">{minRefs}</span>
        </span>
        <span className="kb-density" title="调整节点间距">
          <span className="kb-density-label">间距</span>
          <input
            type="range"
            min="0.6" max="1.8" step="0.1"
            value={density}
            onChange={(e) => setDensity(Number(e.target.value))}
          />
          <span className="kb-density-val">{density.toFixed(1)}×</span>
        </span>
      </div>
      <div className="kb-graph" ref={containerRef}>
        {graphError && <div className="kb-graph-error">{graphError}</div>}
        <div className="kb-graph-legend">
          <span><i style={{ background: EDGE_COLORS.link }} />双向链接</span>
          <span><i style={{ background: EDGE_COLORS.similar }} />内容相似</span>
          <span><i style={{ background: EDGE_COLORS.tag }} />标签</span>
          <span><i style={{ background: EDGE_COLORS.folder }} />目录</span>
        </div>
        {selectedNode && (
          <aside className="kb-graph-relations" aria-label="当前节点关联知识">
            <div className="kb-graph-relations-head">
              <div className="kb-graph-relations-kicker">当前探索</div>
              <div className="kb-graph-relations-title" title={selectedNode.data.relPath || selectedNode.data.label}>
                {selectedNode.data.label || "未命名节点"}
              </div>
              <div className="kb-graph-relations-meta">
                {selectedNode.data.type === "file" ? "文档" : selectedNode.data.type === "tag" ? "标签" : "目录"}
                {selectedNode.data.relPath ? ` · ${selectedNode.data.relPath}` : ""}
                {` · ${relationCount} 条关联`}
              </div>
              <div className="kb-graph-relations-hint">单击关系继续探索，双击节点打开文档</div>
            </div>
            <div className="kb-graph-relations-body">
              {relationGroups.length === 0 && <div className="kb-graph-relations-empty">这个节点暂时没有可展示的关联知识。</div>}
              {relationGroups.map((group) => (
                <section className="kb-graph-relation-group" key={group.type}>
                  <div className="kb-graph-relation-group-title">
                    <i style={{ background: EDGE_COLORS[group.type] || "#5a6a85" }} />
                    {group.label}<span>{group.items.length}</span>
                  </div>
                  <div className="kb-graph-relation-list">
                    {group.items.slice(0, 40).map(({ node }) => (
                      <button
                        type="button"
                        className="kb-graph-relation-item"
                        key={`${group.type}:${node.id}`}
                        onClick={() => selectNode(node.id)}
                        title={node.data.relPath || node.data.label}
                      >
                        <span className="kb-graph-relation-dot" data-type={node.data.type} />
                        <span className="kb-graph-relation-name">{node.data.label || "未命名节点"}</span>
                        <span className="kb-graph-relation-arrow">›</span>
                      </button>
                    ))}
                    {group.items.length > 40 && <div className="kb-graph-relations-more">还有 {group.items.length - 40} 条关联</div>}
                  </div>
                </section>
              ))}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
