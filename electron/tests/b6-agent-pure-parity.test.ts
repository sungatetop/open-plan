/**
 * B6-6-1 对拍：agent.mjs 纯函数/薄 IO 批（tool-schema / usage-text / agent-errors / office-command）。
 *
 * 旧侧不加载 agent.mjs（巨石依赖链过重），而是按行号提取源码段 + new Function 求值
 * （批6d-2 范式）；行号锚点断言保证 agent.mjs 变动时先行失败提醒。
 * 新侧为 electron/src/main/backend/agent 下四个 TS 模块，双侧同输入比较输出。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT_SOURCE = readFileSync(path.resolve(HERE, "../../server/agent.mjs"), "utf8");
const LINES = AGENT_SOURCE.split("\n");
const seg = (start: number, end: number) => LINES.slice(start - 1, end).join("\n").replace(/^export\s+/gm, "");

// 行号锚点：agent.mjs 结构变动导致偏移时，这里先行失败提醒更新提取区间
expect(seg(116, 116)).toContain("function schemaToTypeBox");
expect(seg(227, 227)).toContain("function assistantText");
expect(seg(444, 444)).toContain("const TERMINAL_AGENT_ERROR_PATTERN");
expect(seg(681, 681)).toContain("const THINKING_LEVEL_ORDER");
expect(seg(4765, 4765)).toContain("function runAgentOfficeCommand");

const oldToolSchema = new Function("Type", "path", `${seg(116, 164)}\nreturn { schemaToTypeBox, safePiToolName, extensionToolNames };`)(Type, path);
const oldUsageText = new Function(`${seg(227, 277)}\n${seg(281, 288)}\nreturn { TOOL_OUTPUT_MAX_CHARS, limitToolText, assistantText, eventValueText, normalizeUsage, usageFromEvent };`)();
const oldAgentErrors = new Function(
  "AUTO_COMPACT_PROMPT_CHARS",
  "MODEL_FIRST_EVENT_TIMEOUT_MS",
  "MODEL_IDLE_TIMEOUT_MS",
  `${seg(444, 605)}\n${seg(681, 700)}\nreturn { isProviderTruncation, estimateRestoredContextChars, rawAgentErrorMessage, agentErrorStatus, isEmptyBadRequestError, safeAgentErrorMessage, isAbortLikeError, isUserAbortSettled, createSettledAgentError, captureSettledAgentError, clearInvalidCredential, getCredentialErrors, classifyAgentError, createModelTimeoutError, createModelStreamTimeoutError, resolveThinkingLevel };`,
)(AUTO_COMPACT_PROMPT_CHARS, MODEL_FIRST_EVENT_TIMEOUT_MS, MODEL_IDLE_TIMEOUT_MS);
const oldOffice = new Function(`${seg(4760, 4790)}\nreturn { runAgentOfficeCommand };`)();

/** 双侧 invalidCredentials 清场（用例触达过的 provider 全部清掉）。 */
const TOUCHED_PROVIDERS = ["prov-x", "auth-p", "p1", "p2"];
beforeEach(() => {
  for (const provider of TOUCHED_PROVIDERS) {
    clearInvalidCredential(provider);
    oldAgentErrors.clearInvalidCredential(provider);
  }
});

describe("B6-6-1 tool-schema 对拍", () => {
  it("常量与签名锚点", () => {
    expect(TOOL_OUTPUT_MAX_CHARS).toBe(16000);
    expect(oldUsageText.TOOL_OUTPUT_MAX_CHARS).toBe(TOOL_OUTPUT_MAX_CHARS);
  });

  const schemaSamples: Array<{ name: string; schema: unknown }> = [
    { name: "空对象", schema: {} },
    { name: "null", schema: null },
    { name: "undefined", schema: undefined },
    { name: "enum 单值", schema: { enum: ["only"] } },
    { name: "enum 多值", schema: { enum: ["a", "b", 3, true] } },
    { name: "enum 含对象回落", schema: { enum: ["a", { x: 1 }] } },
    { name: "anyOf 单支", schema: { anyOf: [{ type: "string" }] } },
    { name: "anyOf 多支", schema: { anyOf: [{ type: "string" }, { type: "number" }, { type: "null" }] } },
    { name: "oneOf 超限回落", schema: { oneOf: Array.from({ length: 13 }, () => ({ type: "string" })) } },
    { name: "type 数组去 null", schema: { type: ["string", "null"] } },
    { name: "type 数组全 null", schema: { type: ["null", "null"] } },
    { name: "object required+closed", schema: { type: "object", required: ["a"], properties: { a: { type: "string" }, b: { type: "number" } }, additionalProperties: false } },
    { name: "object 仅 properties", schema: { properties: { a: { type: "string" } } } },
    { name: "object 属性截断100", schema: { type: "object", properties: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`k${i}`, { type: "string" }])) } },
    { name: "array 默认 maxItems", schema: { type: "array", items: { type: "string" } } },
    { name: "array 显式 maxItems", schema: { type: "array", items: { type: "number" }, maxItems: 5 } },
    { name: "array items 缺省", schema: { type: "array" } },
    { name: "string 长度约束", schema: { type: "string", maxLength: 10, minLength: 2 } },
    { name: "string 约束无效", schema: { type: "string", maxLength: "x", minLength: -1 } },
    { name: "integer", schema: { type: "integer" } },
    { name: "number", schema: { type: "number" } },
    { name: "boolean", schema: { type: "boolean" } },
    { name: "null 类型", schema: { type: "null" } },
    { name: "未知类型回落", schema: { type: "foo" } },
    { name: "深嵌套超深度", schema: (() => { let node: unknown = { type: "string" }; for (let i = 0; i < 12; i += 1) node = { type: "object", properties: { n: node } }; return node; })() },
  ];

  for (const { name, schema } of schemaSamples) {
    it(`schemaToTypeBox ${name} 双侧同流`, () => {
      const isNew = schema === undefined ? schemaToTypeBox() : schemaToTypeBox(schema);
      const isOld = schema === undefined ? oldToolSchema.schemaToTypeBox() : oldToolSchema.schemaToTypeBox(schema);
      expect(JSON.parse(JSON.stringify(isNew))).toEqual(JSON.parse(JSON.stringify(isOld)));
    });
  }

  it("schemaToTypeBox enum 含 null 双侧均抛（typebox Literal 不接受 null，旧行为保真）", () => {
    const sample = { enum: ["a", null] };
    expect(() => schemaToTypeBox(sample)).toThrow("Invalid Literal value");
    expect(() => oldToolSchema.schemaToTypeBox(sample)).toThrow("Invalid Literal value");
  });

  it("safePiToolName 样本双侧同流", () => {
    const samples: unknown[] = ["read-file", " 测试 工具!!", "", null, undefined, "a".repeat(100), "_leading__trailing_", "___", "tool.name+ext", 123];
    for (const sample of samples) {
      expect(safePiToolName(sample)).toBe(oldToolSchema.safePiToolName(sample));
    }
    expect(safePiToolName("a".repeat(100), 8)).toBe(oldToolSchema.safePiToolName("a".repeat(100), 8));
  });

  it("extensionToolNames 双侧同流", () => {
    const makeLoader = (extensions: unknown[]) => ({ getExtensions: () => ({ extensions }) });
    const entries = [{ path: "/ws/ext-a" }];
    const cases: Array<{ name: string; loader: unknown; entries: unknown }> = [
      { name: "空 loader", loader: {}, entries },
      { name: "getExtensions 无 extensions 字段", loader: { getExtensions: () => ({}) }, entries },
      { name: "扩展无 tools", loader: makeLoader([{ resolvedPath: "/ws/ext-a/index.js" }]), entries },
      { name: "命中启用根", loader: makeLoader([{ resolvedPath: "/ws/ext-a/index.js", tools: new Map([["t1", {}], ["t2", {}]]) }]), entries },
      { name: "根子目录命中", loader: makeLoader([{ resolvedPath: "/ws/ext-a/sub/tool.js", tools: new Map([["t3", {}]]) }]), entries },
      { name: "未启用路径", loader: makeLoader([{ resolvedPath: "/other/ext-b/index.js", tools: new Map([["t4", {}]]) }]), entries },
      { name: "resolvedPath 缺省用 path", loader: makeLoader([{ path: "/ws/ext-a/x.js", tools: new Map([["t5", {}]]) }]), entries },
      { name: "多扩展去重", loader: makeLoader([
        { resolvedPath: "/ws/ext-a/a.js", tools: new Map([["dup", {}]]) },
        { resolvedPath: "/ws/ext-a/b.js", tools: new Map([["dup", {}], ["only-b", {}]]) },
      ]), entries },
      { name: "兄弟目录不误命中", loader: makeLoader([{ resolvedPath: "/ws/ext-ab/x.js", tools: new Map([["t6", {}]]) }]), entries },
    ];
    for (const { name, loader, entries: ent } of cases) {
      const isNew = extensionToolNames(loader as never, ent as never);
      const isOld = oldToolSchema.extensionToolNames(loader, ent);
      expect([...isNew].sort(), name).toEqual([...isOld].sort());
    }
  });
});

describe("B6-6-1 usage-text 对拍", () => {
  it("limitToolText 短文本原样", () => {
    for (const text of ["", "短文本", "x".repeat(TOOL_OUTPUT_MAX_CHARS), String(null)]) {
      expect(limitToolText(text)).toBe(oldUsageText.limitToolText(text));
    }
  });

  it("limitToolText 长文本首尾截断", () => {
    const long = "H".repeat(20000) + "T".repeat(20000);
    const isNew = limitToolText(long);
    const isOld = oldUsageText.limitToolText(long);
    expect(isNew).toBe(isOld);
    expect(isNew.length).toBeGreaterThan(16000); // 头尾相加 16000 + 截断标记占位
    expect(isNew).toContain("...[输出已截断，原始长度 40000 字符；请使用分段读取继续获取]...");
    expect(isNew.startsWith("H")).toBe(true);
    expect(isNew.endsWith("T")).toBe(true);
    const custom = limitToolText("y".repeat(500), 100);
    expect(custom).toBe(oldUsageText.limitToolText("y".repeat(500), 100));
    expect(custom.length).toBeGreaterThan(100);
  });

  it("assistantText 样本双侧同流", () => {
    const samples: unknown[] = [
      "纯文本",
      { content: "字符串 content" },
      { content: [{ type: "text", text: "A" }, { type: "text", text: "B" }] },
      { content: [{ type: "text", text: "A" }, { type: "tool_call" }, { type: "text", text: "C" }] },
      { content: [{ type: "text" }, { type: "text", text: "" }] },
      { content: [] },
      { content: null },
      { content: 42 },
      null,
      undefined,
      {},
    ];
    for (const sample of samples) {
      expect(assistantText(sample)).toBe(oldUsageText.assistantText(sample));
    }
  });

  it("eventValueText 样本双侧同流", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    const samples: unknown[] = ["文本", undefined, null, 123, { a: 1, b: [1, 2] }, circular];
    for (const sample of samples) {
      expect(eventValueText(sample)).toBe(oldUsageText.eventValueText(sample));
    }
    expect(eventValueText({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it("normalizeUsage 样本双侧同流", () => {
    const samples: unknown[] = [
      null,
      undefined,
      "str",
      42,
      {},
      { inputTokens: 10 },
      { input_tokens: 11, output_tokens: 22 },
      { input: 3, output: 4 },
      { inputTokens: -5, output: 7 },
      { inputTokens: "12", output: NaN },
      { cacheReadTokens: 1, cacheWriteTokens: 2 },
      { cache_read_input_tokens: 5, cache_creation_input_tokens: 6 },
      { contextTokens: 100, totalTokens: 200 },
      { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
      { contextTokens: 0 },
      { totalTokens: 0 },
      { inputTokens: 0, outputTokens: 0 },
    ];
    for (const sample of samples) {
      expect(normalizeUsage(sample), JSON.stringify(sample) ?? String(sample)).toEqual(oldUsageText.normalizeUsage(sample));
    }
    const full = normalizeUsage({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 3, cacheWriteTokens: 4, contextTokens: 100, totalTokens: 30 });
    expect(full).toEqual({
      inputTokens: 10, outputTokens: 20, cacheReadTokens: 3, cacheWriteTokens: 4,
      input: 10, output: 20, cacheRead: 3, cacheWrite: 4, context: 100, totalTokens: 30,
    });
    const derived = normalizeUsage({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
    expect(derived?.context).toBe(8);
    expect(derived?.totalTokens).toBe(10);
    expect(derived).toEqual(oldUsageText.normalizeUsage({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }));
  });

  it("usageFromEvent 候选链双侧同流", () => {
    const usage = { inputTokens: 9, outputTokens: 8 };
    const samples: unknown[] = [
      null,
      {},
      { usage },
      { usage: null, tokens: { input_tokens: 5 } },
      { usage: null, tokens: null, message: { usage } },
      { usage: null, tokens: null, message: { tokens: { input: 2 } } },
      { usage: null, tokens: null, message: null, response: { usage } },
      { usage: null, tokens: null, message: null, response: null, result: { usage } },
      { usage: {}, tokens: { inputTokens: 7 } },
    ];
    for (const sample of samples) {
      expect(usageFromEvent(sample), JSON.stringify(sample)).toEqual(oldUsageText.usageFromEvent(sample));
    }
  });
});

describe("B6-6-1 agent-errors 对拍", () => {
  it("超时常量与 env 公式一致", () => {
    expect(AUTO_COMPACT_PROMPT_CHARS).toBe(90000);
    expect(MODEL_FIRST_EVENT_TIMEOUT_MS).toBe(Math.max(10000, Number.parseInt(process.env.OAW_MODEL_FIRST_EVENT_TIMEOUT_MS || "45000", 10) || 45000));
    expect(MODEL_IDLE_TIMEOUT_MS).toBe(Math.max(30000, Number.parseInt(process.env.OAW_MODEL_IDLE_TIMEOUT_MS || "120000", 10) || 120000));
    expect(MODEL_FIRST_EVENT_TIMEOUT_MS).toBeGreaterThanOrEqual(10000);
    expect(MODEL_IDLE_TIMEOUT_MS).toBeGreaterThanOrEqual(30000);
  });

  it("rawAgentErrorMessage 样本双侧同流", () => {
    const samples: unknown[] = ["直接字符串", new Error("boom"), { message: "m" }, { cause: { message: "c" } }, { cause: { code: "X" } }, {}, null, undefined, 0, 5, true, ["x"]];
    for (const sample of samples) {
      expect(rawAgentErrorMessage(sample), String(sample)).toBe(oldAgentErrors.rawAgentErrorMessage(sample));
    }
    expect(rawAgentErrorMessage(null)).toBe("模型连接失败");
    expect(rawAgentErrorMessage(0)).toBe("模型连接失败");
  });

  it("agentErrorStatus 样本双侧同流", () => {
    const cases: Array<[unknown, string?]> = [
      [{ status: 401 }],
      [{ statusCode: 429 }],
      [{ response: { status: 500 } }],
      [{ status: 0 }],
      [{ statusCode: 200 }],
      [new Error("Error: 503 status code from gateway")],
      ["502 status code returned"],
      ["no status here"],
      [{ status: 401 }, "ignored message 500 status code"],
      [{}, "body mentions 418 status code explicitly"],
    ];
    for (const [error, message] of cases) {
      expect(agentErrorStatus(error, message), JSON.stringify([error?.toString?.(), message])).toBe(oldAgentErrors.agentErrorStatus(error, message));
    }
  });

  it("isEmptyBadRequestError 样本双侧同流", () => {
    const samples: unknown[] = [
      new Error("400 status code (no body)"),
      new Error("400 status code (empty response body)"),
      new Error("400 status code"),
      new Error("400 status code") as Error & { body?: string },
      { message: "400 status code", body: "400 status code (no body)" },
      { message: "boom", responseBody: "400 status code (empty response body)" },
      new Error("404 status code (no body)"),
      new Error("500 status code (no body)"),
      "boom",
    ];
    for (const sample of samples) {
      expect(isEmptyBadRequestError(sample), String(sample)).toBe(oldAgentErrors.isEmptyBadRequestError(sample));
    }
  });

  it("safeAgentErrorMessage 脱敏与截断", () => {
    const samples: unknown[] = [
      "api_key=sk-abcdef12345",
      "Authorization: Bearer sk-xyz",
      "bearer token: qqq",
      "access_token=aaa; refresh_token: bbb",
      "普通错误消息",
      "",
      null,
      "z".repeat(3000),
    ];
    for (const sample of samples) {
      expect(safeAgentErrorMessage(sample), String(sample)).toBe(oldAgentErrors.safeAgentErrorMessage(sample));
    }
    expect(safeAgentErrorMessage("api_key=secret")).not.toContain("secret");
    expect(safeAgentErrorMessage("z".repeat(3000)).length).toBe(1200);
  });

  it("isAbortLikeError 样本双侧同流", () => {
    const samples: unknown[] = [
      "Request aborted",
      "request was aborted by user",
      "任务在完成前被中断",
      "操作已中断",
      "已取消",
      "aborted",
      "The request was cancelled",
      new Error("user interrupted"),
      "boom",
      "超时了",
      "",
      null,
    ];
    for (const sample of samples) {
      expect(isAbortLikeError(sample), String(sample)).toBe(oldAgentErrors.isAbortLikeError(sample));
    }
  });

  it("isUserAbortSettled 组合矩阵", () => {
    const aborted = new Error("Request aborted");
    const normal = new Error("boom");
    const cases: Array<{ name: string; entry: unknown; value: unknown }> = [
      { name: "cancelRequested + abort", entry: { cancelRequested: true }, value: aborted },
      { name: "cancelRequested + 普通错误", entry: { cancelRequested: true }, value: normal },
      { name: "无中断标记", entry: {}, value: aborted },
      { name: "abortRequestedAt 2 分钟内", entry: { abortRequestedAt: Date.now() - 1000 }, value: aborted },
      { name: "abortRequestedAt 超 2 分钟", entry: { abortRequestedAt: Date.now() - 130000 }, value: aborted },
      { name: "entry 为 null", entry: null, value: aborted },
      { name: "abortRequestedAt falsy", entry: { abortRequestedAt: 0 }, value: aborted },
    ];
    for (const { name, entry, value } of cases) {
      expect(isUserAbortSettled(entry, value), name).toBe(oldAgentErrors.isUserAbortSettled(entry, value));
    }
  });

  it("isProviderTruncation 样本双侧同流", () => {
    const samples: unknown[] = [
      "stream ended without finish_reason",
      "Response stream closed unexpectedly",
      "unexpected end of stream",
      "stream ended unexpectedly",
      new Error("without finish_reason"),
      "rate limit exceeded",
      "",
      null,
    ];
    for (const sample of samples) {
      expect(isProviderTruncation(sample), String(sample)).toBe(oldAgentErrors.isProviderTruncation(sample));
    }
  });

  it("createSettledAgentError 分类注入", () => {
    const samples: unknown[] = [
      "Invalid API key provided",
      "boom",
      "429 rate limit exceeded",
      "provider is not configured",
      "api_key=sk-secret leaked",
    ];
    for (const sample of samples) {
      const isNew = createSettledAgentError(sample);
      const isOld = oldAgentErrors.createSettledAgentError(sample);
      expect(isNew.message, String(sample)).toBe(isOld.message);
      expect(isNew.code).toBe(isOld.code);
      expect(isNew.status).toBe(isOld.status);
      expect(isNew.errorCategory).toBe(isOld.errorCategory);
      expect(isNew.noRetry).toBe(isOld.noRetry);
      expect(isNew.oawClassification).toEqual(isOld.oawClassification);
    }
    const settled = createSettledAgentError("Invalid API key provided");
    expect(settled.errorCategory).toBe("auth");
    expect(settled.noRetry).toBe(true);
    expect(settled.code).toBe("PI_SETTLED_ERROR");
  });

  it("captureSettledAgentError 回写与脱敏", () => {
    const newEntry: Record<string, unknown> = { lastAgentError: "api_key=abc123 boom" };
    const oldEntry: Record<string, unknown> = { lastAgentError: "api_key=abc123 boom" };
    expect(captureSettledAgentError(newEntry)).toBe(oldAgentErrors.captureSettledAgentError(oldEntry));
    expect(newEntry.lastSettledError).toBe(oldEntry.lastSettledError);
    expect(captureSettledAgentError(newEntry)).not.toContain("abc123");
    const emptyNew: Record<string, unknown> = {};
    const emptyOld: Record<string, unknown> = {};
    expect(captureSettledAgentError(emptyNew)).toBe(oldAgentErrors.captureSettledAgentError(emptyOld));
    expect(emptyNew.lastSettledError).toBeNull();
  });

  it("classifyAgentError 分类矩阵", () => {
    const cases: Array<{ name: string; error: unknown }> = [
      { name: "401 auth", error: { status: 401, message: "401 Unauthorized" } },
      { name: "403 文案", error: { message: "403 Forbidden" } },
      { name: "AUTH_ERROR 类别", error: { errorCategory: "AUTH_ERROR", message: "boom" } },
      { name: "quota", error: { message: "quota exceeded for this month" } },
      { name: "configuration", error: { message: "provider is not configured" } },
      { name: "timeout code", error: { code: "MODEL_TIMEOUT", message: "模型连接超过 45 秒没有响应，已自动中止" } },
      { name: "429 rate_limit", error: { status: 429, message: "429 Too Many Requests" } },
      { name: "network", error: { message: "connection refused by upstream" } },
      { name: "400 request", error: { status: 400, message: "bad request" } },
      { name: "空 400 重试", error: { status: 400, message: "400 status code (no body)" } },
      { name: "503 transient", error: { status: 503, message: "service unavailable" } },
      { name: "unknown", error: "boom" },
      { name: "404 terminal", error: { status: 404, message: "model not found" } },
      { name: "causeCode", error: { cause: { code: "ECONNRESET" }, message: "fetch failed" } },
      { name: "provider/model 提取", error: { provider: "p1", model: { id: "m1" }, message: "boom" } },
      { name: "model 字符串", error: { model: "m-str", message: "boom" } },
      { name: "截断重试", error: { message: "stream ended without finish_reason" } },
      { name: "invalid request", error: { status: 400, message: "invalid request" } },
      { name: "5xx transient 文案", error: { message: "502 upstream connect error" } },
      { name: "余额不足", error: { message: "available balance is 0" } },
    ];
    for (const { name, error } of cases) {
      const isNew = classifyAgentError(error);
      const isOld = oldAgentErrors.classifyAgentError(error);
      expect(isNew, name).toEqual(isOld);
    }
  });

  it("auth 分类记录 invalidCredentials 并可清除", () => {
    classifyAgentError({ provider: "prov-x", message: "401 Unauthorized" });
    oldAgentErrors.classifyAgentError({ provider: "prov-x", message: "401 Unauthorized" });
    const newErrors = getCredentialErrors();
    const oldErrors = oldAgentErrors.getCredentialErrors();
    expect(Object.keys(newErrors).sort()).toEqual(Object.keys(oldErrors).sort());
    expect(newErrors["prov-x"]?.message).toBe(oldErrors["prov-x"]?.message);
    expect(newErrors["prov-x"]?.message).toContain("401");
    expect(typeof newErrors["prov-x"]?.at).toBe("string");
    // 非 auth 不记录
    classifyAgentError({ provider: "p2", message: "boom" });
    oldAgentErrors.classifyAgentError({ provider: "p2", message: "boom" });
    expect(getCredentialErrors()["p2"]).toBeUndefined();
    expect(oldAgentErrors.getCredentialErrors()["p2"]).toBeUndefined();
    // 清除
    clearInvalidCredential("prov-x");
    oldAgentErrors.clearInvalidCredential("prov-x");
    expect(getCredentialErrors()["prov-x"]).toBeUndefined();
    expect(oldAgentErrors.getCredentialErrors()["prov-x"]).toBeUndefined();
    // model.provider 路径
    classifyAgentError({ model: { provider: "auth-p" }, message: "401 Unauthorized" });
    oldAgentErrors.classifyAgentError({ model: { provider: "auth-p" }, message: "401 Unauthorized" });
    expect(getCredentialErrors()["auth-p"]?.message).toBe(oldAgentErrors.getCredentialErrors()["auth-p"]?.message);
  });

  it("createModelTimeoutError / createModelStreamTimeoutError", () => {
    for (const [factory, oldFactory] of [[createModelTimeoutError, oldAgentErrors.createModelTimeoutError], [createModelStreamTimeoutError, oldAgentErrors.createModelStreamTimeoutError]] as const) {
      const isNew = factory();
      const isOld = oldFactory();
      expect(isNew.message).toBe(isOld.message);
      expect(isNew.code).toBe(isOld.code);
      expect(isNew.noRetry).toBe(true);
    }
    expect(createModelTimeoutError().message).toContain(`模型连接超过 ${Math.round(MODEL_FIRST_EVENT_TIMEOUT_MS / 1000)} 秒`);
    expect(createModelStreamTimeoutError().message).toContain(`模型流式输出超过 ${Math.round(MODEL_IDLE_TIMEOUT_MS / 1000)} 秒`);
  });

  it("estimateRestoredContextChars 双侧同流", () => {
    const message = { role: "user", content: "x".repeat(200) };
    const cases: unknown[] = [
      null,
      {},
      { agent: {} },
      { agent: { state: {} } },
      { agent: { state: { messages: [] } } },
      { agent: { state: { messages: [message] } } },
      { agent: { state: { messages: Array.from({ length: 100 }, () => message) } } },
      { agent: { state: { messages: [BigInt(1)] } } },
      { agent: { state: { messages: [message, BigInt(2), message] } } },
      { agent: { state: { messages: [{ role: "user", content: "y".repeat(95000) }] } } },
    ];
    for (const sample of cases) {
      expect(estimateRestoredContextChars(sample), String(sample).slice(0, 80)).toBe(oldAgentErrors.estimateRestoredContextChars(sample));
    }
    // 超阈值提前返回：两条大消息，累计超过 90000 即停
    const big = { content: "z".repeat(60000) };
    const entry = { agent: { state: { messages: [big, big, big] } } };
    expect(estimateRestoredContextChars(entry)).toBeLessThan(180050);
    expect(estimateRestoredContextChars(entry)).toBe(oldAgentErrors.estimateRestoredContextChars(entry));
  });

  it("resolveThinkingLevel 档位矩阵", () => {
    const cases: Array<[unknown, unknown?]> = [
      [null],
      [undefined],
      [{ reasoning: false }],
      [{ reasoning: true }],
      [{}],
      [{ thinkingLevelMap: { medium: 1, low: null } }, "medium"],
      [{ thinkingLevelMap: { medium: null, low: 1 } }, "medium"],
      [{ thinkingLevelMap: { xhigh: null, low: 2 } }, "xhigh"],
      [{ thinkingLevelMap: { max: null, low: null, high: 3 } }, "max"],
      [{ thinkingLevelMap: { minimal: 4 } }, "minimal"],
      [{ thinkingLevelMap: { off: 1 } }, "off"],
      [{ thinkingLevelMap: { high: 1 } }, "ultra"],
      [{ thinkingLevelMap: {} }, "medium"],
      [{ thinkingLevelMap: { low: null, high: 9 } }],
      [{ thinkingLevelMap: { low: null, high: 9 } }, "high"],
      ["string-model"],
      [{ thinkingLevelMap: "not-object" }],
      [{ thinkingLevelMap: { low: 0 } }, "low"],
    ];
    for (const [model, requested] of cases) {
      const isNew = requested === undefined ? resolveThinkingLevel(model) : resolveThinkingLevel(model, requested);
      const isOld = requested === undefined ? oldAgentErrors.resolveThinkingLevel(model) : oldAgentErrors.resolveThinkingLevel(model, requested);
      expect(isNew, JSON.stringify([model, requested])).toBe(isOld);
    }
    expect(resolveThinkingLevel({ reasoning: false })).toBe("off");
    expect(resolveThinkingLevel({ thinkingLevelMap: { medium: null, low: 1 } }, "medium")).toBe("low");
  });
});

describe("B6-6-1 office-command 对拍", () => {
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
  const summarizeCalls = (calls: Array<{ args: unknown; options: unknown }>) => JSON.parse(JSON.stringify(calls));

  const cases: Array<{ name: string; args: unknown; cwd?: string; script: Script }> = [
    { name: "非 get 透传", args: ["open", "a.docx"], cwd: "C:/ws", script: [{ code: 0, stdout: "opened" }] },
    { name: "get 参数不足透传", args: ["get", "a.docx", "/p"], script: [{ code: 0 }] },
    { name: "args 非 get 前缀", args: ["GETX", "a.docx", "/p", "--o"], script: [{ code: 3, text: "err" }] },
    { name: "单路径透传", args: ["get", "a.docx", "/body/p1", "--opt", "x"], cwd: "C:/ws", script: [{ code: 0, json: { success: true, data: { matches: 1, results: [{ r: 1 }] } } }] },
    { name: "多路径拆分合并", args: ["get", "a.docx", "/body/p1", "/body/p2", "--opt", "x"], cwd: "D:/x", script: [
      { code: 0, json: { success: true, data: { matches: 2, results: [{ i: 1 }, { i: 2 }] } }, stdout: "raw1" },
      { code: 0, json: { success: true, data: { matches: 3, results: [{ i: 3 }] } }, stdout: "raw2" },
    ] },
    { name: "多路径其一失败短路", args: ["get", "a.docx", "/p1", "/p2", "/p3"], script: [
      { code: 0, json: { success: true, data: { matches: 1, results: [] } } },
      { code: 2, stderr: "boom", text: "err" },
      { code: 0 },
    ] },
    { name: "结果缺 json 回落合并", args: ["get", "a.docx", "/p1", "/p2"], script: [
      { code: 0, stdout: "out1", text: "t1" },
      { code: 0, stdout: "out2", text: "t2", stderr: "w" },
    ] },
    { name: "json 无 results 回落", args: ["get", "a.docx", "/p1", "/p2"], script: [
      { code: 0, json: { success: true, data: { matches: 1 } } },
      { code: 0, json: { success: true, data: { matches: 1 } } },
    ] },
    { name: "成功聚合含 false", args: ["get", "f.xlsx", "/s1", "/s2"], script: [
      { code: 0, json: { success: false, data: { matches: 1, results: [{ a: 1 }] } } },
      { code: 0, json: { success: true, data: { matches: "4", results: [{ b: 2 }] } }, stderr: "" },
    ] },
    { name: "args 为 null", args: null, script: [{ code: 1 }] },
  ];

  for (const { name, args, cwd, script } of cases) {
    it(`runAgentOfficeCommand ${name}`, async () => {
      const n = makeRunner(script);
      const o = makeRunner(script);
      const isNew = await runAgentOfficeCommand(args, n.runner, cwd);
      const isOld = await oldOffice.runAgentOfficeCommand(args, o.runner, cwd);
      expect(JSON.parse(JSON.stringify(isNew)), name).toEqual(JSON.parse(JSON.stringify(isOld)));
      expect(summarizeCalls(n.calls)).toEqual(summarizeCalls(o.calls));
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
