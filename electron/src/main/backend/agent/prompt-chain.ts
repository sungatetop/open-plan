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
