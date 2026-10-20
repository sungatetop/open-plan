import { describe, it, expect } from "vitest";
import { resolveRendererTarget } from "../src/main/util/renderer-target";

describe("resolveRendererTarget（OP_DESKTOP_NEW_UI 门控，默认关）", () => {
  it("默认与非法取值一律走旧 client（功能不变）", () => {
    expect(resolveRendererTarget({})).toBe("legacy-client");
    expect(resolveRendererTarget({ OP_DESKTOP_NEW_UI: "" })).toBe("legacy-client");
    expect(resolveRendererTarget({ OP_DESKTOP_NEW_UI: "0" })).toBe("legacy-client");
    expect(resolveRendererTarget({ OP_DESKTOP_NEW_UI: "true" })).toBe("legacy-client");
    expect(resolveRendererTarget({ OP_DESKTOP_NEW_UI: "on" })).toBe("legacy-client");
    expect(resolveRendererTarget({ OP_DESKTOP_NEW_UI: " 1" })).toBe("legacy-client");
  });

  it("仅精确 '1' 走新 UI 应用页", () => {
    expect(resolveRendererTarget({ OP_DESKTOP_NEW_UI: "1" })).toBe("app");
  });

  it("缺省 env 读取 process.env", () => {
    const prev = process.env.OP_DESKTOP_NEW_UI;
    try {
      delete process.env.OP_DESKTOP_NEW_UI;
      expect(resolveRendererTarget()).toBe("legacy-client");
      process.env.OP_DESKTOP_NEW_UI = "1";
      expect(resolveRendererTarget()).toBe("app");
    } finally {
      if (prev === undefined) delete process.env.OP_DESKTOP_NEW_UI;
      else process.env.OP_DESKTOP_NEW_UI = prev;
    }
  });
});
