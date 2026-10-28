/**
 * R6-2 资产自持：oaw-data:// 自定义协议对拍（oaw-data-protocol.ts）。
 *
 * 锚点：
 *   - 旧 sidecar 静态服务面：server/index.mjs L611 express.static(map.STATIC_ROOT)
 *     （/api/map/data/* → WORKSPACE_DIR/maps）+ L5740 express.static(client/dist)
 *     （/glyphs/* → client/public/glyphs，R6-2 起迁移 electron/resources/glyphs）；
 *   - 桌面形态：单 scheme 双 host（maps = WORKSPACE_DIR/maps，glyphs = app 根
 *     resources/glyphs），MapLibre 引擎 fetch 资产面（业务通道之外）等价替换；
 *   - 调用方可感知语义：未命中/穿越 → 404（express.static 未命中 → next() → 404 等价）；
 *     mime 对齐 mime-db（.geojson → application/geo+json、.pbf → application/x-protobuf）。
 *
 * 本文件为纯逻辑测试：只测 resolveOawDataFile（electron 依赖收敛在安装函数内动态
 * import，vitest 不触达）+ app/index.html CSP 放行断言（oaw-data 资产面的策略锚点）。
 */
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OAW_DATA_SCHEME, resolveOawDataFile, type OawDataRoots } from "../src/main/oaw-data-protocol";

const ROOTS: OawDataRoots = { maps: "W:\\ws\\maps", glyphs: "D:\\app\\resources\\glyphs" };

describe("oaw-data host 分发", () => {
  test("maps host → maps 根；glyphs host → glyphs 根", () => {
    expect(resolveOawDataFile("oaw-data://maps/demo/tiles/roads/{z}/{x}/{y}.pbf", ROOTS)?.filePath).toBe(
      join("W:\\ws\\maps", "demo", "tiles", "roads", "{z}", "{x}", "{y}.pbf")
    );
    expect(resolveOawDataFile("oaw-data://glyphs/Noto Sans Regular/0-255.pbf", ROOTS)?.filePath).toBe(
      join("D:\\app\\resources\\glyphs", "Noto Sans Regular", "0-255.pbf")
    );
  });

  test("未知 host → null（404 面）", () => {
    expect(resolveOawDataFile("oaw-data://other/demo/t.json", ROOTS)).toBeNull();
  });
});

describe("oaw-data 路径解析与穿越守卫", () => {
  test("URL 百分号编码解码（{z}/{x}/{y} 与空格）", () => {
    const r = resolveOawDataFile("oaw-data://maps/demo/tiles/a/%7Bz%7D/%7Bx%7D/%7By%7D.pbf", ROOTS);
    expect(r?.filePath).toContain("{z}");
    const s = resolveOawDataFile("oaw-data://glyphs/Noto%20Sans%20Regular/0-255.pbf", ROOTS);
    expect(s?.filePath).toContain("Noto Sans Regular");
  });

  test("字面 ../ 与 %2e%2e 均被 URL 构造器规范化（WHATWG dot-segment 口径），路径落根内不逃逸", () => {
    for (const u of [
      "oaw-data://maps/../escape.json",
      "oaw-data://maps/%2e%2e/escape.json",
      "oaw-data://maps/demo/%2e%2e/%2e%2e/escape.json"
    ]) {
      const r = resolveOawDataFile(u, ROOTS);
      expect(r === null || !r.filePath.startsWith("..")).toBe(true);
      if (r) expect(r.filePath.startsWith("W:\\ws\\maps")).toBe(true);
    }
  });

  test("编码穿越形态被守卫拦截 → null：%5C 反斜杠注入 / %2f 分隔注入", () => {
    // URL 规范化只识别整段 dot-segment，段内编码分隔符（%5C/%2f）原样保留到守卫层
    expect(resolveOawDataFile("oaw-data://maps/..%5C..%5Cescape.json", ROOTS)).toBeNull();
    expect(resolveOawDataFile("oaw-data://maps/x%2f..%2f..%2fescape.json", ROOTS)).toBeNull();
  });

  test("根自身路径放行（目录探测由读文件 404 兜底，不在此拒）", () => {
    expect(resolveOawDataFile("oaw-data://maps/", ROOTS)?.filePath).toBe("W:\\ws\\maps");
  });
});

describe("oaw-data mime 映射（对齐旧侧 mime-db 调用方语义）", () => {
  test(".geojson → application/geo+json；.pbf → application/x-protobuf；.json → application/json", () => {
    expect(resolveOawDataFile("oaw-data://maps/demo/layers/a.geojson", ROOTS)?.mime).toBe("application/geo+json");
    expect(resolveOawDataFile("oaw-data://maps/demo/tiles/a/0/0/0.pbf", ROOTS)?.mime).toBe("application/x-protobuf");
    expect(resolveOawDataFile("oaw-data://maps/demo/style.json", ROOTS)?.mime).toBe("application/json");
  });

  test("未知扩展 → application/octet-stream", () => {
    expect(resolveOawDataFile("oaw-data://maps/demo/blob.xyz", ROOTS)?.mime).toBe("application/octet-stream");
  });
});

describe("scheme 常量与 CSP 放行锚点", () => {
  test("scheme 名为 oaw-data；app/index.html connect-src 放行 oaw-data:（MapLibre fetch 资产面）", () => {
    expect(OAW_DATA_SCHEME).toBe("oaw-data");
    const html = readFileSync(join(__dirname, "..", "src", "renderer", "app", "index.html"), "utf8");
    const csp = html.match(/Content-Security-Policy"\s+content="([^"]+)"/)?.[1] ?? "";
    expect(csp).toContain("worker-src blob:");
    expect(csp).toContain("connect-src 'self' oaw-data:");
    expect(csp).toContain("frame-src blob:");
    expect(csp).toContain("img-src 'self' data: blob: https:");
  });
});
