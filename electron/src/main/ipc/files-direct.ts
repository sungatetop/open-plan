/**
 * files 族通道直调器（D-4，非 agent 域收编第六批·D 线收尾）：op:files:list /
 * op:files:search / op:files:upload / op:files:delete → 进程内直调 workspace 域 +
 * 写协同（writeWorkspaceFile / withWriteLockAsync）+ office.runOfficecli + 写权限错误归一。
 *
 * 旧路径：渲染层 invoke → http-forward 转发 sidecar HTTP。本模块把 4 条通道的
 * sidecar 路由编排逐点转录为主进程内直调（行号锚点均指 server/index.mjs）：
 *   - op:files:list（L839-858）：dir 越界判定（.. / 绝对路径）→ 400；请求级工作区
 *     解析（resolveRequestWorkspace：显式 invalid → 409）；dir 存在性判定 → 404；
 *     listWorkspace 投影（非目录补 mime/mtime/version=size:mtimeMs，stat 抛错透传原项）；
 *   - op:files:search（L860-871）：q/limit 归一（1..500 缺省 200）→ 空 query 空结果；
 *     searchWorkspace；catch 500 { error }；
 *   - op:files:upload（L969-986）：safeName/base64 校验 → 400；扩展名白名单 → 400
 *     「不支持的格式」；请求级工作区 409；withOfficecliReleaseRetry + writeWorkspaceFile
 *     （kind:"ui_upload"）→ { ...result, file, workspace }；
 *   - op:files:delete（L988-1003）：请求级工作区 409；resolvePath null → 404；
 *     withWriteLockAsync（runId:`ui_${randomUUID()}`，kind:"ui_delete"）+ unlinkSync →
 *     { ok:true, file: rel 正斜杠化, workspace }。
 *
 * 本地辅助转录：mimeForExt（L873-882 扩展名 MIME 表 + octet-stream 回退）/
 * resolveRequestWorkspace（L831-837 请求级工作区解析：显式携带 → 校验，未携带 →
 * 回退全局）/ withOfficecliReleaseRetry（L957-967：OFFICE_DOCUMENT_LOCKED 时先
 * `officecli close` 释放常驻句柄（15s 超时吞错）→ 等 400ms → 重试一次；非锁定错误
 * 原样抛出归一化错误）/ respondWorkspaceFileError（L928-936：normalizeWorkspaceWriteError
 * + workspaceWriteHttpStatus + code 回退 WORKSPACE_FILE_OPERATION_FAILED）。
 *
 * 语义差异（注释声明）：
 *   - respondWorkspaceFileError 的 requestId 在 HTTP 形态为每请求 uuid；IPC 无 HTTP
 *     req → requestId=null（C-7 先例）；
 *   - list/upload/delete 薄路由与 search 的 catch 面各自忠实转录；list 无整体
 *     try/catch（express 默认错误页），直调形态由分发器兜底 500 { ok:false, error }。
 *
 * 数据源：backend/workspace.ts（safeName/resolvePath/listWorkspace/searchWorkspace，
 * B2 对拍覆盖）+ backend/agent/write-coordination.ts（writeWorkspaceFile/
 * withWriteLockAsync，B2-4/B6 对拍覆盖）+ backend/file-permission-error.ts
 * （normalizeWorkspaceWriteError/workspaceWriteHttpStatus）+ backend/office.ts runOfficecli。
 *
 * 门控：OP_DESKTOP_FILES_DIRECT 且 OP_DESKTOP_AGENT_DOMAIN 双门控
 * （S4 语义：未设置=默认启用，=0 显式回滚——流量切换评估方案 §4-S4）。
 * 本模块不 import electron（纯逻辑，vitest 可直接测）；注册入口在 main/index.ts。
 */
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { InvokeEnvelope, InvokeResult } from "../../shared/protocol/channels";

/** files 族编排的跨域依赖（生产接线传 backend 真实模块与 fs 面，测试注入桩）。 */
export interface FilesDirectDeps {
  /** 当前工作区（backend/workspace.ts getWorkspace） */
  getWorkspace: () => string;
  /** 工作区路径归一（backend/workspace.ts normalizeWorkspace） */
  normalizeWorkspace: (dir: string) => string | null;
  /** 工作区内路径解析（backend/workspace.ts resolvePath，越界返回 null） */
  resolvePath: (rel: string, workspace?: string) => string | null;
  /** 上传文件名清洗（backend/workspace.ts safeName，非法返回 null） */
  safeName: (name: string) => string | null;
  /** 工作区文件清单（backend/workspace.ts listWorkspace，WorkspaceEntry 形状宽松） */
  listWorkspace: (dir?: string) => Array<Record<string, any>>;
  /** 工作区搜索（backend/workspace.ts searchWorkspace） */
  searchWorkspace: (query: string, options?: { dir?: string; limit?: number }) => unknown[];
  /** 受锁写入（backend/agent/write-coordination.ts writeWorkspaceFile，同步） */
  writeWorkspaceFile: (input: { workspace: string; targetPath: string; content: string | Buffer; kind?: string; runId?: string | null; threadId?: string | null; skipExternalOverlap?: boolean }) => { ok: boolean; workspace: string; path: string; status: string; size: number };
  /** 写锁编排（backend/agent/write-coordination.ts withWriteLockAsync；调用面丢弃返回值故非泛型签名） */
  withWriteLockAsync: (options: { workspace: string; targetPath: string; runId: string; kind: string }, callback: () => unknown) => Promise<unknown>;
  /** OfficeCLI 调用（backend/office.ts runOfficecli；释放句柄用 close + 15s） */
  runOfficecli: (args: unknown, options?: { cwd?: string; timeoutMs?: number }) => Promise<unknown>;
  /** 写权限错误归一（backend/file-permission-error.ts normalizeWorkspaceWriteError） */
  normalizeWorkspaceWriteError: (error: any) => { code?: string; message: string } & Record<string, any>;
  /** 错误 → HTTP 状态映射（backend/file-permission-error.ts workspaceWriteHttpStatus） */
  workspaceWriteHttpStatus: (error: any) => number;
  /** fs 面（dir 存在性/目录判定与删除），注入便于测试 */
  existsSync: (p: string) => boolean;
  statSync: (p: string) => { isDirectory(): boolean; mtimeMs: number; size: number };
  unlinkSync: (p: string) => void;
}

/** files 族直调 invoke 通道清单（与 DESKTOP_CHANNELS 对应路由一致）。 */
export const FILES_DIRECT_CHANNELS = [
  "op:files:list",
  "op:files:search",
  "op:files:upload",
  "op:files:delete"
] as const;

export type FilesDirectChannel = (typeof FILES_DIRECT_CHANNELS)[number];

const ok = (data: unknown): InvokeResult<unknown> => ({ ok: true, status: 200, data });

function bodyOf(payload: InvokeEnvelope): Record<string, any> {
  const body = payload.body;
  return body && typeof body === "object" ? (body as Record<string, any>) : {};
}

function paramsOf(payload: InvokeEnvelope): Record<string, unknown> {
  return (payload.params ?? {}) as Record<string, unknown>;
}

/* ------------------------------ 本地辅助转录 ------------------------------ */

/** server L873-882：扩展名 → MIME（表 + octet-stream 回退，逐字转录）。 */
function mimeForExt(ext: unknown): string {
  return ({
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xls: "application/vnd.ms-excel",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    pdf: "application/pdf", csv: "text/csv", json: "application/json",
    md: "text/markdown", markdown: "text/markdown", txt: "text/plain", html: "text/html", htm: "text/html"
  } as Record<string, string>)[String(ext || "").toLowerCase()] || "application/octet-stream";
}

/** server L831-837：请求级工作区解析（显式携带 → 校验；未携带 → 回退全局，回显真实来源）。 */
function resolveRequestWorkspace(query: Record<string, unknown>, deps: FilesDirectDeps) {
  const raw = String(query.workspace || query.cwd || "").trim();
  if (!raw) return { workspace: deps.getWorkspace(), explicit: false };
  const normalized = deps.normalizeWorkspace(raw);
  if (!normalized) return { workspace: null, explicit: true, invalid: raw };
  return { workspace: normalized, explicit: true };
}

/** server L957-967：文档锁定（OfficeCLI 常驻句柄）→ close 释放 + 400ms + 重试一次。 */
async function withOfficecliReleaseRetry<T>(workspace: string, fileName: string, operation: () => Promise<T> | T, deps: FilesDirectDeps): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const normalized = deps.normalizeWorkspaceWriteError(error);
    if (normalized.code !== "OFFICE_DOCUMENT_LOCKED") throw normalized;
    try {
      await deps.runOfficecli(["close", fileName], { cwd: workspace, timeoutMs: 15000 });
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 400));
    return await operation();
  }
}

/** server L928-936：写权限错误响应（requestId=null——IPC 无 HTTP req，C-7 先例）。 */
function respondWorkspaceFileError(deps: FilesDirectDeps, error: unknown): InvokeResult<unknown> {
  const normalized = deps.normalizeWorkspaceWriteError(error);
  return {
    ok: false,
    status: deps.workspaceWriteHttpStatus(normalized),
    data: {
      ok: false,
      code: normalized.code || "WORKSPACE_FILE_OPERATION_FAILED",
      error: normalized.message,
      requestId: null
    }
  };
}

/* ------------------------------ 通道转录 ------------------------------ */

/** GET /api/files（server L839-858 逐点转录：越界 400 / 请求级工作区 409 / dir 404 / mime 投影）。 */
function invokeFilesList(payload: InvokeEnvelope, deps: FilesDirectDeps): InvokeResult<unknown> {
  const query = paramsOf(payload);
  const dir = String(query.dir ?? "");
  // 只允许相对路径，防止越界
  if (dir && (dir.includes("..") || dir.startsWith("/") || /^[a-zA-Z]:/.test(dir))) {
    return { ok: false, status: 400, data: { error: "invalid dir" } };
  }
  const resolved = resolveRequestWorkspace(query, deps);
  if (resolved.explicit && !resolved.workspace) {
    return { ok: false, status: 409, data: { error: "unknown workspace", workspace: resolved.invalid } };
  }
  const workspace = resolved.workspace as string;
  const target = dir ? deps.resolvePath(dir, workspace) : workspace;
  if (dir && (!target || !deps.existsSync(target) || !deps.statSync(target).isDirectory())) {
    return { ok: false, status: 404, data: { error: "directory not found", workspace } };
  }
  // 404 判定已保证 target 非 null（dir 非空且 resolvePath null / 不存在 / 非目录均已
  // 提前返回；dir 为空时 target=workspace）——server 同款控制流，TS 推不出故断言。
  const targetDir = target as string;
  const files = deps.listWorkspace(targetDir).map((item) => {
    if (item.isDir) return item;
    const p = path.join(targetDir, item.name);
    try {
      const st = deps.statSync(p);
      return { ...item, mime: mimeForExt(item.ext), mtime: st.mtimeMs, version: `${st.size}:${st.mtimeMs}` };
    } catch {
      return item;
    }
  });
  return ok({ files, dir, workspace });
}

/** GET /api/files/search（server L860-871 逐点转录：limit 归一 1..500 / 空 query 空结果 / catch 500）。 */
function invokeFilesSearch(payload: InvokeEnvelope, deps: FilesDirectDeps): InvokeResult<unknown> {
  const query = paramsOf(payload);
  const q = String(query.q || "").trim();
  const limit = Math.max(1, Math.min(500, Number.parseInt(String(query.limit || "200"), 10) || 200));
  const resolved = resolveRequestWorkspace(query, deps);
  if (resolved.explicit && !resolved.workspace) {
    return { ok: false, status: 409, data: { error: "unknown workspace", workspace: resolved.invalid } };
  }
  const workspace = resolved.workspace as string;
  if (!q) return ok({ files: [], query: "", workspace });
  try {
    return ok({ files: deps.searchWorkspace(q, { dir: workspace, limit }), query: q, workspace });
  } catch (error) {
    const e = error as { message?: unknown };
    return { ok: false, status: 500, data: { error: String(e?.message ?? error) } };
  }
}

/** POST /api/files/upload（server L969-986 逐点转录：base64 非 multipart + 锁定释放重试）。 */
async function invokeFilesUpload(payload: InvokeEnvelope, deps: FilesDirectDeps): Promise<InvokeResult<unknown>> {
  const body = bodyOf(payload);
  const { name, base64, workspace: rawWorkspace } = body;
  const safe = deps.safeName(String(name ?? ""));
  if (!safe || !base64) return { ok: false, status: 400, data: { error: "invalid upload" } };
  const buf = Buffer.from(String(base64), "base64");
  if (!/\.(docx|xlsx|xls|pptx|pdf|csv|json|md|markdown|txt|html|htm)$/i.test(safe)) {
    return { ok: false, status: 400, data: { error: "不支持的格式" } };
  }
  // 上传必须落在请求声明的工作区，不能用全局可变值（交互 1）
  const requested = rawWorkspace ? deps.normalizeWorkspace(String(rawWorkspace)) : null;
  if (rawWorkspace && !requested) {
    return { ok: false, status: 409, data: { error: "unknown workspace", workspace: rawWorkspace } };
  }
  try {
    const workspace = requested || deps.getWorkspace();
    const result = await withOfficecliReleaseRetry(workspace, safe, () =>
      deps.writeWorkspaceFile({ workspace, targetPath: path.join(workspace, safe), content: buf, kind: "ui_upload" }), deps);
    return ok({ ...(result as Record<string, unknown>), file: safe, workspace });
  } catch (error) {
    return respondWorkspaceFileError(deps, error);
  }
}

/** POST /api/files/delete（server L988-1003 逐点转录：写锁 + unlink + 锁定释放重试）。 */
async function invokeFilesDelete(payload: InvokeEnvelope, deps: FilesDirectDeps): Promise<InvokeResult<unknown>> {
  const body = bodyOf(payload);
  const { name, workspace: rawWorkspace } = body;
  const requested = rawWorkspace ? deps.normalizeWorkspace(String(rawWorkspace)) : null;
  if (rawWorkspace && !requested) {
    return { ok: false, status: 409, data: { error: "unknown workspace", workspace: rawWorkspace } };
  }
  const workspaceRoot = requested || deps.getWorkspace();
  const p = deps.resolvePath(String(name ?? ""), workspaceRoot);
  if (!p) return { ok: false, status: 404, data: { error: "not found" } };
  try {
    const rel = path.relative(workspaceRoot, p);
    await withOfficecliReleaseRetry(workspaceRoot, rel, () =>
      deps.withWriteLockAsync({ workspace: workspaceRoot, targetPath: p, runId: `ui_${randomUUID()}`, kind: "ui_delete" }, () => deps.unlinkSync(p)), deps);
    return ok({ ok: true, file: rel.replace(/\\/g, "/"), workspace: workspaceRoot });
  } catch (error) {
    return respondWorkspaceFileError(deps, error);
  }
}

/** files 族直调分发器（unknown channel → 404；list 薄路由异常统一 500 兜底——语义差异见模块头）。 */
export async function invokeFilesDirect(
  channel: string,
  payload: InvokeEnvelope | undefined,
  deps: FilesDirectDeps
): Promise<InvokeResult<unknown>> {
  const envelope: InvokeEnvelope = payload ?? {};
  try {
    switch (channel as FilesDirectChannel) {
      case "op:files:list":
        return invokeFilesList(envelope, deps);
      case "op:files:search":
        return invokeFilesSearch(envelope, deps);
      case "op:files:upload":
        return await invokeFilesUpload(envelope, deps);
      case "op:files:delete":
        return await invokeFilesDelete(envelope, deps);
      default:
        return { ok: false, status: 404, data: { error: `unknown channel: ${channel}` } } as InvokeResult<unknown>;
    }
  } catch (error) {
    // list 在 sidecar 无整体 try/catch（express 默认错误页）；直调形态统一
    // 500 { ok:false, error } JSON 信封，调用方语义等价。
    const e = error as { message?: unknown };
    return { ok: false, status: 500, data: { ok: false, error: String(e?.message ?? error) } } as InvokeResult<unknown>;
  }
}
