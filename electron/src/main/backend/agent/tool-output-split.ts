/**
 * 工具输出单帧体积护栏（B6-6-3，自 server/stream-connection.mjs L203-255 逐行转录）。
 *
 * Qoder P0-2：超大 tool_output（例如 officecli 返回的整段 JSON、bash 的巨量 stdout）以
 * 单帧下发时，会一次性把整帧塞进 SSE 通路：客户端解析一次要整块驻留内存，服务端排空
 * 队列也会被顶到上限。按「单帧 ≤ 上限字节」把文本切成多片，第一片仍走 tool_output
 * （保留 replace 语义），其余走增量事件 tool_output_delta（只追加）。
 * 注意：切分按「码点」推进，不会把多字节字符劈成半个（避免前端拿到乱码）。
 */

/** 按 UTF-8 字节上限切分文本；按码点推进，保证每个片段都是合法字符串。 */
export function 按字节切分(文本: unknown, 上限字节: unknown = 256 * 1024): string[] {
  const 内容 = String(文本 ?? "");
  const 上限 = Math.max(1024, Number(上限字节) || 256 * 1024);
  if (!内容) return [];
  if (Buffer.byteLength(内容, "utf8") <= 上限) return [内容];
  const 片段: string[] = [];
  let 当前 = "";
  let 当前字节 = 0;
  for (const 字 of 内容) {
    const 字节 = Buffer.byteLength(字, "utf8");
    if (当前 && 当前字节 + 字节 > 上限) {
      片段.push(当前);
      当前 = "";
      当前字节 = 0;
    }
    当前 += 字;
    当前字节 += 字节;
  }
  if (当前) 片段.push(当前);
  return 片段;
}

/**
 * 把一条 tool_output 载荷切成「下发帧」序列。
 * 单帧（未超限）时原样返回一条 tool_output，保证开关打开但输出不大时与基线**完全同形**。
 */
export function 工具输出分片(载荷: any = {}, 上限字节: unknown = 256 * 1024): Array<{ type: string; data: any }> {
  const 片段 = 按字节切分(载荷?.output, 上限字节);
  if (片段.length <= 1) return [{ type: "tool_output", data: 载荷 }];
  const 帧列表: Array<{ type: string; data: any }> = [{ type: "tool_output", data: { ...载荷, output: 片段[0] } }];
  for (let i = 1; i < 片段.length; i += 1) {
    帧列表.push({
      type: "tool_output_delta",
      data: { toolCallId: 载荷?.toolCallId ?? null, name: 载荷?.name ?? null, output: 片段[i], index: i, frames: 片段.length },
    });
  }
  return 帧列表;
}

/** 单帧上限（字节）解析：非法值回落到默认 256 KiB。 */
export function 工具输出帧上限(值: unknown): number {
  const 数 = Number(值);
  return Number.isFinite(数) && 数 >= 1024 ? Math.floor(数) : 256 * 1024;
}
