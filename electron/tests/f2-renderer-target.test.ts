import { describe, it, expect } from "vitest";
import { resolveRendererTarget } from "../src/main/util/renderer-target";

describe("resolveRendererTarget（R6-1 门控退役，恒 app）", () => {
  it("新 UI 应用页为唯一形态，任何环境（含历史 OP_DESKTOP_NEW_UI 取值）一律 app", () => {
    expect(resolveRendererTarget()).toBe("app");
    expect(resolveRendererTarget()).not.toBe("legacy-client");
  });
});
