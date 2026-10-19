/**
 * 子代理编排器（P1-C / P2-B，方案 §3.2–§3.6）
 *
 * 设计原则（方案 §2.3）：
 *   - 编排用代码，不用模型自治：角色解析、并发 fan-out、对抗式核验的回环判定
 *     全部由本模块的确定性逻辑驱动；Worker/Verifier 才是模型会话（由调用方注入执行器）。
 *   - 事件是唯一事实来源：roster 通过 subagent_planned/started/result/verified/closed
 *     持久化（注册表 persist:true），跨会话可回放。
 *   - SubagentProvider seam：本模块只依赖注入的 runTask/runVerifier 执行器接口
 *     （当前实现是 agent.mjs 里的 Pi 子会话；未来可换独立进程/外部 Agent）。
 *
 * 本模块不 import Pi SDK，纯逻辑可单测。
 */

/** 子代理并发上限（§3.3：独立 limiter，默认 2–3，避免抢占主会话）。 */
export const SUBAGENT_CONCURRENCY = 2;
/** 单次派发的子任务上限。 */
export const SUBAGENT_MAX_TASKS = 4;
/** revise 回环上限（§3.6 P2-B：最多 1 轮）。 */
export const SUBAGENT_REVISE_ROUNDS = 1;

/**
 * 角色定义表（§3.5 能力矩阵）：角色决定工具白名单、读写分级与超时分级。
 * scout/reviewer/planner/verifier 只读；worker 仅在父会话具备写工具（Work 模式）时生效。
 */
export const SUBAGENT_ROLES = Object.freeze({
  scout: { label: "资料探索", readOnly: true, tools: ["read", "grep", "find", "ls"], timeoutMs: 60000, prompt: "资料探索者，优先寻找证据并归纳要点。" },
  reviewer: { label: "审阅", readOnly: true, tools: ["read", "grep", "find", "ls"], timeoutMs: 120000, prompt: "审阅者，逐条给出证据与问题，不做推测。" },
  planner: { label: "方案拆解", readOnly: true, tools: ["read", "grep", "find", "ls"], timeoutMs: 60000, prompt: "方案拆解者，输出简短、可执行的步骤。" },
  verifier: { label: "独立核验", readOnly: true, tools: ["read", "grep", "find", "ls"], timeoutMs: 120000, prompt: "独立核验者，对抗式检查结论是否成立、证据是否充分，给出 pass/revise/fail 判定。" },
  worker: { label: "执行", readOnly: false, tools: ["read", "grep", "find", "ls", "write", "edit", "officecli"], timeoutMs: 180000, prompt: "执行者，按子任务产出结果（写操作需审批）；完成后给出简明交付说明。" },
});

/**
 * 角色解析：请求角色不在定义表内 → scout；worker 需要父会话可写（Work 模式），
 * 否则降级 scout，避免 Chat/Review 被越权写入。
 */
export function resolveRole(requestedRole, { canWrite = false } = {}) {
  const requested = String(requestedRole || "scout");
  let role = SUBAGENT_ROLES[requested] ? requested : "scout";
  if (role === "worker" && !canWrite) role = "scout";
  return role;
}

/** childId 生成：稳定、可从 parentToolCallId 追溯。 */
export function childIdFor(toolKey, index, multiple) {
  const key = String(toolKey || Math.random().toString(36).slice(2)).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
  return `subagent_${key}${multiple ? `_${index + 1}` : ""}`;
}

/**
 * 确定性解析 verifier 的判定：
 *  - 「判定：pass|revise|fail」（推荐格式，提示词里要求最后一行输出）；
 *  - 或 JSON {"verdict": "..."}；
 *  - 解析不到时按 pass 处理（fail-safe：不因格式问题触发无限回环；回环另有 1 轮上限）。
 * @returns {{verdict: "pass"|"revise"|"fail", checklist: Array<{item:string,ok:boolean}>, notes: string}}
 */
export function parseVerdict(text) {
  const source = String(text || "");
  let verdict = "pass";
  const explicit = source.match(/判定[：:]\s*["']?(pass|revise|fail|通过|需修订|不通过)["']?/i);
  if (explicit) {
    const raw = explicit[1].toLowerCase();
    verdict = raw === "pass" || raw === "通过" ? "pass" : raw === "revise" || raw === "需修订" ? "revise" : "fail";
  } else {
    const jsonMatch = source.match(/\{[\s\S]*?"verdict"[\s\S]*?\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        const raw = String(parsed.verdict || "").toLowerCase();
        if (["pass", "revise", "fail"].includes(raw)) verdict = raw;
      } catch {}
    }
  }
  // 检查清单："- 检查项：通过/缺失/未通过" 或 "- 检查项（ok/missing）"
  const checklist = [];
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*[-*]\s*(.+?)[：:]\s*(通过|ok|✅|缺失|未通过|fail|missing|❌)?\s*$/i);
    if (match && match[1] && !/^(判定|verdict)/i.test(match[1])) {
      const flag = String(match[2] || "").toLowerCase();
      checklist.push({ item: match[1].trim().slice(0, 300), ok: !(flag === "缺失" || flag === "未通过" || flag === "fail" || flag === "missing" || flag === "❌") });
    }
  }
  return { verdict, checklist: checklist.slice(0, 40), notes: source.slice(0, 1200) };
}

/** 构造 verifier 子任务输入：对抗式核查 worker 输出，要求最后一行输出判定。 */
export function buildVerifierTask({ task, output }) {
  return [
    "你是对抗式核验者。请独立核查下面这个子任务的执行结论是否成立：",
    `【子任务】${task}`,
    `【执行结论】${String(output || "").slice(0, 6000)}`,
    "要求：",
    "1. 只依据可读取的文件与证据判断，不臆测；逐条列出检查项与结论（格式：- 检查项：通过 或 - 检查项：缺失）。",
    "2. 结论成立且证据充分 → 修订建议可为空；证据不足或结论与文件不符 → 给出需要修订的具体点。",
    `3. 最后一行必须输出判定，格式严格为：判定：pass 或 判定：revise 或 判定：fail。`,
  ].join("\n");
}

/** 汇总多个子代理结果为父会话可见文本（Leader 由代码担任的"汇总"职责）。 */
export function summarizeResults(results, { roleLabel = "子代理" } = {}) {
  const children = results.filter(Boolean);
  if (!children.length) return "（子代理没有返回结果）";
  const parts = children.map((child, index) => {
    const head = children.length > 1 ? `### 子任务 ${index + 1}` : "";
    const verdict = child.verify && child.verify.verdict !== "pass"
      ? `\n（核验结论：${child.verify.verdict === "revise" ? "需修订" : "不通过"}）`
      : "";
    return `${head}\n${child.text || "（无结果）"}${verdict}`.trim();
  });
  return parts.join("\n\n").slice(0, 16000);
}

/**
 * 确定性编排：计划（planned）→ 并发执行 → 结果（result）→
 * 可选对抗式核验（verified）→ revise 回环（≤1 轮）→ 关账（closed）。
 *
 * @param {object} input
 * @param {string[]} input.tasks 子任务列表（已裁剪到 SUBAGENT_MAX_TASKS）
 * @param {string} input.role 已解析角色
 * @param {object} input.roleSpec SUBAGENT_ROLES[role]
 * @param {string} input.toolKey 父工具调用的稳定 key
 * @param {string|null} input.parentToolCallId 父会话 run_subagent 的 toolCallId
 * @param {boolean} input.verify 是否对 worker 结果做对抗式核验
 * @param {(type: string, data: object) => void} input.emit 事件发出（writeEvent）
 * @param {(task: string, ctx: {index:number, childId:string, suffix:string}) => Promise<{text:string, isError:boolean, childId:string, model?:string|null}>} input.runTask
 *        子任务执行器（Pi 子会话 seam；负责任何角色）
 * @param {AbortSignal} [input.signal]
 * @param {number} [input.concurrency]
 * @returns {Promise<{results: Array, text: string, isError: boolean}>}
 */
export async function orchestrateSubagents({
  tasks = [],
  role = "scout",
  roleSpec = SUBAGENT_ROLES.scout,
  toolKey,
  parentToolCallId = null,
  verify = false,
  emit = () => {},
  runTask,
  signal = null,
  concurrency = SUBAGENT_CONCURRENCY,
}) {
  const list = tasks.map((task) => String(task || "").trim()).filter(Boolean).slice(0, SUBAGENT_MAX_TASKS);
  if (!list.length) throw new Error("orchestrateSubagents 需要至少一个非空子任务");
  const multiple = list.length > 1;

  // ---- roster 计划：每个子任务先发 planned（持久化，前端按 planned 状态渲染）----
  const roster = list.map((task, index) => {
    const childId = childIdFor(toolKey, index, multiple);
    const entry = { childId, index, task, status: "planned", result: null, verify: null, rounds: 0 };
    emit("subagent_planned", {
      childId,
      parentToolCallId,
      role,
      task,
      tools: [...roleSpec.tools],
      readOnly: roleSpec.readOnly,
      budget: { timeoutMs: roleSpec.timeoutMs },
      position: index,
      total: list.length,
    });
    return entry;
  });

  const runChild = async (entry, { suffix = "", promptSuffix = "" } = {}) => {
    const startedAt = Date.now();
    emit("subagent_started", { childId: entry.childId, parentToolCallId, role, status: "running" });
    const outcome = await runTask(entry.task, {
      index: entry.index,
      childId: entry.childId,
      suffix: entry.suffix || suffix,
      promptSuffix,
    });
    entry.rounds += 1;
    entry.result = {
      text: outcome?.text || "",
      isError: outcome?.isError === true,
      model: outcome?.model ?? null,
      durationMs: Date.now() - startedAt,
      promptSuffix,
    };
    emit("subagent_result", {
      childId: entry.childId,
      parentToolCallId,
      role,
      task: entry.task,
      status: entry.result.isError ? "failed" : "completed",
      output: entry.result.text.slice(0, 9000),
      toolStats: { rounds: entry.rounds, durationMs: entry.result.durationMs },
      isError: entry.result.isError,
    });
    return entry.result;
  };

  const verifyChild = async (entry) => {
    // verifier 也是模型会话（只读）；回环判定由本编排器（代码）做出。
    const verifierTask = buildVerifierTask({ task: entry.task, output: entry.result?.text || "" });
    emit("subagent_progress", { childId: entry.childId, parentToolCallId, role, phase: "对抗式核验中", activity: "核验执行结论" });
    const verifierChildId = `${entry.childId}_v${entry.rounds}`;
    const outcome = await runTask(verifierTask, {
      index: entry.index,
      childId: verifierChildId,
      suffix: `_v${entry.rounds}`,
      roleOverride: "verifier",
    });
    const parsed = parseVerdict(outcome?.text || "");
    entry.verify = { ...parsed, verifierChildId, isError: outcome?.isError === true };
    emit("subagent_verified", {
      childId: entry.childId,
      parentToolCallId,
      role,
      verdict: entry.verify.isError ? "pass" : entry.verify.verdict,
      checklist: entry.verify.checklist,
      notes: entry.verify.isError ? "核验子代理执行失败，按通过处理（结果已保留）" : entry.verify.notes,
      verifierChildId,
    });
    return entry.verify;
  };

  // ---- 受限并发 fan-out（§3.3：独立并发，默认 2）----
  const runWithVerify = async (entry) => {
    entry.status = "running";
    await runChild(entry);
    // 对抗式核验 + revise 回环（§3.6 P2-B：最多 SUBAGENT_REVISE_ROUNDS 轮）
    // 核验只对 worker 任务生效（verifier 与执行者构成对抗关系）
    if (verify && !entry.result.isError && role === "worker") {
      for (let round = 0; round <= SUBAGENT_REVISE_ROUNDS; round += 1) {
        const verdict = await verifyChild(entry);
        if (verdict.verdict !== "revise") break;
        if (round >= SUBAGENT_REVISE_ROUNDS) break;
        // revise → 把核验意见并回任务重跑一次（回环上限由 for 循环控制）
        entry.task = `${entry.task}\n\n【核验反馈（请修订后重新交付）】\n${(verdict.notes || "").slice(0, 1200)}`;
        emit("subagent_progress", { childId: entry.childId, parentToolCallId, role, phase: "按核验意见修订中", activity: "revise 回环" });
        await runChild(entry);
      }
    }
    const finalStatus = entry.result.isError ? "failed" : "completed";
    entry.status = finalStatus;
    emit("subagent_closed", {
      childId: entry.childId,
      parentToolCallId,
      role,
      finalStatus,
      verdict: entry.verify?.verdict || null,
      rounds: entry.rounds,
    });
    return entry;
  };

  const queue = [...roster];
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), queue.length) }, async () => {
    while (queue.length) {
      const entry = queue.shift();
      if (signal?.aborted) {
        entry.status = "cancelled";
        emit("subagent_closed", { childId: entry.childId, parentToolCallId, role, finalStatus: "cancelled" });
        continue;
      }
      try {
        await runWithVerify(entry);
      } catch (error) {
        entry.status = "failed";
        emit("subagent_closed", { childId: entry.childId, parentToolCallId, role, finalStatus: "failed", error: String(error?.message || error).slice(0, 600) });
      }
    }
  }));

  const results = roster.map((entry) => ({
    childId: entry.childId,
    text: entry.result?.text || "",
    isError: entry.result?.isError ?? true,
    verify: entry.verify,
    status: entry.status,
  }));
  const text = summarizeResults(results);
  return {
    results,
    text,
    isError: results.length > 0 && results.every((result) => result.isError),
  };
}
