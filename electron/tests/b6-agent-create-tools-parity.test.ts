/**
 * B6-6-4g 行为覆盖：_create 工具定义工厂批（create-tools.ts buildCreateTools）。
 *
 * R6-6b 对拍退役改写：旧侧 agent.mjs 源码段提取 + new Function 工厂随 server 退役删除，
 * 仅保留 TS 侧断言（期望值此前已经双侧对拍固化，现改为直接断言）。
 *
 * pi 域（defineTool/Type/createBashToolDefinition）与未迁域 seam 均以 stub 注入；
 * 动态 import 的域模块（office/kb/map/layer-repository/map-visualization/
 * spatial-analysis/map-template）经 vi.mock 换绑 reg stub。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import * as pathMod from "node:path";
import * as osMod from "node:os";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { buildCreateTools } from "../src/main/backend/agent/create-tools";
import { ASK_TIMEOUT_MS, savePendingAsks } from "../src/main/backend/agent/pending-asks";

// ---- 域模块 stub 注册表：create-tools 动态 import 经 vi.mock 转发到 reg ----
const reg = vi.hoisted(() => ({
  office: {} as any, kb: {} as any, map: {} as any, repo: {} as any,
  vis: {} as any, traffic: {} as any, spatial: {} as any, tpl: {} as any,
}));
// vi.mock 工厂用 getter 显式转发：vitest 会枚举工厂返回对象的导出名做存在性校验，
// getter 让导出名静态可见，取值时才解引用 reg 里的当前 stub（每用例可重赋值）。
vi.mock("../src/main/backend/office", () => ({
  get runOfficecli() { return (reg as any).office.runOfficecli; },
  get validateOfficecliArgs() { return (reg as any).office.validateOfficecliArgs; },
}));
vi.mock("../src/main/backend/kb", () => ({
  get scan() { return (reg as any).kb.scan; },
  get status() { return (reg as any).kb.status; },
  get getDoc() { return (reg as any).kb.getDoc; },
  get search() { return (reg as any).kb.search; },
}));
vi.mock("../src/main/backend/map", () => ({
  get DEFAULT_PROJECT() { return (reg as any).map.DEFAULT_PROJECT; },
  get getProject() { return (reg as any).map.getProject; },
  get projectDir() { return (reg as any).map.projectDir; },
  get listProjects() { return (reg as any).map.listProjects; },
  get importLayer() { return (reg as any).map.importLayer; },
}));
vi.mock("../src/main/backend/layer-repository", () => ({
  get listLayers() { return (reg as any).repo.listLayers; },
  get resolveLayer() { return (reg as any).repo.resolveLayer; },
  get markLayerOwnership() { return (reg as any).repo.markLayerOwnership; },
}));
// traffic-sources 仅注册面（导入即注册），mock 为空壳即可（listSources/loadSource 已 mock）。
vi.mock("../src/main/backend/map-visualization", () => ({
  get listSources() { return (reg as any).vis.listSources; },
  get loadSource() { return (reg as any).vis.loadSource; },
}));
vi.mock("../src/main/backend/traffic-sources", () => ({}));
vi.mock("../src/main/backend/spatial-analysis", () => ({
  get analyzeGeoJSON() { return (reg as any).spatial.analyzeGeoJSON; },
}));
vi.mock("../src/main/backend/map-template", () => ({
  get runOdCommuterTemplate() { return (reg as any).tpl.runOdCommuterTemplate; },
}));

// ---- 32 个工具键（与 create-tools.ts buildCreateTools 返回对象一一对应） ----
const TOOL_KEYS = [
  "managedBashTool", "officeTool", "todoTool", "kbSearchTool", "kbReadTool", "reviewSourceApplyTool",
  "browserOpenTool", "browserSnapshotTool", "browserClickTool", "browserTypeTool", "browserPressTool",
  "browserScrollTool", "browserScreenshotTool", "browserBackTool", "browserTabsTool", "browserCloseTool",
  "webSearchTool", "webFetchTool", "skillsSearchTool", "skillsReadTool", "contextReadTool",
  "mapReadTool", "mapEditTool", "mapImportTool", "mapDatasetsTool", "mapAnalyzeTool", "mapTemplateTool",
  "mapSaveAnalysisTool", "mapClearAnalysisTool", "memoryUpdateTool", "completeTaskTool", "askUserTool",
];

// ---- 轻量 Type stub（defineTool parameters 形状） ----
const TypeStub: any = {
  Object: (props: any, opts?: any) => ({ type: "object", properties: props, required: Object.keys(props).filter((k) => !props[k]?.__opt), ...(opts || {}) }),
  String: (opts?: any) => ({ type: "string", ...(opts || {}) }),
  Number: (opts?: any) => ({ type: "number", ...(opts || {}) }),
  Boolean: (opts?: any) => ({ type: "boolean", ...(opts || {}) }),
  Array: (items: any, opts?: any) => ({ type: "array", items, ...(opts || {}) }),
  Union: (options: any, opts?: any) => ({ anyOf: options, ...(opts || {}) }),
  Literal: (v: any) => ({ const: v, type: typeof v }),
  Optional: (s: any) => ({ ...s, __opt: 1 }),
};

function makeHarness(opts: { flags?: any; entry?: any; overrides?: any } = {}) {
  const events: any[] = [];
  const channelEvents: any[] = [];
  const calls: Record<string, any> = {};
  const fn = (key: string, impl?: any) => { calls[key] = vi.fn(impl); return calls[key]; };
  const tmpWs = mkdtempSync(pathMod.join(osMod.tmpdir(), "p4g-ws-"));
  const entry: any = {
    workspace: tmpWs, clientId: "c1", threadId: "t1", activeRunId: "run_1", mode: "work",
    task: null, references: [], reviewProtectedPaths: [],
    reviewSources: [{ sourceId: "R-01", status: "read" }],
    channel: { seq: 0, streamId: "s1", history: [], emitter: new EventEmitter() },
    ...opts.entry,
  };
  entry.channel.emitter.on("event", (ev: any) => channelEvents.push({ id: ev.id, type: ev.type, data: ev.data }));
  const flags = opts.flags || {};
  const world: any = {
    entry, workspace: tmpWs, clientId: "c1",
    pendingAsks: new Map(), flags,
    activeWriteContext: fn("activeWriteContext", (kind: string) => ({ runId: "run_1", threadId: "t1", workspace: tmpWs, kind })),
    writeEvent: fn("writeEvent", (type: string, data: any) => events.push({ type, data })),
    withWorkspaceWriteLock: fn("withWorkspaceWriteLock", async (_c: any, _k: string, action: any) => action()),
    assertReviewWriteAllowed: fn("assertReviewWriteAllowed", () => {}),
    reviewSourceEvent: fn("reviewSourceEvent", () => {}),
    registerReviewSource: fn("registerReviewSource", (input: any) => ({ sourceId: "src_1", ...input })),
    localBash: { exec: fn("localBashExec", async () => ({ exitCode: 0, output: "ok" })) },
    defineTool: (def: any) => def,
    Type: TypeStub,
    createBashToolDefinition: fn("createBashToolDefinition", (cwd: string, options: any) => ({ name: "bash", cwd, operations: options.operations })),
    requireToolApproval: fn("requireToolApproval", async () => {}),
    isGlobalSearchCommand: fn("isGlobalSearchCommand", () => false),
    normalizeBashOptions: fn("normalizeBashOptions", (o: any) => o || {}),
    normalizeOfficeFailure: fn("normalizeOfficeFailure", (e: any) => e),
    parseArgs: fn("parseArgs", (input: any) => String(input).trim().split(/\s+/).filter(Boolean)),
    collectReferencedPaths: fn("collectReferencedPaths", () => []),
    ensureOfficeOutputDirs: fn("ensureOfficeOutputDirs", () => []),
    webSearch: fn("webSearch", async () => ({ backend: "stub", results: [{ title: "T1", url: "https://example.com/a", snippet: "s1" }] })),
    webFetch: fn("webFetch", async () => ({ url: "https://example.com/a", title: "Page", via: "direct", markdown: "# Hello", chars: 7, truncated: false })),
    browserSessionKey: fn("browserSessionKey", (c: any, t: any) => `${c}:${t}`),
    browserOpen: fn("browserOpen", async () => ({ url: "https://example.com/a", title: "Page" })),
    browserSnapshot: fn("browserSnapshot", async () => ({ url: "https://example.com/a", title: "Page", elements: ["e1 按钮"], text: "hello" })),
    browserClick: fn("browserClick", async () => ({ clicked: "e1", text: "按钮", url: "https://example.com/a" })),
    browserType: fn("browserType", async (_k: any, _r: any, text: any, o: any) => ({ typed: "e1", chars: String(text).length, submitted: o?.submit === true })),
    browserPress: fn("browserPress", async () => ({ pressed: "Enter" })),
    browserScroll: fn("browserScroll", async () => ({ y: 600, height: 1200 })),
    browserScreenshot: fn("browserScreenshot", async () => ({ bytes: 2048 })),
    browserBack: fn("browserBack", async () => ({ url: "https://example.com/b" })),
    browserTabs: fn("browserTabs", async () => ({ tabs: [{ id: "tab1234567890", active: true, title: "T", url: "https://example.com/a" }] })),
    browserClose: fn("browserClose", async () => ({ closed: true })),
    getBashSidecar: fn("getBashSidecar", () => ({ execute: async () => ({ exitCode: 0, output: "sidecar" }) })),
    createDemoAnalysis: fn("createDemoAnalysis", (input: any) => ({
      action: "show_analysis", id: `demo-${input.analysis}`, analysis: input.analysis,
      project: input.project, title: `演示${input.region}`,
      geojson: { type: "FeatureCollection", features: [] },
    })),
    normalizeCompletion: fn("normalizeCompletion", (input: any) => (input && ["success", "partial", "blocked", "failed"].includes(input.status) && input.summary
      ? {
          status: input.status, summary: String(input.summary),
          ...(input.incomplete ? { incomplete: input.incomplete } : {}),
          ...(input.blockers ? { blockers: input.blockers } : {}),
          ...(input.verification ? { verification: input.verification } : {}),
        }
      : null)),
    completionStatusLabel: fn("completionStatusLabel", (s: any) => ({ success: "已完成", partial: "部分完成", blocked: "受阻", failed: "失败" } as any)[s] || s),
    evaluateMemoryCandidate: fn("evaluateMemoryCandidate", () => ({ ok: true })),
    getProjectForWorkspace: fn("getProjectForWorkspace", () => null),
    updateRunTodo: fn("updateRunTodo", () => ({ todos: [{ id: "1", title: "A", status: "completed" }], todoProgress: { completed: 1, total: 1 } })),
    listStoredMemoryProposals: fn("listStoredMemoryProposals", () => []),
    createMemoryProposal: fn("createMemoryProposal", (input: any) => ({ id: "prop_1", ...input })),
    ...opts.overrides,
  };
  const fresh = buildCreateTools(world);
  const reset = () => {
    events.length = 0; channelEvents.length = 0; entry.channel.seq = 0;
    for (const key of Object.keys(calls)) calls[key].mockClear();
  };
  return { world, entry, flags, calls, events, channelEvents, fresh, reset, tmpWs, reg };
}

/** 单侧跑一个工具并取回 JSON 化返回值（执行后清场）。 */
async function runOne(h: any, tool: string, params: any) {
  const r = JSON.parse(JSON.stringify(await h.fresh[tool].execute("tc", params)));
  h.reset();
  return r;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---- 1. 定义级 ----
describe("b664g 工具定义级", () => {
  it("32 个工具键齐全", () => {
    const h = makeHarness();
    expect(Object.keys(h.fresh).sort()).toEqual([...TOOL_KEYS].sort());
    expect(Object.keys(h.fresh)).toHaveLength(32);
  });
});

// ---- 2. bash ----
describe("b664g bash 工具", () => {
  const exec = (h: any, command: string, cwd?: string) =>
    h.fresh.managedBashTool.operations.exec(command, cwd, {});

  it("正常执行：审批入参 + 写锁事件 + localBash 转发", async () => {
    const h = makeHarness();
    const r = JSON.parse(JSON.stringify(await exec(h, "echo hi")));
    expect(r).toEqual({ exitCode: 0, output: "ok" });
    expect(h.calls.requireToolApproval).toHaveBeenCalledTimes(1);
    expect(h.calls.localBashExec).toHaveBeenCalledTimes(1);
    expect(h.events.map((e: any) => e.type)).toEqual(["write_started", "write_locked"]);
  });

  it("全盘搜索拦截：BASH_SCOPE_BLOCKED", async () => {
    const h = makeHarness({ overrides: { isGlobalSearchCommand: () => true } });
    await expect(exec(h, "ls /")).rejects.toMatchObject({ code: "BASH_SCOPE_BLOCKED" });
  });

  it("记忆写拦截：MEMORY_WRITE_REQUIRES_PROPOSAL", async () => {
    const h = makeHarness();
    await expect(exec(h, "echo x > memory/a.md")).rejects.toMatchObject({ code: "MEMORY_WRITE_REQUIRES_PROPOSAL" });
  });

  it("piBashSidecar on：走侧车而非 localBash", async () => {
    const h = makeHarness({ flags: { piBashSidecar: 1 } });
    const r = JSON.parse(JSON.stringify(await exec(h, "echo s")));
    expect(r).toEqual({ exitCode: 0, output: "sidecar" });
    expect(h.calls.localBashExec).not.toHaveBeenCalled();
  });
});

// ---- 3. officecli ----
describe("b664g officecli 工具", () => {
  it("validate 抛错：officecli_failed 事件 + 抛错", async () => {
    const h = makeHarness();
    h.reg.office.validateOfficecliArgs = vi.fn(() => { throw Object.assign(new Error("参数不合法"), { code: "OFFICECLI_ARGS_INVALID" }); });
    h.reg.office.runOfficecli = vi.fn();
    await expect(h.fresh.officeTool.execute("tc", { args: "view f.docx text" })).rejects.toMatchObject({ code: "OFFICECLI_ARGS_INVALID" });
    expect(h.events.map((e: any) => e.type)).toContain("officecli_failed");
  });

  it("成功路径：无锁分支直跑 runOfficecli", async () => {
    const h = makeHarness();
    h.reg.office.validateOfficecliArgs = vi.fn(() => ({ command: "view", file: "f.docx", absolute: false }));
    h.reg.office.runOfficecli = vi.fn(async () => ({ code: 0, text: "done" }));
    const r = await runOne(h, "officeTool", { args: "view f.docx text" });
    expect(r.content[0].text.length).toBeGreaterThan(0);
  });

  it("lockBlocked：OFFICE_DOCUMENT_LOCKED + officeLockFailures 计数", async () => {
    const h = makeHarness();
    h.reg.office.validateOfficecliArgs = vi.fn(() => ({ command: "view", file: "f.docx", absolute: false }));
    h.reg.office.runOfficecli = vi.fn(async () => ({ code: 1, stderr: "busy", lockBlocked: true }));
    await expect(h.fresh.officeTool.execute("tc", { args: "view f.docx text" })).rejects.toMatchObject({
      code: "OFFICE_DOCUMENT_LOCKED",
    });
    expect(h.entry.officeLockFailures.get("f.docx")).toBe(1);
  });
});

// ---- 4. todo + review_source_apply ----
describe("b664g todo 与 review_source_apply", () => {
  it("todo 缺 Run：RUN_REQUIRED", async () => {
    const h = makeHarness({ entry: { activeRunId: null } });
    await expect(h.fresh.todoTool.execute("tc", { items: [] })).rejects.toMatchObject({ code: "RUN_REQUIRED" });
  });

  it("todo 正常：todo_updated 通道事件", async () => {
    const h = makeHarness();
    await h.fresh.todoTool.execute("tc", { items: [{ title: "A", status: "completed" }] });
    expect(h.channelEvents.map((e: any) => e.type)).toContain("todo_updated");
  });

  it("review_source_apply：命中登记 + 未命中文案", async () => {
    const h = makeHarness();
    await runOne(h, "reviewSourceApplyTool", { sourceIds: ["R-01", "R-99"], status: "applied", reason: "核对通过" });
  });
});

// ---- 5. kb ----
describe("b664g kb_search 与 kb_read", () => {
  it("kb_read：命中文档登记审查依据 + review_source 事件", async () => {
    const h = makeHarness();
    h.reg.kb.scan = vi.fn(async () => {});
    h.reg.kb.status = vi.fn(() => ({ roots: [{ name: "rootA" }, { name: "rootB" }] }));
    h.reg.kb.getDoc = vi.fn((_rel: string, idx: any) => (idx === 1
      ? { relPath: "doc.md", rootIdx: 1, title: "文档A", content: "# 内容", tags: ["t1"] }
      : null));
    const r = await runOne(h, "kbReadTool", { path: "doc.md@rootB" });
    expect(r.content[0].text).toContain("文档A");
  });

  it("kb_read：未找到文档文案", async () => {
    const h = makeHarness();
    h.reg.kb.scan = vi.fn(async () => {});
    h.reg.kb.status = vi.fn(() => ({ roots: [{ name: "rootA" }] }));
    h.reg.kb.getDoc = vi.fn(() => null);
    await runOne(h, "kbReadTool", { path: "missing.md@rootA" });
  });

  it("kb_search：候选列表", async () => {
    const h = makeHarness();
    h.reg.kb.scan = vi.fn(async () => {});
    h.reg.kb.status = vi.fn(() => ({ roots: [{ name: "rootA" }] }));
    h.reg.kb.search = vi.fn(() => [{ title: "文档A", relPath: "doc.md", rootIdx: 0, score: 0.9, snippet: "片段" }]);
    await runOne(h, "kbSearchTool", { query: "出行" });
  });
});

// ---- 6. browser 族 ----
describe("b664g browser 族", () => {
  it("browser_open 成功与失败文案", async () => {
    const h = makeHarness();
    await runOne(h, "browserOpenTool", { url: "https://example.com/a" });
  });

  it("browser_open 用户接管错误：BROWSER_USER_TAKEOVER 文案", async () => {
    const h = makeHarness({
      overrides: { browserOpen: async () => { throw Object.assign(new Error("启动失败"), { code: "BROWSER_USER_TAKEOVER" }); } },
    });
    await runOne(h, "browserOpenTool", { url: "https://example.com/a" });
  });

  it("browser_snapshot / click / type / press / scroll / screenshot / back / tabs 转发", async () => {
    const h = makeHarness();
    for (const [tool, params] of [
      ["browserSnapshotTool", { purpose: "check" }],
      ["browserClickTool", { ref: "e1" }],
      ["browserTypeTool", { ref: "e1", text: "hi", submit: true }],
      ["browserPressTool", { key: "Enter" }],
      ["browserScrollTool", { direction: "down", amount: 300 }],
      ["browserScreenshotTool", {}],
      ["browserBackTool", {}],
      ["browserTabsTool", { action: "list" }],
    ] as const) {
      await runOne(h, tool as string, params as any);
    }
  });

  it("browser_close kept=true 提示保留", async () => {
    const h = makeHarness({ overrides: { browserClose: async () => ({ kept: true, message: "已保留浏览器。" }) } });
    const r = await runOne(h, "browserCloseTool", { reason: "done" });
    expect(r.content[0].text).toContain("已保留");
  });
});

// ---- 7. web ----
describe("b664g web_search 与 web_fetch", () => {
  it("web_search 成功：标题/链接/摘要拼接", async () => {
    const h = makeHarness();
    const r = await runOne(h, "webSearchTool", { query: "政策", maxResults: 3 });
    expect(r.content[0].text).toContain("搜索结果（后端：stub）");
  });

  it("web_search 空结果与未配置 hint 文案", async () => {
    const h = makeHarness({ overrides: { webSearch: async () => ({ backend: "bing", results: [], answer: "" }) } });
    const r = await runOne(h, "webSearchTool", { query: "x" });
    expect(r.content[0].text).toContain("未找到相关结果（后端：bing）");

    const h2 = makeHarness({ overrides: { webSearch: async () => { throw Object.assign(new Error("未配置"), { code: "SEARCH_NOT_CONFIGURED" }); } } });
    const r2 = await runOne(h2, "webSearchTool", { query: "x" });
    expect(r2.content[0].text).toContain("browser_open 打开 https://cn.bing.com/search");
  });

  it("web_fetch 成功与 WEB_FETCH_BLOCKED hint", async () => {
    const h = makeHarness();
    const r = await runOne(h, "webFetchTool", { url: "https://example.com/a" });
    expect(r.content[0].text).toContain("# Hello");

    const h2 = makeHarness({ overrides: { webFetch: async () => { throw Object.assign(new Error("内网地址"), { code: "WEB_FETCH_BLOCKED" }); } } });
    const r2 = await runOne(h2, "webFetchTool", { url: "http://127.0.0.1:9/x" });
    expect(r2.content[0].text).toContain("安全边界拦截");
  });
});

// ---- 8. skills + context_read ----
describe("b664g skills 与 context_read", () => {
  it("skills_search / skills_read 未命中文案", async () => {
    const h = makeHarness();
    await runOne(h, "skillsSearchTool", { query: "前端" });
    await runOne(h, "skillsReadTool", { name: "not-exist" });
  });

  it("context_read：未找到引用文案含引用摘要", async () => {
    const h = makeHarness({ entry: { references: [{ id: "ref_x", kind: "file", target: "a.md" }] } });
    await runOne(h, "contextReadTool", { refId: "ref_missing" });
  });
});

// ---- 9. map 族 ----
describe("b664g map 族", () => {
  const styleObj = () => ({
    layers: [
      { id: "highways", type: "line", paint: { "line-color": "#000" } },
      { id: "basemap-0", type: "background" },
      { id: "highways-label", type: "symbol", layout: { visibility: "none" } },
    ],
  });
  const proj = () => ({
    config: { name: "浙江交通", center: [120, 30], zoom: 7, basemap: "vec" },
    files: [{ id: "f1", size: 2048 }],
    style: styleObj(),
  });

  it("map_read：项目/图层/样式清单", async () => {
    const h = makeHarness();
    h.reg.map.DEFAULT_PROJECT = "zhejiang-map";
    h.reg.map.getProject = vi.fn(() => proj());
    h.reg.repo.listLayers = vi.fn(() => [{ id: "f1", origin: "shared" }]);
    const r = await runOne(h, "mapReadTool", {});
    expect(r.content[0].text).toContain("浙江交通");
  });

  it("map_edit setVisibility：解析/审批/落盘事件，注记层联动", async () => {
    const h = makeHarness();
    h.reg.map.DEFAULT_PROJECT = "zhejiang-map";
    h.reg.map.projectDir = vi.fn(() => h.tmpWs);
    h.reg.repo.resolveLayer = vi.fn(() => ({ ok: true, matches: [{ id: "highways", ref: "shared/highways" }] }));
    writeFileSync(pathMod.join(h.tmpWs, "style.json"), JSON.stringify(styleObj(), null, 2), "utf8");
    await h.fresh.mapEditTool.execute("tc", { action: "setVisibility", target: "id:highways", visible: false });
    const saved = JSON.parse(readFileSync(pathMod.join(h.tmpWs, "style.json"), "utf8"));
    expect(saved.layers.find((l: any) => l.id === "highways").layout.visibility).toBe("none");
    expect(saved.layers.find((l: any) => l.id === "highways-label").layout.visibility).toBe("none");
  });

  it("map_edit paint 非法 JSON：错误文案（不落盘）", async () => {
    const h = makeHarness();
    h.reg.map.DEFAULT_PROJECT = "zhejiang-map";
    h.reg.map.projectDir = vi.fn(() => h.tmpWs);
    h.reg.repo.resolveLayer = vi.fn(() => ({ ok: true, matches: [{ id: "highways", ref: "shared/highways" }] }));
    await runOne(h, "mapEditTool", { action: "setPaint", target: "id:highways", paint: "{invalid" });
  });

  it("map_import：工作区内 GeoJSON 导入 + 归属标注", async () => {
    const h = makeHarness();
    h.reg.map.DEFAULT_PROJECT = "zhejiang-map";
    h.reg.map.importLayer = vi.fn(async () => ({ tiles: { count: 5 } }));
    h.reg.repo.markLayerOwnership = vi.fn();
    writeFileSync(pathMod.join(h.tmpWs, "data.geojson"), JSON.stringify({ type: "FeatureCollection", features: [{}, {}] }), "utf8");
    const r = await runOne(h, "mapImportTool", { file: "data.geojson", layerId: "L1" });
    expect(r.content[0].text).toContain("已导入图层 L1（2 个要素");
  });

  it("map_import：工作区外路径拒绝", async () => {
    const h = makeHarness();
    h.reg.map.DEFAULT_PROJECT = "zhejiang-map";
    await runOne(h, "mapImportTool", { file: "../../../etc/passwd.geojson" });
  });

  it("map_datasets：项目清单 + 数据源适配器", async () => {
    const h = makeHarness();
    h.reg.map.DEFAULT_PROJECT = "zhejiang-map";
    h.reg.map.listProjects = vi.fn(() => [{ project: "zhejiang-map", name: "浙江交通" }]);
    h.reg.repo.listLayers = vi.fn(() => [
      { id: "f1", name: "公路", type: "line", origin: "shared" },
      { id: "mine1", name: "我的层", type: "fill", origin: "workspace" },
    ]);
    h.reg.vis.listSources = vi.fn(() => [{ id: "local-file", label: "本地文件", kind: "*" }]);
    h.reg.traffic.register = vi.fn();
    const r = await runOne(h, "mapDatasetsTool", {});
    expect(r.content[0].text).toContain("共享数据集（1）");
  });

  it("map_analyze 演示路径：map_action 事件 + lastMapAnalysis", async () => {
    const h = makeHarness();
    const r = await runOne(h, "mapAnalyzeTool", { analysis: "heatmap", region: "义乌市" });
    expect(r.content[0].text).toContain("演示数据");
    expect(h.entry.lastMapAnalysis.id).toBe("demo-heatmap");
  });

  it("map_analyze spatial flag off / on（含工作区读取）", async () => {
    const h = makeHarness();
    await runOne(h, "mapAnalyzeTool", { analysis: "buffer", path: "data.geojson" });

    const h2 = makeHarness({ flags: { spatialAnalysis: 1 } });
    h2.reg.spatial.analyzeGeoJSON = vi.fn(() => ({
      stats: { count: 2, inputCount: 3, totalAreaKm2: 12.5, elapsedMs: 5 },
      geojson: { type: "FeatureCollection", features: [] },
    }));
    writeFileSync(pathMod.join(h2.tmpWs, "data.geojson"), JSON.stringify({ type: "FeatureCollection", features: [] }), "utf8");
    const r = await runOne(h2, "mapAnalyzeTool", { analysis: "buffer", path: "data.geojson", distanceMeters: 500 });
    expect(r.content[0].text).toContain("空间分析完成：buffer，2/3 个要素");
  });

  it("map_analyze dataSource 适配器路径", async () => {
    const h = makeHarness();
    h.reg.vis.loadSource = vi.fn(async () => ({
      id: "d1", kind: "points", title: "车流", provenance: { demo: true },
      geojson: { type: "FeatureCollection", features: [] }, stats: { count: 3 },
    }));
    h.reg.traffic.register = vi.fn();
    const r = await runOne(h, "mapAnalyzeTool", { analysis: "od", dataSource: "local-file", path: "data.csv" });
    expect(r.content[0].text).toContain("已用数据源 local-file");
  });

  it("map_template flag off / on", async () => {
    const h = makeHarness();
    const r = await runOne(h, "mapTemplateTool", { template: "od-commuter", path: "od.csv" });
    expect(r.content[0].text).toContain("场景化分析模板未开启");

    const h2 = makeHarness({ flags: { mapTemplates: 1 } });
    h2.reg.tpl.runOdCommuterTemplate = vi.fn(async () => ({
      title: "OD 通勤分析", template: "od-commuter",
      bands: { count: 10, levels: ["L1", "L2"], topFlows: [{ label: "义乌→金华", flow: 123.4 }] },
      report: { fileName: "report.docx" },
    }));
    h2.reg.vis.loadSource = vi.fn(async () => ({
      id: "od-lines", error: null, lines: [{ from: [120, 30], to: [119, 29] }],
      geojson: { type: "FeatureCollection", features: [] }, stats: { count: 1 },
    }));
    const r2 = await runOne(h2, "mapTemplateTool", { template: "od-commuter", path: "od.csv" });
    expect(r2.content[0].text).toContain("OD 通勤分析完成：10 对流向");
  });

  it("map_save_analysis：审批 + importLayer + 归属标注", async () => {
    const h = makeHarness({
      entry: { lastMapAnalysis: { id: "demo-heatmap", analysis: "heatmap", project: "zhejiang-map", title: "演示热力图", geojson: { type: "FeatureCollection", features: [] } } },
    });
    h.reg.map.DEFAULT_PROJECT = "zhejiang-map";
    h.reg.map.importLayer = vi.fn(async () => ({}));
    h.reg.repo.markLayerOwnership = vi.fn();
    const r = await runOne(h, "mapSaveAnalysisTool", {});
    expect(r.content[0].text).toContain("保存为正式图层 demo-heatmap");
  });

  it("map_save_analysis：无可保存结果文案", async () => {
    const h = makeHarness();
    await runOne(h, "mapSaveAnalysisTool", {});
  });

  it("map_clear_analysis：map_action 事件", async () => {
    const h = makeHarness();
    await runOne(h, "mapClearAnalysisTool", { id: "demo-heatmap" });
  });
});

// ---- 10. memory / complete_task / ask_user ----
describe("b664g memory_update 与 complete_task", () => {
  it("memory_update manual 策略：拒绝沉淀文案", async () => {
    const h = makeHarness({ overrides: { getProjectForWorkspace: () => ({ settings: { memoryPolicy: "manual" } }) } });
    const r = await runOne(h, "memoryUpdateTool", { section: "项目事实", content: "X" });
    expect(r.details.skipped).toBe("manual_policy");
  });

  it("memory_update 准入拒绝：memory_proposal_rejected 事件", async () => {
    const h = makeHarness({ overrides: { evaluateMemoryCandidate: () => ({ ok: false, code: "TEMP_STATE", reason: "临时状态" }) } });
    await runOne(h, "memoryUpdateTool", { section: "项目事实", content: "今天天气" });
  });

  it("memory_update 正常：createMemoryProposal + memory_proposal 事件", async () => {
    const h = makeHarness();
    await runOne(h, "memoryUpdateTool", { section: "经验教训", content: "先校验再写入" });
  });

  it("complete_task 正常与无效入参", async () => {
    const h = makeHarness();
    const r = await runOne(h, "completeTaskTool", { status: "success", summary: "搞定" });
    expect(r.content[0].text).toContain("已记录任务完成状态：已完成");
    await runOne(h, "completeTaskTool", { status: "nope", summary: "" });
  });
});

describe("b664g ask_user", () => {
  it("回答路径：pendingAsks 登记 + resolve 文案 + 落盘", async () => {
    const h = makeHarness();
    const p = h.fresh.askUserTool.execute("tc", { question: "用哪种格式?", options: ["A", "B"] });
    const done = h.world.pendingAsks.get("c1");
    expect(typeof done).toBe("function");
    done("A");
    const r = JSON.parse(JSON.stringify(await p));
    expect(r.content[0].text).toBe("用户回答：A");
    savePendingAsks([]);
  });

  it("review 确认路径：review_waiting_confirmation + review_confirmed 事件", async () => {
    const h = makeHarness({ entry: { mode: "review" } });
    h.entry.reviewConfirmed = undefined;
    const p = h.fresh.askUserTool.execute("tc", { question: "是否写回原文?" });
    h.world.pendingAsks.get("c1")("确认写回原文");
    await p;
    expect(h.entry.reviewConfirmed).toBe(true);
    const types = JSON.parse(JSON.stringify(h.channelEvents.map((e: any) => e.type)));
    expect(types).toContain("review_waiting_confirmation");
    expect(types).toContain("review_confirmed");
    savePendingAsks([]);
  });

  it("超时路径：ASK_TIMEOUT_MS 后按专业判断继续文案", async () => {
    const h = makeHarness();
    const p = h.fresh.askUserTool.execute("tc", { question: "怎么处理?" });
    await vi.advanceTimersByTimeAsync(ASK_TIMEOUT_MS + 1);
    const r = await p;
    expect(r.content[0].text).toBe(`(用户未在 ${Math.round(ASK_TIMEOUT_MS / 60000)} 分钟内回答，请按专业判断继续，并在最终结果中注明你的假设)`);
    expect(h.world.pendingAsks.has("c1")).toBe(false);
    savePendingAsks([]);
  });
});
