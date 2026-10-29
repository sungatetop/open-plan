/**
 * S3-3 prompt 主链直调对拍（agent-prompt-direct.ts 编排层）。
 *
 * 覆盖面（行号锚点均指 server/index.mjs）：
 *   - manifest 锚点：10 条通道（prompt/abort/answer/compact/new/resume/session-tree/
 *     session-branch + runs resume/retry）全部在 DESKTOP_CHANNELS 且路由指向已审计路径；
 *   - op:agent:prompt（L4194-4503）：400 形参 / 写探针失败状态映射 / ensureRuntime 500
 *     （诊断落盘）/ SESSION_FROZEN 409 / setModel 同模型跳过与失败 409 / SKILL_PREFLIGHT
 *     409（@技能 提及）/ OFFICE preferred·lazy 双路由 / chat 成功（admission 13 字段 +
 *     事件序列 + appendEvent 排除集 + 后台收尾）/ steering 复用 Run / chat+附件快照
 *     与 stageWrite / 用户中断 aborted / 后台失败 agent_error+runtime_error+run_finished；
 *   - abort（L3899-3921）/ compact（L3924-3932）/ answer（L3994-4000）/ new（L4674-4685）/
 *     resume（L4687-4708）/ session-tree（L3952-3961）/ session-branch（L3965-3977）逐通道；
 *   - runs resume/retry（L4657-4672）：404 / actions 409 / 状态守卫 500 / busy 500 /
 *     SKILL_PREFLIGHT 409 / 成功（continuation 文案 + recoveryChain + 后台收尾）；
 *   - dispatcher（unknown channel 404 / 意外错误 500）。
 *
 * 纯编排测试：deps 全注入桩（域行为断言见 s3-prompt-domain 相关批次测试；
 * runs/write-coordination 等见各批次既有测试）。后台 executeAgentRun/executeContinuation 的 waitForFlush 首轮
 * 固定 1.5s（L5818-5827 同构），相关断言用 vi.waitFor 轮询。
 */
import { describe, expect, test, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type * as PromptDirectModule from "../src/main/ipc/agent-prompt-direct";
import { DESKTOP_CHANNELS, type InvokeEnvelope } from "../src/shared/protocol/channels";

type Svc = typeof PromptDirectModule;
let svc: Svc;
let tmp = "";
const WS = "D:\\fake-workspace";

beforeAll(async () => {
  svc = await import("../src/main/ipc/agent-prompt-direct");
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "s3prompt-"));
});

afterAll(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

function makeEntry(overrides: Record<string, unknown> = {}) {
  const emitter = new EventEmitter();
  const events: Array<Record<string, any>> = [];
  emitter.on("event", (ev) => events.push(ev));
  return {
    clientId: "clientA",
    threadId: "threadB",
    sessionId: "sess1",
    session: { sessionId: "sess1", model: null as unknown },
    workspace: WS,
    busy: false,
    compacting: false,
    activeRunId: null as string | null,
    queuedCount: 1,
    lastFinalText: "",
    cancelRequested: false,
    abortRequestedAt: 0,
    modelFallbackSpec: undefined as unknown,
    modelFallbackFrom: null as unknown,
    reviewSources: [] as unknown[],
    pendingCompletion: null as unknown,
    channel: { seq: 0, streamId: "stream-1", history: [] as unknown[], historyLimit: null as number | null, emitter },
    events,
    ...overrides
  };
}

type ManagerOverrides = Partial<Record<string, ReturnType<typeof vi.fn>>>;

function makeManager(entry: Record<string, any>, overrides: ManagerOverrides = {}) {
  return {
    sessions: new Map(),
    ensureRuntime: vi.fn(async () => entry),
    setModel: vi.fn(async () => ({})),
    runtimeSnapshot: vi.fn(() => null),
    runtimeHealth: vi.fn(() => ({ status: "ready" })),
    promptWithContext: vi.fn(async () => {}),
    resolveLiveEntry: vi.fn(() => null),
    abort: vi.fn(async () => ({ ok: true })),
    compact: vi.fn(async () => ({ ok: true, compacted: true })),
    submitAnswer: vi.fn(() => ({ ok: true })),
    newThread: vi.fn(async () => ({ sessionId: "sess-new" })),
    resumeThread: vi.fn(async () => entry),
    getOrCreate: vi.fn(async () => entry),
    sessionTree: vi.fn(async () => ({ entries: [] })),
    branchSession: vi.fn(async () => ({ ok: true, branched: true })),
    ...overrides
  };
}

type DepOverrides = Partial<Record<string, unknown>>;

function makeDeps(manager: Record<string, any>, overrides: DepOverrides = {}) {
  let runSeq = 0;
  const deps = {
    getManager: vi.fn(async () => manager),
    agentKeyOf: vi.fn((client: unknown, thread: unknown) => `${String(client)}::${String(thread ?? "")}`),
    getWorkspace: vi.fn(() => WS),
    normalizeWorkspace: vi.fn((dir: unknown) => (dir ? String(dir) : null)),
    safeName: vi.fn((name: unknown) => {
      const s = typeof name === "string" ? name : "";
      return s && !/[\\/:*?"<>|]/.test(s) ? s : null;
    }),
    getProjectForWorkspace: vi.fn(() => null),
    getProject: vi.fn(() => null),
    defaultProjectSettings: vi.fn(() => ({})),
    findSessionFile: vi.fn(() => null),
    readSessionHeader: vi.fn(() => ({}) as Record<string, unknown>),
    updateSessionHeader: vi.fn(),
    annotateSessionThread: vi.fn(),
    scanSkills: vi.fn(() => [] as unknown[]),
    preflightSkills: vi.fn(() => ({ ok: true, workflow: null, required: [], checks: [], missing: [], message: "Skills 预检通过" })),
    resolveReferences: vi.fn(() => [] as unknown[]),
    requireWorkspaceWriteForTask: vi.fn(() => null),
    checkOfficecli: vi.fn(async () => ({ available: true, message: "ok" })),
    beginRun: vi.fn((input: Record<string, unknown>) => ({ id: `r${++runSeq}`, ...input })),
    getRun: vi.fn(() => null),
    listRuns: vi.fn(() => [] as unknown[]),
    finishRun: vi.fn((id: string, patch: Record<string, unknown>) => ({ id, status: patch.status, artifacts: [], verificationStatus: "not_checked", completion: patch.completion })),
    requestRunCancellation: vi.fn(),
    recordRunEvent: vi.fn(),
    snapshotWorkspace: vi.fn(() => [] as string[]),
    filterRunChanges: vi.fn((_run: unknown, changes: unknown) => changes),
    validateArtifacts: vi.fn(() => [] as unknown[]),
    validateArtifactFile: vi.fn(() => ({ path: "staged.txt", status: "passed" })),
    listStagedFilesForValidation: vi.fn(() => [] as unknown[]),
    stageWrite: vi.fn(),
    stagedRunsRoot: vi.fn(() => path.join(tmp, "runs-root")),
    appendEvent: vi.fn(),
    diagnosticLogPath: vi.fn(() => path.join(tmp, "diag.log")),
    ...overrides
  };
  return deps as unknown as PromptDirectModule.AgentPromptDirectDeps;
}

function invoke(channel: PromptDirectModule.AgentPromptDirectChannel, envelope: InvokeEnvelope | undefined, deps: PromptDirectModule.AgentPromptDirectDeps) {
  return svc.invokeAgentPromptDirect(channel, envelope, deps);
}

const chatBody = (extra: Record<string, unknown> = {}): InvokeEnvelope => ({
  body: { client: "clientA", thread: "threadB", text: "你好", task: { mode: "chat" }, ...extra }
});

async function until(fn: () => boolean, timeoutMs = 6000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 60));
  }
}

describe("S3-3 manifest 锚点", () => {
  test("10 条通道全部在 DESKTOP_CHANNELS 且路由指向已审计路径", () => {
    expect(svc.AGENT_PROMPT_DIRECT_CHANNELS).toHaveLength(10);
    const expectedRoutes: Record<string, { method: string; path: string }> = {
      "op:agent:prompt": { method: "POST", path: "/api/agent/prompt" },
      "op:agent:abort": { method: "POST", path: "/api/agent/abort" },
      "op:agent:answer": { method: "POST", path: "/api/agent/answer" },
      "op:agent:compact": { method: "POST", path: "/api/agent/compact" },
      "op:agent:new": { method: "POST", path: "/api/agent/new" },
      "op:agent:resume": { method: "POST", path: "/api/agent/resume" },
      "op:agent:session-tree": { method: "GET", path: "/api/agent/session-tree" },
      "op:agent:session-branch": { method: "POST", path: "/api/agent/session-branch" },
      "op:runs:resume": { method: "POST", path: "/api/runs/:id/resume" },
      "op:runs:retry": { method: "POST", path: "/api/runs/:id/retry" }
    };
    for (const channel of svc.AGENT_PROMPT_DIRECT_CHANNELS) {
      expect(DESKTOP_CHANNELS[channel as keyof typeof DESKTOP_CHANNELS]).toEqual(expectedRoutes[channel]);
    }
  });
});

describe("S3-3 op:agent:prompt 准入分支（server L4194-4503）", () => {
  test("400：缺 client；空 text 且无 images/attachments", async () => {
    const a = await invoke("op:agent:prompt", { body: { client: "", text: "hi" } }, makeDeps(makeManager(makeEntry())));
    expect(a).toEqual({ ok: false, status: 400, data: { error: "text, image, or attachment required" } });
    const b = await invoke("op:agent:prompt", { body: { client: "clientA", text: "  " } }, makeDeps(makeManager(makeEntry())));
    expect(b.status).toBe(400);
  });

  test("写探针失败：错误码经 workspaceWriteHttpStatus 映射（503），body 带 code/writeAccess/requestId", async () => {
    const entry = makeEntry();
    const deps = makeDeps(makeManager(entry), {
      requireWorkspaceWriteForTask: vi.fn(() => {
        const e = new Error("当前服务进程无法写工作区") as Error & { code?: string };
        e.code = "WORKSPACE_WRITE_UNAVAILABLE";
        (e as any).writeAccess = { status: "failed" };
        throw e;
      })
    });
    const result = await invoke("op:agent:prompt", chatBody(), deps);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    expect(result.data).toMatchObject({ error: "当前服务进程无法写工作区", code: "WORKSPACE_WRITE_UNAVAILABLE", writeAccess: { status: "failed" } });
    expect(String((result.data as any).requestId)).toBeTruthy();
  });

  test("写探针抛普通 Error：body code 兜底 WORKSPACE_WRITE_UNAVAILABLE，HTTP 走 dispatcher 默认 500", async () => {
    const deps = makeDeps(makeManager(makeEntry()), {
      requireWorkspaceWriteForTask: vi.fn(() => { throw new Error("探针异常"); })
    });
    const result = await invoke("op:agent:prompt", chatBody(), deps);
    expect(result.status).toBe(500);
    expect((result.data as any).code).toBe("WORKSPACE_WRITE_UNAVAILABLE");
  });

  test("ensureRuntime 失败：500 + retryable，诊断记录落盘（含 requestId/clientId）", async () => {
    const deps = makeDeps(makeManager(makeEntry(), {
      ensureRuntime: vi.fn(async () => { throw new Error("runtime down"); })
    }), { diagnosticLogPath: vi.fn(() => path.join(tmp, "diag-runtime.log")) });
    const result = await invoke("op:agent:prompt", chatBody(), deps);
    expect(result).toMatchObject({ ok: false, status: 500, data: { error: "runtime down", retryable: expect.any(Boolean) } });
    expect(String((result.data as any).requestId)).toBeTruthy();
    const diagLog = path.join(tmp, "diag-runtime.log");
    const lines = fs.readFileSync(diagLog, "utf8").trim().split("\n");
    const record = JSON.parse(String(lines[lines.length - 1]));
    expect(record).toMatchObject({ clientId: "clientA", threadId: "threadB", message: "runtime down" });
  });

  test("SESSION_FROZEN：readSessionHeader.frozen → 409；run_admitting 已先发", async () => {
    const entry = makeEntry();
    const deps = makeDeps(makeManager(entry), { readSessionHeader: vi.fn(() => ({ frozen: true })) });
    const result = await invoke("op:agent:prompt", chatBody(), deps);
    expect(result).toEqual({
      ok: false, status: 409,
      data: { error: "当前会话已冻结，请先解冻后再继续执行", code: "SESSION_FROZEN", sessionId: "sess1" }
    });
    expect(entry.events.map((e) => e.type)).toEqual(["run_admitting"]);
  });

  test("setModel：同模型 spec 跳过；不同模型失败 → 409 模型同步失败", async () => {
    const same = makeEntry({ session: { sessionId: "sess1", model: { provider: "p", id: "q" } } });
    const managerSame = makeManager(same);
    const okResult = await invoke("op:agent:prompt", chatBody({ model: "p/q" }), makeDeps(managerSame));
    expect(okResult.data).toMatchObject({ accepted: true });
    expect(managerSame.setModel).not.toHaveBeenCalled();

    const diff = makeEntry();
    const managerDiff = makeManager(diff, {
      setModel: vi.fn(async () => { throw new Error("provider 401"); })
    });
    const failResult = await invoke("op:agent:prompt", chatBody({ model: "p/q" }), makeDeps(managerDiff));
    expect(failResult).toMatchObject({ ok: false, status: 409, data: { error: "模型同步失败：provider 401" } });
    expect(managerDiff.setModel).toHaveBeenCalledWith("clientA::threadB", "p/q");
  });

  test("SKILL_PREFLIGHT_FAILED：@技能 提及触发预检，预检失败 → 409 + agent_error 事件 + appendEvent", async () => {
    const entry = makeEntry();
    const deps = makeDeps(makeManager(entry), {
      preflightSkills: vi.fn(() => ({ ok: false, workflow: null, required: ["my-skill"], checks: [], missing: ["my-skill"], message: "Skills 预检未通过：my-skill" }))
    });
    const result = await invoke("op:agent:prompt", {
      body: { client: "clientA", thread: "threadB", text: "@技能[my-skill] 帮我处理", task: { mode: "agent" } }
    }, deps);
    expect(result).toMatchObject({
      ok: false, status: 409,
      data: { code: "SKILL_PREFLIGHT_FAILED", preflight: { missing: ["my-skill"] }, requestId: expect.any(String) }
    });
    expect((result.data as any).capabilityPlan).toBeTruthy();
    expect(deps.scanSkills).toHaveBeenCalled();
    const agentError = entry.events.find((e) => e.type === "agent_error");
    expect(agentError?.data).toMatchObject({ code: "SKILL_PREFLIGHT_FAILED", message: "Skills 预检未通过：my-skill" });
    expect(deps.appendEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "agent_error" }));
  });

  test("OFFICE preferred：修改既有 .docx（附件兜底 officeRefExists）且 CLI 不可用 → 409 OFFICE_PREFLIGHT_FAILED", async () => {
    const entry = makeEntry();
    const deps = makeDeps(makeManager(entry), {
      checkOfficecli: vi.fn(async () => ({ available: false, message: "cli 缺失" }))
    });
    const result = await invoke("op:agent:prompt", {
      body: {
        client: "clientA", thread: "threadB", text: "修改文档 内容",
        task: { mode: "agent", currentFile: "方案.docx" },
        attachments: [{ name: "附件.docx", data: Buffer.from("x").toString("base64") }]
      }
    }, deps);
    expect(result).toMatchObject({ ok: false, status: 409, data: { code: "OFFICE_PREFLIGHT_FAILED" } });
    const agentError = entry.events.find((e) => e.type === "agent_error");
    expect(agentError?.data.code).toBe("OFFICE_PREFLIGHT_FAILED");
  });

  test("OFFICE lazy：生成类任务预检延后，capabilityPlan.officecli.deferred=true 且响应不被回填竞态污染", async () => {
    const entry = makeEntry();
    const deps = makeDeps(makeManager(entry), {
      checkOfficecli: vi.fn(() => new Promise(() => {}))
    });
    const result = await invoke("op:agent:prompt", {
      body: { client: "clientA", thread: "threadB", text: "生成 ppt 汇报", task: { mode: "agent" } }
    }, deps);
    expect(result.ok).toBe(true);
    const task = (result.data as any).task;
    expect(task.capabilityPlan.routing.officecli).toBe("lazy");
    expect(task.capabilityPlan.officecli).toMatchObject({ available: null, deferred: true });
  });
});

describe("S3-3 op:agent:prompt 成功与后台收尾（server L4082-4192 / L5818-5853）", () => {
  test("chat 成功：admission 响应 13 字段 + 事件序列 + appendEvent 排除集 + 后台 finishRun 收尾", async () => {
    const entry = makeEntry();
    const deps = makeDeps(makeManager(entry, {
      promptWithContext: vi.fn(async () => { entry.lastFinalText = "最终回答文本"; })
    }));
    const result = await invoke("op:agent:prompt", chatBody(), deps);
    expect(result).toEqual({
      ok: true, status: 200,
      data: {
        ok: true, accepted: true, queued: false, queuePosition: 1, changed: [],
        runId: "r1", artifacts: [], validations: [], verificationStatus: "pending", status: "accepted",
        task: expect.objectContaining({ mode: "chat", modeLabel: "Chat", goal: "你好" }),
        sessionId: "sess1", model: null, modelFallbackFrom: null, thread: "threadB"
      }
    });
    // admission 阶段断言
    expect(deps.preflightSkills).not.toHaveBeenCalled();
    expect(deps.scanSkills).not.toHaveBeenCalled();
    expect(deps.snapshotWorkspace).not.toHaveBeenCalled();
    expect(deps.beginRun).toHaveBeenCalledWith(expect.objectContaining({
      clientId: "clientA", threadId: "threadB", sessionId: "sess1", cwd: WS,
      snapshotMode: "none", beforeSnapshot: null, model: null
    }));
    expect(deps.recordRunEvent).toHaveBeenCalledWith("r1", "prompt", expect.objectContaining({ text: "你好", steer: false }));
    expect(deps.recordRunEvent).toHaveBeenCalledWith("r1", "capability_plan", expect.objectContaining({ preflight: expect.anything() }));
    // 后台收尾：chat 无快照（snapshotMode none）不经 waitForFlush，立即完成
    await until(() => entry.events.some((e) => e.type === "run_finished"));
    expect(deps.recordRunEvent).toHaveBeenCalledWith("r1", "assistant_final", expect.objectContaining({ text: "最终回答文本" }));
    expect(deps.finishRun).toHaveBeenCalledWith("r1", expect.objectContaining({
      status: "completed", sessionId: "sess1", summary: "本轮对话完成，未检测到文件变更", validations: [], publishPaths: []
    }));
    // 事件序列：run_admitting → capability_plan → run_admitted → agent_summary → run_finished
    expect(entry.events.map((e) => e.type)).toEqual(["run_admitting", "capability_plan", "run_admitted", "agent_summary", "run_finished"]);
    expect(entry.events[0]!.data).toMatchObject({ requestId: expect.any(String) });
    expect(entry.events[1]!.data.runId).toBe("r1");
    const summary = entry.events.find((e) => e.type === "agent_summary");
    expect(summary?.data).toMatchObject({ summary: "本轮对话完成，未检测到文件变更", workspace: WS, runId: "r1", status: "completed" });
    const finished = entry.events.find((e) => e.type === "run_finished");
    expect(finished?.data).toMatchObject({ runId: "r1", status: "completed", workspace: WS, finalText: "" });
    // appendEvent：run_admitting/run_admitted/agent_summary 落根级流；capability_plan/run_finished 排除（已由 recordRunEvent/finishRun 落 Store）
    expect((deps.appendEvent as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].type)).toEqual(["run_admitting", "run_admitted", "agent_summary"]);
  });

  test("steering：busy 会话插话复用当前 Run，不 beginRun、不重打首字、不发 capability_plan/run_admitted", async () => {
    const entry = makeEntry({ busy: true, activeRunId: "r0", queuedCount: 2 });
    const steeringRun = { id: "r0", status: "running", before: [`${WS}\\a.txt|hash1`] };
    const deps = makeDeps(makeManager(entry), { getRun: vi.fn((id: unknown) => (id === "r0" ? steeringRun : null)) });
    const result = await invoke("op:agent:prompt", chatBody({ text: "补充一点" }), deps);
    expect(result.data).toMatchObject({ accepted: true, queued: true, queuePosition: 2, runId: "r0", status: "accepted" });
    expect(deps.beginRun).not.toHaveBeenCalled();
    expect(deps.snapshotWorkspace).not.toHaveBeenCalled();
    expect(deps.recordRunEvent).toHaveBeenCalledWith("r0", "prompt", expect.objectContaining({ text: "补充一点", steer: true }));
    expect(deps.recordRunEvent).toHaveBeenCalledWith("r0", "steer", expect.objectContaining({ source: "user", merged: true }));
    expect(entry.events.map((e) => e.type)).toEqual(["run_admitting"]);
    await until(() => (deps.finishRun as ReturnType<typeof vi.fn>).mock.calls.length > 0);
    expect(deps.finishRun).toHaveBeenCalledWith("r0", expect.objectContaining({ status: "completed" }));
  });

  test("chat + 附件：tracksWorkspace 升级为 full 快照，附件 stageWrite 进暂存区；非法文件名跳过", async () => {
    const entry = makeEntry();
    const deps = makeDeps(makeManager(entry));
    const result = await invoke("op:agent:prompt", chatBody({
      text: "看下这个文件",
      attachments: [
        { name: "表.xlsx", data: Buffer.from("hello").toString("base64") },
        { name: "bad/name.txt", data: Buffer.from("x").toString("base64") }
      ]
    }), deps);
    expect(result.ok).toBe(true);
    expect(deps.snapshotWorkspace).toHaveBeenCalledTimes(1);
    expect(deps.beginRun).toHaveBeenCalledWith(expect.objectContaining({ snapshotMode: "full", beforeSnapshot: [] }));
    expect(deps.stageWrite).toHaveBeenCalledTimes(1);
    expect(deps.stageWrite).toHaveBeenCalledWith(expect.objectContaining({
      runId: "r1", workspace: WS, targetPath: path.join(WS, "表.xlsx"),
      content: Buffer.from("hello"), threadId: "threadB", kind: "attachment", onEvent: expect.any(Function)
    }));
  });

  test("用户中断：promptWithContext 以 abort 形态失败且 entry.cancelRequested → aborted 事件 + cancelled 收尾，无 runtime_error", async () => {
    const entry = makeEntry({ cancelRequested: true });
    const deps = makeDeps(makeManager(entry, {
      promptWithContext: vi.fn(async () => { throw new Error("Request aborted."); })
    }));
    const result = await invoke("op:agent:prompt", chatBody({ task: { mode: "agent" } }), deps);
    expect(result.ok).toBe(true);
    await until(() => entry.events.some((e) => e.type === "aborted"));
    expect(entry.events.map((e) => e.type)).not.toContain("agent_error");
    expect((deps.recordRunEvent as ReturnType<typeof vi.fn>).mock.calls.some((c) => c[1] === "runtime_error")).toBe(false);
    // tracksWorkspace=true 的失败收尾先等 1.5s 刷写窗再 finishRun
    await until(() => (deps.finishRun as ReturnType<typeof vi.fn>).mock.calls.length > 0);
    expect(deps.finishRun).toHaveBeenCalledWith("r1", expect.objectContaining({
      status: "cancelled", error: "用户请求取消", summary: "任务已中断"
    }));
    const finished = entry.events.find((e) => e.type === "run_finished");
    expect(finished?.data).toMatchObject({ runId: "r1", status: "cancelled" });
  });

  test("后台失败：agent_error + runtime_error + failed 收尾 + run_finished，admission 响应已先返回", async () => {
    const entry = makeEntry();
    const deps = makeDeps(makeManager(entry, {
      promptWithContext: vi.fn(async () => { throw new Error("boom provider"); })
    }));
    const result = await invoke("op:agent:prompt", chatBody({ task: { mode: "agent" } }), deps);
    expect(result.data).toMatchObject({ accepted: true, runId: "r1" });
    await until(() => entry.events.some((e) => e.type === "run_finished"));
    const agentError = entry.events.find((e) => e.type === "agent_error");
    expect(agentError?.data).toMatchObject({ message: "boom provider", runId: "r1" });
    expect(deps.recordRunEvent).toHaveBeenCalledWith("r1", "runtime_error", expect.objectContaining({ message: "boom provider", runtime: { status: "ready" } }));
    expect(deps.finishRun).toHaveBeenCalledWith("r1", expect.objectContaining({
      status: "failed", error: "boom provider", summary: "Agent 执行失败"
    }));
    const finished = entry.events.find((e) => e.type === "run_finished");
    expect(finished?.data).toMatchObject({ runId: "r1", status: "failed" });
    expect((deps.appendEvent as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].type)).toContain("agent_error");
  });
});

describe("S3-3 abort/answer/compact/session-tree/session-branch（server L3899-4000）", () => {
  test("abort：400 / live.activeRunId 取消 + stillQueued / listRuns 兜底 / abort 抛错 500", async () => {
    expect(await invoke("op:agent:abort", { body: {} }, makeDeps(makeManager(makeEntry()))))
      .toEqual({ ok: false, status: 400, data: { error: "client required" } });

    const liveEntry = makeEntry({ activeRunId: "r9", queuedCount: 3 });
    const depsLive = makeDeps(makeManager(liveEntry, { resolveLiveEntry: vi.fn(() => liveEntry) }));
    const liveResult = await invoke("op:agent:abort", { body: { client: "clientA", thread: "threadB" } }, depsLive);
    expect(depsLive.requestRunCancellation).toHaveBeenCalledWith("r9", "用户在对话栏请求中断");
    expect(liveResult.data).toMatchObject({ ok: true, runId: "r9", stillQueued: 3 });

    const depsFallback = makeDeps(makeManager(makeEntry()), {
      listRuns: vi.fn(() => [{ id: "r8", status: "running", clientId: "clientA", threadId: null }])
    });
    const fallback = await invoke("op:agent:abort", { body: { client: "clientA", thread: "threadB" } }, depsFallback);
    expect(depsFallback.requestRunCancellation).toHaveBeenCalledWith("r8", "用户在对话栏请求中断");
    expect(fallback.data).toMatchObject({ runId: "r8", stillQueued: 0 });

    const depsFail = makeDeps(makeManager(makeEntry(), {
      resolveLiveEntry: vi.fn(() => makeEntry({ activeRunId: "rx" })),
      abort: vi.fn(async () => { throw new Error("abort failed"); })
    }));
    expect(await invoke("op:agent:abort", { body: { client: "clientA" } }, depsFail))
      .toEqual({ ok: false, status: 500, data: { error: "abort failed" } });
  });

  test("answer：400 / 404 无待答 / 成功透传 / 提交内容截断 2000", async () => {
    expect(await invoke("op:agent:answer", { body: { client: "clientA" } }, makeDeps(makeManager(makeEntry()))))
      .toEqual({ ok: false, status: 400, data: { error: "client and answer required" } });

    const deps404 = makeDeps(makeManager(makeEntry(), { submitAnswer: vi.fn(() => ({ ok: false })) }));
    expect(await invoke("op:agent:answer", { body: { client: "clientA", answer: "x" } }, deps404))
      .toEqual({ ok: false, status: 404, data: { error: "no pending question" } });

    const depsOk = makeDeps(makeManager(makeEntry(), { submitAnswer: vi.fn(() => ({ ok: true, accepted: true })) }));
    expect(await invoke("op:agent:answer", { body: { client: "clientA", answer: "答案" } }, depsOk))
      .toEqual({ ok: true, status: 200, data: { ok: true, accepted: true } });

    const managerLong = makeManager(makeEntry(), { submitAnswer: vi.fn(() => ({ ok: true })) });
    const depsLong = makeDeps(managerLong);
    await invoke("op:agent:answer", { body: { client: "clientA", thread: "threadB", answer: "x".repeat(3000) } }, depsLong);
    expect(managerLong.submitAnswer).toHaveBeenCalledWith("clientA::threadB", "x".repeat(2000));
  });

  test("compact：400 / 成功透传 / 抛错 409", async () => {
    expect(await invoke("op:agent:compact", { body: {} }, makeDeps(makeManager(makeEntry()))))
      .toEqual({ ok: false, status: 400, data: { error: "client required" } });
    expect(await invoke("op:agent:compact", { body: { client: "c", instructions: "压缩" } }, makeDeps(makeManager(makeEntry()))))
      .toEqual({ ok: true, status: 200, data: { ok: true, compacted: true } });
    const depsFail = makeDeps(makeManager(makeEntry(), { compact: vi.fn(async () => { throw new Error("busy"); }) }));
    expect(await invoke("op:agent:compact", { body: { client: "c" } }, depsFail))
      .toEqual({ ok: false, status: 409, data: { error: "busy" } });
  });

  test("session-tree：400 / 成功透传 / 抛错 409", async () => {
    expect(await invoke("op:agent:session-tree", { query: {} }, makeDeps(makeManager(makeEntry()))))
      .toEqual({ ok: false, status: 400, data: { error: "client required" } });
    expect(await invoke("op:agent:session-tree", { query: { client: "c", thread: "t" } }, makeDeps(makeManager(makeEntry()))))
      .toEqual({ ok: true, status: 200, data: { entries: [] } });
    const depsFail = makeDeps(makeManager(makeEntry(), { sessionTree: vi.fn(async () => { throw new Error("no session"); }) }));
    expect(await invoke("op:agent:session-tree", { query: { client: "c" } }, depsFail))
      .toEqual({ ok: false, status: 409, data: { error: "no session" } });
  });

  test("session-branch：400 双分支 / summarize 默认 true、label 截 120 / 抛错 409", async () => {
    expect(await invoke("op:agent:session-branch", { body: {} }, makeDeps(makeManager(makeEntry()))))
      .toEqual({ ok: false, status: 400, data: { error: "client required" } });
    expect(await invoke("op:agent:session-branch", { body: { client: "c" } }, makeDeps(makeManager(makeEntry()))))
      .toEqual({ ok: false, status: 400, data: { error: "entryId required" } });

    const manager = makeManager(makeEntry());
    const result = await invoke("op:agent:session-branch", { body: { client: "clientA", thread: "threadB", entryId: "e1" } }, makeDeps(manager));
    expect(result).toEqual({ ok: true, status: 200, data: { ok: true, branched: true } });
    expect(manager.branchSession).toHaveBeenCalledWith("clientA::threadB", "e1", { summarize: true, label: undefined });

    const managerOpts = makeManager(makeEntry());
    await invoke("op:agent:session-branch", {
      body: { client: "clientA", thread: "threadB", entryId: "e1", summarize: false, label: "L".repeat(200) }
    }, makeDeps(managerOpts));
    expect(managerOpts.branchSession).toHaveBeenCalledWith("clientA::threadB", "e1", { summarize: false, label: "L".repeat(120) });

    const depsFail = makeDeps(makeManager(makeEntry(), { branchSession: vi.fn(async () => { throw new Error("branch denied"); }) }));
    expect(await invoke("op:agent:session-branch", { body: { client: "c", entryId: "e1" } }, depsFail))
      .toEqual({ ok: false, status: 409, data: { error: "branch denied" } });
  });
});

describe("S3-3 new/resume 会话生命周期（server L4674-4708）", () => {
  test("new：400 / 归注会话线程 + 项目与标签回写 / 抛错 500 带 code/detail", async () => {
    expect(await invoke("op:agent:new", { body: { client: "c" } }, makeDeps(makeManager(makeEntry()))))
      .toEqual({ ok: false, status: 400, data: { error: "client and thread required" } });

    const deps = makeDeps(makeManager(makeEntry()), { getProject: vi.fn((id: unknown) => (id === "p9" ? { id: "p9" } : null)) });
    const result = await invoke("op:agent:new", { body: { client: "clientA", thread: "threadB", projectId: "p9", label: " 我的标签 " } }, deps);
    expect(result).toEqual({ ok: true, status: 200, data: { sessionId: "sess-new" } });
    expect(deps.annotateSessionThread).toHaveBeenCalledWith("sess-new", "threadB");
    expect(deps.updateSessionHeader).toHaveBeenCalledWith("sess-new", { projectId: "p9", label: "我的标签" });

    const depsFail = makeDeps(makeManager(makeEntry(), {
      newThread: vi.fn(async () => { const e = new Error("create failed") as Error & { code?: string; detail?: unknown }; e.code = "E-PI"; e.detail = { x: 1 }; throw e; })
    }));
    expect(await invoke("op:agent:new", { body: { client: "c", thread: "t" } }, depsFail))
      .toEqual({ ok: false, status: 500, data: { error: "create failed", code: "E-PI", detail: { x: 1 } } });
  });

  test("resume：400 / 404 会话不存在 / 工作区不一致 409 / 成功恢复并归注 / 抛错 500", async () => {
    expect(await invoke("op:agent:resume", { body: { client: "c", thread: "t" } }, makeDeps(makeManager(makeEntry()))))
      .toEqual({ ok: false, status: 400, data: { error: "client, thread and sessionId required" } });
    expect(await invoke("op:agent:resume", { body: { client: "c", thread: "t", sessionId: "s404" } }, makeDeps(makeManager(makeEntry()))))
      .toEqual({ ok: false, status: 404, data: { error: "session not found" } });

    const depsMis = makeDeps(makeManager(makeEntry()), {
      findSessionFile: vi.fn(() => ({ fullPath: "D:\\sess\\s1.jsonl" })),
      readSessionHeader: vi.fn(() => ({ cwd: "D:\\other-ws" }))
    });
    const mismatch = await invoke("op:agent:resume", { body: { client: "c", thread: "t", sessionId: "s1" } }, depsMis);
    expect(mismatch).toMatchObject({ ok: false, status: 409, data: { code: "SESSION_WORKSPACE_MISMATCH" } });

    const found = { fullPath: "D:\\sess\\s1.jsonl" };
    const deps = makeDeps(makeManager(makeEntry()), { findSessionFile: vi.fn(() => found) });
    const result = await invoke("op:agent:resume", { body: { client: "clientA", thread: "threadB", sessionId: "s1" } }, deps);
    expect(result).toEqual({ ok: true, status: 200, data: expect.objectContaining({ sessionId: "sess1" }) });
    expect(deps.annotateSessionThread).toHaveBeenCalledWith("sess1", "threadB");
    const manager = await (deps.getManager as ReturnType<typeof vi.fn>)();
    expect(manager.resumeThread).toHaveBeenCalledWith("clientA::threadB", "threadB", "D:\\sess\\s1.jsonl", WS);

    const depsFail = makeDeps(makeManager(makeEntry(), {
      resumeThread: vi.fn(async () => { throw new Error("corrupt session"); })
    }), { findSessionFile: vi.fn(() => found) });
    expect(await invoke("op:agent:resume", { body: { client: "c", thread: "t", sessionId: "s1" } }, depsFail))
      .toEqual({ ok: false, status: 500, data: { error: "corrupt session", code: null, detail: null } });
  });
});

describe("S3-3 runs resume/retry 恢复链（server L4513-4672 / L4657-4669）", () => {
  function sourceRun(overrides: Record<string, unknown> = {}) {
    return {
      id: "r1", status: "failed", clientId: "clientA", threadId: "threadB", sessionId: "sess1", cwd: WS,
      task: { goal: "原任务目标文本", mode: "agent", workflowId: null, references: [] },
      actions: { canResume: true, canRetry: true },
      ...overrides
    };
  }

  test("404 run not found / actions 不可 → 409 带 run 回显", async () => {
    expect(await invoke("op:runs:resume", { params: { id: "r404" } }, makeDeps(makeManager(makeEntry()))))
      .toEqual({ ok: false, status: 404, data: { error: "run not found" } });
    const deps = makeDeps(makeManager(makeEntry()), { getRun: vi.fn(() => sourceRun({ actions: { canResume: false, canRetry: false } })) });
    const result = await invoke("op:runs:resume", { params: { id: "r1" } }, deps);
    expect(result).toMatchObject({ ok: false, status: 409, data: { error: "任务当前状态不可继续：failed", run: { id: "r1" } } });
  });

  test("状态守卫：status=running（canRetry=true）→ 500 RUN_RECOVERY_FAILED", async () => {
    const deps = makeDeps(makeManager(makeEntry()), { getRun: vi.fn(() => sourceRun({ status: "running" })) });
    const result = await invoke("op:runs:retry", { params: { id: "r1" } }, deps);
    expect(result).toEqual({
      ok: false, status: 500,
      data: { error: "任务当前状态不可重试：running", code: "RUN_RECOVERY_FAILED", sourceRunId: "r1" }
    });
  });

  test("busy：内存会话正在执行 → 500 对应对话正在执行其他任务", async () => {
    const manager = makeManager(makeEntry());
    manager.sessions.set("clientA::threadB", { busy: true });
    const deps = makeDeps(manager, { getRun: vi.fn(() => sourceRun()) });
    const result = await invoke("op:runs:resume", { params: { id: "r1" } }, deps);
    expect(result).toMatchObject({ ok: false, status: 500, data: { code: "RUN_RECOVERY_FAILED" } });
    expect((result.data as any).error).toContain("对应对话正在执行其他任务");
  });

  test("SKILL_PREFLIGHT_FAILED：工作流依赖预检失败 → 409", async () => {
    const deps = makeDeps(makeManager(makeEntry()), {
      getRun: vi.fn(() => sourceRun({ task: { goal: "原任务目标文本", mode: "agent", workflowId: "wf-plan-doc", references: [] } })),
      preflightSkills: vi.fn(() => ({ ok: false, workflow: null, required: [], checks: [], missing: ["huashu-research"], message: "Skills 预检未通过：huashu-research" }))
    });
    const result = await invoke("op:runs:retry", { params: { id: "r1" } }, deps);
    expect(result).toEqual({
      ok: false, status: 409,
      data: { error: "Skills 预检未通过：huashu-research", code: "SKILL_PREFLIGHT_FAILED", sourceRunId: "r1" }
    });
  });

  test("resume 成功：磁盘会话恢复 + recoveryChain + continuation 文案 + 后台收尾 run_finished", async () => {
    const entry = makeEntry();
    const manager = makeManager(entry);
    const createdRun: Record<string, any> = { id: "r2" };
    const deps = makeDeps(manager, {
      getRun: vi.fn((id: unknown) => (id === "r1" ? sourceRun() : id === "r2" ? createdRun : null)),
      findSessionFile: vi.fn(() => ({ fullPath: "D:\\sess\\sess1.jsonl" })),
      beginRun: vi.fn((input: Record<string, unknown>) => Object.assign(createdRun, input))
    });
    const result = await invoke("op:runs:resume", { params: { id: "r1" } }, deps);
    expect(result).toMatchObject({ ok: true, status: 200, data: { sourceRunId: "r1" } });
    expect((result.data as any).run.id).toBe("r2");
    expect(createdRun.recoveryChain).toEqual([{ sourceRunId: "r1", action: "resume" }]);
    expect(deps.annotateSessionThread).toHaveBeenCalledWith("sess1", "threadB");
    expect(deps.recordRunEvent).toHaveBeenCalledWith("r2", "run_recovery_started", expect.objectContaining({ sourceRunId: "r1", action: "resume" }));
    expect(deps.requireWorkspaceWriteForTask).toHaveBeenCalledWith(expect.objectContaining({ mode: "agent" }), WS);
    // 恢复文案（resume 形态）与磁盘会话恢复路径
    await until(() => (manager.promptWithContext as ReturnType<typeof vi.fn>).mock.calls.length > 0);
    const promptText = String((manager.promptWithContext as ReturnType<typeof vi.fn>).mock.calls[0]![1]);
    expect(promptText).toContain("请从原任务上次中断的位置继续执行");
    expect(promptText).toContain("原任务目标：原任务目标文本");
    expect(manager.resumeThread).toHaveBeenCalledWith("clientA::threadB", "threadB", "D:\\sess\\sess1.jsonl", WS);
    await until(() => entry.events.some((e) => e.type === "run_finished"));
    expect(deps.finishRun).toHaveBeenCalledWith("r2", expect.objectContaining({
      status: "completed", summary: "恢复任务完成，未检测到文件变更"
    }));
    const finished = entry.events.find((e) => e.type === "run_finished");
    expect(finished?.data).toMatchObject({ runId: "r2", status: "completed" });
  });

  test("retry 成功：continuation 文案为重试形态", async () => {
    const entry = makeEntry();
    const manager = makeManager(entry);
    const deps = makeDeps(manager, {
      getRun: vi.fn((id: unknown) => (id === "r1" ? sourceRun() : null)),
      beginRun: vi.fn((input: Record<string, unknown>) => ({ id: "r3", ...input }))
    });
    const result = await invoke("op:runs:retry", { params: { id: "r1" } }, deps);
    expect(result).toMatchObject({ ok: true, data: { sourceRunId: "r1" } });
    await until(() => (manager.promptWithContext as ReturnType<typeof vi.fn>).mock.calls.length > 0);
    const promptText = String((manager.promptWithContext as ReturnType<typeof vi.fn>).mock.calls[0]![1]);
    expect(promptText).toContain("请重新执行原任务");
    expect(promptText).toContain("原任务目标：原任务目标文本");
  });
});

describe("S3-3 dispatcher（invokeAgentPromptDirect）", () => {
  test("unknown channel → 404；处理器意外错误 → 500", async () => {
    const deps = makeDeps(makeManager(makeEntry()));
    expect(await invoke("op:agent:nonexistent" as never, {}, deps))
      .toEqual({ ok: false, status: 404, data: { error: "unknown channel: op:agent:nonexistent" } });

    const depsFail = makeDeps(makeManager(makeEntry()), {
      getManager: vi.fn(async () => { throw new Error("mgr down"); })
    });
    const result = await invoke("op:agent:answer", { body: { client: "c", answer: "a" } }, depsFail);
    expect(result).toEqual({ ok: false, status: 500, data: { error: "mgr down" } });
  });
});
