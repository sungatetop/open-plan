import { describe, it, expect } from "vitest";
import {
  PROTOCOL_VERSION,
  CHANNEL_HISTORY_LIMIT,
  createStreamId,
  resolveReplayCursor,
  pushChannelEvent,
  isHistoryTruncated,
  DELTA_EVENT_TYPES,
  LIFECYCLE_EVENT_TYPES
} from "../src/shared/runtime/event-protocol";

const serverModule = await import("../../server/event-protocol.mjs");
// server 版为 JS 推断签名，测试用宽容视图以覆盖字符串数字/缺省输入
const server = serverModule as unknown as {
  PROTOCOL_VERSION: number;
  CHANNEL_HISTORY_LIMIT: number;
  DELTA_EVENT_TYPES: Set<string>;
  LIFECYCLE_EVENT_TYPES: Set<string>;
  createStreamId(): string;
  resolveReplayCursor(input?: Record<string, unknown>): number;
  pushChannelEvent(channel: { history: unknown[]; historyLimit?: number }, event: unknown): void;
  isHistoryTruncated(input?: Record<string, unknown>): boolean;
};

describe("event-protocol TS 版与 server 版等价（对拍）", () => {
  it("协议常量与注册表派生集合 re-export 一致", () => {
    expect(PROTOCOL_VERSION).toBe(server.PROTOCOL_VERSION);
    expect(CHANNEL_HISTORY_LIMIT).toBe(server.CHANNEL_HISTORY_LIMIT);
    expect([...DELTA_EVENT_TYPES]).toEqual([...server.DELTA_EVENT_TYPES]);
    expect([...LIFECYCLE_EVENT_TYPES]).toEqual([...server.LIFECYCLE_EVENT_TYPES]);
  });

  it("createStreamId 格式一致且各自唯一", () => {
    const pattern = /^stream_[a-z0-9]+_[0-9a-f]{8}$/;
    const tsIds = Array.from({ length: 50 }, () => createStreamId());
    const jsIds = Array.from({ length: 50 }, () => server.createStreamId());
    for (const id of [...tsIds, ...jsIds]) expect(id).toMatch(pattern);
    expect(new Set(tsIds).size).toBe(50);
    expect(new Set(jsIds).size).toBe(50);
  });

  it("resolveReplayCursor 代际/游标矩阵一致", () => {
    const cases = [
      { clientStreamId: "s1", channelStreamId: "s1", lastId: 10, channelSeq: 20 },
      { clientStreamId: "s1", channelStreamId: "s2", lastId: 10, channelSeq: 20 },
      { clientStreamId: "", channelStreamId: "s2", lastId: 30, channelSeq: 20 },
      { clientStreamId: "", channelStreamId: "s2", lastId: 5, channelSeq: 20 },
      { clientStreamId: "s1", channelStreamId: "", lastId: 8, channelSeq: 0 },
      { lastId: -4, channelSeq: 9 },
      { lastId: "12", channelSeq: "30" },
      {}
    ];
    for (const input of cases) {
      expect(resolveReplayCursor(input as never)).toBe(server.resolveReplayCursor(input));
    }
  });

  it("pushChannelEvent 语义化淘汰结果逐条一致", () => {
    // 混合事件流：token/tool_output 为可淘汰增量，tool_start/run_finished 为受保护生命周期事件
    const makeEvents = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        type: i % 3 === 0 ? "tool_start" : i % 3 === 1 ? "token" : "run_finished",
        id: `${prefix}-${i}`
      }));

    const build = (limit: number, prefix: string) => {
      const channel = { history: [] as Array<{ type?: string; id?: string }>, historyLimit: limit };
      for (const event of makeEvents(prefix, 40)) pushChannelEvent(channel as never, event);
      return channel.history.map((item) => item.id);
    };
    const buildServer = (limit: number, prefix: string) => {
      const channel = { history: [] as Array<{ type?: string; id?: string }>, historyLimit: limit };
      for (const event of makeEvents(prefix, 40)) server.pushChannelEvent(channel, event);
      return channel.history.map((item) => item.id);
    };

    // 两侧输入完全相同的事件流（同前缀），比较淘汰后的历史 id 序列
    for (const limit of [5, 10, 4000]) {
      expect(build(limit, "p")).toEqual(buildServer(limit, "p"));
    }
    // 默认上限（未设置 historyLimit）不被淘汰
    const defaultChannel = { history: [] as unknown[] };
    for (let i = 0; i < 10; i++) pushChannelEvent(defaultChannel as never, { type: "token" });
    expect(defaultChannel.history.length).toBe(10);
  });

  it("isHistoryTruncated 判定矩阵一致", () => {
    const cases = [
      { lastId: 5, earliestId: 10 },
      { lastId: 9, earliestId: 10 },
      { lastId: 10, earliestId: 10 },
      { lastId: 0, earliestId: 10 },
      { lastId: 5, earliestId: 0 },
      { lastId: "7", earliestId: "3" },
      {}
    ];
    for (const input of cases) {
      expect(isHistoryTruncated(input as never)).toBe(server.isHistoryTruncated(input));
    }
  });
});
