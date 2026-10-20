/**
 * IPC → HTTP 转发器（迁移期过渡形态，B6 收口后退役）。
 *
 * 把 shared/protocol/channels.ts 清单里的 invoke 通道翻译成对内嵌 legacy server
 * （127.0.0.1:port）的 HTTP 请求，保留 REST 语义（状态码/错误体）。
 * 本模块不 import electron（纯逻辑，vitest 可直接测）；注册入口在 main/index.ts。
 */
import {
  DESKTOP_CHANNELS,
  type ChannelFailureData,
  type DesktopChannelId,
  type HttpMethod,
  type InvokeEnvelope,
  type InvokeResult
} from "../../shared/protocol/channels";

const FORWARD_TIMEOUT_MS = 120_000;

export interface ChannelRoute {
  method: HttpMethod;
  path: string;
}

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

/** 展开路径模板中的 `:param` 段；缺参时返回 missing 列表（不猜测拼接）。 */
export function resolvePathTemplate(
  template: string,
  params: Readonly<Record<string, string>> | undefined
): { path: string; missing: string[] } {
  const missing: string[] = [];
  const path = template.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
    const value = params?.[name];
    if (value === undefined || value === "") {
      missing.push(name);
      return "";
    }
    return encodeURIComponent(value);
  });
  return { path, missing };
}

/** 组装查询串：undefined/null/空串跳过。 */
export function buildQueryString(
  query: InvokeEnvelope["query"]
): string {
  if (!query) return "";
  const pairs = Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (!pairs.length) return "";
  return "?" + pairs.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join("&");
}

/**
 * 执行一次转发：返回 invoke 结果信封。
 * 非 2xx → ok:false（data 为服务端错误体）；网络失败/非 JSON → ok:false（人工错误体）。
 */
export async function forwardHttpRequest(
  port: number,
  method: HttpMethod,
  pathTemplate: string,
  payload: InvokeEnvelope | undefined,
  fetchImpl: FetchLike = fetch
): Promise<InvokeResult<unknown>> {
  const envelope: InvokeEnvelope = payload ?? {};
  const { path: resolvedPath, missing } = resolvePathTemplate(pathTemplate, envelope.params);
  if (missing.length) {
    return { ok: false, status: 0, data: { error: `通道缺少路径参数：${missing.join(", ")}` } };
  }
  const url = `http://127.0.0.1:${port}${resolvedPath}${buildQueryString(envelope.query)}`;
  const hasBody = method !== "GET" && envelope.body !== undefined;
  try {
    const response = await fetchImpl(url, {
      method,
      headers: hasBody ? { "content-type": "application/json" } : {},
      body: hasBody ? JSON.stringify(envelope.body) : undefined,
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS)
    });
    const data = parseBody(await response.text());
    return response.ok
      ? { ok: true, status: response.status, data }
      : { ok: false, status: response.status, data: data as ChannelFailureData };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: { error: `本地服务调用失败：${error instanceof Error ? error.message : String(error)}` }
    };
  }
}

function parseBody(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: `本地服务返回了非 JSON 响应：${text.slice(0, 200)}` };
  }
}

/**
 * 通道 → 转发目标路由的静态映射（供注册循环与对账测试共用）。
 * 键为 DesktopChannelId，值为 { method, path }，与 DESKTOP_CHANNELS 一致。
 */
export function channelRoutes(): ReadonlyArray<{ channel: DesktopChannelId; route: ChannelRoute }> {
  return Object.entries(DESKTOP_CHANNELS).map(([channel, route]) => ({
    channel: channel as DesktopChannelId,
    route: { method: route.method, path: route.path }
  }));
}
