/**
 * 服务集成连接器目录（连接器状态 + 授权意图，不含密钥持久化）。
 *
 * 逐行等价迁移自 server/connectors.mjs（S3-12，绞杀者分域 S3 批次，零依赖六域批）。
 *
 * 路径锚定：旧侧 PROJECT_DIR=__dirname 上一级（项目根），状态文件固定
 * <项目根>/.oaw/connectors.json——TS 侧 PROJECT_DIR 直绑 workspace-paths
 * （仓库根锚点，S3-11 models-dev-catalog 先例），路径拼接与旧侧数学等价。
 * 当前消费面：旧 index.mjs L28 静态 import（四函数），随流量切换批退役。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PROJECT_DIR } from "./workspace-paths";

const STATE_FILE = path.join(PROJECT_DIR, ".oaw", "connectors.json");

const DEFINITIONS = [
  { id: "local", name: "本地工作区", kind: "filesystem", status: "ready", capabilities: ["read", "write", "watch"] },
  { id: "google-drive", name: "Google Drive", kind: "oauth", status: "authorization_required", capabilities: ["read", "download", "upload"] },
  { id: "sharepoint", name: "SharePoint", kind: "oauth", status: "authorization_required", capabilities: ["read", "download", "upload"] },
  { id: "feishu-drive", name: "飞书云盘", kind: "oauth", status: "authorization_required", capabilities: ["read", "download", "upload"] },
];

function readState(): any {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}

function writeState(state: any): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n", "utf8");
}

export function listConnectors(): any[] {
  const state = readState();
  return DEFINITIONS.map((definition) => ({
    ...definition,
    ...(state[definition.id] || {}),
    configured: !!state[definition.id]?.configured || definition.id === "local",
    authRequired: definition.kind === "oauth" && !state[definition.id]?.configured,
  }));
}

export function getConnector(id: any): any {
  return listConnectors().find((item) => item.id === id) || null;
}

/**
 * Create a provider-neutral authorization intent. The actual OAuth exchange is
 * intentionally delegated to the installed provider connector; secrets are
 * never persisted by this project.
 */
export function beginConnectorAuth(id: any, redirectUri = ""): any {
  const connector = getConnector(id);
  if (!connector) return { ok: false, error: "connector not found" };
  if (connector.kind !== "oauth") return { ok: true, connector, status: "ready" };
  return {
    ok: true,
    connector,
    status: "authorization_required",
    state: crypto.randomUUID(),
    redirectUri: String(redirectUri || ""),
    message: "请通过对应插件完成 OAuth 授权；本地服务不会保存第三方密钥。",
  };
}

export function setConnectorStatus(id: any, patch: any = {}): any {
  const connector = getConnector(id);
  if (!connector) return { ok: false, error: "connector not found" };
  const state = readState();
  state[id] = { configured: !!patch.configured, accountLabel: patch.accountLabel || "", updatedAt: new Date().toISOString() };
  writeState(state);
  return { ok: true, connector: getConnector(id) };
}
