/**
 * 记忆文件存储域（C-6，自 server/index.mjs L4979-5056 内联记忆助手逐行转录）。
 *
 * 覆盖面（行号锚点均指 server/index.mjs）：
 *   - memoryEmitter / memoryWatcher（L4980-4982）：记忆目录变更事件源（SSE
 *     /api/memory/stream 的 push 源；桌面端事件推送线由 memory-events-bridge 消费，
 *     本模块只负责发射）；EMFILE 时关闭 watcher 置空自愈；
 *   - getMemoryDir / getAgentsMd / ensureMemoryDir（L4984-4991）：工作区派生路径；
 *   - listMemoryFiles（L4993-5024）：AGENTS.md 置顶 + memory 目录递归扫描
 *     （md/txt 且不以 . 开头）+ MEMORY.md 次置顶 + 其余按文件名 localeCompare；
 *   - resolveMemoryPath（L5026-5033）：rel 归一（反斜杠→斜杠、拒绝绝对路径与
 *     ".." 段）；AGENTS.md 直达；其余必须落在 memory 目录内（resolve 后前缀校验）；
 *   - startMemoryWatcher（L5035-5056）：fs.watch 目录级监听（recursive:false），
 *     变更读前 2000 字节作为 preview 发射 change 事件。
 *
 * 与旧实现的差异（可测性扩展，B2-2 runs 先例）：无——getMemoryDir 每次调用时从
 * getWorkspace() 派生（工作区切换即时生效），与旧实现一致；函数体逐行转录，无行为差异。
 * 路由编排消费面见 ipc/agent-memory-direct.ts（C-6）。
 *
 * 本模块不 import electron（纯逻辑，vitest 可直接测）。
 */
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { getWorkspace } from "../workspace";

// ---------- memory 系统（server L4979-4991）----------
export const memoryEmitter = new EventEmitter();
let memoryWatcher: fs.FSWatcher | null = null;

export function getMemoryDir(): string {
  return path.join(getWorkspace(), "memory");
}

export function getAgentsMd(): string {
  return path.join(getWorkspace(), "AGENTS.md");
}

export function ensureMemoryDir(): string {
  const dir = getMemoryDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------- 记忆文件清单（server L4993-5024 逐行转录）----------
export function listMemoryFiles(): Array<{ name: string; rel: string; size: number; mtime: number; type: string }> {
  const dir = getMemoryDir();
  const agentsMd = getAgentsMd();
  const files: Array<{ name: string; rel: string; size: number; mtime: number; type: string }> = [];
  if (fs.existsSync(agentsMd)) {
    const st = fs.statSync(agentsMd);
    files.push({ name: "AGENTS.md", rel: "AGENTS.md", size: st.size, mtime: st.mtimeMs, type: "agents" });
  }
  if (fs.existsSync(dir)) {
    const walk = (d: string, prefix = ""): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isFile() && /\.(md|txt)$/i.test(e.name) && !e.name.startsWith(".")) {
          const fp = path.join(d, e.name);
          const st = fs.statSync(fp);
          files.push({ name: e.name, rel, size: st.size, mtime: st.mtimeMs, type: "memory" });
        } else if (e.isDirectory() && !e.name.startsWith(".")) {
          walk(path.join(d, e.name), rel);
        }
      }
    };
    walk(dir);
  }
  return files.sort((a, b) => {
    if (a.rel === "AGENTS.md") return -1;
    if (b.rel === "AGENTS.md") return 1;
    if (a.rel === "MEMORY.md") return -1;
    if (b.rel === "MEMORY.md") return 1;
    return a.name.localeCompare(b.name);
  });
}

// ---------- rel 路径安全解析（server L5026-5033 逐行转录）----------
export function resolveMemoryPath(rel: unknown): string | null {
  const raw = String(rel || "").replace(/\\/g, "/").trim();
  if (!raw || path.isAbsolute(raw) || raw.split("/").includes("..")) return null;
  if (raw === "AGENTS.md") return getAgentsMd();
  const base = path.resolve(getMemoryDir());
  const target = path.resolve(base, raw);
  return target === base || !target.startsWith(base + path.sep) ? null : target;
}

// ---------- 目录监听（server L5035-5056 逐行转录）----------
export function startMemoryWatcher(): void {
  if (memoryWatcher) return;
  const dir = getMemoryDir();
  if (!fs.existsSync(dir)) return;
  try {
    memoryWatcher = fs.watch(dir, { recursive: false }, (eventType: string, filename: string | null) => {
      if (!filename) return;
      const filePath = path.join(dir, filename);
      let content: string | null = null;
      try { content = fs.readFileSync(filePath, "utf8").slice(0, 2000); } catch {}
      memoryEmitter.emit("change", { file: filename, event: eventType, preview: content, time: Date.now() });
    });
    memoryWatcher.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EMFILE") {
        try { memoryWatcher?.close(); } catch {}
        memoryWatcher = null;
      }
    });
  } catch {
    memoryWatcher = null;
  }
}
