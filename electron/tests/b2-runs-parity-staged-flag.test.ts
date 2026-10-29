/**
 * B2-2 runs 域：stagedVisible flag 开启态投影。
 *
 * R6-7a 对拍退役改写：旧侧 server/runs.mjs 物理路径动态 import（pathToFileURL）
 * 随 server/ 退役删除（等价性已在 B2-2 批对拍验收冻结），仅保留新侧绝对断言。
 *
 * RUNTIME_FLAGS Object.freeze 且 readFlag 只在模块 import 时读一次 env，无法在测试中
 * 就地变异——故独立成文件：在 import 之前注入 OAW_STAGED_VISIBLE=1，让模块图以
 * flag 开启态实例化（vi.stubEnv 先于 vi.resetModules 动态 import）。flag 关闭态
 * （默认）由 b2-runs-parity-store.test.ts 覆盖。
 */
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const base = fs.mkdtempSync(path.join(os.tmpdir(), "b2staged-new-"));
const ws = path.join(base, "ws");
const runsDir = path.join(base, "runs");
const eventDir = path.join(base, "events");

let runs: any;

beforeAll(async () => {
  // 必须先注入 flag env 再 import：readFlag 在模块初始化时一次性读取。
  vi.stubEnv("OAW_STAGED_VISIBLE", "1");
  vi.stubEnv("OAW_RUNS_DIR", runsDir);
  vi.stubEnv("OAW_EVENT_DIR", eventDir);
  fs.mkdirSync(ws);
  vi.resetModules();
  runs = await import("../src/main/backend/runs");
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
});

describe("B2-2 runs stagedVisible 开启态：暂存写入投影为运行中临时产物", () => {
  it("运行中 Run 的 touchedPaths 投影成 staged 产物；终态后不投影", async () => {
    const run = runs.beginRun({ clientId: "c", threadId: "t", cwd: ws });
    runs.recordRunEvent(run.id, "write_started", { path: "报告.docx" });
    runs.recordRunEvent(run.id, "write_started", { path: path.join(ws, "out", "数据.xlsx") });
    const running = runs.getRun(run.id);
    runs.finishRun(run.id, { status: "completed" });
    const finished = runs.getRun(run.id);
    // 反斜杠台账路径归一成正斜杠；已存在的产物路径不重复投影。
    // 投影保持 touchedPaths 台账插入序（报告.docx 先记录）。
    expect((running.artifacts ?? []).filter((a: any) => a.source === "staged").map((a: any) => ({
      path: a.path, status: a.status, staged: a.staged,
      artifactIdShape: /^staged:run_[0-9a-f-]{36}:/.test(a.artifactId),
    }))).toEqual([
      { path: "报告.docx", status: "staged", staged: true, artifactIdShape: true },
      { path: "out/数据.xlsx", status: "staged", staged: true, artifactIdShape: true },
    ]);
    expect((finished.artifacts ?? []).filter((a: any) => a.source === "staged")).toHaveLength(0);
  });
});
