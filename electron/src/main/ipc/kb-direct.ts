/**
 * 知识库域通道直调器（F5-4）：op:kb:* 12 条通道 → 进程内直调 backend/kb.ts 域
 * （本地索引 + IMA 云端 + docx 联动；op:kb:ingest 已由 system-status-direct.ts D-1b 收编）。
 *
 * 旧路径：渲染层 invoke → http-forward 转发 sidecar HTTP。本模块把 12 条通道的
 * sidecar 路由编排逐点转录为主进程内直调（行号锚点均指 server/index.mjs）：
 *   - op:kb:status（L359-362）：await scan() → status()（每次请求先重扫，增量语义）；
 *   - op:kb:roots:add（L364-369）：addRoot(body.path) → !ok 400 整体透传 →
 *     await scan(true)（强制重扫）→ { ok:true, roots, fileCount: status().fileCount }；
 *   - op:kb:roots:remove（L371-375）：removeRoot(body.path)（removeRoot 对不存在根
 *     仍 ok，无 400 分支）→ await scan(true) → r 整体透传（DELETE 请求体经
 *     InvokeEnvelope.body 携带，http-forward 对非 GET 通道发 body 与 Express 同语义）；
 *   - op:kb:tree（L377-382）：await scan() → rootIdx=parseInt(query.root) 非法回退 0 →
 *     getTreeLevel(rootIdx, query.dir || "")；
 *   - op:kb:search（L384-390）：await scan() → { results: search(q||"", rootIdx 非法
 *     回退 null, parseInt(limit)||30) }；
 *   - op:kb:graph（L392-397）：await scan() → include=(query.include||"links")
 *     .split(",").filter(Boolean) → getGraph({ rootIdx 非法回退 null, include,
 *     maxNodes: parseInt(query.max)||800 })；
 *   - op:kb:doc（L399-405）：await scan() → getDoc(query.path||"", rootIdx 非法回退
 *     null) → !doc 404 { error:"not found" }；
 *   - op:kb:ima:status/bases/search/doc（L408-411）：imaStatus()/imaListBases()/
 *     imaSearch(query.q||"", query.kb||"")/imaDoc(query.media_id||"")——IMA 凭证未配置
 *     时 imaStatus 返回 { configured:false }（路由注释语义，忠实不抛）；
 *   - op:kb:export-docx（L458-467）：try/catch → rootIdx=parseInt(body.rootIdx) →
 *     exportDocx(body.relPath, 非法回退 null) → !ok 400 整体透传 → 成功 r；catch →
 *     500 { ok:false, error }。
 *
 * 语义差异（注释声明）：L359-411 十一条路由**无 try/catch**——kb.scan()/域函数抛错时
 * Express 4 对 rejected async handler 挂起响应（旧 client 表现为请求悬挂）；IPC 直调
 * 形态下异常沿 dispatcher 传播到 ipcMain.handle（渲染层 invoke rejected）——对调用方
 * 等价于"请求失败"，比 HTTP 挂起更可诊断，属形态差异不属减配。
 *
 * 数据源：backend/kb.ts（17 导出，与 server/kb.mjs 17/17 对齐——R5 侦察核验；
 * 本模块用其中 scan/status/addRoot/removeRoot/getTreeLevel/search/getGraph/getDoc/
 * imaStatus/imaListBases/imaSearch/imaDoc/exportDocx 13 项）。
 *
 * 门控：OP_DESKTOP_KB_DIRECT 且 OP_DESKTOP_AGENT_DOMAIN 双门控（S4 语义：未设置=默认
 * 启用，=0 显式回滚）。未覆盖通道（op:kb:ingest）已由 system-status-direct 直调；
 * 本模块不 import electron（纯逻辑，vitest 可直接测）；注册入口在 main/index.ts。
 */
import type { InvokeEnvelope, InvokeResult } from "../../shared/protocol/channels";

/** 知识库域编排的跨域依赖（生产接线传 backend/kb.ts 真实模块，测试注入桩）。 */
export interface KbDirectDeps {
  /** 重扫本地索引（backend/kb.ts scan；roots 变更后传 true 强制全量） */
  scan: (force?: boolean) => Promise<unknown>;
  /** 索引状态（backend/kb.ts status，含 fileCount/roots） */
  status: () => Record<string, unknown>;
  /** 新增根目录（backend/kb.ts addRoot，无效路径返回 { ok:false, error }） */
  addRoot: (dir: unknown) => { ok: boolean; roots?: string[]; error?: string };
  /** 移除根目录（backend/kb.ts removeRoot，恒返回 { ok, roots }） */
  removeRoot: (dir: unknown) => { ok: boolean; roots: string[] };
  /** 目录树一级（backend/kb.ts getTreeLevel） */
  getTreeLevel: (rootIdx: number, dirPath?: string) => { dirs: unknown[]; files: unknown[] };
  /** 本地检索（backend/kb.ts search） */
  search: (q: unknown, rootIdx?: number | null, limit?: number) => unknown[];
  /** 知识图谱（backend/kb.ts getGraph，同步返回 { nodes, edges, meta, stats }） */
  getGraph: (options: { rootIdx?: number | null; include?: string[]; maxNodes?: number }) => unknown;
  /** 取文档（backend/kb.ts getDoc，不存在返回 null） */
  getDoc: (relPath: string, rootIdx?: number | null) => Record<string, unknown> | null;
  /** IMA 云端状态（backend/kb.ts imaStatus，未配置返回 { configured:false }） */
  imaStatus: () => Promise<Record<string, unknown>>;
  /** IMA 云端知识库清单（backend/kb.ts imaListBases） */
  imaListBases: () => Promise<unknown>;
  /** IMA 云端检索（backend/kb.ts imaSearch） */
  imaSearch: (query: string, kbId: string) => Promise<unknown>;
  /** IMA 云端文档（backend/kb.ts imaDoc） */
  imaDoc: (mediaId: string) => Promise<unknown>;
  /** kb 文档导出 docx 写工作区（backend/kb.ts exportDocx） */
  exportDocx: (relPath: string, rootIdx?: number | null) => Promise<{ ok: boolean; name?: string; error?: string }>;
}

/** 知识库域直调 invoke 通道清单（与 DESKTOP_CHANNELS 对应路由一致）。 */
export const KB_DIRECT_CHANNELS = [
  "op:kb:status",
  "op:kb:roots:add",
  "op:kb:roots:remove",
  "op:kb:tree",
  "op:kb:search",
  "op:kb:graph",
  "op:kb:doc",
  "op:kb:ima:status",
  "op:kb:ima:bases",
  "op:kb:ima:search",
  "op:kb:ima:doc",
  "op:kb:export-docx"
] as const;

export type KbDirectChannel = (typeof KB_DIRECT_CHANNELS)[number];

const ok = (data: unknown): InvokeResult<unknown> => ({ ok: true, status: 200, data });
const fail = (status: number, data: unknown): InvokeResult<unknown> => ({ ok: false, status, data } as InvokeResult<unknown>);

const bodyOf = (payload: InvokeEnvelope): Record<string, any> => (payload.body ?? {}) as Record<string, any>;
const queryOf = (payload: InvokeEnvelope): Record<string, string | undefined> => (payload.query ?? {}) as Record<string, string | undefined>;

/** server 同款 rootIdx 归一：parseInt 非法 → 回退值（tree 用 0，其余用 null）。 */
function parseRootIdx(raw: string | undefined, fallback: number | null): number | null {
  const idx = parseInt(String(raw ?? ""), 10);
  return Number.isNaN(idx) ? fallback : idx;
}

/** GET /api/kb/status（L359-362 逐点转录：先 scan 再 status）。 */
async function invokeStatus(deps: KbDirectDeps): Promise<InvokeResult<unknown>> {
  await deps.scan();
  return ok(deps.status());
}

/** POST /api/kb/roots（L364-369 逐点转录：!ok 400 透传 → scan(true) → fileCount 取自 status）。 */
async function invokeRootsAdd(payload: InvokeEnvelope, deps: KbDirectDeps): Promise<InvokeResult<unknown>> {
  const r = deps.addRoot(bodyOf(payload).path);
  if (!r.ok) return fail(400, r);
  await deps.scan(true);
  return ok({ ok: true, roots: r.roots, fileCount: (deps.status() as { fileCount?: unknown }).fileCount });
}

/** DELETE /api/kb/roots（L371-375 逐点转录：removeRoot → scan(true) → r 整体透传）。 */
async function invokeRootsRemove(payload: InvokeEnvelope, deps: KbDirectDeps): Promise<InvokeResult<unknown>> {
  const r = deps.removeRoot(bodyOf(payload).path);
  await deps.scan(true);
  return ok(r);
}

/** GET /api/kb/tree（L377-382 逐点转录：rootIdx 非法回退 0）。 */
async function invokeTree(payload: InvokeEnvelope, deps: KbDirectDeps): Promise<InvokeResult<unknown>> {
  await deps.scan();
  const query = queryOf(payload);
  const rootIdx = parseRootIdx(query.root, 0) as number;
  return ok(deps.getTreeLevel(rootIdx, query.dir || ""));
}

/** GET /api/kb/search（L384-390 逐点转录：rootIdx 非法回退 null，limit 缺省 30）。 */
async function invokeSearch(payload: InvokeEnvelope, deps: KbDirectDeps): Promise<InvokeResult<unknown>> {
  await deps.scan();
  const query = queryOf(payload);
  const rootIdx = parseRootIdx(query.root, null);
  const limit = parseInt(String(query.limit ?? ""), 10) || 30;
  return ok({ results: deps.search(query.q || "", rootIdx, limit) });
}

/** GET /api/kb/graph（L392-397 逐点转录：include 逗号分裂去空，maxNodes 缺省 800）。 */
async function invokeGraph(payload: InvokeEnvelope, deps: KbDirectDeps): Promise<InvokeResult<unknown>> {
  await deps.scan();
  const query = queryOf(payload);
  const rootIdx = parseRootIdx(query.root, null);
  const include = (query.include || "links").split(",").filter(Boolean);
  const maxNodes = parseInt(String(query.max ?? ""), 10) || 800;
  return ok(deps.getGraph({ rootIdx, include, maxNodes }));
}

/** GET /api/kb/doc（L399-405 逐点转录：!doc 404 { error: not found }）。 */
async function invokeDoc(payload: InvokeEnvelope, deps: KbDirectDeps): Promise<InvokeResult<unknown>> {
  await deps.scan();
  const query = queryOf(payload);
  const rootIdx = parseRootIdx(query.root, null);
  const doc = deps.getDoc(query.path || "", rootIdx);
  if (!doc) return fail(404, { error: "not found" });
  return ok(doc);
}

/** GET /api/kb/ima/status（L408 逐点转录）。 */
async function invokeImaStatus(deps: KbDirectDeps): Promise<InvokeResult<unknown>> {
  return ok(await deps.imaStatus());
}

/** GET /api/kb/ima/bases（L409 逐点转录）。 */
async function invokeImaBases(deps: KbDirectDeps): Promise<InvokeResult<unknown>> {
  return ok(await deps.imaListBases());
}

/** GET /api/kb/ima/search（L410 逐点转录：q/kb 缺省空串）。 */
async function invokeImaSearch(payload: InvokeEnvelope, deps: KbDirectDeps): Promise<InvokeResult<unknown>> {
  const query = queryOf(payload);
  return ok(await deps.imaSearch(query.q || "", query.kb || ""));
}

/** GET /api/kb/ima/doc（L411 逐点转录：media_id 缺省空串）。 */
async function invokeImaDoc(payload: InvokeEnvelope, deps: KbDirectDeps): Promise<InvokeResult<unknown>> {
  const query = queryOf(payload);
  return ok(await deps.imaDoc(query.media_id || ""));
}

/** POST /api/kb/export-docx（L458-467 逐点转录：rootIdx 非法回退 null → !ok 400 →
 * catch 500 { ok:false, error }）。 */
async function invokeExportDocx(payload: InvokeEnvelope, deps: KbDirectDeps): Promise<InvokeResult<unknown>> {
  try {
    const body = bodyOf(payload);
    const rootIdx = parseRootIdx(body.rootIdx === undefined ? undefined : String(body.rootIdx), null);
    const r = await deps.exportDocx(body.relPath as string, rootIdx);
    if (!r.ok) return fail(400, r);
    return ok(r);
  } catch (error) {
    const e = error as { message?: unknown };
    return fail(500, { ok: false, error: String(e?.message || error) });
  }
}

/**
 * 知识库域直调分发入口：ipcMain.handle 注册侧调用（main/index.ts registerKbDirectInvokers）。
 * 十一条无 try/catch 路由的域函数异常沿本函数传播（见头注释语义差异声明）。
 */
export async function invokeKbDirect(
  channel: string,
  payload: InvokeEnvelope | undefined,
  deps: KbDirectDeps
): Promise<InvokeResult<unknown>> {
  const envelope: InvokeEnvelope = payload ?? {};
  switch (channel as KbDirectChannel) {
    case "op:kb:status":
      return invokeStatus(deps);
    case "op:kb:roots:add":
      return invokeRootsAdd(envelope, deps);
    case "op:kb:roots:remove":
      return invokeRootsRemove(envelope, deps);
    case "op:kb:tree":
      return invokeTree(envelope, deps);
    case "op:kb:search":
      return invokeSearch(envelope, deps);
    case "op:kb:graph":
      return invokeGraph(envelope, deps);
    case "op:kb:doc":
      return invokeDoc(envelope, deps);
    case "op:kb:ima:status":
      return invokeImaStatus(deps);
    case "op:kb:ima:bases":
      return invokeImaBases(deps);
    case "op:kb:ima:search":
      return invokeImaSearch(envelope, deps);
    case "op:kb:ima:doc":
      return invokeImaDoc(envelope, deps);
    case "op:kb:export-docx":
      return invokeExportDocx(envelope, deps);
    default:
      return fail(404, { error: `unknown channel: ${channel}` });
  }
}
