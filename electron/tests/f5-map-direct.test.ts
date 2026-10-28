/**
 * F5-1/F5-2/F5-3 地图域直调对拍（map-direct.ts 编排层）。
 *
 * 覆盖面（行号锚点均指 server/index.mjs）：
 *   - manifest 锚点：43 通道全部在 DESKTOP_CHANNELS 且路由指向已审计路径；unknown → 404；
 *   - 项目族（L615-702）：list/create（201+409 集合）/project get（layerViews 增补静默）/
 *     export（flag 404 + zip base64 载数据 + 404/413/500）/duplicate/rename（409+403）/
 *     archive（404）/delete（403/404）；
 *   - 样式配置/导入/瓦片/图层族（L704-779）：style/config 400、import（geojson 守卫 +
 *     clientError 正则 400）、import:batch（items 守卫）、prepare（invalid dir + 目录
 *     不存在 + 两脚本链 + 输出尾截）、rebuild 400、layer:delete 透传、layer:get 404；
 *   - 空间查询（L781-796）：isochrone/route 守卫 + r.error 400 + 响应投影；
 *   - 项目命名路由族（L5438-5506）：detail/style/config/import/rebuild-tiles/
 *     layer GET+DELETE/isochrone（:name + :layerId params 透传，500 版错误面）；
 *   - 分析可视化族（F5-2，L5194-5254 / L5508-5585 / L799-825）：visual:sources/
 *     visual:get（dataset 五分支 + 未知 400）/M2 分析四路由（sendMapAnalysis 语义：
 *     error==="项目不存在" → 404）/multi-isochrone/demo-analysis（生效段原始透传 +
 *     {error,code,detail} 500 信封）/cambodia-od/m3:*（getXinchangBus 四 kind）。
 *     /api/bus/* 为 L5714 404 catch-all 遮蔽的死路由，不登记通道（死路由声明）；
 *   - 报告导出模板族（F5-3，L5259-5401）：report（flag 404 + workspace 归一回退 +
 *     400 词集 + basename 投影）/export:batch:start（flag 404 + 串行锁 409 + 计划 400 +
 *     jobs 投影 + 后台状态机 completed/completed-with-failures/failed + onProgress 写回）/
 *     export:batch:status（404 未知 id + 快照白名单）/template:od-commuter（flag 404 +
 *     {ok:true,...result} + 400 词集 + ok:false 信封）/executeExportJob 内联转录
 *     （browser 七函数序列 + png/pdf 分支 + pageError + 越界拒绝 + 落盘）。
 *
 * 本文件为纯编排测试：deps 全桩，不加载 map/layer-repository/project-pack/
 * map-visualization 域实现。
 */
import { describe, expect, test, beforeAll, vi } from "vitest";
import type * as MapModule from "../src/main/ipc/map-direct";
import { DESKTOP_CHANNELS, type InvokeEnvelope } from "../src/shared/protocol/channels";

type MapSvc = typeof MapModule;
let svc: MapSvc;

beforeAll(async () => {
  svc = await import("../src/main/ipc/map-direct");
});

function makeDeps(overrides: Partial<MapModule.MapDirectDeps> = {}) {
  return {
    listProjects: vi.fn(() => [{ project: "zhejiang-map" }, { project: "demo" }]),
    createProject: vi.fn((input: Record<string, unknown>) => ({
      config: { project: input.project ?? "new-proj" },
      style: { version: 8 },
      files: ["layers/a.geojson"]
    })),
    getProject: vi.fn((name: unknown) => ({ config: { project: name }, style: {} })),
    duplicateProject: vi.fn(() => ({ config: { project: "copy" } })),
    renameProject: vi.fn(() => ({ config: { project: "renamed" } })),
    archiveProject: vi.fn(() => ({ project: "demo", archived: true })),
    deleteProject: vi.fn(() => ({ removed: ["demo"] })),
    saveStyle: vi.fn(() => true),
    saveConfig: vi.fn(() => true),
    importLayer: vi.fn(async () => ({ ok: true, layerId: "roads" })),
    importBatch: vi.fn(async () => ({ ok: true, count: 2 })),
    rebuildTiles: vi.fn(() => ({ roads: 12 })),
    deleteLayer: vi.fn(() => ({ ok: true })),
    getLayer: vi.fn(() => ({ type: "FeatureCollection", features: [] })),
    isochrone: vi.fn(async () => ({ center: [120, 30], cost: 30, polygons: {} })),
    route: vi.fn(async () => ({ provider: "osrm", distance: 1000, duration: 600, geometry: {} })),
    listLayers: vi.fn(() => [{ id: "roads", origin: "shared" }]),
    buildProjectZip: vi.fn(async () => ({
      fileName: "demo.zip",
      manifest: { project: "demo" },
      stats: { files: 3, bytes: 1024 },
      buffer: Buffer.from("ZIPDATA")
    })),
    getWorkspace: vi.fn(() => "W:\\ws"),
    projectDir: "P:\\proj",
    dirProbe: vi.fn(() => ({ exists: true, isDirectory: true })),
    runScript: vi.fn(async (script: string) => ({ code: 0, out: `ran ${script}` })),
    mapPackEnabled: vi.fn(() => true),
    // F5-2 分析可视化族桩
    getTrafficBandwidth: vi.fn(() => ({ geojson: { type: "FeatureCollection", features: [] }, stats: { max: 10 } })),
    getODLines: vi.fn(() => ({ geojson: { type: "FeatureCollection", features: [] }, stats: { levels: [] } })),
    multiIsochrone: vi.fn(async () => ({ location: [120, 30], polygons: {} })),
    getExchangeSankey: vi.fn(() => ({ nodes: [], links: [] })),
    getRoadStructure: vi.fn(() => ({ total: 100 })),
    visualListSources: vi.fn(() => [{ id: "local-file" }, { id: "bundled-xinchang" }]),
    visualLoadSource: vi.fn(async () => ({ v: 1, kind: "flow", id: "local-file" })),
    fromTrafficBandwidth: vi.fn(() => ({ id: "m2-traffic-bandwidth" })),
    fromOdLines: vi.fn(() => ({ id: "m2-od-lines" })),
    fromCambodiaOd: vi.fn(() => ({ id: "cambodia-od" })),
    fromDemoAnalysis: vi.fn(() => ({ id: "agent-analysis" })),
    cambodiaGetCambodiaOD: vi.fn(() => ({ lines: { type: "FeatureCollection", features: [] }, points: { type: "FeatureCollection", features: [] } })),
    analysisCreateDemoAnalysis: vi.fn(() => ({ analysis: "heatmap", geojson: { type: "FeatureCollection", features: [] } })),
    analysisGetCambodiaOD: vi.fn(() => ({ error: null, source: "demo" })),
    getXinchangBus: vi.fn((kind: string) => ({ kind })),
    demoCreateDemoAnalysis: vi.fn(() => ({ analysis: "od", id: "agent-od-analysis" })),
    plannedSources: vi.fn(() => [{ id: "planned-a" }]),
    // F5-3 报告导出模板族桩
    normalizeWorkspace: vi.fn((dir: string) => (dir ? `N:\\ws\\${dir}` : null)),
    mapReportEnabled: vi.fn(() => true),
    buildMapReport: vi.fn(async () => ({ file: "N:\\ws\\报告.md", blocks: 3, images: 2 })),
    mapExportEnabled: vi.fn(() => true),
    planExportJobs: vi.fn(() => ({
      jobs: [{ id: "j1", project: "p1", layers: ["roads"], sizeId: "hd", sizeLabel: "1920x1080", width: 1920, height: 1080, format: "png", fileName: "p1.png" }],
      errors: [],
      skipped: []
    })),
    runExportQueue: vi.fn(async (jobs: any[], executor: (job: any) => Promise<{ file: string; bytes: number }>, opts?: { onProgress?: (s: unknown) => void }) => {
      const results: unknown[] = [];
      for (const j of jobs) {
        results.push(await executor(j));
        opts?.onProgress?.({ total: jobs.length, done: results.length, failed: 0, results });
      }
      return { total: jobs.length, done: jobs.length, failed: 0, results };
    }),
    mapTemplatesEnabled: vi.fn(() => true),
    runOdCommuterTemplate: vi.fn(async () => ({ project: "od-proj", file: "N:\\ws\\od.md" })),
    browserSessionKey: vi.fn((clientId: string, threadId: string) => `${clientId}|${threadId}`),
    browserOpen: vi.fn(async () => ({})),
    browserResize: vi.fn(async () => ({})),
    browserWaitForExpression: vi.fn(async () => true),
    browserEvaluateValue: vi.fn(async () => ""),
    browserPrintToPdf: vi.fn(async () => ({ base64: "UERG" })),
    browserScreenshot: vi.fn(async () => ({ base64: "UE5H" })),
    exportViewPort: vi.fn(() => 3002),
    ensureDir: vi.fn(() => undefined),
    writeFile: vi.fn(() => undefined),
    ...overrides
  } as never as MapModule.MapDirectDeps & Record<string, ReturnType<typeof vi.fn>>;
}

function invoke(channel: MapModule.MapDirectChannel, envelope: InvokeEnvelope | undefined, deps = makeDeps()) {
  return svc.invokeMapDirect(channel, envelope, deps);
}

describe("F5-1/F5-2 manifest 锚点", () => {
  test("44 条通道全部在 DESKTOP_CHANNELS 且路由指向已审计路径", () => {
    expect(svc.MAP_DIRECT_CHANNELS).toHaveLength(44);
    const expectedRoutes: Record<string, { method: string; path: string }> = {
      "op:map:projects:list": { method: "GET", path: "/api/map/projects" },
      "op:map:projects:create": { method: "POST", path: "/api/map/projects" },
      "op:map:project:get": { method: "GET", path: "/api/map/project" },
      "op:map:project:export": { method: "GET", path: "/api/map/project/export" },
      "op:map:projects:duplicate": { method: "POST", path: "/api/map/projects/duplicate" },
      "op:map:projects:rename": { method: "POST", path: "/api/map/projects/rename" },
      "op:map:projects:archive": { method: "POST", path: "/api/map/projects/archive" },
      "op:map:projects:delete": { method: "POST", path: "/api/map/projects/delete" },
      "op:map:style:save": { method: "POST", path: "/api/map/style" },
      "op:map:config:save": { method: "POST", path: "/api/map/config" },
      "op:map:import": { method: "POST", path: "/api/map/import" },
      "op:map:import:batch": { method: "POST", path: "/api/map/import-batch" },
      "op:map:prepare": { method: "POST", path: "/api/map/prepare" },
      "op:map:rebuild": { method: "POST", path: "/api/map/rebuild" },
      "op:map:layer:delete": { method: "POST", path: "/api/map/layer/delete" },
      "op:map:layer:get": { method: "GET", path: "/api/map/layer" },
      "op:map:isochrone": { method: "POST", path: "/api/map/isochrone" },
      "op:map:route": { method: "POST", path: "/api/map/route" },
      "op:map:project:detail": { method: "GET", path: "/api/map/project/:name" },
      "op:map:project:style:save": { method: "POST", path: "/api/map/project/:name/style" },
      "op:map:project:config:save": { method: "POST", path: "/api/map/project/:name/config" },
      "op:map:project:import": { method: "POST", path: "/api/map/project/:name/import" },
      "op:map:project:rebuild-tiles": { method: "POST", path: "/api/map/project/:name/rebuild-tiles" },
      "op:map:project:layer:get": { method: "GET", path: "/api/map/project/:name/layer/:layerId" },
      "op:map:project:layer:delete": { method: "DELETE", path: "/api/map/project/:name/layer/:layerId" },
      "op:map:project:isochrone": { method: "POST", path: "/api/map/project/:name/isochrone" },
      // F5-2 分析可视化族
      "op:map:visual:sources": { method: "GET", path: "/api/map/visual/sources" },
      "op:map:visual:get": { method: "GET", path: "/api/map/visual" },
      "op:map:traffic-bandwidth": { method: "GET", path: "/api/map/traffic-bandwidth" },
      "op:map:od-lines": { method: "GET", path: "/api/map/od-lines" },
      "op:map:multi-isochrone": { method: "POST", path: "/api/map/multi-isochrone" },
      "op:map:exchange-sankey": { method: "GET", path: "/api/map/exchange-sankey" },
      "op:map:road-structure": { method: "GET", path: "/api/map/road-structure" },
      "op:map:demo-analysis": { method: "GET", path: "/api/map/demo-analysis" },
      "op:map:cambodia-od": { method: "GET", path: "/api/demo/cambodia-od" },
      "op:map:m3:bus-routes": { method: "GET", path: "/api/m3/bus-routes" },
      "op:map:m3:station-heatmap": { method: "GET", path: "/api/m3/station-heatmap" },
      "op:map:m3:od-lines": { method: "GET", path: "/api/m3/od-lines" },
      "op:map:m3:network-stats": { method: "GET", path: "/api/m3/network-stats" },
      // F5-3 报告导出模板族
      "op:map:report": { method: "POST", path: "/api/map/report" },
      "op:map:export:batch:start": { method: "POST", path: "/api/map/export/batch" },
      "op:map:export:batch:status": { method: "GET", path: "/api/map/export/batch" },
      "op:map:template:od-commuter": { method: "POST", path: "/api/map/template/od-commuter" },
      // F5-5 style.json 动态读（server L592-608 正则路由转录）
      "op:map:data:style": { method: "GET", path: "/api/map/data/:project/style.json" }
    };
    for (const channel of svc.MAP_DIRECT_CHANNELS) {
      expect(DESKTOP_CHANNELS[channel as keyof typeof DESKTOP_CHANNELS]).toEqual(expectedRoutes[channel]);
    }
  });

  test("unknown channel → 404", async () => {
    const result = await svc.invokeMapDirect("op:map:portal" as never, {}, makeDeps());
    expect(result).toEqual({ ok: false, status: 404, data: { error: "unknown channel: op:map:portal" } });
  });
});

describe("F5-1 项目族（L615-702）", () => {
  test("projects:list → { projects }（清单引用透传，L615-617）", async () => {
    const result = await invoke("op:map:projects:list", {});
    expect(result).toEqual({ ok: true, status: 200, data: { projects: [{ project: "zhejiang-map" }, { project: "demo" }] } });
  });

  test("projects:create → 201 投影（files || [] 兜底，baseProject 缺省回退默认项目）", async () => {
    const createFn = vi.fn((input: Record<string, unknown>) => ({
      config: { project: "p1" }, style: { version: 8 }, files: undefined
    }));
    const result = await invoke("op:map:projects:create", { body: { project: "p1" } }, makeDeps({ createProject: createFn }));
    expect(createFn).toHaveBeenCalledWith({ project: "p1", name: undefined, baseProject: "zhejiang-map" });
    expect(result).toEqual({
      ok: true, status: 201,
      data: { ok: true, project: "p1", config: { project: "p1" }, style: { version: 8 }, files: [] }
    });
  });

  test("projects:create 错误码映射：MAP_PROJECT_EXISTS → 409；无 code → 500 默认码", async () => {
    const conflict = await invoke("op:map:projects:create", { body: {} }, makeDeps({
      createProject: vi.fn(() => { const e = new Error("已存在") as Error & { code?: string }; e.code = "MAP_PROJECT_EXISTS"; throw e; })
    }));
    expect(conflict).toEqual({ ok: false, status: 409, data: { ok: false, error: "已存在", code: "MAP_PROJECT_EXISTS" } });
    const unknown = await invoke("op:map:projects:create", { body: {} }, makeDeps({
      createProject: vi.fn(() => { throw new Error("磁盘满"); })
    }));
    expect(unknown).toEqual({ ok: false, status: 500, data: { ok: false, error: "磁盘满", code: "MAP_PROJECT_CREATE_FAILED" } });
  });

  test("project:get → layerViews 增补（config.project 优先，workspace 字符串化）；归属失败静默", async () => {
    const listFn = vi.fn(() => [{ id: "roads", origin: "workspace" }]);
    const result = await invoke("op:map:project:get", { query: { name: "demo", workspace: 123 as unknown as string } }, makeDeps({
      getProject: vi.fn(() => ({ config: { project: "demo-proj" } })),
      listLayers: listFn
    }));
    expect(listFn).toHaveBeenCalledWith("demo-proj", { workspace: "123" });
    expect(result).toEqual({
      ok: true, status: 200,
      data: { config: { project: "demo-proj" }, layerViews: [{ id: "roads", origin: "workspace" }] }
    });
    const silent = await invoke("op:map:project:get", { query: { name: "demo" } }, makeDeps({
      getProject: vi.fn(() => ({ style: {} })),
      listLayers: vi.fn(() => { throw new Error("repo down"); })
    }));
    expect(silent).toEqual({ ok: true, status: 200, data: { style: {} } });
  });

  test("project:get 不存在 → 404", async () => {
    const result = await invoke("op:map:project:get", { query: {} }, makeDeps({ getProject: vi.fn(() => null) }));
    expect(result).toEqual({ ok: false, status: 404, data: { error: "project not found" } });
  });

  test("project:export：flag 关 → 404；开 → fileName/manifest/buffer base64", async () => {
    const off = await invoke("op:map:project:export", { query: { name: "demo" } }, makeDeps({ mapPackEnabled: vi.fn(() => false) }));
    expect(off).toEqual({ ok: false, status: 404, data: { error: "not found" } });
    const zipFn = vi.fn(async () => ({
      fileName: "demo.zip", manifest: { project: "demo" }, stats: { files: 3, bytes: 1024 }, buffer: Buffer.from("ZIPDATA")
    }));
    const on = await invoke("op:map:project:export", { query: { name: "demo", tiles: "1" } }, makeDeps({ buildProjectZip: zipFn }));
    expect(zipFn).toHaveBeenCalledWith({ project: "demo", includeTiles: true });
    expect(on).toEqual({
      ok: true, status: 200,
      data: { ok: true, fileName: "demo.zip", manifest: { project: "demo", files: 3, bytes: 1024 }, buffer: Buffer.from("ZIPDATA").toString("base64") }
    });
  });

  test("project:export 错误码映射：MAP_PACK_TOO_LARGE → 413", async () => {
    const result = await invoke("op:map:project:export", { query: {} }, makeDeps({
      buildProjectZip: vi.fn(async () => { const e = new Error("too large") as Error & { code?: string }; e.code = "MAP_PACK_TOO_LARGE"; throw e; })
    }));
    expect(result).toEqual({ ok: false, status: 413, data: { ok: false, error: "too large", code: "MAP_PACK_TOO_LARGE" } });
  });

  test("duplicate → 201；rename → 200 / 409 / 403", async () => {
    expect(await invoke("op:map:projects:duplicate", { body: { project: "a", name: "b" } }))
      .toEqual({ ok: true, status: 201, data: { ok: true, project: "copy", config: { project: "copy" } } });
    expect(await invoke("op:map:projects:rename", { body: { project: "a", name: "c" } }))
      .toEqual({ ok: true, status: 200, data: { ok: true, project: "renamed", config: { project: "renamed" } } });
    const conflict = await invoke("op:map:projects:rename", { body: {} }, makeDeps({
      renameProject: vi.fn(() => { const e = new Error("exists") as Error & { code?: string }; e.code = "MAP_PROJECT_EXISTS"; throw e; })
    }));
    expect(conflict.status).toBe(409);
    const guarded = await invoke("op:map:projects:rename", { body: {} }, makeDeps({
      renameProject: vi.fn(() => { const e = new Error("protected") as Error & { code?: string }; e.code = "MAP_PROJECT_PROTECTED"; throw e; })
    }));
    expect(guarded.status).toBe(403);
    // server L684：code: e.code || "MAP_PROJECT_RENAME_FAILED"——PROTECTED 原码保留。
    expect((guarded.data as Record<string, unknown>).code).toBe("MAP_PROJECT_PROTECTED");
  });

  test("archive：archived !== false 默认归档；不存在 404", async () => {
    const archiveFn = vi.fn(() => ({ project: "demo" }));
    const okRes = await invoke("op:map:projects:archive", { body: { project: "demo", archived: false } }, makeDeps({ archiveProject: archiveFn }));
    expect(archiveFn).toHaveBeenCalledWith("demo", false);
    expect(okRes).toEqual({ ok: true, status: 200, data: { ok: true, config: { project: "demo" } } });
    const missing = await invoke("op:map:projects:archive", { body: {} }, makeDeps({ archiveProject: vi.fn(() => null) }));
    expect(missing).toEqual({ ok: false, status: 404, data: { ok: false, error: "project not found" } });
  });

  test("delete：PROTECTED 403 / NOT_FOUND 404 / 成功展开", async () => {
    expect(await invoke("op:map:projects:delete", { body: { project: "demo" } }))
      .toEqual({ ok: true, status: 200, data: { ok: true, removed: ["demo"] } });
    const guarded = await invoke("op:map:projects:delete", { body: {} }, makeDeps({
      deleteProject: vi.fn(() => { const e = new Error("x") as Error & { code?: string }; e.code = "MAP_PROJECT_PROTECTED"; throw e; })
    }));
    expect(guarded.status).toBe(403);
    const missing = await invoke("op:map:projects:delete", { body: {} }, makeDeps({
      deleteProject: vi.fn(() => { const e = new Error("x") as Error & { code?: string }; e.code = "MAP_PROJECT_NOT_FOUND"; throw e; })
    }));
    expect(missing.status).toBe(404);
  });
});

describe("F5-1 样式配置/导入/瓦片/图层族（L704-779）", () => {
  test("style:save / config:save：name 回退默认项目，无效 400", async () => {
    const styleFn = vi.fn(() => true);
    const okRes = await invoke("op:map:style:save", { body: { style: { version: 8 } } }, makeDeps({ saveStyle: styleFn }));
    expect(styleFn).toHaveBeenCalledWith("zhejiang-map", { version: 8 });
    expect(okRes).toEqual({ ok: true, status: 200, data: { ok: true } });
    expect(await invoke("op:map:style:save", { body: {} }, makeDeps({ saveStyle: vi.fn(() => false) })))
      .toEqual({ ok: false, status: 400, data: { error: "invalid style" } });
    expect(await invoke("op:map:config:save", { body: {} }, makeDeps({ saveConfig: vi.fn(() => false) })))
      .toEqual({ ok: false, status: 400, data: { error: "invalid config" } });
  });

  test("import：geojson 守卫 400；clientError 正则 400 与其他 500 分流", async () => {
    expect((await invoke("op:map:import", { body: { name: "demo" } })).status).toBe(400);
    const clientErr = await invoke("op:map:import", { body: { geojson: {} } }, makeDeps({
      importLayer: vi.fn(async () => { throw new Error("没有可导入的要素"); })
    }));
    expect(clientErr).toEqual({ ok: false, status: 400, data: { error: "没有可导入的要素" } });
    const serverErr = await invoke("op:map:import", { body: { geojson: {} } }, makeDeps({
      importLayer: vi.fn(async () => { throw new Error("IO 崩溃"); })
    }));
    expect(serverErr.status).toBe(500);
    const failFast = await invoke("op:map:import", { body: { geojson: {} } }, makeDeps({
      importLayer: vi.fn(async () => null)
    }));
    expect(failFast).toEqual({ ok: false, status: 400, data: { error: "import failed" } });
  });

  test("import:batch：items 非空数组守卫；成功透传", async () => {
    expect((await invoke("op:map:import:batch", { body: { items: [] } })).status).toBe(400);
    expect((await invoke("op:map:import:batch", { body: { items: "x" } })).status).toBe(400);
    expect(await invoke("op:map:import:batch", { body: { items: [{ layerId: "a" }] } }))
      .toEqual({ ok: true, status: 200, data: { ok: true, count: 2 } });
  });

  test("prepare：invalid dir 400 / 目录不存在 400 / 成功链两脚本 + 输出尾截", async () => {
    expect((await invoke("op:map:prepare", { body: { srcDir: "../escape" } }, makeDeps({
      dirProbe: vi.fn(() => ({ exists: false, isDirectory: false }))
    }))).status).toBe(400);
    const missing = await invoke("op:map:prepare", { body: { srcDir: "data" } }, makeDeps({
      dirProbe: vi.fn(() => ({ exists: false, isDirectory: false }))
    }));
    expect(missing).toEqual({ ok: false, status: 400, data: { error: "目录不存在: data（请先把矢量数据放入该目录）" } });
    const runFn = vi.fn(async (script: string) => script.includes("prepare-map-data")
      ? { code: 0, out: "x".repeat(790) + "PREPARE_TAIL" }
      : { code: 0, out: "y".repeat(495) + "TILES_TAIL" });
    const okRes = await invoke("op:map:prepare", { body: { srcDir: "data/in" } }, makeDeps({
      runScript: runFn,
      dirProbe: vi.fn(() => ({ exists: true, isDirectory: true }))
    }));
    expect(runFn).toHaveBeenCalledTimes(2);
    expect(runFn).toHaveBeenNthCalledWith(1, "scripts/tools/prepare-map-data.mjs", [expect.stringContaining("data")]);
    expect(runFn).toHaveBeenNthCalledWith(2, "scripts/tools/build-vector-tiles.mjs", ["--force"]);
    const data = okRes.data as Record<string, unknown>;
    expect(data.ok).toBe(true);
    expect(data.prepare).toHaveLength(800);
    expect(String(data.prepare).endsWith("PREPARE_TAIL")).toBe(true);
    expect(String(data.tiles).endsWith("TILES_TAIL")).toBe(true);
    const failed = await invoke("op:map:prepare", { body: {} }, makeDeps({
      runScript: vi.fn(async (_s: string) => ({ code: 1, out: "boom" }))
    }));
    expect((failed.data as Record<string, unknown>).ok).toBe(false);
  });

  test("prepare srcDir 缺省回退 PROJECT_DIR/data；workspace 内相对路径放行", async () => {
    const probeFn = vi.fn(() => ({ exists: true, isDirectory: true }));
    const runFn = vi.fn(async () => ({ code: 0, out: "" }));
    await invoke("op:map:prepare", { body: {} }, makeDeps({ dirProbe: probeFn, runScript: runFn }));
    expect(probeFn).toHaveBeenCalledWith("P:\\proj\\data");
    const wsFn = vi.fn(async () => ({ code: 0, out: "" }));
    await invoke("op:map:prepare", { body: { srcDir: "sub/dir" } }, makeDeps({ dirProbe: probeFn, runScript: wsFn }));
    const arg = (wsFn.mock.calls[0] as unknown[])[1] as string[];
    expect(arg[0]).toBe(require("path").resolve("W:\\ws", "sub/dir"));
  });

  test("rebuild：layerIds 数组透传；失败 400", async () => {
    const rebuildFn = vi.fn(() => ({ roads: 12 }));
    const okRes = await invoke("op:map:rebuild", { body: { name: "demo", layerIds: ["roads"] } }, makeDeps({ rebuildTiles: rebuildFn }));
    expect(rebuildFn).toHaveBeenCalledWith("demo", ["roads"]);
    expect(okRes).toEqual({ ok: true, status: 200, data: { ok: true, layers: { roads: 12 } } });
    expect(await invoke("op:map:rebuild", { body: {} }, makeDeps({ rebuildTiles: vi.fn(() => null) })))
      .toEqual({ ok: false, status: 400, data: { error: "rebuild failed" } });
  });

  test("layer:delete 透传（无 try/catch 忠实）；layer:get 404", async () => {
    expect(await invoke("op:map:layer:delete", { body: { name: "demo", layerId: "roads" } }))
      .toEqual({ ok: true, status: 200, data: { ok: true } });
    const getFn = vi.fn(() => ({ type: "FeatureCollection" }));
    expect(await invoke("op:map:layer:get", { query: { name: "demo", layer: "roads" } }, makeDeps({ getLayer: getFn })))
      .toEqual({ ok: true, status: 200, data: { type: "FeatureCollection" } });
    expect(getFn).toHaveBeenCalledWith("demo", "roads");
    expect(await invoke("op:map:layer:get", { query: {} }, makeDeps({ getLayer: vi.fn(() => null) })))
      .toEqual({ ok: false, status: 404, data: { error: "layer not found" } });
  });
});

describe("F5-1 空间查询（L781-796）", () => {
  test("isochrone：location 守卫 + r.error 400 + 投影", async () => {
    expect((await invoke("op:map:isochrone", { body: {} })).status).toBe(400);
    const bizErr = await invoke("op:map:isochrone", { body: { location: "120,30" } }, makeDeps({
      isochrone: vi.fn(async () => ({ error: "AMAP_KEY 未配置" }))
    }));
    expect(bizErr).toEqual({ ok: false, status: 400, data: { error: "AMAP_KEY 未配置" } });
    const okRes = await invoke("op:map:isochrone", { body: { location: "120,30", mode: "walking" } }, makeDeps({
      isochrone: vi.fn(async (input: Record<string, unknown>) => ({ center: input.location, cost: 20, polygons: { type: "FeatureCollection" } }))
    }));
    expect(okRes).toEqual({
      ok: true, status: 200,
      data: { ok: true, center: "120,30", cost: 20, polygons: { type: "FeatureCollection" } }
    });
  });

  test("route：from/to 守卫 + 成功投影", async () => {
    expect((await invoke("op:map:route", { body: { from: "120,30" } })).status).toBe(400);
    expect(await invoke("op:map:route", { body: { from: "120,30", to: "121,31" } }))
      .toEqual({ ok: true, status: 200, data: { ok: true, provider: "osrm", distance: 1000, duration: 600, geometry: {} } });
  });
});

describe("F5-1 项目命名路由族（L5438-5506）", () => {
  test("project:detail：params.name 透传 + 404", async () => {
    const getFn = vi.fn(() => ({ config: { project: "demo" } }));
    expect(await invoke("op:map:project:detail", { params: { name: "demo" } }, makeDeps({ getProject: getFn })))
      .toEqual({ ok: true, status: 200, data: { config: { project: "demo" } } });
    expect(getFn).toHaveBeenCalledWith("demo");
    expect(await invoke("op:map:project:detail", { params: { name: "nope" } }, makeDeps({ getProject: vi.fn(() => null) })))
      .toEqual({ ok: false, status: 404, data: { error: "project not found" } });
  });

  test("project:style:save / config:save：400 与 ok 分支", async () => {
    expect((await invoke("op:map:project:style:save", { params: { name: "demo" }, body: {} }, makeDeps({ saveStyle: vi.fn(() => false) }))).status).toBe(400);
    expect((await invoke("op:map:project:config:save", { params: { name: "demo" }, body: {} }, makeDeps({ saveConfig: vi.fn(() => false) }))).status).toBe(400);
    const okRes = await invoke("op:map:project:style:save", { params: { name: "demo" }, body: { style: { version: 8 } } });
    expect(okRes).toEqual({ ok: true, status: 200, data: { ok: true } });
  });

  test("project:import：双守卫 400 / !r 400 / catch 500", async () => {
    expect((await invoke("op:map:project:import", { params: { name: "demo" }, body: { layerId: "a" } })).status).toBe(400);
    expect((await invoke("op:map:project:import", { params: { name: "demo" }, body: { layerId: "a", geojson: {} } }, makeDeps({
      importLayer: vi.fn(async () => null)
    }))).status).toBe(400);
    const boom = await invoke("op:map:project:import", { params: { name: "demo" }, body: { layerId: "a", geojson: {} } }, makeDeps({
      importLayer: vi.fn(async () => { throw new Error("磁盘错误"); })
    }));
    expect(boom).toEqual({ ok: false, status: 500, data: { error: "磁盘错误" } });
    expect(await invoke("op:map:project:import", { params: { name: "demo" }, body: { layerId: "a", geojson: {} } }))
      .toEqual({ ok: true, status: 200, data: { ok: true, layerId: "roads" } });
  });

  test("project:rebuild-tiles：results 字段 + catch 500（与顶层 rebuild 400 版语义分叉）", async () => {
    expect(await invoke("op:map:project:rebuild-tiles", { params: { name: "demo" } }))
      .toEqual({ ok: true, status: 200, data: { ok: true, results: { roads: 12 } } });
    const boom = await invoke("op:map:project:rebuild-tiles", { params: { name: "demo" } }, makeDeps({
      rebuildTiles: vi.fn(() => { throw new Error("瓦片失败"); })
    }));
    expect(boom).toEqual({ ok: false, status: 500, data: { error: "瓦片失败" } });
  });

  test("project:layer:get / layer:delete：params 双参数 + 500 版错误面", async () => {
    const getFn = vi.fn(() => ({ type: "FeatureCollection" }));
    expect(await invoke("op:map:project:layer:get", { params: { name: "demo", layerId: "roads" } }, makeDeps({ getLayer: getFn })))
      .toEqual({ ok: true, status: 200, data: { type: "FeatureCollection" } });
    expect(getFn).toHaveBeenCalledWith("demo", "roads");
    expect((await invoke("op:map:project:layer:get", { params: { name: "demo", layerId: "x" } }, makeDeps({ getLayer: vi.fn(() => null) }))).status).toBe(404);
    expect(await invoke("op:map:project:layer:delete", { params: { name: "demo", layerId: "roads" } }))
      .toEqual({ ok: true, status: 200, data: { ok: true } });
    const boom = await invoke("op:map:project:layer:delete", { params: { name: "demo", layerId: "x" } }, makeDeps({
      deleteLayer: vi.fn(() => { throw new Error("删除失败"); })
    }));
    expect(boom).toEqual({ ok: false, status: 500, data: { error: "删除失败" } });
  });

  test("project:isochrone：整体透传（含 error 字段不转 400）+ catch 500", async () => {
    const passthrough = await invoke("op:map:project:isochrone", { params: { name: "demo" }, body: { location: "120,30" } }, makeDeps({
      isochrone: vi.fn(async () => ({ error: "AMAP_KEY 未配置" }))
    }));
    expect(passthrough).toEqual({ ok: true, status: 200, data: { error: "AMAP_KEY 未配置" } });
    const boom = await invoke("op:map:project:isochrone", { params: { name: "demo" }, body: {} }, makeDeps({
      isochrone: vi.fn(async () => { throw new Error("超时"); })
    }));
    expect(boom).toEqual({ ok: false, status: 500, data: { error: "超时" } });
  });
});

describe("F5-2 visual:sources / visual:get（L5194-5254）", () => {
  test("visual:sources → { sources, planned }（server 侧 planned 每请求动态 import 取值）", async () => {
    const plannedFn = vi.fn(() => [{ id: "planned-a" }]);
    const result = await invoke("op:map:visual:sources", {}, makeDeps({ plannedSources: plannedFn }));
    expect(plannedFn).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, status: 200, data: { sources: [{ id: "local-file" }, { id: "bundled-xinchang" }], planned: [{ id: "planned-a" }] } });
  });

  test("visual:get 适配器命中：params 十项组装 + loadSource + descriptor.error 400", async () => {
    const loadFn = vi.fn(async (id: unknown, params: Record<string, unknown>) => ({ v: 1, kind: "flow", id, echo: params }));
    const result = await invoke("op:map:visual:get", {
      query: { dataset: "local-file", kind: "flow", path: "a.geojson", measure: "flow", project: "p1", threshold: "30", region: "义乌市", workspace: "W:\\ws", url: "http://x", db: "d", sql: "s" }
    }, makeDeps({ visualLoadSource: loadFn }));
    expect(loadFn).toHaveBeenCalledWith("local-file", {
      kind: "flow", path: "a.geojson", measure: "flow", project: "p1",
      minFlow: "30", region: "义乌市", workspace: "W:\\ws", url: "http://x", db: "d", sql: "s"
    });
    const data = result.data as Record<string, unknown>;
    expect((data.descriptor as Record<string, unknown>).id).toBe("local-file");
    // loadSource 业务失败（{error}）→ 400 原载荷透传
    const bizErr = await invoke("op:map:visual:get", { query: { dataset: "local-file" } }, makeDeps({
      visualLoadSource: vi.fn(async () => ({ error: "文件不存在" }))
    }));
    expect(bizErr).toEqual({ ok: false, status: 400, data: { error: "文件不存在" } });
  });

  test("visual:get M2 两分支：r.error 400 / fromXxx 描述符包装 / project 缺省回退", async () => {
    const bwErr = await invoke("op:map:visual:get", { query: { dataset: "m2-traffic-bandwidth" } }, makeDeps({
      getTrafficBandwidth: vi.fn(() => ({ error: "项目不存在" }))
    }));
    expect(bwErr).toEqual({ ok: false, status: 400, data: { error: "项目不存在" } });
    const bwOk = await invoke("op:map:visual:get", { query: { dataset: "m2-traffic-bandwidth", project: "custom" } }, makeDeps({
      getTrafficBandwidth: vi.fn((name: unknown) => ({ geojson: {}, project: name }))
    }));
    expect(bwOk.data).toEqual({ descriptor: { id: "m2-traffic-bandwidth" } });
    const odOk = await invoke("op:map:visual:get", { query: { dataset: "m2-od-lines" } }, makeDeps({
      getODLines: vi.fn((name: unknown) => ({ geojson: {}, project: name }))
    }));
    expect(odOk.data).toEqual({ descriptor: { id: "m2-od-lines" } });
  });

  test("visual:get cambodia-od 分支：minFlow 透传（cambodia-od 域，非 map-analysis）+ 无 error 检查", async () => {
    const camFn = vi.fn(() => ({ lines: {}, points: {} }));
    const result = await invoke("op:map:visual:get", { query: { dataset: "cambodia-od", threshold: "50" } }, makeDeps({
      cambodiaGetCambodiaOD: camFn
    }));
    expect(camFn).toHaveBeenCalledWith({ minFlow: "50" });
    expect(result.data).toEqual({ descriptor: { id: "cambodia-od" } });
  });

  test("visual:get demo-analysis 分支：kind 三值映射（flow→od / isochrone→isochrone / 其余→heatmap）", async () => {
    const demoFn = vi.fn(() => ({ analysis: "od" }));
    await invoke("op:map:visual:get", { query: { dataset: "demo-analysis", kind: "flow" } }, makeDeps({ demoCreateDemoAnalysis: demoFn }));
    expect(demoFn).toHaveBeenCalledWith({ analysis: "od", region: "义乌市", project: "zhejiang-map" });
    await invoke("op:map:visual:get", { query: { dataset: "demo-analysis", kind: "isochrone", region: "杭州市", project: "p9" } }, makeDeps({ demoCreateDemoAnalysis: demoFn }));
    expect(demoFn).toHaveBeenLastCalledWith({ analysis: "isochrone", region: "杭州市", project: "p9" });
    await invoke("op:map:visual:get", { query: { dataset: "demo-analysis", kind: "heatmap" } }, makeDeps({ demoCreateDemoAnalysis: demoFn }));
    expect(demoFn).toHaveBeenLastCalledWith({ analysis: "heatmap", region: "义乌市", project: "zhejiang-map" });
    expect((await invoke("op:map:visual:get", { query: { dataset: "demo-analysis", kind: "heatmap" } })).data)
      .toEqual({ descriptor: { id: "agent-analysis" } });
  });

  test("visual:get 未知 dataset → 400 { error, available }（available = 适配器 id + 四固定数据集）", async () => {
    const result = await invoke("op:map:visual:get", { query: { dataset: "nope" } });
    expect(result).toEqual({
      ok: false, status: 400,
      data: { error: "未知 dataset：nope", available: ["local-file", "bundled-xinchang", "m2-traffic-bandwidth", "m2-od-lines", "cambodia-od", "demo-analysis"] }
    });
    // dataset 为空串：available 前缀为空串字面（server L5248 `${dataset || "(空)"}` 之外的 400 路径）
    const empty = await invoke("op:map:visual:get", {});
    expect((empty.data as Record<string, unknown>).error).toBe("未知 dataset：(空)");
  });

  test("visual:get catch 500", async () => {
    const boom = await invoke("op:map:visual:get", { query: { dataset: "m2-od-lines" } }, makeDeps({
      getODLines: vi.fn(() => { throw new Error("读取崩溃"); })
    }));
    expect(boom).toEqual({ ok: false, status: 500, data: { error: "读取崩溃" } });
  });
});

describe("F5-2 M2 分析四路由（sendMapAnalysis L5510-5552）", () => {
  test("sendMapAnalysis 语义：error==='项目不存在' → 404，其余透传（含其他 error 值）", async () => {
    const missing = await invoke("op:map:traffic-bandwidth", { query: { project: "ghost" } }, makeDeps({
      getTrafficBandwidth: vi.fn(() => ({ error: "项目不存在" }))
    }));
    expect(missing).toEqual({ ok: false, status: 404, data: { error: "项目不存在" } });
    // 其他 error 值（如业务警告）照旧 200 透传——server L5513 只特判"项目不存在"
    const warn = await invoke("op:map:traffic-bandwidth", {}, makeDeps({
      getTrafficBandwidth: vi.fn(() => ({ error: "部分路段缺流量", geojson: {} }))
    }));
    expect(warn).toEqual({ ok: true, status: 200, data: { error: "部分路段缺流量", geojson: {} } });
  });

  test("四路由 project 缺省回退 zhejiang-map 字面 + 透传载荷 + catch 500", async () => {
    const bwFn = vi.fn(() => ({ stats: {} }));
    const odFn = vi.fn(() => ({ stats: {} }));
    const skFn = vi.fn(() => ({ nodes: [] }));
    const rsFn = vi.fn(() => ({ total: 1 }));
    await invoke("op:map:traffic-bandwidth", { query: {} }, makeDeps({ getTrafficBandwidth: bwFn }));
    await invoke("op:map:od-lines", { query: { project: "p2" } }, makeDeps({ getODLines: odFn }));
    await invoke("op:map:exchange-sankey", { query: {} }, makeDeps({ getExchangeSankey: skFn }));
    await invoke("op:map:road-structure", { query: {} }, makeDeps({ getRoadStructure: rsFn }));
    expect(bwFn).toHaveBeenCalledWith("zhejiang-map");
    expect(odFn).toHaveBeenCalledWith("p2");
    expect(skFn).toHaveBeenCalledWith("zhejiang-map");
    expect(rsFn).toHaveBeenCalledWith("zhejiang-map");
    const boom = await invoke("op:map:exchange-sankey", {}, makeDeps({
      getExchangeSankey: vi.fn(() => { throw new Error("加载失败"); })
    }));
    expect(boom).toEqual({ ok: false, status: 500, data: { error: "加载失败" } });
  });
});

describe("F5-2 multi-isochrone（L5533-5540）", () => {
  test("body 四参解构透传 + 透传载荷 + catch 500", async () => {
    const isoFn = vi.fn(async (input: Record<string, unknown>) => ({ ...input, polygons: {} }));
    const result = await invoke("op:map:multi-isochrone", { body: { location: [120, 30], mode: "driving", ranges: [15, 30], rangeType: "time" } }, makeDeps({ multiIsochrone: isoFn }));
    expect(isoFn).toHaveBeenCalledWith({ location: [120, 30], mode: "driving", ranges: [15, 30], rangeType: "time" });
    expect(result).toEqual({ ok: true, status: 200, data: { location: [120, 30], mode: "driving", ranges: [15, 30], rangeType: "time", polygons: {} } });
    const boom = await invoke("op:map:multi-isochrone", { body: {} }, makeDeps({
      multiIsochrone: vi.fn(async () => { throw new Error("OSRM 不可达"); })
    }));
    expect(boom).toEqual({ ok: false, status: 500, data: { error: "OSRM 不可达" } });
  });
});

describe("F5-2 生效段演示数据（L799-825）", () => {
  test("demo-analysis：query 原始透传（默认值由域内补齐）+ 500 信封 { error, code, detail }", async () => {
    const demoFn = vi.fn(() => ({ analysis: "heatmap" }));
    const result = await invoke("op:map:demo-analysis", { query: { analysis: "od", region: "玉环市", project: "p3", count: "48" } }, makeDeps({ analysisCreateDemoAnalysis: demoFn }));
    expect(demoFn).toHaveBeenCalledWith({ analysis: "od", region: "玉环市", project: "p3", count: "48" });
    expect(result).toEqual({ ok: true, status: 200, data: { analysis: "heatmap" } });
    const err = new Error("region 不支持") as Error & { code?: string; detail?: string };
    err.code = "DEMO_REGION_INVALID";
    err.detail = "玉环市无演示中心";
    const boom = await invoke("op:map:demo-analysis", { query: {} }, makeDeps({
      analysisCreateDemoAnalysis: vi.fn(() => { throw err; })
    }));
    expect(boom).toEqual({ ok: false, status: 500, data: { error: "region 不支持", code: "DEMO_REGION_INVALID", detail: "玉环市无演示中心" } });
    // 无 code/detail 的普通错误 → null 字段（server L802 `e.code || null` 忠实）
    const plain = await invoke("op:map:demo-analysis", { query: {} }, makeDeps({
      analysisCreateDemoAnalysis: vi.fn(() => { throw new Error("boom"); })
    }));
    expect(plain).toEqual({ ok: false, status: 500, data: { error: "boom", code: null, detail: null } });
  });

  test("cambodia-od：minFlow 透传（map-analysis 域）+ 500 { error }", async () => {
    const camFn = vi.fn(() => ({ error: null, status: "demo" }));
    const result = await invoke("op:map:cambodia-od", { query: { minFlow: "100" } }, makeDeps({ analysisGetCambodiaOD: camFn }));
    expect(camFn).toHaveBeenCalledWith({ minFlow: "100" });
    expect(result).toEqual({ ok: true, status: 200, data: { error: null, status: "demo" } });
    const boom = await invoke("op:map:cambodia-od", {}, makeDeps({
      analysisGetCambodiaOD: vi.fn(() => { throw new Error("OD 数据缺失"); })
    }));
    expect(boom).toEqual({ ok: false, status: 500, data: { error: "OD 数据缺失" } });
  });

  test("m3 四路由：getXinchangBus 四 kind + 500 { error }", async () => {
    const busFn = vi.fn((kind: string) => ({ kind }));
    expect(await invoke("op:map:m3:bus-routes", {}, makeDeps({ getXinchangBus: busFn })))
      .toEqual({ ok: true, status: 200, data: { kind: "routes" } });
    expect(await invoke("op:map:m3:station-heatmap", {}, makeDeps({ getXinchangBus: busFn })))
      .toEqual({ ok: true, status: 200, data: { kind: "stations" } });
    expect(await invoke("op:map:m3:od-lines", {}, makeDeps({ getXinchangBus: busFn })))
      .toEqual({ ok: true, status: 200, data: { kind: "od" } });
    expect(await invoke("op:map:m3:network-stats", {}, makeDeps({ getXinchangBus: busFn })))
      .toEqual({ ok: true, status: 200, data: { kind: "stats" } });
    expect(busFn).toHaveBeenNthCalledWith(1, "routes");
    expect(busFn).toHaveBeenNthCalledWith(2, "stations");
    expect(busFn).toHaveBeenNthCalledWith(3, "od");
    expect(busFn).toHaveBeenNthCalledWith(4, "stats");
    const boom = await invoke("op:map:m3:bus-routes", {}, makeDeps({
      getXinchangBus: vi.fn(() => { throw new Error("素材缺失"); })
    }));
    expect(boom).toEqual({ ok: false, status: 500, data: { error: "素材缺失" } });
  });

  test("死路由声明：/api/bus/* 不在通道清单（L5714 404 catch-all 遮蔽 + client 零调用）", () => {
    const busChannels = svc.MAP_DIRECT_CHANNELS.filter((c) => c.startsWith("op:map:bus:"));
    expect(busChannels).toEqual([]);
    // DESKTOP_CHANNELS 中亦无 /api/bus 路由
    const busRoutes = Object.values(DESKTOP_CHANNELS).filter((r) => r.path.startsWith("/api/bus"));
    expect(busRoutes).toEqual([]);
  });
});

describe("F5-3 report（L5259-5277）", () => {
  test("flag 关 → 404 { error: not found }", async () => {
    const result = await invoke("op:map:report", { body: {} }, makeDeps({ mapReportEnabled: vi.fn(() => false) }));
    expect(result).toEqual({ ok: false, status: 404, data: { error: "not found" } });
  });

  test("成功：body 六参透传 + 响应投影 fileName basename", async () => {
    const reportFn = vi.fn(async () => ({ file: "N:\\ws\\地图报告\\出行报告.md", blocks: 5, images: 3 }));
    const result = await invoke("op:map:report", {
      body: { workspace: "ws-a", project: "p1", title: "T", sections: [{ text: "s" }], images: ["a.png"], fileName: "r.md" }
    }, makeDeps({ buildMapReport: reportFn }));
    expect(reportFn).toHaveBeenCalledWith({
      workspace: "N:\\ws\\ws-a", project: "p1", title: "T",
      sections: [{ text: "s" }], images: ["a.png"], fileName: "r.md"
    });
    expect(result).toEqual({ ok: true, status: 200, data: { ok: true, file: "N:\\ws\\地图报告\\出行报告.md", fileName: "出行报告.md", blocks: 5, images: 3 } });
  });

  test("workspace 空 → 回退 getWorkspace；越界/不存在 → 400；其他 → 500（信封 { error } 无 ok:false）", async () => {
    const deps = makeDeps();
    const result = await invoke("op:map:report", { body: {} }, deps);
    expect(deps.buildMapReport).toHaveBeenCalledWith(expect.objectContaining({ workspace: "W:\\ws" }));
    const bad = await invoke("op:map:report", { body: {} }, makeDeps({
      buildMapReport: vi.fn(async () => { throw new Error("图片路径越界"); })
    }));
    expect(bad).toEqual({ ok: false, status: 400, data: { error: "图片路径越界" } });
    const missing = await invoke("op:map:report", { body: {} }, makeDeps({
      buildMapReport: vi.fn(async () => { throw new Error("项目不存在"); })
    }));
    expect(missing).toEqual({ ok: false, status: 400, data: { error: "项目不存在" } });
    const boom = await invoke("op:map:report", { body: {} }, makeDeps({
      buildMapReport: vi.fn(async () => { throw new Error("磁盘满"); })
    }));
    expect(boom).toEqual({ ok: false, status: 500, data: { error: "磁盘满" } });
  });
});

describe("F5-3 export/batch POST（L5312-5361）", () => {
  test("flag 关 → 404；计划 errors → 400 { ok:false, errors }", async () => {
    const off = await invoke("op:map:export:batch:start", { body: {} }, makeDeps({ mapExportEnabled: vi.fn(() => false) }));
    expect(off).toEqual({ ok: false, status: 404, data: { error: "not found" } });
    const invalid = await invoke("op:map:export:batch:start", { body: {} }, makeDeps({
      planExportJobs: vi.fn(() => ({ jobs: [], errors: ["尺寸非法"], skipped: [{ reason: "空项目" }] }))
    }));
    expect(invalid).toEqual({ ok: false, status: 400, data: { ok: false, errors: ["尺寸非法"] } });
  });

  test("成功：planExportJobs 五参透传 + 立即响应（batchId 形态 + jobs 八字段投影）", async () => {
    const planFn = vi.fn(() => ({
      jobs: [{ id: "j1", project: "p1", layers: ["roads"], sizeId: "hd", sizeLabel: "1920x1080", width: 1920, height: 1080, format: "png", fileName: "p1.png", extra: "drop-me" }],
      errors: [], skipped: []
    }));
    const result = await invoke("op:map:export:batch:start", {
      body: { projects: ["p1"], layerSets: [], sizes: ["hd"], formats: ["png"], title: "T" }
    }, makeDeps({ planExportJobs: planFn }));
    expect(planFn).toHaveBeenCalledWith({ projects: ["p1"], layerSets: [], sizes: ["hd"], formats: ["png"], title: "T" });
    expect(result.ok).toBe(true);
    const data = (result as { ok: true; data: Record<string, any> }).data;
    expect(data.batchId).toMatch(/^batch-\d+-\d+$/);
    expect(data.total).toBe(1);
    expect(data.skipped).toEqual([]);
    expect(data.jobs).toEqual([{ id: "j1", project: "p1", layers: ["roads"], sizeId: "hd", sizeLabel: "1920x1080", width: 1920, height: 1080, format: "png", fileName: "p1.png" }]);
  });

  test("串行锁：执行中第二次 POST → 409（含批次 id）；完成后锁释放可再发起", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const deps = makeDeps({
      runExportQueue: vi.fn(async () => { await gate; return { total: 1, done: 1, failed: 0, results: [] }; })
    });
    const first = await invoke("op:map:export:batch:start", { body: {} }, deps);
    expect(first.ok).toBe(true);
    const second = await invoke("op:map:export:batch:start", { body: {} }, deps);
    expect(second).toEqual({ ok: false, status: 409, data: { ok: false, error: expect.stringContaining("已有导出批次在执行（batch-") } });
    release();
    await vi.waitFor(() => {
      const third = invoke("op:map:export:batch:start", { body: {} }, deps);
      return third.then((r) => { expect(r.ok).toBe(true); });
    });
  });

  test("状态机 completed：onProgress 快照写回 summary + finishedAt 落值（GET status 轮询可见）", async () => {
    const deps = makeDeps();
    const started = await invoke("op:map:export:batch:start", { body: {} }, deps);
    const batchId = (started as { data: { batchId: string } }).data.batchId;
    await vi.waitFor(async () => {
      const st = await invoke("op:map:export:batch:status", { query: { id: batchId } }, deps);
      expect((st as { data: { status: string } }).data.status).toBe("completed");
    });
    const st = await invoke("op:map:export:batch:status", { query: { id: batchId } }, deps);
    const data = (st as { ok: true; data: Record<string, any> }).data;
    expect(data).toEqual({
      ok: true, id: batchId, status: "completed", total: 1, skipped: [],
      summary: { total: 1, done: 1, failed: 0, results: [{ file: "W:\\ws\\地图导出\\p1.png", bytes: 3 }] },
      error: "", createdAt: expect.any(String), finishedAt: expect.any(String)
    });
  });

  test("状态机 completed-with-failures：summary.failed 非零 → 终态分叉", async () => {
    const deps = makeDeps({
      runExportQueue: vi.fn(async () => ({ total: 2, done: 1, failed: 1, results: [{ id: "j1", status: "failed" }] }))
    });
    const started = await invoke("op:map:export:batch:start", { body: {} }, deps);
    const batchId = (started as { data: { batchId: string } }).data.batchId;
    await vi.waitFor(async () => {
      const st = await invoke("op:map:export:batch:status", { query: { id: batchId } }, deps);
      expect((st as { data: { status: string } }).data.status).toBe("completed-with-failures");
    });
  });

  test("状态机 failed：executor 抛错 → status failed + error 写回 + finishedAt 落值", async () => {
    const deps = makeDeps({
      browserOpen: vi.fn(async () => { throw new Error("浏览器启动失败"); })
    });
    const started = await invoke("op:map:export:batch:start", { body: {} }, deps);
    const batchId = (started as { data: { batchId: string } }).data.batchId;
    await vi.waitFor(async () => {
      const st = await invoke("op:map:export:batch:status", { query: { id: batchId } }, deps);
      const data = (st as { data: Record<string, any> }).data;
      expect(data.status).toBe("failed");
      expect(data.error).toBe("浏览器启动失败");
      expect(data.finishedAt).not.toBe("");
    });
  });
});

describe("F5-3 export/batch GET（L5363-5379）", () => {
  test("flag 关 → 404；未知 id / 空 id → 404 { ok:false, error: 批次不存在或服务已重启 }", async () => {
    const off = await invoke("op:map:export:batch:status", { query: { id: "x" } }, makeDeps({ mapExportEnabled: vi.fn(() => false) }));
    expect(off).toEqual({ ok: false, status: 404, data: { error: "not found" } });
    const missing = await invoke("op:map:export:batch:status", { query: { id: "nope" } }, makeDeps());
    expect(missing).toEqual({ ok: false, status: 404, data: { ok: false, error: "批次不存在或服务已重启" } });
    const empty = await invoke("op:map:export:batch:status", { query: {} }, makeDeps());
    expect(empty).toEqual({ ok: false, status: 404, data: { ok: false, error: "批次不存在或服务已重启" } });
  });
});

describe("F5-3 template/od-commuter（L5383-5401）", () => {
  test("flag 关 → 404；成功 { ok:true, ...result } + 六参透传 + workspace 回退", async () => {
    const off = await invoke("op:map:template:od-commuter", { body: {} }, makeDeps({ mapTemplatesEnabled: vi.fn(() => false) }));
    expect(off).toEqual({ ok: false, status: 404, data: { error: "not found" } });
    const tplFn = vi.fn(async () => ({ project: "od-proj", file: "N:\\ws\\od.md", blocks: 2 }));
    const result = await invoke("op:map:template:od-commuter", {
      body: { workspace: "ws-b", path: "data/od.csv", title: "OD", bands: [10, 50], project: "p1", fileName: "od.md" }
    }, makeDeps({ runOdCommuterTemplate: tplFn }));
    expect(tplFn).toHaveBeenCalledWith({
      workspace: "N:\\ws\\ws-b", path: "data/od.csv", title: "OD",
      bands: [10, 50], project: "p1", fileName: "od.md"
    });
    expect(result).toEqual({ ok: true, status: 200, data: { ok: true, project: "od-proj", file: "N:\\ws\\od.md", blocks: 2 } });
    const fallback = await invoke("op:map:template:od-commuter", { body: {} }, makeDeps());
    expect(fallback.ok).toBe(true);
  });

  test("400 词集（越界/不存在/缺少/不是 OD/没有）+ 其他 → 500；错误信封 { ok:false, error }", async () => {
    for (const msg of ["图片路径越界", "项目不存在", "缺少 OD 数据", "不是 OD 格式", "没有有效流量"]) {
      const bad = await invoke("op:map:template:od-commuter", { body: {} }, makeDeps({
        runOdCommuterTemplate: vi.fn(async () => { throw new Error(msg); })
      }));
      expect(bad).toEqual({ ok: false, status: 400, data: { ok: false, error: msg } });
    }
    const boom = await invoke("op:map:template:od-commuter", { body: {} }, makeDeps({
      runOdCommuterTemplate: vi.fn(async () => { throw new Error("模板引擎崩溃"); })
    }));
    expect(boom).toEqual({ ok: false, status: 500, data: { ok: false, error: "模板引擎崩溃" } });
  });
});

describe("F5-3 executeExportJob 内联转录（L5293-5310）", () => {
  test("png 分支：browser 七函数序列 + 会话键 + URL + 落盘路径与 Buffer", async () => {
    const deps = makeDeps();
    const started = await invoke("op:map:export:batch:start", { body: {} }, deps);
    const batchId = (started as { data: { batchId: string } }).data.batchId;
    await vi.waitFor(async () => {
      const st = await invoke("op:map:export:batch:status", { query: { id: batchId } }, deps);
      expect((st as { data: { status: string } }).data.status).toBe("completed");
    });
    expect(deps.browserSessionKey).toHaveBeenCalledWith("map-export", "batch");
    expect(deps.browserOpen).toHaveBeenCalledWith("map-export|batch", expect.stringContaining("http://127.0.0.1:3002/?export=map"));
    expect(deps.browserResize).toHaveBeenCalledWith("map-export|batch", 1920, 1080);
    expect(deps.browserWaitForExpression).toHaveBeenCalledWith("map-export|batch", "window.__OAW_EXPORT_READY === true", { timeoutMs: 45000 });
    expect(deps.browserEvaluateValue).toHaveBeenCalledWith("map-export|batch", "window.__OAW_EXPORT_ERROR || ''");
    expect(deps.browserScreenshot).toHaveBeenCalledWith("map-export|batch", { format: "png" });
    expect(deps.browserPrintToPdf).not.toHaveBeenCalled();
    expect(deps.ensureDir).toHaveBeenCalledWith("W:\\ws\\地图导出");
    expect(deps.writeFile).toHaveBeenCalledWith("W:\\ws\\地图导出\\p1.png", Buffer.from("UE5H", "base64"));
  });

  test("pdf 分支：format=pdf → browserPrintToPdf（不走 screenshot）", async () => {
    const deps = makeDeps({
      planExportJobs: vi.fn(() => ({
        jobs: [{ id: "j2", project: "p2", layers: [], sizeId: "hd", sizeLabel: "1920x1080", width: 1920, height: 1080, format: "pdf", fileName: "p2.pdf" }],
        errors: [], skipped: []
      }))
    });
    const started = await invoke("op:map:export:batch:start", { body: {} }, deps);
    const batchId = (started as { data: { batchId: string } }).data.batchId;
    await vi.waitFor(async () => {
      const st = await invoke("op:map:export:batch:status", { query: { id: batchId } }, deps);
      expect((st as { data: { status: string } }).data.status).toBe("completed");
    });
    expect(deps.browserPrintToPdf).toHaveBeenCalledWith("map-export|batch");
    expect(deps.browserScreenshot).not.toHaveBeenCalled();
    expect(deps.writeFile).toHaveBeenCalledWith("W:\\ws\\地图导出\\p2.pdf", Buffer.from("UERG", "base64"));
  });

  test("页面错误探测：__OAW_EXPORT_ERROR 非空 → 批次 failed（导出视图异常：...）", async () => {
    const deps = makeDeps({ browserEvaluateValue: vi.fn(async () => "图层加载失败") });
    const started = await invoke("op:map:export:batch:start", { body: {} }, deps);
    const batchId = (started as { data: { batchId: string } }).data.batchId;
    await vi.waitFor(async () => {
      const st = await invoke("op:map:export:batch:status", { query: { id: batchId } }, deps);
      const data = (st as { data: Record<string, any> }).data;
      expect(data.status).toBe("failed");
      expect(data.error).toBe("导出视图异常：图层加载失败");
    });
    expect(deps.writeFile).not.toHaveBeenCalled();
  });

  test("产物路径越界：workspace 归一异常 → throw 越界（ensureDir 已调、不落盘）", async () => {
    const deps = makeDeps({ normalizeWorkspace: vi.fn(() => "..\\esc") });
    const started = await invoke("op:map:export:batch:start", { body: {} }, deps);
    const batchId = (started as { data: { batchId: string } }).data.batchId;
    await vi.waitFor(async () => {
      const st = await invoke("op:map:export:batch:status", { query: { id: batchId } }, deps);
      const data = (st as { data: Record<string, any> }).data;
      expect(data.status).toBe("failed");
      expect(data.error).toBe("导出产物路径越界");
    });
    expect(deps.ensureDir).toHaveBeenCalled();
    expect(deps.writeFile).not.toHaveBeenCalled();
  });
});
