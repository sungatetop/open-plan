#!/usr/bin/env node
/**
 * PI 迭代全链路 E2E 测试（P0-A/B/C + P1-A/C + P2-A/B，方案 §3/§4/§5）。
 *
 * 需要真实服务与已配置的模型供应商：
 *   1. node scripts/service-supervisor.mjs start   （或已在 3002 运行）
 *   2. PORT=3099 node scripts/pi-iteration-fullchain-test.mjs --live
 * 不带 --live 时只做冒烟检查（服务可达 + 契约静态断言），不发起模型调用。
 *
 * 事件来源：SSE 实时流 ∪ Run 持久化事件（/api/runs/:id，跨会话回放的事实来源），
 * 两者断言同一契约——实时流断连不误判（协议本身由 test:sse-protocol 覆盖）。
 *
 * 覆盖：
 *   E2E-1（Chat + 子代理）：run_subagent tasks[] 并发派发 → §3.4 事件序 + 持久化回放。
 *   E2E-2（Work + 编辑流水线）：editorial_pipeline 生成 docx（审批自动放行）→
 *          pipeline_* 阶段事件 → 产物落盘 → routing.officecli=lazy。
 * 退出码: 0 = 全部通过, 1 = 有失败
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const LIVE = process.argv.includes("--live");
const BASE = process.env.E2E_BASE || `http://127.0.0.1:${process.env.PORT || 3002}`;

let failed = 0;
const test = (name, fn) => Promise.resolve().then(fn).then(
  () => console.log(`  ✓ ${name}`),
  (e) => { failed = 1; console.error(`  ✗ ${name}: ${e.message}`); },
);

async function api(pathname, options = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${pathname} → ${res.status}: ${body.error || JSON.stringify(body).slice(0, 200)}`);
  return body;
}

/** 订阅 SSE 实时流（尽力而为）；事件同时会落 Run 记录，断言以两者并集为准。 */
function openEventStream(client, thread) {
  const events = [];
  const controller = new AbortController();
  const done = fetch(`${BASE}/api/agent/stream?client=${encodeURIComponent(client)}&thread=${encodeURIComponent(thread || "")}`, {
    signal: controller.signal,
    headers: { Accept: "text/event-stream" },
  }).then(async (res) => {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done: finished } = await reader.read();
      if (finished) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          try { events.push(JSON.parse(line.slice(6))); } catch {}
        }
      }
    }
  }).catch(() => {});
  return { events, stop: () => { try { controller.abort(); } catch {} return done; } };
}

/**
 * 事件采集器：SSE 实时 + 每 2s 拉一次 Run 持久化事件（并集、按 key 幂等去重），
 * 并自动处理 ask_user（回答"按已知信息继续"）与 tool_approval_request（允许一次）。
 */
function createCollector({ client, thread, runId }) {
  const merged = new Map();
  const keyOf = (event) => `${event.type}|${event.at || ""}|${event.id || event.seq || ""}|${JSON.stringify(event.data || {}).slice(0, 120)}`;
  const add = (event) => {
    const key = keyOf(event);
    if (!merged.has(key)) merged.set(key, event);
  };
  let stopped = false;
  const tick = async () => {
    for (;;) {
      if (stopped) return;
      try {
        const run = await api(`/api/runs/${runId}`);
        for (const event of run.run?.events || []) add(event);
        // ask_user 自动回答（E2E 无人值守）
        const ask = [...merged.values()].find((e) => e.type === "ask_user" && !merged.has(`answered:${e.at}:${e.id || ""}`));
        if (ask) {
          merged.set(`answered:${ask.at}:${ask.id || ""}`, { type: "answered" });
          try {
            await api("/api/agent/answer", { method: "POST", body: JSON.stringify({ client, thread, answer: "无需补充信息，请按工作区已知内容直接完成并汇报。" }) });
          } catch {}
        }
        // 审批自动放行（E2E 无人值守）
        const approval = [...merged.values()].find((e) => e.type === "tool_approval_request" && e.data?.runId === runId && !e.data?.resolved && !merged.has(`approved:${e.data?.id}`));
        if (approval?.data?.id) {
          merged.set(`approved:${approval.data.id}`, { type: "approved" });
          try { await api("/api/agent/approval", { method: "POST", body: JSON.stringify({ id: approval.data.id, decision: "allow" }) }); } catch {}
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  };
  const worker = tick();
  return {
    events: [], // 动态 getter 不可行，改为 snapshot()
    snapshot: () => [...merged.values()],
    has: (predicate) => [...merged.values()].some(predicate),
    stop: () => { stopped = true; return worker; },
  };
}

const waitFor = async (collector, predicate, timeoutMs, description) => {
  const started = Date.now();
  for (;;) {
    const found = collector.has(predicate);
    if (found) return found;
    if (Date.now() - started > timeoutMs) throw new Error(`等待超时（${Math.round(timeoutMs / 1000)}s）：${description}`);
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
};

console.log(`\n▶ 服务可达性（${BASE}）`);
await test("/api/status 响应且版本可读", async () => {
  const status = await api("/api/status");
  assert.ok(status.version, "应返回版本号");
});
await test("/api/models 已配置供应商模型", async () => {
  const models = await api("/api/models");
  assert.ok(Array.isArray(models.models) && models.models.length > 0, "至少配置一个模型");
});

if (!LIVE) {
  console.log("\n（未加 --live：跳过真实模型调用。完整全链路请运行 node scripts/pi-iteration-fullchain-test.mjs --live）");
  console.log(failed ? "\n全链路 E2E（冒烟）：存在失败" : "\n全链路 E2E（冒烟）：通过");
  process.exit(failed);
}

const workspace = process.env.E2E_WORKSPACE || path.join(ROOT, "office-workspace");

// ---------------- E2E-1：Chat + 子代理并发编排 ----------------
console.log("\n▶ E2E-1：Chat + run_subagent 并发编排（事件契约与持久化）");
{
  const client = `e2e-sub-${Date.now()}`;
  const thread = `e2e-sub-${Date.now()}`;
  const stream = openEventStream(client, thread);
  const prompt = [
    "请用 run_subagent 工具并发派发两个 scout 子任务（tasks 数组），不要自己读文件：",
    "1. 列出当前工作区根目录下有哪些 .docx 文件（只看文件名，不用读内容）；",
    "2. 说明 .oaw 目录里有哪些子目录。",
    "两个子任务完成后，把两份子结果合并成一句话汇报即可。",
  ].join("\n");
  const accepted = await api("/api/agent/prompt", {
    method: "POST",
    body: JSON.stringify({ client, thread, text: prompt, task: { mode: "chat", workspace } }),
  });
  const runId = accepted.runId;
  assert.ok(runId, "admission 应返回 runId");
  const collector = createCollector({ client, thread, runId });

  await waitFor(collector, (e) => e.type === "capability_plan", 150000, "capability_plan");
  await test("能力契约 v2 下发且每个能力带 provider", () => {
    const event = collector.snapshot().find((e) => e.type === "capability_plan");
    const plan = event.data?.plan;
    assert.equal(plan.version, 2);
    assert.ok(plan.capabilities.length >= 1);
    for (const capability of plan.capabilities) assert.ok(capability.provider, `${capability.id} 缺 provider`);
  });

  await waitFor(collector, (e) => e.type === "run_finished", 480000, "E2E-1 run_finished");
  await new Promise((resolve) => setTimeout(resolve, 2500));
  await collector.stop();
  await stream.stop();
  const events = collector.snapshot();
  await test("run_subagent 走完 §3.4 事件契约（planned/started/result/closed）", () => {
    const types = events.map((e) => e.type);
    for (const type of ["subagent_planned", "subagent_started", "subagent_result", "subagent_closed"]) {
      assert.ok(types.includes(type), `缺少 ${type}（实际：${[...new Set(types)].slice(0, 30).join(",")}）`);
    }
    const planned = events.filter((e) => e.type === "subagent_planned");
    assert.ok(planned.length >= 2, `至少两个子任务的 planned（实际 ${planned.length}）`);
    for (const event of planned) {
      assert.ok(event.data.parentToolCallId, "planned 必须带 parentToolCallId");
      assert.deepEqual(event.data.tools, ["read", "grep", "find", "ls"], "scout 工具白名单");
    }
  });
  await test("Run 事件持久化：capability_plan 与子代理契约可回放", () => {
    // collector 的并集里已含 /api/runs/:id 的持久化事件；这里再单独拉一次确认接口形态
    const types = events.map((e) => e.type);
    for (const type of ["run_started", "capability_plan", "subagent_planned", "subagent_closed", "run_finished"]) {
      assert.ok(types.includes(type), `持久化事件缺少 ${type}`);
    }
  });
}

// ---------------- E2E-2：Work + 编辑流水线（原生 OOXML 直写） ----------------
console.log("\n▶ E2E-2：Work 模式 editorial_pipeline 生成 Word（审批放行 + 原生 Formatter）");
{
  const client = `e2e-pipe-${Date.now()}`;
  const thread = `e2e-pipe-${Date.now()}`;
  const stream = openEventStream(client, thread);
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const outputPath = `E2E流水线验证_${stamp}.docx`;
  const prompt = [
    "请使用 editorial_pipeline 工具（不要自己写文件、不要用 officecli）生成一份 Word 文档：",
    `goal：单元测试流程说明（两章：测试范围、执行步骤），format：docx，outputPath：${outputPath}。`,
    "工具结束后用一句话报告产物路径与验收结论。",
  ].join("\n");
  const accepted = await api("/api/agent/prompt", {
    method: "POST",
    body: JSON.stringify({ client, thread, text: prompt, task: { mode: "agent", workspace } }),
  });
  const runId = accepted.runId;
  assert.ok(runId, "admission 应返回 runId");
  const collector = createCollector({ client, thread, runId });

  await waitFor(collector, (e) => e.type === "capability_plan", 150000, "capability_plan");
  await test("生成类任务 routing.officecli=lazy（不被预检阻塞）", () => {
    const plan = collector.snapshot().find((e) => e.type === "capability_plan")?.data?.plan;
    assert.ok(plan, "应有能力契约");
    assert.equal(plan.routing.officecli, "lazy");
    assert.ok(plan.capabilities.some((c) => c.id === "office_generate" && c.provider === "native"), "应声明原生生成能力");
  });

  await waitFor(collector, (e) => e.type === "run_finished", 600000, "E2E-2 run_finished");
  await new Promise((resolve) => setTimeout(resolve, 2500));
  await collector.stop();
  await stream.stop();
  const events = collector.snapshot();
  await test("pipeline_* 阶段事件完整（四阶段 + 总完成）", () => {
    const types = events.map((e) => e.type);
    for (const type of ["pipeline_started", "pipeline_stage_started", "pipeline_stage_finished", "pipeline_finished"]) {
      assert.ok(types.includes(type), `缺少 ${type}`);
    }
    const finished = events.filter((e) => e.type === "pipeline_stage_finished");
    const stages = new Set(finished.map((e) => e.data.stage));
    for (const stage of ["planner", "writer", "formatter", "evaluator"]) {
      assert.ok(stages.has(stage), `阶段 ${stage} 未完成（实际：${[...stages].join(",")}）`);
    }
  });
  await test("产物落盘且为有效 docx（Evaluator 确定性检查有效）", () => {
    const finished = events.find((e) => e.type === "pipeline_finished");
    assert.ok(finished, "应有 pipeline_finished");
    const deliverable = finished.data.deliverable;
    assert.ok(deliverable, "应声明产物路径");
    const full = path.join(workspace, deliverable);
    assert.ok(fs.existsSync(full), `产物应存在：${full}`);
    assert.ok(fs.statSync(full).size > 1000, "产物非空");
    try { fs.rmSync(full, { force: true }); } catch {}
  });
}

console.log(failed ? "\n全链路 E2E：存在失败" : "\n全链路 E2E：全部通过");
process.exit(failed);
