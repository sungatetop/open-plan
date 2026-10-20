import { describe, it, expect } from "vitest";
import { 计算展示字符数, 提取消息展示文本 } from "../src/renderer/lib/StreamingTextQueue";

const serverModule = await import("../../client/src/components/StreamingTextQueue.js");
const server = serverModule as unknown as {
  计算展示字符数: typeof 计算展示字符数;
  提取消息展示文本: typeof 提取消息展示文本;
};

describe("StreamingTextQueue TS 版与 client 版等价（对拍）", () => {
  it("计算展示字符数：典型值与默认参数一致", () => {
    const cases: Array<Parameters<typeof 计算展示字符数>[0]> = [
      undefined,
      {},
      { remaining: 0 },
      { remaining: 500 },
      { remaining: 500, elapsedMs: 0 },
      { remaining: 500, elapsedMs: -5 },
      { remaining: 500, elapsedMs: 1000 },
      { remaining: 100, reducedMotion: true },
      { remaining: 100, reducedMotion: 1 },
      { remaining: "120" },
      { remaining: -50 },
      { remaining: Number.NaN },
      { remaining: null },
      { remaining: undefined },
      { remaining: 1e9 },
      { remaining: 21 },
      { remaining: 24 },
      { remaining: 1, elapsedMs: 0.5 },
    ];
    for (const c of cases) {
      expect(计算展示字符数(c)).toBe(server.计算展示字符数(c));
    }
    // 绝对锚点：追赶速率 = max(90, ceil(total/0.24))，帧长下限 1ms、上限 total
    expect(计算展示字符数({})).toBe(0);
    expect(计算展示字符数({ remaining: 500 })).toBe(34);
    expect(计算展示字符数({ remaining: 500, elapsedMs: 1000 })).toBe(500); // 追赶封顶
    expect(计算展示字符数({ remaining: 100, reducedMotion: true })).toBe(100);
  });

  it("计算展示字符数：异型入参两侧行为一致（含 NaN / 解构 null 抛错）", () => {
    expect(计算展示字符数(5 as never)).toBe(server.计算展示字符数(5 as never));
    expect(计算展示字符数(5 as never)).toBe(0); // 解构原始值 → undefined → 默认 0
    expect(计算展示字符数("str" as never)).toBe(server.计算展示字符数("str" as never));
    expect(计算展示字符数({ remaining: 500, elapsedMs: "abc" as never })).toBeNaN(); // Math.max(1,"abc") → NaN
    expect(计算展示字符数({ remaining: 500, elapsedMs: "abc" as never }))
      .toBe(server.计算展示字符数({ remaining: 500, elapsedMs: "abc" as never }));
    expect(() => 计算展示字符数(null as never)).toThrow();
    expect(() => server.计算展示字符数(null as never)).toThrow();
  });

  it("提取消息展示文本：blocks 与旧版 text 不叠加", () => {
    const cases: unknown[] = [
      { blocks: [{ type: "text", text: "a" }, { type: "tool", text: "b" }, { type: "text", text: "c" }], text: "legacy" },
      { text: "legacy" },
      { blocks: [] },
      { blocks: [{ type: "text" }] },
      { blocks: [{ type: "text", text: 123 }] },
      { blocks: [null, { type: "text", text: "x" }] },
      { blocks: "nope" },
      { text: 0 },
      { blocks: [{ type: "text", text: null }] },
      { blocks: [{ type: "text", text: "0" }] },
      { blocks: [{ type: "TEXT", text: "upper" }] },
      null,
      undefined,
      "str",
      42,
    ];
    for (const c of cases) {
      expect(提取消息展示文本(c)).toBe(server.提取消息展示文本(c));
    }
    expect(提取消息展示文本({ blocks: [{ type: "text", text: "a" }, { type: "tool" }], text: "legacy" })).toBe("a");
    expect(提取消息展示文本(null)).toBe("");
  });
});
