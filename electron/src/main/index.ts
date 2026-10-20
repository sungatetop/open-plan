import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { pickPreferredPort } from "./util/port";
import { resolveRendererTarget } from "./util/renderer-target";
import { startLegacyServer, type LegacyServerHandle, type ServerStatusSnapshot } from "./legacy-server";
import { createSplashWindow } from "./splash";

const SMOKE = process.env.OP_DESKTOP_SMOKE === "1";
const RENDERER_TARGET = resolveRendererTarget();
const PRELOAD_PATH = path.join(__dirname, "../preload/index.js");

/** 仓库根：out/main → out → electron → 项目根。打包形态后续里程碑再调整。 */
function projectRoot(): string {
  return process.env.OP_PROJECT_ROOT || path.resolve(__dirname, "../../..");
}

let mainWindow: BrowserWindow | null = null;
let server: LegacyServerHandle | null = null;
let quitting = false;

/** 新 UI 应用页（F2 骨架）：开发态走 dev server，打包态走产物文件。 */
function loadAppPage(win: BrowserWindow): Promise<void> {
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) return win.loadURL(`${devUrl}/app/index.html`);
  return win.loadFile(path.join(__dirname, "../renderer/app/index.html"));
}

/** OP_DESKTOP_NEW_UI=1 冒烟：加载 app 页并断言 React 真实挂载（data-app-ready）。 */
async function smokeNewUi(): Promise<void> {
  const win = mainWindow;
  if (!win) {
    console.log("SMOKE_NEW_UI_FAIL 缺少主窗口");
    void shutdown(1);
    return;
  }
  try {
    await loadAppPage(win);
    const mounted = await win.webContents.executeJavaScript(
      "document.documentElement.getAttribute('data-app-ready') === '1' && (document.getElementById('root')?.childElementCount ?? 0) > 0"
    );
    if (mounted === true) {
      console.log("SMOKE_NEW_UI_OK");
      void shutdown(0);
    } else {
      console.log("SMOKE_NEW_UI_FAIL React 未挂载");
      void shutdown(1);
    }
  } catch (error) {
    console.log(`SMOKE_NEW_UI_FAIL ${error instanceof Error ? error.message : String(error)}`);
    void shutdown(1);
  }
}

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
        if (SMOKE && RENDERER_TARGET === "legacy-client") {
          console.log(`SMOKE_OK port=${server.port}`);
          void shutdown(0);
          return;
        }
        if (RENDERER_TARGET === "app") {
          if (SMOKE) {
            void smokeNewUi();
            return;
          }
          if (mainWindow) {
            loadAppPage(mainWindow).catch((error) => {
              reportFatal(`新 UI 页面加载失败：${error instanceof Error ? error.message : String(error)}`);
            });
          }
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
