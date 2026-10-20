import { describe, it, expect } from "vitest";
import {
  STAGE_KEYS,
  markRunTiming,
  attachRunTimingMeta,
  attachRunTimingSpans,
  finishRunTiming,
  mergeClientTiming,
  latencySampleCount,
  percentile,
  latencySummary,
  recentLatencySamples
} from "../src/shared/runtime/first-token-latency";

const serverModule = await import("../../server/first-token-latency.mjs");
const server = serverModule as unknown as typeof import("../src/shared/runtime/first-token-latency");

// 样本里的 at/updatedAt 来自 Date.now()，对拍时剥离（结构字段必须逐个一致）
const stripVolatile = (value: unknown): Record<string, unknown> => {
  const clone = { ...((value ?? {}) as Record<string, unknown>) };
  delete clone.at;
  delete clone.updatedAt;
  return clone;
};

describe("first-token-latency TS 版与 server 版等价（对拍）", () => {
  it("STAGE_KEYS 与 percentile 计算一致", () => {
    expect([...STAGE_KEYS]).toEqual([...server.STAGE_KEYS]);
    expect(percentile([3, 1, 2], 50)).toBe(server.percentile([3, 1, 2], 50));
    expect(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 95)).toBe(server.percentile(Array.from({ length: 100 }, (_, i) => i + 1), 95));
    expect(percentile([1, 2, 3, 4], 95)).toBe(server.percentile([1, 2, 3, 4], 95));
    expect(percentile([], 50)).toBe(server.percentile([], 50));
    expect(percentile(null, 50)).toBe(server.percentile(null, 50));
    expect(percentile(["5", 7], 50)).toBe(server.percentile(["5", 7], 50));
    expect(percentile([Infinity, 2], 50)).toBe(server.percentile([Infinity, 2], 50));
  });

  it("阶段打点/元数据/细分耗时/终态结算逐字段一致", () => {
    expect(markRunTiming("r1", "clientSubmitAt", 1000)).not.toBeNull();
    markRunTiming("r1", "clientSubmitAt", 1000);
    server.markRunTiming("r1", "clientSubmitAt", 1000);
    attachRunTimingMeta("r1", { model: "m1" });
    server.attachRunTimingMeta("r1", { model: "m1" });
    // 非法 span（负数/非数字）被丢弃，正数四舍五入
    attachRunTimingSpans("r1", { admission: 12.4, dispatch: -3, bad: "x" });
    server.attachRunTimingSpans("r1", { admission: 12.4, dispatch: -3, bad: "x" });
    markRunTiming("r1", "firstTextDeltaAt", 1500);
    server.markRunTiming("r1", "firstTextDeltaAt", 1500);
    // 同阶段只记第一次
    markRunTiming("r1", "clientSubmitAt", 9999);
    server.markRunTiming("r1", "clientSubmitAt", 9999);
    // 非法阶段名/runId → null
    expect(markRunTiming("r2", "nope", 1)).toBeNull();
    expect(markRunTiming("", "clientSubmitAt", 1)).toBeNull();
    expect(server.markRunTiming("r2", "nope", 1)).toBeNull();
    expect(server.markRunTiming("", "clientSubmitAt", 1)).toBeNull();

    const df = finishRunTiming("r1", { client: { firstEventAt: 1200 }, mode: "agent" });
    const sf = server.finishRunTiming("r1", { client: { firstEventAt: 1200 }, mode: "agent" });
    expect(stripVolatile(df)).toEqual(stripVolatile(sf));
    expect(latencySampleCount()).toBe(server.latencySampleCount());
    expect(df?.spans).toEqual({ admission: 12 });
    expect(sf?.spans).toEqual({ admission: 12 });
  });

  it("客户端上报先于/后于终态两种顺序都落到同一条样本", () => {
    // 顺序一：先 merge（进 pending），再打点结算
    expect(mergeClientTiming("r3", { firstTextDeltaAt: 200, bogus: 5 }, { model: "m2" })).toEqual(server.mergeClientTiming("r3", { firstTextDeltaAt: 200, bogus: 5 }, { model: "m2" }));
    markRunTiming("r3", "serverReceivedAt", 50);
    server.markRunTiming("r3", "serverReceivedAt", 50);
    const df1 = finishRunTiming("r3", { client: { firstDomTextAt: 300 } });
    const sf1 = server.finishRunTiming("r3", { client: { firstDomTextAt: 300 } });
    expect(stripVolatile(df1)).toEqual(stripVolatile(sf1));
    expect(df1?.tokenToDomMs).toBe(100);
    expect(df1?.submitToFirstDomTextMs).toBe(null);
    // 顺序二：样本已结算，直接补写并重算分项
    expect(mergeClientTiming("r3", { firstEventAt: 80 }, { model: "m3", mode: "agent" })).toEqual(server.mergeClientTiming("r3", { firstEventAt: 80 }, { model: "m3", mode: "agent" }));
    expect(mergeClientTiming("", { firstEventAt: 1 })).toEqual({ merged: false, finalized: false });
    expect(mergeClientTiming("r4", {}, {})).toEqual({ merged: false, finalized: false });
    expect(mergeClientTiming("r4", { bogus: 1 }, {})).toEqual({ merged: false, finalized: false });
    expect(server.mergeClientTiming("", { firstEventAt: 1 })).toEqual({ merged: false, finalized: false });
    expect(server.mergeClientTiming("r4", {}, {})).toEqual({ merged: false, finalized: false });
    expect(server.mergeClientTiming("r4", { bogus: 1 }, {})).toEqual({ merged: false, finalized: false });
    // 仅客户端打点（无服务端阶段）也可结算成样本（firstEventAt 属于合法阶段）
    expect(stripVolatile(finishRunTiming("r9", { client: { firstEventAt: 1 } }))).toEqual(stripVolatile(server.finishRunTiming("r9", { client: { firstEventAt: 1 } })));
    expect(finishRunTiming("", {})).toBeNull();
    expect(server.finishRunTiming("", {})).toBeNull();
  });

  it("聚合 summary / recentSamples（剥离时间戳）一致", () => {
    const ds = latencySummary();
    const ss = server.latencySummary();
    expect(ds.sampleCount).toBe(ss.sampleCount);
    expect(ds.pendingRunCount).toBe(ss.pendingRunCount);
    expect(ds.stages).toEqual(ss.stages);
    expect(ds.spans).toEqual(ss.spans);
    expect(ds.models).toEqual(ss.models);
    expect(recentLatencySamples(1).map(stripVolatile)).toEqual(server.recentLatencySamples(1).map(stripVolatile));
    expect(recentLatencySamples(50).map(stripVolatile)).toEqual(server.recentLatencySamples(50).map(stripVolatile));
    expect(recentLatencySamples("bad")).toEqual(recentLatencySamples(20));
  });
});
