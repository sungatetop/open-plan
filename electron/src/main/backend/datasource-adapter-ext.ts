/**
 * 外部数据源适配器扩展（GIS G2，数据接入层）——flag OAW_DATA_ADAPTERS（默认关）（S3-14 转录）。
 *
 * 逐行等价迁移自 server/datasource-adapter-ext.mjs；消费面：旧 index.mjs L5190
 * （flag dataAdapters 开启时动态 import，导入即注册两适配器——模块加载期副作用）。
 * 落地 PLANNED_SOURCES 中的两个占位（评审 A1 修正口径）：
 *   - live-traffic-api：HTTP(S) 端点轮询，返回行数组或 GeoJSON FeatureCollection；
 *   - sql-database：本地 SQLite 只读查询（node:sqlite 内置模块，零新增依赖；
 *     运行环境 < Node 22.5 时注册即失败并给出可读错误，不影响其它数据源）。
 *
 * 两者都复用 local-file 的列语义识别（detectColumns）与脏坐标过滤（inChinaRange），
 * 产出同一份描述符协议（toDescriptor）——上层（可视面板 / map_datasets）无需任何改动。
 * 注册由 index.mjs 在 flag 开启时动态 import；flag 关闭 = 两适配器不存在 = 基线行为。
 * 注意：当前仅对拍覆盖、未装配运行时；旧 JS 实现保留至域退役。
 */
import fs from "node:fs";
import path from "node:path";
import { registerSource, toDescriptor, detectMeasureField } from "./map-visualization";
import { getWorkspace } from "./workspace";
import { detectColumns, inChinaRange } from "./traffic-sources";

/** 单次拉取/查询的行数与字节上限（防大结果淹没内存与上下文）。 */
const MAX_ROWS = 50000;
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10000;

const LNG_RANGE_TEXT = "70–140E / 15–56N";

/** 单元格 → 数字；空/非法返回 null（与 local-file 的 cellNumber 同口径）。 */
function cellNumber(value: any): number | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

/** 工作区内路径校验（与 local-file 同口径：path.relative 判边界，防同前缀兄弟目录）。 */
function resolveWorkspaceFile(workspace: any, rel: any): { error: string; ws?: undefined; filePath?: undefined } | { error?: undefined; ws: string; filePath: string } {
  const ws = String(workspace || getWorkspace() || "");
  if (!ws) return { error: "没有当前工作区" };
  const filePath = path.resolve(ws, String(rel || "").trim());
  const relToWs = path.relative(path.resolve(ws), filePath);
  if (!relToWs || relToWs.startsWith("..") || path.isAbsolute(relToWs)) return { error: "路径必须在工作区内" };
  return { ws, filePath };
}

/** 行对象数组 → 描述符（点 / OD 流向），列语义与统计口径同 local-file。 */
function rowsToDescriptor({ id, title, rows, measure, dataset }: any) {
  if (!rows.length) return { error: "数据为空（0 行）" };
  if (rows.length > MAX_ROWS) return { error: `行数超过上限（${rows.length} > ${MAX_ROWS}），请在源头聚合或过滤` };
  const header = Object.keys(rows[0]);
  const cols = detectColumns(header);
  if (cols.mode === "unknown") {
    return {
      error: `无法识别坐标列。字段：${header.join("、")}（需要 经度/纬度，或 起点+终点 经纬度）`,
      header,
    };
  }
  const measureName = String(measure || "") || cols.flow || "";
  const coordinateCols = new Set([cols.lng, cols.lat, cols.olng, cols.olat, cols.dlng, cols.dlat].filter(Boolean));
  const carryCols = header.filter((h) => h && !coordinateCols.has(h) && h !== measureName);

  const features: any[] = [];
  const lines: any[] = [];
  let skipped = 0;
  for (const row of rows) {
    const rawFlow = measureName ? cellNumber(row[measureName]) : null;
    const value = rawFlow === null ? 1 : rawFlow;
    const carry: Record<string, string> = {};
    for (const col of carryCols) {
      const v = String(row[col] ?? "").trim();
      if (v) carry[col] = v;
    }
    if (cols.mode === "od") {
      const o = [cellNumber(row[cols.olng]), cellNumber(row[cols.olat])];
      const d = [cellNumber(row[cols.dlng]), cellNumber(row[cols.dlat])];
      if (!inChinaRange(o[0], o[1]) || !inChinaRange(d[0], d[1])) { skipped += 1; continue; }
      const lineProps: any = { ...carry, flow: value };
      const pointProps: any = { ...carry, flow: value, role: "origin" };
      if (measureName) { lineProps[measureName] = value; pointProps[measureName] = value; }
      lines.push({ type: "Feature", properties: lineProps, geometry: { type: "LineString", coordinates: [o, d] } });
      features.push({ type: "Feature", properties: pointProps, geometry: { type: "Point", coordinates: o } });
    } else {
      const lng = cellNumber(row[cols.lng]);
      const lat = cellNumber(row[cols.lat]);
      if (!inChinaRange(lng, lat)) { skipped += 1; continue; }
      const props: any = { ...carry, value };
      if (measureName) props[measureName] = value;
      features.push({ type: "Feature", properties: props, geometry: { type: "Point", coordinates: [lng, lat] } });
    }
  }
  if (!features.length) {
    return {
      error: `没有解析到有效坐标行（${skipped} 行坐标缺失或超出中国范围 ${LNG_RANGE_TEXT}）`,
      skipped,
      header,
    };
  }
  return toDescriptor({
    id,
    title,
    kind: cols.mode === "od" ? "flow" : "points",
    geojson: { type: "FeatureCollection", features },
    lines: lines.length ? { type: "FeatureCollection", features: lines } : null,
    styleHint: cols.mode === "od"
      ? { field: measureName || "flow", ramp: "ramp", widthRange: [0.7, 4.5] }
      : { field: measureName || "value", ramp: "warm", radiusRange: [3, 12] },
    provenance: { dataset, generatedBy: "datasource-adapter-ext.mjs" },
    stats: { rowCount: rows.length, skipped, measure: measureName || null },
  });
}

/** GeoJSON Feature 数组识别（用于 live-traffic-api 直出 FeatureCollection 的端点）。 */
function isFeatureArray(items: any) {
  return Array.isArray(items) && items.length > 0
    && items.every((f: any) => f && typeof f === "object" && f.type === "Feature" && f.geometry);
}

// ---------- 适配器 G2-a：实时交通流 API（HTTP 轮询，端点可配置） ----------

registerSource({
  id: "live-traffic-api",
  label: "实时交通流 API（HTTP 端点）",
  kind: "*",
  paramsSchema: {
    url: "HTTP(S) 端点，返回 JSON：行数组 / {data|rows|list|result:[...]} / GeoJSON FeatureCollection",
    measure: "可选：指定数值列（流量/车速）；省略时自动识别",
    params: "可选：附加查询参数对象（拼接到 URL query）",
  },
  async load(params: any = {}) {
    const rawUrl = String(params.url || "").trim();
    if (!rawUrl) return { error: "缺少 url 参数（HTTP(S) 端点）" };
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return { error: `url 无法解析：${rawUrl}` };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { error: `只允许 http/https 端点（收到：${url.protocol}//）` };
    }
    if (params.params && typeof params.params === "object") {
      for (const [k, v] of Object.entries(params.params)) url.searchParams.set(k, String(v));
    }
    let resp: Response;
    try {
      resp = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: "application/json" } });
    } catch (e: any) {
      return { error: `请求失败：${e?.name === "TimeoutError" ? `超时（${FETCH_TIMEOUT_MS / 1000}s）` : e?.cause?.message || e.message}` };
    }
    if (!resp.ok) return { error: `端点返回 ${resp.status} ${resp.statusText || ""}`.trim() };
    const text = await resp.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) return { error: `响应超过上限（${Math.round(MAX_RESPONSE_BYTES / 1024 / 1024)}MB）` };
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      return { error: "响应不是合法 JSON" };
    }
    // 常见包装形状解包；GeoJSON FeatureCollection 直通。
    const items = Array.isArray(body) ? body
      : [body?.data, body?.rows, body?.list, body?.result].find(Array.isArray)
        || (body?.type === "FeatureCollection" ? body.features : null);
    if (!Array.isArray(items)) return { error: "响应里没有行数组（支持：数组 / {data|rows|list|result:[...]} / GeoJSON）" };
    if (isFeatureArray(items)) {
      const geojson = { type: "FeatureCollection", features: items.slice(0, MAX_ROWS) };
      const field = String(params.measure || "") || detectMeasureField(geojson);
      return toDescriptor({
        id: "live-traffic-api",
        title: url.hostname,
        geojson,
        styleHint: { field: field || null, ramp: "ramp", widthRange: [0.7, 4.5], radiusRange: [3, 10] },
        provenance: { dataset: "live-traffic-api", generatedBy: "datasource-adapter-ext.mjs", url: url.origin + url.pathname },
      });
    }
    if (!items.length || typeof items[0] !== "object" || Array.isArray(items[0])) {
      return { error: "行数组元素需要是对象（键为列名）" };
    }
    return rowsToDescriptor({ id: "live-traffic-api", title: url.hostname, rows: items, measure: params.measure, dataset: "live-traffic-api" });
  },
});

// ---------- 适配器 G2-b：SQLite 只读直连（node:sqlite，零新增依赖） ----------

const SQL_DB_EXT = /\.(db|sqlite|sqlite3|db3)$/i;
/** 只允许查询语句：首词 SELECT/WITH；拒绝多语句；写操作关键词整词拒绝（字符串字面量误伤走保守拒绝）。 */
const FORBIDDEN_SQL = /\b(insert|update|delete|drop|alter|create|attach|detach|pragma|vacuum|reindex|replace|grant|revoke)\b/i;

function stripSqlComments(sql: any) {
  return String(sql || "")
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
}

function validateReadOnlySql(sql: any) {
  const cleaned = stripSqlComments(sql).trim().replace(/;+\s*$/, "");
  if (!cleaned) return { error: "缺少 sql 参数（只读 SELECT 查询）" };
  if (!/^(select|with)\b/i.test(cleaned)) return { error: "只允许 SELECT / WITH 查询语句" };
  if (/;/i.test(cleaned)) return { error: "不允许一次执行多条语句（sql 中出现多余分号）" };
  if (FORBIDDEN_SQL.test(cleaned)) return { error: "查询中包含写操作关键词，已拒绝（只读数据源）" };
  return { sql: cleaned };
}

registerSource({
  id: "sql-database",
  label: "SQL 数据库直连（SQLite 只读）",
  kind: "*",
  paramsSchema: {
    db: "工作区内 SQLite 文件相对路径（.db/.sqlite/.sqlite3/.db3）",
    sql: "只读 SELECT / WITH 查询（自动限制最多 5 万行）",
    measure: "可选：指定数值列（流量/车速）；省略时自动识别",
  },
  async load(params: any = {}) {
    const rel = String(params.db || "").trim();
    if (!rel) return { error: "缺少 db 参数（工作区内 SQLite 文件相对路径）" };
    const resolved = resolveWorkspaceFile(params.workspace, rel);
    if (resolved.error) return { error: resolved.error };
    const { filePath } = resolved as { ws: string; filePath: string };
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return { error: `数据库文件不存在：${rel}` };
    if (!SQL_DB_EXT.test(filePath)) return { error: "只支持 .db/.sqlite/.sqlite3/.db3 文件" };
    const check = validateReadOnlySql(params.sql);
    if (check.error) return { error: check.error };

    let DatabaseSync: any;
    try {
      ({ DatabaseSync } = await import("node:sqlite"));
    } catch {
      return { error: "当前 Node 版本不支持 node:sqlite（需要 ≥22.5）；可改用 CSV/GeoJSON 文件管道" };
    }
    let db: any;
    try {
      db = new DatabaseSync(filePath, { readOnly: true });
      // 包一层子查询做行数上限：不改写用户语义（ORDER BY/LIMIT 在子查询内仍生效）。
      const wrapped = `SELECT * FROM (${check.sql}) AS __oaw_q LIMIT ${MAX_ROWS}`;
      const stmt = db.prepare(wrapped);
      const rows = stmt.all();
      const columns = stmt.columns().map((c: any) => c.name);
      if (!rows.length) return { error: "查询结果为空（0 行）", header: columns };
      return rowsToDescriptor({ id: "sql-database", title: path.basename(filePath), rows, measure: params.measure, dataset: "sql-database" });
    } catch (e: any) {
      return { error: `SQL 执行失败：${String(e?.message || e)}` };
    } finally {
      try { db?.close(); } catch { /* 关闭失败不影响结果 */ }
    }
  },
});
