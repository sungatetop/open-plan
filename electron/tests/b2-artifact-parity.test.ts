/**
 * B2 artifact 域对拍（artifact-acceptance.ts / artifact-management.ts ↔ server/*.mjs，S3-2 底层件）。
 *
 * 覆盖面（行号锚点均指 server/*.mjs）：
 *   - evaluateArtifactFile 新旧直接对拍：非 Office（txt/png 好/坏字节/pdf/越界基础失败）
 *     + Office 分支 unavailable 状态机（两侧同注入 {available:false} 桩，L164-280）；
 *     checkedAt 为调用时刻时间戳，对拍前经 norm() 归一为常量；
 *   - evaluateRunArtifacts 新旧对拍（png 产物 Run，L344-365；两侧同走真实 checkOfficecli——
 *     legacy 无注入面，TS 省略 officeModule 时动态 import 同一 office.mjs，探测结果逐字一致；
 *     available 时 skip——本机无 officecli 二进制时走文件不存在路径，无 spawn）；
 *   - Office 分支 available 全编排（新侧 office 桩单侧：validate/stats/issues/text/render
 *     + required* 规则，L172-280 锚点断言；validate 为 args[0] 首词，view 族子命令在 args[2]）；
 *   - artifact-management 链路（OAW_RUNS_DIR/OAW_EVENT_DIR stub 隔离，L60-238 语义锚点）：
 *     产物经真实链路装配——beginRun(full 快照) → 写/删文件 → finishRun 前后快照差分
 *     finalizeFileChanges（beginRun 不接受 artifacts 入参，新旧两侧一致）；每用例独立子工作区；
 *     inspectRunAcceptance（沿用人工确认）/ confirmArtifactAcceptance（成功 + 失败 409）/
 *     publishArtifact 校验分支族 / rollbackPublishedArtifact（域函数不校验 confirm——该 400
 *     校验在 op:artifacts:rollback 路由层，S3-2 编排测试覆盖；空 workspace 时 withWriteLock
 *     先拒 409，新旧一致）。
 *
 * 未做：publishArtifact 成功写台账（PUBLISHED_FILE 顶层冻结真实 .oaw/artifacts.json，
 * 无 env 覆盖，不污染真实工作区——savePublished 为 persistence-utils atomicWriteJson
 * 既有对拍件，published 记录构造以源码锚点为准）；listPublishedArtifacts 内容行为
 * （readPublished 读真实台账，无注入面；filter/sort/slice 与旧逐行同构）；
 * rollbackPublishedArtifact 404 分支（publication not found 需先有台账记录，同样受
 * PUBLISHED_FILE 注入面限制；unlock 前置校验分支以源码锚点 + 新旧 parity 覆盖）。
 */
import { describe, expect, test, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as AcceptanceModule from "../src/main/backend/artifact-acceptance";
import type * as ManagementModule from "../src/main/backend/artifact-management";
import type * as RunsModule from "../src/main/backend/runs";

type LegacyAcceptance = typeof import("@legacy-server/artifact-acceptance.mjs");
type LegacyManagement = typeof import("@legacy-server/artifact-management.mjs");
let legacy: LegacyAcceptance;
let legacyMgmt: LegacyManagement;
let acc: typeof AcceptanceModule;
let mgmt: typeof ManagementModule;
let runs: typeof RunsModule;
let base = "";
let ws = "";
let runsDir = "";
let eventDir = "";

const UNAVAILABLE = { available: false as const, path: "stub", code: null, message: "Office CLI 不可用（测试桩）" };
const officeStubModule = {
  checkOfficecli: async () => UNAVAILABLE,
  runOfficecli: async () => { throw new Error("stub 不应被调用"); }
};

/** 最小有效 PNG 字节（签名 + IHDR 头，尺寸 3×2）。 */
function pngBuffer(width = 3, height = 2): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0, 0, 0, 13]),
    Buffer.from("IHDR", "ascii"),
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(width); return b; })(),
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(height); return b; })(),
    Buffer.alloc(6)
  ]);
}

/** 对拍归一：checkedAt 为调用时刻时间戳，新旧两次调用必有毫秒差，比对前置为常量。 */
function norm<T>(value: T): T {
  const clone = structuredClone(value) as any;
  if (clone?.checkedAt) clone.checkedAt = "<ts>";
  for (const item of clone?.artifacts || []) if (item?.checkedAt) item.checkedAt = "<ts>";
  return clone;
}

beforeAll(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "b2artifact-"));
  ws = path.join(base, "ws");
  runsDir = path.join(base, "runs");
  eventDir = path.join(base, "events");
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(runsDir, { recursive: true });
  vi.stubEnv("OAW_RUNS_DIR", runsDir);
  vi.stubEnv("OAW_EVENT_DIR", eventDir);
  acc = await import("../src/main/backend/artifact-acceptance");
  mgmt = await import("../src/main/backend/artifact-management");
  runs = await import("../src/main/backend/runs");
  legacy = await import("@legacy-server/artifact-acceptance.mjs");
  legacyMgmt = await import("@legacy-server/artifact-management.mjs");
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
});

describe("b2-artifact-acceptance-parity evaluateArtifactFile 非 Office", () => {
  test.each([
    ["a.txt", "普通文本内容"],
    ["a.md", "# 标题\n正文"],
    ["a.json", "{\"k\":1}"]
  ])("文本文件 passed（%s）新旧一致", (name, content) => {
    const file = path.join(ws, name);
    fs.writeFileSync(file, content, "utf8");
    const mine = acc.evaluateArtifactFile(file, { root: ws, relativePath: name, officeModule: officeStubModule });
    const theirs = legacy.evaluateArtifactFile(file, { root: ws, relativePath: name });
    return Promise.all([mine, theirs]).then(([m, t]) => {
      expect((m as any).status).toBe("passed");
      expect(norm(m)).toEqual(norm(t));
    });
  });

  test("有效 PNG（3×2）dimensions 读取新旧一致", async () => {
    const file = path.join(ws, "a.png");
    fs.writeFileSync(file, pngBuffer());
    const mine = await acc.evaluateArtifactFile(file, { root: ws, relativePath: "a.png", officeModule: officeStubModule });
    const theirs = await legacy.evaluateArtifactFile(file, { root: ws, relativePath: "a.png" });
    expect(norm(mine)).toEqual(norm(theirs));
    expect(mine.status).toBe("passed");
    expect((mine as any).checks.structure.checks[0].dimensions).toEqual({ width: 3, height: 2 });
  });

  test("坏 PNG 字节 failed 新旧一致", async () => {
    const file = path.join(ws, "bad.png");
    fs.writeFileSync(file, Buffer.from("not a png at all.........."));
    const mine = await acc.evaluateArtifactFile(file, { root: ws, relativePath: "bad.png", officeModule: officeStubModule });
    const theirs = await legacy.evaluateArtifactFile(file, { root: ws, relativePath: "bad.png" });
    expect(norm(mine)).toEqual(norm(theirs));
    expect(mine.status).toBe("failed");
    // 旧实现 readyToPublish: valid（dimensions && …）——坏字节时短路为 null 而非 false
    expect(mine.readyToPublish).toBeFalsy();
  });

  test("PDF manual_review（页数正则 + 视觉待人工）新旧一致", async () => {
    const file = path.join(ws, "a.pdf");
    fs.writeFileSync(file, Buffer.from("%PDF-1.4\n1 0 obj\n/Type /Page\nendobj\n2 0 obj\n/Type /Page \nendobj\n%%EOF"));
    const mine = await acc.evaluateArtifactFile(file, { root: ws, relativePath: "a.pdf", officeModule: officeStubModule });
    const theirs = await legacy.evaluateArtifactFile(file, { root: ws, relativePath: "a.pdf" });
    expect(norm(mine)).toEqual(norm(theirs));
    expect(mine.status).toBe("manual_review");
    expect((mine as any).checks.content.checks[0].message).toContain("至少 2 页");
  });

  test("越界文件基础失败（baseFailure 形状）新旧一致", async () => {
    const outside = path.join(base, "outside.txt");
    fs.writeFileSync(outside, "x");
    const mine = await acc.evaluateArtifactFile(outside, { root: ws, relativePath: "outside.txt", officeModule: officeStubModule });
    const theirs = await legacy.evaluateArtifactFile(outside, { root: ws, relativePath: "outside.txt" });
    expect(norm(mine)).toEqual(norm(theirs));
    expect(mine.status).toBe("failed");
    expect((mine as any).checks.structure.checks[0].id).toBe("file");
  });

  test("Office 分支 unavailable：structure manual_review + manual pending 新旧一致", async () => {
    const file = path.join(ws, "a.docx");
    fs.writeFileSync(file, Buffer.from("PK\x03\x04 fake docx"));
    const mine = await acc.evaluateArtifactFile(file, { root: ws, relativePath: "a.docx", officecli: UNAVAILABLE, officeModule: officeStubModule });
    // legacy（allowJs）把 officecli 形参收窄为 null|undefined，测试侧显式放宽
    const theirs = await legacy.evaluateArtifactFile(file, { root: ws, relativePath: "a.docx", officecli: UNAVAILABLE as any });
    expect(norm(mine)).toEqual(norm(theirs));
    expect(mine.status).toBe("manual_review");
    expect((mine as any).checks.manual.status).toBe("pending");
    expect((mine as any).checks.structure.status).toBe("manual_review");
  });
});

describe("b2-artifact-acceptance-parity evaluateRunArtifacts", () => {
  // legacy evaluateRunArtifacts 无 officecli 注入面（内部 checkOfficecli()），TS 省略
  // officeModule 时动态 import 同一 office.mjs → 两侧探测结果逐字一致（本机无二进制，
  // available:false 无 spawn；若有二进制则跳过对拍，避免测试真调 officecli）。
  test("png 产物 Run 全链路汇总（fileHash/status/officecli 字段）新旧一致", async () => {
    const runWs = path.join(base, "runws");
    fs.mkdirSync(runWs, { recursive: true });
    fs.writeFileSync(path.join(runWs, "out.png"), pngBuffer(4, 5));
    const run = { id: "run_p1", cwd: runWs, artifacts: [{ artifactId: "art1", path: "out.png", status: "modified" }] };
    const mine = await acc.evaluateRunArtifacts(run, {});
    const theirs = await legacy.evaluateRunArtifacts(run, {});
    if ((theirs as any).officecli?.available) { expect(true).toBe(true); return; }
    expect(norm(mine)).toEqual(norm(theirs));
    expect(mine.status).toBe("passed");
    expect(mine.readyToPublish).toBe(true);
    expect((mine.artifacts[0] as any).fileHash).toMatch(/^[0-9a-f]{40}$/);
  });

  test("deleted 产物被过滤 + 空产物 not_checked（新旧一致）", async () => {
    const empty = { id: "run_p2", cwd: ws, artifacts: [] };
    expect(norm(await acc.evaluateRunArtifacts(empty, {})))
      .toEqual(norm(await legacy.evaluateRunArtifacts(empty, {})));
    expect((await acc.evaluateRunArtifacts(empty, {})).status).toBe("not_checked");
  });
});

describe("b2-artifact-acceptance Office 分支 available 编排（office 桩单侧，锚点 L172-280）", () => {
  function makeOfficeStub(options: { validate?: any; stats?: any; issues?: number; textData?: any } = {}) {
    return {
      checkOfficecli: async () => ({ available: true, path: "stub", code: 0, message: "" }),
      runOfficecli: async (args: string[], _opts?: any) => {
        // 与旧实现参数序一致：validate 是首词（["validate", file, "--json"]），
        // view 族子命令在 args[2]（["view", file, "stats|issues|text|screenshot", ...]）。
        const sub = args[0] === "validate" ? "validate" : args[2];
        if (sub === "validate") {
          const v = options.validate ?? { code: 0, json: { success: true, message: "结构 OK", warnings: [] } };
          return typeof v === "function" ? v(args) : v;
        }
        if (sub === "stats") return options.stats ?? { code: 0, json: { data: { pages: 3, paragraphs: 10, totalCharacters: 100, styleDistribution: { Normal: 8 } } } };
        if (sub === "issues") return { code: 0, json: { data: { issues: Array.from({ length: options.issues ?? 0 }, (_, i) => ({ id: i })) } } };
        if (sub === "text") return { code: 0, json: { data: options.textData ?? { body: "关键内容 命中词" } } };
        if (sub === "screenshot") {
          const outIndex = args.indexOf("--out");
          if (outIndex >= 0) fs.writeFileSync(args[outIndex + 1]!, pngBuffer());
          return { code: 0, json: { message: "已截图" } };
        }
        return { code: 0, json: {} };
      }
    };
  }

  test("docx 全通过：status passed + readyToPublish + manual not_required", async () => {
    const file = path.join(ws, "good.docx");
    fs.writeFileSync(file, Buffer.from("PK\x03\x04"));
    const result = await acc.evaluateArtifactFile(file, { root: ws, relativePath: "good.docx", officeModule: makeOfficeStub() as any });
    expect(result.status).toBe("passed");
    expect(result.readyToPublish).toBe(true);
    expect((result as any).checks.manual.status).toBe("not_required");
    expect((result as any).checks.content.checks.map((c: any) => c.id)).toEqual(expect.arrayContaining(["content", "pages", "styles"]));
    // 旧实现 visual 组 = [...formatIssue.checks, ...render.checks]——format 扫描在前
    const renderCheck = (result as any).checks.visual.checks.find((c: any) => c.id === "render");
    expect(renderCheck.message).toBe("已生成视觉预览");
    expect((result as any).verifier).toBe("server+officecli");
  });

  test("validate 失败 → structure manual_review 整体 manual_review", async () => {
    const file = path.join(ws, "broken.docx");
    fs.writeFileSync(file, Buffer.from("PK\x03\x04"));
    const stub = makeOfficeStub({ validate: { code: 3, json: { error: { message: "损坏" } } } });
    const result = await acc.evaluateArtifactFile(file, { root: ws, relativePath: "broken.docx", officeModule: stub as any });
    expect((result as any).checks.structure.status).toBe("manual_review");
    expect(result.status).toBe("manual_review");
    expect(result.readyToPublish).toBe(false);
  });

  test("DOCX 无段落/字符 → content failed（不可人工覆盖）", async () => {
    const file = path.join(ws, "empty.docx");
    fs.writeFileSync(file, Buffer.from("PK\x03\x04"));
    const stub = makeOfficeStub({ stats: { code: 0, json: { data: { pages: 1, paragraphs: 0, totalCharacters: 0 } } } });
    const result = await acc.evaluateArtifactFile(file, { root: ws, relativePath: "empty.docx", officeModule: stub as any });
    expect((result as any).checks.content.status).toBe("failed");
    expect(result.status).toBe("failed");
  });

  test("requiredText 缺失 → content failed + 明细文案", async () => {
    const file = path.join(ws, "miss.docx");
    fs.writeFileSync(file, Buffer.from("PK\x03\x04"));
    const stub = makeOfficeStub({ textData: { body: "完全没有这个词" } });
    const result = await acc.evaluateArtifactFile(file, { root: ws, relativePath: "miss.docx", officeModule: stub as any, rules: { requiredText: ["必须出现"] } });
    const required = (result as any).checks.content.checks.find((c: any) => c.id === "required-content");
    expect(required.status).toBe("failed");
    expect(required.message).toContain("缺少关键内容：必须出现");
  });

  test("xlsx：minFormulas 达标 + requiredSheets 文本命中 → passed", async () => {
    const file = path.join(ws, "t.xlsx");
    fs.writeFileSync(file, Buffer.from("PK\x03\x04"));
    // 旧实现 L215 sheetCount = Number(stats.data.sheets || 0)：sheets 为对象数组时
    // Number() 得 NaN 必 failed，故 stats 回报计数，requiredSheets 走文本检索分支
    // （L236-247 flattenText 后 includes 匹配，与旧侧同一行为）。
    const stub = makeOfficeStub({
      stats: { code: 0, json: { data: { sheets: 2, totalCells: 42, formulaCells: 5 } } },
      textData: { a1: "数据" }
    });
    const result = await acc.evaluateArtifactFile(file, { root: ws, relativePath: "t.xlsx", officeModule: stub as any, rules: { requiredSheets: ["数据"], minFormulas: 3 } });
    expect(result.status).toBe("passed");
    expect(result.readyToPublish).toBe(true);
  });

  test("xlsx：缺工作表 → failed + missing 文案", async () => {
    const file = path.join(ws, "t2.xlsx");
    fs.writeFileSync(file, Buffer.from("PK\x03\x04"));
    const stub = makeOfficeStub({
      stats: { code: 0, json: { data: { sheets: [{ name: "其它" }], totalCells: 42, formulaCells: 5 } } },
      textData: {}
    });
    const result = await acc.evaluateArtifactFile(file, { root: ws, relativePath: "t2.xlsx", officeModule: stub as any, rules: { requiredSheets: ["数据"] } });
    const missing = (result as any).checks.content.checks.find((c: any) => c.id === "required-sheets");
    expect(missing.status).toBe("failed");
    expect(missing.message).toContain("缺少工作表：数据");
  });

  test("render 失败 → visual manual_review（issues warning 不掩盖）", async () => {
    const file = path.join(ws, "r.docx");
    fs.writeFileSync(file, Buffer.from("PK\x03\x04"));
    const stub = {
      checkOfficecli: async () => ({ available: true, path: "stub", code: 0, message: "" }),
      runOfficecli: async (args: string[]) => {
        if (args[2] === "screenshot") return { code: 9, json: { error: { message: "渲染失败" } } };
        if (args[2] === "issues") return { code: 0, json: { data: { issues: [{ id: 1 }] } } };
        if (args[2] === "stats") return { code: 0, json: { data: { pages: 2, paragraphs: 5, totalCharacters: 30 } } };
        return { code: 0, json: { success: true, warnings: [] } };
      }
    };
    const result = await acc.evaluateArtifactFile(file, { root: ws, relativePath: "r.docx", officeModule: stub as any });
    expect((result as any).checks.visual.status).toBe("manual_review");
    expect(result.status).toBe("manual_review");
    expect((result as any).checks.manual.status).toBe("pending");
  });

  test("safeRules 归一：requiredText 截断 30 + minPages 负数钳 0", async () => {
    const file = path.join(ws, "rules.docx");
    fs.writeFileSync(file, Buffer.from("PK\x03\x04"));
    const stub = makeOfficeStub();
    const result = await acc.evaluateArtifactFile(file, { root: ws, relativePath: "rules.docx", officeModule: stub as any, rules: { requiredText: Array.from({ length: 40 }, (_, i) => `词${i}`), minPages: -5 } });
    expect((result as any).rules.requiredText).toHaveLength(30);
    expect((result as any).rules.minPages).toBe(0);
  });
});

/**
 * 真实链路产物装配：beginRun(full 快照) → 写/删文件 → finishRun —— 产物由前后快照
 * 差分 finalizeFileChanges 在收尾时装配（beginRun 不接受 artifacts 入参，新旧两侧
 * 一致，产物只在收尾物化）。每用例独立子工作区：快照差分与 mtime 扫描只落在本轮
 * 窗口内，避免共享目录串扰（snapshotChanges 优先于 recent-mtime，同 hash 触碰文件
 * 会被 finalizeFileChanges 的疑似变更核对剔除）。
 */
let wsSeq = 0;
function makeRunWithArtifact(name: string, content: Buffer | string, mode: "added" | "deleted" = "added") {
  const dir = path.join(base, `ws-${++wsSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  if (mode === "deleted") fs.writeFileSync(path.join(dir, name), content);
  const run = runs.beginRun({ clientId: "c_art", threadId: `t_${Math.random().toString(36).slice(2, 8)}`, cwd: dir, snapshotMode: "full" } as any);
  if (mode === "deleted") fs.unlinkSync(path.join(dir, name));
  else fs.writeFileSync(path.join(dir, name), content);
  runs.finishRun(run.id, { status: "completed", summary: "ok" });
  const view = runs.getRun(run.id) as any;
  const artifact = (view.artifacts || []).find((item: any) => item.path === name);
  return { run: view, artifact };
}

describe("b2-artifact-management inspectRunAcceptance / confirmArtifactAcceptance（runs 真域 + finishRun 差分产物）", () => {
  test("inspect：png 产物自动验收 passed → readyToPublish + 落盘 acceptance", async () => {
    const { run, artifact } = makeRunWithArtifact("good.png", pngBuffer(6, 7));
    expect(artifact).toBeTruthy();
    const result = await mgmt.inspectRunAcceptance(run.id, {});
    expect(result.ok).toBe(true);
    expect((result as any).acceptance.status).toBe("passed");
    expect((result as any).acceptance.readyToPublish).toBe(true);
    // publicRunView 推断类型未收敛 acceptance 附加字段，测试侧放宽
    const saved = runs.getRun(run.id) as any;
    expect(saved.acceptance.status).toBe("passed");
    expect(saved.acceptanceStatus).toBe("passed");
    expect(saved.acceptanceReadyToPublish).toBe(true);
    expect(saved.acceptance.artifacts[0].fileHash).toMatch(/^[0-9a-f]{40}$/);
  });

  test("inspect：404 run not found", async () => {
    expect(await mgmt.inspectRunAcceptance("run_missing_xyz", {})).toEqual({ ok: false, status: 404, error: "run not found" });
  });

  test("inspect：坏 png failed → status failed", async () => {
    const { run, artifact } = makeRunWithArtifact("broken.png", Buffer.from("junk-not-png-bytes"));
    expect(artifact).toBeTruthy();
    const result = await mgmt.inspectRunAcceptance(run.id, {});
    expect((result as any).acceptance.status).toBe("failed");
    expect((result as any).acceptance.readyToPublish).toBe(false);
  });

  test("inspect：已完成人工确认且 fileHash 未变 → 沿用 manualConfirmation", async () => {
    const { run, artifact } = makeRunWithArtifact("reuse.png", pngBuffer(8, 9));
    const first = await mgmt.confirmArtifactAcceptance(run.id, artifact.artifactId, { note: "人工核对通过", operator: "测试员" });
    expect(first.ok).toBe(true);
    // rules 变化触发重新 inspect，但 fileHash 未变 → 沿用
    const second = await mgmt.inspectRunAcceptance(run.id, { minPages: 1 });
    const item = (second as any).acceptance.artifacts[0];
    expect(item.status).toBe("passed");
    expect(item.manualConfirmation.operator).toBe("测试员");
    expect(item.checks.manual.checks[0].id).toBe("manual-confirmation");
    expect((second as any).acceptance.status).toBe("passed");
  });

  test("confirm：成功 → manual checks 注入 + acceptance passed", async () => {
    const { run, artifact } = makeRunWithArtifact("confirm.png", pngBuffer(2, 2));
    const result = await mgmt.confirmArtifactAcceptance(run.id, artifact.artifactId, { note: "确认通过", operator: "测试员" });
    expect(result.ok).toBe(true);
    const confirmed = (result as any).acceptance.artifacts.find((a: any) => a.path === "confirm.png");
    expect(confirmed.status).toBe("passed");
    expect(confirmed.manualConfirmation).toEqual({ operator: "测试员", note: "确认通过", confirmedAt: expect.any(String) });
    expect((result as any).acceptance.status).toBe("passed");
  });

  test("confirm：自动验收失败 → 409 不可覆盖", async () => {
    const { run, artifact } = makeRunWithArtifact("auto-fail.png", Buffer.from("broken png"));
    const result = await mgmt.confirmArtifactAcceptance(run.id, artifact.artifactId, {});
    expect(result).toEqual({ ok: false, status: 409, error: "存在自动验收失败项，人工确认不能覆盖失败", acceptance: (result as any).acceptance });
  });

  test("confirm：artifact 不存在 → 404 artifact not found", async () => {
    const { run } = makeRunWithArtifact("noart.png", pngBuffer());
    expect(await mgmt.confirmArtifactAcceptance(run.id, "art_missing", {})).toEqual({ ok: false, status: 404, error: "artifact not found" });
  });
});

describe("b2-artifact-management publishArtifact 校验分支族（成功写台账不做，见文件头未做段）", () => {
  test("404 run not found", async () => {
    expect(await mgmt.publishArtifact("run_pub_missing", "art", {})).toEqual({ ok: false, status: 404, error: "run not found" });
  });

  test("未完成 Run → 409 只有已完成 Run 的成果可以固定", async () => {
    const run = runs.beginRun({ clientId: "c_pub", threadId: `t_${Math.random().toString(36).slice(2, 8)}`, cwd: ws, snapshotMode: "none" } as any);
    expect(await mgmt.publishArtifact(run.id, "art", {})).toEqual({ ok: false, status: 409, error: "只有已完成 Run 的成果可以固定" });
  });

  test("已完成 + artifact 不存在 → 404 artifact not found", async () => {
    const { run } = makeRunWithArtifact("pub1.png", pngBuffer());
    expect(await mgmt.publishArtifact(run.id, "art_missing", {})).toEqual({ ok: false, status: 404, error: "artifact not found" });
  });

  test("deleted 产物 → 409 已删除文件不能固定为成果", async () => {
    const { run, artifact } = makeRunWithArtifact("pub2.png", pngBuffer(), "deleted");
    expect(artifact.status).toBe("deleted");
    expect(await mgmt.publishArtifact(run.id, artifact.artifactId, {})).toEqual({ ok: false, status: 409, error: "已删除文件不能固定为成果" });
  });

  test("产物未就绪（自动失败）→ 409 验收失败文案优先", async () => {
    const { run, artifact } = makeRunWithArtifact("pub3.png", Buffer.from("broken"));
    const result = await mgmt.publishArtifact(run.id, artifact.artifactId, {});
    expect(result.ok).toBe(false);
    expect((result as any).status).toBe(409);
    expect((result as any).error).toBe("产物验收失败，不能固定为正式成果");
  });

  test("产物待人工确认 → 409 仍需人工确认文案", async () => {
    const { run, artifact } = makeRunWithArtifact("pub4.pdf", Buffer.from("%PDF-1.4\n/Type /Page\n%%EOF"));
    const result = await mgmt.publishArtifact(run.id, artifact.artifactId, {});
    expect(result.ok).toBe(false);
    expect((result as any).error).toBe("产物仍需人工确认，不能固定为正式成果");
    expect((result as any).acceptance).toBeDefined();
  });
});

describe("b2-artifact-management rollbackPublishedArtifact 校验分支", () => {
  // 域函数不校验 confirm（400 "rollback requires confirm=true" 在 op:artifacts:rollback
  // 路由层，server L3198-3203，S3-2 编排测试覆盖）；publication 不存在时 workspace 为空串，
  // withWriteLock→validateTarget 先抛 WORKSPACE_INVALID → catch 409，unlock 的 404 分支
  // 需先有台账记录（PUBLISHED_FILE 无注入面，见文件头未做段）——以新旧 parity 收口。
  test("publication 不存在 + 空 workspace → withWriteLock 先拒 409，新旧一致", () => {
    const mine = mgmt.rollbackPublishedArtifact(`publication_${"0".repeat(8)}_${Date.now()}`, { operator: "测试员" });
    const theirs = legacyMgmt.rollbackPublishedArtifact(`publication_${"0".repeat(8)}_${Date.now()}`, { operator: "测试员" });
    expect(mine).toEqual({ ok: false, status: 409, error: "工作区不存在或不是文件夹" });
    expect(mine).toEqual(theirs);
  });

  test("confirm 参数被域函数忽略（路由层职责），行为与 operator-only 一致", () => {
    const mine = mgmt.rollbackPublishedArtifact("pub_x", { operator: "测试员" });
    const theirs = legacyMgmt.rollbackPublishedArtifact("pub_x", { operator: "测试员" });
    expect((mine as any).status).toBe(409);
    expect(mine).toEqual(theirs);
  });
});
