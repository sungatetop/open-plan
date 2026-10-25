/**
 * B2-2 runs 域对拍③：stagedVisible flag 开启态投影。
 *
 * RUNTIME_FLAGS 双侧均 Object.freeze 且 readFlag 只在模块 import 时读一次 env，
 * 无法在测试中就地变异——故独立成文件：在 import 两侧之前注入 OAW_STAGED_VISIBLE=1，
 * 让双侧模块图都以 flag 开启态实例化。flag 关闭态（默认）由 b2-runs-parity-store.test.ts 覆盖。
 */
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "../..");
const OLD_URL = pathToFileURL(path.join(PROJECT_ROOT, "server", "runs.mjs")).href;

interface Side {
  name: string;
  runs: any;
  base: string;
  ws: string;
  runsDir: string;
  eventDir: string;
}

const SIDES: Side[] = [];

beforeAll(async () => {
  // 必须先注入 flag env 再 import：readFlag 在模块初始化时一次性读取。
  vi.stubEnv("OAW_STAGED_VISIBLE", "1");
  for (const name of ["old", "new"] as const) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), `b2staged-${name}-`));
    const ws = path.join(base, "ws");
    const runsDir = path.join(base, "runs");
    const eventDir = path.join(base, "events");
    fs.mkdirSync(ws);
    vi.stubEnv("OAW_RUNS_DIR", runsDir);
    vi.stubEnv("OAW_EVENT_DIR", eventDir);
    if (name === "old") {
      const runs = await import(OLD_URL);
      SIDES.push({ name, runs, base, ws, runsDir, eventDir });
    } else {
      vi.resetModules();
      const runs = await import("../src/main/backend/runs");
      SIDES.push({ name, runs, base, ws, runsDir, eventDir });
    }
  }
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function runBoth<T>(fn: (side: Side) => T | Promise<T>): Promise<{ old: T; new: T }> {
  const out: any = {};
  for (const side of SIDES) out[side.name] = await fn(side);
  return out;
}

/** 跨侧归一：双侧 ws/base（含正斜杠变体）+ run/artifact UUID + ISO 时间戳。 */
function norm(value: unknown): string {
  let text = JSON.stringify(value)!;
  for (const s of SIDES) {
    text = text!
      .replaceAll(JSON.stringify(s.ws).slice(1, -1), "<WS>")
      .replaceAll(JSON.stringify(s.base).slice(1, -1), "<BASE>")
      .replaceAll(s.ws.replace(/\\/g, "/"), "<WS>")
      .replaceAll(s.base.replace(/\\/g, "/"), "<BASE>");
  }
  return text!
    .replaceAll(/run_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "run_<ID>")
    .replaceAll(/artifact_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "artifact_<ID>")
    .replaceAll(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z/g, "<TS>")
    .replaceAll(/"mtime":\d+(\.\d+)?/g, '"mtime":<MT>');
}

describe("B2-2 runs stagedVisible 开启态：暂存写入投影为运行中临时产物", () => {
  it("运行中 Run 的 touchedPaths 投影成 staged 产物；终态后不投影", async () => {
    await runBoth(async (side) => {
      const runs = side.runs;
      const run = runs.beginRun({ clientId: "c", threadId: "t", cwd: side.ws });
      runs.recordRunEvent(run.id, "write_started", { path: "报告.docx" });
      runs.recordRunEvent(run.id, "write_started", { path: path.join(side.ws, "out", "数据.xlsx") });
      const running = runs.getRun(run.id);
      runs.finishRun(run.id, { status: "completed" });
      const finished = runs.getRun(run.id);
      return {
        stagedRunning: (running.artifacts ?? []).filter((a: any) => a.source === "staged").map((a: any) => ({ path: a.path, status: a.status, staged: a.staged, artifactIdShape: /^staged:run_[0-9a-f-]{36}:/.test(a.artifactId) })),
        stagedFinished: (finished.artifacts ?? []).filter((a: any) => a.source === "staged").length,
      };
    }).then(({ old, new: nw }) => {
      expect(norm(old)).toBe(norm(nw));
      // 反斜杠台账路径归一成正斜杠；已存在的产物路径不重复投影。
      // 投影保持 touchedPaths 台账插入序（报告.docx 先记录）。
      expect(nw.stagedRunning).toEqual([
        { path: "报告.docx", status: "staged", staged: true, artifactIdShape: true },
        { path: "out/数据.xlsx", status: "staged", staged: true, artifactIdShape: true },
      ]);
      expect(nw.stagedFinished).toBe(0);
    });
  });
});
