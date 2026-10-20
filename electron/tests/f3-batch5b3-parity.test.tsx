// @vitest-environment jsdom
/**
 * F3 批5b-3 对拍：ProviderLibrary（供应商库）+ ProviderImportDialog（供应商导入对话框）。
 *
 * 对拍口径（双侧同流）：
 *   - formatContext 纯函数：同输入逐值比输出（含 0/NaN/字符串/边界 1K/1M）；
 *   - 列表渲染：同一 catalog 双侧挂载，DOM outerHTML 逐字节一致
 *     （徽章/登录方式/能力摘要/models.dev 来源行/折叠按钮/空态文案）；
 *   - 交互：搜索关键词过滤、五档筛选、展开全部、刷新目录（成功/fromCache 降级）
 *     的 DOM 与调用形态一致（旧 fetch POST /api/agent/provider-catalog/refresh ==
 *     新通道 op:agent:provider-catalog:refresh）；
 *   - 导入对话框：查看模型 → 详情加载 → DOM 一致；勾选/全不选/仅支持图片、
 *     导入提交 body 深等 + 结果消息 + onImported 回调参数一致；oauth-only 分支、
 *     backdrop 点击关闭。
 *
 * 组件名映射（仓库命名规范）：供应商库→ProviderLibrary、供应商导入对话框→ProviderImportDialog。
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const TsMod = await import("../src/renderer/components/ProviderLibrary");
const JsMod = await import("../../client/src/components/ProviderLibrary.jsx");

const { formatContext } = TsMod;
const formatContextJs: (value: unknown) => string = JsMod.formatContext;
const ProviderLibraryTs = TsMod.ProviderLibrary;
const ProviderImportDialogTs = TsMod.ProviderImportDialog;
// @ts-expect-error 旧 JS 模块导出名为中文；props 走 Record 宽容视图（JS 边界无静态约束）
const ProviderLibraryJs: React.ComponentType<Record<string, unknown>> = JsMod.供应商库;
// @ts-expect-error 旧 JS 模块导出名为中文；props 走 Record 宽容视图（JS 边界无静态约束）
const ProviderImportDialogJs: React.ComponentType<Record<string, unknown>> = JsMod.供应商导入对话框;

interface HttpCall { method: string; url: string; body?: string }
interface IpcCall { channel: string; payload?: Record<string, unknown> }

/** 双侧同流 stub：旧 fetch 与新 invoke 返回同一 data（按 URL/通道区分），调用记录入列 */
function setupParity(routeData: { match: (method: string, path: string) => unknown }): {
  httpCalls: HttpCall[];
  ipcCalls: IpcCall[];
} {
  const httpCalls: HttpCall[] = [];
  const ipcCalls: IpcCall[] = [];
  vi.stubGlobal("fetch", async (path: string | URL, opts?: RequestInit) => {
    const url = new URL(String(path), "http://legacy");
    httpCalls.push({
      method: opts?.method ?? "GET",
      url: url.pathname,
      body: typeof opts?.body === "string" ? opts.body : undefined
    });
    const data = routeData.match(opts?.method ?? "GET", url.pathname);
    return { ok: true, status: 200, json: async () => data };
  });
  (window as unknown as { opDesktop: unknown }).opDesktop = {
    invoke: async (channel: string, payload?: Record<string, unknown>) => {
      ipcCalls.push({ channel, payload });
      const route: Record<string, { method: string; path: string }> = {
        "op:agent:provider-catalog:detail": { method: "GET", path: "/api/agent/provider-catalog" },
        "op:agent:provider-catalog:import": { method: "POST", path: "/api/agent/provider-catalog/import" },
        "op:agent:provider-catalog:refresh": { method: "POST", path: "/api/agent/provider-catalog/refresh" }
      };
      const r = route[channel] ?? { method: "GET", path: "/__unknown__" };
      const id = (payload?.params as { id?: string } | undefined)?.id;
      const path = r.path + (id ? `/${id}` : "");
      const data = routeData.match(r.method, path);
      return { ok: true, status: 200, data };
    }
  };
  return { httpCalls, ipcCalls };
}

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

/** 排空微任务并让 async 流程（详情加载/刷新/导入）在 act 内完成渲染 */
async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

/** 双侧同挂载跑 step(host)，逐字节比较两侧 outerHTML */
function renderPair(uiOld: React.ReactNode, uiNew: React.ReactNode): void {
  const a = mount(uiOld);
  const b = mount(uiNew);
  try {
    expect(b.host.innerHTML).toBe(a.host.innerHTML);
  } finally {
    a.unmount();
    b.unmount();
  }
}

function text(el: Element | null | undefined): string {
  return (el?.textContent ?? "").trim();
}

const SAMPLE_CATALOG = {
  totalModels: 42,
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
      id: "deepseek", name: "DeepSeek", source: "models-dev", importable: true,
      loginMethods: ["apiKey"], modelCount: 5,
      auth: { apiKey: { name: "DeepSeek Key", envVars: ["DEEPSEEK_API_KEY", "DS_KEY"] } },
      capabilities: { maxContext: 1000000 }
    },
    { id: "custom-blocked", name: "Blocked 专有", importable: false, importBlockReason: "需专用配置", modelCount: 1 },
    { id: "broken", name: "Broken 云", configured: true, authError: "凭据已过期", importable: true, modelCount: 2 }
  ],
  sources: { builtin: { count: 25 }, modelsDev: { count: 17, fetchedAt: "2026-10-19T08:00:00.000Z", status: "fresh" } }
};

const SAMPLE_DETAIL = {
  provider: {
    id: "openai", name: "OpenAI", apiLabel: "OpenAI 兼容", baseUrl: "https://api.openai.com/v1",
    importable: true, modelCount: 3,
    capabilities: { maxContext: 128000, visionCount: 2, reasoningCount: 1 },
    auth: { oauth: { name: "ChatGPT 账号" }, apiKey: { name: "OpenAI Key", envVars: ["OPENAI_API_KEY"] } },
    configured: { keyConfigured: true, models: [{ id: "gpt-4o" }] },
    models: [
      { id: "gpt-4o", name: "GPT-4o", contextWindow: 128000, vision: true, reasoning: false },
      { id: "o1", contextWindow: 1000000, vision: false, reasoning: true },
      { id: "gpt-4o-mini", name: "GPT-4o mini", contextWindow: 128000, vision: true }
    ]
  },
  configured: { models: [{ id: "gpt-4o" }] }
};

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as { opDesktop?: unknown }).opDesktop;
});

describe("formatContext 与 client/ProviderLibrary.jsx 等价（对拍）", () => {
  it("边界矩阵逐值一致", () => {
    const values: unknown[] = [0, "", null, undefined, "abc", Number.NaN, -5, 999, 1000, 1001, 128000, 999999, 1000000, 1000001, 2000000, "128000", 1e9];
    for (const value of values) {
      expect(formatContext(value), `formatContext(${String(value)})`).toBe(formatContextJs(value));
    }
  });
});

describe("ProviderLibrary 列表与 client/ProviderLibrary.jsx 等价（对拍）", () => {
  it("完整目录渲染 outerHTML 逐字节一致", () => {
    renderPair(
      <ProviderLibraryJs catalog={SAMPLE_CATALOG} />,
      <ProviderLibraryTs catalog={SAMPLE_CATALOG} />
    );
  });

  it("空目录 / 目录 error / 无 modelsDev 来源三种形态", () => {
    renderPair(<ProviderLibraryJs catalog={null} />, <ProviderLibraryTs catalog={null} />);
    renderPair(
      <ProviderLibraryJs catalog={{ providers: [], totalModels: 0, error: "目录文件缺失" }} />,
      <ProviderLibraryTs catalog={{ providers: [], totalModels: 0, error: "目录文件缺失" }} />
    );
    renderPair(
      <ProviderLibraryJs catalog={{ providers: SAMPLE_CATALOG.providers, totalModels: 42 }} />,
      <ProviderLibraryTs catalog={{ providers: SAMPLE_CATALOG.providers, totalModels: 42 }} />
    );
  });

  it("搜索关键词过滤（命中模型 id / 环境变量）DOM 一致", () => {
    const a = mount(<ProviderLibraryJs catalog={SAMPLE_CATALOG} />);
    const b = mount(<ProviderLibraryTs catalog={SAMPLE_CATALOG} />);
    try {
      const inputA = a.host.querySelector<HTMLInputElement>("input[aria-label='搜索内置供应商']");
      const inputB = b.host.querySelector<HTMLInputElement>("input[aria-label='搜索内置供应商']");
      setInputValue(inputA!, "gpt");
      setInputValue(inputB!, "gpt");
      expect(b.host.innerHTML).toBe(a.host.innerHTML);
      expect(a.host.querySelectorAll(".prov-library-item").length).toBe(1);

      setInputValue(inputA!, "DS_KEY");
      setInputValue(inputB!, "DS_KEY");
      expect(b.host.innerHTML).toBe(a.host.innerHTML);
      expect(a.host.querySelectorAll(".prov-library-item").length).toBe(1);

      // 清空按钮出现且恢复全量
      const clearA = a.host.querySelector(".prov-library-search .btn-xs");
      const clearB = b.host.querySelector(".prov-library-search .btn-xs");
      click(clearA);
      click(clearB);
      expect(b.host.innerHTML).toBe(a.host.innerHTML);
      expect(a.host.querySelectorAll(".prov-library-item").length).toBe(4);
    } finally {
      a.unmount();
      b.unmount();
    }
  });

  it("五档筛选点击后 DOM 一致", () => {
    const a = mount(<ProviderLibraryJs catalog={SAMPLE_CATALOG} />);
    const b = mount(<ProviderLibraryTs catalog={SAMPLE_CATALOG} />);
    try {
      const filters = ["支持账号登录", "API Key", "未添加", "已添加 2", "全部 4"];
      for (const label of filters) {
        const btnA = [...a.host.querySelectorAll(".prov-library-filters button")].find((el) => text(el) === label);
        const btnB = [...b.host.querySelectorAll(".prov-library-filters button")].find((el) => text(el) === label);
        click(btnA);
        click(btnB);
        expect(b.host.innerHTML).toBe(a.host.innerHTML);
      }
    } finally {
      a.unmount();
      b.unmount();
    }
  });

  it("刷新目录：成功与 fromCache 降级两分支，文案与调用形态一致", async () => {
    for (const payload of [{ providerCount: 30, modelCount: 300 }, { fromCache: true, error: "网络不可达" }]) {
      const { httpCalls, ipcCalls } = setupParity({ match: (method, path) =>
        method === "POST" && path === "/api/agent/provider-catalog/refresh" ? payload : {} });
      const onRefreshedJs = vi.fn();
      const onRefreshedTs = vi.fn();
      const a = mount(<ProviderLibraryJs catalog={SAMPLE_CATALOG} onCatalogRefreshed={onRefreshedJs} />);
      const b = mount(<ProviderLibraryTs catalog={SAMPLE_CATALOG} onCatalogRefreshed={onRefreshedTs} />);
      try {
        click(a.host.querySelector(".prov-library-search .btn-sm"));
        click(b.host.querySelector(".prov-library-search .btn-sm"));
        await flush();
        // 文案与 DOM 一致
        expect(b.host.innerHTML).toBe(a.host.innerHTML);
        const note = [...a.host.querySelectorAll(".prov-library-source.model-feedback")].map(text).join("|");
        if (payload.fromCache) expect(note).toContain("拉取失败，已沿用上次缓存 · 网络不可达");
        else expect(note).toContain("已更新：30 家供应商 / 300 个模型");
        expect(onRefreshedTs).toHaveBeenCalledTimes(1);
        expect(onRefreshedJs).toHaveBeenCalledTimes(1);
        // 调用形态：POST /api/agent/provider-catalog/refresh，无 body
        expect(httpCalls).toHaveLength(1);
        expect(ipcCalls).toHaveLength(1);
        expect(httpCalls[0]).toMatchObject({ method: "POST", url: "/api/agent/provider-catalog/refresh" });
        expect(httpCalls[0]?.body).toBeUndefined();
        expect(ipcCalls[0]?.channel).toBe("op:agent:provider-catalog:refresh");
        expect(ipcCalls[0]?.payload?.body).toBeUndefined();
      } finally {
        a.unmount();
        b.unmount();
      }
    }
  });

  it("列表折叠：85 个供应商默认显示前 80，展开按钮文案与展开后一致", () => {
    const many = Array.from({ length: 85 }, (_, i) => ({
      id: `p${String(i).padStart(3, "0")}`, name: `P${i}`, importable: true, modelCount: i
    }));
    const catalog = { providers: many, totalModels: 85 };
    const a = mount(<ProviderLibraryJs catalog={catalog} />);
    const b = mount(<ProviderLibraryTs catalog={catalog} />);
    try {
      expect(a.host.querySelectorAll(".prov-library-item").length).toBe(80);
      expect(b.host.innerHTML).toBe(a.host.innerHTML);
      const moreA = a.host.querySelector(".prov-dialog-more");
      const moreB = b.host.querySelector(".prov-dialog-more");
      expect(text(moreA)).toBe("显示全部 85 个供应商（当前显示前 80 个）");
      click(moreA);
      click(moreB);
      expect(a.host.querySelectorAll(".prov-library-item").length).toBe(85);
      expect(b.host.innerHTML).toBe(a.host.innerHTML);
      expect(text(a.host.querySelector(".prov-dialog-more"))).toBe("收起列表");
    } finally {
      a.unmount();
      b.unmount();
    }
  });
});

describe("ProviderImportDialog 与 client/ProviderLibrary.jsx 等价（对拍）", () => {
  it("详情加载后 DOM 一致 + 勾选/全不选/仅支持图片交互一致", async () => {
    const { httpCalls, ipcCalls } = setupParity({ match: (method, path) =>
      method === "GET" && path === "/api/agent/provider-catalog/openai" ? SAMPLE_DETAIL : {} });
    const a = mount(<ProviderImportDialogJs providerId="openai" />);
    const b = mount(<ProviderImportDialogTs providerId="openai" />);
    try {
      // 加载完成态逐字节一致
      await flush();
      expect(b.host.innerHTML).toBe(a.host.innerHTML);
      // 调用形态：GET /api/agent/provider-catalog/openai（id 代入路径参数）
      expect(httpCalls[0]).toMatchObject({ method: "GET", url: "/api/agent/provider-catalog/openai" });
      expect(ipcCalls[0]?.channel).toBe("op:agent:provider-catalog:detail");
      expect(ipcCalls[0]?.payload?.params).toEqual({ id: "openai" });
      // 初始：3 个模型全选，1 个已存在标记
      expect(text(a.host.querySelector(".prov-dialog-models-head strong"))).toBe("模型（已选 3 / 3）");
      expect(a.host.querySelectorAll(".prov-dialog-model.existing").length).toBe(1);
      // 勾选第二个（o1）→ 已选 2
      const boxes = () => a.host.querySelectorAll<HTMLInputElement>(".prov-dialog-model input[type='checkbox']");
      click(boxes()[1]);
      click(b.host.querySelectorAll<HTMLInputElement>(".prov-dialog-model input[type='checkbox']")[1]);
      expect(text(a.host.querySelector(".prov-dialog-models-head strong"))).toBe("模型（已选 2 / 3）");
      expect(b.host.innerHTML).toBe(a.host.innerHTML);
      // 全不选 → 0；仅支持图片 → 2
      const btn = (label: string) => [...a.host.querySelectorAll(".prov-dialog-models-actions button")].find((el) => text(el) === label);
      const btnB = (label: string) => [...b.host.querySelectorAll(".prov-dialog-models-actions button")].find((el) => text(el) === label);
      click(btn("全不选"));
      click(btnB("全不选"));
      expect(text(a.host.querySelector(".prov-dialog-models-head strong"))).toBe("模型（已选 0 / 3）");
      click(btn("仅支持图片"));
      click(btnB("仅支持图片"));
      expect(text(a.host.querySelector(".prov-dialog-models-head strong"))).toBe("模型（已选 2 / 3）");
      expect(b.host.innerHTML).toBe(a.host.innerHTML);
    } finally {
      a.unmount();
      b.unmount();
    }
  });

  it("导入提交：body 深等 + 结果消息 + onImported 参数 + 对话框关闭", async () => {
    const importResult = { name: "OpenAI", total: 3, defaultModel: "gpt-4o" };
    const { httpCalls, ipcCalls } = setupParity({ match: (method, path) => {
      if (method === "GET" && path === "/api/agent/provider-catalog/openai") return SAMPLE_DETAIL;
      if (method === "POST" && path === "/api/agent/provider-catalog/import") return importResult;
      return {};
    } });
    const importedJs: unknown[] = [];
    const importedTs: unknown[] = [];
    const a = mount(<ProviderImportDialogJs providerId="openai" onImported={(r: unknown) => importedJs.push(r)} />);
    const b = mount(<ProviderImportDialogTs providerId="openai" onImported={(r) => importedTs.push(r)} />);
    try {
      await flush();
      // API Key 输入（configured.keyConfigured=true → 占位文案已由详情渲染验证）
      const keyA = a.host.querySelector<HTMLInputElement>(".prov-dialog-field input");
      const keyB = b.host.querySelector<HTMLInputElement>(".prov-dialog-field input");
      setInputValue(keyA!, "  sk-test  ");
      setInputValue(keyB!, "  sk-test  ");
      // 勾掉 o1 → modelIds 2 个
      click(a.host.querySelectorAll<HTMLInputElement>(".prov-dialog-model input[type='checkbox']")[1]);
      click(b.host.querySelectorAll<HTMLInputElement>(".prov-dialog-model input[type='checkbox']")[1]);
      // 提交
      click(a.host.querySelector(".prov-dialog-actions .btn-sm.primary"));
      click(b.host.querySelector(".prov-dialog-actions .btn-sm.primary"));
      await flush();
      // 传输形态：POST + body 深等（旧 JSON.stringify == 新 payload.body）
      const http = httpCalls.find((c) => c.url === "/api/agent/provider-catalog/import");
      const ipc = ipcCalls.find((c) => c.channel === "op:agent:provider-catalog:import");
      expect(http?.method).toBe("POST");
      expect(JSON.parse(http?.body ?? "null")).toEqual(ipc?.payload?.body);
      expect(ipc?.payload?.body).toEqual({
        provider: "openai",
        modelIds: ["gpt-4o", "gpt-4o-mini"],
        apiKey: "sk-test",
        enabled: true,
        setDefault: false,
        defaultModel: "gpt-4o"
      });
      // 结果消息与回调
      expect(text(a.host.querySelector(".sp-auth-msg"))).toBe("已添加 OpenAI · 共 3 个模型 · 默认模型 gpt-4o");
      expect(b.host.innerHTML).toBe(a.host.innerHTML);
      expect(importedTs).toEqual(importedJs);
      expect(importedTs[0]).toEqual(importResult);
    } finally {
      a.unmount();
      b.unmount();
    }
  });

  it("oauth-only 供应商：无 API Key 分支文案一致 + backdrop 点击关闭", async () => {
    const oauthDetail = {
      provider: {
        id: "google", name: "Google Gemini", importable: true, modelCount: 2,
        auth: { oauth: { name: "Google 账号" } },
        models: [{ id: "gemini-pro", contextWindow: 32000 }]
      }
    };
    const closed = { js: 0, ts: 0 };
    const { } = setupParity({ match: (method, path) =>
      method === "GET" && path === "/api/agent/provider-catalog/google" ? oauthDetail : {} });
    const a = mount(<ProviderImportDialogJs providerId="google" onClose={() => { closed.js += 1; }} />);
    const b = mount(<ProviderImportDialogTs providerId="google" onClose={() => { closed.ts += 1; }} />);
    try {
      await flush();
      expect(b.host.innerHTML).toBe(a.host.innerHTML);
      expect(a.host.querySelector(".sp-note")?.textContent).toContain("pi auth login google");
      // backdrop 自身点击（target === currentTarget）→ onClose
      click(a.host.querySelector(".prov-dialog-backdrop"));
      click(b.host.querySelector(".prov-dialog-backdrop"));
      expect(closed).toEqual({ js: 1, ts: 1 });
    } finally {
      a.unmount();
      b.unmount();
    }
  });
});
