/**
 * B6-6-2 行为覆盖：agent.mjs 薄 IO 批（skill-search / model-spec / memory-layers / pending-asks）。
 *
 * R6-6b 对拍退役改写：旧侧行号提取源码段 + new Function 求值随 server 退役删除，
 * 仅保留 TS 侧断言（期望值此前已经双侧对拍固化，现改为直接断言）。
 *
 * IO 基建：
 * - AGENT_DIR 经 OAW_DATA_DIR 重定向到临时目录（B6-3 范式：先 stubEnv 再动态 import，模块常量同环境求值）。
 * - USERPROFILE 重定向控制 skills 的用户根；真实仓库 .claude/skills（51 个技能）会被扫到，不进快照断言。
 * - 记忆工作区经显式参数传临时目录；getWorkspace/normalizeWorkspace 用 TS workspace（B6-4 已对拍，作共享助手）。
 * - pending-asks 落点 PROJECT_DIR/.oaw/pending-asks.json 是真实仓库运行时文件：用例前后备份/还原，时间戳字段不进断言。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type AnyMod = Record<string, any>;

function writeText(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}
function writeJson(file: string, value: unknown): void {
  writeText(file, JSON.stringify(value, null, 2) + "\n");
}
/** 时间派生字段归一（resolvedAt/consumedAt 取当前时间，不进断言载荷，仅断言存在）。 */
function normalizeTimestamps(value: any): any {
  if (Array.isArray(value)) return value.map(normalizeTimestamps);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, (k === "resolvedAt" || k === "consumedAt") && typeof v === "string" ? "<TS>" : normalizeTimestamps(v)]));
  }
  return value;
}

const tempRoots: string[] = [];
let tempAgent = "";
let tempUser = "";
let wsRoot = "";
let agentDir = "";
let PROJECT_DIR = "";
let PENDING_FILE = "";
let pendingBackup: Buffer | null = null;
// 具名形状声明（Record + noUncheckedIndexedAccess 会把属性访问窄化为 | undefined）
const newSide: { skillSearch: AnyMod; modelSpec: AnyMod; memoryLayers: AnyMod; pendingAsks: AnyMod } = {} as any;

beforeAll(async () => {
  tempAgent = fs.mkdtempSync(path.join(os.tmpdir(), "b662-agent-")); tempRoots.push(tempAgent);
  tempUser = fs.mkdtempSync(path.join(os.tmpdir(), "b662-user-")); tempRoots.push(tempUser);
  wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "b662-ws-")); tempRoots.push(wsRoot);
  vi.stubEnv("OAW_DATA_DIR", tempAgent);
  vi.stubEnv("USERPROFILE", tempUser);
  vi.stubEnv("APPDATA", path.join(tempUser, "AppData", "Roaming"));
  // 注意：不 stub PI_AGENT_DIR——resolveAgentDirectory 显式优先该变量，会抢占 OAW_DATA_DIR

  const piConfig = (await import("../src/main/backend/agent/pi-config-management")) as unknown as AnyMod;
  const workspace = (await import("../src/main/backend/workspace")) as unknown as AnyMod;
  newSide.skillSearch = (await import("../src/main/backend/agent/skill-search")) as unknown as AnyMod;
  newSide.modelSpec = (await import("../src/main/backend/agent/model-spec")) as unknown as AnyMod;
  newSide.memoryLayers = (await import("../src/main/backend/agent/memory-layers")) as unknown as AnyMod;
  newSide.pendingAsks = (await import("../src/main/backend/agent/pending-asks")) as unknown as AnyMod;

  agentDir = String(piConfig.AGENT_DIR);
  PROJECT_DIR = String(workspace.PROJECT_DIR);
  PENDING_FILE = path.join(PROJECT_DIR, ".oaw", "pending-asks.json");
  pendingBackup = fs.existsSync(PENDING_FILE) ? fs.readFileSync(PENDING_FILE) : null;

  expect(path.resolve(agentDir)).toBe(path.resolve(tempAgent));
  expect(newSide.pendingAsks.PENDING_ASKS_FILE).toBe(path.join(PROJECT_DIR, ".oaw", "pending-asks.json"));
});

afterAll(() => {
  vi.unstubAllEnvs();
  // pending-asks 真实文件还原（原先无文件则清掉）
  if (PENDING_FILE) {
    if (pendingBackup === null) fs.rmSync(PENDING_FILE, { force: true });
    else fs.writeFileSync(PENDING_FILE, pendingBackup);
  }
  for (const dir of tempRoots.splice(0).reverse()) fs.rmSync(dir, { recursive: true, force: true });
});

describe("B6-6-2 skill-search 行为覆盖", () => {
  it("localSkillRoots 锚定临时目录", () => {
    const roots = newSide.skillSearch.localSkillRoots();
    expect(roots).toHaveLength(7);
    expect(roots[0]).toBe(path.join(agentDir, "skills"));
    expect(roots[1]).toBe(path.join(tempUser, ".agents", "skills"));
    expect(roots[2]).toBe(path.join(tempUser, ".claude", "skills"));
    expect(roots[3]).toBe(path.join(PROJECT_DIR, ".agents", "skills"));
    expect(roots[4]).toBe(path.join(PROJECT_DIR, ".pi", "skills"));
    expect(roots[5]).toBe(path.join(PROJECT_DIR, ".claude", "skills"));
    expect(roots[6]).toBe(path.resolve(PROJECT_DIR, "..", ".claude", "skills"));
  });

  it("localSkillCatalog 夹具（frontmatter/去重首根优先/来源标记/跳过/排序）", () => {
    writeText(path.join(agentDir, "skills", "alpha", "SKILL.md"), "---\ndescription: 首要技能 alpha 说明\n---\n# 正文");
    writeText(path.join(agentDir, "skills", "dup-name", "SKILL.md"), "---\ndescription: agent 目录版本\n---");
    writeText(path.join(tempUser, ".agents", "skills", "dup-name", "SKILL.md"), "---\ndescription: 用户 agents 版本\n---");
    writeText(path.join(tempUser, ".claude", "skills", "beta", "SKILL.md"), "没有 frontmatter 的技能");
    writeText(path.join(tempUser, ".claude", "skills", "quoted", "SKILL.md"), '---\ndescription: "带引号的描述"\n---\n正文');
    writeText(path.join(tempUser, ".claude", "skills", "empty-desc", "SKILL.md"), "---\ntitle: 无描述\n---\n正文");
    fs.mkdirSync(path.join(agentDir, "skills", "no-skill-md"), { recursive: true });
    writeText(path.join(agentDir, "skills", "plain-file"), "不是目录");

    const catalog = newSide.skillSearch.localSkillCatalog();
    const byName = new Map<string, any>(catalog.map((s: any): [string, any] => [s.name, s]));
    expect(byName.get("alpha")).toMatchObject({ description: "首要技能 alpha 说明", source: "pi-agent", path: path.join(agentDir, "skills", "alpha", "SKILL.md") });
    expect(byName.get("dup-name")).toMatchObject({ description: "agent 目录版本", source: "pi-agent" });
    expect(byName.get("beta")?.description).toBe("");
    expect(byName.get("beta")?.source).toBe("pi-agent");
    expect(byName.get("quoted")?.description).toBe("带引号的描述");
    expect(byName.get("empty-desc")?.description).toBe("");
    expect(byName.has("no-skill-md")).toBe(false);
    const names = catalog.map((s: any) => s.name as string);
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
  });

  it("searchLocalSkills 查询与 limit 边界", () => {
    expect(newSide.skillSearch.searchLocalSkills("alpha").map((s: any) => s.name)).toContain("alpha");
    expect(newSide.skillSearch.searchLocalSkills("不存在的查询词")).toEqual([]);
    expect(newSide.skillSearch.searchLocalSkills("", 1)).toHaveLength(1);
    expect(newSide.skillSearch.searchLocalSkills("", 100).length).toBeLessThanOrEqual(30);
  });
});

describe("B6-6-2 model-spec 行为覆盖", () => {
  const AGENT_FILES = { store: "模型目录缓存.json", config: "模型配置.json", auth: "凭据.json", settings: "运行设置.json" };
  function writeModelFixture(overrides: { store?: unknown; config?: unknown; auth?: unknown; settings?: unknown } = {}): void {
    writeJson(path.join(agentDir, AGENT_FILES.store), overrides.store ?? {
      "供应商A": { enabled: true, models: [{ id: "模型1", name: "m1" }, { id: "模型2", enabled: false }, { id: "  " }, null, { id: "模型3", provider: "other-p" }] },
      "供应商B": { enabled: false, models: [{ id: "B1" }] },
      "供应商C": { models: "不是数组" },
    });
    writeJson(path.join(agentDir, AGENT_FILES.config), overrides.config ?? { providers: { "供应商A": { enabled: true }, "供应商B": { enabled: false }, "供应商D": {} } });
    writeJson(path.join(agentDir, AGENT_FILES.auth), overrides.auth ?? { "供应商A": { type: "api_key" }, "供应商E": { type: "oauth" } });
    writeJson(path.join(agentDir, AGENT_FILES.settings), overrides.settings ?? { defaultProvider: "供应商A", defaultModel: "模型1" });
  }

  it("localModelProviders（三源并集/显式禁用剔除）", () => {
    writeModelFixture();
    const providers = newSide.modelSpec.localModelProviders();
    expect(providers).toBeInstanceOf(Set);
    expect([...providers].sort()).toEqual(["供应商A", "供应商C", "供应商D", "供应商E"]);
  });

  it("localStoredModels 默认与显式 providers（禁用/空 id/非对象剔除，显式 provider 保留）", () => {
    writeModelFixture();
    expect(newSide.modelSpec.localStoredModels()).toEqual([
      { id: "模型1", name: "m1", provider: "供应商A" },
      { id: "模型3", provider: "other-p" },
    ]);
    expect(newSide.modelSpec.localStoredModels(new Set(["供应商A"]))).toEqual([
      { id: "模型1", name: "m1", provider: "供应商A" },
      { id: "模型3", provider: "other-p" },
    ]);
    expect(newSide.modelSpec.localStoredModels(new Set(["供应商B"]))).toEqual([{ id: "B1", provider: "供应商B" }]); // 供应商级 enabled 不在 stored 层复查
    expect(newSide.modelSpec.localStoredModels(new Set())).toEqual([]);
  });

  it("configuredModelSpec（有效/缺省/半空/trim）", () => {
    writeModelFixture();
    expect(newSide.modelSpec.configuredModelSpec()).toBe("供应商A/模型1");
    writeModelFixture({ settings: { defaultProvider: "供应商A" } });
    expect(newSide.modelSpec.configuredModelSpec()).toBe("");
    writeModelFixture({ settings: { defaultProvider: "  供应商A  ", defaultModel: " 模型1 " } });
    expect(newSide.modelSpec.configuredModelSpec()).toBe("供应商A/模型1");
  });

  it("currentModelSpec（纯函数）", () => {
    const entries = [
      { session: { model: { provider: "p", id: "m" } } },
      { session: { model: { provider: "p" } }, modelFallbackSpec: "fb/p" },
      { modelFallbackSpec: "fb/p" },
      {},
      undefined,
      null,
    ];
    expect(newSide.modelSpec.currentModelSpec(entries[0])).toBe("p/m");
    expect(newSide.modelSpec.currentModelSpec(entries[1])).toBe("fb/p");
    expect(newSide.modelSpec.currentModelSpec(entries[2])).toBe("fb/p");
    expect(newSide.modelSpec.currentModelSpec(entries[3])).toBe("");
    expect(newSide.modelSpec.currentModelSpec(undefined)).toBe("");
    expect(newSide.modelSpec.currentModelSpec(null)).toBe("");
  });

  it("resolveInitialModel（runtime 优先/spec 解析/回退本地目录）", () => {
    writeModelFixture();
    const runtimeHit = { getModel: () => ({ id: "rt", provider: "供应商A" }) };
    const runtimeMiss = { getModel: () => null };
    expect(newSide.modelSpec.resolveInitialModel(runtimeHit, "供应商A/模型1")).toEqual({ id: "rt", provider: "供应商A" });
    expect(newSide.modelSpec.resolveInitialModel(runtimeMiss, "供应商A/模型1")).toEqual({ id: "模型1", name: "m1", provider: "供应商A" });
    expect(newSide.modelSpec.resolveInitialModel(runtimeMiss, "供应商A/不存在")).toBeNull();
    expect(newSide.modelSpec.resolveInitialModel(runtimeMiss, "无分隔符")).toBeNull();
    expect(newSide.modelSpec.resolveInitialModel(runtimeMiss, "/开头")).toBeNull();
    expect(newSide.modelSpec.resolveInitialModel(runtimeMiss, "结尾/")).toBeNull();
    expect(newSide.modelSpec.resolveInitialModel(runtimeMiss, "/")).toBeNull();
    expect(newSide.modelSpec.resolveInitialModel(undefined, "")).toEqual({ id: "模型1", name: "m1", provider: "供应商A" });
    expect(newSide.modelSpec.resolveInitialModel(undefined, "  供应商A/模型1  ")).toEqual({ id: "模型1", name: "m1", provider: "供应商A" });
    expect(newSide.modelSpec.resolveInitialModel(null, "供应商A/模型1")).toEqual({ id: "模型1", name: "m1", provider: "供应商A" });
  });
});

describe("B6-6-2 memory-layers 行为覆盖", () => {
  function freshWs(name: string): string {
    const ws = path.join(wsRoot, name);
    fs.mkdirSync(ws, { recursive: true });
    return ws;
  }

  it("分类夹具（标题分类/文件名分类/AGENTS.md/other 结构）", () => {
    const ws = freshWs("分类");
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "# 工作区规则\n先读后写。", "utf8");
    writeText(path.join(ws, "memory", "规则.md"), "## 输出规则\n用中文。\n\n## 准则二\n保持简洁。\n\n## 其他标题\n归入 other。");
    writeText(path.join(ws, "memory", "用户偏好.md"), "无标题整段：喜欢深色主题。");
    writeText(path.join(ws, "memory", "project.md"), "无标题整段：项目是规聚。");
    writeText(path.join(ws, "memory", "经验教训.md"), "无标题整段：先备份再改。");
    writeText(path.join(ws, "memory", "杂项.md"), "无标题整段：放进 other。");
    writeText(path.join(ws, "memory", "preference-en.md"), "## UI Preference\nEnglish section.");

    const layers = newSide.memoryLayers.readMemoryLayers(ws);
    // rules 桶先收 AGENTS.md，再追加 memory 中标题命中的分段
    expect(layers.rules).toBe("# 工作区规则\n先读后写。\n### 输出规则\n用中文。\n### 准则二\n保持简洁。");
    expect(layers.preferences).toContain("### UI Preference\nEnglish section.");
    expect(layers.preferences).toContain("无标题整段：喜欢深色主题。");
    expect(layers.project).toContain("无标题整段：项目是规聚。");
    expect(layers.lessons).toContain("无标题整段：先备份再改。");
    expect(layers.other).toHaveLength(2);
    expect(layers.other.find((x: any) => x.file === "规则.md / 其他标题")?.content).toBe("归入 other。");
    expect(layers.other.find((x: any) => x.file === "杂项.md")?.content).toBe("无标题整段：放进 other。");
  });

  it("空标题体/空文件/非 md/缺 memory 目录/缺工作区", () => {
    const ws = freshWs("边界");
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "", "utf8");
    writeText(path.join(ws, "memory", "空段.md"), "## 只有标题");
    writeText(path.join(ws, "memory", "空文件.md"), "   ");
    writeText(path.join(ws, "memory", "notes.txt"), "不是 md 不进结果");

    const layers = newSide.memoryLayers.readMemoryLayers(ws);
    expect(layers.rules).toBe("");
    expect(layers.other).toEqual([]);

    const noMem = freshWs("无memory目录");
    fs.writeFileSync(path.join(noMem, "AGENTS.md"), "规则内容", "utf8");
    const noMemLayers = newSide.memoryLayers.readMemoryLayers(noMem);
    expect(noMemLayers.rules).toBe("规则内容");
    expect(noMemLayers.other).toEqual([]);

    // 缺工作区：normalizeWorkspace 落空后回落当前工作区（真实 office-workspace，无 AGENTS.md/memory）→ 空层
    const missing = path.join(wsRoot, "不存在的工作区");
    expect(newSide.memoryLayers.readMemoryLayers(missing)).toEqual({ rules: "", project: "", preferences: "", lessons: "", other: [] });
  });

  it("预算截断与 readMemoryContext", () => {
    const ws = freshWs("截断");
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "R".repeat(3000), "utf8");
    writeText(path.join(ws, "memory", "偏好.md"), "## 偏好\n" + "P".repeat(1000));
    writeText(path.join(ws, "memory", "其他长文.md"), "## 超长其他\n" + "O".repeat(1000));

    const layers = newSide.memoryLayers.readMemoryLayers(ws);
    expect(layers.rules).toHaveLength(1800);
    expect(layers.preferences).toBe("\n### 偏好\n" + "P".repeat(1000));

    const ctx = newSide.memoryLayers.readMemoryContext(ws);
    expect(ctx).toContain("## 工作区准则（AGENTS.md）");
    expect(ctx).toContain("## 用户偏好");
    expect(ctx.length).toBeLessThanOrEqual(2800);
  });
});

describe("B6-6-2 pending-asks 行为覆盖", () => {
  beforeEach(() => {
    fs.rmSync(PENDING_FILE, { force: true });
  });

  function writePending(items: unknown[]): void {
    fs.mkdirSync(path.dirname(PENDING_FILE), { recursive: true });
    fs.writeFileSync(PENDING_FILE, JSON.stringify(items, null, 2), "utf8");
  }
  function readPendingFile(): any {
    try { return JSON.parse(fs.readFileSync(PENDING_FILE, "utf8")); } catch { return null; }
  }

  it("常量与缺省读取（文件缺失/损坏 JSON/动态形状原样）", () => {
    expect(newSide.pendingAsks.PENDING_ASKS_FILE).toBe(PENDING_FILE);
    expect(newSide.pendingAsks.readPendingAsks()).toEqual([]);
    writePending([{ x: 1 }]);
    expect(newSide.pendingAsks.readPendingAsks()).toEqual([{ x: 1 }]);
    writeText(PENDING_FILE, "{不是JSON");
    expect(newSide.pendingAsks.readPendingAsks()).toEqual([]);
  });

  it("persistPendingAsk 追加/同 client 待答去重/100 条截尾", () => {
    writePending([{ clientId: "c1", status: "pending", q: 1 }, { clientId: "c1", status: "answered", q: 2 }, { clientId: "c2", status: "pending", q: 3 }]);
    newSide.pendingAsks.persistPendingAsk({ clientId: "c1", status: "pending", q: 9 });
    let file = normalizeTimestamps(readPendingFile());
    expect(file.map((x: any) => `${x.clientId}:${x.status}:${x.q}`)).toEqual(["c1:answered:2", "c2:pending:3", "c1:pending:9"]);

    fs.rmSync(PENDING_FILE, { force: true });
    writePending(Array.from({ length: 105 }, (_, i) => ({ clientId: "c0", status: "answered", i })));
    newSide.pendingAsks.persistPendingAsk({ clientId: "c-new", status: "pending" });
    file = normalizeTimestamps(readPendingFile());
    expect(file).toHaveLength(100);
    expect(file[0].i).toBe(6); // 105+1=106 条截尾 100，丢弃前 6 条
    expect(file[99]).toMatchObject({ clientId: "c-new", status: "pending" });
  });

  it("resolvePendingAsk 倒序命中/写回/空答案与自定义 status/未命中", () => {
    writePending([
      { clientId: "c1", status: "pending", answer: null },
      { clientId: "c1", status: "pending", answer: null },
      { clientId: "c2", status: "pending" },
    ]);
    const resolved = normalizeTimestamps(newSide.pendingAsks.resolvePendingAsk("c1", "这是答案"));
    expect(resolved).toMatchObject({ clientId: "c1", status: "answered", answer: "这是答案" });
    expect(typeof resolved.resolvedAt).toBe("string");
    let file = normalizeTimestamps(readPendingFile());
    expect(file.filter((x: any) => x.clientId === "c1").map((x: any) => x.status)).toEqual(["pending", "answered"]);

    fs.rmSync(PENDING_FILE, { force: true });
    writePending([{ clientId: "c2", status: "pending" }]);
    const dismissed = normalizeTimestamps(newSide.pendingAsks.resolvePendingAsk("c2", "", "dismissed"));
    expect(dismissed).toMatchObject({ status: "dismissed", answer: null });

    fs.rmSync(PENDING_FILE, { force: true });
    writePending([{ clientId: "c3", status: "pending" }]);
    expect(newSide.pendingAsks.resolvePendingAsk("nobody", "x")).toBeUndefined();
    expect(readPendingFile()).toEqual([{ clientId: "c3", status: "pending" }]);
  });

  it("consumeRecoveredAnswers 恢复 queued 回答/置 consumed/空结果", () => {
    writePending([
      { clientId: "c1", status: "queued", answer: "答1" },
      { clientId: "c1", status: "queued", answer: null },
      { clientId: "c1", status: "consumed", answer: "旧" },
      { clientId: "c2", status: "queued", answer: "别人的" },
    ]);
    const recovered = normalizeTimestamps(newSide.pendingAsks.consumeRecoveredAnswers("c1"));
    expect(recovered.map((x: any) => x.answer)).toEqual(["答1"]);
    expect(typeof recovered[0].consumedAt).toBe("string");
    let file = normalizeTimestamps(readPendingFile());
    expect(file[0].status).toBe("consumed");
    expect(file[1].status).toBe("queued");
    expect(file[3].status).toBe("queued");

    fs.rmSync(PENDING_FILE, { force: true });
    writePending([{ clientId: "c1", status: "pending" }]);
    expect(newSide.pendingAsks.consumeRecoveredAnswers("c1")).toEqual([]);
    expect(readPendingFile()).toEqual([{ clientId: "c1", status: "pending" }]);
  });

  it("savePendingAsks 直接落盘", () => {
    newSide.pendingAsks.savePendingAsks([{ a: 1 }, { b: 2 }]);
    expect(readPendingFile()).toEqual([{ a: 1 }, { b: 2 }]);
  });
});
