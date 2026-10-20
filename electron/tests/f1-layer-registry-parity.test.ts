import { describe, it, expect, vi } from "vitest";
import * as desktop from "../src/renderer/lib/layer-registry";

const serverModule = await import("../../client/src/layer-registry.js");
const server = serverModule as unknown as typeof desktop;

const catchThrow = (fn: () => unknown): string => {
  try { fn(); return "no-throw"; } catch { return "threw"; }
};

/** 两侧各跑一遍完全相同的操作序列，记录每步返回值与 console.warn 参数。 */
function runOps(mod: typeof desktop, warnings: unknown[][]): unknown[] {
  const out: unknown[] = [];
  const received: unknown[] = [];
  const replayOk = (m: unknown) => { received.push(m); };
  const replayBad = () => { throw new Error("boom"); };
  const mapA = {};
  const mapB = {};
  out.push(mod.registerLayerReplay(mapA, "k1", replayOk));
  out.push(mod.registerLayerReplay(mapA, "k1", replayOk)); // 同 key 覆盖
  out.push(mod.registerLayerReplay(mapA, "", replayOk)); // 空 key → false
  out.push(mod.registerLayerReplay(mapA, 0, replayOk)); // falsy key → false
  out.push(mod.registerLayerReplay(null, "k", replayOk)); // 空 map → false
  out.push(mod.registerLayerReplay(undefined, "k", replayOk));
  out.push(mod.registerLayerReplay(mapA, "k2", "not-a-fn")); // replay 非函数 → false
  out.push(mod.registerLayerReplay(mapB, "b1", replayOk));
  out.push(mod.listLayerReplayKeys(mapA));
  out.push(mod.listLayerReplayKeys(mapB));
  out.push(mod.listLayerReplayKeys(null));
  out.push(mod.listLayerReplayKeys(undefined));
  out.push(mod.unregisterLayerReplay(mapA, "k1"));
  out.push(mod.unregisterLayerReplay(mapA, "k1")); // 重复注销 → false
  out.push(mod.unregisterLayerReplay(null, "k1"));
  out.push(mod.replayTemporaryLayers(mapA)); // 空桶 → 0
  out.push(mod.registerLayerReplay(mapA, "bad", replayBad));
  out.push(mod.registerLayerReplay(mapA, "ok", replayOk));
  out.push(mod.replayTemporaryLayers(mapA)); // 1 成功 1 失败（console.warn）
  out.push(mod.replayTemporaryLayers(mapB)); // 1
  out.push(mod.replayTemporaryLayers({})); // 未登记 → 0
  out.push(mod.replayTemporaryLayers(null)); // 0
  out.push(mod.unregisterLayerReplay(mapA, "bad"));
  out.push(mod.replayTemporaryLayers(mapA)); // 1
  out.push(mod.clearLayerRegistry(mapB));
  out.push(mod.listLayerReplayKeys(mapB)); // []
  out.push(mod.clearLayerRegistry(null)); // no-op
  out.push(received.length); // replay 实际被调用次数
  out.push(received.every((m) => m === mapA || m === mapB)); // 收到的是本侧 map 实例
  out.push(catchThrow(() => mod.registerLayerReplay("primitive", "k", replayOk))); // WeakMap 原始键 → 抛错
  out.push(mod.unregisterLayerReplay("primitive", "k")); // get 不抛 → false
  return out;
}

describe("layer-registry TS 版与 client 版等价（对拍）", () => {
  it("登记/覆盖/注销/重放/清空 全序列一致（含 console.warn 参数）", () => {
    const warnings: unknown[][] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { warnings.push([...args]); });
    const dOut = runOps(desktop, warnings);
    const split = warnings.length;
    const sOut = runOps(server, warnings);
    expect(sOut).toEqual(dOut);
    expect(warnings.slice(split)).toEqual(warnings.slice(0, split));
    expect(warnings.length).toBe(2); // 每侧恰 1 条失败重放警告
    expect(warnings[0]).toEqual(["[图层注册表] 临时层 bad 重放失败：", "boom"]);
    spy.mockRestore();
  });

  it("返回值锚点（按 runOps 序号）", () => {
    const warnings: unknown[][] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { warnings.push([...args]); });
    const dOut = runOps(desktop, warnings);
    expect(dOut[0]).toBe(true);
    expect(dOut[2]).toBe(false); // 空 key
    expect(dOut[3]).toBe(false); // falsy key
    expect(dOut[4]).toBe(false); // null map
    expect(dOut[5]).toBe(false); // undefined map
    expect(dOut[6]).toBe(false); // replay 非函数
    expect(dOut[8]).toEqual(["k1"]); // k2 注册失败不在列
    expect(dOut[9]).toEqual(["b1"]);
    expect(dOut[10]).toEqual([]);
    expect(dOut[12]).toBe(true);
    expect(dOut[13]).toBe(false);
    expect(dOut[15]).toBe(0);
    expect(dOut[18]).toBe(1);
    expect(dOut[19]).toBe(1);
    expect(dOut[20]).toBe(0);
    expect(dOut[21]).toBe(0);
    expect(dOut[23]).toBe(1);
    expect(dOut[25]).toEqual([]);
    expect(dOut[27]).toBe(3); // mapA×2 + mapB×1
    expect(dOut[28]).toBe(true);
    expect(dOut[29]).toBe("threw"); // WeakMap 原始键
    expect(dOut[30]).toBe(false);
    spy.mockRestore();
  });
});
