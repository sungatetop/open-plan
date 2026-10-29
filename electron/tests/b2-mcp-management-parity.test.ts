/**
 * B2-14 mcp-management 域：CONFIG_FILE 模块加载期锚定 APP_DATA_DIR（OAW_DATA_DIR 链）
 * → B2-3 stubEnv 分次动态 import（R6-7a 对拍退役改写：legacy 物理路径动态 import 与
 * 源码文本锚点随 server/ 退役删除，等价性已在 B2-14 批对拍验收冻结；modern 侧
 * vi.resetModules 重载 TS 依赖树后动态 import——重载使 feature-flags 重读 env）。
 * 真实 IO：tmp DATA_DIR（CONFIG_FILE=DATA_DIR/集成/mcp-servers.json），CRUD/validateServer
 * 全分支/publicServer 脱敏形状/cachedMcpTools 上限/直写配置 fixture 经 saveMcpServer 间接驱动。
 *
 * 限制与口径：
 *   - RUNTIME_FLAGS.amapMcpBridge 模块加载期固化 → flag 开启分支无法在同一 import 副本内
 *     翻转：flag-off describe.each 先跑（凭据 query 拒绝），flag-on describe 单列 modern 侧
 *     真实行为（resetModules 重载读 on + 独立 tmp DATA_DIR2）。
 *   - MCP SDK 连接成功路径需真实 MCP server，不在本域对拍面（SDK 行为非本域逻辑）；
 *     testMcpServer 失败路径用「进程立即退出」命令（cmd /c exit 1）驱动连接拒绝。
 *   - makeId 随机 hex/updatedAt/lastTest.at 非确定性 → 断言正则与存在性，不逐字段深比较。
 */
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const IMPLS = ["modern"] as const;
type ImplKind = (typeof IMPLS)[number];

const MODERN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "b2mcp-md-"));
const MODERN_DATA2 = fs.mkdtempSync(path.join(os.tmpdir(), "b2mcp-md2-"));
const DATA_BY_KIND: Record<ImplKind, string> = { modern: MODERN_DATA };

afterAll(() => {
  delete process.env.OAW_DATA_DIR;
  delete process.env.OAW_AMAP_MCP_BRIDGE;
  for (const dir of [MODERN_DATA, MODERN_DATA2]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

const configFileOf = (dataDir: string): string => path.join(dataDir, "集成", "mcp-servers.json");

/** 直写配置（绕过 saveConfig 的 updatedAt，构造 cachedMcpTools 大清单 fixture）。 */
function seedConfig(dataDir: string, servers: any[]): void {
  fs.mkdirSync(path.dirname(configFileOf(dataDir)), { recursive: true });
  fs.writeFileSync(configFileOf(dataDir), JSON.stringify({ version: 1, servers }));
}

describe.each(IMPLS)("mcp-management (flag off): %s", (kind: ImplKind) => {
  const dataDir = DATA_BY_KIND[kind];
  let impl: any;

  beforeAll(async () => {
    delete process.env.OAW_AMAP_MCP_BRIDGE;
    process.env.OAW_DATA_DIR = dataDir;
    vi.resetModules();
    impl = await import("../src/main/backend/mcp-management");
  });

  it("空配置 listMcpServers 返回空数组", () => {
    expect(impl.listMcpServers()).toEqual([]);
  });

  it("saveMcpServer stdio 新建：清洗 env/publicServer 脱敏形状/配置落盘", () => {
    const saved = impl.saveMcpServer({
      name: "Test Server", transport: "stdio", command: "node", args: ["-v"],
      cwd: "C:/ws", env: { OK_VAR: "v1", "坏 KEY": "x", NUM: 1 },
    });
    expect(saved.id).toMatch(/^test-server-[0-9a-f]{6}$/);
    expect(saved.name).toBe("Test Server");
    expect(saved.transport).toBe("stdio");
    expect(saved.command).toBe("node");
    expect(saved.argsCount).toBe(1);
    expect(saved.cwd).toBe("C:/ws");
    expect(saved.enabled).toBe(false);
    expect(saved.envKeys).toEqual(["OK_VAR"]);
    expect(saved.headerNames).toEqual([]);
    expect(saved.hasSecrets).toBe(true);
    expect(saved.endpoint).toBeUndefined();
    // 配置落盘：坏键与非字符串值被清洗
    const raw = JSON.parse(fs.readFileSync(configFileOf(dataDir), "utf8"));
    expect(raw.servers).toHaveLength(1);
    expect(raw.servers[0].env).toEqual({ OK_VAR: "v1" });
  });

  it("validateServer throw 分支经 saveMcpServer：缺名称/非法传输/stdio 缺命令", () => {
    expect(() => impl.saveMcpServer({ transport: "stdio", command: "node" })).toThrow(/请填写 MCP 服务名称/);
    expect(() => impl.saveMcpServer({ name: "X", transport: "ws", command: "node" })).toThrow(/只支持 stdio 或 Streamable HTTP/);
    expect(() => impl.saveMcpServer({ name: "X", transport: "stdio" })).toThrow(/stdio 类型必须填写启动命令/);
  });

  it("http 分支：URL 校验/协议白名单/userinfo 拒绝/凭据 query 拒绝（flag off）/hash 剥离/headers 合并", () => {
    expect(() => impl.saveMcpServer({ name: "H", transport: "http", endpoint: "not-a-url" })).toThrow(/请填写有效的 MCP 服务 URL/);
    expect(() => impl.saveMcpServer({ name: "H", transport: "http", endpoint: "ftp://host/mcp" })).toThrow(/只支持 HTTP 或 HTTPS/);
    expect(() => impl.saveMcpServer({ name: "H", transport: "http", endpoint: "https://u:p@host/mcp" })).toThrow(/凭据写在 URL/);
    expect(() => impl.saveMcpServer({ name: "H", transport: "http", endpoint: "https://host/mcp?token=abc" })).toThrow(/凭据写在 URL/);
    const saved = impl.saveMcpServer({ name: "H", transport: "http", endpoint: "https://host/mcp#sec", headers: { "X-A": "1" } });
    expect(saved.endpoint).toBe("https://host/mcp");
    expect(saved.headerNames).toEqual(["X-A"]);
    expect(saved.command).toBeUndefined();
    expect(saved.hasSecrets).toBe(true);
  });

  it("saveMcpServer 带 id 更新：env 与 previous 合并/updateMcpServer patch 与未命中", () => {
    const first = impl.saveMcpServer({ name: "Upd Server", transport: "stdio", command: "node", env: { A: "1" } });
    const second = impl.saveMcpServer({ id: first.id, name: "Upd Server", transport: "stdio", command: "node2", env: { B: "2" } });
    expect(second.id).toBe(first.id);
    expect(second.command).toBe("node2");
    const raw = JSON.parse(fs.readFileSync(configFileOf(dataDir), "utf8"));
    expect(raw.servers.find((s: any) => s.id === first.id).env).toEqual({ A: "1", B: "2" });

    const patched = impl.updateMcpServer(first.id, { name: "Renamed" });
    expect(patched.name).toBe("Renamed");
    expect(impl.updateMcpServer("不存在-id", { name: "Y" })).toBeNull();
  });

  it("deleteMcpServer：存在 true 并落盘/不存在 false", async () => {
    const saved = impl.saveMcpServer({ name: "Del Server", transport: "stdio", command: "node" });
    expect(await impl.deleteMcpServer(saved.id)).toBe(true);
    expect(impl.listMcpServers().find((s: any) => s.id === saved.id)).toBeUndefined();
    expect(await impl.deleteMcpServer("不存在-id")).toBe(false);
  });

  it("cachedMcpTools：停用不出/启用出且 tools 上限 100/tool 清洗", () => {
    seedConfig(dataDir, [
      {
        id: "off-srv", name: "Off", transport: "stdio", command: "node", enabled: false,
        tools: [{ name: "t1", inputSchema: { type: "object", properties: {} } }],
      },
      {
        id: "on-srv", name: "On", transport: "stdio", command: "node", enabled: true,
        env: { K: "secret-value-123" },
        tools: Array.from({ length: 101 }, (_, i) => ({ name: `tool_${i}`, description: `d${i}`, inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: i === 0 } })),
      },
    ]);
    const tools = impl.cachedMcpTools();
    expect(tools).toHaveLength(100);
    expect(tools.every((item: any) => item.server.id === "on-srv")).toBe(true);
    expect(tools[0].tool.name).toBe("tool_0");
    expect(tools[0].tool.annotations.readOnlyHint).toBe(true);
    expect(tools[1].tool.annotations.readOnlyHint).toBe(false);
    expect(tools.every((item: any) => item.server.hasSecrets)).toBe(true);
    // cachedMcpTools 只 slice+cleanTool 无空名过滤（name 过滤在 testMcpServer 连接路径）；
    // schema 非对象回退为空 object schema
    seedConfig(dataDir, [{
      id: "clean-srv", name: "Clean", transport: "stdio", command: "node", enabled: true,
      tools: [{ name: "", inputSchema: "not-object" }, { name: "keep", description: "x", inputSchema: { type: "object", properties: {} } }],
    }]);
    const cleaned = impl.cachedMcpTools();
    expect(cleaned).toHaveLength(2);
    expect(cleaned[0].tool.name).toBe("");
    expect(cleaned[0].tool.inputSchema).toEqual({ type: "object", properties: {} });
    expect(cleaned[1].tool.name).toBe("keep");
  });

  it("callMcpTool 停用或不存在抛错；closeMcpConnections 不抛", async () => {
    await expect(impl.callMcpTool("不存在-id", "t", {})).rejects.toThrow(/MCP 服务已停用或不存在/);
    await expect(impl.closeMcpConnections()).resolves.toBeUndefined();
  });

  it("testMcpServer 不存在返回 ok:false 固定文案；进程立即退出命令驱动失败路径并落盘 lastTest", { timeout: 30000 }, async () => {
    expect(await impl.testMcpServer("不存在-id")).toEqual({ ok: false, error: "MCP 服务不存在" });
    const saved = impl.saveMcpServer({ name: "Bad Cmd", transport: "stdio", command: "cmd", args: ["/c", "exit", "1"] });
    const result = await impl.testMcpServer(saved.id);
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe("string");
    expect(result.error.length).toBeGreaterThan(0);
    const raw = JSON.parse(fs.readFileSync(configFileOf(dataDir), "utf8"));
    const record = raw.servers.find((s: any) => s.id === saved.id);
    expect(record.lastTest.ok).toBe(false);
    expect(typeof record.lastTest.at).toBe("string");
    // 敏感值不进错误文案（env 值 ≥4 字符时被 redact）
    expect(record.lastTest.error).not.toContain("secret-value-123");
  });
});

describe("mcp-management flag on（amap 桥，modern 侧真实行为）", () => {
  let impl: any;

  beforeAll(async () => {
    process.env.OAW_AMAP_MCP_BRIDGE = "1";
    process.env.OAW_DATA_DIR = MODERN_DATA2;
    vi.resetModules();
    impl = await import("../src/main/backend/mcp-management");
  });

  it("白名单厂商 + flag 开启：amap key 型 query 放行且 endpoint 保留", () => {
    const saved = impl.saveMcpServer({ name: "Amap", transport: "http", endpoint: "https://mcp.amap.com/mcp?key=ABC123" });
    expect(saved.endpoint).toBe("https://mcp.amap.com/mcp?key=ABC123");
  });

  it("非白名单主机 flag 开启仍拒绝；userinfo 任何情况拒绝", () => {
    expect(() => impl.saveMcpServer({ name: "Evil", transport: "http", endpoint: "https://evil.example/mcp?key=X" })).toThrow(/凭据写在 URL/);
    expect(() => impl.saveMcpServer({ name: "U", transport: "http", endpoint: "https://u:p@mcp.amap.com/mcp" })).toThrow(/凭据写在 URL/);
  });
});
