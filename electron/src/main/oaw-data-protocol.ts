/**
 * oaw-data:// 自定义协议（R6-2 资产自持，BRD-009 桌面架构：桌面端禁 HTTP 通道的
 * 资产面等价替换）。
 *
 * 旧路径：MapLibre 引擎按 style.json 内绝对 URL 直连 sidecar
 * http://127.0.0.1:<port>/api/map/data/*（工作区 maps 静态服务，server/index.mjs
 * L611 express.static）与 /glyphs/*（client/public/glyphs 经 vite 构建拷入 dist，
 * server/index.mjs L5740 express.static(dist)），跨源面靠 installSidecarCorsRelay
 * 注入 ACAO 放行。
 *
 * 新路径：单 scheme 双 host——
 *   - oaw-data://maps/<path>   → 工作区 maps 根（office-workspace/maps，运行时数据，
 *     与 backend/map.ts MAPS_ROOT 同锚点 WORKSPACE_DIR/maps）；
 *   - oaw-data://glyphs/<path> → electron/resources/glyphs（自托管 MapLibre 字体切片，
 *     R6-2 起 client/public/glyphs 迁移至此；R6-1 后 legacy 形态不可达，client/dist
 *     不再被新 UI 消费）。
 *
 * 接线时序（见 main/index.ts）：
 *   - registerOawDataSchemePrivileged() 在 app ready 前调用（standard + secure +
 *     supportFetchAPI + stream + corsEnabled，MapLibre 引擎 fetch 资产的必要特权）；
 *   - installOawDataProtocolHandler(roots) 在 whenReady 后调用（protocol.handle 契约），
 *     roots 由接线方注入（maps 锚 workspace.WORKSPACE_DIR/maps，glyphs 锚
 *     app.getAppPath()/resources/glyphs——dev 即 electron/resources/glyphs，打包态随
 *     files 配置入包，Electron fs 对 asar 内文件透明可读）。
 *
 * 响应面：统一 ACAO:*（渲染层跨源 fetch 约束，接替 CORS relay 在 oaw-data 面的职责）；
 * 文件读取失败（不存在/目录/IO 错）统一 404——与 express.static「未命中 → next() →
 * 404」调用方可感知语义等价。OPTIONS 预检回 204 + CORS 头（MapLibre 现无预检请求，
 * 防御性覆盖）。
 *
 * 安全：路径穿越守卫——URL pathname 先 decodeURIComponent（URL 构造会把 {z}/{x}/{y}
 * 等百分号编码，解码后统一校验；字面 ../ 与 %2e%2e 形态已被 WHATWG URL 解析器按
 * dot-segment 规范化，天然不逃逸），resolve 后必须落在对应根目录内（含根自身），
 * 否则 404；段内编码分隔符注入（%2f、Windows %5C）由 resolve 后前缀校验拦截。
 *
 * 可测性：本模块不顶层 import electron（electron 运行时引用收敛在两个安装函数内的
 * 动态 import），纯逻辑面（resolveOawDataFile）vitest 直接可测。
 */
import { extname as pathExtname, resolve as pathResolve, sep as pathSep } from "node:path";
import { readFile as fsReadFile } from "node:fs/promises";
import type { Protocol } from "electron";

export const OAW_DATA_SCHEME = "oaw-data";

/** oaw-data 双 host：maps = 工作区地图项目根，glyphs = 桌面自托管字体根。 */
export type OawDataHost = "maps" | "glyphs";

export interface OawDataRoots {
  maps: string;
  glyphs: string;
}

/** mime 映射（对齐旧侧 express.static/mime-db 调用方可感知语义；缺省 application/octet-stream）。 */
const MIME_TYPES: Record<string, string> = {
  ".json": "application/json",
  ".geojson": "application/geo+json",
  ".pbf": "application/x-protobuf",
  ".mvt": "application/vnd.mapbox-vector-tile",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".css": "text/css",
  ".js": "text/javascript",
  ".html": "text/html",
  ".txt": "text/plain",
  ".xml": "application/xml",
  ".pdf": "application/pdf"
};

/**
 * 解析 oaw-data URL → 绝对文件路径 + mime。
 * host 不识别（非 maps/glyphs）、路径穿越、pathname 解码失败 → null（调用方 404）。
 */
export function resolveOawDataFile(url: string, roots: OawDataRoots): { filePath: string; mime: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.host as OawDataHost;
  if (host !== "maps" && host !== "glyphs") return null;
  const root = host === "maps" ? roots.maps : roots.glyphs;
  let rel: string;
  try {
    rel = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  // rel 恒以 "/" 开头；拼 "." 防止绝对路径盘符语义（Windows "/C:/" 形态）
  const target = pathResolve(root, "." + rel);
  if (target !== root && !target.startsWith(root + pathSep)) return null;
  const mime = MIME_TYPES[pathExtname(target).toLowerCase()] ?? "application/octet-stream";
  return { filePath: target, mime };
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*"
};

/** app ready 前调用一次：oaw-data 注册为特权 scheme（MapLibre 引擎 fetch 资产的必要特权）。 */
export function registerOawDataSchemePrivileged(): void {
  void import("electron").then(({ protocol }) => {
    protocol.registerSchemesAsPrivileged([
      {
        scheme: OAW_DATA_SCHEME,
        privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true }
      }
    ]);
  });
}

/** whenReady 后调用：安装 oaw-data 协议 handler（roots 由接线方注入，锚点见模块注释）。 */
export async function installOawDataProtocolHandler(roots: OawDataRoots): Promise<void> {
  const { protocol } = (await import("electron")) as { protocol: Protocol };
  protocol.handle(OAW_DATA_SCHEME, async (request) => {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    const resolved = resolveOawDataFile(request.url, roots);
    if (!resolved) return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
    try {
      const data = await fsReadFile(resolved.filePath);
      return new Response(new Uint8Array(data), {
        status: 200,
        headers: { "Content-Type": resolved.mime, ...CORS_HEADERS }
      });
    } catch {
      return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
    }
  });
}
