import { describe, it, expect, afterEach, vi } from "vitest";
import * as desktop from "../src/renderer/lib/browser-linkage";

const serverModule = await import("../../client/src/browser-linkage.js");
const server = serverModule as unknown as typeof desktop;

describe("browser-linkage TS 版与 client 版等价（对拍）", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("初始状态一致（idle/since=0）", () => {
    expect(desktop.getBrowserStreamState()).toEqual(server.getBrowserStreamState());
    expect(desktop.getBrowserStreamState()).toEqual({ status: "idle", since: 0 });
  });

  it("setBrowserStreamState 状态流转与时间戳逐拍一致（假时钟）", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T08:00:00Z"));
    const seq: unknown[] = [
      "connected", "connected", "", null, undefined, 0, false, 123, {}, "reconnecting", "connected",
    ];
    const snaps: Array<{ status: string; since: number }> = [];
    for (let i = 0; i < seq.length; i++) {
      if (i === 4) vi.setSystemTime(new Date("2026-01-01T08:05:00Z")); // 中途推进时钟，验证变更时才刷新 since
      desktop.setBrowserStreamState(seq[i] as never);
      server.setBrowserStreamState(seq[i] as never);
      const d = desktop.getBrowserStreamState();
      expect(server.getBrowserStreamState()).toEqual(d);
      snaps.push({ ...d });
    }
    // 锚点：falsy 输入 → "idle"；相同状态早退不刷新时间戳；仅状态变化时取 Date.now()
    const t0 = Date.parse("2026-01-01T08:00:00Z");
    const t1 = Date.parse("2026-01-01T08:05:00Z");
    expect(snaps[0]).toEqual({ status: "connected", since: t0 });
    expect(snaps[1]).toEqual(snaps[0]); // 重复设置早退
    expect(snaps[2]).toEqual({ status: "idle", since: t0 }); // "" || "idle"
    expect(snaps[6]).toEqual(snaps[5]); // null/undefined/0/false 全部映射 idle 且早退
    expect(snaps[7]).toEqual({ status: "123", since: t1 });
    expect(snaps[8]).toEqual({ status: "[object Object]", since: t1 });
    expect(snaps[9]).toEqual({ status: "reconnecting", since: t1 });
    expect(snaps[10]).toEqual({ status: "connected", since: t1 });
  });
});