#!/usr/bin/env node
/**
 * 子代理编排器测试（P1-C / P2-B，方案 §3.2–§3.6）。
 * 只测纯逻辑（server/subagent-orchestrator.mjs），执行器（Pi 子会话）注入模拟实现；
 * agent.mjs 的接线由集成测试覆盖。
 *
 * 用法: node scripts/subagent-orchestrator-test.mjs
 * 退出码: 0 = 全部通过, 1 = 有失败
 */
import assert from "node:assert/strict";
import {
  SUBAGENT_ROLES,
  SUBAGENT_CONCURRENCY,
  SUBAGENT_MAX_TASKS,
  SUBAGENT_REVISE_ROUNDS,
  resolveRole,
  childIdFor,
  parseVerdict,
  buildVerifierTask,
  summarizeResults,
  orchestrateSubagents,
} from "../server/subagent-orchestrator.mjs";

let failed = 0;
const test = (name, fn) => Promise.resolve().then(fn).then(
  () => console.log(`  ✓ ${name}`),
  (e) => { failed = 1; console.error(`  ✗ ${name}: ${e.message}`); },
);

console.log("\n▶ 角色定义与解析（P1-C）");
test("五个角色且只读/可写分级正确", () => {
  for (const role of ["scout", "reviewer", "planner", "verifier"]) {
    assert.equal(SUBAGENT_ROLES[role].readOnly, true, `${role} 应只读`);
    assert.ok(SUBAGENT_ROLES[role].tools.includes("read"));
    assert.ok(!SUBAGENT_ROLES[role].tools.includes("write"), `${role} 不应有写工具`);
  }
  assert.equal(SUBAGENT_ROLES.worker.readOnly, false);
  assert.ok(SUBAGENT_ROLES.worker.tools.includes("officecli"));
});
test("超时分级：worker 最长、scout/planner 最短", () => {
  assert.ok(SUBAGENT_ROLES.worker.timeoutMs > SUBAGENT_ROLES.scout.timeoutMs);
  assert.equal(SUBAGENT_ROLES.scout.timeoutMs, 60000);
  assert.equal(SUBAGENT_ROLES.reviewer.timeoutMs, 120000);
});
test("resolveRole：未知角色回 scout，worker 无写权限降级", () => {
  assert.equal(resolveRole("worker", { canWrite: false }), "scout");
  assert.equal(resolveRole("worker", { canWrite: true }), "worker");
  assert.equal(resolveRole("不存在的角色", {}), "scout");
  assert.equal(resolveRole("verifier", { canWrite: false }), "verifier");
});
test("childIdFor 稳定且净化非法字符", () => {
  assert.equal(childIdFor("call_1", 0, false), "subagent_call_1");
  assert.equal(childIdFor("call_1", 1, true), "subagent_call_1_2");
  assert.equal(childIdFor("a/b\\c", 0, false), "subagent_a_b_c");
});

console.log("\n▶ verifier 判定解析");
test("解析「判定：revise」与检查清单", () => {
  const parsed = parseVerdict("- 数据来源：缺失\n- 结论与文件一致：通过\n判定：revise");
  assert.equal(parsed.verdict, "revise");
  assert.equal(parsed.checklist.length, 2);
  assert.equal(parsed.checklist[0].ok, false);
  assert.equal(parsed.checklist[1].ok, true);
});
test("解析 JSON verdict 与 fail 关键词", () => {
  assert.equal(parseVerdict('{"verdict":"fail"}').verdict, "fail");
  assert.equal(parseVerdict("结论不成立\n判定：fail").verdict, "fail");
});
test("无明确判定时 fail-safe 为 pass", () => {
  assert.equal(parseVerdict("看起来没问题").verdict, "pass");
});
test("buildVerifierTask 包含任务、结论与判定格式要求", () => {
  const task = buildVerifierTask({ task: "统计人口", output: "约 120 万" });
  assert.ok(task.includes("统计人口"));
  assert.ok(task.includes("120 万"));
  assert.match(task, /判定：pass/);
});

console.log("\n▶ 编排：fan-out + 对抗核验 + revise 回环（P2-B）");
await test("planned→started→result→verified→closed 事件序 + revise 回环一次", async () => {
  const events = [];
  let workerRuns = 0;
  let verifierRuns = 0;
  const result = await orchestrateSubagents({
    tasks: ["任务甲", "任务乙"],
    role: "worker",
    roleSpec: SUBAGENT_ROLES.worker,
    toolKey: "call1",
    parentToolCallId: "call1",
    verify: true,
    emit: (type, data) => events.push({ type, childId: data.childId, verdict: data.verdict ?? null, finalStatus: data.finalStatus ?? null }),
    runTask: async (task, ctx) => {
      if (ctx.roleOverride === "verifier") {
        verifierRuns += 1;
        const round = Number(String(ctx.childId).match(/_v(\d+)/)?.[1] || 0);
        return { text: round === 1 ? "- 覆盖不全：缺失\n判定：revise" : "- 已补齐：通过\n判定：pass", isError: false, childId: ctx.childId };
      }
      workerRuns += 1;
      return { text: `交付 ${workerRuns}`, isError: false, childId: ctx.childId };
    },
  });
  assert.equal(workerRuns, 4, "2 个子任务各跑 2 轮（revise 一次）");
  assert.equal(verifierRuns, 4, "每个子任务每轮核验一次");
  const types = events.map((e) => e.type);
  assert.ok(types.includes("subagent_planned"));
  assert.ok(types.includes("subagent_started"));
  assert.ok(types.includes("subagent_result"));
  assert.ok(types.includes("subagent_verified"));
  assert.ok(types.includes("subagent_closed"));
  // 每个子任务都以 closed 收尾，且第二轮核验后 pass
  const closed = events.filter((e) => e.type === "subagent_closed");
  assert.equal(closed.length, 2);
  for (const item of closed) assert.equal(item.finalStatus, "completed");
  // 每个子任务都经历 revise→pass 两轮核验；最终判定（最后一次 verified）应为 pass
  const verdicts = events.filter((e) => e.type === "subagent_verified").map((e) => e.verdict);
  const verdictByChild = new Map();
  for (const event of events) {
    if (event.type === "subagent_verified") verdictByChild.set(event.childId, event.verdict);
  }
  assert.deepEqual([...verdictByChild.values()].sort(), ["pass", "pass"]);
  assert.equal(verdicts.filter((v) => v === "revise").length, 2, "每个子任务第一轮核验应为 revise");
  assert.equal(result.isError, false);
  // 事件都带 parentToolCallId（G3：按 toolCallId 归属）——由 emit 参数断言在调用方侧验证
});
await test("所有子代理事件都带 parentToolCallId（G3 契约）", async () => {
  const events = [];
  await orchestrateSubagents({
    tasks: ["只读检索"],
    role: "scout",
    roleSpec: SUBAGENT_ROLES.scout,
    toolKey: "call2",
    parentToolCallId: "tool-call-xyz",
    emit: (type, data) => events.push({ type, parent: data.parentToolCallId }),
    runTask: async (task, ctx) => ({ text: "ok", isError: false, childId: ctx.childId }),
  });
  assert.ok(events.length >= 4);
  for (const event of events) assert.equal(event.parent, "tool-call-xyz", `${event.type} 必须携带 parentToolCallId`);
});
await test("scout 不触发核验；并发受限（SUBAGENT_CONCURRENCY）", async () => {
  let concurrent = 0;
  let peak = 0;
  const events = [];
  await orchestrateSubagents({
    tasks: ["a", "b", "c", "d"],
    role: "scout",
    roleSpec: SUBAGENT_ROLES.scout,
    toolKey: "call3",
    verify: true, // scout 不应核验
    emit: (type) => events.push(type),
    runTask: async (task, ctx) => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 20));
      concurrent -= 1;
      return { text: task, isError: false, childId: ctx.childId };
    },
  });
  assert.equal(peak, SUBAGENT_CONCURRENCY, `峰值并发应等于 ${SUBAGENT_CONCURRENCY}`);
  assert.ok(!events.includes("subagent_verified"), "scout 任务不做核验");
});
await test("超过 SUBAGENT_MAX_TASKS 的任务被裁剪", async () => {
  const seen = [];
  await orchestrateSubagents({
    tasks: ["1", "2", "3", "4", "5", "6"],
    role: "planner",
    roleSpec: SUBAGENT_ROLES.planner,
    toolKey: "call4",
    emit: () => {},
    runTask: async (task, ctx) => { seen.push(task); return { text: task, isError: false, childId: ctx.childId }; },
  });
  assert.equal(seen.length, SUBAGENT_MAX_TASKS);
});
await test("执行器抛错不中断其它子任务，错误子任务关账 failed", async () => {
  const closed = [];
  const result = await orchestrateSubagents({
    tasks: ["会炸", "正常"],
    role: "scout",
    roleSpec: SUBAGENT_ROLES.scout,
    toolKey: "call5",
    emit: (type, data) => { if (type === "subagent_closed") closed.push({ id: data.childId, status: data.finalStatus }); },
    runTask: async (task) => {
      if (task.includes("会炸")) throw new Error("boom");
      return { text: "fine", isError: false, childId: "x" };
    },
  });
  assert.equal(closed.filter((item) => item.status === "failed").length, 1);
  assert.equal(closed.filter((item) => item.status === "completed").length, 1);
  assert.equal(result.results.find((item) => item.text.includes("fine")).status, "completed");
});
await test("signal 已中止时子任务直接关账 cancelled", async () => {
  const controller = new AbortController();
  controller.abort();
  const closed = [];
  await orchestrateSubagents({
    tasks: ["a"],
    role: "scout",
    roleSpec: SUBAGENT_ROLES.scout,
    toolKey: "call6",
    signal: controller.signal,
    emit: (type, data) => { if (type === "subagent_closed") closed.push(data.finalStatus); },
    runTask: async () => ({ text: "不应执行", isError: false, childId: "x" }),
  });
  assert.deepEqual(closed, ["cancelled"]);
});
await test("summarizeResults 多任务带标题、附核验结论", () => {
  const text = summarizeResults([
    { text: "结果一", isError: false, verify: { verdict: "pass" } },
    { text: "结果二", isError: false, verify: { verdict: "revise" } },
  ]);
  assert.match(text, /### 子任务 1/);
  assert.match(text, /结果一/);
  assert.match(text, /需修订/);
});

console.log("\n▶ revise 回环上限");
test("SUBAGENT_REVISE_ROUNDS = 1（方案 §3.6）", () => {
  assert.equal(SUBAGENT_REVISE_ROUNDS, 1);
});

console.log(failed ? "\n子代理编排器测试：存在失败" : "\n子代理编排器测试：全部通过");
process.exit(failed);
