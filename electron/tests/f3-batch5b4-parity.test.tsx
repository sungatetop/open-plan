// @vitest-environment jsdom
/**
 * F3 批5b-4 对拍：SettingsPanel（设置面板）+ ProjectSettingsSection（项目设置段）。
 *
 * 对拍口径（双侧同流）：
 *   - 旧组件（client/src/components/SettingsPanel.jsx）走 fetch → HTTP API；
 *     新组件（electron/src/renderer/components/SettingsPanel.tsx）走 opDesktop.invoke → IPC 通道。
 *     两侧等价的充要条件：同一份 DATA 按 (method, path) 路由给两侧，DOM 逐字节一致，
 *     且两侧调用序列归一化（method + path）后一一对应、body/query 深等。
 *   - 覆盖：初始挂载（providers 默认段）全 DOM + 请求序列对账；8 个设置段切换；
 *     权限规则撤销（confirm 放行 + body 深等）；凭据保存（空 Key 校验 + 保存 body 深等）；
 *     网络保存（manual 校验 + direct 保存 body）；联网搜索测试（草稿 body 深等 + 文案）；
 *     模型套餐（目录渲染 + remote 模型拉取 query 深等 + 空 Key 校验 + 断开确认）；
 *     项目设置（列表渲染 + 搜索过滤 + 保存双 PATCH body 深等 + 创建项目）；
 *     底图保存（body 深等 + 输入清空）；高级段重置（confirm=false 不清理）。
 *
 * 架构性等价替换（BRD-009）：旧组件内联 fetch("/api/status") → IPC 通道 op:status:get；
 * 旧 apiControl 8s 槽位自愈不再需要（IPC 不占浏览器同源连接池）。
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const TsMod = await import("../src/renderer/components/SettingsPanel");
const JsMod = await import("../../client/src/components/SettingsPanel.jsx");

const SettingsPanelTs = TsMod.default;
// @ts-expect-error 旧 JS 模块；props 走 Record 宽容视图（JS 边界无静态约束）
const SettingsPanelJs: React.ComponentType<Record<string, unknown>> = JsMod.default;

interface ApiCall { method: string; path: string; body?: unknown; query?: Record<string, string> }

/* ------------------------- 样本数据（双侧共用同一份） ------------------------- */

const CATALOG = {
  totalModels: 42,
  summary: { oauth: 1 },
  providers: [
    {
      id: "openai", name: "OpenAI", api: "openai-completions", apiLabel: "OpenAI 兼容",
      configured: true, configuredModelCount: 3, isDefault: true, importable: true,
      loginMethods: ["oauth", "apiKey"], modelCount: 12,
      capabilities: { maxContext: 128000, visionCount: 4, reasoningCount: 2 },
      auth: { oauth: { name: "ChatGPT 账号" }, apiKey: { name: "OpenAI API Key", envVars: ["OPENAI_API_KEY"] } },
      sampleModels: [{ id: "gpt-4o" }]
    },
    {
      id: "deepseek", name: "DeepSeek", importable: true, configured: true, configuredModelCount: 2,
      loginMethods: ["apiKey"], modelCount: 5,
      auth: { apiKey: { name: "DeepSeek Key", envVars: ["DEEPSEEK_API_KEY"] } },
      capabilities: { maxContext: 1000000 }
    },
    { id: "moonshot", name: "Moonshot", importable: true, loginMethods: ["apiKey"], modelCount: 3, auth: { apiKey: { name: "Moonshot Key", envVars: ["MOONSHOT_API_KEY"] } } },
    { id: "broken", name: "Broken 云", configured: true, authError: "凭据已过期", importable: true, modelCount: 2 }
  ],
  sources: { builtin: { count: 25 }, modelsDev: { count: 17, fetchedAt: "2026-10-19T08:00:00.000Z", status: "fresh" } }
};

const DIAGNOSTICS = {
  service: { version: "0.11.55", pid: 4242 },
  runtime: { health: { status: "idle", message: "" } },
  model: { selected: "deepseek/deepseek-chat", selectedInCatalog: true, selectedAvailable: true, authConfigured: true },
  authErrors: {},
  recentFailures: [{ requestId: "r1", errorCode: "MODEL_ERROR", message: "上游超时", hint: "重试", timestamp: "2026-10-20T10:00:00.000Z" }]
};

const PLANS = {
  plans: [
    { planId: "glm", name: "GLM 套餐", vendor: "智谱", description: "订阅制 · 全模型可用", connected: false, hasKey: false, keyUrl: "https://open.bigmodel.cn", modelsSource: "remote" },
    { planId: "pkg", name: "包月套餐", vendor: "某云", description: "包月制", connected: true, modelCount: 4, totalModels: 6, keyUrl: "https://example.com/key", modelsSource: "builtin" }
  ]
};

const MODELS = [
  { id: "deepseek-chat", provider: "deepseek", name: "DeepSeek Chat", contextWindow: 64000, available: true },
  { id: "deepseek-reasoner", provider: "deepseek", name: "DeepSeek Reasoner", contextWindow: 64000, available: false, authError: "凭据失效" },
  { id: "gpt-4o", provider: "openai", name: "GPT-4o", contextWindow: 128000, vision: true }
];

const PROJECT = {
  id: "p1", name: "城铁 8 号线", type: "交通规划", status: "进行中", description: "走廊交通分析", pinned: true,
  settings: { defaultModel: "deepseek-chat", agentProfile: "GIS", skills: ["gis-tools"], memoryPolicy: "manual", artifactPolicy: "manual" }
};

const PROJECTS = [
  { id: "p1", name: "城铁 8 号线", type: "交通规划", status: "进行中", rootPath: "D:/ws/metro8", description: "走廊交通分析", pinned: true, sessionCount: 4, runCount: 9, pendingMemoryCount: 2, updatedAt: "2026-10-20T09:00:00.000Z" },
  { id: "p2", name: "公交线网优化", type: "数据分析", status: "待整理", rootPath: "D:/ws/bus", description: "", pinned: false, sessionCount: 1, runCount: 2, pendingMemoryCount: 0, updatedAt: "2026-10-18T09:00:00.000Z" },
  { id: "p3", name: "地铁客流报告", type: "调研报告", status: "已完成", rootPath: "D:/ws/flow", description: "客流走廊分析报告", pinned: false, sessionCount: 0, runCount: 0, pendingMemoryCount: 5, updatedAt: "2026-10-15T09:00:00.000Z" }
];

const BASE_PROPS: Record<string, unknown> = {
  clientId: "c1",
  threadId: "t1",
  models: MODELS,
  defaultModel: "deepseek/deepseek-chat",
  activeModel: "",
  currentWorkspace: "D:/ws/metro8",
  project: PROJECT,
  projects: PROJECTS
};

/** 双侧共用路由数据：key = `${method} ${path}`（path 不含 query） */
function makeData(): Record<string, unknown> {
  return {
    "GET /api/status": { version: "0.11.55", piPackageVersion: "0.85.1", officecli: "officecli v1.2.0" },
    "GET /api/agent/auth": { providers: { anthropic: { masked: "sk-a***tx" }, deepseek: { masked: "dk-9***q1" } }, authErrors: { deepseek: { message: "凭据已过期" } } },
    "GET /api/agent/config-status": { configured: true, source: "managed", modelsConfigured: true, dataDir: "D:/ws/.oaw/pi", storage: {} },
    "GET /api/agent/import-preview": { available: true, credentialCount: 3, sessionCount: 12, providers: [{ id: "anthropic" }, { id: "deepseek" }], sessions: { count: 12 } },
    "GET /api/agent/network-settings": { mode: "direct", noProxy: "localhost,127.0.0.1,::1", hasProxy: false },
    "GET /api/search/settings": {
      backends: [{ id: "tavily", name: "Tavily", hint: "免费 1000 次/月" }, { id: "searxng", name: "SearXNG", hint: "自建实例" }],
      settings: { backend: "tavily", searxngUrl: "", state: { tone: "warn", label: "未验证", reason: "尚未测试连通性" } }
    },
    "GET /api/agent/model-configs": {
      configs: [{
        provider: "deepseek", name: "DeepSeek", api: "openai-completions", baseUrl: "https://api.deepseek.com",
        enabled: true, keyConfigured: true,
        models: [
          { id: "deepseek-chat", name: "DeepSeek Chat", contextWindow: 64000, vision: false, reasoning: true, enabled: true },
          { id: "deepseek-vl2", name: "VL2", contextWindow: 32000, vision: true, enabled: true }
        ]
      }]
    },
    "GET /api/agent/provider-catalog": CATALOG,
    "GET /api/agent/diagnostics": DIAGNOSTICS,
    "GET /api/agent/plans": PLANS,
    "GET /api/agent/plans/models": { models: [{ id: "glm-4.6", name: "GLM-4.6" }, { id: "glm-4.5-air", name: "GLM-4.5-Air" }] },
    "POST /api/agent/plans/apply": { ok: true, modelCount: 2 },
    "POST /api/agent/plans/disconnect": { ok: true },
    "POST /api/models/refresh": { models: MODELS },
    "GET /api/map/settings": { basemaps: { tiandituKey: "tk123***", maptilerKey: "", geoapifyKey: "geo***" } },
    "POST /api/map/settings": { basemaps: { tiandituKey: "tk-new", maptilerKey: "", geoapifyKey: "geo***" } },
    "GET /api/agent/permissions": { mode: "ask", defaults: [], user: [{ tool: "bash", pattern: "git *", action: "allow" }, { tool: "write", pattern: "docs/**", action: "allow" }] },
    "DELETE /api/agent/permissions/rule": { rules: [{ tool: "write", pattern: "docs/**", action: "allow" }] },
    "POST /api/agent/auth": { ok: true },
    "PATCH /api/agent/network-settings": { mode: "direct", noProxy: "localhost,127.0.0.1,::1", hasProxy: false },
    "POST /api/search/test": { ok: true, message: "连接正常", testedDraft: true },
    "PATCH /api/projects": { id: "p1" },
    "PATCH /api/projects/p1/settings": { ok: true },
    "POST /api/projects": { project: { id: "p9", name: "新项目" } },
    "POST /api/agent/model/probe": { ok: true, latencyMs: 42, response: { preview: "pong" } }
  };
}

/* ------------------------- 双侧同流 stub（fetch + opDesktop.invoke） ------------------------- */

const CHANNEL_ROUTES: Record<string, { method: string; path: string }> = {
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
  "op:projects:classify": { method: "POST", path: "/api/projects/classify" },
  "op:projects:update": { method: "PATCH", path: "/api/projects" },
  "op:projects:pin": { method: "POST", path: "/api/projects" },
  "op:projects:archive": { method: "POST", path: "/api/projects" },
  "op:projects:settings:update": { method: "PATCH", path: "/api/projects" }
};

function setupParity(): { httpCalls: ApiCall[]; ipcCalls: ApiCall[] } {
  const httpCalls: ApiCall[] = [];
  const ipcCalls: ApiCall[] = [];
  const data = makeData();
  vi.stubGlobal("fetch", async (path: string | URL, opts?: RequestInit) => {
    const url = new URL(String(path), "http://legacy");
    const call: ApiCall = {
      method: opts?.method ?? "GET",
      path: url.pathname,
      body: typeof opts?.body === "string" ? JSON.parse(opts.body) : undefined,
      query: Object.fromEntries(url.searchParams.entries())
    };
    httpCalls.push(call);
    return { ok: true, status: 200, json: async () => data[`${call.method} ${call.path}`] ?? {} };
  });
  (window as unknown as { opDesktop: unknown }).opDesktop = {
    invoke: async (channel: string, payload?: Record<string, unknown>) => {
      const route = CHANNEL_ROUTES[channel] ?? { method: "GET", path: "/__unknown__" };
      const params = (payload?.params ?? {}) as Record<string, string>;
      let routePath = route.path;
      if (channel === "op:agent:model-configs:delete") routePath += `/${encodeURIComponent(params.provider ?? "")}`;
      if (params.id) {
        if (channel === "op:projects:update") routePath += `/${encodeURIComponent(params.id)}`;
        else if (channel === "op:projects:pin") routePath += `/${encodeURIComponent(params.id)}/pin`;
        else if (channel === "op:projects:archive") routePath += `/${encodeURIComponent(params.id)}/archive`;
        else if (channel === "op:projects:settings:update") routePath += `/${encodeURIComponent(params.id)}/settings`;
      }
      const call: ApiCall = {
        method: route.method,
        path: routePath,
        body: payload?.body,
        query: (payload?.query ?? {}) as Record<string, string>
      };
      ipcCalls.push(call);
      return { ok: true, status: 200, data: data[`${call.method} ${call.path}`] ?? {} };
    }
  };
  return { httpCalls, ipcCalls };
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

/** 排空微任务 + 宏任务，让挂载加载（Promise.allSettled 4 路 + 8 组请求）全部落定 */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await Promise.resolve();
      await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    });
  }
}

function setInputValue(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function setSelectValue(select: HTMLSelectElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    setter?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function click(el: Element | null | undefined): void {
  act(() => { el?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}

function text(el: Element | null | undefined): string {
  return (el?.textContent ?? "").trim();
}

function buttonByLabel(host: Element | Document, selector: string, label: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll<HTMLButtonElement>(selector)].find((el) => text(el) === label);
}

function rowByLabel(host: Element, label: string): HTMLElement | undefined {
  return [...host.querySelectorAll<HTMLElement>(".sp-row")].find((row) => row.querySelector(".sp-label")?.textContent === label);
}

/** label/span 结构的表单字段行（network 段 model-network-grid 用 label>span 而非 .sp-row） */
function fieldByLabel(host: Element, label: string): HTMLElement | undefined {
  const span = [...host.querySelectorAll<HTMLElement>(".sp-label, label > span")].find((el) => el.textContent === label);
  return span?.parentElement ?? undefined;
}

/** 归一化调用序列：method + path 排序后比较 */
function callSignature(calls: ApiCall[]): string[] {
  return calls.map((c) => `${c.method} ${c.path}`).sort();
}

let originalAlert: typeof window.alert | null = null;
let originalConfirm: typeof window.confirm | null = null;

function stubDialogs(confirmResult?: boolean): void {
  if (originalAlert === null) originalAlert = window.alert;
  if (originalConfirm === null) originalConfirm = window.confirm;
  (window as unknown as { alert: unknown }).alert = vi.fn();
  (window as unknown as { confirm: unknown }).confirm = vi.fn(() => confirmResult);
}

afterEach(() => {
  if (originalAlert !== null) { (window as unknown as { alert: unknown }).alert = originalAlert; originalAlert = null; }
  if (originalConfirm !== null) { (window as unknown as { confirm: unknown }).confirm = originalConfirm; originalConfirm = null; }
  vi.unstubAllGlobals();
  delete (window as unknown as { opDesktop?: unknown }).opDesktop;
  localStorage.clear();
});

/** 双侧同挂载 + settle；返回两侧 host 与调用记录 */
async function mountPair(props: Record<string, unknown>): Promise<{
  a: { host: HTMLElement; unmount: () => void };
  b: { host: HTMLElement; unmount: () => void };
  httpCalls: ApiCall[];
  ipcCalls: ApiCall[];
}> {
  const { httpCalls, ipcCalls } = setupParity();
  const a = mount(<SettingsPanelJs {...props} />);
  const b = mount(<SettingsPanelTs {...props} />);
  await settle();
  return { a, b, httpCalls, ipcCalls };
}

/* ------------------------------- 对拍用例 ------------------------------- */

describe("SettingsPanel 初始挂载与 client/SettingsPanel.jsx 等价（对拍）", () => {
  it("providers 默认段全 DOM 逐字节一致 + 挂载请求序列归一化对账", async () => {
    const { a, b, httpCalls, ipcCalls } = await mountPair(BASE_PROPS);
    try {
      expect(b.host.innerHTML).toBe(a.host.innerHTML);
      // 默认 initialSection="model" → 重定向到 providers；状态卡 + 供应商列表 + 诊断卡全部就绪
      expect(a.host.querySelector("#settings-providers")).toBeTruthy();
      expect(a.host.querySelectorAll(".settings-status-card").length).toBe(3);
      expect(a.host.querySelectorAll(".model-provider-item").length).toBe(1);
      expect(a.host.querySelectorAll(".prov-library-item").length).toBe(4);
      expect(a.host.querySelectorAll(".prov-oauth-item").length).toBe(1);
      expect(a.host.querySelectorAll(".approval-rule").length).toBe(0);
      // 挂载加载序列：status/auth/config-status/import-preview/network-settings/search-settings/
      // model-configs/provider-catalog/diagnostics/plans/map-settings —— 双侧一一对应
      expect(callSignature(ipcCalls)).toEqual(callSignature(httpCalls));
      expect(new Set(callSignature(httpCalls))).toEqual(new Set([
        "GET /api/status", "GET /api/agent/auth", "GET /api/agent/config-status",
        "GET /api/agent/import-preview", "GET /api/agent/network-settings", "GET /api/search/settings",
        "GET /api/agent/model-configs", "GET /api/agent/provider-catalog", "GET /api/agent/diagnostics",
        "GET /api/agent/plans", "GET /api/map/settings"
      ]));
      // diagnostics 携带 client/thread 参数且双侧一致
      const httpDiag = httpCalls.find((c) => c.path === "/api/agent/diagnostics");
      const ipcDiag = ipcCalls.find((c) => c.path === "/api/agent/diagnostics");
      expect(httpDiag?.query).toEqual({ client: "c1", thread: "t1" });
      expect(ipcDiag?.query).toEqual(httpDiag?.query);
    } finally {
      a.unmount();
      b.unmount();
    }
  });

  it("8 个设置段逐个切换 DOM 一致（含 permission 段规则加载）", async () => {
    const { a, b } = await mountPair(BASE_PROPS);
    try {
      const labels = ["外观与对话", "模型套餐", "模型供应商", "网络与代理", "服务集成", "项目设置与记忆", "审批与权限", "命令面板与高级"];
      expect(a.host.querySelectorAll(".settings-section-nav button").length).toBe(8);
      for (const label of labels) {
        click(buttonByLabel(a.host, ".settings-section-nav button", label));
        click(buttonByLabel(b.host, ".settings-section-nav button", label));
        await settle();
        expect(b.host.innerHTML, `切换到「${label}」后 DOM 应一致`).toBe(a.host.innerHTML);
        if (label === "审批与权限") {
          // permission 段规则已加载渲染（切走后段卸载，故在循环内断言）
          expect(a.host.querySelectorAll(".approval-rule").length).toBe(2);
        }
      }
      // appearance 段：切回外观 → 字体按钮点击 → DOM 与 localStorage 落盘一致
      click(buttonByLabel(a.host, ".settings-section-nav button", "外观与对话"));
      click(buttonByLabel(b.host, ".settings-section-nav button", "外观与对话"));
      await settle();
      click(buttonByLabel(a.host, ".sp-options .sp-opt", "大"));
      click(buttonByLabel(b.host, ".sp-options .sp-opt", "大"));
      expect(b.host.innerHTML).toBe(a.host.innerHTML);
      // useSetting 落盘（appearance 初始化会把合并默认值整份写回，故解析断言字段而非字面量）
      expect(JSON.parse(localStorage.getItem("oaw_settings") ?? "{}")).toMatchObject({ msgFontSize: "large" });
    } finally {
      a.unmount();
      b.unmount();
    }
  });
});

describe("SettingsPanel 交互与 client/SettingsPanel.jsx 等价（对拍）", () => {
  it("权限规则撤销：confirm 放行后 DELETE body 深等 + 列表更新 DOM 一致", async () => {
    stubDialogs(true);
    const { a, b, httpCalls, ipcCalls } = await mountPair(BASE_PROPS);
    try {
      click(buttonByLabel(a.host, ".settings-section-nav button", "审批与权限"));
      click(buttonByLabel(b.host, ".settings-section-nav button", "审批与权限"));
      await settle();
      expect(a.host.querySelectorAll(".approval-rule").length).toBe(2);
      const revokeA = a.host.querySelector(".approval-rule .btn-xs");
      const revokeB = b.host.querySelector(".approval-rule .btn-xs");
      click(revokeA);
      click(revokeB);
      await settle();
      // DELETE /api/agent/permissions/rule body 深等（tool/pattern/action 全量）
      const httpRevoke = [...httpCalls].reverse().find((c) => c.path === "/api/agent/permissions/rule");
      const ipcRevoke = [...ipcCalls].reverse().find((c) => c.path === "/api/agent/permissions/rule");
      expect(httpRevoke).toMatchObject({ method: "DELETE" });
      expect(httpRevoke?.body).toEqual({ tool: "bash", pattern: "git *", action: "allow" });
      expect(ipcRevoke?.body).toEqual(httpRevoke?.body);
      // 服务端返回 rules 1 条 → 列表更新
      expect(a.host.querySelectorAll(".approval-rule").length).toBe(1);
      expect(b.host.innerHTML).toBe(a.host.innerHTML);
    } finally {
      a.unmount();
      b.unmount();
    }
  });

  it("凭据保存：空 Key 校验文案一致无请求；填 Key 保存 body 深等 + 掩码列表刷新", async () => {
    stubDialogs();
    const { a, b, httpCalls, ipcCalls } = await mountPair(BASE_PROPS);
    try {
      const authRow = () => a.host.querySelector(".sp-auth.model-auth-row");
      const saveBtn = () => buttonByLabel(a.host, ".sp-auth.model-auth-row button", "保存凭据");
      const saveBtnB = () => buttonByLabel(b.host, ".sp-auth.model-auth-row button", "保存凭据");
      const keyInputA = () => authRow()?.querySelector<HTMLInputElement>("input[type='password']");
      const keyInputB = () => b.host.querySelector(".sp-auth.model-auth-row")?.querySelector<HTMLInputElement>("input[type='password']");
      // 空 Key：本地校验文案，无网络请求
      const httpBefore = httpCalls.length;
      click(saveBtn());
      click(saveBtnB());
      expect(text(a.host.querySelector(".sp-auth.model-auth-row .sp-auth-msg"))).toBe("请输入 API Key");
      expect(b.host.innerHTML).toBe(a.host.innerHTML);
      expect(httpCalls.length).toBe(httpBefore);
      // 填 Key 保存：POST body 深等（provider 默认 anthropic，key trim）
      setInputValue(keyInputA()!, "  sk-new-key  ");
      setInputValue(keyInputB()!, "  sk-new-key  ");
      click(saveBtn());
      click(saveBtnB());
      await settle();
      const httpSave = httpCalls.find((c) => c.method === "POST" && c.path === "/api/agent/auth");
      const ipcSave = ipcCalls.find((c) => c.method === "POST" && c.path === "/api/agent/auth");
      expect(httpSave?.body).toEqual({ provider: "anthropic", key: "sk-new-key" });
      expect(ipcSave?.body).toEqual(httpSave?.body);
      // 保存后重新拉取掩码 + 消息文案 + 输入框清空
      expect(text(a.host.querySelector(".sp-auth.model-auth-row .sp-auth-msg"))).toBe("已保存 anthropic ✓");
      expect(keyInputA()!.value).toBe("");
      expect(b.host.innerHTML).toBe(a.host.innerHTML);
      expect(a.host.querySelectorAll(".sp-auth-item").length).toBe(2);
    } finally {
      a.unmount();
      b.unmount();
    }
  });

  it("网络保存：manual 无地址校验文案一致无请求；direct 保存 body 深等 + 消息", async () => {
    stubDialogs();
    const { a, b, httpCalls, ipcCalls } = await mountPair(BASE_PROPS);
    try {
      click(buttonByLabel(a.host, ".settings-section-nav button", "网络与代理"));
      click(buttonByLabel(b.host, ".settings-section-nav button", "网络与代理"));
      await settle();
      const modeSelectA = fieldByLabel(a.host, "连接方式")!.querySelector<HTMLSelectElement>("select");
      const modeSelectB = fieldByLabel(b.host, "连接方式")!.querySelector<HTMLSelectElement>("select");
      const saveA = () => buttonByLabel(a.host, ".model-network-card button", "保存网络设置");
      const saveB = () => buttonByLabel(b.host, ".model-network-card button", "保存网络设置");
      // manual 模式：显示代理地址输入；无地址保存 → 本地校验，无 PATCH
      setSelectValue(modeSelectA!, "manual");
      setSelectValue(modeSelectB!, "manual");
      expect(b.host.innerHTML).toBe(a.host.innerHTML);
      const httpBefore = httpCalls.length;
      click(saveA());
      click(saveB());
      expect(text(a.host.querySelector(".model-network-card .model-feedback"))).toBe("手动代理模式需要填写代理地址");
      expect(b.host.innerHTML).toBe(a.host.innerHTML);
      expect(httpCalls.length).toBe(httpBefore);
      // direct 模式：PATCH body 深等（keepExistingProxy 分支）
      setSelectValue(modeSelectA!, "direct");
      setSelectValue(modeSelectB!, "direct");
      click(saveA());
      click(saveB());
      await settle();
      const httpPatch = httpCalls.find((c) => c.method === "PATCH" && c.path === "/api/agent/network-settings");
      const ipcPatch = ipcCalls.find((c) => c.method === "PATCH" && c.path === "/api/agent/network-settings");
      expect(httpPatch?.body).toEqual({ mode: "direct", noProxy: "localhost,127.0.0.1,::1", keepExistingProxy: true });
      expect(ipcPatch?.body).toEqual(httpPatch?.body);
      expect(text(a.host.querySelector(".model-network-card .model-feedback"))).toBe("网络设置已保存，新建 Agent 请求将使用该设置");
      expect(b.host.innerHTML).toBe(a.host.innerHTML);
    } finally {
      a.unmount();
      b.unmount();
    }
  });

  it("联网搜索测试：草稿 body 深等（trim + 未保存才入 draft）+ 结果文案 DOM 一致", async () => {
    stubDialogs();
    const { a, b, httpCalls, ipcCalls } = await mountPair(BASE_PROPS);
    try {
      click(buttonByLabel(a.host, ".settings-section-nav button", "网络与代理"));
      click(buttonByLabel(b.host, ".settings-section-nav button", "网络与代理"));
      await settle();
      const keyRowA = fieldByLabel(a.host, "Tavily API Key")!;
      const keyRowB = fieldByLabel(b.host, "Tavily API Key")!;
      setInputValue(keyRowA.querySelector<HTMLInputElement>("input")!, "  tv-draft-1  ");
      setInputValue(keyRowB.querySelector<HTMLInputElement>("input")!, "  tv-draft-1  ");
      click(buttonByLabel(a.host, ".model-network-card button", "测试连接"));
      click(buttonByLabel(b.host, ".model-network-card button", "测试连接"));
      await settle();
      const httpTest = httpCalls.find((c) => c.method === "POST" && c.path === "/api/search/test");
      const ipcTest = ipcCalls.find((c) => c.method === "POST" && c.path === "/api/search/test");
      // runSearchTest 的 draft 赋值是原样串（trim 仅用于判空，不改变传值）——双侧同语义
      expect(httpTest?.body).toEqual({ backend: "tavily", draft: { tavilyKey: "  tv-draft-1  " } });
      expect(ipcTest?.body).toEqual(httpTest?.body);
      // 结果文案（testedDraft 提示）+ 测试后刷新徽标的 GET /api/search/settings
      expect(text(a.host.querySelector(".model-feedback"))).toContain("测试结果：✓ 连接正常");
      expect(text(a.host.querySelector(".model-feedback"))).toContain("本次使用未保存的草稿测试");
      expect(b.host.innerHTML).toBe(a.host.innerHTML);
      expect(httpCalls.some((c) => c.method === "GET" && c.path === "/api/search/settings")).toBe(true);
    } finally {
      a.unmount();
      b.unmount();
    }
  });

  it("模型套餐：目录渲染 + 接入展开拉取 remote 模型（planId 深等）+ 空 Key 校验 + 断开确认", async () => {
    stubDialogs(true);
    const { a, b, httpCalls, ipcCalls } = await mountPair(BASE_PROPS);
    try {
      click(buttonByLabel(a.host, ".settings-section-nav button", "模型套餐"));
      click(buttonByLabel(b.host, ".settings-section-nav button", "模型套餐"));
      expect(b.host.innerHTML).toBe(a.host.innerHTML);
      expect(a.host.querySelectorAll(".plan-card").length).toBe(2);
      // 未接入套餐：点「接入」→ modelsSource=remote → 拉取模型目录（planId 一致）
      click(buttonByLabel(a.host, ".plan-card button", "接入"));
      click(buttonByLabel(b.host, ".plan-card button", "接入"));
      await settle();
      const httpModels = httpCalls.find((c) => c.path === "/api/agent/plans/models");
      const ipcModels = ipcCalls.find((c) => c.path === "/api/agent/plans/models");
      expect(httpModels?.query).toEqual({ planId: "glm" });
      expect(ipcModels?.query).toEqual(httpModels?.query);
      expect(a.host.querySelectorAll(".plan-access .model-provider-check").length).toBe(2);
      expect(b.host.innerHTML).toBe(a.host.innerHTML);
      // 空 Key 保存 → 本地校验文案，无 POST
      const httpBefore = httpCalls.length;
      click(buttonByLabel(a.host, ".plan-access-actions button", "保存并接入"));
      click(buttonByLabel(b.host, ".plan-access-actions button", "保存并接入"));
      expect(text(a.host.querySelector(".plan-access-actions .sp-auth-msg"))).toBe("请先粘贴套餐 API Key");
      expect(b.host.innerHTML).toBe(a.host.innerHTML);
      expect(httpCalls.length).toBe(httpBefore);
      // 已接入套餐：断开 → confirm 放行 → POST disconnect body {planId}
      click(buttonByLabel(a.host, ".plan-card button", "断开"));
      click(buttonByLabel(b.host, ".plan-card button", "断开"));
      await settle();
      const httpDisc = httpCalls.find((c) => c.path === "/api/agent/plans/disconnect");
      const ipcDisc = ipcCalls.find((c) => c.path === "/api/agent/plans/disconnect");
      expect(httpDisc?.body).toEqual({ planId: "pkg" });
      expect(ipcDisc?.body).toEqual(httpDisc?.body);
      // 断开后刷新目录（POST /api/models/refresh）+ 重新拉套餐
      expect(httpCalls.some((c) => c.method === "POST" && c.path === "/api/models/refresh")).toBe(true);
      expect(b.host.innerHTML).toBe(a.host.innerHTML);
    } finally {
      a.unmount();
      b.unmount();
    }
  });

  it("项目设置：列表渲染 + 搜索过滤 DOM 一致 + 保存双 PATCH body 深等 + 创建项目", async () => {
    stubDialogs();
    const updatedJs: unknown[] = [];
    const selectedJs: unknown[] = [];
    const updatedTs: unknown[] = [];
    const selectedTs: unknown[] = [];
    const props = { ...BASE_PROPS, onProjectUpdated: () => updatedJs.push(1), onProjectSelect: (id: unknown) => selectedJs.push(id) };
    const propsTs = { ...BASE_PROPS, onProjectUpdated: () => updatedTs.push(1), onProjectSelect: (id: unknown) => selectedTs.push(id) };
    const { httpCalls, ipcCalls } = setupParity();
    const a = mount(<SettingsPanelJs {...props} />);
    const b = mount(<SettingsPanelTs {...propsTs} />);
    try {
      click(buttonByLabel(a.host, ".settings-section-nav button", "项目设置与记忆"));
      click(buttonByLabel(b.host, ".settings-section-nav button", "项目设置与记忆"));
      await settle();
      // 列表渲染：3 个项目，当前项目 active + 置顶 ★
      expect(a.host.querySelectorAll(".project-management-item").length).toBe(3);
      expect(a.host.querySelector(".project-management-item.active")).toBeTruthy();
      expect(text(a.host.querySelector(".project-management-item strong"))).toBe("★ 城铁 8 号线");
      expect(b.host.innerHTML).toBe(a.host.innerHTML);
      // 搜索过滤：命中「公交」→ 1 个
      const searchA = a.host.querySelector<HTMLInputElement>(".project-management-toolbar input");
      const searchB = b.host.querySelector<HTMLInputElement>(".project-management-toolbar input");
      setInputValue(searchA!, "公交");
      setInputValue(searchB!, "公交");
      expect(a.host.querySelectorAll(".project-management-item").length).toBe(1);
      expect(b.host.innerHTML).toBe(a.host.innerHTML);
      setInputValue(searchA!, "");
      setInputValue(searchB!, "");
      // 当前项目表单已从 project prop 初始化
      const nameRowA = rowByLabel(a.host, "项目名称")!;
      const nameRowB = rowByLabel(b.host, "项目名称")!;
      expect(nameRowA.querySelector<HTMLInputElement>("input")!.value).toBe("城铁 8 号线");
      // 修改名称 + Agent Profile → 保存：PATCH 项目 + PATCH 设置 body 深等
      setInputValue(nameRowA.querySelector<HTMLInputElement>("input")!, "城铁 8 号线（更新）");
      setInputValue(nameRowB.querySelector<HTMLInputElement>("input")!, "城铁 8 号线（更新）");
      const profileA = rowByLabel(a.host, "Agent Profile")!.querySelector<HTMLSelectElement>("select");
      const profileB = rowByLabel(b.host, "Agent Profile")!.querySelector<HTMLSelectElement>("select");
      setSelectValue(profileA!, "研究");
      setSelectValue(profileB!, "研究");
      click(buttonByLabel(a.host, ".sp-row button", "保存项目设置"));
      click(buttonByLabel(b.host, ".sp-row button", "保存项目设置"));
      await settle();
      const httpUpd = httpCalls.find((c) => c.method === "PATCH" && c.path === "/api/projects/p1");
      const ipcUpd = ipcCalls.find((c) => c.method === "PATCH" && c.path === "/api/projects/p1");
      const httpSet = httpCalls.find((c) => c.method === "PATCH" && c.path === "/api/projects/p1/settings");
      const ipcSet = ipcCalls.find((c) => c.method === "PATCH" && c.path === "/api/projects/p1/settings");
      expect(httpUpd?.body).toEqual({ name: "城铁 8 号线（更新）", type: "交通规划", status: "进行中", description: "走廊交通分析" });
      expect(ipcUpd?.body).toEqual(httpUpd?.body);
      expect(httpSet?.body).toEqual({ defaultModel: "deepseek-chat", agentProfile: "研究", skills: ["gis-tools"], memoryPolicy: "manual", artifactPolicy: "manual" });
      expect(ipcSet?.body).toEqual(httpSet?.body);
      expect(text(rowByLabel(a.host, "操作")!.querySelector(".sp-auth-msg"))).toBe("项目设置已保存");
      expect(b.host.innerHTML).toBe(a.host.innerHTML);
      expect(updatedTs.length).toBe(1);
      // 创建项目：填名称 → 创建 → POST body 深等 + onProjectSelect("p9") + 消息
      click(buttonByLabel(a.host, ".project-management-toolbar button", "新建项目"));
      click(buttonByLabel(b.host, ".project-management-toolbar button", "新建项目"));
      const formA = a.host.querySelector<HTMLInputElement>(".project-create-form input");
      const formB = b.host.querySelector<HTMLInputElement>(".project-create-form input");
      setInputValue(formA!, "新项目");
      setInputValue(formB!, "新项目");
      click(buttonByLabel(a.host, ".project-create-form button", "创建"));
      click(buttonByLabel(b.host, ".project-create-form button", "创建"));
      await settle();
      const httpCreate = httpCalls.find((c) => c.method === "POST" && c.path === "/api/projects");
      const ipcCreate = ipcCalls.find((c) => c.method === "POST" && c.path === "/api/projects");
      expect(httpCreate?.body).toEqual({ name: "新项目", rootPath: "D:/ws/metro8", type: "综合项目", status: "进行中", description: "" });
      expect(ipcCreate?.body).toEqual(httpCreate?.body);
      expect(selectedTs).toEqual(selectedJs);
      expect(selectedTs[0]).toBe("p9");
      expect(text(rowByLabel(a.host, "操作")!.querySelector(".sp-auth-msg"))).toBe("项目已创建");
      expect(b.host.innerHTML).toBe(a.host.innerHTML);
    } finally {
      a.unmount();
      b.unmount();
    }
  });

  it("底图保存：POST body 深等（trim）+ 输入框清空 + 状态徽标与消息 DOM 一致", async () => {
    stubDialogs();
    const { a, b, httpCalls, ipcCalls } = await mountPair(BASE_PROPS);
    try {
      click(buttonByLabel(a.host, ".settings-section-nav button", "服务集成"));
      click(buttonByLabel(b.host, ".settings-section-nav button", "服务集成"));
      await settle();
      // 初始徽标：map/settings 返回 tianditu/geoapify 已配置
      const tiandituRowA = rowByLabel(a.host, "天地图 Key")!;
      const tiandituRowB = rowByLabel(b.host, "天地图 Key")!;
      expect(text(tiandituRowA.querySelector(".sp-badge"))).toBe("已配置");
      setInputValue(tiandituRowA.querySelector<HTMLInputElement>("input")!, "  tk-new  ");
      setInputValue(tiandituRowB.querySelector<HTMLInputElement>("input")!, "  tk-new  ");
      click(buttonByLabel(a.host, ".sp-section button", "保存底图配置"));
      click(buttonByLabel(b.host, ".sp-section button", "保存底图配置"));
      await settle();
      const httpSave = httpCalls.find((c) => c.method === "POST" && c.path === "/api/map/settings");
      const ipcSave = ipcCalls.find((c) => c.method === "POST" && c.path === "/api/map/settings");
      // 旧 HTTP body 与新 IPC body 同形：mapSettingsSave 组件参数在两层都包 {basemaps}（client-api.ts 与 api.js 同约定）
      const expectedSave = { basemaps: { tiandituKey: "tk-new", maptilerKey: "", geoapifyKey: "" } };
      expect(httpSave?.body).toEqual(expectedSave);
      expect(ipcSave?.body).toEqual(expectedSave);
      // 输入框清空 + 消息文案
      expect(rowByLabel(a.host, "天地图 Key")!.querySelector<HTMLInputElement>("input")!.value).toBe("");
      expect(text(a.host.querySelector(".sp-section .sp-auth-msg"))).toBe("已保存 ✓ 底图列表已更新，地图需刷新样式（切一次底图或重进地图）");
      expect(b.host.innerHTML).toBe(a.host.innerHTML);
    } finally {
      a.unmount();
      b.unmount();
    }
  });

  it("高级段：版本文案一致；重置按钮 confirm=false 时不清理 localStorage 不触发 onReset", async () => {
    stubDialogs(false);
    localStorage.setItem("oaw_settings", JSON.stringify({ msgFontSize: "large" }));
    const resetJs = vi.fn();
    const resetTs = vi.fn();
    const props = { ...BASE_PROPS, onReset: resetJs };
    const propsTs = { ...BASE_PROPS, onReset: resetTs };
    setupParity();
    const a = mount(<SettingsPanelJs {...props} />);
    const b = mount(<SettingsPanelTs {...propsTs} />);
    try {
      click(buttonByLabel(a.host, ".settings-section-nav button", "命令面板与高级"));
      click(buttonByLabel(b.host, ".settings-section-nav button", "命令面板与高级"));
      await settle();
      // 版本来自 /api/status 的 version 字段
      const notes = () => a.host.querySelectorAll("#settings-advanced .sp-note");
      expect(text(notes()[1])).toBe("版本 v0.11.55");
      expect(b.host.innerHTML).toBe(a.host.innerHTML);
      click(a.host.querySelector(".sp-danger"));
      click(b.host.querySelector(".sp-danger"));
      expect(resetJs).not.toHaveBeenCalled();
      expect(resetTs).not.toHaveBeenCalled();
      expect(localStorage.getItem("oaw_settings")).toBe(JSON.stringify({ msgFontSize: "large" }));
      expect(b.host.innerHTML).toBe(a.host.innerHTML);
    } finally {
      a.unmount();
      b.unmount();
    }
  });

  it("真实连接测试：probe body 深等（默认模型 + 15s 超时）+ 结果文案 DOM 一致", async () => {
    stubDialogs();
    const { a, b, httpCalls, ipcCalls } = await mountPair(BASE_PROPS);
    try {
      click(buttonByLabel(a.host, ".model-control-grid button", "测试真实连接"));
      click(buttonByLabel(b.host, ".model-control-grid button", "测试真实连接"));
      await settle();
      const httpProbe = httpCalls.find((c) => c.path === "/api/agent/model/probe");
      const ipcProbe = ipcCalls.find((c) => c.path === "/api/agent/model/probe");
      expect(httpProbe?.body).toEqual({ model: "deepseek/deepseek-chat", timeoutMs: 15000 });
      expect(ipcProbe?.body).toEqual(httpProbe?.body);
      // 文案：连接成功 · 42 ms · pong
      expect(text(a.host.querySelector(".model-feedback"))).toBe("连接成功 · 42 ms · pong");
      expect(b.host.innerHTML).toBe(a.host.innerHTML);
    } finally {
      a.unmount();
      b.unmount();
    }
  });
});
