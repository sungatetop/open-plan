/**
 * S3-8 map 域单侧测试：导出面（35 导出）/ 锚点 sanity（staticRoot/DEFAULT_PROJECT/
 * GLYPHS_URL）/ projectDir 防目录穿越边界 / 底图与设置（getBasemaps/loadMapSettings 与
 * 真实 maps/settings*.json 同源）/ 真实数据面只读（listProjects/getProject/
 * getTrafficBandwidth/getODLines/getExchangeSankey/getRoadStructure/getBus*，无论数据
 * 有无断言形状稳定）/ hydrateBasemapSources 全分支（悬空 vector source 剔除+级联图层
 * 剔除、重复图层 id 去重、paint.line-cap 迁移、跨类型 paint 家族剔除、缺底图插入）/
 * 项目 CRUD 全链路真实写盘（create/duplicate/rename/archive/saveStyle/saveConfig/
 * rebuildBasemapStyle/importLayer/importBatch/rebuildTiles/getLayer/deleteLayer/
 * deleteProject，临时项目唯一 id，关键结果绝对断言）/ 错误码文案逐字（INVALID/
 * EXISTS/BASE_NOT_FOUND/NOT_FOUND/PROTECTED）/ 网络面无外呼分支（route 缺参、
 * amap 无 Key stubEnv、isochrone 无 Key 条件断言；真实外呼有意不做）。
 *
 * 真实 IO：modern 静态 import src/main/backend/map.ts，MAPS_ROOT 锚点 office-workspace/maps
 * （beforeAll 固定默认工作区锚，防 .workspace-state.json 残留切换态干扰），
 * tiler（LAYER_DEFS/buildProjectTiles）引用物理模块 scripts/lib/tiler.mjs。
 * 写盘面在 office-workspace/maps 下用唯一临时项目 id，beforeAll 记 .trash 快照，
 * afterAll 差集清理。duplicatedAt/archivedAt/trash 名含时间戳：冻结 Date 断言
 * （fake timers toFake:["Date"]；rename 退避死循环仅在 rename 失败时触发，正常路径
 * 不进退避，风险可控）。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as modern from "../src/main/backend/map";
import { setWorkspace, WORKSPACE_DIR } from "../src/main/backend/workspace";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "../..");
const MAPS_ROOT = path.join(PROJECT_ROOT, "office-workspace", "maps");

function captureSync(fn: () => unknown): any {
  try { fn(); } catch (e) { return e; }
  return null;
}

describe("S3-8 map 域", () => {
  const impl: any = modern;
  const id = "s3ppm";
  const idDup = `${id}-dup`;
  const idRen = `${id}-ren`;
  let trashBefore: string[] = [];

  beforeAll(() => {
    // 地图库锚点跟随当前工作区（2026-10-30 改造）：测试固定默认工作区锚
    setWorkspace(WORKSPACE_DIR);
    trashBefore = fs.existsSync(path.join(MAPS_ROOT, ".trash")) ? fs.readdirSync(path.join(MAPS_ROOT, ".trash")) : [];
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-24T02:00:00Z"));
  }, 120000);

  afterAll(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    // 差集清理：临时项目目录 + .trash 新增项
    for (const pid of [id, idDup, idRen]) {
      try { fs.rmSync(path.join(MAPS_ROOT, pid), { recursive: true, force: true }); } catch {}
    }
    const trashDir = path.join(MAPS_ROOT, ".trash");
    if (fs.existsSync(trashDir)) {
      for (const entry of fs.readdirSync(trashDir)) {
        if (!trashBefore.includes(entry)) {
          try { fs.rmSync(path.join(trashDir, entry), { recursive: true, force: true }); } catch {}
        }
      }
    }
  });

  // ---- 导出面与锚点 ----
  it("导出面（35 导出）", () => {
    expect(Object.keys(impl).length).toBe(35);
  });

  it("锚点 sanity：staticRoot/DEFAULT_PROJECT/GLYPHS_URL", () => {
    expect(impl.staticRoot()).toBe(MAPS_ROOT);
    expect(impl.DEFAULT_PROJECT).toBe("zhejiang-map");
    expect(impl.GLYPHS_URL).toBe("/glyphs/{fontstack}/{range}.pbf");
  });

  it("projectDir：默认/合法/穿越/空/超长/特殊字符", () => {
    expect(impl.projectDir()).toBe(path.join(MAPS_ROOT, "zhejiang-map"));
    expect(impl.projectDir("abc_1")).toBe(path.join(MAPS_ROOT, "abc_1"));
    expect(impl.projectDir("../evil")).toBeNull();
    expect(impl.projectDir("-bad")).toBeNull();
    expect(impl.projectDir("")).toBeNull();
    expect(impl.projectDir(null)).toBeNull();
    expect(impl.projectDir("a".repeat(65))).toBeNull();
    expect(impl.projectDir("含中文")).toBeNull();
    expect(impl.projectDir("a b")).toBeNull();
  });

  it("getBasemaps/loadMapSettings：与真实设置文件同源", () => {
    const bm = impl.getBasemaps();
    // 无 Key 状态：tianditu/maptiler 系不出现；blank/gaode/esri/免 Key 系固定存在
    const keys = Object.keys(bm);
    for (const fixed of ["blank", "gaode-road", "gaode-sat", "gaode-sat-label", "osm-standard", "carto-positron", "carto-dark", "carto-voyager", "opentopomap", "tencent-road", "tencent-satellite", "esri-sat", "esri-street"]) {
      expect(keys).toContain(fixed);
      expect(bm[fixed].metadata.basemap).toBe(true);
    }
    expect(bm.blank.tiles).toEqual([]);
    const settings = impl.loadMapSettings();
    if (!settings.basemaps.tiandituKey) {
      expect(keys.some((k) => k.startsWith("tianditu-"))).toBe(false);
    }
    if (!settings.basemaps.maptilerKey) {
      expect(keys.some((k) => k.startsWith("maptiler-"))).toBe(false);
    }
  });

  it("真实数据面只读：listProjects/getProject(DEFAULT)/getLayer 缺失", () => {
    expect(Array.isArray(impl.listProjects())).toBe(true);
    expect(impl.listProjects().some((p: any) => p.project === impl.DEFAULT_PROJECT)).toBe(true);
    const def = impl.getProject(impl.DEFAULT_PROJECT);
    expect(def).not.toBeNull();
    expect(def.config.project).toBe(impl.DEFAULT_PROJECT);
    expect(impl.getProject("__no_such__")).toBeNull();
    expect(impl.getProject("../evil")).toBeNull();
    expect(impl.getLayer(impl.DEFAULT_PROJECT, "__no_layer__")).toBeNull();
    expect(impl.getLayer("__no_such__", "x")).toBeNull();
    expect(impl.getLayer(impl.DEFAULT_PROJECT, "../evil")).toBeNull();
  });

  it("M2/M3 数据面：不存在项目错误分支逐字 + 真实数据形状", () => {
    expect(impl.getTrafficBandwidth("__no_such__")).toEqual({ error: "项目不存在" });
    expect(impl.getODLines("__no_such__")).toEqual({ error: "项目不存在" });
    expect(impl.getExchangeSankey("__no_such__")).toEqual({ error: "项目不存在" });
    expect(impl.getRoadStructure("__no_such__")).toEqual({ error: "项目不存在" });
    // 真实数据在场：统一 { error: null, geojson/data, stats } 形状断言
    const bw = impl.getTrafficBandwidth();
    expect(bw.error).toBeNull();
    expect(bw.geojson.type).toBe("FeatureCollection");
    expect(typeof bw.stats.count).toBe("number");
    expect(typeof bw.stats.withTraffic).toBe("number");
    const od = impl.getODLines();
    expect(od.error).toBeNull();
    expect(od.geojson.type).toBe("FeatureCollection");
    expect(od.stats.levels).toEqual({ high: expect.any(Number), medium: expect.any(Number), low: expect.any(Number) });
    const sankey = impl.getExchangeSankey();
    expect(sankey.error).toBeNull();
    expect(sankey.stats).toEqual({ nodes: expect.any(Number), links: expect.any(Number), totalVolume: expect.any(Number) });
    const road = impl.getRoadStructure();
    expect(road.error).toBeNull();
    // LAYER_DEFS 七内置图层中 roads-rural.geojson 不在场 → stats 仅六键
    expect(Object.keys(road.stats).sort()).toEqual(["boundary-city", "boundary-county", "highways", "junctions", "roads-trunk", "toll-stations"]);
    const routes = impl.getBusRoutes();
    expect(routes.error).toBeNull();
    expect(routes.geojson.type).toBe("FeatureCollection");
    expect(routes.stats).toEqual({ total: expect.any(Number), urban: expect.any(Number), suburban: expect.any(Number), totalLength: expect.any(Number) });
    const stops = impl.getBusStops();
    expect(stops.error).toBeNull();
    expect(stops.geojson.type).toBe("FeatureCollection");
    expect(typeof stops.stats.count).toBe("number");
    const odAll = impl.getBusOD();
    expect(odAll.error).toBeNull();
    expect(odAll.geojson.type).toBe("FeatureCollection");
    expect(odAll.stats).toEqual({ pairs: expect.any(Number), totalFlow: expect.any(Number) });
    const odAm = impl.getBusOD("am");
    expect(odAm.error).toBeNull();
    expect(odAm.stats.pairs).toBeLessThanOrEqual(odAll.stats.pairs);
    const busStats = impl.getBusStats();
    expect(busStats.error).toBeNull();
    expect(busStats.stats).toEqual({ routes: expect.any(Number), stops: expect.any(Number), coverage: 0, byType: expect.any(Array) });
  }, 30000); // 全量扫真实 M2/M3 数据，IO 重，放宽超时

  it("hydrateBasemapSources：悬空剔除/重复 id 去重/line-cap 迁移/跨类型 paint 剔除/缺底图插入", () => {
    const style = {
      version: 8,
      name: "对拍样式",
      sources: {
        "dangling-vec": { type: "vector", tiles: ["/api/map/data/__no_such_proj__/tiles/foo/{z}/{x}/{y}.pbf"], maxzoom: 13 },
        "custom-fill": { type: "geojson", data: "x.json" },
      },
      layers: [
        // 悬空 vector source 引用层 → 级联剔除
        { id: "ldang", type: "line", source: "dangling-vec", paint: { "line-color": "#fff" } },
        // 跨类型 paint 家族剔除（line 层的 text-color）+ line-cap paint→layout 迁移
        { id: "lcap", type: "line", source: "custom-fill", paint: { "line-color": "#f00", "line-cap": "round", "text-color": "#000" } },
        // 重复 id（首次出现保留，本 fill 版被去重删除）
        { id: "lcap", type: "fill", source: "custom-fill", paint: { "fill-color": "#ddd" } },
        // fill 层跨类型 paint 键（circle-radius）剔除
        { id: "lfill", type: "fill", source: "custom-fill", paint: { "fill-color": "#eee", "circle-radius": 3 } },
        // 空 id 剔除
        { id: "", type: "fill", source: "custom-fill", paint: {} },
      ],
    };
    const out = impl.hydrateBasemapSources(JSON.parse(JSON.stringify(style)));
    // 悬空 vector source 被剔除（无对应 tiles 目录），其引用图层级联剔除
    expect(out.sources["dangling-vec"]).toBeUndefined();
    expect(out.layers.some((l: any) => l.source === "dangling-vec")).toBe(false);
    // 免 Key 底图全量注入
    for (const fixed of ["blank", "gaode-road", "esri-sat", "osm-standard"]) {
      expect(out.sources[fixed]).toBeDefined();
      expect(out.sources[fixed].metadata.basemap).toBe(true);
    }
    // line-cap 从 paint 迁移到 layout；line 层跨类型 text-color 剔除
    const lcap = out.layers.find((l: any) => l.id === "lcap");
    expect(lcap.type).toBe("line");
    expect(lcap.paint["line-cap"]).toBeUndefined();
    expect(lcap.layout["line-cap"]).toBe("round");
    expect(lcap.paint["text-color"]).toBeUndefined();
    expect(lcap.paint["line-color"]).toBe("#f00");
    // fill 层跨类型 circle-radius 剔除，fill-color 保留
    const lfill = out.layers.find((l: any) => l.id === "lfill");
    expect(lfill.paint["circle-radius"]).toBeUndefined();
    expect(lfill.paint["fill-color"]).toBe("#eee");
    // 重复 id 去重（首次出现保留）+ 空 id 剔除
    const ids = out.layers.map((l: any) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.includes("")).toBe(false);
    expect(out.layers.filter((l: any) => l.id === "lcap").length).toBe(1);
    // 缺失底图图层插入到第一个业务图层之前
    const firstBiz = out.layers.findIndex((l: any) => !String(l?.id || "").startsWith("basemap-"));
    expect(firstBiz).toBeGreaterThanOrEqual(0);
    expect(out.layers.slice(0, firstBiz).every((l: any) => String(l.id).startsWith("basemap-"))).toBe(true);
    expect(out.layers.slice(firstBiz).map((l: any) => l.id)).toEqual(["lcap", "lfill"]);
  });

  // ---- 项目 CRUD 全链路（真实写盘，关键结果绝对断言） ----
  it("createProject：新建项目 config/style 形状与默认值", () => {
    const r = impl.createProject({ project: id, name: "对拍项目" });
    expect(r.config.project).toBe(id);
    expect(r.config.name).toBe("对拍项目");
    expect(r.config.center).toEqual([120.0, 29.2]);
    expect(r.config.zoom).toBe(7);
    expect(r.config.basemap).toBe("gaode-road");
    expect(r.config.layers.map((l: any) => l.id)).toEqual(["boundary-city", "boundary-county", "highways", "roads-trunk", "roads-rural", "toll-stations", "junctions"]);
    expect(r.config.layers[0].group).toBe("行政区划");
    expect(r.style.version).toBe(8);
    expect(r.style.glyphs).toBe(impl.GLYPHS_URL);
    expect(r.style.sources["blank"].tiles).toEqual([]);
    expect(r.style.layers.filter((l: any) => l.id.startsWith("basemap-")).length).toBeGreaterThan(10);
  });

  it("createProject 错误分支：重复 EXISTS / 非法 INVALID / baseProject 缺失，文案与 code 逐字", () => {
    const dup = captureSync(() => impl.createProject({ project: id }));
    expect(dup.code).toBe("MAP_PROJECT_EXISTS");
    expect(dup.message).toBe(`地图项目已存在：${id}`);
    const bad = captureSync(() => impl.createProject({ project: "../bad" }));
    expect(bad.code).toBe("MAP_PROJECT_INVALID");
    expect(bad.message).toBe("项目标识需为 1-64 位英文、数字、下划线或短横线，且以字母或数字开头");
    const noBase = captureSync(() => impl.createProject({ project: `${id}b`, baseProject: "__no_such__" }));
    expect(noBase.code).toBe("MAP_BASE_PROJECT_NOT_FOUND");
    expect(noBase.message).toBe("基础地图项目不存在：__no_such__");
  });

  it("duplicateProject：副本 config（duplicatedFrom/名/duplicatedAt 冻结一致）", () => {
    const r = impl.duplicateProject({ project: id, name: idDup });
    expect(r.config.project).toBe(idDup);
    expect(r.config.name).toBe("对拍项目 副本");
    expect(r.config.duplicatedFrom).toBe(id);
    expect(r.config.duplicatedAt).toBe("2026-10-24T02:00:00.000Z");
    expect(r.style).toBeDefined();
    const noSrc = captureSync(() => impl.duplicateProject({ project: "__no_such__" }));
    expect(noSrc.code).toBe("MAP_PROJECT_NOT_FOUND");
    expect(noSrc.message).toBe("源地图项目不存在：__no_such__");
    const bad = captureSync(() => impl.duplicateProject({ project: id, name: "-bad" }));
    expect(bad.code).toBe("MAP_PROJECT_INVALID");
  });

  it("renameProject：目录更名 + config 回写；默认项目 PROTECTED", () => {
    const r = impl.renameProject({ project: idDup, name: idRen });
    expect(r.config.project).toBe(idRen);
    // 旧码语义：rename 只改 project 标识，非空 name 保留（duplicate 时的 "副本" 名）
    expect(r.config.name).toBe("对拍项目 副本");
    expect(fs.existsSync(path.join(MAPS_ROOT, idDup))).toBe(false);
    expect(fs.existsSync(path.join(MAPS_ROOT, idRen, "map.config.json"))).toBe(true);
    const prot = captureSync(() => impl.renameProject({ project: impl.DEFAULT_PROJECT, name: "x" }));
    expect(prot.code).toBe("MAP_PROJECT_PROTECTED");
    expect(prot.message).toBe("默认地图项目不能重命名");
    const noSrc = captureSync(() => impl.renameProject({ project: "__no_such__", name: "x" }));
    expect(noSrc.code).toBe("MAP_PROJECT_NOT_FOUND");
    const noTarget = captureSync(() => impl.renameProject({ project: idRen, name: "-bad" }));
    expect(noTarget.code).toBe("MAP_PROJECT_INVALID");
  });

  it("archiveProject：归档与恢复（archivedAt 冻结一致）", () => {
    const archived = impl.archiveProject(idRen, true);
    expect(archived.archived).toBe(true);
    expect(archived.archivedAt).toBe("2026-10-24T02:00:00.000Z");
    const restored = impl.archiveProject(idRen, false);
    expect(restored.archived).toBe(false);
    expect(restored.archivedAt).toBeNull();
    expect(impl.archiveProject("__no_such__")).toBeNull();
  });

  it("saveStyle/saveConfig：写回读回一致", () => {
    const cfg = impl.getProject(idRen).config;
    cfg.zoom = 9;
    expect(impl.saveConfig(idRen, cfg)).toBe(true);
    const style = impl.getProject(idRen).style;
    style.name = "对拍样式改";
    expect(impl.saveStyle(idRen, style)).toBe(true);
    expect(impl.getProject(idRen).config.zoom).toBe(9);
    expect(impl.getProject(idRen).style.name).toBe("对拍样式改");
    expect(impl.saveStyle("__no_such__", {})).toBeNull();
    expect(impl.saveStyle(idRen, null)).toBeNull();
    expect(impl.saveConfig("__no_such__", {})).toBeNull();
  });

  it("importLayer：点要素导入 + 瓦片重建（count/bytes）+ config/style 注册", async () => {
    const fc = { type: "FeatureCollection", features: [
      { type: "Feature", properties: { name: "A" }, geometry: { type: "Point", coordinates: [120.1, 29.2] } },
      { type: "Feature", properties: { name: "B" }, geometry: { type: "Point", coordinates: [120.3, 29.4] } },
    ] };
    const r = await impl.importLayer(id, "s3p_layer", fc);
    expect(r.ok).toBe(true);
    expect(r.layer).toBe("s3p_layer");
    expect(r.features).toBe(2);
    expect(r.bbox).toEqual([120.1, 29.2, 120.3, 29.4]);
    expect(r.tiles.count).toBeGreaterThan(0);
    // config 注册（type=point → group=设施点）
    const cfg = impl.getProject(id).config;
    const layer = cfg.layers.find((l: any) => l.id === "s3p_layer");
    expect(layer).toBeDefined();
    expect(layer.type).toBe("point");
    expect(layer.group).toBe("设施点");
    // style 注册（rebuildBasemapStyle 在 import 内部已跑）
    const style = impl.getProject(id).style;
    expect(style.sources["s3p_layer"]).toBeDefined();
    expect(style.layers.some((l: any) => l.id === "s3p_layer")).toBe(true);
    // getLayer 读回深等
    expect(impl.getLayer(id, "s3p_layer")).toEqual(fc);
    // 重复导入覆盖不重复注册
    await impl.importLayer(id, "s3p_layer", fc);
    const cfg2 = impl.getProject(id).config;
    expect(cfg2.layers.filter((l: any) => l.id === "s3p_layer").length).toBe(1);
    // 非法输入
    expect(await impl.importLayer(id, "", fc)).toBeNull();
    expect(await impl.importLayer("../evil", "x", fc)).toBeNull();
    const err = await importLayerCatch(impl, id, "bad", { type: "FeatureCollection", features: [] });
    expect(err.message).toBe("没有可导入的要素（需要非空 FeatureCollection）");
    const noCoord = await importLayerCatch(impl, id, "bad", { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [] } }] });
    expect(noCoord.message).toBe("要素没有有效几何坐标");
    const oob = await importLayerCatch(impl, id, "bad", { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [200, 10] } }] });
    expect(oob.message).toBe("坐标不在经纬度范围内，请先转换为 WGS84/EPSG:4326");
  });

  it("importBatch：混合导入（合法+坏图层），坏项 ok:false 导入失败 文案逐字", async () => {
    const fc = { type: "FeatureCollection", features: [
      { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [120.0, 29.0] } },
    ] };
    const r = await impl.importBatch(id, [
      { layerId: "s3p_batch", geojson: fc },
      { layerId: "s3p_bad", geojson: { type: "FeatureCollection", features: [] } },
      { layerId: "", geojson: fc },
      { geojson: fc },
    ]);
    expect(r.ok).toBe(false);
    expect(r.layers["s3p_batch"].ok).toBe(true);
    expect(r.layers["s3p_bad"]).toEqual({ ok: false, error: "导入失败" });
    expect(r.layers[""]).toBeUndefined();
  });

  it("rebuildBasemapStyle：底图重建保留业务图层", () => {
    expect(impl.rebuildBasemapStyle(id)).toBe(true);
    expect(impl.rebuildBasemapStyle("__no_such__")).toBe(false);
    const style = impl.getProject(id).style;
    expect(style.layers.filter((l: any) => String(l.id).startsWith("basemap-")).length).toBeGreaterThan(10);
    expect(style.layers.some((l: any) => l.id === "s3p_layer")).toBe(true);
  });

  it("rebuildTiles：全量重建仅内置图层（无数据 count 0 skipped）", () => {
    const r = impl.rebuildTiles(id);
    // rebuildTiles 的 defs 默认 LAYER_DEFS：只覆盖 7 个内置图层（业务图层不在其列）
    expect(Object.keys(r).sort()).toEqual(["boundary-city", "boundary-county", "highways", "junctions", "roads-rural", "roads-trunk", "toll-stations"]);
    for (const fixed of Object.keys(r)) {
      expect(r[fixed]).toEqual({ count: 0, bytes: 0, skipped: true });
    }
  });

  it("deleteLayer：geojson+瓦片+style+config 四面清除", () => {
    expect(impl.deleteLayer(id, "s3p_batch")).toEqual({ ok: true });
    expect(impl.deleteLayer(id, "__no_layer__")).toEqual({ ok: true }); // 不存在也 ok（旧码语义：文件不存在跳过）
    expect(impl.deleteLayer(id, "")).toEqual({ ok: false, error: "invalid layer" });
    const p = impl.getProject(id);
    expect(p.files.some((f: any) => f.id === "s3p_batch")).toBe(false);
    expect(p.config.layers.some((l: any) => l.id === "s3p_batch")).toBe(false);
    expect(p.style.sources["s3p_batch"]).toBeUndefined();
  });

  it("deleteProject：移入 .trash（trash 名冻结一致）；默认项目 PROTECTED；缺失 NOT_FOUND", () => {
    const prot = captureSync(() => impl.deleteProject(impl.DEFAULT_PROJECT));
    expect(prot.code).toBe("MAP_PROJECT_PROTECTED");
    expect(prot.message).toBe("默认地图项目不能删除");
    const no = captureSync(() => impl.deleteProject("__no_such__"));
    expect(no.code).toBe("MAP_PROJECT_NOT_FOUND");
    expect(no.message).toBe("地图项目不存在：__no_such__");
    const r1 = impl.deleteProject(idRen);
    expect(r1.deleted).toBe(idRen);
    expect(r1.trash).toBe(`${idRen}-${Date.now().toString(36)}`);
    expect(fs.existsSync(path.join(MAPS_ROOT, idRen))).toBe(false);
    expect(fs.existsSync(path.join(MAPS_ROOT, ".trash", r1.trash))).toBe(true);
  });

  it("网络面无外呼分支：route 缺参 / amap 无 Key / isochrone 无 Key（条件）/ multiIsochrone 缺中心", async () => {
    expect(await impl.route({})).toEqual({ error: "需要起点和终点坐标" });
    expect(await impl.route({ from: "120,30" })).toEqual({ error: "需要起点和终点坐标" });
    vi.stubEnv("AMAP_KEY", "");
    vi.stubEnv("GAODE_KEY", "");
    vi.stubEnv("GEOAPIFY_KEY", "");
    expect(await impl.route({ from: "120,30", to: "121,31", provider: "amap" })).toEqual({ error: "未配置高德 Web 服务 Key（环境变量 AMAP_KEY），请改用默认 OSRM 开源路由" });
    const settings = impl.loadMapSettings();
    if (!settings.basemaps?.geoapifyKey) {
      expect(await impl.isochrone({ location: "120,30" })).toEqual({ error: "未配置 Geoapify 或高德等时圈 Key（可在设置中配置 Geoapify Key）" });
    }
    expect(await impl.multiIsochrone({})).toEqual({ error: "需要中心点坐标" });
    expect(await impl.multiIsochrone({ location: "120,30", ranges: [] })).toEqual({ error: "至少需要一个有效时距" });
  });
});

/** importLayer 的 throw 捕获（async 错误） */
async function importLayerCatch(impl: any, name: string, layerId: string, geojson: any): Promise<any> {
  try { await impl.importLayer(name, layerId, geojson); } catch (e) { return e; }
  return null;
}
