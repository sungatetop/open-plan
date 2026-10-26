/**
 * S3-13 四域对拍：legacy 物理加载 server/{feature-flags,agent-management,project-trust,notice}.mjs
 * vs modern 静态 import TS backend/{同名}.ts。
 *
 * 锚定说明：
 *   - feature-flags：RUNTIME_FLAGS 模块加载期读 env → 每用例 vi.stubEnv 控制环境 +
 *     vi.resetModules 重导双侧新实例断言互等（S3-12 先例：规避模块级常量缓存不可逆）；
 *     默认态把全部 OAW_ 键 stub 为空，不依赖进程环境洁净度。
 *   - agent-management：OAW_AGENTS_FILE 在两侧模块加载前 stub 注入 tmp（模块加载期常量）；
 *     写类用例刻意交叉（一侧写、另一侧读同一文件）验证落盘契约兼容。
 *   - project-trust：OAW_DATA_DIR 在两侧模块加载前 stub 注入 tmp（pi-config-management 的
 *     AGENT_DIR 为模块加载期常量，S3-11 先例，AGENT_DIR=tmp 本身）；flag off/on 两期分别
 *     重导断言（RUNTIME_FLAGS.projectTrustGate 加载期求值）。
 *   - notice：getWorkspace 进程级单值 → 两侧各自 setWorkspace 指向独立 tmp 落盘，
 *     afterAll 恢复 .workspace-state.json 原字节；docx 产物用 jszip 解包
 *     word/document.xml 全文互等（document.xml 不含时间戳，core.xml 才有）。
 * 覆盖：导出面；RUNTIME_FLAGS 全量互等（默认态/truthy 解析/qoderAlign 族联动/单开不联动/
 * readPositiveInt 边界/readStringList 分隔形态）；智能体 CRUD 全链（含内置过滤、怪 skills
 * 语义、长度边界、错误文案逐字、uuid 形态）；信任三态与 flag 门禁（off 拒绝文案逐字）；
 * 通知全字段/默认值/items 怪语义（String 化）/cnNums 溢出/文件名查重。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROJECT_DIR } from "../src/main/backend/workspace-paths";

// legacy 侧经 any 载体调用：旧 .mjs 无类型标注（S3-10/S3-11 先例）。
let legacyFlags: any;
let legacyAgents: any;
let legacyTrust: any;
let legacyNotice: any;
let modernFlags: any;
let modernAgents: any;
let modernTrust: any;
let modernNotice: any;

function normalize<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

/* ===== feature-flags ===== */

// 全部 OAW_ 键（readFlag/readPositiveInt/readStringList 读取面），默认态逐个清空
const FLAG_KEYS = [
  "OAW_QODER_ALIGN", "OAW_PI_TOOL_GATE", "OAW_PI_SIDECAR", "OAW_EVENT_NORMALIZE",
  "OAW_PROJECT_TRUST_GATE", "OAW_CACHE_WARMING", "OAW_PI_SIDECAR_IDLE_MS",
  "OAW_STAGED_VISIBLE", "OAW_AUTO_TAB", "OAW_BROWSER_BADGE", "OAW_NARROW_RESTORE",
  "OAW_RECONCILE_HINT", "OAW_FEEDBACK_V2", "OAW_BROWSER_ADAPTIVE_STREAM",
  "OAW_BROWSER_FULLPAGE", "OAW_BROWSER_URL_GUARD", "OAW_BROWSER_URL_ALLOWLIST",
  "OAW_BUSY_WATCHDOG", "OAW_BUSY_WATCHDOG_MS", "OAW_RESUME_AUTO_RETRY",
  "OAW_SPATIAL_ANALYSIS", "OAW_MAP_REPORT", "OAW_MAP_EXPORT", "OAW_DATA_ADAPTERS",
  "OAW_AMAP_MCP_BRIDGE", "OAW_MAP_PACK", "OAW_MAP_TEMPLATES", "OAW_MAP_BOOKMARKS",
  "OAW_REPLAY_RECOVER", "OAW_QODER_SSE_BACKOFF", "OAW_QODER_STYLE",
  "OAW_QODER_SSE_BACKPRESSURE", "OAW_QODER_SSE_QUEUE_MAX_BYTES", "OAW_QODER_DRAIN_ON_ABORT",
  "OAW_QODER_DRAIN_MAX_MS", "OAW_QODER_DRAIN_QUIET_MS", "OAW_HEARTBEAT_CHAT_MS",
  "OAW_HEARTBEAT_EVENTS_MS", "OAW_HEARTBEAT_BROWSER_MS", "OAW_VISUAL_EFFECTS_OFF",
  "OAW_QODER_SEQ_GAP_ALERT", "OAW_STREAM_QUOTA", "OAW_STREAM_QUOTA_RETRY_AFTER_S",
  "OAW_EVENT_SCHEMA_CHECK", "OAW_QODER_OBJECT_BAR", "OAW_DOMAIN_WORKFLOWS",
  "OAW_QODER_TOOL_OUTPUT_SPLIT", "OAW_QODER_TOOL_OUTPUT_FRAME_MAX_BYTES",
  "OAW_QODER_INTERACTION_OWNER",
];

async function loadFlags(): Promise<{ legacy: any; modern: any }> {
  return {
    legacy: await import("@legacy-server/feature-flags.mjs"),
    modern: await import("../src/main/backend/feature-flags"),
  };
}

describe("s3-runtime-config-parity feature-flags", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("导出面一致（2 项：RUNTIME_FLAGS/runtimeFlagsSnapshot）", async () => {
    FLAG_KEYS.forEach((k) => vi.stubEnv(k, ""));
    vi.resetModules();
    const { legacy, modern } = await loadFlags();
    expect(Object.keys(modern).sort()).toEqual(Object.keys(legacy).sort());
    expect(Object.isFrozen(modern.RUNTIME_FLAGS)).toBe(true);
    expect(Object.isFrozen(legacy.RUNTIME_FLAGS)).toBe(true);
  });

  it("默认态：RUNTIME_FLAGS 与 runtimeFlagsSnapshot 全量互等 + 抽查默认值", async () => {
    FLAG_KEYS.forEach((k) => vi.stubEnv(k, ""));
    vi.resetModules();
    const { legacy, modern } = await loadFlags();
    expect(normalize(modern.RUNTIME_FLAGS)).toEqual(normalize(legacy.RUNTIME_FLAGS));
    expect(normalize(modern.runtimeFlagsSnapshot())).toEqual(normalize(legacy.runtimeFlagsSnapshot()));
    expect(modern.RUNTIME_FLAGS.projectTrustGate).toBe(false);
    expect(modern.RUNTIME_FLAGS.qoderAlign).toBe(false);
    expect(modern.RUNTIME_FLAGS.heartbeatChatMs).toBe(5000);
    expect(modern.RUNTIME_FLAGS.heartbeatEventsMs).toBe(15000);
    expect(modern.RUNTIME_FLAGS.heartbeatBrowserMs).toBe(15000);
    expect(modern.RUNTIME_FLAGS.browserUrlAllowlist).toEqual([]);
    expect(modern.RUNTIME_FLAGS.piBashSidecarIdleMs).toBe(10 * 60 * 1000);
    expect(modern.RUNTIME_FLAGS.qoderToolOutputFrameMaxBytes).toBe(256 * 1024);
  });

  it("truthy 解析：ON/1/带空白 true/Yes 开；0/off/空 关；两侧全量互等", async () => {
    vi.stubEnv("OAW_PROJECT_TRUST_GATE", "ON");
    vi.stubEnv("OAW_PI_TOOL_GATE", "1");
    vi.stubEnv("OAW_CACHE_WARMING", " true ");
    vi.stubEnv("OAW_EVENT_NORMALIZE", "Yes");
    vi.stubEnv("OAW_STAGED_VISIBLE", "0");
    vi.stubEnv("OAW_AUTO_TAB", "off");
    vi.stubEnv("OAW_BROWSER_BADGE", "");
    vi.resetModules();
    const { legacy, modern } = await loadFlags();
    expect(modern.RUNTIME_FLAGS.projectTrustGate).toBe(true);
    expect(modern.RUNTIME_FLAGS.piToolGateExtension).toBe(true);
    expect(modern.RUNTIME_FLAGS.cacheWarming).toBe(true);
    expect(modern.RUNTIME_FLAGS.eventNormalize).toBe(true);
    expect(modern.RUNTIME_FLAGS.stagedVisible).toBe(false);
    expect(modern.RUNTIME_FLAGS.autoTab).toBe(false);
    expect(modern.RUNTIME_FLAGS.browserBadge).toBe(false);
    expect(normalize(modern.RUNTIME_FLAGS)).toEqual(normalize(legacy.RUNTIME_FLAGS));
  });

  it("qoderAlign 总开关联动整族；单开 qoderStyle 不联动族内其他位", async () => {
    FLAG_KEYS.forEach((k) => vi.stubEnv(k, ""));
    vi.stubEnv("OAW_QODER_ALIGN", "on");
    vi.resetModules();
    const a = await loadFlags();
    const family = ["qoderSseBackoff", "qoderStyle", "qoderSseBackpressure", "qoderDrainOnAbort", "qoderSeqGapAlert", "streamQuota", "eventSchemaCheck", "qoderObjectBar", "domainWorkflows", "qoderToolOutputSplit", "qoderInteractionOwner"];
    expect(a.modern.RUNTIME_FLAGS.qoderAlign).toBe(true);
    family.forEach((k) => expect(a.modern.RUNTIME_FLAGS[k]).toBe(true));
    expect(normalize(a.modern.RUNTIME_FLAGS)).toEqual(normalize(a.legacy.RUNTIME_FLAGS));

    vi.stubEnv("OAW_QODER_ALIGN", "");
    vi.stubEnv("OAW_QODER_STYLE", "on");
    vi.resetModules();
    const b = await loadFlags();
    expect(b.modern.RUNTIME_FLAGS.qoderStyle).toBe(true);
    expect(b.modern.RUNTIME_FLAGS.qoderAlign).toBe(false);
    expect(b.modern.RUNTIME_FLAGS.qoderSseBackoff).toBe(false);
    expect(b.modern.RUNTIME_FLAGS.domainWorkflows).toBe(false);
    expect(normalize(b.modern.RUNTIME_FLAGS)).toEqual(normalize(b.legacy.RUNTIME_FLAGS));
  });

  it("readPositiveInt 边界：0/负数/非数字回退 fallback；合法值生效", async () => {
    vi.stubEnv("OAW_HEARTBEAT_CHAT_MS", "0");
    vi.stubEnv("OAW_BUSY_WATCHDOG_MS", "-3");
    vi.stubEnv("OAW_QODER_DRAIN_MAX_MS", "abc");
    vi.stubEnv("OAW_HEARTBEAT_EVENTS_MS", "2500");
    vi.stubEnv("OAW_QODER_TOOL_OUTPUT_FRAME_MAX_BYTES", "999999");
    vi.stubEnv("OAW_STREAM_QUOTA_RETRY_AFTER_S", "12");
    vi.resetModules();
    const { legacy, modern } = await loadFlags();
    expect(modern.RUNTIME_FLAGS.heartbeatChatMs).toBe(5000);
    expect(modern.RUNTIME_FLAGS.agentBusyWatchdogMs).toBe(15 * 60 * 1000);
    expect(modern.RUNTIME_FLAGS.qoderDrainMaxMs).toBe(1500);
    expect(modern.RUNTIME_FLAGS.heartbeatEventsMs).toBe(2500);
    expect(modern.RUNTIME_FLAGS.qoderToolOutputFrameMaxBytes).toBe(999999);
    expect(modern.RUNTIME_FLAGS.streamQuotaRetryAfterSeconds).toBe(12);
    expect(normalize(modern.RUNTIME_FLAGS)).toEqual(normalize(legacy.RUNTIME_FLAGS));
  });

  it("readStringList：多分隔符 + trim + 小写化 + 空段过滤", async () => {
    vi.stubEnv("OAW_BROWSER_URL_ALLOWLIST", " Example.COM，b.org;C.Net  d ，； e ");
    vi.resetModules();
    const { legacy, modern } = await loadFlags();
    expect(modern.RUNTIME_FLAGS.browserUrlAllowlist).toEqual(["example.com", "b.org", "c.net", "d", "e"]);
    expect(normalize(modern.RUNTIME_FLAGS)).toEqual(normalize(legacy.RUNTIME_FLAGS));
  });
});

/* ===== agent-management ===== */

describe("s3-runtime-config-parity agent-management", () => {
  const TMP_AG = fs.mkdtempSync(path.join(os.tmpdir(), "s3l13ag-"));
  const AGENTS_FILE = path.join(TMP_AG, "agents.json");

  beforeAll(async () => {
    // OAW_AGENTS_FILE 在两侧模块加载前注入（AGENTS_FILE 为模块加载期常量）
    vi.stubEnv("OAW_AGENTS_FILE", AGENTS_FILE);
    legacyAgents = await import("@legacy-server/agent-management.mjs");
    modernAgents = await import("../src/main/backend/agent-management");
  });

  afterEach(() => {
    try { fs.rmSync(AGENTS_FILE, { force: true }); } catch {}
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    try { fs.rmSync(TMP_AG, { recursive: true, force: true }); } catch {}
  });

  it("导出面一致（5 项）+ BUILTIN_AGENTS 内容互等 + 数组冻结", () => {
    expect(Object.keys(modernAgents).sort()).toEqual(Object.keys(legacyAgents).sort());
    expect(normalize(modernAgents.BUILTIN_AGENTS)).toEqual(normalize(legacyAgents.BUILTIN_AGENTS));
    expect(modernAgents.BUILTIN_AGENTS.length).toBe(4);
    expect(Object.isFrozen(modernAgents.BUILTIN_AGENTS)).toBe(true);
    expect(Object.isFrozen(legacyAgents.BUILTIN_AGENTS)).toBe(true);
  });

  it("文件不存在：listAgents 互等（4 内置的展开副本，不污染内置单例）", () => {
    const lm = modernAgents.listAgents();
    const ll = legacyAgents.listAgents();
    expect(normalize(lm)).toEqual(normalize(ll));
    expect(lm.length).toBe(4);
    lm[0]!.name = "副本改动";
    expect(modernAgents.BUILTIN_AGENTS[0].name).not.toBe("副本改动");
    expect(normalize(modernAgents.listAgents())).toEqual(normalize(legacyAgents.listAgents()));
  });

  it("交叉契约链：modern 写 → legacy 读 → legacy 改 → modern 读 → modern 删 → legacy 读", () => {
    const created = modernAgents.createAgent({ id: "custom-x", name: "交叉甲", description: "描述甲", prompt: "指令甲", skills: ["a", "b"], icon: "xls", color: "#123456" });
    expect(created.ok).toBe(true);
    expect(created.agent.builtin).toBe(false);
    expect(created.agent.id).toBe("custom-x");
    expect(/^\d{4}-\d{2}-\d{2}T/.test(created.agent.updatedAt)).toBe(true);
    expect(fs.existsSync(AGENTS_FILE)).toBe(true);

    const lList = legacyAgents.listAgents();
    expect(lList.length).toBe(5);
    expect(normalize(lList[4])).toEqual(normalize(created.agent));

    const updated = legacyAgents.updateAgent("custom-x", { name: "交叉改名" });
    expect(updated.ok).toBe(true);
    expect(updated.agent.name).toBe("交叉改名");
    expect(updated.agent.prompt).toBe("指令甲"); // previous 继承
    expect(updated.agent.skills).toEqual(["a", "b"]);
    expect(updated.agent.icon).toBe("xls");
    expect(updated.agent.color).toBe("#123456");
    expect(modernAgents.listAgents().some((a: any) => a.name === "交叉改名")).toBe(true);

    const deleted = modernAgents.deleteAgent("custom-x");
    expect(deleted).toEqual({ ok: true, id: "custom-x" });
    expect(legacyAgents.listAgents().length).toBe(4);
  });

  it("校验错误文案逐字（空名/空指令/四种超长边界），两侧互等", () => {
    const cases: [any, string][] = [
      [{ name: "", prompt: "p" }, "智能体名称不能为空"],
      [{ name: "x", prompt: "" }, "智能体指令不能为空"],
      [{ name: "名".repeat(81), prompt: "p" }, "智能体配置超出长度限制"],
      [{ name: "x", prompt: "p", description: "d".repeat(301) }, "智能体配置超出长度限制"],
      [{ name: "x", prompt: "p".repeat(8001) }, "智能体配置超出长度限制"],
      [{ name: "x", prompt: "p", skills: Array.from({ length: 31 }, (_, i) => `s${i}`) }, "智能体配置超出长度限制"],
    ];
    for (const [input, msg] of cases) {
      expect(modernAgents.createAgent(input)).toEqual({ ok: false, error: msg });
      expect(legacyAgents.createAgent(input)).toEqual({ ok: false, error: msg });
    }
    expect(fs.existsSync(AGENTS_FILE)).toBe(false); // 失败不落盘
  });

  it("skills 怪语义保真：对象取 name/null 变 undefined 字面量/数字 String 化/0 与空串过滤", () => {
    const input = { name: "怪语义", prompt: "p", skills: [{ name: " a " }, "b", "", { name: "a" }, null, 42, 0, false] };
    const rm = modernAgents.createAgent(input);
    const rl = legacyAgents.createAgent(input);
    expect(rm.ok).toBe(true);
    expect(rl.ok).toBe(true);
    expect(rm.agent.skills).toEqual(["a", "b", "undefined", "42"]); // null→"undefined" 非空保留（String(null) 先于 filter）
    expect(normalize(rm.agent.skills)).toEqual(normalize(rl.agent.skills));
  });

  it("假内置 id 过滤 + 非法条目丢弃（null/{}/空 id）", () => {
    fs.writeFileSync(AGENTS_FILE, JSON.stringify([{ id: "agent-map", name: "假货" }, { id: "real-1", name: "真货" }, null, {}, { id: "" }]));
    const lm = modernAgents.listAgents();
    const ll = legacyAgents.listAgents();
    expect(normalize(lm)).toEqual(normalize(ll));
    expect(lm.length).toBe(5);
    expect(lm.some((a: any) => a.id === "agent-map" && a.name === "假货")).toBe(false);
    expect(lm[4]!.id).toBe("real-1");
  });

  it("uuid 形态与默认 icon/color；update/delete 防御文案互等", () => {
    const rm = modernAgents.createAgent({ name: "uuid甲", prompt: "p" });
    expect(rm.agent.id).toMatch(/^agent-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(rm.agent.icon).toBe("robot");
    expect(rm.agent.color).toBe("#638e2d");
    const rl = legacyAgents.createAgent({ name: "uuid乙", prompt: "p" });
    expect(rl.agent.id).toMatch(/^agent-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(normalize(modernAgents.updateAgent("agent-map", {}))).toEqual(normalize(legacyAgents.updateAgent("agent-map", {})));
    expect(modernAgents.updateAgent("ghost", {})).toEqual({ ok: false, error: "自定义智能体不存在或内置智能体不可编辑" });
    expect(legacyAgents.updateAgent("ghost", {})).toEqual({ ok: false, error: "自定义智能体不存在或内置智能体不可编辑" });
    expect(modernAgents.deleteAgent("agent-map")).toEqual({ ok: false, error: "内置智能体不可删除" });
    expect(legacyAgents.deleteAgent("agent-map")).toEqual({ ok: false, error: "内置智能体不可删除" });
    expect(modernAgents.deleteAgent("ghost")).toEqual({ ok: false, error: "自定义智能体不存在" });
    expect(legacyAgents.deleteAgent("ghost")).toEqual({ ok: false, error: "自定义智能体不存在" });
  });
});

/* ===== project-trust ===== */

describe("s3-runtime-config-parity project-trust", () => {
  const TMP_TRUST = fs.mkdtempSync(path.join(os.tmpdir(), "s3l13trust-"));

  beforeAll(async () => {
    // OAW_DATA_DIR 在两侧模块加载前注入 → AGENT_DIR = tmp 本身（S3-11 同款技法）
    vi.stubEnv("OAW_DATA_DIR", TMP_TRUST);
    legacyTrust = await import("@legacy-server/project-trust.mjs");
    modernTrust = await import("../src/main/backend/project-trust");
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    try { fs.rmSync(TMP_TRUST, { recursive: true, force: true }); } catch {}
  });

  it("导出面一致（4 项）", () => {
    expect(Object.keys(modernTrust).sort()).toEqual(Object.keys(legacyTrust).sort());
  });

  it("flag off（默认）：setWorkspaceTrust 拒绝写入文案逐字；summary 形态互等且 flagEnabled=false", () => {
    const cwd = path.join(TMP_TRUST, "ws-off");
    for (const side of [modernTrust, legacyTrust]) {
      expect(() => side.setWorkspaceTrust(cwd, true)).toThrow("项目信任写入未启用（OAW_PROJECT_TRUST_GATE=off）");
    }
    const sm = modernTrust.workspaceTrustSummary(cwd);
    const sl = legacyTrust.workspaceTrustSummary(cwd);
    expect(sm).toEqual({ cwd, decision: null, requiresGate: false, flagEnabled: false });
    expect(normalize(sm)).toEqual(normalize(sl));
  });

  it("flag on：三态写入/读取互等（true/false/null），requiresGate 无 .pi 资源为 false", async () => {
    vi.stubEnv("OAW_DATA_DIR", TMP_TRUST);
    vi.stubEnv("OAW_PROJECT_TRUST_GATE", "on");
    vi.resetModules();
    const l2: any = await import("@legacy-server/project-trust.mjs");
    const m2: any = await import("../src/main/backend/project-trust");

    const cwdA = path.join(TMP_TRUST, "ws-accept");
    const cwdB = path.join(TMP_TRUST, "ws-reject");
    const cwdC = path.join(TMP_TRUST, "ws-unknown");
    fs.mkdirSync(cwdA, { recursive: true });
    fs.mkdirSync(cwdB, { recursive: true });

    const setM = m2.setWorkspaceTrust(cwdA, true);
    expect(setM.decision).toBe(true);
    expect(setM.flagEnabled).toBe(true);
    const setL = l2.setWorkspaceTrust(cwdB, "yes"); // trusted === true 严格判定，非 true 一律 false
    expect(setL.decision).toBe(false);
    expect(m2.setWorkspaceTrust(cwdB, 1).decision).toBe(false);

    expect(m2.workspaceTrustDecision(cwdA)).toBe(true);
    expect(l2.workspaceTrustDecision(cwdA)).toBe(true);
    expect(m2.workspaceTrustDecision(cwdB)).toBe(false);
    expect(l2.workspaceTrustDecision(cwdB)).toBe(false);
    expect(m2.workspaceTrustDecision(cwdC)).toBeNull();
    expect(l2.workspaceTrustDecision(cwdC)).toBeNull();

    const sm = m2.workspaceTrustSummary(cwdA);
    expect(sm.requiresGate).toBe(false); // 空工作区无 trust-requiring 资源
    expect(normalize(sm)).toEqual(normalize(l2.workspaceTrustSummary(cwdA)));
    expect(normalize(m2.workspaceTrustSummary(cwdC))).toEqual(normalize(l2.workspaceTrustSummary(cwdC)));

    // 不存在路径：requiresGate 走防御分支 false
    expect(m2.workspaceRequiresTrustGate(path.join(TMP_TRUST, "不存在目录"))).toBe(false);
    expect(normalize(m2.workspaceRequiresTrustGate(cwdA))).toEqual(normalize(l2.workspaceRequiresTrustGate(cwdA)));
    vi.unstubAllEnvs();
  });
});

/* ===== notice ===== */

describe("s3-runtime-config-parity notice", () => {
  const TMP_WS_L = fs.mkdtempSync(path.join(os.tmpdir(), "s3l13ws-l-"));
  const TMP_WS_M = fs.mkdtempSync(path.join(os.tmpdir(), "s3l13ws-m-"));
  const WS_STATE_FILE = path.join(PROJECT_DIR, ".workspace-state.json");
  const STATE_EXISTS = fs.existsSync(WS_STATE_FILE);
  const STATE_BYTES = STATE_EXISTS ? fs.readFileSync(WS_STATE_FILE) : null;
  let JSZip: any;

  async function docXml(file: string): Promise<string> {
    const zip = await JSZip.loadAsync(fs.readFileSync(file));
    return await zip.file("word/document.xml")!.async("text");
  }

  beforeAll(async () => {
    legacyNotice = await import("@legacy-server/notice.mjs");
    modernNotice = await import("../src/main/backend/notice");
    JSZip = (await import("jszip")).default;
    // 两侧各自切换到独立 tmp 工作区（setWorkspace 落 .workspace-state.json，afterAll 恢复原字节）
    expect((await import("@legacy-server/workspace.mjs")).setWorkspace(TMP_WS_L)).toBe(true);
    expect((await import("../src/main/backend/workspace")).setWorkspace(TMP_WS_M)).toBe(true);
  }, 30000);

  afterAll(() => {
    // 恢复项目根 .workspace-state.json 原状（原不存在则删除）
    try {
      if (STATE_EXISTS && STATE_BYTES) fs.writeFileSync(WS_STATE_FILE, STATE_BYTES);
      else if (!STATE_EXISTS) fs.rmSync(WS_STATE_FILE, { force: true });
    } catch {}
    try { fs.rmSync(TMP_WS_L, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(TMP_WS_M, { recursive: true, force: true }); } catch {}
  });

  it("导出面一致（1 项：generateNotice）", () => {
    expect(Object.keys(modernNotice).sort()).toEqual(Object.keys(legacyNotice).sort());
  });

  it("全字段生成：name/absPath 结构互等 + document.xml 全文互等", async () => {
    const p = {
      orgName: "××市交通运输局", title: "专题会议通知", docNo: "×交办函〔2026〕12号",
      recipients: "各区、县交通运输局", intro: "定于近期召开全市交通规划专题会议。",
      items: ["会议时间与地点", "参会单位", "材料准备要求", "联系方式"],
      signer: "××市交通运输局办公室", date: "二〇二六年十月二十四日", filePrefix: "S3L13-A",
    };
    const rm = await modernNotice.generateNotice(p);
    const rl = await legacyNotice.generateNotice(p);
    expect(rl.name).toBe("S3L13-A.docx");
    expect(rm.name).toBe(rl.name);
    expect(rm.absPath).toBe(path.join(TMP_WS_M, rm.name));
    expect(fs.existsSync(rm.absPath)).toBe(true);
    expect(fs.existsSync(rl.absPath)).toBe(true);
    expect(await docXml(rm.absPath)).toBe(await docXml(rl.absPath));
  });

  it("默认值（p=null）：机关/标题/引言/落款/当天日期 + document.xml 互等", async () => {
    const rm = await modernNotice.generateNotice(null);
    const rl = await legacyNotice.generateNotice(null);
    expect(rm.name).toBe("红头会议通知.docx");
    expect(rl.name).toBe(rm.name);
    const xmlM = await docXml(rm.absPath);
    const xmlL = await docXml(rl.absPath);
    expect(xmlM).toBe(xmlL);
    expect(xmlM).toContain("××市人民政府办公室");
    expect(xmlM).toContain("会议通知");
    expect(xmlM).toContain("为深入贯彻落实上级决策部署，经研究决定召开专题会议。现将有关事项通知如下：");
    const now = new Date();
    expect(xmlM).toContain(`${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`);
  });

  it("items 怪语义：对象 String 化/null→'null' 保留/0 与 false 非空字符串化后 truthy 保留/重复不去重", async () => {
    const p = { filePrefix: "S3L13-ITEMS", date: "二〇二六年十月二十四日", items: ["  首项 ", "", { x: 1 }, null, 42, 0, false, "首项"] };
    const rm = await modernNotice.generateNotice(p);
    const rl = await legacyNotice.generateNotice(p);
    expect(rm.name).toBe(rl.name);
    const xmlM = await docXml(rm.absPath);
    expect(xmlM).toBe(await docXml(rl.absPath));
    expect(xmlM).toContain("一、首项");
    expect(xmlM).toContain("二、[object Object]"); // String({x:1})
    expect(xmlM).toContain("三、null"); // String(null)="null" 非空保留
    expect(xmlM).toContain("四、42");
    // filter(Boolean) 作用于 String 化后的字符串："0"/"false" 是非空字符串（truthy）保留，
    // 仅 ""（原始空串 String 化后仍空）被过滤（falsy 语义保真，两侧一致）
    expect(xmlM).toContain("五、0");
    expect(xmlM).toContain("六、false");
    expect(xmlM).toContain("七、首项");
  });

  it("cnNums 溢出：第 11/12 项回退阿拉伯序号", async () => {
    const items = Array.from({ length: 12 }, (_, i) => `事项${i + 1}`);
    const p = { filePrefix: "S3L13-MANY", date: "二〇二六年十月二十四日", items };
    const rm = await modernNotice.generateNotice(p);
    const rl = await legacyNotice.generateNotice(p);
    expect(rm.name).toBe(rl.name);
    const xmlM = await docXml(rm.absPath);
    expect(xmlM).toBe(await docXml(rl.absPath));
    expect(xmlM).toContain("十、事项10");
    expect(xmlM).toContain("11、事项11");
    expect(xmlM).toContain("12、事项12");
  });

  it("docNo 有值/主送顶格/自定义落款 + document.xml 互等", async () => {
    const p = { filePrefix: "S3L13-FIELDS", docNo: "×政办函〔2026〕12号", recipients: "各区、县人民政府", intro: "自定义引言。", signer: "××市规聚会", date: "二〇二六年十月二十四日", items: [] };
    const rm = await modernNotice.generateNotice(p);
    const rl = await legacyNotice.generateNotice(p);
    expect(rm.name).toBe(rl.name);
    const xmlM = await docXml(rm.absPath);
    expect(xmlM).toBe(await docXml(rl.absPath));
    expect(xmlM).toContain("×政办函〔2026〕12号");
    expect(xmlM).toContain("各区、县人民政府");
    expect(xmlM).toContain("××市规聚会");
  });

  it("文件名查重：同名预置后递增（2→3），两侧互等", async () => {
    for (const [tmp, side] of [[TMP_WS_L, legacyNotice], [TMP_WS_M, modernNotice]] as const) {
      fs.writeFileSync(path.join(tmp, "S3L13-DUP.docx"), "占位");
      fs.writeFileSync(path.join(tmp, "S3L13-DUP 2.docx"), "占位");
      const r = await side.generateNotice({ filePrefix: "S3L13-DUP", date: "二〇二六年十月二十四日" });
      expect(r.name).toBe("S3L13-DUP 3.docx");
      expect(fs.existsSync(r.absPath)).toBe(true);
    }
  });
});
