/**
 * 导出视图离屏窗口（R6-3，BRD-009 桌面架构：主进程自持导出渲染面）。
 *
 * 旧路径（server L5293-5310 + F5-3 迁移期等价）：executeExportJob 经 builtin-browser
 * 打开 sidecar URL /?export=map——由 sidecar 服务旧 client 渲染导出视图，CDP
 * Emulation 视口 + Page.captureScreenshot/printToPDF 取图。
 *
 * 新路径：主进程 offscreen BrowserWindow 加载 renderer 导出路由
 * （app/index.html?export=map&project=...，dev 走 vite devUrl、打包走 file:// 产物），
 * 组件数据面经 opDesktop 桥走 op:map:project:get / op:map:data:style 通道，
 * 资产面（瓦片/glyphs/geojson）走 oaw-data://（R6-2）。sidecar 退役后导出链路
 * 完全自持。
 *
 * 接口形态：与 executeExportJob 消费的 builtin-browser 七函数签名对齐
 * （open/resize/waitForExpression/evaluateValue/screenshot/printToPdf），deps 接线
 * 在 main/index.ts 原位替换；会话键（browserSessionKey）仍用 builtin-browser 纯键拼接。
 * 批量导出串行队列复用同一窗口（loadURL 导航重挂载组件），app 退出时 closeAllExportViews。
 *
 * 语义对齐点：
 *   - waitFor：executeJavaScript 轮询 `Boolean(expr)`，超时抛「等待页面就绪超时」
 *     （与 builtin-browser.browserWaitForExpression 同文案）；
 *   - evaluate：executeJavaScript 异常 reject（对齐 CDP exceptionDetails → throw）；
 *   - screenshot：capturePage → PNG（format!="png" 走 JPEG q90，对齐 CDP 分支）；
 *   - printToPdf：{ printBackground: true, preferCSSPageSize: true }（组件注入
 *     @page 视口同尺寸样式，产出与截图一致的单页 PDF，对齐 session.printToPdf）。
 *
 * 可测性：纯逻辑面（buildExportViewQuery / buildExportViewPageUrl）不 import electron，
 * vitest 直接可测；electron 运行时引用收敛在各函数内的动态 import
 * （同 oaw-data-protocol.ts 模式）。
 */
import { pathToFileURL } from "node:url";
import type { BrowserWindow } from "electron";

/** 会话键 → 离屏窗口（批量导出串行队列按 key 复用）。 */
const exportWindows = new Map<string, BrowserWindow>();

/* ------------------------------ 纯逻辑：导出页 URL 构建 ------------------------------ */

/** job → 导出视图 query 段（旧 buildExportViewUrl 的 qs 逐字段转录：export=map +
 * project + title，layers 存在时逗号拼接；project/title 缺省产生 "undefined" 字面
 * ——与 server 同款行为，不修）。 */
export function buildExportViewQuery(job: Record<string, any>): string {
  const qs = new URLSearchParams({ export: "map", project: job.project, title: job.title });
  if (job.layers?.length) qs.set("layers", job.layers.join(","));
  return qs.toString();
}

/** renderer 导出页目标 URL：开发态走 vite dev server（ELECTRON_RENDERER_URL），
 * 打包态走产物 file://（app/index.html 同目录）；query 附于其后供组件读取。 */
export function buildExportViewPageUrl(
  job: Record<string, any>,
  options: { devUrl?: string; appIndex: string }
): string {
  const qs = buildExportViewQuery(job);
  if (options.devUrl) return `${options.devUrl}/app/index.html?${qs}`;
  return `${pathToFileURL(options.appIndex).href}?${qs}`;
}

/* ------------------------------ electron 面：离屏窗口生命周期 ------------------------------ */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function requireWindow(key: string): BrowserWindow {
  const win = exportWindows.get(key);
  if (!win || win.isDestroyed()) throw new Error("导出视图窗口不存在或已关闭");
  return win;
}

/** 打开（或复用）离屏导出窗口并导航到目标 URL。options.preload 仅创建时生效
 * （opDesktop 桥：组件数据面走 op:map:* 通道）。返回对齐 browserOpen 的 await 时机
 * ——win.loadURL 完成即页面 load 完毕，随后 resize/poll。 */
export async function openExportView(key: string, url: string, options: { preload?: string } = {}): Promise<void> {
  const { BrowserWindow } = (await import("electron")) as typeof import("electron");
  let win = exportWindows.get(key);
  if (!win || win.isDestroyed()) {
    win = new BrowserWindow({
      show: false,
      useContentSize: true,
      width: 1280,
      height: 720,
      webPreferences: {
        offscreen: true,
        backgroundThrottling: false,
        preload: options.preload,
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    win.on("closed", () => {
      if (exportWindows.get(key) === win) exportWindows.delete(key);
    });
    exportWindows.set(key, win);
  }
  await win.loadURL(url);
}

/** 视口调整：内容区尺寸（组件 stableViewport 轮询 innerWidth/innerHeight 稳定后建图）。 */
export async function resizeExportView(key: string, width: number, height: number): Promise<void> {
  requireWindow(key).setContentSize(width, height);
}

/** 轮询表达式就绪（对齐 builtin-browser.browserWaitForExpression：默认 30s 超时 /
 * 300ms 间隔，超时抛「等待页面就绪超时（Ns）」；导航期求值异常吞入 lastError）。 */
export async function waitForExportExpression(
  key: string,
  expression: string,
  { timeoutMs = 30000, intervalMs = 300 }: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<boolean> {
  const win = requireWindow(key);
  const timeout = Math.max(1000, Number(timeoutMs) || 30000);
  const deadline = Date.now() + timeout;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const value = await win.webContents.executeJavaScript(`Boolean(${expression})`, true);
      if (value === true) return true;
    } catch (e) {
      lastError = String((e as Error)?.message || e);
    }
    await sleep(Number(intervalMs) || 300);
  }
  throw new Error(`等待页面就绪超时（${Math.round(timeout / 1000)}s）${lastError ? `：${lastError}` : ""}`);
}

/** 求值取值（对齐 builtin-browser.browserEvaluateValue：页面异常 reject）。 */
export async function evaluateExportValue(key: string, expression: string): Promise<unknown> {
  const win = requireWindow(key);
  return win.webContents.executeJavaScript(String(expression), true);
}

/** 视口截图：capturePage → PNG（format!="png" 走 JPEG q90，对齐 CDP 分支）。
 * 空帧显式抛错（离屏窗口未产出画面时拒绝落空文件）。 */
export async function screenshotExportView(key: string, options: { format?: string } = {}): Promise<{ base64: string }> {
  const win = requireWindow(key);
  const image = await win.webContents.capturePage();
  if (image.isEmpty()) throw new Error("截图失败：离屏窗口未产出画面");
  const buffer = options.format === "png" ? image.toPNG() : image.toJPEG(90);
  return { base64: Buffer.from(buffer).toString("base64") };
}

/** 打印 PDF：printBackground + preferCSSPageSize（组件注入 @page 视口同尺寸样式，
 * 产出与截图一致的单页 PDF，对齐 session.printToPdf 选项）。 */
export async function printExportViewPdf(key: string): Promise<{ base64: string }> {
  const win = requireWindow(key);
  const data = await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
  return { base64: Buffer.from(data).toString("base64") };
}

/** 关闭指定导出窗口（当前执行器不主动关闭——串行队列复用；保留给异常清理面）。 */
export function closeExportView(key: string): void {
  const win = exportWindows.get(key);
  if (win && !win.isDestroyed()) win.destroy();
  exportWindows.delete(key);
}

/** 关闭全部导出窗口（app 退出路径调用，防离屏窗口挂住退出）。 */
export function closeAllExportViews(): void {
  for (const win of exportWindows.values()) {
    if (!win.isDestroyed()) win.destroy();
  }
  exportWindows.clear();
}
