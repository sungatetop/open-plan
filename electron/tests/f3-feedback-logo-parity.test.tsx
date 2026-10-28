// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import LogoTs from "../src/renderer/components/Logo";
import FeedbackTsHost, {
  notifyError as notifyErrorTs,
  notifySuccess as notifySuccessTs,
  notifyWarn as notifyWarnTs,
  askConfirm as askConfirmTs,
} from "../src/renderer/components/Feedback";

const clientLogo = (await import("../../client/src/components/Logo.jsx")).default;
const clientFeedback = await import("../../client/src/components/Feedback.jsx");
const clientFlags = await import("../../client/src/feature-flags.js");
const tsFlags = await import("../src/renderer/lib/feature-flags");

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const LogoJsx = clientLogo as (props: Record<string, unknown>) => React.ReactElement;

function markupOf(el: React.ReactElement): string {
  return renderToStaticMarkup(el);
}

describe("Logo TS 版与 client Logo.jsx 渲染等价", () => {
  it("默认与多组 props 下 markup 逐字节一致", () => {
    const cases: Array<Record<string, unknown>> = [
      {},
      { size: 36 },
      { withGradient: false },
      { withBackground: false },
      { markColor: "#123456" },
      { className: "sidebar" },
      { size: 48, withGradient: false, withBackground: false, markColor: "currentColor", className: "x" },
    ];
    for (const props of cases) {
      expect(markupOf(React.createElement(LogoTs, props))).toBe(markupOf(React.createElement(LogJsxSafe, props)));
    }
  });
});

// client 版 JSX 组件 createElement 需要拿稳类型；包一层避免 TS 推断噪音
function LogJsxSafe(props: Record<string, unknown>): React.ReactElement {
  return LogoJsx(props) as React.ReactElement;
}

/* ---------------- Feedback 基线（feedbackV2 默认关 → 原生 alert/confirm） ---------------- */

describe("Feedback TS 版与 client Feedback.jsx 等价（flag 关：原生回退）", () => {
  let alerts: string[];
  let confirmCalls: string[];
  let confirmResult: boolean;
  const originalAlert = window.alert;
  const originalConfirm = window.confirm;

  beforeEach(() => {
    alerts = [];
    confirmCalls = [];
    confirmResult = true;
    window.alert = (msg?: string) => { alerts.push(String(msg)); };
    window.confirm = (msg?: string) => { confirmCalls.push(String(msg)); return confirmResult; };
  });

  afterEach(() => {
    window.alert = originalAlert;
    window.confirm = originalConfirm;
  });

  it("notify* 三族：message 归一化与 alert 调用序列等价", () => {
    const inputs: Array<[unknown, unknown, unknown]> = [
      ["文本", 42, null],
      [undefined, { a: 1 }, ""],
      ["第二波", undefined, "结束"],
    ];
    for (const [a, b, c] of inputs) {
      notifyErrorTs(a); clientFeedback.notifyError(a);
      notifySuccessTs(b); clientFeedback.notifySuccess(b);
      notifyWarnTs(c); clientFeedback.notifyWarn(c);
    }
    expect(alerts.length).toBe(18);
    // 交错调用下 TS 版与 client 版两两相邻，逐对相等
    for (let i = 0; i < alerts.length; i += 2) {
      expect(alerts[i]).toBe(alerts[i + 1]);
    }
  });

  it("askConfirm：confirm 调用与 Promise resolve 值等价（true/false 各一）", async () => {
    confirmResult = true;
    expect(await askConfirmTs("确定吗？")).toBe(await clientFeedback.askConfirm("确定吗？"));
    expect(confirmCalls).toEqual(["确定吗？", "确定吗？"]);
    confirmResult = false;
    expect(await askConfirmTs("取消吗？")).toBe(await clientFeedback.askConfirm("取消吗？"));
    expect(confirmCalls[confirmCalls.length - 1]).toBe("取消吗？");
  });

  it("非字符串 message 的 String(message ?? '') 口径等价", async () => {
    notifyErrorTs(undefined);
    clientFeedback.notifyError(undefined);
    notifyWarnTs(null);
    clientFeedback.notifyWarn(null);
    // null/undefined 经 ?? '' 归一为空串
    expect(alerts).toEqual(["", "", "", ""]);
    expect(await askConfirmTs(0)).toBe(await clientFeedback.askConfirm(0));
    expect(confirmCalls).toEqual(["0", "0"]);
  });
});

/* ---------------- Feedback 开启路径（feedbackV2 → 应用内 toast + 确认对话框） ---------------- */

let containerA: HTMLDivElement | null = null; // TS 版宿主
let containerB: HTMLDivElement | null = null; // client 版宿主
let rootA: Root | null = null;
let rootB: Root | null = null;

function mountHosts(): void {
  containerA = document.createElement("div");
  containerB = document.createElement("div");
  document.body.appendChild(containerA);
  document.body.appendChild(containerB);
  rootA = createRoot(containerA);
  rootB = createRoot(containerB);
  act(() => {
    rootA!.render(React.createElement(FeedbackTsHost));
    rootB!.render(React.createElement(clientFeedback.default));
  });
}

function unmountHosts(): void {
  act(() => {
    rootA?.unmount();
    rootB?.unmount();
  });
  containerA?.remove();
  containerB?.remove();
  containerA = containerB = null;
  rootA = rootB = null;
}

describe("Feedback TS 版与 client Feedback.jsx 等价（feedbackV2 开：toast/对话框）", () => {
  const originalFetch = globalThis.fetch;
  const originalAlert = window.alert;
  const originalConfirm = window.confirm;
  let alerts: string[];
  let confirmCalls: string[];

  beforeEach(async () => {
    alerts = [];
    confirmCalls = [];
    window.alert = (msg?: string) => { alerts.push(String(msg)); };
    window.confirm = (msg?: string) => { confirmCalls.push(String(msg)); return true; };
    // 双侧 flag 模块各自拉同一份 runtimeFlags 快照
    // （R6-1 起 TS 侧走 op:status:get 通道假桥，client 侧仍走 fetch）
    (window as unknown as Record<string, unknown>).opDesktop = {
      invoke: async (channel: string) =>
        channel === "op:status:get"
          ? { ok: true, status: 200, data: { runtimeFlags: { feedbackV2: true } } }
          : { ok: false, status: 404, data: {} }
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => ({ runtimeFlags: { feedbackV2: true } }) })) as unknown as typeof fetch);
    await tsFlags.initRuntimeFlags();
    await clientFlags.initRuntimeFlags();
    expect(tsFlags.flag("feedbackV2")).toBe(true);
    expect(clientFlags.flag("feedbackV2")).toBe(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (window as unknown as Record<string, unknown>).opDesktop;
    globalThis.fetch = originalFetch;
    window.alert = originalAlert;
    window.confirm = originalConfirm;
  });

  it("notify 三族渲染 toast 队列：类名/文本/图标两侧一致，点击关闭即消失", () => {
    mountHosts();
    try {
      act(() => {
        notifyErrorTs("错了");
        clientFeedback.notifyError("错了");
        notifySuccessTs("成了");
        clientFeedback.notifySuccess("成了");
        notifyWarnTs("小心");
        clientFeedback.notifyWarn("小心");
      });
      expect(alerts).toEqual([]);
      const stackA = containerA!.querySelectorAll(".fb-toast-stack .fb-toast");
      const stackB = containerB!.querySelectorAll(".fb-toast-stack .fb-toast");
      expect(stackA.length).toBe(3);
      expect(stackB.length).toBe(3);
      const snapshot = (nodes: NodeListOf<Element>) => [...nodes].map((n) => ({
        className: n.className,
        text: n.querySelector(".fb-toast-text")?.textContent,
        hasIcon: Boolean(n.querySelector(".icon")),
        hasClose: Boolean(n.querySelector(".fb-toast-close")),
      }));
      expect(snapshot(stackA)).toEqual(snapshot(stackB));

      // 点击 TS 版第一个关闭按钮 → 只剩 2 条；client 版同样操作 → 同样剩 2 条
      const closeA = stackA[0]!.querySelector(".fb-toast-close") as HTMLButtonElement;
      const closeB = stackB[0]!.querySelector(".fb-toast-close") as HTMLButtonElement;
      act(() => {
        closeA.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      });
      act(() => {
        closeB.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      });
      expect(containerA!.querySelectorAll(".fb-toast").length).toBe(2);
      expect(containerB!.querySelectorAll(".fb-toast").length).toBe(2);
    } finally {
      unmountHosts();
    }
  });

  it("askConfirm：对话框渲染、Enter/Escape/backdrop 三种 resolve 两侧一致", async () => {
    mountHosts();
    try {
      const p1a = askConfirmTs("确认删除？");
      const p1b = clientFeedback.askConfirm("确认删除？");
      await act(async () => { await Promise.resolve(); });
      const dialogA = containerA!.querySelector(".fb-confirm");
      const dialogB = containerB!.querySelector(".fb-confirm");
      expect(Boolean(dialogA)).toBe(true);
      expect(Boolean(dialogB)).toBe(true);
      expect(dialogA!.querySelector(".fb-confirm-body")?.textContent).toBe(dialogB!.querySelector(".fb-confirm-body")?.textContent);
      // Enter → true
      act(() => {
        window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter" }));
      });
      expect(await p1a).toBe(true);
      expect(await p1b).toBe(true);
      expect(containerA!.querySelector(".fb-confirm")).toBeNull();

      const p2a = askConfirmTs("第二个");
      const p2b = clientFeedback.askConfirm("第二个");
      await act(async () => { await Promise.resolve(); });
      act(() => {
        window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
      });
      expect(await p2a).toBe(false);
      expect(await p2b).toBe(false);

      const p3a = askConfirmTs("第三个");
      const p3b = clientFeedback.askConfirm("第三个");
      await act(async () => { await Promise.resolve(); });
      act(() => {
        containerA!.querySelector(".fb-confirm-backdrop")!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
        containerB!.querySelector(".fb-confirm-backdrop")!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      });
      expect(await p3a).toBe(false);
      expect(await p3b).toBe(false);
      expect(alerts).toEqual([]);
      expect(confirmCalls).toEqual([]);
    } finally {
      unmountHosts();
    }
  });

  it("确认对话框内点击确定/取消按钮 resolve 两侧一致", async () => {
    mountHosts();
    try {
      const pa = askConfirmTs("按钮确认");
      const pb = clientFeedback.askConfirm("按钮确认");
      await act(async () => { await Promise.resolve(); });
      const okA = containerA!.querySelector(".fb-btn-danger") as HTMLButtonElement;
      const okB = containerB!.querySelector(".fb-btn-danger") as HTMLButtonElement;
      act(() => {
        okA.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
        okB.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      });
      expect(await pa).toBe(true);
      expect(await pb).toBe(true);

      const pc = askConfirmTs("按钮取消");
      const pd = clientFeedback.askConfirm("按钮取消");
      await act(async () => { await Promise.resolve(); });
      const cancelA = containerA!.querySelector(".fb-confirm-actions .fb-btn") as HTMLButtonElement;
      const cancelB = containerB!.querySelector(".fb-confirm-actions .fb-btn") as HTMLButtonElement;
      act(() => {
        cancelA.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
        cancelB.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      });
      expect(await pc).toBe(false);
      expect(await pd).toBe(false);
    } finally {
      unmountHosts();
    }
  });

  it("unmount 后外部入口置空：notify 回退 alert、askConfirm 回退 confirm（两侧一致）", async () => {
    mountHosts();
    unmountHosts();
    notifySuccessTs("回退");
    clientFeedback.notifySuccess("回退");
    expect(alerts).toEqual(["回退", "回退"]);
    expect(await askConfirmTs("回退确认")).toBe(await clientFeedback.askConfirm("回退确认"));
    expect(confirmCalls).toEqual(["回退确认", "回退确认"]);
  });

  it("toast 队列上限 MAX_TOASTS=4：连续推送保留最近 4 条（两侧一致）", () => {
    mountHosts();
    try {
      act(() => {
        for (let i = 0; i < 6; i++) notifyWarnTs(`m${i}`);
        for (let i = 0; i < 6; i++) clientFeedback.notifyWarn(`m${i}`);
      });
      const textsA = [...containerA!.querySelectorAll(".fb-toast-text")].map((n) => n.textContent);
      const textsB = [...containerB!.querySelectorAll(".fb-toast-text")].map((n) => n.textContent);
      expect(textsA).toEqual(["m2", "m3", "m4", "m5"]);
      expect(textsA).toEqual(textsB);
    } finally {
      unmountHosts();
    }
  });
});
