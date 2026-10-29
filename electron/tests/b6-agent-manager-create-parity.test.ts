/**
 * B6-6-4i 行为覆盖：AgentManager._create 主体收口批（server/agent.mjs L1020-3458 的 TS 转录）。
 *
 * 覆盖：局部装配（workspace 归一/beginRuntime/modelRuntime 失败标记/DefaultResourceLoader
 * 构造与系统提示/mcp 注册与定义/review 族/managed 读写编辑工具/review_copy/
 * withWorkspaceWriteLock）+ 4g/4h 工厂接线（buildCreateTools/buildSubagentTools 同 world，
 * officeTool 回传）+ session 装配（customTools 39 工具名单 + tools 白名单 + setActiveTools
 * 补激活）+ channel/emit（runId 注入/eventNormalize/recordRunEvent 白名单）/emitUsage
 * （normalizeUsage 分支 + contextUsage 适配）/session.subscribe 事件 switch 20 case/entry
 * 组装（40+ 字段）+ 盒子回填（world.entry/world.session）。
 *
 * R6-6b 对拍退役改写：旧侧行号提取类体（4a 段 + _create 完整体 + resolveEntryContextWindowInfo
 * + new Function 100+ 同名参数注入）随 server/agent.mjs 退役删除，仅保留 TS AgentManager
 * 单侧断言（快照值此前已经双侧对拍固化，现改为直接断言）。
 * harness 独立（真实写锁/暂存不跨侧残留），快照经 tmpWs/streamId 归一化。
 * fake timers + setSystemTime 全文件冻结（信封 at + Date.now）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { AgentManager, type AgentManagerDeps, type LegacyAgentTools } from "../src/main/backend/agent/agent-manager";
import { buildOutputPolicyLines } from "../src/main/backend/agent/prompt-chain";
import { safePiToolName } from "../src/main/backend/agent/tool-schema";
import { SESSION_STORE } from "../src/main/backend/agent/session-store";
import { AGENT_DIR, getWorkspace, normalizeWorkspace as normalizeWsReal } from "../src/main/backend/workspace";

// 冻结时钟：信封 at=ISO + Date.now（lastPiEventAt 等）
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// 轻量 Type stub
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

const ROLES: any = {
  scout: { label: "资料探索", readOnly: true, timeoutMs: 60000, prompt: "探索并汇总资料", tools: ["read"] },
  reviewer: { label: "审阅", readOnly: true, timeoutMs: 90000, prompt: "审阅检查", tools: ["read"] },
  planner: { label: "方案拆解", readOnly: true, timeoutMs: 60000, prompt: "拆解方案", tools: ["read"] },
  verifier: { label: "独立核验", readOnly: true, timeoutMs: 90000, prompt: "独立核验", tools: ["read"] },
  worker: { label: "可写执行", readOnly: false, timeoutMs: 300000, prompt: "执行任务", tools: ["read", "write", "edit", "officecli"] },
};

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

/** harness：独立工作区与调用记录（真实写锁/暂存不跨残留）。 */
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
  return { tmpWs, calls, recordRunEvent, fakeSession, flags, tools, deps, piRuntimeManager };
}

// 快照序列化：函数值折叠为占位符
const snapFn = (_k: string, v: any) => (typeof v === "function" ? "ƒ" : v);

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
 * 单侧跑 _create：harness → _create → drive（事件/工具调用）→ 快照。
 * 快照：entry 挑选字段 / createSession 入参 / seam 调用记录 / 通道历史（归一化 tmpWs/streamId）。
 */
async function runCreate(opts: Parameters<typeof makeHarness>[0] = {}, drive?: (mgr: any, entry: any, h: ReturnType<typeof makeHarness>) => Promise<void> | void) {
  const h = makeHarness(opts);
  const mgr = new AgentManager(h.deps);
  let entry: any;
  let thrown: any = null;
  try {
    entry = await mgr._create("c1", { cwd: h.tmpWs, threadId: "t1", ...(opts.createOptions || {}) });
    if (drive) await drive(mgr, entry, h);
  } catch (error) { thrown = error; }
  const wsKey = JSON.stringify(h.tmpWs).slice(1, -1);
  const norm = (v: any) => JSON.parse(JSON.stringify(v, snapFn).split(wsKey).join("<WS>").replace(/"streamId":"[^"]*"/g, '"streamId":"<SID>"'));
  const loaderCalls = h.calls.beginRuntime?.mock?.calls || [];
  return {
    thrown: thrown ? { message: thrown.message, code: (thrown as any).code } : null,
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
  };
}

/** 触发 fake session 事件。 */
const fire = (entry: any, ev: any) => entry.session.__handlers.forEach((h: any) => h(ev));

describe("B6-6-4i _create 主体收口", () => {
  it("成功创建：entry 组装 + customTools 39 工具名单 + tools 白名单 + 盒子回填 + sessions.set", async () => {
    const s = await runCreate();
    expect(s.thrown).toBeNull();
    // customTools 名单（managed 读/bash/写/编辑 + review_copy + 32 内置 + 2 子代理）
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
    // tools 白名单（含 pi 扩展名）
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
  });

  it("workspace 无效：normalizeWorkspace 双路径皆空 → throw", async () => {
    const s = await runCreate({ depsOverrides: { normalizeWorkspace: () => null } }, () => {});
    expect(s.thrown?.message).toBe("当前工作区不存在或不是文件夹");
  });

  it("modelRuntime 失败：markFailure(reason=model_runtime_create_failed) 后原样抛出", async () => {
    const s = await runCreate({ overrides: { modelRuntimeThrows: true } }, () => {});
    expect(s.thrown?.message).toBe("模型运行时创建失败");
    expect(s.markFailure).toEqual([["rt_new", "模型运行时创建失败", { recovering: true, reason: "model_runtime_create_failed" }]]);
    expect(s.beginRuntime).toHaveLength(1);
    expect(s.mgrSessions).toEqual([]);
  });

  it("createSession 失败：markFailure(reason=session_create_failed) 后原样抛出", async () => {
    const s = await runCreate({ overrides: { createSessionThrows: true } });
    expect(s.thrown?.message).toBe("会话创建失败");
    expect(s.markFailure).toEqual([["rt_new", "会话创建失败", { recovering: true, reason: "session_create_failed" }]]);
    expect(s.mgrSessions).toEqual([]);
  });

  it("loader：构造入参（cwd/agentDir/扩展路径/noSkills）+ agentsFilesOverride 系统提示逐字节一致", async () => {
    const s = await runCreate();
    expect(s.loaderOpts.cwd).toBe(s.entry.workspace);
    expect(s.loaderOpts.agentDir).toBe(AGENT_DIR);
    expect(s.loaderOpts.additionalExtensionPaths).toEqual(["/ext/a.mjs"]);
    expect(s.loaderOpts.noSkills).toBe(true);
    expect(s.loaderOpts.hasOverride).toBe("function");
    // agentsFilesOverride 展开的 content 逐字节断言
    const content = s.entry.loaderOverrideContent;
    expect(content.agentsFiles[0].path).toBe(".agent-context.md");
    expect(content.agentsFiles[0].content).toContain("# Open Plan（规聚）Workspace");
    expect(content.agentsFiles[0].content).toContain(buildOutputPolicyLines({ mode: "work" }).join("\n"));
    expect(content.agentsFiles[0].content).toContain("当前工作区绝对路径");
    expect(content.diagnostics).toEqual([]);
  });

  it("mcp：注册名生成 + execute 审批链与结果拼装", async () => {
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
    const s = await runCreate({ overrides: { mcpTools } }, async (_mgr, entry, h) => {
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
    expect(s.entry.mcpToolNames).toEqual([name1, name2]);
    expect(s.entry.mcpReadOnlyToolNames).toEqual([name1]);
  });

  it("review_copy：工作区内成功复制（write_started/write_locked/file_changed）；跨工作区 REVIEW_COPY_PATH_INVALID", async () => {
    const run = (escape: boolean) => runCreate({}, async (_mgr, entry, h) => {
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
        expect(existsSync(path.join(entry.workspace, "审查副本", "批注稿.md"))).toBe(true);
      }
    });
    const ok = await run(false);
    expect(ok.history.map((h: any) => h.type)).toEqual(["write_started", "write_locked", "file_changed"]);
    expect(ok.history[2].data.files).toEqual(["审查副本/批注稿.md"]);
    const blocked = await run(true);
    expect(blocked.history).toEqual([]);
  });

  it("事件 switch：agent_start/turn_start/turn_end/message_update 流 + token/thinking/boundary/tool_call_progress", async () => {
    const s = await runCreate({}, async (_mgr, entry) => {
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
    expect(s.history.map((h: any) => h.type)).toEqual(["agent_started", "turn_started", "token", "thinking", "text_boundary", "tool_call_progress", "tool_call_progress", "text_boundary", "turn_ended"]);
    expect(s.entry.turnCount).toBe(1);
    expect(s.entry.turnStarted).toBe(true);
    expect(s.entry.firstResponseReceived).toBe(true);
    expect(s.history[2].data).toEqual({ text: "你好", contentIndex: 0, runId: "run_1" });
  });

  it("事件 switch：tool_execution_start/end + toolArgsById + gate + 工具门禁转译", async () => {
    const s = await runCreate({ overrides: { toolGateRejection: true } }, async (_mgr, entry) => {
      entry.activeRunId = "run_1";
      entry.sdkDispatchedRunId = "run_1";
      fire(entry, { type: "tool_execution_start", toolCallId: "tc1", toolName: "bash", args: { cmd: "ls" } });
      fire(entry, { type: "tool_execution_update", toolCallId: "tc1", toolName: "bash", partialResult: "partial-out" });
      fire(entry, { type: "tool_execution_end", toolCallId: "tc1", toolName: "bash", isError: true, result: "[工具门禁] 拒绝", error: "denied" });
    });
    expect(s.history.map((h: any) => h.type)).toEqual(["tool_start", "tool_output", "tool_end", "tool_gate_denied"]);
    expect(s.entry.activeToolCount).toBe(0);
    expect(s.entry.runToolCount).toBe(1);
    expect(s.history[1].data.output).toBe("partial-out");
    expect(s.history[2].data.isError).toBe(true);
    expect(s.history[3].data).toEqual({ toolCallId: "tc1", name: "bash", reason: "[工具门禁] 拒绝", runId: "run_1" });
  });

  it("事件 switch：message_start/message_end → emitUsage stats + usage/stats 直传", async () => {
    const s = await runCreate({}, async (_mgr, entry) => {
      entry.activeRunId = "run_1";
      fire(entry, { type: "message_start", message: { id: "m1", role: "assistant" } });
      fire(entry, { type: "message_end", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "最终回答" }], usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, cost: 0.01 } });
      fire(entry, { type: "usage", usage: { inputTokens: 12, outputTokens: 6, totalTokens: 18 }, cost: 0.02 });
    });
    expect(s.history.map((h: any) => h.type)).toEqual(["message_start", "stats", "message_end", "stats"]);
    // usageFromEvent → normalizeUsage 展开 10 字段，只断言核心三项
    expect(s.entry.lastUsage).toMatchObject({ inputTokens: 12, outputTokens: 6, totalTokens: 18 });
    expect(s.entry.lastAssistantText).toBe("最终回答");
    // normalizeUsage 展开后 tokens 含全字段（cacheRead/cacheWrite 等），只断言核心三项
    expect(s.history[1].data.tokens).toMatchObject({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(s.history[1].data.contextTokens).toBe(15);
    expect(s.history[3].data.contextTokens).toBe(18);
  });

  it("事件 switch：agent_end → agent_turn_end + context_usage（contextWindow 取 session.model）", async () => {
    const s = await runCreate({}, async (_mgr, entry) => {
      entry.activeRunId = "run_1";
      entry.turnCount = 2;
      entry.lastUsage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
      fire(entry, { type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "收尾" }] }], cost: 0.03 });
    });
    expect(s.history.map((h: any) => h.type)).toEqual(["agent_turn_end", "context_usage"]);
    expect(s.history[1].data.contextWindow).toBe(128000);
    expect(s.history[1].data.source).toBe("pi-sdk");
    expect(s.history[1].data.turnIndex).toBe(2);
    expect(s.entry.lastAssistantText).toBe("收尾");
  });

  it("事件 switch：queue_update/compaction/bash_execution_update/auto_retry", async () => {
    const s = await runCreate({}, async (_mgr, entry) => {
      entry.activeRunId = "run_1";
      fire(entry, { type: "queue_update", steering: true, followUp: false });
      fire(entry, { type: "compaction_start" });
      fire(entry, { type: "compaction_end", tokensBefore: 100, estimatedTokensAfter: 40 });
      fire(entry, { type: "bash_execution_update", id: "b1", output: "bash-line" });
      fire(entry, { type: "auto_retry_start", errorMessage: "连接超时", attempt: 1, maxAttempts: 3, delayMs: 2000 });
      fire(entry, { type: "auto_retry_end", success: true, attempt: 1 });
    });
    expect(s.history.map((h: any) => h.type)).toEqual(["agent_queue_update", "context_compacting", "context_compacted", "tool_output", "agent_retry", "agent_retry_end"]);
    expect(s.history[0].data).toEqual({ steering: true, followUp: false, runId: "run_1" });
    expect(s.history[3].data.name).toBe("bash");
    expect(s.history[5].data.success).toBe(true);
    expect(s.history[5].data.message).toBe("模型连接已恢复");
  });

  it("事件 switch：agent_settled 错误分类 / 用户中断 aborted / assistant_final / agent_end 清理", async () => {
    const s = await runCreate({}, async (_mgr, entry) => {
      entry.activeRunId = "run_1";
      entry.turnCount = 3;
      entry.runToolCount = 5;
      entry.runStartedAt = Date.now() - 1000;
      entry.lastAgentError = "网络请求失败";
      entry.lastAssistantText = "权威文本";
      fire(entry, { type: "agent_settled" });
    });
    expect(s.history.map((h: any) => h.type)).toEqual(["agent_error", "assistant_final", "agent_end"]);
    expect(s.history[0].data.code).toBeTruthy();
    expect(s.history[0].data.retryable).toBeDefined();
    expect(s.history[1].data.text).toBe("权威文本");
    expect(s.history[2].data).toEqual({ turns: 3, tools: 5, durationMs: 1000, runId: "run_1" }); // fake timers 冻结 → 恰好 1000
    expect(s.entry.lastFinalText).toBe("权威文本");
    expect(s.entry.lastAgentError).toBeNull();
    expect(s.entry.lastAssistantText).toBe("");
    // 用户中断路径：cancelRequested + 中断式错误 → aborted（不发 agent_error）
    const abortSnap = await runCreate({}, async (_mgr, entry) => {
      entry.activeRunId = "run_2";
      entry.cancelRequested = true;
      entry.lastAgentError = "任务在完成前被中断";
      fire(entry, { type: "agent_settled" });
    });
    expect(abortSnap.history.map((h: any) => h.type)).toEqual(["aborted", "agent_end"]); // aborted 后同 case 无条件收尾 agent_end
    expect(abortSnap.history[0].data.reason).toBe("用户请求中断");
  });

  it("事件 switch：error case 分类 + abort-like 幂等 break", async () => {
    const s = await runCreate({}, async (_mgr, entry) => {
      entry.activeRunId = "run_1";
      fire(entry, { type: "error", error: { message: "模型服务不可用" } });
    });
    expect(s.history.map((h: any) => h.type)).toEqual(["agent_error"]);
    expect(s.entry.lastAgentError).toBe("模型服务不可用");
  });

  it("emit：runId 注入 + recordRunEvent 白名单（agent_started 落盘，token 不落盘）", async () => {
    const s = await runCreate({}, async (_mgr, entry) => {
      entry.activeRunId = "run_1";
      entry.sdkDispatchedRunId = "run_1";
      fire(entry, { type: "agent_start" });
      fire(entry, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } });
    });
    // agent_started 在白名单 → recordRunEvent(activeRunId, type, 原始data)；token 不在 → 不落盘
    expect(s.recordRunEvents).toEqual([["run_1", "agent_started", {}]]);
    expect(s.history.some((h: any) => h.type === "token")).toBe(true);
  });

  it("turn_start：第 6 轮 steer 提醒（interval=6）+ isRunStopping 时不提醒", async () => {
    const s = await runCreate({}, async (_mgr, entry) => {
      entry.activeRunId = "run_1";
      entry.turnCount = 5;
      fire(entry, { type: "turn_start", turnIndex: 6 });
    });
    expect(s.history.map((h: any) => h.type)).toEqual(["turn_started", "steer"]);
    expect(s.history[1].data.source).toBe("turn-progress");
    expect(s.history[1].data.turnCount).toBe(6);
    expect(s.entry.turnCount).toBe(6);
    // isRunStopping（cancelRequested 快速路径）→ 不发 steer
    const stopSnap = await runCreate({}, async (mgr, entry) => {
      entry.activeRunId = "run_1";
      entry.turnCount = 5;
      entry.cancelRequested = true;
      mgr.sessions.set("c1", entry);
      fire(entry, { type: "turn_start", turnIndex: 6 });
    });
    expect(stopSnap.history.map((h: any) => h.type)).toEqual(["turn_started"]);
  });

  it("eventNormalize 开启：信封携带 canonical 视图", async () => {
    const s = await runCreate({ flags: { eventNormalize: true } }, async (_mgr, entry) => {
      entry.activeRunId = "run_1";
      fire(entry, { type: "agent_start" });
    });
    expect(s.history[0].canonical).toBeTruthy();
  });
});
