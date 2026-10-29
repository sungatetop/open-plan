/**
 * B2-15 web-reader 域（modern src/main/backend/web-reader.ts）。
 *
 * R6-7a 对拍退役改写：旧侧 server/web-reader.mjs 物理路径动态 import
 * （pathToFileURL）随 server/ 退役删除（等价性已在 B2-15 批对拍验收冻结），仅保留
 * modern 侧同一套绝对断言。
 *
 * 覆盖面（确定性面）：
 *   - htmlToMarkdown：标题抽取/实体解码、script|style|nav|footer 剥离、article/main/div-class
 *     正文回退、h1-h6/pre/li/a 转换、maxChars 截断标记——富文档 spot 断言；
 *   - isBlockedAddress：IPv4/IPv6 拦截表全族（私网/回环/链路本地/云元数据/CGNAT/文档段/
 *     组播/NAT64/6to4/v4-mapped/无法识别输入一律拒绝）；
 *   - resolveRedirectTarget：相对/绝对/协议相对合法目标 + 协议/凭据/主机名拦截分支；
 *   - webFetch 预网络错误路径：非法协议 WEB_FETCH_INVALID_URL、内网字面量/localhost
 *     WEB_FETCH_BLOCKED（安全边界在发起任何请求前拒绝，allowJina 不越界）。
 *
 * 口径：真实网络抓取路径因安全边界拒绝本地回环地址，无法用本地 HTTP 服务器驱动，
 * 不在单元测试面（B2-14 MCP SDK 真连接同款裁剪）。免 stubEnv——本域无模块加载期 env 锚点
 * （OAW_WEBFETCH_JINA 为调用期读取）。
 */
import { describe, expect, it } from "vitest";
import * as modern from "../src/main/backend/web-reader";

const IMPLS = [
  { label: "modern" },
] as const;

const HTML_DOC = `<!DOCTYPE html><html><head><title>规聚 &amp; 桌面端</title><style>body{color:red}</style></head><body><nav>导航条</nav><article><h1>标题一</h1><p>第一段，含 <a href="https://example.com/a">外链</a> 与 <b>加粗</b>。</p><ul><li>项一</li><li>项二</li></ul><pre><code>const x = 1;&amp;2</code></pre><h2>二级标题</h2><p>第二段</p></article><footer>页脚</footer></body></html>`;

/** isBlockedAddress 拦截表（期望值来自安全边界设计，逐项断言）。 */
const BLOCKED_CASES: Array<[string, boolean]> = [
  ["127.0.0.1", true],
  ["10.1.2.3", true],
  ["172.16.0.1", true],
  ["172.31.255.255", true],
  ["172.32.0.1", false],
  ["192.168.1.1", true],
  ["169.254.169.254", true],
  ["100.64.0.1", true],
  ["100.100.100.200", true],
  ["100.128.0.1", false],
  ["8.8.8.8", false],
  ["114.114.114.114", false],
  ["6.6.6.6", false],
  ["0.0.0.0", true],
  ["224.0.0.1", true],
  ["240.0.0.1", true],
  ["198.18.0.5", true],
  ["192.0.0.1", true],
  ["192.0.1.1", false],
  ["192.0.2.1", true],
  ["192.88.99.1", true],
  ["198.51.100.7", true],
  ["203.0.113.9", true],
  ["::", true],
  ["::1", true],
  ["fd00::1", true],
  ["fe80::1", true],
  ["fe80::1%eth0", true],
  ["ff02::1", true],
  ["::ffff:127.0.0.1", true],
  ["::ffff:8.8.8.8", false],
  ["64:ff9b::127.0.0.1", true],
  ["64:ff9b::8.8.8.8", false],
  ["2002:7f00:1::", true],
  ["2002:0800:0100::", false],
  ["2001:db8::1", true],
  ["100::1", true],
  ["2606:4700:4700::1111", false],
  ["2001:4860:4860::8888", false],
  ["not-an-ip", true],
  ["", true],
  ["999.1.1.1", true],
  ["[::1]", true],
];

const REDIRECT_VALID_CASES: Array<[string, string, string]> = [
  ["/b", "https://example.com/a", "https://example.com/b"],
  ["https://other.com/x?q=1", "https://example.com", "https://other.com/x?q=1"],
  ["//cdn.example.com/lib.js", "https://example.com", "https://cdn.example.com/lib.js"],
];

describe.each(IMPLS)("web-reader（$label）", () => {
  const m = () => modern;

  it("htmlToMarkdown：标题抽取/实体解码/剥离与结构转换（富文档 spot 断言）", () => {
    const out = m().htmlToMarkdown(HTML_DOC);
    expect(out.title).toBe("规聚 & 桌面端");
    expect(out.truncated).toBe(false);
    expect(out.markdown).toContain("# 标题一");
    expect(out.markdown).toContain("## 二级标题");
    expect(out.markdown).toContain("[外链](https://example.com/a)");
    expect(out.markdown).toContain("- 项一");
    expect(out.markdown).toContain("- 项二");
    expect(out.markdown).toContain("```\nconst x = 1;&2\n```");
    expect(out.markdown).toContain("第一段，含");
    expect(out.markdown).toContain("加粗");
    expect(out.markdown).not.toContain("导航条");
    expect(out.markdown).not.toContain("页脚");
    expect(out.markdown).not.toContain("body{color:red}");
  });

  it("htmlToMarkdown：maxChars 截断（前缀+截断标记）", () => {
    const html = `<html><body><main><p>${"字".repeat(300)}</p></main></body></html>`;
    const out = m().htmlToMarkdown(html, 50);
    expect(out.truncated).toBe(true);
    expect(out.markdown.startsWith("字".repeat(50))).toBe(true);
    expect(out.markdown.endsWith("\n\n…（内容过长已截断）")).toBe(true);
    const full = m().htmlToMarkdown(html);
    expect(full.truncated).toBe(false);
    expect(full.markdown).toBe("字".repeat(300));
  });

  it("htmlToMarkdown：div-class 正文回退 + 纯标题文档", () => {
    const out = m().htmlToMarkdown('<div class="post-content"><p>段落甲</p></div>');
    expect(out.title).toBe("");
    expect(out.markdown).toBe("段落甲");
    const titleOnly = m().htmlToMarkdown("<title>X</title>");
    expect(titleOnly.title).toBe("X");
    // 剥标签后 title 内文残留于 body
    expect(titleOnly.markdown).toBe("X");
  });

  it("htmlToMarkdown：数字/十六进制实体解码", () => {
    const out = m().htmlToMarkdown("<title>A &lt; B &#39;C&#39; &#x4E2D; &nbsp;D</title>");
    expect(out.title).toBe("A < B 'C' 中 D");
  });

  it("isBlockedAddress：拦截表全族逐项断言", () => {
    for (const [ip, expected] of BLOCKED_CASES) {
      expect(m().isBlockedAddress(ip), ip).toBe(expected);
    }
  });

  it("resolveRedirectTarget：合法目标解析", () => {
    for (const [location, baseUrl, expected] of REDIRECT_VALID_CASES) {
      expect(m().resolveRedirectTarget(location, baseUrl)).toBe(expected);
    }
  });

  it("resolveRedirectTarget：非法分支（协议/凭据/主机名/不可解析）", () => {
    const cases: Array<[string, string, RegExp]> = [
      ["ftp://x.com/", "https://example.com", /仅支持 http\/https 链接/],
      ["https://u:p@x.com/", "https://example.com", /用户名或密码/],
      ["http://localhost:3000/", "https://example.com", /拒绝访问本机\/内网地址/],
      ["http://metadata.google.internal/", "https://example.com", /拒绝访问本机\/内网地址/],
      ["http://127.0.0.1/", "https://example.com", /拒绝访问内网\/保留地址/],
      ["http://", "https://example.com", /重定向地址无法解析/],
    ];
    for (const [location, baseUrl, pattern] of cases) {
      try {
        m().resolveRedirectTarget(location, baseUrl);
        expect.unreachable(`${location} 应被拒绝`);
      } catch (error: any) {
        expect(error.code).toBe("WEB_FETCH_BLOCKED");
        expect(error.message).toMatch(pattern);
      }
    }
  });

  it("webFetch 预网络错误：非法协议/非 URL → WEB_FETCH_INVALID_URL", async () => {
    await expect(m().webFetch("ftp://example.com/x")).rejects.toMatchObject({ code: "WEB_FETCH_INVALID_URL" });
    await expect(m().webFetch("not a url")).rejects.toMatchObject({ code: "WEB_FETCH_INVALID_URL" });
  });

  it("webFetch 安全边界：内网字面量/localhost 在任何请求前拒绝（allowJina 不越界）", async () => {
    await expect(m().webFetch("http://127.0.0.1:9/x")).rejects.toMatchObject({ code: "WEB_FETCH_BLOCKED" });
    await expect(m().webFetch("https://localhost/x")).rejects.toMatchObject({ code: "WEB_FETCH_BLOCKED" });
    await expect(m().webFetch("https://localhost/x", { allowJina: true })).rejects.toMatchObject({ code: "WEB_FETCH_BLOCKED" });
    await expect(m().webFetch("http://127.0.0.1/x")).rejects.toMatchObject({ message: /拒绝访问内网\/保留地址/ });
    await expect(m().webFetch("https://localhost/x")).rejects.toMatchObject({ message: /拒绝访问本机\/内网地址/ });
  });
});

