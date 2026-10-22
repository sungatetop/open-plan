/**
 * B6-6-2 对拍：agent.mjs 薄 IO 批（skill-search / model-spec / memory-layers / pending-asks）。
 *
 * 旧侧不加载 agent.mjs（巨石依赖链过重），按行号提取源码段 + new Function 求值（批6d-2 范式）；
 * 依赖（path/fs/os、AGENT_DIR/PROJECT_DIR、pi-config 四读取函数、atomicWriteJson、
 * getWorkspace/normalizeWorkspace）以常量或函数注入。行号锚点断言保证 agent.mjs 变动时先行失败提醒。
 *
 * IO 基建（双侧同流）：
 * - AGENT_DIR 经 OAW_DATA_DIR 重定向到临时目录（B6-3 范式：先 stubEnv 再动态 import，模块常量同环境求值）；
 *   旧侧读取函数用旧 server/pi-config-management.mjs，新侧用 TS 版，各读同一份临时夹具。
 * - USERPROFILE 重定向控制 skills 的用户根；真实仓库 .claude/skills（51 个技能）双侧同扫，不进快照断言。
 * - 记忆工作区经显式参数传临时目录；getWorkspace/normalizeWorkspace 用新 TS workspace（B6-4 已对拍，作共享助手）。
 * - pending-asks 落点 PROJECT_DIR/.oaw/pending-asks.json 是真实仓库运行时文件：用例前后备份/还原，
 *   每个用例同一夹具先跑旧侧再重置夹具跑新侧，比对返回值与落盘内容（时间戳归一）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs, { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

type AnyMod = Record<string, any>;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT_SOURCE = readFileSync(path.resolve(HERE, "../../server/agent.mjs"), "utf8");
const LINES = AGENT_SOURCE.split("\n");
const seg = (start: number, end: number) => LINES.slice(start - 1, end).join("\n").replace(/^export\s+/gm, "");

// 行号锚点：agent.mjs 结构变动导致偏移时，这里先行失败提醒更新提取区间
expect(seg(292, 292)).toContain("function localSkillRoots");
expect(seg(703, 703)).toContain("function localModelProviders");
expect(seg(759, 759)).toContain("function readMemoryLayers");
expect(seg(812, 812)).toContain("const PENDING_ASKS_FILE");
expect(seg(833, 833)).toContain("function consumeRecoveredAnswers");

function writeText(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}
function writeJson(file: string, value: unknown): void {
  writeText(file, JSON.stringify(value, null, 2) + "\n");
}
/** 时间派生字段归一（resolvedAt/consumedAt 双侧各自取当前时间，不进比较载荷，仅断言存在）。 */
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
const oldSide: { skills: AnyMod; modelSpec: AnyMod; memory: AnyMod; pending: AnyMod } = {} as any;
const newSide: { skillSearch: AnyMod; modelSpec: AnyMod; memoryLayers: AnyMod; pendingAsks: AnyMod } = {} as any;

beforeAll(async () => {
  tempAgent = fs.mkdtempSync(path.join(os.tmpdir(), "b662-agent-")); tempRoots.push(tempAgent);
  tempUser = fs.mkdtempSync(path.join(os.tmpdir(), "b662-user-")); tempRoots.push(tempUser);
  wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "b662-ws-")); tempRoots.push(wsRoot);
  vi.stubEnv("OAW_DATA_DIR", tempAgent);
  vi.stubEnv("USERPROFILE", tempUser);
  vi.stubEnv("APPDATA", path.join(tempUser, "AppData", "Roaming"));
  // 注意：不 stub PI_AGENT_DIR——resolveAgentDirectory 显式优先该变量，会抢占 OAW_DATA_DIR

  // 同一环境下求值：旧 pi-config（旧侧读取函数来源）与新 TS 模块
  const oldPiConfig = (await import("../../server/pi-config-management.mjs")) as unknown as AnyMod;
  const piConfig = (await import("../src/main/backend/agent/pi-config-management")) as unknown as AnyMod;
  const workspace = (await import("../src/main/backend/workspace")) as unknown as AnyMod;
  const persistenceUtils = (await import("../src/main/backend/persistence-utils")) as unknown as AnyMod;
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

  // 旧 agent.mjs 依赖经参数注入：path/fs/os 用真品，锚点常量/共享助手用同一份值
  oldSide.skills = new Function("path", "fs", "os", "AGENT_DIR", "PROJECT_DIR", `${seg(290, 334)}\nreturn { localSkillRoots, localSkillCatalog, searchLocalSkills };`)(path, fs, os, agentDir, PROJECT_DIR);
  oldSide.modelSpec = new Function("readModelsStore", "readModelsConfig", "readCredentials", "readRuntimeSettings", `${seg(702, 756)}\nreturn { localModelProviders, localStoredModels, configuredModelSpec, currentModelSpec, resolveInitialModel };`)(oldPiConfig.readModelsStore, oldPiConfig.readModelsConfig, oldPiConfig.readCredentials, oldPiConfig.readRuntimeSettings);
  oldSide.memory = new Function("fs", "path", "getWorkspace", "normalizeWorkspace", `${seg(758, 810)}\nreturn { readMemoryLayers, readMemoryContext };`)(fs, path, workspace.getWorkspace, workspace.normalizeWorkspace);
  oldSide.pending = new Function("fs", "path", "PROJECT_DIR", "atomicWriteJson", `${seg(812, 840)}\nreturn { PENDING_ASKS_FILE, readPendingAsks, savePendingAsks, persistPendingAsk, resolvePendingAsk, consumeRecoveredAnswers };`)(fs, path, PROJECT_DIR, persistenceUtils.atomicWriteJson);
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

describe("B6-6-2 skill-search 对拍", () => {
  it("localSkillRoots 双侧同流且锚定临时目录", () => {
    const oldRoots = oldSide.skills.localSkillRoots();
    const newRoots = newSide.skillSearch.localSkillRoots();
    expect(newRoots).toEqual(oldRoots);
    expect(newRoots).toHaveLength(7);
    expect(newRoots[0]).toBe(path.join(agentDir, "skills"));
    expect(newRoots[1]).toBe(path.join(tempUser, ".agents", "skills"));
    expect(newRoots[2]).toBe(path.join(tempUser, ".claude", "skills"));
    expect(newRoots[3]).toBe(path.join(PROJECT_DIR, ".agents", "skills"));
    expect(newRoots[4]).toBe(path.join(PROJECT_DIR, ".pi", "skills"));
    expect(newRoots[5]).toBe(path.join(PROJECT_DIR, ".claude", "skills"));
    expect(newRoots[6]).toBe(path.resolve(PROJECT_DIR, "..", ".claude", "skills"));
  });

  it("localSkillCatalog 夹具双侧同流（frontmatter/去重首根优先/来源标记/跳过/排序）", () => {
    writeText(path.join(agentDir, "skills", "alpha", "SKILL.md"), "---\ndescription: 首要技能 alpha 说明\n---\n# 正文");
    writeText(path.join(agentDir, "skills", "dup-name", "SKILL.md"), "---\ndescription: agent 目录版本\n---");
    writeText(path.join(tempUser, ".agents", "skills", "dup-name", "SKILL.md"), "---\ndescription: 用户 agents 版本\n---");
    writeText(path.join(tempUser, ".claude", "skills", "beta", "SKILL.md"), "没有 frontmatter 的技能");
    writeText(path.join(tempUser, ".claude", "skills", "quoted", "SKILL.md"), '---\ndescription: "带引号的描述"\n---\n正文');
    writeText(path.join(tempUser, ".claude", "skills", "empty-desc", "SKILL.md"), "---\ntitle: 无描述\n---\n正文");
    fs.mkdirSync(path.join(agentDir, "skills", "no-skill-md"), { recursive: true });
    writeText(path.join(agentDir, "skills", "plain-file"), "不是目录");

    const oldCat = oldSide.skills.localSkillCatalog();
    const newCat = newSide.skillSearch.localSkillCatalog();
    expect(newCat).toEqual(oldCat);

    const byName = new Map<string, any>(newCat.map((s: any): [string, any] => [s.name, s]));
    expect(byName.get("alpha")).toMatchObject({ description: "首要技能 alpha 说明", source: "pi-agent", path: path.join(agentDir, "skills", "alpha", "SKILL.md") });
    expect(byName.get("dup-name")).toMatchObject({ description: "agent 目录版本", source: "pi-agent" });
    expect(byName.get("beta")?.description).toBe("");
    expect(byName.get("beta")?.source).toBe("pi-agent");
    expect(byName.get("quoted")?.description).toBe("带引号的描述");
    expect(byName.get("empty-desc")?.description).toBe("");
    expect(byName.has("no-skill-md")).toBe(false);
    const names = newCat.map((s: any) => s.name as string);
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
  });

  it("searchLocalSkills 查询与 limit 边界双侧同流", () => {
    const cases: Array<[unknown, unknown]> = [
      ["alpha", undefined], ["ALPHA 首要", undefined], ["不存在的查询词", undefined],
      ["", undefined], [null, undefined], ["", 0], ["", -5], ["", 1], ["", 31], ["", 100],
      ["", "abc"], ["", 5], ["alpha", 1], ["alpha", 0],
    ];
    for (const [query, limit] of cases) {
      const o = oldSide.skills.searchLocalSkills(query, limit);
      const n = newSide.skillSearch.searchLocalSkills(query, limit);
      expect(n, `query=${String(query)} limit=${String(limit)}`).toEqual(o);
    }
    expect(newSide.skillSearch.searchLocalSkills("alpha").map((s: any) => s.name)).toContain("alpha");
    expect(newSide.skillSearch.searchLocalSkills("", 1)).toHaveLength(1);
    expect(newSide.skillSearch.searchLocalSkills("", 100).length).toBeLessThanOrEqual(30);
  });
});

describe("B6-6-2 model-spec 对拍", () => {
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

  it("localModelProviders 双侧同流（三源并集/显式禁用剔除）", () => {
    writeModelFixture();
    const o = oldSide.modelSpec.localModelProviders();
    const n = newSide.modelSpec.localModelProviders();
    expect(n).toBeInstanceOf(Set);
    expect([...n].sort()).toEqual([...o].sort());
    expect([...n].sort()).toEqual(["供应商A", "供应商C", "供应商D", "供应商E"]);
  });

  it("localStoredModels 默认与显式 providers 双侧同流（禁用/空 id/非对象剔除，显式 provider 保留）", () => {
    writeModelFixture();
    const cases: Array<Set<string> | undefined> = [undefined, new Set(["供应商A"]), new Set(["供应商B"]), new Set()];
    for (const providers of cases) {
      const o = providers === undefined ? oldSide.modelSpec.localStoredModels() : oldSide.modelSpec.localStoredModels(providers);
      const n = providers === undefined ? newSide.modelSpec.localStoredModels() : newSide.modelSpec.localStoredModels(providers);
      expect(n, `providers=${[...(providers ?? [])].join(",")}`).toEqual(o);
    }
    expect(newSide.modelSpec.localStoredModels()).toEqual([
      { id: "模型1", name: "m1", provider: "供应商A" },
      { id: "模型3", provider: "other-p" },
    ]);
    expect(newSide.modelSpec.localStoredModels(new Set(["供应商B"]))).toEqual([{ id: "B1", provider: "供应商B" }]); // 供应商级 enabled 不在 stored 层复查
  });

  it("configuredModelSpec 双侧同流（有效/缺省/半空/trim）", () => {
    writeModelFixture();
    expect(newSide.modelSpec.configuredModelSpec()).toBe(oldSide.modelSpec.configuredModelSpec());
    expect(newSide.modelSpec.configuredModelSpec()).toBe("供应商A/模型1");
    writeModelFixture({ settings: { defaultProvider: "供应商A" } });
    expect(newSide.modelSpec.configuredModelSpec()).toBe(oldSide.modelSpec.configuredModelSpec());
    expect(newSide.modelSpec.configuredModelSpec()).toBe("");
    writeModelFixture({ settings: { defaultProvider: "  供应商A  ", defaultModel: " 模型1 " } });
    expect(newSide.modelSpec.configuredModelSpec()).toBe(oldSide.modelSpec.configuredModelSpec());
    expect(newSide.modelSpec.configuredModelSpec()).toBe("供应商A/模型1");
  });

  it("currentModelSpec 双侧同流（纯函数）", () => {
    const entries = [
      { session: { model: { provider: "p", id: "m" } } },
      { session: { model: { provider: "p" } }, modelFallbackSpec: "fb/p" },
      { modelFallbackSpec: "fb/p" },
      {},
      undefined,
      null,
    ];
    for (const entry of entries) {
      expect(newSide.modelSpec.currentModelSpec(entry)).toBe(oldSide.modelSpec.currentModelSpec(entry));
    }
    expect(newSide.modelSpec.currentModelSpec(entries[0])).toBe("p/m");
    expect(newSide.modelSpec.currentModelSpec(null)).toBe("");
  });

  it("resolveInitialModel 双侧同流（runtime 优先/spec 解析/回退本地目录）", () => {
    writeModelFixture();
    const runtimeHit = { getModel: () => ({ id: "rt", provider: "供应商A" }) };
    const runtimeMiss = { getModel: () => null };
    const cases: Array<[unknown, unknown]> = [
      [runtimeHit, "供应商A/模型1"],
      [runtimeMiss, "供应商A/模型1"],
      [runtimeMiss, "供应商A/不存在"],
      [runtimeMiss, "无分隔符"],
      [runtimeMiss, "/开头"],
      [runtimeMiss, "结尾/"],
      [runtimeMiss, "/"],
      [undefined, ""],
      [undefined, "  供应商A/模型1  "],
      [null, "供应商A/模型1"],
    ];
    for (const [runtime, spec] of cases) {
      const o = oldSide.modelSpec.resolveInitialModel(runtime, spec);
      const n = newSide.modelSpec.resolveInitialModel(runtime, spec);
      expect(n, `spec=${String(spec)}`).toEqual(o);
    }
    expect(newSide.modelSpec.resolveInitialModel(runtimeHit, "供应商A/模型1")).toEqual({ id: "rt", provider: "供应商A" });
    expect(newSide.modelSpec.resolveInitialModel(runtimeMiss, "供应商A/模型1")).toEqual({ id: "模型1", name: "m1", provider: "供应商A" });
    expect(newSide.modelSpec.resolveInitialModel(runtimeMiss, "供应商A/不存在")).toBeNull();
    expect(newSide.modelSpec.resolveInitialModel(undefined, "")).toEqual({ id: "模型1", name: "m1", provider: "供应商A" });
  });
});

describe("B6-6-2 memory-layers 对拍", () => {
  function freshWs(name: string): string {
    const ws = path.join(wsRoot, name);
    fs.mkdirSync(ws, { recursive: true });
    return ws;
  }

  it("分类夹具双侧同流（标题分类/文件名分类/AGENTS.md/other 结构）", () => {
    const ws = freshWs("分类");
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "# 工作区规则\n先读后写。", "utf8");
    writeText(path.join(ws, "memory", "规则.md"), "## 输出规则\n用中文。\n\n## 准则二\n保持简洁。\n\n## 其他标题\n归入 other。");
    writeText(path.join(ws, "memory", "用户偏好.md"), "无标题整段：喜欢深色主题。");
    writeText(path.join(ws, "memory", "project.md"), "无标题整段：项目是规聚。");
    writeText(path.join(ws, "memory", "经验教训.md"), "无标题整段：先备份再改。");
    writeText(path.join(ws, "memory", "杂项.md"), "无标题整段：放进 other。");
    writeText(path.join(ws, "memory", "preference-en.md"), "## UI Preference\nEnglish section.");

    const o = oldSide.memory.readMemoryLayers(ws);
    const n = newSide.memoryLayers.readMemoryLayers(ws);
    expect(n).toEqual(o);
    // rules 桶先收 AGENTS.md，再追加 memory 中标题命中的分段
    expect(n.rules).toBe("# 工作区规则\n先读后写。\n### 输出规则\n用中文。\n### 准则二\n保持简洁。");
    expect(n.preferences).toContain("### UI Preference\nEnglish section.");
    expect(n.preferences).toContain("无标题整段：喜欢深色主题。");
    expect(n.project).toContain("无标题整段：项目是规聚。");
    expect(n.lessons).toContain("无标题整段：先备份再改。");
    expect(n.other).toHaveLength(2);
    expect(n.other.find((x: any) => x.file === "规则.md / 其他标题")?.content).toBe("归入 other。");
    expect(n.other.find((x: any) => x.file === "杂项.md")?.content).toBe("无标题整段：放进 other。");
  });

  it("空标题体/空文件/非 md/缺 memory 目录/缺工作区 双侧同流", () => {
    const ws = freshWs("边界");
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "", "utf8");
    writeText(path.join(ws, "memory", "空段.md"), "## 只有标题");
    writeText(path.join(ws, "memory", "空文件.md"), "   ");
    writeText(path.join(ws, "memory", "notes.txt"), "不是 md 不进结果");

    const o = oldSide.memory.readMemoryLayers(ws);
    const n = newSide.memoryLayers.readMemoryLayers(ws);
    expect(n).toEqual(o);
    expect(n.rules).toBe("");
    expect(n.other).toEqual([]);

    const noMem = freshWs("无memory目录");
    fs.writeFileSync(path.join(noMem, "AGENTS.md"), "规则内容", "utf8");
    expect(newSide.memoryLayers.readMemoryLayers(noMem)).toEqual(oldSide.memory.readMemoryLayers(noMem));

    // 缺工作区：normalizeWorkspace 落空后回落当前工作区（真实 office-workspace，无 AGENTS.md/memory）→ 空层
    const missing = path.join(wsRoot, "不存在的工作区");
    const emptyLayers = { rules: "", project: "", preferences: "", lessons: "", other: [] };
    expect(newSide.memoryLayers.readMemoryLayers(missing)).toEqual(emptyLayers);
    expect(newSide.memoryLayers.readMemoryLayers(missing)).toEqual(oldSide.memory.readMemoryLayers(missing));
  });

  it("预算截断与 readMemoryContext 双侧同流", () => {
    const ws = freshWs("截断");
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "R".repeat(3000), "utf8");
    writeText(path.join(ws, "memory", "偏好.md"), "## 偏好\n" + "P".repeat(1000));
    writeText(path.join(ws, "memory", "其他长文.md"), "## 超长其他\n" + "O".repeat(1000));

    const o = oldSide.memory.readMemoryLayers(ws);
    const n = newSide.memoryLayers.readMemoryLayers(ws);
    expect(n).toEqual(o);
    expect(n.rules).toHaveLength(1800);
    expect(n.preferences).toBe("\n### 偏好\n" + "P".repeat(1000));

    const ctx = newSide.memoryLayers.readMemoryContext(ws);
    expect(ctx).toBe(oldSide.memory.readMemoryContext(ws));
    expect(ctx).toContain("## 工作区准则（AGENTS.md）");
    expect(ctx).toContain("## 用户偏好");
    expect(ctx.length).toBeLessThanOrEqual(2800);
  });
});

describe("B6-6-2 pending-asks 对拍", () => {
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
  /** 双侧串行：同一夹具先跑旧侧，再重置夹具跑新侧，比对返回值与落盘内容。 */
  function runBoth(setup: () => void, run: (side: AnyMod) => unknown): { oldResult: any; newResult: any; oldFile: any; newFile: any } {
    setup();
    const oldResult = normalizeTimestamps(run(oldSide.pending));
    const oldFile = normalizeTimestamps(readPendingFile());
    setup();
    const newResult = normalizeTimestamps(run(newSide.pendingAsks));
    const newFile = normalizeTimestamps(readPendingFile());
    return { oldResult, newResult, oldFile, newFile };
  }

  it("常量与缺省读取双侧同流（文件缺失/损坏 JSON/动态形状原样）", () => {
    expect(newSide.pendingAsks.PENDING_ASKS_FILE).toBe(oldSide.pending.PENDING_ASKS_FILE);
    expect(newSide.pendingAsks.PENDING_ASKS_FILE).toBe(PENDING_FILE);
    expect(newSide.pendingAsks.readPendingAsks()).toEqual([]);
    expect(oldSide.pending.readPendingAsks()).toEqual([]);
    writePending([{ x: 1 }]);
    expect(newSide.pendingAsks.readPendingAsks()).toEqual(oldSide.pending.readPendingAsks());
    writeText(PENDING_FILE, "{不是JSON");
    expect(newSide.pendingAsks.readPendingAsks()).toEqual([]);
    expect(oldSide.pending.readPendingAsks()).toEqual([]);
  });

  it("persistPendingAsk 追加/同 client 待答去重/100 条截尾双侧同流", () => {
    let r = runBoth(
      () => writePending([{ clientId: "c1", status: "pending", q: 1 }, { clientId: "c1", status: "answered", q: 2 }, { clientId: "c2", status: "pending", q: 3 }]),
      (side) => { side.persistPendingAsk({ clientId: "c1", status: "pending", q: 9 }); return readPendingFile(); },
    );
    expect(r.newFile).toEqual(r.oldFile);
    expect(r.newFile.map((x: any) => `${x.clientId}:${x.status}:${x.q}`)).toEqual(["c1:answered:2", "c2:pending:3", "c1:pending:9"]);

    r = runBoth(
      () => writePending(Array.from({ length: 105 }, (_, i) => ({ clientId: "c0", status: "answered", i }))),
      (side) => { side.persistPendingAsk({ clientId: "c-new", status: "pending" }); return readPendingFile(); },
    );
    expect(r.newFile).toEqual(r.oldFile);
    expect(r.newFile).toHaveLength(100);
    expect(r.newFile[0].i).toBe(6); // 105+1=106 条截尾 100，丢弃前 6 条
    expect(r.newFile[99]).toMatchObject({ clientId: "c-new", status: "pending" });
  });

  it("resolvePendingAsk 倒序命中/写回/空答案与自定义 status/未命中双侧同流", () => {
    let r = runBoth(
      () => writePending([
        { clientId: "c1", status: "pending", answer: null },
        { clientId: "c1", status: "pending", answer: null },
        { clientId: "c2", status: "pending" },
      ]),
      (side) => side.resolvePendingAsk("c1", "这是答案"),
    );
    expect(r.newResult).toEqual(r.oldResult);
    expect(r.newResult).toMatchObject({ clientId: "c1", status: "answered", answer: "这是答案" });
    expect(typeof r.newResult.resolvedAt).toBe("string");
    expect(r.newFile).toEqual(r.oldFile);
    expect(r.newFile.filter((x: any) => x.clientId === "c1").map((x: any) => x.status)).toEqual(["pending", "answered"]);

    r = runBoth(
      () => writePending([{ clientId: "c2", status: "pending" }]),
      (side) => side.resolvePendingAsk("c2", "", "dismissed"),
    );
    expect(r.newResult).toEqual(r.oldResult);
    expect(r.newResult).toMatchObject({ status: "dismissed", answer: null });
    expect(r.newFile).toEqual(r.oldFile);

    r = runBoth(
      () => writePending([{ clientId: "c3", status: "pending" }]),
      (side) => side.resolvePendingAsk("nobody", "x"),
    );
    expect(r.newResult).toBeUndefined();
    expect(r.oldResult).toBeUndefined();
    expect(r.newFile).toEqual([{ clientId: "c3", status: "pending" }]);
  });

  it("consumeRecoveredAnswers 恢复 queued 回答/置 consumed/空结果双侧同流", () => {
    let r = runBoth(
      () => writePending([
        { clientId: "c1", status: "queued", answer: "答1" },
        { clientId: "c1", status: "queued", answer: null },
        { clientId: "c1", status: "consumed", answer: "旧" },
        { clientId: "c2", status: "queued", answer: "别人的" },
      ]),
      (side) => side.consumeRecoveredAnswers("c1"),
    );
    expect(r.newResult).toEqual(r.oldResult);
    expect(r.newResult.map((x: any) => x.answer)).toEqual(["答1"]);
    expect(typeof r.newResult[0].consumedAt).toBe("string");
    expect(r.newFile).toEqual(r.oldFile);
    expect(r.newFile[0].status).toBe("consumed");
    expect(r.newFile[1].status).toBe("queued");
    expect(r.newFile[3].status).toBe("queued");

    r = runBoth(
      () => writePending([{ clientId: "c1", status: "pending" }]),
      (side) => side.consumeRecoveredAnswers("c1"),
    );
    expect(r.newResult).toEqual([]);
    expect(r.oldResult).toEqual([]);
    expect(r.newFile).toEqual([{ clientId: "c1", status: "pending" }]);
  });

  it("savePendingAsks 直接落盘双侧同流", () => {
    const r = runBoth(
      () => fs.rmSync(PENDING_FILE, { force: true }),
      (side) => { side.savePendingAsks([{ a: 1 }, { b: 2 }]); return readPendingFile(); },
    );
    expect(r.newFile).toEqual([{ a: 1 }, { b: 2 }]);
    expect(r.newFile).toEqual(r.oldFile);
  });
});
