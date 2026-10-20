/**
 * R1 等价壳冒烟：以 OP_DESKTOP_SMOKE=1 启动 Electron 应用，
 * 主进程用自带 Node 拉起旧 server 并等待 /api/status 就绪后输出 SMOKE_OK 并退出。
 * 断言输出包含 SMOKE_OK 且进程退出码为 0。
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electronBin = require("electron");
const here = path.dirname(fileURLToPath(import.meta.url));

const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS || 180000);
const child = spawn(electronBin, ["."], {
  cwd: path.resolve(here, ".."),
  env: { ...process.env, OP_DESKTOP_SMOKE: "1", ELECTRON_ENABLE_LOGGING: "0" },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});

let settled = false;
let output = "";
const timer = setTimeout(() => finish(false, `超时（${Math.round(timeoutMs / 1000)}s）`), timeoutMs);

child.stdout.on("data", (chunk) => {
  output += String(chunk);
  if (output.includes("SMOKE_OK")) finish(true, output.trim().split(/\r?\n/).slice(-3).join("\n"));
  if (output.includes("SMOKE_FAIL")) finish(false, output.trim().split(/\r?\n/).slice(-5).join("\n"));
});
child.stderr.on("data", (chunk) => { output += String(chunk); });
child.on("exit", (code) => {
  if (!settled) finish(false, `Electron 提前退出（code=${code}）\n${output.slice(-800)}`);
});

function finish(ok, detail) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  try { if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }); else child.kill("SIGKILL"); } catch { /* 已退出 */ }
  console.log(`\n===== smoke ${ok ? "PASSED" : "FAILED"} =====\n${detail}`);
  process.exit(ok ? 0 : 1);
}
