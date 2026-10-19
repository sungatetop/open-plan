#!/usr/bin/env node
/**
 * CI 里跑单个测试脚本的包装器。
 *
 * 为什么需要：本仓库的 Actions 日志需要登录才能读（匿名只能拿到 check-run 的注解），
 * 于是"CI 红了但看不到哪条断言失败"会一直卡住排查。这里在测试失败时把输出尾部
 * 用 GitHub 注解（::error::）打出来——注解是匿名可读的，失败原因就能直接看到。
 *
 * 用法: node scripts/ci-runner.mjs <测试脚本名>（不带 .mjs）
 * 退出码与测试脚本保持一致。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const suite = String(process.argv[2] || "").trim();
if (!suite) {
  console.error("用法: node scripts/ci-runner.mjs <测试脚本名>");
  process.exit(2);
}
const target = path.join(ROOT, "scripts", `${suite}.mjs`);
if (!fs.existsSync(target)) {
  console.error(`测试脚本不存在: ${target}`);
  process.exit(2);
}

const child = spawn(process.execPath, [target], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
child.stdout.on("data", (chunk) => { const text = chunk.toString(); output += text; process.stdout.write(text); });
child.stderr.on("data", (chunk) => { const text = chunk.toString(); output += text; process.stderr.write(text); });

child.on("exit", (code) => {
  if ((code ?? 1) === 0) process.exit(0);
  // 失败时把关键行转成注解：失败的断言优先，其次输出尾部
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const failures = lines.filter((line) => line.includes("✗") || /\b(Error|error:)/.test(line));
  const picked = (failures.length ? failures : lines.slice(-12)).slice(0, 12);
  for (const line of picked) {
    const safe = line.replace(/%/g, "%25").replace(/\r?\n/g, " ").slice(0, 600);
    process.stdout.write(`::error title=${suite}::${safe}\n`);
  }
  process.exit(code ?? 1);
});
