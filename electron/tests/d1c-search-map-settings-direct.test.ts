/**
 * D-1c 联网搜索配置与地图底图设置直调对拍（search-map-settings-direct.ts 编排层）。
 *
 * 覆盖面（行号锚点均指 server/index.mjs）：
 *   - manifest 锚点：5 通道全部在 DESKTOP_CHANNELS 且路由指向已审计路径；unknown → 404；
 *   - search:settings:get（L2056-2062）：{ ok:true, backends, settings }；抛错 500 {ok:false,error}；
 *   - search:settings:save（L2064-2071）：{ ok:true, settings }（body 传参）；抛错 500；
 *   - search:test（L2073-2081）：result 整体透传（backend 缺省 "" + draft 透传）；
 *     抛错 500 { ok:false, category:"unknown", message }；
 *   - map:settings:get（L5404-5414）：四 Key 只回传布尔（Key 原文不泄露）；
 *   - map:settings:save（L5417-5435）：save → listProjects → 循环 rebuild →
 *     { ok:true, basemaps 投影, projects }；抛错 500 { error }（无 ok:false——忠实转录）。
 *
 * 本文件为纯编排测试：deps 全桩，不加载 web-search/map 域实现。
 */
import { describe, expect, test, beforeAll, vi } from "vitest";
import type * as SearchMapModule from "../src/main/ipc/search-map-settings-direct";
import { DESKTOP_CHANNELS, type InvokeEnvelope } from "../src/shared/protocol/channels";

type SearchMap = typeof SearchMapModule;
let svc: SearchMap;

beforeAll(async () => {
  svc = await import("../src/main/ipc/search-map-settings-direct");
});

const BACKENDS = Object.freeze([
  { id: "tavily", name: "Tavily", needsKey: true },
  { id: "none", name: "无", needsKey: false }
]);

function makeDeps(overrides: Partial<SearchMapModule.SearchMapSettingsDirectDeps> = {}) {
  return {
    searchBackends: BACKENDS,
    publicSearchSettings: vi.fn(() => ({ backend: "tavily", apiKey: "***" })),
    saveSearchSettings: vi.fn((input: Record<string, any>) => ({ backend: input.backend ?? "none", apiKey: "***" })),
    testSearchBackend: vi.fn(async () => ({ ok: true, category: "ok", message: "连通", hits: 3 })),
    loadMapSettings: vi.fn(() => ({ basemaps: { tiandituKey: "abc", maptilerKey: "", geoapifyKey: undefined, esriToken: "tok" } })),
    saveMapSettings: vi.fn((basemaps: Record<string, any>) => ({ basemaps: { ...basemaps, tiandituKey: "new-key" } })),
    listProjects: vi.fn(() => [{ project: "demo" }, { project: "xinchang" }]),
    rebuildBasemapStyle: vi.fn(() => undefined),
    ...overrides
  } as never as SearchMapModule.SearchMapSettingsDirectDeps & Record<string, ReturnType<typeof vi.fn>>;
}

function invoke(channel: SearchMapModule.SearchMapSettingsDirectChannel, envelope: InvokeEnvelope | undefined, deps = makeDeps()) {
  return svc.invokeSearchMapSettingsDirect(channel, envelope, deps);
}

describe("D-1c manifest 锚点", () => {
  test("5 条通道全部在 DESKTOP_CHANNELS 且路由指向已审计路径", () => {
    expect(svc.SEARCH_MAP_SETTINGS_DIRECT_CHANNELS).toHaveLength(5);
    const expectedRoutes: Record<string, { method: string; path: string }> = {
      "op:search:settings:get": { method: "GET", path: "/api/search/settings" },
      "op:search:settings:save": { method: "POST", path: "/api/search/settings" },
      "op:search:test": { method: "POST", path: "/api/search/test" },
      "op:map:settings:get": { method: "GET", path: "/api/map/settings" },
      "op:map:settings:save": { method: "POST", path: "/api/map/settings" }
    };
    for (const channel of svc.SEARCH_MAP_SETTINGS_DIRECT_CHANNELS) {
      expect(DESKTOP_CHANNELS[channel as keyof typeof DESKTOP_CHANNELS]).toEqual(expectedRoutes[channel]);
    }
  });

  test("unknown channel → 404", async () => {
    const result = await svc.invokeSearchMapSettingsDirect("op:search:history" as never, {}, makeDeps());
    expect(result).toEqual({ ok: false, status: 404, data: { error: "unknown channel: op:search:history" } });
  });
});

describe("D-1c op:search:settings:*（L2056-2071）", () => {
  test("get → { ok:true, backends, settings }（backends 为冻结清单引用）", async () => {
    const result = await invoke("op:search:settings:get", {});
    expect(result).toEqual({ ok: true, status: 200, data: { ok: true, backends: BACKENDS, settings: { backend: "tavily", apiKey: "***" } } });
  });

  test("get 抛错 → 500 { ok:false, error }", async () => {
    const result = await invoke("op:search:settings:get", {}, makeDeps({
      publicSearchSettings: vi.fn(() => { throw new Error("settings 文件损坏"); })
    }));
    expect(result).toEqual({ ok: false, status: 500, data: { ok: false, error: "settings 文件损坏" } });
  });

  test("save → { ok:true, settings }（body 整体传参）", async () => {
    const saveFn = vi.fn((input: Record<string, any>) => ({ backend: input.backend, apiKey: "***" }));
    const result = await invoke("op:search:settings:save", { body: { backend: "tavily", apiKey: "sk-x" } }, makeDeps({ saveSearchSettings: saveFn }));
    expect(saveFn).toHaveBeenCalledWith({ backend: "tavily", apiKey: "sk-x" });
    expect(result).toEqual({ ok: true, status: 200, data: { ok: true, settings: { backend: "tavily", apiKey: "***" } } });
  });

  test("save 抛错（非法输入）→ 500 { ok:false, error }", async () => {
    const result = await invoke("op:search:settings:save", { body: {} }, makeDeps({
      saveSearchSettings: vi.fn(() => { throw new Error("未知 backend"); })
    }));
    expect(result).toEqual({ ok: false, status: 500, data: { ok: false, error: "未知 backend" } });
  });
});

describe("D-1c op:search:test（L2073-2081）", () => {
  test("成功 → result 整体透传（backend 缺省空串、draft 原样透传）", async () => {
    const testFn = vi.fn(async (backend: string, options?: { draft?: Record<string, any> }) => ({ ok: true, category: "ok", message: "连通", hits: 3 }));
    const result = await invoke("op:search:test", { body: { draft: { apiKey: "draft-key" } } }, makeDeps({ testSearchBackend: testFn }));
    expect(testFn).toHaveBeenCalledWith("", { draft: { apiKey: "draft-key" } });
    expect(result).toEqual({ ok: true, status: 200, data: { ok: true, category: "ok", message: "连通", hits: 3 } });
    await invoke("op:search:test", { body: { backend: "tavily" } }, makeDeps({ testSearchBackend: testFn }));
    expect(testFn).toHaveBeenLastCalledWith("tavily", { draft: undefined });
  });

  test("抛错 → 500 { ok:false, category:unknown, message }", async () => {
    const result = await invoke("op:search:test", { body: { backend: "tavily" } }, makeDeps({
      testSearchBackend: vi.fn(async () => { throw new Error("网络不可达"); })
    }));
    expect(result).toEqual({ ok: false, status: 500, data: { ok: false, category: "unknown", message: "网络不可达" } });
  });
});

describe("D-1c op:map:settings:*（L5404-5435）", () => {
  test("get → 四 Key 只回传布尔（Key 原文不泄露）", async () => {
    const result = await invoke("op:map:settings:get", {});
    expect(result).toEqual({
      ok: true,
      status: 200,
      data: { basemaps: { tiandituKey: true, maptilerKey: false, geoapifyKey: false, esriToken: true } }
    });
  });

  test("save → 全项目 rebuild 后 { ok:true, basemaps 投影, projects }", async () => {
    const rebuildFn = vi.fn(() => undefined);
    const result = await invoke("op:map:settings:save", { body: { basemaps: { tiandituKey: "new-key" } } }, makeDeps({ rebuildBasemapStyle: rebuildFn }));
    expect(rebuildFn).toHaveBeenCalledTimes(2);
    expect(rebuildFn).toHaveBeenNthCalledWith(1, "demo");
    expect(rebuildFn).toHaveBeenNthCalledWith(2, "xinchang");
    expect(result).toEqual({
      ok: true,
      status: 200,
      data: {
        ok: true,
        basemaps: { tiandituKey: true, maptilerKey: false, geoapifyKey: false, esriToken: false },
        projects: ["demo", "xinchang"]
      }
    });
  });

  test("save basemaps 缺省 {} → 全 false 投影", async () => {
    const result = await invoke("op:map:settings:save", { body: {} }, makeDeps({
      saveMapSettings: vi.fn(() => ({ basemaps: null }))
    }));
    expect((result.data as Record<string, unknown>).basemaps).toEqual({
      tiandituKey: false, maptilerKey: false, geoapifyKey: false, esriToken: false
    });
  });

  test("save 抛错 → 500 { error }（无 ok:false——忠实转录）", async () => {
    const result = await invoke("op:map:settings:save", { body: { basemaps: {} } }, makeDeps({
      saveMapSettings: vi.fn(() => { throw new Error("settings 写入失败"); })
    }));
    expect(result).toEqual({ ok: false, status: 500, data: { error: "settings 写入失败" } });
    expect((result.data as Record<string, unknown>).ok).toBeUndefined();
  });
});
