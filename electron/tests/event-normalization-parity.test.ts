import { describe, it, expect } from "vitest";
import {
  CANONICAL_SCHEMA_VERSION,
  PI_EVENT_TO_CANONICAL,
  normalizePiEvent,
  canonicalFromEnvelope,
  assertCanonicalShape
} from "../src/shared/runtime/event-normalization";

const serverModule = await import("../../server/event-normalization.mjs");
// server 版为 JS 推断签名，测试用宽容视图以覆盖 null/undefined/异型输入
const server = serverModule as unknown as {
  CANONICAL_SCHEMA_VERSION: number;
  PI_EVENT_TO_CANONICAL: Record<string, string>;
  normalizePiEvent(input?: unknown, extra?: { payload?: unknown }): unknown;
  canonicalFromEnvelope(ev?: unknown): unknown;
  assertCanonicalShape(obj?: unknown): true;
};

describe("event-normalization TS 版与 server 版等价（对拍）", () => {
  it("schema 版本与映射表一致", () => {
    expect(CANONICAL_SCHEMA_VERSION).toBe(server.CANONICAL_SCHEMA_VERSION);
    expect({ ...PI_EVENT_TO_CANONICAL }).toEqual({ ...server.PI_EVENT_TO_CANONICAL });
  });

  it("normalizePiEvent 已登记/未登记/空入参一致", () => {
    const cases = [
      { type: "agent_start" },
      { type: "tool_execution_update", toolCallId: "t1", turnIndex: 2 },
      { type: "mystery_event" },
      { type: "" },
      {},
      null,
      undefined
    ];
    for (const input of cases) {
      expect(normalizePiEvent(input as never)).toEqual(server.normalizePiEvent(input));
      expect(normalizePiEvent(input as never, { payload: { a: 1 } })).toEqual(server.normalizePiEvent(input, { payload: { a: 1 } }));
      expect(normalizePiEvent(input as never, { payload: "not-object" })).toEqual(server.normalizePiEvent(input, { payload: "not-object" }));
    }
  });

  it("canonicalFromEnvelope 信封转换一致", () => {
    const cases = [
      { protocolVersion: 2, id: "e1", seq: 7, type: "tool_end", at: "2026-10-20T00:00:00Z", data: { runId: "r1", turnIndex: 3, toolCallId: "t9", extra: 1 } },
      { id: "e2", type: "run_finished", data: null },
      { type: "unknown_kind" },
      "not-an-object",
      null,
      undefined
    ];
    for (const input of cases) {
      expect(canonicalFromEnvelope(input)).toEqual(server.canonicalFromEnvelope(input));
    }
  });

  it("assertCanonicalShape 断言行为一致", () => {
    expect(assertCanonicalShape({ type: "x", status: "ended" })).toBe(server.assertCanonicalShape({ type: "x", status: "ended" }));
    expect(() => assertCanonicalShape(null)).toThrow();
    expect(() => assertCanonicalShape({ type: "x" })).toThrow(/status/);
    expect(() => assertCanonicalShape({ type: "x", status: "ended", schemaVersion: 99 })).toThrow(/schemaVersion/);
    expect(() => server.assertCanonicalShape(null)).toThrow();
    expect(() => server.assertCanonicalShape({ type: "x" })).toThrow(/status/);
    expect(() => server.assertCanonicalShape({ type: "x", status: "ended", schemaVersion: 99 })).toThrow(/schemaVersion/);
  });
});
