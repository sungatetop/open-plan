/**
 * 状态与知识库摄取、模型刷新通道直调器（D-1b，非 agent 域收编第二批）：
 * op:status:get / op:kb:ingest / op:models:refresh → 进程内直调。
 *
 * 旧路径：渲染层 invoke → http-forward 转发 sidecar HTTP。本模块把 3 条通道的
 * sidecar 路由编排逐点转录为主进程内直调（行号锚点均指 server/index.mjs）：
 *   - op:status:get（L317-340）：进程身份 / OfficeCLI / native 能力 / runtimeFlags /
 *     picker 状态聚合投影；
 *   - op:kb:ingest（L447-455）：kb.ingestDocx(name)，ok?200:400 result 整体透传；
 *   - op:models:refresh（L1767-1775）：agentManager.refreshModels + listModelCatalog
 *     → { ok:true, ...catalog, models, count }（catch 仅 {error}，无 ok:false——忠实转录）。
 *
 * 语义差异（注释声明，HTTP 专属面在 IPC 形态无对应物，C-7 requestId=null 先例）：
 *   - API_TOKEN/setAuthCookie 分支与 authRequired：sidecar HTTP 认证形态专属，IPC
 *     invoke 不经 HTTP 认证 → 跳过 cookie 设置，authRequired 恒 false；
 *   - host：sidecar 监听地址，app 形态不监听端口 → null；
 *   - service.startedAt：sidecar 为进程启动时间戳；本直调器由 main/index.ts 在注册时
 *     构造一次性常量传入（注册即 main 进程启动窗口，语义等价）；
 *   - service.identity/sandboxIdentity：serviceIdentity（os.userInfo）逐行转录；
 *   - version：app.getVersion()（electron 与根 package.json 同步版本，等价 server 侧
 *     pkg.version——C-7 serviceVersion 先例）。
 *
 * 数据源：backend/workspace.ts（OFFICECLI，B2 对拍覆盖）+ backend/native-files.ts
 * （S3-15 对拍覆盖）+ backend/feature-flags.ts + backend/kb.ts（S3-7 对拍覆盖）+
 * 装配单飞 agentManager（refreshModels/listModelCatalog，C-3 同款接入）+
 * backend/agent/pi-runtime.ts（PI_PACKAGE_VERSION 静态常量）。
 *
 * 门控：OP_DESKTOP_SYSTEM_STATUS_DIRECT 且 OP_DESKTOP_AGENT_DOMAIN 双门控
 * （S4 语义：未设置=默认启用，=0 显式回滚——流量切换评估方案 §4-S4）。
 * 本模块不 import electron（纯逻辑，vitest 可直接测）；注册入口在 main/index.ts。
 */
import { PI_PACKAGE_VERSION } from "../backend/agent/pi-runtime";
import type { InvokeEnvelope, InvokeResult } from "../../shared/protocol/channels";

/** 状态聚合编排的跨域依赖（生产接线传 backend 真实模块与装配单飞，测试注入桩）。 */
export interface SystemStatusDirectDeps {
  /** OfficeCLI 可执行文件路径（backend/workspace.ts OFFICECLI） */
  officecliPath: string;
  /** 应用版本（生产 app.getVersion()，等价 server 侧 pkg.version） */
  serviceVersion: () => string;
  /** 本机能力投影（backend/native-files.ts nativeCapabilities） */
  nativeCapabilities: () => Record<string, unknown>;
  /** 等待中的系统选择器状态（backend/native-files.ts activePickerInfo） */
  activePickerInfo: () => Record<string, unknown>;
  /** 优化项 feature flag 快照（backend/feature-flags.ts runtimeFlagsSnapshot） */
  runtimeFlagsSnapshot: () => Record<string, unknown>;
  /** docx → md 入知识库（backend/kb.ts ingestDocx） */
  ingestDocx: (name: unknown) => Promise<{ ok: boolean } & Record<string, unknown>>;
  /** 重新扫描模型（装配单飞 agentManager.refreshModels） */
  refreshModels: () => Promise<unknown[]>;
  /** 模型目录（装配单飞 agentManager.listModelCatalog） */
  listModelCatalog: () => Promise<Record<string, unknown>>;
  /** 服务进程身份（serviceIdentity 转录，生产 os.userInfo 面） */
  identity: () => string;
  /** 服务启动时间戳（生产为注册时一次性 new Date().toISOString()） */
  startedAt: string;
}

/** 状态与知识库摄取、模型刷新直调 invoke 通道清单（与 DESKTOP_CHANNELS 对应路由一致）。 */
export const SYSTEM_STATUS_DIRECT_CHANNELS = [
  "op:status:get",
  "op:kb:ingest",
  "op:models:refresh"
] as const;

export type SystemStatusDirectChannel = (typeof SYSTEM_STATUS_DIRECT_CHANNELS)[number];

const ok = (data: unknown): InvokeResult<unknown> => ({ ok: true, status: 200, data });

function bodyOf(payload: InvokeEnvelope): Record<string, any> {
  const body = payload.body;
  return body && typeof body === "object" ? (body as Record<string, any>) : {};
}

/* ------------------------------ 通道转录 ------------------------------ */

/** GET /api/status（server L317-340 逐点转录；HTTP 认证面差异见模块头注释）。 */
function invokeStatusGet(deps: SystemStatusDirectDeps): InvokeResult<unknown> {
  const identity = deps.identity();
  return ok({
    ok: true,
    officecli: pathBasename(deps.officecliPath),
    version: deps.serviceVersion(),
    piPackageVersion: PI_PACKAGE_VERSION,
    // host：sidecar 监听地址，app 形态不监听端口（无对应物 → null，C-7 先例）。
    host: null,
    // authRequired：IPC invoke 不经 HTTP 认证（API_TOKEN/cookie 面跳过，见模块头注释）。
    authRequired: false,
    platform: process.platform,
    native: deps.nativeCapabilities(),
    // 评审 R8：优化项 feature flag 快照统一经 /api/status 下发（前端据此决定面板可见性）。
    runtimeFlags: deps.runtimeFlagsSnapshot(),
    // 是否有等待用户操作的系统选择器（前端可据此显示"等待选择/取消等待"）。
    picker: deps.activePickerInfo(),
    service: {
      pid: process.pid,
      startedAt: deps.startedAt,
      uptimeSec: Math.round(process.uptime()),
      identity,
      sandboxIdentity: /sandbox|CodexSandbox/i.test(identity)
    }
  });
}

/** POST /api/kb/ingest（server L447-455 逐点转录：ok?200:400 result 整体透传）。 */
async function invokeKbIngest(payload: InvokeEnvelope, deps: SystemStatusDirectDeps): Promise<InvokeResult<unknown>> {
  try {
    const r = await deps.ingestDocx(bodyOf(payload)?.name);
    return { ok: Boolean(r.ok), status: r.ok ? 200 : 400, data: r } as InvokeResult<unknown>;
  } catch (error) {
    const e = error as { message?: unknown };
    return { ok: false, status: 500, data: { ok: false, error: String(e?.message || error) } } as InvokeResult<unknown>;
  }
}

/** POST /api/models/refresh（server L1767-1775 逐点转录：catch 仅 {error} 无 ok:false）。 */
async function invokeModelsRefresh(deps: SystemStatusDirectDeps): Promise<InvokeResult<unknown>> {
  try {
    const models = await deps.refreshModels();
    const catalog = await deps.listModelCatalog();
    return ok({ ok: true, ...catalog, models, count: models.length });
  } catch (error) {
    const e = error as { message?: unknown };
    return { ok: false, status: 500, data: { error: String(e?.message ?? error) } } as InvokeResult<unknown>;
  }
}

/** 状态聚合直调分发器（unknown channel → 404，与 http-forward catch-all 行为对齐）。 */
export async function invokeSystemStatusDirect(
  channel: string,
  payload: InvokeEnvelope | undefined,
  deps: SystemStatusDirectDeps
): Promise<InvokeResult<unknown>> {
  const envelope: InvokeEnvelope = payload ?? {};
  switch (channel as SystemStatusDirectChannel) {
    case "op:status:get":
      return invokeStatusGet(deps);
    case "op:kb:ingest":
      return invokeKbIngest(envelope, deps);
    case "op:models:refresh":
      return invokeModelsRefresh(deps);
    default:
      return { ok: false, status: 404, data: { error: `unknown channel: ${channel}` } } as InvokeResult<unknown>;
  }
}

/** path.basename 的本地等价（避免整份 node:path 依赖面；Windows 反斜杠与正斜杠均处理）。 */
function pathBasename(p: string): string {
  const normalized = String(p || "").replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}
