import { describe, it, expect, vi, afterEach } from "vitest";
import * as desktop from "../src/renderer/lib/feature-flags";

const serverModule = await import("../../client/src/feature-flags.js");
const server = serverModule as unknown as typeof desktop;

afterEach(() => { vi.unstubAllGlobals(); });

describe("feature-flags（前端只读消费端）TS 版与 client 版等价（对拍）", () => {
  it("成功路径：快照生效，flag/numberFlag 逐名一致", async () => {
    const fetchMock = vi.fn(() => Promise.resolve({
      json: () => ({ runtimeFlags: { ffAlpha: true, ffBeta: "yes", ffNum: "42", ffZero: 0, ffBool: true, ffNeg: "-5", ffNan: "abc" } }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    await Promise.all([desktop.initRuntimeFlags(), server.initRuntimeFlags(), desktop.flagsReady, server.flagsReady]);
    expect(fetchMock).toHaveBeenCalledWith("/api/status", { cache: "no-store" });
    const names: unknown[] = ["ffAlpha", "ffBeta", "ffNum", "ffZero", "ffBool", "ffNeg", "ffNan", "unknown", "", undefined, 123, {}];
    for (const name of names) {
      expect(desktop.flag(name)).toBe(server.flag(name));
      expect(desktop.numberFlag(name, 7)).toBe(server.numberFlag(name, 7));
      expect(desktop.numberFlag(name)).toBe(server.numberFlag(name));
    }
    // 绝对锚点
    expect(desktop.flag("ffAlpha")).toBe(true);
    expect(desktop.flag("ffBool")).toBe(true); // === true 判定
    expect(desktop.flag("ffBeta")).toBe(false);
    expect(desktop.flag("unknown")).toBe(false);
    expect(desktop.numberFlag("ffNum")).toBe(42); // 字符串数字
    expect(desktop.numberFlag("ffBool")).toBe(1); // Number(true) = 1
    expect(desktop.numberFlag("ffZero")).toBe(0); // 非 >0 → fallback(默认0)
    expect(desktop.numberFlag("unknown")).toBe(0);
    expect(desktop.numberFlag("missing", 9)).toBe(9);
    expect(desktop.numberFlag("ffNeg")).toBe(0); // 负数 → fallback
    expect(desktop.numberFlag("ffNan", 3)).toBe(3); // NaN → fallback
  });

  it("r.runtimeFlags 非对象 / r 为 null：快照保持不变，直到合法快照到达", async () => {
    vi.resetModules();
    // 注意：每轮 initRuntimeFlags 两侧各调一次 fetch，共用同一响应
    let payload: unknown = { runtimeFlags: "garbage" };
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ json: () => payload })));
    const d = await import("../src/renderer/lib/feature-flags");
    const s = (await import("../../client/src/feature-flags.js")) as unknown as typeof d;
    await Promise.all([d.initRuntimeFlags(), s.initRuntimeFlags(), d.flagsReady, s.flagsReady]);
    expect(d.flag("late")).toBe(false);
    expect(s.flag("late")).toBe(false);
    payload = null; // r 为 null
    await Promise.all([d.initRuntimeFlags(), s.initRuntimeFlags()]);
    expect(d.flag("late")).toBe(false); // r 为 null → 不更新
    expect(s.flag("late")).toBe(false);
    payload = { runtimeFlags: { late: true } }; // 合法快照
    await Promise.all([d.initRuntimeFlags(), s.initRuntimeFlags()]);
    expect(d.flag("late")).toBe(true); // 合法快照 → 更新
    expect(s.flag("late")).toBe(true);
  });

  it("fetch 拒绝：保持全关且 flagsReady 仍 resolve", async () => {
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("net down"))));
    const d = await import("../src/renderer/lib/feature-flags");
    const s = (await import("../../client/src/feature-flags.js")) as unknown as typeof d;
    await Promise.all([d.initRuntimeFlags(), s.initRuntimeFlags()]);
    await Promise.all([d.flagsReady, s.flagsReady]);
    expect(d.flag("anything")).toBe(false);
    expect(s.flag("anything")).toBe(false);
    expect(d.numberFlag("anything", 3)).toBe(3);
    expect(s.numberFlag("anything", 3)).toBe(3);
  });
});
