/**
 * 知识库脑图（思维导图视图）—— MindMap.jsx 逐行等价 TS 化（F5-8，BRD-009）。
 *
 * 布局：
 *   左侧大纲（缩进列表）+ 右侧 G6 树状脑图（indented 布局）
 *   双向联动：点击大纲 → 脑图高亮；点击脑图节点 → 大纲高亮 + 打开文档
 *   目录节点可展开/折叠
 *
 * 迁移留档：
 * - `t?.tree` 为既有死路径（/api/kb/tree 现返回 getTreeLevel 的 { dirs, files }，无
 *   tree 字段，见 types.ts 留档）：TS 侧经显式 cast 保留原判断形态，行为不变。
 * - `graph.getElementById` 在 G6 v5.1.1 已无此方法（旧端同样抛错被 try/catch 吞掉），
 *   高亮联动 effect 的命中分支与旧端一致地静默失效——忠实转录。
 * - G6 样式回调经 mmDatum() 收窄 NodeData.data（同 knowledge-graph.tsx 约定）。
 */
import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { Graph } from "@antv/g6";
import type { NodeData } from "@antv/g6";
import Icon from "../../components/Icon";
import MarkdownBody from "../../components/MarkdownBody";
import { kbTree } from "../../api/client-api";
import type { KbRootMeta, KbTreeItem } from "./types";

const DIR_COLOR = "#e0af68";
const FILE_COLOR = "#7aa2f7";
const HIGHLIGHT_COLOR = "#f7768e";

/** G6 NodeData → 脑图节点数据视图收窄（label/type/parentId）。 */
interface MindNodeValue { label?: string; type?: string; parentId?: string | null; [key: string]: unknown }
function mmDatum(d: NodeData): MindNodeValue {
  return (d.data || {}) as MindNodeValue;
}

export interface MindMapProps {
  roots: KbRootMeta[];
  onSelectDoc?: (relPath: string, rootIdx?: number | null) => void;
  highlightPath?: string | null;
  rootIdx?: number | null;
  doc?: { relPath?: string; title?: string; tags?: string[]; rootName?: string; content?: string } | null;
}

interface MindTreeEntry { rootIdx: number; rootName: string; tree: KbTreeItem[] }
interface MindOutlineRow { key: string; name: string; type?: string; depth: number; relPath?: string; rootIdx: number | null; isDir: boolean }

export default function MindMap({ roots, onSelectDoc, highlightPath, rootIdx: currentRootIdx, doc }: MindMapProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<Graph | null>(null);
  const dataRef = useRef<{ nodes: Array<{ id: string; data: MindNodeValue }>; edges: Array<{ source: string; target: string; data: Record<string, never> }> }>({ nodes: [], edges: [] });
  const [trees, setTrees] = useState<MindTreeEntry[]>([]); // [{rootIdx, rootName, tree}]
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({}); // dirKey -> bool
  const [activePath, setActivePath] = useState<string | null>(null);

  // 加载所有根目录的完整树
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      const rootsList = roots || [];
      const out: MindTreeEntry[] = [];
      for (let i = 0; i < rootsList.length; i++) {
        const root = rootsList[i];
        if (!root) continue;
        try {
          const t = await kbTree(root.index);
          const tree = (t as unknown as { tree?: KbTreeItem[] }).tree; // 既有死路径留档见 types.ts
          if (alive && tree) out.push({ rootIdx: root.index, rootName: root.name, tree });
        } catch {}
      }
      if (!alive) return;
      // 构建 G6 数据：每个根为顶层节点，dir/file 为子节点
      // 注意：不同父目录下可能有同名子目录，id 必须用完整路径
      const nodes: Array<{ id: string; data: MindNodeValue }> = [];
      const edges: Array<{ source: string; target: string; data: Record<string, never> }> = [];
      const pushNode = (id: string, label: string, type: string, parentId: string | null): void => {
        nodes.push({ id, data: { label, type, parentId } });
        if (parentId) edges.push({ source: parentId, target: id, data: {} });
      };
      const walk = (items: KbTreeItem[] | undefined, parentPath: string, rootIdx: number): void => {
        for (const it of items || []) {
          const fullPath = parentPath ? `${parentPath}/${it.name}` : it.name;
          const id = `${rootIdx}/${fullPath}`;
          if (it.type === "dir") {
            pushNode(id, it.name, "dir", parentPath ? `${rootIdx}/${parentPath}` : `root/${rootIdx}`);
            walk(it.children, fullPath, rootIdx);
          } else {
            pushNode(id, it.name, "file", parentPath ? `${rootIdx}/${parentPath}` : `root/${rootIdx}`);
          }
        }
      };
      for (const t of out) {
        const rootId = `root/${t.rootIdx}`;
        pushNode(rootId, t.rootName, "root", null);
        walk(t.tree, "", t.rootIdx);
      }
      dataRef.current = { nodes, edges };
      setTrees(out);
      setLoading(false);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roots]);

  // 大纲：按折叠状态重建（目录可展开/折叠）
  const outline = useMemo(() => {
    const build = (items: KbTreeItem[] | undefined, depth: number, parentKey: string): MindOutlineRow[] => {
      const out: MindOutlineRow[] = [];
      for (const it of items || []) {
        const key = `${parentKey}/${it.name}`;
        const isDir = it.type === "dir";
        out.push({ key, name: it.name, type: it.type, depth, relPath: it.relPath, rootIdx: it.rootIdx ?? null, isDir });
        if (isDir && !collapsed[key] && it.children?.length) {
          out.push(...build(it.children, depth + 1, key));
        }
      }
      return out;
    };
    let rows: MindOutlineRow[] = [];
    for (const t of trees) rows = rows.concat(build(t.tree, 0, `r${t.rootIdx}`));
    return rows;
  }, [trees, collapsed]);

  // 渲染/更新脑图
  useEffect(() => {
    if (!containerRef.current) return undefined;
    if (!dataRef.current.nodes.length) return undefined;
    const graph = new Graph({
      container: containerRef.current,
      autoResize: true,
      data: dataRef.current,
      node: {
        style: {
          size: 10,
          labelText: (d: NodeData) => mmDatum(d).label ?? "",
          labelPlacement: "right",
          labelOffsetX: 8,
          labelFontSize: 11,
          fill: (d: NodeData) => {
            if (mmDatum(d).type === "root") return DIR_COLOR;
            if (mmDatum(d).type === "dir") return DIR_COLOR;
            return FILE_COLOR;
          },
          stroke: "#00000000",
          lineWidth: 0,
          labelFill: (d: NodeData) => (mmDatum(d).type === "root" ? "#e0af68" : "#c0caf5"),
          labelFontWeight: (d: NodeData) => (mmDatum(d).type === "root" ? 700 : 400),
        },
      },
      edge: {
        style: { stroke: "#3d6080", lineWidth: 1, endArrow: false },
      },
      layout: {
        type: "indented",
        direction: "LR",
        dropCap: false,
        indent: 24,
        getVGap: () => 4,
        getHGap: () => 30,
      },
      behaviors: ["drag-canvas", "zoom-canvas"],
    });
    graph.render();
    graphRef.current = graph;
    return () => {
      try { graph.destroy(); } catch {}
      graphRef.current = null;
    };
  }, [loading]);

  // 点击脑图节点 → 大纲高亮 + 打开文档
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return undefined;
    const onClick = (evt: { target?: { id?: string; data?: MindNodeValue } }): void => {
      const node = evt.target;
      const d = node?.data;
      if (!d || d.type !== "file") return;
      setActivePath(node?.id ?? null);
      const rootIdx = parseInt(String(node?.id ?? "").split("/")[0] ?? "", 10);
      onSelectDoc?.(String(d.label ?? ""), Number.isNaN(rootIdx) ? 0 : rootIdx);
    };
    graph.on("node:click", onClick as never);
    return () => { graph.off("node:click", onClick as never); };
  }, [onSelectDoc]);

  // 外部高亮（从知识库文档切换联动）
  useEffect(() => {
    if (!highlightPath) return;
    const id = `${currentRootIdx ?? 0}/${highlightPath}`;
    setActivePath(id);
    const graph = graphRef.current;
    if (!graph) return;
    try {
      void graph.setElementState(id, ["selected"]);
      // getElementById 为 G6 v4 形态，v5.1.1 已无此方法——旧端同样抛错静默（try/catch）
      const n = (graph as unknown as { getElementById?: (id: string) => unknown }).getElementById?.(id);
      if (n) void (graph as unknown as { focusElement: (id: string, opts: { animation: boolean }) => void }).focusElement(id, { animation: false });
    } catch {}
  }, [highlightPath, currentRootIdx]);

  const toggleCollapse = useCallback((key: string): void => {
    setCollapsed((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      return next;
    });
  }, []);

  const docTags = doc?.tags || [];

  return (
    <div className="kb-mindmap">
      <div className="kb-mindmap-outline">
        <div className="kb-mindmap-outline-head">
          <Icon name="list" size={12} /> 大纲
        </div>
        <div className="kb-mindmap-outline-list">
          {loading && <div className="kb-mindmap-loading">加载中…</div>}
          {!loading && outline.map((row) => (
            <div
              key={row.key}
              className={`kb-mindmap-row ${row.isDir ? "dir" : "file"} ${activePath === `${row.rootIdx ?? 0}/${row.relPath}` ? "active" : ""}`}
              style={{ paddingLeft: row.depth * 14 + 8 }}
              onClick={() => {
                if (row.isDir) toggleCollapse(row.key);
                else onSelectDoc?.(row.relPath || "", row.rootIdx);
              }}
            >
              <span className="kb-mindmap-caret">{row.isDir ? (collapsed[row.key] ? "▸" : "▾") : ""}</span>
              <Icon name={row.isDir ? "folder" : "file"} size={12} />
              <span className="kb-mindmap-name" title={row.name}>{row.name}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="kb-mindmap-canvas" ref={containerRef}>
        {loading && <div className="kb-mindmap-loading">脑图加载中…</div>}
      </div>
      {doc && (
        <div className="kb-mindmap-preview">
          <div className="kb-doc-titlebar">
            <span className="kb-doc-title" title={doc.relPath}>{doc.title || doc.relPath}</span>
            {docTags.length > 0 && (
              <div className="kb-doc-tags">{docTags.map((t) => <span key={t} className="tag">#{t}</span>)}</div>
            )}
            <div className="kb-doc-breadcrumb">{doc.rootName || ""}{doc.relPath ? ` / ${doc.relPath}` : ""}</div>
          </div>
          <div className="kb-doc-body kb-preview-scroll">
            <MarkdownBody>{doc.content}</MarkdownBody>
          </div>
        </div>
      )}
    </div>
  );
}

// HIGHLIGHT_COLOR：旧文件模块常量（脑图选中高亮备用色），忠实保留避免语义漂移
export { HIGHLIGHT_COLOR };
