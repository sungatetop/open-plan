/**
 * 记忆族通道直调器（C-6，迁移期过渡形态）：op:memory:* → 进程内直调记忆域。
 *
 * 旧路径：渲染层 invoke → http-forward 转发 sidecar HTTP（/api/memory*）。
 * 本模块把记忆族 10 条通道的 sidecar 路由编排逐点转录为主进程内直调
 * （行号锚点均指 server/index.mjs）：
 *   - op:memory:list（L5058-5063）：记忆文件清单 + memoryDir；
 *   - op:memory:init（L5097-5114）：工作区骨架初始化（AGENTS.md / MEMORY.md
 *     模板缺则建）+ memory_initialized 事件 + 启动目录监听 + 返回清单；
 *   - op:memory:file:get（L5163-5168）：rel 安全解析 → 读文件内容；
 *   - op:memory:file:save（L5170-5179）：rel 安全解析 → 原子写 →
 *     memory_file_edited 事件（source: memory-panel）；
 *   - op:memory:proposals:list（L5116-5127）：thread 键拼接（agentKey）+
 *     workspace 归一 + 四过滤参数 trim → agentManager.memoryProposals；
 *   - op:memory:proposals:approve / edit / reject / history / merge
 *     （L5134-5161）：agentManager 五方法 → sendMemoryResult 形状
 *     （!ok → status||400 原样透传；ok → 200 原样）。
 *
 * 数据源：backend/agent/memory-files.ts（C-6 新转录文件域）+ workspace.ts
 * （getWorkspace/normalizeWorkspace）+ agent-key.ts + event-storage.ts（appendEvent）+
 * persistence-utils.ts（ensureDirectory/atomicWriteFile）+ agentManager 六方法
 * （memory 域 B 层对拍覆盖）——无 live 会话态依赖（C 层配置族口径）。
 *
 * 错误体形状忠实转录（http-forward 非 2xx 同形：data = 服务端 JSON 错误体）：
 *   - list/init/file:save 的 catch 分支错误体为 { error, code: e.code || null,
 *     detail: e.detail || null }（无 ok:false，与旧路由一致）；
 *   - file:get 的 catch 仅 { error }（无 code/detail）；不存在 → 404 { error: "not found" }、
 *     解析失败保存 → 400 { error: "invalid path" }；
 *   - proposals 五操作走 sendMemoryResult（!ok → result.status||400 整体透传）；
 *   - 无 try/catch 的 proposals:list 等抛错走 dispatcher 统一 500
 *     （对齐 http-forward 网络失败兜底形态）。
 *
 * 门控：OP_DESKTOP_AGENT_MEMORY_DIRECT 且 OP_DESKTOP_AGENT_DOMAIN 双门控（S4 起默认开，
 * =0 显式回滚——流量切换评估方案 §4-S4）。本模块不 import electron（纯逻辑，vitest 可直接测）；
 * 注册入口在 main/index.ts。
 */
import path from "node:path";
import type { ChannelFailureData, InvokeEnvelope, InvokeResult } from "../../shared/protocol/channels";

/** 记忆族编排的跨域依赖（生产接线传 backend 真实模块，测试注入桩）。 */
export interface AgentMemoryDirectDeps {
  /** 记忆文件域（backend/agent/memory-files.ts，C-6 转录） */
  listMemoryFiles: () => unknown[];
  getMemoryDir: () => string;
  startMemoryWatcher: () => void;
  resolveMemoryPath: (rel: unknown) => string | null;
  /** 工作区域（backend/workspace.ts） */
  getWorkspace: () => string;
  normalizeWorkspace: (dir: string) => string | null;
  /** thread 会话键（backend/agent/agent-key.ts） */
  agentKey: (client: unknown, thread: unknown) => string;
  /** 持久化域（backend/persistence-utils.ts）+ 文件系统面 */
  ensureDirectory: (dir: string) => unknown;
  atomicWriteFile: (file: string, data: string) => unknown;
  fileExists: (p: string) => boolean;
  readFileUtf8: (p: string) => string;
  /** 事件域（backend/event-storage.ts appendEvent） */
  appendEvent: (event: Record<string, unknown>) => unknown;
  /** 提案域（AgentManager 六方法，memory 域 B 层对拍覆盖） */
  memoryProposals: (threadId: string, filters: Record<string, any>) => unknown;
  approveMemoryProposal: (id: unknown, options: Record<string, any>) => any;
  editMemoryProposal: (id: unknown, options: Record<string, any>) => any;
  rejectMemoryProposal: (id: unknown, reason: unknown) => any;
  memoryProposalHistory: (id: unknown) => any;
  mergeMemoryProposals: (targetId: unknown, sourceIds?: unknown[]) => any;
}

/** 记忆族直调 invoke 通道清单（与 DESKTOP_CHANNELS 的 op:memory:* 一致）。 */
export const AGENT_MEMORY_DIRECT_CHANNELS = [
  "op:memory:list",
  "op:memory:init",
  "op:memory:file:get",
  "op:memory:file:save",
  "op:memory:proposals:list",
  "op:memory:proposals:approve",
  "op:memory:proposals:edit",
  "op:memory:proposals:reject",
  "op:memory:proposals:history",
  "op:memory:proposals:merge"
] as const;

export type AgentMemoryDirectChannel = (typeof AGENT_MEMORY_DIRECT_CHANNELS)[number];

const ok = (data: unknown): InvokeResult<unknown> => ({ ok: true, status: 200, data });

/** 非 2xx 信封（http-forward 非 2xx 同形：data = 服务端 JSON 错误体，含 code 等字段）。 */
const fail = (status: number, data: unknown): InvokeResult<unknown> => ({
  ok: false,
  status,
  data: data as ChannelFailureData
});

function bodyOf(payload: InvokeEnvelope): Record<string, any> {
  const body = payload.body;
  return body && typeof body === "object" ? (body as Record<string, any>) : {};
}

function paramsOf(payload: InvokeEnvelope): Record<string, any> {
  const params = (payload as { params?: unknown }).params;
  return params && typeof params === "object" ? (params as Record<string, any>) : {};
}

/** sendMemoryResult 转录（server L5129-5132 逐行）：!ok → status||400 整体透传。 */
function sendMemoryResult(result: any): InvokeResult<unknown> {
  return result?.ok ? ok(result) : fail(result?.status || 400, result);
}

/** GET /api/memory（server L5058-5063 逐点转录）。 */
function invokeMemoryList(_payload: InvokeEnvelope, deps: AgentMemoryDirectDeps): InvokeResult<unknown> {
  try {
    const files = deps.listMemoryFiles();
    return ok({ files, memoryDir: deps.getMemoryDir() });
  } catch (error) {
    const e = error as Error & { code?: unknown; detail?: unknown };
    return fail(500, { error: e.message, code: e.code || null, detail: e.detail || null });
  }
}

/** POST /api/memory/init（server L5097-5114 逐点转录）。 */
function invokeMemoryInit(_payload: InvokeEnvelope, deps: AgentMemoryDirectDeps): InvokeResult<unknown> {
  try {
    const ws = deps.getWorkspace();
    const agentsMd = path.join(ws, "AGENTS.md");
    const memDir = path.join(ws, "memory");
    const memMd = path.join(memDir, "MEMORY.md");
    deps.ensureDirectory(memDir);
    if (!deps.fileExists(agentsMd)) {
      deps.atomicWriteFile(agentsMd, `# AGENTS.md\n\n## 项目说明\n\n在此添加项目指令和上下文信息。\n\n## 工作偏好\n\n在此添加工作偏好。\n`);
    }
    if (!deps.fileExists(memMd)) {
      deps.atomicWriteFile(memMd, `# 记忆索引\n\n这是一个长期记忆文件，记录跨会话的上下文信息。\n\n## 项目信息\n\n## 工作规则\n\n## 用户偏好\n\n## 经验教训\n\n`);
    }
    deps.appendEvent({ type: "memory_initialized", data: { workspace: ws } });
    deps.startMemoryWatcher();
    return ok({ ok: true, files: deps.listMemoryFiles() });
  } catch (error) {
    const e = error as Error & { code?: unknown; detail?: unknown };
    return fail(500, { error: e.message, code: e.code || null, detail: e.detail || null });
  }
}

/** GET /api/memory/:rel（server L5163-5168 逐点转录；catch 错误体仅 { error }）。 */
function invokeMemoryFileGet(payload: InvokeEnvelope, deps: AgentMemoryDirectDeps): InvokeResult<unknown> {
  const rel = paramsOf(payload).rel;
  const fp = deps.resolveMemoryPath(rel);
  if (!fp || !deps.fileExists(fp)) return fail(404, { error: "not found" });
  try {
    return ok({ content: deps.readFileUtf8(fp), path: rel });
  } catch (error) {
    return fail(500, { error: (error as Error).message });
  }
}

/** POST /api/memory/:rel（server L5170-5179 逐点转录）。 */
function invokeMemoryFileSave(payload: InvokeEnvelope, deps: AgentMemoryDirectDeps): InvokeResult<unknown> {
  const rel = paramsOf(payload).rel;
  const fp = deps.resolveMemoryPath(rel);
  if (!fp) return fail(400, { error: "invalid path" });
  try {
    const body = bodyOf(payload);
    deps.ensureDirectory(path.dirname(fp));
    deps.atomicWriteFile(fp, body?.content || "");
    deps.appendEvent({
      clientId: String(body?.client || "") || null,
      threadId: String(body?.thread || "") || null,
      type: "memory_file_edited",
      data: { workspace: deps.getWorkspace(), path: rel, source: "memory-panel" }
    });
    return ok({ ok: true });
  } catch (error) {
    const e = error as Error & { code?: unknown; detail?: unknown };
    return fail(500, { error: e.message, code: e.code || null, detail: e.detail || null });
  }
}

/** GET /api/memory/proposals（server L5116-5127 逐点转录；无 try/catch，忠实转录）。 */
function invokeMemoryProposalsList(payload: InvokeEnvelope, deps: AgentMemoryDirectDeps): InvokeResult<unknown> {
  const query = (payload.query ?? {}) as Record<string, any>;
  const threadId = query.thread ? deps.agentKey(String(query.client || ""), String(query.thread)) : "";
  const workspace = query.workspace ? deps.normalizeWorkspace(query.workspace) : "";
  const status = String(query.status || "").trim();
  const proposals = deps.memoryProposals(threadId, {
    workspace,
    projectId: String(query.projectId || "").trim(),
    category: String(query.category || "").trim(),
    status
  });
  return ok({ proposals });
}

/** POST /api/memory/proposals/:id/approve（server L5134-5141 逐点转录）。 */
function invokeMemoryProposalApprove(payload: InvokeEnvelope, deps: AgentMemoryDirectDeps): InvokeResult<unknown> {
  const body = bodyOf(payload);
  const id = paramsOf(payload).id;
  return sendMemoryResult(deps.approveMemoryProposal(id, {
    content: body?.content,
    category: body?.category,
    section: body?.section,
    reviewer: body?.reviewer || "user"
  }));
}

/** PATCH /api/memory/proposals/:id（server L5143-5149 逐点转录）。 */
function invokeMemoryProposalEdit(payload: InvokeEnvelope, deps: AgentMemoryDirectDeps): InvokeResult<unknown> {
  const body = bodyOf(payload);
  const id = paramsOf(payload).id;
  return sendMemoryResult(deps.editMemoryProposal(id, {
    content: body?.content,
    category: body?.category,
    section: body?.section
  }));
}

/** POST /api/memory/proposals/:id/reject（server L5151-5153 逐点转录；reason 缺省由 agentManager 默认参数兜底）。 */
function invokeMemoryProposalReject(payload: InvokeEnvelope, deps: AgentMemoryDirectDeps): InvokeResult<unknown> {
  const id = paramsOf(payload).id;
  return sendMemoryResult(deps.rejectMemoryProposal(id, bodyOf(payload)?.reason));
}

/** GET /api/memory/proposals/:id/history（server L5155-5157 逐点转录）。 */
function invokeMemoryProposalHistory(payload: InvokeEnvelope, deps: AgentMemoryDirectDeps): InvokeResult<unknown> {
  return sendMemoryResult(deps.memoryProposalHistory(paramsOf(payload).id));
}

/** POST /api/memory/proposals/:id/merge（server L5159-5161 逐点转录）。 */
function invokeMemoryProposalMerge(payload: InvokeEnvelope, deps: AgentMemoryDirectDeps): InvokeResult<unknown> {
  const id = paramsOf(payload).id;
  return sendMemoryResult(deps.mergeMemoryProposals(id, bodyOf(payload)?.sourceIds));
}

/**
 * 记忆族通道直调分发：channel → 逐通道转录的 sidecar 路由编排。
 * 未知通道不进入本分发（注册面只登记 AGENT_MEMORY_DIRECT_CHANNELS 清单）；
 * 处理器抛出的意外错误统一 500（对齐 http-forward 网络失败兜底形态）。
 */
export async function invokeAgentMemoryDirect(
  channel: AgentMemoryDirectChannel,
  envelope: InvokeEnvelope | undefined,
  deps: AgentMemoryDirectDeps
): Promise<InvokeResult<unknown>> {
  const payload: InvokeEnvelope = envelope ?? {};
  try {
    switch (channel) {
      case "op:memory:list": return invokeMemoryList(payload, deps);
      case "op:memory:init": return invokeMemoryInit(payload, deps);
      case "op:memory:file:get": return invokeMemoryFileGet(payload, deps);
      case "op:memory:file:save": return invokeMemoryFileSave(payload, deps);
      case "op:memory:proposals:list": return invokeMemoryProposalsList(payload, deps);
      case "op:memory:proposals:approve": return invokeMemoryProposalApprove(payload, deps);
      case "op:memory:proposals:edit": return invokeMemoryProposalEdit(payload, deps);
      case "op:memory:proposals:reject": return invokeMemoryProposalReject(payload, deps);
      case "op:memory:proposals:history": return invokeMemoryProposalHistory(payload, deps);
      case "op:memory:proposals:merge": return invokeMemoryProposalMerge(payload, deps);
    }
  } catch (error) {
    return fail(500, { error: error instanceof Error ? error.message : String(error) });
  }
  return fail(404, { error: `unknown channel: ${channel}` });
}
