/**
 * B2-12 editorial-pipeline 域对拍：常量/纯函数族（safePipelineName/parseLooseJson）/
 * evaluateGeneratedFile 确定性检查全分支（缺失/空文件/非 ZIP/真实 docx·pptx/覆盖与未覆盖）/
 * runEditorialPipeline 全链（docx·pptx 一次通过/revise 回环/结构性损坏 fail/signal 取消/
 * 越界拒绝/解析失败诊断落盘）。
 *
 * doc-engine 域自 B2-13 起已迁 TS（editorial-pipeline.ts 静态直绑 doc-engine.ts），
 * 旧侧 editorial-pipeline.mjs 静态 import server/doc-engine.mjs、TS 侧直绑
 * src/main/backend/doc-engine.ts——两者为逐行等价转录，fixture 生成与全链读取
 * 行为一致，对拍只验 TS 编排逻辑；view stats/outline/text 全走原生（JSZip/docx/
 * pptxgenjs 纯 JS，零外部二进制），测试态可真实全链跑（scripts/editorial-pipeline-test.mjs 蓝本）。
 * 非确定性归一：pipelineId（Date.now base36）/durationMs/产物字节数（docx/pptx 容器
 * 内嵌时间戳双侧必不同）/双侧 tmp 根路径（built.file 绝对路径）。
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  PIPELINE_STAGES,
  STAGE_LABELS,
  safePipelineName,
  parseLooseJson,
  evaluateGeneratedFile,
  runEditorialPipeline,
} from "../src/main/backend/editorial-pipeline";
import * as docEngine from "../src/main/backend/doc-engine";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "../..");

type Legacy = typeof import("../src/main/backend/editorial-pipeline");
let legacy: Legacy;

const LEGACY_WS = fs.mkdtempSync(path.join(os.tmpdir(), "b2ep-lg-"));
const MODERN_WS = fs.mkdtempSync(path.join(os.tmpdir(), "b2ep-md-"));

beforeAll(async () => {
  legacy = (await import(pathToFileURL(path.join(PROJECT_ROOT, "server", "editorial-pipeline.mjs")).href)) as Legacy;
});

afterAll(() => {
  try { fs.rmSync(LEGACY_WS, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(MODERN_WS, { recursive: true, force: true }); } catch {}
});

/** 非确定性归一：pipelineId/实时耗时/产物字节/双侧 tmp 根路径。 */
function norm(value: any): any {
  if (typeof value === "string") {
    return value
      .split(LEGACY_WS).join("WS").split(MODERN_WS).join("WS")
      .replace(/pipeline_[0-9a-z]+/g, "pipeline_X")
      .replace(/\d+ 字节/g, "N 字节");
  }
  if (value && typeof value === "object") {
    if (Array.isArray(value)) return value.map(norm);
    const out: any = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = k === "durationMs" ? "MS" : norm(v);
    }
    return out;
  }
  return value;
}

/** 事件收集器（双侧各自实例）。 */
function makeEvents() {
  const events: any[] = [];
  return { events, emit: (type: string, data: any) => events.push({ type, ...data }) };
}

// ---- mock 模型任务（scripts/editorial-pipeline-test.mjs 蓝本，闭包无状态可双侧共用） ----
const goodDocxModel = async (_prompt: string, { stage }: any = {}) => {
  if (stage === "planner") return '```json\n{"title":"测试报告","sections":[{"title":"第一章 背景综述"},{"title":"第二章 目标指标"},{"title":"第三章 实施安排"}]}\n```';
  if (stage === "writer") return JSON.stringify({
    sections: [
      { title: "第一章 背景综述", blocks: [{ type: "paragraph", text: "本项目位于重点片区。" }] },
      { title: "第二章 目标指标", blocks: [{ type: "table", rows: [["指标", "值"], ["人口", "120万"]] }] },
      { title: "第三章 实施安排", blocks: [{ type: "paragraph", text: "分三期推进。" }] },
    ],
  });
  return "覆盖完整。\n判定：pass";
};
const goodPptxModel = async (_prompt: string, { stage }: any = {}) => {
  if (stage === "planner") return '{"title":"汇报","slides":[{"title":"封面"},{"title":"指标体系"},{"title":"计划"}]}';
  if (stage === "writer") return '{"slides":[{"title":"封面","bullets":["城市更新汇报"]},{"title":"指标体系","bullets":["人口120万"],"table":{"headers":["指标","值"],"rows":[["人口","120万"]]}},{"title":"计划","bullets":["分三期"]}]}';
  return "判定：pass";
};
/** revise 回环模型：writer 第一轮缺章、第二轮补全（每侧独立计数器）。 */
function makeReviseModel() {
  let writerRound = 0;
  return async (_prompt: string, { stage }: any = {}) => {
    if (stage === "planner") return '{"title":"报告","sections":[{"title":"第一章 概述"},{"title":"第二章 附表"}]}';
    if (stage === "writer") {
      writerRound += 1;
      return writerRound === 1
        ? '{"sections":[{"title":"第一章 概述","blocks":[{"type":"paragraph","text":"概述内容。"}]}]}'
        : '{"sections":[{"title":"第一章 概述","blocks":[{"type":"paragraph","text":"概述内容。"}]},{"title":"第二章 附表","blocks":[{"type":"paragraph","text":"附表说明。"}]}]}';
    }
    return writerRound === 1 ? "- 缺少章节：第二章 附表\n判定：revise" : "已补齐\n判定：pass";
  };
}

describe("B2-12 对拍：常量与纯函数族", () => {
  it("PIPELINE_STAGES/STAGE_LABELS 常量一致", () => {
    expect([...PIPELINE_STAGES]).toEqual([...legacy.PIPELINE_STAGES]);
    expect({ ...STAGE_LABELS }).toEqual({ ...legacy.STAGE_LABELS });
    expect([...PIPELINE_STAGES]).toEqual(["planner", "writer", "formatter", "evaluator"]);
  });

  it("safePipelineName：非法字符清洗/空回退/扩展名剥离/60 截断/自定义 fallback", () => {
    const cases: [any, string?][] = [
      ["生成: 2026年*规划<报告>.docx"],
      [""],
      [null],
      ["报告.docx"],
      ["a".repeat(100)],
      ["", "兜底名"],
      ["  \r\n  "],
    ];
    for (const [goal, fallback] of cases) {
      expect(safePipelineName(goal, fallback)).toEqual(legacy.safePipelineName(goal, fallback));
    }
    expect(safePipelineName("生成: 2026年*规划<报告>.docx")).toBe("生成_ 2026年_规划_报告_");
    expect(safePipelineName("")).toBe("流水线文档");
    expect(safePipelineName("a".repeat(100))).toHaveLength(60);
  });

  it("parseLooseJson：围栏/噪声嵌套/转义/截断/非 JSON/数组形态", () => {
    const cases: any[] = [
      '```json\n{"a":1}\n```',
      '前缀 {"a":{"b":"含}括号"}} 后缀',
      "不是json",
      '{"截断',
      '```json\n{"x":"值内\\"引号与}"}\n```',
      '[1,2,3]',
      '',
      null,
      '{"ok":true} 尾部噪声',
    ];
    for (const text of cases) {
      expect(parseLooseJson(text)).toEqual(legacy.parseLooseJson(text));
    }
    expect(parseLooseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseLooseJson('前缀 {"a":{"b":"含}括号"}} 后缀')).toEqual({ a: { b: "含}括号" } });
    expect(parseLooseJson("不是json")).toBeNull();
    expect(parseLooseJson('{"截断')).toBeNull();
  });
});

describe("B2-12 对拍：evaluateGeneratedFile 确定性检查", () => {
  it("缺失文件：structural 直判", async () => {
    const [a, b] = await Promise.all([
      evaluateGeneratedFile(path.join(MODERN_WS, "不存在.docx"), { format: "docx", outline: { sections: [] } }),
      legacy.evaluateGeneratedFile(path.join(LEGACY_WS, "不存在.docx"), { format: "docx", outline: { sections: [] } }),
    ]);
    expect(norm(a)).toEqual(norm(b));
    expect(a).toEqual({ ok: false, structural: true, checks: ["文件存在"], issues: ["产物文件不存在"] });
  });

  it("空文件：structural（0 字节）", async () => {
    fs.writeFileSync(path.join(MODERN_WS, "空.docx"), "");
    fs.writeFileSync(path.join(LEGACY_WS, "空.docx"), "");
    const [a, b] = await Promise.all([
      evaluateGeneratedFile(path.join(MODERN_WS, "空.docx"), { format: "docx", outline: { sections: [] } }),
      legacy.evaluateGeneratedFile(path.join(LEGACY_WS, "空.docx"), { format: "docx", outline: { sections: [] } }),
    ]);
    expect(norm(a)).toEqual(norm(b));
    expect(a.ok).toBe(false);
    expect(a.structural).toBe(true);
  });

  it("非 ZIP 内容：ZIP 解析失败 structural（错误消息双侧一致）", async () => {
    fs.writeFileSync(path.join(MODERN_WS, "坏.docx"), "not a zip");
    fs.writeFileSync(path.join(LEGACY_WS, "坏.docx"), "not a zip");
    const [a, b] = await Promise.all([
      evaluateGeneratedFile(path.join(MODERN_WS, "坏.docx"), { format: "docx", outline: { sections: [] } }),
      legacy.evaluateGeneratedFile(path.join(LEGACY_WS, "坏.docx"), { format: "docx", outline: { sections: [] } }),
    ]);
    expect(norm(a)).toEqual(norm(b));
    expect(a.issues.some((c: string) => c.startsWith("ZIP 解析失败"))).toBe(true);
    expect(a.ok).toBe(false);
    expect(a.structural).toBe(true);
  });

  it("真实 docx 全覆盖：ok + 结构完整 + 章节覆盖 3/3（共享同一产物文件）", async () => {
    const fixture = path.join(MODERN_WS, "fixture.docx");
    await docEngine.buildDocxFromBlocks(fixture, [
      { type: "heading", text: "第一章 背景综述", level: 1 },
      { type: "paragraph", text: "本项目位于重点片区。" },
      { type: "heading", text: "第二章 目标指标", level: 1 },
      { type: "heading", text: "第三章 实施安排", level: 1 },
    ]);
    const outline = { sections: [{ title: "第一章 背景综述" }, { title: "第二章 目标指标" }, { title: "第三章 实施安排" }] };
    const [a, b] = await Promise.all([
      evaluateGeneratedFile(fixture, { format: "docx", outline }),
      legacy.evaluateGeneratedFile(fixture, { format: "docx", outline }),
    ]);
    expect(norm(a)).toEqual(norm(b));
    expect(a.ok).toBe(true);
    expect(a.structural).toBe(false);
    expect(a.checks).toContain("document.xml 存在");
    expect(a.checks).toContain("章节覆盖 3/3");
  });

  it("真实 docx 未覆盖：issues 含大纲章节未覆盖 + 覆盖计数下降", async () => {
    const fixture = path.join(MODERN_WS, "fixture.docx");
    const outline = { sections: [{ title: "第一章 背景综述" }, { title: "不存在的章节标题" }] };
    const [a, b] = await Promise.all([
      evaluateGeneratedFile(fixture, { format: "docx", outline }),
      legacy.evaluateGeneratedFile(fixture, { format: "docx", outline }),
    ]);
    expect(norm(a)).toEqual(norm(b));
    expect(a.issues.some((i: string) => i.startsWith("大纲章节未覆盖：不存在的章节标题"))).toBe(true);
    expect(a.checks).toContain("章节覆盖 1/2");
  });

  it("真实 pptx：幻灯片页数 + 文本非空 + 覆盖检查", async () => {
    const fixture = path.join(MODERN_WS, "fixture.pptx");
    await docEngine.buildPptxFromSlides(fixture, [
      { title: "封面", bullets: ["城市更新汇报"], table: null },
      { title: "指标体系", bullets: ["人口120万"] },
    ]);
    const outline = { slides: [{ title: "封面" }, { title: "指标体系" }] };
    const [a, b] = await Promise.all([
      evaluateGeneratedFile(fixture, { format: "pptx", outline }),
      legacy.evaluateGeneratedFile(fixture, { format: "pptx", outline }),
    ]);
    expect(norm(a)).toEqual(norm(b));
    expect(a.ok).toBe(true);
    expect(a.checks.some((c: string) => c.startsWith("幻灯片 2 页"))).toBe(true);
    expect(a.checks).toContain("章节覆盖 2/2");
  });
});

describe("B2-12 对拍：runEditorialPipeline 全链", () => {
  it("docx 一次通过：四阶段完成/产物存在/事件完整/中间产物落盘", async () => {
    const le = makeEvents();
    const me = makeEvents();
    const [lr, mr] = await Promise.all([
      legacy.runEditorialPipeline({ format: "docx", goal: "城市更新单元规划说明报告", workspace: LEGACY_WS, emit: le.emit, runModelTask: goodDocxModel }),
      runEditorialPipeline({ format: "docx", goal: "城市更新单元规划说明报告", workspace: MODERN_WS, emit: me.emit, runModelTask: goodDocxModel }),
    ]);
    expect(norm(lr)).toEqual(norm(mr));
    expect(norm(le.events)).toEqual(norm(me.events));
    expect(mr.status).toBe("completed");
    expect(mr.deliverable).toBeTruthy();
    expect(mr.deliverable.endsWith(".docx")).toBe(true);
    expect(fs.existsSync(path.join(MODERN_WS, mr.deliverable))).toBe(true);
    expect(mr.checks.length).toBeGreaterThanOrEqual(5);
    expect(mr.issues).toEqual([]);
    expect(fs.existsSync(path.join(MODERN_WS, ".pipeline", "城市更新单元规划说明报告.outline.json"))).toBe(true);
    expect(fs.existsSync(path.join(MODERN_WS, ".pipeline", "城市更新单元规划说明报告.content.json"))).toBe(true);
    const flow = me.events.map((e) => `${e.type}:${e.stage || ""}`).join(",");
    expect(flow).toContain("pipeline_started");
    expect(flow).toContain("pipeline_stage_started:planner");
    expect(flow).toContain("pipeline_stage_finished:writer");
    expect(flow).toContain("pipeline_stage_finished:formatter");
    expect(flow).toContain("pipeline_stage_finished:evaluator");
    expect(flow).toContain("pipeline_finished");
  }, 30000);

  it("pptx 一次通过：幻灯片 3 页 + 章节覆盖 3/3 + 模型复核", async () => {
    const le = makeEvents();
    const me = makeEvents();
    const [lr, mr] = await Promise.all([
      legacy.runEditorialPipeline({ format: "pptx", goal: "城市更新工作汇报演示", workspace: LEGACY_WS, emit: le.emit, runModelTask: goodPptxModel, modelReview: true }),
      runEditorialPipeline({ format: "pptx", goal: "城市更新工作汇报演示", workspace: MODERN_WS, emit: me.emit, runModelTask: goodPptxModel, modelReview: true }),
    ]);
    expect(norm(lr)).toEqual(norm(mr));
    expect(norm(le.events)).toEqual(norm(me.events));
    expect(mr.status).toBe("completed");
    expect(mr.checks.some((c: string) => c.includes("幻灯片 3 页"))).toBe(true);
    expect(mr.checks.some((c: string) => c.includes("章节覆盖 3/3"))).toBe(true);
    expect(mr.checks).toContain("模型语义复核完成");
  }, 30000);

  it("revise 回环（≤1 轮）：Formatter 两轮 + evaluator revise→done + 无未决问题", async () => {
    const le = makeEvents();
    const me = makeEvents();
    const [lr, mr] = await Promise.all([
      legacy.runEditorialPipeline({ format: "docx", goal: "回环测试报告", workspace: LEGACY_WS, emit: le.emit, runModelTask: makeReviseModel() }),
      runEditorialPipeline({ format: "docx", goal: "回环测试报告", workspace: MODERN_WS, emit: me.emit, runModelTask: makeReviseModel() }),
    ]);
    expect(norm(lr)).toEqual(norm(mr));
    expect(norm(le.events)).toEqual(norm(me.events));
    expect(mr.status).toBe("completed");
    expect(mr.issues).toEqual([]);
    const formatterRounds = me.events.filter((e) => e.type === "pipeline_stage_finished" && e.stage === "formatter").length;
    expect(formatterRounds).toBe(2);
    const evaluatorStatuses = me.events.filter((e) => e.type === "pipeline_stage_finished" && e.stage === "evaluator").map((e) => e.status);
    expect(evaluatorStatuses).toEqual(["revise", "done"]);
    const writerRevise = me.events.find((e) => e.type === "pipeline_stage_finished" && e.stage === "writer" && e.status === "revise");
    expect(writerRevise).toBeTruthy();
  }, 30000);

  it("结构性损坏（无内容块）：formatter 抛错 + pipeline_finished failed + 阶段失败事件", async () => {
    const brokenModel = async (_prompt: string, { stage }: any = {}) => {
      if (stage === "planner") return '{"title":"坏报告","sections":[{"title":"第一章"}]}';
      if (stage === "writer") return '{"sections":[]}';
      return "判定：pass";
    };
    const le = makeEvents();
    const me = makeEvents();
    const [lerr, merr] = await Promise.all([
      legacy.runEditorialPipeline({ format: "docx", goal: "结构性损坏报告", workspace: LEGACY_WS, emit: le.emit, runModelTask: brokenModel, modelReview: false }).then(() => null, (e: any) => e),
      runEditorialPipeline({ format: "docx", goal: "结构性损坏报告", workspace: MODERN_WS, emit: me.emit, runModelTask: brokenModel, modelReview: false }).then(() => null, (e: any) => e),
    ]);
    expect(norm(lerr?.message)).toEqual(norm(merr?.message));
    expect(norm(le.events)).toEqual(norm(me.events));
    expect(merr?.message).toMatch(/没有可排版的内容块/);
    expect(me.events.find((e) => e.type === "pipeline_finished")?.status).toBe("failed");
    expect(me.events.some((e) => e.type === "pipeline_stage_finished" && e.stage === "formatter" && e.status === "failed")).toBe(true);
  }, 30000);

  it("signal 已取消：planner 抛取消 + pipeline_finished cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const cancelModel = async () => { throw new Error("流水线已取消"); };
    const le = makeEvents();
    const me = makeEvents();
    const [lerr, merr] = await Promise.all([
      legacy.runEditorialPipeline({ format: "docx", goal: "取消测试报告", workspace: LEGACY_WS, emit: le.emit, runModelTask: cancelModel, signal: controller.signal }).then(() => null, (e: any) => e),
      runEditorialPipeline({ format: "docx", goal: "取消测试报告", workspace: MODERN_WS, emit: me.emit, runModelTask: cancelModel, signal: controller.signal }).then(() => null, (e: any) => e),
    ]);
    expect(lerr?.message).toEqual(merr?.message);
    expect(norm(le.events)).toEqual(norm(me.events));
    expect(me.events.find((e) => e.type === "pipeline_finished")?.status).toBe("cancelled");
  });

  it("输出路径越界拒绝：throw 超出当前工作区", async () => {
    const [lerr, merr] = await Promise.all([
      legacy.runEditorialPipeline({ format: "docx", goal: "越界测试", workspace: LEGACY_WS, outputPath: "../外部.docx", emit: () => {}, runModelTask: goodDocxModel }).then(() => null, (e: any) => e),
      runEditorialPipeline({ format: "docx", goal: "越界测试", workspace: MODERN_WS, outputPath: "../外部.docx", emit: () => {}, runModelTask: goodDocxModel }).then(() => null, (e: any) => e),
    ]);
    expect(lerr?.message).toEqual(merr?.message);
    expect(merr?.message).toMatch(/超出当前工作区/);
  });

  it("Planner 返回垃圾：诊断串含字符数与开头 + raw.txt 落盘", async () => {
    const garbageModel = async () => "这是一段无法解析的markdown文本，没有任何JSON结构。";
    const [lerr, merr] = await Promise.all([
      legacy.runEditorialPipeline({ format: "docx", goal: "诊断测试报告", workspace: LEGACY_WS, emit: () => {}, runModelTask: garbageModel, modelReview: false }).then(() => null, (e: any) => e),
      runEditorialPipeline({ format: "docx", goal: "诊断测试报告", workspace: MODERN_WS, emit: () => {}, runModelTask: garbageModel, modelReview: false }).then(() => null, (e: any) => e),
    ]);
    expect(lerr?.message).toEqual(merr?.message);
    expect(merr?.message).toMatch(/Planner 未返回可解析的大纲 JSON/);
    expect(merr?.message).toContain("原始返回");
    expect(fs.existsSync(path.join(MODERN_WS, ".pipeline", "诊断测试报告.planner.raw.txt"))).toBe(true);
    expect(fs.readFileSync(path.join(MODERN_WS, ".pipeline", "诊断测试报告.planner.raw.txt"), "utf8")).toBe("这是一段无法解析的markdown文本，没有任何JSON结构。");
  });
});
