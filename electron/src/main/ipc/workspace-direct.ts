/**
 * workspace 族通道直调器（D-3，非 agent 域收编第五批）：op:workspaces:list /
 * op:workspace:switch / op:workspace:validate / op:workspace:pick /
 * op:workspace:pick:cancel → 进程内直调 workspace 域 + 写探针 + Office CLI 探测 +
 * 原生选择器 + 会话历史扫描。
 *
 * 旧路径：渲染层 invoke → http-forward 转发 sidecar HTTP。本模块把 5 条通道的
 * sidecar 路由编排逐点转录为主进程内直调（行号锚点均指 server/index.mjs）：
 *   - op:workspaces:list（L3406-3448，最复杂处）：workspacesCache 5s TTL 聚合缓存 →
 *     默认工作区置顶 + 会话历史 cwd 扫描（首行 JSON 解析，canonical realpath 归一
 *     去重，仅收录含 docx/xlsx/pptx 的办公目录）→ 隐藏路径过滤（realpath 归一）→
 *     canonical 去重 → 写回缓存；
 *   - op:workspace:switch（L3466-3482）：!path→400；normalizeWorkspace null→400
 *     WORKSPACE_INVALID；写探针失败→403（writeAccess 整体透传）；setWorkspace
 *     失败→400 WORKSPACE_SWITCH_FAILED；成功 { ok, workspace, files }；
 *   - op:workspace:validate（L3520-3545）：normalizeWorkspace null→200 ok:false；
 *     写探针 + checkOfficecli 双检查（checks[1] officecli 投影）→ 200 聚合结果；
 *   - op:workspace:pick（L3485-3506）：pickFolder 对话框 → canceled / invalid /
 *     写探针失败均 200 ok:false 形状；catch 按 error.code 映射
 *     FOLDER_PICKER_UNAVAILABLE(501) / FOLDER_PICKER_TIMEOUT(500) /
 *     FOLDER_PICKER_FAILED(500)；
 *   - op:workspace:pick:cancel（L3509-3512）：先快照 activePickerInfo 再
 *     cancelActivePicker（顺序忠实）。
 * （POST /api/workspace/delete L3451-3463 与 GET /api/workspace/pick/state
 * L3515-3517 无对应 invoke 通道——旧 client 直连 sidecar HTTP，新渲染层无调用，
 * 不转录。）
 *
 * 语义差异（注释声明）：
 *   - workspacesCache 为本模块内联状态（server L3398-3403 为进程内 let）；
 *     invalidateWorkspacesCache 在 sidecar 由 delete 路由调用，IPC 形态无 delete
 *     通道，函数保留供接线层与测试使用；
 *   - pick 的 finally 在 HTTP 形态仅当请求被客户端中断（res.writableEnded=false）
 *     时收掉对话框；IPC invoke 无中断场景且 runPicker 结束时已自清 activePicker
 *     （native-files.ts L235），保留调用作为等价兜底（no-op，D-1a pick-files 同款）；
 *   - switch/validate/list/cancel 四条薄路由 sidecar 无整体 try/catch（异常走
 *     express 默认错误页），直调形态统一由分发器兜底 500 { ok:false, error }；
 *   - switch 成功分支新增 onSwitched 回调（生产广播 op:maps-changed，旧 sidecar
 *     无此推送——地图库跟随改造 2026-10-30，渲染层地图面板据此刷新）。
 *
 * 数据源：backend/workspace.ts（B2 对拍覆盖）+ backend/workspace-write-probe.ts
 * （S3-3）+ backend/office.ts checkOfficecli + backend/native-files.ts（S3-15）+
 * backend/agent/session-files.ts（readSessionTextCached）。
 *
 * 门控：OP_DESKTOP_WORKSPACE_DIRECT 且 OP_DESKTOP_AGENT_DOMAIN 双门控
 * （S4 语义：未设置=默认启用，=0 显式回滚——流量切换评估方案 §4-S4）。
 * 本模块不 import electron（纯逻辑，vitest 可直接测）；注册入口在 main/index.ts。
 */
import path from "node:path";
import type { InvokeEnvelope, InvokeResult } from "../../shared/protocol/channels";

/** workspace 族编排的跨域依赖（生产接线传 backend 真实模块与 fs 面，测试注入桩）。 */
export interface WorkspaceDirectDeps {
  /** 默认工作区目录（backend/workspace.ts WORKSPACE_DIR） */
  WORKSPACE_DIR: string;
  /** 当前工作区（backend/workspace.ts getWorkspace） */
  getWorkspace: () => string;
  /** 切换当前工作区（backend/workspace.ts setWorkspace） */
  setWorkspace: (dir: string) => boolean;
  /** 工作区文件清单（backend/workspace.ts listWorkspace） */
  listWorkspace: (dir?: string) => unknown[];
  /** 工作区路径归一（backend/workspace.ts normalizeWorkspace） */
  normalizeWorkspace: (dir: string) => string | null;
  /** 用户已删除（隐藏）的工作区路径（backend/workspace.ts getHiddenWorkspaces） */
  getHiddenWorkspaces: () => string[];
  /** 工作区写入探针（backend/workspace-write-probe.ts evaluateWorkspaceWrite，EvaluationCheck 形状；顶层 code 生产面缺省——server 原文 write.code || 回退） */
  evaluateWorkspaceWrite: (root: string) => { id: string; label: string; status: string; message: string; details: Record<string, unknown>; code?: string };
  /** Office CLI 探测（backend/office.ts checkOfficecli，无参调用等价默认 8s 超时；version 可 null、code 为进程退出码 number|null） */
  checkOfficecli: () => Promise<{ available: boolean; path?: string | null; version?: string | null; message?: string | null; code?: string | number | null }>;
  /** 原生文件夹选择器（backend/native-files.ts pickFolder） */
  pickFolder: (options?: { prompt?: string }) => Promise<{ canceled: boolean; path: string }>;
  /** 收掉等待中的选择器（backend/native-files.ts cancelActivePicker） */
  cancelActivePicker: () => boolean;
  /** 等待中选择器快照（backend/native-files.ts activePickerInfo） */
  activePickerInfo: () => { kind: string; startedAt: number; pid: number | null } | null;
  /** 会话文件清单（backend/agent/session-files.ts listSessionFiles） */
  listSessionFiles: () => Array<{ fileName: string; fullPath: string; storeDir: string; mtime: number; size: number; sessionId?: string }>;
  /** 会话全文缓存读（backend/agent/session-files.ts readSessionTextCached，取首行 JSON） */
  readSessionTextCached: (found: { fileName: string; fullPath: string; storeDir: string; mtime: number; size: number; sessionId?: string } | string) => string;
  /** fs 面（隐藏路径与办公目录探测），注入便于测试 */
  existsSync: (p: string) => boolean;
  /** 目录名清单（server 用默认返回文件名字符串数组形态） */
  readdirSync: (p: string) => Array<string>;
  /** realpath 归一（canonical 与隐藏路径比对） */
  realpathSync: (p: string) => string;
  /** switch 成功后回调（可选；生产接线广播 op:maps-changed 供地图面板刷新——地图库跟随改造 2026-10-30） */
  onSwitched?: (workspace: string) => void;
}

/** workspace 族直调 invoke 通道清单（与 DESKTOP_CHANNELS 对应路由一致）。 */
export const WORKSPACE_DIRECT_CHANNELS = [
  "op:workspaces:list",
  "op:workspace:switch",
  "op:workspace:validate",
  "op:workspace:pick",
  "op:workspace:pick:cancel"
] as const;

export type WorkspaceDirectChannel = (typeof WORKSPACE_DIRECT_CHANNELS)[number];

const ok = (data: unknown): InvokeResult<unknown> => ({ ok: true, status: 200, data });

function bodyOf(payload: InvokeEnvelope): Record<string, any> {
  const body = payload.body;
  return body && typeof body === "object" ? (body as Record<string, any>) : {};
}

/* --------------------------- workspaces 聚合缓存 --------------------------- */

/** server L3398-3399：聚合缓存与 5s TTL（IPC 形态内联在本模块）。 */
let workspacesCache: { createdAt: number; workspaces: Array<{ name: string; path: string }> } | null = null;
const WORKSPACES_CACHE_MS = 5000;

/** server L3401-3403：清空聚合缓存（sidecar delete 路由调用；IPC 无 delete 通道，保留供接线层使用）。 */
export function invalidateWorkspacesCache(): void {
  workspacesCache = null;
}

/** 可测性扩展：重置模块级缓存状态（server 侧为进程内 let，测试隔离需要）。 */
export function resetWorkspacesCacheForTest(): void {
  workspacesCache = null;
}

/* ------------------------------ 通道转录 ------------------------------ */

/** GET /api/workspaces（server L3406-3448 逐点转录：缓存 + 会话扫描 + 办公过滤 + 隐藏过滤 + 去重）。 */
function invokeWorkspacesList(deps: WorkspaceDirectDeps): InvokeResult<unknown> {
  if (workspacesCache && Date.now() - workspacesCache.createdAt < WORKSPACES_CACHE_MS) {
    return ok({ workspaces: workspacesCache.workspaces });
  }
  const hidden = new Set(deps.getHiddenWorkspaces().map((p) => (deps.existsSync(p) ? deps.realpathSync(p) : p)));
  const workspaces: Array<{ name: string; path: string }> = [{ name: "默认工作区", path: deps.WORKSPACE_DIR }];
  // canonical：realpath 小写归一，失败降级 path.resolve 小写（同一目录多形态收敛一键）
  const canonical = (value: string): string => {
    try {
      return deps.realpathSync(value).toLowerCase();
    } catch {
      return path.resolve(value).toLowerCase();
    }
  };
  const seen = new Set([canonical(deps.WORKSPACE_DIR)]);
  // 从会话历史里收集其他 cwd（存在 office 文件的工作区）
  for (const f of deps.listSessionFiles()) {
    try {
      const first = deps.readSessionTextCached(f).split(/\r?\n/)[0] ?? "";
      const h = JSON.parse(first) as { cwd?: string };
      const key = h.cwd ? canonical(h.cwd) : "";
      if (h.cwd && !seen.has(key)) {
        seen.add(key);
        // 只收录看起来是办公工作区的目录（有 docx/xlsx/pptx）
        let hasOffice = false;
        try {
          hasOffice = deps.readdirSync(h.cwd).some((f2) => /\.(docx|xlsx|pptx)$/i.test(f2));
        } catch {}
        if (hasOffice) workspaces.push({ name: h.cwd.split(/[\\\/]/).pop() || h.cwd, path: h.cwd });
      }
    } catch {}
  }
  // 过滤用户已删除（隐藏）的工作区路径
  const filtered = workspaces.filter((w) => {
    const rp = deps.existsSync(w.path) ? deps.realpathSync(w.path) : w.path;
    return !hidden.has(rp);
  });
  const unique: Array<{ name: string; path: string }> = [];
  const uniqueKeys = new Set<string>();
  for (const workspace of filtered) {
    const key = canonical(workspace.path);
    if (uniqueKeys.has(key)) continue;
    uniqueKeys.add(key);
    unique.push(workspace);
  }
  workspacesCache = { createdAt: Date.now(), workspaces: unique };
  return ok({ workspaces: unique });
}

/** POST /api/workspace/switch（server L3466-3482 逐点转录：写探针门禁 + 切换失败兜底）。 */
function invokeWorkspaceSwitch(payload: InvokeEnvelope, deps: WorkspaceDirectDeps): InvokeResult<unknown> {
  const dir = bodyOf(payload).path;
  if (!dir) return { ok: false, status: 400, data: { error: "path required" } };
  const workspace = deps.normalizeWorkspace(String(dir));
  if (!workspace) {
    return { ok: false, status: 400, data: { error: "路径不存在或不是可访问的文件夹", code: "WORKSPACE_INVALID" } };
  }
  const write = deps.evaluateWorkspaceWrite(workspace);
  if (write.status !== "passed") {
    return {
      ok: false,
      status: 403,
      data: {
        error: `无法将此目录用作可写工作区：${write.message || "当前服务进程没有写权限"}`,
        code: write.code || "WORKSPACE_WRITE_UNAVAILABLE",
        workspace,
        writeAccess: write
      }
    };
  }
  if (!deps.setWorkspace(workspace)) {
    return { ok: false, status: 400, data: { error: "工作区切换失败", code: "WORKSPACE_SWITCH_FAILED" } };
  }
  // 切换成功通知（地图库跟随：地图面板重拉项目清单 + 重载当前 style）
  deps.onSwitched?.(deps.getWorkspace());
  return ok({ ok: true, workspace: deps.getWorkspace(), files: deps.listWorkspace() });
}

/** POST /api/workspace/pick（server L3485-3506 逐点转录：对话框 + 同一套写探针，catch 按错误码映射）。 */
async function invokeWorkspacePick(deps: WorkspaceDirectDeps): Promise<InvokeResult<unknown>> {
  try {
    const picked = await deps.pickFolder({ prompt: "选择 Open Plan 可写工作区" });
    if (picked.canceled) return ok({ ok: false, canceled: true });
    const selected = picked.path;
    const workspace = deps.normalizeWorkspace(selected);
    if (!workspace) {
      return ok({ ok: false, workspace: selected, code: "WORKSPACE_INVALID", error: "路径不存在或不是可访问的文件夹" });
    }
    const write = deps.evaluateWorkspaceWrite(workspace);
    if (write.status !== "passed") {
      return ok({
        ok: false,
        workspace,
        code: write.code || "WORKSPACE_WRITE_UNAVAILABLE",
        error: write.message || "当前服务进程没有写权限",
        writeAccess: write
      });
    }
    return ok({ ok: true, workspace, writeAccess: write });
  } catch (error) {
    const e = error as { code?: string; message?: string };
    const unsupported = ["PICKER_UNSUPPORTED", "PICKER_UNAVAILABLE"].includes(e?.code ?? "");
    const code = unsupported ? "FOLDER_PICKER_UNAVAILABLE" : e?.code === "PICKER_TIMEOUT" ? "FOLDER_PICKER_TIMEOUT" : "FOLDER_PICKER_FAILED";
    return { ok: false, status: unsupported ? 501 : 500, data: { error: `文件夹选择器不可用：${e?.message || error}`, code } };
  } finally {
    // HTTP 形态：仅当请求被客户端中断（res.writableEnded=false）时收掉对话框；
    // IPC invoke 无中断场景，且 runPicker 结束时已自清 activePicker（native-files
    // L235），保留调用作为等价兜底（no-op，D-1a pick-files 同款）。
    deps.cancelActivePicker();
  }
}

/** POST /api/workspace/pick/cancel（server L3509-3512 逐点转录：先快照再取消，顺序忠实）。 */
function invokeWorkspacePickCancel(deps: WorkspaceDirectDeps): InvokeResult<unknown> {
  const info = deps.activePickerInfo();
  return ok({ ok: true, cancelled: deps.cancelActivePicker(), picker: info });
}

/** POST /api/workspace/validate（server L3520-3545 逐点转录：写探针 + Office CLI 双检查）。 */
async function invokeWorkspaceValidate(payload: InvokeEnvelope, deps: WorkspaceDirectDeps): Promise<InvokeResult<unknown>> {
  const dir = bodyOf(payload).path;
  if (!dir) return { ok: false, status: 400, data: { error: "path required" } };
  const workspace = deps.normalizeWorkspace(String(dir));
  if (!workspace) {
    return ok({ ok: false, code: "WORKSPACE_INVALID", workspace: String(dir), error: "路径不存在或不是可访问的文件夹" });
  }
  const write = deps.evaluateWorkspaceWrite(workspace);
  const officecli = await deps.checkOfficecli();
  const checks = [
    write,
    {
      id: "officecli",
      label: "Office CLI",
      status: officecli.available ? "passed" : "failed",
      message: officecli.available ? `Office CLI 可运行：${officecli.version || officecli.path}` : officecli.message || "Office CLI 不可用",
      details: { path: officecli.path, version: officecli.version || null, code: officecli.code ?? null }
    }
  ];
  return ok({
    ok: write.status === "passed",
    workspace,
    writeAccess: write,
    officecli: checks[1],
    checks,
    note: "探针以当前服务进程身份执行；Office CLI 可运行不代表目标工作区允许保存。"
  });
}

/** workspace 族直调分发器（unknown channel → 404；薄路由异常统一 500 兜底——语义差异见模块头）。 */
export async function invokeWorkspaceDirect(
  channel: string,
  payload: InvokeEnvelope | undefined,
  deps: WorkspaceDirectDeps
): Promise<InvokeResult<unknown>> {
  const envelope: InvokeEnvelope = payload ?? {};
  try {
    switch (channel as WorkspaceDirectChannel) {
      case "op:workspaces:list":
        return invokeWorkspacesList(deps);
      case "op:workspace:switch":
        return invokeWorkspaceSwitch(envelope, deps);
      case "op:workspace:validate":
        return await invokeWorkspaceValidate(envelope, deps);
      case "op:workspace:pick":
        return await invokeWorkspacePick(deps);
      case "op:workspace:pick:cancel":
        return invokeWorkspacePickCancel(deps);
      default:
        return { ok: false, status: 404, data: { error: `unknown channel: ${channel}` } } as InvokeResult<unknown>;
    }
  } catch (error) {
    // list/switch/validate/pick:cancel 四条薄路由 sidecar 无整体 try/catch（express
    // 默认错误页）；直调形态统一 500 { ok:false, error } JSON 信封，调用方语义等价。
    const e = error as { message?: unknown };
    return { ok: false, status: 500, data: { ok: false, error: String(e?.message ?? error) } } as InvokeResult<unknown>;
  }
}
