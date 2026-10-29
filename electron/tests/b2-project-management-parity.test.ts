/**
 * B2-9 project-management 域：12 导出全族（projects.json 存储面 + 常量/画像策略 +
 * CRUD + 设置 + 工作区锚定 + 分类建议）。
 *
 * R6-7a 对拍退役改写：旧侧 server/project-management.mjs 物理路径动态 import 随
 * server/ 退役删除（等价性已在 B2-9 批对拍验收冻结），仅保留 modern
 * src/main/backend/project-management.ts 的同一套绝对断言；双侧 root/norm
 * （tmp 路径·实时时间戳归一）随之删除——排序类断言用注入固定时间戳的假项目
 * 规避实时创建同毫秒并列抖动（B2-2 教训）。
 *
 * PROJECTS_FILE 为模块加载期 env 锚点（OAW_PROJECTS_FILE）→ B2-3 stubEnv 模式：
 * beforeAll stubEnv（独立 mkdtmp json 落点）+ vi.resetModules() 重载 TS 依赖树
 * （workspace/persistence-utils）后动态 import。
 */
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MODERN_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "b2pm-md-"));
const TMP_ROOTS = [MODERN_ROOT];

let modern: any;

beforeAll(async () => {
  // 锚定 MODERN_ROOT 后重载整棵 TS 依赖树（模块加载期读 env）
  vi.stubEnv("OAW_PROJECTS_FILE", path.join(MODERN_ROOT, "projects.json"));
  vi.resetModules();
  modern = await import("../src/main/backend/project-management");
  vi.unstubAllEnvs();
});

afterAll(() => {
  for (const dir of TMP_ROOTS) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

/** 注入假项目清单（固定时间戳与 id 规避并列抖动）。 */
function seedProjects(entries: any[]): void {
  const seeded = entries.map((entry, index) => ({
    createdAt: `2026-01-0${(index % 9) + 1}T00:00:00.000Z`,
    updatedAt: `2026-02-0${(index % 9) + 1}T00:00:00.000Z`,
    ...entry,
  }));
  fs.writeFileSync(path.join(MODERN_ROOT, "projects.json"), JSON.stringify(seeded, null, 2));
}

/** 真实存在的工作区目录（normalizeWorkspace realpath 前提）。 */
function makeWorkspace(name: string): string {
  const dir = path.join(MODERN_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe("B2-9 project-management：常量面与画像策略", () => {
  it("listProjectTypes/Statuses/Profiles/defaultProjectSettings 绝对值", () => {
    expect(modern.listProjectTypes()).toEqual(["交通规划", "GIS / 地图分析", "调研报告", "Office 文档", "数据分析", "综合项目", "资料库"]);
    expect(modern.listProjectStatuses()).toEqual(["进行中", "待整理", "已完成", "已归档", "模板项目"]);
    expect(modern.listProjectProfiles()).toEqual(["通用 Agent", "创作", "研究", "Office", "GIS", "数据分析"]);
    expect(modern.defaultProjectSettings().agentProfile).toBe("通用 Agent");
    expect(modern.defaultProjectSettings().profilePolicy.maxContextTokens).toBe(64000);
  });

  it("profilePolicyFor：六画像全族 + 未知回退 + 数组拷贝不共享引用", () => {
    expect(["通用 Agent", "创作", "研究", "Office", "GIS", "数据分析"].map((p) => modern.profilePolicyFor(p).maxContextTokens))
      .toEqual([64000, 48000, 96000, 64000, 64000, 64000]);
    expect(modern.profilePolicyFor("未知画像").maxContextTokens).toBe(64000);
    expect(modern.profilePolicyFor("研究").maxContextTokens).toBe(96000);
    expect(modern.profilePolicyFor("GIS").approval).toBe("图层写入前确认");
    expect(modern.profilePolicyFor("Office").allowedModes).toEqual(["chat", "office", "agent"]);
    expect(modern.profilePolicyFor("A").preferredTools).not.toBe(modern.profilePolicyFor("A").preferredTools);
  });
});

describe("B2-9 project-management：createProject 与类型推断", () => {
  const ws = makeWorkspace("ws-create");

  it("正常创建（id 形态/字段归一）+ 空名 error + 目录不存在 error + existing 幂等", () => {
    const created = modern.createProject({ name: "交通干线分析", rootPath: ws });
    expect(created.ok).toBe(true);
    expect((created as any).project.id).toMatch(/^project-[0-9a-f]{12}$/);
    expect((created as any).project.type).toBe("交通规划");
    expect((created as any).project.settings.agentProfile).toBe("通用 Agent");
    expect(modern.createProject({ name: "  ", rootPath: ws })).toEqual({ ok: false, error: "项目名称不能为空" });
    expect(modern.createProject({ name: "x", rootPath: path.join(MODERN_ROOT, "no-such-dir") }))
      .toEqual({ ok: false, error: "项目工作区不存在或不是文件夹" });
    const again = modern.createProject({ name: "交通干线分析", rootPath: ws });
    expect((again as any).existing).toBe(true);
    expect((again as any).project.id).toBe((created as any).project.id);
  });

  it("inferType 族（经创建自动推断）：gis/地图/交通/报告/office/资料/综合兜底", () => {
    const cases: Array<[string, string]> = [
      ["gis-city", "GIS / 地图分析"],
      ["地图工具", "GIS / 地图分析"],
      ["公交线路 od", "交通规划"],
      ["调研报告 v2", "调研报告"],
      ["office 文档", "Office 文档"],
      ["资料库", "资料库"],
      ["综合项目", "综合项目"],
    ];
    for (const [name, expected] of cases) {
      const target = makeWorkspace(`t-${name}`);
      const created: any = modern.createProject({ name, rootPath: target });
      expect(created.project.type).toBe(expected);
    }
  });
});

describe("B2-9 project-management：ensureProjectForWorkspace", () => {
  it("新建 + 幂等复用同 id + 不存在路径 null + 缺 settings 补默认", () => {
    const ws1 = makeWorkspace("ws-ensure");
    const first: any = modern.ensureProjectForWorkspace(ws1, { name: "gis-空间项目", description: "d", pinned: true });
    expect(first.id).toMatch(/^project-[0-9a-f]{12}$/);
    expect(first.type).toBe("GIS / 地图分析");
    expect(first.pinned).toBe(true);
    expect(first.settings.profilePolicy.agentProfile ?? first.settings.profilePolicy.description).toBe("完整工具链，按任务计划执行");
    const again: any = modern.ensureProjectForWorkspace(ws1);
    expect(again.id).toBe(first.id);
    expect(modern.ensureProjectForWorkspace(path.join(MODERN_ROOT, "no-such"))).toBeNull();
    // 注入无 settings 记录 → ensure 补默认并写盘
    const ws2 = makeWorkspace("ws-ensure2");
    fs.writeFileSync(path.join(MODERN_ROOT, "projects.json"), JSON.stringify([{ id: "project-p1", name: "无设置项目", type: "综合项目", status: "进行中", rootPath: ws2, description: "", pinned: false, archivedAt: null }]), "utf8");
    const patched: any = modern.ensureProjectForWorkspace(ws2);
    expect(patched.settings.memoryPolicy).toBe("approval_required");
  });
});

describe("B2-9 project-management：listProjects / getProject / getProjectForWorkspace", () => {
  let wsA = "";
  beforeAll(() => {
    wsA = makeWorkspace("r-a");
    seedProjects([
      { id: "project-aaa", name: "甲项目", type: "交通规划", status: "进行中", rootPath: wsA, description: "", pinned: true, settings: { agentProfile: "GIS" }, archivedAt: null },
      { id: "project-bbb", name: "乙项目", type: "GIS / 地图分析", status: "已完成", rootPath: makeWorkspace("r-b"), description: "", pinned: false, settings: {}, archivedAt: null },
      { id: "project-ccc", name: "丙项目", type: "交通规划", status: "进行中", rootPath: makeWorkspace("r-c"), description: "", pinned: false, settings: {}, archivedAt: null },
    ]);
  });

  it("listProjects 全量 + 过滤 type/status/pinned + 排序 name/created/recent + 默认工作区注入", () => {
    expect(modern.listProjects().some((p: any) => p.name === "默认工作区")).toBe(true);
    expect(modern.listProjects({ type: "交通规划" }).map((p: any) => p.id).sort()).toEqual(["project-aaa", "project-ccc"]);
    expect(modern.listProjects({ status: "已完成" }).map((p: any) => p.id)).toEqual(["project-bbb"]);
    expect(modern.listProjects({ pinned: true }).map((p: any) => p.id)).toEqual(["project-aaa"]);
    // pinned 优先于排序键（L185）：pinned 的甲项目恒排首，其余按 name 升序（拼音 丙<默<乙）
    const names = modern.listProjects({ sort: "name" }).map((p: any) => p.name);
    expect(names).toHaveLength(4);
    expect(names[0]).toBe("甲项目");
    for (let i = 2; i < names.length; i += 1) {
      expect(names[i - 1].localeCompare(names[i])).toBeLessThanOrEqual(0);
    }
    // created 降序：pinned 首位 + 默认工作区（实时 now）> ccc(01-03) > bbb(01-02)
    const createdIds = modern.listProjects({ sort: "created" }).map((p: any) => p.id);
    expect(createdIds[0]).toBe("project-aaa");
    expect(createdIds.slice(1)).toEqual([expect.any(String), "project-ccc", "project-bbb"]);
    const pinnedIds = modern.listProjects({ sort: "name" }).filter((p: any) => p.pinned).map((p: any) => p.id);
    expect(pinnedIds).toEqual(["project-aaa"]);
  });

  it("getProject：命中/未知 id null；getProjectForWorkspace：命中/未命中/非法路径 null", () => {
    expect(modern.getProject("project-bbb").id).toBe("project-bbb");
    expect(modern.getProject("no-such-id")).toBeNull();
    expect(modern.getProject("")).toBeNull();
    expect((modern.getProjectForWorkspace(wsA) as any).id).toBe("project-aaa");
    expect(modern.getProjectForWorkspace(path.join(MODERN_ROOT, "no-such-dir"))).toBeNull();
  });
});

describe("B2-9 project-management：updateProject / 设置面 / archiveProject", () => {
  beforeAll(() => {
    seedProjects([
      { id: "project-upd", name: "原项目", type: "综合项目", status: "进行中", rootPath: makeWorkspace("r-upd"), description: "原描述", pinned: false, settings: { defaultModel: "m1" }, archivedAt: null },
    ]);
  });

  it("updateProject：name/type/status/description/pinned/settings 合并 + 非法白名单不动 + 未找到 error", () => {
    const patch = { name: "改 projects", type: "GIS / 地图分析", status: "待整理", description: "新描述", pinned: true, settings: { defaultModel: "m2", memoryPolicy: "manual", skills: ["a", "a", "b"] } };
    modern.updateProject("project-upd", patch);
    const updated: any = modern.getProject("project-upd");
    expect(updated.name).toBe("改 projects");
    expect(updated.type).toBe("GIS / 地图分析");
    expect(updated.status).toBe("待整理");
    expect(updated.description).toBe("新描述");
    expect(updated.pinned).toBe(true);
    expect(updated.settings.defaultModel).toBe("m2");
    expect(updated.settings.memoryPolicy).toBe("manual");
    expect(updated.settings.skills).toEqual(["a", "b"]);
    modern.updateProject("project-upd", { type: "非法类型", status: "非法状态" });
    expect(modern.getProject("project-upd").type).toBe("GIS / 地图分析");
    expect(modern.updateProject("no-such-id", { name: "x" })).toEqual({ ok: false, error: "project not found" });
  });

  it("archiveProject：归档置 archivedAt、取消归档清空", () => {
    modern.archiveProject("project-upd", true);
    expect(modern.getProject("project-upd").status).toBe("已归档");
    expect(modern.getProject("project-upd").archivedAt).toBeTruthy();
    modern.archiveProject("project-upd", false);
    expect(modern.getProject("project-upd").archivedAt).toBeNull();
  });

  it("getProjectSettings：默认合并读取；updateProjectSettings：patch 后 settings 透出", () => {
    expect(modern.getProjectSettings("project-upd").artifactPolicy).toBe("validation_required");
    expect(modern.getProjectSettings("no-such-id")).toBeNull();
    modern.updateProjectSettings("project-upd", { artifactPolicy: "manual" });
    expect(modern.getProjectSettings("project-upd").artifactPolicy).toBe("manual");
  });
});

describe("B2-9 project-management：classifyProjects", () => {
  beforeAll(() => {
    seedProjects([
      { id: "project-c1", name: "gis-map 工具", type: "综合项目", rootPath: makeWorkspace("r-c1"), status: "进行中", pinned: false, settings: {}, archivedAt: null },
      { id: "project-c2", name: "已分类", type: "调研报告", rootPath: makeWorkspace("r-c2"), status: "进行中", pinned: false, settings: {}, archivedAt: null },
    ]);
  });

  it("预览模式（apply=false）：只出建议不写盘", () => {
    const preview: any = modern.classifyProjects();
    expect(preview.applied).toBe(false);
    expect(preview.changes.find((c: any) => c.id === "project-c1")).toMatchObject({ currentType: "综合项目", suggestedType: "GIS / 地图分析", changed: true, applied: false });
    expect(preview.changes.find((c: any) => c.id === "project-c2")).toMatchObject({ currentType: "调研报告", suggestedType: "调研报告", changed: false });
    expect(modern.getProject("project-c1").type).toBe("综合项目");
  });

  it("apply 模式：写盘更新 type + applied 标记", () => {
    const applied: any = modern.classifyProjects({ apply: true });
    expect(applied.applied).toBe(true);
    expect(applied.changes.find((c: any) => c.id === "project-c1").applied).toBe(true);
    expect(modern.getProject("project-c1").type).toBe("GIS / 地图分析");
  });
});
