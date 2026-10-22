import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// 规聚本地运行数据的安全持久化工具（自 server/persistence-utils.mjs 逐行等价迁移）。
// 先写同目录临时文件并尽力完成 fsync，再替换目标文件，避免服务异常时直接截断原文件。
// 注意：当前仅对拍覆盖、未装配运行时；旧 JS 实现保留至域退役。

export function ensureDirectory(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function temporaryPath(file: string, suffix = "tmp"): string {
  return `${file}.${process.pid}.${crypto.randomUUID()}.${suffix}`;
}

function closeQuietly(fd: number | undefined | null): void {
  try { if (fd !== undefined && fd !== null) fs.closeSync(fd); } catch {}
}

function replaceFile(temp: string, file: string): void {
  try {
    fs.renameSync(temp, file);
    return;
  } catch (error) {
    // Windows 不允许 rename 覆盖已存在目标；先移动旧文件，失败时尽力恢复。
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (!fs.existsSync(file) || !["EEXIST", "EPERM", "ENOTEMPTY"].includes(code ?? "")) throw error;
  }
  const backup = temporaryPath(file, "bak");
  fs.renameSync(file, backup);
  try {
    fs.renameSync(temp, file);
    try { fs.rmSync(backup, { force: true }); } catch {}
  } catch (error) {
    try {
      if (!fs.existsSync(file) && fs.existsSync(backup)) fs.renameSync(backup, file);
    } catch {}
    throw error;
  }
}

export function atomicWriteFile(file: string, data: string | Buffer, encoding: BufferEncoding = "utf8"): string {
  const target = path.resolve(file);
  ensureDirectory(path.dirname(target));
  const temp = temporaryPath(target);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, "w");
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data), encoding);
    fs.writeFileSync(fd, buffer);
    try { fs.fsyncSync(fd); } catch {}
    closeQuietly(fd);
    fd = undefined;
    replaceFile(temp, target);
  } catch (error) {
    closeQuietly(fd);
    try { fs.rmSync(temp, { force: true }); } catch {}
    throw error;
  }
  return target;
}

export function atomicWriteJson(file: string, value: unknown): string {
  return atomicWriteFile(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

/** 使用 O_APPEND 写入一条完整 JSONL，并在可用时 flush 到磁盘。 */
export function appendJsonLine(file: string, value: unknown): string {
  const target = path.resolve(file);
  ensureDirectory(path.dirname(target));
  const fd = fs.openSync(target, "a");
  try {
    fs.writeFileSync(fd, JSON.stringify(value) + "\n", "utf8");
    try { fs.fsyncSync(fd); } catch {}
  } finally {
    closeQuietly(fd);
  }
  return target;
}

export function readJsonFile<T = unknown>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; } catch { return fallback; }
}
