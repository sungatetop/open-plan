/**
 * B2-3 memory 域②：MEMORY.md 落盘/批准族（writeMemoryEntry/approve + 上限截断）。
 *
 * R6-7a 对拍退役改写：旧侧 server/memory-management.mjs 物理路径动态 import
 * （pathToFileURL）随 server/ 退役删除（等价性已在 B2-3 批对拍验收冻结），仅保留
 * modern src/main/backend/memory-management.ts 的同一套绝对断言；runBoth/norm
 * （tmp 路径·UUID·ISO 时间戳归一）随之删除——MEMORY.md 内容本就是精确字符串断言。
 *
 * 模块级重状态隔离（B1-1/B2-2 先例）：beforeAll stubEnv（OAW_MEMORY_PROPOSALS_FILE/
 * OAW_EVENT_DIR/OAW_RUNS_DIR/OAW_WRITE_LOCK_DIR=tmp）+ resetModules 后动态 import。
 */
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "b2memw-md-"));
const ws = path.join(base, "ws");
const proposalsFile = path.join(base, "memory-proposals.json");
const MEMORY_FILE = path.join(ws, "memory", "MEMORY.md");

let memory: any;

beforeAll(async () => {
  fs.mkdirSync(ws);
  vi.stubEnv("OAW_MEMORY_PROPOSALS_FILE", proposalsFile);
  vi.stubEnv("OAW_EVENT_DIR", path.join(base, "events"));
  vi.stubEnv("OAW_RUNS_DIR", path.join(base, "runs"));
  vi.stubEnv("OAW_WRITE_LOCK_DIR", path.join(base, "locks"));
  vi.resetModules();
  memory = await import("../src/main/backend/memory-management");
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
});

async function captureError(fn: () => unknown | Promise<unknown>) {
  try {
    await fn();
    return { thrown: false, message: "", code: "" };
  } catch (error: any) {
    return { thrown: true, message: error?.message || String(error), code: error?.code || "" };
  }
}

describe("B2-3 memory 落盘族：writeMemoryEntry", () => {
  it("新建索引：memory/MEMORY.md 创建 + 精确内容 + 返回面", async () => {
    const result = memory.writeMemoryEntry({ workspace: ws, category: "经验教训", content: "第一条记忆" });
    const fileText = fs.readFileSync(MEMORY_FILE, "utf8");
    expect(result).toMatchObject({ ok: true, duplicate: false, category: "lesson", section: "经验教训", file: "memory/MEMORY.md" });
    expect(fs.existsSync(path.join(ws, "memory"))).toBe(true);
    expect(fileText).toBe("# 记忆索引\n\n## 经验教训\n- 第一条记忆\n");
  });

  it("分节追加/重复幂等/新分类分节/内容空白归一", async () => {
    memory.writeMemoryEntry({ workspace: ws, category: "lesson", content: "第二条" });
    const beforeDup = fs.readFileSync(MEMORY_FILE, "utf8");
    const dup = memory.writeMemoryEntry({ workspace: ws, category: "lesson", content: "第二条" });
    const afterDup = fs.readFileSync(MEMORY_FILE, "utf8");
    memory.writeMemoryEntry({ workspace: ws, category: "work_rule", content: "A  B\n\n C" });
    const multi = memory.writeMemoryEntry({ workspace: ws, category: "user_preference", content: "偏好条" });
    const fileText = fs.readFileSync(MEMORY_FILE, "utf8");
    expect(dup).toMatchObject({ ok: true, duplicate: true });
    expect(beforeDup).toBe(afterDup);
    expect(multi).toMatchObject({ ok: true, duplicate: false, category: "user_preference" });
    expect(fileText).toBe([
      "# 记忆索引",
      "",
      "## 经验教训",
      "- 第一条记忆",
      "",
      "- 第二条",
      "",
      "## 工作规则",
      "- A B C",
      "",
      "## 用户偏好",
      "- 偏好条",
      "",
    ].join("\n"));
  });

  it("既有文件分节定位：标题行间的条目插入在下一标题之前", async () => {
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    fs.writeFileSync(MEMORY_FILE, "前置说明\n\n## 经验教训\n- 旧条\n\n## 工作规则\n- 规则条\n", "utf8");
    memory.writeMemoryEntry({ workspace: ws, category: "lesson", content: "新条" });
    const fileText = fs.readFileSync(MEMORY_FILE, "utf8");
    expect(fileText).toBe("前置说明\n\n## 经验教训\n- 旧条\n\n- 新条\n## 工作规则\n- 规则条\n");
  });

  it("校验：空内容 ok:false 文件不变；非法分类抛错；非法工作区抛错", async () => {
    const before = fs.readFileSync(MEMORY_FILE, "utf8");
    const empty = memory.writeMemoryEntry({ workspace: ws, category: "lesson", content: "   " });
    const badCategory = await captureError(() => memory.writeMemoryEntry({ workspace: ws, category: "???", content: "x" }));
    const badWorkspace = await captureError(() => memory.writeMemoryEntry({ workspace: "no-such-workspace", content: "x" }));
    const after = fs.readFileSync(MEMORY_FILE, "utf8");
    expect(empty).toEqual({ ok: false, code: "MEMORY_CONTENT_EMPTY", error: "记忆内容不能为空" });
    expect(badCategory).toMatchObject({ thrown: true, code: "MEMORY_CATEGORY_INVALID" });
    expect(badWorkspace).toMatchObject({ thrown: true, code: "MEMORY_WORKSPACE_INVALID", message: "记忆所属工作区不存在或不是文件夹" });
    expect(before).toBe(after);
  });
});

describe("B2-3 memory 落盘族：approveMemoryProposal", () => {
  it("批准落盘全流程：status/reviewer/approvedAt/write 面 + MEMORY.md 内容 + history", async () => {
    const p = memory.createMemoryProposal({ workspace: ws, category: "work_rule", content: "批准条目" });
    const approved = memory.approveMemoryProposal(p.id);
    const history = memory.getMemoryProposalHistory(p.id);
    const reApproved = memory.approveMemoryProposal(p.id);
    const fileText = fs.readFileSync(MEMORY_FILE, "utf8");
    expect(approved).toMatchObject({ ok: true });
    expect(approved.proposal).toMatchObject({ status: "approved", reviewer: "user", version: 2 });
    expect(approved.proposal.approvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(approved.write).toMatchObject({ ok: true, duplicate: false, file: "memory/MEMORY.md" });
    expect(history.history.map((h: any) => h.action)).toEqual(["created", "approved"]);
    expect(reApproved).toMatchObject({ ok: true });
    expect(reApproved.proposal.version).toBe(2);
    expect(fileText).toContain("- 批准条目");
  });

  it("重复条目幂等批准：duplicate:true 且文件不变", async () => {
    const p = memory.createMemoryProposal({ workspace: ws, category: "work_rule", content: "批准条目" });
    const before = fs.readFileSync(MEMORY_FILE, "utf8");
    const approved = memory.approveMemoryProposal(p.id);
    const after = fs.readFileSync(MEMORY_FILE, "utf8");
    expect(approved.write.duplicate).toBe(true);
    expect(before).toBe(after);
  });

  it("带编辑批准：content/category 覆盖后落盘新分节", async () => {
    const p = memory.createMemoryProposal({ workspace: ws, category: "lesson", content: "原稿" });
    const approved = memory.approveMemoryProposal(p.id, { content: "改稿", category: "用户偏好" });
    const fileText = fs.readFileSync(MEMORY_FILE, "utf8");
    expect(approved).toMatchObject({ ok: true });
    expect(approved.proposal).toMatchObject({ status: "approved", category: "user_preference", section: "用户偏好", content: "改稿" });
    expect(fileText).toContain("## 用户偏好\n- 改稿");
  });

  it("404 / 非 pending 409 / 注入坏工作区 proposal 抛 MEMORY_WORKSPACE_INVALID", async () => {
    const p = memory.createMemoryProposal({ workspace: ws, content: "待拒绝" });
    memory.rejectMemoryProposal(p.id);
    const missing = memory.approveMemoryProposal("memory_missing");
    const rejected = memory.approveMemoryProposal(p.id);
    fs.writeFileSync(proposalsFile, JSON.stringify([{
      id: "memory_seed_bad",
      content: "x",
      status: "pending",
      category: "lesson",
      workspace: path.join(base, "no-such-ws"),
    }]), "utf8");
    const badWorkspace = await captureError(() => memory.approveMemoryProposal("memory_seed_bad"));
    expect(missing).toEqual({ ok: false, status: 404, error: "proposal not found" });
    expect(rejected).toEqual({ ok: false, status: 409, code: "MEMORY_PROPOSAL_CONFLICT", error: "只有待审核建议可以批准" });
    expect(badWorkspace).toMatchObject({ thrown: true, code: "MEMORY_WORKSPACE_INVALID" });
  });
});

describe("B2-3 memory 落盘族：存储上限", () => {
  it("MAX_PROPOSALS：注入 300 条种子后新建 → 截到 300、最旧被淘汰", () => {
    const seeds = Array.from({ length: 300 }, (_, i) => ({ id: `memory_seed_${String(i).padStart(3, "0")}`, content: `c${i}` }));
    fs.writeFileSync(proposalsFile, JSON.stringify(seeds), "utf8");
    memory.createMemoryProposal({ workspace: ws, content: "新条" });
    expect(memory.memoryProposalStoreInfo().count).toBe(300);
    expect(memory.getMemoryProposalHistory("memory_seed_000").ok).toBe(false);
    expect(memory.getMemoryProposalHistory("memory_seed_299").ok).toBe(true);
  });

  it("MAX_HISTORY：注入 70 条历史后编辑 → 截到 60、version 继续递增", () => {
    const history = Array.from({ length: 70 }, (_, i) => ({ version: i + 1, action: "seed", at: "2026-01-01T00:00:00.000Z" }));
    fs.writeFileSync(proposalsFile, JSON.stringify([{ id: "memory_seed_h", content: "x", status: "pending", category: "lesson", history }]), "utf8");
    const edited = memory.editMemoryProposal("memory_seed_h", { content: "改" });
    const full = memory.getMemoryProposalHistory("memory_seed_h");
    expect(edited.proposal.version).toBe(2);
    expect(full.history.length).toBe(60);
    expect(full.history[full.history.length - 1].action).toBe("edited");
  });
});
