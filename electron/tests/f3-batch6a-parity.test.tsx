// @vitest-environment jsdom
/**
 * F3 批6a：ChatPanel 模块级共享层（lib/chat-shared）+ 模型行小组件 + 错误边界。
 *
 * R6-6c 对拍退役改写：旧侧 client/src/components/ChatPanel.jsx import 与
 * normalizeHistoryMessages 双侧互等断言随 client 退役删除（等价性已在 F3 批对拍
 * 验收冻结），改为 TS 侧直接期望值断言；其余纯函数绝对锚点与组件渲染/交互锚点保留。
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const Ts = await import("../src/renderer/lib/chat-shared");
const markModule = await import("../src/renderer/components/ModelProviderMark");
const ModelProviderMark = markModule.default;
const { ModelOptionRow } = markModule;
const ChatErrorBoundary = (await import("../src/renderer/components/ChatErrorBoundary")).default;

type Msg = {
  role?: string;
  text?: string;
  runId?: unknown;
  summary?: unknown;
  blocks?: Array<{ type?: string; text?: string; [key: string]: unknown }>;
  [key: string]: unknown;
};
const asMsgs = (v: unknown): Msg[] => v as Msg[];

function mount(node: React.ReactNode): { host: HTMLElement; unmount: () => void } {
  localStorage.clear();
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
    }
  };
}

function click(el: Element | null | undefined): void {
  act(() => { el?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}

afterEach(() => {
  localStorage.clear();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 第一部分：normalizeHistoryMessages 行为锚点
// ---------------------------------------------------------------------------

describe("normalizeHistoryMessages 行为锚点", () => {
  it("非数组与空数组一律返回空数组", () => {
    expect([
      Ts.normalizeHistoryMessages(null),
      Ts.normalizeHistoryMessages(undefined),
      Ts.normalizeHistoryMessages([]),
      Ts.normalizeHistoryMessages(42),
    ]).toEqual([[], [], [], []]);
  });

  it("「[系统提醒]」与中英文冒号形态剔除，普通消息保留", () => {
    const items = [
      { role: "user", text: "[系统提醒] 运行开始" },
      { role: "user", text: "系统提醒：上下文已压缩" },
      { role: "user", text: "系统提醒: 恢复检查" },
      { role: "user", text: "真正的问题" },
      { role: "user", text: "聊聊系统提醒的历史" },
    ];
    expect(asMsgs(Ts.normalizeHistoryMessages(items)).map((m) => m.text)).toEqual(["真正的问题", "聊聊系统提醒的历史"]);
  });

  it("空 assistant 占位剔除，errorText 分支保留", () => {
    const items = [
      { role: "assistant", text: "" },
      { role: "assistant", text: "", blocks: [] },
      { role: "assistant", text: "", errorText: "上游超时" },
      { role: "assistant", text: "最终结论" },
    ];
    expect(asMsgs(Ts.normalizeHistoryMessages(items)).map((m) => m.text)).toEqual(["", "最终结论"]);
  });

  it("相邻同指纹去重：assistant 同指纹首个胜出（指纹集先行），user 相邻同指纹高分者胜", () => {
    expect(asMsgs(Ts.normalizeHistoryMessages([
      { role: "user", text: "问" },
      { role: "assistant", text: "结论 A" },
      { role: "assistant", text: "结论  A" },
    ])).map((m) => m.text)).toEqual(["问", "结论 A"]);
    expect(asMsgs(Ts.normalizeHistoryMessages([
      { role: "user", text: "问" },
      { role: "assistant", text: "结论  A" },
      { role: "assistant", text: "结论 A" },
    ])).map((m) => m.text)).toEqual(["问", "结论  A"]);
    // 分数比较只发生在相邻非 assistant 同指纹合并：user 原始文本更长者分高胜出
    expect(asMsgs(Ts.normalizeHistoryMessages([
      { role: "user", text: "重复" },
      { role: "user", text: "重复 " },
    ])).map((m) => m.text)).toEqual(["重复 "]);
  });

  it("相邻同指纹去重：块文本空白差异同指纹，后者被指纹集剔除保首个", () => {
    const ts = asMsgs(Ts.normalizeHistoryMessages([
      { role: "assistant", blocks: [{ type: "text", text: "块 内容" }] },
      { role: "assistant", blocks: [{ type: "text", text: "块  内容" }] },
    ]));
    expect([ts.length, ts[0]?.blocks?.[0]?.text]).toEqual([1, "块 内容"]);
  });

  it("assistant 同指纹跨 system 仍合并；遇 user 清空指纹集", () => {
    expect(asMsgs(Ts.normalizeHistoryMessages([
      { role: "user", text: "问1" },
      { role: "assistant", text: "答" },
      { role: "system", text: "进度同步" },
      { role: "assistant", text: "答" },
    ])).map((m) => m.text)).toEqual(["问1", "答", "进度同步"]);
    expect(asMsgs(Ts.normalizeHistoryMessages([
      { role: "user", text: "问1" },
      { role: "assistant", text: "答" },
      { role: "user", text: "问2" },
      { role: "assistant", text: "答" },
    ])).map((m) => m.text)).toEqual(["问1", "答", "问2", "答"]);
  });

  it("同 runId 的 system summary 只留一条且分数高者胜", () => {
    const ts = asMsgs(Ts.normalizeHistoryMessages([
      { role: "user", text: "问" },
      { role: "assistant", text: "过程" },
      { role: "system", summary: true, runId: "r1", text: "短总结" },
      { role: "system", summary: true, runId: "r1", text: "更完整的总结，带产物清单" },
    ]));
    const summaries = ts.filter((m) => m.summary);
    expect([summaries.length, summaries[0]?.text, summaries[0]?.runId]).toEqual([1, "更完整的总结，带产物清单", "r1"]);
    const lowSecond = asMsgs(Ts.normalizeHistoryMessages([
      { role: "system", summary: true, runId: "r2", text: "很长很长很长的第一版总结" },
      { role: "system", summary: true, runId: "r2", text: "短" },
    ]));
    expect(lowSecond.filter((m) => m.summary)[0]?.text).toBe("很长很长很长的第一版总结");
  });

  it("普通相邻重复合并（user 同文本）", () => {
    expect(asMsgs(Ts.normalizeHistoryMessages([
      { role: "user", text: "同一句提问" },
      { role: "user", text: "同一句提问" },
      { role: "assistant", text: "答" },
    ])).map((m) => m.text)).toEqual(["同一句提问", "答"]);
  });

  it("顺序保留：不同内容全部按原顺序输出", () => {
    expect(asMsgs(Ts.normalizeHistoryMessages([
      { role: "user", text: "一" },
      { role: "assistant", text: "二" },
      { role: "system", text: "三" },
      { role: "user", text: "四", images: ["i.png"] },
    ])).map((m) => m.text)).toEqual(["一", "二", "三", "四"]);
  });
});

// ---------------------------------------------------------------------------
// 第二部分：纯函数行为锚点（绝对断言）
// ---------------------------------------------------------------------------

describe("chat-shared 纯函数行为锚点", () => {
  it("newId：模块级序列 m1 起步递增", () => {
    expect([Ts.newId(), Ts.newId()]).toEqual(["m1", "m2"]);
  });

  it("modelProvider：provider 优先 / id 兜底 / 空回退 custom / 大小写归一", () => {
    const { modelProvider } = Ts;
    expect([
      modelProvider({ provider: "deepseek/a", id: "openai/gpt" }),
      modelProvider({ id: "openai/gpt" }),
      modelProvider({ provider: "DeepSeek/x" }),
      modelProvider({}),
      modelProvider(null),
    ]).toEqual(["deepseek", "openai", "deepseek", "custom", "custom"]);
  });

  it("modelProviderMeta：已知命中 / 未知回退 provider 名 / custom 中文回退", () => {
    const { modelProviderMeta } = Ts;
    expect([
      modelProviderMeta({ provider: "deepseek" }),
      modelProviderMeta({ provider: "minimax-cn" }),
      modelProviderMeta({ provider: "no-such" }),
      modelProviderMeta({}),
    ]).toEqual([
      { label: "DeepSeek", icon: "deepseek" },
      { label: "MiniMax", icon: "minimax" },
      { label: "no-such", icon: "custom" },
      { label: "自定义供应商", icon: "custom" },
    ]);
  });

  it("providerInitials：单段前两字符 / 双段首字母 / 空问号", () => {
    const { providerInitials } = Ts;
    expect([
      providerInitials("deepseek"),
      providerInitials("openai"),
      providerInitials("command-code"),
      providerInitials("xiaomi-token-plan-cn"),
      providerInitials("command-code-x"),
      providerInitials(""),
      providerInitials(null),
    ]).toEqual(["DE", "OP", "CC", "XT", "CC", "?", "?"]);
  });

  it("providerHue：确定性哈希（手工锚定 deepseek=28）", () => {
    const { providerHue } = Ts;
    expect([providerHue("deepseek"), providerHue("a"), providerHue(""), providerHue(null)]).toEqual([28, 97, 0, 0]);
  });

  it("eventMessageText：trim / 嵌套优先级 / JSON 兜底 / null 回退", () => {
    const { eventMessageText } = Ts;
    expect([
      eventMessageText("  hi  "),
      eventMessageText({ message: "m", error: "e" }),
      eventMessageText({ error: "e" }),
      eventMessageText({ detail: { message: "deep" } }),
      eventMessageText({ text: "t" }),
      eventMessageText({ foo: 1 }),
      eventMessageText(5),
      eventMessageText(null, "fb"),
      eventMessageText(undefined, "fb"),
      eventMessageText("", "fb"),
    ]).toEqual(["hi", "m", "e", "deep", "t", '{"foo":1}', "5", "fb", "fb", "fb"]);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(eventMessageText(circular, "循环兜底")).toBe("循环兜底");
  });

  it("usageDetails：别名矩阵 / context 缺省按 input+cacheRead+cacheWrite 合成 / 非法数字归零", () => {
    const { usageDetails } = Ts;
    expect([
      usageDetails({ inputTokens: 10, outputTokens: 20 }),
      usageDetails({ input: 5, output: 6, cacheRead: 7, cacheWrite: 8, contextTokens: 100 }),
      usageDetails({ cache_read: 3, cache_write: 4 }),
      usageDetails({ inputTokens: "12", outputTokens: "abc" }),
      usageDetails(undefined),
    ]).toEqual([
      { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, context: 10 },
      { input: 5, output: 6, cacheRead: 7, cacheWrite: 8, context: 100 },
      { input: 0, output: 0, cacheRead: 3, cacheWrite: 4, context: 7 },
      { input: 12, output: 0, cacheRead: 0, cacheWrite: 0, context: 12 },
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, context: 0 },
    ]);
  });

  it("normalizeUiMode：office/agent→agent、review→review、其余→chat", () => {
    const { normalizeUiMode } = Ts;
    expect([normalizeUiMode("office"), normalizeUiMode("agent"), normalizeUiMode("review"), normalizeUiMode("chat"), normalizeUiMode("work"), normalizeUiMode(undefined)]).toEqual(["agent", "agent", "review", "chat", "chat", "chat"]);
  });

  it("pathBaseName：反斜杠/正斜杠/尾斜杠/空", () => {
    const { pathBaseName } = Ts;
    expect([pathBaseName("a\\b\\c.txt"), pathBaseName("a/b/c.txt"), pathBaseName("dir/"), pathBaseName("dir\\"), pathBaseName("single"), pathBaseName("")]).toEqual(["c.txt", "c.txt", "dir", "dir", "single", ""]);
  });

  it("modelCapabilityLabel：vision 布尔 / contextWindow 换算 / 未标注", () => {
    const { modelCapabilityLabel } = Ts;
    expect([
      modelCapabilityLabel(null),
      modelCapabilityLabel({}),
      modelCapabilityLabel({ vision: true }),
      modelCapabilityLabel({ vision: false }),
      modelCapabilityLabel({ contextWindow: 128000 }),
      modelCapabilityLabel({ vision: true, contextWindow: 200000 }),
    ]).toEqual(["", "能力未标注", "支持图片", "仅文本", "128k 上下文", "支持图片 · 200k 上下文"]);
  });

  it("parseReferenceMarkers：五类标记按序收集、@文件[形态不重复收", () => {
    const { parseReferenceMarkers } = Ts;
    const refs = parseReferenceMarkers("@知识库[换乘] 和 @模板目录[周报]，见 &会话[s1] 以及 @文件[报告.docx]");
    expect(refs.map((r) => [r.kind, r.target, r.source])).toEqual([
      ["knowledge", "换乘", "@知识库[换乘]"],
      ["template_dir", "周报", "@模板目录[周报]"],
      ["file", "报告.docx", "@文件[报告.docx]"],
      ["session", "s1", "&会话[s1]"],
    ]);
  });

  it("parseReferenceMarkers：裸 @词带扩展名才收、去重、尾标点修剪", () => {
    const { parseReferenceMarkers } = Ts;
    const refs = parseReferenceMarkers("先看 @报告.docx，再看 @数据.md。重复 @报告.docx 与裸词 @数据 不收");
    expect(refs.map((r) => [r.kind, r.target, r.source])).toEqual([
      ["file", "报告.docx", "@报告.docx"],
      ["file", "数据.md", "@数据.md"],
    ]);
    expect(parseReferenceMarkers("@总结.txt)").map((r) => [r.kind, r.target, r.source])).toEqual([["file", "总结.txt", "@总结.txt"]]);
    expect([parseReferenceMarkers("@"), parseReferenceMarkers("@文件[")]).toEqual([[], []]);
  });

  it("referenceMarker：session 前缀 &会话 / kind 中文标签 / source 优先 / 无 target 空串", () => {
    const { referenceMarker } = Ts;
    expect([
      referenceMarker({ kind: "session", target: "s1" }),
      referenceMarker({ kind: "session", target: "s1", source: "SRC" }),
      referenceMarker({ kind: "knowledge", target: "k1" }),
      referenceMarker({ kind: "knowledge_dir", target: "kd" }),
      referenceMarker({ kind: "template_dir", target: "td" }),
      referenceMarker({ kind: "template", target: "t" }),
      referenceMarker({ kind: "file", target: "a.docx" }),
      referenceMarker({ kind: "whatever", target: "x", source: "SRC2" }),
      referenceMarker({}),
      referenceMarker(null),
    ]).toEqual([
      "&会话[s1]", "SRC", "@知识库[k1]", "@知识库目录[kd]", "@模板目录[td]", "@模板[t]", "@文件[a.docx]", "SRC2", "", "",
    ]);
  });

  it("appendTextBlock/appendThinkingBlock：相邻同型合并、异型新建（thinking 带 startTime）", () => {
    const { appendTextBlock, appendThinkingBlock } = Ts;
    const a = appendTextBlock([], "你好");
    expect(a).toEqual([{ type: "text", text: "你好" }]);
    expect(appendTextBlock(a, "，世界")).toEqual([{ type: "text", text: "你好，世界" }]);
    expect(appendTextBlock([{ type: "thinking", text: "x" }], "t")).toEqual([{ type: "thinking", text: "x" }, { type: "text", text: "t" }]);
    const th = appendThinkingBlock([], "想");
    expect(th).toEqual([{ type: "thinking", text: "想", startTime: expect.any(Number) }]);
    expect(appendThinkingBlock(th, "法")).toEqual([{ type: "thinking", text: "想法", startTime: th[0]?.startTime }]);
  });

  it("appendAssistantMessageBoundary：空数组原样 / 同 id 幂等 / 空 id 幂等 / 异 id 追加", () => {
    const { appendAssistantMessageBoundary } = Ts;
    // 空数组：!arr.length 直接原样返回，不追加
    const first = appendAssistantMessageBoundary([], "x");
    const again = appendAssistantMessageBoundary(first, "x");
    expect([first, again]).toEqual([[], []]);
    // 末尾已是 boundary：空 id 幂等保留，同 id 幂等，异 id 追加
    const yOnly = [{ type: "message_boundary", id: "y" }] as typeof first;
    const emptyIdKeep = appendAssistantMessageBoundary(yOnly, "");
    expect(emptyIdKeep.map((b) => [b.type, b.id])).toEqual([["message_boundary", "y"]]);
    expect(appendAssistantMessageBoundary(yOnly, "y").map((b) => [b.type, b.id])).toEqual([["message_boundary", "y"]]);
    expect(appendAssistantMessageBoundary(yOnly, "z").map((b) => [b.type, b.id])).toEqual([["message_boundary", "y"], ["message_boundary", "z"]]);
    // 末尾非 boundary：追加新边界，显式 id 透传
    const explicit = appendAssistantMessageBoundary([{ type: "text", text: "t" }], "w");
    expect([explicit.length, explicit[1]?.type, explicit[1]?.id]).toEqual([2, "message_boundary", "w"]);
    // 空 id 且末尾非 boundary：生成 m 序列 id
    const genId = appendAssistantMessageBoundary([{ type: "text", text: "t" }], "");
    expect([genId.length, genId[1]?.type, /^m\d+$/.test(String(genId[1]?.id))]).toEqual([2, "message_boundary", true]);
  });

  it("appendExecutionFlowEvent：key 重复直接返回原数组", () => {
    const { appendExecutionFlowEvent } = Ts;
    const prev = [{ key: "k1", type: "token", data: {} }];
    expect(appendExecutionFlowEvent(prev, { key: "k1", type: "other" })).toBe(prev);
  });

  it("appendExecutionFlowEvent：file_changed 同 run 合并 files 去重保留原 key，异 run 不合并", () => {
    const { appendExecutionFlowEvent } = Ts;
    const result = appendExecutionFlowEvent(
      [{ key: "f1", type: "file_changed", data: { runId: "r1", files: ["a.txt"] } }],
      { key: "f2", type: "file_changed", data: { runId: "r1", files: ["b.txt", "a.txt"] } },
    );
    expect([result.length, result[0]]).toEqual([1, { key: "f1", type: "file_changed", data: { runId: "r1", files: ["a.txt", "b.txt"] } }]);
    const cross = appendExecutionFlowEvent(
      [{ key: "f1", type: "file_changed", data: { runId: "r1", files: ["a.txt"] } }],
      { key: "f3", type: "file_changed", data: { runId: "r2", files: ["c.txt"] } },
    );
    expect([cross.length, cross[1]?.key]).toEqual([2, "f3"]);
    const plain = appendExecutionFlowEvent(
      [{ key: "p1", type: "file_changed", data: { files: [] } }],
      { key: "p2", type: "file_changed", data: { files: ["n.txt"] } },
    );
    expect([plain.length, plain[0]]).toEqual([1, { key: "p1", type: "file_changed", data: { files: ["n.txt"] } }]);
  });

  it("appendExecutionFlowEvent：agent_summary 同型同 run 覆盖内容但保留原 key", () => {
    const { appendExecutionFlowEvent } = Ts;
    const result = appendExecutionFlowEvent(
      [{ key: "s1", type: "agent_summary", data: { runId: "r1", summary: "旧" } }],
      { key: "s2", type: "agent_summary", data: { runId: "r1", summary: "新" } },
    );
    expect([result.length, result[0]]).toEqual([1, { key: "s1", type: "agent_summary", data: { runId: "r1", summary: "新" } }]);
  });

  it("appendExecutionFlowEvent：超过 300 条截断保留最近 300 条", () => {
    const { appendExecutionFlowEvent } = Ts;
    let list: Array<{ key: string; type: string; data?: Record<string, unknown> }> = [];
    for (let i = 0; i < 305; i += 1) {
      list = appendExecutionFlowEvent(list, { key: `k${i}`, type: "token", data: {} });
    }
    expect([list.length, list[0]?.key, list[299]?.key]).toEqual([300, "k5", "k304"]);
  });

  it("appendSubagentTrace：非数组起点 / 同类合并 / 异类追加 / 240 上限 / 2 万字截断", () => {
    const { appendSubagentTrace } = Ts;
    expect([
      appendSubagentTrace(null, { kind: "text", text: "a" }),
      appendSubagentTrace([{ kind: "thinking", text: "ab" }], { kind: "thinking", text: "cd" }),
      appendSubagentTrace([{ kind: "thinking", text: "ab" }], { kind: "text", text: "cd" }),
      appendSubagentTrace([{ kind: "text", text: "x" }], null),
    ]).toEqual([
      [{ kind: "text", text: "a" }],
      [{ kind: "thinking", text: "abcd" }],
      [{ kind: "thinking", text: "ab" }, { kind: "text", text: "cd" }],
      [{ kind: "text", text: "x" }],
    ]);
    let list: Array<{ kind?: string; text?: string }> = [];
    for (let i = 0; i < 242; i += 1) list = appendSubagentTrace(list, { kind: `k${i}` });
    expect([list.length, list[0]?.kind]).toEqual([240, "k2"]);
    const merged = appendSubagentTrace([{ kind: "thinking", text: "x".repeat(20005) }], { kind: "thinking", text: "y" });
    expect(merged[0]?.text).toBe("x".repeat(19999) + "y");
  });

  it("readDraft/writeDraft：LRU 容量 20 淘汰最旧、空串删除、非 threadId 不写", () => {
    const { readDraft, writeDraft, draftCache } = Ts;
    draftCache.clear();
    writeDraft("t1", "hello");
    writeDraft("", "nope");
    expect([readDraft("t1"), readDraft(""), readDraft(null), draftCache.has("")]).toEqual(["hello", "", "", false]);
    writeDraft("t1", "");
    expect(readDraft("t1")).toBe("");
    draftCache.clear();
    writeDraft("t1", "1");
    writeDraft("t2", "2");
    writeDraft("t1", "1b");
    for (let i = 3; i <= 21; i += 1) writeDraft(`t${i}`, String(i));
    expect([draftCache.size, readDraft("t2"), readDraft("t1"), readDraft("t21")]).toEqual([20, "", "1b", "21"]);
  });

  it("readStoredModelList/writeStoredModelList：非法 JSON 回退 / 非字符串过滤 / 回写再读", () => {
    const { readStoredModelList, writeStoredModelList } = Ts;
    localStorage.setItem("parity_models_bad", "{oops");
    localStorage.setItem("parity_models_mix", JSON.stringify(["a", "b", 1, "", null]));
    expect([readStoredModelList("parity_models_bad"), readStoredModelList("parity_models_mix"), readStoredModelList("parity_models_missing")]).toEqual([[], ["a", "b"], []]);
    writeStoredModelList("parity_models_out", ["x", "y"]);
    expect([localStorage.getItem("parity_models_out"), readStoredModelList("parity_models_out")]).toEqual(['["x","y"]', ["x", "y"]]);
  });

  it("formatMsgTime：同年 MM/DD HH:mm 补零、跨年含年份、空值空串", () => {
    const { formatMsgTime } = Ts;
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 2, 15, 10, 30));
      expect([
        formatMsgTime(new Date(2026, 2, 15, 10, 30).getTime()),
        formatMsgTime(new Date(2025, 10, 2, 8, 5).getTime()),
      ]).toEqual(["03/15 10:30", "2025/11/02 08:05"]);
    } finally {
      vi.useRealTimers();
    }
    expect([formatMsgTime(0), formatMsgTime(null)]).toEqual(["", ""]);
  });
});

// ---------------------------------------------------------------------------
// 第三部分：组件渲染 / 交互锚点
// ---------------------------------------------------------------------------

describe("ModelProviderMark / ModelOptionRow / ChatErrorBoundary 锚点", () => {
  it("ModelProviderMark 已知供应商：品牌图标 + provider 类 + label title", () => {
    const html = renderToStaticMarkup(<ModelProviderMark model={{ id: "deepseek/deepseek-chat", name: "DeepSeek Chat" }} />);
    expect([html.includes("model-provider-mark provider-deepseek"), html.includes("provider-icon-deepseek"), html.includes('title="DeepSeek"'), html.includes("provider-initials")]).toEqual([true, true, true, false]);
  });

  it("ModelProviderMark 未知供应商：首字母缩写 + 稳定色相 + 手算字号", () => {
    const html = renderToStaticMarkup(<ModelProviderMark model={{ id: "command-code-x/model" }} />);
    expect(html).toContain("model-provider-mark provider-command-code-x provider-initials");
    expect([html.includes(">CC</span>"), html.includes("hsl("), html.includes("font-size:9px"), html.includes('title="command-code-x"')]).toEqual([true, true, true, true]);
  });

  it("ModelOptionRow：不可用禁用徽记 / 当前高亮 check / 收藏 aria 两形态", () => {
    const noPick = vi.fn();
    const noFav = vi.fn();
    const unavailable = renderToStaticMarkup(
      <ModelOptionRow model={{ id: "m/1", name: "模型一", available: false, vision: true, contextWindow: 128000 }} onPick={noPick} onToggleFavorite={noFav} />
    );
    expect([unavailable.includes("disabled"), unavailable.includes("model-unavailable-badge"), unavailable.includes("不可用")]).toEqual([true, true, true]);
    const current = renderToStaticMarkup(
      <ModelOptionRow model={{ id: "m/2", name: "模型二" }} current onPick={noPick} onToggleFavorite={noFav} />
    );
    expect([current.includes("active"), current.includes("icon-check"), current.includes("disabled")]).toEqual([true, true, false]);
    const favOn = renderToStaticMarkup(
      <ModelOptionRow model={{ id: "m/3", name: "模型三" }} favorite onPick={noPick} onToggleFavorite={noFav} />
    );
    const favOff = renderToStaticMarkup(
      <ModelOptionRow model={{ id: "m/3", name: "模型三" }} favorite={false} onPick={noPick} onToggleFavorite={noFav} />
    );
    expect([favOn.includes('aria-pressed="true"'), favOn.includes("取消收藏 模型三"), favOff.includes('aria-pressed="false"'), favOff.includes("收藏 模型三")]).toEqual([true, true, true, true]);
  });

  it("ModelOptionRow 交互：不可用不触发 onPick；收藏按钮触发 onToggleFavorite 且阻断冒泡", () => {
    const onPick = vi.fn();
    const onToggleFavorite = vi.fn();
    const stopSpy = vi.spyOn(Event.prototype, "stopPropagation");
    const m = mount(
      <div>
        <ModelOptionRow model={{ id: "m/1", name: "模型一", available: false }} onPick={onPick} onToggleFavorite={onToggleFavorite} />
        <ModelOptionRow model={{ id: "m/2", name: "模型二" }} current onPick={onPick} onToggleFavorite={onToggleFavorite} />
      </div>
    );
    const optionBtns = m.host.querySelectorAll<HTMLButtonElement>(".model-option");
    act(() => { optionBtns[0]?.click(); }); // disabled 表单控件：jsdom 按 spec 直接忽略
    click(optionBtns[1]);
    expect(onPick.mock.calls.map((c) => c[0])).toEqual(["m/2"]);
    click(m.host.querySelector(".model-fav-btn"));
    expect(onToggleFavorite.mock.calls.map((c) => c[0])).toEqual(["m/1"]);
    expect(stopSpy).toHaveBeenCalled();
    m.unmount();
  });

  it("ChatErrorBoundary：正常 children 直出", () => {
    const html = renderToStaticMarkup(<ChatErrorBoundary><p className="kid">内容正常</p></ChatErrorBoundary>);
    expect(html).toContain('<p class="kid">内容正常</p>');
  });

  it("ChatErrorBoundary：子组件抛错时渲染兜底 UI（console.error 静音）", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    function Boom(): never {
      throw new Error("boom");
    }
    const m = mount(<ChatErrorBoundary><Boom /></ChatErrorBoundary>);
    const html = m.host.innerHTML;
    expect([!!m.host.querySelector(".chat-error-boundary"), html.includes("组件出错，请刷新页面"), html.includes("刷新页面")]).toEqual([true, true, true]);
    expect(errorSpy).toHaveBeenCalled();
    m.unmount();
  });
});
