/**
 * S3-16 对拍：legacy 物理 import server/run-evaluation.mjs vs modern import
 * TS backend/run-evaluation.ts（B 层最后收尾域）。
 *
 * 范围说明：
 *   - run-evaluation.mjs 的 evaluateWorkspaceWrite 已随 S3-3 迁至
 *     workspace-write-probe.ts（探针细节由既有对拍覆盖），TS 侧经 re-export
 *     保持模块面一致，此处仅对拍导出面存在性，不重复探针逐分支。
 *   - pi-runtime-management.mjs 已随 B6 迁至 agent/pi-runtime.ts
 *     （b6-pi-runtime-parity 覆盖），run-evaluation 仅静态直绑其
 *     runtimeCapabilities，不再单独对拍。
 *
 * 锚定说明：
 *   - 全绿路径：两侧各建独立 mkdtemp 工作区（写探针互不踩踏），预写包含
 *     realpath 的 .agent-context.md → read-reliability passed；探针
 *     create-modify-readback-delete 在 tmp 目录真实执行；skills 计数读真实
 *     文件系统（两侧同刻一致）；office/memory-governance/concurrency-write
 *     状态由共享真机环境决定 → checks 投影归一工作区路径后两侧 deep equal，
 *     不预设真机业务值，避免环境差异假败。
 *   - runtime 快照三分支（完整 passed / 缺字段 failed / health failed）两侧
 *     传入相同 mock，仅比对 runtime check 逐字互等。
 *   - 默认参数路径：不传 workspace 时两侧 root 锚点应相等
 *     （getWorkspace() 初始锚点同源），探针在真实工作区创建即自清理。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let legacyRE: any;
let modernRE: any;
let legacyRoot = "";
let modernRoot = "";

function prepareWorkspace(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const real = fs.realpathSync(root);
  // 评测内部 root 取 normalizeWorkspace 的 realpath，预写内容须含该形式
  // 才能命中 read-reliability 的 content.includes(root) 判定。
  fs.writeFileSync(
    path.join(real, ".agent-context.md"),
    `# 工作区上下文\n工作区绝对路径：${real}\n原始路径：${root}\n`,
    "utf8",
  );
  return real;
}

/** 两侧同步执行同一操作，返回 [legacy 结果, modern 结果]（async 调用自动收敛）。 */
async function both<T>(fn: (mod: any) => T | Promise<T>): Promise<[T, T]> {
  return (await Promise.all([fn(legacyRE), fn(modernRE)])) as [T, T];
}

/** checks 投影：把本侧工作区绝对路径归一为 <WS> 后做两侧 deep equal。
 *  路径须以 JSON 转义形式（反斜杠翻倍）替换，否则匹配不上 stringify 后文本。 */
function projectChecks(result: any, ws: string) {
  const escaped = JSON.stringify(ws).slice(1, -1);
  return JSON.parse(JSON.stringify(result.checks).split(escaped).join("<WS>"));
}

function pickRuntimeCheck(result: any) {
  return result.checks.find((c: any) => c.id === "runtime");
}

beforeAll(async () => {
  legacyRE = await import("@legacy-server/run-evaluation.mjs");
  modernRE = await import("../src/main/backend/run-evaluation");
  legacyRoot = prepareWorkspace("s316-legacy-");
  modernRoot = prepareWorkspace("s316-modern-");
});

afterAll(() => {
  for (const root of [legacyRoot, modernRoot]) {
    if (root) {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* tmp 清理失败不阻塞 */ }
    }
  }
});

/* ===== 模块面 ===== */

describe("s3-runtime-eval-parity 模块面", () => {
  it("导出面：evaluateWorkspaceWrite/runRuntimeEvaluation 两侧均为函数", () => {
    expect(typeof legacyRE.evaluateWorkspaceWrite).toBe("function");
    expect(typeof legacyRE.runRuntimeEvaluation).toBe("function");
    expect(typeof modernRE.evaluateWorkspaceWrite).toBe("function");
    expect(typeof modernRE.runRuntimeEvaluation).toBe("function");
  });
});

/* ===== 全绿 tmp 工作区 ===== */

describe("s3-runtime-eval-parity tmp 工作区评测", () => {
  it("评测结果：版本/注记/汇总与 checks 投影两侧互等", async () => {
    const [legacy, modern] = await both((mod) => mod.runRuntimeEvaluation({ workspace: mod === legacyRE ? legacyRoot : modernRoot }));
    expect(modern.version).toBe(legacy.version);
    expect(modern.version).toBe(2);
    expect(modern.note).toBe(legacy.note);
    expect(modern.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(modern.workspace).toBe(modernRoot);
    expect(legacy.workspace).toBe(legacyRoot);
    expect(projectChecks(legacy, legacyRoot)).toEqual(projectChecks(modern, modernRoot));
  });

  it("本侧自洽：read-reliability/workspace-write/concurrency-write 在可写 tmp 工作区均为 passed", async () => {
    const [legacy, modern] = await both((mod) => mod.runRuntimeEvaluation({ workspace: mod === legacyRE ? legacyRoot : modernRoot }));
    for (const result of [legacy, modern]) {
      const byId = new Map<string, any>(result.checks.map((c: any) => [c.id, c]));
      expect(byId.get("read-reliability").status).toBe("passed");
      expect(byId.get("workspace-write").status).toBe("passed");
      expect(byId.get("concurrency-write").status).toBe("passed");
      expect(byId.get("runtime").status).toBe("warning");
      expect(result.checks).toHaveLength(7);
    }
  });
});

/* ===== runtime 快照三分支 ===== */

describe("s3-runtime-eval-parity runtime 快照分支", () => {
  it("完整快照：runtime check passed 且 details 逐字互等", async () => {
    const mockRuntime = {
      runtimeId: "runtime_parity",
      piPackageVersion: "1.1.0",
      profile: "通用 Agent",
      toolPolicyVersion: "task-tool-policy-v1",
      health: { status: "healthy", checkedAt: null, message: null },
      model: { provider: "p", id: "m1" },
      capabilities: { custom: true },
    };
    const [legacy, modern] = await both((mod) =>
      mod.runRuntimeEvaluation({ workspace: mod === legacyRE ? legacyRoot : modernRoot, runtime: mockRuntime }));
    const [l, m] = [pickRuntimeCheck(legacy), pickRuntimeCheck(modern)];
    expect(m.status).toBe(l.status);
    expect(m.status).toBe("passed");
    expect(m.message).toBe(l.message);
    expect(m.details).toEqual(l.details);
  });

  it("缺字段快照：failed 文案（顿号连接缺失清单）逐字互等", async () => {
    const [legacy, modern] = await both((mod) =>
      mod.runRuntimeEvaluation({ workspace: mod === legacyRE ? legacyRoot : modernRoot, runtime: { runtimeId: "r1" } }));
    const [l, m] = [pickRuntimeCheck(legacy), pickRuntimeCheck(modern)];
    expect(m.status).toBe(l.status);
    expect(m.status).toBe("failed");
    expect(m.message).toBe(l.message);
    expect(m.message).toBe("Runtime 快照缺少字段：piPackageVersion、profile、toolPolicyVersion");
    expect(m.details).toEqual({ missing: ["piPackageVersion", "profile", "toolPolicyVersion"] });
  });

  it("health failed：透传 health.message 两侧互等", async () => {
    const mockRuntime = {
      runtimeId: "runtime_parity",
      piPackageVersion: "1.1.0",
      profile: "通用 Agent",
      toolPolicyVersion: "task-tool-policy-v1",
      health: { status: "failed", message: "供应商不可达" },
    };
    const [legacy, modern] = await both((mod) =>
      mod.runRuntimeEvaluation({ workspace: mod === legacyRE ? legacyRoot : modernRoot, runtime: mockRuntime }));
    const [l, m] = [pickRuntimeCheck(legacy), pickRuntimeCheck(modern)];
    expect(m.status).toBe(l.status);
    expect(m.status).toBe("failed");
    expect(m.message).toBe(l.message);
    expect(m.message).toBe("供应商不可达");
  });
});

/* ===== 默认参数路径 ===== */

describe("s3-runtime-eval-parity 默认参数路径", () => {
  it("不传 workspace：两侧 root 锚点相等且汇总状态互等", async () => {
    const [legacy, modern] = await both((mod) => mod.runRuntimeEvaluation());
    expect(modern.workspace).toBe(legacy.workspace);
    expect(modern.version).toBe(legacy.version);
    expect(modern.checks.map((c: any) => c.id)).toEqual(legacy.checks.map((c: any) => c.id));
    expect(modern.ok).toBe(legacy.ok);
    expect(modern.status).toBe(legacy.status);
  });
});
