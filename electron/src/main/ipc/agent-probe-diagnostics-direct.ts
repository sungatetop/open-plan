/**
 * 探测与诊断族通道直调器（C-7，C 层收尾批，迁移期过渡形态）：
 * op:agent:model:probe / op:agent:diagnostics → 进程内直调探测与诊断域。
 *
 * 旧路径：渲染层 invoke → http-forward 转发 sidecar HTTP。本模块把 2 条通道的
 * sidecar 路由编排逐点转录为主进程内直调（行号锚点均指 server/index.mjs）：
 *   - op:agent:model:probe（L1835-1856）：Pi 真实 ModelRuntime 最小请求探测，
 *     不改写用户会话和工作区文件；失败不 500——落诊断记录后返回 200 ok:false
 *     + diagnostic 摘要（code/status/category/retryable/message）；
 *   - op:agent:diagnostics（L1889-1931）：全链路诊断快照（service/requestId/
 *     model 目录对账/runtime/sessions/scheduler/recentFailures+hint/authProviders/
 *     authErrors/network）。
 *
 * 本地辅助转录（TS 侧此前无符号）：
 *   - recordAgentDiagnostic（L117-136，S2/S3 先例同款：直调形态无 req →
 *     requestId/runId=null，写诊断日志 + console.error 后返回 record）；
 *   - readRecentAgentDiagnostics（L138-153）：诊断日志倒序扫描 + client/thread/
 *     runId 过滤 + limit 截断（1..50，非法回退 20）；
 *   - agentFailureHint（L155-171）：凭据失效 / 网络·超时两类提示文案。
 *
 * 与旧路径的语义差异（S2 先例同款）：requestId 为 null（sidecar HTTP 每请求
 * uuid 在直调形态无对应物）；service.version 生产绑定 app.getVersion()
 * （electron/package.json 与根 package.json 同步版本，等价旧路径 pkg.version）。
 *
 * 门控：OP_DESKTOP_AGENT_PROBE_DIAGNOSTICS_DIRECT 且 OP_DESKTOP_AGENT_DOMAIN 双门控
 * （S4 起默认开，=0 显式回滚——流量切换评估方案 §4-S4）。本模块不 import electron（纯逻辑，
 * vitest 可直接测）；注册入口在 main/index.ts。
 */
import fs from "node:fs";
import path from "node:path";
import type { ChannelFailureData, InvokeEnvelope, InvokeResult } from "../../shared/protocol/channels";
import { classifyAgentError } from "../backend/agent/agent-errors";
import { loadSettingsDefault } from "./agent-pi-config-direct";

/** 探测与诊断族编排的跨域依赖（生产接线传 backend 真实模块，测试注入桩）。 */
export interface AgentProbeDiagnosticsDirectDeps {
  /** AgentManager（backend/agent/assembly.ts getAgentManager） */
  probeModel: (model: unknown, options: { timeoutMs?: unknown }) => Promise<any>;
  runtimeHealth: (key: string) => unknown;
  listRuntimes: () => Record<string, any>;
  listSessionStates: () => unknown;
  listModelCatalog: () => Promise<Record<string, any>>;
  /** 网络（agent/pi-runtime.ts piRuntimeManager.networkDiagnostics） */
  networkDiagnostics: () => unknown;
  /** 凭据面（agent/provider-auth.ts + agent/agent-errors.ts） */
  listAuth: () => Record<string, any>;
  getCredentialErrors: () => Record<string, unknown>;
  /** 默认模型设置（agent/pi-config-management.ts，C-3 loadSettingsDefault 数据源） */
  readRuntimeSettings: () => Record<string, any>;
  /** thread 会话键（agent/agent-key.ts） */
  agentKey: (client: unknown, thread: unknown) => string;
  /** 诊断日志路径（缺省 TEMP/open-plan-agent连接诊断.log，S2 先例同款） */
  diagnosticLogPath?: () => string;
  /** 应用版本（生产 app.getVersion()，等价旧路径 pkg.version） */
  serviceVersion: () => string;
}

/** 探测与诊断族直调 invoke 通道清单（与 DESKTOP_CHANNELS 对应通道一致）。 */
export const AGENT_PROBE_DIAGNOSTICS_DIRECT_CHANNELS = [
  "op:agent:model:probe",
  "op:agent:diagnostics"
] as const;

export type AgentProbeDiagnosticsDirectChannel = (typeof AGENT_PROBE_DIAGNOSTICS_DIRECT_CHANNELS)[number];

const ok = (data: unknown): InvokeResult<unknown> => ({ ok: true, status: 200, data });

/** 非 2xx 信封（http-forward 非 2xx 同形：data = 服务端 JSON 错误体）。 */
const fail = (status: number, data: unknown): InvokeResult<unknown> => ({
  ok: false,
  status,
  data: data as ChannelFailureData
});

function bodyOf(payload: InvokeEnvelope): Record<string, any> {
  const body = payload.body;
  return body && typeof body === "object" ? (body as Record<string, any>) : {};
}

function queryOf(payload: InvokeEnvelope): Record<string, any> {
  return (payload.query ?? {}) as Record<string, any>;
}

/** 诊断日志缺省路径（S2 先例 defaultDiagnosticLogPath 同款）。 */
function defaultDiagnosticLogPath(): string {
  return path.join(process.env.TEMP || "", "open-plan-agent连接诊断.log");
}

/** recordAgentDiagnostic 转录（server/index.mjs L117-136；直调无 req → requestId/runId=null）。 */
function recordAgentDiagnostic(deps: AgentProbeDiagnosticsDirectDeps, details: Record<string, any>): Record<string, unknown> {
  const info = details.error ? classifyAgentError(details.error) : details;
  const record = {
    time: new Date().toISOString(),
    requestId: null,
    clientId: details.client || null,
    threadId: details.thread || null,
    runId: details.runId || null,
    model: details.model || null,
    providerStatus: info.status ?? null,
    errorCode: info.code ?? null,
    errorCategory: info.category ?? null,
    causeCode: info.causeCode ?? null,
    retryable: Boolean(info.retryable),
    message: info.message || "模型连接失败"
  };
  try { fs.appendFileSync(deps.diagnosticLogPath?.() ?? defaultDiagnosticLogPath(), `${JSON.stringify(record)}\n`, "utf8"); } catch { /* 诊断落盘失败不阻断主流程 */ }
  console.error("[agent] prompt failed", record);
  return record;
}

/** readRecentAgentDiagnostics 转录（server L138-153 逐行）。 */
function readRecentAgentDiagnostics(
  deps: AgentProbeDiagnosticsDirectDeps,
  { client = "", thread = "", runId = "", limit = 20 }: Record<string, any> = {}
): Array<Record<string, any>> {
  let lines: string[] = [];
  try {
    lines = fs.readFileSync(deps.diagnosticLogPath?.() ?? defaultDiagnosticLogPath(), "utf8").split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
  const max = Math.max(1, Math.min(50, Number.parseInt(String(limit), 10) || 20));
  const matches: Array<Record<string, any>> = [];
  for (let index = lines.length - 1; index >= 0 && matches.length < max; index -= 1) {
    try {
      const item = JSON.parse(lines[index]!);
      if (client && item.clientId !== client) continue;
      if (thread && item.threadId !== thread) continue;
      if (runId && item.runId !== runId) continue;
      matches.push(item);
    } catch {}
  }
  return matches;
}

/** agentFailureHint 转录（server L155-171 逐行）。 */
function agentFailureHint(item: Record<string, any> = {}): string {
  const code = String(item.errorCode || item.code || "");
  const category = String(item.errorCategory || "");
  const status = String(item.providerStatus || "");
  const causeCode = String(item.causeCode || "");
  const message = String(item.message || "");
  if (/^(401|403)$/.test(status) || code === "AUTH_ERROR" || category === "auth" || /(?:invalid.?api.?key|authentication|unauthori[sz]ed|forbidden|permission denied)/i.test(message)) {
    return "凭据已失效：请重新保存 API Key";
  }
  if (["HOST_NETWORK_RESTRICTED", "NETWORK_UNREACHABLE", "MODEL_TIMEOUT", "MODEL_STREAM_TIMEOUT", "MODEL_PROBE_TIMEOUT"].includes(code)
    || ["HOST_NETWORK_RESTRICTED", "NETWORK_UNREACHABLE", "MODEL_TIMEOUT", "MODEL_STREAM_TIMEOUT"].includes(category)
    || causeCode === "ETIMEDOUT"
    || /(?:timed?.?out|timeout|connection.?refused|getaddrinfo|ENOTFOUND|ETIMEDOUT)/i.test(message)) {
    return "模型请求超时：请检查网络或代理设置（设置→模型与连接→模型网络）";
  }
  return "";
}

/** POST /api/agent/model/probe（server L1835-1856 逐点转录；失败不 500，落诊断后 200 ok:false）。 */
async function invokeModelProbe(payload: InvokeEnvelope, deps: AgentProbeDiagnosticsDirectDeps): Promise<InvokeResult<unknown>> {
  const body = bodyOf(payload);
  const { model, timeoutMs } = body;
  if (!model) return fail(400, { ok: false, error: "model required", code: "MODEL_REQUIRED" });
  const startedAt = Date.now();
  try {
    return ok(await deps.probeModel(model, { timeoutMs }));
  } catch (error) {
    const diagnostic = recordAgentDiagnostic(deps, { model: String(model), error });
    return ok({
      ok: false,
      model: String(model),
      latencyMs: Date.now() - startedAt,
      diagnostic: {
        code: diagnostic.errorCode,
        status: diagnostic.providerStatus,
        category: diagnostic.errorCategory || null,
        retryable: diagnostic.retryable,
        message: diagnostic.message
      }
    });
  }
}

/** GET /api/agent/diagnostics（server L1889-1931 逐点转录；catalog 之外无 try/catch，忠实转录）。 */
async function invokeDiagnostics(payload: InvokeEnvelope, deps: AgentProbeDiagnosticsDirectDeps): Promise<InvokeResult<unknown>> {
  const query = queryOf(payload);
  const client = String(query.client || "").trim();
  const thread = String(query.thread || "").trim();
  const runtime = client ? deps.runtimeHealth(deps.agentKey(client, thread)) as Record<string, any> : null;
  const runtimeList = deps.listRuntimes();
  const auth = deps.listAuth();
  let catalog: Record<string, any> | null = null;
  let catalogError: string | null = null;
  try {
    const value = await deps.listModelCatalog();
    const settingsSelected = loadSettingsDefault({ readRuntimeSettings: deps.readRuntimeSettings });
    const selected = runtime?.model?.provider && runtime?.model?.id
      ? `${runtime.model.provider}/${runtime.model.id}`
      : settingsSelected;
    const selectedCatalog = value.models.find((item: Record<string, any>) => item.id === selected) || null;
    catalog = {
      selected,
      selectedInCatalog: Boolean(selectedCatalog),
      selectedAvailable: selectedCatalog?.available ?? null,
      counts: value.counts,
      source: value.source
    };
  } catch (error) {
    catalogError = String((error as any)?.message || error);
  }
  const settingsDefault = loadSettingsDefault({ readRuntimeSettings: deps.readRuntimeSettings });
  const selectedProvider = runtime?.model?.provider || String(settingsDefault).split("/")[0] || null;
  const authProviders = Object.fromEntries(
    Object.entries(auth).map(([provider, value]) => [provider, { type: (value as any)?.type || "unknown", set: Boolean(value) }])
  );
  return ok({
    ok: true,
    service: { version: deps.serviceVersion(), pid: process.pid },
    // 旧路径 req.requestId（sidecar 每请求 uuid）；直调形态无 HTTP 请求（S2 先例同款 → null）
    requestId: null,
    model: {
      ...(catalog || { selected: settingsDefault, selectedInCatalog: null, selectedAvailable: null }),
      authProvider: selectedProvider,
      authConfigured: Boolean(selectedProvider && auth[selectedProvider]),
      catalogError
    },
    runtime,
    // A4：per-client 会话占用快照（busy/queuedCount/compacting），区分"正常占用"与"卡死"
    sessions: deps.listSessionStates(),
    scheduler: runtimeList.scheduler,
    recentFailures: readRecentAgentDiagnostics(deps, { client, thread, runId: query.runId, limit: query.limit })
      .map((item) => ({ ...item, hint: agentFailureHint(item) })),
    authProviders,
    authErrors: deps.getCredentialErrors(),
    network: deps.networkDiagnostics()
  });
}

/**
 * 探测与诊断族通道直调分发：channel → 逐通道转录的 sidecar 路由编排。
 * 未知通道不进入本分发（注册面只登记 AGENT_PROBE_DIAGNOSTICS_DIRECT_CHANNELS 清单）；
 * 处理器抛出的意外错误统一 500（对齐 http-forward 网络失败兜底形态）。
 */
export async function invokeAgentProbeDiagnosticsDirect(
  channel: AgentProbeDiagnosticsDirectChannel,
  envelope: InvokeEnvelope | undefined,
  deps: AgentProbeDiagnosticsDirectDeps
): Promise<InvokeResult<unknown>> {
  const payload: InvokeEnvelope = envelope ?? {};
  try {
    switch (channel) {
      case "op:agent:model:probe": return await invokeModelProbe(payload, deps);
      case "op:agent:diagnostics": return await invokeDiagnostics(payload, deps);
    }
  } catch (error) {
    return fail(500, { error: error instanceof Error ? error.message : String(error) });
  }
  return fail(404, { error: `unknown channel: ${channel}` });
}
