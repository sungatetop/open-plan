/**
 * 文件根目录与系统原生面通道直调器（D-1a，非 agent 域收编首批）：op:file-roots:* +
 * op:system:* → 进程内直调 workspace / native-files 域。
 *
 * 旧路径：渲染层 invoke → http-forward 转发 sidecar HTTP。本模块把 6 条通道的
 * sidecar 路由编排逐点转录为主进程内直调（行号锚点均指 server/index.mjs）：
 *   - op:file-roots:list（L918）：{ roots: listFileRoots() }；
 *   - op:file-roots:add（L919-922）：addFileRoot(path,label)，ok?200:400 整体透传；
 *   - op:file-roots:remove（L923-926）：removeFileRoot(id)，ok?200:404 整体透传；
 *   - op:system:reveal（L5653-5665）：assertNativeTargetAllowed → revealInFileManager
 *     → { ok:true, ...result, fileManager }（/api/open-in-explorer 兼容别名不设通道，
 *     渲染层只走 op:system:reveal）；
 *   - op:system:open（L5667-5682）：目录退化 reveal（opened:"reveal"）/ 文件走
 *     openWithDefaultApp（opened:"default-app"）；
 *   - op:system:pick-files（L5684-5712）：pickFiles → canceled 短路 → 逐路径
 *     rememberNativePick（TTL 白名单）→ 工作区内补相对路径（反斜杠归一）。
 *
 * 数据源：backend/workspace.ts（listFileRoots/addFileRoot/removeFileRoot/getWorkspace/
 * resolvePath/isInside，B2 对拍覆盖）+ backend/native-files.ts（pickFiles/
 * revealInFileManager/openWithDefaultApp/nativeCapabilities/cancelActivePicker，
 * S3-15 对拍覆盖）+ backend/project-management.ts（listProjects，白名单第三源）。
 *
 * 本地辅助转录（index.mjs L5595-5651 闭包 → 本模块纯函数逐行等价）：
 *   rememberNativePick（TTL 10min + 200 条上限惰性清理）/ nativeAllowedRoots
 *   （workspace + file-roots + projects 三源 realpath 白名单）/ resolveNativeTarget
 *   （绝对 realpath / 相对 resolvePath）/ assertNativeTargetAllowed（FILE_NOT_FOUND /
 *   PATH_OUTSIDE_WORKSPACE）/ nativeHttpStatus（404/403/501/500 映射）。
 *
 * 语义差异（注释声明）：pick-files 的 finally cancelActivePicker 兜底在 HTTP 形态
 * 防「客户端中断后对话框滞留」；IPC invoke 无中断场景且 pickFiles/runPicker 内部
 * 已自带清理，此处保留调用作为等价兜底（no-op）。
 *
 * 门控：OP_DESKTOP_NATIVE_SYSTEM_DIRECT 且 OP_DESKTOP_AGENT_DOMAIN 双门控
 * （S4 语义：未设置=默认启用，=0 显式回滚——流量切换评估方案 §4-S4）。
 * 本模块不 import electron（纯逻辑，vitest 可直接测）；注册入口在 main/index.ts。
 */
import path from "node:path";
import type { ChannelFailureData, InvokeEnvelope, InvokeResult } from "../../shared/protocol/channels";

/** 系统原生面编排的跨域依赖（生产接线传 backend 真实模块与 fs 面，测试注入桩）。 */
export interface NativeSystemDirectDeps {
  /** 文件根目录清单（backend/workspace.ts listFileRoots） */
  listFileRoots: () => Array<{ path: string }>;
  /** 新增文件根目录（backend/workspace.ts addFileRoot） */
  addFileRoot: (dir: unknown, label?: unknown) => { ok: boolean } & Record<string, unknown>;
  /** 移除文件根目录（backend/workspace.ts removeFileRoot） */
  removeFileRoot: (id: unknown) => { ok: boolean } & Record<string, unknown>;
  /** 当前工作区（backend/workspace.ts getWorkspace） */
  getWorkspace: () => string;
  /** 工作区相对路径解析（backend/workspace.ts resolvePath，不存在返回 null） */
  resolvePath: (rel: string) => string | null;
  /** 路径包含判定（backend/workspace.ts isInside） */
  isInside: (root: string, target: string) => boolean;
  /** 项目清单（backend/project-management.ts listProjects，白名单第三源取 rootPath） */
  listProjects: (filters: Record<string, unknown>) => Array<{ rootPath?: string }>;
  /** 在文件管理器中显示（backend/native-files.ts revealInFileManager） */
  revealInFileManager: (absPath: unknown) => Promise<{ ok: boolean; path: string }>;
  /** 系统默认应用打开（backend/native-files.ts openWithDefaultApp） */
  openWithDefaultApp: (absPath: unknown) => Promise<{ ok: boolean; path: string }>;
  /** 原生文件选择器（backend/native-files.ts pickFiles） */
  pickFiles: (options: { prompt: string; multiple: boolean; extensions: unknown[] }) => Promise<{ canceled: boolean; paths: string[] }>;
  /** 本机能力（backend/native-files.ts nativeCapabilities，取 fileManagerName） */
  nativeCapabilities: () => { fileManagerName?: string } & Record<string, unknown>;
  /** 收掉等待中的选择器（backend/native-files.ts cancelActivePicker） */
  cancelActivePicker: () => boolean;
  /** fs 面（realpath 白名单归一 / open 目录判定），注入便于测试 */
  realpathSync: (p: string) => string;
  statSync: (p: string) => { isDirectory(): boolean };
}

/** 系统原生面直调 invoke 通道清单（与 DESKTOP_CHANNELS 的 op:file-roots:* / op:system:* 一致）。 */
export const NATIVE_SYSTEM_DIRECT_CHANNELS = [
  "op:file-roots:list",
  "op:file-roots:add",
  "op:file-roots:remove",
  "op:system:reveal",
  "op:system:open",
  "op:system:pick-files"
] as const;

export type NativeSystemDirectChannel = (typeof NATIVE_SYSTEM_DIRECT_CHANNELS)[number];

const ok = (data: unknown): InvokeResult<unknown> => ({ ok: true, status: 200, data });

/** 非 2xx 信封（http-forward 非 2xx 同形：data = 服务端 JSON 错误体，含 code 等字段）。 */
const fail = (status: number, data: unknown): InvokeResult<unknown> => ({
  ok: false,
  status,
  data: data as ChannelFailureData
});

function bodyOf(payload: InvokeEnvelope): Record<string, any> {
  const body = payload.body;
  return body && typeof body === "object" ? (body as Record<string, any>) : {};
}

function paramsOf(payload: InvokeEnvelope): Record<string, unknown> {
  return (payload.params ?? {}) as Record<string, unknown>;
}

/* ------------------------- 本地辅助（server L5595-5651 转录） ------------------------- */

const recentNativePicks = new Map<string, number>();
const NATIVE_PICK_TTL_MS = 10 * 60 * 1000;

/** server L5598-5604：记录本机选择器最近选择（TTL 白名单），超 200 条惰性清理过期项。 */
function rememberNativePick(absPath: string): void {
  const now = Date.now();
  recentNativePicks.set(absPath, now + NATIVE_PICK_TTL_MS);
  if (recentNativePicks.size > 200) {
    for (const [key, expiry] of recentNativePicks) if (expiry <= now) recentNativePicks.delete(key);
  }
}

/** 测试专用：清空最近选择记录（可测性扩展，S3 session-files clearSessionCaches 先例）。 */
export function resetNativePickRecordForTest(): void {
  recentNativePicks.clear();
}

/** server L5606-5615：workspace + file-roots + projects 三源白名单（realpath 归一，失败跳过）。 */
function nativeAllowedRoots(deps: NativeSystemDirectDeps): string[] {
  const roots: string[] = [];
  try { roots.push(deps.getWorkspace()); } catch {}
  try { for (const root of deps.listFileRoots()) roots.push(root.path); } catch {}
  try { for (const project of deps.listProjects({})) roots.push(project.rootPath || ""); } catch {}
  return roots
    .filter(Boolean)
    .map((item) => { try { return deps.realpathSync(item); } catch { return null; } })
    .filter((item): item is string => Boolean(item));
}

/** server L5617-5625：「工作区相对路径」或「绝对路径」→ 真实绝对路径；不存在返回 null。 */
function resolveNativeTarget(input: unknown, deps: NativeSystemDirectDeps): string | null {
  const raw = String(input || "").trim();
  if (!raw) return null;
  if (path.isAbsolute(raw)) {
    try { return deps.realpathSync(raw); } catch { return null; }
  }
  return deps.resolvePath(raw);
}

/** server L5627-5640：校验并返回可操作的真实路径；不在白名单时抛 PATH_OUTSIDE_WORKSPACE。 */
function assertNativeTargetAllowed(input: unknown, deps: NativeSystemDirectDeps): string {
  const target = resolveNativeTarget(input, deps);
  if (!target) {
    const error = new Error("文件不存在或无法解析路径") as Error & { code?: string };
    error.code = "FILE_NOT_FOUND";
    throw error;
  }
  if ((recentNativePicks.get(target) || 0) > Date.now()) return target;
  if (nativeAllowedRoots(deps).some((root) => deps.isInside(root, target))) return target;
  const error = new Error("该路径不在任何工作区内，也不在本机选择器的最近选择中") as Error & { code?: string };
  error.code = "PATH_OUTSIDE_WORKSPACE";
  throw error;
}

/** server L5642-5647：错误 code → HTTP 状态映射。 */
function nativeHttpStatus(code: unknown): number {
  if (code === "FILE_NOT_FOUND") return 404;
  if (code === "PATH_OUTSIDE_WORKSPACE") return 403;
  if (code === "PICKER_UNSUPPORTED" || code === "PICKER_UNAVAILABLE") return 501;
  return 500;
}

/** server L5649-5651 sendNativeError 同形错误信封。 */
function nativeErrorResult(error: unknown, fallbackCode: string): InvokeResult<unknown> {
  const e = error as { code?: string; message?: unknown };
  return fail(nativeHttpStatus(e?.code), { ok: false, error: String(e?.message || error), code: e?.code || fallbackCode });
}

/* ------------------------------ 通道转录 ------------------------------ */

/** GET /api/file-roots（server L918 逐点转录）。 */
function invokeFileRootsList(_payload: InvokeEnvelope, deps: NativeSystemDirectDeps): InvokeResult<unknown> {
  return ok({ roots: deps.listFileRoots() });
}

/** POST /api/file-roots（server L919-922 逐点转录：ok?200:400 result 整体透传）。 */
function invokeFileRootsAdd(payload: InvokeEnvelope, deps: NativeSystemDirectDeps): InvokeResult<unknown> {
  const body = bodyOf(payload);
  const result = deps.addFileRoot(body?.path, body?.label);
  return { ok: Boolean(result.ok), status: result.ok ? 200 : 400, data: result } as InvokeResult<unknown>;
}

/** DELETE /api/file-roots/:id（server L923-926 逐点转录：ok?200:404 result 整体透传）。 */
function invokeFileRootsRemove(payload: InvokeEnvelope, deps: NativeSystemDirectDeps): InvokeResult<unknown> {
  const result = deps.removeFileRoot(paramsOf(payload).id);
  return { ok: Boolean(result.ok), status: result.ok ? 200 : 404, data: result } as InvokeResult<unknown>;
}

/** POST /api/system/reveal（server L5653-5662 逐点转录）。 */
async function invokeSystemReveal(payload: InvokeEnvelope, deps: NativeSystemDirectDeps): Promise<InvokeResult<unknown>> {
  try {
    const body = bodyOf(payload);
    const target = assertNativeTargetAllowed(body?.path ?? body?.name, deps);
    const result = await deps.revealInFileManager(target);
    return ok({ ...(result as Record<string, unknown>), ok: true, fileManager: deps.nativeCapabilities().fileManagerName });
  } catch (error) {
    return nativeErrorResult(error, "REVEAL_FAILED");
  }
}

/** POST /api/system/open（server L5667-5682 逐点转录：目录退化为 reveal）。 */
async function invokeSystemOpen(payload: InvokeEnvelope, deps: NativeSystemDirectDeps): Promise<InvokeResult<unknown>> {
  try {
    const body = bodyOf(payload);
    const target = assertNativeTargetAllowed(body?.path ?? body?.name, deps);
    let stat: { isDirectory(): boolean } | null = null;
    try { stat = deps.statSync(target); } catch {}
    if (stat?.isDirectory()) {
      const result = await deps.revealInFileManager(target);
      return ok({ ...(result as Record<string, unknown>), ok: true, opened: "reveal", fileManager: deps.nativeCapabilities().fileManagerName });
    }
    const result = await deps.openWithDefaultApp(target);
    return ok({ ...(result as Record<string, unknown>), ok: true, opened: "default-app" });
  } catch (error) {
    return nativeErrorResult(error, "OPEN_FAILED");
  }
}

/** POST /api/system/pick-files（server L5684-5712 逐点转录）。 */
async function invokeSystemPickFiles(payload: InvokeEnvelope, deps: NativeSystemDirectDeps): Promise<InvokeResult<unknown>> {
  try {
    const body = bodyOf(payload);
    const extensions = Array.isArray(body?.extensions) ? body.extensions : null;
    const result = await deps.pickFiles({
      prompt: String(body?.prompt || "选择要打开的文件"),
      multiple: body?.multiple !== false,
      extensions: extensions || []
    });
    if (result.canceled) return ok({ ok: false, canceled: true, files: [] });
    let workspace = "";
    try { workspace = deps.realpathSync(deps.getWorkspace()); } catch {}
    const files = result.paths.map((abs) => {
      rememberNativePick(abs);
      const insideWorkspace = Boolean(workspace) && deps.isInside(workspace, abs);
      return {
        path: abs,
        name: insideWorkspace ? path.relative(workspace, abs).replace(/\\/g, "/") : null,
        insideWorkspace
      };
    });
    return ok({ ok: true, canceled: false, files, fileManager: deps.nativeCapabilities().fileManagerName });
  } catch (error) {
    return nativeErrorResult(error, "PICKER_FAILED");
  } finally {
    // 同文件夹选择器兜底（HTTP 形态防中断滞留；IPC 无中断场景，no-op 等价保留）。
    deps.cancelActivePicker();
  }
}

/** 系统原生面直调分发器（unknown channel → 404，与 http-forward catch-all 行为对齐）。 */
export async function invokeNativeSystemDirect(
  channel: string,
  payload: InvokeEnvelope | undefined,
  deps: NativeSystemDirectDeps
): Promise<InvokeResult<unknown>> {
  const envelope: InvokeEnvelope = payload ?? {};
  switch (channel as NativeSystemDirectChannel) {
    case "op:file-roots:list":
      return invokeFileRootsList(envelope, deps);
    case "op:file-roots:add":
      return invokeFileRootsAdd(envelope, deps);
    case "op:file-roots:remove":
      return invokeFileRootsRemove(envelope, deps);
    case "op:system:reveal":
      return invokeSystemReveal(envelope, deps);
    case "op:system:open":
      return invokeSystemOpen(envelope, deps);
    case "op:system:pick-files":
      return invokeSystemPickFiles(envelope, deps);
    default:
      return fail(404, { error: `unknown channel: ${channel}` });
  }
}
