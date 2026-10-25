/**
 * B2-3 memory 域对拍①：建议生命周期族（create/list/edit/reject/merge/history + 校验错误）。
 *
 * 模块级重状态隔离（B1-1/B2-2 先例）：beforeAll 分次 stubEnv（OAW_MEMORY_PROPOSALS_FILE/
 * OAW_EVENT_DIR/OAW_RUNS_DIR/OAW_WRITE_LOCK_DIR=各侧 tmp）后各自动态 import——旧侧
 * Node ESM 首次加载冻结，新侧 vi.resetModules() 重载整棵依赖树（memory-management→
 * runs/event-storage/workspace/write-coordination 全新实例）。runBoth 双侧同脚本执行后归一比对。
 */
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "../..");
const OLD_URL = pathToFileURL(path.join(PROJECT_ROOT, "server", "memory-management.mjs")).href;
const OLD_RUNS_URL = pathToFileURL(path.join(PROJECT_ROOT, "server", "runs.mjs")).href;

interface Side {
  name: string;
  memory: any;
  runs: any;
  base: string;
  ws: string;
  ws2: string;
  proposalsFile: string;
}

const SIDES: Side[] = [];

beforeAll(async () => {
  for (const name of ["old", "new"] as const) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), `b2mem-${name}-`));
    const ws = path.join(base, "ws");
    const ws2 = path.join(base, "ws2");
    const proposalsFile = path.join(base, "memory-proposals.json");
    fs.mkdirSync(ws);
    fs.mkdirSync(ws2);
    vi.stubEnv("OAW_MEMORY_PROPOSALS_FILE", proposalsFile);
    vi.stubEnv("OAW_EVENT_DIR", path.join(base, "events"));
    vi.stubEnv("OAW_RUNS_DIR", path.join(base, "runs"));
    vi.stubEnv("OAW_WRITE_LOCK_DIR", path.join(base, "locks"));
    if (name === "old") {
      const memory = await import(OLD_URL);
      const runs = await import(OLD_RUNS_URL);
      SIDES.push({ name, memory, runs, base, ws, ws2, proposalsFile });
    } else {
      vi.resetModules();
      const memory = await import("../src/main/backend/memory-management");
      const runs = await import("../src/main/backend/runs");
      SIDES.push({ name, memory, runs, base, ws, ws2, proposalsFile });
    }
  }
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** 双侧同脚本执行：先旧后新（顺序执行，模块级状态各自累积）。 */
async function runBoth<T>(fn: (side: Side) => T | Promise<T>): Promise<{ old: T; new: T }> {
  const out: any = {};
  for (const side of SIDES) out[side.name] = await fn(side);
  return out;
}

/**
 * 跨侧归一：tmp 路径（JSON 转义替换键 + 正斜杠变体，realpath 差异取双侧并集）+
 * memory/memory_approval UUID + ISO 时间戳。
 */
function norm(value: unknown): string {
  let text = JSON.stringify(value)!;
  for (const s of SIDES) {
    for (const p of [s.base, s.ws, s.ws2, s.proposalsFile]) {
      text = text!
        .replaceAll(JSON.stringify(p).slice(1, -1), "<TMP>")
        .replaceAll(p.replace(/\\/g, "/"), "<TMP>");
      try { text = text!.replaceAll(fs.realpathSync(p).replace(/\\/g, "/"), "<TMP>"); } catch {}
    }
  }
  return text!
    .replaceAll(/memory_approval_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "approval_<ID>")
    .replaceAll(/memory_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "memory_<ID>")
    .replaceAll(/run_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "run_<ID>")
    .replaceAll(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z/g, "<TS>");
}

function expectSameNorm(oldValue: unknown, newValue: unknown) {
  expect(norm(oldValue)).toBe(norm(newValue));
}

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
  it("MEMORY_CATEGORIES 深等 + memoryProposalStoreInfo 初始面", async () => {
    const { old: o, new: n } = await runBoth((side) => ({
      categories: side.memory.MEMORY_CATEGORIES,
      info: side.memory.memoryProposalStoreInfo(),
    }));
    expect(n.categories).toEqual({
      project_fact: "项目事实",
      work_rule: "工作规则",
      user_preference: "用户偏好",
      lesson: "经验教训",
      resource_index: "资料索引",
    });
    expectSameNorm(o.categories, n.categories);
    expect(n.info.count).toBe(0);
    expectSameNorm(o.info, n.info);
  });
});

describe("B2-3 memory 建议族：createMemoryProposal", () => {
  it("基础创建：默认值/section 标签/history/source 回退/threadKey 回退", async () => {
    const { old: o, new: n } = await runBoth((side) =>
      side.memory.createMemoryProposal({
        clientId: "c1",
        threadId: "t1",
        workspace: side.ws,
        category: "work_rule",
        content: "  规则一  ",
      }));
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
    expectSameNorm(o, n);
  });

  it("内容截断 MAX_CONTENT + source 覆盖展开保留额外字段", async () => {
    const { old: o, new: n } = await runBoth((side) =>
      side.memory.createMemoryProposal({
        workspace: side.ws,
        content: "x".repeat(1500),
        source: { type: "user", label: "手工录入", extra: 1 },
      }));
    expect(n.content).toHaveLength(1200);
    expect(n.source).toMatchObject({ type: "user", label: "手工录入", extra: 1 });
    expectSameNorm(o, n);
  });

  it("校验错误族：空内容/非法分类/非法工作区（code + message 双侧一致）", async () => {
    const { old: o, new: n } = await runBoth(async (side) => ({
      empty: await captureError(() => side.memory.createMemoryProposal({ workspace: side.ws, content: "   " })),
      badCategory: await captureError(() => side.memory.createMemoryProposal({ workspace: side.ws, content: "x", category: "不存在的分类" })),
      badWorkspace: await captureError(() => side.memory.createMemoryProposal({ workspace: "no-such-workspace", content: "x" })),
    }));
    expect(n.empty).toMatchObject({ thrown: true, code: "MEMORY_CONTENT_EMPTY", message: "记忆建议内容不能为空" });
    expect(n.badCategory).toMatchObject({ thrown: true, code: "MEMORY_CATEGORY_INVALID" });
    expect(n.badCategory.message).toContain("不支持的记忆分类");
    expect(n.badWorkspace).toMatchObject({ thrown: true, code: "MEMORY_WORKSPACE_INVALID", message: "记忆所属工作区不存在或不是文件夹" });
    expect(o).toEqual(n);
  });

  it("runId 归属：projectId 回落 run.projectId", async () => {
    const { old: o, new: n } = await runBoth((side) => {
      const run = side.runs.beginRun({ clientId: "c1", threadId: "t1", cwd: side.ws, snapshotMode: "none", projectId: "p1" });
      const proposal = side.memory.createMemoryProposal({ workspace: side.ws, content: "归属检查", runId: run.id });
      return { projectId: proposal.projectId, runId: proposal.runId };
    });
    expect(n).toEqual({ projectId: "p1", runId: expect.stringMatching(/^run_[0-9a-f-]{36}$/) });
    expectSameNorm(o, n);
  });
});

describe("B2-3 memory 建议族：listMemoryProposals", () => {
  it("无命中过滤（不可能的 status）→ []", async () => {
    const { old: o, new: n } = await runBoth((side) => side.memory.listMemoryProposals({ status: "no-such-status" }));
    expect(n).toEqual([]);
    expect(o).toEqual(n);
  });

  it("过滤维度：threadKey 别名（threadId）/workspace/projectId/category 三形态/status all+pending+rejected；非法分类抛错", async () => {
    const { old: o, new: n } = await runBoth(async (side) => {
      const m = side.memory;
      m.createMemoryProposal({ threadKey: "tk-filter", threadId: "t1", workspace: side.ws, projectId: "p1x", category: "work_rule", content: "规则一" });
      m.createMemoryProposal({ threadKey: "tk-filter", threadId: "t2", workspace: side.ws2, projectId: "p2x", category: "用户偏好", content: "偏好一" });
      m.createMemoryProposal({ threadId: "tc", workspace: side.ws, category: "经验教训", content: "教训一" });
      const d = m.createMemoryProposal({ threadKey: "tk-status", workspace: side.ws, category: "lesson", content: "状态条" });
      m.rejectMemoryProposal(d.id);
      const brief = (list: any[]) => list.map((p: any) => ({ content: p.content, category: p.category, section: p.section, projectId: p.projectId, threadKey: p.threadKey }));
      return {
        byThreadAlias: brief(m.listMemoryProposals({ threadKey: "t2" })),
        byWorkspace: brief(m.listMemoryProposals({ workspace: side.ws2 })),
        byProject: brief(m.listMemoryProposals({ projectId: "p1x" })),
        byCategoryKey: brief(m.listMemoryProposals({ category: "work_rule", projectId: "p1x" })),
        byCategoryLabel: brief(m.listMemoryProposals({ category: "工作规则", projectId: "p1x" })),
        byCategoryFuzzy: brief(m.listMemoryProposals({ category: "规则相关", projectId: "p1x" })),
        statusAll: m.listMemoryProposals({ threadKey: "tk-status", status: "all" }).length,
        statusPending: m.listMemoryProposals({ threadKey: "tk-status", status: "pending" }).length,
        statusRejected: m.listMemoryProposals({ threadKey: "tk-status", status: "rejected" }).length,
        combined: brief(m.listMemoryProposals({ workspace: side.ws, category: "lesson", threadKey: "tc" })),
        badCategory: await captureError(() => m.listMemoryProposals({ category: "???" })),
      };
    });
    expect(n.byThreadAlias).toEqual([{ content: "偏好一", category: "user_preference", section: "用户偏好", projectId: "p2x", threadKey: "tk-filter" }]);
    expect(n.byWorkspace).toHaveLength(1);
    expect(n.byProject).toHaveLength(1);
    expect(n.byCategoryKey).toHaveLength(1);
    expect(n.byCategoryLabel).toHaveLength(1);
    expect(n.byCategoryFuzzy).toHaveLength(1);
    expect(n.statusAll).toBe(1);
    expect(n.statusPending).toBe(0);
    expect(n.statusRejected).toBe(1);
    expect(n.combined).toHaveLength(1);
    expect(n.badCategory).toMatchObject({ thrown: true, code: "MEMORY_CATEGORY_INVALID" });
    expectSameNorm(o.byThreadAlias, n.byThreadAlias);
    expectSameNorm(o.byWorkspace, n.byWorkspace);
    expectSameNorm(o.byProject, n.byProject);
    expectSameNorm(o.byCategoryKey, n.byCategoryKey);
    expectSameNorm(o.byCategoryLabel, n.byCategoryLabel);
    expectSameNorm(o.byCategoryFuzzy, n.byCategoryFuzzy);
    expectSameNorm(o.combined, n.combined);
    expect(o.badCategory).toEqual(n.badCategory);
  });
});

describe("B2-3 memory 建议族：editMemoryProposal", () => {
  it("编辑内容+分类：version 递增/history previous；空参编辑 version 照加", async () => {
    const { old: o, new: n } = await runBoth((side) => {
      const m = side.memory;
      const p = m.createMemoryProposal({ workspace: side.ws, category: "lesson", content: "原稿" });
      const edited = m.editMemoryProposal(p.id, { content: "改稿", category: "资料索引" });
      const noop = m.editMemoryProposal(p.id, {});
      return { edited, noop, history: m.getMemoryProposalHistory(p.id) };
    });
    expect(n.edited).toMatchObject({ ok: true });
    expect(n.edited.proposal).toMatchObject({ version: 2, category: "resource_index", section: "资料索引", content: "改稿" });
    expect(n.edited.proposal.history[1]).toMatchObject({ action: "edited" });
    expect(n.edited.proposal.history[1].previous).toEqual({ content: "原稿", category: "lesson" });
    expect(n.noop.ok).toBe(true);
    expect(n.noop.proposal.version).toBe(3);
    expect(n.history.history).toHaveLength(3);
    expectSameNorm(o, n);
  });

  it("空内容 400 / 404 / 非 pending 409（先 reject）", async () => {
    const { old: o, new: n } = await runBoth((side) => {
      const m = side.memory;
      const p = m.createMemoryProposal({ workspace: side.ws, content: "待编辑" });
      const empty = m.editMemoryProposal(p.id, { content: "   " });
      const missing = m.editMemoryProposal("memory_missing", { content: "x" });
      m.rejectMemoryProposal(p.id);
      const rejected = m.editMemoryProposal(p.id, { content: "再改" });
      return { empty, missing, rejected };
    });
    expect(n.empty).toEqual({ ok: false, status: 400, code: "MEMORY_CONTENT_EMPTY", error: "记忆建议内容不能为空" });
    expect(n.missing).toEqual({ ok: false, status: 404, error: "proposal not found" });
    expect(n.rejected).toEqual({ ok: false, status: 409, code: "MEMORY_PROPOSAL_CONFLICT", error: "只有待审核建议可以编辑" });
    expect(o).toEqual(n);
  });
});

describe("B2-3 memory 建议族：rejectMemoryProposal", () => {
  it("默认理由/自定义理由 + 404 + 非 pending 409", async () => {
    const { old: o, new: n } = await runBoth((side) => {
      const m = side.memory;
      const a = m.createMemoryProposal({ workspace: side.ws, content: "拒绝一" });
      const b = m.createMemoryProposal({ workspace: side.ws, content: "拒绝二" });
      const rejected = m.rejectMemoryProposal(a.id);
      const custom = m.rejectMemoryProposal(b.id, "  不要这条  ");
      const missing = m.rejectMemoryProposal("memory_missing");
      const twice = m.rejectMemoryProposal(a.id);
      return { rejected, custom, missing, twice };
    });
    expect(n.rejected).toMatchObject({ ok: true });
    expect(n.rejected.proposal).toMatchObject({ status: "rejected", rejectionReason: "用户拒绝该记忆建议" });
    expect(n.custom.proposal.rejectionReason).toBe("不要这条");
    expect(n.missing).toEqual({ ok: false, status: 404, error: "proposal not found" });
    expect(n.twice).toEqual({ ok: false, status: 409, code: "MEMORY_PROPOSAL_CONFLICT", error: "只有待审核建议可以拒绝" });
    expectSameNorm(o, n);
  });
});

describe("B2-3 memory 建议族：mergeMemoryProposals", () => {
  it("成功合并：内容 join/sources merged/mergedInto/history；targetId 自身去重", async () => {
    const { old: o, new: n } = await runBoth((side) => {
      const m = side.memory;
      const t = m.createMemoryProposal({ workspace: side.ws, category: "work_rule", content: "目标条" });
      const s1 = m.createMemoryProposal({ workspace: side.ws, category: "工作规则", content: "来源一" });
      const s2 = m.createMemoryProposal({ workspace: side.ws, category: "work_rule", content: "目标条" });
      const merged = m.mergeMemoryProposals(t.id, [s1.id, s2.id, t.id, s1.id, ""]);
      const history = m.getMemoryProposalHistory(t.id);
      const s1After = m.getMemoryProposalHistory(s1.id);
      return { merged, targetHistory: history.history, s1After };
    });
    expect(n.merged).toMatchObject({ ok: true, merged: expect.arrayContaining([expect.stringMatching(/^memory_/)]) });
    expect(n.merged.merged).toHaveLength(2);
    expect(n.merged.proposal.content).toBe("目标条；来源一");
    expect(n.merged.proposal.version).toBe(2);
    expect(n.s1After.proposal).toMatchObject({ status: "merged", mergedInto: expect.stringMatching(/^memory_/) });
    expect(n.targetHistory.at(-1)).toMatchObject({ action: "merged" });
    expectSameNorm(o, n);
  });

  it("400 空来源 / 404 目标缺失 / 409 跨分类与跨工作区 / 409 非 pending", async () => {
    const { old: o, new: n } = await runBoth((side) => {
      const m = side.memory;
      const t = m.createMemoryProposal({ workspace: side.ws, category: "work_rule", content: "目标条" });
      const other = m.createMemoryProposal({ workspace: side.ws, category: "lesson", content: "异类" });
      const otherWs = m.createMemoryProposal({ workspace: side.ws2, category: "work_rule", content: "异地" });
      const missing = m.mergeMemoryProposals("memory_missing", []);
      const empty = m.mergeMemoryProposals(t.id, []);
      const crossCategory = m.mergeMemoryProposals(t.id, [other.id]);
      const crossWorkspace = m.mergeMemoryProposals(t.id, [otherWs.id]);
      m.rejectMemoryProposal(other.id);
      const notPending = m.mergeMemoryProposals(t.id, [other.id]);
      return { missing, empty, crossCategory, crossWorkspace, notPending };
    });
    expect(n.missing).toEqual({ ok: false, status: 404, error: "target proposal not found" });
    expect(n.empty).toEqual({ ok: false, status: 400, error: "至少选择一条待合并建议" });
    expect(n.crossCategory).toEqual({ ok: false, status: 409, code: "MEMORY_PROPOSAL_CONFLICT", error: "只能合并同一工作区、同一分类下的待审核建议" });
    expect(n.crossWorkspace).toEqual(n.crossCategory);
    expect(n.notPending).toEqual(n.crossCategory);
    expect(o).toEqual(n);
  });
});

describe("B2-3 memory 建议族：getMemoryProposalHistory", () => {
  it("ok（id/history/proposal）与 404", async () => {
    const { old: o, new: n } = await runBoth((side) => {
      const m = side.memory;
      const p = m.createMemoryProposal({ workspace: side.ws, content: "历史条" });
      return {
        ok: m.getMemoryProposalHistory(p.id),
        missing: m.getMemoryProposalHistory("memory_missing"),
      };
    });
    expect(n.ok).toMatchObject({ ok: true, id: expect.stringMatching(/^memory_/) });
    expect(n.ok.history).toHaveLength(1);
    expect(n.ok.proposal.content).toBe("历史条");
    expect(n.missing).toEqual({ ok: false, status: 404, error: "proposal not found" });
    expectSameNorm(o.ok, n.ok);
    expect(o.missing).toEqual(n.missing);
  });
});
