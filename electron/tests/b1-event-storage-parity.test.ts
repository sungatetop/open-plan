/**
 * B1-1 event-storage（自 server/event-storage.mjs 354 行转录）。
 *
 * R6-6b 对拍退役改写：旧侧 server/event-storage.mjs 动态 import 与双侧同脚本互等
 * （runBoth + norm 归一比对）随 server 退役删除——等价性已在 B1-1 批对拍验收冻结，
 * 域落盘行为由 smoke 与 runs/memory direct 族的 deps 注入面兜底。保留
 * eventSchemaCheck 开关场景（独立模块实例：RUNTIME_FLAGS 经 feature-flags 在 import
 * 期固化，须 vi.resetModules 重载依赖树让开关重新求值）单侧化。
 */
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FIXED_AT = "2026-01-01T00:00:00.000Z";

describe("B1-1 event-storage", () => {
  it("eventSchemaCheck 开（独立模块实例：resetModules 重载依赖树）：违规告警计数 + 快照", async () => {
    vi.stubEnv("OAW_EVENT_SCHEMA_CHECK", "1");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "b1-events-open-"));
    try {
      vi.stubEnv("OAW_EVENT_DIR", tmp);
      // RUNTIME_FLAGS 经 feature-flags 在 import 期固化——须 vi.resetModules 让
      // feature-flags 重新求值读到开关（B6-6-4f hard 先例）。
      vi.resetModules();
      const openMod = await import("../src/main/backend/event-storage");
      // run_draining 声明 schema required ["runId"]：空 data 触发缺字段告警（且该类型落盘）
      const bad = openMod.appendEvent({ type: "run_draining", data: {}, at: FIXED_AT });
      expect(bad ? "set" : null).toBe("set");
      const snapshot = openMod.eventSchemaViolationsSnapshot().map((v: any) => ({ type: v.type, count: v.count, warned: v.warned, missing: v.missing.length, wrongType: v.wrongType.length }));
      expect(snapshot.length).toBeGreaterThan(0);
      expect(snapshot[0]).toMatchObject({ type: "run_draining", warned: true });
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
      vi.unstubAllEnvs();
    }
  });
});
