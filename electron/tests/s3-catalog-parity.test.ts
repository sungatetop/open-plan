/**
 * S3-11 catalog 族四域对拍：legacy 物理加载 server/{provider-catalog,models-dev-catalog,
 * plan-catalog,pi-package-catalog}.mjs vs modern 静态 import TS backend/{同名}.ts。
 *
 * 锚定说明：
 *   - provider/models-dev：CATALOG_FILE/CACHE_FILE 同锚 <项目根>/server/ 下的真实
 *     数据文件（pi-builtin-providers.json 由固化脚本产出；models-dev 缓存默认不存在
 *     =offline 真实态）；合并态用例临时写 fake 缓存后复原（finally 删除 + invalidate）。
 *   - plan/pi-package：OAW_DATA_DIR 在两侧模块加载前 stub 注入 tmp 目录（pi-config-
 *     management 的 AGENT_DIR 为模块加载期常量），写面（applyPlan/disconnectPlan）
 *     全链落在 tmp，不碰真实凭据；vitest per-file 模块图隔离保证注入不外溢。
 * 覆盖：导出面/常量；normalizeModelsDevProvider 全形态；缓存读写回环与状态判定；
 * 内置目录归一化全量互等；合并层 offline/合并语义（快照元数据保留/新模型补充/
 * contextWindow 补齐/source 标记）；投影与详情；模型能力反查（带前缀/裸 id）；
 * 一键导入构造（截断/剥尾斜杠/modelIds 过滤）与拦截文案；套餐常量与接入/断开写盘；
 * resolveInstalledPiPackage 未安装分支。fetch 类网络 IO 域（fetchModelsDevCatalog/
 * fetchPlanModels/searchPiPackageCatalog）不在确定性对拍面，由集成阶段覆盖。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROJECT_DIR } from "../src/main/backend/workspace-paths";

// legacy 侧经 any 载体调用：旧 .mjs 无类型标注，tsc 对解构默认值/可选属性的推断局限
// 直接传参会误报（S3-10 先例）。
let legacy: any;
let modern: any;

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "s3l11cat-"));
const CACHE_FILE = path.join(PROJECT_DIR, "server", "models-dev-目录.json");
const CACHE_EXISTS_BEFORE = fs.existsSync(CACHE_FILE);

beforeAll(async () => {
  // OAW_DATA_DIR 在两侧 pi-config-management 模块加载期求值 → 双侧 AGENT_DIR 同锚 tmp
  vi.stubEnv("OAW_DATA_DIR", TMP_DIR);
  legacy = {
    provider: await import("@legacy-server/provider-catalog.mjs"),
    modelsDev: await import("@legacy-server/models-dev-catalog.mjs"),
    plan: await import("@legacy-server/plan-catalog.mjs"),
    piPackage: await import("@legacy-server/pi-package-catalog.mjs"),
  };
  modern = {
    provider: await import("../src/main/backend/provider-catalog"),
    modelsDev: await import("../src/main/backend/models-dev-catalog"),
    plan: await import("../src/main/backend/plan-catalog"),
    piPackage: await import("../src/main/backend/pi-package-catalog"),
  };
});

afterAll(() => {
  // 恢复 CACHE_FILE 原状（用例内写入的 fake 缓存删除；原本存在则不动其内容由用例自恢复）
  if (!CACHE_EXISTS_BEFORE) {
    try { fs.rmSync(CACHE_FILE, { force: true }); } catch {}
    try { fs.rmSync(`${CACHE_FILE}.tmp`, { force: true }); } catch {}
  }
  legacy?.provider?.invalidateMergedCatalog?.();
  modern?.provider?.invalidateMergedCatalog?.();
  vi.unstubAllEnvs();
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
});

function normalize<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

describe("s3-catalog-parity models-dev-catalog", () => {
  it("导出面一致（6 项）+ STALE 常量互等", () => {
    expect(Object.keys(modern.modelsDev).sort()).toEqual(Object.keys(legacy.modelsDev).sort());
    expect(modern.modelsDev.MODELS_DEV_STALE_MS).toBe(legacy.modelsDev.MODELS_DEV_STALE_MS);
  });

  it("normalizeModelsDevProvider 全形态（npm 映射/默认协议/云平台/防御式字段）", () => {
    const cases: [string, any][] = [
      ["openai", { name: "OpenAI", npm: "@ai-sdk/openai", api: "https://api.openai.com/v1/", models: { "gpt-4o": { name: "GPT-4o", limit: { context: 128000.7, output: 16384 }, attachment: true, reasoning: true }, "gpt-4o-mini": { limit: {} } }, env: ["OPENAI_API_KEY", "", null], doc: "https://docs" }],
      ["unknown-gw", { name: "长尾网关", npm: "@ai-sdk/some-unknown", api: "https://gw.example.com/v1", models: { "m1": {} } }],
      ["anthropic", { npm: "@ai-sdk/anthropic", models: { "claude-3": { modalities: { input: ["text", "image"] } } } }],
      ["bedrock", { npm: "@ai-sdk/amazon-bedrock", models: { "us.anthropic": { name: "Bedrock Claude" } } }],
      ["azure", { npm: "@ai-sdk/azure", models: { "gpt-4o": {} } }],
      ["vertex", { npm: "@ai-sdk/google-vertex/anthropic", models: { "gemini": {} } }],
      ["no-models", { name: "空目录", models: {} }],
      ["bad-model", { models: { "m1": "not-an-object" } }],
      ["", { models: { m1: {} } }],
      ["x", "not-an-object"],
      ["y", null],
    ];
    for (const [id, raw] of cases) {
      expect(normalize(modern.modelsDev.normalizeModelsDevProvider(id, raw))).toEqual(normalize(legacy.modelsDev.normalizeModelsDevProvider(id, raw)));
    }
    const openai = modern.modelsDev.normalizeModelsDevProvider("openai", cases[0]![1]);
    expect(openai.api).toBe("openai-completions");
    expect(openai.baseUrl).toBe("https://api.openai.com/v1"); // 尾斜杠剥除
    expect(openai.models[0]!.contextWindow).toBe(128000); // 小数 floor
    expect(openai.models[0]!.maxTokens).toBe(16384);
    expect(openai.models[0]!.vision).toBe(true);
    expect(openai.models[1]!.contextWindow).toBeNull(); // 防御式缺失置 null
    expect(openai.auth.apiKey.envVars).toEqual(["OPENAI_API_KEY", "null"]); // String(null)="null" 非 falsy 保留（双侧同语义）
    expect(openai.doc).toBe("https://docs");
    expect(modern.modelsDev.normalizeModelsDevProvider("unknown-gw", cases[1]![1]).api).toBe("openai-completions"); // 未知 npm 默认协议
    expect(modern.modelsDev.normalizeModelsDevProvider("anthropic", cases[2]![1]).api).toBe("anthropic-messages");
    expect(modern.modelsDev.normalizeModelsDevProvider("bedrock", cases[3]![1]).api).toBe("bedrock-converse-stream");
    expect(modern.modelsDev.normalizeModelsDevProvider("azure", cases[4]![1]).api).toBe("azure-openai-responses");
    expect(modern.modelsDev.normalizeModelsDevProvider("vertex", cases[5]![1]).api).toBe("google-vertex");
    expect(modern.modelsDev.normalizeModelsDevProvider("no-models", cases[6]![1])).toBeNull();
    expect(modern.modelsDev.normalizeModelsDevProvider("bad-model", cases[7]![1])).toBeNull();
  });

  it("readModelsDevCache：缓存不存在 → 双侧 null；状态判定 offline/fresh/stale", () => {
    expect(modern.modelsDev.readModelsDevCache()).toBeNull();
    expect(modern.modelsDev.readModelsDevCache()).toBe(legacy.modelsDev.readModelsDevCache());
    expect(modern.modelsDev.modelsDevCacheStatus(null)).toBe("offline");
    expect(modern.modelsDev.modelsDevCacheStatus({ fetchedAt: "not-a-date" })).toBe("stale");
    const fresh = { fetchedAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString() };
    const stale = { fetchedAt: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString() };
    expect(modern.modelsDev.modelsDevCacheStatus(fresh)).toBe("fresh");
    expect(modern.modelsDev.modelsDevCacheStatus(stale)).toBe("stale");
    for (const c of [null, { fetchedAt: "x" }, fresh, stale]) {
      expect(modern.modelsDev.modelsDevCacheStatus(c)).toBe(legacy.modelsDev.modelsDevCacheStatus(c));
    }
  });

  it("writeModelsDevCache 落盘回环（写→读→删，原缓存不存在）", () => {
    expect(CACHE_EXISTS_BEFORE).toBe(false);
    const snapshot = {
      fetchedAt: new Date().toISOString(),
      source: "https://models.dev/api.json",
      providerCount: 1,
      modelCount: 1,
      providers: [{ id: "tmp-p", name: "Tmp", api: "openai-completions", baseUrl: "https://t/v1", auth: { apiKey: { name: "API key", envVars: [] }, oauth: null }, models: [{ id: "tmp-m", name: "tmp-m", contextWindow: 1000, maxTokens: null, vision: false, reasoning: false }], npm: null, doc: null }],
    };
    try {
      modern.modelsDev.writeModelsDevCache(snapshot);
      const backM = modern.modelsDev.readModelsDevCache();
      expect(backM).toEqual(snapshot);
      expect(normalize(backM)).toEqual(normalize(legacy.modelsDev.readModelsDevCache()));
      expect(modern.modelsDev.modelsDevCacheStatus()).toBe("fresh");
    } finally {
      fs.rmSync(CACHE_FILE, { force: true });
    }
    expect(fs.existsSync(CACHE_FILE)).toBe(false);
    expect(modern.modelsDev.modelsDevCacheStatus()).toBe("offline");
  });
});

describe("s3-catalog-parity provider-catalog", () => {
  it("导出面一致（8 项）", () => {
    expect(Object.keys(modern.provider).sort()).toEqual(Object.keys(legacy.provider).sort());
  });

  it("loadBuiltinCatalog：真实目录归一化全量互等", () => {
    const m = modern.provider.loadBuiltinCatalog();
    const l = legacy.provider.loadBuiltinCatalog();
    expect(normalize(m)).toEqual(normalize(l));
    expect(m.error).toBeNull();
    expect(m.providers.length).toBeGreaterThan(40); // 固化目录体量（当前 41 供应商）
    const anth = m.providers.find((p: any) => p.id === "anthropic");
    expect(anth.models.length).toBeGreaterThan(0);
    expect(anth.models[0]!.id).toBeTruthy();
  });

  it("loadMergedCatalog offline：快照退回 + sources 标记，双侧互等", () => {
    modern.provider.invalidateMergedCatalog();
    legacy.provider.invalidateMergedCatalog();
    const m = modern.provider.loadMergedCatalog();
    const l = legacy.provider.loadMergedCatalog();
    expect(normalize(m)).toEqual(normalize(l));
    expect(m.sources.modelsDev.status).toBe("offline");
    expect(m.sources.modelsDev.count).toBe(0);
    expect(m.providers.every((p: any) => p.source === "builtin")).toBe(true);
  });

  it("builtinProviderList / builtinProviderDetail / describeLoginMethods：双侧互等", () => {
    const listM = modern.provider.builtinProviderList();
    const listL = legacy.provider.builtinProviderList();
    expect(normalize(listM)).toEqual(normalize(listL));
    expect(listM.providers.length).toBeGreaterThan(40);
    expect(listM.totalModels).toBeGreaterThan(50);
    const first = listM.providers[0]!;
    expect(normalize(modern.provider.builtinProviderDetail(first.id))).toEqual(normalize(legacy.provider.builtinProviderDetail(first.id)));
    expect(modern.provider.builtinProviderDetail("__no_such__")).toBeNull();
    // 摘要投影不变式：登录方式/能力统计/sampleModels 排序截断
    const withOauth = listM.providers.find((p: any) => p.loginMethods.includes("oauth"))!;
    expect(withOauth.capabilities.visionCount).toBeGreaterThanOrEqual(0);
    expect(withOauth.sampleModels.length).toBeLessThanOrEqual(5);
    const detail = modern.provider.builtinProviderDetail(withOauth.id);
    expect(normalize(modern.provider.describeLoginMethods(detail))).toEqual(normalize(legacy.provider.describeLoginMethods(detail)));
    const oauthOnly = modern.provider.describeLoginMethods({ auth: { oauth: { name: "Claude 账号" }, apiKey: null } });
    expect(oauthOnly).toEqual([{ type: "oauth", label: "Claude 账号" }]);
    const keyFallback = modern.provider.describeLoginMethods({ auth: { oauth: null, apiKey: { name: "API key", envVars: ["MY_KEY"] } } });
    expect(keyFallback).toEqual([{ type: "apiKey", label: "MY_KEY" }]); // envVars[0] 优先
  });

  it("findBuiltinModel：带前缀/裸 id/不存在/空", () => {
    const builtin = modern.provider.loadBuiltinCatalog();
    const anth = builtin.providers.find((p: any) => p.id === "anthropic")!;
    const model = anth.models[0]!;
    const hitM = modern.provider.findBuiltinModel(model.id);
    expect(normalize(hitM)).toEqual(normalize(legacy.provider.findBuiltinModel(model.id)));
    expect(hitM.provider).toBe("anthropic");
    expect(hitM.modelName ?? hitM.name).toBeTruthy();
    const prefixed = modern.provider.findBuiltinModel(`anthropic/${model.id}`);
    expect(normalize(prefixed)).toEqual(normalize(legacy.provider.findBuiltinModel(`anthropic/${model.id}`)));
    // 索引先查完整 id 再查剥前缀：固化目录里网关（vercel-ai-gateway）模型 id 自带
    // "anthropic/" 前缀 → 完整 id 直接命中网关副本（第一方优先序只约束"同 id 不被覆盖"，
    // 不同 id 的网关副本照常入库）
    expect(prefixed.provider).toBe("vercel-ai-gateway");
    expect(modern.provider.findBuiltinModel("__no_such_model__")).toBeNull();
    expect(modern.provider.findBuiltinModel("")).toBeNull();
  });

  it("buildBuiltinImport：可导入构造互等（截断/剥尾/modelIds 过滤/enabled）+ 拦截文案", () => {
    const list = modern.provider.builtinProviderList();
    const importable = list.providers.find((p: any) => p.importable === true && p.modelCount >= 2)!;
    const longName = "很长的供应商名称".repeat(40);
    const builtM = modern.provider.buildBuiltinImport(importable.id, {
      name: longName,
      baseUrl: "https://gateway.example.com/api///",
      modelIds: list.providers.find((p: any) => p.id === importable.id) ? undefined : undefined,
      enabled: false,
    });
    const builtL = legacy.provider.buildBuiltinImport(importable.id, {
      name: longName,
      baseUrl: "https://gateway.example.com/api///",
      enabled: false,
    });
    expect(normalize(builtM)).toEqual(normalize(builtL));
    expect(builtM.name.length).toBe(160); // 截断
    expect(builtM.baseUrl).toBe("https://gateway.example.com/api"); // 剥尾斜杠
    expect(builtM.enabled).toBe(false);
    expect(builtM.models.length).toBeGreaterThan(0);
    expect(builtM.models[0]!.enabled).toBe(true);
    // modelIds 过滤
    const detail = modern.provider.builtinProviderDetail(importable.id);
    const wantIds = detail.models.slice(0, 2).map((m: any) => m.id);
    const filteredM = modern.provider.buildBuiltinImport(importable.id, { modelIds: wantIds });
    const filteredL = legacy.provider.buildBuiltinImport(importable.id, { modelIds: wantIds });
    expect(normalize(filteredM)).toEqual(normalize(filteredL));
    expect(filteredM.models.map((m: any) => m.id)).toEqual(wantIds);
    expect(filteredM.models[0]!.input).toEqual(detail.models[0]!.vision ? ["text", "image"] : ["text"]);
    // 拦截文案：不存在 / 云平台 / 协议不支持
    expect(() => modern.provider.buildBuiltinImport("__no_such__")).toThrow("内置供应商不存在：__no_such__");
    const bedrock = list.providers.find((p: any) => p.api === "bedrock-converse-stream");
    if (bedrock) {
      const msgM = (() => { try { modern.provider.buildBuiltinImport(bedrock.id); return ""; } catch (e: any) { return e.message; } })();
      const msgL = (() => { try { legacy.provider.buildBuiltinImport(bedrock.id); return ""; } catch (e: any) { return e.message; } })();
      expect(msgM).toBe(msgL);
      expect(msgM).toBe("使用云平台凭证（AWS / GCP）授权，不走 API Key，请用对应云平台配置");
    }
  });

  it("合并层：fake models-dev 缓存 → invalidate → 合并语义互等（元数据保留/新模型补充/contextWindow 补齐/source 标记）", () => {
    const builtin = modern.provider.loadBuiltinCatalog();
    const anth = builtin.providers.find((p: any) => p.id === "anthropic")!;
    const existingModel = anth.models[0]!;
    const fakeSnapshot = {
      fetchedAt: new Date().toISOString(),
      source: "https://models.dev/api.json",
      providerCount: 2,
      modelCount: 3,
      providers: [
        {
          id: "new-dev-provider",
          name: "New Dev Provider",
          api: "openai-completions",
          baseUrl: "https://new-dev.example.com/v1",
          auth: { apiKey: { name: "API key", envVars: ["NEW_KEY"] }, oauth: null },
          models: [{ id: "new-m1", name: "New M1", contextWindow: 999999, maxTokens: null, vision: false, reasoning: false }],
          npm: "@ai-sdk/openai",
          doc: null,
        },
        {
          id: "anthropic",
          name: "Anthropic (dev 命名不同)",
          api: "anthropic-messages",
          baseUrl: "https://dev.anthropic.com",
          auth: { apiKey: { name: "API key", envVars: ["ANTHROPIC_API_KEY"] }, oauth: null },
          models: [
            { id: existingModel.id, name: "dev 改名", contextWindow: null, maxTokens: null, vision: false, reasoning: false }, // 触发 contextWindow 补齐
            { id: "claude-brand-new", name: "Brand New", contextWindow: 200000, maxTokens: null, vision: true, reasoning: true }, // 快照缺失模型补充
          ],
          npm: "@ai-sdk/anthropic",
          doc: null,
        },
      ],
    };
    try {
      modern.modelsDev.writeModelsDevCache(fakeSnapshot);
      modern.provider.invalidateMergedCatalog();
      legacy.provider.invalidateMergedCatalog();
      const m = modern.provider.loadMergedCatalog();
      const l = legacy.provider.loadMergedCatalog();
      expect(normalize(m)).toEqual(normalize(l));
      expect(m.sources.modelsDev.status).toBe("fresh");
      expect(m.sources.modelsDev.count).toBe(2);
      const newDev = m.providers.find((p: any) => p.id === "new-dev-provider")!;
      expect(newDev.source).toBe("models-dev"); // 快照外整条来自 models.dev
      const mergedAnth = m.providers.find((p: any) => p.id === "anthropic")!;
      expect(mergedAnth.source).toBe("builtin");
      expect(mergedAnth.name).not.toBe("Anthropic (dev 命名不同)"); // 快照元数据优先
      expect(mergedAnth.auth.oauth).toBeTruthy(); // OAuth 声明继承自快照（models.dev 不携带）
      const patched = mergedAnth.models.find((x: any) => x.id === existingModel.id)!;
      expect(patched.contextWindow).toBe(existingModel.contextWindow); // 缺失时由 dev 补齐（快照值优先）
      expect(mergedAnth.models.some((x: any) => x.id === "claude-brand-new")).toBe(true); // 新模型补充
      // 合并后模型反查命中新供应商条目（FIRST_PARTY 优先序之外的网关副本不覆盖第一方）
      expect(normalize(modern.provider.findBuiltinModel("new-m1"))).toEqual(normalize(legacy.provider.findBuiltinModel("new-m1")));
      expect(modern.provider.findBuiltinModel("new-m1").provider).toBe("new-dev-provider");
    } finally {
      if (!CACHE_EXISTS_BEFORE) fs.rmSync(CACHE_FILE, { force: true });
      modern.provider.invalidateMergedCatalog();
      legacy.provider.invalidateMergedCatalog();
    }
  });
});

describe("s3-catalog-parity plan-catalog", () => {
  it("导出面一致（5 项）+ PLAN_PRESETS 常量互等", () => {
    expect(Object.keys(modern.plan).sort()).toEqual(Object.keys(legacy.plan).sort());
    expect(normalize(modern.plan.PLAN_PRESETS)).toEqual(normalize(legacy.plan.PLAN_PRESETS));
    expect(modern.plan.PLAN_PRESETS).toHaveLength(1);
    expect(modern.plan.PLAN_PRESETS[0]!.planId).toBe("opencode-zen-go");
  });

  it("listPlans：空 tmp 配置 → 未接入投影；接入后 connected 投影互等", async () => {
    const beforeM = modern.plan.listPlans();
    const beforeL = legacy.plan.listPlans();
    expect(normalize(beforeM)).toEqual(normalize(beforeL));
    expect(beforeM[0]!.providerId).toBe("PLAN_OPENCODE_ZEN_GO");
    expect(beforeM[0]!.hasKey).toBe(false);
    expect(beforeM[0]!.connected).toBe(false);
    expect(beforeM[0]!.totalModels).toBe(0);
    // 写面：applyPlan（显式 modelIds 绕过网络拉取；key 首尾空白由 trim 落盘）
    const appliedM = await modern.plan.applyPlan({ planId: "opencode-zen-go", apiKey: "  sk-test-123  ", modelIds: ["m-1", "m-2"] });
    const appliedL = await legacy.plan.applyPlan({ planId: "opencode-zen-go", apiKey: "  sk-test-123  ", modelIds: ["m-1", "m-2"] });
    expect(normalize(appliedM)).toEqual(normalize(appliedL));
    expect(appliedM).toEqual({ ok: true, providerId: "PLAN_OPENCODE_ZEN_GO", planId: "opencode-zen-go", modelCount: 2 });
    const afterM = modern.plan.listPlans();
    const afterL = legacy.plan.listPlans();
    expect(normalize(afterM)).toEqual(normalize(afterL));
    expect(afterM[0]!.hasKey).toBe(true);
    expect(afterM[0]!.connected).toBe(true);
    expect(afterM[0]!.modelCount).toBe(2);
    // 断开：移除 provider 与凭据
    const discM = modern.plan.disconnectPlan({ planId: "opencode-zen-go" });
    const discL = legacy.plan.disconnectPlan({ planId: "opencode-zen-go" });
    expect(normalize(discM)).toEqual(normalize(discL));
    expect(discM).toEqual({ ok: true, providerId: "PLAN_OPENCODE_ZEN_GO" });
    expect(normalize(modern.plan.listPlans())).toEqual(normalize(legacy.plan.listPlans()));
    expect(modern.plan.listPlans()[0]!.connected).toBe(false);
  });

  it("applyPlan/disconnectPlan 拦截分支：未知套餐 / 缺少 Key（文案逐字，均不触发网络）", async () => {
    await expect(modern.plan.applyPlan({ planId: "__nope__", apiKey: "k" })).resolves.toEqual({ ok: false, error: "未知套餐" });
    await expect(legacy.plan.applyPlan({ planId: "__nope__", apiKey: "k" })).resolves.toEqual({ ok: false, error: "未知套餐" });
    await expect(modern.plan.applyPlan({ planId: "opencode-zen-go" })).resolves.toEqual({ ok: false, error: "缺少 API Key" });
    await expect(legacy.plan.applyPlan({ planId: "opencode-zen-go" })).resolves.toEqual({ ok: false, error: "缺少 API Key" });
    expect(modern.plan.disconnectPlan({ planId: "__nope__" })).toEqual({ ok: false, error: "未知套餐" });
    expect(legacy.plan.disconnectPlan({ planId: "__nope__" })).toEqual({ ok: false, error: "未知套餐" });
  });
});

describe("s3-catalog-parity pi-package-catalog", () => {
  it("导出面一致（2 项）", () => {
    expect(Object.keys(modern.piPackage).sort()).toEqual(Object.keys(legacy.piPackage).sort());
  });

  it("resolveInstalledPiPackage：未安装 → 异常文案逐字", () => {
    const msgM = (() => { try { modern.piPackage.resolveInstalledPiPackage("some-not-installed-pkg"); return ""; } catch (e: any) { return e.message; } })();
    const msgL = (() => { try { legacy.piPackage.resolveInstalledPiPackage("some-not-installed-pkg"); return ""; } catch (e: any) { return e.message; } })();
    expect(msgM).toBe(msgL);
    expect(msgM).toBe("这个 Pi 包尚未安装在当前 Pi 包目录，未作任何下载或执行。");
  });
});
