// @vitest-environment jsdom
/**
 * F3 批5b-5 对拍：SessionSidebar（侧边栏主组件：项目页/文件页/能力页 + 工作区切换器 +
 * 文件树搜索 + 右键菜单 + 产物弹窗 + 项目历史弹窗 + 设置弹窗组合）。
 *
 * 对拍口径（双侧同流）：
 *   - 旧组件（client/src/components/SessionSidebar.jsx）走 fetch → HTTP API；
 *     新组件（electron/src/renderer/components/SessionSidebar.tsx）走 opDesktop.invoke → IPC 通道。
 *     同一份 DATA 按 (method, path) 路由给两侧，DOM 逐字节一致，调用序列归一化（method + path）
 *     一一对应、body/query 深等。
 *   - 覆盖：初始挂载（项目页）全 DOM + GET /api/file-roots 序列；文件页文件树/排序切换/
 *     changedFiles 徽标/目录导航/@引用；文件搜索防抖（query 深等 + 结果渲染）与工作区不一致
 *     错误分支；右键菜单（存入知识库 op:kb:ingest 成功/失败 + 系统打开 reveal 回调 + 删除）；
 *     工作区切换器（选项切换 + 自定义路径 validate 通过/失败 + pick 成功 + pick 挂起取消）；
 *     外部目录登记/移除；原生文件选择器；产物弹窗全链（runs + acceptance 富化 + published +
 *     人工确认 + 固定成果 + 回滚 + 点击打开）；项目历史弹窗（SessionList 嵌套 + 重命名 + 选择）；
 *     能力页 8 入口回调；设置弹窗组合（嵌套 SettingsPanel 全 DOM + 请求序列）；loadStatus 骨架。
 *
 * 架构性等价替换（BRD-009）：旧组件内联 fetch("/api/kb/ingest") → IPC 通道 op:kb:ingest
 * （HTTP 层 !r.ok 失败形态在 IPC 信封 throw 语义下不存在，data.ok === false 分支保持逐行等价）；
 * 纯函数族（formatTime/shortenCwd/samePath/formatSize/RUNNING_SESSION_STATUSES）复用
 * lib/session-list.ts（旧侧与 SessionList 双份重复定义，等价合并）。
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const TsMod = await import("../src/renderer/components/SessionSidebar");
const JsMod = await import("../../client/src/components/SessionSidebar.jsx");

// 测试边界 props 走 Record 宽容视图（makeProps + overrides 动态构造，JS 边界无静态约束）；
// TS 组件在此降为宽容签名，DOM/请求对拍才是真正的等价门禁
const SessionSidebarTs = TsMod.default as unknown as React.ComponentType<Record<string, unknown>>;
// @ts-expect-error 旧 JS 模块；props 走 Record 宽容视图（JS 边界无静态约束）
const SessionSidebarJs: React.ComponentType<Record<string, unknown>> = JsMod.default;

interface ApiCall { method: string; path: string; body?: unknown; query?: Record<string, string> }

/* ------------------------- 样本数据（双侧共用同一份） ------------------------- */

const MODELS = [
  { id: "deepseek-chat", provider: "deepseek", name: "DeepSeek Chat", contextWindow: 64000, available: true },
  { id: "deepseek-reasoner", provider: "deepseek", name: "DeepSeek Reasoner", contextWindow: 64000, available: false, authError: "凭据失效" },
  { id: "gpt-4o", provider: "openai", name: "GPT-4o", contextWindow: 128000, vision: true }
];

const FILES = [
  { name: "数据.xlsx", size: 1048576, mtime: "2026-10-20T10:00:00.000Z", ext: "xlsx" },
  { name: "报告.docx", size: 2048, mtime: "2026-10-20T09:00:00.000Z", ext: "docx" },
  { name: "子目录", isDir: true, mtime: "2026-10-19T09:00:00.000Z" },
  { name: "成果.pdf", size: 5242880, mtime: "2026-10-18T09:00:00.000Z", ext: "pdf" }
];

const SEARCH_RESULT = {
  workspace: "D:/ws/metro8",
  files: [{ name: "报告.docx", relPath: "docs/报告.docx", size: 2048, mtime: "2026-10-20T09:00:00.000Z", ext: "docx" }]
};

const WORKSPACES = [
  { path: "D:/ws/metro8", name: "城铁工作区" },
  { path: "D:/ws/bus", name: "公交工作区" }
];

const TWO_HOURS_AGO = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
const SESSIONS = [
  { id: "s1", title: "走廊分析", runStatus: "running", mode: "work", cwd: "d:/ws/metro8", projectId: "p1", modified: TWO_HOURS_AGO, threadId: "thr-1", artifactCount: 2 },
  { id: "s2", title: "客流对比", runStatus: "completed", cwd: "D:/ws/metro8", projectId: "p1", modified: TWO_HOURS_AGO },
  { id: "s3", title: "公交线网", runStatus: "idle", cwd: "D:/ws/bus", modified: TWO_HOURS_AGO }
];

const PROJECTS = [
  { id: "p1", name: "城铁 8 号线", type: "交通规划", status: "进行中", rootPath: "D:/ws/metro8", pendingMemoryCount: 2 },
  { id: "p2", name: "公交线网优化", type: "交通规划", status: "待整理", rootPath: "D:/ws/bus" },
  { id: "p3", name: "客流报告", type: "数据分析", status: "已完成", rootPath: "D:/ws/flow", sessionCount: 0 }
];

const RUNS = {
  runs: [
    { id: "run-1", status: "completed", startedAt: "2026-10-20T11:00:00.000Z", finishedAt: "2026-10-20T12:00:00.000Z",
      artifacts: [{ artifactId: "art-1", path: "D:/ws/metro8/报告.docx", acceptanceStatus: "not_checked" }] },
    { id: "run-2", status: "completed", startedAt: "2026-10-20T09:00:00.000Z", finishedAt: "2026-10-20T10:00:00.000Z",
      acceptance: { readyToPublish: true, status: "passed", summary: "自动验收通过",
        // 旧实现的产物级验收按 artifacts[].path 匹配（run 级顶层字段不参与状态判定），readyToPublish 须挂条目上
        artifacts: [{ path: "D:/ws/metro8/数据.xlsx", readyToPublish: true }],
        checks: { structure: { status: "passed" }, content: { status: "passed" }, visual: { status: "passed" }, manual: { status: "pending" } } },
      artifacts: [{ artifactId: "art-2", path: "D:/ws/metro8/数据.xlsx" }] },
    { id: "run-3", status: "completed", startedAt: "2026-10-19T09:00:00.000Z", finishedAt: "2026-10-19T10:00:00.000Z",
      artifacts: [{ artifactId: "art-3", path: "D:/ws/metro8/成果.pdf" }, { artifactId: "art-deleted", path: "D:/ws/metro8/废弃.md", status: "deleted" }] }
  ]
};

const RUN1_ACCEPTANCE = {
  ok: true,
  run: { ...RUNS.runs[0], acceptance: { status: "not_checked", summary: "待人工确认",
    // 验收详情渲染只读按 path 匹配的条目级 checks（run 级顶层 checks 不参与 UI）
    artifacts: [{ path: "D:/ws/metro8/报告.docx",
      checks: { structure: { status: "passed" }, content: { status: "warning" }, visual: { status: "pending" }, manual: { status: "pending" } } }] } }
};

const PUBLISHED = {
  artifacts: [
    // 旧代码 publishedByArtifact 用 Map 构建、重复 artifactId 后者覆盖 → current 记录须放在数组末位
    { id: "pub-0", artifactId: "art-3", path: "D:/ws/metro8/成果.pdf", version: 1, status: "rolled_back", sourceRunId: "run-3-abcdef01" },
    { id: "pub-1", artifactId: "art-3", path: "D:/ws/metro8/成果.pdf", version: 2, status: "current", sourceRunId: "run-3-abcdef12", rollbackTarget: "pub-0", diffSummary: { changeType: "新增" } }
  ]
};

/* ------------------------- 双侧共用路由数据：key = `${method} ${path}` ------------------------- */

function makeData(): Record<string, unknown> {
  return {
    // —— 侧边栏自身路由 ——
    "GET /api/file-roots": { roots: [{ id: "root-1", path: "E:/gis-data", label: "GIS 数据" }] },
    "POST /api/file-roots": { ok: true },
    "DELETE /api/file-roots/root-1": { ok: true },
    "GET /api/files/search": SEARCH_RESULT,
    "POST /api/files/upload": { ok: true, workspace: "D:/ws/metro8" },
    "POST /api/files/delete": { ok: true },
    "POST /api/kb/ingest": { ok: true, mdName: "报告.md" },
    "GET /api/runs": RUNS,
    "GET /api/runs/run-1/acceptance": RUN1_ACCEPTANCE,
    "GET /api/runs/run-3/acceptance": { ok: true },
    "GET /api/artifacts": PUBLISHED,
    "POST /api/runs/run-1/artifacts/art-1/accept": { ok: true },
    "POST /api/runs/run-2/artifacts/art-2/publish": { ok: true },
    "POST /api/artifacts/pub-1/rollback": { ok: true },
    "POST /api/workspace/pick": { ok: true, workspace: "E:/picked-ws" },
    "POST /api/workspace/pick/cancel": { cancelled: true },
    "POST /api/system/pick-files": { ok: true, files: [
      { insideWorkspace: true, name: "报告.docx", path: "D:/ws/metro8/报告.docx" },
      { insideWorkspace: false, name: "外部.pdf", path: "E:/外部.pdf" }
    ] },
    "POST /api/system/open": { opened: "reveal" },
    "POST /api/system/reveal": { ok: true },
    // —— 设置弹窗（嵌套 SettingsPanel）所需路由（与批5b-4 对拍同源）——
    "GET /api/status": { version: "0.11.55", piPackageVersion: "0.85.1", officecli: "officecli v1.2.0" },
    "GET /api/agent/auth": { providers: { anthropic: { masked: "sk-a***tx" }, deepseek: { masked: "dk-9***q1" } }, authErrors: { deepseek: { message: "凭据已过期" } } },
    "GET /api/agent/config-status": { configured: true, source: "managed", modelsConfigured: true, dataDir: "D:/ws/.oaw/pi", storage: {} },
    "GET /api/agent/import-preview": { available: true, credentialCount: 3, sessionCount: 12, providers: [{ id: "anthropic" }, { id: "deepseek" }], sessions: { count: 12 } },
    "GET /api/agent/network-settings": { mode: "direct", noProxy: "localhost,127.0.0.1,::1", hasProxy: false },
    "GET /api/search/settings": { backends: [{ id: "tavily", name: "Tavily" }], settings: { backend: "tavily", searxngUrl: "", state: { tone: "warn", label: "未验证", reason: "尚未测试连通性" } } },
    "GET /api/agent/model-configs": { configs: [{ provider: "deepseek", name: "DeepSeek", api: "openai-completions", baseUrl: "https://api.deepseek.com", enabled: true, keyConfigured: true, models: [{ id: "deepseek-chat", name: "DeepSeek Chat", contextWindow: 64000, vision: false, reasoning: true, enabled: true }] }] },
    "GET /api/agent/provider-catalog": { totalModels: 42, summary: { oauth: 1 }, providers: [], sources: { builtin: { count: 25 }, modelsDev: { count: 17, fetchedAt: "2026-10-19T08:00:00.000Z", status: "fresh" } } },
    "GET /api/agent/diagnostics": { service: { version: "0.11.55", pid: 4242 }, runtime: { health: { status: "idle", message: "" } }, model: { selected: "deepseek/deepseek-chat", selectedInCatalog: true, selectedAvailable: true, authConfigured: true }, authErrors: {}, recentFailures: [] },
    "GET /api/agent/plans": { plans: [] },
    "GET /api/map/settings": { basemaps: { tiandituKey: "tk123***", maptilerKey: "", geoapifyKey: "geo***" } }
  };
}

/* ------------------------- 双侧同流 stub（fetch + opDesktop.invoke） ------------------------- */

const CHANNEL_ROUTES: Record<string, { method: string; path: string }> = {
  // 侧边栏族
  "op:file-roots:list": { method: "GET", path: "/api/file-roots" },
  "op:file-roots:add": { method: "POST", path: "/api/file-roots" },
  "op:file-roots:remove": { method: "DELETE", path: "/api/file-roots" },
  "op:files:search": { method: "GET", path: "/api/files/search" },
  "op:files:upload": { method: "POST", path: "/api/files/upload" },
  "op:files:delete": { method: "POST", path: "/api/files/delete" },
  "op:kb:ingest": { method: "POST", path: "/api/kb/ingest" },
  "op:runs:list": { method: "GET", path: "/api/runs" },
  "op:runs:acceptance": { method: "GET", path: "/api/runs" },
  "op:runs:artifacts:publish": { method: "POST", path: "/api/runs" },
  "op:runs:artifacts:accept": { method: "POST", path: "/api/runs" },
  "op:artifacts:list": { method: "GET", path: "/api/artifacts" },
  "op:artifacts:rollback": { method: "POST", path: "/api/artifacts" },
  "op:workspace:validate": { method: "POST", path: "/api/workspace/validate" },
  "op:workspace:pick": { method: "POST", path: "/api/workspace/pick" },
  "op:workspace:pick:cancel": { method: "POST", path: "/api/workspace/pick/cancel" },
  "op:system:pick-files": { method: "POST", path: "/api/system/pick-files" },
  "op:system:open": { method: "POST", path: "/api/system/open" },
  "op:system:reveal": { method: "POST", path: "/api/system/reveal" },
  // 设置弹窗（嵌套 SettingsPanel）族（与批5b-4 对拍同源）
  "op:status:get": { method: "GET", path: "/api/status" },
  "op:agent:auth:get": { method: "GET", path: "/api/agent/auth" },
  "op:agent:auth:save": { method: "POST", path: "/api/agent/auth" },
  "op:agent:auth:remove": { method: "POST", path: "/api/agent/auth/remove" },
  "op:agent:custom-provider": { method: "POST", path: "/api/agent/custom-provider" },
  "op:agent:config-status": { method: "GET", path: "/api/agent/config-status" },
  "op:agent:plans": { method: "GET", path: "/api/agent/plans" },
  "op:agent:plans:models": { method: "GET", path: "/api/agent/plans/models" },
  "op:agent:plans:apply": { method: "POST", path: "/api/agent/plans/apply" },
  "op:agent:plans:disconnect": { method: "POST", path: "/api/agent/plans/disconnect" },
  "op:agent:import-preview": { method: "GET", path: "/api/agent/import-preview" },
  "op:agent:import-config": { method: "POST", path: "/api/agent/import-config" },
  "op:agent:diagnostics": { method: "GET", path: "/api/agent/diagnostics" },
  "op:agent:network-settings:get": { method: "GET", path: "/api/agent/network-settings" },
  "op:agent:network-settings:save": { method: "PATCH", path: "/api/agent/network-settings" },
  "op:agent:model-configs:list": { method: "GET", path: "/api/agent/model-configs" },
  "op:agent:model-configs:save": { method: "POST", path: "/api/agent/model-configs" },
  "op:agent:model-configs:delete": { method: "DELETE", path: "/api/agent/model-configs" },
  "op:agent:model-configs:fetch-models": { method: "POST", path: "/api/agent/model-configs/fetch-models" },
  "op:agent:provider-catalog": { method: "GET", path: "/api/agent/provider-catalog" },
  "op:agent:provider-catalog:refresh": { method: "POST", path: "/api/agent/provider-catalog/refresh" },
  "op:agent:default-model:set": { method: "POST", path: "/api/agent/default-model" },
  "op:agent:model:probe": { method: "POST", path: "/api/agent/model/probe" },
  "op:agent:permissions:get": { method: "GET", path: "/api/agent/permissions" },
  "op:agent:permissions:rule:remove": { method: "DELETE", path: "/api/agent/permissions/rule" },
  "op:search:settings:get": { method: "GET", path: "/api/search/settings" },
  "op:search:settings:save": { method: "POST", path: "/api/search/settings" },
  "op:search:test": { method: "POST", path: "/api/search/test" },
  "op:map:settings:get": { method: "GET", path: "/api/map/settings" },
  "op:map:settings:save": { method: "POST", path: "/api/map/settings" },
  "op:models:refresh": { method: "POST", path: "/api/models/refresh" },
  "op:projects:create": { method: "POST", path: "/api/projects" },
  "op:projects:update": { method: "PATCH", path: "/api/projects" }
};

function setupParity(opts: { hangPick?: boolean } = {}): { httpCalls: ApiCall[]; ipcCalls: ApiCall[]; data: Record<string, unknown> } {
  const httpCalls: ApiCall[] = [];
  const ipcCalls: ApiCall[] = [];
  const data = makeData();
  const respond = (method: string, path: string, body: unknown): unknown => {
    if (opts.hangPick && path === "/api/workspace/pick") return new Promise<never>(() => {});
    if (path === "/api/workspace/validate") {
      const p = (body as { path?: string })?.path || "";
      return p.includes("bad") ? { ok: false, error: "目录不存在" } : { ok: true };
    }
    return data[`${method} ${path}`] ?? {};
  };
  vi.stubGlobal("fetch", async (path: string | URL, req?: RequestInit) => {
    const url = new URL(String(path), "http://legacy");
    const call: ApiCall = {
      method: req?.method ?? "GET",
      path: url.pathname,
      body: typeof req?.body === "string" ? JSON.parse(req.body) : undefined,
      query: Object.fromEntries(url.searchParams.entries())
    };
    httpCalls.push(call);
    return { ok: true, status: 200, json: async () => respond(call.method, call.path, call.body) };
  });
  (window as unknown as { opDesktop: unknown }).opDesktop = {
    invoke: async (channel: string, payload?: Record<string, unknown>) => {
      const route = CHANNEL_ROUTES[channel] ?? { method: "GET", path: "/__unknown__" };
      const params = (payload?.params ?? {}) as Record<string, string>;
      let routePath = route.path;
      if (channel === "op:file-roots:remove") routePath += `/${encodeURIComponent(params.id ?? "")}`;
      if (channel === "op:runs:acceptance") routePath += `/${encodeURIComponent(params.id ?? "")}/acceptance`;
      if (channel === "op:runs:artifacts:publish") routePath += `/${encodeURIComponent(params.id ?? "")}/artifacts/${encodeURIComponent(params.artifactId ?? "")}/publish`;
      if (channel === "op:runs:artifacts:accept") routePath += `/${encodeURIComponent(params.id ?? "")}/artifacts/${encodeURIComponent(params.artifactId ?? "")}/accept`;
      if (channel === "op:artifacts:rollback") routePath += `/${encodeURIComponent(params.publicationId ?? "")}/rollback`;
      const call: ApiCall = {
        method: route.method,
        path: routePath,
        body: payload?.body,
        query: (payload?.query ?? {}) as Record<string, string>
      };
      ipcCalls.push(call);
      return { ok: true, status: 200, data: respond(call.method, call.path, call.body) };
    }
  };
  return { httpCalls, ipcCalls, data };
}

/* ------------------------- 挂载与交互工具 ------------------------- */

function mount(node: React.ReactNode): { host: HTMLElement; unmount: () => void } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  let root: Root | null = null;
  act(() => {
    root = createRoot(host);
    root.render(node);
  });
  return {
    host,
    unmount: () => {
      const r = root;
      if (r) act(() => { r.unmount(); });
      host.remove();
    }
  };
}

/** 排空微任务 + 宏任务 */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await Promise.resolve();
      await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    });
  }
}

/** 真实等待（文件搜索 180ms 防抖用） */
async function waitMs(ms: number): Promise<void> {
  await act(async () => { await new Promise<void>((resolve) => { setTimeout(resolve, ms); }); });
}

function setInputValue(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function click(el: Element | null | undefined): void {
  act(() => { el?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}

function contextClick(el: Element | null | undefined): void {
  act(() => { el?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 30, clientY: 40 })); });
}

function text(el: Element | null | undefined): string {
  return (el?.textContent ?? "").trim();
}

function buttonByLabel(host: Element | Document, selector: string, label: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll<HTMLButtonElement>(selector)].find((el) => text(el) === label);
}

function callSignature(calls: ApiCall[]): string[] {
  return calls.map((c) => `${c.method} ${c.path}`).sort();
}

/**
 * Logo 渐变 ID 归一化：Logo 组件用 useId() 生成实例级渐变 ID（open-plan-logo-<rN>），
 * A/B 两次独立挂载的 useId 计数必然漂移，属测试基建差异而非迁移逻辑差异；
 * 将两侧的 ID 后缀（定义点 linearGradient id 与引用点 url(#...)）统一归一后比较。
 */
function normalizeLogoIds(html: string): string {
  return html.replace(/open-plan-logo-[A-Za-z0-9]+/g, "open-plan-logo-N");
}

/** DOM 相等断言：失败时给出首个差异位置的两侧片段，避免整页 innerHTML 大段截断 */
function expectSameHtml(actual: string, expected: string, label = "DOM"): void {
  const a = normalizeLogoIds(actual);
  const b = normalizeLogoIds(expected);
  if (a === b) return;
  let i = 0;
  const n = Math.min(a.length, b.length);
  while (i < n && a[i] === b[i]) i++;
  const from = Math.max(0, i - 150);
  throw new Error(
    `${label} 不一致（首个差异位置 ${i}）\n--- 旧(JS) ---\n${b.slice(from, i + 260)}\n--- 新(TS) ---\n${a.slice(from, i + 260)}`
  );
}

let originalAlert: typeof window.alert | null = null;
let originalConfirm: typeof window.confirm | null = null;
let originalPrompt: typeof window.prompt | null = null;

/** 弹窗桩：返回 alert/confirm/prompt 的 mock，便于断言文案与放行结果 */
function stubDialogs(confirmResult = true, promptResult: string | null = "已检查内容、格式和页面显示"): {
  alertMock: ReturnType<typeof vi.fn>;
  confirmMock: ReturnType<typeof vi.fn>;
  promptMock: ReturnType<typeof vi.fn>;
} {
  if (originalAlert === null) originalAlert = window.alert;
  if (originalConfirm === null) originalConfirm = window.confirm;
  if (originalPrompt === null) originalPrompt = window.prompt;
  const alertMock = vi.fn();
  const confirmMock = vi.fn(() => confirmResult);
  const promptMock = vi.fn(() => promptResult);
  (window as unknown as { alert: unknown }).alert = alertMock;
  (window as unknown as { confirm: unknown }).confirm = confirmMock;
  (window as unknown as { prompt: unknown }).prompt = promptMock;
  return { alertMock, confirmMock, promptMock };
}

afterEach(() => {
  if (originalAlert !== null) { (window as unknown as { alert: unknown }).alert = originalAlert; originalAlert = null; }
  if (originalConfirm !== null) { (window as unknown as { confirm: unknown }).confirm = originalConfirm; originalConfirm = null; }
  if (originalPrompt !== null) { (window as unknown as { prompt: unknown }).prompt = originalPrompt; originalPrompt = null; }
  vi.unstubAllGlobals();
  delete (window as unknown as { opDesktop?: unknown }).opDesktop;
  localStorage.clear();
});

type SidebarPropsRecord = Record<string, unknown>;

/** 生成一份全新回调的 props（双侧各自实例，互不串扰） */
function makeProps(overrides: SidebarPropsRecord = {}): SidebarPropsRecord {
  return {
    files: FILES,
    currentName: "报告.docx",
    onOpenFile: vi.fn(),
    onRefreshFiles: vi.fn(),
    onUploaded: vi.fn(),
    projects: PROJECTS,
    currentProjectId: "p1",
    onProjectChange: vi.fn(),
    onProjectUpdated: vi.fn(),
    models: MODELS,
    clientId: "c1",
    threadId: "t1",
    activeModel: "deepseek-chat",
    onModelChange: vi.fn(),
    workspaces: WORKSPACES,
    currentWorkspace: "D:/ws/metro8",
    onWorkspaceChange: vi.fn(),
    currentDir: "",
    onDirChange: vi.fn(),
    onAtMention: vi.fn(),
    sessions: SESSIONS,
    unreadByThread: { "thr-1": 3 },
    onSelectSession: vi.fn(),
    onRefreshSessions: vi.fn(),
    onDeleteSession: vi.fn(),
    onBatchDeleteSession: vi.fn(),
    onRenameSession: vi.fn(),
    onForkSession: vi.fn(),
    onPinSession: vi.fn(),
    onFreezeSession: vi.fn(),
    onOpenSkills: vi.fn(),
    onOpenAgents: vi.fn(),
    onOpenKnowledgeBase: vi.fn(),
    onOpenTemplates: vi.fn(),
    onOpenMap: vi.fn(),
    onOpenTasks: vi.fn(),
    onOpenMcp: vi.fn(),
    onOpenPiPlugins: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenArtifacts: vi.fn(),
    onBeforeOpenModal: vi.fn(),
    onOpenCommandPalette: vi.fn(),
    onToggleTheme: vi.fn(),
    theme: "dark",
    loadStatus: {},
    changedFiles: new Set(["报告.docx"]),
    ...overrides
  };
}

async function mountPair(propsA: SidebarPropsRecord, propsB: SidebarPropsRecord, opts: { hangPick?: boolean } = {}) {
  const { httpCalls, ipcCalls, data } = setupParity(opts);
  const a = mount(<SessionSidebarJs {...propsA} />);
  const b = mount(<SessionSidebarTs {...propsB} />);
  await settle();
  return { a, b, httpCalls, ipcCalls, data };
}

/* ------------------------------- 对拍用例 ------------------------------- */

describe("SessionSidebar 挂载与 client/SessionSidebar.jsx 等价（对拍）", () => {
  it("初始挂载（项目页）：全 DOM 逐字节一致 + 项目卡/会话预览/samePath 归属 + 挂载仅 GET /api/file-roots", async () => {
    const propsA = makeProps();
    const propsB = makeProps();
    const { a, b, httpCalls, ipcCalls } = await mountPair(propsA, propsB);
    try {
      expectSameHtml(b.host.innerHTML, a.host.innerHTML, "B侧DOM");
      // 项目页：3 张项目卡（按类型分两组 optgroup 数据一致），当前项目 active + 会话预览 2 行
      expect(a.host.querySelectorAll(".sidebar-project-card").length).toBe(3);
      expect(a.host.querySelector(".sidebar-project-card.active")).toBeTruthy();
      expect(a.host.querySelectorAll(".project-session-row").length).toBe(2);
      // s1 cwd 传入小写变体 d:/ws/metro8：samePath 归一化后归属 p1（归属逻辑等价）
      expect(text(a.host.querySelector(".sidebar-project-card.active .sidebar-project-count"))).toBe("会话 2");
      // 项目选择器 optgroup 分组
      expect(a.host.querySelectorAll(".project-select optgroup").length).toBe(2);
      // 挂载请求：仅文件根列表
      expect(callSignature(ipcCalls)).toEqual(callSignature(httpCalls));
      expect(new Set(callSignature(httpCalls))).toEqual(new Set(["GET /api/file-roots"]));
      // 文件根渲染
      expect(a.host.querySelectorAll(".external-root-item").length).toBe(0); // 外部目录面板未展开
    } finally {
      a.unmount();
      b.unmount();
    }
  });

  it("loadStatus 骨架：projects/files 加载中渲染 SkeletonRows，DOM 一致", async () => {
    const propsA = makeProps({ projects: [], files: [], loadStatus: { files: "loading", projects: "loading" } });
    const propsB = makeProps({ projects: [], files: [], loadStatus: { files: "loading", projects: "loading" } });
    const { a, b } = await mountPair(propsA, propsB);
    try {
      expect(a.host.querySelectorAll(".sidebar-project-list .oaw-skeleton-row").length).toBe(3);
      expectSameHtml(b.host.innerHTML, a.host.innerHTML, "B侧DOM");
      // 切到文件页 → 文件骨架 4 行
      click(buttonByLabel(a.host, ".sidebar-primary-tabs button", "文件"));
      click(buttonByLabel(b.host, ".sidebar-primary-tabs button", "文件"));
      expect(a.host.querySelectorAll(".files-section .oaw-skeleton-row").length).toBe(4);
      expectSameHtml(b.host.innerHTML, a.host.innerHTML, "B侧DOM");
    } finally {
      a.unmount();
      b.unmount();
    }
  });
});

describe("SessionSidebar 文件页与 client/SessionSidebar.jsx 等价（对拍）", () => {
  it("文件树：排序切换（localStorage 落盘）+ changedFiles 徽标 + 目录导航 + @引用 + 面包屑", async () => {
    const propsA = makeProps();
    const propsB = makeProps();
    const { a, b, httpCalls, ipcCalls } = await mountPair(propsA, propsB);
    try {
      click(buttonByLabel(a.host, ".sidebar-primary-tabs button", "文件"));
      click(buttonByLabel(b.host, ".sidebar-primary-tabs button", "文件"));
      // 文件树渲染：4 条 + changed 徽标（报告.docx 在 changedFiles 中）
      const rowA = () => [...a.host.querySelectorAll<HTMLElement>(".files-section .file-item")];
      expect(rowA().length).toBe(4);
      expect(rowA().find((row) => text(row.querySelector(".file-name")) === "报告.docx")?.className).toContain("changed");
      expect(rowA().find((row) => text(row.querySelector(".file-name")) === "数据.xlsx")?.className).not.toContain("changed");
      expectSameHtml(b.host.innerHTML, a.host.innerHTML, "B侧DOM");
      // 排序切换：time → type，localStorage 落盘一致
      click(a.host.querySelector(".section-sort"));
      click(b.host.querySelector(".section-sort"));
      expect(text(a.host.querySelector(".section-sort-text"))).toBe("类型");
      expect(localStorage.getItem("oaw_file_sort")).toBe("type");
      expectSameHtml(b.host.innerHTML, a.host.innerHTML, "B侧DOM");
      // 目录导航：点击目录行 → onDirChange("子目录")，双侧行为一致
      click(rowA().find((row) => text(row.querySelector(".file-name")) === "子目录"));
      const rowB = () => [...b.host.querySelectorAll<HTMLElement>(".files-section .file-item")];
      click(rowB().find((row) => text(row.querySelector(".file-name")) === "子目录"));
      expect((propsA.onDirChange as ReturnType<typeof vi.fn>).mock.calls).toEqual([["子目录"]]);
      expect((propsB.onDirChange as ReturnType<typeof vi.fn>).mock.calls).toEqual([["子目录"]]);
      // 文件行点击 → onOpenFile(名称)
      click(rowA()[0]);
      click(rowB()[0]);
      expect((propsA.onOpenFile as ReturnType<typeof vi.fn>).mock.calls).toEqual((propsB.onOpenFile as ReturnType<typeof vi.fn>).mock.calls);
      // @ 引用按钮
      click(rowA()[0]!.querySelector(".file-at"));
      click(rowB()[0]!.querySelector(".file-at"));
      expect((propsA.onAtMention as ReturnType<typeof vi.fn>).mock.calls).toEqual((propsB.onAtMention as ReturnType<typeof vi.fn>).mock.calls);
      // 面包屑：currentDir=sub → crumb-bar；上一级 → onDirChange("") + 清空搜索词
      const propsA2 = makeProps({ currentDir: "sub" });
      const propsB2 = makeProps({ currentDir: "sub" });
      const pair2 = await mountPair(propsA2, propsB2);
      try {
        click(buttonByLabel(pair2.a.host, ".sidebar-primary-tabs button", "文件"));
        click(buttonByLabel(pair2.b.host, ".sidebar-primary-tabs button", "文件"));
        expect(text(pair2.a.host.querySelector(".crumb-path"))).toBe("/sub");
        click(buttonByLabel(pair2.a.host, ".crumb-bar button", "← 上一级"));
        click(buttonByLabel(pair2.b.host, ".crumb-bar button", "← 上一级"));
        expect((propsA2.onDirChange as ReturnType<typeof vi.fn>).mock.calls).toEqual([[""]]);
        expect((propsB2.onDirChange as ReturnType<typeof vi.fn>).mock.calls).toEqual([[""]]);
        expectSameHtml(pair2.b.host.innerHTML, pair2.a.host.innerHTML, "pair2DOM");
      } finally {
        pair2.a.unmount();
        pair2.b.unmount();
      }
      // 双侧请求序列一致（含 sort 之后的 file-roots 刷新无新增）
      expect(callSignature(ipcCalls)).toEqual(callSignature(httpCalls));
    } finally {
      a.unmount();
      b.unmount();
    }
  });

  it("文件搜索：防抖后 GET query 深等（q/limit/workspace）+ 结果渲染 path 提示 + 清除恢复", async () => {
    const propsA = makeProps();
    const propsB = makeProps();
    const { a, b, httpCalls, ipcCalls } = await mountPair(propsA, propsB);
    try {
      click(buttonByLabel(a.host, ".sidebar-primary-tabs button", "文件"));
      click(buttonByLabel(b.host, ".sidebar-primary-tabs button", "文件"));
      const inputA = a.host.querySelector<HTMLInputElement>(".file-search input")!;
      const inputB = b.host.querySelector<HTMLInputElement>(".file-search input")!;
      setInputValue(inputA, "报告");
      setInputValue(inputB, "报告");
      await waitMs(260);
      await settle();
      const httpSearch = httpCalls.find((c) => c.path === "/api/files/search");
      const ipcSearch = ipcCalls.find((c) => c.path === "/api/files/search");
      expect(httpSearch?.query).toEqual({ q: "报告", limit: "200", workspace: "D:/ws/metro8" });
      // 线上形态对齐（buildQueryString 对信封 query 统一 String()，对齐批5b-2 assertParity 约定）
      expect(Object.fromEntries(Object.entries((ipcSearch?.query ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)]))).toEqual(httpSearch?.query);
      // 结果渲染：1 条 + path 提示（relPath）
      expect(a.host.querySelectorAll(".files-section .file-item").length).toBe(1);
      expect(text(a.host.querySelector(".file-path-hint"))).toBe("docs/报告.docx");
      expectSameHtml(b.host.innerHTML, a.host.innerHTML, "B侧DOM");
      // 清除按钮 → 搜索词清空、结果复位、树恢复 files
      click(a.host.querySelector(".file-search-clear"));
      click(b.host.querySelector(".file-search-clear"));
      expect(a.host.querySelectorAll(".files-section .file-item").length).toBe(4);
      expectSameHtml(b.host.innerHTML, a.host.innerHTML, "B侧DOM");
    } finally {
      a.unmount();
      b.unmount();
    }
  });

  it("文件搜索：结果工作区与当前不一致 → 错误文案分支一致，结果置空", async () => {
    const propsA = makeProps({ currentWorkspace: "D:/ws/other" });
    const propsB = makeProps({ currentWorkspace: "D:/ws/other" });
    const { a, b } = await mountPair(propsA, propsB);
    try {
      click(buttonByLabel(a.host, ".sidebar-primary-tabs button", "文件"));
      click(buttonByLabel(b.host, ".sidebar-primary-tabs button", "文件"));
      setInputValue(a.host.querySelector<HTMLInputElement>(".file-search input")!, "报告");
      setInputValue(b.host.querySelector<HTMLInputElement>(".file-search input")!, "报告");
      await waitMs(260);
      await settle();
      expect(text(a.host.querySelector(".file-search-status.error"))).toBe("搜索来源与当前工作区不一致（D:/ws/metro8）");
      expect(a.host.querySelectorAll(".files-section .file-item").length).toBe(0);
      expectSameHtml(b.host.innerHTML, a.host.innerHTML, "B侧DOM");
    } finally {
      a.unmount();
      b.unmount();
    }
  });

  it("外部目录：登记 body 深等 + 列表渲染 + 移除 DELETE 路由参数一致", async () => {
    const propsA = makeProps();
    const propsB = makeProps();
    const { a, b, httpCalls, ipcCalls } = await mountPair(propsA, propsB);
    try {
      click(buttonByLabel(a.host, ".sidebar-primary-tabs button", "文件"));
      click(buttonByLabel(b.host, ".sidebar-primary-tabs button", "文件"));
      click(buttonByLabel(a.host, ".sidebar-root-btn", "外部目录"));
      click(buttonByLabel(b.host, ".sidebar-root-btn", "外部目录"));
      // 已登记列表渲染
      expect(a.host.querySelectorAll(".external-root-item").length).toBe(1);
      expect(text(a.host.querySelector(".external-root-item span"))).toBe("GIS 数据");
      expectSameHtml(b.host.innerHTML, a.host.innerHTML, "B侧DOM");
      // 登记：输入路径 → POST /api/file-roots body {path}
      setInputValue(a.host.querySelector<HTMLInputElement>(".external-root-form input")!, "E:/new-data");
      setInputValue(b.host.querySelector<HTMLInputElement>(".external-root-form input")!, "E:/new-data");
      click(buttonByLabel(a.host, ".external-root-form button", "登记"));
      click(buttonByLabel(b.host, ".external-root-form button", "登记"));
      await settle();
      const httpAdd = httpCalls.find((c) => c.method === "POST" && c.path === "/api/file-roots");
      const ipcAdd = ipcCalls.find((c) => c.method === "POST" && c.path === "/api/file-roots");
      expect(httpAdd?.body).toEqual({ path: "E:/new-data" });
      expect(ipcAdd?.body).toEqual(httpAdd?.body);
      // 移除：DELETE /api/file-roots/root-1（路径参数双侧一致）+ 刷新
      click(a.host.querySelector(".external-root-item .btn-icon.danger"));
      click(b.host.querySelector(".external-root-item .btn-icon.danger"));
      await settle();
      expect(httpCalls.filter((c) => c.method === "DELETE" && c.path === "/api/file-roots/root-1").length).toBe(1);
      expect(ipcCalls.filter((c) => c.method === "DELETE" && c.path === "/api/file-roots/root-1").length).toBe(1);
      expect(callSignature(ipcCalls)).toEqual(callSignature(httpCalls));
      expectSameHtml(b.host.innerHTML, a.host.innerHTML, "B侧DOM");
    } finally {
      a.unmount();
      b.unmount();
    }
  });

  it("右键菜单：docx 菜单含存入知识库；系统打开 reveal → onRefreshFiles；删除 confirm+body 深等", async () => {
    const { alertMock, confirmMock } = stubDialogs(true);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
    const propsA = makeProps();
    const propsB = makeProps();
    const { a, b, httpCalls, ipcCalls } = await mountPair(propsA, propsB);
    try {
      click(buttonByLabel(a.host, ".sidebar-primary-tabs button", "文件"));
      click(buttonByLabel(b.host, ".sidebar-primary-tabs button", "文件"));
      const rowA = () => [...a.host.querySelectorAll<HTMLElement>(".files-section .file-item")];
      const rowB = () => [...b.host.querySelectorAll<HTMLElement>(".files-section .file-item")];
      const docxRowA = rowA().find((row) => text(row.querySelector(".file-name")) === "报告.docx")!;
      const docxRowB = rowB().find((row) => text(row.querySelector(".file-name")) === "报告.docx")!;
      // docx 右键 → 菜单含「存入知识库」（ext 分支）
      contextClick(docxRowA);
      contextClick(docxRowB);
      expect(a.host.querySelectorAll(".context-menu-item").length).toBe(6);
      expect(buttonByLabel(a.host, ".context-menu-item", "存入知识库")).toBeTruthy();
      expectSameHtml(b.host.innerHTML, a.host.innerHTML, "B侧DOM");
      // 用系统默认应用打开 → POST /api/system/open body {path} → opened=reveal → onRefreshFiles
      click(buttonByLabel(a.host, ".context-menu-item", "用系统默认应用打开"));
      click(buttonByLabel(b.host, ".context-menu-item", "用系统默认应用打开"));
      await settle();
      const httpOpen = httpCalls.find((c) => c.path === "/api/system/open");
      const ipcOpen = ipcCalls.find((c) => c.path === "/api/system/open");
      expect(httpOpen?.body).toEqual({ path: "报告.docx" });
      expect(ipcOpen?.body).toEqual(httpOpen?.body);
      expect((propsA.onRefreshFiles as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
      expect((propsB.onRefreshFiles as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
      expectSameHtml(b.host.innerHTML, a.host.innerHTML, "B侧DOM");
      // 删除：confirm 文案 + POST /api/files/delete body 深等
      contextClick(docxRowA);
      contextClick(docxRowB);
      click(buttonByLabel(a.host, ".context-menu-item", "删除"));
      click(buttonByLabel(b.host, ".context-menu-item", "删除"));
      await settle();
      expect(confirmMock.mock.calls).toEqual([["删除 报告.docx ?"], ["删除 报告.docx ?"]]);
      const httpDel = httpCalls.find((c) => c.path === "/api/files/delete");
      const ipcDel = ipcCalls.find((c) => c.path === "/api/files/delete");
      expect(httpDel?.body).toEqual({ name: "报告.docx", workspace: "D:/ws/metro8" });
      expect(ipcDel?.body).toEqual(httpDel?.body);
      expectSameHtml(b.host.innerHTML, a.host.innerHTML, "B侧DOM");
    } finally {
      a.unmount();
      b.unmount();
    }
  });

  it("存入知识库（op:kb:ingest）：成功 alert 携带 mdName + 失败分支 alert 错误文案，body 深等", async () => {
    const { alertMock } = stubDialogs(true);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
    const propsA = makeProps();
    const propsB = makeProps();
    const { a, b, httpCalls, ipcCalls, data } = await mountPair(propsA, propsB);
    try {
      click(buttonByLabel(a.host, ".sidebar-primary-tabs button", "文件"));
      click(buttonByLabel(b.host, ".sidebar-primary-tabs button", "文件"));
      const docxRowA = [...a.host.querySelectorAll<HTMLElement>(".files-section .file-item")].find((row) => text(row.querySelector(".file-name")) === "报告.docx")!;
      const docxRowB = [...b.host.querySelectorAll<HTMLElement>(".files-section .file-item")].find((row) => text(row.querySelector(".file-name")) === "报告.docx")!;
      contextClick(docxRowA);
      contextClick(docxRowB);
      click(buttonByLabel(a.host, ".context-menu-item", "存入知识库"));
      click(buttonByLabel(b.host, ".context-menu-item", "存入知识库"));
      await settle();
      // 确认文案一致（两次：JS 侧 + TS 侧）
      expect(alertMock).toHaveBeenNthCalledWith(1, "已存入知识库：报告.md");
      expect(alertMock).toHaveBeenNthCalledWith(2, "已存入知识库：报告.md");
      const httpIngest = httpCalls.find((c) => c.path === "/api/kb/ingest");
      const ipcIngest = ipcCalls.find((c) => c.path === "/api/kb/ingest");
      expect(httpIngest?.body).toEqual({ name: "报告.docx" });
      expect(ipcIngest?.body).toEqual(httpIngest?.body);
      // 失败分支：data.ok=false → 错误文案 alert
      data["POST /api/kb/ingest"] = { ok: false, error: "转换失败" };
      contextClick(docxRowA);
      contextClick(docxRowB);
      click(buttonByLabel(a.host, ".context-menu-item", "存入知识库"));
      click(buttonByLabel(b.host, ".context-menu-item", "存入知识库"));
      await settle();
      expect(alertMock).toHaveBeenNthCalledWith(3, "存入失败: 转换失败");
      expect(alertMock).toHaveBeenNthCalledWith(4, "存入失败: 转换失败");
    } finally {
      a.unmount();
      b.unmount();
    }
  });

  it("原生文件选择器：pick-files body 深等 + 工作区内文件 onOpenFile + 多文件成功文案", async () => {
    const { alertMock } = stubDialogs(true);
    const propsA = makeProps();
    const propsB = makeProps();
    const { a, b, httpCalls, ipcCalls } = await mountPair(propsA, propsB);
    try {
      click(buttonByLabel(a.host, ".sidebar-primary-tabs button", "文件"));
      click(buttonByLabel(b.host, ".sidebar-primary-tabs button", "文件"));
      click(a.host.querySelector(".section-pick-native"));
      click(b.host.querySelector(".section-pick-native"));
      await settle();
      const httpPick = httpCalls.find((c) => c.path === "/api/system/pick-files");
      const ipcPick = ipcCalls.find((c) => c.path === "/api/system/pick-files");
      expect(httpPick?.body).toEqual({ multiple: true, prompt: "选择要打开的文件" });
      expect(ipcPick?.body).toEqual(httpPick?.body);
      // 第 1 个文件在工作区内 → onOpenFile(name)；2 个文件 → 成功提示
      expect((propsA.onOpenFile as ReturnType<typeof vi.fn>).mock.calls).toEqual([["报告.docx"]]);
      expect((propsB.onOpenFile as ReturnType<typeof vi.fn>).mock.calls).toEqual([["报告.docx"]]);
      expect(alertMock).toHaveBeenNthCalledWith(1, "已选中 2 个文件，先处理了第 1 个：报告.docx");
      expect(alertMock).toHaveBeenNthCalledWith(2, "已选中 2 个文件，先处理了第 1 个：报告.docx");
    } finally {
      a.unmount();
      b.unmount();
    }
  });
});

describe("SessionSidebar 工作区切换器与 client/SessionSidebar.jsx 等价（对拍）", () => {
  it("切换器：项目/工作区选项渲染 + 选项点击回调 + 自定义目录 validate 通过", async () => {
    const propsA = makeProps();
    const propsB = makeProps();
    const { a, b, httpCalls, ipcCalls } = await mountPair(propsA, propsB);
    try {
      click(a.host.querySelector(".workspace-switcher-trigger"));
      click(b.host.querySelector(".workspace-switcher-trigger"));
      // 项目区：2 个类型分组 + 3 个项目选项；工作区区：2 个目录 + 自定义入口
      expect(a.host.querySelectorAll(".workspace-switcher-option").length).toBe(5);
      expect(a.host.querySelectorAll(".workspace-switcher-type").length).toBe(2);
      expectSameHtml(b.host.innerHTML, a.host.innerHTML, "B侧DOM");
      // 点击工作区选项 → onWorkspaceChange(path) + 关闭
      const wsOptionA = [...a.host.querySelectorAll<HTMLElement>(".workspace-switcher-option")].find((el) => text(el).includes("公交工作区"))!;
      const wsOptionB = [...b.host.querySelectorAll<HTMLElement>(".workspace-switcher-option")].find((el) => text(el).includes("公交工作区"))!;
      click(wsOptionA);
      click(wsOptionB);
      expect((propsA.onWorkspaceChange as ReturnType<typeof vi.fn>).mock.calls).toEqual([["D:/ws/bus"]]);
      expect((propsB.onWorkspaceChange as ReturnType<typeof vi.fn>).mock.calls).toEqual([["D:/ws/bus"]]);
      expect(a.host.querySelector(".workspace-switcher-backdrop")).toBeNull();
      expectSameHtml(b.host.innerHTML, a.host.innerHTML, "B侧DOM");
      // 自定义目录：打开切换器 → 打开自定义目录 → 输入路径 → 打开（validate ok）→ onWorkspaceChange
      click(a.host.querySelector(".workspace-switcher-trigger"));
      click(b.host.querySelector(".workspace-switcher-trigger"));
      click(buttonByLabel(a.host, ".workspace-switcher-custom", "打开自定义目录"));
      click(buttonByLabel(b.host, ".workspace-switcher-custom", "打开自定义目录"));
      setInputValue(a.host.querySelector<HTMLInputElement>(".workspace-switcher-custom-form input")!, "F:/work/docs");
      setInputValue(b.host.querySelector<HTMLInputElement>(".workspace-switcher-custom-form input")!, "F:/work/docs");
      click(buttonByLabel(a.host, ".workspace-switcher-custom-form button", "打开"));
      click(buttonByLabel(b.host, ".workspace-switcher-custom-form button", "打开"));
      await settle();
      const httpValidate = httpCalls.find((c) => c.path === "/api/workspace/validate");
      const ipcValidate = ipcCalls.find((c) => c.path === "/api/workspace/validate");
      expect(httpValidate?.body).toEqual({ path: "F:/work/docs" });
      expect(ipcValidate?.body).toEqual(httpValidate?.body);
      expect((propsA.onWorkspaceChange as ReturnType<typeof vi.fn>).mock.calls).toEqual([["D:/ws/bus"], ["F:/work/docs"]]);
      expect((propsB.onWorkspaceChange as ReturnType<typeof vi.fn>).mock.calls).toEqual([["D:/ws/bus"], ["F:/work/docs"]]);
      expect(a.host.querySelector(".workspace-switcher-backdrop")).toBeNull();
      expectSameHtml(b.host.innerHTML, a.host.innerHTML, "B侧DOM");
    } finally {
      a.unmount();
      b.unmount();
    }
  });

  it("自定义目录 validate 失败：错误文案一致 + 不触发 onWorkspaceChange", async () => {
    const { alertMock } = stubDialogs(true);
    const propsA = makeProps();
    const propsB = makeProps();
    const { a, b } = await mountPair(propsA, propsB);
    try {
      click(a.host.querySelector(".workspace-switcher-trigger"));
      click(b.host.querySelector(".workspace-switcher-trigger"));
      click(buttonByLabel(a.host, ".workspace-switcher-custom", "打开自定义目录"));
      click(buttonByLabel(b.host, ".workspace-switcher-custom", "打开自定义目录"));
      setInputValue(a.host.querySelector<HTMLInputElement>(".workspace-switcher-custom-form input")!, "D:/bad/path");
      setInputValue(b.host.querySelector<HTMLInputElement>(".workspace-switcher-custom-form input")!, "D:/bad/path");
      click(buttonByLabel(a.host, ".workspace-switcher-custom-form button", "打开"));
      click(buttonByLabel(b.host, ".workspace-switcher-custom-form button", "打开"));
      await settle();
      expect(alertMock).toHaveBeenNthCalledWith(1, "无法将此目录用作可写工作区：目录不存在");
      expect(alertMock).toHaveBeenNthCalledWith(2, "无法将此目录用作可写工作区：目录不存在");
      expect((propsA.onWorkspaceChange as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
      expect((propsB.onWorkspaceChange as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
      expect(a.host.querySelector(".workspace-switcher-backdrop")).toBeTruthy();
      expectSameHtml(b.host.innerHTML, a.host.innerHTML, "B侧DOM");
    } finally {
      a.unmount();
      b.unmount();
    }
  });

  it("系统文件夹选择：pick 成功 → customPath 填充 + onWorkspaceChange + 对话框关闭", async () => {
    const propsA = makeProps();
    const propsB = makeProps();
    const { a, b, httpCalls, ipcCalls } = await mountPair(propsA, propsB);
    try {
      click(a.host.querySelector(".workspace-switcher-trigger"));
      click(b.host.querySelector(".workspace-switcher-trigger"));
      click(buttonByLabel(a.host, ".workspace-switcher-custom", "打开自定义目录"));
      click(buttonByLabel(b.host, ".workspace-switcher-custom", "打开自定义目录"));
      // 等待提示出现（pick 打开中）
      click(buttonByLabel(a.host, ".workspace-switcher-custom-form button", "选择文件夹"));
      click(buttonByLabel(b.host, ".workspace-switcher-custom-form button", "选择文件夹"));
      await settle();
      const httpPick = httpCalls.find((c) => c.path === "/api/workspace/pick");
      const ipcPick = ipcCalls.find((c) => c.path === "/api/workspace/pick");
      expect(httpPick?.body).toEqual({});
      expect(ipcPick?.body).toEqual(httpPick?.body);
      // pick ok → customPath 填充 + onWorkspaceChange(E:/picked-ws) + customMode/switcher 关闭
      expect((propsA.onWorkspaceChange as ReturnType<typeof vi.fn>).mock.calls).toEqual([["E:/picked-ws"]]);
      expect((propsB.onWorkspaceChange as ReturnType<typeof vi.fn>).mock.calls).toEqual([["E:/picked-ws"]]);
      expect(a.host.querySelector(".workspace-switcher-backdrop")).toBeNull();
      expectSameHtml(b.host.innerHTML, a.host.innerHTML, "B侧DOM");
    } finally {
      a.unmount();
      b.unmount();
    }
  });

  it("系统文件夹选择挂起：等待提示 + 取消等待 → pick/cancel 通道 + 提示文案一致", async () => {
    const propsA = makeProps();
    const propsB = makeProps();
    const { a, b, httpCalls, ipcCalls } = await mountPair(propsA, propsB, { hangPick: true });
    try {
      click(a.host.querySelector(".workspace-switcher-trigger"));
      click(b.host.querySelector(".workspace-switcher-trigger"));
      click(buttonByLabel(a.host, ".workspace-switcher-custom", "打开自定义目录"));
      click(buttonByLabel(b.host, ".workspace-switcher-custom", "打开自定义目录"));
      click(buttonByLabel(a.host, ".workspace-switcher-custom-form button", "选择文件夹"));
      click(buttonByLabel(b.host, ".workspace-switcher-custom-form button", "选择文件夹"));
      // 挂起中：等待提示可见
      expect(text(a.host.querySelector(".workspace-switcher-custom-form .workspace-pick-notice span"))).toContain("已打开系统文件夹对话框");
      expectSameHtml(b.host.innerHTML, a.host.innerHTML, "B侧DOM");
      // 取消等待 → POST /api/workspace/pick/cancel → 文案
      click(buttonByLabel(a.host, ".workspace-switcher-custom-form .workspace-pick-notice button", "取消等待"));
      click(buttonByLabel(b.host, ".workspace-switcher-custom-form .workspace-pick-notice button", "取消等待"));
      await settle();
      expect(ipcCalls.some((c) => c.method === "POST" && c.path === "/api/workspace/pick/cancel")).toBe(true);
      expect(httpCalls.some((c) => c.method === "POST" && c.path === "/api/workspace/pick/cancel")).toBe(true);
      expect(text(a.host.querySelector(".workspace-switcher-custom-form .workspace-pick-notice span"))).toBe("已取消等待，系统对话框已关闭。");
      expectSameHtml(b.host.innerHTML, a.host.innerHTML, "B侧DOM");
    } finally {
      a.unmount();
      b.unmount();
    }
  });
});

describe("SessionSidebar 产物弹窗与 client/SessionSidebar.jsx 等价（对拍）", () => {
  it("产物弹窗：runs+published 加载链 + acceptance 富化 + 三种状态卡 + 历史版本 + 回滚", async () => {
    const { confirmMock } = stubDialogs(true);
    const propsA = makeProps({ onOpenArtifacts: undefined });
    const propsB = makeProps({ onOpenArtifacts: undefined });
    const { a, b, httpCalls, ipcCalls } = await mountPair(propsA, propsB);
    try {
      click(a.host.querySelectorAll(".sidebar-bottom-tabs .bt-btn")[0]);
      click(b.host.querySelectorAll(".sidebar-bottom-tabs .bt-btn")[0]);
      await settle();
      // 加载链：runs + artifacts + acceptance 富化（run-1/run-3 无 run 级 acceptance → 补拉；run-2 跳过）
      expect(httpCalls.filter((c) => c.path === "/api/runs/run-1/acceptance").length).toBe(1);
      expect(httpCalls.filter((c) => c.path === "/api/runs/run-3/acceptance").length).toBe(1);
      expect(callSignature(ipcCalls)).toEqual(callSignature(httpCalls));
      // 弹窗标题：成果（3）（deleted 产物被过滤）
      expect(text(a.host.querySelector(".sb-modal-title"))).toBe("成果（3）");
      // 三种状态：art-1 待人工确认（含人工确认按钮 + 验收详情）、art-2 验收通过·待固定（固定成果按钮）、art-3 v2 已固定
      const rowsA = () => [...a.host.querySelectorAll<HTMLElement>(".sb-modal .artifact-item")];
      expect(rowsA().length).toBe(3);
      expect(text(rowsA()[0]!.querySelector(".artifact-status"))).toBe("待人工确认");
      expect(buttonByLabel(rowsA()[0]!, "button", "人工确认")).toBeTruthy();
      expect(text(rowsA()[1]!.querySelector(".artifact-status"))).toBe("验收通过·待固定");
      expect(buttonByLabel(rowsA()[1]!, "button", "固定成果")).toBeTruthy();
      expect(text(rowsA()[2]!.querySelector(".artifact-status"))).toBe("v2 已固定");
      // 验收详情（checks 四项）
      expect(text(rowsA()[0]!.querySelector(".artifact-acceptance-details"))).toContain("结构：passed");
      expect(text(rowsA()[0]!.querySelector(".artifact-acceptance-details"))).toContain("人工：pending");
      // 历史版本：2 行（数组序 = 服务端返回序）+ pub-1 有回滚按钮
      expect(a.host.querySelectorAll(".artifact-history-row").length).toBe(2);
      expect(text(a.host.querySelectorAll(".artifact-history-row")[0]!)).toContain("v1 · 修改 · Run abcdef01 · 已回滚");
      expect(buttonByLabel(a.host.querySelectorAll(".artifact-history-row")[0]!, "button", "回滚")).toBeUndefined();
      expect(text(a.host.querySelectorAll(".artifact-history-row")[1]!)).toContain("v2 · 新增 · Run abcdef12 · 当前版本");
      expect(buttonByLabel(a.host.querySelectorAll(".artifact-history-row")[1]!, "button", "回滚")).toBeTruthy();
      expectSameHtml(b.host.innerHTML, a.host.innerHTML, "B侧DOM");
      // 人工确认：prompt 说明 → accept body 深等 + 清单重刷
      click(buttonByLabel(rowsA()[0]!, "button", "人工确认"));
      const rowsB = () => [...b.host.querySelectorAll<HTMLElement>(".sb-modal .artifact-item")];
      click(buttonByLabel(rowsB()[0]!, "button", "人工确认"));
      await settle();
      const httpAccept = httpCalls.find((c) => c.path === "/api/runs/run-1/artifacts/art-1/accept");
      const ipcAccept = ipcCalls.find((c) => c.path === "/api/runs/run-1/artifacts/art-1/accept");
      expect(httpAccept?.body).toEqual({ note: "已检查内容、格式和页面显示" });
      expect(ipcAccept?.body).toEqual(httpAccept?.body);
      // 固定成果：publish body {}
      click(buttonByLabel(rowsA()[1]!, "button", "固定成果"));
      click(buttonByLabel(rowsB()[1]!, "button", "固定成果"));
      await settle();
      const httpPublish = httpCalls.find((c) => c.path === "/api/runs/run-2/artifacts/art-2/publish");
      const ipcPublish = ipcCalls.find((c) => c.path === "/api/runs/run-2/artifacts/art-2/publish");
      expect(httpPublish?.body).toEqual({});
      expect(ipcPublish?.body).toEqual(httpPublish?.body);
      // 回滚：confirm 文案 + rollback body {confirm:true}（回滚按钮在 pub-1 行）
      click(buttonByLabel(a.host.querySelectorAll(".artifact-history-row")[1]!, "button", "回滚"));
      click(buttonByLabel(b.host.querySelectorAll(".artifact-history-row")[1]!, "button", "回滚"));
      await settle();
      expect(confirmMock).toHaveBeenNthCalledWith(1, "确认将 D:/ws/metro8/成果.pdf 回滚到 v1？");
      expect(confirmMock).toHaveBeenNthCalledWith(2, "确认将 D:/ws/metro8/成果.pdf 回滚到 v1？");
      const httpRollback = httpCalls.find((c) => c.path === "/api/artifacts/pub-1/rollback");
      const ipcRollback = ipcCalls.find((c) => c.path === "/api/artifacts/pub-1/rollback");
      expect(httpRollback?.body).toEqual({ confirm: true });
      expect(ipcRollback?.body).toEqual(httpRollback?.body);
      expectSameHtml(b.host.innerHTML, a.host.innerHTML, "B侧DOM");
      // 点击产物行 → onOpenFile(item.path) + 弹窗关闭
      click(rowsA()[2]);
      click(rowsB()[2]);
      expect((propsA.onOpenFile as ReturnType<typeof vi.fn>).mock.calls).toEqual([["D:/ws/metro8/成果.pdf"]]);
      expect((propsB.onOpenFile as ReturnType<typeof vi.fn>).mock.calls).toEqual([["D:/ws/metro8/成果.pdf"]]);
      expect(a.host.querySelector(".sb-modal")).toBeNull();
      expectSameHtml(b.host.innerHTML, a.host.innerHTML, "B侧DOM");
    } finally {
      a.unmount();
      b.unmount();
    }
  });
});

describe("SessionSidebar 弹窗组合与回调入口与 client/SessionSidebar.jsx 等价（对拍）", () => {
  it("项目历史弹窗：SessionList 嵌套 DOM 一致 + 重命名回调 + 选择会话回调", async () => {
    const propsA = makeProps();
    const propsB = makeProps();
    const { a, b } = await mountPair(propsA, propsB);
    try {
      // 项目页 → 当前项目卡「查看全部」→ 历史弹窗
      click(buttonByLabel(a.host, ".project-session-preview-head button", "查看全部"));
      click(buttonByLabel(b.host, ".project-session-preview-head button", "查看全部"));
      expect(text(a.host.querySelector(".sb-modal-title"))).toBe("城铁 8 号线 · 会话历史");
      expect(text(a.host.querySelector(".sb-modal-sub"))).toBe("共 2 个，会话可独立切换、分支和恢复");
      expect(a.host.querySelectorAll(".sb-modal .session-item").length).toBe(2);
      expectSameHtml(b.host.innerHTML, a.host.innerHTML, "B侧DOM");
      // 编辑会话名称：preview 行的编辑按钮 → initialEditingId → 重命名输入预填
      click(a.host.querySelector(".project-session-row .project-session-edit"));
      click(b.host.querySelector(".project-session-row .project-session-edit"));
      expect(a.host.querySelector<HTMLInputElement>(".sb-modal .rename-input")!.value).toBe("走廊分析");
      setInputValue(a.host.querySelector<HTMLInputElement>(".sb-modal .rename-input")!, "走廊分析（改名）");
      setInputValue(b.host.querySelector<HTMLInputElement>(".sb-modal .rename-input")!, "走廊分析（改名）");
      click(a.host.querySelector(".sb-modal .session-rename .btn-xs"));
      click(b.host.querySelector(".sb-modal .session-rename .btn-xs"));
      await settle();
      expect((propsA.onRenameSession as ReturnType<typeof vi.fn>).mock.calls).toEqual([["s1", "走廊分析（改名）"]]);
      expect((propsB.onRenameSession as ReturnType<typeof vi.fn>).mock.calls).toEqual([["s1", "走廊分析（改名）"]]);
      // 选择会话：点击会话行 → 弹窗关闭 + onSelectSession(session)
      click(a.host.querySelector(".sb-modal .session-item"));
      click(b.host.querySelector(".sb-modal .session-item"));
      expect(a.host.querySelector(".sb-modal")).toBeNull();
      const pickedA = (propsA.onSelectSession as ReturnType<typeof vi.fn>).mock.calls;
      const pickedB = (propsB.onSelectSession as ReturnType<typeof vi.fn>).mock.calls;
      expect(pickedB).toEqual(pickedA);
      expect(pickedA.length).toBe(1);
      expect((pickedA[0]![0] as { id: string }).id).toBe("s1");
      expectSameHtml(b.host.innerHTML, a.host.innerHTML, "B侧DOM");
    } finally {
      a.unmount();
      b.unmount();
    }
  });

  it("能力页 8 入口 + 底部产物/设置回调入口 + 项目上下条记忆按钮", async () => {
    const propsA = makeProps();
    const propsB = makeProps();
    const { a, b } = await mountPair(propsA, propsB);
    try {
      click(buttonByLabel(a.host, ".sidebar-primary-tabs button", "能力"));
      click(buttonByLabel(b.host, ".sidebar-primary-tabs button", "能力"));
      expect(a.host.querySelectorAll(".sidebar-capabilities button").length).toBe(8);
      expectSameHtml(b.host.innerHTML, a.host.innerHTML, "B侧DOM");
      const caps = ["知识库", "Skills", "模板库", "地图", "智能体广场", "任务中心", "MCP", "Pi 插件"];
      const keyOf: Record<string, string> = { 知识库: "onOpenKnowledgeBase", Skills: "onOpenSkills", 模板库: "onOpenTemplates", 地图: "onOpenMap", 智能体广场: "onOpenAgents", 任务中心: "onOpenTasks", MCP: "onOpenMcp", "Pi 插件": "onOpenPiPlugins" };
      for (const name of caps) {
        const btnA = [...a.host.querySelectorAll(".sidebar-capabilities button")].find((el) => el.querySelector("strong")?.textContent === name);
        const btnB = [...b.host.querySelectorAll(".sidebar-capabilities button")].find((el) => el.querySelector("strong")?.textContent === name);
        click(btnA);
        click(btnB);
        expect((propsA[keyOf[name]!] as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
        expect((propsB[keyOf[name]!] as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
      }
      // 底部产物/设置：有回调时只回调，不开弹窗
      click(a.host.querySelectorAll(".sidebar-bottom-tabs .bt-btn")[0]);
      click(b.host.querySelectorAll(".sidebar-bottom-tabs .bt-btn")[0]);
      click(a.host.querySelectorAll(".sidebar-bottom-tabs .bt-btn")[1]);
      click(b.host.querySelectorAll(".sidebar-bottom-tabs .bt-btn")[1]);
      expect((propsA.onOpenArtifacts as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
      expect((propsB.onOpenArtifacts as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
      expect((propsA.onOpenSettings as ReturnType<typeof vi.fn>).mock.calls).toEqual([["settings"]]);
      expect((propsB.onOpenSettings as ReturnType<typeof vi.fn>).mock.calls).toEqual([["settings"]]);
      expect(a.host.querySelector(".sb-modal")).toBeNull();
      // 项目上下条：文件页（非项目页）→ 记忆按钮 → onOpenSettings("memory")
      click(buttonByLabel(a.host, ".sidebar-primary-tabs button", "文件"));
      click(buttonByLabel(b.host, ".sidebar-primary-tabs button", "文件"));
      click(buttonByLabel(a.host, ".project-context-strip button", "记忆"));
      click(buttonByLabel(b.host, ".project-context-strip button", "记忆"));
      expect((propsA.onOpenSettings as ReturnType<typeof vi.fn>).mock.calls).toEqual([["settings"], ["memory"]]);
      expect((propsB.onOpenSettings as ReturnType<typeof vi.fn>).mock.calls).toEqual([["settings"], ["memory"]]);
      expectSameHtml(b.host.innerHTML, a.host.innerHTML, "B侧DOM");
    } finally {
      a.unmount();
      b.unmount();
    }
  });

  it("设置弹窗组合：嵌套 SettingsPanel 全 DOM 一致 + 12 条请求序列归一化对账", async () => {
    stubDialogs();
    const propsA = makeProps({ onOpenSettings: undefined });
    const propsB = makeProps({ onOpenSettings: undefined });
    const { a, b, httpCalls, ipcCalls } = await mountPair(propsA, propsB);
    try {
      click(a.host.querySelectorAll(".sidebar-bottom-tabs .bt-btn")[1]);
      click(b.host.querySelectorAll(".sidebar-bottom-tabs .bt-btn")[1]);
      await settle();
      // 弹窗壳 + 子 tab + 嵌套 SettingsPanel（providers 段 8 个导航项）
      expect(text(a.host.querySelector(".sb-modal-title"))).toBe("设置");
      expect(a.host.querySelectorAll(".sb-subtab").length).toBe(2);
      expect(a.host.querySelectorAll(".settings-section-nav button").length).toBe(8);
      expectSameHtml(b.host.innerHTML, a.host.innerHTML, "B侧DOM");
      // 请求序列：侧边栏 file-roots + SettingsPanel 11 路加载，双侧归一化对账
      expect(callSignature(ipcCalls)).toEqual(callSignature(httpCalls));
      expect(new Set(callSignature(httpCalls)).size).toBe(12);
      expect(httpCalls.filter((c) => c.path === "/api/file-roots").length).toBe(1);
    } finally {
      a.unmount();
      b.unmount();
    }
  });

  it("品牌区与主 tab：主题/命令面板回调 + 品牌 DOM 一致", async () => {
    const propsA = makeProps();
    const propsB = makeProps({ theme: "light" });
    const { a, b } = await mountPair(propsA, propsB);
    try {
      expect(text(a.host.querySelector(".sidebar-brand-copy strong"))).toBe("Open Plan");
      click(a.host.querySelector(".sidebar-brand-action"));
      click(b.host.querySelector(".sidebar-brand-action"));
      expect((propsA.onToggleTheme as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
      expect((propsB.onToggleTheme as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
      click(a.host.querySelectorAll(".sidebar-brand-action")[1]);
      click(b.host.querySelectorAll(".sidebar-brand-action")[1]);
      expect((propsA.onOpenCommandPalette as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
      expect((propsB.onOpenCommandPalette as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
      // theme=light 的 B 侧标题属性切换（同侧对比）
      expect(b.host.querySelector(".sidebar-brand-action")?.getAttribute("title")).toBe("切换到暗色主题");
      expect(a.host.querySelector(".sidebar-brand-action")?.getAttribute("title")).toBe("切换到亮色主题");
      expect(a.host.querySelectorAll(".sidebar-primary-tabs button").length).toBe(3);
    } finally {
      a.unmount();
      b.unmount();
    }
  });
});
