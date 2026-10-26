/**
 * GIS 批量导出（G7，L3 交付层）——计划器与队列编排的纯函数核心。
 *
 * 逐行等价迁移自 server/batch-export.mjs（S3-12，绞杀者分域 S3 批次，零依赖六域批）。
 *
 * 口径（综合修改计划批次 4 / 审查 A3）：
 *   - 多项目 × 多图层组合 × 多尺寸（A4 横/纵、方形、自定义）× 多格式（PNG/PDF）展开为导出任务队列；
 *   - PDF 复用 B4 底座（内置浏览器 Page.printToPDF），PNG 复用内置浏览器截图（viewport=目标尺寸）；
 *   - 队列后台串行执行，不阻塞 UI；产物落工作区（成果可查），执行器由路由层注入以便单测。
 *
 * 本模块不依赖浏览器与文件系统（纯数据变换），执行器以异步函数注入。
 * 当前消费面：旧 index.mjs L5318 动态 import，随流量切换批退役。
 */

/** 与客户端 MapPanel EXPORT_SIZES 同源的尺寸预设（上限对齐内置浏览器 MAX_CAPTURE 2400×1600）。 */
export const EXPORT_SIZES: Readonly<Record<string, { label: string; width: number; height: number }>> = Object.freeze({
  a4l: Object.freeze({ label: "A4 横向", width: 1600, height: 1131 }),
  a4p: Object.freeze({ label: "A4 纵向", width: 1131, height: 1600 }),
  square: Object.freeze({ label: "方形", width: 1400, height: 1400 }),
});

/** 自定义尺寸边界（防极端值拖垮浏览器截图）。 */
export const CUSTOM_SIZE_LIMITS = Object.freeze({ width: [400, 2400], height: [300, 1600] });

export const EXPORT_FORMATS = Object.freeze(["png", "pdf"]);

/** 单次批量计划的任务数上限：超出部分跳过并在计划结果中标记，防止误操作拖垮服务。 */
export const MAX_JOBS = 24;

const PROJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const LAYER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function asStringList(value: any): string[] {
  if (Array.isArray(value)) return value.map((v: any) => String(v || "").trim()).filter(Boolean);
  if (typeof value === "string") return value.split(/[,，;；\s]+/).map((s) => s.trim()).filter(Boolean);
  return [];
}

function clampCustomSize(size: any): { width: number; height: number } | null {
  const width = Math.round(Number(size?.width));
  const height = Math.round(Number(size?.height));
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  return {
    width: Math.max(CUSTOM_SIZE_LIMITS.width[0]!, Math.min(CUSTOM_SIZE_LIMITS.width[1]!, width)),
    height: Math.max(CUSTOM_SIZE_LIMITS.height[0]!, Math.min(CUSTOM_SIZE_LIMITS.height[1]!, height)),
  };
}

function sanitizeFileNamePart(value: any): string {
  return String(value || "")
    .replace(/[\\/:*?"<>|\r\n]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

/**
 * 展开批量导出计划（纯函数）。
 *   jobs: [{id, project, layers, sizeId, sizeLabel, width, height, format, title, fileName}]
 */
export function planExportJobs(options: any = {}): any {
  const errors: string[] = [];
  const projects = [...new Set(asStringList(options.projects))];
  for (const p of projects) {
    if (!PROJECT_PATTERN.test(p)) errors.push(`非法项目名：${p}`);
  }
  if (!projects.length) errors.push("projects 不能为空");

  // layerSets：图层组合列表；空数组 = 使用项目当前可见图层（由导出视图自行解析）。
  const rawLayerSets = Array.isArray(options.layerSets) && options.layerSets.length
    ? options.layerSets
    : [[]];
  const layerSets = rawLayerSets.map((set: any, index: number) => {
    const layers = [...new Set(asStringList(set))];
    for (const id of layers) {
      if (!LAYER_ID_PATTERN.test(id)) errors.push(`非法图层 id（组合 ${index + 1}）：${id}`);
    }
    return layers;
  });

  // sizes：预设 id 或 {id:"custom",width,height}
  const rawSizes = Array.isArray(options.sizes) && options.sizes.length ? options.sizes : ["a4l"];
  const sizes: any[] = [];
  for (const entry of rawSizes) {
    if (typeof entry === "string") {
      if (!EXPORT_SIZES[entry]) { errors.push(`未知尺寸预设：${entry}`); continue; }
      sizes.push({ id: entry, ...EXPORT_SIZES[entry]! });
      continue;
    }
    const custom = clampCustomSize(entry);
    if (!custom) { errors.push("自定义尺寸需要数字 width/height"); continue; }
    sizes.push({ id: "custom", label: `自定义 ${custom.width}×${custom.height}`, ...custom });
  }
  if (!sizes.length) errors.push("sizes 不能为空（可用预设：" + Object.keys(EXPORT_SIZES).join("/") + " 或 custom）");

  const formats = [...new Set(asStringList(options.formats))];
  for (const f of formats) {
    if (!EXPORT_FORMATS.includes(f)) errors.push(`未知导出格式：${f}（可用：${EXPORT_FORMATS.join("/")}）`);
  }
  const useFormats = formats.length ? formats : ["png"];
  if (!formats.length) errors.push("formats 不能为空（可用：png/pdf）");

  if (errors.length) return { jobs: [], skipped: 0, errors };

  const title = sanitizeFileNamePart(options.title) || "地图导出";
  const seen = new Set<string>();
  const jobs: any[] = [];
  for (const project of projects) {
    for (const layers of layerSets) {
      for (const size of sizes) {
        for (const format of useFormats) {
          const key = [project, layers.join("+"), size.id === "custom" ? `custom:${size.width}x${size.height}` : size.id, format].join("|");
          if (seen.has(key)) continue;
          seen.add(key);
          const layersPart = layers.length ? `-${layers.join("_")}` : "";
          const sizePart = size.id === "custom" ? `${size.width}x${size.height}` : size.id;
          const fileName = sanitizeFileNamePart(`${title}-${project}${layersPart}-${sizePart}.${format}`) || `export-${jobs.length + 1}.${format}`;
          jobs.push({
            id: `job-${jobs.length + 1}`,
            project,
            layers,
            sizeId: size.id,
            sizeLabel: size.label,
            width: size.width,
            height: size.height,
            format,
            title,
            fileName,
          });
        }
      }
    }
  }
  // 上限保护：按展开顺序保留前 MAX_JOBS 个，其余记为 skipped（不静默丢弃）。
  const skipped = Math.max(0, jobs.length - MAX_JOBS);
  return { jobs: jobs.slice(0, MAX_JOBS), skipped, errors: [] };
}

type 导出结果 = {
  id: any;
  project: any;
  format: any;
  sizeId: any;
  status: string;
  file?: string;
  bytes?: number;
  error?: string;
  ms?: number;
};

/**
 * 串行执行导出队列（编排纯函数，执行器注入）。
 */
export async function runExportQueue(jobs: any, executor: any, { onProgress }: any = {}): Promise<any> {
  const list = Array.isArray(jobs) ? jobs : [];
  const results: 导出结果[] = list.map((job: any) => ({
    id: job.id,
    project: job.project,
    format: job.format,
    sizeId: job.sizeId,
    status: "pending",
  }));
  const snapshot = () => ({
    total: list.length,
    done: results.filter((r) => r.status === "done").length,
    failed: results.filter((r) => r.status === "failed").length,
    results,
  });
  const startedAt = new Date().toISOString();
  for (let index = 0; index < list.length; index += 1) {
    const job = list[index];
    const started = Date.now();
    results[index]!.status = "running";
    onProgress?.(snapshot());
    try {
      if (typeof executor !== "function") throw new Error("导出执行器不可用");
      const out = await executor(job);
      results[index]!.status = "done";
      results[index]!.file = String(out?.file || "");
      results[index]!.bytes = Number(out?.bytes) || undefined;
    } catch (e: any) {
      results[index]!.status = "failed";
      results[index]!.error = String(e?.message || e);
    }
    results[index]!.ms = Date.now() - started;
    onProgress?.(snapshot());
  }
  return { ...snapshot(), startedAt, finishedAt: new Date().toISOString() };
}
