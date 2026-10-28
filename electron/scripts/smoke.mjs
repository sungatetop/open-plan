/**
 * 桌面端冒烟：以 OP_DESKTOP_SMOKE=1 启动 Electron 应用。
 * R6-1 起新 UI（app 页）为默认形态：主进程拉起本地服务，就绪并完成 agent 域
 * 装配（AGENT_DOMAIN_ASSEMBLED）后加载 app 页，断言 React 挂载输出 SMOKE_NEW_UI_OK 退出。
 * 断言输出包含对应锚点且进程退出码为 0。
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electronBin = require("electron");
const here = path.dirname(fileURLToPath(import.meta.url));

const expectedAnchor = "SMOKE_NEW_UI_OK";
const failAnchors = ["SMOKE_FAIL", "SMOKE_NEW_UI_FAIL"];

const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS || 180000);
// 每次运行注入一次性 userData 临时目录（OP_DESKTOP_USER_DATA）：单例锁/窗口态/
// 本地存储不落 %APPDATA%，运行完即清——不污染用户配置，也兼容受限环境。
const smokeUserData = fs.mkdtempSync(path.join(os.tmpdir(), "guiju-smoke-"));
const child = spawn(electronBin, ["."], {
  cwd: path.resolve(here, ".."),
  env: { ...process.env, OP_DESKTOP_SMOKE: "1", OP_DESKTOP_USER_DATA: smokeUserData, ELECTRON_ENABLE_LOGGING: "0" },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});

let settled = false;
let output = "";
const timer = setTimeout(() => finish(false, `超时（${Math.round(timeoutMs / 1000)}s）`), timeoutMs);

child.stdout.on("data", (chunk) => {
  output += String(chunk);
  if (output.includes(expectedAnchor)) finish(true, output.trim().split(/\r?\n/).slice(-3).join("\n"));
  if (failAnchors.some((anchor) => output.includes(anchor))) finish(false, output.trim().split(/\r?\n/).slice(-5).join("\n"));
});
child.stderr.on("data", (chunk) => { output += String(chunk); });
child.on("exit", (code) => {
  if (!settled) finish(false, `Electron 提前退出（code=${code}）\n${output.slice(-800)}`);
});

function cleanupUserData() {
  try { fs.rmSync(smokeUserData, { recursive: true, force: true }); } catch { /* 占用残留下次系统清理 */ }
}

function finish(ok, detail) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  try { if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }); else child.kill("SIGKILL"); } catch { /* 已退出 */ }
  cleanupUserData();
  console.log(`\n===== smoke ${ok ? "PASSED" : "FAILED"} =====\n${detail}`);
  process.exit(ok ? 0 : 1);
}
