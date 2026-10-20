import { describe, it, expect } from "vitest";
import {
  LIFECYCLE_LABELS, TERMINAL_LIFECYCLES,
  isTerminalLifecycle, lifecycleLabel, normalizeLifecycle,
  isInternalChangePath, normalizeFileChange,
  deriveWorkPhase, deriveTimeline,
  projectRunView, adaptLegacyRunSummary, projectLegacyRunSummary,
  upsertRunSummaryMessage, associateRunMessages,
} from "../src/renderer/lib/run-display-projection";

const clientModule = await import("../../client/src/run-display-projection.js");
const client = clientModule as any;

const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();
const NOW = T0 + 600 * 1000;

function ev(type: string, data: Record<string, unknown> = {}, seconds = 0, extra: Record<string, unknown> = {}) {
  return { type, data, at: at(seconds), ...extra };
}

describe("run-display-projection TS 版与 client 版等价（对拍）", () => {
  it("常量与生命周期：标签/终态/归一化全矩阵", () => {
    expect(LIFECYCLE_LABELS).toEqual(client.LIFECYCLE_LABELS);
    expect([...TERMINAL_LIFECYCLES]).toEqual([...client.TERMINAL_LIFECYCLES]);
    const statuses = ["queued", "pending", "admitting", "admitted", "running", "recovering", "recovery", "in_progress", "active",
      "waiting_user", "waiting_approval", "waiting_approval_user", "finalizing", "cancel_requested", "cancelling", "canceling",
      "completed", "success", "done", "finished", "failed", "error", "cancelled", "canceled", "aborted", "interrupted",
      "idle", "", "  ", "RUNNING", " Queued ", "未知状态", null, undefined, 42, {}, []];
    for (const s of statuses) {
      expect(normalizeLifecycle(s)).toBe(client.normalizeLifecycle(s));
      expect(isTerminalLifecycle(s)).toBe(client.isTerminalLifecycle(s));
      expect(lifecycleLabel(s)).toBe(client.lifecycleLabel(s));
    }
    expect(normalizeLifecycle("admitting")).toBe("running");
    expect(normalizeLifecycle("")).toBe("unknown");
    expect(lifecycleLabel(undefined)).toBe("状态待同步");
  });

  it("isInternalChangePath：内部/缓存/临时/隐藏文件全模式", () => {
    const paths = [".oaw/x.json", "a/.oaw/y", "node_modules/r/e.js", "x/__pycache__/m.pyc", "p/.venv/lib", "q/venv/x",
      ".git/config", "sub/.git/HEAD", ".cache/f", ".pytest_cache/v", "pkg/dist-info/x", ".turbo/x", ".parcel-cache/x",
      ".hidden", "dir/.env", "._icon", "dir/._n", "~$报告.docx", "dir/~$a.xlsx",
      "a.tmp", "b.temp", "c.log", "d.bak", "e.old", "f.orig", "g.pyc", "h.pyo", "i.swp", "j.swo",
      ".agent-context.md", "正常.md", "dir/正常.md", "node_modules_x/正常.md", "data.temporary", "", null, undefined, 42, "  "];
    for (const p of paths) {
      expect(isInternalChangePath(p)).toBe(client.isInternalChangePath(p));
    }
  });

  it("normalizeFileChange：角色分级/验收/发布/前后快照/归属", () => {
    const cases: Array<[Record<string, unknown> | undefined, Record<string, unknown> | undefined]> = [
      [{ relativePath: "docs/a.md", changeType: "created", acceptanceStatus: "passed" }, undefined],
      [{ path: ".git/config", status: "modified" }, undefined],
      [{ relativePath: "x.tmp" }, undefined],
      [{ relativePath: "y.md", acceptance: { status: "warning" } }, undefined],
      [{ relativePath: "z.md", publication: { at: "T" } }, undefined],
      [{ relativePath: "z2.md", publicationStatus: "published" }, undefined],
      [{ relativePath: "w.md" }, undefined],
      [{ relativePath: "w2.md", changeType: "renamed" }, undefined],
      [{ relativePath: "w3.md", status: "removed" }, undefined],
      [{ relativePath: "w4.md", changeType: "什么都不是" }, undefined],
      [{ relativePath: "lead/a.md", source: "write-ledger", acceptanceStatus: "manual_review" }, undefined],
      [{ relativePath: "win/a.md", source: "run-window" }, undefined],
      [{ relativePath: "una/a.md", source: "unattributed" }, undefined],
      [{ relativePath: "sus/a.md", confidence: "suspected" }, undefined],
      [{ relativePath: "both.md", before: { hash: "h1", size: 10, reversible: true }, after: { hash: "h2", size: 20 } }, undefined],
      [{ relativePath: "size.md", size: 33 }, undefined],
      [{ relativePath: "both2.md", before: "truthy非对象", after: 0, size: 5 }, undefined],
      [{ relativePath: "meta.md", changeId: "ch1", workspaceId: "ws1", cwd: "C:/w", toolCallId: "t1", publishedAt: "P", runId: "own" }, { runId: "opt" }],
      [{ relativePath: "no-meta.md" }, { runId: "opt" }],
      [{ path: "反斜杠\\路径.md" }, undefined],
      [{}, undefined],
      [undefined, undefined],
    ];
    for (const [input, opts] of cases) {
      expect(normalizeFileChange(input as Record<string, unknown>, opts as { runId?: unknown } | undefined))
        .toEqual(client.normalizeFileChange(input, opts));
    }
    const d = normalizeFileChange({ relativePath: "docs/a.md", changeType: "created", acceptanceStatus: "passed" });
    expect(d.role).toBe("deliverable");
    expect(d.changeType).toBe("added");
    expect(normalizeFileChange({ relativePath: "una/a.md", source: "unattributed" })).toMatchObject({ attributed: false, unattributed: true, role: "unclassified" });
  });

  it("deriveWorkPhase：前进/验证→执行重试/回退忽略", () => {
    const events = [
      ev("run_admitting", {}, 0),
      ev("todo_updated", {}, 1),
      ev("tool_start", {}, 2),
      ev("artifacts_validated", {}, 3),
      ev("tool_start", {}, 4), // 验证 → 执行：重试
      ev("artifacts_validated", {}, 5),
      ev("artifact_published", {}, 6),
      ev("run_admitting", {}, 7), // 回退忽略
      ev("run_finished", { status: "completed" }, 8), // done → delivering（workPhase 映射）
      ev("unknown_event", {}, 9),
      null, 42, "x",
    ];
    const d = deriveWorkPhase(events);
    const s = client.deriveWorkPhase(events);
    expect(d).toEqual(s);
    expect(d.phase).toBe("delivering");
    expect(d.attempts).toEqual({ planning: 1, executing: 2, verifying: 2, delivering: 1 });
    expect(d.retries).toBe(1);
    expect(d.trail).toHaveLength(6);
    expect(d.trail[0]).toEqual({ phase: "planning", at: at(0), attempt: 1, retry: false });
    expect(d.trail[3]).toMatchObject({ retry: true, attempt: 2 });
    expect(deriveWorkPhase([])).toEqual(client.deriveWorkPhase([]));
  });

  it("deriveTimeline：首末事件与分段耗时", () => {
    const events = [
      ev("run_admitted", {}, 0),
      ev("model_request_started", {}, 2),
      ev("token", {}, 3),
      ev("turn_ended", {}, 8),
      ev("artifacts_validated", {}, 9),
      ev("run_finished", {}, 12),
    ];
    const d = deriveTimeline(events);
    const s = client.deriveTimeline(events);
    expect(d).toEqual(s);
    expect(d.latencyToFirstEventMs).toBe(2000);
    expect(d.modelDurationMs).toBe(6000);
    expect(d.tailLatencyMs).toBe(4000);
    // 快照 finishedAt 优先 + 缺事件为 null
    const withRun = deriveTimeline(events, { finishedAt: at(20) });
    expect(withRun.finished).toBe(at(20));
    expect(withRun.tailLatencyMs).toBe(12000);
    expect(deriveTimeline([], {})).toEqual(client.deriveTimeline([], {}));
    // 非法时间字符串 → NaN（与 client 一致）
    const bad = deriveTimeline([ev("run_admitted", {}, 0).at ? { type: "run_admitted", at: "not-a-date" } : {}], {});
    expect(bad).toEqual(client.deriveTimeline([{ type: "run_admitted", at: "not-a-date" }], {}));
  });

  it("projectRunView：综合投影（快照权威/事件线索/等待/记忆建议/他 Run 过滤）", () => {
    const run = {
      runId: "run-1",
      status: "running",
      artifacts: [
        { relativePath: "交付/报告.docx", changeType: "added", acceptanceStatus: "passed", source: "write-ledger" },
        { relativePath: ".oaw/cache.tmp" },
        { relativePath: "中间产物.txt", source: "run-window" },
        { relativePath: "外部.bin", source: "unattributed", confidence: "suspected" },
        { path: "反斜杠\\路径.md", status: "modified", publicationStatus: "published" },
      ],
      finalText: "最终答复",
      finalMessageId: "m9",
      finalTextVersion: 3,
      completion: { status: "success", summary: "完成" },
      verificationStatus: "passed",
      validations: [{ status: "passed" }],
    };
    const events = [
      ev("run_admitting", { runId: "run-1" }, 0),
      ev("tool_start", { runId: "run-1", toolCallId: "c1", name: "write" }, 1),
      ev("file_changed", { runId: "run-1", files: ["交付/报告.docx", "新文件.txt", ".oaw/x.log"] }, 2),
      ev("tool_end", { runId: "run-1", toolCallId: "c1" }, 3),
      ev("assistant_final", { runId: "run-1", text: "事件终稿", messageId: "m1" }, 4),
      ev("memory_proposal", { runId: "run-1", id: "mp1" }, 5),
      ev("memory_proposal", { runId: "run-1", id: "mp1" }, 5),
      ev("memory_proposal", { id: "mp2" }, 5),
      ev("token", { runId: "run-1" }, 6),
      ev("steer", { runId: "run-1", source: "user" }, 7),
      ev("tool_start", { runId: "run-OTHER" }, 8),
      null, 42,
    ];
    const d = projectRunView(run, events, { now: NOW });
    const s = client.projectRunView(run, events, { now: NOW });
    expect(d).toEqual(s);
    expect(d.lifecycle).toBe("running");
    expect(d.answer).toEqual({ messageId: "m9", version: 3, text: "最终答复", source: "run" });
    expect(d.outcome).toEqual({ status: "success", summary: "完成" });
    expect(d.changes).toHaveLength(7); // 5 快照 + 2 事件新路径（报告.docx 与 .oaw 已知）
    expect(d.deliverables.map((c) => c.relativePath)).toEqual(["交付/报告.docx", "反斜杠/路径.md"]);
    expect(d.verification).toEqual({ status: "passed", label: "验收通过", checks: [{ status: "passed" }], source: "run" });
    expect(d.memoryProposalIds).toEqual(["mp1", "mp2"]);
    expect(d.progress.waitingKind).toBeNull();
    expect(d.progress.currentAction).toBe("插入新指令"); // steer 的 flowEventLabel 文案
    expect(d.meta).toEqual({ eventCount: 12, changeCount: 7, deliverableCount: 2, now: NOW }); // 13 项事件，剔除他 Run 1 项
    expect(d.trace.tools).toHaveLength(1);
  });

  it("projectRunView：等待审批/等待回答/事件推断生命周期与 provisional outcome", () => {
    // 审批未决 → waiting_approval（快照非终态才覆盖）
    const approvalEvents = [
      ev("tool_approval_request", { id: "a1", tool: "bash" }, 0),
      ev("tool_approval_request", { id: "a2", target: "写入" }, 1),
      ev("tool_approval_resolved", { id: "a1" }, 2),
      ev("tool_start", {}, 3),
    ];
    const d1 = projectRunView({ runId: "r", status: "running" }, approvalEvents, { now: NOW });
    expect(d1).toEqual(client.projectRunView({ runId: "r", status: "running" }, approvalEvents, { now: NOW }));
    expect(d1.lifecycle).toBe("waiting_approval");
    expect(d1.progress.waitingReason).toBe("等待你批准：写入");
    // 全部已决 → 不等待
    const resolved = [...approvalEvents, ev("tool_approval_resolved", { id: "a2" }, 4)];
    const d2 = projectRunView({ runId: "r", status: "running" }, resolved, { now: NOW });
    expect(d2.lifecycle).toBe("running");
    expect(d2.progress.waitingKind).toBeNull();
    // ask_user → waiting_user；answered 清除
    const askEvents = [ev("ask_user", { question: "选哪个？" }, 0)];
    const d3 = projectRunView({ runId: "r" }, askEvents, { now: NOW });
    expect(d3).toEqual(client.projectRunView({ runId: "r" }, askEvents, { now: NOW }));
    expect(d3.lifecycle).toBe("waiting_user");
    expect(d3.progress.waitingReason).toBe("等待你回答");
    expect(d3.progress.waitingKind).toBe("ask");
    const answered = [...askEvents, ev("ask_user_answered", {}, 1)];
    expect(projectRunView({ runId: "r" }, answered, { now: NOW }).lifecycle).toBe("unknown");
    // 终态快照不被 waiting 覆盖
    const d4 = projectRunView({ runId: "r", status: "completed" }, approvalEvents, { now: NOW });
    expect(d4.lifecycle).toBe("completed");
    // unknown 快照 + 事件推断（run_finished failed）
    const d5 = projectRunView({ runId: "r" }, [ev("run_finished", { status: "failed" }, 0)], { now: NOW });
    expect(d5).toEqual(client.projectRunView({ runId: "r" }, [ev("run_finished", { status: "failed" }, 0)], { now: NOW }));
    expect(d5.lifecycle).toBe("failed");
    expect(d5.terminal).toBe(true);
    expect(d5.outcome).toMatchObject({ status: "failed" });
    // 非终态 + 事件推断 completion → provisional
    const d6 = projectRunView({ runId: "r", status: "running" }, [ev("task_completed", { status: "success", summary: "显式" }, 0)], { now: NOW });
    expect(d6.outcome).toMatchObject({ status: "success", provisional: true });
    expect(d6.terminal).toBe(false);
  });

  it("projectRunView：answer 事件兜底与空投影", () => {
    const events = [ev("assistant_final", { text: "事件终稿", messageId: "m1" }, 0)];
    const d = projectRunView({ runId: "r" }, events, { now: NOW });
    const s = client.projectRunView({ runId: "r" }, events, { now: NOW });
    expect(d).toEqual(s);
    expect(d.answer).toEqual({ messageId: "m1", version: 0, text: "事件终稿", source: "event" });
    // 快照无 finalText，事件也无 → null
    expect(projectRunView({ runId: "r" }, [], { now: NOW }).answer).toBeNull();
    // runId 取 source.id 兜底；畸形 run/events 不抛错
    const junk = projectRunView(null as unknown as Record<string, unknown>, [null, 42, "x"] as unknown[], { now: NOW });
    expect(junk).toEqual(client.projectRunView(null, [null, 42, "x"], { now: NOW }));
    expect(junk.runId).toBeNull();
    expect(junk.meta.eventCount).toBe(3);
  });

  it("adaptLegacyRunSummary / projectLegacyRunSummary：旧 RunSummary 折算", () => {
    const message = {
      runId: "run-old",
      runStatus: "completed",
      completion: { status: "partial", summary: "部分完成" },
      verification: { status: "warning" },
      finalText: "权威终稿",
      artifacts: [{ path: "a.md" }],
      workspace: "C:/ws",
      products: ["b.txt", { path: "c.md" }],
      model: "deepseek",
    };
    const d = adaptLegacyRunSummary(message);
    const s = client.adaptLegacyRunSummary(message);
    expect(d).toEqual(s);
    expect(d.verificationStatus).toBe("warning");
    expect(d.cwd).toBe("C:/ws");
    // artifacts 缺失 → products 折算
    const fromProducts = adaptLegacyRunSummary({ products: ["b.txt", { path: "c.md" }] });
    expect(fromProducts.artifacts).toEqual([{ path: "b.txt", status: "modified" }, { path: "c.md" }]);
    expect(adaptLegacyRunSummary({})).toEqual(client.adaptLegacyRunSummary({}));
    // 投影：events 缺失用 message.events
    const view = projectLegacyRunSummary({ ...message, events: [ev("tool_start", {}, 0)] }, [], { now: NOW });
    expect(view).toEqual(client.projectLegacyRunSummary({ ...message, events: [ev("tool_start", {}, 0)] }, [], { now: NOW }));
    expect(view.runId).toBe("run-old");
    expect(view.answer).toEqual({ messageId: null, version: 0, text: "权威终稿", source: "run" });
    // 显式 events 优先
    const view2 = projectLegacyRunSummary(message, [ev("tool_end", {}, 0)], { now: NOW });
    expect(view2.meta.eventCount).toBe(1);
    expect(view2).toEqual(client.projectLegacyRunSummary(message, [ev("tool_end", {}, 0)], { now: NOW }));
  });

  it("upsertRunSummaryMessage：新建/合并复用/状态文案/flashFiles", () => {
    const base = { runId: "run-1", task: { mode: "editorial" }, references: ["r1"], workspace: "C:/ws" };
    // 新建（fresh → flashFiles）
    const d1 = upsertRunSummaryMessage([], {
      ...base, status: "completed", summary: "做完了", artifacts: [{ path: "a.md" }], model: "deepseek", eventCount: 9, events: [ev("tool_start", {}, 0)], finalText: "终稿", completion: { status: "success" }, reviewSources: ["s1"], fresh: true,
    }, { id: "msg-1", workspace: "C:/override", runMode: "agent", createdAt: NOW });
    const s1 = client.upsertRunSummaryMessage([], {
      ...base, status: "completed", summary: "做完了", artifacts: [{ path: "a.md" }], model: "deepseek", eventCount: 9, events: [ev("tool_start", {}, 0)], finalText: "终稿", completion: { status: "success" }, reviewSources: ["s1"], fresh: true,
    }, { id: "msg-1", workspace: "C:/override", runMode: "agent", createdAt: NOW });
    expect(d1).toEqual(s1);
    expect(d1[0]).toMatchObject({ role: "system", summary: true, text: "做完了", runStatus: "completed", flashFiles: true, status: "done", id: "msg-1", createdAt: NOW });
    expect(d1[0]?.products).toEqual(["a.md"]);
    expect(d1[0]?.runMode).toBe("editorial");
    // 更新：复用前值（artifacts/products/completion/createdAt 保留），fresh 不重播
    const prev = d1[0];
    const d2 = upsertRunSummaryMessage(d1, { runId: "run-1", status: "failed", summary: "失败收尾", model: "qwen" }, { createdAt: NOW + 1 });
    const s2 = client.upsertRunSummaryMessage(d1, { runId: "run-1", status: "failed", summary: "失败收尾", model: "qwen" }, { createdAt: NOW + 1 });
    expect(d2).toEqual(s2);
    expect(d2[0]).toMatchObject({ runStatus: "failed", text: "失败收尾", model: "qwen", flashFiles: true, createdAt: NOW, completion: { status: "success" } }); // flashFiles 继承前值（data.fresh!==true 时不重播但保留）
    expect(d2[0]?.artifacts).toEqual(prev?.artifacts);
    expect(d2[0]?.eventCount).toBe(9); // data 无 eventCount → 复用 previous
    // summary 缺失 → 状态文案兜底
    for (const [status, label] of [["failed", "失败"], ["cancelled", "已取消"], ["aborted", "已中断"], ["running", "执行中"], ["completed", "完成"], ["whatever", "状态待同步"], ["", "状态待同步"]] as Array<[string, string]>) {
      const d3 = upsertRunSummaryMessage([], { runId: "r2", status }, { createdAt: NOW });
      expect(d3[0]?.text).toBe(`本轮任务${label}`);
    }
    // 前 runStatus 复用
    const d4 = upsertRunSummaryMessage(d1, { runId: "run-1" }, { createdAt: NOW });
    expect(d4[0]?.runStatus).toBe("completed");
    expect(d4[0]?.text).toBe("做完了");
    // 无 runId → 仅 associate
    const msgs = [{ role: "assistant", text: "x" }, { role: "system", summary: true, runId: "r1", text: "y" }];
    expect(upsertRunSummaryMessage(msgs, {})).toEqual(client.upsertRunSummaryMessage(msgs, {}));
  });

  it("associateRunMessages：assistant/系统提醒关联、真实用户边界、跨 runId 排除", () => {
    const messages = [
      { role: "user", text: "开始任务" },
      { role: "assistant", text: "过程1" },
      { role: "user", text: "[系统提醒] 进度" },
      { role: "user", text: "真实插话" },
      { role: "assistant", text: "过程2", runId: "r2" },
      { role: "system", summary: true, runId: "r1", text: "结论" },
      { role: "assistant", text: "结论后" },
      { role: "system", summary: true, runId: "r2", text: "结论2" },
    ];
    const d = associateRunMessages(messages);
    const s = client.associateRunMessages(messages);
    expect(d).toEqual(s);
    // r1 的关联区间被 index3 真实用户消息截断：区间内只有 index4，且已属 r2 被排除
    expect(d[1]?.runId).toBeUndefined();
    expect(d[2]?.runId).toBeUndefined();
    expect(d[3]?.runId).toBeUndefined(); // 真实用户消息是分组边界
    expect(d[4]).toMatchObject({ runId: "r2" }); // 已属他 run：不改写
    expect(d[6]).toMatchObject({ runId: "r2" }); // r2 区间内的 assistant 正常关联
    // 已一致时不产生新数组
    const stable = [{ role: "assistant", text: "a", runId: "r1" }, { role: "system", summary: true, runId: "r1", text: "b" }];
    expect(associateRunMessages(stable)).toBe(stable);
    // 全提醒区间 + internalProcess 幂等
    const reminders = [
      { role: "assistant", text: "a" },
      { role: "user", text: "[系统提醒] x" },
      { role: "user", text: "系统提醒：y" },
      { role: "system", summary: true, runId: "r1", text: "b" },
    ];
    const d2 = associateRunMessages(reminders);
    expect(d2).toEqual(client.associateRunMessages(reminders));
    expect(d2[0]).toMatchObject({ runId: "r1" });
    expect(d2[1]).toMatchObject({ runId: "r1", internalProcess: true });
    expect(d2[2]).toMatchObject({ runId: "r1", internalProcess: true });
    // 空数组 / 非 summary 中间无 runId
    expect(associateRunMessages([])).toEqual([]);
    expect(associateRunMessages([{ role: "assistant", text: "孤立" }])).toEqual([{ role: "assistant", text: "孤立" }]);
  });
});
