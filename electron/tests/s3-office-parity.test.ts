/**
 * S3-4 对拍：旧 server JS ↔ 新 electron TS（office.mjs 全量转录为 backend/office.ts）。
 *
 * 覆盖：
 *  - 导出面完整性（15 导出逐名对齐，防漏转录）；
 *  - validateOfficecliArgs：空命令/非 file 命令/大小写归一/相对路径/工作区内绝对路径归一/
 *    越界拒绝（绝对 + ..）/反斜杠分隔/query·save file-arg 判定/默认 cwd 锚点一致性；
 *  - isOfficeSharingViolation：EN/CN 三形态命中 + 未命中 + null/undefined；
 *  - checkOfficecli：缺失二进制分支（逐字相等）+ 探针缓存按 executable 分键（toBe 同对象）
 *    + 失败 TTL 15s 重算（fake Date）；
 *  - runOfficecli：原生未命中回退 CLI（--version needsCli）→ officeLimiter 门控 spawn
 *    缺失二进制 → OFFICECLI_START_FAILED（message/args 逐字对拍，证明 TS pi-runtime.ts
 *    officeLimiter 直绑在 run 门控链路可用）；
 *  - L1/L2 包装参数序：view/get/set/batch/sheetJson/workbookInfo 经拒绝 details.args
 *    对拍（旧 JS 无注入面，spawn 失败形态是唯一稳定锚点）；
 *  - withPreviewCopy 传播：queryComments/renderHtml（临时副本创建后 CLI 启动失败，拒绝
 *    码/args 对拍）；startWatch 错误 entry + stopWatch 清理。
 *
 * 设计：
 *  - import 前 stub OFFICECLI_BIN=不存在的绝对路径（双侧 workspace 模块 import 时求值，
 *    包装面缺省 executable 落到同一缺失路径，任意机器确定性）；OAW_DATA_DIR/OAW_RUNTIME_
 *    RECORD_FILE 等按 b6-pi-runtime-parity 同口径（officeLimiter 经 pi-runtime 单例，
 *    import 副作用落临时目录，不触碰真实 .oaw）；
 *  - spawn 真实进程的成功路径（输出解析/锁恢复 close 重试/watch 常驻预览/成功 TTL 60s）
 *    依赖 officecli 二进制，由 smoke/真机验证，不在对拍面。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type AnyMod = Record<string, any>;

let root = "";
let ws = "";
let missingCli = "";
let old: AnyMod;
let nw: AnyMod;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "s3-office-parity-"));
  ws = path.join(root, "ws");
  fs.mkdirSync(ws, { recursive: true });
  missingCli = path.join(root, "cli-missing.exe");
  vi.stubEnv("OFFICECLI_BIN", missingCli);
  vi.stubEnv("OAW_DATA_DIR", path.join(root, "应用数据"));
  vi.stubEnv("OAW_LOCAL_PI_AGENT_DIR", "");
  vi.stubEnv("PI_AGENT_DIR", "");
  vi.stubEnv("APPDATA", path.join(root, "AppData", "Roaming"));
  vi.stubEnv("USERPROFILE", path.join(root, "主目录"));
  vi.stubEnv("OAW_RUNTIME_RECORD_FILE", path.join(root, "运行时记录.json"));
  vi.stubEnv("OAW_MAX_AGENT_RUNS", "");
  vi.stubEnv("OAW_MAX_OFFICECLI", "");
  vi.stubEnv("OAW_MODEL_NETWORK_MODE", "");
  [old, nw] = await Promise.all([
    import("@legacy-server/office.mjs") as unknown as Promise<AnyMod>,
    import("../src/main/backend/office") as unknown as Promise<AnyMod>,
  ]);
});

afterAll(async () => {
  try { await Promise.all([old.stopAllWatches(), nw.stopAllWatches()]); } catch {}
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("b3-office-parity 导出面完整性", () => {
  it("15 导出逐名对齐（防漏转录）", () => {
    expect(Object.keys(nw).sort()).toEqual(Object.keys(old).sort());
  });

  it("workspace 锚点一致（WORKSPACE_DIR 同值）", async () => {
    const [legacyWs, tsWs] = await Promise.all([
      import("@legacy-server/workspace.mjs") as unknown as AnyMod,
      import("../src/main/backend/workspace") as unknown as AnyMod,
    ]);
    expect(tsWs.WORKSPACE_DIR).toBe(legacyWs.WORKSPACE_DIR);
  });
});

describe("b3-office-parity validateOfficecliArgs", () => {
  it("空命令：OFFICECLI_ARGS_INVALID（message/code 逐字对拍）", () => {
    const tsErr = (() => { try { nw.validateOfficecliArgs([]); } catch (e: any) { return e; } return null; })();
    const oldErr = (() => { try { old.validateOfficecliArgs([]); } catch (e: any) { return e; } return null; })();
    expect(tsErr?.code).toBe("OFFICECLI_ARGS_INVALID");
    expect(tsErr?.message).toBe(oldErr?.message);
    expect(oldErr?.code).toBe("OFFICECLI_ARGS_INVALID");
  });

  it("非 file 命令 / 大小写归一 / 相对路径 / 工作区内绝对路径归一（新旧 toEqual）", () => {
    expect(nw.validateOfficecliArgs(["--version"])).toEqual(old.validateOfficecliArgs(["--version"]));
    expect(nw.validateOfficecliArgs(["VIEW", "报告.docx", "text"], ws)).toEqual(old.validateOfficecliArgs(["VIEW", "报告.docx", "text"], ws));
    expect(nw.validateOfficecliArgs(["get", "sub/报告.docx"], ws)).toEqual(old.validateOfficecliArgs(["get", "sub/报告.docx"], ws));
    const absInside = path.join(ws, "报告.docx");
    expect(nw.validateOfficecliArgs(["set", absInside], ws)).toEqual(old.validateOfficecliArgs(["set", absInside], ws));
    expect(nw.validateOfficecliArgs(["set", absInside], ws).absolute).toBe(true);
    // 反斜杠分隔（无 .. 段）：允许并归一
    expect(nw.validateOfficecliArgs(["get", "a\\b.docx"], ws)).toEqual(old.validateOfficecliArgs(["get", "a\\b.docx"], ws));
  });

  it("越界拒绝：绝对路径出界 + .. 相对出界（message/code 逐字对拍）", () => {
    const outside = path.join(root, "outside.docx");
    const grab = (fn: () => unknown) => { try { fn(); } catch (e: any) { return { message: e.message, code: e.code }; } return null; };
    expect(grab(() => nw.validateOfficecliArgs(["get", outside], ws))).toEqual(grab(() => old.validateOfficecliArgs(["get", outside], ws)));
    expect(grab(() => nw.validateOfficecliArgs(["get", outside], ws))?.code).toBe("OFFICE_PATH_SCOPE_ERROR");
    expect(grab(() => nw.validateOfficecliArgs(["set", "../outside.docx"], ws))).toEqual(grab(() => old.validateOfficecliArgs(["set", "../outside.docx"], ws)));
    expect(grab(() => nw.validateOfficecliArgs(["set", "../outside.docx"], ws))?.code).toBe("OFFICE_PATH_SCOPE_ERROR");
  });

  it("file-arg 命令表覆盖：query 取文件 / save 无文件 / 默认 cwd 锚点（新旧一致）", () => {
    expect(nw.validateOfficecliArgs(["query", "f.docx", "comment"], ws)).toEqual(old.validateOfficecliArgs(["query", "f.docx", "comment"], ws));
    expect(nw.validateOfficecliArgs(["save"], ws)).toEqual(old.validateOfficecliArgs(["save"], ws));
    expect(nw.validateOfficecliArgs(["save"], ws).file).toBeNull();
    const mine = nw.validateOfficecliArgs(["get", "a.docx"]);
    const theirs = old.validateOfficecliArgs(["get", "a.docx"]);
    expect(mine).toEqual(theirs);
    expect(mine.path).toBe(theirs.path);
  });
});

describe("b3-office-parity isOfficeSharingViolation", () => {
  it("EN/CN 命中 + 未命中 + 空入参（新旧一致）", () => {
    const cases: Array<[any, boolean]> = [
      [{ stderr: "io_error: The file is being used by another process" }, true],
      [{ stdout: "sharing violation on 报告.docx" }, true],
      [{ text: "文档正在被另一个进程使用" }, true],
      [{ stderr: "some other error" }, false],
      [{}, false],
      [null, false],
      [undefined, false],
    ];
    for (const [input] of cases) {
      expect(nw.isOfficeSharingViolation(input)).toBe(old.isOfficeSharingViolation(input));
    }
    expect(nw.isOfficeSharingViolation({ stderr: "io_error: The file is being used by another process" })).toBe(true);
    expect(nw.isOfficeSharingViolation(null)).toBe(false);
  });
});

describe("b3-office-parity checkOfficecli 探测与缓存", () => {
  it("缺失二进制分支：available:false 逐字相等 + 缓存按 executable 分键（toBe 同对象）", async () => {
    const exeA = path.join(root, "probe-a.exe");
    const mine = await nw.checkOfficecli(1000, exeA);
    const theirs = await old.checkOfficecli(1000, exeA);
    expect(mine).toEqual(theirs);
    expect(mine).toEqual({ available: false, path: exeA, code: null, message: `Office CLI 文件不存在：${exeA}` });
    expect(await nw.checkOfficecli(1000, exeA)).toBe(mine);
    expect(await old.checkOfficecli(1000, exeA)).toBe(theirs);
    const exeB = path.join(root, "probe-b.exe");
    expect(await nw.checkOfficecli(1000, exeB)).not.toBe(mine);
    expect(await old.checkOfficecli(1000, exeB)).not.toBe(theirs);
  });

  it("失败缓存 TTL：15s 内命中同对象，超 TTL 重算（fake Date，双侧）", async () => {
    const exeT = path.join(root, "probe-ttl.exe");
    const mine = await nw.checkOfficecli(1000, exeT);
    expect(await nw.checkOfficecli(1000, exeT)).toBe(mine);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.advanceTimersByTime(15001);
      const recomputed = await nw.checkOfficecli(1000, exeT);
      expect(recomputed).not.toBe(mine);
      expect(recomputed).toEqual(mine);
    } finally {
      vi.useRealTimers();
    }
    const theirs = await old.checkOfficecli(1000, exeT);
    expect(await old.checkOfficecli(1000, exeT)).toBe(theirs);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.advanceTimersByTime(15001);
      expect(await old.checkOfficecli(1000, exeT)).not.toBe(theirs);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("b3-office-parity runOfficecli 原生未命中回退 + 启动失败传播", () => {
  it("原生 null → viaCli → officeLimiter spawn 缺失二进制：OFFICECLI_START_FAILED（message/args 逐字对拍）", async () => {
    const grab = async (mod: AnyMod) => {
      try {
        await mod.runOfficecli(["--version"], { cwd: ws, executable: missingCli });
        return null;
      } catch (e: any) {
        return { message: e.message, code: e.code, executable: e.executable, args: e.args, cwd: e.cwd };
      }
    };
    const mine = await grab(nw);
    const theirs = await grab(old);
    expect(mine).toEqual(theirs);
    expect(mine?.code).toBe("OFFICECLI_START_FAILED");
    expect(mine?.args).toEqual(["--version"]);
    expect(mine?.executable).toBe(missingCli);
    expect(mine?.message).toContain("ENOENT");
  });

  it("L1/L2 包装参数序：view/get/set/batch/sheetJson/workbookInfo（经拒绝 details.args 对拍）", async () => {
    const grabArgs = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        return null;
      } catch (e: any) {
        return { code: e.code, args: e.args, cwd: e.cwd };
      }
    };
    const cases: Array<[string, () => Promise<unknown>, () => Promise<unknown>, string[]]> = [
      ["view html", () => nw.view("f.docx", "html"), () => old.view("f.docx", "html"), ["view", "f.docx", "html"]],
      ["view extra", () => nw.view("f.docx", "text", ["--compact"]), () => old.view("f.docx", "text", ["--compact"]), ["view", "f.docx", "text", "--compact"]],
      ["get 缺省", () => nw.get("f.xlsx"), () => old.get("f.xlsx"), ["get", "f.xlsx", "/", "--depth", "2", "--json"]],
      ["get 显式", () => nw.get("f.xlsx", "/表1", 3), () => old.get("f.xlsx", "/表1", 3), ["get", "f.xlsx", "/表1", "--depth", "3", "--json"]],
      ["set 缺省", () => nw.set("f.docx"), () => old.set("f.docx"), ["set", "f.docx", "/", "--json"]],
      ["set props", () => nw.set("f.docx", "/", ["a=1", "b=2"]), () => old.set("f.docx", "/", ["a=1", "b=2"]), ["set", "f.docx", "/", "--prop", "a=1", "--prop", "b=2", "--json"]],
      ["batch", () => nw.batch("f.docx", [{ command: "add", path: "/body/p[1]" }]), () => old.batch("f.docx", [{ command: "add", path: "/body/p[1]" }]), ["batch", "f.docx", "--commands", JSON.stringify([{ command: "add", path: "/body/p[1]" }]), "--json"]],
      ["sheetJson 命名", () => nw.sheetJson("f.xlsx", "Sheet1"), () => old.sheetJson("f.xlsx", "Sheet1"), ["get", "f.xlsx", "/Sheet1", "--depth", "3", "--json"]],
      ["sheetJson 缺省", () => nw.sheetJson("f.xlsx"), () => old.sheetJson("f.xlsx"), ["get", "f.xlsx", "/", "--depth", "3", "--json"]],
      ["workbookInfo", () => nw.workbookInfo("f.xlsx"), () => old.workbookInfo("f.xlsx"), ["get", "f.xlsx", "/", "--depth", "1", "--json"]],
    ];
    for (const [name, mineFn, theirsFn] of cases) {
      const mine = await grabArgs(mineFn);
      const theirs = await grabArgs(theirsFn);
      expect(mine, name).toEqual(theirs);
      expect(mine?.code, name).toBe("OFFICECLI_START_FAILED");
    }
  });
});

describe("b3-office-parity withPreviewCopy 传播 + watch 错误路径", () => {
  it("queryComments/renderHtml：临时副本创建后 CLI 启动失败，拒绝码/args 对拍", async () => {
    const src = path.join(ws, "预览源.docx");
    fs.writeFileSync(src, Buffer.from("PK\x03\x04 fake docx"));
    // 预览临时目录为每次调用独立 mkdtemp（规聚预览-XXXX），双侧目录名必然不同：
    // 归一化随机段后对拍（保真点 = 目录前缀/文件名/参数序/拒绝码一致）。
    const grab = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        return null;
      } catch (e: any) {
        return {
          code: e.code,
          args: e.args?.map((a: any) => typeof a === "string" ? a.replace(/规聚预览-[^\\/]+/, "规聚预览-<tmp>") : a),
        };
      }
    };
    const mineQ = await grab(() => nw.queryComments(src));
    const theirsQ = await grab(() => old.queryComments(src));
    expect(mineQ).toEqual(theirsQ);
    expect(mineQ?.code).toBe("OFFICECLI_START_FAILED");
    expect(mineQ?.args?.[0]).toBe("query");
    const mineR = await grab(() => nw.renderHtml(src));
    const theirsR = await grab(() => old.renderHtml(src));
    expect(mineR).toEqual(theirsR);
    expect(mineR?.code).toBe("OFFICECLI_START_FAILED");
    expect(mineR?.args?.[0]).toBe("view");
    expect(mineR?.args?.[2]).toBe("html");
    expect(mineR?.args).toContain("--out");
  });

  it("startWatch 缺失二进制：error entry 双侧一致 + stopWatch 幂等清理", async () => {
    const src = path.join(ws, "watch源.docx");
    fs.writeFileSync(src, Buffer.from("PK\x03\x04 fake docx"));
    const mine = await nw.startWatch(src);
    const theirs = await old.startWatch(src);
    expect((mine as any).ready).toBe(true);
    expect((mine as any).error).toBe((theirs as any).error);
    expect((mine as any).error).toContain("ENOENT");
    expect((mine as any).port).toBe((theirs as any).port);
    expect(() => nw.stopWatch(src)).not.toThrow();
    expect(() => old.stopWatch(src)).not.toThrow();
  });
});
