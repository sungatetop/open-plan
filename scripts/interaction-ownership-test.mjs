#!/usr/bin/env node
/**
 * 交互（HITL）归属（Qoder P1-4）测试。
 *
 * 1) 行为（真实调用 server/approval-policy.mjs）：
 *    - 不传 owner → 审批载荷键集合与基线**逐字一致**（无 owner 键）；
 *    - 传合法 owner（turn / subagent / session）→ 载荷带规范化后的 owner；
 *    - 传非法 owner（未知 kind / 空 id）→ 一律丢弃，载荷回到基线形状。
 * 2) 接线不变式：子代理写回审批带 subagent 归属、子代理启动发 interaction_owner_changed、
 *    ask_user 带 turn/session 归属——三处都由开关 qoderInteractionOwner 门控；
 *    前端在两张 HITL 卡片上渲染归属标签；样式为纯追加。
 * 3) 开关管线实测：默认关；设环境变量后 RUNTIME_FLAGS 与快照均为开启态。
 *
 * 用法：node scripts/interaction-ownership-test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireToolApproval, resolveToolApproval, normalizeOwner, getApprovalMode, setApprovalMode } from "../server/approval-policy.mjs";
import { RUNTIME_FLAGS as 原始开关, runtimeFlagsSnapshot as 原始快照 } from "../server/feature-flags.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const 读取 = (...段) => fs.readFileSync(path.join(ROOT, ...段), "utf8");

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); } catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
};
const 异步 = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
};

const 基线键 = ["id", "tool", "input", "runId", "threadId", "workspace", "action"];

/** 真实调用一次审批：捕获载荷后立刻拒绝，避免留下挂起项与定时器。 */
async function 采集审批载荷(owner) {
  const 载荷列表 = [];
  const 挂起 = requireToolApproval({
    entry: { workspace: "", threadId: "t-owner", clientId: "c-owner" },
    // officecli 的 create 类命令在默认规则里是 ask（见 approval-policy.mjs 的 DEFAULT_RULES），
    // 因此无需改用户权限配置即可走到挂起分支。
    tool: "officecli",
    input: "create 报告/评估.docx",
    runId: "run-owner-1",
    threadId: "t-owner",
    workspace: "",
    emit: (type, data) => 载荷列表.push({ type, data }),
    owner,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  挂起.catch(() => {});
  const 请求 = 载荷列表.find((项) => 项.type === "tool_approval_request");
  if (请求?.data?.id) resolveToolApproval(请求.data.id, "deny");
  await 挂起.catch(() => {});
  return 请求?.data || null;
}

// 行为断言需要默认规则里的 ask 能真正走到挂起分支：权限模式为 auto 时 ask 会被自动放行，
// 因此临时切到 ask 并在 finally 里恢复原模式（无论断言成功与否都会还原）。
const 原模式 = getApprovalMode();
try {
  if (原模式 !== "ask") setApprovalMode("ask");

  await 异步("不传 owner：审批载荷键集合与基线逐字一致（无 owner 键）", async () => {
    const 载荷 = await 采集审批载荷(undefined);
    assert.ok(载荷, "未捕获到 tool_approval_request");
    assert.deepEqual(Object.keys(载荷), 基线键, `键集合被改动：${Object.keys(载荷).join(",")}`);
    assert.equal("owner" in 载荷, false, "开关关闭语义下不得出现 owner 键");
  });

  await 异步("传合法 owner：turn / subagent / session 三态均进入载荷", async () => {
    for (const kind of ["turn", "subagent", "session"]) {
      const 载荷 = await 采集审批载荷({ kind, id: `id-${kind}` });
      assert.deepEqual(载荷.owner, { kind, id: `id-${kind}` }, `${kind} 归属未进入载荷`);
      assert.deepEqual(Object.keys(载荷), [...基线键, "owner"], "owner 必须是新增键而非替换既有键");
    }
  });

  await 异步("传非法 owner：未知 kind / 空 id / 非对象 一律丢弃", async () => {
    for (const 非法 of [{ kind: "unknown", id: "x" }, { kind: "turn", id: "  " }, null, "subagent", 42]) {
      const 载荷 = await 采集审批载荷(非法);
      assert.equal("owner" in 载荷, false, `非法归属 ${JSON.stringify(非法)} 不应进入载荷`);
    }
  });
} finally {
  if (原模式 !== "ask") setApprovalMode(原模式);
}

test("normalizeOwner 是纯函数：只认三态 + 非空 id", () => {
  assert.equal(normalizeOwner(null), null);
  assert.deepEqual(normalizeOwner({ kind: "turn", id: " r1 " }), { kind: "turn", id: "r1" });
  assert.equal(normalizeOwner({ kind: "turn", id: "" }), null);
  assert.equal(normalizeOwner({ kind: "other", id: "r1" }), null);
});

const AGENT = 读取("server", "agent.mjs");
const 开关 = 读取("server", "feature-flags.mjs");
const 注册表 = 读取("server", "event-registry.mjs");
const 审批 = 读取("server", "approval-policy.mjs");
const CHAT = 读取("client", "src", "components", "ChatPanel.jsx");
const 样式 = 读取("client", "src", "styles.css");

test("事件注册表：interaction_owner_changed 已登记（生命周期 + 落盘）", () => {
  const 行 = 注册表.split("\n").find((项) => 项.includes('type: "interaction_owner_changed"'));
  assert.ok(行, "缺少 interaction_owner_changed 登记");
  assert.ok(行.includes("lifecycle: true") && 行.includes("persist: true"), "应为生命周期事件且落盘");
});

test("server：三处归属都由 qoderInteractionOwner 门控", () => {
  assert.ok(/owner: RUNTIME_FLAGS\.qoderInteractionOwner \? \{ kind: "subagent", id: childId \} : null/.test(AGENT),
    "子代理写回审批未带门控归属");
  assert.ok(/if \(RUNTIME_FLAGS\.qoderInteractionOwner\) \{\s*\n\s*emitChild\("interaction_owner_changed"/.test(AGENT),
    "子代理启动未在开关打开时发 interaction_owner_changed");
  assert.ok(/if \(RUNTIME_FLAGS\.qoderInteractionOwner\) \{\s*\n\s*askPayload\.owner = entry\.activeRunId/.test(AGENT),
    "ask_user 未在开关打开时附加归属");
  assert.ok(AGENT.includes('{ kind: "session", id: entry.clientId || entry.threadId || null }'), "ask_user 缺少会话归属降级分支");
});

test("server：审批载荷仅在归属合法时附加 owner（可选参数，默认不改变形状）", () => {
  assert.ok(审批.includes("owner = null }"), "requireToolApproval 未把 owner 设为可选参数");
  assert.ok(审批.includes("...(归属 ? { owner: 归属 } : {}),"), "载荷未采用「合法才附加」的写法");
});

test("前端：两张 HITL 卡片都记录并渲染归属标签", () => {
  assert.equal((CHAT.match(/owner: data\.owner \|\| null,/g) || []).length, 2, "ask / approval 两处都应记录 owner");
  assert.ok(CHAT.includes("function 交互归属文案(owner)"), "缺少归属文案映射");
  assert.equal((CHAT.match(/交互归属文案\(block\.owner\)/g) || []).length, 2, "两张卡片都应渲染归属标签");
  assert.ok(CHAT.includes('className="interaction-owner"'), "缺少归属标签的样式类");
  assert.ok(样式.includes(".interaction-owner"), "styles.css 缺少归属标签样式");
});

test("开关：qoderInteractionOwner 默认关且已下发", () => {
  assert.ok(/qoderInteractionOwner: readFlag\("OAW_QODER_INTERACTION_OWNER"\)/.test(开关), "缺少 qoderInteractionOwner");
  assert.ok(开关.includes("qoderInteractionOwner: RUNTIME_FLAGS.qoderInteractionOwner,"), "快照未下发 qoderInteractionOwner");
  assert.equal(原始开关.qoderInteractionOwner, false, "不设环境变量时必须为 false（基线）");
  assert.equal(原始快照().qoderInteractionOwner, false, "快照必须如实反映默认关");
});

await 异步("开关管线实测：OAW_QODER_INTERACTION_OWNER=1 时 RUNTIME_FLAGS 与快照均开启", async () => {
  process.env.OAW_QODER_INTERACTION_OWNER = "1";
  const 新 = await import("../server/feature-flags.mjs?fresh=owner-probe");
  assert.equal(新.RUNTIME_FLAGS.qoderInteractionOwner, true);
  assert.equal(新.runtimeFlagsSnapshot().qoderInteractionOwner, true);
  delete process.env.OAW_QODER_INTERACTION_OWNER;
});

console.log(failed ? "\n交互归属测试：存在失败" : "\n交互归属测试：全部通过");
process.exitCode = failed ? 1 : 0;
