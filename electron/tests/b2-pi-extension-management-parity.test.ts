/**
 * B2-17 pi-extension-management 域对拍（legacy server/pi-extension-management.mjs vs
 * modern src/main/backend/agent/pi-extension-management.ts）。
 *
 * 对拍形态②（B2-3/B2-9/B2-14/B2-15/B2-16 stubEnv 模式）：APP_DATA_DIR 为模块加载期锚点
 * （CONFIG_FILE 常量，经 pi-config-management 读 OAW_DATA_DIR），双侧各自 mkdtmp 锚定 +
 * beforeAll 设 env 后动态 import；modern 侧 vi.resetModules() 重载 TS 依赖树
 * （pi-config-management/persistence-utils 同步重实例化），legacy 侧物理路径 import 一次缓存。
 *
 * 覆盖面（全部 fs 驱动，无网络/无进程/无真实用户目录）：
 *   - 初始态：CONFIG_FILE 不存在 → listPiExtensions/enabled 两导出全空；
 *   - addPiExtension：三拒绝分支（空路径/超长/不存在，均不落盘）+ 合法目录登记
 *     （realPath 归一、id slug+6hex、files 盘点、lastCheck 三键、落盘 JSON version/updatedAt）+
 *     重复登记拒绝（不同写法路径 resolve 同一 realPath）+ CJK 名 slug 回退 pi-extension
 *     （去首尾连字符）与单文件登记 basename files；
 *   - updatePiExtension：id 不存在 null / 改名与空白名保原 / 启用（路径有效）与停用 /
 *     启用路径删除拒绝且配置不变 / lastCheck 刷新恰双键 {ok,at}；
 *   - checkPiExtension：null / 有效有文件 / 有效无文件 / 路径删除四分支 message 与 files 数；
 *   - deletePiExtension：true + 落盘移除 / 不存在 id false；
 *   - enabledPiExtensionPaths/Entries：全 disabled 空 / enabled 有效按注册序包含 /
 *     enabled 但路径删除排除；
 *   - inspectPath 行为面（经 files 驱动）：扩展名正则（ts/js/mjs/cts 计、txt 不计）、
 *     隐藏文件与隐藏目录跳过、深度 4 目录不计（walk 入口 depth>3）、
 *     100 截断（t120 三目录各 60 文件：前两目录入口累计 60<100 放行、第三目录入口
 *     120>=100 被拒 → 恰 120 且恰两个前缀各 60，readdir 顺序无关）；
 *   - 双侧一致性 battery：终态落盘配置归一（id→<ID>、每侧根→<R>、冻结时钟统一 at）
 *     后 deep-equal。
 *
 * 口径：makeId 的 randomBytes(3) 双侧不同 → 比较面归一 <ID>；at/updatedAt 经冻结时钟
 * （fake Date）双侧一致可 deep-equal；inspectPath 的"既非目录又非文件"stat 分支
 * （win32 无法稳定构造）不在对拍面，经代码审读确认等价。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as PiExtModule from "../src/main/backend/agent/pi-extension-management";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// tests → electron → 项目根（旧 server 锚定真实仓库，与生产 sidecar 同一加载形态）
const PROJECT_ROOT = path.resolve(HERE, "../..");

const FROZEN_AT = new Date(1_700_000_000_000).toISOString();

const LEGACY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "b2-piext-legacy-"));
const MODERN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "b2-piext-modern-"));

type PiExtApi = typeof PiExtModule;
const legacyHolder: { mod: PiExtApi | null } = { mod: null };
const modernHolder: { mod: PiExtApi | null } = { mod: null };

const IMPLS = [
  { label: "legacy", dir: LEGACY_DATA, holder: legacyHolder, modern: false },
  { label: "modern", dir: MODERN_DATA, holder: modernHolder, modern: true },
] as const;

/** 终态落盘快照容器（describe.each 各侧 test 8 填充，battery 比较）。 */
const diskSnapshots: Record<string, any> = {};

/** 每侧夹具：ext-src 扩展树 / single 单文件 / deep 深度链 / t120 百文件截断布局。 */
function buildFixture(root: string): void {
  const write = (rel: string, content = "// ext\n"): void => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
  };
  // ext-src：5 个计入 + 4 个不计（txt 扩展名/.secret.ts 隐藏文件/.hidden 隐藏目录/deep4 深度 4）
  write("ext-src/alpha.ts");
  write("ext-src/beta.js");
  write("ext-src/notes.txt", "not js\n");
  write("ext-src/.secret.ts");
  write("ext-src/.hidden/hidden.ts");
  write("ext-src/sub/gamma.mjs");
  write("ext-src/sub/deep2/delta.cts");
  write("ext-src/sub/deep2/deep3/eta.ts");
  write("ext-src/sub/deep2/deep3/deep4/zeta.tsx");
  write("single/extension.ts");
  write("deep/a/b/c/ok.ts");
  write("deep/a/b/c/d/zeta.tsx");
  for (const dirName of ["a", "b", "c"]) {
    for (let i = 0; i < 60; i += 1) write(`t120/${dirName}/${dirName}${String(i).padStart(2, "0")}.ts`);
  }
}

/** 归一比较面：每侧根目录 → <R>，makeId 随机 id（slug-6hex）→ <ID>。 */
function normalize(value: any, root: string): any {
  if (typeof value === "string") {
    const replaced = value.split(root).join("<R>");
    return /^[a-z0-9_-]{1,24}-[0-9a-f]{6}$/.test(replaced) ? "<ID>" : replaced;
  }
  if (Array.isArray(value)) return value.map((item) => normalize(item, root));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item, root)]));
  }
  return value;
}

describe.each(IMPLS)("pi-extension-management 对拍（$label）", ({ dir, holder, modern }) => {
  const m = () => holder.mod!;
  const configFile = () => path.join(dir, "集成", "pi-extensions.json");

  beforeAll(async () => {
    buildFixture(dir);
    process.env.OAW_DATA_DIR = dir;
    if (modern) {
      vi.resetModules();
      holder.mod = (await import("../src/main/backend/agent/pi-extension-management")) as PiExtApi;
    } else {
      holder.mod = (await import(pathToFileURL(path.join(PROJECT_ROOT, "server", "pi-extension-management.mjs")).href)) as PiExtApi;
    }
  });

  it("初始态：CONFIG_FILE 不存在 → list/enabled 三导出全空", () => {
    expect(fs.existsSync(configFile())).toBe(false);
    expect(m().listPiExtensions()).toEqual([]);
    expect(m().enabledPiExtensionPaths()).toEqual([]);
    expect(m().enabledPiExtensionEntries()).toEqual([]);
  });

  it("addPiExtension：三拒绝分支不落盘 + 合法登记（realPath/id/files/lastCheck/落盘 JSON）+ 重复登记拒绝 + CJK 名与单文件", () => {
    expect(() => m().addPiExtension({ path: "" })).toThrow("请填写 Pi 扩展文件或目录路径");
    expect(() => m().addPiExtension({ path: "x".repeat(4001) })).toThrow("Pi 扩展路径过长");
    expect(() => m().addPiExtension({ path: path.join(dir, "no-such-dir") })).toThrow("找不到该文件或目录，请检查路径");
    expect(fs.existsSync(configFile())).toBe(false);

    const extDir = path.join(dir, "ext-src");
    const added = m().addPiExtension({ path: extDir });
    expect(added.id).toMatch(/^[a-z0-9_-]{1,24}-[0-9a-f]{6}$/);
    expect(added.name).toBe("ext-src");
    expect(added.enabled).toBe(false);
    expect(added.exists).toBe(true);
    expect(added.requiresNewSession).toBe(true);
    expect(added.files.sort()).toEqual([
      "alpha.ts", "beta.js", "sub/deep2/delta.cts", "sub/deep2/deep3/eta.ts", "sub/gamma.mjs",
    ].sort());
    expect(added.lastCheck).toEqual({ ok: true, at: FROZEN_AT, files: 5 });
    expect(added.path).toBe(fs.realpathSync(extDir)); // realPath 归一
    expect(fs.existsSync(configFile())).toBe(true);
    const raw = JSON.parse(fs.readFileSync(configFile(), "utf8"));
    expect(raw.version).toBe(1);
    expect(raw.extensions).toHaveLength(1);
    expect(raw.updatedAt).toBe(FROZEN_AT);

    // 重复登记：不同写法路径 resolve 到同一 realPath
    expect(() => m().addPiExtension({ path: path.join(extDir, "sub", "..") })).toThrow("这个 Pi 扩展路径已经登记");

    // CJK/空格/感叹号均被替换为连字符 → slug "alpha"（去首尾连字符），id 前缀 alpha
    const single = path.join(dir, "single", "extension.ts");
    const added2 = m().addPiExtension({ name: "我的扩展 Alpha!", path: single });
    expect(added2.name).toBe("我的扩展 Alpha!");
    expect(added2.id.startsWith("alpha-")).toBe(true);
    expect(added2.files).toEqual(["extension.ts"]);
    expect(added2.path).toBe(fs.realpathSync(single));
  });

  it("updatePiExtension：null / 改名与空白名保原 / 启用与停用 / 启用路径删除拒绝且配置不变 / lastCheck 恰双键", () => {
    expect(m().updatePiExtension("no-such-id", { name: "x" })).toBeNull();
    const target = m().listPiExtensions().find((item: any) => item.name === "ext-src")!;
    expect(m().updatePiExtension(target.id, { name: "主扩展" })!.name).toBe("主扩展");
    expect(m().updatePiExtension(target.id, { name: "   " })!.name).toBe("主扩展");
    const enabled = m().updatePiExtension(target.id, { enabled: true })!;
    expect(enabled.enabled).toBe(true);
    expect(enabled.lastCheck).toEqual({ ok: true, at: FROZEN_AT });

    // 路径删除后启用被拒：throw 先于 enabled 变更与落盘，配置不变
    const scratch = path.join(dir, "scratch");
    fs.mkdirSync(scratch, { recursive: true });
    const scratchExt = m().addPiExtension({ path: scratch });
    fs.rmSync(scratch, { recursive: true, force: true });
    expect(() => m().updatePiExtension(scratchExt.id, { enabled: true })).toThrow("扩展路径当前不可用，修正路径后再启用");
    expect(m().listPiExtensions().find((item: any) => item.id === scratchExt.id)!.enabled).toBe(false);
    expect(m().updatePiExtension(target.id, { enabled: false })!.enabled).toBe(false);
  });

  it("checkPiExtension：null / 有效有文件 / 有效无文件 / 路径删除四分支", () => {
    expect(m().checkPiExtension("no-such-id")).toBeNull();
    const target = m().listPiExtensions().find((item: any) => item.name === "主扩展")!;
    const checked = m().checkPiExtension(target.id)!;
    expect(checked.lastCheck).toEqual({ ok: true, at: FROZEN_AT, files: 5, message: "路径有效，发现 5 个 JS/TS 文件；本检查未执行扩展代码。" });

    const emptyDir = path.join(dir, "empty-ext");
    fs.mkdirSync(emptyDir, { recursive: true });
    const emptyExt = m().addPiExtension({ path: emptyDir });
    expect(m().checkPiExtension(emptyExt.id)!.lastCheck)
      .toEqual({ ok: true, at: FROZEN_AT, files: 0, message: "路径有效，但未发现 JS/TS 文件。" });
    fs.rmSync(emptyDir, { recursive: true, force: true });
    const gone = m().checkPiExtension(emptyExt.id)!;
    expect(gone.exists).toBe(false);
    expect(gone.lastCheck).toEqual({ ok: false, at: FROZEN_AT, files: 0, message: "路径不存在或不可读取。" });
  });

  it("deletePiExtension：true + 落盘移除 / 不存在 id false", () => {
    expect(m().deletePiExtension("no-such-id")).toBe(false);
    const victim = m().listPiExtensions().find((item: any) => item.name === "我的扩展 Alpha!")!;
    expect(m().deletePiExtension(victim.id)).toBe(true);
    expect(m().listPiExtensions().some((item: any) => item.id === victim.id)).toBe(false);
    expect(m().deletePiExtension(victim.id)).toBe(false);
  });

  it("enabledPiExtensionPaths/Entries：全 disabled 空 / enabled 按注册序包含 / enabled 路径删除排除", () => {
    // 当前注册表：主扩展（disabled）/ scratch（disabled，路径已删）/ empty-ext（disabled，路径已删）
    expect(m().enabledPiExtensionPaths()).toEqual([]);
    expect(m().enabledPiExtensionEntries()).toEqual([]);
    const dirA = path.join(dir, "enable-a");
    const dirB = path.join(dir, "enable-b");
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    fs.writeFileSync(path.join(dirB, "tool.ts"), "export {}\n", "utf8");
    const extA = m().addPiExtension({ path: dirA });
    const extB = m().addPiExtension({ path: dirB });
    expect(m().enabledPiExtensionPaths()).toEqual([]);
    m().updatePiExtension(extA.id, { enabled: true });
    m().updatePiExtension(extB.id, { enabled: true });
    const realA = fs.realpathSync(dirA);
    const realB = fs.realpathSync(dirB);
    expect(m().enabledPiExtensionPaths()).toEqual([realA, realB]);
    const entries = m().enabledPiExtensionEntries();
    expect(entries.map((item: any) => item.id)).toEqual([extA.id, extB.id]);
    expect(entries.map((item: any) => item.path)).toEqual([realA, realB]);
    expect(entries.every((item: any) => item.enabled && item.exists)).toBe(true);
    fs.rmSync(dirB, { recursive: true, force: true });
    expect(m().enabledPiExtensionPaths()).toEqual([realA]);
    expect(m().enabledPiExtensionEntries().map((item: any) => item.id)).toEqual([extA.id]);
  });

  it("inspectPath 行为面：深度 4 不计 / t120 三目录 60+60+60 → 恰 120（walk 入口 100 截断，顺序无关）", () => {
    const deepExt = m().addPiExtension({ path: path.join(dir, "deep") });
    expect(deepExt.files).toEqual(["a/b/c/ok.ts"]);
    const t120Ext = m().addPiExtension({ path: path.join(dir, "t120") });
    const files: string[] = t120Ext.files;
    expect(files).toHaveLength(120);
    const byPrefix = new Map<string, number>();
    for (const file of files) {
      const prefix = file.split("/")[0]!;
      byPrefix.set(prefix, (byPrefix.get(prefix) ?? 0) + 1);
    }
    expect(byPrefix.size).toBe(2); // 第三目录入口 files.length>=100 被拒
    for (const count of byPrefix.values()) expect(count).toBe(60);
    expect([...byPrefix.keys()].every((prefix) => ["a", "b", "c"].includes(prefix))).toBe(true);
  });

  it("终态落盘快照（供双侧一致性 battery）", () => {
    const raw = JSON.parse(fs.readFileSync(configFile(), "utf8"));
    expect(raw.updatedAt).toBe(FROZEN_AT);
    diskSnapshots[modern ? "modern" : "legacy"] = normalize(raw, dir);
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("pi-extension-management 双侧一致性 battery", () => {
  it("终态落盘配置（归一 id/路径、冻结时钟统一 at）deep-equal", () => {
    expect(diskSnapshots.legacy).toBeDefined();
    expect(diskSnapshots.modern).toEqual(diskSnapshots.legacy);
  });
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_700_000_000_000);
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  delete process.env.OAW_DATA_DIR;
});
