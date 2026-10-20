import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { pickPreferredPort } from "./util/port";
import { startLegacyServer, type LegacyServerHandle, type ServerStatusSnapshot } from "./legacy-server";
import { createSplashWindow } from "./splash";

const SMOKE = process.env.OP_DESKTOP_SMOKE === "1";
const PRELOAD_PATH = path.join(__dirname, "../preload/index.js");

/** 仓库根：out/main → out → electron → 项目根。打包形态后续里程碑再调整。 */
function projectRoot(): string {
  return process.env.OP_PROJECT_ROOT || path.resolve(__dirname, "../../..");
}

let mainWindow: BrowserWindow | null = null;
let server: LegacyServerHandle | null = null;
let quitting = false;

function broadcastStatus(status: ServerStatusSnapshot): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("op:server-status", status);
  }
}

async function bootstrap(): Promise<void> {
  let port: number;
  try {
    port = await pickPreferredPort();
  } catch (error) {
    reportFatal(error instanceof Error ? error.message : String(error));
    return;
  }

  const root = projectRoot();
  server = startLegacyServer(root, port);
  broadcastStatus(server.status);
  server.ready
    .then((probe) => {
      if (!server) return;
      broadcastStatus(server.status);
      if (probe.ok) {
        if (SMOKE) {
          console.log(`SMOKE_OK port=${server.port}`);
          void shutdown(0);
          return;
        }
        mainWindow?.loadURL(`http://127.0.0.1:${server.port}/`).catch((error) => {
          reportFatal(`页面加载失败：${error instanceof Error ? error.message : String(error)}`);
        });
      } else {
        reportFatal(probe.error ?? "本地服务启动失败", server.status.logTail);
      }
    })
    .catch((error) => {
      reportFatal(error instanceof Error ? error.message : String(error), server?.status.logTail);
    });
}

function reportFatal(message: string, logTail?: string[]): void {
  const status: ServerStatusSnapshot = { phase: "failed", message, logTail };
  broadcastStatus(status);
  if (SMOKE) {
    console.log(`SMOKE_FAIL ${message}`);
    void shutdown(1);
  }
}

async function shutdown(exitCode: number): Promise<void> {
  if (quitting) return;
  quitting = true;
  try { await server?.stop(); } catch { /* 忽略停止期错误 */ }
  app.exit(exitCode);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    ipcMain.handle("op:server-status", () => server?.status ?? { phase: "starting" });
    mainWindow = createSplashWindow(PRELOAD_PATH);
    void bootstrap();
  });

  app.on("window-all-closed", () => {
    void shutdown(0);
  });

  app.on("before-quit", (event) => {
    if (!quitting) {
      event.preventDefault();
      void shutdown(0);
    }
  });
}
