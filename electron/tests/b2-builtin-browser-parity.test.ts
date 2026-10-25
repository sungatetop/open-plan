/**
 * B2-16 builtin-browser 域对拍（legacy server/builtin-browser.mjs vs modern src/main/backend/builtin-browser.ts）。
 *
 * 对拍形态②（B2-3/B2-9/B2-14/B2-15 stubEnv 模式）：OAW_BROWSER_PROFILE 为模块加载期锚点
 * （PROFILE_DIR 常量），双侧各自 mkdtmp 锚定 + beforeAll 设 env 后动态 import；
 * modern 侧 vi.resetModules() 重载 TS 依赖树，legacy 侧物理路径 import 一次缓存。
 *
 * 覆盖面（全部经导出面驱动）：
 *   - browserStoreInfo：5 键集 + PROFILE_DIR 双侧各自锚定 tmpdir + shotDir 同锚真实仓库 + headless 默认 true；
 *   - 纯函数族：normalizeBrowserOwnership（lease 过期自动交还/owner 归一）、
 *     browserAgentWriteBlocked（放行 null/阻塞 retryAfterMs）、browserSessionKey（复合键剥离）、
 *     BROWSER_USER_ACTION_SET 集合一致；
 *   - verifyCdpOwnership fs 分支：无效端口/无 marker 无 pid 拒绝/marker 一致放行/marker 端口不一致拒绝
 *     （tmpdir 写 DevToolsActivePort，全程不触真实浏览器进程）；
 *   - browserShotFile：非法名 INVALID_SHOT_NAME（穿越/扩展名）/ SHOT_NOT_FOUND / 合法文件返回绝对路径
 *     （真实 SHOT_DIR 写临时文件，finally 清理）；
 *   - 订阅广播闭环：subscribeBrowser/broadcast/browserSubscriberCount（订阅→广播→退订→空集清理）；
 *   - 无会话编排分支：browserClose（未启动消息）/browserSetStreamPaused（静默）/hasBrowserSession/
 *     getBrowserSession（空注册表）/resetBrowserSession（tmpdir profile 清理 + killed 0 + cleared 0）/
 *     browserOpen 非法 URL 拒绝（normalizeNavUrl 先校验，不创建会话）/shutdownBrowsers 空注册表静默。
 *
 * 口径（安全/进程边界决定，同 B2-15）：CdpConnection WebSocket 全链、BrowserSession 实例方法
 * （start/launch/screencast/导航/点击/截图）、killBrowserProcessesForProfile 正常路径、
 * allocatePort/findBrowserExecutable 内部实现均不在单元对拍面——需要真实 Edge/Chrome 进程与
 * CDP 端点；browserOpen 合法 URL 分支会真实拉起浏览器，测试全程禁止触发。
 * assertUrlAllowed/normalizeNavUrl/sandboxArgs/readPortFile 等未导出内部函数经导出面间接覆盖。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as BrowserModule from "../src/main/backend/builtin-browser";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// tests → electron → 项目根（旧 server 锚定真实仓库，与生产 sidecar 同一加载形态）
const PROJECT_ROOT = path.resolve(HERE, "../..");

const LEGACY_PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), "b2-browser-legacy-"));
const MODERN_PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), "b2-browser-modern-"));

type BrowserApi = typeof BrowserModule;
const legacyHolder: { mod: BrowserApi | null } = { mod: null };
const modernHolder: { mod: BrowserApi | null } = { mod: null };

const IMPLS = [
  { label: "legacy", dir: LEGACY_PROFILE, holder: legacyHolder, modern: false },
  { label: "modern", dir: MODERN_PROFILE, holder: modernHolder, modern: true },
] as const;

const REAL_SHOT_DIR = path.join(PROJECT_ROOT, ".oaw", "browser-shots");
const USER_ACTIONS = [
  "click", "pointer", "wheel", "type", "key", "scroll", "navigate", "back", "reload", "tab_new", "tab_switch", "tab_close",
];

describe.each(IMPLS)("builtin-browser 对拍（$label）", ({ dir, holder, modern }) => {
  const m = () => holder.mod!;

  beforeAll(async () => {
    process.env.OAW_BROWSER_PROFILE = dir;
    if (modern) {
      vi.resetModules();
      holder.mod = (await import("../src/main/backend/builtin-browser")) as BrowserApi;
    } else {
      holder.mod = (await import(pathToFileURL(path.join(PROJECT_ROOT, "server", "builtin-browser.mjs")).href)) as BrowserApi;
    }
  });

  it("browserStoreInfo：5 键集 + PROFILE_DIR 锚定本侧 tmpdir + shotDir 同锚真实仓库 + headless 默认开", () => {
    const info = m().browserStoreInfo();
    expect(Object.keys(info).sort()).toEqual(["executable", "headless", "profileDir", "sessions", "shotDir"]);
    expect(info.profileDir).toBe(dir);
    expect(info.shotDir).toBe(REAL_SHOT_DIR);
    expect(info.headless).toBe(true); // OAW_BROWSER_HEADLESS 未设 → headless=new
    expect(info.sessions).toEqual([]);
    expect(info.executable === null || typeof info.executable === "string").toBe(true);
  });

  it("BROWSER_USER_ACTION_SET：12 项用户接管动作集合一致，resize/tabs 不在其中", () => {
    expect([...m().BROWSER_USER_ACTION_SET].sort()).toEqual([...USER_ACTIONS].sort());
    expect(m().BROWSER_USER_ACTION_SET.has("resize")).toBe(false);
    expect(m().BROWSER_USER_ACTION_SET.has("tabs")).toBe(false);
  });

  it("normalizeBrowserOwnership：agent 透传 / user 未过期保留 / user 过期自动交还 / owner 非法归一", () => {
    expect(m().normalizeBrowserOwnership({ owner: "agent", leaseExpiresAt: 0, reason: "" }, 1000))
      .toEqual({ owner: "agent", leaseExpiresAt: 0, reason: "", expiredFrom: null });
    expect(m().normalizeBrowserOwnership({ owner: "user", leaseExpiresAt: 5000, reason: "用户接管" }, 1000))
      .toEqual({ owner: "user", leaseExpiresAt: 5000, reason: "用户接管", expiredFrom: null });
    expect(m().normalizeBrowserOwnership({ owner: "user", leaseExpiresAt: 500, reason: "用户接管" }, 1000))
      .toEqual({ owner: "agent", leaseExpiresAt: 0, reason: "用户接管已超时，自动交还 Agent", expiredFrom: "user" });
    expect(m().normalizeBrowserOwnership({ owner: "nonsense", leaseExpiresAt: 99, reason: "x" }, 1000).owner).toBe("agent");
    expect(m().normalizeBrowserOwnership(null, 1000)).toEqual({ owner: "agent", leaseExpiresAt: 0, reason: "", expiredFrom: null });
  });

  it("browserAgentWriteBlocked：agent 放行 null；user 接管期间阻塞并带剩余毫秒；lease 过期放行", () => {
    expect(m().browserAgentWriteBlocked({ owner: "agent", leaseExpiresAt: 0, reason: "" }, 1000)).toBeNull();
    const blocked = m().browserAgentWriteBlocked({ owner: "user", leaseExpiresAt: 4000, reason: "用户接管" }, 1000);
    expect(blocked).toMatchObject({ code: "BROWSER_USER_TAKEOVER", retryAfterMs: 3000 });
    expect(String(blocked!.message)).toContain("3 秒后自动交还");
    expect(m().browserAgentWriteBlocked({ owner: "user", leaseExpiresAt: 500, reason: "x" }, 1000)).toBeNull();
  });

  it("browserSessionKey：复合 agentKey 剥离 thread 后缀 / 普通键原样 / 空 thread / 后缀不匹配不剥离", () => {
    expect(m().browserSessionKey("client::thread", "thread")).toBe("client::thread");
    expect(m().browserSessionKey("client", "thread")).toBe("client::thread");
    expect(m().browserSessionKey("client::other", "thread")).toBe("client::other::thread");
    expect(m().browserSessionKey("client", "")).toBe("client::");
    expect(m().browserSessionKey("", "")).toBe("::");
  });

  it("verifyCdpOwnership：无效端口拒绝 / 无 marker 无 pid 拒绝 / marker 一致放行 / marker 端口不一致拒绝", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `b2-browser-cdp-${modern ? "modern" : "legacy"}-`));
    try {
      expect(await m().verifyCdpOwnership({ port: 0, pid: 0, profileDir: tmp })).toMatchObject({ ok: false, reason: "端口记录无效" });
      expect(await m().verifyCdpOwnership({ port: Number.NaN, pid: 0, profileDir: tmp })).toMatchObject({ ok: false, reason: "端口记录无效" });
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), "b2-browser-cdp-empty-"));
      expect(await m().verifyCdpOwnership({ port: 42871, pid: 0, profileDir: empty }))
        .toMatchObject({ ok: false, reason: "既无 DevToolsActivePort 也无进程记录，无法确认 CDP 归属" });
      fs.writeFileSync(path.join(tmp, "DevToolsActivePort"), "42871\n/devtools/browser/abc");
      const ok = await m().verifyCdpOwnership({ port: 42871, pid: 0, profileDir: tmp });
      expect(ok.ok).toBe(true);
      expect(ok.marker).toEqual({ port: 42871, wsPath: "/devtools/browser/abc" });
      const mismatch = await m().verifyCdpOwnership({ port: 42872, pid: 0, profileDir: tmp });
      expect(mismatch.ok).toBe(false);
      expect(String(mismatch.reason)).toContain("不一致");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("browserShotFile：穿越与非法扩展名拒绝 / 不存在 SHOT_NOT_FOUND / 合法文件返回绝对路径", () => {
    fs.mkdirSync(REAL_SHOT_DIR, { recursive: true });
    for (const bad of ["../evil.jpg", "sub/dir.jpg", "shot.txt", ""]) {
      try {
        m().browserShotFile(bad);
        expect.unreachable(`应拒绝非法文件名：${bad}`);
      } catch (error) {
        expect((error as any).code).toBe("INVALID_SHOT_NAME");
      }
    }
    try {
      m().browserShotFile("shot-parity-missing.jpg");
      expect.unreachable("应抛 SHOT_NOT_FOUND");
    } catch (error) {
      expect((error as any).code).toBe("SHOT_NOT_FOUND");
    }
    const name = `shot-parity-${modern ? "modern" : "legacy"}-${Date.now()}.jpg`;
    const written = path.join(REAL_SHOT_DIR, name);
    try {
      fs.writeFileSync(written, "parity");
      expect(m().browserShotFile(name)).toBe(written);
    } finally {
      fs.rmSync(written, { force: true });
    }
  });

  it("订阅广播闭环：subscribe→broadcast 收到→退订不再收→空集自动清理", () => {
    const seen: Array<[string, any]> = [];
    const unsubscribe = m().subscribeBrowser("parity-key", (type, data) => seen.push([type, data]));
    expect(m().browserSubscriberCount("parity-key")).toBe(1);
    m().broadcast("parity-key", "state", { active: false });
    m().broadcast("no-such-key", "state", {}); // 无订阅者静默
    expect(seen).toEqual([["state", { active: false }]]);
    unsubscribe();
    expect(m().browserSubscriberCount("parity-key")).toBe(0);
    m().broadcast("parity-key", "frame", { data: "x" });
    expect(seen).toHaveLength(1);
  });

  it("空注册表：hasBrowserSession false / getBrowserSession null / browserClose 未启动消息 / browserSetStreamPaused 静默", async () => {
    expect(m().hasBrowserSession("parity-none")).toBe(false);
    expect(m().getBrowserSession("parity-none")).toBeNull();
    expect(await m().browserClose("parity-none")).toEqual({ closed: false, message: "没有运行中的浏览器" });
    await expect(m().browserSetStreamPaused("parity-none", true)).resolves.toBeUndefined();
  });

  // resetBrowserSession 在 win32 经 PowerShell 查询进程（killBrowserProcessesForProfile），
  // 全量并发下可能超过 vitest 默认 5s，显式放宽到 30s。
  it("resetBrowserSession：无会话时按 sessionProfileDir 清理（killed 0 / cleared 0 / profileDir 在本侧 tmpdir）", async () => {
    const result = await m().resetBrowserSession("parity-reset");
    expect(result.killed).toBe(0);
    expect(result.cleared).toBe(0);
    expect(result.profileDir.startsWith(path.join(dir, "sessions"))).toBe(true);
    expect(fs.existsSync(path.join(result.profileDir, ".oaw-devtools-port"))).toBe(false);
  }, 30000);

  it("browserOpen 非法 URL：空串与非网页协议在启动浏览器前拒绝，且不创建会话", async () => {
    await expect(m().browserOpen("parity-nav", "")).rejects.toThrow("URL 不能为空");
    await expect(m().browserOpen("parity-nav", "javascript:alert(1)")).rejects.toThrow("无效的 URL");
    expect(m().getBrowserSession("parity-nav")).toBeNull(); // 先校验后启动：无效地址不注册会话
  });

  it("shutdownBrowsers：空注册表静默完成", async () => {
    await expect(m().shutdownBrowsers()).resolves.toBeUndefined();
    expect(m().browserSubscriberCount("parity-reset")).toBe(0);
  });

  afterAll(() => {
    // modern 侧 resetModules 重载的 workspace.ts 会在 PROJECT_DIR 建 office-workspace（既有副作用，与旧侧同构）
    fs.rmSync(path.join(dir, "sessions"), { recursive: true, force: true });
  });
});

describe("builtin-browser 对拍：双侧常量与键集一致", () => {
  it("BROWSER_USER_ACTION_SET 双侧集合一致", () => {
    expect([...legacyHolder.mod!.BROWSER_USER_ACTION_SET].sort()).toEqual([...modernHolder.mod!.BROWSER_USER_ACTION_SET].sort());
  });
  it("browserStoreInfo 双侧键集一致（executable 探测环境相关，只比键集与 headless）", () => {
    const legacy = legacyHolder.mod!.browserStoreInfo();
    const modern = modernHolder.mod!.browserStoreInfo();
    expect(Object.keys(legacy).sort()).toEqual(Object.keys(modern).sort());
    expect(legacy.headless).toBe(modern.headless);
  });
});

afterAll(() => {
  fs.rmSync(LEGACY_PROFILE, { recursive: true, force: true });
  fs.rmSync(MODERN_PROFILE, { recursive: true, force: true });
});
