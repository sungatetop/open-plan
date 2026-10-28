/**
 * F6-1 外围·业务面板五域直调对拍（skills/workflows/agents/integrations/templates
 * 五个 direct 编排层；行号锚点均指 server/index.mjs）。
 *
 * 覆盖面（纯编排测试：deps 全桩，不加载 backend 域实现）：
 *   - manifest 锚点：3+3+4+12+5=27 条通道全部在 DESKTOP_CHANNELS 且路由指向
 *     /api/skills|workflows|agents|integrations|templates 已审计路径；unknown → 404；
 *   - skills-direct（L2525-2527 / L2683-2737）：list 透传 scanSkills；export !skill
 *     404、SKILL.md+辅助文件 base64、catch 500；import 必填/白名单 400、frontmatter
 *     补头、非法文件名跳过、catch 500；
 *   - workflows-direct（L2536-2581）：list flag 关不追加 domain / 开追加并剥离
 *     文件 字段 / registry 抛错 domain=[]+domainError；validate !workflow 404、
 *     message 随 valid 分叉；preflight 关 flag 404、空 id 400、未命中 404、catch 500；
 *   - agents-direct（L2584-2601）：result 整体透传（create ok 201 / !ok 400，
 *     update/delete ok 200 / !ok 400）；
 *   - integrations-direct（L2621-2680）：mcp save try201/catch400、update !server
 *     404、delete !deleted 404、test ok?200:502；pi catalog catch 502、from-package
 *     resolveInstalled→add({name,path}) 201/catch 400、update/check/delete 404；
 *   - templates-direct（L413-443 + L551-586）：list {categories,items,total}；
 *     content !path 400/!c 404/整体透传；generate-notice {ok,name}/catch 500；
 *     file marker 截取 + ".." "/" 400 + 双根前缀过滤 find + 404 + mime 表；
 *     files 盘符 400 + TPL_ROOT 直拼 + 404。
 */
import { describe, expect, test, vi } from "vitest";
import { DESKTOP_CHANNELS } from "../src/shared/protocol/channels";
import * as skills from "../src/main/ipc/skills-direct";
import type { SkillsDirectDeps } from "../src/main/ipc/skills-direct";
import * as workflows from "../src/main/ipc/workflows-direct";
import type { WorkflowsDirectDeps } from "../src/main/ipc/workflows-direct";
import * as agents from "../src/main/ipc/agents-direct";
import type { AgentsDirectDeps } from "../src/main/ipc/agents-direct";
import * as integrations from "../src/main/ipc/integrations-direct";
import type { IntegrationsDirectDeps } from "../src/main/ipc/integrations-direct";
import * as templates from "../src/main/ipc/templates-direct";
import type { TemplatesDirectDeps } from "../src/main/ipc/templates-direct";
import type { InvokeEnvelope, InvokeResult } from "../src/shared/protocol/channels";

/* ==================== manifest 锚点 ==================== */

describe("F6-1 manifest 锚点（27 条通道）", () => {
  test("五域通道全部在 DESKTOP_CHANNELS 且路由指向已审计路径", () => {
    const expected: Record<string, { method: string; path: string }> = {
      "op:skills:list": { method: "GET", path: "/api/skills" },
      "op:skills:export": { method: "POST", path: "/api/skills/export" },
      "op:skills:import": { method: "POST", path: "/api/skills/import" },
      "op:workflows:list": { method: "GET", path: "/api/workflows" },
      "op:workflows:validate": { method: "GET", path: "/api/workflows/:id/validate" },
      "op:workflows:preflight": { method: "POST", path: "/api/domain-workflows/preflight" },
      "op:agents:list": { method: "GET", path: "/api/agents" },
      "op:agents:create": { method: "POST", path: "/api/agents" },
      "op:agents:update": { method: "PATCH", path: "/api/agents/:id" },
      "op:agents:delete": { method: "DELETE", path: "/api/agents/:id" },
      "op:integrations:mcp:list": { method: "GET", path: "/api/integrations/mcp/servers" },
      "op:integrations:mcp:save": { method: "POST", path: "/api/integrations/mcp/servers" },
      "op:integrations:mcp:update": { method: "PATCH", path: "/api/integrations/mcp/servers/:id" },
      "op:integrations:mcp:delete": { method: "DELETE", path: "/api/integrations/mcp/servers/:id" },
      "op:integrations:mcp:test": { method: "POST", path: "/api/integrations/mcp/servers/:id/test" },
      "op:integrations:pi:list": { method: "GET", path: "/api/integrations/pi/extensions" },
      "op:integrations:pi:catalog": { method: "GET", path: "/api/integrations/pi/catalog" },
      "op:integrations:pi:from-package": { method: "POST", path: "/api/integrations/pi/extensions/from-package" },
      "op:integrations:pi:add": { method: "POST", path: "/api/integrations/pi/extensions" },
      "op:integrations:pi:update": { method: "PATCH", path: "/api/integrations/pi/extensions/:id" },
      "op:integrations:pi:check": { method: "POST", path: "/api/integrations/pi/extensions/:id/check" },
      "op:integrations:pi:delete": { method: "DELETE", path: "/api/integrations/pi/extensions/:id" },
      "op:templates:list": { method: "GET", path: "/api/templates" },
      "op:templates:content": { method: "GET", path: "/api/templates/content" },
      "op:templates:generate-notice": { method: "POST", path: "/api/templates/generate-notice" },
      "op:templates:file": { method: "GET", path: "/api/templates/file/:path" },
      "op:templates:files": { method: "GET", path: "/api/templates/files/:path" }
    };
    const all = [
      ...skills.SKILLS_DIRECT_CHANNELS,
      ...workflows.WORKFLOWS_DIRECT_CHANNELS,
      ...agents.AGENTS_DIRECT_CHANNELS,
      ...integrations.INTEGRATIONS_DIRECT_CHANNELS,
      ...templates.TEMPLATES_DIRECT_CHANNELS
    ];
    expect(all).toHaveLength(27);
    for (const channel of all) {
      expect(DESKTOP_CHANNELS[channel]).toEqual(expected[channel]);
    }
  });

  test("op:templates:refresh 死导出路由不入通道清单（channels-manifest 窄前缀豁免）", () => {
    expect(templates.TEMPLATES_DIRECT_CHANNELS).not.toContain("op:templates:refresh");
  });
});

/* ==================== skills-direct ==================== */

function makeSkillsDeps(overrides: Partial<SkillsDirectDeps> = {}): SkillsDirectDeps {
  return {
    scanSkills: vi.fn(() => [{ name: "gis", description: "GIS 技能", path: "D:\\skills\\gis" }]),
    agentDir: "D:\\agent",
    fs: {
      readFileSync: vi.fn((p: string, enc: string) => (enc === "base64" ? "YmFzZTY0" : "# SKILL")),
      readdirSync: vi.fn(() => [{ name: "SKILL.md", isFile: () => true }, { name: "run.py", isFile: () => true }]),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn()
    },
    ...overrides
  };
}

describe("F6-1 skills-direct（L2525-2527 / L2683-2737）", () => {
  test("list：scanSkills 透传", () => {
    const deps = makeSkillsDeps();
    const result = skills.invokeSkillsDirect("op:skills:list", {}, deps);
    expect(deps.scanSkills).toHaveBeenCalledWith();
    expect(result).toEqual({ ok: true, status: 200, data: { skills: [{ name: "gis", description: "GIS 技能", path: "D:\\skills\\gis" }] } });
  });

  test("export：!skill → 404", () => {
    const deps = makeSkillsDeps({ scanSkills: vi.fn(() => []) });
    const result = skills.invokeSkillsDirect("op:skills:export", { body: { name: "nope" } }, deps);
    expect(result).toEqual({ ok: false, status: 404, data: { error: "skill not found" } });
  });

  test("export：SKILL.md base64 + 辅助文件 extra（SKILL.md 自身不入 extra）", () => {
    const deps = makeSkillsDeps();
    const result = skills.invokeSkillsDirect("op:skills:export", { body: { name: "gis" } }, deps);
    expect(result.ok).toBe(true);
    const skill = (result.data as { skill: { name: string; content: string; extra: Record<string, string> } }).skill;
    expect(skill.name).toBe("gis");
    expect(skill.content).toBe(Buffer.from("# SKILL").toString("base64"));
    expect(skill.extra).toEqual({ "run.py": "YmFzZTY0" });
  });

  test("import：!name/!content 400；非法名 400", () => {
    const deps = makeSkillsDeps();
    expect(skills.invokeSkillsDirect("op:skills:import", { body: {} }, deps))
      .toEqual({ ok: false, status: 400, data: { error: "name and content required" } });
    expect(skills.invokeSkillsDirect("op:skills:import", { body: { name: "Bad_Name", content: "eA==" } }, deps))
      .toEqual({ ok: false, status: 400, data: { error: "invalid skill name (小写字母/数字/连字符)" } });
  });

  test("import：无 frontmatter 自动补头；非法辅助文件名跳过", () => {
    const deps = makeSkillsDeps();
    const result = skills.invokeSkillsDirect("op:skills:import", { body: { name: "demo", description: "演示", content: Buffer.from("正文").toString("base64"), extra: { "ok.txt": "eA==", "bad/../x": "eA==" } } }, deps);
    expect(result).toEqual({ ok: true, status: 200, data: { ok: true, name: "demo" } });
    const wf = deps.fs.writeFileSync as ReturnType<typeof vi.fn>;
    const writes = wf.mock.calls.map((c) => String(c[0]));
    expect(writes.some((p) => p.endsWith("demo\\SKILL.md"))).toBe(true);
    expect(writes.some((p) => p.includes("ok.txt"))).toBe(true);
    expect(writes.some((p) => p.includes("bad"))).toBe(false);
    const md = wf.mock.calls.find((c) => String(c[1]).startsWith("---"));
    expect(md?.[1]).toContain("name: demo");
  });

  test("import：有 frontmatter 原样写入；fs 抛错 → catch 500", () => {
    const deps = makeSkillsDeps();
    skills.invokeSkillsDirect("op:skills:import", { body: { name: "demo", content: Buffer.from("---\nname: x\n---\n\n正文").toString("base64") } }, deps);
    const wf = deps.fs.writeFileSync as ReturnType<typeof vi.fn>;
    expect(String(wf.mock.calls[0]![1])).not.toContain("description: demo");
    const failing = makeSkillsDeps({
      fs: { ...deps.fs, mkdirSync: vi.fn(() => { throw new Error("disk full"); }) }
    });
    const result = skills.invokeSkillsDirect("op:skills:import", { body: { name: "demo", content: "eA==" } }, failing);
    expect(result).toEqual({ ok: false, status: 500, data: { error: "disk full" } });
  });

  test("unknown 通道 → 404", () => {
    expect(skills.invokeSkillsDirect("op:skills:nope", {}, makeSkillsDeps()))
      .toEqual({ ok: false, status: 404, data: { error: "unknown channel: op:skills:nope" } });
  });
});

/* ==================== workflows-direct ==================== */

function makeWorkflowsDeps(overrides: Partial<WorkflowsDirectDeps> = {}): WorkflowsDirectDeps {
  return {
    listWorkflows: vi.fn(() => [{ id: "w1", name: "变化检测" }]),
    getWorkflow: vi.fn((_id: unknown, _s: Array<{ name?: unknown } | string>) => ({ id: "w1", valid: true, missing: [] })),
    scanSkills: vi.fn(() => []),
    domainWorkflowsEnabled: vi.fn(() => false),
    listDomainWorkflows: vi.fn(async () => [{ id: "d1", title: "OD 调查", 文件: "d1.yaml" }]),
    getDomainWorkflow: vi.fn(async () => ({ id: "d1", title: "OD 调查" })),
    runPreflight: vi.fn(() => ({ checks: [] })),
    ...overrides
  };
}

async function invokeWorkflow(channel: string, payload: InvokeEnvelope | undefined, deps: WorkflowsDirectDeps): Promise<InvokeResult<unknown>> {
  return workflows.invokeWorkflowsDirect(channel, payload, deps);
}

describe("F6-1 workflows-direct（L2536-2581）", () => {
  test("list：flag 关 → 仅 workflows，不触发 registry", async () => {
    const deps = makeWorkflowsDeps();
    const result = await invokeWorkflow("op:workflows:list", {}, deps);
    expect(result).toEqual({ ok: true, status: 200, data: { workflows: [{ id: "w1", name: "变化检测" }] } });
    expect(deps.listDomainWorkflows).not.toHaveBeenCalled();
  });

  test("list：flag 开 → domain 字段剥离 文件；registry 抛错 → domain=[] + domainError", async () => {
    const deps = makeWorkflowsDeps({ domainWorkflowsEnabled: vi.fn(() => true) });
    const result = await invokeWorkflow("op:workflows:list", {}, deps);
    expect((result.data as { domain: Array<Record<string, unknown>> }).domain).toEqual([{ id: "d1", title: "OD 调查" }]);

    const failing = makeWorkflowsDeps({
      domainWorkflowsEnabled: vi.fn(() => true),
      listDomainWorkflows: vi.fn(async () => { throw new Error("registry missing"); })
    });
    const r2 = await invokeWorkflow("op:workflows:list", {}, failing);
    expect(r2.data).toEqual({ workflows: [{ id: "w1", name: "变化检测" }], domain: [], domainError: "registry missing" });
  });

  test("validate：!workflow 404；valid 与 missing 分叉 message", async () => {
    const deps = makeWorkflowsDeps({ getWorkflow: vi.fn(() => null) });
    expect(await invokeWorkflow("op:workflows:validate", { params: { id: "nope" } }, deps))
      .toEqual({ ok: false, status: 404, data: { ok: false, error: "workflow not found" } });

    const invalid = makeWorkflowsDeps({ getWorkflow: vi.fn(() => ({ id: "w1", valid: false, missing: ["a", "b"] })) });
    const r = await invokeWorkflow("op:workflows:validate", { params: { id: "w1" } }, invalid);
    expect(r.data).toEqual({ ok: false, workflow: { id: "w1", valid: false, missing: ["a", "b"] }, message: "缺少技能：a, b" });

    const valid = makeWorkflowsDeps();
    const r2 = await invokeWorkflow("op:workflows:validate", { params: { id: "w1" } }, valid);
    expect(r2.data).toEqual({ ok: true, workflow: { id: "w1", valid: true, missing: [] }, message: "工作流依赖完整" });
  });

  test("preflight：flag 关 404 → 空 workflowId 400 → 未命中 404", async () => {
    const off = makeWorkflowsDeps();
    expect(await invokeWorkflow("op:workflows:preflight", { body: { workflowId: "d1" } }, off))
      .toEqual({ ok: false, status: 404, data: { ok: false, error: "领域工作流未启用" } });

    const on = makeWorkflowsDeps({ domainWorkflowsEnabled: vi.fn(() => true) });
    expect(await invokeWorkflow("op:workflows:preflight", { body: { workflowId: "  " } }, on))
      .toEqual({ ok: false, status: 400, data: { ok: false, error: "缺少 workflowId" } });

    const missing = makeWorkflowsDeps({ domainWorkflowsEnabled: vi.fn(() => true), getDomainWorkflow: vi.fn(async () => null) });
    expect(await invokeWorkflow("op:workflows:preflight", { body: { workflowId: "nope" } }, missing))
      .toEqual({ ok: false, status: 404, data: { ok: false, error: "工作流不存在" } });
  });

  test("preflight：命中 → runPreflight 透传上下文 + 跳过校验选项；catch 500", async () => {
    const on = makeWorkflowsDeps({ domainWorkflowsEnabled: vi.fn(() => true) });
    const r = await invokeWorkflow("op:workflows:preflight", { body: { workflowId: "d1", 坐标点: [[1, 2]], 记录数: { 声明数: 10 }, 跳过校验: true } }, on);
    expect(r.data).toEqual({ ok: true, workflow: { id: "d1", title: "OD 调查" }, 预检: { checks: [] } });
    expect(on.runPreflight).toHaveBeenCalledWith(
      { id: "d1", title: "OD 调查" },
      { 坐标点: [[1, 2]], 记录数: { 声明数: 10 }, 写回: undefined, 产物路径: undefined },
      { 跳过校验: true }
    );

    const failing = makeWorkflowsDeps({
      domainWorkflowsEnabled: vi.fn(() => true),
      runPreflight: vi.fn(() => { throw new Error("坐标越界"); })
    });
    const r2 = await invokeWorkflow("op:workflows:preflight", { body: { workflowId: "d1" } }, failing);
    expect(r2).toEqual({ ok: false, status: 500, data: { ok: false, error: "坐标越界" } });
  });
});

/* ==================== agents-direct ==================== */

function makeAgentsDeps(overrides: Partial<AgentsDirectDeps> = {}): AgentsDirectDeps {
  return {
    listAgents: vi.fn(() => [{ id: "builtin", name: "内置" }]),
    createAgent: vi.fn(() => ({ ok: true, agent: { id: "a1" } })),
    updateAgent: vi.fn(() => ({ ok: true, agent: { id: "a1" } })),
    deleteAgent: vi.fn(() => ({ ok: true, id: "a1" })),
    ...overrides
  };
}

describe("F6-1 agents-direct（L2584-2601）", () => {
  test("list → { agents }；create ok 201 / !ok 400（result 整体透传）", () => {
    const deps = makeAgentsDeps();
    expect(agents.invokeAgentsDirect("op:agents:list", {}, deps))
      .toEqual({ ok: true, status: 200, data: { agents: [{ id: "builtin", name: "内置" }] } });
    expect(agents.invokeAgentsDirect("op:agents:create", { body: { name: "x" } }, deps))
      .toEqual({ ok: true, status: 201, data: { ok: true, agent: { id: "a1" } } });
    const bad = makeAgentsDeps({ createAgent: vi.fn(() => ({ ok: false, error: "名称重复" })) });
    expect(agents.invokeAgentsDirect("op:agents:create", { body: { name: "x" } }, bad))
      .toEqual({ ok: false, status: 400, data: { ok: false, error: "名称重复" } });
  });

  test("update/delete ok 200 / !ok 400；params.id 透传", () => {
    const deps = makeAgentsDeps();
    expect(agents.invokeAgentsDirect("op:agents:update", { params: { id: "a1" }, body: { name: "y" } }, deps))
      .toEqual({ ok: true, status: 200, data: { ok: true, agent: { id: "a1" } } });
    expect(deps.updateAgent).toHaveBeenCalledWith("a1", { name: "y" });
    expect(agents.invokeAgentsDirect("op:agents:delete", { params: { id: "a1" } }, deps))
      .toEqual({ ok: true, status: 200, data: { ok: true, id: "a1" } });
    const bad = makeAgentsDeps({
      updateAgent: vi.fn(() => ({ ok: false, error: "内置 Agent 只读" })),
      deleteAgent: vi.fn(() => ({ ok: false, error: "不存在" }))
    });
    expect(agents.invokeAgentsDirect("op:agents:update", { params: { id: "builtin" }, body: {} }, bad).status).toBe(400);
    expect(agents.invokeAgentsDirect("op:agents:delete", { params: { id: "nope" } }, bad).status).toBe(400);
  });

  test("unknown 通道 → 404", () => {
    expect(agents.invokeAgentsDirect("op:agents:nope", {}, makeAgentsDeps()))
      .toEqual({ ok: false, status: 404, data: { error: "unknown channel: op:agents:nope" } });
  });
});

/* ==================== integrations-direct ==================== */

function makeIntegrationsDeps(overrides: Partial<IntegrationsDirectDeps> = {}): IntegrationsDirectDeps {
  return {
    listMcpServers: vi.fn(() => [{ id: "m1", name: "amap" }]),
    saveMcpServer: vi.fn(() => ({ id: "m2", name: "new" })),
    updateMcpServer: vi.fn(() => ({ id: "m1", name: "amap" })),
    deleteMcpServer: vi.fn(async () => true),
    testMcpServer: vi.fn(async () => ({ ok: true, server: { tools: [] } })),
    listPiExtensions: vi.fn(() => [{ id: "p1", name: "subagent" }]),
    addPiExtension: vi.fn(() => ({ id: "p2", name: "ext" })),
    updatePiExtension: vi.fn(() => ({ id: "p1", enabled: true })),
    checkPiExtension: vi.fn(() => ({ id: "p1", exists: true })),
    deletePiExtension: vi.fn(() => true),
    searchPiPackageCatalog: vi.fn(async () => ({ items: [], total: 0, page: 0 })),
    resolveInstalledPiPackage: vi.fn(() => ({ name: "pkg", path: "D:\\pkg" })),
    ...overrides
  };
}

async function invokeIntegration(channel: string, payload: InvokeEnvelope | undefined, deps: IntegrationsDirectDeps): Promise<InvokeResult<unknown>> {
  return integrations.invokeIntegrationsDirect(channel, payload, deps);
}

describe("F6-1 integrations-direct（L2621-2680）", () => {
  test("mcp：list / save try201+catch400 / update !server 404+catch400", async () => {
    const deps = makeIntegrationsDeps();
    expect(await invokeIntegration("op:integrations:mcp:list", {}, deps))
      .toEqual({ ok: true, status: 200, data: { servers: [{ id: "m1", name: "amap" }] } });
    expect(await invokeIntegration("op:integrations:mcp:save", { body: { name: "new" } }, deps))
      .toEqual({ ok: true, status: 201, data: { server: { id: "m2", name: "new" } } });
    const throwing = makeIntegrationsDeps({ saveMcpServer: vi.fn(() => { throw new Error("env 不是对象"); }) });
    expect(await invokeIntegration("op:integrations:mcp:save", { body: {} }, throwing))
      .toEqual({ ok: false, status: 400, data: { error: "env 不是对象" } });
    const missing = makeIntegrationsDeps({ updateMcpServer: vi.fn(() => null) });
    expect(await invokeIntegration("op:integrations:mcp:update", { params: { id: "nope" }, body: {} }, missing))
      .toEqual({ ok: false, status: 404, data: { error: "MCP 服务不存在" } });
  });

  test("mcp：delete !deleted 404；test ok?200:502 整体透传", async () => {
    const deps = makeIntegrationsDeps();
    expect(await invokeIntegration("op:integrations:mcp:delete", { params: { id: "m1" } }, deps))
      .toEqual({ ok: true, status: 200, data: { ok: true } });
    const missing = makeIntegrationsDeps({ deleteMcpServer: vi.fn(async () => false) });
    expect(await invokeIntegration("op:integrations:mcp:delete", { params: { id: "nope" } }, missing))
      .toEqual({ ok: false, status: 404, data: { error: "MCP 服务不存在" } });
    const failing = makeIntegrationsDeps({ testMcpServer: vi.fn(async () => ({ ok: false, error: "连接超时" })) });
    expect(await invokeIntegration("op:integrations:mcp:test", { params: { id: "m1" } }, failing))
      .toEqual({ ok: false, status: 502, data: { ok: false, error: "连接超时" } });
  });

  test("pi：catalog 整体透传 + catch 502；from-package resolveInstalled→add({name,path}) 201 + catch 400", async () => {
    const deps = makeIntegrationsDeps();
    expect(await invokeIntegration("op:integrations:pi:catalog", { query: { q: "subagent", page: "2" } }, deps))
      .toEqual({ ok: true, status: 200, data: { items: [], total: 0, page: 0 } });
    expect(deps.searchPiPackageCatalog).toHaveBeenCalledWith("subagent", "2");
    const netFail = makeIntegrationsDeps({ searchPiPackageCatalog: vi.fn(async () => { throw new Error("网络不可达"); }) });
    expect(await invokeIntegration("op:integrations:pi:catalog", {}, netFail))
      .toEqual({ ok: false, status: 502, data: { error: "网络不可达" } });

    expect(await invokeIntegration("op:integrations:pi:from-package", { body: { name: "pkg" } }, deps))
      .toEqual({ ok: true, status: 201, data: { extension: { id: "p2", name: "ext" } } });
    expect(deps.addPiExtension).toHaveBeenCalledWith({ name: "pkg", path: "D:\\pkg" });
    const unresolved = makeIntegrationsDeps({ resolveInstalledPiPackage: vi.fn(() => { throw new Error("包未安装"); }) });
    expect(await invokeIntegration("op:integrations:pi:from-package", { body: { name: "nope" } }, unresolved))
      .toEqual({ ok: false, status: 400, data: { error: "包未安装" } });
  });

  test("pi：add 201/catch 400；update/check/delete 未命中 404「Pi 扩展不存在」", async () => {
    const deps = makeIntegrationsDeps();
    expect(await invokeIntegration("op:integrations:pi:add", { body: { name: "ext" } }, deps))
      .toEqual({ ok: true, status: 201, data: { extension: { id: "p2", name: "ext" } } });
    const missing = makeIntegrationsDeps({
      updatePiExtension: vi.fn(() => null),
      checkPiExtension: vi.fn(() => null),
      deletePiExtension: vi.fn(() => false)
    });
    expect(await invokeIntegration("op:integrations:pi:update", { params: { id: "nope" }, body: {} }, missing))
      .toEqual({ ok: false, status: 404, data: { error: "Pi 扩展不存在" } });
    expect(await invokeIntegration("op:integrations:pi:check", { params: { id: "nope" } }, missing))
      .toEqual({ ok: false, status: 404, data: { error: "Pi 扩展不存在" } });
    expect(await invokeIntegration("op:integrations:pi:delete", { params: { id: "nope" } }, missing))
      .toEqual({ ok: false, status: 404, data: { error: "Pi 扩展不存在" } });
  });

  test("unknown 通道 → 404", async () => {
    expect(await invokeIntegration("op:integrations:nope", {}, makeIntegrationsDeps()))
      .toEqual({ ok: false, status: 404, data: { error: "unknown channel: op:integrations:nope" } });
  });
});

/* ==================== templates-direct ==================== */

function makeTemplatesDeps(overrides: Partial<TemplatesDirectDeps> = {}): TemplatesDirectDeps {
  const files = new Set<string>(["D:\\proj\\templates\\a.html", "D:\\_报告模板\\b.docx"]);
  return {
    getCategories: vi.fn(() => [{ id: "c1", name: "报告", icon: "doc" }]),
    getTemplatesByCategory: vi.fn(() => [{ title: "A" }, { title: "B" }]),
    getTemplateContent: vi.fn(() => ({ type: "markdown", content: "# t" })),
    generateNotice: vi.fn(async () => ({ name: "会议通知.docx" })),
    projectDir: "D:\\proj",
    tplRoot: "D:\\",
    fs: {
      existsSync: vi.fn((p: string) => files.has(p)),
      statSync: vi.fn(() => ({ isFile: () => true })),
      readFileSync: vi.fn(() => "PD94bWw+")
    },
    ...overrides
  };
}

async function invokeTemplate(channel: string, payload: InvokeEnvelope | undefined, deps: TemplatesDirectDeps): Promise<InvokeResult<unknown>> {
  return templates.invokeTemplatesDirect(channel, payload, deps);
}

describe("F6-1 templates-direct（L413-443 + L551-586）", () => {
  test("list：{ categories, items, total }；category query 透传", async () => {
    const deps = makeTemplatesDeps();
    const r = await invokeTemplate("op:templates:list", { query: { category: "c1" } }, deps);
    expect(r.data).toEqual({ categories: [{ id: "c1", name: "报告", icon: "doc" }], items: [{ title: "A" }, { title: "B" }], total: 2 });
    expect(deps.getTemplatesByCategory).toHaveBeenCalledWith("c1");
  });

  test("content：!path 400 / !c 404 / 命中整体透传", async () => {
    const deps = makeTemplatesDeps();
    expect(await invokeTemplate("op:templates:content", {}, deps))
      .toEqual({ ok: false, status: 400, data: { error: "path required" } });
    expect(await invokeTemplate("op:templates:content", { query: { path: "nope" } }, makeTemplatesDeps({ getTemplateContent: vi.fn(() => null) })))
      .toEqual({ ok: false, status: 404, data: { error: "not found" } });
    expect(await invokeTemplate("op:templates:content", { query: { path: "templates/a.html" } }, deps))
      .toEqual({ ok: true, status: 200, data: { type: "markdown", content: "# t" } });
  });

  test("generate-notice：{ ok, name } / catch 500", async () => {
    const deps = makeTemplatesDeps();
    expect(await invokeTemplate("op:templates:generate-notice", { body: { title: "通知" } }, deps))
      .toEqual({ ok: true, status: 200, data: { ok: true, name: "会议通知.docx" } });
    const failing = makeTemplatesDeps({ generateNotice: vi.fn(async () => { throw new Error("模板缺失"); }) });
    expect(await invokeTemplate("op:templates:generate-notice", {}, failing))
      .toEqual({ ok: false, status: 500, data: { error: "模板缺失" } });
  });

  test("file：marker 截取 + .. / 前导 / 400 + 双根前缀过滤 find + 404 + mime", async () => {
    const deps = makeTemplatesDeps();
    expect(await invokeTemplate("op:templates:file", { params: { path: "D:/x/templates/a.html" } }, deps))
      .toEqual({ ok: true, status: 200, data: { mime: "text/html; charset=utf-8", base64: "PD94bWw+" } });
    expect((deps.fs.existsSync as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe("D:\\proj\\templates\\a.html");
    for (const bad of ["..\\x", "/abs"]) {
      expect((await invokeTemplate("op:templates:file", { params: { path: bad } }, deps)).status).toBe(400);
    }
    expect(await invokeTemplate("op:templates:file", { params: { path: "templates/missing.html" } }, deps))
      .toEqual({ ok: false, status: 404, data: { error: "file not found" } });
    // 双根语义：templates/ 前缀 relPath 归 projectDir 候选（缺失即 404，不回退 tplRoot）；
    // _ 前缀 relPath 被 tplRoot/_ 候选接住（前缀过滤 find，非首个存在者）
    expect((await invokeTemplate("op:templates:file", { params: { path: "_报告模板/b.docx" } }, deps)).data)
      .toEqual({ mime: "application/octet-stream", base64: "PD94bWw+" });
  });

  test("files：.. / 前导 / 盘符 400 → TPL_ROOT 直拼 + 404 + mime", async () => {
    const deps = makeTemplatesDeps();
    for (const bad of ["..\\x", "/abs", "D:\\evil"]) {
      expect((await invokeTemplate("op:templates:files", { params: { path: bad } }, deps)).status).toBe(400);
    }
    expect(await invokeTemplate("op:templates:files", { params: { path: "_报告模板/b.docx" } }, deps))
      .toEqual({ ok: true, status: 200, data: { mime: "application/octet-stream", base64: "PD94bWw+" } });
    expect((deps.fs.existsSync as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]).toBe("D:\\_报告模板\\b.docx");
    expect(await invokeTemplate("op:templates:files", { params: { path: "_报告模板/missing.docx" } }, deps))
      .toEqual({ ok: false, status: 404, data: { error: "file not found" } });
  });
});
