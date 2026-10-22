import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
// 逐行等价迁移自 server/write-coordination.mjs（B6-4，agent 域）。
// 旧实现 ROOT 以 server/ 上一级（仓库根）为基准；此处复用 workspace-paths.ts 的 PROJECT_DIR
// 锚点（B6-1 先例），解析结果一致，B2 收编时随锚点统一校正。
// RUNS_DIR/LOCK_DIR 仍支持 OAW_RUNS_DIR/OAW_WRITE_LOCK_DIR 环境变量覆盖。
// 注意：当前仅对拍覆盖、未装配运行时；旧 JS 实现保留至域退役。
import { PROJECT_DIR } from "../workspace-paths";
import { normalizeWorkspace, isInside } from "../workspace";
import { atomicWriteFile, atomicWriteJson, ensureDirectory, readJsonFile } from "../persistence-utils";

const ROOT = PROJECT_DIR;
const RUNS_DIR = process.env.OAW_RUNS_DIR || path.join(ROOT, ".oaw", "runs");
const LOCK_DIR = process.env.OAW_WRITE_LOCK_DIR || path.join(ROOT, ".oaw", "locks");

export interface WriteLockToken {
  key: string;
  runId: string;
  reentrant: boolean;
}

interface LockRecord {
  target: string;
  workspace: string;
  runId: string;
  threadId: string | null;
  kind: string;
  pid: number;
  lockedAt: string;
  references: number;
  lockFile?: string;
}

export interface WriteLockOptions {
  workspace?: string;
  targetPath?: string;
  runId?: string | null;
  threadId?: string | null;
  kind?: string;
  skipExternalOverlap?: boolean;
}

export type WriteEventSink = ((type: string, data: unknown) => void) | undefined;

interface ManifestEntry {
  path: string;
  stagedPath: string;
  status: string;
  kind: string;
  runId: string;
  threadId: string | null;
  stagedAt: string;
  writes: number;
  size: number;
  materializedAt?: string;
  publishedAt?: string;
}

interface Manifest {
  version: number;
  runId: string;
  files: ManifestEntry[];
  updatedAt?: string;
  status?: string;
  publishedAt?: string;
}

interface StageInfo {
  id: string;
  runDir: string;
  stagingDir: string;
  manifestFile: string;
}

interface TargetValidation {
  root: string;
  target: string;
  relative: string;
}

export class WriteConflictError extends Error {
  code: string;
  details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "WriteConflictError";
    this.code = "WRITE_CONFLICT";
    this.details = details;
  }
}

const locks = new Map<string, LockRecord>();

function safeRunId(runId: string): string {
  const value = String(runId || "").trim();
  if (!value || !/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error("活动 Run 标识无效");
  return value;
}

function now(): string { return new Date().toISOString(); }

function lockKey(target: string): string {
  const resolved = path.resolve(target);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function lockFileFor(key: string): string {
  return path.join(LOCK_DIR, `${crypto.createHash("sha1").update(key).digest("hex")}.lock`);
}

function processAlive(pid: unknown): boolean {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  if (Number(pid) === process.pid) return true;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function readLockFile(file: string): LockRecord | null {
  return readJsonFile<LockRecord | null>(file, null);
}

function overlapping(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return left === right || isInside(left, right) || isInside(right, left);
}

function findExternalOverlap(target: string): LockRecord | null {
  for (const record of locks.values()) {
    if (overlapping(record.target, target)) return record;
  }
  ensureDirectory(LOCK_DIR);
  for (const name of fs.readdirSync(LOCK_DIR).filter((item) => item.endsWith(".lock"))) {
    const file = path.join(LOCK_DIR, name);
    const record = readLockFile(file);
    if (!record || !overlapping(record.target, target)) continue;
    if (removeStaleLock(file, record)) continue;
    return { ...record, lockFile: file };
  }
  return null;
}

function removeStaleLock(file: string, record: LockRecord | null): boolean {
  if (record && processAlive(Number(record.pid))) return false;
  try { fs.rmSync(file, { force: true }); return true; } catch { return false; }
}

export function reclaimStaleWriteLocks(): number {
  ensureDirectory(LOCK_DIR);
  let reclaimed = 0;
  for (const name of fs.readdirSync(LOCK_DIR).filter((item) => item.endsWith(".lock"))) {
    const file = path.join(LOCK_DIR, name);
    const record = readLockFile(file);
    if (removeStaleLock(file, record)) reclaimed += 1;
  }
  return reclaimed;
}

function nearestExistingPath(target: string): string {
  let cursor = target;
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return cursor;
    cursor = parent;
  }
  return cursor;
}

function validateTarget(workspace: string, targetPath: string, { allowWorkspaceRoot = true } = {}): TargetValidation {
  const root = normalizeWorkspace(workspace);
  if (!root) {
    const error = new Error("工作区不存在或不是文件夹") as NodeJS.ErrnoException;
    error.code = "WORKSPACE_INVALID";
    throw error;
  }
  const requestedTarget = path.resolve(String(targetPath || ""));
  // macOS 的 /var、/tmp 等常见路径是指向 /private/... 的符号链接。
  // normalizeWorkspace 返回 realpath；目标也必须先按最近存在的父目录做同样规范化，
  // 否则合法的 /var/folders/... 工作区会被误判为逃逸出 /private/var/folders/...。
  const probe = nearestExistingPath(requestedTarget);
  let realProbe: string;
  try { realProbe = fs.realpathSync(probe); } catch { realProbe = probe; }
  const target = path.resolve(realProbe, path.relative(probe, requestedTarget));
  if (!isInside(root, target) || (!allowWorkspaceRoot && target === root)) {
    const error = new Error(`写入路径必须位于当前工作区内：${target}`) as NodeJS.ErrnoException;
    error.code = "WRITE_SCOPE_ERROR";
    throw error;
  }
  return { root, target, relative: path.relative(root, target).replace(/\\/g, "/") };
}

export function isProtectedMemoryTarget(workspace: string, targetPath: string): boolean {
  try {
    const { relative } = validateTarget(workspace, targetPath, { allowWorkspaceRoot: true });
    const normalized = relative.toLowerCase();
    return normalized === "agents.md" || normalized === "memory" || normalized.startsWith("memory/");
  } catch {
    return false;
  }
}

function stageInfo(runId: string): StageInfo {
  const id = safeRunId(runId);
  const runDir = ensureDirectory(path.join(RUNS_DIR, id));
  return {
    id,
    runDir,
    stagingDir: ensureDirectory(path.join(runDir, "staging")),
    manifestFile: path.join(runDir, "写入清单.json"),
  };
}

function loadManifest(runId: string): { info: StageInfo; manifest: Manifest } {
  const info = stageInfo(runId);
  const value = readJsonFile<Manifest>(info.manifestFile, { version: 1, runId: info.id, files: [] });
  return { info, manifest: value && Array.isArray(value.files) ? value : { version: 1, runId: info.id, files: [] } };
}

function saveManifest(info: StageInfo, manifest: Manifest): void {
  atomicWriteJson(info.manifestFile, manifest);
}

export function ensureRunStaging(runId: string, workspace: string): { runId: string; workspace: string | null; directory: string; manifest: string } {
  const info = stageInfo(runId);
  const root = normalizeWorkspace(workspace);
  return { runId: info.id, workspace: root, directory: info.stagingDir, manifest: info.manifestFile };
}

export function acquireWriteLock({ workspace, targetPath, runId, threadId = null, kind = "file", skipExternalOverlap = false }: WriteLockOptions = {}): WriteLockToken {
  const target = validateTarget(workspace as string, targetPath as string).target;
  const key = lockKey(target);
  const owner = String(runId || "").trim();
  if (!owner) {
    const error = new Error("写入操作必须绑定活动 Run") as NodeJS.ErrnoException;
    error.code = "RUN_REQUIRED";
    throw error;
  }
  const current = locks.get(key);
  if (current) {
    if (current.runId === owner) {
      current.references += 1;
      return { key, runId: owner, reentrant: true };
    }
    throw new WriteConflictError(`文件正在被其他任务修改：${path.relative(current.workspace, target).replace(/\\/g, "/") || "."}`, {
      target,
      workspace: current.workspace,
      ownerRunId: current.runId,
      ownerThreadId: current.threadId,
      ownerKind: current.kind,
      lockedAt: current.lockedAt,
    });
  }

  const overlap = (kind === "workspace_write_probe" || skipExternalOverlap) ? null : findExternalOverlap(target);
  if (overlap && overlap.runId !== owner) {
    throw new WriteConflictError(`写入范围与其他任务冲突：${overlap.target}`, {
      target,
      workspace: overlap.workspace,
      ownerRunId: overlap.runId,
      ownerThreadId: overlap.threadId,
      ownerKind: overlap.kind,
      lockedAt: overlap.lockedAt,
    });
  }

  ensureDirectory(LOCK_DIR);
  const file = lockFileFor(key);
  const existing = readLockFile(file);
  if (existing) {
    if (removeStaleLock(file, existing)) {
      // 继续尝试创建新的锁文件。
    } else {
      throw new WriteConflictError(`文件正在被其他进程修改：${target}`, {
        target,
        workspace: existing.workspace,
        ownerRunId: existing.runId,
        ownerThreadId: existing.threadId,
        ownerKind: existing.kind,
        lockedAt: existing.lockedAt,
      });
    }
  }

  const record: LockRecord = {
    target,
    workspace: path.resolve(workspace as string),
    runId: owner,
    threadId: threadId || null,
    kind: kind as string,
    pid: process.pid,
    lockedAt: now(),
    references: 1,
  };
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "wx");
    fs.writeFileSync(fd, JSON.stringify(record) + "\n", "utf8");
    try { fs.fsyncSync(fd); } catch {}
    locks.set(key, { ...record, lockFile: file });
    return { key, runId: owner, reentrant: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "EEXIST") {
      const latest = readLockFile(file);
      throw new WriteConflictError(`文件正在被其他进程修改：${target}`, { target, ...(latest as LockRecord | null) });
    }
    throw error;
  } finally {
    try { if (fd !== undefined) fs.closeSync(fd); } catch {}
  }
}

/**
 * 异步等待可用写锁。
 *
 * 背景：工作区级写锁（bash / officecli / 地图工具）此前一直持到 Run 结束，同一工作区
 * 并发执行两个任务时，后一个 Run 的每次写入都会被拒（实测 12 天内 33 次
 * “文件正在被其他任务修改”）。现在工具侧改为“用完即放”，并发时的重叠通常只有秒级，
 * 这里用短退避重试把冲突变成“稍等一下”，超过上限才按原错误抛出。
 */
export async function acquireWriteLockWithRetry(options: WriteLockOptions = {}, { timeoutMs = 20000, intervalMs = 350 } = {}): Promise<WriteLockToken> {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  for (;;) {
    try {
      return acquireWriteLock(options);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "WRITE_CONFLICT" || Date.now() >= deadline) throw error;
      const wait = intervalMs + Math.random() * 250;
      await new Promise((resolve) => { setTimeout(resolve, wait); });
    }
  }
}

export function releaseWriteLock(token: WriteLockToken | null | undefined): boolean {
  if (!token?.key) return false;
  const record = locks.get(token.key);
  if (!record || record.runId !== token.runId) return false;
  record.references = Math.max(0, Number(record.references || 1) - 1);
  if (record.references > 0) return true;
  locks.delete(token.key);
  try { fs.rmSync(record.lockFile as string, { force: true }); } catch {}
  return true;
}

export function releaseRunLocks(runId: string): number {
  const owner = String(runId || "");
  if (!owner) return 0;
  let released = 0;
  for (const [key, record] of locks) {
    if (record.runId !== owner) continue;
    locks.delete(key);
    try { fs.rmSync(record.lockFile as string, { force: true }); } catch {}
    released += 1;
  }
  return released;
}

export function holdWorkspaceWriteLock({ workspace, runId, threadId = null, kind = "workspace" }: { workspace?: string; runId?: string | null; threadId?: string | null; kind?: string } = {}): WriteLockToken {
  const root = normalizeWorkspace(workspace as string);
  return acquireWriteLock({ workspace: root as string, targetPath: root as string, runId, threadId, kind });
}

export function withWriteLock<T>(options: WriteLockOptions, callback: () => T): T {
  const token = acquireWriteLock(options);
  try {
    return callback();
  } finally {
    releaseWriteLock(token);
  }
}

export async function withWriteLockAsync<T>(options: WriteLockOptions, callback: () => Promise<T> | T): Promise<T> {
  const token = acquireWriteLock(options);
  try {
    return await callback();
  } finally {
    releaseWriteLock(token);
  }
}

export function writeWorkspaceFile({ workspace, targetPath, content, runId = null, threadId = null, kind = "ui_file", skipExternalOverlap = false }: { workspace: string; targetPath: string; content: string | Buffer; runId?: string | null; threadId?: string | null; kind?: string; skipExternalOverlap?: boolean }): { ok: boolean; workspace: string; path: string; status: string; size: number } {
  const { root, target, relative } = validateTarget(workspace, targetPath, { allowWorkspaceRoot: false });
  if (isProtectedMemoryTarget(root, target)) {
    const error = new Error("长期记忆必须通过 memory_update 建议并经用户审核，不能使用普通文件写入工具") as NodeJS.ErrnoException;
    error.code = "MEMORY_WRITE_REQUIRES_PROPOSAL";
    throw error;
  }
  const owner = runId || `ui_${crypto.randomUUID()}`;
  const token = acquireWriteLock({ workspace: root, targetPath: target, runId: owner, threadId, kind, skipExternalOverlap });
  try {
    const existed = fs.existsSync(target);
    atomicWriteFile(target, content);
    return {
      ok: true,
      workspace: root,
      path: relative,
      status: existed ? "modified" : "added",
      size: Buffer.isBuffer(content) ? content.length : Buffer.byteLength(String(content)),
    };
  } finally {
    releaseWriteLock(token);
  }
}

function emitWriteEvent(onEvent: WriteEventSink, type: string, data: unknown): void {
  try { onEvent?.(type, data); } catch {}
}

function eventData({ runId, workspace, target, relative, kind, threadId }: { runId: string; workspace: string; target: string; relative: string; kind: string; threadId: string | null }): Record<string, unknown> {
  return { runId, workspace, path: relative, target, kind, threadId: threadId || null };
}

export function stageWrite({ runId, workspace, targetPath, content, threadId = null, kind = "agent", onEvent }: { runId: string; workspace: string; targetPath: string; content: string | Buffer; threadId?: string | null; kind?: string; onEvent?: WriteEventSink }): Record<string, unknown> {
  const { root, target, relative } = validateTarget(workspace, targetPath, { allowWorkspaceRoot: false });
  if (!relative) throw new Error("不能把工作区根目录作为文件写入目标");
  if (isProtectedMemoryTarget(root, target) && !["attachment", "memory_approval"].includes(kind as string)) {
    const error = new Error("长期记忆必须通过 memory_update 建议并经用户审核，不能使用普通文件写入工具") as NodeJS.ErrnoException;
    error.code = "MEMORY_WRITE_REQUIRES_PROPOSAL";
    throw error;
  }
  const info = stageInfo(runId);
  const data = eventData({ runId: safeRunId(runId), workspace: root, target, relative, kind: kind as string, threadId });
  let token: WriteLockToken | undefined;
  try {
    token = acquireWriteLock({ workspace: root, targetPath: target, runId, threadId, kind });
    emitWriteEvent(onEvent, "write_started", data);
    emitWriteEvent(onEvent, "write_locked", data);
    const stagedPath = path.resolve(info.stagingDir, relative);
    if (!isInside(info.stagingDir, stagedPath)) throw new Error("临时产物路径非法");
    atomicWriteFile(stagedPath, content, "utf8");
    const { manifest } = loadManifest(runId);
    const previous = manifest.files.find((item) => item.path === relative);
    const entry: ManifestEntry = {
      path: relative,
      stagedPath: path.relative(info.runDir, stagedPath).replace(/\\/g, "/"),
      status: fs.existsSync(target) ? "modified" : "added",
      kind: kind as string,
      runId: safeRunId(runId),
      threadId: threadId || null,
      stagedAt: now(),
      writes: Number(previous?.writes || 0) + 1,
      size: Buffer.isBuffer(content) ? content.length : Buffer.byteLength(String(content), "utf8"),
    };
    manifest.files = [...manifest.files.filter((item) => item.path !== relative), entry];
    manifest.updatedAt = now();
    saveManifest(info, manifest);
    emitWriteEvent(onEvent, "artifact_staged", { ...data, stagedPath: entry.stagedPath, status: entry.status, size: entry.size });
    return { ok: true, ...entry, target };
  } catch (error) {
    emitWriteEvent(onEvent, "write_rejected", { ...data, code: (error as NodeJS.ErrnoException | undefined)?.code || "WRITE_FAILED", message: String((error as Error | undefined)?.message || error) });
    throw error;
  } finally {
    // Run 结束前故意不释放锁，避免同一 Run 的临时产物和其他 Run 交错发布。
    void token;
  }
}

function stagedPathFor(runId: string, workspace: string, targetPath: string): { root: string; target: string; relative: string; stagedPath: string | null; entry: ManifestEntry | null } {
  const { root, target, relative } = validateTarget(workspace, targetPath, { allowWorkspaceRoot: false });
  const { info, manifest } = loadManifest(runId);
  const entry = manifest.files.find((item) => item.path === relative);
  const stagedPath = entry ? path.resolve(info.runDir, entry.stagedPath) : null;
  if (stagedPath && isInside(info.stagingDir, stagedPath) && fs.existsSync(stagedPath)) return { root, target, relative, stagedPath, entry: entry as ManifestEntry };
  return { root, target, relative, stagedPath: null, entry: null };
}

export function resolveReadablePath({ runId, workspace, targetPath }: { runId?: string; workspace?: string; targetPath?: string } = {}): string {
  const raw = path.resolve(String(targetPath || ""));
  try {
    const result = stagedPathFor(runId as string, workspace as string, raw);
    return result.stagedPath || result.target;
  } catch {
    // Pi 的 read 允许读取工作区上级的 AGENTS.md；这类只读路径不纳入 staging。
    return raw;
  }
}

export function stagedAccess({ runId, workspace, targetPath }: { runId?: string; workspace?: string; targetPath?: string } = {}): string {
  const readable = resolveReadablePath({ runId, workspace, targetPath });
  fs.accessSync(readable, fs.constants.R_OK);
  return readable;
}

export function ensureStagedDirectory({ runId, workspace, targetPath, kind = "write" }: { runId: string; workspace: string; targetPath: string; kind?: string }): { root: string; directory: string } {
  const { root, relative } = validateTarget(workspace, targetPath, { allowWorkspaceRoot: true });
  if (isProtectedMemoryTarget(root, path.resolve(root, targetPath)) && !["attachment", "memory_approval"].includes(kind)) {
    const error = new Error("长期记忆目录不能通过普通文件工具创建") as NodeJS.ErrnoException;
    error.code = "MEMORY_WRITE_REQUIRES_PROPOSAL";
    throw error;
  }
  const info = stageInfo(runId);
  const directory = path.resolve(info.stagingDir, relative);
  if (!isInside(info.stagingDir, directory)) throw new Error("临时目录路径非法");
  ensureDirectory(directory);
  return { root, directory };
}

export function listStagedFiles(runId: string): ManifestEntry[] {
  return loadManifest(runId).manifest.files || [];
}

export function listStagedFilesForValidation(runId: string): Array<ManifestEntry & { file: string; root: string }> {
  const { info, manifest } = loadManifest(runId);
  return (manifest.files || []).map((entry) => ({
    ...entry,
    file: path.resolve(info.runDir, entry.stagedPath || ""),
    root: info.stagingDir,
  }));
}

/**
 * 把本轮暂存区里被**外部工具**（officecli 等独立进程）引用到的文件物化到真实磁盘。
 *
 * officecli 是独立进程，只认真实磁盘；而 Agent 用 write 工具写出的文件在暂存覆盖层里。
 * 不物化就会出现“文件明明写了，officecli 却说找不到”——实测里 Agent 因此反复失败绕道
 * （第二轮 `.ch6work/b4.json` 就是这样）。
 * 只物化被显式引用、且磁盘上没有更新版本的文件；返回被物化的相对路径。
 */
export function materializeStagedReferences({ runId, workspace, paths = [] }: { runId?: string; workspace?: string; paths?: string[] } = {}): string[] {
  if (!runId || !Array.isArray(paths) || !paths.length) return [];
  let loaded: { info: StageInfo; manifest: Manifest };
  try { loaded = loadManifest(runId); } catch { return []; }
  const { info, manifest } = loaded;
  const wanted = new Set(
    paths.map((item) => String(item || "").replace(/\\/g, "/").replace(/^\.\//, "").trim()).filter(Boolean),
  );
  if (!wanted.size) return [];
  const materialized: string[] = [];
  for (const entry of manifest.files || []) {
    const rel = String(entry.path || "").replace(/\\/g, "/");
    if (!wanted.has(rel)) continue;
    const stagedPath = path.resolve(info.runDir, entry.stagedPath || "");
    if (!isInside(info.stagingDir, stagedPath) || !fs.existsSync(stagedPath)) continue;
    let target: string;
    try { target = validateTarget(workspace as string, path.resolve(workspace as string, rel), { allowWorkspaceRoot: false }).target; } catch { continue; }
    try {
      const stagedStat = fs.statSync(stagedPath);
      const diskStat = fs.existsSync(target) ? fs.statSync(target) : null;
      // 磁盘上已有更新（或同样新）的版本就不覆盖：那种情况是 Agent 直接写盘的结果。
      if (diskStat && diskStat.mtimeMs >= stagedStat.mtimeMs) continue;
      ensureDirectory(path.dirname(target));
      fs.copyFileSync(stagedPath, target);
      entry.materializedAt = new Date().toISOString();
      materialized.push(rel);
    } catch {}
  }
  if (materialized.length) {
    try { saveManifest(info, manifest); } catch {}
  }
  return materialized;
}

function isTransientPublishError(error: unknown): boolean {
  return ["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException | undefined)?.code as string);
}

function materializeStagedFile(target: string, content: Buffer, existed: boolean): { fallback: boolean } {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      atomicWriteFile(target, content);
      return { fallback: false };
    } catch (error) {
      lastError = error;
      if (!isTransientPublishError(error)) throw error;
    }
  }
  // Windows security scanners can briefly reject the adjacent temp file. For
  // a new target only, direct creation is safe and avoids losing the staged
  // artifact; existing files still fail closed so rollback remains reliable.
  if (!existed && isTransientPublishError(lastError)) {
    try {
      fs.writeFileSync(target, content);
      return { fallback: true };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * 中间工作文件判定：Agent 的临时目录与备份文件不算交付产物。
 *
 * 实测踩坑：Agent 把 batch 输入放在 `.work/`，写完就删；但暂存清单里仍留着它，
 * Run 收尾发布时又把它复制回工作区，用户目录里于是多出一份垃圾（且 Agent 以为已清理）。
 * 这里统一认定“临时目录/备份后缀”不参与发布，工作区只留真正的产物。
 * 分隔符除 `/` 外还接受 `-._`：Agent 也常把临时文件写成 `.work-review.html` 这种
 * 平铺在工作区根目录的名字（实测留下过一个 82MB 的导出文件，规则不认就清不掉）。
 */
const TEMP_WORK_PATTERN = /^(?:\.work|\.tmp|\.temp|\.cache|\.scratch|\.ch6work|\.intermediate)(?:[-._/]|$)|\.(?:bak|tmp|temp|orig)$|~$/i;

export function isTempWorkPath(relPath: string): boolean {
  const rel = String(relPath || "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (!rel) return false;
  return TEMP_WORK_PATTERN.test(rel);
}

export function publishStagedRun(runId: string, workspace: string, { onEvent, threadId = null, paths = null }: { onEvent?: WriteEventSink; threadId?: string | null; paths?: string[] | null } = {}): ManifestEntry[] {
  const { root } = validateTarget(workspace, workspace);
  const { info, manifest } = loadManifest(runId);
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  // 临时工作文件与备份不发布：它们只是 Agent 的中间产物，不属于交付物。
  // 注意：被跳过的文件要从“待发布清单”里剔除（不能只丢进 skipped——后面的存在性校验仍会按全量清单检查，
  // 而跳过逻辑已经把暂存副本删了，会抛“临时产物不存在”把整轮判成失败）。
  const tempSkipped = files.filter((entry) => isTempWorkPath(entry.path));
  const publishable = files.filter((entry) => !isTempWorkPath(entry.path));
  const allowedPaths = Array.isArray(paths)
    ? new Set(paths.map((item) => String(item || "").replace(/\\/g, "/")).filter(Boolean))
    : null;
  const skipped = [
    ...tempSkipped,
    ...(allowedPaths ? publishable.filter((entry) => !allowedPaths.has(String(entry.path || "").replace(/\\/g, "/"))) : []),
  ];
  for (const entry of skipped) {
    const stagedPath = path.resolve(info.runDir, entry.stagedPath || "");
    if (isInside(info.stagingDir, stagedPath)) {
      try { fs.rmSync(stagedPath, { force: true }); } catch {}
    }
  }
  const checked = publishable.filter((entry) => !allowedPaths || allowedPaths.has(String(entry.path || "").replace(/\\/g, "/"))).map((entry) => {
    const target = validateTarget(root, path.resolve(root, entry.path), { allowWorkspaceRoot: false }).target;
    const stagedPath = path.resolve(info.runDir, entry.stagedPath || "");
    if (!isInside(info.stagingDir, stagedPath) || !fs.existsSync(stagedPath) || !fs.statSync(stagedPath).isFile()) throw new Error(`临时产物不存在：${entry.path}`);
    if (fs.existsSync(target) && !fs.statSync(target).isFile()) throw new Error(`正式目标不是文件：${entry.path}`);
    return { ...entry, target, stagedPath };
  });
  const fileLocks: WriteLockToken[] = [];
  const backups: Array<{ target: string; backupPath: string; existed: boolean }> = [];
  const backupDir = path.join(info.runDir, "发布备份");
  try {
    for (const entry of checked) {
      fileLocks.push(acquireWriteLock({ workspace: root, targetPath: entry.target, runId, threadId, kind: "artifact_publish" }));
      const backupPath = path.resolve(backupDir, entry.path);
      if (!isInside(backupDir, backupPath)) throw new Error(`发布备份路径非法：${entry.path}`);
      const existed = fs.existsSync(entry.target);
      if (existed) {
        ensureDirectory(path.dirname(backupPath));
        fs.copyFileSync(entry.target, backupPath);
      }
      backups.push({ target: entry.target, backupPath, existed });
      const content = fs.readFileSync(entry.stagedPath);
      const materialized = materializeStagedFile(entry.target, content, existed);
      entry.publishedAt = now();
      emitWriteEvent(onEvent, "artifact_materialized", { runId: safeRunId(runId), path: entry.path, kind: entry.kind, size: content.length, fallback: materialized.fallback || undefined });
    }
  } catch (error) {
    for (const backup of backups.reverse()) {
      try {
        if (backup.existed) atomicWriteFile(backup.target, fs.readFileSync(backup.backupPath));
        else fs.rmSync(backup.target, { force: true });
      } catch {}
    }
    throw error;
  } finally {
    for (const lock of fileLocks.reverse()) releaseWriteLock(lock);
    try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch {}
  }
  const next: Manifest = {
    ...manifest,
    files: checked.map((item) => {
      const { target: _target, stagedPath: _stagedPath, ...entry } = item;
      return { ...entry, status: "published" } as ManifestEntry;
    }),
    status: "published",
    publishedAt: now(),
    updatedAt: now(),
  };
  saveManifest(info, next);
  return next.files;
}

export function discardStagedRun(runId: string, { onEvent, reason = "run_not_completed" }: { onEvent?: WriteEventSink; reason?: string } = {}): { ok: boolean; count: number; reason: string } {
  const { info, manifest } = loadManifest(runId);
  const count = Array.isArray(manifest.files) ? manifest.files.length : 0;
  try { fs.rmSync(info.stagingDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(info.manifestFile, { force: true }); } catch {}
  emitWriteEvent(onEvent, "write_cleaned", { runId: safeRunId(runId), count, reason });
  return { ok: true, count, reason };
}

export function writeCoordinatorInfo(): { lockDir: string; activeLocks: number; stagedRunsDir: string } {
  return { lockDir: LOCK_DIR, activeLocks: locks.size, stagedRunsDir: RUNS_DIR };
}

reclaimStaleWriteLocks();
