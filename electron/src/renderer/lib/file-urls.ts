/**
 * 统一文件身份与预览地址（D01）
 *
 * 目标：一个文件在「哪个工作区、哪个相对路径、哪个版本」上被打开时，
 * 所有预览请求（open / raw / text / html / comments / annotations / outline / watch）
 * 都显式携带同一份「文件身份」，避免不同工作区的同名文件互相串内容。
 *
 * 与 client/src/file-urls.js 逐函数等价（tests/f1-file-urls-parity.test.ts 对拍强制）。
 */

export interface FileIdentity {
  workspaceId: string;
  cwd: string;
  relativePath: string;
  revision: string;
}

/** 共享预览状态：loading | ready | partial | unsupported | failed */
export const PREVIEW_STATE = Object.freeze({
  LOADING: "loading",
  READY: "ready",
  PARTIAL: "partial",
  UNSUPPORTED: "unsupported",
  FAILED: "failed",
});

export const PREVIEW_STATE_LABEL = Object.freeze({
  [PREVIEW_STATE.LOADING]: "加载中",
  [PREVIEW_STATE.READY]: "已就绪",
  [PREVIEW_STATE.PARTIAL]: "部分内容",
  [PREVIEW_STATE.UNSUPPORTED]: "不支持预览",
  [PREVIEW_STATE.FAILED]: "预览失败",
} as Record<string, string>);

/** 归一化相对路径：统一分隔符、去掉前导 "./" 与 "/"。 */
export function normalizeRelativePath(value: unknown): string {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^(?:\.?\/)+/, "");
}

/**
 * 构造文件身份。relativePath 缺失时回退 name，便于旧调用点迁移。
 * workspaceId 缺失时回退 cwd。
 */
export function makeFileIdentity(input: unknown = {}): FileIdentity {
  // 注意：默认参数只对 undefined 生效，显式传 null 时与 JS 一致地抛 TypeError
  const src = input as any;
  const relativePath = normalizeRelativePath(src.relativePath ?? src.name ?? "");
  const cwd = String(src.cwd || src.workspaceId || "");
  const workspaceId = String(src.workspaceId || cwd || "");
  const revision = src.revision == null ? "" : String(src.revision);
  return { workspaceId, cwd: cwd || workspaceId, relativePath, revision };
}

/** 身份去重键：工作区 + 相对路径（不含版本，版本变化不应新建标签）。 */
export function fileIdentityKey(identity: unknown): string {
  if (!identity) return "";
  const src = identity as any;
  const ws = String(src.workspaceId || src.cwd || "").replace(/\\/g, "/").toLowerCase();
  return `${ws}::${normalizeRelativePath(src.relativePath).toLowerCase()}`;
}

/** 两个身份是否指向同一文件（比较工作区 + 相对路径，大小写与分隔符归一）。 */
export function identityMatches(expected: unknown, actual: unknown): boolean {
  if (!expected || !actual) return false;
  return fileIdentityKey(expected) === fileIdentityKey(actual);
}

/** 把服务端返回 identity 合并进本地身份（保留本地已知的 cwd 兜底）。 */
export function mergeFileIdentity(local: unknown, server: unknown): FileIdentity {
  if (!server) return makeFileIdentity(local || {});
  const l = local as any;
  const s = server as any;
  return makeFileIdentity({
    workspaceId: s.workspaceId || l?.workspaceId,
    cwd: s.cwd || l?.cwd,
    relativePath: s.relativePath || l?.relativePath,
    revision: s.revision != null ? s.revision : l?.revision,
  });
}

/** 从服务端 raw 响应头读取文件身份（服务端 URL 编码的 JSON）。 */
export function readIdentityHeader(response: unknown): unknown {
  try {
    const raw = (response as any)?.headers?.get?.("x-oa-file-identity");
    if (!raw) return null;
    return JSON.parse(decodeURIComponent(raw));
  } catch {
    return null;
  }
}

function identityQuery(identity: any = {}): string {
  const params = new URLSearchParams();
  const ws = String(identity.workspaceId || identity.cwd || "");
  if (ws) {
    params.set("cwd", ws);
    params.set("wsid", ws);
  }
  if (identity.revision) params.set("v", String(identity.revision));
  return params.toString();
}

function withQuery(url: string, query: string): string {
  return query ? `${url}${url.includes("?") ? "&" : "?"}${query}` : url;
}

export interface DocUrls {
  base: string;
  identity: FileIdentity;
  open: string;
  raw: string;
  text: string;
  html: string;
  comments: string;
  annotations: string;
  outline: string;
  watch: string;
  watchStop: string;
  rawSave: string;
}

/**
 * 由文件身份生成全部预览地址。每条地址都携带同一份 cwd/wsid/v。
 */
export function buildDocUrls(identity: unknown): DocUrls {
  const id = makeFileIdentity(identity || {});
  const rel = encodeURIComponent(id.relativePath);
  const base = `/api/doc/${rel}`;
  const query = identityQuery(id);
  const q = (suffix: string) => withQuery(`${base}${suffix}`, query);
  return {
    base,
    identity: id,
    open: q(""),
    raw: q("/raw"),
    text: q("/text"),
    html: q("/html"),
    comments: q("/comments"),
    annotations: q("/annotations"),
    outline: q("/outline"),
    watch: q("/watch"),
    watchStop: q("/watch/stop"),
    rawSave: q("/raw-save"),
  };
}

/** 用新的 revision 覆盖地址中的 v 参数（刷新时使用服务端最新版本）。 */
export function withRevision(url: unknown, revision: unknown): string {
  if (!url) return url as string;
  const next = String(revision || "");
  if (!next) return url as string;
  const [head, search = ""] = String(url).split("?");
  const params = new URLSearchParams(search);
  params.set("v", next);
  return `${head}?${params.toString()}`;
}

/** 判断错误信息是否表示「格式不支持预览」。 */
export function looksUnsupported(message: unknown): boolean {
  return /不支持|无法预览|unsupported|not supported|\.doc\b|\.wps\b/i.test(String(message || ""));
}

/** 依据错误归类预览状态。 */
export function previewStateFromError(error: unknown): string {
  return looksUnsupported((error as any)?.message || error) ? PREVIEW_STATE.UNSUPPORTED : PREVIEW_STATE.FAILED;
}
