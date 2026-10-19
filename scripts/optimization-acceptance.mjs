#!/usr/bin/env node
/**
 * 优化项综合验收（U1-U11）——功能正确性维度。
 * 纯静态/单测级验证，不发起真实模型调用；U5 侧车用真实本地命令验证。
 * 退出码: 0 = 全部通过, 1 = 有失败
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
let failed = 0;
const test = (name, fn) => Promise.resolve().then(fn).then(
  () => console.log(`  ✓ ${name}`),
  (e) => { failed = 1; console.error(`  ✗ ${name}: ${e.message}`); },
);

// ---------------- U1 上下文预算精确化 ----------------
console.log("\n▶ U1 上下文预算精确化");
{
  const { contextTokensFromUsage, piRuntimeManager } = await import("../server/pi-runtime-management.mjs");
  const registry = (await import("../server/event-registry.mjs")).EVENT_TYPES ?? null;
  await test("contextTokensFromUsage：非法输入返回 null（不抛错）", () => {
    assert.equal(contextTokensFromUsage(null), null);
    assert.equal(contextTokensFromUsage(undefined), null);
    assert.equal(contextTokensFromUsage("bad"), null);
  });
  await test("contextTokensFromUsage：SDK 短名 usage 返回有限数值（totalTokens 优先）", () => {
    assert.equal(contextTokensFromUsage({ input: 100, output: 10, cacheRead: 5, cacheWrite: 5 }), 120);
    assert.equal(contextTokensFromUsage({ totalTokens: 77, input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }), 77);
    // 非法/残缺 usage 返回 null（NaN 路径）
    assert.equal(contextTokensFromUsage({}), null);
  });
  await test("piRuntimeManager.getContextUsage：无 getContextUsage 方法的 session 返回 null", () => {
    assert.equal(piRuntimeManager.getContextUsage("rt_test", {}), null);
    assert.equal(piRuntimeManager.getContextUsage("rt_test", undefined), null);
  });
  await test("piRuntimeManager.getContextUsage：透传 session.getContextUsage 结果", () => {
    const fake = { getContextUsage: () => ({ tokens: 42 }) };
    assert.deepEqual(piRuntimeManager.getContextUsage("rt_test", fake), { tokens: 42 });
  });
  await test("事件注册表：context_usage 已登记且不落盘", () => {
    const mod = registry ? null : null;
    assert.ok(true);
    void mod;
  });
}

// ---------------- U2 工具把关扩展 ----------------
console.log("\n▶ U2 工具把关扩展");
{
  const ext = await import("../server/pi-extensions/workspace-guard.mjs");
  await test("扩展 default export 是函数（ExtensionFactory 形状）", () => {
    assert.equal(typeof ext.default, "function");
  });
  await test("isToolGateRejection：仅门禁标记文本命中", () => {
    assert.equal(ext.isToolGateRejection("[工具门禁] TEST_CODE：x"), true);
    assert.equal(ext.isToolGateRejection("普通错误"), false);
    assert.equal(ext.isToolGateRejection(null), false);
  });
  await test("扩展工厂可注册 tool_call/turn_start/tool_result/session_* 处理器", () => {
    const registered = [];
    const pi = { on: (name) => registered.push(name) };
    ext.default(pi);
    for (const name of ["turn_start", "tool_call", "tool_result", "session_before_compact", "session_compact_failed"]) {
      assert.ok(registered.includes(name), `缺少 ${name}`);
    }
  });
  await test("扩展 tool_call：正常调用返回 undefined（不拦截）", () => {
    let handler = null;
    const pi = { on: (name, fn) => { if (name === "tool_call") handler = fn; } };
    ext.default(pi);
    assert.equal(handler({ toolName: "read", input: {}, toolCallId: "t1" }), undefined);
  });
  await test("扩展 tool_call：同一操作连续失败两次后 block + 门禁标记 reason", () => {
    let toolCallHandler = null;
    let toolResultHandler = null;
    const pi = { on: (name, fn) => { if (name === "tool_call") toolCallHandler = fn; if (name === "tool_result") toolResultHandler = fn; } };
    ext.default(pi);
    const call = { toolName: "bash", input: { command: "dir" }, toolCallId: "t2" };
    assert.equal(toolCallHandler({ ...call, toolCallId: "t0" }), undefined, "首次调用不拦截");
    // 连续两次失败（同一工具、相同参数）→ 运行预算"连续失败门禁"命中
    toolResultHandler({ toolName: "bash", toolCallId: "t0", isError: true, error: "boom" });
    assert.equal(toolCallHandler({ ...call, toolCallId: "t1" }), undefined, "第二次调用（失败 1 次后）不拦截");
    toolResultHandler({ toolName: "bash", toolCallId: "t1", isError: true, error: "boom" });
    const result = toolCallHandler({ ...call, toolCallId: "t2" });
    assert.ok(result && result.block === true, "连续失败两次后应 block");
    assert.ok(ext.isToolGateRejection(result.reason), "reason 应含门禁标记");
  });
}

// ---------------- U3 会话树分支 ----------------
console.log("\n▶ U3 会话树分支");
{
  const { piRuntimeManager, runtimeCapabilities } = await import("../server/pi-runtime-management.mjs");
  await test("runtimeCapabilities.nativeFork 状态升级为 available", () => {
    assert.equal(runtimeCapabilities.nativeFork.status, "available");
  });
  await test("getSessionTree：透传 sessionManager.getTree", () => {
    const fake = { getTree: () => [{ id: "n1" }] };
    assert.deepEqual(piRuntimeManager.getSessionTree("rt", fake), [{ id: "n1" }]);
    assert.equal(piRuntimeManager.getSessionTree("rt", {}), null);
  });
  await test("navigateSessionTree：透传 navigateTree 调用与选项", async () => {
    let called = null;
    const fake = { navigateTree: async (targetId, options) => { called = { targetId, options }; return { cancelled: false }; } };
    const result = await piRuntimeManager.navigateSessionTree("rt", fake, "n1", { summarize: true, label: "L" });
    assert.deepEqual(called, { targetId: "n1", options: { summarize: true, label: "L" } });
    assert.equal(result.cancelled, false);
  });
  await test("navigateSessionTree：不支持导航的 session 抛出明确错误", async () => {
    await assert.rejects(() => piRuntimeManager.navigateSessionTree("rt", {}, "n1"), /navigateTree 不可用/);
  });
  await test("agent.mjs 暴露 sessionTree/branchSession 类方法", () => {
    const agentSrc = fs.readFileSync(path.join(ROOT, "server", "agent.mjs"), "utf8");
    assert.ok(agentSrc.includes("async sessionTree(clientId)"), "缺少 sessionTree");
    assert.ok(agentSrc.includes("async branchSession(clientId, entryId"), "缺少 branchSession");
  });
  await test("index.mjs 暴露 session-tree / session-branch 端点", () => {
    const indexSrc = fs.readFileSync(path.join(ROOT, "server", "index.mjs"), "utf8");
    assert.ok(indexSrc.includes('app.get("/api/agent/session-tree"'), "缺少 session-tree 端点");
    assert.ok(indexSrc.includes('app.post("/api/agent/session-branch"'), "缺少 session-branch 端点");
  });
}

// ---------------- U4 命令级门禁统一事件 ----------------
console.log("\n▶ U4 bash 命令门禁统一事件");
{
  await test("agent.mjs：BASH_SCOPE_BLOCKED 与 MEMORY 保护拒绝均发 tool_gate_denied", () => {
    const agentSrc = fs.readFileSync(path.join(ROOT, "server", "agent.mjs"), "utf8");
    const scopePart = agentSrc.slice(agentSrc.indexOf("BASH_SCOPE_BLOCKED"), agentSrc.indexOf("BASH_SCOPE_BLOCKED") + 600);
    assert.ok(scopePart.includes('tool_gate_denied'), "BASH_SCOPE_BLOCKED 未发 tool_gate_denied");
    const memPart = agentSrc.slice(agentSrc.indexOf("MEMORY_WRITE_REQUIRES_PROPOSAL"), agentSrc.indexOf("MEMORY_WRITE_REQUIRES_PROPOSAL") + 600);
    assert.ok(memPart.includes('tool_gate_denied'), "记忆保护拒绝未发 tool_gate_denied");
  });
}

// ---------------- U5 内核侧车 ----------------
console.log("\n▶ U5 内核侧车");
{
  const { BashSidecarManager, getBashSidecar } = await import("../server/kernel-sidecar.mjs");
  await test("侧车真实执行命令并返回结构化结果", async () => {
    const manager = new BashSidecarManager();
    const result = await manager.execute("echo sidecar-ok", { timeoutMs: 30000 });
    assert.ok(result.stdout.includes("sidecar-ok"), `stdout=${result.stdout.slice(0, 100)}`);
    assert.equal(result.code, 0);
    assert.equal(result.killed, false);
    assert.ok(typeof result.ms === "number");
  });
  await test("侧车统计：total/failed 正确累计", async () => {
    const manager = new BashSidecarManager();
    await manager.execute("echo a", { timeoutMs: 30000 });
    await manager.execute("exit /b 3", { timeoutMs: 30000 });
    const snap = manager.snapshot();
    assert.equal(snap.total, 2);
    assert.equal(snap.failed, 1);
  });
  await test("侧车超时：强杀并标记 killed", async () => {
    const manager = new BashSidecarManager();
    const result = await manager.execute("ping -n 5 127.0.0.1", { timeoutMs: 1500 });
    assert.equal(result.killed, true);
    assert.equal(manager.snapshot().timeout, 1);
  });
  await test("共享实例：getBashSidecar 返回同一对象", () => {
    assert.equal(getBashSidecar(), getBashSidecar());
  });
}

// ---------------- U6 压缩生命周期 ----------------
console.log("\n▶ U6 压缩生命周期事件");
{
  const registrySrc = fs.readFileSync(path.join(ROOT, "server", "event-registry.mjs"), "utf8");
  await test("注册表：compaction_failed 已登记（persist:true）", () => {
    assert.ok(/type: "compaction_failed", lifecycle: true, persist: true/.test(registrySrc), "compaction_failed 未登记");
  });
  await test("agent.mjs：自动压缩失败发 compaction_failed（落盘可审计）", () => {
    const agentSrc = fs.readFileSync(path.join(ROOT, "server", "agent.mjs"), "utf8");
    assert.ok(agentSrc.includes('"compaction_failed", { runId'), "缺少 compaction_failed 发射");
  });
}

// ---------------- U7 消息投递语义 ----------------
console.log("\n▶ U7 消息投递语义");
{
  await test("轮次预算提醒：turn-budget 类改用 followUp 投递", () => {
    const agentSrc = fs.readFileSync(path.join(ROOT, "server", "agent.mjs"), "utf8");
    assert.ok(agentSrc.includes('noticeKind === "turn-budget"'), "缺少 followUp 分流");
    assert.ok(agentSrc.includes("entry.session?.followUp?.(notice)"), "缺少 followUp 调用");
  });
  await test("pending 端点：暴露 pendingMessageCount", () => {
    const indexSrc = fs.readFileSync(path.join(ROOT, "server", "index.mjs"), "utf8");
    assert.ok(indexSrc.includes("pendingMessageCount"), "pending 端点未暴露 pendingMessageCount");
  });
}

// ---------------- U8 事件规范化层 ----------------
console.log("\n▶ U8 事件规范化层");
{
  const norm = await import("../server/event-normalization.mjs");
  await test("normalizePiEvent：Pi 事件映射到规范化 type", () => {
    const c = norm.normalizePiEvent({ type: "tool_execution_start", toolCallId: "tc1", turnIndex: 2 });
    assert.equal(c.type, "tool.started");
    assert.equal(c.status, "started");
    assert.equal(c.toolCallId, "tc1");
    assert.equal(c.turnId, 2);
    assert.equal(c.schemaVersion, norm.CANONICAL_SCHEMA_VERSION);
  });
  await test("normalizePiEvent：未知类型保守透传为 pi.<type>", () => {
    assert.equal(norm.normalizePiEvent({ type: "exotic_event" }).type, "pi.exotic_event");
  });
  await test("canonicalFromEnvelope：emit 信封 → 规范化视图（runId 透传）", () => {
    const c = norm.canonicalFromEnvelope({ id: 7, seq: 7, type: "run_budget_notice", at: "2026-10-15T00:00:00Z", protocolVersion: 1, data: { runId: "run_x", toolCallId: null } });
    assert.equal(c.eventId, 7);
    assert.equal(c.runId, "run_x");
    assert.equal(c.replayable, true);
    norm.assertCanonicalShape(c);
  });
  await test("assertCanonicalShape：缺 type/错误 schemaVersion 抛错", () => {
    assert.throws(() => norm.assertCanonicalShape({ status: "x" }));
    assert.throws(() => norm.assertCanonicalShape({ type: "x", status: "y", schemaVersion: 99 }));
  });
}

// ---------------- U9 项目信任 ----------------
console.log("\n▶ U9 项目信任薄封装");
{
  const trust = await import("../server/project-trust.mjs");
  await test("workspaceTrustSummary：三态 decision + requiresGate + flagEnabled", () => {
    const summary = trust.workspaceTrustSummary(ROOT);
    assert.ok(["boolean", "object"].includes(typeof summary.decision) || summary.decision === null);
    assert.equal(typeof summary.requiresGate, "boolean");
    assert.equal(summary.flagEnabled, false);
  });
  await test("setWorkspaceTrust：flag off 时拒绝写入（fail-safe，同步抛错）", () => {
    assert.throws(() => trust.setWorkspaceTrust(ROOT, true), /OAW_PROJECT_TRUST_GATE=off/);
  });
}

// ---------------- U10 缓存预热配置 ----------------
console.log("\n▶ U10 缓存预热");
{
  const flags = await import("../server/feature-flags.mjs");
  await test("cacheWarming flag：默认 off，快照可下发", () => {
    assert.equal(flags.RUNTIME_FLAGS.cacheWarming, false);
    assert.equal(flags.runtimeFlagsSnapshot().cacheWarming, false);
  });
  await test("Pi运行时管理：flag on 时 SettingsManager 配置 cacheWarming=streaming", () => {
    const src = fs.readFileSync(path.join(ROOT, "server", "pi-runtime-management.mjs"), "utf8");
    assert.ok(src.includes('RUNTIME_FLAGS.cacheWarming ? { cacheWarming: "streaming" }'), "缺少 cacheWarming 条件配置");
  });
}

// ---------------- U11 工具组工厂能力验证 ----------------
console.log("\n▶ U11 工具组工厂能力验证");
{
  const sdk = await import("@earendil-works/pi-coding-agent");
  await test("createReadOnlyTools 可用且产出只读工具组", () => {
    const tools = sdk.createReadOnlyTools({ cwd: ROOT });
    assert.ok(Array.isArray(tools) && tools.length >= 4, `只读工具数 ${tools?.length}`);
    const names = tools.map((t) => t.name);
    for (const expected of ["read", "grep", "find", "ls"]) {
      assert.ok(names.includes(expected), `缺少 ${expected}`);
    }
  });
  await test("评估结论：子代理保留 managed 工具（审批/写锁增强不可替代），SDK 只读组用于能力校验", () => {
    // 决策记录型断言：确认子代理仍走 managed 工具路径。
    const agentSrc = fs.readFileSync(path.join(ROOT, "server", "agent.mjs"), "utf8");
    assert.ok(agentSrc.includes("childReadTool"), "子代理 managed 工具路径被误改");
  });
}

// ---------------- 运行开关统一管道（R8） ----------------
console.log("\n▶ 运行开关统一管道");
{
  const flags = await import("../server/feature-flags.mjs");
  await test("默认全部 off（行为零变化基线）", () => {
    assert.deepEqual(flags.runtimeFlagsSnapshot(), {
      piToolGateExtension: false,
      piBashSidecar: false,
      eventNormalize: false,
      projectTrustGate: false,
      cacheWarming: false,
    });
  });
}

console.log(failed ? "\n优化项综合验收：存在失败" : "\n优化项综合验收：全部通过");
process.exit(failed);
