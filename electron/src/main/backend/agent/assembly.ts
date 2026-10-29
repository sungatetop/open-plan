/**
 * B2 装配层（agent 域收编第一站）——AgentManager 真实依赖装配。
 *
 * B6-1～B6-7 各批 TS 模块此前未接入运行时（对拍覆盖）；本模块把 AgentManager 的
 * deps 面一次性接通：已迁 TS 实现直绑（pi-runtime 单例 / approval-policy /
 * command-safety-policy / subagent-orchestrator / shared run-trace / runs B2-2 /
 * memory B2-3 / memory-admission B2-5 / file-permission-error B2-6 / office-params
 * B2-7 / workspace-guard B2-8 / project-management B2-9 / kernel-sidecar B2-10 /
 * map-analysis B2-11 / editorial-pipeline B2-12 / mcp-management B2-14 / web-search B2-15 /
 * web-reader B2-15 / builtin-browser B2-16 / pi-extension B2-17）。
 * B2-17 过渡桥清零：legacyTools 45 成员全部为 TS 直绑（静态 import 同一模块实例）。
 *
 * runs/memory 直绑（B2-4）：静态 import src/main/backend 同一模块实例（非过渡桥）；
 * 两域落地锚点与旧实现同一 env 体系（OAW_RUNS_DIR/OAW_EVENT_DIR/OAW_MEMORY_PROPOSALS_FILE/
 * OAW_WRITE_LOCK_DIR），与 legacy sidecar 旧实例写同一文件族（事件流/锁文件互斥跨实例有效）。
 * getRun/recordRunEvent 绑定处显式收窄转换（deps 形参 unknown vs TS 实现形参 string，
 * strictFunctionTypes 不变式；piRuntimeManager 同先例）。
 *
 * 过渡桥历史记录：迁移期旧 server 模块曾以**运行时物理路径动态 import**绑定（与
 * main/index.ts legacy-server sidecar 同一 projectRoot 定位），不走 rollup 打包——
 * 旧 ESM 模块的路径锚点（fileURLToPath(import.meta.url)）在 cjs bundle 中不保真，
 * 打包会让 RUNS_DIR/SESSION_STORE 等落点漂移；从源文件加载则锚点全对。B2-17 起
 * 全域 TS 直绑，物理路径加载管道随之退役。`@legacy-server` 生产 alias 仅作构建域
 * 备用（electron.vite.config.ts main 段），测试域 alias 见 vitest.config.ts。
 *
 * 消费点：main/index.ts 经 OP_DESKTOP_AGENT_DOMAIN 门控（S4 起默认开，=0 显式关闭
 * 回滚——docs/solutions/2026-10-24-agent域流量切换评估方案.md §4-S4）动态 import
 * 本模块并 getAgentManager()；sidecar 旧域共存直至 F 线收尾退役。
 */
import { Type } from "typebox";
import { AgentManager, type AgentManagerDeps, type LegacyAgentTools } from "./agent-manager";
import {
  piRuntimeManager,
  contextTokensFromUsage,
  createBashToolDefinition,
  createEditToolDefinition,
  createLocalBashOperations,
  createReadToolDefinition,
  createWriteToolDefinition,
  DefaultResourceLoader,
  defineTool,
} from "./pi-runtime";
import { requireToolApproval } from "./approval-policy";
import { normalizeBashOptions } from "./command-safety-policy";
import { SUBAGENT_ROLES, resolveRole, orchestrateSubagents } from "./subagent-orchestrator";
import { completionStatusLabel, normalizeCompletion } from "../../../shared/runtime/run-trace";
import { RUNTIME_FLAGS } from "../../../shared/runtime/feature-flags";
import * as runsDomain from "../runs";
import * as memoryDomain from "../memory-management";
import * as memoryAdmissionDomain from "../memory-admission";
import * as filePermissionErrorDomain from "../file-permission-error";
import * as officeParamsDomain from "../office-params";
import * as workspaceGuardDomain from "../workspace-guard";
import * as projectManagementDomain from "../project-management";
import * as kernelSidecarDomain from "../kernel-sidecar";
import * as mapAnalysisDomain from "../map-analysis";
import * as editorialPipelineDomain from "../editorial-pipeline";
import * as mcpManagementDomain from "../mcp-management";
import * as webSearchDomain from "../web-search";
import * as webReaderDomain from "../web-reader";
import * as browserDomain from "../builtin-browser";
import * as piExtensionDomain from "./pi-extension-management";

/** 装配 AgentManager 全量 deps：TS 已迁实现全量直绑（45 成员 legacyTools + 9 必填 deps）。 */
export async function buildAgentManagerDeps(): Promise<AgentManagerDeps> {
  const legacyTools: LegacyAgentTools = {
    // ---- pi 域：pi-runtime.ts 单一事实源（SDK re-export 面 = 旧 pi-runtime-management.mjs）；Type 来自 typebox（旧 agent.mjs L19 同源） ----
    defineTool,
    Type,
    DefaultResourceLoader,
    createBashToolDefinition,
    createReadToolDefinition,
    createWriteToolDefinition,
    createEditToolDefinition,
    createLocalBashOperations,
    // ---- pi 扩展域：B2-17 已迁 TS 实现直绑（过渡桥清零）/ MCP 域：B2-14 已迁 TS 实现直绑 ----
    enabledPiExtensionEntries: piExtensionDomain.enabledPiExtensionEntries,
    enabledPiExtensionPaths: piExtensionDomain.enabledPiExtensionPaths,
    cachedMcpTools: mcpManagementDomain.cachedMcpTools,
    callMcpTool: mcpManagementDomain.callMcpTool,
    // ---- 审批 / 命令策略：B6-1 已迁 TS 实现 ----
    requireToolApproval,
    normalizeBashOptions,
    // ---- 工具门禁拒绝标记域：B2-8 已迁 TS 实现直绑 ----
    isToolGateRejection: workspaceGuardDomain.isToolGateRejection,
    // ---- office / web / browser / map / memory 域（旧模块过渡桥） ----
    // ---- 文件权限/占用错误归一域：B2-6 已迁 TS 实现直绑 ----
    normalizeOfficeFailure: filePermissionErrorDomain.normalizeOfficeFailure,
    // ---- officecli 参数处理域：B2-7 已迁 TS 实现直绑 ----
    parseArgs: officeParamsDomain.parseOfficeArgs,
    collectReferencedPaths: officeParamsDomain.collectReferencedPaths,
    ensureOfficeOutputDirs: officeParamsDomain.ensureOfficeOutputDirs,
    // ---- 联网搜索/网页读取域：B2-15 已迁 TS 实现直绑 ----
    webSearch: webSearchDomain.webSearch,
    webFetch: webReaderDomain.webFetch,
    // ---- 浏览器域：B2-16 已迁 TS 实现直绑 ----
    browserOpen: browserDomain.browserOpen,
    browserSnapshot: browserDomain.browserSnapshot,
    browserClick: browserDomain.browserClick,
    browserType: browserDomain.browserType,
    browserPress: browserDomain.browserPress,
    browserScroll: browserDomain.browserScroll,
    browserScreenshot: browserDomain.browserScreenshot,
    browserBack: browserDomain.browserBack,
    browserTabs: browserDomain.browserTabs,
    browserClose: browserDomain.browserClose,
    browserSessionKey: browserDomain.browserSessionKey,
    // ---- 内核侧车域：B2-10 已迁 TS 实现直绑 ----
    getBashSidecar: kernelSidecarDomain.getBashSidecar,
    // ---- 地图分析演示数据域：B2-11 已迁 TS 实现直绑 ----
    createDemoAnalysis: mapAnalysisDomain.createDemoAnalysis,
    normalizeCompletion,
    completionStatusLabel,
    // ---- memory 准入域：B2-5 已迁 TS 实现直绑 ----
    evaluateMemoryCandidate: memoryAdmissionDomain.evaluateMemoryCandidate,
    // ---- 项目管理域：B2-9 已迁 TS 实现直绑 ----
    getProjectForWorkspace: projectManagementDomain.getProjectForWorkspace,
    // ---- runs / memory 域：B2-2/B2-3 已迁 TS 实现直绑（静态 import 同一模块实例） ----
    updateRunTodo: runsDomain.updateRunTodo,
    listStoredMemoryProposals: memoryDomain.listMemoryProposals,
    createMemoryProposal: memoryDomain.createMemoryProposal,
    // ---- 子代理编排域：编排器 B6-2 已迁 TS；编辑流水线 B2-12 已迁 TS 实现直绑 ----
    SUBAGENT_ROLES: SUBAGENT_ROLES as Record<string, any>,
    resolveRole,
    orchestrateSubagents,
    runEditorialPipeline: editorialPipelineDomain.runEditorialPipeline,
  };

  return {
    // PiRuntimeManager 实例结构化满足 AgentPiRuntimeSeam（B6-7 全量转录）
    piRuntimeManager: piRuntimeManager as AgentManagerDeps["piRuntimeManager"],
    contextTokensFromUsage,
    // runs 域 B2-2 TS 直绑（形参 unknown → string 收窄转换，strictFunctionTypes 不变式）
    getRun: runsDomain.getRun as AgentManagerDeps["getRun"],
    // memory 域 B2-3 TS 直绑 + 旧 agent.mjs L83-90 同一别名映射
    listStoredMemoryProposals: memoryDomain.listMemoryProposals,
    approveStoredMemoryProposal: memoryDomain.approveMemoryProposal,
    editStoredMemoryProposal: memoryDomain.editMemoryProposal,
    rejectStoredMemoryProposal: memoryDomain.rejectMemoryProposal,
    mergeMemoryProposals: memoryDomain.mergeMemoryProposals,
    getMemoryProposalHistory: memoryDomain.getMemoryProposalHistory,
    legacyTools,
    flags: RUNTIME_FLAGS,
    emitDeps: { recordRunEvent: runsDomain.recordRunEvent as NonNullable<AgentManagerDeps["emitDeps"]>["recordRunEvent"] },
  };
}

/** 构造独立 AgentManager 实例（装配测试用；生产走 getAgentManager 单飞）。 */
export async function createAgentManager(): Promise<AgentManager> {
  return new AgentManager(await buildAgentManagerDeps());
}

let agentManagerSingleton: Promise<AgentManager> | null = null;

/** 生产单飞（对应旧 agent.mjs L4802 `export const agentManager = new AgentManager()`）。 */
export function getAgentManager(): Promise<AgentManager> {
  if (!agentManagerSingleton) {
    agentManagerSingleton = createAgentManager();
  }
  return agentManagerSingleton;
}

/** agent 域装配开关（B2 装配层；R6-4 起恒 true——OP_DESKTOP_AGENT_DOMAIN 回滚旗标随 sidecar 退役删除，保留导出供测试对拍）。 */
export function isAgentDomainEnabled(): boolean {
  return true;
}
