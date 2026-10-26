/**
 * S2 B 层通道直调对拍（agent-direct-invokers.ts）。
 *
 * 覆盖面：
 *   - 9 条 invoke 通道与 server/index.mjs 各路由逐点对齐：
 *     校验规则（400 文案逐字）、错误码（404/500）、响应形状；
 *   - stream-close 直推态 no-op（closed:0，server L4715-4724 无匹配流分支）；
 *   - manager 键统一走 server agentKey 转录（`${client}::${thread}`）；
 *   - setModel 失败诊断明细（recordAgentDiagnostic 调用点同参）；
 *   - 对拍锚点：AGENT_DIRECT_INVOKE_CHANNELS + AGENT_STREAM_CLOSE_CHANNEL
 *     与 DESKTOP_CHANNELS 清单一致、路由指向已审计的 /api/agent/* 路径。
 */
import { describe, expect, test, vi } from "vitest";
import {
  AGENT_DIRECT_INVOKE_CHANNELS,
  AGENT_STREAM_CLOSE_CHANNEL,
  invokeAgentDirect,
  invokeAgentStreamCloseDirect,
  type AgentDirectInvokerDeps,
  type DirectInvokerAgentManagerView
} from "../src/main/ipc/agent-direct-invokers";
import { agentKey } from "../src/main/backend/agent/agent-key";
import { DESKTOP_CHANNELS } from "../src/shared/protocol/channels";

type ManagerStub = DirectInvokerAgentManagerView & {
  setModel: ReturnType<typeof vi.fn>;
  runtimeHealth: ReturnType<typeof vi.fn>;
  usageSnapshot: ReturnType<typeof vi.fn>;
  resolveLiveEntry: ReturnType<typeof vi.fn>;
  pendingQuestions: ReturnType<typeof vi.fn>;
};

function makeManager(overrides: Partial<ManagerStub> = {}): ManagerStub {
  return {
    setModel: vi.fn(async () => ({ ok: true, model: "prov/model-x" })),
    runtimeHealth: vi.fn(() => ({ status: "ready", health: { status: "ok" } })),
    usageSnapshot: vi.fn(() => ({ tokens: 42 })),
    resolveLiveEntry: vi.fn(() => null),
    pendingQuestions: vi.fn(() => []),
    ...overrides
  };
}

function makeDeps(manager: ManagerStub, overrides: Partial<AgentDirectInvokerDeps> = {}): AgentDirectInvokerDeps & {
  listPendingApprovals: ReturnType<typeof vi.fn>;
  getApprovalMode: ReturnType<typeof vi.fn>;
  setApprovalMode: ReturnType<typeof vi.fn>;
  resolveToolApproval: ReturnType<typeof vi.fn>;
  eventStoreInfo: ReturnType<typeof vi.fn>;
  getReadCursor: ReturnType<typeof vi.fn>;
  markReadCursor: ReturnType<typeof vi.fn>;
  recordDiagnostic: ReturnType<typeof vi.fn>;
} {
  return {
    getManager: async () => manager,
    listPendingApprovals: vi.fn(() => [{ id: "ap-1" }]),
    getApprovalMode: vi.fn(() => "ask"),
    setApprovalMode: vi.fn((mode: unknown) => ({ ok: true, mode })),
    resolveToolApproval: vi.fn(() => ({ ok: true, id: "ap-1", decision: "allow" })),
    eventStoreInfo: vi.fn(() => ({ latest: 7, count: 7 })),
    getReadCursor: vi.fn(() => 3),
    markReadCursor: vi.fn(() => ({ ok: true, clientId: "c1", seq: 5 })),
    recordDiagnostic: vi.fn(),
    ...overrides
  } as never;
}

describe("S2 B 层直调：通道清单对拍锚点", () => {
  test("10 条通道全部在 DESKTOP_CHANNELS 且路由指向已审计路径", () => {
    const channels = [...AGENT_DIRECT_INVOKE_CHANNELS, AGENT_STREAM_CLOSE_CHANNEL];
    expect(channels).toHaveLength(10);
    const expectedRoutes: Record<string, { method: string; path: string }> = {
      "op:agent:model:set": { method: "POST", path: "/api/agent/model" },
      "op:agent:runtime": { method: "GET", path: "/api/agent/runtime" },
      "op:agent:pending": { method: "GET", path: "/api/agent/pending" },
      "op:agent:approvals": { method: "GET", path: "/api/agent/approvals" },
      "op:agent:approval": { method: "POST", path: "/api/agent/approval" },
      "op:agent:approval-mode:get": { method: "GET", path: "/api/agent/approval-mode" },
      "op:agent:approval-mode:set": { method: "PATCH", path: "/api/agent/approval-mode" },
      "op:agent:stream-close": { method: "POST", path: "/api/agent/stream/close" },
      "op:agent:events-state": { method: "GET", path: "/api/agent/events/state" },
      "op:agent:events-read": { method: "POST", path: "/api/agent/events/read" }
    };
    for (const channel of channels) {
      expect(DESKTOP_CHANNELS[channel as keyof typeof DESKTOP_CHANNELS]).toEqual(expectedRoutes[channel]);
    }
  });

  test("agentKey 转录与 server L1387-1391 逐字一致", () => {
    expect(agentKey("c1", "t1")).toBe("c1::t1");
    expect(agentKey(" c1 ", " t1 ")).toBe("c1::t1");
    expect(agentKey("c1", "")).toBe("c1");
    expect(agentKey("c1", undefined)).toBe("c1");
    // server 同款边界：client 空、thread 非空 → "::t"（忠实转录，不做"修正"）
    expect(agentKey("", "t")).toBe("::t");
  });
});

describe("S2 B 层直调：op:agent:model:set（server L1777-1786）", () => {
  test("ok：manager.setModel 收到 agentKey 键与原始 model，200 回传结果", async () => {
    const manager = makeManager();
    const deps = makeDeps(manager);
    const result = await invokeAgentDirect("op:agent:model:set", { body: { client: "c1", thread: "t1", model: "prov/model-x" } }, deps);
    expect(result).toEqual({ ok: true, status: 200, data: { ok: true, model: "prov/model-x" } });
    expect(manager.setModel).toHaveBeenCalledWith("c1::t1", "prov/model-x");
    expect(deps.recordDiagnostic).not.toHaveBeenCalled();
  });

  test("缺 client / 缺 model → 400 精确文案", async () => {
    const deps = makeDeps(makeManager());
    const noClient = await invokeAgentDirect("op:agent:model:set", { body: { thread: "t1", model: "m" } }, deps);
    expect(noClient).toEqual({ ok: false, status: 400, data: { error: "client and model required" } });
    const noModel = await invokeAgentDirect("op:agent:model:set", { body: { client: "c1" } }, deps);
    expect(noModel).toEqual({ ok: false, status: 400, data: { error: "client and model required" } });
  });

  test("setModel 抛错：诊断明细同参 + 500 {error: message}", async () => {
    const failure = new Error("模型不存在");
    const manager = makeManager({ setModel: vi.fn(async () => { throw failure; }) });
    const deps = makeDeps(manager);
    const result = await invokeAgentDirect("op:agent:model:set", { body: { client: "c1", thread: "t1", model: "prov/model-x" } }, deps);
    expect(result).toEqual({ ok: false, status: 500, data: { error: "模型不存在" } });
    expect(deps.recordDiagnostic).toHaveBeenCalledWith({ client: "c1", thread: "t1", model: "prov/model-x", error: failure });
  });
});

describe("S2 B 层直调：op:agent:runtime（server L1863-1868）", () => {
  test("ok：client trim 后组键，{runtime, usage} 同形状", async () => {
    const manager = makeManager();
    const deps = makeDeps(manager);
    const result = await invokeAgentDirect("op:agent:runtime", { query: { client: " c1 ", thread: "t1" } }, deps);
    expect(result).toEqual({
      ok: true, status: 200,
      data: { runtime: { status: "ready", health: { status: "ok" } }, usage: { tokens: 42 } }
    });
    expect(manager.runtimeHealth).toHaveBeenCalledWith("c1::t1");
    expect(manager.usageSnapshot).toHaveBeenCalledWith("c1::t1");
  });

  test("缺 client → 400 'client required'", async () => {
    const result = await invokeAgentDirect("op:agent:runtime", { query: {} }, makeDeps(makeManager()));
    expect(result).toEqual({ ok: false, status: 400, data: { error: "client required" } });
  });
});

describe("S2 B 层直调：op:agent:pending（server L3979-3991）", () => {
  test("client+thread 齐全：resolveLiveEntry 组键，pendingMessages 取数字", async () => {
    const manager = makeManager({
      resolveLiveEntry: vi.fn(() => ({ session: { pendingMessageCount: 2 } })),
      pendingQuestions: vi.fn(() => [{ id: "q1" }])
    });
    const result = await invokeAgentDirect("op:agent:pending", { query: { client: "c1", thread: "t1" } }, makeDeps(manager));
    expect(manager.resolveLiveEntry).toHaveBeenCalledWith("c1::t1");
    expect(manager.pendingQuestions).toHaveBeenCalledWith("c1::t1");
    expect(result).toEqual({ ok: true, status: 200, data: { questions: [{ id: "q1" }], pendingMessages: 2 } });
  });

  test("缺 thread：key 空串 → resolveLiveEntry 不调用，pendingQuestions('')，pendingMessages null", async () => {
    const manager = makeManager();
    const result = await invokeAgentDirect("op:agent:pending", { query: { client: "c1" } }, makeDeps(manager));
    expect(manager.resolveLiveEntry).not.toHaveBeenCalled();
    expect(manager.pendingQuestions).toHaveBeenCalledWith("");
    expect(result).toEqual({ ok: true, status: 200, data: { questions: [], pendingMessages: null } });
  });

  test("entry 无 session / pendingMessageCount 非数字 → pendingMessages null", async () => {
    const noSession = await invokeAgentDirect(
      "op:agent:pending",
      { query: { client: "c1", thread: "t1" } },
      makeDeps(makeManager({ resolveLiveEntry: vi.fn(() => null) }))
    );
    expect((noSession.data as { pendingMessages: unknown }).pendingMessages).toBeNull();
    const badCount = await invokeAgentDirect(
      "op:agent:pending",
      { query: { client: "c1", thread: "t1" } },
      makeDeps(makeManager({ resolveLiveEntry: vi.fn(() => ({ session: { pendingMessageCount: "3" } })) }))
    );
    expect((badCount.data as { pendingMessages: unknown }).pendingMessages).toBeNull();
  });
});

describe("S2 B 层直调：审批族（server L4003-4036）", () => {
  test("op:agent:approvals：{approvals: listPendingApprovals()}", async () => {
    const deps = makeDeps(makeManager());
    const result = await invokeAgentDirect("op:agent:approvals", {}, deps);
    expect(result).toEqual({ ok: true, status: 200, data: { approvals: [{ id: "ap-1" }] } });
  });

  test("op:agent:approval：ok → 200 回传完整 result", async () => {
    const deps = makeDeps(makeManager());
    const result = await invokeAgentDirect("op:agent:approval", { body: { id: "ap-1", decision: "allow" } }, deps);
    expect(result).toEqual({ ok: true, status: 200, data: { ok: true, id: "ap-1", decision: "allow" } });
    expect(deps.resolveToolApproval).toHaveBeenCalledWith("ap-1", "allow");
  });

  test("op:agent:approval：非法 decision → 400 精确文案；resolveToolApproval 不调用", async () => {
    const deps = makeDeps(makeManager());
    const result = await invokeAgentDirect("op:agent:approval", { body: { id: "ap-1", decision: "maybe" } }, deps);
    expect(result).toEqual({ ok: false, status: 400, data: { error: "id and decision (allow/always/deny) required" } });
    expect(deps.resolveToolApproval).not.toHaveBeenCalled();
  });

  test("op:agent:approval：result.ok=false → 404 携带完整 result", async () => {
    const deps = makeDeps(makeManager(), {
      resolveToolApproval: vi.fn(() => ({ ok: false, error: "approval not found" }))
    });
    const result = await invokeAgentDirect("op:agent:approval", { body: { id: "gone", decision: "deny" } }, deps);
    expect(result).toEqual({ ok: false, status: 404, data: { ok: false, error: "approval not found" } });
  });

  test("op:agent:approval-mode:get：{mode}", async () => {
    const result = await invokeAgentDirect("op:agent:approval-mode:get", {}, makeDeps(makeManager()));
    expect(result).toEqual({ ok: true, status: 200, data: { mode: "ask" } });
  });

  test("op:agent:approval-mode:set：auto/ask 直传；非法值 400 精确文案；缺省 'ask'", async () => {
    const deps = makeDeps(makeManager());
    const auto = await invokeAgentDirect("op:agent:approval-mode:set", { body: { mode: "auto" } }, deps);
    expect(auto).toEqual({ ok: true, status: 200, data: { ok: true, mode: "auto" } });
    const bad = await invokeAgentDirect("op:agent:approval-mode:set", { body: { mode: "bogus" } }, deps);
    expect(bad).toEqual({ ok: false, status: 400, data: { error: "mode must be ask or auto" } });
    const fallback = await invokeAgentDirect("op:agent:approval-mode:set", { body: {} }, deps);
    expect(fallback.ok && fallback.data).toMatchObject({ mode: "ask" });
  });
});

describe("S2 B 层直调：事件游标族（server L3124-3134）", () => {
  test("op:agent:events-state：{...eventStoreInfo(), readCursor}", async () => {
    const deps = makeDeps(makeManager());
    const result = await invokeAgentDirect("op:agent:events-state", { query: { client: " c1 " } }, deps);
    expect(result).toEqual({ ok: true, status: 200, data: { latest: 7, count: 7, readCursor: 3 } });
    expect(deps.getReadCursor).toHaveBeenCalledWith("c1");
  });

  test("op:agent:events-state：缺 client → 400 'client required'", async () => {
    const result = await invokeAgentDirect("op:agent:events-state", { query: {} }, makeDeps(makeManager()));
    expect(result).toEqual({ ok: false, status: 400, data: { error: "client required" } });
  });

  test("op:agent:events-read：markReadCursor(String(client), seq)", async () => {
    const deps = makeDeps(makeManager());
    const result = await invokeAgentDirect("op:agent:events-read", { body: { client: "c1", seq: 5 } }, deps);
    expect(result).toEqual({ ok: true, status: 200, data: { ok: true, clientId: "c1", seq: 5 } });
    expect(deps.markReadCursor).toHaveBeenCalledWith("c1", 5);
  });

  test("op:agent:events-read：缺 client → 400 'client and seq required'（server 同款只查 client）", async () => {
    const result = await invokeAgentDirect("op:agent:events-read", { body: {} }, makeDeps(makeManager()));
    expect(result).toEqual({ ok: false, status: 400, data: { error: "client and seq required" } });
  });
});

describe("S2 B 层直调：stream-close 与兜底", () => {
  test("stream-close 直推态 no-op：{closed: 0}", () => {
    expect(invokeAgentStreamCloseDirect()).toEqual({ ok: true, status: 200, data: { closed: 0 } });
  });

  test("getManager 拒绝 → 500 兜底（对齐 http-forward 网络失败形态）", async () => {
    const deps = makeDeps(makeManager(), { getManager: async () => { throw new Error("装配失败"); } });
    const result = await invokeAgentDirect("op:agent:runtime", { query: { client: "c1" } }, deps);
    expect(result).toEqual({ ok: false, status: 500, data: { error: "装配失败" } });
  });
});
