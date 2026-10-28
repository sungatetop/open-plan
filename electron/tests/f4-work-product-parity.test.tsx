// @vitest-environment jsdom
/**
 * F4-2 对拍：WorkProductPanel（产物面板 ArtifactPanel + 改动面板 RunChangesPanel）
 * 与 FileChangesPanel（本轮文件改动 + 内容差异）逐行等价迁移。
 *
 * 形态（沿 F4-1 双侧同流基建）：
 *   - 旧侧 client/src/components/WorkArtifactPanel.jsx / FileChangesPanel.jsx（fetch api.js），
 *     新侧 features/tasks/work-product-panel.tsx / file-changes-panel.tsx
 *     （client-api.ts → IPC runs/artifacts/system 通道，S3-2 起直调）。
 *   - 双侧 API 层分别 vi.mock（保留原模块其余导出），同参数分送同一行为表，
 *     调用序列与全 DOM（innerHTML）逐字节比较。
 *
 * 场景：
 *   A ArtifactPanel 挂载空态 + listRuns/listPublishedArtifacts 请求参数逐字段一致
 *   B 产物矩阵（staged/unattributed/run-window/deleted 过滤 + acceptance 补充链 +
 *     publication 映射 + 正式版本区三种回滚态）全 DOM 一致
 *   C 动作链：人工确认（window.prompt）→ confirmArtifactAcceptance；固定成果 →
 *     publishArtifact；回滚 → rollbackPublishedArtifact；动作后 refresh 重拉
 *   D 读取失败自报家门（双 reject → loadError role=alert + 来源拼接）
 *   E FileChangesPanel 矩阵（added/modified/deleted/renamed/suspected/internal）+
 *     diff 展开/翻页（getRunChangeDiff page 参数）+ 文本/二进制两种 DiffView +
 *     打开三分支（onOpenFile 优先 / openInSystem / revealInSystem）
 *   F ArtifactPanel 联动：范围切换（本轮/会话 → onArtifactScopeChange）+
 *     产物打开三参（path, undefined, cwd）+ staged 不可点
 *   G RunChangesPanel 请求参数（includeEvents:"none" + signal 归一）+ 空态与列表态
 *   H WorkProductPanel 分发：children 透传 + tab="artifacts"/"changes" 对应面板
 *
 * 确定性：双侧共用同一行为表与 fixture；window.prompt 显式覆盖为固定返回值；
 * RunChangesPanel 15s abort 定时器在断言窗口内不触发，afterEach unmount 清理。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

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
  const out: Record<string, unknown> = { ...original };
  for (const method of ["listRuns", "getRun", "getRunAcceptance", "publishArtifact", "confirmArtifactAcceptance", "listPublishedArtifacts", "rollbackPublishedArtifact", "getRunChangeDiff", "openInSystem", "revealInSystem"]) out[method] = (...args: unknown[]) => { record("ts", method, args); return dispatch(method, args); };
  return out;
});

vi.mock("../../client/src/api.js", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  const out: Record<string, unknown> = { ...original };
  for (const method of ["listRuns", "getRun", "getRunAcceptance", "publishArtifact", "confirmArtifactAcceptance", "listPublishedArtifacts", "rollbackPublishedArtifact", "getRunChangeDiff", "openInSystem", "revealInSystem"]) out[method] = (...args: unknown[]) => { record("jsx", method, args); return dispatch(method, args); };
  return out;
});

import WorkProductPanelTs from "../src/renderer/features/tasks/work-product-panel";
import FileChangesPanelTs from "../src/renderer/features/tasks/file-changes-panel";

const clientWorkProductPanel = (await import("../../client/src/components/WorkArtifactPanel.jsx")).default;
const clientFileChangesPanel = (await import("../../client/src/components/FileChangesPanel.jsx")).default;

/* ------------------------------ fixture ------------------------------ */

const WORKSPACE = "D:/ws/parity";
const PROJECT_ID = "proj-1";
const SESSION_ID = "sess-1";

/** 产物矩阵：正常（验收通过可固定）/ staged 暂存 / 未归属线索 / run-window 待确认 /
 *  deleted 过滤 / 人工确认路径（passed 但 readyToPublish=false）/ 已固定映射。 */
const RUN_ARTIFACTS = [
  { artifactId: "a1", path: "out/a.docx", status: "ok" },
  { artifactId: "a2", path: "out/b.xlsx", status: "staged", source: "staged" },
  { artifactId: "a3", path: "out/c.txt", status: "ok", source: "unattributed" },
  { artifactId: "a4", path: "out/d.txt", status: "ok", source: "run-window" },
  { artifactId: "a5", path: "out/deleted.txt", status: "deleted" },
  { artifactId: "a7", path: "out/f.txt", status: "ok" },
  { artifactId: "a-pub", path: "out/pub.docx", status: "ok" },
];

const RUN_BASE = {
  id: "r1",
  status: "completed",
  sessionId: SESSION_ID,
  cwd: WORKSPACE,
  artifacts: RUN_ARTIFACTS,
  events: [],
};

const RUN_ACCEPTANCE = {
  run: {
    acceptance: {
      artifacts: [
        { path: "out/a.docx", status: "passed", readyToPublish: true },
        { path: "out/f.txt", status: "passed", readyToPublish: false },
      ],
    },
  },
};

/** 正式版本：可回滚（有上一版）/ 首版（无历史）/ 已回滚。 */
const PUBLISHED = [
  { id: "p1", artifactId: "a-pub", path: "out/pub.docx", version: 2, status: "published", rollbackTarget: "v1" },
  { id: "p2", artifactId: "a-x", path: "out/first.docx", version: 1, status: "published", rollbackTarget: null },
  { id: "p3", artifactId: "a-y", path: "out/rolled.docx", version: 1, status: "rolled_back" },
];

/** 改动矩阵：交付/支撑/疑似/内部 + 增删改名四态。 */
const CHANGES = [
  { changeId: "c1", relativePath: "docs/plan.md", changeType: "modified", role: "deliverable", confidence: "exact" },
  { changeId: "c2", relativePath: "out/new.md", changeType: "added", role: "deliverable" },
  { changeId: "c3", relativePath: "out/old.md", changeType: "deleted", role: "supporting" },
  { changeId: "c4", relativePath: "out/ren.md", changeType: "renamed", role: "supporting", confidence: "suspected" },
  { changeId: "c5", relativePath: "cache/tmp.bin", changeType: "modified", role: "internal" },
  { changeId: "c6", relativePath: "out/x.docx", changeType: "modified", role: "supporting" },
];

const TEXT_DIFF = {
  kind: "text",
  summary: { added: 3, removed: 1 },
  hunks: [
    {
      beforeStart: 1,
      afterStart: 1,
      ops: [
        { type: "context", beforeLine: 1, text: "行一" },
        { type: "delete", beforeLine: 2, text: "旧行" },
        { type: "insert", afterLine: 2, text: "新行" },
      ],
    },
  ],
  pageCount: 2,
};

const OFFICE_DIFF = {
  kind: "office",
  summary: { beforeSize: 100, afterSize: 150, sizeDelta: 50, hashChanged: true },
  note: "二进制差异",
};

const ARTIFACT_DEFAULT_PROPS = {
  workspace: WORKSPACE,
  projectId: PROJECT_ID,
  currentSessionId: SESSION_ID,
  refreshToken: 0,
};

const CHANGES_DEFAULT_PROPS = {
  runId: "run-1",
  detection: { truncated: false },
};

/* ------------------------------ 挂载与驱动基建 ------------------------------ */

type Host = { container: HTMLElement; root: Root };
type Pair = [Host, Host];

async function mountComp(Comp: unknown, props: Record<string, unknown>, side: "ts" | "jsx"): Promise<Host> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  // on* 回调统一侧别打标：同参数分送原实现，调用记录进对应侧桶
  const wrapped: Record<string, unknown> = { ...props };
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith("on") && typeof value === "function") {
      const fn = value as (...a: unknown[]) => unknown;
      wrapped[key] = (...args: unknown[]) => { record(side, key, args); return fn(...args); };
    }
  }
  await act(async () => {
    root.render(React.createElement(Comp as (p: Record<string, unknown>) => React.ReactElement, wrapped));
  });
  return { container, root };
}

async function mountPair(CompTs: unknown, CompJsx: unknown, props: Record<string, unknown> = {}): Promise<Pair> {
  return [await mountComp(CompTs, props, "ts"), await mountComp(CompJsx, props, "jsx")];
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

async function clickButton(host: Host, text: string): Promise<void> {
  const buttons = [...host.container.querySelectorAll("button")];
  const btn = buttons.find((b) => (b.textContent || "").includes(text));
  if (!btn) throw new Error(`未找到按钮: ${text}`);
  await act(async () => { btn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await act(async () => { await flushApi(); });
}

/** 行内点击：在第 relativePath 行内找文本匹配按钮（打开/显示按钮逐行重复，需按行定位）。 */
async function clickInRow(host: Host, relativePath: string, text: string): Promise<void> {
  const rows = [...host.container.querySelectorAll(".file-change-row")];
  const row = rows.find((r) => (r.textContent || "").includes(relativePath));
  if (!row) throw new Error(`未找到改动行: ${relativePath}`);
  const btn = [...row.querySelectorAll("button")].find((b) => (b.textContent || "").includes(text));
  if (!btn) throw new Error(`行内未找到按钮: ${text}`);
  await act(async () => { btn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await act(async () => { await flushApi(); });
}

function recorded(side: "ts" | "jsx", method: string): unknown[][] {
  return h.calls[side][method] || [];
}

/** 归一化 AbortSignal 实例（双侧各自 new，实例不等但语义等价）为占位标记。 */
function stripSignal(args: unknown[] | undefined): unknown[] {
  return (args || []).map((arg) => {
    if (arg && typeof arg === "object" && "signal" in (arg as Record<string, unknown>)) {
      const { signal: _signal, ...rest } = arg as Record<string, unknown>;
      void _signal;
      return { ...rest, signal: "«signal»" };
    }
    return arg;
  });
}

/* ------------------------------ 用例 ------------------------------ */

describe("F4-2 产物面板/改动面板 双侧同流对拍（TS ↔ client JSX）", () => {
  beforeEach(() => {
    h.calls.ts = {};
    h.calls.jsx = {};
    h.behaviors.listRuns = () => Promise.resolve({ runs: [] });
    h.behaviors.listPublishedArtifacts = () => Promise.resolve({ artifacts: [] });
    h.behaviors.getRunAcceptance = () => Promise.resolve({ run: null });
    h.behaviors.getRun = () => Promise.resolve({ run: null });
    h.behaviors.publishArtifact = () => Promise.resolve({ ok: true });
    h.behaviors.confirmArtifactAcceptance = () => Promise.resolve({ ok: true });
    h.behaviors.rollbackPublishedArtifact = () => Promise.resolve({ ok: true });
    // 文本 diff（c1/c2/...）与二进制 diff（c6）按 changeId 分流
    h.behaviors.getRunChangeDiff = (_runId: unknown, changeId: unknown) => (changeId === "c6"
      ? Promise.resolve({ diff: OFFICE_DIFF, limits: {} })
      : Promise.resolve({ diff: TEXT_DIFF, limits: { maxInputBytes: 65536 } }));
    h.behaviors.openInSystem = () => Promise.resolve({ ok: true });
    h.behaviors.revealInSystem = () => Promise.resolve({ ok: true });
    // 人工确认说明弹窗：jsdom 无实现，双侧共用同一固定返回值保证同流
    window.prompt = () => "已检查内容、格式和页面显示";
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

  it("A ArtifactPanel 挂载空态：文案与 listRuns/listPublishedArtifacts 请求参数逐字段一致", async () => {
    pair = await mountPair(WorkProductPanelTs, clientWorkProductPanel, { ...ARTIFACT_DEFAULT_PROPS, tab: "artifacts" });
    await settle(pair);
    expect(pair[0].container.innerHTML).toBe(pair[1].container.innerHTML);
    expect(pair[0].container.textContent).toContain("当前会话暂未生成产物");
    expect(pair[0].container.textContent).toContain("会话文件");
    expect(pair[0].container.textContent).toContain("产物验收与固定");
    // 请求参数：listRuns("", 100, { cwd, projectId })；listPublishedArtifacts(workspace, projectId)
    expect(recorded("ts", "listRuns").length).toBeGreaterThan(0);
    expect(recorded("jsx", "listRuns")).toEqual(recorded("ts", "listRuns"));
    expect(recorded("ts", "listRuns")[0]).toEqual(["", 100, { cwd: WORKSPACE, projectId: PROJECT_ID }]);
    expect(recorded("jsx", "listPublishedArtifacts")).toEqual(recorded("ts", "listPublishedArtifacts"));
    expect(recorded("ts", "listPublishedArtifacts")[0]).toEqual([WORKSPACE, PROJECT_ID]);
  });

  it("B 产物矩阵：源标签/验收双源/固定映射/正式版本三态全 DOM 一致", async () => {
    h.behaviors.listRuns = () => Promise.resolve({ runs: [{ ...RUN_BASE }] });
    h.behaviors.getRunAcceptance = () => Promise.resolve({ ...RUN_ACCEPTANCE });
    h.behaviors.listPublishedArtifacts = () => Promise.resolve({ artifacts: PUBLISHED.map((item) => ({ ...item })) });
    pair = await mountPair(WorkProductPanelTs, clientWorkProductPanel, { ...ARTIFACT_DEFAULT_PROPS, tab: "artifacts" });
    await settle(pair);
    expect(pair[0].container.innerHTML).toBe(pair[1].container.innerHTML);
    // 汇总：6 条可见（deleted 过滤）/ 待固定 1（a1）/ 正式版本 3
    expect(pair[0].container.textContent).toContain("任务中暂存");
    expect(pair[0].container.textContent).toContain("未归属线索");
    expect(pair[0].container.textContent).toContain("待确认");
    expect(pair[0].container.textContent).toContain("v2 已固定");
    expect(pair[0].container.textContent).toContain("待固定");
    expect(pair[0].container.textContent).toContain("已完成 · out");
    // 产物主列表不渲染 deleted 条目（deleted.txt 只出现在 projectRunView 改动卡里）
    // 7 条 - 1 deleted 过滤 - 1 staged（span 不可点）= 5 个主按钮 + 1 个 span
    const mainRowsB = [...pair[0].container.querySelectorAll(".preview-artifact-main")];
    expect(mainRowsB.filter((el) => el.tagName === "BUTTON").length).toBe(5);
    expect(mainRowsB.filter((el) => el.tagName === "SPAN").length).toBe(1);
    expect(pair[0].container.textContent).toContain("可回滚 1 个（回到上一正式版本）");
    expect(pair[0].container.textContent).toContain("首个版本 · 无历史版本可回滚");
    expect(pair[0].container.textContent).toContain("已回滚");
    // 动作按钮存在
    const tsButtons = [...pair[0].container.querySelectorAll("button")].map((b) => b.textContent || "");
    expect(tsButtons.some((t) => t.includes("固定成果"))).toBe(true);
    expect(tsButtons.some((t) => t.includes("人工确认"))).toBe(true);
    expect(tsButtons.some((t) => t.includes("回滚"))).toBe(true);
  });

  it("C 动作链：人工确认(prompt 固定说明)→accept / 固定→publish / 回滚→rollback，动作后 refresh 重拉", async () => {
    h.behaviors.listRuns = () => Promise.resolve({ runs: [{ ...RUN_BASE }] });
    h.behaviors.getRunAcceptance = () => Promise.resolve({ ...RUN_ACCEPTANCE });
    h.behaviors.listPublishedArtifacts = () => Promise.resolve({ artifacts: PUBLISHED.map((item) => ({ ...item })) });
    pair = await mountPair(WorkProductPanelTs, clientWorkProductPanel, { ...ARTIFACT_DEFAULT_PROPS, tab: "artifacts" });
    await settle(pair);
    await clickButton(pair[0], "人工确认");
    await clickButton(pair[1], "人工确认");
    expect(recorded("jsx", "confirmArtifactAcceptance")).toEqual(recorded("ts", "confirmArtifactAcceptance"));
    expect(recorded("ts", "confirmArtifactAcceptance")[0]).toEqual(["r1", "a7", "已检查内容、格式和页面显示"]);
    await clickButton(pair[0], "固定成果");
    await clickButton(pair[1], "固定成果");
    expect(recorded("jsx", "publishArtifact")).toEqual(recorded("ts", "publishArtifact"));
    expect(recorded("ts", "publishArtifact")[0]).toEqual(["r1", "a1"]);
    await clickButton(pair[0], "回滚");
    await clickButton(pair[1], "回滚");
    expect(recorded("jsx", "rollbackPublishedArtifact")).toEqual(recorded("ts", "rollbackPublishedArtifact"));
    expect(recorded("ts", "rollbackPublishedArtifact")[0]).toEqual(["p1"]);
    // 动作完成后 refresh 重拉（listRuns 再增）
    expect(recorded("ts", "listRuns").length).toBeGreaterThanOrEqual(4);
    expect(recorded("jsx", "listRuns").length).toBe(recorded("ts", "listRuns").length);
  });

  it("D 读取失败自报家门：双 reject → loadError(role=alert) 来源拼接 + 重试入口", async () => {
    h.behaviors.listRuns = () => Promise.reject(new Error("网络中断"));
    h.behaviors.listPublishedArtifacts = () => Promise.reject(new Error("读取超时"));
    pair = await mountPair(WorkProductPanelTs, clientWorkProductPanel, { ...ARTIFACT_DEFAULT_PROPS, tab: "artifacts" });
    await settle(pair);
    expect(pair[0].container.innerHTML).toBe(pair[1].container.innerHTML);
    const alert = pair[0].container.querySelector(".artifact-load-error");
    expect(alert).not.toBeNull();
    expect(alert?.getAttribute("role")).toBe("alert");
    expect(pair[0].container.textContent).toContain("读取失败（运行记录、已发布成果）：运行记录：网络中断；已发布成果：读取超时");
    expect(pair[0].container.textContent).toContain("重试");
  });

  it("E FileChangesPanel：矩阵标签/文本 diff 展开+翻页/二进制摘要/打开三分支一致", async () => {
    pair = await mountPair(FileChangesPanelTs, clientFileChangesPanel, { ...CHANGES_DEFAULT_PROPS, changes: CHANGES.map((c) => ({ ...c })) });
    expect(pair[0].container.innerHTML).toBe(pair[1].container.innerHTML);
    expect(pair[0].container.textContent).toContain("本轮文件改动 （6）");
    expect(pair[0].container.textContent).toContain("删除 1");
    expect(pair[0].container.textContent).toContain("疑似 1");
    expect(pair[0].container.textContent).toContain("显示内部文件（1）");
    // 内部文件默认折叠
    expect(pair[0].container.textContent).not.toContain("cache/tmp.bin");
    // 文本 diff 展开 + 翻页
    await clickInRow(pair[0], "docs/plan.md", "docs/plan.md");
    await clickInRow(pair[1], "docs/plan.md", "docs/plan.md");
    expect(recorded("jsx", "getRunChangeDiff")).toEqual(recorded("ts", "getRunChangeDiff"));
    expect(recorded("ts", "getRunChangeDiff")[0]).toEqual(["run-1", "c1", 0]);
    expect(pair[0].container.textContent).toContain("+3 行");
    expect(pair[0].container.textContent).toContain("-1 行");
    expect(pair[0].container.textContent).toContain("@@ -1 +1 @@");
    expect(pair[0].container.textContent).toContain("旧行");
    expect(pair[0].container.textContent).toContain("新行");
    expect(pair[0].container.textContent).toContain("第 1/2 页");
    await clickInRow(pair[0], "docs/plan.md", "下一页");
    await clickInRow(pair[1], "docs/plan.md", "下一页");
    expect(recorded("ts", "getRunChangeDiff")[1]).toEqual(["run-1", "c1", 1]);
    // 二进制摘要（无 onOpenFile → 打开走 openInSystem）
    await clickInRow(pair[0], "out/x.docx", "out/x.docx");
    await clickInRow(pair[1], "out/x.docx", "out/x.docx");
    expect(pair[0].container.textContent).toContain("100 → 150 字节（+50）");
    expect(pair[0].container.textContent).toContain("内容哈希已变化");
    expect(pair[0].container.textContent).toContain("二进制差异");
    // 打开/显示：无 onOpenFile → openInSystem / revealInSystem
    await clickInRow(pair[0], "out/new.md", "打开");
    await clickInRow(pair[1], "out/new.md", "打开");
    expect(recorded("jsx", "openInSystem")).toEqual(recorded("ts", "openInSystem"));
    expect(recorded("ts", "openInSystem")[0]).toEqual(["out/new.md"]);
    // 显示（reveal）按钮为纯图标（title 定位，无文本），双侧直接按 title 点击
    for (const host of pair) {
      const rows = [...host.container.querySelectorAll(".file-change-row")];
      const row = rows.find((r) => (r.textContent || "").includes("out/new.md"));
      const btn = [...row!.querySelectorAll("button")].find((b) => b.getAttribute("title") === "在文件管理器中显示");
      await act(async () => { btn!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
      await act(async () => { await flushApi(); });
    }
    expect(recorded("jsx", "revealInSystem")).toEqual(recorded("ts", "revealInSystem"));
    expect(recorded("ts", "revealInSystem")[0]).toEqual(["out/new.md"]);
    // 带内部文件的展开态全 DOM 一致
    await clickButton(pair[0], "显示内部文件");
    await clickButton(pair[1], "显示内部文件");
    expect(pair[0].container.textContent).toContain("cache/tmp.bin");
    expect(pair[0].container.innerHTML).toBe(pair[1].container.innerHTML);
  });

  it("E2 FileChangesPanel onOpenFile 优先：打开走回调不走系统", async () => {
    pair = await mountPair(FileChangesPanelTs, clientFileChangesPanel, {
      ...CHANGES_DEFAULT_PROPS,
      changes: CHANGES.map((c) => ({ ...c })),
      onOpenFile: () => {},
    });
    await clickInRow(pair[0], "out/new.md", "打开");
    await clickInRow(pair[1], "out/new.md", "打开");
    expect(recorded("jsx", "openInSystem").length).toBe(0);
    expect(recorded("jsx", "onOpenFile")).toEqual(recorded("ts", "onOpenFile"));
    expect(recorded("ts", "onOpenFile")[0]).toEqual(["out/new.md"]);
  });

  it("F ArtifactPanel 联动：范围切换 onArtifactScopeChange + 打开三参 + staged 不可点", async () => {
    h.behaviors.listRuns = () => Promise.resolve({ runs: [{ ...RUN_BASE }] });
    h.behaviors.getRunAcceptance = () => Promise.resolve({ ...RUN_ACCEPTANCE });
    pair = await mountPair(WorkProductPanelTs, clientWorkProductPanel, {
      ...ARTIFACT_DEFAULT_PROPS,
      tab: "artifacts",
      onArtifactScopeChange: () => {},
      onOpenFile: () => {},
    });
    await settle(pair);
    await clickButton(pair[0], "本轮");
    await clickButton(pair[1], "本轮");
    expect(recorded("jsx", "onArtifactScopeChange")).toEqual(recorded("ts", "onArtifactScopeChange"));
    expect(recorded("ts", "onArtifactScopeChange")[0]).toEqual(["run"]);
    // 打开三参：产物主按钮 → onOpenFile(path, undefined, run.cwd)。
    // 改动卡行也有同名路径文本，用产物主按钮类名精确点击（首个 = a.docx）。
    for (const host of pair) {
      const main = [...host.container.querySelectorAll("button.preview-artifact-main")][0] as HTMLButtonElement;
      await act(async () => { main.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
      await act(async () => { await flushApi(); });
    }
    expect(recorded("ts", "onOpenFile")).toEqual(recorded("jsx", "onOpenFile"));
    expect(recorded("ts", "onOpenFile")[0]).toEqual(["out/a.docx", undefined, WORKSPACE]);
    // staged 条目是 span：7 条 - 1 deleted - 1 staged = 5 个主按钮 + 1 个 span
    const mainButtons = [...pair[0].container.querySelectorAll(".preview-artifact-main")];
    expect(mainButtons.filter((el) => el.tagName === "BUTTON").length).toBe(5);
    expect(mainButtons.filter((el) => el.tagName === "SPAN").length).toBe(1);
    expect(pair[0].container.innerHTML).toBe(pair[1].container.innerHTML);
  });

  it("G RunChangesPanel：请求参数(includeEvents=none, signal 归一)一致 + 空态/列表态", async () => {
    pair = await mountPair(WorkProductPanelTs, clientWorkProductPanel, {
      workspace: WORKSPACE,
      projectId: PROJECT_ID,
      currentSessionId: SESSION_ID,
      tab: "changes",
    });
    await settle(pair);
    expect(pair[0].container.innerHTML).toBe(pair[1].container.innerHTML);
    expect(pair[0].container.textContent).toContain("当前会话还没有捕获到文件改动（运行产生文件后才会记录）");
    expect(recorded("ts", "listRuns").length).toBeGreaterThan(0);
    expect(stripSignal(recorded("jsx", "listRuns")[0])).toEqual(stripSignal(recorded("ts", "listRuns")[0]));
    expect(stripSignal(recorded("ts", "listRuns")[0])).toEqual([
      "", 60,
      { cwd: WORKSPACE, projectId: PROJECT_ID, sessionId: SESSION_ID, includeEvents: "none", signal: "«signal»" },
    ]);
    expect(recorded("ts", "getRun").length).toBe(0);

    // 列表态：scoped run + getRun 补充 + FileChangesPanel 空改动
    await act(async () => { pair![0].root.unmount(); });
    await act(async () => { pair![1].root.unmount(); });
    pair[0].container.remove();
    pair[1].container.remove();
    h.calls.ts = {};
    h.calls.jsx = {};
    h.behaviors.listRuns = () => Promise.resolve({
      runs: [
        { id: "r9", status: "completed", sessionId: SESSION_ID, artifacts: [{ path: "x.txt" }] },
        { id: "r8", status: "completed", sessionId: "other", artifacts: [{ path: "y.txt" }] },
      ],
    });
    h.behaviors.getRun = () => Promise.resolve({ run: { ...RUN_BASE, id: "r9" } });
    pair = await mountPair(WorkProductPanelTs, clientWorkProductPanel, {
      workspace: WORKSPACE,
      projectId: PROJECT_ID,
      currentSessionId: SESSION_ID,
      tab: "changes",
    });
    await settle(pair);
    expect(pair[0].container.innerHTML).toBe(pair[1].container.innerHTML);
    expect(pair[0].container.textContent).toContain("本轮文件改动 （7）");
    expect(pair[0].container.textContent).toContain("out/a.docx");
    expect(stripSignal(recorded("ts", "getRun")[0])).toEqual(["r9", { signal: "«signal»" }]);
    expect(recorded("jsx", "getRun").length).toBe(recorded("ts", "getRun").length);
  });

  it("H WorkProductPanel 分发：children 透传 + artifacts/changes 页签对应面板", async () => {
    pair = await mountPair(WorkProductPanelTs, clientWorkProductPanel, { workspace: WORKSPACE, projectId: PROJECT_ID, currentSessionId: SESSION_ID, children: <div className="marker-children">预览占位</div> });
    expect(pair[0].container.innerHTML).toBe(pair[1].container.innerHTML);
    expect(pair[0].container.querySelector(".marker-children")).not.toBeNull();
    expect(pair[0].container.querySelector(".preview-artifact-panel")).toBeNull();

    await act(async () => { pair![0].root.unmount(); });
    await act(async () => { pair![1].root.unmount(); });
    pair[0].container.remove();
    pair[1].container.remove();
    pair = await mountPair(WorkProductPanelTs, clientWorkProductPanel, { ...ARTIFACT_DEFAULT_PROPS, tab: "artifacts" });
    expect(pair[0].container.querySelector(".preview-artifact-panel")).not.toBeNull();
    expect(pair[0].container.querySelector(".run-changes-workspace")).toBeNull();

    await act(async () => { pair![0].root.unmount(); });
    await act(async () => { pair![1].root.unmount(); });
    pair[0].container.remove();
    pair[1].container.remove();
    pair = await mountPair(WorkProductPanelTs, clientWorkProductPanel, { ...ARTIFACT_DEFAULT_PROPS, tab: "changes" });
    expect(pair[0].container.querySelector(".run-changes-workspace")).not.toBeNull();
    expect(pair[0].container.innerHTML).toBe(pair[1].container.innerHTML);
  });
});
