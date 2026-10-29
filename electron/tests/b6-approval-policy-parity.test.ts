/**
 * B6-1 行为覆盖：approval-policy / command-safety-policy / persistence-utils。
 *
 * R6-6b 对拍退役改写：旧侧 server/*.mjs 动态 import + runSide 双侧对拍随 server 退役删除，
 * 仅保留 TS 侧断言（期望值此前已经双侧对拍固化，现改为直接断言，矩阵期望值自 TS 源推导）。
 *
 * 基建设计：
 * - vi.mock("node:fs") 内存 FS：files/dirs 隔离真实磁盘，openSync 支持 "w"/"wx"/"a"，
 *   renameSync 对已存在目标抛 EEXIST 模拟 Windows（覆盖 replaceFile 备份分支）。
 * - vi.mock("node:crypto") 仅 override randomUUID 为同序计数器（approvalId / 临时文件名确定化）。
 * - fake timers 冻结 Date+setTimeout/clearTimeout（超时路径与 createdAt/updatedAt 确定化）。
 * - beforeEach vi.resetModules() + 动态 import，隔离模块级 pendingApprovals Map。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { PROJECT_DIR } from "../src/main/backend/workspace-paths";

type AnyMod = Record<string, any>;

const { store, state } = vi.hoisted(() => ({
  store: {
    files: new Map<string, string>(),
    dirs: new Set<string>(),
    fds: new Map<number, { path: string; mode: string }>(),
    nextFd: 16,
  },
  state: { uuidSeq: 0 },
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const key = (p: unknown) => path.resolve(String(p));
  const err = (code: string, message: string) => {
    const e = new Error(message) as NodeJS.ErrnoException;
    e.code = code;
    return e;
  };
  const mock = {
    ...actual,
    existsSync(p: unknown) { const k = key(p); return store.files.has(k) || store.dirs.has(k); },
    mkdirSync(p: unknown, _opts?: { recursive?: boolean }) {
      let d = key(p);
      for (;;) { store.dirs.add(d); const parent = path.dirname(d); if (parent === d) break; d = parent; }
      return key(p);
    },
    readFileSync(p: unknown, encoding?: unknown) {
      const k = key(p);
      if (!store.files.has(k)) throw err("ENOENT", `ENOENT: no such file or directory, open '${k}'`);
      const text = store.files.get(k) ?? "";
      return typeof encoding === "string" ? text : Buffer.from(text, "utf8");
    },
    writeFileSync(target: unknown, data: unknown, encoding?: unknown) {
      if (typeof target === "number") {
        const entry = store.fds.get(target);
        if (!entry) throw err("EBADF", "EBADF: bad file descriptor, write");
        const text = typeof data === "string" ? data : (data as Buffer).toString("utf8");
        const current = entry.mode === "a" ? (store.files.get(entry.path) ?? "") : "";
        store.files.set(entry.path, current + text);
        return;
      }
      const text = typeof data === "string" ? data : (data as Buffer).toString(typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8");
      store.files.set(key(target), text);
    },
    openSync(p: unknown, flags?: unknown) {
      const k = key(p);
      const f = String(flags ?? "r");
      if (f.startsWith("w")) {
        if (f.includes("x") && (store.files.has(k) || store.dirs.has(k))) throw err("EEXIST", `EEXIST: file already exists, open '${k}'`);
        store.files.set(k, "");
      } else if (f.startsWith("a")) {
        if (!store.files.has(k)) store.files.set(k, "");
      } else if (!store.files.has(k)) {
        throw err("ENOENT", `ENOENT: no such file or directory, open '${k}'`);
      }
      const fd = store.nextFd;
      store.nextFd += 1;
      store.fds.set(fd, { path: k, mode: f.slice(0, 1) });
      return fd;
    },
    fsyncSync(_fd: number) {},
    closeSync(fd: number) { store.fds.delete(fd); },
    // 模拟 Windows：rename 到已存在目标抛 EEXIST，驱动 replaceFile 走备份分支
    renameSync(from: unknown, to: unknown) {
      const f = key(from);
      const t = key(to);
      if (store.files.has(t) || store.dirs.has(t)) throw err("EEXIST", `EPERM: operation not permitted, rename '${f}' -> '${t}'`);
      if (!store.files.has(f)) throw err("ENOENT", `ENOENT: no such file or directory, rename '${f}' -> '${t}'`);
      store.files.set(t, store.files.get(f) ?? "");
      store.files.delete(f);
    },
    rmSync(p: unknown, _opts?: { force?: boolean }) { store.files.delete(key(p)); },
  };
  return { ...mock, default: mock } as unknown as typeof actual;
});

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  const mock = {
    ...actual,
    randomUUID: () => {
      state.uuidSeq += 1;
      return `uuid-${String(state.uuidSeq).padStart(4, "0")}`;
    },
  };
  return { ...mock, default: mock } as unknown as typeof actual;
});

const PERMS_FILE = path.join(PROJECT_DIR, ".oaw", "permissions.json");
const PENDING_FILE = path.join(PROJECT_DIR, ".oaw", "pending-approvals.json");

async function loadApprovalMods(): Promise<{ ap: AnyMod }> {
  vi.resetModules();
  return { ap: (await import("../src/main/backend/agent/approval-policy")) as unknown as AnyMod };
}

async function loadSafetyMods(): Promise<{ cs: AnyMod }> {
  vi.resetModules();
  return { cs: (await import("../src/main/backend/agent/command-safety-policy")) as unknown as AnyMod };
}

async function loadPersistenceMods(): Promise<{ pu: AnyMod }> {
  vi.resetModules();
  return { pu: (await import("../src/main/backend/persistence-utils")) as unknown as AnyMod };
}

function resetSideState(): void {
  store.files.clear();
  store.dirs.clear();
  store.fds.clear();
  state.uuidSeq = 0;
}

function readJson(file: string): unknown {
  const text = store.files.get(path.resolve(file));
  return text === undefined ? undefined : JSON.parse(text);
}

function writePending(items: unknown[]): void {
  store.files.set(path.resolve(PENDING_FILE), JSON.stringify(items));
}

async function rejectionOf(p: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await p;
    return { rejected: false };
  } catch (error) {
    const e = error as Error & { code?: string; action?: string };
    return { rejected: true, message: e.message, code: e.code, action: e.action };
  }
}

function makeEmit(): { events: Array<{ event: string; payload: Record<string, unknown> }>; emit: (event: string, payload: Record<string, unknown>) => void } {
  const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const emit = (event: string, payload: Record<string, unknown>) => { events.push({ event, payload }); };
  return { events, emit };
}

function requestEvents(events: Array<{ event: string; payload: Record<string, unknown> }>) {
  return events.filter((x) => x.event === "tool_approval_request");
}

beforeEach(() => {
  resetSideState();
  vi.useFakeTimers({ now: 1_700_000_000_000, toFake: ["Date", "setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("B6 approval-policy 行为覆盖", () => {
  it("A 常量与默认规则锚点", async () => {
    const { ap } = await loadApprovalMods();
    expect(ap.APPROVAL_ACTIONS).toEqual(["allow", "ask", "deny"]);
    const list = ap.listPermissionRules();
    expect(list.mode).toBe("ask");
    expect(list.defaults.length).toBeGreaterThan(20);
    // 默认规则首尾锚点：catch-all allow 在前、敏感 .env deny 在后（最后匹配生效的次序前提）
    expect(list.defaults[0]).toEqual({ tool: "*", pattern: "*", action: "allow" });
    expect(list.defaults[list.defaults.length - 1]).toEqual({ tool: "write", pattern: "*.env.*", action: "deny" });
    expect(list.user).toEqual([]);
  });

  it("B wildcardToRegExp 矩阵（* ? 大小写 i、null→*）", async () => {
    const { ap } = await loadApprovalMods();
    // 期望值自 wildcardToRegExp 实现推导：String(pattern||"") 转义后 * → .*、? → .，^...$ + i
    const cases: Array<[unknown, string, string, boolean]> = [
      ["set *", "set A1:B2", "^set .*$", true], ["set *", "setx", "^set .*$", false], ["set *", "SET A1", "^set .*$", true],
      ["rm *", "rm -rf x", "^rm .*$", true], ["rm *", "rm", "^rm .*$", false], ["rm *", " rm -x", "^rm .*$", false],
      ["*.env", ".env", "^.*\\.env$", true], ["*.env", "app.env", "^.*\\.env$", true], ["*.env", ".env.local", "^.*\\.env$", false], ["*.env", "env", "^.*\\.env$", false],
      ["*.env.*", "a.env.b", "^.*\\.env\\..*$", true], ["*.env.*", "a.env", "^.*\\.env\\..*$", false],
      // RegExp.prototype.source 按 ES 规范把 "/" 转义为 "\/"（EscapeRegExpPattern），期望值随之
      ["shared/*", "shared/roads", "^shared\\/.*$", true], ["shared/*", "SHARED/roads", "^shared\\/.*$", true], ["shared/*", "sharedx/roads", "^shared\\/.*$", false],
      ["workspace/*", "workspace/roads", "^workspace\\/.*$", true], ["workspace/*", "Workspace/roads", "^workspace\\/.*$", true],
      ["?", "a", "^.$", true], ["?", "", "^.$", false], ["?", "ab", "^.$", false], ["a?c", "abc", "^a.c$", true], ["a?c", "ac", "^a.c$", false], ["a?c", "a/c", "^a.c$", true],
      [null, "", "^$", true], [null, "anything", "^$", false], [undefined, "x", "^$", false], ["", "", "^$", true], ["", "x", "^$", false],
      ["a*b", "a-b", "^a.*b$", true], ["a*b", "ab", "^a.*b$", true], ["a*b", "axxb", "^a.*b$", true],
      ["remove-item *", "Remove-Item foo", "^remove-item .*$", true],
    ];
    for (const [pattern, input, source, expected] of cases) {
      const n = ap.wildcardToRegExp(pattern) as RegExp;
      expect([n.source, n.flags], JSON.stringify(pattern)).toEqual([source, "i"]);
      expect(n.test(input), JSON.stringify([pattern, input])).toBe(expected);
    }
  });

  it("C matchToolAction 默认规则矩阵", async () => {
    const { ap } = await loadApprovalMods();
    // 期望值自 DEFAULT_RULES 顺序匹配（最后匹配生效）+ mode ask 推导
    const cases: Array<[unknown, unknown, string]> = [
      ["bash", "echo hi", "allow"], ["bash", "rm -rf x", "ask"], ["Bash", "  rm -rf x  ", "ask"],
      ["bash", "del x", "ask"], ["bash", "RD /s x", "ask"], ["bash", "remove-item x", "ask"], ["bash", "format d", "ask"], ["bash", "rmdir x", "ask"],
      ["officecli", "set A1 100", "ask"], ["officecli", "get A1", "allow"], ["officecli", " create doc.docx", "ask"],
      ["editorial_pipeline", "anything", "ask"], ["editorial_pipeline", "", "ask"],
      ["map_edit", "workspace/roads", "allow"], ["map_edit", "shared/roads", "ask"], ["MAP_EDIT", "other/roads", "ask"],
      ["map_import", "shared/roads", "deny"], ["map_import", "workspace/roads", "ask"], ["map_save_analysis", "shared/roads", "deny"],
      ["write", ".env", "deny"], ["write", "src/.env", "deny"], ["write", "config.env.local", "deny"], ["write", "README.md", "allow"],
      ["mcp", "fetch", "ask"], ["mcp", "", "ask"], ["unknown_tool", "x", "allow"], [null, null, "allow"], ["", "", "allow"],
      ["bash", "rm", "allow"],
    ];
    for (const [tool, input, expected] of cases) {
      expect(ap.matchToolAction(tool, input), JSON.stringify([tool, input])).toBe(expected);
    }
  });

  it("D 用户规则与模式序列（返回值 + permissions.json 落盘）", async () => {
    const { ap } = await loadApprovalMods();
    const out: AnyMod = {};
    out.add1 = ap.addUserRule("bash", "rm -rf /tmp/secret", "allow");
    out.add2 = ap.addUserRule("WRITE", "*.env", "ask");
    out.addBad = ap.addUserRule("bash", "x", "maybe");
    const list1 = ap.listPermissionRules();
    out.matchUserAllow = ap.matchToolAction("bash", "rm -rf /tmp/secret");
    out.matchUserAsk = ap.matchToolAction("write", ".env.prod");
    out.modeAuto = ap.setApprovalMode("auto");
    out.matchAutoAsk = ap.matchToolAction("mcp", "fetch");
    out.matchAutoDeny = ap.matchToolAction("map_import", "shared/roads");
    out.getMode = ap.getApprovalMode();
    out.modeBack = ap.setApprovalMode("ask");
    out.modeDefault = ap.setApprovalMode();
    out.modeJunk = ap.setApprovalMode("weird");
    out.rm1 = ap.removeUserRule({ tool: "write", pattern: "*.env", action: "ask" });
    out.rm2 = ap.removeUserRule({ tool: "write", pattern: "*.env", action: "ask" });
    out.rm3 = ap.removeUserRule();
    out.rm4 = ap.removeUserRule({ tool: "bash", pattern: "x", action: "nope" });
    const list2 = ap.listPermissionRules();
    const bashRule = { tool: "bash", pattern: "rm -rf /tmp/secret", action: "allow" };
    const writeRule = { tool: "write", pattern: "*.env", action: "ask" };
    expect(out.add1).toEqual({ ok: true, rule: bashRule, rules: [bashRule] });
    expect(out.add2).toEqual({ ok: true, rule: writeRule, rules: [bashRule, writeRule] });
    expect(out.addBad).toEqual({ ok: false, error: "invalid action: maybe" });
    expect(list1.mode).toBe("ask");
    expect(list1.user).toEqual([bashRule, writeRule]);
    expect(out.matchUserAllow).toBe("allow"); // 用户 allow 规则精确匹配
    expect(out.matchUserAsk).toBe("deny"); // *.env.* deny 覆盖 catch-all
    expect(out.modeAuto).toEqual({ ok: true, mode: "auto" });
    expect(out.matchAutoAsk).toBe("allow"); // auto 只放行默认 ask
    expect(out.matchAutoDeny).toBe("deny"); // 显式 deny 不被 auto 绕过
    expect(out.getMode).toBe("auto");
    expect(out.modeBack).toEqual({ ok: true, mode: "ask" });
    expect(out.modeDefault).toEqual({ ok: true, mode: "ask" });
    expect(out.modeJunk).toEqual({ ok: true, mode: "ask" });
    expect(out.rm1).toEqual({ ok: true, rules: [bashRule] });
    expect(out.rm2).toEqual({ ok: false, error: "rule not found" });
    expect(out.rm3).toEqual({ ok: false, error: "invalid rule" });
    expect(out.rm4).toEqual({ ok: false, error: "invalid rule" });
    expect(list2.mode).toBe("ask");
    expect(list2.user).toEqual([bashRule]);
    const perms = readJson(PERMS_FILE) as { rules: unknown[]; mode: string; updatedAt: string };
    expect(perms.rules).toEqual([bashRule]);
    expect(perms.mode).toBe("ask");
    expect(perms.updatedAt).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it("E1 allow 快路径不落盘、deny 拒绝形状", async () => {
    const { ap } = await loadApprovalMods();
    await ap.requireToolApproval({ tool: "read", input: "x" });
    expect(readJson(PENDING_FILE)).toBeUndefined();
    const deny = await rejectionOf(ap.requireToolApproval({ tool: "map_import", input: "shared/roads" }) as Promise<unknown>);
    expect(deny).toMatchObject({ rejected: true, code: "APPROVAL_DENIED", action: "deny" });
    expect(String(deny.message)).toContain("工具调用被权限策略拒绝（map_import）：shared/roads");
  });

  it("E2 ask 全流程：载荷逐字 / pending 持久化 / allow+deny 决议 / owner 门控", async () => {
    const { ap } = await loadApprovalMods();
    const { events, emit } = makeEmit();
    const entry = { activeRunId: "run-entry", threadId: "thread-entry", clientId: "client-1", workspace: "ws-entry" };
    const p1 = ap.requireToolApproval({ tool: "officecli", input: "set A1 100", runId: "run-1", threadId: "thread-1", workspace: "ws-1", entry, emit, owner: { kind: "turn", id: "turn-1" } }) as Promise<unknown>;
    const req1 = requestEvents(events)[0];
    // randomUUID mock 计数器 → approvalId 确定化：uuid-0001 → approval_uuid0001
    expect(req1?.payload).toEqual({
      id: "approval_uuid0001", tool: "officecli", input: "set A1 100", runId: "run-1", threadId: "thread-1", workspace: "ws-1", action: "ask", owner: { kind: "turn", id: "turn-1" },
    });
    const res1 = ap.resolveToolApproval(req1?.payload.id, "allow");
    expect(res1).toEqual({ ok: true, id: "approval_uuid0001", decision: "allow", always: false });
    await p1;
    const p2 = ap.requireToolApproval({ tool: "officecli", input: "batch format docs", entry, emit, owner: { kind: "bogus", id: "x" } }) as Promise<unknown>;
    const req2 = requestEvents(events)[1];
    expect(req2?.payload).toMatchObject({ id: "approval_uuid0005", input: "batch format docs", runId: "run-entry", threadId: "thread-entry" });
    expect("owner" in (req2?.payload as Record<string, unknown>)).toBe(false); // 非法归属不进载荷
    const deny2 = await rejectionOf((async () => {
      ap.resolveToolApproval(req2?.payload.id, "deny");
      await p2;
    })());
    expect(deny2).toMatchObject({ rejected: true, code: "APPROVAL_DENIED", action: "deny" });
    expect(String(deny2.message)).toContain("工具调用被用户拒绝（officecli）");
    const p3 = ap.requireToolApproval({ tool: "officecli", input: "add row", entry, emit }) as Promise<unknown>;
    const req3 = requestEvents(events)[2];
    expect(req3?.payload).toMatchObject({ id: "approval_uuid0010", input: "add row", runId: "run-entry", threadId: "thread-entry" });
    ap.resolveToolApproval(req3?.payload.id, "allow");
    await p3;
    const pending = readJson(PENDING_FILE) as Array<Record<string, unknown>>;
    expect(pending).toHaveLength(3);
    expect(pending.map((x) => `${x.status}:${x.decision}`)).toEqual(["approved:allow", "rejected:deny", "approved:allow"]);
    expect(pending[0]).toMatchObject({ id: "approval_uuid0001", tool: "officecli", input: "set A1 100", runId: "run-1", threadId: "thread-1", clientId: "client-1", status: "approved", decision: "allow" });
  });

  it("E3 always → addUserRule 首词通配生效，二次同前缀不再询问", async () => {
    const { ap } = await loadApprovalMods();
    const { events, emit } = makeEmit();
    const p1 = ap.requireToolApproval({ tool: "officecli", input: "set A1 100", emit }) as Promise<unknown>;
    const id1 = requestEvents(events)[0]?.payload.id;
    const res1 = ap.resolveToolApproval(id1, "always");
    expect(res1).toMatchObject({ ok: true, decision: "allow", always: true });
    await p1;
    const p2 = ap.requireToolApproval({ tool: "officecli", input: "set B2 200", emit }) as Promise<unknown>;
    await p2;
    expect(requestEvents(events)).toHaveLength(1); // 二次同前缀不再询问
    expect(ap.listPermissionRules().user).toEqual([{ tool: "officecli", pattern: "set *", action: "allow" }]);
    const perms = readJson(PERMS_FILE) as { rules: Array<Record<string, unknown>> };
    expect(perms.rules).toEqual([{ tool: "officecli", pattern: "set *", action: "allow" }]);
  });

  it("E4 未知 id 与重启恢复分支", async () => {
    const { ap } = await loadApprovalMods();
    expect(ap.resolveToolApproval("no-such-id", "allow")).toEqual({ ok: false, error: "approval not found or already resolved" });
    expect(ap.resolveToolApproval("")).toEqual({ ok: false, error: "approval not found or already resolved" });
    writePending([
      { id: "approval_recovered", tool: "officecli", input: "create doc.docx", runId: null, threadId: null, clientId: null, status: "pending", createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(ap.resolveToolApproval("approval_recovered", "deny")).toEqual({ ok: true, recovered: true, id: "approval_recovered", decision: "deny" });
    expect(readJson(PENDING_FILE)).toEqual([
      { id: "approval_recovered", tool: "officecli", input: "create doc.docx", runId: null, threadId: null, clientId: null, status: "rejected", createdAt: "2026-01-01T00:00:00.000Z", decision: "deny", resolvedAt: new Date(1_700_000_000_000).toISOString() },
    ]);
  });

  it("E5 超时拒绝 APPROVAL_TIMEOUT + 持久化 expired", async () => {
    const { ap } = await loadApprovalMods();
    const { events, emit } = makeEmit();
    const p = ap.requireToolApproval({ tool: "officecli", input: "save doc.docx", emit }) as Promise<unknown>;
    vi.advanceTimersByTime(300_000);
    const err = await rejectionOf(p);
    expect(err).toMatchObject({ rejected: true, code: "APPROVAL_TIMEOUT" });
    expect(String(err.message)).toContain("超过 5 分钟未获批准");
    expect(requestEvents(events)).toHaveLength(1);
    expect(events.filter((x) => x.event === "tool_approval_resolved")).toHaveLength(0);
    const pending = readJson(PENDING_FILE) as Array<Record<string, unknown>>;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ status: "expired", decision: "expired" });
  });

  it("F normalizeOwner 表", async () => {
    const { ap } = await loadApprovalMods();
    // 期望值自实现推导：id 空 trim → null；kind 不在 turn/subagent/session → null
    const cases: Array<[unknown, unknown]> = [
      [{ kind: "turn", id: "t1" }, { kind: "turn", id: "t1" }],
      [{ kind: "subagent", id: "  s2  " }, { kind: "subagent", id: "s2" }],
      [{ kind: "session", id: 123 }, { kind: "session", id: "123" }],
      [{ kind: "bogus", id: "x" }, null],
      [{ kind: "turn", id: "" }, null],
      [{ kind: "turn", id: "   " }, null],
      [{ kind: "turn" }, null],
      [{ id: "x" }, null],
      [{}, null],
      [null, null],
      [undefined, null],
      ["turn", null],
      [42, null],
    ];
    for (const [input, expected] of cases) {
      expect(ap.normalizeOwner(input), JSON.stringify(input)).toEqual(expected);
    }
  });

  it("G listPendingApprovals 只留 pending", async () => {
    const { ap } = await loadApprovalMods();
    writePending([
      { id: "a", status: "pending" },
      { id: "b", status: "approved" },
      { id: "c", status: "expired" },
      { id: "d" },
    ]);
    expect(ap.listPendingApprovals()).toEqual([{ id: "a", status: "pending" }]);
  });

  it("H command-safety-policy 行为覆盖", async () => {
    const { cs } = await loadSafetyMods();
    // 期望值自 GLOBAL_SEARCH_PATTERN（\b(?:find|rg|grep|ls|du|tree)\s+(?:-[^\s]+\s+)*\/(?:\s|$)，i）推导；
    // 注意无 ^ 锚定："echo find /" 中 find 子串命中
    const cmds: Array<[unknown, boolean]> = [
      ["find / -name x", true], ["rg / foo", true], ["grep -r pattern /", false], ["ls /", true], ["du -sh /", true], ["tree /", true],
      ["find  /", true], ["grep -E -i pat /", false], ["find ./ -name x", false], ["rg pattern .", false], ["grep pat /data/x", false],
      ["ls -la", false], ["ls/", false], ["echo find /", true], ["findx /", false], ["find", false], ["", false], [null, false], [undefined, false], [123, false],
      ["tree C:/", false], ["ls /x/y", false], ["find /x -name y", false],
    ];
    for (const [c, expected] of cmds) {
      expect(cs.isGlobalSearchCommand(c), JSON.stringify(c)).toBe(expected);
    }
    // 期望值自实现推导：timeout > 0 且有限 → min(timeout, 600)，否则 120；spread 保留其余字段
    const optCases: Array<[Record<string, unknown> | undefined, Record<string, unknown>]> = [
      [undefined, { timeout: 120 }], [{}, { timeout: 120 }], [{ timeout: 300 }, { timeout: 300 }], [{ timeout: 9999 }, { timeout: 600 }],
      [{ timeout: 0 }, { timeout: 120 }], [{ timeout: -5 }, { timeout: 120 }], [{ timeout: "abc" }, { timeout: 120 }],
      [{ timeout: "90" }, { timeout: 90 }], [{ cwd: "/x", timeout: 45 }, { cwd: "/x", timeout: 45 }], [{ timeout: 600 }, { timeout: 600 }],
    ];
    for (const [oc, expected] of optCases) {
      expect(cs.normalizeBashOptions(oc === undefined ? undefined : { ...oc })).toEqual(expected);
    }
    expect(cs.bashTimeoutPolicy).toEqual({ defaultSeconds: 120, maxSeconds: 600 });
    expect(Object.isFrozen(cs.bashTimeoutPolicy)).toBe(true);
  });

  it("I persistence-utils 直测", async () => {
    const { pu } = await loadPersistenceMods();
    const dir = path.join(PROJECT_DIR, ".oaw", "pu-parity");
    expect(pu.ensureDirectory(dir)).toBe(dir);
    const aFile = path.join(dir, "a.json");
    pu.atomicWriteJson(aFile, { v: 1, list: [1, 2] });
    pu.atomicWriteJson(aFile, { v: 2 }); // 二次覆盖走 replaceFile 备份分支
    expect(pu.readJsonFile(aFile, null)).toEqual({ v: 2 });
    expect(pu.readJsonFile(path.join(dir, "missing.json"), { fb: true })).toEqual({ fb: true });
    const logFile = path.join(dir, "log.jsonl");
    pu.appendJsonLine(logFile, { n: 1 });
    pu.appendJsonLine(logFile, { n: 2 });
    expect(store.files.get(path.resolve(aFile))).toBe(JSON.stringify({ v: 2 }, null, 2) + "\n");
    expect(store.files.get(path.resolve(logFile))).toBe(JSON.stringify({ n: 1 }) + "\n" + JSON.stringify({ n: 2 }) + "\n");
  });
});
