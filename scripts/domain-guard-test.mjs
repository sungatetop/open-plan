#!/usr/bin/env node
/**
 * 领域硬约束测试（Qoder 对标 §4.3）。
 *
 * 覆盖四类越界各一例 + 边界值 + 跳过校验降级：
 *   geoRange      → geo_out_of_range（经度 73–135°E / 纬度 18–54°N）
 *   recordCount   → data_integrity_failed
 *   writeBackGuard→ review_waiting_confirmation（复用既有事件）
 *   artifactRoot  → artifact_root_violation
 * 并断言检查器为纯函数（无副作用：不抛错、不写盘）。
 *
 * 用法：node scripts/domain-guard-test.mjs
 */
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import {
  经度范围,
  纬度范围,
  检查坐标范围,
  检查记录数,
  检查写回保护,
  检查产物根,
  运行预检,
  检查器名称,
  检查工具权限,
} from "../server/workflow-validation.mjs";

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); } catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
};

test("坐标范围常量与 AGENT.MD 一致", () => {
  assert.deepEqual([...经度范围], [73, 135]);
  assert.deepEqual([...纬度范围], [18, 54]);
});

test("geoRange：范围内通过，越界阻断并给出事件", () => {
  const 正常 = 检查坐标范围([{ 经度: 120.1, 纬度: 30.2 }, [119.5, 29.8], { lon: 121, lat: 31 }]);
  assert.equal(正常.ok, true, 正常.摘要);
  assert.equal(正常.检查项, "geoRange");
  assert.equal(正常.统计.总数, 3);

  const 越界 = 检查坐标范围([{ 经度: 140, 纬度: 30 }]);
  assert.equal(越界.ok, false);
  assert.equal(越界.事件类型, "geo_out_of_range");
  assert.equal(越界.违规.length, 1);
  assert.match(越界.违规[0].原因, /经度超出/);
});

test("geoRange：四边界值（73/135/18/54）通过，边界外阻断", () => {
  for (const 点 of [[73, 18], [135, 54], [73, 54], [135, 18]]) {
    assert.equal(检查坐标范围([点]).ok, true, `边界点应通过：${点}`);
  }
  for (const 点 of [[72.9, 30], [135.1, 30], [120, 17.9], [120, 54.1]]) {
    assert.equal(检查坐标范围([点]).ok, false, `边界外应阻断：${点}`);
  }
});

test("geoRange：坐标缺失/非数值识别为违规，空集合不误报", () => {
  const 缺失 = 检查坐标范围([{ 经度: "东经120" }]);
  assert.equal(缺失.ok, false);
  assert.match(缺失.违规[0].原因, /缺失或非数值/);
  assert.equal(检查坐标范围([]).ok, true);
});

test("recordCount：一致通过；不一致/空数据阻断", () => {
  assert.equal(检查记录数({ 声明数: 1000, 实际数: 1000 }).ok, true);

  const 不一致 = 检查记录数({ 声明数: 1000, 实际数: 998 });
  assert.equal(不一致.ok, false);
  assert.equal(不一致.事件类型, "data_integrity_failed");
  assert.match(不一致.摘要, /未通过/);

  const 空数据 = 检查记录数({ 声明数: 0, 实际数: 0 });
  assert.equal(空数据.ok, false);
  assert.match(空数据.违规[0].原因, /无有效记录/);

  const 缺字段 = 检查记录数({});
  assert.equal(缺字段.ok, false);
});

test("writeBackGuard：写回类工具未确认阻断，确认后放行；只读工具免检", () => {
  const 未确认 = 检查写回保护({ 工具: "officecli" });
  assert.equal(未确认.ok, false);
  assert.equal(未确认.需要确认, true);
  assert.equal(未确认.事件类型, "review_waiting_confirmation");

  assert.equal(检查写回保护({ 工具: "officecli", 已确认: true }).ok, true);
  assert.equal(检查写回保护({ 工具: "read" }).ok, true);
  assert.equal(检查写回保护({ 工具: "read" }).需要确认, false);
});

test("artifactRoot：工作区内通过，越界阻断", () => {
  const 根 = path.join(process.cwd(), "office-workspace");
  assert.equal(检查产物根("报告/评估.docx", { 产物根目录: 根 }).ok, true);
  assert.equal(检查产物根(根, { 产物根目录: 根 }).ok, true);

  const 越界 = 检查产物根("../../outside.docx", { 产物根目录: 根 });
  assert.equal(越界.ok, false);
  assert.equal(越界.事件类型, "artifact_root_violation");

  const 缺路径 = 检查产物根("", { 产物根目录: 根 });
  assert.equal(缺路径.ok, false);
  assert.match(缺路径.违规[0].原因, /缺少产物路径/);
});

test("运行预检：全部通过 / 部分失败整体阻断并列出阻断事件", () => {
  const 工作流 = { preflight: ["geoRange", "recordCount", "artifactRoot"] };
  const 通过 = 运行预检(工作流, {
    坐标点: [{ 经度: 120, 纬度: 30 }],
    记录数: { 声明数: 10, 实际数: 10 },
    产物路径: "out/结果.docx",
    产物选项: { 产物根目录: path.join(process.cwd(), "office-workspace") },
  });
  assert.equal(通过.ok, true, 通过.摘要);
  assert.equal(通过.检查结果.length, 3);

  const 失败 = 运行预检(工作流, {
    坐标点: [{ 经度: 140, 纬度: 30 }],
    记录数: { 声明数: 10, 实际数: 8 },
    产物路径: "../escape.docx",
    产物选项: { 产物根目录: path.join(process.cwd(), "office-workspace") },
  });
  assert.equal(失败.ok, false);
  assert.equal(失败.失败项.length, 3);
  assert.deepEqual(
    [...失败.阻断事件].sort(),
    ["artifact_root_violation", "data_integrity_failed", "geo_out_of_range"],
  );
});

test("运行预检：显式跳过校验走降级分支并留痕 preflight_skipped", () => {
  const 工作流 = { preflight: ["geoRange", "recordCount"] };
  const 跳过 = 运行预检(工作流, { 坐标点: [{ 经度: 140, 纬度: 30 }] }, { 跳过校验: true });
  assert.equal(跳过.ok, true);
  assert.equal(跳过.跳过, true);
  assert.deepEqual(跳过.阻断事件, ["preflight_skipped"]);
});

test("检查器集合与注册表已知预检项一致", () => {
  assert.deepEqual([...检查器名称].sort(), ["artifactRoot", "geoRange", "recordCount", "writeBackGuard"]);
});

test("纯函数无副作用：检查不抛错、不产生文件", () => {
  const 探针 = path.join(process.cwd(), "office-workspace", "_preflight_probe_should_not_exist.txt");
  assert.equal(fs.existsSync(探针), false);
  检查坐标范围([{ 经度: 200, 纬度: 200 }]);
  检查记录数({ 声明数: 1, 实际数: 0 });
  检查写回保护({ 工具: "officecli" });
  检查产物根("../../x", { 产物根目录: path.join(process.cwd(), "office-workspace") });
  assert.equal(fs.existsSync(探针), false);
});

test("工具白名单：越权工具被判定为不允许", () => {
  const 工作流 = { tools: ["read", "map_analyze"] };
  assert.equal(检查工具权限(工作流, "map_analyze"), true);
  assert.equal(检查工具权限(工作流, "bash"), false);
});

console.log(failed ? "\n领域硬约束测试：存在失败" : "\n领域硬约束测试：全部通过");
process.exitCode = failed ? 1 : 0;
