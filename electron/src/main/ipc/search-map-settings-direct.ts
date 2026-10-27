/**
 * 联网搜索配置与地图底图设置通道直调器（D-1c，非 agent 域收编第三批，D-1 收尾）：
 * op:search:* + op:map:settings:* → 进程内直调 web-search / map 域。
 *
 * 旧路径：渲染层 invoke → http-forward 转发 sidecar HTTP。本模块把 5 条通道的
 * sidecar 路由编排逐点转录为主进程内直调（行号锚点均指 server/index.mjs）：
 *   - op:search:settings:get（L2056-2062）：{ ok:true, backends, settings }；
 *   - op:search:settings:save（L2064-2071）：saveSearchSettings(body) → { ok:true, settings }；
 *   - op:search:test（L2073-2081）：testSearchBackend(backend, { draft }) result 整体透传
 *     （draft 只用于本次测试不持久化）；catch 500 { ok:false, category:"unknown", message }；
 *   - op:map:settings:get（L5404-5414）：basemaps 四 Key 只回传布尔（不泄露 Key 原文）；
 *   - op:map:settings:save（L5417-5435）：saveMapSettings → listProjects → 循环
 *     rebuildBasemapStyle 重建全部项目 style.json 底图部分 → { ok:true, basemaps 投影, projects }。
 *
 * 语义差异（注释声明）：GET /api/map/settings 在 sidecar 无 try/catch（异常走 express
 * 默认错误页）；直调形态异常统一落 500 { error } JSON 信封——对调用方等价于"请求失败"。
 * save 侧 catch 500 { error }（无 ok:false）忠实转录。
 *
 * 数据源：backend/web-search.ts（SEARCH_BACKENDS/publicSearchSettings/saveSearchSettings/
 * testSearchBackend，B2-15 对拍覆盖）+ backend/map.ts（loadMapSettings/saveMapSettings/
 * listProjects/rebuildBasemapStyle，S3 域对拍覆盖）。
 *
 * 门控：OP_DESKTOP_SEARCH_MAP_SETTINGS_DIRECT 且 OP_DESKTOP_AGENT_DOMAIN 双门控
 * （S4 语义：未设置=默认启用，=0 显式回滚——流量切换评估方案 §4-S4）。
 * 本模块不 import electron（纯逻辑，vitest 可直接测）；注册入口在 main/index.ts。
 */
import type { InvokeEnvelope, InvokeResult } from "../../shared/protocol/channels";

/** 搜索与地图设置编排的跨域依赖（生产接线传 backend 真实模块，测试注入桩）。 */
export interface SearchMapSettingsDirectDeps {
  /** 搜索后端元数据清单（backend/web-search.ts SEARCH_BACKENDS） */
  searchBackends: readonly unknown[];
  /** 脱敏后的搜索设置投影（backend/web-search.ts publicSearchSettings） */
  publicSearchSettings: () => Record<string, unknown>;
  /** 保存搜索设置（backend/web-search.ts saveSearchSettings，非法输入抛错） */
  saveSearchSettings: (input: Record<string, any>) => Record<string, unknown>;
  /** 测试搜索后端连通（backend/web-search.ts testSearchBackend） */
  testSearchBackend: (backend: string, options?: { draft?: Record<string, any> }) => Promise<Record<string, unknown>>;
  /** 读取地图设置（backend/map.ts loadMapSettings） */
  loadMapSettings: () => { basemaps?: Record<string, unknown> | null };
  /** 保存底图 Key（backend/map.ts saveMapSettings，非法输入抛错） */
  saveMapSettings: (basemaps: Record<string, any>) => { basemaps?: Record<string, unknown> | null };
  /** 地图项目清单（backend/map.ts listProjects，元素含 project 名） */
  listProjects: () => Array<{ project: unknown }>;
  /** 重建项目 style.json 底图部分（backend/map.ts rebuildBasemapStyle） */
  rebuildBasemapStyle: (name: unknown) => unknown;
}

/** 搜索与地图设置直调 invoke 通道清单（与 DESKTOP_CHANNELS 对应路由一致）。 */
export const SEARCH_MAP_SETTINGS_DIRECT_CHANNELS = [
  "op:search:settings:get",
  "op:search:settings:save",
  "op:search:test",
  "op:map:settings:get",
  "op:map:settings:save"
] as const;

export type SearchMapSettingsDirectChannel = (typeof SEARCH_MAP_SETTINGS_DIRECT_CHANNELS)[number];

const ok = (data: unknown): InvokeResult<unknown> => ({ ok: true, status: 200, data });

function bodyOf(payload: InvokeEnvelope): Record<string, any> {
  const body = payload.body;
  return body && typeof body === "object" ? (body as Record<string, any>) : {};
}

/** server L5407-5412 / L5424-5429 同款四 Key 布尔投影（不泄露 Key 原文）。 */
function basemapProjection(basemaps: Record<string, unknown> | null | undefined): Record<string, boolean> {
  return {
    tiandituKey: !!basemaps?.tiandituKey,
    maptilerKey: !!basemaps?.maptilerKey,
    geoapifyKey: !!basemaps?.geoapifyKey,
    esriToken: !!basemaps?.esriToken
  };
}

/* ------------------------------ 通道转录 ------------------------------ */

/** GET /api/search/settings（server L2056-2062 逐点转录）。 */
function invokeSearchSettingsGet(deps: SearchMapSettingsDirectDeps): InvokeResult<unknown> {
  try {
    return ok({ ok: true, backends: deps.searchBackends, settings: deps.publicSearchSettings() });
  } catch (error) {
    const e = error as { message?: unknown };
    return { ok: false, status: 500, data: { ok: false, error: String(e?.message ?? error) } } as InvokeResult<unknown>;
  }
}

/** POST /api/search/settings（server L2064-2071 逐点转录）。 */
function invokeSearchSettingsSave(payload: InvokeEnvelope, deps: SearchMapSettingsDirectDeps): InvokeResult<unknown> {
  try {
    const settings = deps.saveSearchSettings(bodyOf(payload) || {});
    return ok({ ok: true, settings });
  } catch (error) {
    const e = error as { message?: unknown };
    return { ok: false, status: 500, data: { ok: false, error: String(e?.message ?? error) } } as InvokeResult<unknown>;
  }
}

/** POST /api/search/test（server L2073-2081 逐点转录：result 整体透传，catch 投影 category:"unknown"）。 */
async function invokeSearchTest(payload: InvokeEnvelope, deps: SearchMapSettingsDirectDeps): Promise<InvokeResult<unknown>> {
  try {
    // draft 只用于本次测试（可测试尚未保存的新 Key/URL），服务端不会持久化。
    const result = await deps.testSearchBackend(String(bodyOf(payload)?.backend || ""), { draft: bodyOf(payload)?.draft });
    return ok(result);
  } catch (error) {
    const e = error as { message?: unknown };
    return { ok: false, status: 500, data: { ok: false, category: "unknown", message: String(e?.message ?? error) } } as InvokeResult<unknown>;
  }
}

/** GET /api/map/settings（server L5404-5414 逐点转录：四 Key 只回传布尔）。 */
function invokeMapSettingsGet(deps: SearchMapSettingsDirectDeps): InvokeResult<unknown> {
  const s = deps.loadMapSettings();
  return ok({ basemaps: basemapProjection(s.basemaps) });
}

/** POST /api/map/settings（server L5417-5435 逐点转录：保存后重建全部项目 style.json）。 */
function invokeMapSettingsSave(payload: InvokeEnvelope, deps: SearchMapSettingsDirectDeps): InvokeResult<unknown> {
  try {
    const s = deps.saveMapSettings(bodyOf(payload)?.basemaps || {});
    const projects = deps.listProjects();
    for (const p of projects) deps.rebuildBasemapStyle(p.project);
    return ok({
      ok: true,
      basemaps: basemapProjection(s.basemaps),
      projects: projects.map((p) => p.project)
    });
  } catch (error) {
    const e = error as { message?: unknown };
    return { ok: false, status: 500, data: { error: String(e?.message ?? error) } } as InvokeResult<unknown>;
  }
}

/** 搜索与地图设置直调分发器（unknown channel → 404，与 http-forward catch-all 行为对齐）。 */
export async function invokeSearchMapSettingsDirect(
  channel: string,
  payload: InvokeEnvelope | undefined,
  deps: SearchMapSettingsDirectDeps
): Promise<InvokeResult<unknown>> {
  const envelope: InvokeEnvelope = payload ?? {};
  switch (channel as SearchMapSettingsDirectChannel) {
    case "op:search:settings:get":
      return invokeSearchSettingsGet(deps);
    case "op:search:settings:save":
      return invokeSearchSettingsSave(envelope, deps);
    case "op:search:test":
      return invokeSearchTest(envelope, deps);
    case "op:map:settings:get":
      return invokeMapSettingsGet(deps);
    case "op:map:settings:save":
      return invokeMapSettingsSave(envelope, deps);
    default:
      return { ok: false, status: 404, data: { error: `unknown channel: ${channel}` } } as InvokeResult<unknown>;
  }
}
