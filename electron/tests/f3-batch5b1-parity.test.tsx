// @vitest-environment jsdom
/**
 * F3 批5b-1 对拍：SessionSidebar 纯函数族（lib/session-list）+ SessionList 组件。
 *
 * 对拍口径：
 *   - 纯函数：旧实现为 SessionSidebar.jsx 模块私有函数，无法直接 import —— 采用
 *     「TS 侧绝对锚点断言 + 组件 DOM 双侧间接覆盖」：formatTime/shortenCwd/
 *     groupByDate/togglePin 的行为全部体现在 SessionList 渲染与交互落盘里，
 *     由组件逐字节对拍兜底；TS 侧另加档位/归一化矩阵的绝对锚点；
 *   - SessionList：双侧同挂载（旧 client 组件树 / 新 electron 组件树），DOM
 *     outerHTML 逐字节一致；交互（搜索/筛选/重命名/置顶/冻结/分支/删除/批量删除）
 *     回调调用序列与 localStorage 落盘一致。askConfirm 两侧同走 window.confirm
 *     （feedbackV2 默认关），stub 同值同流。
 *
 * 时间稳定化：测试数据 modified 取 now-30s（"刚刚"）、now-25h（"1天前"+昨天组）、
 * now-3d（"3天前"+更早组），同档位内两侧渲染间隔毫秒级不跨档。
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const SessionListTs = (await import("../src/renderer/components/SessionList")).SessionList;
const SessionListJs = (await import("../../client/src/components/SessionSidebar.jsx")).SessionList;
const sessionListLib = await import("../src/renderer/lib/session-list");

const PIN_KEY = "oaw_pinned_sessions";

const NOW = Date.now();
const T_JUST = new Date(NOW - 30 * 1000).toISOString();
const T_YDAY = new Date(NOW - 25 * 3600 * 1000).toISOString();
const T_OLD = new Date(NOW - 3 * 24 * 3600 * 1000).toISOString();

interface CallLog { calls: unknown[]; push: (...args: unknown[]) => void }

function makeLog(): CallLog {
  const calls: unknown[] = [];
  return { calls, push: (...args: unknown[]) => { calls.push(args); } };
}

const SAMPLE_SESSIONS = [
  { id: "s1", title: "运行中的会话", runStatus: "running", mode: "chat", modified: T_JUST, threadId: "t1", cwd: "F:\\work\\docs\\plan" },
  { id: "s2", label: "已完成会话", runStatus: "completed", modified: T_YDAY, artifactCount: 3, threadId: "t2" },
  { id: "s3", title: "三天前的会话", runStatus: "idle", modified: T_OLD, cwd: "C:\\a" },
  { id: "s4", title: "置顶会话", pinned: true, runStatus: "idle", modified: T_JUST, threadId: "t4" },
  { id: "s5", title: "冻结分支", frozen: true, parentSessionId: "s1", branchPurpose: "试验", runStatus: "idle", modified: T_JUST },
  { id: "s6", title: "未读多的会话", runStatus: "idle", modified: T_JUST, threadId: "t6" },
];
const SAMPLE_UNREAD = { t1: 1, t6: 120 };

function stubMatchMedia(matches = false): void {
  (window as unknown as { matchMedia: unknown }).matchMedia = vi.fn(() => ({
    matches,
    addEventListener() {},
    removeEventListener() {},
  }));
}

function mount(node: React.ReactNode): { host: HTMLElement; unmount: () => void } {
  // 双侧 run 先后执行且共享同一 localStorage：挂载前清空，避免置顶状态串场
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

function setInputValue(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function click(el: Element | null | undefined): void {
  act(() => { el?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}

/** 排空微任务并让 async onClick 的后续 setState 在 act 内完成渲染 */
async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

function hover(el: Element | null | undefined): void {
  // React 的 onMouseEnter 由原生 mouseover 派生（委托在 root 上）
  act(() => { el?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); });
}

afterEach(() => {
  localStorage.clear();
  document.body.innerHTML = "";
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 第一部分：纯函数锚点（旧函数模块私有，绝对锚点 + 组件间接覆盖）
// ---------------------------------------------------------------------------

describe("session-list 纯函数锚点（绝对断言）", () => {
  it("RUNNING_SESSION_STATUSES：五个运行态", () => {
    expect([...sessionListLib.RUNNING_SESSION_STATUSES]).toEqual(["running", "queued", "waiting_user", "recovering", "cancel_requested"]);
  });

  it("sameWorkspacePath/samePath：分隔符/大小写/尾斜杠/空值归一化", () => {
    const { sameWorkspacePath, samePath } = sessionListLib;
    expect(sameWorkspacePath("F:\\work\\docs", "f:/work/docs")).toBe(true);
    expect(sameWorkspacePath("F:\\work\\docs\\", "F:/work/docs")).toBe(true);
    expect(sameWorkspacePath("F:\\work\\docs", "F:\\work\\other")).toBe(false);
    expect(sameWorkspacePath("", "F:\\work")).toBe(false);
    expect(sameWorkspacePath(undefined, null)).toBe(false);
    // 盘符冒号参与比较：c:/a/b ≠ c/a/b（与原始 JS 归一化一致）
    expect(samePath("C:\\A\\B", "c:/a/b")).toBe(true);
    expect(samePath("C:\\A\\B", "c/a/b")).toBe(false);
  });

  it("formatTime 档位锚点", () => {
    const { formatTime } = sessionListLib;
    expect(formatTime("")).toBe("");
    expect(formatTime(new Date(NOW - 30 * 1000).toISOString())).toBe("刚刚");
    expect(formatTime(new Date(NOW - 5 * 60 * 1000).toISOString())).toBe("5分钟前");
    expect(formatTime(new Date(NOW - 3 * 3600 * 1000).toISOString())).toBe("3小时前");
    expect(formatTime(new Date(NOW - 5 * 24 * 3600 * 1000).toISOString())).toBe("5天前");
  });

  it("formatRelTime：毫秒时间戳转发；空值空串", () => {
    const { formatRelTime } = sessionListLib;
    expect(formatRelTime(0)).toBe("");
    expect(formatRelTime(undefined)).toBe("");
    expect(formatRelTime(NOW - 30 * 1000)).toBe("刚刚");
  });

  it("shortenCwd：≤2 段原样；>2 段省略前缀", () => {
    const { shortenCwd } = sessionListLib;
    expect(shortenCwd("")).toBe("");
    expect(shortenCwd("C:\\a")).toBe("C:\\a");
    // 3 段即缩略（C: 也算一段，与原始 JS 一致）
    expect(shortenCwd("C:\\a\\b")).toBe("…/a/b");
    expect(shortenCwd("F:\\work\\docs\\plan")).toBe("…/docs/plan");
    expect(shortenCwd("/home/user/proj/x")).toBe("…/proj/x");
  });

  it("formatSize：B/KB/MB 档位；空值空串", () => {
    const { formatSize } = sessionListLib;
    expect(formatSize(undefined)).toBe("");
    expect(formatSize(null)).toBe("");
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(2048)).toBe("2.0 KB");
    expect(formatSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });

  it("groupByDate：今天/昨天/更早分组顺序 + 空组剔除", () => {
    const { groupByDate } = sessionListLib;
    const sessions = [
      { id: "a", modified: T_JUST },
      { id: "b", modified: T_OLD },
      { id: "c", modified: T_YDAY },
      { id: "d", modified: T_JUST },
    ];
    const groups = groupByDate(sessions);
    expect(groups.map(([label]) => label)).toEqual(["今天", "昨天", "更早"]);
    expect(groups[0]?.[1].map((s) => s.id)).toEqual(["a", "d"]);
    expect(groups[1]?.[1].map((s) => s.id)).toEqual(["c"]);
    expect(groups[2]?.[1].map((s) => s.id)).toEqual(["b"]);
    // 空组剔除：只有今天
    expect(groupByDate([{ id: "x", modified: T_JUST }]).map(([label]) => label)).toEqual(["今天"]);
  });

  it("getPinnedSet/togglePin：localStorage 落盘序列", () => {
    const { getPinnedSet, togglePin, PIN_KEY: KEY } = sessionListLib;
    expect(KEY).toBe(PIN_KEY);
    expect(getPinnedSet()).toEqual(new Set());
    expect(togglePin("a")).toEqual(new Set(["a"]));
    expect(togglePin("b")).toEqual(new Set(["a", "b"]));
    expect(togglePin("a")).toEqual(new Set(["b"]));
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toEqual(["b"]);
    // 损坏 JSON 回退空集
    localStorage.setItem(KEY, "{oops");
    expect(getPinnedSet()).toEqual(new Set());
  });
});

// ---------------------------------------------------------------------------
// 第二部分：SessionList 组件双侧对拍
// ---------------------------------------------------------------------------

describe("SessionList TS 版与 client SessionSidebar.SessionList 等价", () => {
  /** 顺序单挂载（双 root 同时挂载在 act 环境下表现不稳定）；保持挂载态返回 host，由用例自行交互与卸载 */
  function renderLive(Comp: React.ComponentType<any>): { host: HTMLElement; unmount: () => void } {
    const log = makeLog();
    const m = mount(
      <Comp
        sessions={SAMPLE_SESSIONS}
        unreadByThread={SAMPLE_UNREAD}
        onSelect={(s: unknown) => log.push("select", s)}
        onDelete={(id: unknown) => log.push("delete", id)}
        onBatchDelete={(ids: unknown) => log.push("batchDelete", ids)}
        onRename={(id: unknown, value: unknown) => log.push("rename", id, value)}
        onFork={(id: unknown, name: unknown) => log.push("fork", id, name)}
        onPin={(id: unknown, pinned: unknown) => log.push("pin", id, pinned)}
        onFreeze={(id: unknown, frozen: unknown) => log.push("freeze", id, frozen)}
      />
    );
    return { host: m.host, unmount: m.unmount };
  }

  it("初始渲染：置顶区/日期分组/运行态/冻结/分支/未读 99+/cwd/mode DOM 逐字节一致", () => {
    stubMatchMedia();
    const js = renderLive(SessionListJs);
    const ts = renderLive(SessionListTs);
    const jsHtml = js.host.innerHTML;
    const tsHtml = ts.host.innerHTML;

    expect(tsHtml).toBe(jsHtml);
    // 结构锚点：置顶分组在前、今天/昨天/更早随后
    const titles = [...ts.host.querySelectorAll<HTMLElement>(".session-group-title")].map((el) => (el.textContent ?? "").trim());
    if (titles.length === 0) console.log("[DEBUG] tsHtml:", tsHtml.slice(0, 800));
    expect(titles).toEqual(["置顶", "今天", "昨天", "更早"]);
    // 运行态标记与未读上限
    expect(tsHtml).toContain("is-running");
    expect(tsHtml).toContain("99+");
    expect(tsHtml).toContain("执行中");
    expect(tsHtml).toContain(" · 产物 3");
    // cwd 缩写与冻结/分支标记
    expect(tsHtml).toContain("…/docs/plan");
    expect(tsHtml).toContain("session-frozen-mark");
    expect(tsHtml).toContain("session-branch-mark");
    // Chat 模式标签
    expect(tsHtml).toContain("Chat");
    js.unmount();
    ts.unmount();
  });

  it("搜索过滤：输入关键词后仅剩匹配项，两侧一致", () => {
    stubMatchMedia();
    const js = renderLive(SessionListJs);
    const ts = renderLive(SessionListTs);
    for (const m of [js, ts]) {
      const input = m.host.querySelector<HTMLInputElement>(".session-search input");
      setInputValue(input!, "置顶");
    }
    const jsHtml = js.host.innerHTML;
    const tsHtml = ts.host.innerHTML;
    expect(tsHtml).toBe(jsHtml);
    expect([...ts.host.querySelectorAll(".session-item")]).toHaveLength(1);
    js.unmount();
    ts.unmount();
  });

  it("状态筛选：点击「执行中」仅显示 running 会话，两侧一致", () => {
    stubMatchMedia();
    const js = renderLive(SessionListJs);
    const ts = renderLive(SessionListTs);
    for (const m of [js, ts]) {
      const filter = [...m.host.querySelectorAll<HTMLButtonElement>(".session-filter")].find((b) => b.textContent === "执行中");
      click(filter);
    }
    const jsHtml = js.host.innerHTML;
    const tsHtml = ts.host.innerHTML;
    expect(tsHtml).toBe(jsHtml);
    expect([...ts.host.querySelectorAll(".session-item")]).toHaveLength(1);
    js.unmount();
    ts.unmount();
  });

  it("双击重命名：进入编辑态 → Enter 提交 onRename 序列一致；Escape 取消", async () => {
    stubMatchMedia();
    const run = async (Comp: React.ComponentType<any>) => {
      const log = makeLog();
      const m = mount(
        <Comp
          sessions={SAMPLE_SESSIONS}
          unreadByThread={{}}
          onSelect={() => {}}
          onDelete={() => {}}
          onRename={(id: unknown, value: unknown) => log.push("rename", id, value)}
        />
      );
      // DOM 顺序：置顶组在前 → 第一个 idle item 是 s4（置顶会话）
      const label = m.host.querySelector<HTMLElement>('[data-status="idle"]')?.closest(".session-item")?.querySelector<HTMLElement>(".session-label");
      act(() => { label?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
      const input = m.host.querySelector<HTMLInputElement>(".rename-input");
      if (input) {
        setInputValue(input, "新名字");
        act(() => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
        await flush();
      }
      const renamed = [...log.calls];
      // 再进编辑态后 Escape 取消（同步 setState）
      const label2 = m.host.querySelector<HTMLElement>('[data-status="idle"]')?.closest(".session-item")?.querySelector<HTMLElement>(".session-label");
      act(() => { label2?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
      const input2 = m.host.querySelector<HTMLInputElement>(".rename-input");
      if (input2) act(() => { input2.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
      const editingGone = !m.host.querySelector(".rename-input");
      m.unmount();
      return { renamed, editingGone };
    };
    const js = await run(SessionListJs);
    const ts = await run(SessionListTs);
    expect(ts.renamed).toEqual(js.renamed);
    expect(ts.renamed[0]).toEqual(["rename", "s4", "新名字"]);
    expect(ts.editingGone).toBe(js.editingGone);
    expect(ts.editingGone).toBe(true);
  });

  it("hover 动作条：置顶（onPin+落盘）/冻结/分支/删除（confirm 后 onDelete）调用序列一致", async () => {
    stubMatchMedia();
    (window as unknown as { confirm: unknown }).confirm = vi.fn(() => true);
    const run = async (Comp: React.ComponentType<any>) => {
      const log = makeLog();
      const m = mount(
        <Comp
          sessions={SAMPLE_SESSIONS}
          unreadByThread={{}}
          onSelect={() => {}}
          onDelete={(id: unknown) => log.push("delete", id)}
          onRename={() => {}}
          onFork={(id: unknown, name: unknown) => log.push("fork", id, name)}
          onPin={(id: unknown, pinned: unknown) => log.push("pin", id, pinned)}
          onFreeze={(id: unknown, frozen: unknown) => log.push("freeze", id, frozen)}
        />
      );
      // DOM 顺序：置顶组在前 → 第一个 item 是 s4（pinned: true）
      const firstItem = m.host.querySelector<HTMLElement>(".session-item");
      hover(firstItem);
      const actions = firstItem?.querySelectorAll<HTMLButtonElement>(".session-actions .btn-icon");
      // 顺序：置顶/重命名/分支/冻结/删除
      click(actions?.[0]);
      await flush();
      click(actions?.[2]);
      click(actions?.[3]);
      click(actions?.[4]);
      await flush();
      const before = [...log.calls];
      const pins = JSON.parse(localStorage.getItem(PIN_KEY) ?? "null");
      m.unmount();
      return { calls: before, pins };
    };
    const js = await run(SessionListJs);
    const ts = await run(SessionListTs);
    expect(ts.calls).toEqual(js.calls);
    expect(ts.pins).toEqual(js.pins);
    // s4 已置顶 → 再点置顶 = 取消置顶
    expect(ts.calls[0]).toEqual(["pin", "s4", false]);
    expect(ts.calls[1]).toEqual(["fork", "s4", "置顶会话（分支）"]);
    expect(ts.calls[2]).toEqual(["freeze", "s4", true]);
    expect(ts.calls[3]).toEqual(["delete", "s4"]);
    expect(ts.pins).toEqual(["s4"]);
  });

  it("删除确认取消：confirm=false 时不调用 onDelete，两侧一致", async () => {
    stubMatchMedia();
    (window as unknown as { confirm: unknown }).confirm = vi.fn(() => false);
    const run = async (Comp: React.ComponentType<any>) => {
      const log = makeLog();
      const m = mount(
        <Comp
          sessions={SAMPLE_SESSIONS}
          unreadByThread={{}}
          onSelect={() => {}}
          onDelete={(id: unknown) => log.push("delete", id)}
          onRename={() => {}}
        />
      );
      const firstItem = m.host.querySelector<HTMLElement>(".session-item");
      hover(firstItem);
      click(firstItem?.querySelectorAll<HTMLButtonElement>(".session-actions .btn-icon")[4]);
      await flush();
      const calls = [...log.calls];
      m.unmount();
      return calls;
    };
    const js = await run(SessionListJs);
    const ts = await run(SessionListTs);
    expect(ts).toEqual(js);
    expect(ts).toEqual([]);
  });

  it("批量删除：选择会话 → 全选 → confirm 后 onBatchDelete 全部 id + 退出选择态", async () => {
    stubMatchMedia();
    (window as unknown as { confirm: unknown }).confirm = vi.fn(() => true);
    const run = async (Comp: React.ComponentType<any>) => {
      const log = makeLog();
      const m = mount(
        <Comp
          sessions={SAMPLE_SESSIONS}
          unreadByThread={{}}
          onSelect={() => {}}
          onDelete={() => {}}
          onBatchDelete={(ids: unknown) => log.push("batchDelete", ids)}
          onRename={() => {}}
        />
      );
      click(m.host.querySelector<HTMLButtonElement>(".session-batch-toggle"));
      click(m.host.querySelector<HTMLButtonElement>(".session-batch-toolbar button:nth-child(2)")); // 全选
      const badge = m.host.querySelector<HTMLButtonElement>(".session-batch-toolbar .danger")?.textContent;
      click(m.host.querySelector<HTMLButtonElement>(".session-batch-toolbar .danger"));
      await flush();
      const calls = [...log.calls];
      const stillSelecting = !!m.host.querySelector(".session-select");
      m.unmount();
      return { calls, badge, stillSelecting };
    };
    const js = await run(SessionListJs);
    const ts = await run(SessionListTs);
    expect(ts.calls).toEqual(js.calls);
    expect(ts.badge).toBe(js.badge);
    expect(ts.stillSelecting).toBe(js.stillSelecting);
    const firstCall = ts.calls[0] as unknown[];
    expect(firstCall[0]).toBe("batchDelete");
    expect([...(firstCall[1] as string[])].sort()).toEqual(["s1", "s2", "s3", "s4", "s5", "s6"]);
    expect(ts.badge).toContain("批量删除（6）");
    expect(ts.stillSelecting).toBe(false);
  });
});
