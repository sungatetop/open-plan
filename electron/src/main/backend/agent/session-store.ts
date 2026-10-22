/**
 * 会话存储定位（B6-6-4f，自 server/agent.mjs L168-225 逐行转录）。
 *
 * - SESSION_STORE：工作台会话 JSONL 存储根（PROJECT_DIR/.规聚会话），模块加载期建目录
 *   （与旧 JS 一致）。
 * - findSessionFileForAgent：失败恢复时按会话 id 定位具体 JSONL 文件——不能把会话目录
 *   本身传给 Pi（与 index.mjs 路由辅助解耦，避免循环依赖）。匹配顺序：文件名精确/
 *   前缀匹配（按 mtime 新→旧）→ 逐文件读首行 JSON 校验 id/sessionId。
 * - materializeSessionPath：只读的旧 Pi 会话复制到工作台会话目录后再打开，保留原历史
 *   文件作为只读来源。
 *
 * 可测性口径：findSessionFileForAgent/materializeSessionPath 增加可选尾参 storeDir
 * （缺省 SESSION_STORE，与旧单参签名行为一致）；对拍测试注入临时目录，避免触碰真实
 * 会话存储。
 */
import fs from "node:fs";
import path from "node:path";
import { PROJECT_DIR, isInside } from "../workspace";
import { importLocalPiSessionFile } from "./pi-config-management";

export const SESSION_STORE = path.join(PROJECT_DIR, ".规聚会话");
fs.mkdirSync(SESSION_STORE, { recursive: true });

export function findSessionFileForAgent(id: unknown, storeDir: string = SESSION_STORE): any {
  const sessionId = String(id || "").trim();
  if (!sessionId) return null;
  const roots = [storeDir];
  const candidates: any[] = [];
  const walk = (dir: string, depth: number, rootDir: string): void => {
    if (depth > 4) return;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1, rootDir);
      } else if (entry.isFile() && /\.jsonl$/i.test(entry.name)) {
        try {
          const stat = fs.statSync(fullPath);
          candidates.push({ fileName: entry.name, fullPath, storeDir: rootDir, mtime: stat.mtimeMs });
        } catch {}
      }
    }
  };
  for (const root of roots) walk(root, 0, root);

  const byName = candidates
    .filter((file) => file.fileName === `${sessionId}.jsonl` || file.fileName === `${sessionId}.json` || file.fileName.startsWith(sessionId))
    .sort((a, b) => b.mtime - a.mtime);
  if (byName[0]) return byName[0]!;

  for (const file of candidates.sort((a, b) => b.mtime - a.mtime)) {
    try {
      const firstLine = fs.readFileSync(file.fullPath, "utf8").split(/\r?\n/)[0]!;
      const header = JSON.parse(firstLine);
      if (header?.id === sessionId || header?.sessionId === sessionId) return file;
    } catch {}
  }
  return null;
}

/** 将只读的旧 Pi 会话复制到工作台会话目录后再打开，保留原历史文件作为只读来源。 */
export function materializeSessionPath(sessionPath: unknown, storeDir: string = SESSION_STORE): any {
  if (!sessionPath) return sessionPath;
  const source = path.resolve(String(sessionPath));
  if (!fs.existsSync(source)) throw new Error(`会话文件不存在：${source}`);
  let stat;
  try { stat = fs.statSync(source); } catch (error: any) { throw new Error(`无法读取会话路径：${error.message}`); }
  if (!stat.isFile()) throw new Error(`会话路径必须是 JSONL 文件，不能是目录：${source}`);
  if (isInside(storeDir, source) && source.toLowerCase().endsWith(".jsonl")) return source;
  try {
    return importLocalPiSessionFile(source, storeDir);
  } catch (error: any) {
    throw new Error(`无法将旧 Pi 会话迁移到项目内可写目录：${error.message}`);
  }
}
