#!/usr/bin/env node
/**
 * 事件负载结构校验测试（Qoder 对标 P1-2）。
 *
 * P1-2 的机制是「只对注册表里**声明了 schema** 的事件做结构校验，且默认关、只告警不阻断」。
 * 因此本测试守护四件事：
 *   1) 校验器语义：合法通过 / 缺必填 → missing / 类型不符 → wrongType / 未声明 → skipped；
 *   2) 首批覆盖：报告要求「首批只覆盖本次新增/改动事件 + 4 个 HITL/终态事件」，
 *      这些事件必须都声明 schema（防回退），且 schema 不能过严——真实发射点的最小载荷也要通过；
 *   3) 接线：默认关时 `appendEvent` 不进入校验分支；打开后违规经
 *      `eventSchemaViolationsSnapshot()` 计数暴露（进程内诊断，不落盘、不改事件语义）；
 *   4) 端到端 A/B（子进程 + 环境变量，用**不落盘**事件做，零副作用）：
 *      OAW_EVENT_SCHEMA_CHECK=1 → 非法负载计数 1、合法负载不计；不设变量 → 一条都不计。
 *
 * 用法：node scripts/event-payload-validation-test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateEventPayload, eventSpec } from "../server/event-registry.mjs";
import { shouldPersistEvent } from "../server/event-storage.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const 读 = (...段) => fs.readFileSync(path.join(ROOT, ...段), "utf8");

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); } catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
};

/** 首批事件（报告 §P1-2：本次新增/改动的事件 + 4 个 HITL/终态事件）与其真实载荷样本。 */
const 首批 = {
  run_draining: { runId: "run_x", reason: "abort" },
  aborted: { runId: "run_x" },
  run_finished: { runId: "run_x", status: "completed", artifacts: [] },
  tool_end: { name: "read", isError: false },
  ask_user: { askId: "ask_1", question: "要覆盖哪一年？", options: ["2024", "2025"] },
  tool_approval_request: { id: "ap_1", tool: "officecli", action: "ask", input: "set ...", runId: null },
  interaction_owner_changed: { owner: { kind: "subagent", id: "child_1" }, status: "running" },
  tool_output_delta: { output: "chunk", index: 1, frames: 3, toolCallId: null, name: null },
};

/* ---------------- 1) 校验器语义 ---------------- */

test("合法负载通过（首批 8 个事件逐一）", () => {
  for (const [类型, 载荷] of Object.entries(首批)) {
    const r = validateEventPayload(类型, 载荷);
    assert.equal(r.skipped, false, `${类型} 应声明了 schema`);
    assert.equal(r.ok, true, `${类型} 的样本被判非法：missing=${r.missing} wrongType=${r.wrongType}`);
  }
});

test("缺必填字段 → missing 命中且不抛错", () => {
  const r = validateEventPayload("run_finished", { status: "completed" });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ["runId"]);
  const r2 = validateEventPayload("ask_user", {});
  assert.deepEqual(r2.missing.sort(), ["askId", "question"]);
});

test("字段类型不符 → wrongType 命中（含 null 视为缺失而非类型错）", () => {
  const r = validateEventPayload("run_finished", { runId: 123, status: "completed" });
  assert.equal(r.missing.length, 0, "数字 123 不算缺失");
  assert.deepEqual(r.wrongType, ["runId 期望 string"]);
  const r2 = validateEventPayload("run_finished", { runId: null, status: "completed" });
  assert.deepEqual(r2.missing, ["runId"], "null 应算缺失（required 语义）");
});

test("未声明 schema 的事件 → skipped（存量 100+ 事件不受影响）", () => {
  assert.equal(eventSpec("token")?.schema, undefined, "token 不应声明 schema");
  const r = validateEventPayload("token", { anything: 1 });
  assert.equal(r.skipped, true);
  assert.equal(r.ok, true);
});

test("可空字段不参与校验：字段缺失或为 null 都不报错", () => {
  // tool_approval_request 的 runId 在基线里就是 null（会话级审批），schema 刻意不含它
  assert.equal(validateEventPayload("tool_approval_request", { id: "ap_1", tool: "bash", runId: null }).ok, true);
  // tool_end 的 isError 缺失也应通过（types 只在字段存在时检查）
  assert.equal(validateEventPayload("tool_end", { name: "read" }).ok, true);
});

/* ---------------- 2) 首批覆盖（防回退 + 防过严） ---------------- */

test("首批 8 个事件在注册表里都声明了 schema", () => {
  for (const 类型 of Object.keys(首批)) {
    assert.ok(eventSpec(类型)?.schema, `${类型} 未声明 schema（P1-2 首批覆盖回退）`);
  }
});

test("schema 不过严：只给必填字段、其余字段全空的最小载荷也必须通过", () => {
  const 最小 = {
    run_draining: { runId: "run_x" },
    aborted: { runId: "run_x" },
    run_finished: { runId: "run_x", status: "failed" },
    tool_end: { name: "read" },
    ask_user: { askId: "a", question: "q" },
    tool_approval_request: { id: "i", tool: "bash" },
    interaction_owner_changed: { owner: {} },
    tool_output_delta: { output: "" },
  };
  for (const [类型, 载荷] of Object.entries(最小)) {
    const r = validateEventPayload(类型, 载荷);
    assert.equal(r.ok, true, `${类型} 的最小载荷被拦下：${JSON.stringify(r)}`);
  }
});

test("schema 字段确实出现在对应事件的发射点（静态契约）", () => {
  const 发射点文件 = {
    run_draining: ["server/agent.mjs"],
    aborted: ["server/agent.mjs"],
    run_finished: ["server/index.mjs"],
    tool_end: ["server/agent.mjs"],
    ask_user: ["server/agent.mjs"],
    tool_approval_request: ["server/approval-policy.mjs"],
    interaction_owner_changed: ["server/agent.mjs"],
    tool_output_delta: ["server/stream-connection.mjs"],
  };
  for (const [类型, 文件们] of Object.entries(发射点文件)) {
    const schema = eventSpec(类型).schema;
    const 源码 = 文件们.map((f) => 读(...f.split("/"))).join("\n");
    for (const 字段 of [...(schema.required || []), ...Object.keys(schema.types || {})]) {
      assert.ok(
        new RegExp(`(^|[\\s{,])${字段}\\s*:`).test(源码),
        `${类型} 的 schema 字段 ${字段} 在 ${文件们.join("、")} 的发射点里找不到`,
      );
    }
  }
});

/* ---------------- 3) 接线 ---------------- */

test("接线：默认关时 appendEvent 不进入校验分支，且校验失败只告警+计数（不阻断落盘）", () => {
  const 存储 = 读("server", "event-storage.mjs");
  assert.match(存储, /if \(RUNTIME_FLAGS\.eventSchemaCheck\) noteEventSchemaCheck\(type, data\);/, "缺少开关门控的校验调用");
  assert.match(存储, /function noteEventSchemaCheck\(type, data\)/, "缺少告警计数实现");
  assert.match(存储, /schemaViolations: eventSchemaViolationsSnapshot\(\)/, "违规计数未经事件状态只读暴露");
  // 校验发生在落盘判定之前，且不改变返回值/落盘行为
  const 调用位置 = 存储.indexOf("noteEventSchemaCheck(type, data)");
  const 落盘判定 = 存储.indexOf("if (!shouldPersistEvent(type))");
  assert.ok(调用位置 > 0 && 调用位置 < 落盘判定, "校验应早于落盘判定，且不介入其分支");
  assert.equal(shouldPersistEvent("tool_output_delta"), false, "增量分片事件不落盘（端到端测试据此做到零副作用）");
});

/* ---------------- 4) 端到端 A/B（子进程） ---------------- */

const 模块URL = pathToFileURL(path.join(ROOT, "server", "event-storage.mjs")).href;
const 子脚本 = `
import { appendEvent, eventSchemaViolationsSnapshot } from ${JSON.stringify(模块URL)};
appendEvent({ type: "tool_output_delta", data: { index: 0, frames: 2 } });          // 缺 output → 应告警
appendEvent({ type: "tool_output_delta", data: { output: "ok", index: 0, frames: 2 } }); // 合法 → 不告警
process.stdout.write("___RESULT___" + JSON.stringify(eventSchemaViolationsSnapshot()));
`;
const 跑子进程 = (开) => {
  const 输出 = execFileSync(process.execPath, ["--input-type=module", "-e", 子脚本], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...(开 ? { OAW_EVENT_SCHEMA_CHECK: "1" } : {}) },
  });
  const i = 输出.indexOf("___RESULT___");
  assert.ok(i >= 0, "子进程未返回结果：" + 输出.slice(-200));
  return JSON.parse(输出.slice(i + "___RESULT___".length));
};

test("端到端 A/B：开关打开时非法负载计数 1（合法负载不计）", () => {
  const 违规 = 跑子进程(true);
  assert.equal(违规.length, 1, `应只记 1 种事件违规，实际 ${JSON.stringify(违规)}`);
  assert.equal(违规[0].type, "tool_output_delta");
  assert.equal(违规[0].count, 1);
  assert.deepEqual(违规[0].missing, ["output"]);
});

test("端到端 A/B：默认关时同一非法负载不产生任何告警", () => {
  assert.deepEqual(跑子进程(false), [], "默认关时不应产生任何校验告警（行为与基线一致）");
});

console.log(failed ? "\n事件负载结构校验测试：存在失败" : "\n事件负载结构校验测试：全部通过");
process.exitCode = failed ? 1 : 0;
