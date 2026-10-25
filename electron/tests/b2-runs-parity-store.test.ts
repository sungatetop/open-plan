/**
 * B2-2 runs 域对拍②：CRUD/生命周期/查询族（beginRun/finishRun/回滚/恢复/取消/列表）。
 *
 * 模块级重状态隔离（B1-1 先例）：beforeAll 分次 stubEnv（OAW_RUNS_DIR/OAW_EVENT_DIR=各侧 tmp）
 * 后各自动态 import——旧侧 Node ESM 首次加载冻结，新侧 vi.resetModules() 重载整棵依赖树
 * （runs.ts→event-storage/workspace/feature-flags 全新实例）。runBoth 双侧同脚本执行后归一比对。
 */
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "../..");
const OLD_URL = pathToFileURL(path.join(PROJECT_ROOT, "server", "runs.mjs")).href;
const OLD_FLAGS_URL = pathToFileURL(path.join(PROJECT_ROOT, "server", "feature-flags.mjs")).href;

interface Side {
  name: string;
  runs: any;
  flags: any;
  base: string;
  ws: string;
  runsDir: string;
  eventDir: string;
}

const SIDES: Side[] = [];

beforeAll(async () => {
  for (const name of ["old", "new"] as const) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), `b2runs-${name}-`));
    const ws = path.join(base, "ws");
    const runsDir = path.join(base, "runs");
    const eventDir = path.join(base, "events");
    fs.mkdirSync(ws);
    vi.stubEnv("OAW_RUNS_DIR", runsDir);
    vi.stubEnv("OAW_EVENT_DIR", eventDir);
    if (name === "old") {
      const runs = await import(OLD_URL);
      const flags = (await import(OLD_FLAGS_URL)).RUNTIME_FLAGS;
      SIDES.push({ name, runs, flags, base, ws, runsDir, eventDir });
    } else {
      vi.resetModules();
      const runs = await import("../src/main/backend/runs");
      const flags = (await import("../src/shared/runtime/feature-flags")).RUNTIME_FLAGS;
      SIDES.push({ name, runs, flags, base, ws, runsDir, eventDir });
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
 * 跨侧归一：tmp 路径（JSON 转义替换键 + 正斜杠变体，publicRunView 的 staging.directory
 * 会把路径转成正斜杠）+ run/artifact UUID + ISO 时间戳 + mtime。
 * 对两侧的 ws/base 全部做替换：旧值只含旧侧路径、新值只含新侧路径，替换集合取并集即可对称。
 */
function norm(value: unknown): string {
  let text = JSON.stringify(value)!;
  for (const s of SIDES) {
    text = text!
      .replaceAll(JSON.stringify(s.ws).slice(1, -1), "<WS>")
      .replaceAll(JSON.stringify(s.base).slice(1, -1), "<BASE>")
      .replaceAll(s.ws.replace(/\\/g, "/"), "<WS>")
      .replaceAll(s.base.replace(/\\/g, "/"), "<BASE>");
  }
  return text!
    .replaceAll(/run_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "run_<ID>")
    .replaceAll(/artifact_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "artifact_<ID>")
    .replaceAll(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z/g, "<TS>")
    .replaceAll(/"mtime":\d+(\.\d+)?/g, '"mtime":<MT>');
}

function expectSameNorm(oldValue: unknown, newValue: unknown) {
  expect(norm(oldValue)).toBe(norm(newValue));
}

/** 直接落盘 seed 一个 Run JSON（绕过 beginRun，供恢复/归属回溯等场景）。 */
function seedRun(side: Side, patch: Record<string, unknown>): string {
  const id = `run_${crypto.randomUUID()}`;
  const run = {
    id,
    version: 1,
    status: "running",
    snapshotMode: "none",
    cwd: side.ws,
    threadId: "seed-thread",
    events: [],
    steps: [],
    todos: [],
    artifacts: [],
    touchedPaths: [],
    eventSeq: 0,
    startedAt: new Date().toISOString(),
    ...patch,
  };
  fs.writeFileSync(path.join(side.runsDir, `${id}.json`), JSON.stringify(run));
  return id;
}

describe("B2-2 runs 生命周期：beginRun / runsDir", () => {
  it("runsDir 指向 env 注入目录；beginRun 基础面：默认主步骤/事件/checkpoint/staging/快照收编", async () => {
    await runBoth(async (side) => {
      const runs = side.runs;
      expect(runs.runsDir()).toBe(side.runsDir);
      fs.writeFileSync(path.join(side.ws, "seed.md"), "seed-content");
      const run = runs.beginRun({ clientId: "c1", threadId: "t1", sessionId: "s1", cwd: side.ws, task: { goal: "目标G", mode: "agent" } });
      const view = runs.getRun(run.id);
      const runFile = path.join(side.runsDir, `${run.id}.json`);
      return {
        dir: runs.runsDir(),
        idShape: /^run_[0-9a-f-]{36}$/.test(run.id),
        fileExists: fs.existsSync(runFile),
        view,
        eventTypes: fs.readFileSync(path.join(side.eventDir, "事件流.jsonl"), "utf8").trim().split("\n").map((line: string) => JSON.parse(line).type),
      };
    }).then(({ old, new: nw }) => {
      expectSameNorm(old, nw);
      const newSide = SIDES[1]!;
      expect(nw.dir).toBe(newSide.runsDir);
      expect(nw.idShape).toBe(true);
      expect(nw.fileExists).toBe(true);
      expect(nw.eventTypes).toEqual(["run_started"]);
      const view = nw.view;
      expect(view.status).toBe("running");
      expect(view.version).toBe(1);
      expect(view.clientId).toBe("c1");
      expect(view.threadId).toBe("t1");
      expect(view.sessionId).toBe("s1");
      expect(view.cwd).toBe(path.resolve(newSide.ws));
      expect(view.task).toEqual({ goal: "目标G", mode: "agent" });
      expect(view.steps).toHaveLength(1);
      expect(view.steps[0]).toMatchObject({ id: `${view.id}:main`, index: 0, name: "执行 Agent 任务", status: "running", attempts: 1 });
      expect(view.currentStepId).toBe(`${view.id}:main`);
      expect(view.events).toHaveLength(1);
      expect(view.events[0]).toMatchObject({ seq: 1, type: "run_started", data: {} });
      expect(view.checkpoint).toMatchObject({ version: 1, type: "jsonl_reopen", status: "available", native: false, sessionId: "s1" });
      expect(view.checkpoint.note).toContain("JSONL 会话重开");
      expect(view.todoVersion).toBe(1);
      expect(view.todos).toEqual([]);
      expect(view.touchedPaths).toEqual([]);
      expect(view.snapshotMode).toBe("full");
      expect(view.staging.status).toBe("open");
      expect(view.staging.files).toEqual([]);
      expect(view.staging.directory).toContain(view.id);
      expect(view.staging.directory.endsWith("/staging")).toBe(true);
      expect(view.workspaceSnapshot).toEqual({ beforeFiles: 1, afterFiles: 0 });
      expect(view.actions).toEqual({ canCancel: true, canResume: false, canRetry: false });
      expect(view.progress).toEqual({ completed: 0, total: 1, running: 1 });
      expect(view.todoProgress).toEqual({ completed: 0, total: 0, running: 0, blocked: 0, failed: 0 });
      expect(view.finishedAt).toBeNull();
    });
  });

  it("beginRun 变体：snapshotMode none / beforeSnapshot 复用 / workflow 步骤映射 / 分支溯源 / capabilityPlan 回退", async () => {
    await runBoth(async (side) => {
      const runs = side.runs;
      const noneRun = runs.beginRun({ clientId: "c", threadId: "t", cwd: side.ws, snapshotMode: "none" });
      const snap = runs.snapshotWorkspace(side.ws);
      const reuseRun = runs.beginRun({ clientId: "c", threadId: "t", cwd: side.ws, beforeSnapshot: snap });
      const wfRun = runs.beginRun({
        clientId: "c", threadId: "t", cwd: side.ws,
        workflow: { id: "wf1", name: "流程", valid: true, missing: [], steps: ["第一步", "第二步"] },
        branchOfRunId: "run_parent", branchPointEntryId: "entry-9",
        model: "deepseek/deepseek-chat",
        references: [{ path: "ref.md" }],
        projectId: "p1",
        task: { goal: "g", capabilityPlan: { steps: 2 } },
      });
      const views = [noneRun, reuseRun, wfRun].map((r) => runs.getRun(r.id));
      return {
        none: { snapshotMode: views[0].snapshotMode, beforeFiles: views[0].workspaceSnapshot.beforeFiles, checkpoint: views[0].checkpoint.status },
        reuse: { beforeFiles: views[1].workspaceSnapshot.beforeFiles, seedInBefore: Object.keys(views[1].events ? {} : {}) },
        wf: {
          steps: views[2].steps.map((s: any) => ({ id: s.id, index: s.index, name: s.name, status: s.status })),
          branchOfRunId: views[2].branchOfRunId,
          branchPointEntryId: views[2].branchPointEntryId,
          model: views[2].model,
          references: views[2].references,
          projectId: views[2].projectId,
          capabilityPlan: views[2].capabilityPlan,
          workflow: views[2].workflow,
          currentStep: views[2].currentStep,
        },
      };
    }).then(({ old, new: nw }) => {
      expectSameNorm(old, nw);
      expect(nw.none).toMatchObject({ snapshotMode: "none", beforeFiles: 0, checkpoint: "unavailable" });
      expect(nw.reuse.beforeFiles).toBe(1);
      expect(nw.wf.steps).toEqual([
        { id: "wf1:step-1", index: 0, name: "第一步", status: "ready" },
        { id: "wf1:step-2", index: 1, name: "第二步", status: "pending" },
      ]);
      expect(nw.wf.branchOfRunId).toBe("run_parent");
      expect(nw.wf.branchPointEntryId).toBe("entry-9");
      expect(nw.wf.model).toBe("deepseek/deepseek-chat");
      expect(nw.wf.references).toEqual([{ path: "ref.md" }]);
      expect(nw.wf.projectId).toBe("p1");
      expect(nw.wf.capabilityPlan).toEqual({ steps: 2 });
      expect(nw.wf.workflow).toEqual({ id: "wf1", name: "流程", valid: true, missing: [] });
      expect(nw.wf.currentStep).toBeNull();
    });
  });
});

describe("B2-2 runs 生命周期：getRun / updateRunStep / recordRunEvent", () => {
  it("getRun 公开视图剥离快照；未知 id null", async () => {
    await runBoth(async (side) => {
      const runs = side.runs;
      const run = runs.beginRun({ clientId: "c", threadId: "t", cwd: side.ws });
      const view = runs.getRun(run.id);
      return {
        view,
        missing: runs.getRun("run_missing"),
        noBeforeKeys: "before" in view || "after" in view,
      };
    }).then(({ old, new: nw }) => {
      expectSameNorm(old, nw);
      expect(nw.missing).toBeNull();
      expect(nw.noBeforeKeys).toBe(false);
      expect(nw.view.workspaceSnapshot.afterFiles).toBe(0);
    });
  });

  it("updateRunStep：按 id 与按 index 定位/running 计数/completed 收口/未知返回 null", async () => {
    await runBoth(async (side) => {
      const runs = side.runs;
      const run = runs.beginRun({ clientId: "c", threadId: "t", cwd: side.ws });
      const byIndex = runs.updateRunStep(run.id, 0, { status: "running" });
      const main = byIndex.steps.find((s: any) => s.id === `${run.id}:main`);
      const done = runs.updateRunStep(run.id, `${run.id}:main`, { status: "completed" });
      return {
        attemptsAfterRunning: main.attempts,
        finishedAtSet: Boolean(main.startedAt),
        doneStatus: done.steps[0].status,
        doneFinishedAt: Boolean(done.steps[0].finishedAt),
        eventTypes: done.events.filter((e: any) => e.type === "step_updated").map((e: any) => e.data),
        unknownStep: runs.updateRunStep(run.id, "no-such", { status: "done" }),
        unknownRun: runs.updateRunStep("run_missing", 0, {}),
      };
    }).then(({ old, new: nw }) => {
      expectSameNorm(old, nw);
      expect(nw.attemptsAfterRunning).toBe(2);
      expect(nw.finishedAtSet).toBe(true);
      expect(nw.doneStatus).toBe("completed");
      expect(nw.doneFinishedAt).toBe(true);
      expect(nw.eventTypes).toEqual([{ stepId: expect.any(String), status: "running" }, { stepId: expect.any(String), status: "completed" }]);
      expect(nw.unknownStep).toBeNull();
      expect(nw.unknownRun).toBeNull();
    });
  });

  it("recordRunEvent：工具步骤族/touchedPaths 台账/runtime_health/runtime_error/assistant_final 重定向", async () => {
    await runBoth(async (side) => {
      const runs = side.runs;
      const run = runs.beginRun({ clientId: "c", threadId: "t", cwd: side.ws });
      const id = run.id;
      runs.recordRunEvent(id, "tool_start", { name: "officecli", toolCallId: "tc1" });
      runs.recordRunEvent(id, "tool_end", { name: "officecli", toolCallId: "tc1", isError: true, error: "x".repeat(600) });
      runs.recordRunEvent(id, "write_started", { path: path.join(side.ws, "out", "报告.docx"), toolCallId: "tc2" });
      runs.recordRunEvent(id, "runtime_health", { status: "degraded", note: "慢" });
      runs.recordRunEvent(id, "runtime_error", { message: "Pi 挂了", runtime: { model: "m" } });
      runs.recordRunEvent(id, "assistant_final", { text: "终稿文本", source: "agent" });
      const view = runs.getRun(id);
      const toolStep = view.steps.find((s: any) => s.id === `${id}:tool:tc1`);
      return {
        toolStep: { name: toolStep?.name, status: toolStep?.status, errorLen: toolStep?.error?.length, finished: Boolean(toolStep?.finishedAt) },
        currentStepId: view.currentStepId,
        touchedPaths: view.touchedPaths,
        runtimeHealth: view.runtimeHealth,
        runtime: view.runtime,
        recovery: view.recovery,
        finalText: view.finalText,
        finalMessageId: view.finalMessageId,
        finalVersion: view.finalTextVersion,
        finalEvent: view.events.filter((e: any) => e.type === "assistant_final"),
        seqMax: view.events[view.events.length - 1].seq,
        eventSeq: view.eventSeq,
        rawToolStartAppended: fs.readFileSync(path.join(side.eventDir, "事件流.jsonl"), "utf8").includes("tool_execution_start") === false,
      };
    }).then(({ old, new: nw }) => {
      expectSameNorm(old, nw);
      expect(nw.toolStep).toEqual({ name: "处理 Office 文档", status: "failed", errorLen: 500, finished: true });
      expect(nw.touchedPaths).toEqual(["out/报告.docx"]);
      expect(nw.runtimeHealth).toMatchObject({ status: "failed", message: "Pi 挂了" });
      expect(nw.runtime).toMatchObject({ status: "degraded", model: "m" });
      expect(nw.recovery).toMatchObject({ required: true, reason: "Pi 挂了" });
      expect(nw.finalText).toBe("终稿文本");
      expect(nw.finalVersion).toBe(1);
      expect(nw.finalEvent).toHaveLength(1);
      expect(nw.rawToolStartAppended).toBe(true);
    });
  });
});

describe("B2-2 runs 生命周期：recordRunFinalText / checkpoint / todo", () => {
  it("recordRunFinalText：首写/幂等/改稿版本递增同位置/空文本", async () => {
    await runBoth(async (side) => {
      const runs = side.runs;
      const run = runs.beginRun({ clientId: "c", threadId: "t", cwd: side.ws });
      const id = run.id;
      const first = runs.recordRunFinalText(id, "第一稿", { messageId: "msg-1" });
      const same = runs.recordRunFinalText(id, "第一稿", { messageId: "msg-1" });
      const revised = runs.recordRunFinalText(id, "第二稿", { messageId: "msg-1" });
      const empty = runs.recordRunFinalText(id, "   ");
      const view = runs.getRun(id);
      return {
        changed: [first.changed, same.changed, revised.changed, empty.changed],
        versions: [first.event.data.version, revised.event.data.version],
        sameSeq: first.event.seq === revised.event.seq,
        eventsFinalCount: view.events.filter((e: any) => e.type === "assistant_final").length,
        finalText: view.finalText,
        finalTextVersion: view.finalTextVersion,
        finalMessageId: view.finalMessageId,
        emptyRunId: empty.run?.id ?? null,
        recordRunEventRedirect: Boolean(runs.recordRunEvent(id, "assistant_final", { text: "第三稿" })),
        afterRedirectVersion: runs.getRun(id).finalTextVersion,
      };
    }).then(({ old, new: nw }) => {
      expectSameNorm(old, nw);
      expect(nw.changed).toEqual([true, false, true, false]);
      expect(nw.versions).toEqual([1, 2]);
      expect(nw.sameSeq).toBe(true);
      expect(nw.eventsFinalCount).toBe(1);
      // view 在重定向之前捕获：finalText 仍是改稿后的"第二稿"；
      // recordRunEvent 的 assistant_final 重定向走 recordRunFinalText 幂等路径，版本递增到 3。
      expect(nw.finalText).toBe("第二稿");
      expect(nw.finalTextVersion).toBe(2);
      expect(nw.afterRedirectVersion).toBe(3);
      expect(nw.finalMessageId).toBe("msg-1");
    });
  });

  it("updateRunCheckpoint：幂等不重复追加；变化才落事件", async () => {
    await runBoth(async (side) => {
      const runs = side.runs;
      const run = runs.beginRun({ clientId: "c", threadId: "t", cwd: side.ws });
      const id = run.id;
      const before = runs.getRun(id).events.length;
      const noop = runs.updateRunCheckpoint(id, { native: false });
      // publicRunView 是浅拷贝：noop.events 与 run.events 是同一活引用，
      // 下面的 changed 会向同一数组 push，必须在 changed 之前先取数值快照。
      const noopLen = noop.events.length;
      const changed = runs.updateRunCheckpoint(id, { native: true, note: "升级" });
      const view = runs.getRun(id);
      return {
        noopEventsLen: noopLen,
        noopSameAsBefore: noopLen === before,
        checkpoint: view.checkpoint,
        cpEvents: view.events.filter((e: any) => e.type === "run_checkpoint_updated").map((e: any) => e.data.note),
        missing: runs.updateRunCheckpoint("run_missing", { a: 1 }),
      };
    }).then(({ old, new: nw }) => {
      expectSameNorm(old, nw);
      expect(nw.noopSameAsBefore).toBe(true);
      // patch 合并不重算 status（runs.mjs 只做 JSON 比对合并）：beginRun 无 sessionId → unavailable 保持。
      expect(nw.checkpoint).toMatchObject({ native: true, note: "升级", status: "unavailable" });
      expect(nw.cpEvents).toEqual(["升级"]);
      expect(nw.missing).toBeNull();
    });
  });

  it("updateRunTodo：规范化落库/签名一致 no-op/事件追加/非法 id null", async () => {
    await runBoth(async (side) => {
      const runs = side.runs;
      const run = runs.beginRun({ clientId: "c", threadId: "t", cwd: side.ws });
      const id = run.id;
      const first = runs.updateRunTodo(id, [{ title: "任务A", status: "todo" }, { title: "任务B", done: true }], { source: "plan" });
      const eventsAfterFirst = runs.getRun(id).events.filter((e: any) => e.type === "todo_updated").length;
      const noop = runs.updateRunTodo(id, [{ title: "任务A", status: "planned" }, { title: "任务B", status: "completed" }]);
      // 计数必须在每次调用后立即取数值快照（events 是活引用，后续调用会向同一数组 push）。
      const eventsAfterNoop = runs.getRun(id).events.filter((e: any) => e.type === "todo_updated").length;
      const second = runs.updateRunTodo(id, [{ title: "任务C" }]);
      const eventsAfterSecond = runs.getRun(id).events.filter((e: any) => e.type === "todo_updated").length;
      return {
        todos: runs.getRun(id).todos.map((t: any) => ({ title: t.title, status: t.status, index: t.index })),
        todoVersion: runs.getRun(id).todoVersion,
        eventsAfterFirst,
        noopSameTodos: eventsAfterNoop === eventsAfterFirst,
        secondEventCount: eventsAfterSecond,
        source: first.events?.[0]?.data?.source ?? null,
        invalidId: runs.updateRunTodo("a/b\\c!", []),
      };
    }).then(({ old, new: nw }) => {
      expectSameNorm(old, nw);
      // updateRunTodo 是整表替换语义：最后一次调用 [任务C] 覆盖了先前的 [任务A, 任务B]。
      expect(nw.todos).toEqual([{ title: "任务C", status: "planned", index: 0 }]);
      expect(nw.todoVersion).toBe(1);
      expect(nw.eventsAfterFirst).toBe(1);
      expect(nw.noopSameTodos).toBe(true);
      expect(nw.secondEventCount).toBe(2);
      expect(nw.invalidId).toBeNull();
    });
  });
});

describe("B2-2 runs 生命周期：取消族 / recoverActiveRuns", () => {
  it("requestRunCancellation：活动态转 cancel_requested/重复幂等/待收尾表/非活动 no-op/clear", async () => {
    await runBoth(async (side) => {
      const runs = side.runs;
      const run = runs.beginRun({ clientId: "c", threadId: "t", cwd: side.ws });
      const id = run.id;
      const first = runs.requestRunCancellation(id, "用户点停");
      const pending1 = runs.listPendingCancellations();
      const eventsLen1 = runs.getRun(id).events.filter((e: any) => e.type === "run_cancel_requested").length;
      const second = runs.requestRunCancellation(id, "再点");
      const finished = runs.finishRun(id, { status: "cancelled" });
      const pendingAfterFinish = runs.listPendingCancellations().length;
      const completedRun = runs.beginRun({ clientId: "c", threadId: "t", cwd: side.ws });
      runs.finishRun(completedRun.id, { status: "completed" });
      const inactive = runs.requestRunCancellation(completedRun.id);
      const cleared = runs.clearPendingCancellation(inactive.id);
      return {
        status: first.status,
        cancelReason: first.cancelReason,
        cancelRequestedAtSet: Boolean(first.cancelRequestedAt),
        pending1: pending1.map((p: any) => ({ idIsRun: /^run_/.test(p.id), hasLastEventAt: Boolean(p.lastEventAt), hasRequestedAt: Boolean(p.cancelRequestedAt) })),
        eventsLen1,
        secondNoNewEvent: runs.getRun(id).events.filter((e: any) => e.type === "run_cancel_requested").length === eventsLen1,
        secondStatus: second.status,
        finishedStatus: finished.status,
        pendingAfterFinish,
        inactiveStatus: inactive.status,
        cleared: cleared,
        pendingEmpty: runs.listPendingCancellations().length,
      };
    }).then(({ old, new: nw }) => {
      expectSameNorm(old, nw);
      expect(nw.status).toBe("cancel_requested");
      expect(nw.cancelReason).toBe("用户点停");
      expect(nw.cancelRequestedAtSet).toBe(true);
      expect(nw.pending1).toEqual([expect.objectContaining({ idIsRun: true, hasLastEventAt: true, hasRequestedAt: true })]);
      expect(nw.eventsLen1).toBe(1);
      expect(nw.secondNoNewEvent).toBe(true);
      expect(nw.secondStatus).toBe("cancel_requested");
      expect(nw.finishedStatus).toBe("cancelled");
      expect(nw.pendingAfterFinish).toBe(0);
      expect(nw.inactiveStatus).toBe("completed");
      expect(nw.cleared).toBe(false);
      expect(nw.pendingEmpty).toBe(0);
    });
  });

  it("recoverActiveRuns：running→recovering、recovering→失败收尾、completed 不动、allowList 生效", async () => {
    await runBoth(async (side) => {
      const runs = side.runs;
      const runningId = seedRun(side, { status: "running" });
      const recoveringId = seedRun(side, { status: "recovering" });
      const queuedId = seedRun(side, { status: "queued" });
      const doneId = seedRun(side, { status: "completed", finishedAt: new Date().toISOString() });
      const first = runs.recoverActiveRuns({ onlyIds: [runningId] });
      const statusOf = (id: string) => runs.getRun(id)?.status ?? null;
      const second = runs.recoverActiveRuns();
      const recoveringView = runs.getRun(recoveringId);
      // readdir 顺序依赖文件系统，与实现无关：按「未收尾在前、收尾在后」稳定排序后比对。
      const stable = (list: string[]) => [...list].sort((a, b) => (a.endsWith("(收尾)") ? 1 : 0) - (b.endsWith("(收尾)") ? 1 : 0));
      return {
        first: stable(first),
        statuses: [statusOf(runningId), statusOf(recoveringId), statusOf(queuedId), statusOf(doneId)],
        runningRecovery: runs.getRun(runningId)?.recovery ?? null,
        runningEvent: runs.getRun(runningId)?.events.filter((e: any) => e.type === "run_recovered").length,
        second: stable(second),
        recoveringFinished: recoveringView?.status,
        recoveringError: recoveringView?.error ?? null,
        recoveringFinishedAt: Boolean(recoveringView?.finishedAt),
      };
    }).then(({ old, new: nw }) => {
      expectSameNorm(old, nw);
      // allowList 语义：onlyIds=[runningId] 时只有该 run 转 recovering（+已 recovering 的收尾），
      // 其余历史遗留 running 不受影响。
      expect(nw.first).toHaveLength(2);
      expect(nw.first.filter((x: string) => x.endsWith("(收尾)"))).toHaveLength(1);
      // 二次调用后读取：runningId 已被收尾成 failed；recoveringId 首轮即被收尾；
      // queued 属活动态，无过滤的二次调用把它转入 recovering。
      expect(nw.statuses).toEqual(["failed", "failed", "recovering", "completed"]);
      expect(nw.runningRecovery).toMatchObject({ required: true, reason: "服务重启后需要用户确认继续" });
      expect(nw.runningEvent).toBe(1);
      // 二次无过滤调用会吞并此前用例遗留的活动 Run：只对收尾计数与规模下限做断言。
      expect(nw.second.filter((x: string) => x.endsWith("(收尾)"))).toHaveLength(1);
      expect(nw.second.length).toBeGreaterThan(2);
      expect(nw.recoveringFinished).toBe("failed");
      expect(nw.recoveringError).toBe("服务重启两次后未被恢复，任务已终止");
      expect(nw.recoveringFinishedAt).toBe(true);
    });
  });
});

describe("B2-2 runs 生命周期：finishRun", () => {
  it("happy path：快照 diff 产物/归属 unattributed/after blob/validation 映射/completion/run_finished/二次收尾幂等", async () => {
    await runBoth(async (side) => {
      const runs = side.runs;
      fs.writeFileSync(path.join(side.ws, "a.md"), "v1");
      const run = runs.beginRun({ clientId: "c", threadId: "t", cwd: side.ws });
      await runs.awaitBeforeBlobs(run.id);
      fs.writeFileSync(path.join(side.ws, "a.md"), "v2-longer");
      fs.writeFileSync(path.join(side.ws, "b.md"), "new-file");
      const finished = runs.finishRun(run.id, {
        validations: [{ path: "b.md", status: "passed", message: "ok" }],
        completion: { status: "success", summary: "结论X" },
      });
      const again = runs.finishRun(run.id, { status: "completed" });
      const eventsLen = finished.events.length;
      return {
        status: finished.status,
        error: finished.error,
        verificationStatus: finished.verificationStatus,
        summary: finished.summary,
        snapshotTruncated: finished.snapshotTruncated,
        artifacts: finished.artifacts.map((a: any) => ({
          path: a.path, status: a.status, changeType: a.changeType, source: a.source, confidence: a.confidence,
          autoDeliverable: a.autoDeliverable, detectedBy: a.detectedBy, detectable: a.detectable,
          blobs: a.blobs, validationStatus: a.validation?.status ?? null, verificationStatus: a.verificationStatus,
          changeIdShape: /^change_[0-9a-f]{12}$/.test(a.changeId), runId: a.runId === run.id, artifactIdShape: /^artifact_/.test(a.artifactId),
        })),
        staging: finished.staging,
        completion: finished.completion,
        steps: finished.steps.map((s: any) => s.status),
        finishedAtSet: Boolean(finished.finishedAt),
        finishedEvent: finished.events.filter((e: any) => e.type === "run_finished").map((e: any) => ({ status: e.data.status, artifacts: e.data.artifacts, verificationStatus: e.data.verificationStatus, finalText: e.data.finalText })),
        againSame: again.finishedAt === finished.finishedAt && again.events.length === eventsLen,
        changeDetection: finished.changeDetection ?? null,
        workspaceSnapshot: runs.getRun(run.id).workspaceSnapshot,
      };
    }).then(({ old, new: nw }) => {
      expectSameNorm(old, nw);
      expect(nw.status).toBe("completed");
      expect(nw.error).toBeNull();
      expect(nw.verificationStatus).toBe("passed");
      expect(nw.summary).toBe("结论X");
      expect(nw.snapshotTruncated).toBe(false);
      expect(nw.artifacts).toEqual([
        expect.objectContaining({ path: "a.md", status: "modified", changeType: "modified", source: "unattributed", confidence: "suspected", autoDeliverable: false, detectedBy: "snapshot", detectable: true, blobs: { before: true, after: true }, validationStatus: null, verificationStatus: "not_checked", changeIdShape: true, runId: true, artifactIdShape: true }),
        expect.objectContaining({ path: "b.md", status: "added", changeType: "added", source: "unattributed", confidence: "suspected", autoDeliverable: false, blobs: { before: false, after: true }, validationStatus: "passed", verificationStatus: "passed", changeIdShape: true, runId: true, artifactIdShape: true }),
      ]);
      expect(nw.staging.status).toBe("published");
      expect(nw.completion).toMatchObject({ status: "success", summary: "结论X" });
      expect(nw.completion.runId).toBeTruthy();
      expect(nw.steps).toEqual(["completed"]);
      expect(nw.finishedAtSet).toBe(true);
      expect(nw.finishedEvent).toEqual([expect.objectContaining({ status: "completed", artifacts: 2, verificationStatus: "passed", finalText: null })]);
      expect(nw.againSame).toBe(true);
      // ws 跨用例累积：早前用例写入的文件可能落入 startedAt-2s 的 mtime 窗口，scanned 绝对值不稳定。
      expect(nw.changeDetection).toMatchObject({ source: "recent-mtime" });
      expect(nw.changeDetection.scanned).toBeGreaterThanOrEqual(2);
      expect(nw.workspaceSnapshot.afterFiles).toBeGreaterThanOrEqual(2);
    });
  });

  it("校验失败：全失败落 failed/混合跳过失败件继续发布/failed 分支 discard", async () => {
    await runBoth(async (side) => {
      const runs = side.runs;
      const allFailed = runs.beginRun({ clientId: "c", threadId: "t", cwd: side.ws });
      runs.finishRun(allFailed.id, { status: "completed", validations: [{ path: "x.docx", status: "failed", message: "坏" }] });
      const failedView = runs.getRun(allFailed.id);
      const mixed = runs.beginRun({ clientId: "c", threadId: "t", cwd: side.ws });
      runs.finishRun(mixed.id, { status: "completed", validations: [{ path: "p1.md", status: "passed" }, { path: "x.docx", status: "failed" }] });
      const mixedView = runs.getRun(mixed.id);
      const explicitFailed = runs.beginRun({ clientId: "c", threadId: "t", cwd: side.ws });
      runs.finishRun(explicitFailed.id, { status: "failed", error: "模型炸了" });
      const failedBranch = runs.getRun(explicitFailed.id);
      return {
        allFailed: { status: failedView.status, error: failedView.error, verificationStatus: failedView.verificationStatus, staging: failedView.staging.status, steps: failedView.steps.map((s: any) => s.status), summary: failedView.summary, finishedData: failedView.events.filter((e: any) => e.type === "run_finished").map((e: any) => e.data.status) },
        mixed: { status: mixedView.status, verificationStatus: mixedView.verificationStatus, staging: mixedView.staging.status, summary: mixedView.summary },
        failedBranch: { status: failedBranch.status, error: failedBranch.error, staging: failedBranch.staging.status, steps: failedBranch.steps.map((s: any) => s.status) },
      };
    }).then(({ old, new: nw }) => {
      expectSameNorm(old, nw);
      // summary 的「，产物校验发现问题」后缀只在有产物时拼接（runs.mjs：artifacts.length 分支）；
      // 无产物时统一是"本轮未产生文件变更"。
      expect(nw.allFailed).toMatchObject({ status: "failed", error: "产物校验失败，未发布临时产物", verificationStatus: "failed", staging: "discarded", steps: ["failed"], summary: "本轮未产生文件变更", finishedData: ["failed"] });
      expect(nw.mixed).toMatchObject({ status: "completed", verificationStatus: "failed", staging: "published", summary: "本轮未产生文件变更" });
      expect(nw.failedBranch).toMatchObject({ status: "failed", error: "模型炸了", staging: "discarded", steps: ["failed"] });
    });
  });

  it("临时文件清理（tempCleaned）与未完成待办降级（completion partial）", async () => {
    await runBoth(async (side) => {
      const runs = side.runs;
      const run = runs.beginRun({ clientId: "c", threadId: "t", cwd: side.ws });
      await runs.awaitBeforeBlobs(run.id);
      fs.mkdirSync(path.join(side.ws, ".tmp_out"));
      fs.writeFileSync(path.join(side.ws, ".tmp_out", "notes.py"), "tmp");
      runs.recordRunEvent(run.id, "write_started", { path: ".tmp_out/notes.py" });
      runs.updateRunTodo(run.id, [{ title: "没做完的事" }]);
      const finished = runs.finishRun(run.id, { status: "completed", completion: { status: "success", summary: "S" } });
      return {
        tempCleaned: finished.tempCleaned ?? null,
        tmpGone: fs.existsSync(path.join(side.ws, ".tmp_out", "notes.py")),
        tmpDirGone: fs.existsSync(path.join(side.ws, ".tmp_out")),
        completion: finished.completion,
        // write_cleaned 经 persistWriteEvent 落事件流（jsonl），不进 run.events。
        cleanedEvent: fs.readFileSync(path.join(side.eventDir, "事件流.jsonl"), "utf8").includes("write_cleaned"),
      };
    }).then(({ old, new: nw }) => {
      expectSameNorm(old, nw);
      expect(nw.tempCleaned).toEqual([".tmp_out/notes.py"]);
      expect(nw.tmpGone).toBe(false);
      expect(nw.tmpDirGone).toBe(false);
      expect(nw.completion).toMatchObject({ status: "partial", incomplete: ["没做完的事"], todoNote: "收尾时仍有 1 项待办未完成" });
      expect(nw.cleanedEvent).toBe(true);
    });
  });
});

describe("B2-2 runs 生命周期：rollbackRun", () => {
  it("modified 恢复/added 删除/renamed 双向恢复/运行中拒绝", async () => {
    await runBoth(async (side) => {
      const runs = side.runs;
      fs.writeFileSync(path.join(side.ws, "orig.txt"), "hello");
      fs.writeFileSync(path.join(side.ws, "moved.txt"), "MMM");
      const run = runs.beginRun({ clientId: "c", threadId: "t", cwd: side.ws });
      await runs.awaitBeforeBlobs(run.id);
      const runningRefusal = runs.rollbackRun(run.id);
      fs.writeFileSync(path.join(side.ws, "orig.txt"), "changed");
      fs.writeFileSync(path.join(side.ws, "new.txt"), "brand");
      fs.renameSync(path.join(side.ws, "moved.txt"), path.join(side.ws, "renamed.txt"));
      runs.recordRunEvent(run.id, "write_started", { path: path.join(side.ws, "orig.txt"), toolCallId: "tc1" });
      runs.recordRunEvent(run.id, "write_started", { path: path.join(side.ws, "new.txt"), toolCallId: "tc2" });
      runs.recordRunEvent(run.id, "write_started", { path: path.join(side.ws, "renamed.txt"), toolCallId: "tc3" });
      const finished = runs.finishRun(run.id, { status: "completed" });
      const artifactSources = finished.artifacts.map((a: any) => ({ path: a.path, status: a.status, from: a.from ?? null, source: a.source, confidence: a.confidence, toolCallId: a.toolCallId }));
      const rollback = runs.rollbackRun(run.id);
      const after = {
        orig: fs.readFileSync(path.join(side.ws, "orig.txt"), "utf8"),
        newGone: fs.existsSync(path.join(side.ws, "new.txt")),
        renamedGone: fs.existsSync(path.join(side.ws, "renamed.txt")),
        movedBack: fs.readFileSync(path.join(side.ws, "moved.txt"), "utf8"),
      };
      const partial = runs.rollbackRun(run.id, ["orig.txt"]);
      return { runningRefusal, artifactSources, rollback, after, partial };
    }).then(({ old, new: nw }) => {
      expectSameNorm(old, nw);
      expect(nw.runningRefusal).toEqual({ ok: false, error: "run not finished" });
      expect(nw.artifactSources).toEqual([
        expect.objectContaining({ path: "new.txt", status: "added", source: "write-ledger", confidence: "confirmed", toolCallId: "tc2" }),
        expect.objectContaining({ path: "orig.txt", status: "modified", source: "write-ledger", confidence: "confirmed", toolCallId: "tc1" }),
        expect.objectContaining({ path: "renamed.txt", status: "renamed", from: "moved.txt", source: "write-ledger", confidence: "confirmed", toolCallId: "tc3" }),
      ]);
      expect(nw.rollback.ok).toBe(true);
      expect([...nw.rollback.restored].sort()).toEqual(["new.txt", "orig.txt", "renamed.txt"]);
      expect(nw.after).toEqual({ orig: "hello", newGone: false, renamedGone: false, movedBack: "MMM" });
      expect(nw.partial).toEqual({ ok: true, restored: ["orig.txt"] });
    });
  });
});

describe("B2-2 runs 查询族：listRuns / listRunSummaries / runSummaryView / 验收 / 缓存", () => {
  it("列表过滤（threadId/cwd 大小写/status/query）/事件瘦身/runSummaryView 投影/summaries 排序", async () => {
    await runBoth(async (side) => {
      const runs = side.runs;
      const r1 = runs.beginRun({ clientId: "c", threadId: "thread-A", sessionId: "sess-1", cwd: side.ws, task: { goal: "生成季度报表", mode: "agent" } });
      runs.finishRun(r1.id, { status: "completed" });
      const r2 = runs.beginRun({ clientId: "c", threadId: "thread-B", cwd: side.ws, task: { goal: "别的任务", mode: "chat" } });
      const r3 = runs.beginRun({ clientId: "c", threadId: "thread-A", cwd: side.ws, task: { goal: "另一件事", mode: "agent" } });
      const upperCwd = side.ws.toUpperCase();
      return {
        byThread: runs.listRuns({ threadId: "thread-A" }).map((v: any) => v.task?.goal),
        byUpperCwd: runs.listRuns({ cwd: upperCwd }).length,
        byExactCwd: runs.listRuns({ cwd: side.ws }).length,
        byStatus: runs.listRuns({ status: "running" }).map((v: any) => v.status),
        byQuery: runs.listRuns({ query: "季度" }).map((v: any) => v.task?.goal),
        byMode: runs.listRuns({ mode: "chat" }).map((v: any) => v.task?.goal),
        includeNone: runs.listRuns({ threadId: "thread-A", includeEvents: "none" }).map((v: any) => ({ hasEvents: Array.isArray(v.events), eventCount: v.eventCount })),
        includeAll: runs.listRuns({ threadId: "thread-B", includeEvents: "all" })[0].events.length >= 1,
        defaultLatestRunning: runs.listRuns({ threadId: "thread-B" })[0].events.length >= 1,
        limit: runs.listRuns({ limit: 1 }).length,
        summaryView: runs.runSummaryView(runs.getRun(r1.id)),
        summaryNull: runs.runSummaryView(null),
        summaries: runs.listRunSummaries({ limit: 10 }).map((m: any) => ({ id: m.id, status: m.status, mode: m.mode, search: typeof m.search === "string" })),
        summariesLimit: runs.listRunSummaries({ limit: 1 }).length,
        totalRunFiles: fs.readdirSync(side.runsDir).filter((n: string) => n.endsWith(".json")).length,
      };
    }).then(({ old, new: nw }) => {
      expectSameNorm(old, nw);
      expect(nw.byThread).toEqual(["另一件事", "生成季度报表"]);
      // runsDir 为文件级模块状态、跨用例累积（所有 run 同 cwd），绝对数不稳定；
      // 改相对口径验证 cwd 过滤大小写不敏感：大写查询与原样查询命中同一集合。
      expect(nw.byUpperCwd).toBe(nw.byExactCwd);
      expect(nw.byUpperCwd).toBeGreaterThanOrEqual(3);
      // recoverActiveRuns 用例的无过滤调用已把此前累积的 running 全部转 recovering，
      // 但残留数量仍依赖用例结构；只验证过滤精度（结果全为 running）且本用例两个新 run 命中。
      expect(nw.byStatus.every((s: string) => s === "running")).toBe(true);
      expect(nw.byStatus.length).toBeGreaterThanOrEqual(2);
      expect(nw.byQuery).toEqual(["生成季度报表"]);
      expect(nw.byMode).toEqual(["别的任务"]);
      // includeEvents none：events 被删除（hasEvents false）并以 eventCount 计数；
      // r1 已 finishRun（run_started + run_finished）eventCount=2、r3 running=1，只验下限。
      expect(nw.includeNone.every((v: any) => v.hasEvents === false && v.eventCount >= 1)).toBe(true);
      expect(nw.includeAll).toBe(true);
      expect(nw.defaultLatestRunning).toBe(true);
      expect(nw.limit).toBe(1);
      // run 本体无顶层 mode（mode 仅在 runIndexEntry 由 task.mode 派生，供 listRuns 过滤），
      // runSummaryView 的 mode 取 view.mode || "" → 空串。
      expect(nw.summaryView).toMatchObject({ id: expect.any(String), status: "completed", mode: "", task: { goal: "生成季度报表", title: "" }, summary: "本轮未产生文件变更", verificationStatus: "not_checked", eventCount: 0, workflow: null });
      expect(nw.summaryNull).toBeNull();
      // summaries 相对口径：返回数 = min(limit, runsDir 内 Run 文件数)（runsDir 跨用例累积）。
      expect(nw.summaries.length).toBe(Math.min(10, nw.totalRunFiles));
      expect(nw.summariesLimit).toBe(1);
    });
  });

  it("updateRunAcceptance 落库与产物映射；外部改盘指纹失效重读；stagedVisible 关闭态投影", async () => {
    await runBoth(async (side) => {
      const runs = side.runs;
      const run = runs.beginRun({ clientId: "c", threadId: "t", cwd: side.ws });
      runs.finishRun(run.id, { status: "completed" });
      const accepted = runs.updateRunAcceptance(run.id, { status: "passed", readyToPublish: true, artifacts: [{ path: "whatever.md", status: "passed" }] });
      // 外部改盘：loadRun 按 mtime+size 指纹失效
      const file = path.join(side.runsDir, `${run.id}.json`);
      const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
      onDisk.externalMarker = "touched";
      fs.writeFileSync(file, JSON.stringify(onDisk));
      const reread = runs.getRun(run.id);
      // stagedVisible 关闭态（默认）：运行中的暂存写入不投影成产物。
      // flag 开启态由 b2-runs-parity-staged-flag.test.ts 覆盖——RUNTIME_FLAGS 双侧
      // Object.freeze 且 env 只在 import 时读取，无法就地变异。
      const flagRun = runs.beginRun({ clientId: "c", threadId: "t", cwd: side.ws });
      runs.recordRunEvent(flagRun.id, "write_started", { path: "报告.docx" });
      const stagedOff = runs.getRun(flagRun.id);
      return {
        acceptance: { status: accepted.acceptanceStatus, ready: accepted.acceptanceReadyToPublish, hasBefore: "before" in accepted },
        rereadMarker: reread?.externalMarker ?? null,
        stagedOffCount: stagedOff.artifacts?.filter((a: any) => a.source === "staged").length ?? 0,
      };
    }).then(({ old, new: nw }) => {
      expectSameNorm(old, nw);
      expect(nw.acceptance).toMatchObject({ status: "passed", ready: true, hasBefore: true });
      expect(nw.rereadMarker).toBe("touched");
      expect(nw.stagedOffCount).toBe(0);
    });
  });
});
