/**
 * 高德 MCP 桥（G3）回归：豁免范围、flag 基线、预置模板与文档存在性。
 * 运行：node scripts/amap-mcp-bridge-test.mjs
 *
 * validateServer 未导出且 saveMcpServer 会写真实用户配置——按项目验收惯例（A5），
 * 行为面用"源码断言 + 子进程 flag 基线"覆盖，不触碰真实 mcp-servers.json。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = path.join(import.meta.dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const passed = [];
async function check(name, fn) {
  try { await fn(); passed.push(name); console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

console.log("▶ 服务端豁免（server/mcp-management.mjs）");
await check("白名单仅含 mcp.amap.com", () => {
  const src = read("server/mcp-management.mjs");
  assert.match(src, /KNOWN_QUERY_KEY_HOSTS = new Set\(\["mcp\.amap\.com"\]\)/, "白名单应只含 mcp.amap.com");
});
await check("豁免双重条件：flag 开启 且 主机在白名单", () => {
  const src = read("server/mcp-management.mjs");
  assert.match(src, /RUNTIME_FLAGS\.amapMcpBridge && knownVendorQueryKey/, "豁免必须是 flag && 白名单双条件");
});
await check("userinfo 凭据任何情况都拒绝", () => {
  const src = read("server/mcp-management.mjs");
  assert.match(src, /if \(url\.username \|\| url\.password\) throw/, "基本凭据不应被豁免放行");
});
await check("flag 关闭路径：RUNTIME_FLAGS 从运行开关导入", () => {
  const src = read("server/mcp-management.mjs");
  assert.match(src, /import \{ RUNTIME_FLAGS \} from "\.\/feature-flags\.mjs"/);
});

console.log("▶ flag 管道");
await check("运行开关含 amapMcpBridge 且默认关", () => {
  const src = read("server/feature-flags.mjs");
  assert.match(src, /amapMcpBridge: readFlag\("OAW_AMAP_MCP_BRIDGE"\)/);
  assert.match(src, /amapMcpBridge: RUNTIME_FLAGS\.amapMcpBridge/, "快照应下发该位");
});

console.log("▶ 前端预置模板");
await check("集成中心有高德预置按钮且 flag 门控", () => {
  const src = read("client/src/components/IntegrationsCenter.jsx");
  assert.match(src, /高德地图预置/, "应有预置按钮");
  assert.match(src, /flag\("amapMcpBridge"\)/, "预置按钮应挂 flag");
  assert.match(src, /https:\/\/mcp\.amap\.com\/mcp/, "应预填官方端点");
});

console.log("▶ 行为面（子进程）");
await check("mcp-management.mjs 在 flag 关闭时可正常加载（无导入期副作用）", async () => {
  const code = `
const m = await import("./server/mcp-management.mjs");
if (typeof m.listMcpServers !== "function") throw new Error("导出缺失");
console.log("load-ok:" + m.listMcpServers().length);
`;
  const { stdout } = await run(process.execPath, ["--input-type=module", "-e", code], {
    cwd: root, env: { ...process.env, OAW_AMAP_MCP_BRIDGE: "" }, timeout: 30000,
  });
  assert.match(stdout, /load-ok:\d+/);
});

console.log("▶ 文档");
await check("接入指南存在且覆盖关键步骤", () => {
  const doc = read("docs/2026-10-16-GIS-G3-高德MCP桥接入指南.md");
  assert.match(doc, /OAW_AMAP_MCP_BRIDGE/);
  assert.match(doc, /mcp\.amap\.com\/mcp\?key=/);
  assert.match(doc, /测试并读取工具/);
});

console.log(process.exitCode ? "高德 MCP 桥回归：存在失败用例" : `高德 MCP 桥回归：通过（${passed.length} 项）`);
