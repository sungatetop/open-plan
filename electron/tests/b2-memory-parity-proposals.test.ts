/**
 * B2-3 memory 域①：建议生命周期族（create/list/edit/reject/merge/history + 校验错误）。
 *
 * R6-7a 对拍退役改写：旧侧 server/memory-management.mjs + server/runs.mjs 物理路径
 * 动态 import 随 server/ 退役删除（等价性已在 B2-3 批对拍验收冻结），仅保留 modern
 * src/main/backend/memory-management.ts + runs.ts 的同一套绝对断言；runBoth/norm
 * （tmp 路径·UUID·ISO 时间戳归一）随之删除。
 *
 * 模块级重状态隔离（B1-1/B2-2 先例）：beforeAll stubEnv（OAW_MEMORY_PROPOSALS_FILE/
 * OAW_EVENT_DIR/OAW_RUNS_DIR/OAW_WRITE_LOCK_DIR=tmp）+ vi.resetModules() 重载整棵
 * 依赖树（memory-management→runs/event-storage/workspace/write-coordination 全新实例）
 * 后动态 import。
 */
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "b2mem-md-"));
const ws = path.join(base, "ws");
const ws2 = path.join(base, "ws2");
const proposalsFile = path.join(base, "memory-proposals.json");

let memory: any;
let runs: any;

beforeAll(async () => {
  fs.mkdirSync(ws);
  fs.mkdirSync(ws2);
  vi.stubEnv("OAW_MEMORY_PROPOSALS_FILE", proposalsFile);
  vi.stubEnv("OAW_EVENT_DIR", path.join(base, "events"));
  vi.stubEnv("OAW_RUNS_DIR", path.join(base, "runs"));
  vi.stubEnv("OAW_WRITE_LOCK_DIR", path.join(base, "locks"));
  vi.resetModules();
  runs = await import("../src/main/backend/runs");
  memory = await import("../src/main/backend/memory-management");
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
});

/** 捕获异常为可比对形态（message + code）。 */
async function captureError(fn: () => unknown | Promise<unknown>) {
  try {
    await fn();
    return { thrown: false, message: "", code: "" };
  } catch (error: any) {
    return { thrown: true, message: error?.message || String(error), code: error?.code || "" };
  }
}

describe("B2-3 memory 建议族：常量与存储面", () => {
  it("MEMORY_CATEGORIES 深等 + memoryProposalStoreInfo 初始面", () => {
    expect(memory.MEMORY_CATEGORIES).toEqual({
      project_fact: "项目事实",
      work_rule: "工作规则",
      user_preference: "用户偏好",
      lesson: "经验教训",
      resource_index: "资料索引",
    });
    expect(memory.memoryProposalStoreInfo().count).toBe(0);
  });
});

describe("B2-3 memory 建议族：createMemoryProposal", () => {
  it("基础创建：默认值/section 标签/history/source 回退/threadKey 回退", () => {
    const n = memory.createMemoryProposal({
      clientId: "c1",
      threadId: "t1",
      workspace: ws,
      category: "work_rule",
      content: "  规则一  ",
    });
    expect(n.id).toMatch(/^memory_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(n).toMatchObject({
      version: 1,
      clientId: "c1",
      threadId: "t1",
      threadKey: "t1",
      category: "work_rule",
      section: "工作规则",
      content: "规则一",
      status: "pending",
      runId: null,
      projectId: null,
    });
    expect(n.history).toHaveLength(1);
    expect(n.history[0]).toMatchObject({ version: 1, action: "created", content: "规则一" });
    expect(n.source).toMatchObject({ type: "agent", label: "Agent 建议", runId: null, threadId: "t1", clientId: "c1" });
  });

  it("内容截断 MAX_CONTENT + source 覆盖展开保留额外字段", () => {
    const n = memory.createMemoryProposal({
      workspace: ws,
      content: "x".repeat(1500),
      source: { type: "user", label: "手工录入", extra: 1 },
    });
    expect(n.content).toHaveLength(1200);
    expect(n.source).toMatchObject({ type: "user", label: "手工录入", extra: 1 });
  });

  it("校验错误族：空内容/非法分类/非法工作区（code + message）", async () => {
    const empty = await captureError(() => memory.createMemoryProposal({ workspace: ws, content: "   " }));
    const badCategory = await captureError(() => memory.createMemoryProposal({ workspace: ws, content: "x", category: "不存在的分类" }));
    const badWorkspace = await captureError(() => memory.createMemoryProposal({ workspace: "no-such-workspace", content: "x" }));
    expect(empty).toMatchObject({ thrown: true, code: "MEMORY_CONTENT_EMPTY", message: "记忆建议内容不能为空" });
    expect(badCategory).toMatchObject({ thrown: true, code: "MEMORY_CATEGORY_INVALID" });
    expect(badCategory.message).toContain("不支持的记忆分类");
    expect(badWorkspace).toMatchObject({ thrown: true, code: "MEMORY_WORKSPACE_INVALID", message: "记忆所属工作区不存在或不是文件夹" });
  });

  it("runId 归属：projectId 回落 run.projectId", () => {
    const run = runs.beginRun({ clientId: "c1", threadId: "t1", cwd: ws, snapshotMode: "none", projectId: "p1" });
    const proposal = memory.createMemoryProposal({ workspace: ws, content: "归属检查", runId: run.id });
    expect(proposal.projectId).toBe("p1");
    expect(proposal.runId).toMatch(/^run_[0-9a-f-]{36}$/);
  });
});

describe("B2-3 memory 建议族：listMemoryProposals", () => {
  it("无命中过滤（不可能的 status）→ []", () => {
    expect(memory.listMemoryProposals({ status: "no-such-status" })).toEqual([]);
  });

  it("过滤维度：threadKey 别名（threadId）/workspace/projectId/category 三形态/status all+pending+rejected；非法分类抛错", async () => {
    const m = memory;
    m.createMemoryProposal({ threadKey: "tk-filter", threadId: "t1", workspace: ws, projectId: "p1x", category: "work_rule", content: "规则一" });
    m.createMemoryProposal({ threadKey: "tk-filter", threadId: "t2", workspace: ws2, projectId: "p2x", category: "用户偏好", content: "偏好一" });
    m.createMemoryProposal({ threadId: "tc", workspace: ws, category: "经验教训", content: "教训一" });
    const d = m.createMemoryProposal({ threadKey: "tk-status", workspace: ws, category: "lesson", content: "状态条" });
    m.rejectMemoryProposal(d.id);
    const brief = (list: any[]) => list.map((p: any) => ({ content: p.content, category: p.category, section: p.section, projectId: p.projectId, threadKey: p.threadKey }));
    expect(brief(m.listMemoryProposals({ threadKey: "t2" }))).toEqual([{ content: "偏好一", category: "user_preference", section: "用户偏好", projectId: "p2x", threadKey: "tk-filter" }]);
    expect(brief(m.listMemoryProposals({ workspace: ws2 }))).toHaveLength(1);
    expect(brief(m.listMemoryProposals({ projectId: "p1x" }))).toHaveLength(1);
    expect(brief(m.listMemoryProposals({ category: "work_rule", projectId: "p1x" }))).toHaveLength(1);
    expect(brief(m.listMemoryProposals({ category: "工作规则", projectId: "p1x" }))).toHaveLength(1);
    expect(brief(m.listMemoryProposals({ category: "规则相关", projectId: "p1x" }))).toHaveLength(1);
    expect(m.listMemoryProposals({ threadKey: "tk-status", status: "all" }).length).toBe(1);
    expect(m.listMemoryProposals({ threadKey: "tk-status", status: "pending" }).length).toBe(0);
    expect(m.listMemoryProposals({ threadKey: "tk-status", status: "rejected" }).length).toBe(1);
    expect(brief(m.listMemoryProposals({ workspace: ws, category: "lesson", threadKey: "tc" }))).toHaveLength(1);
    await expect(captureError(() => m.listMemoryProposals({ category: "???" }))).resolves.toMatchObject({ thrown: true, code: "MEMORY_CATEGORY_INVALID" });
  });
});

describe("B2-3 memory 建议族：editMemoryProposal", () => {
  it("编辑内容+分类：version 递增/history previous；空参编辑 version 照加", () => {
    const m = memory;
    const p = m.createMemoryProposal({ workspace: ws, category: "lesson", content: "原稿" });
    const edited = m.editMemoryProposal(p.id, { content: "改稿", category: "资料索引" });
    const noop = m.editMemoryProposal(p.id, {});
    expect(edited).toMatchObject({ ok: true });
    expect(edited.proposal).toMatchObject({ version: 2, category: "resource_index", section: "资料索引", content: "改稿" });
    expect(edited.proposal.history[1]).toMatchObject({ action: "edited" });
    expect(edited.proposal.history[1].previous).toEqual({ content: "原稿", category: "lesson" });
    expect(noop.ok).toBe(true);
    expect(noop.proposal.version).toBe(3);
    expect(m.getMemoryProposalHistory(p.id).history).toHaveLength(3);
  });

  it("空内容 400 / 404 / 非 pending 409（先 reject）", () => {
    const m = memory;
    const p = m.createMemoryProposal({ workspace: ws, content: "待编辑" });
    const empty = m.editMemoryProposal(p.id, { content: "   " });
    const missing = m.editMemoryProposal("memory_missing", { content: "x" });
    m.rejectMemoryProposal(p.id);
    const rejected = m.editMemoryProposal(p.id, { content: "再改" });
    expect(empty).toEqual({ ok: false, status: 400, code: "MEMORY_CONTENT_EMPTY", error: "记忆建议内容不能为空" });
    expect(missing).toEqual({ ok: false, status: 404, error: "proposal not found" });
    expect(rejected).toEqual({ ok: false, status: 409, code: "MEMORY_PROPOSAL_CONFLICT", error: "只有待审核建议可以编辑" });
  });
});

describe("B2-3 memory 建议族：rejectMemoryProposal", () => {
  it("默认理由/自定义理由 + 404 + 非 pending 409", () => {
    const m = memory;
    const a = m.createMemoryProposal({ workspace: ws, content: "拒绝一" });
    const b = m.createMemoryProposal({ workspace: ws, content: "拒绝二" });
    const rejected = m.rejectMemoryProposal(a.id);
    const custom = m.rejectMemoryProposal(b.id, "  不要这条  ");
    const missing = m.rejectMemoryProposal("memory_missing");
    const twice = m.rejectMemoryProposal(a.id);
    expect(rejected).toMatchObject({ ok: true });
    expect(rejected.proposal).toMatchObject({ status: "rejected", rejectionReason: "用户拒绝该记忆建议" });
    expect(custom.proposal.rejectionReason).toBe("不要这条");
    expect(missing).toEqual({ ok: false, status: 404, error: "proposal not found" });
    expect(twice).toEqual({ ok: false, status: 409, code: "MEMORY_PROPOSAL_CONFLICT", error: "只有待审核建议可以拒绝" });
  });
});

describe("B2-3 memory 建议族：mergeMemoryProposals", () => {
  it("成功合并：内容 join/sources merged/mergedInto/history；targetId 自身去重", () => {
    const m = memory;
    const t = m.createMemoryProposal({ workspace: ws, category: "work_rule", content: "目标条" });
    const s1 = m.createMemoryProposal({ workspace: ws, category: "工作规则", content: "来源一" });
    const s2 = m.createMemoryProposal({ workspace: ws, category: "work_rule", content: "目标条" });
    const merged = m.mergeMemoryProposals(t.id, [s1.id, s2.id, t.id, s1.id, ""]);
    const s1After = m.getMemoryProposalHistory(s1.id);
    expect(merged).toMatchObject({ ok: true, merged: expect.arrayContaining([expect.stringMatching(/^memory_/)]) });
    expect(merged.merged).toHaveLength(2);
    expect(merged.proposal.content).toBe("目标条；来源一");
    expect(merged.proposal.version).toBe(2);
    expect(s1After.proposal).toMatchObject({ status: "merged", mergedInto: expect.stringMatching(/^memory_/) });
    expect(m.getMemoryProposalHistory(t.id).history.at(-1)).toMatchObject({ action: "merged" });
  });

  it("400 空来源 / 404 目标缺失 / 409 跨分类与跨工作区 / 409 非 pending", () => {
    const m = memory;
    const t = m.createMemoryProposal({ workspace: ws, category: "work_rule", content: "目标条" });
    const other = m.createMemoryProposal({ workspace: ws, category: "lesson", content: "异类" });
    const otherWs = m.createMemoryProposal({ workspace: ws2, category: "work_rule", content: "异地" });
    const missing = m.mergeMemoryProposals("memory_missing", []);
    const empty = m.mergeMemoryProposals(t.id, []);
    const crossCategory = m.mergeMemoryProposals(t.id, [other.id]);
    const crossWorkspace = m.mergeMemoryProposals(t.id, [otherWs.id]);
    m.rejectMemoryProposal(other.id);
    const notPending = m.mergeMemoryProposals(t.id, [other.id]);
    expect(missing).toEqual({ ok: false, status: 404, error: "target proposal not found" });
    expect(empty).toEqual({ ok: false, status: 400, error: "至少选择一条待合并建议" });
    expect(crossCategory).toEqual({ ok: false, status: 409, code: "MEMORY_PROPOSAL_CONFLICT", error: "只能合并同一工作区、同一分类下的待审核建议" });
    expect(crossWorkspace).toEqual(crossCategory);
    expect(notPending).toEqual(crossCategory);
  });
});

describe("B2-3 memory 建议族：getMemoryProposalHistory", () => {
  it("ok（id/history/proposal）与 404", () => {
    const m = memory;
    const p = m.createMemoryProposal({ workspace: ws, content: "历史条" });
    const ok = m.getMemoryProposalHistory(p.id);
    expect(ok).toMatchObject({ ok: true, id: expect.stringMatching(/^memory_/) });
    expect(ok.history).toHaveLength(1);
    expect(ok.proposal.content).toBe("历史条");
    expect(m.getMemoryProposalHistory("memory_missing")).toEqual({ ok: false, status: 404, error: "proposal not found" });
  });
});
