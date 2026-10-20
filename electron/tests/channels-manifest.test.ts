/**
 * 通道清单对账（F2b 验收：清单对账无缺漏）。
 *
 * 从 server/index.mjs 静态提取 REST 路由面，校验三方关系：
 *   1. 无幽灵通道：DESKTOP_CHANNELS 的 method+path 必须真实存在于 server 路由面；
 *   2. chat 域无缺漏：server 路由面每条路由要么是通道、要么是 SSE 替代路由、
 *      要么落在显式豁免名录（非 chat 域，后续里程碑进入通道清单）；
 *      ——新增 chat 域路由若忘记登记通道，本测试即红；
 *   3. SSE 替代关系显式声明：被 op:event 取代的长连接路由必须登记且存在。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DESKTOP_CHANNELS,
  SSE_REPLACED_ROUTES
} from "../src/shared/protocol/channels";

const SERVER_INDEX = path.resolve(__dirname, "../../server/index.mjs");

interface ExtractedRoutes {
  stringRoutes: Set<string>;
  regexRoutePrefixes: Set<string>;
}

function extractRoutes(source: string): ExtractedRoutes {
  const stringRoutes = new Set<string>();
  const strRe = /app\.(get|post|put|delete|patch)\(\s*["'`](\/api\/[^"'`]+)["'`]/g;
  for (const match of source.matchAll(strRe)) {
    stringRoutes.add(`${match[1]?.toUpperCase()} ${match[2]}`);
  }
  // 正则形式路由（app.get(/^\/api\/doc\/...$/, ...)）：取其字面前缀归属域
  const regexRoutePrefixes = new Set<string>();
  const reRe = /app\.(get|post|put|delete|patch)\(\s*\/\^(\\?\/api\\?\/[^/\\(.,]+)/g;
  for (const match of source.matchAll(reRe)) {
    const prefix = (match[2] ?? "").replaceAll("\\/", "/").replaceAll("\\.", ".");
    regexRoutePrefixes.add(`${match[1]?.toUpperCase()} ${prefix}`);
  }
  return { stringRoutes, regexRoutePrefixes };
}

/** 非 chat 域路由豁免前缀（后续里程碑按域进入通道清单时从这里移除）。 */
const EXEMPT_PREFIXES = [
  "/api/map",
  "/api/kb",
  "/api/doc",
  "/api/templates",
  "/api/browser",
  "/api/m3",
  "/api/bus",
  "/api/demo",
  "/api/files",
  "/api/file-roots",
  "/api/context",
  "/api/integrations",
  "/api/connectors",
  "/api/projects",
  "/api/workspace",
  "/api/workspaces",
  "/api/workflows",
  "/api/domain-workflows",
  "/api/agents",
  "/api/skills",
  "/api/search",
  "/api/system",
  "/api/open-in-explorer",
  "/api/models",
  "/api/diagnostics",
  "/api/office"
] as const;

/** /api/agent/ 下属于管理配置面（settings/模型域）的逐条豁免；chat 链路路由必须进通道清单。 */
const EXEMPT_AGENT_MANAGEMENT_ROUTES = [
  "GET /api/agent/auth",
  "POST /api/agent/auth",
  "POST /api/agent/auth/remove",
  "GET /api/agent/config-status",
  "GET /api/agent/diagnostics",
  "GET /api/agent/evaluations",
  "GET /api/agent/import-preview",
  "POST /api/agent/import-config",
  "GET /api/agent/model-configs",
  "POST /api/agent/model-configs",
  "POST /api/agent/model-configs/fetch-models",
  "DELETE /api/agent/model-configs/:provider",
  "POST /api/agent/custom-provider",
  "POST /api/agent/default-model",
  "POST /api/agent/model",
  "POST /api/agent/model/probe",
  "GET /api/agent/network-settings",
  "PATCH /api/agent/network-settings",
  "GET /api/agent/plans",
  "GET /api/agent/plans/models",
  "POST /api/agent/plans/apply",
  "POST /api/agent/plans/disconnect",
  "GET /api/agent/provider-catalog",
  "GET /api/agent/provider-catalog/:id",
  "POST /api/agent/provider-catalog/import",
  "POST /api/agent/provider-catalog/refresh",
  "GET /api/agent/runtime",
  "GET /api/agent/runtimes",
  "POST /api/agent/runtime/health",
  "POST /api/agent/runtime/restart",
  "GET /api/agent/timing",
  "POST /api/agent/timing",
  "GET /api/agent/workspace-trust",
  "POST /api/agent/workspace-trust",
  "GET /api/agent/permissions",
  "DELETE /api/agent/permissions/rule"
] as const;

const channelRouteSet: ReadonlySet<string> = new Set(
  Object.entries(DESKTOP_CHANNELS).map(([, route]) => `${route.method} ${route.path}`)
);
const sseReplacedSet: ReadonlySet<string> = new Set(SSE_REPLACED_ROUTES);

function isExempt(route: string, regexRoutePrefixes: ReadonlySet<string>): boolean {
  const routePath = route.split(" ")[1] ?? "";
  if (EXEMPT_PREFIXES.some((prefix) => routePath.startsWith(prefix))) return true;
  if ((EXEMPT_AGENT_MANAGEMENT_ROUTES as readonly string[]).includes(route)) return true;
  // 正则形式路由按其字面前缀归属域判断
  for (const regexRoute of regexRoutePrefixes) {
    const regexPath = regexRoute.split(" ")[1] ?? "";
    if (routePath.startsWith(regexPath) && EXEMPT_PREFIXES.some((prefix) => regexPath.startsWith(prefix))) {
      return true;
    }
  }
  return false;
}

const source = readFileSync(SERVER_INDEX, "utf8");
const extracted = extractRoutes(source);

describe("channels manifest 对账", () => {
  it("通道清单规约：op: 前缀、族:动作命名、数量钉住（扩清单需同步更新对账）", () => {
    const channelKeys = Object.keys(DESKTOP_CHANNELS);
    expect(channelKeys.length).toBe(49);
    for (const key of channelKeys) {
      expect(key.startsWith("op:")).toBe(true);
    }
    // 通道族：status / sessions / runs / artifacts / agent / memory
    const families = new Set(channelKeys.map((key) => key.split(":")[1]));
    expect([...families].sort()).toEqual(["agent", "artifacts", "memory", "runs", "sessions", "status"]);
  });

  /** 通道路由是否被正则形式路由的字面前缀覆盖（同 method 且 path 以其为前缀）。 */
  function coveredByRegexRoute(route: string): boolean {
    const [method = "", routePath = ""] = [route.split(" ")[0], route.split(" ")[1]];
    for (const regexRoute of extracted.regexRoutePrefixes) {
      const [regexMethod = "", regexPath = ""] = [regexRoute.split(" ")[0], regexRoute.split(" ")[1]];
      if (method === regexMethod && routePath.startsWith(regexPath)) return true;
    }
    return false;
  }

  it("无幽灵通道：每个通道的 method+path 都存在于 server 路由面", () => {
    const ghost: string[] = [];
    for (const route of channelRouteSet) {
      if (extracted.stringRoutes.has(route)) continue;
      // 正则形式路由（如 /^\/api\/memory\/([^/]+)$/）：按同 method 字面前缀归属判断存在性
      if (coveredByRegexRoute(route)) continue;
      ghost.push(route);
    }
    expect(ghost).toEqual([]);
  });

  it("SSE 替代路由真实存在", () => {
    for (const route of sseReplacedSet) {
      expect(extracted.stringRoutes.has(route)).toBe(true);
    }
  });

  it("chat 域无缺漏：server 路由面每条路由都有归属（通道 / SSE 替代 / 豁免名录）", () => {
    const uncovered: string[] = [];
    for (const route of extracted.stringRoutes) {
      if (channelRouteSet.has(route)) continue;
      if (sseReplacedSet.has(route)) continue;
      if (isExempt(route, extracted.regexRoutePrefixes)) continue;
      uncovered.push(route);
    }
    expect(uncovered).toEqual([]);
  });

  it("正则形式路由全部落在豁免域或通道覆盖域（doc/templates/memory/map）", () => {
    for (const regexRoute of extracted.regexRoutePrefixes) {
      const regexPath = regexRoute.split(" ")[1] ?? "";
      expect(
        EXEMPT_PREFIXES.some((prefix) => regexPath.startsWith(prefix)) ||
          [...channelRouteSet].some((route) => coveredByRegexRoute(route) && (route.split(" ")[1] ?? "").startsWith(regexPath)),
        `正则路由 ${regexRoute} 未落在豁免域或通道覆盖域`
      ).toBe(true);
    }
  });

  it("豁免名录不与通道清单重叠", () => {
    for (const route of EXEMPT_AGENT_MANAGEMENT_ROUTES) {
      expect(channelRouteSet.has(route), `豁免路由 ${route} 不应同时是通道`).toBe(false);
    }
  });
});
