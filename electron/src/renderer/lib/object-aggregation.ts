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
 *
 * 与 client/src/object-aggregation.js 逐函数等价（tests/f1-object-aggregation-parity.test.ts 对拍强制）。
 * 注：JS 版导出名为 聚合对象栏，本 TS 版按命名规范改用英文名 aggregateObjectBar。
 */

/** 每组最多回传的明细条数。 */
const GROUP_ITEM_LIMIT = 12;

/** 明细名过长时截断，避免把面板横向撑破。 */
const NAME_LIMIT = 48;

/** 五个业务分组的固定定义（顺序即展示顺序）。 */
const GROUP_DEFS = [
  { key: "artifact", label: "产出", icon: "package" },
  { key: "source", label: "来源", icon: "link" },
  { key: "runtime", label: "技能与 MCP", icon: "plug" },
  { key: "browser", label: "网页查阅", icon: "globe" },
  { key: "memory", label: "记忆", icon: "book" },
] as const;

/** 产出记录的英文枚举转中文，避免右栏出现裸英文。 */
const CHANGE_WORDS: Record<string, string> = { added: "新增", modified: "修改", deleted: "删除", renamed: "重命名" };
const ACCEPTANCE_WORDS: Record<string, string> = { passed: "已验收", manual_review: "待确认", failed: "未通过" };
const MEMORY_STATUS_WORDS: Record<string, string> = { pending: "待准入", approved: "已准入", rejected: "已拒绝", archived: "已归档" };

const pickWord = (map: Record<string, string>, value: unknown, fallback = ""): string =>
  map[String(value || "")] || fallback;

function textOf(value: unknown, fallback = ""): string {
  const text = value === undefined || value === null ? "" : String(value).trim();
  return text || fallback;
}

function truncateName(value: unknown, limit = NAME_LIMIT): string {
  const text = textOf(value);
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

interface Detail {
  name: string;
  meta: string;
  [key: string]: unknown;
}

function makeDetail(name: unknown, meta: unknown, extra: Record<string, unknown> = {}): Detail {
  return { name: truncateName(name) || "未命名", meta: textOf(meta), ...extra };
}

interface ItemGroup {
  key: string;
  label: string;
  icon: string;
  count: number;
  items: Detail[];
  hidden: number;
}

function makeGroup(def: { key: string; label: string; icon: string }, all: Detail[]): ItemGroup {
  return {
    key: def.key,
    label: def.label,
    icon: def.icon,
    count: all.length,
    items: all.slice(0, GROUP_ITEM_LIMIT),
    hidden: Math.max(0, all.length - GROUP_ITEM_LIMIT),
  };
}

export interface ObjectBarInput {
  artifacts?: unknown;
  references?: unknown;
  skills?: unknown;
  mcpServers?: unknown;
  memoryProposals?: unknown;
  browser?: unknown;
  scheduler?: unknown;
  environment?: unknown;
}

export interface ObjectBarResult {
  groups: ItemGroup[];
  background: ItemGroup;
  environment: { workspace: string; model: string; runtime: string };
  total: number;
  objectCount: number;
}

/**
 * 把各数据源归一为右栏对象栏的分组视图。入参缺省逐字段兜空。
 */
export function aggregateObjectBar({
  artifacts = [],
  references = [],
  skills = [],
  mcpServers = [],
  memoryProposals = [],
  browser = null,
  scheduler = null,
  environment = {},
}: ObjectBarInput = {}): ObjectBarResult {
  const artifactDetails = asArray(artifacts).map((item): Detail => makeDetail(
    item?.path || item?.name || item?.artifactId || item?.id,
    [
      pickWord(CHANGE_WORDS, item?.diffSummary?.changeType),
      item?.version ? `v${item.version}` : "",
      pickWord(ACCEPTANCE_WORDS, item?.acceptanceStatus),
    ].filter(Boolean).join(" · ") || "产出",
  ));

  const referenceDetails = asArray(references).map((item): Detail => (typeof item === "string"
    ? makeDetail(item, "来源")
    : makeDetail(item?.label || item?.path || item?.target || item?.name, item?.kind || "来源")));

  const skillDetails = asArray(skills).map((item): Detail => makeDetail(item?.name || item?.id, item?.category || "技能"));
  const mcpDetails = asArray(mcpServers).map((item): Detail => makeDetail(
    item?.name || item?.id,
    `MCP · ${item?.enabled === false ? "已停用" : "已启用"}`,
  ));

  const webDetails = browser && (browser as any).active
    ? [makeDetail((browser as any).title || (browser as any).url, textOf((browser as any).url, "内置浏览器"))]
    : [];

  const memoryDetails = asArray(memoryProposals).map((item): Detail => makeDetail(
    item?.content || item?.title || item?.summary || item?.id,
    [item?.category, pickWord(MEMORY_STATUS_WORDS, item?.status, "待准入")].filter(Boolean).join(" · "),
  ));

  // 后台进程：只列真正在跑/排队的调度器，全空闲时不占位。
  const backgroundDetails = (["agent", "officecli"] as const)
    .map((key) => ({ key, slot: (scheduler as any)?.[key] }))
    .filter(({ slot }) => Number(slot?.active) > 0 || Number(slot?.queued) > 0)
    .map(({ key, slot }): Detail => makeDetail(
      key === "agent" ? "Agent 调度" : "Office 调度",
      `运行 ${Number(slot?.active) || 0}/${Number(slot?.limit) || 0} · 排队 ${Number(slot?.queued) || 0}`,
      { status: Number(slot?.active) > 0 ? "running" : "queued" },
    ));

  const groups = [
    makeGroup(GROUP_DEFS[0], artifactDetails),
    makeGroup(GROUP_DEFS[1], referenceDetails),
    makeGroup(GROUP_DEFS[2], [...skillDetails, ...mcpDetails]),
    makeGroup(GROUP_DEFS[3], webDetails),
    makeGroup(GROUP_DEFS[4], memoryDetails),
  ];

  return {
    groups,
    background: { ...makeGroup({ key: "background", label: "后台进程", icon: "terminal" }, backgroundDetails), count: backgroundDetails.length },
    environment: {
      workspace: textOf((environment as any)?.workspace, "未指定"),
      model: textOf((environment as any)?.model, "默认"),
      runtime: textOf((environment as any)?.runtime, "未知"),
    },
    total: groups.reduce((sum, group) => sum + group.count, 0),
    // 对齐对标报告 §3.3① 的 +N 口径：本轮新增的「产出 / 来源 / 记忆」条目数。
    objectCount: artifactDetails.length + referenceDetails.length + memoryDetails.length,
  };
}
