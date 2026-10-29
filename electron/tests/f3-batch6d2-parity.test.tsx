// @vitest-environment jsdom
/**
 * F3 批6d-2：消息与结果卡族（message.tsx，自 ChatPanel.jsx 4101-4905 拆出）。
 *
 * R6-6c 对拍退役改写：旧侧 readFileSync 抽取 ChatPanel.jsx 源码原文本执行
 * artifactsFromView 的双侧 deep-equal 随 client 退役删除（等价性已在 F3 批对拍
 * 验收冻结），锚点样本固化为 TS 侧直接期望值断言；RunSummary / Message /
 * MemoMessage 的渲染与交互锚点保留（新侧唯一覆盖）。
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const M = await import("../src/renderer/features/chat/message");

/* ------------------------- 挂载与查询工具（同批6d-1） ------------------------- */

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

async function flushMarkdown(): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
}

function stubClipboard(): ReturnType<typeof vi.fn> {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
}

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

/* ============================ artifactsFromView ============================ */

describe("artifactsFromView", () => {
  // 综合样本：交付优先、路径去重（\\ 归一）、internal 跳过、无路径跳过、
  // confirmed（write-ledger/deliverable）、attributed（unattributed 降级线索）、size 提取
  const SAMPLES: Array<unknown> = [
    null,
    {},
    { deliverables: [], changes: [] },
    {
      deliverables: [
        { relativePath: "报告.docx", source: "write-ledger", role: "deliverable", after: { size: 2048 } },
        { path: "D:/ws/内部缓存.tmp", role: "internal", after: { size: 1 } },
        { name: "", after: { size: 9 } }
      ],
      changes: [
        { relativePath: "报告.docx", source: "run-window", after: { size: 999 } }, // 已被交付条目占据 → 跳过
        { relativePath: "草图.png", source: "run-window", after: { size: 512 } },
        { relativePath: "D:\\ws\\子\\说明.md", after: null }, // 反斜杠归一 + size null
        { relativePath: "外部改动.txt", source: "unattributed" },
        { relativePath: "手工放弃.md", attributed: false }
      ]
    },
    { deliverables: [{ relativePath: "唯一.md", role: "deliverable" }], changes: [] },
    { deliverables: [{ relativePath: "台账写.md", source: "write-ledger" }], changes: [{ relativePath: "台账写.md", role: "deliverable" }] }
  ];

  it("空视图（null / 空对象 / 空数组）返回 null", () => {
    expect(M.artifactsFromView(SAMPLES[0])).toBeNull();
    expect(M.artifactsFromView(SAMPLES[1])).toBeNull();
    expect(M.artifactsFromView(SAMPLES[2])).toBeNull();
  });

  it("语义抽查：交付优先去重 / confirmed / attributed / size / 反斜杠归一", () => {
    const result = M.artifactsFromView(SAMPLES[3]);
    expect(result).toEqual([
      { path: "报告.docx", deliverable: true, size: 2048, confirmed: true, attributed: true },
      { path: "草图.png", deliverable: false, size: 512, confirmed: false, attributed: true },
      { path: "D:/ws/子/说明.md", deliverable: false, size: null, confirmed: false, attributed: true },
      { path: "外部改动.txt", deliverable: false, size: null, confirmed: false, attributed: false },
      { path: "手工放弃.md", deliverable: false, size: null, confirmed: false, attributed: false }
    ]);
  });

  it("deliverable role 驱动 confirmed；changes 同路径条目被交付条目压制", () => {
    expect(M.artifactsFromView(SAMPLES[4])).toEqual([
      { path: "唯一.md", deliverable: true, size: null, confirmed: true, attributed: true },
    ]);
    expect(M.artifactsFromView(SAMPLES[5])).toEqual([
      { path: "台账写.md", deliverable: true, size: null, confirmed: true, attributed: true },
    ]);
  });
});

/* ============================ RunSummary ============================ */

const RUN_ARTIFACTS = [
  { relativePath: "报告.docx", source: "write-ledger", changeType: "modified", acceptance: { status: "passed" }, before: { reversible: true, size: 100 }, after: { size: 2048 } },
  { relativePath: "草图.png", source: "run-window", changeType: "added", after: { size: 512 } },
  { relativePath: "外部改动.txt", source: "unattributed", changeType: "modified" }
];

const RUN_EVENTS = [
  { type: "turn_started", at: "2026-10-21T10:00:00.000Z" },
  { type: "stats", at: "2026-10-21T10:00:05.000Z", data: { tokens: { input: 1000, output: 500, cacheRead: 200, context: 64000 } } },
  { type: "turn_ended", at: "2026-10-21T10:00:10.000Z", data: { toolCount: 2 } },
  { type: "review_source_applied", data: { sourceId: "s2", title: "规范B", relPath: "docs/b.md" } }
];

const SUMMARY_MSG = {
  role: "system",
  summary: true,
  runId: "run-9",
  runStatus: "completed",
  conclusion: "客流预测交付完成",
  artifacts: RUN_ARTIFACTS,
  events: RUN_EVENTS,
  completion: { status: "success", source: "model", summary: "全部完成" },
  reviewSources: [{ sourceId: "s1", title: "规范A", relPath: "docs/a.md", status: "read" }]
};

describe("RunSummary", () => {
  it("空投影返回 null（无产物/依据/待处理/指标）", () => {
    const a = mount(<M.RunSummary m={{ role: "system", summary: true, completion: { status: "success" } }} />);
    expect(a.host.innerHTML).toBe("");
    a.unmount();
  });

  it("结果卡头部：标题/状态/完成徽标；折叠摘要计数", () => {
    const a = mount(<M.RunSummary m={SUMMARY_MSG} />);
    expect(a.host.querySelector(".msg")!.className).toContain("summary-msg");
    expect(text(a.host.querySelector(".run-summary-title"))).toBe("客流预测交付完成");
    expect(text(a.host.querySelector(".run-summary-meta"))).toContain("运行结束");
    expect(a.host.querySelector(".flow-completion")!.className).toBe("flow-completion success");
    expect(text(a.host.querySelector(".run-result-fold-meta"))).toBe("已完成 · 3 个文件"); // completionLabel("success")="已完成" + 3 产物 + 无工具
    a.unmount();
  });

  it("产物页：卡片计数/交付与待确认徽标/未归属线索折叠/打开回调", () => {
    const opened: string[] = [];
    const a = mount(<M.RunSummary m={SUMMARY_MSG} onOpenFile={(p) => opened.push(p)} />);
    const tabs = a.host.querySelectorAll("button.result-tab");
    expect(tabs.length).toBe(3); // 产物 + 文件改动 + 依据（reviewSources 存在）
    expect(text(tabs[0])).toContain("本轮产物");
    expect(text(tabs[0]!.querySelector(".result-tab-count"))).toBe("2"); // attributed
    const head = text(a.host.querySelector(".product-cards-head"));
    expect(head).toContain("交付产物 1");
    expect(head).toContain("已确认 1");
    expect(head).toContain("待确认 1");
    expect(head).toContain("未归属线索 1");
    const cards = a.host.querySelectorAll(".product-card");
    expect(cards.length).toBe(2); // attributed（报告.docx + 草图.png）
    expect(cards[0]!.querySelector(".product-card-badge")!.textContent).toBe("交付");
    expect(cards[1]!.querySelector(".product-card-badge.provisional")!.textContent).toBe("待确认");
    click(cards[0]!.querySelector("button.product-card-main"));
    expect(opened).toEqual(["报告.docx"]);
    const leads = a.host.querySelector("details.product-leads")!;
    expect(text(leads.querySelector("summary"))).toContain("未归属线索 1");
    expect(leads.querySelectorAll("button.product-lead").length).toBe(1);
    a.unmount();
  });

  it("文件改动页：清单/可回滚/回滚回调参数（runId + 可回滚路径）/工作区", () => {
    const rollbacks: Array<[unknown, string[]]> = [];
    const a = mount(<M.RunSummary m={{ ...SUMMARY_MSG, workspace: "D:/ws/杭州" }} onRollbackRun={(runId, paths) => rollbacks.push([runId, paths])} onOpenChanges={() => {}} />);
    click([...a.host.querySelectorAll("button.result-tab")].find((b) => b.textContent!.includes("文件改动"))!);
    const spans = a.host.querySelectorAll("span.summary-product");
    expect(spans.length).toBe(3);
    expect(spans[0]!.className).toContain("role-deliverable");
    expect(text(a.host.querySelector(".summary-workspace"))).toBe("工作区：D:/ws/杭州");
    const buttons = [...a.host.querySelectorAll("button.btn-xs")];
    const rollbackBtn = buttons.find((b) => b.textContent!.includes("回滚本轮"))!;
    expect(rollbackBtn.textContent).toBe("回滚本轮（1 项）");
    click(rollbackBtn);
    expect(rollbacks).toEqual([["run-9", ["报告.docx"]]]);
    expect(buttons.find((b) => b.textContent === "查看内容差异")!).toBeTruthy();
    a.unmount();
  });

  it("依据页：reviewSources 事件归并（read + applied）", () => {
    const a = mount(<M.RunSummary m={SUMMARY_MSG} />);
    click([...a.host.querySelectorAll("button.result-tab")].find((b) => b.textContent!.includes("依据"))!);
    const rows = a.host.querySelectorAll(".review-source-row");
    expect(rows.length).toBe(2);
    expect(rows[0]!.querySelector("strong")!.textContent).toBe("s1");
    expect(rows[1]!.querySelector("strong")!.textContent).toBe("s2");
    expect(text(rows[1]!.querySelector(".review-source-status"))).toBe("已采用");
    a.unmount();
  });

  it("每轮指标：用时/轮数/token 行与每轮明细表（formatDuration/formatTokenCount）", () => {
    const a = mount(<M.RunSummary m={SUMMARY_MSG} />);
    const metrics = text(a.host.querySelector(".run-metrics-text"));
    expect(metrics).toContain("用时");
    expect(metrics).toContain("10 秒");
    expect(metrics).toContain("1 轮");
    expect(metrics).toContain("输入");
    expect(metrics).toContain("1k");
    expect(metrics).toContain("500");
    expect(metrics).toContain("64k");
    const rows = a.host.querySelectorAll(".run-turns-row");
    expect(rows.length).toBe(2); // head + 1 轮
    const cells = [...rows[1]!.querySelectorAll("span")].map((c) => c.textContent);
    expect(cells).toEqual(["#1", "10 秒", "500", "1k", "200", "64k", "2"]);
    a.unmount();
  });

  it("中断终态说明：completion.status=cancelled → cancelled 行动条", () => {
    const a = mount(<M.RunSummary m={{ ...SUMMARY_MSG, completion: { status: "cancelled" } }} />);
    expect(text(a.host.querySelector(".run-result-action.cancelled"))).toContain("本轮已中断，已保留生成到一半的内容");
    a.unmount();
  });
});

/* ============================ Message ============================ */

describe("Message：system 分支", () => {
  it("summary 消息转发 RunSummary（runId 参数透传 onOpenRunChanges/onOpenRunArtifacts）", () => {
    const changesRuns: unknown[] = [];
    const artifactRuns: unknown[] = [];
    const a = mount(<M.Message m={SUMMARY_MSG} onOpenRunChanges={(runId) => changesRuns.push(runId)} onOpenRunArtifacts={(runId) => artifactRuns.push(runId)} />);
    // 产物面板入口在 products tab 头部
    click(a.host.querySelector("button.product-cards-link")!);
    expect(artifactRuns).toEqual(["run-9"]);
    // changes tab → 查看内容差异 → runId 透传
    click([...a.host.querySelectorAll("button.result-tab")].find((b) => b.textContent!.includes("文件改动"))!);
    click([...a.host.querySelectorAll("button.btn-xs")].find((b) => b.textContent === "查看内容差异")!);
    expect(changesRuns).toEqual(["run-9"]);
    a.unmount();
  });

  it("memoryProposal：待审核 → 确认/拒绝回调；已写入态文案", () => {
    const approved: unknown[] = [];
    const rejected: unknown[] = [];
    const a = mount(<M.Message
      m={{ role: "system", text: "建议记录偏好", memoryProposal: { id: "mp1", section: "偏好", content: "输出用中文", status: "pending" } }}
      onMemoryApprove={(id) => approved.push(id)}
      onMemoryReject={(id) => rejected.push(id)}
    />);
    expect(text(a.host.querySelector(".memory-proposal-card"))).toContain("偏好：输出用中文");
    click([...a.host.querySelectorAll("button")].find((b) => b.textContent === "确认写入记忆")!);
    click([...a.host.querySelectorAll("button")].find((b) => b.textContent === "拒绝")!);
    expect(approved).toEqual(["mp1"]);
    expect(rejected).toEqual(["mp1"]);
    a.unmount();
    const b = mount(<M.Message m={{ role: "system", text: "x", memoryProposal: { id: "mp2", section: "s", content: "c", status: "approved" } }} />);
    expect(text(b.host.querySelector(".memory-proposal-state"))).toBe("✓ 已写入");
    b.unmount();
    const c = mount(<M.Message m={{ role: "system", text: "x", memoryProposal: { id: "mp3", section: "s", content: "c", status: "rejected" } }} />);
    expect(text(c.host.querySelector(".memory-proposal-state"))).toBe("未写入");
    c.unmount();
  });
});

describe("Message：user 分支", () => {
  it("气泡结构：作者/时间/当前文件/引用条/图片/正文 + 重发回调 + data-msg-index", () => {
    const resent: unknown[] = [];
    const opened: string[] = [];
    const a = mount(<M.Message
      m={{ role: "user", text: "帮我分析客流数据", currentDoc: "报告.docx", images: ["blob:image1"], references: [{ id: "r1", kind: "file", status: "ok", target: "D:/x/数据.xlsx", metadata: { name: "数据.xlsx", relativePath: "数据.xlsx" } }] }}
      index={3}
      onResend={(t) => resent.push(t)}
      onOpenFile={(p) => opened.push(p)}
    />);
    const msg = a.host.querySelector(".msg")!;
    expect(msg.className).toContain("user");
    expect(msg.getAttribute("data-msg-index")).toBe("3");
    expect(text(a.host.querySelector(".msg-author"))).toBe("You");
    expect(text(a.host.querySelector(".msg-context"))).toBe("当前文件: 报告.docx");
    expect(a.host.querySelectorAll(".msg-images img").length).toBe(1);
    click(a.host.querySelector(".msg-reference-chip")!);
    expect(opened).toEqual(["数据.xlsx"]);
    expect(text(a.host.querySelector(".msg-text"))).toBe("帮我分析客流数据");
    click([...a.host.querySelectorAll("button.msg-action")].find((b) => b.textContent!.includes("重发"))!);
    expect(resent).toEqual(["帮我分析客流数据"]);
    a.unmount();
  });
});

describe("Message：assistant 分支", () => {
  it("无终稿：最后文本块原文渲染（不收窄）+ 工具卡入过程折叠区", () => {
    const a = mount(<M.Message
      m={{ role: "assistant", blocks: [{ type: "tool", id: "t1", name: "bash", input: "ls", output: "file1", done: true }, { type: "text", text: "回答正文" }] }}
      model="DeepSeek"
    />);
    expect(text(a.host.querySelector(".msg-author"))).toBe("DeepSeek");
    expect(a.host.querySelector("details.message-process-fold")).toBeTruthy();
    expect(text(a.host.querySelector("details.message-process-fold summary"))).toContain("思考与工具过程");
    expect(a.host.querySelectorAll(".tool-card").length).toBe(1);
    expect(a.host.querySelector(".assistant-final-answer")).toBeNull();
    a.unmount();
  });

  it("权威终稿通道：assistant_final 事件反查 + 匹配文本块隐藏（不重复渲染）", async () => {
    const a = mount(<M.Message
      m={{ role: "assistant", blocks: [{ type: "text", text: "最终答复文本" }, { type: "text", text: "过程小结" }] }}
      runSummary={{ role: "assistant", runId: "run-5", runStatus: "completed", events: [{ type: "assistant_final", data: { text: "最终答复文本" } }] }}
    />);
    await flushMarkdown();
    // 终稿块由 assistant-final-answer 单独渲染；原文块隐藏
    expect(a.host.querySelector(".assistant-final-answer")!.textContent).toContain("最终答复文本");
    const flowTexts = [...a.host.querySelectorAll(".flow-markdown")].filter((el) => !el.className.includes("assistant-final-answer"));
    expect(flowTexts.map((el) => el.textContent)).toEqual(["过程小结"]);
    a.unmount();
  });

  it("B02 收窄：answerDetail=brief 且终稿无匹配块 → 最后文本块承担答复并截 3 行，可展开", async () => {
    window.localStorage.setItem("oaw_settings", JSON.stringify({ answerDetail: "brief" }));
    const longText = "第一行\n第二行\n第三行\n第四行\n第五行";
    const a = mount(<M.Message
      m={{ role: "assistant", blocks: [{ type: "text", text: "过程小结" }] }}
      runSummary={{ role: "assistant", runId: "run-6", runStatus: "completed", events: [{ type: "assistant_final", data: { text: longText } }] }}
    />);
    await flushMarkdown();
    // 终稿无匹配块 → replaceLegacyFinalCandidate：最后文本块按 brief 收窄，独立终稿块不渲染
    expect(a.host.querySelector(".assistant-final-answer")).toBeNull();
    expect(text(a.host.querySelector(".answer-detail-toggle"))).toBe("展开完整答案");
    expect(a.host.querySelector(".msg-blocks")!.textContent).toContain("第一行\n第二行\n第三行");
    expect(a.host.querySelector(".msg-blocks")!.textContent).not.toContain("第四行");
    click(a.host.querySelector("button.answer-detail-toggle"));
    expect(a.host.querySelector(".msg-blocks")!.textContent).toContain("第四行");
    expect(text(a.host.querySelector("button.answer-detail-toggle"))).toBe("收起完整答案");
    a.unmount();
  });

  it("复制：blocks 拼接（tool → name + input）→ 剪贴板 + 已复制反馈", async () => {
    const writeText = stubClipboard();
    const a = mount(<M.Message
      m={{ role: "assistant", blocks: [{ type: "tool", id: "t1", name: "bash", input: "ls -la" }, { type: "text", text: "回答正文" }] }}
      model="DeepSeek"
    />);
    click(a.host.querySelector("button.msg-action")!);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(writeText).toHaveBeenCalledWith("bash ls -la\n回答正文");
    expect(text(a.host.querySelector(".msg-actions"))).toContain("已复制");
    a.unmount();
  });

  it("停止/错误状态：错误徽标 + 中断徽标 + 操作条；runStatus=cancelled → 本轮已中断", () => {
    const a = mount(<M.Message m={{ role: "assistant", blocks: [{ type: "text", text: "半截" }], stopped: true, status: "error", errorText: "连接中断" }} model="DeepSeek" />);
    expect(text(a.host.querySelector(".msg-error-badge"))).toBe("生成失败");
    expect(text(a.host.querySelector(".msg-stopped-badge"))).toBe("已停止生成");
    expect(text(a.host.querySelector(".err-badge"))).toBe("连接中断");
    expect(a.host.querySelector(".msg-actions")).toBeTruthy();
    a.unmount();
    const b = mount(<M.Message
      m={{ role: "assistant", blocks: [{ type: "text", text: "x" }] }}
      runSummary={{ role: "assistant", runId: "run-7", runStatus: "cancelled" }}
    />);
    expect(text(b.host.querySelector(".msg-stopped-badge"))).toBe("本轮已中断");
    b.unmount();
  });

  it("流式态：流式状态条 + 无操作条；等待首字秒数计时", () => {
    vi.useFakeTimers();
    const a = mount(<M.Message m={{ role: "assistant", status: "streaming", blocks: [] }} model="DeepSeek" />);
    expect(a.host.querySelector(".msg-streaming-status")).toBeTruthy();
    expect(a.host.querySelector(".msg-actions")).toBeNull();
    expect(a.host.querySelector(".avatar")!.className).toContain("is-streaming");
    act(() => { vi.advanceTimersByTime(2100); });
    expect(text(a.host.querySelector(".msg-streaming-elapsed"))).toBe("2s");
    a.unmount();
    vi.useRealTimers();
  });
});

/* ============================ MemoMessage 比较器 ============================ */

describe("MemoMessage（React.memo 比较器）", () => {
  const compare = (M.MemoMessage as unknown as { compare: (a: unknown, b: unknown) => boolean }).compare;
  const base = {
    m: { role: "assistant", text: "x" },
    model: "DeepSeek",
    index: 1,
    prevRole: "user",
    clientId: "c1",
    threadId: "t1",
    onOpenFile: () => {},
    onOpenSubagent: () => {}
  };

  it("八字段全等 → 跳过重渲染；任一变化 → 重渲染", () => {
    expect(compare(base, { ...base })).toBe(true);
    expect(compare(base, { ...base, m: { role: "assistant", text: "x" } })).toBe(false);
    expect(compare(base, { ...base, model: "Qwen" })).toBe(false);
    expect(compare(base, { ...base, index: 2 })).toBe(false);
    expect(compare(base, { ...base, prevRole: null })).toBe(false);
    expect(compare(base, { ...base, clientId: "c2" })).toBe(false);
    expect(compare(base, { ...base, threadId: "t2" })).toBe(false);
    expect(compare(base, { ...base, onOpenFile: () => {} })).toBe(false);
    expect(compare(base, { ...base, onOpenSubagent: () => {} })).toBe(false);
  });

  it("未列入比较器的回调变化不触发重渲染（流式补丁不重算历史消息）", () => {
    expect(compare(base, { ...base, runSummary: null, onToggleTool: () => {}, onMemoryApprove: () => {} })).toBe(true);
  });
});
