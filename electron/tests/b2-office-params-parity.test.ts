/**
 * B2-7 office-params 域对拍：parseOfficeArgs / collectReferencedPaths / ensureOfficeOutputDirs。
 *
 * parseOfficeArgs/collectReferencedPaths 零 IO 纯函数：旧侧物理路径动态 import（与生产
 * 过渡桥同一加载形态）+ 新侧静态 import，逐用例同入参双侧执行 toEqual + 绝对断言锚定。
 * ensureOfficeOutputDirs 有真实 mkdir IO：每侧独立 mkdtemp workspace（双侧共享会因
 * existsSync 二次跑空），同参数双侧各自落盘后比对 created 记录 + 验证目录真实存在。
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as modern from "../src/main/backend/office-params";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "../..");

const legacy = (await import(
  pathToFileURL(path.join(PROJECT_ROOT, "server", "office-params.mjs")).href
)) as unknown as typeof modern;

const TMP_DIRS: string[] = [];

afterAll(() => {
  for (const dir of TMP_DIRS) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

/** 每侧独立临时 workspace（mkdir 落盘隔离）。 */
function makeWs(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2op-"));
  TMP_DIRS.push(dir);
  return dir;
}

describe("B2-7 对拍：parseOfficeArgs", () => {
  /** 同入参双侧执行 + 比对，返回新侧结果。 */
  function both(input: any): string[] {
    const oldOut = legacy.parseOfficeArgs(input);
    const newOut = modern.parseOfficeArgs(input);
    expect(newOut).toEqual(oldOut);
    return newOut;
  }

  it("基础分词 + 多空格 + 空输入", () => {
    expect(both("--convert a.docx -o out/x.html")).toEqual(["--convert", "a.docx", "-o", "out/x.html"]);
    expect(both("  a   b  ")).toEqual(["a", "b"]);
    expect(both("")).toEqual([]);
    expect(both(null)).toEqual([]);
    expect(both(undefined)).toEqual([]);
  });

  it("转义引号与普通引号同效（引号字符不进值、反斜杠丢弃）", () => {
    expect(both('--prop author=\\"规聚 Agent\\"')).toEqual(["--prop", "author=规聚 Agent"]);
    expect(both('--prop author="规聚 Agent"')).toEqual(["--prop", "author=规聚 Agent"]);
    expect(both("--prop author='规聚 Agent'")).toEqual(["--prop", "author=规聚 Agent"]);
  });

  it("joinPropValues：裸写空格值并回；选项与 key=value 停止拼接；--prop 尾随直通", () => {
    expect(both("--prop author=规聚 Agent")).toEqual(["--prop", "author=规聚 Agent"]);
    expect(both("--prop x=1 --prop y=2")).toEqual(["--prop", "x=1", "--prop", "y=2"]);
    expect(both("--prop a -o out")).toEqual(["--prop", "a", "-o", "out"]);
    expect(both("--prop")).toEqual(["--prop"]);
    expect(both("普通token --prop 裸值 续行")).toEqual(["普通token", "--prop", "裸值 续行"]);
  });
});

describe("B2-7 对拍：collectReferencedPaths", () => {
  /** 同入参双侧执行 + 比对，返回新侧结果。 */
  function both(args: any): string[] {
    const oldOut = legacy.collectReferencedPaths(args);
    const newOut = modern.collectReferencedPaths(args);
    expect(newOut).toEqual(oldOut);
    return newOut;
  }

  it("--input 形式：下一 token 剥 key= 前缀入列（尾随 --input 无 next 不入列）", () => {
    expect(both(["--input", "src=报告.md"])).toEqual(["报告.md"]);
    expect(both(["--input", "plain.md"])).toEqual(["plain.md"]);
    expect(both(["--input"])).toEqual([]);
  });

  it("looksLikePath 族：key= 前缀剥除 + 后缀判定（docx/json/png/jpeg/pbf 等）", () => {
    expect(both(["--prop", "src=报告.md", "--prop", "path=数据.json", "图片.png", "a.jpeg", "map.pbf", "表.xlsx"]))
      .toEqual(["报告.md", "数据.json", "图片.png", "a.jpeg", "map.pbf", "表.xlsx"]);
  });

  it("非 path 排除：- 开头 / / 开头 / 盘符路径 / 无后缀；去重；非数组防御", () => {
    expect(both(["-o", "out/x.html", "/abs.md", "D:\\abs\\b.md", "noext", "--input"])).toEqual(["out/x.html"]);
    expect(both(["a.md", "a.md"])).toEqual(["a.md"]);
    expect(both("not-array")).toEqual([]);
  });
});

describe("B2-7 对拍：ensureOfficeOutputDirs", () => {
  /** 同参数双侧各自独立 ws 执行 + created 比对。 */
  function both(args: any[]): { oldOut: string[]; newOut: string[]; oldWs: string; newWs: string } {
    const oldWs = makeWs();
    const newWs = makeWs();
    const oldOut = legacy.ensureOfficeOutputDirs(args, oldWs);
    const newOut = modern.ensureOfficeOutputDirs(args, newWs);
    expect(newOut).toEqual(oldOut);
    return { oldOut, newOut, oldWs, newWs };
  }

  it("-o 相对路径：mkdir 真实落盘 + 记录相对路径（正斜杠）", () => {
    const { newOut, newWs } = both(["-o", ".work/review.html"]);
    expect(newOut).toEqual([".work"]);
    expect(fs.existsSync(path.join(newWs, ".work"))).toBe(true);
  });

  it("--output= 形式 + 多级 recursive mkdir", () => {
    const { newOut, newWs } = both(["--output=reports/sub/x.md"]);
    expect(newOut).toEqual(["reports/sub"]);
    expect(fs.existsSync(path.join(newWs, "reports", "sub"))).toBe(true);
  });

  it("已存在目录不重复记录；单文件名（dir===root 且 root 已存在）不记录", () => {
    const oldWs = makeWs();
    const newWs = makeWs();
    fs.mkdirSync(path.join(newWs, "work"), { recursive: true });
    fs.mkdirSync(path.join(oldWs, "work"), { recursive: true });
    const oldOut = legacy.ensureOfficeOutputDirs(["-o", "work/x.txt"], oldWs);
    const newOut = modern.ensureOfficeOutputDirs(["-o", "work/x.txt"], newWs);
    expect(newOut).toEqual(oldOut);
    expect(newOut).toEqual([]);
    const oldFlat = legacy.ensureOfficeOutputDirs(["-o", "review.html"], oldWs);
    const newFlat = modern.ensureOfficeOutputDirs(["-o", "review.html"], newWs);
    expect(newFlat).toEqual(oldFlat);
    expect(newFlat).toEqual([]);
  });

  it("跳过族：绝对路径 / 盘符 / .. 逃逸 / 非数组 args", () => {
    const { newOut } = both(["--output=D:\\abs\\out.html", "-o", "/abs.md", "-o", "../esc.html"]);
    expect(newOut).toEqual([]);
    expect(modern.ensureOfficeOutputDirs("not-array" as any, makeWs())).toEqual(legacy.ensureOfficeOutputDirs("not-array" as any, makeWs()));
  });
});
