/**
 * 内置浏览器域通道直调器（F6-2）：op:browser:* 8 条通道 → 进程内直调 builtin-browser
 * （server/index.mjs L2084-2305 逐点转录；行号锚点均指 server/index.mjs）。
 *
 *   - op:browser:state（L2084-2090）：browserSessionKey(client, thread) → getBrowserSession →
 *     session ? session.stateView() : inactive 默认（active:false/url:""/title:""/loading:false/
 *     hasFrame:false/ownership:{owner:"agent",reason:"",leaseExpiresAt:0,secondsRemaining:0}）→ { ok, state }；
 *   - op:browser:open（L2092-2102）：!client → 400 { ok:false, error:"client required" }；
 *     url trim 空回退 "https://cn.bing.com" → { ok, state }；catch → 400 { ok:false, error, code: e?.code || null }；
 *   - op:browser:stream-pause（L2105-2114）：B3 面板可见性联动（OAW_BROWSER_ADAPTIVE_STREAM 默认关，
 *     未开启时后端 no-op）；catch → 400 { ok:false, error }（无 code）；
 *   - op:browser:fullpage / op:browser:pdf（L2117-2138）：B4（OAW_BROWSER_FULLPAGE 默认关）；
 *     → { ok, file, base64, bytes, url }；catch → 400 + code；
 *   - op:browser:input（L2271-2280）：body 除 client/thread 外整体透传 browserUserInput
 *     （无 !client 守卫，与服务端一致）；→ { ok, result }；catch → 400 + code；
 *   - op:browser:close（L2282-2291）：{ force: force === true, reason: reason || "" } →
 *     { ok, ...result }；catch → 500 { ok:false, error }（无 code，重置判定靠 message 正则）；
 *   - op:browser:reset（L2295-2305）：!client → 400 "client required"；catch → 500 { ok:false, error }。
 *
 * 帧流推桥（GET /api/browser/stream L2165-2269 的 IPC 替代）：createBrowserWatchRegistry
 * 管理 subscribeBrowser 订阅，事件经 emit（生产绑 broadcastEvent）以 BROWSER_STREAM_EVENT_TYPE
 * 推送，data 形态 { client, thread, event, payload }（event/payload 对齐旧 SSE 消息 {type, data}）。
 * watch 语义对齐 SSE 建立序：初始 state 帧 → refreshTabs（active 时）→ 既有 frame 快照 →
 * subscribeBrowser → noteSubscribers（订阅者数量驱动推流）→ 无帧时 captureFrame。
 * SSE 专属面不转录：连接登记/背压/心跳（IPC 无同源连接池约束）；浏览器帧背压由订阅侧
 * 前端 stream-budget 预算承接（旧 acquireStream 语义保留）。
 *
 * /api/browser/shot 不迁（BrowserPanel 未消费，聊天工具卡文件走 openDocFile/file-urls）。
 *
 * 门控：R6-4 起恒直调（S4 期 OP_DESKTOP_BROWSER_DIRECT 回滚旗标随 sidecar 退役删除）。
 * 本模块不 import electron（纯逻辑，vitest 可注入桩直接测）；注册入口在 main/index.ts。
 */
import type { InvokeEnvelope, InvokeResult } from "../../shared/protocol/channels";
import { BROWSER_INACTIVE_STATE, BROWSER_STREAM_EVENT_TYPE } from "../../shared/protocol/channels";

export { BROWSER_STREAM_EVENT_TYPE };

/** 会话对象的最小结构面（生产传 builtin-browser BrowserSession，测试注入桩）。
 *  state/stateView/异步返回面收窄为结构子集或 object：BrowserState/NavigateResult/CloseResult
 *  无 index signature，Record<string, unknown> 不可作赋值目标（TS2322）。 */
export interface BrowserSessionLike {
  state: { active?: boolean; viewport?: { width?: number; height?: number } };
  frame?: { data: string; at: number; width: number; height: number } | null;
  stateView: () => object;
  refreshTabs: () => Promise<unknown>;
  captureFrame: () => Promise<unknown>;
  noteSubscribers: (count: number) => Promise<unknown> | void;
}

/** 浏览器域编排的跨域依赖（生产接线传 builtin-browser 真实模块，测试注入桩）。 */
export interface BrowserDirectDeps {
  browserSessionKey: (clientId: string, threadId: string) => string;
  getBrowserSession: (key: string) => BrowserSessionLike | null;
  browserOpen: (key: string, url: string) => Promise<object>;
  browserUserInput: (key: string, payload: Record<string, unknown>) => Promise<unknown>;
  browserClose: (key: string, options: { force?: boolean; reason?: string }) => Promise<object>;
  resetBrowserSession: (key: string) => Promise<object>;
  browserSetStreamPaused: (key: string, paused: boolean) => Promise<unknown>;
  browserFullpageScreenshot: (key: string) => Promise<{ file: string; base64: string; bytes: number; url: string }>;
  browserPrintToPdf: (key: string) => Promise<{ file: string; base64: string; bytes: number; url: string }>;
  subscribeBrowser: (key: string, handler: (type: string, data: unknown) => void) => () => void;
  browserSubscriberCount: (key: string) => number;
}

/** 浏览器域直调 invoke 通道清单（与 DESKTOP_CHANNELS 对应路由一致）。 */
export const BROWSER_DIRECT_CHANNELS = [
  "op:browser:state",
  "op:browser:open",
  "op:browser:stream-pause",
  "op:browser:fullpage",
  "op:browser:pdf",
  "op:browser:input",
  "op:browser:close",
  "op:browser:reset"
] as const;

export type BrowserDirectChannel = (typeof BROWSER_DIRECT_CHANNELS)[number];

const ok = (data: unknown): InvokeResult<unknown> => ({ ok: true, status: 200, data });
const fail = (status: number, data: unknown): InvokeResult<unknown> => ({ ok: false, status, data } as InvokeResult<unknown>);

const queryOf = (payload: InvokeEnvelope): Record<string, any> => (payload.query ?? {}) as Record<string, any>;
const bodyOf = (payload: InvokeEnvelope): Record<string, any> => (payload.body ?? {}) as Record<string, any>;

/** GET /api/browser/state（L2084-2090 逐点转录）。 */
function invokeState(payload: InvokeEnvelope, deps: BrowserDirectDeps): InvokeResult<unknown> {
  const { client, thread } = queryOf(payload);
  const key = deps.browserSessionKey(String(client || ""), String(thread || ""));
  const session = deps.getBrowserSession(key);
  return ok({ ok: true, state: session ? session.stateView() : { ...BROWSER_INACTIVE_STATE } });
}

/** POST /api/browser/open（L2092-2102 逐点转录：!client 400 / url trim 兜底必应 / catch 400+code）。 */
async function invokeOpen(payload: InvokeEnvelope, deps: BrowserDirectDeps): Promise<InvokeResult<unknown>> {
  const { client, thread, url } = bodyOf(payload);
  if (!client) return fail(400, { ok: false, error: "client required" });
  const key = deps.browserSessionKey(client, thread);
  try {
    const state = await deps.browserOpen(key, String(url || "").trim() || "https://cn.bing.com");
    return ok({ ok: true, state });
  } catch (error) {
    const e = error as { message?: unknown; code?: unknown };
    return fail(400, { ok: false, error: String(e?.message || error), code: e?.code || null });
  }
}

/** POST /api/browser/stream-pause（L2105-2114 逐点转录：!client 400 / catch 400 无 code）。 */
async function invokeStreamPause(payload: InvokeEnvelope, deps: BrowserDirectDeps): Promise<InvokeResult<unknown>> {
  const { client, thread, paused } = bodyOf(payload);
  if (!client) return fail(400, { ok: false, error: "client required" });
  try {
    await deps.browserSetStreamPaused(deps.browserSessionKey(client, thread || ""), Boolean(paused));
    return ok({ ok: true });
  } catch (error) {
    const e = error as { message?: unknown };
    return fail(400, { ok: false, error: String(e?.message || error) });
  }
}

/** POST /api/browser/fullpage 与 /api/browser/pdf 共用转录（L2117-2138：catch 400+code）。 */
async function invokeCapture(
  payload: InvokeEnvelope,
  deps: BrowserDirectDeps,
  capture: (key: string) => Promise<{ file: string; base64: string; bytes: number; url: string }>
): Promise<InvokeResult<unknown>> {
  const { client, thread } = bodyOf(payload);
  if (!client) return fail(400, { ok: false, error: "client required" });
  try {
    const result = await capture(deps.browserSessionKey(client, thread || ""));
    return ok({ ok: true, file: result.file, base64: result.base64, bytes: result.bytes, url: result.url });
  } catch (error) {
    const e = error as { message?: unknown; code?: unknown };
    return fail(400, { ok: false, error: String(e?.message || error), code: e?.code || null });
  }
}

/** POST /api/browser/input（L2271-2280 逐点转录：无 !client 守卫 / 整体透传 / catch 400+code）。 */
async function invokeInput(payload: InvokeEnvelope, deps: BrowserDirectDeps): Promise<InvokeResult<unknown>> {
  const { client, thread, ...rest } = bodyOf(payload);
  const key = deps.browserSessionKey(client, thread);
  try {
    const result = await deps.browserUserInput(key, rest);
    return ok({ ok: true, result });
  } catch (error) {
    const e = error as { message?: unknown; code?: unknown };
    return fail(400, { ok: false, error: String(e?.message || error), code: e?.code || null });
  }
}

/** POST /api/browser/close（L2282-2291 逐点转录：catch 500 无 code）。 */
async function invokeClose(payload: InvokeEnvelope, deps: BrowserDirectDeps): Promise<InvokeResult<unknown>> {
  const { client, thread, force, reason } = bodyOf(payload);
  const key = deps.browserSessionKey(client, thread);
  try {
    const result = await deps.browserClose(key, { force: force === true, reason: reason || "" });
    return ok({ ok: true, ...result });
  } catch (error) {
    const e = error as { message?: unknown };
    return fail(500, { ok: false, error: String(e?.message || error) });
  }
}

/** POST /api/browser/reset（L2295-2305 逐点转录：!client 400 / catch 500 无 code）。 */
async function invokeReset(payload: InvokeEnvelope, deps: BrowserDirectDeps): Promise<InvokeResult<unknown>> {
  const { client, thread } = bodyOf(payload);
  if (!client) return fail(400, { ok: false, error: "client required" });
  const key = deps.browserSessionKey(client, thread);
  try {
    const result = await deps.resetBrowserSession(key);
    return ok({ ok: true, ...result });
  } catch (error) {
    const e = error as { message?: unknown };
    return fail(500, { ok: false, error: String(e?.message || error) });
  }
}

/** 浏览器域直调分发入口：ipcMain.handle 注册侧调用（main/index.ts registerBrowserDirectInvokers）。 */
export function invokeBrowserDirect(
  channel: string,
  payload: InvokeEnvelope | undefined,
  deps: BrowserDirectDeps
): Promise<InvokeResult<unknown>> | InvokeResult<unknown> {
  const envelope: InvokeEnvelope = payload ?? {};
  switch (channel as BrowserDirectChannel) {
    case "op:browser:state":
      return invokeState(envelope, deps);
    case "op:browser:open":
      return invokeOpen(envelope, deps);
    case "op:browser:stream-pause":
      return invokeStreamPause(envelope, deps);
    case "op:browser:fullpage":
      return invokeCapture(envelope, deps, (key) => deps.browserFullpageScreenshot(key));
    case "op:browser:pdf":
      return invokeCapture(envelope, deps, (key) => deps.browserPrintToPdf(key));
    case "op:browser:input":
      return invokeInput(envelope, deps);
    case "op:browser:close":
      return invokeClose(envelope, deps);
    case "op:browser:reset":
      return invokeReset(envelope, deps);
    default:
      return fail(404, { error: `unknown channel: ${channel}` });
  }
}

// ============================================================================
// 帧流推桥（GET /api/browser/stream 的 IPC 替代）：watch/unwatch 生命周期
// ============================================================================

/** watch 请求面（对齐 SSE 建立参数 client/thread/frames）。 */
export interface BrowserWatchRequest {
  client?: string;
  thread?: string;
  frames?: boolean | string;
}

/** 帧流推桥事件出口（生产绑 broadcastEvent 组装 DesktopEvent）。 */
export type BrowserWatchEmit = (event: { type: string; data: { client: string; thread: string; event: string; payload: unknown } }) => void;

export interface BrowserWatchRegistry {
  watch: (request: BrowserWatchRequest) => { ok: true };
  unwatch: (request: BrowserWatchRequest) => { ok: true };
  /** 已在订阅的 (client, thread) 键数（测试/诊断用） */
  size: () => number;
}

/**
 * 创建 watch 注册表：同 (client, thread) 只保留一条订阅（对齐 SSE 同键去重语义：
 * server L2190-2199 registerServerStream「同一 (路径, client, thread) 只保留最新一条」）。
 * 重复 watch 更新 frames 偏好并重发初始快照（渲染层重挂/重连语义）。
 * unwatch 未知键幂等。watch/unwatch 都同步 noteSubscribers（订阅者数量驱动推流，
 * server L2256-2264 连接建立/断开两侧同款）。
 */
export function createBrowserWatchRegistry(deps: BrowserDirectDeps, emit: BrowserWatchEmit): BrowserWatchRegistry {
  const entries = new Map<string, { client: string; thread: string; unsubscribe: () => void }>();
  const watch = (request: BrowserWatchRequest): { ok: true } => {
    const client = String(request?.client || "");
    const thread = String(request?.thread || "");
    if (!client) return { ok: true };
    const withFrames = request?.frames !== false && request?.frames !== "0";
    const key = deps.browserSessionKey(client, thread);
    const existing = entries.get(key);
    if (existing) {
      existing.unsubscribe();
      entries.delete(key);
    }
    const session = deps.getBrowserSession(key);
    // 初始 state 帧（L2244：无会话回 inactive 默认）
    emit({ type: BROWSER_STREAM_EVENT_TYPE, data: { client, thread, event: "state", payload: session ? session.stateView() : { ...BROWSER_INACTIVE_STATE } } });
    if (session?.state?.active) Promise.resolve(session.refreshTabs()).catch(() => {});
    // 既有帧快照（L2246-2251：width/height 缺省回退 state.viewport，再缺省 null）
    const frame = session?.frame;
    if (withFrames && frame?.data) {
      emit({
        type: BROWSER_STREAM_EVENT_TYPE,
        data: {
          client,
          thread,
          event: "frame",
          payload: {
            data: frame.data,
            at: frame.at,
            width: frame.width || session?.state?.viewport?.width || null,
            height: frame.height || session?.state?.viewport?.height || null
          }
        }
      });
    }
    const unsubscribe = deps.subscribeBrowser(key, (type, data) => {
      if (type === "frame" && !withFrames) return;
      emit({ type: BROWSER_STREAM_EVENT_TYPE, data: { client, thread, event: type, payload: data } });
    });
    entries.set(key, { client, thread, unsubscribe });
    if (session) {
      // 订阅者数量驱动推流：有人看才推流（省 CPU/带宽），并保证面板第一次打开就有一帧（L2256-2259）
      Promise.resolve(session.noteSubscribers(deps.browserSubscriberCount(key))).catch(() => {});
      if (withFrames && !session.frame) Promise.resolve(session.captureFrame()).catch(() => {});
    }
    return { ok: true };
  };
  const unwatch = (request: BrowserWatchRequest): { ok: true } => {
    const client = String(request?.client || "");
    const thread = String(request?.thread || "");
    const key = deps.browserSessionKey(client, thread);
    const entry = entries.get(key);
    if (!entry) return { ok: true };
    entry.unsubscribe();
    entries.delete(key);
    // 断开侧同样同步订阅者数量（L2261-2264 req close 语义）
    const session = deps.getBrowserSession(key);
    if (session) Promise.resolve(session.noteSubscribers(deps.browserSubscriberCount(key))).catch(() => {});
    return { ok: true };
  };
  return { watch, unwatch, size: () => entries.size };
}
