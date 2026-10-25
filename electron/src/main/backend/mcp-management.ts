/**
 * B2-14：MCP 服务管理域（集成中心后端）——逐行等价迁移自 server/mcp-management.mjs。
 *
 * 8 导出：listMcpServers/saveMcpServer/updateMcpServer/deleteMcpServer/testMcpServer/
 * cachedMcpTools/callMcpTool/closeMcpConnections；私有族 readConfig/saveConfig/cleanEnv/
 * cleanHeaders/cleanTool/publicServer/makeId/validateServer/closeConnection/redactServerError/
 * createTransport/connectServer + connections 模块级连接表 + CONFIG_FILE 模块加载期锚点。
 *
 * 与旧模块的差异（均为等价收口，行为不变）：
 *   - APP_DATA_DIR：旧侧来自 server/pi-config-management.mjs（OAW_DATA_DIR 显式覆盖 ||
 *     平台应用数据目录/规聚）；TS 侧暂无该模块，内联同形锚定（后续该域迁移后可改共享直绑）。
 *   - MCP SDK（@modelcontextprotocol/client）：electron/package.json 未声明该依赖（经
 *     open-plan file: 依赖树提升存在于 node_modules），经 loadSdk 变量间接动态 import
 *     （非字面量动态 import 不进 rollup 静态分析，运行时 node 向上解析）；createTransport
 *     因 await loadSdk 改 async（唯一调用点 connectServer 内 await，行为等价）。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWriteJson, ensureDirectory, readJsonFile } from "./persistence-utils";
import { RUNTIME_FLAGS } from "../../shared/runtime/feature-flags";

/** APP_DATA_DIR：与 server/pi-config-management.mjs L9-16 同形（模块加载期锚定）。 */
const APP_DATA_DIR = path.resolve(
  String(process.env.OAW_DATA_DIR || "").trim()
  || path.join(
    process.platform === "win32"
      ? (process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"))
      : (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")),
    "规聚",
  ),
);

const CONFIG_FILE = path.join(APP_DATA_DIR, "集成", "mcp-servers.json");
const connections = new Map<any, any>();
const MAX_TOOLS_PER_SERVER = 100;
const MAX_TOOL_SCHEMA_BYTES = 128 * 1024;

/**
 * GIS G3（OAW_AMAP_MCP_BRIDGE，默认关）：官方协议要求凭据放在 URL query 的已知厂商白名单。
 * 高德 MCP Server 的接入契约是 https://mcp.amap.com/mcp?key=...（官方文档口径），
 * 通用规则（凭据一律走请求头）对其不适用；这里只对白名单主机放行 key 型 query 参数。
 */
const KNOWN_QUERY_KEY_HOSTS = new Set(["mcp.amap.com"]);

/**
 * MCP SDK 惰性加载（变量间接动态 import，模块加载期零副作用）；
 * createTransport/connectServer 内 await 使用。
 */
let sdkCache: any = null;
async function loadSdk(): Promise<any> {
  if (!sdkCache) {
    const clientSpec = "@modelcontextprotocol/client";
    const stdioSpec = "@modelcontextprotocol/client/stdio";
    const client = await import(clientSpec);
    const stdio = await import(stdioSpec);
    sdkCache = {
      Client: client.Client,
      StreamableHTTPClientTransport: client.StreamableHTTPClientTransport,
      StdioClientTransport: stdio.StdioClientTransport,
      getDefaultEnvironment: stdio.getDefaultEnvironment,
    };
  }
  return sdkCache;
}

function readConfig(): { version: number; servers: any[] } {
  const value = readJsonFile(CONFIG_FILE, { version: 1, servers: [] });
  return { version: 1, servers: Array.isArray(value?.servers) ? value.servers : [] };
}

function saveConfig(config: any): void {
  ensureDirectory(path.dirname(CONFIG_FILE));
  atomicWriteJson(CONFIG_FILE, { ...config, updatedAt: new Date().toISOString() });
}

function cleanEnv(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(value && typeof value === "object" ? (value as Record<string, unknown>) : {})
    .filter(([key, item]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof item === "string")
    .slice(0, 100)) as Record<string, string>;
}

function cleanHeaders(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(value && typeof value === "object" ? (value as Record<string, unknown>) : {})
    .filter(([key, item]) => /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) && typeof item === "string")
    .slice(0, 100)) as Record<string, string>;
}

function cleanTool(tool: any) {
  const schema = tool?.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object", properties: {} };
  let schemaText = "";
  try { schemaText = JSON.stringify(schema); } catch {}
  return {
    name: String(tool?.name || "").slice(0, 200),
    description: String(tool?.description || "").slice(0, 4000),
    inputSchema: schemaText.length <= MAX_TOOL_SCHEMA_BYTES ? schema : { type: "object", properties: {}, additionalProperties: true },
    annotations: {
      readOnlyHint: tool?.annotations?.readOnlyHint === true,
      destructiveHint: tool?.annotations?.destructiveHint === true,
      idempotentHint: tool?.annotations?.idempotentHint === true,
    },
  };
}

function publicServer(server: any) {
  return {
    id: server.id,
    name: server.name,
    transport: server.transport,
    command: server.transport === "stdio" ? server.command : undefined,
    argsCount: server.transport === "stdio" ? (server.args || []).length : undefined,
    endpoint: server.transport === "http" ? server.endpoint : undefined,
    cwd: server.transport === "stdio" ? server.cwd || "" : undefined,
    enabled: Boolean(server.enabled),
    envKeys: Object.keys(server.env || {}),
    headerNames: Object.keys(server.headers || {}),
    hasSecrets: Object.keys(server.env || {}).length > 0 || Object.keys(server.headers || {}).length > 0,
    tools: Array.isArray(server.tools) ? server.tools.map(cleanTool) : [],
    lastTest: server.lastTest || null,
  };
}

function makeId(name: unknown): string {
  const slug = String(name || "server").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "server";
  return `${slug}-${crypto.randomBytes(3).toString("hex")}`;
}

function validateServer(input: any = {}, previous: any = null): any {
  const name = String(input.name ?? previous?.name ?? "").trim().slice(0, 80);
  const transport = String(input.transport ?? previous?.transport ?? "stdio");
  if (!name) throw new Error("请填写 MCP 服务名称");
  if (!new Set(["stdio", "http"]).has(transport)) throw new Error("MCP 传输类型只支持 stdio 或 Streamable HTTP");
  const result: any = {
    id: previous?.id || String(input.id || makeId(name)).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48),
    name,
    transport,
    enabled: input.enabled === undefined ? Boolean(previous?.enabled) : Boolean(input.enabled),
    tools: Array.isArray(previous?.tools) ? previous.tools : [],
    lastTest: previous?.lastTest || null,
  };
  if (transport === "stdio") {
    const command = String(input.command ?? previous?.command ?? "").trim().slice(0, 1000);
    if (!command) throw new Error("stdio 类型必须填写启动命令");
    result.command = command;
    result.args = (Array.isArray(input.args) ? input.args : previous?.args || []).map((arg: any) => String(arg).slice(0, 2000)).slice(0, 100);
    result.cwd = String(input.cwd ?? previous?.cwd ?? "").trim().slice(0, 2000);
    result.env = { ...(previous?.env || {}), ...cleanEnv(input.env) };
  } else {
    const endpoint = String(input.endpoint ?? previous?.endpoint ?? "").trim().slice(0, 4000);
    let url: URL;
    try { url = new URL(endpoint); } catch { throw new Error("请填写有效的 MCP 服务 URL"); }
    if (!new Set(["https:", "http:"]).has(url.protocol)) throw new Error("MCP URL 只支持 HTTP 或 HTTPS");
    // GIS G3：白名单厂商（mcp.amap.com）+ flag 开启时允许官方协议要求的 ?key= 参数；
    // 其余端点维持"凭据不进 URL"的既有规则（userinfo 基本凭据任何情况都拒绝）。
    if (url.username || url.password) throw new Error("请不要把凭据写在 URL 中，改用 HTTP 请求头配置；凭据才可保持隐藏。");
    const credentialInQuery = [...url.searchParams.keys()].some((key) => /token|secret|key|auth|credential/i.test(key));
    const knownVendorQueryKey = KNOWN_QUERY_KEY_HOSTS.has(url.hostname.toLowerCase());
    if (credentialInQuery && !(RUNTIME_FLAGS.amapMcpBridge && knownVendorQueryKey)) {
      throw new Error("请不要把凭据写在 URL 中，改用 HTTP 请求头配置；凭据才可保持隐藏。");
    }
    url.hash = "";
    result.endpoint = url.toString();
    result.headers = { ...(previous?.headers || {}), ...cleanHeaders(input.headers) };
  }
  return result;
}

async function closeConnection(id: unknown): Promise<void> {
  const connection = connections.get(id);
  if (!connection) return;
  connections.delete(id);
  try { await connection.client.close(); } catch {}
}

function redactServerError(server: any, value: unknown): string {
  let message = String((value as any)?.message || value || "MCP 连接失败").slice(0, 500);
  for (const secret of [...Object.values(server.env || {}), ...Object.values(server.headers || {})].filter((item: any) => item && String(item).length >= 4)) {
    message = message.replaceAll(String(secret), "[已隐藏]");
  }
  return message;
}

async function createTransport(server: any): Promise<any> {
  const sdk = await loadSdk();
  if (server.transport === "stdio") {
    const env = { ...sdk.getDefaultEnvironment(), ...(server.env || {}) };
    return new sdk.StdioClientTransport({ command: server.command, args: server.args || [], env, cwd: server.cwd || undefined, stderr: "pipe" });
  }
  return new sdk.StreamableHTTPClientTransport(new URL(server.endpoint), {
    requestInit: { headers: server.headers || {} },
    reconnectionOptions: { maxReconnectionDelay: 4000, initialReconnectionDelay: 400, reconnectionDelayGrowFactor: 1.5, maxRetries: 1 },
  });
}

async function connectServer(server: any, timeoutMs = 8000): Promise<any> {
  const cached = connections.get(server.id);
  if (cached) return cached;
  const sdk = await loadSdk();
  const client = new sdk.Client({ name: "open-plan", version: "0.11.11" });
  const transport = await createTransport(server);
  const connection = { client, transport, tools: [], serverId: server.id };
  let timeoutTimer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      client.connect(transport),
      new Promise((_, reject) => { timeoutTimer = setTimeout(() => reject(new Error(`连接超时（${timeoutMs} ms）`)), timeoutMs); }),
    ]);
    connections.set(server.id, connection);
    return connection;
  } catch (error) {
    try { await client.close(); } catch {}
    throw error;
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
  }
}

export function listMcpServers(): any[] {
  return readConfig().servers.map(publicServer);
}

export function saveMcpServer(input: any = {}): any {
  const config = readConfig();
  const id = String(input.id || "");
  const index = id ? config.servers.findIndex((item: any) => item.id === id) : -1;
  const previous = index >= 0 ? config.servers[index] : null;
  const server = validateServer(input, previous);
  if (index >= 0) config.servers[index] = server;
  else config.servers.push(server);
  saveConfig(config);
  if (previous && JSON.stringify(previous) !== JSON.stringify(server)) void closeConnection(server.id);
  return publicServer(server);
}

export function updateMcpServer(id: unknown, patch: any = {}): any {
  const config = readConfig();
  const index = config.servers.findIndex((item: any) => item.id === id);
  if (index < 0) return null;
  const server = validateServer({ ...patch, id }, config.servers[index]);
  config.servers[index] = server;
  saveConfig(config);
  void closeConnection(id);
  return publicServer(server);
}

export async function deleteMcpServer(id: unknown): Promise<boolean> {
  const config = readConfig();
  const next = config.servers.filter((item: any) => item.id !== id);
  if (next.length === config.servers.length) return false;
  config.servers = next;
  saveConfig(config);
  await closeConnection(id);
  return true;
}

export async function testMcpServer(id: unknown): Promise<any> {
  const config = readConfig();
  const server = config.servers.find((item: any) => item.id === id);
  if (!server) return { ok: false, error: "MCP 服务不存在" };
  let connection: any;
  try {
    connection = await connectServer(server, 12000);
    const { tools = [] } = await connection.client.listTools();
    connection.tools = tools.slice(0, MAX_TOOLS_PER_SERVER).map(cleanTool).filter((tool: any) => tool.name);
    const current = readConfig();
    const saved = current.servers.find((item: any) => item.id === id);
    if (saved) {
      saved.tools = connection.tools;
      saved.lastTest = { ok: true, at: new Date().toISOString(), serverInfo: connection.client.getServerVersion()?.name || null };
      saveConfig(current);
    }
    return { ok: true, server: publicServer(saved || server), serverInfo: connection.client.getServerVersion() || null };
  } catch (error) {
    const current = readConfig();
    const saved = current.servers.find((item: any) => item.id === id);
    const safeError = redactServerError(server, error);
    if (saved) { saved.lastTest = { ok: false, at: new Date().toISOString(), error: safeError }; saveConfig(current); }
    await closeConnection(id);
    return { ok: false, error: safeError };
  }
}

export function cachedMcpTools(): any[] {
  return readConfig().servers.filter((server: any) => server.enabled)
    .flatMap((server: any) => (server.tools || []).slice(0, MAX_TOOLS_PER_SERVER).map((tool: any) => ({ server: publicServer(server), tool: cleanTool(tool) })));
}

export async function callMcpTool(serverId: unknown, name: unknown, args: any, options: any = {}): Promise<any> {
  const server = readConfig().servers.find((item: any) => item.id === serverId && item.enabled);
  if (!server) throw new Error("MCP 服务已停用或不存在，请启用后新建会话");
  const connection = await connectServer(server, 12000);
  try {
    return await connection.client.callTool({ name, arguments: args || {} }, { signal: options.signal, timeout: 120000 });
  } catch (error) {
    if (/closed|transport|connection|timeout/i.test(String((error as any)?.message || error))) await closeConnection(serverId);
    throw error;
  }
}

export async function closeMcpConnections(): Promise<void> {
  await Promise.all([...connections.keys()].map((id) => closeConnection(id)));
}

process.once("beforeExit", () => { void closeMcpConnections(); });
