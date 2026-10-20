/**
 * SSE 增量解析器单测（F2c）：字段解析、CRLF 兼容、分块边界、注释、id 粘滞、尾部派发。
 * 纯函数无 IO，直接构造字节串喂入。
 */
import { describe, expect, it } from "vitest";
import { createSseParser, type SseMessage } from "../src/main/ipc/sse-parser";

function collect(): { messages: SseMessage[]; parser: ReturnType<typeof createSseParser> } {
  const messages: SseMessage[] = [];
  return { messages, parser: createSseParser((m) => messages.push(m)) };
}

describe("createSseParser", () => {
  it("基础 data 消息", () => {
    const { messages, parser } = collect();
    parser.push('data: hello\n\n');
    expect(messages).toEqual([{ id: null, event: null, data: "hello" }]);
  });

  it("多行 data 以 \\n 连接", () => {
    const { messages, parser } = collect();
    parser.push('data: first\ndata: second\ndata:\n\n');
    expect(messages).toEqual([{ id: null, event: null, data: "first\nsecond\n" }]);
  });

  it("event 字段与 id 字段", () => {
    const { messages, parser } = collect();
    parser.push('event: heartbeat\ndata: {}\n\n');
    expect(messages[0]?.event).toBe("heartbeat");
  });

  it("注释行忽略；只有注释的消息不派发", () => {
    const { messages, parser } = collect();
    parser.push(': keep-alive\n\n');
    parser.push(': ping\n: ping2\ndata: after\n\n');
    expect(messages).toEqual([{ id: null, event: null, data: "after" }]);
  });

  it("CRLF 行尾兼容", () => {
    const { messages, parser } = collect();
    parser.push('data: a\r\n\r\ndata: b\r\n\r\n');
    expect(messages).toEqual([
      { id: null, event: null, data: "a" },
      { id: null, event: null, data: "b" }
    ]);
  });

  it("跨块切断：半行缓冲、半消息缓冲", () => {
    const { messages, parser } = collect();
    parser.push('dat');
    parser.push('a: hel');
    parser.push('lo\nid: 4');
    parser.push('2\nevent: mes');
    parser.push('sage.delta\n\n');
    expect(messages).toEqual([{ id: "42", event: "message.delta", data: "hello" }]);
  });

  it("id 跨消息粘滞（W3C 规范），event/data 每消息重置", () => {
    const { messages, parser } = collect();
    parser.push('id: 1\ndata: first\n\n');
    parser.push('data: second\n\n');
    parser.push('id: 3\ndata: third\n\n');
    expect(messages.map((m) => m.id)).toEqual(["1", "1", "3"]);
    expect(messages.map((m) => m.event)).toEqual([null, null, null]);
  });

  it("id 含 NUL 时忽略该行", () => {
    const { messages, parser } = collect();
    parser.push('id: 1\ndata: a\n\nid: bad\u0000id\ndata: b\n\n');
    expect(messages.map((m) => m.id)).toEqual(["1", "1"]);
  });

  it("无冒号字段行按空值处理", () => {
    const { messages, parser } = collect();
    parser.push('data\n\n');
    expect(messages).toEqual([{ id: null, event: null, data: "" }]);
  });

  it("冒号后仅剥离一个空格", () => {
    const { messages, parser } = collect();
    parser.push('data:  two-spaces\n\ndata:no-space\n\n');
    expect(messages.map((m) => m.data)).toEqual([" two-spaces", "no-space"]);
  });

  it("end() 派发无结尾空行的尾部消息", () => {
    const { messages, parser } = collect();
    parser.push('data: tail');
    parser.end();
    expect(messages).toEqual([{ id: null, event: null, data: "tail" }]);
  });

  it("end() 后缓冲清空，重复 end 不重复派发", () => {
    const { messages, parser } = collect();
    parser.push('data: tail');
    parser.end();
    parser.end();
    expect(messages).toHaveLength(1);
  });

  it("未知字段（retry 等）忽略不派发", () => {
    const { messages, parser } = collect();
    parser.push('retry: 3000\ndata: x\n\n');
    expect(messages).toEqual([{ id: null, event: null, data: "x" }]);
  });

  it("真实 legacy 帧形态：id + data JSON 一体的通道事件", () => {
    const { messages, parser } = collect();
    const frame = JSON.stringify({ id: 12, type: "message.delta", data: { text: "hi" } });
    parser.push(`id: 12\ndata: ${frame}\n\n`);
    expect(messages[0]?.id).toBe("12");
    expect(JSON.parse(messages[0]?.data ?? "{}")).toEqual({ id: 12, type: "message.delta", data: { text: "hi" } });
  });
});
