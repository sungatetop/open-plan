import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// B6-4 行为覆盖：workspace / write-coordination。
//
// R6-6b 对拍退役改写：旧侧 server/{workspace,write-coordination}.mjs 动态 import 与双侧
// 同流互等随 server 退役删除，仅保留 TS 侧断言（期望值此前已经双侧对拍固化，常量与状态
// 文件形状自 TS 源推导）。
//
// 基建设计：
// - 不 mock fs：两模块全部表面都是真实目录驱动的同步 IO（realpathSync/statSync/readdir/openSync "wx"），
//   直接走真实文件系统（独立临时目录 + 相同初始夹具），比内存 mock 更贴近生产行为。
// - vi.mock("node:url") 仅定向 fileURLToPath：workspace-paths.ts 的 __dirname 重定向到
//   假根 FAKE_NEW → PROJECT_DIR 落假根，模块级状态文件（.workspace-state.json/.file-roots.json）
//   与 office-workspace 目录都落在假根下，不触碰真实 d:\open-plan 运行时数据；测试后整根清理。
//   其余 fileURLToPath 调用（pi-config-management 链等）透传真实实现，沿 B6-3 范式以
//   OAW_DATA_DIR 重定向配置目录（显式指定时不触发 fallback 探测，无副作用）。
// - write-coordination 的 RUNS_DIR/LOCK_DIR 由 OAW_RUNS_DIR/OAW_WRITE_LOCK_DIR 每用例
//   指向独立临时目录（stubEnv 全覆盖兜底路径）。
// - fake timers 仅 toFake:["Date"]：lockedAt/stagedAt/publishedAt/created 冻结确定；
//   setTimeout 保持真实（acquireWriteLockWithRetry 退避可真实 await）。
// - 含路径的断言经 normalizePaths 归一（根目录替换为 <R>）；mkdtemp 随机名/uuid 只出现在
//   不参与比较的中间态。

type AnyMod = Record<string, any>;

const hoisted = vi.hoisted(() => {
  const base = (process.env.TEMP || process.env.TMP || "/tmp").replace(/[\\/]+$/, "");
  const stamp = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  return { fakeNew: `${base}/oaw-b64-new-${stamp}` };
});

vi.mock("node:url", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:url")>();
  const mapped = `${hoisted.fakeNew}/electron/src/main/backend/workspace-paths.ts`;
  return {
    ...actual,
    fileURLToPath: (url: URL | string) => {
      if (String(url).endsWith("electron/src/main/backend/workspace-paths.ts")) return mapped;
      return actual.fileURLToPath(url as URL);
    },
  };
});

// 路径归一映射：假根与每用例临时目录都替换为 <R>（realpath 后注册，避免 Windows 短名/大小写漂移）
const ROOTS: Array<[string, string]> = [];

function pushRoot(real: string): void {
  ROOTS.push([real, "<R>"]);
  const lower = real.toLowerCase();
  if (lower !== real) ROOTS.push([lower, "<R>"]);
}

function resetRoots(): void {
  ROOTS.length = 0;
  // 假根以 path.sep 规范形态注册：模块内部经 path.dirname/resolve 规范化后全部是反斜杠，
  // 原始 fakeNew（TEMP 以正斜杠拼接）无法命中替换
  pushRoot(hoisted.fakeNew.replace(/\//g, path.sep));
}

// 模块加载即注册假根，保证首个用例的 normalizePaths 也能命中
resetRoots();

function normalizePaths(value: any): any {
  if (typeof value === "string") {
    let out = value;
    for (const [from, to] of ROOTS) out = out.split(from).join(to);
    return out;
  }
  if (Array.isArray(value)) return value.map((item) => normalizePaths(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizePaths(item)]));
  return value;
}

function tempRoot(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `b64-${label}-`));
  pushRoot(fs.realpathSync(dir));
  return dir;
}

/** 递归树快照（相对路径排序），用于发布/回滚后的工作区形态断言。 */
function snapshotTree(rootDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      const relPath = path.relative(rootDir, p).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        out.push(`d/${relPath}`);
        walk(p);
      } else {
        out.push(`f/${relPath}`);
      }
    }
  };
  walk(rootDir);
  return out;
}

function expectSame(actual: unknown, expected: unknown): void {
  expect(normalizePaths(actual)).toEqual(normalizePaths(expected));
}

async function loadWorkspaceMods(env: Record<string, string>, { clearState = true } = {}): Promise<AnyMod> {
  vi.unstubAllEnvs();
  vi.resetModules();
  if (clearState) {
    fs.rmSync(path.join(hoisted.fakeNew, ".workspace-state.json"), { force: true });
    fs.rmSync(path.join(hoisted.fakeNew, ".file-roots.json"), { force: true });
  }
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  return (await import("../src/main/backend/workspace")) as unknown as AnyMod;
}

async function loadWriteMod(env: Record<string, string>): Promise<AnyMod> {
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  return (await import("../src/main/backend/agent/write-coordination")) as unknown as AnyMod;
}

type WsCtx = { ws: string; data: string; reload: () => Promise<AnyMod> };
type WriteCtx = { ws: string; runs: string; locks: string; reload: () => Promise<AnyMod> };

/** workspace 脚本：独立临时工作区/数据目录，同一 script 顺序执行。 */
async function runWorkspace(
  env: Record<string, string>,
  script: (m: AnyMod, ctx: WsCtx) => Promise<any> | any,
  { clearState = true } = {},
): Promise<any> {
  const ws = tempRoot("ws");
  // 数据目录移出工作区：避免 _data 目录混入 listWorkspace/searchWorkspace 夹具断言
  const data = tempRoot("data");
  const mod = await loadWorkspaceMods({ ...env, OAW_DATA_DIR: data }, { clearState });
  return script(mod, {
    ws,
    data,
    reload: () => loadWorkspaceMods({ ...env, OAW_DATA_DIR: data }, { clearState: false }),
  });
}

/** write-coordination 脚本：独立工作区 + RUNS/LOCK 临时目录。 */
async function runWrite(script: (m: AnyMod, ctx: WriteCtx) => Promise<any> | any): Promise<any> {
  const ws = tempRoot("wsws");
  const runs = tempRoot("runs");
  const locks = tempRoot("locks");
  const data = path.join(ws, "_data");
  fs.mkdirSync(data);
  const env = { OAW_RUNS_DIR: runs, OAW_WRITE_LOCK_DIR: locks, OAW_DATA_DIR: data };
  const mod = await loadWriteMod(env);
  return script(mod, { ws, runs, locks, reload: () => loadWriteMod(env) });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  resetRoots();
});

afterAll(() => {
  fs.rmSync(hoisted.fakeNew, { recursive: true, force: true });
});

function useFakeDate(): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-22T08:00:00.000Z"));
}

function eventSink(events: Array<[string, any]>): (type: string, data: unknown) => void {
  return (type, data) => { events.push([type, data]); };
}

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

describe("B6-4 workspace 行为覆盖", () => {
  it("模块常量面：PROJECT_DIR/WORKSPACE_DIR/CLIENT_DIST/AGENT_DIR/SUPPORTED_EXTENSIONS", async () => {
    useFakeDate();
    const r = await runWorkspace({ OFFICECLI_BIN: "X:/cli/officecli.exe" }, async (m) => ({
      projectDir: m.PROJECT_DIR,
      workspaceDir: m.WORKSPACE_DIR,
      clientDist: m.CLIENT_DIST,
      agentDir: m.AGENT_DIR,
      localPiAgentDir: m.LOCAL_PI_AGENT_DIR,
      officecli: m.OFFICECLI,
      supported: m.SUPPORTED_EXTENSIONS.source,
      supportedFlags: m.SUPPORTED_EXTENSIONS.flags,
    }));
    expect(r.officecli).toBe("X:/cli/officecli.exe");
    expect(r.supported).toBe("\\.(docx|doc|xlsx|xls|pptx|pdf|csv|json|md|markdown|txt|html|htm|wps|png|jpg|jpeg|gif|webp|bmp|svg|avif)$");
    expect(r.supportedFlags).toBe("i");
    expect(normalizePaths(r.projectDir)).toBe("<R>");
    expect(normalizePaths(r.workspaceDir)).toBe(path.join("<R>", "office-workspace"));
    expect(normalizePaths(r.clientDist)).toBe(path.join("<R>", "client", "dist"));
    expect(normalizePaths(r.agentDir)).toBe("<R>");
    expect(typeof r.localPiAgentDir).toBe("string");
  });

  it("OFFICECLI 默认解析链：bundled 缺失时走 LOCALAPPDATA 官方安装路径", async () => {
    useFakeDate();
    const r = await runWorkspace({ LOCALAPPDATA: "X:/LocalAppData" }, async (m) => ({ officecli: m.OFFICECLI }));
    expect(r.officecli).toBe(path.join("X:/LocalAppData", "OfficeCLI", "officecli.exe"));
  });

  it("safeName / isInside 纯函数矩阵", async () => {
    useFakeDate();
    const r = await runWorkspace({}, async (m) => ({
      safeName: [null, "", "..", "a/b", "a\\b", "x:y", "a<b>", "报告?.docx", "正常 报告.docx", ".gitignore", "ends.", "nul", "..d"].map((v) => m.safeName(v)),
      isInside: [["/a", "/a"], ["/a", "/a/b"], ["/a", "/ab"], ["/a/b", "/a"], ["/a", "/b"], ["", ""], ["/a/", "/a/b"]].map(([root, target]) => m.isInside(root, target)),
    }));
    // Windows path.basename 行为锚点："a/b"→"b"、"\\"分隔→"b"、"x:y"→"y"（盘符相对）、
    // "..d" 含 ".." 子串→null；""/".." 空或父引用→null
    expect(r.safeName).toEqual([null, null, null, "b", "b", "y", null, null, "正常 报告.docx", ".gitignore", "ends.", "nul", null]);
    // ["",""]：path.relative("","") 相对 cwd 解析为空串 → isInside 为 true
    expect(r.isInside).toEqual([true, true, false, false, false, true, true]);
  });

  it("normalizeWorkspace：不存在/创建/文件路径/空串", async () => {
    useFakeDate();
    const r = await runWorkspace({}, async (m, ctx) => {
      const missing = path.join(ctx.ws, "不存在");
      const fileTarget = path.join(ctx.ws, "file.txt");
      fs.writeFileSync(fileTarget, "x");
      const result = {
        missing: m.normalizeWorkspace(missing),
        created: m.normalizeWorkspace(missing, { create: true }),
        createdAgain: m.normalizeWorkspace(missing),
        fileTarget: m.normalizeWorkspace(fileTarget),
        empty: m.normalizeWorkspace(""),
        wsRoot: m.normalizeWorkspace(ctx.ws),
        defaultDir: m.normalizeWorkspace(),
        missingReal: fs.realpathSync(missing),
      };
      return result;
    });
    expect(r.missing).toBeNull();
    expect(r.empty).toBeNull();
    expect(r.fileTarget).toBeNull();
    expect(r.created).toBe(r.missingReal);
    expect(r.createdAgain).toBe(r.missingReal);
    expect(normalizePaths(r.wsRoot)).toBe("<R>");
    // 缺省目录 = 模块级 _currentWorkspace 初值 = WORKSPACE_DIR（假根 office-workspace）
    expect(normalizePaths(r.defaultDir)).toBe(path.join("<R>", "office-workspace"));
  });

  it("setWorkspace/getWorkspace 持久化 + 重 import 恢复 + hiddenWorkspaces", async () => {
    useFakeDate();
    const r = await runWorkspace({}, async (m, ctx) => {
      const target = path.join(ctx.ws, "工作区甲");
      fs.mkdirSync(target);
      expect(m.setWorkspace(target)).toBe(true);
      expect(m.setWorkspace("")).toBe(false);
      const first = { workspace: m.getWorkspace() };
      const stateFile = readJson(path.join(m.PROJECT_DIR, ".workspace-state.json"));
      // 重新加载模块：_currentWorkspace 从状态文件恢复
      const m2 = await ctx.reload();
      const restored = { workspace: m2.getWorkspace() };
      // 隐藏工作区：一个真实目录 + 一个不存在的字面路径
      expect(m2.hideWorkspace(target)).toBe(true);
      const ghost = path.join(ctx.ws, "幽灵工作区");
      expect(m2.hideWorkspace(ghost)).toBe(true);
      expect(m2.hideWorkspace(target)).toBe(true); // 重复隐藏幂等
      const hidden = m2.getHiddenWorkspaces();
      const state2 = readJson(path.join(m2.PROJECT_DIR, ".workspace-state.json"));
      return { first, restored, stateFile, hidden, state2, targetReal: fs.realpathSync(target), ghost };
    });
    expect(r.first.workspace).toBe(r.targetReal);
    expect(r.restored.workspace).toBe(r.targetReal);
    expect(r.stateFile).toEqual({ workspace: r.targetReal });
    expect(r.hidden).toEqual([r.targetReal, r.ghost]);
    expect(r.state2).toEqual({ workspace: r.targetReal, hiddenWorkspaces: [r.targetReal, r.ghost] });
  });

  it("fileRoots 增删查 + resolveExternalPath 矩阵", async () => {
    useFakeDate();
    const r = await runWorkspace({}, async (m, ctx) => {
      const ext = path.join(ctx.ws, "外部资料");
      fs.mkdirSync(ext);
      fs.mkdirSync(path.join(ext, "doc"));
      fs.writeFileSync(path.join(ext, "doc", "a.docx"), "hello");
      fs.writeFileSync(path.join(ext, "顶层.txt"), "t");
      const added = m.addFileRoot(ext, "外部资料");
      const again = m.addFileRoot(ext, "改名无效");
      const roots1 = m.listFileRoots();
      const id = added.root?.id ?? "";
      const removed = m.removeFileRoot(id);
      const notFound = m.removeFileRoot("无此id");
      const empty = m.addFileRoot("");
      // 重新添加用于 resolveExternalPath 矩阵
      const added2 = m.addFileRoot(ext, "外部资料");
      const id2 = added2.root?.id ?? "";
      return {
        addedShape: added.ok && /^[0-9a-f]{12}$/.test(added.root.id) && added.root.label === "外部资料" ? { ok: added.ok, label: added.root.label, created: added.root.created } : added,
        againRootPath: again.root?.path,
        againOk: again.ok,
        roots1: roots1.map((item: any) => ({ ...item, id: "<ID>" })),
        removedOk: removed.ok,
        removedRoots: (removed.roots ?? []).map((item: any) => ({ ...item, id: "<ID>" })),
        notFound,
        empty,
        hit: m.resolveExternalPath(id2, "doc/a.docx"),
        hitTop: m.resolveExternalPath(id2, "/顶层.txt"),
        escape: m.resolveExternalPath(id2, "../逃逸.txt"),
        nullRel: m.resolveExternalPath(id2, ""),
        absRel: m.resolveExternalPath(id2, "C:/Windows"),
        missing: m.resolveExternalPath(id2, "doc/不存在.docx"),
        badId: m.resolveExternalPath("无此id", "doc/a.docx"),
        extReal: fs.realpathSync(ext),
      };
    });
    expect(r.addedShape).toEqual({ ok: true, label: "外部资料", created: "2026-10-22T08:00:00.000Z" });
    expect(r.againOk).toBe(true);
    expect(r.againRootPath).toBe(r.extReal);
    expect(r.roots1).toEqual([{ id: "<ID>", path: r.extReal, label: "外部资料", created: "2026-10-22T08:00:00.000Z" }]);
    expect(r.removedOk).toBe(true);
    expect(r.removedRoots).toEqual([]);
    expect(r.notFound).toEqual({ ok: false, error: "root not found" });
    expect(r.empty).toEqual({ ok: false, error: "path required" });
    expect(r.hit).toBe(path.join(r.extReal, "doc", "a.docx"));
    expect(r.hitTop).toBe(path.join(r.extReal, "顶层.txt"));
    expect(r.escape).toBeNull();
    expect(r.nullRel).toBeNull();
    expect(r.absRel).toBeNull();
    expect(r.missing).toBeNull();
    expect(r.badId).toBeNull();
  });

  it("listWorkspace / searchWorkspace：夹具过滤、排序与投影", async () => {
    useFakeDate();
    const r = await runWorkspace({}, async (m, ctx) => {
      fs.mkdirSync(path.join(ctx.ws, "报告集"));
      fs.writeFileSync(path.join(ctx.ws, "报告集", "nested.csv"), "1,2");
      fs.writeFileSync(path.join(ctx.ws, "a报告.docx"), "doc");
      fs.writeFileSync(path.join(ctx.ws, "b表格.xlsx"), "xls");
      fs.writeFileSync(path.join(ctx.ws, "notes.md"), "md");
      fs.writeFileSync(path.join(ctx.ws, "~$temp.docx"), "lock");
      fs.writeFileSync(path.join(ctx.ws, ".hidden.txt"), "h");
      fs.writeFileSync(path.join(ctx.ws, "skip.exe"), "exe");
      const strip = (list: any[]) => list.map((e) => ({ ...e, mtime: 0 }));
      return {
        list: strip(m.listWorkspace(ctx.ws)),
        listDefault: strip(m.listWorkspace()),
        searchA: strip(m.searchWorkspace("a", { dir: ctx.ws })),
        searchMulti: strip(m.searchWorkspace("报告 docx", { dir: ctx.ws })),
        searchNested: strip(m.searchWorkspace("nested", { dir: ctx.ws })),
        searchEmpty: strip(m.searchWorkspace("", { dir: ctx.ws })),
        searchLimit: strip(m.searchWorkspace("报", { dir: ctx.ws, limit: 1 })),
      };
    });
    expect(r.list.map((e: any) => [e.name, e.isDir, e.ext, e.size])).toEqual([
      ["报告集", true, "folder", 0],
      ["a报告.docx", false, "docx", 3],
      ["b表格.xlsx", false, "xlsx", 3],
      ["notes.md", false, "md", 2],
    ]);
    // "nested" 不含字母 a：searchA 只命中 a报告.docx
    expect(r.searchA.map((e: any) => [e.relPath, e.isDir])).toEqual([
      ["a报告.docx", false],
    ]);
    expect(r.searchMulti.map((e: any) => e.relPath)).toEqual(["a报告.docx"]);
    expect(r.searchNested.map((e: any) => e.relPath)).toEqual(["报告集/nested.csv"]);
    expect(r.searchEmpty).toEqual([]);
    // limit 截断发生在遍历中途（NTFS 序 a报告.docx 先于 报告集，files 达到 limit 即 break）
    expect(r.searchLimit.map((e: any) => e.relPath)).toEqual(["a报告.docx"]);
  });

  it("resolvePath / filePath 矩阵", async () => {
    useFakeDate();
    const r = await runWorkspace({}, async (m, ctx) => {
      fs.mkdirSync(path.join(ctx.ws, "子目录"));
      fs.writeFileSync(path.join(ctx.ws, "子目录", "报告.docx"), "x");
      fs.writeFileSync(path.join(ctx.ws, "顶层.docx"), "x");
      const cases = [
        "顶层.docx",
        "子目录/报告.docx",
        "子目录\\报告.docx",
        "/子目录/报告.docx",
        "\\子目录\\报告.docx",
        null as unknown as string,
        "",
        "无此文件.docx",
        "../逃逸.docx",
        "子目录/../顶层.docx",
        "a\0b",
        "C:/Windows/system32",
        "\\\\srv/share",
        "file:///x",
      ];
      return {
        resolved: cases.map((c) => m.resolvePath(c, ctx.ws)),
        filePath: m.filePath("顶层.docx", ctx.ws),
        filePathNull: m.filePath("无此文件.docx", ctx.ws),
        defaultWs: m.resolvePath("顶层.docx"),
      };
    });
    expect(r.resolved[0]).toContain("顶层.docx");
    expect(r.resolved[9]).toBeNull(); // 含 .. 段
    expect(r.resolved[10]).toBeNull();
    expect(r.resolved[11]).toBeNull();
    expect(r.resolved[12]).toBeNull();
    expect(r.resolved[13]).toBeNull();
    expect(r.defaultWs).toBeNull();
  });
});

describe("B6-4 write-coordination 行为覆盖", () => {
  it("ensureRunStaging / safeRunId / isTempWorkPath / isProtectedMemoryTarget", async () => {
    useFakeDate();
    const r = await runWrite(async (m, ctx) => {
      const info = m.ensureRunStaging("run_1", ctx.ws);
      const bad = (() => { try { m.ensureRunStaging("bad id!", ctx.ws); return null; } catch (e: any) { return { message: e.message }; } })();
      const tempPaths = [
        ".work/x.json", ".work-review.html", ".tmp/1", ".temp2/1", ".cache/1", ".scratch/1",
        ".ch6work/b4.json", ".intermediate/1", "a.bak", "a.tmp", "a.orig", "备份~", "a.TMP",
        "正常.docx", ".workspace/config.json", "work/x.json", "tmpwork/x", "", "./.work/x.json",
      ].map((p) => m.isTempWorkPath(p));
      const memory = [
        "agents.md", "AGENTS.md", "memory", "memory/", "memory/笔记.md", "memoryx", "memory2/1", "docs/a.docx",
      ].map((p) => m.isProtectedMemoryTarget(ctx.ws, path.join(ctx.ws, p)));
      const memoryBadWs = m.isProtectedMemoryTarget(path.join(ctx.ws, "无此工作区"), "agents.md");
      return { info, bad, tempPaths, memory, memoryBadWs, stagingExists: fs.existsSync(path.join(ctx.runs, "run_1", "staging")) };
    });
    expect(r.info.runId).toBe("run_1");
    expect(r.bad).toEqual({ message: "活动 Run 标识无效" });
    expect(r.stagingExists).toBe(true);
    // ".temp2/1"：TEMP_WORK_PATTERN 要求 .temp 后跟 [-._/] 或结尾，"2" 不命中
    expect(r.tempPaths).toEqual([true, true, true, false, true, true, true, true, true, true, true, true, true, false, false, false, false, false, true]);
    expect(r.memory).toEqual([true, true, true, true, true, false, false, false]);
    expect(r.memoryBadWs).toBe(false);
  });

  it("acquireWriteLock 基本流：token/锁文件/重入/冲突/释放", async () => {
    useFakeDate();
    const r = await runWrite(async (m, ctx) => {
      const token1 = m.acquireWriteLock({ workspace: ctx.ws, targetPath: path.join(ctx.ws, "a.docx"), runId: "run-1", threadId: "t1", kind: "agent" });
      const reentrant = m.acquireWriteLock({ workspace: ctx.ws, targetPath: path.join(ctx.ws, "a.docx"), runId: "run-1" });
      const conflict = (() => {
        try {
          m.acquireWriteLock({ workspace: ctx.ws, targetPath: path.join(ctx.ws, "a.docx"), runId: "run-2" });
          return null;
        } catch (e: any) {
          return { name: e.name, code: e.code, message: e.message, details: e.details };
        }
      })();
      // 锁文件：lock 目录唯一 .lock 文件
      const lockNames = fs.readdirSync(ctx.locks).filter((n: string) => n.endsWith(".lock"));
      const lockRecord = lockNames.length === 1 ? readJson(path.join(ctx.locks, lockNames[0] ?? "")) : null;
      const release1 = m.releaseWriteLock(token1);
      const release2 = m.releaseWriteLock(reentrant);
      const releaseAgain = m.releaseWriteLock(reentrant);
      const lockAfterRelease = fs.readdirSync(ctx.locks).filter((n: string) => n.endsWith(".lock"));
      const releasedOther = m.releaseWriteLock({ key: token1.key, runId: "别人" });
      const releaseRun = m.releaseRunLocks("run-1");
      const noRun = m.releaseRunLocks("");
      return { token1, reentrant, conflict, lockRecord, release1, release2, releaseAgain, lockAfterRelease: lockAfterRelease.length, releasedOther, releaseRun, noRun };
    });
    expect(r.token1).toEqual({ key: expect.any(String), runId: "run-1", reentrant: false });
    expect(r.reentrant).toEqual({ key: r.token1.key, runId: "run-1", reentrant: true });
    expect(r.conflict.name).toBe("WriteConflictError");
    expect(r.conflict.code).toBe("WRITE_CONFLICT");
    expect(r.conflict.message).toBe("文件正在被其他任务修改：a.docx");
    expect(r.conflict.details.ownerRunId).toBe("run-1");
    expect(r.conflict.details.ownerThreadId).toBe("t1");
    expect(r.conflict.details.ownerKind).toBe("agent");
    expect(r.lockRecord.runId).toBe("run-1");
    expect(r.lockRecord.threadId).toBe("t1");
    expect(r.lockRecord.kind).toBe("agent");
    expect(r.lockRecord.pid).toBe(process.pid);
    expect(r.lockRecord.lockedAt).toBe("2026-10-22T08:00:00.000Z");
    expect(r.release1).toBe(true);
    expect(r.release2).toBe(true);
    expect(r.releaseAgain).toBe(false);
    expect(r.lockAfterRelease).toBe(0);
    expect(r.releasedOther).toBe(false);
    expect(r.releaseRun).toBe(0);
    expect(r.noRun).toBe(0);
  });

  it("跨实例锁：外部重叠冲突 + 同 owner 撞锁文件 + 实例1 释放后实例2 可得", async () => {
    useFakeDate();
    const r = await runWrite(async (m, ctx) => {
      const token = m.acquireWriteLock({ workspace: ctx.ws, targetPath: path.join(ctx.ws, "报告.docx"), runId: "run-A", kind: "agent" });
      const m2 = await ctx.reload();
      const conflictExternal = (() => {
        try {
          m2.acquireWriteLock({ workspace: ctx.ws, targetPath: path.join(ctx.ws, "报告.docx"), runId: "run-B", kind: "agent" });
          return null;
        } catch (e: any) {
          return { code: e.code, message: e.message, details: e.details };
        }
      })();
      const overlapSelf = (() => {
        try {
          m2.acquireWriteLock({ workspace: ctx.ws, targetPath: path.join(ctx.ws, "报告.docx"), runId: "run-A", kind: "agent" });
          return null;
        } catch (e: any) {
          return { code: e.code, message: e.message, details: e.details };
        }
      })();
      const m1CanRelease = m.releaseWriteLock(token);
      const token2 = m2.acquireWriteLock({ workspace: ctx.ws, targetPath: path.join(ctx.ws, "报告.docx"), runId: "run-B", kind: "agent" });
      const m2Got = token2.runId === "run-B" && token2.reentrant === false;
      m2.releaseWriteLock(token2);
      return { conflictExternal, overlapSelf, m1CanRelease, m2Got };
    });
    expect(r.conflictExternal.code).toBe("WRITE_CONFLICT");
    expect(r.conflictExternal.message).toContain("写入范围与其他任务冲突");
    expect(r.conflictExternal.details.ownerRunId).toBe("run-A");
    expect(r.conflictExternal.details.ownerKind).toBe("agent");
    expect(r.overlapSelf.code).toBe("WRITE_CONFLICT");
    expect(r.overlapSelf.message).toContain("文件正在被其他进程修改");
    expect(r.m1CanRelease).toBe(true);
    expect(r.m2Got).toBe(true);
  });

  it("reclaimStaleWriteLocks：stale 删除计数、alive 保留、无效 pid 判定", async () => {
    useFakeDate();
    const r = await runWrite(async (m, ctx) => {
      const write = (name: string, record: unknown) => fs.writeFileSync(path.join(ctx.locks, name), JSON.stringify(record) + "\n", "utf8");
      write("stale.lock", { target: "X", pid: 99999999, runId: "old" });
      write("alive.lock", { target: "Y", pid: process.pid, runId: "cur" });
      write("zero.lock", { target: "Z", pid: 0, runId: "z" });
      write("garbage.lock", { target: "W", pid: "not-a-number", runId: "g" });
      const reclaimed = m.reclaimStaleWriteLocks();
      const remaining = fs.readdirSync(ctx.locks).sort();
      const aliveKept = readJson(path.join(ctx.locks, "alive.lock"));
      const again = m.reclaimStaleWriteLocks();
      return { reclaimed, remaining, aliveKept, again };
    });
    expect(r.reclaimed).toBe(3);
    expect(r.remaining).toEqual(["alive.lock"]);
    expect(r.aliveKept.runId).toBe("cur");
    expect(r.again).toBe(0);
  });

  it("acquireWriteLockWithRetry：冲突后等待释放再得锁", async () => {
    useFakeDate();
    const r = await runWrite(async (m, ctx) => {
      const token = m.acquireWriteLock({ workspace: ctx.ws, targetPath: path.join(ctx.ws, "a.docx"), runId: "run-A" });
      const sleep = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });
      const retryPromise = m.acquireWriteLockWithRetry({ workspace: ctx.ws, targetPath: path.join(ctx.ws, "a.docx"), runId: "run-B" }, { timeoutMs: 8000, intervalMs: 30 });
      const raced = await Promise.race([retryPromise.then(() => "got"), sleep(150).then(() => "still-waiting")]);
      const timedOut = raced === "still-waiting";
      await sleep(60);
      m.releaseWriteLock(token);
      const token2 = await retryPromise;
      return { timedOut, runId: token2.runId, reentrant: token2.reentrant };
    });
    expect(r.timedOut).toBe(true);
    expect(r.runId).toBe("run-B");
    expect(r.reentrant).toBe(false);
  });

  it("validateTarget 面：无效工作区/越界/工作区根/缺 Run/withWriteLock", async () => {
    useFakeDate();
    const r = await runWrite(async (m, ctx) => {
      const attempt = (fn: () => unknown) => {
        try { return { ok: true, value: fn() }; } catch (e: any) { return { ok: false, code: e.code, message: e.message }; }
      };
      const badWs = attempt(() => m.acquireWriteLock({ workspace: path.join(ctx.ws, "无"), targetPath: path.join(ctx.ws, "a.docx"), runId: "r" }));
      const escape = attempt(() => m.acquireWriteLock({ workspace: ctx.ws, targetPath: path.join(ctx.ws, "..", "外部.docx"), runId: "r" }));
      const rootHold = attempt(() => m.holdWorkspaceWriteLock({ workspace: ctx.ws, runId: "r-ws", kind: "workspace" }));
      const lockNames = fs.readdirSync(ctx.locks).filter((n: string) => n.endsWith(".lock"));
      const rootRecord = lockNames.length === 1 ? readJson(path.join(ctx.locks, lockNames[0] ?? "")) : null;
      // 工作区级锁是外部重叠锁：不释放会让后续 acquireWriteLock 撞 findExternalOverlap 冲突
      m.releaseWriteLock(rootHold.value);
      const missingRun = attempt(() => m.acquireWriteLock({ workspace: ctx.ws, targetPath: path.join(ctx.ws, "a.docx") }));
      const withWriteLockValue = attempt(() => m.withWriteLock({ workspace: ctx.ws, targetPath: path.join(ctx.ws, "b.docx"), runId: "r2" }, () => 42));
      const lockCountAfter = fs.readdirSync(ctx.locks).filter((n: string) => n.endsWith(".lock")).length;
      return { badWs, escape, rootHold, rootRecord, missingRun, withWriteLockValue, lockCountAfter };
    });
    expect(r.badWs.ok).toBe(false);
    expect(r.badWs.code).toBe("WORKSPACE_INVALID");
    expect(r.badWs.message).toBe("工作区不存在或不是文件夹");
    expect(r.escape.ok).toBe(false);
    expect(r.escape.code).toBe("WRITE_SCOPE_ERROR");
    expect(r.escape.message).toContain("写入路径必须位于当前工作区内");
    expect(r.rootHold.ok).toBe(true);
    expect(r.rootRecord.runId).toBe("r-ws");
    expect(r.rootRecord.kind).toBe("workspace");
    expect(r.missingRun.ok).toBe(false);
    expect(r.missingRun.code).toBe("RUN_REQUIRED");
    expect(r.withWriteLockValue).toEqual({ ok: true, value: 42 });
    expect(r.lockCountAfter).toBe(0);
  });

  it("stageWrite 全链：staging 结构/manifest/事件序/memory 保护/根目标拒绝", async () => {
    useFakeDate();
    const r = await runWrite(async (m, ctx) => {
      const ev: Array<[string, any]> = [];
      const onEvent = eventSink(ev);
      const r1 = m.stageWrite({ runId: "run-1", workspace: ctx.ws, targetPath: path.join(ctx.ws, "docs", "报告.docx"), content: "内容A", kind: "agent", threadId: "t1", onEvent });
      const r2 = m.stageWrite({ runId: "run-1", workspace: ctx.ws, targetPath: path.join(ctx.ws, "docs", "报告.docx"), content: "内容BB", kind: "agent", onEvent });
      const stagedFile = fs.readFileSync(path.join(ctx.runs, "run-1", "staging", "docs", "报告.docx"), "utf8");
      const manifest = readJson(path.join(ctx.runs, "run-1", "写入清单.json"));
      // memory 保护与根目标拒绝发生在 try 外：抛错但不产生事件
      const memoryRejected = (() => {
        try {
          m.stageWrite({ runId: "run-1", workspace: ctx.ws, targetPath: path.join(ctx.ws, "memory", "笔记.md"), content: "x", kind: "agent", onEvent });
          return null;
        } catch (e: any) { return { code: e.code, message: e.message }; }
      })();
      const memoryApproval = m.stageWrite({ runId: "run-1", workspace: ctx.ws, targetPath: path.join(ctx.ws, "memory", "新记忆.md"), content: "记", kind: "memory_approval", onEvent });
      const attachment = m.stageWrite({ runId: "run-1", workspace: ctx.ws, targetPath: path.join(ctx.ws, "memory", "附件.bin"), content: "a", kind: "attachment", onEvent });
      // 工作区根目标：allowWorkspaceRoot:false 在 validateTarget 即拒（"不能把工作区根…"为防御死分支）
      const rootRejected = (() => {
        try {
          m.stageWrite({ runId: "run-1", workspace: ctx.ws, targetPath: ctx.ws, content: "x", kind: "agent", onEvent });
          return null;
        } catch (e: any) { return { code: e.code, message: e.message }; }
      })();
      const manifest2 = readJson(path.join(ctx.runs, "run-1", "写入清单.json"));
      return { r1, r2, stagedFile, manifest, memoryRejected, memoryApproval, attachment, rootRejected, manifest2, ev };
    });
    expect(r.r1).toMatchObject({ ok: true, path: "docs/报告.docx", stagedPath: "staging/docs/报告.docx", status: "added", writes: 1, size: 7 });
    expect(r.r2).toMatchObject({ ok: true, status: "added", writes: 2, size: 8 });
    expect(r.stagedFile).toBe("内容BB");
    expect(r.manifest.files).toHaveLength(1);
    expect(r.memoryRejected).toEqual({ code: "MEMORY_WRITE_REQUIRES_PROPOSAL", message: "长期记忆必须通过 memory_update 建议并经用户审核，不能使用普通文件写入工具" });
    expect(r.memoryApproval).toMatchObject({ ok: true, kind: "memory_approval" });
    expect(r.attachment).toMatchObject({ ok: true, kind: "attachment" });
    expect(r.rootRejected.code).toBe("WRITE_SCOPE_ERROR");
    expect(r.rootRejected.message).toContain("写入路径必须位于当前工作区内");
    expect(r.manifest2.files).toHaveLength(3);
    expect(r.ev.map((e: [string, any]) => e[0])).toEqual([
      "write_started", "write_locked", "artifact_staged",
      "write_started", "write_locked", "artifact_staged",
      "write_started", "write_locked", "artifact_staged",
      "write_started", "write_locked", "artifact_staged",
    ]);
  });

  it("读取面：resolveReadablePath/stagedAccess/listStagedFiles/listStagedFilesForValidation", async () => {
    useFakeDate();
    const r = await runWrite(async (m, ctx) => {
      m.stageWrite({ runId: "run-1", workspace: ctx.ws, targetPath: path.join(ctx.ws, "docs", "报告.docx"), content: "内容A", kind: "agent" });
      fs.writeFileSync(path.join(ctx.ws, "直接落盘.txt"), "disk");
      const stagedHit = m.resolveReadablePath({ runId: "run-1", workspace: ctx.ws, targetPath: path.join(ctx.ws, "docs", "报告.docx") });
      const diskDirect = m.resolveReadablePath({ runId: "run-1", workspace: ctx.ws, targetPath: path.join(ctx.ws, "直接落盘.txt") });
      const noManifest = m.resolveReadablePath({ runId: "run-2", workspace: ctx.ws, targetPath: path.join(ctx.ws, "直接落盘.txt") });
      const outside = m.resolveReadablePath({ runId: "run-1", workspace: ctx.ws, targetPath: path.join(ctx.ws, "..", "AGENTS.md") });
      const accessStaged = m.stagedAccess({ runId: "run-1", workspace: ctx.ws, targetPath: path.join(ctx.ws, "docs", "报告.docx") });
      const accessMissing = (() => {
        try { m.stagedAccess({ runId: "run-1", workspace: ctx.ws, targetPath: path.join(ctx.ws, "无.docx") }); return null; } catch (e: any) { return { code: e.code }; }
      })();
      const list = m.listStagedFiles("run-1");
      const forValidation = m.listStagedFilesForValidation("run-1");
      return { stagedHit, diskDirect, noManifest, outside, accessStaged, accessMissing, list, forValidation };
    });
    expect(r.stagedHit).toContain("报告.docx");
    expect(r.diskDirect).toContain("直接落盘.txt");
    expect(r.noManifest).toContain("直接落盘.txt");
    expect(r.outside).toContain("AGENTS.md");
    expect(r.accessStaged).toContain("报告.docx");
    expect(r.accessMissing).toEqual({ code: "ENOENT" });
    expect(r.list).toHaveLength(1);
    expect(r.forValidation[0].file).toContain("报告.docx");
  });

  it("ensureStagedDirectory：建目录 + memory 保护 + attachment 放行", async () => {
    useFakeDate();
    const r = await runWrite(async (m, ctx) => {
      const made = m.ensureStagedDirectory({ runId: "run-1", workspace: ctx.ws, targetPath: path.join(ctx.ws, "交付", "多级") });
      const memoryRejected = (() => {
        try { m.ensureStagedDirectory({ runId: "run-1", workspace: ctx.ws, targetPath: path.join(ctx.ws, "memory"), kind: "write" }); return null; } catch (e: any) { return { code: e.code, message: e.message }; }
      })();
      const attachmentOk = m.ensureStagedDirectory({ runId: "run-1", workspace: ctx.ws, targetPath: path.join(ctx.ws, "memory", "附件目录"), kind: "attachment" });
      const staged = fs.readdirSync(path.join(ctx.runs, "run-1", "staging"), { withFileTypes: true }).map((e: any) => e.name).sort();
      const nested = fs.existsSync(path.join(ctx.runs, "run-1", "staging", "交付", "多级"));
      return { made, memoryRejected, attachmentOk, staged, nested };
    });
    expect(r.memoryRejected).toEqual({ code: "MEMORY_WRITE_REQUIRES_PROPOSAL", message: "长期记忆目录不能通过普通文件工具创建" });
    expect(r.staged.slice().sort()).toEqual(["memory", "交付"]);
    expect(r.nested).toBe(true);
  });

  it("materializeStagedReferences：物化新产物、跳过磁盘更新版", async () => {
    useFakeDate();
    const r = await runWrite(async (m, ctx) => {
      m.stageWrite({ runId: "run-1", workspace: ctx.ws, targetPath: path.join(ctx.ws, "docs", "物化.docx"), content: "暂存版", kind: "agent" });
      m.stageWrite({ runId: "run-1", workspace: ctx.ws, targetPath: path.join(ctx.ws, "docs", "新.docx"), content: "暂存版", kind: "agent" });
      fs.mkdirSync(path.join(ctx.ws, "docs"));
      fs.writeFileSync(path.join(ctx.ws, "docs", "新.docx"), "磁盘更新版");
      const materialized = m.materializeStagedReferences({ runId: "run-1", workspace: ctx.ws, paths: ["./docs/物化.docx", "docs/新.docx"] });
      const content = fs.readFileSync(path.join(ctx.ws, "docs", "物化.docx"), "utf8");
      const contentSkip = fs.readFileSync(path.join(ctx.ws, "docs", "新.docx"), "utf8");
      const manifest = readJson(path.join(ctx.runs, "run-1", "写入清单.json"));
      const empty = m.materializeStagedReferences({ runId: "run-1", workspace: ctx.ws, paths: [] });
      const noRun = m.materializeStagedReferences({ workspace: ctx.ws, paths: ["docs/物化.docx"] });
      return { materialized, content, contentSkip, materializedAt: manifest.files.map((f: any) => f.materializedAt ?? null), empty, noRun };
    });
    expect(r.materialized).toEqual(["docs/物化.docx"]);
    expect(r.content).toBe("暂存版");
    expect(r.contentSkip).toBe("磁盘更新版");
    expect(r.materializedAt[0]).toBe("2026-10-22T08:00:00.000Z");
    expect(r.materializedAt[1]).toBeNull();
    expect(r.empty).toEqual([]);
    expect(r.noRun).toEqual([]);
  });

  it("publishStagedRun：正式发布/临时剔除/白名单/回滚/备份清理", async () => {
    useFakeDate();
    const r = await runWrite(async (m, ctx) => {
      // 场景1：正式发布（含覆盖既有文件 + 临时文件剔除）
      m.stageWrite({ runId: "run-1", workspace: ctx.ws, targetPath: path.join(ctx.ws, "交付", "正式A.docx"), content: "新版A", kind: "agent" });
      m.stageWrite({ runId: "run-1", workspace: ctx.ws, targetPath: path.join(ctx.ws, "交付", "正式B.docx"), content: "新版B", kind: "agent" });
      m.stageWrite({ runId: "run-1", workspace: ctx.ws, targetPath: path.join(ctx.ws, ".work", "中间.json"), content: "{}", kind: "agent" });
      m.stageWrite({ runId: "run-1", workspace: ctx.ws, targetPath: path.join(ctx.ws, "交付", "旧.docx.bak"), content: "bak", kind: "agent" });
      fs.mkdirSync(path.join(ctx.ws, "交付"));
      fs.writeFileSync(path.join(ctx.ws, "交付", "正式A.docx"), "旧版A");
      const ev1: Array<[string, any]> = [];
      const published = m.publishStagedRun("run-1", ctx.ws, { onEvent: eventSink(ev1), threadId: "t1" });
      const tree1 = snapshotTree(ctx.ws);
      const stagedTempFileGone = !fs.existsSync(path.join(ctx.runs, "run-1", "staging", ".work", "中间.json"));
      const backupLeft = fs.existsSync(path.join(ctx.runs, "run-1", "发布备份"));
      const manifest1 = readJson(path.join(ctx.runs, "run-1", "写入清单.json"));

      // 场景2：白名单部分发布
      m.stageWrite({ runId: "run-2", workspace: ctx.ws, targetPath: path.join(ctx.ws, "交付", "甲.docx"), content: "甲", kind: "agent" });
      m.stageWrite({ runId: "run-2", workspace: ctx.ws, targetPath: path.join(ctx.ws, "交付", "乙.docx"), content: "乙", kind: "agent" });
      const ev2: Array<[string, any]> = [];
      const published2 = m.publishStagedRun("run-2", ctx.ws, { onEvent: eventSink(ev2), paths: ["交付/乙.docx"] });
      const manifest2 = readJson(path.join(ctx.runs, "run-2", "写入清单.json"));
      const staging2 = snapshotTree(path.join(ctx.runs, "run-2", "staging"));

      // 场景3：staged 副本缺失 → 抛错回滚
      m.stageWrite({ runId: "run-3", workspace: ctx.ws, targetPath: path.join(ctx.ws, "交付", "丙.docx"), content: "丙", kind: "agent" });
      m.stageWrite({ runId: "run-3", workspace: ctx.ws, targetPath: path.join(ctx.ws, "交付", "丁.docx"), content: "丁", kind: "agent" });
      fs.rmSync(path.join(ctx.runs, "run-3", "staging", "交付", "丁.docx"), { force: true });
      const ev3: Array<[string, any]> = [];
      const rollback = (() => {
        try { m.publishStagedRun("run-3", ctx.ws, { onEvent: eventSink(ev3) }); return null; } catch (e: any) { return { message: e.message }; }
      })();
      const tree3 = snapshotTree(ctx.ws);
      return { published, tree1, stagedTempFileGone, backupLeft, manifest1, published2, manifest2, staging2, rollback, tree3, ev1, ev2, ev3 };
    });
    expect(r.published.map((f: any) => [f.path, f.status, f.size])).toEqual([
      ["交付/正式A.docx", "published", 7],
      ["交付/正式B.docx", "published", 7],
    ]);
    expect(r.tree1.slice().sort()).toEqual(["d/_data", "d/交付", "f/交付/正式A.docx", "f/交付/正式B.docx"].sort());
    expect(r.stagedTempFileGone).toBe(true);
    expect(r.backupLeft).toBe(false);
    expect(r.manifest1.files.map((f: any) => [f.path, f.status, f.publishedAt])).toEqual([
      ["交付/正式A.docx", "published", "2026-10-22T08:00:00.000Z"],
      ["交付/正式B.docx", "published", "2026-10-22T08:00:00.000Z"],
    ]);
    expect(r.published2.map((f: any) => f.path)).toEqual(["交付/乙.docx"]);
    expect(r.manifest2.files.map((f: any) => f.path)).toEqual(["交付/乙.docx"]);
    expect(r.staging2.slice().sort()).toEqual(["d/交付", "f/交付/乙.docx"].sort());
    expect(r.rollback).toEqual({ message: "临时产物不存在：交付/丁.docx" });
    expect(r.tree3.slice().sort()).toEqual(["d/_data", "d/交付", "f/交付/正式A.docx", "f/交付/正式B.docx", "f/交付/乙.docx"].sort());
    expect(r.ev1.map((e: [string, any]) => e[0])).toEqual(["artifact_materialized", "artifact_materialized"]);
    expect(r.ev2.map((e: [string, any]) => e[0])).toEqual(["artifact_materialized"]);
    // 场景3 的“丁暂存副本缺失”在待发布清单存在性校验阶段即抛出，未进入物化循环 → 无事件；
    // materialize 后备份恢复（回滚 backups 分支）无法经该场景触达，见提交「未做」段
    expect(r.ev3).toEqual([]);
  });

  it("discardStagedRun：清理 staging 与 manifest + write_cleaned 事件", async () => {
    useFakeDate();
    const r = await runWrite(async (m, ctx) => {
      m.stageWrite({ runId: "run-1", workspace: ctx.ws, targetPath: path.join(ctx.ws, "a.docx"), content: "A", kind: "agent" });
      m.stageWrite({ runId: "run-1", workspace: ctx.ws, targetPath: path.join(ctx.ws, "b.docx"), content: "B", kind: "agent" });
      const ev: Array<[string, any]> = [];
      const result = m.discardStagedRun("run-1", { onEvent: eventSink(ev), reason: "cancelled" });
      const stagingGone = fs.existsSync(path.join(ctx.runs, "run-1", "staging"));
      const manifestGone = fs.existsSync(path.join(ctx.runs, "run-1", "写入清单.json"));
      return { result, stagingGone, manifestGone, ev };
    });
    expect(r.result).toEqual({ ok: true, count: 2, reason: "cancelled" });
    expect(r.stagingGone).toBe(false);
    expect(r.manifestGone).toBe(false);
    expect(r.ev).toEqual([["write_cleaned", { runId: "run-1", count: 2, reason: "cancelled" }]]);
  });

  it("writeWorkspaceFile / withWriteLockAsync / writeCoordinatorInfo", async () => {
    useFakeDate();
    const r = await runWrite(async (m, ctx) => {
      const added = m.writeWorkspaceFile({ workspace: ctx.ws, targetPath: path.join(ctx.ws, "交付", "文档.docx"), content: "第一版" });
      const modified = m.writeWorkspaceFile({ workspace: ctx.ws, targetPath: path.join(ctx.ws, "交付", "文档.docx"), content: Buffer.from("第二版内容", "utf8") });
      const memoryRejected = (() => {
        try { m.writeWorkspaceFile({ workspace: ctx.ws, targetPath: path.join(ctx.ws, "agents.md"), content: "x" }); return null; } catch (e: any) { return { code: e.code, message: e.message }; }
      })();
      const asyncValue = await m.withWriteLockAsync({ workspace: ctx.ws, targetPath: path.join(ctx.ws, "交付", "文档.docx"), runId: "run-1" }, async () => "async-ok");
      const lockFreeAfter = m.acquireWriteLock({ workspace: ctx.ws, targetPath: path.join(ctx.ws, "交付", "文档.docx"), runId: "run-2" });
      m.releaseWriteLock(lockFreeAfter);
      const info = m.writeCoordinatorInfo();
      const content = fs.readFileSync(path.join(ctx.ws, "交付", "文档.docx"), "utf8");
      return { added, modified, memoryRejected, asyncValue, info, content };
    });
    expect(r.added).toMatchObject({ ok: true, path: "交付/文档.docx", status: "added", size: 9 });
    expect(r.modified).toMatchObject({ ok: true, status: "modified", size: 15 });
    expect(r.memoryRejected).toEqual({ code: "MEMORY_WRITE_REQUIRES_PROPOSAL", message: "长期记忆必须通过 memory_update 建议并经用户审核，不能使用普通文件写入工具" });
    expect(r.asyncValue).toBe("async-ok");
    expect(r.info.activeLocks).toBe(0);
    expect(r.content).toBe("第二版内容");
  });
});
