/**
 * 地图项目打包归档（GIS G9，L3 交付层）——flag OAW_MAP_PACK（默认关）。
 *
 * 口径：把项目的「配置 + 样式（已脱敏）+ 图层数据 + 瓦片索引」打包为 zip，
 * zip 内布局与项目目录一致（跨环境恢复 = 解压到 MAPS_ROOT/<project>/），另附
 * MANIFEST.json 记录清单与恢复提示。瓦片（.pbf）默认不进包（体积大且可由图层重建），
 * 可选 includeTiles 带上（总量超上限时报错而非静默截断）。
 */
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import * as mapSvc from "./map.mjs";

/** 打包体积护栏：瓦片可选携带的总量上限。 */
const MAX_TILES_BYTES = 256 * 1024 * 1024;
/** 单包文件数护栏（防异常目录拖垮内存）。 */
const MAX_FILES = 5000;

function dirSize(dir) {
  let total = 0;
  let count = 0;
  if (!fs.existsSync(dir)) return { bytes: 0, files: 0 };
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = dirSize(p);
      total += sub.bytes;
      count += sub.files;
    } else if (entry.isFile()) {
      total += fs.statSync(p).size;
      count += 1;
    }
  }
  return { bytes: total, files: count };
}

/** 瓦片索引：每图层 {files, bytes, maxZoom（从文件名聚合）}。 */
function buildTilesIndex(projectDir) {
  const tilesDir = path.join(projectDir, "tiles");
  const index = {};
  if (!fs.existsSync(tilesDir)) return index;
  for (const layer of fs.readdirSync(tilesDir, { withFileTypes: true })) {
    if (!layer.isDirectory()) continue;
    const layerDir = path.join(tilesDir, layer.name);
    const stat = dirSize(layerDir);
    let maxZoom = -1;
    for (const z of fs.readdirSync(layerDir, { withFileTypes: true })) {
      if (!z.isDirectory()) continue;
      const zoom = Number.parseInt(z.name, 10);
      if (Number.isFinite(zoom) && zoom > maxZoom) maxZoom = zoom;
    }
    index[layer.name] = { files: stat.files, bytes: stat.bytes, maxZoom: maxZoom >= 0 ? maxZoom : null };
  }
  return index;
}

/**
 * 打包地图项目 → zip。
 * @param {{project: string, includeTiles?: boolean}} options
 * @returns {Promise<{buffer: Buffer, fileName: string, manifest: object, stats: {files: number, bytes: number}}>}
 */
export async function buildProjectZip(options = {}) {
  const project = String(options.project || "").trim();
  const dir = mapSvc.projectDir(project);
  if (!dir || !fs.existsSync(path.join(dir, "map.config.json"))) {
    throw Object.assign(new Error(`地图项目不存在：${project || "(空)"}`), { code: "MAP_PROJECT_NOT_FOUND" });
  }
  const includeTiles = options.includeTiles === true;

  const zip = new JSZip();
  const added = [];
  const addFile = (rel) => {
    const source = path.join(dir, rel);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) return;
    zip.file(rel, fs.readFileSync(source));
    added.push({ path: rel, bytes: fs.statSync(source).size });
  };

  // 核心：配置 + 脱敏样式（style.json 本身就是 redact 后的 tracked 版本，不带 Key）
  addFile("map.config.json");
  addFile("style.json");

  // 图层数据（layers/*.geojson 等）
  const layersDir = path.join(dir, "layers");
  const layerFiles = fs.existsSync(layersDir)
    ? fs.readdirSync(layersDir, { withFileTypes: true }).filter((e) => e.isFile() && !e.name.startsWith(".")).map((e) => `layers/${e.name}`)
    : [];
  for (const rel of layerFiles.slice(0, MAX_FILES)) addFile(rel);

  // 瓦片索引（必带）+ 可选瓦片本体
  const tilesIndex = buildTilesIndex(dir);
  const manifest = {
    version: 1,
    kind: "open-plan-map-project",
    project,
    exportedAt: new Date().toISOString(),
    config: mapSvc.getProject(project)?.config?.name || project,
    files: added.map((f) => f.path),
    layerCount: layerFiles.length,
    tilesIndex,
    tilesIncluded: includeTiles,
    restoreHint: includeTiles
      ? "解压到 MAPS_ROOT/<project>/（默认 office-workspace/maps/<project>/）后重启服务即可使用。"
      : "解压到 MAPS_ROOT/<project>/（默认 office-workspace/maps/<project>/）后，先执行「重建瓦片」（map:prepare / map:tiles 或界面重建），瓦片索引只含统计不含 .pbf 本体。",
  };
  zip.file("MANIFEST.json", JSON.stringify(manifest, null, 2));

  if (includeTiles) {
    const tilesDir = path.join(dir, "tiles");
    if (fs.existsSync(tilesDir)) {
      let total = 0;
      const walk = (relDir) => {
        for (const entry of fs.readdirSync(path.join(dir, relDir), { withFileTypes: true })) {
          const rel = `${relDir}/${entry.name}`;
          if (entry.isDirectory()) walk(rel);
          else if (entry.isFile()) {
            const size = fs.statSync(path.join(dir, rel)).size;
            total += size;
            if (total > MAX_TILES_BYTES) {
              throw Object.assign(new Error(`瓦片总量超过 ${Math.round(MAX_TILES_BYTES / 1024 / 1024)}MB 上限，请去掉 includeTiles 用索引 + 重建方式恢复`), { code: "MAP_PACK_TOO_LARGE" });
            }
            zip.file(rel, fs.readFileSync(path.join(dir, rel)));
            added.push({ path: rel, bytes: size });
          }
        }
      };
      walk("tiles");
    }
  }

  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  const fileName = `${project}-map-${new Date().toISOString().slice(0, 10)}.zip`;
  return {
    buffer,
    fileName,
    manifest,
    stats: { files: added.length, bytes: buffer.length },
  };
}
