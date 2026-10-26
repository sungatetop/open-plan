/**
 * B2 装配层测试：AgentManager 真实 deps 装配（assembly.ts）。
 *
 * 覆盖：legacyTools 45 成员键集与形态（全部 TS 直绑，B2-17 过渡桥清零）/
 * deps 必填面 9 项（piRuntimeManager·contextTokensFromUsage 与 pi-runtime.ts 同一引用、
 * getRun、memory 六函数别名适配、emitDeps.recordRunEvent）/ createAgentManager 构造 /
 * getAgentManager 单飞 / isAgentDomainEnabled flag 判定。
 *
 * 口径说明：全部域自 B2-4～B2-17 起为 TS 直绑（静态 import src/main/backend 同一模块
 * 实例，断言与 TS 模块导出同一引用）；B2-17 起旧 server 模块物理路径动态加载管道
 * （importLegacyModule）已随最后一桥退役并整体移除。测试断言只验绑定面形态，不调用业务函数。
 */
import { describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/main/backend/agent/agent-manager";
import {
  piRuntimeManager,
  contextTokensFromUsage,
} from "../src/main/backend/agent/pi-runtime";
import { requireToolApproval } from "../src/main/backend/agent/approval-policy";
import { normalizeBashOptions } from "../src/main/backend/agent/command-safety-policy";
import { SUBAGENT_ROLES, resolveRole, orchestrateSubagents } from "../src/main/backend/agent/subagent-orchestrator";
import { completionStatusLabel, normalizeCompletion } from "../src/shared/runtime/run-trace";
import * as runsDomain from "../src/main/backend/runs";
import * as memoryDomain from "../src/main/backend/memory-management";
import * as memoryAdmissionDomain from "../src/main/backend/memory-admission";
import * as filePermissionErrorDomain from "../src/main/backend/file-permission-error";
import * as officeParamsDomain from "../src/main/backend/office-params";
import * as workspaceGuardDomain from "../src/main/backend/workspace-guard";
import * as projectManagementDomain from "../src/main/backend/project-management";
import * as kernelSidecarDomain from "../src/main/backend/kernel-sidecar";
import * as mapAnalysisDomain from "../src/main/backend/map-analysis";
import * as editorialPipelineDomain from "../src/main/backend/editorial-pipeline";
import * as mcpManagementDomain from "../src/main/backend/mcp-management";
import * as webSearchDomain from "../src/main/backend/web-search";
import * as webReaderDomain from "../src/main/backend/web-reader";
import * as browserDomain from "../src/main/backend/builtin-browser";
import * as piExtensionDomain from "../src/main/backend/agent/pi-extension-management";
import {
  buildAgentManagerDeps,
  createAgentManager,
  getAgentManager,
  isAgentDomainEnabled,
} from "../src/main/backend/agent/assembly";

/** LegacyAgentTools 全部 45 键（agent-manager.ts L112-160 接口成员清单）。 */
const LEGACY_TOOLS_KEYS = [
  "defineTool", "Type", "DefaultResourceLoader",
  "createBashToolDefinition", "createReadToolDefinition", "createWriteToolDefinition",
  "createEditToolDefinition", "createLocalBashOperations",
  "enabledPiExtensionEntries", "enabledPiExtensionPaths", "cachedMcpTools", "callMcpTool",
  "requireToolApproval", "normalizeBashOptions", "isToolGateRejection",
  "normalizeOfficeFailure", "parseArgs", "collectReferencedPaths", "ensureOfficeOutputDirs",
  "webSearch", "webFetch",
  "browserOpen", "browserSnapshot", "browserClick", "browserType", "browserPress",
  "browserScroll", "browserScreenshot", "browserBack", "browserTabs", "browserClose",
  "browserSessionKey",
  "getBashSidecar", "createDemoAnalysis", "normalizeCompletion", "completionStatusLabel",
  "evaluateMemoryCandidate", "getProjectForWorkspace", "updateRunTodo",
  "listStoredMemoryProposals", "createMemoryProposal",
  "SUBAGENT_ROLES", "resolveRole", "orchestrateSubagents", "runEditorialPipeline",
] as const;

/** 键形态例外：对象型成员（其余 43 键均为 function）。 */
const OBJECT_KEYS = new Set<string>(["Type", "SUBAGENT_ROLES"]);

describe("B2 装配层：deps 面绑定", () => {
  it("legacyTools 45 键集完整且形态正确（function/对象特例）", async () => {
    const deps = await buildAgentManagerDeps();
    const tools = deps.legacyTools as unknown as Record<string, unknown>;
    expect(Object.keys(tools).sort()).toEqual([...LEGACY_TOOLS_KEYS].sort());
    for (const key of LEGACY_TOOLS_KEYS) {
      if (OBJECT_KEYS.has(key)) {
        expect(tools[key], key).toBeTypeOf("object");
      } else {
        expect(tools[key], key).toBeTypeOf("function");
      }
    }
  });

  it("TS 已迁件引用同一性（pi-runtime/approval/command-safety/subagent-orchestrator/run-trace/runs/memory）", async () => {
    const deps = await buildAgentManagerDeps();
    const tools = deps.legacyTools as unknown as Record<string, unknown>;
    // pi 域单一事实源：pi-runtime.ts re-export（SDK 同一实例语义）
    expect(deps.piRuntimeManager).toBe(piRuntimeManager);
    expect(deps.contextTokensFromUsage).toBe(contextTokensFromUsage);
    expect(tools.defineTool).toBe((await import("../src/main/backend/agent/pi-runtime")).defineTool);
    // B6-1/B6-2 已迁实现直绑
    expect(tools.requireToolApproval).toBe(requireToolApproval);
    expect(tools.normalizeBashOptions).toBe(normalizeBashOptions);
    expect(tools.SUBAGENT_ROLES).toBe(SUBAGENT_ROLES);
    expect(tools.resolveRole).toBe(resolveRole);
    expect(tools.orchestrateSubagents).toBe(orchestrateSubagents);
    expect(tools.normalizeCompletion).toBe(normalizeCompletion);
    expect(tools.completionStatusLabel).toBe(completionStatusLabel);
    // B2-4：runs/memory 域 TS 直绑（同一模块实例引用）
    expect(tools.updateRunTodo).toBe(runsDomain.updateRunTodo);
    expect(deps.getRun).toBe(runsDomain.getRun);
    expect(deps.emitDeps?.recordRunEvent).toBe(runsDomain.recordRunEvent);
    expect(tools.listStoredMemoryProposals).toBe(memoryDomain.listMemoryProposals);
    expect(tools.createMemoryProposal).toBe(memoryDomain.createMemoryProposal);
    expect(deps.listStoredMemoryProposals).toBe(memoryDomain.listMemoryProposals);
    expect(deps.approveStoredMemoryProposal).toBe(memoryDomain.approveMemoryProposal);
    expect(deps.editStoredMemoryProposal).toBe(memoryDomain.editMemoryProposal);
    expect(deps.rejectStoredMemoryProposal).toBe(memoryDomain.rejectMemoryProposal);
    expect(deps.mergeMemoryProposals).toBe(memoryDomain.mergeMemoryProposals);
    expect(deps.getMemoryProposalHistory).toBe(memoryDomain.getMemoryProposalHistory);
    // B2-5：memory 准入域 TS 直绑
    expect(tools.evaluateMemoryCandidate).toBe(memoryAdmissionDomain.evaluateMemoryCandidate);
    // B2-6：文件权限/占用错误归一域 TS 直绑
    expect(tools.normalizeOfficeFailure).toBe(filePermissionErrorDomain.normalizeOfficeFailure);
    // B2-7：officecli 参数处理域 TS 直绑
    expect(tools.parseArgs).toBe(officeParamsDomain.parseOfficeArgs);
    expect(tools.collectReferencedPaths).toBe(officeParamsDomain.collectReferencedPaths);
    expect(tools.ensureOfficeOutputDirs).toBe(officeParamsDomain.ensureOfficeOutputDirs);
    // B2-8：工具门禁拒绝标记域 TS 直绑
    expect(tools.isToolGateRejection).toBe(workspaceGuardDomain.isToolGateRejection);
    // B2-9：项目管理域 TS 直绑
    expect(tools.getProjectForWorkspace).toBe(projectManagementDomain.getProjectForWorkspace);
    // B2-10：内核侧车域 TS 直绑
    expect(tools.getBashSidecar).toBe(kernelSidecarDomain.getBashSidecar);
    // B2-11：地图分析演示数据域 TS 直绑
    expect(tools.createDemoAnalysis).toBe(mapAnalysisDomain.createDemoAnalysis);
    // B2-12：编辑流水线域 TS 直绑
    expect(tools.runEditorialPipeline).toBe(editorialPipelineDomain.runEditorialPipeline);
    // B2-14：MCP 管理域 TS 直绑
    expect(tools.cachedMcpTools).toBe(mcpManagementDomain.cachedMcpTools);
    expect(tools.callMcpTool).toBe(mcpManagementDomain.callMcpTool);
    // B2-15：联网搜索/网页读取域 TS 直绑
    expect(tools.webSearch).toBe(webSearchDomain.webSearch);
    expect(tools.webFetch).toBe(webReaderDomain.webFetch);
    // B2-16：浏览器域 TS 直绑
    expect(tools.browserOpen).toBe(browserDomain.browserOpen);
    expect(tools.browserSessionKey).toBe(browserDomain.browserSessionKey);
    expect(tools.browserClose).toBe(browserDomain.browserClose);
    // B2-17：pi 扩展域 TS 直绑（过渡桥清零）
    expect(tools.enabledPiExtensionEntries).toBe(piExtensionDomain.enabledPiExtensionEntries);
    expect(tools.enabledPiExtensionPaths).toBe(piExtensionDomain.enabledPiExtensionPaths);
  });

  it("deps 必填面 9 项就位（getRun + memory 六函数别名适配 + emitDeps.recordRunEvent）", async () => {
    const deps = await buildAgentManagerDeps();
    expect(deps.getRun).toBeTypeOf("function");
    expect(deps.listStoredMemoryProposals).toBeTypeOf("function");
    expect(deps.approveStoredMemoryProposal).toBeTypeOf("function");
    expect(deps.editStoredMemoryProposal).toBeTypeOf("function");
    expect(deps.rejectStoredMemoryProposal).toBeTypeOf("function");
    expect(deps.mergeMemoryProposals).toBeTypeOf("function");
    expect(deps.getMemoryProposalHistory).toBeTypeOf("function");
    expect(deps.emitDeps?.recordRunEvent).toBeTypeOf("function");
    expect(deps.flags).toBeDefined();
  });

  it("别名适配同源：listStoredMemoryProposals=TS listMemoryProposals（B2-4 直绑）、parseArgs=TS parseOfficeArgs（B2-7 直绑）", async () => {
    const deps = await buildAgentManagerDeps();
    expect(deps.listStoredMemoryProposals).toBe(memoryDomain.listMemoryProposals);
    const tools = deps.legacyTools as unknown as Record<string, unknown>;
    expect(tools.parseArgs).toBe(officeParamsDomain.parseOfficeArgs);
  });
});

describe("B2 装配层：AgentManager 构造与单飞", () => {
  it("createAgentManager 构造成功且为 AgentManager 实例", async () => {
    const mgr = await createAgentManager();
    expect(mgr).toBeInstanceOf(AgentManager);
  });

  it("getAgentManager 单飞：两次调用返回同一实例", async () => {
    const [a, b] = await Promise.all([getAgentManager(), getAgentManager()]);
    expect(a).toBe(b);
    expect(a).toBeInstanceOf(AgentManager);
  });
});

describe("B2 装配层：flag 判定", () => {
  it("OP_DESKTOP_AGENT_DOMAIN 未设/非 0 → 开（S4 默认路径翻转），=0 → 关", () => {
    vi.stubEnv("OP_DESKTOP_AGENT_DOMAIN", "");
    expect(isAgentDomainEnabled()).toBe(true);
    vi.stubEnv("OP_DESKTOP_AGENT_DOMAIN", "1");
    expect(isAgentDomainEnabled()).toBe(true);
    vi.stubEnv("OP_DESKTOP_AGENT_DOMAIN", "0");
    expect(isAgentDomainEnabled()).toBe(false);
    vi.unstubAllEnvs();
  });
});
