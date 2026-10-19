/**
 * 本轮对象栏聚合（Qoder 对标 P1-8 / 对标报告 §3.3⑤）。
 *
 * 纯函数：把各数据源归一为「产出 / 来源 / 技能与 MCP / 网页查阅 / 记忆」五组
 * （分组命名对齐 Qoder 的 artifact / source / runtime / browser / memory），
 * 外加「环境信息」与独立的「后台进程」组，供右栏统一呈现与计数。
 *
 * 设计约束：
 *   - 不做任何网络请求、不读全局状态、无副作用 —— 因此可在 Node 里直接断言；
 *   - 输入缺失一律按空处理，不让单个数据源缺失导致整栏渲染失败；
 *   - 每组只回传前 N 条明细 + 余量（hidden），避免长列表把面板撑爆。
 */

/** 每组最多回传的明细条数。 */
const 每组明细上限 = 12;

/** 明细名过长时截断，避免把面板横向撑破。 */
const 名称上限 = 48;

/** 五个业务分组的固定定义（顺序即展示顺序）。 */
const 分组定义 = [
  { key: "artifact", label: "产出", icon: "package" },
  { key: "source", label: "来源", icon: "link" },
  { key: "runtime", label: "技能与 MCP", icon: "plug" },
  { key: "browser", label: "网页查阅", icon: "globe" },
  { key: "memory", label: "记忆", icon: "book" },
];

/** 产出记录的英文枚举转中文，避免右栏出现裸英文。 */
const 变更词 = { added: "新增", modified: "修改", deleted: "删除", renamed: "重命名" };
const 验收词 = { passed: "已验收", manual_review: "待确认", failed: "未通过" };
const 记忆状态词 = { pending: "待准入", approved: "已准入", rejected: "已拒绝", archived: "已归档" };

const 带落 = (map, value, fallback = "") => map[String(value || "")] || fallback;

function 文本(value, fallback = "") {
  const text = value === undefined || value === null ? "" : String(value).trim();
  return text || fallback;
}

function 截断(value, limit = 名称上限) {
  const text = 文本(value);
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function 数组(value) {
  return Array.isArray(value) ? value : [];
}

function 明细(name, meta, extra = {}) {
  return { name: 截断(name) || "未命名", meta: 文本(meta), ...extra };
}

function 成组(定义, 全部) {
  return {
    key: 定义.key,
    label: 定义.label,
    icon: 定义.icon,
    count: 全部.length,
    items: 全部.slice(0, 每组明细上限),
    hidden: Math.max(0, 全部.length - 每组明细上限),
  };
}

/**
 * @param {object} input
 * @param {Array} [input.artifacts]       产出（GET /api/artifacts 的 artifacts）
 * @param {Array} [input.references]      来源（{ label, kind } 归一后的引用/打开项）
 * @param {Array} [input.skills]          技能（GET /api/skills 的 skills）
 * @param {Array} [input.mcpServers]      MCP 服务（GET /api/integrations/mcp/servers 的 servers）
 * @param {Array} [input.memoryProposals] 记忆建议（GET /api/memory/proposals 的 proposals）
 * @param {object} [input.browser]        内置浏览器状态（GET /api/browser/state 的 state）
 * @param {object} [input.scheduler]      服务端调度器快照（{ agent, officecli }，各含 active/queued/limit）
 * @param {object} [input.environment]    环境信息（{ workspace, model, runtime }）
 * @returns {{groups:Array, background:object, environment:object, total:number, objectCount:number}}
 */
export function 聚合对象栏({
  artifacts = [],
  references = [],
  skills = [],
  mcpServers = [],
  memoryProposals = [],
  browser = null,
  scheduler = null,
  environment = {},
} = {}) {
  const 产出 = 数组(artifacts).map((item) => 明细(
    item?.path || item?.name || item?.artifactId || item?.id,
    [
      带落(变更词, item?.diffSummary?.changeType),
      item?.version ? `v${item.version}` : "",
      带落(验收词, item?.acceptanceStatus),
    ].filter(Boolean).join(" · ") || "产出",
  ));

  const 来源 = 数组(references).map((item) => (typeof item === "string"
    ? 明细(item, "来源")
    : 明细(item?.label || item?.path || item?.target || item?.name, item?.kind || "来源")));

  const 技能 = 数组(skills).map((item) => 明细(item?.name || item?.id, item?.category || "技能"));
  const MCP = 数组(mcpServers).map((item) => 明细(
    item?.name || item?.id,
    `MCP · ${item?.enabled === false ? "已停用" : "已启用"}`,
  ));

  const 网页 = browser && browser.active
    ? [明细(browser.title || browser.url, 文本(browser.url, "内置浏览器"))]
    : [];

  const 记忆 = 数组(memoryProposals).map((item) => 明细(
    item?.content || item?.title || item?.summary || item?.id,
    [item?.category, 带落(记忆状态词, item?.status, "待准入")].filter(Boolean).join(" · "),
  ));

  // 后台进程：只列真正在跑/排队的调度器，全空闲时不占位。
  const 后台 = ["agent", "officecli"]
    .map((key) => ({ key, slot: scheduler?.[key] }))
    .filter(({ slot }) => Number(slot?.active) > 0 || Number(slot?.queued) > 0)
    .map(({ key, slot }) => 明细(
      key === "agent" ? "Agent 调度" : "Office 调度",
      `运行 ${Number(slot?.active) || 0}/${Number(slot?.limit) || 0} · 排队 ${Number(slot?.queued) || 0}`,
      { status: Number(slot?.active) > 0 ? "running" : "queued" },
    ));

  const groups = [
    成组(分组定义[0], 产出),
    成组(分组定义[1], 来源),
    成组(分组定义[2], [...技能, ...MCP]),
    成组(分组定义[3], 网页),
    成组(分组定义[4], 记忆),
  ];

  return {
    groups,
    background: { ...成组({ key: "background", label: "后台进程", icon: "terminal" }, 后台), count: 后台.length },
    environment: {
      workspace: 文本(environment?.workspace, "未指定"),
      model: 文本(environment?.model, "默认"),
      runtime: 文本(environment?.runtime, "未知"),
    },
    total: groups.reduce((sum, group) => sum + group.count, 0),
    // 对齐对标报告 §3.3① 的 +N 口径：本轮新增的「产出 / 来源 / 记忆」条目数。
    objectCount: 产出.length + 来源.length + 记忆.length,
  };
}
