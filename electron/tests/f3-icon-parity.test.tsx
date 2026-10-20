// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React, { type ReactElement } from "react";
import IconTs, { ProviderIcon, ICON_NAMES } from "../src/renderer/components/Icon";

const clientIcon = await import("../../client/src/components/Icon.jsx");
const IconJsx: (props: { name: string; size?: number; className?: string; strokeWidth?: number }) => ReactElement | null =
  clientIcon.default;
const ProviderIconJsx: (props: { provider?: string; size?: number; className?: string }) => ReactElement =
  (clientIcon as { ProviderIcon: typeof ProviderIconJsx }).ProviderIcon;

const BRAND_KEYS = [
  "anthropic", "openai", "gemini", "deepseek", "xai", "mistral", "moonshot", "kimi",
  "minimax", "qwen", "xiaomi", "meta", "cloudflare", "vercel", "huggingface", "nvidia",
  "openrouter", "googlecloud", "azure", "bedrock", "ollama", "alibaba", "opencode",
];

describe("Icon TS 版与 client Icon.jsx 渲染等价", () => {
  it("ICON_NAMES 与旧版逐键一致", () => {
    expect(ICON_NAMES).toEqual(clientIcon.ICON_NAMES);
  });

  it("所有注册名称渲染 markup 逐字节一致", () => {
    expect(ICON_NAMES.length).toBeGreaterThan(0);
    for (const name of ICON_NAMES) {
      const jsx = renderToStaticMarkup(React.createElement(IconJsx, { name }));
      const ts = renderToStaticMarkup(React.createElement(IconTs, { name }));
      expect(ts).toBe(jsx);
    }
  });

  it("自定义 size / className / strokeWidth 渲染等价", () => {
    for (const name of ["doc", "search", "gear"]) {
      const jsx = renderToStaticMarkup(React.createElement(IconJsx, { name, size: 24, className: "x", strokeWidth: 1.5 }));
      const ts = renderToStaticMarkup(React.createElement(IconTs, { name, size: 24, className: "x", strokeWidth: 1.5 }));
      expect(ts).toBe(jsx);
    }
  });

  it("未注册名称返回 null（markup 为空）", () => {
    expect(renderToStaticMarkup(React.createElement(IconTs, { name: "__nope__" }))).toBe("");
    expect(renderToStaticMarkup(React.createElement(IconJsx, { name: "__nope__" }))).toBe("");
    // 空名称同样不告警不渲染
    expect(renderToStaticMarkup(React.createElement(IconTs, { name: "" }))).toBe("");
  });
});

describe("ProviderIcon TS 版与 client Icon.jsx 渲染等价", () => {
  it("品牌图形键 + 占位键渲染 markup 逐字节一致", () => {
    const keys = [...BRAND_KEYS, "zhipu", "commandcode", "custom", "__unknown__", ""];
    for (const provider of keys) {
      const jsx = renderToStaticMarkup(React.createElement(ProviderIconJsx, { provider }));
      const ts = renderToStaticMarkup(React.createElement(ProviderIcon, { provider }));
      expect(ts).toBe(jsx);
    }
  });

  it("缺省参数（custom）与大写输入归一化等价", () => {
    for (const provider of [undefined, "OpenAI", "DEEPSEEK", "Kimi"]) {
      const props = provider === undefined ? {} : { provider };
      const jsx = renderToStaticMarkup(React.createElement(ProviderIconJsx, props));
      const ts = renderToStaticMarkup(React.createElement(ProviderIcon, props));
      expect(ts).toBe(jsx);
    }
  });

  it("自定义 size / className 渲染等价", () => {
    const jsx = renderToStaticMarkup(React.createElement(ProviderIconJsx, { provider: "qwen", size: 28, className: "m" }));
    const ts = renderToStaticMarkup(React.createElement(ProviderIcon, { provider: "qwen", size: 28, className: "m" }));
    expect(ts).toBe(jsx);
  });
});
