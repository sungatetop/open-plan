/**
 * ChatPanel 事件状态机（F3 批6b：自 client/src/components/ChatPanel.jsx 抽出，
 * 与原实现逐行等价，对拍强制 tests/f3-batch6b-parity.test.tsx）。
 *
 * 覆盖范围（旧源码行号）：
 *   - 流式缓冲回调 patch/flushToolOutput/queueToolOutput/rememberDisplayedText/
 *     cancelTextReveal/enqueueTextReveal/finishTextReveal/scheduleFlush（1233-1445）
 *   - acceptSystemEvent（1843-1854）+ handleEvent 全 switch（1856-2790）
 *   - flushNow（2800-2814）/ pushSystem（2816-2820）/ upsertRunSummary（2822-2835）/
 *     finalizeStopped（2856-2877）
 *
 * 与旧实现的差异只有形态、没有语义：
 *   - 旧 handleEvent 是组件渲染闭包，读取 busy/runState/model/forcedMode/threadId 的
 *     「最近一次已提交渲染值」；这里以 deps.getXxx() getter 注入同一语义（每事件开始时取值）。
 *   - setState 族经 deps 注入（支持函数式更新，与 React 同形）。
 *   - 旧源码中的 appendToBlock 为从未被调用的死代码，未转录。
 *   - enqueueExecutionEvent / pushSystemNote / clearSystemNotes / rememberModel /
 *     applyModel / flushQueued / props 回调均为注入依赖（组件级接线在 6d 完成）。
 *   - window.__oawChatEvents 测试钩子属组件挂载层，不在本模块。
 */
import {
  ASK_TIMEOUT_FALLBACK_MS,
  BROWSER_PANEL_OPEN_TOOLS,
  LIVE_RUN_STATUSES,
  appendAssistantMessageBoundary,
  appendSubagentTrace,
  appendTextBlock,
  appendThinkingBlock,
  eventMessageText,
  newId,
  normalizeUiMode,
  type ChatBlock,
  type ChatMessage,
  type FlowEvent,
} from "../../lib/chat-shared";
import { FLOW_EVENT_TYPES } from "../../lib/event-display";
import { flag } from "../../lib/feature-flags";
import { finalizeLatencyProbe, markLatency, patchLatencyMeta } from "../../lib/first-token-latency-tracker";
import { 计算展示字符数 } from "../../lib/StreamingTextQueue";
import { isMotionReduced } from "../../lib/ui-appearance";
import { upsertRunSummaryMessage } from "../../lib/run-display-projection";

/** 运行态（runState）宽松视图：已知字段之外全走索引签名。 */
export interface ChatRunState {
  status: string;
  runId?: unknown;
  mode?: string;
  [key: string]: unknown;
}

/** SSE / 事件通道的宽松信封：type 在 JSON 体内，id/seq 为游标序号。 */
export interface ChatEventEnvelope {
  type?: string;
  data?: Record<string, unknown>;
  id?: unknown;
  seq?: unknown;
  at?: string;
  event?: ChatEventEnvelope;
  [key: string]: unknown;
}

export type ChatEventInput = ChatEventEnvelope | null | undefined;

/** queueToolOutput 的单条待刷新工具输出编辑。 */
export interface ToolOutputEdit {
  messageId: string;
  toolCallId: string | null;
  name: string;
  output: string;
  replace: boolean;
}

/** enqueueTextReveal 的打字机揭示状态。 */
export interface TextRevealState {
  id: string;
  fullText: string;
  pending: string;
  lastAt: number;
  completeWhenDrained: boolean;
  instant: boolean;
}

/** RefContainer：机器不创建 ref，由组件层（6d）声明后注入，与旧组件一一对应。 */
export interface ChatMachineRefs {
  mountedRef: { current: boolean };
  activeRunIdRef: { current: string | null };
  runInProgressRef: { current: boolean };
  agentEventAtRef: { current: number };
  assistantIdRef: { current: string | null };
  lastAssistantIdRef: { current: string | null };
  streamingMsgIdRef: { current: string | null };
  streamBufRef: { current: { text: string; thinking: string } | null };
  rafRef: { current: number | null };
  toolOutputQueueRef: { current: Map<string, ToolOutputEdit> };
  toolOutputRafRef: { current: number | null };
  textRevealRef: { current: TextRevealState | null };
  textRevealRafRef: { current: number | null };
  displayedTextRef: { current: Map<string, string> };
  stoppingRef: { current: boolean };
  stopRequestedRef: { current: boolean };
  roundStoppedRef: { current: boolean };
  stopConfirmTimerRef: { current: number | null };
  agentErrorRef: { current: boolean };
  systemEventKeysRef: { current: Set<string> };
  replayProbeRef: { current: { pending: boolean; thread: string | null } };
  replayBufferRef: { current: unknown[] };
  runtimeConnectingEventRef: { current: FlowEvent | null };
  connectionTimerRef: { current: number | null };
}

/** 事件状态机的注入依赖（对应旧组件渲染闭包 + 组件级回调 + props 回调）。 */
export interface ChatEventMachineDeps {
  refs: ChatMachineRefs;
  // —— 闭包值读取（等价旧组件「最近一次已提交渲染」语义）——
  getBusy(): boolean;
  getRunState(): ChatRunState;
  getModel(): string;
  getForcedMode(): string | null | undefined;
  getThreadId(): string | null | undefined;
  getWorkspace(): string | null | undefined;
  // —— setState 族（函数式更新与 React 同形）——
  setMessages(next: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])): void;
  setBusy(value: boolean): void;
  setRunState(updater: (prev: ChatRunState) => ChatRunState): void;
  setAgentPhase(next: string | ((prev: string) => string)): void;
  setConnected(value: boolean): void;
  setModelMsg(value: string): void;
  setTodoItems(value: unknown[]): void;
  setEditMode(value: string): void;
  setStopping(value: boolean): void;
  setPendingModel(value: string): void;
  setModel(value: string): void;
  setLastMapVisual(value: unknown): void;
  setMapVisualHint(value: string): void;
  setConnectionNotice(value: unknown): void;
  // —— 组件级回调（handleEvent 只调用，不拥有）——
  enqueueExecutionEvent(event: FlowEvent): void;
  pushSystemNote(note: Record<string, unknown>): void;
  clearSystemNotes(): void;
  rememberModel(id: string): void;
  applyModel(id: string): void;
  flushQueued(force?: boolean): void;
  // 注：agent_model_fallback / steer / map_action 分支调用的 pushSystem 由本工厂
  // 自带（旧 2816-2820），不作为依赖注入。
  // —— props 回调 ——
  onFileChanged?(files: unknown): void;
  onMapAction?(data: Record<string, unknown>): void;
  onRunFinished?(data: Record<string, unknown>): void;
  onAgentEnd?(): void;
  onBrowserActivity?(): void;
  onModelChange?(id: string): void;
}

export function createChatEventMachine(deps: ChatEventMachineDeps) {
  const { refs } = deps;

  // 流式刷新调度：合并同一帧内的多次文本追加（旧 1233-1236）
  const patch = (id: string | null, fn: (m: ChatMessage) => ChatMessage): void => {
    if (!refs.mountedRef.current) return;
    deps.setMessages((ms) => ms.map((m) => (m.id === id ? fn(m) : m)));
  };

  const flushToolOutput = (): void => {
    if (refs.toolOutputRafRef.current) {
      cancelAnimationFrame(refs.toolOutputRafRef.current);
      refs.toolOutputRafRef.current = null;
    }
    const updates = [...refs.toolOutputQueueRef.current.values()];
    refs.toolOutputQueueRef.current.clear();
    if (!updates.length || !refs.mountedRef.current) return;
    deps.setMessages((current) => {
      const byMessage = new Map<string, ToolOutputEdit[]>();
      for (const update of updates) {
        if (!byMessage.has(update.messageId)) byMessage.set(update.messageId, []);
        byMessage.get(update.messageId)!.push(update);
      }
      let changed = false;
      const next = [...current];
      for (const [messageId, edits] of byMessage) {
        const messageIndex = next.findIndex((item) => item.id === messageId);
        if (messageIndex < 0) continue;
        const blocks = [...(next[messageIndex]!.blocks || [])];
        let messageChanged = false;
        for (const edit of edits) {
          let blockIndex = edit.toolCallId
            ? blocks.findIndex((block) => block.type === "tool" && block.id === edit.toolCallId)
            : -1;
          if (!edit.toolCallId) {
            for (let index = blocks.length - 1; index >= 0; index -= 1) {
              const block = blocks[index]!;
              if (block.type === "tool" && !block.done && (!edit.name || block.name === edit.name)) {
                blockIndex = index;
                break;
              }
            }
          }
          if (blockIndex < 0) continue;
          const block = blocks[blockIndex]!;
          const output = edit.replace ? edit.output : `${String(block.output || "")}${edit.output}`;
          if (output === block.output) continue;
          blocks[blockIndex] = { ...block, output };
          messageChanged = true;
        }
        if (messageChanged) {
          next[messageIndex] = { ...next[messageIndex]!, blocks };
          changed = true;
        }
      }
      return changed ? next : current;
    });
  };

  const queueToolOutput = (messageId: string, data: Record<string, unknown> = {}): void => {
    if (!messageId) return;
    const toolCallId = (data.toolCallId as string | undefined) || null;
    const name = (data.name as string | undefined) || "";
    const key = `${messageId}:${toolCallId || name || "last"}`;
    const previous = refs.toolOutputQueueRef.current.get(key);
    const output = String(data.output || "");
    refs.toolOutputQueueRef.current.set(key, {
      messageId,
      toolCallId,
      name,
      output: data.replace ? output : `${previous?.output || ""}${output}`,
      replace: Boolean(data.replace || previous?.replace),
    });
    if (!refs.toolOutputRafRef.current) refs.toolOutputRafRef.current = requestAnimationFrame(flushToolOutput);
  };

  const rememberDisplayedText = (id: string, text: unknown): void => {
    if (!id) return;
    refs.displayedTextRef.current.set(id, String(text || ""));
    if (refs.displayedTextRef.current.size > 600) {
      const oldest = refs.displayedTextRef.current.keys().next().value;
      if (oldest) refs.displayedTextRef.current.delete(oldest);
    }
  };

  const cancelTextReveal = ({ preserveText = false } = {}): void => {
    const active = refs.textRevealRef.current;
    if (refs.textRevealRafRef.current) cancelAnimationFrame(refs.textRevealRafRef.current);
    refs.textRevealRafRef.current = null;
    refs.textRevealRef.current = null;
    // 已经拿到但尚未显示的字符不能因为下一轮输入而丢失。
    if (preserveText && active?.pending && active?.id) {
      const displayed = refs.displayedTextRef.current.get(active.id) || "";
      rememberDisplayedText(active.id, displayed + active.pending);
      patch(active.id, (m) => ({
        ...m,
        blocks: appendTextBlock([...(m.blocks || [])], active.pending),
        status: active.completeWhenDrained ? (refs.agentErrorRef.current ? "error" : "done") : m.status,
      }));
    }
  };

  const enqueueTextReveal = (id: string, value: unknown, { authoritative = false } = {}): void => {
    const text = String(value || "");
    if (!id || !text) return;
    let state = refs.textRevealRef.current;
    if (!state || state.id !== id) {
      if (refs.textRevealRafRef.current) cancelAnimationFrame(refs.textRevealRafRef.current);
      state = { id, fullText: refs.displayedTextRef.current.get(id) || "", pending: "", lastAt: performance.now(), completeWhenDrained: false, instant: isMotionReduced() };
      refs.textRevealRef.current = state;
      refs.textRevealRafRef.current = null;
    }

    if (authoritative) {
      // 动效闸门可能在本轮执行中途变化：补齐权威全文时刷新一次即刻落定标记
      state.instant = isMotionReduced();
      const displayed = refs.displayedTextRef.current.get(id) || "";
      if (text === displayed || text === state.fullText) return;
      if (text.startsWith(state.fullText)) {
        state.pending += text.slice(state.fullText.length);
      } else if (text.startsWith(displayed)) {
        // 动画状态可能已经在 agent_end 后清理，但消息气泡已经显示了前缀。
        // 只排队缺失后缀，不能把最终全文再次追加到气泡末尾。
        state.pending = text.slice(displayed.length);
      } else if (displayed && text.includes(displayed)) {
        // 权威全文包含已显示文本：只追加缺失后缀，绝不能先清空已显示内容。
        // 多回合场景下权威全文不是累积文本的前缀，按包含关系判断即可。
        state.pending += text.slice(text.indexOf(displayed) + displayed.length);
      } else if (!state.fullText) {
        // 气泡还没有任何已显示文本：允许从权威全文清空重播。
        // 断线重连或缺失 token 时宁可从最终文本重放，也不能保留截断回复。
        state.pending = text;
        rememberDisplayedText(id, "");
        patch(id, (m) => {
          const blocks = [...(m.blocks || [])];
          const textIndex = blocks.map((block) => block.type).lastIndexOf("text");
          if (textIndex >= 0) blocks[textIndex] = { ...blocks[textIndex]!, text: "" };
          else blocks.push({ type: "text", text: "" });
          return { ...m, blocks };
        });
      }
      // 已有已显示文本但权威全文不包含它（多回合累积）：保留已显示内容、不追加、不清空。
      state.fullText = text;
    } else {
      state.fullText += text;
      state.pending += text;
    }

    const reveal = (now: number): void => {
      const active = refs.textRevealRef.current;
      if (!active || active.id !== id) return;
      const elapsedMs = Math.max(1, now - active.lastAt);
      // 闸门命中（系统减少动效 / 产品关闭动效）时跳过节流，一帧内落定，
      // 避免"文字重新打字"和旧揭示动画继续覆盖新状态。
      if (!active.instant && elapsedMs < 32 && active.pending.length < 24) {
        refs.textRevealRafRef.current = requestAnimationFrame(reveal);
        return;
      }
      active.lastAt = now;
      const count = 计算展示字符数({ remaining: active.pending.length, elapsedMs, reducedMotion: active.instant === true });
      if (count) {
        const chunk = active.pending.slice(0, count);
        active.pending = active.pending.slice(count);
        rememberDisplayedText(id, (refs.displayedTextRef.current.get(id) || "") + chunk);
        patch(id, (m) => {
          const blocks = appendTextBlock([...(m.blocks || [])], chunk);
          return { ...m, blocks };
        });
      }
      if (active.pending.length) {
        refs.textRevealRafRef.current = requestAnimationFrame(reveal);
      } else {
        refs.textRevealRafRef.current = null;
        if (active.completeWhenDrained) {
          patch(id, (m) => ({ ...m, status: refs.agentErrorRef.current ? "error" : "done" }));
          refs.textRevealRef.current = null;
        }
      }
    };
    if (!refs.textRevealRafRef.current) refs.textRevealRafRef.current = requestAnimationFrame(reveal);
  };

  const finishTextReveal = (id: string | null): void => {
    const state = refs.textRevealRef.current;
    if (!id || !state || state.id !== id || !state.pending.length) {
      if (id) patch(id, (m) => ({ ...m, status: refs.agentErrorRef.current ? "error" : "done" }));
      return;
    }
    state.completeWhenDrained = true;
  };

  const scheduleFlush = (type: string, data: Record<string, unknown>): void => {
    if (!refs.streamBufRef.current) return;
    const buf = refs.streamBufRef.current;
    // 与旧实现一致：data.text 缺失时按 JS 字符串拼接语义落成 "undefined"
    if (type === "token") buf.text += String(data.text);
    else if (type === "thinking") buf.thinking += String(data.text);
    if (!refs.rafRef.current) {
      refs.rafRef.current = requestAnimationFrame(() => {
        refs.rafRef.current = null;
        const id = refs.streamingMsgIdRef.current;
        if (id && refs.streamBufRef.current) {
          const { text, thinking } = refs.streamBufRef.current;
          if (text || thinking) {
            patch(id, (m) => {
              let blocks = [...(m.blocks || [])];
              if (text) blocks = appendTextBlock(blocks, text);
              if (thinking) blocks = appendThinkingBlock(blocks, thinking);
              return { ...m, blocks };
            });
          }
          // 清空已刷新的增量
          refs.streamBufRef.current.text = "";
          refs.streamBufRef.current.thinking = "";
        }
      });
    }
  };

  const acceptSystemEvent = (key: unknown): boolean => {
    const value = String(key || "");
    if (!value) return true;
    if (refs.systemEventKeysRef.current.has(value)) return false;
    refs.systemEventKeysRef.current.add(value);
    // 限制长期运行的浏览器标签页内存增长。
    if (refs.systemEventKeysRef.current.size > 600) {
      const first = refs.systemEventKeysRef.current.values().next().value;
      if (first) refs.systemEventKeysRef.current.delete(first);
    }
    return true;
  };

  function handleEvent(ev: ChatEventInput): void {
    const envelope = (ev as ChatEventEnvelope | null)?.event || ev || {};
    const { type, data = {} } = envelope as { type?: string; data?: Record<string, unknown> };
    const runState = deps.getRunState();
    const busy = deps.getBusy();
    const model = deps.getModel();
    const forcedMode = deps.getForcedMode();
    const threadId = deps.getThreadId();
    // OAW_REPLAY_RECOVER：冷启动探测期间缓冲通道回放事件，探测完成后统一冲刷落点，
    // 避免探测竞态窗口内到达的 token/tool 事件因 busy/idle 门闩被静默丢弃。
    if (flag("replayRecover") && refs.replayProbeRef.current.pending && refs.replayProbeRef.current.thread === threadId && type !== "connected") {
      if (refs.replayBufferRef.current.length < 6000) refs.replayBufferRef.current.push(ev);
      return;
    }
    const eventRunId = data?.runId || null;
    // 重连会回放历史事件。已知当前 Run 时，旧 Run 的事件不能污染当前对话。
    if (eventRunId && refs.activeRunIdRef.current && eventRunId !== refs.activeRunIdRef.current) return;
    // 断线重连可能从 capability_plan 之后开始回放；run_admitted 也可以作为
    // 当前 Run 的锚点，否则后续 tool_start/token 会被误判为旧事件而丢弃。
    const runInProgress = refs.runInProgressRef.current || busy || LIVE_RUN_STATUSES.has(runState.status);
    if (eventRunId && !refs.activeRunIdRef.current && runInProgress && ["capability_plan", "run_admitted", "model_request_started"].includes(type as string)) {
      refs.activeRunIdRef.current = eventRunId as string;
    }
    // 本地还没有锚点但事件带 runId（恢复/切换会话/重连回放/fetch 响应前到达）：
    // 首个带 runId 的事件即视为当前运行锚点并接受，避免运行中的事件被误丢。
    if (eventRunId && !refs.activeRunIdRef.current && !["connected", "capability_plan", "run_finished"].includes(type as string)) {
      refs.activeRunIdRef.current = eventRunId as string;
    }
    if (type !== "connected") refs.agentEventAtRef.current = Date.now();
    // 首字延迟：首个 SSE 事件、首个正文增量分别打点（方案 §3.5）。
    // 这两个时刻与服务端的 provider 事件成对，可以把“服务端慢”和“前端渲染慢”分开。
    if (type !== "connected") markLatency("firstEventAt");
    if (type === "run_admitted" && data?.runId) patchLatencyMeta({ runId: data.runId });
    if (FLOW_EVENT_TYPES.has(type as string) && (runInProgress || eventRunId === refs.activeRunIdRef.current)) {
      const sequence = Number(envelope.id || envelope.seq || 0);
      const eventKey = sequence ? `seq:${sequence}` : `${type}:${eventRunId || "current"}:${envelope.at || Date.now()}`;
      deps.enqueueExecutionEvent({ key: eventKey, type: type as string, data, at: envelope.at || new Date().toISOString() });
    }
    let aid = refs.assistantIdRef.current;
    // 刷新、断线重连或切换回正在执行的子对话时，历史事件可能先于本地气泡到达。
    // 只在本轮仍处于运行态时恢复气泡，避免把已完成历史重复渲染一遍。
    const ensureAssistant = (force = false): string | null => {
      if (refs.assistantIdRef.current) {
        refs.lastAssistantIdRef.current = refs.assistantIdRef.current;
        return refs.assistantIdRef.current;
      }
      // OAW_REPLAY_RECOVER：探测恢复的运行上下文经 ref 同步生效（state 可能尚未提交），
      // 故 runInProgressRef 也放行；flag 关时与基线判定完全一致。
      const replayRecoverGate = flag("replayRecover") && refs.runInProgressRef.current;
      if (!force && !busy && !LIVE_RUN_STATUSES.has(runState.status) && !replayRecoverGate) return null;
      const recoveredId = newId();
      refs.assistantIdRef.current = recoveredId;
      refs.lastAssistantIdRef.current = recoveredId;
      refs.streamingMsgIdRef.current = recoveredId;
      refs.streamBufRef.current = { text: "", thinking: "" };
      deps.setMessages((ms) => ms.some((message) => message.id === recoveredId)
        ? ms
        : [...ms, { id: recoveredId, role: "assistant", blocks: [], status: "streaming", images: [], createdAt: Date.now() }]);
      aid = recoveredId;
      return recoveredId;
    };
    switch (type) {
      case "runtime_connecting":
        {
          const at = envelope.at || new Date().toISOString();
          const sequence = Number(envelope.id || envelope.seq || 0);
          refs.runtimeConnectingEventRef.current = {
            key: sequence ? `seq:${sequence}` : `${type}:${eventRunId || "current"}:${at}`,
            type: type as string,
            data,
            at,
          };
        }
        deps.setConnected(false);
        // 用户按下发送后最关心的是"模型在不在动"。这里保持"思考中"的措辞，
        // 只把当前在等什么作为括号补充，不再让状态行读起来像"还没开始"。
        deps.setAgentPhase((current) => (/思考中/.test(String(current || "")) ? "思考中（准备运行时）" : "准备会话运行时"));
        break;
      case "runtime_init_failed":
        // 运行时初始化失败是终态：必须同时解除 busy 与运行锚点，
        // 否则界面会停留在“准备会话运行时”，输入框无法恢复。
        deps.setConnected(false);
        deps.setAgentPhase((data?.message as string) || "会话运行时初始化失败");
        deps.setModelMsg((data?.message as string) || "会话运行时初始化失败，请重试或检查模型配置");
        window.setTimeout(() => deps.setModelMsg(""), 4200);
        deps.setBusy(false);
        refs.runInProgressRef.current = false;
        deps.setRunState((s) => (s.status === "failed" ? s : { ...s, status: "failed" }));
        break;
      case "stream_resync":
        // 游标与当前历史窗口已不连续（高频增量被淘汰）。触发 Run 对账，
        // 用服务端 Run 终态与最终文本重建状态，而不是依赖已丢失的事件。
        deps.setAgentPhase("事件流已重同步");
        if (refs.runInProgressRef.current || busy) {
          window.dispatchEvent(new CustomEvent("oaw:force-reconcile"));
        }
        break;
      case "connected":
        refs.runtimeConnectingEventRef.current = null;
        deps.setConnected(true);
        if (data.model && data.model !== model) {
          deps.setModel(data.model as string);
          deps.applyModel(data.model as string);
          if (data.modelFallbackFrom) {
            deps.setModelMsg(`旧模型连接失败，已恢复到 ${data.model}`);
            window.setTimeout(() => deps.setModelMsg(""), 3600);
          }
        }
        break;
      case "run_admitting":
        deps.setAgentPhase("准备任务");
        break;
      case "run_admitted":
        deps.setAgentPhase("任务已受理");
        if (data.runId) deps.setRunState((s) => ({ ...s, runId: data.runId }));
        // 新的一轮任务开始：上一轮的系统提示摘要不再跟随，避免长期堆在顶部
        deps.clearSystemNotes();
        break;
      case "model_request_started":
        deps.setAgentPhase("正在请求模型");
        break;
      case "agent_started":
        deps.setAgentPhase("模型已开始处理");
        ensureAssistant();
        break;
      case "turn_started":
        deps.setAgentPhase("模型正在生成");
        break;
      // 文本 token：节流合并到 blocks
      case "token":
        deps.setAgentPhase("生成回复");
        if (!aid) aid = ensureAssistant();
        if (aid) enqueueTextReveal(aid, data.text);
        markLatency("firstTextDeltaAt");
        break;
      // 思考过程：节流合并到 blocks
      case "thinking":
        deps.setAgentPhase("模型思考");
        if (!aid) aid = ensureAssistant();
        if (aid) scheduleFlush("thinking", data);
        break;
      case "subagent_start":
      case "subagent_planned":
      case "subagent_started":
        flushToolOutput();
        deps.setAgentPhase("子 Agent 正在处理只读子任务");
        if (!aid) aid = ensureAssistant();
        if (aid) {
          if (refs.streamBufRef.current) flushNow(aid);
          const childId = (data.childId as string | undefined) || (data.parentToolCallId as string | undefined) || newId();
          const planned = type === "subagent_planned";
          patch(aid, (m) => m.blocks?.some((block) => block.type === "subagent" && block.id === childId)
            ? m
            : ({ ...m, blocks: [...(m.blocks || []), { type: "subagent", id: childId, parentToolCallId: data.parentToolCallId || null, role: data.role || "scout", task: data.task || "", status: planned ? "planned" : "running", activity: planned ? "子任务已编排，等待执行" : "正在准备隔离的只读会话", thinking: "", preview: "", summary: "", error: "", tools: [], transcript: [] }] }));
        }
        break;
      case "subagent_update":
      case "subagent_progress":
        if (!aid) aid = ensureAssistant();
        if (aid) {
          const childId = (data.childId as string | undefined) || (data.parentToolCallId as string | undefined);
          patch(aid, (m) => {
            const blocks = [...(m.blocks || [])];
            let block = blocks.find((item) => item.type === "subagent" && item.id === childId);
            if (!block) {
              block = { type: "subagent", id: childId || newId(), parentToolCallId: data.parentToolCallId || null, role: data.role || "scout", task: data.task || "", status: "running", thinking: "", preview: "", summary: "", error: "", tools: [], transcript: [] };
              blocks.push(block);
            }
            const delta = data.delta as Record<string, unknown> | undefined;
            Object.assign(block, {
              status: data.status || block.status,
              activity: data.activity || data.phase || block.activity,
              thinking: data.thinking ?? block.thinking,
              preview: data.preview ?? block.preview,
              transcript: data.delta ? appendSubagentTrace(block.transcript, { kind: delta?.kind as string, text: delta?.text as string }) : (block.transcript || []),
            });
            return { ...m, blocks };
          });
        }
        break;
      case "subagent_tool": {
        // 子代理内部工具调用：归到对应子代理卡片下，按子 toolCallId 去重（回放不重复）
        if (!aid) aid = ensureAssistant();
        if (aid) {
          const childId = (data.childId as string | undefined) || (data.parentToolCallId as string | undefined);
          patch(aid, (m) => {
            const blocks = [...(m.blocks || [])];
            let block = blocks.find((item) => item.type === "subagent" && item.id === childId);
            if (!block) {
              block = { type: "subagent", id: childId || newId(), parentToolCallId: data.parentToolCallId || null, role: data.role || "scout", task: data.task || "", status: "running", thinking: "", preview: "", summary: "", error: "", tools: [], transcript: [] };
              blocks.push(block);
            }
            const tools = [...((block.tools as Array<Record<string, unknown>>) || [])];
            const tid = data.toolCallId ? String(data.toolCallId) : null;
            let tool = tid ? tools.find((item) => item.toolCallId === tid) : null;
            if (!tool) {
              tool = { toolCallId: tid, name: data.toolName || "read", status: "running", isError: false };
              tools.push(tool);
            }
            let transcript = block.transcript || [];
            if (data.status === "end") {
              tool.status = "done";
              tool.isError = data.isError === true;
              tool.result = data.result || tool.result || "";
              transcript = appendSubagentTrace(transcript, { kind: "tool_result", toolCallId: tid, isError: data.isError === true, result: data.result || "" });
            } else {
              tool.status = "running";
              tool.args = data.args || tool.args || "";
              transcript = appendSubagentTrace(transcript, { kind: "tool_call", toolName: data.toolName || "read", toolCallId: tid, args: data.args || "" });
            }
            block.tools = tools;
            block.transcript = transcript;
            return { ...m, blocks };
          });
        }
        break;
      }
      case "subagent_end":
        flushToolOutput();
        if (!aid) aid = ensureAssistant();
        if (aid) {
          const childId = (data.childId as string | undefined) || (data.parentToolCallId as string | undefined);
          patch(aid, (m) => {
            const blocks = [...(m.blocks || [])];
            let block = blocks.find((item) => item.type === "subagent" && item.id === childId);
            if (!block) {
              block = { type: "subagent", id: childId || newId(), parentToolCallId: data.parentToolCallId || null, role: data.role || "scout", task: data.task || "", status: "running", thinking: "", tools: [], transcript: [] };
              blocks.push(block);
            }
            // subagent_end 携带后端有界会话轨迹（含思考/文本/工具），回放与实时都据此重建详情
            if (Array.isArray(data.transcript) && data.transcript.length) block.transcript = data.transcript;
            Object.assign(block, { status: data.status || "completed", activity: data.status === "completed" ? "子任务已完成" : "子任务已结束", summary: data.summary || "", error: data.error || "" });
            return { ...m, blocks };
          });
        }
        break;
      case "subagent_result":
        // §3.4 契约：结构化结果（output/artifacts），与 subagent_end 语义互补
        if (!aid) aid = ensureAssistant();
        if (aid) {
          const childId = (data.childId as string | undefined) || (data.parentToolCallId as string | undefined);
          patch(aid, (m) => {
            const blocks = [...(m.blocks || [])];
            const block = blocks.find((item) => item.type === "subagent" && item.id === childId);
            if (!block) return m;
            if (data.output) block.summary = String(data.output).slice(0, 9000);
            if (Array.isArray(data.artifacts) && data.artifacts.length) block.artifacts = (data.artifacts as Array<Record<string, unknown>>).map((item) => String(item?.path || item || "")).filter(Boolean);
            if (data.status) block.status = String(data.status);
            return { ...m, blocks };
          });
        }
        break;
      case "subagent_verified":
        // 对抗式核验结论：pass / revise / fail，附检查清单
        if (!aid) aid = ensureAssistant();
        if (aid) {
          const childId = (data.childId as string | undefined) || (data.parentToolCallId as string | undefined);
          patch(aid, (m) => {
            const blocks = [...(m.blocks || [])];
            const block = blocks.find((item) => item.type === "subagent" && item.id === childId);
            if (!block) return m;
            block.verdict = String(data.verdict || "");
            block.checklist = Array.isArray(data.checklist) ? (data.checklist as Array<Record<string, unknown> | null | undefined>).slice(0, 40).map((item) => ({ item: String(item?.item || item || "").slice(0, 300), ok: item?.ok !== false })) : [];
            if (data.notes) block.verifyNotes = String(data.notes).slice(0, 1200);
            if (data.verdict === "revise") block.status = "running"; // 进入修订回环
            return { ...m, blocks };
          });
        }
        break;
      case "subagent_closed":
        if (!aid) aid = ensureAssistant();
        if (aid) {
          const childId = (data.childId as string | undefined) || (data.parentToolCallId as string | undefined);
          patch(aid, (m) => {
            const blocks = [...(m.blocks || [])];
            const block = blocks.find((item) => item.type === "subagent" && item.id === childId);
            if (!block) return m;
            if (data.finalStatus) block.status = String(data.finalStatus);
            return { ...m, blocks };
          });
        }
        break;
      case "pipeline_started":
      case "pipeline_stage_started":
      case "pipeline_stage_finished":
      case "pipeline_finished": {
        // P2-A：编辑流水线阶段条（§5.2）——planner→writer→formatter→evaluator 可折叠展示
        if (!aid) aid = ensureAssistant();
        if (aid) {
          if (refs.streamBufRef.current && type === "pipeline_started") flushNow(aid);
          patch(aid, (m) => {
            const blocks = [...(m.blocks || [])];
            let block = blocks.find((item) => item.type === "pipeline" && item.id === (data.pipelineId || "pipeline"));
            if (!block) {
              block = { type: "pipeline", id: data.pipelineId || newId(), pipelineId: data.pipelineId || null, format: data.format || null, status: "running", stages: [], deliverable: "" };
              blocks.push(block);
            }
            if (type === "pipeline_started" && data.format) block.format = data.format;
            const stageId = String(data.stage || "");
            if (stageId && type !== "pipeline_finished") {
              const stages = [...((block.stages as Array<Record<string, unknown>>) || [])];
              let stage = stages.find((item) => item.stage === stageId);
              if (!stage) {
                stage = { stage: stageId, label: data.label || stageId, status: "running", checks: [], issues: [] };
                stages.push(stage);
              }
              if (type === "pipeline_stage_started") {
                stage.status = "running";
                if (data.label) stage.label = data.label;
              } else {
                stage.status = String(data.status || "done");
                if (data.artifact) stage.artifact = data.artifact;
                if (Array.isArray(data.checks)) stage.checks = (data.checks as unknown[]).slice(0, 12);
                if (Array.isArray(data.issues)) stage.issues = (data.issues as unknown[]).slice(0, 8);
              }
              block.stages = stages;
            }
            if (type === "pipeline_finished") {
              block.status = String(data.status || "completed");
              if (data.deliverable) block.deliverable = String(data.deliverable);
              if (Array.isArray(data.issues)) block.issues = (data.issues as unknown[]).slice(0, 8);
            }
            return { ...m, blocks };
          });
        }
        break;
      }
      // 工具调用开始：推入新 tool block（按 toolCallId 去重，重放不产生重复卡片）
      case "tool_start":
        if (data.name === "run_subagent") break;
        flushToolOutput();
        deps.setAgentPhase(`调用工具：${data.name || "处理中"}`);
        // 浏览器"写操作类"工具开始执行时通知外层展开内置浏览器侧栏（O-P3 判定修正：
        // browser_close / browser_tabs / browser_snapshot 等查看或收尾动作不再把面板拉起）。
        // 这条通知替代了原先 App 常驻的 /api/browser/stream（只用它判断"浏览器活跃"），
        // 少一条长连接就少占一个同源连接槽位。
        if (BROWSER_PANEL_OPEN_TOOLS.has(String(data.name || ""))) deps.onBrowserActivity?.();
        if (!aid) aid = ensureAssistant();
        if (aid) {
          if (refs.streamBufRef.current) flushNow(aid);
          patch(aid, (m) => {
            const blocks = m.blocks || [];
            if (data.toolCallId && blocks.some((block) => block.type === "tool" && (block.id === data.toolCallId || block.toolCallId === data.toolCallId))) {
              return m;
            }
            return {
              ...m,
              blocks: [...blocks, {
                type: "tool",
                id: data.toolCallId || newId(),
                toolCallId: data.toolCallId || null,
                name: data.name,
                input: data.input || "",
                output: "",
                done: false,
                isError: false,
                expanded: false,
                startTime: Date.now(),
                duration: null,
              }],
            };
          });
        }
        break;
      // 工具输出流：更新最后一个 tool block
      // tool_output_delta 是 P0-2 单帧护栏的增量帧（服务端开关 qoderToolOutputSplit 打开时才出现）：
      // 语义与 tool_output 完全一致（卸载 replace 标记后走「追加」分支），因此共用同一分支。
      case "tool_output":
      case "tool_output_delta":
        if (data.name === "run_subagent") break;
        if (!aid) aid = ensureAssistant();
        if (aid) queueToolOutput(aid, data);
        break;
      // 工具结束：标记完成；找不到对应 start（历史被截断/重连丢失）时创建恢复卡片
      case "tool_end":
        if (data.name === "run_subagent") break;
        flushToolOutput();
        if (!aid) aid = ensureAssistant();
        if (aid) patch(aid, (m) => {
          const blocks = [...(m.blocks || [])];
          const tool = data.toolCallId
            ? blocks.find((block) => block.type === "tool" && (block.id === data.toolCallId || block.toolCallId === data.toolCallId))
            : [...blocks].reverse().find((block) => block.type === "tool" && (!data.name || block.name === data.name));
          if (tool) {
            tool.done = true;
            tool.isError = !!data.isError;
            if (data.result) tool.result = data.result;
            if (tool.startTime) tool.duration = ((Date.now() - Number(tool.startTime)) / 1000).toFixed(1);
          } else if (data.toolCallId || data.name) {
            // tool_start 已被历史淘汰或重连丢失：创建带恢复标记的工具卡，
            // 保证界面工具数量与实际执行一致，而不是静默丢弃。
            blocks.push({
              type: "tool",
              id: data.toolCallId || newId(),
              toolCallId: data.toolCallId || null,
              name: data.name || "tool",
              input: "",
              output: "",
              result: data.result || "",
              done: true,
              isError: !!data.isError,
              startMissing: true,
              expanded: false,
              startTime: null,
              duration: null,
            });
          }
          return { ...m, blocks };
        });
        break;
      // agent 主动提问（ask_user 工具）：追加问题卡片，用户回答后 agent 继续
      case "ask_user":
        if (!aid) aid = ensureAssistant();
        if (aid) {
          if (refs.streamBufRef.current) flushNow(aid);
          deps.setBusy(true);
          deps.setAgentPhase("等待你的回答");
          deps.setRunState((s) => ({ ...s, status: "waiting_user", runId: data.runId || s.runId || null }));
          const askId = (data.askId as string | undefined) || `${data.runId || "ask"}:${data.question || ""}`;
          patch(aid, (m) => m.blocks?.some((block) => block.type === "ask" && block.id === askId)
            ? m
            : ({
              ...m,
              blocks: [...(m.blocks || []), {
                type: "ask",
                id: askId,
                question: data.question || "",
                options: data.options || [],
                // Qoder P1-4：交互归属（服务端开关打开时才带；关闭时不显示归属标签）。
                owner: data.owner || null,
                // 时间窗口：服务端到点即不再接受回答，前端据此把卡片置为"已超时"。
                expiresAt: Number(Date.parse((data.expiresAt as string) || "")) || (Date.now() + ASK_TIMEOUT_FALLBACK_MS),
                answer: "",
              }],
            }));
        }
        break;
      // 工具审批请求（opencode 式 allow/ask/deny）：追加审批卡片，用户批准后 agent 继续
      case "tool_approval_request":
        if (!aid) aid = ensureAssistant();
        if (aid) {
          if (refs.streamBufRef.current) flushNow(aid);
          deps.setBusy(true);
          deps.setAgentPhase("等待你的审批");
          deps.setRunState((s) => ({ ...s, status: "waiting_user", runId: data.runId || s.runId || null }));
          const approvalId = (data.id as string | undefined) || `${data.runId || "approval"}:${data.tool}:${data.input || ""}`;
          patch(aid, (m) => m.blocks?.some((block) => block.type === "approval" && block.id === approvalId)
            ? m
            : ({
              ...m,
              blocks: [...(m.blocks || []), {
                type: "approval",
                id: approvalId,
                tool: data.tool || "",
                input: data.input || "",
                // Qoder P1-4：交互归属（服务端开关打开时才带）。
                owner: data.owner || null,
                decision: "",
              }],
            }));
        }
        break;
      case "tool_approval_resolved":
        if (aid) {
          const approvalId = (data.id as string | undefined) || `${data.runId || "approval"}:${data.tool}:${data.input || ""}`;
          patch(aid, (m) => {
            const blocks = [...(m.blocks || [])];
            const block = blocks.find((b) => b.type === "approval" && b.id === approvalId);
            if (!block) return m;
            block.decision = data.decision === "allow" ? "allow" : "deny";
            return { ...m, blocks };
          });
          deps.setAgentPhase(data.decision === "allow" ? "审批已通过，继续执行" : "操作已被拒绝");
        }
        break;
      // 消息开始/结束
      case "message_start":
        if (data.role === "assistant") {
          deps.setAgentPhase("模型已开始生成");
          aid = ensureAssistant();
          if (aid) {
            if (refs.streamBufRef.current) flushNow(aid);
            patch(aid, (m) => ({ ...m, blocks: appendAssistantMessageBoundary(m.blocks || [], data.messageId as string) }));
          }
        }
        break;
      case "message_end":
        break;
      case "text_boundary":
        if (data.phase === "start") deps.setAgentPhase("模型已开始生成");
        break;
      case "thinking_boundary":
        if (data.phase === "start") deps.setAgentPhase("模型思考");
        break;
      case "tool_call_progress":
        if (data.name) deps.setAgentPhase(`准备工具：${data.name}`);
        break;
      case "agent_queue_update":
        deps.setAgentPhase(data.steering ? "正在调整当前任务" : "正在等待后续任务");
        break;
      case "agent_turn_end":
        if (!refs.agentErrorRef.current) deps.setAgentPhase("整理回复");
        break;
      case "stats":
        deps.setRunState((s) => {
          const usage = s.usage as Record<string, unknown> | null | undefined;
          return {
            ...s,
            usage: data.tokens
              ? {
                ...(data.tokens as Record<string, unknown>),
                contextWindow: usage?.contextWindow,
                compactThreshold: usage?.compactThreshold,
                compactionMode: usage?.compactionMode,
                compactThresholdSource: usage?.compactThresholdSource,
              }
              : null,
            cost: data.cost ?? null,
          };
        });
        break;
      case "agent_retry":
        // Pi 结算失败后，工作台可能会在同一请求内重放一次。失败回合
        // 已经发出 agent_end 并清空了 assistant 引用，这里重新建立一个
        // 流式气泡，避免恢复后的 token 被丢弃。
        if (refs.connectionTimerRef.current) { window.clearTimeout(refs.connectionTimerRef.current); refs.connectionTimerRef.current = null; }
        deps.setConnectionNotice({ state: "retrying" });
        refs.agentErrorRef.current = false;
        cancelTextReveal();
        refs.stoppingRef.current = false;
        refs.stopRequestedRef.current = false;
        refs.roundStoppedRef.current = false;
        deps.setStopping(false);
        deps.setBusy(true);
        deps.setRunState((s) => ({ ...s, status: "running" }));
        if (!refs.assistantIdRef.current) {
          const retryAid = newId();
          refs.assistantIdRef.current = retryAid;
          refs.lastAssistantIdRef.current = retryAid;
          refs.streamingMsgIdRef.current = retryAid;
          refs.streamBufRef.current = { text: "", thinking: "" };
          deps.setMessages((ms) => [...ms, {
            id: retryAid, role: "assistant", blocks: [],
            status: "streaming", images: [], createdAt: Date.now(),
          }]);
        } else {
          patch(refs.assistantIdRef.current, (m) => ({ ...m, status: "streaming", errorText: "" }));
        }
        deps.setAgentPhase(`模型连接重试${data.attempt && data.maxAttempts ? `（${data.attempt}/${data.maxAttempts}）` : ""}`);
        {
          const retryLabels: Record<string, string> = {
            network: "网络波动，正在重试…",
            timeout: "模型响应超时，正在重试…",
            rate_limit: "模型服务繁忙，正在重试…",
            auth: "模型授权校验失败，重试中…",
            quota: "模型额度不足，重试中…",
            configuration: "模型供应商未配置，当前重试可能仍会失败",
            request: "模型请求配置有误，重试中…",
          };
          deps.setConnectionNotice({ state: "retrying", message: retryLabels[String(data.category)] || "模型暂时没有响应，正在重试…" });
        }
        break;
      case "agent_retry_end":
        if (data.success) {
          deps.setAgentPhase("模型连接已恢复");
          // A+B：恢复不再作为系统消息堆在对话里；改为输入框旁状态点，3.5s 后自动消失
          if (refs.connectionTimerRef.current) window.clearTimeout(refs.connectionTimerRef.current);
          deps.setConnectionNotice({ state: "recovered" });
          refs.connectionTimerRef.current = window.setTimeout(() => deps.setConnectionNotice(null), 3500);
        } else {
          if (refs.connectionTimerRef.current) window.clearTimeout(refs.connectionTimerRef.current);
          refs.connectionTimerRef.current = null;
          deps.setConnectionNotice(null);
        }
        break;
      case "agent_model_fallback":
        if (data.to) {
          deps.setModel(data.to as string);
          deps.applyModel(data.to as string);
          deps.setAgentPhase("切换备用模型");
          pushSystem((data.message as string) || `模型连接失败，已切换到 ${data.to}`, `agent_model_fallback:${data.from || "unknown"}:${data.to}`);
        }
        break;
      case "agent_model_fallback_failed":
        pushSystem(`备用模型切换失败：${data.message || "请在设置中检查模型授权"}`, `agent_model_fallback_failed:${data.from || "unknown"}`);
        break;
      case "model_switched": {
        // 模型切换的统一事实来源：排队（本轮结束前不生效）/ 生效 / 通道回退 / 失败。
        const to = String(data.to || "").trim();
        if (data.effective === "after-run") {
          deps.setPendingModel(to);
          deps.setModelMsg(`本轮仍由 ${data.from || model || "当前模型"} 执行；已排队，本轮结束后切换为 ${to}`);
          break;
        }
        if (data.effective === "failed") {
          deps.setPendingModel("");
          deps.setModelMsg(`模型切换失败：${data.message || to || "未知原因"}`);
          setTimeout(() => deps.setModelMsg(""), 6000);
          break;
        }
        if (to) {
          deps.setModel(to);
          deps.applyModel(to);
          deps.rememberModel(to);
          deps.onModelChange?.(to);
        }
        deps.setPendingModel("");
        deps.setModelMsg(data.reason === "fallback" ? `通道回退为 ${to}` : `已切换为 ${to}`);
        setTimeout(() => deps.setModelMsg(""), 4000);
        break;
      }
      case "todo_updated":
        deps.setTodoItems(Array.isArray(data.todos) ? data.todos : []);
        deps.setRunState((s) => ({
          ...s,
          runId: data.runId || s.runId,
          todoProgress: data.todoProgress || s.todoProgress,
        }));
        break;
      case "thinking_level":
        deps.setRunState((s) => ({ ...s, thinkingLevel: data.effective || null }));
        if (data.effective) deps.setAgentPhase(`设置思考深度：${data.effective === "low" ? "低" : data.effective === "medium" ? "标准" : data.effective === "high" ? "高" : "最大"}`);
        break;
      case "agent_queued":
        deps.setAgentPhase(`任务排队${data.position ? `（第 ${data.position} 项）` : ""}`);
        deps.setRunState((s) => ({ ...s, status: "queued", runId: data.runId || s.runId || null }));
        break;
      case "capability_plan":
        {
          const plan = data.plan || {};
          if (data.runId) refs.activeRunIdRef.current = data.runId as string;
          // 准备阶段要如实推进状态行：从"任务已受理"到"请求模型"之间还有能力/工具边界/
          // 思考深度几步（合计 1~2 秒），旧文案在这段时间是静止的，看起来就是"卡住了"。
          deps.setAgentPhase("准备能力与工具边界");
          deps.setRunState((s) => ({ ...s, capabilityPlan: plan }));
        }
        break;
      case "mode_policy":
        {
          const mode = normalizeUiMode(data.mode);
          deps.setEditMode(forcedMode ? normalizeUiMode(forcedMode) : mode);
          deps.setAgentPhase(`应用${mode === "chat" ? "只读" : mode === "review" ? "审查" : "执行"}工具边界`);
          deps.setRunState((s) => ({ ...s, mode, modePolicy: data }));
        }
        break;
      case "assistant_final":
        if (!aid) aid = ensureAssistant();
        if (aid && data.text) {
          patch(aid, (m) => ({ ...m, authoritativeFinalText: String(data.text) }));
          enqueueTextReveal(aid, data.text, { authoritative: true });
        }
        break;
      case "context_compacted":
        deps.setRunState((s) => {
          const estimated = Number(data.estimatedTokensAfter || 0);
          return {
            ...s,
            usage: estimated > 0
              ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, context: estimated }
              : null,
            compaction: {
              count: Number((s.compaction as Record<string, unknown> | null | undefined)?.count || 0) + 1,
              automatic: !!data.automatic,
              tokensBefore: Number(data.tokensBefore || 0),
              tokensAfter: estimated,
              at: envelope.at || new Date().toISOString(),
            },
          };
        });
        deps.pushSystemNote({
          key: "compact",
          kind: "compact",
          text: `${data.automatic ? "已自动压缩上下文" : "已压缩上下文"}${data.tokensBefore ? `（压缩前约 ${Number(data.tokensBefore).toLocaleString()} tokens）` : ""}`,
        });
        break;
      case "context_compacting":
        deps.setAgentPhase("正在压缩上下文");
        deps.pushSystemNote({ key: "compact", kind: "compact", text: "上下文较长，正在压缩重复过程信息…", pending: true });
        break;
      case "context_compact_warning":
        deps.pushSystemNote({
          key: "compact-warning",
          kind: "compact",
          text: `自动压缩未完成：${data.message || "将继续使用当前上下文"}`,
          pending: true,
        });
        break;
      case "agent_end": {
        const endedWithError = refs.agentErrorRef.current;
        flushToolOutput();
        if (refs.streamBufRef.current) flushNow(aid);
        if (aid) finishTextReveal(aid);
        refs.assistantIdRef.current = null;
        refs.streamBufRef.current = null;
        refs.streamingMsgIdRef.current = null;
        // agent_end 只表示 Pi 当前回合结束；工作区快照、产物发布和
        // run_finished 仍可能在后台收尾。保持 busy 到权威终结事件，
        // 避免下一条排队消息抢先启动后又被旧 run_finished 清掉状态。
        // 例外：本轮已经按中断收尾（aborted 先到）——此时不能再把输入区拉回"运行中"，
        // 否则徽记说「已停止生成」而输入框还显示「中断」。run_finished 到达时照常收尾。
        if (!refs.roundStoppedRef.current) {
          deps.setBusy(true);
          refs.runInProgressRef.current = true;
        }
        refs.stoppingRef.current = false;
        refs.stopRequestedRef.current = false;
        deps.setStopping(false);
        deps.setAgentPhase(endedWithError ? "模型调用失败" : "");
        deps.setRunState((s) => ({ ...s, status: refs.roundStoppedRef.current ? "aborted" : (endedWithError ? "failed" : "finishing") }));
        if (!endedWithError && deps.onAgentEnd) deps.onAgentEnd();
        break;
      }
      case "run_draining":
        // Qoder P0-3 前端收尾态（开关 qoderDrainOnAbort，默认关）：
        // 服务端中断后先发 run_draining，再做有界排空（默认 ≤1.5s，静默 300ms 即结束）。
        // 这里只把状态行切成「正在收尾」，让用户看到中断确实在收尾，而不是以为界面卡住；
        // 刻意不改 runState.status（LIVE_RUN_STATUSES / 对账逻辑的判定口径保持原样）。
        // 开关关闭时服务端不发该事件，本分支不会触发。
        if (flag("qoderDrainOnAbort")) {
          refs.agentEventAtRef.current = Date.now();
          deps.setAgentPhase("正在收尾（投递在途消息）");
        }
        break;
      case "agent_error":
        // 用户点了中断（或本轮已被标记取消）时，SDK 会以 "Request aborted" 之类收尾。
        // 这不是"生成失败"：早先这里会先打上错误徽记与「模型调用失败：Request aborted」，
        // 几秒后才被 aborted 改成「本轮已中断」——用户看到的就是"中断时先报错"。
        if (refs.stoppingRef.current || refs.stopRequestedRef.current) {
          const abortMessage = String(data.message || "");
          if (/abort|cancel|中断|已取消|interrupted/i.test(abortMessage)) {
            if (refs.connectionTimerRef.current) window.clearTimeout(refs.connectionTimerRef.current);
            refs.connectionTimerRef.current = null;
            deps.setConnectionNotice(null);
            flushToolOutput();
            refs.agentErrorRef.current = false;
            cancelTextReveal({ preserveText: true });
            finalizeStopped();
            break;
          }
        }
        if (refs.connectionTimerRef.current) window.clearTimeout(refs.connectionTimerRef.current);
        refs.connectionTimerRef.current = null;
        deps.setConnectionNotice(null);
        flushToolOutput();
        refs.agentErrorRef.current = true;
        cancelTextReveal({ preserveText: true });
        {
          const errorMessage = eventMessageText(data.message, data.category === "quota" ? "当前模型额度不足" : "模型调用失败");
          const errorLabels: Record<string, string> = {
            quota: "模型额度不足",
            auth: "模型授权失败",
            configuration: "模型供应商未配置",
            timeout: "模型响应超时",
            rate_limit: "模型服务繁忙",
            network: "模型网络连接失败",
            request: "模型请求无效",
          };
          const errorActions: Record<string, string> = {
            quota: "请检查模型额度或切换供应商",
            auth: "请检查供应商密钥和授权",
            configuration: "请在模型设置中配置该供应商",
            timeout: "可稍后重试或切换响应更快的模型",
            rate_limit: "请稍后重试，或降低并发",
            network: "请检查本机网络、代理和供应商服务状态",
            request: "请检查模型 ID 和请求参数",
          };
          const errorCategory = String(data.category || "unknown");
          const errorLabel = errorLabels[errorCategory] || "模型调用失败";
          const errorAction = errorActions[errorCategory] || (data.retryable === false ? "" : "请检查模型配置与网络后重试");
          const errorText = `${errorLabel}：${errorMessage}${errorAction ? `。${errorAction}` : ""}`;
          if (aid) patch(aid, (m) => ({ ...m, status: "error", errorText }));
          refs.assistantIdRef.current = null;
          refs.streamBufRef.current = null;
          refs.streamingMsgIdRef.current = null;
          // 有 runId 时等待 run_finished 统一收尾；若只是 Runtime 握手错误
          // 没有关联 Run，才立即恢复输入框。
          const errorRunId = data.runId || runState.runId;
          deps.setBusy(Boolean(errorRunId));
          refs.runInProgressRef.current = Boolean(errorRunId);
          refs.stoppingRef.current = false;
          refs.stopRequestedRef.current = false;
          refs.roundStoppedRef.current = false;
          deps.setStopping(false);
          deps.setAgentPhase(errorLabels[errorCategory] || "模型调用失败");
          deps.setRunState((s) => ({ ...s, status: "failed", runId: data.runId || s.runId || null }));
        }
        break;
      case "steer": {
        const source = String(data.source || "user");
        const message = String(data.message || data.text || "").trim();
        if (source === "turn-progress" || source.startsWith("turn-budget")) {
          // 轮次/预算提示是 harness 内部控制事件，不把原始提示词或轮次计数展示给用户。
          // 模型生成的进度小结仍作为普通过程播报，进入消息级折叠。
        } else if (message) {
          pushSystem(`⟳ 插入新指令：${message.slice(0, 60)}${message.length > 60 ? "…" : ""}`, `steer:${message.slice(0, 40)}`);
        }
        break;
      }
      case "aborted":
        if (refs.connectionTimerRef.current) window.clearTimeout(refs.connectionTimerRef.current);
        refs.connectionTimerRef.current = null;
        deps.setConnectionNotice(null);
        flushToolOutput();
        finalizeStopped();
        break;
      case "file_changed":
        {
          const files = Array.isArray(data.files) ? (data.files as unknown[]).filter(Boolean) : [];
          // 按轮次聚合：同一轮内多次改文件只保留一条摘要，条目内合并文件名
          deps.pushSystemNote({
            key: "file_changed",
            kind: "file",
            text: `文件已更新：${files.join("、")}`,
            files,
          });
        }
        const rawFiles = data.files as unknown[] | undefined;
        if (rawFiles?.length) deps.onFileChanged?.(rawFiles);
        break;
      case "map_action":
        if (data && acceptSystemEvent(`map_action:${data.id || "analysis"}:${data.updatedAt || JSON.stringify(data.stats || {})}`)) {
          if (data.action === "clear_analysis") {
            pushSystem("已清除地图临时分析结果");
            deps.setLastMapVisual(null);
            deps.setMapVisualHint("");
          } else {
            pushSystem(`地图分析已生成：${data.title || data.analysis || "分析结果"}${data.source === "demo" ? "（演示数据）" : ""}`);
            // 阶段 4.4：记住最近一次地图可视化，结果区据此提示"临时，未保存"。
            // 数据源就是既有 map_action 事件（persist:false，不落盘），不新增 SSE。
            deps.setMapVisualHint("");
            deps.setLastMapVisual({
              id: data.id || "agent-analysis",
              title: data.title || data.analysis || "分析结果",
              demo: data.source === "demo",
              at: Date.now(),
            });
          }
          deps.onMapAction?.(data);
        }
        break;
      case "agent_summary":
        // 对话结束总结条。
        // R04：agent_summary 在权威终态之前发出且可能不带 status，绝不能据此宣告完成——
        // 状态缺失时由 upsertRunSummary 显示“状态待同步”，等 run_finished 再定终态。
        {
          const key = `agent_summary:${data.runId || "unknown"}:${((data.products as string[] | undefined) || []).join("|")}:${data.summary || ""}`;
          if (!acceptSystemEvent(key)) break;
        }
        upsertRunSummary({ ...data });
        break;
      case "run_finished": {
        flushToolOutput();
        // 首字延迟结算：run_finished 是本轮唯一的终态信号，
        // 成功后上报一次（sendBeacon，刷新/关闭页面也不丢）。
        finalizeLatencyProbe({ runId: data?.runId || refs.activeRunIdRef.current || runState.runId || null, finalStatus: data?.status || null });
        // SSE 可能只保留了终结事件，或 agent_end 先清理了本地气泡。
        // 服务端从 Pi 的 assistant_final 事件带回权威全文，在这里补齐回复。
        // 断线重连回放时旧 run 的 run_finished 会穿透 runId 过滤：只允许把
        // 权威全文注入当前活跃 run 的气泡，跨 run 的旧文本一律丢弃。
        // 无本地锚点且本地不在运行（恢复/重连）时，也允许用权威全文兜底补齐。
        const knownRunId = refs.activeRunIdRef.current || runState.runId || null;
        const finalTextAllowed = data.runId && knownRunId
          ? data.runId === knownRunId
          : (!data.runId && !refs.runInProgressRef.current && !busy);
        if (data.finalText && finalTextAllowed) {
          if (!aid) aid = refs.assistantIdRef.current || refs.lastAssistantIdRef.current || ensureAssistant(true);
          if (aid) {
            patch(aid, (m) => ({ ...m, authoritativeFinalText: String(data.finalText) }));
            enqueueTextReveal(aid, data.finalText, { authoritative: true });
          }
        }
        if (data.runId && refs.activeRunIdRef.current === data.runId) refs.activeRunIdRef.current = null;
        {
          // R04：run_finished 是终态信号，但缺失 status 时不得谎报“完成”——显示“状态待同步”，
          // 同时照常释放 busy（运行确实已结束，不能永久卡在运行态）。
          const finalStatus = (data.status as string) || "unknown";
          deps.setRunState((s) => ({
            ...s,
            status: finalStatus,
            runId: data.runId || s.runId || null,
            artifacts: Array.isArray(data.artifacts) && data.artifacts.length ? data.artifacts : s.artifacts,
            references: data.references || s.references || [],
            verificationStatus: data.verificationStatus || s.verificationStatus || "not_checked",
          }));
          if (!["running", "queued", "waiting_user", "recovering", "cancel_requested"].includes(finalStatus)) {
            if (refs.connectionTimerRef.current) window.clearTimeout(refs.connectionTimerRef.current);
            refs.connectionTimerRef.current = null;
            deps.setConnectionNotice(null);
            deps.setBusy(false);
            refs.runInProgressRef.current = false;
            deps.setStopping(false);
            deps.setAgentPhase("");
            if (finalStatus === "failed") refs.agentErrorRef.current = true;
            if (aid) finishTextReveal(aid);
          }
        }
        upsertRunSummary({ ...data, fresh: Boolean(data.runId) && data.runId === knownRunId });
        // run_finished 才是本轮产物完整可用的时点；交给 App 自动打开首个产物。
        deps.onRunFinished?.(data);
        if (data.runId && !["cancelled", "aborted"].includes(data.status as string)) deps.flushQueued(true);
        break;
      }
      case "memory_proposal": {
        // A03：记忆建议不再插入主消息流（会与任务结论争注意力），只挂到本轮结果卡的待审核入口；
        // 审核与状态在「设置 → 记忆」的待审核列表里进行。
        const proposalId = String((data.proposal as Record<string, unknown> | undefined)?.id || "");
        if (proposalId && acceptSystemEvent(`memory_proposal:${proposalId}`)) {
          const targetRunId = refs.activeRunIdRef.current || runState.runId || null;
          deps.setMessages((ms) => {
            for (let i = ms.length - 1; i >= 0; i -= 1) {
              const item = ms[i]!;
              if (!item?.summary) continue;
              if (targetRunId && item.runId !== targetRunId) continue;
              const next = [...ms];
              next[i] = { ...item, memoryProposalIds: [...new Set([...((item.memoryProposalIds as unknown[] | undefined) || []), proposalId])] };
              return next;
            }
            return ms;
          });
        }
        break;
      }
      case "memory_proposal_resolved": {
        // 审核完成后从结果卡入口移除，不再追加“第二篇任务总结”
        const resolvedId = String((data.proposal as Record<string, unknown> | undefined)?.id || "");
        if (resolvedId) {
          deps.setMessages((ms) => ms.map((m) => Array.isArray(m.memoryProposalIds) && (m.memoryProposalIds as unknown[]).includes(resolvedId)
            ? { ...m, memoryProposalIds: (m.memoryProposalIds as unknown[]).filter((id) => id !== resolvedId) }
            : m));
        }
        break;
      }
      default:
        break;
    }
  }

  // 立即刷新流式缓冲（工具边界、agent_end 前调用）（旧 2800-2814）
  const flushNow = (id: string | null): void => {
    if (refs.rafRef.current) { cancelAnimationFrame(refs.rafRef.current); refs.rafRef.current = null; }
    const buf = refs.streamBufRef.current;
    if (id && buf && (buf.text || buf.thinking)) {
      const { text, thinking } = buf;
      patch(id, (m) => {
        let blocks = [...(m.blocks || [])];
        if (text) blocks = appendTextBlock(blocks, text);
        if (thinking) blocks = appendThinkingBlock(blocks, thinking);
        return { ...m, blocks };
      });
      buf.text = "";
      buf.thinking = "";
    }
  };

  // 系统提示气泡（旧 2816-2820）。deps.pushSystemText 由组件层接到 pushSystem 的
  // 实现上（含 acceptSystemEvent 去重与 setMessages 追加），这里拆两层是为让
  // handleEvent 内的调用点与旧代码逐行对应。
  const pushSystem = (text: string, key: unknown = text): void => {
    if (!refs.mountedRef.current) return;
    if (!acceptSystemEvent(key)) return;
    deps.setMessages((ms) => [...ms, { id: newId(), role: "system", text, status: "done", createdAt: Date.now() }]);
  };

  // 运行摘要卡（旧 2822-2835）
  const upsertRunSummary = (data: Record<string, unknown> = {}): void => {
    const runId = data.runId || null;
    if (!runId) return;
    const id = newId();
    const createdAt = Date.now();
    deps.setMessages((messages) => {
      return upsertRunSummaryMessage(messages, data, {
        id,
        createdAt,
        workspace: deps.getWorkspace() || "",
        runMode: deps.getRunState().mode || "agent",
      }) as unknown as ChatMessage[];
    });
  };

  // 中断收尾（旧 2856-2877）
  const finalizeStopped = (): void => {
    const id = refs.assistantIdRef.current;
    cancelTextReveal({ preserveText: true });
    // 中断收尾必须清掉错误文案：否则结果卡里会留一条「模型调用失败：Request aborted」，
    // 与「本轮已中断」并存，看起来像"中断顺带把模型弄坏了"。
    if (id) patch(id, (m) => ({ ...m, status: "done", stopped: true, errorText: "" }));
    refs.assistantIdRef.current = null;
    refs.streamBufRef.current = null;
    refs.streamingMsgIdRef.current = null;
    refs.activeRunIdRef.current = null;
    refs.stoppingRef.current = false;
    refs.stopRequestedRef.current = false;
    refs.roundStoppedRef.current = true;
    if (refs.stopConfirmTimerRef.current) {
      window.clearTimeout(refs.stopConfirmTimerRef.current);
      refs.stopConfirmTimerRef.current = null;
    }
    deps.setStopping(false);
    deps.setBusy(false);
    refs.runInProgressRef.current = false;
    deps.setRunState((s) => ({ ...s, status: "aborted" }));
  };

  return {
    handleEvent,
    patch,
    flushToolOutput,
    queueToolOutput,
    rememberDisplayedText,
    cancelTextReveal,
    enqueueTextReveal,
    finishTextReveal,
    scheduleFlush,
    acceptSystemEvent,
    flushNow,
    pushSystem,
    upsertRunSummary,
    finalizeStopped,
  };
}

export type ChatEventMachine = ReturnType<typeof createChatEventMachine>;
