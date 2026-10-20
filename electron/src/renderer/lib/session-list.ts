/**
 * SessionList/SessionSidebar 共用纯函数族（F3 批5b：自 client/src/components/SessionSidebar.jsx
 * 拆出，与原实现逐行等价，对拍强制 tests/f3-batch5b1-parity.test.tsx）。
 */

// 运行中的状态集合：这些会话的名字用跑马灯 + 灯效展示，一眼看出"还在跑"
export const RUNNING_SESSION_STATUSES = new Set(["running", "queued", "waiting_user", "recovering", "cancel_requested"]);

// 工作区身份比较：服务端返回 realpath，客户端保存的也是 realpath，但 Windows 的
// 大小写与分隔符差异会让严格比较误报"来源不一致"。统一归一化后再比。
export function sameWorkspacePath(a: unknown, b: unknown): boolean {
  if (!a || !b) return false;
  const normalize = (value: unknown) => String(value).replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase();
  return normalize(a) === normalize(b);
}

export function samePath(a: unknown, b: unknown): boolean {
  if (!a || !b) return false;
  const normalize = (value: unknown) => String(value).replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase();
  return normalize(a) === normalize(b);
}

export const PIN_KEY = "oaw_pinned_sessions";

export function getPinnedSet(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(PIN_KEY) || "[]")); } catch { return new Set(); }
}

export function togglePin(id: string): Set<string> {
  const s = getPinnedSet();
  if (s.has(id)) s.delete(id); else s.add(id);
  localStorage.setItem(PIN_KEY, JSON.stringify([...s]));
  return s;
}

export function formatTime(iso: unknown): string {
  if (!iso) return "";
  const d = new Date(iso as string);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins}分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  return `${days}天前`;
}

// 产物面板：接收毫秒时间戳
export function formatRelTime(ms: unknown): string {
  if (!ms) return "";
  return formatTime(new Date(ms as number).toISOString());
}

export function shortenCwd(cwd: unknown): string {
  if (!cwd) return "";
  const parts = String(cwd).replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length <= 2) return cwd as string;
  return "\u2026/" + parts.slice(-2).join("/");
}

// 文件大小格式化（文件树展示）
export function formatSize(bytes: number | undefined | null): string {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

// 日期分组（Proma groupByDate）
export function groupByDate<T extends { modified?: string }>(sessions: T[]): Array<[string, T[]]> {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = today - 86400000;
  const groups = { 今天: [] as T[], 昨天: [] as T[], 更早: [] as T[] };
  for (const s of sessions) {
    const t = new Date(s.modified || 0).getTime();
    if (t >= today) groups["今天"].push(s);
    else if (t >= yesterday) groups["昨天"].push(s);
    else groups["更早"].push(s);
  }
  return Object.entries(groups).filter(([, arr]) => arr.length > 0);
}
