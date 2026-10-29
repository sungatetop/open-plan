/**
 * B2-2 runs 域①：快照/变更族纯函数（快照哈希缓存 / 变更过滤 / mtime 扫描 / Todo 规范化）。
 *
 * R6-7a 对拍退役改写：旧侧 server/runs.mjs 运行时物理路径动态 import 随 server/
 * 退役删除（等价性已在 B2-2 批对拍验收冻结），仅保留静态 import
 * src/main/backend/runs.ts 的同一套绝对断言；runBoth/norm（tmp 路径·随机 id·
 * ISO 时间戳·mtime 归一）随之删除。
 * 本文件用例不触碰 RUNS_DIR/事件流（纯函数 + 显式 root），无需 env 隔离。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import * as runs from "../src/main/backend/runs";

function tmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `b2runs-${label}-`));
}

describe("B2-2 runs 快照/变更族：normalizeTodoItems", () => {
  it("别名归一/done 置完成/标题回退/id 清洗与冲突去重/字段截断/dependsOn 去重", () => {
    const items = [
      { title: "  Alpha  ", status: "todo" },
      { name: "Beta", done: true },
      { text: "Gamma", status: "in-progress", note: "备注" },
      { title: "Delta", id: "has space/!", dependsOn: ["x", "x", "", "y"] },
      { title: "Alpha", status: "unknown-status" },
      { title: "", name: "  " },
      { title: "Eps", details: "details 注", status: "done" },
    ];
    const res = runs.normalizeTodoItems(items);
    expect(res).toHaveLength(6);
    expect(res[0]).toMatchObject({ index: 0, title: "Alpha", status: "planned" });
    expect(res[0]!.id).toMatch(/^todo-1-[0-9a-f]{10}$/);
    expect(res[1]).toMatchObject({ title: "Beta", status: "completed" });
    expect(res[2]).toMatchObject({ title: "Gamma", status: "in_progress", note: "备注" });
    expect(res[3]).toMatchObject({ id: "has-space--", dependsOn: ["x", "y"] });
    expect(res[4]).toMatchObject({ title: "Alpha", status: "planned" });
    expect(res[4]!.id).not.toBe(res[0]!.id);
    expect(res[5]).toMatchObject({ title: "Eps", status: "completed", note: "details 注" });
  });

  it("非数组→空数组；>12 条截断；标题/备注超长截断", () => {
    const res = [
      runs.normalizeTodoItems("not-array"),
      runs.normalizeTodoItems(Array.from({ length: 15 }, (_, i) => ({ title: `T${i}` }))).length,
      runs.normalizeTodoItems([{ title: "x".repeat(400), note: "n".repeat(600) }]).map((t: any) => ({ len: t.title.length, noteLen: t.note.length })),
    ];
    expect(res[0]).toEqual([]);
    expect(res[1]).toBe(12);
    expect(res[2]).toEqual([{ len: 300, noteLen: 500 }]);
  });
});

describe("B2-2 runs 快照/变更族：isNoiseArtifactPath / changeIdForPath", () => {
  it("噪音模式族全命中与放行样本", () => {
    const samples = [
      "node_modules/pkg/index.js", "sub/__pycache__/a.pyc", ".hidden.md", "dir/.agent-context.md",
      "~$报表.docx", "sub/~$a.xlsx", "_agent_write_test.py", "run_log.txt", "run_log2.json",
      "tmp_probe.py", "temp_thing.sh", "test_case.ts", "debug_out.log", "debug-thing.py",
      "a.txt.bak", "c.old", "f.pyc", "v.swp", "_scratch.py", "_jscheck.txt", "sub/_head.py",
      "报告.docx", "docs/说明.md", "data.geojson",
    ];
    expect(samples.map((s) => runs.isNoiseArtifactPath(s))).toEqual([
      true, true, true, true,
      true, true, true, true, true,
      true, true, true, true, true,
      true, true, true, true, true, true, true,
      false, false, false,
    ]);
    expect([runs.isNoiseArtifactPath(""), runs.isNoiseArtifactPath(null), runs.isNoiseArtifactPath("a\\b.txt")]).toEqual([false, false, false]);
  });

  it("changeIdForPath：稳定、反斜杠归一同值、change_ 前缀", () => {
    const res = [
      runs.changeIdForPath("a/b/c.md"),
      runs.changeIdForPath("a\\b\\c.md"),
      runs.changeIdForPath("a/b/c.md"),
      runs.changeIdForPath(""),
    ];
    expect(res[0]).toBe(res[1]);
    expect(res[0]).toBe(res[2]);
    expect(res[0]).toMatch(/^change_[0-9a-f]{12}$/);
    expect(res[3]).not.toBe(res[0]);
  });
});

describe("B2-2 runs 快照/变更族：filterRunChanges / mergeChangeLists", () => {
  it("touchedPaths 台账过滤：前缀目录命中、对象 path/from、噪音剔除、无台账全放行", () => {
    const runFixture = (touchedPaths: string[]) => ({ cwd: "/ws", touchedPaths });
    const changes = [
      "reports/a.md",
      "reports/b/c.md",
      "other/x.md",
      { path: "reports/d.md", status: "modified" },
      { path: "src/from-old.md", from: "src/new.md" },
      { path: "reports/tmp_skip.py" },
    ];
    const res = [
      runs.filterRunChanges(runFixture(["reports", "src"]), changes).map((c: any) => (typeof c === "string" ? c : c.path)),
      runs.filterRunChanges(runFixture(["."]), changes).length,
      runs.filterRunChanges(runFixture([]), changes).length,
      runs.filterRunChanges(null, changes),
      runs.filterRunChanges(runFixture(["reports"]), "bad"),
    ];
    // rename 台账以 path（现名）过滤，from 只作溯源：命中前缀后保留原 path 字段。
    expect(res[0]).toEqual(["reports/a.md", "reports/b/c.md", "reports/d.md", "src/from-old.md"]);
    // touchedPaths ["."]：只代表"写过但不知写哪"，噪音剔除后全放行
    expect(res[1]).toBe(5);
    expect(res[2]).toBe(5);
    expect(res[3]).toEqual([]);
    expect(res[4]).toEqual([]);
  });

  it("mergeChangeLists：快照优先、recent 补缺、按路径排序、detectedBy 标注", () => {
    const snapshot = [
      { path: "b.md", status: "modified", before: { size: 1 }, after: { size: 2 } },
      { path: "a.md", status: "added" },
    ];
    const recent = [
      { path: "b.md", status: "modified" },
      { path: "c.md", status: "added" },
      { path: "", status: "added" },
    ];
    // before/after 只在输入里携带时透传；recent 来源的条目显式补 null（快照来源的 added 不补）。
    expect(runs.mergeChangeLists(snapshot, recent)).toEqual([
      { path: "a.md", status: "added", detectedBy: "snapshot" },
      { path: "b.md", status: "modified", before: { size: 1 }, after: { size: 2 }, detectedBy: "snapshot" },
      { path: "c.md", status: "added", before: null, after: null, detectedBy: "recent-mtime" },
    ]);
  });
});

describe("B2-2 runs 快照/变更族：detectRecentWorkspaceFiles", () => {
  it("窗口 mtime 扫描：新文件命中、老文件排除、隐藏与跳过目录、limit 截断、非法 sinceMs", () => {
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
    const hits = runs.detectRecentWorkspaceFiles(ws, since);
    const limited = runs.detectRecentWorkspaceFiles(ws, since, { limit: 2 }).length;
    const nanHits = runs.detectRecentWorkspaceFiles(ws, NaN);
    const zeroHits = runs.detectRecentWorkspaceFiles(ws, 0);
    const paths = hits.map((item) => item.path).sort();
    expect(paths).toEqual(["fresh.txt", "sub/s1.txt", "sub/s2.txt"]);
    for (const item of hits) {
      expect(item.size).toBeGreaterThan(0);
      expect(item.mtime).toBeGreaterThanOrEqual(since);
    }
    expect(limited).toBe(2);
    expect(nanHits).toEqual([]);
    expect(zeroHits).toEqual([]);
  });
});

describe("B2-2 runs 快照/变更族：snapshotWorkspace / 哈希缓存", () => {
  it("快照结构与内容哈希、跳过目录、隐藏文件；二次快照复用缓存、改动后失效、clear 后重建", () => {
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
    fs.writeFileSync(path.join(ws, "a.md"), "hello-changed");
    const third = runs.snapshotWorkspace(ws);
    runs.clearSnapshotHashCache(ws);
    const fourth = runs.snapshotWorkspace(ws);
    runs.clearSnapshotHashCache();
    const fifth = runs.snapshotWorkspace(ws);

    expect(first.root).toBe(path.resolve(ws));
    expect(typeof first.capturedAt).toBe("string");
    expect(Object.keys(first.files).sort()).toEqual(["a.md", "d/b.txt"]);
    expect(first.size).toBe(2);
    expect(first.truncated).toBe(false);
    expect(/^[0-9a-f]{40}$/.test(first.files["a.md"].hash)).toBe(true);
    expect(first.files["a.md"].hash).toBe(crypto.createHash("sha1").update("hello").digest("hex"));
    expect({ ...first.files["a.md"], hash: null, mtime: 0 }).toEqual({ path: "a.md", size: 5, hash: null, reversible: false, mtime: 0 });
    expect(second.files["a.md"].hash).toBe(first.files["a.md"].hash);
    expect(third.files["a.md"].hash).not.toBe(first.files["a.md"].hash);
    // clear 后全量重算：哈希值与缓存期一致（同一内容）
    expect(fourth.files["a.md"].hash).toBe(third.files["a.md"].hash);
    expect(fifth.files["a.md"].hash).toBe(third.files["a.md"].hash);
    expect(fourth.files["d/b.txt"].hash).toBe(second.files["d/b.txt"].hash);
  });

  it("awaitBeforeBlobs：无任务立即返回", async () => {
    const out = await runs.awaitBeforeBlobs("no-such-run").then(() => "resolved");
    expect(out).toBe("resolved");
  });
});
