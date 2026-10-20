// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import MarkdownBodyTs from "../src/renderer/components/MarkdownBody";

const MarkdownBodyJsx = (await import("../../client/src/components/MarkdownBody.jsx")).default as unknown as (
  props: Record<string, unknown>
) => React.ReactElement;

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 双侧同流渲染对拍：同一段 markdown + 同一组 props 分别喂给 TS 版与 client 版，
 * 轮询等两侧渲染稳定（重插件 KaTeX/highlight 异步就绪会触发二次渲染）后比较 innerHTML。
 */
async function renderBoth(markdown: string, props: Record<string, unknown> = {}): Promise<[string, string]> {
  const a = document.createElement("div");
  const b = document.createElement("div");
  document.body.appendChild(a);
  document.body.appendChild(b);
  const rootA: Root = createRoot(a);
  const rootB: Root = createRoot(b);
  act(() => {
    rootA.render(React.createElement(MarkdownBodyTs, { ...props, children: markdown }));
    rootB.render(React.createElement(MarkdownBodyJsx, { ...props, children: markdown }));
  });
  // 轮询至两侧渲染稳定：首次 katex/highlight.js 动态加载耗时不定，固定 sleep 会 flake
  let prevA = a.innerHTML;
  let prevB = b.innerHTML;
  for (let i = 0; i < 20; i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    const nowA = a.innerHTML;
    const nowB = b.innerHTML;
    if (nowA === prevA && nowB === prevB) break; // 两侧连续两轮一致 = 稳定
    prevA = nowA;
    prevB = nowB;
  }
  const resultA = a.innerHTML;
  const resultB = b.innerHTML;
  act(() => {
    rootA.unmount();
    rootB.unmount();
  });
  a.remove();
  b.remove();
  return [resultA, resultB];
}

const BASIC_MD = [
  "# 标题一",
  "",
  "正文段落，含 **粗体** 与 *斜体*。",
  "",
  "| 列A | 列B |",
  "| --- | --- |",
  "| 1 | 2 |",
  "",
  "- [ ] 待办一",
  "- [x] 待办二",
  "",
  "```js",
  "const x = 1;",
  "```",
  "",
  "行内 `code` 与 [外链](https://example.com)。",
  "",
  "![图](https://example.com/a.png)",
].join("\n");

describe("MarkdownBody TS 版与 client MarkdownBody.jsx 渲染等价", () => {
  let clicksTs: string[];
  let clicksJsx: string[];

  beforeEach(() => {
    clicksTs = [];
    clicksJsx = [];
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("基础 Markdown（标题/表格/任务列表/代码/图片/外链）innerHTML 一致", async () => {
    const [a, b] = await renderBoth(BASIC_MD);
    expect(a).toBe(b);
    expect(a).toContain("md-table-wrap");
    expect(a).toContain("<table>");
    expect(a).toContain('target="_blank"');
    expect(a).toContain('loading="lazy"');
  });

  it("withToc 目录生成一致（remark-toc 默认只识别英文 toc 标题）", async () => {
    const md = "## Table of contents\n\n## 甲\n\n内容\n\n## 乙\n\n内容\n\n### 乙一\n\n内容";
    const [a, b] = await renderBoth(md, { withToc: true });
    expect(a).toBe(b);
    expect(a).toContain("<ul>");
  });

  it("onTagClick：v10 下 text 组件不被调用（历史死代码），两侧现状一致", async () => {
    const md = "这是 #标签一 和 #FFFFFF 与 #123。";
    const [a, b] = await renderBoth(md, {
      onTagClick: (tag: string) => clicksTs.push(tag),
    });
    expect(a).toBe(b);
    // react-markdown v10 的 components 仅对元素名生效，text 节点不走自定义组件：
    // 迁移保持与旧版一致的「不生效」现状，此处固化该事实防回归误判。
    expect(a).not.toContain("md-tag");
    expect(a).toContain("#标签一");
  });

  it("onTagClick 点击回调：现状不触发，两侧一致（独立挂载驱动点击）", async () => {
    const md = "点击 #目标tag";
    const mountWith = async (
      Comp: React.ComponentType<Record<string, unknown>>,
      handler: (t: string) => void
    ): Promise<{ el: HTMLElement; unmount: () => void; text: string }> => {
      const el = document.createElement("div");
      document.body.appendChild(el);
      const root = createRoot(el);
      act(() => {
        root.render(React.createElement(Comp, { children: md, onTagClick: handler }));
      });
      await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
      return { el, text: el.textContent ?? "", unmount: () => act(() => root.unmount()) };
    };
    const ta = await mountWith(MarkdownBodyTs as unknown as React.ComponentType<Record<string, unknown>>, (t) => clicksTs.push(t));
    const tb = await mountWith(MarkdownBodyJsx, (t) => clicksJsx.push(t));
    expect(ta.text).toBe(tb.text);
    expect(ta.el.querySelectorAll(".md-tag").length).toBe(0);
    expect(clicksTs).toEqual([]);
    expect(clicksTs).toEqual(clicksJsx);
    ta.unmount();
    tb.unmount();
  });

  it("onWikilinkHover：[[目标]] 渲染 kb-wikilink，显示文本取 | 前段，两侧一致", async () => {
    const md = "见 [[页面甲]] 与 [[页面乙|乙的别名]]。";
    const [a, b] = await renderBoth(md, { onWikilinkHover: () => {} });
    expect(a).toBe(b);
    expect(a).toContain("kb-wikilink");
    expect(a).toContain("页面甲");
    expect(a).toContain("页面乙");
    expect(a).not.toContain("乙的别名"); // 显示文本是 label（| 前段），不是别名
    expect(a).not.toContain("[[");
  });

  it("artifacts + onOpenFile：散文产物名/行内代码/markdown 链接都渲染文件条且一致", async () => {
    const artifacts = [
      { path: "out/report.docx", size: 20480, deliverable: true, confirmed: true },
      { path: "out/data.csv", size: 512, deliverable: false },
    ];
    const md = [
      "报告见 report.docx 与数据 out/data.csv。",
      "",
      "行内写法 `report.docx`。",
      "",
      "[点这里](out/report.docx)。",
      "",
      "```js",
      "const report = 'report.docx';",
      "```",
    ].join("\n");
    const [a, b] = await renderBoth(md, {
      onOpenFile: (p: string) => clicksTs.push(p),
      artifacts,
    });
    expect(a).toBe(b);
    expect(a).toContain("artifact-inline");
    // #artifact: 链接被 a 组件拦截渲染为文件条，DOM 中不保留 href
    expect(a).toContain("打开 out/report.docx");
    expect(a).not.toContain("#artifact:");
    // 代码块带 language- 前缀：内部的 report.docx 不转文件条，仍为 code
    expect(a).toContain("language-js");
  });

  it("产物名边界：延续字符不拆分（mydata.docx 不命中 data.docx）", async () => {
    const artifacts = [{ path: "out/data.docx", size: 10 }];
    const md = "前缀拼一起 mydata.docx 与独立 data.docx。";
    const [a, b] = await renderBoth(md, {
      onOpenFile: () => {},
      artifacts,
    });
    expect(a).toBe(b);
    expect(a).toContain("mydata.docx");
  });

  it("无 onOpenFile 时产物名不转换，与基线一致", async () => {
    const md = "提到 report.docx 但不开预览。";
    const [a, b] = await renderBoth(md, { artifacts: [{ path: "out/report.docx", size: 1 }] });
    expect(a).toBe(b);
    expect(a).not.toContain("artifact-inline");
  });

  it("重插件就绪后：数学公式与代码高亮渲染一致", async () => {
    const md = [
      "公式 $E = mc^2$ 行内。",
      "",
      "$$",
      "\\int_0^1 x \\, dx",
      "$$",
      "",
      "```python",
      "def f(x):",
      "    return x + 1",
      "```",
    ].join("\n");
    const [a, b] = await renderBoth(md);
    expect(a).toBe(b);
  });

  it("空 children 与数字 children 的 String 归一口径一致", async () => {
    const [a, b] = await renderBoth("");
    expect(a).toBe(b);
    const [c, d] = await renderBoth("纯文本");
    expect(c).toBe(d);
  });
});
