import { describe, it, expect } from "vitest";
import {
  normalizeArtifactPath,
  artifactName,
  artifactExt,
  artifactTypeInfo,
  artifactTypeLabel,
  formatFileSize,
  buildArtifactIndex,
  resolveArtifactTarget,
  normalizeLocalFileHref,
} from "../src/renderer/lib/artifact-types";

const clientModule = await import("../../client/src/artifact-types.js");
const client = clientModule as unknown as {
  normalizeArtifactPath: typeof normalizeArtifactPath;
  artifactName: typeof artifactName;
  artifactExt: typeof artifactExt;
  artifactTypeInfo: typeof artifactTypeInfo;
  artifactTypeLabel: typeof artifactTypeLabel;
  formatFileSize: typeof formatFileSize;
  buildArtifactIndex: typeof buildArtifactIndex;
  resolveArtifactTarget: typeof resolveArtifactTarget;
  normalizeLocalFileHref: typeof normalizeLocalFileHref;
};

describe("artifact-types TS 版与 client 版等价（对拍）", () => {
  it("normalizeArtifactPath / artifactName / artifactExt 全对拍（含空值与边界）", () => {
    const cases = [
      null, undefined, "", "   ", "a\\b\\c.md", "./a/b.md", "/abs/path.png", ".//x///y.txt",
      "folder/", "..\\..\\up.json", "name", "name.", ".gitignore", "archive.tar.gz", 123, {},
    ];
    for (const c of cases) {
      expect(normalizeArtifactPath(c)).toBe(client.normalizeArtifactPath(c));
      expect(artifactName(c)).toBe(client.artifactName(c));
      expect(artifactExt(c)).toBe(client.artifactExt(c));
    }
  });

  it("artifactTypeInfo / artifactTypeLabel：已知扩展、未知扩展、无扩展全对拍", () => {
    const cases = ["报告.docx", "a.MD", "x.geojson", "no-ext", ".gitignore", "b.PDF", "unknown.zzz", ""];
    for (const c of cases) {
      expect(artifactTypeInfo(c)).toEqual(client.artifactTypeInfo(c));
      expect(artifactTypeLabel(c)).toBe(client.artifactTypeLabel(c));
    }
    // 绝对锚点：几类代表类型
    expect(artifactTypeInfo("a.xlsx")).toEqual({ icon: "xls", label: "表格", ext: "xlsx" });
    expect(artifactTypeInfo("a.geojson")).toEqual({ icon: "map", label: "地图数据", ext: "geojson" });
    expect(artifactTypeInfo("a.zzz")).toEqual({ icon: "file", label: "文件", ext: "zzz" });
    expect(artifactTypeLabel("a.xlsx")).toBe("表格 · XLSX");
    expect(artifactTypeLabel("no-ext")).toBe("文件");
  });

  it("formatFileSize：非法值返回空串，B/KB/MB 三档与去尾零行为一致", () => {
    const cases = [null, undefined, NaN, -1, -0.5, Infinity, "abc", 0, 512, 1023.9, 1024, 590848, 1048575, 1048576, 1258291.2, 10485760, 3e9];
    for (const c of cases) {
      expect(formatFileSize(c)).toBe(client.formatFileSize(c));
    }
    expect(formatFileSize(590848)).toBe("577 KB");
    expect(formatFileSize(1024)).toBe("1 KB");
    expect(formatFileSize(1258291.2)).toBe("1.2 MB");
  });

  it("buildArtifactIndex：去重交付优先、size/confirmed/attributed 合并、byName 两种键、列表字段补全", () => {
    const entries = [
      { path: "docs/方案.md", size: 2048, deliverable: true, confirmed: true },
      { path: "./docs/方案.md", size: 999 },
      { relativePath: "img\\图标.png", size: 577 * 1024 },
      { path: "sub/同名.txt", name: "同名" },
      { path: "other/同名.txt" },
      { path: "", size: 1 },
      null,
      { path: "no-attrib.md", attributed: false },
    ];
    const d = buildArtifactIndex(entries as any);
    const s = client.buildArtifactIndex(JSON.parse(JSON.stringify(entries)) as any);
    expect(JSON.parse(JSON.stringify(d.list))).toEqual(s.list);
    expect(d.byName.size).toBe(s.byName.size);
    for (const [key, item] of s.byName) {
      expect(JSON.parse(JSON.stringify(d.byName.get(key)))).toEqual(item);
    }
    // 绝对锚点：同路径交付优先合并 deliverable/confirmed（OR），但 size 为后写覆盖（?? 链）
    expect(d.list).toHaveLength(5);
    const plan = d.byName.get("docs/方案.md")!;
    expect(plan).toMatchObject({ deliverable: true, confirmed: true, size: 999, icon: "md", label: "Markdown", typeLabel: "Markdown · MD", sizeText: "999 B" });
    expect(d.byName.get("同名")).toBe(d.byName.get("sub/同名.txt"));
    expect(d.byName.get("no-attrib.md")!.attributed).toBe(false);
    // 非法输入：非数组/空数组 → 空索引
    for (const bad of [null, undefined, "str", 123, {}]) {
      const emptyD = buildArtifactIndex(bad as any);
      const emptyS = client.buildArtifactIndex(bad as any);
      expect(emptyD.list).toEqual([]);
      expect(emptyD.byName.size).toBe(0);
      expect(emptyD.list).toEqual(emptyS.list);
    }
  });

  it("resolveArtifactTarget：相对路径/./前缀/反斜杠/file://+编码/盘符/纯文件名/外部协议 全对拍", () => {
    const entries = [
      { path: "docs/方案.md", deliverable: true },
      { path: "地图数据/路网.geojson", size: 12 },
      { path: "output/城 市带 空格.png" },
    ];
    const dIdx = buildArtifactIndex(entries);
    const sIdx = client.buildArtifactIndex(JSON.parse(JSON.stringify(entries)));
    const targets = [
      "docs/方案.md", "./docs/方案.md", "docs\\方案.md", "DOCS/方案.md",
      "file:///D:/workspace/地图数据/路网.geojson",
      "file:///D:/workspace/%E5%9C%B0%E5%9B%BE%E6%95%B0%E6%8D%AE/%E8%B7%AF%E7%BD%91.geojson",
      "output/%E5%9F%8E%20%E5%B8%82.png",
      "路网.geojson",
      "https://example.com/a.md", "mailto:a@b.c", "javascript:void(0)",
      "D:\\workspace\\docs\\方案.md",
      "", "   ", null, undefined,
      "不存在.md",
    ];
    for (const t of targets) {
      const d = resolveArtifactTarget(t as any, dIdx);
      const s = client.resolveArtifactTarget(t as any, sIdx);
      expect(d === null ? null : JSON.parse(JSON.stringify(d))).toEqual(s === null ? null : JSON.parse(JSON.stringify(s)));
    }
    expect(resolveArtifactTarget("docs/方案.md", dIdx)!.deliverable).toBe(true);
    expect(resolveArtifactTarget("https://example.com/a.md", dIdx)).toBeNull();
    // index 为空/null → null
    expect(resolveArtifactTarget("docs/方案.md", null)).toBeNull();
    expect(resolveArtifactTarget("docs/方案.md", undefined)).toBeNull();
    expect(resolveArtifactTarget(null, dIdx)).toBeNull();
  });

  it("normalizeLocalFileHref：锚点/外部协议/查询串/file:///未知扩展/白名单扩展 全对拍", () => {
    const cases = [
      "#锚点", "", "   ", null, undefined,
      "docs/方案.md", "docs/方案.md?x=1#frag", "img\\图标.PNG",
      "https://example.com/a.docx", "mailto:a@b.c",
      "file:///D:/ws/报告.docx", "file:///D:/ws/%E6%8A%A5%E5%91%8A.docx",
      "data/output.dbf", "logs/run.log", "config/settings.yml",
      "noext", "unknown.zzz", "a.shp#",
    ];
    for (const c of cases) {
      expect(normalizeLocalFileHref(c)).toBe(client.normalizeLocalFileHref(c));
    }
    expect(normalizeLocalFileHref("docs/方案.md?x=1#frag")).toBe("docs/方案.md");
    expect(normalizeLocalFileHref("https://example.com/a.docx")).toBe("");
  });
});
