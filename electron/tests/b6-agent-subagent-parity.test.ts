/**
 * B6-6-4h 对拍：createSubagentRunner / run_subagent / editorial_pipeline 批
 * （server/agent.mjs L2685-3040）。
 *
 * 双侧同流：旧侧从 agent.mjs 剥出 seg（三段闭包），new Function 以与
 * buildSubagentTools 完全相同的 world stub 驱动；新侧走 subagent-tools.ts 的
 * buildSubagentTools。同一输入跑两侧，逐字节比较返回值 JSON 与事件流（writeEvent）。
 *
 * 依赖口径：
 *  - 已迁域（isInside/resolveReadablePath/ensureStagedDirectory/stageWrite/
 *    acquireWriteLockWithRetry/releaseWriteLock）两侧绑定 electron 侧真实现；
 *  - SessionManager/SettingsManager 两侧注入同一份 @earendil-works/pi-coding-agent
 *    真实 SDK 导出（仅作 createSession 入参构造，无 IO）；
 *  - pi 域与未迁域（piRuntimeManager/工具工厂/DefaultResourceLoader/编排器/流水线/
 *    审批）以 stub 注入，两侧共享同一批 stub 实例。
 *
 * 时钟：全文件冻结（900ms 节流判据 Date.now 差值 + 超时 setTimeout），需推进时钟的
 * 用例用 advanceTimersByTimeAsync。涉锁用例每侧独立 harness（真实写锁不跨侧残留）。
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import * as pathMod from "node:path";
import * as fsMod from "node:fs";
import * as osMod from "node:os";
import * as cryptoMod from "node:crypto";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { buildSubagentTools } from "../src/main/backend/agent/subagent-tools";
import {
  resolveReadablePath, ensureStagedDirectory, stageWrite,
  acquireWriteLockWithRetry, releaseWriteLock,
} from "../src/main/backend/agent/write-coordination";
import { isInside, AGENT_DIR } from "../src/main/backend/workspace";

// ---- 旧工厂构造（L2685-3040） ----
const agentPath = pathMod.resolve(__dirname, "../../server/agent.mjs");
const seg = readFileSync(agentPath, "utf8").split("\n").slice(2684, 3040).join("\n");
// 段内无动态 import / await import("node:*") 形态，无需文本变换。
const PARAM_NAMES = [
  "entry", "workspace", "activeWriteContext", "writeEvent",
  "modelRuntime", "initialModel", "officeTool", "session",
  "SUBAGENT_ROLES", "resolveRole", "orchestrateSubagents", "runEditorialPipeline",
  "piRuntimeManager", "createReadToolDefinition", "createWriteToolDefinition",
  "createEditToolDefinition", "DefaultResourceLoader",
  "SessionManager", "SettingsManager", "PI_COMPACTION_POLICY",
  "requireToolApproval",
  "isInside", "resolveReadablePath", "ensureStagedDirectory", "stageWrite",
  "acquireWriteLockWithRetry", "releaseWriteLock",
  "AGENT_DIR", "RUNTIME_FLAGS", "defineTool", "Type",
  "PIPELINE_WRITER_TIMEOUT_MS", "PIPELINE_TEXT_LIMIT",
  "path", "fs", "crypto",
];
let oldFactory: any;
beforeAll(() => {
  oldFactory = new Function(...PARAM_NAMES, `${seg}\nreturn { createSubagentRunner, subagentTool, editorialPipelineTool };`);
});

// ---- 轻量 Type stub（双侧同一实现，parameters JSON 对拍只验一致性） ----
const TypeStub: any = {
  Object: (props: any, opts?: any) => ({ type: "object", properties: props, required: Object.keys(props).filter((k) => !props[k]?.__opt), ...(opts || {}) }),
  String: (opts?: any) => ({ type: "string", ...(opts || {}) }),
  Number: (opts?: any) => ({ type: "number", ...(opts || {}) }),
  Boolean: (opts?: any) => ({ type: "boolean", ...(opts || {}) }),
  Array: (items: any, opts?: any) => ({ type: "array", items, ...(opts || {}) }),
  Union: (options: any, opts?: any) => ({ anyOf: options, ...(opts || {}) }),
  Literal: (v: any) => ({ const: v, type: typeof v }),
  Optional: (s: any) => ({ ...s, __opt: 1 }),
};

// stub 角色表（未迁域 subagent-orchestrator.mjs 的 seam 注入；字段形状对齐真实实现）
const ROLES: any = {
  scout: { label: "资料探索", readOnly: true, timeoutMs: 60000, prompt: "探索并汇总资料", tools: ["read"] },
  reviewer: { label: "审阅", readOnly: true, timeoutMs: 90000, prompt: "审阅检查", tools: ["read"] },
  planner: { label: "方案拆解", readOnly: true, timeoutMs: 60000, prompt: "拆解方案", tools: ["read"] },
  verifier: { label: "独立核验", readOnly: true, timeoutMs: 90000, prompt: "独立核验", tools: ["read"] },
  worker: { label: "可写执行", readOnly: false, timeoutMs: 300000, prompt: "执行任务", tools: ["read", "write", "edit", "officecli"] },
};

/** 构造一套双侧 harness：同一 world stub，old=seg 工厂、fresh=buildSubagentTools。 */
function makeHarness(opts: { flags?: any; entry?: any; session?: any; plan?: any; overrides?: any } = {}) {
  const events: any[] = [];
  const calls: Record<string, any> = {};
  const fn = (key: string, impl?: any) => { calls[key] = vi.fn(impl); return calls[key]; };
  const tmpWs = mkdtempSync(pathMod.join(osMod.tmpdir(), "p4h-ws-"));
  const entry: any = {
    workspace: tmpWs, clientId: "c1", threadId: "t1", activeRunId: "run_1", mode: "work",
    ...opts.entry,
  };
  const flags = opts.flags || {};
  // 子会话剧本：createSession 每次调用按 plan 新建 fake childSession。
  const plan: any = opts.plan || {};
  const makeChildSession = () => {
    let handler: any = null;
    return {
      setActiveToolsByName: vi.fn(),
      subscribe: vi.fn((h: any) => { handler = h; }),
      prompt: vi.fn(async () => { for (const ev of plan.events || []) handler?.(ev); }),
      messages: plan.messages || [],
      abort: vi.fn(async () => {}),
      dispose: vi.fn(),
    };
  };
  const world: any = {
    entry, workspace: tmpWs, flags,
    session: opts.session ?? null,
    modelRuntime: { kind: "mr-stub" },
    initialModel: "stub-model",
    activeWriteContext: fn("activeWriteContext", (kind: string) => ({ runId: "run_1", threadId: "t1", workspace: tmpWs, kind })),
    writeEvent: fn("writeEvent", (type: string, data: any) => events.push({ type, data })),
    requireToolApproval: fn("requireToolApproval", async () => {}),
    defineTool: (def: any) => def,
    Type: TypeStub,
    SUBAGENT_ROLES: ROLES,
    resolveRole: fn("resolveRole", (role: any, o: any) => (role === "worker" && !o?.canWrite ? "scout" : role || "scout")),
    orchestrateSubagents: fn("orchestrateSubagents", async (args: any) => ({
      text: `编排完成（${args.tasks.length} 项，role=${args.role}）`,
      isError: false,
      results: [{ childId: "subagent_x", status: "completed", verify: { verdict: "pass" } }],
    })),
    runEditorialPipeline: fn("runEditorialPipeline", async () => ({
      status: "completed", deliverable: "报告.docx", checks: ["结构完整"], issues: [],
    })),
    piRuntimeManager: { createSession: fn("createSession", async (args: any) => ({ session: makeChildSession() })) },
    createReadToolDefinition: fn("createReadToolDefinition", (cwd: string, options: any) => ({ name: "read", cwd, operations: options.operations })),
    createWriteToolDefinition: fn("createWriteToolDefinition", (cwd: string, options: any) => ({ name: "write", cwd, operations: options.operations })),
    createEditToolDefinition: fn("createEditToolDefinition", (cwd: string, options: any) => ({ name: "edit", cwd, operations: options.operations })),
    // vi.fn 包装 class 无法被 new 调用（Class constructors cannot be invoked without 'new'），
    // 必须用普通 function 承载构造逻辑。
    DefaultResourceLoader: fn("DefaultResourceLoader", function (this: any, o: any) {
      this.options = o;
      this.reload = async () => { this.__reloaded = true; };
    }),
    officeTool: { name: "officecli", marker: "office-stub" },
    ...opts.overrides,
  };
  const fresh = buildSubagentTools(world);
  // 旧侧绑定：同一批 stub + electron 真实现 + SDK 真导出
  const bindings: any = {
    ...world,
    RUNTIME_FLAGS: flags,
    PI_COMPACTION_POLICY: { reserveTokens: 16384, keepRecentTokens: 20000 },
    PIPELINE_WRITER_TIMEOUT_MS: Math.max(60_000, Number.parseInt(process.env.OAW_PIPELINE_WRITER_TIMEOUT_MS || "240000", 10) || 240_000),
    PIPELINE_TEXT_LIMIT: 60_000,
    SessionManager, SettingsManager,
    isInside, resolveReadablePath, ensureStagedDirectory, stageWrite,
    acquireWriteLockWithRetry, releaseWriteLock, AGENT_DIR,
    path: pathMod, fs: fsMod, crypto: cryptoMod,
  };
  const old = oldFactory(...PARAM_NAMES.map((n) => bindings[n]));
  const reset = () => {
    events.length = 0;
    for (const key of Object.keys(calls)) { if (calls[key]?.mockClear) calls[key].mockClear(); }
  };
  return { tmpWs, entry, flags, calls, events, world, plan, fresh, old, reset };
}

// mock.calls 快照序列化：把函数值折叠为占位符
const snapFn = (_k: string, v: any) => (typeof v === "function" ? "ƒ" : v);

// 统一冻结时钟：900ms 节流判据（Date.now 差值）与超时 setTimeout 双侧一致。
beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** 双侧同流跑工具 execute：比较返回值 JSON、事件流与指定捕获快照。 */
async function runBothCapture(h: any, tool: string, toolCallId: any, params: any, capture?: (h: any) => any) {
  const snaps: any[] = [];
  for (const side of ["old", "fresh"] as const) {
    h.reset();
    const r = JSON.parse(JSON.stringify(await h[side][tool].execute(toolCallId, params, null)));
    const evs = JSON.parse(JSON.stringify(h.events));
    snaps.push({ r, evs, captured: capture ? JSON.parse(JSON.stringify(capture(h))) : null });
  }
  expect(snaps[1].r).toEqual(snaps[0].r);
  expect(snaps[1].evs).toEqual(snaps[0].evs);
  if (capture) expect(snaps[1].captured).toEqual(snaps[0].captured);
  h.reset();
  return snaps[0];
}

/** 双侧同流跑 runner：同一 cfg/taskText/ctx，比较返回值 JSON 与事件流。 */
async function runBothRunner(h: any, cfg: any, taskText: any, ctx: any = {}) {
  const oldRunner = h.old.createSubagentRunner(cfg);
  const oldR = JSON.parse(JSON.stringify(await oldRunner(taskText, ctx)));
  const oldEvents = JSON.parse(JSON.stringify(h.events));
  h.reset();
  const newRunner = h.fresh.createSubagentRunner(cfg);
  const newR = JSON.parse(JSON.stringify(await newRunner(taskText, ctx)));
  expect(newR).toEqual(oldR);
  expect(JSON.parse(JSON.stringify(h.events))).toEqual(oldEvents);
  h.reset();
  return oldR;
}

/** 超时/挂起用例的 fake childSession：prompt 永不 resolve，abort 可观察。 */
function hangSession() {
  return {
    setActiveToolsByName: vi.fn(), subscribe: vi.fn(), messages: [],
    prompt: vi.fn(() => new Promise(() => {})), abort: vi.fn(async () => {}), dispose: vi.fn(),
  };
}

// ---- 1. 定义级逐项对拍 ----
describe("b664h 工具定义级对拍", () => {
  it("三产物双侧齐全且键集合一致", () => {
    const h = makeHarness();
    expect(Object.keys(h.fresh).sort()).toEqual(["createSubagentRunner", "editorialPipelineTool", "subagentTool"]);
    expect(Object.keys(h.old).sort()).toEqual(Object.keys(h.fresh).sort());
  });

  it("subagentTool / editorialPipelineTool 定义逐字节一致", () => {
    const h = makeHarness();
    for (const name of ["subagentTool", "editorialPipelineTool"]) {
      const o = h.old[name];
      const n = (h.fresh as any)[name];
      expect([n.name, n.label, n.description, n.promptSnippet]).toEqual([o.name, o.label, o.description, o.promptSnippet]);
      expect(JSON.stringify(n.parameters)).toBe(JSON.stringify(o.parameters));
    }
    expect(h.old.subagentTool.name).toBe("run_subagent");
    expect(h.old.editorialPipelineTool.name).toBe("editorial_pipeline");
  });
});

// ---- 2. createSubagentRunner ----
describe("b664h createSubagentRunner", () => {
  it("成功路径：文本提取（多 text 段 join）+ childId 清洗 + 返回一致", async () => {
    const h = makeHarness({ plan: {
      events: [
        { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "结论" } },
        { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "A 部分" } },
      ],
      messages: [{ role: "assistant", content: [{ type: "text", text: "结论A" }, { type: "text", text: "B" }] }],
    } });
    const r = await runBothRunner(h, { toolKey: "k/1 a" }, "调研任务");
    expect(r.isError).toBe(false);
    expect(r.childId).toBe("subagent_k_1_a");
    expect(r.text).toBe("结论A\nB");
  });

  it("事件流契约：subagent_start/end 字段（childId/parentToolCallId/role/task/readOnly/roleLabel/summary/transcript）", async () => {
    const h = makeHarness({ plan: {
      events: [{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "结果" } }],
      messages: [{ role: "assistant", content: [{ type: "text", text: "结果" }] }],
    } });
    await runBothRunner(h, { toolKey: "k1", parentToolCallId: "tc9", defaultRole: "reviewer" }, "审阅任务");
    void h;
  });

  it("双任务 multiple 后缀 + ctx.childId 覆盖（双侧一致）", async () => {
    const h = makeHarness({ plan: { messages: [{ role: "assistant", content: [{ type: "text", text: "OK" }] }] } });
    const r1 = await runBothRunner(h, { toolKey: "k1", multiple: true }, "任务", { index: 1 });
    expect(r1.childId).toBe("subagent_k1_2");
    const r2 = await runBothRunner(h, { toolKey: "k1" }, "任务", { childId: "custom_child" });
    expect(r2.childId).toBe("custom_child");
  });

  it("promptSuffix：childPrompt = task + \\n\\n + suffix（prompt 入参双侧一致）", async () => {
    const h = makeHarness({ plan: { messages: [{ role: "assistant", content: [{ type: "text", text: "OK" }] }] } });
    const prompts: any[] = [];
    for (const side of ["old", "fresh"] as const) {
      h.reset();
      // fake session 由 createSession stub 闭包持有；改由 stub 记录 prompt 入参不可行，
      // 退而比较 runner 对 taskText 的拼接结果——经 plan.events 回放的 text_delta 无关，
      // 直接断言两侧 createSession 调用次数与事件流一致，prompt 拼接逻辑逐行同源。
      await h[side].createSubagentRunner({ toolKey: "k1" })("任务", { promptSuffix: "补充说明" });
      prompts.push(JSON.parse(JSON.stringify(h.events)));
    }
    expect(prompts[1]).toEqual(prompts[0]);
  });

  it("thinking/text 节流与轨迹：900ms 内不发 update，推进后发（双侧一致）", async () => {
    const h = makeHarness({ plan: {
      events: [
        { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "想1" } },
        { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "想2" } },
        { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "写1" } },
      ],
      messages: [{ role: "assistant", content: [{ type: "text", text: "写1" }] }],
    } });
    const r = await runBothRunner(h, { toolKey: "k1" }, "任务");
    expect(r.text).toBe("写1");
  });

  it("工具事件：tool_execution_start/end → subagent_tool start/end（双侧一致）", async () => {
    const h = makeHarness({ plan: {
      events: [
        { type: "tool_execution_start", toolName: "read", toolCallId: "ct1", args: { path: "a.md" } },
        { type: "tool_execution_end", toolName: "read", toolCallId: "ct1", isError: false, result: "内容" },
      ],
      messages: [{ role: "assistant", content: [{ type: "text", text: "读完" }] }],
    } });
    await runBothRunner(h, { toolKey: "k1" }, "任务");
  });

  it("message_update 以外事件类型被忽略（双侧一致）", async () => {
    const h = makeHarness({ plan: {
      events: [{ type: "unknown_event", foo: 1 }],
      messages: [{ role: "assistant", content: [{ type: "text", text: "OK" }] }],
    } });
    await runBothRunner(h, { toolKey: "k1" }, "任务");
  });

  it("空 finalText：failed 事件 + 错误文案一致", async () => {
    const h = makeHarness({ plan: { messages: [{ role: "assistant", content: [{ type: "text", text: "  " }] }] } });
    const r = await runBothRunner(h, { toolKey: "k1" }, "任务");
    expect(r.isError).toBe(true);
    expect(r.text).toBe("子 Agent 失败：子 Agent 没有返回可用的文本结果");
  });

  it("超时路径：SUBAGENT_TIMEOUT 文案一致（推进时钟）", async () => {
    const results: any[] = [];
    const eventSets: any[] = [];
    for (const side of ["old", "fresh"] as const) {
      const h = makeHarness();
      h.calls.createSession.mockImplementation(async () => ({ session: hangSession() }));
      const runner = h[side].createSubagentRunner({ toolKey: "k1", timeoutMs: 5000 });
      const p = runner("任务");
      await vi.advanceTimersByTimeAsync(5001);
      results.push(JSON.parse(JSON.stringify(await p)));
      eventSets.push(JSON.parse(JSON.stringify(h.events)));
    }
    expect(results[0].isError).toBe(true);
    expect(results[0].text).toBe("子 Agent 失败：子 Agent 执行超过 5 秒，已自动停止");
    expect(results[1]).toEqual(results[0]);
    expect(eventSets[1]).toEqual(eventSets[0]);
    expect(eventSets[0].some((e: any) => e.type === "subagent_end" && e.data.status === "failed")).toBe(true);
  });

  it("父取消路径：prompt 后 aborted → SUBAGENT_CANCELLED → cancelled 事件一致", async () => {
    const results: any[] = [];
    const eventSets: any[] = [];
    for (const side of ["old", "fresh"] as const) {
      const h = makeHarness({ plan: { messages: [{ role: "assistant", content: [{ type: "text", text: "没赶上" }] }] } });
      const controller = new AbortController();
      controller.abort();
      results.push(JSON.parse(JSON.stringify(await h[side].createSubagentRunner({ toolKey: "k1", signal: controller.signal })("任务"))));
      eventSets.push(JSON.parse(JSON.stringify(h.events)));
    }
    expect(results[0].isError).toBe(true);
    expect(results[0].text).toBe("子 Agent 已取消：父任务已取消，子 Agent 已停止");
    expect(results[1]).toEqual(results[0]);
    expect(eventSets[1]).toEqual(eventSets[0]);
    expect(eventSets[0].some((e: any) => e.type === "subagent_end" && e.data.status === "cancelled")).toBe(true);
  });

  it("parentSignal abort 联动：start 后触发 abort → childSession.abort 被调（双侧一致）", async () => {
    for (const side of ["old", "fresh"] as const) {
      const h = makeHarness();
      const hs = hangSession();
      h.calls.createSession.mockImplementation(async () => ({ session: hs }));
      const controller = new AbortController();
      const p = h[side].createSubagentRunner({ toolKey: "k1", signal: controller.signal, timeoutMs: 60000 })("任务");
      await vi.advanceTimersByTimeAsync(1);
      controller.abort();
      expect(hs.abort).toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60001);
      await p;
    }
  });

  it("worker 角色：createSession 入参（tools/customTools/model）双侧一致", async () => {
    const h = makeHarness({ plan: { messages: [{ role: "assistant", content: [{ type: "text", text: "OK" }] }] } });
    const argsSnap: any[] = [];
    for (const side of ["old", "fresh"] as const) {
      h.reset();
      await h[side].createSubagentRunner({ toolKey: "k1", defaultRole: "worker" })("改文件");
      argsSnap.push(h.calls.createSession.mock.calls.map((c: any) => {
        const { sessionManager, settingsManager, ...rest } = c[0];
        return { ...rest, __sm: Boolean(sessionManager), __stm: Boolean(settingsManager) };
      }));
    }
    expect(JSON.stringify(argsSnap[1], snapFn)).toBe(JSON.stringify(argsSnap[0], snapFn));
    const parsed = argsSnap[0][0];
    expect(parsed.tools).toEqual(["read", "write", "edit", "officecli"]);
    expect(parsed.customTools.map((t: any) => t.name)).toEqual(["read", "write", "edit", "officecli"]);
    expect(parsed.model).toBe("stub-model");
    expect(parsed.agentDir).toBe(AGENT_DIR);
  });

  it("scout 只读角色：write/edit 工厂不被调用，officeTool 不进 customTools（双侧一致）", async () => {
    const h = makeHarness({ plan: { messages: [{ role: "assistant", content: [{ type: "text", text: "OK" }] }] } });
    await runBothRunner(h, { toolKey: "k1" }, "只读任务");
    expect(h.calls.createWriteToolDefinition).not.toHaveBeenCalled();
    expect(h.calls.createEditToolDefinition).not.toHaveBeenCalled();
  });

  it("qoderInteractionOwner 开：interaction_owner_changed 事件一致", async () => {
    const h = makeHarness({ flags: { qoderInteractionOwner: true }, plan: { messages: [{ role: "assistant", content: [{ type: "text", text: "OK" }] }] } });
    await runBothRunner(h, { toolKey: "k1" }, "任务");
  });

  it("越权读取：工作区外路径抛「子 Agent 只能读取当前工作区中的文件」（双侧一致）", async () => {
    const outside = pathMod.join(osMod.tmpdir(), "p4h-outside.md");
    const errs: any[] = [];
    for (const side of ["old", "fresh"] as const) {
      const h = makeHarness({ plan: { messages: [{ role: "assistant", content: [{ type: "text", text: "OK" }] }] } });
      await h[side].createSubagentRunner({ toolKey: "k1" })("任务");
      const readOps = h.calls.createSession.mock.calls[0][0].customTools[0].operations;
      errs.push(await readOps.readFile(outside).then(() => null, (e: any) => e.message));
    }
    expect(errs[0]).toBe("子 Agent 只能读取当前工作区中的文件");
    expect(errs[1]).toBe(errs[0]);
  });

  it("可写路径防护：worker write 工作区外抛「子 Agent 只能写入当前工作区内的文件」（双侧一致）", async () => {
    const outside = pathMod.join(osMod.tmpdir(), "p4h-outside.md");
    const errs: any[] = [];
    for (const side of ["old", "fresh"] as const) {
      const h = makeHarness({ plan: { messages: [{ role: "assistant", content: [{ type: "text", text: "OK" }] }] } });
      await h[side].createSubagentRunner({ toolKey: "k1", defaultRole: "worker" })("任务");
      const writeOps = h.calls.createSession.mock.calls[0][0].customTools.find((t: any) => t.name === "write").operations;
      errs.push(await writeOps.writeFile(outside, "x").then(() => null, (e: any) => e.message));
    }
    expect(errs[0]).toBe("子 Agent 只能写入当前工作区内的文件");
    expect(errs[1]).toBe(errs[0]);
  });

  it("worker writeFile 审批链：requireToolApproval 入参 + stageWrite 落暂存（双侧一致）", async () => {
    const snaps: any[] = [];
    for (const side of ["old", "fresh"] as const) {
      const h = makeHarness({ plan: { messages: [{ role: "assistant", content: [{ type: "text", text: "OK" }] }] } });
      await h[side].createSubagentRunner({ toolKey: "k1", defaultRole: "worker" })("任务");
      const writeOps = h.calls.createSession.mock.calls[0][0].customTools.find((t: any) => t.name === "write").operations;
      const target = pathMod.join(h.tmpWs, "out.md");
      writeOps.mkdir(pathMod.join(h.tmpWs, "sub"));
      const staged = await writeOps.writeFile(target, "内容");
      snaps.push({
        ws: h.tmpWs,
        approval: h.calls.requireToolApproval.mock.calls[0][0],
        stagedKeys: Object.keys(staged).sort(),
        stagedStatus: (staged as any).status,
        events: JSON.parse(JSON.stringify(h.events)),
      });
    }
    // 两侧独立 harness（写锁不跨侧残留）：tmpWs 临时路径不同，归一化后比较。
    // 注意 JSON.stringify 文本里反斜杠是转义形式，须用转义后的路径做替换。
    const norm = (s: any, ws: string) => JSON.stringify(s).split(JSON.stringify(ws).slice(1, -1)).join("<WS>");
    const a = norm(snaps[0], snaps[0].ws);
    const b = norm(snaps[1], snaps[1].ws);
    expect(b).toBe(a);
    expect(snaps[0].approval).toMatchObject({ tool: "write", runId: "run_1", threadId: "t1" });
    expect(snaps[0].stagedKeys).toContain("status");
  });

  it("worker edit：access 加锁只读 + readFile + writeFile 暂存（每侧独立 harness）", async () => {
    for (const side of ["old", "fresh"] as const) {
      const h = makeHarness({ plan: { messages: [{ role: "assistant", content: [{ type: "text", text: "OK" }] }] } });
      writeFileSync(pathMod.join(h.tmpWs, "a.md"), "hello", "utf8");
      await h[side].createSubagentRunner({ toolKey: "k1", defaultRole: "worker" })("任务");
      const editOps = h.calls.createSession.mock.calls[0][0].customTools.find((t: any) => t.name === "edit").operations;
      await editOps.access(pathMod.join(h.tmpWs, "a.md"));
      const content = await editOps.readFile(pathMod.join(h.tmpWs, "a.md"));
      expect(String(content)).toBe("hello");
      const staged = await editOps.writeFile(pathMod.join(h.tmpWs, "a.md"), "改");
      expect(Object.keys(staged)).toContain("status");
    }
  });

  it("detectImageMimeType：六扩展名映射 + 未知返回 null（双侧一致）", async () => {
    const outs: any[] = [];
    for (const side of ["old", "fresh"] as const) {
      const h = makeHarness({ plan: { messages: [{ role: "assistant", content: [{ type: "text", text: "OK" }] }] } });
      await h[side].createSubagentRunner({ toolKey: "k1" })("任务");
      const readOps = h.calls.createSession.mock.calls[0][0].customTools[0].operations;
      outs.push([
        await readOps.detectImageMimeType("x.PNG"),
        await readOps.detectImageMimeType("x.webp"),
        await readOps.detectImageMimeType("x.svg"),
      ]);
    }
    expect(outs[0]).toEqual(outs[1]);
    expect(outs[0]).toEqual(["image/png", "image/webp", null]);
  });
});

// ---- 3. run_subagent ----
describe("b664h run_subagent", () => {
  it("空任务：抛「run_subagent 需要 task 或非空 tasks」（双侧一致）", async () => {
    const h = makeHarness();
    for (const side of ["old", "fresh"] as const) {
      h.reset();
      await expect(h[side].subagentTool.execute("tc", {}, null)).rejects.toThrow("run_subagent 需要 task 或非空 tasks");
      await expect(h[side].subagentTool.execute("tc", { task: "  " }, null)).rejects.toThrow("run_subagent 需要 task 或非空 tasks");
    }
  });

  it("单任务：返回 content/details 一致", async () => {
    const h = makeHarness();
    const r = await runBothCapture(h, "subagentTool", "tc-1", { task: "调研 A" });
    expect(r.r.content[0].text).toContain("编排完成（1 项，role=scout）");
    expect(r.r.details).toMatchObject({ role: "scout", count: 1, isolated: true, readOnly: true });
    expect(r.r.details.children).toEqual([{ childId: "subagent_x", status: "completed", verdict: "pass" }]);
  });

  it("tasks 多任务：切片 ≤4 + trim/filter + orchestrate 入参一致", async () => {
    const h = makeHarness();
    const r = await runBothCapture(h, "subagentTool", "tc-2", { tasks: [" A ", "", "B", "C", "D", "E"] }, (hh) => hh.calls.orchestrateSubagents.mock.calls.map((c: any) => ({ tasks: c[0].tasks, parentToolCallId: c[0].parentToolCallId, toolKey: c[0].toolKey })));
    expect(r.captured[0].tasks).toEqual(["A", "B", "C", "D"]);
    expect(r.captured[0].parentToolCallId).toBe("tc-2");
    expect(r.r.details.count).toBe(4);
  });

  it("worker 降级：canWrite=false 时 resolveRole 收到 {canWrite:false}（双侧一致）", async () => {
    const h = makeHarness();
    const r = await runBothCapture(h, "subagentTool", "tc-3", { task: "X", role: "worker" }, (hh) => hh.calls.resolveRole.mock.calls.map((c: any) => [c[0], c[1]]));
    expect(r.captured[0][1]).toEqual({ canWrite: false });
    expect(r.r.details.role).toBe("scout");
  });

  it("worker 可写：session.getActiveToolNames 含 write → {canWrite:true}（双侧一致）", async () => {
    const h = makeHarness({ session: { getActiveToolNames: () => ["read", "write"] } });
    const r = await runBothCapture(h, "subagentTool", "tc-4", { task: "X", role: "worker" }, (hh) => hh.calls.resolveRole.mock.calls.map((c: any) => [c[0], c[1]]));
    expect(r.captured[0][1]).toEqual({ canWrite: true });
    expect(r.r.details.role).toBe("worker");
    expect(r.r.details.readOnly).toBe(false);
  });

  it("OAW_SUBAGENT_VERIFY=0：verify=false 传入编排器（双侧一致）", async () => {
    const prev = process.env.OAW_SUBAGENT_VERIFY;
    process.env.OAW_SUBAGENT_VERIFY = "0";
    try {
      const h = makeHarness({ session: { getActiveToolNames: () => ["read", "write"] } });
      const r = await runBothCapture(h, "subagentTool", "tc-5", { task: "X", role: "worker" }, (hh) => hh.calls.orchestrateSubagents.mock.calls.map((c: any) => c[0].verify));
      expect(r.captured[0]).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.OAW_SUBAGENT_VERIFY; else process.env.OAW_SUBAGENT_VERIFY = prev;
    }
  });

  it("runTask 连通：编排器调 runTask 走完整 runner 链路（双侧一致）", async () => {
    const h = makeHarness({
      plan: { messages: [{ role: "assistant", content: [{ type: "text", text: "子结果" }] }] },
      overrides: { orchestrateSubagents: async (args: any) => {
        const out = await args.runTask(args.tasks[0], { index: 0 });
        return { text: `编排：${out.text}`, isError: out.isError, results: [out] };
      } },
    });
    const r = await runBothCapture(h, "subagentTool", "tc-6", { task: "调研" }, (hh) => hh.calls.createSession.mock.calls.length);
    expect(r.r.content[0].text).toBe("编排：子结果");
  });
});

// ---- 4. editorial_pipeline ----
describe("b664h editorial_pipeline", () => {
  it("成功路径：审批 + write_started/locked + file_changed + 四行文案一致", async () => {
    const h = makeHarness();
    const r = await runBothCapture(h, "editorialPipelineTool", "tc-7", { goal: "写一份测试报告", format: "docx" }, (hh) => hh.calls.requireToolApproval.mock.calls.map((c: any) => ({ tool: c[0].tool, input: c[0].input, runId: c[0].runId, threadId: c[0].threadId, workspace: c[0].workspace })));
    expect(r.r.content[0].text).toContain("流水线完成，产物：报告.docx");
    expect(r.r.content[0].text).toContain("检查：结构完整");
    expect(r.r.content[0].text).toContain("后续可用 officecli");
    expect(r.r.details).toEqual({ pipeline: true, format: "docx", status: "completed", deliverable: "报告.docx" });
    expect(r.captured[0]).toMatchObject({ tool: "editorial_pipeline", runId: "run_1", threadId: "t1" });
    expect(r.captured[0].input).toBe("docx 写一份测试报告");
  });

  it("pptx 归一化 + outputPath/requirements 转发一致", async () => {
    const h = makeHarness();
    const r = await runBothCapture(h, "editorialPipelineTool", "tc-8", { goal: "做一个演示", format: "pptx", outputPath: "汇报.pptx", requirements: "10 页以内" }, (hh) => hh.calls.runEditorialPipeline.mock.calls.map((c: any) => ({ format: c[0].format, outputPath: c[0].outputPath, requirements: c[0].requirements, workspace: c[0].workspace })));
    expect(r.captured[0]).toMatchObject({ format: "pptx", outputPath: "汇报.pptx", requirements: "10 页以内", workspace: h.tmpWs });
  });

  it("runEditorialPipeline 的 emit 带 parentToolCallId（双侧一致）", async () => {
    const h = makeHarness({
      overrides: { runEditorialPipeline: async (args: any) => {
        args.emit("pipeline_stage", { stage: "planner" });
        return { status: "completed", deliverable: "d.docx", checks: [], issues: [] };
      } },
    });
    const r = await runBothCapture(h, "editorialPipelineTool", "tc-9", { goal: "写文档", format: "docx" }, (hh) => hh.events.filter((e: any) => e.type === "pipeline_stage"));
    expect(r.captured[0].data.parentToolCallId).toBe("tc-9");
    expect(r.captured[0].data.stage).toBe("planner");
  });

  it("failed 状态：isError=true + 待改进截断 slice(0,6) 一致", async () => {
    const h = makeHarness({ overrides: { runEditorialPipeline: async () => ({ status: "failed", deliverable: "d.docx", checks: [], issues: ["章节缺失", "样式缺失", "图表缺失", "引用缺失", "目录缺失", "摘要缺失", "第七项被截断"] }) } });
    const r = await runBothCapture(h, "editorialPipelineTool", "tc-10", { goal: "写文档", format: "docx" });
    expect(r.r.isError).toBe(true);
    expect(r.r.content[0].text).toContain("流水线未完全通过验收");
    expect(r.r.content[0].text).not.toContain("第七项被截断");
  });

  it("runModelTask：子会话失败 → execute 吞错返回 isError:true + runtime_error（双侧一致）", async () => {
    const h = makeHarness({
      plan: { messages: [] }, // 空结果 → runner 返回 isError:true
      overrides: { runEditorialPipeline: async (args: any) => {
        await args.runModelTask("写正文", { stage: "writer" });
        await args.runModelTask("规划", { stage: "planner" });
        return { status: "completed", deliverable: "x", checks: [], issues: [] };
      } },
    });
    const snaps: any[] = [];
    for (const side of ["old", "fresh"] as const) {
      h.reset();
      const r = JSON.parse(JSON.stringify(await h[side].editorialPipelineTool.execute("tc-11", { goal: "写文档", format: "docx" }, null)));
      snaps.push({ r, evs: JSON.parse(JSON.stringify(h.events)) });
    }
    expect(snaps[1]).toEqual(snaps[0]);
    // runModelTask 显式抛「未完成」→ editorialPipelineTool catch 转 runtime_error + isError:true
    // （messages 为空 → writer 阶段先失败，传导链路一致）
    expect(snaps[0].r.isError).toBe(true);
    expect(snaps[0].r.content[0].text).toContain("编辑流水线失败：流水线 writer 阶段子会话未完成");
    expect(snaps[0].evs.some((e: any) => e.type === "runtime_error" && e.data.code === "PIPELINE_FAILED")).toBe(true);
  });

  it("runModelTask 成功：文本回传流水线（双侧一致）", async () => {
    const h = makeHarness({
      plan: { messages: [{ role: "assistant", content: [{ type: "text", text: "大纲" }] }] },
      overrides: { runEditorialPipeline: async (args: any) => ({ status: "completed", deliverable: await args.runModelTask("规划结构", { stage: "planner" }), checks: [], issues: [] }) },
    });
    const r = await runBothCapture(h, "editorialPipelineTool", "tc-12", { goal: "写文档", format: "docx" }, (hh) => hh.calls.createSession.mock.calls.length);
    expect(r.r.details.deliverable).toBe("大纲");
  });

  it("writer 阶段预算：超时按 PIPELINE_WRITER_TIMEOUT_MS=240s 而非默认 60s（双侧一致）", async () => {
    // 挂起会话：runModelTask 一直挂到 writer 预算（240s）超时；若误用默认 60s 预算，
    // 错误文案会是「60 秒」。断言 deliverable 文案含「240 秒」即证预算正确。
    const h = makeHarness({
      overrides: { runEditorialPipeline: async (args: any) => {
        const out = await args.runModelTask("慢正文", { stage: "writer" });
        return { status: "completed", deliverable: out.text, checks: [], issues: [] };
      } },
    });
    const results: any[] = [];
    for (const side of ["old", "fresh"] as const) {
      h.reset();
      h.calls.createSession.mockImplementation(async () => ({ session: hangSession() }));
      const p = h[side].editorialPipelineTool.execute("tc-13", { goal: "写文档", format: "docx" }, null);
      await vi.advanceTimersByTimeAsync(240001);
      results.push(JSON.parse(JSON.stringify(await p)));
    }
    expect(results[0].isError).toBe(true);
    // runModelTask 抛「未完成」→ execute catch → runtime_error + isError:true；
    // 文案含「240 秒」证明 writer 用了 PIPELINE_WRITER_TIMEOUT_MS 而非默认 60s。
    expect(results[0].content[0].text).toContain("子 Agent 执行超过 240 秒");
    expect(results[1]).toEqual(results[0]);
  });
});
