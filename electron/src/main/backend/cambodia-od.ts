/**
 * 柬埔寨 OD 演示数据读取层（外部素材，不进仓库）。
 *
 * 逐行等价迁移自 server/cambodia-od.mjs（S3-12，绞杀者分域 S3 批次，零依赖六域批）。
 *
 * 路径锚定：旧侧 PROJECT_DIR=__dirname 上一级（项目根），默认数据根取
 * 「项目目录的兄弟目录」（不写死某台机器的绝对路径——写死会让功能与测试只在
 * 那一台机器上成立）；素材放在别处时用 CAMBODIA_PROJECT_DIR / CAMBODIA_OD_FILE
 * 环境变量覆盖。TS 侧 PROJECT_DIR 直绑 workspace-paths（仓库根锚点，同批先例）。
 * 当前消费面：旧 index.mjs L14 命名空间 import，随流量切换批退役。
 */
import fs from "node:fs";
import path from "node:path";
import { PROJECT_DIR } from "./workspace-paths";

const DEFAULT_ROOT = path.resolve(PROJECT_DIR, "..", "柬埔寨公交项目");

function dataFile(): string {
  return process.env.CAMBODIA_OD_FILE || path.join(process.env.CAMBODIA_PROJECT_DIR || DEFAULT_ROOT, "od_data_for_map.json");
}

function readData(): any {
  const file = dataFile();
  if (!fs.existsSync(file)) return { error: `柬埔寨 OD 数据不存在：${file}` };
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const rows = Array.isArray(raw) ? raw : raw?.data || [];
    return { file, rows };
  } catch (e: any) {
    return { error: `柬埔寨 OD 数据解析失败：${e.message}` };
  }
}

export function getCambodiaOD({ minFlow = 0 }: any = {}): any {
  const loaded = readData();
  if (loaded.error) return loaded;
  const threshold = Math.max(0, Number(minFlow) || 0);
  const valid = loaded.rows.filter((row: any) => [row.start_lon, row.start_lat, row.dest_lon, row.dest_lat].every((v: any) => Number.isFinite(Number(v))) && (Number(row.flow) || 0) >= threshold);
  const totalFlow = valid.reduce((sum: number, row: any) => sum + (Number(row.flow) || 0), 0);
  const origins = new Map<string, number>();
  const destinations = new Map<string, number>();
  const pairs: any[] = [];
  for (const row of valid) {
    const flow = Number(row.flow) || 1;
    const origin = String(row.start || "未命名起点");
    const destination = String(row.dest || "未命名终点");
    origins.set(origin, (origins.get(origin) || 0) + flow);
    destinations.set(destination, (destinations.get(destination) || 0) + flow);
    pairs.push({ origin, destination, flow });
  }
  const top = (map: Map<string, number>) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, flow]) => ({ name, flow }));
  const points: any[] = [];
  const lines: any[] = [];
  for (const row of valid) {
    const flow = Number(row.flow) || 1;
    const origin = String(row.start || "未命名起点");
    const destination = String(row.dest || "未命名终点");
    const o = [Number(row.start_lon), Number(row.start_lat)];
    const d = [Number(row.dest_lon), Number(row.dest_lat)];
    points.push({ type: "Feature", properties: { name: origin, value: flow, role: "origin" }, geometry: { type: "Point", coordinates: o } });
    lines.push({ type: "Feature", properties: { origin, destination, flow }, geometry: { type: "LineString", coordinates: [o, d] } });
  }
  return {
    error: null,
    source: path.basename(loaded.file),
    sourcePath: loaded.file,
    status: "demo",
    stats: { records: valid.length, totalFlow, averageFlow: valid.length ? Number((totalFlow / valid.length).toFixed(2)) : 0, originCount: origins.size, destinationCount: destinations.size, minFlow: threshold },
    topOrigins: top(origins),
    topDestinations: top(destinations),
    topPairs: pairs.sort((a, b) => b.flow - a.flow).slice(0, 8),
    points: { type: "FeatureCollection", features: points },
    lines: { type: "FeatureCollection", features: lines },
  };
}
