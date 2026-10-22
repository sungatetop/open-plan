import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import * as nextOrchestrator from "../src/main/backend/agent/subagent-orchestrator";

// B6-2 对拍：旧 server JS ↔ 新 electron TS（subagent-orchestrator）。
//
// 基建设计（双侧同流）：
// - 本模块零 import 纯逻辑，无 fs/crypto 外部依赖，无需 mock 模块依赖；
// - fake timers 仅冻结 Date（toFake:["Date"]）：orchestrateSubagents 内部 Date.now() 只用于
//   durationMs 计时，冻结后双侧恒为 0，事件 payload 可整体 deep-equal；setTimeout 保持真实，
//   执行器用微任务（await Promise.resolve()）制造确定性交叠，保证并发峰值与事件交错两侧一致；
// - childIdFor 的 falsy toolKey 分支走 Math.random 兜底，用 vi.spyOn(Math,"random") 定值 0.5
//   使双侧输出可等值断言（(0.5).toString(36)="0.i" → 兜底键 "i"）；
// - 编排场景以同一份确定性执行器剧本分别驱动旧/新模块，对 events/calls/result 全量 deep-equal，
//   事件与调用序的交错由同一 V8 引擎的微任务调度保证两侧一致。

type AnyMod = Record<string, any>;

let oldMod: AnyMod;

beforeAll(async () => {
  oldMod = (await import("../../server/subagent-orchestrator.mjs")) as unknown as AnyMod;
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** 双侧同流：同一输入函数分别驱动旧 JS 与新 TS，返回双侧结果供等值断言。 */
async function both<T>(fn: (mod: AnyMod) => T | Promise<T>): Promise<[T, T]> {
  const o = await fn(oldMod);
  const n = await fn(nextOrchestrator as unknown as AnyMod);
  return [o as T, n as T];
}

describe("B6-2 对拍：subagent-orchestrator 旧 JS ↔ 新 TS", () => {
  it("常量与角色定义表 deep-equal 且冻结", async () => {
    const [o, n] = await both((m) => ({
      concurrency: m.SUBAGENT_CONCURRENCY,
      maxTasks: m.SUBAGENT_MAX_TASKS,
      reviseRounds: m.SUBAGENT_REVISE_ROUNDS,
      roles: m.SUBAGENT_ROLES,
      frozen: Object.isFrozen(m.SUBAGENT_ROLES),
    }));
    expect(o).toEqual(n);
    expect(o.concurrency).toBe(2);
    expect(o.maxTasks).toBe(4);
    expect(o.reviseRounds).toBe(1);
    expect(o.frozen).toBe(true);
    expect(Object.keys(o.roles)).toEqual(["scout", "reviewer", "planner", "verifier", "worker"]);
  });

  it("resolveRole 矩阵：未知回 scout、worker 写权限降级、大小写敏感", async () => {
    const [o, n] = await both((m) => [
      m.resolveRole("worker", { canWrite: false }),
      m.resolveRole("worker", { canWrite: true }),
      m.resolveRole("不存在的角色", {}),
      m.resolveRole("verifier", { canWrite: false }),
      m.resolveRole("scout", {}),
      m.resolveRole("REVIEWER", {}),
      m.resolveRole("", {}),
      m.resolveRole(undefined, {}),
      m.resolveRole("worker"),
    ]);
    expect(o).toEqual(n);
    expect(o).toEqual(["scout", "worker", "scout", "verifier", "scout", "scout", "scout", "scout", "scout"]);
  });

  it("childIdFor 矩阵：净化/截断/falsy key 兜底（Math.random 定序）", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const [o, n] = await both((m) => [
      m.childIdFor("call_1", 0, false),
      m.childIdFor("call_1", 1, true),
      m.childIdFor("a/b\\c", 0, false),
      m.childIdFor("x".repeat(60), 0, false),
      m.childIdFor("", 0, false),
      m.childIdFor(null, 2, true),
      m.childIdFor("含 中文/字符?", 0, false),
    ]);
    expect(o).toEqual(n);
    expect(o[0]).toBe("subagent_call_1");
    expect(o[1]).toBe("subagent_call_1_2");
    expect(o[2]).toBe("subagent_a_b_c");
    expect(o[3]).toBe(`subagent_${"x".repeat(48)}`);
    expect(o[4]).toBe("subagent_i"); // Math.random()=0.5 → (0.5).toString(36)="0.i" → slice(2)="i"
    expect(o[5]).toBe("subagent_i_3");
  });

  it("parseVerdict 矩阵：显式判定/JSON/fail-safe/检查清单/截断", async () => {
    const samples: Array<string | null> = [
      "- 数据来源：缺失\n- 结论与文件一致：通过\n判定：revise",
      "结论不成立\n判定：fail",
      "判定: PASS",
      "判定：通过",
      "判定：需修订",
      "判定：不通过",
      "判定：'revise'",
      '{"verdict":"fail"}',
      '前言 {"verdict":"revise"} 后语',
      '{"verdict":"ok"}',
      '{"verdict" "fail"}',
      "看起来没问题",
      "",
      null,
      "- 数据来源\r\n- 覆盖：ok\r\n- 覆盖2：✅\r\n- 覆盖3：missing\r\n- 覆盖4：❌\r\n- 覆盖5\r\n- 判定：pass",
      "- Verdict: fail\n- 其余：通过",
      `- ${"I".repeat(400)}：通过`,
      "N".repeat(1500),
      Array.from({ length: 45 }, (_, i) => `- 项${i}：通过`).join("\n"),
    ];
    const [o, n] = await both((m) => samples.map((s) => m.parseVerdict(s)));
    expect(o).toEqual(n);
    expect(o[0]).toEqual({ verdict: "revise", checklist: [{ item: "数据来源", ok: false }, { item: "结论与文件一致", ok: true }], notes: samples[0] });
    expect(o[1].verdict).toBe("fail");
    expect(o[2].verdict).toBe("pass"); // 半角冒号 + 大小写不敏感
    expect(o[4].verdict).toBe("revise");
    expect(o[5].verdict).toBe("fail");
    expect(o[6].verdict).toBe("revise"); // 带引号
    expect(o[7].verdict).toBe("fail");
    expect(o[8].verdict).toBe("revise"); // 混在文本中的 JSON
    expect(o[9].verdict).toBe("pass"); // 非法枚举值 fail-safe
    expect(o[10].verdict).toBe("pass"); // JSON.parse 抛错 fail-safe
    expect(o[11].verdict).toBe("pass");
    expect(o[13]).toEqual({ verdict: "pass", checklist: [], notes: "" });
    expect(o[14].verdict).toBe("pass");
    expect(o[14].checklist).toEqual([
      // 无冒号行（数据来源/覆盖5）不匹配清单正则被跳过；✅ 不在失败关键词表 → ok
      { item: "覆盖", ok: true },
      { item: "覆盖2", ok: true },
      { item: "覆盖3", ok: false },
      { item: "覆盖4", ok: false },
    ]);
    expect(o[15].checklist).toEqual([{ item: "其余", ok: true }]); // verdict 行不进清单
    expect(o[16].checklist[0].item.length).toBe(300);
    expect(o[17].notes.length).toBe(1200);
    expect(o[18].checklist.length).toBe(40);
  });

  it("buildVerifierTask：精确文本与 6000 截断", async () => {
    const [o, n] = await both((m) => [
      m.buildVerifierTask({ task: "统计人口", output: "约 120 万" }),
      m.buildVerifierTask({ task: "t", output: "A".repeat(6000) + "TAIL_MARKER" }),
      m.buildVerifierTask({ task: "t2" }),
    ]);
    expect(o).toEqual(n);
    expect(o[0]).toBe([
      "你是对抗式核验者。请独立核查下面这个子任务的执行结论是否成立：",
      "【子任务】统计人口",
      "【执行结论】约 120 万",
      "要求：",
      "1. 只依据可读取的文件与证据判断，不臆测；逐条列出检查项与结论（格式：- 检查项：通过 或 - 检查项：缺失）。",
      "2. 结论成立且证据充分 → 修订建议可为空；证据不足或结论与文件不符 → 给出需要修订的具体点。",
      "3. 最后一行必须输出判定，格式严格为：判定：pass 或 判定：revise 或 判定：fail。",
    ].join("\n"));
    expect(o[1]).not.toContain("TAIL_MARKER");
    expect(o[1]).toContain("A".repeat(6000));
    expect(o[2]).toContain("【执行结论】");
  });

  it("summarizeResults 矩阵：空/单/多标题/核验结论/16000 截断", async () => {
    const [o, n] = await both((m) => [
      m.summarizeResults([]),
      m.summarizeResults([{ text: "单结果", isError: false, verify: { verdict: "pass" } }]),
      m.summarizeResults([
        { text: "结果一", isError: false, verify: { verdict: "pass" } },
        { text: "结果二", isError: false, verify: { verdict: "revise" } },
        { text: "结果三", isError: true, verify: { verdict: "fail" } },
        { text: "" },
      ]),
      m.summarizeResults([{ text: "L".repeat(9000) }, { text: "R".repeat(9000) }]),
    ]);
    expect(o).toEqual(n);
    expect(o[0]).toBe("（子代理没有返回结果）");
    expect(o[1]).toBe("单结果");
    expect(o[2]).toContain("### 子任务 1");
    expect(o[2]).toContain("### 子任务 4");
    expect(o[2]).toContain("需修订");
    expect(o[2]).toContain("不通过");
    expect(o[2]).toContain("（无结果）");
    expect(o[3].length).toBe(16000);
  });

  it("编排：worker+verify revise 回环，事件/调用/结果双侧全量 deep-equal", async () => {
    const run = async (m: AnyMod) => {
      const events: Array<{ type: string; data: any }> = [];
      const calls: Array<{ task: string; ctx: any }> = [];
      let workerRuns = 0;
      let verifierRuns = 0;
      const result = await m.orchestrateSubagents({
        tasks: ["任务甲", "任务乙"],
        role: "worker",
        roleSpec: m.SUBAGENT_ROLES.worker,
        toolKey: "call1",
        parentToolCallId: "call1",
        verify: true,
        emit: (type: string, data: any) => events.push({ type, data }),
        runTask: async (task: string, ctx: any) => {
          calls.push({ task, ctx: { ...ctx } });
          if (ctx.roleOverride === "verifier") {
            verifierRuns += 1;
            const round = Number(String(ctx.childId).match(/_v(\d+)/)?.[1] || 0);
            return { text: round === 1 ? "- 覆盖不全：缺失\n判定：revise" : "- 已补齐：通过\n判定：pass", isError: false, childId: ctx.childId };
          }
          workerRuns += 1;
          return { text: `交付 ${workerRuns}`, isError: false, childId: ctx.childId };
        },
      });
      return { events, calls, result };
    };
    const [o, n] = await both(run);
    expect(n.events).toEqual(o.events);
    expect(n.calls).toEqual(o.calls);
    expect(n.result).toEqual(o.result);
    expect(o.calls.length).toBe(8); // 2 任务 ×（worker 2 轮 + verifier 2 轮）
    expect(o.result.isError).toBe(false);
    expect(o.result.results.map((r: any) => r.status)).toEqual(["completed", "completed"]);
    expect(o.result.results.map((r: any) => r.childId)).toEqual(["subagent_call1_1", "subagent_call1_2"]);
    const closed = o.events.filter((e: any) => e.type === "subagent_closed");
    expect(closed.length).toBe(2);
    for (const c of closed) expect(c.data.finalStatus).toBe("completed");
    expect(o.events.filter((e: any) => e.type === "subagent_verified" && e.data.verdict === "revise").length).toBe(2);
    for (const r of o.result.results) expect(r.verify.verdict).toBe("pass");
    // revise 把核验意见并回任务重跑：worker 重跑调用 + 第二轮 verifier 任务文本（引用被改写的任务）均含反馈段
    const rerun = o.calls.filter((c: any) => !c.ctx.roleOverride && c.task.includes("【核验反馈（请修订后重新交付）】"));
    expect(rerun.length).toBe(2);
    const verifierWithFeedback = o.calls.filter((c: any) => c.ctx.roleOverride === "verifier" && c.task.includes("【核验反馈（请修订后重新交付）】"));
    expect(verifierWithFeedback.length).toBe(2);
  });

  it("编排：scout 不核验，峰值并发=SUBAGENT_CONCURRENCY", async () => {
    const run = async (m: AnyMod) => {
      const events: string[] = [];
      let concurrent = 0;
      let peak = 0;
      await m.orchestrateSubagents({
        tasks: ["a", "b", "c", "d"],
        role: "scout",
        roleSpec: m.SUBAGENT_ROLES.scout,
        toolKey: "call3",
        verify: true, // scout 不应核验
        emit: (type: string) => events.push(type),
        runTask: async (task: string, ctx: any) => {
          concurrent += 1;
          peak = Math.max(peak, concurrent);
          await Promise.resolve();
          await Promise.resolve();
          concurrent -= 1;
          return { text: task, isError: false, childId: ctx.childId };
        },
      });
      return { events, peak };
    };
    const [o, n] = await both(run);
    expect(n.peak).toBe(o.peak);
    expect(o.peak).toBe(nextOrchestrator.SUBAGENT_CONCURRENCY);
    expect(o.events).not.toContain("subagent_verified");
  });

  it("编排：超过 SUBAGENT_MAX_TASKS 的任务被裁剪", async () => {
    const [o, n] = await both(async (m) => {
      const seen: string[] = [];
      await m.orchestrateSubagents({
        tasks: ["1", "2", "3", "4", "5", "6"],
        role: "planner",
        roleSpec: m.SUBAGENT_ROLES.planner,
        toolKey: "call4",
        emit: () => {},
        runTask: async (task: string, ctx: any) => { seen.push(task); return { text: task, isError: false, childId: ctx.childId }; },
      });
      return seen;
    });
    expect(o).toEqual(["1", "2", "3", "4"]);
    expect(n).toEqual(o);
  });

  it("编排：执行器抛错不中断其它子任务，failed 关账且 error 截断 600", async () => {
    const longError = "boom-" + "x".repeat(700);
    const run = async (m: AnyMod) => {
      const closed: any[] = [];
      const result = await m.orchestrateSubagents({
        tasks: ["会炸", "正常"],
        role: "scout",
        roleSpec: m.SUBAGENT_ROLES.scout,
        toolKey: "call5",
        emit: (type: string, data: any) => { if (type === "subagent_closed") closed.push(data); },
        runTask: async (task: string) => {
          if (task.includes("会炸")) throw new Error(longError);
          return { text: "fine", isError: false, childId: "x" };
        },
      });
      return { closed, result };
    };
    const [o, n] = await both(run);
    expect(n).toEqual(o);
    const failed = o.closed.filter((c: any) => c.finalStatus === "failed");
    expect(failed.length).toBe(1);
    expect(failed[0].error).toBe(longError.slice(0, 600));
    expect(o.closed.filter((c: any) => c.finalStatus === "completed").length).toBe(1);
    expect(o.result.isError).toBe(false);
    expect(o.result.results.find((r: any) => r.text === "fine").status).toBe("completed");
  });

  it("编排：全部子任务失败 → isError=true", async () => {
    const run = async (m: AnyMod) => {
      const result = await m.orchestrateSubagents({
        tasks: ["甲", "乙"],
        role: "scout",
        roleSpec: m.SUBAGENT_ROLES.scout,
        toolKey: "call11",
        emit: () => {},
        runTask: async () => { throw new Error("boom"); },
      });
      return result;
    };
    const [o, n] = await both(run);
    expect(n).toEqual(o);
    expect(o.isError).toBe(true);
    expect(o.results.every((r: any) => r.status === "failed" && r.text === "")).toBe(true);
  });

  it("编排：signal 已中止时直接关账 cancelled 且不调用执行器", async () => {
    const run = async (m: AnyMod) => {
      const controller = new AbortController();
      controller.abort();
      const closed: any[] = [];
      let executed = 0;
      await m.orchestrateSubagents({
        tasks: ["a"],
        role: "scout",
        roleSpec: m.SUBAGENT_ROLES.scout,
        toolKey: "call6",
        signal: controller.signal,
        emit: (type: string, data: any) => { if (type === "subagent_closed") closed.push(data); },
        runTask: async () => { executed += 1; return { text: "不应执行", isError: false, childId: "x" }; },
      });
      return { closed, executed };
    };
    const [o, n] = await both(run);
    expect(n).toEqual(o);
    expect(o.closed.map((c: any) => c.finalStatus)).toEqual(["cancelled"]);
    expect(o.executed).toBe(0);
  });

  it("编排：空任务列表抛同文案错误", async () => {
    const run = async (m: AnyMod) => {
      try {
        await m.orchestrateSubagents({ tasks: ["", "   "], toolKey: "k", runTask: async () => ({ text: "x", isError: false }) });
        return "no-throw";
      } catch (error) {
        return (error as Error).message;
      }
    };
    const [o, n] = await both(run);
    expect(o).toBe("orchestrateSubagents 需要至少一个非空子任务");
    expect(n).toBe(o);
  });

  it("编排：G3 契约——所有子代理事件携带 parentToolCallId", async () => {
    const run = async (m: AnyMod) => {
      const events: any[] = [];
      await m.orchestrateSubagents({
        tasks: ["只读检索"],
        role: "scout",
        roleSpec: m.SUBAGENT_ROLES.scout,
        toolKey: "call2",
        parentToolCallId: "tool-call-xyz",
        emit: (type: string, data: any) => events.push({ type, parent: data.parentToolCallId }),
        runTask: async (task: string, ctx: any) => ({ text: "ok", isError: false, childId: ctx.childId }),
      });
      return events;
    };
    const [o, n] = await both(run);
    expect(n).toEqual(o);
    expect(o.length).toBeGreaterThanOrEqual(4);
    for (const e of o) expect(e.parent).toBe("tool-call-xyz");
  });

  it("编排：空白任务被过滤，缺省 role=scout，单任务 childId 无序号后缀", async () => {
    const run = async (m: AnyMod) => {
      const events: any[] = [];
      const calls: string[] = [];
      await m.orchestrateSubagents({
        tasks: ["", "  ", "任务丙"],
        toolKey: "call9",
        emit: (type: string, data: any) => events.push({ type, role: data.role, childId: data.childId }),
        runTask: async (task: string, ctx: any) => { calls.push(task); return { text: task, isError: false, childId: ctx.childId }; },
      });
      return { events, calls };
    };
    const [o, n] = await both(run);
    expect(n).toEqual(o);
    expect(o.calls).toEqual(["任务丙"]);
    expect(o.events.every((e: any) => e.role === "scout")).toBe(true);
    expect(o.events[0].childId).toBe("subagent_call9");
  });

  it("编排：完成顺序乱序时 results/汇总仍按 roster 顺序", async () => {
    const run = async (m: AnyMod) => {
      const events: any[] = [];
      const result = await m.orchestrateSubagents({
        tasks: ["慢任务", "快任务甲", "快任务乙"],
        role: "scout",
        roleSpec: m.SUBAGENT_ROLES.scout,
        toolKey: "key",
        parentToolCallId: "p1",
        emit: (type: string, data: any) => events.push({ type, childId: data.childId }),
        runTask: async (task: string, ctx: any) => {
          const ticks = ctx.index === 0 ? 12 : 2;
          for (let i = 0; i < ticks; i += 1) await Promise.resolve();
          return { text: `out-${ctx.index}`, isError: false, childId: ctx.childId };
        },
      });
      return { events, result };
    };
    const [o, n] = await both(run);
    expect(n).toEqual(o);
    expect(o.result.results.map((r: any) => r.childId)).toEqual(["subagent_key_1", "subagent_key_2", "subagent_key_3"]);
    expect(o.result.text.indexOf("### 子任务 1")).toBeLessThan(o.result.text.indexOf("### 子任务 2"));
    expect(o.result.text.indexOf("### 子任务 2")).toBeLessThan(o.result.text.indexOf("### 子任务 3"));
  });
});