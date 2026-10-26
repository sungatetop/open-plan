/**
 * B2 file-diff 域对拍（file-diff.ts ↔ server/file-diff.mjs）。
 *
 * file-diff.mjs 为无依赖纯函数模块（S3-2 运行族直调批底层件），可新旧同输入
 * 直接对拍（最强对拍形态）：分类 / 归一化 / 行差异（含降级）/ hunk 聚合分页 /
 * 文本差异 / 不透明摘要 / 统一入口，以及 DIFF_LIMITS 常量逐键。
 */
import { describe, expect, test, beforeAll, afterAll, vi } from "vitest";
import type * as FileDiffModule from "../src/main/backend/file-diff";

type LegacyFileDiff = typeof import("@legacy-server/file-diff.mjs");
let legacy: LegacyFileDiff;
let mod: typeof FileDiffModule;

beforeAll(async () => {
  legacy = await import("@legacy-server/file-diff.mjs");
  mod = await import("../src/main/backend/file-diff");
});

afterAll(() => {
  vi.resetModules();
});

describe("b2-file-diff-parity 常量与分类", () => {
  test("DIFF_LIMITS / DIFF_ALGO_VERSION 逐键一致", () => {
    expect(mod.DIFF_LIMITS).toEqual(legacy.DIFF_LIMITS);
    expect(mod.DIFF_ALGO_VERSION).toBe(legacy.DIFF_ALGO_VERSION);
  });

  test.each([
    ["a.txt", "text"],
    ["a.md", "text"],
    ["a.json", "text"],
    ["a.tsx", "text"],
    ["a.docx", "office"],
    ["a.ppt", "office"],
    ["a.pdf", "pdf"],
    ["a.png", "image"],
    ["a.webp", "image"],
    ["a.unknownext", "binary"],
    ["noext", "text"],
    ["dir/a/b.csv", "text"]
  ])("classifyFileKind(%s) = %s 新旧一致", (input, kind) => {
    expect(mod.classifyFileKind(input)).toBe(kind);
    expect(mod.classifyFileKind(input)).toBe(legacy.classifyFileKind(input));
  });

  test("无扩展名嗅探：NUL → binary，否则 text（新旧一致）", () => {
    for (const sniff of ["plain text", "with\0nul"]) {
      expect(mod.classifyFileKind("noext", { sniff })).toBe(legacy.classifyFileKind("noext", { sniff }));
    }
  });

  test.each(["", "a", "a.", ".hidden", "a.TXT", "dir\\win\\path.BMP"])("extensionOf(%s) 新旧一致", (input) => {
    expect(mod.extensionOf(input)).toBe(legacy.extensionOf(input));
  });
});

describe("b2-file-diff-parity 归一化与行拆分", () => {
  test.each([
    "plain",
    "a\r\nb\r\nc",
    "a\nb",
    "a\r\nb\nmixed\r\n",
    "\ufeffbom text",
    ""
  ])("normalizeText(%j) 新旧一致", (input) => {
    expect(mod.normalizeText(input)).toEqual(legacy.normalizeText(input));
  });

  test.each(["", "\n", "a\nb\n", "a\r\nb\r\n"])("splitLines(%j) 新旧一致（末尾换行不算一行）", (input) => {
    expect(mod.splitLines(input)).toEqual(legacy.splitLines(input));
  });

  test("normalizeText 非 string 输入（Buffer/number/null）新旧一致", () => {
    expect(mod.normalizeText(null)).toEqual(legacy.normalizeText(null));
    expect(mod.normalizeText(123)).toEqual(legacy.normalizeText(123));
  });
});

describe("b2-file-diff-parity 行级差异", () => {
  test("典型增删改 ops 新旧一致", () => {
    const a = ["x", "keep1", "old", "keep2", "y"];
    const b = ["x", "keep1", "new1", "new2", "keep2", "z"];
    const mine = mod.lineDiff(a, b);
    const theirs = legacy.lineDiff(a, b);
    expect(mine.ops).toEqual(theirs.ops);
    expect(mine.degraded).toBe(theirs.degraded);
  });

  test("LCS 倾向：双候选路径取 delete 先行（新旧一致）", () => {
    const a = ["A", "B", "C"];
    const b = ["B", "C", "D"];
    expect(mod.lineDiff(a, b).ops).toEqual(legacy.lineDiff(a, b).ops);
  });

  test("行数超上限退化为整体替换（degraded=true）", () => {
    const big = Array.from({ length: 10 }, (_, i) => `L${i}`);
    const mine = mod.lineDiff(big, ["x"], { maxLines: 5 });
    const theirs = legacy.lineDiff(big, ["x"], { maxLines: 5 } as any);
    expect(mine.degraded).toBe(true);
    expect(mine.ops).toEqual(theirs.ops);
  });

  test("空数组与默认参数（新旧一致）", () => {
    expect(mod.lineDiff().ops).toEqual(legacy.lineDiff().ops);
    expect(mod.lineDiff([], []).ops).toEqual(legacy.lineDiff([], []).ops);
  });

  test("summarizeOps 新旧一致", () => {
    const ops = [
      { type: "equal", text: "a" },
      { type: "insert", text: "b" },
      { type: "delete", text: "c" },
      { type: "insert", text: "d" }
    ] as const;
    expect(mod.summarizeOps([...ops])).toEqual(legacy.summarizeOps([...ops]));
  });
});

describe("b2-file-diff-parity hunk 聚合分页", () => {
  const buildOps = () => mod.lineDiff(
    Array.from({ length: 40 }, (_, i) => `before-${i}`),
    Array.from({ length: 40 }, (_, i) => (i % 10 === 5 ? `after-${i}` : `before-${i}`))
  ).ops;

  test("context 截断与尾部 equal 修剪新旧一致", () => {
    const ops = buildOps();
    const mine = mod.buildHunks(ops, { context: 2, maxHunks: 5, page: 0 });
    const theirs = legacy.buildHunks(ops, { context: 2, maxHunks: 5, page: 0 } as any);
    expect(mine).toEqual(theirs);
  });

  test("分页：pageCount/hunkTotal/truncatedHunks 新旧一致", () => {
    const ops = buildOps();
    for (const page of [0, 1, 3, 99]) {
      expect(mod.buildHunks(ops, { context: 1, maxHunks: 3, page })).toEqual(legacy.buildHunks(ops, { context: 1, maxHunks: 3, page } as any));
    }
  });

  test("纯 equal ops → 空 hunks 但 pageCount=1（新旧一致）", () => {
    const equalOps = [{ type: "equal", text: "a" }, { type: "equal", text: "b" }] as any[];
    expect(mod.buildHunks(equalOps)).toEqual(legacy.buildHunks(equalOps));
  });
});

describe("b2-file-diff-parity 文本差异与不透明摘要", () => {
  test("diffText 全形状新旧一致（含 eol/bom/分页/截断标注）", () => {
    const before = "\ufeffheader\r\nline1\r\nline2\r\nline3";
    const after = "header\nline1\nLINE2-changed\nline3\nline4";
    expect(mod.diffText({ beforeText: before, afterText: after, relativePath: "a.md", page: 0 }))
      .toEqual(legacy.diffText({ beforeText: before, afterText: after, relativePath: "a.md", page: 0 }));
  });

  test("diffText 输入超限截断标注（maxInputBytes）新旧一致", () => {
    const big = "x".repeat(300);
    expect(mod.diffText({ beforeText: big, afterText: "y", limits: { maxInputBytes: 100 } }))
      .toEqual(legacy.diffText({ beforeText: big, afterText: "y", limits: { maxInputBytes: 100 } }));
  });

  test.each([
    [{ relativePath: "a.docx", before: { size: 10, hash: "h1" }, after: { size: 20, hash: "h2" } }],
    [{ relativePath: "a.pdf", before: { size: 10 }, after: { size: 10 } }],
    [{ relativePath: "a.png", before: { size: 5, hash: "same" }, after: { size: 5, hash: "same" } }],
    [{ relativePath: "a.bin", before: {}, after: {} }],
    [{ relativePath: "a.docx", before: { size: 10, hash: "h" }, after: { size: 10, hash: "h" } }]
  ])("diffOpaque 新旧一致 %j", (input) => {
    expect(mod.diffOpaque(input as any)).toEqual(legacy.diffOpaque(input as any));
  });

  test.each([
    [{ relativePath: "a.txt", beforeBuffer: "1\n2\n3", afterBuffer: "1\n2\n4" }],
    [{ relativePath: "a.json", beforeBuffer: Buffer.from("{}"), afterBuffer: Buffer.from("[]") }],
    [{ relativePath: "a.docx", beforeBuffer: "text-ish", afterBuffer: "text-ish2", before: { size: 8 }, after: { size: 9 } }],
    [{ relativePath: "a.png", before: { size: 3 }, after: { size: 4 } }],
    [{ relativePath: "a.txt", beforeBuffer: "same", afterBuffer: "same" }]
  ])("diffFileContents 统一入口新旧一致 %j", (input) => {
    expect(mod.diffFileContents(input as any)).toEqual(legacy.diffFileContents(input as any));
  });

  test("diffFileContents 只有一侧 buffer 时另一侧按空文本参与（新旧一致）", () => {
    expect(mod.diffFileContents({ relativePath: "a.txt", afterBuffer: "new content" }))
      .toEqual(legacy.diffFileContents({ relativePath: "a.txt", afterBuffer: "new content" }));
  });
});
