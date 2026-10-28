// @vitest-environment jsdom
/**
 * F5-5 MapViewer 组件对拍（client/src/components/MapViewer.jsx → map-viewer.tsx 三面）。
 *
 * 对拍口径（MapLibre 引擎全桩：vi.mock("maplibre-gl") 捕获构造参数与实例方法调用）：
 *   A. 渲染参数面：构造参数（container/style 来自 op:map:data:style 通道对象注入/
 *      center/zoom 配置与缺省/canvasContextAttributes.preserveDrawingBuffer/attributionControl.compact）+
 *      控件挂载（NavigationControl visualizePitch / ScaleConfig）+ window.__oawMap 钩子 +
 *      加载遮罩状态机（加载中→load 事件解除/失败→错误面+重新加载按钮 remount）；
 *   B. 轮询 hash 热更面：3s interval 拉取 op:map:data:style；文本变化 →
 *      setStyle(新样式, { diff: false }) + jumpTo 保相机（getCenter/getZoom 原值）；
 *      同 hash 不重复 setStyle（styleHash 游标语义）；
 *   C. ref API 面：getMap/getViewport/setBasemap（setLayoutProperty 显隐 + onBasemapResolved）/
 *      setProjection/setCoverageMode（road 图层 setFilter null）/showAnalysis→clearAnalysis
 *      （addSource/addLayer/removeLayer/removeSource 家族）/startDraw+stopDraw
 *      （draw-layer source + draw-line/draw-dots 图层 + click 数据流 + Esc/stop 清理）。
 *
 * 语义差异声明（与旧版对拍口径一致）：初始 style 由「URL 引用+引擎自拉」改为
 * 「op:map:data:style 通道文本 + 对象注入」，本文件以桩捕获方式验证通道消费一致性。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/* ==================== 模块桩 ==================== */

// client-api：只替换 map 族三个消费点，其余透传真实实现（纯类型/纯函数模块无副作用）
vi.mock("../src/renderer/api/client-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/renderer/api/client-api")>();
  return {
    ...actual,
    mapDataStyleText: vi.fn(async () => "{}"),
    mapImportLayer: vi.fn(async () => ({})),
    mapGetLayer: vi.fn(async () => undefined)
  };
});

vi.mock("shpjs", () => ({ default: vi.fn() }));

// MapLibre 引擎全桩：类定义放工厂内（vi.mock 提升约束），测试经 import 拿到桩引用
vi.mock("maplibre-gl", () => {
  class FakeBounds {
    constructor(private w = 118, private s = 27, private e = 122.5, private n = 31.5) {}
    getWest() { return this.w; }
    getSouth() { return this.s; }
    getEast() { return this.e; }
    getNorth() { return this.n; }
  }
  class FakeMap {
    options: Record<string, unknown>;
    handlers = new Map<string, Set<(e?: unknown) => void>>();
    layers = new Set<string>();
    sources = new Map<string, Record<string, unknown>>();
    controls: Array<[unknown, string]> = [];
    styleCalls: Array<[unknown, unknown]> = [];
    jumps: unknown[] = [];
    filters: Array<[string, unknown]> = [];
    layoutProps: Array<[string, string, unknown]> = [];
    paintProps: Array<[string, string, unknown]> = [];
    projectionCalls: unknown[] = [];
    removedLayers: string[] = [];
    removedFlag = false;
    styleLayers: Array<Record<string, unknown>>;
    styleLoaded = true;
    static instances: FakeMap[] = [];
    constructor(options: Record<string, unknown>) {
      this.options = options;
      this.styleLayers = ((options.style as { layers?: Array<Record<string, unknown>> })?.layers ?? []);
      for (const l of this.styleLayers) this.layers.add(String(l.id));
      FakeMap.instances.push(this);
    }
    on(ev: string, fn: (e?: unknown) => void) {
      if (!this.handlers.has(ev)) this.handlers.set(ev, new Set());
      this.handlers.get(ev)!.add(fn);
    }
    once(ev: string, fn: (e?: unknown) => void) { this.on(ev, fn); }
    off(ev: string, fn: (e?: unknown) => void) { this.handlers.get(ev)?.delete(fn); }
    emit(ev: string, payload?: unknown) {
      const hs = this.handlers.get(ev);
      if (!hs) return;
      for (const h of [...hs]) h(payload ?? {});
    }
    addControl(ctrl: unknown, pos: string) { this.controls.push([ctrl, pos]); }
    remove() { this.removedFlag = true; }
    isStyleLoaded() { return this.styleLoaded; }
    loaded() { return true; }
    getStyle() { return { layers: this.styleLayers }; }
    getLayer(id: string) { return this.layers.has(id) ? { id } : undefined; }
    getSource(id: string) {
      const def = this.sources.get(id);
      if (!def) return undefined;
      return { ...def, setData: (d: unknown) => { this.sources.set(id, { ...def, data: d }); } };
    }
    addSource(id: string, def: Record<string, unknown>) {
      this.sources.set(id, { ...def, __id: id });
    }
    addLayer(def: Record<string, unknown>) {
      this.layers.add(String(def.id));
      this.styleLayers = [...this.styleLayers, def];
    }
    removeLayer(id: string) {
      this.layers.delete(id);
      this.removedLayers.push(id);
      this.styleLayers = this.styleLayers.filter((l) => l.id !== id);
    }
    removeSource(id: string) { this.sources.delete(id); }
    setLayoutProperty(id: string, key: string, val: unknown) { this.layoutProps.push([id, key, val]); }
    setPaintProperty(id: string, key: string, val: unknown) { this.paintProps.push([id, key, val]); }
    getPaintProperty(id: string, key: string) {
      const hit = this.paintProps.find(([i, k]) => i === id && k === key);
      return hit ? hit[2] : undefined;
    }
    setFilter(id: string, f: unknown) { this.filters.push([id, f]); }
    setStyle(style: unknown, opts: unknown) {
      this.styleCalls.push([style, opts]);
      this.styleLayers = ((style as { layers?: Array<Record<string, unknown>> })?.layers ?? []);
      for (const l of this.styleLayers) this.layers.add(String(l.id));
    }
    jumpTo(cam: unknown) { this.jumps.push(cam); }
    fitBounds() {}
    getCenter() { return { lng: 120.0, lat: 29.2 }; }
    getZoom() { return 7; }
    getBounds() { return new FakeBounds(); }
    queryRenderedFeatures() { return []; }
    getCanvas() { return { style: { cursor: "" } }; }
    moveLayer() {}
    setProjection(o: unknown) { this.projectionCalls.push(o); }
  }
  class FakePopup {
    opts: Record<string, unknown>;
    static instances: FakePopup[] = [];
    constructor(opts: Record<string, unknown>) { this.opts = opts; FakePopup.instances.push(this); }
    setLngLat() { return this; }
    setHTML() { return this; }
    addTo() { return this; }
    remove() { return this; }
  }
  class NavigationControl { opts: Record<string, unknown>; constructor(opts: Record<string, unknown> = {}) { this.opts = opts; } }
  class ScaleControl { opts: Record<string, unknown>; constructor(opts: Record<string, unknown> = {}) { this.opts = opts; } }
  class LngLatBounds { extend() { return this; } isEmpty() { return false; } }
  return { Map: FakeMap, Popup: FakePopup, NavigationControl, ScaleControl, LngLatBounds };
});

const { mapDataStyleText, mapGetLayer } = await import("../src/renderer/api/client-api");
const { default: MapViewer } = await import("../src/renderer/features/map/map-viewer");
const { Map: FakeMapRef, Popup: FakePopupRef, NavigationControl, ScaleControl } = await import("maplibre-gl");

type FakeMapLike = {
  options: Record<string, unknown>;
  handlers: Map<string, Set<(e?: unknown) => void>>;
  layers: Set<string>;
  sources: Map<string, Record<string, unknown>>;
  controls: Array<[unknown, string]>;
  styleCalls: Array<[unknown, unknown]>;
  jumps: unknown[];
  filters: Array<[string, unknown]>;
  layoutProps: Array<[string, string, unknown]>;
  removedLayers: string[];
  removedFlag: boolean;
  emit(ev: string, payload?: unknown): void;
};
type PopupOpts = { opts: Record<string, unknown> };

const fakeMaps = () => (FakeMapRef as unknown as { instances: FakeMapLike[] }).instances;
const fakePopups = () => (FakePopupRef as unknown as { instances: PopupOpts[] }).instances;
/** noUncheckedIndexedAccess 友好取桩（测试前置保证实例已挂载） */
const mapAt = (i: number): FakeMapLike => fakeMaps()[i]!;

/* ==================== 样式夹具 ==================== */

// layers：basemap-* 不带 source（隔离 roadLayerIds 过滤面，专测底图与下钻分域）
const STYLE_A = {
  version: 8,
  glyphs: "/glyphs/{fontstack}/{range}.pbf",
  sources: {
    roads: { type: "vector", tiles: ["/api/map/data/zhejiang-map/tiles/roads/{z}/{x}/{y}.pbf"] }
  },
  layers: [
    { id: "basemap-gaode-road", type: "line" },
    { id: "basemap-gaode-sat", type: "line" },
    { id: "roads", type: "line", source: "roads", paint: { "line-color": "#334455" } },
    { id: "roads-label", type: "symbol", source: "roads" },
    { id: "boundary-city", type: "line", source: "boundary-city" }
  ]
};
const STYLE_B = JSON.parse(JSON.stringify(STYLE_A)) as typeof STYLE_A;
// 注意：styleHash = length + ":" + slice(0,200)，改动必须落进 hash 窗口（长度变化）
(STYLE_B.layers[2] as { paint: Record<string, string> }).paint["line-color"] = "#ff0000aa";
const TEXT_A = JSON.stringify(STYLE_A);
const TEXT_B = JSON.stringify(STYLE_B);

const ANALYSIS_FC = {
  type: "FeatureCollection",
  features: [{ type: "Feature", properties: { value: 5 }, geometry: { type: "Point", coordinates: [120.1, 29.3] } }]
};

/* ==================== 挂载 harness ==================== */

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(mapDataStyleText).mockReset();
  vi.mocked(mapGetLayer).mockReset();
  (fakeMaps() as unknown[]).length = 0;
  (fakePopups() as unknown[]).length = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  vi.useRealTimers();
});

/** 冲刷 boot 异步链（mapDataStyleText → new Map → markReady .then 链） */
const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
};

async function mountViewer(props: Record<string, unknown> = {}) {
  const ref = createRef<import("../src/renderer/features/map/map-viewer").MapViewerHandle>();
  await act(async () => {
    root.render(React.createElement(MapViewer, { ...props, ref }));
  });
  await flush();
  return ref;
}

/** 模拟引擎 load 事件（markReady 就绪语义：styledata/load/idle 任一） */
const emitLoad = async (map: FakeMapLike) => {
  await act(async () => { map.emit("load"); });
  await flush();
};

/* ==================== A. 渲染参数面 ==================== */

describe("F5-5 MapViewer 渲染参数面", () => {
  it("构造参数：style 对象来自通道文本 + config center/zoom + preserveDrawingBuffer + compact attribution", async () => {
    vi.mocked(mapDataStyleText).mockResolvedValue(TEXT_A);
    await mountViewer({ project: "zhejiang-map", config: { name: "浙江地图", center: [119.5, 28.8], zoom: 6.5 } });
    expect(fakeMaps()).toHaveLength(1);
    const map = mapAt(0);
    expect(map.options.container).toBeInstanceOf(HTMLElement);
    expect((map.options.container as HTMLElement).className).toBe("map-canvas");
    expect(map.options.style).toEqual(STYLE_A);
    expect(map.options.center).toEqual([119.5, 28.8]);
    expect(map.options.zoom).toBe(6.5);
    expect(map.options.canvasContextAttributes).toEqual({ preserveDrawingBuffer: true });
    expect(map.options.attributionControl).toEqual({ compact: true });
  });

  it("缺省 center/zoom 回退 [120.0,29.2]/7；控件挂载 NavigationControl visualizePitch + ScaleControl metric；__oawMap 钩子", async () => {
    vi.mocked(mapDataStyleText).mockResolvedValue(TEXT_A);
    await mountViewer({ project: "zhejiang-map" });
    const map = mapAt(0);
    expect(map.options.center).toEqual([120.0, 29.2]);
    expect(map.options.zoom).toBe(7);
    expect(map.controls).toHaveLength(2);
    const [navCtrl, navPos] = map.controls[0]!;
    const [scaleCtrl, scalePos] = map.controls[1]!;
    expect(navCtrl).toBeInstanceOf(NavigationControl);
    expect((navCtrl as unknown as { opts: Record<string, unknown> }).opts).toEqual({ visualizePitch: true });
    expect(navPos).toBe("bottom-right");
    expect(scaleCtrl).toBeInstanceOf(ScaleControl);
    expect((scaleCtrl as unknown as { opts: Record<string, unknown> }).opts).toEqual({ maxWidth: 120, unit: "metric" });
    expect(scalePos).toBe("bottom-left");
    expect((window as unknown as { __oawMap?: unknown }).__oawMap).toBe(map);
  });

  it("加载遮罩状态机：加载中→load 事件解除；卸载 remove + __oawMap 清空", async () => {
    vi.mocked(mapDataStyleText).mockResolvedValue(TEXT_A);
    const ref = await mountViewer({ project: "zhejiang-map", config: { name: "浙江地图" } });
    const map = mapAt(0);
    // boot 完成但引擎未就绪：遮罩仍在
    expect(host.querySelector(".map-loading")?.textContent).toContain("地图加载中");
    await emitLoad(map);
    // 就绪后：遮罩消失 + 工具条标题 + 状态栏缺省文案 + Popup 效果挂载
    expect(host.querySelector(".map-loading")).toBeNull();
    expect(host.querySelector(".map-toolbar-title")?.textContent).toContain("浙江地图");
    expect(host.querySelector(".map-status")?.textContent).toContain("点击要素查看属性");
    expect(fakePopups().length).toBeGreaterThanOrEqual(1);
    expect(fakePopups()[0]!.opts).toEqual({ closeButton: true, closeOnClick: false, maxWidth: "300px" });
    expect(ref.current?.getMap()).toBe(mapAt(0));
    await act(async () => { root.unmount(); });
    host.appendChild(document.createElement("div")); // 占位避免 remove() 后查询异常
    expect(map.removedFlag).toBe(true);
    expect((window as unknown as { __oawMap?: unknown }).__oawMap).toBeNull();
    root = createRoot(host); // 供 afterEach 再次 unmount（幂等）
    await flush();
  });

  it("boot 失败：错误面 + 重新加载按钮 remount 恢复", async () => {
    vi.mocked(mapDataStyleText).mockRejectedValueOnce(new Error("sidecar down"));
    await mountViewer({ project: "zhejiang-map" });
    expect(fakeMaps()).toHaveLength(0);
    expect(host.querySelector(".map-loading")?.textContent).toContain("地图样式加载失败，请重试");
    const btn = host.querySelector(".map-load-error button");
    expect(btn?.textContent).toContain("重新加载");
    // 重试：mock 恢复正常 → retryToken 触发 remount → 新引擎实例
    vi.mocked(mapDataStyleText).mockResolvedValue(TEXT_A);
    await act(async () => { (btn as HTMLButtonElement).click(); });
    await flush();
    expect(fakeMaps()).toHaveLength(1);
    expect(mapAt(0).options.style).toEqual(STYLE_A);
  });
});

/* ==================== B. 轮询 hash 热更面 ==================== */

describe("F5-5 MapViewer 轮询 hash 热更面", () => {
  it("3s 轮询：文本变化 → setStyle(新样式,{diff:false}) + jumpTo 保相机；同 hash 不重复 setStyle", async () => {
    vi.mocked(mapDataStyleText).mockResolvedValue(TEXT_A);
    await mountViewer({ project: "zhejiang-map" });
    const map = mapAt(0);
    await emitLoad(map);
    // markReady 游标同步后，未变更不触发 setStyle
    expect(map.styleCalls).toHaveLength(0);
    // agent 修改 style.json → 下一次轮询拉到新文本
    vi.mocked(mapDataStyleText).mockResolvedValue(TEXT_B);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(map.styleCalls).toHaveLength(1);
    const [applied, opts] = map.styleCalls[0]!;
    expect(applied).toEqual(STYLE_B);
    expect(opts).toEqual({ diff: false });
    // 相机保持：jumpTo 使用 getCenter/getZoom 原值（热更不跳视野）
    expect(map.jumps).toEqual([{ center: { lng: 120.0, lat: 29.2 }, zoom: 7 }]);
    // 同 hash（文本未再变化）→ 游标命中，不重复 setStyle
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(map.styleCalls).toHaveLength(1);
  });

  it("reloadStyle ref API 走同一热更路径（setStyle + 返回 true）；syncStyleHash 只动游标", async () => {
    vi.mocked(mapDataStyleText).mockResolvedValue(TEXT_A);
    const ref = await mountViewer({ project: "zhejiang-map" });
    const map = mapAt(0);
    await emitLoad(map);
    vi.mocked(mapDataStyleText).mockResolvedValue(TEXT_B);
    let reloaded = false;
    await act(async () => { reloaded = await ref.current!.reloadStyle(); });
    expect(reloaded).toBe(true);
    expect(map.styleCalls).toHaveLength(1);
    expect(map.styleCalls[0]![0]).toEqual(STYLE_B);
    expect(map.styleCalls[0]![1]).toEqual({ diff: false });
    // syncStyleHash：游标对齐，不触发 setStyle
    vi.mocked(mapDataStyleText).mockResolvedValue(TEXT_A);
    let synced = false;
    await act(async () => { synced = await ref.current!.syncStyleHash(); });
    expect(synced).toBe(true);
    expect(map.styleCalls).toHaveLength(1);
    // 轮询继续：游标已对齐 TEXT_A → 同 hash 不 setStyle
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(map.styleCalls).toHaveLength(1);
  });
});

/* ==================== C. ref API 面 ==================== */

describe("F5-5 MapViewer ref API 面", () => {
  it("getMap/getViewport：实例透引 + 视口快照（center/zoom/bounds）", async () => {
    vi.mocked(mapDataStyleText).mockResolvedValue(TEXT_A);
    const ref = await mountViewer({ project: "zhejiang-map" });
    const map = mapAt(0);
    expect(ref.current!.getMap()).toBe(map);
    expect(ref.current!.getViewport()).toEqual({
      center: [120.0, 29.2],
      zoom: 7,
      bounds: [118, 27, 122.5, 31.5]
    });
  });

  it("setBasemap：setLayoutProperty 显隐切换 + onBasemapResolved 回调；legacy id 归一", async () => {
    vi.mocked(mapDataStyleText).mockResolvedValue(TEXT_A);
    const resolved: string[] = [];
    const ref = await mountViewer({ project: "zhejiang-map", onBasemapResolved: (id: string) => resolved.push(id) });
    const map = mapAt(0);
    await emitLoad(map);
    // markReady 初始同步：basemap-gaode-road visible（缺省）
    ref.current!.setBasemap("gaode-sat");
    const props = Object.fromEntries(map.layoutProps.map(([id, k, v]) => [id, [k, v]]));
    expect(props["basemap-gaode-sat"]).toEqual(["visibility", "visible"]);
    expect(props["basemap-gaode-road"]).toEqual(["visibility", "none"]);
    expect(resolved.at(-1)).toBe("gaode-sat");
    // legacy id：carto → gaode-road
    ref.current!.setBasemap("carto");
    expect(resolved.at(-1)).toBe("gaode-road");
  });

  it("setProjection 结构化透传；setCoverageMode 无下钻时对 road 图层 setFilter null", async () => {
    vi.mocked(mapDataStyleText).mockResolvedValue(TEXT_A);
    const ref = await mountViewer({ project: "zhejiang-map" });
    const map = mapAt(0);
    await emitLoad(map);
    expect(ref.current!.setProjection("globe")).toBe(true);
    expect((map as unknown as { projectionCalls: unknown[] }).projectionCalls).toEqual([{ type: "globe" }]);
    ref.current!.setCoverageMode("city");
    // roadLayerIdsRef：roads（line）+ roads-label（symbol -label）；basemap/boundary 排除
    expect(map.filters).toEqual([["roads", null], ["roads-label", null]]);
  });

  it("showAnalysis → clearAnalysis：addSource/addLayer 家族与反操作", async () => {
    vi.mocked(mapDataStyleText).mockResolvedValue(TEXT_A);
    const ref = await mountViewer({ project: "zhejiang-map" });
    const map = mapAt(0);
    await emitLoad(map);
    const shown = ref.current!.showAnalysis({ id: "t1", type: "heatmap", geojson: ANALYSIS_FC });
    expect(shown).toBe(true);
    expect(map.sources.has("t1-source")).toBe(true);
    expect(map.sources.get("t1-source")?.data).toEqual(ANALYSIS_FC);
    for (const id of ["t1-heat", "t1-circles", "t1-labels"]) expect(map.layers.has(id)).toBe(true);
    ref.current!.clearAnalysis("t1");
    for (const id of ["t1-heat", "t1-circles", "t1-labels"]) expect(map.layers.has(id)).toBe(false);
    expect(map.sources.has("t1-source")).toBe(false);
    // showAnalysis 前置守卫：缺 geojson → false
    expect(ref.current!.showAnalysis({ id: "t2" })).toBe(false);
  });

  it("startDraw/stopDraw：draw 家族图层 + click 数据流 + Esc 取消清理", async () => {
    vi.mocked(mapDataStyleText).mockResolvedValue(TEXT_A);
    const ref = await mountViewer({ project: "zhejiang-map" });
    const map = mapAt(0);
    await emitLoad(map);
    const updates: number[][][] = [];
    const done: Array<{ kind: string }> = [];
    ref.current!.startDraw("measure-line", { onUpdate: (pts) => updates.push(pts), onDone: (_p, meta) => done.push(meta) });
    // startDraw 只注册事件（首帧 draw 家族在首次 click 的 ensureSource/render 内创建）
    expect(map.handlers.has("click")).toBe(true);
    // 首次 click：创建 draw-layer source + draw-line/draw-dots 图层（measure-line 不落 fill 分支）+ 采点
    await act(async () => { map.emit("click", { lngLat: { lng: 120.1, lat: 29.3 } }); });
    expect(map.sources.has("draw-layer")).toBe(true);
    expect(map.layers.has("draw-line")).toBe(true);
    expect(map.layers.has("draw-dots")).toBe(true);
    expect(map.layers.has("draw-fill")).toBe(false);
    expect(updates).toEqual([[[120.1, 29.3]]]);
    expect(done).toEqual([]);
    // stopDraw：事件解绑 + draw 家族清理
    ref.current!.stopDraw();
    expect(map.layers.has("draw-line")).toBe(false);
    expect(map.layers.has("draw-dots")).toBe(false);
    expect(map.sources.has("draw-layer")).toBe(false);
    await act(async () => { map.emit("click", { lngLat: { lng: 121, lat: 30 } }); });
    expect(updates).toHaveLength(1); // 解绑后不再推进
    // Esc 取消路径：keydown Escape 清理（draw 家族在首 click 后存在）
    ref.current!.startDraw("measure-polygon", {});
    await act(async () => { map.emit("click", { lngLat: { lng: 120.2, lat: 29.4 } }); });
    expect(map.layers.has("draw-fill")).toBe(true);
    await act(async () => { map.emit("keydown", { key: "Escape" }); });
    expect(map.layers.has("draw-fill")).toBe(false);
    expect(map.sources.has("draw-layer")).toBe(false);
  });
});
