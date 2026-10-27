/**
 * S3-15 两域对拍：legacy 物理 import server/{native-files,stream-connection}.mjs
 * vs modern 静态/动态 import TS backend/{同名}.ts。
 *
 * 锚定说明：
 *   - native-files：纯函数族（脚本生成/解析/转义/扩展名归一化）逐 case 互等；
 *     resolveWindowsBinary 在 win32 真机解析（explorer/cmd/powershell 绝对路径）；
 *     错误路径只走「不 spawn」分支（相对路径 PATH_NOT_ABSOLUTE、不存在路径
 *     OPEN/REVEAL_FAILED——existsSync 先挡）；linux 分支经 Object.defineProperty
 *     mock process.platform 触发 zenity ENOENT → PICKER_UNAVAILABLE（两侧对称），
 *     afterAll 恢复 win32。绝不真实调用 pickFiles/pickFolder（会弹系统对话框）。
 *   - stream-connection：登记表全导出对拍（同键去重/client 上限/supersede 宽限期/
 *     sweep probe 三态/quota/reject 503 语义/noteStreamWrite 记账/close 过滤）；
 *     supersede 超宽限期用 vi fake Date 推进 61s（两侧共享全局时钟，对称执行）；
 *     每用例后两侧 closeServerStreams() 清场（模块级 Map 单例，用例间隔离）。
 *   - stream-connection.mjs L203-255 分片三函数已随 B6-6-3 迁至
 *     agent/tool-output-split.ts（b6-agent-emit-parity 覆盖），本文件不重复对拍。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";

let legacyNF: any;
let modernNF: any;
let legacySC: any;
let modernSC: any;

beforeAll(async () => {
  legacyNF = await import("@legacy-server/native-files.mjs");
  modernNF = await import("../src/main/backend/native-files");
  legacySC = await import("@legacy-server/stream-connection.mjs");
  modernSC = await import("../src/main/backend/stream-connection");
});

/** 两侧同步执行同一操作，返回 [legacy 结果, modern 结果]。 */
function both<T>(fn: (mod: any) => T): [T, T] {
  return [fn(legacyNF), fn(modernNF)];
}

const ORIG_PLATFORM = process.platform;

function setPlatform(value: string) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

/* ===== native-files ===== */

describe("s3-native-stream-parity native-files 纯函数族", () => {
  it("appleScriptString：转义/空值语义互等", () => {
    const cases = ["abc", 'a"b', "a\\b", "", null, undefined, "多字节中文", "line\nbreak"];
    for (const c of cases) {
      const [l, m] = both((mod) => mod.appleScriptString(c));
      expect(m).toBe(l);
      expect(m).toBe(`"${String(c ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
    }
  });

  it("normalizeExtensions：去重保序/剥前缀/非法丢弃互等", () => {
    const cases: unknown[] = [
      ["docx", ".docx", "*.pdf", "docx", "A", ""],
      ["!!", "a b", "doc.x", 123, null, "*.doc"],
      [],
      "not-array",
      [".PDF", "pdf", "PDF"],
    ];
    for (const c of cases) {
      const [l, m] = both((mod) => mod.normalizeExtensions(c as any));
      expect(m).toEqual(l);
    }
    expect(modernNF.normalizeExtensions(["docx", ".docx", "*.pdf", "docx", "A"])).toEqual(["docx", "pdf", "a"]);
  });

  it("buildPickFilesScript：默认/多选/扩展名组合逐元素互等", () => {
    const cases = [
      {},
      { multiple: true },
      { extensions: ["docx", "pdf"] },
      { prompt: "选吧", multiple: true, extensions: [".xlsx", "*.csv", "xlsx"] },
    ];
    for (const c of cases) {
      const [l, m] = both((mod) => mod.buildPickFilesScript(c as any));
      expect(m).toEqual(l);
    }
    const single = modernNF.buildPickFilesScript({ extensions: ["docx"] });
    expect(single[0]).toBe("-e");
    expect(single[1]).toContain("choose file");
    expect(single[1]).toContain('of type {"docx"}');
    expect(single[1]).toContain("with prompt");
    expect(single[2]).toBe("-e");
    expect(single[3]).toBe("return POSIX path of theChoice");
    const multi = modernNF.buildPickFilesScript({ multiple: true });
    expect(multi[1]).toContain("with multiple selections allowed");
  });

  it("buildPickFolderScript：默认与自定义 prompt 互等", () => {
    for (const c of [{}, { prompt: "选目录" }]) {
      const [l, m] = both((mod) => mod.buildPickFolderScript(c as any));
      expect(m).toEqual(l);
    }
    expect(modernNF.buildPickFolderScript({ prompt: '带"引号"' })[1]).toContain('\\"引号\\"');
  });

  it("parseAppleScriptOutput：BOM/空行/trim/空值互等", () => {
    const cases = [
      "/a/b\n/c/d",
      "\uFEFF/a/b\n\n  /c/d  \n",
      "",
      null,
      undefined,
      "single",
      "\r\nx\r\ny\r\n",
    ];
    for (const c of cases) {
      const [l, m] = both((mod) => mod.parseAppleScriptOutput(c as any));
      expect(m).toEqual(l);
    }
    expect(modernNF.parseAppleScriptOutput("\uFEFF/a\n\n/b\n")).toEqual(["/a", "/b"]);
  });

  it("isAppleScriptCancel：错误码/文案/非取消互等", () => {
    const cases = [
      { stderr: "user canceled", message: "" },
      { stderr: "", message: "error -128 happened" },
      { message: "用户已取消" },
      { message: "(err=-1743)" },
      { message: "some other error" },
      null,
      undefined,
    ];
    for (const c of cases) {
      const [l, m] = both((mod) => mod.isAppleScriptCancel(c as any));
      expect(m).toBe(l);
    }
  });

  it("buildWindowsPickFilesScript：filter/多选/默认逐元素互等", () => {
    const cases = [
      {},
      { multiple: true },
      { extensions: ["docx", "xlsx"] },
      { prompt: "选择", multiple: true, extensions: ["csv"] },
    ];
    for (const c of cases) {
      const [l, m] = both((mod) => mod.buildWindowsPickFilesScript(c as any));
      expect(m).toEqual(l);
    }
    const script = modernNF.buildWindowsPickFilesScript({ extensions: ["docx", "xlsx"] });
    expect(script).toContain("Add-Type -AssemblyName System.Windows.Forms");
    expect(script).toContain("$owner.TopMost = $true");
    expect(script).toContain('"docx/xlsx (*.docx;*.xlsx)|*.docx;*.xlsx|所有文件 (*.*)|*.*"');
    expect(script).toContain("$dialog.Multiselect = $(false)");
    expect(script.endsWith("}")).toBe(true);
  });

  it("buildWindowsPickFolderScript：默认与自定义互等", () => {
    for (const c of [{}, { prompt: "选文件夹" }]) {
      const [l, m] = both((mod) => mod.buildWindowsPickFolderScript(c as any));
      expect(m).toEqual(l);
    }
    expect(modernNF.buildWindowsPickFolderScript({})).toContain("FolderBrowserDialog");
  });

  it("resolveWindowsBinary：win32 绝对路径解析两侧互等且落盘", () => {
    const cases = ["explorer.exe", "explorer", "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "foo", "C:\\Windows\\System32\\cmd.exe", ""];
    for (const c of cases) {
      const [l, m] = both((mod) => mod.resolveWindowsBinary(c));
      expect(m).toBe(l);
      if (m && path.isAbsolute(m)) {
        // 解析出的候选必须真实存在（explorer/cmd/powershell 三类命中 SystemRoot/System32）
        if (["explorer", "cmd", "powershell"].some((k) => m.toLowerCase().includes(k))) {
          expect(require("node:fs").existsSync(m)).toBe(true);
        }
      } else {
        // 未命中二进制原样返回（保持 PICKER_UNAVAILABLE / REVEAL_FAILED 报错路径）
        expect(m).toBe(c);
      }
    }
  });

  it("nativeCapabilities：win32 分支结构互等", () => {
    const [l, m] = both((mod) => mod.nativeCapabilities());
    expect(m).toEqual(l);
    expect(m.platform).toBe("win32");
    expect(m).toMatchObject({ picker: true, pickerKind: "powershell", open: true, reveal: true, fileManagerName: "资源管理器" });
  });

  it("nativePlatform：互等且为 win32", () => {
    const [l, m] = both((mod) => mod.nativePlatform());
    expect(m).toBe(l);
    expect(m).toBe("win32");
  });

  it("activePicker 空态：cancel 返回 false / info 为 null", () => {
    const [lc, mc] = both((mod) => mod.cancelActivePicker());
    expect(lc).toBe(false);
    expect(mc).toBe(false);
    const [li, mi] = both((mod) => mod.activePickerInfo());
    expect(li).toBeNull();
    expect(mi).toBeNull();
  });
});

describe("s3-native-stream-parity native-files 错误契约（不 spawn 分支）", () => {
  const NOT_EXIST = path.join(os.tmpdir(), "__no_such_native_files_target__");

  it("openWithDefaultApp：相对路径 → PATH_NOT_ABSOLUTE 文案逐字", async () => {
    for (const mod of [legacyNF, modernNF]) {
      await expect(mod.openWithDefaultApp("relative/file.txt")).rejects.toMatchObject({
        message: "需要绝对路径",
        code: "PATH_NOT_ABSOLUTE",
      });
    }
  });

  it("openWithDefaultApp：绝对路径不存在 → OPEN_FAILED「文件不存在」", async () => {
    for (const mod of [legacyNF, modernNF]) {
      await expect(mod.openWithDefaultApp(NOT_EXIST)).rejects.toMatchObject({
        message: "打开失败：文件不存在",
        code: "OPEN_FAILED",
      });
    }
  });

  it("revealInFileManager：相对路径 → PATH_NOT_ABSOLUTE；不存在 → REVEAL_FAILED", async () => {
    for (const mod of [legacyNF, modernNF]) {
      await expect(mod.revealInFileManager("relative/file.txt")).rejects.toMatchObject({
        message: "需要绝对路径",
        code: "PATH_NOT_ABSOLUTE",
      });
      await expect(mod.revealInFileManager(NOT_EXIST)).rejects.toMatchObject({
        message: "在文件管理器中显示失败：文件不存在",
        code: "REVEAL_FAILED",
      });
    }
  });
});

describe("s3-native-stream-parity native-files linux 分支（mock platform）", () => {
  beforeAll(() => setPlatform("linux"));
  afterAll(() => setPlatform(ORIG_PLATFORM));

  it("nativeCapabilities：zenity 分支互等", () => {
    const [l, m] = both((mod) => mod.nativeCapabilities());
    expect(m).toEqual(l);
    expect(m).toMatchObject({ platform: "linux", picker: true, pickerKind: "zenity", fileManagerName: "文件管理器" });
  });

  it("pickFiles：zenity 缺失 → PICKER_UNAVAILABLE 文案逐字（含 pickerKind）", async () => {
    for (const mod of [legacyNF, modernNF]) {
      await expect(mod.pickFiles({ prompt: "选文件" })).rejects.toMatchObject({
        message: "未找到系统选择器（zenity）",
        code: "PICKER_UNAVAILABLE",
      });
    }
  });

  it("pickFolder：zenity 缺失 → PICKER_UNAVAILABLE 文案逐字", async () => {
    for (const mod of [legacyNF, modernNF]) {
      await expect(mod.pickFolder({ prompt: "选目录" })).rejects.toMatchObject({
        message: "未找到系统选择器（zenity）",
        code: "PICKER_UNAVAILABLE",
      });
    }
  });

  it("win32 之外无 picker 的平台（mock darwin 缺失分支不可能，mock freebsd）→ PICKER_UNSUPPORTED", async () => {
    setPlatform("freebsd");
    for (const mod of [legacyNF, modernNF]) {
      await expect(mod.pickFiles({})).rejects.toMatchObject({
        message: "当前平台没有可用的原生文件选择器",
        code: "PICKER_UNSUPPORTED",
      });
      await expect(mod.pickFolder({})).rejects.toMatchObject({
        message: "当前平台没有可用的原生文件夹选择器",
        code: "PICKER_UNSUPPORTED",
      });
    }
    setPlatform("linux"); // 恢复到本 describe 的基准，避免 afterAll 双重恢复错位
  });
});

/** stream-connection 侧载体（与 native-files 侧互不干扰）。 */
function bothSC<T>(fn: (mod: any) => T): [T, T] {
  return [fn(legacySC), fn(modernSC)];
}

/* ===== stream-connection ===== */

describe("s3-native-stream-parity stream-connection 登记表", () => {
  afterEach(() => {
    bothSC((mod) => mod.closeServerStreams());
  });

  it("streamKeyOf：键格式互等", () => {
    const cases = [
      { path: "/api/agent/stream" },
      { path: "/api/agent/stream", client: "c1" },
      { path: "/api/agent/stream", client: "c1", thread: "t1" },
      { path: "/x", client: "", thread: "" },
    ];
    for (const c of cases) {
      const [l, m] = bothSC((mod) => mod.streamKeyOf(c as any));
      expect(m).toBe(l);
    }
    expect(modernSC.streamKeyOf({ path: "/a", client: "c", thread: "t" })).toBe("/a|c|t");
  });

  it("登记基础：id 形态/release 函数/replaced 空数组/list 字段互等", () => {
    const [l, m] = bothSC((mod) => mod.registerServerStream({ path: "/api/base", client: "cb", thread: "tb", note: "n1" }));
    expect(m.id).toBe(l.id.replace(/\d+/, (s: string) => s)); // id 序号两侧独立，比形态
    expect(typeof m.release).toBe("function");
    expect(m.replaced).toEqual([]);
    expect(m.replaced).toEqual(l.replaced);
    expect(String(m.id)).toMatch(/^stream-\d+$/);

    const [ll, lm] = bothSC((mod) => mod.listServerStreams());
    const mine = lm.find((e: any) => e.id === m.id);
    const theirs = ll.find((e: any) => e.id === l.id);
    expect(mine).toBeDefined();
    expect(mine.path).toBe(theirs!.path);
    expect(mine.client).toBe("cb");
    expect(mine.thread).toBe("tb");
    expect(mine.note).toBe("n1");
    expect(Object.keys(mine).sort()).toEqual(Object.keys(theirs!).sort());
    expect(mine.ageMs).toBeGreaterThanOrEqual(0);
    expect(mine.idleMs).toBeGreaterThanOrEqual(0);
    expect(mine.bytes).toBe(0);
  });

  it("同键去重：MAX_SAME_KEY=2，第 3/4 条顶掉最旧（reason=same-key，close 被调）", () => {
    const mk = (mod: any) => {
      const closes: string[] = [];
      const r1 = mod.registerServerStream({ path: "/api/dup", client: "cd", thread: "t", close: () => closes.push("r1") });
      const r2 = mod.registerServerStream({ path: "/api/dup", client: "cd", thread: "t", close: () => closes.push("r2") });
      const r3 = mod.registerServerStream({ path: "/api/dup", client: "cd", thread: "t", close: () => closes.push("r3") });
      const r4 = mod.registerServerStream({ path: "/api/dup", client: "cd", thread: "t", close: () => closes.push("r4") });
      return { closes, r1: r1.id, r2: r2.id, r3replaced: r3.replaced, r4replaced: r4.replaced, alive: mod.listServerStreams().filter((e: any) => e.path === "/api/dup").length };
    };
    const [l, m] = bothSC(mk);
    expect(m.r3replaced).toEqual(l.r3replaced);
    expect(m.r4replaced).toEqual(l.r4replaced);
    expect(m.r3replaced).toEqual([{ id: l.r1, reason: "same-key" }]);
    expect(m.r4replaced).toEqual([{ id: l.r2, reason: "same-key" }]);
    expect(m.closes).toEqual(["r1", "r2"]);
    expect(m.alive).toBe(2);
  });

  it("client 上限：MAX_PER_CLIENT=8，第 9 条顶掉最旧（reason=client-limit）", () => {
    const mk = (mod: any) => {
      const ids: string[] = [];
      let lastReplaced: any[] = [];
      for (let i = 0; i < 9; i++) {
        const r = mod.registerServerStream({ path: "/api/quota-test", client: "cl", thread: `t${i}` });
        ids.push(r.id);
        lastReplaced = r.replaced;
      }
      return { ids, lastReplaced, alive: mod.listServerStreams().filter((e: any) => e.client === "cl").length };
    };
    const [l, m] = bothSC(mk);
    // 每侧自洽：被顶的最旧一条 = 自侧第 1 条（两侧 seq 独立，不跨侧比 id）
    expect(m.lastReplaced).toEqual([{ id: m.ids[0], reason: "client-limit" }]);
    expect(l.lastReplaced).toEqual([{ id: l.ids[0], reason: "client-limit" }]);
    expect(m.alive).toBe(8);
    expect(m.alive).toBe(l.alive);
  });

  it("supersede 宽限期：60s 内快速注册 3 条不判旧（grace 保护）", () => {
    const mk = (mod: any) => {
      const replaced: any[][] = [];
      for (let i = 0; i < 3; i++) {
        replaced.push(mod.registerServerStream({ path: "/api/agent/stream", client: "cg", thread: `t${i}` }).replaced);
      }
      return { replaced, alive: mod.listServerStreams().filter((e: any) => e.path === "/api/agent/stream" && e.client === "cg").length };
    };
    const [l, m] = bothSC(mk);
    expect(m.replaced).toEqual(l.replaced);
    expect(m.replaced.every((r: any[]) => r.length === 0)).toBe(true);
    expect(m.alive).toBe(3);
  });

  it("supersede 超宽限期：stub Date.now 推进 61s → keep 条之外被顶（reason=superseded）", () => {
    // 用 Date.now spy 精确编排时钟（两侧共享全局 Date.now）：openedAt 全等时 sort
    // 稳定保持插入序，slice(keep) 命中第 3 条（插入序最新），超 grace 判旧。
    const t0 = 1_800_000_000_000;
    const spy = vi.spyOn(Date, "now");
    try {
      const mk = (mod: any) => {
        spy.mockReturnValue(t0);
        const ids: string[] = [];
        for (let i = 0; i < 3; i++) ids.push(mod.registerServerStream({ path: "/api/agent/stream", client: "cs", thread: `t${i}` }).id);
        spy.mockReturnValue(t0 + 61_000);
        const r4 = mod.registerServerStream({ path: "/api/agent/stream", client: "cs", thread: "t3" });
        const alive = mod.listServerStreams().filter((e: any) => e.path === "/api/agent/stream" && e.client === "cs").map((e: any) => e.id);
        return { ids, id4: r4.id, lastReplaced: r4.replaced, alive };
      };
      const [l, m] = bothSC(mk);
      expect(m.lastReplaced).toEqual([{ id: m.ids[2], reason: "superseded" }]);
      expect(l.lastReplaced).toEqual([{ id: l.ids[2], reason: "superseded" }]);
      // 存活 = e1/e2（keep 内）+ 新注册的第 4 条；e3 已被顶
      expect(m.alive).toEqual([m.ids[0], m.ids[1], m.id4]);
      expect(l.alive).toEqual([l.ids[0], l.ids[1], l.id4]);
    } finally {
      spy.mockRestore();
    }
  });

  it("sweepServerStreams：probe 三态（false 清/true 留/抛错清）+ 无 probe 跳过", () => {
    const mk = (mod: any) => {
      mod.registerServerStream({ path: "/api/sw", client: "c", thread: "t1", probe: () => false });
      mod.registerServerStream({ path: "/api/sw", client: "c", thread: "t2", probe: () => true });
      mod.registerServerStream({ path: "/api/sw", client: "c", thread: "t3", probe: () => { throw new Error("probe boom"); } });
      mod.registerServerStream({ path: "/api/sw", client: "c", thread: "t4" });
      const closed = mod.sweepServerStreams();
      const alive = mod.listServerStreams().map((e: any) => e.thread).sort();
      return { closed, alive };
    };
    const [l, m] = bothSC(mk);
    expect(m.closed).toBe(l.closed);
    expect(m.closed).toBe(2);
    expect(m.alive).toEqual(["t2", "t4"]);
  });

  it("releaseServerStream：存在 true / 不存在 false；release 闭包生效", () => {
    const mk = (mod: any) => {
      const r = mod.registerServerStream({ path: "/api/rel", client: "c", thread: "t" });
      const rel1 = r.release();
      const rel2 = r.release();
      const direct = mod.releaseServerStream("stream-999999");
      return { rel1, rel2, direct, alive: mod.listServerStreams().some((e: any) => e.id === r.id) };
    };
    const [l, m] = bothSC(mk);
    expect(m.rel1).toBe(true);
    expect(m.rel2).toBe(false);
    expect(m.direct).toBe(false);
    expect(m.alive).toBe(false);
    expect(m).toEqual(l);
  });

  it("noteStreamWrite：bytes 累加/lastWriteAt 推进（idleMs 走 lastWriteAt）/未注册 id 无操作", () => {
    const mk = (mod: any) => {
      const r = mod.registerServerStream({ path: "/api/w", client: "c", thread: "t" });
      mod.noteStreamWrite(r.id, 10);
      mod.noteStreamWrite(r.id, 32);
      mod.noteStreamWrite("stream-999999", 5);
      const item = mod.listServerStreams().find((e: any) => e.id === r.id);
      return { bytes: item.bytes, idleMs: item.idleMs };
    };
    const [l, m] = bothSC(mk);
    expect(m.bytes).toBe(42);
    expect(m.bytes).toBe(l.bytes);
    // lastWriteAt 已推进：idleMs 落在 lastWriteAt 侧（远小于 openedAt 起算的 age）
    expect(m.idleMs).toBeLessThan(5000);
    expect(() => bothSC((mod) => mod.noteStreamWrite("stream-999999", 1))).not.toThrow();
  });

  it("serverStreamStats：total/byPath/byClient/maxPerClient/maxSameKey/supersede 常量互等", () => {
    bothSC((mod) => {
      mod.registerServerStream({ path: "/api/st1", client: "cx", thread: "t1" });
      mod.registerServerStream({ path: "/api/st1", client: "cx", thread: "t2" });
      mod.registerServerStream({ path: "/api/st2", client: "cy", thread: "t3" });
      mod.registerServerStream({ path: "/api/st2" }); // 无 client → 不进 byClient
    });
    const [l, m] = bothSC((mod) => mod.serverStreamStats());
    expect(m).toEqual(l);
    expect(m.maxPerClient).toBe(8);
    expect(m.maxSameKey).toBe(2);
    expect(m.supersede).toEqual({
      "/api/agent/stream": { keep: 2, graceMs: 60000 },
      "/api/browser/stream": { keep: 2, graceMs: 5000 },
      "/api/agent/events": { keep: 2, graceMs: 5000 },
      "/api/memory/stream": { keep: 1, graceMs: 5000 },
    });
  });

  it("closeServerStreams：按 id/path/client 过滤 + 无过滤全清，close 回调触发", () => {
    const mk = (mod: any) => {
      const closedBy: string[] = [];
      const a = mod.registerServerStream({ path: "/api/cx", client: "c1", thread: "t", close: () => closedBy.push("a") });
      const b = mod.registerServerStream({ path: "/api/cy", client: "c1", thread: "t", close: () => closedBy.push("b") });
      mod.registerServerStream({ path: "/api/cy", client: "c2", thread: "t", close: () => closedBy.push("c") });
      const byId = mod.closeServerStreams({ id: a.id });
      const byPath = mod.closeServerStreams({ path: "/api/cy", client: "c2" });
      const byClient = mod.closeServerStreams({ client: "c1" });
      const all = mod.closeServerStreams();
      return { closedBy, byId, byPath, byClient, all, remaining: mod.listServerStreams().length };
    };
    const [l, m] = bothSC(mk);
    expect(m).toEqual(l);
    expect(m.byId).toBe(1);
    expect(m.byPath).toBe(1);
    expect(m.byClient).toBe(1);
    expect(m.all).toBe(0);
    expect(m.closedBy.sort()).toEqual(["a", "b", "c"]);
    expect(m.remaining).toBe(0);
  });

  it("streamQuotaOf：配额表内 current/ok 与表外 limit=0 互等", () => {
    bothSC((mod) => {
      for (let i = 0; i < 4; i++) mod.registerServerStream({ path: "/api/agent/events", client: `cq${i}`, thread: "t" });
      mod.registerServerStream({ path: "/api/not-in-quota", client: "cx", thread: "t" });
    });
    const [l1, m1] = bothSC((mod) => mod.streamQuotaOf("/api/agent/events"));
    expect(m1).toEqual(l1);
    expect(m1.limit).toBe(4);
    expect(m1.current).toBe(4);
    expect(m1.ok).toBe(false);
    const [l2, m2] = bothSC((mod) => mod.streamQuotaOf("/api/agent/stream"));
    expect(m2).toEqual(l2);
    expect(m2.limit).toBe(8);
    expect(m2.ok).toBe(true);
    const [l3, m3] = bothSC((mod) => mod.streamQuotaOf("/api/other"));
    expect(m3).toEqual(l3);
    expect(m3).toEqual({ path: "/api/other", limit: 0, current: 0, ok: true });
  });

  it("rejectStreamQuota：503 + Retry-After + body 互等；异常回退 end()", () => {
    const fakeRes = () => {
      const calls: any[] = [];
      return {
        calls,
        writeHead(code: number, headers: Record<string, string>) { calls.push({ op: "writeHead", code, headers }); return this; },
        end(data?: string) { calls.push({ op: "end", data }); return this; },
      };
    };
    const run = (mod: any) => {
      const res1 = fakeRes();
      const body1 = mod.rejectStreamQuota(res1 as any, { path: "/api/agent/stream", current: 8, limit: 8 });
      const res2 = fakeRes();
      const body2 = mod.rejectStreamQuota(res2 as any, { path: "/p", retryAfterSeconds: 0 });
      const res3 = fakeRes();
      (res3 as any).writeHead = () => { throw new Error("header already sent"); };
      const body3 = mod.rejectStreamQuota(res3 as any, { path: "/q" });
      const res4 = fakeRes();
      const body4 = mod.rejectStreamQuota(res4 as any);
      return {
        body1, body2, body3, body4,
        h1: res1.calls[0],
        e1: res1.calls[1],
        e2: res2.calls.filter((c: any) => c.op === "end").map((c: any) => c.data),
        e3: res3.calls,
        e4: res4.calls.filter((c: any) => c.op === "end").map((c: any) => c.data),
      };
    };
    const [l, m] = bothSC(run);
    expect(m.body1).toEqual(l.body1);
    expect(m.body1).toEqual({ ok: false, code: "STREAM_QUOTA_EXCEEDED", path: "/api/agent/stream", current: 8, limit: 8 });
    expect(m.h1.code).toBe(503);
    expect(m.h1.headers["Content-Type"]).toBe("application/json");
    expect(m.h1.headers["Cache-Control"]).toBe("no-store");
    expect(m.h1.headers["Retry-After"]).toBe("5");
    expect(m.e1.data).toEqual(l.e1.data);
    expect(JSON.parse(m.e1.data)).toEqual(m.body1);
    expect(m.e2).toEqual(l.e2);
    expect(JSON.parse(m.e2[0])).toEqual({ ok: false, code: "STREAM_QUOTA_EXCEEDED", path: "/p", current: 0, limit: 0 });
    // retryAfterSeconds=0 → Number(0)||5 → 5
    expect(m.h1.headers["Retry-After"]).toBe("5");
    expect(m.e3).toEqual([{ op: "end", data: undefined }]);
    expect(m.body3).toEqual({ ok: false, code: "STREAM_QUOTA_EXCEEDED", path: "/q", current: 0, limit: 0 });
    expect(m.e4).toEqual(l.e4);
  });
});
