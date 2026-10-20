// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import ToolIdentityIconTs from "../src/renderer/components/SemanticToolIcon";
import AgentBrainGraphTs from "../src/renderer/components/AgentBrainGraph";
import ChatTimelineTs from "../src/renderer/components/ChatTimeline";
import { createRunTrace, type RunTrace } from "../src/renderer/lib/run-trace";

const clientIcon = (await import("../../client/src/components/SemanticToolIcon.jsx")).default;
const clientBrain = (await import("../../client/src/components/AgentBrainGraph.jsx")).default;
const clientTimeline = (await import("../../client/src/components/ChatTimeline.jsx")).default;

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

type AnyComp = React.ComponentType<Record<string, unknown>>;

/* ---------------- SemanticToolIcon ---------------- */

describe("ToolIdentityIcon TS 版与 client SemanticToolIcon.jsx 渲染等价", () => {
  it("典型/未知工具名 markup 逐字节一致", () => {
    const names = ["read", "write", "bash", "kb_search", "map_analyze", "ask_user", "todo", "__unknown_tool__", ""];
    for (const name of names) {
      const jsx = renderToStaticMarkup(React.createElement(clientIcon as unknown as AnyComp, { name }));
      const ts = renderToStaticMarkup(React.createElement(ToolIdentityIconTs as unknown as AnyComp, { name }));
      expect(ts).toBe(jsx);
    }
  });

  it("自定义 size / className 拼接一致", () => {
    for (const props of [{ name: "read", size: 20, className: "extra" }, { name: "write" }]) {
      const jsx = renderToStaticMarkup(React.createElement(clientIcon as unknown as AnyComp, props));
      const ts = renderToStaticMarkup(React.createElement(ToolIdentityIconTs as unknown as AnyComp, props));
      expect(ts).toBe(jsx);
    }
  });
});

/* ---------------- AgentBrainGraph ---------------- */

function makeTrace(patch: Partial<RunTrace>): RunTrace {
  return { ...createRunTrace("run-1"), ...patch };
}

const TOOL = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, toolCallId: `tc-${id}`, name, input: null, output: "", result: "", isError: false, status: "done",
  startAt: null, endAt: null, duration: null, startMissing: false, ...extra,
});

describe("AgentBrainGraph TS 版与 client AgentBrainGraph.jsx 渲染等价", () => {
  it("null / 空 trace 返回 null", () => {
    expect(renderToStaticMarkup(React.createElement(clientBrain as unknown as AnyComp, { trace: null }))).toBe("");
    expect(renderToStaticMarkup(React.createElement(AgentBrainGraphTs as unknown as AnyComp, { trace: null }))).toBe("");
    const empty = makeTrace({});
    expect(renderToStaticMarkup(React.createElement(clientBrain as unknown as AnyComp, { trace: empty }))).toBe("");
    expect(renderToStaticMarkup(React.createElement(AgentBrainGraphTs as unknown as AnyComp, { trace: empty }))).toBe("");
  });

  it("各分支分类与计数：markup 逐字节一致", () => {
    const trace = makeTrace({
      startedAt: "2026-01-01T00:00:00Z",
      tools: [
        TOOL("t1", "read"), TOOL("t2", "grep"), TOOL("t3", "write"), TOOL("t4", "edit"),
        TOOL("t5", "bash"), TOOL("t6", "ask_user"), TOOL("t7", "map_analyze"),
      ],
    });
    const jsx = renderToStaticMarkup(React.createElement(clientBrain as unknown as AnyComp, { trace }));
    const ts = renderToStaticMarkup(React.createElement(AgentBrainGraphTs as unknown as AnyComp, { trace }));
    expect(ts).toBe(jsx);
    expect(ts).toContain("brain-branch");
    expect(ts).toContain("读取");
    expect(ts).toContain("×2");
  });

  it("running 分支状态与 live 类：markup 逐字节一致", () => {
    const trace = makeTrace({
      startedAt: "2026-01-01T00:00:00Z",
      tools: [TOOL("t1", "read"), TOOL("t2", "write", { status: "running" })],
    });
    for (const running of [true, false]) {
      const jsx = renderToStaticMarkup(React.createElement(clientBrain as unknown as AnyComp, { trace, running }));
      const ts = renderToStaticMarkup(React.createElement(AgentBrainGraphTs as unknown as AnyComp, { trace, running }));
      expect(ts).toBe(jsx);
      if (running) expect(ts).toContain("live");
    }
  });

  it("错误/文件静态分支：markup 逐字节一致", () => {
    const trace = makeTrace({
      startedAt: "2026-01-01T00:00:00Z",
      errors: [{ message: "boom", at: "2026-01-01T00:00:01Z", type: "error" }],
      files: ["out/a.docx", "out/b.csv"],
    });
    const jsx = renderToStaticMarkup(React.createElement(clientBrain as unknown as AnyComp, { trace }));
    const ts = renderToStaticMarkup(React.createElement(AgentBrainGraphTs as unknown as AnyComp, { trace }));
    expect(ts).toBe(jsx);
    expect(ts).toContain("boom");
    expect(ts).toContain("out/a.docx");
  });

  it("completion 各状态 + 推断摘要：markup 逐字节一致", () => {
    const completionVariants = [
      { status: "done", summary: "任务完成", source: "declared" },
      { status: "done", summary: "推断的结论", source: "inferred" },
      { status: "failed", summary: "", source: "declared" },
      { status: "cancelled" },
    ];
    for (const completion of completionVariants) {
      const trace = makeTrace({ startedAt: "2026-01-01T00:00:00Z", completion });
      const jsx = renderToStaticMarkup(React.createElement(clientBrain as unknown as AnyComp, { trace }));
      const ts = renderToStaticMarkup(React.createElement(AgentBrainGraphTs as unknown as AnyComp, { trace }));
      expect(ts).toBe(jsx);
    }
  });

  it("elapsed 时长格式（endedAt 固定）：markup 逐字节一致", () => {
    const base = "2026-01-01T00:00:00Z";
    for (const endedAt of ["2026-01-01T00:00:05Z", "2026-01-01T01:05:00Z", "2026-01-01T00:00:59Z"]) {
      const trace = makeTrace({ startedAt: base, endedAt });
      const jsx = renderToStaticMarkup(React.createElement(clientBrain as unknown as AnyComp, { trace }));
      const ts = renderToStaticMarkup(React.createElement(AgentBrainGraphTs as unknown as AnyComp, { trace }));
      expect(ts).toBe(jsx);
    }
    const t5 = makeTrace({ startedAt: base, endedAt: "2026-01-01T00:00:05Z" });
    expect(renderToStaticMarkup(React.createElement(AgentBrainGraphTs as unknown as AnyComp, { trace: t5 }))).toContain("5s");
  });

  it("点击分支展开工具列表 + onFocusTool 回调（toolCallId 优先）", () => {
    const callsTs: string[] = [];
    const callsJsx: string[] = [];
    const trace = makeTrace({
      startedAt: "2026-01-01T00:00:00Z",
      tools: [
        TOOL("t1", "read", { output: "文件内容", input: "a.md" }),
        TOOL("t2", "write", { isError: true, result: "失败原因" }),
      ],
    });
    const results: Array<{ host: HTMLElement; root: Root }> = [];
    const mount = (Comp: AnyComp, onFocusTool: (id: string) => void) => {
      const host = document.createElement("div");
      document.body.appendChild(host);
      const root = createRoot(host);
      act(() => { root.render(React.createElement(Comp, { trace, onFocusTool })); });
      results.push({ host, root });
      return host;
    };
    try {
      const a = mount(AgentBrainGraphTs as unknown as AnyComp, (id) => callsTs.push(id));
      const b = mount(clientBrain as unknown as AnyComp, (id) => callsJsx.push(id));
      const branchA = a.querySelector(".brain-branch") as HTMLButtonElement;
      const branchB = b.querySelector(".brain-branch") as HTMLButtonElement;
      expect(Boolean(branchA)).toBe(true);
      act(() => {
        branchA.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
        branchB.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      });
      // 展开后整个图 markup 一致（含工具列表；首支为「读取」分支，仅 t1 一个工具）
      expect(a.innerHTML).toBe(b.innerHTML);
      expect(a.querySelectorAll(".brain-tool").length).toBe(1);
      const toolsA = [...a.querySelectorAll(".brain-tool")] as HTMLButtonElement[];
      act(() => {
        toolsA[0]!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      });
      const toolsB = [...b.querySelectorAll(".brain-tool")] as HTMLButtonElement[];
      act(() => {
        toolsB[0]!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      });
      expect(callsTs).toEqual(["tc-t1"]);
      expect(callsTs).toEqual(callsJsx);
      // 再次点击分支收起
      act(() => {
        (a.querySelector(".brain-branch") as HTMLButtonElement).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
        (b.querySelector(".brain-branch") as HTMLButtonElement).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      });
      expect(a.innerHTML).toBe(b.innerHTML);
      expect(a.querySelector(".brain-tool-list")).toBeNull();
    } finally {
      for (const { root, host } of results) {
        act(() => root.unmount());
        host.remove();
      }
    }
  });
});

/* ---------------- ChatTimeline ---------------- */

function msg(role: string, text: string, extra: Record<string, unknown> = {}) {
  return { role, text, ...extra };
}

describe("ChatTimeline TS 版与 client ChatTimeline.jsx 渲染等价", () => {
  let scrollCalls: Array<{ idx: string | null; behavior: unknown }>;
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

  beforeEach(() => {
    scrollCalls = [];
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement, arg?: ScrollIntoViewOptions) {
      scrollCalls.push({ idx: this.getAttribute("data-msg-index"), behavior: (arg as { behavior?: unknown })?.behavior });
    } as typeof HTMLElement.prototype.scrollIntoView;
  });

  afterEach(() => {
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    document.body.innerHTML = "";
  });

  function mountTimeline(Comp: AnyComp, messages: unknown[]) {
    const container = document.createElement("div");
    messages.forEach((_, i) => {
      const el = document.createElement("div");
      el.setAttribute("data-msg-index", String(i));
      container.appendChild(el);
    });
    const host = document.createElement("div");
    document.body.appendChild(container);
    document.body.appendChild(host);
    const root = createRoot(host);
    const containerRef = { current: container };
    act(() => { root.render(React.createElement(Comp, { messages, containerRef })); });
    return {
      host,
      unmount: () => act(() => root.unmount()),
    };
  }

  it("无用户消息 / 空 messages 返回 null", () => {
    const onlyAssistant = [msg("assistant", "你好")];
    expect(mountTimeline(clientTimeline as unknown as AnyComp, onlyAssistant).host.innerHTML).toBe("");
    expect(mountTimeline(ChatTimelineTs as unknown as AnyComp, onlyAssistant).host.innerHTML).toBe("");
    expect(mountTimeline(clientTimeline as unknown as AnyComp, []).host.innerHTML).toBe("");
  });

  it("beads 数量/位置/active 高亮：innerHTML 逐字节一致", () => {
    const messages = [
      msg("user", "第一问"), msg("assistant", "第一答"),
      msg("user", "第二问"), msg("assistant", "第二答"),
      msg("user", "第三问"), msg("assistant", "第三答"),
    ];
    const a = mountTimeline(ChatTimelineTs as unknown as AnyComp, messages);
    const b = mountTimeline(clientTimeline as unknown as AnyComp, messages);
    expect(a.host.innerHTML).toBe(b.host.innerHTML);
    expect(a.host.querySelectorAll(".timeline-bead").length).toBe(3);
    a.unmount();
    b.unmount();
  });

  it("相邻重复用户消息合并：title 与计数一致", () => {
    const messages = [
      msg("user", "重复问题"), msg("assistant", "答"),
      msg("user", "重复问题"), msg("user", "重复问题"),
    ];
    const a = mountTimeline(ChatTimelineTs as unknown as AnyComp, messages);
    const b = mountTimeline(clientTimeline as unknown as AnyComp, messages);
    expect(a.host.innerHTML).toBe(b.host.innerHTML);
    expect(a.host.querySelectorAll(".timeline-bead").length).toBe(2);
    expect(a.host.innerHTML).toContain("（合并 2 条重复消息）");
    a.unmount();
    b.unmount();
  });

  it("图片/附件/空消息摘要口径一致", () => {
    const messages = [
      { role: "user", images: [{ url: "x.png" }] },
      { role: "user", attachments: [{ name: "a.docx" }] },
      { role: "user", text: "" },
      msg("assistant", "回复"),
    ];
    const a = mountTimeline(ChatTimelineTs as unknown as AnyComp, messages);
    const b = mountTimeline(clientTimeline as unknown as AnyComp, messages);
    expect(a.host.innerHTML).toBe(b.host.innerHTML);
    a.unmount();
    b.unmount();
  });

  it("点击 bead：固定弹层内容一致 + 定位滚动调用一致", () => {
    const messages = [
      msg("user", "问题甲"), msg("assistant", "回复甲"),
      msg("user", "问题乙", { status: "error" }), msg("assistant", "回复乙"),
    ];
    const a = mountTimeline(ChatTimelineTs as unknown as AnyComp, messages);
    const b = mountTimeline(clientTimeline as unknown as AnyComp, messages);
    const beadA = a.host.querySelectorAll(".timeline-bead")[1] as HTMLElement;
    const beadB = b.host.querySelectorAll(".timeline-bead")[1] as HTMLElement;
    act(() => {
      beadA.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      beadB.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    expect(a.host.innerHTML).toBe(b.host.innerHTML);
    expect(a.host.querySelector(".timeline-popup")).not.toBeNull();
    expect(a.host.textContent).toContain("问题乙");
    expect(a.host.textContent).toContain("出错");
    // 定位滚动：点击 bead 即 scrollToMsg
    expect(scrollCalls.length).toBeGreaterThanOrEqual(2);
    // Esc 关闭
    act(() => {
      window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(a.host.innerHTML).toBe(b.host.innerHTML);
    expect(a.host.querySelector(".timeline-popup")).toBeNull();
    a.unmount();
    b.unmount();
  });

  it("键盘 ArrowDown 移动高亮 + Enter 跳转 + 顶部/底部按钮", () => {
    const messages = [
      msg("user", "Q1"), msg("assistant", "A1"),
      msg("user", "Q2"), msg("assistant", "A2"),
      msg("user", "Q3"), msg("assistant", "A3"),
    ];
    const a = mountTimeline(ChatTimelineTs as unknown as AnyComp, messages);
    const b = mountTimeline(clientTimeline as unknown as AnyComp, messages);
    const beadA = a.host.querySelector(".timeline-bead") as HTMLElement;
    const beadB = b.host.querySelector(".timeline-bead") as HTMLElement;
    act(() => {
      beadA.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      beadB.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    scrollCalls.length = 0;
    act(() => {
      window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown" }));
    });
    expect(a.host.innerHTML).toBe(b.host.innerHTML);
    act(() => {
      window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter" }));
    });
    expect(a.host.querySelector(".timeline-popup")).toBeNull();
    expect(scrollCalls.length).toBe(2); // 双侧各一次
    // 顶部/底部按钮
    act(() => {
      beadA.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      beadB.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    scrollCalls.length = 0;
    const buttonsA = [...a.host.querySelectorAll(".timeline-popup-foot button")] as HTMLButtonElement[];
    const buttonsB = [...b.host.querySelectorAll(".timeline-popup-foot button")] as HTMLButtonElement[];
    act(() => {
      buttonsA[0]!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      buttonsB[0]!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    expect(a.host.querySelector(".timeline-popup")).toBeNull();
    act(() => {
      beadA.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      beadB.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    const buttonsA2 = [...a.host.querySelectorAll(".timeline-popup-foot button")] as HTMLButtonElement[];
    const buttonsB2 = [...b.host.querySelectorAll(".timeline-popup-foot button")] as HTMLButtonElement[];
    act(() => {
      buttonsA2[1]!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      buttonsB2[1]!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    expect(a.host.innerHTML).toBe(b.host.innerHTML);
    a.unmount();
    b.unmount();
  });

  it("跳转回退：目标未挂 DOM 时落到最近已挂载消息（scrollIntoView 仍触发）", () => {
    const messages = [msg("user", "只在列表里的远端问题"), msg("assistant", "A")];
    const container = document.createElement("div");
    // 故意只挂载 index 1 的消息节点，模拟历史消息渐进挂载
    const el = document.createElement("div");
    el.setAttribute("data-msg-index", "1");
    container.appendChild(el);
    const mountWith = (Comp: AnyComp) => {
      const host = document.createElement("div");
      document.body.appendChild(container);
      document.body.appendChild(host);
      const root = createRoot(host);
      act(() => { root.render(React.createElement(Comp, { messages, containerRef: { current: container } })); });
      return { host, unmount: () => act(() => root.unmount()) };
    };
    const a = mountWith(ChatTimelineTs as unknown as AnyComp);
    const b = mountWith(clientTimeline as unknown as AnyComp);
    scrollCalls.length = 0;
    const beadA = a.host.querySelector(".timeline-bead") as HTMLElement;
    const beadB = b.host.querySelector(".timeline-bead") as HTMLElement;
    act(() => {
      beadA.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      beadB.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    expect(scrollCalls.length).toBe(2); // 双侧各一次
    expect(scrollCalls[0]!.idx).toBe("1"); // 回退到已挂载的 index 1
    expect(scrollCalls[1]!.idx).toBe("1");
    expect(scrollCalls[0]!.behavior).toBe(scrollCalls[1]!.behavior);
    a.unmount();
    b.unmount();
  });

  it("messages 渐进更新：innerHTML 双侧一致", () => {
    const initial = [msg("user", "第一问"), msg("assistant", "第一答")];
    const grown = [...initial, msg("user", "第二问"), msg("assistant", "第二答")];
    const a = document.createElement("div");
    const b = document.createElement("div");
    document.body.appendChild(a);
    document.body.appendChild(b);
    const rootA = createRoot(a);
    const rootB = createRoot(b);
    const ref = { current: document.createElement("div") };
    act(() => {
      rootA.render(React.createElement(ChatTimelineTs as unknown as AnyComp, { messages: initial, containerRef: ref }));
      rootB.render(React.createElement(clientTimeline as unknown as AnyComp, { messages: initial, containerRef: ref }));
    });
    expect(a.innerHTML).toBe(b.innerHTML);
    act(() => {
      rootA.render(React.createElement(ChatTimelineTs as unknown as AnyComp, { messages: grown, containerRef: ref }));
      rootB.render(React.createElement(clientTimeline as unknown as AnyComp, { messages: grown, containerRef: ref }));
    });
    expect(a.innerHTML).toBe(b.innerHTML);
    act(() => { rootA.unmount(); rootB.unmount(); });
    a.remove();
    b.remove();
  });
});
