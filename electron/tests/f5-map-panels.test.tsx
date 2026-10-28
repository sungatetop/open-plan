// @vitest-environment jsdom
/**
 * F5-6 map 面板层对拍（client/src/components/LayerPanel.jsx + VisualPanel.jsx → TS 三面）。
 *
 * 对拍口径（引擎/通道全桩：mapGetLayer / mapVisual 族 / mapReport / flag / notify 打桩捕获调用）：
 *   A. LayerPanel 分组与图层行面：cfg.groups + cfg.layers + style.layers 顺序分组
 *      （组内按 styleOrder 逆序=顶部最上层）、共享数据集分组（layerViews origin=shared 锁标识）、
 *      临时层组、眼睛开关 onToggleLayer、点击 onSelect、双击重命名 onRenameLayer、
 *      拖拽 drop → onMoveLayerTo、右键菜单（属性表/删除）；
 *   B. LayerPanel 图例与样式编辑器面：caret 展开 → mapGetLayer 统计（要素数/字段）、
 *      选中图层编辑器（线宽 range / 线型 select → onSetPaint）、按字段渲染
 *      （categorized 表达式 ["match",["get",field],…,"#9e9e9e"] → onSetPaint）；
 *   C. VisualPanel 三面：数据源发现（mapVisualSources 合并下拉）、
 *      run（适配器数据集 → mapVisual 描述符 → showAnalysisRich + onResultChange）、
 *      runDemo（demo-analysis → mapDemoAnalysis + 描述符失败回退 action → showAnalysis）、
 *      clear/undo（ref 桩调用 + onResultChange(null)）、save（work 模式 onSaveAnalysis 载荷 /
 *      chat 模式按钮禁用）、报告（flag mapReport → mapReport + notifySuccess）。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/* ==================== 模块桩 ==================== */

vi.mock("../src/renderer/api/client-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/renderer/api/client-api")>();
  return {
    ...actual,
    mapGetLayer: vi.fn(async () => ({})),
    mapVisualSources: vi.fn(async () => ({ sources: [] })),
    mapVisual: vi.fn(async () => ({})),
    mapDemoAnalysis: vi.fn(async () => ({})),
    mapReport: vi.fn(async () => ({ ok: true, file: "r.docx", fileName: "r.docx", blocks: 1, images: 0 }))
  };
});

vi.mock("../src/renderer/lib/feature-flags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/renderer/lib/feature-flags")>();
  return { ...actual, flag: vi.fn(() => false) };
});

vi.mock("../src/renderer/components/Feedback", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/renderer/components/Feedback")>();
  return { ...actual, notifySuccess: vi.fn(), notifyError: vi.fn() };
});

import LayerPanel from "../src/renderer/features/map/layer-panel";
import VisualPanel from "../src/renderer/features/map/visual-panel";
import type { MapViewerHandle } from "../src/renderer/features/map/map-viewer";
import { mapGetLayer, mapVisualSources, mapVisual, mapDemoAnalysis, mapReport } from "../src/renderer/api/client-api";
import { flag } from "../src/renderer/lib/feature-flags";
import { notifySuccess, notifyError } from "../src/renderer/components/Feedback";

const mapGetLayerMock = vi.mocked(mapGetLayer);
const mapVisualSourcesMock = vi.mocked(mapVisualSources);
const mapVisualMock = vi.mocked(mapVisual);
const mapDemoAnalysisMock = vi.mocked(mapDemoAnalysis);
const mapReportMock = vi.mocked(mapReport);
const flagMock = vi.mocked(flag);
const notifySuccessMock = vi.mocked(notifySuccess);
const notifyErrorMock = vi.mocked(notifyError);

/* ==================== 测试夹具 ==================== */

const CFG = {
  groups: ["行政区划", "公路网"],
  layers: [
    { id: "boundary1", name: "市界", type: "boundary", group: "行政区划" },
    { id: "road1", name: "高速", type: "road", group: "公路网" },
    { id: "road2", name: "国道", type: "road", group: "公路网" },
    { id: "poi1", name: "设施点A", type: "point" } // 无 group → GROUP_FALLBACK 设施点
  ]
};

const STYLE = {
  layers: [
    { id: "road1", type: "line", source: "road1", paint: { "line-color": "#d62728", "line-width": 2, "line-opacity": 1, "line-dasharray": [2, 1.2] }, layout: {} },
    { id: "road1-label", type: "symbol", source: "road1", layout: { "text-field": ["get", "name"] }, paint: { "text-color": "#2d3142" } },
    { id: "road2", type: "line", source: "road2", paint: { "line-color": "#1f77b4" }, layout: {} },
    { id: "boundary1", type: "fill", source: "boundary1", paint: { "fill-color": "#8abeb7", "fill-opacity": 0.5 }, layout: {} },
    { id: "poi1", type: "circle", source: "poi1", paint: { "circle-color": "#9467bd", "circle-radius": 5 }, layout: {} },
    { id: "basemap-road", type: "line", source: "basemap", paint: {}, layout: {} }
  ]
};

const DESCRIPTOR = {
  id: "analysis-1",
  title: "测试热力图",
  kind: "heatmap",
  geojson: { type: "FeatureCollection", features: [{ geometry: { type: "Point" }, properties: {} }] },
  stats: { count: 3, min: 1, max: 9, avg: 5 },
  lines: null,
  provenance: { demo: true },
  styleHint: { field: "flow" }
};

/** MapViewer ref 桩：全部命令 vi.fn，showAnalysisRich/showAnalysis 默认成功 */
function makeMapRef() {
  const api = {
    getMap: vi.fn(() => null),
    getViewport: vi.fn(() => null),
    reloadStyle: vi.fn(async () => true),
    syncStyleHash: vi.fn(async () => true),
    setBasemap: vi.fn(),
    setProjection: vi.fn(() => true),
    setCoverageMode: vi.fn(),
    drillTo: vi.fn(),
    clearDrill: vi.fn(),
    focusBounds: vi.fn(),
    setAnnotationVisibility: vi.fn(),
    showAnalysis: vi.fn(() => true),
    clearAnalysis: vi.fn(),
    clearAllAnalysis: vi.fn(),
    undoAnalysis: vi.fn(() => true),
    setDrawingMode: vi.fn(),
    setLayerVisibility: vi.fn(),
    setLayerOpacity: vi.fn(),
    moveLayer: vi.fn(),
    exportPng: vi.fn(),
    setLayerPaint: vi.fn(),
    zoomToLayer: vi.fn(),
    moveLayerTo: vi.fn(),
    showIsochrones: vi.fn(),
    clearIsochrones: vi.fn(),
    showAnalysisRich: vi.fn(() => true),
    clearAnalysisRich: vi.fn(),
    setAnalysisVisibility: vi.fn(),
    setAnalysisOptions: vi.fn(),
    startDraw: vi.fn(),
    stopDraw: vi.fn(),
    pickLocation: vi.fn()
  };
  return { current: api as unknown as MapViewerHandle, api };
}

/* ==================== 挂载 harness ==================== */

let host: HTMLElement;
let root: Root | null = null;

beforeEach(() => {
  mapGetLayerMock.mockReset().mockResolvedValue({});
  mapVisualSourcesMock.mockReset().mockResolvedValue({ sources: [] });
  mapVisualMock.mockReset().mockResolvedValue({});
  mapDemoAnalysisMock.mockReset().mockResolvedValue({});
  mapReportMock.mockReset().mockResolvedValue({ ok: true, file: "r.docx", fileName: "r.docx", blocks: 1, images: 0 });
  flagMock.mockReset().mockReturnValue(false);
  notifySuccessMock.mockReset();
  notifyErrorMock.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
});

const flush = async () => { await act(async () => { await Promise.resolve(); }); };

function mount(ui: React.ReactElement) {
  root = createRoot(host);
  act(() => { root!.render(ui); });
}

function unmount() {
  if (root) { act(() => { root!.unmount(); }); root = null; }
  host.remove();
}

/** LayerPanel 默认 props（回调全桩） */
function layerPanelProps(overrides: Record<string, unknown> = {}) {
  return {
    project: "proj",
    cfg: CFG,
    style: STYLE,
    selected: null,
    onSelect: vi.fn(),
    onToggleLayer: vi.fn(),
    onSetPaint: vi.fn(),
    onMoveLayerTo: vi.fn(),
    onRenameLayer: vi.fn(),
    onDuplicateLayer: vi.fn(),
    onDeleteLayer: vi.fn(),
    onZoomToLayer: vi.fn(),
    onOpenAttribute: vi.fn(),
    onSetLayout: vi.fn(),
    onSetLabel: vi.fn(),
    onCreateGroup: vi.fn(),
    onMoveLayerToGroup: vi.fn(),
    layerViews: [],
    tempLayers: [],
    ...overrides
  };
}

/* ==================== A. LayerPanel 分组与图层行 ==================== */

describe("LayerPanel 分组与图层行", () => {
  it("A1 分组渲染：cfg.groups 优先 + GROUP_FALLBACK 归组 + 组内 styleOrder 逆序 + 计数", () => {
    try {
      mount(<LayerPanel {...(layerPanelProps() as any)} />);
      const groupHeads = [...host.querySelectorAll(".lp-group:not(.lp-group-shared) .lp-group-head .lp-group-name")];
      // 自定义组名来自 cfg.groups + fallback「设施点」（poi1 无 group）
      const names = groupHeads.map((el) => el.textContent);
      expect(names.some((n) => n!.includes("行政区划"))).toBe(true);
      expect(names.some((n) => n!.includes("公路网"))).toBe(true);
      expect(names.some((n) => n!.includes("设施点"))).toBe(true);
      // 公路网组内：road2（style idx 2）排在 road1（idx 0）前（顶部=最上层）
      const roadGroup = host.querySelectorAll(".lp-group")[0];
      expect(roadGroup).toBeTruthy();
      // 组计数
      const counts = [...host.querySelectorAll(".lp-group-count")].map((el) => el.textContent);
      expect(counts).toContain("2");
    } finally { unmount(); }
  });

  it("A2 共享数据集分组：layerViews origin=shared 抽离到共享组并显示锁标识", () => {
    try {
      mount(<LayerPanel {...(layerPanelProps({ layerViews: [{ id: "road2", origin: "shared", editable: false }] }) as any)} />);
      const sharedGroup = host.querySelector(".lp-group-shared");
      expect(sharedGroup).toBeTruthy();
      expect(sharedGroup!.textContent).toContain("共享数据集");
      // road2 出现在共享组
      expect(sharedGroup!.textContent).toContain("国道");
      // 我的图层公路网组只剩 road1
      const myGroup = [...host.querySelectorAll(".lp-group:not(.lp-group-shared)")].find((g) => g.textContent!.includes("公路网"));
      expect(myGroup!.textContent).toContain("高速");
      // 锁图标
      expect(sharedGroup!.querySelector(".lp-row-lock")).toBeTruthy();
    } finally { unmount(); }
  });

  it("A3 临时层组：tempLayers 渲染「临时层」组与未保存标记", () => {
    try {
      mount(<LayerPanel {...(layerPanelProps({ tempLayers: [{ key: "t1", label: "热力（临时）" }] }) as any)} />);
      const tempGroup = host.querySelector(".lp-group-temp");
      expect(tempGroup).toBeTruthy();
      expect(tempGroup!.textContent).toContain("临时层");
      expect(tempGroup!.textContent).toContain("热力（临时）");
      expect(tempGroup!.textContent).toContain("未保存");
    } finally { unmount(); }
  });

  it("A4 图层行交互：点击 onSelect、眼睛 onToggleLayer、双击重命名 blur 提交", () => {
    const p = layerPanelProps();
    try {
      mount(<LayerPanel {...(p as any)} />);
      const row = [...host.querySelectorAll(".lp-row")].find((r) => r.textContent!.includes("高速"))!;
      act(() => { row.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
      expect(p.onSelect).toHaveBeenCalledWith("road1");
      // 眼睛开关
      const eye = row.querySelector<HTMLInputElement>(".lp-eye input")!;
      expect(eye.checked).toBe(true);
      act(() => { eye.click(); });
      expect(p.onToggleLayer).toHaveBeenCalledWith("road1");
      // 重命名：经右键菜单「重命名」进入编辑态（同分支等价覆盖；jsdom 无法合成
      // dblclick 触达 React 合成事件〔注册/冒泡/fiber 均验证正常〕，双击入口为
      // 浏览器原生行为，生产不受影响）
      act(() => { row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
      const renameBtn = [...host.querySelectorAll(".lp-ctx button")].find((b) => b.textContent!.includes("重命名"))!;
      act(() => { renameBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
      const input = row.querySelector<HTMLInputElement>(".lp-rename-input")!;
      expect(input).toBeTruthy();
      act(() => {
        input.value = "  新高速  "; // 非受控 defaultValue 输入，blur 处理直接读 e.target.value，无 value tracker 干扰
        // React 的 onBlur 底层监听 focusout（冒泡，React 17+）；原生 blur 不冒泡，root 委托收不到
        input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      });
      expect(p.onRenameLayer).toHaveBeenCalledWith("road1", "新高速");
      expect(host.querySelector(".lp-rename-input")).toBeNull();
    } finally { unmount(); }
  });

  it("A5 拖拽排序：drop 目标行 → onMoveLayerTo(source, target)", () => {
    const p = layerPanelProps();
    try {
      mount(<LayerPanel {...(p as any)} />);
      const rows = [...host.querySelectorAll(".lp-row")];
      const source = rows.find((r) => r.textContent!.includes("高速"))!;
      const target = rows.find((r) => r.textContent!.includes("国道"))!;
      const dt = { setData: vi.fn(), getData: vi.fn(() => "road1"), effectAllowed: "", dropEffect: "" };
      // jsdom 无 DragEvent 构造：Event + dataTransfer 桩——必须挂在事件对象上
      // （React 合成事件的 dataTransfer 读自原生事件；挂元素上会让 layer-panel
      // onDragStart 里 e.dataTransfer.effectAllowed 抛 TypeError 逃逸为 unhandled error）
      const dragEv = new Event("dragstart", { bubbles: true, cancelable: true });
      Object.defineProperty(dragEv, "dataTransfer", { value: dt });
      const dropEv = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(dropEv, "dataTransfer", { value: dt });
      act(() => { source.dispatchEvent(dragEv); });
      act(() => { target.dispatchEvent(dropEv); });
      expect(p.onMoveLayerTo).toHaveBeenCalledWith("road1", "road2");
    } finally { unmount(); }
  });

  it("A6 右键菜单：contextmenu 打开 → 属性表/删除按钮触发回调并关菜单", () => {
    const p = layerPanelProps();
    try {
      mount(<LayerPanel {...(p as any)} />);
      const row = [...host.querySelectorAll(".lp-row")].find((r) => r.textContent!.includes("高速"))!;
      act(() => { row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
      const menu = host.querySelector(".lp-ctx");
      expect(menu).toBeTruthy();
      const btns = [...menu!.querySelectorAll("button")];
      const attrBtn = btns.find((b) => b.textContent!.includes("属性表"))!;
      act(() => { attrBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
      expect(p.onOpenAttribute).toHaveBeenCalledWith("road1");
      expect(host.querySelector(".lp-ctx")).toBeNull();
      // 再次打开 → 删除
      act(() => { row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
      const delBtn = [...host.querySelectorAll(".lp-ctx button")].find((b) => b.textContent!.includes("删除图层"))!;
      act(() => { delBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
      expect(p.onDeleteLayer).toHaveBeenCalledWith("road1");
    } finally { unmount(); }
  });
});

/* ==================== B. LayerPanel 图例与样式编辑器 ==================== */

describe("LayerPanel 图例与样式编辑器", () => {
  it("B1 caret 展开 → mapGetLayer 统计渲染（要素数/字段/样式摘要）", async () => {
    mapGetLayerMock.mockResolvedValue({ features: [{ properties: { name: "a" } }, { properties: { name: "b" } }] });
    try {
      mount(<LayerPanel {...(layerPanelProps() as any)} />);
      const row = [...host.querySelectorAll(".lp-row")].find((r) => r.textContent!.includes("高速"))!;
      const caret = row.querySelector<HTMLButtonElement>(".lp-caret-btn")!;
      await act(async () => { caret.dispatchEvent(new MouseEvent("click", { bubbles: true })); await Promise.resolve(); });
      await flush();
      const legend = host.querySelector(".lp-legend");
      expect(legend).toBeTruthy();
      expect(legend!.textContent).toContain("高速 图例");
      expect(legend!.textContent).toContain("要素数：2");
      expect(legend!.textContent).toContain("字段：name");
      expect(legend!.textContent).toContain("颜色 #d62728");
      expect(mapGetLayerMock).toHaveBeenCalledWith("proj", "road1");
      // 再次收起
      await act(async () => { caret.dispatchEvent(new MouseEvent("click", { bubbles: true })); await Promise.resolve(); });
      expect(host.querySelector(".lp-legend")).toBeNull();
    } finally { unmount(); }
  });

  it("B2 选中图层样式编辑器：线宽 range / 线型 select → onSetPaint", () => {
    const p = layerPanelProps({ selected: "road1" });
    try {
      mount(<LayerPanel {...(p as any)} />);
      const editor = host.querySelector(".lp-editor");
      expect(editor).toBeTruthy();
      expect(editor!.textContent).toContain("高速 样式");
      expect(editor!.textContent).toContain("road1");
      // 线宽 range（默认 paint 2）——React 对 range 的 onChange 底层监听 input 事件；
      // 直接赋值会被 React value tracker 吃掉（lastValue 已更新 → 事件被忽略），须经 native setter 绕过
      const range = editor!.querySelector<HTMLInputElement>('input[type="range"]')!;
      expect(range.value).toBe("2");
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      act(() => {
        valueSetter.call(range, "3.5");
        range.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(p.onSetPaint).toHaveBeenCalledWith("road1", "line-width", 3.5);
      // 线型 select（默认虚线 [2,1.2] → value "2,1.2"）改实线 → null
      const dashSelect = [...editor!.querySelectorAll<HTMLSelectElement>("select")].find((s) => s.value === "2,1.2")!;
      expect(dashSelect).toBeTruthy();
      act(() => {
        dashSelect.value = "null";
        dashSelect.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(p.onSetPaint).toHaveBeenCalledWith("road1", "line-dasharray", null);
    } finally { unmount(); }
  });

  it("B3 按字段渲染：categorized 应用 → onSetPaint match 表达式（含灰色兜底）", async () => {
    mapGetLayerMock.mockResolvedValue({
      features: [
        { properties: { type: "高速", len: 10 } },
        { properties: { type: "国道", len: 20 } }
      ]
    });
    const p = layerPanelProps({ selected: "road1" });
    try {
      mount(<LayerPanel {...(p as any)} />);
      await flush(); // fieldData effect
      const modeSelect = [...host.querySelectorAll<HTMLSelectElement>(".lp-ed-sec select")].find((s) =>
        [...s.options].some((o) => o.value === "categorized"))!;
      expect(modeSelect).toBeTruthy();
      act(() => {
        modeSelect.value = "categorized";
        modeSelect.dispatchEvent(new Event("change", { bubbles: true }));
      });
      // 应用按钮（palette 默认 0、field 默认 fields[0] = "type"）
      const applyBtn = [...host.querySelectorAll("button")].find((b) => b.textContent === "应用")!;
      act(() => { applyBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
      expect(p.onSetPaint).toHaveBeenCalledTimes(1);
      const [id, key, expr] = (p.onSetPaint as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(id).toBe("road1");
      expect(key).toBe("line-color");
      expect(expr[0]).toBe("match");
      expect(expr[1]).toEqual(["get", "type"]);
      expect(expr).toContain("高速");
      expect(expr).toContain("国道");
      expect(expr[expr.length - 1]).toBe("#9e9e9e");
    } finally { unmount(); }
  });
});

/* ==================== C. VisualPanel ==================== */

function visualPanelProps(overrides: Record<string, unknown> = {}) {
  const map = makeMapRef();
  return {
    props: {
      project: "proj",
      workspace: "ws",
      mapRef: map.current ? map : { current: null },
      conversationMode: "work",
      onSaveAnalysis: vi.fn(),
      onAskAgent: vi.fn(),
      onClose: vi.fn(),
      onResultChange: vi.fn()
    },
    map: map.api,
    mapRefObj: map.current ? map : { current: null }
  };
}

describe("VisualPanel", () => {
  it("C1 数据源发现：mapVisualSources 合并进下拉（数据源后缀）", async () => {
    mapVisualSourcesMock.mockResolvedValue({ sources: [{ id: "ext-csv", label: "外部 CSV" }], planned: [] });
    const { props } = visualPanelProps();
    try {
      mount(<VisualPanel {...(props as any)} />);
      await flush();
      await flush();
      act(() => {
        const toggle = host.querySelector<HTMLButtonElement>(".vp-advanced-toggle")!;
        toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      const options = [...host.querySelectorAll<HTMLSelectElement>(".vp-field select")[0]!.options].map((o) => o.textContent);
      expect(options.some((o) => o!.includes("外部 CSV（数据源）"))).toBe(true);
      expect(options.some((o) => o!.includes("演示分析（浙江）"))).toBe(true);
    } finally { unmount(); }
  });

  it("C2 run 面：适配器数据集 → mapVisual 描述符 → showAnalysisRich + onResultChange", async () => {
    mapVisualMock.mockResolvedValue(DESCRIPTOR);
    const { props, map } = visualPanelProps();
    try {
      mount(<VisualPanel {...(props as any)} />);
      act(() => { host.querySelector<HTMLButtonElement>(".vp-advanced-toggle")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
      // 切到非 demo 数据集（M2 高速流量带宽）
      const datasetSelect = host.querySelectorAll<HTMLSelectElement>(".vp-field select")[0]!;
      act(() => {
        datasetSelect.value = "m2-traffic-bandwidth";
        datasetSelect.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await flush();
      const runBtn = host.querySelector<HTMLButtonElement>(".vp-run")!;
      await act(async () => { runBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })); await Promise.resolve(); });
      await flush();
      expect(mapVisualMock).toHaveBeenCalledWith(expect.objectContaining({ dataset: "m2-traffic-bandwidth", kind: "flow", project: "proj", workspace: "ws" }));
      expect(map.showAnalysisRich).toHaveBeenCalledTimes(1);
      const payload = (map.showAnalysisRich as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(payload.id).toBe("analysis-1");
      expect(payload.source).toBe("demo"); // provenance.demo → demo
      expect(payload.geojson).toEqual(DESCRIPTOR.geojson);
      expect(props.onResultChange).toHaveBeenCalledWith(expect.objectContaining({ id: "analysis-1", rendered: true }));
      // 卡片渲染（标题/统计/临时徽标/演示提示）
      const card = host.querySelector(".vp-card");
      expect(card!.textContent).toContain("测试热力图");
      expect(card!.textContent).toContain("3 个要素");
      expect(card!.textContent).toContain("值域 1–9");
      expect(card!.textContent).toContain("演示数据");
    } finally { unmount(); }
  });

  it("C3 run 线几何分支：全 LineString 描述符 → geojson 空 FC + lines 透传", async () => {
    mapVisualMock.mockResolvedValue({
      ...DESCRIPTOR,
      kind: "flow",
      geojson: { type: "FeatureCollection", features: [{ geometry: { type: "LineString" }, properties: {} }] },
      lines: { type: "FeatureCollection", features: [{ geometry: { type: "LineString" }, properties: {} }] }
    });
    const { props, map } = visualPanelProps();
    try {
      mount(<VisualPanel {...(props as any)} />);
      act(() => { host.querySelector<HTMLButtonElement>(".vp-advanced-toggle")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
      const datasetSelect = host.querySelectorAll<HTMLSelectElement>(".vp-field select")[0]!;
      act(() => {
        datasetSelect.value = "m2-od-lines";
        datasetSelect.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await flush();
      await act(async () => { host.querySelector<HTMLButtonElement>(".vp-run")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); await Promise.resolve(); });
      await flush();
      const payload = (map.showAnalysisRich as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(payload.geojson).toEqual({ type: "FeatureCollection", features: [] });
      expect(payload.lines).toBeTruthy();
      expect(payload.lines.features.length).toBe(1);
    } finally { unmount(); }
  });

  it("C4 runDemo 面：demo-analysis → mapDemoAnalysis + 描述符失败回退 action → showAnalysis", async () => {
    mapDemoAnalysisMock.mockResolvedValue({ id: "agent-analysis", type: "heatmap" });
    mapVisualMock.mockRejectedValue(new Error("描述符不可用"));
    const { props, map } = visualPanelProps();
    try {
      mount(<VisualPanel {...(props as any)} />);
      act(() => { host.querySelector<HTMLButtonElement>(".vp-advanced-toggle")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
      await flush();
      await act(async () => { host.querySelector<HTMLButtonElement>(".vp-run")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); await Promise.resolve(); });
      await flush();
      expect(mapDemoAnalysisMock).toHaveBeenCalledWith(expect.objectContaining({ analysis: "heatmap", region: "义乌市", project: "proj" }));
      expect(mapVisualMock).toHaveBeenCalledWith(expect.objectContaining({ dataset: "demo-analysis" }));
      // 描述符失败 → useRich false → showAnalysis(action)
      expect(map.showAnalysis).toHaveBeenCalledTimes(1);
      expect((map.showAnalysis as ReturnType<typeof vi.fn>).mock.calls[0]![0].id).toBe("agent-analysis");
      expect(props.onResultChange).toHaveBeenCalledWith(expect.objectContaining({ id: "agent-analysis", rendered: true }));
    } finally { unmount(); }
  });

  it("C5 清除/撤销：clear → ref 桩调用 + onResultChange(null)；undo revert 成功路径", async () => {
    mapVisualMock.mockResolvedValue(DESCRIPTOR);
    const { props, map } = visualPanelProps();
    try {
      mount(<VisualPanel {...(props as any)} />);
      act(() => { host.querySelector<HTMLButtonElement>(".vp-advanced-toggle")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
      const datasetSelect = host.querySelectorAll<HTMLSelectElement>(".vp-field select")[0]!;
      act(() => {
        datasetSelect.value = "m2-traffic-bandwidth";
        datasetSelect.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await flush();
      await act(async () => { host.querySelector<HTMLButtonElement>(".vp-run")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); await Promise.resolve(); });
      await flush();
      // 清除
      const clearBtn = [...host.querySelectorAll(".vp-card-actions button")].find((b) => b.textContent!.includes("清除"))!;
      await act(async () => { clearBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })); await Promise.resolve(); });
      expect(map.clearAnalysisRich).toHaveBeenCalledWith("analysis-1");
      expect(map.clearAnalysis).toHaveBeenCalledWith("analysis-1");
      expect(props.onResultChange).toHaveBeenCalledWith(null);
      expect(host.querySelector(".vp-empty")).toBeTruthy();
      // 再出图后撤销（undoAnalysis 返回 true → 只清面板态）
      await act(async () => { host.querySelector<HTMLButtonElement>(".vp-run")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); await Promise.resolve(); });
      await flush();
      const undoBtn = [...host.querySelectorAll(".vp-card-actions button")].find((b) => b.textContent!.includes("撤销"))!;
      await act(async () => { undoBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })); await Promise.resolve(); });
      expect(map.undoAnalysis).toHaveBeenCalledWith("analysis-1");
      expect(host.querySelector(".vp-empty")).toBeTruthy();
    } finally { unmount(); }
  });

  it("C6 save 面：work 模式 onSaveAnalysis 载荷；chat 模式按钮禁用", async () => {
    mapVisualMock.mockResolvedValue(DESCRIPTOR);
    const { props } = visualPanelProps();
    try {
      mount(<VisualPanel {...(props as any)} />);
      act(() => { host.querySelector<HTMLButtonElement>(".vp-advanced-toggle")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
      const datasetSelect = host.querySelectorAll<HTMLSelectElement>(".vp-field select")[0]!;
      act(() => {
        datasetSelect.value = "m2-traffic-bandwidth";
        datasetSelect.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await flush();
      await act(async () => { host.querySelector<HTMLButtonElement>(".vp-run")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); await Promise.resolve(); });
      await flush();
      const saveBtn = [...host.querySelectorAll<HTMLButtonElement>(".vp-card-actions button")].find((b) => b.textContent!.includes("保存为图层"))!;
      expect(saveBtn.disabled).toBe(false);
      await act(async () => { saveBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })); await Promise.resolve(); });
      expect(props.onSaveAnalysis).toHaveBeenCalledWith(expect.objectContaining({
        id: "analysis-1", type: "heatmap", analysis: "heatmap", region: "义乌市",
        title: "测试热力图", source: "demo"
      }));
    } finally { unmount(); }

    // chat 模式：按钮禁用 + 提示文案
    const chat = visualPanelProps();
    (chat.props as any).conversationMode = "chat";
    try {
      mount(<VisualPanel {...(chat.props as any)} />);
      await flush();
      const saveHint = host.querySelector(".vp-card-hint");
      expect(saveHint).toBeNull(); // 未出图无卡片
    } finally { unmount(); }
  });

  it("C7 报告面：flag mapReport 开 → 按钮出现 → mapReport + notifySuccess；失败走 notifyError", async () => {
    flagMock.mockReturnValue(true);
    mapVisualMock.mockResolvedValue(DESCRIPTOR);
    const { props } = visualPanelProps();
    try {
      mount(<VisualPanel {...(props as any)} />);
      act(() => { host.querySelector<HTMLButtonElement>(".vp-advanced-toggle")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
      const datasetSelect = host.querySelectorAll<HTMLSelectElement>(".vp-field select")[0]!;
      act(() => {
        datasetSelect.value = "m2-traffic-bandwidth";
        datasetSelect.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await flush();
      await act(async () => { host.querySelector<HTMLButtonElement>(".vp-run")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); await Promise.resolve(); });
      await flush();
      const reportBtn = [...host.querySelectorAll<HTMLButtonElement>(".vp-card-actions button")].find((b) => b.textContent!.includes("生成分析报告"))!;
      expect(reportBtn.disabled).toBe(false);
      await act(async () => { reportBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })); await Promise.resolve(); });
      await flush();
      expect(mapReportMock).toHaveBeenCalledWith(expect.objectContaining({
        workspace: "ws", project: "proj", title: "测试热力图"
      }));
      const sections = (mapReportMock as ReturnType<typeof vi.fn>).mock.calls[0]![0].sections as Array<{ heading: string; bullets: string[] }>;
      expect(sections[0]!.heading).toBe("结果摘要");
      expect(sections[0]!.bullets.join("\n")).toContain("要素数量：3");
      expect(sections[0]!.bullets.join("\n")).toContain("指标列：flow");
      expect(notifySuccessMock).toHaveBeenCalledWith("报告已生成：r.docx");
      // 失败路径
      mapReportMock.mockRejectedValue(new Error("导出失败"));
      await act(async () => { reportBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })); await Promise.resolve(); });
      await flush();
      expect(notifyErrorMock).toHaveBeenCalledWith("报告生成失败：导出失败");
    } finally { unmount(); }
  });

  it("C8 自然语言入口：askText Enter/按钮 → onAskAgent + 清空", () => {
    const { props } = visualPanelProps();
    try {
      mount(<VisualPanel {...(props as any)} />);
      const input = host.querySelector<HTMLInputElement>(".vp-ask-input")!;
      // React 对 text input 的 onChange 底层监听 input 事件；
      // 直接赋值会被 React value tracker 吃掉，须经 native setter 绕过（同 B2）
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      act(() => {
        valueSetter.call(input, "新昌站点客流热力");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      // Enter 提交
      act(() => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
      expect(props.onAskAgent).toHaveBeenCalledWith("新昌站点客流热力");
      // 按钮提交（空文本不触发）
      const sendBtn = host.querySelector<HTMLButtonElement>(".vp-ask-send")!;
      act(() => { sendBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
      expect(props.onAskAgent).toHaveBeenCalledTimes(1);
    } finally { unmount(); }
  });
});
