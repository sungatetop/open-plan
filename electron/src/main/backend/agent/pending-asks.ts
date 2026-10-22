/**
 * ask_user 待答持久化（B6-6-2，自 server/agent.mjs L812-840 逐行转录）。
 *
 * 服务重启后恢复排队中的提问与已入队的回答；落盘走 atomicWriteJson（B2），
 * 条目截尾保留最近 100 条。JSON 形状动态，入参保持宽容类型。
 */
import fs from "node:fs";
import path from "node:path";
import { PROJECT_DIR } from "../workspace";
import { atomicWriteJson } from "../persistence-utils";

export const PENDING_ASKS_FILE = path.join(PROJECT_DIR, ".oaw", "pending-asks.json");

export function readPendingAsks(): any[] {
  try { return JSON.parse(fs.readFileSync(PENDING_ASKS_FILE, "utf8")); } catch { return []; }
}

export function savePendingAsks(items: any[]): void {
  fs.mkdirSync(path.dirname(PENDING_ASKS_FILE), { recursive: true });
  atomicWriteJson(PENDING_ASKS_FILE, items.slice(-100));
}

export function persistPendingAsk(item: any): void {
  const items = readPendingAsks().filter((x: any) => x.clientId !== item.clientId || x.status !== "pending");
  items.push(item);
  savePendingAsks(items);
}

export function resolvePendingAsk(clientId: unknown, answer: unknown, status = "answered"): any {
  const items = readPendingAsks();
  const item = [...items].reverse().find((x: any) => x.clientId === clientId && x.status === "pending");
  if (item) { item.status = status; item.answer = answer || null; item.resolvedAt = new Date().toISOString(); savePendingAsks(items); }
  return item;
}

export function consumeRecoveredAnswers(clientId: unknown): any[] {
  const items = readPendingAsks();
  const recovered = items.filter((x: any) => x.clientId === clientId && x.status === "queued" && x.answer);
  if (!recovered.length) return [];
  for (const item of recovered) { item.status = "consumed"; item.consumedAt = new Date().toISOString(); }
  savePendingAsks(items);
  return recovered;
}

// ask_user 阻塞等待用户回答的时间窗口（B6-6-4f，自 agent.mjs L437-439 转录）：
// 到期后按专业判断继续。前端凭事件里的 expiresAt 把卡片置为"已超时"，
// 避免留下点得动、一发就报 no pending question 的死卡片。
// ask_user 工具定义（_create 工厂，4g 批）以它计算 expiresAt 与超时提示文案。
export const ASK_TIMEOUT_MS = 300_000;
