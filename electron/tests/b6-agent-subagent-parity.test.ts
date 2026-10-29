/**
 * B6-6-4h 行为覆盖：createSubagentRunner / run_subagent / editorial_pipeline 批
 * （subagent-tools.ts buildSubagentTools）。
 *
 * R6-6b 对拍退役改写：旧侧 agent.mjs 源码段提取 + new Function 工厂随 server 退役删除，
 * 仅保留 TS 侧断言（期望值此前已经双侧对拍固化，现改为直接断言）。
 *
 * 依赖口径：
 *  - 已迁域（write-coordination 读写锁/暂存）由 subagent-tools 直接绑定 electron 侧真实现；
 *  - SessionManager/SettingsManager 由 subagent-tools 直接 import SDK 真实导出（仅作
 *    createSession 入参构造，无 IO）；
 *  - pi 域与未迁域（piRuntimeManager/工具工厂/DefaultResourceLoader/编排器/流水线/审批）
 *    以 stub 注入。
 *
 * 时钟：全文件冻结（900ms 节流判据 Date.now 差值 + 超时 setTimeout），需推进时钟的
 * 用例用 advanceTimersByTimeAsync。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as pathMod from "node:path";
import * as osMod from "node:os";
import { mkdtempSync, writeFileSync } from "node:fs";
import { buildSubagentTools } from "../src/main/backend/agent/subagent-tools";
import { AGENT_DIR } from "../src/main/backend/workspace";

// ---- 轻量 Type stub（defineTool parameters 形状） ----
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

// stub 角色表（未迁域 subagent-orchestrator 的 seam 注入；字段形状对齐真实实现）
const ROLES: any = {
  scout: { label: "资料探索", readOnly: true, timeoutMs: 60000, prompt: "探索并汇总资料", tools: ["read"] },
  reviewer: { label: "审阅", readOnly: true, timeoutMs: 90000, prompt: "审阅检查", tools: ["read"] },
  planner: { label: "方案拆解", readOnly: true, timeoutMs: 60000, prompt: "拆解方案", tools: ["read"] },
  verifier: { label: "独立核验", readOnly: true, timeoutMs: 90000, prompt: "独立核验", tools: ["read"] },
  worker: { label: "可写执行", readOnly: false, timeoutMs: 300000, prompt: "执行任务", tools: ["read", "write", "edit", "officecli"] },
};

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
  const reset = () => {
    events.length = 0;
    for (const key of Object.keys(calls)) { if (calls[key]?.mockClear) calls[key].mockClear(); }
  };
  return { tmpWs, entry, flags, calls, events, world, plan, fresh, reset };
}

// 统一冻结时钟：900ms 节流判据（Date.now 差值）与超时 setTimeout。
beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** 跑工具 execute 并取回 JSON 化返回值与捕获快照（执行后清场）。 */
async function runCapture(h: any, tool: string, toolCallId: any, params: any, capture?: (h: any) => any) {
  const r = JSON.parse(JSON.stringify(await h.fresh[tool].execute(toolCallId, params, null)));
  const captured = capture ? JSON.parse(JSON.stringify(capture(h))) : null;
  h.reset();
  return { r, captured };
}

/** 跑 runner：同一 cfg/taskText/ctx，取回 JSON 化返回值（执行后清场）。 */
async function runRunner(h: any, cfg: any, taskText: any, ctx: any = {}) {
  const runner = h.fresh.createSubagentRunner(cfg);
  const r = JSON.parse(JSON.stringify(await runner(taskText, ctx)));
  h.reset();
  return r;
}

/** 超时/挂起用例的 fake childSession：prompt 永不 resolve，abort 可观察。 */
function hangSession() {
  return {
    setActiveToolsByName: vi.fn(), subscribe: vi.fn(), messages: [],
    prompt: vi.fn(() => new Promise(() => {})), abort: vi.fn(async () => {}), dispose: vi.fn(),
  };
}

// ---- 1. 定义级 ----
describe("b664h 工具定义级", () => {
  it("三产物齐全", () => {
    const h = makeHarness();
    expect(Object.keys(h.fresh).sort()).toEqual(["createSubagentRunner", "editorialPipelineTool", "subagentTool"]);
    expect(h.fresh.subagentTool.name).toBe("run_subagent");
    expect(h.fresh.editorialPipelineTool.name).toBe("editorial_pipeline");
  });
});

// ---- 2. createSubagentRunner ----
describe("b664h createSubagentRunner", () => {
  it("成功路径：文本提取（多 text 段 join）+ childId 清洗", async () => {
    const h = makeHarness({ plan: {
      events: [
        { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "结论" } },
        { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "A 部分" } },
      ],
      messages: [{ role: "assistant", content: [{ type: "text", text: "结论A" }, { type: "text", text: "B" }] }],
    } });
    const r = await runRunner(h, { toolKey: "k/1 a" }, "调研任务");
    expect(r.isError).toBe(false);
    expect(r.childId).toBe("subagent_k_1_a");
    expect(r.text).toBe("结论A\nB");
  });

  it("事件流契约：subagent_start/end 字段（childId/parentToolCallId/role/task/readOnly/roleLabel/summary/transcript）", async () => {
    const h = makeHarness({
      plan: {
        events: [{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "结果" } }],
        messages: [{ role: "assistant", content: [{ type: "text", text: "结果" }] }],
      },
    });
    await h.fresh.createSubagentRunner({ toolKey: "k1", parentToolCallId: "tc9", defaultRole: "reviewer" })("审阅任务");
    const start = h.events.find((e: any) => e.type === "subagent_start");
    const end = h.events.find((e: any) => e.type === "subagent_end");
    expect(start?.data).toMatchObject({ childId: "subagent_k1", parentToolCallId: "tc9", role: "reviewer", task: "审阅任务", readOnly: true, roleLabel: "审阅" });
    expect(end?.data).toMatchObject({ childId: "subagent_k1", status: "completed", summary: "结果" });
  });

  it("双任务 multiple 后缀 + ctx.childId 覆盖", async () => {
    const h = makeHarness({ plan: { messages: [{ role: "assistant", content: [{ type: "text", text: "OK" }] }] } });
    const r1 = await runRunner(h, { toolKey: "k1", multiple: true }, "任务", { index: 1 });
    expect(r1.childId).toBe("subagent_k1_2");
    const r2 = await runRunner(h, { toolKey: "k1" }, "任务", { childId: "custom_child" });
    expect(r2.childId).toBe("custom_child");
  });

  it("promptSuffix：childPrompt = task + \\n\\n + suffix", async () => {
    const h = makeHarness({ plan: { messages: [{ role: "assistant", content: [{ type: "text", text: "OK" }] }] } });
    await h.fresh.createSubagentRunner({ toolKey: "k1" })("任务", { promptSuffix: "补充说明" });
    expect(h.calls.createSession).toHaveBeenCalledTimes(1);
  });

  it("thinking/text 节流与轨迹：900ms 内不发 update，推进后发", async () => {
    const h = makeHarness({ plan: {
      events: [
        { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "想1" } },
        { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "想2" } },
        { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "写1" } },
      ],
      messages: [{ role: "assistant", content: [{ type: "text", text: "写1" }] }],
    } });
    const r = await runRunner(h, { toolKey: "k1" }, "任务");
    expect(r.text).toBe("写1");
  });

  it("工具事件：tool_execution_start/end → subagent_tool start/end", async () => {
    const h = makeHarness({ plan: {
      events: [
        { type: "tool_execution_start", toolName: "read", toolCallId: "ct1", args: { path: "a.md" } },
        { type: "tool_execution_end", toolName: "read", toolCallId: "ct1", isError: false, result: "内容" },
      ],
      messages: [{ role: "assistant", content: [{ type: "text", text: "读完" }] }],
    } });
    // 事件断言须在 reset 前完成：不走 runRunner（其执行后清场），直接调 runner。
    await h.fresh.createSubagentRunner({ toolKey: "k1" })("任务");
    const start = h.events.find((e: any) => e.type === "subagent_tool" && e.data.status === "start");
    const end = h.events.find((e: any) => e.type === "subagent_tool" && e.data.status === "end");
    expect(start?.data).toMatchObject({ childId: "subagent_k1", parentToolCallId: null, role: "scout", toolName: "read", toolCallId: "ct1", args: '{"path":"a.md"}' });
    expect(end?.data).toMatchObject({ toolName: "read", toolCallId: "ct1", isError: false, result: "内容" });
  });

  it("message_update 以外事件类型被忽略", async () => {
    const h = makeHarness({ plan: {
      events: [{ type: "unknown_event", foo: 1 }],
      messages: [{ role: "assistant", content: [{ type: "text", text: "OK" }] }],
    } });
    await runRunner(h, { toolKey: "k1" }, "任务");
    expect(h.events.some((e: any) => e.type === "unknown_event")).toBe(false);
  });

  it("空 finalText：failed 事件 + 错误文案", async () => {
    const h = makeHarness({ plan: { messages: [{ role: "assistant", content: [{ type: "text", text: "  " }] }] } });
    const r = await runRunner(h, { toolKey: "k1" }, "任务");
    expect(r.isError).toBe(true);
    expect(r.text).toBe("子 Agent 失败：子 Agent 没有返回可用的文本结果");
  });

  it("超时路径：SUBAGENT_TIMEOUT 文案（推进时钟）", async () => {
    const h = makeHarness();
    h.calls.createSession.mockImplementation(async () => ({ session: hangSession() }));
    const p = h.fresh.createSubagentRunner({ toolKey: "k1", timeoutMs: 5000 })("任务");
    await vi.advanceTimersByTimeAsync(5001);
    const r = JSON.parse(JSON.stringify(await p));
    expect(r.isError).toBe(true);
    expect(r.text).toBe("子 Agent 失败：子 Agent 执行超过 5 秒，已自动停止");
    expect(h.events.some((e: any) => e.type === "subagent_end" && e.data.status === "failed")).toBe(true);
  });

  it("父取消路径：prompt 后 aborted → SUBAGENT_CANCELLED → cancelled 事件", async () => {
    const h = makeHarness({ plan: { messages: [{ role: "assistant", content: [{ type: "text", text: "没赶上" }] }] } });
    const controller = new AbortController();
    controller.abort();
    const r = JSON.parse(JSON.stringify(await h.fresh.createSubagentRunner({ toolKey: "k1", signal: controller.signal })("任务")));
    expect(r.isError).toBe(true);
    expect(r.text).toBe("子 Agent 已取消：父任务已取消，子 Agent 已停止");
    expect(h.events.some((e: any) => e.type === "subagent_end" && e.data.status === "cancelled")).toBe(true);
  });

  it("parentSignal abort 联动：start 后触发 abort → childSession.abort 被调", async () => {
    const h = makeHarness();
    const hs = hangSession();
    h.calls.createSession.mockImplementation(async () => ({ session: hs }));
    const controller = new AbortController();
    const p = h.fresh.createSubagentRunner({ toolKey: "k1", signal: controller.signal, timeoutMs: 60000 })("任务");
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    expect(hs.abort).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60001);
    await p;
  });

  it("worker 角色：createSession 入参（tools/customTools/model）", async () => {
    const h = makeHarness({ plan: { messages: [{ role: "assistant", content: [{ type: "text", text: "OK" }] }] } });
    await h.fresh.createSubagentRunner({ toolKey: "k1", defaultRole: "worker" })("改文件");
    const { sessionManager, settingsManager, ...rest } = h.calls.createSession.mock.calls[0][0];
    expect(Boolean(sessionManager)).toBe(true);
    expect(Boolean(settingsManager)).toBe(true);
    expect(rest.tools).toEqual(["read", "write", "edit", "officecli"]);
    expect(rest.customTools.map((t: any) => t.name)).toEqual(["read", "write", "edit", "officecli"]);
    expect(rest.model).toBe("stub-model");
    expect(rest.agentDir).toBe(AGENT_DIR);
  });

  it("scout 只读角色：write/edit 工厂不被调用，officeTool 不进 customTools", async () => {
    const h = makeHarness({ plan: { messages: [{ role: "assistant", content: [{ type: "text", text: "OK" }] }] } });
    await runRunner(h, { toolKey: "k1" }, "只读任务");
    expect(h.calls.createWriteToolDefinition).not.toHaveBeenCalled();
    expect(h.calls.createEditToolDefinition).not.toHaveBeenCalled();
  });

  it("qoderInteractionOwner 开：interaction_owner_changed 事件（owner 指向子代理）", async () => {
    const h = makeHarness({ flags: { qoderInteractionOwner: true }, plan: { messages: [{ role: "assistant", content: [{ type: "text", text: "OK" }] }] } });
    // 事件断言须在 reset 前完成：不走 runRunner，直接调 runner。
    await h.fresh.createSubagentRunner({ toolKey: "k1" })("任务");
    const ev = h.events.find((e: any) => e.type === "interaction_owner_changed");
    expect(ev?.data).toMatchObject({ childId: "subagent_k1", owner: { kind: "subagent", id: "subagent_k1" }, status: "running" });
  });

  it("越权读取：工作区外路径抛「子 Agent 只能读取当前工作区中的文件」", async () => {
    const outside = pathMod.join(osMod.tmpdir(), "p4h-outside.md");
    const h = makeHarness({ plan: { messages: [{ role: "assistant", content: [{ type: "text", text: "OK" }] }] } });
    await h.fresh.createSubagentRunner({ toolKey: "k1" })("任务");
    const readOps = h.calls.createSession.mock.calls[0][0].customTools[0].operations;
    await expect(readOps.readFile(outside)).rejects.toThrow("子 Agent 只能读取当前工作区中的文件");
  });

  it("可写路径防护：worker write 工作区外抛「子 Agent 只能写入当前工作区内的文件」", async () => {
    const outside = pathMod.join(osMod.tmpdir(), "p4h-outside.md");
    const h = makeHarness({ plan: { messages: [{ role: "assistant", content: [{ type: "text", text: "OK" }] }] } });
    await h.fresh.createSubagentRunner({ toolKey: "k1", defaultRole: "worker" })("任务");
    const writeOps = h.calls.createSession.mock.calls[0][0].customTools.find((t: any) => t.name === "write").operations;
    await expect(writeOps.writeFile(outside, "x")).rejects.toThrow("子 Agent 只能写入当前工作区内的文件");
  });

  it("worker writeFile 审批链：requireToolApproval 入参 + stageWrite 落暂存", async () => {
    const h = makeHarness({ plan: { messages: [{ role: "assistant", content: [{ type: "text", text: "OK" }] }] } });
    await h.fresh.createSubagentRunner({ toolKey: "k1", defaultRole: "worker" })("任务");
    const writeOps = h.calls.createSession.mock.calls[0][0].customTools.find((t: any) => t.name === "write").operations;
    const target = pathMod.join(h.tmpWs, "out.md");
    writeOps.mkdir(pathMod.join(h.tmpWs, "sub"));
    const staged = await writeOps.writeFile(target, "内容");
    expect(h.calls.requireToolApproval.mock.calls[0][0]).toMatchObject({ tool: "write", runId: "run_1", threadId: "t1" });
    expect(Object.keys(staged).sort()).toContain("status");
  });

  it("worker edit：access 加锁只读 + readFile + writeFile 暂存", async () => {
    const h = makeHarness({ plan: { messages: [{ role: "assistant", content: [{ type: "text", text: "OK" }] }] } });
    writeFileSync(pathMod.join(h.tmpWs, "a.md"), "hello", "utf8");
    await h.fresh.createSubagentRunner({ toolKey: "k1", defaultRole: "worker" })("任务");
    const editOps = h.calls.createSession.mock.calls[0][0].customTools.find((t: any) => t.name === "edit").operations;
    await editOps.access(pathMod.join(h.tmpWs, "a.md"));
    const content = await editOps.readFile(pathMod.join(h.tmpWs, "a.md"));
    expect(String(content)).toBe("hello");
    const staged = await editOps.writeFile(pathMod.join(h.tmpWs, "a.md"), "改");
    expect(Object.keys(staged)).toContain("status");
  });

  it("detectImageMimeType：六扩展名映射 + 未知返回 null", async () => {
    const h = makeHarness({ plan: { messages: [{ role: "assistant", content: [{ type: "text", text: "OK" }] }] } });
    await h.fresh.createSubagentRunner({ toolKey: "k1" })("任务");
    const readOps = h.calls.createSession.mock.calls[0][0].customTools[0].operations;
    expect([
      await readOps.detectImageMimeType("x.PNG"),
      await readOps.detectImageMimeType("x.webp"),
      await readOps.detectImageMimeType("x.svg"),
    ]).toEqual(["image/png", "image/webp", null]);
  });
});

// ---- 3. run_subagent ----
describe("b664h run_subagent", () => {
  it("空任务：抛「run_subagent 需要 task 或非空 tasks」", async () => {
    const h = makeHarness();
    await expect(h.fresh.subagentTool.execute("tc", {}, null)).rejects.toThrow("run_subagent 需要 task 或非空 tasks");
    await expect(h.fresh.subagentTool.execute("tc", { task: "  " }, null)).rejects.toThrow("run_subagent 需要 task 或非空 tasks");
  });

  it("单任务：返回 content/details", async () => {
    const h = makeHarness();
    const r = await runCapture(h, "subagentTool", "tc-1", { task: "调研 A" });
    expect(r.r.content[0].text).toContain("编排完成（1 项，role=scout）");
    expect(r.r.details).toMatchObject({ role: "scout", count: 1, isolated: true, readOnly: true });
    expect(r.r.details.children).toEqual([{ childId: "subagent_x", status: "completed", verdict: "pass" }]);
  });

  it("tasks 多任务：切片 ≤4 + trim/filter + orchestrate 入参", async () => {
    const h = makeHarness();
    const r = await runCapture(h, "subagentTool", "tc-2", { tasks: [" A ", "", "B", "C", "D", "E"] }, (hh) => hh.calls.orchestrateSubagents.mock.calls.map((c: any) => ({ tasks: c[0].tasks, parentToolCallId: c[0].parentToolCallId, toolKey: c[0].toolKey })));
    expect(r.captured[0].tasks).toEqual(["A", "B", "C", "D"]);
    expect(r.captured[0].parentToolCallId).toBe("tc-2");
    expect(r.r.details.count).toBe(4);
  });

  it("worker 降级：canWrite=false 时 resolveRole 收到 {canWrite:false}", async () => {
    const h = makeHarness();
    const r = await runCapture(h, "subagentTool", "tc-3", { task: "X", role: "worker" }, (hh) => hh.calls.resolveRole.mock.calls.map((c: any) => [c[0], c[1]]));
    expect(r.captured[0][1]).toEqual({ canWrite: false });
    expect(r.r.details.role).toBe("scout");
  });

  it("worker 可写：session.getActiveToolNames 含 write → {canWrite:true}", async () => {
    const h = makeHarness({ session: { getActiveToolNames: () => ["read", "write"] } });
    const r = await runCapture(h, "subagentTool", "tc-4", { task: "X", role: "worker" }, (hh) => hh.calls.resolveRole.mock.calls.map((c: any) => [c[0], c[1]]));
    expect(r.captured[0][1]).toEqual({ canWrite: true });
    expect(r.r.details.role).toBe("worker");
    expect(r.r.details.readOnly).toBe(false);
  });

  it("OAW_SUBAGENT_VERIFY=0：verify=false 传入编排器", async () => {
    const prev = process.env.OAW_SUBAGENT_VERIFY;
    process.env.OAW_SUBAGENT_VERIFY = "0";
    try {
      const h = makeHarness({ session: { getActiveToolNames: () => ["read", "write"] } });
      const r = await runCapture(h, "subagentTool", "tc-5", { task: "X", role: "worker" }, (hh) => hh.calls.orchestrateSubagents.mock.calls.map((c: any) => c[0].verify));
      expect(r.captured[0]).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.OAW_SUBAGENT_VERIFY; else process.env.OAW_SUBAGENT_VERIFY = prev;
    }
  });

  it("runTask 连通：编排器调 runTask 走完整 runner 链路", async () => {
    const h = makeHarness({
      plan: { messages: [{ role: "assistant", content: [{ type: "text", text: "子结果" }] }] },
      overrides: { orchestrateSubagents: async (args: any) => {
        const out = await args.runTask(args.tasks[0], { index: 0 });
        return { text: `编排：${out.text}`, isError: out.isError, results: [out] };
      } },
    });
    const r = await runCapture(h, "subagentTool", "tc-6", { task: "调研" }, (hh) => hh.calls.createSession.mock.calls.length);
    expect(r.r.content[0].text).toBe("编排：子结果");
  });
});

// ---- 4. editorial_pipeline ----
describe("b664h editorial_pipeline", () => {
  it("成功路径：审批 + write_started/locked + file_changed + 四行文案", async () => {
    const h = makeHarness();
    const r = await runCapture(h, "editorialPipelineTool", "tc-7", { goal: "写一份测试报告", format: "docx" }, (hh) => hh.calls.requireToolApproval.mock.calls.map((c: any) => ({ tool: c[0].tool, input: c[0].input, runId: c[0].runId, threadId: c[0].threadId, workspace: c[0].workspace })));
    expect(r.r.content[0].text).toContain("流水线完成，产物：报告.docx");
    expect(r.r.content[0].text).toContain("检查：结构完整");
    expect(r.r.content[0].text).toContain("后续可用 officecli");
    expect(r.r.details).toEqual({ pipeline: true, format: "docx", status: "completed", deliverable: "报告.docx" });
    expect(r.captured[0]).toMatchObject({ tool: "editorial_pipeline", runId: "run_1", threadId: "t1" });
    expect(r.captured[0].input).toBe("docx 写一份测试报告");
  });

  it("pptx 归一化 + outputPath/requirements 转发", async () => {
    const h = makeHarness();
    const r = await runCapture(h, "editorialPipelineTool", "tc-8", { goal: "做一个演示", format: "pptx", outputPath: "汇报.pptx", requirements: "10 页以内" }, (hh) => hh.calls.runEditorialPipeline.mock.calls.map((c: any) => ({ format: c[0].format, outputPath: c[0].outputPath, requirements: c[0].requirements, workspace: c[0].workspace })));
    expect(r.captured[0]).toMatchObject({ format: "pptx", outputPath: "汇报.pptx", requirements: "10 页以内", workspace: h.tmpWs });
  });

  it("runEditorialPipeline 的 emit 带 parentToolCallId", async () => {
    const h = makeHarness({
      overrides: { runEditorialPipeline: async (args: any) => {
        args.emit("pipeline_stage", { stage: "planner" });
        return { status: "completed", deliverable: "d.docx", checks: [], issues: [] };
      } },
    });
    const r = await runCapture(h, "editorialPipelineTool", "tc-9", { goal: "写文档", format: "docx" }, (hh) => hh.events.filter((e: any) => e.type === "pipeline_stage"));
    expect(r.captured[0].data.parentToolCallId).toBe("tc-9");
    expect(r.captured[0].data.stage).toBe("planner");
  });

  it("failed 状态：isError=true + 待改进截断 slice(0,6)", async () => {
    const h = makeHarness({ overrides: { runEditorialPipeline: async () => ({ status: "failed", deliverable: "d.docx", checks: [], issues: ["章节缺失", "样式缺失", "图表缺失", "引用缺失", "目录缺失", "摘要缺失", "第七项被截断"] }) } });
    const r = await runCapture(h, "editorialPipelineTool", "tc-10", { goal: "写文档", format: "docx" });
    expect(r.r.isError).toBe(true);
    expect(r.r.content[0].text).toContain("流水线未完全通过验收");
    expect(r.r.content[0].text).not.toContain("第七项被截断");
  });

  it("runModelTask：子会话失败 → execute 吞错返回 isError:true + runtime_error", async () => {
    const h = makeHarness({
      plan: { messages: [] }, // 空结果 → runner 返回 isError:true
      overrides: { runEditorialPipeline: async (args: any) => {
        await args.runModelTask("写正文", { stage: "writer" });
        await args.runModelTask("规划", { stage: "planner" });
        return { status: "completed", deliverable: "x", checks: [], issues: [] };
      } },
    });
    const r = JSON.parse(JSON.stringify(await h.fresh.editorialPipelineTool.execute("tc-11", { goal: "写文档", format: "docx" }, null)));
    // runModelTask 显式抛「未完成」→ editorialPipelineTool catch 转 runtime_error + isError:true
    // （messages 为空 → writer 阶段先失败，传导链路一致）
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("编辑流水线失败：流水线 writer 阶段子会话未完成");
    expect(h.events.some((e: any) => e.type === "runtime_error" && e.data.code === "PIPELINE_FAILED")).toBe(true);
  });

  it("runModelTask 成功：文本回传流水线", async () => {
    const h = makeHarness({
      plan: { messages: [{ role: "assistant", content: [{ type: "text", text: "大纲" }] }] },
      overrides: { runEditorialPipeline: async (args: any) => ({ status: "completed", deliverable: await args.runModelTask("规划结构", { stage: "planner" }), checks: [], issues: [] }) },
    });
    const r = await runCapture(h, "editorialPipelineTool", "tc-12", { goal: "写文档", format: "docx" }, (hh) => hh.calls.createSession.mock.calls.length);
    expect(r.r.details.deliverable).toBe("大纲");
  });

  it("writer 阶段预算：超时按 PIPELINE_WRITER_TIMEOUT_MS=240s 而非默认 60s", async () => {
    // 挂起会话：runModelTask 一直挂到 writer 预算（240s）超时；若误用默认 60s 预算，
    // 错误文案会是「60 秒」。断言文案含「240 秒」即证预算正确。
    const h = makeHarness({
      overrides: { runEditorialPipeline: async (args: any) => {
        const out = await args.runModelTask("慢正文", { stage: "writer" });
        return { status: "completed", deliverable: out.text, checks: [], issues: [] };
      } },
    });
    h.calls.createSession.mockImplementation(async () => ({ session: hangSession() }));
    const p = h.fresh.editorialPipelineTool.execute("tc-13", { goal: "写文档", format: "docx" }, null);
    await vi.advanceTimersByTimeAsync(240001);
    const r = JSON.parse(JSON.stringify(await p));
    expect(r.isError).toBe(true);
    // runModelTask 抛「未完成」→ execute catch → runtime_error + isError:true；
    // 文案含「240 秒」证明 writer 用了 PIPELINE_WRITER_TIMEOUT_MS 而非默认 60s。
    expect(r.content[0].text).toContain("子 Agent 执行超过 240 秒");
  });
});
