/**
 * B6-6-4f 行为覆盖：AgentManager 动态上下文 + 模块级残余（server/agent.mjs 对应 TS 转录）。
 *
 * 覆盖：
 * - buildDynamicContext：mode 三分支词条 / 记忆摘要截断（chat 800 其余 1500）/ sharedMemCtx
 *   共享跳过重读 / entry.workspace 缺省回退 getWorkspace / threadId 上下文文件名 / 异常吞错返回空串。
 * - writeContextFile：首写双文件（线程级权威 + 旧名兼容）/ 内容不变跳过落盘（mtime 断言）/
 *   内容变化重写 / 无 threadId 只写兼容文件 / sharedMemCtx 共享。
 * - 模块级残余：buildOutputPolicyLines / SESSION_STORE+findSessionFileForAgent+
 *   materializeSessionPath / toolFingerprint / RUN_BUDGET_ENFORCE+ensureRunBudget+
 *   emitBudgetEvent+stopRunByBudget / noteRepeatedToolCall / listAuth+setApiKey+removeApiKey /
 *   ensureContextFile / 常量 REPEATED_TOOL_WARN_AT、ASK_TIMEOUT_MS。
 *
 * R6-6b 对拍退役改写：旧侧行号提取源段 + new Function 求值随 server/agent.mjs 退役删除，
 * 仅保留 TS 侧断言。类方法经 AgentManager.prototype.buildDynamicContext/writeContextFile
 * .call(fakeThis) 驱动，fakeThis 只含 deps.readMemoryContext（方法体内无其它 this 引用）。
 * findSessionFileForAgent/materializeSessionPath 以可选尾参 storeDir 注入测试目录；
 * 凭据存储用内存 store（vi.hoisted + vi.mock pi-config-management），不触碰真实凭据文件。
 * 预算 hard 场景：vi.stubEnv + vi.resetModules + dynamic import 重新固化模块常量。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync, existsSync, utimesSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { AgentManager } from "../src/main/backend/agent/agent-manager";
import { buildOutputPolicyLines } from "../src/main/backend/agent/prompt-chain";
import { ASK_TIMEOUT_MS } from "../src/main/backend/agent/pending-asks";
import { REPEATED_TOOL_WARN_AT, toolFingerprint, noteRepeatedToolCall } from "../src/main/backend/agent/tool-repeat";
import { RUN_BUDGET_ENFORCE, ensureRunBudget, emitBudgetEvent, stopRunByBudget } from "../src/main/backend/agent/budget-wiring";
import { SESSION_STORE, findSessionFileForAgent, materializeSessionPath } from "../src/main/backend/agent/session-store";
import { listAuth, setApiKey, removeApiKey } from "../src/main/backend/agent/provider-auth";
import { ensureContextFile } from "../src/main/backend/agent/context";
import { PROJECT_DIR, getWorkspace } from "../src/main/backend/workspace";
import { createRunBudget, budgetSnapshot } from "../src/shared/runtime/run-budget";

// 常量锚点：与旧 server/agent.mjs 逐值一致（R6-6b 对拍退役后作为行为基线保留）
expect(ASK_TIMEOUT_MS).toBe(300_000);
expect(REPEATED_TOOL_WARN_AT).toBe(3);
expect(RUN_BUDGET_ENFORCE).toBe("soft");
expect(SESSION_STORE).toBe(path.join(PROJECT_DIR, ".规聚会话"));

// ==================== 新侧类方法驱动 ====================

/** 类方法驱动：fakeThis 只带 deps.readMemoryContext（方法体内无其它 this 引用）。 */
const callNewBuildDynamicContext = (readMemoryContext: (ws: unknown) => any, entry: any, file: unknown, sharedMemCtx: any = null) =>
  (AgentManager.prototype.buildDynamicContext as any).call({ deps: { readMemoryContext } }, entry, file, sharedMemCtx);
const callNewWriteContextFile = (readMemoryContext: (ws: unknown) => any, entry: any, file: unknown, sharedMemCtx: any = null) =>
  (AgentManager.prototype.writeContextFile as any).call({ deps: { readMemoryContext } }, entry, file, sharedMemCtx);

// ==================== 夹具 ====================

let tmpRoot: string;
beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "b664f-"));
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.resetModules();
});

const readText = (file: string) => readFileSync(file, "utf8");

describe("buildDynamicContext 行为覆盖", () => {
  it("mode agent（缺省）+ 长记忆截断 1500 + threadId 上下文文件名", () => {
    const mem = "M".repeat(1600) + "TAIL";
    const stub = () => mem;
    const entry = { workspace: "C:/ws/a", mode: undefined, threadId: "t1", currentFile: "doc.docx" };
    const out = callNewBuildDynamicContext(stub, entry, "doc.docx");
    expect(out).toContain("[动态上下文]");
    expect(out).toContain("C:/ws/a");
    expect(out).toContain(".agent-context.t1.md");
    expect(out).toContain(`- 工作区记忆摘要：\n${"M".repeat(1500)}`);
    expect(out).not.toContain("TAIL");
    expect(out).toContain("Office 文档一律用 officecli");
    expect(out).toContain("计划触发条件");
  });

  it("mode chat：纪律词条切换 + 记忆截断 800", () => {
    const mem = "C".repeat(900) + "TAIL";
    const stub = () => mem;
    const entry = { workspace: "C:/ws/a", mode: "chat", threadId: "t2" };
    const out = callNewBuildDynamicContext(stub, entry, "");
    expect(out).toContain("- 当前为 Chat：只读检索、解释与引用");
    expect(out).not.toContain("Office 文档一律用 officecli");
    expect(out).toContain(`- 工作区记忆摘要：\n${"C".repeat(800)}`);
    expect(out).not.toContain("TAIL");
    expect(out).toContain("- 当前工作文件: （无）");
  });

  it("mode review：审查纪律词条 + 记忆截断 1500", () => {
    const stub = () => "R".repeat(1600);
    const entry = { workspace: "C:/ws/a", mode: "review" };
    const out = callNewBuildDynamicContext(stub, entry, "report.md");
    expect(out).toContain("- 当前为 Review：先识别材料类型");
    expect(out).toContain("- 必须维护规范依据台账");
    expect(out).toContain("- Review 禁止使用 bash、地图编辑、浏览器自动化和 memory_update");
  });

  it("sharedMemCtx 共享：readMemoryContext 不被调用；异常吞错返回空串", () => {
    let calls = 0;
    const stub = () => {
      calls += 1;
      return "MEM";
    };
    const entry = { workspace: "C:/ws/a", mode: "chat" };
    const shared = "SHARED";
    expect(callNewBuildDynamicContext(stub, entry, "f", shared)).toContain("SHARED");
    expect(calls).toBe(0);

    const boom = () => {
      throw new Error("mem boom");
    };
    expect(callNewBuildDynamicContext(boom, entry, "f")).toBe("");
  });

  it("entry.workspace 缺省回退 getWorkspace", () => {
    const stub = () => "";
    const entry = { mode: "chat" };
    expect(callNewBuildDynamicContext(stub, entry, "")).toContain(getWorkspace());
  });
});

describe("writeContextFile 行为覆盖", () => {
  it("首写：线程级 + 兼容双文件内容一致", () => {
    const stub = () => "记忆摘要内容";
    const ws = path.join(tmpRoot, "ws-first");
    mkdirSync(ws, { recursive: true });
    callNewWriteContextFile(stub, { workspace: ws, threadId: "t1" }, "doc.docx");
    const thread = readText(path.join(ws, ".agent-context.t1.md"));
    const compat = readText(path.join(ws, ".agent-context.md"));
    expect(thread).toBe(compat);
    expect(compat).toContain(`- **当前工作区（绝对路径）**: ${ws}`);
    expect(compat).toContain("- 当前工作文件: doc.docx");
    expect(compat).toContain("## 工作区记忆（每次任务开始前阅读；沉淀新经验请用 memory_update 工具，勿直接写文件）\n记忆摘要内容");
    expect(compat).toContain(`/maps/{project}/`);
  });

  it("内容不变跳过落盘（mtime 断言）；内容变化重写", () => {
    const stub = () => "MEM";
    const ws = path.join(tmpRoot, "ws-skip");
    mkdirSync(ws, { recursive: true });
    const entry = { workspace: ws, threadId: "t1" };
    const run = (e: any, file: unknown) => callNewWriteContextFile(stub, e, file);

    run(entry, "a.docx");
    const past = new Date(Date.now() - 86400_000);
    for (const name of [".agent-context.t1.md", ".agent-context.md"]) {
      utimesSync(path.join(ws, name), past, past);
    }
    run(entry, "a.docx");
    for (const name of [".agent-context.t1.md", ".agent-context.md"]) {
      const mtimeMs = statSync(path.join(ws, name)).mtimeMs;
      expect(mtimeMs).toBeLessThan(Date.now() - 43200_000);
    }
    run(entry, "b.docx");
    expect(readText(path.join(ws, ".agent-context.t1.md"))).toContain("- 当前工作文件: b.docx");
    expect(statSync(path.join(ws, ".agent-context.t1.md")).mtimeMs).toBeGreaterThan(Date.now() - 43200_000);
  });

  it("无 threadId：只写兼容文件；sharedMemCtx 共享跳过重读", () => {
    let calls = 0;
    const stub = () => {
      calls += 1;
      return "MEM";
    };
    const ws = path.join(tmpRoot, "ws-shared");
    mkdirSync(ws, { recursive: true });
    callNewWriteContextFile(stub, { workspace: ws }, "f.md", "SHARED");
    expect(calls).toBe(0);
    expect(existsSync(path.join(ws, ".agent-context.md"))).toBe(true);
    expect(existsSync(path.join(ws, ".agent-context.undefined.md"))).toBe(false);
    expect(readText(path.join(ws, ".agent-context.md"))).toContain("SHARED");
  });
});

describe("findSessionFileForAgent 行为覆盖", () => {
  const touch = (file: string, mtime: number) => utimesSync(file, new Date(mtime), new Date(mtime));

  it("精确名 + 前缀名按 mtime 新→旧返回第一个", () => {
    const store = path.join(tmpRoot, "store-a");
    mkdirSync(path.join(store, "a/b"), { recursive: true });
    writeFileSync(path.join(store, "a/b/s-1.jsonl"), "{}\n");
    writeFileSync(path.join(store, "s-1-extra.jsonl"), "{}\n");
    touch(path.join(store, "a/b/s-1.jsonl"), 1000);
    touch(path.join(store, "s-1-extra.jsonl"), 2000);
    expect(findSessionFileForAgent("s-1", store)?.fullPath).toBe(path.join(store, "s-1-extra.jsonl"));

    touch(path.join(store, "a/b/s-1.jsonl"), 3000);
    expect(findSessionFileForAgent("s-1", store)?.fullPath).toBe(path.join(store, "a/b/s-1.jsonl"));
  });

  it("目录深度 >4 剪枝；非 .jsonl 不收；无匹配返回 null；空参返回 null", () => {
    const store = path.join(tmpRoot, "store-b");
    mkdirSync(path.join(store, "d1/d2/d3/d4/d5"), { recursive: true });
    writeFileSync(path.join(store, "d1/d2/d3/d4/d5/deep.jsonl"), "{}\n");
    writeFileSync(path.join(store, "d1/d2/d3/d4/ok.jsonl"), "{}\n");
    writeFileSync(path.join(store, "note.txt"), "x");
    expect(findSessionFileForAgent("deep", store)).toBeNull();
    expect(findSessionFileForAgent("ok", store)?.fileName).toBe("ok.jsonl");
    expect(findSessionFileForAgent("missing", store)).toBeNull();
    expect(findSessionFileForAgent("", store)).toBeNull();
  });

  it("首行 JSON header（id/sessionId）匹配；坏首行跳过", () => {
    const store = path.join(tmpRoot, "store-c");
    mkdirSync(path.join(store, "x"), { recursive: true });
    writeFileSync(path.join(store, "x/zzz-unknown.jsonl"), JSON.stringify({ id: "s-9" }) + "\nmore\n");
    expect(findSessionFileForAgent("s-9", store)?.fileName).toBe("zzz-unknown.jsonl");

    const store2 = path.join(tmpRoot, "store-c2");
    mkdirSync(store2, { recursive: true });
    writeFileSync(path.join(store2, "abc.jsonl"), JSON.stringify({ sessionId: "s-8" }) + "\n");
    expect(findSessionFileForAgent("s-8", store2)?.fileName).toBe("abc.jsonl");

    const store3 = path.join(tmpRoot, "store-c3");
    mkdirSync(store3, { recursive: true });
    writeFileSync(path.join(store3, "bad.jsonl"), "not-json\n");
    expect(findSessionFileForAgent("s-7", store3)).toBeNull();
  });
});

describe("materializeSessionPath 行为覆盖", () => {
  it("falsy 透传 / 不存在抛错 / 目录抛错", () => {
    const store = path.join(tmpRoot, "store-m");
    mkdirSync(store, { recursive: true });
    expect(materializeSessionPath("", store)).toBe("");
    expect(materializeSessionPath(null, store)).toBeNull();
    const missing = path.join(tmpRoot, "missing.jsonl");
    expect(() => materializeSessionPath(missing, store)).toThrow(`会话文件不存在：${path.resolve(missing)}`);
    expect(() => materializeSessionPath(tmpRoot, store)).toThrow(`会话路径必须是 JSONL 文件，不能是目录：${path.resolve(tmpRoot)}`);
  });

  it("store 内 .jsonl 直返；store 外经 importLocalPiSessionFile 复制；非法 JSONL 包装错误", () => {
    const store = path.join(tmpRoot, "store-m2");
    mkdirSync(store, { recursive: true });
    const inside = path.join(store, "local.jsonl");
    writeFileSync(inside, "{}\n");
    expect(materializeSessionPath(inside, store)).toBe(inside);

    const outsideDir = path.join(tmpRoot, "outside");
    mkdirSync(outsideDir, { recursive: true });
    const outside = path.join(outsideDir, "old-pi.jsonl");
    writeFileSync(outside, JSON.stringify({ id: "s-1" }) + "\n{}\n");
    const copy = materializeSessionPath(outside, store);
    expect(copy).toContain(path.basename(store));
    expect(copy).not.toBe(outside);
    expect(readText(copy)).toBe(readText(outside));

    const badDir = path.join(tmpRoot, "bad");
    mkdirSync(badDir, { recursive: true });
    const bad = path.join(badDir, "bad.txt");
    writeFileSync(bad, "not jsonl");
    expect(() => materializeSessionPath(bad, store)).toThrow("无法将旧 Pi 会话迁移到项目内可写目录");
  });
});

describe("toolFingerprint 行为覆盖", () => {
  it("字符串/对象/空值/空白归一/300 字符截断", () => {
    expect(toolFingerprint("read", { path: "a.txt" })).toBe('read::{"path":"a.txt"}');
    expect(toolFingerprint("bash", "ls -la   && echo hi")).toBe("bash::ls -la && echo hi");
    expect(toolFingerprint("?", undefined)).toBe("?::{}");
    expect(toolFingerprint("", null)).toBe("?::{}");
    expect(toolFingerprint("x", "")).toBe("x::");
    expect(toolFingerprint(0, { n: 1 })).toBe('?::{"n":1}');
    const long = "Z".repeat(500);
    expect(toolFingerprint("t", long)).toBe(`t::${"Z".repeat(300)}`);
    expect(toolFingerprint("t", "a \n\t b")).toBe("t::a b");
    expect(toolFingerprint("t", { b: 1, a: [1, 2] })).toBe('t::{"b":1,"a":[1,2]}');
  });
});

describe("noteRepeatedToolCall 行为覆盖", () => {
  const runScenarios = (note: typeof noteRepeatedToolCall) => {
    const events: any[] = [];
    const steers: string[] = [];
    const emit = (type: string, data: any) => events.push({ type, data });
    const session = { steer: (text: string) => { steers.push(text); return "ok"; } };
    const entry: any = { activeRunId: "run-1" };
    const ev = { toolName: "read", args: { path: "a.txt" } };

    note(entry, session, ev, emit);
    note(entry, session, ev, emit);
    expect(events).toHaveLength(0);
    expect(steers).toHaveLength(0);

    note(entry, session, ev, emit);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("tool_repeat_warning");
    expect(events[0]!.data.name).toBe("read");
    expect(events[0]!.data.count).toBe(3);
    expect(events[0]!.data.input).toContain("read::");
    expect(steers).toHaveLength(1);
    expect(steers[0]).toContain("第 3 次");
    expect(steers[0]).toContain("[系统提醒] 「read」");
    expect(steers).toHaveLength(1);

    // 不同参数独立计数（新 key 首计，不提醒）
    note(entry, session, { toolName: "read", args: { path: "b.txt" } }, emit);
    expect(events).toHaveLength(1);
    // 字符串参数与对象 JSON 同指纹：计数累计，warned 已含该 key → 不再提醒
    note(entry, session, { toolName: "read", args: '{"path":"a.txt"}' }, emit);
    expect(events).toHaveLength(1);

    // 新 Run 重置：重新从 1 计数，第 3 次再提醒
    entry.activeRunId = "run-2";
    note(entry, session, ev, emit);
    note(entry, session, ev, emit);
    expect(events).toHaveLength(1);
    note(entry, session, ev, emit);
    expect(events).toHaveLength(2);
    expect(events[1]!.data.count).toBe(3);

    // steer 同步抛错吞掉（第 3 次才走到 steer，emit 已发生）
    const throwSession = { steer: () => { throw new Error("steer boom"); } };
    note(entry, throwSession, { toolName: "x", args: "y" }, emit);
    note(entry, throwSession, { toolName: "x", args: "y" }, emit);
    expect(events).toHaveLength(2);
    expect(() => note(entry, throwSession, { toolName: "x", args: "y" }, emit)).not.toThrow();
    expect(events).toHaveLength(3);
    // 缺 session（第 3 次触发提醒也不炸）/ entry null 整段吞错
    note(entry, null, { toolName: "z", args: "w" }, emit);
    note(entry, null, { toolName: "z", args: "w" }, emit);
    expect(() => note(entry, null, { toolName: "z", args: "w" }, emit)).not.toThrow();
    expect(() => note(null, session, null, emit)).not.toThrow();

    expect(entry.toolRepeat.counts.get(toolFingerprint("read", { path: "a.txt" }))).toBe(3);
    expect(entry.toolRepeat.warned.has(toolFingerprint("read", { path: "a.txt" }))).toBe(true);
    expect(entry.toolRepeat.runId).toBe("run-2");
  };

  it("阈值 3 提醒一次 / warned 去重 / Run 切换重置 / 异常吞错", () => {
    runScenarios(noteRepeatedToolCall);
  });
});

describe("运行预算接线行为覆盖", () => {
  it("ensureRunBudget：按 Run 建状态/复用/重建清空 toolArgsById", () => {
    const entry: any = { activeRunId: "r1" };

    const b = ensureRunBudget(entry);
    expect(b).toBeTruthy();
    expect(entry.runBudgetRunId).toBe("r1");
    expect(entry.budgetStopped).toBe(false);
    expect(entry.toolArgsById).toBeInstanceOf(Map);

    expect(ensureRunBudget(entry)).toBe(b);

    entry.activeRunId = "r2";
    entry.toolArgsById.set("k", 1);
    const b2 = ensureRunBudget(entry);
    expect(b2).not.toBe(b);
    expect(entry.toolArgsById.size).toBe(0);
    expect(entry.budgetStopped).toBe(false);

    expect(ensureRunBudget(null)).toBeNull();
  });

  it("emitBudgetEvent：level/code 过滤 + 类型映射 + 快照携带", () => {
    const events: any[] = [];
    const emit = (type: string, data: any) => events.push({ type, data });

    emitBudgetEvent({ runBudget: null }, emit, "", "code", "why");
    emitBudgetEvent({ runBudget: null }, emit, "soft", "", "why");
    expect(events).toHaveLength(0);

    const budget = createRunBudget({ runId: "r1" });
    emitBudgetEvent({ runBudget: budget }, emit, "soft", "TURN_SOFT", "too many turns");
    emitBudgetEvent({ runBudget: budget }, emit, "hard", "TOOL_HARD", "stop");
    emitBudgetEvent(null, emit, "soft", "X", "y");
    expect(events.map((e) => e.type)).toEqual(["run_budget_notice", "run_budget_blocked", "run_budget_notice"]);
    expect(events[0]!.data.snapshot).toEqual(budgetSnapshot(budget));
    expect(events[2]!.data.snapshot).toBeNull();
  });

  it("stopRunByBudget：soft 不动作；hard 置位 + 单次 abort；abort 抛错吞掉", async () => {
    const softEntry: any = { session: { abort: vi.fn() } };
    stopRunByBudget(softEntry);
    expect(softEntry.budgetStopped).toBeFalsy();
    expect(softEntry.session.abort).not.toHaveBeenCalled();

    vi.stubEnv("OAW_RUN_BUDGET_ENFORCE", "hard");
    vi.resetModules();
    const hardMod = await import("../src/main/backend/agent/budget-wiring");
    expect(hardMod.RUN_BUDGET_ENFORCE).toBe("hard");

    const entry: any = { session: { abort: vi.fn(async () => {}) } };
    hardMod.stopRunByBudget(entry);
    expect(entry.budgetStopped).toBe(true);
    expect(entry.session.abort).toHaveBeenCalledTimes(1);
    hardMod.stopRunByBudget(entry);
    expect(entry.session.abort).toHaveBeenCalledTimes(1);

    const boomEntry: any = { session: { abort: () => { throw new Error("abort boom"); } } };
    expect(() => hardMod.stopRunByBudget(boomEntry)).not.toThrow();
    expect(boomEntry.budgetStopped).toBe(true);
  });
});

describe("buildOutputPolicyLines 行为覆盖", () => {
  it("work/chat/review 分支 + 缺省与大小写归一", () => {
    const work = buildOutputPolicyLines({ mode: "work" });
    const chat = buildOutputPolicyLines({ mode: "chat" });
    const review = buildOutputPolicyLines({ mode: "review" });
    // 缺省/空串/agent 归一为 work 分支；大小写归一同小写
    expect(buildOutputPolicyLines()).toEqual(work);
    expect(buildOutputPolicyLines({ mode: "" })).toEqual(work);
    expect(buildOutputPolicyLines({ mode: "agent" })).toEqual(work);
    expect(buildOutputPolicyLines({ mode: "CHAT" })).toEqual(chat);
    expect(buildOutputPolicyLines({ mode: "Review" })).toEqual(review);
    expect(chat).toHaveLength(2);
    expect(chat[0]).toContain("- **进度结论（重要）**");
    expect(chat[1]).toContain("不要输出固定的 Markdown 分段模板");
    expect(work[1]).toContain("当本轮产生了文件、报告、数据、代码改动等成果时");
    expect(chat[1]).not.toBe(work[1]);
  });
});

describe("listAuth/setApiKey/removeApiKey 行为覆盖", () => {
  /** 凭据内存 store（vi.hoisted 定义，vi.mock 转发）。 */
  const credStore = vi.hoisted(() => {
    const store: Record<string, any> = {};
    const deep = (v: any) => JSON.parse(JSON.stringify(v));
    return {
      reset: () => { for (const k of Object.keys(store)) delete store[k]; },
      read: () => deep(store),
      write: (v: any) => {
        const next = deep(v);
        for (const k of Object.keys(store)) delete store[k];
        Object.assign(store, next);
      },
    };
  });

  beforeEach(() => {
    credStore.reset();
  });

  vi.mock("../src/main/backend/agent/pi-config-management", async (importOriginal) => {
    const actual = await importOriginal<Record<string, any>>();
    return { ...actual, readCredentials: () => credStore.read(), writeCredentials: (value: any) => credStore.write(value) };
  });

  const makeRuntime = (calls: any[]) => ({
    modelRuntime: async () => ({
      setRuntimeApiKey: async (provider: unknown, key: unknown, options: any) => {
        calls.push(["setRuntimeApiKey", provider, key, options]);
      },
    }),
    resetModelRuntime: () => {
      calls.push(["resetModelRuntime"]);
    },
  });

  it("setApiKey：trim 写回 + 运行时注入 + 注入失败静默", async () => {
    const calls: any[] = [];
    const result = await setApiKey("prov-a", "  key-1  ", makeRuntime(calls));
    expect(result).toEqual({ ok: true, providers: ["prov-a"] });
    expect(calls).toEqual([["setRuntimeApiKey", "prov-a", "key-1", { allowNetwork: false }]]);
    const snapshot = listAuth();
    expect(snapshot["prov-a"]).toEqual({ type: "api_key", key: "key-1" });

    // 注入失败静默
    const failing = { modelRuntime: async () => { throw new Error("runtime boom"); } };
    const result2 = await setApiKey("prov-a", "key-2", failing);
    expect(result2).toEqual({ ok: true, providers: ["prov-a"] });
    expect(listAuth()["prov-a"]!.key).toBe("key-2");
  });

  it("removeApiKey：删除写回 + 重置运行时", async () => {
    const calls: any[] = [];
    await setApiKey("prov-b", "k", makeRuntime(calls));
    const result = await removeApiKey("prov-b", { resetModelRuntime: () => calls.push(["resetModelRuntime"]) });
    expect(result).toEqual({ ok: true, providers: [] });
    expect(calls.filter((c) => c[0] === "resetModelRuntime")).toHaveLength(1);
    expect(listAuth()["prov-b"]).toBeUndefined();

    const result2 = await removeApiKey("ghost", { resetModelRuntime: () => {} });
    expect(result2).toEqual({ ok: true, providers: [] });
  });

  it("listAuth 透传凭据存储", () => {
    credStore.write({ "prov-c": { type: "api_key", key: "k" } });
    expect(listAuth()).toEqual({ "prov-c": { type: "api_key", key: "k" } });
    expect(listAuth()).toEqual(credStore.read());
  });
});

describe("ensureContextFile 行为覆盖", () => {
  it("缺文件写默认内容；已有文件保留", () => {
    const dir = path.join(tmpRoot, "proj-a");
    const keepDir = path.join(tmpRoot, "proj-keep");
    mkdirSync(dir, { recursive: true });
    mkdirSync(keepDir, { recursive: true });

    ensureContextFile(dir);
    const expected = "# Office Agent Workspace\n\n- 当前没有打开文档\n- 当前工作文件: (无)\n";
    expect(readText(path.join(dir, ".agent-context.md"))).toBe(expected);

    writeFileSync(path.join(keepDir, ".agent-context.md"), "自定义内容");
    ensureContextFile(keepDir);
    expect(readText(path.join(keepDir, ".agent-context.md"))).toBe("自定义内容");
  });
});
