/**
 * 内置浏览器（CDP 操作 + 帧流推流），逐行等价迁移自 server/builtin-browser.mjs。
 *
 * 观察方式与 Playwright MCP 一致：可访问性语义快照（编号元素），非像素识别。
 * 依赖：PROJECT_DIR（workspace.ts）、atomicWriteJson（persistence-utils.ts）、
 * loadNetworkSettings（agent/pi-config-management.ts）、RUNTIME_FLAGS（shared/runtime/feature-flags.ts）。
 * 节点侧 WebSocket 使用 Node 22 全局 WebSocket（undici）。
 */
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { PROJECT_DIR } from "./workspace";
import { loadNetworkSettings } from "./agent/pi-config-management";
import { RUNTIME_FLAGS } from "../../shared/runtime/feature-flags";

const PROFILE_DIR = process.env.OAW_BROWSER_PROFILE || path.join(PROJECT_DIR, ".oaw", "browser-profile");
const SHOT_DIR = path.join(PROJECT_DIR, ".oaw", "browser-shots");
const VIEWPORT = { width: 1440, height: 900 };
const MAX_CAPTURE = { width: 2400, height: 1600 };
const NAV_TIMEOUT_MS = 8000;
const NAV_SETTLE_MS = 2500;
const NAV_SETTLE_POLL_MS = 200;
const NAV_DOC_PROBE = "({ ready: document.readyState, origin: Number(performance.timeOrigin) || 0 })";
const NAV_CONTENT_PROBE = "(() => { const body = document.body; const text = body ? body.innerText : ''; return text.length + ':' + (body ? body.getElementsByTagName('*').length : 0); })()";
const FRAME_BROADCAST_INTERVAL_MS = 90;
const FRAME_QUALITY = Math.min(100, Math.max(40, Number(process.env.OAW_BROWSER_FRAME_QUALITY) || 70));
const FRAME_EVERY_NTH = Math.max(1, Number(process.env.OAW_BROWSER_FRAME_EVERY_NTH) || 2);
const FRAME_MAX_WIDTH = Math.max(640, Number(process.env.OAW_BROWSER_FRAME_MAX_WIDTH) || 1600);
const FRAME_MAX_HEIGHT = Math.max(480, Number(process.env.OAW_BROWSER_FRAME_MAX_HEIGHT) || 1000);
const MAX_FRAME_BYTES = Math.max(120_000, Number(process.env.OAW_BROWSER_FRAME_MAX_BYTES) || 900_000);
const SUBSCRIBER_WATCHDOG_MS = 1500;
const SCREENCAST_RETRY_MS = 4000;
const FIRST_FRAME_GRACE_MS = 1200;

const sessions = new Map<string, BrowserSession>();
const subscribers = new Map<string, Set<(type: string, data: any) => void>>();

export function browserSubscriberCount(key: string): number {
  const set = subscribers.get(key);
  return set ? set.size : 0;
}

const USER_TAKEOVER_LEASE_MS = Math.max(30_000, Number(process.env.OAW_BROWSER_USER_LEASE_MS) || 3 * 60 * 1000);

export const BROWSER_USER_ACTION_SET = new Set<string>([
  "click", "pointer", "wheel", "type", "key", "scroll", "navigate", "back", "reload", "tab_new", "tab_switch", "tab_close",
]);

export interface BrowserOwnership {
  owner: string;
  leaseExpiresAt: number;
  reason: string;
  updatedAt?: string;
}

export function normalizeBrowserOwnership(ownership: any, nowMs: number = Date.now()) {
  const owner = ownership?.owner === "user" ? "user" : "agent";
  const leaseExpiresAt = Number(ownership?.leaseExpiresAt) || 0;
  const reason = String(ownership?.reason || "");
  if (owner === "user" && leaseExpiresAt <= nowMs) {
    return { owner: "agent", leaseExpiresAt: 0, reason: "用户接管已超时，自动交还 Agent", expiredFrom: "user" };
  }
  return { owner, leaseExpiresAt, reason, expiredFrom: null as string | null };
}

export function browserAgentWriteBlocked(ownership: any, nowMs: number = Date.now()) {
  const current = normalizeBrowserOwnership(ownership, nowMs);
  if (current.owner !== "user") return null;
  const remainingMs = Math.max(0, current.leaseExpiresAt - nowMs);
  return {
    code: "BROWSER_USER_TAKEOVER",
    message: `浏览器正在由用户操作（约 ${Math.ceil(remainingMs / 1000)} 秒后自动交还），Agent 的写操作已暂停`,
    retryAfterMs: remainingMs,
  };
}

export function browserSessionKey(clientId: string, threadId: string): string {
  let client = String(clientId || "").trim();
  const thread = String(threadId || "").trim();
  if (thread && client.endsWith(`::${thread}`)) {
    client = client.slice(0, -(thread.length + 2));
  }
  return `${client}::${thread}`;
}

export function hasBrowserSession(key: string): boolean {
  const session = sessions.get(key);
  return Boolean(session && session.state.active);
}

export function subscribeBrowser(key: string, handler: (type: string, data: any) => void) {
  if (!subscribers.has(key)) subscribers.set(key, new Set());
  subscribers.get(key)!.add(handler);
  cleanupSubscribers();
  return () => {
    const set = subscribers.get(key);
    if (!set) return;
    set.delete(handler);
    if (!set.size) subscribers.delete(key);
  };
}

function cleanupSubscribers() {
  for (const [key, set] of subscribers.entries()) {
    if (!set.size) subscribers.delete(key);
  }
}

export function broadcast(key: string, type: string, data: any) {
  const set = subscribers.get(key);
  if (!set) return;
  for (const handler of set) {
    try { handler(type, data); } catch {}
  }
}

function findBrowserExecutable(): string | null {
  const candidates = [
    process.env.OAW_BROWSER_PATH,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    path.join(process.env.HOME || "", "Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
    path.join(process.env.HOME || "", "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    "/usr/bin/microsoft-edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter((item): item is string => Boolean(item));
  return candidates.find((item) => { try { return fs.existsSync(item); } catch { return false; } }) || null;
}

function sessionProfileDir(key: string): string {
  const token = Buffer.from(String(key || "default"), "utf8").toString("base64url").slice(0, 96) || "default";
  return path.join(PROFILE_DIR, "sessions", token);
}

function browserProxyArgs(): string[] {
  try {
    const settings = loadNetworkSettings();
    if (settings.mode !== "manual" || !settings.proxyUrl) return [];
    const args = [`--proxy-server=${settings.proxyUrl}`];
    const bypass = String(settings.noProxy || "")
      .split(/[;,\s]+/)
      .map((item) => item.trim())
      .filter(Boolean)
      .join(";");
    if (bypass) args.push(`--proxy-bypass-list=${bypass}`);
    return args;
  } catch {
    return [];
  }
}

function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function killBrowserProcessesForProfile(profileDir: string): Promise<number> {
  return new Promise((resolve) => {
    const target = path.resolve(profileDir);
    if (process.platform === "win32") {
      const escaped = target.replace(/'/g, "''");
      const script = [
        `$p='${escaped}';`,
        "$procs = Get-CimInstance Win32_Process -Filter \"Name='msedge.exe' or Name='chrome.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($p) };",
        "$n = 0;",
        "foreach ($proc in $procs) { try { Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue; $n++ } catch {} }",
        "Write-Output $n",
      ].join(" ");
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 20000 }, (error, stdout) => {
        resolve(Number(String(stdout || "").trim()) || 0);
      });
      return;
    }
    const pattern = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    execFile("pgrep", ["-f", pattern], { timeout: 8000 }, (error, stdout) => {
      const pids = String(stdout || "")
        .split(/\s+/)
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0 && value !== process.pid);
      if (!pids.length) return resolve(0);
      execFile("kill", ["-9", ...pids.map(String)], { timeout: 8000 }, () => resolve(pids.length));
    });
  });
}

function hasLiveProfileProcess(profileDir: string): Promise<boolean> {
  return new Promise((resolve) => {
    const target = path.resolve(profileDir);
    if (process.platform === "win32") {
      const escaped = target.replace(/'/g, "''");
      const script = `@(Get-CimInstance Win32_Process -Filter "Name='msedge.exe' or Name='chrome.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${escaped}') }).Count`;
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 15000 }, (error, stdout) => {
        resolve(Number(String(stdout || "").trim()) > 0);
      });
      return;
    }
    const pattern = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    execFile("pgrep", ["-f", pattern], { timeout: 8000 }, (error, stdout) => {
      const pids = String(stdout || "").split(/\s+/).map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0 && value !== process.pid);
      resolve(pids.length > 0);
    });
  });
}

function processCommandLine(pid: number): Promise<string> {
  return new Promise((resolve) => {
    const value = Number(pid);
    if (!Number.isFinite(value) || value <= 0) return resolve("");
    if (process.platform === "win32") {
      const script = `(Get-CimInstance Win32_Process -Filter "ProcessId=${value}").CommandLine`;
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 8000 }, (error, stdout) => resolve(String(stdout || "").trim()));
      return;
    }
    execFile("ps", ["-p", String(value), "-o", "command="], { timeout: 5000 }, (error, stdout) => resolve(String(stdout || "").trim()));
  });
}

function sandboxArgs(): string[] {
  const raw = String(process.env.OAW_BROWSER_NO_SANDBOX ?? "").trim().toLowerCase();
  if (!["1", "true", "yes", "on"].includes(raw)) return [];
  console.warn("[browser] ⚠ 已通过 OAW_BROWSER_NO_SANDBOX 关闭 Chromium 沙箱；仅限受控开发环境，不要在生产或浏览开放网页时使用。");
  return ["--no-sandbox", "--disable-setuid-sandbox"];
}

function readDevToolsActivePort(profileDir: string): { port: number; wsPath: string } | null {
  try {
    const raw = fs.readFileSync(path.join(profileDir, "DevToolsActivePort"), "utf8");
    const parts = String(raw).split(/\r?\n/);
    const port = Number(String(parts[0] || "").trim());
    if (!Number.isFinite(port) || port <= 0) return null;
    return { port, wsPath: String(parts[1] || "").trim() };
  } catch {
    return null;
  }
}

interface PortFileInfo { port: number; pid: number; profileDir: string; startedAt: string | null }

function readPortFile(portFile: string): PortFileInfo | null {
  try {
    const raw = String(fs.readFileSync(portFile, "utf8")).trim();
    if (!raw) return null;
    if (raw.startsWith("{")) {
      const parsed = JSON.parse(raw);
      const port = Number(parsed.port);
      if (!Number.isFinite(port) || port <= 0) return null;
      return { port, pid: Number(parsed.pid) || 0, profileDir: String(parsed.profileDir || ""), startedAt: parsed.startedAt || null };
    }
    const port = Number(raw);
    return Number.isFinite(port) && port > 0 ? { port, pid: 0, profileDir: "", startedAt: null } : null;
  } catch {
    return null;
  }
}

function writePortFile(portFile: string, info: PortFileInfo) {
  try { fs.writeFileSync(portFile, JSON.stringify(info)); } catch {}
}

export async function verifyCdpOwnership(args: { port: number; pid: number; profileDir: string }): Promise<{ ok: boolean; reason?: string; marker?: { port: number; wsPath: string } | null }> {
  if (!Number.isFinite(Number(args.port)) || Number(args.port) <= 0) return { ok: false, reason: "端口记录无效" };
  const marker = readDevToolsActivePort(args.profileDir);
  if (marker && Number(marker.port) !== Number(args.port)) return { ok: false, reason: `DevToolsActivePort(${marker.port}) 与端口记录(${args.port}) 不一致` };
  if (args.pid) {
    const cmdline = await processCommandLine(args.pid);
    if (!cmdline) return { ok: false, reason: `记录的进程 ${args.pid} 已不存在` };
    if (!cmdline.includes(path.resolve(args.profileDir))) return { ok: false, reason: `进程 ${args.pid} 的命令行不属于本 profile` };
    return { ok: true, marker };
  }
  if (marker) return { ok: true, marker };
  return { ok: false, reason: "既无 DevToolsActivePort 也无进程记录，无法确认 CDP 归属" };
}

function clearProfileLocks(profileDir: string): number {
  let cleared = 0;
  for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket", "lockfile"]) {
    const file = path.join(profileDir, name);
    try {
      if (fs.existsSync(file)) { fs.rmSync(file, { force: true, recursive: true }); cleared += 1; }
    } catch {}
  }
  return cleared;
}

export async function resetBrowserSession(key: string) {
  const session = getBrowserSession(key);
  const profileDir = session?.profileDir || sessionProfileDir(key);
  if (session) {
    try { await session.close(); } catch {}
  }
  const killed = await killBrowserProcessesForProfile(profileDir);
  const cleared = clearProfileLocks(profileDir);
  try { fs.rmSync(path.join(profileDir, ".oaw-devtools-port"), { force: true }); } catch {}
  return { profileDir, killed, cleared };
}

const SNAPSHOT_SCRIPT = `(() => {
  const SELECTOR = 'a,button,input,textarea,select,[role="button"],[role="link"],[role="textbox"],[role="searchbox"],[contenteditable="true"],[onclick]';
  const isVisible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  };
  document.querySelectorAll('[data-oaw-ref]').forEach((el) => el.removeAttribute('data-oaw-ref'));
  const lines = [];
  let counter = 0;
  for (const el of document.querySelectorAll(SELECTOR)) {
    if (counter >= 140) break;
    if (!isVisible(el)) continue;
    counter += 1;
    const ref = 'e' + counter;
    el.setAttribute('data-oaw-ref', ref);
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'button' ? 'button' : tag === 'input' ? (el.type || 'input') : tag);
    const isField = tag === 'input' || tag === 'textarea' || tag === 'select';
    const rawName = isField
      ? (el.value || el.getAttribute('aria-label') || el.placeholder || el.title || el.name || '')
      : (el.innerText || el.getAttribute('aria-label') || el.title || '');
    const name = String(rawName).replace(/\\s+/g, ' ').trim().slice(0, 90);
    let extra = '';
    if (tag === 'a' && el.href) extra = ' → ' + String(el.href).slice(0, 140);
    else if ((tag === 'input' || tag === 'textarea') && el.value) extra = ' 值:"' + String(el.value).slice(0, 40) + '"';
    lines.push('[' + ref + '] ' + role + ' "' + name + '"' + extra);
  }
  const bodyText = String(document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 5000);
  return { url: location.href, title: document.title, elements: lines, text: bodyText };
})()`;

// ---- CdpConnection ----

class CdpConnection {
  nextId = 1;
  pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  envelopes = new Map<number, number>();
  listeners = new Map<string, Set<(params: any) => void>>();
  closed = false;
  sessionId: string | null = null;
  ws: WebSocket;
  ready: Promise<void>;

  constructor(wsUrl: string) {
    this.ws = new WebSocket(wsUrl);
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP 连接超时")), 15000);
      this.ws.addEventListener("open", () => { clearTimeout(timer); resolve(); });
      this.ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP 连接失败")); });
    });
    this.ws.addEventListener("message", (event) => {
      let message: any = null;
      try { message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data)); } catch { return; }

      if (message.method === "Target.receivedMessageFromTarget") {
        if (message.params?.sessionId !== this.sessionId) return;
        try {
          const inner = JSON.parse(message.params.message || "{}");
          if (inner.id && this.pending.has(inner.id)) {
            const pending = this.pending.get(inner.id)!;
            this.pending.delete(inner.id);
            if (message.error || inner.error) pending.reject(new Error((message.error || inner.error).message || "CDP 命令失败"));
            else pending.resolve(inner.result || {});
            return;
          }
          if (inner.method) this.dispatchEvent(inner);
        } catch {}
        return;
      }

      if (message.id && this.envelopes.has(message.id)) {
        const innerId = this.envelopes.get(message.id)!;
        this.envelopes.delete(message.id);
        if (message.error && this.pending.has(innerId)) {
          const pending = this.pending.get(innerId)!;
          this.pending.delete(innerId);
          pending.reject(new Error(message.error.message || "CDP 命令失败"));
        }
        return;
      }

      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id)!;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message || "CDP 命令失败"));
        else pending.resolve(message.result || {});
        return;
      }
      this.dispatchEvent(message);
    });
    this.ws.addEventListener("close", () => {
      this.closed = true;
      for (const [id, pending] of this.pending.entries()) {
        pending.reject(new Error("浏览器连接已关闭"));
        this.pending.delete(id);
      }
      this.envelopes.clear();
    });
  }

  dispatchEvent(message: any) {
    if (!message?.method) return;
    const handlers = this.listeners.get(message.method);
    if (!handlers) return;
    for (const handler of handlers) { try { handler(message.params || {}); } catch {} }
  }

  send(method: string, params: Record<string, any> = {}, timeoutMs = 30000): Promise<any> {
    if (this.closed) return Promise.reject(new Error("浏览器连接已关闭"));
    const id = this.nextId++;
    const envelopeId = this.sessionId ? this.nextId++ : null;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          if (envelopeId != null) this.envelopes.delete(envelopeId);
          reject(new Error(`CDP 命令超时：${method}`));
        }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); if (envelopeId != null) this.envelopes.delete(envelopeId); reject(error); },
      });
      try {
        const message = this.sessionId
          ? { id: envelopeId, method: "Target.sendMessageToTarget", params: { sessionId: this.sessionId, message: JSON.stringify({ id, method, params }) } }
          : { id, method, params };
        if (this.sessionId) this.envelopes.set(envelopeId!, id);
        this.ws.send(JSON.stringify(message));
      } catch (error) {
        this.pending.delete(id);
        if (envelopeId != null) this.envelopes.delete(envelopeId);
        clearTimeout(timer);
        reject(error as Error);
      }
    });
  }

  on(method: string, handler: (params: any) => void) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method)!.add(handler);
  }

  close() {
    this.closed = true;
    try { this.ws.close(); } catch {}
  }
}

function normalizeNavUrl(raw: string): string {
  const value = String(raw || "").trim();
  if (!value) throw new Error("URL 不能为空");
  if (/^https?:\/\//i.test(value)) return value;
  if (/^[\w-]+(\.[\w-]+)+(\/|$)/.test(value)) return `https://${value}`;
  if (!/^[a-z][a-z\d+.-]*:/i.test(value)) {
    return `https://cn.bing.com/search?q=${encodeURIComponent(value)}`;
  }
  throw new Error(`无效的 URL：${value}（需 http/https 链接，或输入普通关键词搜索）`);
}

function assertUrlAllowed(url: string) {
  if (!RUNTIME_FLAGS.browserUrlGuard) return;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    const err: any = new Error(`URL 防护：无法解析 ${url}`);
    err.code = "URL_GUARD_REJECTED";
    throw err;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    const err: any = new Error(`URL 防护：已拦截非 http/https 链接（${parsed.protocol}//）`);
    err.code = "URL_GUARD_REJECTED";
    throw err;
  }
  const allowList = RUNTIME_FLAGS.browserUrlAllowlist as string[];
  if (allowList.length && !allowList.some((domain) => parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`))) {
    const err: any = new Error(`URL 防护：域名 ${parsed.hostname} 不在白名单内（OAW_BROWSER_URL_ALLOWLIST）`);
    err.code = "URL_GUARD_REJECTED";
    throw err;
  }
}

// ---- BrowserSession ----

export interface BrowserState {
  active: boolean;
  url: string;
  title: string;
  loading: boolean;
  viewport: { width: number; height: number };
  startedAt: string | null;
  error: string | null;
  processCount?: number;
}

export interface BrowserFrame { data: string; at: number; width: number; height: number }

export interface BrowserStateView {
  active: boolean;
  url: string;
  title: string;
  loading: boolean;
  viewport: { width: number; height: number };
  frameSize: { width: number | null; height: number | null } | null;
  error: string | null;
  hasFrame: boolean;
  ownership: any;
}

export interface NavigateResult {
  active: boolean;
  url: string;
  title: string;
  loading: boolean;
  viewport: { width: number; height: number };
  frameSize: { width: number | null; height: number | null } | null;
  error: string | null;
  hasFrame: boolean;
  ownership: any;
}

export interface SnapshotResult { url: string; title: string; elements: string[]; text: string }

export interface ClickResult { clicked: string; text: string; url: string }
export interface TypeResult { typed: string; chars: number; submitted: boolean }
export interface PressResult { pressed: string }
export interface ScreenshotResult { file: string; base64: string; bytes: number; url: string }
export interface CloseResult { closed: boolean; reason?: string; message?: string; kept?: boolean }
export interface TabsResult { tabs: Array<{ id: string; title: string; url: string; active: boolean }> }

class BrowserSession {
  key: string;
  profileDir: string;
  portFile: string;
  child: any = null;
  cdp: CdpConnection | null = null;
  port = 0;
  browserStderr = "";
  frame: BrowserFrame | null = null;
  pendingFrame: BrowserFrame | null = null;
  frameBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
  lastFrameAt = 0;
  capturing = false;
  screencastOn = false;
  screencastError = "";
  screencastStartedAt = 0;
  lastScreencastAttemptAt = 0;
  subscriberCount = 0;
  watchdogTimer: ReturnType<typeof setInterval> | null = null;
  firstFrameTimer: ReturnType<typeof setTimeout> | null = null;
  lastUserInputAt = 0;
  streamPausedByVisibility = false;
  ownership: BrowserOwnership;
  activeTargetId: string | null = null;
  tabs: Array<{ id: string; title: string; url: string; active: boolean }> = [];
  tabsTimer: ReturnType<typeof setTimeout> | null = null;
  lastTabsFingerprint = "";
  state: BrowserState;

  constructor(key: string) {
    this.key = key;
    this.profileDir = sessionProfileDir(key);
    this.portFile = path.join(this.profileDir, ".oaw-devtools-port");
    this.ownership = { owner: "agent", leaseExpiresAt: 0, reason: "", updatedAt: new Date().toISOString() };
    this.state = { active: false, url: "about:blank", title: "", loading: false, viewport: { ...VIEWPORT }, startedAt: null, error: null };
  }

  queueFrameBroadcast(frame: BrowserFrame) {
    if (!frame?.data) return;
    if (frame.data.length > MAX_FRAME_BYTES) return;
    this.pendingFrame = frame;
    if (this.frameBroadcastTimer) return;
    this.frameBroadcastTimer = setTimeout(() => {
      this.frameBroadcastTimer = null;
      const next = this.pendingFrame;
      this.pendingFrame = null;
      if (next) broadcast(this.key, "frame", next);
    }, FRAME_BROADCAST_INTERVAL_MS);
  }

  clearFrameBroadcast() {
    if (this.frameBroadcastTimer) clearTimeout(this.frameBroadcastTimer);
    this.frameBroadcastTimer = null;
    this.pendingFrame = null;
  }

  async startScreencast(): Promise<boolean> {
    if (!this.cdp || !this.state.active) return false;
    this.lastScreencastAttemptAt = Date.now();
    try { await this.cdp.send("Page.stopScreencast"); } catch {}
    try {
      await this.cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: FRAME_QUALITY,
        maxWidth: FRAME_MAX_WIDTH,
        maxHeight: FRAME_MAX_HEIGHT,
        everyNthFrame: FRAME_EVERY_NTH,
        maxFramesInFlight: 2,
      });
      this.screencastOn = true;
      this.screencastStartedAt = Date.now();
      this.screencastError = "";
      if (typeof this.state.error === "string" && this.state.error.startsWith("画面推流启动失败")) this.state.error = null;
      if (this.firstFrameTimer) clearTimeout(this.firstFrameTimer);
      this.firstFrameTimer = setTimeout(() => {
        this.firstFrameTimer = null;
        if (this.state.active && (this.lastFrameAt || 0) < this.screencastStartedAt) this.captureFrame().catch(() => {});
      }, FIRST_FRAME_GRACE_MS);
      return true;
    } catch (error) {
      this.screencastOn = false;
      this.screencastError = String((error as any)?.message || (error as any)).slice(0, 200);
      this.state.error = `画面推流启动失败，已改用定时截图兜底：${this.screencastError}`;
      this.emitState();
      return false;
    }
  }

  async stopScreencast() {
    this.screencastOn = false;
    if (this.firstFrameTimer) { clearTimeout(this.firstFrameTimer); this.firstFrameTimer = null; }
    if (!this.cdp) return;
    try { await this.cdp.send("Page.stopScreencast"); } catch {}
  }

  async captureFrame(): Promise<BrowserFrame | null> {
    if (!this.cdp || !this.state.active || this.capturing) return null;
    this.capturing = true;
    try {
      const result = await this.cdp.send("Page.captureScreenshot", { format: "jpeg", quality: FRAME_QUALITY });
      const data = result?.data || "";
      if (!data) return null;
      this.lastFrameAt = Date.now();
      this.frame = { data, at: this.lastFrameAt, width: this.state.viewport.width, height: this.state.viewport.height };
      this.queueFrameBroadcast({ data, at: this.frame.at, width: this.frame.width, height: this.frame.height });
      return this.frame;
    } catch {
      return null;
    } finally {
      this.capturing = false;
    }
  }

  async noteSubscribers(count: number) {
    this.subscriberCount = Number(count) || 0;
    if (this.subscriberCount > 0) {
      this.ensureWatching();
      if (!this.screencastOn && !this.streamPausedByVisibility) this.startScreencast().catch(() => {});
      if (!this.frame) this.captureFrame().catch(() => {});
      return;
    }
    this.stopWatching();
    await this.stopScreencast();
  }

  async setStreamPaused(paused: boolean) {
    const wantPaused = Boolean(paused) && RUNTIME_FLAGS.browserAdaptiveStream;
    if (this.streamPausedByVisibility === wantPaused) return;
    this.streamPausedByVisibility = wantPaused;
    if (wantPaused) {
      await this.stopScreencast();
      return;
    }
    if (this.subscriberCount > 0 && !this.screencastOn) await this.startScreencast().catch(() => {});
  }

  ensureWatching() {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => {
      if (!this.state.active || this.subscriberCount <= 0) return;
      const now = Date.now();
      if (!this.frame) {
        if (!this.screencastOn && !this.streamPausedByVisibility && now - this.lastScreencastAttemptAt > SCREENCAST_RETRY_MS) this.startScreencast().catch(() => {});
        this.captureFrame().catch(() => {});
        return;
      }
      if (!this.screencastOn && !this.streamPausedByVisibility && now - this.lastScreencastAttemptAt > SCREENCAST_RETRY_MS) this.startScreencast().catch(() => {});
    }, SUBSCRIBER_WATCHDOG_MS);
  }

  stopWatching() {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
    if (this.firstFrameTimer) clearTimeout(this.firstFrameTimer);
    this.firstFrameTimer = null;
  }

  ownershipView() {
    const current = normalizeBrowserOwnership(this.ownership);
    return {
      owner: current.owner,
      reason: current.reason || "",
      leaseExpiresAt: current.leaseExpiresAt || 0,
      secondsRemaining: current.owner === "user" ? Math.max(0, Math.ceil((current.leaseExpiresAt - Date.now()) / 1000)) : 0,
      expiredFrom: current.expiredFrom || null,
    };
  }

  takeover(reason: string = "用户接管"): NavigateResult {
    this.ownership = { owner: "user", leaseExpiresAt: Date.now() + USER_TAKEOVER_LEASE_MS, reason: String(reason || "用户接管"), updatedAt: new Date().toISOString() };
    this.lastUserInputAt = Date.now();
    this.emitState();
    return this.stateView();
  }

  markUserActivity(action: string) {
    const value = String(action || "");
    if (!BROWSER_USER_ACTION_SET.has(value)) return;
    this.takeover(`用户正在操作（${value}）`);
  }

  releaseToAgent(reason: string = "用户交还"): NavigateResult {
    this.ownership = { owner: "agent", leaseExpiresAt: 0, reason: String(reason || "用户交还"), updatedAt: new Date().toISOString() };
    this.emitState();
    return this.stateView();
  }

  assertAgentWrite(action: string = "") {
    const blocked = browserAgentWriteBlocked(this.ownership, Date.now());
    if (!blocked) return;
    const error: any = new Error(blocked.message);
    error.code = blocked.code;
    error.retryAfterMs = blocked.retryAfterMs;
    error.action = String(action || "");
    throw error;
  }

  async fetchTargets(): Promise<any[]> {
    if (!this.port) return [];
    try {
      const response = await fetch(`http://127.0.0.1:${this.port}/json/list`, { signal: AbortSignal.timeout(2500) });
      const list = await response.json();
      return list.filter((item: any) => item.type === "page") || [];
    } catch {
      return [];
    }
  }

  async refreshTabs() {
    const targets = await this.fetchTargets();
    const tabs = targets.map((item: any) => ({
      id: item.id,
      title: String(item.title || "").trim() || String(item.url || "").replace(/^https?:\/\//, "").slice(0, 40) || "新标签页",
      url: item.url || "",
      active: item.id === this.activeTargetId,
    }));
    const fingerprint = JSON.stringify(tabs);
    if (fingerprint !== this.lastTabsFingerprint) {
      this.lastTabsFingerprint = fingerprint;
      this.tabs = tabs;
      broadcast(this.key, "tabs", { tabs, activeId: this.activeTargetId });
    }
    return tabs;
  }

  scheduleTabsRefresh(delay = 400) {
    if (this.tabsTimer) clearTimeout(this.tabsTimer);
    this.tabsTimer = setTimeout(() => {
      this.tabsTimer = null;
      this.refreshTabs().catch(() => {});
    }, delay);
  }

  async newTab(url: string = "about:blank"): Promise<{ tabId: string; url: string }> {
    await this.ensureStarted();
    const target = String(url || "").trim() === "about:blank" ? "about:blank" : normalizeNavUrl(url);
    const endpoint = `http://127.0.0.1:${this.port}/json/new?${encodeURIComponent(target)}`;
    let created: any = null;
    try {
      const response = await fetch(endpoint, { method: "PUT", signal: AbortSignal.timeout(5000) });
      created = await response.json();
    } catch {
      try {
        const response = await fetch(endpoint, { signal: AbortSignal.timeout(5000) });
        created = await response.json();
      } catch {}
    }
    const targets = await this.fetchTargets();
    const targetInfo = (created?.id && targets.find((item: any) => item.id === created.id)) || targets[targets.length - 1] || null;
    if (!targetInfo) throw new Error("新建标签页失败");
    await this.switchToTarget(targetInfo.id);
    return { tabId: targetInfo.id, url: targetInfo.url };
  }

  async switchToTarget(targetId: string): Promise<NavigateResult> {
    const targets = await this.fetchTargets();
    const target = targets.find((item: any) => item.id === targetId);
    if (!target) throw new Error("标签页不存在或已关闭");
    try { await fetch(`http://127.0.0.1:${this.port}/json/activate/${targetId}`, { signal: AbortSignal.timeout(3000) }); } catch {}
    try { this.cdp?.close(); } catch {}
    this.cdp = null;
    this.clearFrameBroadcast();
    this.frame = null;
    await this.connectToTarget(target);
    this.activeTargetId = targetId;
    this.state.url = target.url || this.state.url;
    this.state.title = target.title || this.state.title;
    this.state.loading = false;
    this.emitState();
    this.scheduleTabsRefresh(80);
    return this.stateView();
  }

  async closeTab(targetId: string): Promise<{ closed: string }> {
    const targets = await this.fetchTargets();
    if (targets.length <= 1) throw new Error("至少保留一个标签页");
    await fetch(`http://127.0.0.1:${this.port}/json/close/${targetId}`, { signal: AbortSignal.timeout(3000) }).catch(() => {});
    await sleep(400);
    if (targetId === this.activeTargetId) {
      const remaining = await this.fetchTargets();
      const next = remaining[remaining.length - 1];
      if (next) await this.switchToTarget(next.id);
    } else {
      this.scheduleTabsRefresh(100);
    }
    return { closed: targetId };
  }

  async reload(): Promise<{ reloaded: boolean; url: string }> {
    await this.ensureStarted();
    await sleep(500);
    return { reloaded: true, url: this.state.url };
  }

  async resolvePoint(payload: any = {}): Promise<{ x: number; y: number }> {
    await this.ensureStarted();
    let clientWidth = VIEWPORT.width;
    let clientHeight = VIEWPORT.height;
    try {
      const metrics = await this.cdp!.send("Page.getLayoutMetrics");
      const viewport = metrics.cssLayoutViewport || {};
      if (viewport.clientWidth) clientWidth = Number(viewport.clientWidth);
      if (viewport.clientHeight) clientHeight = Number(viewport.clientHeight);
    } catch {}
    const nx = Number(payload.nx);
    const ny = Number(payload.ny);
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      return {
        x: Math.round(Math.max(0, Math.min(1, nx)) * clientWidth),
        y: Math.round(Math.max(0, Math.min(1, ny)) * clientHeight),
      };
    }
    const x = Number(payload.x);
    const y = Number(payload.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("无效的点击坐标");
    return { x: Math.round(x), y: Math.round(y) };
  }

  async resize(width: number, height: number): Promise<NavigateResult> {
    await this.ensureStarted();
    const next = {
      width: Math.max(320, Math.min(MAX_CAPTURE.width, Math.round(Number(width) || VIEWPORT.width))),
      height: Math.max(240, Math.min(MAX_CAPTURE.height, Math.round(Number(height) || VIEWPORT.height))),
    };
    const previous = this.state.viewport || VIEWPORT;
    if (previous.width === next.width && previous.height === next.height) return this.stateView();
    await this.cdp!.send("Emulation.setDeviceMetricsOverride", {
      width: next.width,
      height: next.height,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: next.width,
      screenHeight: next.height,
    });
    this.state.viewport = next;
    try {
      const result = await this.cdp!.send("Page.captureScreenshot", { format: "jpeg", quality: 90 });
      const data = result.data || "";
      if (data) {
        this.frame = { data, at: Date.now(), width: next.width, height: next.height };
        this.queueFrameBroadcast({ data, at: this.frame.at, width: this.frame.width, height: this.frame.height });
      }
    } catch {}
    this.emitState();
    return this.stateView();
  }

  stateView(): NavigateResult {
    return {
      active: this.state.active,
      url: this.state.url,
      title: this.state.title,
      loading: this.state.loading,
      viewport: this.state.viewport,
      frameSize: this.frame ? { width: this.frame.width || null, height: this.frame.height || null } : null,
      error: this.state.error,
      hasFrame: Boolean(this.frame),
      ownership: this.ownershipView(),
    };
  }

  emitState() {
    broadcast(this.key, "state", this.stateView());
  }

  async probeAlive(): Promise<boolean> {
    if (!this.state.active) return false;
    try {
      if (this.cdp) {
        await Promise.race([
          this.cdp.send("Browser.getVersion"),
          new Promise((_, reject) => { setTimeout(() => reject(new Error("probe timeout")), 2500); }),
        ]);
        return true;
      }
      if (this.port) {
        const response = await fetch(`http://127.0.0.1:${this.port}/json/version`, { signal: AbortSignal.timeout(1500) });
        if (response.ok) return true;
      }
    } catch {}
    return false;
  }

  async start() {
    if (this.state.active && await this.probeAlive()) return;
    if (this.state.active) {
      try { this.cdp?.close(); } catch {}
      this.cdp = null;
      this.state.active = false;
      this.frame = null;
      try { fs.rmSync(this.portFile, { force: true }); } catch {}
      clearProfileLocks(this.profileDir);
      this.emitState();
    }
    const executable = findBrowserExecutable();
    if (!executable) { const error: any = new Error("未找到 Edge/Chrome，无法启动内置浏览器（可设置环境变量 OAW_BROWSER_PATH 指定浏览器路径）"); error.code = "BROWSER_NOT_FOUND"; throw error; }
    fs.mkdirSync(this.profileDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(this.profileDir, 0o700); } catch {}
    if (await this.tryReuse()) return;

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) {
        const killed = await killBrowserProcessesForProfile(this.profileDir);
        const cleared = clearProfileLocks(this.profileDir);
        console.warn(`[browser] 启动失败后清理 profile 占用：进程 ${killed} 个、锁文件 ${cleared} 个`);
      } else if (!(await hasLiveProfileProcess(this.profileDir))) {
        clearProfileLocks(this.profileDir);
      }
      try {
        await this.launch(executable);
        return;
      } catch (error) {
        lastError = error as Error;
        await this.close().catch(() => {});
      }
    }
    if (lastError && !(lastError as any).code) (lastError as any).code = "BROWSER_LAUNCH_FAILED";
    throw lastError || Object.assign(new Error("浏览器启动失败"), { code: "BROWSER_LAUNCH_FAILED" });
  }

  async launch(executable: string) {
    this.port = await allocatePort();
    const headless = process.env.OAW_BROWSER_HEADLESS !== "0";
    const args = [
      `--remote-debugging-port=${this.port}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${this.profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-sync",
      "--disable-gpu",
      "--in-process-gpu",
      ...sandboxArgs(),
      "--disable-extensions",
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      "about:blank",
    ];
    args.splice(args.length - 1, 0, ...browserProxyArgs());
    if (headless) args.unshift("--headless=new");
    this.browserStderr = "";
    this.child = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    this.child.stderr?.on("data", (chunk: any) => {
      this.browserStderr = `${this.browserStderr}${String(chunk)}`.slice(-4000);
    });
    this.child.on("exit", () => {
      if (this.state.active) {
        this.state.active = false;
        this.emitState();
      }
    });

    let target: any = null;
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/json/list`, { signal: AbortSignal.timeout(2000) });
        const list = await response.json();
        target = list.find((item: any) => item.type === "page") || null;
        if (target?.webSocketDebuggerUrl) break;
      } catch {}
      await sleep(300);
    }
    if (!target?.webSocketDebuggerUrl) {
      const exited = this.child?.exitCode;
      const detail = this.browserStderr.trim().replace(/\s+/g, " ");
      const hints: string[] = [];
      if (exited === 21) hints.push("用户数据目录被其他浏览器进程占用（已尝试清理 profile 锁与孤儿进程）");
      if (/sandbox/i.test(detail)) {
        hints.push(
          process.platform === "darwin"
            ? "疑似沙箱启动失败：请确认浏览器来自官方渠道且未被隔离（可尝试 xattr -dr com.apple.quarantine），不要直接关闭沙箱"
            : "疑似沙箱启动失败：优先使用官方浏览器；仅在受控开发环境才考虑 OAW_BROWSER_NO_SANDBOX=1（会降低安全性）",
        );
      }
      if (process.platform === "win32") hints.push("Windows 可检查是否有残留 msedge/chrome 进程占用该 profile");
      if (process.platform === "darwin") hints.push("macOS 可用 OAW_BROWSER_PATH 指定 Edge/Chrome 路径");
      const hintText = hints.length ? `。诊断建议：${hints.join("；")}` : "";
      const launchError: any = new Error(`浏览器启动失败：CDP 端点不可用${exited !== null && exited !== undefined ? `（进程退出码 ${exited}）` : "（进程仍在运行但未监听调试端口）"}${hintText}${detail ? `。原始输出：${detail.slice(0, 800)}` : ""}`);
      launchError.code = exited === 21 ? "BROWSER_LAUNCH_FAILED" : "BROWSER_CDP_UNAVAILABLE";
      throw launchError;
    }
    const marker = readDevToolsActivePort(this.profileDir);
    if (marker && Number(marker.port) !== Number(this.port)) {
      const ownershipError: any = new Error(`浏览器启动异常：DevToolsActivePort(${marker.port}) 与分配端口(${this.port}) 不一致，已拒绝接入以避免连到非本会话的浏览器`);
      ownershipError.code = "BROWSER_OWNERSHIP_MISMATCH";
      throw ownershipError;
    }
    if (!marker) console.warn("[browser] profile 内未生成 DevToolsActivePort，跳过启动期标记校验（复用时会用进程归属二次校验）");
    writePortFile(this.portFile, { port: this.port, pid: Number(this.child?.pid) || 0, profileDir: this.profileDir, startedAt: new Date().toISOString() });
    await this.connectToTarget(target);
    try { fs.chmodSync(this.profileDir, 0o700); } catch {}
  }

  async tryReuse(): Promise<boolean> {
    if (!fs.existsSync(this.portFile)) return false;
    const record = readPortFile(this.portFile);
    const discard = async (reason: string | undefined, cleanLocks = true): Promise<boolean> => {
      if (reason) console.warn(`[browser] 不复用旧实例：${reason}`);
      try { fs.rmSync(this.portFile, { force: true }); } catch {}
      if (cleanLocks && !(await hasLiveProfileProcess(this.profileDir))) clearProfileLocks(this.profileDir);
      return false;
    };
    if (!record) return discard("端口文件无效");
    const ownership = await verifyCdpOwnership({ port: record.port, pid: record.pid, profileDir: this.profileDir });
    if (!ownership.ok) return discard(ownership.reason);
    try {
      const response = await fetch(`http://127.0.0.1:${record.port}/json/list`, { signal: AbortSignal.timeout(1500) });
      const list = await response.json();
      const target = list.find((item: any) => item.type === "page") || null;
      if (!target?.webSocketDebuggerUrl) return discard("CDP 未返回可用标签页", false);
      this.port = record.port;
      this.child = null;
      await this.connectToTarget(target);
      return true;
    } catch (error) {
      return discard(`CDP 不可达：${String((error as any)?.message || (error as any)).slice(0, 120)}`);
    }
  }

  async connectToTarget(target: any) {
    let version: any = null;
    try {
      const response = await fetch(`http://127.0.0.1:${this.port}/json/version`, { signal: AbortSignal.timeout(2500) });
      version = await response.json();
    } catch {}
    const browserWs = version?.webSocketDebuggerUrl;
    if (!browserWs) throw new Error("浏览器 CDP 端点缺少浏览器级 websocket");
    this.cdp = new CdpConnection(browserWs);
    await this.cdp.ready;
    const attached = await this.cdp.send("Target.attachToTarget", { targetId: target.id, flatten: false });
    if (!attached?.sessionId) throw new Error("浏览器 CDP 未能 attach 当前标签页");
    this.cdp.sessionId = attached.sessionId;
    await this.cdp.send("Page.enable");
    await this.cdp.send("Runtime.enable");
    this.cdp.on("Page.screencastFrame", (params: any) => {
      this.lastFrameAt = Date.now();
      this.frame = {
        data: params.data,
        at: this.lastFrameAt,
        width: this.state.viewport.width,
        height: this.state.viewport.height,
      };
      this.queueFrameBroadcast({ data: params.data, at: this.frame.at, width: this.frame.width, height: this.frame.height });
      this.cdp!.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
    });
    this.cdp.on("Page.frameNavigated", (params: any) => {
      const frame = params?.frame;
      if (!frame || frame.parentId) return;
      this.state.url = frame.url || this.state.url;
      if (frame.name) this.state.title = frame.name;
      this.emitState();
    });
    this.cdp.on("Page.loadEventFired", () => {
      this.state.loading = false;
      this.refreshTitle().catch(() => {});
      this.emitState();
      this.scheduleTabsRefresh();
      this.captureFrame().catch(() => {});
    });
    await this.startScreencast();
    if (target.id) this.activeTargetId = target.id;
    this.state.active = true;
    this.state.startedAt = this.state.startedAt || new Date().toISOString();
    this.state.error = null;
    this.emitState();
    this.scheduleTabsRefresh(100);
  }

  async ensureStarted() {
    if (this.state.active && await this.probeAlive()) return;
    await this.start();
  }

  async evaluate(expression: string): Promise<any> {
    await this.ensureStarted();
    const result = await this.cdp!.send("Runtime.evaluate", { expression, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "页面脚本执行失败");
    return result.result?.value;
  }

  async refreshTitle() {
    const value = await this.evaluate("({ url: location.href, title: document.title })");
    if (value && typeof value === "object") {
      if (value.url) this.state.url = value.url;
      if (value.title) this.state.title = value.title;
    }
  }

  async waitForLoad(timeoutMs: number = NAV_TIMEOUT_MS, { previousOrigin = 0, settleMs = NAV_SETTLE_MS, sameDocumentGraceMs = 0 }: { previousOrigin?: number; settleMs?: number; sameDocumentGraceMs?: number } = {}): Promise<boolean> {
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    const grace = Math.max(0, Number(sameDocumentGraceMs) || 0);
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const probe = await this.evaluate(NAV_DOC_PROBE);
        if (probe?.ready === "complete") {
          const navigated = !previousOrigin || probe.origin !== previousOrigin;
          if (navigated || Date.now() - startedAt >= grace) {
            ready = true;
            break;
          }
        }
      } catch {}
      await sleep(150);
    }
    if (!ready) return false;
    const budget = Math.max(0, Math.min(Number(settleMs) || 0, deadline - Date.now()));
    const settleDeadline = Date.now() + budget;
    let previous = "";
    while (Date.now() < settleDeadline) {
      let metric = "";
      try { metric = String(await this.evaluate(NAV_CONTENT_PROBE) || ""); } catch {}
      if (metric && metric === previous) return true;
      previous = metric;
      await sleep(NAV_SETTLE_POLL_MS);
    }
    return true;
  }

  async navigate(rawUrl: string): Promise<NavigateResult> {
    const url = normalizeNavUrl(rawUrl);
    assertUrlAllowed(url);
    await this.ensureStarted();
    this.state.loading = true;
    this.state.url = url;
    this.emitState();
    const before: any = await this.evaluate("({ origin: Number(performance.timeOrigin) || 0, href: location.href })").catch(() => null);
    const stripHash = (value: string) => String(value || "").split("#")[0]!.replace(/\/+$/, "");
    const sameDocument = stripHash(before?.href) === stripHash(url);
    await this.cdp!.send("Page.navigate", { url });
    await this.waitForLoad(NAV_TIMEOUT_MS, { previousOrigin: sameDocument ? 0 : Number(before?.origin || 0) });
    this.state.loading = false;
    if (this.state.error && this.state.error.startsWith("页面加载超时")) this.state.error = null;
    await this.refreshTitle().catch(() => {});
    this.emitState();
    this.scheduleTabsRefresh();
    return this.stateView();
  }

  async snapshot(): Promise<SnapshotResult> {
    const value = await this.evaluate(SNAPSHOT_SCRIPT);
    if (value?.url) this.state.url = value.url;
    if (value?.title) this.state.title = value.title;
    this.emitState();
    return value || { url: this.state.url, title: this.state.title, elements: [], text: "" };
  }

  async click(ref: string): Promise<ClickResult> {
    const safe = String(ref || "").trim();
    if (!/^e\d+$/.test(safe)) throw new Error(`无效的元素编号：${ref}（请先 browser_snapshot 获取）`);
    const box: any = await this.evaluate(`(() => {
      const el = document.querySelector('[data-oaw-ref="${safe}"]');
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, text: String(el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 80) };
    })()`);
    if (!box) throw new Error(`页面上没有编号 ${safe} 的元素，请重新 browser_snapshot`);
    const point = { x: Math.round(box.x), y: Math.round(box.y) };
    const previousOrigin = Number(await this.evaluate("Number(performance.timeOrigin) || 0").catch(() => 0)) || 0;
    await this.cdp!.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none", clickCount: 0 });
    await this.cdp!.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
    await this.cdp!.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
    await sleep(600);
    await this.waitForLoad(8000, { previousOrigin, settleMs: 1200, sameDocumentGraceMs: 800 }).catch(() => {});
    await this.refreshTitle().catch(() => {});
    this.emitState();
    return { clicked: safe, text: box.text, url: this.state.url };
  }

  async type(ref: string, text: string, { submit = false }: { submit?: boolean } = {}): Promise<TypeResult> {
    const safe = String(ref || "").trim();
    if (!/^e\d+$/.test(safe)) throw new Error(`无效的元素编号：${ref}（请先 browser_snapshot 获取）`);
    const focused = await this.evaluate(`(() => {
      const el = document.querySelector('[data-oaw-ref="${safe}"]');
      if (!el) return false;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.focus();
      if (el.isContentEditable) { el.textContent = ''; } else { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
      return true;
    })()`);
    if (!focused) throw new Error(`页面上没有编号 ${safe} 的元素，请重新 browser_snapshot`);
    await this.cdp!.send("Input.insertText", { text: String(text ?? "") });
    if (submit) {
      await this.press("Enter");
    } else {
      await sleep(200);
    }
    return { typed: safe, chars: String(text ?? "").length, submitted: Boolean(submit) };
  }

  async press(key: string): Promise<PressResult> {
    const keyName = String(key || "Enter").trim() || "Enter";
    const map: Record<string, { code: string; keyCode: number; text: string }> = {
      Enter: { code: "Enter", keyCode: 13, text: "\r" },
      Tab: { code: "Tab", keyCode: 9, text: "\t" },
      Escape: { code: "Escape", keyCode: 27, text: "" },
      Backspace: { code: "Backspace", keyCode: 8, text: "" },
      ArrowDown: { code: "ArrowDown", keyCode: 40, text: "" },
      ArrowUp: { code: "ArrowUp", keyCode: 38, text: "" },
      PageDown: { code: "PageDown", keyCode: 34, text: "" },
      PageUp: { code: "PageUp", keyCode: 33, text: "" },
    };
    const info = map[keyName] || map.Enter!;
    await this.ensureStarted();
    const previousOrigin = Number(await this.evaluate("Number(performance.timeOrigin) || 0").catch(() => 0)) || 0;
    const base = { key: keyName, code: info.code, windowsVirtualKeyCode: info.keyCode, nativeVirtualKeyCode: info.keyCode };
    const down = info.text ? { ...base, text: info.text, unmodifiedText: info.text } : base;
    await this.cdp!.send("Input.dispatchKeyEvent", { type: "keyDown", ...down });
    await this.cdp!.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await sleep(600);
    await this.waitForLoad(10000, { previousOrigin, sameDocumentGraceMs: 800 }).catch(() => {});
    await this.refreshTitle().catch(() => {});
    this.emitState();
    return { pressed: keyName };
  }

  async scroll(direction: string = "down", amount: number = 600) {
    const delta = direction === "up" ? -Math.abs(amount) : Math.abs(amount);
    const value = await this.evaluate(`(() => { window.scrollBy(0, ${Number(delta) || 600}); return { y: window.scrollY, height: document.body.scrollHeight }; })()`);
    await sleep(400);
    return value || {};
  }

  async screenshot(options: { format?: string } = {}): Promise<ScreenshotResult> {
    const format = options.format === "png" ? "png" : "jpeg";
    await this.ensureStarted();
    const result = await this.cdp!.send("Page.captureScreenshot", format === "png" ? { format: "png" } : { format: "jpeg", quality: 90 });
    const data = result.data || "";
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const file = path.join(SHOT_DIR, `shot-${Date.now()}${format === "png" ? ".png" : ".jpg"}`);
    try { fs.writeFileSync(file, Buffer.from(data, "base64")); } catch {}
    this.lastFrameAt = Date.now();
    this.frame = { data, at: this.lastFrameAt, width: this.state.viewport.width, height: this.state.viewport.height };
    this.queueFrameBroadcast({ data, at: this.frame.at, width: this.frame.width, height: this.frame.height });
    return { file, base64: data, bytes: Buffer.byteLength(data, "base64"), url: this.state.url };
  }

  async fullpageScreenshot(): Promise<ScreenshotResult> {
    await this.ensureStarted();
    const result = await this.cdp!.send("Page.captureScreenshot", { format: "jpeg", quality: 90, captureBeyondViewport: true });
    const data = result.data || "";
    if (!data) throw new Error("整页截图失败：浏览器未返回图像数据");
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const file = path.join(SHOT_DIR, `shot-full-${Date.now()}.jpg`);
    try { fs.writeFileSync(file, Buffer.from(data, "base64")); } catch {}
    return { file, base64: data, bytes: Buffer.byteLength(data, "base64"), url: this.state.url };
  }

  async printToPdf(): Promise<ScreenshotResult> {
    await this.ensureStarted();
    const result = await this.cdp!.send("Page.printToPDF", { printBackground: true, preferCSSPageSize: true });
    const data = result.data || "";
    if (!data) throw new Error("PDF 导出失败：浏览器未返回数据");
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const file = path.join(SHOT_DIR, `page-${Date.now()}.pdf`);
    try { fs.writeFileSync(file, Buffer.from(data, "base64")); } catch {}
    return { file, base64: data, bytes: Buffer.byteLength(data, "base64"), url: this.state.url };
  }

  async back(): Promise<NavigateResult> {
    await this.ensureStarted();
    const previousOrigin = Number(await this.evaluate("Number(performance.timeOrigin) || 0").catch(() => 0)) || 0;
    await this.evaluate("history.back()");
    await sleep(800);
    await this.waitForLoad(8000, { previousOrigin, sameDocumentGraceMs: 800 }).catch(() => {});
    await this.refreshTitle().catch(() => {});
    this.emitState();
    return this.stateView();
  }

  async close() {
    const child = this.child;
    const port = this.port;
    this.state.active = false;
    this.stopWatching();
    this.subscriberCount = 0;
    await this.stopScreencast();
    this.clearFrameBroadcast();
    this.frame = null;
    this.lastFrameAt = 0;
    this.emitState();
    broadcast(this.key, "closed", {});
    try { this.cdp?.close(); } catch {}
    this.cdp = null;
    this.child = null;
    try { fs.rmSync(this.portFile, { force: true }); } catch {}
    if (port) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
        const list = await response.json();
        for (const target of list.filter((item: any) => item.type === "page")) {
          fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {});
        }
      } catch {}
    }
    if (port) {
      try {
        const versionResponse = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
        const version = await versionResponse.json();
        if (version?.webSocketDebuggerUrl) {
          const browserConnection = new CdpConnection(version.webSocketDebuggerUrl);
          await browserConnection.ready;
          await browserConnection.send("Browser.close").catch(() => {});
          browserConnection.close();
        }
      } catch {}
    }
    const killed = await killBrowserProcessesForProfile(this.profileDir);
    if (killed === 0 && child?.pid) {
      await new Promise<void>((resolve) => {
        execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => resolve());
        setTimeout(resolve, 3000);
      });
    }
    clearProfileLocks(this.profileDir);
    this.state.processCount = killed;
  }
}

// ---- 顶层 API ----

export function getBrowserSession(key: string): BrowserSession | null {
  return sessions.get(key) || null;
}

async function requireActiveSession(key: string): Promise<BrowserSession> {
  let session = sessions.get(key);
  if (!session) {
    session = await sessionFor(key);
    const reused = await session.tryReuse().catch(() => false);
    if (!reused) {
      sessions.delete(key);
      const error: any = new Error("浏览器尚未启动，请先调用 browser_open 打开网页");
      error.code = "BROWSER_NOT_STARTED";
      throw error;
    }
  }
  if (!session.state.active) {
    const error: any = new Error("浏览器尚未启动，请先调用 browser_open 打开网页");
    error.code = "BROWSER_NOT_STARTED";
    throw error;
  }
  return session;
}

async function sessionFor(key: string): Promise<BrowserSession> {
  if (!sessions.has(key)) sessions.set(key, new BrowserSession(key));
  return sessions.get(key)!;
}

export async function browserOpen(key: string, url: string): Promise<NavigateResult> {
  const target = normalizeNavUrl(url);
  const session = await sessionFor(key);
  session.assertAgentWrite("open");
  await session.ensureStarted();
  return session.navigate(target);
}

export async function browserSnapshot(key: string): Promise<SnapshotResult> {
  const session = await requireActiveSession(key);
  return session.snapshot();
}

function syncFrameSoon(session: BrowserSession | null, delay = 60) {
  if (!session || session.subscriberCount <= 0) return;
  setTimeout(() => { session.captureFrame().catch(() => {}); }, delay);
}

function shouldSyncFrame(action: string, payload: any = {}): boolean {
  if (action === "pointer") return String(payload.phase || "") === "up";
  return ["click", "wheel", "type", "key", "scroll", "navigate", "back", "reload", "tab_new", "tab_switch", "tab_close"].includes(action);
}

export async function browserClick(key: string, ref: string): Promise<ClickResult> {
  const session = await requireActiveSession(key);
  session.assertAgentWrite("click");
  const result = await session.click(ref);
  syncFrameSoon(session);
  return result;
}

export async function browserType(key: string, ref: string, text: string, options: { submit?: boolean } = {}): Promise<TypeResult> {
  const session = await requireActiveSession(key);
  session.assertAgentWrite("type");
  const result = await session.type(ref, text, options);
  syncFrameSoon(session);
  return result;
}

export async function browserPress(key: string, pressKey: string): Promise<PressResult> {
  const session = await requireActiveSession(key);
  session.assertAgentWrite("press");
  const result = await session.press(pressKey);
  syncFrameSoon(session);
  return result;
}

export async function browserScroll(key: string, direction: string, amount: number): Promise<any> {
  const session = await requireActiveSession(key);
  session.assertAgentWrite("scroll");
  const result = await session.scroll(direction, amount);
  syncFrameSoon(session);
  return result;
}

export async function browserScreenshot(key: string, options: { format?: string } = {}): Promise<ScreenshotResult> {
  return (await requireActiveSession(key)).screenshot(options);
}

export async function browserFullpageScreenshot(key: string): Promise<ScreenshotResult> {
  if (!RUNTIME_FLAGS.browserFullpage) {
    const err: any = new Error("整页截图未开启（OAW_BROWSER_FULLPAGE=1）");
    err.code = "FLAG_DISABLED";
    throw err;
  }
  return (await requireActiveSession(key)).fullpageScreenshot();
}

export async function browserPrintToPdf(key: string): Promise<ScreenshotResult> {
  if (!RUNTIME_FLAGS.browserFullpage) {
    const err: any = new Error("PDF 导出未开启（OAW_BROWSER_FULLPAGE=1）");
    err.code = "FLAG_DISABLED";
    throw err;
  }
  return (await requireActiveSession(key)).printToPdf();
}

export async function browserSetStreamPaused(key: string, paused: boolean) {
  const session = getBrowserSession(key);
  if (!session) return;
  await session.setStreamPaused(paused);
}

export async function browserResize(key: string, width: number, height: number): Promise<NavigateResult> {
  const session = await sessionFor(key);
  return session.resize(width, height);
}

export async function browserWaitForExpression(key: string, expression: string, { timeoutMs = 30000, intervalMs = 300 }: { timeoutMs?: number; intervalMs?: number } = {}): Promise<boolean> {
  const session = await requireActiveSession(key);
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 30000);
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const value = await session.evaluate(`Boolean(${expression})`);
      if (value === true) return true;
    } catch (e) {
      lastError = String((e as any)?.message || e);
    }
    await sleep(Number(intervalMs) || 300);
  }
  throw new Error(`等待页面就绪超时（${Math.round((Date.now() - deadline + timeoutMs) / 1000)}s）${lastError ? `：${lastError}` : ""}`);
}

export async function browserEvaluateValue(key: string, expression: string): Promise<any> {
  const session = await requireActiveSession(key);
  return session.evaluate(String(expression));
}

const SHOT_FILE_PATTERN = /^[\w-]+\.(jpg|png|pdf)$/;

export function browserShotFile(name: string): string {
  const clean = String(name || "").trim();
  if (!SHOT_FILE_PATTERN.test(clean)) { const err: any = new Error("非法的截图文件名"); err.code = "INVALID_SHOT_NAME"; throw err; }
  const file = path.join(SHOT_DIR, clean);
  if (!file.startsWith(SHOT_DIR)) { const err: any = new Error("非法的截图文件名"); err.code = "INVALID_SHOT_NAME"; throw err; }
  if (!fs.existsSync(file)) { const err: any = new Error("截图文件不存在或已被清理"); err.code = "SHOT_NOT_FOUND"; throw err; }
  return file;
}

export async function browserBack(key: string): Promise<NavigateResult> {
  const session = await requireActiveSession(key);
  session.assertAgentWrite("back");
  const result = await session.back();
  syncFrameSoon(session);
  return result;
}

async function dispatchBrowserUserInput(session: BrowserSession, action: string, payload: any = {}) {
  if (action === "navigate") return session.navigate(payload.url);
  if (action === "click") {
    const point = await session.resolvePoint(payload);
    await session.cdp!.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none", clickCount: 0 });
    await session.cdp!.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1, buttons: 1 });
    await session.cdp!.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1, buttons: 0 });
    return { clicked: point };
  }
  if (action === "pointer") {
    const point = await session.resolvePoint(payload);
    const phase = String(payload.phase || "move");
    if (phase === "down") {
      await session.cdp!.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none", clickCount: 0 });
      await session.cdp!.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1, buttons: 1 });
    } else if (phase === "up") {
      await session.cdp!.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1, buttons: 0 });
    } else {
      await session.cdp!.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "left", buttons: 1 });
    }
    return { pointer: phase, point };
  }
  if (action === "resize") return session.resize(payload.width, payload.height);
  if (action === "wheel") {
    const point = await session.resolvePoint(payload);
    const deltaY = Math.max(-3000, Math.min(3000, Number(payload.deltaY) || 0));
    const deltaX = Math.max(-3000, Math.min(3000, Number(payload.deltaX) || 0));
    await session.cdp!.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX, deltaY, button: "none" });
    return { wheel: { deltaX, deltaY } };
  }
  if (action === "type") {
    await session.cdp!.send("Input.insertText", { text: String(payload.text ?? "") });
    return { typed: String(payload.text ?? "").length };
  }
  if (action === "key") return session.press(payload.key || "Enter");
  if (action === "scroll") return session.scroll(payload.direction || "down", payload.amount);
  if (action === "back") return session.back();
  if (action === "reload") return session.reload();
  if (action === "tab_new") return session.newTab(payload.url || "about:blank");
  if (action === "tab_switch") return session.switchToTarget(String(payload.tabId || ""));
  if (action === "tab_close") return session.closeTab(String(payload.tabId || ""));
  if (action === "tabs") return { tabs: await session.refreshTabs() };
  throw new Error(`不支持的操作：${action}`);
}

export async function browserUserInput(key: string, payload: any = {}) {
  const session = await requireActiveSession(key);
  const action = String(payload.action || "");
  if (action === "release") return session.releaseToAgent(payload.reason || "用户交还");
  if (action === "takeover") return session.takeover(payload.reason || "用户主动接管");
  session.markUserActivity(action);
  const result = await dispatchBrowserUserInput(session, action, payload);
  if (shouldSyncFrame(action, payload)) syncFrameSoon(session);
  return result;
}

export async function browserTabs(key: string, action: string = "list", tabId: string = "", url: string = ""): Promise<any> {
  const session = await requireActiveSession(key);
  if (action === "list") return { tabs: await session.refreshTabs() };
  session.assertAgentWrite(`tab_${action}`);
  const result = action === "new" ? await session.newTab(url || "about:blank")
    : action === "switch" ? await session.switchToTarget(String(tabId || ""))
      : action === "close" ? await session.closeTab(String(tabId || ""))
        : (() => { throw new Error(`不支持的标签页操作：${action}`); })();
  syncFrameSoon(session);
  return result;
}

export async function browserClose(key: string, { force = false, reason = "" }: { force?: boolean; reason?: string } = {}): Promise<CloseResult> {
  const session = sessions.get(key);
  if (!session) return { closed: false, message: "没有运行中的浏览器" };
  const recent = session.lastUserInputAt && Date.now() - session.lastUserInputAt < 3 * 60 * 1000;
  if (!force && recent) {
    return {
      closed: false,
      kept: true,
      message: "用户刚刚在浏览器中操作过，已保留浏览器（如确需关闭，请让用户点击面板右上角关闭，或稍后再试）。",
    };
  }
  await session.close();
  sessions.delete(key);
  return { closed: true, reason };
}

export async function shutdownBrowsers() {
  const tasks: Promise<void>[] = [];
  for (const [key, session] of sessions.entries()) {
    const profileDir = session.profileDir;
    tasks.push(
      Promise.resolve()
        .then(() => session.close())
        .catch(() => {})
        .then(() => killBrowserProcessesForProfile(profileDir))
        .then(() => { clearProfileLocks(profileDir); })
        .catch(() => {}),
    );
    sessions.delete(key);
  }
  await Promise.all(tasks);
}

process.on("exit", () => {
  for (const session of sessions.values()) {
    if (session.child?.pid) {
      try { session.child.kill(); } catch {}
    }
  }
});

export function browserStoreInfo() {
  return {
    profileDir: PROFILE_DIR,
    shotDir: SHOT_DIR,
    executable: findBrowserExecutable(),
    headless: process.env.OAW_BROWSER_HEADLESS !== "0",
    sessions: [...sessions.keys()],
  };
}
