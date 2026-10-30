import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { PROJECT_DIR as workspacePathsProjectDir } from "./backend/workspace-paths";
import { createAgentDirectEventsBridge } from "./ipc/agent-direct-events";
import {
  AGENT_DIRECT_INVOKE_CHANNELS,
  AGENT_STREAM_CLOSE_CHANNEL,
  invokeAgentDirect,
  invokeAgentStreamCloseDirect,
  type AgentDirectInvokerDeps
} from "./ipc/agent-direct-invokers";
import {
  AGENT_SESSIONS_DIRECT_CHANNELS,
  invokeAgentSessionsDirect,
  type AgentSessionsDirectDeps
} from "./ipc/agent-sessions-direct";
import {
  AGENT_RUNS_DIRECT_CHANNELS,
  invokeAgentRunsDirect,
  type AgentRunsDirectDeps
} from "./ipc/agent-runs-direct";
import {
  AGENT_PROMPT_DIRECT_CHANNELS,
  invokeAgentPromptDirect,
  snapshotWorkspace as mainchainSnapshotWorkspace,
  type AgentPromptDirectDeps
} from "./ipc/agent-prompt-direct";
import {
  AGENT_PLANS_DIRECT_CHANNELS,
  invokeAgentPlansDirect,
  type AgentPlansDirectDeps
} from "./ipc/agent-plans-direct";
import {
  AGENT_AUTH_PERMISSIONS_DIRECT_CHANNELS,
  invokeAgentAuthPermissionsDirect,
  type AgentAuthPermissionsDirectDeps
} from "./ipc/agent-auth-permissions-direct";
import {
  AGENT_PI_CONFIG_DIRECT_CHANNELS,
  invokeAgentPiConfigDirect,
  type AgentPiConfigDirectDeps
} from "./ipc/agent-pi-config-direct";
import {
  AGENT_PROVIDER_CATALOG_DIRECT_CHANNELS,
  invokeAgentProviderCatalogDirect,
  type AgentProviderCatalogDirectDeps
} from "./ipc/agent-provider-catalog-direct";
import {
  AGENT_NETWORK_SETTINGS_DIRECT_CHANNELS,
  invokeAgentNetworkSettingsDirect,
  type AgentNetworkSettingsDirectDeps
} from "./ipc/agent-network-settings-direct";
import {
  AGENT_MEMORY_DIRECT_CHANNELS,
  invokeAgentMemoryDirect,
  type AgentMemoryDirectDeps
} from "./ipc/agent-memory-direct";
import {
  AGENT_PROBE_DIAGNOSTICS_DIRECT_CHANNELS,
  invokeAgentProbeDiagnosticsDirect,
  type AgentProbeDiagnosticsDirectDeps
} from "./ipc/agent-probe-diagnostics-direct";
import {
  NATIVE_SYSTEM_DIRECT_CHANNELS,
  invokeNativeSystemDirect,
  type NativeSystemDirectDeps
} from "./ipc/native-system-direct";
import {
  SYSTEM_STATUS_DIRECT_CHANNELS,
  invokeSystemStatusDirect,
  type SystemStatusDirectDeps
} from "./ipc/system-status-direct";
import {
  KB_DIRECT_CHANNELS,
  invokeKbDirect,
  type KbDirectDeps
} from "./ipc/kb-direct";
import {
  SKILLS_DIRECT_CHANNELS,
  invokeSkillsDirect,
  type SkillsDirectDeps
} from "./ipc/skills-direct";
import {
  BROWSER_DIRECT_CHANNELS,
  invokeBrowserDirect,
  createBrowserWatchRegistry,
  BROWSER_STREAM_EVENT_TYPE,
  type BrowserDirectDeps
} from "./ipc/browser-direct";
import {
  WORKFLOWS_DIRECT_CHANNELS,
  invokeWorkflowsDirect,
  type WorkflowsDirectDeps
} from "./ipc/workflows-direct";
import {
  AGENTS_DIRECT_CHANNELS,
  invokeAgentsDirect,
  type AgentsDirectDeps
} from "./ipc/agents-direct";
import {
  INTEGRATIONS_DIRECT_CHANNELS,
  invokeIntegrationsDirect,
  type IntegrationsDirectDeps
} from "./ipc/integrations-direct";
import {
  TEMPLATES_DIRECT_CHANNELS,
  invokeTemplatesDirect,
  type TemplatesDirectDeps
} from "./ipc/templates-direct";
import {
  SEARCH_MAP_SETTINGS_DIRECT_CHANNELS,
  invokeSearchMapSettingsDirect,
  type SearchMapSettingsDirectDeps
} from "./ipc/search-map-settings-direct";
import {
  MAP_DIRECT_CHANNELS,
  invokeMapDirect,
  type MapDirectDeps
} from "./ipc/map-direct";
import {
  PROJECT_MANAGEMENT_DIRECT_CHANNELS,
  invokeProjectManagementDirect,
  type ProjectManagementDirectDeps
} from "./ipc/project-management-direct";
import {
  WORKSPACE_DIRECT_CHANNELS,
  invokeWorkspaceDirect,
  type WorkspaceDirectDeps
} from "./ipc/workspace-direct";
import {
  FILES_DIRECT_CHANNELS,
  invokeFilesDirect,
  type FilesDirectDeps
} from "./ipc/files-direct";
import {
  DOC_DIRECT_CHANNELS,
  invokeDocDirect,
  type DocDirectDeps
} from "./ipc/doc-direct";
import { createDocWatchRegistry } from "./ipc/doc-watch";
import { installOawDataProtocolHandler, registerOawDataSchemePrivileged } from "./oaw-data-protocol";
import * as approvalPolicy from "./backend/agent/approval-policy";
import * as eventStorage from "./backend/event-storage";
import * as memoryFiles from "./backend/agent/memory-files";
import type { InvokeEnvelope, DesktopEvent } from "../shared/protocol/channels";
import { createSplashWindow } from "./splash";
import * as exportView from "./export-view-window";

const SMOKE = process.env.OP_DESKTOP_SMOKE === "1";
const PRELOAD_PATH = path.join(__dirname, "../preload/index.js");

// R6-2 资产自持：oaw-data://maps|glyphs 特权 scheme 注册（app ready 前；handler 在
// whenReady 内安装，锚点见 installOawDataProtocolHandler 调用处）。
registerOawDataSchemePrivileged();

/** 仓库根/应用根：OP_PROJECT_ROOT 覆盖优先；回退统一锚 workspace-paths 三态
 * PROJECT_DIR（R6-8：dev=仓库根、打包=应用根，与 workspace-paths.ts 重校同源）。 */
function projectRoot(): string {
  return process.env.OP_PROJECT_ROOT || workspacePathsProjectDir;
}

let mainWindow: BrowserWindow | null = null;
let quitting = false;

/** 应用启动状态（R6-4 语义收敛：sidecar 退役后「本地服务」概念消失，
 * op:server-status 面保留并改锚应用引导态——starting → ready（app 页加载完成）/
 * failed（引导失败），供 splash 与渲染层启动 UI 消费）。 */
interface ServerStatusSnapshot {
  phase: "starting" | "ready" | "failed" | "stopped";
  message?: string;
  logTail?: string[];
}
let bootStatus: ServerStatusSnapshot = { phase: "starting" };

/** 新 UI 应用页（F2 骨架）：开发态走 dev server，打包态走产物文件。 */
function loadAppPage(win: BrowserWindow): Promise<void> {
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) return win.loadURL(`${devUrl}/app/index.html`);
  return win.loadFile(path.join(__dirname, "../renderer/app/index.html"));
}

/** 冒烟（R6-1 起默认形态即 app）：加载 app 页并断言 React 真实挂载（data-app-ready）。 */
async function smokeNewUi(): Promise<void> {
  const win = mainWindow;
  if (!win) {
    console.log("SMOKE_NEW_UI_FAIL 缺少主窗口");
    void shutdown(1);
    return;
  }
  try {
    await loadAppPage(win);
    const mounted = await win.webContents.executeJavaScript(
      "document.documentElement.getAttribute('data-app-ready') === '1' && (document.getElementById('root')?.childElementCount ?? 0) > 0"
    );
    if (mounted === true) {
      console.log("SMOKE_NEW_UI_OK");
      void shutdown(0);
    } else {
      console.log("SMOKE_NEW_UI_FAIL React 未挂载");
      void shutdown(1);
    }
  } catch (error) {
    console.log(`SMOKE_NEW_UI_FAIL ${error instanceof Error ? error.message : String(error)}`);
    void shutdown(1);
  }
}

function broadcastStatus(status: ServerStatusSnapshot): void {
  bootStatus = status;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("op:server-status", status);
  }
}

/** 事件广播：op:event 推送到所有窗口（渲染层 subscribeDesktopEvents 消费）。 */
function broadcastEvent(event: DesktopEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("op:event", event);
  }
}

/**
 * 对话流事件直推（S1）：对话流事件源 = TS AgentManager 进程内直推，
 * watch/unwatch 生命周期语义（同键幂等 / 非当前键 stop 忽略）。
 * R6-4：SSE 过渡桥（events-bridge 消费 legacy /api/agent/stream）随 sidecar 退役删除。
 */
function registerEventBridgeHandlers(): void {
  const directBridge = createAgentDirectEventsBridge({
    getManager: async () => {
      const assembly = await import("./backend/agent/assembly");
      return assembly.getAgentManager();
    },
    send: (event) => broadcastEvent(event),
    onState: (state, detail) =>
      broadcastEvent({ type: "op:stream-state", data: { state, detail: detail ?? null } })
  });
  ipcMain.handle("op:events:watch", (_event, request: Parameters<typeof directBridge.watch>[0]) =>
    directBridge.watch(request)
  );
  ipcMain.handle("op:events:unwatch", (_event, request?: { client?: string; thread?: string }) => {
    directBridge.stop(request ?? {});
    return { ok: true };
  });
}

/**
 * 记忆变更事件直推（F3 批4）：memory-files 域的 memoryEmitter（fs.watch 目录监听，
 * C-6 转录）→ op:memory-change 推送。生命周期由渲染层经 op:memory:watch /
 * op:memory:unwatch 控制。R6-4：SSE 过渡桥（消费 legacy /api/memory/stream）退役，
 * 事件源换为进程内 emitter（帧形状 { file, event, preview, time } 与旧 SSE data 一致）。
 */
function registerMemoryBridgeHandlers(): void {
  let unsubscribe: (() => void) | null = null;
  ipcMain.handle("op:memory:watch", () => {
    if (unsubscribe) return { ok: true }; // 全局单流：重复 watch 幂等
    memoryFiles.startMemoryWatcher();
    const forward = (payload: unknown): void => {
      broadcastEvent({
        type: "op:memory-change",
        at: new Date().toISOString(),
        data: (payload ?? {}) as Record<string, unknown>
      });
    };
    memoryFiles.memoryEmitter.on("change", forward);
    unsubscribe = () => memoryFiles.memoryEmitter.off("change", forward);
    return { ok: true };
  });
  ipcMain.handle("op:memory:unwatch", () => {
    unsubscribe?.();
    unsubscribe = null;
    return { ok: true };
  });
}

/**
 * 全局 Agent 事件直推（F3 批7b）：event-storage 落库事件（runs 域 recordRunEvent /
 * appendEvent 同源 emitter）→ op:agent-event 推送。生命周期由渲染层经
 * op:agent-events:watch / op:agent-events:unwatch 控制。R6-4：SSE 过渡桥（消费
 * legacy /api/agent/events）退役——直推语义与旧 SSE 路由对齐：watch 携带渲染层
 * 游标（after）先回放 listEvents 再挂实时订阅（幂等门闩按 seq 去重），仅转发
 * 命中 clientId 的事件；帧 data = 落库事件本体（seq/threadId/type 等索引字段齐全）。
 */
function registerGlobalEventsBridgeHandlers(): void {
  let lastSentSeq = 0;
  let unsubscribe: (() => void) | null = null;
  let activeClient = "";
  ipcMain.handle(
    "op:agent-events:watch",
    (_event, request: { client?: string; after?: unknown }) => {
      const client = String(request?.client ?? "");
      if (!client) return { ok: false, error: "client required" };
      if (activeClient === client && unsubscribe) return { ok: true }; // 同 client 幂等
      unsubscribe?.();
      unsubscribe = null;
      activeClient = client;
      lastSentSeq = Number(request?.after ?? 0) || 0;
      // 回放（对齐旧 SSE 建流起点：after 游标之后、命中 clientId 的事件）
      for (const ev of eventStorage.listEvents({ after: lastSentSeq, clientId: client, limit: 2000 }).events) {
        const seq = Number(ev?.seq || 0);
        if (seq > lastSentSeq) {
          broadcastEvent({ id: seq, type: "op:agent-event", data: ev as unknown as Record<string, unknown> });
          lastSentSeq = seq;
        }
      }
      unsubscribe = eventStorage.subscribeEvents((raw: unknown) => {
        const ev = raw as { seq?: unknown; clientId?: unknown } | null;
        const seq = Number(ev?.seq || 0);
        if (!ev || ev.clientId !== client || seq <= lastSentSeq) return;
        broadcastEvent({ id: seq, type: "op:agent-event", data: ev as unknown as Record<string, unknown> });
        lastSentSeq = seq;
      });
      return { ok: true };
    }
  );
  ipcMain.handle("op:agent-events:unwatch", (_event, request?: { client?: string }) => {
    const client = String(request?.client ?? activeClient);
    if (!activeClient) return { ok: true };
    if (client && client !== activeClient) return { ok: true }; // 非当前 client：忽略
    unsubscribe?.();
    unsubscribe = null;
    activeClient = "";
    return { ok: true };
  });
}

/**
 * B 层通道直调注册（S2）：agent 域 9 条薄映射通道进程内直调 TS AgentManager，
 * stream-close 一并接管（S1 直推恒开，no-op 语义 closed:0）。
 * 诊断日志与旧 sidecar 同一文件族（TEMP 优先，server/index.mjs L70 同锚点，
 * projectRoot 回退对应 PROJECT_DIR）。
 * R6-4 直调收敛：sidecar / http-forward 兜底路径退役，全部 invoke 通道恒直调
 * 主进程域服务。S4 期「未设置 = 默认启用，=0 显式关闭回滚」的 OP_DESKTOP_*_DIRECT
 * flag 族连同 AGENT_DOMAIN / AGENT_EVENT_DIRECT 门控一并退役（回滚对象已不存在，
 * docs/solutions/2026-10-24-agent域流量切换评估方案.md §4-S4 历史留档）。
 */
function registerAgentDirectInvokers(): void {
  const deps: AgentDirectInvokerDeps = {
    getManager: async () => {
      const assembly = await import("./backend/agent/assembly");
      return assembly.getAgentManager();
    },
    listPendingApprovals: approvalPolicy.listPendingApprovals,
    getApprovalMode: approvalPolicy.getApprovalMode,
    setApprovalMode: approvalPolicy.setApprovalMode,
    resolveToolApproval: approvalPolicy.resolveToolApproval,
    eventStoreInfo: eventStorage.eventStoreInfo,
    getReadCursor: eventStorage.getReadCursor,
    markReadCursor: eventStorage.markReadCursor,
    diagnosticLogPath: () => path.join(process.env.TEMP || projectRoot(), "open-plan-agent连接诊断.log")
  };
  for (const channel of AGENT_DIRECT_INVOKE_CHANNELS) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (_event, payload: InvokeEnvelope | undefined) => invokeAgentDirect(channel, payload, deps));
  }
  ipcMain.removeHandler(AGENT_STREAM_CLOSE_CHANNEL);
  ipcMain.handle(AGENT_STREAM_CLOSE_CHANNEL, () => invokeAgentStreamCloseDirect());
}

/**
 * 会话族通道直调注册（S3-1）：op:sessions:* 9 条通道进程内直调会话存储域
 * （backend/agent/session-files.ts，文件族共享态，跨实例即时一致）。
 * runs/projects/workspace 跨域联接惰性动态组装（单飞缓存）；会话存储域
 * （session-files.ts，加载期 mkdir 幂等）随模块静态链加载，与 event-storage（B1-1）同类先例。
 */
function registerAgentSessionsDirectInvokers(): void {
  let depsPromise: Promise<AgentSessionsDirectDeps> | null = null;
  const ensureDeps = (): Promise<AgentSessionsDirectDeps> => {
    depsPromise ??= (async () => {
      const [runs, projects, workspace] = await Promise.all([
        import("./backend/runs"),
        import("./backend/project-management"),
        import("./backend/workspace")
      ]);
      return {
        listRunSummaries: (opts) => runs.listRunSummaries(opts),
        getProject: (id) => projects.getProject(id),
        getProjectForWorkspace: (cwd) => projects.getProjectForWorkspace(cwd),
        getWorkspace: () => workspace.getWorkspace(),
        normalizeWorkspace: (dir) => workspace.normalizeWorkspace(String(dir ?? ""))
      };
    })();
    return depsPromise;
  };
  for (const channel of AGENT_SESSIONS_DIRECT_CHANNELS) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (_event, payload: InvokeEnvelope | undefined) =>
      invokeAgentSessionsDirect(channel, payload, await ensureDeps())
    );
  }
}

/**
 * 运行族通道直调注册（S3-2）：11 条运行族通道（op:runs:* 除 resume/retry +
 * op:artifacts:* 2 条）进程内直调 TS 域服务。runs/发布台账/after blob 为文件族
 * 共享态（OAW_RUNS_DIR 同锚点）；runs/artifact/diff/workspace 跨域惰性动态组装
 * （单飞缓存）。
 */
function registerAgentRunsDirectInvokers(): void {
  let depsPromise: Promise<AgentRunsDirectDeps> | null = null;
  const ensureDeps = (): Promise<AgentRunsDirectDeps> => {
    depsPromise ??= (async () => {
      const [runs, artifacts, diff, workspace] = await Promise.all([
        import("./backend/runs"),
        import("./backend/artifact-management"),
        import("./backend/file-diff"),
        import("./backend/workspace")
      ]);
      return {
        getManager: async () => {
          const assembly = await import("./backend/agent/assembly");
          return assembly.getAgentManager();
        },
        getRun: (id) => runs.getRun(String(id)),
        listRuns: (opts) => runs.listRuns(opts),
        runSummaryView: (run) => runs.runSummaryView(run),
        updateRunStep: (id, stepId, patch) => runs.updateRunStep(String(id), stepId, patch),
        finishRun: (id, patch) => runs.finishRun(id, patch),
        requestRunCancellation: (id, reason) => runs.requestRunCancellation(String(id), reason),
        awaitBeforeBlobs: (runId) => runs.awaitBeforeBlobs(runId),
        rollbackRun: (id, paths) => runs.rollbackRun(String(id), paths),
        listPublishedArtifacts: (opts) => artifacts.listPublishedArtifacts(opts),
        publishArtifact: (runId, artifactId, opts) => artifacts.publishArtifact(runId, artifactId, opts),
        confirmArtifactAcceptance: (runId, artifactId, opts) => artifacts.confirmArtifactAcceptance(runId, artifactId, opts),
        inspectRunAcceptance: (runId, rules) => artifacts.inspectRunAcceptance(runId, rules),
        rollbackPublishedArtifact: (publicationId, opts) => artifacts.rollbackPublishedArtifact(publicationId, opts),
        diffFileContents: (input) => diff.diffFileContents(input),
        diffLimits: diff.DIFF_LIMITS as { maxInputBytes: number; maxHunksPerPage: number },
        runsChangesDir: () => runs.runsDir(),
        normalizeWorkspace: (dir) => workspace.normalizeWorkspace(String(dir ?? "")),
        isInside: (root, target) => workspace.isInside(root, target)
      };
    })();
    return depsPromise;
  };
  for (const channel of AGENT_RUNS_DIRECT_CHANNELS) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (_event, payload: InvokeEnvelope | undefined) =>
      invokeAgentRunsDirect(channel, payload, await ensureDeps())
    );
  }
}

/**
 * 主链通道直调注册（S3-3）：prompt 主链 10 条通道（op:agent:prompt/abort/answer/
 * compact/new/resume/session-tree/session-branch + op:runs:resume/retry）进程内直调
 * TS AgentManager 单飞与各域服务。S3 三批：会话族（S3-1）→ 运行族（S3-2）→ prompt 主链（本批）。
 */
function registerAgentPromptDirectInvokers(): void {
  let depsPromise: Promise<AgentPromptDirectDeps> | null = null;
  const ensureDeps = (): Promise<AgentPromptDirectDeps> => {
    depsPromise ??= (async () => {
      const [runs, workspace, projects, sessionFiles, skillsCatalog, writeProbe, writeCoordination, artifactVerification, agentContext] = await Promise.all([
        import("./backend/runs"),
        import("./backend/workspace"),
        import("./backend/project-management"),
        import("./backend/agent/session-files"),
        import("./backend/agent/skills-catalog"),
        import("./backend/workspace-write-probe"),
        import("./backend/agent/write-coordination"),
        import("./backend/artifact-verification"),
        import("./backend/agent/context")
      ]);
      return {
        getManager: async () => {
          const assembly = await import("./backend/agent/assembly");
          return assembly.getAgentManager();
        },
        getWorkspace: () => workspace.getWorkspace(),
        normalizeWorkspace: (dir) => workspace.normalizeWorkspace(String(dir ?? "")),
        safeName: (name) => workspace.safeName(String(name ?? "")),
        getProjectForWorkspace: (root) => projects.getProjectForWorkspace(root),
        getProject: (id) => projects.getProject(id),
        defaultProjectSettings: () => projects.defaultProjectSettings(),
        findSessionFile: (id) => sessionFiles.findSessionFile(id),
        readSessionHeader: (found) => sessionFiles.readSessionHeader(found),
        updateSessionHeader: (id, patch) => sessionFiles.updateSessionHeader(id, patch),
        annotateSessionThread: (sessionId, threadId) => sessionFiles.annotateSessionThread(sessionId, threadId),
        scanSkills: () => skillsCatalog.scanSkills(),
        preflightSkills: (opts) => skillsCatalog.preflightSkills(opts),
        resolveReferences: (refs, text, ws) => agentContext.resolveReferences(refs, text, ws),
        requireWorkspaceWriteForTask: (plan, ws) => writeProbe.requireWorkspaceWriteForTask(plan, ws),
        beginRun: (input) => runs.beginRun(input),
        getRun: (id) => runs.getRun(String(id)),
        listRuns: (opts) => runs.listRuns(opts),
        finishRun: (id, patch) => runs.finishRun(id, patch),
        requestRunCancellation: (id, reason) => runs.requestRunCancellation(String(id), reason),
        recordRunEvent: (id, type, data) => runs.recordRunEvent(String(id), type, data as never),
        snapshotWorkspace: (root) => mainchainSnapshotWorkspace(workspace.normalizeWorkspace(String(root ?? "")) || workspace.getWorkspace()),
        filterRunChanges: (run, changes) => runs.filterRunChanges(run, changes),
        validateArtifacts: (paths, root) => artifactVerification.validateArtifacts(paths, root),
        validateArtifactFile: (file, root, relativePath) => artifactVerification.validateArtifactFile(file, root, relativePath),
        listStagedFilesForValidation: (runId) => writeCoordination.listStagedFilesForValidation(runId),
        stageWrite: (opts) => writeCoordination.stageWrite(opts as never),
        stagedRunsRoot: () => runs.runsDir(),
        appendEvent: (evt) => eventStorage.appendEvent(evt as never),
        diagnosticLogPath: () => path.join(process.env.TEMP || projectRoot(), "open-plan-agent连接诊断.log")
      };
    })();
    return depsPromise as Promise<AgentPromptDirectDeps>;
  };
  for (const channel of AGENT_PROMPT_DIRECT_CHANNELS) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (_event, payload: InvokeEnvelope | undefined) =>
      invokeAgentPromptDirect(channel, payload, await ensureDeps())
    );
  }
}

/**
 * 套餐族通道直调注册（C-1）：套餐族 4 条通道（op:agent:plans*）进程内直调
 * 套餐目录域（backend/plan-catalog.ts）；apply/disconnect 成功路径附带模型运行时
 * 缓存重置与配置状态快照（文件族共享态），无 live 会话态依赖（C 层配置族口径）。
 * plan-catalog/pi-runtime/pi-config-management 跨域惰性动态组装（单飞缓存）。
 */
function registerAgentPlansDirectInvokers(): void {
  let depsPromise: Promise<AgentPlansDirectDeps> | null = null;
  const ensureDeps = (): Promise<AgentPlansDirectDeps> => {
    depsPromise ??= (async () => {
      const [planCatalog, piRuntime, piConfig] = await Promise.all([
        import("./backend/plan-catalog"),
        import("./backend/agent/pi-runtime"),
        import("./backend/agent/pi-config-management")
      ]);
      return {
        listPlans: () => planCatalog.listPlans(),
        fetchPlanModels: (planId) => planCatalog.fetchPlanModels(planId),
        applyPlan: (body) => planCatalog.applyPlan(body),
        disconnectPlan: (body) => planCatalog.disconnectPlan(body),
        resetModelRuntime: () => piRuntime.piRuntimeManager.resetModelRuntime(),
        getConfigStatus: () => piConfig.getConfigStatus()
      };
    })();
    return depsPromise;
  };
  for (const channel of AGENT_PLANS_DIRECT_CHANNELS) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (_event, payload: InvokeEnvelope | undefined) =>
      invokeAgentPlansDirect(channel, payload, await ensureDeps())
    );
  }
}

/**
 * 凭据与权限族通道直调注册（C-2）：凭据 3 条（op:agent:auth:get/save/remove）+
 * 权限规则 2 条（op:agent:permissions:get/rule:remove）通道进程内直调；
 * provider-auth 的 runtime seam 绑定 piRuntimeManager 对应方法（modelRuntime/
 * resetModelRuntime），凭据错误表与权限规则为模块级/文件族共享态，无 live 会话态
 * 依赖（C 层配置族口径）。provider-auth/agent-errors/approval-policy/pi-runtime
 * 跨域惰性动态组装（单飞缓存）。
 */
function registerAgentAuthPermissionsDirectInvokers(): void {
  let depsPromise: Promise<AgentAuthPermissionsDirectDeps> | null = null;
  const ensureDeps = (): Promise<AgentAuthPermissionsDirectDeps> => {
    depsPromise ??= (async () => {
      const [providerAuth, agentErrors, approvalPolicy, piRuntime] = await Promise.all([
        import("./backend/agent/provider-auth"),
        import("./backend/agent/agent-errors"),
        import("./backend/agent/approval-policy"),
        import("./backend/agent/pi-runtime")
      ]);
      return {
        listAuth: () => providerAuth.listAuth(),
        setApiKey: (provider, key) =>
          providerAuth.setApiKey(provider, key, { modelRuntime: () => piRuntime.piRuntimeManager.modelRuntime() }),
        removeApiKey: (provider) =>
          providerAuth.removeApiKey(provider, { resetModelRuntime: () => piRuntime.piRuntimeManager.resetModelRuntime() }),
        getCredentialErrors: () => agentErrors.getCredentialErrors(),
        listPermissionRules: () => approvalPolicy.listPermissionRules(),
        removeUserRule: (rule) => approvalPolicy.removeUserRule(rule as never)
      };
    })();
    return depsPromise;
  };
  for (const channel of AGENT_AUTH_PERMISSIONS_DIRECT_CHANNELS) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (_event, payload: InvokeEnvelope | undefined) =>
      invokeAgentAuthPermissionsDirect(channel, payload, await ensureDeps())
    );
  }
}

/**
 * Pi 配置族通道直调注册（C-3）：8 条通道（op:models:list / op:agent:model-configs:
 * list/save/delete / op:agent:default-model:set / op:agent:config-status /
 * op:agent:import-preview / op:agent:import-config）进程内直调；数据源
 * pi-config-management（B6 对拍覆盖）+ provider-auth runtime seam 绑定
 * piRuntimeManager（C-2 同口径）+ session-files（会话目录与缓存失效），无 live
 * 会话态依赖（C 层配置族口径）。pi-config-management/provider-auth/agent-errors/
 * session-files/pi-runtime/assembly 六域惰性动态组装（单飞缓存）。
 */
function registerAgentPiConfigDirectInvokers(): void {
  let depsPromise: Promise<AgentPiConfigDirectDeps> | null = null;
  const ensureDeps = (): Promise<AgentPiConfigDirectDeps> => {
    depsPromise ??= (async () => {
      const [piConfig, providerAuth, agentErrors, sessionFiles, piRuntime, assembly] = await Promise.all([
        import("./backend/agent/pi-config-management"),
        import("./backend/agent/provider-auth"),
        import("./backend/agent/agent-errors"),
        import("./backend/agent/session-files"),
        import("./backend/agent/pi-runtime"),
        import("./backend/agent/assembly")
      ]);
      return {
        listModelCatalog: async () => (await assembly.getAgentManager()).listModelCatalog(),
        readModelsStore: () => piConfig.readModelsStore(),
        readRuntimeSettings: () => piConfig.readRuntimeSettings(),
        readModelsConfig: () => piConfig.readModelsConfig(),
        writeModelsConfig: (value) => piConfig.writeModelsConfig(value),
        listAuth: () => providerAuth.listAuth(),
        getCredentialErrors: () => agentErrors.getCredentialErrors(),
        setApiKey: (provider, key) =>
          providerAuth.setApiKey(provider, key, { modelRuntime: () => piRuntime.piRuntimeManager.modelRuntime() }),
        removeApiKey: (provider) =>
          providerAuth.removeApiKey(provider, { resetModelRuntime: () => piRuntime.piRuntimeManager.resetModelRuntime() }),
        resetModelRuntime: () => piRuntime.piRuntimeManager.resetModelRuntime(),
        writeDefaultModel: (input) => piConfig.writeDefaultModel(input as never),
        getConfigStatus: () => piConfig.getConfigStatus(),
        previewLocalPiConfig: () => piConfig.previewLocalPiConfig(),
        importLocalPiConfig: (options) => piConfig.importLocalPiConfig(options as never),
        importLocalPiSessions: (options) => piConfig.importLocalPiSessions(options as never),
        sessionsDir: () => sessionFiles.SESSIONS_DIR,
        clearSessionCaches: () => sessionFiles.clearSessionCaches()
      };
    })();
    return depsPromise;
  };
  for (const channel of AGENT_PI_CONFIG_DIRECT_CHANNELS) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (_event, payload: InvokeEnvelope | undefined) =>
      invokeAgentPiConfigDirect(channel, payload, await ensureDeps())
    );
  }
}

/**
 * 供应商目录族通道直调注册（C-4）：6 条通道（op:agent:provider-catalog* 4 条 +
 * op:agent:custom-provider + op:agent:model-configs:fetch-models）进程内直调；
 * 数据源 provider-catalog（B2 对拍覆盖）+ models-dev-catalog + pi-network-proxy
 * 网络适配器 + pi-config-management 读写族，无 live 会话态依赖（C 层配置族口径）。
 * provider-catalog/models-dev-catalog/pi-network-proxy/pi-config-management/
 * pi-runtime 五域惰性动态组装（单飞缓存）。
 */
function registerAgentProviderCatalogDirectInvokers(): void {
  let depsPromise: Promise<AgentProviderCatalogDirectDeps> | null = null;
  const ensureDeps = (): Promise<AgentProviderCatalogDirectDeps> => {
    depsPromise ??= (async () => {
      const [providerCatalog, modelsDevCatalog, piNetworkProxy, piConfig, piRuntime, providerAuth, agentErrors] = await Promise.all([
        import("./backend/provider-catalog"),
        import("./backend/models-dev-catalog"),
        import("./backend/agent/pi-network-proxy"),
        import("./backend/agent/pi-config-management"),
        import("./backend/agent/pi-runtime"),
        import("./backend/agent/provider-auth"),
        import("./backend/agent/agent-errors")
      ]);
      return {
        builtinProviderList: () => providerCatalog.builtinProviderList(),
        builtinProviderDetail: (id) => providerCatalog.builtinProviderDetail(id),
        buildBuiltinImport: (provider, options) => providerCatalog.buildBuiltinImport(provider, options as never),
        findBuiltinModel: (id) => providerCatalog.findBuiltinModel(id),
        fetchModelsDevCatalog: () => modelsDevCatalog.fetchModelsDevCatalog(),
        readModelsDevCache: () => modelsDevCatalog.readModelsDevCache(),
        writeModelsDevCache: (data) => modelsDevCatalog.writeModelsDevCache(data),
        invalidateMergedCatalog: () => providerCatalog.invalidateMergedCatalog(),
        createPiNetworkAdapter: () => piNetworkProxy.createPiNetworkAdapter(),
        readModelsConfig: () => piConfig.readModelsConfig(),
        writeModelsConfig: (value) => piConfig.writeModelsConfig(value),
        readRuntimeSettings: () => piConfig.readRuntimeSettings(),
        writeDefaultModel: (input) => piConfig.writeDefaultModel(input as never),
        listAuth: () => providerAuth.listAuth(),
        getCredentialErrors: () => agentErrors.getCredentialErrors(),
        setApiKey: (provider, key) =>
          providerAuth.setApiKey(provider, key, { modelRuntime: () => piRuntime.piRuntimeManager.modelRuntime() }),
        resetModelRuntime: () => piRuntime.piRuntimeManager.resetModelRuntime()
      };
    })();
    return depsPromise;
  };
  for (const channel of AGENT_PROVIDER_CATALOG_DIRECT_CHANNELS) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (_event, payload: InvokeEnvelope | undefined) =>
      invokeAgentProviderCatalogDirect(channel, payload, await ensureDeps())
    );
  }
}

/**
 * 网络设置族通道直调注册（C-5）：2 条通道（op:agent:network-settings:get/save）
 * 进程内直调；数据源 pi-config-management 读写族 + pi-runtime 运行时应用，无
 * live 会话态依赖（C 层配置族口径）。pi-config-management/pi-runtime 两域惰性
 * 动态组装（单飞缓存）。
 */
function registerAgentNetworkSettingsDirectInvokers(): void {
  let depsPromise: Promise<AgentNetworkSettingsDirectDeps> | null = null;
  const ensureDeps = (): Promise<AgentNetworkSettingsDirectDeps> => {
    depsPromise ??= (async () => {
      const [piConfig, piRuntime] = await Promise.all([
        import("./backend/agent/pi-config-management"),
        import("./backend/agent/pi-runtime")
      ]);
      return {
        readNetworkSettings: () => piConfig.readNetworkSettings(),
        saveNetworkSettings: (value, options) => piConfig.saveNetworkSettings(value, options as never),
        loadNetworkSettings: () => piConfig.loadNetworkSettings() as Record<string, any>,
        updateNetworkSettings: (settings) => piRuntime.piRuntimeManager.updateNetworkSettings(settings)
      };
    })();
    return depsPromise;
  };
  for (const channel of AGENT_NETWORK_SETTINGS_DIRECT_CHANNELS) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (_event, payload: InvokeEnvelope | undefined) =>
      invokeAgentNetworkSettingsDirect(channel, payload, await ensureDeps())
    );
  }
}

/**
 * 记忆族通道直调注册（C-6）：10 条通道（op:memory:list/init/file:get/file:save +
 * op:memory:proposals:list/approve/edit/reject/history/merge）进程内直调；数据源
 * memory-files 文件域（C-6 转录）+ workspace/agent-key/event-storage/
 * persistence-utils + agentManager 提案六方法，无 live 会话态依赖（C 层配置族口径）。
 * memory-files/workspace/event-storage/persistence-utils/agent-key/assembly 六域
 * 惰性动态组装（单飞缓存）。
 */
function registerAgentMemoryDirectInvokers(): void {
  let depsPromise: Promise<AgentMemoryDirectDeps> | null = null;
  const ensureDeps = (): Promise<AgentMemoryDirectDeps> => {
    depsPromise ??= (async () => {
      const [memoryFiles, workspace, eventStorage, persistence, agentKeyMod, assembly] = await Promise.all([
        import("./backend/agent/memory-files"),
        import("./backend/workspace"),
        import("./backend/event-storage"),
        import("./backend/persistence-utils"),
        import("./backend/agent/agent-key"),
        import("./backend/agent/assembly")
      ]);
      const agentManager = await assembly.getAgentManager();
      return {
        listMemoryFiles: () => memoryFiles.listMemoryFiles(),
        getMemoryDir: () => memoryFiles.getMemoryDir(),
        startMemoryWatcher: () => memoryFiles.startMemoryWatcher(),
        resolveMemoryPath: (rel) => memoryFiles.resolveMemoryPath(rel),
        getWorkspace: () => workspace.getWorkspace(),
        normalizeWorkspace: (dir) => workspace.normalizeWorkspace(dir),
        agentKey: (client, thread) => agentKeyMod.agentKey(client, thread),
        ensureDirectory: (dir) => persistence.ensureDirectory(dir),
        atomicWriteFile: (file, data) => persistence.atomicWriteFile(file, data, "utf8"),
        fileExists: (p) => fs.existsSync(p),
        readFileUtf8: (p) => fs.readFileSync(p, "utf8"),
        appendEvent: (event) => eventStorage.appendEvent(event as never),
        memoryProposals: (threadId, filters) => agentManager.memoryProposals(threadId, filters),
        approveMemoryProposal: (id, options) => agentManager.approveMemoryProposal(id, options),
        editMemoryProposal: (id, options) => agentManager.editMemoryProposal(id, options),
        rejectMemoryProposal: (id, reason) => agentManager.rejectMemoryProposal(id, reason),
        memoryProposalHistory: (id) => agentManager.memoryProposalHistory(id),
        mergeMemoryProposals: (targetId, sourceIds) => agentManager.mergeMemoryProposals(targetId, sourceIds)
      };
    })();
    return depsPromise;
  };
  for (const channel of AGENT_MEMORY_DIRECT_CHANNELS) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (_event, payload: InvokeEnvelope | undefined) =>
      invokeAgentMemoryDirect(channel, payload, await ensureDeps())
    );
  }
}

/**
 * 探测与诊断族通道直调注册（C-7）：2 条通道（op:agent:model:probe /
 * op:agent:diagnostics）进程内直调；数据源 agentManager 探测与健康面 +
 * pi-runtime 网络诊断 + provider-auth/agent-errors 凭据面 + pi-config-management
 * 默认模型设置，无 live 会话态依赖（C 层口径）。provider-auth/agent-errors/
 * pi-config-management/pi-runtime/agent-key/assembly 六域惰性动态组装（单飞缓存）。
 */
function registerAgentProbeDiagnosticsDirectInvokers(): void {
  let depsPromise: Promise<AgentProbeDiagnosticsDirectDeps> | null = null;
  const ensureDeps = (): Promise<AgentProbeDiagnosticsDirectDeps> => {
    depsPromise ??= (async () => {
      const [providerAuth, agentErrors, piConfig, piRuntime, agentKeyMod, assembly] = await Promise.all([
        import("./backend/agent/provider-auth"),
        import("./backend/agent/agent-errors"),
        import("./backend/agent/pi-config-management"),
        import("./backend/agent/pi-runtime"),
        import("./backend/agent/agent-key"),
        import("./backend/agent/assembly")
      ]);
      const agentManager = await assembly.getAgentManager();
      return {
        probeModel: (model, options) => agentManager.probeModel(model, options),
        runtimeHealth: (key) => agentManager.runtimeHealth(key),
        listRuntimes: () => agentManager.listRuntimes() as Record<string, any>,
        listSessionStates: () => agentManager.listSessionStates(),
        listModelCatalog: () => agentManager.listModelCatalog() as Promise<Record<string, any>>,
        networkDiagnostics: () => piRuntime.piRuntimeManager.networkDiagnostics(),
        listAuth: () => providerAuth.listAuth(),
        getCredentialErrors: () => agentErrors.getCredentialErrors(),
        readRuntimeSettings: () => piConfig.readRuntimeSettings(),
        agentKey: (client, thread) => agentKeyMod.agentKey(client, thread),
        serviceVersion: () => app.getVersion()
      };
    })();
    return depsPromise;
  };
  for (const channel of AGENT_PROBE_DIAGNOSTICS_DIRECT_CHANNELS) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (_event, payload: InvokeEnvelope | undefined) =>
      invokeAgentProbeDiagnosticsDirect(channel, payload, await ensureDeps())
    );
  }
}

/**
 * 文件根目录与系统原生面通道直调注册（D-1a）：6 条通道（op:file-roots:list/add/
 * remove + op:system:reveal/open/pick-files）进程内直调；数据源 workspace/
 * native-files/project-management 三域，无 live 会话态依赖（非 agent 域薄映射口径）。
 * workspace/native-files/project-management 三域惰性动态组装（单飞缓存）；
 * fs 面注入 realpathSync/statSync（白名单归一与目录判定）。
 */
function registerNativeSystemDirectInvokers(): void {
  let depsPromise: Promise<NativeSystemDirectDeps> | null = null;
  const ensureDeps = (): Promise<NativeSystemDirectDeps> => {
    depsPromise ??= (async () => {
      const [workspace, nativeFiles, projectManagement] = await Promise.all([
        import("./backend/workspace"),
        import("./backend/native-files"),
        import("./backend/project-management")
      ]);
      return {
        listFileRoots: () => workspace.listFileRoots(),
        addFileRoot: (dir, label) => workspace.addFileRoot(dir as string, label as string | undefined),
        removeFileRoot: (id) => workspace.removeFileRoot(id as string),
        getWorkspace: () => workspace.getWorkspace(),
        resolvePath: (rel) => workspace.resolvePath(rel),
        isInside: (root, target) => workspace.isInside(root, target),
        listProjects: (filters) => projectManagement.listProjects(filters as never) as Array<{ rootPath?: string }>,
        revealInFileManager: (absPath) => nativeFiles.revealInFileManager(absPath),
        openWithDefaultApp: (absPath) => nativeFiles.openWithDefaultApp(absPath),
        pickFiles: (options) => nativeFiles.pickFiles(options),
        nativeCapabilities: () => nativeFiles.nativeCapabilities(),
        cancelActivePicker: () => nativeFiles.cancelActivePicker(),
        realpathSync: (p) => fs.realpathSync(p),
        statSync: (p) => fs.statSync(p)
      };
    })();
    return depsPromise;
  };
  for (const channel of NATIVE_SYSTEM_DIRECT_CHANNELS) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (_event, payload: InvokeEnvelope | undefined) =>
      invokeNativeSystemDirect(channel, payload, await ensureDeps())
    );
  }
}

/**
 * 状态与知识库摄取、模型刷新通道直调注册（D-1b）：3 条通道（op:status:get /
 * op:kb:ingest / op:models:refresh）进程内直调；status 为进程身份聚合投影
 * （HTTP 认证面差异见模块头注释），models:refresh 数据源为装配单飞 agentManager
 * （C-3 同款接入）。
 */
function registerSystemStatusDirectInvokers(): void {
  let depsPromise: Promise<SystemStatusDirectDeps> | null = null;
  const ensureDeps = (): Promise<SystemStatusDirectDeps> => {
    depsPromise ??= (async () => {
      const [workspace, nativeFiles, featureFlags, kb, assembly] = await Promise.all([
        import("./backend/workspace"),
        import("./backend/native-files"),
        import("./backend/feature-flags"),
        import("./backend/kb"),
        import("./backend/agent/assembly")
      ]);
      return {
        officecliPath: workspace.OFFICECLI,
        serviceVersion: () => app.getVersion(),
        nativeCapabilities: () => nativeFiles.nativeCapabilities() as Record<string, unknown>,
        activePickerInfo: () => nativeFiles.activePickerInfo() as Record<string, unknown>,
        runtimeFlagsSnapshot: () => featureFlags.runtimeFlagsSnapshot() as Record<string, unknown>,
        ingestDocx: (name) => kb.ingestDocx(name),
        refreshModels: async () => (await assembly.getAgentManager()).refreshModels(),
        listModelCatalog: async () => (await assembly.getAgentManager()).listModelCatalog(),
        // serviceIdentity 逐行转录（server/index.mjs L76-78）：os.userInfo 优先、USERNAME 回退。
        identity: () => {
          try {
            return os.userInfo().username || String(process.env.USERNAME || "").trim() || "unknown";
          } catch {
            return String(process.env.USERNAME || "").trim() || "unknown";
          }
        },
        startedAt: new Date().toISOString()
      };
    })();
    return depsPromise;
  };
  for (const channel of SYSTEM_STATUS_DIRECT_CHANNELS) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (_event, payload: InvokeEnvelope | undefined) =>
      invokeSystemStatusDirect(channel, payload, await ensureDeps())
    );
  }
}

/**
 * 知识库域通道直调注册（F5-4）：12 条通道（op:kb:status/roots+remove/tree/search/
 * graph/doc/ima 4 件套/export-docx）进程内直调；数据源 backend/kb 单域。
 */
function registerKbDirectInvokers(): void {
  let depsPromise: Promise<KbDirectDeps> | null = null;
  const ensureDeps = (): Promise<KbDirectDeps> => {
    depsPromise ??= (async () => {
      const kb = await import("./backend/kb");
      return {
        scan: (force) => kb.scan(force),
        status: () => kb.status() as Record<string, unknown>,
        addRoot: (dir) => kb.addRoot(dir),
        removeRoot: (dir) => kb.removeRoot(dir),
        getTreeLevel: (rootIdx, dirPath) => kb.getTreeLevel(rootIdx, dirPath),
        search: (q, rootIdx, limit) => kb.search(q, rootIdx, limit),
        getGraph: (options) => kb.getGraph(options) as Record<string, unknown>,
        getDoc: (relPath, rootIdx) => kb.getDoc(relPath, rootIdx) as Record<string, unknown> | null,
        imaStatus: () => kb.imaStatus() as Promise<Record<string, unknown>>,
        imaListBases: () => kb.imaListBases(),
        imaSearch: (query, kbId) => kb.imaSearch(query, kbId),
        imaDoc: (mediaId) => kb.imaDoc(mediaId),
        exportDocx: (relPath, rootIdx) => kb.exportDocx(relPath, rootIdx)
      } satisfies KbDirectDeps;
    })();
    return depsPromise!;
  };
  for (const channel of KB_DIRECT_CHANNELS) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (_event, payload: InvokeEnvelope | undefined) =>
      invokeKbDirect(channel, payload, await ensureDeps())
    );
  }
}

/**
 * 业务面板域通道直调注册（F6-1）：五域 27 条通道（skills 3 / workflows 3 /
 * agents 4 / integrations 12 / templates 5）进程内直调；数据源 skills-catalog /
 * workflows / workflow-registry / workflow-validation / agent-management /
 * mcp-management / pi-extension-management / pi-package-catalog / tpl / notice 十域。
 */

/** 技能域通道直调注册（F6-1）：op:skills 3 条通道进程内直调。 */
function registerSkillsDirectInvokers(): void {
  let depsPromise: Promise<SkillsDirectDeps> | null = null;
  const ensureDeps = (): Promise<SkillsDirectDeps> => {
    depsPromise ??= (async () => {
      const [skillsCatalog, workspace] = await Promise.all([
        import("./backend/agent/skills-catalog"),
        import("./backend/workspace")
      ]);
      return {
        scanSkills: () => skillsCatalog.scanSkills().map((s) => ({ ...s })),
        agentDir: workspace.AGENT_DIR,
        fs: {
          readFileSync: (p, encoding) => fs.readFileSync(p, encoding),
          readdirSync: (p, options) => fs.readdirSync(p, options),
          mkdirSync: (p, options) => fs.mkdirSync(p, options),
          writeFileSync: (p, data) => fs.writeFileSync(p, data)
        }
      } satisfies SkillsDirectDeps;
    })();
    return depsPromise!;
  };
  for (const channel of SKILLS_DIRECT_CHANNELS) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (_event, payload: InvokeEnvelope | undefined) =>
      invokeSkillsDirect(channel, payload, await ensureDeps())
    );
  }
}

/**
 * 内置浏览器域通道直调注册（F6-2）：8 条 invoke 通道 + op:browser:watch/unwatch 帧流推桥。
 * watch/unwatch 不入 DESKTOP_CHANNELS（对齐 op:events:watch 先例），生命周期由渲染层控制，
 * 事件经 broadcastEvent 以 BROWSER_STREAM_EVENT_TYPE（op:browser-stream）推所有窗口。
 */
function registerBrowserDirectInvokers(): void {
  let depsPromise: Promise<BrowserDirectDeps> | null = null;
  const ensureDeps = (): Promise<BrowserDirectDeps> => {
    depsPromise ??= (async () => {
      const browser = await import("./backend/builtin-browser");
      return {
        browserSessionKey: (clientId: string, threadId: string) => browser.browserSessionKey(clientId, threadId),
        getBrowserSession: (key: string) => browser.getBrowserSession(key),
        browserOpen: (key: string, url: string) => browser.browserOpen(key, url),
        browserUserInput: (key: string, payload: Record<string, unknown>) => browser.browserUserInput(key, payload),
        browserClose: (key: string, options: { force?: boolean; reason?: string }) => browser.browserClose(key, options),
        resetBrowserSession: (key: string) => browser.resetBrowserSession(key),
        browserSetStreamPaused: (key: string, paused: boolean) => browser.browserSetStreamPaused(key, paused),
        browserFullpageScreenshot: (key: string) => browser.browserFullpageScreenshot(key),
        browserPrintToPdf: (key: string) => browser.browserPrintToPdf(key),
        subscribeBrowser: (key: string, handler: (type: string, data: unknown) => void) => browser.subscribeBrowser(key, handler as (type: string, data: any) => void),
        browserSubscriberCount: (key: string) => browser.browserSubscriberCount(key)
      } satisfies BrowserDirectDeps;
    })();
    return depsPromise!;
  };
  ipcMain.removeHandler("op:browser:watch");
  ipcMain.handle("op:browser:watch", async (_event, request: { client?: string; thread?: string; frames?: boolean | string }) => {
    const registry = await watchRegistry();
    return registry.watch(request ?? {});
  });
  ipcMain.removeHandler("op:browser:unwatch");
  ipcMain.handle("op:browser:unwatch", async (_event, request: { client?: string; thread?: string }) => {
    const registry = await watchRegistry();
    return registry.unwatch(request ?? {});
  });
  let registryPromise: Promise<ReturnType<typeof createBrowserWatchRegistry>> | null = null;
  const watchRegistry = (): Promise<ReturnType<typeof createBrowserWatchRegistry>> => {
    registryPromise ??= (async () => {
      const deps = await ensureDeps();
      return createBrowserWatchRegistry(deps, (event) =>
        broadcastEvent({ type: BROWSER_STREAM_EVENT_TYPE, data: event.data } as DesktopEvent)
      );
    })();
    return registryPromise!;
  };
  for (const channel of BROWSER_DIRECT_CHANNELS) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (_event, payload: InvokeEnvelope | undefined) =>
      invokeBrowserDirect(channel, payload, await ensureDeps())
    );
  }
}

/** 工作流域通道直调注册（F6-1）：workflows 域 3 条通道进程内直调。 */
function registerWorkflowsDirectInvokers(): void {
  let depsPromise: Promise<WorkflowsDirectDeps> | null = null;
  const ensureDeps = (): Promise<WorkflowsDirectDeps> => {
    depsPromise ??= (async () => {
      const [workflows, skillsCatalog, workflowRegistry, workflowValidation, featureFlags] = await Promise.all([
        import("./backend/agent/workflows"),
        import("./backend/agent/skills-catalog"),
        import("./backend/workflow-registry"),
        import("./backend/workflow-validation"),
        import("./backend/feature-flags")
      ]);
      return {
        listWorkflows: (skills) => workflows.listWorkflows(skills).map((w) => ({ ...w })),
        getWorkflow: (id, skills) => {
          const w = workflows.getWorkflow(id, skills);
          return w ? { ...w } : null;
        },
        scanSkills: () => skillsCatalog.scanSkills().map((s) => ({ ...s })),
        domainWorkflowsEnabled: () => featureFlags.RUNTIME_FLAGS.domainWorkflows === true,
        listDomainWorkflows: () => workflowRegistry.列出工作流(),
        getDomainWorkflow: (id) => workflowRegistry.取工作流(id),
        runPreflight: (workflow, context, options) => workflowValidation.运行预检(workflow, context, options)
      } satisfies WorkflowsDirectDeps;
    })();
    return depsPromise!;
  };
  for (const channel of WORKFLOWS_DIRECT_CHANNELS) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (_event, payload: InvokeEnvelope | undefined) =>
      invokeWorkflowsDirect(channel, payload, await ensureDeps())
    );
  }
}

/** 智能体广场通道直调注册（F6-1）：op:agents 4 条通道进程内直调。 */
function registerAgentsDirectInvokers(): void {
  let depsPromise: Promise<AgentsDirectDeps> | null = null;
  const ensureDeps = (): Promise<AgentsDirectDeps> => {
    depsPromise ??= (async () => {
      const agentManagement = await import("./backend/agent-management");
      return {
        listAgents: () => agentManagement.listAgents(),
        createAgent: (input) => agentManagement.createAgent(input),
        updateAgent: (id, patch) => agentManagement.updateAgent(id, patch),
        deleteAgent: (id) => agentManagement.deleteAgent(id)
      } satisfies AgentsDirectDeps;
    })();
    return depsPromise!;
  };
  for (const channel of AGENTS_DIRECT_CHANNELS) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (_event, payload: InvokeEnvelope | undefined) =>
      invokeAgentsDirect(channel, payload, await ensureDeps())
    );
  }
}

/** 集成接入通道直调注册（F6-1）：op:integrations 12 条通道进程内直调。 */
function registerIntegrationsDirectInvokers(): void {
  let depsPromise: Promise<IntegrationsDirectDeps> | null = null;
  const ensureDeps = (): Promise<IntegrationsDirectDeps> => {
    depsPromise ??= (async () => {
      const [mcp, piExtensions, piCatalog] = await Promise.all([
        import("./backend/mcp-management"),
        import("./backend/agent/pi-extension-management"),
        import("./backend/pi-package-catalog")
      ]);
      return {
        listMcpServers: () => mcp.listMcpServers(),
        saveMcpServer: (input) => mcp.saveMcpServer(input),
        updateMcpServer: (id, patch) => mcp.updateMcpServer(id, patch),
        deleteMcpServer: (id) => mcp.deleteMcpServer(id),
        testMcpServer: (id) => mcp.testMcpServer(id),
        listPiExtensions: () => piExtensions.listPiExtensions().map((e) => ({ ...e })),
        addPiExtension: (input) => ({ ...piExtensions.addPiExtension(input) }),
        updatePiExtension: (id, patch) => {
          const e = piExtensions.updatePiExtension(id, patch);
          return e ? { ...e } : null;
        },
        checkPiExtension: (id) => {
          const e = piExtensions.checkPiExtension(id);
          return e ? { ...e } : null;
        },
        deletePiExtension: (id) => piExtensions.deletePiExtension(id),
        searchPiPackageCatalog: (query, page) => piCatalog.searchPiPackageCatalog(query, page),
        resolveInstalledPiPackage: (name) => piCatalog.resolveInstalledPiPackage(name)
      } satisfies IntegrationsDirectDeps;
    })();
    return depsPromise!;
  };
  for (const channel of INTEGRATIONS_DIRECT_CHANNELS) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (_event, payload: InvokeEnvelope | undefined) =>
      invokeIntegrationsDirect(channel, payload, await ensureDeps())
    );
  }
}

/** 模版库通道直调注册（F6-1）：op:templates 5 条通道进程内直调。 */
function registerTemplatesDirectInvokers(): void {
  let depsPromise: Promise<TemplatesDirectDeps> | null = null;
  const ensureDeps = (): Promise<TemplatesDirectDeps> => {
    depsPromise ??= (async () => {
      const [tpl, notice, workspacePaths] = await Promise.all([
        import("./backend/tpl"),
        import("./backend/notice"),
        import("./backend/workspace-paths")
      ]);
      const projectDir = workspacePaths.PROJECT_DIR;
      return {
        getCategories: () => tpl.getCategories(),
        getTemplatesByCategory: (categoryId) => tpl.getTemplatesByCategory(categoryId ?? ""),
        getTemplateContent: (relPath) => tpl.getTemplateContent(relPath),
        generateNotice: (input) => notice.generateNotice(input),
        projectDir,
        tplRoot: path.resolve(projectDir, ".."),
        fs: {
          existsSync: (p) => fs.existsSync(p),
          statSync: (p) => fs.statSync(p),
          readFileSync: (p, encoding) => fs.readFileSync(p, encoding)
        }
      } satisfies TemplatesDirectDeps;
    })();
    return depsPromise!;
  };
  for (const channel of TEMPLATES_DIRECT_CHANNELS) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (_event, payload: InvokeEnvelope | undefined) =>
      invokeTemplatesDirect(channel, payload, await ensureDeps())
    );
  }
}

/**
 * 联网搜索配置与地图底图设置通道直调注册（D-1c）：5 条通道（op:search:settings:
 * get/save、op:search:test、op:map:settings:get/save）进程内直调；数据源
 * web-search/map 两域。
 */
function registerSearchMapSettingsDirectInvokers(): void {
  let depsPromise: Promise<SearchMapSettingsDirectDeps> | null = null;
  const ensureDeps = (): Promise<SearchMapSettingsDirectDeps> => {
    depsPromise ??= (async () => {
      const [webSearch, map] = await Promise.all([
        import("./backend/web-search"),
        import("./backend/map")
      ]);
      return {
        searchBackends: webSearch.SEARCH_BACKENDS,
        publicSearchSettings: () => webSearch.publicSearchSettings() as Record<string, unknown>,
        saveSearchSettings: (input) => webSearch.saveSearchSettings(input) as Record<string, unknown>,
        testSearchBackend: (backend, options) => webSearch.testSearchBackend(backend, options) as Promise<Record<string, unknown>>,
        loadMapSettings: () => map.loadMapSettings(),
        saveMapSettings: (basemaps) => map.saveMapSettings(basemaps),
        listProjects: () => map.listProjects() as Array<{ project: unknown }>,
        rebuildBasemapStyle: (name) => map.rebuildBasemapStyle(name as string)
      };
    })();
    return depsPromise;
  };
  for (const channel of SEARCH_MAP_SETTINGS_DIRECT_CHANNELS) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (_event, payload: InvokeEnvelope | undefined) =>
      invokeSearchMapSettingsDirect(channel, payload, await ensureDeps())
    );
  }
}

/**
 * 地图域通道直调注册（F5-1/F5-2）：39 条通道（op:map:projects 系列 / op:map:project
 * 系列 / op:map:style / config / import / import:batch / prepare / rebuild /
 * layer:delete / layer:get / isochrone / route + F5-2 分析可视化族 visual:sources /
 * visual:get / traffic-bandwidth / od-lines / multi-isochrone / exchange-sankey /
 * road-structure / demo-analysis / cambodia-od / m3:*）进程内直调；数据源 map /
 * layer-repository / project-pack / workspace / map-visualization / cambodia-od /
 * map-analysis / map-demo / traffic-sources 九域（B5 TS 模块已就绪）。
 */
function registerMapDirectInvokers(): void {
  let depsPromise: Promise<MapDirectDeps> | null = null;
  const ensureDeps = (): Promise<MapDirectDeps> => {
    depsPromise ??= (async () => {
      const [map, layerRepo, projectPack, workspace, workspacePaths, featureFlags, visual, cambodiaOD, mapAnalysis, mapDemo, trafficSources, mapReport, batchExport, mapTemplate, builtinBrowser] = await Promise.all([
        import("./backend/map"),
        import("./backend/layer-repository"),
        import("./backend/project-pack"),
        import("./backend/workspace"),
        import("./backend/workspace-paths"),
        import("./backend/feature-flags"),
        import("./backend/map-visualization"),
        import("./backend/cambodia-od"),
        import("./backend/map-analysis"),
        import("./backend/map-demo"),
        // 导入即注册内置适配器（local-file / bundled-xinchang），与 server L5186 同形态
        import("./backend/traffic-sources"),
        // F5-3 报告导出模板族（GIS G8/G7/G5-v1 + B4 内置浏览器底座）
        import("./backend/map-report"),
        import("./backend/batch-export"),
        import("./backend/map-template"),
        import("./backend/builtin-browser")
      ]);
      // G2 外部数据适配器（live-traffic-api / sql-database）：flag 关 = 不注册 =
      // visual:sources 与 map_datasets 看不到，基线行为零变化（server L5189-5191 同款）。
      if (featureFlags.RUNTIME_FLAGS.dataAdapters) {
        void import("./backend/datasource-adapter-ext").catch((e) => console.warn("[data-adapters] 适配器注册失败：", (e as Error)?.message || e));
      }
      return {
        listProjects: () => map.listProjects(),
        createProject: (input) => map.createProject(input),
        getProject: (name) => map.getProject(name) as Record<string, unknown> | null,
        duplicateProject: (input) => map.duplicateProject(input),
        renameProject: (input) => map.renameProject(input),
        archiveProject: (name, archived) => map.archiveProject(name, archived),
        deleteProject: (name) => map.deleteProject(name) as Record<string, unknown>,
        saveStyle: (name, style) => map.saveStyle(name, style),
        saveConfig: (name, config) => map.saveConfig(name, config),
        importLayer: (name, layerId, geojson) => map.importLayer(name, layerId, geojson),
        importBatch: (name, items) => map.importBatch(name, items),
        rebuildTiles: (name, layerIds) => map.rebuildTiles(name, layerIds),
        deleteLayer: (name, layerId) => map.deleteLayer(name, layerId),
        getLayer: (name, layerId) => map.getLayer(name, layerId),
        isochrone: (input) => map.isochrone(input) as Promise<Record<string, unknown>>,
        route: (input) => map.route(input) as Promise<Record<string, unknown>>,
        listLayers: (project, options) => layerRepo.listLayers(project, options),
        buildProjectZip: (input) => projectPack.buildProjectZip(input),
        getWorkspace: () => workspace.getWorkspace(),
        projectDir: workspacePaths.PROJECT_DIR,
        dirProbe: (dir) => {
          if (!fs.existsSync(dir)) return { exists: false, isDirectory: false };
          return { exists: true, isDirectory: fs.statSync(dir).isDirectory() };
        },
        // server 用 PATH 上的 node 跑 scripts/tools/*.mjs（L752-756 逐点转录：超时 300s、
        // cwd=PROJECT_DIR、"node" 字面同款——桌面端与 sidecar 等价）。R6-8：打包分发态
        // PATH 上的 node 不可假设存在，切 Electron 自带 node 运行时（execPath +
        // ELECTRON_RUN_AS_NODE=1）；dev 态保持 "node" 字面与旧形态等价。
        runScript: (script, args) =>
          new Promise((resolve) => {
            void import("node:child_process").then(({ execFile }) => {
              const packaged = app.isPackaged;
              const command = packaged ? process.execPath : "node";
              const env = packaged ? { ...process.env, ELECTRON_RUN_AS_NODE: "1" } : process.env;
              execFile(command, [script, ...args], { cwd: workspacePaths.PROJECT_DIR, timeout: 300_000, env }, (err, stdout, stderr) => {
                resolve({ code: err ? 1 : 0, out: (stdout || "") + (stderr || "") });
              });
            });
          }),
        mapPackEnabled: () => featureFlags.RUNTIME_FLAGS.mapPack,
        // ---- F5-2 分析可视化族 deps ----
        getTrafficBandwidth: (name) => map.getTrafficBandwidth(name) as Record<string, unknown>,
        getODLines: (name) => map.getODLines(name) as Record<string, unknown>,
        multiIsochrone: (input) => map.multiIsochrone(input) as Promise<Record<string, unknown>>,
        getExchangeSankey: (name) => map.getExchangeSankey(name) as Record<string, unknown>,
        getRoadStructure: (name) => map.getRoadStructure(name) as Record<string, unknown>,
        visualListSources: () => visual.listSources() as Array<{ id: string } & Record<string, unknown>>,
        visualLoadSource: (id, params) => visual.loadSource(id, params),
        fromTrafficBandwidth: (result) => visual.fromTrafficBandwidth(result as Record<string, unknown>),
        fromOdLines: (result) => visual.fromOdLines(result as Record<string, unknown>),
        fromCambodiaOd: (result) => visual.fromCambodiaOd(result as Record<string, unknown>),
        fromDemoAnalysis: (action) => visual.fromDemoAnalysis(action as Record<string, unknown>),
        cambodiaGetCambodiaOD: (input) => cambodiaOD.getCambodiaOD(input),
        analysisCreateDemoAnalysis: (input) => mapAnalysis.createDemoAnalysis(input as Parameters<typeof mapAnalysis.createDemoAnalysis>[0]) as Record<string, unknown>,
        analysisGetCambodiaOD: (input) => mapAnalysis.getCambodiaOD(input as { minFlow?: string | number }) as Record<string, unknown>,
        getXinchangBus: (kind) => mapAnalysis.getXinchangBus(kind),
        demoCreateDemoAnalysis: (input) => mapDemo.createDemoAnalysis(input),
        plannedSources: () => trafficSources.PLANNED_SOURCES,
        // ---- F5-3 报告导出模板族 deps ----
        normalizeWorkspace: (dir) => workspace.normalizeWorkspace(String(dir ?? "")),
        mapReportEnabled: () => featureFlags.RUNTIME_FLAGS.mapReport,
        buildMapReport: (options) => mapReport.buildMapReport(options as Parameters<typeof mapReport.buildMapReport>[0]),
        mapExportEnabled: () => featureFlags.RUNTIME_FLAGS.mapExport,
        planExportJobs: (options) => batchExport.planExportJobs(options),
        runExportQueue: (jobs, executor, opts) => batchExport.runExportQueue(jobs, executor, opts),
        mapTemplatesEnabled: () => featureFlags.RUNTIME_FLAGS.mapTemplates,
        runOdCommuterTemplate: (options) => mapTemplate.runOdCommuterTemplate(options as Parameters<typeof mapTemplate.runOdCommuterTemplate>[0]),
        // 批量导出执行器走离屏导出窗口（R6-3）：offscreen BrowserWindow 加载 renderer
        // 导出路由（?export=map），数据面经 opDesktop 桥走 op:map:* 通道、资产面走
        // oaw-data://，不再依赖 sidecar 旧 client；会话键仍为 builtin-browser 纯键拼接。
        browserSessionKey: (clientId, threadId) => builtinBrowser.browserSessionKey(clientId, threadId),
        browserOpen: (key, url) => exportView.openExportView(key, url, { preload: PRELOAD_PATH }),
        browserResize: (key, width, height) => exportView.resizeExportView(key, width, height),
        browserWaitForExpression: (key, expression, opts) => exportView.waitForExportExpression(key, expression, opts),
        browserEvaluateValue: (key, expression) => exportView.evaluateExportValue(key, expression),
        browserPrintToPdf: (key) => exportView.printExportViewPdf(key),
        browserScreenshot: (key, options) => exportView.screenshotExportView(key, options),
        exportViewUrl: (job) => exportView.buildExportViewPageUrl(job, {
          devUrl: process.env.ELECTRON_RENDERER_URL,
          appIndex: path.join(__dirname, "../renderer/app/index.html")
        }),
        ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true }),
        writeFile: (file, data) => fs.writeFileSync(file, data),
        // ---- F5-5 style.json 动态读通道 deps ----
        mapProjectDir: (name) => map.projectDir(name),
        hydrateBasemapSources: (style) => map.hydrateBasemapSources(style),
        readStyleFile: (file) => fs.readFileSync(file, "utf8")
      } satisfies MapDirectDeps;
    })();
    return depsPromise;
  };
  for (const channel of MAP_DIRECT_CHANNELS) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (_event, payload: InvokeEnvelope | undefined) =>
      invokeMapDirect(channel, payload, await ensureDeps())
    );
  }
}

/**
 * 项目管理族通道直调注册（D-2）：7 条通道（op:projects:list/create/classify/update/
 * pin/archive/settings:update）进程内直调；list 为四域计数聚合（project-management +
 * runs + session-files + 装配单飞 agentManager.memoryProposals）。
 */
function registerProjectManagementDirectInvokers(): void {
  let depsPromise: Promise<ProjectManagementDirectDeps> | null = null;
  const ensureDeps = (): Promise<ProjectManagementDirectDeps> => {
    depsPromise ??= (async () => {
      const [workspace, projects, runs, sessionFiles, assembly] = await Promise.all([
        import("./backend/workspace"),
        import("./backend/project-management"),
        import("./backend/runs"),
        import("./backend/agent/session-files"),
        import("./backend/agent/assembly")
      ]);
      const agentManager = await assembly.getAgentManager();
      return {
        getWorkspace: () => workspace.getWorkspace(),
        ensureProjectForWorkspace: (rootPath) => projects.ensureProjectForWorkspace(rootPath),
        listRunSummaries: (options) => runs.listRunSummaries(options) as Array<Record<string, any>>,
        memoryProposals: () => agentManager.memoryProposals() as Array<Record<string, any>>,
        listSessionFiles: () => sessionFiles.listSessionFiles(),
        readSessionHeader: (found) => sessionFiles.readSessionHeader(found as never),
        listProjects: (filters) => projects.listProjects(filters),
        listProjectTypes: () => projects.listProjectTypes(),
        listProjectStatuses: () => projects.listProjectStatuses(),
        listProjectProfiles: () => projects.listProjectProfiles() as Record<string, any>,
        defaultProjectSettings: () => projects.defaultProjectSettings() as Record<string, any>,
        createProject: (input) => projects.createProject(input) as { ok: boolean } & Record<string, unknown>,
        updateProject: (id, patch) => projects.updateProject(id as string, patch) as { ok: boolean } & Record<string, unknown>,
        getProjectSettings: (id) => projects.getProjectSettings(id as string) as Record<string, any>,
        updateProjectSettings: (id, patch) => projects.updateProjectSettings(id as string, patch) as { ok: boolean } & Record<string, unknown>,
        archiveProject: (id, archived) => projects.archiveProject(id as string, archived) as { ok: boolean } & Record<string, unknown>,
        classifyProjects: (options) => projects.classifyProjects(options) as Record<string, unknown>
      };
    })();
    return depsPromise;
  };
  for (const channel of PROJECT_MANAGEMENT_DIRECT_CHANNELS) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (_event, payload: InvokeEnvelope | undefined) =>
      invokeProjectManagementDirect(channel, payload, await ensureDeps())
    );
  }
}

/**
 * workspace 族通道直调注册（D-3）：5 条通道（op:workspaces:list / op:workspace:switch /
 * validate / pick / pick:cancel）进程内直调：workspaces 聚合缓存（5s TTL + 会话扫描 +
 * 办公目录过滤）+ 写探针门禁 + 原生对话框 + Office CLI 双检查。
 */
function registerWorkspaceDirectInvokers(): void {
  let depsPromise: Promise<WorkspaceDirectDeps> | null = null;
  const ensureDeps = (): Promise<WorkspaceDirectDeps> => {
    depsPromise ??= (async () => {
      const [workspace, writeProbe, office, nativeFiles, sessionFiles] = await Promise.all([
        import("./backend/workspace"),
        import("./backend/workspace-write-probe"),
        import("./backend/office"),
        import("./backend/native-files"),
        import("./backend/agent/session-files")
      ]);
      return {
        WORKSPACE_DIR: workspace.WORKSPACE_DIR,
        getWorkspace: () => workspace.getWorkspace(),
        setWorkspace: (dir) => workspace.setWorkspace(dir),
        listWorkspace: (dir) => workspace.listWorkspace(dir) as unknown[],
        normalizeWorkspace: (dir) => workspace.normalizeWorkspace(dir),
        getHiddenWorkspaces: () => workspace.getHiddenWorkspaces(),
        evaluateWorkspaceWrite: (root) => writeProbe.evaluateWorkspaceWrite(root),
        checkOfficecli: () => office.checkOfficecli(),
        pickFolder: (options) => nativeFiles.pickFolder(options),
        cancelActivePicker: () => nativeFiles.cancelActivePicker(),
        activePickerInfo: () => nativeFiles.activePickerInfo(),
        listSessionFiles: () => sessionFiles.listSessionFiles(),
        readSessionTextCached: (found) => sessionFiles.readSessionTextCached(found as never),
        existsSync: (p) => fs.existsSync(p),
        readdirSync: (p) => fs.readdirSync(p),
        realpathSync: (p) => fs.realpathSync(p),
        // 地图库跟随（2026-10-30 改造）：switch 成功后广播 op:maps-changed，
        // 渲染层地图面板据此重拉项目清单 + 重载当前 style
        onSwitched: (ws) =>
          broadcastEvent({
            type: "op:maps-changed",
            at: new Date().toISOString(),
            data: { workspace: ws, mapsRoot: workspace.getMapsRoot() }
          })
      };
    })();
    return depsPromise;
  };
  for (const channel of WORKSPACE_DIRECT_CHANNELS) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (_event, payload: InvokeEnvelope | undefined) =>
      invokeWorkspaceDirect(channel, payload, await ensureDeps())
    );
  }
}

/**
 * files 族通道直调注册（D-4）：4 条通道（op:files:list/search/upload/delete）进程内
 * 直调：请求级工作区解析 + mime 投影 + writeWorkspaceFile/withWriteLockAsync 写协同 +
 * withOfficecliReleaseRetry（OFFICE_DOCUMENT_LOCKED 释放重试）。
 */
function registerFilesDirectInvokers(): void {
  let depsPromise: Promise<FilesDirectDeps> | null = null;
  const ensureDeps = (): Promise<FilesDirectDeps> => {
    depsPromise ??= (async () => {
      const [workspace, writeCoordination, filePermissionError, office] = await Promise.all([
        import("./backend/workspace"),
        import("./backend/agent/write-coordination"),
        import("./backend/file-permission-error"),
        import("./backend/office")
      ]);
      return {
        getWorkspace: () => workspace.getWorkspace(),
        normalizeWorkspace: (dir) => workspace.normalizeWorkspace(dir),
        resolvePath: (rel, ws) => workspace.resolvePath(rel, ws),
        safeName: (name) => workspace.safeName(name),
        listWorkspace: (dir) => workspace.listWorkspace(dir) as Array<Record<string, any>>,
        searchWorkspace: (query, options) => workspace.searchWorkspace(query, options),
        writeWorkspaceFile: (input) => writeCoordination.writeWorkspaceFile(input),
        withWriteLockAsync: (options, callback) => writeCoordination.withWriteLockAsync(options, callback),
        runOfficecli: (args, options) => office.runOfficecli(args, options),
        normalizeWorkspaceWriteError: (error) => filePermissionError.normalizeWorkspaceWriteError(error),
        workspaceWriteHttpStatus: (error) => filePermissionError.workspaceWriteHttpStatus(error),
        existsSync: (p) => fs.existsSync(p),
        statSync: (p) => fs.statSync(p),
        unlinkSync: (p) => fs.unlinkSync(p)
      };
    })();
    return depsPromise;
  };
  for (const channel of FILES_DIRECT_CHANNELS) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (_event, payload: InvokeEnvelope | undefined) =>
      invokeFilesDirect(channel, payload, await ensureDeps())
    );
  }
}

/**
 * doc 族通道直调注册（F4-3）：7 条读通道（op:doc:open/raw/text/html/comments/
 * outline/annotations）进程内直调：预览文件身份族 + 扩展名 kind 分发 + JSZip docx
 * 文本提取 + renderHtml 占位页/身份注入 + 会话批注提取 + 标题大纲启发式。
 * 写路由（annotations POST / watch / raw-save / cells）随 F4-4。
 */
function registerDocDirectInvokers(): void {
  let depsPromise: Promise<DocDirectDeps> | null = null;
  // F4-4 实时预览 watch 注册表：fs.watchFile 变化 → op:doc-watch 事件推送（不经对话流）。
  const docWatchRegistry = createDocWatchRegistry(
    (event) => broadcastEvent({ type: event.type, data: event.data }),
    {
      watchFile: (path, options, listener) => fs.watchFile(path, options, (curr) => listener(curr)),
      unwatchFile: (path) => fs.unwatchFile(path),
      statSync: (path) => fs.statSync(path)
    }
  );
  const ensureDeps = (): Promise<DocDirectDeps> => {
    depsPromise ??= (async () => {
      const [workspace, office, agentManager, sessionFiles, writeCoordination, filePermissionError] = await Promise.all([
        import("./backend/workspace"),
        import("./backend/office"),
        import("./backend/agent/assembly"),
        import("./backend/agent/session-files"),
        import("./backend/agent/write-coordination"),
        import("./backend/file-permission-error")
      ]);
      const manager = await agentManager.getAgentManager();
      return {
        getWorkspace: () => workspace.getWorkspace(),
        normalizeWorkspace: (dir) => workspace.normalizeWorkspace(dir),
        resolvePath: (rel, ws) => workspace.resolvePath(rel, ws),
        setCurrentFile: (clientId, file) => manager.setCurrentFile(clientId, file),
        officeGet: (file, target, depth) => office.get(file, target, depth),
        renderHtml: (file) => office.renderHtml(file),
        queryComments: (file) => office.queryComments(file),
        runOfficecli: (args, options) => office.runOfficecli(args, options),
        listSessionFiles: () => sessionFiles.listSessionFiles(),
        readSessionTextCached: (found) => sessionFiles.readSessionTextCached(found as never),
        existsSync: (p) => fs.existsSync(p),
        statSync: (p) => fs.statSync(p),
        readFileSync: (p) => fs.readFileSync(p),
        // ---- F4-4 写路由依赖 ----
        writeWorkspaceFile: (options) => writeCoordination.writeWorkspaceFile(options),
        withWriteLockAsync: (options, callback) => writeCoordination.withWriteLockAsync(options, callback),
        officeBatch: (file, commands) => office.batch(file, commands),
        normalizeOfficeFailure: (error, args, result) => filePermissionError.normalizeOfficeFailure(error, args as never, result),
        normalizeWorkspaceWriteError: (error) => filePermissionError.normalizeWorkspaceWriteError(error),
        workspaceWriteHttpStatus: (error) => filePermissionError.workspaceWriteHttpStatus(error),
        startDocWatch: (absPath, relativePath) => { docWatchRegistry.start(absPath, relativePath); },
        stopDocWatch: (absPath) => { docWatchRegistry.stop(absPath); }
      };
    })();
    return depsPromise;
  };
  for (const channel of DOC_DIRECT_CHANNELS) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (_event, payload: InvokeEnvelope | undefined) =>
      invokeDocDirect(channel, payload, await ensureDeps())
    );
  }
}

/**
 * B2 装配层冒烟路径：动态加载装配模块并构造真实 AgentManager
 * （已迁 TS 实现 + 未迁域旧 server 过渡桥）。成功输出 AGENT_DOMAIN_ASSEMBLED，
 * 失败输出 SMOKE_FAIL 并退出。
 */
async function assembleAgentDomainForSmoke(): Promise<boolean> {
  try {
    const assembly = await import("./backend/agent/assembly");
    await assembly.getAgentManager();
    console.log("AGENT_DOMAIN_ASSEMBLED");
    return true;
  } catch (error) {
    console.log(`SMOKE_FAIL agent 域装配失败：${error instanceof Error ? error.message : String(error)}`);
    void shutdown(1);
    return false;
  }
}

/** 非 SMOKE 形态的后台装配（不阻塞窗口加载；失败仅记录不崩进程）。 */
function assembleAgentDomainInBackground(): void {
  void import("./backend/agent/assembly")
    .then((assembly) => assembly.getAgentManager())
    .then(() => console.log("AGENT_DOMAIN_ASSEMBLED"))
    .catch((error) => {
      console.error(`agent 域装配失败：${error instanceof Error ? error.message : String(error)}`);
    });
}

async function bootstrap(): Promise<void> {
  broadcastStatus(bootStatus);
  if (SMOKE) {
    // B2 装配层冒烟：先装配（SMOKE_OK 锚点在装配成功后才输出），再验 React 挂载
    if (!(await assembleAgentDomainForSmoke())) return;
    void smokeNewUi();
    return;
  }
  assembleAgentDomainInBackground();
  if (mainWindow) {
    try {
      await loadAppPage(mainWindow);
      broadcastStatus({ phase: "ready" });
    } catch (error) {
      reportFatal(`新 UI 页面加载失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function reportFatal(message: string, logTail?: string[]): void {
  broadcastStatus({ phase: "failed", message, logTail });
  if (SMOKE) {
    console.log(`SMOKE_FAIL ${message}`);
    void shutdown(1);
  }
}

async function shutdown(exitCode: number): Promise<void> {
  if (quitting) return;
  quitting = true;
  exportView.closeAllExportViews();
  app.exit(exitCode);
}

// OP_DESKTOP_USER_DATA 显式重定向 userData（必须在 requestSingleInstanceLock 前生效：
// 单例锁落在 userData 下）。冒烟/受限运行环境用：%APPDATA% 不可写时把 Chromium
// 单例锁、窗口态与本地存储隔离到指定目录（smoke.mjs 每次运行注入一次性临时目录）。
const userDataOverride = process.env.OP_DESKTOP_USER_DATA;
if (userDataOverride) app.setPath("userData", path.resolve(userDataOverride));

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    ipcMain.handle("op:server-status", () => bootStatus);
    registerAgentDirectInvokers();
    registerAgentSessionsDirectInvokers();
    registerAgentRunsDirectInvokers();
    registerAgentPromptDirectInvokers();
    registerAgentPlansDirectInvokers();
    registerAgentAuthPermissionsDirectInvokers();
    registerAgentPiConfigDirectInvokers();
    registerAgentProviderCatalogDirectInvokers();
    registerAgentNetworkSettingsDirectInvokers();
    registerAgentMemoryDirectInvokers();
    registerAgentProbeDiagnosticsDirectInvokers();
    registerNativeSystemDirectInvokers();
    registerSystemStatusDirectInvokers();
    registerKbDirectInvokers();
    registerSkillsDirectInvokers();
    registerBrowserDirectInvokers();
    registerWorkflowsDirectInvokers();
    registerAgentsDirectInvokers();
    registerIntegrationsDirectInvokers();
    registerTemplatesDirectInvokers();
    registerSearchMapSettingsDirectInvokers();
    registerMapDirectInvokers();
    registerProjectManagementDirectInvokers();
    registerWorkspaceDirectInvokers();
    registerFilesDirectInvokers();
    registerDocDirectInvokers();
    registerEventBridgeHandlers();
    registerMemoryBridgeHandlers();
    registerGlobalEventsBridgeHandlers();
    // R6-2 资产自持：oaw-data://maps（锚 workspace.getMapsRoot() 动态 getter，与
    // backend/map.ts mapsRoot() 同源，工作区切换时地图库跟随）+ oaw-data://glyphs
    // （锚 app 根 resources/glyphs，dev 即 electron/resources/glyphs）。
    void import("./backend/workspace")
      .then((workspace) =>
        installOawDataProtocolHandler({
          maps: () => workspace.getMapsRoot(),
          glyphs: path.join(app.getAppPath(), "resources", "glyphs")
        })
      )
      .catch((e) => console.error("[oaw-data] 协议 handler 安装失败：", (e as Error)?.message || e));
    mainWindow = createSplashWindow(PRELOAD_PATH);
    void bootstrap();
  });

  app.on("window-all-closed", () => {
    void shutdown(0);
  });

  app.on("before-quit", (event) => {
    if (!quitting) {
      event.preventDefault();
      void shutdown(0);
    }
  });
}
