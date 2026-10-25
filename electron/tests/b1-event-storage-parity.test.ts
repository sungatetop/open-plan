/**
 * B1-1 备料批对拍：event-storage.ts（自 server/event-storage.mjs 354 行转录）。
 *
 * 模块级重状态域（emitter/nextSeq/events 窗口/activeFileOffset/诊断 Map）双侧同脚本
 * 对拍：beforeAll 先 stubEnv(OAW_EVENT_DIR=旧侧 tmp) 动态 import 旧模块，再换目录
 * import 新模块（两侧 EVENT_DIR 各自独立落点，互不串写）；断言经 norm 归一
 * （eventId/stamp/tmp 路径 JSON 转义替换，B6-6-4h 路径反斜杠教训）后 toEqual。
 *
 * 覆盖：shouldPersistEvent 全注册表类型 / appendEvent 落盘与返回结构 / data 截断 /
 * 未登记类型 null + typeStats / listEvents 过滤与钳制与 truncated / subscribeEvents
 * 订阅退订 / 阅读游标钳制与落盘 / rotateEventLog force 归档与索引 / 增量同步（外部
 * 完整行消费、半行不消费）/ eventStoreInfo 诊断面 / eventSchemaCheck 开关场景
 * （独立模块实例：URL query 变体绕 ESM 缓存 + OAW_EVENT_SCHEMA_CHECK=1）。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OLD_URL = pathToFileURL(path.resolve(HERE, "../../server/event-storage.mjs")).href;
const OLD_REGISTRY_URL = pathToFileURL(path.resolve(HERE, "../../server/event-registry.mjs")).href;
const FIXED_AT = "2026-01-01T00:00:00.000Z";

let oldTmp = "";
let newTmp = "";
let oldSide: any;
let fresh: any;
let EVENT_FILE = "";

/** 双侧同脚本执行 + 归一比对。 */
async function runBoth<T>(run: (side: any) => Promise<T> | T): Promise<{ old: any; fresh: any }> {
  const o = await run(oldSide);
  const f = await run(fresh);
  return { old: o, fresh: f };
}

/** JSON 文本层归一：tmp 路径（转义形式）/ eventId / 归档 stamp。 */
function norm(value: any) {
  const esc = (p: string) => JSON.stringify(p).slice(1, -1);
  let text = JSON.stringify(value);
  text = text
    .split(esc(oldTmp)).join("<EVDIR>")
    .split(esc(newTmp)).join("<EVDIR>")
    .replace(/event_[0-9a-f-]{36}/g, "event_<UUID>")
    .replace(/事件流-\d{14}\.jsonl/g, "事件流-<STAMP>.jsonl");
  return JSON.parse(text);
}

beforeAll(async () => {
  oldTmp = fs.mkdtempSync(path.join(os.tmpdir(), "b1-events-old-"));
  newTmp = fs.mkdtempSync(path.join(os.tmpdir(), "b1-events-new-"));
  vi.stubEnv("OAW_EVENT_DIR", oldTmp);
  oldSide = await import(OLD_URL);
  vi.stubEnv("OAW_EVENT_DIR", newTmp);
  fresh = await import("../src/main/backend/event-storage");
  EVENT_FILE = path.join(newTmp, "事件流.jsonl");
  // 两侧目录已就绪，导出面同构
  expect(Object.keys(fresh).sort()).toEqual(Object.keys(oldSide).sort());
});

afterAll(() => {
  vi.unstubAllEnvs();
  for (const dir of [oldTmp, newTmp]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

describe("B1-1 event-storage 对拍", () => {
  it("shouldPersistEvent：全注册表类型双侧同值 + 未注册类型 false", async () => {
    const registry = await import(OLD_REGISTRY_URL);
    const types = registry.EVENT_TYPES as string[];
    expect(types.length).toBeGreaterThan(100);
    const { old: o, fresh: f } = await runBoth((side) =>
      types.map((type) => side.shouldPersistEvent(type)).concat([side.shouldPersistEvent("nope_x"), side.shouldPersistEvent(""), side.shouldPersistEvent(null)])
    );
    expect(norm(f)).toEqual(norm(o));
  });

  it("预置历史行：loadStore 收编 + listEvents truncated/earliest/latest", async () => {
    const seed = (dir: string) => {
      const file = path.join(dir, "事件流.jsonl");
      fs.writeFileSync(file, [
        JSON.stringify({ eventId: "event_s5", seq: 5, at: FIXED_AT, clientId: "seed", threadId: "t0", runId: null, type: "agent_started", data: { n: 5 } }),
        JSON.stringify({ eventId: "event_s6", seq: 6, at: FIXED_AT, clientId: "seed", threadId: "t0", runId: null, type: "agent_started", data: { n: 6 } }),
      ].join("\n") + "\n");
    };
    const { old: o, fresh: f } = await runBoth((side) => {
      // seed 在各侧首次 loadStore 前写入（appendEvent 触发 loadStore）
      seed(side === fresh ? newTmp : oldTmp);
      const after = side.listEvents({ after: 1 });
      const exact = side.listEvents({ after: 6 });
      return {
        truncated: { events: after.events.length, latest: after.latest, earliest: after.earliest, truncated: after.truncated },
        exact: { events: exact.events.map((e: any) => e.seq), truncated: exact.truncated },
        storeInfo: { latest: side.eventStoreInfo().latest, earliest: side.eventStoreInfo().earliest },
      };
    });
    expect(norm(f)).toEqual(norm(o));
    expect(f.truncated).toEqual({ events: 2, latest: 6, earliest: 5, truncated: true });
    expect(f.exact.truncated).toBe(false);
    // 外部追加与后续 append 从 nextSeq=6 起步
    expect(f.storeInfo.latest).toBe(6);
  });

  it("appendEvent：落盘结构与返回值 + jsonl 文件内容 + 固定 at 保留", async () => {
    const { old: o, fresh: f } = await runBoth((side) => {
      const event = side.appendEvent({ clientId: "c1", threadId: "t1", runId: "r1", type: "agent_started", data: { a: 1, nested: { b: "x" } }, at: FIXED_AT });
      return { event, file: JSON.parse(fs.readFileSync(path.join(side === fresh ? newTmp : oldTmp, "事件流.jsonl"), "utf8").trim().split("\n").pop()!) };
    });
    expect(f.event.eventId).toMatch(/^event_[0-9a-f-]{36}$/);
    expect(f.event).toMatchObject({ seq: 7, at: FIXED_AT, clientId: "c1", threadId: "t1", runId: "r1", type: "agent_started", data: { a: 1, nested: { b: "x" } } });
    expect(f.file.seq).toBe(7);
    expect(norm(f)).toEqual(norm(o));
  });

  it("data 截断：>8000 字符串切 8000 + …[截断] 后缀（嵌套层同样生效）", async () => {
    const { old: o, fresh: f } = await runBoth((side) => {
      const event = side.appendEvent({ type: "agent_started", data: { s: "x".repeat(9000), n: { deep: "y".repeat(8500) } }, at: FIXED_AT });
      return {
        sLen: event.data.s.length, sTail: event.data.s.slice(-6),
        deepLen: event.data.n.deep.length, deepTail: event.data.n.deep.slice(-6),
        fileTail: JSON.parse(fs.readFileSync(path.join(side === fresh ? newTmp : oldTmp, "事件流.jsonl"), "utf8").trim().split("\n").pop()!).data.s.length,
      };
    });
    // 后缀「…[截断]」5 字符：8000 + 5 = 8005
    expect(f).toEqual({ sLen: 8005, sTail: "x…[截断]", deepLen: 8005, deepTail: "y…[截断]", fileTail: 8005 });
    expect(norm(f)).toEqual(norm(o));
  });

  it("未登记类型 appendEvent 返回 null + typeStats 记 skipped（P2-5）", async () => {
    const { old: o, fresh: f } = await runBoth((side) => {
      const token = side.appendEvent({ type: "token", data: { text: "hi" }, at: FIXED_AT });
      const delta = side.appendEvent({ type: "delta_tool_output", data: {}, at: FIXED_AT });
      return {
        token, delta,
        stats: side.eventTypeStatsSnapshot({ limit: 500 }).filter((s: any) => ["token", "delta_tool_output"].includes(s.type)),
      };
    });
    expect(f.token).toBeNull();
    expect(f.delta).toBeNull();
    expect(norm(f)).toEqual(norm(o));
    const byType = Object.fromEntries(f.stats.map((s: any) => [s.type, s]));
    expect(byType.token).toMatchObject({ total: 1, persisted: 0, skipped: 1 });
  });

  it("listEvents：clientId/threadId/runId 过滤 + limit 钳制 + after 超界", async () => {
    const { old: o, fresh: f } = await runBoth((side) => {
      side.appendEvent({ clientId: "ui", threadId: "ta", type: "agent_started", data: { i: 1 }, at: FIXED_AT });
      side.appendEvent({ clientId: "ui", threadId: "tb", runId: "r2", type: "agent_started", data: { i: 2 }, at: FIXED_AT });
      side.appendEvent({ clientId: "other", threadId: "ta", type: "agent_started", data: { i: 3 }, at: FIXED_AT });
      return {
        all: side.listEvents({}).events.length,
        byClient: side.listEvents({ clientId: "ui" }).events.map((e: any) => e.data.i),
        byThread: side.listEvents({ threadId: "ta" }).events.map((e: any) => e.data.i),
        byRun: side.listEvents({ runId: "r2" }).events.map((e: any) => e.data.i),
        limit1: side.listEvents({ limit: 1 }).events.map((e: any) => e.data.i),
        limitHuge: side.listEvents({ limit: 99999 }).events.length,
        limitZero: side.listEvents({ limit: 0 }).events.length,
        afterBig: side.listEvents({ after: 99999 }).events.length,
        latest: side.listEvents({}).latest,
      };
    });
    expect(norm(f)).toEqual(norm(o));
    expect(f.all).toBe(7); // 内存窗口全量：seed 2 + 截至本用例的 append 5（预置 2 + append 1 + 截断 1 + 本用例 3）
    expect(f.byClient).toEqual([1, 2]);
    expect(f.byThread).toEqual([1, 3]);
    expect(f.byRun).toEqual([2]);
    expect(f.limit1).toEqual([3]);
    expect(f.limitZero).toBe(f.all);
    expect(f.afterBig).toBe(0);
  });

  it("subscribeEvents：订阅即收到落盘事件 / 退订后不再收到", async () => {
    const { old: o, fresh: f } = await runBoth((side) => {
      const got: any[] = [];
      const off = side.subscribeEvents((event: any) => got.push(event));
      side.appendEvent({ type: "agent_started", data: { n: 1 }, at: FIXED_AT });
      off();
      side.appendEvent({ type: "agent_started", data: { n: 2 }, at: FIXED_AT });
      return got.map((e) => e.data.n);
    });
    expect(f).toEqual([1]);
    expect(norm(f)).toEqual(norm(o));
  });

  it("阅读游标：钳制 nextSeq / 单调 max / 空 clientId / 游标文件落盘", async () => {
    const { old: o, fresh: f } = await runBoth((side) => {
      const dir = side === fresh ? newTmp : oldTmp;
      const info = side.eventStoreInfo();
      const capped = side.markReadCursor("ui1", 999999);
      const bump = side.markReadCursor("ui1", 1);
      const empty = side.markReadCursor("", 5);
      const zero = side.getReadCursor("");
      const read = side.getReadCursor("ui1");
      const file = JSON.parse(fs.readFileSync(path.join(dir, "阅读游标.json"), "utf8"));
      return { nextSeq: info.latest, capped, bump, empty, zero, read, file };
    });
    expect(f.capped).toEqual({ ok: true, clientId: "ui1", seq: f.nextSeq });
    expect(f.bump.seq).toBe(f.nextSeq); // 单调 max：低于既有值不回退
    expect(f.empty).toEqual({ ok: false, error: "clientId required" });
    expect(f.zero).toBe(0);
    expect(f.file.ui1).toBe(f.nextSeq);
    expect(norm(f)).toEqual(norm(o));
  });

  it("rotateEventLog force：归档切片 + 索引落盘 + 内存窗口保留归档条目", async () => {
    const { old: o, fresh: f } = await runBoth((side) => {
      const dir = side === fresh ? newTmp : oldTmp;
      side.appendEvent({ type: "agent_started", data: { rot: 1 }, at: FIXED_AT });
      side.appendEvent({ type: "agent_started", data: { rot: 2 }, at: FIXED_AT });
      const rotated = side.rotateEventLog({ force: true });
      const noop = side.rotateEventLog({});
      const index = JSON.parse(fs.readFileSync(path.join(dir, "事件流索引.json"), "utf8"));
      const info = side.eventStoreInfo();
      const afterAppend = side.appendEvent({ type: "agent_started", data: { rot: 3 }, at: FIXED_AT });
      // 归档条目经 loadStore(true) 回收进内存窗口
      const listed = side.listEvents({}).events.map((e: any) => e.data.rot).filter((v: any) => v !== undefined);
      return {
        rotated: { count: rotated?.count, bytes: rotated?.bytes, name: rotated?.file ? "archived" : null },
        noop, indexFiles: index.files.map((e: any) => ({ count: e.count, fromSeq: e.fromSeq, toSeq: e.toSeq })),
        archives: info.archives, latestArchive: info.latestArchive ? "archived" : null,
        afterAppendSeq: afterAppend.seq, listed,
      };
    });
    expect(f.rotated).toEqual({ count: expect.any(Number), bytes: expect.any(Number), name: "archived" });
    expect(f.rotated.count).toBeGreaterThanOrEqual(3); // 活动文件全量行数（含此前用例累积 + 本用例 2 行）
    expect(f.noop).toBeNull(); // 活动文件已被清空（重建后为空文件）
    expect(f.indexFiles).toEqual([{ count: f.rotated.count, fromSeq: expect.any(Number), toSeq: expect.any(Number) }]);
    expect(f.archives).toBe(1);
    expect(f.afterAppendSeq).toBeGreaterThan(f.indexFiles[0].toSeq);
    expect(f.listed).toContain(1);
    expect(f.listed).toContain(2);
    expect(norm(f)).toEqual(norm(o));
  });

  it("增量同步：外部完整行被消费（seq 跳跃纳入）/ 半行不消费（lastBreak 分支）", async () => {
    const { old: o, fresh: f } = await runBoth((side) => {
      const dir = side === fresh ? newTmp : oldTmp;
      const file = path.join(dir, "事件流.jsonl");
      const base = side.listEvents({}).latest;
      // 外部进程追加：完整行（seq 跳跃 +5）
      fs.appendFileSync(file, JSON.stringify({ eventId: "event_ext1", seq: base + 5, at: FIXED_AT, clientId: "ext", threadId: null, runId: null, type: "agent_started", data: { ext: 1 } }) + "\n");
      const afterFull = side.appendEvent({ type: "agent_started", data: { n: "post-full" }, at: FIXED_AT });
      // 外部追加半行（无尾 \n）→ 不消费，且不与下次 append 拼成坏行进内存
      fs.appendFileSync(file, JSON.stringify({ eventId: "event_ext2", seq: base + 9, at: FIXED_AT, type: "agent_started", data: { ext: 2 } }));
      const afterHalf = side.appendEvent({ type: "agent_started", data: { n: "post-half" }, at: FIXED_AT });
      const seqs = side.listEvents({}).events.map((e: any) => e.seq);
      return {
        base,
        afterFullSeq: afterFull.seq, afterHalfSeq: afterHalf.seq,
        hasExt1: seqs.includes(base + 5),
        hasExt2: seqs.includes(base + 9),
        latest: side.listEvents({}).latest,
      };
    });
    expect(f.hasExt1).toBe(true);
    expect(f.hasExt2).toBe(false);
    expect(f.afterFullSeq).toBe(f.base + 6); // 外部行 seq=base+5 → nextSeq 推进到 base+5，自 append 取 +6
    expect(f.afterHalfSeq).toBe(f.base + 7);
    expect(f.latest).toBe(f.base + 7); // 半行不消费、不推进
    expect(norm(f)).toEqual(norm(o));
  });

  it("eventStoreInfo 诊断面：结构 + 量级遥测（P2-5）+ schemaViolations 默认空（P1-2 关）", async () => {
    const { old: o, fresh: f } = await runBoth((side) => {
      const info = side.eventStoreInfo();
      return {
        file: info.file ? "set" : null,
        latest: info.latest, earliest: info.earliest, count: info.count,
        rotateBytes: info.rotateBytes, archives: info.archives,
        latestArchive: info.latestArchive ? "set" : null,
        typeStatsTotal: info.typeStats.reduce((sum: number, s: any) => sum + s.total, 0),
        tokenSkipped: info.typeStats.filter((s: any) => s.type === "token")[0]?.skipped,
        schemaViolations: info.schemaViolations,
      };
    });
    expect(f.file).toBe("set");
    expect(f.rotateBytes).toBe(8 * 1024 * 1024);
    expect(f.latestArchive).toBe("set");
    expect(f.count).toBeGreaterThan(0);
    expect(f.typeStatsTotal).toBeGreaterThan(0);
    expect(f.tokenSkipped).toBeGreaterThan(0);
    expect(f.schemaViolations).toEqual([]);
    expect(norm(f)).toEqual(norm(o));
  });

  it("eventSchemaCheck 开（独立模块实例：resetModules 重载依赖树）：违规告警计数 + 快照", async () => {
    vi.stubEnv("OAW_EVENT_SCHEMA_CHECK", "1");
    const oldTmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "b1-events-old2-"));
    const newTmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "b1-events-new2-"));
    try {
      // RUNTIME_FLAGS 经 feature-flags 在 import 期固化，query 变体只重载目标模块、
      // 依赖树仍是缓存实例——须 vi.resetModules 让 feature-flags 重新求值读到开关（B6-6-4f hard 先例）。
      // 已加载的 oldSide/fresh 引用是既有对象，重载不影响其绑定。
      vi.stubEnv("OAW_EVENT_DIR", oldTmp2);
      vi.resetModules();
      const oldOpen = await import(OLD_URL);
      vi.stubEnv("OAW_EVENT_DIR", newTmp2);
      const freshOpen = await import("../src/main/backend/event-storage");
      const run = (side: any) => {
        // run_draining 声明 schema required ["runId"]：空 data 触发缺字段告警（且该类型落盘）
        const bad = side.appendEvent({ type: "run_draining", data: {}, at: FIXED_AT });
        return {
          persisted: bad ? "set" : null,
          snapshot: side.eventSchemaViolationsSnapshot().map((v: any) => ({ type: v.type, count: v.count, warned: v.warned, missing: v.missing.length, wrongType: v.wrongType.length })),
        };
      };
      const o = await run(oldOpen);
      const f = await run(freshOpen);
      expect(norm(f)).toEqual(norm(o));
      expect(f.snapshot.length).toBeGreaterThan(0);
      expect(f.snapshot[0]).toMatchObject({ type: "run_draining", warned: true });
    } finally {
      for (const dir of [oldTmp2, newTmp2]) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      }
    }
  });
});
