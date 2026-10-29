// @vitest-environment jsdom
/**
 * F6-1 外围·业务面板五组件前端组装层对拍（旧客户端组件逐行等价 TS 化）。
 *
 * 对拍口径（client-api 函数族全桩 + Feedback askConfirm 桩 + 子件 MarkdownBody/
 * DocxViewer 轻桩；jsdom 挂载，act 驱动）：
 *   S1 SkillsManager：挂载 listSkills/listWorkflows → 技能卡片；「调用」→
 *      onAtMention(name) + onClose；「技能集合」视图 → 「启动」→ validateWorkflow
 *      分叉 message + onPromoteToAgent({text,skills,workflowId})；
 *   A1 AgentMarket：挂载 listAgents（内置只读/自定义可编辑）；「带入对话」→
 *      onPromoteToAgent({text,skills})；编辑 → 保存 → updateAgent(id,payload)；
 *   I1 IntegrationsCenter：open → Promise.all(mcp,pi) 渲染两侧清单；MCP 表单
 *      （stdio）提交 → saveMcpServer payload（args 拆行/env JSON 解析）；「测试并
 *      读取工具」→ testMcpServer → notice 文案带工具数；
 *   T1 TemplateLibrary：挂载 tplList → 分类+卡片；点卡片 → tplContent → 预览合并
 *      （MarkdownBody 渲染 content）；
 *   W1 WorkflowLauncher：listWorkflows({domain}) → 领域 tab + 阶段/工具/产物渲染；
 *      「运行预检」→ preflightDomainWorkflow payload 断言 + 结果摘要渲染。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

vi.setConfig({ testTimeout: 30_000 });

vi.mock("../src/renderer/api/client-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/renderer/api/client-api")>();
  const fn = () => vi.fn(async () => ({}));
  return {
    ...actual,
    listSkills: fn(),
    listWorkflows: fn(),
    exportSkill: fn(),
    importSkill: fn(),
    validateWorkflow: fn(),
    listAgents: fn(),
    createAgent: fn(),
    updateAgent: fn(),
    deleteAgent: fn(),
    listMcpServers: fn(),
    saveMcpServer: fn(),
    updateMcpServer: fn(),
    deleteMcpServer: fn(),
    testMcpServer: fn(),
    listPiExtensions: fn(),
    checkPiExtension: fn(),
    searchPiPackageCatalog: fn(),
    tplList: fn(),
    tplContent: fn(),
    generateNotice: fn(),
    preflightDomainWorkflow: fn()
  };
});

vi.mock("../src/renderer/components/Feedback", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/renderer/components/Feedback")>();
  return { ...actual, notifyError: vi.fn(), notifySuccess: vi.fn(), askConfirm: vi.fn(async () => true) };
});

vi.mock("../src/renderer/components/MarkdownBody", async () => {
  const React = await import("react");
  return {
    default: (props: Record<string, unknown>) =>
      React.createElement("div", { "data-testid": "md-body-stub" }, String(props.children ?? ""))
  };
});

vi.mock("../src/renderer/components/DocxViewer", async () => {
  const React = await import("react");
  return { default: () => React.createElement("div", { "data-testid": "docx-viewer-stub" }) };
});

import SkillsManager from "../src/renderer/features/skills/skills-manager";
import AgentMarket from "../src/renderer/features/agents/agent-market";
import IntegrationsCenter from "../src/renderer/features/integrations/integrations-center";
import TemplateLibrary from "../src/renderer/features/templates/template-library";
import WorkflowLauncher from "../src/renderer/features/workflow/workflow-launcher";
import {
  listSkills, listWorkflows, validateWorkflow,
  listAgents, updateAgent,
  listMcpServers, listPiExtensions, saveMcpServer, testMcpServer,
  tplList, tplContent,
  preflightDomainWorkflow
} from "../src/renderer/api/client-api";

const listSkillsMock = vi.mocked(listSkills);
const listWorkflowsMock = vi.mocked(listWorkflows);
const validateWorkflowMock = vi.mocked(validateWorkflow);
const listAgentsMock = vi.mocked(listAgents);
const updateAgentMock = vi.mocked(updateAgent);
const listMcpServersMock = vi.mocked(listMcpServers);
const listPiExtensionsMock = vi.mocked(listPiExtensions);
const saveMcpServerMock = vi.mocked(saveMcpServer);
const testMcpServerMock = vi.mocked(testMcpServer);
const tplListMock = vi.mocked(tplList);
const tplContentMock = vi.mocked(tplContent);
const preflightMock = vi.mocked(preflightDomainWorkflow);

/* ==================== 夹具 ==================== */

const SKILLS = {
  skills: [
    { name: "gis-analysis", description: "GIS 空间分析", category: "gis", path: "D:\\skills\\gis-analysis" },
    { name: "report-writer", description: "报告撰写", category: "writing", path: "D:\\skills\\report-writer" }
  ]
};
const DOMAIN_WORKFLOW = {
  id: "od-survey", title: "OD 调查工作流", description: "OD 数据导入→分析→可视化",
  budget: { maxTurns: 20, maxToolCalls: 80 },
  stages: [{ id: "ingest", title: "数据导入", approval: false }, { id: "analyze", title: "统计分析", approval: true }],
  tools: ["officecli", "gis"],
  artifacts: [{ id: "report", title: "分析报告", kind: "docx", required: true }],
  preflight: ["coordinate"]
};
const AGENTS = {
  agents: [
    { id: "builtin-1", name: "规划助手", builtin: true, prompt: "你是规划师", skills: ["gis-analysis"] },
    { id: "custom-1", name: "审阅员", builtin: false, prompt: "你是审阅员" }
  ]
};
const MCP_SERVER = { id: "m1", name: "amap", transport: "stdio", command: "npx", enabled: true };
const PI_EXTENSION = { id: "p1", name: "subagent", path: "/pi/ext", enabled: true };
const TPL_CATEGORIES = [{ id: "c1", name: "报告模板", icon: "doc" }];
const TPL_ITEMS = [{ id: "t1", title: "OD 分析报告", ext: "md", type: "markdown", relPath: "templates/od.md", size: 1200, category: "c1" }];
const TPL_CONTENT = { type: "markdown", content: "# OD 分析报告正文" };

/* ==================== 挂载 harness ==================== */

let host: HTMLElement;
let root: Root | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  listSkillsMock.mockResolvedValue(SKILLS as never);
  listWorkflowsMock.mockResolvedValue({ workflows: [], domain: [DOMAIN_WORKFLOW] } as never);
  validateWorkflowMock.mockResolvedValue({ ok: true, message: "工作流依赖完整" } as never);
  listAgentsMock.mockResolvedValue(AGENTS as never);
  updateAgentMock.mockResolvedValue({ ok: true, agent: { id: "custom-1" } } as never);
  listMcpServersMock.mockResolvedValue({ servers: [MCP_SERVER] } as never);
  listPiExtensionsMock.mockResolvedValue({ extensions: [PI_EXTENSION] } as never);
  saveMcpServerMock.mockResolvedValue({ id: "m2", name: "new" } as never);
  testMcpServerMock.mockResolvedValue({ ok: true, server: { tools: [{ name: "geocode" }], lastTest: { summary: "ok" } } } as never);
  tplListMock.mockResolvedValue({ categories: TPL_CATEGORIES, items: TPL_ITEMS, total: 1 } as never);
  tplContentMock.mockResolvedValue(TPL_CONTENT as never);
  preflightMock.mockResolvedValue({
    ok: true, workflow: { id: "od-survey", title: "OD 调查工作流" },
    预检: { ok: true, 摘要: "全部通过", 检查结果: [{ 检查项: "coordinate", ok: true, 摘要: "坐标有效", 违规: [] }] }
  } as never);
  host = document.createElement("div");
  document.body.appendChild(host);
});

const flush = async (times = 2) => {
  for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve(); });
};

function mount(ui: React.ReactElement) {
  root = createRoot(host);
  act(() => { root!.render(ui); });
}

function unmount() {
  if (root) { act(() => { root!.unmount(); }); root = null; }
  host.remove();
}

const buttonByText = (text: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll("button")].find((b) => b.textContent!.includes(text));
const inputByLabel = (label: string): HTMLInputElement | HTMLTextAreaElement | undefined => {
  const labelEl = [...host.querySelectorAll("label")].find((l) => l.textContent!.includes(label));
  return labelEl?.querySelector("input,textarea") as HTMLInputElement | HTMLTextAreaElement | undefined;
};
const inputByPlaceholder = (placeholder: string): HTMLInputElement | HTMLTextAreaElement | undefined =>
  host.querySelector(`[placeholder="${placeholder}"]`) as HTMLInputElement | HTMLTextAreaElement | undefined;

// React 受控 input：须用原型 native setter 写值再派发 input 事件，onChange 才会触发
const setNative = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value"
  )!.set!;
  act(() => { setter.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); });
};

/* ==================== S1. SkillsManager ==================== */

describe("SkillsManager", () => {
  it("S1 挂载加载 + 「调用」@ 标记 + 技能集合启动链", async () => {
    const onAtMention = vi.fn();
    const onClose = vi.fn();
    const onPromoteToAgent = vi.fn();
    try {
      mount(<SkillsManager open onClose={onClose} onAtMention={onAtMention} clientId="c1" onPromoteToAgent={onPromoteToAgent} />);
      await flush(4);
      expect(listSkillsMock).toHaveBeenCalledTimes(1);
      expect(host.textContent).toContain("gis-analysis");
      // 「调用」：传了 onPromoteToAgent → 走 promote 分支（text 含技能名 + skills 透传）
      act(() => { buttonByText("调用")!.click(); });
      await flush(2);
      expect(onPromoteToAgent).toHaveBeenCalledWith({ text: expect.stringContaining("gis-analysis"), skills: ["gis-analysis"] });
      // 切「技能集合」→ 预置工作流渲染 → 启动（validate 分叉 + promote 透传）
      act(() => { buttonByText("技能集合")!.click(); });
      await flush(2);
      expect(host.textContent).toContain("规划报告全流程");
      validateWorkflowMock.mockResolvedValue({ ok: false, message: "缺少技能：gis" } as never);
      act(() => { buttonByText("启动")!.click(); });
      await flush(3);
      expect(validateWorkflowMock).toHaveBeenCalledWith("wf-plan-doc");
      expect(onPromoteToAgent).toHaveBeenCalledWith(expect.objectContaining({ workflowId: "wf-plan-doc", skills: expect.any(Array) }));
      // validate 的 message 分叉随 startWorkflow 的「已启动」msg 覆盖（组件真实时序）
      expect(host.textContent).toContain("已启动「规划报告全流程」工作流");
    } finally { unmount(); }
  });
});

/* ==================== A1. AgentMarket ==================== */

describe("AgentMarket", () => {
  it("A1 挂载清单 + 「带入对话」透传 + 编辑保存 updateAgent", async () => {
    const onPromoteToAgent = vi.fn();
    try {
      mount(<AgentMarket open onClose={vi.fn()} onPromoteToAgent={onPromoteToAgent} workspace="ws1" />);
      await flush(4);
      expect(listAgentsMock).toHaveBeenCalledTimes(1);
      expect(host.textContent).toContain("规划助手");
      expect(host.textContent).toContain("审阅员");
      // 内置卡带「内置」标记，无编辑/删除
      expect(host.textContent).toContain("内置");
      // 「带入对话」→ onPromoteToAgent({ text, skills })
      act(() => { buttonByText("带入对话")!.click(); });
      await flush(2);
      expect(onPromoteToAgent).toHaveBeenCalledWith({ text: "你是规划师", skills: ["gis-analysis"] });
      // 自定义卡「编辑」→ 表单出现 → 保存 → updateAgent(id, payload)
      act(() => { buttonByText("编辑")!.click(); });
      await flush(2);
      const nameInput = inputByPlaceholder("名称");
      expect(nameInput).toBeTruthy();
      setNative(nameInput!, "审阅员2");
      act(() => { buttonByText("保存")!.click(); });
      await flush(3);
      expect(updateAgentMock).toHaveBeenCalledWith("custom-1", expect.objectContaining({ name: "审阅员2" }));
      expect(host.textContent).toContain("智能体已保存");
    } finally { unmount(); }
  });
});

/* ==================== I1. IntegrationsCenter ==================== */

describe("IntegrationsCenter", () => {
  it("I1 open 挂载双清单 + MCP 表单提交 payload + 测试链 notice", async () => {
    try {
      mount(<IntegrationsCenter kind="mcp" open onClose={vi.fn()} />);
      await flush(4);
      expect(listMcpServersMock).toHaveBeenCalledTimes(1);
      expect(listPiExtensionsMock).toHaveBeenCalledTimes(1);
      expect(host.textContent).toContain("amap");
      // 表单：名称 + 启动命令 + 参数（拆行）+ 环境 JSON（解析）
      const set = (label: string, value: string) => setNative(inputByLabel(label)!, value);
      set("服务名称", "检索服务");
      set("启动命令", "npx");
      set("命令参数", "-y\nserver-fs");
      set("环境变量 JSON", '{"API_KEY":"k1"}');
      act(() => { buttonByText("保存 MCP 配置")!.click(); });
      await flush(3);
      expect(saveMcpServerMock).toHaveBeenCalledWith({
        name: "检索服务", transport: "stdio",
        command: "npx", args: ["-y", "server-fs"], cwd: "", env: { API_KEY: "k1" }
      });
      // 「测试并读取工具」→ askConfirm → testMcpServer → notice 文案带工具数
      act(() => { buttonByText("测试并读取工具")!.click(); });
      await flush(3);
      expect(testMcpServerMock).toHaveBeenCalledWith("m1");
      expect(host.textContent).toContain("连接成功，发现 1 个工具");
    } finally { unmount(); }
  });
});

/* ==================== T1. TemplateLibrary ==================== */

describe("TemplateLibrary", () => {
  it("T1 挂载 tplList + 卡片点击 → tplContent 预览合并", async () => {
    try {
      mount(<TemplateLibrary onExit={vi.fn()} onAtMention={vi.fn()} />);
      await flush(4);
      expect(tplListMock).toHaveBeenCalledTimes(1);
      expect(host.textContent).toContain("OD 分析报告");
      expect(host.textContent).toContain("报告模板");
      // 点卡片 → tplContent → MarkdownBody 渲染 content
      const card = host.querySelector(".tpl-card") as HTMLElement;
      expect(card).toBeTruthy();
      act(() => { card.click(); });
      await flush(4);
      expect(tplContentMock).toHaveBeenCalledWith("templates/od.md");
      expect(host.textContent).toContain("OD 分析报告正文");
    } finally { unmount(); }
  });
});

/* ==================== W1. WorkflowLauncher ==================== */

describe("WorkflowLauncher", () => {
  it("W1 领域清单渲染（阶段/工具/产物）+ 运行预检 payload 与结果", async () => {
    try {
      mount(<WorkflowLauncher onClose={vi.fn()} />);
      await flush(4);
      expect(listWorkflowsMock).toHaveBeenCalledTimes(1);
      expect(host.textContent).toContain("OD 调查工作流");
      // 阶段条：阶段标题 + 需人工确认标记
      const stages = [...host.querySelectorAll(".wf-stage-title")].map((el) => el.textContent);
      expect(stages).toEqual(["数据导入", "统计分析"]);
      expect(host.querySelectorAll(".wf-stage-approval")).toHaveLength(1);
      expect(host.textContent).toContain("officecli");
      // 「运行预检」→ payload 透传坐标/记录数/写回/产物路径
      setNative(inputByLabel("产物路径")!, "out/report.docx");
      act(() => { buttonByText("运行预检")!.click(); });
      await flush(3);
      expect(preflightMock).toHaveBeenCalledWith(expect.objectContaining({
        workflowId: "od-survey",
        记录数: expect.objectContaining({ 声明数: 1000, 实际数: 1000 }),
        产物路径: "out/report.docx"
      }));
      expect(host.textContent).toContain("全部通过");
      expect(host.textContent).toContain("坐标有效");
    } finally { unmount(); }
  });
});
