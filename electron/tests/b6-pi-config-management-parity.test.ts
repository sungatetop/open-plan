import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROJECT_DIR } from "../src/main/backend/workspace-paths";

/**
 * B6-3 行为覆盖：pi-config-management（常量路径族 / 读写导入 / 会话迁移 / 掩码）。
 *
 * R6-6b 对拍退役改写：旧侧 server/pi-config-management.mjs 动态 import 与双侧同流互等
 * 随 server 退役删除，仅保留 TS 侧断言（期望值此前已经双侧对拍固化，路径族期望值自
 * TS 源推导）。
 *
 * 基建设计：
 * - 不 mock fs：模块全部表面都是目录驱动的同步操作，直接走真实临时目录
 *   （mkdtemp 独立根目录 + 初始夹具），比内存 mock 更贴近生产行为。
 * - 模块级常量（AGENT_DIR/APP_DATA_DIR/LOCAL_PI_AGENT_DIR 等）在 import 时读环境变量，
 *   通过 vi.stubEnv + vi.resetModules + 动态 import 控制在同一环境下求值：
 *   OAW_DATA_DIR 显式指定数据目录；APPDATA/USERPROFILE 重定向避免触碰真实用户目录；
 *   项目回退目录（d:\open-plan\.oaw\规聚）只读探测、不写入。
 * - vi.useFakeTimers({ toFake: ["Date"] }) 冻结时钟：migration.at / canWriteDirectory 探测名等
 *   时间派生值确定化；随机量（uuid 临时文件名/探测随机段）不进断言载荷。
 */

type AnyMod = Record<string, any>;

const PROJECT_FALLBACK_DIR = path.join(PROJECT_DIR, ".oaw", "规聚");
const FALLBACK_CONFIG_NAMES = ["模型配置.json", "模型目录缓存.json", "凭据.json", "运行设置.json", "网络代理.json"];

async function loadMods(env: Record<string, string>): Promise<AnyMod> {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  return (await import("../src/main/backend/agent/pi-config-management")) as unknown as AnyMod;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function writeJsonl(file: string, entries: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
}

/** 根目录下搭建旧 Pi 源夹具（标准英文文件名）。 */
function buildPiFixture(sourceDir: string): void {
  writeJson(path.join(sourceDir, "models.json"), { providers: { "测试供应商": { api: "https://example.test/v1", apiKey: "sk-model-secret-456" } } });
  writeJson(path.join(sourceDir, "models-store.json"), { "测试供应商": { models: [{ id: "测试模型", name: "测试模型" }, { id: "第二模型", name: "第二模型" }] } });
  writeJson(path.join(sourceDir, "settings.json"), { defaultProvider: "测试供应商", defaultModel: "测试模型", theme: "dark" });
  writeJson(path.join(sourceDir, "auth.json"), {
    "测试供应商": { type: "api_key", key: "sk-auth-secret-123" },
    "另一家": { type: "oauth", access: "at-9876543210" },
  });
  const sessions = path.join(sourceDir, "sessions");
  writeJsonl(path.join(sessions, "有效会话.jsonl"), [{ type: "session", id: "s1" }, { type: "message", text: "hello" }]);
  writeJsonl(path.join(sessions, "嵌套", "第二个会话.jsonl"), [{ type: "session", id: "s2" }]);
  fs.writeFileSync(path.join(sessions, "无效会话.jsonl"), "不是 JSON\n", "utf8");
  writeJson(path.join(sessions, "旧格式.json"), { id: "nope" });
  fs.mkdirSync(path.join(sessions, "目录.jsonl"), { recursive: true });
  // 深度链 e/f/g/h/i：文件落在深度 5（> maxDepth 4），不应计入
  let deep = sessions;
  for (const seg of ["e", "f", "g", "h", "i"]) deep = path.join(deep, seg);
  writeJsonl(path.join(deep, "深层会话.jsonl"), [{ type: "session", id: "deep" }]);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_700_000_000_000);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("pi-config-management 模块级常量与路径族", () => {
  it("显式 OAW_DATA_DIR：常量与路径族（中文默认名）", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "b6-pi-cfg-a-"));
    try {
      const dataDir = path.join(root, "应用数据");
      const home = path.join(root, "主目录");
      const nw = await loadMods({ OAW_DATA_DIR: dataDir, OAW_LOCAL_PI_AGENT_DIR: "", PI_AGENT_DIR: "", APPDATA: path.join(root, "AppData", "Roaming"), USERPROFILE: home });
      expect(nw.AGENT_DIR).toBe(path.resolve(dataDir));
      expect(nw.AGENT_DIR_USES_PROJECT_FALLBACK).toBe(false);
      expect(nw.LOCAL_PI_AGENT_DIR).toBe(path.resolve(home, ".pi", "agent"));
      expect(path.basename(nw.PI_CONFIG_PATHS.modelsPath)).toBe("模型配置.json");
      expect(path.basename(nw.PI_CONFIG_PATHS.authPath)).toBe("凭据.json");

      // getPiConfigPaths 三种 standardNames 取值（false/空 → APP 中文名；true → PI 英文名；
      // 非默认覆盖目录时 undefined 亦走 APP 名）
      expect(nw.getPiConfigPaths(dataDir, { standardNames: false }).modelsPath).toBe(path.join(path.resolve(dataDir), "模型配置.json"));
      expect(nw.getPiConfigPaths(dataDir, { standardNames: true }).modelsPath).toBe(path.join(path.resolve(dataDir), "models.json"));
      expect(nw.getPiConfigPaths(dataDir, {}).modelsPath).toBe(path.join(path.resolve(dataDir), "模型配置.json"));
      expect(path.basename(nw.getPiConfigPaths(dataDir, { standardNames: true }).authPath)).toBe("auth.json");
      expect(path.basename(nw.getPiConfigPaths(dataDir, { standardNames: true }).migrationPath)).toBe("session-migration.json");
      expect(path.basename(nw.getPiConfigPaths(dataDir, {}).migrationPath)).toBe("会话迁移记录.json");

      // 空目录的配置状态
      const status = nw.getConfigStatus({ dir: dataDir });
      expect(status).toMatchObject({ source: "not-configured", configured: false, modelsConfigured: false, credentialCount: 0 });
      expect(status.storage).toMatchObject({ fallback: false, requestedDir: path.resolve(dataDir), message: null });

      // ensureConfigDirectory 落目录
      nw.ensureConfigDirectory(dataDir);
      expect(fs.existsSync(dataDir)).toBe(true);
      nw.ensureConfigDirectory(path.join(root, "新目录"));
      expect(fs.existsSync(path.join(root, "新目录"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("PI_AGENT_DIR 覆盖：英文文件名 + environment-override 来源", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "b6-pi-cfg-b-"));
    try {
      const piDir = path.join(root, "兼容Pi");
      const nw = await loadMods({ OAW_DATA_DIR: "", OAW_LOCAL_PI_AGENT_DIR: "", PI_AGENT_DIR: piDir, APPDATA: path.join(root, "AppData", "Roaming"), USERPROFILE: path.join(root, "主目录") });
      expect(nw.AGENT_DIR).toBe(path.resolve(piDir));
      expect(nw.USING_PI_AGENT_OVERRIDE).toBe(true);
      expect(nw.LOCAL_PI_AGENT_DIR).toBe(path.resolve(piDir));
      expect(path.basename(nw.PI_CONFIG_PATHS.modelsPath)).toBe("models.json");
      expect(nw.getConfigStatus().source).toBe("environment-override");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("AppData 可写：无显式目录时优先 AppData", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "b6-pi-cfg-c1-"));
    try {
      const appData = path.join(root, "AppData", "Roaming");
      const fallbackHasConfig = fs.existsSync(PROJECT_FALLBACK_DIR) && fs.readdirSync(PROJECT_FALLBACK_DIR).some((name) => FALLBACK_CONFIG_NAMES.includes(name));
      const expected = fallbackHasConfig ? PROJECT_FALLBACK_DIR : path.resolve(appData, "规聚");
      const nw = await loadMods({ OAW_DATA_DIR: "", PI_AGENT_DIR: "", OAW_LOCAL_PI_AGENT_DIR: path.join(root, "本地Pi"), APPDATA: appData, USERPROFILE: path.join(root, "主目录") });
      expect(nw.AGENT_DIR).toBe(expected);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("AppData 不可写：回退到项目内运行数据目录", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "b6-pi-cfg-c2-"));
    try {
      const appData = path.join(root, "AppData", "Roaming");
      // 预置同名“文件”占位，令 mkdirSync(recursive) 抛错 → canWriteDirectory false
      fs.mkdirSync(appData, { recursive: true });
      fs.writeFileSync(path.join(appData, "规聚"), "occupied", "utf8");
      const nw = await loadMods({ OAW_DATA_DIR: "", PI_AGENT_DIR: "", OAW_LOCAL_PI_AGENT_DIR: path.join(root, "本地Pi"), APPDATA: appData, USERPROFILE: path.join(root, "主目录") });
      expect(nw.AGENT_DIR).toBe(PROJECT_FALLBACK_DIR);
      expect(nw.AGENT_DIR_USES_PROJECT_FALLBACK).toBe(true);
      const status = nw.getConfigStatus();
      expect(status.storage).toMatchObject({ fallback: true, requestedDir: path.resolve(appData, "规聚"), message: "默认 AppData 不可写，已使用项目内运行数据目录" });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("pi-config-management 读写与导入功能序列", () => {
  it("全功能序列（导入/读写/网络设置/会话/掩码）", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "b6-pi-cfg-seq-"));
    try {
      const source = path.join(base, "本地Pi");
      const target = path.join(base, "应用数据");
      const sessionTarget = path.join(base, "项目", ".规聚会话");
      const sessionTarget2 = path.join(base, "项目2", ".规聚会话");
      const sessionTarget3 = path.join(base, "项目3", ".规聚会话");
      buildPiFixture(source);
      // 预置目标同名会话（exists_skipped 分支）与目录占位（目标非文件分支）
      writeJsonl(path.join(sessionTarget, "有效会话.jsonl"), [{ type: "session", id: "existing" }]);
      fs.mkdirSync(path.join(sessionTarget3, "有效会话.jsonl"), { recursive: true });

      const dataDir = path.join(base, "模块数据");
      const mod = await loadMods({ OAW_DATA_DIR: dataDir, OAW_LOCAL_PI_AGENT_DIR: "", PI_AGENT_DIR: "", APPDATA: path.join(base, "AppData", "Roaming"), USERPROFILE: path.join(base, "主目录") });

      const results: Record<string, unknown> = {};
      // 1. 全量导入（快照复制 + 迁移记录）
      results.import = mod.importLocalPiConfig({ sourceDir: source, targetDir: target });
      // 2. 导入结果读取
      results.credentials = mod.readCredentials({ dir: target });
      results.models = mod.readModelsConfig({ dir: target });
      results.modelsStore = mod.readModelsStore({ dir: target });
      results.settings = mod.readRuntimeSettings({ dir: target });
      // 3. 默认模型写入/清除（其余字段保留）
      results.defaultModelSet = mod.writeDefaultModel({ provider: "新供应商", model: "新模型" }, { dir: target });
      results.settingsAfterSet = mod.readRuntimeSettings({ dir: target });
      results.defaultModelClear = mod.writeDefaultModel({ provider: "", model: "" }, { dir: target });
      results.settingsAfterClear = mod.readRuntimeSettings({ dir: target });
      // 4. 网络设置：脱敏读、原文读、白名单过滤 + preserveProxy
      results.networkSaved = mod.saveNetworkSettings({ mode: "manual", proxyUrl: "http://user:secret@proxy.example.test:8080", noProxy: ["127.0.0.1"], unknownKey: "x" }, { dir: target });
      results.networkRead = mod.readNetworkSettings({ dir: target });
      results.networkRaw = mod.loadNetworkSettings({ dir: target });
      results.networkFile = JSON.parse(fs.readFileSync(path.join(target, "网络代理.json"), "utf8"));
      results.networkPreserved = mod.saveNetworkSettings({ mode: "direct", noProxy: "localhost" }, { dir: target, preserveProxy: true });
      // 5. 凭据/模型直写
      mod.writeCredentials({ "直写供应商": { type: "api_key", key: "sk-direct-999" } }, { dir: target });
      results.credentialsAfterWrite = mod.readCredentials({ dir: target });
      mod.writeModelsConfig({ providers: {} }, { dir: target });
      results.modelsAfterWrite = mod.readModelsConfig({ dir: target });
      // 6. 配置状态（有数据后）
      results.status = mod.getConfigStatus({ dir: target });
      // 7. 旧 Pi 预览/探测
      results.preview = mod.previewLocalPiConfig({ sourceDir: source });
      results.detect = mod.detectLocalPi({ sourceDir: source });
      // 8. 二次导入：跳过模型与凭据
      results.importPartial = mod.importLocalPiConfig({ sourceDir: source, targetDir: target, includeModels: false, includeCredentials: false });
      // 9. 源=目标拒绝
      results.importSame = mod.importLocalPiConfig({ sourceDir: source, targetDir: source });
      // 10. 会话批量导入
      results.sessions = mod.importLocalPiSessions({ sourceDir: path.join(source, "sessions"), targetDir: sessionTarget });
      results.sessionsNoTarget = mod.importLocalPiSessions({});
      // 11. 单文件导入：正常/各类抛错/已存在/目录占位
      const valid = path.join(source, "sessions", "有效会话.jsonl");
      results.sessionFile = mod.importLocalPiSessionFile(valid, sessionTarget2);
      results.sessionFileExists = mod.importLocalPiSessionFile(valid, sessionTarget2);
      const grab = (fn: () => unknown) => { try { return { ok: fn() }; } catch (error: any) { return { error: error.message }; } };
      results.sessionFileNotJsonl = grab(() => mod.importLocalPiSessionFile(path.join(source, "sessions", "旧格式.json"), sessionTarget2));
      results.sessionFileMissing = grab(() => mod.importLocalPiSessionFile(path.join(source, "sessions", "缺失.jsonl"), sessionTarget2));
      results.sessionFileInvalid = grab(() => mod.importLocalPiSessionFile(path.join(source, "sessions", "无效会话.jsonl"), sessionTarget2));
      results.sessionFileEmptyArgs = grab(() => mod.importLocalPiSessionFile("", sessionTarget2));
      results.sessionFileTargetIsDir = grab(() => mod.importLocalPiSessionFile(valid, sessionTarget3));
      // 12. 掩码
      results.mask = ["", "ab", "abcde", "sk-auth-secret-123"].map((value) => mod.maskCredential(value));

      // 关键内容断言
      const r = results as any;
      expect(r.import.ok).toBe(true);
      expect(r.import.imported.sort()).toEqual(["auth", "models", "modelsStore", "settings"]);
      expect(r.import.migration).toEqual({ status: "recorded", at: new Date(1_700_000_000_000).toISOString() });
      expect(r.import.providers[0]).toMatchObject({ provider: "测试供应商", set: true, type: "api_key" });
      expect(r.import.providers[0].masked).not.toContain("sk-auth-secret-123");
      // 目标目录树关键文件锚点（原对拍以双侧 snapshotTree 互等保证；单侧化后列清单断言）
      const targetTree = fs.readdirSync(target).sort();
      expect(targetTree).toEqual(["会话迁移记录.json", "凭据.json", "模型目录缓存.json", "模型配置.json", "网络代理.json", "运行设置.json"]);
      // 预置同名会话保留原内容（exists_skipped 分支）
      expect(JSON.parse(fs.readFileSync(path.join(sessionTarget, "有效会话.jsonl"), "utf8").split("\n")[0]!)).toMatchObject({ id: "existing" });
      expect(r.credentials).toMatchObject({ "测试供应商": { type: "api_key" }, "另一家": { type: "oauth" } });
      expect(r.models.providers["测试供应商"].api).toBe("https://example.test/v1");
      expect(r.modelsStore["测试供应商"].models).toHaveLength(2);
      expect(r.settingsAfterSet).toMatchObject({ defaultProvider: "新供应商", defaultModel: "新模型", theme: "dark" });
      expect(r.settingsAfterClear).toMatchObject({ theme: "dark" });
      expect(r.settingsAfterClear.defaultProvider).toBeUndefined();
      expect(r.networkSaved).toMatchObject({ proxy: "http://proxy.example.test:8080", hasProxy: true, noProxy: "127.0.0.1" });
      expect(r.networkRaw.proxyUrl).toBe("http://user:secret@proxy.example.test:8080");
      expect(r.networkFile).toMatchObject({ mode: "manual", proxyUrl: "http://user:secret@proxy.example.test:8080", noProxy: "127.0.0.1" });
      expect(Object.keys(r.networkFile).sort()).toEqual(["mode", "noProxy", "proxyUrl"].sort());
      expect(r.networkPreserved).toMatchObject({ mode: "direct", proxy: "http://proxy.example.test:8080", hasProxy: true });
      expect(r.status.configured).toBe(true);
      expect(r.status.credentialCount).toBe(1);
      expect(r.status.files.auth).toMatchObject({ status: "present", isFile: true });
      expect(r.status.credentials.providers["直写供应商"].masked).toBe("sk*********99");
      expect(r.preview.sessionCount).toBe(3);
      expect(r.preview.models).toEqual({ providerCount: 1, modelCount: 2, providers: ["测试供应商"] });
      expect(r.preview.files.auth.providers["测试供应商"].set).toBe(true);
      expect(JSON.stringify(r.preview)).not.toContain("sk-auth-secret-123");
      expect(r.detect.available).toBe(true);
      expect(r.importPartial.imported).toEqual(["settings"]);
      expect(r.importPartial.files).toMatchObject({ models: { status: "skipped" }, modelsStore: { status: "skipped" }, auth: { status: "skipped" }, settings: { status: "imported" } });
      expect(r.importSame).toEqual({ ok: false, error: "源目录和目标目录不能相同" });
      expect(r.sessions.imported).toBe(1);
      // 顺序依赖 NTFS 目录序，排序后断言
      expect(r.sessions.files.slice().sort((x: any, y: any) => x.name.localeCompare(y.name))).toEqual([
        { name: "第二个会话.jsonl", status: "imported" },
        { name: "无效会话.jsonl", status: "invalid" },
        { name: "有效会话.jsonl", status: "exists_skipped" },
      ]);
      expect(r.sessionsNoTarget).toEqual({ ok: false, error: "targetDir required", files: [] });
      expect(r.sessionFileNotJsonl).toEqual({ error: "会话文件必须是 JSONL 文件" });
      expect(r.sessionFileMissing).toEqual({ error: "会话文件不存在或不是文件" });
      expect(r.sessionFileInvalid).toEqual({ error: "会话文件不是有效 JSONL" });
      expect(r.sessionFileEmptyArgs).toEqual({ error: "会话文件必须是 JSONL 文件" });
      expect(r.sessionFileTargetIsDir).toEqual({ error: "目标会话路径已存在但不是文件" });
      expect(r.mask).toEqual([null, "****", "ab****de", "sk************23"]);
      // 单文件导入副本内容与源一致
      expect(fs.readFileSync(path.join(sessionTarget2, "有效会话.jsonl"), "utf8")).toBe(fs.readFileSync(valid, "utf8"));
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
