/**
 * B6-6-3 对拍：agent.mjs emit 助手批（emitChannelSafe / emitToolOutput / emitAbortedOnce）
 * + stream-connection.mjs 工具输出分片族（按字节切分 / 工具输出分片 / 工具输出帧上限）。
 *
 * 旧侧不加载 agent.mjs（巨石依赖链过重），按行号提取源码段 + new Function 求值（批6d-2 范式）；
 * recordRunEvent（runs 域未迁）与 flags 以参数注入旧工厂，新侧 TS 走 deps 注入，双侧同流。
 * 行号锚点断言保证源文件变动时先行失败提醒。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHANNEL_HISTORY_LIMIT, PROTOCOL_VERSION, pushChannelEvent } from "../src/shared/runtime/event-protocol";
import { 按字节切分, 工具输出分片, 工具输出帧上限 } from "../src/main/backend/agent/tool-output-split";
import { emitChannelSafe, emitToolOutput, emitAbortedOnce, type EmitDeps, type EmitFlags } from "../src/main/backend/agent/emit-helpers";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LINES_AGENT = readFileSync(path.resolve(HERE, "../../server/agent.mjs"), "utf8").split("\n");
const LINES_STREAM = readFileSync(path.resolve(HERE, "../../server/stream-connection.mjs"), "utf8").split("\n");
const segAgent = (start: number, end: number) => LINES_AGENT.slice(start - 1, end).join("\n").replace(/^export\s+/gm, "");
const segStream = (start: number, end: number) => LINES_STREAM.slice(start - 1, end).join("\n").replace(/^export\s+/gm, "");

// 行号锚点：源文件结构变动导致偏移时，这里先行失败提醒更新提取区间
expect(segAgent(4684, 4684)).toContain("function emitChannelSafe(entry, type, data, { persist = true } = {}) {");
expect(segAgent(4710, 4710)).toContain("function emitToolOutput(emit, payload) {");
expect(segAgent(4725, 4725)).toContain("function emitAbortedOnce(entry, reason = \"\") {");
expect(segAgent(4758, 4758)).toContain("}");
expect(segStream(211, 211)).toContain("function 按字节切分(文本, 上限字节 = 256 * 1024) {");
expect(segStream(238, 238)).toContain("function 工具输出分片(载荷 = {}, 上限字节 = 256 * 1024) {");
expect(segStream(252, 252)).toContain("function 工具输出帧上限(值) {");

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
/** 旧侧分片族工厂（stream-connection.mjs L210-255，无外部依赖，Buffer 为 Node 全局）。 */
function makeOldSplit() {
  return new Function(`${segStream(210, 255)}\nreturn { 按字节切分, 工具输出分片, 工具输出帧上限 };`)() as {
    按字节切分: (文本: unknown, 上限字节?: unknown) => string[];
    工具输出分片: (载荷: any, 上限字节?: unknown) => Array<{ type: string; data: any }>;
    工具输出帧上限: (值: unknown) => number;
  };
}
const oldSplit = makeOldSplit();

/** 旧侧 emit 工厂：flags/recordRunEvent 每场景注入（new Function 求值，分片实现复用 electron TS 版同一实例）。 */
function makeOldEmit(flags: EmitFlags, recordRunEvent: (id: unknown, type: unknown, data: unknown) => void) {
  return new Function(
    "RUNTIME_FLAGS",
    "recordRunEvent",
    "PROTOCOL_VERSION",
    "CHANNEL_HISTORY_LIMIT",
    "pushChannelEvent",
    "工具输出分片",
    "工具输出帧上限",
    `${segAgent(4684, 4758)}\nreturn { emitChannelSafe, emitToolOutput, emitAbortedOnce };`,
  )(flags, recordRunEvent, PROTOCOL_VERSION, CHANNEL_HISTORY_LIMIT, pushChannelEvent, 工具输出分片, 工具输出帧上限);
}
const FLAGS_OFF: EmitFlags = { qoderToolOutputSplit: false, qoderDrainOnAbort: false };
const FLAGS_ON: EmitFlags = { qoderToolOutputSplit: true, qoderToolOutputFrameMaxBytes: 256 * 1024, qoderDrainOnAbort: true, qoderDrainMaxMs: 1500, qoderDrainQuietMs: 300 };

afterEach(() => {
  vi.useRealTimers();
});

describe("B6-6-3 工具输出分片族对拍", () => {
  it("按字节切分样本双侧同流（含多字节边界与上限回落）", () => {
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
      const isNew = 上限 === undefined ? 按字节切分(文本) : 按字节切分(文本, 上限);
      const isOld = 上限 === undefined ? oldSplit.按字节切分(文本) : oldSplit.按字节切分(文本, 上限);
      expect(isNew).toEqual(isOld);
      const 上限数字 = Math.max(1024, Number(上限) || 256 * 1024);
      expect(isNew.join("")).toBe(String(文本 ?? ""));
      for (const 片 of isNew) expect(Buffer.byteLength(片, "utf8")).toBeLessThanOrEqual(上限数字);
    }
  });

  it("工具输出分片样本双侧同流（单帧同形 / delta 帧字段 / null 载荷）", () => {
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
      const isNew = 工具输出分片(载荷, 上限);
      const isOld = oldSplit.工具输出分片(载荷, 上限);
      expect(isNew).toEqual(isOld);
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

  it("工具输出帧上限解析双侧同流", () => {
    const samples: unknown[] = [undefined, 0, 1023, 1024, 2048.9, -5, "1024", "abc", 1024 * 1024, Number.NaN, Number.POSITIVE_INFINITY];
    for (const 值 of samples) expect(工具输出帧上限(值)).toBe(oldSplit.工具输出帧上限(值));
  });
});

describe("B6-6-3 emitChannelSafe 对拍", () => {
  it("信封形状与投递序列双侧同流", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const record = makeRecord();
    const old = makeOldEmit(FLAGS_OFF, record.fn);
    const { entry: newEntry, emitted: newEmitted } = makeEntry();
    const { entry: oldEntry, emitted: oldEmitted } = makeEntry();
    emitChannelSafe(newEntry, "token", { text: "hi" }, {}, { recordRunEvent: record.fn });
    old.emitChannelSafe(oldEntry, "token", { text: "hi" });
    const newEv = newEntry.channel.history[0];
    const oldEv = oldEntry.channel.history[0];
    expect(newEv).toEqual({
      id: 1,
      type: "token",
      at: "2026-01-01T00:00:00.000Z",
      streamId: "stream_test",
      protocolVersion: PROTOCOL_VERSION,
      data: { text: "hi", runId: "run-1" },
    });
    expect(newEv).toEqual(oldEv);
    expect(newEntry.channel.seq).toBe(1);
    expect(oldEntry.channel.seq).toBe(1);
    expect(newEntry.channel.historyLimit).toBe(CHANNEL_HISTORY_LIMIT);
    expect(newEntry.channel.historyLimit).toBe(oldEntry.channel.historyLimit);
    expect(newEntry.channel.lastEmitAt).toBe(Date.now());
    expect(newEntry.channel.lastEmitAt).toBe(oldEntry.channel.lastEmitAt);
    expect(newEmitted).toHaveLength(1);
    expect(newEmitted[0]).toBe(newEv);
    expect(oldEmitted).toHaveLength(1);
  });

  it("runId 注入矩阵双侧同流", () => {
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
      const record = makeRecord();
      const old = makeOldEmit(FLAGS_OFF, record.fn);
      const { entry: newEntry } = makeEntry({ activeRunId });
      const { entry: oldEntry } = makeEntry({ activeRunId });
      const newEv: any = (() => { emitChannelSafe(newEntry, "evt", data); return newEntry.channel.history[0]; })();
      const oldEv: any = (() => { old.emitChannelSafe(oldEntry, "evt", data); return oldEntry.channel.history[0]; })();
      expect(newEv.data).toEqual(oldEv.data);
      expect(newEv.data.runId).toBe(expectRunId);
      // 剥时钟字段比较（本用例不冻时钟，两侧调用可能跨毫秒）
      const { at: _newAt, ...newRest } = newEv;
      const { at: _oldAt, ...oldRest } = oldEv;
      expect(newRest).toEqual(oldRest);
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
      const recordNew = makeRecord();
      const recordOld = makeRecord();
      const old = makeOldEmit(FLAGS_OFF, recordOld.fn);
      const { entry: newEntry } = makeEntry({ activeRunId });
      const { entry: oldEntry } = makeEntry({ activeRunId });
      const options = persist === undefined ? {} : { persist };
      emitChannelSafe(newEntry, "evt", data, options, { recordRunEvent: recordNew.fn });
      old.emitChannelSafe(oldEntry, "evt", data, options);
      expect(recordNew.calls).toEqual(recordOld.calls);
      if (called) expect(recordNew.calls).toEqual([[activeRunId, "evt", data || {}]]);
      else expect(recordNew.calls).toEqual([]);
      // 事件照发不受持久化开关影响
      expect(newEntry.channel.history).toHaveLength(1);
      expect(oldEntry.channel.history).toHaveLength(1);
    }
  });

  it("recordRunEvent 抛错被内层吞掉、事件照发；emitter 抛错被外层吞掉", () => {
    const recordNew = makeRecord({ throwOnCall: true });
    const recordOld = makeRecord({ throwOnCall: true });
    const old = makeOldEmit(FLAGS_OFF, recordOld.fn);
    const { entry: newEntry } = makeEntry();
    const { entry: oldEntry } = makeEntry();
    expect(() => emitChannelSafe(newEntry, "evt", { ok: 1 }, {}, { recordRunEvent: recordNew.fn })).not.toThrow();
    expect(() => old.emitChannelSafe(oldEntry, "evt", { ok: 1 })).not.toThrow();
    expect(recordNew.calls).toEqual(recordOld.calls);
    expect(recordNew.calls).toEqual([["run-1", "evt", { ok: 1 }]]);
    expect(newEntry.channel.history).toHaveLength(1);
    expect(oldEntry.channel.history).toHaveLength(1);
    // emitter 抛错：外层 catch 吞掉，无异常逃逸；persist 在 emitter 之后，不再触达
    const { entry: boomNew } = makeEntry();
    const { entry: boomOld } = makeEntry();
    boomNew.channel.emitter = { emit: () => { throw new Error("emit boom"); } };
    boomOld.channel.emitter = { emit: () => { throw new Error("emit boom"); } };
    expect(() => emitChannelSafe(boomNew, "evt", { ok: 1 }, {}, { recordRunEvent: recordNew.fn })).not.toThrow();
    expect(() => old.emitChannelSafe(boomOld, "evt", { ok: 1 })).not.toThrow();
    expect(recordNew.calls).toHaveLength(1);
    expect(boomNew.channel.history).toHaveLength(1);
    expect(boomOld.channel.history).toHaveLength(1);
    expect(boomNew.channel.seq).toBe(1);
    expect(boomOld.channel.seq).toBe(1);
  });

  it("连续投递 seq 递增且通道历史经 pushChannelEvent 入队", () => {
    const record = makeRecord();
    const old = makeOldEmit(FLAGS_OFF, record.fn);
    const { entry: newEntry } = makeEntry();
    const { entry: oldEntry } = makeEntry();
    for (let i = 0; i < 5; i += 1) {
      emitChannelSafe(newEntry, "evt", { i });
      old.emitChannelSafe(oldEntry, "evt", { i });
    }
    expect(newEntry.channel.seq).toBe(5);
    expect(oldEntry.channel.seq).toBe(5);
    expect(newEntry.channel.history.map((ev: any) => ev.id)).toEqual([1, 2, 3, 4, 5]);
    expect(newEntry.channel.history).toEqual(oldEntry.channel.history);
  });
});

describe("B6-6-3 emitToolOutput 对拍", () => {
  it("开关关闭：执行基线 emit(\"tool_output\", payload) 逐字未变", () => {
    const big = { output: "x".repeat(999999), toolCallId: "t1", name: "bash" };
    for (const payload of [{ output: "small" }, big]) {
      const emitNew = makeEmit();
      const emitOld = makeEmit();
      const record = makeRecord();
      const old = makeOldEmit({ ...FLAGS_OFF, qoderToolOutputFrameMaxBytes: 1024 }, record.fn);
      expect(emitToolOutput(emitNew.emit, payload, { flags: FLAGS_OFF })).toBe(1);
      expect(old.emitToolOutput(emitOld.emit, payload)).toBe(1);
      expect(emitNew.calls).toEqual(emitOld.calls);
      expect(emitNew.calls).toEqual([["tool_output", payload]]);
    }
  });

  it("开关开启 + 输出未超限：单帧同形返回 1", () => {
    const emitNew = makeEmit();
    const emitOld = makeEmit();
    const payload = { output: "ok", toolCallId: "t1", name: "bash" };
    const deps: EmitDeps = { flags: FLAGS_ON };
    const old = makeOldEmit(FLAGS_ON, makeRecord().fn);
    expect(emitToolOutput(emitNew.emit, payload, deps)).toBe(1);
    expect(old.emitToolOutput(emitOld.emit, payload)).toBe(1);
    expect(emitNew.calls).toEqual(emitOld.calls);
    expect(emitNew.calls).toEqual([["tool_output", payload]]);
  });

  it("开关开启 + 超限：首帧 tool_output + delta 帧序列，返回帧数", () => {
    const output = "中文".repeat(600); // 2400 字节 > 上限 1024
    const payload = { output, toolCallId: "t2", name: "officecli" };
    const flags: EmitFlags = { ...FLAGS_ON, qoderToolOutputFrameMaxBytes: 1024 };
    const emitNew = makeEmit();
    const emitOld = makeEmit();
    const old = makeOldEmit(flags, makeRecord().fn);
    const newCount = emitToolOutput(emitNew.emit, payload, { flags });
    const oldCount = old.emitToolOutput(emitOld.emit, payload);
    expect(newCount).toBe(oldCount);
    expect(newCount).toBeGreaterThan(1);
    expect(emitNew.calls).toEqual(emitOld.calls);
    expect(emitNew.calls[0]![0]).toBe("tool_output");
    expect(emitNew.calls[0]![1].output.length).toBeLessThan(output.length);
    for (let i = 1; i < emitNew.calls.length; i += 1) expect(emitNew.calls[i]![0]).toBe("tool_output_delta");
  });

  it("帧上限取自 flags.qoderToolOutputFrameMaxBytes（非法值回落默认）", () => {
    const output = "字".repeat(400);
    for (const frameMax of [1024, "abc", undefined]) {
      const flags: EmitFlags = { ...FLAGS_ON, qoderToolOutputFrameMaxBytes: frameMax };
      const emitNew = makeEmit();
      const emitOld = makeEmit();
      const old = makeOldEmit(flags, makeRecord().fn);
      const newCount = emitToolOutput(emitNew.emit, { output }, { flags });
      const oldCount = old.emitToolOutput(emitOld.emit, { output });
      expect(newCount).toBe(oldCount);
      expect(emitNew.calls).toEqual(emitOld.calls);
    }
  });
});

describe("B6-6-3 emitAbortedOnce 对拍", () => {
  it("entry 为空返回 false（双侧）", () => {
    const old = makeOldEmit(FLAGS_OFF, makeRecord().fn);
    expect(emitAbortedOnce(null, "x", { flags: FLAGS_OFF })).toBe(false);
    expect(old.emitAbortedOnce(null, "x")).toBe(false);
  });

  it("开关关闭：立即 aborted 且 persist 走 recordRunEvent", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const recordNew = makeRecord();
    const recordOld = makeRecord();
    const old = makeOldEmit(FLAGS_OFF, recordOld.fn);
    const { entry: newEntry, emitted: newEmitted } = makeEntry();
    const { entry: oldEntry, emitted: oldEmitted } = makeEntry();
    const newRet = emitAbortedOnce(newEntry, "用户请求中断", { flags: FLAGS_OFF, recordRunEvent: recordNew.fn });
    const oldRet = old.emitAbortedOnce(oldEntry, "用户请求中断");
    expect(newRet).toBe(true);
    expect(oldRet).toBe(true);
    expect(newEmitted.map((ev: any) => ({ type: ev.type, data: ev.data }))).toEqual(oldEmitted.map((ev: any) => ({ type: ev.type, data: ev.data })));
    expect(newEmitted[0].type).toBe("aborted");
    expect(newEmitted[0].data).toEqual({ runId: "run-1", reason: "用户请求中断" });
    expect(newEntry.abortedEmittedRunId).toBe("run-1");
    expect(recordNew.calls).toEqual(recordOld.calls);
    expect(recordNew.calls).toContainEqual(["run-1", "aborted", { runId: "run-1", reason: "用户请求中断" }]);
  });

  it("幂等：同 entry 二次调用返回 false 不重发；runId 变化后可再次发", () => {
    const record = makeRecord();
    const old = makeOldEmit(FLAGS_OFF, record.fn);
    const { entry: newEntry, emitted: newEmitted } = makeEntry();
    const { entry: oldEntry, emitted: oldEmitted } = makeEntry();
    expect(emitAbortedOnce(newEntry, "r1", { flags: FLAGS_OFF })).toBe(true);
    expect(old.emitAbortedOnce(oldEntry, "r1")).toBe(true);
    expect(emitAbortedOnce(newEntry, "r1", { flags: FLAGS_OFF })).toBe(false);
    expect(old.emitAbortedOnce(oldEntry, "r1")).toBe(false);
    expect(newEmitted).toHaveLength(1);
    expect(oldEmitted).toHaveLength(1);
    newEntry.activeRunId = "run-2";
    oldEntry.activeRunId = "run-2";
    expect(emitAbortedOnce(newEntry, "r2", { flags: FLAGS_OFF })).toBe(true);
    expect(old.emitAbortedOnce(oldEntry, "r2")).toBe(true);
    expect(newEmitted).toHaveLength(2);
    expect(newEmitted[1].data).toEqual({ runId: "run-2", reason: "r2" });
    expect(newEmitted).toHaveLength(oldEmitted.length);
  });

  it("no-run 令牌：runId null 时按 no-run:<abortRequestedAt> 幂等，两 entry 独立", () => {
    const record = makeRecord();
    const old = makeOldEmit(FLAGS_OFF, record.fn);
    const a = makeEntry({ activeRunId: null, abortRequestedAt: 123 });
    const b = makeEntry({ activeRunId: null, abortRequestedAt: 456 });
    const oldA = makeEntry({ activeRunId: null, abortRequestedAt: 123 });
    const oldB = makeEntry({ activeRunId: null, abortRequestedAt: 456 });
    expect(emitAbortedOnce(a.entry, "x", { flags: FLAGS_OFF })).toBe(true);
    expect(emitAbortedOnce(a.entry, "x", { flags: FLAGS_OFF })).toBe(false);
    expect(emitAbortedOnce(b.entry, "x", { flags: FLAGS_OFF })).toBe(true);
    expect(old.emitAbortedOnce(oldA.entry, "x")).toBe(true);
    expect(old.emitAbortedOnce(oldA.entry, "x")).toBe(false);
    expect(old.emitAbortedOnce(oldB.entry, "x")).toBe(true);
    expect(a.entry.abortedEmittedRunId).toBe("no-run:123");
    expect(a.entry.abortedEmittedRunId).toBe(oldA.entry.abortedEmittedRunId);
    expect(a.entry.channel.history[0].data.runId).toBe(null);
  });

  it("开关开启：先 run_draining，通道静默 300ms 后 aborted（drained: true），drainTimer 清空", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const record = makeRecord();
    const old = makeOldEmit(FLAGS_ON, record.fn);
    const { entry: newEntry, emitted: newEmitted } = makeEntry();
    const { entry: oldEntry, emitted: oldEmitted } = makeEntry();
    expect(emitAbortedOnce(newEntry, "中断", { flags: FLAGS_ON })).toBe(true);
    expect(old.emitAbortedOnce(oldEntry, "中断")).toBe(true);
    expect(newEmitted).toHaveLength(1);
    expect(newEmitted[0].type).toBe("run_draining");
    expect(newEmitted[0].data).toEqual({ runId: "run-1", reason: "中断", quietMs: 300, maxMs: 1500 });
    expect(typeof newEntry.drainTimer).not.toBe("undefined");
    expect(newEntry.drainTimer).not.toBe(null);
    expect(oldEntry.drainTimer).not.toBe(null);
    vi.advanceTimersByTime(300);
    expect(newEmitted).toHaveLength(2);
    expect(oldEmitted).toHaveLength(2);
    expect(newEmitted[1].type).toBe("aborted");
    expect(newEmitted[1].data).toEqual({ runId: "run-1", reason: "中断", drained: true });
    expect(newEmitted[1]).toEqual(oldEmitted[1]);
    expect(newEntry.drainTimer).toBe(null);
    expect(oldEntry.drainTimer).toBe(null);
  });

  it("开关开启：排空期持续新事件则按 1500ms 上限强制 aborted（drained: false）", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const record = makeRecord();
    const old = makeOldEmit(FLAGS_ON, record.fn);
    const { entry: newEntry, emitted: newEmitted } = makeEntry();
    const { entry: oldEntry, emitted: oldEmitted } = makeEntry();
    emitAbortedOnce(newEntry, "中断", { flags: FLAGS_ON });
    old.emitAbortedOnce(oldEntry, "中断");
    // 模拟排空期间通道不断有新事件：每次 100ms 步进后把 lastEmitAt 推到当前时刻（settle 已在本次步进内执行完）
    for (let step = 1; step <= 13; step += 1) {
      vi.advanceTimersByTime(100);
      const now = Date.now();
      if (newEntry.drainTimer) {
        newEntry.channel.lastEmitAt = now;
        oldEntry.channel.lastEmitAt = now;
      }
    }
    // 累计 1300ms 仍在静默判定窗口内；继续推进到 1500ms 上限强制 aborted（此时 idleFor < quietMs → drained: false）
    vi.advanceTimersByTime(400);
    expect(newEmitted.filter((ev: any) => ev.type === "aborted")).toHaveLength(1);
    const aborted = newEmitted.find((ev: any) => ev.type === "aborted");
    expect(aborted.data).toEqual({ runId: "run-1", reason: "中断", drained: false });
    expect(aborted).toEqual(oldEmitted.find((ev: any) => ev.type === "aborted"));
    expect(newEntry.drainTimer).toBe(null);
  });

  it("开关开启：幂等令牌置位后第二条收尾路径不重复排空或重发", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const old = makeOldEmit(FLAGS_ON, makeRecord().fn);
    const { entry: newEntry, emitted: newEmitted } = makeEntry();
    const { entry: oldEntry, emitted: oldEmitted } = makeEntry();
    expect(emitAbortedOnce(newEntry, "中断", { flags: FLAGS_ON })).toBe(true);
    expect(old.emitAbortedOnce(oldEntry, "中断")).toBe(true);
    expect(emitAbortedOnce(newEntry, "中断", { flags: FLAGS_ON })).toBe(false);
    expect(old.emitAbortedOnce(oldEntry, "中断")).toBe(false);
    expect(newEmitted.filter((ev: any) => ev.type === "run_draining")).toHaveLength(1);
    expect(oldEmitted.filter((ev: any) => ev.type === "run_draining")).toHaveLength(1);
    vi.advanceTimersByTime(300);
    expect(newEmitted.filter((ev: any) => ev.type === "aborted")).toHaveLength(1);
    expect(oldEmitted.filter((ev: any) => ev.type === "aborted")).toHaveLength(1);
  });

  it("排空参数取自 flags（drainMaxMs/drainQuietMs，非法回落默认）", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    for (const [maxMs, quietMs] of [[800, 200], ["abc", undefined], [10, 5]] as const) {
      const flags: EmitFlags = { qoderDrainOnAbort: true, qoderDrainMaxMs: maxMs, qoderDrainQuietMs: quietMs };
      const old = makeOldEmit(flags, makeRecord().fn);
      const { entry: newEntry, emitted: newEmitted } = makeEntry();
      const { entry: oldEntry, emitted: oldEmitted } = makeEntry();
      emitAbortedOnce(newEntry, "x", { flags });
      old.emitAbortedOnce(oldEntry, "x");
      expect(newEmitted[0].data).toEqual(oldEmitted[0].data);
      expect(newEmitted[0].data.quietMs).toBe(Math.max(50, Number(quietMs) || 300));
      expect(newEmitted[0].data.maxMs).toBe(Math.max(100, Number(maxMs) || 1500));
      vi.clearAllTimers();
    }
  });
});
