import { describe, it, expect } from "vitest";
import {
  LATENCY_STAGES,
  getActiveProbe,
  startLatencyProbe,
  markLatency,
  patchLatencyMeta,
  markFirstDomText,
  finalizeLatencyProbe,
  reportLatencySample,
  percentile,
} from "../src/renderer/lib/first-token-latency-tracker";

const clientModule = await import("../../client/src/first-token-latency-tracker.js");
const client = clientModule as unknown as {
  LATENCY_STAGES: readonly string[];
  getActiveProbe: typeof getActiveProbe;
  startLatencyProbe: typeof startLatencyProbe;
  markLatency: typeof markLatency;
  patchLatencyMeta: typeof patchLatencyMeta;
  markFirstDomText: typeof markFirstDomText;
  finalizeLatencyProbe: typeof finalizeLatencyProbe;
  reportLatencySample: typeof reportLatencySample;
  percentile: typeof percentile;
};

/** 同一操作序列分别跑在 TS 版与 client 版上，收集全部可观察输出。 */
function runScenario(mod: {
  startLatencyProbe: typeof startLatencyProbe;
  markLatency: typeof markLatency;
  patchLatencyMeta: typeof patchLatencyMeta;
  markFirstDomText: typeof markFirstDomText;
  finalizeLatencyProbe: typeof finalizeLatencyProbe;
}): Record<string, unknown> {
  const sends: Array<{ url: string; opts: Record<string, unknown> }> = [];
  const origFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: string, opts: Record<string, unknown>) => {
    sends.push({ url, opts });
    return new Response(null, { status: 204 });
  };
  try {
    const out: Record<string, unknown> = { sends };
    out.finalizeNoProbe = mod.finalizeLatencyProbe({}, { send: false });
    out.markNoProbe = mod.markLatency("firstEventAt", 1);
    out.patchNoProbe = mod.patchLatencyMeta({ runId: "x" });

    const p1 = mod.startLatencyProbe({ clientSubmitAt: 1000 });
    out.markInvalid = p1.mark("bogusStage");
    out.markNumeric = p1.mark(42);
    out.markFirst = mod.markLatency("firstEventAt", 1300);
    out.patch = mod.patchLatencyMeta({ runId: "run-1", model: "deepseek" });
    out.patch2 = mod.patchLatencyMeta({ model: "qwen" });
    out.snapNoExtra = p1.snapshot();
    out.markText = mod.markLatency("firstTextDeltaAt", 1450);
    out.markDom1 = mod.markFirstDomText(1500);
    out.markDom2 = mod.markFirstDomText(1600);
    out.snapExtra = p1.snapshot({ extraKey: "e", runId: "run-override" });
    out.settleNoSend = p1.settle({}, { send: false });
    out.settleAgain = p1.settle();
    out.finalizeAfterSettle = mod.finalizeLatencyProbe();

    // 超替路径：p4 活动时再次 start → p4 以 reason=superseded 结算并走 fetch 上报
    mod.startLatencyProbe({ clientSubmitAt: 5000 });
    mod.startLatencyProbe({ clientSubmitAt: 6000 });
    out.finalizeP5 = mod.finalizeLatencyProbe({}, { send: false });
    out.markAfterFinal = mod.markLatency("firstEventAt", 4000);
    return out;
  } finally {
    globalThis.fetch = origFetch;
  }
}

describe("first-token-latency-tracker TS 版与 client 版等价（对拍）", () => {
  it("LATENCY_STAGES 阶段清单一致", () => {
    expect([...LATENCY_STAGES]).toEqual([...client.LATENCY_STAGES]);
  });

  it("探针全生命周期：打点/合并/快照/结算/超替/上报逐字段一致", () => {
    const ts = runScenario({ startLatencyProbe, markLatency, patchLatencyMeta, markFirstDomText, finalizeLatencyProbe });
    const js = runScenario(client);
    expect(ts).toEqual(js);

    // 绝对锚点（确定性时序下的分项耗时）
    const settle = ts.settleNoSend as Record<string, any>;
    expect(settle.clientSubmitAt).toBe(1000);
    expect(settle.runId).toBe("run-1");
    expect(settle.model).toBe("qwen");
    expect(settle.submitToFirstEventMs).toBe(300);
    expect(settle.submitToFirstTextDeltaMs).toBe(450);
    expect(settle.submitToFirstDomTextMs).toBe(500);
    expect(settle.tokenToDomMs).toBe(50);
    expect(settle.firstEventToFirstTextDeltaMs).toBe(150);
    // 首写优先：1600 的 second dom 标记不覆盖 1500
    expect(settle.firstDomTextAt).toBe(1500);
    // snapshot extra 覆盖 runId 但不污染 marks
    expect((ts.snapExtra as Record<string, any>).runId).toBe("run-override");
    expect((ts.snapExtra as Record<string, any>).extraKey).toBe("e");
    // 超替上报体：reason=superseded，POST 到 /api/agent/timing
    const sends = ts.sends as Array<{ url: string; opts: Record<string, any> }>;
    expect(sends).toHaveLength(1);
    expect(sends[0]!.url).toBe("/api/agent/timing");
    expect(sends[0]!.opts.method).toBe("POST");
    expect((sends[0]!.opts.headers as any)["Content-Type"]).toBe("application/json");
    const sentSample = JSON.parse(sends[0]!.opts.body as string);
    expect(sentSample).toMatchObject({ clientSubmitAt: 5000, reason: "superseded", runId: null });
    // finalizeP5：clientSubmitAt=6000，无其他阶段 → 分项全 null
    expect(ts.finalizeP5).toMatchObject({ clientSubmitAt: 6000, submitToFirstEventMs: null, submitToFirstTextDeltaMs: null, tokenToDomMs: null });
  });

  it("getActiveProbe 指向当前活动探针；markFirstDomText 首写优先", () => {
    const p = startLatencyProbe({ clientSubmitAt: 1000 });
    expect(getActiveProbe()).toBe(p);
    expect(getActiveProbe()!.marks).toEqual({ clientSubmitAt: 1000, runId: null });
    expect(markFirstDomText(1234)).toBe(1234);
    expect(markFirstDomText(5678)).toBe(1234);
    expect(getActiveProbe()!.marks.firstDomTextAt).toBe(1234);
    const jsP = client.startLatencyProbe({ clientSubmitAt: 1000 });
    expect(client.getActiveProbe()).toBe(jsP);
    client.markFirstDomText(1234);
    expect(client.getActiveProbe()!.marks).toEqual(getActiveProbe()!.marks);
    // 结束后清空
    finalizeLatencyProbe({}, { send: false });
    client.finalizeLatencyProbe({}, { send: false });
    expect(getActiveProbe()).toBeNull();
    expect(client.getActiveProbe()).toBeNull();
  });

  it("reportLatencySample 走 sendBeacon 时：URL 与 Blob 内容一致", async () => {
    const calls: Array<{ url: string; blob: Blob }> = [];
    const desc = Object.getOwnPropertyDescriptor(globalThis, "navigator")!;
    Object.defineProperty(globalThis, "navigator", {
      value: { sendBeacon: (url: string, blob: Blob) => { calls.push({ url, blob }); return true; } },
      configurable: true,
      writable: true,
    });
    try {
      reportLatencySample({ clientSubmitAt: 1, submitToFirstEventMs: 2 });
      client.reportLatencySample({ clientSubmitAt: 1, submitToFirstEventMs: 2 });
      expect(calls).toHaveLength(2);
      expect(calls[0]!.url).toBe("/api/agent/timing");
      expect(calls[1]!.url).toBe(calls[0]!.url);
      expect(JSON.parse(await calls[0]!.blob.text())).toEqual({ clientSubmitAt: 1, submitToFirstEventMs: 2 });
      expect(await calls[1]!.blob.type).toBe("application/json");
      expect(calls[0]!.blob.type).toBe(calls[1]!.blob.type);
    } finally {
      Object.defineProperty(globalThis, "navigator", desc);
    }
  });

  it("reportLatencySample 对异常样本静默吞掉（不抛错）", () => {
    expect(() => reportLatencySample(undefined)).not.toThrow();
    expect(() => client.reportLatencySample(undefined)).not.toThrow();
  });

  it("percentile：过滤非有限值、空样本 null、NaN p 返回 undefined，全网格对拍", () => {
    const values = [5, 1, 9, NaN, Infinity, -Infinity, 3, "7", null, 7];
    const ps = [0, 1, 10, 25, 50, 75, 90, 99, 100, 110, -5, NaN, "50", undefined, null];
    for (const p of ps) {
      expect(percentile(values, p)).toBe(client.percentile(values, p));
    }
    expect(percentile([], 50)).toBeNull();
    expect(percentile(null, 50)).toBeNull();
    expect(percentile(undefined, 50)).toBeNull();
    expect(percentile([1, 2, 3, 4], NaN)).toBeUndefined();
    expect(percentile([1], 50)).toBe(client.percentile([1], 50));
    // 绝对锚点：1..100 的 P50 = 50（ceil(0.5*100)-1=49 → 第 50 个）
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(hundred, 50)).toBe(50);
    expect(percentile(hundred, 100)).toBe(100);
    expect(percentile(hundred, 0)).toBe(1);
    expect(percentile(hundred, 75)).toBe(client.percentile(hundred, 75));
  });
});
