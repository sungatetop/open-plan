// @vitest-environment jsdom
/**
 * F4-1 对拍：TaskCenter（任务中心，R11 任务运行面）逐行等价迁移。
 *
 * 形态（沿 F3 双侧同流基建）：
 *   - 旧侧 client/src/components/TaskCenter.jsx（fetch api.js），新侧
 *     features/tasks/task-center.tsx（client-api.ts → IPC runs 通道，S3-2 起直调）。
 *   - 双侧 API 层分别 vi.mock（保留原模块其余导出），同参数分送同一行为表，
 *     调用序列与全 DOM（innerHTML）逐字节比较。
 *
 * 场景：
 *   A 挂载初始态（关闭/触发钮 + hideTrigger 形态）全 DOM 一致
 *   B 打开空列表（runs:[]）过滤区/汇总/空态一致
 *   C 列表 fixture 矩阵（8 态 + null 过滤 + 标题清洗正则 + meta 拼接）一致
 *   D 明细加载（completed + artifacts 无 acceptance → getRunAcceptance 补充链）
 *     状态行/完成说明/未完成/受阻/任务清单/执行步骤/产物验收/事件摘要一致
 *   E 取消动作链（cancelRun(id, 默认原因) → refresh → 明细替换 → 动作按钮收敛；
 *     cancel 不触发 onOpenRun）
 *   F 打开对应对话三分支（session 匹配 → onSelectSession / threadId 命中当前 →
 *     onFocusRun / 仅 run id → onOpenRun / 无关联 → 错误文案）
 *
 * 确定性：双侧共用同一行为表与 fixture；事件时间戳 toLocaleTimeString 同进程同 locale；
 * 明细轮询（3s/10s interval）真实定时器在断言窗口内不触发，afterEach unmount 清理。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// 视口压到 ≤560：组件的窄屏分支不走 Portal（floatingRect 恒 null，面板内联渲染在
// 挂载容器内）——否则 open 后面板 Portal 到 document.body，容器内只剩触发钮。
// 浮层定位是纯 CSS 数学（两侧同码），不在此对拍范围。
Object.defineProperty(window, "innerWidth", { configurable: true, value: 480 });

/* ------------------------- 双侧假通道（vi.hoisted 先于组件装配） ------------------------- */

const h = vi.hoisted(() => ({
  /** 每侧每方法的调用参数记录：calls.side.method -> args[][] */
  calls: {
    ts: {} as Record<string, unknown[][]>,
    jsx: {} as Record<string, unknown[][]>,
  },
  /** 行为表：method -> 实现（双侧共用同一实现保证等价） */
  behaviors: {} as Record<string, (...args: unknown[]) => Promise<unknown>>,
}));

function record(side: "ts" | "jsx", method: string, args: unknown[]): void {
  const bucket = (h.calls[side][method] ||= []);
  bucket.push(args);
}

function dispatch(method: string, args: unknown[]): Promise<unknown> {
  const impl = h.behaviors[method];
  if (!impl) throw new Error(`未配置假通道行为: ${method}`);
  return impl(...args);
}

vi.mock("../src/renderer/api/client-api", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  const wrap = (method: string) => (...args: unknown[]) => { record("ts", method, args); return dispatch(method, args); };
  return {
    ...original,
    listRuns: wrap("listRuns"),
    getRun: wrap("getRun"),
    getRunAcceptance: wrap("getRunAcceptance"),
    cancelRun: wrap("cancelRun"),
    resumeRun: wrap("resumeRun"),
    retryRun: wrap("retryRun"),
  };
});

vi.mock("../../client/src/api.js", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  const wrap = (method: string) => (...args: unknown[]) => { record("jsx", method, args); return dispatch(method, args); };
  return {
    ...original,
    listRuns: wrap("listRuns"),
    getRun: wrap("getRun"),
    getRunAcceptance: wrap("getRunAcceptance"),
    cancelRun: wrap("cancelRun"),
    resumeRun: wrap("resumeRun"),
    retryRun: wrap("retryRun"),
  };
});

import TaskCenterTs from "../src/renderer/features/tasks/task-center";

const clientTaskCenter = (await import("../../client/src/components/TaskCenter.jsx")).default;

/* ------------------------------ fixture ------------------------------ */

const BASE = 1_700_000_000_000;
const PROJECTS = [
  { id: "proj-1", name: "市域总规" },
  { id: "proj-2", name: "控规调整" },
];

/** 列表矩阵：状态九态 / 模式三态+缺省 / completion 显式+推断+缺省 / 待办优先于步骤 /
 *  验收双源 / 标题清洗正则 / null 过滤 / 无 task 兜底「未命名任务」。 */
const RUNS: unknown[] = [
  { id: "r1", status: "running", task: { mode: "agent", goal: "[模式:Agent] 编制说明书" }, todoProgress: { completed: 1, total: 3 }, projectId: "proj-1" },
  { id: "r2", status: "queued", task: { mode: "office", title: "批量导出报表" }, projectId: "proj-2" },
  { id: "r3", status: "completed", task: { mode: "chat", goal: "资料问答" }, completion: { status: "success" }, acceptanceStatus: "passed", progress: { completed: 2, total: 2 }, projectId: "proj-1" },
  { id: "r4", status: "failed", summary: "无模式标记任务", completion: { status: "blocked", source: "inferred" }, verificationStatus: "warning" },
  { id: "r5", status: "cancelled" },
  null,
  { id: "r6", status: "waiting_user", task: { mode: "agent", goal: "等待输入" } },
  { id: "r7", status: "recovering", task: { mode: "agent", goal: "恢复中" } },
  { id: "r8", status: "cancel_requested", task: { mode: "agent", goal: "正在中断" } },
];

const DETAIL_BASE = {
  id: "r1",
  status: "completed",
  task: { mode: "agent", goal: "编制国土空间规划说明书" },
  summary: "已完成说明书主体",
  completion: {
    status: "partial",
    source: "explicit",
    summary: "主体完成，附表待人工确认",
    incomplete: ["附表 3 待确认"],
    blockers: ["指标口径待确认"],
    verification: "自检通过 3 项",
  },
  todoVersion: 1,
  todoProgress: { completed: 2, total: 4 },
  todos: [
    { id: "t1", title: "收集资料", status: "completed" },
    { id: "t2", title: "起草章节", status: "in_progress", note: "第 4 章" },
    { id: "t3", title: "校核指标", status: "blocked" },
    { id: "t4", title: "废弃项", status: "failed" },
  ],
  steps: [
    { id: "s1", name: "读取底图", status: "completed" },
    { id: "s2", name: "撰写正文", status: "running" },
    { id: "s3", name: "导出附件", status: "failed", error: "磁盘只读" },
    { id: "s4", name: "排队项", status: "queued" },
  ],
  artifacts: [{ path: "out/a.docx" }, { path: "out/b.xlsx" }],
  events: [
    { seq: 1, type: "run_started", at: BASE },
    { seq: 2, type: "tool_call", data: { toolName: "write_file", detail: "写入 out/a.docx" }, at: BASE + 1000 },
    { seq: 3, type: "run_finished", data: { summary: "任务结束" }, at: BASE + 2000 },
  ],
  error: "非终态失败原因保留展示",
  actions: { canCancel: true, canResume: true, canRetry: true },
  projectId: "proj-1",
  sessionId: "sess-1",
  threadId: "thread-1",
  acceptanceStatus: "passed",
  verificationStatus: "not_checked",
};

const DETAIL_WITH_ACCEPTANCE = {
  ...DETAIL_BASE,
  acceptance: {
    artifacts: [
      { path: "out/a.docx", status: "passed" },
      { path: "out/b.xlsx", status: "pending" },
    ],
  },
};

const DETAIL_CANCELLED = {
  ...DETAIL_BASE,
  status: "cancelled",
  actions: { canCancel: false, canResume: false, canRetry: true },
};

const DEFAULT_PROPS = {
  sessions: [] as unknown[],
  projects: PROJECTS,
  currentProjectId: "proj-1",
  currentWorkspace: "D:/ws/parity",
  currentThreadId: "thread-cur",
  currentSessionId: "sess-cur",
  eventVersion: 0,
  unreadCount: 0,
};

/* ------------------------------ 挂载与驱动基建 ------------------------------ */

type Host = { container: HTMLElement; root: Root; ref: React.RefObject<unknown> };
type Pair = [Host, Host];

type PropsSpec = Record<string, unknown> | ((side: "ts" | "jsx") => Record<string, unknown>);

async function mountPair(spec: PropsSpec = {}): Promise<Pair> {
  const mk = async (Comp: unknown, side: "ts" | "jsx"): Promise<Host> => {
    const props = typeof spec === "function" ? spec(side) : { ...spec };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const ref = createRef<unknown>();
    await act(async () => {
      root.render(React.createElement(Comp as (p: Record<string, unknown>) => React.ReactElement, { ...DEFAULT_PROPS, ...props, ref }));
    });
    return { container, root, ref };
  };
  return [await mk(TaskCenterTs, "ts"), await mk(clientTaskCenter, "jsx")];
}

async function flushApi(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

async function settle(pair: Pair): Promise<void> {
  for (const host of pair) {
    await act(async () => { await flushApi(); });
    await act(async () => { await flushApi(); });
  }
}

async function openCenter(host: Host): Promise<void> {
  await act(async () => {
    (host.ref.current as { open(): void }).open();
  });
}

async function clickButton(host: Host, text: string): Promise<void> {
  const buttons = [...host.container.querySelectorAll("button")];
  const btn = buttons.find((b) => (b.textContent || "").includes(text));
  if (!btn) throw new Error(`未找到按钮: ${text}`);
  await act(async () => { btn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await act(async () => { await flushApi(); });
}

function recorded(side: "ts" | "jsx", method: string): unknown[][] {
  return h.calls[side][method] || [];
}

/* ------------------------------ 用例 ------------------------------ */

describe("F4-1 TaskCenter 双侧同流对拍（TS ↔ client JSX）", () => {
  beforeEach(() => {
    h.calls.ts = {};
    h.calls.jsx = {};
    h.behaviors.listRuns = () => Promise.resolve({ runs: RUNS });
    h.behaviors.getRun = () => Promise.resolve({ run: { ...DETAIL_BASE } });
    h.behaviors.getRunAcceptance = () => Promise.resolve({ run: { ...DETAIL_WITH_ACCEPTANCE } });
    h.behaviors.cancelRun = () => Promise.resolve({ run: { ...DETAIL_CANCELLED } });
    h.behaviors.resumeRun = () => Promise.resolve({ run: { ...DETAIL_BASE, status: "running" } });
    h.behaviors.retryRun = () => Promise.resolve({ run: { ...DETAIL_BASE, status: "queued" } });
  });

  let pair: Pair | null = null;
  afterEach(async () => {
    if (pair) {
      for (const host of pair) {
        await act(async () => { host.root.unmount(); });
        host.container.remove();
      }
      pair = null;
    }
  });

  it("A 挂载初始态：触发钮形态与 hideTrigger 形态全 DOM 一致", async () => {
    pair = await mountPair();
    expect(pair[0].container.innerHTML).toBe(pair[1].container.innerHTML);
    expect(pair[0].container.querySelector(".task-center-trigger")).not.toBeNull();
    expect(pair[0].container.textContent).toContain("任务");

    await act(async () => { pair![0].root.unmount(); });
    await act(async () => { pair![1].root.unmount(); });
    pair[0].container.remove();
    pair[1].container.remove();
    pair = await mountPair({ hideTrigger: true, anchorRef: { current: null } });
    expect(pair[0].container.innerHTML).toBe(pair[1].container.innerHTML);
    expect(pair[0].container.querySelector(".task-center-trigger")).toBeNull();
  });

  it("B 打开空列表：过滤区/汇总/空态一致，listRuns 请求参数逐字段一致", async () => {
    h.behaviors.listRuns = () => Promise.resolve({ runs: [] });
    pair = await mountPair();
    await settle(pair);
    await openCenter(pair[0]);
    await openCenter(pair[1]);
    await settle(pair);
    expect(pair[0].container.innerHTML).toBe(pair[1].container.innerHTML);
    expect(pair[0].container.textContent).toContain("暂无任务记录");
    const tsArgs = recorded("ts", "listRuns");
    const jsxArgs = recorded("jsx", "listRuns");
    expect(tsArgs.length).toBeGreaterThan(0);
    expect(jsxArgs).toEqual(tsArgs);
    // 列表与徽标只读摘要带宽护栏：fields:"summary" 原样传递
    expect(JSON.stringify(tsArgs[tsArgs.length - 1])).toContain('"fields":"summary"');
  });

  it("C 列表矩阵：8 态卡片 + null 过滤 + 标题清洗 + meta 拼接逐字节一致", async () => {
    pair = await mountPair();
    await settle(pair);
    await openCenter(pair[0]);
    await openCenter(pair[1]);
    await settle(pair);
    expect(pair[0].container.innerHTML).toBe(pair[1].container.innerHTML);
    expect(pair[0].container.querySelectorAll(".task-center-item").length).toBe(8);
    expect(pair[0].container.textContent).toContain("编制说明书");
    expect(pair[0].container.textContent).toContain("Agent · 执行中");
    expect(pair[0].container.textContent).toContain("步骤 1/3");
    expect(pair[0].container.textContent).toContain("任务受阻（推断）");
    expect(pair[0].container.textContent).toContain("市域总规 · Chat · 运行结束");
    expect(pair[0].container.textContent).not.toContain("[模式:Agent]");
  });

  it("D 明细加载：completed+artifacts 无 acceptance → getRunAcceptance 补充链与全 DOM 一致", async () => {
    pair = await mountPair();
    await settle(pair);
    await openCenter(pair[0]);
    await openCenter(pair[1]);
    await settle(pair);
    await clickButton(pair[0], "编制说明书");
    await clickButton(pair[1], "编制说明书");
    expect(recorded("ts", "getRun")).toEqual(recorded("jsx", "getRun"));
    expect(recorded("ts", "getRunAcceptance")).toEqual(recorded("jsx", "getRunAcceptance"));
    expect(recorded("ts", "getRun")[0]).toEqual(["r1"]);
    expect(pair[0].container.innerHTML).toBe(pair[1].container.innerHTML);
    expect(pair[0].container.textContent).toContain("编制国土空间规划说明书");
    expect(pair[0].container.textContent).toContain("运行状态");
    expect(pair[0].container.textContent).toContain("部分达成");
    expect(pair[0].container.textContent).toContain("未完成项：附表 3 待确认");
    expect(pair[0].container.textContent).toContain("受阻项：指标口径待确认");
    expect(pair[0].container.textContent).toContain("验证说明：自检通过 3 项");
    expect(pair[0].container.textContent).toContain("任务清单");
    expect(pair[0].container.textContent).toContain("2/4 完成");
    expect(pair[0].container.textContent).toContain("执行步骤");
    expect(pair[0].container.textContent).toContain("磁盘只读");
    expect(pair[0].container.textContent).toContain("a.docx");
    expect(pair[0].container.textContent).toContain("取消任务");
    expect(pair[0].container.textContent).toContain("继续任务");
    expect(pair[0].container.textContent).toContain("重试任务");
    expect(pair[0].container.textContent).toContain("失败原因：非终态失败原因保留展示");
  });

  it("E 取消动作链：cancelRun(id, 默认原因) → refresh → 明细收敛 → onOpenRun 不触发", async () => {
    pair = await mountPair();
    await settle(pair);
    await openCenter(pair[0]);
    await openCenter(pair[1]);
    await settle(pair);
    await clickButton(pair[0], "编制说明书");
    await clickButton(pair[1], "编制说明书");
    await clickButton(pair[0], "取消任务");
    await clickButton(pair[1], "取消任务");
    expect(recorded("ts", "cancelRun")).toEqual(recorded("jsx", "cancelRun"));
    // JS 默认参数在函数入口生效，rest 实参列表只含调用实参（reason 缺省不显式出现）
    expect(recorded("ts", "cancelRun")[0]).toEqual(["r1"]);
    expect(recorded("ts", "onOpenRun")).toEqual(recorded("jsx", "onOpenRun"));
    expect(recorded("ts", "onOpenRun").length).toBe(0);
    expect(pair[0].container.innerHTML).toBe(pair[1].container.innerHTML);
    expect(pair[0].container.textContent).toContain("已取消");
    // 按钮级断言（textContent 含状态行拼接"已取消|任务达成"，不能用子串排除按钮）
    const tsButtons = [...pair[0].container.querySelectorAll("button")].map((b) => b.textContent || "");
    expect(tsButtons.some((t) => t.includes("取消任务"))).toBe(false);
    expect(tsButtons.some((t) => t.includes("继续任务"))).toBe(false);
    expect(tsButtons.some((t) => t.includes("重试任务"))).toBe(true);
  });

  it("F1 打开对应对话：session 匹配 → onSelectSession(session) 且弹层关闭", async () => {
    pair = await mountPair((side) => ({
      sessions: [{ id: "sess-1", threadId: "thread-x", title: "会话甲" }],
      onSelectSession: (session: unknown) => { record(side, "onSelectSession", [session]); },
      onOpenRun: (run: unknown) => { record(side, "onOpenRun", [run]); },
      onFocusRun: (run: unknown) => { record(side, "onFocusRun", [run]); },
    }));
    await settle(pair);
    await openCenter(pair[0]);
    await openCenter(pair[1]);
    await settle(pair);
    await clickButton(pair[0], "编制说明书");
    await clickButton(pair[1], "编制说明书");
    await clickButton(pair[0], "打开对应对话");
    await clickButton(pair[1], "打开对应对话");
    expect(recorded("ts", "onSelectSession")).toEqual(recorded("jsx", "onSelectSession"));
    expect((recorded("ts", "onSelectSession")[0] as unknown[])[0]).toMatchObject({ id: "sess-1" });
    expect(recorded("ts", "onOpenRun").length).toBe(0);
    expect(recorded("ts", "onFocusRun").length).toBe(0);
    expect(pair[0].container.innerHTML).toBe(pair[1].container.innerHTML);
    expect(pair[0].container.querySelector(".task-center-panel")).toBeNull();
  });

  it("F2 打开对应对话：threadId 命中当前对话 → onFocusRun(run) 不关面板", async () => {
    pair = await mountPair((side) => ({
      onSelectSession: (session: unknown) => { record(side, "onSelectSession", [session]); },
      onOpenRun: (run: unknown) => { record(side, "onOpenRun", [run]); },
      onFocusRun: (run: unknown) => { record(side, "onFocusRun", [run]); },
    }));
    // 当前 threadId=thread-cur ≠ detail.threadId=thread-1 —— 改走 onOpenRun 分支，
    // 因此本用例以「sessionId 命中当前对话」驱动 onFocusRun：currentSessionId=sess-cur。
    // 当前 threadId=thread-cur ≠ detail.threadId —— 以「sessionId 命中当前对话」驱动
    // onFocusRun：变体须同时覆盖 getRunAcceptance（acceptance 补充链会整体替换明细，
    // 仅改 getRun 会被 DETAIL_WITH_ACCEPTANCE 的 sess-1 还原）。
    h.behaviors.getRun = () => Promise.resolve({ run: { ...DETAIL_BASE, sessionId: "sess-cur", threadId: "thread-other" } });
    h.behaviors.getRunAcceptance = () => Promise.resolve({ run: { ...DETAIL_WITH_ACCEPTANCE, sessionId: "sess-cur", threadId: "thread-other" } });
    await settle(pair);
    await openCenter(pair[0]);
    await openCenter(pair[1]);
    await settle(pair);
    await clickButton(pair[0], "编制说明书");
    await clickButton(pair[1], "编制说明书");
    await clickButton(pair[0], "打开对应对话");
    await clickButton(pair[1], "打开对应对话");
    expect(recorded("ts", "onFocusRun")).toEqual(recorded("jsx", "onFocusRun"));
    expect((recorded("ts", "onFocusRun")[0] as unknown[])[0]).toMatchObject({ id: "r1" });
    expect(recorded("ts", "onSelectSession").length).toBe(0);
    expect(recorded("ts", "onOpenRun").length).toBe(0);
    // 非全页形态：分支后 closePanel 关闭弹层
    expect(pair[0].container.querySelector(".task-center-panel")).toBeNull();
    expect(pair[0].container.innerHTML).toBe(pair[1].container.innerHTML);
  });

  it("F3 打开对应对话：仅 run 关联 id → onOpenRun(run)；无关联 → 错误文案一致", async () => {
    pair = await mountPair((side) => ({
      onSelectSession: (session: unknown) => { record(side, "onSelectSession", [session]); },
      onOpenRun: (run: unknown) => { record(side, "onOpenRun", [run]); },
      onFocusRun: (run: unknown) => { record(side, "onFocusRun", [run]); },
    }));
    h.behaviors.getRun = () => Promise.resolve({ run: { ...DETAIL_BASE, sessionId: "sess-other", threadId: "thread-other" } });
    h.behaviors.getRunAcceptance = () => Promise.resolve({ run: { ...DETAIL_WITH_ACCEPTANCE, sessionId: "sess-other", threadId: "thread-other" } });
    await settle(pair);
    await openCenter(pair[0]);
    await openCenter(pair[1]);
    await settle(pair);
    await clickButton(pair[0], "编制说明书");
    await clickButton(pair[1], "编制说明书");
    await clickButton(pair[0], "打开对应对话");
    await clickButton(pair[1], "打开对应对话");
    expect(recorded("ts", "onOpenRun")).toEqual(recorded("jsx", "onOpenRun"));
    expect((recorded("ts", "onOpenRun")[0] as unknown[])[0]).toMatchObject({ id: "r1", sessionId: "sess-other" });
    expect(pair[0].container.innerHTML).toBe(pair[1].container.innerHTML);

    // 无关联 id：抛「任务没有关联的会话」→ error 区展示，面板保持
    await act(async () => { pair![0].root.unmount(); });
    await act(async () => { pair![1].root.unmount(); });
    pair[0].container.remove();
    pair[1].container.remove();
    h.calls.ts = {};
    h.calls.jsx = {};
    h.behaviors.getRun = () => Promise.resolve({ run: { ...DETAIL_BASE, sessionId: undefined, threadId: undefined } });
    h.behaviors.getRunAcceptance = () => Promise.resolve({ run: { ...DETAIL_BASE, sessionId: undefined, threadId: undefined } });
    pair = await mountPair((side) => ({
      onSelectSession: (session: unknown) => { record(side, "onSelectSession", [session]); },
      onOpenRun: (run: unknown) => { record(side, "onOpenRun", [run]); },
      onFocusRun: (run: unknown) => { record(side, "onFocusRun", [run]); },
    }));
    await settle(pair);
    await openCenter(pair[0]);
    await openCenter(pair[1]);
    await settle(pair);
    await clickButton(pair[0], "编制说明书");
    await clickButton(pair[1], "编制说明书");
    await clickButton(pair[0], "打开对应对话");
    await clickButton(pair[1], "打开对应对话");
    expect(recorded("ts", "onOpenRun").length).toBe(0);
    expect(recorded("ts", "onSelectSession").length).toBe(0);
    expect(pair[0].container.textContent).toContain("任务没有关联的会话");
    expect(pair[0].container.innerHTML).toBe(pair[1].container.innerHTML);
  });
});
