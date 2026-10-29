/**
 * B2-7 office-params 域：parseOfficeArgs / collectReferencedPaths / ensureOfficeOutputDirs。
 *
 * R6-7a 对拍退役改写：旧侧 server/office-params.mjs 物理路径动态 import
 * （pathToFileURL）随 server/ 退役删除（等价性已在 B2-7 批对拍验收冻结），仅保留
 * modern 静态 import src/main/backend/office-params.ts 的同一套绝对断言。
 * parseOfficeArgs/collectReferencedPaths 零 IO 纯函数；ensureOfficeOutputDirs 有真实
 * mkdir IO：独立 mkdtemp workspace 隔离，验证 created 记录 + 目录真实存在。
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as modern from "../src/main/backend/office-params";

const TMP_DIRS: string[] = [];

afterAll(() => {
  for (const dir of TMP_DIRS) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

/** 独立临时 workspace（mkdir 落盘隔离）。 */
function makeWs(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2op-"));
  TMP_DIRS.push(dir);
  return dir;
}

describe("B2-7 office-params：parseOfficeArgs", () => {
  /** 同入参单侧执行，返回结果。 */
  function both(input: any): string[] {
    return modern.parseOfficeArgs(input);
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

describe("B2-7 office-params：collectReferencedPaths", () => {
  /** 同入参单侧执行，返回结果。 */
  function both(args: any): string[] {
    return modern.collectReferencedPaths(args);
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

describe("B2-7 office-params：ensureOfficeOutputDirs", () => {
  /** 独立 ws 执行，返回 created 记录。 */
  function both(args: any[]): string[] {
    return modern.ensureOfficeOutputDirs(args, makeWs());
  }

  it("-o 相对路径：mkdir 真实落盘 + 记录相对路径（正斜杠）", () => {
    const newWs = makeWs();
    const newOut = modern.ensureOfficeOutputDirs(["-o", ".work/review.html"], newWs);
    expect(newOut).toEqual([".work"]);
    expect(fs.existsSync(path.join(newWs, ".work"))).toBe(true);
  });

  it("--output= 形式 + 多级 recursive mkdir", () => {
    const newWs = makeWs();
    const newOut = modern.ensureOfficeOutputDirs(["--output=reports/sub/x.md"], newWs);
    expect(newOut).toEqual(["reports/sub"]);
    expect(fs.existsSync(path.join(newWs, "reports", "sub"))).toBe(true);
  });

  it("已存在目录不重复记录；单文件名（dir===root 且 root 已存在）不记录", () => {
    const ws = makeWs();
    fs.mkdirSync(path.join(ws, "work"), { recursive: true });
    expect(modern.ensureOfficeOutputDirs(["-o", "work/x.txt"], ws)).toEqual([]);
    expect(modern.ensureOfficeOutputDirs(["-o", "review.html"], ws)).toEqual([]);
  });

  it("跳过族：绝对路径 / 盘符 / .. 逃逸 / 非数组 args", () => {
    expect(both(["--output=D:\\abs\\out.html", "-o", "/abs.md", "-o", "../esc.html"])).toEqual([]);
    expect(modern.ensureOfficeOutputDirs("not-array" as any, makeWs())).toEqual([]);
  });
});
