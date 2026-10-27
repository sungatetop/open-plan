/**
 * C-6 记忆族直调对拍（agent-memory-direct.ts 编排层）。
 *
 * 覆盖面（行号锚点均指 server/index.mjs）：
 *   - manifest 锚点：10 通道全部在 DESKTOP_CHANNELS 且路由指向已审计路径；unknown → 404；
 *   - list（L5058-5063）：{ files, memoryDir } 形状 / 抛错 500 { error, code, detail }（无 ok:false）；
 *   - init（L5097-5114）：模板文件缺则建 + 已存不覆写 + appendEvent/startMemoryWatcher
 *     编排顺序 + 响应 { ok:true, files } / 抛错 500；
 *   - file:get（L5163-5168）：resolve null → 404 / 文件不存在 → 404 / 成功
 *     { content, path } / 读抛错 500 仅 { error }（无 code）；
 *   - file:save（L5170-5179）：resolve null → 400 invalid path / 成功链
 *     ensureDirectory+atomicWrite+appendEvent(clientId/threadId 空串→null) / 写抛错 500；
 *   - proposals:list（L5116-5127）：thread 有无 → agentKey 拼接分支 / workspace 归一 /
 *     四过滤 trim / 响应 { proposals }；
 *   - sendMemoryResult（L5129-5132）：ok → 200 原样 / !ok → status||400 整体透传；
 *   - approve/edit/reject/history/merge 五操作参数转录（reviewer 默认 user、
 *     reason/sourceIds 缺省透传 undefined 交 agentManager 默认参数）。
 *
 * 本文件为纯编排测试：不加载 memory-files 等域实现（无 env 隔离需求）。
 */
import { describe, expect, test, beforeAll, vi } from "vitest";
import path from "node:path";
import type * as MemoryModule from "../src/main/ipc/agent-memory-direct";
import { DESKTOP_CHANNELS, type InvokeEnvelope } from "../src/shared/protocol/channels";

type Memory = typeof MemoryModule;
let svc: Memory;

beforeAll(async () => {
  svc = await import("../src/main/ipc/agent-memory-direct");
});

/** deps 桩：memory-files 文件域 + workspace/persistence/event-storage + agentManager 六方法注入。 */
function makeDeps(overrides: Partial<MemoryModule.AgentMemoryDirectDeps> = {}) {
  const deps = {
    listMemoryFiles: vi.fn(() => [
      { name: "AGENTS.md", rel: "AGENTS.md", size: 100, mtime: 1, type: "agents" },
      { name: "MEMORY.md", rel: "MEMORY.md", size: 200, mtime: 2, type: "memory" }
    ]),
    getMemoryDir: vi.fn(() => "D:\\ws\\memory"),
    startMemoryWatcher: vi.fn(() => undefined),
    resolveMemoryPath: vi.fn((rel: unknown) => (rel === "AGENTS.md" ? path.join("D:\\ws", "AGENTS.md") : rel === "notes/todo.md" ? path.join("D:\\ws", "memory", "notes", "todo.md") : null)),
    getWorkspace: vi.fn(() => "D:\\ws"),
    normalizeWorkspace: vi.fn((dir: string) => dir || null),
    agentKey: vi.fn((client: unknown, thread: unknown) => `${String(client)}::${String(thread)}`),
    ensureDirectory: vi.fn(() => undefined),
    atomicWriteFile: vi.fn(() => undefined),
    fileExists: vi.fn((p: string) => p === path.join("D:\\ws", "AGENTS.md")),
    readFileUtf8: vi.fn(() => "# 记忆内容"),
    appendEvent: vi.fn(() => undefined),
    memoryProposals: vi.fn(() => [{ id: "p1" }]),
    approveMemoryProposal: vi.fn(() => ({ ok: true, proposal: { id: "p1" } })),
    editMemoryProposal: vi.fn(() => ({ ok: true, proposal: { id: "p1" } })),
    rejectMemoryProposal: vi.fn(() => ({ ok: true, proposal: { id: "p1" } })),
    memoryProposalHistory: vi.fn(() => ({ ok: true, history: [] })),
    mergeMemoryProposals: vi.fn(() => ({ ok: true, proposal: { id: "p1" } })),
    ...overrides
  };
  return deps as never as MemoryModule.AgentMemoryDirectDeps & {
    // 测试内需访问 vi.fn 的 mock 记录；接口签名的纯函数视图供 invoke 使用
    listMemoryFiles: ReturnType<typeof vi.fn>;
    getMemoryDir: ReturnType<typeof vi.fn>;
    startMemoryWatcher: ReturnType<typeof vi.fn>;
    resolveMemoryPath: ReturnType<typeof vi.fn>;
    getWorkspace: ReturnType<typeof vi.fn>;
    normalizeWorkspace: ReturnType<typeof vi.fn>;
    agentKey: ReturnType<typeof vi.fn>;
    ensureDirectory: ReturnType<typeof vi.fn>;
    atomicWriteFile: ReturnType<typeof vi.fn>;
    fileExists: ReturnType<typeof vi.fn>;
    readFileUtf8: ReturnType<typeof vi.fn>;
    appendEvent: ReturnType<typeof vi.fn>;
    memoryProposals: ReturnType<typeof vi.fn>;
    approveMemoryProposal: ReturnType<typeof vi.fn>;
    editMemoryProposal: ReturnType<typeof vi.fn>;
    rejectMemoryProposal: ReturnType<typeof vi.fn>;
    memoryProposalHistory: ReturnType<typeof vi.fn>;
    mergeMemoryProposals: ReturnType<typeof vi.fn>;
  };
}

function invoke(channel: MemoryModule.AgentMemoryDirectChannel, envelope: InvokeEnvelope | undefined, deps = makeDeps()) {
  return svc.invokeAgentMemoryDirect(channel, envelope, deps);
}

describe("C-6 manifest 锚点", () => {
  test("10 条通道全部在 DESKTOP_CHANNELS 且路由指向已审计路径", () => {
    expect(svc.AGENT_MEMORY_DIRECT_CHANNELS).toHaveLength(10);
    const expectedRoutes: Record<string, { method: string; path: string }> = {
      "op:memory:list": { method: "GET", path: "/api/memory" },
      "op:memory:init": { method: "POST", path: "/api/memory/init" },
      "op:memory:file:get": { method: "GET", path: "/api/memory/:rel" },
      "op:memory:file:save": { method: "POST", path: "/api/memory/:rel" },
      "op:memory:proposals:list": { method: "GET", path: "/api/memory/proposals" },
      "op:memory:proposals:approve": { method: "POST", path: "/api/memory/proposals/:id/approve" },
      "op:memory:proposals:edit": { method: "PATCH", path: "/api/memory/proposals/:id" },
      "op:memory:proposals:reject": { method: "POST", path: "/api/memory/proposals/:id/reject" },
      "op:memory:proposals:history": { method: "GET", path: "/api/memory/proposals/:id/history" },
      "op:memory:proposals:merge": { method: "POST", path: "/api/memory/proposals/:id/merge" }
    };
    for (const channel of svc.AGENT_MEMORY_DIRECT_CHANNELS) {
      expect(DESKTOP_CHANNELS[channel as keyof typeof DESKTOP_CHANNELS]).toEqual(expectedRoutes[channel]);
    }
  });

  test("unknown channel → 404", async () => {
    const result = await svc.invokeAgentMemoryDirect("op:memory:file:remove" as never, {}, makeDeps());
    expect(result).toEqual({ ok: false, status: 404, data: { error: "unknown channel: op:memory:file:remove" } });
  });
});

describe("C-6 op:memory:list（L5058-5063）", () => {
  test("成功 → { files, memoryDir }；抛错 → 500 { error, code, detail }（无 ok:false，忠实转录）", async () => {
    const deps = makeDeps();
    const result = await invoke("op:memory:list", {}, deps);
    expect(result).toEqual({
      ok: true,
      status: 200,
      data: {
        files: [
          { name: "AGENTS.md", rel: "AGENTS.md", size: 100, mtime: 1, type: "agents" },
          { name: "MEMORY.md", rel: "MEMORY.md", size: 200, mtime: 2, type: "memory" }
        ],
        memoryDir: "D:\\ws\\memory"
      }
    });

    const boom = makeDeps({ listMemoryFiles: vi.fn(() => { const e = new Error("记忆目录损坏") as Error & { code?: string }; e.code = "EACCES"; throw e; }) });
    expect((await invoke("op:memory:list", {}, boom)).data).toEqual({ error: "记忆目录损坏", code: "EACCES", detail: null });
  });
});

describe("C-6 op:memory:init（L5097-5114）", () => {
  test("缺 AGENTS.md+MEMORY.md → 两模板写入 + appendEvent(memory_initialized) + startMemoryWatcher + { ok:true, files }", async () => {
    const deps = makeDeps({ fileExists: vi.fn(() => false) });
    const result = await invoke("op:memory:init", {}, deps);
    expect(deps.ensureDirectory.mock.calls[0]).toEqual([path.join("D:\\ws", "memory")]);
    const writes = deps.atomicWriteFile.mock.calls.map((c) => c[0]);
    expect(writes).toEqual([path.join("D:\\ws", "AGENTS.md"), path.join("D:\\ws", "memory", "MEMORY.md")]);
    expect(String(deps.atomicWriteFile.mock.calls[0]![1]).startsWith("# AGENTS.md")).toBe(true);
    expect(String(deps.atomicWriteFile.mock.calls[1]![1]).startsWith("# 记忆索引")).toBe(true);
    expect(deps.appendEvent.mock.calls[0]).toEqual([{ type: "memory_initialized", data: { workspace: "D:\\ws" } }]);
    expect(deps.startMemoryWatcher).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, status: 200, data: { ok: true, files: deps.listMemoryFiles() } });
  });

  test("文件已存 → 不覆写（AGENTS.md 存、MEMORY.md 缺 → 仅写一处）；抛错 → 500 code/detail 置 null", async () => {
    const deps = makeDeps(); // fileExists 桩：仅 AGENTS.md 存在
    await invoke("op:memory:init", {}, deps);
    const writes = deps.atomicWriteFile.mock.calls.map((c) => c[0]);
    expect(writes).toEqual([path.join("D:\\ws", "memory", "MEMORY.md")]);

    const boom = makeDeps({ ensureDirectory: vi.fn(() => { throw new Error("目录拒绝访问"); }) });
    expect((await invoke("op:memory:init", {}, boom)).data).toEqual({ error: "目录拒绝访问", code: null, detail: null });
  });
});

describe("C-6 op:memory:file:get（L5163-5168）", () => {
  test("resolve null → 404 not found；文件不存在 → 404；成功 → { content, path }；读抛错 → 500 仅 { error }", async () => {
    expect((await invoke("op:memory:file:get", { params: { rel: "../etc/passwd" } })).status).toBe(404);
    expect((await invoke("op:memory:file:get", { params: { rel: "AGENTS.md" } }, makeDeps({ fileExists: vi.fn(() => false) }))).data).toEqual({ error: "not found" });

    const deps = makeDeps();
    const result = await invoke("op:memory:file:get", { params: { rel: "AGENTS.md" } }, deps);
    expect(deps.readFileUtf8.mock.calls[0]).toEqual([path.join("D:\\ws", "AGENTS.md")]);
    expect(result).toEqual({ ok: true, status: 200, data: { content: "# 记忆内容", path: "AGENTS.md" } });

    const readBoom = makeDeps({ readFileUtf8: vi.fn(() => { throw new Error("读取失败"); }) });
    const failed = await invoke("op:memory:file:get", { params: { rel: "AGENTS.md" } }, readBoom);
    expect(failed).toEqual({ ok: false, status: 500, data: { error: "读取失败" } });
  });
});

describe("C-6 op:memory:file:save（L5170-5179）", () => {
  test("resolve null → 400 invalid path；成功链 ensureDirectory(dirname)+atomicWrite+appendEvent(clientId/threadId 空串→null)", async () => {
    expect((await invoke("op:memory:file:save", { params: { rel: "abs/..\\x.md" }, body: { content: "x" } })).data).toEqual({ error: "invalid path" });

    const deps = makeDeps();
    const result = await invoke("op:memory:file:save", { params: { rel: "notes/todo.md" }, body: { content: "新内容", client: "c1", thread: "t1" } }, deps);
    expect(deps.ensureDirectory.mock.calls[0]).toEqual([path.join("D:\\ws", "memory", "notes")]);
    expect(deps.atomicWriteFile.mock.calls[0]).toEqual([path.join("D:\\ws", "memory", "notes", "todo.md"), "新内容"]);
    expect(deps.appendEvent.mock.calls[0]![0]).toMatchObject({ clientId: "c1", threadId: "t1", type: "memory_file_edited", data: { workspace: "D:\\ws", path: "notes/todo.md", source: "memory-panel" } });
    expect(result).toEqual({ ok: true, status: 200, data: { ok: true } });

    const noClient = makeDeps();
    await invoke("op:memory:file:save", { params: { rel: "notes/todo.md" }, body: { content: "x" } }, noClient);
    expect(deps.resolveMemoryPath).toHaveBeenCalledWith("notes/todo.md");
    expect(noClient.appendEvent.mock.calls[0]![0]).toMatchObject({ clientId: null, threadId: null });
  });

  test("content 缺省 → 空串写入；写抛错 → 500 { error, code, detail }", async () => {
    const deps = makeDeps();
    await invoke("op:memory:file:save", { params: { rel: "AGENTS.md" } }, deps);
    expect(deps.atomicWriteFile.mock.calls[0]).toEqual([path.join("D:\\ws", "AGENTS.md"), ""]);

    const boom = makeDeps({ atomicWriteFile: vi.fn(() => { const e = new Error("磁盘已满") as Error & { code?: string }; e.code = "ENOSPC"; throw e; }) });
    expect((await invoke("op:memory:file:save", { params: { rel: "AGENTS.md" }, body: { content: "x" } }, boom)).data)
      .toEqual({ error: "磁盘已满", code: "ENOSPC", detail: null });
  });
});

describe("C-6 op:memory:proposals:list（L5116-5127）", () => {
  test("thread 有 → agentKey(client, thread)；thread 无 → 空串；workspace 归一；四过滤 trim；响应 { proposals }", async () => {
    const deps = makeDeps();
    const result = await invoke("op:memory:proposals:list", { query: { client: "web", thread: "t1", workspace: "D:/other", projectId: " p1 ", category: " rule ", status: " pending " } }, deps);
    expect(deps.agentKey.mock.calls[0]).toEqual(["web", "t1"]);
    expect(deps.normalizeWorkspace.mock.calls[0]).toEqual(["D:/other"]);
    expect(deps.memoryProposals.mock.calls[0]).toEqual(["web::t1", { workspace: "D:/other", projectId: "p1", category: "rule", status: "pending" }]);
    expect(result).toEqual({ ok: true, status: 200, data: { proposals: [{ id: "p1" }] } });

    const bare = makeDeps();
    await invoke("op:memory:proposals:list", { query: {} }, bare);
    expect(bare.memoryProposals.mock.calls[0]).toEqual(["", { workspace: "", projectId: "", category: "", status: "" }]);
    expect(bare.normalizeWorkspace).not.toHaveBeenCalled();
  });
});

describe("C-6 sendMemoryResult（L5129-5132）+ 五操作参数转录（L5134-5161）", () => {
  test("ok → 200 原样；!ok → status||400 整体透传", async () => {
    expect(await invoke("op:memory:proposals:history", { params: { id: "h1" } }))
      .toEqual({ ok: true, status: 200, data: { ok: true, history: [] } });

    const rejected = makeDeps({ memoryProposalHistory: vi.fn(() => ({ ok: false, status: 404, error: "提案不存在" })) });
    const result = await invoke("op:memory:proposals:history", { params: { id: "h1" } }, rejected);
    expect(result).toEqual({ ok: false, status: 404, data: { ok: false, status: 404, error: "提案不存在" } });

    const noStatus = makeDeps({ memoryProposalHistory: vi.fn(() => ({ ok: false, error: "bad" })) });
    expect((await invoke("op:memory:proposals:history", { params: { id: "h1" } }, noStatus)).status).toBe(400);
  });

  test("approve：id 取 params + reviewer 默认 user + content/category/section 透传", async () => {
    const deps = makeDeps();
    await invoke("op:memory:proposals:approve", { params: { id: "a1" }, body: { content: "改", category: "pref" } }, deps);
    expect(deps.approveMemoryProposal.mock.calls[0]).toEqual(["a1", { content: "改", category: "pref", section: undefined, reviewer: "user" }]);

    const withReviewer = makeDeps();
    await invoke("op:memory:proposals:approve", { params: { id: "a1" }, body: { reviewer: "admin", section: "规则" } }, withReviewer);
    expect(withReviewer.approveMemoryProposal.mock.calls[0]![1]).toMatchObject({ reviewer: "admin", section: "规则" });
  });

  test("edit 三字段透传；reject reason 缺省透传 undefined；merge sourceIds 透传", async () => {
    const deps = makeDeps();
    await invoke("op:memory:proposals:edit", { params: { id: "e1" }, body: { content: "编辑", category: "info", section: "项目信息" } }, deps);
    expect(deps.editMemoryProposal.mock.calls[0]).toEqual(["e1", { content: "编辑", category: "info", section: "项目信息" }]);

    const rejectDeps = makeDeps();
    await invoke("op:memory:proposals:reject", { params: { id: "r1" }, body: { reason: "不采纳" } }, rejectDeps);
    expect(rejectDeps.rejectMemoryProposal.mock.calls[0]).toEqual(["r1", "不采纳"]);

    const bareReject = makeDeps();
    await invoke("op:memory:proposals:reject", { params: { id: "r1" } }, bareReject);
    expect(bareReject.rejectMemoryProposal.mock.calls[0]).toEqual(["r1", undefined]);

    const mergeDeps = makeDeps();
    await invoke("op:memory:proposals:merge", { params: { id: "m1" }, body: { sourceIds: ["s1", "s2"] } }, mergeDeps);
    expect(mergeDeps.mergeMemoryProposals.mock.calls[0]).toEqual(["m1", ["s1", "s2"]]);
  });
});
