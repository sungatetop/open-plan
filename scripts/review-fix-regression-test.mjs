#!/usr/bin/env node
/**
 * Review 报错修复回归：officecli 参数处理 + 临时文件卫生 + 输入区布局
 *
 * 起因：一次 Review 运行里出现 8 条 officecli_failed，逐条定位到：
 *   1. view <file> summary —— 工具说明里写了不存在的模式（真实模式只有 text/annotated/outline/stats/issues/html/svg/screenshot/forms）；
 *   2. view html -o .work/review.html —— officecli 不创建输出目录，父目录不存在就直接失败；
 *   3. add --prop author=\"规聚 Agent\" —— 模型照抄说明里的转义引号，参数被空格切成两个 token；
 *   4. add --type markdown --prop src=报告.md —— 引用写成 key=value，物化时按 "src=报告.md" 找文件，暂存文件永远找不到；
 *   5. 82MB 的 .work-review.html 留在工作区 —— 临时文件规则只认 .work/ 目录，不认 .work-* 文件。
 * 另修：任务卡被渲染在输入框内部（"被吞进去"）+ 忙时输入框把对话区压到几十像素。
 *
 * 用法: node scripts/review-fix-regression-test.mjs
 * 退出码: 0 = 全部通过, 1 = 有失败
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { collectReferencedPaths, ensureOfficeOutputDirs, parseOfficeArgs } from "../server/office-params.mjs";
import { isTempWorkPath } from "../server/write-coordination.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let failed = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const bad = (msg) => { console.error(`  ✗ ${msg}`); failed = 1; };
function 场景(name, fn) {
  try { fn(); ok(name); } catch (e) { bad(`${name}: ${e.message}`); }
}

// ============================================================
// 1. 参数分词：转义引号不能再切坏
// ============================================================
场景("分词：普通写法不受影响", () => {
  assert.deepEqual(parseOfficeArgs("view 报告.docx text"), ["view", "报告.docx", "text"]);
  assert.deepEqual(parseOfficeArgs("get 报告.docx /body/p[3] --json"), ["get", "报告.docx", "/body/p[3]", "--json"]);
  assert.deepEqual(parseOfficeArgs("add 报告.docx / --type paragraph --prop text=一句话"), ["add", "报告.docx", "/", "--type", "paragraph", "--prop", "text=一句话"]);
});

场景("分词：引号（含反斜杠转义）里的空格不再切坏 token", () => {
  const expected = ["add", "报告.docx", "/body/p[3]", "--type", "comment", "--prop", "author=规聚 Agent", "--prop", "initials=OA", "--prop", "text=请核对这段内容"];
  assert.deepEqual(parseOfficeArgs('add 报告.docx /body/p[3] --type comment --prop "author=规聚 Agent" --prop initials=OA --prop "text=请核对这段内容"'), expected);
  // 模型照抄说明里的转义写法（本次线上失败的真实输入）
  assert.deepEqual(parseOfficeArgs('add 报告.docx /body/p[3] --type comment --prop author=\\"规聚 Agent\\" --prop initials=OA --prop text=\\"请核对这段内容\\"'), expected);
  assert.deepEqual(parseOfficeArgs("add 报告.docx / --prop text='含 空格 的值'"), ["add", "报告.docx", "/", "--prop", "text=含 空格 的值"]);
});

场景("分词：输出路径带引号也保持一个 token", () => {
  assert.deepEqual(parseOfficeArgs('view 报告.docx html -o ".work/review.html"'), ["view", "报告.docx", "html", "-o", ".work/review.html"]);
});

场景("分词：--prop 的裸值带空格时并回同一个值（模型常忘加引号）", () => {
  // 线上实测：--prop author=规聚 Agent 被切成两个 token → Invalid --prop 'Agent': expected key=value
  assert.deepEqual(
    parseOfficeArgs("add 验证.docx /body/p[1] --type comment --prop author=规聚 Agent --prop initials=OA --prop text=请核对这段内容"),
    ["add", "验证.docx", "/body/p[1]", "--type", "comment", "--prop", "author=规聚 Agent", "--prop", "initials=OA", "--prop", "text=请核对这段内容"],
  );
  // 值后面的选项不能被吞进去
  assert.deepEqual(
    parseOfficeArgs("add 报告.docx / --type paragraph --prop text=一句话 --json"),
    ["add", "报告.docx", "/", "--type", "paragraph", "--prop", "text=一句话", "--json"],
  );
  // 多个 prop 连写时互不影响
  assert.deepEqual(
    parseOfficeArgs("set 报告.docx / --prop bold=true --prop color=red"),
    ["set", "报告.docx", "/", "--prop", "bold=true", "--prop", "color=red"],
  );
});

// ============================================================
// 2. 暂存文件引用：key=value 要剥掉前缀
// ============================================================
场景("引用收集：--prop src= / path= 要剥前缀，物化才能命中暂存文件", () => {
  // 文档自身也算被引用（物化它无害），关键是 key= 前缀必须剥掉，否则永远找不到暂存文件
  assert.deepEqual(collectReferencedPaths(["add", "报告.docx", "/", "--type", "markdown", "--prop", "src=审查报告_汇总.md"]), ["报告.docx", "审查报告_汇总.md"]);
  assert.deepEqual(collectReferencedPaths(["set", "数据.xlsx", "/", "--prop", "path=输入/明细.csv"]), ["数据.xlsx", "输入/明细.csv"]);
  assert.deepEqual(collectReferencedPaths(["batch", "报告.docx", "--input", ".work/docx-body.json"]), ["报告.docx", ".work/docx-body.json"]);
  // 选项与绝对路径都不算"被引用的暂存文件"
  assert.deepEqual(collectReferencedPaths(["view", "报告.docx", "text", "--json"]), ["报告.docx"]);
  assert.deepEqual(collectReferencedPaths(["get", "C:/tmp/绝对路径.docx"]), []);
});

// ============================================================
// 3. 输出目录：-o 指向不存在的目录要先建好
// ============================================================
场景("输出目录：-o 目标父目录自动创建（工作区内）", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "office-outdir-"));
  try {
    const created = ensureOfficeOutputDirs(["view", "报告.docx", "html", "-o", ".work/review.html"], sandbox);
    assert.deepEqual(created, [".work"]);
    assert.ok(fs.existsSync(path.join(sandbox, ".work")));
    // 已存在时不重复创建
    assert.deepEqual(ensureOfficeOutputDirs(["view", "报告.docx", "html", "-o", ".work/review.html"], sandbox), []);
    // 越界与绝对路径不处理
    assert.deepEqual(ensureOfficeOutputDirs(["view", "x.docx", "html", "-o", "../outside/x.html"], sandbox), []);
    assert.deepEqual(ensureOfficeOutputDirs(["view", "x.docx", "html", "-o", "C:/tmp/x.html"], sandbox), []);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

// ============================================================
// 4. 临时文件卫生：.work-* 平铺文件也要算临时
// ============================================================
场景("临时文件：.work/ 与 .work-* 都算临时，正常文件不受影响", () => {
  for (const temp of [".work/x.json", ".work-review.html", ".tmp-report.md", ".cache/data.json", ".ch6work/notes.md", "报告.docx.bak", "数据~"]) {
    assert.equal(isTempWorkPath(temp), true, `${temp} 应判为临时文件`);
  }
  for (const keep of ["报告.docx", "审查副本/批注稿.docx", "审查报告_汇总.md", ".agent-context.md", ".template.docx", "template.docx"]) {
    assert.equal(isTempWorkPath(keep), false, `${keep} 不应判为临时文件`);
  }
});

// ============================================================
// 5. 工具说明与界面布局
// ============================================================
场景("工具说明：不再教模型用不存在的 view summary，也不再示范转义引号", () => {
  const agent = read("server/agent.mjs");
  assert.doesNotMatch(agent, /view <file> summary/, "说明里不能再出现不存在的 summary 模式");
  assert.match(agent, /VIEW MODES: 'view <file> <mode>' where mode is exactly one of text, annotated, outline, stats, issues, html, svg, screenshot, forms/);
  assert.match(agent, /there is NO 'summary' mode/);
  assert.doesNotMatch(agent, /--prop author=\\\\?"规聚 Agent\\\\?"/, "示例不能再写转义引号");
  assert.match(agent, /--prop author=规聚Agent/, "批注示例要给出可直接用的写法");
  assert.match(agent, /do NOT wrap them in escaped quotes/);
  assert.match(agent, /parent folders are created for you/, "要说明 -o 的父目录会被创建");
  assert.match(agent, /System\.Private\.Xml/, "officecli 安装目录半更新导致的程序集错误要给出处理方式");
});

场景("输入区布局：任务卡在输入框之外，对话区有高度下限", () => {
  const panel = read("client/src/components/ChatPanel.jsx");
  const css = read("client/src/styles.css");
  assert.match(panel, /<div className="chat-compose">/, "任务卡与输入框要有共同外壳");
  const composeAt = panel.indexOf('<div className="chat-compose">');
  const cardAt = panel.indexOf("<TaskProgressCard", composeAt);
  const inputAt = panel.indexOf('<div className="chat-input">', composeAt);
  assert.ok(cardAt > 0 && inputAt > cardAt, "任务卡要排在输入框之前（在输入框外面）");
  assert.match(css, /\.center-chat-slot \.chat-compose \{/);
  assert.match(css, /\.center-chat-slot \.chat-compose > \.task-card \{/, "任务卡样式挂到新外壳上");
  assert.doesNotMatch(css, /\.chat-input > \.task-card/, "旧的「输入框内任务卡」选择器应已移除");
  assert.match(css, /\.center-chat-slot \.chat-body \{ min-height: 120px; \}/, "对话区要有高度下限");
  assert.match(css, /@media \(max-height: 560px\)[\s\S]{0,200}\.chat-target-bar \{ display: none; \}/, "矮窗口先收起目标范围行");
  assert.match(css, /@media \(max-height: 470px\)[\s\S]{0,120}\.busy-input-mode \{ display: none; \}/, "更矮时收起忙时提示行");
});

场景("任务清单弹层：按卡片上方可用空间夹取高度，不再被外层裁掉", () => {
  const panel = read("client/src/components/ChatPanel.jsx");
  assert.match(panel, /const \[panelMaxHeight, setPanelMaxHeight\] = useState\(260\)/);
  assert.match(panel, /const available = card\.getBoundingClientRect\(\)\.top - clipTop - 12;/);
  assert.match(panel, /window\.addEventListener\("resize", measure\)/, "窗口尺寸变化后要重算，否则缩放窗口又会裁到");
  assert.match(panel, /setPanelMaxHeight\(Math\.max\(96, Math\.min\(260, Math\.round\(available\)\)\)\)/);
  assert.match(panel, /<div className="task-body" style=\{\{ maxHeight: panelMaxHeight \}\}>/);
});

console.log(failed ? "\n有失败项 ✗" : "\n全部通过 ✓");
process.exit(failed ? 1 : 0);
