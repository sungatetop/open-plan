/**
 * B2-2 runs 域②：CRUD/生命周期/查询族（beginRun/finishRun/回滚/恢复/取消/列表）。
 *
 * R6-7a 对拍退役改写：旧侧 server/runs.mjs + server/feature-flags.mjs 物理路径动态
 * import 随 server/ 退役删除（等价性已在 B2-2 批对拍验收冻结），仅保留 modern
 * src/main/backend/runs.ts + src/shared/runtime/feature-flags 的同一套绝对断言；
 * runBoth/norm（tmp 路径·run/artifact UUID·ISO 时间戳·mtime 归一）随之删除。
 *
 * 模块级重状态隔离（B1-1 先例）：beforeAll stubEnv（OAW_RUNS_DIR/OAW_EVENT_DIR=tmp）
 * + vi.resetModules() 重载整棵依赖树（runs.ts→event-storage/workspace/feature-flags
 * 全新实例）后动态 import。
 */
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "b2runs-md-"));
const ws = path.join(base, "ws");
const runsDir = path.join(base, "runs");
const eventDir = path.join(base, "events");

let runs: any;

beforeAll(async () => {
  fs.mkdirSync(ws);
  vi.stubEnv("OAW_RUNS_DIR", runsDir);
  vi.stubEnv("OAW_EVENT_DIR", eventDir);
  vi.resetModules();
  runs = await import("../src/main/backend/runs");
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
});

/** 直接落盘 seed 一个 Run JSON（绕过 beginRun，供恢复/归属回溯等场景）。 */
function seedRun(patch: Record<string, unknown>): string {
  const id = `run_${crypto.randomUUID()}`;
  const run = {
    id,
    version: 1,
    status: "running",
    snapshotMode: "none",
    cwd: ws,
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
  fs.writeFileSync(path.join(runsDir, `${id}.json`), JSON.stringify(run));
  return id;
}

describe("B2-2 runs 生命周期：beginRun / runsDir", () => {
  it("runsDir 指向 env 注入目录；beginRun 基础面：默认主步骤/事件/checkpoint/staging/快照收编", async () => {
    expect(runs.runsDir()).toBe(runsDir);
    fs.writeFileSync(path.join(ws, "seed.md"), "seed-content");
    const run = runs.beginRun({ clientId: "c1", threadId: "t1", sessionId: "s1", cwd: ws, task: { goal: "目标G", mode: "agent" } });
    const view = runs.getRun(run.id);
    expect(/^run_[0-9a-f-]{36}$/.test(run.id)).toBe(true);
    expect(fs.existsSync(path.join(runsDir, `${run.id}.json`))).toBe(true);
    expect(fs.readFileSync(path.join(eventDir, "事件流.jsonl"), "utf8").trim().split("\n").map((line: string) => JSON.parse(line).type)).toEqual(["run_started"]);
    expect(view.status).toBe("running");
    expect(view.version).toBe(1);
    expect(view.clientId).toBe("c1");
    expect(view.threadId).toBe("t1");
    expect(view.sessionId).toBe("s1");
    expect(view.cwd).toBe(path.resolve(ws));
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

  it("beginRun 变体：snapshotMode none / beforeSnapshot 复用 / workflow 步骤映射 / 分支溯源 / capabilityPlan 回退", async () => {
    const noneRun = runs.beginRun({ clientId: "c", threadId: "t", cwd: ws, snapshotMode: "none" });
    const snap = runs.snapshotWorkspace(ws);
    const reuseRun = runs.beginRun({ clientId: "c", threadId: "t", cwd: ws, beforeSnapshot: snap });
    const wfRun = runs.beginRun({
      clientId: "c", threadId: "t", cwd: ws,
      workflow: { id: "wf1", name: "流程", valid: true, missing: [], steps: ["第一步", "第二步"] },
      branchOfRunId: "run_parent", branchPointEntryId: "entry-9",
      model: "deepseek/deepseek-chat",
      references: [{ path: "ref.md" }],
      projectId: "p1",
      task: { goal: "g", capabilityPlan: { steps: 2 } },
    });
    const views = [noneRun, reuseRun, wfRun].map((r) => runs.getRun(r.id));
    expect(views[0].snapshotMode).toBe("none");
    expect(views[0].workspaceSnapshot.beforeFiles).toBe(0);
    expect(views[0].checkpoint.status).toBe("unavailable");
    expect(views[1].workspaceSnapshot.beforeFiles).toBe(1);
    expect(views[2].steps.map((s: any) => ({ id: s.id, index: s.index, name: s.name, status: s.status }))).toEqual([
      { id: "wf1:step-1", index: 0, name: "第一步", status: "ready" },
      { id: "wf1:step-2", index: 1, name: "第二步", status: "pending" },
    ]);
    expect(views[2].branchOfRunId).toBe("run_parent");
    expect(views[2].branchPointEntryId).toBe("entry-9");
    expect(views[2].model).toBe("deepseek/deepseek-chat");
    expect(views[2].references).toEqual([{ path: "ref.md" }]);
    expect(views[2].projectId).toBe("p1");
    expect(views[2].capabilityPlan).toEqual({ steps: 2 });
    expect(views[2].workflow).toEqual({ id: "wf1", name: "流程", valid: true, missing: [] });
    expect(views[2].currentStep).toBeNull();
  });
});

describe("B2-2 runs 生命周期：getRun / updateRunStep / recordRunEvent", () => {
  it("getRun 公开视图剥离快照；未知 id null", async () => {
    const run = runs.beginRun({ clientId: "c", threadId: "t", cwd: ws });
    const view = runs.getRun(run.id);
    expect(runs.getRun("run_missing")).toBeNull();
    expect("before" in view || "after" in view).toBe(false);
    expect(view.workspaceSnapshot.afterFiles).toBe(0);
  });

  it("updateRunStep：按 id 与按 index 定位/running 计数/completed 收口/未知返回 null", async () => {
    const run = runs.beginRun({ clientId: "c", threadId: "t", cwd: ws });
    const byIndex = runs.updateRunStep(run.id, 0, { status: "running" });
    const main = byIndex.steps.find((s: any) => s.id === `${run.id}:main`);
    const done = runs.updateRunStep(run.id, `${run.id}:main`, { status: "completed" });
    expect(main.attempts).toBe(2);
    expect(Boolean(main.startedAt)).toBe(true);
    expect(done.steps[0].status).toBe("completed");
    expect(Boolean(done.steps[0].finishedAt)).toBe(true);
    expect(done.events.filter((e: any) => e.type === "step_updated").map((e: any) => e.data))
      .toEqual([{ stepId: expect.any(String), status: "running" }, { stepId: expect.any(String), status: "completed" }]);
    expect(runs.updateRunStep(run.id, "no-such", { status: "done" })).toBeNull();
    expect(runs.updateRunStep("run_missing", 0, {})).toBeNull();
  });

  it("recordRunEvent：工具步骤族/touchedPaths 台账/runtime_health/runtime_error/assistant_final 重定向", async () => {
    const run = runs.beginRun({ clientId: "c", threadId: "t", cwd: ws });
    const id = run.id;
    runs.recordRunEvent(id, "tool_start", { name: "officecli", toolCallId: "tc1" });
    runs.recordRunEvent(id, "tool_end", { name: "officecli", toolCallId: "tc1", isError: true, error: "x".repeat(600) });
    runs.recordRunEvent(id, "write_started", { path: path.join(ws, "out", "报告.docx"), toolCallId: "tc2" });
    runs.recordRunEvent(id, "runtime_health", { status: "degraded", note: "慢" });
    runs.recordRunEvent(id, "runtime_error", { message: "Pi 挂了", runtime: { model: "m" } });
    runs.recordRunEvent(id, "assistant_final", { text: "终稿文本", source: "agent" });
    const view = runs.getRun(id);
    const toolStep = view.steps.find((s: any) => s.id === `${id}:tool:tc1`);
    expect(toolStep).toMatchObject({ name: "处理 Office 文档", status: "failed" });
    expect(toolStep?.error?.length).toBe(500);
    expect(Boolean(toolStep?.finishedAt)).toBe(true);
    expect(view.touchedPaths).toEqual(["out/报告.docx"]);
    expect(view.runtimeHealth).toMatchObject({ status: "failed", message: "Pi 挂了" });
    expect(view.runtime).toMatchObject({ status: "degraded", model: "m" });
    expect(view.recovery).toMatchObject({ required: true, reason: "Pi 挂了" });
    expect(view.finalText).toBe("终稿文本");
    expect(view.finalTextVersion).toBe(1);
    expect(view.events.filter((e: any) => e.type === "assistant_final")).toHaveLength(1);
    expect(fs.readFileSync(path.join(eventDir, "事件流.jsonl"), "utf8").includes("tool_execution_start")).toBe(false);
  });
});

describe("B2-2 runs 生命周期：recordRunFinalText / checkpoint / todo", () => {
  it("recordRunFinalText：首写/幂等/改稿版本递增同位置/空文本", async () => {
    const run = runs.beginRun({ clientId: "c", threadId: "t", cwd: ws });
    const id = run.id;
    const first = runs.recordRunFinalText(id, "第一稿", { messageId: "msg-1" });
    const same = runs.recordRunFinalText(id, "第一稿", { messageId: "msg-1" });
    const revised = runs.recordRunFinalText(id, "第二稿", { messageId: "msg-1" });
    const empty = runs.recordRunFinalText(id, "   ");
    const view = runs.getRun(id);
    expect([first.changed, same.changed, revised.changed, empty.changed]).toEqual([true, false, true, false]);
    expect([first.event.data.version, revised.event.data.version]).toEqual([1, 2]);
    expect(first.event.seq === revised.event.seq).toBe(true);
    expect(view.events.filter((e: any) => e.type === "assistant_final")).toHaveLength(1);
    // view 在重定向之前捕获：finalText 仍是改稿后的"第二稿"；
    // recordRunEvent 的 assistant_final 重定向走 recordRunFinalText 幂等路径，版本递增到 3。
    expect(view.finalText).toBe("第二稿");
    expect(view.finalTextVersion).toBe(2);
    expect(Boolean(runs.recordRunEvent(id, "assistant_final", { text: "第三稿" }))).toBe(true);
    expect(runs.getRun(id).finalTextVersion).toBe(3);
  });

  it("updateRunCheckpoint：幂等不重复追加；变化才落事件", async () => {
    const run = runs.beginRun({ clientId: "c", threadId: "t", cwd: ws });
    const id = run.id;
    const before = runs.getRun(id).events.length;
    const noop = runs.updateRunCheckpoint(id, { native: false });
    // publicRunView 是浅拷贝：noop.events 与 run.events 是同一活引用，
    // 下面的 changed 会向同一数组 push，必须在 changed 之前先取数值快照。
    const noopLen = noop.events.length;
    runs.updateRunCheckpoint(id, { native: true, note: "升级" });
    const view = runs.getRun(id);
    expect(noopLen === before).toBe(true);
    // patch 合并不重算 status（只做 JSON 比对合并）：beginRun 无 sessionId → unavailable 保持。
    expect(view.checkpoint).toMatchObject({ native: true, note: "升级", status: "unavailable" });
    expect(view.events.filter((e: any) => e.type === "run_checkpoint_updated").map((e: any) => e.data.note)).toEqual(["升级"]);
    expect(runs.updateRunCheckpoint("run_missing", { a: 1 })).toBeNull();
  });

  it("updateRunTodo：规范化落库/签名一致 no-op/事件追加/非法 id null", async () => {
    const run = runs.beginRun({ clientId: "c", threadId: "t", cwd: ws });
    const id = run.id;
    runs.updateRunTodo(id, [{ title: "任务A", status: "todo" }, { title: "任务B", done: true }], { source: "plan" });
    const eventsAfterFirst = runs.getRun(id).events.filter((e: any) => e.type === "todo_updated").length;
    runs.updateRunTodo(id, [{ title: "任务A", status: "planned" }, { title: "任务B", status: "completed" }]);
    // 计数必须在每次调用后立即取数值快照（events 是活引用，后续调用会向同一数组 push）。
    const eventsAfterNoop = runs.getRun(id).events.filter((e: any) => e.type === "todo_updated").length;
    runs.updateRunTodo(id, [{ title: "任务C" }]);
    const eventsAfterSecond = runs.getRun(id).events.filter((e: any) => e.type === "todo_updated").length;
    // updateRunTodo 是整表替换语义：最后一次调用 [任务C] 覆盖了先前的 [任务A, 任务B]。
    expect(runs.getRun(id).todos.map((t: any) => ({ title: t.title, status: t.status, index: t.index }))).toEqual([{ title: "任务C", status: "planned", index: 0 }]);
    expect(runs.getRun(id).todoVersion).toBe(1);
    expect(eventsAfterFirst).toBe(1);
    expect(eventsAfterNoop === eventsAfterFirst).toBe(true);
    expect(eventsAfterSecond).toBe(2);
    expect(runs.updateRunTodo("a/b\\c!", [])).toBeNull();
  });
});

describe("B2-2 runs 生命周期：取消族 / recoverActiveRuns", () => {
  it("requestRunCancellation：活动态转 cancel_requested/重复幂等/待收尾表/非活动 no-op/clear", async () => {
    const run = runs.beginRun({ clientId: "c", threadId: "t", cwd: ws });
    const id = run.id;
    const first = runs.requestRunCancellation(id, "用户点停");
    const pending1 = runs.listPendingCancellations();
    const eventsLen1 = runs.getRun(id).events.filter((e: any) => e.type === "run_cancel_requested").length;
    const second = runs.requestRunCancellation(id, "再点");
    const finished = runs.finishRun(id, { status: "cancelled" });
    const pendingAfterFinish = runs.listPendingCancellations().length;
    const completedRun = runs.beginRun({ clientId: "c", threadId: "t", cwd: ws });
    runs.finishRun(completedRun.id, { status: "completed" });
    const inactive = runs.requestRunCancellation(completedRun.id);
    const cleared = runs.clearPendingCancellation(inactive.id);
    expect(first.status).toBe("cancel_requested");
    expect(first.cancelReason).toBe("用户点停");
    expect(Boolean(first.cancelRequestedAt)).toBe(true);
    expect(pending1.map((p: any) => ({ idIsRun: /^run_/.test(p.id), hasLastEventAt: Boolean(p.lastEventAt), hasRequestedAt: Boolean(p.cancelRequestedAt) })))
      .toEqual([expect.objectContaining({ idIsRun: true, hasLastEventAt: true, hasRequestedAt: true })]);
    expect(eventsLen1).toBe(1);
    expect(runs.getRun(id).events.filter((e: any) => e.type === "run_cancel_requested").length === eventsLen1).toBe(true);
    expect(second.status).toBe("cancel_requested");
    expect(finished.status).toBe("cancelled");
    expect(pendingAfterFinish).toBe(0);
    expect(inactive.status).toBe("completed");
    expect(cleared).toBe(false);
    expect(runs.listPendingCancellations().length).toBe(0);
  });

  it("recoverActiveRuns：running→recovering、recovering→失败收尾、completed 不动、allowList 生效", async () => {
    const runningId = seedRun({ status: "running" });
    const recoveringId = seedRun({ status: "recovering" });
    const queuedId = seedRun({ status: "queued" });
    const doneId = seedRun({ status: "completed", finishedAt: new Date().toISOString() });
    const first = runs.recoverActiveRuns({ onlyIds: [runningId] });
    const statusOf = (id: string) => runs.getRun(id)?.status ?? null;
    const second = runs.recoverActiveRuns();
    const recoveringView = runs.getRun(recoveringId);
    // readdir 顺序依赖文件系统，与实现无关：按「未收尾在前、收尾在后」稳定排序后比对。
    const stable = (list: string[]) => [...list].sort((a, b) => (a.endsWith("(收尾)") ? 1 : 0) - (b.endsWith("(收尾)") ? 1 : 0));
    // allowList 语义：onlyIds=[runningId] 时只有该 run 转 recovering（+已 recovering 的收尾），
    // 其余历史遗留 running 不受影响。
    expect(stable(first)).toHaveLength(2);
    expect(stable(first).filter((x: string) => x.endsWith("(收尾)"))).toHaveLength(1);
    // 二次调用后读取：runningId 已被收尾成 failed；recoveringId 首轮即被收尾；
    // queued 属活动态，无过滤的二次调用把它转入 recovering。
    expect([statusOf(runningId), statusOf(recoveringId), statusOf(queuedId), statusOf(doneId)]).toEqual(["failed", "failed", "recovering", "completed"]);
    expect(runs.getRun(runningId)?.recovery).toMatchObject({ required: true, reason: "服务重启后需要用户确认继续" });
    expect(runs.getRun(runningId)?.events.filter((e: any) => e.type === "run_recovered").length).toBe(1);
    // 二次无过滤调用会吞并此前用例遗留的活动 Run：只对收尾计数与规模下限做断言。
    expect(stable(second).filter((x: string) => x.endsWith("(收尾)"))).toHaveLength(1);
    expect(stable(second).length).toBeGreaterThan(2);
    expect(recoveringView?.status).toBe("failed");
    expect(recoveringView?.error ?? null).toBe("服务重启两次后未被恢复，任务已终止");
    expect(Boolean(recoveringView?.finishedAt)).toBe(true);
  });
});

describe("B2-2 runs 生命周期：finishRun", () => {
  it("happy path：快照 diff 产物/归属 unattributed/after blob/validation 映射/completion/run_finished/二次收尾幂等", async () => {
    fs.writeFileSync(path.join(ws, "a.md"), "v1");
    const run = runs.beginRun({ clientId: "c", threadId: "t", cwd: ws });
    await runs.awaitBeforeBlobs(run.id);
    fs.writeFileSync(path.join(ws, "a.md"), "v2-longer");
    fs.writeFileSync(path.join(ws, "b.md"), "new-file");
    const finished = runs.finishRun(run.id, {
      validations: [{ path: "b.md", status: "passed", message: "ok" }],
      completion: { status: "success", summary: "结论X" },
    });
    const again = runs.finishRun(run.id, { status: "completed" });
    const eventsLen = finished.events.length;
    expect(finished.status).toBe("completed");
    expect(finished.error).toBeNull();
    expect(finished.verificationStatus).toBe("passed");
    expect(finished.summary).toBe("结论X");
    expect(finished.snapshotTruncated).toBe(false);
    expect(finished.artifacts.map((a: any) => ({
      path: a.path, status: a.status, changeType: a.changeType, source: a.source, confidence: a.confidence,
      autoDeliverable: a.autoDeliverable, detectedBy: a.detectedBy, detectable: a.detectable,
      blobs: a.blobs, validationStatus: a.validation?.status ?? null, verificationStatus: a.verificationStatus,
      changeIdShape: /^change_[0-9a-f]{12}$/.test(a.changeId), runId: a.runId === run.id, artifactIdShape: /^artifact_/.test(a.artifactId),
    }))).toEqual([
      expect.objectContaining({ path: "a.md", status: "modified", changeType: "modified", source: "unattributed", confidence: "suspected", autoDeliverable: false, detectedBy: "snapshot", detectable: true, blobs: { before: true, after: true }, validationStatus: null, verificationStatus: "not_checked", changeIdShape: true, runId: true, artifactIdShape: true }),
      expect.objectContaining({ path: "b.md", status: "added", changeType: "added", source: "unattributed", confidence: "suspected", autoDeliverable: false, blobs: { before: false, after: true }, validationStatus: "passed", verificationStatus: "passed", changeIdShape: true, runId: true, artifactIdShape: true }),
    ]);
    expect(finished.staging.status).toBe("published");
    expect(finished.completion).toMatchObject({ status: "success", summary: "结论X" });
    expect(finished.completion.runId).toBeTruthy();
    expect(finished.steps.map((s: any) => s.status)).toEqual(["completed"]);
    expect(Boolean(finished.finishedAt)).toBe(true);
    expect(finished.events.filter((e: any) => e.type === "run_finished").map((e: any) => ({ status: e.data.status, artifacts: e.data.artifacts, verificationStatus: e.data.verificationStatus, finalText: e.data.finalText })))
      .toEqual([expect.objectContaining({ status: "completed", artifacts: 2, verificationStatus: "passed", finalText: null })]);
    expect(again.finishedAt === finished.finishedAt && again.events.length === eventsLen).toBe(true);
    // ws 跨用例累积：早前用例写入的文件可能落入 startedAt-2s 的 mtime 窗口，scanned 绝对值不稳定。
    expect(finished.changeDetection).toMatchObject({ source: "recent-mtime" });
    expect(finished.changeDetection.scanned).toBeGreaterThanOrEqual(2);
    expect(runs.getRun(run.id).workspaceSnapshot.afterFiles).toBeGreaterThanOrEqual(2);
  });

  it("校验失败：全失败落 failed/混合跳过失败件继续发布/failed 分支 discard", async () => {
    const allFailed = runs.beginRun({ clientId: "c", threadId: "t", cwd: ws });
    runs.finishRun(allFailed.id, { status: "completed", validations: [{ path: "x.docx", status: "failed", message: "坏" }] });
    const failedView = runs.getRun(allFailed.id);
    const mixed = runs.beginRun({ clientId: "c", threadId: "t", cwd: ws });
    runs.finishRun(mixed.id, { status: "completed", validations: [{ path: "p1.md", status: "passed" }, { path: "x.docx", status: "failed" }] });
    const mixedView = runs.getRun(mixed.id);
    const explicitFailed = runs.beginRun({ clientId: "c", threadId: "t", cwd: ws });
    runs.finishRun(explicitFailed.id, { status: "failed", error: "模型炸了" });
    const failedBranch = runs.getRun(explicitFailed.id);
    // summary 的「，产物校验发现问题」后缀只在有产物时拼接（artifacts.length 分支）；
    // 无产物时统一是"本轮未产生文件变更"。
    expect({ status: failedView.status, error: failedView.error, verificationStatus: failedView.verificationStatus, staging: failedView.staging.status, steps: failedView.steps.map((s: any) => s.status), summary: failedView.summary, finishedData: failedView.events.filter((e: any) => e.type === "run_finished").map((e: any) => e.data.status) })
      .toMatchObject({ status: "failed", error: "产物校验失败，未发布临时产物", verificationStatus: "failed", staging: "discarded", steps: ["failed"], summary: "本轮未产生文件变更", finishedData: ["failed"] });
    expect({ status: mixedView.status, verificationStatus: mixedView.verificationStatus, staging: mixedView.staging.status, summary: mixedView.summary })
      .toMatchObject({ status: "completed", verificationStatus: "failed", staging: "published", summary: "本轮未产生文件变更" });
    expect({ status: failedBranch.status, error: failedBranch.error, staging: failedBranch.staging.status, steps: failedBranch.steps.map((s: any) => s.status) })
      .toMatchObject({ status: "failed", error: "模型炸了", staging: "discarded", steps: ["failed"] });
  });

  it("临时文件清理（tempCleaned）与未完成待办降级（completion partial）", async () => {
    const run = runs.beginRun({ clientId: "c", threadId: "t", cwd: ws });
    await runs.awaitBeforeBlobs(run.id);
    fs.mkdirSync(path.join(ws, ".tmp_out"));
    fs.writeFileSync(path.join(ws, ".tmp_out", "notes.py"), "tmp");
    runs.recordRunEvent(run.id, "write_started", { path: ".tmp_out/notes.py" });
    runs.updateRunTodo(run.id, [{ title: "没做完的事" }]);
    const finished = runs.finishRun(run.id, { status: "completed", completion: { status: "success", summary: "S" } });
    expect(finished.tempCleaned ?? null).toEqual([".tmp_out/notes.py"]);
    expect(fs.existsSync(path.join(ws, ".tmp_out", "notes.py"))).toBe(false);
    expect(fs.existsSync(path.join(ws, ".tmp_out"))).toBe(false);
    expect(finished.completion).toMatchObject({ status: "partial", incomplete: ["没做完的事"], todoNote: "收尾时仍有 1 项待办未完成" });
    // write_cleaned 经 persistWriteEvent 落事件流（jsonl），不进 run.events。
    expect(fs.readFileSync(path.join(eventDir, "事件流.jsonl"), "utf8").includes("write_cleaned")).toBe(true);
  });
});

describe("B2-2 runs 生命周期：rollbackRun", () => {
  it("modified 恢复/added 删除/renamed 双向恢复/运行中拒绝", async () => {
    fs.writeFileSync(path.join(ws, "orig.txt"), "hello");
    fs.writeFileSync(path.join(ws, "moved.txt"), "MMM");
    const run = runs.beginRun({ clientId: "c", threadId: "t", cwd: ws });
    await runs.awaitBeforeBlobs(run.id);
    const runningRefusal = runs.rollbackRun(run.id);
    fs.writeFileSync(path.join(ws, "orig.txt"), "changed");
    fs.writeFileSync(path.join(ws, "new.txt"), "brand");
    fs.renameSync(path.join(ws, "moved.txt"), path.join(ws, "renamed.txt"));
    runs.recordRunEvent(run.id, "write_started", { path: path.join(ws, "orig.txt"), toolCallId: "tc1" });
    runs.recordRunEvent(run.id, "write_started", { path: path.join(ws, "new.txt"), toolCallId: "tc2" });
    runs.recordRunEvent(run.id, "write_started", { path: path.join(ws, "renamed.txt"), toolCallId: "tc3" });
    const finished = runs.finishRun(run.id, { status: "completed" });
    const artifactSources = finished.artifacts.map((a: any) => ({ path: a.path, status: a.status, from: a.from ?? null, source: a.source, confidence: a.confidence, toolCallId: a.toolCallId }));
    const rollback = runs.rollbackRun(run.id);
    const after = {
      orig: fs.readFileSync(path.join(ws, "orig.txt"), "utf8"),
      newGone: fs.existsSync(path.join(ws, "new.txt")),
      renamedGone: fs.existsSync(path.join(ws, "renamed.txt")),
      movedBack: fs.readFileSync(path.join(ws, "moved.txt"), "utf8"),
    };
    const partial = runs.rollbackRun(run.id, ["orig.txt"]);
    expect(runningRefusal).toEqual({ ok: false, error: "run not finished" });
    expect(artifactSources).toEqual([
      expect.objectContaining({ path: "new.txt", status: "added", source: "write-ledger", confidence: "confirmed", toolCallId: "tc2" }),
      expect.objectContaining({ path: "orig.txt", status: "modified", source: "write-ledger", confidence: "confirmed", toolCallId: "tc1" }),
      expect.objectContaining({ path: "renamed.txt", status: "renamed", from: "moved.txt", source: "write-ledger", confidence: "confirmed", toolCallId: "tc3" }),
    ]);
    expect(rollback.ok).toBe(true);
    expect([...rollback.restored].sort()).toEqual(["new.txt", "orig.txt", "renamed.txt"]);
    expect(after).toEqual({ orig: "hello", newGone: false, renamedGone: false, movedBack: "MMM" });
    expect(partial).toEqual({ ok: true, restored: ["orig.txt"] });
  });
});

describe("B2-2 runs 查询族：listRuns / listRunSummaries / runSummaryView / 验收 / 缓存", () => {
  it("列表过滤（threadId/cwd 大小写/status/query）/事件瘦身/runSummaryView 投影/summaries 排序", async () => {
    const r1 = runs.beginRun({ clientId: "c", threadId: "thread-A", sessionId: "sess-1", cwd: ws, task: { goal: "生成季度报表", mode: "agent" } });
    runs.finishRun(r1.id, { status: "completed" });
    const r2 = runs.beginRun({ clientId: "c", threadId: "thread-B", cwd: ws, task: { goal: "别的任务", mode: "chat" } });
    const r3 = runs.beginRun({ clientId: "c", threadId: "thread-A", cwd: ws, task: { goal: "另一件事", mode: "agent" } });
    void r2;
    void r3;
    const upperCwd = ws.toUpperCase();
    expect(runs.listRuns({ threadId: "thread-A" }).map((v: any) => v.task?.goal)).toEqual(["另一件事", "生成季度报表"]);
    // runsDir 为文件级模块状态、跨用例累积（所有 run 同 cwd），绝对数不稳定；
    // 改相对口径验证 cwd 过滤大小写不敏感：大写查询与原样查询命中同一集合。
    const byUpperCwd = runs.listRuns({ cwd: upperCwd }).length;
    expect(byUpperCwd).toBe(runs.listRuns({ cwd: ws }).length);
    expect(byUpperCwd).toBeGreaterThanOrEqual(3);
    // recoverActiveRuns 用例的无过滤调用已把此前累积的 running 全部转 recovering，
    // 但残留数量仍依赖用例结构；只验证过滤精度（结果全为 running）且本用例两个新 run 命中。
    const byStatus = runs.listRuns({ status: "running" }).map((v: any) => v.status);
    expect(byStatus.every((s: string) => s === "running")).toBe(true);
    expect(byStatus.length).toBeGreaterThanOrEqual(2);
    expect(runs.listRuns({ query: "季度" }).map((v: any) => v.task?.goal)).toEqual(["生成季度报表"]);
    expect(runs.listRuns({ mode: "chat" }).map((v: any) => v.task?.goal)).toEqual(["别的任务"]);
    // includeEvents none：events 被删除（hasEvents false）并以 eventCount 计数；
    // r1 已 finishRun（run_started + run_finished）eventCount=2、r3 running=1，只验下限。
    expect(runs.listRuns({ threadId: "thread-A", includeEvents: "none" }).every((v: any) => !Array.isArray(v.events) && v.eventCount >= 1)).toBe(true);
    expect(runs.listRuns({ threadId: "thread-B", includeEvents: "all" })[0].events.length >= 1).toBe(true);
    expect(runs.listRuns({ threadId: "thread-B" })[0].events.length >= 1).toBe(true);
    expect(runs.listRuns({ limit: 1 }).length).toBe(1);
    // run 本体无顶层 mode（mode 仅在 runIndexEntry 由 task.mode 派生，供 listRuns 过滤），
    // runSummaryView 的 mode 取 view.mode || "" → 空串。
    expect(runs.runSummaryView(runs.getRun(r1.id))).toMatchObject({ id: expect.any(String), status: "completed", mode: "", task: { goal: "生成季度报表", title: "" }, summary: "本轮未产生文件变更", verificationStatus: "not_checked", eventCount: 0, workflow: null });
    expect(runs.runSummaryView(null)).toBeNull();
    // summaries 相对口径：返回数 = min(limit, runsDir 内 Run 文件数)（runsDir 跨用例累积）。
    const totalRunFiles = fs.readdirSync(runsDir).filter((n: string) => n.endsWith(".json")).length;
    expect(runs.listRunSummaries({ limit: 10 }).length).toBe(Math.min(10, totalRunFiles));
    expect(runs.listRunSummaries({ limit: 1 }).length).toBe(1);
    void r2;
  });

  it("updateRunAcceptance 落库与产物映射；外部改盘指纹失效重读；stagedVisible 关闭态投影", async () => {
    const run = runs.beginRun({ clientId: "c", threadId: "t", cwd: ws });
    runs.finishRun(run.id, { status: "completed" });
    const accepted = runs.updateRunAcceptance(run.id, { status: "passed", readyToPublish: true, artifacts: [{ path: "whatever.md", status: "passed" }] });
    // 外部改盘：loadRun 按 mtime+size 指纹失效
    const file = path.join(runsDir, `${run.id}.json`);
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    onDisk.externalMarker = "touched";
    fs.writeFileSync(file, JSON.stringify(onDisk));
    const reread = runs.getRun(run.id);
    // stagedVisible 关闭态（默认）：运行中的暂存写入不投影成产物。
    // flag 开启态由 b2-runs-parity-staged-flag.test.ts 覆盖——RUNTIME_FLAGS Object.freeze
    // 且 env 只在 import 时读取，无法就地变异。
    const flagRun = runs.beginRun({ clientId: "c", threadId: "t", cwd: ws });
    runs.recordRunEvent(flagRun.id, "write_started", { path: "报告.docx" });
    const stagedOff = runs.getRun(flagRun.id);
    expect(accepted).toMatchObject({ acceptanceStatus: "passed", acceptanceReadyToPublish: true });
    expect("before" in accepted).toBe(true);
    expect(reread?.externalMarker ?? null).toBe("touched");
    expect(stagedOff.artifacts?.filter((a: any) => a.source === "staged").length ?? 0).toBe(0);
  });
});
