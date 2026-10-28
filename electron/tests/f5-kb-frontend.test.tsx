// @vitest-environment jsdom
/**
 * F5-8 kb 前端组装层对拍（client/src/components/KnowledgeBase.jsx 851 行 → TS）。
 *
 * 对拍口径（子件全桩：KnowledgeGraph/MindMap/RetrievalChat/MarkdownBody 以轻桩捕获
 * props；client-api kb 函数族 12 项 / Feedback notify*+askConfirm / window.prompt 打桩）：
 *   K1 挂载加载链：kbStatus + kbImaStatus → 根下拉；roots 非空自动 loadRoot(0) →
 *      kbTree(0) 根级渲染（目录 + 文件行）；
 *   K2 打开文档：文件树行 → kbDoc(relPath, rootIdx) → tab 栏 + MarkdownBody content
 *      + 左栏路径/标题结构 + 右栏链接反链 + 底部反链区块；
 *   K3 搜索：输入 + 按钮 → kbSearch(q, rootIdx) → 结果列表 → 点结果 openDoc；
 *   K4 思维图谱：视图切换 → kbGraph(rootIdx, inc, 800) → data 分发 + stats 文案；
 *      勾选维度 → graphData 清空重拉（include 增量）；
 *   K5 脑图：视图切换 → MindMap 轻桩分发 roots/rootIdx/highlightPath；
 *   K6 @ 标记链：右栏「@ 到对话」+ 树行 @（文件/目录两种标记）累积 → 返回按钮
 *      计数文案 → onExit(marks) 传出；
 *   K7 导出 Word：kbExportDocx(relPath, rootIdx) → notifySuccess / 失败 notifyError；
 *   K8 增根：window.prompt → kbAddRoot → kbStatus 重拉 → loadRoot(新根索引)；
 *   K9 删根：askConfirm true → kbRemoveRoot(当前根 path) → 重拉 loadRoot(0)；
 *      askConfirm false → 不发起移除；
 *   K10 只读 Chat 抽屉：RetrievalChat 分发（scope/contextLabel/references）+
 *      onPromoteToAgent 透传。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

vi.setConfig({ testTimeout: 30_000 });

/* ==================== 桩捕获容器（vi.hoisted 供工厂与用例共享） ==================== */

const stubs = vi.hoisted(() => {
  const box = <T,>(initial: T) => ({ current: initial });
  return {
    kgProps: box<Record<string, unknown> | null>(null),
    mmProps: box<Record<string, unknown> | null>(null),
    chatProps: box<Record<string, unknown> | null>(null),
    mdProps: box<Record<string, unknown> | null>(null),
  };
});

/* ==================== 模块桩 ==================== */

vi.mock("../src/renderer/api/client-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/renderer/api/client-api")>();
  const fn = () => vi.fn(async () => ({}));
  return {
    ...actual,
    kbStatus: fn(),
    kbAddRoot: fn(),
    kbRemoveRoot: fn(),
    kbTree: fn(),
    kbSearch: fn(),
    kbGraph: fn(),
    kbDoc: fn(),
    kbImaStatus: fn(),
    kbImaBases: fn(),
    kbImaSearch: fn(),
    kbImaDoc: fn(),
    kbExportDocx: fn()
  };
});

vi.mock("../src/renderer/components/Feedback", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/renderer/components/Feedback")>();
  return {
    ...actual,
    notifyError: vi.fn(),
    notifySuccess: vi.fn(),
    askConfirm: vi.fn(async () => true)
  };
});

vi.mock("../src/renderer/features/kb/knowledge-graph", async () => {
  const React = await import("react");
  return {
    default: (props: Record<string, unknown>) => {
      stubs.kgProps.current = props;
      const data = props.data as { nodes?: unknown[]; edges?: unknown[] } | null;
      return React.createElement(
        "div",
        { "data-testid": "kg-stub" },
        JSON.stringify({ nodes: data?.nodes?.length ?? 0, edges: data?.edges?.length ?? 0, highlightId: props.highlightId ?? null, focusId: props.focusId ?? null })
      );
    }
  };
});

vi.mock("../src/renderer/features/kb/mind-map", async () => {
  const React = await import("react");
  return {
    default: (props: Record<string, unknown>) => {
      stubs.mmProps.current = props;
      const roots = props.roots as unknown[] | undefined;
      return React.createElement(
        "div",
        { "data-testid": "mm-stub" },
        JSON.stringify({ roots: roots?.length ?? 0, rootIdx: props.rootIdx, highlightPath: props.highlightPath ?? null })
      );
    }
  };
});

vi.mock("../src/renderer/features/chat/retrieval-chat", async () => {
  const React = await import("react");
  return {
    default: (props: Record<string, unknown>) => {
      stubs.chatProps.current = props;
      return React.createElement("div", { "data-testid": "retrieval-chat-stub" });
    }
  };
});

vi.mock("../src/renderer/components/MarkdownBody", async () => {
  const React = await import("react");
  return {
    default: (props: Record<string, unknown>) => {
      stubs.mdProps.current = props;
      return React.createElement("div", { "data-testid": "md-body-stub" }, String(props.children ?? ""));
    }
  };
});

import KnowledgeBase from "../src/renderer/features/kb/knowledge-base";
import {
  kbStatus, kbAddRoot, kbRemoveRoot, kbTree, kbSearch, kbGraph, kbDoc,
  kbImaStatus, kbExportDocx
} from "../src/renderer/api/client-api";
import { notifyError, notifySuccess, askConfirm } from "../src/renderer/components/Feedback";

const kbStatusMock = vi.mocked(kbStatus);
const kbAddRootMock = vi.mocked(kbAddRoot);
const kbRemoveRootMock = vi.mocked(kbRemoveRoot);
const kbTreeMock = vi.mocked(kbTree);
const kbSearchMock = vi.mocked(kbSearch);
const kbGraphMock = vi.mocked(kbGraph);
const kbDocMock = vi.mocked(kbDoc);
const kbImaStatusMock = vi.mocked(kbImaStatus);
const kbExportDocxMock = vi.mocked(kbExportDocx);
const notifyErrorMock = vi.mocked(notifyError);
const notifySuccessMock = vi.mocked(notifySuccess);
const askConfirmMock = vi.mocked(askConfirm);

/* ==================== 测试夹具 ==================== */

const ROOTS = [
  { index: 0, path: "D:/kb1", name: "kb1", exists: true },
  { index: 1, path: "D:/kb2", name: "kb2", exists: false }
];
const ROOTS_AFTER_ADD = [...ROOTS, { index: 2, path: "D:/newkb", name: "newkb", exists: true }];
const ROOTS_AFTER_REMOVE = [ROOTS[1]!];

const ROOT_LEVEL = {
  dirs: [{ type: "dir", name: "子目录", path: "sub", subCount: 2 }],
  files: [{ type: "file", name: "a.md", relPath: "a.md", title: "文档A", tags: ["t1"], linkCount: 1, mtime: 123 }]
};
const SUB_LEVEL = {
  dirs: [],
  files: [{ type: "file", name: "b.md", relPath: "sub/b.md", title: "B文", tags: [], linkCount: 0, mtime: 456 }]
};

const DOC = {
  relPath: "a.md",
  rootIdx: 0,
  rootName: "kb1",
  title: "文档A",
  content: "# 文档A\n\n正文内容",
  tags: ["t1"],
  headings: ["标题一", "标题二"],
  links: [{ relPath: "b.md", alias: "B文", title: "B文" }],
  backlinks: [{ relPath: "c.md", title: "C文", snippet: "引用了文档A", rootIdx: 0 }],
  mentions: [{ relPath: "d.md", title: "D文", snippet: "提及文档A上下文片段内容足够长", rootIdx: 0 }]
};

const SEARCH_RESULTS = { results: [{ relPath: "doc-x.md", title: "物流方案", snippet: "物流网络设计", tags: ["物流"] }] };

const GRAPH_DATA = {
  nodes: [{ id: "n0/a.md", label: "文档A", type: "doc" }, { id: "n0/b.md", label: "B文", type: "doc" }],
  edges: [{ source: "n0/a.md", target: "n0/b.md" }],
  stats: { nodes: 2, edges: 1, isolated: 0, brokenLinks: 0 }
};

function kbProps(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    clientId: "c1",
    workspace: "ws1",
    project: null,
    models: [],
    defaultModel: "m1",
    onExit: vi.fn(),
    onPromoteToAgent: vi.fn(),
    ...overrides
  };
}

/* ==================== 挂载 harness ==================== */

let host: HTMLElement;
let root: Root | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  kbStatusMock.mockResolvedValue({ roots: ROOTS, fileCount: 2, imaSkillDir: "" } as never);
  kbImaStatusMock.mockResolvedValue({ configured: true } as never);
  kbTreeMock.mockImplementation(async (root: number, dir?: string) =>
    (dir ? SUB_LEVEL : ROOT_LEVEL) as never);
  kbDocMock.mockResolvedValue(DOC as never);
  kbSearchMock.mockResolvedValue(SEARCH_RESULTS as never);
  kbGraphMock.mockResolvedValue(GRAPH_DATA as never);
  kbExportDocxMock.mockResolvedValue({ name: "文档A.docx", relPath: "a.md" } as never);
  askConfirmMock.mockResolvedValue(true);
  stubs.kgProps.current = null;
  stubs.mmProps.current = null;
  stubs.chatProps.current = null;
  stubs.mdProps.current = null;
  host = document.createElement("div");
  document.body.appendChild(host);
});

const flush = async (times = 2) => {
  for (let i = 0; i < times; i += 1) {
    await act(async () => { await Promise.resolve(); });
  }
};

function mount(ui: React.ReactElement) {
  root = createRoot(host);
  act(() => { root!.render(ui); });
}

function unmount() {
  if (root) { act(() => { root!.unmount(); }); root = null; }
  host.remove();
}

const buttonByTitle = (title: string): HTMLButtonElement =>
  [...host.querySelectorAll("button")].find((b) => (b.getAttribute("title") || "").includes(title)) as HTMLButtonElement;

const buttonByText = (text: string): HTMLButtonElement =>
  [...host.querySelectorAll("button")].find((b) => b.textContent!.includes(text)) as HTMLButtonElement;

/** 打开文档 a.md（点文件树行并等 kbDoc 链完成）。 */
async function openDocA() {
  const row = [...host.querySelectorAll(".kb-tree-row")].find((r) => r.getAttribute("title") === "a.md") as HTMLButtonElement;
  expect(row).toBeTruthy();
  act(() => { row.click(); });
  await flush(3);
}

/* ==================== K1/K2. 加载链与文档打开 ==================== */

describe("加载链与文档打开", () => {
  it("K1 挂载：kbStatus + kbImaStatus → 根下拉 → 自动 loadRoot(0) → kbTree 根级渲染", async () => {
    try {
      mount(<KnowledgeBase {...(kbProps() as any)} />);
      await flush(4);
      expect(kbStatusMock).toHaveBeenCalledTimes(1);
      expect(kbImaStatusMock).toHaveBeenCalledTimes(1);
      // 根下拉渲染 2 个 option（缺失根带「（缺失）」后缀）
      const select = host.querySelector(".kb-root-select") as HTMLSelectElement;
      expect(select).toBeTruthy();
      const options = [...select.querySelectorAll("option")].map((o) => o.textContent);
      expect(options).toEqual(["kb1", "kb2（缺失）"]);
      // 自动加载根 0：kbTree(0) → 目录 + 文件行（目录行 title 为目录名）
      expect(kbTreeMock).toHaveBeenCalledWith(0);
      const rows = [...host.querySelectorAll(".kb-tree-row")].map((r) => r.getAttribute("title"));
      expect(rows).toContain("子目录");
      expect(rows).toContain("a.md");
      // 目录行带子项计数徽标
      const dirRow = host.querySelector(".kb-tree-dir .kb-tree-row")!;
      expect(dirRow.querySelector(".kb-tree-count")!.textContent).toBe("2");
    } finally { unmount(); }
  });

  it("K2 打开文档：kbDoc → tab + 正文 + 左栏信息 + 右栏链接反链 + 底部反链区块", async () => {
    try {
      mount(<KnowledgeBase {...(kbProps() as any)} />);
      await flush(4);
      await openDocA();
      expect(kbDocMock).toHaveBeenCalledWith("a.md", 0);
      // Obsidian tab 栏
      const tab = host.querySelector(".kb-tab")!;
      expect(tab.querySelector(".kb-tab-title")!.textContent).toBe("文档A");
      expect(tab.className).toContain("active");
      // 正文经 MarkdownBody 渲染
      expect(stubs.mdProps.current).toBeTruthy();
      expect(String((stubs.mdProps.current as Record<string, unknown>).children)).toContain("正文内容");
      // 左栏信息：路径 + 标题结构 + 标签
      expect(host.querySelector(".kb-meta-path")!.textContent).toBe("kb1 / a.md");
      const headings = [...host.querySelectorAll(".kb-headings li")].map((li) => li.textContent);
      expect(headings).toEqual(["标题一", "标题二"]);
      expect([...host.querySelectorAll(".kb-doc-tags .tag")].map((t) => t.textContent)).toEqual(["#t1"]);
      // 右栏：双向链接 + 反链 + @ 按钮
      expect(buttonByTitle("插入 @ 引用到主 Chat 对话")).toBeTruthy();
      const linkItems = [...host.querySelectorAll(".kb-links li")].map((li) => li.textContent);
      expect(linkItems.join("|")).toContain("B文");
      // 底部反链区块：反向链接（1）· 提及（1）
      expect(host.querySelector(".kb-doc-backlinks-title")!.textContent).toContain("反向链接（1）· 提及（1）");
    } finally { unmount(); }
  });
});

/* ==================== K3/K4/K5. 搜索与视图切换 ==================== */

describe("搜索与视图切换", () => {
  it("K3 搜索：kbSearch(q, rootIdx) → 结果列表 → 点结果 openDoc", async () => {
    try {
      mount(<KnowledgeBase {...(kbProps() as any)} />);
      await flush(4);
      const input = host.querySelector('input[placeholder="搜索知识库…"]') as HTMLInputElement;
      // React 受控 input：须用原型 native setter 写值再派发 input 事件，onChange 才会触发
      const setNativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      act(() => { setNativeValue.call(input, "物流"); input.dispatchEvent(new Event("input", { bubbles: true })); });
      await flush();
      act(() => { (host.querySelector('button[aria-label="搜索知识库"]') as HTMLButtonElement).click(); });
      await flush(3);
      expect(kbSearchMock).toHaveBeenCalledWith("物流", 0);
      // 结果列表渲染
      const items = [...host.querySelectorAll(".kb-results li")];
      expect(items.length).toBe(1);
      expect(items[0]!.textContent).toContain("物流方案");
      expect(items[0]!.textContent).toContain("物流网络设计");
      // 点结果 → openDoc
      act(() => { (items[0] as HTMLElement).click(); });
      await flush(3);
      expect(kbDocMock).toHaveBeenCalledWith("doc-x.md", 0);
    } finally { unmount(); }
  });

  it("K4 思维图谱：kbGraph(rootIdx, inc, 800) → data 分发 + stats 文案；勾选维度重拉", async () => {
    try {
      mount(<KnowledgeBase {...(kbProps() as any)} />);
      await flush(4);
      act(() => { buttonByText("思维图谱").click(); });
      await flush(3);
      expect(kbGraphMock).toHaveBeenCalledWith(0, ["links", "tags"], 800);
      // KnowledgeGraph 轻桩分发 data + 高亮 id
      const kg = JSON.parse(host.querySelector('[data-testid="kg-stub"]')!.textContent!);
      expect(kg.nodes).toBe(2);
      expect(kg.edges).toBe(1);
      expect(kg.highlightId).toBeNull(); // 未选中文档
      // stats 文案
      expect(host.querySelector(".kb-graph-meta")!.textContent).toContain("节点 2 · 边 1 · 孤立 0");
      // 勾选「目录」维度 → graphData 清空 → include 增量重拉
      const folderCheck = [...host.querySelectorAll(".kb-check input")][3] as HTMLInputElement;
      act(() => { folderCheck.click(); });
      await flush(3);
      expect(kbGraphMock).toHaveBeenLastCalledWith(0, ["links", "tags", "folders"], 800);
    } finally { unmount(); }
  });

  it("K5 脑图：MindMap 分发 roots/rootIdx/highlightPath（tree 死路径形态由轻桩承接）", async () => {
    try {
      mount(<KnowledgeBase {...(kbProps() as any)} />);
      await flush(4);
      act(() => { buttonByText("脑图").click(); });
      await flush(2);
      expect(stubs.mmProps.current).toBeTruthy();
      const mm = JSON.parse(host.querySelector('[data-testid="mm-stub"]')!.textContent!);
      expect(mm.roots).toBe(2);
      expect(mm.rootIdx).toBe(0);
      expect(mm.highlightPath).toBeNull();
    } finally { unmount(); }
  });
});

/* ==================== K6/K7. @ 标记链与导出 ==================== */

describe("@ 标记链与导出", () => {
  it("K6 @ 标记：右栏按钮 + 树行 @（文件/目录）累积 → 返回按钮计数 → onExit(marks)", async () => {
    try {
      const props = kbProps();
      mount(<KnowledgeBase {...(props as any)} />);
      await flush(4);
      // 未打开文档时右栏 @ 按钮不存在（currentDoc 守卫）
      expect(host.querySelector(".kb-at-btn")).toBeNull();
      // 树行文件 @ → @知识库[relPath@rootName]
      const fileAt = [...host.querySelectorAll(".kb-tree-at")].find((s) => s.getAttribute("title") === "@ 到对话") as HTMLElement;
      act(() => { fileAt.click(); });
      await flush();
      // 树行目录 @ → @知识库目录[path@rootName]
      const dirAt = host.querySelector(".kb-tree-dir .kb-tree-at") as HTMLElement;
      act(() => { dirAt.click(); });
      await flush();
      // 返回按钮计数文案
      const backBtn = buttonByTitle("返回主工作区");
      expect(backBtn.textContent).toContain("@2项");
      // 打开文档后右栏 @ 按钮出现并累积第三个
      await openDocA();
      act(() => { (host.querySelector(".kb-at-btn") as HTMLButtonElement).click(); });
      await flush();
      expect(backBtn.textContent).toContain("@3项");
      // 退出 → onExit 按序传出
      act(() => { backBtn.click(); });
      expect(props.onExit).toHaveBeenCalledWith([
        "@知识库[a.md@kb1]",
        "@知识库目录[sub@kb1]",
        "@知识库[a.md@kb1]"
      ]);
    } finally { unmount(); }
  });

  it("K7 导出 Word：成功 notifySuccess；失败 notifyError 带原因", async () => {
    try {
      mount(<KnowledgeBase {...(kbProps() as any)} />);
      await flush(4);
      await openDocA();
      const exportBtn = buttonByTitle("导出为 Word 文档");
      act(() => { exportBtn.click(); });
      await flush(2);
      expect(kbExportDocxMock).toHaveBeenCalledWith("a.md", 0);
      expect(notifySuccessMock).toHaveBeenCalledWith("已导出：文档A.docx（保存到工作区）");
      // 失败分支
      kbExportDocxMock.mockRejectedValueOnce(new Error("boom"));
      act(() => { exportBtn.click(); });
      await flush(2);
      expect(notifyErrorMock).toHaveBeenCalledWith("导出失败: boom");
    } finally { unmount(); }
  });
});

/* ==================== K8/K9. 根目录管理 ==================== */

describe("根目录管理", () => {
  it("K8 添加根：window.prompt → kbAddRoot → kbStatus 重拉 → loadRoot(新根索引)", async () => {
    try {
      const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("D:/newkb");
      kbStatusMock.mockResolvedValueOnce({ roots: ROOTS, fileCount: 2, imaSkillDir: "" } as never)
        .mockResolvedValue({ roots: ROOTS_AFTER_ADD, fileCount: 3, imaSkillDir: "" } as never);
      kbAddRootMock.mockResolvedValue({ ok: true } as never);
      mount(<KnowledgeBase {...(kbProps() as any)} />);
      await flush(4);
      act(() => { (host.querySelector('button[aria-label="添加知识库根目录"]') as HTMLButtonElement).click(); });
      await flush(4);
      expect(promptSpy).toHaveBeenCalled();
      expect(kbAddRootMock).toHaveBeenCalledWith("D:/newkb");
      // 状态重拉 + 切到新根
      expect(kbStatusMock).toHaveBeenCalledTimes(2);
      expect(kbTreeMock).toHaveBeenLastCalledWith(2);
      promptSpy.mockRestore();
    } finally { unmount(); }
  });

  it("K9 移除根：askConfirm 确认 → kbRemoveRoot(当前根 path) → 重拉 loadRoot(0)；取消则不发起", async () => {
    try {
      kbStatusMock.mockResolvedValueOnce({ roots: ROOTS, fileCount: 2, imaSkillDir: "" } as never)
        .mockResolvedValue({ roots: ROOTS_AFTER_REMOVE, fileCount: 1, imaSkillDir: "" } as never);
      kbRemoveRootMock.mockResolvedValue({ ok: true } as never);
      mount(<KnowledgeBase {...(kbProps() as any)} />);
      await flush(4);
      const removeBtn = host.querySelector('button[aria-label="移除当前根目录"]') as HTMLButtonElement;
      expect(removeBtn).toBeTruthy(); // roots.length > 1 才渲染
      // 取消分支：不发起移除
      askConfirmMock.mockResolvedValueOnce(false);
      act(() => { removeBtn.click(); });
      await flush(2);
      expect(kbRemoveRootMock).not.toHaveBeenCalled();
      // 确认分支
      askConfirmMock.mockResolvedValueOnce(true);
      act(() => { removeBtn.click(); });
      await flush(4);
      expect(askConfirmMock).toHaveBeenCalledWith("移除根目录「kb1」？（仅移出索引，不删除文件）");
      expect(kbRemoveRootMock).toHaveBeenCalledWith("D:/kb1");
      expect(kbStatusMock).toHaveBeenCalledTimes(2);
      expect(kbTreeMock).toHaveBeenLastCalledWith(0);
    } finally { unmount(); }
  });
});

/* ==================== K10. 只读 Chat 抽屉 ==================== */

describe("只读 Chat 抽屉", () => {
  it("K10 Chat 按钮 → RetrievalChat 分发 scope/contextLabel/references；onPromoteToAgent 透传", async () => {
    try {
      const props = kbProps();
      mount(<KnowledgeBase {...(props as any)} />);
      await flush(4);
      act(() => { buttonByTitle("打开知识库只读 Chat").click(); });
      await flush();
      const chat = stubs.chatProps.current!;
      expect(chat).toBeTruthy();
      expect(chat.scope).toBe("knowledge");
      expect(chat.title).toBe("知识库 Chat");
      expect(chat.clientId).toBe("c1");
      expect(chat.workspace).toBe("ws1");
      expect(chat.contextLabel).toBe("kb1"); // 未选中文档 → 仅根名
      expect(String(chat.contextText)).toContain("当前未选中文档");
      expect(chat.references).toEqual([]);
      // 转交 Agent：透传宿主回调
      act(() => { (chat.onPromoteToAgent as (p: Record<string, unknown>) => void)({ text: "转 Agent" }); });
      expect(props.onPromoteToAgent).toHaveBeenCalledWith({ text: "转 Agent" });
      // 关闭抽屉（轻桩 box 不随卸载置空，以 DOM 消失为准）
      act(() => { (chat.onClose as () => void)(); });
      await flush();
      expect(host.querySelector('[data-testid="retrieval-chat-stub"]')).toBeNull();
    } finally { unmount(); }
  });
});
