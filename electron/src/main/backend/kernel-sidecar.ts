/**
 * U5：内核侧车（bash 进程隔离执行管理器）。
 *
 * 评审 R6 后的收敛定位：
 *   - SDK `RpcCommand` 全集不含 customTools 注册，"会话整体迁入常驻子进程"静态 No-Go；
 *   - 本模块交付**可用的最小隔离层**：bash 命令经由统一管理器 spawn 到独立进程执行
 *     （与 createLocalBashOperations 同构的进程模型），叠加并发上限、执行统计与
 *     崩溃计数——为第二阶段 DSH sidecar（C1 内核侧车）提供同构的生命周期/统计基建；
 *   - 常驻 RPC 子进程形态留待 SDK RPC 扩展 customTools 命令后升级（见《优化方案》U5）。
 *
 * flag：OAW_PI_SIDECAR=on 时 agent.mjs 的 bash operations 改经本管理器执行；
 * off（默认）时走 createLocalBashOperations 原路径，行为与基线一致。
 *
 * 逐行等价迁移自 server/kernel-sidecar.mjs（B2-10）。零依赖（仅 node:child_process），
 * 无 env 锚点、无文件 IO；模块级单例 sharedManager 与旧实现同构（getBashSidecar 同侧 toBe）。
 */
import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 120000;
const MAX_CONCURRENCY = 4;

export interface SidecarSnapshot {
  maxConcurrency: number;
  total: number;
  failed: number;
  timeout: number;
  active: number;
  lastMs: number | null;
  totalMs: number;
  avgMs: number | null;
}

export interface SidecarExecuteResult {
  code: number;
  stdout: string;
  stderr: string;
  ms: number;
  killed: boolean;
}

export class BashSidecarManager {
  maxConcurrency: number;
  defaultTimeoutMs: number;
  stats: { total: number; failed: number; timeout: number; active: number; lastMs: number | null; totalMs: number };
  waiting: Array<(granted: boolean) => void>;

  constructor({ maxConcurrency = MAX_CONCURRENCY, defaultTimeoutMs = DEFAULT_TIMEOUT_MS }: { maxConcurrency?: number; defaultTimeoutMs?: number } = {}) {
    this.maxConcurrency = Math.max(1, Number(maxConcurrency) || MAX_CONCURRENCY);
    this.defaultTimeoutMs = Number(defaultTimeoutMs) || DEFAULT_TIMEOUT_MS;
    this.stats = { total: 0, failed: 0, timeout: 0, active: 0, lastMs: null, totalMs: 0 };
    this.waiting = [];
  }

  snapshot(): SidecarSnapshot {
    return {
      maxConcurrency: this.maxConcurrency,
      ...this.stats,
      avgMs: this.stats.total ? Math.round(this.stats.totalMs / this.stats.total) : null,
    };
  }

  _acquire(): Promise<unknown> {
    if (this.stats.active < this.maxConcurrency) {
      this.stats.active += 1;
      return Promise.resolve();
    }
    // resolve 以 unknown 形参身份入 waiting（next(true) 旧语义保留，值被 Promise await 忽略）
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  _release(): void {
    this.stats.active = Math.max(0, this.stats.active - 1);
    const next = this.waiting.shift();
    if (next) {
      this.stats.active += 1;
      next(true);
    }
  }

  /**
   * 在独立进程内执行一条 shell 命令（Windows: cmd /c；类 Unix: sh -c）。
   * 返回 { code, stdout, stderr, ms, killed }；超时强杀并计入 timeout 统计。
   */
  execute(command: string, { cwd, timeoutMs, env }: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {}): Promise<SidecarExecuteResult> {
    const commandText = String(command || "");
    if (!commandText.trim()) return Promise.resolve({ code: 1, stdout: "", stderr: "empty command", ms: 0, killed: false });
    const started = Date.now();
    return this._acquire().then(() => new Promise<SidecarExecuteResult>((resolve) => {
      const isWindows = process.platform === "win32";
      const child = spawn(isWindows ? "cmd.exe" : "sh", isWindows ? ["/d", "/s", "/c", commandText] : ["-c", commandText], {
        cwd: cwd || process.cwd(),
        env: { ...process.env, ...env },
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let killed = false;
      let settled = false;
      const timer = setTimeout(() => {
        killed = true;
        try { child.kill("SIGKILL"); } catch {}
      }, Number(timeoutMs) || this.defaultTimeoutMs);
      child.stdout?.on("data", (chunk) => { stdout += chunk; });
      child.stderr?.on("data", (chunk) => { stderr += chunk; });
      const finish = (code: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const ms = Date.now() - started;
        this.stats.total += 1;
        this.stats.totalMs += ms;
        this.stats.lastMs = ms;
        if (killed) this.stats.timeout += 1;
        if (code !== 0) this.stats.failed += 1;
        this._release();
        // 输出裁剪与 truncateHead 语义对齐（防长输出洪水）。
        resolve({ code, stdout: stdout.slice(-200000), stderr: stderr.slice(-60000), ms, killed });
      };
      // 旧行为：error 分支先 finish(1)（resolve 参数在 stderr 追加前构造）再追加错误消息——
      // resolve 已定，追加对返回值无效；等价改写为顺序语句（TS1345：void 不可真值测试）。
      child.on("error", (error) => {
        finish(1);
        stderr += String(error?.message || error);
      });
      child.on("close", (code) => finish(Number(code ?? (killed ? 124 : 1))));
    }));
  }
}

let sharedManager: BashSidecarManager | null = null;

/** 进程内共享实例（agent.mjs bash operations 使用）。 */
export function getBashSidecar(): BashSidecarManager {
  if (!sharedManager) sharedManager = new BashSidecarManager();
  return sharedManager;
}
