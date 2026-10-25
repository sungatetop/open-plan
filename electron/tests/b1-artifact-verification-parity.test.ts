/**
 * B1-1 备料批对拍：artifact-verification.ts（自 server/artifact-verification.mjs 71 行转录）。
 *
 * 纯函数域对拍：双侧动态 import（旧侧物理路径加载真实仓库源文件，锚点保真），
 * 同脚本双侧执行 + checkedAt 归一后比对。覆盖全部校验分支：
 * Office ZIP 容器签名（passed/failed）/ PDF 文件头 / 文本（空文件·空白内容·JSON 可解析与坏结构）/
 * 图片 / not_applicable / 工作区外 / 文件不存在 / 目录 / validateArtifacts 数组形态与默认 root。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as fresh from "../src/main/backend/artifact-verification";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OLD_URL = pathToFileURL(path.resolve(HERE, "../../server/artifact-verification.mjs")).href;

type Side = typeof fresh;
let oldSide: Side;

/** 双侧同脚本执行：run(侧) 返回可归一化结果，断言双侧相等。 */
async function runBoth<T>(run: (side: Side) => Promise<T> | T): Promise<{ old: T; fresh: T }> {
  const o = await run(oldSide);
  const f = await run(fresh);
  return { old: o, fresh: f };
}

/** checkedAt（当前时刻）归一，其余保留。 */
function normResult(value: any) {
  const clone = JSON.parse(JSON.stringify(value));
  if (clone?.checkedAt) clone.checkedAt = "<TS>";
  return clone;
}

function normResults(values: any[]) {
  return values.map(normResult);
}

/** 在 root 下写一个产物文件（二进制/文本），返回绝对路径。 */
function makeFile(root: string, name: string, content: string | Buffer): string {
  const file = path.join(root, name);
  fs.writeFileSync(file, content);
  return file;
}

const PK = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("dummy-zip-body")]);

describe("B1-1 artifact-verification 对拍", () => {
  it("旧模块动态加载 + 双侧导出面一致", async () => {
    oldSide = (await import(OLD_URL)) as unknown as Side;
    expect(typeof oldSide.validateArtifactFile).toBe("function");
    expect(typeof oldSide.validateArtifacts).toBe("function");
    expect(Object.keys(fresh).sort()).toEqual(Object.keys(oldSide).sort());
  });

  it("Office 扩展：ZIP 容器头 passed / 非 ZIP failed", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "b1-artifact-"));
    try {
      const { old: o, fresh: f } = await runBoth(async (side) => ({
        good: side.validateArtifactFile(makeFile(root, "report.docx", PK), root),
        bad: side.validateArtifactFile(makeFile(root, "bad.xlsx", Buffer.from("not-a-zip-at-all")), root),
        pptx: side.validateArtifactFile(makeFile(root, "deck.pptx", PK), root),
      }));
      expect(normResult(o.good)).toEqual(normResult(f.good));
      expect(f.good).toMatchObject({ status: "passed", format: "docx", message: "Office ZIP 容器签名正常", size: PK.length });
      expect(normResult(o.bad)).toEqual(normResult(f.bad));
      expect(f.bad).toMatchObject({ status: "failed", format: "xlsx", message: "不是有效的 Office ZIP 容器" });
      expect(f.pptx.status).toBe("passed");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("PDF：文件头 %PDF passed / 无效 failed", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "b1-artifact-"));
    try {
      const { old: o, fresh: f } = await runBoth(async (side) => ({
        good: side.validateArtifactFile(makeFile(root, "a.pdf", Buffer.from("%PDF-1.7 body")), root),
        bad: side.validateArtifactFile(makeFile(root, "b.pdf", Buffer.from("JUNKJUNK")), root),
      }));
      expect(normResult(o.good)).toEqual(normResult(f.good));
      expect(f.good).toMatchObject({ status: "passed", format: "pdf", message: "PDF 文件头正常", size: 13 });
      expect(normResult(o.bad)).toEqual(normResult(f.bad));
      expect(f.bad.status).toBe("failed");
      expect(f.bad.message).toBe("PDF 文件头无效");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("文本族：可读 passed / 空白 failed / JSON 可解析与坏结构 / geojson 同路径", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "b1-artifact-"));
    try {
      const { old: o, fresh: f } = await runBoth(async (side) => ({
        md: side.validateArtifactFile(makeFile(root, "note.md", "# 标题\n正文"), root),
        blank: side.validateArtifactFile(makeFile(root, "blank.txt", "   \n\t"), root),
        jsonGood: side.validateArtifactFile(makeFile(root, "data.json", '{"a":1}'), root),
        jsonBad: side.validateArtifactFile(makeFile(root, "bad.json", "{not-json"), root),
        geoBad: side.validateArtifactFile(makeFile(root, "bad.geojson", "<xml>"), root),
        csv: side.validateArtifactFile(makeFile(root, "t.csv", "a,b\n1,2"), root),
      }));
      expect(normResults(Object.values(o))).toEqual(normResults(Object.values(f)));
      expect(f.md).toMatchObject({ status: "passed", format: "md", message: "文本内容可读取" });
      expect(f.blank).toMatchObject({ status: "failed", message: "文本产物为空" });
      expect(f.jsonGood.message).toBe("文本内容可读取，JSON 结构可解析");
      expect(f.jsonBad).toMatchObject({ status: "failed", message: "JSON 结构不可解析" });
      expect(f.geoBad.message).toBe("JSON 结构不可解析");
      expect(f.csv.status).toBe("passed");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("图片 passed / 未登记扩展 not_applicable / 空文件 failed", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "b1-artifact-"));
    try {
      const { old: o, fresh: f } = await runBoth(async (side) => ({
        png: side.validateArtifactFile(makeFile(root, "img.png", Buffer.from([0x89, 0x50, 0x4e, 0x47])), root),
        bin: side.validateArtifactFile(makeFile(root, "blob.bin", Buffer.from([0x00, 0x01])), root),
        empty: side.validateArtifactFile(makeFile(root, "empty.md", Buffer.alloc(0)), root),
      }));
      expect(normResults(Object.values(o))).toEqual(normResults(Object.values(f)));
      expect(f.png).toMatchObject({ status: "passed", format: "png", message: "图片产物非空" });
      expect(f.bin).toMatchObject({ status: "not_applicable", format: "bin", message: "暂不执行该格式的结构校验" });
      expect(f.empty).toMatchObject({ status: "failed", message: "产物文件为空", size: 0 });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("边界：工作区外 / 文件不存在 / 目录 / 默认 root=dirname(file) / relativePath 反斜杠归一", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "b1-artifact-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "b1-outside-"));
    try {
      const outsideFile = makeFile(outside, "leak.md", "x");
      fs.mkdirSync(path.join(root, "subdir"));
      const { old: o, fresh: f } = await runBoth(async (side) => ({
        outside: side.validateArtifactFile(outsideFile, root),
        missing: side.validateArtifactFile(path.join(root, "nope.md"), root),
        dir: side.validateArtifactFile(path.join(root, "subdir"), root, "inside.md"),
        defaultRoot: side.validateArtifactFile(outsideFile),
        relNorm: side.validateArtifactFile(outsideFile, root, "sub\\dir\\leak.md"),
      }));
      expect(normResults(Object.values(o))).toEqual(normResults(Object.values(f)));
      expect(f.outside).toMatchObject({ path: "leak.md", status: "failed", message: "产物不在当前工作区内" });
      expect(f.missing).toMatchObject({ status: "failed", message: "产物文件不存在" });
      expect(f.dir).toMatchObject({ path: "inside.md", status: "failed", message: "产物不是文件" });
      // 默认 root：文件不在其自身所在目录的判定下必然通过 isInside，走正常读取分支
      expect(f.defaultRoot.status).toBe("passed");
      expect(f.relNorm.path).toBe("sub/dir/leak.md");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("validateArtifacts：字符串与 {path} 混合数组 / root 指定 / 空数组 / 非 root 相对解析", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "b1-artifact-"));
    try {
      makeFile(root, "ok.md", "内容");
      makeFile(root, "bad.json", "{oops");
      const { old: o, fresh: f } = await runBoth(async (side) => ({
        mixed: side.validateArtifacts(["ok.md", { path: "bad.json" }, "missing.md"], root),
        empty: side.validateArtifacts("nope" as unknown as string[], root),
        none: side.validateArtifacts([], root),
      }));
      expect(normResults(o.mixed)).toEqual(normResults(f.mixed));
      expect(f.mixed.map((r: any) => r.status)).toEqual(["passed", "failed", "failed"]);
      expect(f.mixed.map((r: any) => r.path)).toEqual(["ok.md", "bad.json", "missing.md"]);
      expect(f.empty).toEqual(f.none);
      expect(f.none).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
