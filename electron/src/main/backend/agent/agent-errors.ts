/**
 * Agent 错误判定/分类族（B6-6-1，自 server/agent.mjs L444-605、L681-700 逐行转录）。
 *
 * 纯判定函数 + 模块级 invalidCredentials 记录（与旧实现一致，进程内共享）。
 * promptWithFirstEventTimeout / waitForPiSessionIdle 依赖 runtime 管理器，留待后续批次。
 */

/** 上下文压缩阈值（后续压缩域批次复用）。 */
export const AUTO_COMPACT_PROMPT_CHARS = 90000;
// 只监控“首个模型/工具事件”的等待时间，不限制已经开始执行的长任务。
// 供应商连接卡住时必须自动释放 Agent，否则前端会永久停留在“连接模型”。
export const MODEL_FIRST_EVENT_TIMEOUT_MS = Math.max(10000, Number.parseInt(process.env.OAW_MODEL_FIRST_EVENT_TIMEOUT_MS || "45000", 10) || 45000);
// 首个事件之后仍可能出现供应商流中途静默；工具正在执行时不计入该保护，
// 避免长时间 Office/脚本任务被误中止。可通过环境变量按供应商特性调整。
export const MODEL_IDLE_TIMEOUT_MS = Math.max(30000, Number.parseInt(process.env.OAW_MODEL_IDLE_TIMEOUT_MS || "120000", 10) || 120000);

const TERMINAL_AGENT_ERROR_PATTERN = /(?:invalid.?api.?key|authentication|unauthori[sz]ed|forbidden|permission denied|model not found|no model selected|insufficient(?:[_\s-]?user)?[_\s-]?quota|quota exceeded|available balance|credit\s+insufficient|balance\s*=\s*0|out of budget|billing|usage limit|monthly usage|invalid request|bad request|context length|content policy|abort(?:ed|ing)?|cancel(?:led|ed)?)/i;
const TRANSIENT_AGENT_ERROR_PATTERN = /(?:429|408|425|500|501|502|503|504|529|rate.?limit|overloaded|service.?unavailable|internal.?error|provider.?returned.?error|network.?error|connection.?error|connection.?refused|connection.?lost|other side closed|fetch failed|getaddrinfo|ENOTFOUND|EAI_AGAIN|upstream.?connect|reset before headers|socket hang up|socket connection was closed|timed?.?out|timeout|terminated|websocket.?closed|temporar(?:y|ily)|try again|模型连接超过|模型流式输出超过|没有响应|已自动中止)/i;
// 供应商流被截断：请求本身没报错，只是流在没有 finish_reason 的情况下结束。
// 这不是"模型调用失败"的终态错误——重试通常能恢复，而且此时产物往往已经写完，
// 必须与真实故障分开（否则界面把干完的活报成「本轮失败」）。
const PROVIDER_TRUNCATION_PATTERN = /(?:stream ended without finish_reason|without finish_reason|unexpected end of (?:stream|response)|stream (?:ended|closed) unexpectedly)/i;

export function isProviderTruncation(value: unknown): boolean {
  const message = typeof value === "string" ? value : rawAgentErrorMessage(value);
  return PROVIDER_TRUNCATION_PATTERN.test(message);
}

// 服务重启后 entry.promptChars 会归零，但 Pi 已恢复的 JSONL 会话仍可能很长。
// 仅在会话创建/恢复时估算一次，避免每次发送都遍历历史消息。
export function estimateRestoredContextChars(session: unknown): number {
  const messages = (session as { agent?: { state?: { messages?: unknown } } } | null | undefined)?.agent?.state?.messages;
  if (!Array.isArray(messages)) return 0;
  let chars = 0;
  for (const message of messages) {
    try { chars += JSON.stringify(message).length; } catch { chars += 256; }
    if (chars >= AUTO_COMPACT_PROMPT_CHARS) return chars;
  }
  return chars;
}

export function rawAgentErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  const e = error as { message?: unknown; cause?: { message?: unknown } } | null | undefined;
  return String(e?.message || e?.cause?.message || error || "模型连接失败");
}

export function agentErrorStatus(error: unknown, message = rawAgentErrorMessage(error)): number | null {
  const e = error as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } } | null | undefined;
  const direct = Number(e?.status ?? e?.statusCode ?? e?.response?.status ?? 0) || null;
  if (direct) return direct;
  const match = String(message || "").match(/\b([1-5]\d{2})\s+status\s+code\b/i);
  return match ? Number(match[1]!) : null;
}

/** 供应商偶发返回空 400；只有首轮、无工具副作用时允许安全重试。 */
export function isEmptyBadRequestError(error: unknown): boolean {
  const message = rawAgentErrorMessage(error);
  const e = error as { responseBody?: unknown; body?: unknown } | null | undefined;
  const body = String(e?.responseBody || e?.body || "");
  const combined = `${message} ${body}`;
  return agentErrorStatus(error, combined) === 400
    && /\b400\s+status\s+code\s*\(\s*(?:no body|empty(?:\s+response)?\s+body)\s*\)/i.test(combined);
}

export function safeAgentErrorMessage(message: unknown): string {
  return String(message || "模型连接失败")
    .replace(/(api[_-]?key|authorization|bearer|access[_-]?token|refresh[_-]?token)([\s=:]+)[^\s,;]+/gi, "$1$2[已隐藏]")
    .slice(0, 1200);
}

/**
 * 用户主动中断（或排队期取消）会让 SDK 以 "Request aborted" 之类的错误收尾。
 * 这不是模型故障：一旦把它当错误上报，界面会先显示「生成失败 · 模型调用失败：
 * Request aborted」，几秒后才变成「本轮已中断」，事件流里还会多出 agent_error /
 * runtime_error，Runtime 也会被标成失败并在下一次发送时被当作失效运行时重建。
 */
const ABORT_LIKE_PATTERN = /(?:request\s+aborted|aborted|aborting|\babort\b|cancelled|canceled|interrupted|用户请求中断|已中断|已取消|任务在完成前被中断)/i;

export function isAbortLikeError(value: unknown): boolean {
  const message = typeof value === "string" ? value : rawAgentErrorMessage(value);
  return ABORT_LIKE_PATTERN.test(message);
}

/** 判断这次收尾是否属于"用户主动中断"：必须同时满足"用户要求中断" + 错误形如中断。 */
export function isUserAbortSettled(entry: unknown, value: unknown): boolean {
  if (!entry) return false;
  const e = entry as { cancelRequested?: unknown; abortRequestedAt?: unknown } | null;
  const requested = Boolean(e?.cancelRequested) || Boolean(e?.abortRequestedAt && Date.now() - Number(e.abortRequestedAt) < 120000);
  return requested && isAbortLikeError(value);
}

/** Pi 可能把最终模型错误放进 assistant message 后正常结束；转成可被上层 Run 捕获的错误。 */
export interface SettledAgentError extends Error {
  code?: string;
  status?: number | null;
  errorCategory?: string;
  oawClassification?: AgentErrorClassification;
  noRetry?: boolean;
}

export function createSettledAgentError(message: unknown): SettledAgentError {
  const normalizedMessage = safeAgentErrorMessage(rawAgentErrorMessage(message));
  const error = new Error(normalizedMessage) as SettledAgentError;
  const classification = classifyAgentError(error);
  error.code = classification.code || "PI_SETTLED_ERROR";
  error.status = classification.status;
  error.errorCategory = classification.category;
  error.oawClassification = classification;
  error.noRetry = !classification.retryable;
  return error;
}

export function captureSettledAgentError(entry: unknown): string | null {
  const e = entry as { lastAgentError?: unknown; lastSettledError?: unknown } | null | undefined;
  const settledError = e?.lastAgentError ? safeAgentErrorMessage(rawAgentErrorMessage(e.lastAgentError)) : null;
  if (e) e.lastSettledError = settledError;
  return settledError;
}

export interface CredentialErrorRecord {
  at: string;
  message: string;
}

const invalidCredentials = new Map<unknown, CredentialErrorRecord>();

function recordInvalidCredential(provider: unknown, message: unknown): void {
  if (!provider) return;
  invalidCredentials.set(provider, { at: new Date().toISOString(), message: safeAgentErrorMessage(message) });
}

export function clearInvalidCredential(provider: unknown): void {
  if (provider) invalidCredentials.delete(provider);
}

export function getCredentialErrors(): Record<string, CredentialErrorRecord> {
  const result: Record<string, CredentialErrorRecord> = {};
  for (const [provider, record] of invalidCredentials) result[provider as string] = { at: record.at, message: record.message };
  return result;
}

export interface AgentErrorClassification {
  message: string;
  code: string | null;
  status: number | null;
  causeCode: string | null;
  provider: string | null;
  model: string | null;
  category: string;
  retryable: boolean;
}

/** 将 SDK/网关错误归一化，供有限重试和诊断日志复用。 */
export function classifyAgentError(error: unknown): AgentErrorClassification {
  const e = (error && typeof error === "object" ? error : {}) as Record<string, any>;
  const message = rawAgentErrorMessage(error);
  const status = agentErrorStatus(error, message);
  const safeEmpty400 = isEmptyBadRequestError(error);
  const causeCode = e.cause?.code ? String(e.cause.code) : null;
  const authFailure = [401, 403].includes(status as number)
    || e.errorCategory === "AUTH_ERROR"
    || /(?:invalid.?api.?key|authentication|unauthori[sz]ed|forbidden|permission denied)/i.test(message);
  const configurationFailure = /(?:provider\s+is\s+not\s+configured|provider.*not configured|no provider configuration|missing (?:an? )?(?:api key|credentials?))/i.test(message);
  const timeout = ["MODEL_TIMEOUT", "MODEL_STREAM_TIMEOUT", "MODEL_PROBE_TIMEOUT"].includes(String(e.code || "")) || /(?:timed?.?out|timeout)/i.test(message);
  const rateLimited = [408, 425, 429, 529].includes(status as number) || /(?:429|rate.?limit|overloaded)/i.test(message);
  const network = /(?:network.?error|connection.?error|connection.?refused|connection.?lost|other side closed|fetch failed|getaddrinfo|ENOTFOUND|EAI_AGAIN|upstream.?connect|reset before headers|socket hang up|socket connection was closed|websocket.?closed)/i.test(message);
  const terminal = authFailure || configurationFailure || TERMINAL_AGENT_ERROR_PATTERN.test(message) || ([400, 404].includes(status as number) && !safeEmpty400);
  const retryable = !configurationFailure && (safeEmpty400 || isProviderTruncation(message) || (!terminal && Boolean(
    ["MODEL_TIMEOUT", "MODEL_STREAM_TIMEOUT"].includes(String(e.code || ""))
      || (status && [408, 425, 429, 500, 501, 502, 503, 504, 529].includes(status as number))
      || TRANSIENT_AGENT_ERROR_PATTERN.test(message),
  )));
  const quota = /(?:insufficient(?:[_\s-]?user)?[_\s-]?quota|quota exceeded|available balance|credit\s+insufficient|balance\s*=\s*0|out of budget|billing)/i.test(message);
  const category = authFailure ? "auth" : quota ? "quota" : configurationFailure ? "configuration" : timeout ? "timeout" : rateLimited ? "rate_limit" : network ? "network" : [400, 404].includes(status as number) ? "request" : retryable ? "transient" : "unknown";
  if (category === "auth" && (e.provider || e.model?.provider)) {
    recordInvalidCredential(e.provider || e.model?.provider, message);
  }
  return {
    message: safeAgentErrorMessage(message),
    code: e.code ? String(e.code) : null,
    status,
    causeCode,
    provider: e.provider || e.model?.provider || null,
    model: e.model?.id || (typeof e.model === "string" ? e.model : null),
    category,
    retryable,
  };
}

export interface AgentTimeoutError extends Error {
  code: string;
  noRetry: boolean;
}

export function createModelTimeoutError(): AgentTimeoutError {
  const error = new Error(`模型连接超过 ${Math.round(MODEL_FIRST_EVENT_TIMEOUT_MS / 1000)} 秒没有响应，已自动中止`) as AgentTimeoutError;
  error.code = "MODEL_TIMEOUT";
  error.noRetry = true;
  return error;
}

export function createModelStreamTimeoutError(): AgentTimeoutError {
  const error = new Error(`模型流式输出超过 ${Math.round(MODEL_IDLE_TIMEOUT_MS / 1000)} 秒没有新事件，已自动中止；已保留当前已生成内容`) as AgentTimeoutError;
  error.code = "MODEL_STREAM_TIMEOUT";
  error.noRetry = true;
  return error;
}

const THINKING_LEVEL_ORDER: readonly string[] = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * Pi 模型目录里的 thinkingLevelMap 才是本模型真正支持的档位。
 * 例如 Hy3 的 medium/xhigh/max 是 null；直接把 medium 传给 Pi 会让界面
 * 显示“标准”，但运行时仍可能保留较慢的默认档位。
 */
export function resolveThinkingLevel(model: unknown, requested: unknown = "low"): string {
  const wanted = THINKING_LEVEL_ORDER.includes(String(requested)) ? String(requested) : "low";
  const m = (model && typeof model === "object" ? model : {}) as Record<string, any>;
  const map = m.thinkingLevelMap;
  if (!map || typeof map !== "object") return m.reasoning === false ? "off" : wanted;
  if (map[wanted] !== null && map[wanted] !== undefined) return wanted;
  if (wanted === "medium" || wanted === "minimal" || wanted === "xhigh" || wanted === "max") {
    if (map.low !== null && map.low !== undefined) return "low";
  }
  for (const level of THINKING_LEVEL_ORDER) {
    if (map[level] !== null && map[level] !== undefined) return level;
  }
  return m.reasoning === false ? "off" : "low";
}
