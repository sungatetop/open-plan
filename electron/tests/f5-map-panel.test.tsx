// @vitest-environment jsdom
/**
 * F5-7 map 组装层对拍（client/src/components/MapPanel.jsx 2543 行 → TS 组装面）。
 *
 * 对拍口径（子件全桩：MapViewer/ChatPanel/LayerPanel/VisualPanel/AttributeTable/TaskCenter
 * 以轻桩捕获 props；client-api map 函数族 / flag / askConfirm / shpjs 打桩捕获调用）：
 *   A. 加载链与 props 分发：mapProjects + mapProject(name, workspace) → cfg/style/files/
 *      layerViews/basemapMeta 分发到 LayerPanel，project/config 分发到 MapViewer，
 *      sessions/historyMessages 等透传内置 ChatPanel（hideChat=false 分支）；
 *   B. hideChat 分支形态：.mp-shared-chat class + 不渲染内置 ChatPanel + 视图菜单
 *      「隐藏 Agent 对话」→ onToggleChat；
 *   C. 桥接面：bridgeRef 四处理器 + window.__oawMapBridge 注册与卸载清理；
 *      onMapAction（showAnalysis 渲染链 + clear_analysis 分支）、onFileChanged
 *      （maps/<project>/ 前缀过滤命中刷新）、onAgentEnd（hideChat 双形态：延迟 reload
 *      不透传 / 非隐藏态透传）、onOpenFile（onExit + onOpenFile 转发）；
 *   D. onViewportChange：MapViewer 视口上报增补 regionName 后透传宿主；
 *   E. 等时圈：未选点守卫文案 + stub 地图 click 选点后 mapIsochrone 四元组载荷；
 *   F. 批量导出（flag mapExport）：勾选项目 → mapExportBatch 入队 → 1.2s 轮询
 *      mapExportStatus（running → done）进度与结果文案；
 *   G. 数据导入：GeoJSON 文件 → mapImportBatch 载荷 → 成功文案 + reloadStyle + zoomToLayer。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

vi.setConfig({ testTimeout: 30_000 });

/* ==================== 桩捕获容器（vi.hoisted 供工厂与用例共享） ==================== */

const stubs = vi.hoisted(() => {
  const box = <T,>(initial: T) => ({ current: initial });
  return {
    mapViewerProps: box<Record<string, unknown> | null>(null),
    mapViewerHandle: box<Record<string, unknown> | null>(null),
    mapClickHandler: box<((e: unknown) => void) | null>(null),
    chatProps: box<Record<string, unknown> | null>(null),
    layerPanelProps: box<Record<string, unknown> | null>(null),
    visualPanelProps: box<Record<string, unknown> | null>(null),
    attributeTableProps: box<Record<string, unknown> | null>(null),
  };
});

/* ==================== 模块桩 ==================== */

vi.mock("../src/renderer/api/client-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/renderer/api/client-api")>();
  const fn = () => vi.fn(async () => ({}));
  return {
    ...actual,
    mapProjects: fn(),
    mapCreateProject: fn(),
    mapProject: fn(),
    mapSaveStyle: fn(),
    mapSaveConfig: fn(),
    mapDeleteLayer: fn(),
    mapRebuild: fn(),
    mapGetLayer: fn(),
    mapImportLayer: fn(),
    mapImportBatch: fn(),
    mapPrepare: fn(),
    mapIsochrone: fn(),
    mapRoute: fn(),
    mapDemoAnalysis: fn(),
    mapDuplicateProject: fn(),
    mapRenameProject: fn(),
    mapArchiveProject: fn(),
    mapDeleteProject: fn(),
    mapExportBatch: fn(),
    mapExportStatus: fn()
  };
});

vi.mock("../src/renderer/lib/feature-flags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/renderer/lib/feature-flags")>();
  return { ...actual, flag: vi.fn(() => false) };
});

vi.mock("../src/renderer/components/Feedback", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/renderer/components/Feedback")>();
  return { ...actual, askConfirm: vi.fn(async () => true) };
});

vi.mock("shpjs", () => ({ default: vi.fn(async () => ({ type: "FeatureCollection", features: [] })) }));

// MapViewer 轻桩：forwardRef 暴露全套 handle（getMap 返回可编程 stub 地图），props 全捕获
vi.mock("../src/renderer/features/map/map-viewer", async () => {
  const React = await import("react");
  const mapStub = {
    once: (_event: unknown, handler: (e: unknown) => void) => { stubs.mapClickHandler.current = handler; },
    getStyle: () => ({ layers: [{ id: "road1" }] }),
    getLayer: vi.fn(() => false),
    removeLayer: vi.fn(),
    removeSource: vi.fn(),
    addSource: vi.fn(),
    addLayer: vi.fn(),
    fitBounds: vi.fn()
  };
  const handle: Record<string, unknown> = {
    getMap: vi.fn(() => mapStub),
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
  stubs.mapViewerHandle.current = handle;
  const MapViewerStub = React.forwardRef((props: Record<string, unknown>, ref: React.Ref<unknown>) => {
    stubs.mapViewerProps.current = props;
    React.useImperativeHandle(ref, () => handle as never, []);
    return React.createElement("div", { "data-testid": "map-viewer-stub", "data-project": String(props.project) });
  });
  return { default: MapViewerStub };
});

vi.mock("../src/renderer/features/chat/panel", async () => {
  const React = await import("react");
  return {
    default: (props: Record<string, unknown>) => {
      stubs.chatProps.current = props;
      return React.createElement("div", { "data-testid": "chat-panel-stub" });
    }
  };
});

vi.mock("../src/renderer/features/map/layer-panel", async () => {
  const React = await import("react");
  return {
    default: (props: Record<string, unknown>) => {
      stubs.layerPanelProps.current = props;
      const cfg = props.cfg as { groups?: string[] } | null;
      const files = (props.files as unknown[]) || [];
      const layerViews = (props.layerViews as unknown[]) || [];
      const tempLayers = (props.tempLayers as unknown[]) || [];
      return React.createElement(
        "div",
        { "data-testid": "layer-panel-stub" },
        JSON.stringify({ groups: cfg?.groups || [], files: files.length, layerViews: layerViews.length, tempLayers: tempLayers.length })
      );
    }
  };
});

vi.mock("../src/renderer/features/map/visual-panel", async () => {
  const React = await import("react");
  return {
    default: (props: Record<string, unknown>) => {
      stubs.visualPanelProps.current = props;
      return React.createElement("div", { "data-testid": "visual-panel-stub" });
    }
  };
});

vi.mock("../src/renderer/features/map/attribute-table", async () => {
  const React = await import("react");
  return {
    default: (props: Record<string, unknown>) => {
      stubs.attributeTableProps.current = props;
      return React.createElement("div", { "data-testid": "attribute-table-stub" });
    }
  };
});

vi.mock("../src/renderer/features/tasks/task-center", async () => {
  const React = await import("react");
  return { default: () => React.createElement("div", { "data-testid": "task-center-stub" }) };
});

import MapPanel from "../src/renderer/features/map/map-panel";
import {
  mapProjects, mapProject, mapGetLayer, mapImportBatch, mapIsochrone, mapExportBatch, mapExportStatus
} from "../src/renderer/api/client-api";
import { flag } from "../src/renderer/lib/feature-flags";

const mapProjectsMock = vi.mocked(mapProjects);
const mapProjectMock = vi.mocked(mapProject);
const mapGetLayerMock = vi.mocked(mapGetLayer);
const mapImportBatchMock = vi.mocked(mapImportBatch);
const mapIsochroneMock = vi.mocked(mapIsochrone);
const mapExportBatchMock = vi.mocked(mapExportBatch);
const mapExportStatusMock = vi.mocked(mapExportStatus);
const flagMock = vi.mocked(flag);

/* ==================== 测试夹具 ==================== */

const PROJECT_DETAIL = {
  config: {
    name: "浙江地图",
    groups: ["公路网"],
    layers: [{ id: "road1", name: "高速", type: "road", group: "公路网" }],
    center: [120.0, 29.2],
    zoom: 7
  },
  style: {
    layers: [
      { id: "road1", type: "line", source: "road1", paint: {}, layout: {} },
      { id: "basemap-road", type: "line", source: "basemap", paint: {}, layout: {} }
    ]
  },
  files: [{ name: "road1.geojson" }],
  layerViews: [{ id: "road1", origin: "workspace", editable: true }],
  basemapMeta: [{ id: "gaode-road", name: "路网" }]
};

const SESSIONS = [{ id: "s1", label: "会话一" }];

function mapPanelProps(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    clientId: "c1",
    threadId: "t1",
    workspace: "ws1",
    models: [],
    defaultModel: "m1",
    historyMessages: [{ role: "user", content: "hi" }],
    sessions: SESSIONS as never,
    currentSessionId: "s1",
    onExit: vi.fn(),
    onOpenFile: vi.fn(),
    onAgentEnd: vi.fn(),
    onProjectChange: vi.fn(),
    onViewportChange: vi.fn(),
    conversationMode: "chat",
    onModeChange: vi.fn(),
    insertChatText: vi.fn(),
    bridgeRef: { current: null },
    ...overrides
  };
}

/* ==================== 挂载 harness ==================== */

let host: HTMLElement;
let root: Root | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  mapProjectsMock.mockResolvedValue({ projects: [{ project: "zhejiang-map", name: "浙江地图" }, { project: "p1", name: "项目一" }] } as never);
  mapProjectMock.mockResolvedValue(PROJECT_DETAIL as never);
  mapGetLayerMock.mockResolvedValue({ features: [] } as never);
  mapImportBatchMock.mockResolvedValue({ layers: { roads: { ok: true, tiles: { count: 3 } } } } as never);
  mapIsochroneMock.mockResolvedValue({ polygons: [], center: null } as never);
  mapExportBatchMock.mockResolvedValue({ batchId: "b1", total: 1, skipped: 0 } as never);
  mapExportStatusMock.mockResolvedValue({ status: "done", summary: { done: 1, failed: 0, total: 1 } } as never);
  flagMock.mockReturnValue(false);
  stubs.mapViewerProps.current = null;
  stubs.mapClickHandler.current = null;
  stubs.chatProps.current = null;
  stubs.layerPanelProps.current = null;
  stubs.visualPanelProps.current = null;
  stubs.attributeTableProps.current = null;
  (window as unknown as Record<string, unknown>).__oawMapBridge = null;
  host = document.createElement("div");
  document.body.appendChild(host);
});

const flush = async (times = 2) => {
  for (let i = 0; i < times; i += 1) {
    await act(async () => { await Promise.resolve(); });
  }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mount(ui: React.ReactElement) {
  root = createRoot(host);
  act(() => { root!.render(ui); });
}

function unmount() {
  if (root) { act(() => { root!.unmount(); }); root = null; }
  host.remove();
}

const buttonByTitle = (title: string): HTMLButtonElement =>
  [...host.querySelectorAll("button")].find((b) => (b.getAttribute("title") || "").includes(title)) as HTMLButtonElement;

/* ==================== A. 加载链与 props 分发 ==================== */

describe("加载链与 props 分发", () => {
  it("A1 初始加载：mapProjects + mapProject(name, workspace) → 子件分发 + onProjectChange", async () => {
    try {
      const props = mapPanelProps();
      mount(<MapPanel {...(props as any)} />);
      await flush();
      expect(mapProjectsMock).toHaveBeenCalled();
      expect(mapProjectMock).toHaveBeenCalledWith("zhejiang-map", "ws1");
      expect(props.onProjectChange).toHaveBeenCalledWith("zhejiang-map");
      // LayerPanel 分发：cfg.groups / files / layerViews / tempLayers（初始空）
      const summary = JSON.parse(host.querySelector('[data-testid="layer-panel-stub"]')!.textContent!);
      expect(summary.groups).toEqual(["公路网"]);
      expect(summary.files).toBe(1);
      expect(summary.layerViews).toBe(1);
      expect(summary.tempLayers).toBe(0);
      // MapViewer 分发：project + config
      const mv = stubs.mapViewerProps.current!;
      expect(mv.project).toBe("zhejiang-map");
      expect((mv.config as { name?: string }).name).toBe("浙江地图");
      // bridgeRef 挂上四处理器
      const bridge = (props.bridgeRef as { current: Record<string, unknown> | null }).current!;
      expect(typeof bridge.onMapAction).toBe("function");
      expect(typeof bridge.onFileChanged).toBe("function");
      expect(typeof bridge.onAgentEnd).toBe("function");
      expect(typeof bridge.onOpenFile).toBe("function");
    } finally { unmount(); }
  });

  it("A2 内置 ChatPanel（hideChat=false）：透传 sessions/historyMessages + currentDoc 地图项目", async () => {
    try {
      mount(<MapPanel {...(mapPanelProps() as any)} />);
      await flush();
      const chat = stubs.chatProps.current!;
      expect(chat).toBeTruthy();
      expect(chat.threadId).toBe("t1");
      expect(chat.currentDoc).toBe("地图项目:zhejiang-map");
      expect(chat.sessions).toBe(SESSIONS);
      expect(chat.historyMessages).toEqual([{ role: "user", content: "hi" }]);
      expect(chat.compact).toBe(true);
      expect(typeof chat.onMapAction).toBe("function");
    } finally { unmount(); }
  });

  it("A3 会话切换清理链：threadId 变更 → clearAllAnalysis + clearDrill（增量）", async () => {
    try {
      const props = mapPanelProps();
      mount(<MapPanel {...(props as any)} />);
      await flush();
      const handle = stubs.mapViewerHandle.current as Record<string, ReturnType<typeof vi.fn>>;
      const clearCalls = handle.clearAllAnalysis!.mock.calls.length; // 挂载首跑也计入
      const drillCalls = handle.clearDrill!.mock.calls.length;
      act(() => { root!.render(<MapPanel {...(mapPanelProps({ threadId: "t2" }) as any)} />); });
      await flush();
      expect(handle.clearAllAnalysis!.mock.calls.length).toBeGreaterThan(clearCalls);
      expect(handle.clearDrill!.mock.calls.length).toBeGreaterThan(drillCalls);
    } finally { unmount(); }
  });
});

/* ==================== B. hideChat 分支形态 ==================== */

describe("hideChat 分支形态", () => {
  it("B1 hideChat=true：共享聊天形态 class + 不渲染内置 ChatPanel + 对话开关回调", async () => {
    try {
      const props = mapPanelProps({ hideChat: true, chatVisible: true, onToggleChat: vi.fn() });
      mount(<MapPanel {...(props as any)} />);
      await flush();
      expect(host.querySelector(".mp")!.className).toContain("mp-shared-chat");
      expect(host.querySelector(".mp-right")).toBeNull();
      expect(stubs.chatProps.current).toBeNull(); // 内置 ChatPanel 未挂载
      // 视图菜单 → 隐藏 Agent 对话
      buttonByTitle("视图：地球/平面、Agent 对话开关").click();
      await flush();
      const toggleBtn = [...host.querySelectorAll("button")].find((b) => b.textContent!.includes("隐藏 Agent 对话"));
      expect(toggleBtn).toBeTruthy();
      (toggleBtn as HTMLButtonElement).click();
      await flush();
      expect(props.onToggleChat).toHaveBeenCalledTimes(1);
    } finally { unmount(); }
  });
});

/* ==================== C. 桥接面 ==================== */

describe("桥接面", () => {
  it("C1 window.__oawMapBridge 注册与卸载清理", async () => {
    try {
      const props = mapPanelProps();
      mount(<MapPanel {...(props as any)} />);
      await flush();
      const globalBridge = (window as unknown as Record<string, Record<string, unknown>>).__oawMapBridge!;
      expect(typeof globalBridge.mapAction).toBe("function");
      expect(typeof globalBridge.fileChanged).toBe("function");
      expect(typeof globalBridge.agentEnd).toBe("function");
      unmount();
      expect((props.bridgeRef as { current: unknown }).current).toBeNull();
      expect((window as unknown as Record<string, unknown>).__oawMapBridge).toBeNull();
      return; // unmount 后跳过 finally 重复卸载
    } finally {
      if (root) unmount();
    }
  });

  it("C2 onMapAction：showAnalysis 渲染链 + flash 文案 + clear_analysis 分支", async () => {
    try {
      const props = mapPanelProps();
      mount(<MapPanel {...(props as any)} />);
      await flush();
      const bridge = (props.bridgeRef as { current: any }).current;
      const handle = stubs.mapViewerHandle.current as Record<string, ReturnType<typeof vi.fn>>;
      const action = { analysis: "od", id: "a1", geojson: { type: "FeatureCollection", features: [] } };
      bridge.onMapAction(action);
      await flush();
      expect(handle.showAnalysis).toHaveBeenCalledWith(action);
      expect(host.querySelector(".mp-msg")!.textContent).toContain("出行 OD已显示");
      // clear_analysis 分支：clearAnalysis(id) + 清除文案
      bridge.onMapAction({ action: "clear_analysis" });
      await flush();
      expect(handle.clearAnalysis).toHaveBeenCalledWith("agent-analysis");
      expect(host.querySelector(".mp-msg")!.textContent).toContain("已清除地图临时分析结果");
    } finally { unmount(); }
  });

  it("C3 onFileChanged：maps/<project>/ 前缀过滤命中才刷新", async () => {
    try {
      const props = mapPanelProps();
      mount(<MapPanel {...(props as any)} />);
      await flush();
      const callsAfterLoad = mapProjectMock.mock.calls.length;
      const bridge = (props.bridgeRef as { current: any }).current;
      const handle = stubs.mapViewerHandle.current as Record<string, ReturnType<typeof vi.fn>>;
      bridge.onFileChanged(["maps/other-project/style.json"]);
      await flush();
      expect(mapProjectMock.mock.calls.length).toBe(callsAfterLoad); // 无关项目不触发
      expect(handle.reloadStyle).not.toHaveBeenCalled();
      bridge.onFileChanged(["maps/zhejiang-map/style.json"]);
      await flush();
      expect(mapProjectMock.mock.calls.length).toBe(callsAfterLoad + 1);
      expect(handle.reloadStyle).toHaveBeenCalled();
    } finally { unmount(); }
  });

  it("C4 onAgentEnd：hideChat=true 延迟 reload 不透传；hideChat=false 同步透传", async () => {
    try {
      const props = mapPanelProps({ hideChat: true });
      mount(<MapPanel {...(props as any)} />);
      await flush();
      const callsAfterLoad = mapProjectMock.mock.calls.length;
      const bridge = (props.bridgeRef as { current: any }).current;
      bridge.onAgentEnd();
      expect(props.onAgentEnd).not.toHaveBeenCalled(); // 隐藏对话态不透传宿主
      await sleep(340);
      await flush();
      expect(mapProjectMock.mock.calls.length).toBe(callsAfterLoad + 1); // 300ms 后重拉项目
      unmount();

      const props2 = mapPanelProps();
      mount(<MapPanel {...(props2 as any)} />);
      await flush();
      const bridge2 = (props2.bridgeRef as { current: any }).current;
      bridge2.onAgentEnd();
      expect(props2.onAgentEnd).toHaveBeenCalledTimes(1);
    } finally { if (root) unmount(); }
  });

  it("C5 onOpenFile：onExit + onOpenFile 转发", async () => {
    try {
      const props = mapPanelProps();
      mount(<MapPanel {...(props as any)} />);
      await flush();
      const bridge = (props.bridgeRef as { current: any }).current;
      bridge.onOpenFile("a.geojson");
      expect(props.onExit).toHaveBeenCalledTimes(1);
      expect(props.onOpenFile).toHaveBeenCalledWith("a.geojson");
    } finally { unmount(); }
  });
});

/* ==================== D/E/F/G. 视口上报 / 等时圈 / 批量导出 / 数据导入 ==================== */

describe("视口上报与交互链", () => {
  it("D1 onViewportChange：增补 regionName 后透传宿主", async () => {
    try {
      const props = mapPanelProps();
      mount(<MapPanel {...(props as any)} />);
      await flush();
      const report = { center: [120, 29], zoom: 8 };
      act(() => { (stubs.mapViewerProps.current!.onViewportChange as (c: unknown) => void)(report); });
      expect(props.onViewportChange).toHaveBeenCalledWith({ ...report, regionName: "" });
    } finally { unmount(); }
  });

  it("E1 等时圈：未选点守卫 → stub 地图选点 → mapIsochrone 四元组载荷", async () => {
    try {
      mount(<MapPanel {...(mapPanelProps() as any)} />);
      await flush();
      buttonByTitle("可达性：等时圈与路径规划").click();
      await flush();
      const panel = host.querySelector(".mp-iso-panel")!;
      expect(panel).toBeTruthy();
      // 未选点提交 → 守卫文案，不发起请求
      act(() => { (panel.querySelector(".btn.primary") as HTMLButtonElement).click(); });
      await flush();
      expect(panel.textContent).toContain("请先选择中心点");
      expect(mapIsochroneMock).not.toHaveBeenCalled();
      // 地图选点：startPick 注册 click → stub 触发
      const pickBtn = [...host.querySelectorAll("button")].find((b) => b.textContent!.includes("地图选点")) as HTMLButtonElement;
      act(() => { pickBtn.click(); });
      expect(stubs.mapClickHandler.current).toBeTruthy();
      act(() => { stubs.mapClickHandler.current!({ lngLat: { lng: 120.1, lat: 29.2 } }); });
      await flush();
      act(() => { (host.querySelector(".mp-iso-panel .btn.primary") as HTMLButtonElement).click(); });
      await flush();
      expect(mapIsochroneMock).toHaveBeenCalledWith({ location: "120.100000,29.200000", mode: "driving", range: 30, rangeType: "time" });
      expect(host.querySelector(".mp-iso-panel")!.textContent).toContain("计算完成");
    } finally { unmount(); }
  });

  it("F1 批量导出：flag 开 → 勾选项目 → 入队 → 轮询 running → done 文案", async () => {
    try {
      flagMock.mockImplementation((key: unknown) => key === "mapExport");
      mapExportStatusMock
        .mockResolvedValueOnce({ status: "running", summary: { done: 0, failed: 0, total: 1 } } as never)
        .mockResolvedValueOnce({ status: "done", summary: { done: 1, failed: 0, total: 1 } } as never);
      mount(<MapPanel {...(mapPanelProps() as any)} />);
      await flush();
      buttonByTitle("导出报告图").click();
      await flush();
      const batch = host.querySelector(".mp-iso-batch")!;
      expect(batch).toBeTruthy();
      // 勾选第二个项目 p1（默认尺寸 a4l / 格式 png）
      const checkboxes = [...batch.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
      act(() => { checkboxes[1]!.click(); });
      await flush();
      act(() => { ([...batch.querySelectorAll("button")].find((b) => b.textContent!.includes("发起批量导出")) as HTMLButtonElement).click(); });
      await flush();
      expect(mapExportBatchMock).toHaveBeenCalledWith({ projects: ["p1"], sizes: ["a4l"], formats: ["png"], title: undefined });
      expect(host.querySelector(".mp-msg")!.textContent).toContain("批量导出已入队（1 个任务");
      await sleep(1400); // 首轮轮询 1.2s
      await flush();
      expect(host.querySelector(".mp-iso-batch")!.textContent).toContain("执行中 0/1");
      await sleep(1700); // 次轮轮询 +1.5s → done
      await flush();
      expect(host.querySelector(".mp-iso-batch")!.textContent).toContain("1 个成功");
      expect(host.querySelector(".mp-iso-batch")!.textContent).not.toContain("执行中");
    } finally { unmount(); }
  });

  it("G1 数据导入：GeoJSON 文件 → mapImportBatch 载荷 → 成功文案 + reloadStyle + zoomToLayer", async () => {
    try {
      mount(<MapPanel {...(mapPanelProps() as any)} />);
      await flush();
      buttonByTitle("数据：导入、重建瓦片、刷新地图").click();
      await flush();
      const importBtn = [...host.querySelectorAll(".mp-analysis-menu button")].find((b) => b.textContent!.includes("导入数据")) as HTMLButtonElement;
      act(() => { importBtn.click(); });
      await flush();
      const input = host.querySelector('input[type="file"]') as HTMLInputElement;
      expect(input).toBeTruthy();
      const geojson = { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [120, 29] } }] };
      const raw = JSON.stringify(geojson);
      // jsdom File 未实现 text()：补实例方法（handleBatchImport 依赖 f.text() 读内容）
      const file = new File([raw], "roads.geojson", { type: "application/json" }) as File & { text?: () => Promise<string> };
      file.text = () => Promise.resolve(raw);
      // zoomToLayer 链：mapGetLayer 返回要素 → 计算包围盒 → stub 地图 fitBounds
      mapGetLayerMock.mockResolvedValue({ features: [{ geometry: { coordinates: [120, 29.1] } }] } as never);
      Object.defineProperty(input, "files", { value: [file], configurable: true });
      await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
      await flush(3);
      // 诊断锚点：导入失败时 impMsg 会给出失败原因
      if (!mapImportBatchMock.mock.calls.length) {
        throw new Error(`mapImportBatch 未调用；impMsg=${host.querySelector(".mp-iso-info")?.textContent || "(空)"}`);
      }
      expect(mapImportBatchMock).toHaveBeenCalledWith("zhejiang-map", [{ layerId: "roads", geojson }]);
      const handle = stubs.mapViewerHandle.current as Record<string, ReturnType<typeof vi.fn>>;
      expect(handle.reloadStyle).toHaveBeenCalled();
      // zoomToLayer 是 map-panel 自有 useCallback：mapGetLayer 取要素算 bbox → stub 地图 fitBounds
      const mapStub = handle.getMap!() as unknown as Record<string, ReturnType<typeof vi.fn>>;
      expect(mapStub.fitBounds).toHaveBeenCalled();
      expect(host.querySelector(".mp-iso-info")!.textContent).toContain("已导入 1 个图层（roads），瓦片已重建");
    } finally { unmount(); }
  });
});
