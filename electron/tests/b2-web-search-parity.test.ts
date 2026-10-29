/**
 * B2-15 web-search 域（modern src/main/backend/web-search.ts）。
 *
 * R6-7a 对拍退役改写：旧侧 server/web-search.mjs 物理路径动态 import
 * （pathToFileURL）随 server/ 退役删除（等价性已在 B2-15 批对拍验收冻结），仅保留
 * modern 侧同一套绝对断言。
 *
 * stubEnv 模式（B2-3/B2-9/B2-14 先例）：OAW_SEARCH_CONFIG 为模块加载期锚点
 * （CONFIG_FILE 常量），mkdtmp 锚定 + beforeAll 设 env 后 vi.resetModules() 重载
 * TS 依赖树动态 import（workspace/persistence-utils 同步重实例化）。
 *
 * 覆盖面：searchStoreInfo 存在性/锚点、readStoredSearchSettings/readSearchSettings
 * 默认值与环境变量注入（磁盘优先）、saveSearchSettings（backend 白名单/去尾斜杠/
 * maxResults 钳制/timeoutMs 不可写/环境凭据不落盘/clearCredentials 三形态）、
 * searchState/publicSearchSettings 状态聚合（label/tone/reason/credentialSource）、
 * webSearch 预网络错误（空关键词/不支持后端/未配置 SEARCH_NOT_CONFIGURED）、
 * testSearchBackend 预网络分支（不支持/未配置/draft 不落盘不标记连通性）。
 *
 * 口径：四后端真实搜索请求路径不在单元测试面（需外网凭据，B2-14 MCP SDK 同款裁剪）；
 * jina 免 Key 即 ready——任何对 jina 的 webSearch/testSearchBackend 调用都会发起真实
 * 网络请求，测试全程禁止调用。connectivity Map 进程内状态：ok/failed 标记仅经真实
 * 测试路径产生，本面只断言 untested 初值与 save 后 resetConnectivity 效果。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type * as SearchModule from "../src/main/backend/web-search";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const MODERN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "b2-websearch-modern-"));

type SearchApi = typeof SearchModule;
const modernHolder: { mod: SearchApi | null } = { mod: null };

const IMPLS = [
  { label: "modern", dir: MODERN_DATA, holder: modernHolder },
] as const;

const DEFAULT_SETTINGS = {
  backend: "tavily",
  tavilyKey: "",
  searxngUrl: "",
  jinaKey: "",
  bochaKey: "",
  maxResults: 6,
  timeoutMs: 20000,
};

const SEARCH_STATE_KEYS = [
  "selectedBackend", "selectedName", "configured", "needsKey", "needsUrl", "keyless",
  "credentialSource", "connectivity", "connectivityMessage", "connectivityAt",
  "connectivityDurationMs", "label", "tone", "reason", "backends",
] as const;

describe.each(IMPLS)("web-search（$label）", ({ dir, holder }) => {
  const cfg = () => path.join(dir, "search.json");
  const m = () => holder.mod!;
  const readRaw = () => JSON.parse(fs.readFileSync(cfg(), "utf8"));

  beforeAll(async () => {
    process.env.OAW_SEARCH_CONFIG = cfg();
    vi.resetModules();
    holder.mod = (await import("../src/main/backend/web-search")) as SearchApi;
  });

  it("初始态：store 不存在、settings 等于默认值、searchState 全族 untested 待配置", () => {
    const info = m().searchStoreInfo();
    expect(info.exists).toBe(false);
    expect(info.file).toBe(cfg());
    expect(info.backends.map((b: any) => b.id)).toEqual(["tavily", "searxng", "jina", "bocha"]);
    expect(m().readStoredSearchSettings()).toEqual(DEFAULT_SETTINGS);
    expect(m().readSearchSettings()).toEqual(DEFAULT_SETTINGS);
    const state = m().searchState();
    expect(Object.keys(state).sort()).toEqual([...SEARCH_STATE_KEYS].sort());
    expect(state.selectedBackend).toBe("tavily");
    expect(state.selectedName).toBe("Tavily");
    expect(state.configured).toBe(false);
    expect(state.connectivity).toBe("untested");
    expect(state.connectivityMessage).toBe("");
    expect(state.connectivityAt).toBe("");
    expect(state.connectivityDurationMs).toBeNull();
    expect(state.label).toBe("待配置");
    expect(state.tone).toBe("warn");
    expect(state.reason).toBe("Tavily 未配置 API Key（设置 → 联网搜索）");
    expect(state.backends).toHaveLength(4);
    const jina = state.backends.find((b: any) => b.id === "jina")!;
    expect(jina.keyless).toBe(true);
    expect(jina.configured).toBe(true);
    expect(jina.credentialSource).toBe("none");
    expect(jina.connectivity).toBe("untested");
  });

  it("环境变量注入 readSearchSettings（env 凭据）且不进 readStoredSearchSettings", () => {
    process.env.TAVILY_API_KEY = "env-tavily-key-0001";
    process.env.SEARXNG_URL = "http://env-searxng";
    try {
      const merged = m().readSearchSettings();
      expect(merged.tavilyKey).toBe("env-tavily-key-0001");
      expect(merged.searxngUrl).toBe("http://env-searxng");
      const stored = m().readStoredSearchSettings();
      expect(stored.tavilyKey).toBe("");
      expect(stored.searxngUrl).toBe("");
      const tavily = m().searchState().backends.find((b: any) => b.id === "tavily")!;
      expect(tavily.credentialSource).toBe("env");
    } finally {
      delete process.env.TAVILY_API_KEY;
      delete process.env.SEARXNG_URL;
    }
  });

  it("保存面：磁盘优先于环境变量、掩码、落盘与 timeoutMs 不可写", () => {
    process.env.TAVILY_API_KEY = "env-tavily-key-0001";
    try {
      const saved = m().saveSearchSettings({ backend: "searxng", searxngUrl: "http://my.instance///", tavilyKey: "stored-tavily-key-123", bochaKey: "bc-1234567890", maxResults: 99, timeoutMs: 1 });
      expect(saved.backend).toBe("searxng");
      expect(saved.searxngUrl).toBe("http://my.instance");
      expect(saved.maxResults).toBe(10);
      expect(saved.hasTavilyKey).toBe(true);
      expect(saved.tavilyKeyMasked).toBe("stor••••-123");
      expect(saved.hasBochaKey).toBe(true);
      expect(saved.bochaKeyMasked).toBe("bc-1••••7890");
      // 磁盘优先（既有行为）：磁盘配置覆盖环境变量
      expect(m().readSearchSettings().tavilyKey).toBe("stored-tavily-key-123");
      // 落盘形态：环境凭据不写盘、timeoutMs 被删、maxResults 钳制
      const raw = readRaw();
      expect(raw.tavilyKey).toBe("stored-tavily-key-123");
      expect(raw).not.toHaveProperty("timeoutMs");
      expect(raw.maxResults).toBe(10);
      expect(raw.backend).toBe("searxng");
      expect(m().searchStoreInfo().exists).toBe(true);
      // 保存 touched 后端 → 进程内连通性重置为 untested
      expect(m().searchState().connectivity).toBe("untested");
    } finally {
      delete process.env.TAVILY_API_KEY;
    }
  });

  it("searchState 聚合：选中 searxng 已配置未验证（label/tone/reason/credentialSource）", () => {
    const state = m().searchState();
    expect(state.selectedBackend).toBe("searxng");
    expect(state.selectedName).toBe("SearXNG（自建/公共实例）");
    expect(state.configured).toBe(true);
    expect(state.needsKey).toBe(false);
    expect(state.needsUrl).toBe(true);
    expect(state.keyless).toBe(false);
    expect(state.credentialSource).toBe("saved");
    expect(state.label).toBe("已配置 · 未验证");
    expect(state.tone).toBe("warn");
    expect(state.reason).toBe("凭据已保存，但尚未验证连通性；点“测试连接”确认。");
  });

  it("实例地址可清空（原行为）+ maxResults 下钳", () => {
    const cleared = m().saveSearchSettings({ searxngUrl: "", maxResults: 0 });
    expect(cleared.searxngUrl).toBe("");
    expect(cleared.maxResults).toBe(1);
    const state = m().searchState();
    expect(state.configured).toBe(false);
    expect(state.label).toBe("待配置");
    expect(state.reason).toBe("SearXNG 未配置实例地址（设置 → 联网搜索）");
    const restored = m().saveSearchSettings({ searxngUrl: "http://back.instance/" });
    expect(restored.searxngUrl).toBe("http://back.instance");
  });

  it("clearCredentials：true 清全部 / 字段名与 id 形态 / 非法 token 忽略 / 短 key 全掩码", () => {
    const clearedAll = m().saveSearchSettings({ clearCredentials: true });
    expect(clearedAll.hasTavilyKey).toBe(false);
    expect(clearedAll.hasBochaKey).toBe(false);
    expect(clearedAll.hasJinaKey).toBe(false);
    expect(readRaw().tavilyKey).toBe("");
    expect(readRaw().bochaKey).toBe("");

    const withJina = m().saveSearchSettings({ jinaKey: "jj-1234567890" });
    expect(withJina.hasJinaKey).toBe(true);
    expect(withJina.jinaKeyMasked).toBe("jj-1••••7890");
    const shortKey = m().saveSearchSettings({ jinaKey: "short" });
    expect(shortKey.hasJinaKey).toBe(true);
    expect(shortKey.jinaKeyMasked).toBe("••••");

    // 字段名形态 + 非法 token 忽略
    const clearedByField = m().saveSearchSettings({ clearCredentials: ["jinaKey", "unknown-token"] });
    expect(clearedByField.hasJinaKey).toBe(false);
    // id 形态
    const setAndClear = m().saveSearchSettings({ bochaKey: "bc-0987654321", clearCredentials: ["bocha"] });
    expect(setAndClear.hasBochaKey).toBe(false);
  });

  it("webSearch 预网络错误：空关键词/不支持后端/未配置后端（code+category）", async () => {
    await expect(m().webSearch("")).rejects.toThrow("搜索关键词不能为空");
    await expect(m().webSearch("关键词", { backend: "nope" })).rejects.toThrow("不支持的搜索后端：nope");
    const error: any = await m().webSearch("关键词", { backend: "tavily" }).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("SEARCH_NOT_CONFIGURED");
    expect(error.category).toBe("unconfigured");
    expect(error.message).toBe("Tavily 未配置 API Key（设置 → 联网搜索）");
    const bochaError: any = await m().webSearch("关键词", { backend: "bocha" }).catch((e) => e);
    expect(bochaError.code).toBe("SEARCH_NOT_CONFIGURED");
    expect(bochaError.message).toBe("博查未配置 API Key（设置 → 联网搜索）");
  });

  it("testSearchBackend 预网络分支：不支持/未配置/draft 不落盘不标记连通性", async () => {
    const unsupported = await m().testSearchBackend("nope");
    expect(unsupported).toMatchObject({
      ok: false, backend: "nope", name: "nope", testedDraft: false,
      category: "unknown", connectivity: "untested", durationMs: 0,
      message: "不支持的搜索后端：nope",
    });
    const unconfigured = await m().testSearchBackend("tavily");
    expect(unconfigured).toMatchObject({
      ok: false, backend: "tavily", name: "Tavily", testedDraft: false,
      category: "unconfigured", connectivity: "untested", durationMs: 0,
      message: "Tavily 未配置 API Key（设置 → 联网搜索）",
    });
    const draft = await m().testSearchBackend("tavily", { draft: {} });
    expect(draft).toMatchObject({ ok: false, category: "unconfigured", testedDraft: true, connectivity: "untested" });
    // draft 不改变已保存后端的连通性状态（不 markConnectivity）
    const state = m().searchState();
    expect(state.backends.find((b: any) => b.id === "tavily")!.connectivity).toBe("untested");
    expect(state.connectivity).toBe("untested");
  });

  it("publicSearchSettings 形态：脱敏配置 + 统一状态嵌套", () => {
    const pub = m().publicSearchSettings();
    expect(Object.keys(pub).sort()).toEqual([
      "backend", "bochaKeyMasked", "hasBochaKey", "hasJinaKey", "hasTavilyKey",
      "jinaKeyMasked", "maxResults", "searxngUrl", "state", "tavilyKeyMasked",
    ].sort());
    expect(pub.state).toEqual(m().searchState());
  });
});

describe("web-search：modern 侧常量锚点", () => {
  it("SEARCH_BACKENDS frozen", () => {
    expect(Object.isFrozen(modernHolder.mod!.SEARCH_BACKENDS)).toBe(true);
  });
});
