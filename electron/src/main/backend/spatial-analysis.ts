/**
 * 空间分析（G1，L1"砖"层）：零依赖 GeoJSON 几何算子子集。
 *
 * 逐行等价迁移自 server/spatial-analysis.mjs（S3-10，绞杀者分域 S3 批次）。
 * 旧行为保真：falsy/可选链/Number 语义与旧 JS 一致；noUncheckedIndexedAccess
 * 索引访问加 ! 收窄；私有实现形态（any 载体）不设静态 GeoJSON 类型约束，
 * 与旧 JS 动态形参逐一对应。
 *
 * 设计口径（v1，均为经纬度平面近似，适合市级尺度的规划分析）：
 *   - buffer：点 → 圆形面；多边形 → 环偏移（miter 连接，外环外扩/内环内缩）；
 *     折线 → 按段生成"胶囊"（四边形 + 两端圆弧）的 MultiPolygon（各段之间允许重叠，
 *     视觉等价于折线缓冲带；面积统计按几何口径不做重叠去重）。
 *   - spatial_filter：以一组裁剪要素为参照，筛选 intersect / within 的要素（布尔判定，不改几何）。
 *   - bbox_clip：矩形裁剪，多边形用 Sutherland–Hodgman（凸裁剪域下结果精确），折线用逐段裁剪。
 *   - 距离单位一律为米；度↔米换算用本地纬度比例（110540 / 111320·cos φ）。
 * 已知限制（v1 不做拓扑合并/精确布尔并差交）：多边形大距离外扩可能出现自相交环；
 * spatial_filter 只做选择不输出裁剪几何。这些限制已写进工具描述，供模型如实转述。
 *
 * 消费面：agent create-tools 的 map_analyze 工具（动态 import ../spatial-analysis，
 * S3-10 起替换 @legacy-server/spatial-analysis.mjs 过渡动态 import）；
 * 旧侧 server/agent.mjs 消费点随流量切换批退役。
 */

const LAT_M = 110_540; // 每纬度米数（近似常数）
const LNG_M_DEG = 111_320; // 赤道每经度米数，实际乘 cos(lat)

function metersPerDegree(lat: number): { lat: number; lng: number } {
  return { lat: LAT_M, lng: Math.max(1_000, LNG_M_DEG * Math.cos((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180)) };
}

function coordType(geometry: any): string {
  return String(geometry?.type || "");
}

function eachPosition(geometry: any, cb: (pt: number[], depth: number) => void): void {
  const walk = (coords: any, depth: number): void => {
    if (typeof coords[0] === "number") { cb(coords, depth); return; }
    for (const item of coords) walk(item, depth + 1);
  };
  walk(geometry?.coordinates || [], 0);
}

export function bboxOf(geometry: any): [number, number, number, number] | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, seen = 0;
  eachPosition(geometry, (pt) => {
    seen += 1;
    if (pt[0]! < minX) minX = pt[0]!;
    if (pt[1]! < minY) minY = pt[1]!;
    if (pt[0]! > maxX) maxX = pt[0]!;
    if (pt[1]! > maxY) maxY = pt[1]!;
  });
  return seen ? [minX, minY, maxX, maxY] : null;
}

export function bboxesIntersect(a: any, b: any): boolean {
  return Boolean(a && b && a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]);
}

function signedRingAreaM2(ring: number[][], scale: { lat: number; lng: number }): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    sum += (ring[i]![0]! * scale.lng - ring[i + 1]![0]! * scale.lng) * (ring[i + 1]![1]! * scale.lat + ring[i]![1]! * scale.lat);
  }
  return sum / 2;
}

function polygonAreaM2(coordinates: any, scale: { lat: number; lng: number }): number {
  if (!Array.isArray(coordinates) || !coordinates.length) return 0;
  let area = Math.abs(signedRingAreaM2(coordinates[0], scale));
  for (let i = 1; i < coordinates.length; i += 1) area -= Math.abs(signedRingAreaM2(coordinates[i], scale));
  return area;
}

export function geometryAreaM2(geometry: any): number {
  const bbox = bboxOf(geometry);
  if (!bbox) return 0;
  const scale = metersPerDegree((bbox[1]! + bbox[3]!) / 2);
  if (geometry.type === "Polygon") return polygonAreaM2(geometry.coordinates, scale);
  if (geometry.type === "MultiPolygon") return geometry.coordinates.reduce((sum: number, poly: any) => sum + polygonAreaM2(poly, scale), 0);
  return 0;
}

function lineLengthM(geometry: any): number {
  let total = 0;
  const scale = metersPerDegree((bboxOf(geometry)?.[1] ?? 30));
  const addLine = (coords: any[]): void => {
    for (let i = 0; i < coords.length - 1; i += 1) {
      const dx = (coords[i + 1]![0]! - coords[i]![0]!) * scale.lng;
      const dy = (coords[i + 1]![1]! - coords[i]![1]!) * scale.lat;
      total += Math.hypot(dx, dy);
    }
  };
  if (geometry.type === "LineString") addLine(geometry.coordinates);
  else if (geometry.type === "MultiLineString") geometry.coordinates.forEach(addLine);
  return total;
}

export function geometryLengthM(geometry: any): number {
  if (coordType(geometry) === "LineString" || coordType(geometry) === "MultiLineString") return lineLengthM(geometry);
  return 0;
}

function pointInRing(pt: number[], ring: any[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if ((yi! > pt[1]!) !== (yj! > pt[1]!) && pt[0]! < ((xj! - xi!) * (pt[1]! - yi!)) / (yj! - yi!) + xi!) inside = !inside;
  }
  return inside;
}

function pointInGeometry(pt: number[], geometry: any): boolean {
  const inPolygon = (poly: any[]): boolean => pointInRing(pt, poly[0]) && poly.slice(1).every((hole: any[][]) => !pointInRing(pt, hole));
  if (geometry.type === "Polygon") return inPolygon(geometry.coordinates);
  if (geometry.type === "MultiPolygon") return geometry.coordinates.some(inPolygon);
  return false;
}

function segmentsIntersect(p1: number[], p2: number[], p3: number[], p4: number[]): boolean {
  const d = (a: number[], b: number[], c: number[]): number => (b[0]! - a[0]!) * (c[1]! - a[1]!) - (b[1]! - a[1]!) * (c[0]! - a[0]!);
  const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

function eachSegment(geometry: any, cb: (p1: number[], p2: number[]) => void): void {
  const walkLine = (coords: any[]): void => { for (let i = 0; i < coords.length - 1; i += 1) cb(coords[i]!, coords[i + 1]!); };
  if (geometry.type === "LineString") walkLine(geometry.coordinates);
  else if (geometry.type === "MultiLineString") geometry.coordinates.forEach(walkLine);
  else if (geometry.type === "Polygon") geometry.coordinates.forEach(walkLine);
  else if (geometry.type === "MultiPolygon") geometry.coordinates.forEach((poly: any[]) => poly.forEach(walkLine));
}

/** 布尔相交判定：bbox 预筛 → 边对相交 → 退化为包含判定。不输出几何。 */
export function geometriesIntersect(a: any, b: any): boolean {
  const ba = bboxOf(a), bb = bboxOf(b);
  if (!bboxesIntersect(ba, bb)) return false;
  let crossed = false;
  outer: for (const sa of [a]) {
    for (const sb of [b]) {
      eachSegment(sa, (p1, p2) => {
        if (crossed) return;
        eachSegment(sb, (p3, p4) => {
          if (segmentsIntersect(p1, p2, p3, p4)) { crossed = true; return; }
        });
        if (crossed) return;
      });
    }
    if (crossed) break outer;
  }
  if (crossed) return true;
  // 无边相交时退化为包含：任一要素的代表点落在对方内部
  const representative = (geometry: any): number[] | null => {
    if (geometry.type === "Point") return geometry.coordinates;
    if (geometry.type === "MultiPoint") return geometry.coordinates[0];
    const bbox = bboxOf(geometry);
    return bbox ? [(bbox[0]! + bbox[2]!) / 2, (bbox[1]! + bbox[3]!) / 2] : null;
  };
  const pa = representative(a), pb = representative(b);
  if (pa && pointInGeometry(pa, b)) return true;
  if (pb && pointInGeometry(pb, a)) return true;
  return false;
}

function toLocalMeters(geometry: any, origin: number[]): { coordinates: any; scale: { lat: number; lng: number } } {
  const scale = metersPerDegree(origin[1]!);
  const map = ([lng, lat]: number[]): number[] => [(lng! - origin[0]!) * scale.lng, (lat! - origin[1]!) * scale.lat];
  const walk = (coords: any, depth: number): any => (typeof coords[0] === "number" ? map(coords) : coords.map((item: any) => walk(item, depth + 1)));
  return { coordinates: walk(geometry.coordinates, 0), scale };
}

function fromLocalMeters(coordinates: any, origin: number[], scale: { lat: number; lng: number }): any {
  const walk = (coords: any): any => (typeof coords[0] === "number" ? [coords[0]! / scale.lng + origin[0]!, coords[1]! / scale.lat + origin[1]!] : coords.map(walk));
  return walk(coordinates);
}

function circlePolygon(center: number[], radiusM: number, steps: number, scale: { lat: number; lng: number }): number[][][] {
  const ring: number[][] = [];
  for (let i = 0; i <= steps; i += 1) {
    const angle = (i / steps) * Math.PI * 2;
    ring.push([center[0]! + Math.cos(angle) * radiusM / scale.lng, center[1]! + Math.sin(angle) * radiusM / scale.lat]);
  }
  return [ring];
}

function offsetRingMeters(ringLocal: number[][], distance: number): number[][] | null {
  // 对每条边求法向偏移线，相邻偏移线求交（miter）；退化段跳过。
  const n = ringLocal.length - 1 >= 3 ? ringLocal.length - 1 : ringLocal.length;
  const lines: { a: number[]; b: number[] }[] = [];
  for (let i = 0; i < n; i += 1) {
    const a = ringLocal[i]!, b = ringLocal[(i + 1) % n]!;
    const dx = b[0]! - a[0]!, dy = b[1]! - a[1]!;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    const nx = -dy / len, ny = dx / len;
    lines.push({ a: [a[0]! + nx * distance, a[1]! + ny * distance], b: [b[0]! + nx * distance, b[1]! + ny * distance] });
  }
  if (lines.length < 3) return null;
  const out: number[][] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const cur = lines[i]!, next = lines[(i + 1) % lines.length]!;
    out.push(cur.a);
    const d1x = cur.b[0]! - cur.a[0]!, d1y = cur.b[1]! - cur.a[1]!;
    const d2x = next.b[0]! - next.a[0]!, d2y = next.b[1]! - next.a[1]!;
    const denom = d1x * d2y - d1y * d2x;
    if (Math.abs(denom) > 1e-9) {
      const t = ((next.a[0]! - cur.a[0]!) * d2y - (next.a[1]! - cur.a[1]!) * d2x) / denom;
      if (t > -5 && t < 1e6) out.push([cur.a[0]! + d1x * t, cur.a[1]! + d1y * t]);
    } else {
      out.push(cur.b);
    }
  }
  out.push(out[0]!);
  return out;
}

function polygonBuffer(coordinates: any, distanceM: number, origin: number[], steps: number): any[] {
  const scale = metersPerDegree(origin[1]!);
  return coordinates
    .map((ring: number[][], index: number) => {
      const local: number[][] = ring.map(([lng, lat]) => [(lng! - origin[0]!) * scale.lng, (lat! - origin[1]!) * scale.lat]);
      // 外环外扩、内环内缩：方向由"偏移后面积变大"决定，避免依赖环方向约定
      const grow = offsetRingMeters(local, distanceM);
      const shrink = offsetRingMeters(local, -distanceM);
      const areaOf = (ring: number[][] | null): number => {
        if (!ring) return -1;
        let sum = 0;
        for (let i = 0; i < ring.length - 1; i += 1) sum += ring[i]![0]! * ring[i + 1]![1]! - ring[i + 1]![0]! * ring[i]![1]!;
        return Math.abs(sum / 2);
      };
      const pick = areaOf(grow) >= areaOf(local) && areaOf(grow) > 0 ? grow : shrink;
      if (!pick || areaOf(pick) <= 0) return index === 0 ? null : null;
      return pick.map(([x, y]) => [x! / scale.lng + origin[0]!, y! / scale.lat + origin[1]!]);
    })
    .filter(Boolean);
}

/** 缓冲：distanceM 为米。点→圆；面→环偏移；线→逐段胶囊 MultiPolygon（v1 口径，见文件头）。 */
export function bufferGeometry(geometry: any, distanceM: number, steps = 48): any {
  const origin = (() => {
    const b = bboxOf(geometry);
    return b ? [(b[0]! + b[2]!) / 2, (b[1]! + b[3]!) / 2] : [120, 30];
  })();
  const scale = metersPerDegree(origin[1]!);
  if (geometry.type === "Point") return { type: "Polygon", coordinates: circlePolygon(geometry.coordinates, distanceM, steps, scale) };
  if (geometry.type === "MultiPoint") {
    return { type: "MultiPolygon", coordinates: geometry.coordinates.map((pt: number[]) => circlePolygon(pt, distanceM, steps, scale)) };
  }
  if (geometry.type === "Polygon") {
    const coords = polygonBuffer(geometry.coordinates, distanceM, origin, steps);
    return coords.length ? { type: "Polygon", coordinates: coords } : null;
  }
  if (geometry.type === "MultiPolygon") {
    const polys = geometry.coordinates.map((poly: any) => polygonBuffer(poly, distanceM, origin, steps)).filter((p: any[]) => p.length);
    return polys.length ? { type: "MultiPolygon", coordinates: polys } : null;
  }
  if (geometry.type === "LineString" || geometry.type === "MultiLineString") {
    const polygons: number[][][][] = [];
    eachSegment(geometry, (p1, p2) => {
      const dx = p2[0]! - p1[0]!, dy = p2[1]! - p1[1]!;
      const len = Math.hypot(dx * scale.lng, dy * scale.lat);
      if (len < 1e-6) return;
      const nx = (-dy / (dx * scale.lng || 1e-9)), ny = (dx / (dy * scale.lat || 1e-9));
      // 归一化法向（米空间）
      const nl = Math.hypot(nx * scale.lng, ny * scale.lat) || 1;
      const ux = (nx * scale.lng) / nl, uy = (ny * scale.lat) / nl;
      const ring: number[][] = [];
      const capSteps = Math.max(8, Math.floor(steps / 4));
      for (let i = 0; i <= capSteps; i += 1) {
        const a = Math.PI / 2 + (i / capSteps) * Math.PI;
        ring.push([p2[0]! + Math.cos(a) * distanceM / scale.lng, p2[1]! + Math.sin(a) * distanceM / scale.lat]);
      }
      for (let i = 0; i <= capSteps; i += 1) {
        const a = -Math.PI / 2 + (i / capSteps) * Math.PI;
        ring.push([p1[0]! + Math.cos(a) * distanceM / scale.lng, p1[1]! + Math.sin(a) * distanceM / scale.lat]);
      }
      ring.push(ring[0]!);
      polygons.push([ring]);
    });
    return polygons.length ? { type: "MultiPolygon", coordinates: polygons } : null;
  }
  return null;
}

/** Sutherland–Hodgman：用凸裁剪域（bbox）裁多边形环，结果顶点全部落在 bbox 内。 */
function clipRingToBbox(ring: number[][], bbox: number[]): number[][] | null {
  const inside = (p: number[], edge: number): boolean => {
    if (edge === 0) return p[0]! >= bbox[0]!;
    if (edge === 1) return p[0]! <= bbox[2]!;
    if (edge === 2) return p[1]! >= bbox[1]!;
    return p[1]! <= bbox[3]!;
  };
  const intersect = (p1: number[], p2: number[], edge: number): number[] => {
    if (edge === 0 || edge === 1) {
      const x = edge === 0 ? bbox[0]! : bbox[2]!;
      const t = (x - p1[0]!) / (p2[0]! - p1[0]!);
      return [x, p1[1]! + t * (p2[1]! - p1[1]!)];
    }
    const y = edge === 2 ? bbox[1]! : bbox[3]!;
    const t = (y - p1[1]!) / (p2[1]! - p1[1]!);
    return [p1[0]! + t * (p2[0]! - p1[0]!), y];
  };
  let output = ring;
  for (let edge = 0; edge < 4; edge += 1) {
    const input = output;
    output = [];
    if (!input.length) break;
    for (let i = 0; i < input.length; i += 1) {
      const cur = input[i]!, prev = input[(i + input.length - 1) % input.length]!;
      const curIn = inside(cur, edge), prevIn = inside(prev, edge);
      if (curIn) {
        if (!prevIn) output.push(intersect(prev, cur, edge));
        output.push(cur);
      } else if (prevIn) {
        output.push(intersect(prev, cur, edge));
      }
    }
  }
  return output.length >= 4 ? output : null;
}

/** 矩形裁剪：多边形（逐环 S-H）与折线（逐段裁剪拼接）。 */
export function bboxClipGeometry(geometry: any, bbox: number[]): any {
  if (geometry.type === "Polygon") {
    const rings = geometry.coordinates.map((ring: number[][]) => clipRingToBbox(ring, bbox)).filter(Boolean);
    return rings.length ? { type: "Polygon", coordinates: rings } : null;
  }
  if (geometry.type === "MultiPolygon") {
    const polys = geometry.coordinates
      .map((poly: number[][][]) => poly.map((ring: number[][]) => clipRingToBbox(ring, bbox)).filter(Boolean))
      .filter((rings: number[][]) => rings.length);
    return polys.length ? { type: "MultiPolygon", coordinates: polys } : null;
  }
  if (geometry.type === "LineString") {
    const pieces: number[][][] = [];
    const coords: number[][] = geometry.coordinates;
    for (let i = 0; i < coords.length - 1; i += 1) {
      const a = coords[i]!, b = coords[i + 1]!;
      let t0 = 0, t1 = 1;
      const d = [b[0]! - a[0]!, b[1]! - a[1]!];
      let ok = true;
      for (let edge = 0; edge < 4 && ok; edge += 1) {
        const p = edge === 0 ? -d[0]! : edge === 1 ? d[0]! : edge === 2 ? -d[1]! : d[1]!;
        const q = edge === 0 ? a[0]! - bbox[0]! : edge === 1 ? bbox[2]! - a[0]! : edge === 2 ? a[1]! - bbox[1]! : bbox[3]! - a[1]!;
        if (p === 0) { if (q < 0) ok = false; continue; }
        const t = q / p;
        if (p < 0) { if (t > t1) ok = false; else if (t > t0) t0 = t; }
        else { if (t < t0) ok = false; else if (t < t1) t1 = t; }
      }
      if (ok && t1 > t0) {
        const start = t0 === 0 ? a : [a[0]! + d[0]! * t0, a[1]! + d[1]! * t0];
        const end = t1 === 1 ? b : [a[0]! + d[0]! * t1, a[1]! + d[1]! * t1];
        pieces.push([start, end]);
      }
    }
    if (!pieces.length) return null;
    let current = [pieces[0]![0]!, pieces[0]![1]!];
    const lines: number[][][] = [];
    for (let i = 1; i < pieces.length; i += 1) {
      const last = current[current.length - 1]!;
      if (last[0] === pieces[i]![0]![0] && last[1] === pieces[i]![0]![1]) current.push(pieces[i]![1]!);
      else { lines.push(current); current = [pieces[i]![0]!, pieces[i]![1]!]; }
    }
    lines.push(current);
    return lines.length === 1 ? { type: "LineString", coordinates: lines[0] } : { type: "MultiLineString", coordinates: lines };
  }
  return null;
}

/**
 * 统一入口：type = buffer | spatial_filter | bbox_clip。
 * 返回 { geojson, stats }；无可保留要素时 geojson 为空 FeatureCollection。
 */
export function analyzeGeoJSON({ type, geojson, distanceMeters = 500, clipBbox = null, clipGeojson = null, mode = "intersects", steps = 48 }: {
  type: string; geojson: any; distanceMeters?: number; clipBbox?: number[] | null; clipGeojson?: any; mode?: string; steps?: number;
}): { geojson: any; stats: Record<string, any> } {
  const startedAt = Date.now();
  const features: any[] = Array.isArray(geojson?.features) ? geojson.features : [];
  const out: any[] = [];
  let totalAreaM2 = 0, totalLengthM = 0;
  if (type === "buffer") {
    for (const feature of features) {
      const geometry = feature?.geometry;
      if (!geometry) continue;
      const buffered = bufferGeometry(geometry, distanceMeters, steps);
      if (!buffered) continue;
      totalAreaM2 += geometryAreaM2(buffered);
      out.push({ type: "Feature", properties: { ...feature.properties, bufferDistanceM: distanceMeters }, geometry: buffered });
    }
  } else if (type === "bbox_clip") {
    for (const feature of features) {
      const geometry = feature?.geometry;
      if (!geometry) continue;
      const clipped = bboxClipGeometry(geometry, clipBbox || bboxOf(geometry)!);
      if (!clipped) continue;
      totalAreaM2 += geometryAreaM2(clipped);
      totalLengthM += geometryLengthM(clipped);
      out.push({ type: "Feature", properties: { ...feature.properties }, geometry: clipped });
    }
  } else if (type === "spatial_filter") {
    const refs: any[] = Array.isArray(clipGeojson?.features) ? clipGeojson.features : [];
    if (!refs.length) return { geojson: { type: "FeatureCollection", features: [] }, stats: { count: 0, elapsedMs: Date.now() - startedAt, note: "无裁剪参照要素" } };
    for (const feature of features) {
      const geometry = feature?.geometry;
      if (!geometry) continue;
      const fb = bboxOf(geometry);
      const matched = refs.some((ref) => {
        const rb = bboxOf(ref.geometry || {});
        if (!bboxesIntersect(fb, rb)) return false;
        if (mode === "within") {
          const rep = geometry.type === "Point" ? geometry.coordinates : (() => { const b = bboxOf(geometry)!; return [(b[0]! + b[2]!) / 2, (b[1]! + b[3]!) / 2]; })();
          return pointInGeometry(rep, ref.geometry);
        }
        return geometriesIntersect(geometry, ref.geometry);
      });
      if (matched) out.push(feature);
    }
  } else {
    throw new Error(`未知的空间分析类型：${type}`);
  }
  return {
    geojson: { type: "FeatureCollection", features: out },
    stats: {
      count: out.length,
      inputCount: features.length,
      totalAreaM2: Math.round(totalAreaM2),
      totalAreaKm2: Math.round(totalAreaM2 / 100) / 100,
      totalLengthM: Math.round(totalLengthM),
      elapsedMs: Date.now() - startedAt,
      planarApprox: true,
    },
  };
}
