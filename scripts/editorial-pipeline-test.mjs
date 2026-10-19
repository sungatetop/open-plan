#!/usr/bin/env node
/**
 * Editorial Pipeline 测试（P2-A，方案 §5.2）。
 * 只测纯编排逻辑（server/editorial-pipeline.mjs），模型会话注入模拟实现；
 * agent.mjs 的 editorial_pipeline 工具接线由集成测试覆盖。
 *
 * 用法: node scripts/editorial-pipeline-test.mjs
 * 退出码: 0 = 全部通过, 1 = 有失败
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PIPELINE_STAGES,
  safePipelineName,
  parseLooseJson,
  evaluateGeneratedFile,
  runEditorialPipeline,
} from "../server/editorial-pipeline.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
let failed = 0;
const test = (name, fn) => Promise.resolve().then(fn).then(
  () => console.log(`  ✓ ${name}`),
  (e) => { failed = 1; console.error(`  ✗ ${name}: ${e.message}`); },
);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-test-"));

console.log("\n▶ 基础工具");
test("parseLooseJson 容忍围栏/前后噪声/嵌套花括号", () => {
  assert.deepEqual(parseLooseJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseLooseJson('前缀 {"a":{"b":"含}括号"}} 后缀'), { a: { b: "含}括号" } });
  assert.equal(parseLooseJson("不是json"), null);
  assert.equal(parseLooseJson('{"截断'), null);
});
test("safePipelineName 清洗非法字符", () => {
  assert.equal(safePipelineName("生成: 2026年*规划<报告>.docx"), "生成_ 2026年_规划_报告_");
  assert.equal(safePipelineName(""), "流水线文档");
});
test("PIPELINE_STAGES 顺序固定", () => {
  assert.deepEqual([...PIPELINE_STAGES], ["planner", "writer", "formatter", "evaluator"]);
});

console.log("\n▶ docx 流水线（一次通过）");
const events = [];
const emit = (type, data) => events.push({ type, stage: data.stage, status: data.status || data.finalStatus });
const goodDocxModel = async (prompt, { stage } = {}) => {
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
await test("四阶段完成、产物存在、事件完整", async () => {
  events.length = 0;
  const result = await runEditorialPipeline({ format: "docx", goal: "城市更新单元规划说明报告", workspace: tmp, emit, runModelTask: goodDocxModel });
  assert.equal(result.status, "completed");
  assert.ok(result.deliverable && result.deliverable.endsWith(".docx"));
  assert.ok(fs.existsSync(path.join(tmp, result.deliverable)));
  const flow = events.map((e) => `${e.type}:${e.stage || ""}`).join(",");
  assert.match(flow, /pipeline_started/);
  assert.match(flow, /pipeline_stage_started:planner/);
  assert.match(flow, /pipeline_stage_finished:writer/);
  assert.match(flow, /pipeline_stage_finished:formatter/);
  assert.match(flow, /pipeline_stage_finished:evaluator/);
  assert.match(flow, /pipeline_finished/);
  assert.ok(result.checks.length >= 5, `应有确定性+模型检查（实际 ${result.checks.length}）`);
  assert.deepEqual(result.issues, []);
  // 中间产物落盘（§5.2：每步产出可检查的中间产物）
  assert.ok(fs.existsSync(path.join(tmp, ".pipeline", "城市更新单元规划说明报告.outline.json")), "outline.json 中间产物");
  assert.ok(fs.existsSync(path.join(tmp, ".pipeline", "城市更新单元规划说明报告.content.json")), "content.json 中间产物");
});

console.log("\n▶ pptx 流水线");
await test("pptx 一次通过且页数一致", async () => {
  const pptModel = async (prompt, { stage } = {}) => {
    if (stage === "planner") return '{"title":"汇报","slides":[{"title":"封面"},{"title":"指标体系"},{"title":"计划"}]}';
    if (stage === "writer") return '{"slides":[{"title":"封面","bullets":["城市更新汇报"]},{"title":"指标体系","bullets":["人口120万"],"table":{"headers":["指标","值"],"rows":[["人口","120万"]]}},{"title":"计划","bullets":["分三期"]}]}';
    return "判定：pass";
  };
  const result = await runEditorialPipeline({ format: "pptx", goal: "城市更新工作汇报演示", workspace: tmp, emit, runModelTask: pptModel, modelReview: true });
  assert.equal(result.status, "completed");
  assert.ok(result.checks.some((c) => c.includes("幻灯片 3 页")));
  assert.ok(result.checks.some((c) => c.includes("章节覆盖 3/3")));
});

console.log("\n▶ revise 回环（≤1 轮）");
await test("内容缺漏触发 revise→补写→复渲染→通过；Formatter 跑两遍", async () => {
  events.length = 0;
  let writerRound = 0;
  const reviseModel = async (prompt, { stage } = {}) => {
    if (stage === "planner") return '{"title":"报告","sections":[{"title":"第一章 概述"},{"title":"第二章 附表"}]}';
    if (stage === "writer") {
      writerRound += 1;
      return writerRound === 1
        ? '{"sections":[{"title":"第一章 概述","blocks":[{"type":"paragraph","text":"概述内容。"}]}]}'
        : '{"sections":[{"title":"第一章 概述","blocks":[{"type":"paragraph","text":"概述内容。"}]},{"title":"第二章 附表","blocks":[{"type":"paragraph","text":"附表说明。"}]}]}';
    }
    return writerRound === 1 ? "- 缺少章节：第二章 附表\n判定：revise" : "已补齐\n判定：pass";
  };
  const result = await runEditorialPipeline({ format: "docx", goal: "回环测试报告", workspace: tmp, emit, runModelTask: reviseModel });
  assert.equal(result.status, "completed");
  assert.equal(result.issues.length, 0, "回环后应无未决问题");
  const formatterRounds = events.filter((e) => e.type === "pipeline_stage_finished" && e.stage === "formatter").length;
  assert.equal(formatterRounds, 2, "revise 后 Formatter 应复渲染一次");
  const evaluatorStatuses = events.filter((e) => e.type === "pipeline_stage_finished" && e.stage === "evaluator").map((e) => e.status);
  assert.deepEqual(evaluatorStatuses, ["revise", "done"], "验收结论应为 revise→done");
});
await test("结构性损坏直接 fail，不做无效回环", async () => {
  events.length = 0;
  const brokenModel = async (prompt, { stage } = {}) => {
    if (stage === "planner") return '{"title":"坏报告","sections":[{"title":"第一章"}]}';
    if (stage === "writer") return '{"sections":[]}'; // 没有内容块 → formatter 抛错
    return "判定：pass";
  };
  await assert.rejects(
    () => runEditorialPipeline({ format: "docx", goal: "结构性损坏报告", workspace: tmp, emit, runModelTask: brokenModel, modelReview: false }),
    /没有可排版的内容块/,
  );
  const finished = events.find((e) => e.type === "pipeline_finished");
  assert.equal(finished.status, "failed");
});
await test("evaluateGeneratedFile 对缺失文件判 structural", async () => {
  const verdict = await evaluateGeneratedFile(path.join(tmp, "不存在.docx"), { format: "docx", outline: { sections: [] } });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.structural, true);
});

console.log("\n▶ 取消与越界保护");
await test("signal 取消后 pipeline_finished=cancelled", async () => {
  events.length = 0;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => runEditorialPipeline({
      format: "docx", goal: "取消测试报告", workspace: tmp, emit,
      runModelTask: async () => { throw new Error("流水线已取消"); },
      signal: controller.signal,
    }),
    /取消/,
  );
  const finished = events.find((e) => e.type === "pipeline_finished");
  assert.equal(finished.status, "cancelled");
});
await test("输出路径越界被拒绝", async () => {
  await assert.rejects(
    () => runEditorialPipeline({ format: "docx", goal: "越界测试", workspace: tmp, outputPath: "../外部.docx", emit, runModelTask: goodDocxModel }),
    /超出当前工作区/,
  );
});

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log(failed ? "\n编辑流水线测试：存在失败" : "\n编辑流水线测试：全部通过");
process.exit(failed);
