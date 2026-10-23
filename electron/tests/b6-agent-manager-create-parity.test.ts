/**
 * B6-6-4i 对拍：AgentManager._create 主体收口批（server/agent.mjs L1020-3458）。
 *
 * 覆盖：局部装配（workspace 归一/beginRuntime/modelRuntime 失败标记/DefaultResourceLoader
 * 构造与系统提示/mcp 注册与定义/review 族/managed 读写编辑工具/review_copy/
 * withWorkspaceWriteLock）+ 4g/4h 工厂接线（buildCreateTools/buildSubagentTools 同 world，
 * officeTool 回传）+ session 装配（customTools 39 工具名单 + tools 白名单 + setActiveTools
 * 补激活）+ channel/emit（runId 注入/eventNormalize/recordRunEvent 白名单）/emitUsage
 * （normalizeUsage 分支 + contextUsage 适配）/session.subscribe 事件 switch 20 case/entry
 * 组装（40+ 字段）+ 盒子回填（world.entry/world.session）。
 *
 * 旧侧按行号提取源段拼 class：L843-1018（类头+构造器+薄方法，构造器与 modelRuntime/
 * isRunStopping 必需）+ L1020-3458（_create 完整体，内联 4g/4h 段）+ L3610-3620
 * （resolveEntryContextWindowInfo）。4g 段动态 import 重定向 __legacy（4g 先例）；
 * (await import("node:fs"/"node:path")).default → 注入参数。
 *
 * 已迁函数两侧注入同一 TS 实现（4b isAbortLikeError 先例）；未迁域以 stub 注入。
 * 每侧独立 harness（真实写锁/暂存不跨侧残留，4h 先例），快照经 tmpWs 路径归一化。
 * fake timers + setSystemTime 全文件冻结（信封 at + Date.now）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import * as fsReal from "node:fs";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { AgentManager, type AgentManagerDeps, type LegacyAgentTools } from "../src/main/backend/agent/agent-manager";
import { emitChannelSafe, emitToolOutput, emitAbortedOnce } from "../src/main/backend/agent/emit-helpers";
import {
  classifyAgentError, estimateRestoredContextChars, isUserAbortSettled,
  captureSettledAgentError, rawAgentErrorMessage, safeAgentErrorMessage,
} from "../src/main/backend/agent/agent-errors";
import { resolveInitialModel } from "../src/main/backend/agent/model-spec";
import { buildOutputPolicyLines } from "../src/main/backend/agent/prompt-chain";
import { extensionToolNames, schemaToTypeBox, safePiToolName } from "../src/main/backend/agent/tool-schema";
import { assistantText, eventValueText, normalizeUsage, usageFromEvent, limitToolText } from "../src/main/backend/agent/usage-text";
import { noteRepeatedToolCall } from "../src/main/backend/agent/tool-repeat";
import { ensureRunBudget, emitBudgetEvent, stopRunByBudget } from "../src/main/backend/agent/budget-wiring";
import { noteTurn, evaluateTurnGate, evaluateToolGate, noteToolResult } from "../src/shared/runtime/run-budget";
import {
  stagedAccess, resolveReadablePath, ensureStagedDirectory, stageWrite,
  acquireWriteLockWithRetry, releaseWriteLock, writeWorkspaceFile,
  isProtectedMemoryTarget, materializeStagedReferences,
} from "../src/main/backend/agent/write-coordination";
import { materializeSessionPath, SESSION_STORE } from "../src/main/backend/agent/session-store";
import { createStreamId, CHANNEL_HISTORY_LIMIT, PROTOCOL_VERSION, pushChannelEvent } from "../src/shared/runtime/event-protocol";
import { canonicalFromEnvelope } from "../src/shared/runtime/event-normalization";
import { turnNoticeKind, turnNoticeText, TURN_PROGRESS_INTERVAL } from "../src/shared/runtime/turn-budget";
import { markRunTiming } from "../src/shared/runtime/first-token-latency";
import { isGlobalSearchCommand } from "../src/main/backend/agent/command-safety-policy";
import { runAgentOfficeCommand } from "../src/main/backend/agent/office-command";
import { atomicWriteFile } from "../src/main/backend/persistence-utils";
import { readReference, contextSummary } from "../src/main/backend/agent/context";
import { searchLocalSkills, localSkillCatalog } from "../src/main/backend/agent/skill-search";
import { persistPendingAsk, resolvePendingAsk, ASK_TIMEOUT_MS } from "../src/main/backend/agent/pending-asks";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { normalizeWorkspace as normalizeWsReal, getWorkspace, isInside, PROJECT_DIR, AGENT_DIR } from "../src/main/backend/workspace";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LINES_AGENT = readFileSync(path.resolve(HERE, "../../server/agent.mjs"), "utf8").split("\n");
const segAgent = (start: number, end: number) => LINES_AGENT.slice(start - 1, end).join("\n").replace(/^export\s+/gm, "");

// 冻结时钟：信封 at=ISO + Date.now（lastPiEventAt 等）
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// 行号锚点：源文件结构变动导致偏移时，这里先行失败提醒更新提取区间
expect(segAgent(843, 843)).toContain("class AgentManager extends EventEmitter {");
expect(segAgent(1018, 1018)).toContain("}");
expect(segAgent(1020, 1020)).toContain("async _create(clientId, options = {}) {");
expect(segAgent(3458, 3458)).toContain("}");
expect(segAgent(3610, 3610)).toContain("resolveEntryContextWindowInfo(entry) {");
expect(segAgent(3620, 3620)).toContain("}");

// 4g 段动态 import 逃逸 new Function，重定向注入式（4g 先例）
const segCreate = segAgent(1020, 3458)
  .replace(/await import\("\.\/([a-z-]+)\.mjs"\)/g, 'await __legacy("$1.mjs")')
  .replace(/import\("\.\/([a-z-]+)\.mjs"\)/g, '__legacy("$1.mjs")')
  .replace(/\(await import\("node:fs"\)\)\.default/g, "__fsMod")
  .replace(/\(await import\("node:path"\)\)\.default/g, "__pathMod");

const PARAM_NAMES = [
  // 4a 类体段
  "EventEmitter", "RUNTIME_FLAGS", "getRun", "listStoredMemoryProposals", "approveStoredMemoryProposal",
  "editStoredMemoryProposal", "rejectStoredMemoryProposal", "mergeMemoryProposals",
  "getMemoryProposalHistory", "readPendingAsks", "resolvePendingAsk", "emitChannelSafe",
  "piRuntimeManager", "normalizeWorkspace",
  // 4i 前半
  "getWorkspace", "resolveInitialModel", "enabledPiExtensionEntries", "enabledPiExtensionPaths",
  "PROJECT_DIR", "AGENT_DIR", "DefaultResourceLoader", "buildOutputPolicyLines",
  "extensionToolNames", "cachedMcpTools", "safePiToolName", "schemaToTypeBox",
  "callMcpTool", "requireToolApproval", "isInside", "stagedAccess", "ensureStagedDirectory",
  "stageWrite", "resolveReadablePath", "acquireWriteLockWithRetry", "releaseWriteLock",
  "writeWorkspaceFile", "defineTool", "Type",
  "createReadToolDefinition", "createWriteToolDefinition", "createEditToolDefinition",
  "createBashToolDefinition", "createLocalBashOperations",
  // 4g 段 seam
  "isGlobalSearchCommand", "normalizeBashOptions", "normalizeOfficeFailure", "parseArgs",
  "collectReferencedPaths", "ensureOfficeOutputDirs", "runAgentOfficeCommand", "limitToolText",
  "webSearch", "webFetch", "searchLocalSkills", "localSkillCatalog", "readReference",
  "contextSummary", "materializeStagedReferences", "updateRunTodo",
  "persistPendingAsk", "ASK_TIMEOUT_MS", "atomicWriteFile", "getBashSidecar",
  "createDemoAnalysis", "normalizeCompletion", "completionStatusLabel",
  "evaluateMemoryCandidate", "getProjectForWorkspace", "createMemoryProposal",
  "browserSessionKey", "browserOpen", "browserSnapshot", "browserClick", "browserType",
  "browserPress", "browserScroll", "browserScreenshot", "browserBack", "browserTabs", "browserClose",
  "isProtectedMemoryTarget",
  // 4h 段
  "SUBAGENT_ROLES", "resolveRole", "orchestrateSubagents", "runEditorialPipeline",
  "SessionManager", "SettingsManager", "PI_COMPACTION_POLICY",
  "PIPELINE_WRITER_TIMEOUT_MS", "PIPELINE_TEXT_LIMIT",
  // 4i 后半
  "materializeSessionPath", "SESSION_STORE", "createStreamId", "CHANNEL_HISTORY_LIMIT",
  "PROTOCOL_VERSION", "pushChannelEvent", "canonicalFromEnvelope", "recordRunEvent",
  "normalizeUsage", "usageFromEvent", "assistantText", "eventValueText",
  "contextTokensFromUsage", "markRunTiming", "turnNoticeKind", "turnNoticeText",
  "TURN_PROGRESS_INTERVAL", "ensureRunBudget", "noteTurn", "evaluateTurnGate",
  "emitBudgetEvent", "stopRunByBudget", "evaluateToolGate", "noteToolResult",
  "noteRepeatedToolCall", "emitToolOutput", "classifyAgentError",
  "captureSettledAgentError", "isUserAbortSettled", "emitAbortedOnce",
  "rawAgentErrorMessage", "safeAgentErrorMessage", "isToolGateRejection",
  "estimateRestoredContextChars", "localStoredModels", "DEFAULT_CONTEXT_WINDOW",
  // 模块对象与变换占位
  "path", "fs", "crypto", "__fsMod", "__pathMod", "__legacy",
];

// 轻量 Type stub（双侧同一实现）
const TypeStub: any = {
  Object: (props: any, opts?: any) => ({ type: "object", properties: props, required: Object.keys(props).filter((k) => !props[k]?.__opt), ...(opts || {}) }),
  String: (opts?: any) => ({ type: "string", ...(opts || {}) }),
  Number: (opts?: any) => ({ type: "number", ...(opts || {}) }),
  Boolean: (opts?: any) => ({ type: "boolean", ...(opts || {}) }),
  Array: (items: any, opts?: any) => ({ type: "array", items, ...(opts || {}) }),
  Union: (options: any, opts?: any) => ({ anyOf: options, ...(opts || {}) }),
  Literal: (v: any) => ({ const: v, type: typeof v }),
  Optional: (s: any) => ({ ...s, __opt: 1 }),
};

// 4g 段动态 import 的模块 stub 注册表（双侧共享；工具 execute 场景只触达 office/kb/map）
const reg = {
  office: { runOfficecli: async () => ({ ok: true }), validateOfficecliArgs: () => ({ ok: true }) },
  kb: { scan: async () => ({ docs: [] }), status: async () => ({}), getDoc: async () => ({}), search: async () => ({ hits: [] }) },
  map: { DEFAULT_PROJECT: "zhejiang-map", getProject: async () => ({ project: "p" }), projectDir: () => ".", listProjects: async () => [], importLayer: async () => ({}) },
  "layer-repository": { listLayers: async () => [], resolveLayer: async () => ({}), markLayerOwnership: async () => ({}) },
  "map-visualization": { listSources: async () => [], loadSource: async () => ({}) },
  "traffic-sources": {},
  "spatial-analysis": { analyzeGeoJSON: async () => ({}) },
  "map-template": { runOdCommuterTemplate: async () => ({}) },
};
const LEGACY_KEYS: Record<string, string> = {
  office: "office", kb: "kb", map: "map", "layer-repository": "layer-repository",
  "map-visualization": "map-visualization", "traffic-sources": "traffic-sources",
  "spatial-analysis": "spatial-analysis", "map-template": "map-template",
};
const __legacy = (name: string) => Promise.resolve((reg as any)[LEGACY_KEYS[name.replace(/\.mjs$/, "")] || name.replace(/\.mjs$/, "")]);

const ROLES: any = {
  scout: { label: "资料探索", readOnly: true, timeoutMs: 60000, prompt: "探索并汇总资料", tools: ["read"] },
  reviewer: { label: "审阅", readOnly: true, timeoutMs: 90000, prompt: "审阅检查", tools: ["read"] },
  planner: { label: "方案拆解", readOnly: true, timeoutMs: 60000, prompt: "拆解方案", tools: ["read"] },
  verifier: { label: "独立核验", readOnly: true, timeoutMs: 90000, prompt: "独立核验", tools: ["read"] },
  worker: { label: "可写执行", readOnly: false, timeoutMs: 300000, prompt: "执行任务", tools: ["read", "write", "edit", "officecli"] },
};

/** 旧侧类工厂：4a 类体段 + _create 完整体 + resolveEntryContextWindowInfo，同名参数注入。 */
function makeOldManager(h: ReturnType<typeof makeHarness>) {
  const Ctor = new Function(...PARAM_NAMES, `${segAgent(843, 1018)}
${segCreate}
${segAgent(3610, 3620)}
}
return AgentManager;`);
  const d = h.deps as any;
  const t = h.tools as any;
  // 三步：new Function 得工厂 → 工厂调用求值出 AgentManager 类 → new 实例
  // （thin-parity 同构；若直接 new 工厂，body 的 return AgentManager 会让 new 表达式返回类本身）
  const OldAgentManager = (Ctor as any)(
    EventEmitter,
    d.flags, d.getRun, d.listStoredMemoryProposals, d.approveStoredMemoryProposal,
    d.editStoredMemoryProposal, d.rejectStoredMemoryProposal, d.mergeMemoryProposals,
    d.getMemoryProposalHistory, d.readPendingAsks, d.resolvePendingAsk,
    // 三参调用包装绑定同一 emitDeps（4b 先例）
    (entry: any, type: string, data: any, opts: any) => emitChannelSafe(entry, type, data, opts, d.emitDeps),
    d.piRuntimeManager, d.normalizeWorkspace,
    getWorkspace, resolveInitialModel, t.enabledPiExtensionEntries, t.enabledPiExtensionPaths,
    PROJECT_DIR, AGENT_DIR, t.DefaultResourceLoader, buildOutputPolicyLines,
    extensionToolNames, t.cachedMcpTools, safePiToolName, schemaToTypeBox,
    t.callMcpTool, t.requireToolApproval, isInside, stagedAccess, ensureStagedDirectory,
    stageWrite, resolveReadablePath, acquireWriteLockWithRetry, releaseWriteLock,
    writeWorkspaceFile, t.defineTool, t.Type,
    t.createReadToolDefinition, t.createWriteToolDefinition, t.createEditToolDefinition,
    t.createBashToolDefinition, t.createLocalBashOperations,
    t.isGlobalSearchCommand, t.normalizeBashOptions, t.normalizeOfficeFailure, t.parseArgs,
    t.collectReferencedPaths, t.ensureOfficeOutputDirs, runAgentOfficeCommand, limitToolText,
    t.webSearch, t.webFetch, searchLocalSkills, localSkillCatalog, readReference,
    contextSummary, materializeStagedReferences, t.updateRunTodo,
    persistPendingAsk, ASK_TIMEOUT_MS, atomicWriteFile, t.getBashSidecar,
    t.createDemoAnalysis, t.normalizeCompletion, t.completionStatusLabel,
    t.evaluateMemoryCandidate, t.getProjectForWorkspace, t.createMemoryProposal,
    t.browserSessionKey, t.browserOpen, t.browserSnapshot, t.browserClick, t.browserType,
    t.browserPress, t.browserScroll, t.browserScreenshot, t.browserBack, t.browserTabs, t.browserClose,
    isProtectedMemoryTarget,
    t.SUBAGENT_ROLES, t.resolveRole, t.orchestrateSubagents, t.runEditorialPipeline,
    SessionManager, SettingsManager, { reserveTokens: 16384, keepRecentTokens: 20000 },
    Math.max(60_000, Number.parseInt(process.env.OAW_PIPELINE_WRITER_TIMEOUT_MS || "240000", 10) || 240_000),
    60_000,
    materializeSessionPath, SESSION_STORE, createStreamId, CHANNEL_HISTORY_LIMIT,
    PROTOCOL_VERSION, pushChannelEvent, canonicalFromEnvelope, h.recordRunEvent,
    normalizeUsage, usageFromEvent, assistantText, eventValueText,
    d.contextTokensFromUsage, markRunTiming, turnNoticeKind, turnNoticeText,
    TURN_PROGRESS_INTERVAL, ensureRunBudget, noteTurn, evaluateTurnGate,
    emitBudgetEvent, stopRunByBudget, evaluateToolGate, noteToolResult,
    noteRepeatedToolCall, emitToolOutput, classifyAgentError,
    captureSettledAgentError, isUserAbortSettled, emitAbortedOnce,
    rawAgentErrorMessage, safeAgentErrorMessage, t.isToolGateRejection,
    estimateRestoredContextChars, d.localStoredModels, 1000000,
    path, fsReal, crypto, fsReal, path, __legacy,
  );
  const mgr = new OldAgentManager() as any;
  if (process.env._P4I_DEBUG) {
    process.stderr.write(`[p4i-proto] ${Object.getOwnPropertyNames(Object.getPrototypeOf(mgr)).join(",")}\n`);
  }
  return mgr;
}

/** fake pi 会话：subscribe 收 handler、getActiveToolNames 供 run_subagent canWrite 判定。 */
function makeFakeSession(activeTools: string[] = ["read", "bash", "grep", "find", "ls", "write", "edit"]) {
  const handlers: any[] = [];
  return {
    sessionId: "s_new",
    model: { provider: "prov-x", id: "mdl-1", contextWindow: 128000 },
    getActiveToolNames: () => [...activeTools],
    subscribe: (h: any) => { handlers.push(h); },
    __handlers: handlers,
    followUp: async () => {},
    steer: async () => {},
    messages: [],
  };
}

/** 双侧 harness：每侧独立（真实写锁/暂存不跨侧残留），calls 快照后归一化比较。 */
function makeHarness(opts: {
  flags?: any;
  entry?: any;
  createOptions?: any;
  overrides?: any;
  seamOverrides?: any;
  depsOverrides?: any;
} = {}) {
  const tmpWs = mkdtempSync(path.join(os.tmpdir(), "p4i-ws-"));
  const calls: Record<string, any> = {};
  const fn = (key: string, impl?: any) => { calls[key] = vi.fn(impl); return calls[key]; };
  const recordRunEvent = fn("recordRunEvent", () => {});
  const fakeSession = makeFakeSession(opts.overrides?.activeTools);
  const flags = opts.flags || {};
  const mr = { marker: "model-runtime", getModels: () => [] };
  const piRuntimeManager: any = {
    modelRuntime: fn("modelRuntime", async () => {
      if (opts.overrides?.modelRuntimeThrows) throw new Error("模型运行时创建失败");
      return mr;
    }),
    dispose: () => {},
    getSessionTree: () => null,
    navigateSessionTree: async () => ({}),
    abort: async () => {},
    compact: async () => ({}),
    health: () => null,
    markRecovery: () => {},
    listSnapshots: () => [],
    schedulerSnapshot: () => ({}),
    setModel: async () => {},
    probeModel: async () => ({}),
    resetModelRuntime: () => {},
    disposeAll: async () => {},
    getContextUsage: fn("getContextUsage", () => null),
    prompt: () => {},
    runPrompt: async (_r: unknown, operation: () => Promise<any>) => operation(),
    setActiveTools: fn("setActiveTools", () => {}),
    update: () => {},
    setThinkingLevel: () => {},
    // B6-6-4i 扩员
    beginRuntime: fn("beginRuntime", (args: any) => ({ runtimeId: "rt_new", ...args })),
    markFailure: fn("markFailure", () => {}),
    createSession: fn("createSession", async (args: any) => {
      if (opts.overrides?.createSessionThrows) throw new Error("会话创建失败");
      return { session: fakeSession, sessionManager: { marker: "sm" } };
    }),
    bindSession: fn("bindSession", () => {}),
  };
  const tools: LegacyAgentTools = {
    // pi 域
    defineTool: (def: any) => def,
    Type: TypeStub,
    DefaultResourceLoader: function (this: any, o: any) {
      this.options = o;
      this.reload = async () => { calls.loaderReload = (calls.loaderReload || 0) + 1; };
      // extensionToolNames(loader, entries) 读取：扩展记录 + 工具名 Map
      this.getExtensions = () => ({ extensions: [{ path: "/ext/a.mjs", resolvedPath: "/ext/a.mjs", tools: new Map([["ext_tool_1", {}]]) }] });
    } as any,
    createBashToolDefinition: fn("createBashToolDefinition", (cwd: string, ops: any) => ({ name: "bash", cwd, operations: ops.operations })),
    createReadToolDefinition: fn("createReadToolDefinition", (cwd: string, ops: any) => ({ name: "read", cwd, operations: ops.operations })),
    createWriteToolDefinition: fn("createWriteToolDefinition", (cwd: string, ops: any) => ({ name: "write", cwd, operations: ops.operations })),
    createEditToolDefinition: fn("createEditToolDefinition", (cwd: string, ops: any) => ({ name: "edit", cwd, operations: ops.operations })),
    createLocalBashOperations: fn("createLocalBashOperations", () => ({ exec: async () => ({ exitCode: 0, output: "ok" }) })),
    // pi 扩展 / MCP
    enabledPiExtensionEntries: fn("enabledPiExtensionEntries", () => [{ id: "ext1", path: "/ext/a.mjs" }]),
    enabledPiExtensionPaths: fn("enabledPiExtensionPaths", () => ["/ext/a.mjs"]),
    cachedMcpTools: fn("cachedMcpTools", () => opts.overrides?.mcpTools ?? []),
    callMcpTool: fn("callMcpTool", async () => ({ content: [{ type: "text", text: "mcp-ok" }] })),
    // 审批 / 策略
    requireToolApproval: fn("requireToolApproval", async () => {}),
    normalizeBashOptions: (o: any) => o || {},
    isToolGateRejection: fn("isToolGateRejection", (text: unknown) => Boolean(opts.overrides?.toolGateRejection && String(text).includes("[工具门禁]"))),
    // office / web / browser / map / memory（4g 工厂仅解构引用，构造期不调用）
    normalizeOfficeFailure: (e: any) => e,
    parseArgs: (input: unknown) => String(input).trim().split(/\s+/).filter(Boolean),
    collectReferencedPaths: () => [],
    ensureOfficeOutputDirs: () => [],
    webSearch: async () => ({ backend: "stub", results: [] }),
    webFetch: async () => ({ markdown: "" }),
    browserOpen: async () => ({}), browserSnapshot: async () => ({}), browserClick: async () => ({}),
    browserType: async () => ({}), browserPress: async () => ({}), browserScroll: async () => ({}),
    browserScreenshot: async () => ({}), browserBack: async () => ({}), browserTabs: async () => ({}),
    browserClose: async () => ({}), browserSessionKey: (c: any, t: any) => `${c}:${t}`,
    getBashSidecar: () => ({ execute: async () => ({ exitCode: 0, output: "sidecar" }) }),
    createDemoAnalysis: (input: any) => ({ action: "show_analysis", ...input }),
    normalizeCompletion: (input: unknown) => input,
    completionStatusLabel: (s: unknown) => String(s || ""),
    evaluateMemoryCandidate: () => null,
    getProjectForWorkspace: () => null,
    updateRunTodo: () => ({}),
    listStoredMemoryProposals: () => [],
    createMemoryProposal: () => ({}),
    // 子代理编排
    SUBAGENT_ROLES: ROLES,
    resolveRole: (role: unknown, o: any) => (role === "worker" && !o?.canWrite ? "scout" : role || "scout"),
    orchestrateSubagents: async () => ({ text: "编排完成", isError: false, results: [] }),
    runEditorialPipeline: async () => ({ status: "completed", deliverable: "报告.docx", checks: [], issues: [] }),
    ...(opts.seamOverrides || {}),
  } as any;
  const emitDeps = { recordRunEvent, flags };
  const deps: AgentManagerDeps = {
    piRuntimeManager,
    getRun: () => null,
    listStoredMemoryProposals: () => [],
    approveStoredMemoryProposal: () => ({ proposal: null }),
    editStoredMemoryProposal: () => ({ proposal: null }),
    rejectStoredMemoryProposal: () => ({ proposal: null }),
    mergeMemoryProposals: () => ({}),
    getMemoryProposalHistory: () => [],
    flags,
    normalizeWorkspace: (dir: unknown) => (dir === undefined || dir === null || dir === "" ? normalizeWsReal(getWorkspace()) : normalizeWsReal(dir as string)),
    readPendingAsks: () => [],
    resolvePendingAsk: () => null,
    contextTokensFromUsage: fn("contextTokensFromUsage", (usage: any) => (usage && usage.totalTokens ? usage.totalTokens : null)),
    emitDeps,
    localStoredModels: () => [{ id: "prov-x/mdl-1", contextWindow: 99000 }],
    legacyTools: tools,
    ...(opts.depsOverrides || {}),
  } as any;
  const toolsSnapshot = { ...tools };
  return { tmpWs, calls, recordRunEvent, fakeSession, flags, tools, toolsSnapshot, deps, piRuntimeManager };
}

// 快照序列化：函数值折叠为占位符
const snapFn = (_k: string, v: any) => (typeof v === "function" ? "ƒ" : v);
const snap = (v: any) => JSON.parse(JSON.stringify(v, snapFn));

/** entry 关键字段挑选（函数值/Promise/streamId 随机值折叠）。 */
function pickEntry(e: any) {
  return {
    clientId: e.clientId, workspace: e.workspace, threadId: e.threadId, runtimeId: e.runtimeId,
    busy: e.busy, compacting: e.compacting, compactionKind: e.compactionKind, mode: e.mode,
    modePolicy: e.modePolicy ?? null, modePolicyKey: e.modePolicyKey,
    mcpToolNames: e.mcpToolNames, mcpReadOnlyToolNames: e.mcpReadOnlyToolNames,
    piExtensionToolNames: e.piExtensionToolNames, hasSubagent: e.hasSubagent,
    reviewConfirmed: e.reviewConfirmed, reviewAwaitingConfirmation: e.reviewAwaitingConfirmation,
    reviewProtectedPaths: [...(e.reviewProtectedPaths || [])], reviewSources: e.reviewSources,
    turnStarted: e.turnStarted, toolStarted: e.toolStarted, firstResponseReceived: e.firstResponseReceived,
    turnCount: e.turnCount, runToolCount: e.runToolCount,
    activeToolCount: e.activeToolCount, queuedCount: e.queuedCount, promptChars: e.promptChars,
    autoCompacting: e.autoCompacting, lastCompactionAt: e.lastCompactionAt,
    currentFile: e.currentFile, activeRunId: e.activeRunId, task: e.task, references: e.references,
    lastAgentError: e.lastAgentError, lastSettledError: e.lastSettledError,
    lastAssistantText: e.lastAssistantText, lastFinalText: e.lastFinalText,
    lastUsage: e.lastUsage ?? null, requestedThinkingLevel: e.requestedThinkingLevel,
    effectiveThinkingLevel: e.effectiveThinkingLevel,
    sessionManager: e.sessionManager, sessionModel: e.session?.model ?? null,
    channelSeq: e.channel?.seq, channelStreamIdType: typeof e.channel?.streamId,
    channelHistoryLen: e.channel?.history?.length, channelHistoryLimit: e.channel?.historyLimit,
    promptChainType: Object.prototype.toString.call(e.promptChain),
    loaderType: typeof e.loader, loaderOptions: e.loader?.options ?? null,
    loaderOverrideContent: typeof e.loader?.options?.agentsFilesOverride === "function"
      ? e.loader.options.agentsFilesOverride({ agentsFiles: [], diagnostics: [] })
      : null,
  };
}

/** createSession 入参快照：customTools 名称序列 + tools 白名单 + 关键标量。 */
function pickCreateArgs(args: any) {
  return {
    cwd: args.cwd, agentDir: args.agentDir, sessionPath: args.sessionPath, sessionStore: args.sessionStore,
    model: args.model, customToolNames: args.customTools.map((t: any) => t?.name ?? null),
    tools: args.tools, resourceLoaderType: typeof args.resourceLoader,
  };
}

/**
 * 双侧同流跑 _create：每侧独立 harness → _create → drive（事件/工具调用）→ 快照比较。
 * 快照：entry 挑选字段 / createSession 入参 / seam 调用记录 / 通道历史（归一化 tmpWs）。
 */
async function runBothCreate(opts: Parameters<typeof makeHarness>[0] = {}, drive?: (mgr: any, entry: any, h: ReturnType<typeof makeHarness>) => Promise<void> | void) {
  const snaps: any[] = [];
  for (const side of ["old", "fresh"] as const) {
    const h = makeHarness(opts);
    const mgr = side === "old" ? makeOldManager(h) : new AgentManager(h.deps);
    let entry: any;
    let thrown: any = null;
    try {
      entry = await mgr._create("c1", { cwd: h.tmpWs, threadId: "t1", ...(opts.createOptions || {}) });
      if (drive) await drive(mgr, entry, h);
    } catch (error) { thrown = error; }
    const wsKey = JSON.stringify(h.tmpWs).slice(1, -1);
    const norm = (v: any) => JSON.parse(JSON.stringify(v, snapFn).split(wsKey).join("<WS>").replace(/"streamId":"[^"]*"/g, '"streamId":"<SID>"'));
    const loaderCalls = h.calls.beginRuntime?.mock?.calls || [];
    snaps.push({
      thrown: thrown ? { message: thrown.message, code: (thrown as any).code } : null,
      thrownRaw: thrown,
      entry: thrown ? null : norm(pickEntry(entry)),
      createArgs: thrown ? null : norm(pickCreateArgs(h.calls.createSession?.mock?.calls?.[0]?.[0] || {})),
      activeTools: thrown ? null : h.calls.setActiveTools?.mock?.calls?.[0]?.[2] ?? null,
      beginRuntime: norm(loaderCalls.map((c: any) => c.slice(0, 5))),
      bindSession: norm((h.calls.bindSession?.mock?.calls || []).map((c: any) => [c[0], typeof c[1], c[1]?.profile, c[1]?.toolPolicy])),
      markFailure: norm((h.calls.markFailure?.mock?.calls || []).map((c: any) => [c[0], String(c[1]?.message || c[1]), c[2]])),
      loaderOpts: norm(entry?.loader?.options ? { cwd: entry.loader.options.cwd, agentDir: entry.loader.options.agentDir, additionalExtensionPaths: entry.loader.options.additionalExtensionPaths, noSkills: entry.loader.options.noSkills, hasOverride: typeof entry.loader.options.agentsFilesOverride } : null),
      history: thrown ? null : norm(entry?.channel?.history || []),
      recordRunEvents: thrown ? null : norm((h.recordRunEvent as any).mock.calls.map((c: any[]) => [c[0], c[1], c[2]])),
      sessionFired: typeof h.fakeSession.__handlers?.length === "number" ? h.fakeSession.__handlers.length : null,
      mgrSessions: mgr.sessions instanceof Map ? [...mgr.sessions.keys()] : null,
    });
  }
  const [oldS, freshS] = snaps;
  if (process.env._P4I_DEBUG) {
    if (oldS.thrownRaw) process.stderr.write(`[p4i-old-stack]\n${oldS.thrownRaw.stack}\n`);
    if (freshS.thrownRaw) process.stderr.write(`[p4i-fresh-stack]\n${freshS.thrownRaw.stack}\n`);
    const diffKeys = Object.keys(oldS).filter((k) => JSON.stringify(oldS[k]) !== JSON.stringify(freshS[k]));
    process.stderr.write(`[p4i-diff] ${diffKeys.join(",") || "none"}\n`);
    for (const k of diffKeys.slice(0, 4)) {
      process.stderr.write(`[p4i-diff:${k}]\nold=${JSON.stringify(oldS[k])?.slice(0, 900)}\nfresh=${JSON.stringify(freshS[k])?.slice(0, 900)}\n`);
    }
  }
  expect(freshS.thrown).toEqual(oldS.thrown);
  expect(freshS.entry).toEqual(oldS.entry);
  expect(freshS.createArgs).toEqual(oldS.createArgs);
  expect(freshS.activeTools).toEqual(oldS.activeTools);
  expect(freshS.beginRuntime).toEqual(oldS.beginRuntime);
  expect(freshS.bindSession).toEqual(oldS.bindSession);
  expect(freshS.markFailure).toEqual(oldS.markFailure);
  expect(freshS.loaderOpts).toEqual(oldS.loaderOpts);
  expect(freshS.history).toEqual(oldS.history);
  expect(freshS.recordRunEvents).toEqual(oldS.recordRunEvents);
  expect(freshS.sessionFired).toEqual(oldS.sessionFired);
  expect(freshS.mgrSessions).toEqual(oldS.mgrSessions);
  return snaps;
}

/** 触发 fake session 事件。 */
const fire = (entry: any, ev: any) => entry.session.__handlers.forEach((h: any) => h(ev));

describe("B6-6-4i _create 主体收口", () => {
  it("成功创建：entry 组装 + customTools 39 工具名单 + tools 白名单 + 盒子回填 + sessions.set", async () => {
    const snaps = await runBothCreate();
    for (const s of snaps) {
      expect(s.thrown).toBeNull();
      // L3053 customTools 名单（managed 读/bash/写/编辑 + review_copy + 32 内置 + 2 子代理）
      expect(s.createArgs.customToolNames).toEqual([
        "read", "bash", "edit", "write", "review_copy", "ask_user", "officecli", "todo",
        "kb_search", "kb_read", "review_source_apply", "skills_search", "skills_read",
        "context_read", "map_read", "map_datasets", "map_edit", "map_import", "map_analyze",
        "map_template", "map_save_analysis", "map_clear_analysis", "memory_update",
        "complete_task", "web_search", "web_fetch", "browser_open", "browser_snapshot",
        "browser_click", "browser_type", "browser_press", "browser_scroll",
        "browser_screenshot", "browser_tabs", "browser_back", "browser_close",
        "run_subagent", "editorial_pipeline",
      ]);
      // L3054 tools 白名单（含 pi 扩展名）
      expect(s.createArgs.tools).toEqual([
        "read", "bash", "grep", "find", "ls", "write", "edit", "officecli", "review_copy",
        "ask_user", "todo", "kb_search", "kb_read", "review_source_apply", "skills_search",
        "skills_read", "context_read", "map_read", "map_datasets", "map_edit", "map_import",
        "map_analyze", "map_template", "map_save_analysis", "map_clear_analysis",
        "memory_update", "complete_task", "web_search", "web_fetch", "browser_open",
        "browser_snapshot", "browser_click", "browser_type", "browser_press", "browser_scroll",
        "browser_screenshot", "browser_tabs", "browser_back", "browser_close", "run_subagent",
        "editorial_pipeline", "ext_tool_1",
      ]);
      expect(s.createArgs.sessionStore).toBe(SESSION_STORE);
      expect(s.createArgs.model).toBeUndefined(); // resolveInitialModel(stub runtime) 无候选 → undefined
      expect(s.activeTools?.slice(-2)).toEqual(["editorial_pipeline", "ext_tool_1"]); // pi 扩展名在激活清单尾部
      expect(s.entry.mcpToolNames).toEqual([]);
      expect(s.entry.piExtensionToolNames).toEqual(["ext_tool_1"]);
      expect(s.entry.sessionModel).toEqual({ provider: "prov-x", id: "mdl-1", contextWindow: 128000 });
      expect(s.entry.promptChars).toBe(0);
      expect(s.entry.promptChainType).toBe("[object Promise]");
      expect(s.mgrSessions).toEqual(["c1"]);
      expect(s.beginRuntime).toEqual([[{ key: "c1", clientId: "c1", threadId: "t1", cwd: s.entry.workspace, profile: "通用 Agent" }]]);
      expect(s.bindSession).toEqual([["rt_new", "object", null, null]]); // norm 经 JSON 序列化，undefined 折叠为 null
      // 盒子回填：run_subagent 读 world.session（getActiveToolNames 含 write → canWrite）
      expect(s.entry.hasSubagent).toBe(true);
    }
  });

  it("workspace 无效：normalizeWorkspace 双路径皆空 → throw", async () => {
    const snaps = await runBothCreate({ depsOverrides: { normalizeWorkspace: () => null } }, () => {});
    expect(snaps[0].thrown.message).toBe("当前工作区不存在或不是文件夹");
  });

  it("modelRuntime 失败：markFailure(reason=model_runtime_create_failed) 后原样抛出", async () => {
    const snaps = await runBothCreate({ overrides: { modelRuntimeThrows: true } }, () => {});
    expect(snaps[0].thrown.message).toBe("模型运行时创建失败");
    expect(snaps[0].markFailure).toEqual([["rt_new", "模型运行时创建失败", { recovering: true, reason: "model_runtime_create_failed" }]]);
    expect(snaps[0].beginRuntime).toHaveLength(1);
    expect(snaps[0].mgrSessions).toEqual([]);
    expect(snaps[1].markFailure).toEqual(snaps[0].markFailure);
  });

  it("createSession 失败：markFailure(reason=session_create_failed) 后原样抛出", async () => {
    const snaps = await runBothCreate({ overrides: { createSessionThrows: true } });
    expect(snaps[0].thrown.message).toBe("会话创建失败");
    expect(snaps[0].markFailure).toEqual([["rt_new", "会话创建失败", { recovering: true, reason: "session_create_failed" }]]);
    expect(snaps[0].mgrSessions).toEqual([]);
  });

  it("loader：构造入参（cwd/agentDir/扩展路径/noSkills）+ agentsFilesOverride 系统提示逐字节一致", async () => {
    const snaps = await runBothCreate();
    for (const s of snaps) {
      expect(s.loaderOpts.cwd).toBe(s.entry.workspace);
      expect(s.loaderOpts.agentDir).toBe(AGENT_DIR);
      expect(s.loaderOpts.additionalExtensionPaths).toEqual(["/ext/a.mjs"]);
      expect(s.loaderOpts.noSkills).toBe(true);
      expect(s.loaderOpts.hasOverride).toBe("function");
      // agentsFilesOverride 展开的 content 逐字节比对（经 pickEntry 预计算字段，快照归一化后双侧对拍）
      const content = s.entry.loaderOverrideContent;
      expect(content.agentsFiles[0].path).toBe(".agent-context.md");
      expect(content.agentsFiles[0].content).toContain("# Open Plan（规聚）Workspace");
      expect(content.agentsFiles[0].content).toContain(buildOutputPolicyLines({ mode: "work" }).join("\n"));
      expect(content.agentsFiles[0].content).toContain("当前工作区绝对路径");
      expect(content.diagnostics).toEqual([]);
    }
    expect(snaps[1].entry.loaderOptions).toEqual(snaps[0].entry.loaderOptions);
  });

  it("mcp：注册名生成 + execute 审批链与结果拼装（双侧同流）", async () => {
    const mcpTools = [{
      server: { id: "srv-1", name: "TestServer" },
      tool: { name: "query", description: "查询数据", inputSchema: { type: "object", properties: { q: { type: "string" } } }, annotations: { readOnlyHint: true } },
    }, {
      server: { id: "srv-2", name: "WriteServer" },
      tool: { name: "write_thing", inputSchema: { type: "object" }, annotations: { readOnlyHint: true, destructiveHint: true } },
    }];
    // 注册名 hash 与旧实现同式现算：sha1(`${server.id}:${tool.name}`) 前 6 位
    const hash = (s: string) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 6);
    const name1 = safePiToolName(`mcp_srv-1_query_${hash("srv-1:query")}`, 62);
    const name2 = safePiToolName(`mcp_srv-2_write_thing_${hash("srv-2:write_thing")}`, 62);
    const snaps = await runBothCreate({ overrides: { mcpTools } }, async (_mgr, entry, h) => {
      entry.activeRunId = "run_1";
      const customTools = h.calls.createSession?.mock?.calls?.[0]?.[0]?.customTools ?? [];
      const mcpTool = customTools.find((t: any) => t?.name === name1);
      expect(mcpTool).toBeTruthy();
      const result = await mcpTool.execute("tc1", { q: "hello" }, null);
      expect(result).toEqual({
        content: [{ type: "text", text: "mcp-ok" }],
        details: { serverId: "srv-1", toolName: "query" },
        isError: false,
      });
      expect(h.calls.requireToolApproval).toHaveBeenCalledWith(expect.objectContaining({ tool: "mcp", entry }));
    });
    for (const s of snaps) {
      expect(s.entry.mcpToolNames).toEqual([name1, name2]);
      expect(s.entry.mcpReadOnlyToolNames).toEqual([name1]);
    }
  });

  it("review_copy：工作区内成功复制（write_started/write_locked/file_changed）；跨工作区 REVIEW_COPY_PATH_INVALID", async () => {
    const run = (escape: boolean) => runBothCreate({}, async (_mgr, entry, h) => {
      entry.activeRunId = "run_1";
      writeFileSync(path.join(entry.workspace, "源文件.md"), "# 源内容", "utf8");
      const customTools = h.calls.createSession?.mock?.calls?.[0]?.[0]?.customTools ?? [];
      const copyTool = customTools.find((t: any) => t?.name === "review_copy");
      expect(copyTool).toBeTruthy();
      if (escape) {
        const err: any = await copyTool.execute("tc1", { source: "../escape.md", destination: "审查副本/x.md" }, null).catch((e: any) => e);
        expect(err.code).toBe("REVIEW_COPY_PATH_INVALID");
      } else {
        const result = await copyTool.execute("tc1", { source: "源文件.md", destination: "审查副本/批注稿.md" }, null);
        expect(result.details.status).toBe("materialized");
        expect(result.details.source).toBe("源文件.md");
        expect(result.content[0].text).toContain("已生成审查副本：");
        expect(result.content[0].text).toContain("批注稿.md");
        expect(fsReal.existsSync(path.join(entry.workspace, "审查副本", "批注稿.md"))).toBe(true);
      }
    });
    const ok = await run(false);
    expect(ok[0].history.map((h: any) => h.type)).toEqual(["write_started", "write_locked", "file_changed"]);
    expect(ok[0].history[2].data.files).toEqual(["审查副本/批注稿.md"]);
    const blocked = await run(true);
    expect(blocked[0].history).toEqual([]);
  });

  it("事件 switch：agent_start/turn_start/turn_end/message_update 流 + token/thinking/boundary/tool_call_progress", async () => {
    const snaps = await runBothCreate({}, async (_mgr, entry) => {
      entry.activeRunId = "run_1";
      entry.sdkDispatchedRunId = "run_1";
      fire(entry, { type: "agent_start" });
      fire(entry, { type: "turn_start", turnIndex: 1 });
      fire(entry, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "你好", contentIndex: 0 } });
      fire(entry, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "思考中", contentIndex: 0 } });
      fire(entry, { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
      fire(entry, { type: "message_update", assistantMessageEvent: { type: "toolcall_start", id: "tc1", toolName: "read", contentIndex: 0 } });
      fire(entry, { type: "message_update", assistantMessageEvent: { type: "toolcall_delta", id: "tc1", delta: "abc", contentIndex: 0 } });
      fire(entry, { type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0 } });
      fire(entry, { type: "turn_end", toolResults: [1, 2] });
    });
    const types = snaps[0].history.map((h: any) => h.type);
    expect(types).toEqual(["agent_started", "turn_started", "token", "thinking", "text_boundary", "tool_call_progress", "tool_call_progress", "text_boundary", "turn_ended"]);
    for (const s of snaps) {
      expect(s.entry.turnCount).toBe(1);
      expect(s.entry.turnStarted).toBe(true);
      expect(s.entry.firstResponseReceived).toBe(true);
      expect(s.history[2].data).toEqual({ text: "你好", contentIndex: 0, runId: "run_1" });
    }
  });

  it("事件 switch：tool_execution_start/end + toolArgsById + gate + 工具门禁转译", async () => {
    const snaps = await runBothCreate({ overrides: { toolGateRejection: true } }, async (_mgr, entry) => {
      entry.activeRunId = "run_1";
      entry.sdkDispatchedRunId = "run_1";
      fire(entry, { type: "tool_execution_start", toolCallId: "tc1", toolName: "bash", args: { cmd: "ls" } });
      fire(entry, { type: "tool_execution_update", toolCallId: "tc1", toolName: "bash", partialResult: "partial-out" });
      fire(entry, { type: "tool_execution_end", toolCallId: "tc1", toolName: "bash", isError: true, result: "[工具门禁] 拒绝", error: "denied" });
    });
    const types = snaps[0].history.map((h: any) => h.type);
    expect(types).toEqual(["tool_start", "tool_output", "tool_end", "tool_gate_denied"]);
    for (const s of snaps) {
      expect(s.entry.activeToolCount).toBe(0);
      expect(s.entry.runToolCount).toBe(1);
      expect(s.history[1].data.output).toBe("partial-out");
      expect(s.history[2].data.isError).toBe(true);
      expect(s.history[3].data).toEqual({ toolCallId: "tc1", name: "bash", reason: "[工具门禁] 拒绝", runId: "run_1" });
    }
  });

  it("事件 switch：message_start/message_end → emitUsage stats + usage/stats 直传", async () => {
    const snaps = await runBothCreate({}, async (_mgr, entry) => {
      entry.activeRunId = "run_1";
      fire(entry, { type: "message_start", message: { id: "m1", role: "assistant" } });
      fire(entry, { type: "message_end", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "最终回答" }], usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, cost: 0.01 } });
      fire(entry, { type: "usage", usage: { inputTokens: 12, outputTokens: 6, totalTokens: 18 }, cost: 0.02 });
    });
    const types = snaps[0].history.map((h: any) => h.type);
    expect(types).toEqual(["message_start", "stats", "message_end", "stats"]);
    for (const s of snaps) {
      // usageFromEvent → normalizeUsage 展开 10 字段，只断言核心三项
      expect(s.entry.lastUsage).toMatchObject({ inputTokens: 12, outputTokens: 6, totalTokens: 18 });
      expect(s.entry.lastAssistantText).toBe("最终回答");
      // normalizeUsage 展开后 tokens 含全字段（cacheRead/cacheWrite 等），只断言核心三项
      expect(s.history[1].data.tokens).toMatchObject({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
      expect(s.history[1].data.contextTokens).toBe(15);
      expect(s.history[3].data.contextTokens).toBe(18);
    }
  });

  it("事件 switch：agent_end → agent_turn_end + context_usage（contextWindow 取 session.model）", async () => {
    const snaps = await runBothCreate({}, async (_mgr, entry) => {
      entry.activeRunId = "run_1";
      entry.turnCount = 2;
      entry.lastUsage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
      fire(entry, { type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "收尾" }] }], cost: 0.03 });
    });
    const types = snaps[0].history.map((h: any) => h.type);
    expect(types).toEqual(["agent_turn_end", "context_usage"]);
    for (const s of snaps) {
      expect(s.history[1].data.contextWindow).toBe(128000);
      expect(s.history[1].data.source).toBe("pi-sdk");
      expect(s.history[1].data.turnIndex).toBe(2);
      expect(s.entry.lastAssistantText).toBe("收尾");
    }
  });

  it("事件 switch：queue_update/compaction/bash_execution_update/auto_retry 双流一致", async () => {
    const snaps = await runBothCreate({}, async (_mgr, entry) => {
      entry.activeRunId = "run_1";
      fire(entry, { type: "queue_update", steering: true, followUp: false });
      fire(entry, { type: "compaction_start" });
      fire(entry, { type: "compaction_end", tokensBefore: 100, estimatedTokensAfter: 40 });
      fire(entry, { type: "bash_execution_update", id: "b1", output: "bash-line" });
      fire(entry, { type: "auto_retry_start", errorMessage: "连接超时", attempt: 1, maxAttempts: 3, delayMs: 2000 });
      fire(entry, { type: "auto_retry_end", success: true, attempt: 1 });
    });
    const types = snaps[0].history.map((h: any) => h.type);
    expect(types).toEqual(["agent_queue_update", "context_compacting", "context_compacted", "tool_output", "agent_retry", "agent_retry_end"]);
    for (const s of snaps) {
      expect(s.history[0].data).toEqual({ steering: true, followUp: false, runId: "run_1" });
      expect(s.history[3].data.name).toBe("bash");
      expect(s.history[5].data.success).toBe(true);
      expect(s.history[5].data.message).toBe("模型连接已恢复");
    }
  });

  it("事件 switch：agent_settled 错误分类 / 用户中断 aborted / assistant_final / agent_end 清理", async () => {
    const snaps = await runBothCreate({}, async (_mgr, entry) => {
      entry.activeRunId = "run_1";
      entry.turnCount = 3;
      entry.runToolCount = 5;
      entry.runStartedAt = Date.now() - 1000;
      entry.lastAgentError = "网络请求失败";
      entry.lastAssistantText = "权威文本";
      fire(entry, { type: "agent_settled" });
    });
    const types = snaps[0].history.map((h: any) => h.type);
    expect(types).toEqual(["agent_error", "assistant_final", "agent_end"]);
    for (const s of snaps) {
      expect(s.history[0].data.code).toBeTruthy();
      expect(s.history[0].data.retryable).toBeDefined();
      expect(s.history[1].data.text).toBe("权威文本");
      expect(s.history[2].data).toEqual({ turns: 3, tools: 5, durationMs: 1000, runId: "run_1" }); // fake timers 冻结 → 恰好 1000
      expect(s.entry.lastFinalText).toBe("权威文本");
      expect(s.entry.lastAgentError).toBeNull();
      expect(s.entry.lastAssistantText).toBe("");
    }
    // 用户中断路径：cancelRequested + 中断式错误 → aborted（不发 agent_error）
    const abortSnaps = await runBothCreate({}, async (_mgr, entry) => {
      entry.activeRunId = "run_2";
      entry.cancelRequested = true;
      entry.lastAgentError = "任务在完成前被中断";
      fire(entry, { type: "agent_settled" });
    });
    const abortTypes = abortSnaps[0].history.map((h: any) => h.type);
    expect(abortTypes).toEqual(["aborted", "agent_end"]); // aborted 后同 case 无条件收尾 agent_end
    expect(abortSnaps[0].history[0].data.reason).toBe("用户请求中断");
  });

  it("事件 switch：error case 分类 + abort-like 幂等 break", async () => {
    const snaps = await runBothCreate({}, async (_mgr, entry) => {
      entry.activeRunId = "run_1";
      fire(entry, { type: "error", error: { message: "模型服务不可用" } });
    });
    const types = snaps[0].history.map((h: any) => h.type);
    expect(types).toEqual(["agent_error"]);
    for (const s of snaps) {
      expect(s.entry.lastAgentError).toBe("模型服务不可用");
    }
  });

  it("emit：runId 注入 + recordRunEvent 白名单（agent_started 落盘，token 不落盘）", async () => {
    const snaps = await runBothCreate({}, async (_mgr, entry) => {
      entry.activeRunId = "run_1";
      entry.sdkDispatchedRunId = "run_1";
      fire(entry, { type: "agent_start" });
      fire(entry, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } });
    });
    // agent_started 在白名单 → recordRunEvent(activeRunId, type, 原始data)；token 不在 → 不落盘
    expect(snaps[0].recordRunEvents).toEqual([["run_1", "agent_started", {}]]);
    expect(snaps[0].history.some((h: any) => h.type === "token")).toBe(true);
    expect(snaps[1].recordRunEvents).toEqual(snaps[0].recordRunEvents);
  });

  it("turn_start：第 6 轮 steer 提醒（interval=6）+ isRunStopping 时不提醒", async () => {
    const snaps = await runBothCreate({}, async (_mgr, entry) => {
      entry.activeRunId = "run_1";
      entry.turnCount = 5;
      fire(entry, { type: "turn_start", turnIndex: 6 });
    });
    const types = snaps[0].history.map((h: any) => h.type);
    expect(types).toEqual(["turn_started", "steer"]);
    for (const s of snaps) {
      expect(s.history[1].data.source).toBe("turn-progress");
      expect(s.history[1].data.turnCount).toBe(6);
      expect(s.entry.turnCount).toBe(6);
    }
    // isRunStopping（cancelRequested 快速路径）→ 不发 steer
    const stopSnaps = await runBothCreate({}, async (mgr, entry) => {
      entry.activeRunId = "run_1";
      entry.turnCount = 5;
      entry.cancelRequested = true;
      mgr.sessions.set("c1", entry);
      fire(entry, { type: "turn_start", turnIndex: 6 });
    });
    const stopTypes = stopSnaps[0].history.map((h: any) => h.type);
    expect(stopTypes).toEqual(["turn_started"]);
  });

  it("eventNormalize 开启：信封携带 canonical 视图", async () => {
    const snaps = await runBothCreate({ flags: { eventNormalize: true } }, async (_mgr, entry) => {
      entry.activeRunId = "run_1";
      fire(entry, { type: "agent_start" });
    });
    for (const s of snaps) {
      expect(s.history[0].canonical).toBeTruthy();
    }
  });
});
