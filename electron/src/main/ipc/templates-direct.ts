/**
 * 模版库通道直调器（F6-1）：op:templates:* 5 条通道 → 进程内直调模版库列表/
 * 内容/红头通知/文件流（server/index.mjs L413-443 + L551-586 逐点转录；行号锚点
 * 均指 server/index.mjs）。
 *
 *   - op:templates:list（L414-419）：cats = getCategories()，items =
 *     getTemplatesByCategory(query.category) → { categories, items, total }；
 *   - op:templates:content（L421-427）：!relPath 400 { error: "path required" } →
 *     c = getTemplateContent(relPath)，!c 404 { error: "not found" } → c 整体透传；
 *   - op:templates:generate-notice（L435-443）：r = await generateNotice(body) →
 *     { ok: true, name: r.name }；catch → 500 { error: String(e?.message || e) }；
 *   - op:templates:file（L552-572 正则路由转录）：params.path 为捕获组原文
 *     （IPC 直调无 URL 编码层，直调器按「已解码捕获组」语义消费，不再
 *     decodeURIComponent）→ 截取 templates/ 之后的部分（含 marker 本身，兼容
 *     tpl 扫描产出的绝对 relPath）→ 含 ".." 或以 "/" 起始 400 "invalid path" →
 *     双根候选 [join(projectDir, relPath), join(tplRoot, relPath)]，find 取首个
 *     通过前缀过滤（projectDir/templates 或 tplRoot/_）者——非首个存在者，忠实
 *     转录 → 不存在或非文件 404 "file not found" → 按扩展名 mime 映射读
 *     base64 → { mime, base64 }；
 *   - op:templates:files（L576-586 正则路由转录）：relPath = params.path 原文
 *     → 含 ".."/以 "/" 起始/盘符 /^[A-Z]:/i 400 → abs = join(tplRoot, relPath)，
 *     不存在或非文件 404 → 按扩展名 mime 映射读 base64 → { mime, base64 }。
 *
 * 桌面形态差异声明：server 侧 file/files 以 res.sendFile 流式回包（Express 按
 * 扩展名推断 Content-Type）；IPC 直调改回 { mime, base64 }，渲染层拼 data URL，
 * 语义等价（mime 推断同表转录 L569 映射，files 路由用同一张表替代 sendFile
 * 的 mime 推断）。op:templates:refresh（L429-432）为前端未消费的死导出路由，
 * 不入通道清单（channels-manifest 窄前缀豁免）。
 *
 * 数据源：backend/tpl.ts（getCategories/getTemplatesByCategory/getTemplateContent，
 * ROOT=resolve(PROJECT_DIR,"..")）+ backend/notice.ts（generateNotice，docx 生成
 * → 写工作区）。
 *
 * 门控：OP_DESKTOP_TEMPLATES_DIRECT 且 OP_DESKTOP_AGENT_DOMAIN 双门控（S4 语义：
 * 未设置=默认启用，=0 显式回滚）。本模块不 import electron（纯逻辑，vitest 可直接测）；
 * 注册入口在 main/index.ts。
 */
import path from "node:path";
import type { InvokeEnvelope, InvokeResult } from "../../shared/protocol/channels";

/** 模版库的跨域依赖（生产接线传 tpl/notice 真实模块 + node:fs，测试注入桩）。 */
export interface TemplatesDirectDeps {
  /** 模版分类清单（backend/tpl.ts getCategories） */
  getCategories: () => Array<Record<string, unknown>>;
  /** 按分类取模版（backend/tpl.ts getTemplatesByCategory；undefined=全量，与 server query 缺省同义） */
  getTemplatesByCategory: (categoryId: string | undefined) => Array<Record<string, unknown>>;
  /** 模版内容（backend/tpl.ts getTemplateContent，未命中 null） */
  getTemplateContent: (relPath: string) => Record<string, unknown> | null;
  /** 红头会议通知生成（backend/notice.ts generateNotice，异步写工作区） */
  generateNotice: (input: Record<string, unknown>) => Promise<{ name: string }>;
  /** 项目根（server PROJECT_DIR 语义：electron/src/main/backend/workspace-paths.ts） */
  projectDir: string;
  /** 工作目录根（server TPL_ROOT 语义 = resolve(PROJECT_DIR, ".."，与 tpl.ts ROOT 同值） */
  tplRoot: string;
  /** 文件系统注入（生产传 node:fs，测试注入桩） */
  fs: {
    existsSync: (path: string) => boolean;
    statSync: (path: string) => { isFile: () => boolean };
    readFileSync: (path: string, encoding: "base64") => string;
  };
}

/** 模版库直调 invoke 通道清单（与 DESKTOP_CHANNELS 对应路由一致）。 */
export const TEMPLATES_DIRECT_CHANNELS = [
  "op:templates:list",
  "op:templates:content",
  "op:templates:generate-notice",
  "op:templates:file",
  "op:templates:files"
] as const;

export type TemplatesDirectChannel = (typeof TEMPLATES_DIRECT_CHANNELS)[number];

const ok = (data: unknown): InvokeResult<unknown> => ({ ok: true, status: 200, data });
const fail = (status: number, data: unknown): InvokeResult<unknown> => ({ ok: false, status, data } as InvokeResult<unknown>);

const bodyOf = (payload: InvokeEnvelope): Record<string, any> => (payload.body ?? {}) as Record<string, any>;
const queryOf = (payload: InvokeEnvelope): Record<string, string | undefined> => (payload.query ?? {}) as Record<string, string | undefined>;

/** 扩展名 → Content-Type 映射（server L569 file 路由映射表逐项转录；files 路由复用）。 */
const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".json": "application/json"
};

const mimeOf = (abs: string): string => MIME_BY_EXT[path.extname(abs).toLowerCase()] ?? "application/octet-stream";

/** GET /api/templates（L414-419 逐点转录）。 */
function invokeList(payload: InvokeEnvelope, deps: TemplatesDirectDeps): InvokeResult<unknown> {
  const cat = queryOf(payload).category;
  const cats = deps.getCategories();
  const items = deps.getTemplatesByCategory(cat);
  return ok({ categories: cats, items, total: items.length });
}

/** GET /api/templates/content（L421-427 逐点转录：!path 400 / !c 404 / 整体透传）。 */
function invokeContent(payload: InvokeEnvelope, deps: TemplatesDirectDeps): InvokeResult<unknown> {
  const relPath = queryOf(payload).path || "";
  if (!relPath) return fail(400, { error: "path required" });
  const c = deps.getTemplateContent(relPath);
  if (!c) return fail(404, { error: "not found" });
  return ok(c);
}

/** POST /api/templates/generate-notice（L435-443 逐点转录：{ ok, name } / catch 500）。 */
async function invokeGenerateNotice(payload: InvokeEnvelope, deps: TemplatesDirectDeps): Promise<InvokeResult<unknown>> {
  try {
    const r = await deps.generateNotice(bodyOf(payload));
    return ok({ ok: true, name: r.name });
  } catch (e) {
    return fail(500, { error: String((e as { message?: unknown })?.message || e) });
  }
}

/** GET /api/templates/file/:path（L552-572 逐点转录：marker 截取 → 双根候选 →
 * 前缀过滤 find → 存在性校验 → mime+base64）。 */
function invokeFile(payload: InvokeEnvelope, deps: TemplatesDirectDeps): InvokeResult<unknown> {
  const params = (payload.params ?? {}) as Record<string, string>;
  const raw = params.path ?? "";
  // 兼容绝对路径 relPath（tpl 扫描结果）：截取 templates/ 之后的部分
  const marker = "templates/";
  const idx = raw.indexOf(marker);
  const relPath = idx >= 0 ? raw.slice(idx) : raw;
  if (!relPath || relPath.includes("..") || relPath.startsWith("/")) {
    return fail(400, { error: "invalid path" });
  }
  // 模板可能位于项目根 templates/ 或工作目录（_报告模板 等），双根尝试
  const candidates = [path.join(deps.projectDir, relPath), path.join(deps.tplRoot, relPath)];
  const abs = candidates.find(
    (p) => p.startsWith(path.join(deps.projectDir, "templates")) || p.startsWith(path.join(deps.tplRoot, "_"))
  );
  if (!abs || !deps.fs.existsSync(abs) || !deps.fs.statSync(abs).isFile()) {
    return fail(404, { error: "file not found" });
  }
  return ok({ mime: mimeOf(abs), base64: deps.fs.readFileSync(abs, "base64") });
}

/** GET /api/templates/files/:path（L576-586 逐点转录：..//盘符 400 → TPL_ROOT 直拼 →
 * 存在性校验 → mime+base64）。 */
function invokeFiles(payload: InvokeEnvelope, deps: TemplatesDirectDeps): InvokeResult<unknown> {
  const params = (payload.params ?? {}) as Record<string, string>;
  const relPath = params.path ?? ""; // 正则捕获组（IPC 无 URL 编码层，按原文消费）
  if (!relPath || relPath.includes("..") || relPath.startsWith("/") || /^[A-Z]:/i.test(relPath)) {
    return fail(400, { error: "invalid path" });
  }
  const abs = path.join(deps.tplRoot, relPath);
  if (!deps.fs.existsSync(abs) || !deps.fs.statSync(abs).isFile()) {
    return fail(404, { error: "file not found" });
  }
  return ok({ mime: mimeOf(abs), base64: deps.fs.readFileSync(abs, "base64") });
}

/**
 * 模版库直调分发入口：ipcMain.handle 注册侧调用（main/index.ts
 * registerTemplatesDirectInvokers）。全部路由均有 try/catch 或纯同步域调用，
 * 异常面与 server 一致。
 */
export async function invokeTemplatesDirect(
  channel: string,
  payload: InvokeEnvelope | undefined,
  deps: TemplatesDirectDeps
): Promise<InvokeResult<unknown>> {
  const envelope: InvokeEnvelope = payload ?? {};
  switch (channel as TemplatesDirectChannel) {
    case "op:templates:list":
      return invokeList(envelope, deps);
    case "op:templates:content":
      return invokeContent(envelope, deps);
    case "op:templates:generate-notice":
      return invokeGenerateNotice(envelope, deps);
    case "op:templates:file":
      return invokeFile(envelope, deps);
    case "op:templates:files":
      return invokeFiles(envelope, deps);
    default:
      return fail(404, { error: `unknown channel: ${channel}` });
  }
}
