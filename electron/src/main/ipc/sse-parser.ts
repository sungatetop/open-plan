/**
 * SSE 增量解析器（纯函数，无 IO）：把 text/event-stream 字节流切成消息。
 *
 * 按 W3C SSE 规范处理：字段 `id:` / `event:` / `data:` / 注释（`:` 开头），
 * 多行 data 以 \n 连接，空行派发消息；兼容 CRLF 与分块到达（chunk 边界可能切断行/消息）。
 * 事件桥（events-bridge.ts）用它消费 legacy server 的 /api/agent/stream。
 */

export interface SseMessage {
  /** `id:` 字段原文（未转数字；缺省 null） */
  id: string | null;
  /** `event:` 字段（缺省 null，即默认消息） */
  event: string | null;
  /** data 各行以 \n 连接后的原文 */
  data: string;
}

export interface SseParser {
  /** 喂入一个文本分块（内部处理跨块缓冲） */
  push(chunk: string): void;
  /** 流结束：若还有未派发的尾部消息（无结尾空行）则派发 */
  end(): void;
}

export function createSseParser(onMessage: (message: SseMessage) => void): SseParser {
  let buffer = "";
  let id: string | null = null;
  let event: string | null = null;
  const dataLines: string[] = [];

  const dispatch = (): void => {
    if (dataLines.length === 0) {
      // 空消息（只有注释/空行）：重置 id 之外的字段状态
      event = null;
      return;
    }
    onMessage({ id, event, data: dataLines.join("\n") });
    event = null;
    dataLines.length = 0;
  };

  const handleLine = (line: string): void => {
    if (line === "") {
      dispatch();
      return;
    }
    if (line.startsWith(":")) return; // 注释/keep-alive
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "id") {
      // 规范：id 含 NUL 时忽略整行
      if (!value.includes("\0")) id = value;
    } else if (field === "event") {
      event = value;
    } else if (field === "data") {
      dataLines.push(value);
    }
    // 其他字段（retry 等）当前消费方不需要，忽略
  };

  return {
    push(chunk: string): void {
      buffer += chunk;
      // 兼容 CRLF：先归一化再按 \n 切分；\r 单独出现也视为行结束
      const normalized = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const lines = normalized.split("\n");
      // 最后一段可能是被切断的半行：留回缓冲
      buffer = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    },
    end(): void {
      if (buffer !== "") {
        handleLine(buffer);
        buffer = "";
      }
      dispatch();
    }
  };
}
