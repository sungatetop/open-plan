/**
 * B2-10 kernel-sidecar 域：BashSidecarManager 全生命周期（构造默认/并发闸/执行统计/
 * 超时强杀/输出裁剪/env·cwd 透传）+ getBashSidecar 模块级单例。
 *
 * R6-7a 对拍退役改写：旧侧 server/kernel-sidecar.mjs 物理路径动态 import
 * （pathToFileURL）随 server/ 退役删除（等价性已在 B2-10 批对拍验收冻结），仅保留
 * modern 静态 import src/main/backend/kernel-sidecar.ts 的同一套绝对断言。
 *
 * 零 env 锚点、零文件 IO → 免 stubEnv 简化形态（B2-5 先例）。
 * execute 真实 spawn（Windows: cmd /d /s /c；超时用例 spawn node 长睡眠配小 timeoutMs）。
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { BashSidecarManager, getBashSidecar } from "../src/main/backend/kernel-sidecar";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// 内联 node -e "..." 在 cmd 下会被参数转义坏（内层 " 变 \"，node 把脚本当字符串字面量
// 求值立即 code 0——office-params 域注释的同类坑）→ 长输出/长睡眠脚本改临时 JS 文件 +
// 纯命令行（无引号无特殊字符）；长睡眠另一可用形态为 ping -n 30（无引号）。
const SCRIPT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "b2ks2-"));
const STDOUT_CMD = `node ${path.join(SCRIPT_DIR, "log-x.js")}`;
const STDERR_CMD = `node ${path.join(SCRIPT_DIR, "log-e.js")}`;

beforeAll(async () => {
  fs.writeFileSync(path.join(SCRIPT_DIR, "log-x.js"), `console.log("x".repeat(210000))`);
  fs.writeFileSync(path.join(SCRIPT_DIR, "log-e.js"), `console.error("e".repeat(70000))`);
});

afterAll(() => {
  try { fs.rmSync(SCRIPT_DIR, { recursive: true, force: true }); } catch {}
});

const SLEEP_CMD = "ping -n 3 127.0.0.1";

describe("B2-10 kernel-sidecar：构造默认与 snapshot 形态", () => {
  it("默认构造：maxConcurrency 4 + stats 初始零值 + avgMs null", () => {
    const m = new BashSidecarManager();
    expect(m.snapshot().maxConcurrency).toBe(4);
    expect(m.snapshot().total).toBe(0);
    expect(m.snapshot().lastMs).toBeNull();
    expect(m.snapshot().avgMs).toBeNull();
  });

  it("自定义与边界 maxConcurrency：2 直取 / 0 falsy 回 4 / 负值钳 1 / NaN 回 4", () => {
    expect(new BashSidecarManager({ maxConcurrency: 2 }).snapshot().maxConcurrency).toBe(2);
    expect(new BashSidecarManager({ maxConcurrency: 0 }).snapshot().maxConcurrency).toBe(4);
    expect(new BashSidecarManager({ maxConcurrency: -3 }).snapshot().maxConcurrency).toBe(1);
    expect(new BashSidecarManager({ maxConcurrency: NaN }).snapshot().maxConcurrency).toBe(4);
  });
});

describe("B2-10 kernel-sidecar：execute 全族（真实 spawn）", () => {
  it("空命令：不 spawn 直接返回 empty command，stats 不累积", async () => {
    const m = new BashSidecarManager();
    expect(await m.execute("")).toEqual({ code: 1, stdout: "", stderr: "empty command", ms: 0, killed: false });
    expect(await m.execute("   ")).toEqual({ code: 1, stdout: "", stderr: "empty command", ms: 0, killed: false });
    expect(m.snapshot().total).toBe(0);
  });

  it("成功路径：echo 输出 + code 0 + 统计 total/lastMs/avgMs + active 释放归零", async () => {
    const m = new BashSidecarManager();
    const r = await m.execute("echo sidecar-ok");
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("sidecar-ok");
    expect(r.killed).toBe(false);
    expect(m.snapshot().total).toBe(1);
    expect(m.snapshot().failed).toBe(0);
    expect(m.snapshot().active).toBe(0);
    expect((m.snapshot().lastMs as number) > 0).toBe(true);
    expect(m.snapshot().avgMs).toBe(m.snapshot().lastMs);
  });

  it("失败路径：exit 3 → code 3 + failed 计数", async () => {
    const m = new BashSidecarManager();
    const r = await m.execute("exit 3");
    expect(r.code).toBe(3);
    expect(m.snapshot().failed).toBe(1);
  });

  it("超时路径：长睡眠 + timeoutMs 150 → killed true + code 124 + timeout/failed 计数", async () => {
    const m = new BashSidecarManager();
    // cmd 被 kill 后 ping 孤儿进程持有 stdio 管道，close 事件等孤儿自然退出才触发
    //（killed 标志 150ms 置位但 resolve 延迟至孤儿退出）。
    const r = await m.execute(SLEEP_CMD, { timeoutMs: 150 });
    expect(r.killed).toBe(true);
    expect(r.code).toBe(124);
    expect(m.snapshot().timeout).toBe(1);
    expect(m.snapshot().failed).toBe(1);
  }, 30000);

  it("输出裁剪：stdout 尾 200000 / stderr 尾 60000", async () => {
    const m = new BashSidecarManager();
    const r = await m.execute(STDOUT_CMD);
    expect(r.stdout.length).toBe(200000);
    const r2 = await m.execute(STDERR_CMD);
    expect(r2.stderr.length).toBe(60000);
  }, 60000);

  it("env 透传：{...process.env, ...env} 展开，cmd 展开 %VAR%", async () => {
    const m = new BashSidecarManager();
    const r = await m.execute("echo %OAW_T%", { env: { OAW_T: "v42" } });
    expect(r.stdout).toContain("v42");
  }, 30000);

  it("cwd 透传：mkdtmp 目录生效（输出含该目录）", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "b2ks-"));
    try {
      const m = new BashSidecarManager();
      const r = await m.execute("cd", { cwd: tmp });
      expect(r.stdout).toContain("b2ks-");
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  }, 30000);

  it("并发上限与排队：maxConcurrency 1 两命令并发 → 排队执行 total 2 + active 归零", async () => {
    const m = new BashSidecarManager({ maxConcurrency: 1 });
    const [r1, r2] = await Promise.all([m.execute("exit 0"), m.execute("exit 0")]);
    expect(r1.code).toBe(0);
    expect(r2.code).toBe(0);
    expect(m.snapshot().total).toBe(2);
    expect(m.snapshot().active).toBe(0);
  }, 30000);
});

describe("B2-10 kernel-sidecar：getBashSidecar 模块级单例", () => {
  it("两次调用同一实例", () => {
    expect(getBashSidecar()).toBe(getBashSidecar());
  });
});
