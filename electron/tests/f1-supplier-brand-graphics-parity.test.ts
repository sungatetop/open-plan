import { describe, it, expect } from "vitest";
import graphics from "../src/renderer/lib/SupplierBrandGraphics";

// R6-6c 对拍退役改写：旧侧 client/src/components/SupplierBrandGraphics.js import 与
// 键集/逐键互等断言随 client 退役删除（等价性已在 F1 批对拍验收冻结），
// 改为 TS 侧直接锚点断言 + 结构约束断言。

describe("SupplierBrandGraphics 常量表", () => {
  it("键集锚点：23 个供应商 slug，按字典序逐项", () => {
    expect(Object.keys(graphics).sort()).toEqual([
      "alibabacloud", "amazonwebservices", "anthropic", "cloudflare", "deepseek",
      "googlecloud", "googlegemini", "huggingface", "kimi", "meta",
      "microsoftazure", "minimax", "mistralai", "moonshotai", "nvidia",
      "ollama", "openai", "opencode", "openrouter", "qwen",
      "vercel", "x", "xiaomi",
    ]);
    expect(Object.keys(graphics)).toHaveLength(23);
  });

  it("结构约束：所有值均为以 M/m 开头的非空 SVG path 字符串", () => {
    for (const [key, value] of Object.entries(graphics)) {
      expect(typeof value, `slug ${key} 应为字符串`).toBe("string");
      expect(value.length, `slug ${key} 的 path 不应为空`).toBeGreaterThan(0);
      expect(/^[Mm]/.test(value), `slug ${key} 的 path 应以 M/m 开头`).toBe(true);
    }
  });

  it("抽查关键供应商 path 锚点（deepseek / openai / x / vercel）", () => {
    expect(graphics.deepseek).toMatch(/^M23\.748 4\.651/);
    expect(graphics.openai).toMatch(/^M22\.2819 9\.8211/);
    expect(graphics.x).toBe(
      "M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z",
    );
    expect(graphics.vercel).toBe("m12 1.608 12 20.784H0Z");
    expect(graphics.opencode).toBe("M22 24H2V0h20zM17 4.8H7v14.4h10z");
  });
});
