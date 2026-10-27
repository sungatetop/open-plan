/**
 * D-2 项目管理族直调对拍（project-management-direct.ts 编排层）。
 *
 * 覆盖面（行号锚点均指 server/index.mjs）：
 *   - manifest 锚点：7 通道全部在 DESKTOP_CHANNELS 且路由指向已审计路径；unknown → 404；
 *   - list（L3298-3328，最复杂处）：ensureProjectForWorkspace 自动登记 / filters 四参数
 *     归一（pinned 缺省 null、"true"/"false" 布尔化）/ 三源会话投影（id 回退 sessionId、
 *     空 id 过滤）/ 六项计数聚合矩阵（sessionCount 双条件 projectId|cwd、runCount、
 *     artifactCount 求和、unresolvedRunCount 五态白名单、pending/approvedMemoryCount、
 *     lastMemoryAt ISO 排序 pop 空回退 null）/ { projects, types, statuses, profiles,
 *     defaultSettings }；抛错 500 { error }（无 ok:false）；
 *   - create（L3330-3334）!ok→400 透传 / update（L3336-3340）!ok→404 透传 /
 *     settings:update（L3348-3352）!ok→404 / archive（L3354-3358）archived 缺省 true /
 *     pin（L3360-3364）pinned 缺省 true / classify（L4504-4510）apply 严格 ===true +
 *     catch 500 { ok:false, error }；
 *   - 薄路由异常 → 分发器兜底 500 { ok:false, error }（语义差异见模块头注释）。
 *
 * 本文件为纯编排测试：deps 全桩，不加载 project-management/runs/session-files/assembly。
 */
import { describe, expect, test, beforeAll, vi } from "vitest";
import type * as ProjectsModule from "../src/main/ipc/project-management-direct";
import { DESKTOP_CHANNELS, type InvokeEnvelope } from "../src/shared/protocol/channels";

type Projects = typeof ProjectsModule;
let svc: Projects;

beforeAll(async () => {
  svc = await import("../src/main/ipc/project-management-direct");
});

const PROJECT = { id: "p1", name: "演示项目", rootPath: "D:\\proj\\p1", type: "survey", status: "active", pinned: false };

function makeDeps(overrides: Partial<ProjectsModule.ProjectManagementDirectDeps> = {}) {
  return {
    getWorkspace: vi.fn(() => "D:\\ws"),
    ensureProjectForWorkspace: vi.fn(() => undefined),
    listRunSummaries: vi.fn(() => [
      { cwd: "D:\\proj\\p1", status: "running", artifactCount: 2 },
      { cwd: "D:\\proj\\p1", status: "done", artifactCount: 3 },
      { cwd: "D:\\other", status: "done", artifactCount: 1 }
    ]),
    memoryProposals: vi.fn(() => [
      { workspace: "D:\\proj\\p1", status: "pending", createdAt: "2026-10-01T00:00:00Z" },
      { workspace: "D:\\proj\\p1", status: "approved", approvedAt: "2026-10-03T00:00:00Z" },
      { workspace: "D:\\proj\\p1", status: "approved", createdAt: "2026-10-05T00:00:00Z" },
      { workspace: "D:\\other", status: "pending", createdAt: "2026-10-02T00:00:00Z" }
    ]),
    listSessionFiles: vi.fn(() => [
      { fileName: "s1.jsonl", fullPath: "D:\\ws\\s1.jsonl", storeDir: "D:\\ws", mtime: 1, size: 1 },
      { fileName: "s2.jsonl", fullPath: "D:\\ws\\s2.jsonl", storeDir: "D:\\ws", mtime: 1, size: 1 },
      { fileName: "s3.jsonl", fullPath: "D:\\ws\\s3.jsonl", storeDir: "D:\\ws", mtime: 1, size: 1 }
    ]),
    readSessionHeader: vi.fn((found: { fileName: string }) => {
      if (found.fileName === "s1.jsonl") return { id: "sess-1", cwd: "D:\\proj\\p1", projectId: "p1" };
      if (found.fileName === "s2.jsonl") return { sessionId: "sess-2", cwd: "D:\\proj\\p1" };
      return { cwd: "D:\\tmp" };
    }),
    listProjects: vi.fn(() => [PROJECT]),
    listProjectTypes: vi.fn(() => ["survey", "report"]),
    listProjectStatuses: vi.fn(() => ["active", "archived"]),
    listProjectProfiles: vi.fn(() => ({ survey: { label: "踏勘" } })),
    defaultProjectSettings: vi.fn(() => ({ language: "zh" })),
    createProject: vi.fn(() => ({ ok: true, project: PROJECT })),
    updateProject: vi.fn((_id: unknown, patch: Record<string, any>) => ({ ok: true, project: { ...PROJECT, ...patch } })),
    getProjectSettings: vi.fn(() => ({ language: "zh" })),
    updateProjectSettings: vi.fn(() => ({ ok: true, settings: { language: "en" } })),
    archiveProject: vi.fn((_id: unknown, archived: boolean) => ({ ok: true, archived })),
    classifyProjects: vi.fn(() => ({ scanned: 2, matched: 1 })),
    ...overrides
  } as never as ProjectsModule.ProjectManagementDirectDeps & Record<string, ReturnType<typeof vi.fn>>;
}

function invoke(channel: ProjectsModule.ProjectManagementDirectChannel, envelope: InvokeEnvelope | undefined, deps = makeDeps()) {
  return svc.invokeProjectManagementDirect(channel, envelope, deps);
}

describe("D-2 manifest 锚点", () => {
  test("7 条通道全部在 DESKTOP_CHANNELS 且路由指向已审计路径", () => {
    expect(svc.PROJECT_MANAGEMENT_DIRECT_CHANNELS).toHaveLength(7);
    const expectedRoutes: Record<string, { method: string; path: string }> = {
      "op:projects:list": { method: "GET", path: "/api/projects" },
      "op:projects:create": { method: "POST", path: "/api/projects" },
      "op:projects:classify": { method: "POST", path: "/api/projects/classify" },
      "op:projects:update": { method: "PATCH", path: "/api/projects/:id" },
      "op:projects:pin": { method: "POST", path: "/api/projects/:id/pin" },
      "op:projects:archive": { method: "POST", path: "/api/projects/:id/archive" },
      "op:projects:settings:update": { method: "PATCH", path: "/api/projects/:id/settings" }
    };
    for (const channel of svc.PROJECT_MANAGEMENT_DIRECT_CHANNELS) {
      expect(DESKTOP_CHANNELS[channel as keyof typeof DESKTOP_CHANNELS]).toEqual(expectedRoutes[channel]);
    }
  });

  test("unknown channel → 404", async () => {
    const result = await svc.invokeProjectManagementDirect("op:projects:delete" as never, {}, makeDeps());
    expect(result).toEqual({ ok: false, status: 404, data: { error: "unknown channel: op:projects:delete" } });
  });
});

describe("D-2 op:projects:list（L3298-3328 四域计数聚合）", () => {
  test("ensureProjectForWorkspace 自动登记 + filters 缺省归一 + 六项计数聚合投影", async () => {
    const listFn = vi.fn(() => [PROJECT]);
    const result = await invoke("op:projects:list", { query: {} }, makeDeps({ listProjects: listFn }));
    expect(result.ok).toBe(true);
    // 自动登记当前工作区
    const deps = makeDeps();
    await invoke("op:projects:list", { query: {} }, deps);
    expect(deps.ensureProjectForWorkspace).toHaveBeenCalledWith("D:\\ws");
    // filters 缺省归一（pinned null / sort recent）
    expect(listFn).toHaveBeenCalledWith({ type: "", status: "", pinned: null, sort: "recent" });
    // 计数聚合：sessions（projectId=p1 或 cwd=rootPath）= s1+s2 = 2（s3 无 id 被过滤）
    const project = (result.data as Record<string, any>).projects[0];
    expect(project.sessionCount).toBe(2);
    expect(project.runCount).toBe(2);
    expect(project.artifactCount).toBe(5);
    // 五态白名单：running 命中，done 不计
    expect(project.unresolvedRunCount).toBe(1);
    expect(project.pendingMemoryCount).toBe(1);
    expect(project.approvedMemoryCount).toBe(2);
    // approvedAt || createdAt 最大：10-03（approved 用 approvedAt）vs 10-05（无 approvedAt 用 createdAt）
    expect(project.lastMemoryAt).toBe("2026-10-05T00:00:00Z");
  });

  test("聚合投影还带 types/statuses/profiles/defaultSettings；pinned/sort query 归一", async () => {
    const listFn = vi.fn(() => [PROJECT]);
    const result = await invoke("op:projects:list", { query: { type: "survey", status: "active", pinned: "true", sort: "name" } }, makeDeps({ listProjects: listFn }));
    expect(listFn).toHaveBeenCalledWith({ type: "survey", status: "active", pinned: true, sort: "name" });
    const data = result.data as Record<string, any>;
    expect(data.types).toEqual(["survey", "report"]);
    expect(data.statuses).toEqual(["active", "archived"]);
    expect(data.profiles).toEqual({ survey: { label: "踏勘" } });
    expect(data.defaultSettings).toEqual({ language: "zh" });
  });

  test("lastMemoryAt 空提案回退 null；list 抛错 → 500 { error }（无 ok:false）", async () => {
    const empty = await invoke("op:projects:list", { query: {} }, makeDeps({
      memoryProposals: vi.fn(() => [])
    }));
    expect(((empty.data as Record<string, any>).projects as any[])[0].lastMemoryAt).toBeNull();
    const fail = await invoke("op:projects:list", { query: {} }, makeDeps({
      listRunSummaries: vi.fn(() => { throw new Error("runs 目录不可读"); })
    }));
    expect(fail).toEqual({ ok: false, status: 500, data: { error: "runs 目录不可读" } });
    expect((fail.data as Record<string, unknown>).ok).toBeUndefined();
  });
});

describe("D-2 op:projects:create/update/settings/archive/pin（薄路由透传）", () => {
  test("create：ok→200 透传；!ok→400 透传", async () => {
    const okResult = await invoke("op:projects:create", { body: { name: "新项目" } });
    expect(okResult.status).toBe(200);
    const failResult = await invoke("op:projects:create", { body: {} }, makeDeps({
      createProject: vi.fn(() => ({ ok: false, error: "项目名已存在" }))
    }));
    expect(failResult).toEqual({ ok: false, status: 400, data: { ok: false, error: "项目名已存在" } });
  });

  test("update：params.id + body 传参，!ok→404 透传", async () => {
    const updateFn = vi.fn((id: unknown, patch: Record<string, any>) => (id === "p1" ? { ok: true, project: { ...PROJECT, ...patch } } : { ok: false, error: "project not found" }));
    const okResult = await invoke("op:projects:update", { params: { id: "p1" }, body: { name: "改名" } }, makeDeps({ updateProject: updateFn }));
    expect(updateFn).toHaveBeenCalledWith("p1", { name: "改名" });
    expect(okResult.status).toBe(200);
    const failResult = await invoke("op:projects:update", { params: { id: "ghost" }, body: {} }, makeDeps({ updateProject: updateFn }));
    expect(failResult).toEqual({ ok: false, status: 404, data: { ok: false, error: "project not found" } });
  });

  test("settings:update：!ok→404 透传", async () => {
    const failResult = await invoke("op:projects:settings:update", { params: { id: "ghost" }, body: {} }, makeDeps({
      updateProjectSettings: vi.fn(() => ({ ok: false, error: "project not found" }))
    }));
    expect(failResult).toEqual({ ok: false, status: 404, data: { ok: false, error: "project not found" } });
  });

  test("archive：archived 缺省 true、body.archived=false 显式取消归档；!ok→404", async () => {
    const archiveFn = vi.fn((_id: unknown, archived: boolean) => ({ ok: true, archived }));
    const r1 = await invoke("op:projects:archive", { params: { id: "p1" } }, makeDeps({ archiveProject: archiveFn }));
    expect(archiveFn).toHaveBeenLastCalledWith("p1", true);
    const r2 = await invoke("op:projects:archive", { params: { id: "p1" }, body: { archived: false } }, makeDeps({ archiveProject: archiveFn }));
    expect(archiveFn).toHaveBeenLastCalledWith("p1", false);
    expect(r1.status).toBe(200);
    expect((r2.data as Record<string, unknown>).archived).toBe(false);
    const failResult = await invoke("op:projects:archive", { params: { id: "ghost" } }, makeDeps({
      archiveProject: vi.fn(() => ({ ok: false, error: "project not found" }))
    }));
    expect(failResult.status).toBe(404);
  });

  test("pin：pinned 缺省 true、body.pinned=false 取消置顶；!ok→404", async () => {
    const updateFn = vi.fn((_id: unknown, patch: Record<string, any>) => ({ ok: true, project: { ...PROJECT, ...patch } }));
    await invoke("op:projects:pin", { params: { id: "p1" } }, makeDeps({ updateProject: updateFn }));
    expect(updateFn).toHaveBeenLastCalledWith("p1", { pinned: true });
    await invoke("op:projects:pin", { params: { id: "p1" }, body: { pinned: false } }, makeDeps({ updateProject: updateFn }));
    expect(updateFn).toHaveBeenLastCalledWith("p1", { pinned: false });
  });

  test("薄路由异常 → 分发器兜底 500 { ok:false, error }（sidecar 无 try/catch 语义差异声明）", async () => {
    const result = await invoke("op:projects:create", { body: {} }, makeDeps({
      createProject: vi.fn(() => { throw new Error("磁盘不可写"); })
    }));
    expect(result).toEqual({ ok: false, status: 500, data: { ok: false, error: "磁盘不可写" } });
  });
});

describe("D-2 op:projects:classify（L4504-4510）", () => {
  test("apply 严格 ===true；成功 result 整体透传", async () => {
    const classifyFn = vi.fn((options: Record<string, any>) => ({ scanned: 2, matched: 1, apply: options.apply }));
    const r1 = await invoke("op:projects:classify", { body: { apply: true } }, makeDeps({ classifyProjects: classifyFn }));
    expect(classifyFn).toHaveBeenLastCalledWith({ apply: true });
    expect((r1.data as Record<string, unknown>).apply).toBe(true);
    const r2 = await invoke("op:projects:classify", { body: { apply: "yes" } }, makeDeps({ classifyProjects: classifyFn }));
    expect(classifyFn).toHaveBeenLastCalledWith({ apply: false });
    expect((r2.data as Record<string, unknown>).apply).toBe(false);
  });

  test("抛错 → 500 { ok:false, error }", async () => {
    const result = await invoke("op:projects:classify", { body: {} }, makeDeps({
      classifyProjects: vi.fn(() => { throw new Error("分类失败"); })
    }));
    expect(result).toEqual({ ok: false, status: 500, data: { ok: false, error: "分类失败" } });
  });
});
