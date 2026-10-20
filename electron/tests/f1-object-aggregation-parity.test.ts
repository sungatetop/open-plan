import { describe, it, expect } from "vitest";
import { aggregateObjectBar } from "../src/renderer/lib/object-aggregation";

const clientModule = await import("../../client/src/object-aggregation.js");
const client = clientModule as unknown as { 聚合对象栏: typeof aggregateObjectBar };

describe("object-aggregation TS 版与 client 版等价（对拍）", () => {
  it("空入参：全组空、环境默认兜底文案", () => {
    const d = aggregateObjectBar();
    const s = client.聚合对象栏();
    expect(d).toEqual(s);
    expect(d.groups.map((g) => [g.key, g.label, g.icon, g.count, g.items, g.hidden])).toEqual([
      ["artifact", "产出", "package", 0, [], 0],
      ["source", "来源", "link", 0, [], 0],
      ["runtime", "技能与 MCP", "plug", 0, [], 0],
      ["browser", "网页查阅", "globe", 0, [], 0],
      ["memory", "记忆", "book", 0, [], 0],
    ]);
    expect(d.background).toEqual({ key: "background", label: "后台进程", icon: "terminal", count: 0, items: [], hidden: 0 });
    expect(d.environment).toEqual({ workspace: "未指定", model: "默认", runtime: "未知" });
    expect(d.total).toBe(0);
    expect(d.objectCount).toBe(0);
  });

  it("全量数据：五组明细、计数、objectCount 口径逐字段一致", () => {
    const input = {
      artifacts: [
        { path: "docs/方案.docx", diffSummary: { changeType: "added" }, version: 3, acceptanceStatus: "passed" },
        { name: "预算.xlsx", diffSummary: { changeType: "modified" } },
        { artifactId: "art-9", acceptanceStatus: "manual_review" },
        { id: "raw-1" },
        {},
      ],
      references: ["报告.pdf", { label: "引用A", kind: "web" }, { path: "来源B.md" }, { target: "来源C" }, { name: "来源D" }, {}],
      skills: [{ name: "周报生成", category: "office" }, { id: "skill-2" }, {}],
      mcpServers: [{ name: "amap", enabled: true }, { name: "offices", enabled: false }, { id: "mcp-3" }],
      memoryProposals: [
        { content: "用户偏好深色", category: "偏好", status: "approved" },
        { title: "项目别名", status: "pending" },
        { summary: "无分类" },
        { id: "mem-4", status: "unknown_status" },
        {},
      ],
      browser: { active: true, title: "杭州市规划局", url: "https://example.com" },
      scheduler: { agent: { active: 2, queued: 1, limit: 4 }, officecli: { active: 0, queued: 3, limit: 2 } },
      environment: { workspace: "D:\\ws\\甲", model: "deepseek", runtime: "node22" },
    };
    const d = aggregateObjectBar(input);
    const s = client.聚合对象栏(input);
    expect(d).toEqual(s);
    // 绝对锚点
    expect(d.groups[0]!.items[0]!).toEqual({ name: "docs/方案.docx", meta: "新增 · v3 · 已验收" });
    expect(d.groups[0]!.items[1]!).toEqual({ name: "预算.xlsx", meta: "修改" });
    expect(d.groups[0]!.items[2]!).toEqual({ name: "art-9", meta: "待确认" });
    expect(d.groups[0]!.items[4]!).toEqual({ name: "未命名", meta: "产出" });
    expect(d.groups[1]!.items[0]!).toEqual({ name: "报告.pdf", meta: "来源" });
    expect(d.groups[1]!.items[1]!).toEqual({ name: "引用A", meta: "web" });
    expect(d.groups[2]!.count).toBe(6);
    expect(d.groups[2]!.items[0]!).toEqual({ name: "周报生成", meta: "office" });
    expect(d.groups[2]!.items[3]!).toEqual({ name: "amap", meta: "MCP · 已启用" });
    expect(d.groups[2]!.items[4]!).toEqual({ name: "offices", meta: "MCP · 已停用" });
    expect(d.groups[3]!.items).toEqual([{ name: "杭州市规划局", meta: "https://example.com" }]);
    expect(d.groups[4]!.items[0]!).toEqual({ name: "用户偏好深色", meta: "偏好 · 已准入" });
    expect(d.groups[4]!.items[3]!).toEqual({ name: "mem-4", meta: "待准入" });
    expect(d.background.items).toEqual([
      { name: "Agent 调度", meta: "运行 2/4 · 排队 1", status: "running" },
      { name: "Office 调度", meta: "运行 0/2 · 排队 3", status: "queued" },
    ]);
    expect(d.background.count).toBe(2);
    expect(d.total).toBe(5 + 6 + 6 + 1 + 5);
    expect(d.objectCount).toBe(5 + 6 + 5);
  });

  it("截断与上限：超长名 47 字符+省略号；每组 12 条封顶，hidden 记余量", () => {
    const long = "名".repeat(60);
    const fifteen = Array.from({ length: 15 }, (_, i) => `条目-${i}`);
    const input = { references: fifteen, skills: [{ name: long }] };
    const d = aggregateObjectBar(input);
    const s = client.聚合对象栏(input);
    expect(d).toEqual(s);
    const longDetail = d.groups[2]!.items[0]!;
    expect(longDetail.name.length).toBe(48);
    expect(longDetail.name.endsWith("…")).toBe(true);
    expect(longDetail.name).toBe(`${"名".repeat(47)}…`);
    const source = d.groups[1]!;
    expect(source.count).toBe(15);
    expect(source.items).toHaveLength(12);
    expect(source.hidden).toBe(3);
    expect(source.items[11]!).toEqual({ name: "条目-11", meta: "来源" });
  });

  it("缺省与边界：browser 非激活、scheduler 全空闲、字符串数值、undefined 字段兜默认", () => {
    const input = {
      artifacts: undefined,
      references: undefined,
      skills: undefined,
      mcpServers: undefined,
      memoryProposals: undefined,
      browser: { active: false, title: "后台页", url: "" },
      scheduler: { agent: { active: 0, queued: 0, limit: 1 }, officecli: { active: "3", queued: "0", limit: "8" } },
      environment: { workspace: "   ", model: null, runtime: 0 },
    };
    const d = aggregateObjectBar(input);
    const s = client.聚合对象栏(input);
    expect(d).toEqual(s);
    expect(d.groups[3]!.items).toEqual([]);
    expect(d.background.items).toEqual([{ name: "Office 调度", meta: "运行 3/8 · 排队 0", status: "running" }]);
    // runtime: 0 非 nullish → String(0) = "0"，不落兜底
    expect(d.environment).toEqual({ workspace: "未指定", model: "默认", runtime: "0" });
    expect(d.total).toBe(0);
    // browser.url 为空 → meta 兜底文案
    const activeNoUrl = aggregateObjectBar({ browser: { active: true } });
    const activeNoUrlS = client.聚合对象栏({ browser: { active: true } });
    expect(activeNoUrl).toEqual(activeNoUrlS);
    expect(activeNoUrl.groups[3]!.items).toEqual([{ name: "未命名", meta: "内置浏览器" }]);
  });

  it("null 整体入参：JS 解构抛 TypeError，TS 行为一致", () => {
    const attempt = (fn: () => unknown): string => {
      try { fn(); return "no-throw"; } catch (e) { return `threw:${(e as Error).constructor.name}`; }
    };
    expect(attempt(() => aggregateObjectBar(null as any))).toBe(attempt(() => client.聚合对象栏(null as any)));
    expect(attempt(() => aggregateObjectBar(null as any))).toContain("TypeError");
  });
});
