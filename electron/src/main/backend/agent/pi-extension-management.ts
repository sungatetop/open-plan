import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { APP_DATA_DIR } from "./pi-config-management";
import { atomicWriteJson, ensureDirectory, readJsonFile } from "../persistence-utils";

// Pi 扩展管理：用户自登记的 Pi 扩展（文件/目录）清单读写、路径存在性与 JS/TS 文件盘点、
// 启用态维护、enabled 面供 agent 装配消费。
// （自 server/pi-extension-management.mjs 逐行等价迁移；旧 JS 实现保留至域退役，
// HTTP 面五导出（list/add/update/check/delete）随流量切换批退役，enabled 两导出经
// assembly 直绑。JSON 内容为动态形状，入参保持宽容类型。CONFIG_FILE 经 APP_DATA_DIR
// 锚定（pi-config-management 加载期读 OAW_DATA_DIR）。）

export interface PublicPiExtension {
  id: string;
  name: string;
  path: string;
  enabled: boolean;
  exists: boolean;
  files: string[];
  lastCheck: any;
  requiresNewSession: boolean;
}

const CONFIG_FILE = path.join(APP_DATA_DIR, "集成", "pi-extensions.json");

function readConfig(): { version: number; extensions: any[] } {
  const value = readJsonFile<any>(CONFIG_FILE, { version: 1, extensions: [] });
  return { version: 1, extensions: Array.isArray(value?.extensions) ? value.extensions : [] };
}

function saveConfig(config: { version: number; extensions: any[] }): void {
  ensureDirectory(path.dirname(CONFIG_FILE));
  atomicWriteJson(CONFIG_FILE, { ...config, updatedAt: new Date().toISOString() });
}

function inspectPath(target: string): { exists: boolean; realPath: string | null; files: string[] } {
  try {
    const realPath = fs.realpathSync(path.resolve(target));
    const stat = fs.statSync(realPath);
    if (!stat.isDirectory() && !stat.isFile()) return { exists: false, realPath: null, files: [] };
    const files: string[] = [];
    const walk = (dir: string, depth = 0): void => {
      if (depth > 3 || files.length >= 100) return;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file, depth + 1);
        else if (/\.(?:[cm]?[jt]s|tsx?)$/i.test(entry.name)) files.push(path.relative(realPath, file).replace(/\\/g, "/"));
      }
    };
    if (stat.isDirectory()) walk(realPath);
    else files.push(path.basename(realPath));
    return { exists: true, realPath, files };
  } catch {
    return { exists: false, realPath: null, files: [] };
  }
}

function publicExtension(extension: any): PublicPiExtension {
  const inspected = inspectPath(extension.path);
  return {
    id: extension.id,
    name: extension.name,
    path: extension.path,
    enabled: Boolean(extension.enabled),
    exists: inspected.exists,
    files: inspected.files,
    lastCheck: extension.lastCheck || null,
    requiresNewSession: true,
  };
}

function makeId(name: string): string {
  const slug = String(name || "pi-extension").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "pi-extension";
  return `${slug}-${crypto.randomBytes(3).toString("hex")}`;
}

export function listPiExtensions(): PublicPiExtension[] {
  return readConfig().extensions.map(publicExtension);
}

export function addPiExtension(input: any = {}): PublicPiExtension {
  const name = String(input.name || "").trim().slice(0, 80);
  const target = String(input.path || "").trim();
  if (!target) throw new Error("请填写 Pi 扩展文件或目录路径");
  if (target.length > 4000) throw new Error("Pi 扩展路径过长");
  const inspected = inspectPath(target);
  if (!inspected.exists) throw new Error("找不到该文件或目录，请检查路径");
  const realPath = inspected.realPath!;
  const config = readConfig();
  if (config.extensions.some((item: any) => path.resolve(item.path) === realPath)) throw new Error("这个 Pi 扩展路径已经登记");
  const extension = {
    id: makeId(name || path.basename(realPath)),
    name: name || path.basename(realPath),
    path: realPath,
    enabled: false,
    lastCheck: { ok: true, at: new Date().toISOString(), files: inspected.files.length },
  };
  config.extensions.push(extension);
  saveConfig(config);
  return publicExtension(extension);
}

export function updatePiExtension(id: string, patch: any = {}): PublicPiExtension | null {
  const config = readConfig();
  const extension = config.extensions.find((item: any) => item.id === id);
  if (!extension) return null;
  if (patch.name !== undefined) extension.name = String(patch.name || "").trim().slice(0, 80) || extension.name;
  if (patch.enabled !== undefined) {
    const inspected = inspectPath(extension.path);
    if (patch.enabled && !inspected.exists) throw new Error("扩展路径当前不可用，修正路径后再启用");
    extension.enabled = Boolean(patch.enabled);
  }
  extension.lastCheck = { ok: inspectPath(extension.path).exists, at: new Date().toISOString() };
  saveConfig(config);
  return publicExtension(extension);
}

export function checkPiExtension(id: string): PublicPiExtension | null {
  const config = readConfig();
  const extension = config.extensions.find((item: any) => item.id === id);
  if (!extension) return null;
  const inspected = inspectPath(extension.path);
  extension.lastCheck = {
    ok: inspected.exists,
    at: new Date().toISOString(),
    files: inspected.files.length,
    message: inspected.exists
      ? (inspected.files.length ? `路径有效，发现 ${inspected.files.length} 个 JS/TS 文件；本检查未执行扩展代码。` : "路径有效，但未发现 JS/TS 文件。")
      : "路径不存在或不可读取。",
  };
  saveConfig(config);
  return publicExtension(extension);
}

export function deletePiExtension(id: string): boolean {
  const config = readConfig();
  const next = config.extensions.filter((item: any) => item.id !== id);
  if (next.length === config.extensions.length) return false;
  config.extensions = next;
  saveConfig(config);
  return true;
}

export function enabledPiExtensionPaths(): string[] {
  return readConfig().extensions
    .filter((item: any) => item.enabled && inspectPath(item.path).exists)
    .map((item: any) => inspectPath(item.path).realPath as string);
}

export function enabledPiExtensionEntries(): PublicPiExtension[] {
  return readConfig().extensions.filter((item: any) => item.enabled && inspectPath(item.path).exists).map(publicExtension);
}
