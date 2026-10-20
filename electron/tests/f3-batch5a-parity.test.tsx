// @vitest-environment jsdom
/**
 * F3 批5a 对拍：MarqueeText + ContextMenu（SessionSidebar 的两个基础子组件）。
 *
 * 对拍口径（同输入同流）：
 *   - MarqueeText：双侧同挂载（旧 client ui-appearance / 新 electron lib/ui-appearance
 *     读同一 oaw_settings），溢出度量 stub 相同值（隐藏测量元素 scrollWidth -
 *     容器 clientWidth），DOM outerHTML 逐字节一致；覆盖 motionLevel off /
 *     marqueeStyle static / 抖动阈值（≤1px 不重渲染）；
 *   - ContextMenu：items 渲染（separator/danger/disabled/shortcut/icon）逐字节，
 *     点击分发序列（普通项 onClick+onClose、disabled 项无副作用）、Escape 关闭、
 *     内部/外部 mousedown 判定、窗口越界防溢出坐标计算，两侧一致。
 *
 * 环境事实：jsdom 无 ResizeObserver → 两侧都走 window resize 兜底路径（等价）；
 * 溢出度量靠 Object.defineProperty 覆盖 clientWidth/scrollWidth 实例属性。
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// 旧/新组件装载
// ---------------------------------------------------------------------------

const MarqueeTextTs = (await import("../src/renderer/components/MarqueeText")).default;
const ContextMenuTs = (await import("../src/renderer/components/ContextMenu")).default;
// 旧组件用宽容视图装载：JSDoc 参数解构会把无默认值的 title 推成必填，与实际调用不符
const MarqueeTextJs = (await import("../../client/src/components/MarqueeText.jsx")).default as unknown as React.ComponentType<any>;
const ContextMenuJs = (await import("../../client/src/components/ContextMenu.jsx")).default as unknown as React.ComponentType<any>;

const SETTINGS_KEY = "oaw_settings";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function stubMatchMedia(matches = false): void {
  (window as unknown as { matchMedia: unknown }).matchMedia = vi.fn(() => ({
    matches,
    addEventListener() {},
    removeEventListener() {},
  }));
}

interface Mounted {
  host: HTMLElement;
  unmount: () => void;
}

function mount(component: React.ReactNode): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  let root: Root | null = null;
  act(() => {
    root = createRoot(host);
    root.render(component);
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

/** 覆盖跑马灯度量：隐藏测量元素 scrollWidth=文本宽、容器 clientWidth=可见宽 */
function stubMarqueeMetrics(host: HTMLElement, textWidth: number, visibleWidth: number): void {
  const wrap = host.querySelector(".marquee") as HTMLElement;
  const probe = host.querySelector(".marquee-measure") as HTMLElement;
  Object.defineProperty(wrap, "clientWidth", { configurable: true, value: visibleWidth });
  Object.defineProperty(probe, "scrollWidth", { configurable: true, value: textWidth });
}

afterEach(() => {
  localStorage.clear();
  document.body.innerHTML = "";
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
});

// ---------------------------------------------------------------------------
// 第一部分：MarqueeText 对拍
// ---------------------------------------------------------------------------

describe("MarqueeText TS 版与 client MarqueeText.jsx 渲染等价", () => {
  it("基础渲染：类名/结构/data 属性/title 兜底逐字节一致", () => {
    stubMatchMedia();
    const js = mount(<MarqueeTextJs text="会话A" active={false} className="extra" />);
    const jsHtml = js.host.innerHTML;
    js.unmount();

    const ts = mount(<MarqueeTextTs text="会话A" active={false} className="extra" />);
    const tsHtml = ts.host.innerHTML;
    ts.unmount();

    expect(tsHtml).toBe(jsHtml);
    expect(tsHtml).toContain('data-marquee-overflow="0"');
    expect(tsHtml).toContain('data-marquee-motion="full"');
    expect(tsHtml).toContain('title="会话A"');
    expect(tsHtml).not.toContain("is-scrolling");
    // 短文本 inactive：无 is-active、无自定义 style
    expect(tsHtml).not.toContain("is-active");
    expect(tsHtml).not.toContain("--marquee-shift");
  });

  it("active 且溢出 >4px：is-scrolling + 位移变量两侧一致", async () => {
    stubMatchMedia();
    const js = mount(<MarqueeTextJs text="很长很长的会话名字需要滚动" active />);
    stubMarqueeMetrics(js.host, 100, 50);
    const ts = mount(<MarqueeTextTs text="很长很长的会话名字需要滚动" active />);
    stubMarqueeMetrics(ts.host, 100, 50);
    // 120ms 定时重算档触发 measure，overflow = ceil(100-50) = 50 > 4
    await act(async () => { await sleep(160); });
    const jsHtml = js.host.innerHTML;
    const tsHtml = ts.host.innerHTML;
    js.unmount();
    ts.unmount();

    expect(tsHtml).toBe(jsHtml);
    expect(tsHtml).toContain("is-active");
    expect(tsHtml).toContain("is-scrolling");
    expect(tsHtml).toContain('data-marquee-overflow="50"');
    expect(tsHtml).toContain("--marquee-shift");
    expect(tsHtml).toContain("-60px");
    expect(tsHtml).toContain("60px");
  });

  it("motionLevel off：溢出也不滚动，仅 is-active 静态高亮", async () => {
    stubMatchMedia();
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ motionLevel: "off" }));
    const js = mount(<MarqueeTextJs text="很长很长的会话名字需要滚动" active />);
    stubMarqueeMetrics(js.host, 100, 50);
    const ts = mount(<MarqueeTextTs text="很长很长的会话名字需要滚动" active />);
    stubMarqueeMetrics(ts.host, 100, 50);
    await act(async () => { await sleep(160); });
    const jsHtml = js.host.innerHTML;
    const tsHtml = ts.host.innerHTML;
    js.unmount();
    ts.unmount();

    expect(tsHtml).toBe(jsHtml);
    expect(tsHtml).toContain("is-active");
    expect(tsHtml).not.toContain("is-scrolling");
    expect(tsHtml).toContain('data-marquee-motion="off"');
  });

  it("marqueeStyle static：完全不动（不滚动不做灯效）", async () => {
    stubMatchMedia();
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ marqueeStyle: "static" }));
    const js = mount(<MarqueeTextJs text="很长很长的会话名字需要滚动" active />);
    stubMarqueeMetrics(js.host, 100, 50);
    const ts = mount(<MarqueeTextTs text="很长很长的会话名字需要滚动" active />);
    stubMarqueeMetrics(ts.host, 100, 50);
    await act(async () => { await sleep(160); });
    const jsHtml = js.host.innerHTML;
    const tsHtml = ts.host.innerHTML;
    js.unmount();
    ts.unmount();

    expect(tsHtml).toBe(jsHtml);
    expect(tsHtml).toContain("is-active");
    expect(tsHtml).not.toContain("is-scrolling");
    // overflow 照常测量，只是不进滚动样式
    expect(tsHtml).toContain('data-marquee-overflow="50"');
    expect(tsHtml).not.toContain("--marquee-shift");
  });

  it("溢出变化 ≤1px 不重渲染（防抖阈值）", async () => {
    stubMatchMedia();
    const js = mount(<MarqueeTextJs text="很长很长的会话名字需要滚动" active />);
    stubMarqueeMetrics(js.host, 100, 50);
    const ts = mount(<MarqueeTextTs text="很长很长的会话名字需要滚动" active />);
    stubMarqueeMetrics(ts.host, 100, 50);
    await act(async () => { await sleep(160); }); // 第一档：overflow=50
    // 第二档（400ms）触发时文本只宽了 1px：next=51，|50-51|=1 不更新
    stubMarqueeMetrics(js.host, 101, 50);
    stubMarqueeMetrics(ts.host, 101, 50);
    await act(async () => { await sleep(320); });
    const jsHtml = js.host.innerHTML;
    const tsHtml = ts.host.innerHTML;
    js.unmount();
    ts.unmount();

    expect(tsHtml).toBe(jsHtml);
    expect(tsHtml).toContain('data-marquee-overflow="50"');
  });
});

// ---------------------------------------------------------------------------
// 第二部分：ContextMenu 对拍
// ---------------------------------------------------------------------------

const SAMPLE_ITEMS = [
  { icon: "externalLink", label: "用系统默认应用打开", onClick: () => {} },
  { separator: true },
  { icon: "trash", label: "删除", danger: true, onClick: () => {} },
  { icon: "copy", label: "复制文件名", disabled: true, shortcut: "Ctrl+C", onClick: () => {} },
];

describe("ContextMenu TS 版与 client ContextMenu.jsx 行为等价", () => {
  it("items 渲染：separator/danger/disabled/shortcut/icon DOM 逐字节一致", () => {
    const js = mount(<ContextMenuJs x={10} y={10} items={SAMPLE_ITEMS} onClose={() => {}} />);
    const jsHtml = js.host.innerHTML;
    js.unmount();

    const ts = mount(<ContextMenuTs x={10} y={10} items={SAMPLE_ITEMS} onClose={() => {}} />);
    const tsHtml = ts.host.innerHTML;
    ts.unmount();

    expect(tsHtml).toBe(jsHtml);
    expect(tsHtml).toContain("context-menu-separator");
    expect(tsHtml).toContain("danger");
    expect(tsHtml).toContain("disabled");
    expect(tsHtml).toContain("context-menu-shortcut");
    // 图标走 Icon 组件（SVG）
    expect(tsHtml).toContain("context-menu-icon");
    expect(tsHtml).toContain("<svg");
  });

  it("点击分发：普通项 onClick+onClose；disabled 项无副作用；序列两侧一致", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 对拍 run 辅助：两侧组件 props 视图宽严不同
    const run = (Comp: React.ComponentType<any>) => {
      const calls: string[] = [];
      let closed = 0;
      const m = mount(
        <Comp
          x={0}
          y={0}
          items={[
            { icon: "copy", label: "A", onClick: () => calls.push("A") },
            { icon: "trash", label: "B", disabled: true, onClick: () => calls.push("B") },
          ]}
          onClose={() => { closed += 1; }}
        />
      );
      const items = [...m.host.querySelectorAll<HTMLElement>(".context-menu-item")];
      act(() => { items[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
      act(() => { items[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
      m.unmount();
      return { calls, closed };
    };
    const js = run(ContextMenuJs);
    const ts = run(ContextMenuTs);
    expect(ts).toEqual(js);
    expect(ts.calls).toEqual(["A"]);
    expect(ts.closed).toBe(1);
  });

  it("Escape 关闭；内部 mousedown 不关闭；外部 mousedown 关闭", () => {
    const run = (Comp: React.ComponentType<any>) => {
      let closed = 0;
      const m = mount(<Comp x={0} y={0} items={[{ label: "A", onClick: () => {} }]} onClose={() => { closed += 1; }} />);
      const menu = m.host.querySelector(".context-menu") as HTMLElement;
      act(() => { menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
      const afterEscape = closed;
      // 内部 mousedown：target 在 menu 内 → 不关闭
      menu.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      const afterInternal = closed;
      // 外部 mousedown：target 不在 menu 内
      const outside = document.createElement("button");
      document.body.appendChild(outside);
      outside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      const afterOutside = closed;
      m.unmount();
      outside.remove();
      return { afterEscape, afterInternal, afterOutside };
    };
    const js = run(ContextMenuJs);
    const ts = run(ContextMenuTs);
    expect(ts).toEqual(js);
    expect(ts.afterEscape).toBe(1);
    expect(ts.afterInternal).toBe(1);
    expect(ts.afterOutside).toBe(2);
  });

  it("窗口越界防溢出：x/y 越界收进屏幕，两侧一致", () => {
    const realW = window.innerWidth;
    const realH = window.innerHeight;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
    try {
      const items = [{ label: "A", onClick: () => {} }, { label: "B", onClick: () => {} }, { label: "C", onClick: () => {} }];
      const js = mount(<ContextMenuJs x={900} y={590} items={items} onClose={() => {}} />);
      const jsHtml = js.host.innerHTML;
      js.unmount();
      const ts = mount(<ContextMenuTs x={900} y={590} items={items} onClose={() => {}} />);
      const tsHtml = ts.host.innerHTML;
      ts.unmount();

      expect(tsHtml).toBe(jsHtml);
      // adjustedX = min(900, 800-200) = 600；adjustedY = min(590, 600-3*36-20) = 472
      expect(tsHtml).toContain("600px");
      expect(tsHtml).toContain("472px");
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: realW });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: realH });
    }
  });
});
