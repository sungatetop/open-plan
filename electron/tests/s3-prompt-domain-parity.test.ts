/**
 * S3-3 域件对拍（prompt 主链三个新域件）。
 *
 * 覆盖面：
 *   - workflows.ts ↔ server/workflows.mjs 全函数对拍（listWorkflows/getWorkflow/
 *     workflowIdFromText/workflowSteps，纯函数同输入深比较）；
 *   - skills-catalog.ts（server/index.mjs L2403-2522 转录，legacy 内联不可导入 →
 *     行为测试 + 行号锚点）：classifySkill 分类顺序 / skillRoots 结构 / scanSkills
 *     fixture 扫描（frontmatter 描述、来源标签、首根去重、排序、非目录与非 SKILL.md
 *     跳过）/ 根签名失效与 30s TTL 缓存 / preflightSkills（ready·missing·invalid·
 *     工作流依赖·去重·对象名归一）；
 *   - workspace-write-probe.ts：evaluateWorkspaceWrite ↔ server/run-evaluation.mjs
 *     L59-84 同根对拍（成功逐字段相等 + 失败结构相等）；requireWorkspaceWriteForTask
 *     （server/index.mjs L938-953 转录）：chat 不探针 / saveToWorkspace=false 跳过 /
 *     agent·review 探针通过并回填 workspaceWrite / 失败归一 WORKSPACE_WRITE_UNAVAILABLE
 *     + writeAccess + 503 映射。
 *
 * 环境注入：PI_AGENT_DIR / USERPROFILE 在动态导入前指向 tmp fixture（skills-catalog
 * 的 AGENT_DIR 经 pi-config-management 解析，skillRoots 在调用期读 USERPROFILE；
 * 仓库根 .claude/skills 真实存在，断言一律按 fixture 名过滤）。
 */
import { describe, expect, test, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { planTaskCapabilities } from "../src/shared/runtime/task";
import { workspaceWriteHttpStatus } from "../src/main/backend/file-permission-error";

type WorkflowsModule = typeof import("../src/main/backend/agent/workflows");
type LegacyWorkflows = typeof import("@legacy-server/workflows.mjs");
type CatalogModule = typeof import("../src/main/backend/agent/skills-catalog");
type ProbeModule = typeof import("../src/main/backend/workspace-write-probe");
type LegacyEval = typeof import("@legacy-server/run-evaluation.mjs");

let wf: WorkflowsModule;
let legacyWf: LegacyWorkflows;
let catalog: CatalogModule;
let probe: ProbeModule;
let legacyEval: LegacyEval;
let workspace: typeof import("../src/main/backend/workspace");

let tmp = "";
let skillRoot0 = "";
let wsRoot = "";

const FIXTURE_NAMES = ["dup-skill", "skill-alpha", "skill-beta", "skill-empty"];

function writeSkill(root: string, name: string, body: string): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), body, "utf8");
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "s3domain-"));
  skillRoot0 = path.join(tmp, "agent", "skills");
  const agentRoot = path.join(tmp, "agent");
  const userRoot = path.join(tmp, "user");
  fs.mkdirSync(skillRoot0, { recursive: true });
  wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "s3domain-ws-"));
  // fixture：agent 根（pi-agent 来源）与用户 .agents 根（agents 来源）
  writeSkill(skillRoot0, "skill-alpha", "---\nname: skill-alpha\ndescription: 交通规划分析工具\n---\n正文");
  writeSkill(skillRoot0, "skill-empty", "");
  writeSkill(skillRoot0, "dup-skill", "---\ndescription: dup from root0\n---\n正文");
  writeSkill(path.join(userRoot, ".agents", "skills"), "skill-beta", "---\ndescription: 生成配图 poster\n---\n正文");
  writeSkill(path.join(userRoot, ".agents", "skills"), "dup-skill", "---\ndescription: dup from root1\n---\n正文");
  // 跳过面：无 SKILL.md 的目录 + 普通文件
  fs.mkdirSync(path.join(skillRoot0, "skill-noskill"), { recursive: true });
  fs.writeFileSync(path.join(skillRoot0, "plainfile.txt"), "not a skill", "utf8");

  process.env.PI_AGENT_DIR = agentRoot;
  process.env.USERPROFILE = userRoot;

  wf = await import("../src/main/backend/agent/workflows");
  legacyWf = await import("@legacy-server/workflows.mjs");
  probe = await import("../src/main/backend/workspace-write-probe");
  legacyEval = await import("@legacy-server/run-evaluation.mjs");
  catalog = await import("../src/main/backend/agent/skills-catalog");
  workspace = await import("../src/main/backend/workspace");
  catalog.resetSkillsCacheForTest();
});

afterAll(() => {
  delete process.env.PI_AGENT_DIR;
  delete process.env.USERPROFILE;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(wsRoot, { recursive: true, force: true }); } catch {}
});

// ---------- workflows ↔ legacy 对拍 ----------

describe("S3-3 workflows 对拍（server/workflows.mjs）", () => {
  const skillNameSets: unknown[][] = [
    [],
    [{ name: "huashu-research" }],
    [{ name: "huashu-research" }, { name: "traffic-report-comprehensive" }, { name: "traffic-charts-template" }, { name: "huashu-md-to-pdf" }],
    [{ name: "od-workflow" }, { name: "huashu-data-pro" }, { name: "transport-chart-composition" }, { name: "traffic-map-template" }]
  ];

  test("listWorkflows：四条内置声明 + available/missing/valid 投影逐字段相等", () => {
    for (const skills of skillNameSets) {
      expect(JSON.parse(JSON.stringify(wf.listWorkflows(skills as never))))
        .toEqual(JSON.parse(JSON.stringify(legacyWf.listWorkflows(skills as never))));
    }
    expect(wf.listWorkflows(skillNameSets[0] as never)).toHaveLength(4);
  });

  test("getWorkflow：命中与未命中（null）对拍", () => {
    expect(wf.getWorkflow("wf-plan-doc", skillNameSets[2] as never))
      .toEqual(legacyWf.getWorkflow("wf-plan-doc", skillNameSets[2]));
    expect(wf.getWorkflow("wf-nope", skillNameSets[0] as never)).toBeNull();
    expect(legacyWf.getWorkflow("wf-nope", skillNameSets[0])).toBeNull();
  });

  test("workflowIdFromText：提及提取与裁剪对拍", () => {
    for (const text of ["@工作流[wf-plan-doc] 帮我", " @工作流[ wf-od-analysis ] x", "没有标记", "@工作流[]", ""]) {
      expect(wf.workflowIdFromText(text)).toEqual(legacyWf.workflowIdFromText(text));
    }
    expect(wf.workflowIdFromText(" @工作流[ wf-od-analysis ] x")).toBe("wf-od-analysis");
    expect(wf.workflowIdFromText("没有标记")).toBeNull();
  });

  test("workflowSteps：步骤投影与空入参对拍", () => {
    const declaration = wf.getWorkflow("wf-bus-plan", skillNameSets[0] as never);
    expect(wf.workflowSteps(declaration)).toEqual(legacyWf.workflowSteps(declaration));
    expect(wf.workflowSteps(null)).toEqual(legacyWf.workflowSteps(null));
    expect(wf.workflowSteps(declaration)?.[0]).toMatchObject({ id: "wf-bus-plan:step-1", status: "ready", attempts: 0 });
  });
});

// ---------- skills-catalog（转录行为测试；legacy 内联于 index.mjs 不可导入） ----------

describe("S3-3 skills-catalog 分类与根目录（server/index.mjs L2403-2445）", () => {
  test("classifySkill：按声明顺序命中分类，未命中归 other", () => {
    expect(catalog.classifySkill("交通报告生成", "")).toBe("traffic");
    expect(catalog.classifySkill("skill-od", "OD 客流分析")).toBe("traffic");
    expect(catalog.classifySkill("doc-writer", "撰写研究报告")).toBe("doc");
    expect(catalog.classifySkill("chart-kit", "可视化图表 dashboard")).toBe("chart");
    // “配图”含“图”，chart 先于 image 命中（与 server 分类序同构）；纯海报/封面才归 image
    expect(catalog.classifySkill("poster", "生成配图 封面")).toBe("chart");
    expect(catalog.classifySkill("poster", "海报 封面")).toBe("image");
    expect(catalog.classifySkill("tts", "配音 字幕 脚本")).toBe("media");
    expect(catalog.classifySkill("excel", "xlsx 表格")).toBe("office");
    expect(catalog.classifySkill("debug", "test git 部署")).toBe("dev");
    expect(catalog.classifySkill("research", "文献调研")).toBe("research");
    expect(catalog.classifySkill("xyz", "")).toBe("other");
  });

  test("skillRoots：7 个根，首根 AGENT_DIR/skills，含 USERPROFILE 与 PROJECT_DIR 锚点", () => {
    const roots = catalog.skillRoots();
    expect(roots).toHaveLength(7);
    expect(roots[0]).toBe(path.join(workspace.AGENT_DIR, "skills"));
    expect(roots[1]).toBe(path.join(tmp, "user", ".agents", "skills"));
    expect(roots[2]).toBe(path.join(tmp, "user", ".claude", "skills"));
    expect(roots[3]).toBe(path.join(workspace.PROJECT_DIR, ".agents", "skills"));
    expect(roots[5]).toBe(path.join(workspace.PROJECT_DIR, ".claude", "skills"));
    expect(roots[6]).toBe(path.resolve(workspace.PROJECT_DIR, "..", ".claude", "skills"));
  });
});

describe("S3-3 skills-catalog scanSkills 扫描与缓存（server/index.mjs L2447-2486）", () => {
  test("fixture 扫描：frontmatter 描述 / 来源标签 / 首根去重 / 排序 / 跳过面", () => {
    const entries = catalog.scanSkills();
    const fixture = entries.filter((e) => FIXTURE_NAMES.includes(e.name));
    expect(fixture.map((e) => e.name)).toEqual(FIXTURE_NAMES);
    const byName = new Map(fixture.map((e) => [e.name, e]));
    expect(byName.get("skill-alpha")).toMatchObject({
      description: "交通规划分析工具", path: path.join(skillRoot0, "skill-alpha"),
      source: "pi-agent", category: "traffic"
    });
    expect(byName.get("skill-beta")).toMatchObject({
      description: "生成配图 poster", path: path.join(tmp, "user", ".agents", "skills", "skill-beta"),
      source: "agents", category: "chart"
    });
    // 首根去重：root0 的 dup-skill 胜出
    expect(byName.get("dup-skill")).toMatchObject({ path: path.join(skillRoot0, "dup-skill"), source: "pi-agent" });
    expect(byName.get("skill-empty")).toMatchObject({ description: "", category: "dev" });
    expect(entries.some((e) => e.name === "skill-noskill")).toBe(false);
    expect(entries.some((e) => e.name === "plainfile.txt")).toBe(false);
    // path 指向目录
    for (const entry of fixture) expect(fs.statSync(entry.path).isDirectory()).toBe(true);
  });

  test("缓存：签名不变复用同一引用；根 mtime 变化触发重扫；30s TTL 过期重扫", () => {
    catalog.resetSkillsCacheForTest();
    const r1 = catalog.scanSkills();
    const r2 = catalog.scanSkills();
    expect(r2).toBe(r1);

    // 根签名失效：新增技能目录 + 显式推进 mtime
    writeSkill(skillRoot0, "skill-gamma", "---\ndescription: gamma\n---\n正文");
    const future = new Date(Date.now() + 10_000);
    fs.utimesSync(skillRoot0, future, future);
    const r3 = catalog.scanSkills();
    expect(r3).not.toBe(r2);
    expect(r3.some((e) => e.name === "skill-gamma")).toBe(true);

    const r4 = catalog.scanSkills();
    expect(r4).toBe(r3);

    // TTL 过期：签名不变、时间推进 31s → 重扫
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 31_000);
      const r5 = catalog.scanSkills();
      expect(r5).not.toBe(r4);
      expect(r5.map((e) => e.name)).toEqual(r4.map((e) => e.name));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("S3-3 skills-catalog preflightSkills 预检（server/index.mjs L2488-2522）", () => {
  test("ready：目录/文件/可读/非空四检全过", () => {
    const result = catalog.preflightSkills({ requestedSkills: ["skill-alpha"] });
    expect(result.ok).toBe(true);
    expect(result.message).toBe("Skills 预检通过");
    expect(result.required).toEqual(["skill-alpha"]);
    expect(result.checks[0]).toMatchObject({
      name: "skill-alpha", ok: true, status: "ready",
      path: path.join(skillRoot0, "skill-alpha"),
      checks: { directory: true, file: true, readable: true, nonEmpty: true },
      message: "SKILL.md 可读取"
    });
    expect(result.missing).toEqual([]);
  });

  test("missing：未在目录中 → status missing；invalid：SKILL.md 为空 → status invalid", () => {
    const missing = catalog.preflightSkills({ requestedSkills: ["skill-nope"] });
    expect(missing.ok).toBe(false);
    expect(missing.checks[0]).toMatchObject({ name: "skill-nope", ok: false, status: "missing", message: "未找到该 skill" });
    expect(missing.missing).toEqual(["skill-nope"]);

    const invalid = catalog.preflightSkills({ requestedSkills: ["skill-empty"] });
    expect(invalid.ok).toBe(false);
    expect(invalid.checks[0]).toMatchObject({
      status: "invalid", checks: { directory: true, file: true, readable: true, nonEmpty: false },
      message: "SKILL.md 不存在、不可读取或为空"
    });
  });

  test("工作流依赖：valid 工作流四技能全过；缺技能工作流列出 missing；未知工作流报 工作流不存在", () => {
    // wf-od-analysis 的四个依赖以 fixture 目录形式落盘，显式注入（含真实 path 供四检）
    const odRoot = path.join(tmp, "agent", "skills");
    const odNames = ["od-workflow", "huashu-data-pro", "transport-chart-composition", "traffic-map-template"];
    for (const name of odNames) writeSkill(odRoot, name, `---\ndescription: ${name}\n---\n正文`);
    const odSkills = odNames.map((name) => ({
      name, description: name, path: path.join(odRoot, name), source: "pi-agent", category: "other"
    }));
    const valid = catalog.preflightSkills({ workflowId: "wf-od-analysis", skills: odSkills });
    expect(valid.ok).toBe(true);
    expect(valid.workflow).toEqual({ id: "wf-od-analysis", name: "OD 数据分析工作台", valid: true });
    expect(valid.required).toEqual(["od-workflow", "huashu-data-pro", "transport-chart-composition", "traffic-map-template"]);
    expect(valid.checks.every((c) => c.status === "ready")).toBe(true);

    const short = catalog.preflightSkills({ workflowId: "wf-plan-doc", skills: [] });
    expect(short.ok).toBe(false);
    expect(short.workflow).toEqual({ id: "wf-plan-doc", name: "规划报告全流程", valid: false });
    expect(short.missing).toEqual(["huashu-research", "traffic-report-comprehensive", "traffic-charts-template", "huashu-md-to-pdf"]);
    expect(short.message).toBe("Skills 预检未通过：huashu-research、traffic-report-comprehensive、traffic-charts-template、huashu-md-to-pdf");

    const unknown = catalog.preflightSkills({ workflowId: "wf-nope", skills: [] });
    expect(unknown.ok).toBe(false);
    expect(unknown.workflow).toEqual({ id: "wf-nope", valid: false });
    expect(unknown.missing).toEqual(["工作流不存在：wf-nope"]);
  });

  test("去重与对象名归一：requestedSkills 重复/对象形态归一为单名", () => {
    const result = catalog.preflightSkills({ requestedSkills: ["skill-alpha", { name: " skill-alpha " }, "skill-alpha"] });
    expect(result.required).toEqual(["skill-alpha"]);
    expect(result.checks).toHaveLength(1);
  });
});

// ---------- workspace-write-probe ----------

describe("S3-3 evaluateWorkspaceWrite 探针（server/run-evaluation.mjs L59-84 对拍）", () => {
  test("与 legacy 同根对拍：passed 结果逐字段相等，探针文件无残留", () => {
    const tsCheck = probe.evaluateWorkspaceWrite(wsRoot);
    const legacyCheck = legacyEval.evaluateWorkspaceWrite(wsRoot);
    expect(tsCheck).toEqual(legacyCheck);
    expect(tsCheck).toEqual({
      id: "workspace-write", label: "工作区写入", status: "passed",
      message: "当前服务进程已完成文件创建、修改、回读和删除探针",
      details: { probe: "create-modify-readback-delete", root: wsRoot, operations: ["create", "modify", "readback", "delete"] }
    });
    expect(fs.readdirSync(wsRoot).filter((n) => n.includes("写入探针"))).toEqual([]);
  });

  test("失败路径（根为文件）：TS/legacy 同为 create 阶段失败，结构一致", () => {
    const fileRoot = path.join(tmp, "probe-root-is-file");
    fs.writeFileSync(fileRoot, "not a directory", "utf8");
    const tsCheck = probe.evaluateWorkspaceWrite(fileRoot);
    const legacyCheck = legacyEval.evaluateWorkspaceWrite(fileRoot);
    expect(tsCheck.status).toBe("failed");
    expect(legacyCheck.status).toBe("failed");
    const tsDetails = tsCheck.details as { stage: string; code: unknown; probe: string };
    const legacyDetails = legacyCheck.details as { stage: string; code: unknown; probe: string };
    expect(tsDetails.stage).toBe(legacyDetails.stage);
    expect(tsDetails.stage).toBe("create");
    expect(tsDetails.code).toBe(legacyDetails.code);
    expect(tsDetails.probe).toBe(legacyDetails.probe);
    expect(tsCheck.message.startsWith("当前服务进程在create阶段无法完成工作区探针")).toBe(true);
    expect(legacyCheck.message.startsWith("当前服务进程在create阶段无法完成工作区探针")).toBe(true);
  });
});

describe("S3-3 requireWorkspaceWriteForTask 闸门（server/index.mjs L938-953 转录）", () => {
  test("chat 无产出 → null 且不回填 workspaceWrite", () => {
    const plan = planTaskCapabilities({ text: "你好", task: { mode: "chat" } });
    expect(plan.output.expected).toBe(false);
    expect(probe.requireWorkspaceWriteForTask(plan, wsRoot)).toBeNull();
    expect((plan as unknown as Record<string, unknown>).workspaceWrite).toBeUndefined();
  });

  test("saveToWorkspace=false → 跳过探针返回 null", () => {
    const plan = planTaskCapabilities({ text: "生成一份报告", task: { mode: "agent", output: { saveToWorkspace: false } } });
    expect(plan.output.expected).toBe(true);
    expect(probe.requireWorkspaceWriteForTask(plan, wsRoot)).toBeNull();
  });

  test("agent 产出任务 → 探针通过并回填 capabilityPlan.workspaceWrite", () => {
    const plan = planTaskCapabilities({ text: "生成一份报告", task: { mode: "agent" } });
    const check = probe.requireWorkspaceWriteForTask(plan, wsRoot);
    expect(check?.status).toBe("passed");
    expect((plan as unknown as Record<string, unknown>).workspaceWrite).toBe(check);
  });

  test("review 模式 → 无产出声明也强制探针", () => {
    const plan = planTaskCapabilities({ text: "审查这份材料", task: { mode: "review" } });
    expect(plan.output.expected).toBe(false);
    expect(probe.requireWorkspaceWriteForTask(plan, wsRoot)?.status).toBe("passed");
  });

  test("探针失败 → 抛 WORKSPACE_WRITE_UNAVAILABLE（挂 writeAccess，HTTP 503）", () => {
    const fileRoot = path.join(tmp, "gate-root-is-file");
    fs.writeFileSync(fileRoot, "not a directory", "utf8");
    const plan = planTaskCapabilities({ text: "生成一份报告", task: { mode: "agent" } });
    let thrown: (Error & { code?: string; writeAccess?: { status: string } }) | null = null;
    try {
      probe.requireWorkspaceWriteForTask(plan, fileRoot);
    } catch (error) {
      thrown = error as Error & { code?: string; writeAccess?: { status: string } };
    }
    expect(thrown?.code).toBe("WORKSPACE_WRITE_UNAVAILABLE");
    expect(thrown?.writeAccess?.status).toBe("failed");
    expect(workspaceWriteHttpStatus(thrown)).toBe(503);
  });
});
