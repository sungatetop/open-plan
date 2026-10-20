// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { repaginateDocx } from "../src/renderer/lib/DocPagination";

const clientModule = await import("../../client/src/components/DocPagination.js");
const client = clientModule as unknown as { repaginateDocx: typeof repaginateDocx };

interface BlockDecl {
  height?: number;
  marginTop?: number;
  marginBottom?: number;
  position?: string;
}
interface SectionDecl {
  minHeight?: number;
  paddingTop?: number;
  paddingBottom?: number;
}

const REG = {
  block: new WeakMap<Element, BlockDecl>(),
  section: new WeakMap<HTMLElement, SectionDecl>(),
};

const originalRect = Element.prototype.getBoundingClientRect;

beforeAll(() => {
  vi.stubGlobal("getComputedStyle", (el: Element) => {
    const m = REG.block.get(el);
    const s = REG.section.get(el as HTMLElement);
    const num = (v?: number) => (v === undefined ? "" : String(v));
    return {
      minHeight: num(s?.minHeight),
      height: "",
      paddingTop: num(s?.paddingTop),
      paddingBottom: num(s?.paddingBottom),
      marginTop: num(m?.marginTop),
      marginBottom: num(m?.marginBottom),
      position: m?.position ?? "static",
    } as unknown as CSSStyleDeclaration;
  });
  Element.prototype.getBoundingClientRect = function (): DOMRect {
    const height = REG.block.get(this)?.height ?? 0;
    return { height, top: 0, left: 0, right: 0, bottom: height, width: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
});

afterAll(() => {
  Element.prototype.getBoundingClientRect = originalRect;
  vi.unstubAllGlobals();
});

function makeHost(): { host: HTMLElement; wrapper: HTMLElement } {
  const host = document.createElement("div");
  host.className = "oaw-docx-host";
  const wrapper = document.createElement("div");
  wrapper.className = "oaw-docx-wrapper";
  host.appendChild(wrapper);
  return { host, wrapper };
}

function setSection(wrapper: HTMLElement, geo: SectionDecl, style = "width:794px"): HTMLElement {
  const section = document.createElement("section");
  section.className = "docx-section";
  section.setAttribute("style", style);
  REG.section.set(section, geo);
  wrapper.appendChild(section);
  return section;
}

function makeArticle(section: HTMLElement, style = ""): HTMLElement {
  const article = document.createElement("article");
  if (style) article.setAttribute("style", style);
  section.appendChild(article);
  return article;
}

function makeBlock(parent: HTMLElement, tag: string, text: string, decl: BlockDecl = {}): HTMLElement {
  const el = document.createElement(tag);
  el.textContent = text;
  REG.block.set(el, decl);
  parent.appendChild(el);
  return el;
}

function makeTable(parent: HTMLElement, opts: { h: number; headerH: number; rows: number[]; withColgroup?: boolean }): HTMLTableElement {
  const table = document.createElement("table");
  REG.block.set(table, { height: opts.h });
  if (opts.withColgroup !== false) {
    const colgroup = document.createElement("colgroup");
    colgroup.appendChild(document.createElement("col"));
    table.appendChild(colgroup);
  }
  const thead = document.createElement("thead");
  REG.block.set(thead, { height: opts.headerH });
  const headerRow = document.createElement("tr");
  const th = document.createElement("td");
  th.textContent = "表头";
  headerRow.appendChild(th);
  thead.appendChild(headerRow);
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  opts.rows.forEach((h, i) => {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.textContent = `行${i}`;
    tr.appendChild(td);
    REG.block.set(tr, { height: h });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  parent.appendChild(table);
  return table;
}

/** 分页后页面的结构签名（类名/样式/页码/每页块序列），用于两侧逐字段比较 */
function pageSignature(host: HTMLElement): unknown {
  const wrapper = host.querySelector(".oaw-docx-wrapper");
  if (!wrapper) return [];
  return [...wrapper.querySelectorAll<HTMLElement>(":scope > section")].map((section) => ({
    cls: section.getAttribute("class") || "",
    style: section.getAttribute("style") || "",
    page: section.dataset.page ?? null,
    blocks: [...(section.querySelector(":scope > article") ?? section).children].map((el) => {
      if (el.tagName === "TABLE") {
        const t = el as HTMLTableElement;
        return { table: [...t.rows].map((row) => [...row.cells].map((c) => c.textContent ?? "").join("|")) };
      }
      return { tag: el.tagName, text: (el.textContent ?? "").trim() };
    }),
  }));
}

/** 同一构建函数生成两棵独立 DOM，分别跑 TS 版与 client 版，比较返回值与最终结构 */
async function runBoth(build: (wrapper: HTMLElement) => void) {
  const a = makeHost();
  const b = makeHost();
  build(a.wrapper);
  build(b.wrapper);
  const tsResult = repaginateDocx(a.host);
  const clientResult = client.repaginateDocx(b.host);
  expect(tsResult).toEqual(clientResult);
  expect(pageSignature(a.host)).toEqual(pageSignature(b.host));
  return { host: a.host, tsResult, clientResult };
}

describe("DocPagination TS 版与 client 版等价（对拍）", () => {
  it("一页装得下：原样保留，不重建 DOM，页码标注", async () => {
    const { host, tsResult } = await runBoth((wrapper) => {
      const section = setSection(wrapper, { minHeight: 2000 });
      const article = makeArticle(section);
      makeBlock(article, "p", "第一段", { height: 200 });
      makeBlock(article, "p", "第二段", { height: 200 });
    });
    expect(tsResult).toEqual({ before: 1, after: 1 });
    const pages = pageSignature(host) as { page: string; blocks: unknown[] }[];
    expect(pages).toHaveLength(1);
    expect(pages[0]!.page).toBe("1");
    expect(pages[0]!.blocks).toHaveLength(2);
  });

  it("超页高：按块边界拆进新页，页首不计段前距", async () => {
    const { tsResult } = await runBoth((wrapper) => {
      const section = setSection(wrapper, { minHeight: 1000 });
      const article = makeArticle(section);
      makeBlock(article, "p", "p1", { height: 400, marginTop: 0, marginBottom: 20 });
      makeBlock(article, "p", "p2", { height: 400, marginTop: 30, marginBottom: 10 });
      makeBlock(article, "p", "p3", { height: 400, marginTop: 0, marginBottom: 0 });
      makeBlock(article, "p", "p4", { height: 100, marginTop: 0, marginBottom: 0 });
    });
    expect(tsResult).toEqual({ before: 1, after: 2 });
  });

  it("超高表格：按行拆多张表，续表重复 colgroup+thead", async () => {
    const { host, tsResult } = await runBoth((wrapper) => {
      const section = setSection(wrapper, { minHeight: 1000 });
      const article = makeArticle(section);
      makeTable(article, { h: 1500, headerH: 40, rows: [240, 240, 240, 240, 240, 240] });
    });
    expect(tsResult).toEqual({ before: 1, after: 2 });
    const pages = pageSignature(host) as { blocks: { table?: string[] }[] }[];
    const tables = pages.map((p) => p.blocks[0]);
    expect(pages).toHaveLength(2);
    // 第一张表放当前页剩余空间：表头 + 前 4 行；第二张表：表头 + 后 2 行
    expect(tables[0]!.table).toEqual(["表头", "行0", "行1", "行2", "行3"]);
    expect(tables[1]!.table).toEqual(["表头", "行4", "行5"]);
  });

  it("绝对定位块不占正文高度，跟随当前页", async () => {
    const { host, tsResult } = await runBoth((wrapper) => {
      const section = setSection(wrapper, { minHeight: 800 });
      const article = makeArticle(section);
      makeBlock(article, "p", "p1", { height: 500 });
      makeBlock(article, "div", "浮动图", { height: 50, position: "absolute" });
      makeBlock(article, "p", "p2", { height: 500 });
    });
    expect(tsResult).toEqual({ before: 1, after: 2 });
    const pages = pageSignature(host) as { blocks: { text?: string }[] }[];
    expect(pages[0]!.blocks.map((b) => b.text)).toEqual(["p1", "浮动图"]);
    expect(pages[1]!.blocks.map((b) => b.text)).toEqual(["p2"]);
  });

  it("多 article 堆叠：按 DOM 顺序收集所有块重排，续页继承首个 article 样式", async () => {
    const { host, tsResult } = await runBoth((wrapper) => {
      const section = setSection(wrapper, { minHeight: 1000 });
      const article1 = makeArticle(section, "margin:0 auto");
      makeBlock(article1, "p", "a1", { height: 700 });
      const article2 = makeArticle(section, "margin:0 auto");
      makeBlock(article2, "p", "a2", { height: 700 });
    });
    expect(tsResult).toEqual({ before: 1, after: 2 });
    const pages = pageSignature(host) as { style: string; blocks: { text?: string }[] }[];
    expect(pages).toHaveLength(2);
    expect(pages[0]!.blocks.map((b) => b.text)).toEqual(["a1"]);
    expect(pages[1]!.blocks.map((b) => b.text)).toEqual(["a2"]);
    expect(pages[0]!.style).toContain("width:794px");
  });

  it("边界：null host / 无 wrapper / 无 section / 空 section", async () => {
    expect(repaginateDocx(null)).toEqual({ before: 0, after: 0 });
    expect(client.repaginateDocx(null)).toEqual({ before: 0, after: 0 });

    const bare = await runBoth((wrapper) => { void wrapper; });
    expect(bare.tsResult).toEqual({ before: 0, after: 0 });

    const emptySection = await runBoth((wrapper) => {
      setSection(wrapper, { minHeight: 1000 });
    });
    expect(emptySection.tsResult).toEqual({ before: 1, after: 1 });
    // 空 section 不重建，保留原引用，仅标注页码
    const pages = pageSignature(emptySection.host) as { page: string }[];
    expect(pages).toHaveLength(1);
    expect(pages[0]!.page).toBe("1");
  });

  it("节级几何：padding 收缩可用高度，影响分页阈值", async () => {
    const { tsResult } = await runBoth((wrapper) => {
      const section = setSection(wrapper, { minHeight: 1000, paddingTop: 100, paddingBottom: 100 });
      const article = makeArticle(section);
      // contentHeight = max(120, 1000-200) = 800：p1+p2=1000 超页 → 拆
      makeBlock(article, "p", "p1", { height: 500 });
      makeBlock(article, "p", "p2", { height: 500 });
    });
    expect(tsResult).toEqual({ before: 1, after: 2 });
  });
});
