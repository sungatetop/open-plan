/**
 * B6-7 对拍：旧 server JS ↔ 新 electron TS（pi-runtime-management 全量转录）。
 *
 * 覆盖（旧 pi-runtime-management.mjs 668 行）：
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
 *  - 双侧动态 import（beforeAll 一次），import 前stub OAW_DATA_DIR/OAW_RUNTIME_RECORD_FILE
 *    等——两侧模块级单例的 import 副作用（读网络设置/记录文件）全部落在临时目录；
 *  - vi.useFakeTimers({ toFake: ["Date"] }) 冻结时钟：now()/Date.now()（abortRequestedAt、
 *    120s 窗口）双侧一致；runtimeId uuid 随机量经 normalizeRecord 归一后 deep-equal；
 *  - recordFile 逐侧独立临时文件（mkdtemp），不触碰真实 .oaw；
 *  - modelRuntime/createSession/probeModel 依赖真实 Pi SDK ModelRuntime 与网络，不在对拍
 *    范围（签名已按 AgentPiRuntimeSeam 核对；错误分类器 classifyPiError 已由
 *    b6-pi-network-proxy-parity 覆盖）。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type AnyMod = Record<string, any>;

let root = "";
let old: AnyMod;
let nw: AnyMod;

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
  old = (await import("../../server/pi-runtime-management.mjs")) as unknown as AnyMod;
  nw = (await import("../src/main/backend/agent/pi-runtime")) as unknown as AnyMod;
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

/** runtimeId 及恢复链引用归一（uuid 双侧随机）。 */
function normalizeRecord(record: any): any {
  if (!record || typeof record !== "object") return record;
  const clone = JSON.parse(JSON.stringify(record));
  if (typeof clone.runtimeId === "string" && clone.runtimeId.startsWith("runtime_")) clone.runtimeId = "<RID>";
  if (Array.isArray(clone.recoveryChain)) {
    clone.recoveryChain = clone.recoveryChain.map((item: any) => (
      typeof item?.runtimeId === "string" && item.runtimeId.startsWith("runtime_") ? { ...item, runtimeId: "<RID>" } : item
    ));
  }
  return clone;
}

function expectSameRecords(oldM: any, nwM: any): void {
  expect(oldM.records.map(normalizeRecord)).toEqual(nwM.records.map(normalizeRecord));
}

function expectSameFiles(oldFile: string, nwFile: string): void {
  const a = JSON.parse(fs.readFileSync(oldFile, "utf8")).map(normalizeRecord);
  const b = JSON.parse(fs.readFileSync(nwFile, "utf8")).map(normalizeRecord);
  expect(a).toEqual(b);
}

/** 每侧独立 recordFile 的实例对（相同构造参数，隔离持久化）。 */
function makeManagers(options: any = {}): { oldM: any; nwM: any; oldFile: string; nwFile: string } {
  const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), "b6-pi-rt-old-"));
  const nwDir = fs.mkdtempSync(path.join(os.tmpdir(), "b6-pi-rt-nw-"));
  const oldFile = path.join(oldDir, "运行时记录.json");
  const nwFile = path.join(nwDir, "运行时记录.json");
  const oldM = new old.PiRuntimeManager({ recordFile: oldFile, ...options });
  const nwM = new nw.PiRuntimeManager({ recordFile: nwFile, ...options });
  return { oldM, nwM, oldFile, nwFile };
}

describe("B6-7 模块级常量、re-export 面与单例", () => {
  it("PI_PACKAGE_VERSION / PI_COMPACTION_POLICY / runtimeCapabilities 逐值对齐且冻结", () => {
    expect(old.PI_PACKAGE_VERSION).toBe("1.1.0");
    expect(nw.PI_PACKAGE_VERSION).toBe(old.PI_PACKAGE_VERSION);
    expect(nw.PI_COMPACTION_POLICY).toEqual(old.PI_COMPACTION_POLICY);
    expect(nw.PI_COMPACTION_POLICY).toEqual({ reserveTokens: 16384, keepRecentTokens: 20000 });
    expect(Object.isFrozen(nw.PI_COMPACTION_POLICY)).toBe(true);
    expect(Object.isFrozen(old.PI_COMPACTION_POLICY)).toBe(true);
    expect(nw.runtimeCapabilities).toEqual(old.runtimeCapabilities);
    expect(Object.isFrozen(nw.runtimeCapabilities)).toBe(true);
  });

  it("Pi SDK 构造器 re-export 与旧模块同一实例（agent 业务层统一取 Pi 依赖）", () => {
    const names = ["createBashToolDefinition", "createEditToolDefinition", "createLocalBashOperations", "createReadToolDefinition", "createWriteToolDefinition", "DefaultResourceLoader", "defineTool"];
    for (const name of names) {
      expect(typeof nw[name]).toBe(typeof old[name]);
      expect(nw[name]).toBe(old[name]);
    }
  });

  it("单例：piRuntimeManager/officeLimiter 构造与并发缺省（agent=2/officecli=1）双侧一致", () => {
    expect(old.piRuntimeManager instanceof old.PiRuntimeManager).toBe(true);
    expect(nw.piRuntimeManager instanceof nw.PiRuntimeManager).toBe(true);
    expect(nw.officeLimiter).toBe(nw.piRuntimeManager.officeLimiter);
    expect(nw.piRuntimeManager.schedulerSnapshot()).toEqual(old.piRuntimeManager.schedulerSnapshot());
    expect(nw.piRuntimeManager.schedulerSnapshot().agent).toMatchObject({ name: "agent", limit: 2, active: 0 });
    expect(nw.piRuntimeManager.schedulerSnapshot().officecli).toMatchObject({ name: "officecli", limit: 1, active: 0 });
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
    for (const [input] of cases) {
      expect(nw.contextTokensFromUsage(input)).toBe(old.contextTokensFromUsage(input));
    }
    expect(nw.contextTokensFromUsage({ input: 100, output: 50, cacheRead: 10, cacheWrite: 5 })).toBe(165);
    expect(nw.contextTokensFromUsage({ totalTokens: 42 })).toBe(42);
  });
});

describe("B6-7 AsyncLimiter 资源闸门", () => {
  it("直通获取与计数器：active/started/completed/queued 逐项对齐", async () => {
    const a = new old.AsyncLimiter(2, "测试闸门");
    const b = new nw.AsyncLimiter(2, "测试闸门");
    const ra = await a.acquire({ job: 1 });
    const rb = await b.acquire({ job: 1 });
    expect(a.snapshot()).toEqual(b.snapshot());
    const secondA = a.acquire({ job: 2 });
    const secondB = b.acquire({ job: 2 });
    expect(a.snapshot()).toEqual(b.snapshot());
    ra();
    rb();
    await Promise.all([secondA, secondB]);
    expect(a.snapshot()).toEqual(b.snapshot());
    // #1 已释放（completed 1），#2 仍持有闸门（active 1）
    expect(b.snapshot()).toEqual({ name: "测试闸门", limit: 2, active: 1, queued: 0, started: 2, completed: 1 });
  });

  it("超限排队 FIFO：release 唤醒队首，metadata 保留", async () => {
    const a = new old.AsyncLimiter(1, "q");
    const b = new nw.AsyncLimiter(1, "q");
    const ra = await a.acquire({ job: 1 });
    const rb = await b.acquire({ job: 1 });
    const pa = a.acquire({ job: 2 });
    const pb = b.acquire({ job: 2 });
    const qa = a.acquire({ job: 3 });
    const qb = b.acquire({ job: 3 });
    expect(a.snapshot()).toEqual(b.snapshot());
    expect(b.snapshot()).toMatchObject({ active: 1, queued: 2, started: 1 });
    expect(b.queue.map((item: any) => item.metadata)).toEqual([{ job: 2 }, { job: 3 }]);
    expect(a.queue.map((item: any) => item.metadata)).toEqual(b.queue.map((item: any) => item.metadata));
    ra();
    const resolvedA = await pa;
    rb();
    const resolvedB = await pb;
    expect(typeof resolvedA).toBe("function");
    expect(typeof resolvedB).toBe("function");
    resolvedA();
    resolvedB();
    expect(a.snapshot()).toEqual(b.snapshot());
    // #3 仍持有闸门：started 3 / completed 2（release 才计数）
    expect(b.snapshot()).toMatchObject({ active: 1, queued: 0, started: 3, completed: 2 });
    const resolvedQa = await qa;
    const resolvedQb = await qb;
    resolvedQa();
    resolvedQb();
    expect(a.snapshot()).toEqual(b.snapshot());
    expect(b.snapshot()).toMatchObject({ active: 0, queued: 0, started: 3, completed: 3 });
  });

  it("run()：结果透传 + finally 释放 + 门控串行", async () => {
    const a = new old.AsyncLimiter(1, "run");
    const b = new nw.AsyncLimiter(1, "run");
    let openA: () => void = () => {};
    let openB: () => void = () => {};
    const gateA = new Promise<void>((resolve) => { openA = resolve; });
    const gateB = new Promise<void>((resolve) => { openB = resolve; });
    const pa = a.run(() => gateA.then(() => "第一"));
    const pb = b.run(() => gateB.then(() => "第一"));
    const sa = a.run(() => "第二");
    const sb = b.run(() => "第二");
    openA();
    openB();
    expect(await pa).toBe("第一");
    expect(await pb).toBe("第一");
    expect(await sa).toBe("第二");
    expect(await sb).toBe("第二");
    expect(a.snapshot()).toEqual(b.snapshot());
    expect(b.snapshot()).toMatchObject({ completed: 2, started: 2 });
  });

  it("run() 失败也释放：后续排队项可进入", async () => {
    const b = new nw.AsyncLimiter(1, "fail");
    const a = new old.AsyncLimiter(1, "fail");
    const pa = a.run(async () => { throw new Error("炸了"); }).catch((error: any) => error.message);
    const pb = b.run(async () => { throw new Error("炸了"); }).catch((error: any) => error.message);
    const sa = a.run(() => "补位");
    const sb = b.run(() => "补位");
    expect(await pa).toBe("炸了");
    expect(await pb).toBe("炸了");
    expect(await sa).toBe("补位");
    expect(await sb).toBe("补位");
    expect(a.snapshot()).toEqual(b.snapshot());
    expect(b.snapshot()).toMatchObject({ active: 0, queued: 0, completed: 2 });
  });

  it("limit 归一：0/负数/NaN/非数字回落 1，字符串数字可解析", () => {
    const cases: Array<[number | string, number]> = [[0, 1], [-3, 1], [Number.NaN, 1], ["abc", 1], ["3", 3], [5, 5]];
    for (const [limit, expected] of cases) {
      const a = new old.AsyncLimiter(limit, "n");
      const b = new nw.AsyncLimiter(limit, "n");
      expect(b.limit).toBe(a.limit);
      expect(b.limit).toBe(expected);
    }
    expect(new nw.AsyncLimiter().name).toBe("resource");
    expect(new nw.AsyncLimiter().limit).toBe(1);
  });
});

describe("B6-7 PiRuntimeManager 记录生命周期", () => {
  it("beginRuntime：字段全对齐 + 持久化文件双侧一致", () => {
    const { oldM, nwM, oldFile, nwFile } = makeManagers();
    const ra = oldM.beginRuntime({ key: "thread-1", clientId: "client-1", threadId: "t1", cwd: "D:\\工作区" });
    const rb = nwM.beginRuntime({ key: "thread-1", clientId: "client-1", threadId: "t1", cwd: "D:\\工作区" });
    expect(normalizeRecord(ra)).toEqual(normalizeRecord(rb));
    expect(rb.status).toBe("creating");
    expect(rb.profile).toBe("通用 Agent");
    expect(rb.toolPolicyVersion).toBe("task-tool-policy-v1");
    expect(rb.piPackageVersion).toBe("1.1.0");
    expect(rb.capabilities).toEqual(nw.runtimeCapabilities);
    expect(rb.networkMode).toBe(nwM.networkSettings.mode);
    expect(rb.health).toEqual({ status: "starting", checkedAt: null, message: null });
    expectSameRecords(oldM, nwM);
    expectSameFiles(oldFile, nwFile);
  });

  it("beginRuntime 同 key 二次登记 → recoveryChain 引用上一 runtime", () => {
    const { oldM, nwM } = makeManagers();
    oldM.beginRuntime({ key: "k" });
    nwM.beginRuntime({ key: "k" });
    const ra = oldM.beginRuntime({ key: "k" });
    const rb = nwM.beginRuntime({ key: "k" });
    expect(rb.recoveryChain).toEqual([{ runtimeId: expect.stringMatching(/^runtime_/), reason: "previous_runtime" }]);
    expect(normalizeRecord(ra)).toEqual(normalizeRecord(rb));
    const otherA = oldM.beginRuntime({ key: "其他" });
    const otherB = nwM.beginRuntime({ key: "其他" });
    expect(otherA.recoveryChain).toEqual([]);
    expect(otherB.recoveryChain).toEqual([]);
    expectSameRecords(oldM, nwM);
  });

  it("bindSession：快照 model/登记 profile 与工具策略；缺省回落", () => {
    const { oldM, nwM } = makeManagers();
    const model = { provider: "测试商", id: "模型A", name: "模型A名", contextWindow: 128000.9, reasoning: true, vision: false, limit: { context: 999 } };
    const ia = oldM.beginRuntime({ key: "k" });
    const ib = nwM.beginRuntime({ key: "k" });
    const sa = oldM.bindSession(ia.runtimeId, { session: { sessionId: "sess-1", model } });
    const sb = nwM.bindSession(ib.runtimeId, { session: { sessionId: "sess-1", model } });
    expect(normalizeRecord(sa)).toEqual(normalizeRecord(sb));
    expect(sb.status).toBe("idle");
    expect(sb.sessionId).toBe("sess-1");
    expect(sb.provider).toBe("测试商");
    expect(sb.model).toEqual({ provider: "测试商", id: "模型A", name: "模型A名", reasoning: true, vision: false, contextWindow: 128000 });
    // 缺省：profile/toolPolicy/toolPolicyVersion 保留 beginRuntime 值
    const ja = oldM.bindSession(ia.runtimeId, {});
    const jb = nwM.bindSession(ib.runtimeId, {});
    expect(normalizeRecord(ja)).toEqual(normalizeRecord(jb));
    // 覆写：profile/toolPolicy 生效
    const ka = oldM.bindSession(ia.runtimeId, { profile: "审校 Agent", toolPolicyVersion: "v2", toolPolicy: { tools: ["read"] } });
    const kb = nwM.bindSession(ib.runtimeId, { profile: "审校 Agent", toolPolicyVersion: "v2", toolPolicy: { tools: ["read"] } });
    expect(normalizeRecord(ka)).toEqual(normalizeRecord(kb));
    expect(kb.profile).toBe("审校 Agent");
    expectSameRecords(oldM, nwM);
  });

  it("update：patch 合并 + model 再快照（contextLength 变体 → contextWindow）", () => {
    const { oldM, nwM } = makeManagers();
    const ia = oldM.beginRuntime({});
    const ib = nwM.beginRuntime({});
    const ua = oldM.update(ia.runtimeId, { status: "running", customField: "x", model: { provider: "p2", id: "m2", name: "n2", contextLength: 4096.7 } });
    const ub = nwM.update(ib.runtimeId, { status: "running", customField: "x", model: { provider: "p2", id: "m2", name: "n2", contextLength: 4096.7 } });
    expect(normalizeRecord(ua)).toEqual(normalizeRecord(ub));
    expect(ub.model).toEqual({ provider: "p2", id: "m2", name: "n2", reasoning: false, vision: false, contextWindow: 4096 });
    expect(ub.customField).toBe("x");
    expect(oldM.update("不存在", { status: "x" })).toBe(null);
    expect(nwM.update("不存在", { status: "x" })).toBe(null);
    expectSameRecords(oldM, nwM);
  });

  it("markFailure：分类落账 + code 白名单保留 + recovering 变体", () => {
    const { oldM, nwM } = makeManagers();
    const ia = oldM.beginRuntime({ key: "k" });
    const ib = nwM.beginRuntime({ key: "k" });
    const genericA = oldM.markFailure(ia.runtimeId, new Error("boom"));
    const genericB = nwM.markFailure(ib.runtimeId, new Error("boom"));
    expect(normalizeRecord(genericA)).toEqual(normalizeRecord(genericB));
    expect(genericB.status).toBe("failed");
    expect(genericB.health.status).toBe("failed");
    expect(genericB.error.code).toBe(genericB.errorCategory);
    expect(genericB.error.message).toContain("boom");
    expect(typeof genericB.error.retryable).toBe("boolean");
    expect(genericB.recoveryChain.at(-1)).toEqual({ at: new Date().toISOString(), reason: "runtime_error", status: "failed" });
    // code 白名单（MODEL_TIMEOUT）保留原始 code
    const timeoutA = oldM.markFailure(ia.runtimeId, Object.assign(new Error("超时"), { code: "MODEL_TIMEOUT" }));
    const timeoutB = nwM.markFailure(ib.runtimeId, Object.assign(new Error("超时"), { code: "MODEL_TIMEOUT" }));
    expect(normalizeRecord(timeoutA)).toEqual(normalizeRecord(timeoutB));
    expect(timeoutB.error.code).toBe("MODEL_TIMEOUT");
    // recovering 变体
    const recA = oldM.markFailure(ia.runtimeId, new Error("再炸"), { recovering: true, reason: "自定义原因" });
    const recB = nwM.markFailure(ib.runtimeId, new Error("再炸"), { recovering: true, reason: "自定义原因" });
    expect(normalizeRecord(recA)).toEqual(normalizeRecord(recB));
    expect(recB.status).toBe("recovering");
    expect(recB.health.status).toBe("degraded");
    expect(oldM.markFailure("不存在", new Error("x"))).toBe(null);
    expect(nwM.markFailure("不存在", new Error("x"))).toBe(null);
    expectSameRecords(oldM, nwM);
  });

  it("markRecovery：状态/健康/恢复链", () => {
    const { oldM, nwM } = makeManagers();
    const ia = oldM.beginRuntime({});
    const ib = nwM.beginRuntime({});
    const ra = oldM.markRecovery(ia.runtimeId);
    const rb = nwM.markRecovery(ib.runtimeId);
    expect(normalizeRecord(ra)).toEqual(normalizeRecord(rb));
    expect(rb.status).toBe("recovering");
    expect(rb.health).toEqual({ status: "degraded", checkedAt: new Date().toISOString(), message: "等待恢复入口" });
    expect(rb.recoveryChain.at(-1)).toEqual({ at: new Date().toISOString(), reason: "manual_recovery", status: "recovering" });
    expect(nwM.markRecovery("不存在")).toBe(null);
    expectSameRecords(oldM, nwM);
  });

  it("health：流式/空闲/失败三态 + scheduler 附带 + 快照净化", () => {
    const { oldM, nwM } = makeManagers();
    const ia = oldM.beginRuntime({ key: "k" });
    const ib = nwM.beginRuntime({ key: "k" });
    // 流式 → running
    const ha = oldM.health(ia.runtimeId, { isStreaming: true, sessionId: "s9", model: { provider: "p", id: "m" } });
    const hb = nwM.health(ib.runtimeId, { isStreaming: true, sessionId: "s9", model: { provider: "p", id: "m" } });
    expect(normalizeRecord(ha)).toEqual(normalizeRecord(hb));
    expect(hb.health.status).toBe("running");
    expect(hb.status).toBe("running");
    expect(hb.scheduler).toEqual(nwM.agentLimiter.snapshot());
    // 空闲 → healthy
    const ia2 = oldM.health(ia.runtimeId, { isStreaming: false, isIdle: true });
    const ib2 = nwM.health(ib.runtimeId, { isStreaming: false, isIdle: true });
    expect(normalizeRecord(ia2)).toEqual(normalizeRecord(ib2));
    expect(ib2.health.status).toBe("healthy");
    // 不空闲不流式 → degraded / 记录 idle
    const ia3 = oldM.health(ia.runtimeId, { isStreaming: false, isIdle: false });
    const ib3 = nwM.health(ib.runtimeId, { isStreaming: false, isIdle: false });
    expect(normalizeRecord(ia3)).toEqual(normalizeRecord(ib3));
    expect(ib3.health.status).toBe("degraded");
    expect(ib3.status).toBe("idle");
    // failed 记录保持 failed
    oldM.markFailure(ia.runtimeId, new Error("boom"));
    nwM.markFailure(ib.runtimeId, new Error("boom"));
    const ia4 = oldM.health(ia.runtimeId, { isStreaming: false, isIdle: true });
    const ib4 = nwM.health(ib.runtimeId, { isStreaming: false, isIdle: true });
    expect(normalizeRecord(ia4)).toEqual(normalizeRecord(ib4));
    expect(ib4.status).toBe("failed");
    expect(ib4.health.status).toBe("failed");
    // overrides 合并 + 缺记录
    expect(oldM.health("不存在", {})).toBe(null);
    expect(nwM.health("不存在", {})).toBe(null);
    const oa = oldM.health(ia.runtimeId, {}, { customOverride: 1 });
    const ob = nwM.health(ib.runtimeId, {}, { customOverride: 1 });
    expect(normalizeRecord(oa)).toEqual(normalizeRecord(ob));
    expectSameRecords(oldM, nwM);
  });

  it("snapshot/listSnapshots：覆盖合并 + capabilities 缺省 + 倒序", () => {
    const { oldM, nwM } = makeManagers();
    const ia = oldM.beginRuntime({ key: "a" });
    const ib = nwM.beginRuntime({ key: "a" });
    oldM.beginRuntime({ key: "b" });
    nwM.beginRuntime({ key: "b" });
    expect(normalizeRecord(oldM.snapshot(ia.runtimeId, { status: "custom" }))).toEqual(normalizeRecord(nwM.snapshot(ib.runtimeId, { status: "custom" })));
    expect(nwM.snapshot(ib.runtimeId, { status: "custom" }).status).toBe("custom");
    expect(nwM.snapshot(ib.runtimeId).capabilities).toEqual(nw.runtimeCapabilities);
    expect(oldM.snapshot("不存在")).toBe(null);
    expect(nwM.snapshot("不存在")).toBe(null);
    const la = oldM.listSnapshots();
    const lb = nwM.listSnapshots();
    expect(la.map(normalizeRecord)).toEqual(lb.map(normalizeRecord));
    expect(lb.map((item: any) => item.key)).toEqual(["b", "a"]);
  });

  it("schedulerSnapshot：agent/officecli 双闸门快照", () => {
    const { oldM, nwM } = makeManagers({ agentConcurrency: 3, officeConcurrency: "4" });
    expect(nwM.schedulerSnapshot()).toEqual(oldM.schedulerSnapshot());
    expect(nwM.schedulerSnapshot()).toEqual({
      agent: { name: "agent", limit: 3, active: 0, queued: 0, started: 0, completed: 0 },
      officecli: { name: "officecli", limit: 4, active: 0, queued: 0, started: 0, completed: 0 },
    });
  });

  it("dispose/disposeAll：会话释放 + 状态落账 + 适配器关闭 + 失败也落 disposed", () => {
    const { oldM, nwM } = makeManagers();
    const ia = oldM.beginRuntime({});
    const ib = nwM.beginRuntime({});
    const disposeA = vi.fn();
    const disposeB = vi.fn();
    oldM.dispose(ia.runtimeId, { dispose: disposeA });
    nwM.dispose(ib.runtimeId, { dispose: disposeB });
    expect(disposeA).toHaveBeenCalledTimes(1);
    expect(disposeB).toHaveBeenCalledTimes(1);
    expect(oldM.find(ia.runtimeId).status).toBe("disposed");
    expect(nwM.find(ib.runtimeId).status).toBe("disposed");
    expect(nwM.find(ib.runtimeId).health).toEqual({ status: "stopped", checkedAt: new Date().toISOString(), message: null });
    // dispose 抛错 → markFailure(dispose_failed) 后仍落 disposed
    const ja = oldM.beginRuntime({});
    const jb = nwM.beginRuntime({});
    oldM.dispose(ja.runtimeId, { dispose: () => { throw new Error("释放失败"); } });
    nwM.dispose(jb.runtimeId, { dispose: () => { throw new Error("释放失败"); } });
    expect(normalizeRecord(oldM.find(ja.runtimeId))).toEqual(normalizeRecord(nwM.find(jb.runtimeId)));
    expect(nwM.find(jb.runtimeId).status).toBe("disposed");
    expect(nwM.find(jb.runtimeId).errorCategory).toBeTruthy();
    // disposeAll：批量 dispose + 关闭适配器
    const closeA = vi.fn();
    const closeB = vi.fn();
    (oldM as any).networkAdapterInstance = { close: closeA };
    (nwM as any).networkAdapterInstance = { close: closeB };
    oldM.disposeAll([{ runtimeId: ia.runtimeId, session: null }, { runtimeId: ja.runtimeId, session: null }]);
    nwM.disposeAll([{ runtimeId: ib.runtimeId, session: null }, { runtimeId: jb.runtimeId, session: null }]);
    expect(closeA).toHaveBeenCalledTimes(1);
    expect(closeB).toHaveBeenCalledTimes(1);
    expect((nwM as any).networkAdapterInstance).toBe(null);
    expectSameRecords(oldM, nwM);
  });

  it("find：命中/未命中", () => {
    const { oldM, nwM } = makeManagers();
    const ia = oldM.beginRuntime({});
    const ib = nwM.beginRuntime({});
    expect(normalizeRecord(oldM.find(ia.runtimeId))).toEqual(normalizeRecord(nwM.find(ib.runtimeId)));
    expect(oldM.find("nope")).toBe(null);
    expect(nwM.find("nope")).toBe(null);
  });
});

describe("B6-7 runPrompt / abort / isUserAbort", () => {
  it("runPrompt steer=false：经 agentLimiter 排队串行，成功后落 idle", async () => {
    const { oldM, nwM } = makeManagers({ agentConcurrency: 1 });
    const ia = oldM.beginRuntime({});
    const ib = nwM.beginRuntime({});
    let openA: () => void = () => {};
    let openB: () => void = () => {};
    const gateA = new Promise<void>((resolve) => { openA = resolve; });
    const gateB = new Promise<void>((resolve) => { openB = resolve; });
    const pa = oldM.runPrompt(ia.runtimeId, () => gateA.then(() => "r1"));
    const pb = nwM.runPrompt(ib.runtimeId, () => gateB.then(() => "r1"));
    // 第二条进队列
    const qa = oldM.runPrompt(ia.runtimeId, () => "r2");
    const qb = nwM.runPrompt(ib.runtimeId, () => "r2");
    expect(nwM.find(ib.runtimeId).status).toBe("queued");
    expect(nwM.agentLimiter.snapshot().queued).toBe(1);
    openA();
    openB();
    expect(await pa).toBe("r1");
    expect(await pb).toBe("r1");
    expect(await qa).toBe("r2");
    expect(await qb).toBe("r2");
    expect(nwM.find(ib.runtimeId).status).toBe("idle");
    expect(nwM.find(ib.runtimeId).health.status).toBe("healthy");
    expect(nwM.agentLimiter.snapshot().started).toBe(2);
    expectSameRecords(oldM, nwM);
  });

  it("runPrompt steer=true：绕过闸门直通 running", async () => {
    const { oldM, nwM } = makeManagers();
    const ia = oldM.beginRuntime({});
    const ib = nwM.beginRuntime({});
    const ra = await oldM.runPrompt(ia.runtimeId, async () => "直通", { steer: true });
    const rb = await nwM.runPrompt(ib.runtimeId, async () => "直通", { steer: true });
    expect(ra).toBe("直通");
    expect(rb).toBe("直通");
    expect(nwM.agentLimiter.snapshot().started).toBe(0);
    expect(nwM.find(ib.runtimeId).status).toBe("idle");
    expectSameRecords(oldM, nwM);
  });

  it("runPrompt 失败：markFailure(failed) + 重抛；用户中断形态落 idle + user_abort 链", async () => {
    const { oldM, nwM } = makeManagers();
    const ia = oldM.beginRuntime({});
    const ib = nwM.beginRuntime({});
    await expect(oldM.runPrompt(ia.runtimeId, async () => { throw new Error("普通故障"); })).rejects.toThrow("普通故障");
    await expect(nwM.runPrompt(ib.runtimeId, async () => { throw new Error("普通故障"); })).rejects.toThrow("普通故障");
    expect(nwM.find(ib.runtimeId).status).toBe("failed");
    expect(nwM.find(ib.runtimeId).recoveryChain.at(-1).reason).toBe("runtime_error");
    // 先 abort 打中断标记（abort 正常收尾 → idle），随后 prompt 以 Request aborted 拒绝
    await oldM.abort(ia.runtimeId, { abort: async () => {} });
    await nwM.abort(ib.runtimeId, { abort: async () => {} });
    await expect(oldM.runPrompt(ia.runtimeId, async () => { throw new Error("Request aborted"); })).rejects.toThrow("Request aborted");
    await expect(nwM.runPrompt(ib.runtimeId, async () => { throw new Error("Request aborted"); })).rejects.toThrow("Request aborted");
    expect(nwM.find(ib.runtimeId).status).toBe("idle");
    expect(nwM.find(ib.runtimeId).error).toBe(null);
    expect(nwM.find(ib.runtimeId).recoveryChain.at(-1)).toEqual({ at: new Date().toISOString(), reason: "user_abort", status: "idle" });
    expectSameRecords(oldM, nwM);
  });

  it("abort：成功落 idle；中断形态吞错落 idle；故障形态 markFailure(abort_failed) 重抛", async () => {
    const { oldM, nwM } = makeManagers();
    const ia = oldM.beginRuntime({});
    const ib = nwM.beginRuntime({});
    // 成功：aborting → idle，中断标记已打
    await oldM.abort(ia.runtimeId, { abort: async () => {} });
    await nwM.abort(ib.runtimeId, { abort: async () => {} });
    expect(nwM.find(ib.runtimeId).status).toBe("idle");
    expect(typeof nwM.find(ib.runtimeId).abortRequestedAt).toBe("number");
    expectSameRecords(oldM, nwM);
    // 中断形态：session.abort 以 Request aborted 拒绝 → 吞错，落 idle + error 清空
    const ja = oldM.beginRuntime({});
    const jb = nwM.beginRuntime({});
    await oldM.abort(ja.runtimeId, { abort: async () => { throw new Error("Request aborted by user"); } });
    await nwM.abort(jb.runtimeId, { abort: async () => { throw new Error("Request aborted by user"); } });
    expect(nwM.find(jb.runtimeId).status).toBe("idle");
    expect(nwM.find(jb.runtimeId).error).toBe(null);
    expectSameRecords(oldM, nwM);
    // 故障形态：非中断错误 → 重抛 + markFailure(abort_failed)
    const ka = oldM.beginRuntime({});
    const kb = nwM.beginRuntime({});
    await expect(oldM.abort(ka.runtimeId, { abort: async () => { throw new Error("断开失败"); } })).rejects.toThrow("断开失败");
    await expect(nwM.abort(kb.runtimeId, { abort: async () => { throw new Error("断开失败"); } })).rejects.toThrow("断开失败");
    expect(nwM.find(kb.runtimeId).status).toBe("failed");
    expect(nwM.find(kb.runtimeId).recoveryChain.at(-1).reason).toBe("abort_failed");
    // session 为 null/缺 abort 方法也不炸
    await oldM.abort(ia.runtimeId, null);
    await nwM.abort(ib.runtimeId, null);
    await oldM.abort(ia.runtimeId, {});
    await nwM.abort(ib.runtimeId, {});
    expectSameRecords(oldM, nwM);
  });

  it("isUserAbort：中断标记 + 形态正则 + 120s 窗口", () => {
    const { oldM, nwM } = makeManagers();
    const ia = oldM.beginRuntime({});
    const ib = nwM.beginRuntime({});
    const recordA = oldM.find(ia.runtimeId);
    const recordB = nwM.find(ib.runtimeId);
    // 无标记 → false
    expect(oldM.isUserAbort(recordA, new Error("Request aborted"))).toBe(false);
    expect(nwM.isUserAbort(recordB, new Error("Request aborted"))).toBe(false);
    // aborting 状态即视为已请求，但消息形态必须匹配
    recordB.status = "aborting";
    recordA.status = "aborting";
    expect(oldM.isUserAbort(recordA, new Error("Request aborted"))).toBe(true);
    expect(nwM.isUserAbort(recordB, new Error("Request aborted"))).toBe(true);
    expect(oldM.isUserAbort(recordA, new Error("普通故障"))).toBe(false);
    expect(nwM.isUserAbort(recordB, new Error("普通故障"))).toBe(false);
    // abortRequestedAt 新鲜窗口（冻结时钟差值 0 < 120000）
    recordB.status = "idle";
    recordA.status = "idle";
    recordA.abortRequestedAt = Date.now();
    recordB.abortRequestedAt = Date.now();
    for (const message of ["Request aborted", "aborted", "task aborting", "cancelled", "canceled", "interrupted", "用户请求中断", "已中断", "已取消"]) {
      expect(oldM.isUserAbort(recordA, { message })).toBe(true);
      expect(nwM.isUserAbort(recordB, { message })).toBe(true);
    }
    expect(nwM.isUserAbort(recordB, { cause: { message: "Request aborted" } })).toBe(true);
    expect(oldM.isUserAbort(recordA, { cause: { message: "Request aborted" } })).toBe(true);
    // 过期窗口（200s 前）
    recordA.abortRequestedAt = Date.now() - 200000;
    recordB.abortRequestedAt = Date.now() - 200000;
    expect(oldM.isUserAbort(recordA, new Error("Request aborted"))).toBe(false);
    expect(nwM.isUserAbort(recordB, new Error("Request aborted"))).toBe(false);
    // 无记录 → false
    expect(oldM.isUserAbort(null, new Error("Request aborted"))).toBe(false);
    expect(nwM.isUserAbort(null, new Error("Request aborted"))).toBe(false);
    expect(oldM.isUserAbort(undefined, new Error("Request aborted"))).toBe(false);
    expect(nwM.isUserAbort(undefined, new Error("Request aborted"))).toBe(false);
  });
});

describe("B6-7 compact / setModel / setActiveTools / setThinkingLevel / 上下文与树", () => {
  it("compact：成功透传结果 + compacting 中间态；失败 markFailure(recovering) 重抛", async () => {
    const { oldM, nwM } = makeManagers();
    const ia = oldM.beginRuntime({});
    const ib = nwM.beginRuntime({});
    let openA: () => void = () => {};
    let openB: () => void = () => {};
    const gateA = new Promise<void>((resolve) => { openA = resolve; });
    const gateB = new Promise<void>((resolve) => { openB = resolve; });
    const pa = oldM.compact(ia.runtimeId, { compact: () => gateA.then(() => ({ ok: true })) }, "压缩指令");
    const pb = nwM.compact(ib.runtimeId, { compact: () => gateB.then(() => ({ ok: true })) }, "压缩指令");
    expect(nwM.find(ib.runtimeId).status).toBe("compacting");
    openA();
    openB();
    expect(await pa).toEqual({ ok: true });
    expect(await pb).toEqual({ ok: true });
    expect(nwM.find(ib.runtimeId).status).toBe("idle");
    // 空指令 → undefined 透传给 session.compact
    const receivedA: Array<unknown> = [];
    const receivedB: Array<unknown> = [];
    await oldM.compact(ia.runtimeId, { compact: (instructions: unknown) => { receivedA.push(instructions); return "空"; } });
    await nwM.compact(ib.runtimeId, { compact: (instructions: unknown) => { receivedB.push(instructions); return "空"; } });
    expect(receivedA).toEqual([undefined]);
    expect(receivedB).toEqual([undefined]);
    // 失败
    await expect(oldM.compact(ia.runtimeId, { compact: async () => { throw new Error("压缩失败"); } })).rejects.toThrow("压缩失败");
    await expect(nwM.compact(ib.runtimeId, { compact: async () => { throw new Error("压缩失败"); } })).rejects.toThrow("压缩失败");
    expect(nwM.find(ib.runtimeId).status).toBe("recovering");
    expect(nwM.find(ib.runtimeId).recoveryChain.at(-1).reason).toBe("compact_failed");
    expectSameRecords(oldM, nwM);
  });

  it("setModel：成功登记 provider/model 快照；失败 markFailure(model_switch_failed)", async () => {
    const { oldM, nwM } = makeManagers();
    const ia = oldM.beginRuntime({});
    const ib = nwM.beginRuntime({});
    const model = { provider: "测试商", id: "模型B", name: "模型B名", contextWindow: 32000 };
    await oldM.setModel(ia.runtimeId, { setModel: async () => {} }, model);
    await nwM.setModel(ib.runtimeId, { setModel: async () => {} }, model);
    expect(nwM.find(ib.runtimeId).provider).toBe("测试商");
    expect(nwM.find(ib.runtimeId).model).toEqual({ provider: "测试商", id: "模型B", name: "模型B名", reasoning: false, vision: false, contextWindow: 32000 });
    expect(nwM.find(ib.runtimeId).status).toBe("idle");
    await expect(oldM.setModel(ia.runtimeId, { setModel: async () => { throw new Error("切换失败"); } }, model)).rejects.toThrow("切换失败");
    await expect(nwM.setModel(ib.runtimeId, { setModel: async () => { throw new Error("切换失败"); } }, model)).rejects.toThrow("切换失败");
    expect(nwM.find(ib.runtimeId).recoveryChain.at(-1).reason).toBe("model_switch_failed");
    expectSameRecords(oldM, nwM);
  });

  it("setActiveTools：去重登记 toolPolicy；失败 markFailure(tool_policy_apply_failed)", () => {
    const { oldM, nwM } = makeManagers();
    const ia = oldM.beginRuntime({});
    const ib = nwM.beginRuntime({});
    oldM.setActiveTools(ia.runtimeId, { setActiveToolsByName: () => {} }, ["b", "a", "b"]);
    nwM.setActiveTools(ib.runtimeId, { setActiveToolsByName: () => {} }, ["b", "a", "b"]);
    expect(nwM.find(ib.runtimeId).toolPolicy).toEqual({ tools: ["b", "a"] });
    // 非数组 → 空集
    oldM.setActiveTools(ia.runtimeId, { setActiveToolsByName: () => {} }, "不是数组");
    nwM.setActiveTools(ib.runtimeId, { setActiveToolsByName: () => {} }, "不是数组");
    expect(nwM.find(ib.runtimeId).toolPolicy).toEqual({ tools: [] });
    expect(oldM.find(ia.runtimeId).toolPolicy).toEqual(nwM.find(ib.runtimeId).toolPolicy);
    // 失败
    expect(() => oldM.setActiveTools(ia.runtimeId, { setActiveToolsByName: () => { throw new Error("工具失败"); } }, [])).toThrow("工具失败");
    expect(() => nwM.setActiveTools(ib.runtimeId, { setActiveToolsByName: () => { throw new Error("工具失败"); } }, [])).toThrow("工具失败");
    expect(nwM.find(ib.runtimeId).recoveryChain.at(-1).reason).toBe("tool_policy_apply_failed");
    expectSameRecords(oldM, nwM);
  });

  it("setThinkingLevel：成功登记；失败 markFailure(thinking_level_apply_failed)", () => {
    const { oldM, nwM } = makeManagers();
    const ia = oldM.beginRuntime({});
    const ib = nwM.beginRuntime({});
    oldM.setThinkingLevel(ia.runtimeId, { setThinkingLevel: () => {} }, "high");
    nwM.setThinkingLevel(ib.runtimeId, { setThinkingLevel: () => {} }, "high");
    expect(nwM.find(ib.runtimeId).thinkingLevel).toBe("high");
    expect(() => oldM.setThinkingLevel(ia.runtimeId, { setThinkingLevel: () => { throw new Error("档位失败"); } }, "high")).toThrow("档位失败");
    expect(() => nwM.setThinkingLevel(ib.runtimeId, { setThinkingLevel: () => { throw new Error("档位失败"); } }, "high")).toThrow("档位失败");
    expect(nwM.find(ib.runtimeId).recoveryChain.at(-1).reason).toBe("thinking_level_apply_failed");
    expectSameRecords(oldM, nwM);
  });

  it("getContextUsage / getSessionTree：缺函数/异常回落 null，正常透传", () => {
    const { oldM, nwM } = makeManagers();
    const ia = oldM.beginRuntime({});
    const ib = nwM.beginRuntime({});
    const usage = { input: 1, output: 2 };
    const tree = [{ id: "root" }];
    const pairsA: Array<[any, unknown]> = [
      [null, null],
      [{}, null],
      [{ getContextUsage: () => usage }, usage],
      [{ getContextUsage: () => { throw new Error("x"); } }, null],
    ];
    const pairsB: Array<[any, unknown]> = [
      [null, null],
      [{}, null],
      [{ getTree: () => tree }, tree],
      [{ getTree: () => { throw new Error("x"); } }, null],
    ];
    for (const [session, expected] of pairsA) {
      expect(oldM.getContextUsage(ia.runtimeId, session)).toEqual(expected);
      expect(nwM.getContextUsage(ib.runtimeId, session)).toEqual(expected);
    }
    for (const [sessionManager, expected] of pairsB) {
      expect(oldM.getSessionTree(ia.runtimeId, sessionManager)).toEqual(expected);
      expect(nwM.getSessionTree(ib.runtimeId, sessionManager)).toEqual(expected);
    }
  });

  it("navigateSessionTree：不支持时中文报错；支持时透传 String(targetId) 与 options", async () => {
    const { oldM, nwM } = makeManagers();
    const ia = oldM.beginRuntime({});
    const ib = nwM.beginRuntime({});
    await expect(oldM.navigateSessionTree(ia.runtimeId, {}, "n1", {})).rejects.toThrow("当前 Pi 会话不支持会话树导航（navigateTree 不可用）");
    await expect(nwM.navigateSessionTree(ib.runtimeId, {}, "n1", {})).rejects.toThrow("当前 Pi 会话不支持会话树导航（navigateTree 不可用）");
    const callsA: Array<unknown[]> = [];
    const callsB: Array<unknown[]> = [];
    const options = { summarize: true, label: "分支" };
    await oldM.navigateSessionTree(ia.runtimeId, { navigateTree: (...callArgs: unknown[]) => { callsA.push(callArgs); return "ok"; } }, "n1", options);
    await nwM.navigateSessionTree(ib.runtimeId, { navigateTree: (...callArgs: unknown[]) => { callsB.push(callArgs); return "ok"; } }, "n1", options);
    expect(callsA).toEqual(callsB);
    expect(callsB).toEqual([["n1", options]]);
    // targetId 空值 → String("" || "") = ""
    await oldM.navigateSessionTree(ia.runtimeId, { navigateTree: (...callArgs: unknown[]) => { callsA.push(callArgs); } }, null, {});
    await nwM.navigateSessionTree(ib.runtimeId, { navigateTree: (...callArgs: unknown[]) => { callsB.push(callArgs); } }, null, {});
    expect(callsA).toEqual(callsB);
    expect(callsB.at(-1)).toEqual(["", {}]);
  });
});

describe("B6-7 网络诊断与设置更新", () => {
  it("networkDiagnostics：未建适配器时回落形状", () => {
    const { oldM, nwM } = makeManagers();
    expect(nwM.networkDiagnostics()).toEqual(oldM.networkDiagnostics());
    expect(nwM.networkDiagnostics()).toMatchObject({ mode: "direct", closed: false, hasProxy: false });
  });

  it("updateNetworkSettings：manual 代理脱敏 + 旧适配器关闭 + 记录切换", () => {
    const { oldM, nwM } = makeManagers();
    const closeA = vi.fn();
    const closeB = vi.fn();
    (oldM as any).networkAdapterInstance = { close: closeA };
    (nwM as any).networkAdapterInstance = { close: closeB };
    const da = oldM.updateNetworkSettings({ mode: "manual", proxyUrl: "http://user:secret@proxy:8080" });
    const db = nwM.updateNetworkSettings({ mode: "manual", proxyUrl: "http://user:secret@proxy:8080" });
    expect(da).toEqual(db);
    expect(closeA).toHaveBeenCalledTimes(1);
    expect(closeB).toHaveBeenCalledTimes(1);
    expect(db.mode).toBe("manual");
    expect(db.hasProxy).toBe(true);
    expect(String(db.proxy)).not.toContain("secret");
    expect(nwM.networkSettings.mode).toBe("manual");
    // 空参数 → loadNetworkSettings 缺省（临时目录无网络代理.json → direct）
    const da2 = oldM.updateNetworkSettings();
    const db2 = nwM.updateNetworkSettings();
    expect(da2).toEqual(db2);
    expect((nwM as any).networkAdapterInstance).toBe(null);
  });
});

describe("B6-7 持久化与恢复", () => {
  it("markPersistedRuntimesRecovering：构造时把活跃态标记 recovering 并回写", () => {
    const seed = [
      { version: 1, runtimeId: "runtime_old_running", key: "k1", status: "running", health: { status: "healthy", checkedAt: null, message: null }, recoveryChain: [] },
      { version: 1, runtimeId: "runtime_old_failed", key: "k2", status: "failed", health: { status: "failed", checkedAt: null, message: null }, recoveryChain: [] },
    ];
    const { oldM, nwM, oldFile, nwFile } = makeManagersWithSeed(seed);
    expect(oldM.find("runtime_old_running").status).toBe("recovering");
    expect(nwM.find("runtime_old_running").status).toBe("recovering");
    expect(nwM.find("runtime_old_running").health).toEqual({ status: "degraded", checkedAt: new Date().toISOString(), message: "服务重启后等待显式恢复" });
    expect(nwM.find("runtime_old_running").recoveryChain).toEqual([{ at: new Date().toISOString(), reason: "process_restart", status: "recovering" }]);
    expect(nwM.find("runtime_old_failed").status).toBe("failed");
    expect(JSON.parse(fs.readFileSync(oldFile, "utf8")).map(normalizeRecord)).toEqual(JSON.parse(fs.readFileSync(nwFile, "utf8")).map(normalizeRecord));
  });

  it("RUNTIME_RECORD_LIMIT=120：records 与持久化文件截断到最近 120 条", () => {
    const { oldM, nwM, oldFile, nwFile } = makeManagers();
    for (let i = 0; i < 130; i += 1) {
      oldM.beginRuntime({ key: `k${i}` });
      nwM.beginRuntime({ key: `k${i}` });
    }
    expect(oldM.records.length).toBe(120);
    expect(nwM.records.length).toBe(120);
    expect(oldM.records.map(normalizeRecord)).toEqual(nwM.records.map(normalizeRecord));
    const persistedA = JSON.parse(fs.readFileSync(oldFile, "utf8"));
    const persistedB = JSON.parse(fs.readFileSync(nwFile, "utf8"));
    expect(persistedA.length).toBe(120);
    expect(persistedA.map(normalizeRecord)).toEqual(persistedB.map(normalizeRecord));
    expect(persistedB[0].key).toBe("k10");
  });

  it("重载：另一实例读取同一记录文件（creating → recovering）", () => {
    const { oldM, oldFile, nwFile } = makeManagers();
    const created = oldM.beginRuntime({ key: "重载" });
    const reloadedOld = new old.PiRuntimeManager({ recordFile: oldFile });
    const reloadedNew = new nw.PiRuntimeManager({ recordFile: nwFile });
    // nw 侧同 key 实例没有——直接用旧侧生成的文件喂新侧独立文件验证重载语义
    expect(reloadedOld.find(created.runtimeId)).not.toBe(null);
    expect(reloadedOld.find(created.runtimeId).status).toBe("recovering");
    expect(reloadedNew.records.length).toBe(0);
    // 新侧重载等价性：往 nwFile 写入同一 seed
    fs.writeFileSync(nwFile, fs.readFileSync(oldFile, "utf8"), "utf8");
    const reloadedNew2 = new nw.PiRuntimeManager({ recordFile: nwFile });
    expect(normalizeRecord(reloadedOld.records[0])).toEqual(normalizeRecord(reloadedNew2.records[0]));
  });
});

/** 带 seed 记录文件的实例对（验证构造期 markPersistedRuntimesRecovering）。 */
function makeManagersWithSeed(seed: any[]): { oldM: any; nwM: any; oldFile: string; nwFile: string } {
  const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), "b6-pi-rt-old-"));
  const nwDir = fs.mkdtempSync(path.join(os.tmpdir(), "b6-pi-rt-nw-"));
  const oldFile = path.join(oldDir, "运行时记录.json");
  const nwFile = path.join(nwDir, "运行时记录.json");
  fs.writeFileSync(oldFile, JSON.stringify(seed, null, 2) + "\n", "utf8");
  fs.writeFileSync(nwFile, JSON.stringify(seed, null, 2) + "\n", "utf8");
  const oldM = new old.PiRuntimeManager({ recordFile: oldFile });
  const nwM = new nw.PiRuntimeManager({ recordFile: nwFile });
  return { oldM, nwM, oldFile, nwFile };
}
