#!/usr/bin/env node
/**
 * Review 修复端到端验证：跑一次真实 Agent 回合，覆盖本次修掉的三类 officecli 失败。
 *
 * 提示词刻意要求：
 *   1. 新建 docx（正常路径）
 *   2. 把文档导出 HTML 到 .work/export.html —— 父目录不存在（修复前必失败：Could not find a part of the path）
 *   3. 给段落加批注，作者写成「规聚 Agent」（含空格）—— 修复前参数被切成两个 token 必失败
 * 验收：Run 无 officecli_failed 事件、导出文件确实生成、批注可回读、工作区不留临时文件。
 *
 * 用法: node scripts/review-fix-e2e-verify.mjs
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OFFICECLI } from "../server/workspace.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "http://127.0.0.1:3002";

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-review-e2e-"));
const client = `e2e-review-${Date.now().toString(36)}`;
const thread = `thread-e2e-${Date.now().toString(36)}`;
const out = [];
const log = (line) => { out.push(line); console.log(line); };

const runOfficecli = (args) => new Promise((resolve) => {
  execFile(OFFICECLI, args, { cwd: workspace, timeout: 60000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
    resolve({ code: error?.code ?? 0, text: `${stdout || ""}${stderr || ""}` });
  });
});

log(`工作区: ${workspace}`);

const prompt = [
  "请按顺序完成三步，并在每步之间用一句话说明结果：",
  "1) 用 officecli 在当前工作区新建 `验证.docx`，写入标题「端到端验证」和一段正文「这是用于验证 officecli 修复的正文段落。」；",
  "2) 用 officecli 把 `验证.docx` 导出成 HTML，输出路径写 `.work/export.html`（注意 .work 目录可能不存在，请直接用这个输出路径，不要手工建目录）；",
  "3) 用 officecli 给正文那一段加一条批注，作者写成 `规聚 Agent`（作者名里有一个空格），批注内容「请核对这段正文」。",
  "全部完成后用 query comment --json 回读批注确认，并报告三步是否都成功。",
].join("\n");

const response = await fetch(`${BASE}/api/agent/prompt`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ client, thread, text: prompt, task: { workspace, mode: "review" } }),
});
const accepted = await response.json();
log(`prompt 受理: ${response.status} ${JSON.stringify(accepted).slice(0, 200)}`);

// 轮询 Run 状态直到结束
const deadline = Date.now() + 8 * 60 * 1000;
let runId = accepted?.runId || accepted?.run?.id || null;
let status = "";
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 5000));
  const list = await (await fetch(`${BASE}/api/runs?limit=5`)).json();
  const mine = (list.runs || []).find((r) => r.threadId === thread || (runId && r.id === runId));
  if (!mine) continue;
  runId = mine.id;
  status = mine.status;
  if (!["running", "queued", "waiting_user", "recovering", "cancel_requested"].includes(status)) break;
}
log(`Run: ${runId || "(未找到)"} 状态: ${status || "(超时)"}`);

if (runId) {
  const detail = await (await fetch(`${BASE}/api/runs/${runId}`)).json();
  const run = detail.run || detail;
  const events = Array.isArray(run.events) ? run.events : [];
  const failures = events.filter((e) => e.type === "officecli_failed");
  log(`事件数 ${events.length}｜officecli_failed ${failures.length} 条`);
  for (const f of failures) log(`  ✗ ${JSON.stringify(f.data || {}).slice(0, 300)}`);
  const materialized = events.filter((e) => e.type === "artifact_materialized").map((e) => `${e.data?.reason}: ${(e.data?.paths || []).join(",")}`);
  log(`物化事件: ${materialized.join(" | ") || "(无)"}`);
  log(`完成状态: ${run.completion?.status || run.status}｜产物 ${(run.artifacts || []).length} 个`);
}

// 直接检查磁盘结果
const docPath = path.join(workspace, "验证.docx");
const exportPath = path.join(workspace, ".work", "export.html");
log(`验证.docx 存在: ${fs.existsSync(docPath)}`);
log(`.work/export.html 存在: ${fs.existsSync(exportPath)}${fs.existsSync(exportPath) ? ` (${Math.round(fs.statSync(exportPath).size / 1024)}KB)` : ""}`);
if (fs.existsSync(docPath)) {
  const comments = await runOfficecli(["query", "验证.docx", "comment", "--json"]);
  log(`批注回读: exit=${comments.code} ${comments.text.replace(/\s+/g, " ").slice(0, 260)}`);
  await runOfficecli(["close", "验证.docx"]);
}
log(`收尾工作区内容: ${fs.readdirSync(workspace).join(", ") || "(空)"}`);

fs.writeFileSync(path.join(ROOT, "scripts/_tmp_e2e_result.txt"), out.join("\n"), "utf8");
try { fs.rmSync(workspace, { recursive: true, force: true }); } catch {}
