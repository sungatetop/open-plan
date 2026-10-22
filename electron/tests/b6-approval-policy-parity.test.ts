import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { PROJECT_DIR } from "../src/main/backend/workspace-paths";

// B6-1 对拍：旧 server JS ↔ 新 electron TS（approval-policy / command-safety-policy / persistence-utils）。
//
// 基建设计（双侧同流）：
// - vi.mock("node:fs") 内存 FS：files/dirs 按 side（old/new）双份隔离，openSync 支持 "w"/"wx"/"a"，
//   renameSync 对已存在目标抛 EEXIST 模拟 Windows（覆盖 replaceFile 备份分支）；旧侧硬编码真实路径
//   只成 mock 键，不污染真实 .oaw。
// - vi.mock("node:crypto") 仅 override randomUUID 为同序计数器；runSide 每侧归零，两侧操作序一致
//   → approvalId / 临时文件名成对相等，持久化内容可直接 deep-equal。
// - fake timers 冻结 Date+setTimeout/clearTimeout；runSide 每侧重置系统时间，createdAt/updatedAt 对齐。
// - beforeEach vi.resetModules() + 动态 import，隔离模块级 pendingApprovals Map。

type AnyMod = Record<string, any>; // 对拍两侧统一宽松句柄：旧侧为 JS 推断，新侧刻意取 any 以便传任意输入

const { store, state } = vi.hoisted(() => {
  const mkSide = () => ({ files: new Map<string, string>(), dirs: new Set<string>() });
  return {
    store: {
      sides: { old: mkSide(), new: mkSide() },
      active: "old" as "old" | "new",
      fds: new Map<number, { path: string; mode: string }>(),
      nextFd: 16,
    },
    state: { uuidSeq: 0 },
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const cur = () => store.sides[store.active];
  const key = (p: unknown) => path.resolve(String(p));
  const err = (code: string, message: string) => {
    const e = new Error(message) as NodeJS.ErrnoException;
    e.code = code;
    return e;
  };
  const mock = {
    ...actual,
    existsSync(p: unknown) { const k = key(p); return cur().files.has(k) || cur().dirs.has(k); },
    mkdirSync(p: unknown, _opts?: { recursive?: boolean }) {
      let d = key(p);
      for (;;) { cur().dirs.add(d); const parent = path.dirname(d); if (parent === d) break; d = parent; }
      return key(p);
    },
    readFileSync(p: unknown, encoding?: unknown) {
      const k = key(p);
      if (!cur().files.has(k)) throw err("ENOENT", `ENOENT: no such file or directory, open '${k}'`);
      const text = cur().files.get(k) ?? "";
      return typeof encoding === "string" ? text : Buffer.from(text, "utf8");
    },
    writeFileSync(target: unknown, data: unknown, encoding?: unknown) {
      if (typeof target === "number") {
        const entry = store.fds.get(target);
        if (!entry) throw err("EBADF", "EBADF: bad file descriptor, write");
        const text = typeof data === "string" ? data : (data as Buffer).toString("utf8");
        const current = entry.mode === "a" ? (cur().files.get(entry.path) ?? "") : "";
        cur().files.set(entry.path, current + text);
        return;
      }
      const text = typeof data === "string" ? data : (data as Buffer).toString(typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8");
      cur().files.set(key(target), text);
    },
    openSync(p: unknown, flags?: unknown) {
      const k = key(p);
      const f = String(flags ?? "r");
      if (f.startsWith("w")) {
        if (f.includes("x") && (cur().files.has(k) || cur().dirs.has(k))) throw err("EEXIST", `EEXIST: file already exists, open '${k}'`);
        cur().files.set(k, "");
      } else if (f.startsWith("a")) {
        if (!cur().files.has(k)) cur().files.set(k, "");
      } else if (!cur().files.has(k)) {
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
      if (cur().files.has(t) || cur().dirs.has(t)) throw err("EEXIST", `EPERM: operation not permitted, rename '${f}' -> '${t}'`);
      if (!cur().files.has(f)) throw err("ENOENT", `ENOENT: no such file or directory, rename '${f}' -> '${t}'`);
      cur().files.set(t, cur().files.get(f) ?? "");
      cur().files.delete(f);
    },
    rmSync(p: unknown, _opts?: { force?: boolean }) { cur().files.delete(key(p)); },
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

async function loadApprovalMods(): Promise<{ oldAp: AnyMod; newAp: AnyMod }> {
  vi.resetModules();
  const oldAp = (await import("../../server/approval-policy.mjs")) as unknown as AnyMod;
  const newAp = (await import("../src/main/backend/agent/approval-policy")) as unknown as AnyMod;
  return { oldAp, newAp };
}

async function loadSafetyMods(): Promise<{ oldCs: AnyMod; newCs: AnyMod }> {
  vi.resetModules();
  const oldCs = (await import("../../server/command-safety-policy.mjs")) as unknown as AnyMod;
  const newCs = (await import("../src/main/backend/agent/command-safety-policy")) as unknown as AnyMod;
  return { oldCs, newCs };
}

async function loadPersistenceMods(): Promise<{ oldPu: AnyMod; newPu: AnyMod }> {
  vi.resetModules();
  const oldPu = (await import("../../server/persistence-utils.mjs")) as unknown as AnyMod;
  const newPu = (await import("../src/main/backend/persistence-utils")) as unknown as AnyMod;
  return { oldPu, newPu };
}

function resetSideState(): void {
  for (const side of ["old", "new"] as const) {
    store.sides[side].files.clear();
    store.sides[side].dirs.clear();
  }
  store.fds.clear();
  state.uuidSeq = 0;
}

/** 切到指定侧、归零 uuid 计数与系统时间后执行该侧操作序列。 */
function runSide<T>(side: "old" | "new", fn: () => T): T {
  store.active = side;
  state.uuidSeq = 0;
  vi.setSystemTime(1_700_000_000_000);
  return fn();
}

function readJsonAt(side: "old" | "new", file: string): unknown {
  const text = store.sides[side].files.get(path.resolve(file));
  return text === undefined ? undefined : JSON.parse(text);
}

function writePendingAt(side: "old" | "new", items: unknown[]): void {
  store.sides[side].files.set(path.resolve(PENDING_FILE), JSON.stringify(items));
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

describe("B6 approval-policy 对拍（旧 JS ↔ 新 TS）", () => {
  it("A 常量与默认规则一致", async () => {
    const { oldAp, newAp } = await loadApprovalMods();
    expect([...newAp.APPROVAL_ACTIONS]).toEqual([...oldAp.APPROVAL_ACTIONS]);
    expect(newAp.APPROVAL_ACTIONS).toEqual(["allow", "ask", "deny"]);
    const oldList = oldAp.listPermissionRules();
    const newList = newAp.listPermissionRules();
    expect(newList).toEqual(oldList);
    expect(newList.mode).toBe("ask");
    expect(newList.defaults.length).toBeGreaterThan(20);
  });

  it("B wildcardToRegExp 矩阵（* ? 大小写 i、null→*）", async () => {
    const { oldAp, newAp } = await loadApprovalMods();
    const cases: Array<[unknown, string]> = [
      ["set *", "set A1:B2"], ["set *", "setx"], ["set *", "SET A1"],
      ["rm *", "rm -rf x"], ["rm *", "rm"], ["rm *", " rm -x"],
      ["*.env", ".env"], ["*.env", "app.env"], ["*.env", ".env.local"], ["*.env", "env"],
      ["*.env.*", "a.env.b"], ["*.env.*", "a.env"],
      ["shared/*", "shared/roads"], ["shared/*", "SHARED/roads"], ["shared/*", "sharedx/roads"],
      ["workspace/*", "workspace/roads"], ["workspace/*", "Workspace/roads"],
      ["?", "a"], ["?", ""], ["?", "ab"], ["a?c", "abc"], ["a?c", "ac"], ["a?c", "a/c"],
      [null, ""], [null, "anything"], [undefined, "x"], ["", ""], ["", "x"],
      ["a*b", "a-b"], ["a*b", "ab"], ["a*b", "axxb"],
      ["remove-item *", "Remove-Item foo"],
    ];
    for (const [pattern, input] of cases) {
      const o = oldAp.wildcardToRegExp(pattern) as RegExp;
      const n = newAp.wildcardToRegExp(pattern) as RegExp;
      expect([n.source, n.flags, n.test(input)]).toEqual([o.source, o.flags, o.test(input)]);
    }
  });

  it("C matchToolAction 默认规则矩阵", async () => {
    const { oldAp, newAp } = await loadApprovalMods();
    const cases: Array<[unknown, unknown]> = [
      ["bash", "echo hi"], ["bash", "rm -rf x"], ["Bash", "  rm -rf x  "],
      ["bash", "del x"], ["bash", "RD /s x"], ["bash", "remove-item x"], ["bash", "format d"], ["bash", "rmdir x"],
      ["officecli", "set A1 100"], ["officecli", "get A1"], ["officecli", " create doc.docx"],
      ["editorial_pipeline", "anything"], ["editorial_pipeline", ""],
      ["map_edit", "workspace/roads"], ["map_edit", "shared/roads"], ["MAP_EDIT", "other/roads"],
      ["map_import", "shared/roads"], ["map_import", "workspace/roads"], ["map_save_analysis", "shared/roads"],
      ["write", ".env"], ["write", "src/.env"], ["write", "config.env.local"], ["write", "README.md"],
      ["mcp", "fetch"], ["mcp", ""], ["unknown_tool", "x"], [null, null], ["", ""],
      ["bash", "rm"],
    ];
    for (const [tool, input] of cases) {
      const o = oldAp.matchToolAction(tool, input) as string;
      const n = newAp.matchToolAction(tool, input) as string;
      expect(n).toEqual(o);
    }
  });

  it("D 用户规则与模式序列（返回值 + permissions.json 落盘逐字节）", async () => {
    const { oldAp, newAp } = await loadApprovalMods();
    async function sequence(mod: AnyMod): Promise<AnyMod> {
      const out: AnyMod = {};
      out.add1 = mod.addUserRule("bash", "rm -rf /tmp/secret", "allow");
      out.add2 = mod.addUserRule("WRITE", "*.env", "ask");
      out.addBad = mod.addUserRule("bash", "x", "maybe");
      out.list1 = mod.listPermissionRules();
      out.matchUserAllow = mod.matchToolAction("bash", "rm -rf /tmp/secret");
      out.matchUserAsk = mod.matchToolAction("write", ".env.prod");
      out.modeAuto = mod.setApprovalMode("auto");
      out.matchAutoAsk = mod.matchToolAction("mcp", "fetch");
      out.matchAutoDeny = mod.matchToolAction("map_import", "shared/roads");
      out.getMode = mod.getApprovalMode();
      out.modeBack = mod.setApprovalMode("ask");
      out.modeDefault = mod.setApprovalMode();
      out.modeJunk = mod.setApprovalMode("weird");
      out.rm1 = mod.removeUserRule({ tool: "write", pattern: "*.env", action: "ask" });
      out.rm2 = mod.removeUserRule({ tool: "write", pattern: "*.env", action: "ask" });
      out.rm3 = mod.removeUserRule();
      out.rm4 = mod.removeUserRule({ tool: "bash", pattern: "x", action: "nope" });
      out.list2 = mod.listPermissionRules();
      return out;
    }
    const oldOut = await runSide("old", () => sequence(oldAp));
    const newOut = await runSide("new", () => sequence(newAp));
    expect(newOut).toEqual(oldOut);
    expect(readJsonAt("old", PERMS_FILE)).toEqual(readJsonAt("new", PERMS_FILE));
    const perms = readJsonAt("old", PERMS_FILE) as { rules: unknown[]; mode: string; updatedAt: string };
    expect(perms.rules).toHaveLength(1);
    expect(perms.mode).toBe("ask");
    expect(perms.updatedAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(oldOut.matchAutoDeny).toBe("deny");
    expect(oldOut.matchAutoAsk).toBe("allow");
  });

  it("E1 allow 快路径不落盘、deny 拒绝形状", async () => {
    const { oldAp, newAp } = await loadApprovalMods();
    const oAllow = await runSide("old", async () => {
      await oldAp.requireToolApproval({ tool: "read", input: "x" });
      return readJsonAt("old", PENDING_FILE);
    });
    const nAllow = await runSide("new", async () => {
      await newAp.requireToolApproval({ tool: "read", input: "x" });
      return readJsonAt("new", PENDING_FILE);
    });
    expect(oAllow).toBeUndefined();
    expect(nAllow).toEqual(oAllow);
    async function denyFlow(mod: AnyMod): Promise<Record<string, unknown>> {
      return rejectionOf(mod.requireToolApproval({ tool: "map_import", input: "shared/roads" }) as Promise<unknown>);
    }
    const oDeny = await runSide("old", () => denyFlow(oldAp));
    const nDeny = await runSide("new", () => denyFlow(newAp));
    expect(nDeny).toEqual(oDeny);
    expect(oDeny).toMatchObject({ rejected: true, code: "APPROVAL_DENIED", action: "deny" });
    expect(String(oDeny.message)).toContain("工具调用被权限策略拒绝（map_import）：shared/roads");
  });

  it("E2 ask 全流程：载荷逐字 / pending 持久化 / allow+deny 决议 / owner 门控", async () => {
    const { oldAp, newAp } = await loadApprovalMods();
    async function askFlow(mod: AnyMod): Promise<AnyMod> {
      const { events, emit } = makeEmit();
      const out: AnyMod = { events };
      const entry = { activeRunId: "run-entry", threadId: "thread-entry", clientId: "client-1", workspace: "ws-entry" };
      const p1 = mod.requireToolApproval({ tool: "officecli", input: "set A1 100", runId: "run-1", threadId: "thread-1", workspace: "ws-1", entry, emit, owner: { kind: "turn", id: "turn-1" } }) as Promise<unknown>;
      const req1 = requestEvents(events)[0];
      out.req1 = req1;
      out.res1 = mod.resolveToolApproval(req1?.payload.id, "allow");
      await p1;
      const p2 = mod.requireToolApproval({ tool: "officecli", input: "batch format docs", entry, emit, owner: { kind: "bogus", id: "x" } }) as Promise<unknown>;
      const req2 = requestEvents(events)[1];
      out.req2 = req2;
      out.deny2 = await rejectionOf((async () => {
        mod.resolveToolApproval(req2?.payload.id, "deny");
        await p2;
      })());
      const p3 = mod.requireToolApproval({ tool: "officecli", input: "add row", entry, emit }) as Promise<unknown>;
      const req3 = requestEvents(events)[2];
      out.req3 = req3;
      mod.resolveToolApproval(req3?.payload.id, "allow");
      await p3;
      out.pending = readJsonAt(store.active, PENDING_FILE);
      return out;
    }
    const oldOut = await runSide("old", () => askFlow(oldAp));
    const newOut = await runSide("new", () => askFlow(newAp));
    expect(newOut).toEqual(oldOut);
    expect(oldOut.req1.payload).toMatchObject({ tool: "officecli", input: "set A1 100", runId: "run-1", threadId: "thread-1", workspace: "ws-1", action: "ask", owner: { kind: "turn", id: "turn-1" } });
    expect("owner" in (oldOut.req2.payload as Record<string, unknown>)).toBe(false);
    expect("owner" in (oldOut.req3.payload as Record<string, unknown>)).toBe(false);
    expect(oldOut.deny2).toMatchObject({ code: "APPROVAL_DENIED", action: "deny" });
    expect(String(oldOut.deny2.message)).toContain("工具调用被用户拒绝（officecli）");
    const pending = oldOut.pending as Array<Record<string, unknown>>;
    expect(pending).toHaveLength(3);
    expect(pending.map((x) => `${x.status}:${x.decision}`)).toEqual(["approved:allow", "rejected:deny", "approved:allow"]);
    expect(pending[0]).toMatchObject({ tool: "officecli", input: "set A1 100", runId: "run-1", threadId: "thread-1", clientId: "client-1" });
  });

  it("E3 always → addUserRule 首词通配生效，二次同前缀不再询问", async () => {
    const { oldAp, newAp } = await loadApprovalMods();
    async function alwaysFlow(mod: AnyMod): Promise<AnyMod> {
      const { events, emit } = makeEmit();
      const out: AnyMod = { events };
      const p1 = mod.requireToolApproval({ tool: "officecli", input: "set A1 100", emit }) as Promise<unknown>;
      const id1 = requestEvents(events)[0]?.payload.id;
      out.res1 = mod.resolveToolApproval(id1, "always");
      await p1;
      const p2 = mod.requireToolApproval({ tool: "officecli", input: "set B2 200", emit }) as Promise<unknown>;
      await p2;
      out.requests = requestEvents(events).length;
      out.rules = mod.listPermissionRules();
      out.perms = readJsonAt(store.active, PERMS_FILE);
      return out;
    }
    const oldOut = await runSide("old", () => alwaysFlow(oldAp));
    const newOut = await runSide("new", () => alwaysFlow(newAp));
    expect(newOut).toEqual(oldOut);
    expect(oldOut.res1).toMatchObject({ ok: true, decision: "allow", always: true });
    expect(oldOut.requests).toBe(1);
    expect(oldOut.rules.user).toEqual([{ tool: "officecli", pattern: "set *", action: "allow" }]);
  });

  it("E4 未知 id 与重启恢复分支", async () => {
    const { oldAp, newAp } = await loadApprovalMods();
    async function recoverFlow(mod: AnyMod): Promise<AnyMod> {
      const out: AnyMod = {};
      out.unknown = mod.resolveToolApproval("no-such-id", "allow");
      out.unknownDefault = mod.resolveToolApproval("");
      writePendingAt(store.active, [
        { id: "approval_recovered", tool: "officecli", input: "create doc.docx", runId: null, threadId: null, clientId: null, status: "pending", createdAt: "2026-01-01T00:00:00.000Z" },
      ]);
      out.recoveredDeny = mod.resolveToolApproval("approval_recovered", "deny");
      out.pendingAfter = readJsonAt(store.active, PENDING_FILE);
      return out;
    }
    const oldOut = await runSide("old", () => recoverFlow(oldAp));
    const newOut = await runSide("new", () => recoverFlow(newAp));
    expect(newOut).toEqual(oldOut);
    expect(oldOut.unknown).toEqual({ ok: false, error: "approval not found or already resolved" });
    expect(oldOut.recoveredDeny).toEqual({ ok: true, recovered: true, id: "approval_recovered", decision: "deny" });
    expect(oldOut.pendingAfter).toEqual([
      { id: "approval_recovered", tool: "officecli", input: "create doc.docx", runId: null, threadId: null, clientId: null, status: "rejected", createdAt: "2026-01-01T00:00:00.000Z", decision: "deny", resolvedAt: new Date(1_700_000_000_000).toISOString() },
    ]);
  });

  it("E5 超时拒绝 APPROVAL_TIMEOUT + 持久化 expired", async () => {
    const { oldAp, newAp } = await loadApprovalMods();
    async function timeoutFlow(mod: AnyMod): Promise<AnyMod> {
      const { events, emit } = makeEmit();
      const out: AnyMod = { events };
      const p = mod.requireToolApproval({ tool: "officecli", input: "save doc.docx", emit }) as Promise<unknown>;
      vi.advanceTimersByTime(300_000);
      out.err = await rejectionOf(p);
      out.requests = requestEvents(events).length;
      out.resolveds = events.filter((x) => x.event === "tool_approval_resolved").length;
      out.pending = readJsonAt(store.active, PENDING_FILE);
      return out;
    }
    const oldOut = await runSide("old", () => timeoutFlow(oldAp));
    const newOut = await runSide("new", () => timeoutFlow(newAp));
    expect(newOut).toEqual(oldOut);
    expect(oldOut.err).toMatchObject({ rejected: true, code: "APPROVAL_TIMEOUT" });
    expect(String(oldOut.err.message)).toContain("超过 5 分钟未获批准");
    expect(oldOut.requests).toBe(1);
    expect(oldOut.resolveds).toBe(0);
    expect(oldOut.pending).toHaveLength(1);
    expect((oldOut.pending as Array<Record<string, unknown>>)[0]).toMatchObject({ status: "expired", decision: "expired" });
  });

  it("F normalizeOwner 表", async () => {
    const { oldAp, newAp } = await loadApprovalMods();
    const cases: unknown[] = [
      { kind: "turn", id: "t1" },
      { kind: "subagent", id: "  s2  " },
      { kind: "session", id: 123 },
      { kind: "bogus", id: "x" },
      { kind: "turn", id: "" },
      { kind: "turn", id: "   " },
      { kind: "turn" },
      { id: "x" },
      {},
      null,
      undefined,
      "turn",
      42,
    ];
    for (const c of cases) {
      expect([JSON.stringify(c), newAp.normalizeOwner(c)]).toEqual([JSON.stringify(c), oldAp.normalizeOwner(c)]);
    }
    expect(newAp.normalizeOwner({ kind: "subagent", id: "  s2  " })).toEqual({ kind: "subagent", id: "s2" });
    expect(newAp.normalizeOwner({ kind: "session", id: 123 })).toEqual({ kind: "session", id: "123" });
  });

  it("G listPendingApprovals 只留 pending", async () => {
    const { oldAp, newAp } = await loadApprovalMods();
    async function listFlow(mod: AnyMod): Promise<unknown> {
      writePendingAt(store.active, [
        { id: "a", status: "pending" },
        { id: "b", status: "approved" },
        { id: "c", status: "expired" },
        { id: "d" },
      ]);
      return mod.listPendingApprovals();
    }
    const oldOut = await runSide("old", () => listFlow(oldAp));
    const newOut = await runSide("new", () => listFlow(newAp));
    expect(newOut).toEqual(oldOut);
    expect(oldOut).toEqual([{ id: "a", status: "pending" }]);
  });

  it("H command-safety-policy 对拍", async () => {
    const { oldCs, newCs } = await loadSafetyMods();
    const cmds: unknown[] = [
      "find / -name x", "rg / foo", "grep -r pattern /", "ls /", "du -sh /", "tree /",
      "find  /", "grep -E -i pat /", "find ./ -name x", "rg pattern .", "grep pat /data/x",
      "ls -la", "ls/", "echo find /", "findx /", "find", "", null, undefined, 123,
      "tree C:/", "ls /x/y", "find /x -name y",
    ];
    for (const c of cmds) {
      expect(newCs.isGlobalSearchCommand(c)).toBe(oldCs.isGlobalSearchCommand(c));
    }
    expect(oldCs.isGlobalSearchCommand("find / -name x")).toBe(true);
    expect(oldCs.isGlobalSearchCommand("find ./ -name x")).toBe(false);
    const optCases: Array<Record<string, unknown> | undefined> = [
      undefined, {}, { timeout: 300 }, { timeout: 9999 }, { timeout: 0 }, { timeout: -5 },
      { timeout: "abc" }, { timeout: "90" }, { cwd: "/x", timeout: 45 }, { timeout: 600 },
    ];
    for (const oc of optCases) {
      const o = oldCs.normalizeBashOptions(oc === undefined ? undefined : { ...oc }) as Record<string, unknown>;
      const n = newCs.normalizeBashOptions(oc === undefined ? undefined : { ...oc }) as Record<string, unknown>;
      expect(n).toEqual(o);
    }
    expect(oldCs.normalizeBashOptions({ timeout: 9999 })).toMatchObject({ timeout: 600 });
    expect(oldCs.normalizeBashOptions({ cwd: "/x", timeout: 45 })).toMatchObject({ cwd: "/x", timeout: 45 });
    expect(newCs.bashTimeoutPolicy).toEqual(oldCs.bashTimeoutPolicy);
    expect(Object.isFrozen(newCs.bashTimeoutPolicy)).toBe(true);
  });

  it("I persistence-utils 直测对拍", async () => {
    const { oldPu, newPu } = await loadPersistenceMods();
    async function puFlow(mod: AnyMod): Promise<AnyMod> {
      const dir = path.join(PROJECT_DIR, ".oaw", "pu-parity");
      const out: AnyMod = {};
      out.ensure = mod.ensureDirectory(dir);
      const aFile = path.join(dir, "a.json");
      mod.atomicWriteJson(aFile, { v: 1, list: [1, 2] });
      mod.atomicWriteJson(aFile, { v: 2 });
      out.readA = mod.readJsonFile(aFile, null);
      out.readMissing = mod.readJsonFile(path.join(dir, "missing.json"), { fb: true });
      const logFile = path.join(dir, "log.jsonl");
      out.append1 = mod.appendJsonLine(logFile, { n: 1 });
      out.append2 = mod.appendJsonLine(logFile, { n: 2 });
      out.rawA = store.sides[store.active].files.get(path.resolve(aFile));
      out.rawLog = store.sides[store.active].files.get(path.resolve(logFile));
      return out;
    }
    const oldOut = await runSide("old", () => puFlow(oldPu));
    const newOut = await runSide("new", () => puFlow(newPu));
    expect(newOut).toEqual(oldOut);
    expect(oldOut.rawA).toBe(JSON.stringify({ v: 2 }, null, 2) + "\n");
    expect(oldOut.rawLog).toBe(JSON.stringify({ n: 1 }) + "\n" + JSON.stringify({ n: 2 }) + "\n");
    expect(oldOut.readA).toEqual({ v: 2 });
    expect(oldOut.readMissing).toEqual({ fb: true });
    expect(oldOut.ensure).toBe(path.join(PROJECT_DIR, ".oaw", "pu-parity"));
  });
});
