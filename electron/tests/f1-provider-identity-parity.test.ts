import { describe, it, expect } from "vitest";
import * as desktop from "../src/renderer/lib/provider-identity";
import desktopDefault from "../src/renderer/lib/provider-identity";

const serverModule = await import("../../client/src/provider-identity.js");
const server = serverModule as unknown as typeof desktop;
const serverDefault = (serverModule as { default: Record<string, { label: string; icon: string }> }).default;

describe("provider-identity TS 版与 client 版等价（对拍）", () => {
  it("供应商标识默认导出逐字段一致", () => {
    expect({ ...desktopDefault }).toEqual({ ...serverDefault });
    expect(Object.keys(desktopDefault).sort()).toEqual(Object.keys(serverDefault).sort());
    expect(desktopDefault.ollama).toEqual({ label: "Ollama", icon: "ollama" });
    expect(desktopDefault["openai-codex"]).toEqual({ label: "OpenAI Codex", icon: "openai" });
  });

  it("providerIdentity：已知/未知/异型 id 一致", () => {
    const ids: unknown[] = [
      "anthropic", "deepseek", "openai-codex", "google-vertex", "qwen-token-plan-cn",
      "  ANTHROPIC  ", "DEEPSEEK",
      "weird-id", "", " ", null, undefined, 0, false, 123, Number.NaN, true, {}, ["anthropic"],
    ];
    for (const id of ids) {
      expect(desktop.providerIdentity(id)).toEqual(server.providerIdentity(id));
    }
    expect(desktop.providerIdentity("anthropic")).toEqual({ id: "anthropic", label: "Anthropic", icon: "anthropic" });
    expect(desktop.providerIdentity("  ANTHROPIC  ")).toEqual({ id: "ANTHROPIC", label: "Anthropic", icon: "anthropic" }); // trim 保留原大小写
    expect(desktop.providerIdentity("weird-id")).toEqual({ id: "weird-id", label: "weird-id", icon: "custom" });
    expect(desktop.providerIdentity("")).toEqual({ id: "", label: "自定义供应商", icon: "custom" });
    expect(desktop.providerIdentity(undefined)).toEqual({ id: "", label: "自定义供应商", icon: "custom" });
    expect(desktop.providerIdentity(123)).toEqual({ id: "123", label: "123", icon: "custom" });
    expect(desktop.providerIdentity(Number.NaN)).toEqual({ id: "", label: "自定义供应商", icon: "custom" }); // NaN falsy
    expect(desktop.providerIdentity({})).toEqual({ id: "[object Object]", label: "[object Object]", icon: "custom" });
    expect(desktop.providerIdentity(["anthropic"])).toEqual({ id: "anthropic", label: "Anthropic", icon: "anthropic" }); // String(数组) 拼接
  });

  it("providerLabel / providerIconKey 一致", () => {
    const ids: unknown[] = ["anthropic", "zai", "kimi-coding", "groq", "unknown-x", null, ""];
    for (const id of ids) {
      expect(desktop.providerLabel(id)).toBe(server.providerLabel(id));
      expect(desktop.providerIconKey(id)).toBe(server.providerIconKey(id));
    }
    expect(desktop.providerLabel("zai")).toBe("Z.AI");
    expect(desktop.providerIconKey("kimi-coding")).toBe("kimi");
    expect(desktop.providerIconKey("groq")).toBe("custom"); // 无品牌图形 → custom 兜底
    expect(desktop.providerLabel("unknown-x")).toBe("unknown-x");
  });
});
