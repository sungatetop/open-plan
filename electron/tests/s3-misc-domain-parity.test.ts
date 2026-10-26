/**
 * S3-12 零依赖六域批对拍：legacy 物理加载 server/{workflow-registry,workflow-validation,
 * connectors,cambodia-od,map-demo,batch-export}.mjs vs modern 静态 import TS backend/{同名}.ts。
 *
 * 锚定说明：
 *   - 六域消费面全在旧 index.mjs 路由（workflow-registry L2541/L2566、workflow-validation
 *     L2567、batch-export L5318 动态 import；connectors L28 / cambodia-od L14 / map-demo
 *     L15 静态 import），TS 侧零换绑（纯域落地，S3-11 同款）。
 *   - workflow-registry：懒加载缓存为模块级 Promise——空目录（基线真实态）用 beforeAll
 *     实例；声明文件加载路径用 vi.resetModules + 临时写 server/工作流 目录取新实例
 *     （缓存拒绝态不可逆，非法/重复用例各自新实例）；目录 finally 清理。
 *   - connectors：状态文件 <项目根>/.oaw/connectors.json 基线不存在，用例写真实文件、
 *     finally 复原（原不存在则删除）；beginConnectorAuth 的 state 为随机 UUID，只比形态。
 *   - cambodia-od：数据为外部素材不进仓库——CAMBODIA_OD_FILE stub 注入 tmp fixture
 *     （dataFile() 每次调用读 env，无模块加载期常量约束）。
 *   - workflow-validation：getWorkspace 双侧同锚（workspace-state.json 同逻辑恢复，
 *     B6-4 对拍已锁），默认根分支只断言双侧互等不断言具体路径。
 *   - map-demo / batch-export：零依赖纯函数，全形态矩阵双侧互等。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROJECT_DIR } from "../src/main/backend/workspace-paths";

// legacy 侧经 any 载体调用：旧 .mjs 无类型标注，tsc 对解构默认值/可选属性的推断局限
// 直接传参会误报（S3-10 先例）。
let legacy: any;
let modern: any;

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "s3l12misc-"));
const CONNECTORS_FILE = path.join(PROJECT_DIR, ".oaw", "connectors.json");
const CONNECTORS_FILE_EXISTS_BEFORE = fs.existsSync(CONNECTORS_FILE);
const WORKFLOW_DIR = path.join(PROJECT_DIR, "server", "工作流");
const WORKFLOW_DIR_EXISTS_BEFORE = fs.existsSync(WORKFLOW_DIR);

const VALID_DECLARATION = {
  id: "od-demand-analysis",
  title: "OD 需求分析",
  description: "演示声明",
  budget: { maxTurns: 12, maxToolCalls: 40, maxWallMs: 600000 },
  tools: ["map_analysis", "officecli"],
  preflight: ["geoRange", "artifactRoot"],
  stages: [{ id: "s1", title: "准备" }, { id: "s2", title: "执行", approval: true }],
  artifacts: [{ id: "a1", title: "OD 矩阵", kind: "table", required: true }],
};

function normalize<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

beforeAll(async () => {
  legacy = {
    registry: await import("@legacy-server/workflow-registry.mjs"),
    validation: await import("@legacy-server/workflow-validation.mjs"),
    connectors: await import("@legacy-server/connectors.mjs"),
    cambodia: await import("@legacy-server/cambodia-od.mjs"),
    mapDemo: await import("@legacy-server/map-demo.mjs"),
    batchExport: await import("@legacy-server/batch-export.mjs"),
  };
  modern = {
    registry: await import("../src/main/backend/workflow-registry"),
    validation: await import("../src/main/backend/workflow-validation"),
    connectors: await import("../src/main/backend/connectors"),
    cambodia: await import("../src/main/backend/cambodia-od"),
    mapDemo: await import("../src/main/backend/map-demo"),
    batchExport: await import("../src/main/backend/batch-export"),
  };
});

afterAll(() => {
  if (!CONNECTORS_FILE_EXISTS_BEFORE) {
    try { fs.rmSync(CONNECTORS_FILE, { force: true }); } catch {}
  }
  vi.unstubAllEnvs();
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
});

describe("s3-misc-domain-parity workflow-registry", () => {
  it("导出面一致（6 项）+ 常量互等", () => {
    expect(Object.keys(modern.registry).sort()).toEqual(Object.keys(legacy.registry).sort());
    expect(normalize(modern.registry.已知预检项)).toEqual(normalize(legacy.registry.已知预检项));
    expect(normalize(modern.registry.已知产物类型)).toEqual(normalize(legacy.registry.已知产物类型));
    expect(modern.registry.已知预检项).toEqual(["geoRange", "recordCount", "writeBackGuard", "artifactRoot"]);
  });

  it("空目录（基线真实态）：懒加载空表 + 概览 + 未命中 null，双侧互等", async () => {
    expect(WORKFLOW_DIR_EXISTS_BEFORE).toBe(false);
    const listM = await modern.registry.列出工作流();
    const listL = await legacy.registry.列出工作流();
    expect(normalize(listM)).toEqual(normalize(listL));
    expect(listM).toEqual([]);
    const missM = await modern.registry.取工作流("od-demand-analysis");
    expect(missM).toBeNull();
    expect(normalize(missM)).toEqual(normalize(await legacy.registry.取工作流("od-demand-analysis")));
    const overviewM = await modern.registry.注册表概览();
    const overviewL = await legacy.registry.注册表概览();
    expect(normalize(overviewM)).toEqual(normalize(overviewL));
    expect(overviewM).toEqual({ total: 0, ids: [], 已知预检项: ["geoRange", "recordCount", "writeBackGuard", "artifactRoot"], 声明文件目录: "server/workflows" });
  });

  it("校验工作流：全形态矩阵（结构/预算/工具去重/预检项/阶段/产物）双侧互等", () => {
    const cases: [string, any][] = [
      ["null", null],
      ["string", "not-object"],
      ["array", []],
      ["缺id", { ...VALID_DECLARATION, id: "" }],
      ["id形态非法", { ...VALID_DECLARATION, id: "OD_X" }],
      ["缺title", { ...VALID_DECLARATION, title: "  " }],
      ["缺description", { ...VALID_DECLARATION, description: null }],
      ["缺budget", { ...VALID_DECLARATION, budget: null }],
      ["budget非正整数", { ...VALID_DECLARATION, budget: { maxTurns: 0, maxToolCalls: 1.5, maxWallMs: "12" } }],
      ["tools空", { ...VALID_DECLARATION, tools: [] }],
      ["tools重复", { ...VALID_DECLARATION, tools: ["a", "a"] }],
      ["tools空名", { ...VALID_DECLARATION, tools: ["a", "  ", 123] }],
      ["preflight非数组", { ...VALID_DECLARATION, preflight: "geoRange" }],
      ["preflight未知项", { ...VALID_DECLARATION, preflight: ["geoRange", "bogus"] }],
      ["stages空", { ...VALID_DECLARATION, stages: [] }],
      ["stages重复", { ...VALID_DECLARATION, stages: [{ id: "s1", title: "a" }, { id: "s1", title: "b" }] }],
      ["stages缺title", { ...VALID_DECLARATION, stages: [{ id: "s1" }] }],
      ["stages审批非布尔", { ...VALID_DECLARATION, stages: [{ id: "s1", title: "a", approval: "yes" }] }],
      ["artifacts空", { ...VALID_DECLARATION, artifacts: [] }],
      ["artifacts重复", { ...VALID_DECLARATION, artifacts: [{ id: "a1", title: "x", kind: "table", required: true }, { id: "a1", title: "y", kind: "table", required: false }] }],
      ["artifacts缺title", { ...VALID_DECLARATION, artifacts: [{ id: "a1", kind: "table", required: true }] }],
      ["artifacts未知kind", { ...VALID_DECLARATION, artifacts: [{ id: "a1", title: "x", kind: "video", required: true }] }],
      ["artifacts required非布尔", { ...VALID_DECLARATION, artifacts: [{ id: "a1", title: "x", kind: "table", required: 1 }] }],
      ["合法全量", VALID_DECLARATION],
    ];
    for (const [name, declaration] of cases) {
      const m = modern.registry.校验工作流(declaration);
      const l = legacy.registry.校验工作流(declaration);
      expect(normalize(m), name).toEqual(normalize(l));
    }
    expect(modern.registry.校验工作流(null)).toEqual({ ok: false, 错误: ["声明必须是对象"], 声明: null });
    const ok = modern.registry.校验工作流(VALID_DECLARATION);
    expect(ok.ok).toBe(true);
    expect(ok.错误).toEqual([]);
    expect(ok.声明).toBe(VALID_DECLARATION); // 通过时原样返回（同一引用）
  });

  it("声明文件加载：合法声明冻结入表（含 文件 字段）+ 概览/按 id 取用互等", async () => {
    vi.resetModules();
    fs.mkdirSync(WORKFLOW_DIR, { recursive: true });
    try {
      fs.writeFileSync(path.join(WORKFLOW_DIR, "10-od.mjs"), `export default ${JSON.stringify(VALID_DECLARATION)};\n`, "utf8");
      const freshLegacy: any = await import("@legacy-server/workflow-registry.mjs");
      const freshModern: any = await import("../src/main/backend/workflow-registry");
      const listM = await freshModern.列出工作流();
      const listL = await freshLegacy.列出工作流();
      expect(normalize(listM)).toEqual(normalize(listL));
      expect(listM).toHaveLength(1);
      expect(listM[0]).toMatchObject({ id: "od-demand-analysis", 文件: "10-od.mjs" });
      const hitM = await freshModern.取工作流("od-demand-analysis");
      const hitL = await freshLegacy.取工作流("od-demand-analysis");
      expect(normalize(hitM)).toEqual(normalize(hitL));
      expect(hitM.id).toBe("od-demand-analysis");
      const overviewM = await freshModern.注册表概览();
      const overviewL = await freshLegacy.注册表概览();
      expect(normalize(overviewM)).toEqual(normalize(overviewL));
      expect(overviewM.ids).toEqual(["od-demand-analysis"]);
      expect(overviewM.total).toBe(1);
    } finally {
      fs.rmSync(WORKFLOW_DIR, { recursive: true, force: true });
    }
    expect(fs.existsSync(WORKFLOW_DIR)).toBe(false);
  });

  it("声明非法 → 懒加载报错文案逐字（声明非法（文件名）：错误 join；）", async () => {
    vi.resetModules();
    fs.mkdirSync(WORKFLOW_DIR, { recursive: true });
    try {
      fs.writeFileSync(path.join(WORKFLOW_DIR, "bad.mjs"), "export default { id: \"x\" };\n", "utf8");
      const freshLegacy: any = await import("@legacy-server/workflow-registry.mjs");
      const freshModern: any = await import("../src/main/backend/workflow-registry");
      const msgM = await freshModern.列出工作流().then(() => "", (e: any) => e.message);
      const msgL = await freshLegacy.列出工作流().then(() => "", (e: any) => e.message);
      expect(msgM).toBe(msgL);
      expect(msgM).toBe("工作流声明非法（bad.mjs）：缺少 title；缺少 description；缺少 budget；tools 必须是非空数组；preflight 必须是数组；stages 必须是非空数组；artifacts 必须是非空数组");
    } finally {
      fs.rmSync(WORKFLOW_DIR, { recursive: true, force: true });
    }
  });

  it("声明 id 重复 → 报错文案逐字", async () => {
    vi.resetModules();
    fs.mkdirSync(WORKFLOW_DIR, { recursive: true });
    try {
      const body = `export default ${JSON.stringify(VALID_DECLARATION)};\n`;
      fs.writeFileSync(path.join(WORKFLOW_DIR, "a.mjs"), body, "utf8");
      fs.writeFileSync(path.join(WORKFLOW_DIR, "b.mjs"), body, "utf8");
      const freshLegacy: any = await import("@legacy-server/workflow-registry.mjs");
      const freshModern: any = await import("../src/main/backend/workflow-registry");
      const msgM = await freshModern.列出工作流().then(() => "", (e: any) => e.message);
      const msgL = await freshLegacy.列出工作流().then(() => "", (e: any) => e.message);
      expect(msgM).toBe(msgL);
      expect(msgM).toBe("工作流 id 重复：od-demand-analysis");
    } finally {
      fs.rmSync(WORKFLOW_DIR, { recursive: true, force: true });
    }
  });
});

describe("s3-misc-domain-parity workflow-validation", () => {
  it("导出面一致（9 项）+ 范围常量互等", () => {
    expect(Object.keys(modern.validation).sort()).toEqual(Object.keys(legacy.validation).sort());
    expect(normalize(modern.validation.经度范围)).toEqual(normalize(legacy.validation.经度范围));
    expect(normalize(modern.validation.纬度范围)).toEqual(normalize(legacy.validation.纬度范围));
    expect(modern.validation.经度范围).toEqual([73, 135]);
    expect(modern.validation.纬度范围).toEqual([18, 54]);
  });

  it("检查坐标范围：缺失/越界（经/纬）/边界贴齐/别名形态/自定义范围/空集，双侧互等", () => {
    const cases: [string, any, any][] = [
      ["空集", [], {}],
      ["合法点", [[120, 30], { 经度: 120.5, 纬度: 30.5 }, { lon: 119, lat: 29 }, { lng: 134.9, latitude: 53.9 }], {}],
      ["经度越界", [[72.9, 30], [135.1, 30]], {}],
      ["纬度越界", [[120, 17.9], [120, 54.1]], {}],
      ["边界贴齐", [[73, 18], [135, 54]], {}],
      ["坐标缺失", [[null, 30], ["x", "y"], {}, undefined], {}],
      ["自定义范围", [[100, 30], [90, 30]], { 经度范围: [95, 105], 纬度范围: [20, 40] }],
      ["非数组入参", "not-array", {}],
    ];
    for (const [name, points, options] of cases) {
      const m = modern.validation.检查坐标范围(points, options);
      const l = legacy.validation.检查坐标范围(points, options);
      expect(normalize(m), name).toEqual(normalize(l));
    }
    const hit = modern.validation.检查坐标范围([[72.9, 30]]);
    expect(hit.ok).toBe(false);
    expect(hit.检查项).toBe("geoRange");
    expect(hit.事件类型).toBe("geo_out_of_range");
    expect(hit.违规[0]).toEqual({ 索引: 0, 经度: 72.9, 纬度: 30, 原因: "经度超出 73–135°E" });
    expect(hit.统计).toEqual({ 总数: 1, 越界数: 1 });
    expect(modern.validation.检查坐标范围([]).摘要).toBe("无坐标数据，跳过范围检查");
  });

  it("检查记录数：缺失/零/不一致/一致，双侧互等", () => {
    const cases: [string, any][] = [
      ["缺失", {}],
      ["非数值", { 声明数: "x", 实际数: 3 }],
      ["零记录", { 声明数: 5, 实际数: 0 }],
      ["负数", { 声明数: 5, 实际数: -1 }],
      ["不一致", { 声明数: 5, 实际数: 4 }],
      ["一致", { 声明数: 5, 实际数: 5 }],
      ["自定义名称", { 声明数: 2, 实际数: 2, 名称: "OD 矩阵" }],
      ["小数相等", { 声明数: 3.0, 实际数: "3.0" }],
    ];
    for (const [name, input] of cases) {
      const m = modern.validation.检查记录数(input);
      const l = legacy.validation.检查记录数(input);
      expect(normalize(m), name).toEqual(normalize(l));
    }
    expect(modern.validation.检查记录数({ 声明数: 5, 实际数: 4 }).事件类型).toBe("data_integrity_failed");
    expect(modern.validation.检查记录数({ 声明数: 5, 实际数: 4 }).违规).toEqual([{ 原因: "记录数不一致：声明 5 / 实际 4" }]);
    expect(modern.validation.检查记录数({ 声明数: 5, 实际数: 5 }).摘要).toBe("记录集 记录数一致（5）");
    expect(modern.validation.检查记录数({ 声明数: 2, 实际数: 2, 名称: "OD 矩阵" }).摘要).toBe("OD 矩阵 记录数一致（2）");
  });

  it("检查写回保护：写回类未确认/已确认/非写回/空名，双侧互等", () => {
    const cases: [string, any][] = [
      ["officecli未确认", { 工具: "officecli" }],
      ["officecli已确认", { 工具: "officecli", 已确认: true }],
      ["带空白", { 工具: "  edit  " }],
      ["非写回", { 工具: "map_analysis" }],
      ["空名", {}],
      ["目标透传", { 工具: "write", 已确认: false, 目标: "报告.docx" }],
    ];
    for (const [name, input] of cases) {
      const m = modern.validation.检查写回保护(input);
      const l = legacy.validation.检查写回保护(input);
      expect(normalize(m), name).toEqual(normalize(l));
    }
    const blocked = modern.validation.检查写回保护({ 工具: "map_import", 目标: "a.map" });
    expect(blocked.事件类型).toBe("review_waiting_confirmation");
    expect(blocked.违规).toEqual([{ 原因: "写回工具 map_import 未经用户确认", 工具: "map_import", 目标: "a.map" }]);
    expect(blocked.摘要).toBe("写回待确认（map_import），已阻断");
    expect(modern.validation.检查写回保护({}).摘要).toBe("工具 ? 非写回类，无需确认");
  });

  it("检查产物根：缺失路径/tmp 根内外/默认工作区根（双侧互等，不断言具体路径）", () => {
    const inside = path.join(TMP_DIR, "out", "a.png");
    const outside = path.join(os.tmpdir(), "definitely-outside-s3l12.png");
    const cases: [string, any, any][] = [
      ["缺失路径", "", { 产物根目录: TMP_DIR }],
      ["根内", inside, { 产物根目录: TMP_DIR }],
      ["根外", outside, { 产物根目录: TMP_DIR }],
      ["相对路径按根解析", "sub/dir/report.docx", { 产物根目录: TMP_DIR }],
      ["根为空串", "x.png", { 产物根目录: "" }],
    ];
    for (const [name, target, options] of cases) {
      const m = modern.validation.检查产物根(target, options);
      const l = legacy.validation.检查产物根(target, options);
      expect(normalize(m), name).toEqual(normalize(l));
    }
    expect(modern.validation.检查产物根(inside, { 产物根目录: TMP_DIR }).事件类型).toBe("artifact_root_violation");
    // 默认根：双侧 getWorkspace 同锚（workspace-state.json 同逻辑恢复），只断言互等
    const dm = modern.validation.检查产物根("x.png");
    const dl = legacy.validation.检查产物根("x.png");
    expect(normalize(dm)).toEqual(normalize(dl));
    expect(dm.统计.根目录).toBeTruthy();
  });

  it("运行预检：跳过/全过/部分失败摘要拼接/未知项过滤，双侧互等", () => {
    const workflow = { preflight: ["geoRange", "recordCount", "bogus", "writeBackGuard"] };
    const context = {
      坐标点: [[120, 30]],
      记录数: { 声明数: 1, 实际数: 1 },
      写回: { 工具: "officecli" },
    };
    const passM = modern.validation.运行预检(workflow, context);
    const passL = legacy.validation.运行预检(workflow, context);
    expect(normalize(passM)).toEqual(normalize(passL));
    expect(passM.ok).toBe(false); // officecli 未确认 → 写回失败
    expect(passM.失败项).toHaveLength(1);
    expect(passM.阻断事件).toEqual(["review_waiting_confirmation"]);
    expect(passM.摘要).toBe("preflight 未通过：写回待确认（officecli），已阻断");
    const skipM = modern.validation.运行预检(workflow, context, { 跳过校验: true });
    const skipL = legacy.validation.运行预检(workflow, context, { 跳过校验: true });
    expect(normalize(skipM)).toEqual(normalize(skipL));
    expect(skipM).toEqual({ ok: true, 跳过: true, 检查结果: [], 失败项: [], 阻断事件: ["preflight_skipped"], 摘要: "用户显式跳过 preflight 校验（需留痕）" });
    const okCtx = { ...context, 写回: { 工具: "map_analysis" } };
    const allPassM = modern.validation.运行预检(workflow, okCtx);
    expect(allPassM.ok).toBe(true);
    expect(allPassM.摘要).toBe("preflight 全部通过（3 项）");
    expect(normalize(allPassM)).toEqual(normalize(legacy.validation.运行预检(workflow, okCtx)));
    expect(modern.validation.检查器名称).toEqual(["geoRange", "recordCount", "writeBackGuard", "artifactRoot"]);
  });

  it("检查工具权限：白名单命中/未命中/空白修剪/非数组工具", () => {
    const workflow = { tools: ["map_analysis", "officecli"] };
    expect(modern.validation.检查工具权限(workflow, "officecli")).toBe(true);
    expect(modern.validation.检查工具权限(workflow, "  map_analysis ")).toBe(true);
    expect(modern.validation.检查工具权限(workflow, "write")).toBe(false);
    expect(modern.validation.检查工具权限({}, "officecli")).toBe(false);
    for (const [wf, tool] of [[workflow, "officecli"], [workflow, "write"], [{}, "x"], [undefined, ""]] as [any, any][]) {
      expect(modern.validation.检查工具权限(wf, tool)).toBe(legacy.validation.检查工具权限(wf, tool));
    }
  });
});

describe("s3-misc-domain-parity connectors", () => {
  it("导出面一致（4 项）", () => {
    expect(Object.keys(modern.connectors).sort()).toEqual(Object.keys(legacy.connectors).sort());
  });

  it("无状态文件基线：目录投影 + 详情 + 授权意图（local ready / oauth 随机 state）", () => {
    expect(CONNECTORS_FILE_EXISTS_BEFORE).toBe(false);
    const listM = modern.connectors.listConnectors();
    const listL = legacy.connectors.listConnectors();
    expect(normalize(listM)).toEqual(normalize(listL));
    expect(listM).toHaveLength(4);
    expect(listM.find((c: any) => c.id === "local")).toMatchObject({ configured: true, authRequired: false, status: "ready" });
    expect(listM.find((c: any) => c.id === "google-drive")).toMatchObject({ configured: false, authRequired: true, kind: "oauth" });
    expect(normalize(modern.connectors.getConnector("feishu-drive"))).toEqual(normalize(legacy.connectors.getConnector("feishu-drive")));
    expect(modern.connectors.getConnector("__nope__")).toBeNull();
    // 授权意图：local 非 oauth → ready；oauth → 随机 state（只比形态与消息文案）
    const localM = modern.connectors.beginConnectorAuth("local", "http://localhost/cb");
    const localL = legacy.connectors.beginConnectorAuth("local", "http://localhost/cb");
    expect(normalize(localM)).toEqual(normalize(localL));
    const oauthM = modern.connectors.beginConnectorAuth("google-drive", "  http://cb/  ");
    const oauthL = legacy.connectors.beginConnectorAuth("google-drive", "  http://cb/  ");
    expect(oauthM.ok).toBe(true);
    expect(oauthM.status).toBe("authorization_required");
    expect(oauthM.redirectUri).toBe("  http://cb/  ");
    expect(typeof oauthM.state).toBe("string");
    expect(oauthM.state).toHaveLength(36);
    expect(oauthM.state).not.toBe(oauthL.state); // 随机 UUID 不相等
    expect(oauthM.message).toBe(oauthL.message);
    expect(oauthM.message).toBe("请通过对应插件完成 OAuth 授权；本地服务不会保存第三方密钥。");
    expect(normalize(modern.connectors.beginConnectorAuth("__nope__"))).toEqual(normalize(legacy.connectors.beginConnectorAuth("__nope__")));
    expect(modern.connectors.beginConnectorAuth("__nope__")).toEqual({ ok: false, error: "connector not found" });
  });

  it("setConnectorStatus 写盘回环：patch 落盘 → 投影 connected 形态互等 → 复原", () => {
    try {
      const missM = modern.connectors.setConnectorStatus("__nope__", { configured: true });
      expect(missM).toEqual({ ok: false, error: "connector not found" });
      expect(normalize(missM)).toEqual(normalize(legacy.connectors.setConnectorStatus("__nope__", { configured: true })));
      const setM = modern.connectors.setConnectorStatus("google-drive", { configured: true, accountLabel: "team@google.com" });
      const setL = legacy.connectors.setConnectorStatus("google-drive", { configured: true, accountLabel: "team@google.com" });
      expect(setM.ok).toBe(true);
      expect(setL.ok).toBe(true);
      expect(setM.connector).toMatchObject({ id: "google-drive", configured: true, accountLabel: "team@google.com", authRequired: false });
      expect(setM.connector.updatedAt).toBeTruthy();
      // 后写者覆盖：最终文件双侧读一致（updatedAt 为最后写入者时间戳，整体深等）
      expect(normalize(modern.connectors.listConnectors())).toEqual(normalize(legacy.connectors.listConnectors()));
      const drive = modern.connectors.getConnector("google-drive");
      expect(drive.configured).toBe(true);
      expect(drive.accountLabel).toBe("team@google.com");
    } finally {
      if (!CONNECTORS_FILE_EXISTS_BEFORE) fs.rmSync(CONNECTORS_FILE, { force: true });
    }
    expect(fs.existsSync(CONNECTORS_FILE)).toBe(!CONNECTORS_FILE_EXISTS_BEFORE ? false : true);
  });
});

describe("s3-misc-domain-parity cambodia-od", () => {
  it("导出面一致（1 项）", () => {
    expect(Object.keys(modern.cambodia).sort()).toEqual(Object.keys(legacy.cambodia).sort());
  });

  it("数据缺失/解析失败 → 错误文案逐字", () => {
    const missing = path.join(TMP_DIR, "no-such-od.json");
    vi.stubEnv("CAMBODIA_OD_FILE", missing);
    try {
      const m = modern.cambodia.getCambodiaOD();
      const l = legacy.cambodia.getCambodiaOD();
      expect(normalize(m)).toEqual(normalize(l));
      expect(m.error).toBe(`柬埔寨 OD 数据不存在：${missing}`);
      fs.writeFileSync(missing, "not-json{", "utf8");
      const badM = modern.cambodia.getCambodiaOD();
      const badL = legacy.cambodia.getCambodiaOD();
      expect(normalize(badM)).toEqual(normalize(badL));
      expect(badM.error).toContain("柬埔寨 OD 数据解析失败：");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("数据投影：过滤/阈值/聚合/GeoJSON/排序截断/{data} 包装形态，双侧互等", () => {
    const rows = [
      { start: "A", dest: "B", start_lon: 120.0, start_lat: 30.0, dest_lon: 121.5, dest_lat: 31.2, flow: 10 },
      { start: "A", dest: "C", start_lon: 120.0, start_lat: 30.0, dest_lon: 122.0, dest_lat: 30.5, flow: 0 },
      { start_lon: "bad", start_lat: 30, dest_lon: 121, dest_lat: 30, flow: 5 },
      { start: "D", dest: "E", start_lon: 73, start_lat: 18, dest_lon: 135, dest_lat: 54, flow: 2.345 },
      { start: "A", dest: "B", start_lon: 120, start_lat: 30, dest_lon: 121.5, dest_lat: 31.2, flow: 3 },
    ];
    const file = path.join(TMP_DIR, "od.json");
    fs.writeFileSync(file, JSON.stringify(rows), "utf8");
    vi.stubEnv("CAMBODIA_OD_FILE", file);
    try {
      const m = modern.cambodia.getCambodiaOD({ minFlow: 2 });
      const l = legacy.cambodia.getCambodiaOD({ minFlow: 2 });
      expect(normalize(m)).toEqual(normalize(l));
      expect(m.error).toBeNull();
      expect(m.status).toBe("demo");
      expect(m.source).toBe("od.json");
      expect(m.stats.records).toBe(3);
      expect(m.stats.minFlow).toBe(2);
      expect(m.stats.originCount).toBe(2);
      expect(m.stats.destinationCount).toBe(2); // C 仅出现在 flow 0 行（被阈值滤除），余 B/E
      expect(m.topOrigins).toEqual([{ name: "A", flow: 13 }, { name: "D", flow: 2.345 }]);
      expect(m.topPairs.map((p: any) => [p.origin, p.destination, p.flow])).toEqual([["A", "B", 10], ["A", "B", 3], ["D", "E", 2.345]]); // pairs 为逐行 flow 非聚合（同对多行各占一条），按 flow 降序
      expect(m.points.features).toHaveLength(3);
      expect(m.lines.features).toHaveLength(3);
      expect(m.points.features[0]).toEqual({ type: "Feature", properties: { name: "A", value: 10, role: "origin" }, geometry: { type: "Point", coordinates: [120, 30] } });
      // flow 0 行：阈值 0 时保留，聚合 fallback ||1
      const m0 = modern.cambodia.getCambodiaOD();
      expect(normalize(m0)).toEqual(normalize(legacy.cambodia.getCambodiaOD()));
      expect(m0.stats.records).toBe(4);
      // {data:[...]} 包装形态
      fs.writeFileSync(file, JSON.stringify({ data: rows }), "utf8");
      const wrappedM = modern.cambodia.getCambodiaOD();
      const wrappedL = legacy.cambodia.getCambodiaOD();
      expect(normalize(wrappedM)).toEqual(normalize(wrappedL));
      expect(wrappedM.stats.records).toBe(4);
      // 负阈值钳 0
      expect(modern.cambodia.getCambodiaOD({ minFlow: -5 }).stats.minFlow).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("s3-misc-domain-parity map-demo", () => {
  it("导出面一致（1 项）", () => {
    expect(Object.keys(modern.mapDemo).sort()).toEqual(Object.keys(legacy.mapDemo).sort());
  });

  it("三类分析全形态矩阵：od / isochrone / heatmap / 未知回退 / 参数钳制，双侧互等", () => {
    const cases: [string, any][] = [
      ["od 台州", { analysis: "od", region: "台州市" }],
      ["od 义乌（9 目的地）", { analysis: "od", region: "义乌市" }],
      ["od 未知区域回退", { analysis: "od", region: "亚特兰蒂斯" }],
      ["isochrone 默认", { analysis: "isochrone" }],
      ["isochrone 新昌", { analysis: "isochrone", region: "新昌县" }],
      ["heatmap 默认", {}],
      ["heatmap 计数钳下", { count: 3 }],
      ["heatmap 计数钳上", { count: 500 }],
      ["heatmap 自定义项目", { analysis: "heatmap", region: "杭州市", project: "demo-p", count: 12 }],
      ["未知分析回退 heatmap", { analysis: "xyz" }],
    ];
    for (const [name, input] of cases) {
      const m = modern.mapDemo.createDemoAnalysis(input);
      const l = legacy.mapDemo.createDemoAnalysis(input);
      expect(normalize(m), name).toEqual(normalize(l));
    }
    const od = modern.mapDemo.createDemoAnalysis({ analysis: "od", region: "台州市" });
    expect(od.id).toBe("agent-od-analysis");
    expect(od.source).toBe("demo");
    expect(od.stats.destinations).toBe(9); // TAIZHOU_COUNTIES 全部 9 县区（不含台州市本体，全保留）
    expect(od.stats.totalFlow).toBe(2880); // Σ(180+i*35, i=0..8) = 9*180 + 35*36
    expect(od.geojson.features).toHaveLength(10);
    expect(od.lines.features).toHaveLength(9);
    expect(od.geojson.features[0]).toMatchObject({ properties: { name: "台州市", role: "origin", value: 1000 } });
    const iso = modern.mapDemo.createDemoAnalysis({ analysis: "isochrone", region: "义乌市" });
    expect(iso.geojson.features).toHaveLength(3);
    expect(iso.geojson.features[0]!.geometry.coordinates[0]).toHaveLength(49); // 48 点 + 闭合
    expect(iso.geojson.features.map((f: any) => f.properties.color)).toEqual(["#c4b5fd", "#8b5cf6", "#6d28d9"]);
    const heat = modern.mapDemo.createDemoAnalysis({ count: 3 });
    expect(heat.geojson.features).toHaveLength(12);
    expect(heat.id).toBe("agent-analysis");
    expect(heat.title).toBe("义乌市点位热力图");
    expect(heat.geojson.features[0]!.properties.name).toBe("义乌市演示点-01");
    expect(heat.geojson.features[2]!.properties.category).toBe("居住"); // i=2 → i%3=2
    expect(heat.geojson.features[3]!.properties.category).toBe("枢纽"); // i=3 → i%3=0
    expect(heat.geojson.features[1]!.properties.category).toBe("商贸");
  });
});

describe("s3-misc-domain-parity batch-export", () => {
  it("导出面一致（6 项）+ 常量互等", () => {
    expect(Object.keys(modern.batchExport).sort()).toEqual(Object.keys(legacy.batchExport).sort());
    expect(normalize(modern.batchExport.EXPORT_SIZES)).toEqual(normalize(legacy.batchExport.EXPORT_SIZES));
    expect(normalize(modern.batchExport.CUSTOM_SIZE_LIMITS)).toEqual(normalize(legacy.batchExport.CUSTOM_SIZE_LIMITS));
    expect(normalize(modern.batchExport.EXPORT_FORMATS)).toEqual(normalize(legacy.batchExport.EXPORT_FORMATS));
    expect(modern.batchExport.MAX_JOBS).toBe(legacy.batchExport.MAX_JOBS);
    expect(modern.batchExport.MAX_JOBS).toBe(24);
    expect(modern.batchExport.EXPORT_SIZES.a4l).toEqual({ label: "A4 横向", width: 1600, height: 1131 });
  });

  it("planExportJobs：全形态矩阵（校验/默认/去重/自定义钳制/文件名消毒/上限），双侧互等", () => {
    const cases: [string, any][] = [
      ["全量合法", { projects: ["p1", "p2", "p1"], layerSets: [["roads", "roads", "poi"], [""]], sizes: ["a4l", "square", { width: 100, height: 50 }, { width: 2000.4, height: 1599.6 }], formats: ["png", "pdf", "png"], title: "a/b:c*d?e\"<f>|g\nh  i" }],
      ["空 projects", { projects: [] }],
      ["非法项目名", { projects: ["-bad", "ok"] }],
      ["非法图层 id", { projects: ["p1"], layerSets: [["good", "-bad"]] }],
      ["未知尺寸预设", { projects: ["p1"], sizes: ["a5x"] }],
      ["自定义非数字", { projects: ["p1"], sizes: [{ width: "x", height: 100 }] }],
      ["空 sizes", { projects: ["p1"], sizes: [] }],
      ["未知格式", { projects: ["p1"], formats: ["svg"] }],
      ["缺 formats", { projects: ["p1"] }],
      ["空串 formats", { projects: ["p1"], formats: "" }],
      ["字符串 projects/layersets/formats", { projects: "p1,p2;p3", layerSets: "roads, poi", sizes: "a4p", formats: "png pdf" }],
      ["无参数默认", {}],
    ];
    for (const [name, options] of cases) {
      const m = modern.batchExport.planExportJobs(options);
      const l = legacy.batchExport.planExportJobs(options);
      expect(normalize(m), name).toEqual(normalize(l));
    }
    const full = modern.batchExport.planExportJobs(cases[0]![1]);
    expect(full.errors).toEqual([]);
    // 2 项目 × 2 组合 × 4 尺寸 × 2 格式 = 32 → MAX_JOBS(24) 截断，skipped 8
    expect(full.jobs).toHaveLength(24);
    expect(full.skipped).toBe(8);
    // 尺寸外层、格式内层：同尺寸成对展开（png/pdf），两个 custom 连排四帧
    expect(full.jobs.slice(0, 8).map((j: any) => j.sizeId)).toEqual(["a4l", "a4l", "square", "square", "custom", "custom", "custom", "custom"]);
    expect(full.jobs[0]).toMatchObject({ id: "job-1", project: "p1", layers: ["roads", "poi"], sizeId: "a4l", sizeLabel: "A4 横向", width: 1600, height: 1131, format: "png" });
    expect(full.jobs[4]!.sizeLabel).toBe("自定义 400×300"); // 100×50 钳到下界
    expect(full.jobs[6]!.sizeLabel).toBe("自定义 2000×1600"); // 小数四舍五入
    expect(full.jobs[0]!.title).toBe("a-b-c-d-e-f-g-h i"); // 非法字符→-、空白折叠
    expect(full.jobs[0]!.fileName).toBe("a-b-c-d-e-f-g-h i-p1-roads_poi-a4l.png");
    // 空图层组合：layersPart 缺省
    const emptyLayers = modern.batchExport.planExportJobs({ projects: ["p1"], formats: ["png"] });
    expect(normalize(emptyLayers)).toEqual(normalize(legacy.batchExport.planExportJobs({ projects: ["p1"], formats: ["png"] })));
    expect(emptyLayers.jobs[0]!.fileName).toBe("地图导出-p1-a4l.png");
    // 上限：5 项目 × 1 组合 × 3 尺寸 × 2 格式 = 30 → 24 + skipped 6
    const many = modern.batchExport.planExportJobs({ projects: ["p1", "p2", "p3", "p4", "p5"], sizes: ["a4l", "a4p", "square"], formats: ["png", "pdf"] });
    expect(normalize(many)).toEqual(normalize(legacy.batchExport.planExportJobs({ projects: ["p1", "p2", "p3", "p4", "p5"], sizes: ["a4l", "a4p", "square"], formats: ["png", "pdf"] })));
    expect(many.jobs).toHaveLength(24);
    expect(many.skipped).toBe(6);
    expect(many.jobs[23]!.id).toBe("job-24");
  });

  it("runExportQueue：串行执行/进度快照序列/失败文案/执行器缺失，双侧互等", async () => {
    const jobs = [
      { id: "job-1", project: "p1", format: "png", sizeId: "a4l" },
      { id: "job-2", project: "p1", format: "pdf", sizeId: "a4l" },
      { id: "job-3", project: "p2", format: "png", sizeId: "square" },
    ];
    const makeExecutor = () => async (job: any) => {
      if (job.id === "job-2") throw new Error("boom");
      return { file: `${job.id}.png`, ...(job.id === "job-1" ? { bytes: 123 } : {}) };
    };
    const snapM: any[] = [];
    const snapL: any[] = [];
    const runM = await modern.batchExport.runExportQueue(jobs, makeExecutor(), { onProgress: (s: any) => snapM.push(JSON.parse(JSON.stringify({ ...s, results: s.results.map((r: any) => ({ ...r, ms: 0 })) }))) });
    const runL = await legacy.batchExport.runExportQueue(jobs, makeExecutor(), { onProgress: (s: any) => snapL.push(JSON.parse(JSON.stringify({ ...s, results: s.results.map((r: any) => ({ ...r, ms: 0 })) }))) });
    const strip = (r: any) => { const c = JSON.parse(JSON.stringify(r)); c.results.forEach((x: any) => delete x.ms); delete c.startedAt; delete c.finishedAt; return c; };
    expect(strip(runM)).toEqual(strip(runL));
    expect(runM.total).toBe(3);
    expect(runM.done).toBe(2);
    expect(runM.failed).toBe(1);
    expect(runM.results.map((r: any) => r.status)).toEqual(["done", "failed", "done"]);
    expect(runM.results[0]).toMatchObject({ id: "job-1", file: "job-1.png", bytes: 123 });
    expect(runM.results[1]!.error).toBe("boom");
    expect(runM.results[2]!.bytes).toBeUndefined(); // Number(undefined)=NaN || undefined
    expect(runM.results.every((r: any) => r.ms >= 0)).toBe(true);
    expect(runM.startedAt).toBeTruthy();
    expect(runM.finishedAt >= runM.startedAt).toBe(true);
    // 进度快照序列：running/done 各推一帧 → 6 帧
    expect(snapM).toEqual(snapL);
    expect(snapM.map((s) => [s.done, s.failed])).toEqual([[0, 0], [1, 0], [1, 0], [1, 1], [1, 1], [2, 1]]);
    // 执行器缺失 → 单任务失败文案
    const noExecM = await modern.batchExport.runExportQueue(jobs.slice(0, 1), undefined);
    const noExecL = await legacy.batchExport.runExportQueue(jobs.slice(0, 1), undefined);
    expect(noExecM.results[0]!.status).toBe("failed");
    expect(noExecM.results[0]!.error).toBe("导出执行器不可用");
    expect(strip(noExecM)).toEqual(strip(noExecL));
    // 空队列
    const emptyM = await modern.batchExport.runExportQueue([], makeExecutor());
    expect(emptyM).toMatchObject({ total: 0, done: 0, failed: 0, results: [] });
  });
});
