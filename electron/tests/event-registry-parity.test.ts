import { describe, it, expect } from "vitest";
import {
  EVENT_REGISTRY,
  EVENT_TYPES,
  LIFECYCLE_EVENT_TYPES,
  DELTA_EVENT_TYPES,
  PERSISTED_TYPES,
  validateEventPayload,
  registrySummary
} from "../src/shared/protocol/event-registry";
import type { PayloadValidation } from "../src/shared/protocol/event-registry";

// 直接对拍迁移期权威实现（B1 批次完成后 server 版退役）
const serverModule = await import("../../server/event-registry.mjs");
const serverValidate = serverModule.validateEventPayload as (type: unknown, data?: unknown) => PayloadValidation;

interface ServerSpec { type: string; lifecycle: boolean; persist: boolean; note: string; schema?: unknown }

describe("事件注册表 TS 版与 server 版等价（对拍）", () => {
  it("事件类型清单逐条一致且有序", () => {
    const serverTypes: string[] = [...serverModule.EVENT_TYPES];
    expect(EVENT_TYPES).toEqual(serverTypes);
  });

  it("每条事件规格（lifecycle/persist/note/schema）完全一致", () => {
    const serverSpecs = new Map<string, ServerSpec>(serverModule.EVENT_REGISTRY.map((item: ServerSpec) => [item.type, item]));
    for (const spec of EVENT_REGISTRY) {
      const serverSpec = serverSpecs.get(spec.type);
      expect(serverSpec, `server 版缺少事件 ${spec.type}`).toBeDefined();
      expect(spec.lifecycle, `${spec.type}.lifecycle`).toBe(serverSpec?.lifecycle);
      expect(spec.persist, `${spec.type}.persist`).toBe(serverSpec?.persist);
      expect(spec.note, `${spec.type}.note`).toBe(serverSpec?.note);
      expect(spec.schema ?? null, `${spec.type}.schema`).toEqual(serverSpec?.schema ?? null);
    }
    expect(serverSpecs.size).toBe(EVENT_REGISTRY.length);
  });

  it("派生集合（lifecycle/persisted/delta）与摘要一致", () => {
    expect([...LIFECYCLE_EVENT_TYPES]).toEqual([...serverModule.LIFECYCLE_EVENT_TYPES]);
    expect([...PERSISTED_TYPES]).toEqual([...serverModule.PERSISTED_TYPES]);
    expect([...DELTA_EVENT_TYPES]).toEqual([...serverModule.DELTA_EVENT_TYPES]);
    expect(registrySummary()).toEqual(serverModule.registrySummary());
  });

  it("validateEventPayload 行为一致（含声明 schema 与未声明的事件）", () => {
    const normalize = (v: PayloadValidation) => ({ ...v });
    // 未声明 schema 的事件：一律 skipped
    expect(normalize(validateEventPayload("prompt", {}))).toEqual(normalize(serverValidate("prompt", {})));
    // 声明 schema 的事件：通过/缺字段/错类型
    const cases: Array<[string | null, unknown]> = [
      ["run_finished", { runId: "r1", status: "done", artifacts: [] }],
      ["run_finished", { status: "done" }],
      ["run_finished", { runId: "r1", status: 42 }],
      ["tool_end", { name: "write", isError: false }],
      ["tool_end", { isError: true }],
      ["ask_user", { askId: "a1", question: "q", options: [] }],
      ["未登记事件", {}],
      [null, undefined]
    ];
    for (const [type, data] of cases) {
      expect(normalize(validateEventPayload(type, data))).toEqual(normalize(serverValidate(type, data)));
    }
  });

  it("注册表自洽：persist 必须同时 lifecycle，且无重复类型", () => {
    const types = new Set<string>();
    for (const spec of EVENT_REGISTRY) {
      expect(types.has(spec.type), `重复事件类型 ${spec.type}`).toBe(false);
      types.add(spec.type);
      if (spec.persist) expect(spec.lifecycle, `${spec.type} 标记了 persist 但未标记 lifecycle`).toBe(true);
    }
  });
});
