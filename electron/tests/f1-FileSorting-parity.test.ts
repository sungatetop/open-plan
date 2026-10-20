import { describe, it, expect } from "vitest";
import { sortFiles } from "../src/renderer/lib/FileSorting";

const serverModule = await import("../../client/src/components/FileSorting.js");
const server = serverModule as unknown as { sortFiles: typeof sortFiles };

function makeList(): Array<Record<string, unknown>> {
  return [
    { name: "报告.pdf", ext: "pdf", isDir: false, mtime: "2026-10-01T10:00:00Z" },
    { name: "笔记.md", ext: "md", isDir: false, mtime: "2026-10-05T10:00:00Z" },
    { name: "build", isDir: true, mtime: "2026-09-01T10:00:00Z" },
    { name: "src", isDir: true },
    { name: "A.txt", ext: "TXT", isDir: false, mtime: "2026-03-01T10:00:00Z" },
    { name: "无扩展名", isDir: false },
    { name: "z.ts", ext: "ts", isDir: false, mtime: "not-a-date" },
    {},
  ];
}

const nameOf = (x: unknown): string | undefined => (x as { name?: string } | null)?.name;

describe("FileSorting TS 版与 client 版等价（对拍）", () => {
  it("time 模式（默认/显式/未知 mode 同分支）两侧一致", () => {
    for (const mode of [undefined, "time", "zzz"]) {
      const d = sortFiles(makeList(), mode);
      const s = server.sortFiles(makeList(), mode);
      expect(d).toEqual(s);
    }
    // 绝对锚点：目录在前（有 mtime 的在前），文件按 mtime 倒序、同值按名称
    const tie = [
      { name: "b", isDir: false, mtime: "2026-03-01T00:00:00Z" },
      { name: "a", isDir: false, mtime: "2026-03-01T00:00:00Z" },
      { name: "adir", isDir: true },
      { name: "bdir", isDir: true, mtime: "2025-01-01T00:00:00Z" },
      { name: "new", isDir: false, mtime: "2026-06-01T00:00:00Z" },
      { name: "old", isDir: false, mtime: "2026-01-01T00:00:00Z" },
    ];
    const out = sortFiles(tie.map((x) => ({ ...x })), "time");
    expect(out.map(nameOf)).toEqual(["bdir", "adir", "new", "a", "b", "old"]);
    const outS = server.sortFiles(tie.map((x) => ({ ...x })), "time");
    expect(out.map(nameOf)).toEqual(outS.map(nameOf));
  });

  it("type 模式：按扩展名分组（空扩展退回 zzzz），同组按名称；{} 落文件桶", () => {
    const d = sortFiles(makeList(), "type");
    const s = server.sortFiles(makeList(), "type");
    expect(d).toEqual(s);
    const names = d.map(nameOf);
    // 目录在前（build < src）；文件按小写扩展 md → pdf → ts → txt → ""(zzzz)；zzzz 组内 "" 在前
    expect(names).toEqual(["build", "src", "笔记.md", "报告.pdf", "z.ts", "A.txt", undefined, "无扩展名"]);
  });

  it("type 模式遇 null 项：JS 原版比较器直接取 a.ext 会抛错，两侧抛错行为一致", () => {
    const attempt = (fn: () => unknown): string => {
      try { fn(); return "no-throw"; } catch (e) { return `threw:${(e as Error).message}`; }
    };
    const d = attempt(() => sortFiles([null, { name: "a", ext: "x", isDir: false }], "type"));
    const s = attempt(() => server.sortFiles([null, { name: "a", ext: "x", isDir: false }], "type"));
    expect(d).toBe(s);
    expect(d).toContain("reading 'ext'");
  });

  it("非法 list：非数组返回 []；输入数组不被原地修改", () => {
    for (const bad of [null, undefined, "str", 123, false, {}]) {
      expect(sortFiles(bad)).toEqual([]);
      expect(sortFiles(bad)).toEqual(server.sortFiles(bad));
    }
    const original = makeList();
    const before = JSON.stringify(original);
    sortFiles(original, "type");
    sortFiles(original, "time");
    expect(JSON.stringify(original)).toBe(before);
  });
});