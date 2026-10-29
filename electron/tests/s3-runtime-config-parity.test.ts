/**
 * S3-13 四域运行时配置：backend/{feature-flags,agent-management,project-trust,notice}.ts。
 *
 * R6-6b 对拍退役改写：legacy 物理加载 server/*.mjs 与 modern 静态 import TS 的双侧
 * 互等（导出面/快照/落盘交叉契约/docx 全文逐字）随 server 退役删除——等价性已在
 * S3-13 批对拍验收冻结，改为 TS 侧直接断言（期望值自 TS 源推导硬编码）。
 *
 * 锚定说明：
 *   - feature-flags：RUNTIME_FLAGS 模块加载期读 env → 每用例 vi.stubEnv 控制环境 +
 *     vi.resetModules 重导新实例（S3-12 先例：规避模块级常量缓存不可逆）；
 *     默认态把全部 OAW_ 键 stub 为空，不依赖进程环境洁净度。
 *   - agent-management：OAW_AGENTS_FILE 在模块加载前 stub 注入 tmp（模块加载期常量）。
 *   - project-trust：OAW_DATA_DIR 在模块加载前 stub 注入 tmp（pi-config-management 的
 *     AGENT_DIR 为模块加载期常量，S3-11 先例，AGENT_DIR=tmp 本身）；flag off/on 两期
 *     分别重导（RUNTIME_FLAGS.projectTrustGate 加载期求值）。
 *   - notice：getWorkspace 进程级单值 → setWorkspace 指向独立 tmp 落盘，afterAll 恢复
 *     .workspace-state.json 原字节；docx 产物用 jszip 解包 word/document.xml 断言
 *     内容锚点（document.xml 不含时间戳，core.xml 才有）。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROJECT_DIR } from "../src/main/backend/workspace-paths";

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

// /api/status 下发形态：38 个布尔位 + 3 个数值位（前端 numberFlag() 读取心跳三件套）
const SNAPSHOT_KEYS = [
  "piToolGateExtension", "piBashSidecar", "eventNormalize", "projectTrustGate",
  "cacheWarming", "stagedVisible", "autoTab", "browserBadge", "narrowRestore",
  "reconcileHint", "feedbackV2", "browserAdaptiveStream", "browserFullpage",
  "browserUrlGuard", "agentBusyWatchdog", "resumeAutoRetry", "spatialAnalysis",
  "mapReport", "mapExport", "dataAdapters", "amapMcpBridge", "mapPack",
  "mapTemplates", "mapBookmarks", "replayRecover", "qoderAlign", "qoderSseBackoff",
  "qoderStyle", "qoderSseBackpressure", "qoderDrainOnAbort", "visualEffectsOff",
  "qoderSeqGapAlert", "streamQuota", "eventSchemaCheck", "qoderObjectBar",
  "domainWorkflows", "qoderToolOutputSplit", "qoderInteractionOwner",
  "heartbeatChatMs", "heartbeatEventsMs", "heartbeatBrowserMs",
];

describe("s3-runtime-config feature-flags", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("导出面（2 项：RUNTIME_FLAGS/runtimeFlagsSnapshot），两侧常量均冻结", async () => {
    FLAG_KEYS.forEach((k) => vi.stubEnv(k, ""));
    vi.resetModules();
    const modern = await import("../src/main/backend/feature-flags");
    expect(Object.keys(modern).sort()).toEqual(["RUNTIME_FLAGS", "runtimeFlagsSnapshot"]);
    expect(Object.isFrozen(modern.RUNTIME_FLAGS)).toBe(true);
  });

  it("默认态：RUNTIME_FLAGS 全关 + 数值回退默认 + snapshot 键面全量", async () => {
    FLAG_KEYS.forEach((k) => vi.stubEnv(k, ""));
    vi.resetModules();
    const modern = await import("../src/main/backend/feature-flags");
    expect(Object.keys(modern.runtimeFlagsSnapshot()).sort()).toEqual([...SNAPSHOT_KEYS].sort());
    expect(modern.RUNTIME_FLAGS.projectTrustGate).toBe(false);
    expect(modern.RUNTIME_FLAGS.qoderAlign).toBe(false);
    expect(modern.RUNTIME_FLAGS.heartbeatChatMs).toBe(5000);
    expect(modern.RUNTIME_FLAGS.heartbeatEventsMs).toBe(15000);
    expect(modern.RUNTIME_FLAGS.heartbeatBrowserMs).toBe(15000);
    expect(modern.RUNTIME_FLAGS.browserUrlAllowlist).toEqual([]);
    expect(modern.RUNTIME_FLAGS.piBashSidecarIdleMs).toBe(10 * 60 * 1000);
    expect(modern.RUNTIME_FLAGS.qoderToolOutputFrameMaxBytes).toBe(256 * 1024);
    // snapshot 与 RUNTIME_FLAGS 同源：抽查布尔与数值位
    expect(modern.runtimeFlagsSnapshot().projectTrustGate).toBe(false);
    expect(modern.runtimeFlagsSnapshot().heartbeatChatMs).toBe(5000);
  });

  it("truthy 解析：ON/1/带空白 true/Yes 开；0/off/空 关", async () => {
    vi.stubEnv("OAW_PROJECT_TRUST_GATE", "ON");
    vi.stubEnv("OAW_PI_TOOL_GATE", "1");
    vi.stubEnv("OAW_CACHE_WARMING", " true ");
    vi.stubEnv("OAW_EVENT_NORMALIZE", "Yes");
    vi.stubEnv("OAW_STAGED_VISIBLE", "0");
    vi.stubEnv("OAW_AUTO_TAB", "off");
    vi.stubEnv("OAW_BROWSER_BADGE", "");
    vi.resetModules();
    const modern = await import("../src/main/backend/feature-flags");
    expect(modern.RUNTIME_FLAGS.projectTrustGate).toBe(true);
    expect(modern.RUNTIME_FLAGS.piToolGateExtension).toBe(true);
    expect(modern.RUNTIME_FLAGS.cacheWarming).toBe(true);
    expect(modern.RUNTIME_FLAGS.eventNormalize).toBe(true);
    expect(modern.RUNTIME_FLAGS.stagedVisible).toBe(false);
    expect(modern.RUNTIME_FLAGS.autoTab).toBe(false);
    expect(modern.RUNTIME_FLAGS.browserBadge).toBe(false);
  });

  it("qoderAlign 总开关联动整族；单开 qoderStyle 不联动族内其他位", async () => {
    FLAG_KEYS.forEach((k) => vi.stubEnv(k, ""));
    vi.stubEnv("OAW_QODER_ALIGN", "on");
    vi.resetModules();
    const a = await import("../src/main/backend/feature-flags");
    const family = ["qoderSseBackoff", "qoderStyle", "qoderSseBackpressure", "qoderDrainOnAbort", "qoderSeqGapAlert", "streamQuota", "eventSchemaCheck", "qoderObjectBar", "domainWorkflows", "qoderToolOutputSplit", "qoderInteractionOwner"];
    expect(a.RUNTIME_FLAGS.qoderAlign).toBe(true);
    family.forEach((k) => expect((a.RUNTIME_FLAGS as any)[k]).toBe(true));

    vi.stubEnv("OAW_QODER_ALIGN", "");
    vi.stubEnv("OAW_QODER_STYLE", "on");
    vi.resetModules();
    const b = await import("../src/main/backend/feature-flags");
    expect(b.RUNTIME_FLAGS.qoderStyle).toBe(true);
    expect(b.RUNTIME_FLAGS.qoderAlign).toBe(false);
    expect(b.RUNTIME_FLAGS.qoderSseBackoff).toBe(false);
    expect(b.RUNTIME_FLAGS.domainWorkflows).toBe(false);
  });

  it("readPositiveInt 边界：0/负数/非数字回退 fallback；合法值生效", async () => {
    vi.stubEnv("OAW_HEARTBEAT_CHAT_MS", "0");
    vi.stubEnv("OAW_BUSY_WATCHDOG_MS", "-3");
    vi.stubEnv("OAW_QODER_DRAIN_MAX_MS", "abc");
    vi.stubEnv("OAW_HEARTBEAT_EVENTS_MS", "2500");
    vi.stubEnv("OAW_QODER_TOOL_OUTPUT_FRAME_MAX_BYTES", "999999");
    vi.stubEnv("OAW_STREAM_QUOTA_RETRY_AFTER_S", "12");
    vi.resetModules();
    const modern = await import("../src/main/backend/feature-flags");
    expect(modern.RUNTIME_FLAGS.heartbeatChatMs).toBe(5000);
    expect(modern.RUNTIME_FLAGS.agentBusyWatchdogMs).toBe(15 * 60 * 1000);
    expect(modern.RUNTIME_FLAGS.qoderDrainMaxMs).toBe(1500);
    expect(modern.RUNTIME_FLAGS.heartbeatEventsMs).toBe(2500);
    expect(modern.RUNTIME_FLAGS.qoderToolOutputFrameMaxBytes).toBe(999999);
    expect(modern.RUNTIME_FLAGS.streamQuotaRetryAfterSeconds).toBe(12);
  });

  it("readStringList：多分隔符 + trim + 小写化 + 空段过滤", async () => {
    vi.stubEnv("OAW_BROWSER_URL_ALLOWLIST", " Example.COM，b.org;C.Net  d ，； e ");
    vi.resetModules();
    const modern = await import("../src/main/backend/feature-flags");
    expect(modern.RUNTIME_FLAGS.browserUrlAllowlist).toEqual(["example.com", "b.org", "c.net", "d", "e"]);
  });
});

/* ===== agent-management ===== */

describe("s3-runtime-config agent-management", () => {
  const TMP_AG = fs.mkdtempSync(path.join(os.tmpdir(), "s3l13ag-"));
  const AGENTS_FILE = path.join(TMP_AG, "agents.json");
  let agents: any;

  beforeAll(async () => {
    // OAW_AGENTS_FILE 在模块加载前注入（AGENTS_FILE 为模块加载期常量）
    vi.stubEnv("OAW_AGENTS_FILE", AGENTS_FILE);
    agents = await import("../src/main/backend/agent-management");
  });

  afterEach(() => {
    try { fs.rmSync(AGENTS_FILE, { force: true }); } catch {}
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    try { fs.rmSync(TMP_AG, { recursive: true, force: true }); } catch {}
  });

  it("导出面（5 项）+ BUILTIN_AGENTS 4 内置（id 锚点）+ 数组冻结", () => {
    expect(Object.keys(agents).sort()).toEqual(["BUILTIN_AGENTS", "createAgent", "deleteAgent", "listAgents", "updateAgent"]);
    expect(agents.BUILTIN_AGENTS.map((a: any) => a.id)).toEqual(["agent-gongwen", "agent-map", "agent-review", "agent-data"]);
    expect(agents.BUILTIN_AGENTS.length).toBe(4);
    expect(Object.isFrozen(agents.BUILTIN_AGENTS)).toBe(true);
  });

  it("文件不存在：listAgents 返回 4 内置的展开副本，不污染内置单例", () => {
    const list = agents.listAgents();
    expect(list.length).toBe(4);
    list[0]!.name = "副本改动";
    expect(agents.BUILTIN_AGENTS[0].name).not.toBe("副本改动");
    expect(agents.listAgents().length).toBe(4);
  });

  it("CRUD 全链：create → list 落盘 → update（previous 继承）→ delete", () => {
    const created = agents.createAgent({ id: "custom-x", name: "交叉甲", description: "描述甲", prompt: "指令甲", skills: ["a", "b"], icon: "xls", color: "#123456" });
    expect(created.ok).toBe(true);
    expect(created.agent.builtin).toBe(false);
    expect(created.agent.id).toBe("custom-x");
    expect(/^\d{4}-\d{2}-\d{2}T/.test(created.agent.updatedAt)).toBe(true);
    expect(fs.existsSync(AGENTS_FILE)).toBe(true);

    const list = agents.listAgents();
    expect(list.length).toBe(5);
    expect(list[4]).toEqual(created.agent);

    const updated = agents.updateAgent("custom-x", { name: "交叉改名" });
    expect(updated.ok).toBe(true);
    expect(updated.agent.name).toBe("交叉改名");
    expect(updated.agent.prompt).toBe("指令甲"); // previous 继承
    expect(updated.agent.skills).toEqual(["a", "b"]);
    expect(updated.agent.icon).toBe("xls");
    expect(updated.agent.color).toBe("#123456");
    expect(agents.listAgents().some((a: any) => a.name === "交叉改名")).toBe(true);

    const deleted = agents.deleteAgent("custom-x");
    expect(deleted).toEqual({ ok: true, id: "custom-x" });
    expect(agents.listAgents().length).toBe(4);
  });

  it("校验错误文案逐字（空名/空指令/四种超长边界）", () => {
    const cases: [any, string][] = [
      [{ name: "", prompt: "p" }, "智能体名称不能为空"],
      [{ name: "x", prompt: "" }, "智能体指令不能为空"],
      [{ name: "名".repeat(81), prompt: "p" }, "智能体配置超出长度限制"],
      [{ name: "x", prompt: "p", description: "d".repeat(301) }, "智能体配置超出长度限制"],
      [{ name: "x", prompt: "p".repeat(8001) }, "智能体配置超出长度限制"],
      [{ name: "x", prompt: "p", skills: Array.from({ length: 31 }, (_, i) => `s${i}`) }, "智能体配置超出长度限制"],
    ];
    for (const [input, msg] of cases) {
      expect(agents.createAgent(input)).toEqual({ ok: false, error: msg });
    }
    expect(fs.existsSync(AGENTS_FILE)).toBe(false); // 失败不落盘
  });

  it("skills 怪语义保真：对象取 name/null 变 undefined 字面量/数字 String 化/0 与空串过滤", () => {
    const input = { name: "怪语义", prompt: "p", skills: [{ name: " a " }, "b", "", { name: "a" }, null, 42, 0, false] };
    const r = agents.createAgent(input);
    expect(r.ok).toBe(true);
    expect(r.agent.skills).toEqual(["a", "b", "undefined", "42"]); // null→"undefined" 非空保留（String(null) 先于 filter）
  });

  it("假内置 id 过滤 + 非法条目丢弃（null/{}/空 id）", () => {
    fs.writeFileSync(AGENTS_FILE, JSON.stringify([{ id: "agent-map", name: "假货" }, { id: "real-1", name: "真货" }, null, {}, { id: "" }]));
    const list = agents.listAgents();
    expect(list.length).toBe(5);
    expect(list.some((a: any) => a.id === "agent-map" && a.name === "假货")).toBe(false);
    expect(list[4]!.id).toBe("real-1");
  });

  it("uuid 形态与默认 icon/color；update/delete 防御文案逐字", () => {
    const r = agents.createAgent({ name: "uuid甲", prompt: "p" });
    expect(r.agent.id).toMatch(/^agent-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(r.agent.icon).toBe("robot");
    expect(r.agent.color).toBe("#638e2d");
    expect(agents.updateAgent("ghost", {})).toEqual({ ok: false, error: "自定义智能体不存在或内置智能体不可编辑" });
    expect(agents.deleteAgent("agent-map")).toEqual({ ok: false, error: "内置智能体不可删除" });
    expect(agents.deleteAgent("ghost")).toEqual({ ok: false, error: "自定义智能体不存在" });
  });
});

/* ===== project-trust ===== */

describe("s3-runtime-config project-trust", () => {
  const TMP_TRUST = fs.mkdtempSync(path.join(os.tmpdir(), "s3l13trust-"));

  beforeAll(async () => {
    // OAW_DATA_DIR 在模块加载前注入 → AGENT_DIR = tmp 本身（S3-11 同款技法）
    vi.stubEnv("OAW_DATA_DIR", TMP_TRUST);
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    try { fs.rmSync(TMP_TRUST, { recursive: true, force: true }); } catch {}
  });

  // timeout 20s：动态 import project-trust → pi-config-management 依赖链在
  // 全量并发满载下可拖过默认 5s（基线 flake 家族）。
  it("导出面（4 项）", async () => {
    const trust = await import("../src/main/backend/project-trust");
    expect(Object.keys(trust).sort()).toEqual(["setWorkspaceTrust", "workspaceRequiresTrustGate", "workspaceTrustDecision", "workspaceTrustSummary"]);
  }, 20000);

  it("flag off（默认）：setWorkspaceTrust 拒绝写入文案逐字；summary flagEnabled=false", async () => {
    const trust = await import("../src/main/backend/project-trust");
    const cwd = path.join(TMP_TRUST, "ws-off");
    expect(() => trust.setWorkspaceTrust(cwd, true)).toThrow("项目信任写入未启用（OAW_PROJECT_TRUST_GATE=off）");
    expect(trust.workspaceTrustSummary(cwd)).toEqual({ cwd, decision: null, requiresGate: false, flagEnabled: false });
  }, 20000);

  it("flag on：三态写入/读取（true/false/null），requiresGate 无 .pi 资源为 false", async () => {
    vi.stubEnv("OAW_DATA_DIR", TMP_TRUST);
    vi.stubEnv("OAW_PROJECT_TRUST_GATE", "on");
    vi.resetModules();
    const trust: any = await import("../src/main/backend/project-trust");

    const cwdA = path.join(TMP_TRUST, "ws-accept");
    const cwdB = path.join(TMP_TRUST, "ws-reject");
    const cwdC = path.join(TMP_TRUST, "ws-unknown");
    fs.mkdirSync(cwdA, { recursive: true });
    fs.mkdirSync(cwdB, { recursive: true });

    const setM = trust.setWorkspaceTrust(cwdA, true);
    expect(setM.decision).toBe(true);
    expect(setM.flagEnabled).toBe(true);
    expect(trust.setWorkspaceTrust(cwdB, "yes").decision).toBe(false); // trusted === true 严格判定，非 true 一律 false
    expect(trust.setWorkspaceTrust(cwdB, 1).decision).toBe(false);

    expect(trust.workspaceTrustDecision(cwdA)).toBe(true);
    expect(trust.workspaceTrustDecision(cwdB)).toBe(false);
    expect(trust.workspaceTrustDecision(cwdC)).toBeNull();

    const sm = trust.workspaceTrustSummary(cwdA);
    expect(sm.requiresGate).toBe(false); // 空工作区无 trust-requiring 资源
    expect(sm.flagEnabled).toBe(true);
    expect(sm.decision).toBe(true);

    // 不存在路径：requiresGate 走防御分支 false
    expect(trust.workspaceRequiresTrustGate(path.join(TMP_TRUST, "不存在目录"))).toBe(false);
    vi.unstubAllEnvs();
  }, 20000);
});

/* ===== notice ===== */

describe("s3-runtime-config notice", () => {
  const TMP_WS = fs.mkdtempSync(path.join(os.tmpdir(), "s3l13ws-"));
  const WS_STATE_FILE = path.join(PROJECT_DIR, ".workspace-state.json");
  const STATE_EXISTS = fs.existsSync(WS_STATE_FILE);
  const STATE_BYTES = STATE_EXISTS ? fs.readFileSync(WS_STATE_FILE) : null;
  let JSZip: any;
  let notice: any;

  async function docXml(file: string): Promise<string> {
    const zip = await JSZip.loadAsync(fs.readFileSync(file));
    return await zip.file("word/document.xml")!.async("text");
  }

  beforeAll(async () => {
    notice = await import("../src/main/backend/notice");
    JSZip = (await import("jszip")).default;
    // 切换到独立 tmp 工作区（setWorkspace 落 .workspace-state.json，afterAll 恢复原字节）
    expect((await import("../src/main/backend/workspace")).setWorkspace(TMP_WS)).toBe(true);
  }, 30000);

  afterAll(() => {
    // 恢复项目根 .workspace-state.json 原状（原不存在则删除）
    try {
      if (STATE_EXISTS && STATE_BYTES) fs.writeFileSync(WS_STATE_FILE, STATE_BYTES);
      else if (!STATE_EXISTS) fs.rmSync(WS_STATE_FILE, { force: true });
    } catch {}
    try { fs.rmSync(TMP_WS, { recursive: true, force: true }); } catch {}
  });

  it("导出面（1 项：generateNotice）", () => {
    expect(Object.keys(notice).sort()).toEqual(["generateNotice"]);
  });

  it("全字段生成：name/absPath 结构 + document.xml 内容锚点", async () => {
    const p = {
      orgName: "××市交通运输局", title: "专题会议通知", docNo: "×交办函〔2026〕12号",
      recipients: "各区、县交通运输局", intro: "定于近期召开全市交通规划专题会议。",
      items: ["会议时间与地点", "参会单位", "材料准备要求", "联系方式"],
      signer: "××市交通运输局办公室", date: "二〇二六年十月二十四日", filePrefix: "S3L13-A",
    };
    const r = await notice.generateNotice(p);
    expect(r.name).toBe("S3L13-A.docx");
    expect(r.absPath).toBe(path.join(TMP_WS, r.name));
    expect(fs.existsSync(r.absPath)).toBe(true);
    const xml = await docXml(r.absPath);
    expect(xml).toContain("××市交通运输局");
    expect(xml).toContain("专题会议通知");
    expect(xml).toContain("×交办函〔2026〕12号");
    expect(xml).toContain("各区、县交通运输局");
    expect(xml).toContain("定于近期召开全市交通规划专题会议。");
    expect(xml).toContain("一、会议时间与地点");
    expect(xml).toContain("四、联系方式");
    expect(xml).toContain("××市交通运输局办公室");
    expect(xml).toContain("二〇二六年十月二十四日");
  });

  it("默认值（p=null）：机关/标题/引言/落款/当天日期", async () => {
    const r = await notice.generateNotice(null);
    expect(r.name).toBe("红头会议通知.docx");
    const xml = await docXml(r.absPath);
    expect(xml).toContain("××市人民政府办公室");
    expect(xml).toContain("会议通知");
    expect(xml).toContain("为深入贯彻落实上级决策部署，经研究决定召开专题会议。现将有关事项通知如下：");
    const now = new Date();
    expect(xml).toContain(`${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`);
  });

  it("items 怪语义：对象 String 化/null→'null' 保留/0 与 false 非空字符串化后 truthy 保留/重复不去重", async () => {
    const p = { filePrefix: "S3L13-ITEMS", date: "二〇二六年十月二十四日", items: ["  首项 ", "", { x: 1 }, null, 42, 0, false, "首项"] };
    const r = await notice.generateNotice(p);
    const xml = await docXml(r.absPath);
    expect(xml).toContain("一、首项");
    expect(xml).toContain("二、[object Object]"); // String({x:1})
    expect(xml).toContain("三、null"); // String(null)="null" 非空保留
    expect(xml).toContain("四、42");
    // filter(Boolean) 作用于 String 化后的字符串："0"/"false" 是非空字符串（truthy）保留，
    // 仅 ""（原始空串 String 化后仍空）被过滤（falsy 语义保真）
    expect(xml).toContain("五、0");
    expect(xml).toContain("六、false");
    expect(xml).toContain("七、首项");
  });

  it("cnNums 溢出：第 11/12 项回退阿拉伯序号", async () => {
    const items = Array.from({ length: 12 }, (_, i) => `事项${i + 1}`);
    const p = { filePrefix: "S3L13-MANY", date: "二〇二六年十月二十四日", items };
    const r = await notice.generateNotice(p);
    const xml = await docXml(r.absPath);
    expect(xml).toContain("十、事项10");
    expect(xml).toContain("11、事项11");
    expect(xml).toContain("12、事项12");
  });

  it("docNo 有值/主送顶格/自定义落款", async () => {
    const p = { filePrefix: "S3L13-FIELDS", docNo: "×政办函〔2026〕12号", recipients: "各区、县人民政府", intro: "自定义引言。", signer: "××市规聚会", date: "二〇二六年十月二十四日", items: [] };
    const r = await notice.generateNotice(p);
    const xml = await docXml(r.absPath);
    expect(xml).toContain("×政办函〔2026〕12号");
    expect(xml).toContain("各区、县人民政府");
    expect(xml).toContain("××市规聚会");
  });

  it("文件名查重：同名预置后递增（2→3）", async () => {
    fs.writeFileSync(path.join(TMP_WS, "S3L13-DUP.docx"), "占位");
    fs.writeFileSync(path.join(TMP_WS, "S3L13-DUP 2.docx"), "占位");
    const r = await notice.generateNotice({ filePrefix: "S3L13-DUP", date: "二〇二六年十月二十四日" });
    expect(r.name).toBe("S3L13-DUP 3.docx");
    expect(fs.existsSync(r.absPath)).toBe(true);
  });
});
