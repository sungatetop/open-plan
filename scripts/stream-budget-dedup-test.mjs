#!/usr/bin/env node
/**
 * stream-budget-dedup-test（卡死防护）：
 * 校验客户端槽位预算（申请/拒绝/必需流顶位/回收/等待空位）与服务端流登记表
 * （同键去重、单客户端上限、写入记账、按条件关闭）。
 * 用法: node scripts/stream-budget-dedup-test.mjs
 * 退出码: 0 = 全部通过, 1 = 有失败
 */
import assert from "node:assert/strict";
import {
  MAX_STREAMS,
  acquireStream,
  activeStreamCount,
  closeOptionalStreams,
  hasStreamSlot,
  releaseStream,
  resetStreams,
  streamEvents,
  streamSnapshot,
  waitForStreamSlot,
} from "../client/src/stream-budget.js";
import {
  closeServerStreams,
  listServerStreams,
  noteStreamWrite,
  registerServerStream,
  releaseServerStream,
  serverStreamStats,
  streamKeyOf,
  sweepServerStreams,
} from "../server/stream-connection.mjs";

let failed = 0;
function ok(msg) { console.log(`  ✓ ${msg}`); }
function fail(msg) { console.error(`  ✗ ${msg}`); failed = 1; }
function test(name, fn) {
  try {
    fn();
    ok(name);
  } catch (e) {
    fail(`${name}: ${e.message}`);
  }
}
// 异步用例单独走这个：必须 await，否则断言失败会被 process.exit 吞掉（假通过）。
async function testAsync(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (e) {
    fail(`${name}: ${e.message}`);
  }
}

console.log("客户端长连接预算：");
test("槽位未满时可申请，连续申请到上限", () => {
  resetStreams();
  const handles = [];
  for (let i = 0; i < MAX_STREAMS; i += 1) {
    const handle = acquireStream(`panel-${i}`, { priority: 5, label: `面板 ${i}` });
    assert.ok(handle, `第 ${i + 1} 条应申请成功`);
    handles.push(handle);
  }
  assert.equal(activeStreamCount(), MAX_STREAMS);
  assert.equal(hasStreamSlot(), false);
  handles.forEach((handle) => handle.release());
  assert.equal(activeStreamCount(), 0);
  assert.equal(hasStreamSlot(), true);
});

test("可放弃的流超预算时被拒绝，而不是顶掉正在用的流", () => {
  resetStreams();
  const a = acquireStream("memory-changes", { priority: 4, label: "记忆变更流" });
  const b = acquireStream("browser-frames", { priority: 3, label: "浏览器帧流" });
  const c = acquireStream("thread-events", { priority: 4, label: "事件页签流" });
  const denied = acquireStream("extra-panel", { priority: 9, label: "额外面板" });
  assert.equal(denied, null, "超预算的可放弃流应拿到 null");
  assert.equal(activeStreamCount(), MAX_STREAMS);
  const kinds = streamSnapshot().map((item) => item.kind);
  assert.deepEqual(kinds.sort(), ["browser-frames", "memory-changes", "thread-events"]);
  assert.ok(streamEvents().some((entry) => entry.action === "denied"), "应记录 denied 事件");
  [a, b, c].forEach((handle) => handle.release());
});

test("必需流超预算时顶掉优先级最低的可放弃流", () => {
  resetStreams();
  const memory = acquireStream("memory-changes", { priority: 4, label: "记忆变更流" });
  const browser = acquireStream("browser-frames", { priority: 3, label: "浏览器帧流" });
  const eventsTab = acquireStream("thread-events", { priority: 4, label: "事件页签流" });
  let memoryClosed = false;
  memory.attach(() => { memoryClosed = true; });
  const chat = acquireStream("chat", { essential: true, priority: 1, label: "对话流" });
  assert.ok(chat, "必需流必须拿到槽位");
  assert.equal(memoryClosed, true, "应关闭优先级最低的可放弃流（记忆变更流）");
  assert.equal(activeStreamCount(), MAX_STREAMS);
  assert.ok(!streamSnapshot().some((item) => item.kind === "memory-changes"));
  assert.ok(streamSnapshot().some((item) => item.kind === "chat"));
  assert.ok(streamEvents().some((entry) => entry.action === "evict"), "应记录 evict 事件");
  [browser, eventsTab, chat].forEach((handle) => handle.release());
});

test("回收只关可放弃的流，对话流与全局事件流保留", () => {
  resetStreams();
  const chat = acquireStream("chat", { essential: true, priority: 1, label: "对话流" });
  const events = acquireStream("agent-events", { essential: true, priority: 2, label: "全局事件流" });
  const browser = acquireStream("browser-frames", { priority: 3, label: "浏览器帧流" });
  const closed = closeOptionalStreams("测试回收");
  assert.equal(closed, 1);
  assert.deepEqual(streamSnapshot().map((item) => item.kind).sort(), ["agent-events", "chat"]);
  assert.ok(streamEvents().some((entry) => entry.action === "reclaim" && entry.reason === "测试回收"));
  [chat, events].forEach((handle) => handle.release());
  assert.equal(activeStreamCount(), 0);
});

test("attach 后回收会真正断开底层连接；release 幂等", () => {
  resetStreams();
  const handle = acquireStream("browser-frames", { priority: 3, label: "浏览器帧流" });
  let closedCount = 0;
  handle.attach(() => { closedCount += 1; });
  closeOptionalStreams("测试");
  assert.equal(closedCount, 1);
  handle.release();
  handle.release();
  assert.equal(closedCount, 1, "重复 release 不应重复断开");
});

test("waitForStreamSlot 在有槽位时立刻回调，满时等释放后回调", () => {
  resetStreams();
  let immediate = 0;
  waitForStreamSlot(() => { immediate += 1; });
  assert.equal(immediate, 1, "有空槽应立即回调");

  const handles = [];
  for (let i = 0; i < MAX_STREAMS; i += 1) handles.push(acquireStream(`panel-${i}`, { priority: 5 }));
  let waited = 0;
  const cancel = waitForStreamSlot(() => { waited += 1; });
  assert.equal(waited, 0, "无空槽时不回调");
  releaseStream(handles[0].key);
  assert.equal(waited, 1, "腾出槽位后应回调一次");
  cancel();
  releaseStream(handles[1].key);
  assert.equal(waited, 1, "取消后不应再回调");
  handles.forEach((handle) => handle.release());
  resetStreams();
});

console.log("\n服务端流登记表：");
test("同键保留上限：同一 (path, client, thread) 允许一个备用读者，超出才收掉最旧的", () => {
  const closedA = [];
  const first = registerServerStream({ path: "/api/agent/stream", client: "c1", thread: "t1", close: () => closedA.push(first.id) });
  const second = registerServerStream({ path: "/api/agent/stream", client: "c1", thread: "t1", close: () => closedA.push(second.id) });
  // 第二个读者不该把第一个踢掉（多标签页/监测工具共存）
  assert.deepEqual(second.replaced.map((item) => item.reason), [], "第二个同键读者不应触发去重");
  assert.equal(closedA.length, 0, "第一个读者的连接必须保留");
  // 第三个才触发上限：收掉最旧的那个
  const third = registerServerStream({ path: "/api/agent/stream", client: "c1", thread: "t1", close: () => closedA.push(third.id) });
  assert.deepEqual(third.replaced.map((item) => item.reason), ["same-key"], "超出保留上限应收掉最旧连接");
  assert.equal(closedA.length, 1, "只应收掉一条（最旧的）");
  assert.equal(listServerStreams().some((item) => item.id === first.id), false, "最旧的流不应留在登记表");
  assert.equal(listServerStreams().filter((item) => item.id === second.id).length, 1, "中间那条应保留");
  assert.equal(listServerStreams().filter((item) => item.id === third.id).length, 1, "最新的流应登记在册");
  releaseServerStream(second.id);
  releaseServerStream(third.id);
  assert.equal(listServerStreams().some((item) => item.id === third.id), false);
});

test("不同 thread 的对话流可以并存", () => {
  const a = registerServerStream({ path: "/api/agent/stream", client: "c2", thread: "t1", close: () => {} });
  const b = registerServerStream({ path: "/api/agent/stream", client: "c2", thread: "t2", close: () => {} });
  const ids = listServerStreams().map((item) => item.id);
  assert.ok(ids.includes(a.id) && ids.includes(b.id));
  releaseServerStream(a.id);
  releaseServerStream(b.id);
});

test("同一 client 超过上限时收掉最早的流", () => {
  const stats = serverStreamStats();
  const created = [];
  const closedIds = [];
  for (let i = 0; i < stats.maxPerClient + 1; i += 1) {
    const handle = registerServerStream({
      path: `/api/panel-${i}`,
      client: "cap-client",
      close: () => closedIds.push(handle.id),
    });
    created.push(handle);
  }
  const remaining = listServerStreams().filter((item) => item.client === "cap-client");
  assert.equal(remaining.length, stats.maxPerClient + 1 - 1, "超出上限应关掉一条");
  assert.equal(closedIds.length, 1);
  assert.equal(remaining.some((item) => item.id === created[0].id), false, "被关掉的应是最早的流");
  created.forEach((handle) => releaseServerStream(handle.id));
});

test("写入记账区分活跃与挂死的流，按条件关闭生效", () => {
  const handle = registerServerStream({ path: "/api/browser/stream", client: "c3", thread: "t3", note: "frames", close: () => {} });
  noteStreamWrite(handle.id, 128);
  const entry = listServerStreams().find((item) => item.id === handle.id);
  assert.equal(entry.bytes, 128);
  assert.ok(entry.idleMs < 1000, "刚写入的流 idleMs 应很小");
  const closed = closeServerStreams({ client: "c3" });
  assert.equal(closed, 1);
  assert.equal(listServerStreams().some((item) => item.id === handle.id), false);
});

test("streamKeyOf 归一化键", () => {
  assert.equal(streamKeyOf({ path: "/a", client: "c", thread: "t" }), "/a|c|t");
  assert.equal(streamKeyOf({ path: "/a" }), "/a||");
});

test("清扫：probe 判定已断开的流被摘掉，存活的保留", () => {
  let alive = true;
  const live = registerServerStream({ path: "/api/browser/stream", client: "sweep-1", close: () => {}, probe: () => alive });
  const dead = registerServerStream({ path: "/api/memory/stream", client: "sweep-2", close: () => {}, probe: () => false });
  const swept = sweepServerStreams();
  assert.equal(swept, 1, "只应清扫 probe=false 的流");
  assert.equal(listServerStreams().some((item) => item.id === dead.id), false);
  assert.equal(listServerStreams().some((item) => item.id === live.id), true);
  alive = false;
  assert.equal(sweepServerStreams(), 1);
  assert.equal(listServerStreams().some((item) => item.id === live.id), false);
  releaseServerStream(live.id);
});

test("清扫不碰没有 probe 的登记项（老调用点不会被误关）", () => {
  const handle = registerServerStream({ path: "/api/agent/stream", client: "sweep-3", close: () => {} });
  sweepServerStreams();
  assert.equal(listServerStreams().some((item) => item.id === handle.id), true);
  releaseServerStream(handle.id);
});

console.log("\n暂存写入 ↔ officecli 可见性（按需物化）：");
test("临时工作文件与备份不参与发布；正常产物照常发布", async () => {
  const { isTempWorkPath } = await import("../server/write-coordination.mjs");
  for (const rel of [".work/batch.json", ".ch6work/b4.json", ".tmp/x.json", "报告.docx.bak", "草稿.tmp", "a~"]) {
    assert.equal(isTempWorkPath(rel), true, `${rel} 应判为临时文件（不发布）`);
  }
  for (const rel of ["报告.docx", "初稿/表格.xlsx", ".agent-context.md", ".github/workflows/ci.yml", "数据.csv"]) {
    assert.equal(isTempWorkPath(rel), false, `${rel} 应判为产物（发布）`);
  }
  const runs源 = (await import("node:fs")).readFileSync(new URL("../server/runs.mjs", import.meta.url), "utf8");
  assert.match(runs源, /cleanupRunTempArtifacts\(run, persistWriteEvent\)/, "收尾应清理本轮临时文件");
  assert.match(runs源, /onEvent\?\.\("write_cleaned", \{ paths: removed \}\)/, "清理要写成 write_cleaned 事件（可追溯）");
  assert.match(runs源, /if \(before\[normalized\]\) continue;/, "清理只删本轮新建的临时文件，不碰运行前就有的内容");
});

await testAsync("被引用的暂存文件物化到磁盘，未被引用的保持不可见", async () => {
  const os = await import("node:os");
  const fsp = await import("node:fs");
  const nodePath = await import("node:path");
  const { stageWrite, materializeStagedReferences, listStagedFiles } = await import("../server/write-coordination.mjs");
  const workspace = fsp.mkdtempSync(nodePath.join(os.default.tmpdir(), "规聚物化测试-"));
  const runId = `run_probe_${Date.now().toString(36)}`;
  const rel = ".work/batch.json";
  const content = JSON.stringify([{ command: "set", target: "a.docx" }], null, 2);
  try {
    stageWrite({ runId, workspace, targetPath: nodePath.join(workspace, rel), content: Buffer.from(content, "utf8"), kind: "write" });
    assert.equal(listStagedFiles(runId).some((f) => f.path === rel), true, "写入应登记到暂存区");
    assert.equal(fsp.existsSync(nodePath.join(workspace, rel)), false, "暂存文件此时不应出现在磁盘上");

    const materialized = materializeStagedReferences({ runId, workspace, paths: [rel, "不存在的.json"] });
    assert.deepEqual(materialized, [rel], "只物化被显式引用且暂存区里存在的文件");
    assert.equal(fsp.readFileSync(nodePath.join(workspace, rel), "utf8"), content, "物化内容必须与暂存内容一致");

    const other = "别的.json";
    stageWrite({ runId, workspace, targetPath: nodePath.join(workspace, other), content: Buffer.from("[]", "utf8"), kind: "write" });
    materializeStagedReferences({ runId, workspace, paths: [rel] });
    assert.equal(fsp.existsSync(nodePath.join(workspace, other)), false, "未被引用的暂存文件不应被物化");
  } finally {
    fsp.rmSync(workspace, { recursive: true, force: true });
    fsp.rmSync(nodePath.join(".oaw", "runs", runId), { recursive: true, force: true });
    fsp.rmSync(nodePath.join(".oaw", "runs", `${runId}.json`), { force: true });
  }
});

console.log(failed ? "\n有失败用例" : "\n全部通过");
process.exit(failed);
