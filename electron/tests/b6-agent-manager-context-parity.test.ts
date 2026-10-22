/**
 * B6-6-4f 对拍：AgentManager 动态上下文 + 模块级残余批（server/agent.mjs）。
 *
 * 覆盖：
 * - buildDynamicContext（L4260-4300）：mode 三分支词条 / 记忆摘要截断（chat 800 其余 1500）
 *   / sharedMemCtx 共享跳过重读 / entry.workspace 缺省回退 getWorkspace / threadId 上下文
 *   文件名 / 异常吞错返回空串。
 * - writeContextFile（L4307-4345）：首写双文件（线程级权威 + 旧名兼容）/ 内容不变跳过
 *   落盘（mtime 断言）/ 内容变化重写 / 无 threadId 只写兼容文件 / sharedMemCtx 共享 /
 *   两侧产物逐字节一致。
 * - 模块级残余：buildOutputPolicyLines（L55-65）/ SESSION_STORE+findSessionFileForAgent+
 *   materializeSessionPath（L168-225）/ toolFingerprint（L359-362）/ RUN_BUDGET_ENFORCE+
 *   ensureRunBudget+emitBudgetEvent+stopRunByBudget（L366-394）/ noteRepeatedToolCall
 *   （L406-422）/ listAuth+setApiKey+removeApiKey（L4657-4682）/ ensureContextFile
 *   （L4793-4800）/ 常量 REPEATED_TOOL_WARN_AT、ASK_TIMEOUT_MS。
 *
 * 对拍范式：旧侧按行号提取源段 + new Function 同名参数注入求值。两个类方法体内无
 * this 引用 → 签名行机械替换为 function 声明后按普通函数对拍（比 4e 类体拼装轻量）；
 * 新侧经 AgentManager.prototype.buildDynamicContext/writeContextFile.call(fakeThis) 驱动，
 * fakeThis 只含 deps.readMemoryContext。共享依赖（getWorkspace/normalizeTaskMode/
 * atomicWriteFile/isInside/importLocalPiSessionFile/createRunBudget/budgetSnapshot/
 * toolFingerprint/clearInvalidCredential）注入已对拍的 TS 真实实现，两侧同流。
 * findSessionFileForAgent/materializeSessionPath 的 SESSION_STORE 旧侧替换为 __storeDir
 * 工厂参数、新侧用可选尾参 storeDir（缺省 SESSION_STORE，行为不变）；凭据族旧侧
 * agentManager/piRuntimeManager 单例以同名工厂参数注入 stub，新侧为 runtime seam 参数。
 * 凭据存储用内存 store（vi.hoisted + vi.mock pi-config-management），不触碰真实凭据文件。
 * 预算 hard 场景：vi.stubEnv + vi.resetModules + dynamic import 重新固化模块常量。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync, existsSync, utimesSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { AgentManager } from "../src/main/backend/agent/agent-manager";
import { buildOutputPolicyLines } from "../src/main/backend/agent/prompt-chain";
import { ASK_TIMEOUT_MS } from "../src/main/backend/agent/pending-asks";
import { REPEATED_TOOL_WARN_AT, toolFingerprint, noteRepeatedToolCall } from "../src/main/backend/agent/tool-repeat";
import { RUN_BUDGET_ENFORCE, ensureRunBudget, emitBudgetEvent } from "../src/main/backend/agent/budget-wiring";
import { SESSION_STORE, findSessionFileForAgent, materializeSessionPath } from "../src/main/backend/agent/session-store";
import { listAuth, setApiKey, removeApiKey } from "../src/main/backend/agent/provider-auth";
import { ensureContextFile } from "../src/main/backend/agent/context";
import { PROJECT_DIR, getWorkspace, isInside } from "../src/main/backend/workspace";
import { importLocalPiSessionFile } from "../src/main/backend/agent/pi-config-management";
import { atomicWriteFile } from "../src/main/backend/persistence-utils";
import { createRunBudget, budgetSnapshot } from "../src/shared/runtime/run-budget";
import { normalizeTaskMode } from "../src/shared/runtime/task";
import { clearInvalidCredential } from "../src/main/backend/agent/agent-errors";
import fsReal from "node:fs";
import nodePath from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LINES_AGENT = readFileSync(path.resolve(HERE, "../../server/agent.mjs"), "utf8").split("\n");
const segAgent = (start: number, end: number) => LINES_AGENT.slice(start - 1, end).join("\n").replace(/^export\s+/gm, "");

// 行号锚点：源文件结构变动导致偏移时，这里先行失败提醒更新提取区间
expect(segAgent(55, 55)).toContain("function buildOutputPolicyLines({ mode = \"work\" } = {}) {");
expect(segAgent(65, 65)).toContain("}");
expect(segAgent(168, 168)).toContain("const SESSION_STORE = path.join(PROJECT_DIR, \".规聚会话\");");
expect(segAgent(173, 173)).toContain("function findSessionFileForAgent(id) {");
expect(segAgent(209, 209)).toContain("}");
expect(segAgent(212, 212)).toContain("function materializeSessionPath(sessionPath) {");
expect(segAgent(225, 225)).toContain("}");
expect(segAgent(357, 357)).toContain("const REPEATED_TOOL_WARN_AT = 3;");
expect(segAgent(359, 359)).toContain("function toolFingerprint(name, args) {");
expect(segAgent(366, 366)).toContain("const RUN_BUDGET_ENFORCE = String(process.env.OAW_RUN_BUDGET_ENFORCE || \"soft\").toLowerCase();");
expect(segAgent(369, 369)).toContain("function ensureRunBudget(entry) {");
expect(segAgent(383, 383)).toContain("function emitBudgetEvent(entry, emit, level, code, reason) {");
expect(segAgent(390, 390)).toContain("function stopRunByBudget(entry) {");
expect(segAgent(394, 394)).toContain("}");
expect(segAgent(406, 406)).toContain("function noteRepeatedToolCall(entry, session, ev, emit) {");
expect(segAgent(422, 422)).toContain("}");
expect(segAgent(439, 439)).toContain("const ASK_TIMEOUT_MS = 300_000;");
expect(segAgent(4260, 4260)).toContain("buildDynamicContext(entry, file, sharedMemCtx = null) {");
expect(segAgent(4300, 4300)).toContain("}");
expect(segAgent(4307, 4307)).toContain("writeContextFile(entry, file, sharedMemCtx = null) {");
expect(segAgent(4345, 4345)).toContain("}");
expect(segAgent(4657, 4657)).toContain("function listAuth() {");
expect(segAgent(4662, 4662)).toContain("async function setApiKey(provider, key) {");
expect(segAgent(4675, 4675)).toContain("async function removeApiKey(provider) {");
expect(segAgent(4682, 4682)).toContain("}");
expect(segAgent(4793, 4793)).toContain("(function ensureContextFile() {");
expect(segAgent(4800, 4800)).toContain("})();");

// 常量锚点：与 agent.mjs 逐值一致
expect(ASK_TIMEOUT_MS).toBe(300_000);
expect(REPEATED_TOOL_WARN_AT).toBe(3);
expect(RUN_BUDGET_ENFORCE).toBe("soft");
expect(SESSION_STORE).toBe(nodePath.join(PROJECT_DIR, ".规聚会话"));
expect(segAgent(168, 168)).toContain(".规聚会话");

// ==================== 旧侧工厂 ====================

/** 类方法提取：签名行机械替换为 function 声明（方法体内无 this 引用，行为等价）。 */
const makeOldBuildDynamicContext = (readMemoryContext: (ws: unknown) => any) =>
  new Function(
    "getWorkspace",
    "readMemoryContext",
    "normalizeTaskMode",
    segAgent(4260, 4300).replace(
      "buildDynamicContext(entry, file, sharedMemCtx = null) {",
      "function buildDynamicContext(entry, file, sharedMemCtx = null) {",
    ) + "\nreturn buildDynamicContext;",
  )(getWorkspace, readMemoryContext, normalizeTaskMode) as (entry: any, file: unknown, sharedMemCtx?: any) => string;

const makeOldWriteContextFile = (readMemoryContext: (ws: unknown) => any) =>
  new Function(
    "getWorkspace",
    "readMemoryContext",
    "path",
    "fs",
    "atomicWriteFile",
    segAgent(4307, 4345).replace(
      "writeContextFile(entry, file, sharedMemCtx = null) {",
      "function writeContextFile(entry, file, sharedMemCtx = null) {",
    ) + "\nreturn writeContextFile;",
  )(getWorkspace, readMemoryContext, nodePath, fsReal, atomicWriteFile) as (entry: any, file: unknown, sharedMemCtx?: any) => void;

/** 新侧类方法驱动：fakeThis 只带 deps.readMemoryContext（方法体内无其它 this 引用）。 */
const callNewBuildDynamicContext = (readMemoryContext: (ws: unknown) => any, entry: any, file: unknown, sharedMemCtx: any = null) =>
  (AgentManager.prototype.buildDynamicContext as any).call({ deps: { readMemoryContext } }, entry, file, sharedMemCtx);
const callNewWriteContextFile = (readMemoryContext: (ws: unknown) => any, entry: any, file: unknown, sharedMemCtx: any = null) =>
  (AgentManager.prototype.writeContextFile as any).call({ deps: { readMemoryContext } }, entry, file, sharedMemCtx);

const makeOldFindSessionFile = (storeDir: string) =>
  new Function(
    "fs",
    "path",
    "__storeDir",
    segAgent(173, 209).replace(/SESSION_STORE/g, "__storeDir") + "\nreturn findSessionFileForAgent;",
  )(fsReal, nodePath, storeDir) as (id: unknown) => any;

const makeOldMaterializeSessionPath = (storeDir: string) =>
  new Function(
    "fs",
    "path",
    "isInside",
    "importLocalPiSessionFile",
    "__storeDir",
    segAgent(212, 225).replace(/SESSION_STORE/g, "__storeDir") + "\nreturn materializeSessionPath;",
  )(fsReal, nodePath, isInside, importLocalPiSessionFile, storeDir) as (sessionPath: unknown) => any;

const oldToolFingerprint = new Function(
  segAgent(359, 362) + "\nreturn toolFingerprint;",
)() as (name: unknown, args: unknown) => string;

const makeOldBudget = (enforce: string) =>
  new Function(
    "RUN_BUDGET_ENFORCE",
    "createRunBudget",
    "budgetSnapshot",
    segAgent(369, 394) + "\nreturn { ensureRunBudget, emitBudgetEvent, stopRunByBudget };",
  )(enforce, createRunBudget, budgetSnapshot) as {
    ensureRunBudget: (entry: any) => any;
    emitBudgetEvent: (entry: any, emit: (t: string, d: any) => void, level: unknown, code: unknown, reason: unknown) => void;
    stopRunByBudget: (entry: any) => void;
  };

const oldNoteRepeatedToolCall = new Function(
  "toolFingerprint",
  "REPEATED_TOOL_WARN_AT",
  segAgent(406, 422) + "\nreturn noteRepeatedToolCall;",
)(toolFingerprint, REPEATED_TOOL_WARN_AT) as typeof noteRepeatedToolCall;

const oldBuildOutputPolicyLines = new Function(
  segAgent(55, 65) + "\nreturn buildOutputPolicyLines;",
)() as typeof buildOutputPolicyLines;

/** 旧侧凭据模块工厂：返回未调用编译函数，由用例按场景注入单例 stub 后求值。 */
const makeOldAuth = () =>
  new Function(
    "readCredentials",
    "writeCredentials",
    "clearInvalidCredential",
    "agentManager",
    "piRuntimeManager",
    segAgent(4657, 4682) + "\nreturn { listAuth, setApiKey, removeApiKey };",
  ) as (
    readCredentials: () => any,
    writeCredentials: (v: any) => unknown,
    clearInvalidCredential: (p: unknown) => void,
    agentManager: any,
    piRuntimeManager: any,
  ) => { listAuth: () => any; setApiKey: (provider: unknown, key: unknown) => Promise<any>; removeApiKey: (provider: unknown) => Promise<any> };

const runOldEnsureContextFile = (projectDir: string) => {
  new Function(
    "path",
    "fs",
    "atomicWriteFile",
    "PROJECT_DIR",
    segAgent(4793, 4800),
  )(nodePath, fsReal, atomicWriteFile, projectDir);
};

// ==================== 夹具 ====================

let tmpRoot: string;
beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "b664f-"));
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.resetModules();
});

const readText = (file: string) => readFileSync(file, "utf8");

describe("buildDynamicContext 对拍", () => {
  it("mode agent（缺省）+ 长记忆截断 1500 + threadId 上下文文件名，两侧逐字节一致", () => {
    const mem = "M".repeat(1600) + "TAIL";
    const stub = () => mem;
    const oldFn = makeOldBuildDynamicContext(stub);
    const entry = { workspace: "C:/ws/a", mode: undefined, threadId: "t1", currentFile: "doc.docx" };
    expect(callNewBuildDynamicContext(stub, entry, "doc.docx")).toBe(oldFn(entry, "doc.docx"));
    const out = oldFn(entry, "doc.docx");
    expect(out).toContain("[动态上下文]");
    expect(out).toContain("C:/ws/a");
    expect(out).toContain(".agent-context.t1.md");
    expect(out).toContain(`- 工作区记忆摘要：\n${"M".repeat(1500)}`);
    expect(out).not.toContain("TAIL");
    expect(out).toContain("Office 文档一律用 officecli");
    expect(out).toContain("计划触发条件");
  });

  it("mode chat：纪律词条切换 + 记忆截断 800", () => {
    const mem = "C".repeat(900) + "TAIL";
    const stub = () => mem;
    const oldFn = makeOldBuildDynamicContext(stub);
    const entry = { workspace: "C:/ws/a", mode: "chat", threadId: "t2" };
    expect(callNewBuildDynamicContext(stub, entry, "")).toBe(oldFn(entry, ""));
    const out = oldFn(entry, "");
    expect(out).toContain("- 当前为 Chat：只读检索、解释与引用");
    expect(out).not.toContain("Office 文档一律用 officecli");
    expect(out).toContain(`- 工作区记忆摘要：\n${"C".repeat(800)}`);
    expect(out).not.toContain("TAIL");
    expect(out).toContain("- 当前工作文件: （无）");
  });

  it("mode review：审查纪律词条 + 记忆截断 1500", () => {
    const stub = () => "R".repeat(1600);
    const oldFn = makeOldBuildDynamicContext(stub);
    const entry = { workspace: "C:/ws/a", mode: "review" };
    expect(callNewBuildDynamicContext(stub, entry, "report.md")).toBe(oldFn(entry, "report.md"));
    const out = oldFn(entry, "report.md");
    expect(out).toContain("- 当前为 Review：先识别材料类型");
    expect(out).toContain("- 必须维护规范依据台账");
    expect(out).toContain("- Review 禁止使用 bash、地图编辑、浏览器自动化和 memory_update");
  });

  it("sharedMemCtx 共享：readMemoryContext 不被调用；异常吞错返回空串", () => {
    let calls = 0;
    const stub = () => {
      calls += 1;
      return "MEM";
    };
    const oldFn = makeOldBuildDynamicContext(stub);
    const entry = { workspace: "C:/ws/a", mode: "chat" };
    const shared = "SHARED";
    expect(callNewBuildDynamicContext(stub, entry, "f", shared)).toBe(oldFn(entry, "f", shared));
    expect(calls).toBe(0);
    expect(callNewBuildDynamicContext(stub, entry, "f", shared)).toContain("SHARED");

    const boom = () => {
      throw new Error("mem boom");
    };
    const oldBoom = makeOldBuildDynamicContext(boom);
    expect(callNewBuildDynamicContext(boom, entry, "f")).toBe("");
    expect(oldBoom(entry, "f")).toBe("");
  });

  it("entry.workspace 缺省回退 getWorkspace（两侧同一真实实现）", () => {
    const stub = () => "";
    const oldFn = makeOldBuildDynamicContext(stub);
    const entry = { mode: "chat" };
    expect(callNewBuildDynamicContext(stub, entry, "")).toBe(oldFn(entry, ""));
    expect(oldFn(entry, "")).toContain(getWorkspace());
  });
});

describe("writeContextFile 对拍", () => {
  it("首写：线程级 + 兼容双文件，两侧产物逐字节一致", () => {
    const stub = () => "记忆摘要内容";
    const oldFn = makeOldWriteContextFile(stub);
    const oldWs = path.join(tmpRoot, "ws-old");
    const newWs = path.join(tmpRoot, "ws-new");
    mkdirSync(oldWs, { recursive: true });
    mkdirSync(newWs, { recursive: true });
    const entry = { workspace: oldWs, threadId: "t1" };
    oldFn(entry, "doc.docx");
    callNewWriteContextFile(stub, { workspace: newWs, threadId: "t1" }, "doc.docx");
    const oldThread = readText(path.join(oldWs, ".agent-context.t1.md"));
    const oldCompat = readText(path.join(oldWs, ".agent-context.md"));
    // 内容内嵌工作区路径：归一化后逐字节比对
    expect(oldThread.replaceAll(oldWs, newWs)).toBe(readText(path.join(newWs, ".agent-context.t1.md")));
    expect(oldCompat.replaceAll(oldWs, newWs)).toBe(readText(path.join(newWs, ".agent-context.md")));
    expect(oldThread).toBe(oldCompat);
    expect(oldCompat).toContain(`- **当前工作区（绝对路径）**: ${oldWs}`);
    expect(oldCompat).toContain("- 当前工作文件: doc.docx");
    expect(oldCompat).toContain("## 工作区记忆（每次任务开始前阅读；沉淀新经验请用 memory_update 工具，勿直接写文件）\n记忆摘要内容");
    expect(oldCompat).toContain(`/maps/{project}/`);
  });

  it("内容不变跳过落盘（mtime 断言）；内容变化重写", () => {
    const stub = () => "MEM";
    const oldFn = makeOldWriteContextFile(stub);
    const newFn = (entry: any, file: unknown, shared: any = null) => callNewWriteContextFile(stub, entry, file, shared);
    const ws = path.join(tmpRoot, "ws-skip");
    mkdirSync(ws, { recursive: true });
    const entry = { workspace: ws, threadId: "t1" };

    const skipOne = (run: (entry: any, file: unknown) => void) => {
      run(entry, "a.docx");
      const past = new Date(Date.now() - 86400_000);
      for (const name of [".agent-context.t1.md", ".agent-context.md"]) {
        utimesSync(path.join(ws, name), past, past);
      }
      run(entry, "a.docx");
      for (const name of [".agent-context.t1.md", ".agent-context.md"]) {
        const mtimeMs = statSync(path.join(ws, name)).mtimeMs;
        expect(mtimeMs).toBeLessThan(Date.now() - 43200_000);
      }
      run(entry, "b.docx");
      expect(readText(path.join(ws, ".agent-context.t1.md"))).toContain("- 当前工作文件: b.docx");
      expect(statSync(path.join(ws, ".agent-context.t1.md")).mtimeMs).toBeGreaterThan(Date.now() - 43200_000);
    };
    skipOne(oldFn);
    // 新侧从干净工作区重跑同序断言
    const ws2 = path.join(tmpRoot, "ws-skip2");
    mkdirSync(ws2, { recursive: true });
    skipOne((e, file) => newFn(e, file));
  });

  it("无 threadId：只写兼容文件；sharedMemCtx 共享跳过重读", () => {
    let calls = 0;
    const stub = () => {
      calls += 1;
      return "MEM";
    };
    const oldFn = makeOldWriteContextFile(stub);
    const oldWs = path.join(tmpRoot, "ws-old2");
    const newWs = path.join(tmpRoot, "ws-new2");
    mkdirSync(oldWs, { recursive: true });
    mkdirSync(newWs, { recursive: true });
    oldFn({ workspace: oldWs }, "f.md", "SHARED");
    callNewWriteContextFile(stub, { workspace: newWs }, "f.md", "SHARED");
    expect(calls).toBe(0);
    expect(existsSync(path.join(oldWs, ".agent-context.md"))).toBe(true);
    expect(existsSync(path.join(oldWs, ".agent-context.undefined.md"))).toBe(false);
    expect(existsSync(path.join(newWs, ".agent-context.md"))).toBe(true);
    expect(readText(path.join(oldWs, ".agent-context.md")).replaceAll(oldWs, newWs)).toBe(readText(path.join(newWs, ".agent-context.md")));
    expect(readText(path.join(oldWs, ".agent-context.md"))).toContain("SHARED");
  });
});

describe("findSessionFileForAgent 对拍", () => {
  const touch = (file: string, mtime: number) => utimesSync(file, new Date(mtime), new Date(mtime));

  it("精确名 + 前缀名按 mtime 新→旧返回第一个", () => {
    const store = path.join(tmpRoot, "store-a");
    mkdirSync(path.join(store, "a/b"), { recursive: true });
    writeFileSync(path.join(store, "a/b/s-1.jsonl"), "{}\n");
    writeFileSync(path.join(store, "s-1-extra.jsonl"), "{}\n");
    touch(path.join(store, "a/b/s-1.jsonl"), 1000);
    touch(path.join(store, "s-1-extra.jsonl"), 2000);
    expect(findSessionFileForAgent("s-1", store)?.fullPath).toBe(path.join(store, "s-1-extra.jsonl"));
    expect(makeOldFindSessionFile(store)("s-1")?.fullPath).toBe(path.join(store, "s-1-extra.jsonl"));

    touch(path.join(store, "a/b/s-1.jsonl"), 3000);
    expect(findSessionFileForAgent("s-1", store)?.fullPath).toBe(path.join(store, "a/b/s-1.jsonl"));
    expect(makeOldFindSessionFile(store)("s-1")?.fullPath).toBe(path.join(store, "a/b/s-1.jsonl"));
  });

  it("目录深度 >4 剪枝；非 .jsonl 不收；无匹配返回 null；空参返回 null", () => {
    const store = path.join(tmpRoot, "store-b");
    mkdirSync(path.join(store, "d1/d2/d3/d4/d5"), { recursive: true });
    writeFileSync(path.join(store, "d1/d2/d3/d4/d5/deep.jsonl"), "{}\n");
    writeFileSync(path.join(store, "d1/d2/d3/d4/ok.jsonl"), "{}\n");
    writeFileSync(path.join(store, "note.txt"), "x");
    expect(findSessionFileForAgent("deep", store)).toBeNull();
    expect(makeOldFindSessionFile(store)("deep")).toBeNull();
    expect(findSessionFileForAgent("ok", store)?.fileName).toBe("ok.jsonl");
    expect(makeOldFindSessionFile(store)("ok")?.fileName).toBe("ok.jsonl");
    expect(findSessionFileForAgent("missing", store)).toBeNull();
    expect(makeOldFindSessionFile(store)("missing")).toBeNull();
    expect(findSessionFileForAgent("", store)).toBeNull();
    expect(makeOldFindSessionFile(store)("")).toBeNull();
  });

  it("首行 JSON header（id/sessionId）匹配；坏首行跳过", () => {
    const store = path.join(tmpRoot, "store-c");
    mkdirSync(path.join(store, "x"), { recursive: true });
    writeFileSync(path.join(store, "x/zzz-unknown.jsonl"), JSON.stringify({ id: "s-9" }) + "\nmore\n");
    expect(findSessionFileForAgent("s-9", store)?.fileName).toBe("zzz-unknown.jsonl");
    expect(makeOldFindSessionFile(store)("s-9")?.fileName).toBe("zzz-unknown.jsonl");

    const store2 = path.join(tmpRoot, "store-c2");
    mkdirSync(store2, { recursive: true });
    writeFileSync(path.join(store2, "abc.jsonl"), JSON.stringify({ sessionId: "s-8" }) + "\n");
    expect(findSessionFileForAgent("s-8", store2)?.fileName).toBe("abc.jsonl");
    expect(makeOldFindSessionFile(store2)("s-8")?.fileName).toBe("abc.jsonl");

    const store3 = path.join(tmpRoot, "store-c3");
    mkdirSync(store3, { recursive: true });
    writeFileSync(path.join(store3, "bad.jsonl"), "not-json\n");
    expect(findSessionFileForAgent("s-7", store3)).toBeNull();
    expect(makeOldFindSessionFile(store3)("s-7")).toBeNull();
  });
});

describe("materializeSessionPath 对拍", () => {
  it("falsy 透传 / 不存在抛错 / 目录抛错", () => {
    const store = path.join(tmpRoot, "store-m");
    mkdirSync(store, { recursive: true });
    const oldFn = makeOldMaterializeSessionPath(store);
    expect(materializeSessionPath("", store)).toBe("");
    expect(oldFn("")).toBe("");
    expect(materializeSessionPath(null, store)).toBeNull();
    expect(oldFn(null)).toBeNull();
    const missing = path.join(tmpRoot, "missing.jsonl");
    expect(() => materializeSessionPath(missing, store)).toThrow(`会话文件不存在：${path.resolve(missing)}`);
    expect(() => oldFn(missing)).toThrow(`会话文件不存在：${path.resolve(missing)}`);
    expect(() => materializeSessionPath(tmpRoot, store)).toThrow(`会话路径必须是 JSONL 文件，不能是目录：${path.resolve(tmpRoot)}`);
    expect(() => oldFn(tmpRoot)).toThrow(`会话路径必须是 JSONL 文件，不能是目录：${path.resolve(tmpRoot)}`);
  });

  it("store 内 .jsonl 直返；store 外经 importLocalPiSessionFile 复制；非法 JSONL 包装错误", () => {
    const store = path.join(tmpRoot, "store-m2");
    mkdirSync(store, { recursive: true });
    const inside = path.join(store, "local.jsonl");
    writeFileSync(inside, "{}\n");
    expect(materializeSessionPath(inside, store)).toBe(inside);
    expect(makeOldMaterializeSessionPath(store)(inside)).toBe(inside);

    const outsideDir = path.join(tmpRoot, "outside");
    mkdirSync(outsideDir, { recursive: true });
    const outside = path.join(outsideDir, "old-pi.jsonl");
    writeFileSync(outside, JSON.stringify({ id: "s-1" }) + "\n{}\n");
    const newCopy = materializeSessionPath(outside, store);
    const oldCopy = makeOldMaterializeSessionPath(store)(outside);
    expect(newCopy).toBe(oldCopy);
    expect(newCopy).toContain(path.basename(store));
    expect(newCopy).not.toBe(outside);
    expect(readText(newCopy)).toBe(readText(outside));
    expect(readText(oldCopy)).toBe(readText(outside));

    const badDir = path.join(tmpRoot, "bad");
    mkdirSync(badDir, { recursive: true });
    const bad = path.join(badDir, "bad.txt");
    writeFileSync(bad, "not jsonl");
    expect(() => materializeSessionPath(bad, store)).toThrow("无法将旧 Pi 会话迁移到项目内可写目录");
    expect(() => makeOldMaterializeSessionPath(store)(bad)).toThrow("无法将旧 Pi 会话迁移到项目内可写目录");
  });
});

describe("toolFingerprint 对拍", () => {
  it("字符串/对象/空值/空白归一/300 字符截断，两侧一致", () => {
    const cases: [unknown, unknown][] = [
      ["read", { path: "a.txt" }],
      ["bash", "ls -la   && echo hi"],
      ["?", undefined],
      ["", null],
      ["x", ""],
      [0, { n: 1 }],
    ];
    for (const [name, args] of cases) {
      expect(toolFingerprint(name, args)).toBe(oldToolFingerprint(name, args));
    }
    const long = "Z".repeat(500);
    expect(toolFingerprint("t", long)).toBe(oldToolFingerprint("t", long));
    expect(toolFingerprint("t", long)).toBe(`t::${"Z".repeat(300)}`);
    expect(toolFingerprint("t", "a \n\t b")).toBe("t::a b");
    expect(toolFingerprint("t", { b: 1, a: [1, 2] })).toBe('t::{"b":1,"a":[1,2]}');
  });
});

describe("noteRepeatedToolCall 对拍", () => {
  const runScenarios = (note: typeof noteRepeatedToolCall) => {
    const events: any[] = [];
    const steers: string[] = [];
    const emit = (type: string, data: any) => events.push({ type, data });
    const session = { steer: (text: string) => { steers.push(text); return "ok"; } };
    const entry: any = { activeRunId: "run-1" };
    const ev = { toolName: "read", args: { path: "a.txt" } };

    note(entry, session, ev, emit);
    note(entry, session, ev, emit);
    expect(events).toHaveLength(0);
    expect(steers).toHaveLength(0);

    note(entry, session, ev, emit);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("tool_repeat_warning");
    expect(events[0]!.data.name).toBe("read");
    expect(events[0]!.data.count).toBe(3);
    expect(events[0]!.data.input).toContain("read::");
    expect(steers).toHaveLength(1);
    expect(steers[0]).toContain("第 3 次");
    expect(steers[0]).toContain("[系统提醒] 「read」");
    expect(steers).toHaveLength(1);

    // 不同参数独立计数（新 key 首计，不提醒）
    note(entry, session, { toolName: "read", args: { path: "b.txt" } }, emit);
    expect(events).toHaveLength(1);
    // 字符串参数与对象 JSON 同指纹：计数累计，warned 已含该 key → 不再提醒
    note(entry, session, { toolName: "read", args: '{"path":"a.txt"}' }, emit);
    expect(events).toHaveLength(1);

    // 新 Run 重置：重新从 1 计数，第 3 次再提醒
    entry.activeRunId = "run-2";
    note(entry, session, ev, emit);
    note(entry, session, ev, emit);
    expect(events).toHaveLength(1);
    note(entry, session, ev, emit);
    expect(events).toHaveLength(2);
    expect(events[1]!.data.count).toBe(3);

    // steer 同步抛错吞掉（第 3 次才走到 steer，emit 已发生）
    const throwSession = { steer: () => { throw new Error("steer boom"); } };
    note(entry, throwSession, { toolName: "x", args: "y" }, emit);
    note(entry, throwSession, { toolName: "x", args: "y" }, emit);
    expect(events).toHaveLength(2);
    expect(() => note(entry, throwSession, { toolName: "x", args: "y" }, emit)).not.toThrow();
    expect(events).toHaveLength(3);
    // 缺 session（第 3 次触发提醒也不炸）/ entry null 整段吞错
    note(entry, null, { toolName: "z", args: "w" }, emit);
    note(entry, null, { toolName: "z", args: "w" }, emit);
    expect(() => note(entry, null, { toolName: "z", args: "w" }, emit)).not.toThrow();
    expect(() => note(null, session, null, emit)).not.toThrow();

    expect(entry.toolRepeat.counts.get(toolFingerprint("read", { path: "a.txt" }))).toBe(3);
    expect(entry.toolRepeat.warned.has(toolFingerprint("read", { path: "a.txt" }))).toBe(true);
    expect(entry.toolRepeat.runId).toBe("run-2");
    return { events, steers, entry };
  };

  it("阈值 3 提醒一次 / warned 去重 / Run 切换重置 / 异常吞错，两侧同流", () => {
    const newResult = runScenarios(noteRepeatedToolCall);
    const oldResult = runScenarios(oldNoteRepeatedToolCall);
    expect(newResult.events).toEqual(oldResult.events);
    expect(newResult.steers).toEqual(oldResult.steers);
    expect(newResult.entry.toolRepeat.runId).toBe(oldResult.entry.toolRepeat.runId);
    expect([...newResult.entry.toolRepeat.warned]).toEqual([...oldResult.entry.toolRepeat.warned]);
  });
});

describe("运行预算接线对拍", () => {
  it("ensureRunBudget：按 Run 建状态/复用/重建清空 toolArgsById", () => {
    const oldB = makeOldBudget("soft");
    const newEntry: any = { activeRunId: "r1" };
    const oldEntry: any = { activeRunId: "r1" };

    const nb = ensureRunBudget(newEntry);
    const ob = oldB.ensureRunBudget(oldEntry);
    expect(nb).toBeTruthy();
    expect(ob).toBeTruthy();
    expect(newEntry.runBudgetRunId).toBe("r1");
    expect(oldEntry.runBudgetRunId).toBe("r1");
    expect(newEntry.budgetStopped).toBe(false);
    expect(oldEntry.budgetStopped).toBe(false);
    expect(newEntry.toolArgsById).toBeInstanceOf(Map);
    expect(oldEntry.toolArgsById).toBeInstanceOf(Map);

    expect(ensureRunBudget(newEntry)).toBe(nb);
    expect(oldB.ensureRunBudget(oldEntry)).toBe(ob);

    newEntry.activeRunId = "r2";
    oldEntry.activeRunId = "r2";
    newEntry.toolArgsById.set("k", 1);
    oldEntry.toolArgsById.set("k", 1);
    const nb2 = ensureRunBudget(newEntry);
    const ob2 = oldB.ensureRunBudget(oldEntry);
    expect(nb2).not.toBe(nb);
    expect(ob2).not.toBe(ob);
    expect(newEntry.toolArgsById.size).toBe(0);
    expect(oldEntry.toolArgsById.size).toBe(0);
    expect(newEntry.budgetStopped).toBe(false);
    expect(oldEntry.budgetStopped).toBe(false);

    expect(ensureRunBudget(null)).toBeNull();
    expect(oldB.ensureRunBudget(null)).toBeNull();
  });

  it("emitBudgetEvent：level/code 过滤 + 类型映射 + 快照携带", () => {
    const oldB = makeOldBudget("soft");
    const newEvents: any[] = [];
    const oldEvents: any[] = [];
    const newEmit = (type: string, data: any) => newEvents.push({ type, data });
    const oldEmit = (type: string, data: any) => oldEvents.push({ type, data });

    emitBudgetEvent({ runBudget: null }, newEmit, "", "code", "why");
    emitBudgetEvent({ runBudget: null }, newEmit, "soft", "", "why");
    oldB.emitBudgetEvent({ runBudget: null }, oldEmit, "", "code", "why");
    oldB.emitBudgetEvent({ runBudget: null }, oldEmit, "soft", "", "why");
    expect(newEvents).toHaveLength(0);
    expect(oldEvents).toHaveLength(0);

    const budget = createRunBudget({ runId: "r1" });
    emitBudgetEvent({ runBudget: budget }, newEmit, "soft", "TURN_SOFT", "too many turns");
    oldB.emitBudgetEvent({ runBudget: budget }, oldEmit, "soft", "TURN_SOFT", "too many turns");
    emitBudgetEvent({ runBudget: budget }, newEmit, "hard", "TOOL_HARD", "stop");
    oldB.emitBudgetEvent({ runBudget: budget }, oldEmit, "hard", "TOOL_HARD", "stop");
    emitBudgetEvent(null, newEmit, "soft", "X", "y");
    oldB.emitBudgetEvent(null, oldEmit, "soft", "X", "y");
    expect(newEvents).toEqual(oldEvents);
    expect(newEvents.map((e) => e.type)).toEqual(["run_budget_notice", "run_budget_blocked", "run_budget_notice"]);
    expect(newEvents[0]!.data.snapshot).toEqual(budgetSnapshot(budget));
    expect(newEvents[2]!.data.snapshot).toBeNull();
  });

  it("stopRunByBudget：soft 不动作；hard 置位 + 单次 abort；abort 抛错吞掉", async () => {
    const oldSoft = makeOldBudget("soft");
    const softEntry: any = { session: { abort: vi.fn() } };
    oldSoft.stopRunByBudget(softEntry);
    expect(softEntry.budgetStopped).toBeFalsy();
    expect(softEntry.session.abort).not.toHaveBeenCalled();

    vi.stubEnv("OAW_RUN_BUDGET_ENFORCE", "hard");
    vi.resetModules();
    const hardMod = await import("../src/main/backend/agent/budget-wiring");
    expect(hardMod.RUN_BUDGET_ENFORCE).toBe("hard");

    const newEntry: any = { session: { abort: vi.fn(async () => {}) } };
    hardMod.stopRunByBudget(newEntry);
    expect(newEntry.budgetStopped).toBe(true);
    expect(newEntry.session.abort).toHaveBeenCalledTimes(1);
    hardMod.stopRunByBudget(newEntry);
    expect(newEntry.session.abort).toHaveBeenCalledTimes(1);

    const oldHard = makeOldBudget("hard");
    const oldEntry: any = { session: { abort: vi.fn(async () => {}) } };
    oldHard.stopRunByBudget(oldEntry);
    expect(oldEntry.budgetStopped).toBe(true);
    expect(oldEntry.session.abort).toHaveBeenCalledTimes(1);
    oldHard.stopRunByBudget(oldEntry);
    expect(oldEntry.session.abort).toHaveBeenCalledTimes(1);

    const boomEntry: any = { session: { abort: () => { throw new Error("abort boom"); } } };
    expect(() => hardMod.stopRunByBudget(boomEntry)).not.toThrow();
    expect(boomEntry.budgetStopped).toBe(true);
    const oldBoom: any = { session: { abort: () => { throw new Error("abort boom"); } } };
    expect(() => oldHard.stopRunByBudget(oldBoom)).not.toThrow();
  });
});

describe("buildOutputPolicyLines 对拍", () => {
  it("work/chat/review/缺省/大小写归一，两侧一致", () => {
    const cases = ["work", "chat", "review", undefined, "CHAT", "Review", "agent", ""];
    for (const mode of cases) {
      const newLines = mode === undefined ? buildOutputPolicyLines() : buildOutputPolicyLines({ mode });
      const oldLines = mode === undefined ? oldBuildOutputPolicyLines() : oldBuildOutputPolicyLines({ mode });
      expect(newLines).toEqual(oldLines);
    }
    const chat = buildOutputPolicyLines({ mode: "chat" });
    expect(chat).toHaveLength(2);
    expect(chat[0]).toContain("- **进度结论（重要）**");
    expect(chat[1]).toContain("不要输出固定的 Markdown 分段模板");
    const work = buildOutputPolicyLines({ mode: "work" });
    expect(work[1]).toContain("当本轮产生了文件、报告、数据、代码改动等成果时");
    expect(buildOutputPolicyLines({ mode: "chat" })[1]).not.toBe(work[1]);
  });
});

describe("listAuth/setApiKey/removeApiKey 对拍", () => {
  /** 凭据内存 store（vi.hoisted 定义，vi.mock 转发 + 旧侧工厂注入共用）。 */
  const credStore = vi.hoisted(() => {
    const store: Record<string, any> = {};
    const deep = (v: any) => JSON.parse(JSON.stringify(v));
    return {
      reset: () => { for (const k of Object.keys(store)) delete store[k]; },
      read: () => deep(store),
      write: (v: any) => {
        const next = deep(v);
        for (const k of Object.keys(store)) delete store[k];
        Object.assign(store, next);
      },
    };
  });

  beforeEach(() => {
    credStore.reset();
  });

  vi.mock("../src/main/backend/agent/pi-config-management", async (importOriginal) => {
    const actual = await importOriginal<Record<string, any>>();
    return { ...actual, readCredentials: () => credStore.read(), writeCredentials: (value: any) => credStore.write(value) };
  });

  const makeRuntime = (calls: any[]) => ({
    modelRuntime: async () => ({
      setRuntimeApiKey: async (provider: unknown, key: unknown, options: any) => {
        calls.push(["setRuntimeApiKey", provider, key, options]);
      },
    }),
    resetModelRuntime: () => {
      calls.push(["resetModelRuntime"]);
    },
  });

  it("setApiKey：trim 写回 + 运行时注入 + 注入失败静默；两侧凭据终态一致", async () => {
    const newCalls: any[] = [];
    const oldCalls: any[] = [];
    const oldMod = makeOldAuth()(
      credStore.read,
      credStore.write,
      clearInvalidCredential,
      { modelRuntime: makeRuntime(oldCalls).modelRuntime },
      { resetModelRuntime: () => {} },
    );
    const newResult = await setApiKey("prov-a", "  key-1  ", makeRuntime(newCalls));
    const oldResult = await oldMod.setApiKey("prov-a", "  key-1  ");
    expect(newResult).toEqual(oldResult);
    expect(newResult).toEqual({ ok: true, providers: ["prov-a"] });
    expect(newCalls).toEqual([["setRuntimeApiKey", "prov-a", "key-1", { allowNetwork: false }]]);
    expect(oldCalls).toEqual(newCalls);
    const snapshot = listAuth();
    expect(snapshot["prov-a"]).toEqual({ type: "api_key", key: "key-1" });

    // 注入失败静默
    const failing = { modelRuntime: async () => { throw new Error("runtime boom"); } };
    const result2 = await setApiKey("prov-a", "key-2", failing);
    const oldMod2 = makeOldAuth()(
      credStore.read,
      credStore.write,
      clearInvalidCredential,
      failing,
      { resetModelRuntime: () => {} },
    );
    const oldResult2 = await oldMod2.setApiKey("prov-a", "key-2");
    expect(result2).toEqual(oldResult2);
    expect(result2).toEqual({ ok: true, providers: ["prov-a"] });
    expect(listAuth()["prov-a"]!.key).toBe("key-2");
  });

  it("removeApiKey：删除写回 + 重置运行时；两侧一致", async () => {
    const calls: any[] = [];
    const oldMod = makeOldAuth()(
      credStore.read,
      credStore.write,
      clearInvalidCredential,
      { modelRuntime: makeRuntime(calls).modelRuntime },
      { resetModelRuntime: () => calls.push(["resetModelRuntime"]) },
    );
    await setApiKey("prov-b", "k", makeRuntime(calls));
    const newResult = await removeApiKey("prov-b", { resetModelRuntime: () => calls.push(["resetModelRuntime"]) });
    const oldResult = await oldMod.removeApiKey("prov-b");
    expect(newResult).toEqual(oldResult);
    expect(newResult).toEqual({ ok: true, providers: [] });
    expect(calls.filter((c) => c[0] === "resetModelRuntime")).toHaveLength(2);
    expect(listAuth()["prov-b"]).toBeUndefined();

    const oldMod2 = makeOldAuth()(
      credStore.read,
      credStore.write,
      clearInvalidCredential,
      { modelRuntime: async () => ({}) },
      { resetModelRuntime: () => {} },
    );
    const result2 = await removeApiKey("ghost", { resetModelRuntime: () => {} });
    const oldResult2 = await oldMod2.removeApiKey("ghost");
    expect(result2).toEqual(oldResult2);
    expect(result2).toEqual({ ok: true, providers: [] });
  });

  it("listAuth 透传凭据存储", () => {
    credStore.write({ "prov-c": { type: "api_key", key: "k" } });
    expect(listAuth()).toEqual({ "prov-c": { type: "api_key", key: "k" } });
    expect(listAuth()).toEqual(credStore.read());
  });
});

describe("ensureContextFile 对拍", () => {
  it("缺文件写默认内容（两侧内容一致）；已有文件保留", () => {
    const oldDir = path.join(tmpRoot, "proj-old");
    const newDir = path.join(tmpRoot, "proj-new");
    const keepDir = path.join(tmpRoot, "proj-keep");
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(newDir, { recursive: true });
    mkdirSync(keepDir, { recursive: true });

    runOldEnsureContextFile(oldDir);
    ensureContextFile(newDir);
    const expected = "# Office Agent Workspace\n\n- 当前没有打开文档\n- 当前工作文件: (无)\n";
    expect(readText(path.join(oldDir, ".agent-context.md"))).toBe(expected);
    expect(readText(path.join(newDir, ".agent-context.md"))).toBe(expected);

    writeFileSync(path.join(keepDir, ".agent-context.md"), "自定义内容");
    ensureContextFile(keepDir);
    expect(readText(path.join(keepDir, ".agent-context.md"))).toBe("自定义内容");
  });
});
