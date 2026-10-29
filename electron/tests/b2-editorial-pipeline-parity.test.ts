/**
 * B2-12 editorial-pipeline 域：常量/纯函数族（safePipelineName/parseLooseJson）/
 * evaluateGeneratedFile 确定性检查全分支（缺失/空文件/非 ZIP/真实 docx·pptx/覆盖与未覆盖）/
 * runEditorialPipeline 全链（docx·pptx 一次通过/revise 回环/结构性损坏 fail/signal 取消/
 * 越界拒绝/解析失败诊断落盘）。
 *
 * R6-7a 对拍退役改写：旧侧 server/editorial-pipeline.mjs（静态 import server/doc-engine.mjs）
 * 随 server/ 退役删除（等价性已在 B2-12 批对拍验收冻结），仅保留 modern 静态 import
 * src/main/backend/editorial-pipeline.ts（直绑 doc-engine.ts）的同一套绝对断言；
 * 非确定字段（pipelineId/durationMs/产物字节数）不在断言面内，norm 归一随之删除。
 * view stats/outline/text 全走原生（JSZip/docx/pptxgenjs 纯 JS，零外部二进制），
 * 测试态可真实全链跑（scripts/editorial-pipeline-test.mjs 蓝本）。
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PIPELINE_STAGES,
  STAGE_LABELS,
  safePipelineName,
  parseLooseJson,
  evaluateGeneratedFile,
  runEditorialPipeline,
} from "../src/main/backend/editorial-pipeline";
import * as docEngine from "../src/main/backend/doc-engine";

const MODERN_WS = fs.mkdtempSync(path.join(os.tmpdir(), "b2ep-md-"));

afterAll(() => {
  try { fs.rmSync(MODERN_WS, { recursive: true, force: true }); } catch {}
});

/** 事件收集器。 */
function makeEvents() {
  const events: any[] = [];
  return { events, emit: (type: string, data: any) => events.push({ type, ...data }) };
}

// ---- mock 模型任务（scripts/editorial-pipeline-test.mjs 蓝本，闭包无状态） ----
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
/** revise 回环模型：writer 第一轮缺章、第二轮补全（闭包计数器）。 */
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

describe("B2-12 editorial-pipeline：常量与纯函数族", () => {
  it("PIPELINE_STAGES/STAGE_LABELS 常量锚点", () => {
    expect([...PIPELINE_STAGES]).toEqual(["planner", "writer", "formatter", "evaluator"]);
    expect({ ...STAGE_LABELS }).toEqual({ planner: "规划结构", writer: "撰写正文", formatter: "排版生成", evaluator: "独立验收" });
  });

  it("safePipelineName：非法字符清洗/空回退/扩展名剥离/60 截断/自定义 fallback", () => {
    expect(safePipelineName("生成: 2026年*规划<报告>.docx")).toBe("生成_ 2026年_规划_报告_");
    expect(safePipelineName("")).toBe("流水线文档");
    expect(safePipelineName(null)).toBe("流水线文档");
    expect(safePipelineName("报告.docx")).toBe("报告");
    expect(safePipelineName("a".repeat(100))).toBe("a".repeat(60));
    expect(safePipelineName("", "兜底名")).toBe("兜底名");
    // \r\n 属非法字符类替换为 _，trim 不吃下划线
    expect(safePipelineName("  \r\n  ")).toBe("_");
  });

  it("parseLooseJson：围栏/噪声嵌套/转义/截断/非 JSON/数组形态", () => {
    expect(parseLooseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseLooseJson('前缀 {"a":{"b":"含}括号"}} 后缀')).toEqual({ a: { b: "含}括号" } });
    expect(parseLooseJson('```json\n{"x":"值内\\"引号与}"}\n```')).toEqual({ x: '值内"引号与}' });
    expect(parseLooseJson('{"ok":true} 尾部噪声')).toEqual({ ok: true });
    expect(parseLooseJson("不是json")).toBeNull();
    expect(parseLooseJson('{"截断')).toBeNull();
    expect(parseLooseJson("[1,2,3]")).toBeNull(); // 只取对象形态，数组不解析
    expect(parseLooseJson("")).toBeNull();
    expect(parseLooseJson(null)).toBeNull();
  });
});

describe("B2-12 editorial-pipeline：evaluateGeneratedFile 确定性检查", () => {
  it("缺失文件：structural 直判", async () => {
    const a = await evaluateGeneratedFile(path.join(MODERN_WS, "不存在.docx"), { format: "docx", outline: { sections: [] } });
    expect(a).toEqual({ ok: false, structural: true, checks: ["文件存在"], issues: ["产物文件不存在"] });
  });

  it("空文件：structural（0 字节）", async () => {
    fs.writeFileSync(path.join(MODERN_WS, "空.docx"), "");
    const a = await evaluateGeneratedFile(path.join(MODERN_WS, "空.docx"), { format: "docx", outline: { sections: [] } });
    expect(a.ok).toBe(false);
    expect(a.structural).toBe(true);
  });

  it("非 ZIP 内容：ZIP 解析失败 structural", async () => {
    fs.writeFileSync(path.join(MODERN_WS, "坏.docx"), "not a zip");
    const a = await evaluateGeneratedFile(path.join(MODERN_WS, "坏.docx"), { format: "docx", outline: { sections: [] } });
    expect(a.issues.some((c: string) => c.startsWith("ZIP 解析失败"))).toBe(true);
    expect(a.ok).toBe(false);
    expect(a.structural).toBe(true);
  });

  it("真实 docx 全覆盖：ok + 结构完整 + 章节覆盖 3/3", async () => {
    const fixture = path.join(MODERN_WS, "fixture.docx");
    await docEngine.buildDocxFromBlocks(fixture, [
      { type: "heading", text: "第一章 背景综述", level: 1 },
      { type: "paragraph", text: "本项目位于重点片区。" },
      { type: "heading", text: "第二章 目标指标", level: 1 },
      { type: "heading", text: "第三章 实施安排", level: 1 },
    ]);
    const outline = { sections: [{ title: "第一章 背景综述" }, { title: "第二章 目标指标" }, { title: "第三章 实施安排" }] };
    const a = await evaluateGeneratedFile(fixture, { format: "docx", outline });
    expect(a.ok).toBe(true);
    expect(a.structural).toBe(false);
    expect(a.checks).toContain("document.xml 存在");
    expect(a.checks).toContain("章节覆盖 3/3");
  });

  it("真实 docx 未覆盖：issues 含大纲章节未覆盖 + 覆盖计数下降", async () => {
    const fixture = path.join(MODERN_WS, "fixture.docx");
    const outline = { sections: [{ title: "第一章 背景综述" }, { title: "不存在的章节标题" }] };
    const a = await evaluateGeneratedFile(fixture, { format: "docx", outline });
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
    const a = await evaluateGeneratedFile(fixture, { format: "pptx", outline });
    expect(a.ok).toBe(true);
    expect(a.checks.some((c: string) => c.startsWith("幻灯片 2 页"))).toBe(true);
    expect(a.checks).toContain("章节覆盖 2/2");
  });
});

describe("B2-12 editorial-pipeline：runEditorialPipeline 全链", () => {
  it("docx 一次通过：四阶段完成/产物存在/事件完整/中间产物落盘", async () => {
    const me = makeEvents();
    const mr = await runEditorialPipeline({ format: "docx", goal: "城市更新单元规划说明报告", workspace: MODERN_WS, emit: me.emit, runModelTask: goodDocxModel });
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
    const me = makeEvents();
    const mr = await runEditorialPipeline({ format: "pptx", goal: "城市更新工作汇报演示", workspace: MODERN_WS, emit: me.emit, runModelTask: goodPptxModel, modelReview: true });
    expect(mr.status).toBe("completed");
    expect(mr.checks.some((c: string) => c.includes("幻灯片 3 页"))).toBe(true);
    expect(mr.checks.some((c: string) => c.includes("章节覆盖 3/3"))).toBe(true);
    expect(mr.checks).toContain("模型语义复核完成");
  }, 30000);

  it("revise 回环（≤1 轮）：Formatter 两轮 + evaluator revise→done + 无未决问题", async () => {
    const me = makeEvents();
    const mr = await runEditorialPipeline({ format: "docx", goal: "回环测试报告", workspace: MODERN_WS, emit: me.emit, runModelTask: makeReviseModel() });
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
    const me = makeEvents();
    const merr = await runEditorialPipeline({ format: "docx", goal: "结构性损坏报告", workspace: MODERN_WS, emit: me.emit, runModelTask: brokenModel, modelReview: false }).then(() => null, (e: any) => e);
    expect(merr?.message).toMatch(/没有可排版的内容块/);
    expect(me.events.find((e) => e.type === "pipeline_finished")?.status).toBe("failed");
    expect(me.events.some((e) => e.type === "pipeline_stage_finished" && e.stage === "formatter" && e.status === "failed")).toBe(true);
  }, 30000);

  it("signal 已取消：planner 抛取消 + pipeline_finished cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const cancelModel = async () => { throw new Error("流水线已取消"); };
    const me = makeEvents();
    const merr = await runEditorialPipeline({ format: "docx", goal: "取消测试报告", workspace: MODERN_WS, emit: me.emit, runModelTask: cancelModel, signal: controller.signal }).then(() => null, (e: any) => e);
    expect(merr?.message).toContain("流水线已取消");
    expect(me.events.find((e) => e.type === "pipeline_finished")?.status).toBe("cancelled");
  });

  it("输出路径越界拒绝：throw 超出当前工作区", async () => {
    const merr = await runEditorialPipeline({ format: "docx", goal: "越界测试", workspace: MODERN_WS, outputPath: "../外部.docx", emit: () => {}, runModelTask: goodDocxModel }).then(() => null, (e: any) => e);
    expect(merr?.message).toMatch(/超出当前工作区/);
  });

  it("Planner 返回垃圾：诊断串含字符数与开头 + raw.txt 落盘", async () => {
    const garbageModel = async () => "这是一段无法解析的markdown文本，没有任何JSON结构。";
    const merr = await runEditorialPipeline({ format: "docx", goal: "诊断测试报告", workspace: MODERN_WS, emit: () => {}, runModelTask: garbageModel, modelReview: false }).then(() => null, (e: any) => e);
    expect(merr?.message).toMatch(/Planner 未返回可解析的大纲 JSON/);
    expect(merr?.message).toContain("原始返回");
    expect(fs.existsSync(path.join(MODERN_WS, ".pipeline", "诊断测试报告.planner.raw.txt"))).toBe(true);
    expect(fs.readFileSync(path.join(MODERN_WS, ".pipeline", "诊断测试报告.planner.raw.txt"), "utf8")).toBe("这是一段无法解析的markdown文本，没有任何JSON结构。");
  });
});
