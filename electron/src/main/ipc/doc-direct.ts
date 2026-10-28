/**
 * doc 族通道直调器（F4-3 读路由 + F4-4 写路由收编）：op:doc:open / op:doc:raw /
 * op:doc:text / op:doc:html / op:doc:comments / op:doc:outline / op:doc:annotations /
 * op:doc:annotations-save / op:doc:raw-save / op:doc:cells / op:doc:edit / op:office:run /
 * op:doc:watch / op:doc:watch-stop → 进程内直调 workspace 解析 + office 域
 * （get/batch/renderHtml/queryComments/runOfficecli）+ 会话批注提取 + 写协调（写锁/落盘）。
 *
 * 旧路径：渲染层 invoke → http-forward 转发 sidecar HTTP。本模块把 14 条路由的
 * sidecar 编排逐点转录为主进程内直调（行号锚点均指 server/index.mjs）：
 *   - op:doc:open（L1069-1111）：resolvePath null → 404；xlsx/xls → readWorkbook
 *     （officecli 枚举 sheets + xlsx 包回退，L250-315）；md/markdown/txt/csv/json →
 *     {kind:"text"}；html/htm → {kind:"htmlfile"}；pdf/image → {kind,url=raw 地址}；
 *     其余 → {kind:"html",url=渲染地址}；client 参数 → setCurrentFile（agent 上下文）；
 *   - op:doc:raw（L1006-1044）：mimeMap（docx/xls/xlsx/pptx/pdf/8 图片格式）+ svg CSP
 *     兜底 + 文件身份。HTTP 形态 res.sendFile 流式响应 + Cache-Control/Content-
 *     Disposition/X-OA-File-Identity 响应头；IPC 形态为 base64+mime 载数据（架构性
 *     等价替换，渲染层自行建 blob URL；img 通道本就不执行脚本，svg CSP 语义保留在注释）；
 *   - op:doc:text（L1047-1066）：仅 .docx；JSZip 解 word/document.xml → w:p/w:t 段落
 *     join("\n")；无 document.xml → 400；异常 → 500；
 *   - op:doc:html（L1136-1157）：renderHtml(p)（office.ts 已迁，临时副本防锁）；空渲染 →
 *     previewUnsupportedPage（unsupported 态，.doc/.wps 专用 tips）；成功 → 注入身份
 *     postMessage 就绪消息；异常 → 500 + 占位页（error 态）。HTTP 形态的 X-Frame-Options/
 *     setPreviewIdentityHeader 在 IPC 无对应（identity 在 data 与注入消息内，语义保留）；
 *   - op:doc:comments（L1161-1216）：md/markdown/txt → 从 listSessionFiles 会话 JSONL
 *     提取含 fileName 的 user 消息（slice(0,200) 去重 20 条）；其余 → queryComments
 *     （officecli，临时副本）映射 {path,author,text,date}；异常 → {comments:[],identity}；
 *   - op:doc:outline（L1355-1384）：runOfficecli get --depth 3 --json → walk results
 *     按 style Heading* 与标题 启发式 → {level(1-6),text(120),path}；异常 → {outline:[]}；
 *   - op:doc:annotations（L524-535）：.annotations/<basename>.json，缺失/解析失败 →
 *     {annotations:[],identity}；写路由 POST（L537-549）为 annotations-save；
 *   - op:doc:annotations-save（L537-549）：annotationsPath basename 防越界 →
 *     writeWorkspaceFile(kind:"ui_annotations") → {...result, count, identity}；
 *   - op:doc:watch（L1218-1230）：HTTP 形态 startWatch 启动 officecli watch 子进程返回
 *     渲染服务 URL；IPC 形态为 fs.watchFile 变化检测 + op:doc-watch 事件推送（CSP 'self'
 *     禁 http iframe + 桌面端禁 HTTP 通道原则，见 doc-watch.ts 模块头），响应不含 url/port；
 *   - op:doc:watch-stop（L1233-1239）：resolvePath 后 stopDocWatch，恒 {ok:true}；
 *   - op:doc:cells（L1242-1262）：ref → batch set 命令，写锁 kind:"office_ui"，失败判定
 *     json.error / 退出码 / 任一 result.error → normalizeOfficeFailure；
 *   - op:doc:edit（L1303-1331）：props 全值 String 归一（officecli 需要 "true"/"false"）→ batch；
 *   - op:office:run（L1265-1298）：命令白名单 view/get/set/batch/query/watch/close +
 *     文件参数（args[1]）越界校验 + mutating（set/batch）写锁；非零退出码 → normalizeOfficeFailure；
 *   - op:doc:raw-save（L1334-1352）：base64 解码 + PK 头校验 → writeWorkspaceFile(kind:"ui_docx_save")。
 *
 * 本地辅助转录：previewWorkspaceRoot（L472-474）/ requestedPreviewWorkspace（L477-479
 * query.cwd 校验）/ previewFileRevision（L482-489 sha1(size:mtime) 前 16 位）/
 * previewFileIdentity（L491-499）/ annotationsPath（L518-522 basename 防越界）/
 * injectPreviewIdentityMessage（L508-515 </body> 前注入 postMessage 脚本）/
 * previewUnsupportedPage（L1115-1133 占位卡）/ agentKey（L1387-1391）/ IMAGE_EXTENSIONS
 * （L3215）/ readWorkbook+sheetToGrid+officeResults+nodeChildren+colToIndex（L216-315）。
 *
 * 语义差异（注释声明）：
 *   - L1071 open 路由的子路由让位 next()（/(?:^|\/)(?:raw|text|...)\/?$/ 尾巴）是
 *     HTTP 正则路由分发 concern；IPC 通道已按 op 显式分发，不存在吞参数歧义，不转录；
 *   - raw/html 的 HTTP 响应头（Cache-Control/Content-Disposition/X-Frame-Options/
 *     X-OA-File-Identity）在 IPC 信封无对应：身份改由 data.identity 携带（raw）与
 *     注入 postMessage 消息（html），渲染层以同一 identityMatches 逻辑核对；
 *   - op:doc:html 的 404 在 HTTP 形态响应纯文本 "not found"，直调形态统一 JSON 信封；
 *   - open 的 setCurrentFile 在 electron agent-manager 为 async，await 后吞错（server
 *     为同步 try/catch 吞错，语义等价）；
 *   - 写路由失败的 HTTP 形态 respondWorkspaceFileError（L928-936）带 requestId 字段，
 *     IPC 信封无对应不携带；status 保留（workspaceWriteHttpStatus 映射）；
 *   - op:office:run 成功响应的 requestId（req.requestId）在 IPC 无对应不携带；
 *   - op:doc:watch 的 url/port（officecli watch 渲染服务）在 IPC 形态不存在：变化检测
 *     改由 doc-watch.ts 的 fs.watchFile + op:doc-watch 事件推送承担。
 *
 * 数据源：backend/workspace.ts（normalizeWorkspace/resolvePath，B2 对拍覆盖）+
 * backend/office.ts（runOfficecli/get/renderHtml/queryComments，D 线已迁）+
 * backend/agent/agent-manager.ts setCurrentFile + backend/agent/session-files.ts
 * （listSessionFiles/readSessionTextCached，B 线已迁）。
 *
 * 门控：OP_DESKTOP_DOC_DIRECT 且 OP_DESKTOP_AGENT_DOMAIN 双门控（S4 语义：未设置=
 * 默认启用，=0 显式回滚——流量切换评估方案 §4-S4）。本模块不 import electron（纯
 * 逻辑，vitest 可直接测）；注册入口在 main/index.ts。
 */
import crypto from "node:crypto";
import path from "node:path";
import type { InvokeEnvelope, InvokeResult } from "../../shared/protocol/channels";

/** doc 族编排的跨域依赖（生产接线传 backend 真实模块与 fs 面，测试注入桩）。 */
export interface DocDirectDeps {
  /** 当前工作区（backend/workspace.ts getWorkspace） */
  getWorkspace: () => string;
  /** 工作区路径归一（backend/workspace.ts normalizeWorkspace，越界返回 null） */
  normalizeWorkspace: (dir: string) => string | null;
  /** 工作区内路径解析（backend/workspace.ts resolvePath，越界返回 null） */
  resolvePath: (rel: string, workspace?: string) => string | null;
  /** 当前工作文件记录（backend/agent/agent-manager.ts setCurrentFile，agent 上下文） */
  setCurrentFile: (clientId: unknown, file: unknown) => Promise<unknown>;
  /** OfficeCLI get 节点 JSON（backend/office.ts get） */
  officeGet: (file: string, target?: string, depth?: number) => Promise<unknown>;
  /** docx/pptx 渲染自包含 HTML（backend/office.ts renderHtml） */
  renderHtml: (file: string) => Promise<string>;
  /** Office 批注查询（backend/office.ts queryComments，临时副本防锁） */
  queryComments: (file: string) => Promise<unknown>;
  /** OfficeCLI 通用调用（outline 用 ["get",p,"/","--depth","3","--json"]） */
  runOfficecli: (args: unknown, options?: { cwd?: string; timeoutMs?: number }) => Promise<unknown>;
  /** 会话文件清单（backend/agent/session-files.ts listSessionFiles） */
  listSessionFiles: () => Array<{ fileName: string; fullPath: string; storeDir: string; mtime: number; size: number; sessionId?: string }>;
  /** 会话文本读取（backend/agent/session-files.ts readSessionTextCached） */
  readSessionTextCached: (found: { fileName: string; fullPath: string; storeDir: string; mtime: number; size: number; sessionId?: string }) => string;
  /** fs 面（raw 读取 / open 文本读取 / annotations 存在性），注入便于测试 */
  existsSync: (p: string) => boolean;
  statSync: (p: string) => { mtimeMs: number; size: number };
  readFileSync: (p: string) => Buffer;
  // ---- F4-4 写路由依赖 ----
  /** 工作区落盘（backend/agent/write-coordination.ts writeWorkspaceFile，B3 已迁） */
  writeWorkspaceFile: (options: { workspace: string; targetPath: string; content: string | Buffer; kind?: string }) => { ok: boolean; workspace: string; path: string; status: string; size: number };
  /** 写锁（backend/agent/write-coordination.ts withWriteLockAsync，B3 已迁） */
  withWriteLockAsync: <T>(options: { workspace: string; targetPath: string; runId: string; kind: string }, callback: () => Promise<T> | T) => Promise<T>;
  /** OfficeCLI batch（backend/office.ts batch，D 线已迁；cells/edit 写路径） */
  officeBatch: (file: string, commands: unknown) => Promise<unknown>;
  /** office 失败归一（backend/file-permission-error.ts normalizeOfficeFailure） */
  normalizeOfficeFailure: (error: unknown, args: unknown[], result: unknown) => { code?: string; message: string };
  /** 工作区写错误归一（backend/file-permission-error.ts normalizeWorkspaceWriteError） */
  normalizeWorkspaceWriteError: (error: unknown) => { code?: string; message: string };
  /** 归一化错误 → HTTP 状态（backend/file-permission-error.ts workspaceWriteHttpStatus） */
  workspaceWriteHttpStatus: (error: unknown) => number;
  /** 实时预览 watch（main/ipc/doc-watch.ts 注册表；变化经 op:doc-watch 事件推送） */
  startDocWatch: (absPath: string, relativePath: string) => void;
  stopDocWatch: (absPath: string) => void;
}

/** doc 族直调 invoke 通道清单（与 DESKTOP_CHANNELS 对应路由一致；写路由 F4-4 已扩）。 */
export const DOC_DIRECT_CHANNELS = [
  "op:doc:open",
  "op:doc:raw",
  "op:doc:text",
  "op:doc:html",
  "op:doc:comments",
  "op:doc:outline",
  "op:doc:annotations",
  "op:doc:annotations-save",
  "op:doc:raw-save",
  "op:doc:cells",
  "op:doc:edit",
  "op:office:run",
  "op:doc:watch",
  "op:doc:watch-stop"
] as const;

export type DocDirectChannel = (typeof DOC_DIRECT_CHANNELS)[number];

const ok = (data: unknown): InvokeResult<unknown> => ({ ok: true, status: 200, data });

function paramsOf(payload: InvokeEnvelope): Record<string, unknown> {
  return (payload.params ?? {}) as Record<string, unknown>;
}

function queryOf(payload: InvokeEnvelope): Record<string, unknown> {
  return (payload.query ?? {}) as Record<string, unknown>;
}

/* ------------------------------ 本地辅助转录 ------------------------------ */

/** server L1387-1391：agent 上下文键（client + thread 组合）。 */
function agentKey(client: unknown, thread: unknown): string {
  const c = String(client || "").trim();
  const t = String(thread || "").trim();
  return t ? `${c}::${t}` : c;
}

/** server L472-474：预览工作区根（显式 cwd 校验归一，失败回退全局）。 */
function previewWorkspaceRoot(requestedCwd: unknown, deps: DocDirectDeps): string {
  const explicit = requestedCwd ? deps.normalizeWorkspace(String(requestedCwd)) : null;
  return explicit || deps.getWorkspace() || "";
}

/** server L477-479：请求方显式指定的工作区（仍经 normalizeWorkspace 校验，禁止越界）。 */
function requestedPreviewWorkspace(query: Record<string, unknown>, deps: DocDirectDeps): string | undefined {
  return deps.normalizeWorkspace(String(query.cwd || "")) || undefined;
}

/** server L482-489：文件版本 sha1(`${size}:${floor(mtimeMs)}`) 前 16 位（stat 失败空串）。 */
function previewFileRevision(absPath: string, deps: DocDirectDeps): string {
  try {
    const st = deps.statSync(absPath);
    return crypto.createHash("sha1").update(`${st.size}:${Math.floor(st.mtimeMs)}`).digest("hex").slice(0, 16);
  } catch {
    return "";
  }
}

/** server L491-499：预览文件身份 {workspaceId,cwd,relativePath,revision}。 */
function previewFileIdentity(relativePath: unknown, requestedCwd: unknown, deps: DocDirectDeps, absPath: string | null = null) {
  const ws = previewWorkspaceRoot(requestedCwd, deps);
  return {
    workspaceId: ws,
    cwd: ws,
    relativePath: String(relativePath || "").replace(/\\/g, "/"),
    revision: absPath ? previewFileRevision(absPath, deps) : "",
  };
}

/** server L518-522：标注持久化路径（basename 防越界，跟随当前/显式工作区）。 */
function annotationsPath(fileName: unknown, workspace: string): string | null {
  const safe = path.basename(String(fileName || ""));
  if (!safe || safe.includes("..")) return null;
  return path.join(workspace, ".annotations", safe + ".json");
}

/** server L508-515：在预览 HTML </body> 前注入受控 postMessage 消息（携带文件身份）。 */
function injectPreviewIdentityMessage(html: unknown, identity: unknown, type = "ready", detail = ""): string {
  const payload = JSON.stringify({ __oawPreview: true, type, identity, message: detail ? String(detail).slice(0, 300) : "" });
  const script = `<script>(function(){try{var d=${payload};if(window.parent&&window.parent!==window){window.parent.postMessage(d,"*");}}catch(e){}})();<\/script>`;
  const src = String(html || "");
  const idx = src.toLowerCase().lastIndexOf("</body>");
  if (idx >= 0) return src.slice(0, idx) + script + src.slice(idx);
  return src + script;
}

/** server L1115-1133：预览占位页（老式 .doc/.wps 专用 tips），注入 unsupported/error 消息。 */
function previewUnsupportedPage(fileName: unknown, ext: unknown, detail: unknown, identity: unknown, type = "unsupported"): string {
  const safeName = String(fileName || "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c] ?? c));
  const tips = ({
    doc: "老式 .doc 二进制格式不被预览引擎支持。请用 WPS/Word 打开后另存为 .docx，即可在规聚中正常预览。",
    wps: "WPS 专有格式不被预览引擎支持。请用 WPS 打开后另存为 .docx。",
  } as Record<string, string>)[String(ext || "").toLowerCase()] || "该格式暂不支持内嵌预览。";
  const page = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${safeName}</title>
<style>body{margin:0;font:14px/1.7 -apple-system,"Microsoft YaHei",sans-serif;background:#f5f6f8;color:#2b2f36;display:flex;align-items:center;justify-content:center;height:100vh}
.card{max-width:520px;background:#fff;border:1px solid #e3e6eb;border-radius:12px;padding:28px 32px;box-shadow:0 6px 20px rgba(15,23,42,.06)}
h1{font-size:16px;margin:0 0 10px}.ext{display:inline-block;font-size:12px;color:#7a8291;border:1px solid #e3e6eb;border-radius:6px;padding:1px 6px;margin-left:6px}
p{margin:8px 0;color:#4b5563}.file{font-weight:600;color:#111827;word-break:break-all}
.err{margin-top:12px;font-size:12px;color:#9aa1ad}</style></head>
<body><div class="card"><h1>无法内嵌预览<span class="ext">.${String(ext || "").toLowerCase()}</span></h1>
<p class="file">${safeName}</p><p>${tips}</p>
<p>也可以让 Agent 直接读取或转换该文件（例如另存为 .docx 后再预览）。</p>
${detail ? `<div class="err">渲染引擎信息：${String(detail).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c] ?? c))}</div>` : ""}
</div></body></html>`;
  return injectPreviewIdentityMessage(page, identity || {}, type, String(detail || ""));
}

/** server L3215：独立图片格式（raw 按扩展名给正确 MIME）。 */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico"]);

/** server L1012-1028：raw 路由扩展名 → MIME（D04：图片按真实类型返回）。 */
function rawMimeForExt(ext: string): string {
  return ({
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    avif: "image/avif",
    ico: "image/x-icon",
    svg: "image/svg+xml",
  } as Record<string, string>)[ext] || "application/octet-stream";
}

/** server L216-221：Excel 列号（A→1）。 */
const COL_RE = /([A-Z]+)(\d+)$/;
function colToIndex(col: string): number {
  let n = 0;
  for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/** server L246-248：officecli JSON 结果 → results 数组（兼容 Results）。 */
function officeResults(response: unknown): Array<Record<string, unknown>> {
  const data = ((response as any)?.json?.data || {}) as Record<string, unknown>;
  return Array.isArray(data.results) ? (data.results as Array<Record<string, unknown>>) : Array.isArray((data as any).Results) ? (data as any).Results : [];
}

/** server L246-248 兄弟：node children（兼容 Children）。 */
function nodeChildren(node: unknown): Array<Record<string, unknown>> {
  return Array.isArray((node as any)?.children) ? (node as any).children : Array.isArray((node as any)?.Children) ? (node as any).Children : [];
}

/** server L222-239：officecli sheet 节点 children → 行列网格（ExcelGrid 数据契约）。 */
function sheetToGrid(children: Array<Record<string, unknown>>): Record<string, { cells: Record<number, { text: string }> }> {
  const rows: Record<string, { cells: Record<number, { text: string }> }> = {};
  for (const row of children || []) {
    if (row.type !== "row") continue;
    const m = String(row.path || "").match(/row\[(\d+)\]/);
    const ri = m ? Number.parseInt(m[1] ?? "", 10) : null;
    if (!ri) continue;
    rows[ri] = { cells: {} };
    for (const cell of nodeChildren(row)) {
      if (cell.type !== "cell") continue;
      const ref = String(cell.path || "").match(COL_RE);
      if (!ref) continue;
      const ci = colToIndex(ref[1] ?? "");
      rows[ri].cells[ci] = { text: (cell.text as string) ?? "" };
    }
  }
  return rows;
}

/** server L250-315：readWorkbook —— officecli 枚举 sheets（depth 1→2 重试）逐表取网格，
 * officecli 不可用回退 xlsx 包原生读取；双失败抛合并错误。 */
async function readWorkbook(file: string, deps: DocDirectDeps): Promise<{ sheets: string[]; grids: Record<string, unknown> }> {
  // 尝试 officecli（Windows），失败则用 xlsx 包原生读取（macOS/Linux）
  try {
    // 枚举 sheets：depth 1 不够则递增重试
    let info = await deps.officeGet(file, "/", 1);
    const sheetNodes: Array<Record<string, unknown>> = [];
    const collect = (results: Array<Record<string, unknown>>): void => {
      for (const r of results || []) {
        if (r.type === "sheet" && r.path) sheetNodes.push(r);
        collect(nodeChildren(r));
      }
    };
    collect(officeResults(info));
    if (sheetNodes.length === 0) {
      info = await deps.officeGet(file, "/", 2);
      collect(officeResults(info));
    }
    if (sheetNodes.length === 0) {
      throw new Error("无法枚举工作表");
    }
    const sheets: Array<{ name: string; path: string }> = [];
    const grids: Record<string, unknown> = {};
    for (const s of sheetNodes) {
      const name = String(s.preview || String(s.path).split("/").pop());
      if (!sheets.some((x) => x.name === name)) {
        sheets.push({ name, path: String(s.path) });
      }
    }
    for (const s of sheets) {
      // 使用 Office CLI 返回的 DOM 路径，而不是工作表显示名；名称含空格、斜杠
      // 或非 ASCII 字符时，显示名不一定能作为查询路径。
      const r = await deps.officeGet(file, s.path || `/${s.name}`, 3);
      const results = officeResults(r);
      const res = results.find((item) => item.type === "sheet") || results[0];
      grids[s.name] = sheetToGrid(nodeChildren(res));
    }
    return { sheets: sheets.map((s) => s.name), grids };
  } catch (officeErr) {
    // officecli 不可用，使用 xlsx 包原生读取
    try {
      // xlsx 是 CommonJS 包：动态 import 后需要用 .default 取导出对象
      const xlsxModule = (await import("xlsx")) as unknown as { default?: any } & Record<string, any>;
      const XLSX = xlsxModule.default || xlsxModule;
      const wb = XLSX.readFile(file);
      const sheetNames: string[] = wb.SheetNames;
      const grids: Record<string, unknown> = {};
      for (const name of sheetNames) {
        const ws = wb.Sheets[name];
        const data: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
        const rows: Record<string, { cells: Record<number, { text: string }> }> = {};
        data.forEach((row, ri) => {
          const cells: Record<number, { text: string }> = {};
          (row || []).forEach((val, ci) => {
            cells[ci + 1] = { text: String(val) };
          });
          rows[ri + 1] = { cells };
        });
        grids[name] = { rows };
      }
      return { sheets: sheetNames, grids };
    } catch (xlsxErr) {
      throw new Error(`officecli: ${(officeErr as Error).message} | xlsx: ${(xlsxErr as Error).message}`);
    }
  }
}

/* ------------------------------ 通道转录 ------------------------------ */

/** GET /api/doc/:name（server L1069-1111 逐点转录：按扩展名分发 kind）。 */
async function invokeDocOpen(payload: InvokeEnvelope, deps: DocDirectDeps): Promise<InvokeResult<unknown>> {
  const params = paramsOf(payload);
  const query = queryOf(payload);
  const fileName = String(params.name ?? "");
  // 支持按调用方指定的工作区解析（产物可能属于其他工作区，不能只看全局当前工作区）
  const requestedCwd = requestedPreviewWorkspace(query, deps);
  const p = deps.resolvePath(fileName, requestedCwd);
  if (!p) return { ok: false, status: 404, data: { error: "not found" } };
  const ext = path.extname(p).slice(1).toLowerCase();
  const cwdQuery = requestedCwd ? `?cwd=${encodeURIComponent(requestedCwd)}` : "";
  const identity = previewFileIdentity(fileName, requestedCwd, deps, p);
  // 记录当前工作文件（前端传 client 参数）；electron 形态 async，await 后吞错（语义差异见模块头）
  const client = query.client;
  const thread = query.thread;
  if (client) {
    try { await deps.setCurrentFile(agentKey(client, thread), fileName); } catch {}
  }
  try {
    if (ext === "xlsx" || ext === "xls") {
      const wb = await readWorkbook(p, deps);
      return ok({ kind: "xlsx", name: fileName, identity, ...wb });
    } else if (["md", "markdown", "txt", "csv", "json"].includes(ext)) {
      return ok({ kind: "text", name: fileName, content: deps.readFileSync(p).toString("utf8"), ext, identity });
    } else if (ext === "html" || ext === "htm") {
      return ok({ kind: "htmlfile", name: fileName, content: deps.readFileSync(p).toString("utf8"), identity });
    } else if (ext === "pdf") {
      return ok({ kind: "pdf", name: fileName, ext, identity, url: `/api/doc/${encodeURIComponent(fileName)}/raw${cwdQuery}` });
    } else if (IMAGE_EXTENSIONS.has(ext)) {
      // D04：独立图片格式走专用查看器（raw 已按扩展名给正确 MIME）
      return ok({ kind: "image", name: fileName, ext, identity, url: `/api/doc/${encodeURIComponent(fileName)}/raw${cwdQuery}` });
    }
    return ok({ kind: "html", name: fileName, ext, identity, url: `/api/doc/${encodeURIComponent(fileName)}/html${cwdQuery}` });
  } catch (e) {
    return { ok: false, status: 500, data: { error: (e as Error).message } };
  }
}

/** GET /api/doc/:name/raw（server L1006-1044 逐点转录；HTTP 流式响应 → base64 载数据）。 */
function invokeDocRaw(payload: InvokeEnvelope, deps: DocDirectDeps): InvokeResult<unknown> {
  const params = paramsOf(payload);
  const query = queryOf(payload);
  const fileName = String(params.name ?? "");
  const requestedCwd = requestedPreviewWorkspace(query, deps);
  const p = deps.resolvePath(fileName, requestedCwd);
  if (!p) return { ok: false, status: 404, data: { error: "not found" } };
  const ext = path.extname(p).slice(1).toLowerCase();
  try {
    // HTTP 形态：Cache-Control no-store + Content-Disposition inline + svg CSP 沙箱
    // （sandbox; default-src 'none'; style-src 'unsafe-inline'）+ X-OA-File-Identity 头。
    // IPC 形态：blob URL 渲染（img/iframe 通道不执行脚本，CSP 语义保留），身份在 data.identity。
    const mime = rawMimeForExt(ext);
    const base64 = deps.readFileSync(p).toString("base64");
    return ok({ base64, mime, identity: previewFileIdentity(fileName, requestedCwd, deps, p) });
  } catch (e) {
    return { ok: false, status: 500, data: { error: (e as Error).message } };
  }
}

/** GET /api/doc/:name/text（server L1047-1066 逐点转录：JSZip 提取 docx 段落文本）。 */
async function invokeDocText(payload: InvokeEnvelope, deps: DocDirectDeps): Promise<InvokeResult<unknown>> {
  const params = paramsOf(payload);
  const query = queryOf(payload);
  const fileName = String(params.name ?? "");
  const requestedCwd = requestedPreviewWorkspace(query, deps);
  const p = deps.resolvePath(fileName, requestedCwd);
  if (!p || !/\.docx$/i.test(p)) return { ok: false, status: 404, data: { error: "not found" } };
  try {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(deps.readFileSync(p));
    const xml = await zip.file("word/document.xml")?.async("string");
    if (!xml) return { ok: false, status: 400, data: { error: "no document.xml" } };
    const paras: string[] = [];
    for (const m of xml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)) {
      const text = [...m[0].matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((t) => t[1]).join("").trim();
      if (text) paras.push(text);
    }
    return ok({ name: fileName, text: paras.join("\n"), identity: previewFileIdentity(fileName, requestedCwd, deps, p) });
  } catch (e) {
    return { ok: false, status: 500, data: { error: String((e as Error)?.message || e) } };
  }
}

/** GET /api/doc/:name/html（server L1136-1157 逐点转录：renderHtml + 占位页 + 身份注入）。 */
async function invokeDocHtml(payload: InvokeEnvelope, deps: DocDirectDeps): Promise<InvokeResult<unknown>> {
  const params = paramsOf(payload);
  const query = queryOf(payload);
  const fileName = String(params.name ?? "");
  const requestedCwd = requestedPreviewWorkspace(query, deps);
  const p = deps.resolvePath(fileName, requestedCwd);
  if (!p) return { ok: false, status: 404, data: { error: "not found" } };
  const identity = previewFileIdentity(fileName, requestedCwd, deps, p);
  try {
    const html = await deps.renderHtml(p);
    // 老式 .doc/.wps 会被渲染成空字符串；直接 send("") 就是一片空白。
    if (!html || !String(html).trim()) {
      return ok({ html: previewUnsupportedPage(fileName, path.extname(p).slice(1).toLowerCase(), "", identity), identity });
    }
    return ok({ html: injectPreviewIdentityMessage(html, identity, "ready"), identity });
  } catch (e) {
    return { ok: false, status: 500, data: { html: previewUnsupportedPage(fileName, path.extname(p).slice(1).toLowerCase(), (e as Error).message, identity, "error"), identity } };
  }
}

/** GET /api/doc/:name/comments（server L1161-1216 逐点转录：会话提取 / officecli 查询）。 */
async function invokeDocComments(payload: InvokeEnvelope, deps: DocDirectDeps): Promise<InvokeResult<unknown>> {
  const params = paramsOf(payload);
  const query = queryOf(payload);
  const fileName = String(params.name ?? "");
  const requestedCwd = requestedPreviewWorkspace(query, deps);
  const p = deps.resolvePath(fileName, requestedCwd);
  if (!p) return { ok: false, status: 404, data: { error: "not found" } };
  const identity = previewFileIdentity(fileName, requestedCwd, deps, p);
  const ext = path.extname(p).slice(1).toLowerCase();
  try {
    if (ext === "md" || ext === "markdown" || ext === "txt") {
      // 从 agent 会话中提取与该文件相关的修改指令（模拟批注/修订记录）
      const comments: Array<Record<string, unknown>> = [];
      for (const f of deps.listSessionFiles()) {
        try {
          const text = deps.readSessionTextCached(f);
          if (!text.includes(fileName)) continue;
          for (const line of text.split(/\r?\n/)) {
            if (!line.trim()) continue;
            try {
              const entry = JSON.parse(line);
              if (entry.type === "message" && entry.message?.role === "user") {
                const c = entry.message.content;
                let t = "";
                if (typeof c === "string") t = c;
                else if (Array.isArray(c)) t = c.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ");
                if (t.includes(fileName)) {
                  comments.push({
                    path: fileName,
                    author: "用户",
                    text: t.slice(0, 200),
                    date: entry.timestamp || entry.time || new Date(f.mtime).toISOString(),
                  });
                }
              }
            } catch {}
          }
        } catch {}
      }
      // 去重 + 最新 20 条
      const seen = new Set<string>();
      const unique = comments.filter((c) => { if (seen.has(String(c.text))) return false; seen.add(String(c.text)); return true; });
      return ok({ comments: unique.slice(0, 20), identity });
    }
    const r = await deps.queryComments(p);
    const results = (r as any)?.json?.data?.results || [];
    const comments = results.map((c: any) => ({
      path: c.path,
      author: c.format?.author || c.author || "",
      text: c.text || c.preview || "",
      date: c.format?.date || c.date || "",
    }));
    return ok({ comments, identity });
  } catch {
    return ok({ comments: [], identity });
  }
}

/** GET /api/doc/:name/outline（server L1355-1384 逐点转录：标题样式启发式大纲）。 */
async function invokeDocOutline(payload: InvokeEnvelope, deps: DocDirectDeps): Promise<InvokeResult<unknown>> {
  const params = paramsOf(payload);
  const query = queryOf(payload);
  const fileName = String(params.name ?? "");
  const requestedCwd = requestedPreviewWorkspace(query, deps);
  const p = deps.resolvePath(fileName, requestedCwd);
  if (!p) return { ok: false, status: 404, data: { error: "not found" } };
  const identity = previewFileIdentity(fileName, requestedCwd, deps, p);
  try {
    // 遍历文档段落，按样式名启发式识别标题（Heading* / 常见标题样式 / 短文本+大字号）
    const r = await deps.runOfficecli(["get", p, "/", "--depth", "3", "--json"]);
    const results = (r as any)?.json?.data?.results || [];
    const outline: Array<{ level: number; text: string; path: string }> = [];
    const walk = (nodes: Array<Record<string, unknown>>): void => {
      for (const n of nodes || []) {
        if (n.type === "p" || n.type === "paragraph") {
          const style = String(n.style || (n.format as any)?.style || "");
          const text = String(n.text || n.preview || "").trim();
          if (text && (style.startsWith("Heading") || /标题|Heading/.test(style))) {
            const m = style.match(/(\d)/);
            outline.push({ level: Math.min(6, Number.parseInt(m?.[1] ?? "1", 10)), text: text.slice(0, 120), path: String(n.path || "") });
          }
        }
        if (n.children) walk(nodeChildren(n));
      }
    };
    walk(results);
    return ok({ outline, identity });
  } catch {
    return ok({ outline: [], identity });
  }
}

/** GET /api/doc/:name/annotations（server L524-535 逐点转录；写路由 POST 随 F4-4）。 */
function invokeDocAnnotations(payload: InvokeEnvelope, deps: DocDirectDeps): InvokeResult<unknown> {
  const params = paramsOf(payload);
  const query = queryOf(payload);
  const fileName = String(params.name ?? "");
  const requestedCwd = requestedPreviewWorkspace(query, deps);
  const p = annotationsPath(fileName, previewWorkspaceRoot(requestedCwd, deps));
  const identity = previewFileIdentity(fileName, requestedCwd, deps);
  if (!p || !deps.existsSync(p)) return ok({ annotations: [], identity });
  try {
    return ok({ annotations: JSON.parse(deps.readFileSync(p).toString("utf8")), identity });
  } catch {
    return ok({ annotations: [], identity });
  }
}

/* ------------------------------ F4-4 写路由 ------------------------------ */

/** server L928-936 respondWorkspaceFileError 的 IPC 形态：status=workspaceWriteHttpStatus
 * （作用于归一化后的错误），data={ok:false,code,error}；requestId 在 IPC 信封无对应不携带。 */
function workspaceFileError(error: unknown, deps: DocDirectDeps): InvokeResult<unknown> {
  const normalized = deps.normalizeWorkspaceWriteError(error);
  return {
    ok: false,
    status: deps.workspaceWriteHttpStatus(normalized),
    data: { ok: false, code: normalized.code || "WORKSPACE_FILE_OPERATION_FAILED", error: normalized.message },
  };
}

/** server L1255/L1324：batch 结果失败判定（json.error / 非零退出码 / 任一 result.error）。 */
function officeBatchFailed(r: unknown): boolean {
  const anyR = r as { json?: { error?: unknown; data?: { results?: unknown } }; code?: unknown };
  const results = anyR?.json?.data?.results;
  return Boolean(
    anyR?.json?.error ||
    (anyR?.code != null && Number(anyR.code) !== 0) ||
    (Array.isArray(results) && results.some((item) => (item as { error?: unknown })?.error)),
  );
}

/** POST /api/doc/:name/annotations（server L537-549 逐点转录：划词标注数组整体落盘）。 */
async function invokeDocAnnotationsSave(payload: InvokeEnvelope, deps: DocDirectDeps): Promise<InvokeResult<unknown>> {
  const params = paramsOf(payload);
  const query = queryOf(payload);
  const fileName = String(params.name ?? "");
  const requestedCwd = requestedPreviewWorkspace(query, deps);
  const workspace = requestedCwd || deps.getWorkspace();
  const p = annotationsPath(fileName, workspace);
  if (!p) return { ok: false, status: 400, data: { error: "invalid name" } };
  const body = (payload.body ?? {}) as { annotations?: unknown };
  const list = Array.isArray(body.annotations) ? body.annotations : [];
  try {
    const result = deps.writeWorkspaceFile({ workspace, targetPath: p, content: JSON.stringify(list, null, 2), kind: "ui_annotations" });
    return ok({ ...result, count: list.length, identity: previewFileIdentity(fileName, requestedCwd, deps) });
  } catch (e) {
    return workspaceFileError(e, deps);
  }
}

/** GET /api/doc/:name/watch（server L1218-1230 转录；watch 语义差异见模块头与 doc-watch.ts）。 */
function invokeDocWatch(payload: InvokeEnvelope, deps: DocDirectDeps): InvokeResult<unknown> {
  const params = paramsOf(payload);
  const query = queryOf(payload);
  const fileName = String(params.name ?? "");
  const requestedCwd = requestedPreviewWorkspace(query, deps);
  const p = deps.resolvePath(fileName, requestedCwd);
  if (!p) return { ok: false, status: 404, data: { error: "not found" } };
  const identity = previewFileIdentity(fileName, requestedCwd, deps, p);
  try {
    deps.startDocWatch(p, fileName);
    return ok({ ok: true, identity });
  } catch (e) {
    return { ok: false, status: 500, data: { ok: false, error: (e as Error).message } };
  }
}

/** POST /api/doc/:name/watch/stop（server L1233-1239 逐点转录：恒 {ok:true}）。 */
function invokeDocWatchStop(payload: InvokeEnvelope, deps: DocDirectDeps): InvokeResult<unknown> {
  const params = paramsOf(payload);
  const query = queryOf(payload);
  const fileName = String(params.name ?? "");
  const requestedCwd = requestedPreviewWorkspace(query, deps);
  const p = deps.resolvePath(fileName, requestedCwd);
  if (p) deps.stopDocWatch(p);
  return ok({ ok: true });
}

/** POST /api/doc/:name/cells（server L1242-1262 逐点转录：ref → batch set，写锁 office_ui）。
 * 注意 cells 路由用 getWorkspace() 无显式 cwd（server resolvePath(fileName) 单参）。 */
async function invokeDocCells(payload: InvokeEnvelope, deps: DocDirectDeps): Promise<InvokeResult<unknown>> {
  const params = paramsOf(payload);
  const fileName = String(params.name ?? "");
  const p = deps.resolvePath(fileName);
  if (!p) return { ok: false, status: 404, data: { error: "not found" } };
  const body = (payload.body ?? {}) as { sheet?: unknown; cells?: unknown };
  const sheet = body.sheet;
  const cells = body.cells;
  if (!sheet || !Array.isArray(cells) || !cells.length) return { ok: false, status: 400, data: { error: "bad payload" } };
  const commands = cells
    .map((c) => {
      const ref = String((c as { ref?: unknown })?.ref || "").match(COL_RE);
      if (!ref) return null;
      return { command: "set", path: `/${sheet}/${ref[0]}`, props: { value: String((c as { value?: unknown })?.value ?? "") } };
    })
    .filter(Boolean) as Array<{ command: string; path: string; props: { value: string } }>;
  try {
    const r = await deps.withWriteLockAsync(
      { workspace: deps.getWorkspace(), targetPath: p, runId: `ui_${crypto.randomUUID()}`, kind: "office_ui" },
      () => deps.officeBatch(p, commands),
    );
    if (officeBatchFailed(r)) {
      const anyR = r as { stderr?: string; text?: string; json?: { error?: string } };
      return workspaceFileError(deps.normalizeOfficeFailure(new Error(anyR?.stderr || anyR?.text || anyR?.json?.error || "Excel 单元格保存失败"), commands, r), deps);
    }
    const anyR = r as { json?: unknown; text?: unknown };
    return ok({ ok: !(anyR?.json as { error?: unknown } | undefined)?.error, result: anyR?.json || anyR?.text });
  } catch (e) {
    return workspaceFileError(e, deps);
  }
}

/** POST /api/office（server L1265-1298 逐点转录：officecli 直通 + mutating 写锁）。 */
async function invokeOfficeRun(payload: InvokeEnvelope, deps: DocDirectDeps): Promise<InvokeResult<unknown>> {
  const body = (payload.body ?? {}) as { args?: unknown };
  if (!Array.isArray(body.args)) return { ok: false, status: 400, data: { error: "args required" } };
  const args = body.args.map(String);
  const allowedCommands = new Set(["view", "get", "set", "batch", "query", "watch", "close"]);
  if (!allowedCommands.has(args[0] ?? "")) {
    return { ok: false, status: 400, data: { error: "unsupported office command", allowed: [...allowedCommands] } };
  }
  // 只校验文件参数（args[1]）：DOM 路径如 /、/body/p[1] 在 Windows 上会被
  // path.isAbsolute 误判为绝对路径，不能对整个 args 做绝对路径检查。
  const fileArg = args[1] || "";
  if (fileArg && (path.isAbsolute(fileArg) || fileArg.split(/[\\/]/).includes(".."))) {
    return { ok: false, status: 400, data: { error: "office paths must stay inside the workspace" } };
  }
  const mutating = new Set(["set", "batch"]).has(args[0] ?? "");
  const workspace = deps.getWorkspace();
  const targetPath = mutating ? deps.resolvePath(args[1] ?? "", workspace) : null;
  if (mutating && !targetPath) {
    return { ok: false, status: 400, data: { ok: false, code: "WRITE_SCOPE_ERROR", error: "Office 文件必须是当前工作区内的现有文件" } };
  }
  try {
    const execute = () => deps.runOfficecli(args, { cwd: workspace });
    const r = mutating
      ? await deps.withWriteLockAsync({ workspace, targetPath: targetPath as string, runId: `ui_${crypto.randomUUID()}`, kind: "office_ui" }, execute)
      : await execute();
    const anyR = r as { code?: unknown; stdout?: unknown; stderr?: unknown; text?: unknown; json?: unknown };
    if (Number(anyR?.code) !== 0) {
      const officeError = new Error(String(anyR?.stderr || anyR?.text || `Office CLI 退出码 ${anyR?.code}`));
      (officeError as Error & { exitCode?: unknown }).exitCode = anyR?.code;
      return workspaceFileError(deps.normalizeOfficeFailure(officeError, args, r), deps);
    }
    // HTTP 形态响应含 requestId（req.requestId）；IPC 信封无对应不携带（语义差异见模块头）。
    return ok({ ok: true, code: anyR?.code, stdout: anyR?.stdout, stderr: anyR?.stderr, json: anyR?.json });
  } catch (e) {
    if ((e as { code?: unknown })?.code === "OFFICECLI_TIMEOUT") {
      return { ok: false, status: 504, data: { ok: false, code: String((e as { code?: unknown }).code ?? ""), error: (e as Error).message } };
    }
    return workspaceFileError(e, deps);
  }
}

/** POST /api/doc/edit（server L1303-1331 逐点转录：props 全值 String 归一后 batch）。 */
async function invokeDocEdit(payload: InvokeEnvelope, deps: DocDirectDeps): Promise<InvokeResult<unknown>> {
  const body = (payload.body ?? {}) as { file?: unknown; commands?: unknown };
  const file = body.file;
  const commands = body.commands;
  if (!file || !Array.isArray(commands) || !commands.length) {
    return { ok: false, status: 400, data: { error: "file and commands required" } };
  }
  const p = deps.resolvePath(String(file));
  if (!p) return { ok: false, status: 404, data: { error: "file not found" } };
  // 标准化 props：值转字符串（officecli 需要 "true"/"false"；server 两分支等价归一）
  const normalized = commands.map((c) => {
    const item = { ...((c ?? {}) as Record<string, unknown>) };
    if (item.props) {
      const props: Record<string, string> = {};
      for (const [k, v] of Object.entries(item.props as Record<string, unknown>)) props[k] = String(v);
      item.props = props;
    }
    return item;
  });
  try {
    const r = await deps.withWriteLockAsync(
      { workspace: deps.getWorkspace(), targetPath: p, runId: `ui_${crypto.randomUUID()}`, kind: "office_ui" },
      () => deps.officeBatch(p, normalized),
    );
    if (officeBatchFailed(r)) {
      const anyR = r as { stderr?: string; text?: string; json?: { error?: string } };
      return workspaceFileError(deps.normalizeOfficeFailure(new Error(anyR?.stderr || anyR?.text || anyR?.json?.error || "编辑失败"), normalized, r), deps);
    }
    const anyR = r as { json?: unknown; text?: unknown };
    return ok({ ok: true, result: anyR?.json || anyR?.text });
  } catch (e) {
    return workspaceFileError(e, deps);
  }
}

/** POST /api/doc/:name/raw-save（server L1334-1352 逐点转录：base64 + PK 头校验写回）。 */
function invokeDocRawSave(payload: InvokeEnvelope, deps: DocDirectDeps): InvokeResult<unknown> {
  const params = paramsOf(payload);
  const query = queryOf(payload);
  const fileName = String(params.name ?? "");
  const requestedCwd = requestedPreviewWorkspace(query, deps);
  const p = deps.resolvePath(fileName, requestedCwd);
  if (!p) return { ok: false, status: 404, data: { error: "not found" } };
  const body = (payload.body ?? {}) as { base64?: unknown };
  if (!body.base64) return { ok: false, status: 400, data: { error: "base64 required" } };
  try {
    const buf = Buffer.from(String(body.base64), "base64");
    // 校验是合法的 zip/docx（PK 头）
    if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
      return { ok: false, status: 400, data: { error: "不是有效的 docx 文件" } };
    }
    const result = deps.writeWorkspaceFile({ workspace: requestedCwd || deps.getWorkspace(), targetPath: p, content: buf, kind: "ui_docx_save" });
    return ok({ ...result, size: buf.length, identity: previewFileIdentity(fileName, requestedCwd, deps, p) });
  } catch (e) {
    return workspaceFileError(e, deps);
  }
}

/** doc 族直调分发器（unknown channel → 404；整体 500 { ok:false, error } 兜底）。 */
export async function invokeDocDirect(
  channel: string,
  payload: InvokeEnvelope | undefined,
  deps: DocDirectDeps
): Promise<InvokeResult<unknown>> {
  const envelope: InvokeEnvelope = payload ?? {};
  try {
    switch (channel as DocDirectChannel) {
      case "op:doc:open":
        return await invokeDocOpen(envelope, deps);
      case "op:doc:raw":
        return invokeDocRaw(envelope, deps);
      case "op:doc:text":
        return await invokeDocText(envelope, deps);
      case "op:doc:html":
        return await invokeDocHtml(envelope, deps);
      case "op:doc:comments":
        return await invokeDocComments(envelope, deps);
      case "op:doc:outline":
        return await invokeDocOutline(envelope, deps);
      case "op:doc:annotations":
        return invokeDocAnnotations(envelope, deps);
      case "op:doc:annotations-save":
        return await invokeDocAnnotationsSave(envelope, deps);
      case "op:doc:raw-save":
        return invokeDocRawSave(envelope, deps);
      case "op:doc:cells":
        return await invokeDocCells(envelope, deps);
      case "op:doc:edit":
        return await invokeDocEdit(envelope, deps);
      case "op:office:run":
        return await invokeOfficeRun(envelope, deps);
      case "op:doc:watch":
        return invokeDocWatch(envelope, deps);
      case "op:doc:watch-stop":
        return invokeDocWatchStop(envelope, deps);
      default:
        return { ok: false, status: 404, data: { error: `unknown channel: ${channel}` } } as InvokeResult<unknown>;
    }
  } catch (error) {
    const e = error as { message?: unknown };
    return { ok: false, status: 500, data: { ok: false, error: String(e?.message ?? error) } } as InvokeResult<unknown>;
  }
}
