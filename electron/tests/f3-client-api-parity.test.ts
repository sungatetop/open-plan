// @vitest-environment jsdom
/**
 * client API 层对拍（F3 批1）：client/src/api.js（浏览器 fetch）与
 * electron/src/renderer/api/client-api.ts（IPC 通道）的语义等价。
 *
 * 对拍口径（同输入同流）：
 *   - 旧侧 stub global fetch 捕获 method/url/body；新侧 stub window.opDesktop.invoke 捕获 channel/payload；
 *   - HTTP 形态等价：旧 method+路径 == 通道路由 method+path（params 代入模板）；
 *   - 查询串等价：旧 URL searchParams 与 payload.query 逐键相等（空值剔除规则两侧一致）；
 *   - body 等价：旧 JSON body 与 payload.body 深等；
 *   - 成功/失败返回与 throw 形状（message/code/detail）逐字段相等。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { DESKTOP_CHANNELS, type DesktopChannelId } from "../src/shared/protocol/channels";

/** 组装查询串（R6-4 起就地内联，原 http-forward buildQueryString 同语义）：undefined/null/空串跳过。 */
function buildQueryString(query: Record<string, unknown> | undefined): string {
  if (!query) return "";
  const pairs = Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (!pairs.length) return "";
  return "?" + pairs.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join("&");
}

const clientApi = await import("../../client/src/api.js");
const desktopApi = await import("../src/renderer/api/client-api");

/** jsdom 的 AbortSignal 可能缺 static timeout（apiControl 依赖）：探测缺失则补最小实现 */
if (typeof AbortSignal.timeout !== "function") {
  (AbortSignal as unknown as { timeout: (ms: number) => AbortSignal }).timeout = (ms: number) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  };
}

interface HttpCall { method: string; url: string; body?: string }
interface IpcCall { channel: string; payload?: Record<string, unknown> }

const SAMPLE_DATA = { sample: "ok", items: [1, 2] };

/** 双侧同流 stub：旧 fetch 与新 invoke 返回同一 data，调用记录分别入列 */
function setupParity(): { httpCalls: HttpCall[]; ipcCalls: IpcCall[] } {
  const httpCalls: HttpCall[] = [];
  const ipcCalls: IpcCall[] = [];
  vi.stubGlobal("fetch", async (path: string | URL, opts?: RequestInit) => {
    httpCalls.push({
      method: opts?.method ?? "GET",
      url: String(path),
      body: typeof opts?.body === "string" ? opts.body : undefined
    });
    return { ok: true, status: 200, json: async () => SAMPLE_DATA };
  });
  (window as unknown as { opDesktop: unknown }).opDesktop = {
    invoke: async (channel: string, payload?: Record<string, unknown>) => {
      ipcCalls.push({ channel, payload });
      return { ok: true, status: 200, data: SAMPLE_DATA };
    }
  };
  return { httpCalls, ipcCalls };
}

/** 模板路径代入 params（对拍用简单 id，无编码差异） */
function expandPath(template: string, params?: Record<string, string>): string {
  let path = template;
  for (const [key, value] of Object.entries(params ?? {})) path = path.replace(`:${key}`, value);
  return path;
}

/** 断言第 callIndex 次调用：旧 HTTP 形态/查询串/body 与新通道调用逐项等价 */
function assertParity(httpCalls: HttpCall[], ipcCalls: IpcCall[], callIndex: number, channel: DesktopChannelId): void {
  const http = httpCalls[callIndex];
  const ipc = ipcCalls[callIndex];
  const route = DESKTOP_CHANNELS[channel];
  if (!http || !ipc) throw new Error(`第 ${callIndex} 次调用缺失：http=${httpCalls.length} ipc=${ipcCalls.length}`);
  expect(ipc.channel).toBe(channel);
  expect(http.method).toBe(route.method);
  const url = new URL(http.url, "http://legacy");
  expect(url.pathname).toBe(expandPath(route.path, ipc.payload?.params as Record<string, string> | undefined));

  // 查询串：旧 URL searchParams 与新 payload.query 逐键相等（空串/undefined/null 两侧都应缺省）
  const newQuery = (ipc.payload?.query ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(newQuery)) {
    expect(value, `新侧 ${channel} query.${key} 不应为空值`).not.toStrictEqual("");
    expect(value).not.toBe(undefined);
    expect(value).not.toBe(null);
    expect(url.searchParams.get(key), `query.${key} 不等`).toBe(String(value));
  }
  expect([...url.searchParams.keys()].sort()).toEqual(Object.keys(newQuery).sort());

  // body
  if (ipc.payload?.body === undefined) {
    expect(http.body).toBeUndefined();
  } else {
    expect(JSON.parse(http.body ?? "null")).toEqual(ipc.payload.body);
  }
}

async function expectBothThrow(
  oldPromise: Promise<unknown>,
  newPromise: Promise<unknown>,
  expected: { message: string; code?: string; detail?: unknown }
): Promise<void> {
  const oldError = await oldPromise.then(() => { throw new Error("旧侧未抛错"); }, (e: unknown) => e as Error);
  const newError = await newPromise.then(() => { throw new Error("新侧未抛错"); }, (e: unknown) => e as Error);
  expect(newError.message).toBe(oldError.message);
  expect(newError.message).toBe(expected.message);
  expect((newError as { code?: string }).code).toBe((oldError as { code?: string }).code);
  expect((newError as { code?: string }).code).toBe(expected.code);
  expect((newError as { detail?: unknown }).detail).toEqual((oldError as { detail?: unknown }).detail);
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as { opDesktop?: unknown }).opDesktop;
});

describe("client-api(chat 链路) 与 client/api.js 等价（对拍）", () => {
  it("getStatus", async () => {
    const { httpCalls, ipcCalls } = setupParity();
    const [oldData, newData] = await Promise.all([clientApi.getStatus(), desktopApi.getStatus()]);
    expect(newData).toEqual(oldData);
    assertParity(httpCalls, ipcCalls, 0, "op:status:get");
  });

  it("listSessions：字符串形态 / 对象全字段 / 空对象", async () => {
    const { httpCalls, ipcCalls } = setupParity();
    await Promise.all([clientApi.listSessions("f1.json"), desktopApi.listSessions("f1.json")]);
    assertParity(httpCalls, ipcCalls, 0, "op:sessions:list");

    await Promise.all([
      clientApi.listSessions({ projectId: "p1", mode: "m", runStatus: "running", pinned: false, frozen: "true" }),
      desktopApi.listSessions({ projectId: "p1", mode: "m", runStatus: "running", pinned: false, frozen: "true" })
    ]);
    assertParity(httpCalls, ipcCalls, 1, "op:sessions:list");
    expect(new URL(httpCalls[1]?.url ?? "", "http://legacy").searchParams.get("pinned")).toBe("false");

    await Promise.all([clientApi.listSessions(), desktopApi.listSessions()]);
    assertParity(httpCalls, ipcCalls, 2, "op:sessions:list");
    expect(new URL(httpCalls[2]?.url ?? "", "http://legacy").search).toBe("");
  });

  it("listSessions：pinned/frozen 原样字符串化（0 → '0'）", async () => {
    const { httpCalls, ipcCalls } = setupParity();
    await Promise.all([clientApi.listSessions({ pinned: 0 as unknown as boolean }), desktopApi.listSessions({ pinned: 0 as unknown as boolean })]);
    assertParity(httpCalls, ipcCalls, 0, "op:sessions:list");
    expect(new URL(httpCalls[0]?.url ?? "", "http://legacy").searchParams.get("pinned")).toBe("0");
  });

  it("getSession：view/limit/before 组装", async () => {
    const { httpCalls, ipcCalls } = setupParity();
    await Promise.all([clientApi.getSession("s1", { view: "chat", limit: 30, before: 12 }), desktopApi.getSession("s1", { view: "chat", limit: 30, before: 12 })]);
    assertParity(httpCalls, ipcCalls, 0, "op:sessions:get");
    await Promise.all([clientApi.getSession("s2"), desktopApi.getSession("s2")]);
    assertParity(httpCalls, ipcCalls, 1, "op:sessions:get");
  });

  it("会话族写操作：delete/delete-batch/rename/pin/freeze/fork", async () => {
    const { httpCalls, ipcCalls } = setupParity();
    await Promise.all([clientApi.deleteSession("s1"), desktopApi.deleteSession("s1")]);
    assertParity(httpCalls, ipcCalls, 0, "op:sessions:delete");

    await Promise.all([clientApi.deleteSessions(["a", "b"]), desktopApi.deleteSessions(["a", "b"])]);
    assertParity(httpCalls, ipcCalls, 1, "op:sessions:batch-delete");

    await Promise.all([clientApi.renameSession("s1", "新名"), desktopApi.renameSession("s1", "新名")]);
    assertParity(httpCalls, ipcCalls, 2, "op:sessions:rename");

    await Promise.all([clientApi.pinSession("s1", false), desktopApi.pinSession("s1", false)]);
    assertParity(httpCalls, ipcCalls, 3, "op:sessions:pin");

    await Promise.all([clientApi.freezeSession("s1", true, "验收中"), desktopApi.freezeSession("s1", true, "验收中")]);
    assertParity(httpCalls, ipcCalls, 4, "op:sessions:freeze");

    await Promise.all([clientApi.forkSession("s1", "分叉", { sourceMessageId: "m9" }), desktopApi.forkSession("s1", "分叉", { sourceMessageId: "m9" })]);
    assertParity(httpCalls, ipcCalls, 5, "op:sessions:fork");
  });

  it("listRuns：全 options + 默认 limit 50", async () => {
    const { httpCalls, ipcCalls } = setupParity();
    await Promise.all([
      clientApi.listRuns("t1", 20, { sessionId: "s", cwd: "d", projectId: "p", status: "running", mode: "all", query: "q", includeEvents: "latest", fields: "summary" }),
      desktopApi.listRuns("t1", 20, { sessionId: "s", cwd: "d", projectId: "p", status: "running", mode: "all", query: "q", includeEvents: "latest", fields: "summary" })
    ]);
    assertParity(httpCalls, ipcCalls, 0, "op:runs:list");
    // mode/status 为 "all" 时两侧都剔除
    expect(new URL(httpCalls[0]?.url ?? "", "http://legacy").searchParams.get("mode")).toBe(null);

    await Promise.all([clientApi.listRuns(), desktopApi.listRuns()]);
    assertParity(httpCalls, ipcCalls, 1, "op:runs:list");
    expect(new URL(httpCalls[1]?.url ?? "", "http://legacy").searchParams.get("limit")).toBe("50");
  });

  it("Run 族写/读操作：get/cancel/resume/retry/rollback/step/artifacts/diff/acceptance", async () => {
    const { httpCalls, ipcCalls } = setupParity();
    await Promise.all([clientApi.getRun("r1", { signal: new AbortController().signal }), desktopApi.getRun("r1", { signal: new AbortController().signal })]);
    assertParity(httpCalls, ipcCalls, 0, "op:runs:get");

    await Promise.all([clientApi.cancelRun("r1"), desktopApi.cancelRun("r1")]);
    assertParity(httpCalls, ipcCalls, 1, "op:runs:cancel");
    expect(JSON.parse(httpCalls[1]?.body ?? "{}")).toEqual({ reason: "用户请求取消" });

    await Promise.all([clientApi.resumeRun("r1"), desktopApi.resumeRun("r1")]);
    assertParity(httpCalls, ipcCalls, 2, "op:runs:resume");

    await Promise.all([clientApi.retryRun("r1"), desktopApi.retryRun("r1")]);
    assertParity(httpCalls, ipcCalls, 3, "op:runs:retry");

    await Promise.all([clientApi.rollbackRun("r1", ["a.txt"]), desktopApi.rollbackRun("r1", ["a.txt"])]);
    assertParity(httpCalls, ipcCalls, 4, "op:runs:rollback");

    await Promise.all([clientApi.updateRunStep("r1", "st1", { status: "done" }), desktopApi.updateRunStep("r1", "st1", { status: "done" })]);
    assertParity(httpCalls, ipcCalls, 5, "op:runs:step");

    await Promise.all([clientApi.publishArtifact("r1", "a1"), desktopApi.publishArtifact("r1", "a1")]);
    assertParity(httpCalls, ipcCalls, 6, "op:runs:artifacts:publish");

    await Promise.all([clientApi.confirmArtifactAcceptance("r1", "a1", "ok"), desktopApi.confirmArtifactAcceptance("r1", "a1", "ok")]);
    assertParity(httpCalls, ipcCalls, 7, "op:runs:artifacts:accept");

    await Promise.all([clientApi.getRunAcceptance("r1"), desktopApi.getRunAcceptance("r1")]);
    assertParity(httpCalls, ipcCalls, 8, "op:runs:acceptance");

    await Promise.all([clientApi.getRunChangeDiff("r1", "c1"), desktopApi.getRunChangeDiff("r1", "c1")]);
    assertParity(httpCalls, ipcCalls, 9, "op:runs:diff");
    // page=0 两侧都不带 query
    expect(new URL(httpCalls[9]?.url ?? "", "http://legacy").search).toBe("");

    await Promise.all([clientApi.getRunChangeDiff("r1", "c1", 3), desktopApi.getRunChangeDiff("r1", "c1", 3)]);
    assertParity(httpCalls, ipcCalls, 10, "op:runs:diff");

    await Promise.all([clientApi.listPublishedArtifacts("d:\\w", "p1"), desktopApi.listPublishedArtifacts("d:\\w", "p1")]);
    assertParity(httpCalls, ipcCalls, 11, "op:artifacts:list");

    await Promise.all([clientApi.listArtifacts({ cwd: "d:\\w" }), desktopApi.listArtifacts({ cwd: "d:\\w" })]);
    assertParity(httpCalls, ipcCalls, 12, "op:artifacts:list");

    await Promise.all([clientApi.rollbackPublishedArtifact("pub1"), desktopApi.rollbackPublishedArtifact("pub1")]);
    assertParity(httpCalls, ipcCalls, 13, "op:artifacts:rollback");
  });

  it("Agent 交互族：compact/new/resume/pending/approval-mode/events-read", async () => {
    const { httpCalls, ipcCalls } = setupParity();
    await Promise.all([clientApi.compactAgentContext("web", "t1", "压缩"), desktopApi.compactAgentContext("web", "t1", "压缩")]);
    assertParity(httpCalls, ipcCalls, 0, "op:agent:compact");

    await Promise.all([clientApi.createAgentThread("web", "t1", "d:\\w", { label: "L" }), desktopApi.createAgentThread("web", "t1", "d:\\w", { label: "L" })]);
    assertParity(httpCalls, ipcCalls, 1, "op:agent:new");

    await Promise.all([clientApi.resumeAgentThread("web", "t1", "sess1", "d:\\w"), desktopApi.resumeAgentThread("web", "t1", "sess1", "d:\\w")]);
    assertParity(httpCalls, ipcCalls, 2, "op:agent:resume");

    await Promise.all([clientApi.listPendingQuestions("web", "t1"), desktopApi.listPendingQuestions("web", "t1")]);
    assertParity(httpCalls, ipcCalls, 3, "op:agent:pending");

    await Promise.all([clientApi.getApprovalMode(), desktopApi.getApprovalMode()]);
    assertParity(httpCalls, ipcCalls, 4, "op:agent:approval-mode:get");

    await Promise.all([clientApi.setApprovalMode("auto"), desktopApi.setApprovalMode("auto")]);
    assertParity(httpCalls, ipcCalls, 5, "op:agent:approval-mode:set");

    await Promise.all([clientApi.markAgentEventsRead("web", 42), desktopApi.markAgentEventsRead("web", 42)]);
    assertParity(httpCalls, ipcCalls, 6, "op:agent:events-read");
  });

  it("listPendingQuestions 空 thread：调用侧原样携带，转发器剔除空值——服务端 `|| ''` 兜底下等价", async () => {
    const { httpCalls, ipcCalls } = setupParity();
    await Promise.all([clientApi.listPendingQuestions("web", ""), desktopApi.listPendingQuestions("web", "")]);
    const url = new URL(httpCalls[0]?.url ?? "", "http://legacy");
    expect(url.searchParams.get("client")).toBe("web");
    // 调用侧信封原样携带（剔除是转发器职责）
    expect(ipcCalls[0]?.payload?.query).toEqual({ client: "web", thread: "" });
    // 转发器按信封约定剔除空串后，与服务端视角等价
    expect(buildQueryString(ipcCalls[0]?.payload?.query as Record<string, string>)).toBe("?client=web");
  });

  it("失败信封：409 {error, code, detail} → 两侧 throw 形状逐字段相等", async () => {
    setupParity();
    const failureBody = { error: "当前会话已冻结", code: "SESSION_BUSY", detail: { owner: "c1" } };
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 409, json: async () => failureBody }));
    (window as unknown as { opDesktop: unknown }).opDesktop = {
      invoke: async () => ({ ok: false, status: 409, data: failureBody })
    };
    await expectBothThrow(clientApi.cancelRun("r1"), desktopApi.cancelRun("r1"), {
      message: "当前会话已冻结", code: "SESSION_BUSY", detail: { owner: "c1" }
    });
  });

  it("失败信封：空 error 回退 `HTTP ${status}`；缺 code/detail 不挂载", async () => {
    setupParity();
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 500, json: async () => ({ error: "" }) }));
    (window as unknown as { opDesktop: unknown }).opDesktop = {
      invoke: async () => ({ ok: false, status: 500, data: { error: "" } })
    };
    await expectBothThrow(clientApi.getStatus(), desktopApi.getStatus(), { message: "HTTP 500" });
    // 缺 code：新侧 ApiError 上不应存在 code 字段（对齐旧实现 truthy 赋值）
    const newError = await desktopApi.getStatus().then(() => null, (e: unknown) => e as Error);
    expect(newError).toBeInstanceOf(desktopApi.ApiError);
    expect((newError as { code?: string } | null)?.code).toBeUndefined();
  });

  it("非 JSON 失败体：旧 json().catch({}) → HTTP 500；新转发器截断原文（语义差异登记）", async () => {
    setupParity();
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 500, json: async () => { throw new Error("bad json"); } }));
    (window as unknown as { opDesktop: unknown }).opDesktop = {
      invoke: async () => ({ ok: false, status: 500, data: { error: "响应非 JSON：<html>bad" } })
    };
    const oldError = await clientApi.getStatus().then(() => null, (e: unknown) => e as Error);
    const newError = await desktopApi.getStatus().then(() => null, (e: unknown) => e as Error);
    expect(oldError?.message).toBe("HTTP 500");
    // 差异仅 message 原文更可读；status/调用路径等价，行为均为 throw
    expect(newError).toBeInstanceOf(desktopApi.ApiError);
    expect((newError as unknown as { status: number }).status).toBe(500);
  });
});

describe("client-api 本地工具", () => {
  it("getClientId：首次生成 client- 前缀并持久化，二次复用", () => {
    localStorage.removeItem("oaw_client_id");
    const first = desktopApi.getClientId();
    expect(first).toMatch(/^client-/);
    expect(localStorage.getItem("oaw_client_id")).toBe(first);
    expect(desktopApi.getClientId()).toBe(first);
  });

  it("fileToBase64：文本文件 base64 与 mediaType（jsdom FileReader）", async () => {
    const file = new File(["hello 规聚"], "a.txt", { type: "text/plain" });
    const result = await desktopApi.fileToBase64(file);
    expect(result.mediaType).toBe("text/plain");
    expect(Buffer.from(result.data, "base64").toString("utf8")).toBe("hello 规聚");
  });

  it("fileToBase64：无类型文件回退 application/octet-stream", async () => {
    const file = new File(["x"], "b.bin");
    const result = await desktopApi.fileToBase64(file);
    expect(result.mediaType).toBe("application/octet-stream");
  });
});
