/**
 * 全链路首字延迟样本仓库（方案 §3.5）。
 *
 * 客户端打 client_submit / first_event / first_text_delta / first_dom_text，
 * 服务端打 server_received / admission_ready / sdk_request_dispatched /
 * first_provider_event。两侧用 runId 合并成一条样本，按阶段给出 P50/P95。
 *
 * 关键口径：缺某一段就留 null，绝不用 0 代替——"没有样本"和"耗时 0ms"
 * 在延迟统计里是完全不同的两件事。
 *
 * 与 server/first-token-latency.mjs 逐函数等价（tests/first-token-latency-parity.test.ts 对拍强制）。
 */

/** 进程内滚动窗口：够看近期回归，又不会随长跑进程无限增长。 */
const MAX_SAMPLES = 500;
const samples: Array<Record<string, unknown>> = [];
/** 尚未收到终态的 run：只保留阶段打点，收到终态后才进入统计。 */
const pending = new Map<string, PendingEntry>();
/** 待结算集合的硬上限：Run 永不收口时不能无限堆积。 */
const MAX_PENDING = 200;
/** 待结算标记的最长保留时间：超时按"未收口"兜底落地。 */
const PENDING_TTL_MS = 10 * 60_000;

interface PendingEntry {
  runId: string;
  marks: Record<string, unknown>;
  meta: Record<string, unknown>;
  updatedAt?: number;
  spans?: Record<string, number>;
}

/** 允许登记的阶段名；客户端上报时只接受这些字段，其余一律丢弃。 */
export const STAGE_KEYS: readonly string[] = Object.freeze([
  "clientSubmitAt",
  "serverReceivedAt",
  "admissionReadyAt",
  "sdkRequestDispatchedAt",
  "firstProviderEventAt",
  "firstEventAt",
  "firstTextDeltaAt",
  "firstDomTextAt"
]);

/** 样本之间可比的分项耗时（单位 ms）。 */
const DERIVED_KEYS: readonly string[] = Object.freeze([
  "submitToServerReceivedMs",
  "serverReceivedToAdmissionReadyMs",
  "admissionReadyToSdkDispatchMs",
  "sdkDispatchToFirstProviderEventMs",
  "submitToFirstTextDeltaMs",
  "submitToFirstDomTextMs",
  "tokenToDomMs"
]);

function numeric(value: unknown): number | null {
  return Number.isFinite(value) ? Number(value) : null;
}

function derive(marks: Record<string, unknown> = {}): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  const delta = (from: string, to: string): number | null => {
    const a = numeric(marks[from]);
    const b = numeric(marks[to]);
    return a != null && b != null ? b - a : null;
  };
  out.submitToServerReceivedMs = delta("clientSubmitAt", "serverReceivedAt");
  out.serverReceivedToAdmissionReadyMs = delta("serverReceivedAt", "admissionReadyAt");
  out.admissionReadyToSdkDispatchMs = delta("admissionReadyAt", "sdkRequestDispatchedAt");
  out.sdkDispatchToFirstProviderEventMs = delta("sdkRequestDispatchedAt", "firstProviderEventAt");
  out.submitToFirstTextDeltaMs = delta("clientSubmitAt", "firstTextDeltaAt");
  out.submitToFirstDomTextMs = delta("clientSubmitAt", "firstDomTextAt");
  out.tokenToDomMs = delta("firstTextDeltaAt", "firstDomTextAt");
  return out;
}

/** 服务端阶段打点：同一阶段只记第一次（重试/多回合不会覆盖首字口径）。 */
export function markRunTiming(runId: unknown, stage: unknown, at: unknown = Date.now()): PendingEntry | null {
  const id = String(runId || "").trim();
  if (!id || !STAGE_KEYS.includes(stage as string)) return null;
  const entry = pending.get(id) || { runId: id, marks: {}, meta: {} };
  if (entry.marks[stage as string] == null) entry.marks[stage as string] = numeric(at);
  entry.updatedAt = Date.now();
  pending.set(id, entry);
  // 极端情况下（Run 永不收口）不能让待结算集合无限增长。
  if (pending.size > MAX_PENDING) flushStalePending(0);
  return entry;
}

/**
 * 兜底结算：并非每条 Run 都会走到 run_finished。超过保留期的待结算标记直接落地成样本，
 * 样本标注 outcome=unsettled，统计时仍可用，但不会被误读成"正常完成"。
 */
function flushStalePending(maxAgeMs: number = PENDING_TTL_MS): number {
  const now = Date.now();
  const expired: string[] = [];
  for (const [id, entry] of pending) {
    if (now - Number(entry.updatedAt || now) >= maxAgeMs) expired.push(id);
  }
  for (const id of expired) {
    const entry = pending.get(id);
    pending.delete(id);
    const sample = finalizeSample(entry?.marks || {}, entry?.meta || {}, { outcome: "unsettled" });
    if (sample) pushSample(sample);
  }
  return expired.length;
}

function pushSample(sample: Record<string, unknown>): Record<string, unknown> {
  samples.push(sample);
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
  return sample;
}

/** 把阶段打点组装成一条样本（含派生分项）。 */
function finalizeSample(marks: Record<string, unknown> = {}, meta: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Record<string, unknown> | null {
  if (!STAGE_KEYS.some((key) => marks[key] != null)) return null;
  return {
    runId: extra.runId || marks.runId || null,
    at: Date.now(),
    ...extra,
    ...meta,
    ...marks,
    ...derive(marks)
  };
}

export function attachRunTimingMeta(runId: unknown, meta: Record<string, unknown> = {}): PendingEntry | null {
  const id = String(runId || "").trim();
  if (!id) return null;
  const entry = pending.get(id) || { runId: id, marks: {}, meta: {} };
  entry.meta = { ...entry.meta, ...meta };
  pending.set(id, entry);
  return entry;
}

/**
 * 细分耗时打点（准入与派发阶段内部的构成）：按名字记录毫秒耗时，
 * 随样本一起输出，/api/agent/timing 可直接看到每一项的 p50/p90。
 */
export function attachRunTimingSpans(runId: unknown, spans: Record<string, unknown> = {}): Record<string, number> | null {
  const id = String(runId || "").trim();
  if (!id) return null;
  const entry = pending.get(id) || { runId: id, marks: {}, meta: {} };
  const clean: Record<string, number> = {};
  for (const [key, value] of Object.entries(spans || {})) {
    const ms = Number(value);
    if (Number.isFinite(ms) && ms >= 0) clean[key] = Math.round(ms);
  }
  entry.spans = { ...(entry.spans || {}), ...clean };
  pending.set(id, entry);
  return entry.spans;
}

export interface FinishRunTimingExtra {
  client?: unknown;
  meta?: Record<string, unknown>;
  model?: unknown;
  mode?: unknown;
  spans?: Record<string, number>;
  [key: string]: unknown;
}

/** Run 进入终态：把阶段打点与客户端样本合并成一条可统计样本。 */
export function finishRunTiming(runId: unknown, extra: FinishRunTimingExtra = {}): Record<string, unknown> | null {
  const id = String(runId || "").trim();
  if (!id) return null;
  const entry = pending.get(id);
  pending.delete(id);
  const clientMarks = extra.client && typeof extra.client === "object" ? (extra.client as Record<string, unknown>) : {};
  const marks = { ...(entry?.marks || {}), ...clientMarks };
  const meta = { ...(entry?.meta || {}), ...(extra.meta || {}) };
  if (!STAGE_KEYS.some((key) => marks[key] != null)) return null;
  const spans = { ...(entry?.spans || {}), ...(extra.spans || {}) };
  const sample: Record<string, unknown> = {
    runId: id,
    at: Date.now(),
    ...meta,
    model: extra.model || meta.model || null,
    mode: extra.mode || meta.mode || null,
    ...marks,
    ...derive(marks),
    ...(Object.keys(spans).length ? { spans } : {})
  };
  samples.push(sample);
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
  return sample;
}

export interface MergeClientTimingResult {
  merged: boolean;
  finalized: boolean;
}

/**
 * 客户端上报。它与 Run 终态是两个独立的完成信号，先后顺序不确定：
 *  - Run 还没结束 → 只并入待结算的阶段，终态再统一结算；
 *  - Run 已结束（样本已结算）→ 直接补写进那条样本并重算分项。
 */
export function mergeClientTiming(runId: unknown, marks: Record<string, unknown> = {}, meta: Record<string, unknown> = {}): MergeClientTimingResult {
  const id = String(runId || "").trim();
  if (!id) return { merged: false, finalized: false };
  const clean: Record<string, unknown> = {};
  for (const key of STAGE_KEYS) {
    const value = numeric(marks[key]);
    if (value != null) clean[key] = value;
  }
  if (!Object.keys(clean).length) return { merged: false, finalized: false };
  const existing = samples.find((sample) => sample.runId === id);
  if (existing) {
    Object.assign(existing, clean, { ...(meta.model ? { model: meta.model } : {}), ...(meta.mode ? { mode: meta.mode } : {}) });
    Object.assign(existing, derive(existing as Record<string, unknown>));
    return { merged: true, finalized: true };
  }
  const entry = pending.get(id) || { runId: id, marks: {}, meta: {} };
  entry.marks = { ...entry.marks, ...clean };
  entry.meta = { ...entry.meta, ...meta };
  entry.updatedAt = Date.now();
  pending.set(id, entry);
  return { merged: true, finalized: false };
}

export function latencySampleCount(): number {
  return samples.length;
}

export function percentile(values: unknown, p: unknown): number | null {
  const sorted = ((values || []) as unknown[])
    .filter((value) => Number.isFinite(value))
    .map((value) => Number(value))
    .sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((Number(p) / 100) * sorted.length) - 1));
  return sorted[index] ?? null;
}

/** 聚合：逐阶段 count / P50 / P95。count 为 0 时 p50/p95 必须是 null。 */
export function latencySummary(): {
  sampleCount: number;
  pendingRunCount: number;
  stages: Record<string, { count: number; p50: number | null; p95: number | null }>;
  spans: Record<string, { count: number; p50: number | null; p95: number | null }>;
  models: Record<string, number>;
} {
  const stages: Record<string, { count: number; p50: number | null; p95: number | null }> = {};
  for (const key of [...STAGE_KEYS, ...DERIVED_KEYS]) {
    const values = samples.map((sample) => numeric(sample[key])).filter((value) => value != null);
    stages[key] = {
      count: values.length,
      p50: percentile(values, 50),
      p95: percentile(values, 95)
    };
  }
  // 细分耗时：按出现过的 span 名聚合，便于定位"这一段在等什么"。
  const spanNames = new Set<string>();
  for (const sample of samples) for (const key of Object.keys((sample.spans as Record<string, unknown>) || {})) spanNames.add(key);
  const spans: Record<string, { count: number; p50: number | null; p95: number | null }> = {};
  for (const key of [...spanNames].sort()) {
    const values = samples.map((sample) => numeric(((sample.spans as Record<string, unknown> | undefined)?.[key]))).filter((value) => value != null);
    spans[key] = { count: values.length, p50: percentile(values, 50), p95: percentile(values, 95) };
  }
  const models: Record<string, number> = {};
  for (const sample of samples) {
    const name = String(sample.model || "unknown");
    models[name] = (models[name] || 0) + 1;
  }
  return { sampleCount: samples.length, pendingRunCount: pending.size, stages, spans, models };
}

export function recentLatencySamples(limit: unknown = 20): Array<Record<string, unknown>> {
  return samples.slice(-Math.max(1, Number(limit) || 20));
}
