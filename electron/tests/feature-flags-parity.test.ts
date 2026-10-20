import { describe, it, expect, vi } from "vitest";

// 关键点：两个实现都在模块加载时解析 env，必须先改 env 再动态 import 两侧
process.env.OAW_QODER_ALIGN = "1";
process.env.OAW_HEARTBEAT_CHAT_MS = "3000";
process.env.OAW_PI_SIDECAR_IDLE_MS = "not-a-number";
process.env.OAW_BROWSER_URL_ALLOWLIST = "Example.COM, b.cn；  c.cn ,";
process.env.OAW_EVENT_SCHEMA_CHECK = "0";

const serverModule = await import("../../server/feature-flags.mjs");
const desktopModule = await import("../src/shared/runtime/feature-flags");

const server = serverModule as unknown as {
  RUNTIME_FLAGS: Record<string, unknown>;
  runtimeFlagsSnapshot(): Record<string, unknown>;
};

describe("feature-flags TS 版与 server 版等价（对拍）", () => {
  it("QODER_ALIGN=1 场景：RUNTIME_FLAGS 与快照逐字段一致", () => {
    expect({ ...desktopModule.RUNTIME_FLAGS }).toEqual({ ...server.RUNTIME_FLAGS });
    expect(desktopModule.runtimeFlagsSnapshot()).toEqual(server.runtimeFlagsSnapshot());
    // 总开关族派生：OAW_EVENT_SCHEMA_CHECK=0 但总开关开 → 仍为 true
    expect(desktopModule.RUNTIME_FLAGS.qoderAlign).toBe(true);
    expect(desktopModule.RUNTIME_FLAGS.qoderSseBackoff).toBe(true);
    expect(desktopModule.RUNTIME_FLAGS.eventSchemaCheck).toBe(true);
    // 数值解析：合法取值生效、非法取值回退默认
    expect(desktopModule.RUNTIME_FLAGS.heartbeatChatMs).toBe(3000);
    expect(desktopModule.RUNTIME_FLAGS.piBashSidecarIdleMs).toBe(10 * 60 * 1000);
    // 字符串列表：全角分号/逗号/空白分隔 + 小写归一 + 空项过滤
    expect(desktopModule.RUNTIME_FLAGS.browserUrlAllowlist).toEqual(["example.com", "b.cn", "c.cn"]);
  });

  it("env 清空后重载：默认值场景逐字段一致", async () => {
    vi.resetModules();
    delete process.env.OAW_QODER_ALIGN;
    delete process.env.OAW_HEARTBEAT_CHAT_MS;
    delete process.env.OAW_PI_SIDECAR_IDLE_MS;
    delete process.env.OAW_BROWSER_URL_ALLOWLIST;
    delete process.env.OAW_EVENT_SCHEMA_CHECK;
    const serverModule2 = await import("../../server/feature-flags.mjs");
    const desktopModule2 = await import("../src/shared/runtime/feature-flags");
    const server2 = serverModule2 as unknown as {
      RUNTIME_FLAGS: Record<string, unknown>;
      runtimeFlagsSnapshot(): Record<string, unknown>;
    };
    expect({ ...desktopModule2.RUNTIME_FLAGS }).toEqual({ ...server2.RUNTIME_FLAGS });
    expect(desktopModule2.runtimeFlagsSnapshot()).toEqual(server2.runtimeFlagsSnapshot());
    expect(desktopModule2.RUNTIME_FLAGS.qoderAlign).toBe(false);
    expect(desktopModule2.RUNTIME_FLAGS.qoderSseBackoff).toBe(false);
    expect(desktopModule2.RUNTIME_FLAGS.eventSchemaCheck).toBe(false);
    expect(desktopModule2.RUNTIME_FLAGS.heartbeatChatMs).toBe(5000);
    expect(desktopModule2.RUNTIME_FLAGS.browserUrlAllowlist).toEqual([]);
    // 快照形状：布尔位 + 数值位逐个对齐
    expect(Object.keys(desktopModule2.runtimeFlagsSnapshot()).sort()).toEqual(Object.keys(server2.runtimeFlagsSnapshot()).sort());
  });
});
