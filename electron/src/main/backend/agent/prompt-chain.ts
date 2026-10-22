/**
 * Prompt 主链辅助函数族（B6-6-4e，自 server/agent.mjs L589-679 逐行转录）。
 *
 * - waitForAgentRetry：重试退避等待（setTimeout 薄封装）。
 * - waitForPiSessionIdle：continuation 重试前等待 Pi 会话空闲（默认 4s 上限）。
 * - promptWithFirstEventTimeout：pi.prompt 首事件 watchdog——只监控「首个模型/工具事件」
 *   的等待时间，不限制已经开始执行的长任务；首事件超时（MODEL_TIMEOUT）或流中途静默
 *   （MODEL_STREAM_TIMEOUT）时自动 abort 并以对应错误拒绝。
 *
 * 依赖口径：createModelTimeoutError/createModelStreamTimeoutError 与超时常量来自
 * agent-errors（B6-6-1 已迁）；piRuntimeManager 为 pi 域 seam——旧代码是模块级函数闭包
 * 引用模块级单例，electron 侧无模块级单例，改为首参显式传入（AgentPiRuntimeSeam 的
 * 结构子集），调用点由 AgentManager 传 this.deps.piRuntimeManager。行为不变，仅依赖
 * 注入形状差异。
 */
import {
  createModelTimeoutError,
  createModelStreamTimeoutError,
  MODEL_FIRST_EVENT_TIMEOUT_MS,
  MODEL_IDLE_TIMEOUT_MS,
} from "./agent-errors";

/** promptWithFirstEventTimeout 所需的 Pi runtime 子集（AgentPiRuntimeSeam 结构兼容）。 */
export interface PromptChainRuntime {
  prompt(runtimeId: unknown, session: unknown, text: unknown, options: any): any;
  abort(runtimeId: unknown, session: unknown): Promise<void>;
}

export function waitForAgentRetry(delayMs: number) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function waitForPiSessionIdle(entry: any, timeoutMs = 4000) {
  const isIdle = entry?.session?.isIdle;
  if (typeof isIdle !== "function") return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (isIdle.call(entry.session)) return;
    } catch {
      return;
    }
    await waitForAgentRetry(100);
  }
}

/**
 * pi.prompt() 会一直等到整轮任务结束。这里仅对首个 Pi 事件设 watchdog，
 * 一旦已经收到文本、思考或工具事件，就允许长文档任务继续执行。
 */
export async function promptWithFirstEventTimeout(piRuntimeManager: PromptChainRuntime, entry: any, text: unknown, options: any = {}) {
  let timeout: any;
  let probe: any;
  let idleProbe: any;
  let settled = false;
  const prompt = Promise.resolve().then(() => piRuntimeManager.prompt(entry.runtimeId, entry.session, text, options));
  const firstEvent = new Promise((_, reject) => {
    const rejectTimeout = () => {
      if (settled) return;
      settled = true;
      const error = createModelTimeoutError();
      // 不通过 AgentManager.abort，避免把用户主动中止事件误发给前端；
      // 这里的错误会由 _promptEntry 统一转成 agent_error/run_finished。
      const abortPromise = piRuntimeManager.abort(entry.runtimeId, entry.session).catch(() => {});
      entry.pendingAbortPromise = abortPromise;
      void abortPromise.finally(() => {
        if (entry.pendingAbortPromise === abortPromise) entry.pendingAbortPromise = null;
      });
      reject(error);
    };
    timeout = setTimeout(rejectTimeout, MODEL_FIRST_EVENT_TIMEOUT_MS);
    probe = setInterval(() => {
      if (entry.firstResponseReceived) {
        clearTimeout(timeout);
        clearInterval(probe);
        timeout = null;
        probe = null;
      }
    }, 250);
  });
  const idleEvent = new Promise((_, reject) => {
    idleProbe = setInterval(() => {
      if (!entry.firstResponseReceived || entry.activeToolCount > 0) return;
      const lastEventAt = Number(entry.lastPiEventAt || 0);
      if (!lastEventAt || Date.now() - lastEventAt < MODEL_IDLE_TIMEOUT_MS) return;
      if (settled) return;
      settled = true;
      const error = createModelStreamTimeoutError();
      const abortPromise = piRuntimeManager.abort(entry.runtimeId, entry.session).catch(() => {});
      entry.pendingAbortPromise = abortPromise;
      void abortPromise.finally(() => {
        if (entry.pendingAbortPromise === abortPromise) entry.pendingAbortPromise = null;
      });
      reject(error);
    }, 1000);
  });
  try {
    return await Promise.race([prompt, firstEvent, idleEvent]);
  } finally {
    settled = true;
    if (timeout) clearTimeout(timeout);
    if (probe) clearInterval(probe);
    if (idleProbe) clearInterval(idleProbe);
  }
}

/**
 * 输出策略（A03，B6-6-4f，自 server/agent.mjs L49-65 逐行转录）：Chat / Work / Review
 * 共用同一套收尾口径，避免系统提示各要求一套收尾。
 *   - 进度：始终短句、不复述工具、不用模板标签；
 *   - 最终答复：纯问答/审阅用 1-3 句短结论；产生成果（文件/报告/数据/改动）时用
 *     简洁 Markdown 讲清成果。
 * 返回可直接铺进系统提示的词条数组（_create 系统提示组装消费，4g/4i 批接线）。
 */
export function buildOutputPolicyLines({ mode = "work" }: { mode?: unknown } = {}): string[] {
  const normalized = String(mode || "work").toLowerCase();
  const chatLike = normalized === "chat" || normalized === "review";
  const finalLine = chatLike
    ? "- **最终答复（重要）**: 完成任务后先直接说结论，用 1-3 句自然语言即可；不要输出固定的 Markdown 分段模板，也不要复述工具调用流水。只有用户明确要求详细展开时，才给出完整内容。"
    : "- **最终答复（重要）**: 完成任务后先直接说结论。纯问答、闲聊或只读咨询用 1-3 句自然语言即可；**当本轮产生了文件、报告、数据、代码改动等成果时，用简洁但完整的 Markdown 把成果讲清楚**：可用小标题 + 要点列表，覆盖「做了什么 / 关键结果或发现 / 产物路径 / 如何验证 / 未完成项或风险」。不要把工具调用流水逐条复述，也不要用“读取来源 / 修改文件 / 产物 / 假设 / 下一步”这类固定模板标签，但成果本身要让用户不看任务详情也能明白。";
  return [
    "- **进度结论（重要）**: 长任务不要静默连续调用工具。每完成一个阶段（或收到系统进度提醒时），先用 1-3 句自然中文直接说明阶段结论、当前结果和下一步，再继续执行。第一句先说结论；不要输出 Markdown 标题、加粗、项目符号或“阶段总结/已完成/当前/下一步”模板标签，不要复述工具调用，也不要写“正在处理中”这类空话。",
    finalLine,
  ];
}
