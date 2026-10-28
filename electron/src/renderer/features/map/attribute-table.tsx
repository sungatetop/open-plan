/**
 * 属性表弹窗（QGIS 风格）：字段表格 / 搜索 / 排序 / 行定位 / 导出 CSV。
 *
 * 与 client/src/components/AttributeTable.jsx 逐行等价迁移（F5-5，BRD-009）：
 * - 数据源 mapGetLayer → IPC 通道 op:map:layer:get（api/client-api.ts）；
 * - 图标 ./Icon.jsx → components/Icon（f3-icon-parity 对拍同源）；
 * - 样式类（lp-attr-*）由 workbench 引入的 client/src/styles.css 提供，零迁移。
 */
import { useState, useEffect, useCallback, useMemo } from "react";
import Icon from "../../components/Icon";
import { mapGetLayer } from "../../api/client-api";

const PAGE_SIZE = 100;

/** 单行：要素 id + 属性键值 + 几何（定位用，语义与旧版一致）。 */
interface AttrRow {
  id: unknown;
  props: Record<string, unknown>;
  geom: unknown;
}

interface AttributeTableProps {
  project: string;
  layerId: string;
  layerName?: string;
  onClose: () => void;
  onLocate?: (row: AttrRow) => void;
}

export default function AttributeTable({ project, layerId, layerName, onClose, onLocate }: AttributeTableProps) {
  const [data, setData] = useState<{ fields: string[]; rows: AttrRow[] } | null>(null);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ field: string; dir: "asc" | "desc" } | null>(null);
  const [page, setPage] = useState(0);
  const [selIdx, setSelIdx] = useState<AttrRow | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const g = await mapGetLayer(project, layerId);
        if (!g?.features) { setErr("图层无数据"); return; }
        const feats = g.features as Array<{ id?: unknown; properties?: Record<string, unknown>; geometry?: unknown }>;
        const fields = [...new Set(feats.flatMap((f) => Object.keys(f.properties || {})))];
        const rows: AttrRow[] = feats.map((f) => ({ id: f.id ?? null, props: f.properties || {}, geom: f.geometry }));
        setData({ fields, rows });
      } catch (e) {
        setErr("加载属性表失败: " + (e instanceof Error ? e.message : String(e)));
      }
    })();
  }, [project, layerId]);

  // 搜索 + 排序
  const filtered = useMemo(() => {
    if (!data) return [] as AttrRow[];
    let rows = data.rows;
    if (q.trim()) {
      const kw = q.trim().toLowerCase();
      rows = rows.filter((r) => Object.values(r.props).some((v) => String(v ?? "").toLowerCase().includes(kw)));
    }
    if (sort) {
      const { field, dir } = sort;
      rows = [...rows].sort((a, b) => {
        const va = a.props[field], vb = b.props[field];
        if (va == null) return 1;
        if (vb == null) return -1;
        const cmp = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb));
        return dir === "asc" ? cmp : -cmp;
      });
    }
    return rows;
  }, [data, q, sort]);

  const pageRows = useMemo(() => filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), [filtered, page]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));

  useEffect(() => { setPage(0); setSelIdx(null); }, [q, sort]);

  const exportCsv = useCallback(() => {
    if (!data) return;
    const head = data.fields.join(",");
    const lines = data.rows.map((r) => data.fields.map((f) => {
      const v = r.props[f];
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(","));
    const blob = new Blob(["\uFEFF" + [head, ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${layerId}-属性表.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, [data, layerId]);

  const handleLocate = useCallback((row: AttrRow) => {
    setSelIdx(row);
    onLocate?.(row);
  }, [onLocate]);

  return (
    <div className="lp-attr-backdrop" onClick={onClose}>
      <div className="lp-attr" onClick={(e) => e.stopPropagation()}>
        <div className="lp-attr-head">
          <Icon name="list" size={14} />
          <span className="lp-attr-title">{layerName || layerId} — 属性表</span>
          {data && <span className="lp-attr-count">{filtered.length} / {data.rows.length} 要素</span>}
          <div className="lp-attr-actions">
            <input
              className="lp-attr-search"
              placeholder="搜索属性值…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <button className="btn-sm" onClick={exportCsv} title="导出 CSV"><Icon name="download" size={12} /> 导出</button>
            <button className="mp-op" onClick={onClose} title="关闭"><Icon name="close" size={14} /></button>
          </div>
        </div>
        {err ? (
          <div className="lp-attr-err">{err}</div>
        ) : !data ? (
          <div className="lp-attr-loading">加载属性数据…</div>
        ) : (
          <>
            <div className="lp-attr-table-wrap">
              <table className="lp-attr-table">
                <thead>
                  <tr>
                    <th className="lp-attr-idx">#</th>
                    {data.fields.map((f) => (
                      <th key={f} onClick={() => setSort((s) => ({ field: f, dir: s?.field === f && s.dir === "asc" ? "desc" : "asc" }))} title="点击排序">
                        {f}
                        {sort?.field === f && <span className="lp-attr-sort">{sort.dir === "asc" ? "▲" : "▼"}</span>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((r, i) => {
                    const globalIdx = page * PAGE_SIZE + i;
                    return (
                      <tr key={String(r.id ?? globalIdx)} className={selIdx === r ? "selected" : ""} onClick={() => handleLocate(r)} title="点击定位到地图">
                        <td className="lp-attr-idx">{globalIdx + 1}</td>
                        {data.fields.map((f) => (
                          <td key={f}>{r.props[f] == null ? "" : String(r.props[f])}</td>
                        ))}
                      </tr>
                    );
                  })}
                  {pageRows.length === 0 && (
                    <tr><td colSpan={data.fields.length + 1} className="lp-attr-empty">无匹配要素</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="lp-attr-foot">
              <button className="btn-sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>上一页</button>
              <span className="lp-attr-page">第 {page + 1} / {pageCount} 页</span>
              <button className="btn-sm" disabled={page >= pageCount - 1} onClick={() => setPage((p) => p + 1)}>下一页</button>
              <span className="lp-attr-hint">点击行定位到地图</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
