/**
 * HTTP 转发器单测（F2b）：路径参数展开、查询串组装、方法/体语义、错误信封。
 * fetch 以 stub 注入，不发真实请求。
 */
import { describe, expect, it } from "vitest";
import { DESKTOP_CHANNELS } from "../src/shared/protocol/channels";
import {
  buildQueryString,
  channelRoutes,
  forwardHttpRequest,
  resolvePathTemplate,
  type FetchLike
} from "../src/main/ipc/http-forward";

function stubFetch(status: number, body: string, ok = status >= 200 && status < 300): { fetch: FetchLike; calls: { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }[] } {
  const calls: { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return { ok, status, text: async () => body };
  };
  return { fetch, calls };
}

describe("resolvePathTemplate", () => {
  it("展开全部 :param 并做 encodeURIComponent", () => {
    const { path, missing } = resolvePathTemplate("/api/runs/:id/changes/:changeId/diff", {
      id: "run 1",
      changeId: "c/2"
    });
    expect(path).toBe("/api/runs/run%201/changes/c%2F2/diff");
    expect(missing).toEqual([]);
  });

  it("缺参返回 missing 列表", () => {
    const { path, missing } = resolvePathTemplate("/api/sessions/:id", {});
    expect(missing).toEqual(["id"]);
    expect(path).toBe("/api/sessions/");
  });

  it("空串参数视为缺失", () => {
    const { missing } = resolvePathTemplate("/api/sessions/:id", { id: "" });
    expect(missing).toEqual(["id"]);
  });

  it("无参模板原样返回", () => {
    const { path, missing } = resolvePathTemplate("/api/status", undefined);
    expect(path).toBe("/api/status");
    expect(missing).toEqual([]);
  });
});

describe("buildQueryString", () => {
  it("拼接并编码键值", () => {
    expect(buildQueryString({ client: "c 1", thread: "t/2" })).toBe("?client=c%201&thread=t%2F2");
  });

  it("跳过 undefined/null/空串", () => {
    expect(buildQueryString({ a: undefined, b: null, c: "", d: "x" })).toBe("?d=x");
  });

  it("空/缺省返回空串", () => {
    expect(buildQueryString(undefined)).toBe("");
    expect(buildQueryString({})).toBe("");
  });

  it("数字与布尔转字符串", () => {
    expect(buildQueryString({ limit: 50, pinned: true })).toBe("?limit=50&pinned=true");
  });
});

describe("forwardHttpRequest", () => {
  it("GET：带查询串、无请求体", async () => {
    const { fetch, calls } = stubFetch(200, JSON.stringify({ sessions: [] }));
    const result = await forwardHttpRequest(3003, "GET", "/api/sessions", { query: { pinned: "true" } }, fetch);
    expect(result).toEqual({ ok: true, status: 200, data: { sessions: [] } });
    expect(calls[0]?.url).toBe("http://127.0.0.1:3003/api/sessions?pinned=true");
    expect(calls[0]?.init?.method).toBe("GET");
    expect(calls[0]?.init?.body).toBeUndefined();
  });

  it("POST：JSON 体 + content-type", async () => {
    const { fetch, calls } = stubFetch(200, JSON.stringify({ ok: true }));
    await forwardHttpRequest(3003, "POST", "/api/agent/abort", { body: { client: "web" } }, fetch);
    expect(calls[0]?.init?.headers).toEqual({ "content-type": "application/json" });
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ client: "web" }));
  });

  it("GET 不发送 body", async () => {
    const { fetch, calls } = stubFetch(200, "{}");
    await forwardHttpRequest(3003, "GET", "/api/status", { body: { ignored: true } }, fetch);
    expect(calls[0]?.init?.body).toBeUndefined();
    expect(calls[0]?.init?.headers).toEqual({});
  });

  it("路径缺参：不发起请求，直接返回错误信封", async () => {
    const { fetch, calls } = stubFetch(200, "{}");
    const result = await forwardHttpRequest(3003, "GET", "/api/sessions/:id", {}, fetch);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(String((result.data as { error?: string }).error)).toContain("id");
    expect(calls).toHaveLength(0);
  });

  it("非 2xx：ok=false 且 data 为服务端错误体", async () => {
    const { fetch } = stubFetch(409, JSON.stringify({ error: "当前会话已冻结" }));
    const result = await forwardHttpRequest(3003, "POST", "/api/agent/prompt", { body: { client: "web" } }, fetch);
    expect(result).toEqual({ ok: false, status: 409, data: { error: "当前会话已冻结" } });
  });

  it("202 之类的 2xx 也走 ok=true", async () => {
    const { fetch } = stubFetch(202, JSON.stringify({ ok: true }));
    const result = await forwardHttpRequest(3003, "POST", "/api/runs/:id/resume", { params: { id: "r1" }, body: {} }, fetch);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(202);
  });

  it("非 JSON 响应体：2xx 保留 ok，错误体给出截断原文", async () => {
    const { fetch } = stubFetch(200, "<html>bad");
    const result = await forwardHttpRequest(3003, "GET", "/api/status", undefined, fetch);
    expect(result.ok).toBe(true);
    expect(String((result.data as { error?: string }).error)).toContain("非 JSON");
  });

  it("空响应体解析为空对象", async () => {
    const { fetch } = stubFetch(204, "");
    const result = await forwardHttpRequest(3003, "DELETE", "/api/sessions/:id", { params: { id: "s1" } }, fetch);
    expect(result).toEqual({ ok: true, status: 204, data: {} });
  });

  it("网络失败：ok=false status=0", async () => {
    const fetch: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const result = await forwardHttpRequest(3003, "GET", "/api/status", undefined, fetch);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(String((result.data as { error?: string }).error)).toContain("ECONNREFUSED");
  });
});

describe("channelRoutes", () => {
  it("与通道清单一一对应", () => {
    const routes = channelRoutes();
    expect(routes.length).toBe(Object.keys(DESKTOP_CHANNELS).length);
    expect(routes[0]?.channel).toBe("op:status:get");
    expect(routes[0]?.route).toEqual({ method: "GET", path: "/api/status" });
  });
});
