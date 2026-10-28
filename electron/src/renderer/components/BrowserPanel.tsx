import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Icon from "./Icon";
import { browserClose, browserFullpage, browserInput, browserOpen, browserPdf, browserReset, browserState, browserStreamPause } from "../api/client-api";
import { subscribeDesktopEvents, unwatchBrowserStream, watchBrowserStream } from "../api/ipc-client";
import { acquireStream, waitForStreamSlot } from "../lib/stream-budget";
import { flag } from "../lib/feature-flags";
import { setBrowserStreamState } from "../lib/browser-linkage";
import { BROWSER_STREAM_EVENT_TYPE } from "../../shared/protocol/channels";

/**
 * 内置浏览器面板（F6-2：client/src/components/BuiltinBrowserPanel.jsx 逐行等价转录）。
 *
 * - Agent 调用 browser_* 写操作工具时，画面以帧流（CDP screencast）实时显示在这里；
 * - 用户可直接在画面上点击、输入，随时接管（登录、验证码等）；
 * - 只在有活动会话时建立帧流订阅，避免空跑。
 *
 * 架构性等价替换（BRD-009，SSE → IPC 推桥）：
 *   - 旧 EventSource GET /api/browser/stream（重连退避/心跳/背压在连接层）改为
 *     watchBrowserStream/unwatchBrowserStream 生命周期 + subscribeDesktopEvents 过滤
 *     BROWSER_STREAM_EVENT_TYPE 帧（main 侧 subscribeBrowser 推桥，事件 {client, thread,
 *     event, payload}，event/payload 对齐旧 SSE 消息 {type, data}）；连接状态语义
 *     （connected/重连中）由 watch 成功即在线、unwatch 即离线表达——IPC 无同源连接池，
 *     无需指数退避重连；
 *   - stream-budget 帧预算保留：watch 前 acquireStream("browser-frames") 占槽，
 *     槽位不足时 waitForStreamSlot 排队（旧语义：帧流是可放弃的长连接，不挤占对话流）；
 *   - 控制面 8 函数（api.js）→ client-api.ts op:browser:* 封装，「成功返回 data、失败
 *     throw（code 保留）」语义逐行对齐；RECOVERABLE_BROWSER_CODES/PATTERN 重置逻辑不变；
 *   - /api/browser/shot 不迁（组件未消费）。
 */

// 只有「启动 / profile 锁 / CDP 归属」这类异常才值得重置浏览器；
// 导航失败、URL 无效、用户接管都不应销毁标签与登录态。
const RECOVERABLE_BROWSER_CODES = new Set(["BROWSER_LAUNCH_FAILED", "BROWSER_NOT_FOUND", "BROWSER_OWNERSHIP_MISMATCH", "BROWSER_CDP_UNAVAILABLE"]);
const RECOVERABLE_BROWSER_PATTERN = /退出码 21|单例锁|用户数据目录被其他浏览器进程占用|CDP 端点不可用|DevToolsActivePort/;

function openError(result: { error?: string; code?: string }, fallback: string): Error & { code?: string } {
  const error = new Error(result?.error || fallback) as Error & { code?: string };
  error.code = result?.code || "";
  return error;
}

function isRecoverableBrowserError(error: unknown): boolean {
  const e = error as { code?: string; message?: string };
  if (RECOVERABLE_BROWSER_CODES.has(String(e?.code || ""))) return true;
  return RECOVERABLE_BROWSER_PATTERN.test(String(e?.message || ""));
}

interface BrowserOwnershipView { owner?: string; reason?: string; leaseExpiresAt?: number; secondsRemaining?: number }
interface BrowserStateView {
  active?: boolean;
  url?: string;
  title?: string;
  loading?: boolean;
  error?: string | null;
  viewport?: { width?: number; height?: number };
  frameSize?: { width?: number | null; height?: number | null } | null;
  hasFrame?: boolean;
  ownership?: BrowserOwnershipView | null;
  [key: string]: unknown;
}
interface BrowserTabRow { id?: unknown; title?: unknown; url?: unknown; active?: unknown }

const INACTIVE_STATE: BrowserStateView = { active: false, url: "", title: "", loading: false, viewport: { width: 1280, height: 800 }, hasFrame: false, ownership: null };

export interface BrowserPanelProps {
  clientId: string;
  threadId?: string;
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
}

export default function BrowserPanel({ clientId, threadId, fullscreen = false, onToggleFullscreen }: BrowserPanelProps) {
  const [state, setState] = useState<BrowserStateView>(INACTIVE_STATE);
  const [tabs, setTabs] = useState<BrowserTabRow[]>([]);
  const [frame, setFrame] = useState<string | null>(null);
  const [frameSize, setFrameSize] = useState({ width: 0, height: 0 });
  const [urlDraft, setUrlDraft] = useState("");
  const [openDraft, setOpenDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [connected, setConnected] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const viewRef = useRef<HTMLDivElement | null>(null);
  const keyboardRef = useRef<HTMLTextAreaElement | null>(null);
  const composingRef = useRef(false);
  const watchingRef = useRef(false);
  const addressEditingRef = useRef(false);
  const inputQueueRef = useRef<Promise<unknown>>(Promise.resolve());

  // 先读取状态，再订阅帧流；这样用户切回"浏览器"页签时不会先看到旧的未启动状态。
  // IPC 推桥：watch 成功即 connected；组件卸载 / clientId 变化时 unwatch（对齐旧 SSE
  // 同键去重——main 侧注册表同一 (client, thread) 只保留一条订阅）。
  useEffect(() => {
    if (!clientId) return undefined;
    let stopped = false;
    let slot: { attach: (fn: () => void) => void; release: () => void } | null = null;
    let cancelWaiting: (() => void) | null = null;
    let unsubscribeEvents: (() => void) | null = null;
    let retryCount = 0;
    let retryTimer: number | null = null;

    const syncState = async () => {
      try {
        const result = await browserState(clientId, threadId || "");
        if (!stopped && result?.state) {
          setState((previous) => ({ ...previous, ...(result.state as BrowserStateView) }));
          const frameSizeValue = (result.state as BrowserStateView).frameSize;
          if (frameSizeValue) setFrameSize({ width: Number(frameSizeValue.width || 0), height: Number(frameSizeValue.height || 0) });
        }
      } catch {}
    };

    const handleStreamEvent = (type: string, data: Record<string, unknown>) => {
      if (type === "state") {
        setState((previous) => ({ ...previous, ...(data || {}) }));
        const frameSizeValue = (data as BrowserStateView | undefined)?.frameSize;
        if (frameSizeValue) setFrameSize({ width: Number(frameSizeValue.width || 0), height: Number(frameSizeValue.height || 0) });
      } else if (type === "tabs") {
        setTabs(Array.isArray((data as { tabs?: BrowserTabRow[] })?.tabs) ? (data as { tabs: BrowserTabRow[] }).tabs : []);
      } else if (type === "frame" && (data as { data?: string })?.data) {
        setFrame((data as { data: string }).data);
        const width = Number((data as { width?: unknown }).width);
        const height = Number((data as { height?: unknown }).height);
        if (width && height) setFrameSize({ width, height });
      } else if (type === "closed") {
        setFrame(null);
        setFrameSize({ width: 0, height: 0 });
        setTabs([]);
        setState((previous) => ({ ...previous, active: false, hasFrame: false }));
      }
    };

    const connect = () => {
      if (stopped) return;
      // 每次重挂都重发订阅：main 侧同键去重并重发初始 state/frame 快照（对齐旧 SSE
      // 连接建立序 L2243-2259），订阅回调只对本 (client, thread) 的帧生效。
      watchBrowserStream(clientId, threadId || "", true)
        .then(() => {
          if (stopped) return;
          watchingRef.current = true;
          retryCount = 0;
          setConnected(true);
          setBrowserStreamState("ok");
          // 帧预算回收时的关闭动作 = 断开订阅（等价旧 SSE slot.attach(() => source.close())）
          slot?.attach(() => {
            watchingRef.current = false;
            void unwatchBrowserStream(clientId, threadId || "");
          });
        })
        .catch(() => {
          if (stopped) return;
          setConnected(false);
          setBrowserStreamState("reconnecting"); // O-P8：向对话工具卡广播重连状态（对账提示用）
          // IPC 无同源连接池，但 main 侧浏览器会话可能暂不可用（如应用重启中），
          // 保留旧 SSE 的指数退避重试节奏，避免高频空转。
          const delay = Math.min(10000, 1000 * (2 ** Math.min(retryCount, 3)));
          retryCount += 1;
          retryTimer = window.setTimeout(connect, delay);
        });
      if (!unsubscribeEvents) {
        unsubscribeEvents = subscribeDesktopEvents((event) => {
          if (event.type !== BROWSER_STREAM_EVENT_TYPE) return;
          const data = (event.data || {}) as { client?: string; thread?: string; event?: string; payload?: Record<string, unknown> };
          if (data.client !== clientId || (data.thread || "") !== (threadId || "")) return;
          handleStreamEvent(String(data.event || ""), data.payload || {});
        });
      }
    };

    // 帧流是可放弃的长连接：此槽位不够时宁可不连（保持"等待连接"），
    // 也不能挤掉对话流/全局事件流，或把切工作区这类控制面请求堵死。
    const start = () => {
      if (stopped) return;
      slot = acquireStream("browser-frames", { priority: 3, label: "浏览器帧流" }) as typeof slot;
      if (!slot) {
        setConnected(false);
        cancelWaiting = waitForStreamSlot(() => {
          cancelWaiting = null;
          start();
        }) as typeof cancelWaiting;
        return;
      }
      connect();
    };

    void syncState();
    start();

    return () => {
      stopped = true;
      try { unsubscribeEvents?.(); } catch {}
      unsubscribeEvents = null;
      if (watchingRef.current) {
        watchingRef.current = false;
        void unwatchBrowserStream(clientId, threadId || "");
      }
      if (retryTimer) window.clearTimeout(retryTimer);
      cancelWaiting?.();
      try { slot?.release(); } catch {}
      setBrowserStreamState("idle");
    };
  }, [clientId, threadId]);

  // B3（OAW_BROWSER_ADAPTIVE_STREAM，默认关）：面板所在页面不可见时暂停推流，回可见即恢复。
  useEffect(() => {
    if (!clientId || !flag("browserAdaptiveStream")) return undefined;
    const notify = () => {
      browserStreamPause({ client: clientId, thread: threadId || "", paused: document.hidden }).catch(() => {});
    };
    document.addEventListener("visibilitychange", notify);
    return () => {
      document.removeEventListener("visibilitychange", notify);
      browserStreamPause({ client: clientId, thread: threadId || "", paused: false }).catch(() => {});
    };
  }, [clientId, threadId]);

  // 所有 CDP 输入都经过同一条队列，保证 down → move → up、滚轮和键盘不会乱序。
  const queueBrowserInput = useCallback((payload: Record<string, unknown>) => {
    const run = inputQueueRef.current
      .catch(() => {})
      .then(() => browserInput({ client: clientId, thread: threadId || "", ...payload }));
    inputQueueRef.current = run.catch(() => {});
    return run;
  }, [clientId, threadId]);

  useEffect(() => {
    if (!addressEditingRef.current) setUrlDraft(state.url || "");
  }, [state.url]);

  const send = useCallback(async (payload: Record<string, unknown>) => {
    setBusy(true);
    setMessage("");
    try {
      const result = await queueBrowserInput(payload) as { ok?: boolean; error?: string } | null;
      if (result?.ok === false) setMessage(result.error || "操作失败");
    } catch (error) {
      setMessage(String((error as Error).message || error));
    } finally {
      setBusy(false);
    }
  }, [queueBrowserInput]);

  const openUrl = useCallback(async (url: string) => {
    const target = String(url || "").trim();
    if (!target) return;
    setBusy(true);
    setMessage("");
    const applyState = (result: { state?: BrowserStateView }) => {
      if (result?.state) setState((previous) => ({ ...previous, ...result.state }));
      setOpenDraft(target);
      addressEditingRef.current = false;
      setUrlDraft(target);
    };
    try {
      const result = await browserOpen(clientId, threadId || "", target) as { ok?: boolean; state?: BrowserStateView; error?: string; code?: string };
      if (result?.ok === false) throw openError(result, "打开网页失败");
      applyState(result);
    } catch (error) {
      // 只在「已识别的启动/profile 锁异常」时重置浏览器（杀孤儿 + 清锁 + 重试一次）。
      // 普通导航失败、URL 无效、用户接管等情况必须保留当前标签与登录态，不能销毁会话。
      if (!isRecoverableBrowserError(error)) {
        setMessage(String((error as Error)?.message || error));
        return;
      }
      try {
        setMessage("正在修复浏览器环境…");
        await browserReset(clientId, threadId || "");
        const retry = await browserOpen(clientId, threadId || "", target) as { ok?: boolean; state?: BrowserStateView; error?: string; code?: string };
        if (retry?.ok === false) throw openError(retry, "打开网页失败");
        applyState(retry);
      } catch (retryError) {
        setMessage(String((retryError as Error)?.message || retryError || (error as Error)?.message || error));
      }
    } finally {
      setBusy(false);
    }
  }, [clientId, threadId]);

  // 归一化坐标：不受帧缩放与设备像素比影响，由服务端按真实视口换算
  const normalizedPoint = useCallback((event: { clientX: number; clientY: number }) => {
    const img = imgRef.current;
    if (!img) return null;
    const rect = img.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const sourceWidth = Number(frameSize.width) || Number(state.viewport?.width) || 1440;
    const sourceHeight = Number(frameSize.height) || Number(state.viewport?.height) || 900;
    const scale = Math.max(rect.width / sourceWidth, rect.height / sourceHeight);
    const renderedWidth = sourceWidth * scale;
    const renderedHeight = sourceHeight * scale;
    const cropX = Math.max(0, (renderedWidth - rect.width) / 2);
    const cropY = Math.max(0, (renderedHeight - rect.height) / 2);
    const localX = (event.clientX - rect.left) + cropX;
    const localY = (event.clientY - rect.top) + cropY;
    return {
      nx: Math.max(0, Math.min(1, localX / renderedWidth)),
      ny: Math.max(0, Math.min(1, localY / renderedHeight))
    };
  }, [frameSize.height, frameSize.width, state.viewport?.height, state.viewport?.width]);

  // 让 Chromium 的 CSS viewport 跟右侧栏同步，网页本身按真实面板宽度排版，
  // 避免把固定 1440×900 的截图硬塞进窄栏后再裁切/放大。
  useEffect(() => {
    const node = viewRef.current;
    if (!node || !state.active || typeof ResizeObserver === "undefined") return undefined;
    let timer: number | null = null;
    let last = "";
    const resize = () => {
      const rect = node.getBoundingClientRect();
      const width = Math.max(320, Math.floor(rect.width));
      const height = Math.max(240, Math.floor(rect.height));
      const signature = `${width}x${height}`;
      if (!width || !height || signature === last) return;
      last = signature;
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        queueBrowserInput({ action: "resize", width, height }).catch(() => {});
      }, 120);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    resize();
    return () => {
      observer.disconnect();
      if (timer) window.clearTimeout(timer);
    };
  }, [queueBrowserInput, state.active]);

  // 鼠标接管：按下 → 拖动 → 抬起（支持滑块验证码/画布/文本选择；单击即按下+抬起）
  const dragRef = useRef({ active: false, lastSentAt: 0 });
  const sendPointer = useCallback((phase: string, point: { nx: number; ny: number }) => {
    return queueBrowserInput({ action: "pointer", phase, nx: point.nx, ny: point.ny });
  }, [queueBrowserInput]);
  useEffect(() => {
    const img = imgRef.current;
    if (!img || !state.active) return undefined;
    const onDown = (event: MouseEvent) => {
      if (event.button !== 0) return;
      img.focus({ preventScroll: true });
      keyboardRef.current?.focus({ preventScroll: true });
      event.preventDefault();
      const point = normalizedPoint(event);
      if (!point) return;
      dragRef.current.active = true;
      dragRef.current.lastSentAt = Date.now();
      void sendPointer("down", point);
    };
    const onMove = (event: MouseEvent) => {
      if (!dragRef.current.active) return;
      const now = Date.now();
      if (now - dragRef.current.lastSentAt < 40) return; // 节流，避免刷屏
      const point = normalizedPoint(event);
      if (!point) return;
      dragRef.current.lastSentAt = now;
      void sendPointer("move", point);
    };
    const onUp = (event: MouseEvent) => {
      if (!dragRef.current.active) return;
      dragRef.current.active = false;
      const point = normalizedPoint(event);
      if (point) void sendPointer("up", point);
    };
    img.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      img.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      dragRef.current.active = false;
    };
    // 注意：不要把 frame 放进依赖。帧流每 ~100ms 更新一次，effect 会被反复重建并
    // 重置拖拽状态，导致 mouseup 发不出去（表现为点击无效、输入框拿不到焦点）。
  }, [Boolean(state.active), normalizedPoint, sendPointer]);

  // 滚轮接管：把面板滚轮转发为页面滚动（节流合并，避免刷屏）
  const wheelRef = useRef<{ deltaX: number; deltaY: number; timer: number | null; point: { nx: number; ny: number } | null }>({ deltaX: 0, deltaY: 0, timer: null, point: null });
  useEffect(() => {
    const img = imgRef.current;
    if (!img || !state.active) return undefined;
    const flush = () => {
      const pending = wheelRef.current;
      pending.timer = null;
      if (!pending.point || (!pending.deltaX && !pending.deltaY)) return;
      const { deltaX, deltaY, point } = pending;
      pending.deltaX = 0;
      pending.deltaY = 0;
      void queueBrowserInput({ action: "wheel", nx: point.nx, ny: point.ny, deltaX, deltaY }).catch(() => {});
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const point = normalizedPoint(event);
      if (!point) return;
      const pending = wheelRef.current;
      pending.point = point;
      pending.deltaX += event.deltaX;
      pending.deltaY += event.deltaY;
      if (!pending.timer) pending.timer = window.setTimeout(flush, 130);
    };
    img.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      img.removeEventListener("wheel", onWheel);
      if (wheelRef.current.timer) window.clearTimeout(wheelRef.current.timer);
    };
  }, [Boolean(state.active), normalizedPoint, queueBrowserInput]);

  // 键盘直输：点击画面后把本地键盘焦点交给不可见捕获层，再通过 CDP
  // Input.insertText/dispatchKeyEvent 转发到真实网页，支持中文输入法。
  const sendQuiet = useCallback((payload: Record<string, unknown>) => queueBrowserInput(payload), [queueBrowserInput]);
  const flushKeyboardText = useCallback((target: HTMLTextAreaElement) => {
    if (composingRef.current) return;
    const text = target.value;
    if (!text) return;
    target.value = "";
    void sendQuiet({ action: "type", text });
  }, [sendQuiet]);
  const handleKeyboardKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!state.active) return;
    const key = event.key;
    const specialKeys = ["Backspace", "Tab", "Enter", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", "Delete"];
    if (specialKeys.includes(key)) {
      event.preventDefault();
      void sendQuiet({ action: "key", key });
    }
  }, [Boolean(state.active), sendQuiet]);

  const handleClose = useCallback(async () => {
    setBusy(true);
    try {
      const result = await browserClose(clientId, threadId || "", { force: true }) as { closed?: boolean; message?: string };
      setFrame(null);
      setState((previous) => ({ ...previous, active: false }));
      setMessage(result?.closed ? "浏览器已关闭" : result?.message || "浏览器未关闭");
    } catch (error) {
      setMessage(String((error as Error).message || error));
    } finally {
      setBusy(false);
    }
  }, [clientId, threadId]);

  // 接管/交还都走服务端：前端不再只改本地布尔值，Agent 写操作由服务端仲裁。
  const ownership = state.ownership || { owner: "agent", secondsRemaining: 0 };
  const userOwns = ownership.owner === "user";
  // O-P6：接管倒计时本地逐秒递减（服务端 state 事件到达时以最新 leaseExpiresAt 重同步），
  // 修复"lease 空闲期间显示固定秒数"的不连贯观感。
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!userOwns || !ownership.leaseExpiresAt) return undefined;
    const timer = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [userOwns, ownership.leaseExpiresAt]);
  const secondsRemainingLocal = userOwns && ownership.leaseExpiresAt
    ? Math.max(0, Math.ceil((ownership.leaseExpiresAt - nowTick) / 1000))
    : (ownership.secondsRemaining || 0);

  // B4（OAW_BROWSER_FULLPAGE，默认关）：整页截图 / 整页 PDF —— 服务端 CDP 能力，前端触发下载。
  const downloadBase64 = (base64: string, filename: string, mime: string) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
  };
  const captureFullpage = useCallback(async () => {
    setBusy(true);
    setMessage("");
    try {
      const result = await browserFullpage({ client: clientId, thread: threadId || "" }) as { ok?: boolean; error?: string; base64?: string; file?: string };
      if (result?.ok === false) throw new Error(result.error || "整页截图失败");
      downloadBase64(String(result.base64 || ""), String(result.file || "shot-full.jpg").split(/[\\/]/).pop() || "shot-full.jpg", "image/jpeg");
      setMessage("整页截图已完成并下载（同时保留在 .oaw/browser-shots/）");
    } catch (error) {
      setMessage(String((error as Error).message || error));
    } finally {
      setBusy(false);
    }
  }, [clientId, threadId]);
  const exportPdf = useCallback(async () => {
    setBusy(true);
    setMessage("");
    try {
      const result = await browserPdf({ client: clientId, thread: threadId || "" }) as { ok?: boolean; error?: string; base64?: string; file?: string };
      if (result?.ok === false) throw new Error(result.error || "PDF 导出失败");
      downloadBase64(String(result.base64 || ""), String(result.file || "page.pdf").split(/[\\/]/).pop() || "page.pdf", "application/pdf");
      setMessage("整页 PDF 已导出并下载（同时保留在 .oaw/browser-shots/）");
    } catch (error) {
      setMessage(String((error as Error).message || error));
    } finally {
      setBusy(false);
    }
  }, [clientId, threadId]);

  const toggleOwnership = useCallback(async () => {
    const action = userOwns ? "release" : "takeover";
    setBusy(true);
    try {
      const response = await queueBrowserInput({ action, reason: action === "release" ? "用户交还" : "用户主动接管" }) as { result?: BrowserStateView; state?: BrowserStateView } | null;
      const nextState = response?.result || response?.state;
      if (nextState) setState((previous) => ({ ...previous, ...nextState }));
      setMessage(action === "release" ? "已交还 Agent，Agent 可以继续编排网页" : "已接管：Agent 写操作会暂停，点击画面即可操作网页");
    } catch (error) {
      setMessage(String((error as Error).message || error));
    } finally {
      setBusy(false);
    }
  }, [queueBrowserInput, userOwns]);

  const statusText = useMemo(() => {
    if (!state.active) return "未启动";
    if (state.loading) return "加载中…";
    return "运行中";
  }, [state.active, state.loading]);

  if (!state.active && !frame) {
    return (
      <div className="browser-panel browser-panel-idle">
        <div className="browser-idle-card">
          <div className="browser-idle-icon"><Icon name="globe" size={22} /></div>
          <div className="browser-idle-heading"><strong>Open Plan 浏览器</strong><span>Agent 与你共用的可视化网页空间</span></div>
          <p>Agent 打开网页后，画面会实时出现在这里。你可以直接点击、拖动、滚动、输入，接管登录、验证码或网页操作。</p>
          <form className="browser-idle-open" onSubmit={(event) => { event.preventDefault(); void openUrl(openDraft); }}>
            <Icon name="link" size={14} />
            <input value={openDraft} onChange={(event) => setOpenDraft(event.target.value)} placeholder="输入网址，例如 https://cn.bing.com" spellCheck={false} />
            <button type="submit" className="browser-primary-btn" disabled={busy || !openDraft.trim()}><Icon name="arrowRight" size={14} />打开</button>
          </form>
          <div className="browser-quick-links">
            <span>快速打开</span>
            <button type="button" onClick={() => void openUrl("https://cn.bing.com")} disabled={busy}>必应</button>
            <button type="button" onClick={() => void openUrl("https://www.baidu.com")} disabled={busy}>百度</button>
            <button type="button" onClick={() => void openUrl("https://example.com")} disabled={busy}>示例页</button>
          </div>
          <p className="browser-idle-hint">也可以直接对 Agent 说：<em>“打开浏览器，搜索浙江省综合交通规划 2026”</em></p>
          {message && <div className="browser-msg">{message}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="browser-panel">
      <div className="browser-tabs" role="tablist">
        {tabs.map((tab) => (
          <div
            key={String(tab.id)}
            role="tab"
            aria-selected={Boolean(tab.active)}
            className={`browser-tab ${tab.active ? "active" : ""}`}
            onClick={() => { if (!tab.active) void send({ action: "tab_switch", tabId: tab.id }); }}
            title={`${String(tab.url || tab.title || "")}`}
          >
            <span className="browser-tab-title">{String(tab.title || "新标签页")}</span>
            <button
              type="button"
              className="browser-tab-close"
              title="关闭标签页"
              onClick={(event) => { event.stopPropagation(); void send({ action: "tab_close", tabId: tab.id }); }}
            >✕</button>
          </div>
        ))}
        <button type="button" className="browser-tab-new" onClick={() => void send({ action: "tab_new", url: "about:blank" })} disabled={busy} title="新建标签页">＋</button>
      </div>
      <div className="browser-toolbar">
        <div className="browser-nav-actions">
          <button className="btn-icon" onClick={() => void send({ action: "back" })} disabled={busy} title="后退" aria-label="后退"><Icon name="back" size={14} /></button>
          <button className="btn-icon" onClick={() => void send({ action: "reload" })} disabled={busy} title="刷新页面" aria-label="刷新页面"><Icon name="refresh" size={14} /></button>
        </div>
        <form
          className="browser-url-form"
          onSubmit={(event) => { event.preventDefault(); if (urlDraft.trim()) void openUrl(urlDraft.trim()); }}
        >
          <Icon name="lock" size={12} />
          <input
            className="browser-url-input"
            value={urlDraft}
            onChange={(event) => setUrlDraft(event.target.value)}
            onFocus={() => { addressEditingRef.current = true; }}
            onBlur={() => { addressEditingRef.current = false; }}
            placeholder="输入网址或搜索内容后回车"
            spellCheck={false}
          />
        </form>
        <span className={`browser-status ${state.loading ? "loading" : state.active ? "active" : ""}`} title={state.error || "浏览器连接状态"}>
          <i /> {statusText}
        </span>
        <span className={`browser-connection ${connected ? "online" : "offline"}`}><i />{connected ? "同步中" : "重连中"}</span>
        <span className={`browser-takeover ${userOwns ? "is-user" : "is-agent"}`} title={userOwns ? `${ownership.reason || "你正在操作"}；Agent 写操作已暂停，交还或等待 ${secondsRemainingLocal}s 后自动恢复` : "Agent 可继续使用此浏览器"}>
          <i />{userOwns ? `你在操作${secondsRemainingLocal ? ` · ${secondsRemainingLocal}s` : ""}` : "Agent 可用"}
        </span>
        <button
          type="button"
          className={`browser-control-toggle ${userOwns ? "active" : ""}`}
          onClick={() => void toggleOwnership()}
          disabled={busy}
          title={userOwns ? "交还 Agent 继续操作（Agent 写操作恢复）" : "接管操作：Agent 写操作会暂停，避免与你抢焦点/误提交"}
        >
          <Icon name="cursor" size={12} />{userOwns ? "交还 Agent" : "接管操作"}
        </button>
        {flag("browserFullpage") && (
          <>
            <button type="button" className="btn-icon" onClick={() => void captureFullpage()} disabled={busy || !state.active} title="整页截图（长页面完整保存）" aria-label="整页截图"><Icon name="image" size={14} /></button>
            <button type="button" className="btn-icon" onClick={() => void exportPdf()} disabled={busy || !state.active} title="导出整页 PDF" aria-label="导出整页 PDF"><Icon name="download" size={14} /></button>
          </>
        )}
        <button
          type="button"
          className="browser-fullscreen-toggle"
          onClick={onToggleFullscreen}
          title={fullscreen ? "退出浏览器全屏" : "浏览器铺满工作区"}
          aria-label={fullscreen ? "退出浏览器全屏" : "浏览器铺满工作区"}
        >
          <Icon name={fullscreen ? "minimize" : "maximize"} size={14} />
        </button>
        <button className="btn-icon" onClick={() => void handleClose()} disabled={busy} title="关闭浏览器" aria-label="关闭浏览器"><Icon name="close" size={14} /></button>
      </div>
      {state.title && <div className="browser-title" title={state.title}>{state.title}</div>}
      <div ref={viewRef} className="browser-view" title="滚轮滚动 · 单击接管 · 按住拖动可操作滑块">
        <textarea
          ref={keyboardRef}
          className="browser-keyboard-capture"
          aria-label="网页键盘输入"
          tabIndex={-1}
          onInput={(event) => flushKeyboardText(event.currentTarget)}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            flushKeyboardText(event.currentTarget);
          }}
          onKeyDown={handleKeyboardKeyDown}
        />
        {frame ? (
          <img
            ref={imgRef}
            src={`data:image/jpeg;base64,${frame}`}
            alt="浏览器画面"
            draggable={false}
            style={frameSize.width && frameSize.height ? { aspectRatio: `${frameSize.width} / ${frameSize.height}` } : undefined}
          />
        ) : (
          <div className="browser-placeholder"><span>{state.loading ? "正在加载网页…" : "正在获取画面…"}</span><button className="btn-sm" onClick={() => void send({ action: "reload" })} disabled={busy}>重新连接</button></div>
        )}
      </div>
      <div className="browser-hint"><Icon name="cursor" size={12} /> {userOwns ? "你正在接管：Agent 写操作已暂停，点击「交还 Agent」后恢复" : "点击网页控件后直接键盘输入 · 滚轮滚动 · 按住拖动滑块/验证码 · 回车提交"}</div>
      {state.error && <div className="browser-msg">{state.error}</div>}
      {message && <div className="browser-msg">{message}</div>}
    </div>
  );
}
