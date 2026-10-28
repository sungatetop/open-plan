// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import * as desktop from "../src/renderer/lib/feature-flags";

const serverModule = await import("../../client/src/feature-flags.js");
const server = serverModule as unknown as typeof desktop;

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as Record<string, unknown>).opDesktop;
});

/**
 * 新侧假桥：op:status:get 应答可控。
 * 架构性等价替换（BRD-009）：TS 版 initRuntimeFlags 已切 IPC 通道，旧 client 版仍走
 * fetch("/api/status")——两侧传输面不同属架构约定，对拍口径为快照消费语义（flag/numberFlag）。
 */
function stubDesktopStatus(data: unknown, mode: "ok" | "fail" = "ok"): Array<{ channel: string }> {
  const calls: Array<{ channel: string }> = [];
  (window as unknown as Record<string, unknown>).opDesktop = {
    invoke: async (channel: string) => {
      calls.push({ channel });
      if (channel !== "op:status:get") return { ok: false, status: 404, data: {} };
      if (mode === "fail") throw new Error("bridge down");
      return { ok: true, status: 200, data };
    }
  };
  return calls;
}

describe("feature-flags（前端只读消费端）TS 版与 client 版等价（对拍）", () => {
  it("成功路径：快照生效，flag/numberFlag 逐名一致", async () => {
    const flags = { ffAlpha: true, ffBeta: "yes", ffNum: "42", ffZero: 0, ffBool: true, ffNeg: "-5", ffNan: "abc" };
    const fetchMock = vi.fn(() => Promise.resolve({
      json: () => ({ runtimeFlags: flags }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const ipcCalls = stubDesktopStatus({ runtimeFlags: flags });
    await Promise.all([desktop.initRuntimeFlags(), server.initRuntimeFlags(), desktop.flagsReady, server.flagsReady]);
    // 旧侧走 HTTP，新侧走 op:status:get 通道（各拉一次）
    expect(fetchMock).toHaveBeenCalledWith("/api/status", { cache: "no-store" });
    expect(ipcCalls).toEqual([{ channel: "op:status:get" }]);
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

  it("runtimeFlags 非对象 / 快照缺失：快照保持不变，直到合法快照到达", async () => {
    vi.resetModules();
    // 注意：每轮 init 两侧各调一次传输（旧侧 fetch / 新侧 IPC），共用同一载荷
    let payload: unknown = { runtimeFlags: "garbage" };
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ json: () => payload })));
    stubDesktopStatus(payload);
    const d = await import("../src/renderer/lib/feature-flags");
    const s = (await import("../../client/src/feature-flags.js")) as unknown as typeof d;
    await Promise.all([d.initRuntimeFlags(), s.initRuntimeFlags(), d.flagsReady, s.flagsReady]);
    expect(d.flag("late")).toBe(false);
    expect(s.flag("late")).toBe(false);
    payload = null; // 快照缺失
    stubDesktopStatus(payload);
    await Promise.all([d.initRuntimeFlags(), s.initRuntimeFlags()]);
    expect(d.flag("late")).toBe(false); // 快照缺失 → 不更新
    expect(s.flag("late")).toBe(false);
    payload = { runtimeFlags: { late: true } }; // 合法快照
    stubDesktopStatus(payload);
    await Promise.all([d.initRuntimeFlags(), s.initRuntimeFlags()]);
    expect(d.flag("late")).toBe(true); // 合法快照 → 更新
    expect(s.flag("late")).toBe(true);
  });

  it("通道/网络失败：保持全关且 flagsReady 仍 resolve", async () => {
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("net down"))));
    stubDesktopStatus(null, "fail");
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
