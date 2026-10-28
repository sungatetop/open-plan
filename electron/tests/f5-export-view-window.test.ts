/**
 * R6-3 导出视图离屏窗口：纯逻辑面对拍（export-view-window.ts）。
 *
 * 锚点：
 *   - 旧 buildExportViewUrl（map-direct.ts，随本批删除）：job → /?export=map query
 *     ——project/title 缺省产生 "undefined" 字面（server L5287-5291 同款行为保留）、
 *     layers 逗号拼接；
 *   - 新形态：renderer 导出页 URL（dev = vite devUrl + /app/index.html?qs；打包 =
 *     产物 file:// + ?qs），由 executeExportJob deps.exportViewUrl 注入（index.ts 接线）；
 *   - electron 面（offscreen BrowserWindow 七函数签名对齐 builtin-browser）不在本
 *     文件覆盖（动态 import electron，vitest 不触达；功能验证走 desktop:smoke + 手测）。
 */
import { describe, expect, test } from "vitest";
import { pathToFileURL } from "node:url";
import { buildExportViewPageUrl, buildExportViewQuery } from "../src/main/export-view-window";

describe("buildExportViewQuery（旧 buildExportViewUrl qs 段对拍）", () => {
  test("export=map + project + title 三字段；layers 逗号拼接", () => {
    expect(buildExportViewQuery({ project: "p1", title: "标题" })).toBe("export=map&project=p1&title=%E6%A0%87%E9%A2%98");
    expect(buildExportViewQuery({ project: "p1", title: "标题", layers: ["roads", "landuse"] })).toBe(
      "export=map&project=p1&title=%E6%A0%87%E9%A2%98&layers=roads%2Clanduse"
    );
  });

  test("project/title 缺省 → 'undefined' 字面（server 同款行为，不修）；空 layers 不进 query", () => {
    expect(buildExportViewQuery({})).toBe("export=map&project=undefined&title=undefined");
    expect(buildExportViewQuery({ project: "p1", title: "t", layers: [] })).toBe("export=map&project=p1&title=t");
  });
});

describe("buildExportViewPageUrl（dev / 打包双形态）", () => {
  const APP_INDEX = "D:\\app\\out\\renderer\\app\\index.html";

  test("dev：devUrl + /app/index.html?qs（对齐 loadAppPage 的 dev 路径）", () => {
    expect(
      buildExportViewPageUrl({ project: "p1", title: "导出" }, { devUrl: "http://localhost:5173", appIndex: APP_INDEX })
    ).toBe(`http://localhost:5173/app/index.html?export=map&project=p1&title=%E5%AF%BC%E5%87%BA`);
  });

  test("打包：产物 file:// URL + ?qs（location.search 可读，query 不丢）", () => {
    const url = buildExportViewPageUrl({ project: "p1", title: "t" }, { appIndex: APP_INDEX });
    expect(url).toBe(`${pathToFileURL(APP_INDEX).href}?export=map&project=p1&title=t`);
    expect(url.startsWith("file:///D:/app/out/renderer/app/index.html?")).toBe(true);
  });

  test("dev 缺省（空串视为未设置）→ file:// 形态", () => {
    const url = buildExportViewPageUrl({ project: "p1", title: "t" }, { devUrl: "", appIndex: APP_INDEX });
    expect(url.startsWith("file:///")).toBe(true);
  });
});
