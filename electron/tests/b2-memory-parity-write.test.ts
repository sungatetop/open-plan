/**
 * B2-3 memory 域对拍②：MEMORY.md 落盘/批准族（writeMemoryEntry/approve + 上限截断）。
 *
 * 模块级重状态隔离（B1-1/B2-2 先例）：beforeAll 分次 stubEnv（OAW_MEMORY_PROPOSALS_FILE/
 * OAW_EVENT_DIR/OAW_RUNS_DIR/OAW_WRITE_LOCK_DIR=各侧 tmp）后各自动态 import；runBoth
 * 双侧同脚本执行后归一比对。MEMORY.md 内容无动态字段，可精确字符串比对。
 */
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "../..");
const OLD_URL = pathToFileURL(path.join(PROJECT_ROOT, "server", "memory-management.mjs")).href;

interface Side {
  name: string;
  memory: any;
  base: string;
  ws: string;
  proposalsFile: string;
}

const SIDES: Side[] = [];

beforeAll(async () => {
  for (const name of ["old", "new"] as const) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), `b2memw-${name}-`));
    const ws = path.join(base, "ws");
    const proposalsFile = path.join(base, "memory-proposals.json");
    fs.mkdirSync(ws);
    vi.stubEnv("OAW_MEMORY_PROPOSALS_FILE", proposalsFile);
    vi.stubEnv("OAW_EVENT_DIR", path.join(base, "events"));
    vi.stubEnv("OAW_RUNS_DIR", path.join(base, "runs"));
    vi.stubEnv("OAW_WRITE_LOCK_DIR", path.join(base, "locks"));
    if (name === "old") {
      const memory = await import(OLD_URL);
      SIDES.push({ name, memory, base, ws, proposalsFile });
    } else {
      vi.resetModules();
      const memory = await import("../src/main/backend/memory-management");
      SIDES.push({ name, memory, base, ws, proposalsFile });
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
    for (const p of [s.base, s.ws, s.proposalsFile]) {
      text = text!
        .replaceAll(JSON.stringify(p).slice(1, -1), "<TMP>")
        .replaceAll(p.replace(/\\/g, "/"), "<TMP>");
      try { text = text!.replaceAll(fs.realpathSync(p).replace(/\\/g, "/"), "<TMP>"); } catch {}
    }
  }
  return text!
    .replaceAll(/memory_approval_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "approval_<ID>")
    .replaceAll(/memory_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "memory_<ID>")
    .replaceAll(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z/g, "<TS>");
}

function expectSameNorm(oldValue: unknown, newValue: unknown) {
  expect(norm(oldValue)).toBe(norm(newValue));
}

function memoryFileOf(side: Side): string {
  return path.join(side.ws, "memory", "MEMORY.md");
}

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
    const { old: o, new: n } = await runBoth((side) => {
      const result = side.memory.writeMemoryEntry({ workspace: side.ws, category: "经验教训", content: "第一条记忆" });
      return {
        result,
        fileExists: fs.existsSync(memoryFileOf(side)),
        memoryDirCreated: fs.existsSync(path.join(side.ws, "memory")),
        fileText: fs.existsSync(memoryFileOf(side)) ? fs.readFileSync(memoryFileOf(side), "utf8") : "",
      };
    });
    expect(n.result).toMatchObject({ ok: true, duplicate: false, category: "lesson", section: "经验教训", file: "memory/MEMORY.md" });
    expect(n.fileText).toBe("# 记忆索引\n\n## 经验教训\n- 第一条记忆\n");
    expectSameNorm(o.result, n.result);
    expect(o.fileText).toBe(n.fileText);
  });

  it("分节追加/重复幂等/新分类分节/内容空白归一", async () => {
    const { old: o, new: n } = await runBoth((side) => {
      const m = side.memory;
      m.writeMemoryEntry({ workspace: side.ws, category: "lesson", content: "第二条" });
      const beforeDup = fs.readFileSync(memoryFileOf(side), "utf8");
      const dup = m.writeMemoryEntry({ workspace: side.ws, category: "lesson", content: "第二条" });
      const afterDup = fs.readFileSync(memoryFileOf(side), "utf8");
      m.writeMemoryEntry({ workspace: side.ws, category: "work_rule", content: "A  B\n\n C" });
      const multi = m.writeMemoryEntry({ workspace: side.ws, category: "user_preference", content: "偏好条" });
      return { dup, beforeDup, afterDup, multi, fileText: fs.readFileSync(memoryFileOf(side), "utf8") };
    });
    expect(n.dup).toMatchObject({ ok: true, duplicate: true });
    expect(n.beforeDup).toBe(n.afterDup);
    expect(n.multi).toMatchObject({ ok: true, duplicate: false, category: "user_preference" });
    expect(n.fileText).toBe([
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
    expect(o.fileText).toBe(n.fileText);
    expectSameNorm(o.dup, n.dup);
  });

  it("既有文件分节定位：标题行间的条目插入在下一标题之前", async () => {
    const { old: o, new: n } = await runBoth((side) => {
      const target = memoryFileOf(side);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "前置说明\n\n## 经验教训\n- 旧条\n\n## 工作规则\n- 规则条\n", "utf8");
      const result = side.memory.writeMemoryEntry({ workspace: side.ws, category: "lesson", content: "新条" });
      return { result, fileText: fs.readFileSync(target, "utf8") };
    });
    expect(n.fileText).toBe("前置说明\n\n## 经验教训\n- 旧条\n\n- 新条\n## 工作规则\n- 规则条\n");
    expectSameNorm(o.result, n.result);
    expect(o.fileText).toBe(n.fileText);
  });

  it("校验：空内容 ok:false 文件不变；非法分类抛错；非法工作区抛错", async () => {
    const { old: o, new: n } = await runBoth(async (side) => {
      const m = side.memory;
      const before = fs.readFileSync(memoryFileOf(side), "utf8");
      const empty = m.writeMemoryEntry({ workspace: side.ws, category: "lesson", content: "   " });
      const badCategory = await captureError(() => m.writeMemoryEntry({ workspace: side.ws, category: "???", content: "x" }));
      const badWorkspace = await captureError(() => m.writeMemoryEntry({ workspace: "no-such-workspace", content: "x" }));
      const after = fs.readFileSync(memoryFileOf(side), "utf8");
      return { empty, badCategory, badWorkspace, unchanged: before === after };
    });
    expect(n.empty).toEqual({ ok: false, code: "MEMORY_CONTENT_EMPTY", error: "记忆内容不能为空" });
    expect(n.badCategory).toMatchObject({ thrown: true, code: "MEMORY_CATEGORY_INVALID" });
    expect(n.badWorkspace).toMatchObject({ thrown: true, code: "MEMORY_WORKSPACE_INVALID", message: "记忆所属工作区不存在或不是文件夹" });
    expect(n.unchanged).toBe(true);
    expect(o).toEqual(n);
  });
});

describe("B2-3 memory 落盘族：approveMemoryProposal", () => {
  it("批准落盘全流程：status/reviewer/approvedAt/write 面 + MEMORY.md 内容 + history", async () => {
    const { old: o, new: n } = await runBoth((side) => {
      const m = side.memory;
      const p = m.createMemoryProposal({ workspace: side.ws, category: "work_rule", content: "批准条目" });
      const approved = m.approveMemoryProposal(p.id);
      const history = m.getMemoryProposalHistory(p.id);
      const reApproved = m.approveMemoryProposal(p.id);
      return { approved, history, reApproved, fileText: fs.readFileSync(memoryFileOf(side), "utf8") };
    });
    expect(n.approved).toMatchObject({ ok: true });
    expect(n.approved.proposal).toMatchObject({ status: "approved", reviewer: "user", version: 2 });
    expect(n.approved.proposal.approvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(n.approved.write).toMatchObject({ ok: true, duplicate: false, file: "memory/MEMORY.md" });
    expect(n.history.history.map((h: any) => h.action)).toEqual(["created", "approved"]);
    expect(n.reApproved).toMatchObject({ ok: true });
    expect(n.reApproved.proposal.version).toBe(2);
    expect(n.fileText).toContain("- 批准条目");
    expectSameNorm(o, n);
  });

  it("重复条目幂等批准：duplicate:true 且文件不变", async () => {
    const { old: o, new: n } = await runBoth((side) => {
      const m = side.memory;
      const p = m.createMemoryProposal({ workspace: side.ws, category: "work_rule", content: "批准条目" });
      const before = fs.readFileSync(memoryFileOf(side), "utf8");
      const approved = m.approveMemoryProposal(p.id);
      const after = fs.readFileSync(memoryFileOf(side), "utf8");
      return { duplicate: approved.write.duplicate, before, after };
    });
    expect(n.duplicate).toBe(true);
    expect(n.before).toBe(n.after);
    expectSameNorm(o, n);
  });

  it("带编辑批准：content/category 覆盖后落盘新分节", async () => {
    const { old: o, new: n } = await runBoth((side) => {
      const m = side.memory;
      const p = m.createMemoryProposal({ workspace: side.ws, category: "lesson", content: "原稿" });
      const approved = m.approveMemoryProposal(p.id, { content: "改稿", category: "用户偏好" });
      return { approved, fileText: fs.readFileSync(memoryFileOf(side), "utf8") };
    });
    expect(n.approved).toMatchObject({ ok: true });
    expect(n.approved.proposal).toMatchObject({ status: "approved", category: "user_preference", section: "用户偏好", content: "改稿" });
    expect(n.fileText).toContain("## 用户偏好\n- 改稿");
    expectSameNorm(o, n);
  });

  it("404 / 非 pending 409 / 注入坏工作区 proposal 抛 MEMORY_WORKSPACE_INVALID", async () => {
    const { old: o, new: n } = await runBoth(async (side) => {
      const m = side.memory;
      const p = m.createMemoryProposal({ workspace: side.ws, content: "待拒绝" });
      m.rejectMemoryProposal(p.id);
      const missing = m.approveMemoryProposal("memory_missing");
      const rejected = m.approveMemoryProposal(p.id);
      fs.writeFileSync(side.proposalsFile, JSON.stringify([{
        id: "memory_seed_bad",
        content: "x",
        status: "pending",
        category: "lesson",
        workspace: path.join(side.base, "no-such-ws"),
      }]), "utf8");
      const badWorkspace = await captureError(() => m.approveMemoryProposal("memory_seed_bad"));
      return { missing, rejected, badWorkspace };
    });
    expect(n.missing).toEqual({ ok: false, status: 404, error: "proposal not found" });
    expect(n.rejected).toEqual({ ok: false, status: 409, code: "MEMORY_PROPOSAL_CONFLICT", error: "只有待审核建议可以批准" });
    expect(n.badWorkspace).toMatchObject({ thrown: true, code: "MEMORY_WORKSPACE_INVALID" });
    expect(o.missing).toEqual(n.missing);
    expect(o.rejected).toEqual(n.rejected);
    expect(o.badWorkspace).toEqual(n.badWorkspace);
  });
});

describe("B2-3 memory 落盘族：存储上限", () => {
  it("MAX_PROPOSALS：注入 300 条种子后新建 → 截到 300、最旧被淘汰", async () => {
    const { old: o, new: n } = await runBoth((side) => {
      const m = side.memory;
      const seeds = Array.from({ length: 300 }, (_, i) => ({ id: `memory_seed_${String(i).padStart(3, "0")}`, content: `c${i}` }));
      fs.writeFileSync(side.proposalsFile, JSON.stringify(seeds), "utf8");
      m.createMemoryProposal({ workspace: side.ws, content: "新条" });
      return {
        count: m.memoryProposalStoreInfo().count,
        oldestGone: m.getMemoryProposalHistory("memory_seed_000").ok,
        lastSeedAlive: m.getMemoryProposalHistory("memory_seed_299").ok,
      };
    });
    expect(n).toEqual({ count: 300, oldestGone: false, lastSeedAlive: true });
    expect(o).toEqual(n);
  });

  it("MAX_HISTORY：注入 70 条历史后编辑 → 截到 60、version 继续递增", async () => {
    const { old: o, new: n } = await runBoth((side) => {
      const m = side.memory;
      const history = Array.from({ length: 70 }, (_, i) => ({ version: i + 1, action: "seed", at: "2026-01-01T00:00:00.000Z" }));
      fs.writeFileSync(side.proposalsFile, JSON.stringify([{ id: "memory_seed_h", content: "x", status: "pending", category: "lesson", history }]), "utf8");
      const edited = m.editMemoryProposal("memory_seed_h", { content: "改" });
      const full = m.getMemoryProposalHistory("memory_seed_h");
      return { version: edited.proposal.version, historyLen: full.history.length, lastAction: full.history[full.history.length - 1].action };
    });
    expect(n).toEqual({ version: 2, historyLen: 60, lastAction: "edited" });
    expect(o).toEqual(n);
  });
});
