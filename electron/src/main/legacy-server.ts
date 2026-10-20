import { spawn, execFile, type ChildProcess } from "node:child_process";
import path from "node:path";
import { waitForServerReady, type ServerProbe } from "./util/wait";

export interface ServerStatusSnapshot {
  phase: "starting" | "ready" | "failed" | "stopped";
  port?: number;
  message?: string;
  logTail?: string[];
}

export interface LegacyServerHandle {
  readonly port: number;
  readonly ready: Promise<ServerProbe>;
  status: ServerStatusSnapshot;
  stop(): Promise<void>;
}

const LOG_RING_LIMIT = 200;

/**
 * R1 过渡形态：以 Electron 自带 Node（ELECTRON_RUN_AS_NODE）运行现有 server/index.mjs，
 * 仅绑定 127.0.0.1；后续里程碑按域把业务收进主进程后逐步退役本模块。
 */
export function startLegacyServer(projectRoot: string, port: number): LegacyServerHandle {
  const serverEntry = path.join(projectRoot, "server", "index.mjs");
  const logRing: string[] = [];
  const status: ServerStatusSnapshot = { phase: "starting", port };

  const child: ChildProcess = spawn(
    process.execPath,
    [serverEntry],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        PORT: String(port),
        HOST: "127.0.0.1",
        OAW_DESKTOP: "1"
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    }
  );

  const pushLog = (chunk: Buffer | string) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line.trim()) continue;
      logRing.push(line);
      if (logRing.length > LOG_RING_LIMIT) logRing.shift();
    }
  };
  child.stdout?.on("data", pushLog);
  child.stderr?.on("data", pushLog);

  let settleStop: (() => void) | null = null;
  const stopped = new Promise<void>((resolve) => { settleStop = resolve; });
  let stopRequested = false;

  child.on("exit", (code) => {
    if (!stopRequested) {
      status.phase = "failed";
      status.message = `本地服务异常退出（code=${code ?? "null"}）`;
      status.logTail = logRing.slice(-20);
    }
    settleStop?.();
  });

  const ready = waitForServerReady(`http://127.0.0.1:${port}/api/status`, 120_000).then((probe) => {
    if (probe.ok) {
      status.phase = "ready";
      status.message = "本地服务就绪";
    } else if (status.phase === "starting") {
      status.phase = "failed";
      status.message = probe.error ?? "本地服务启动失败";
      status.logTail = logRing.slice(-20);
    }
    return probe;
  });

  const stop = async (): Promise<void> => {
    stopRequested = true;
    if (child.exitCode !== null || child.signalCode !== null) return stopped;
    if (process.platform === "win32") {
      await new Promise<void>((resolve) => {
        execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => resolve());
      });
    } else {
      child.kill("SIGTERM");
      const forceTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* 已退出 */ } }, 5000);
      child.once("exit", () => clearTimeout(forceTimer));
    }
    await stopped;
  };

  return { port, ready, status, stop };
}
