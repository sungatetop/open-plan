/**
 * 集成接入通道直调器（F6-1）：op:integrations:* 12 条通道 → 进程内直调 MCP 服务
 * 与 Pi 扩展接入面（server/index.mjs L2621-2680 逐点转录；行号锚点均指
 * server/index.mjs）。
 *
 * MCP（L2622-2642）：
 *   - list（L2622）：{ servers: listMcpServers() }；
 *   - save（L2623-2626）：try → 201 { server: saveMcpServer(req.body || {}) }；
 *     catch → 400 { error: error?.message || String(error) }；
 *   - update（L2627-2633）：try → server = updateMcpServer(params.id, body)，
 *     !server → 404 { error: "MCP 服务不存在" }，否则 200 { server }；catch → 400；
 *   - delete（L2634-2638）：await deleteMcpServer(params.id)，!deleted → 404
 *     "MCP 服务不存在"，否则 { ok: true }；
 *   - test（L2639-2642）：result = await testMcpServer(params.id) →
 *     status = result.ok ? 200 : 502，result 整体透传。
 *
 * Pi 扩展（L2644-2680）：
 *   - list（L2644）：{ extensions: listPiExtensions() }；
 *   - catalog（L2645-2651）：await searchPiPackageCatalog(query.q || "", query.page || 0)
 *     整体透传；catch → 502 { error: error?.message || "查询 Pi 包目录失败" }；
 *   - from-package（L2652-2660）：resolveInstalledPiPackage(body?.name) →
 *     addPiExtension({ name, path }) → 201 { extension }；catch → 400
 *     { error: error?.message || "登记已安装 Pi 包失败" }；
 *   - add（L2661-2664）：try → 201 { extension: addPiExtension(body) }；catch → 400；
 *   - update（L2665-2671）：!extension → 404 "Pi 扩展不存在"，否则 { extension }；
 *     catch → 400；
 *   - check（L2672-2676）：!extension → 404 "Pi 扩展不存在"，否则 { extension }；
 *   - delete（L2677-2680）：!deletePiExtension(id) → 404 "Pi 扩展不存在"，否则 { ok: true }。
 *
 * 数据源：backend/mcp-management.ts（listMcpServers/saveMcpServer/updateMcpServer/
 * deleteMcpServer/testMcpServer）+ backend/agent/pi-extension-management.ts
 * （listPiExtensions/addPiExtension/updatePiExtension/checkPiExtension/
 * deletePiExtension）+ backend/pi-package-catalog.ts（searchPiPackageCatalog/
 * resolveInstalledPiPackage）。
 *
 * 门控：OP_DESKTOP_INTEGRATIONS_DIRECT 且 OP_DESKTOP_AGENT_DOMAIN 双门控（S4 语义：
 * 未设置=默认启用，=0 显式回滚）。本模块不 import electron（纯逻辑，vitest 可直接测）；
 * 注册入口在 main/index.ts。
 */
import type { InvokeEnvelope, InvokeResult } from "../../shared/protocol/channels";

/** 集成接入的跨域依赖（生产接线传 mcp/pi 管理真实模块，测试注入桩）。 */
export interface IntegrationsDirectDeps {
  /** MCP 服务清单（backend/mcp-management.ts listMcpServers） */
  listMcpServers: () => Array<Record<string, unknown>>;
  /** 保存 MCP 服务（backend/mcp-management.ts saveMcpServer，非法入参抛错） */
  saveMcpServer: (input: Record<string, unknown>) => Record<string, unknown>;
  /** 更新 MCP 服务（backend/mcp-management.ts updateMcpServer，未命中 null） */
  updateMcpServer: (id: unknown, patch: Record<string, unknown>) => Record<string, unknown> | null;
  /** 删除 MCP 服务（backend/mcp-management.ts deleteMcpServer，异步断连） */
  deleteMcpServer: (id: unknown) => Promise<boolean>;
  /** 连通性测试（backend/mcp-management.ts testMcpServer，{ ok, ... }） */
  testMcpServer: (id: unknown) => Promise<Record<string, unknown>>;
  /** Pi 扩展清单（backend/agent/pi-extension-management.ts listPiExtensions） */
  listPiExtensions: () => Array<Record<string, unknown>>;
  /** 登记 Pi 扩展（backend/agent/pi-extension-management.ts addPiExtension，非法入参抛错） */
  addPiExtension: (input: Record<string, unknown>) => Record<string, unknown>;
  /** 更新 Pi 扩展（backend/agent/pi-extension-management.ts updatePiExtension，未命中 null） */
  updatePiExtension: (id: string, patch: Record<string, unknown>) => Record<string, unknown> | null;
  /** 健康检查 Pi 扩展（backend/agent/pi-extension-management.ts checkPiExtension，未命中 null） */
  checkPiExtension: (id: string) => Record<string, unknown> | null;
  /** 删除 Pi 扩展（backend/agent/pi-extension-management.ts deletePiExtension） */
  deletePiExtension: (id: string) => boolean;
  /** 查询 Pi 包目录（backend/pi-package-catalog.ts searchPiPackageCatalog，网络失败抛错） */
  searchPiPackageCatalog: (query: string, page: unknown) => Promise<Record<string, unknown>>;
  /** 解析本机已安装 Pi 包（backend/pi-package-catalog.ts resolveInstalledPiPackage，未命中抛错） */
  resolveInstalledPiPackage: (name: unknown) => { name: string; path: string };
}

/** 集成接入直调 invoke 通道清单（与 DESKTOP_CHANNELS 对应路由一致）。 */
export const INTEGRATIONS_DIRECT_CHANNELS = [
  "op:integrations:mcp:list",
  "op:integrations:mcp:save",
  "op:integrations:mcp:update",
  "op:integrations:mcp:delete",
  "op:integrations:mcp:test",
  "op:integrations:pi:list",
  "op:integrations:pi:catalog",
  "op:integrations:pi:from-package",
  "op:integrations:pi:add",
  "op:integrations:pi:update",
  "op:integrations:pi:check",
  "op:integrations:pi:delete"
] as const;

export type IntegrationsDirectChannel = (typeof INTEGRATIONS_DIRECT_CHANNELS)[number];

const ok = (data: unknown, status = 200): InvokeResult<unknown> => ({ ok: true, status, data });
const fail = (status: number, data: unknown): InvokeResult<unknown> => ({ ok: false, status, data } as InvokeResult<unknown>);

const bodyOf = (payload: InvokeEnvelope): Record<string, any> => (payload.body ?? {}) as Record<string, any>;
const queryOf = (payload: InvokeEnvelope): Record<string, string | undefined> => (payload.query ?? {}) as Record<string, string | undefined>;
const paramsOf = (payload: InvokeEnvelope): Record<string, string> => (payload.params ?? {}) as Record<string, string>;

/** error?.message || fallback 的统一转录（server 侧 catch 惯例）。 */
const errMessage = (error: unknown, fallback?: string): string => {
  const message = (error as { message?: unknown })?.message;
  if (message) return String(message);
  return fallback ?? String(error);
};

// ---------- MCP ----------

/** GET /api/integrations/mcp/servers（L2622 逐点转录）。 */
function invokeMcpList(deps: IntegrationsDirectDeps): InvokeResult<unknown> {
  return ok({ servers: deps.listMcpServers() });
}

/** POST /api/integrations/mcp/servers（L2623-2626 逐点转录：try 201 / catch 400）。 */
function invokeMcpSave(payload: InvokeEnvelope, deps: IntegrationsDirectDeps): InvokeResult<unknown> {
  try {
    return ok({ server: deps.saveMcpServer(bodyOf(payload)) }, 201);
  } catch (error) {
    return fail(400, { error: errMessage(error) });
  }
}

/** PATCH /api/integrations/mcp/servers/:id（L2627-2633 逐点转录：!server 404 / catch 400）。 */
function invokeMcpUpdate(payload: InvokeEnvelope, deps: IntegrationsDirectDeps): InvokeResult<unknown> {
  try {
    const server = deps.updateMcpServer(paramsOf(payload).id, bodyOf(payload));
    if (!server) return fail(404, { error: "MCP 服务不存在" });
    return ok({ server });
  } catch (error) {
    return fail(400, { error: errMessage(error) });
  }
}

/** DELETE /api/integrations/mcp/servers/:id（L2634-2638 逐点转录：!deleted 404 / ok:true）。 */
async function invokeMcpDelete(payload: InvokeEnvelope, deps: IntegrationsDirectDeps): Promise<InvokeResult<unknown>> {
  const deleted = await deps.deleteMcpServer(paramsOf(payload).id);
  if (!deleted) return fail(404, { error: "MCP 服务不存在" });
  return ok({ ok: true });
}

/** POST /api/integrations/mcp/servers/:id/test（L2639-2642 逐点转录：result 整体透传，ok?200:502）。 */
async function invokeMcpTest(payload: InvokeEnvelope, deps: IntegrationsDirectDeps): Promise<InvokeResult<unknown>> {
  const result = await deps.testMcpServer(paramsOf(payload).id);
  return result.ok ? ok(result) : fail(502, result);
}

// ---------- Pi 扩展 ----------

/** GET /api/integrations/pi/extensions（L2644 逐点转录）。 */
function invokePiList(deps: IntegrationsDirectDeps): InvokeResult<unknown> {
  return ok({ extensions: deps.listPiExtensions() });
}

/** GET /api/integrations/pi/catalog（L2645-2651 逐点转录：整体透传 / catch 502）。 */
async function invokePiCatalog(payload: InvokeEnvelope, deps: IntegrationsDirectDeps): Promise<InvokeResult<unknown>> {
  const query = queryOf(payload);
  try {
    return ok(await deps.searchPiPackageCatalog(query.q || "", query.page || 0));
  } catch (error) {
    return fail(502, { error: errMessage(error, "查询 Pi 包目录失败") });
  }
}

/** POST /api/integrations/pi/extensions/from-package（L2652-2660 逐点转录：
 * resolveInstalled → addPiExtension({name,path}) → 201 / catch 400）。 */
function invokePiFromPackage(payload: InvokeEnvelope, deps: IntegrationsDirectDeps): InvokeResult<unknown> {
  try {
    const installed = deps.resolveInstalledPiPackage((bodyOf(payload) as { name?: unknown } | undefined)?.name);
    const extension = deps.addPiExtension({ name: installed.name, path: installed.path });
    return ok({ extension }, 201);
  } catch (error) {
    return fail(400, { error: errMessage(error, "登记已安装 Pi 包失败") });
  }
}

/** POST /api/integrations/pi/extensions（L2661-2664 逐点转录：try 201 / catch 400）。 */
function invokePiAdd(payload: InvokeEnvelope, deps: IntegrationsDirectDeps): InvokeResult<unknown> {
  try {
    return ok({ extension: deps.addPiExtension(bodyOf(payload)) }, 201);
  } catch (error) {
    return fail(400, { error: errMessage(error) });
  }
}

/** PATCH /api/integrations/pi/extensions/:id（L2665-2671 逐点转录：!extension 404 / catch 400）。 */
function invokePiUpdate(payload: InvokeEnvelope, deps: IntegrationsDirectDeps): InvokeResult<unknown> {
  try {
    const extension = deps.updatePiExtension(paramsOf(payload).id ?? "", bodyOf(payload));
    if (!extension) return fail(404, { error: "Pi 扩展不存在" });
    return ok({ extension });
  } catch (error) {
    return fail(400, { error: errMessage(error) });
  }
}

/** POST /api/integrations/pi/extensions/:id/check（L2672-2676 逐点转录：!extension 404）。 */
function invokePiCheck(payload: InvokeEnvelope, deps: IntegrationsDirectDeps): InvokeResult<unknown> {
  const extension = deps.checkPiExtension(paramsOf(payload).id ?? "");
  if (!extension) return fail(404, { error: "Pi 扩展不存在" });
  return ok({ extension });
}

/** DELETE /api/integrations/pi/extensions/:id（L2677-2680 逐点转录：!deleted 404 / ok:true）。 */
function invokePiDelete(payload: InvokeEnvelope, deps: IntegrationsDirectDeps): InvokeResult<unknown> {
  if (!deps.deletePiExtension(paramsOf(payload).id ?? "")) return fail(404, { error: "Pi 扩展不存在" });
  return ok({ ok: true });
}

/**
 * 集成接入直调分发入口：ipcMain.handle 注册侧调用（main/index.ts
 * registerIntegrationsDirectInvokers）。全部路由均有 try/catch 或纯域调用，
 * 异常面与 server 一致。
 */
export async function invokeIntegrationsDirect(
  channel: string,
  payload: InvokeEnvelope | undefined,
  deps: IntegrationsDirectDeps
): Promise<InvokeResult<unknown>> {
  const envelope: InvokeEnvelope = payload ?? {};
  switch (channel as IntegrationsDirectChannel) {
    case "op:integrations:mcp:list":
      return invokeMcpList(deps);
    case "op:integrations:mcp:save":
      return invokeMcpSave(envelope, deps);
    case "op:integrations:mcp:update":
      return invokeMcpUpdate(envelope, deps);
    case "op:integrations:mcp:delete":
      return invokeMcpDelete(envelope, deps);
    case "op:integrations:mcp:test":
      return invokeMcpTest(envelope, deps);
    case "op:integrations:pi:list":
      return invokePiList(deps);
    case "op:integrations:pi:catalog":
      return invokePiCatalog(envelope, deps);
    case "op:integrations:pi:from-package":
      return invokePiFromPackage(envelope, deps);
    case "op:integrations:pi:add":
      return invokePiAdd(envelope, deps);
    case "op:integrations:pi:update":
      return invokePiUpdate(envelope, deps);
    case "op:integrations:pi:check":
      return invokePiCheck(envelope, deps);
    case "op:integrations:pi:delete":
      return invokePiDelete(envelope, deps);
    default:
      return fail(404, { error: `unknown channel: ${channel}` });
  }
}
