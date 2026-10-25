/**
 * B2-9 project-management 域对拍：12 导出全族（projects.json 存储面 + 常量/画像策略 +
 * CRUD + 设置 + 工作区锚定 + 分类建议）。
 *
 * PROJECTS_FILE 为模块加载期 env 锚点（OAW_PROJECTS_FILE）→ B2-3 stubEnv 模式：
 * beforeAll 分次 stubEnv（各侧独立 mkdtmp json 落点）后双侧动态 import（旧侧物理路径
 * 加载 .mjs 依赖树、新侧 vi.resetModules() 重载 TS 依赖树 workspace/persistence-utils），
 * runBoth 同脚本双侧执行；项目对象含实时时间戳 → norm 归一 createdAt/updatedAt/archivedAt，
 * 其余（id 由 rootPath sha1 确定性生成）全量比对；排序类断言用注入固定时间戳的假项目
 * 规避实时创建同毫秒并列抖动（B2-2 教训）。
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { vi } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "../..");

let legacy: any;
let modern: any;
const TMP_ROOTS: string[] = [];

function makeRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2pm-"));
  TMP_ROOTS.push(dir);
  return dir;
}

/** 归一实时时间戳字段与各侧 tmp 派生值（id=sha1(rootPath)、rootPath 字符串），两侧独立 now()/tmp 不逐值比对。 */
function norm(value: any): any {
  if (typeof value === "string") {
    const scrubbed = value.split(LEGACY_ROOT).join("ROOT").split(MODERN_ROOT).join("ROOT");
    return scrubbed.replace(/^project-[0-9a-f]{12}$/, "project-H");
  }
  if (Array.isArray(value)) return value.map(norm);
  if (value && typeof value === "object") {
    const out: any = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = k === "createdAt" || k === "updatedAt" || k === "archivedAt" ? "T" : norm(v);
    }
    return out;
  }
  return value;
}

/** 双侧分侧注入假项目清单（rootPath 按各自侧真实目录生成；固定时间戳与 id 规避并列抖动）。 */
function seedProjects(entriesFn: (root: string) => any[]): void {
  const seeded = (root: string) => entriesFn(root).map((entry, index) => ({
    createdAt: `2026-01-0${(index % 9) + 1}T00:00:00.000Z`,
    updatedAt: `2026-02-0${(index % 9) + 1}T00:00:00.000Z`,
    ...entry,
  }));
  writeProjects(LEGACY_ROOT, seeded(LEGACY_ROOT));
  writeProjects(MODERN_ROOT, seeded(MODERN_ROOT));
}

/** 单侧写 projects.json（rootPath 不同的记录分侧注入）。 */
function writeProjects(root: string, entries: any[]): void {
  fs.writeFileSync(path.join(root, "projects.json"), JSON.stringify(entries, null, 2));
}

/** 真实存在的工作区目录（normalizeWorkspace realpath 前提）。 */
function makeWorkspace(parent: string, name: string): string {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const LEGACY_ROOT = makeRoot();
const MODERN_ROOT = makeRoot();

beforeAll(async () => {
  // 旧侧：锚定 LEGACY_ROOT 后物理路径加载（模块加载期读 env）
  vi.stubEnv("OAW_PROJECTS_FILE", path.join(LEGACY_ROOT, "projects.json"));
  legacy = await import(pathToFileURL(path.join(PROJECT_ROOT, "server", "project-management.mjs")).href);
  // 新侧：换锚 MODERN_ROOT 后重载整棵 TS 依赖树
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

describe("B2-9 对拍：常量面与画像策略", () => {
  it("listProjectTypes/Statuses/Profiles/defaultProjectSettings 绝对值", () => {
    expect(modern.listProjectTypes()).toEqual(legacy.listProjectTypes());
    expect(modern.listProjectStatuses()).toEqual(legacy.listProjectStatuses());
    expect(modern.listProjectProfiles()).toEqual(legacy.listProjectProfiles());
    expect(modern.defaultProjectSettings()).toEqual(legacy.defaultProjectSettings());
    expect(modern.listProjectTypes()).toEqual(["交通规划", "GIS / 地图分析", "调研报告", "Office 文档", "数据分析", "综合项目", "资料库"]);
    expect(modern.defaultProjectSettings().agentProfile).toBe("通用 Agent");
    expect(modern.defaultProjectSettings().profilePolicy.maxContextTokens).toBe(64000);
  });

  it("profilePolicyFor：六画像全族 + 未知回退 + 数组拷贝不共享引用", () => {
    for (const profile of ["通用 Agent", "创作", "研究", "Office", "GIS", "数据分析", "未知画像"]) {
      expect(norm(modern.profilePolicyFor(profile))).toEqual(norm(legacy.profilePolicyFor(profile)));
    }
    expect(modern.profilePolicyFor("未知画像").maxContextTokens).toBe(64000);
    expect(modern.profilePolicyFor("研究").maxContextTokens).toBe(96000);
    expect(modern.profilePolicyFor("GIS").approval).toBe("图层写入前确认");
    expect(modern.profilePolicyFor("Office").allowedModes).toEqual(["chat", "office", "agent"]);
    expect(modern.profilePolicyFor("A").preferredTools).not.toBe(modern.profilePolicyFor("A").preferredTools);
  });
});

describe("B2-9 对拍：createProject 与类型推断", () => {
  const legacyWs = makeWorkspace(LEGACY_ROOT, "ws-create");
  const modernWs = makeWorkspace(MODERN_ROOT, "ws-create");

  it("正常创建（id 形态/字段归一）+ 空名 error + 目录不存在 error + existing 幂等", () => {
    const created = modern.createProject({ name: "交通干线分析", rootPath: modernWs });
    expect(norm(created)).toEqual(norm(legacy.createProject({ name: "交通干线分析", rootPath: legacyWs })));
    expect(created.ok).toBe(true);
    expect((created as any).project.id).toMatch(/^project-[0-9a-f]{12}$/);
    expect((created as any).project.type).toBe("交通规划");
    expect((created as any).project.settings.agentProfile).toBe("通用 Agent");
    expect(modern.createProject({ name: "  ", rootPath: modernWs })).toEqual({ ok: false, error: "项目名称不能为空" });
    expect(modern.createProject({ name: "x", rootPath: path.join(MODERN_ROOT, "no-such-dir") }))
      .toEqual({ ok: false, error: "项目工作区不存在或不是文件夹" });
    const again = modern.createProject({ name: "交通干线分析", rootPath: modernWs });
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
      const ws = makeWorkspace(MODERN_ROOT, `t-${name}`);
      const lws = makeWorkspace(LEGACY_ROOT, `t-${name}`);
      const created: any = modern.createProject({ name, rootPath: ws });
      expect(norm(created)).toEqual(norm(legacy.createProject({ name, rootPath: lws })));
      expect(created.project.type).toBe(expected);
    }
  });
});

describe("B2-9 对拍：ensureProjectForWorkspace", () => {
  it("新建 + 幂等复用同 id + 不存在路径 null + 缺 settings 补默认", () => {
    const lws = makeWorkspace(LEGACY_ROOT, "ws-ensure");
    const mws = makeWorkspace(MODERN_ROOT, "ws-ensure");
    const first: any = modern.ensureProjectForWorkspace(mws, { name: "gis-空间项目", description: "d", pinned: true });
    const lfirst: any = legacy.ensureProjectForWorkspace(lws, { name: "gis-空间项目", description: "d", pinned: true });
    expect(norm(first)).toEqual(norm(lfirst));
    expect(first.id).toMatch(/^project-[0-9a-f]{12}$/);
    expect(first.type).toBe("GIS / 地图分析");
    expect(first.pinned).toBe(true);
    expect(first.settings.profilePolicy.agentProfile ?? first.settings.profilePolicy.description).toBe("完整工具链，按任务计划执行");
    const again: any = modern.ensureProjectForWorkspace(mws);
    expect(again.id).toBe(first.id);
    expect(norm(again)).toEqual(norm(legacy.ensureProjectForWorkspace(lws)));
    expect(modern.ensureProjectForWorkspace(path.join(MODERN_ROOT, "no-such"))).toBeNull();
    // 注入无 settings 记录（rootPath 分侧）→ ensure 补默认并写盘
    const lws2 = makeWorkspace(LEGACY_ROOT, "ws-ensure2");
    const mws2 = makeWorkspace(MODERN_ROOT, "ws-ensure2");
    writeProjects(LEGACY_ROOT, [{ id: "project-p1", name: "无设置项目", type: "综合项目", status: "进行中", rootPath: lws2, description: "", pinned: false, archivedAt: null }]);
    writeProjects(MODERN_ROOT, [{ id: "project-p1", name: "无设置项目", type: "综合项目", status: "进行中", rootPath: mws2, description: "", pinned: false, archivedAt: null }]);
    const patched: any = modern.ensureProjectForWorkspace(mws2);
    expect(norm(patched)).toEqual(norm(legacy.ensureProjectForWorkspace(lws2)));
    expect(patched.settings.memoryPolicy).toBe("approval_required");
  });
});

describe("B2-9 对拍：listProjects / getProject / getProjectForWorkspace", () => {
  let wsAL = "";
  let wsAM = "";
  beforeAll(() => {
    wsAL = makeWorkspace(LEGACY_ROOT, "r-a");
    wsAM = makeWorkspace(MODERN_ROOT, "r-a");
    seedProjects((root) => [
      { id: "project-aaa", name: "甲项目", type: "交通规划", status: "进行中", rootPath: root === LEGACY_ROOT ? wsAL : wsAM, description: "", pinned: true, settings: { agentProfile: "GIS" }, archivedAt: null },
      { id: "project-bbb", name: "乙项目", type: "GIS / 地图分析", status: "已完成", rootPath: makeWorkspace(root, "r-b"), description: "", pinned: false, settings: {}, archivedAt: null },
      { id: "project-ccc", name: "丙项目", type: "交通规划", status: "进行中", rootPath: makeWorkspace(root, "r-c"), description: "", pinned: false, settings: {}, archivedAt: null },
    ]);
  });

  it("listProjects 全量 + 过滤 type/status/pinned + 排序 name/created/recent + 默认工作区注入", () => {
    expect(norm(modern.listProjects())).toEqual(norm(legacy.listProjects()));
    expect(modern.listProjects().some((p: any) => p.name === "默认工作区")).toBe(true);
    expect(norm(modern.listProjects({ type: "交通规划" }))).toEqual(norm(legacy.listProjects({ type: "交通规划" })));
    expect(norm(modern.listProjects({ status: "已完成" }))).toEqual(norm(legacy.listProjects({ status: "已完成" })));
    expect(norm(modern.listProjects({ pinned: true }))).toEqual(norm(legacy.listProjects({ pinned: true })));
    expect(modern.listProjects({ sort: "name" }).map((p: any) => p.name)).toEqual(legacy.listProjects({ sort: "name" }).map((p: any) => p.name));
    expect(modern.listProjects({ sort: "created" }).map((p: any) => p.id)).toEqual(legacy.listProjects({ sort: "created" }).map((p: any) => p.id));
    const pinnedIds = modern.listProjects({ sort: "name" }).filter((p: any) => p.pinned).map((p: any) => p.id);
    expect(pinnedIds).toEqual(["project-aaa"]);
  });

  it("getProject：命中/未知 id null；getProjectForWorkspace：命中/未命中/非法路径 null", () => {
    expect(norm(modern.getProject("project-bbb"))).toEqual(norm(legacy.getProject("project-bbb")));
    expect(modern.getProject("no-such-id")).toBeNull();
    expect(modern.getProject("")).toBeNull();
    expect(norm(modern.getProjectForWorkspace(wsAM))).toEqual(norm(legacy.getProjectForWorkspace(wsAL)));
    expect((modern.getProjectForWorkspace(wsAM) as any).id).toBe("project-aaa");
    expect(modern.getProjectForWorkspace(path.join(MODERN_ROOT, "no-such-dir"))).toBeNull();
  });
});

describe("B2-9 对拍：updateProject / 设置面 / archiveProject", () => {
  beforeAll(() => {
    seedProjects((root) => [
      { id: "project-upd", name: "原项目", type: "综合项目", status: "进行中", rootPath: makeWorkspace(root, "r-upd"), description: "原描述", pinned: false, settings: { defaultModel: "m1" }, archivedAt: null },
    ]);
  });

  it("updateProject：name/type/status/description/pinned/settings 合并 + 非法白名单不动 + 未找到 error", () => {
    const patch = { name: "改 projects", type: "GIS / 地图分析", status: "待整理", description: "新描述", pinned: true, settings: { defaultModel: "m2", memoryPolicy: "manual", skills: ["a", "a", "b"] } };
    expect(norm(modern.updateProject("project-upd", patch))).toEqual(norm(legacy.updateProject("project-upd", patch)));
    const updated: any = modern.getProject("project-upd");
    expect(updated.name).toBe("改 projects");
    expect(updated.type).toBe("GIS / 地图分析");
    expect(updated.settings.defaultModel).toBe("m2");
    expect(updated.settings.memoryPolicy).toBe("manual");
    expect(updated.settings.skills).toEqual(["a", "b"]);
    expect(norm(modern.updateProject("project-upd", { type: "非法类型", status: "非法状态" })))
      .toEqual(norm(legacy.updateProject("project-upd", { type: "非法类型", status: "非法状态" })));
    expect(modern.getProject("project-upd").type).toBe("GIS / 地图分析");
    expect(modern.updateProject("no-such-id", { name: "x" })).toEqual({ ok: false, error: "project not found" });
  });

  it("archiveProject：归档置 archivedAt、取消归档清空", () => {
    expect(norm(modern.archiveProject("project-upd", true))).toEqual(norm(legacy.archiveProject("project-upd", true)));
    expect(modern.getProject("project-upd").status).toBe("已归档");
    expect(modern.getProject("project-upd").archivedAt).toBeTruthy();
    expect(norm(modern.archiveProject("project-upd", false))).toEqual(norm(legacy.archiveProject("project-upd", false)));
    expect(modern.getProject("project-upd").archivedAt).toBeNull();
  });

  it("getProjectSettings：默认合并读取；updateProjectSettings：patch 后 settings 透出", () => {
    expect(norm(modern.getProjectSettings("project-upd"))).toEqual(norm(legacy.getProjectSettings("project-upd")));
    expect(modern.getProjectSettings("no-such-id")).toBeNull();
    expect(norm(modern.updateProjectSettings("project-upd", { artifactPolicy: "manual" })))
      .toEqual(norm(legacy.updateProjectSettings("project-upd", { artifactPolicy: "manual" })));
    expect(modern.getProjectSettings("project-upd").artifactPolicy).toBe("manual");
  });
});

describe("B2-9 对拍：classifyProjects", () => {
  beforeAll(() => {
    seedProjects((root) => [
      { id: "project-c1", name: "gis-map 工具", type: "综合项目", rootPath: makeWorkspace(root, "r-c1"), status: "进行中", pinned: false, settings: {}, archivedAt: null },
      { id: "project-c2", name: "已分类", type: "调研报告", rootPath: makeWorkspace(root, "r-c2"), status: "进行中", pinned: false, settings: {}, archivedAt: null },
    ]);
  });

  it("预览模式（apply=false）：只出建议不写盘", () => {
    const preview: any = modern.classifyProjects();
    expect(preview).toEqual(legacy.classifyProjects());
    expect(preview.applied).toBe(false);
    expect(preview.changes.find((c: any) => c.id === "project-c1")).toMatchObject({ currentType: "综合项目", suggestedType: "GIS / 地图分析", changed: true, applied: false });
    expect(preview.changes.find((c: any) => c.id === "project-c2")).toMatchObject({ currentType: "调研报告", suggestedType: "调研报告", changed: false });
    expect(modern.getProject("project-c1").type).toBe("综合项目");
    // 对称化：getProject 触发默认工作区注入写盘，两侧必须同步注入，否则 apply 用例两侧清单不对称（B2-9 教训）
    expect(legacy.getProject("project-c1").type).toBe("综合项目");
  });

  it("apply 模式：写盘更新 type + applied 标记", () => {
    const applied: any = modern.classifyProjects({ apply: true });
    expect(applied).toEqual(legacy.classifyProjects({ apply: true }));
    expect(applied.applied).toBe(true);
    expect(applied.changes.find((c: any) => c.id === "project-c1").applied).toBe(true);
    expect(modern.getProject("project-c1").type).toBe("GIS / 地图分析");
  });
});
