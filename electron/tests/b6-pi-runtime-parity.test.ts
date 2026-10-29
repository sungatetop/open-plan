/**
 * B6-7 行为覆盖：pi-runtime-management（Pi Runtime 管理域全量转录）。
 *
 * R6-6b 对拍退役改写：旧侧 server/pi-runtime-management.mjs 动态 import 与双侧同流互等
 * 随 server 退役删除，仅保留 TS 侧断言（期望值此前已经双侧对拍固化，runtimeCapabilities
 * 等直接期望值自 TS 源推导）。
 *
 * 覆盖：
 *  - 模块级常量（PI_PACKAGE_VERSION/PI_COMPACTION_POLICY/runtimeCapabilities）+ SDK 构造器
 *    re-export 面 + 单例（piRuntimeManager/officeLimiter）+ contextTokensFromUsage 纯函数；
 *  - AsyncLimiter：直通/排队/FIFO/计数器/run 门控/limit 归一（0/负数/NaN/字符串）；
 *  - PiRuntimeManager 记录生命周期：beginRuntime/bindSession/update/markFailure（含
 *    code 白名单保留与 recovering 变体）/markRecovery/health/snapshot/listSnapshots/
 *    schedulerSnapshot/dispose/disposeAll/find；
 *  - runPrompt（steer 直通 vs limiter 排队/用户中断识别/失败标记/finally 收尾）+ abort
 *    （成功/中断形态/故障形态）+ isUserAbort 正则与 120s 窗口；
 *  - compact/setModel/setActiveTools/setThinkingLevel（成功登记 + 失败 markFailure 变体）/
 *    getContextUsage/getSessionTree/navigateSessionTree 容错族；
 *  - 网络：networkDiagnostics 回落形状/updateNetworkSettings（manual 代理脱敏）；
 *  - 持久化：运行时记录文件读写、markPersistedRuntimesRecovering（活跃态→recovering）、
 *    RUNTIME_RECORD_LIMIT=120 截断、重载恢复。
 *
 * 设计：
 *  - beforeAll 一次动态 import，import 前 stub OAW_DATA_DIR/OAW_RUNTIME_RECORD_FILE 等——
 *    模块级单例的 import 副作用（读网络设置/记录文件）全部落在临时目录；
 *  - vi.useFakeTimers({ toFake: ["Date"] }) 冻结时钟：now()/Date.now()（abortRequestedAt、
 *    120s 窗口、恢复链 at）确定化；runtimeId uuid 随机量经 stringMatching/字段级断言规避；
 *  - recordFile 用独立临时文件（mkdtemp），不触碰真实 .oaw；
 *  - modelRuntime/createSession/probeModel 依赖真实 Pi SDK ModelRuntime 与网络，不在覆盖
 *    范围（签名已按 AgentPiRuntimeSeam 核对；错误分类器 classifyPiError 已由
 *    b6-pi-network-proxy-parity 覆盖）。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type AnyMod = Record<string, any>;

let root = "";
let mod: AnyMod;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "b6-pi-rt-root-"));
  vi.stubEnv("OAW_DATA_DIR", path.join(root, "应用数据"));
  vi.stubEnv("OAW_LOCAL_PI_AGENT_DIR", "");
  vi.stubEnv("PI_AGENT_DIR", "");
  vi.stubEnv("APPDATA", path.join(root, "AppData", "Roaming"));
  vi.stubEnv("USERPROFILE", path.join(root, "主目录"));
  vi.stubEnv("OAW_RUNTIME_RECORD_FILE", path.join(root, "单例运行时记录.json"));
  vi.stubEnv("OAW_MAX_AGENT_RUNS", "");
  vi.stubEnv("OAW_MAX_OFFICECLI", "");
  vi.stubEnv("OAW_MODEL_NETWORK_MODE", "");
  mod = (await import("../src/main/backend/agent/pi-runtime")) as unknown as AnyMod;
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_700_000_000_000);
});

afterEach(() => {
  vi.useRealTimers();
});

/** 独立 recordFile 的实例（隔离持久化）。 */
function makeManager(options: any = {}): { m: AnyMod; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b6-pi-rt-"));
  const file = path.join(dir, "运行时记录.json");
  const m = new mod.PiRuntimeManager({ recordFile: file, ...options });
  return { m, file };
}

/** 带 seed 记录文件的实例（验证构造期 markPersistedRuntimesRecovering）。 */
function makeManagerWithSeed(seed: any[]): { m: AnyMod; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b6-pi-rt-seed-"));
  const file = path.join(dir, "运行时记录.json");
  fs.writeFileSync(file, JSON.stringify(seed, null, 2) + "\n", "utf8");
  const m = new mod.PiRuntimeManager({ recordFile: file });
  return { m, file };
}

describe("B6-7 模块级常量、re-export 面与单例", () => {
  it("PI_PACKAGE_VERSION / PI_COMPACTION_POLICY / runtimeCapabilities 逐值对齐且冻结", () => {
    expect(mod.PI_PACKAGE_VERSION).toBe("1.1.0");
    expect(mod.PI_COMPACTION_POLICY).toEqual({ reserveTokens: 16384, keepRecentTokens: 20000 });
    expect(Object.isFrozen(mod.PI_COMPACTION_POLICY)).toBe(true);
    expect(mod.runtimeCapabilities).toEqual({
      nativeFork: { status: "available", message: "会话树导航（navigateTree）已绑定工作台分支端点；文件级 fork 由会话树承载。" },
      nativeCheckpoint: { status: "unsupported", message: "当前没有 token 级检查点；使用 JSONL 会话重开 + 恢复提示词。" },
      replay: { status: "fallback", message: "支持从 JSONL 会话文件恢复，并由 Run 恢复链重新执行未完成目标。" },
    });
    expect(Object.isFrozen(mod.runtimeCapabilities)).toBe(true);
  });

  it("Pi SDK 构造器 re-export（agent 业务层统一取 Pi 依赖）", () => {
    const names = ["createBashToolDefinition", "createEditToolDefinition", "createLocalBashOperations", "createReadToolDefinition", "createWriteToolDefinition", "DefaultResourceLoader", "defineTool"];
    for (const name of names) {
      expect(typeof mod[name]).toBe("function");
    }
  });

  it("单例：piRuntimeManager/officeLimiter 构造与并发缺省（agent=2/officecli=1）", () => {
    expect(mod.piRuntimeManager instanceof mod.PiRuntimeManager).toBe(true);
    expect(mod.officeLimiter).toBe(mod.piRuntimeManager.officeLimiter);
    expect(mod.piRuntimeManager.schedulerSnapshot().agent).toMatchObject({ name: "agent", limit: 2, active: 0 });
    expect(mod.piRuntimeManager.schedulerSnapshot().officecli).toMatchObject({ name: "officecli", limit: 1, active: 0 });
  });

  it("contextTokensFromUsage：缺参/异常形状回落 null，合法 usage 走 SDK 原生计算", () => {
    const cases: Array<[unknown, number | null]> = [
      [null, null],
      [undefined, null],
      ["x", null],
      [42, null],
      [{}, null],
      [{ totalTokens: -1 }, null],
      [{ input: 100, output: 50, cacheRead: 10, cacheWrite: 5 }, 165],
      [{ totalTokens: 42 }, 42],
    ];
    for (const [input, expected] of cases) {
      expect(mod.contextTokensFromUsage(input)).toBe(expected);
    }
  });
});

describe("B6-7 AsyncLimiter 资源闸门", () => {
  it("直通获取与计数器：active/started/completed/queued 逐项对齐", async () => {
    const limiter = new mod.AsyncLimiter(2, "测试闸门");
    const release1 = await limiter.acquire({ job: 1 });
    expect(limiter.snapshot()).toMatchObject({ name: "测试闸门", limit: 2, active: 1, queued: 0, started: 1, completed: 0 });
    const second = limiter.acquire({ job: 2 });
    expect(limiter.snapshot()).toMatchObject({ active: 2, queued: 0, started: 2 });
    release1();
    await second;
    // #1 已释放（completed 1），#2 仍持有闸门（active 1）
    expect(limiter.snapshot()).toEqual({ name: "测试闸门", limit: 2, active: 1, queued: 0, started: 2, completed: 1 });
  });

  it("超限排队 FIFO：release 唤醒队首，metadata 保留", async () => {
    const limiter = new mod.AsyncLimiter(1, "q");
    const release1 = await limiter.acquire({ job: 1 });
    const p2 = limiter.acquire({ job: 2 });
    const p3 = limiter.acquire({ job: 3 });
    expect(limiter.snapshot()).toMatchObject({ active: 1, queued: 2, started: 1 });
    expect(limiter.queue.map((item: any) => item.metadata)).toEqual([{ job: 2 }, { job: 3 }]);
    release1();
    const resolved2 = await p2;
    expect(typeof resolved2).toBe("function");
    resolved2();
    // #3 仍持有闸门：started 3 / completed 2（release 才计数）
    expect(limiter.snapshot()).toMatchObject({ active: 1, queued: 0, started: 3, completed: 2 });
    const resolved3 = await p3;
    resolved3();
    expect(limiter.snapshot()).toMatchObject({ active: 0, queued: 0, started: 3, completed: 3 });
  });

  it("run()：结果透传 + finally 释放 + 门控串行", async () => {
    const limiter = new mod.AsyncLimiter(1, "run");
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const first = limiter.run(() => gate.then(() => "第一"));
    const second = limiter.run(() => "第二");
    open();
    expect(await first).toBe("第一");
    expect(await second).toBe("第二");
    expect(limiter.snapshot()).toMatchObject({ completed: 2, started: 2 });
  });

  it("run() 失败也释放：后续排队项可进入", async () => {
    const limiter = new mod.AsyncLimiter(1, "fail");
    const failed = limiter.run(async () => { throw new Error("炸了"); }).catch((error: any) => error.message);
    const next = limiter.run(() => "补位");
    expect(await failed).toBe("炸了");
    expect(await next).toBe("补位");
    expect(limiter.snapshot()).toMatchObject({ active: 0, queued: 0, completed: 2 });
  });

  it("limit 归一：0/负数/NaN/非数字回落 1，字符串数字可解析", () => {
    const cases: Array<[number | string, number]> = [[0, 1], [-3, 1], [Number.NaN, 1], ["abc", 1], ["3", 3], [5, 5]];
    for (const [limit, expected] of cases) {
      expect(new mod.AsyncLimiter(limit, "n").limit).toBe(expected);
    }
    expect(new mod.AsyncLimiter().name).toBe("resource");
    expect(new mod.AsyncLimiter().limit).toBe(1);
  });
});

describe("B6-7 PiRuntimeManager 记录生命周期", () => {
  it("beginRuntime：字段全对齐 + 持久化文件落盘", () => {
    const { m, file } = makeManager();
    const rec = m.beginRuntime({ key: "thread-1", clientId: "client-1", threadId: "t1", cwd: "D:\\工作区" });
    expect(rec.status).toBe("creating");
    expect(rec.profile).toBe("通用 Agent");
    expect(rec.toolPolicyVersion).toBe("task-tool-policy-v1");
    expect(rec.piPackageVersion).toBe("1.1.0");
    expect(rec.capabilities).toEqual(mod.runtimeCapabilities);
    expect(rec.networkMode).toBe(m.networkSettings.mode);
    expect(rec.health).toEqual({ status: "starting", checkedAt: null, message: null });
    const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ key: "thread-1", status: "creating" });
  });

  it("beginRuntime 同 key 二次登记 → recoveryChain 引用上一 runtime", () => {
    const { m } = makeManager();
    m.beginRuntime({ key: "k" });
    const rec = m.beginRuntime({ key: "k" });
    expect(rec.recoveryChain).toEqual([{ runtimeId: expect.stringMatching(/^runtime_/), reason: "previous_runtime" }]);
    const other = m.beginRuntime({ key: "其他" });
    expect(other.recoveryChain).toEqual([]);
  });

  it("bindSession：快照 model/登记 profile 与工具策略；缺省回落", () => {
    const { m } = makeManager();
    const model = { provider: "测试商", id: "模型A", name: "模型A名", contextWindow: 128000.9, reasoning: true, vision: false, limit: { context: 999 } };
    const rec = m.beginRuntime({ key: "k" });
    const bound = m.bindSession(rec.runtimeId, { session: { sessionId: "sess-1", model } });
    expect(bound.status).toBe("idle");
    expect(bound.sessionId).toBe("sess-1");
    expect(bound.provider).toBe("测试商");
    expect(bound.model).toEqual({ provider: "测试商", id: "模型A", name: "模型A名", reasoning: true, vision: false, contextWindow: 128000 });
    // 缺省：profile/toolPolicy/toolPolicyVersion 保留 beginRuntime 值
    const kept = m.bindSession(rec.runtimeId, {});
    expect(kept.profile).toBe("通用 Agent");
    // 覆写：profile/toolPolicy 生效
    const overridden = m.bindSession(rec.runtimeId, { profile: "审校 Agent", toolPolicyVersion: "v2", toolPolicy: { tools: ["read"] } });
    expect(overridden.profile).toBe("审校 Agent");
  });

  it("update：patch 合并 + model 再快照（contextLength 变体 → contextWindow）", () => {
    const { m } = makeManager();
    const rec = m.beginRuntime({});
    const updated = m.update(rec.runtimeId, { status: "running", customField: "x", model: { provider: "p2", id: "m2", name: "n2", contextLength: 4096.7 } });
    expect(updated.model).toEqual({ provider: "p2", id: "m2", name: "n2", reasoning: false, vision: false, contextWindow: 4096 });
    expect(updated.customField).toBe("x");
    expect(m.update("不存在", { status: "x" })).toBe(null);
  });

  it("markFailure：分类落账 + code 白名单保留 + recovering 变体", () => {
    const { m } = makeManager();
    const rec = m.beginRuntime({ key: "k" });
    const generic = m.markFailure(rec.runtimeId, new Error("boom"));
    expect(generic.status).toBe("failed");
    expect(generic.health.status).toBe("failed");
    expect(generic.error.code).toBe(generic.errorCategory);
    expect(generic.error.message).toContain("boom");
    expect(typeof generic.error.retryable).toBe("boolean");
    expect(generic.recoveryChain.at(-1)).toEqual({ at: new Date().toISOString(), reason: "runtime_error", status: "failed" });
    // code 白名单（MODEL_TIMEOUT）保留原始 code
    const timeout = m.markFailure(rec.runtimeId, Object.assign(new Error("超时"), { code: "MODEL_TIMEOUT" }));
    expect(timeout.error.code).toBe("MODEL_TIMEOUT");
    // recovering 变体
    const recovering = m.markFailure(rec.runtimeId, new Error("再炸"), { recovering: true, reason: "自定义原因" });
    expect(recovering.status).toBe("recovering");
    expect(recovering.health.status).toBe("degraded");
    expect(m.markFailure("不存在", new Error("x"))).toBe(null);
  });

  it("markRecovery：状态/健康/恢复链", () => {
    const { m } = makeManager();
    const rec = m.beginRuntime({});
    const recovered = m.markRecovery(rec.runtimeId);
    expect(recovered.status).toBe("recovering");
    expect(recovered.health).toEqual({ status: "degraded", checkedAt: new Date().toISOString(), message: "等待恢复入口" });
    expect(recovered.recoveryChain.at(-1)).toEqual({ at: new Date().toISOString(), reason: "manual_recovery", status: "recovering" });
    expect(m.markRecovery("不存在")).toBe(null);
  });

  it("health：流式/空闲/失败三态 + scheduler 附带 + 快照净化", () => {
    const { m } = makeManager();
    const rec = m.beginRuntime({ key: "k" });
    // 流式 → running
    const streaming = m.health(rec.runtimeId, { isStreaming: true, sessionId: "s9", model: { provider: "p", id: "m" } });
    expect(streaming.health.status).toBe("running");
    expect(streaming.status).toBe("running");
    expect(streaming.scheduler).toEqual(m.agentLimiter.snapshot());
    // 空闲 → healthy
    const idle = m.health(rec.runtimeId, { isStreaming: false, isIdle: true });
    expect(idle.health.status).toBe("healthy");
    // 不空闲不流式 → degraded / 记录 idle
    const busy = m.health(rec.runtimeId, { isStreaming: false, isIdle: false });
    expect(busy.health.status).toBe("degraded");
    expect(busy.status).toBe("idle");
    // failed 记录保持 failed
    m.markFailure(rec.runtimeId, new Error("boom"));
    const failed = m.health(rec.runtimeId, { isStreaming: false, isIdle: true });
    expect(failed.status).toBe("failed");
    expect(failed.health.status).toBe("failed");
    // overrides 合并 + 缺记录
    expect(m.health("不存在", {})).toBe(null);
    const overridden = m.health(rec.runtimeId, {}, { customOverride: 1 });
    expect(overridden.customOverride).toBe(1);
  });

  it("snapshot/listSnapshots：覆盖合并 + capabilities 缺省 + 倒序", () => {
    const { m } = makeManager();
    const first = m.beginRuntime({ key: "a" });
    m.beginRuntime({ key: "b" });
    expect(m.snapshot(first.runtimeId, { status: "custom" }).status).toBe("custom");
    expect(m.snapshot(first.runtimeId).capabilities).toEqual(mod.runtimeCapabilities);
    expect(m.snapshot("不存在")).toBe(null);
    expect(m.listSnapshots().map((item: any) => item.key)).toEqual(["b", "a"]);
  });

  it("schedulerSnapshot：agent/officecli 双闸门快照", () => {
    const { m } = makeManager({ agentConcurrency: 3, officeConcurrency: "4" });
    expect(m.schedulerSnapshot()).toEqual({
      agent: { name: "agent", limit: 3, active: 0, queued: 0, started: 0, completed: 0 },
      officecli: { name: "officecli", limit: 4, active: 0, queued: 0, started: 0, completed: 0 },
    });
  });

  it("dispose/disposeAll：会话释放 + 状态落账 + 适配器关闭 + 失败也落 disposed", () => {
    const { m } = makeManager();
    const rec = m.beginRuntime({});
    const dispose = vi.fn();
    m.dispose(rec.runtimeId, { dispose });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(m.find(rec.runtimeId).status).toBe("disposed");
    expect(m.find(rec.runtimeId).health).toEqual({ status: "stopped", checkedAt: new Date().toISOString(), message: null });
    // dispose 抛错 → markFailure(dispose_failed) 后仍落 disposed
    const rec2 = m.beginRuntime({});
    m.dispose(rec2.runtimeId, { dispose: () => { throw new Error("释放失败"); } });
    expect(m.find(rec2.runtimeId).status).toBe("disposed");
    expect(m.find(rec2.runtimeId).errorCategory).toBeTruthy();
    // disposeAll：批量 dispose + 关闭适配器
    const close = vi.fn();
    (m as any).networkAdapterInstance = { close };
    m.disposeAll([{ runtimeId: rec.runtimeId, session: null }, { runtimeId: rec2.runtimeId, session: null }]);
    expect(close).toHaveBeenCalledTimes(1);
    expect((m as any).networkAdapterInstance).toBe(null);
  });

  it("find：命中/未命中", () => {
    const { m } = makeManager();
    const rec = m.beginRuntime({});
    expect(m.find(rec.runtimeId)).not.toBe(null);
    expect(m.find("nope")).toBe(null);
  });
});

describe("B6-7 runPrompt / abort / isUserAbort", () => {
  it("runPrompt steer=false：经 agentLimiter 排队串行，成功后落 idle", async () => {
    const { m } = makeManager({ agentConcurrency: 1 });
    const rec = m.beginRuntime({});
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const first = m.runPrompt(rec.runtimeId, () => gate.then(() => "r1"));
    // 第二条进队列
    const queued = m.runPrompt(rec.runtimeId, () => "r2");
    expect(m.find(rec.runtimeId).status).toBe("queued");
    expect(m.agentLimiter.snapshot().queued).toBe(1);
    open();
    expect(await first).toBe("r1");
    expect(await queued).toBe("r2");
    expect(m.find(rec.runtimeId).status).toBe("idle");
    expect(m.find(rec.runtimeId).health.status).toBe("healthy");
    expect(m.agentLimiter.snapshot().started).toBe(2);
  });

  it("runPrompt steer=true：绕过闸门直通 running", async () => {
    const { m } = makeManager();
    const rec = m.beginRuntime({});
    const result = await m.runPrompt(rec.runtimeId, async () => "直通", { steer: true });
    expect(result).toBe("直通");
    expect(m.agentLimiter.snapshot().started).toBe(0);
    expect(m.find(rec.runtimeId).status).toBe("idle");
  });

  it("runPrompt 失败：markFailure(failed) + 重抛；用户中断形态落 idle + user_abort 链", async () => {
    const { m } = makeManager();
    const rec = m.beginRuntime({});
    await expect(m.runPrompt(rec.runtimeId, async () => { throw new Error("普通故障"); })).rejects.toThrow("普通故障");
    expect(m.find(rec.runtimeId).status).toBe("failed");
    expect(m.find(rec.runtimeId).recoveryChain.at(-1).reason).toBe("runtime_error");
    // 先 abort 打中断标记（abort 正常收尾 → idle），随后 prompt 以 Request aborted 拒绝
    await m.abort(rec.runtimeId, { abort: async () => {} });
    await expect(m.runPrompt(rec.runtimeId, async () => { throw new Error("Request aborted"); })).rejects.toThrow("Request aborted");
    expect(m.find(rec.runtimeId).status).toBe("idle");
    expect(m.find(rec.runtimeId).error).toBe(null);
    expect(m.find(rec.runtimeId).recoveryChain.at(-1)).toEqual({ at: new Date().toISOString(), reason: "user_abort", status: "idle" });
  });

  it("abort：成功落 idle；中断形态吞错落 idle；故障形态 markFailure(abort_failed) 重抛", async () => {
    const { m } = makeManager();
    const rec = m.beginRuntime({});
    // 成功：aborting → idle，中断标记已打
    await m.abort(rec.runtimeId, { abort: async () => {} });
    expect(m.find(rec.runtimeId).status).toBe("idle");
    expect(typeof m.find(rec.runtimeId).abortRequestedAt).toBe("number");
    // 中断形态：session.abort 以 Request aborted 拒绝 → 吞错，落 idle + error 清空
    const rec2 = m.beginRuntime({});
    await m.abort(rec2.runtimeId, { abort: async () => { throw new Error("Request aborted by user"); } });
    expect(m.find(rec2.runtimeId).status).toBe("idle");
    expect(m.find(rec2.runtimeId).error).toBe(null);
    // 故障形态：非中断错误 → 重抛 + markFailure(abort_failed)
    const rec3 = m.beginRuntime({});
    await expect(m.abort(rec3.runtimeId, { abort: async () => { throw new Error("断开失败"); } })).rejects.toThrow("断开失败");
    expect(m.find(rec3.runtimeId).status).toBe("failed");
    expect(m.find(rec3.runtimeId).recoveryChain.at(-1).reason).toBe("abort_failed");
    // session 为 null/缺 abort 方法也不炸
    await m.abort(rec.runtimeId, null);
    await m.abort(rec.runtimeId, {});
  });

  it("isUserAbort：中断标记 + 形态正则 + 120s 窗口", () => {
    const { m } = makeManager();
    const rec = m.beginRuntime({});
    const record = m.find(rec.runtimeId);
    // 无标记 → false
    expect(m.isUserAbort(record, new Error("Request aborted"))).toBe(false);
    // aborting 状态即视为已请求，但消息形态必须匹配
    record.status = "aborting";
    expect(m.isUserAbort(record, new Error("Request aborted"))).toBe(true);
    expect(m.isUserAbort(record, new Error("普通故障"))).toBe(false);
    // abortRequestedAt 新鲜窗口（冻结时钟差值 0 < 120000）
    record.status = "idle";
    record.abortRequestedAt = Date.now();
    for (const message of ["Request aborted", "aborted", "task aborting", "cancelled", "canceled", "interrupted", "用户请求中断", "已中断", "已取消"]) {
      expect(m.isUserAbort(record, { message })).toBe(true);
    }
    expect(m.isUserAbort(record, { cause: { message: "Request aborted" } })).toBe(true);
    // 过期窗口（200s 前）
    record.abortRequestedAt = Date.now() - 200000;
    expect(m.isUserAbort(record, new Error("Request aborted"))).toBe(false);
    // 无记录 → false
    expect(m.isUserAbort(null, new Error("Request aborted"))).toBe(false);
    expect(m.isUserAbort(undefined, new Error("Request aborted"))).toBe(false);
  });
});

describe("B6-7 compact / setModel / setActiveTools / setThinkingLevel / 上下文与树", () => {
  it("compact：成功透传结果 + compacting 中间态；失败 markFailure(recovering) 重抛", async () => {
    const { m } = makeManager();
    const rec = m.beginRuntime({});
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const compacting = m.compact(rec.runtimeId, { compact: () => gate.then(() => ({ ok: true })) }, "压缩指令");
    expect(m.find(rec.runtimeId).status).toBe("compacting");
    open();
    expect(await compacting).toEqual({ ok: true });
    expect(m.find(rec.runtimeId).status).toBe("idle");
    // 空指令 → undefined 透传给 session.compact
    const received: Array<unknown> = [];
    await m.compact(rec.runtimeId, { compact: (instructions: unknown) => { received.push(instructions); return "空"; } });
    expect(received).toEqual([undefined]);
    // 失败
    await expect(m.compact(rec.runtimeId, { compact: async () => { throw new Error("压缩失败"); } })).rejects.toThrow("压缩失败");
    expect(m.find(rec.runtimeId).status).toBe("recovering");
    expect(m.find(rec.runtimeId).recoveryChain.at(-1).reason).toBe("compact_failed");
  });

  it("setModel：成功登记 provider/model 快照；失败 markFailure(model_switch_failed)", async () => {
    const { m } = makeManager();
    const rec = m.beginRuntime({});
    const model = { provider: "测试商", id: "模型B", name: "模型B名", contextWindow: 32000 };
    await m.setModel(rec.runtimeId, { setModel: async () => {} }, model);
    expect(m.find(rec.runtimeId).provider).toBe("测试商");
    expect(m.find(rec.runtimeId).model).toEqual({ provider: "测试商", id: "模型B", name: "模型B名", reasoning: false, vision: false, contextWindow: 32000 });
    expect(m.find(rec.runtimeId).status).toBe("idle");
    await expect(m.setModel(rec.runtimeId, { setModel: async () => { throw new Error("切换失败"); } }, model)).rejects.toThrow("切换失败");
    expect(m.find(rec.runtimeId).recoveryChain.at(-1).reason).toBe("model_switch_failed");
  });

  it("setActiveTools：去重登记 toolPolicy；失败 markFailure(tool_policy_apply_failed)", () => {
    const { m } = makeManager();
    const rec = m.beginRuntime({});
    m.setActiveTools(rec.runtimeId, { setActiveToolsByName: () => {} }, ["b", "a", "b"]);
    expect(m.find(rec.runtimeId).toolPolicy).toEqual({ tools: ["b", "a"] });
    // 非数组 → 空集
    m.setActiveTools(rec.runtimeId, { setActiveToolsByName: () => {} }, "不是数组");
    expect(m.find(rec.runtimeId).toolPolicy).toEqual({ tools: [] });
    // 失败
    expect(() => m.setActiveTools(rec.runtimeId, { setActiveToolsByName: () => { throw new Error("工具失败"); } }, [])).toThrow("工具失败");
    expect(m.find(rec.runtimeId).recoveryChain.at(-1).reason).toBe("tool_policy_apply_failed");
  });

  it("setThinkingLevel：成功登记；失败 markFailure(thinking_level_apply_failed)", () => {
    const { m } = makeManager();
    const rec = m.beginRuntime({});
    m.setThinkingLevel(rec.runtimeId, { setThinkingLevel: () => {} }, "high");
    expect(m.find(rec.runtimeId).thinkingLevel).toBe("high");
    expect(() => m.setThinkingLevel(rec.runtimeId, { setThinkingLevel: () => { throw new Error("档位失败"); } }, "high")).toThrow("档位失败");
    expect(m.find(rec.runtimeId).recoveryChain.at(-1).reason).toBe("thinking_level_apply_failed");
  });

  it("getContextUsage / getSessionTree：缺函数/异常回落 null，正常透传", () => {
    const { m } = makeManager();
    const rec = m.beginRuntime({});
    const usage = { input: 1, output: 2 };
    const tree = [{ id: "root" }];
    const usageCases: Array<[any, unknown]> = [
      [null, null],
      [{}, null],
      [{ getContextUsage: () => usage }, usage],
      [{ getContextUsage: () => { throw new Error("x"); } }, null],
    ];
    for (const [session, expected] of usageCases) {
      expect(m.getContextUsage(rec.runtimeId, session)).toEqual(expected);
    }
    const treeCases: Array<[any, unknown]> = [
      [null, null],
      [{}, null],
      [{ getTree: () => tree }, tree],
      [{ getTree: () => { throw new Error("x"); } }, null],
    ];
    for (const [sessionManager, expected] of treeCases) {
      expect(m.getSessionTree(rec.runtimeId, sessionManager)).toEqual(expected);
    }
  });

  it("navigateSessionTree：不支持时中文报错；支持时透传 String(targetId) 与 options", async () => {
    const { m } = makeManager();
    const rec = m.beginRuntime({});
    await expect(m.navigateSessionTree(rec.runtimeId, {}, "n1", {})).rejects.toThrow("当前 Pi 会话不支持会话树导航（navigateTree 不可用）");
    const calls: Array<unknown[]> = [];
    const options = { summarize: true, label: "分支" };
    await m.navigateSessionTree(rec.runtimeId, { navigateTree: (...callArgs: unknown[]) => { calls.push(callArgs); return "ok"; } }, "n1", options);
    expect(calls).toEqual([["n1", options]]);
    // targetId 空值 → String("" || "") = ""
    await m.navigateSessionTree(rec.runtimeId, { navigateTree: (...callArgs: unknown[]) => { calls.push(callArgs); } }, null, {});
    expect(calls.at(-1)).toEqual(["", {}]);
  });
});

describe("B6-7 网络诊断与设置更新", () => {
  it("networkDiagnostics：未建适配器时回落形状", () => {
    const { m } = makeManager();
    expect(m.networkDiagnostics()).toMatchObject({ mode: "direct", closed: false, hasProxy: false });
  });

  it("updateNetworkSettings：manual 代理脱敏 + 旧适配器关闭 + 记录切换", () => {
    const { m } = makeManager();
    const close = vi.fn();
    (m as any).networkAdapterInstance = { close };
    const diagnostics = m.updateNetworkSettings({ mode: "manual", proxyUrl: "http://user:secret@proxy:8080" });
    expect(close).toHaveBeenCalledTimes(1);
    expect(diagnostics.mode).toBe("manual");
    expect(diagnostics.hasProxy).toBe(true);
    expect(String(diagnostics.proxy)).not.toContain("secret");
    expect(m.networkSettings.mode).toBe("manual");
    // 空参数 → loadNetworkSettings 缺省（临时目录无网络代理.json → direct）
    m.updateNetworkSettings();
    expect((m as any).networkAdapterInstance).toBe(null);
  });
});

describe("B6-7 持久化与恢复", () => {
  it("markPersistedRuntimesRecovering：构造时把活跃态标记 recovering 并回写", () => {
    const seed = [
      { version: 1, runtimeId: "runtime_old_running", key: "k1", status: "running", health: { status: "healthy", checkedAt: null, message: null }, recoveryChain: [] },
      { version: 1, runtimeId: "runtime_old_failed", key: "k2", status: "failed", health: { status: "failed", checkedAt: null, message: null }, recoveryChain: [] },
    ];
    const { m, file } = makeManagerWithSeed(seed);
    expect(m.find("runtime_old_running").status).toBe("recovering");
    expect(m.find("runtime_old_running").health).toEqual({ status: "degraded", checkedAt: new Date().toISOString(), message: "服务重启后等待显式恢复" });
    expect(m.find("runtime_old_running").recoveryChain).toEqual([{ at: new Date().toISOString(), reason: "process_restart", status: "recovering" }]);
    expect(m.find("runtime_old_failed").status).toBe("failed");
    const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(persisted.map((record: any) => record.status)).toEqual(["recovering", "failed"]);
  });

  it("RUNTIME_RECORD_LIMIT=120：records 与持久化文件截断到最近 120 条", () => {
    const { m, file } = makeManager();
    for (let i = 0; i < 130; i += 1) {
      m.beginRuntime({ key: `k${i}` });
    }
    expect(m.records.length).toBe(120);
    const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(persisted.length).toBe(120);
    expect(persisted[0].key).toBe("k10");
  });

  it("重载：另一实例读取同一记录文件（creating → recovering）", () => {
    const { m, file } = makeManager();
    const created = m.beginRuntime({ key: "重载" });
    const reloaded = new mod.PiRuntimeManager({ recordFile: file });
    expect(reloaded.find(created.runtimeId)).not.toBe(null);
    expect(reloaded.find(created.runtimeId).status).toBe("recovering");
  });
});
