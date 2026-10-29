/**
 * B6-6-3 行为覆盖：agent.mjs emit 助手批（emitChannelSafe / emitToolOutput / emitAbortedOnce）
 * + stream-connection.mjs 工具输出分片族（按字节切分 / 工具输出分片 / 工具输出帧上限）。
 *
 * R6-6b 对拍退役改写：旧侧行号提取源码段 + new Function 求值随 server 退役删除，
 * 仅保留 TS 侧断言（期望值此前已经双侧对拍固化，现改为直接断言）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHANNEL_HISTORY_LIMIT, PROTOCOL_VERSION } from "../src/shared/runtime/event-protocol";
import { 按字节切分, 工具输出分片, 工具输出帧上限 } from "../src/main/backend/agent/tool-output-split";
import { emitChannelSafe, emitToolOutput, emitAbortedOnce, type EmitDeps, type EmitFlags } from "../src/main/backend/agent/emit-helpers";

type RecordCall = [unknown, unknown, unknown];
function makeRecord(opts: { throwOnCall?: boolean } = {}) {
  const calls: RecordCall[] = [];
  const fn = (id: unknown, type: unknown, data: unknown) => {
    calls.push([id, type, data]);
    if (opts.throwOnCall) throw new Error("persist boom");
  };
  return { fn, calls };
}
function makeEmit() {
  const calls: Array<[string, any]> = [];
  return { emit: (type: string, data: any) => { calls.push([type, data]); }, calls };
}
function makeEntry(overrides: Record<string, unknown> = {}) {
  const emitted: any[] = [];
  const entry: any = {
    activeRunId: "run-1",
    channel: {
      streamId: "stream_test",
      seq: 0,
      history: [] as any[],
      historyLimit: 0,
      lastEmitAt: 0,
      emitter: { emit: (_type: string, ev: any) => { emitted.push(ev); return true; } },
    },
    ...overrides,
  };
  return { entry, emitted };
}
const FLAGS_OFF: EmitFlags = { qoderToolOutputSplit: false, qoderDrainOnAbort: false };
const FLAGS_ON: EmitFlags = { qoderToolOutputSplit: true, qoderToolOutputFrameMaxBytes: 256 * 1024, qoderDrainOnAbort: true, qoderDrainMaxMs: 1500, qoderDrainQuietMs: 300 };

afterEach(() => {
  vi.useRealTimers();
});

describe("B6-6-3 工具输出分片族行为覆盖", () => {
  it("按字节切分样本（含多字节边界与上限回落）", () => {
    const samples: Array<[unknown, unknown]> = [
      ["", undefined],
      [undefined, undefined],
      [null, 1024],
      ["abc", undefined],
      ["中文字符串测试", 8],
      ["😀😀😀😀", 8],
      ["中文😀混合文本 abc 123", 16],
      ["a".repeat(3000), 1024],
      ["a".repeat(3000), 1023],
      ["ab😀cd😀ef", 3],
      [123, undefined],
      ["hello", "abc"],
      ["hello", 0],
      ["hello", -5],
      ["段落一。段落二。", 10],
    ];
    for (const [文本, 上限] of samples) {
      const 片段 = 上限 === undefined ? 按字节切分(文本) : 按字节切分(文本, 上限);
      // 上限回落：非法/不足 1024 时按默认 256 KiB 计
      const 上限数字 = Math.max(1024, Number(上限) || 256 * 1024);
      expect(片段.join("")).toBe(String(文本 ?? ""));
      for (const 片 of 片段) expect(Buffer.byteLength(片, "utf8")).toBeLessThanOrEqual(上限数字);
    }
  });

  it("工具输出分片样本（单帧同形 / delta 帧字段 / null 载荷）", () => {
    const big = "中".repeat(700); // 2100 字节 > 上限 1024 → 多片
    const samples: Array<[any, unknown]> = [
      [{ output: "hello", toolCallId: "t1", name: "bash" }, undefined],
      [{ output: big, toolCallId: "t2", name: "read" }, 1024],
      [{ output: big }, undefined],
      [null, undefined],
      [undefined, undefined],
      [{}, undefined],
      [{ output: "", toolCallId: "t3" }, 1024],
      [{ output: "ok", toolCallId: null, name: null }, 1024],
      [{ output: "x", extra: { nested: true } }, 1024],
    ];
    for (const [载荷, 上限] of samples) {
      const frames = 工具输出分片(载荷, 上限);
      expect(Array.isArray(frames)).toBe(true);
      expect(frames.length).toBeGreaterThanOrEqual(1);
      for (const frame of frames) expect(["tool_output", "tool_output_delta"]).toContain(frame.type);
    }
    // 语义抽查：未超限单帧 data 与载荷同引用；超限首帧 replace + delta 追加
    const small = { output: "hi", toolCallId: "t9", name: "n" };
    expect(工具输出分片(small, 1024)).toEqual([{ type: "tool_output", data: small }]);
    const frames = 工具输出分片({ output: big, toolCallId: "t2", name: "read" }, 1024);
    expect(frames.length).toBeGreaterThan(1);
    const first = frames[0]!;
    expect(first.type).toBe("tool_output");
    expect(first.data.output).toBe(big.slice(0, first.data.output.length));
    for (let i = 1; i < frames.length; i += 1) {
      expect(frames[i]).toEqual({
        type: "tool_output_delta",
        data: { toolCallId: "t2", name: "read", output: frames[i]!.data.output, index: i, frames: frames.length },
      });
    }
  });

  it("工具输出帧上限解析：非法/不足 1024 回落默认 256 KiB，合法值 floor", () => {
    const cases: Array<[unknown, number]> = [
      [undefined, 256 * 1024],
      [0, 256 * 1024],
      [1023, 256 * 1024],
      [1024, 1024],
      [2048.9, 2048],
      [-5, 256 * 1024],
      ["1024", 1024],
      ["abc", 256 * 1024],
      [1024 * 1024, 1024 * 1024],
      [Number.NaN, 256 * 1024],
      [Number.POSITIVE_INFINITY, 256 * 1024],
    ];
    for (const [值, expected] of cases) expect(工具输出帧上限(值)).toBe(expected);
  });
});

describe("B6-6-3 emitChannelSafe 行为覆盖", () => {
  it("信封形状与投递序列", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const record = makeRecord();
    const { entry, emitted } = makeEntry();
    emitChannelSafe(entry, "token", { text: "hi" }, {}, { recordRunEvent: record.fn });
    const ev = entry.channel.history[0];
    expect(ev).toEqual({
      id: 1,
      type: "token",
      at: "2026-01-01T00:00:00.000Z",
      streamId: "stream_test",
      protocolVersion: PROTOCOL_VERSION,
      data: { text: "hi", runId: "run-1" },
    });
    expect(entry.channel.seq).toBe(1);
    expect(entry.channel.historyLimit).toBe(CHANNEL_HISTORY_LIMIT);
    expect(entry.channel.lastEmitAt).toBe(Date.now());
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toBe(ev);
  });

  it("runId 注入矩阵", () => {
    const cases: Array<{ name: string; data: any; activeRunId?: unknown; expectRunId: unknown }> = [
      { name: "data 自带 runId 保留", data: { runId: "own" }, activeRunId: "run-1", expectRunId: "own" },
      { name: "data 无 runId 取 entry", data: { text: "x" }, activeRunId: "run-1", expectRunId: "run-1" },
      { name: "data.runId 显式 undefined 取 entry", data: { runId: undefined, text: "x" }, activeRunId: "run-1", expectRunId: "run-1" },
      { name: "entry 无 activeRunId 回 null", data: { text: "x" }, activeRunId: null, expectRunId: null },
      { name: "非对象字符串包 value", data: "hello", activeRunId: "run-1", expectRunId: "run-1" },
      { name: "数字包 value", data: 42, activeRunId: "run-1", expectRunId: "run-1" },
      { name: "null 包 value", data: null, activeRunId: "run-1", expectRunId: "run-1" },
      { name: "数组包 value", data: [1, 2], activeRunId: "run-1", expectRunId: "run-1" },
    ];
    for (const { name, data, activeRunId, expectRunId } of cases) {
      const { entry } = makeEntry({ activeRunId });
      const ev: any = (() => { emitChannelSafe(entry, "evt", data); return entry.channel.history[0]; })();
      expect(ev.data.runId, name).toBe(expectRunId);
      // 剥时钟字段后的信封形状（id/type/streamId/protocolVersion 固定）
      expect({ id: ev.id, type: ev.type, streamId: ev.streamId, protocolVersion: ev.protocolVersion }, name).toEqual({
        id: 1,
        type: "evt",
        streamId: "stream_test",
        protocolVersion: PROTOCOL_VERSION,
      });
    }
  });

  it("persist 矩阵：默认持久化 / data null 兜 {} / persist false / 无 activeRunId", () => {
    const cases: Array<{ name: string; data: any; persist?: boolean; activeRunId?: unknown; called: boolean }> = [
      { name: "默认持久化", data: { text: "x" }, activeRunId: "run-1", called: true },
      { name: "data null 兜 {}", data: null, activeRunId: "run-1", called: true },
      { name: "persist false 不落盘", data: { text: "x" }, persist: false, activeRunId: "run-1", called: false },
      { name: "无 activeRunId 不落盘", data: { text: "x" }, activeRunId: null, called: false },
      { name: "activeRunId 空串不落盘", data: { text: "x" }, activeRunId: "", called: false },
    ];
    for (const { name, data, persist, activeRunId, called } of cases) {
      const record = makeRecord();
      const { entry } = makeEntry({ activeRunId });
      const options = persist === undefined ? {} : { persist };
      emitChannelSafe(entry, "evt", data, options, { recordRunEvent: record.fn });
      if (called) expect(record.calls, name).toEqual([[activeRunId, "evt", data || {}]]);
      else expect(record.calls, name).toEqual([]);
      // 事件照发不受持久化开关影响
      expect(entry.channel.history, name).toHaveLength(1);
    }
  });

  it("recordRunEvent 抛错被内层吞掉、事件照发；emitter 抛错被外层吞掉", () => {
    const record = makeRecord({ throwOnCall: true });
    const { entry } = makeEntry();
    expect(() => emitChannelSafe(entry, "evt", { ok: 1 }, {}, { recordRunEvent: record.fn })).not.toThrow();
    expect(record.calls).toEqual([["run-1", "evt", { ok: 1 }]]);
    expect(entry.channel.history).toHaveLength(1);
    // emitter 抛错：外层 catch 吞掉，无异常逃逸；persist 在 emitter 之后，不再触达
    const boom = makeEntry();
    boom.entry.channel.emitter = { emit: () => { throw new Error("emit boom"); } };
    expect(() => emitChannelSafe(boom.entry, "evt", { ok: 1 }, {}, { recordRunEvent: record.fn })).not.toThrow();
    expect(record.calls).toHaveLength(1);
    expect(boom.entry.channel.history).toHaveLength(1);
    expect(boom.entry.channel.seq).toBe(1);
  });

  it("连续投递 seq 递增且通道历史经 pushChannelEvent 入队", () => {
    const { entry } = makeEntry();
    for (let i = 0; i < 5; i += 1) emitChannelSafe(entry, "evt", { i });
    expect(entry.channel.seq).toBe(5);
    expect(entry.channel.history.map((ev: any) => ev.id)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("B6-6-3 emitToolOutput 行为覆盖", () => {
  it("开关关闭：执行基线 emit(\"tool_output\", payload) 逐字未变", () => {
    const big = { output: "x".repeat(999999), toolCallId: "t1", name: "bash" };
    for (const payload of [{ output: "small" }, big]) {
      const n = makeEmit();
      expect(emitToolOutput(n.emit, payload, { flags: FLAGS_OFF })).toBe(1);
      expect(n.calls).toEqual([["tool_output", payload]]);
    }
  });

  it("开关开启 + 输出未超限：单帧同形返回 1", () => {
    const n = makeEmit();
    const payload = { output: "ok", toolCallId: "t1", name: "bash" };
    const deps: EmitDeps = { flags: FLAGS_ON };
    expect(emitToolOutput(n.emit, payload, deps)).toBe(1);
    expect(n.calls).toEqual([["tool_output", payload]]);
  });

  it("开关开启 + 超限：首帧 tool_output + delta 帧序列，返回帧数", () => {
    const output = "中文".repeat(600); // 2400 字节 > 上限 1024
    const payload = { output, toolCallId: "t2", name: "officecli" };
    const flags: EmitFlags = { ...FLAGS_ON, qoderToolOutputFrameMaxBytes: 1024 };
    const n = makeEmit();
    const count = emitToolOutput(n.emit, payload, { flags });
    expect(count).toBeGreaterThan(1);
    expect(n.calls[0]![0]).toBe("tool_output");
    expect(n.calls[0]![1].output.length).toBeLessThan(output.length);
    for (let i = 1; i < n.calls.length; i += 1) expect(n.calls[i]![0]).toBe("tool_output_delta");
  });

  it("帧上限取自 flags.qoderToolOutputFrameMaxBytes（非法值回落默认）", () => {
    const output = "字".repeat(400); // 1200 字节
    for (const frameMax of [1024, "abc", undefined]) {
      const flags: EmitFlags = { ...FLAGS_ON, qoderToolOutputFrameMaxBytes: frameMax };
      const n = makeEmit();
      const count = emitToolOutput(n.emit, { output }, { flags });
      // 1024 → 多帧；"abc"/undefined → 回落 256 KiB → 单帧
      if (frameMax === 1024) expect(count).toBeGreaterThan(1);
      else expect(count).toBe(1);
    }
  });
});

describe("B6-6-3 emitAbortedOnce 行为覆盖", () => {
  it("entry 为空返回 false", () => {
    expect(emitAbortedOnce(null, "x", { flags: FLAGS_OFF })).toBe(false);
  });

  it("开关关闭：立即 aborted 且 persist 走 recordRunEvent", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const record = makeRecord();
    const { entry, emitted } = makeEntry();
    expect(emitAbortedOnce(entry, "用户请求中断", { flags: FLAGS_OFF, recordRunEvent: record.fn })).toBe(true);
    expect(emitted.map((ev: any) => ({ type: ev.type, data: ev.data }))).toEqual([
      { type: "aborted", data: { runId: "run-1", reason: "用户请求中断" } },
    ]);
    expect(entry.abortedEmittedRunId).toBe("run-1");
    expect(record.calls).toContainEqual(["run-1", "aborted", { runId: "run-1", reason: "用户请求中断" }]);
  });

  it("幂等：同 entry 二次调用返回 false 不重发；runId 变化后可再次发", () => {
    const { entry, emitted } = makeEntry();
    expect(emitAbortedOnce(entry, "r1", { flags: FLAGS_OFF })).toBe(true);
    expect(emitAbortedOnce(entry, "r1", { flags: FLAGS_OFF })).toBe(false);
    expect(emitted).toHaveLength(1);
    entry.activeRunId = "run-2";
    expect(emitAbortedOnce(entry, "r2", { flags: FLAGS_OFF })).toBe(true);
    expect(emitted).toHaveLength(2);
    expect(emitted[1].data).toEqual({ runId: "run-2", reason: "r2" });
  });

  it("no-run 令牌：runId null 时按 no-run:<abortRequestedAt> 幂等，两 entry 独立", () => {
    const a = makeEntry({ activeRunId: null, abortRequestedAt: 123 });
    const b = makeEntry({ activeRunId: null, abortRequestedAt: 456 });
    expect(emitAbortedOnce(a.entry, "x", { flags: FLAGS_OFF })).toBe(true);
    expect(emitAbortedOnce(a.entry, "x", { flags: FLAGS_OFF })).toBe(false);
    expect(emitAbortedOnce(b.entry, "x", { flags: FLAGS_OFF })).toBe(true);
    expect(a.entry.abortedEmittedRunId).toBe("no-run:123");
    expect(a.entry.channel.history[0].data.runId).toBe(null);
  });

  it("开关开启：先 run_draining，通道静默 300ms 后 aborted（drained: true），drainTimer 清空", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const { entry, emitted } = makeEntry();
    expect(emitAbortedOnce(entry, "中断", { flags: FLAGS_ON })).toBe(true);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].type).toBe("run_draining");
    expect(emitted[0].data).toEqual({ runId: "run-1", reason: "中断", quietMs: 300, maxMs: 1500 });
    expect(typeof entry.drainTimer).not.toBe("undefined");
    expect(entry.drainTimer).not.toBe(null);
    vi.advanceTimersByTime(300);
    expect(emitted).toHaveLength(2);
    expect(emitted[1].type).toBe("aborted");
    expect(emitted[1].data).toEqual({ runId: "run-1", reason: "中断", drained: true });
    expect(entry.drainTimer).toBe(null);
  });

  it("开关开启：排空期持续新事件则按 1500ms 上限强制 aborted（drained: false）", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const { entry, emitted } = makeEntry();
    emitAbortedOnce(entry, "中断", { flags: FLAGS_ON });
    // 模拟排空期间通道不断有新事件：每次 100ms 步进后把 lastEmitAt 推到当前时刻（settle 已在本次步进内执行完）
    for (let step = 1; step <= 13; step += 1) {
      vi.advanceTimersByTime(100);
      const now = Date.now();
      if (entry.drainTimer) entry.channel.lastEmitAt = now;
    }
    // 累计 1300ms 仍在静默判定窗口内；继续推进到 1500ms 上限强制 aborted（此时 idleFor < quietMs → drained: false）
    vi.advanceTimersByTime(400);
    expect(emitted.filter((ev: any) => ev.type === "aborted")).toHaveLength(1);
    const aborted = emitted.find((ev: any) => ev.type === "aborted");
    expect(aborted.data).toEqual({ runId: "run-1", reason: "中断", drained: false });
    expect(entry.drainTimer).toBe(null);
  });

  it("开关开启：幂等令牌置位后第二条收尾路径不重复排空或重发", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const { entry, emitted } = makeEntry();
    expect(emitAbortedOnce(entry, "中断", { flags: FLAGS_ON })).toBe(true);
    expect(emitAbortedOnce(entry, "中断", { flags: FLAGS_ON })).toBe(false);
    expect(emitted.filter((ev: any) => ev.type === "run_draining")).toHaveLength(1);
    vi.advanceTimersByTime(300);
    expect(emitted.filter((ev: any) => ev.type === "aborted")).toHaveLength(1);
  });

  it("排空参数取自 flags（drainMaxMs/drainQuietMs，非法回落默认）", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    for (const [maxMs, quietMs] of [[800, 200], ["abc", undefined], [10, 5]] as const) {
      const flags: EmitFlags = { qoderDrainOnAbort: true, qoderDrainMaxMs: maxMs, qoderDrainQuietMs: quietMs };
      const { entry, emitted } = makeEntry();
      emitAbortedOnce(entry, "x", { flags });
      expect(emitted[0].data.quietMs).toBe(Math.max(50, Number(quietMs) || 300));
      expect(emitted[0].data.maxMs).toBe(Math.max(100, Number(maxMs) || 1500));
      vi.clearAllTimers();
    }
  });
});
