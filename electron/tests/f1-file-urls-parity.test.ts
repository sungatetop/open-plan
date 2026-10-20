import { describe, it, expect } from "vitest";
import {
  PREVIEW_STATE,
  PREVIEW_STATE_LABEL,
  normalizeRelativePath,
  makeFileIdentity,
  fileIdentityKey,
  identityMatches,
  mergeFileIdentity,
  readIdentityHeader,
  buildDocUrls,
  withRevision,
  looksUnsupported,
  previewStateFromError,
} from "../src/renderer/lib/file-urls";

const clientModule = await import("../../client/src/file-urls.js");
const client = clientModule as unknown as {
  PREVIEW_STATE: typeof PREVIEW_STATE;
  PREVIEW_STATE_LABEL: typeof PREVIEW_STATE_LABEL;
  normalizeRelativePath: typeof normalizeRelativePath;
  makeFileIdentity: typeof makeFileIdentity;
  fileIdentityKey: typeof fileIdentityKey;
  identityMatches: typeof identityMatches;
  mergeFileIdentity: typeof mergeFileIdentity;
  readIdentityHeader: typeof readIdentityHeader;
  buildDocUrls: typeof buildDocUrls;
  withRevision: typeof withRevision;
  looksUnsupported: typeof looksUnsupported;
  previewStateFromError: typeof previewStateFromError;
};

describe("file-urls TS 版与 client 版等价（对拍）", () => {
  it("常量表一致", () => {
    expect(PREVIEW_STATE).toEqual(client.PREVIEW_STATE);
    expect(PREVIEW_STATE_LABEL).toEqual(client.PREVIEW_STATE_LABEL);
  });

  it("normalizeRelativePath：反斜杠/前导 ./ 与 // 全对拍", () => {
    const cases = [null, undefined, "", "a\\b.md", "./a/b.md", "/abs/x", ".//x//y", "plain.md", 123];
    for (const c of cases) expect(normalizeRelativePath(c)).toBe(client.normalizeRelativePath(c));
  });

  it("makeFileIdentity：relativePath←name 回退、workspaceId←cwd 回退、revision null 归空、0/false 字符串化", () => {
    const cases = [
      undefined, {},
      { relativePath: "a\\b.md" },
      { name: "只传名字.md" },
      { cwd: "D:\\ws\\甲" },
      { workspaceId: "D:\\ws\\甲", cwd: "D:\\ws\\乙" },
      { relativePath: "a.md", revision: "r1" },
      { relativePath: "a.md", revision: null },
      { relativePath: "a.md", revision: 0 },
      { relativePath: "a.md", revision: false },
      { relativePath: 42, workspaceId: 7 },
    ];
    for (const c of cases) {
      expect(makeFileIdentity(c as any)).toEqual(client.makeFileIdentity(c as any));
    }
    // null：默认参数不兜 null，JS 直接抛 TypeError；TS 行为一致
    const attempt = (fn: () => unknown): string => {
      try { return JSON.stringify(fn()); } catch (e) { return `threw:${(e as Error).constructor.name}`; }
    };
    expect(attempt(() => makeFileIdentity(null))).toBe(attempt(() => client.makeFileIdentity(null)));
    expect(attempt(() => makeFileIdentity(null))).toContain("TypeError");
  });

  it("fileIdentityKey / identityMatches：空值、大小写与分隔符归一", () => {
    const a = { workspaceId: "D:\\WS\\甲", relativePath: "Sub\\A.MD" };
    const b = { cwd: "d:/ws/甲", relativePath: "./sub/a.md" };
    const c = { cwd: "d:/ws/乙", relativePath: "sub/a.md" };
    expect(fileIdentityKey(null)).toBe("");
    expect(fileIdentityKey(a)).toBe(client.fileIdentityKey(a));
    expect(identityMatches(a, b)).toBe(true);
    expect(identityMatches(a, c)).toBe(false);
    expect(identityMatches(null, b)).toBe(false);
    expect(identityMatches(a, null)).toBe(false);
    expect(identityMatches(a, b)).toBe(client.identityMatches(a, b));
  });

  it("mergeFileIdentity：server 缺失回 local；逐字段 server 优先、revision null 保留 local", () => {
    const local = { workspaceId: "ws-local", cwd: "cwd-local", relativePath: "本地.md", revision: "v1" };
    const server = { workspaceId: "ws-server", cwd: "", relativePath: "", revision: "v2" };
    expect(mergeFileIdentity(local, null)).toEqual(client.mergeFileIdentity(local, null));
    expect(mergeFileIdentity(null, server)).toEqual(client.mergeFileIdentity(null, server));
    expect(mergeFileIdentity(local, server)).toEqual(client.mergeFileIdentity(local, server));
    const merged = mergeFileIdentity(local, server);
    expect(merged).toEqual({ workspaceId: "ws-server", cwd: "cwd-local", relativePath: "本地.md", revision: "v2" });
    const keepRev = mergeFileIdentity(local, { workspaceId: "s2", revision: null });
    expect(keepRev.revision).toBe("v1");
    expect(keepRev).toEqual(client.mergeFileIdentity(local, { workspaceId: "s2", revision: null }));
  });

  it("readIdentityHeader：正常/缺失/坏 JSON/无 get 方法 全对拍", () => {
    const payload = { workspaceId: "ws", relativePath: "a.md", revision: "r9" };
    const ok = { headers: new Headers({ "x-oa-file-identity": encodeURIComponent(JSON.stringify(payload)) }) };
    expect(readIdentityHeader(ok)).toEqual(payload);
    expect(readIdentityHeader(ok)).toEqual(client.readIdentityHeader(ok));
    for (const bad of [
      null, undefined, {},
      { headers: null },
      { headers: new Headers() },
      { headers: { get: () => encodeURIComponent("{bad json") } },
      { headers: { get: "not-a-function" } },
    ]) {
      expect(readIdentityHeader(bad as any)).toBeNull();
      expect(readIdentityHeader(bad as any)).toEqual(client.readIdentityHeader(bad as any));
    }
  });

  it("buildDocUrls：完整地址形状（cwd+wsid+v）、无 workspaceId 回退 cwd、无 revision 无 v、路径编码", () => {
    const full = { workspaceId: "D:\\ws 甲", cwd: "D:\\ws 甲", relativePath: "docs/方案 a.md", revision: "rev 1" };
    const dFull = buildDocUrls(full);
    const sFull = client.buildDocUrls(full);
    expect(dFull).toEqual(sFull);
    expect(dFull.raw).toBe(`/api/doc/docs%2F%E6%96%B9%E6%A1%88%20a.md/raw?cwd=D%3A%5Cws+%E7%94%B2&wsid=D%3A%5Cws+%E7%94%B2&v=rev+1`);
    expect(dFull.open).toContain("/api/doc/docs%2F%E6%96%B9%E6%A1%88%20a.md?");
    for (const key of ["text", "html", "comments", "annotations", "outline", "watch", "watchStop", "rawSave"] as const) {
      expect(dFull[key]).toBe(sFull[key]);
    }
    // 无 workspaceId → 回退 cwd；无 revision → 无 v 参数
    const minimal = buildDocUrls({ cwd: "C:\\ws" });
    expect(minimal.identity).toEqual({ workspaceId: "C:\\ws", cwd: "C:\\ws", relativePath: "", revision: "" });
    expect(minimal.raw).toBe("/api/doc//raw?cwd=C%3A%5Cws&wsid=C%3A%5Cws");
    expect(minimal.raw).toBe(client.buildDocUrls({ cwd: "C:\\ws" }).raw);
    // null → makeFileIdentity({}) 全空
    const empty = buildDocUrls(null);
    expect(empty).toEqual(client.buildDocUrls(null));
    expect(empty.raw).toBe("/api/doc//raw");
  });

  it("withRevision：空 url 原样返回、空 revision 原样、无 ? 追加、已有 v 覆盖且保留其他参数", () => {
    const cases: Array<[unknown, unknown]> = [
      ["", "r1"], [null, "r1"], [undefined, "r1"],
      ["/api/doc/a.md/raw", ""], ["/api/doc/a.md/raw", null],
      ["/api/doc/a.md/raw", "r1"],
      ["/api/doc/a.md/raw?cwd=ws", "r1"],
      ["/api/doc/a.md/raw?cwd=ws&v=old&x=1", "r2"],
    ];
    for (const [u, r] of cases) {
      expect(withRevision(u, r)).toBe(client.withRevision(u, r));
    }
    expect(withRevision("/api/doc/a.md/raw", "r1")).toBe("/api/doc/a.md/raw?v=r1");
    expect(withRevision("/api/doc/a.md/raw?cwd=ws&v=old&x=1", "r2")).toBe("/api/doc/a.md/raw?cwd=ws&v=r2&x=1");
  });

  it("looksUnsupported / previewStateFromError：各类文案与错误对象全对拍", () => {
    const cases: Array<unknown> = [
      null, undefined, "", "普通错误", "该格式不支持预览", "无法预览此文档",
      "unsupported format", "Not Supported!", "报告.doc", "说明.wps", "a.docx", "a.docX",
      { message: "该格式不支持预览" }, { message: "boom" }, {}, 42,
    ];
    for (const c of cases) {
      expect(looksUnsupported(c)).toBe(client.looksUnsupported(c));
      expect(previewStateFromError(c)).toBe(client.previewStateFromError(c));
    }
    expect(previewStateFromError("该格式不支持预览")).toBe(PREVIEW_STATE.UNSUPPORTED);
    expect(previewStateFromError(new Error("boom"))).toBe(PREVIEW_STATE.FAILED);
  });
});
