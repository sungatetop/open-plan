/**
 * B2-2 runs 域对拍①：快照/变更族纯函数（快照哈希缓存 / 变更过滤 / mtime 扫描 / Todo 规范化）。
 *
 * 旧侧经运行时物理路径动态 import（Node ESM，与生产 sidecar 同一加载形态），
 * 新侧静态 import TS 模块；两侧对同一脚本各跑一遍后归一比对。
 * 本文件用例不触碰 RUNS_DIR/事件流（纯函数 + 显式 root），无需 env 隔离。
 */
import { describe, expect, it, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as newRuns from "../src/main/backend/runs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "../..");
const OLD_URL = pathToFileURL(path.join(PROJECT_ROOT, "server", "runs.mjs")).href;

let oldRuns: any;

beforeAll(async () => {
  oldRuns = await import(OLD_URL);
});

/** 双侧同脚本执行：先旧后新，返回双侧结果。 */
async function runBoth<T>(fn: (runs: any) => T | Promise<T>): Promise<[T, T]> {
  return [await fn(oldRuns), await fn(newRuns)] as [T, T];
}

/** 跨侧归一：tmp 路径（JSON 转义形式做替换键，B6-6-4h 教训）+ todo/change 随机 id + ISO 时间戳 + mtime。 */
function norm(value: unknown, tmpRoots: string[]): string {
  let text = JSON.stringify(value);
  for (const root of tmpRoots) {
    text = text!.replaceAll(JSON.stringify(root).slice(1, -1), "<TMP>");
  }
  return text!
    .replaceAll(/todo-\d+-[0-9a-f]{10}/g, "todo_<ID>")
    .replaceAll(/change_[0-9a-f]{12}/g, "change_<ID>")
    .replaceAll(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z/g, "<TS>")
    .replaceAll(/"mtime":\d+(\.\d+)?/g, '"mtime":<MT>');
}

function tmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `b2runs-${label}-`));
}

describe("B2-2 runs 快照/变更族：normalizeTodoItems", () => {
  it("别名归一/done 置完成/标题回退/id 清洗与冲突去重/字段截断/dependsOn 去重", async () => {
    const items = [
      { title: "  Alpha  ", status: "todo" },
      { name: "Beta", done: true },
      { text: "Gamma", status: "in-progress", note: "备注" },
      { title: "Delta", id: "has space/!", dependsOn: ["x", "x", "", "y"] },
      { title: "Alpha", status: "unknown-status" },
      { title: "", name: "  " },
      { title: "Eps", details: "details 注", status: "done" },
    ];
    const [oldRes, newRes] = await runBoth((runs) => runs.normalizeTodoItems(items));
    expect(norm(oldRes, [])).toBe(norm(newRes, []));
    expect(newRes).toHaveLength(6);
    expect(newRes[0]).toMatchObject({ index: 0, title: "Alpha", status: "planned" });
    expect(newRes[0].id).toMatch(/^todo-1-[0-9a-f]{10}$/);
    expect(newRes[1]).toMatchObject({ title: "Beta", status: "completed" });
    expect(newRes[2]).toMatchObject({ title: "Gamma", status: "in_progress", note: "备注" });
    expect(newRes[3]).toMatchObject({ id: "has-space--", dependsOn: ["x", "y"] });
    expect(newRes[4]).toMatchObject({ title: "Alpha", status: "planned" });
    expect(newRes[4].id).not.toBe(newRes[0].id);
    expect(newRes[5]).toMatchObject({ title: "Eps", status: "completed", note: "details 注" });
  });

  it("非数组→空数组；>12 条截断；标题/备注超长截断", async () => {
    const [oldRes, newRes] = await runBoth((runs) => ([
      runs.normalizeTodoItems("not-array"),
      runs.normalizeTodoItems(Array.from({ length: 15 }, (_, i) => ({ title: `T${i}` }))).length,
      runs.normalizeTodoItems([{ title: "x".repeat(400), note: "n".repeat(600) }]).map((t: any) => ({ len: t.title.length, noteLen: t.note.length })),
    ]));
    expect(norm(oldRes, [])).toBe(norm(newRes, []));
    expect(newRes[0]).toEqual([]);
    expect(newRes[1]).toBe(12);
    expect(newRes[2]).toEqual([{ len: 300, noteLen: 500 }]);
  });
});

describe("B2-2 runs 快照/变更族：isNoiseArtifactPath / changeIdForPath", () => {
  it("噪音模式族全命中与放行样本双侧一致", async () => {
    const samples = [
      "node_modules/pkg/index.js", "sub/__pycache__/a.pyc", ".hidden.md", "dir/.agent-context.md",
      "~$报表.docx", "sub/~$a.xlsx", "_agent_write_test.py", "run_log.txt", "run_log2.json",
      "tmp_probe.py", "temp_thing.sh", "test_case.ts", "debug_out.log", "debug-thing.py",
      "a.txt.bak", "c.old", "f.pyc", "v.swp", "_scratch.py", "_jscheck.txt", "sub/_head.py",
      "报告.docx", "docs/说明.md", "data.geojson",
    ];
    const [oldRes, newRes] = await runBoth((runs) => samples.map((s) => runs.isNoiseArtifactPath(s)));
    expect(newRes).toEqual(oldRes);
    expect(newRes).toEqual([
      true, true, true, true,
      true, true, true, true, true,
      true, true, true, true, true,
      true, true, true, true, true, true, true,
      false, false, false,
    ]);
    expect(await runBoth((runs) => [runs.isNoiseArtifactPath(""), runs.isNoiseArtifactPath(null), runs.isNoiseArtifactPath("a\\b.txt")])).toEqual([[false, false, false], [false, false, false]]);
  });

  it("changeIdForPath：稳定、反斜杠归一同值、change_ 前缀", async () => {
    const [oldRes, newRes] = await runBoth((runs) => [
      runs.changeIdForPath("a/b/c.md"),
      runs.changeIdForPath("a\\b\\c.md"),
      runs.changeIdForPath("a/b/c.md"),
      runs.changeIdForPath(""),
    ]);
    expect(newRes).toEqual(oldRes);
    expect(newRes[0]).toBe(newRes[1]);
    expect(newRes[0]).toBe(newRes[2]);
    expect(newRes[0]).toMatch(/^change_[0-9a-f]{12}$/);
    expect(newRes[3]).not.toBe(newRes[0]);
  });
});

describe("B2-2 runs 快照/变更族：filterRunChanges / mergeChangeLists", () => {
  it("touchedPaths 台账过滤：前缀目录命中、对象 path/from、噪音剔除、无台账全放行", async () => {
    const runFixture = (touchedPaths: string[]) => ({ cwd: "/ws", touchedPaths });
    const changes = [
      "reports/a.md",
      "reports/b/c.md",
      "other/x.md",
      { path: "reports/d.md", status: "modified" },
      { path: "src/from-old.md", from: "src/new.md" },
      { path: "reports/tmp_skip.py" },
    ];
    const [oldRes, newRes] = await runBoth(async (runs) => ([
      runs.filterRunChanges(runFixture(["reports", "src"]), changes).map((c: any) => (typeof c === "string" ? c : c.path)),
      runs.filterRunChanges(runFixture(["."]), changes).length,
      runs.filterRunChanges(runFixture([]), changes).length,
      runs.filterRunChanges(null, changes),
      runs.filterRunChanges(runFixture(["reports"]), "bad"),
    ]));
    expect(norm(oldRes, [])).toBe(norm(newRes, []));
    // rename 台账以 path（现名）过滤，from 只作溯源：命中前缀后保留原 path 字段。
    expect(newRes[0]).toEqual(["reports/a.md", "reports/b/c.md", "reports/d.md", "src/from-old.md"]);
    // touchedPaths ["."]：只代表"写过但不知写哪"，噪音剔除后全放行
    expect(newRes[1]).toBe(5);
    expect(newRes[2]).toBe(5);
    expect(newRes[3]).toEqual([]);
    expect(newRes[4]).toEqual([]);
  });

  it("mergeChangeLists：快照优先、recent 补缺、按路径排序、detectedBy 标注", async () => {
    const snapshot = [
      { path: "b.md", status: "modified", before: { size: 1 }, after: { size: 2 } },
      { path: "a.md", status: "added" },
    ];
    const recent = [
      { path: "b.md", status: "modified" },
      { path: "c.md", status: "added" },
      { path: "", status: "added" },
    ];
    const [oldRes, newRes] = await runBoth((runs) => runs.mergeChangeLists(snapshot, recent));
    expect(norm(oldRes, [])).toBe(norm(newRes, []));
    // before/after 只在输入里携带时透传；recent 来源的条目显式补 null（快照来源的 added 不补）。
    expect(newRes).toEqual([
      { path: "a.md", status: "added", detectedBy: "snapshot" },
      { path: "b.md", status: "modified", before: { size: 1 }, after: { size: 2 }, detectedBy: "snapshot" },
      { path: "c.md", status: "added", before: null, after: null, detectedBy: "recent-mtime" },
    ]);
  });
});

describe("B2-2 runs 快照/变更族：detectRecentWorkspaceFiles", () => {
  it("窗口 mtime 扫描：新文件命中、老文件排除、隐藏与跳过目录、limit 截断、非法 sinceMs", async () => {
    const ws = tmpDir("recent");
    fs.writeFileSync(path.join(ws, "old.txt"), "old");
    fs.utimesSync(path.join(ws, "old.txt"), new Date("2000-01-01"), new Date("2000-01-01"));
    fs.writeFileSync(path.join(ws, "fresh.txt"), "fresh");
    fs.mkdirSync(path.join(ws, ".hid"));
    fs.writeFileSync(path.join(ws, ".hid", "x.txt"), "x");
    fs.mkdirSync(path.join(ws, "node_modules"));
    fs.writeFileSync(path.join(ws, "node_modules", "y.txt"), "y");
    fs.mkdirSync(path.join(ws, "sub"));
    fs.writeFileSync(path.join(ws, "sub", "s1.txt"), "s1");
    fs.writeFileSync(path.join(ws, "sub", "s2.txt"), "s2");
    const since = Date.now() - 60_000;
    const [oldRes, newRes] = await runBoth((runs) => ([
      runs.detectRecentWorkspaceFiles(ws, since),
      runs.detectRecentWorkspaceFiles(ws, since, { limit: 2 }).length,
      runs.detectRecentWorkspaceFiles(ws, NaN),
      runs.detectRecentWorkspaceFiles(ws, 0),
    ]));
    expect(norm(oldRes, [ws])).toBe(norm(newRes, [ws]));
    const paths = newRes[0].map((item: any) => item.path).sort();
    expect(paths).toEqual(["fresh.txt", "sub/s1.txt", "sub/s2.txt"]);
    for (const item of newRes[0]) {
      expect(item.size).toBeGreaterThan(0);
      expect(item.mtime).toBeGreaterThanOrEqual(since);
    }
    expect(newRes[1]).toBe(2);
    expect(newRes[2]).toEqual([]);
    expect(newRes[3]).toEqual([]);
  });
});

describe("B2-2 runs 快照/变更族：snapshotWorkspace / 哈希缓存", () => {
  it("快照结构与内容哈希、跳过目录、隐藏文件；二次快照复用缓存、改动后失效、clear 后重建", async () => {
    // 场景会改盘（a.md 改内容），必须每侧独立 ws，否则旧侧的改动会泄漏进新侧首拍。
    const [oldRes, newRes] = await runBoth((runs) => {
      const ws = tmpDir("snap");
      fs.writeFileSync(path.join(ws, "a.md"), "hello");
      fs.mkdirSync(path.join(ws, "node_modules"), { recursive: true });
      fs.writeFileSync(path.join(ws, "node_modules", "dep.js"), "dep");
      fs.mkdirSync(path.join(ws, ".git"), { recursive: true });
      fs.writeFileSync(path.join(ws, ".git", "cfg"), "cfg");
      fs.mkdirSync(path.join(ws, "d"));
      fs.writeFileSync(path.join(ws, "d", "b.txt"), "b-content");

      const first = runs.snapshotWorkspace(ws);
      const second = runs.snapshotWorkspace(ws);
      const changedRoot = path.join(ws, "a.md");
      fs.writeFileSync(changedRoot, "hello-changed");
      const third = runs.snapshotWorkspace(ws);
      runs.clearSnapshotHashCache(ws);
      const fourth = runs.snapshotWorkspace(ws);
      runs.clearSnapshotHashCache();
      const fifth = runs.snapshotWorkspace(ws);
      return {
        ws,
        root: first.root,
        capturedAtIsString: typeof first.capturedAt === "string",
        files: Object.keys(first.files).sort(),
        size: first.size,
        truncated: first.truncated,
        aHash40: /^[0-9a-f]{40}$/.test(first.files["a.md"].hash),
        hashEqualsSha1: first.files["a.md"].hash === crypto.createHash("sha1").update("hello").digest("hex"),
        bHash: first.files["d/b.txt"].hash,
        itemShape: { ...first.files["a.md"], hash: null, mtime: 0 },
        cachedSameHash: second.files["a.md"].hash === first.files["a.md"].hash,
        thirdHash: third.files["a.md"].hash,
        fourthHash: fourth.files["a.md"].hash,
        fifthHash: fifth.files["a.md"].hash,
        fourthStable: fourth.files["d/b.txt"].hash === second.files["d/b.txt"].hash,
      };
    });
    const roots = [oldRes.ws, newRes.ws];
    expect(norm(oldRes, roots)).toBe(norm(newRes, roots));
    expect(newRes.root).toBe(path.resolve(newRes.ws));
    expect(newRes.files).toEqual(["a.md", "d/b.txt"]);
    expect(newRes.size).toBe(2);
    expect(newRes.truncated).toBe(false);
    expect(newRes.aHash40).toBe(true);
    expect(newRes.hashEqualsSha1).toBe(true);
    expect(newRes.itemShape).toEqual({ path: "a.md", size: 5, hash: null, reversible: false, mtime: 0 });
    expect(newRes.cachedSameHash).toBe(true);
    expect(newRes.thirdHash).not.toBe(newRes.bHash);
    // clear 后全量重算：哈希值与缓存期一致（同一内容）
    expect(newRes.fourthHash).toBe(newRes.thirdHash);
    expect(newRes.fifthHash).toBe(newRes.thirdHash);
    expect(newRes.fourthStable).toBe(true);
  });

  it("awaitBeforeBlobs：无任务立即返回（双侧）", async () => {
    const [oldRes, newRes] = await runBoth(async (runs) => {
      await runs.awaitBeforeBlobs("no-such-run");
      return "resolved";
    });
    expect(oldRes).toBe("resolved");
    expect(newRes).toBe("resolved");
  });
});
