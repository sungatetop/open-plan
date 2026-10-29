/**
 * 通道清单自洽校验（F2b 建立，R6-4 起改口径）。
 *
 * R6-4 sidecar / legacy-server / http-forward 退役后，通道清单（DESKTOP_CHANNELS）
 * 是 IPC 请求面的单一事实来源：全部通道进程内直调主进程域服务，不再存在可对账的
 * server 路由面。本测试只校验清单自身的规约与自洽：
 *   1. 通道清单规约：op: 前缀、数量钉住；
 *   2. 通道族清单钉住（扩族需同步更新）；
 *   3. 路由模板自洽：method 白名单、/api/ 前缀、method+path 全局唯一；
 *   4. SSE 替代关系显式声明：替代名录钉住，且不得与通道清单重叠
 *      （被 op:event 事件流取代的旧长连接路由不能再登记为通道）。
 *
 * 历史留档：原「server/index.mjs 路由面无缺漏对账」及 EXEMPT_PREFIXES /
 * EXEMPT_AGENT_MANAGEMENT_ROUTES 豁免名录随 server 退役一并删除
 * （git 历史与 docs/plans R4-R6 执行计划留档）。
 */
import { describe, expect, it } from "vitest";
import {
  DESKTOP_CHANNELS,
  SSE_REPLACED_ROUTES
} from "../src/shared/protocol/channels";

const channelRouteSet: ReadonlySet<string> = new Set(
  Object.entries(DESKTOP_CHANNELS).map(([, route]) => `${route.method} ${route.path}`)
);
const sseReplacedSet: ReadonlySet<string> = new Set(SSE_REPLACED_ROUTES);

describe("channels manifest 自洽", () => {
  it("通道清单规约：op: 前缀、数量钉住（扩清单需同步更新本测试）", () => {
    const channelKeys = Object.keys(DESKTOP_CHANNELS);
    expect(channelKeys.length).toBe(212);
    for (const key of channelKeys) {
      expect(key.startsWith("op:")).toBe(true);
    }
  });

  it("通道族清单钉住：扩族需同步更新", () => {
    const channelKeys = Object.keys(DESKTOP_CHANNELS);
    // 通道族：status / sessions / runs / artifacts / agent / memory / files / doc / office / kb / models
    //   / search / map / projects / workspace / workspaces / file-roots / system / browser
    //   / skills / workflows / agents / integrations / templates（F6-1/F6-2）
    const families = new Set(channelKeys.map((key) => key.split(":")[1]));
    expect([...families].sort()).toEqual([
      "agent",
      "agents",
      "artifacts",
      "browser",
      "doc",
      "file-roots",
      "files",
      "integrations",
      "kb",
      "map",
      "memory",
      "models",
      "office",
      "projects",
      "runs",
      "search",
      "sessions",
      "skills",
      "status",
      "system",
      "templates",
      "workflows",
      "workspace",
      "workspaces"
    ]);
  });

  it("路由模板自洽：method 白名单、/api/ 前缀、method+path 全局唯一", () => {
    const seen = new Set<string>();
    for (const [, route] of Object.entries(DESKTOP_CHANNELS)) {
      expect(["GET", "POST", "DELETE", "PATCH"], `通道 method 越界：${route.method}`).toContain(route.method);
      expect(route.path.startsWith("/api/"), `通道 path 非 /api/ 前缀：${route.path}`).toBe(true);
      const key = `${route.method} ${route.path}`;
      expect(seen.has(key), `路由模板重复：${key}`).toBe(false);
      seen.add(key);
    }
    expect(seen.size).toBe(channelRouteSet.size);
  });

  it("SSE 替代关系显式声明：替代名录钉住，且不得与通道清单重叠", () => {
    expect([...sseReplacedSet].sort()).toEqual([
      "GET /api/agent/events",
      "GET /api/agent/stream",
      "GET /api/browser/stream",
      "GET /api/memory/stream"
    ]);
    for (const route of sseReplacedSet) {
      expect(channelRouteSet.has(route), `SSE 替代路由 ${route} 不应同时是通道`).toBe(false);
    }
  });
});
