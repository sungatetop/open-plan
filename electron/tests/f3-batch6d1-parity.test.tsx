// @vitest-environment jsdom
/**
 * F3 批6d-1 对拍：ChatPanel 叶子展示族（message-parts / interaction-parts /
 * execution-flow，自 ChatPanel.jsx 4056-4100 + 4907-5821 段拆出）。
 *
 * 对拍口径（锚点 + 交互语义，批5b-1「TS 绝对锚点」先例）：
 *   - 叶子组件为旧模块私有符号（未导出），旧侧无直接挂载入口；纯函数锚点值由
 *     node 执行旧源码原文本（readableProgressText/toolPhrase 抽取求值）生成，
 *     组件锚点按旧 JSX 结构逐字段转录；真双侧同流全 DOM 对拍在批6d-3
 *     （挂载旧 ChatPanel vs 新主组件，同一份消息样本贯穿本批全部叶子件）补齐。
 *   - 交互语义对拍：旧内联 fetch("/api/agent/approval"、"/api/agent/answer") 的
 *     请求形态（channel + body 深等）、404 失效分支、失败文案形状
 *     （服务端 error → 「label（status）」→「label，请重试」）逐一验证。
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const P = await import("../src/renderer/features/chat/message-parts");
const I = await import("../src/renderer/features/chat/interaction-parts");
const E = await import("../src/renderer/features/chat/execution-flow");

// 动态 import 命名空间不能用作类型命名空间（批6b 经验），类型走 import() 别名
type ToolBlock = import("../src/renderer/features/chat/message-parts").ToolBlock;

/* ------------------------- 挂载与查询工具 ------------------------- */

function mount(node: React.ReactNode): { host: HTMLElement; unmount: () => void; rerender: (next: React.ReactNode) => void } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  let root: Root | null = null;
  act(() => {
    root = createRoot(host);
    root.render(node);
  });
  return {
    host,
    unmount: () => {
      const r = root;
      if (r) act(() => { r.unmount(); });
      host.remove();
    },
    rerender: (next: React.ReactNode) => {
      act(() => { (root as Root).render(next); });
    }
  };
}

function click(el: Element | null | undefined): void {
  expect(el, "待点击元素存在").toBeTruthy();
  act(() => { el!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
}

function text(el: Element | null | undefined): string {
  return el?.textContent ?? "";
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

interface IpcCall { channel: string; payload?: Record<string, unknown> }

/**
 * IPC 桥 stub：按通道响应；failChannel 指定通道返回 ok:false（status + data 可配）。
 * failChannel 在调用入队后触发（calls 已含本次），按 calls.length 区分第几次调用。
 */
function stubIpc(respond: (channel: string, payload?: Record<string, unknown>) => unknown, failChannel?: (channel: string, calls: IpcCall[]) => { status: number; data: Record<string, unknown> } | null): { calls: IpcCall[] } {
  const calls: IpcCall[] = [];
  (window as unknown as { opDesktop: unknown }).opDesktop = {
    invoke: async (channel: string, payload?: Record<string, unknown>) => {
      calls.push({ channel, payload });
      const fail = failChannel?.(channel, calls);
      if (fail) return { ok: false, status: fail.status, data: fail.data };
      return { ok: true, status: 200, data: respond(channel, payload) };
    }
  };
  return { calls };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (window as unknown as { opDesktop?: unknown }).opDesktop;
  window.localStorage.clear();
});

/* ------------------------- 纯函数锚点（值由旧源码原文本执行生成） ------------------------- */

describe("readableProgressText / toolPhrase（锚点=旧源码执行值）", () => {
  it("readableProgressText：标题/列表/链接图片剥离、表格行分隔符、引用与行内标记", () => {
    expect(P.readableProgressText("## 标题\n- 列表项\n[链接](http://x) ![图](http://y)")).toBe("标题\n列表项\n链接 图");
    expect(P.readableProgressText("| a | b |\n|---|---|\n正文 **加粗** `code`")).toBe(" · a · b ·\n\n正文 加粗 code");
    expect(P.readableProgressText("> 引用行")).toBe("引用行");
    expect(P.readableProgressText("")).toBe("");
    expect(P.readableProgressText(null)).toBe("");
  });

  it("toolPhrase：语义短语矩阵（含非对象输入 JSON 解析失败回退）", () => {
    expect(P.toolPhrase("bash", JSON.stringify({ args: "ls -la /data" }), true)).toBe("执行命令 ls -la /data");
    expect(P.toolPhrase("read", JSON.stringify({ file_path: "D:/ws/报告.docx" }), false)).toBe("正在读取文件 D:/ws/报告.docx");
    expect(P.toolPhrase("todo", "{}", false)).toBe("正在更新任务清单");
    expect(P.toolPhrase("unknown_tool", null, true)).toBe("调用 unknown_tool");
    expect(P.toolPhrase("bash", "raw-string-input", false)).toBe("执行命令");
    expect(P.toolPhrase("grep", JSON.stringify({ pattern: "客流.*预测" }), false)).toBe("正在搜索内容 客流.*预测");
    expect(P.toolPhrase("find", JSON.stringify({ path: "D:/ws" }), true)).toBe("查看文件列表 D:/ws");
  });
});

/* ------------------------- SafeMarkdown ------------------------- */

describe("SafeMarkdown", () => {
  it("空值返回 null；短文本走 MarkdownBody 完整排版", async () => {
    const a = mount(<P.SafeMarkdown text="" />);
    expect(a.host.innerHTML).toBe("");
    a.unmount();
    const b = mount(<P.SafeMarkdown text="普通**加粗**文本" />);
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(b.host.querySelector(".markdown-body")?.textContent).toContain("普通加粗文本");
    b.unmount();
  });

  it("超长文本：先显示揭示按钮，点击后原文 pre 呈现（KB 数取整）", () => {
    const huge = "x".repeat(101 * 1024);
    const a = mount(<P.SafeMarkdown text={huge} />);
    const btn = a.host.querySelector("button.large-msg-reveal");
    expect(btn?.textContent).toBe("⚠ 内容过长（101 KB），点击查看全文");
    click(btn);
    expect(a.host.querySelector("pre.large-msg-raw")?.textContent).toBe(huge);
    a.unmount();
  });
});

/* ------------------------- ReferenceChips / 流式指示 ------------------------- */

describe("ReferenceChips / StreamingActivityLabel / StreamingDot", () => {
  it("引用条：file 且可打开 → 按钮点击回调 relativePath；missing → span", () => {
    const refs = [
      { id: "r1", kind: "file", status: "ok", target: "D:/abs/报告.docx", metadata: { name: "报告.docx", relativePath: "docs/报告.docx" } },
      { id: "r2", kind: "file", status: "missing", target: "丢失.docx" },
      { id: "r3", kind: "kb", target: "规范#3.2", message: "知识库条目" }
    ];
    const opened: string[] = [];
    const a = mount(<P.ReferenceChips references={refs} onOpenFile={(p) => opened.push(p)} />);
    const chips = a.host.querySelectorAll(".msg-reference-chip");
    expect(chips.length).toBe(3);
    expect(chips[0]!.tagName).toBe("BUTTON");
    expect(text(chips[0])).toContain("@报告.docx");
    click(chips[0]);
    expect(opened).toEqual(["docs/报告.docx"]);
    expect(chips[1]!.tagName).toBe("SPAN");
    expect(chips[2]!.getAttribute("title")).toBe("知识库条目");
    a.unmount();
    const b = mount(<P.ReferenceChips references={[]} onOpenFile={() => {}} />);
    expect(b.host.innerHTML).toBe("");
    b.unmount();
  });

  it("StreamingActivityLabel：短语轮换（4.2s 步进，索引 0→1→3）", () => {
    vi.useFakeTimers();
    const a = mount(<P.StreamingActivityLabel />);
    const label = a.host.querySelector(".msg-streaming-label")!;
    expect(text(label)).toBe("正在聚合资料");
    act(() => { vi.advanceTimersByTime(4200); });
    expect(text(label)).toBe("正在梳理需求");
    act(() => { vi.advanceTimersByTime(4200 * 2); });
    expect(text(label)).toBe("正在调查现状");
    a.unmount();
    vi.useRealTimers();
  });

  it("StreamingDot：四瓣结构与 aria 属性", () => {
    const a = mount(<P.StreamingDot />);
    const dot = a.host.querySelector(".streaming-dot")!;
    expect(dot.getAttribute("title")).toBe("正在处理");
    expect(dot.getAttribute("aria-hidden")).toBe("true");
    expect(dot.querySelector(".streaming-dot-mark")).toBeTruthy();
    a.unmount();
  });
});

/* ------------------------- ThinkingBlock / PipelineCard / SubagentCard ------------------------- */

describe("ThinkingBlock", () => {
  it("embedded 形态：思考中/耗时/字数三态", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-21T10:00:10.000Z"));
    const a = mount(<P.ThinkingBlock text="分析客流数据…" startTime={Date.now() - 5200} streaming embedded />);
    expect(text(a.host.querySelector(".thinking-process-heading"))).toContain("思考中…");
    a.unmount();
    const b = mount(<P.ThinkingBlock text="分析客流数据…" startTime={Date.now() - 5200} streaming={false} embedded />);
    expect(text(b.host.querySelector(".thinking-process-heading"))).toContain("思考了 5.2s");
    expect(b.host.querySelector(".thinking-text")?.textContent).toBe("分析客流数据…");
    b.unmount();
    const c = mount(<P.ThinkingBlock text="十二字思考内容十二字思考内容" startTime={0} streaming={false} embedded />);
    expect(text(c.host.querySelector(".thinking-process-heading"))).toContain("14 字");
    c.unmount();
    vi.useRealTimers();
  });

  it("非 embedded 形态：默认收起（respect thinkingDefaultOpen），展开后正文可见", () => {
    window.localStorage.setItem("oaw_settings", JSON.stringify({ thinkingDefaultOpen: false }));
    const a = mount(<P.ThinkingBlock text="思考内容" streaming={false} />);
    expect(a.host.querySelector(".thinking-block")?.className).not.toContain("expanded");
    click(a.host.querySelector("button.thinking-header"));
    expect(a.host.querySelector(".thinking-block")?.className).toContain("expanded");
    expect(a.host.querySelector(".thinking-text")?.textContent).toBe("思考内容");
    a.unmount();
  });
});

describe("PipelineCard / SubagentCard", () => {
  it("PipelineCard：运行态默认展开（状态条/阶段列表/产物按钮/待改进），点击可收起再展开", () => {
    const block = {
      status: "running", format: "docx",
      stages: [
        { stage: "plan", label: "规划", status: "done" },
        { stage: "write", label: "撰写", status: "running" },
        { stage: "check", label: "验收", status: "failed", issues: ["图注缺失", "口径不一致", "页码错误", "第四条被截断"] }
      ],
      deliverable: "D:/ws/报告.docx",
      issues: ["整体超时"]
    };
    const opened: string[] = [];
    const a = mount(<P.PipelineCard block={block} onOpenFile={(p) => opened.push(p)} />);
    const head = a.host.querySelector("button.pipeline-card-head")!;
    expect(text(head.querySelector(".pipeline-card-status"))).toContain("进行中：撰写");
    // status=running → 初始即展开
    const stages = a.host.querySelectorAll("li.pipeline-stage");
    expect(stages.length).toBe(3);
    expect(text(stages[2]!.querySelector(".pipeline-stage-issues"))).toBe("图注缺失；口径不一致；页码错误");
    click(a.host.querySelector("button.pipeline-open"));
    expect(opened).toEqual(["D:/ws/报告.docx"]);
    expect(text(a.host.querySelector(".pipeline-issues"))).toContain("待改进：整体超时");
    click(head); // 收起
    expect(a.host.querySelectorAll("li.pipeline-stage").length).toBe(0);
    click(head); // 再展开
    expect(a.host.querySelectorAll("li.pipeline-stage").length).toBe(3);
    a.unmount();
  });

  it("SubagentCard：角色/状态/工具计数/核验/占位文案，运行态默认展开", () => {
    const block = {
      status: "running", role: "scout", activity: "正在检索规范库",
      tools: [
        { toolCallId: "t1", name: "kb_search", status: "done" },
        { toolCallId: "t2", name: "kb_read", status: "running" }
      ]
    };
    const a = mount(<P.SubagentCard block={block} onOpenDetail={() => {}} />);
    expect(a.host.querySelector("section.subagent-card")?.getAttribute("aria-label")).toBe("子 Agent：资料探索");
    expect(text(a.host.querySelector(".subagent-card-toolcount"))).toBe("2 个工具 · 1 进行中");
    // 运行态初始展开，工具行直接可见
    const tools = a.host.querySelectorAll(".subagent-tool");
    expect(tools.length).toBe(2);
    expect(text(tools[0]!.querySelector("i"))).toBe("完成");
    expect(text(tools[1]!.querySelector("i"))).toBe("执行中");
    expect(text(a.host.querySelector(".subagent-placeholder"))).toContain("隔离上下文");
    click(a.host.querySelector("button.subagent-card-head")); // 收起
    expect(a.host.querySelectorAll(".subagent-tool").length).toBe(0);
    a.unmount();
    const b = mount(<P.SubagentCard block={{ status: "failed", role: "verifier", verdict: "fail", error: "核验超时" }} />);
    click(b.host.querySelector("button.subagent-card-head")); // 非运行态收起 → 点击展开
    expect(text(b.host.querySelector(".subagent-card-status"))).toContain("失败");
    expect(text(b.host.querySelector(".subagent-verdict"))).toContain("核验不通过");
    expect(text(b.host.querySelector(".subagent-error"))).toBe("核验超时");
    b.unmount();
  });
});

/* ------------------------- ToolCard ------------------------- */

describe("ToolCard", () => {
  it("完成态：短语/cmd 预览/时长/展开详情（输入+全量结果）", () => {
    const output = "stdout 行".repeat(80); // 640 字符
    const a = mount(<P.ToolCard tool={{ id: "t1", name: "bash", input: { args: "python run.py --city 杭州" }, output, done: true, isError: false, expanded: true, duration: 3.5 } as unknown as ToolBlock} />);
    const card = a.host.querySelector(".tool-card")!;
    expect(card.className).toContain("success");
    expect(text(card.querySelector(".tool-phrase"))).toBe("执行命令 python run.py --city 杭州");
    expect(text(card.querySelector(".cmd-code"))).toContain("$ python run.py --city 杭州");
    expect(text(card.querySelector(".tool-duration"))).toBe("3.5s");
    const sections = card.querySelectorAll(".tool-section");
    expect(text(sections[0]!.querySelector(".tool-section-label"))).toBe("输入");
    expect(text(sections[1]!.querySelector(".tool-section-label"))).toBe("结果");
    // 展开态（expanded=true）结果区渲染全量输出，不截断（旧实现 expanded ? 全量 : 300 截断预览）
    expect(text(sections[1]!.querySelector("pre"))!.length).toBe(640);
    a.unmount();
  });

  it("运行中/地图徽标/browser_screenshot 截图回看/错误态", () => {
    const run = mount(<P.ToolCard tool={{ id: "t2", name: "map_edit", input: { path: "样式.json" }, done: false, expanded: true } as unknown as ToolBlock} />);
    const runCard = run.host.querySelector(".tool-card")!;
    expect(runCard.className).toContain("pending");
    expect(runCard.className).toContain("tool-card-map");
    expect(runCard.querySelector(".tool-map-badge")?.textContent).toBe("地图");
    // map_edit 不在 toolPhrase 语义表内 → default 分支「正在调用 <name> <arg>」
    expect(text(runCard.querySelector(".tool-phrase"))).toBe("正在调用 map_edit 样式.json");
    run.unmount();

    const shot = mount(<P.ToolCard tool={{ id: "t3", name: "browser_screenshot", output: '{"details":{"file":"D:/tmp/shot-abc123.jpg"}}', done: true, isError: false, expanded: true } as unknown as ToolBlock} />);
    const img = shot.host.querySelector("img.tool-shot-thumb") as HTMLImageElement;
    expect(img?.getAttribute("src")).toBe("/api/browser/shot?file=shot-abc123.jpg");
    shot.unmount();

    const err = mount(<P.ToolCard tool={{ id: "t4", name: "write", input: "x", output: "boom", done: true, isError: true, expanded: true } as unknown as ToolBlock} />);
    expect(err.host.querySelector(".tool-card")!.className).toContain("error");
    // 第一个 pre 是输入区（write 非 cmd，无 err 类）；err 类在结果区 pre 上
    const pres = err.host.querySelectorAll("pre.tool-code");
    expect(pres.length).toBe(2);
    expect(pres[0]!.className).not.toContain("err");
    expect(pres[1]!.className).toContain("err");
    err.unmount();
  });
});

/* ------------------------- 待处理条 / 提问卡 / 审批卡（IPC 请求形态对拍） ------------------------- */

describe("PendingActionBar（op:agent:approval / op:agent:answer）", () => {
  it("审批段：允许/拒绝 body 深等", async () => {
    const { calls } = stubIpc(() => ({ ok: true }));
    const a = mount(<I.PendingActionBar approval={{ id: "ap-1", tool: "bash", input: "rm -rf tmp" }} clientId="c1" threadId="t1" />);
    const allow = [...a.host.querySelectorAll("button")].find((b) => b.textContent === "允许一次")!;
    expect([...a.host.querySelectorAll("button")].find((b) => b.textContent === "拒绝")!).toBeTruthy();
    expect(a.host.querySelector(".pending-action-command")?.textContent).toBe("rm -rf tmp");
    await act(async () => { click(allow); });
    expect(calls).toEqual([{ channel: "op:agent:approval", payload: { body: { id: "ap-1", decision: "allow" } } }]);
    a.unmount();
  });

  it("提问段：选项快答与输入提交 body 深等（thread null → 键缺省）", async () => {
    const { calls } = stubIpc(() => ({ ok: true }));
    const answered: Array<[unknown, string]> = [];
    const a = mount(<I.PendingActionBar ask={{ id: "ask-1", question: "选哪个方案？", options: ["甲", "乙"] }} clientId="c1" threadId={null} onAnswered={(id, v) => answered.push([id, v])} />);
    await act(async () => { click([...a.host.querySelectorAll("button")].find((b) => b.textContent === "甲")!); });
    expect(calls[0]).toEqual({ channel: "op:agent:answer", payload: { body: { client: "c1", answer: "甲" } } });
    expect(answered).toEqual([["ask-1", "甲"]]);
    const input = a.host.querySelector("input.pending-action-input") as HTMLInputElement;
    setInputValue(input, "自定义回答");
    await act(async () => { click([...a.host.querySelectorAll("button")].find((b) => b.textContent === "发送")!); });
    expect(calls[1]).toEqual({ channel: "op:agent:answer", payload: { body: { client: "c1", answer: "自定义回答" } } });
    a.unmount();
  });

  it("404 失效分支：onExpired + 固定文案（空输入时发送按钮禁用，不发起调用）", async () => {
    const expired: unknown[] = [];
    const { calls } = stubIpc(() => ({}), (channel, list) =>
      channel === "op:agent:answer" && list.length === 1 ? { status: 404, data: {} } : null);
    const a = mount(<I.PendingActionBar ask={{ id: "ask-9", question: "继续吗？" }} clientId="c1" threadId="t1" onExpired={(id) => expired.push(id)} />);
    // 空答案：发送按钮 disabled，点击不产生调用
    click([...a.host.querySelectorAll("button")].find((b) => b.textContent === "发送")!);
    expect(calls.length).toBe(0);
    // 填入答案后再提交 → 404 → onExpired + 固定文案
    setInputValue(a.host.querySelector("input.pending-action-input") as HTMLInputElement, "回答");
    await act(async () => { click([...a.host.querySelectorAll("button")].find((b) => b.textContent === "发送")!); });
    expect(calls[0]).toEqual({ channel: "op:agent:answer", payload: { body: { client: "c1", thread: "t1", answer: "回答" } } });
    expect(expired).toEqual(["ask-9"]);
    expect(text(a.host.querySelector(".pending-action-error"))).toBe("该问题已失效（超过 5 分钟未回答或已在别处回答），回答未提交");
    a.unmount();
  });
});

describe("AskBlock（op:agent:answer）", () => {
  it("未回答态：提交 body 深等 + onAnswered；回答态/超时态渲染", async () => {
    const { calls } = stubIpc(() => ({ ok: true }));
    const answered: Array<[unknown, string]> = [];
    const a = mount(<I.AskBlock block={{ id: "a1", question: "Q1", options: ["选项一"] }} clientId="c1" threadId="t1" onAnswered={(id, v) => answered.push([id, v])} />);
    await act(async () => { click(a.host.querySelector("button.ask-opt")!); });
    expect(calls[0]).toEqual({ channel: "op:agent:answer", payload: { body: { client: "c1", thread: "t1", answer: "选项一" } } });
    expect(answered).toEqual([["a1", "选项一"]]);
    a.unmount();
    const b = mount(<I.AskBlock block={{ id: "a2", question: "Q2", answer: "好" }} clientId="c1" threadId="t1" />);
    expect(text(b.host.querySelector(".ask-answer"))).toContain("你的回答：好");
    expect(b.host.querySelector(".ask-block")!.className).toContain("answered");
    b.unmount();
    const c = mount(<I.AskBlock block={{ id: "a3", question: "Q3", expired: true }} clientId="c1" threadId="t1" />);
    expect(text(c.host.querySelector(".ask-status"))).toBe("已超时");
    expect(text(c.host.querySelector(".ask-expired"))).toContain("Agent 已按自己的假设继续");
    c.unmount();
  });

  it("404 → onExpired；错误文案形状映射（服务端 error 透传）", async () => {
    const expired: unknown[] = [];
    stubIpc(() => ({}), (channel, list) =>
      channel === "op:agent:answer"
        ? (list.length <= 1 ? { status: 404, data: {} } : { status: 500, data: { error: "服务开小差" } })
        : null);
    const a = mount(<I.AskBlock block={{ id: "a1", question: "Q" }} clientId="c1" threadId="t1" onExpired={(id) => expired.push(id)} />);
    setInputValue(a.host.querySelector("input.ask-input") as HTMLInputElement, "答");
    await act(async () => { click(a.host.querySelector("button.ask-submit")!); });
    expect(expired).toEqual(["a1"]);
    expect(text(a.host.querySelector(".ask-error"))).toBe("该问题已失效（超过 5 分钟未回答或已在别处回答），回答未提交");
    a.unmount();
    const b = mount(<I.AskBlock block={{ id: "a2", question: "Q" }} clientId="c1" threadId="t1" />);
    setInputValue(b.host.querySelector("input.ask-input") as HTMLInputElement, "答");
    await act(async () => { click(b.host.querySelector("button.ask-submit")!); });
    expect(text(b.host.querySelector(".ask-error"))).toBe("服务开小差");
    b.unmount();
  });
});

describe("ApprovalBlock（op:agent:approval）", () => {
  it("三决策请求 body 深等；决策态（decision prop）状态与 scope 文案", async () => {
    const { calls } = stubIpc(() => ({ ok: true }));
    const a = mount(<I.ApprovalBlock block={{ id: "ap1", tool: "officecli", input: "convert 报告.docx" }} />);
    expect(text(a.host.querySelector(".approval-title"))).toBe("需要审批：Office CLI");
    await act(async () => { click(a.host.querySelector("button.approval-always")!); });
    expect(calls[0]).toEqual({ channel: "op:agent:approval", payload: { body: { id: "ap1", decision: "always" } } });
    a.unmount();
    // 决策态由 prop 驱动（旧实现中父组件按事件回写 block.decision）
    const b = mount(<I.ApprovalBlock block={{ id: "ap1", tool: "officecli", input: "convert 报告.docx", decision: "always" }} />);
    expect(text(b.host.querySelector(".approval-status"))).toBe("✓ 已总是允许（全局规则）");
    expect(text(b.host.querySelector(".resolved-scope"))).toContain("已写入本机全局规则");
    b.unmount();
    const c = mount(<I.ApprovalBlock block={{ id: "ap1", tool: "officecli", input: "x", decision: "allow" }} />);
    expect(text(c.host.querySelector(".resolved-scope"))).toBe("只放行本次调用，不影响后续同类命令。");
    c.unmount();
  });

  it("拒绝文案与 data-approval-id 锚点", () => {
    const a = mount(<I.ApprovalBlock block={{ id: "ap2", tool: "write", input: "x", decision: "deny" }} />);
    expect(a.host.querySelector(".approval-block")!.getAttribute("data-approval-id")).toBe("ap2");
    expect(text(a.host.querySelector(".resolved-scope"))).toBe("已拒绝本次调用，Agent 不会再执行这条命令。");
    a.unmount();
  });
});

describe("交互归属文案", () => {
  it("subagent/turn/session 三形态与 null", () => {
    expect(I.交互归属文案({ kind: "subagent", id: "child-123456789012345678" })).toEqual({ text: "来自子代理 · child-123456789…", title: "该交互由子代理 child-123456789012345678 发起" });
    expect(I.交互归属文案({ kind: "turn", id: "run-1" })).toEqual({ text: "来自本轮任务", title: "该交互属于本轮 Run run-1" });
    expect(I.交互归属文案({ kind: "session", id: "s1" })).toEqual({ text: "来自会话", title: "该交互属于会话 s1" });
    expect(I.交互归属文案(null)).toBe(null);
    expect(I.交互归属文案({ kind: "other", id: "x" })).toBe(null);
  });

  it("AskBlock 渲染 owner 标签", () => {
    const a = mount(<I.AskBlock block={{ id: "a1", question: "Q", owner: { kind: "turn", id: "run-9" } }} clientId="c1" threadId="t1" />);
    const tag = a.host.querySelector(".interaction-owner")!;
    expect(tag.textContent).toBe("来自本轮任务");
    expect(tag.getAttribute("title")).toBe("该交互属于本轮 Run run-9");
    a.unmount();
  });
});

/* ------------------------- ContextUsageRing / ApprovalModeControl / TaskProgressCard ------------------------- */

describe("ContextUsageRing", () => {
  const base = {
    usage: { input: 1200, cacheRead: 300, cacheWrite: 100, output: 400 },
    contextWindow: 128000,
    contextTokens: 64000,
    compactThreshold: 128000 - 16384,
    compactionMode: "pi-native",
    compactionReserveTokens: 16384,
    compactionKeepRecentTokens: 20000,
    compaction: { count: 2, at: "2026-10-21T09:30:00.000Z", tokensBefore: 111457 },
    model: { id: "m1", name: "DeepSeek Chat", provider: "deepseek" }
  };

  it("闭合态：色阶/百分比/标题压缩线（formatTokenCount 小写 k）", () => {
    const b = mount(<I.ContextUsageRing {...base} onCompact={() => {}} />);
    const btn = b.host.querySelector("button.context-ring-button")!;
    expect(btn.className).toContain("ok"); // 50% < 60 → ok 档
    expect(btn.getAttribute("title")).toBe("上下文 64k / 128k tokens · 压缩线 112k");
    expect(btn.querySelector("strong")?.textContent).toBe("50%");
    expect(text(btn.querySelector(".context-ring-label small"))).toBe("64k");
    b.unmount();
  });

  it("展开态：压缩线明细/上次压缩/用量分解/压缩按钮", () => {
    const compacted: boolean[] = [];
    const a = mount(<I.ContextUsageRing {...base} compacting={false} busy={false} onCompact={() => compacted.push(true)} />);
    click(a.host.querySelector("button.context-ring-button"));
    expect(a.host.querySelector(".context-ring-marker")?.getAttribute("title")).toBe("压缩线 87%");
    const rows = a.host.querySelectorAll(".crb-row");
    expect(rows.length).toBe(3); // 压缩线 / 压缩后保留 / 上次压缩（hint 不带 crb-row）
    expect(rows[0]!.querySelector("b")!.textContent).toBe("111,616 tokens（87%）");
    expect(rows[1]!.querySelector("b")!.textContent).toBe("最近 20,000 tokens");
    expect(rows[2]!.querySelector("b")!.textContent).toContain("2 次");
    expect(a.host.querySelector(".context-ring-breakdown")?.textContent).toContain("输入 1,200");
    click(a.host.querySelector("button.context-ring-compact"));
    expect(compacted).toEqual([true]);
    a.unmount();
  });

  it("无压缩线：marker 不渲染、按钮态文案", () => {
    const a = mount(<I.ContextUsageRing {...base} compactThreshold={0} compactionMode={null} busy compacting={false} onCompact={() => {}} />);
    click(a.host.querySelector("button.context-ring-button"));
    expect(a.host.querySelector(".context-ring-marker")).toBeNull();
    expect(a.host.querySelectorAll(".crb-row")[0]!.querySelector("b")!.textContent).toBe("已关闭");
    expect(a.host.querySelector("button.context-ring-compact")!.textContent).toBe("任务完成后可压缩");
    a.unmount();
  });
});

describe("ApprovalModeControl", () => {
  it("两态切换回调", () => {
    const got: string[] = [];
    const a = mount(<I.ApprovalModeControl mode="auto" onChange={(m) => got.push(m)} />);
    expect(a.host.querySelector("button")!.className).toContain("auto");
    click(a.host.querySelector("button"));
    expect(got).toEqual(["ask"]);
    a.unmount();
    const b = mount(<I.ApprovalModeControl mode="ask" saving onChange={() => {}} />);
    expect(b.host.querySelector("button")!.className).toContain("ask");
    expect((b.host.querySelector("button") as HTMLButtonElement).disabled).toBe(true);
    b.unmount();
  });
});

describe("TaskProgressCard", () => {
  it("进度统计/展开清单/状态图标", () => {
    const tasks = [
      { id: "k1", title: "拉取数据", status: "completed" },
      { id: "k2", text: "清洗表格", status: "running" },
      { id: "k3", name: "生成图表", status: "failed", note: "权限不足" },
      { id: "k4", title: "校对", done: true }
    ];
    const a = mount(<I.TaskProgressCard tasks={tasks} running />);
    expect(text(a.host.querySelector(".task-progress"))).toBe("2/4 完成 · 1 失败");
    click(a.host.querySelector("button.task-head"));
    const items = a.host.querySelectorAll(".task-item");
    expect(items.length).toBe(4);
    expect(items[1]!.className).not.toContain("done");
    expect(text(items[1]!.querySelectorAll("small")[0] ?? items[1]!.querySelector("small"))).toBe("进行中");
    expect(items[2]!.className).toContain("failed");
    expect(items[3]!.className).toContain("done");
    // jsdom 无布局：available = 0 - 8 - 12 → 下限 96
    expect((a.host.querySelector(".task-body") as HTMLElement).style.maxHeight).toBe("96px");
    a.unmount();
  });
});

/* ------------------------- ExecutionFlow ------------------------- */

const FLOW_EVENTS = [
  { key: "e1", type: "run_started", data: {}, at: "2026-10-21T10:00:00.000Z" },
  { key: "e2", type: "tool_start", data: { name: "bash", toolCallId: "tc1" }, at: "2026-10-21T10:00:01.000Z" },
  { key: "e3", type: "tool_end", data: { name: "bash", toolCallId: "tc1" }, at: "2026-10-21T10:00:02.000Z" },
  { key: "e4", type: "tool_start", data: { name: "bash", toolCallId: "tc1" }, at: "2026-10-21T10:00:03.000Z" },
  { key: "e5", type: "file_changed", data: { files: ["报告.docx", "数据.xlsx"] }, at: "2026-10-21T10:00:04.000Z" },
  { key: "e6", type: "agent_retry", data: {}, at: "2026-10-21T10:00:05.000Z" },
  { key: "e7", type: "agent_retry", data: {}, at: "2026-10-21T10:00:06.000Z" },
  { key: "e8", type: "agent_retry_end", data: {}, at: "2026-10-21T10:00:07.000Z" }
];

describe("ExecutionFlow", () => {
  it("独立形态：计数与去重（run_started 为纯阶段事件剔除/tool_start 已配对剔除/连续重试留末条/agent_retry_end 剔除）、隐藏态", () => {
    const hidden: boolean[] = [];
    const a = mount(<E.ExecutionFlow events={FLOW_EVENTS} running={false} onHiddenChange={(v) => hidden.push(v)} />);
    const head = a.host.querySelector("button.execution-flow-toggle")!;
    // contentEvents = 8 - run_started（STAGE_ONLY_EVENTS）= 7
    expect(text(head.querySelector(".execution-flow-count"))).toBe("7 个事件");
    click(a.host.querySelector("button.execution-flow-hide"));
    expect(hidden).toEqual([true]);
    a.unmount();
    const b = mount(<E.ExecutionFlow events={FLOW_EVENTS} hidden onHiddenChange={(v) => hidden.push(v)} />);
    expect(text(b.host.querySelector(".execution-flow-hidden button"))).toContain("显示执行流");
    click(b.host.querySelector(".execution-flow-hidden button"));
    expect(hidden).toEqual([true, false]);
    b.unmount();
  });

  it("展开态：事件行渲染（去重后 3 行）+ 脑回路图挂载", () => {
    const a = mount(<E.ExecutionFlow events={FLOW_EVENTS} defaultExpanded running={false} onFocusTool={() => {}} />);
    const rows = a.host.querySelectorAll(".execution-flow-item");
    // 去重后：tool_end(tc1)、file_changed、agent_retry(末条)；tool_start×2 已配对剔除、agent_retry_end 剔除
    expect(rows.length).toBe(3);
    expect(rows[0]!.querySelector(".tool-identity-inline")).toBeTruthy();
    expect(text(rows[0]!.querySelector(".execution-flow-label"))).toBe("执行命令完成");
    expect(text(rows[1]!.querySelector(".execution-flow-detail"))).toBe("报告.docx, 数据.xlsx");
    expect(a.host.querySelector(".brain-graph")).toBeTruthy();
    a.unmount();
  });

  it("运行态：自动展开 + 实时徽标 + 下一步 + 进度行 + 状态行", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-21T10:00:30.000Z"));
    const a = mount(<E.ExecutionFlow
      events={FLOW_EVENTS} running
      statusText="正在执行第 2 步" statusChips={[{ key: "c1", label: "工具 1/3" }]} statusDotClass="live"
      nextStep="等待文件写入完成"
      note="已生成初稿"
      pendingApproval={{ tool: "bash" }}
      onLocateApproval={() => {}}
    />);
    expect(a.host.querySelector(".execution-flow")!.className).toContain("expanded");
    expect(a.host.querySelector(".execution-flow")!.className).toContain("live");
    expect(text(a.host.querySelector(".efs-text"))).toBe("正在执行第 2 步");
    expect(text(a.host.querySelector(".efs-chip"))).toBe("工具 1/3");
    expect(text(a.host.querySelector(".efs-approval"))).toContain("待批准：bash");
    expect(text(a.host.querySelector(".execution-flow-next .efn-next"))).toContain("等待文件写入完成");
    expect(a.host.querySelector(".execution-flow-progress")!.className).toContain("phase-");
    expect(text(a.host.querySelector(".efp-note"))).toBe("已生成初稿");
    a.unmount();
    vi.useRealTimers();
  });

  it("embedded 形态：只渲染系统提示（无 notes 返回 null）", () => {
    const a = mount(<E.ExecutionFlow events={FLOW_EVENTS} embedded notes={[{ key: "n1", kind: "file", text: "报告.docx 已更新", count: 1 }, { key: "n2", kind: "info", text: "上下文压缩", count: 2 }]} compaction={{ count: 2 }} />);
    const items = a.host.querySelectorAll(".efn-item");
    expect(items.length).toBe(2);
    expect(items[0]!.className).toContain("kind-file");
    expect(text(items[1]!.querySelector(".efn-count"))).toBe("×2");
    expect(a.host.querySelector(".execution-flow-list")).toBeNull();
    a.unmount();
    const b = mount(<E.ExecutionFlow events={[]} embedded notes={[]} />);
    expect(b.host.innerHTML).toBe("");
    b.unmount();
  });

  it("运行结束自动收束：running true→false 后折叠", () => {
    const a = mount(<E.ExecutionFlow events={FLOW_EVENTS} running />);
    expect(a.host.querySelector(".execution-flow")!.className).toContain("expanded");
    a.rerender(<E.ExecutionFlow events={FLOW_EVENTS} running={false} />);
    expect(a.host.querySelector(".execution-flow")!.className).not.toContain("expanded");
    a.unmount();
  });

  it("空事件且非运行：返回 null", () => {
    const a = mount(<E.ExecutionFlow events={[]} running={false} />);
    expect(a.host.innerHTML).toBe("");
    a.unmount();
  });
});
