/**
 * S3-2 运行族直调对拍（agent-runs-direct.ts 编排层）。
 *
 * 覆盖面（行号锚点均指 server/index.mjs）：
 *   - manifest 锚点：op:runs:* / op:artifacts:* 13 通道中 11 条直调、路由指向已审计路径；
 *     resume/retry（L4657-4672，依赖 executeContinuation = S3-3 prompt 主链）不在本分发；
 *   - 逐通道编排语义（deps 全注入桩，域行为由各域自有对拍覆盖）：
 *     list（cwd 哨兵 / fields=summary / includeEvents / limit）/ get 404 / cancel
 *     （404 / canCancel 409 / live busy→abort / 空态→finishRun cancelled / abort 409 /
 *     agentKey 键格式）/ rollback（confirm 400 / awaitBeforeBlobs 吞错 / !ok 400）/
 *     step 404 / artifacts:list 哨兵 / publish·accept·rollback·acceptance 通道透传与
 *     错误映射 / diff（RUN_NOT_FOUND / CHANGE_NOT_FOUND code 错误体 / before·after blob
 *     真读 / 工作区 fallback 与越界拒绝 / maxInputBytes 截断 / page 解析 / 响应形状）/
 *     dispatcher（unknown channel 404 / 意外错误 500）。
 *
 * 本文件为纯编排测试：不加载 runs/artifact 域实现（无 env 隔离需求），diff 的
 * before/after blob 读取经 runsChangesDir 桩指向 tmp 真文件验证读文件路径拼接。
 */
import { describe, expect, test, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as RunsDirectModule from "../src/main/ipc/agent-runs-direct";
import { DESKTOP_CHANNELS, type InvokeEnvelope } from "../src/shared/protocol/channels";

type RunsDirect = typeof RunsDirectModule;
let svc: RunsDirect;
let tmp = "";

beforeAll(async () => {
  svc = await import("../src/main/ipc/agent-runs-direct");
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "s3runs-"));
});

afterAll(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

/** deps 桩：runs / artifact / diff / workspace / manager 五域注入面。 */
function makeDeps(overrides: Partial<RunsDirectModule.AgentRunsDirectDeps> = {}): RunsDirectModule.AgentRunsDirectDeps & {
  listRuns: ReturnType<typeof vi.fn>;
  diffFileContents: ReturnType<typeof vi.fn>;
} {
  const deps = {
    getManager: vi.fn(async () => ({ sessions: new Map(), abort: vi.fn(async () => ({})) })),
    getRun: vi.fn(() => null),
    listRuns: vi.fn(() => []),
    runSummaryView: vi.fn((run: any) => ({ summaryOf: run.id })),
    updateRunStep: vi.fn(() => null),
    finishRun: vi.fn(() => null),
    requestRunCancellation: vi.fn(() => ({ pending: true })),
    awaitBeforeBlobs: vi.fn(async () => ({})),
    rollbackRun: vi.fn(() => ({ ok: true, restored: 2 })),
    listPublishedArtifacts: vi.fn(() => []),
    publishArtifact: vi.fn(async () => ({ ok: true, artifact: { id: "p1" } })),
    confirmArtifactAcceptance: vi.fn(async () => ({ ok: true, acceptance: { status: "passed" } })),
    inspectRunAcceptance: vi.fn(async () => ({ ok: true, acceptance: { status: "passed" } })),
    rollbackPublishedArtifact: vi.fn(() => ({ ok: true, rolledBack: {} })),
    diffFileContents: vi.fn(() => ({ diff: "stub", hunks: [] })),
    diffLimits: { maxInputBytes: 1_000_000, maxHunksPerPage: 50 },
    runsChangesDir: vi.fn(() => tmp),
    normalizeWorkspace: vi.fn((dir: unknown) => (dir ? String(dir) : null)),
    isInside: vi.fn((root: string, target: string) => {
      const rel = path.relative(path.resolve(root), path.resolve(target));
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    }),
    ...overrides
  };
  return deps as never;
}

function invoke(channel: RunsDirectModule.AgentRunsDirectChannel, envelope: InvokeEnvelope | undefined, deps = makeDeps()) {
  return svc.invokeAgentRunsDirect(channel, envelope, deps);
}

describe("S3-2 manifest 锚点", () => {
  test("11 条通道全部在 DESKTOP_CHANNELS 且路由指向 /api/runs*|/api/artifacts* 已审计路径", () => {
    expect(svc.AGENT_RUNS_DIRECT_CHANNELS).toHaveLength(11);
    const expectedRoutes: Record<string, { method: string; path: string }> = {
      "op:runs:list": { method: "GET", path: "/api/runs" },
      "op:runs:get": { method: "GET", path: "/api/runs/:id" },
      "op:runs:cancel": { method: "POST", path: "/api/runs/:id/cancel" },
      "op:runs:rollback": { method: "POST", path: "/api/runs/:id/rollback" },
      "op:runs:step": { method: "POST", path: "/api/runs/:id/steps/:stepId" },
      "op:runs:artifacts:publish": { method: "POST", path: "/api/runs/:id/artifacts/:artifactId/publish" },
      "op:runs:artifacts:accept": { method: "POST", path: "/api/runs/:id/artifacts/:artifactId/accept" },
      "op:runs:acceptance": { method: "GET", path: "/api/runs/:id/acceptance" },
      "op:runs:diff": { method: "GET", path: "/api/runs/:id/changes/:changeId/diff" },
      "op:artifacts:list": { method: "GET", path: "/api/artifacts" },
      "op:artifacts:rollback": { method: "POST", path: "/api/artifacts/:publicationId/rollback" }
    };
    for (const channel of svc.AGENT_RUNS_DIRECT_CHANNELS) {
      expect(DESKTOP_CHANNELS[channel as keyof typeof DESKTOP_CHANNELS]).toEqual(expectedRoutes[channel]);
    }
  });

  test("resume/retry 留转发 sidecar（依赖 S3-3 executeContinuation），不进本分发", async () => {
    expect(svc.AGENT_RUNS_DIRECT_CHANNELS).not.toContain("op:runs:resume");
    expect(svc.AGENT_RUNS_DIRECT_CHANNELS).not.toContain("op:runs:retry");
    // 分发面对未登记通道一律 404（注册面只登记 AGENT_RUNS_DIRECT_CHANNELS 清单）
    const result = await svc.invokeAgentRunsDirect("op:runs:resume" as never, {}, makeDeps());
    expect(result).toEqual({ ok: false, status: 404, data: { error: "unknown channel: op:runs:resume" } });
  });
});

describe("S3-2 op:runs:list（server L3037-3059）", () => {
  test("query 透传：thread/session/projectId/status/mode/query 字符串化，limit parseInt||50", async () => {
    const deps = makeDeps();
    await invoke("op:runs:list", { query: { thread: "t1", session: "s1", projectId: "p1", status: "running", mode: "agent", query: "kw", limit: "30" } }, deps);
    expect(deps.listRuns).toHaveBeenCalledWith({
      threadId: "t1", sessionId: "s1", cwd: "", projectId: "p1", status: "running", mode: "agent", query: "kw",
      limit: 30, includeEvents: "latest"
    });
  });

  test("limit 非数字 → 50；cwd 经 normalizeWorkspace，null → 哨兵 __invalid_workspace__", async () => {
    const deps = makeDeps({ normalizeWorkspace: vi.fn(() => null) });
    await invoke("op:runs:list", { query: { cwd: "D:\\不存在", limit: "abc" } }, deps);
    expect(deps.listRuns).toHaveBeenCalledWith(expect.objectContaining({ cwd: "__invalid_workspace__", limit: 50 }));
  });

  test("fields=summary → includeEvents 强制 none + runSummaryView 投影", async () => {
    const deps = makeDeps();
    deps.listRuns.mockReturnValue([{ id: "r1" }, { id: "r2" }]);
    const result = await invoke("op:runs:list", { query: { fields: "summary" } }, deps);
    expect(deps.listRuns).toHaveBeenCalledWith(expect.objectContaining({ includeEvents: "none" }));
    expect(result).toEqual({ ok: true, status: 200, data: { runs: [{ summaryOf: "r1" }, { summaryOf: "r2" }] } });
  });

  test("includeEvents 合法值透传、非法值回 latest；summary 优先级高于显式 includeEvents", async () => {
    const deps = makeDeps();
    await invoke("op:runs:list", { query: { includeEvents: "all" } }, deps);
    expect(deps.listRuns).toHaveBeenLastCalledWith(expect.objectContaining({ includeEvents: "all" }));
    await invoke("op:runs:list", { query: { includeEvents: "bogus" } }, deps);
    expect(deps.listRuns).toHaveBeenLastCalledWith(expect.objectContaining({ includeEvents: "latest" }));
    await invoke("op:runs:list", { query: { includeEvents: "all", fields: "summary" } }, deps);
    expect(deps.listRuns).toHaveBeenLastCalledWith(expect.objectContaining({ includeEvents: "none" }));
  });
});

describe("S3-2 op:runs:get / step（server L3136-3140 / L3171-3175）", () => {
  test("get：命中 → { run }；未命中 → 404 run not found", async () => {
    const run = { id: "r1", status: "running" };
    const hit = makeDeps({ getRun: vi.fn(() => run) });
    expect(await invoke("op:runs:get", { params: { id: "r1" } }, hit)).toEqual({ ok: true, status: 200, data: { run } });
    const miss = makeDeps();
    expect(await invoke("op:runs:get", { params: { id: "r404" } }, miss)).toEqual({ ok: false, status: 404, data: { error: "run not found" } });
  });

  test("step：updateRunStep null → 404 run or step not found；命中 → { ok, run }（getRun 重取）", async () => {
    const miss = makeDeps();
    expect(await invoke("op:runs:step", { params: { id: "r1", stepId: "s1" }, body: { status: "completed" } }, miss))
      .toEqual({ ok: false, status: 404, data: { error: "run or step not found" } });
    expect(miss.updateRunStep).toHaveBeenCalledWith("r1", "s1", { status: "completed" });

    const run = { id: "r1" };
    const hit = makeDeps({ getRun: vi.fn(() => run), updateRunStep: vi.fn(() => ({ ok: true })) });
    const result = await invoke("op:runs:step", { params: { id: "r1", stepId: "s1" }, body: { status: "completed" } }, hit);
    expect(result).toEqual({ ok: true, status: 200, data: { ok: true, run } });
  });
});

describe("S3-2 op:runs:cancel（server L3142-3160）", () => {
  function runningRun(overrides: Record<string, unknown> = {}) {
    return { id: "r1", status: "running", clientId: "clientA", threadId: "threadB", sessionId: "sess1", actions: { canCancel: true }, ...overrides };
  }

  test("404 run not found", async () => {
    const result = await invoke("op:runs:cancel", { params: { id: "r404" } });
    expect(result).toEqual({ ok: false, status: 404, data: { error: "run not found" } });
  });

  test("canCancel=false → 409 任务当前状态不可取消：<status> + run 回显", async () => {
    const run = runningRun({ status: "completed", actions: { canCancel: false } });
    const deps = makeDeps({ getRun: vi.fn(() => run) });
    const result = await invoke("op:runs:cancel", { params: { id: "r1" } }, deps);
    expect(result).toEqual({ ok: false, status: 409, data: { error: "任务当前状态不可取消：completed", run } });
    expect(deps.requestRunCancellation).not.toHaveBeenCalled();
  });

  test("live.busy → manager.abort(key)，不动 finishRun；响应带 previous/stillQueued", async () => {
    const run = runningRun();
    const abort = vi.fn(async () => ({}));
    const deps = makeDeps({
      getRun: vi.fn(() => run),
      getManager: vi.fn(async () => ({ sessions: new Map([["clientA::threadB", { busy: true, queuedCount: 2 }]]), abort }))
    });
    const result = await invoke("op:runs:cancel", { params: { id: "r1" }, body: { reason: "不等了" } }, deps);
    expect(deps.requestRunCancellation).toHaveBeenCalledWith("r1", "不等了");
    expect(abort).toHaveBeenCalledWith("clientA::threadB");
    expect(deps.finishRun).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, status: 200, data: { ok: true, run, previous: { pending: true }, stillQueued: 2 } });
  });

  test("直调空态（S3-3 前 live 不存在）→ finishRun cancelled 固定参数 + stillQueued 0", async () => {
    const run = runningRun();
    const deps = makeDeps({ getRun: vi.fn(() => run) });
    const result = await invoke("op:runs:cancel", { params: { id: "r1" } }, deps);
    expect(deps.finishRun).toHaveBeenCalledWith("r1", { status: "cancelled", sessionId: "sess1", error: "任务在恢复前被取消", summary: "任务已取消" });
    expect(result).toEqual({ ok: true, status: 200, data: { ok: true, run, previous: { pending: true }, stillQueued: 0 } });
  });

  test("agentKey 键格式：threadId 为空退化为 client-only（默认 agentKeyOf，未注入）", async () => {
    const run = runningRun({ threadId: "" });
    const abort = vi.fn(async () => ({}));
    const deps = makeDeps({
      getRun: vi.fn(() => run),
      getManager: vi.fn(async () => ({ sessions: new Map([["clientA", { busy: true, queuedCount: 0 }]]), abort }))
    });
    await invoke("op:runs:cancel", { params: { id: "r1" } }, deps);
    expect(abort).toHaveBeenCalledWith("clientA");
  });

  test("reason 缺省 → 用户请求取消；abort 抛错 → 409 { error, run }", async () => {
    const run = runningRun();
    const deps = makeDeps({
      getRun: vi.fn(() => run),
      getManager: vi.fn(async () => ({ sessions: new Map([["clientA::threadB", { busy: true, queuedCount: 0 }]]), abort: vi.fn(async () => { throw new Error("中断失败"); }) }))
    });
    const result = await invoke("op:runs:cancel", { params: { id: "r1" } }, deps);
    expect(deps.requestRunCancellation).toHaveBeenCalledWith("r1", "用户请求取消");
    expect(result).toEqual({ ok: false, status: 409, data: { error: "中断失败", run } });
  });
});

describe("S3-2 op:runs:rollback（server L3162-3169）", () => {
  test("confirm!==true → 400 rollback requires confirm=true（confirm 400 校验在编排层）", async () => {
    const deps = makeDeps();
    expect(await invoke("op:runs:rollback", { params: { id: "r1" }, body: {} }, deps))
      .toEqual({ ok: false, status: 400, data: { error: "rollback requires confirm=true" } });
    expect(deps.rollbackRun).not.toHaveBeenCalled();
  });

  test("confirm=true → 先 awaitBeforeBlobs（reject 吞掉）再 rollbackRun(paths)；!ok → 400", async () => {
    const okDeps = makeDeps({ rollbackRun: vi.fn(() => ({ ok: true, restored: 3 })) });
    const okResult = await invoke("op:runs:rollback", { params: { id: "r1" }, body: { confirm: true, paths: ["a.txt"] } }, okDeps);
    expect(okDeps.awaitBeforeBlobs).toHaveBeenCalledWith("r1");
    expect(okDeps.rollbackRun).toHaveBeenCalledWith("r1", ["a.txt"]);
    expect(okResult).toEqual({ ok: true, status: 200, data: { ok: true, restored: 3 } });

    const swallowDeps = makeDeps({ awaitBeforeBlobs: vi.fn(async () => { throw new Error("blob 未就绪"); }) });
    const swallowResult = await invoke("op:runs:rollback", { params: { id: "r1" }, body: { confirm: true } }, swallowDeps);
    expect(swallowResult).toEqual({ ok: true, status: 200, data: { ok: true, restored: 2 } });

    const badDeps = makeDeps({ rollbackRun: vi.fn(() => ({ ok: false, error: "无法回滚" })) });
    const badResult = await invoke("op:runs:rollback", { params: { id: "r1" }, body: { confirm: true } }, badDeps);
    expect(badResult).toEqual({ ok: false, status: 400, data: { ok: false, error: "无法回滚" } });
  });
});

describe("S3-2 op:artifacts:list / publish / accept / rollback / acceptance（server L3177-3211）", () => {
  test("artifacts:list：cwd 哨兵 + projectId + limit parseInt||200", async () => {
    const deps = makeDeps({ normalizeWorkspace: vi.fn(() => null) });
    await invoke("op:artifacts:list", { query: { cwd: "X:\\无", projectId: "p1", limit: "7" } }, deps);
    expect(deps.listPublishedArtifacts).toHaveBeenCalledWith({ cwd: "__invalid_workspace__", projectId: "p1", limit: 7 });
    await invoke("op:artifacts:list", { query: { limit: "bogus" } }, deps);
    expect(deps.listPublishedArtifacts).toHaveBeenLastCalledWith({ cwd: "", projectId: "", limit: 200 });
  });

  test("publish：body.rules/operator 透传；!ok → fail(result.status || 400)", async () => {
    const deps = makeDeps({ publishArtifact: vi.fn(async () => ({ ok: false, status: 409, error: "产物验收失败" })) });
    const result = await invoke("op:runs:artifacts:publish", { params: { id: "r1", artifactId: "a1" }, body: { rules: { minPages: 2 }, operator: "测试员" } }, deps);
    expect(deps.publishArtifact).toHaveBeenCalledWith("r1", "a1", { rules: { minPages: 2 }, operator: "测试员" });
    expect(result).toEqual({ ok: false, status: 409, data: { ok: false, status: 409, error: "产物验收失败" } });
  });

  test("accept：note/operator/rules 透传", async () => {
    const deps = makeDeps();
    await invoke("op:runs:artifacts:accept", { params: { id: "r1", artifactId: "a1" }, body: { note: "ok", operator: "测试员", rules: {} } }, deps);
    expect(deps.confirmArtifactAcceptance).toHaveBeenCalledWith("r1", "a1", { note: "ok", operator: "测试员", rules: {} });
  });

  test("artifacts:rollback：confirm!==true → 400（路由层）；confirm → rollbackPublishedArtifact({ operator })", async () => {
    const miss = makeDeps();
    expect(await invoke("op:artifacts:rollback", { params: { publicationId: "p1" }, body: {} }, miss))
      .toEqual({ ok: false, status: 400, data: { error: "rollback requires confirm=true" } });
    expect(miss.rollbackPublishedArtifact).not.toHaveBeenCalled();

    const hit = makeDeps();
    const result = await invoke("op:artifacts:rollback", { params: { publicationId: "p1" }, body: { confirm: true, operator: "测试员" } }, hit);
    expect(hit.rollbackPublishedArtifact).toHaveBeenCalledWith("p1", { operator: "测试员" });
    expect(result).toEqual({ ok: true, status: 200, data: { ok: true, rolledBack: {} } });
  });

  test("acceptance：query.rules 非法 JSON → 400 固定文案；合法 → inspectRunAcceptance(id, rules)", async () => {
    const bad = makeDeps();
    expect(await invoke("op:runs:acceptance", { params: { id: "r1" }, query: { rules: "{broken" } }, bad))
      .toEqual({ ok: false, status: 400, data: { error: "rules 参数不是有效 JSON" } });
    expect(bad.inspectRunAcceptance).not.toHaveBeenCalled();

    const hit = makeDeps();
    const result = await invoke("op:runs:acceptance", { params: { id: "r1" }, query: { rules: "{\"minPages\":2}" } }, hit);
    expect(hit.inspectRunAcceptance).toHaveBeenCalledWith("r1", { minPages: 2 });
    expect(result).toEqual({ ok: true, status: 200, data: { ok: true, acceptance: { status: "passed" } } });

    const none = makeDeps();
    await invoke("op:runs:acceptance", { params: { id: "r1" } }, none);
    expect(none.inspectRunAcceptance).toHaveBeenCalledWith("r1", {});
  });
});

describe("S3-2 op:runs:diff（server L3243-3295）", () => {
  function changeRun(overrides: Record<string, unknown> = {}) {
    return {
      id: "r1",
      cwd: path.join(tmp, "ws"),
      artifacts: [{
        changeId: "ch1", artifactId: "art1", relativePath: "a.txt", changeType: "modified",
        confidence: "confirmed", source: "write-ledger", acceptanceStatus: "passed", verificationStatus: "passed",
        blobs: { before: true, after: true },
        before: { size: 3, hash: "h-before" }, after: { size: 6, hash: "h-after" },
        ...overrides
      }]
    };
  }

  function seedBlobs(relativePath: string, before: string, after: string) {
    fs.mkdirSync(path.join(tmp, "r1", "before", path.dirname(relativePath)), { recursive: true });
    fs.mkdirSync(path.join(tmp, "r1", "after", path.dirname(relativePath)), { recursive: true });
    fs.writeFileSync(path.join(tmp, "r1", "before", relativePath), before);
    fs.writeFileSync(path.join(tmp, "r1", "after", relativePath), after);
  }

  test("RUN_NOT_FOUND / CHANGE_NOT_FOUND：404 + code 错误体", async () => {
    expect(await invoke("op:runs:diff", { params: { id: "r404", changeId: "ch1" } }))
      .toEqual({ ok: false, status: 404, data: { ok: false, error: "run not found", code: "RUN_NOT_FOUND" } });
    const deps = makeDeps({ getRun: vi.fn(() => ({ id: "r1", cwd: "", artifacts: [] })) });
    expect(await invoke("op:runs:diff", { params: { id: "r1", changeId: "nope" } }, deps))
      .toEqual({ ok: false, status: 404, data: { ok: false, error: "该 Run 记录里没有这个变更", code: "CHANGE_NOT_FOUND" } });
  });

  test("changeId 与 artifactId 双键命中；before/after blob 真读 + 响应形状", async () => {
    seedBlobs("a.txt", "abc", "abcdef");
    const run = changeRun();
    const deps = makeDeps({ getRun: vi.fn(() => run) });
    const result = await invoke("op:runs:diff", { params: { id: "r1", changeId: "ch1" } }, deps);
    expect(result.ok).toBe(true);
    const data = (result as any).data;
    expect(data.change).toEqual({
      changeId: "ch1", relativePath: "a.txt", changeType: "modified", confidence: "confirmed",
      source: "write-ledger", blobs: { before: true, after: true },
      acceptanceStatus: "passed", verificationStatus: "passed"
    });
    expect(data.limits).toEqual({ maxInputBytes: 1_000_000, maxHunksPerPage: 50, inputTruncated: false });
    const diffArgs = deps.diffFileContents.mock.calls[0]![0];
    expect(diffArgs.relativePath).toBe("a.txt");
    expect(diffArgs.beforeBuffer.toString()).toBe("abc");
    expect(diffArgs.afterBuffer.toString()).toBe("abcdef");
    expect(diffArgs.before).toEqual({ size: 3, hash: "h-before" });
    expect(diffArgs.after).toEqual({ size: 6, hash: "h-after" });
    expect(diffArgs.page).toBe(0);
    // blob 文件存在时 size 取读到的真实值（blob 真读优先于 change.before/after 元数据）
    expect(data.diff).toEqual({ diff: "stub", hunks: [] });
  });

  test("after blob 缺失 → 工作区 fallback（isInside 内才读）；越界 → afterBuffer null", async () => {
    const ws = path.join(tmp, "ws2");
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, "a.txt"), "workspace-current");
    const run = changeRun({ cwd: ws, blobs: { before: false, after: false } });
    const deps = makeDeps({ getRun: vi.fn(() => run) });
    await invoke("op:runs:diff", { params: { id: "r1", changeId: "ch1" } }, deps);
    let args = deps.diffFileContents.mock.calls[0]![0];
    expect(args.afterBuffer.toString()).toBe("workspace-current");
    expect(args.beforeBuffer).toBeNull();

    const outsideRun = changeRun({ cwd: path.join(tmp, "elsewhere"), blobs: { before: false, after: false }, relativePath: "..\\escape.txt" });
    const outsideDeps = makeDeps({ getRun: vi.fn(() => outsideRun) });
    await invoke("op:runs:diff", { params: { id: "r1", changeId: "ch1" } }, outsideDeps);
    args = outsideDeps.diffFileContents.mock.calls[0]![0];
    expect(args.afterBuffer).toBeNull();
  });

  test("maxInputBytes 截断：读 maxInputBytes+1 字节 → inputTruncated true", async () => {
    seedBlobs("big.txt", "A".repeat(12), "B".repeat(12));
    const run = changeRun({ relativePath: "big.txt" });
    const deps = makeDeps({ getRun: vi.fn(() => run), diffLimits: { maxInputBytes: 4, maxHunksPerPage: 9 } });
    const result = await invoke("op:runs:diff", { params: { id: "r1", changeId: "ch1" } }, deps);
    const args = deps.diffFileContents.mock.calls[0]![0];
    expect(args.beforeBuffer).toHaveLength(5);
    expect(args.afterBuffer).toHaveLength(5);
    expect((result as any).data.limits).toEqual({ maxInputBytes: 4, maxHunksPerPage: 9, inputTruncated: true });
  });

  test("page 解析：parseInt 回退 0", async () => {
    seedBlobs("a.txt", "abc", "abcdef");
    const run = changeRun();
    const deps = makeDeps({ getRun: vi.fn(() => run) });
    await invoke("op:runs:diff", { params: { id: "r1", changeId: "ch1" }, query: { page: "3" } }, deps);
    expect(deps.diffFileContents).toHaveBeenLastCalledWith(expect.objectContaining({ page: 3 }));
    await invoke("op:runs:diff", { params: { id: "r1", changeId: "ch1" }, query: { page: "abc" } }, deps);
    expect(deps.diffFileContents).toHaveBeenLastCalledWith(expect.objectContaining({ page: 0 }));
  });
});

describe("S3-2 dispatcher 兜底", () => {
  test("处理器意外错误 → 500 { error }（对齐 http-forward 网络失败兜底形态）", async () => {
    const deps = makeDeps({ getRun: vi.fn(() => { throw new Error("boom"); }) });
    const result = await invoke("op:runs:get", { params: { id: "r1" } }, deps);
    expect(result).toEqual({ ok: false, status: 500, data: { error: "boom" } });
  });

  test("非 Error 抛出物 → String 化", async () => {
    const deps = makeDeps({ getRun: vi.fn(() => { throw "plain"; }) });
    const result = await invoke("op:runs:get", { params: { id: "r1" } }, deps);
    expect(result).toEqual({ ok: false, status: 500, data: { error: "plain" } });
  });
});
