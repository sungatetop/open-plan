import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
// 逐行等价迁移自 server/workspace.mjs（B6-4，agent 域直接上游，B2 收编时随域校正）。
// PROJECT_DIR 复用 workspace-paths.ts 锚点（B6-1 先例），B2 收编 main 进程时随锚点统一校正层级。
// 注意：当前仅对拍覆盖、未装配运行时；旧 JS 实现保留至域退役。
import { PROJECT_DIR } from "./workspace-paths";
import { atomicWriteJson } from "./persistence-utils";
import { AGENT_DIR, LOCAL_PI_AGENT_DIR } from "./agent/pi-config-management";

// 旧模块 export PROJECT_DIR，测试与下游经模块面取锚点，保持同名导出
export { PROJECT_DIR };

// AGENT_DIR 是规聚自己的配置目录；LOCAL_PI_AGENT_DIR 仅用于检测/显式导入。
// 两者由配置管理器统一解析，避免业务模块继续绑定某台机器的用户目录。
export { AGENT_DIR, LOCAL_PI_AGENT_DIR };

export const WORKSPACE_DIR = path.join(PROJECT_DIR, "office-workspace");
// CLIENT_DIST 已随 R6-7b client/ 本体删除退役（旧 sidecar 静态服务锚点，R6-4 后无生产消费）

// OfficeCLI 二进制解析优先级：
//   1. 环境变量 OFFICECLI_BIN（显式指定）
//   2. 项目内置 bin/officecli（node scripts/tools/install-officecli.mjs 安装）
//   3. 系统 PATH 中的 officecli
//   4. Windows 默认安装路径（officecli.ai 官方安装脚本）
function resolveOfficecli(): string {
  if (process.env.OFFICECLI_BIN) return process.env.OFFICECLI_BIN;
  const bundled = path.join(PROJECT_DIR, "bin", process.platform === "win32" ? "officecli.exe" : "officecli");
  if (fs.existsSync(bundled)) return bundled;
  const onPath = process.platform === "win32" ? null : (() => { try { return requireResolveInPath("officecli"); } catch { return null; } })();
  if (onPath) return onPath;
  return path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || process.env.HOME || ".", "AppData", "Local"), "OfficeCLI", "officecli.exe");
}

function requireResolveInPath(name: string): string | null {
  const dirs = (process.env.PATH || "").split(path.delimiter);
  for (const d of dirs) {
    try {
      const p = path.join(d, name);
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

export const OFFICECLI = resolveOfficecli();

fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

const ROOTS_STATE_FILE = path.join(PROJECT_DIR, ".file-roots.json");
export const SUPPORTED_EXTENSIONS = /\.(docx|doc|xlsx|xls|pptx|pdf|csv|json|md|markdown|txt|html|htm|wps|png|jpg|jpeg|gif|webp|bmp|svg|avif)$/i;
const SEARCH_SKIP_DIRS = new Set(["node_modules", ".git", ".venv", "__pycache__", ".next", "dist", "build", "coverage"]);

export interface FileRoot {
  id: string;
  path: string;
  label: string;
  created: string;
}

export interface WorkspaceEntry {
  name: string;
  size: number;
  mtime: number;
  ext: string;
  isDir: boolean;
}

export interface WorkspaceSearchResult {
  name: string;
  relPath: string;
  isDir: boolean;
  ext: string;
  size: number;
  mtime: number;
}

// 当前工作区（可切换），默认项目内的 office-workspace；切换后持久化，重启恢复
let _currentWorkspace = WORKSPACE_DIR;
const WS_STATE_FILE = path.join(PROJECT_DIR, ".workspace-state.json");
try {
  const saved = JSON.parse(fs.readFileSync(WS_STATE_FILE, "utf8")) as { workspace?: string } | null;
  const restored = saved?.workspace ? normalizeWorkspace(saved.workspace) : null;
  if (restored) _currentWorkspace = restored;
} catch {}

export function getWorkspace(): string {
  return _currentWorkspace;
}

/**
 * 解析并校验一个工作区目录，统一给 HTTP 层、Agent 和 Run 使用。
 * 返回 realpath，避免同一个目录因相对路径/符号链接产生多个运行归属。
 */
export function normalizeWorkspace(dir: string = _currentWorkspace, { create = false } = {}): string | null {
  const raw = String(dir || "").trim();
  if (!raw) return null;
  try {
    if (!fs.existsSync(raw)) {
      if (!create) return null;
      fs.mkdirSync(raw, { recursive: true });
    }
    const real = fs.realpathSync(raw);
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

export function setWorkspace(dir: string): boolean {
  try {
    const real = normalizeWorkspace(dir, { create: true });
    if (!real) return false;
    _currentWorkspace = real;
    // 合并写入，保留 hiddenWorkspaces 等已持久化字段
    let prev: any = {};
    try { prev = fs.existsSync(WS_STATE_FILE) ? JSON.parse(fs.readFileSync(WS_STATE_FILE, "utf8")) : {}; } catch {}
    prev.workspace = real;
    try { atomicWriteJson(WS_STATE_FILE, prev); } catch {}
    return true;
  } catch {
    return false;
  }
}

// 隐藏（删除）的工作区名单：持久化在 .workspace-state.json 的 hiddenWorkspaces 中，
// 用于让用户从下拉列表中移除不再需要的工作区路径（不破坏相关会话历史）。
export function getHiddenWorkspaces(): string[] {
  try {
    const state = JSON.parse(fs.readFileSync(WS_STATE_FILE, "utf8")) as { hiddenWorkspaces?: string[] } | null;
    return Array.isArray(state?.hiddenWorkspaces) ? state.hiddenWorkspaces : [];
  } catch {
    return [];
  }
}

export function hideWorkspace(dir: string): boolean {
  try {
    const state = fs.existsSync(WS_STATE_FILE) ? JSON.parse(fs.readFileSync(WS_STATE_FILE, "utf8")) as any : {};
    const list = Array.isArray(state.hiddenWorkspaces) ? state.hiddenWorkspaces : [];
    const d = fs.existsSync(dir) ? fs.realpathSync(dir) : String(dir);
    if (!list.includes(d)) list.push(d);
    state.hiddenWorkspaces = list;
    atomicWriteJson(WS_STATE_FILE, state);
    return true;
  } catch {
    return false;
  }
}

export function safeName(name: string): string | null {
  const base = path.basename(String(name || ""));
  if (!base || base.includes("..") || /[\\/:*?"<>|]/.test(base)) return null;
  return base;
}

export function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function readFileRoots(): FileRoot[] {
  try {
    const roots = JSON.parse(fs.readFileSync(ROOTS_STATE_FILE, "utf8")) as FileRoot[];
    return Array.isArray(roots)
      ? roots.filter((r): r is FileRoot => Boolean(r?.id) && Boolean(r?.path) && fs.existsSync(r.path))
      : [];
  } catch {
    return [];
  }
}

export function listFileRoots(): FileRoot[] {
  return readFileRoots().map((r) => ({ ...r, path: fs.realpathSync(r.path) }));
}

export function addFileRoot(dir: string, label = ""): { ok: boolean; error?: string; root?: FileRoot; roots?: FileRoot[] } {
  const raw = String(dir || "").trim();
  if (!raw) return { ok: false, error: "path required" };
  try {
    const real = fs.realpathSync(raw);
    if (!fs.statSync(real).isDirectory()) return { ok: false, error: "不是文件夹" };
    const roots = readFileRoots();
    const existing = roots.find((r) => r.path === real);
    if (existing) return { ok: true, root: { ...existing, path: real }, roots: listFileRoots() };
    const id = crypto.createHash("sha1").update(real).digest("hex").slice(0, 12);
    const root: FileRoot = { id, path: real, label: String(label || path.basename(real) || real), created: new Date().toISOString() };
    atomicWriteJson(ROOTS_STATE_FILE, [...roots, root]);
    return { ok: true, root, roots: listFileRoots() };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export function removeFileRoot(id: string): { ok: boolean; error?: string; roots?: FileRoot[] } {
  const roots = readFileRoots();
  const next = roots.filter((r) => r.id !== String(id || ""));
  if (next.length === roots.length) return { ok: false, error: "root not found" };
  atomicWriteJson(ROOTS_STATE_FILE, next);
  return { ok: true, roots: listFileRoots() };
}

export function resolveExternalPath(rootId: string, rel = ""): string | null {
  const root = listFileRoots().find((r) => r.id === String(rootId || ""));
  if (!root) return null;
  const clean = String(rel || "").replace(/^[/\\]+/, "");
  if (!clean || clean.includes("\0") || clean.split(/[\\/]/).includes("..") || path.isAbsolute(clean)) return null;
  const target = path.resolve(root.path, clean);
  if (!isInside(root.path, target) || !fs.existsSync(target)) return null;
  const real = fs.realpathSync(target);
  return isInside(root.path, real) ? real : null;
}

export function listWorkspace(dir?: string): WorkspaceEntry[] {
  const target = dir || _currentWorkspace;
  if (!fs.existsSync(target)) return [];
  const items = fs.readdirSync(target, { withFileTypes: true });
  const files = items
    .filter((e) => e.isFile() && !e.name.startsWith("~$") && !e.name.startsWith(".") && SUPPORTED_EXTENSIONS.test(e.name))
    .map((e): WorkspaceEntry => {
      const st = fs.statSync(path.join(target, e.name));
      return { name: e.name, size: st.size, mtime: st.mtimeMs, ext: path.extname(e.name).slice(1).toLowerCase(), isDir: false };
    });
  const dirs = items
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e): WorkspaceEntry => {
      const st = fs.statSync(path.join(target, e.name));
      return { name: e.name, size: 0, mtime: st.mtimeMs, ext: "folder", isDir: true };
    });
  return [...dirs, ...files].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** 在当前工作区递归搜索文件和目录名称，返回相对路径，避免前端逐层请求目录。 */
export function searchWorkspace(query: string, { dir = _currentWorkspace, limit = 200, maxDepth = 12 } = {}): WorkspaceSearchResult[] {
  const terms = String(query || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  const root = normalizeWorkspace(dir);
  if (!root || !terms.length) return [];
  const results: WorkspaceSearchResult[] = [];
  const pending: Array<{ absolute: string; relative: string; depth: number }> = [{ absolute: root, relative: "", depth: 0 }];
  const matches = (relative: string) => terms.every((term) => relative.toLowerCase().includes(term));
  while (pending.length && results.length < limit) {
    const current = pending.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current.absolute, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name.startsWith("~$")) continue;
      if (entry.isDirectory() && SEARCH_SKIP_DIRS.has(entry.name)) continue;
      const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      const absolute = path.join(current.absolute, entry.name);
      if (entry.isDirectory()) {
        if (matches(relative)) {
          try {
            const stat = fs.statSync(absolute);
            results.push({ name: entry.name, relPath: relative, isDir: true, ext: "folder", size: 0, mtime: stat.mtimeMs });
          } catch {}
        }
        if (current.depth < maxDepth) pending.push({ absolute, relative, depth: current.depth + 1 });
        continue;
      }
      if (!SUPPORTED_EXTENSIONS.test(entry.name) || !matches(relative)) continue;
      try {
        const stat = fs.statSync(absolute);
        results.push({ name: entry.name, relPath: relative, isDir: false, ext: path.extname(entry.name).slice(1).toLowerCase(), size: stat.size, mtime: stat.mtimeMs });
      } catch {}
      if (results.length >= limit) break;
    }
  }
  return results.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.relPath.localeCompare(b.relPath, undefined, { sensitivity: "base" });
  }).slice(0, limit);
}

// 解析相对路径（支持子目录），返回绝对路径
export function resolvePath(rel: string, workspace: string = _currentWorkspace): string | null {
  const raw = String(rel || "").trim();
  if (!raw || raw.includes("\0") || raw.split(/[\\/]/).includes("..") || path.isAbsolute(raw) || raw.startsWith("\\\\") || raw.startsWith("//") || /^[a-zA-Z]:[\\/]/.test(raw)) return null;
  const root = normalizeWorkspace(workspace);
  if (!root) return null;
  const n = raw.replace(/^\\/g, "").replace(/^\//g, "");
  const p = path.resolve(root, n);
  if (!isInside(root, p) || !fs.existsSync(p)) return null;
  try {
    const real = fs.realpathSync(p);
    return isInside(root, real) ? real : null;
  } catch {
    return null;
  }
}

export function filePath(name: string, workspace: string = _currentWorkspace): string | null {
  return resolvePath(name, workspace);
}
