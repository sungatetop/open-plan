/**
 * B6-6-1 行为覆盖：agent.mjs 纯函数/薄 IO 批（tool-schema / usage-text / agent-errors / office-command）。
 *
 * R6-6b 对拍退役改写：旧侧行号提取源码段 + new Function 求值随 server/agent.mjs 退役删除，
 * 仅保留 TS 侧断言（期望值此前已经双侧对拍固化，现改为直接断言）。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { schemaToTypeBox, safePiToolName, extensionToolNames } from "../src/main/backend/agent/tool-schema";
import { TOOL_OUTPUT_MAX_CHARS, limitToolText, assistantText, eventValueText, normalizeUsage, usageFromEvent } from "../src/main/backend/agent/usage-text";
import {
  AUTO_COMPACT_PROMPT_CHARS,
  MODEL_FIRST_EVENT_TIMEOUT_MS,
  MODEL_IDLE_TIMEOUT_MS,
  isProviderTruncation,
  estimateRestoredContextChars,
  rawAgentErrorMessage,
  agentErrorStatus,
  isEmptyBadRequestError,
  safeAgentErrorMessage,
  isAbortLikeError,
  isUserAbortSettled,
  createSettledAgentError,
  captureSettledAgentError,
  clearInvalidCredential,
  getCredentialErrors,
  classifyAgentError,
  createModelTimeoutError,
  createModelStreamTimeoutError,
  resolveThinkingLevel,
} from "../src/main/backend/agent/agent-errors";
import { runAgentOfficeCommand, type OfficeCommandOutput } from "../src/main/backend/agent/office-command";

/** invalidCredentials 清场（用例触达过的 provider 全部清掉）。 */
const TOUCHED_PROVIDERS = ["prov-x", "auth-p", "p1", "p2"];
beforeEach(() => {
  for (const provider of TOUCHED_PROVIDERS) {
    clearInvalidCredential(provider);
  }
});

describe("B6-6-1 tool-schema 行为覆盖", () => {
  it("常量锚点", () => {
    expect(TOOL_OUTPUT_MAX_CHARS).toBe(16000);
  });

  /** JSON.stringify 后判（剥离 TypeBox symbol 键）。 */
  const json = (v: unknown) => JSON.parse(JSON.stringify(v));

  const schemaCases: Array<{ name: string; schema: unknown; check: (out: any) => void }> = [
    { name: "空对象", schema: {}, check: (out) => expect(out).toEqual({}) },
    { name: "null", schema: null, check: (out) => expect(out).toEqual({}) },
    { name: "undefined", schema: undefined, check: (out) => expect(out).toEqual({}) },
    { name: "enum 单值", schema: { enum: ["only"] }, check: (out) => expect(out).toMatchObject({ const: "only" }) },
    {
      name: "enum 多值",
      schema: { enum: ["a", "b", 3, true] },
      check: (out) => expect(out.anyOf).toEqual([expect.objectContaining({ const: "a" }), expect.objectContaining({ const: "b" }), expect.objectContaining({ const: 3 }), expect.objectContaining({ const: true })]),
    },
    { name: "enum 含对象回落", schema: { enum: ["a", { x: 1 }] }, check: (out) => expect(out).toEqual({}) },
    { name: "anyOf 单支", schema: { anyOf: [{ type: "string" }] }, check: (out) => expect(out).toEqual({ type: "string" }) },
    {
      name: "anyOf 多支",
      schema: { anyOf: [{ type: "string" }, { type: "number" }, { type: "null" }] },
      check: (out) => expect(out.anyOf).toEqual([{ type: "string" }, { type: "number" }, { type: "null" }]),
    },
    { name: "oneOf 超限回落", schema: { oneOf: Array.from({ length: 13 }, () => ({ type: "string" })) }, check: (out) => expect(out).toEqual({}) },
    { name: "type 数组去 null", schema: { type: ["string", "null"] }, check: (out) => expect(out).toEqual({ type: "string" }) },
    { name: "type 数组全 null", schema: { type: ["null", "null"] }, check: (out) => expect(out).toEqual({}) },
    {
      name: "object required+closed",
      schema: { type: "object", required: ["a"], properties: { a: { type: "string" }, b: { type: "number" } }, additionalProperties: false },
      check: (out) => {
        expect(out).toMatchObject({ type: "object", additionalProperties: false, required: ["a"] });
        expect(out.properties.a).toEqual({ type: "string" });
        expect(out.properties.b).toEqual({ type: "number" });
      },
    },
    {
      name: "object 仅 properties",
      schema: { properties: { a: { type: "string" } } },
      check: (out) => {
        expect(out).toMatchObject({ type: "object", additionalProperties: true });
        expect(out.properties.a).toEqual({ type: "string" });
      },
    },
    {
      name: "object 属性截断100",
      schema: { type: "object", properties: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`k${i}`, { type: "string" }])) },
      check: (out) => {
        expect(Object.keys(out.properties)).toHaveLength(100);
        expect(out.properties.k99).toEqual({ type: "string" });
        expect(out.properties.k100).toBeUndefined();
      },
    },
    {
      name: "array 默认 maxItems",
      schema: { type: "array", items: { type: "string" } },
      check: (out) => {
        expect(out).toMatchObject({ type: "array", maxItems: 1000 });
        expect(out.items).toEqual({ type: "string" });
      },
    },
    {
      name: "array 显式 maxItems",
      schema: { type: "array", items: { type: "number" }, maxItems: 5 },
      check: (out) => {
        expect(out).toMatchObject({ type: "array", maxItems: 5 });
        expect(out.items).toEqual({ type: "number" });
      },
    },
    {
      name: "array items 缺省",
      schema: { type: "array" },
      check: (out) => {
        expect(out).toMatchObject({ type: "array", maxItems: 1000 });
        expect(out.items).toEqual({});
      },
    },
    { name: "string 长度约束", schema: { type: "string", maxLength: 10, minLength: 2 }, check: (out) => expect(out).toEqual({ type: "string", maxLength: 10, minLength: 2 }) },
    { name: "string 约束无效", schema: { type: "string", maxLength: "x", minLength: -1 }, check: (out) => expect(out).toEqual({ type: "string", minLength: -1 }) },
    { name: "integer", schema: { type: "integer" }, check: (out) => expect(out).toEqual({ type: "number" }) },
    { name: "number", schema: { type: "number" }, check: (out) => expect(out).toEqual({ type: "number" }) },
    { name: "boolean", schema: { type: "boolean" }, check: (out) => expect(out).toEqual({ type: "boolean" }) },
    { name: "null 类型", schema: { type: "null" }, check: (out) => expect(out).toEqual({ type: "null" }) },
    { name: "未知类型回落", schema: { type: "foo" }, check: (out) => expect(out).toEqual({}) },
    {
      name: "深嵌套超深度",
      schema: (() => { let node: unknown = { type: "string" }; for (let i = 0; i < 12; i += 1) node = { type: "object", properties: { n: node } }; return node; })(),
      // depth>8 剪枝：恰好 9 层 object（depth 0-8），第 10 层起回落 Type.Any()
      check: (out) => expect(JSON.stringify(out).split('"type":"object"').length - 1).toBe(9),
    },
  ];

  for (const { name, schema, check } of schemaCases) {
    it(`schemaToTypeBox ${name}`, () => {
      const out = schema === undefined ? schemaToTypeBox() : schemaToTypeBox(schema);
      check(json(out));
    });
  }

  it("schemaToTypeBox enum 含 null 抛错（typebox Literal 不接受 null，旧行为保真）", () => {
    const sample = { enum: ["a", null] };
    expect(() => schemaToTypeBox(sample)).toThrow("Invalid Literal value");
  });

  it("safePiToolName 样本", () => {
    const cases: Array<[unknown, string]> = [
      ["read-file", "read-file"],
      [" 测试 工具!!", "tool"],
      ["", "tool"],
      [null, "tool"],
      [undefined, "tool"],
      ["a".repeat(100), "a".repeat(64)],
      ["_leading__trailing_", "leading__trailing"],
      ["___", "tool"],
      ["tool.name+ext", "tool_name_ext"],
      [123, "123"],
    ];
    for (const [sample, expected] of cases) {
      expect(safePiToolName(sample), String(sample)).toBe(expected);
    }
    expect(safePiToolName("a".repeat(100), 8)).toBe("aaaaaaaa");
  });

  it("extensionToolNames 样本", () => {
    const makeLoader = (extensions: unknown[]) => ({ getExtensions: () => ({ extensions }) });
    const entries = [{ path: "/ws/ext-a" }];
    const cases: Array<{ name: string; loader: unknown; entries: unknown; expected: string[] }> = [
      { name: "空 loader", loader: {}, entries, expected: [] },
      { name: "getExtensions 无 extensions 字段", loader: { getExtensions: () => ({}) }, entries, expected: [] },
      { name: "扩展无 tools", loader: makeLoader([{ resolvedPath: "/ws/ext-a/index.js" }]), entries, expected: [] },
      { name: "命中启用根", loader: makeLoader([{ resolvedPath: "/ws/ext-a/index.js", tools: new Map([["t1", {}], ["t2", {}]]) }]), entries, expected: ["t1", "t2"] },
      { name: "根子目录命中", loader: makeLoader([{ resolvedPath: "/ws/ext-a/sub/tool.js", tools: new Map([["t3", {}]]) }]), entries, expected: ["t3"] },
      { name: "未启用路径", loader: makeLoader([{ resolvedPath: "/other/ext-b/index.js", tools: new Map([["t4", {}]]) }]), entries, expected: [] },
      { name: "resolvedPath 缺省用 path", loader: makeLoader([{ path: "/ws/ext-a/x.js", tools: new Map([["t5", {}]]) }]), entries, expected: ["t5"] },
      {
        name: "多扩展去重",
        loader: makeLoader([
          { resolvedPath: "/ws/ext-a/a.js", tools: new Map([["dup", {}]]) },
          { resolvedPath: "/ws/ext-a/b.js", tools: new Map([["dup", {}], ["only-b", {}]]) },
        ]),
        entries,
        expected: ["dup", "only-b"],
      },
      { name: "兄弟目录不误命中", loader: makeLoader([{ resolvedPath: "/ws/ext-ab/x.js", tools: new Map([["t6", {}]]) }]), entries, expected: [] },
    ];
    for (const { name, loader, entries: ent, expected } of cases) {
      expect([...extensionToolNames(loader as never, ent as never)].sort(), name).toEqual(expected);
    }
  });
});

describe("B6-6-1 usage-text 行为覆盖", () => {
  it("limitToolText 短文本原样", () => {
    for (const [text, expected] of [["", ""], ["短文本", "短文本"], ["x".repeat(TOOL_OUTPUT_MAX_CHARS), "x".repeat(TOOL_OUTPUT_MAX_CHARS)], [String(null), "null"]] as const) {
      expect(limitToolText(text)).toBe(expected);
    }
  });

  it("limitToolText 长文本首尾截断（头 72% / 尾 28%）", () => {
    const long = "H".repeat(20000) + "T".repeat(20000);
    const out = limitToolText(long);
    const marker = (n: number) => `\n\n...[输出已截断，原始长度 ${n} 字符；请使用分段读取继续获取]...\n\n`;
    expect(out.length).toBe(11520 + marker(40000).length + 4480); // 头 16000*0.72 + 标记 + 尾
    expect(out).toContain(marker(40000));
    expect(out.startsWith("H")).toBe(true);
    expect(out.endsWith("T")).toBe(true);
    const custom = limitToolText("y".repeat(500), 100);
    expect(custom.length).toBe(100 + marker(500).length);
    expect(custom).toContain(marker(500));
  });

  it("assistantText 样本", () => {
    const cases: Array<[unknown, string]> = [
      ["纯文本", ""],
      [{ content: "字符串 content" }, "字符串 content"],
      [{ content: [{ type: "text", text: "A" }, { type: "text", text: "B" }] }, "AB"],
      [{ content: [{ type: "text", text: "A" }, { type: "tool_call" }, { type: "text", text: "C" }] }, "AC"],
      [{ content: [{ type: "text" }, { type: "text", text: "" }] }, ""],
      [{ content: [] }, ""],
      [{ content: null }, ""],
      [{ content: 42 }, ""],
      [null, ""],
      [undefined, ""],
      [{}, ""],
    ];
    for (const [sample, expected] of cases) {
      expect(assistantText(sample), JSON.stringify(sample) ?? String(sample)).toBe(expected);
    }
  });

  it("eventValueText 样本", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    const cases: Array<[unknown, string]> = [
      ["文本", "文本"],
      [undefined, ""],
      [null, ""],
      [123, "123"],
      [{ a: 1, b: [1, 2] }, '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}'],
      [circular, "[object Object]"],
    ];
    for (const [sample, expected] of cases) {
      expect(eventValueText(sample), String(sample)).toBe(expected);
    }
    expect(eventValueText({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it("normalizeUsage 样本", () => {
    /** normalizeUsage 恒返回完整 10 字段对象，helper 补零后逐 case 覆盖差异字段。 */
    const expectFull = (o: Record<string, number>) => ({
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, context: 0, totalTokens: 0,
      ...o,
    });
    const cases: Array<[unknown, Record<string, number> | null]> = [
      [null, null],
      [undefined, null],
      ["str", null],
      [42, null],
      [{}, null],
      [{ inputTokens: 10 }, expectFull({ inputTokens: 10, input: 10, context: 10, totalTokens: 10 })],
      [{ input_tokens: 11, output_tokens: 22 }, expectFull({ inputTokens: 11, outputTokens: 22, input: 11, output: 22, context: 11, totalTokens: 33 })],
      [{ input: 3, output: 4 }, expectFull({ inputTokens: 3, outputTokens: 4, input: 3, output: 4, context: 3, totalTokens: 7 })],
      [{ inputTokens: -5, output: 7 }, expectFull({ outputTokens: 7, output: 7, totalTokens: 7 })],
      [{ inputTokens: "12", output: NaN }, expectFull({ inputTokens: 12, input: 12, context: 12, totalTokens: 12 })],
      [{ cacheReadTokens: 1, cacheWriteTokens: 2 }, expectFull({ cacheReadTokens: 1, cacheWriteTokens: 2, cacheRead: 1, cacheWrite: 2, context: 3, totalTokens: 3 })],
      [{ cache_read_input_tokens: 5, cache_creation_input_tokens: 6 }, expectFull({ cacheReadTokens: 5, cacheWriteTokens: 6, cacheRead: 5, cacheWrite: 6, context: 11, totalTokens: 11 })],
      [{ contextTokens: 100, totalTokens: 200 }, expectFull({ context: 100, totalTokens: 200 })],
      [{ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, expectFull({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, input: 1, output: 2, cacheRead: 3, cacheWrite: 4, context: 8, totalTokens: 10 })],
      [{ contextTokens: 0 }, null],
      [{ totalTokens: 0 }, null],
      [{ inputTokens: 0, outputTokens: 0 }, null],
    ];
    for (const [sample, expected] of cases) {
      expect(normalizeUsage(sample), JSON.stringify(sample) ?? String(sample)).toEqual(expected);
    }
    const full = normalizeUsage({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 3, cacheWriteTokens: 4, contextTokens: 100, totalTokens: 30 });
    expect(full).toEqual({
      inputTokens: 10, outputTokens: 20, cacheReadTokens: 3, cacheWriteTokens: 4,
      input: 10, output: 20, cacheRead: 3, cacheWrite: 4, context: 100, totalTokens: 30,
    });
    const derived = normalizeUsage({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
    expect(derived?.context).toBe(8);
    expect(derived?.totalTokens).toBe(10);
  });

  it("usageFromEvent 候选链", () => {
    const usage = { inputTokens: 9, outputTokens: 8 };
    const cases: Array<[unknown, Record<string, number> | null]> = [
      [null, null],
      [{}, null],
      [{ usage }, { inputTokens: 9, outputTokens: 8, context: 9, totalTokens: 17 }],
      [{ usage: null, tokens: { input_tokens: 5 } }, { inputTokens: 5, context: 5, totalTokens: 5 }],
      [{ usage: null, tokens: null, message: { usage } }, { inputTokens: 9, outputTokens: 8 }],
      [{ usage: null, tokens: null, message: { tokens: { input: 2 } } }, { inputTokens: 2 }],
      [{ usage: null, tokens: null, message: null, response: { usage } }, { inputTokens: 9, outputTokens: 8 }],
      [{ usage: null, tokens: null, message: null, response: null, result: { usage } }, { inputTokens: 9, outputTokens: 8 }],
      [{ usage: {}, tokens: { inputTokens: 7 } }, { inputTokens: 7 }],
    ];
    for (const [sample, expected] of cases) {
      expect(usageFromEvent(sample), JSON.stringify(sample)).toMatchObject(expected ?? {});
      if (!expected) expect(usageFromEvent(sample)).toBeNull();
    }
  });
});

describe("B6-6-1 agent-errors 行为覆盖", () => {
  it("超时常量与 env 公式一致", () => {
    expect(AUTO_COMPACT_PROMPT_CHARS).toBe(90000);
    expect(MODEL_FIRST_EVENT_TIMEOUT_MS).toBe(Math.max(10000, Number.parseInt(process.env.OAW_MODEL_FIRST_EVENT_TIMEOUT_MS || "45000", 10) || 45000));
    expect(MODEL_IDLE_TIMEOUT_MS).toBe(Math.max(30000, Number.parseInt(process.env.OAW_MODEL_IDLE_TIMEOUT_MS || "120000", 10) || 120000));
    expect(MODEL_FIRST_EVENT_TIMEOUT_MS).toBeGreaterThanOrEqual(10000);
    expect(MODEL_IDLE_TIMEOUT_MS).toBeGreaterThanOrEqual(30000);
  });

  it("rawAgentErrorMessage 样本", () => {
    const cases: Array<[unknown, string]> = [
      ["直接字符串", "直接字符串"],
      [new Error("boom"), "boom"],
      [{ message: "m" }, "m"],
      [{ cause: { message: "c" } }, "c"],
      [{ cause: { code: "X" } }, "[object Object]"],
      [{}, "[object Object]"],
      [null, "模型连接失败"],
      [undefined, "模型连接失败"],
      [0, "模型连接失败"],
      [5, "5"],
      [true, "true"],
      [["x"], "x"],
    ];
    for (const [sample, expected] of cases) {
      expect(rawAgentErrorMessage(sample), String(sample)).toBe(expected);
    }
  });

  it("agentErrorStatus 样本", () => {
    const cases: Array<[unknown, string | undefined, number | null]> = [
      [{ status: 401 }, undefined, 401],
      [{ statusCode: 429 }, undefined, 429],
      [{ response: { status: 500 } }, undefined, 500],
      [{ status: 0 }, undefined, null],
      [{ statusCode: 200 }, undefined, 200],
      [new Error("Error: 503 status code from gateway"), undefined, 503],
      ["502 status code returned", undefined, 502],
      ["no status here", undefined, null],
      [{ status: 401 }, "ignored message 500 status code", 401],
      [{}, "body mentions 418 status code explicitly", 418],
    ];
    for (const [error, message, expected] of cases) {
      expect(agentErrorStatus(error, message), JSON.stringify([error?.toString?.(), message])).toBe(expected);
    }
  });

  it("isEmptyBadRequestError 样本", () => {
    const cases: Array<[unknown, boolean]> = [
      [new Error("400 status code (no body)"), true],
      [new Error("400 status code (empty response body)"), true],
      [new Error("400 status code"), false],
      [new Error("400 status code") as Error & { body?: string }, false],
      [{ message: "400 status code", body: "400 status code (no body)" }, true],
      [{ message: "boom", responseBody: "400 status code (empty response body)" }, true],
      [new Error("404 status code (no body)"), false],
      [new Error("500 status code (no body)"), false],
      ["boom", false],
    ];
    for (const [sample, expected] of cases) {
      expect(isEmptyBadRequestError(sample), String(sample)).toBe(expected);
    }
  });

  it("safeAgentErrorMessage 脱敏与截断", () => {
    const cases: Array<[unknown, string]> = [
      ["api_key=sk-abcdef12345", "api_key=[已隐藏]"],
      ["Authorization: Bearer sk-xyz", "Authorization: [已隐藏] sk-xyz"],
      ["bearer token: qqq", "bearer [已隐藏] qqq"],
      ["access_token=aaa; refresh_token: bbb", "access_token=[已隐藏]; refresh_token: [已隐藏]"],
      ["普通错误消息", "普通错误消息"],
      ["", "模型连接失败"],
      [null, "模型连接失败"],
      ["z".repeat(3000), "z".repeat(1200)],
    ];
    for (const [sample, expected] of cases) {
      expect(safeAgentErrorMessage(sample), String(sample)).toBe(expected);
    }
    expect(safeAgentErrorMessage("api_key=secret")).not.toContain("secret");
  });

  it("isAbortLikeError 样本", () => {
    const cases: Array<[unknown, boolean]> = [
      ["Request aborted", true],
      ["request was aborted by user", true],
      ["任务在完成前被中断", true],
      ["操作已中断", true],
      ["已取消", true],
      ["aborted", true],
      ["The request was cancelled", true],
      [new Error("user interrupted"), true],
      ["boom", false],
      ["超时了", false],
      ["", false],
      [null, false],
    ];
    for (const [sample, expected] of cases) {
      expect(isAbortLikeError(sample), String(sample)).toBe(expected);
    }
  });

  it("isUserAbortSettled 组合矩阵", () => {
    const aborted = new Error("Request aborted");
    const normal = new Error("boom");
    const cases: Array<[string, unknown, unknown, boolean]> = [
      ["cancelRequested + abort", { cancelRequested: true }, aborted, true],
      ["cancelRequested + 普通错误", { cancelRequested: true }, normal, false],
      ["无中断标记", {}, aborted, false],
      ["abortRequestedAt 2 分钟内", { abortRequestedAt: Date.now() - 1000 }, aborted, true],
      ["abortRequestedAt 超 2 分钟", { abortRequestedAt: Date.now() - 130000 }, aborted, false],
      ["entry 为 null", null, aborted, false],
      ["abortRequestedAt falsy", { abortRequestedAt: 0 }, aborted, false],
    ];
    for (const [name, entry, value, expected] of cases) {
      expect(isUserAbortSettled(entry, value), name).toBe(expected);
    }
  });

  it("isProviderTruncation 样本", () => {
    const cases: Array<[unknown, boolean]> = [
      ["stream ended without finish_reason", true],
      ["Response stream closed unexpectedly", true],
      ["unexpected end of stream", true],
      ["stream ended unexpectedly", true],
      [new Error("without finish_reason"), true],
      ["rate limit exceeded", false],
      ["", false],
      [null, false],
    ];
    for (const [sample, expected] of cases) {
      expect(isProviderTruncation(sample), String(sample)).toBe(expected);
    }
  });

  it("createSettledAgentError 分类注入", () => {
    const settled = createSettledAgentError("Invalid API key provided");
    expect(settled.message).toBe("Invalid API key provided");
    expect(settled.code).toBe("PI_SETTLED_ERROR");
    expect(settled.status).toBeNull();
    expect(settled.errorCategory).toBe("auth");
    expect(settled.noRetry).toBe(true);
    expect(settled.oawClassification).toMatchObject({ category: "auth", retryable: false });

    const boom = createSettledAgentError("boom");
    expect(boom.code).toBe("PI_SETTLED_ERROR");
    expect(boom.errorCategory).toBe("unknown");
    expect(boom.noRetry).toBe(true);

    const rate = createSettledAgentError("429 rate limit exceeded");
    expect(rate.errorCategory).toBe("rate_limit");
    expect(rate.noRetry).toBe(false);

    const config = createSettledAgentError("provider is not configured");
    expect(config.errorCategory).toBe("configuration");
    expect(config.noRetry).toBe(true);

    const leaked = createSettledAgentError("api_key=sk-secret leaked");
    expect(leaked.message).toContain("[已隐藏]");
    expect(leaked.message).not.toContain("sk-secret");
  });

  it("captureSettledAgentError 回写与脱敏", () => {
    const entry: Record<string, unknown> = { lastAgentError: "api_key=abc123 boom" };
    expect(captureSettledAgentError(entry)).toBe("api_key=[已隐藏] boom");
    expect(entry.lastSettledError).toBe("api_key=[已隐藏] boom");
    expect(String(entry.lastSettledError)).not.toContain("abc123");
    const empty: Record<string, unknown> = {};
    expect(captureSettledAgentError(empty)).toBeNull();
    expect(empty.lastSettledError).toBeNull();
  });

  it("classifyAgentError 分类矩阵", () => {
    const base = { code: null, status: null, causeCode: null, provider: null, model: null };
    const cases: Array<{ name: string; error: unknown; category: string; retryable: boolean; status?: number | null; causeCode?: string; provider?: string; model?: string; message?: string }> = [
      { name: "401 auth", error: { status: 401, message: "401 Unauthorized" }, category: "auth", retryable: false, status: 401 },
      { name: "403 文案", error: { message: "403 Forbidden" }, category: "auth", retryable: false },
      { name: "AUTH_ERROR 类别", error: { errorCategory: "AUTH_ERROR", message: "boom" }, category: "auth", retryable: false },
      { name: "quota", error: { message: "quota exceeded for this month" }, category: "quota", retryable: false },
      { name: "configuration", error: { message: "provider is not configured" }, category: "configuration", retryable: false },
      { name: "timeout code", error: { code: "MODEL_TIMEOUT", message: "模型连接超过 45 秒没有响应，已自动中止" }, category: "timeout", retryable: true, message: "模型连接超过 45 秒没有响应，已自动中止" },
      { name: "429 rate_limit", error: { status: 429, message: "429 Too Many Requests" }, category: "rate_limit", retryable: true, status: 429 },
      { name: "network", error: { message: "connection refused by upstream" }, category: "network", retryable: true },
      { name: "400 request", error: { status: 400, message: "bad request" }, category: "request", retryable: false, status: 400 },
      { name: "空 400 重试", error: { status: 400, message: "400 status code (no body)" }, category: "request", retryable: true, status: 400 },
      { name: "503 transient", error: { status: 503, message: "service unavailable" }, category: "transient", retryable: true, status: 503 },
      { name: "unknown", error: "boom", category: "unknown", retryable: false, message: "boom" },
      { name: "404 terminal", error: { status: 404, message: "model not found" }, category: "request", retryable: false, status: 404 },
      { name: "causeCode", error: { cause: { code: "ECONNRESET" }, message: "fetch failed" }, category: "network", retryable: true, causeCode: "ECONNRESET" },
      { name: "provider/model 提取", error: { provider: "p1", model: { id: "m1" }, message: "boom" }, category: "unknown", retryable: false, provider: "p1", model: "m1" },
      { name: "model 字符串", error: { model: "m-str", message: "boom" }, category: "unknown", retryable: false, model: "m-str" },
      { name: "截断重试", error: { message: "stream ended without finish_reason" }, category: "transient", retryable: true },
      { name: "invalid request", error: { status: 400, message: "invalid request" }, category: "request", retryable: false, status: 400 },
      { name: "5xx transient 文案", error: { message: "502 upstream connect error" }, category: "network", retryable: true },
      { name: "余额不足", error: { message: "available balance is 0" }, category: "quota", retryable: false },
    ];
    for (const { name, error, category, retryable, status, causeCode, provider, model, message } of cases) {
      const result = classifyAgentError(error);
      expect(result.category, name).toBe(category);
      expect(result.retryable, name).toBe(retryable);
      expect({ ...base, ...result }, name).toEqual({
        ...base,
        ...(status !== undefined ? { status } : {}),
        ...(causeCode !== undefined ? { causeCode } : {}),
        ...(provider !== undefined ? { provider } : {}),
        ...(model !== undefined ? { model } : {}),
        category,
        retryable,
        code: (error as any)?.code ? String((error as any).code) : null,
        // classification.message = rawAgentErrorMessage(error)，与入参 message 一致
        message: message ?? (typeof error === "string" ? error : String((error as any).message)),
      });
    }
  });

  it("auth 分类记录 invalidCredentials 并可清除", () => {
    classifyAgentError({ provider: "prov-x", message: "401 Unauthorized" });
    const errors = getCredentialErrors();
    expect(Object.keys(errors)).toEqual(["prov-x"]);
    expect(errors["prov-x"]?.message).toContain("401");
    expect(typeof errors["prov-x"]?.at).toBe("string");
    // 非 auth 不记录
    classifyAgentError({ provider: "p2", message: "boom" });
    expect(getCredentialErrors()["p2"]).toBeUndefined();
    // 清除
    clearInvalidCredential("prov-x");
    expect(getCredentialErrors()["prov-x"]).toBeUndefined();
    // model.provider 路径
    classifyAgentError({ model: { provider: "auth-p" }, message: "401 Unauthorized" });
    expect(getCredentialErrors()["auth-p"]?.message).toContain("401");
  });

  it("createModelTimeoutError / createModelStreamTimeoutError", () => {
    const timeout = createModelTimeoutError();
    expect(timeout.code).toBe("MODEL_TIMEOUT");
    expect(timeout.noRetry).toBe(true);
    expect(timeout.message).toContain(`模型连接超过 ${Math.round(MODEL_FIRST_EVENT_TIMEOUT_MS / 1000)} 秒`);
    const stream = createModelStreamTimeoutError();
    expect(stream.code).toBe("MODEL_STREAM_TIMEOUT");
    expect(stream.noRetry).toBe(true);
    expect(stream.message).toContain(`模型流式输出超过 ${Math.round(MODEL_IDLE_TIMEOUT_MS / 1000)} 秒`);
  });

  it("estimateRestoredContextChars 阈值与 JSON 长度口径", () => {
    const message = { role: "user", content: "x".repeat(200) };
    const cases: Array<[unknown, number]> = [
      [null, 0],
      [{}, 0],
      [{ agent: {} }, 0],
      [{ agent: { state: {} } }, 0],
      [{ agent: { state: { messages: [] } } }, 0],
      [{ agent: { state: { messages: [message] } } }, 228],
      [{ agent: { state: { messages: Array.from({ length: 100 }, () => message) } } }, 22800],
      [{ agent: { state: { messages: [BigInt(1)] } } }, 256],
      [{ agent: { state: { messages: [message, BigInt(2), message] } } }, 712],
      [{ agent: { state: { messages: [{ role: "user", content: "y".repeat(95000) }] } } }, 95028],
    ];
    for (const [sample, expected] of cases) {
      expect(estimateRestoredContextChars(sample), String(sample).slice(0, 80)).toBe(expected);
    }
    // 超阈值提前返回：两条大消息，累计超过 90000 即停
    const big = { content: "z".repeat(60000) };
    const entry = { agent: { state: { messages: [big, big, big] } } };
    expect(estimateRestoredContextChars(entry)).toBe(120028);
  });

  it("resolveThinkingLevel 档位矩阵", () => {
    const cases: Array<[unknown, unknown?, string?]> = [
      [null, undefined, "low"],
      [undefined, undefined, "low"],
      [{ reasoning: false }, undefined, "off"],
      [{ reasoning: true }, undefined, "low"],
      [{}, undefined, "low"],
      [{ thinkingLevelMap: { medium: 1, low: null } }, "medium", "medium"],
      [{ thinkingLevelMap: { medium: null, low: 1 } }, "medium", "low"],
      [{ thinkingLevelMap: { xhigh: null, low: 2 } }, "xhigh", "low"],
      [{ thinkingLevelMap: { max: null, low: null, high: 3 } }, "max", "high"],
      [{ thinkingLevelMap: { minimal: 4 } }, "minimal", "minimal"],
      [{ thinkingLevelMap: { off: 1 } }, "off", "off"],
      [{ thinkingLevelMap: { high: 1 } }, "ultra", "high"],
      [{ thinkingLevelMap: {} }, "medium", "low"],
      [{ thinkingLevelMap: { low: null, high: 9 } }, undefined, "high"],
      [{ thinkingLevelMap: { low: null, high: 9 } }, "high", "high"],
      ["string-model", undefined, "low"],
      [{ thinkingLevelMap: "not-object" }, undefined, "low"],
      [{ thinkingLevelMap: { low: 0 } }, "low", "low"],
    ];
    for (const [model, requested, expected] of cases) {
      const result = requested === undefined ? resolveThinkingLevel(model) : resolveThinkingLevel(model, requested);
      expect(result, JSON.stringify([model, requested])).toBe(expected);
    }
    expect(resolveThinkingLevel({ reasoning: false })).toBe("off");
    expect(resolveThinkingLevel({ thinkingLevelMap: { medium: null, low: 1 } }, "medium")).toBe("low");
  });
});

describe("B6-6-1 office-command 行为覆盖", () => {
  type Script = Array<Partial<OfficeCommandOutput>>;
  function makeRunner(script: Script) {
    const calls: Array<{ args: unknown; options: unknown }> = [];
    const runner = async (args: unknown, options: { cwd?: string }): Promise<OfficeCommandOutput> => {
      calls.push({ args, options });
      const step = script[Math.min(calls.length - 1, script.length - 1)] || {};
      return { code: 0, stdout: "", stderr: "", text: "", ...step };
    };
    return { runner, calls };
  }

  const cases: Array<{ name: string; args: unknown; cwd?: string; script: Script; calls: Array<[unknown, { cwd?: string }]>; result: Record<string, unknown> }> = [
    {
      name: "非 get 透传", args: ["open", "a.docx"], cwd: "C:/ws", script: [{ code: 0, stdout: "opened" }],
      calls: [[["open", "a.docx"], { cwd: "C:/ws" }]],
      result: { code: 0, stdout: "opened", stderr: "", text: "" },
    },
    {
      name: "get 参数不足透传", args: ["get", "a.docx", "/p"], script: [{ code: 0 }],
      calls: [[["get", "a.docx", "/p"], {}]],
      result: { code: 0, stdout: "", stderr: "", text: "" },
    },
    {
      name: "args 非 get 前缀", args: ["GETX", "a.docx", "/p", "--o"], script: [{ code: 3, text: "err" }],
      calls: [[["GETX", "a.docx", "/p", "--o"], {}]],
      result: { code: 3, stdout: "", stderr: "", text: "err" },
    },
    {
      name: "单路径透传", args: ["get", "a.docx", "/body/p1", "--opt", "x"], cwd: "C:/ws", script: [{ code: 0, json: { success: true, data: { matches: 1, results: [{ r: 1 }] } } }],
      calls: [[["get", "a.docx", "/body/p1", "--opt", "x"], { cwd: "C:/ws" }]],
      result: { code: 0, json: { success: true, data: { matches: 1, results: [{ r: 1 }] } }, stdout: "", stderr: "", text: "" },
    },
    {
      name: "多路径拆分合并", args: ["get", "a.docx", "/body/p1", "/body/p2", "--opt", "x"], cwd: "D:/x", script: [
        { code: 0, json: { success: true, data: { matches: 2, results: [{ i: 1 }, { i: 2 }] } }, stdout: "raw1" },
        { code: 0, json: { success: true, data: { matches: 3, results: [{ i: 3 }] } }, stdout: "raw2" },
      ],
      calls: [
        [["get", "a.docx", "/body/p1", "--opt", "x"], { cwd: "D:/x" }],
        [["get", "a.docx", "/body/p2", "--opt", "x"], { cwd: "D:/x" }],
      ],
      result: {
        code: 0, stderr: "",
        command: ["get", "a.docx", "/body/p1", "/body/p2", "--opt", "x"],
        json: { success: true, data: { matches: 5, results: [{ i: 1 }, { i: 2 }, { i: 3 }] } },
      },
    },
    {
      name: "多路径其一失败短路", args: ["get", "a.docx", "/p1", "/p2", "/p3"], script: [
        { code: 0, json: { success: true, data: { matches: 1, results: [] } } },
        { code: 2, stderr: "boom", text: "err" },
        { code: 0 },
      ],
      calls: [
        [["get", "a.docx", "/p1"], {}],
        [["get", "a.docx", "/p2"], {}],
      ],
      result: { code: 2, stdout: "", stderr: "boom", text: "err", command: ["get", "a.docx", "/p1", "/p2", "/p3"] },
    },
    {
      name: "结果缺 json 回落合并", args: ["get", "a.docx", "/p1", "/p2"], script: [
        { code: 0, stdout: "out1", text: "t1" },
        { code: 0, stdout: "out2", text: "t2", stderr: "w" },
      ],
      calls: [
        [["get", "a.docx", "/p1"], {}],
        [["get", "a.docx", "/p2"], {}],
      ],
      result: { code: 0, stdout: "out1\nout2", stderr: "", text: "t1\nt2", command: ["get", "a.docx", "/p1", "/p2"] },
    },
    {
      name: "json 无 results 回落", args: ["get", "a.docx", "/p1", "/p2"], script: [
        { code: 0, json: { success: true, data: { matches: 1 } } },
        { code: 0, json: { success: true, data: { matches: 1 } } },
      ],
      calls: [
        [["get", "a.docx", "/p1"], {}],
        [["get", "a.docx", "/p2"], {}],
      ],
      result: { code: 0, stdout: "\n", stderr: "", text: "\n", command: ["get", "a.docx", "/p1", "/p2"], json: { success: true, data: { matches: 1 } } },
    },
    {
      name: "成功聚合含 false", args: ["get", "f.xlsx", "/s1", "/s2"], script: [
        { code: 0, json: { success: false, data: { matches: 1, results: [{ a: 1 }] } } },
        { code: 0, json: { success: true, data: { matches: "4", results: [{ b: 2 }] } }, stderr: "" },
      ],
      calls: [
        [["get", "f.xlsx", "/s1"], {}],
        [["get", "f.xlsx", "/s2"], {}],
      ],
      result: {
        code: 0, stderr: "",
        command: ["get", "f.xlsx", "/s1", "/s2"],
        json: { success: false, data: { matches: 5, results: [{ a: 1 }, { b: 2 }] } },
      },
    },
    {
      name: "args 为 null", args: null, script: [{ code: 1 }],
      calls: [[null, {}]],
      result: { code: 1, stdout: "", stderr: "", text: "" },
    },
  ];

  for (const { name, args, cwd, script, calls: expectedCalls, result } of cases) {
    it(`runAgentOfficeCommand ${name}`, async () => {
      const n = makeRunner(script);
      const out = await runAgentOfficeCommand(args, n.runner, cwd);
      // 透传/短路/回落场景校验全字段；合并场景 stdout/text 为 pretty JSON，单独断言
      expect(JSON.parse(JSON.stringify({ ...out, stdout: result.stdout !== undefined ? out.stdout : undefined, text: result.text !== undefined ? out.text : undefined }))).toMatchObject(JSON.parse(JSON.stringify(result)));
      expect(JSON.parse(JSON.stringify(n.calls))).toEqual(expectedCalls.map(([args2, options]) => ({ args: args2, options })));
      if (result.json && result.stdout === undefined) {
        // 仅聚合场景（case 未显式给 stdout）：stdout/text 均为 mergedJson 的 pretty JSON
        const text = JSON.stringify(result.json, null, 2);
        expect(out.stdout).toBe(text);
        expect(out.text).toBe(text);
      }
    });
  }

  it("多路径合并结构校验", async () => {
    const n = makeRunner([
      { code: 0, json: { success: true, data: { matches: 2, results: [{ i: 1 }, { i: 2 }] } }, stdout: "raw1", stderr: "warn1" },
      { code: 0, json: { success: true, data: { matches: 3, results: [{ i: 3 }] } }, stdout: "raw2" },
    ]);
    const merged = await runAgentOfficeCommand(["get", "a.docx", "/p1", "/p2", "--opt", "x"], n.runner, "C:/ws");
    expect(n.calls.length).toBe(2);
    expect(n.calls[0]?.args).toEqual(["get", "a.docx", "/p1", "--opt", "x"]);
    expect(n.calls[1]?.args).toEqual(["get", "a.docx", "/p2", "--opt", "x"]);
    expect(n.calls[0]?.options).toEqual({ cwd: "C:/ws" });
    expect(merged.json).toEqual({ success: true, data: { matches: 5, results: [{ i: 1 }, { i: 2 }, { i: 3 }] } });
    expect(merged.command).toEqual(["get", "a.docx", "/p1", "/p2", "--opt", "x"]);
    expect(merged.stderr).toBe("warn1");
    const text = JSON.stringify(merged.json, null, 2);
    expect(merged.stdout).toBe(text);
    expect(merged.text).toBe(text);
  });
});
