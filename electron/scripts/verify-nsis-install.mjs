/**
 * R6-8 NSIS 打包安装验证：
 *   node scripts/verify-nsis-install.mjs --exe <应用exe>          验证已落地的 exe（win-unpacked 或已安装）
 *   node scripts/verify-nsis-install.mjs --setup <安装包exe>      先 /S 静默安装，再验证默认安装位
 * 复用 smoke 锚点：OP_DESKTOP_SMOKE=1 启动，断言 stdout 出现 SMOKE_NEW_UI_OK 且退出码 0；
 * 每次注入一次性 userData（OP_DESKTOP_USER_DATA），不污染用户配置。
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
function argOf(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

// electron-builder NSIS per-user 默认安装目录锚 package.json name（非 productName）
const NSIS_DEFAULT = path.join(process.env.LOCALAPPDATA || "", "Programs", "guiju-desktop", "规聚.exe");
let targetExe = argOf("--exe");
const setupExe = argOf("--setup");

if (setupExe) {
  if (!fs.existsSync(setupExe)) fail(`安装包不存在：${setupExe}`);
  console.log(`静默安装：${setupExe}`);
  execFileSync(setupExe, ["/S"], { timeout: 180_000, windowsHide: true });
  targetExe = argOf("--exe") || NSIS_DEFAULT;
  // NSIS 安装尾进程可能短暂延迟
  for (let i = 0; i < 20 && !fs.existsSync(targetExe); i++) wait(500);
  if (!fs.existsSync(targetExe)) fail(`安装后未找到应用：${targetExe}`);
  console.log(`已安装：${targetExe}`);
}

if (!targetExe) {
  console.log("用法：node scripts/verify-nsis-install.mjs --exe <应用exe> | --setup <安装包exe> [--exe <覆盖安装位>]");
  process.exit(2);
}
if (!fs.existsSync(targetExe)) fail(`目标 exe 不存在：${targetExe}`);

probeTilerChain(path.resolve(targetExe));

/** tiler 物理链探测：electron-builder.yml node_modules 白名单的门禁兜底，
 * ELECTRON_RUN_AS_NODE 在应用根解析 geojson-vt/vt-pbf（runScript 子进程同款环境）。 */
function probeTilerChain(exe) {
  const appDir = path.join(path.dirname(exe), "resources", "app");
  if (!fs.existsSync(appDir)) fail(`应用根不存在：${appDir}`);
  const probe = "import('geojson-vt').then(() => import('vt-pbf')).then(() => console.log('TILER_CHAIN_OK')).catch((e) => { console.error(String(e)); process.exit(1); })";
  let out;
  try {
    out = execFileSync(exe, ["-e", probe], {
      cwd: appDir,
      timeout: 60_000,
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      encoding: "utf8"
    });
  } catch (e) {
    fail(`tiler 链探测失败：\n${e.stdout || ""}${e.stderr || e.message}`);
  }
  if (!out.includes("TILER_CHAIN_OK")) fail(`tiler 链探测无锚点输出：${out}`);
  console.log("tiler 链探测：TILER_CHAIN_OK");
}

runSmoke(path.resolve(targetExe));

function wait(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function fail(msg) {
  console.error(`\n===== verify FAILED =====\n${msg}`);
  process.exit(1);
}

function runSmoke(exe) {
  const smokeUserData = fs.mkdtempSync(path.join(os.tmpdir(), "guiju-verify-"));
  const child = spawn(exe, [], {
    env: { ...process.env, OP_DESKTOP_SMOKE: "1", OP_DESKTOP_USER_DATA: smokeUserData, ELECTRON_ENABLE_LOGGING: "0" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });

  let settled = false;
  let output = "";
  const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS || 180000);
  const timer = setTimeout(() => finish(false, `超时（${Math.round(timeoutMs / 1000)}s）`), timeoutMs);

  child.stdout.on("data", (chunk) => {
    output += String(chunk);
    if (output.includes("SMOKE_NEW_UI_OK")) finish(true, output.trim().split(/\r?\n/).slice(-3).join("\n"));
    if (output.includes("SMOKE_FAIL") || output.includes("SMOKE_NEW_UI_FAIL")) finish(false, output.trim().split(/\r?\n/).slice(-5).join("\n"));
  });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  child.on("exit", (code) => {
    if (!settled) finish(false, `应用提前退出（code=${code}）\n${output.slice(-800)}`);
  });

  function finish(ok, detail) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    try { if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }); else child.kill("SIGKILL"); } catch { /* 已退出 */ }
    try { fs.rmSync(smokeUserData, { recursive: true, force: true }); } catch { /* 占用残留下次系统清理 */ }
    console.log(`\n===== verify ${ok ? "PASSED" : "FAILED"} =====\n${detail}`);
    process.exit(ok ? 0 : 1);
  }
}
