/**
 * Excel 可编辑网格（client/src/components/ExcelGrid.jsx 112 行逐行转录，F4-4 批次）。
 * 行号锚点均指旧 JSX 文件；渲染行为、类名、DOM 结构、交互逻辑与旧版完全一致。
 * 与旧版差异：
 *   - 保存通道：saveCells(name, sheet, cells)（client/src/api.js，HTTP POST /api/doc/:name/cells）
 *     → saveDocCells（../api/client-api，IPC op:doc:cells）；失败语义等价——
 *     invokeOrThrow 非 ok 直接 reject，沿用 catch 提示 "save failed: ..."；
 *   - x-data-spreadsheet 自带 d.ts 与实际数据面不符（loadData/getData 实为 sheet 数组、
 *     view 只传 height、destroy 未声明），按旧代码实际用法做定点类型断言，运行时不变；
 *   - strict 空值兜底：catch 参数 (e as Error).message、grids 取行定点断言，运行时语义不变。
 */
import React, { useEffect, useRef, useState } from "react";
import Spreadsheet, { type Options } from "x-data-spreadsheet";
import "x-data-spreadsheet/dist/xspreadsheet.css";
import { saveDocCells } from "../api/client-api";

/** x-data-spreadsheet getData/loadData 实际承载的行/单元格数据面（按旧代码字段访问定形）。 */
type CellBag = Record<string, { text?: unknown } | undefined>;
type RowBag = Record<string, { cells?: CellBag } | undefined>;
type SheetDatum = { name: string; rows?: RowBag };
/** 保存时的单元格增量（与 saveDocCells 入参对齐）。 */
type CellPatch = { ref: string; value: unknown };

function indexToCol(i: number): string { let s = ""; while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - r) / 26); } return s; }

export default function ExcelGrid({ name, sheets, grids }: { name: string; sheets: string[]; grids: Record<string, unknown> }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [spread, setSpread] = useState<Spreadsheet | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const sheetNames = Array.isArray(sheets) ? sheets : [];
  const hasSheets = sheetNames.length > 0;
  // 保存时记录每个 sheet 的初始数据
  const initialRef = useRef<Record<string, RowBag>>({});

  useEffect(() => {
    if (!hostRef.current || !hasSheets) return undefined;
    const s = new Spreadsheet(hostRef.current, {
      showToolbar: true,
      showGrid: true,
      // 自带 d.ts 的 view 要求 width 必填而旧代码只传 height：断言以保持运行时不变
      view: { height: () => Math.max(200, (hostRef.current?.clientHeight as number) - 40) } as Options["view"],
    });
    setSpread(s);
    // destroy 未在自带 d.ts 声明，按旧代码 typeof 探测后调用
    const maybeDestroy = (s as { destroy?: () => void }).destroy;
    return () => { if (typeof maybeDestroy === "function") try { maybeDestroy(); } catch {} };
  }, [hasSheets]);

  // 一次加载所有 sheets（带 name），x-spreadsheet 底部标签栏可切换
  useEffect(() => {
    if (!spread || !hasSheets) return;
    const allSheets = sheetNames.map((s) => ({
      name: s,
      rows: (grids?.[s] as { rows?: unknown } | undefined)?.rows || grids?.[s] || {},
    }));
    initialRef.current = {};
    for (const s of sheetNames) {
      initialRef.current[s] = JSON.parse(JSON.stringify((grids?.[s] as { rows?: unknown } | undefined)?.rows || grids?.[s] || {}));
    }
    // 自带 d.ts 把 loadData 声明为 Record<string, any>，实际是 sheet 数组：断言取形
    spread.loadData(allSheets as unknown as Record<string, any>);
    if (typeof spread.change === "function") spread.change(() => {});
  }, [spread, hasSheets, sheetNames, grids]);

  // sheets 为空（文件读取失败）时显示错误。放在 hooks 之后，避免文件从加载中
  // 变为可读时触发 React 的 hooks 顺序错误。
  if (!hasSheets) {
    return (
      <div className="excel-wrap">
        <div className="excel-toolbar">
          <span className="badge">可编辑</span>
        </div>
        <div className="excel-empty">
          <div>⚠ 无法读取工作表</div>
          <div className="hint">文件可能已损坏、被占用（Excel 打开中），或格式不受支持</div>
        </div>
      </div>
    );
  }

  const handleSave = async () => {
    if (!spread) return;
    // getData 返回所有 sheet 的数据数组
    const allData = spread.getData() as unknown as SheetDatum[]; // [{ name, rows }]
    const changedBySheet: Record<string, CellPatch[]> = {};
    for (const sd of allData) {
      const sname = sd.name;
      const current = sd.rows || {};
      const initial = initialRef.current[sname] || {};
      const cells: CellPatch[] = [];
      const allKeys = new Set([...Object.keys(current), ...Object.keys(initial)]);
      for (const ri of allKeys) {
        const cur = current[ri]?.cells || {};
        const ini = initial[ri]?.cells || {};
        for (const ci of new Set([...Object.keys(cur), ...Object.keys(ini)])) {
          const cv = cur[ci]?.text ?? "";
          const iv = ini[ci]?.text ?? "";
          if (cv !== iv) cells.push({ ref: indexToCol(Number(ci)) + ri, value: cv });
        }
      }
      if (cells.length) changedBySheet[sname] = cells;
    }
    const total = Object.values(changedBySheet).reduce((a, b) => a + b.length, 0);
    if (!total) { setMsg("no changes"); return; }
    setSaving(true);
    try {
      for (const [sname, cells] of Object.entries(changedBySheet)) {
        // 旧 saveCells（HTTP）失败抛错；IPC 形态 invokeOrThrow 非 ok 直接 reject，
        // 这里按批次约定保留响应 ok 兜底判定，两路失败最终都落 catch 提示。
        const r = await saveDocCells(name, sname, cells);
        if (!r.ok) throw new Error(String((r.data as { error?: string })?.error || "保存失败"));
      }
      setMsg(`saved ${total} cells`);
      // 更新初始数据
      for (const sd of allData) {
        initialRef.current[sd.name] = JSON.parse(JSON.stringify(sd.rows || {}));
      }
    } catch (e) { setMsg("save failed: " + (e as Error).message); }
    setSaving(false);
    setTimeout(() => setMsg(""), 2500);
  };

  return (
    <div className="excel-wrap">
      <div className="excel-toolbar">
        <span className="badge">工作簿 · {sheets.length} 个工作表</span>
        <span className="excel-sheet-hint">底部标签栏可切换工作表</span>
        <button className="btn primary" onClick={handleSave} disabled={saving}>
          {saving ? "saving..." : "save changes"}
        </button>
        {msg && <span className="save-msg">{msg}</span>}
      </div>
      <div ref={hostRef} className="excel-host" />
    </div>
  );
}
