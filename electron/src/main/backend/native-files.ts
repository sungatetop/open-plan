/**
 * 本机原生能力（macOS / Windows / Linux）（S3-15 转录，自 server/native-files.mjs 全文 342 行）。
 *
 * 消费面：旧 index.mjs L36（nativeCapabilities / openWithDefaultApp / pickFiles /
 * pickFolder / revealInFileManager / cancelActivePicker / activePickerInfo 七符号）；
 * 其余导出（resolveWindowsBinary / 纯函数族）供对拍与未来装配复用。
 *
 *   - 文件 / 文件夹选择器（macOS 用 osascript 的 choose file / choose folder；Windows 用 PowerShell 对话框；Linux 尝试 zenity）
 *   - 用默认应用打开文件
 *   - 在文件管理器中显示（macOS Finder / Windows 资源管理器 / Linux 文件管理器）
 *
 * 安全约定：
 *   1. 全程使用 execFile + 参数数组，**不经过 shell**，文件名里的引号/分号/空格都不会被解释；
 *   2. 只接受绝对路径（绝对路径不可能被当成命令行选项）；
 *   3. 调用方在执行前用工作区白名单校验路径。
 *
 * 行为保真说明：
 *  - OAW_NATIVE_PICKER_TIMEOUT_MS 为模块加载期常量（与旧侧一致，env 在加载前注入才生效）；
 *  - 依赖仅 node:child_process / node:fs / node:path，无项目内依赖，静态直绑无循环风险；
 *  - falsy 语义与旧 JS 一致（String(value ?? "") 等）；noUncheckedIndexedAccess 不涉及。
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PICKER_TIMEOUT_MS = Number(process.env.OAW_NATIVE_PICKER_TIMEOUT_MS) || 10 * 60 * 1000;
const ACTION_TIMEOUT_MS = 15 * 1000;

/**
 * Windows 系统二进制按绝对路径解析，不依赖 PATH。
 *
 * 为什么不直接 spawn("explorer")：execFile 不经过 shell，Node 只能靠 PATH 找可执行文件。
 * 而机器级 PATH 一旦缺少 C:\Windows\System32（精简镜像、手工改过、或被工具写坏），
 * explorer / cmd / powershell 会全部以 ENOENT 失败，表现为「打开本地文件」接口 500。
 * 注意 explorer.exe 不在 System32，而在 %SystemRoot% 根目录下，所以要单独兜底。
 */
const WINDOWS_BINARY_NAMES: Record<string, string[]> = {
  explorer: ["explorer.exe"],
  cmd: ["cmd.exe"],
  powershell: ["powershell.exe", "pwsh.exe"],
};

export function resolveWindowsBinary(file: string): string {
  if (process.platform !== "win32") return file;
  const raw = String(file || "");
  if (!raw || path.isAbsolute(raw)) return raw;
  const key = raw.toLowerCase().replace(/\.exe$/i, "");
  const names = WINDOWS_BINARY_NAMES[key] || [`${raw}.exe`];
  const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const dirs = [
    path.join(root, "System32"),
    path.join(root, "System32", "WindowsPowerShell", "v1.0"),
    root,
  ];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {}
    }
  }
  // 找不到就原样返回，保持原有报错路径（PICKER_UNAVAILABLE / REVEAL_FAILED）。
  return raw;
}

export function nativePlatform(): NodeJS.Platform {
  return process.platform;
}

/** 本机能力与界面用词（前端据此显示"Finder / 资源管理器"等平台化措辞）。 */
export function nativeCapabilities() {
  const platform = process.platform;
  if (platform === "darwin") {
    return { platform, picker: true, pickerKind: "osascript", open: true, reveal: true, fileManagerName: "Finder", pickVerb: "从 Finder 选择文件" };
  }
  if (platform === "win32") {
    return { platform, picker: true, pickerKind: "powershell", open: true, reveal: true, fileManagerName: "资源管理器", pickVerb: "从资源管理器选择文件" };
  }
  return { platform, picker: platform === "linux", pickerKind: platform === "linux" ? "zenity" : "none", open: platform === "linux", reveal: platform === "linux", fileManagerName: "文件管理器", pickVerb: "从文件管理器选择文件" };
}

/* ------------------------------ 纯函数（可单测） ------------------------------ */

/** AppleScript 字符串字面量转义。 */
export function appleScriptString(value: unknown): string {
  return `"${String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** 扩展名归一化：接受 "docx" / ".docx" / "*.docx"，去重并保留顺序。 */
export function normalizeExtensions(extensions: unknown): string[] {
  const list = Array.isArray(extensions) ? extensions : [];
  const out: string[] = [];
  for (const item of list) {
    const ext = String(item || "").trim().replace(/^\*?\.?/, "").toLowerCase();
    if (!ext || !/^[a-z0-9]+$/.test(ext)) continue;
    if (!out.includes(ext)) out.push(ext);
  }
  return out;
}

/** 生成 `choose file` 的 -e 参数（不含 osascript 本体）。 */
export function buildPickFilesScript({ prompt = "选择要打开的文件", multiple = false, extensions = [] }: { prompt?: string; multiple?: boolean; extensions?: unknown[] } = {}) {
  const exts = normalizeExtensions(extensions);
  const typeClause = exts.length ? ` of type {${exts.map((ext) => appleScriptString(ext)).join(", ")}}` : "";
  const promptPart = ` with prompt ${appleScriptString(prompt)}`;
  if (!multiple) {
    return ["-e", `set theChoice to choose file${promptPart}${typeClause}`, "-e", "return POSIX path of theChoice"];
  }
  return [
    "-e", `set theChoices to choose file${promptPart}${typeClause} with multiple selections allowed`,
    "-e", "set theOutput to \"\"",
    "-e", "repeat with theFile in theChoices",
    "-e", "set theOutput to theOutput & (POSIX path of theFile) & linefeed",
    "-e", "end repeat",
    "-e", "return theOutput",
  ];
}

/** 生成 `choose folder` 的 -e 参数。 */
export function buildPickFolderScript({ prompt = "选择文件夹" }: { prompt?: string } = {}) {
  return ["-e", `return POSIX path of (choose folder with prompt ${appleScriptString(prompt)})`];
}

/** 解析 osascript 输出：逐行 POSIX 路径（自动跳过空行）。 */
export function parseAppleScriptOutput(stdout: unknown): string[] {
  return String(stdout || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** 用户点了取消（AppleScript 错误码 -128 / User canceled）。 */
export function isAppleScriptCancel(error: unknown): boolean {
  const e = error as { stderr?: string; message?: string } | null | undefined;
  const text = `${e?.stderr || ""} ${e?.message || ""}`;
  return /-128\b|User canceled|用户已取消|\/-1743\b/.test(text);
}

/** 生成 Windows OpenFileDialog 的 PowerShell 脚本（同样用 TopMost owner 保证窗口在前台）。 */
export function buildWindowsPickFilesScript({ prompt = "选择要打开的文件", multiple = false, extensions = [] }: { prompt?: string; multiple?: boolean; extensions?: unknown[] } = {}) {
  const exts = normalizeExtensions(extensions);
  const filter = exts.length
    ? `${exts.join("/")} (${exts.map((ext) => `*.${ext}`).join(";")})|${exts.map((ext) => `*.${ext}`).join(";")}|所有文件 (*.*)|*.*`
    : "所有文件 (*.*)|*.*";
  return [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$owner = New-Object System.Windows.Forms.Form",
    "$owner.TopMost = $true",
    "$owner.ShowInTaskbar = $false",
    "$owner.WindowState = [System.Windows.Forms.FormWindowState]::Minimized",
    "$owner.Show()",
    "$dialog = New-Object System.Windows.Forms.OpenFileDialog",
    `$dialog.Title = ${JSON.stringify(prompt)}`,
    `$dialog.Filter = ${JSON.stringify(filter)}`,
    `$dialog.Multiselect = $(${multiple ? "true" : "false"})`,
    "$result = $dialog.ShowDialog($owner)",
    "$owner.Close()",
    "if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $dialog.FileNames | ForEach-Object { Write-Output $_ } }",
  ].join("; ");
}

/**
 * 生成 Windows 文件夹选择器的 PowerShell 脚本。
 *
 * FolderBrowserDialog 没有 owner 时常常出现在浏览器窗口**后面**，用户看不到就以为
 * "选择文件夹失效了"。这里用一个 TopMost 的隐藏窗体当 owner，把对话框强制带到前台。
 */
export function buildWindowsPickFolderScript({ prompt = "选择文件夹" }: { prompt?: string } = {}) {
  return [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$owner = New-Object System.Windows.Forms.Form",
    "$owner.TopMost = $true",
    "$owner.ShowInTaskbar = $false",
    "$owner.WindowState = [System.Windows.Forms.FormWindowState]::Minimized",
    "$owner.Show()",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    `$dialog.Description = ${JSON.stringify(prompt)}`,
    "$dialog.ShowNewFolderButton = $true",
    "$result = $dialog.ShowDialog($owner)",
    "$owner.Close()",
    "if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Write-Output $dialog.SelectedPath }",
  ].join("; ");
}

function nativeError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

/* ------------------------------ 命令执行 ------------------------------ */

/** 正在等待用户操作的选择器进程（见 runPicker 注释）。 */
interface PickerEntry {
  child: ReturnType<typeof execFile>;
  kind: string;
  startedAt: number;
  cancelled: boolean;
}

/**
 * 正在等待用户操作的选择器进程。系统对话框是独立进程，用户点「取消等待」或再点一次
 * 「选择文件夹」时必须能把它收掉——否则桌面上会留下没人管的弹窗，用户以为界面卡死。
 */
let activePicker: PickerEntry | null = null;

/** 收掉正在等待的选择器进程；返回是否真的收掉了。 */
export function cancelActivePicker(): boolean {
  const current = activePicker;
  activePicker = null;
  if (!current) return false;
  current.cancelled = true;
  try { current.child.kill(); } catch {}
  return true;
}

export function activePickerInfo() {
  if (!activePicker) return null;
  return { kind: activePicker.kind, startedAt: activePicker.startedAt, pid: activePicker.child?.pid || null };
}

/**
 * 运行一个"等待用户操作"的选择器进程（仍走 execFile + 参数数组，不经 shell）。
 * execFile 返回的子进程句柄让我们可以主动收掉对话框：用户点「取消等待」或再点一次
 * 「选择文件夹」时，桌面上不该留下没人管的弹窗。
 */
function runPicker(file: string, args: string[], { timeout = PICKER_TIMEOUT_MS, kind = "" }: { timeout?: number; kind?: string } = {}): Promise<{ stdout: string; stderr: string }> {
  // 新的选择请求先收掉上一个：重复点击不应该在桌面上堆出多个对话框。
  cancelActivePicker();
  return new Promise((resolve, reject) => {
    let entry: PickerEntry | null = null;
    const child = execFile(resolveWindowsBinary(file), args, { timeout: Math.max(5000, timeout), maxBuffer: 1024 * 1024, encoding: "utf8", windowsHide: false }, (error, stdout, stderr) => {
      if (activePicker === entry) activePicker = null;
      if (entry?.cancelled) return reject(nativeError("已取消等待系统选择器", "PICKER_CANCELLED"));
      if (error?.killed) return reject(nativeError("选择器等待超时", "PICKER_TIMEOUT"));
      if (error) {
        error.stderr = stderr;
        return reject(error);
      }
      resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
    entry = { child, kind, startedAt: Date.now(), cancelled: false };
    activePicker = entry;
  });
}

/** 区分「进程根本没起来」与「起来了但退出码非零」。前者 error.code 是字符串系统错误码，后者是数字退出码。 */
function isSpawnFailure(error: unknown): boolean {
  if (!error) return false;
  const e = error as { code?: unknown; syscall?: unknown };
  return typeof e.code === "string" || Boolean(e.syscall);
}

function run(file: string, args: string[], { timeout = ACTION_TIMEOUT_MS, tolerateNonZeroExit = false }: { timeout?: number; tolerateNonZeroExit?: boolean } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(resolveWindowsBinary(file), args, { timeout, maxBuffer: 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        // tolerateNonZeroExit：explorer 这类 shell 进程成功时也会返回非零退出码，
        // 只有 ENOENT / EACCES 这类「压根没启动」才算真失败。
        if (!(tolerateNonZeroExit && !isSpawnFailure(error))) {
          reject(error);
          return;
        }
      }
      resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

/** 原生文件选择器；返回绝对路径数组。用户取消时 canceled=true。 */
export async function pickFiles({ prompt = "选择要打开的文件", multiple = false, extensions = [] }: { prompt?: string; multiple?: boolean; extensions?: unknown[] } = {}): Promise<{ canceled: boolean; paths: string[] }> {
  const capability = nativeCapabilities();
  if (!capability.picker) throw nativeError("当前平台没有可用的原生文件选择器", "PICKER_UNSUPPORTED");
  try {
    if (capability.pickerKind === "osascript") {
      const { stdout } = await runPicker("osascript", buildPickFilesScript({ prompt, multiple, extensions }), { kind: "files" });
      const paths = parseAppleScriptOutput(stdout);
      return paths.length ? { canceled: false, paths } : { canceled: true, paths: [] };
    }
    if (capability.pickerKind === "powershell") {
      const { stdout } = await runPicker("powershell.exe", ["-NoProfile", "-STA", "-Command", buildWindowsPickFilesScript({ prompt, multiple, extensions })], { kind: "files" });
      const paths = parseAppleScriptOutput(stdout);
      return paths.length ? { canceled: false, paths } : { canceled: true, paths: [] };
    }
    // Linux：zenity（未安装则明确报错，不静默失败）
    const args = ["--file-selection", "--separator", "\n", `--title=${prompt}`];
    if (multiple) args.push("--multiple");
    for (const ext of normalizeExtensions(extensions)) args.push(`--file-filter=${ext} | *.${ext}`);
    const { stdout } = await runPicker("zenity", args, { kind: "files" });
    const paths = parseAppleScriptOutput(stdout);
    return paths.length ? { canceled: false, paths } : { canceled: true, paths: [] };
  } catch (error: any) {
    if (error?.code === "PICKER_CANCELLED" || isAppleScriptCancel(error)) return { canceled: true, paths: [] };
    if (error?.code === "ENOENT") throw nativeError(`未找到系统选择器（${capability.pickerKind}）`, "PICKER_UNAVAILABLE");
    if (error?.killed) throw nativeError("选择器等待超时", "PICKER_TIMEOUT");
    throw nativeError(`选择器执行失败：${error?.message || error}`, "PICKER_FAILED");
  }
}

/** 原生文件夹选择器；返回单个绝对路径。 */
export async function pickFolder({ prompt = "选择文件夹" }: { prompt?: string } = {}): Promise<{ canceled: boolean; path: string }> {
  const capability = nativeCapabilities();
  if (!capability.picker) throw nativeError("当前平台没有可用的原生文件夹选择器", "PICKER_UNSUPPORTED");
  try {
    if (capability.pickerKind === "osascript") {
      const { stdout } = await runPicker("osascript", buildPickFolderScript({ prompt }), { kind: "folder" });
      const paths = parseAppleScriptOutput(stdout);
      return paths.length ? { canceled: false, path: paths[0]! } : { canceled: true, path: "" };
    }
    if (capability.pickerKind === "powershell") {
      const { stdout } = await runPicker("powershell.exe", ["-NoProfile", "-STA", "-Command", buildWindowsPickFolderScript({ prompt })], { kind: "folder" });
      const paths = parseAppleScriptOutput(stdout);
      return paths.length ? { canceled: false, path: paths[0]! } : { canceled: true, path: "" };
    }
    const { stdout } = await runPicker("zenity", ["--file-selection", "--directory", `--title=${prompt}`], { kind: "folder" });
    const paths = parseAppleScriptOutput(stdout);
    return paths.length ? { canceled: false, path: paths[0]! } : { canceled: true, path: "" };
  } catch (error: any) {
    if (error?.code === "PICKER_CANCELLED" || isAppleScriptCancel(error)) return { canceled: true, path: "" };
    if (error?.code === "ENOENT") throw nativeError(`未找到系统选择器（${capability.pickerKind}）`, "PICKER_UNAVAILABLE");
    if (error?.killed) throw nativeError("选择器等待超时", "PICKER_TIMEOUT");
    throw nativeError(`选择器执行失败：${error?.message || error}`, "PICKER_FAILED");
  }
}

/** 用系统默认应用打开文件（只接受绝对路径）。 */
export async function openWithDefaultApp(absPath: unknown): Promise<{ ok: boolean; path: string }> {
  const target = String(absPath || "");
  if (!path.isAbsolute(target)) throw nativeError("需要绝对路径", "PATH_NOT_ABSOLUTE");
  try {
    // 放在 try 内，让外层统一包装成「打开失败：…」保持既有错误契约。
    if (!fs.existsSync(target)) throw new Error("文件不存在");
    if (process.platform === "darwin") await run("open", [target]);
    else if (process.platform === "win32") await run("cmd", ["/c", "start", "", target]);
    else await run("xdg-open", [target]);
    return { ok: true, path: target };
  } catch (error: any) {
    throw nativeError(`打开失败：${error?.message || error}`, "OPEN_FAILED");
  }
}

/** 在文件管理器中显示（macOS 选中该文件）。 */
export async function revealInFileManager(absPath: unknown): Promise<{ ok: boolean; path: string }> {
  const target = String(absPath || "");
  if (!path.isAbsolute(target)) throw nativeError("需要绝对路径", "PATH_NOT_ABSOLUTE");
  // explorer 成功时也会返回非零退出码，所以「路径不存在」必须在这里显式挡掉，
  // 不能指望退出码——否则不存在的路径会被当成成功，白白弹一次资源管理器。
  // 放在 try 内，让外层统一包装成「在文件管理器中显示失败：…」。
  try {
    if (!fs.existsSync(target)) throw new Error("文件不存在");
    if (process.platform === "darwin") await run("open", ["-R", target]);
    else if (process.platform === "win32") await run("explorer", [`/select,${target}`], { tolerateNonZeroExit: true });
    else await run("xdg-open", [path.dirname(target)]);
    return { ok: true, path: target };
  } catch (error: any) {
    throw nativeError(`在文件管理器中显示失败：${error?.message || error}`, "REVEAL_FAILED");
  }
}
