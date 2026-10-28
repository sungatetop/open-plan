/**
 * F5-5 style.json 动态读通道对拍（map-direct.ts invokeMapDataStyle）。
 *
 * 对拍锚点（server/index.mjs L592-608 动态路由 + desktop 扩展声明）：
 *   - manifest：op:map:data:style 入 MAP_DIRECT_CHANNELS（44 通道）且路由
 *     GET /api/map/data/:project/style.json；
 *   - 404 面：project 白名单拒绝（mapProjectDir → null）/ 目录缺失（dirProbe.exists=false）
 *     同信封 { error: "style not found" }；
 *   - 500 面：readStyleFile 抛错 / JSON 解析失败（err500 信封）；
 *   - 成功面：hydrate 底图注入（deps 透传）+ tiles 数组逐项绝对化 + glyphs 根相对绝对化 +
 *     geojson source.data 桌面扩展绝对化（绝对 URL 不动）→ { text: JSON.stringify(style) }；
 *   - 桌面扩展语义差异声明（含在 map-direct.ts 注释内）：server 正则路由 ([^/]+) 对 ".."
 *     无白名单（历史形态），桌面侧沿用 map.ts projectDir 白名单收紧，非法名同 404 信封。
 *
 * 本文件为纯编排测试：deps 全桩，不加载 map 域实现。
 */
import { describe, expect, test, beforeAll, vi } from "vitest";
import { join } from "node:path";
import type * as MapModule from "../src/main/ipc/map-direct";
import { DESKTOP_CHANNELS } from "../src/shared/protocol/channels";

type MapSvc = typeof MapModule;
let svc: MapSvc;

beforeAll(async () => {
  svc = await import("../src/main/ipc/map-direct");
});

const PORT = 3002;
const ORIGIN = `http://127.0.0.1:${PORT}`;

/** 最小 deps：invokeMapDataStyle 只消费 mapProjectDir / dirProbe / hydrateBasemapSources / readStyleFile / exportViewPort。 */
function makeDeps(overrides: {
  projectDir?: unknown;
  exists?: boolean;
  styleText?: string | Error;
  hydrate?: (style: unknown) => unknown;
} = {}) {
  return {
    mapProjectDir: vi.fn((name: unknown) => (typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name) ? `W:\\ws\\maps\\${name}` : null)),
    dirProbe: vi.fn((file: string) => ({ exists: overrides.exists ?? true, isDirectory: true, __file: file })),
    hydrateBasemapSources: vi.fn(overrides.hydrate ?? ((style: unknown) => style)),
    readStyleFile: vi.fn((file: string) => {
      if (overrides.styleText instanceof Error) throw overrides.styleText;
      return overrides.styleText ?? "{}";
    }),
    exportViewPort: vi.fn(() => PORT)
  } as never as MapModule.MapDirectDeps;
}

function invoke(envelope: Record<string, unknown>, deps = makeDeps()) {
  return svc.invokeMapDirect("op:map:data:style", envelope as never, deps);
}

describe("F5-5 manifest 锚点", () => {
  test("op:map:data:style 入清单（44 通道）且路由指向动态路由审计路径", () => {
    expect(svc.MAP_DIRECT_CHANNELS).toHaveLength(44);
    expect(svc.MAP_DIRECT_CHANNELS).toContain("op:map:data:style");
    expect(DESKTOP_CHANNELS["op:map:data:style"]).toEqual({
      method: "GET",
      path: "/api/map/data/:project/style.json"
    });
  });
});

describe("F5-5 404 面（server L597 next() 透传 static → 404 的桌面等价形态）", () => {
  test("project 白名单拒绝（含 ../ 穿越）→ 404 { error: style not found }", async () => {
    for (const project of ["../escape", "a/b", "", undefined]) {
      const result = await invoke({ query: { project } as never });
      expect(result).toEqual({ ok: false, status: 404, data: { error: "style not found" } });
    }
  });

  test("白名单通过但 style.json 不存在 → dirProbe 探测 join(dir, style.json) → 404", async () => {
    const deps = makeDeps({ exists: false });
    const result = await invoke({ query: { project: "demo" } }, deps);
    expect(result).toEqual({ ok: false, status: 404, data: { error: "style not found" } });
    expect(deps.mapProjectDir).toHaveBeenCalledWith("demo");
    expect(deps.dirProbe).toHaveBeenCalledWith(join("W:\\ws\\maps\\demo", "style.json"));
  });
});

describe("F5-5 500 面（server L608 catch res.status(500) 等价）", () => {
  test("readStyleFile 抛错 → 500 { error: 消息 }", async () => {
    const result = await invoke({ query: { project: "demo" } }, makeDeps({ styleText: new Error("磁盘 IO 失败") }));
    expect(result).toEqual({ ok: false, status: 500, data: { error: "磁盘 IO 失败" } });
  });

  test("JSON 解析失败 → 500（err500 信封）", async () => {
    const result = await invoke({ query: { project: "demo" } }, makeDeps({ styleText: "not-json{{" }));
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect((result.data as Record<string, unknown>).error).toBeTruthy();
  });
});

describe("F5-5 成功面（hydrate + 绝对化 + text 载数据）", () => {
  test("tiles 数组逐项绝对化 + glyphs 绝对化 + geojson data 桌面扩展绝对化；绝对 URL 不动", async () => {
    const style = {
      version: 8,
      glyphs: "/glyphs/{fontstack}/{range}.pbf",
      sources: {
        roads: { type: "vector", tiles: ["/api/map/data/demo/tiles/roads/{z}/{x}/{y}.pbf"] },
        agent: { type: "geojson", data: "/api/map/data/demo/layers/agent-analysis.geojson" },
        osm: { type: "raster", tiles: ["https://tile.example.com/{z}/{x}/{y}.png"] }
      },
      layers: [{ id: "basemap-gaode-road", type: "line" }]
    };
    const deps = makeDeps({ styleText: JSON.stringify(style) });
    const result = await invoke({ query: { project: "demo" } }, deps);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    const text = (result.data as { text: string }).text;
    const out = JSON.parse(text);
    // hydrate 在 main 侧透传（getBasmaps 运行时注入在域实现内，编排层只做 JSON.parse → hydrate）
    expect(deps.hydrateBasemapSources).toHaveBeenCalledTimes(1);
    // tiles：根相对 → sidecar origin 绝对；绝对 URL 原样保留
    expect(out.sources.roads.tiles).toEqual([`${ORIGIN}/api/map/data/demo/tiles/roads/{z}/{x}/{y}.pbf`]);
    expect(out.sources.osm.tiles).toEqual(["https://tile.example.com/{z}/{x}/{y}.png"]);
    // geojson source.data：桌面形态扩展（server 同源形态无此步）
    expect(out.sources.agent.data).toBe(`${ORIGIN}/api/map/data/demo/layers/agent-analysis.geojson`);
    // glyphs：MapLibre 字体资产按 sidecar origin 解析
    expect(out.glyphs).toBe(`${ORIGIN}/glyphs/{fontstack}/{range}.pbf`);
    // 其余字段原样保留（零迁移）
    expect(out.version).toBe(8);
    expect(out.layers).toEqual([{ id: "basemap-gaode-road", type: "line" }]);
  });

  test("hydrate 结果被消费（桩返回增强对象），响应 text 为增强后样式", async () => {
    const enriched = { version: 8, sources: { injected: { type: "geojson", data: "/x.geojson" } }, layers: [] };
    const deps = makeDeps({ styleText: "{}", hydrate: () => enriched });
    const result = await invoke({ query: { project: "demo" } }, deps);
    const out = JSON.parse((result.data as { text: string }).text);
    expect(out.sources.injected.data).toBe(`${ORIGIN}/x.geojson`);
  });

  test("port 取自 exportViewPort（sidecar 视口注入 origin）", async () => {
    const deps = makeDeps({ styleText: JSON.stringify({ glyphs: "/glyphs/p" }) });
    (deps as unknown as { exportViewPort: ReturnType<typeof vi.fn> }).exportViewPort.mockReturnValue(3210);
    const result = await invoke({ query: { project: "demo" } }, deps);
    expect(JSON.parse((result.data as { text: string }).text).glyphs).toBe("http://127.0.0.1:3210/glyphs/p");
  });
});
