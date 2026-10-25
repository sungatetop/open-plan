/**
 * 产物轻量结构校验（B1-1 备料批，自 server/artifact-verification.mjs 71 行逐行转录）。
 *
 * 对本轮新增/修改文件做签名/文本结构检查（Office ZIP 容器头/PDF 文件头/文本可读/
 * JSON 可解析），不替代 Word/Excel/PPT 的视觉验收。runs 域 finishRun 与办公室
 * publishStagedRun 消费本模块。
 *
 * 模块未接入运行时（runs 域 TS 化批次接线）；旧 JS 实现保留至 runs 域收编后退役。
 * isInside 保持本地私有实现与旧文件一致（不从 ../workspace 导入，语义等价但来源独立）。
 */
import fs from "node:fs";
import path from "node:path";

const TEXT_EXTENSIONS = new Set(["md", "markdown", "txt", "csv", "json", "geojson", "html", "htm"]);
const OFFICE_EXTENSIONS = new Set(["docx", "xlsx", "pptx"]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "svg"]);

function isInside(root: string, target: string): boolean {
  const base = path.resolve(root);
  const full = path.resolve(target);
  return full === base || full.startsWith(base + path.sep);
}

function readSignature(file: string): Buffer {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(8);
    fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer;
  } finally {
    fs.closeSync(fd);
  }
}

export interface ArtifactValidation {
  path: string;
  status: "passed" | "failed" | "not_applicable";
  message: string;
  checkedAt: string;
  format?: string;
  size?: number;
}

/** 对本轮新增/修改文件做轻量结构校验，不替代 Word/Excel/PPT 的视觉验收。 */
export function validateArtifactFile(file: string, root: string = path.dirname(file), relativePath: string = path.basename(file)): ArtifactValidation {
  const checkedAt = new Date().toISOString();
  const target = path.resolve(file);
  const rel = String(relativePath || path.basename(target)).replace(/\\/g, "/");
  const base = path.resolve(root);
  if (!isInside(base, target)) return { path: rel, status: "failed", message: "产物不在当前工作区内", checkedAt };
  if (!fs.existsSync(target)) return { path: rel, status: "failed", message: "产物文件不存在", checkedAt };
  let stat: fs.Stats;
  try { stat = fs.statSync(target); } catch (error) { return { path: rel, status: "failed", message: `无法读取产物：${(error as Error).message}`, checkedAt }; }
  if (!stat.isFile()) return { path: rel, status: "failed", message: "产物不是文件", checkedAt };
  if (stat.size <= 0) return { path: rel, status: "failed", message: "产物文件为空", checkedAt, size: stat.size };

  const ext = path.extname(target).slice(1).toLowerCase();
  try {
    if (OFFICE_EXTENSIONS.has(ext)) {
      const signature = readSignature(target);
      const zipContainer = signature[0] === 0x50 && signature[1] === 0x4b;
      return {
        path: rel,
        format: ext,
        status: zipContainer ? "passed" : "failed",
        message: zipContainer ? "Office ZIP 容器签名正常" : "不是有效的 Office ZIP 容器",
        checkedAt,
        size: stat.size,
      };
    }
    if (ext === "pdf") {
      const signature = readSignature(target).toString("ascii", 0, 4);
      return { path: rel, format: ext, status: signature === "%PDF" ? "passed" : "failed", message: signature === "%PDF" ? "PDF 文件头正常" : "PDF 文件头无效", checkedAt, size: stat.size };
    }
    if (TEXT_EXTENSIONS.has(ext)) {
      const text = fs.readFileSync(target, "utf8");
      if (!text.trim()) return { path: rel, format: ext, status: "failed", message: "文本产物为空", checkedAt, size: stat.size };
      if (ext === "json" || ext === "geojson") {
        try { JSON.parse(text); } catch { return { path: rel, format: ext, status: "failed", message: "JSON 结构不可解析", checkedAt, size: stat.size }; }
      }
      return { path: rel, format: ext, status: "passed", message: "文本内容可读取" + ((ext === "json" || ext === "geojson") ? "，JSON 结构可解析" : ""), checkedAt, size: stat.size };
    }
    if (IMAGE_EXTENSIONS.has(ext)) return { path: rel, format: ext, status: "passed", message: "图片产物非空", checkedAt, size: stat.size };
    return { path: rel, format: ext || "unknown", status: "not_applicable", message: "暂不执行该格式的结构校验", checkedAt, size: stat.size };
  } catch (error) {
    return { path: rel, format: ext || "unknown", status: "failed", message: `产物校验失败：${(error as Error).message}`, checkedAt, size: stat.size };
  }
}

export function validateArtifacts(paths: unknown[], root?: string): ArtifactValidation[] {
  const workspace = path.resolve(root || process.cwd());
  return (Array.isArray(paths) ? paths : []).map((item: any) => {
    const rel = typeof item === "string" ? item : item?.path;
    return validateArtifactFile(path.resolve(workspace, String(rel || "")), workspace, rel);
  });
}
