/**
 * 桌面 IPC 请求/响应通道注册表：invoke 通道族的单一事实来源。
 *
 * 与 event-registry.ts 的分工：
 *   - event-registry：事件推送（emitChannel → op:event）的事件类型清单；
 *   - channels.ts：请求/响应通道（op:invoke）的通道清单与请求/响应类型。
 *
 * 演进对应关系（BRD-009 绞杀者模式）：每个通道最初映射 legacy server 的一条 HTTP 路由，
 * R6-4 起 sidecar / http-forward 退役，全部通道进程内直调主进程域服务，
 * 通道名与类型保持不变（method/path 字段留作历史路由对照）。
 *
 * 对账：tests/channels-manifest.test.ts 校验通道清单自洽
 * （无幽灵通道、chat 域无缺漏、SSE 替代关系显式声明）。
 *
 * 请求载荷约定（直调器按此取参）：
 *   - params：路径参数，对应旧路由的 `:param` 段；
 *   - query：查询参数（直调器按服务端 `x || ""` 兜底语义取值）；
 *   - body：JSON 请求体（GET 不发送）。
 */

export type HttpMethod = "GET" | "POST" | "DELETE" | "PATCH";

/** 通道请求载荷信封：所有通道 request 类型的公共结构（编译期由 satisfies 链保证兼容）。 */
export interface InvokeEnvelope {
  params?: Record<string, string>;
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
}

/** invoke 结果信封：保留 HTTP 语义，非 2xx 不抛异常，由调用方按 ok 收窄处理。 */
export type InvokeResult<T> =
  | { readonly ok: true; readonly status: number; readonly data: T }
  | { readonly ok: false; readonly status: number; readonly data: ChannelFailureData };

export interface ChannelFailureData {
  error?: string;
  code?: string;
  [key: string]: unknown;
}

/**
 * 通道清单：通道名 → HTTP 路由模板。
 * 通道名以 `op:` 前缀标记桌面桥通道（与 op:server-status / op:event 一致）。
 */
export const DESKTOP_CHANNELS = {
  // ---- 状态族 ----
  "op:status:get": { method: "GET", path: "/api/status" },

  // ---- 会话（线程）族 ----
  "op:sessions:list": { method: "GET", path: "/api/sessions" },
  "op:sessions:create": { method: "POST", path: "/api/sessions" },
  "op:sessions:get": { method: "GET", path: "/api/sessions/:id" },
  "op:sessions:delete": { method: "DELETE", path: "/api/sessions/:id" },
  "op:sessions:batch-delete": { method: "POST", path: "/api/sessions/batch-delete" },
  "op:sessions:rename": { method: "POST", path: "/api/sessions/:id/rename" },
  "op:sessions:pin": { method: "POST", path: "/api/sessions/:id/pin" },
  "op:sessions:freeze": { method: "POST", path: "/api/sessions/:id/freeze" },
  "op:sessions:fork": { method: "POST", path: "/api/sessions/:id/fork" },

  // ---- 运行（Run）族 ----
  "op:runs:list": { method: "GET", path: "/api/runs" },
  "op:runs:get": { method: "GET", path: "/api/runs/:id" },
  "op:runs:cancel": { method: "POST", path: "/api/runs/:id/cancel" },
  "op:runs:rollback": { method: "POST", path: "/api/runs/:id/rollback" },
  "op:runs:step": { method: "POST", path: "/api/runs/:id/steps/:stepId" },
  "op:runs:resume": { method: "POST", path: "/api/runs/:id/resume" },
  "op:runs:retry": { method: "POST", path: "/api/runs/:id/retry" },
  "op:runs:artifacts:publish": { method: "POST", path: "/api/runs/:id/artifacts/:artifactId/publish" },
  "op:runs:artifacts:accept": { method: "POST", path: "/api/runs/:id/artifacts/:artifactId/accept" },
  "op:runs:acceptance": { method: "GET", path: "/api/runs/:id/acceptance" },
  "op:runs:diff": { method: "GET", path: "/api/runs/:id/changes/:changeId/diff" },
  "op:artifacts:list": { method: "GET", path: "/api/artifacts" },
  "op:artifacts:rollback": { method: "POST", path: "/api/artifacts/:publicationId/rollback" },

  // ---- Agent 交互族（对话链路核心） ----
  "op:agent:prompt": { method: "POST", path: "/api/agent/prompt" },
  "op:agent:abort": { method: "POST", path: "/api/agent/abort" },
  "op:agent:model:set": { method: "POST", path: "/api/agent/model" },
  "op:agent:runtime": { method: "GET", path: "/api/agent/runtime" },
  "op:agent:compact": { method: "POST", path: "/api/agent/compact" },
  "op:agent:new": { method: "POST", path: "/api/agent/new" },
  "op:agent:resume": { method: "POST", path: "/api/agent/resume" },
  "op:agent:pending": { method: "GET", path: "/api/agent/pending" },
  "op:agent:answer": { method: "POST", path: "/api/agent/answer" },
  "op:agent:approvals": { method: "GET", path: "/api/agent/approvals" },
  "op:agent:approval": { method: "POST", path: "/api/agent/approval" },
  "op:agent:approval-mode:get": { method: "GET", path: "/api/agent/approval-mode" },
  "op:agent:approval-mode:set": { method: "PATCH", path: "/api/agent/approval-mode" },
  "op:agent:stream-close": { method: "POST", path: "/api/agent/stream/close" },
  "op:agent:session-tree": { method: "GET", path: "/api/agent/session-tree" },
  "op:agent:session-branch": { method: "POST", path: "/api/agent/session-branch" },

  // ---- 事件游标管理（事件桥配套；SSE 本体由 op:event 推送替代） ----
  "op:agent:events-state": { method: "GET", path: "/api/agent/events/state" },
  "op:agent:events-read": { method: "POST", path: "/api/agent/events/read" },

  // ---- 记忆域（F3 批4：MemoryTab；file:get/save 对应 server 正则路由 /^\/api\/memory\/([^/]+)$/） ----
  "op:memory:list": { method: "GET", path: "/api/memory" },
  "op:memory:init": { method: "POST", path: "/api/memory/init" },
  "op:memory:file:get": { method: "GET", path: "/api/memory/:rel" },
  "op:memory:file:save": { method: "POST", path: "/api/memory/:rel" },
  "op:memory:proposals:list": { method: "GET", path: "/api/memory/proposals" },
  "op:memory:proposals:approve": { method: "POST", path: "/api/memory/proposals/:id/approve" },
  "op:memory:proposals:edit": { method: "PATCH", path: "/api/memory/proposals/:id" },
  "op:memory:proposals:reject": { method: "POST", path: "/api/memory/proposals/:id/reject" },
  "op:memory:proposals:history": { method: "GET", path: "/api/memory/proposals/:id/history" },
  "op:memory:proposals:merge": { method: "POST", path: "/api/memory/proposals/:id/merge" },

  // ---- 文件族（F3 批5b-2：SessionSidebar 文件树/上传/搜索；批7b：App 工作区文件列表） ----
  "op:files:list": { method: "GET", path: "/api/files" },
  "op:files:search": { method: "GET", path: "/api/files/search" },
  "op:files:upload": { method: "POST", path: "/api/files/upload" },
  "op:files:delete": { method: "POST", path: "/api/files/delete" },

  // ---- 知识库族（F3 批5b-5：SessionSidebar docx 存入知识库；域内其余路由仍走前缀豁免） ----
  "op:kb:ingest": { method: "POST", path: "/api/kb/ingest" },
  // ---- 知识库域（F5-4：kb-direct 直调；本地索引 + IMA 云端 + docx 联动） ----
  "op:kb:status": { method: "GET", path: "/api/kb/status" },
  "op:kb:roots:add": { method: "POST", path: "/api/kb/roots" },
  "op:kb:roots:remove": { method: "DELETE", path: "/api/kb/roots" },
  "op:kb:tree": { method: "GET", path: "/api/kb/tree" },
  "op:kb:search": { method: "GET", path: "/api/kb/search" },
  "op:kb:graph": { method: "GET", path: "/api/kb/graph" },
  "op:kb:doc": { method: "GET", path: "/api/kb/doc" },
  "op:kb:ima:status": { method: "GET", path: "/api/kb/ima/status" },
  "op:kb:ima:bases": { method: "GET", path: "/api/kb/ima/bases" },
  "op:kb:ima:search": { method: "GET", path: "/api/kb/ima/search" },
  "op:kb:ima:doc": { method: "GET", path: "/api/kb/ima/doc" },
  "op:kb:export-docx": { method: "POST", path: "/api/kb/export-docx" },

  // ---- 技能族（F6-1：skills-direct 直调；技能广场扫描/导出/导入；preflight 前端未消费不入清单） ----
  "op:skills:list": { method: "GET", path: "/api/skills" },
  "op:skills:export": { method: "POST", path: "/api/skills/export" },
  "op:skills:import": { method: "POST", path: "/api/skills/import" },

  // ---- 工作流族（F6-1：workflows-direct 直调；声明式工作流 + §4 领域工作流预检试算） ----
  "op:workflows:list": { method: "GET", path: "/api/workflows" },
  "op:workflows:validate": { method: "GET", path: "/api/workflows/:id/validate" },
  "op:workflows:preflight": { method: "POST", path: "/api/domain-workflows/preflight" },

  // ---- 智能体族（F6-1：agents-direct 直调；智能体广场自定义 Agent CRUD） ----
  "op:agents:list": { method: "GET", path: "/api/agents" },
  "op:agents:create": { method: "POST", path: "/api/agents" },
  "op:agents:update": { method: "PATCH", path: "/api/agents/:id" },
  "op:agents:delete": { method: "DELETE", path: "/api/agents/:id" },

  // ---- 集成族（F6-1：integrations-direct 直调；MCP 服务与 Pi 扩展接入） ----
  "op:integrations:mcp:list": { method: "GET", path: "/api/integrations/mcp/servers" },
  "op:integrations:mcp:save": { method: "POST", path: "/api/integrations/mcp/servers" },
  "op:integrations:mcp:update": { method: "PATCH", path: "/api/integrations/mcp/servers/:id" },
  "op:integrations:mcp:delete": { method: "DELETE", path: "/api/integrations/mcp/servers/:id" },
  "op:integrations:mcp:test": { method: "POST", path: "/api/integrations/mcp/servers/:id/test" },
  "op:integrations:pi:list": { method: "GET", path: "/api/integrations/pi/extensions" },
  "op:integrations:pi:catalog": { method: "GET", path: "/api/integrations/pi/catalog" },
  "op:integrations:pi:from-package": { method: "POST", path: "/api/integrations/pi/extensions/from-package" },
  "op:integrations:pi:add": { method: "POST", path: "/api/integrations/pi/extensions" },
  "op:integrations:pi:update": { method: "PATCH", path: "/api/integrations/pi/extensions/:id" },
  "op:integrations:pi:check": { method: "POST", path: "/api/integrations/pi/extensions/:id/check" },
  "op:integrations:pi:delete": { method: "DELETE", path: "/api/integrations/pi/extensions/:id" },

  // ---- 模版库族（F6-1：templates-direct 直调；列表/内容/红头通知/文件流。
  //      file/files 为 server 正则路由转录：params.path 承载捕获组原文（IPC 直调无 URL
  //      编码层，渲染层传 relPath 原文，直调器按「已解码捕获组」语义消费）） ----
  "op:templates:list": { method: "GET", path: "/api/templates" },
  "op:templates:content": { method: "GET", path: "/api/templates/content" },
  "op:templates:generate-notice": { method: "POST", path: "/api/templates/generate-notice" },
  "op:templates:file": { method: "GET", path: "/api/templates/file/:path" },
  "op:templates:files": { method: "GET", path: "/api/templates/files/:path" },

  // ---- 内置浏览器族（F6-2：browser-direct 直调；画面流状态/导航/输入/关闭/重置/整页截图/PDF/推流暂停。
  //      /api/browser/stream 长连接以 op:browser:watch/unwatch + op:browser-stream 事件推送替代（不入清单）；
  //      /api/browser/shot 文件回看不迁（BrowserPanel 未消费，聊天工具卡文件走 openDocFile/file-urls）） ----
  "op:browser:state": { method: "GET", path: "/api/browser/state" },
  "op:browser:open": { method: "POST", path: "/api/browser/open" },
  "op:browser:stream-pause": { method: "POST", path: "/api/browser/stream-pause" },
  "op:browser:fullpage": { method: "POST", path: "/api/browser/fullpage" },
  "op:browser:pdf": { method: "POST", path: "/api/browser/pdf" },
  "op:browser:input": { method: "POST", path: "/api/browser/input" },
  "op:browser:close": { method: "POST", path: "/api/browser/close" },
  "op:browser:reset": { method: "POST", path: "/api/browser/reset" },

  // ---- 模型族（10s 单飞缓存在 renderer API 层，通道只承载传输） ----
  "op:models:list": { method: "GET", path: "/api/models" },
  "op:models:refresh": { method: "POST", path: "/api/models/refresh" },

  // ---- Agent 配置族（SettingsPanel：鉴权/导入/网络/模型配置/目录/探测/权限） ----
  "op:agent:auth:get": { method: "GET", path: "/api/agent/auth" },
  "op:agent:auth:save": { method: "POST", path: "/api/agent/auth" },
  "op:agent:auth:remove": { method: "POST", path: "/api/agent/auth/remove" },
  "op:agent:custom-provider": { method: "POST", path: "/api/agent/custom-provider" },
  "op:agent:config-status": { method: "GET", path: "/api/agent/config-status" },
  "op:agent:import-preview": { method: "GET", path: "/api/agent/import-preview" },
  "op:agent:import-config": { method: "POST", path: "/api/agent/import-config" },
  "op:agent:plans": { method: "GET", path: "/api/agent/plans" },
  "op:agent:plans:models": { method: "GET", path: "/api/agent/plans/models" },
  "op:agent:plans:apply": { method: "POST", path: "/api/agent/plans/apply" },
  "op:agent:plans:disconnect": { method: "POST", path: "/api/agent/plans/disconnect" },
  "op:agent:diagnostics": { method: "GET", path: "/api/agent/diagnostics" },
  "op:agent:network-settings:get": { method: "GET", path: "/api/agent/network-settings" },
  "op:agent:network-settings:save": { method: "PATCH", path: "/api/agent/network-settings" },
  "op:agent:model-configs:list": { method: "GET", path: "/api/agent/model-configs" },
  "op:agent:model-configs:save": { method: "POST", path: "/api/agent/model-configs" },
  "op:agent:model-configs:delete": { method: "DELETE", path: "/api/agent/model-configs/:provider" },
  "op:agent:model-configs:fetch-models": { method: "POST", path: "/api/agent/model-configs/fetch-models" },
  "op:agent:provider-catalog": { method: "GET", path: "/api/agent/provider-catalog" },
  "op:agent:provider-catalog:detail": { method: "GET", path: "/api/agent/provider-catalog/:id" },
  "op:agent:provider-catalog:import": { method: "POST", path: "/api/agent/provider-catalog/import" },
  "op:agent:provider-catalog:refresh": { method: "POST", path: "/api/agent/provider-catalog/refresh" },
  "op:agent:default-model:set": { method: "POST", path: "/api/agent/default-model" },
  "op:agent:model:probe": { method: "POST", path: "/api/agent/model/probe" },
  "op:agent:permissions:get": { method: "GET", path: "/api/agent/permissions" },
  "op:agent:permissions:rule:remove": { method: "DELETE", path: "/api/agent/permissions/rule" },

  // ---- 联网搜索配置族（SettingsPanel 搜索分节） ----
  "op:search:settings:get": { method: "GET", path: "/api/search/settings" },
  "op:search:settings:save": { method: "POST", path: "/api/search/settings" },
  "op:search:test": { method: "POST", path: "/api/search/test" },

  // ---- 地图设置族（SettingsPanel 地图分节） ----
  "op:map:settings:get": { method: "GET", path: "/api/map/settings" },
  "op:map:settings:save": { method: "POST", path: "/api/map/settings" },

  // ---- 地图域项目图层族（F5-1：map-direct 直调；项目生命周期/样式配置/导入/瓦片/图层/空间查询） ----
  "op:map:projects:list": { method: "GET", path: "/api/map/projects" },
  "op:map:projects:create": { method: "POST", path: "/api/map/projects" },
  "op:map:project:get": { method: "GET", path: "/api/map/project" },
  "op:map:project:export": { method: "GET", path: "/api/map/project/export" },
  "op:map:projects:duplicate": { method: "POST", path: "/api/map/projects/duplicate" },
  "op:map:projects:rename": { method: "POST", path: "/api/map/projects/rename" },
  "op:map:projects:archive": { method: "POST", path: "/api/map/projects/archive" },
  "op:map:projects:delete": { method: "POST", path: "/api/map/projects/delete" },
  "op:map:style:save": { method: "POST", path: "/api/map/style" },
  "op:map:config:save": { method: "POST", path: "/api/map/config" },
  "op:map:import": { method: "POST", path: "/api/map/import" },
  "op:map:import:batch": { method: "POST", path: "/api/map/import-batch" },
  "op:map:prepare": { method: "POST", path: "/api/map/prepare" },
  "op:map:rebuild": { method: "POST", path: "/api/map/rebuild" },
  "op:map:layer:delete": { method: "POST", path: "/api/map/layer/delete" },
  "op:map:layer:get": { method: "GET", path: "/api/map/layer" },
  "op:map:isochrone": { method: "POST", path: "/api/map/isochrone" },
  "op:map:route": { method: "POST", path: "/api/map/route" },
  "op:map:project:detail": { method: "GET", path: "/api/map/project/:name" },
  "op:map:project:style:save": { method: "POST", path: "/api/map/project/:name/style" },
  "op:map:project:config:save": { method: "POST", path: "/api/map/project/:name/config" },
  "op:map:project:import": { method: "POST", path: "/api/map/project/:name/import" },
  "op:map:project:rebuild-tiles": { method: "POST", path: "/api/map/project/:name/rebuild-tiles" },
  "op:map:project:layer:get": { method: "GET", path: "/api/map/project/:name/layer/:layerId" },
  "op:map:project:layer:delete": { method: "DELETE", path: "/api/map/project/:name/layer/:layerId" },
  "op:map:project:isochrone": { method: "POST", path: "/api/map/project/:name/isochrone" },

  // ---- 地图域分析可视化族（F5-2：map-direct 直调；统一可视化/M2 分析/演示数据/M3 新昌公交） ----
  "op:map:visual:sources": { method: "GET", path: "/api/map/visual/sources" },
  "op:map:visual:get": { method: "GET", path: "/api/map/visual" },
  "op:map:traffic-bandwidth": { method: "GET", path: "/api/map/traffic-bandwidth" },
  "op:map:od-lines": { method: "GET", path: "/api/map/od-lines" },
  "op:map:multi-isochrone": { method: "POST", path: "/api/map/multi-isochrone" },
  "op:map:exchange-sankey": { method: "GET", path: "/api/map/exchange-sankey" },
  "op:map:road-structure": { method: "GET", path: "/api/map/road-structure" },
  // legacy 路径 /api/map/demo-analysis 与 /api/demo/cambodia-od（server L799-808 先注册生效段；
  // bus 族 /api/bus/* 为 L5714 404 catch-all 遮蔽的死路由，不登记通道，随 R6 退役）
  "op:map:demo-analysis": { method: "GET", path: "/api/map/demo-analysis" },
  "op:map:cambodia-od": { method: "GET", path: "/api/demo/cambodia-od" },
  "op:map:m3:bus-routes": { method: "GET", path: "/api/m3/bus-routes" },
  "op:map:m3:station-heatmap": { method: "GET", path: "/api/m3/station-heatmap" },
  "op:map:m3:od-lines": { method: "GET", path: "/api/m3/od-lines" },
  "op:map:m3:network-stats": { method: "GET", path: "/api/m3/network-stats" },
  // ---- 地图域报告导出模板族（F5-3：map-direct 直调；GIS G8 报告 / G7 批量导出 / G5-v1 OD 通勤模板） ----
  "op:map:report": { method: "POST", path: "/api/map/report" },
  "op:map:export:batch:start": { method: "POST", path: "/api/map/export/batch" },
  "op:map:export:batch:status": { method: "GET", path: "/api/map/export/batch" },
  "op:map:template:od-commuter": { method: "POST", path: "/api/map/template/od-commuter" },
  // F5-5：style.json 动态读通道（server L592-608 正则路由：hydrate 底图 + 相对瓦片 URL 绝对化；
  // 桌面形态扩展 glyphs/data 一并绝对化到 sidecar origin，渲染层与 sidecar 不同源）
  "op:map:data:style": { method: "GET", path: "/api/map/data/:project/style.json" },

  // ---- 项目族（SettingsPanel 项目管理分节；批7b：App 项目列表） ----
  "op:projects:list": { method: "GET", path: "/api/projects" },
  "op:projects:create": { method: "POST", path: "/api/projects" },
  "op:projects:classify": { method: "POST", path: "/api/projects/classify" },
  "op:projects:update": { method: "PATCH", path: "/api/projects/:id" },
  "op:projects:pin": { method: "POST", path: "/api/projects/:id/pin" },
  "op:projects:archive": { method: "POST", path: "/api/projects/:id/archive" },
  "op:projects:settings:update": { method: "PATCH", path: "/api/projects/:id/settings" },

  // ---- 工作区族（SessionSidebar 工作区切换/验证/系统选择器；批7b：App 工作区列表与切换） ----
  "op:workspaces:list": { method: "GET", path: "/api/workspaces" },
  "op:workspace:switch": { method: "POST", path: "/api/workspace/switch" },
  "op:workspace:validate": { method: "POST", path: "/api/workspace/validate" },
  "op:workspace:pick": { method: "POST", path: "/api/workspace/pick" },
  "op:workspace:pick:cancel": { method: "POST", path: "/api/workspace/pick/cancel" },

  // ---- 外部目录（文件根）族 ----
  "op:file-roots:list": { method: "GET", path: "/api/file-roots" },
  "op:file-roots:add": { method: "POST", path: "/api/file-roots" },
  "op:file-roots:remove": { method: "DELETE", path: "/api/file-roots/:id" },

  // ---- 系统集成族（原生文件选择/系统打开/文件管理器显示） ----
  "op:system:pick-files": { method: "POST", path: "/api/system/pick-files" },
  "op:system:open": { method: "POST", path: "/api/system/open" },
  "op:system:reveal": { method: "POST", path: "/api/system/reveal" },

  // ---- 文档预览族（F4-3 读路由 + F4-4 写路由：annotations POST / raw-save / cells / edit / office / watch） ----
  "op:doc:open": { method: "GET", path: "/api/doc/:name" },
  "op:doc:raw": { method: "GET", path: "/api/doc/:name/raw" },
  "op:doc:text": { method: "GET", path: "/api/doc/:name/text" },
  "op:doc:html": { method: "GET", path: "/api/doc/:name/html" },
  "op:doc:comments": { method: "GET", path: "/api/doc/:name/comments" },
  "op:doc:outline": { method: "GET", path: "/api/doc/:name/outline" },
  "op:doc:annotations": { method: "GET", path: "/api/doc/:name/annotations" },
  "op:doc:annotations-save": { method: "POST", path: "/api/doc/:name/annotations" },
  "op:doc:raw-save": { method: "POST", path: "/api/doc/:name/raw-save" },
  "op:doc:cells": { method: "POST", path: "/api/doc/:name/cells" },
  "op:doc:edit": { method: "POST", path: "/api/doc/edit" },
  "op:office:run": { method: "POST", path: "/api/office" },
  "op:doc:watch": { method: "GET", path: "/api/doc/:name/watch" },
  "op:doc:watch-stop": { method: "POST", path: "/api/doc/:name/watch/stop" }
} as const satisfies Record<string, { method: HttpMethod; path: string }>;

export type DesktopChannelId = keyof typeof DESKTOP_CHANNELS;

/** SSE 长连接路由 → op:event 推送的替代关系（对账测试断言其存在于 server 路由面）。
 *  GET /api/browser/stream（F6-2）以 op:browser:watch/unwatch 生命周期 + op:browser-stream 事件推送替代。 */
export const SSE_REPLACED_ROUTES = ["GET /api/agent/stream", "GET /api/agent/events", "GET /api/memory/stream", "GET /api/browser/stream"] as const;

// ============================================================================
// 领域载荷类型：对齐 server/index.mjs 各路由的实际请求/响应结构。
// 视图类型只声明调用方消费的字段；响应里的未知扩展字段不进类型（F3 消费时按需收紧）。
// ============================================================================

// ---- 状态族 ----

export type StatusGetRequest = { query?: { token?: string } };

export interface ServiceStatusInfo {
  pid: number;
  startedAt: string;
  uptimeSec: number;
  identity: string;
  sandboxIdentity: boolean;
}

export interface StatusInfo {
  ok: true;
  officecli: string;
  version: string;
  piPackageVersion: string;
  host: string;
  authRequired: boolean;
  platform: string;
  native: Record<string, unknown>;
  runtimeFlags: Record<string, unknown>;
  picker: Record<string, unknown> | null;
  service: ServiceStatusInfo;
}

// ---- 会话族 ----

export type SessionListRequest = {
  query?: {
    file?: string;
    projectId?: string;
    mode?: string;
    runStatus?: string;
    pinned?: "true" | "false";
    frozen?: "true" | "false";
  };
};

export interface SessionListItem {
  id: string;
  threadId: string;
  projectId: string | null;
  projectName: string;
  projectType: string;
  projectStatus: string;
  cwd: string;
  created: string;
  modified: number;
  label: string;
  pinned: boolean;
  frozen: boolean;
  freezeReason: string;
  contextSnapshot: Record<string, unknown> | null;
  parentSessionId: string | null;
  branchSourceMessageId: string | null;
  branchPurpose: string;
  fileName: string;
  title: string;
  runStatus: RunStatus | (string & {});
  runId: string | null;
  mode: string;
  lastRunAt: string | null;
  artifactCount: number;
}

export interface SessionListResponse {
  sessions: SessionListItem[];
}

export type SessionCreateRequest = {
  body?: { cwd?: string; projectId?: string | null; label?: string; frozen?: boolean };
};

export interface SessionCreateResponse {
  id: string;
  fileName: string;
  cwd: string;
  projectId: string | null;
  created: string;
  status: string;
  pinned: boolean;
  frozen: boolean;
}

export type SessionGetRequest = {
  params: { id: string };
  query?: { view?: "chat"; limit?: number; before?: number };
};

export interface SessionEntry {
  id: string;
  parentId?: string | null;
  type?: string;
  [key: string]: unknown;
}

export interface SessionInfo {
  id: string;
  cwd: string;
  projectId: string | null;
  created: string;
  label: string;
  pinned: boolean;
  frozen: boolean;
  freezeReason: string;
  contextSnapshot: Record<string, unknown> | null;
  parentSessionId: string | null;
  branchSourceMessageId: string | null;
  branchPurpose: string;
  fileName: string;
  modified: number;
  chatView: boolean;
  historyTotal?: number;
  historyStart?: number;
  historyEnd?: number;
  historyHasMore: boolean;
}

export interface SessionGetResponse {
  entries: SessionEntry[];
  tree: Record<string, string[]>;
  leafId: string | null;
  info: SessionInfo;
}

export type SessionDeleteRequest = { params: { id: string } };
export interface SessionDeleteResponse { ok: true }

export type SessionBatchDeleteRequest = { body: { ids: string[] } };

export interface SessionBatchDeleteResponse {
  ok: true;
  deleted: string[];
  skipped: { id: string; reason: string }[];
  missing: string[];
}

export type SessionRenameRequest = { params: { id: string }; body?: { label?: string } };
export interface SessionRenameResponse { ok: true; label: string }

export type SessionPinRequest = { params: { id: string }; body?: { pinned?: boolean } };
export interface SessionPinResponse { ok: true; sessionId: string; pinned: boolean }

export type SessionFreezeRequest = {
  params: { id: string };
  body?: { frozen?: boolean; reason?: string; snapshot?: Record<string, unknown> };
};

export interface SessionFreezeResponse {
  ok: true;
  sessionId: string;
  frozen: boolean;
  freezeReason: string;
  contextSnapshot: Record<string, unknown> | null;
}

export type SessionForkRequest = {
  params: { id: string };
  body?: { label?: string; sourceMessageId?: string; purpose?: string };
};

export interface SessionForkResponse {
  ok: true;
  id: string;
  fileName: string;
  parentSessionId: string;
  cwd: string;
  threadId: string;
  label: string;
  projectId: string | null;
}

// ---- 运行（Run）族 ----

/** Run 生命周期状态（listRuns/会话徽标所见；容忍服务端扩展值）。 */
export type RunStatus =
  | "idle"
  | "queued"
  | "running"
  | "waiting_user"
  | "recovering"
  | "cancel_requested"
  | "cancelled"
  | "aborted"
  | "failed"
  | "completed";

export interface RunActions {
  canCancel?: boolean;
  canResume?: boolean;
  canRetry?: boolean;
  [key: string]: unknown;
}

/** 验收详情：服务端在 artifact.acceptance / run.acceptance 上都会返回（人工确认/可固定状态）。 */
export interface RunAcceptanceInfo {
  readyToPublish?: boolean;
  status?: string;
  summary?: string;
  checks?: Record<string, { status?: string }>;
  artifacts?: Array<{ path?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface RunArtifact {
  changeId?: string;
  artifactId?: string;
  relativePath?: string;
  path?: string;
  cwd?: string;
  blobs?: { before?: string | boolean | null; after?: string | boolean | null };
  acceptance?: RunAcceptanceInfo;
  acceptanceStatus?: string | null;
  verificationStatus?: string | null;
  [key: string]: unknown;
}

export interface RunEventEntry {
  seq?: number;
  type?: string;
  data?: unknown;
  at?: string;
  [key: string]: unknown;
}

/** Run 记录视图：id 必有，其余字段随记录版本可选（IO 边界数据，调用方做空值兜底）。 */
export interface RunRecord {
  id: string;
  status?: RunStatus | (string & {});
  threadId?: string | null;
  sessionId?: string | null;
  clientId?: string;
  cwd?: string;
  projectId?: string | null;
  mode?: string;
  createdAt?: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  artifactCount?: number;
  error?: string | null;
  summary?: string;
  model?: string | null;
  finalText?: string;
  acceptance?: RunAcceptanceInfo;
  verificationStatus?: string;
  completion?: Record<string, unknown> | null;
  actions?: RunActions;
  steps?: RunEventEntry[];
  events?: RunEventEntry[];
  artifacts?: RunArtifact[];
  task?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export type RunListRequest = {
  query?: {
    thread?: string;
    session?: string;
    cwd?: string;
    projectId?: string;
    status?: string;
    mode?: string;
    query?: string;
    limit?: number;
    fields?: "summary";
    includeEvents?: "all" | "none" | "latest";
  };
};

export interface RunListResponse { runs: RunRecord[] }

export type RunGetRequest = { params: { id: string } };
export interface RunGetResponse { run: RunRecord }

export type RunCancelRequest = { params: { id: string }; body?: { reason?: string } };
export interface RunCancelResponse {
  ok: true;
  run: RunRecord;
  previous: unknown;
  stillQueued: number;
}

export type RunRollbackRequest = { params: { id: string }; body: { confirm: true; paths?: string[] } };
export interface RunRollbackResult { ok: boolean; [key: string]: unknown }

export type RunStepRequest = {
  params: { id: string; stepId: string };
  body?: Record<string, unknown>;
};
export interface RunStepResponse { ok: true; run: RunRecord }

export type RunResumeRetryRequest = { params: { id: string }; body?: Record<string, unknown> };
export interface RunContinuationResponse { ok: true; run: RunRecord; sourceRunId: string }

export type RunArtifactPublishRequest = {
  params: { id: string; artifactId: string };
  body?: { rules?: Record<string, unknown>; operator?: string };
};

export type RunArtifactAcceptRequest = {
  params: { id: string; artifactId: string };
  body?: { note?: string; operator?: string; rules?: Record<string, unknown> };
};

export interface ArtifactOpResult { ok: boolean; [key: string]: unknown }

export type RunAcceptanceRequest = { params: { id: string }; query?: { rules?: string } };

export type RunDiffRequest = {
  params: { id: string; changeId: string };
  query?: { page?: number };
};

export interface RunDiffResponse {
  ok: true;
  change: {
    changeId: string | null;
    relativePath: string;
    changeType: string | null;
    confidence: unknown;
    source: string | null;
    blobs: Record<string, unknown>;
    acceptanceStatus: string | null;
    verificationStatus: string | null;
  };
  diff: Record<string, unknown>;
  limits: {
    maxInputBytes: number;
    maxHunksPerPage: number;
    inputTruncated: boolean;
  };
}

export type ArtifactListRequest = {
  query?: { cwd?: string; projectId?: string; limit?: number };
};
export interface ArtifactListResponse { artifacts: RunArtifact[] }

export type ArtifactRollbackRequest = {
  params: { publicationId: string };
  body: { confirm: true; operator?: string };
};

// ---- Agent 交互族 ----

export interface PromptImage { data?: string; mimeType?: string; [key: string]: unknown }

export interface PromptAttachment { name?: string; data?: string; mimeType?: string; [key: string]: unknown }

export interface PromptTaskInput {
  mode?: string;
  workflowId?: string | null;
  workspace?: string;
  cwd?: string;
  projectId?: string | null;
  skills?: string[];
  goal?: string;
  [key: string]: unknown;
}

export type AgentPromptRequest = {
  body: {
    client: string;
    thread?: string;
    text?: string;
    images?: PromptImage[];
    attachments?: PromptAttachment[];
    references?: unknown[];
    effort?: string;
    model?: string;
    task?: PromptTaskInput;
    latency?: Record<string, unknown>;
  };
};

/** prompt 的 admission 响应：HTTP 只负责"已接收"，后续状态全走 op:event 事件流。 */
export interface PromptAdmissionResponse {
  ok: true;
  accepted: true;
  queued: boolean;
  queuePosition: number;
  changed: string[];
  runId: string | null;
  artifacts: unknown[];
  validations: unknown[];
  verificationStatus: string;
  status: string;
  task: Record<string, unknown> | null;
  sessionId: string | null;
  model: string | null;
  modelFallbackFrom: string | null;
  thread: string | null;
}

export type AgentAbortRequest = { body: { client: string; thread?: string } };
export interface AgentAbortResponse {
  ok?: boolean;
  runId: string | null;
  stillQueued: number;
  [key: string]: unknown;
}

/** POST /api/agent/model：切换模型；运行中受理时 pending=true（排队到本轮结束）。 */
export type AgentModelSetRequest = {
  body: { client: string; thread?: string; model: string };
};
export interface AgentModelSetResponse {
  ok?: boolean;
  pending?: boolean;
  model?: string;
  current?: string;
  [key: string]: unknown;
}

/** GET /api/agent/runtime：Pi 运行时上下文用量快照（恢复/切换会话后回填）。 */
export type AgentRuntimeRequest = { query: { client: string; thread?: string } };
export interface AgentRuntimeResponse {
  usage?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export type AgentCompactRequest = {
  body: { client: string; thread?: string; instructions?: string };
};
export interface AgentCompactResponse { ok?: boolean; [key: string]: unknown }

export type AgentNewRequest = {
  body: { client: string; thread: string; cwd?: string; projectId?: string | null; label?: string };
};
export interface AgentThreadResponse { sessionId: string; [key: string]: unknown }

export type AgentResumeRequest = {
  body: { client: string; thread: string; sessionId: string; cwd?: string };
};

export type AgentPendingRequest = { query: { client: string; thread?: string } };
export interface AgentPendingResponse {
  questions: Record<string, unknown>[];
  pendingMessages: number | null;
}

export type AgentAnswerRequest = {
  body: { client: string; thread?: string; answer: string };
};
export interface AgentAnswerResponse { ok: boolean; [key: string]: unknown }

export interface ApprovalItem {
  id: string;
  tool: string;
  input: string;
  runId: string | null;
  threadId: string | null;
  clientId: string | null;
  status: string;
  createdAt: string;
}

export interface AgentApprovalsResponse { approvals: ApprovalItem[] }

export type AgentApprovalRequest = {
  body: { id: string; decision: "allow" | "always" | "deny" };
};

export type AgentApprovalResponse =
  | { ok: true; id: string; decision: "allow" | "deny"; always?: boolean; recovered?: boolean }
  | { ok: false; error: string };

export type AgentApprovalModeGetResponse = { mode: "ask" | "auto" };

export type AgentApprovalModeSetRequest = { body: { mode: "ask" | "auto" } };
export interface AgentApprovalModeSetResponse { ok?: boolean; [key: string]: unknown }

export type AgentStreamCloseRequest = { body: { client: string; thread?: string } };
export interface AgentStreamCloseResponse { closed: number }

export type AgentSessionTreeRequest = { query: { client: string; thread?: string } };
export interface AgentSessionTreeResponse { ok?: boolean; [key: string]: unknown }

export type AgentSessionBranchRequest = {
  body: {
    client: string;
    thread?: string;
    entryId: string;
    summarize?: boolean;
    label?: string;
  };
};
export interface AgentSessionBranchResponse { ok?: boolean; [key: string]: unknown }

export type AgentEventsStateRequest = { query: { client: string } };
export interface AgentEventsStateResponse { readCursor: number; [key: string]: unknown }

export type AgentEventsReadRequest = { body: { client: string; seq: number } };
export interface AgentEventsReadResponse { ok?: boolean; [key: string]: unknown }

// ---- 记忆域（F3 批4：MemoryTab） ----

export interface MemoryFileInfo {
  rel: string;
  type?: string;
  size?: number;
  [key: string]: unknown;
}

export type MemoryListResponse = { files: MemoryFileInfo[]; memoryDir?: string };

export type MemoryFileGetResponse = { content: string; path: string };

export type MemoryFileSaveRequest = { params: { rel: string }; body?: { content?: string } };

export type MemoryInitResponse = { ok: true; files: MemoryFileInfo[] };

export interface MemoryProposal {
  id: string;
  status?: string;
  category?: string;
  section?: string;
  content?: string;
  source?: { label?: string; [key: string]: unknown } | null;
  runId?: string | null;
  version?: number;
  [key: string]: unknown;
}

export type MemoryProposalListRequest = {
  query?: { workspace?: string; status?: string; projectId?: string; category?: string; client?: string; thread?: string };
};
export type MemoryProposalListResponse = { proposals: MemoryProposal[] };

export type MemoryProposalApproveRequest = {
  params: { id: string };
  body?: { content?: string; category?: string; section?: string; reviewer?: string };
};
export type MemoryProposalEditRequest = {
  params: { id: string };
  body?: { content?: string; category?: string; section?: string };
};
export type MemoryProposalRejectRequest = { params: { id: string }; body?: { reason?: string } };
export type MemoryProposalHistoryRequest = { params: { id: string } };
export type MemoryProposalMergeRequest = { params: { id: string }; body?: { sourceIds?: string[] } };

/** 审批类操作结果（sendMemoryResult 直传 agentManager 结果，失败时调用方走 ApiError）。 */
export type MemoryProposalOpResult = { ok: boolean; [key: string]: unknown };

export interface MemoryProposalHistoryItem {
  version?: number;
  action?: string;
  at?: string;
  [key: string]: unknown;
}

export type MemoryProposalHistoryResponse = {
  ok?: boolean;
  id?: string;
  history?: MemoryProposalHistoryItem[];
  [key: string]: unknown;
};

// ---- 文件族（F3 批5b-2；批7b 增列表） ----

export type FileListRequest = { query?: { dir?: string; workspace?: string } };
export type FileListResponse = {
  files?: Array<Record<string, unknown>>;
  dir?: string;
  workspace?: string;
  [key: string]: unknown;
};
export type FileSearchRequest = { query: { q: string; limit: number; workspace?: string } };
export type FileSearchResponse = {
  workspace?: string;
  files?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};
export type FileUploadRequest = { body: { name: string; base64: string; workspace?: string } };
export type FileDeleteRequest = { body: { name: string; workspace?: string } };

// ---- 文档预览族（F4-3：读路由；identity 形状见 renderer/lib/file-urls.ts FileIdentity） ----

/** 文件身份（与 file-urls.ts FileIdentity 同构，shared 层不反向依赖 renderer）： */
export type DocFileIdentity = {
  workspaceId?: string;
  cwd?: string;
  relativePath?: string;
  revision?: string;
  [key: string]: unknown;
};

/** doc 域查询参数族：cwd=预览工作区（显式携带则经 normalizeWorkspace 校验）。 */
export type DocQuery = { cwd?: string; client?: string; thread?: string; [key: string]: unknown };

export type DocOpenRequest = { params: { name: string }; query?: DocQuery };
export type DocOpenResponse = {
  kind?: string;
  name?: string;
  ext?: string;
  content?: string;
  identity?: DocFileIdentity;
  url?: string;
  sheets?: unknown;
  grids?: Record<string, unknown>;
  [key: string]: unknown;
};
/** raw 原始字节：HTTP 形态为流式 sendFile + 身份响应头；IPC 形态为 base64 + mime（架构性等价替换）。 */
export type DocRawRequest = { params: { name: string }; query?: DocQuery };
export type DocRawResponse = { base64: string; mime: string; identity?: DocFileIdentity; [key: string]: unknown };
export type DocTextRequest = { params: { name: string }; query?: DocQuery };
export type DocTextResponse = { name?: string; text?: string; identity?: DocFileIdentity; [key: string]: unknown };
/** 渲染 HTML：HTTP 形态为 text/html 响应体；IPC 形态为字符串（含注入的身份 postMessage 脚本）。 */
export type DocHtmlRequest = { params: { name: string }; query?: DocQuery };
export type DocHtmlResponse = { html: string; identity?: DocFileIdentity; [key: string]: unknown };
export type DocCommentsRequest = { params: { name: string }; query?: DocQuery };
export type DocCommentsResponse = { comments?: Array<Record<string, unknown>>; identity?: DocFileIdentity; [key: string]: unknown };
export type DocOutlineRequest = { params: { name: string }; query?: DocQuery };
export type DocOutlineResponse = { outline?: Array<{ level: number; text: string; path?: string }>; identity?: DocFileIdentity; [key: string]: unknown };
export type DocAnnotationsRequest = { params: { name: string }; query?: DocQuery };
export type DocAnnotationsResponse = { annotations?: Array<Record<string, unknown>>; identity?: DocFileIdentity; [key: string]: unknown };

// ---- 文档写路由族（F4-4：POST 通道直调；行号锚点均指 server/index.mjs） ----

/** 划词标注保存（POST /api/doc/:name/annotations，L537-549）：body.annotations 数组整体落盘。 */
export type DocAnnotationsSaveRequest = { params: { name: string }; query?: DocQuery; body: { annotations: unknown[] } };
export type DocAnnotationsSaveResponse = { ok?: boolean; workspace?: string; path?: string; status?: string; size?: number; count?: number; identity?: DocFileIdentity; [key: string]: unknown };

/** docx 重打包保存（POST /api/doc/:name/raw-save，L1334-1352）：base64 解码后带 PK 头校验写回。 */
export type DocRawSaveRequest = { params: { name: string }; query?: DocQuery; body: { base64: string } };
export type DocRawSaveResponse = { ok?: boolean; workspace?: string; path?: string; status?: string; size?: number; identity?: DocFileIdentity; [key: string]: unknown };

/** Excel 单元格保存（POST /api/doc/:name/cells，L1242-1262）：ref → batch set 命令。 */
export type DocCellsRequest = { params: { name: string }; body: { sheet: string; cells: Array<{ ref: string; value: unknown }> } };
export type DocCellsResponse = { ok?: boolean; result?: unknown; [key: string]: unknown };

/** docx 富文本编辑代理（POST /api/doc/edit，L1303-1331）：props 全值 String 归一后 batch。 */
export type DocEditRequest = { body: { file: string; commands: Array<Record<string, unknown>> } };
export type DocEditResponse = { ok?: boolean; result?: unknown; [key: string]: unknown };

/** officecli 通用直通（POST /api/office，L1265-1298）：白名单命令 + mutating 写锁。
 * HTTP 形态响应含 requestId；IPC 信封无对应（语义差异在直调器模块头声明）。 */
export type OfficeRunRequest = { body: { args: unknown[] } };
export type OfficeRunResponse = { ok?: boolean; code?: number; stdout?: string; stderr?: string; json?: unknown; [key: string]: unknown };

/** 实时预览 watch（GET /api/doc/:name/watch，L1218-1230）：HTTP 形态启动 officecli watch
 * 子进程返回渲染服务 URL；IPC 形态为 fs.watchFile 变化检测 + op:doc-watch 事件推送
 * （CSP 'self' 禁止 http iframe + 桌面端禁 HTTP 通道原则），响应不含 url/port。 */
export type DocWatchRequest = { params: { name: string }; query?: DocQuery };
export type DocWatchResponse = { ok?: boolean; identity?: DocFileIdentity; [key: string]: unknown };
export type DocWatchStopRequest = { params: { name: string }; query?: DocQuery };
export type DocWatchStopResponse = { ok?: boolean; [key: string]: unknown };

// ---- 知识库族 ----

export type KbIngestRequest = { body: { name: string } };
export type KbIngestResponse = { ok?: boolean; mdName?: string; error?: string; [key: string]: unknown };
/** F5-4 知识库域 12 条（server L359-467）。查询参数以字符串透传，直调器内 parseInt/isNaN 归一。 */
export type KbStatusRequest = Record<string, never>;
/** 根目录元信息（backend/kb.ts status()：cfg.roots 逐项投影，index=数组下标）。 */
export type KbRootMeta = { index: number; path: string; name: string; exists: boolean };
export type KbStatusResponse = { fileCount?: number; roots?: KbRootMeta[]; [key: string]: unknown };
export type KbRootsAddRequest = { body?: { path?: unknown } };
export type KbRootsAddResponse = { ok: true; roots: string[]; fileCount: number };
export type KbRootsRemoveRequest = { body?: { path?: unknown } };
export type KbRootsRemoveResponse = { ok: boolean; roots: string[] };
export type KbTreeRequest = { query?: { root?: string; dir?: string } };
export type KbTreeResponse = { dirs: unknown[]; files: unknown[] };
export type KbSearchRequest = { query?: { q?: string; root?: string; limit?: string } };
export type KbSearchResponse = { results: unknown[] };
export type KbGraphRequest = { query?: { root?: string; include?: string; max?: string } };
export type KbGraphResponse = Record<string, unknown>;
export type KbDocRequest = { query?: { path?: string; root?: string } };
export type KbDocResponse = Record<string, unknown>;
export type KbImaSearchRequest = { query?: { q?: string; kb?: string } };
export type KbImaDocRequest = { query?: { media_id?: string } };
export type KbExportDocxRequest = { body?: { relPath?: unknown; rootIdx?: unknown } };
export type KbExportDocxResponse = { ok?: boolean; name?: string; error?: string; [key: string]: unknown };

// ---- 技能 / 工作流 / 智能体 / 集成 / 模版库族（F6-1，对齐 server/index.mjs L2525-2737 / L414-443 / L552-586 实际结构） ----

export interface SkillCatalogItem {
  name: string;
  description?: string;
  category?: string;
  source?: string;
  path?: string;
  [key: string]: unknown;
}
export type SkillsListRequest = Record<string, never>;
export type SkillsListResponse = { skills: SkillCatalogItem[] };
export type SkillsExportRequest = { body: { name: string } };
export type SkillsExportResponse = {
  ok?: boolean;
  skill?: { name: string; description?: string; content: string; extra: Record<string, string> };
  error?: string;
};
export type SkillsImportRequest = { body: { name: string; description?: string; content: string; extra?: Record<string, string> } };
export type SkillsImportResponse = { ok: true; name: string } | { ok?: false; error: string };

export interface WorkflowStageRecord {
  id?: string;
  title?: string;
  tools?: string[];
  [key: string]: unknown;
}
export interface DomainWorkflowArtifact {
  id: string;
  title?: string;
  kind?: string;
  required?: boolean;
  [key: string]: unknown;
}
export interface DomainWorkflowRecord {
  id: string;
  title?: string;
  description?: string;
  budget?: { maxTurns?: number; maxToolCalls?: number; maxWallMs?: number; [key: string]: unknown };
  preflight?: string[];
  stages?: WorkflowStageRecord[];
  tools?: string[];
  artifacts?: DomainWorkflowArtifact[];
  [key: string]: unknown;
}
export interface WorkflowViewRecord {
  id?: string;
  name?: string;
  description?: string;
  icon?: string;
  skills?: string[];
  prompt?: string;
  steps?: string[];
  missing?: string[];
  valid?: boolean;
  [key: string]: unknown;
}
export type WorkflowsListRequest = Record<string, never>;
export type WorkflowsListResponse = {
  workflows: WorkflowViewRecord[];
  domain?: DomainWorkflowRecord[];
  domainError?: string;
};
export type WorkflowsValidateRequest = { params: { id: string } };
export type WorkflowsValidateResponse = {
  ok: boolean;
  workflow?: WorkflowViewRecord;
  message?: string;
  error?: string;
};
export type WorkflowsPreflightRequest = {
  body: {
    workflowId: string;
    坐标点?: unknown;
    记录数?: unknown;
    写回?: unknown;
    产物路径?: string;
    跳过校验?: boolean;
  }
};
export type WorkflowsPreflightResponse = {
  ok: boolean;
  workflow?: { id: string; title?: string };
  预检?: Record<string, unknown>;
  error?: string;
};

export interface AgentRecord {
  id: string;
  name?: string;
  icon?: string;
  description?: string;
  desc?: string;
  skills?: string[];
  inputs?: string[];
  outputs?: string[];
  prompt?: string;
  color?: string;
  builtin?: boolean;
  [key: string]: unknown;
}
export type AgentsListRequest = Record<string, never>;
export type AgentsListResponse = { agents: AgentRecord[] };
export type AgentsCreateRequest = { body?: Record<string, unknown> };
export type AgentsMutationResponse = { ok: boolean; agent?: AgentRecord; error?: string; id?: string };
export type AgentsUpdateRequest = { params: { id: string }; body?: Record<string, unknown> };
export type AgentsDeleteRequest = { params: { id: string } };

export interface McpToolRecord {
  name: string;
  description?: string;
  annotations?: { readOnlyHint?: boolean; [key: string]: unknown };
  [key: string]: unknown;
}
export interface McpServerRecord {
  id: string;
  name?: string;
  transport?: string;
  command?: string;
  argsCount?: number;
  endpoint?: string;
  enabled?: boolean;
  tools?: McpToolRecord[];
  envKeys?: string[];
  headerNames?: string[];
  lastTest?: { ok?: boolean; error?: string; serverInfo?: string; [key: string]: unknown } | null;
  [key: string]: unknown;
}
export type IntegrationsMcpListRequest = Record<string, never>;
export type IntegrationsMcpListResponse = { servers: McpServerRecord[] };
export type IntegrationsMcpSaveRequest = { body?: Record<string, unknown> };
export type IntegrationsMcpSaveResponse = { server: McpServerRecord } | { error: string };
export type IntegrationsMcpUpdateRequest = { params: { id: string }; body?: Record<string, unknown> };
export type IntegrationsMcpUpdateResponse = { server: McpServerRecord } | { error: string };
export type IntegrationsMcpDeleteRequest = { params: { id: string } };
export type IntegrationsMcpDeleteResponse = { ok: true } | { error: string };
export type IntegrationsMcpTestRequest = { params: { id: string } };
export type IntegrationsMcpTestResponse = { ok: boolean; server?: McpServerRecord; error?: string; [key: string]: unknown };

export interface PiExtensionRecord {
  id: string;
  name?: string;
  path?: string;
  enabled?: boolean;
  exists?: boolean;
  files?: string[];
  lastCheck?: { message?: string; [key: string]: unknown } | null;
  [key: string]: unknown;
}
export type IntegrationsPiListRequest = Record<string, never>;
export type IntegrationsPiListResponse = { extensions: PiExtensionRecord[] };
export type IntegrationsPiCatalogRequest = { query: { q?: string; page?: number | string } };
export type IntegrationsPiCatalogResponse = {
  items?: Array<{
    name: string;
    version?: string;
    description?: string;
    publisher?: string;
    keywords?: string[];
    installed?: boolean;
    installedVersion?: string;
    hasExtensions?: boolean;
    galleryUrl?: string;
    npmUrl?: string;
    repositoryUrl?: string;
    [key: string]: unknown;
  }>;
  total?: number;
  page?: number;
  error?: string;
};
export type IntegrationsPiFromPackageRequest = { body: { name: string } };
export type IntegrationsPiAddRequest = { body?: Record<string, unknown> };
export type IntegrationsPiMutationResponse = { extension: PiExtensionRecord } | { error: string };
export type IntegrationsPiUpdateRequest = { params: { id: string }; body?: Record<string, unknown> };
export type IntegrationsPiCheckRequest = { params: { id: string } };
export type IntegrationsPiCheckResponse = { extension: PiExtensionRecord } | { error: string };
export type IntegrationsPiDeleteRequest = { params: { id: string } };
export type IntegrationsPiDeleteResponse = { ok: true } | { error: string };

export interface TemplateCategory {
  id: string;
  name: string;
  icon: string;
}
export interface TemplateItem {
  id: string;
  title: string;
  name?: string;
  ext: string;
  type?: string;
  category?: string;
  relPath?: string;
  size?: number;
  [key: string]: unknown;
}
export type TemplatesListRequest = { query?: { category?: string } };
export type TemplatesListResponse = { categories: TemplateCategory[]; items: TemplateItem[]; total: number };
export type TemplatesContentRequest = { query: { path: string } };
export type TemplatesContentResponse = {
  type: string;
  content?: string;
  ext?: string;
  size?: number;
  relPath?: string;
  error?: string;
};
export type TemplatesGenerateNoticeRequest = { body?: Record<string, unknown> };
export type TemplatesGenerateNoticeResponse = { ok: true; name: string } | { ok?: false; error: string };
/** 模板文件流通道响应：base64 + mime（旧路由 res.setHeader(Content-Type)+sendFile 的 IPC 等价）。 */
export type TemplatesFileRequest = { params: { path: string } };
export type TemplatesFileResponse = { mime: string; base64: string } | { error: string };

// ---- 内置浏览器族（F6-2；响应结构与 server/index.mjs L2084-2305 逐点对齐） ----

/** 浏览器会话状态视图（session.stateView() 或无会话时的 inactive 默认，server L2089/L2244 同款）。 */
export interface BrowserStateView {
  active: boolean;
  url: string;
  title: string;
  loading: boolean;
  hasFrame?: boolean;
  error?: string;
  viewport?: { width: number; height: number };
  frameSize?: { width: number; height: number };
  ownership?: { owner: string; reason: string; leaseExpiresAt: number; secondsRemaining: number } | null;
  [key: string]: unknown;
}

export const BROWSER_INACTIVE_STATE: BrowserStateView = {
  active: false,
  url: "",
  title: "",
  loading: false,
  hasFrame: false,
  ownership: { owner: "agent", reason: "", leaseExpiresAt: 0, secondsRemaining: 0 }
};

export type BrowserStateRequest = { query: { client: string; thread?: string } };
export type BrowserStateResponse = { ok: true; state: BrowserStateView };
export type BrowserOpenRequest = { body: { client: string; thread?: string; url?: string } };
export type BrowserOpenResponse = { ok: true; state: BrowserStateView } | { ok: false; error: string; code?: string | null };
export type BrowserStreamPauseRequest = { body: { client?: string; thread?: string; paused?: boolean } };
export type BrowserStreamPauseResponse = { ok: true } | { ok: false; error: string };
export type BrowserCaptureRequest = { body: { client?: string; thread?: string } };
/** 整页截图 / PDF：file/base64/bytes/url（server L2122/L2134 同款字段面）。 */
export type BrowserCaptureResponse =
  | { ok: true; file: string; base64: string; bytes: number; url: string }
  | { ok: false; error: string; code?: string | null };
/** input 通道：body 除 client/thread 外整体透传 browserUserInput（action/nx/ny/key/text/... 宽类型）。 */
export type BrowserInputRequest = { body: { client?: string; thread?: string } & Record<string, unknown> };
export type BrowserInputResponse = { ok: true; result: unknown } | { ok: false; error: string; code?: string | null };
export type BrowserCloseRequest = { body: { client?: string; thread?: string; force?: boolean; reason?: string } };
export type BrowserCloseResponse = { ok: true; [key: string]: unknown } | { ok: false; error: string };
export type BrowserResetRequest = { body: { client?: string; thread?: string } };
export type BrowserResetResponse = { ok: true; [key: string]: unknown } | { ok: false; error: string };

// ---- 模型族 ----

export type ModelsListRequest = Record<string, never>;
export type ModelsListResponse = { models?: Array<Record<string, unknown>>; [key: string]: unknown };

// ---- Agent 配置族（SettingsPanel；响应宽类型，F3 消费时按需收紧） ----

export type AgentAuthSaveRequest = { body: { provider: string; key: string } };
export type AgentAuthRemoveRequest = { body: { provider: string } };
export type AgentPlansModelsRequest = { query: { planId: string } };
export type AgentPlansApplyRequest = { body?: Record<string, unknown> };
export type AgentPlansDisconnectRequest = { body: { planId: string } };
export type AgentCustomProviderRequest = { body?: Record<string, unknown> };
export type AgentImportConfigRequest = { body?: Record<string, unknown> };
export type AgentDiagnosticsRequest = { query?: { client?: string; thread?: string; runId?: string } };
export type AgentNetworkSettingsSaveRequest = { body?: Record<string, unknown> };
export type AgentModelConfigSaveRequest = { body?: Record<string, unknown> };
export type AgentModelConfigDeleteRequest = { params: { provider: string } };
export type AgentModelConfigFetchModelsRequest = { body?: Record<string, unknown> };
export type AgentDefaultModelSetRequest = { body: { provider: string; model: string } };
export type AgentModelProbeRequest = { body: { model: unknown; timeoutMs: number } };
export type AgentPermissionRuleRemoveRequest = { body: Record<string, unknown> };
export type AgentProviderCatalogDetailRequest = { params: { id: string } };
export type AgentProviderCatalogImportRequest = { body?: Record<string, unknown> };

// ---- 联网搜索配置族 ----

export type SearchSettingsSaveRequest = { body?: Record<string, unknown> };
export type SearchSettingsTestRequest = { body: { backend: string; draft?: unknown } };

// ---- 地图设置族 ----

export type MapSettingsSaveRequest = { body: { basemaps: unknown } };

// ---- 地图域项目图层族（F5-1，对齐 server/index.mjs L615-796 / L5438-5506 实际结构） ----

export type MapProjectsListRequest = Record<string, never>;
export type MapProjectsListResponse = { projects?: Array<Record<string, unknown>> };
export type MapProjectsCreateRequest = { body?: { project?: unknown; name?: unknown; baseProject?: unknown } };
export type MapProjectsCreateResponse = {
  ok?: boolean;
  project?: unknown;
  config?: Record<string, unknown>;
  style?: Record<string, unknown>;
  files?: unknown[];
  error?: string;
  code?: string;
};
export type MapProjectGetRequest = { query?: { name?: string; workspace?: string } };
/** 项目详情 + layerViews 增补（归属视图失败时无该字段，server L639-643 静默语义）。 */
export type MapProjectGetResponse = Record<string, unknown>;
export type MapProjectExportRequest = { query?: { name?: string; tiles?: string | number } };
/** zip 二进制流式响应 → buffer base64 载数据（HTTP Content-Disposition/X-Pack-Manifest 头语义内联承载）。 */
export type MapProjectExportResponse = {
  ok?: boolean;
  fileName?: string;
  manifest?: { project?: unknown; files?: number; bytes?: number };
  buffer?: string;
  error?: string;
  code?: string;
};
export type MapProjectsDuplicateRequest = { body?: { project?: unknown; name?: unknown } };
export type MapProjectsRenameRequest = { body?: { project?: unknown; name?: unknown } };
export type MapProjectsArchiveRequest = { body?: { project?: unknown; archived?: boolean } };
export type MapProjectsDeleteRequest = { body?: { project?: unknown } };
export type MapProjectsLifecycleResponse = {
  ok?: boolean;
  project?: unknown;
  config?: Record<string, unknown>;
  error?: string;
  code?: string;
};
export type MapStyleSaveRequest = { body?: { name?: string; style?: unknown } };
export type MapConfigSaveRequest = { body?: { name?: string; config?: unknown } };
export type MapOkResponse = { ok?: boolean; error?: string };
export type MapImportRequest = { body?: { name?: string; layerId?: string; geojson?: unknown } };
export type MapImportBatchRequest = { body?: { name?: string; items?: unknown[] } };
export type MapPrepareRequest = { body?: { srcDir?: string } };
export type MapPrepareResponse = { ok?: boolean; prepare?: string; tiles?: string; error?: string };
export type MapRebuildRequest = { body?: { name?: string; layerIds?: string[] | null } };
export type MapRebuildResponse = { ok?: boolean; layers?: unknown; error?: string };
export type MapLayerDeleteRequest = { body?: { name?: string; layerId?: string } };
export type MapLayerGetRequest = { query?: { name?: string; layer?: string } };
/** F5-5：style.json 动态读（server L592 正则路由 :project 单段参数）。 */
export type MapDataStyleRequest = { query?: { project?: string } };
/** style 动态响应 → JSON 文本载数据（旧版 fetch text → styleHash 消费形态不变）。 */
export type MapDataStyleResponse = { text?: string; error?: string };
export type MapIsochroneRequest = { body?: { location?: string; mode?: string; range?: number; rangeType?: string } };
export type MapIsochroneResponse = { ok?: boolean; center?: unknown; cost?: unknown; polygons?: unknown; error?: string };
export type MapRouteRequest = { body?: { from?: string; to?: string; mode?: string; provider?: string } };
export type MapRouteResponse = {
  ok?: boolean;
  provider?: string;
  distance?: number;
  duration?: number;
  geometry?: unknown;
  error?: string;
};
export type MapProjectNamedRequest = { params: { name: string } };
export type MapProjectLayerNamedRequest = { params: { name: string; layerId: string } };
export type MapProjectStyleSaveRequest = { params: { name: string }; body?: { style?: unknown } };
export type MapProjectConfigSaveRequest = { params: { name: string }; body?: { config?: unknown } };
export type MapProjectImportRequest = { params: { name: string }; body?: { layerId?: string; geojson?: unknown } };
export type MapProjectRebuildTilesRequest = { params: { name: string } };
export type MapProjectRebuildTilesResponse = { ok?: boolean; results?: unknown; error?: string };
export type MapProjectIsochroneRequest = { params: { name: string }; body?: Record<string, unknown> };

// ---- 地图域分析可视化族（F5-2，对齐 server/index.mjs L5194-5254 / L5508-5585 / L799-825 实际结构） ----

export type MapVisualSourcesRequest = Record<string, never>;
export type MapVisualSourcesResponse = { sources?: Array<Record<string, unknown>>; planned?: unknown[] };
/** dataset 分发入参（server L5202-5215：minFlow 取自 query.threshold）。 */
export type MapVisualGetRequest = {
  query?: {
    dataset?: string;
    kind?: string;
    path?: string;
    measure?: string;
    project?: string;
    threshold?: string | number;
    region?: string;
    workspace?: string;
    url?: string;
    db?: string;
    sql?: string;
  };
};
export type MapVisualGetResponse = { descriptor?: Record<string, unknown>; error?: string; available?: string[] };
/** M2 分析四路由（traffic-bandwidth/od-lines/exchange-sankey/road-structure）：载荷整体透传。 */
export type MapAnalysisQueryRequest = { query?: { project?: string } };
export type MapMultiIsochroneRequest = { body?: { location?: unknown; mode?: string; ranges?: unknown; rangeType?: string } };
/** 生效段 L799-803：query 原始透传（默认值由域内补齐）。 */
export type MapDemoAnalysisRequest = { query?: { analysis?: string; region?: string; project?: string; count?: string | number } };
export type MapCambodiaOdRequest = { query?: { minFlow?: string | number } };
export type MapM3Request = Record<string, never>;
/** F5-3 报告导出模板族（GIS G8/G7/G5-v1，server L5259-5401）。 */
export type MapReportRequest = { body?: { workspace?: string; project?: unknown; title?: unknown; sections?: unknown; images?: unknown; fileName?: unknown } };
export type MapReportResponse = { ok: true; file: string; fileName: string; blocks: number; images: number };
export type MapExportBatchStartRequest = { body?: { workspace?: string; projects?: unknown; layerSets?: unknown; sizes?: unknown; formats?: unknown; title?: unknown } };
export type MapExportBatchStartResponse = { ok: true; batchId: string; total: number; skipped: unknown; jobs: Array<Record<string, unknown>> };
export type MapExportBatchStatusRequest = { query?: { id?: string } };
export type MapExportBatchStatusResponse = { ok: true; id: string; status: string; total: number; skipped: unknown; summary: unknown; error: string; createdAt: string; finishedAt: string };
export type MapTemplateOdCommuterRequest = { body?: { workspace?: string; path?: unknown; title?: unknown; bands?: unknown; project?: unknown; fileName?: unknown } };
export type MapTemplateOdCommuterResponse = { ok: true } & Record<string, unknown>;

// ---- 项目族 ----

export type ProjectListRequest = { query?: { type?: string; status?: string; sort?: string; pinned?: string } };
export type ProjectListResponse = {
  projects?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};
export type ProjectCreateRequest = { body?: Record<string, unknown> };
export type ProjectClassifyRequest = { body: { apply: boolean } };
export type ProjectUpdateRequest = { params: { id: string }; body?: Record<string, unknown> };
export type ProjectPinRequest = { params: { id: string }; body: { pinned: boolean } };
export type ProjectArchiveRequest = { params: { id: string }; body: { archived: boolean } };
export type ProjectSettingsUpdateRequest = { params: { id: string }; body?: Record<string, unknown> };

// ---- 工作区族 ----

export type WorkspaceListRequest = Record<string, never>;
export type WorkspaceListResponse = {
  workspaces?: Array<{ name?: string; path?: string }>;
  [key: string]: unknown;
};
export type WorkspaceSwitchRequest = { body: { path: string } };
export type WorkspaceSwitchResponse = {
  ok?: boolean;
  workspace?: string;
  files?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};
export type WorkspaceValidateRequest = { body: { path: string } };
export type WorkspacePickRequest = { body: Record<string, never> };
export type WorkspacePickCancelRequest = { body: Record<string, never> };

// ---- 外部目录（文件根）族 ----

export type FileRootsAddRequest = { body: { path: string; label?: string } };
export type FileRootsRemoveRequest = { params: { id: string } };
export type FileRootsResponse = { roots?: Array<Record<string, unknown>>; [key: string]: unknown };

// ---- 系统集成族 ----

export type SystemPickFilesRequest = { body?: Record<string, unknown> };
export type SystemOpenRequest = { body: { path: string } };
export type SystemRevealRequest = { body: { path: string } };

// ============================================================================
// 通道协议映射：通道名 → 请求/响应类型（renderer 与 main 共用）。
// ============================================================================

export interface DesktopChannelProtocol {
  "op:status:get": { request: StatusGetRequest; response: StatusInfo };

  "op:sessions:list": { request: SessionListRequest; response: SessionListResponse };
  "op:sessions:create": { request: SessionCreateRequest; response: SessionCreateResponse };
  "op:sessions:get": { request: SessionGetRequest; response: SessionGetResponse };
  "op:sessions:delete": { request: SessionDeleteRequest; response: SessionDeleteResponse };
  "op:sessions:batch-delete": { request: SessionBatchDeleteRequest; response: SessionBatchDeleteResponse };
  "op:sessions:rename": { request: SessionRenameRequest; response: SessionRenameResponse };
  "op:sessions:pin": { request: SessionPinRequest; response: SessionPinResponse };
  "op:sessions:freeze": { request: SessionFreezeRequest; response: SessionFreezeResponse };
  "op:sessions:fork": { request: SessionForkRequest; response: SessionForkResponse };

  "op:runs:list": { request: RunListRequest; response: RunListResponse };
  "op:runs:get": { request: RunGetRequest; response: RunGetResponse };
  "op:runs:cancel": { request: RunCancelRequest; response: RunCancelResponse };
  "op:runs:rollback": { request: RunRollbackRequest; response: RunRollbackResult };
  "op:runs:step": { request: RunStepRequest; response: RunStepResponse };
  "op:runs:resume": { request: RunResumeRetryRequest; response: RunContinuationResponse };
  "op:runs:retry": { request: RunResumeRetryRequest; response: RunContinuationResponse };
  "op:runs:artifacts:publish": { request: RunArtifactPublishRequest; response: ArtifactOpResult };
  "op:runs:artifacts:accept": { request: RunArtifactAcceptRequest; response: ArtifactOpResult };
  "op:runs:acceptance": { request: RunAcceptanceRequest; response: ArtifactOpResult };
  "op:runs:diff": { request: RunDiffRequest; response: RunDiffResponse };
  "op:artifacts:list": { request: ArtifactListRequest; response: ArtifactListResponse };
  "op:artifacts:rollback": { request: ArtifactRollbackRequest; response: ArtifactOpResult };

  "op:agent:prompt": { request: AgentPromptRequest; response: PromptAdmissionResponse };
  "op:agent:abort": { request: AgentAbortRequest; response: AgentAbortResponse };
  "op:agent:model:set": { request: AgentModelSetRequest; response: AgentModelSetResponse };
  "op:agent:runtime": { request: AgentRuntimeRequest; response: AgentRuntimeResponse };
  "op:agent:compact": { request: AgentCompactRequest; response: AgentCompactResponse };
  "op:agent:new": { request: AgentNewRequest; response: AgentThreadResponse };
  "op:agent:resume": { request: AgentResumeRequest; response: AgentThreadResponse };
  "op:agent:pending": { request: AgentPendingRequest; response: AgentPendingResponse };
  "op:agent:answer": { request: AgentAnswerRequest; response: AgentAnswerResponse };
  "op:agent:approvals": { request: Record<string, never>; response: AgentApprovalsResponse };
  "op:agent:approval": { request: AgentApprovalRequest; response: AgentApprovalResponse };
  "op:agent:approval-mode:get": { request: Record<string, never>; response: AgentApprovalModeGetResponse };
  "op:agent:approval-mode:set": { request: AgentApprovalModeSetRequest; response: AgentApprovalModeSetResponse };
  "op:agent:stream-close": { request: AgentStreamCloseRequest; response: AgentStreamCloseResponse };
  "op:agent:session-tree": { request: AgentSessionTreeRequest; response: AgentSessionTreeResponse };
  "op:agent:session-branch": { request: AgentSessionBranchRequest; response: AgentSessionBranchResponse };

  "op:agent:events-state": { request: AgentEventsStateRequest; response: AgentEventsStateResponse };
  "op:agent:events-read": { request: AgentEventsReadRequest; response: AgentEventsReadResponse };

  "op:memory:list": { request: Record<string, never>; response: MemoryListResponse };
  "op:memory:init": { request: Record<string, never>; response: MemoryInitResponse };
  "op:memory:file:get": { request: { params: { rel: string } }; response: MemoryFileGetResponse };
  "op:memory:file:save": { request: MemoryFileSaveRequest; response: Record<string, unknown> };
  "op:memory:proposals:list": { request: MemoryProposalListRequest; response: MemoryProposalListResponse };
  "op:memory:proposals:approve": { request: MemoryProposalApproveRequest; response: MemoryProposalOpResult };
  "op:memory:proposals:edit": { request: MemoryProposalEditRequest; response: MemoryProposalOpResult };
  "op:memory:proposals:reject": { request: MemoryProposalRejectRequest; response: MemoryProposalOpResult };
  "op:memory:proposals:history": { request: MemoryProposalHistoryRequest; response: MemoryProposalHistoryResponse };
  "op:memory:proposals:merge": { request: MemoryProposalMergeRequest; response: MemoryProposalOpResult };

  "op:files:list": { request: FileListRequest; response: FileListResponse };
  "op:files:search": { request: FileSearchRequest; response: FileSearchResponse };
  "op:files:upload": { request: FileUploadRequest; response: Record<string, unknown> };
  "op:files:delete": { request: FileDeleteRequest; response: Record<string, unknown> };

  "op:doc:open": { request: DocOpenRequest; response: DocOpenResponse };
  "op:doc:raw": { request: DocRawRequest; response: DocRawResponse };
  "op:doc:text": { request: DocTextRequest; response: DocTextResponse };
  "op:doc:html": { request: DocHtmlRequest; response: DocHtmlResponse };
  "op:doc:comments": { request: DocCommentsRequest; response: DocCommentsResponse };
  "op:doc:outline": { request: DocOutlineRequest; response: DocOutlineResponse };
  "op:doc:annotations": { request: DocAnnotationsRequest; response: DocAnnotationsResponse };
  "op:doc:annotations-save": { request: DocAnnotationsSaveRequest; response: DocAnnotationsSaveResponse };
  "op:doc:raw-save": { request: DocRawSaveRequest; response: DocRawSaveResponse };
  "op:doc:cells": { request: DocCellsRequest; response: DocCellsResponse };
  "op:doc:edit": { request: DocEditRequest; response: DocEditResponse };
  "op:office:run": { request: OfficeRunRequest; response: OfficeRunResponse };
  "op:doc:watch": { request: DocWatchRequest; response: DocWatchResponse };
  "op:doc:watch-stop": { request: DocWatchStopRequest; response: DocWatchStopResponse };

  "op:kb:ingest": { request: KbIngestRequest; response: KbIngestResponse };
  "op:kb:status": { request: KbStatusRequest; response: KbStatusResponse };
  "op:kb:roots:add": { request: KbRootsAddRequest; response: KbRootsAddResponse };
  "op:kb:roots:remove": { request: KbRootsRemoveRequest; response: KbRootsRemoveResponse };
  "op:kb:tree": { request: KbTreeRequest; response: KbTreeResponse };
  "op:kb:search": { request: KbSearchRequest; response: KbSearchResponse };
  "op:kb:graph": { request: KbGraphRequest; response: KbGraphResponse };
  "op:kb:doc": { request: KbDocRequest; response: KbDocResponse };
  "op:kb:ima:status": { request: Record<string, never>; response: Record<string, unknown> };
  "op:kb:ima:bases": { request: Record<string, never>; response: Record<string, unknown> };
  "op:kb:ima:search": { request: KbImaSearchRequest; response: Record<string, unknown> };
  "op:kb:ima:doc": { request: KbImaDocRequest; response: Record<string, unknown> };
  "op:kb:export-docx": { request: KbExportDocxRequest; response: KbExportDocxResponse };

  // ---- 技能 / 工作流 / 智能体 / 集成 / 模版库族（F6-1） ----
  "op:skills:list": { request: SkillsListRequest; response: SkillsListResponse };
  "op:skills:export": { request: SkillsExportRequest; response: SkillsExportResponse };
  "op:skills:import": { request: SkillsImportRequest; response: SkillsImportResponse };
  "op:workflows:list": { request: WorkflowsListRequest; response: WorkflowsListResponse };
  "op:workflows:validate": { request: WorkflowsValidateRequest; response: WorkflowsValidateResponse };
  "op:workflows:preflight": { request: WorkflowsPreflightRequest; response: WorkflowsPreflightResponse };
  "op:agents:list": { request: AgentsListRequest; response: AgentsListResponse };
  "op:agents:create": { request: AgentsCreateRequest; response: AgentsMutationResponse };
  "op:agents:update": { request: AgentsUpdateRequest; response: AgentsMutationResponse };
  "op:agents:delete": { request: AgentsDeleteRequest; response: AgentsMutationResponse };
  "op:integrations:mcp:list": { request: IntegrationsMcpListRequest; response: IntegrationsMcpListResponse };
  "op:integrations:mcp:save": { request: IntegrationsMcpSaveRequest; response: IntegrationsMcpSaveResponse };
  "op:integrations:mcp:update": { request: IntegrationsMcpUpdateRequest; response: IntegrationsMcpUpdateResponse };
  "op:integrations:mcp:delete": { request: IntegrationsMcpDeleteRequest; response: IntegrationsMcpDeleteResponse };
  "op:integrations:mcp:test": { request: IntegrationsMcpTestRequest; response: IntegrationsMcpTestResponse };
  "op:integrations:pi:list": { request: IntegrationsPiListRequest; response: IntegrationsPiListResponse };
  "op:integrations:pi:catalog": { request: IntegrationsPiCatalogRequest; response: IntegrationsPiCatalogResponse };
  "op:integrations:pi:from-package": { request: IntegrationsPiFromPackageRequest; response: IntegrationsPiMutationResponse };
  "op:integrations:pi:add": { request: IntegrationsPiAddRequest; response: IntegrationsPiMutationResponse };
  "op:integrations:pi:update": { request: IntegrationsPiUpdateRequest; response: IntegrationsPiMutationResponse };
  "op:integrations:pi:check": { request: IntegrationsPiCheckRequest; response: IntegrationsPiCheckResponse };
  "op:integrations:pi:delete": { request: IntegrationsPiDeleteRequest; response: IntegrationsPiDeleteResponse };
  "op:templates:list": { request: TemplatesListRequest; response: TemplatesListResponse };
  "op:templates:content": { request: TemplatesContentRequest; response: TemplatesContentResponse };
  "op:templates:generate-notice": { request: TemplatesGenerateNoticeRequest; response: TemplatesGenerateNoticeResponse };
  "op:templates:file": { request: TemplatesFileRequest; response: TemplatesFileResponse };
  "op:templates:files": { request: TemplatesFileRequest; response: TemplatesFileResponse };

  // ---- 内置浏览器族（F6-2） ----
  "op:browser:state": { request: BrowserStateRequest; response: BrowserStateResponse };
  "op:browser:open": { request: BrowserOpenRequest; response: BrowserOpenResponse };
  "op:browser:stream-pause": { request: BrowserStreamPauseRequest; response: BrowserStreamPauseResponse };
  "op:browser:fullpage": { request: BrowserCaptureRequest; response: BrowserCaptureResponse };
  "op:browser:pdf": { request: BrowserCaptureRequest; response: BrowserCaptureResponse };
  "op:browser:input": { request: BrowserInputRequest; response: BrowserInputResponse };
  "op:browser:close": { request: BrowserCloseRequest; response: BrowserCloseResponse };
  "op:browser:reset": { request: BrowserResetRequest; response: BrowserResetResponse };

  "op:models:list": { request: ModelsListRequest; response: ModelsListResponse };
  "op:models:refresh": { request: Record<string, never>; response: Record<string, unknown> };

  "op:agent:auth:get": { request: Record<string, never>; response: Record<string, unknown> };
  "op:agent:auth:save": { request: AgentAuthSaveRequest; response: Record<string, unknown> };
  "op:agent:auth:remove": { request: AgentAuthRemoveRequest; response: Record<string, unknown> };
  "op:agent:plans": { request: Record<string, never>; response: Record<string, unknown> };
  "op:agent:plans:models": { request: AgentPlansModelsRequest; response: Record<string, unknown> };
  "op:agent:plans:apply": { request: AgentPlansApplyRequest; response: Record<string, unknown> };
  "op:agent:plans:disconnect": { request: AgentPlansDisconnectRequest; response: Record<string, unknown> };
  "op:agent:custom-provider": { request: AgentCustomProviderRequest; response: Record<string, unknown> };
  "op:agent:config-status": { request: Record<string, never>; response: Record<string, unknown> };
  "op:agent:import-preview": { request: Record<string, never>; response: Record<string, unknown> };
  "op:agent:import-config": { request: AgentImportConfigRequest; response: Record<string, unknown> };
  "op:agent:diagnostics": { request: AgentDiagnosticsRequest; response: Record<string, unknown> };
  "op:agent:network-settings:get": { request: Record<string, never>; response: Record<string, unknown> };
  "op:agent:network-settings:save": { request: AgentNetworkSettingsSaveRequest; response: Record<string, unknown> };
  "op:agent:model-configs:list": { request: Record<string, never>; response: Record<string, unknown> };
  "op:agent:model-configs:save": { request: AgentModelConfigSaveRequest; response: Record<string, unknown> };
  "op:agent:model-configs:delete": { request: AgentModelConfigDeleteRequest; response: Record<string, unknown> };
  "op:agent:model-configs:fetch-models": { request: AgentModelConfigFetchModelsRequest; response: Record<string, unknown> };
  "op:agent:provider-catalog": { request: Record<string, never>; response: Record<string, unknown> };
  "op:agent:provider-catalog:detail": { request: AgentProviderCatalogDetailRequest; response: Record<string, unknown> };
  "op:agent:provider-catalog:import": { request: AgentProviderCatalogImportRequest; response: Record<string, unknown> };
  "op:agent:provider-catalog:refresh": { request: Record<string, never>; response: Record<string, unknown> };
  "op:agent:default-model:set": { request: AgentDefaultModelSetRequest; response: Record<string, unknown> };
  "op:agent:model:probe": { request: AgentModelProbeRequest; response: Record<string, unknown> };
  "op:agent:permissions:get": { request: Record<string, never>; response: Record<string, unknown> };
  "op:agent:permissions:rule:remove": { request: AgentPermissionRuleRemoveRequest; response: Record<string, unknown> };

  "op:search:settings:get": { request: Record<string, never>; response: Record<string, unknown> };
  "op:search:settings:save": { request: SearchSettingsSaveRequest; response: Record<string, unknown> };
  "op:search:test": { request: SearchSettingsTestRequest; response: Record<string, unknown> };

  "op:map:settings:get": { request: Record<string, never>; response: Record<string, unknown> };
  "op:map:settings:save": { request: MapSettingsSaveRequest; response: Record<string, unknown> };

  // ---- 地图域项目图层族（F5-1） ----
  "op:map:projects:list": { request: MapProjectsListRequest; response: MapProjectsListResponse };
  "op:map:projects:create": { request: MapProjectsCreateRequest; response: MapProjectsCreateResponse };
  "op:map:project:get": { request: MapProjectGetRequest; response: MapProjectGetResponse };
  "op:map:project:export": { request: MapProjectExportRequest; response: MapProjectExportResponse };
  "op:map:projects:duplicate": { request: MapProjectsDuplicateRequest; response: MapProjectsLifecycleResponse };
  "op:map:projects:rename": { request: MapProjectsRenameRequest; response: MapProjectsLifecycleResponse };
  "op:map:projects:archive": { request: MapProjectsArchiveRequest; response: MapProjectsLifecycleResponse };
  "op:map:projects:delete": { request: MapProjectsDeleteRequest; response: MapProjectsLifecycleResponse };
  "op:map:style:save": { request: MapStyleSaveRequest; response: MapOkResponse };
  "op:map:config:save": { request: MapConfigSaveRequest; response: MapOkResponse };
  "op:map:import": { request: MapImportRequest; response: Record<string, unknown> };
  "op:map:import:batch": { request: MapImportBatchRequest; response: Record<string, unknown> };
  "op:map:prepare": { request: MapPrepareRequest; response: MapPrepareResponse };
  "op:map:rebuild": { request: MapRebuildRequest; response: MapRebuildResponse };
  "op:map:layer:delete": { request: MapLayerDeleteRequest; response: Record<string, unknown> };
  "op:map:layer:get": { request: MapLayerGetRequest; response: Record<string, unknown> };
  "op:map:isochrone": { request: MapIsochroneRequest; response: MapIsochroneResponse };
  "op:map:route": { request: MapRouteRequest; response: MapRouteResponse };
  "op:map:project:detail": { request: MapProjectNamedRequest; response: Record<string, unknown> };
  "op:map:project:style:save": { request: MapProjectStyleSaveRequest; response: MapOkResponse };
  "op:map:project:config:save": { request: MapProjectConfigSaveRequest; response: MapOkResponse };
  "op:map:project:import": { request: MapProjectImportRequest; response: Record<string, unknown> };
  "op:map:project:rebuild-tiles": { request: MapProjectRebuildTilesRequest; response: MapProjectRebuildTilesResponse };
  "op:map:project:layer:get": { request: MapProjectLayerNamedRequest; response: Record<string, unknown> };
  "op:map:project:layer:delete": { request: MapProjectLayerNamedRequest; response: Record<string, unknown> };
  "op:map:project:isochrone": { request: MapProjectIsochroneRequest; response: Record<string, unknown> };
  // ---- 地图域 style.json 动态读通道（F5-5） ----
  "op:map:data:style": { request: MapDataStyleRequest; response: MapDataStyleResponse };

  // ---- 地图域分析可视化族（F5-2） ----
  "op:map:visual:sources": { request: MapVisualSourcesRequest; response: MapVisualSourcesResponse };
  "op:map:visual:get": { request: MapVisualGetRequest; response: MapVisualGetResponse };
  "op:map:traffic-bandwidth": { request: MapAnalysisQueryRequest; response: Record<string, unknown> };
  "op:map:od-lines": { request: MapAnalysisQueryRequest; response: Record<string, unknown> };
  "op:map:multi-isochrone": { request: MapMultiIsochroneRequest; response: Record<string, unknown> };
  "op:map:exchange-sankey": { request: MapAnalysisQueryRequest; response: Record<string, unknown> };
  "op:map:road-structure": { request: MapAnalysisQueryRequest; response: Record<string, unknown> };
  "op:map:demo-analysis": { request: MapDemoAnalysisRequest; response: Record<string, unknown> };
  "op:map:cambodia-od": { request: MapCambodiaOdRequest; response: Record<string, unknown> };
  "op:map:m3:bus-routes": { request: MapM3Request; response: Record<string, unknown> };
  "op:map:m3:station-heatmap": { request: MapM3Request; response: Record<string, unknown> };
  "op:map:m3:od-lines": { request: MapM3Request; response: Record<string, unknown> };
  "op:map:m3:network-stats": { request: MapM3Request; response: Record<string, unknown> };
  "op:map:report": { request: MapReportRequest; response: MapReportResponse };
  "op:map:export:batch:start": { request: MapExportBatchStartRequest; response: MapExportBatchStartResponse };
  "op:map:export:batch:status": { request: MapExportBatchStatusRequest; response: MapExportBatchStatusResponse };
  "op:map:template:od-commuter": { request: MapTemplateOdCommuterRequest; response: MapTemplateOdCommuterResponse };

  "op:projects:list": { request: ProjectListRequest; response: ProjectListResponse };
  "op:projects:create": { request: ProjectCreateRequest; response: Record<string, unknown> };
  "op:projects:classify": { request: ProjectClassifyRequest; response: Record<string, unknown> };
  "op:projects:update": { request: ProjectUpdateRequest; response: Record<string, unknown> };
  "op:projects:pin": { request: ProjectPinRequest; response: Record<string, unknown> };
  "op:projects:archive": { request: ProjectArchiveRequest; response: Record<string, unknown> };
  "op:projects:settings:update": { request: ProjectSettingsUpdateRequest; response: Record<string, unknown> };

  "op:workspaces:list": { request: WorkspaceListRequest; response: WorkspaceListResponse };
  "op:workspace:switch": { request: WorkspaceSwitchRequest; response: WorkspaceSwitchResponse };
  "op:workspace:validate": { request: WorkspaceValidateRequest; response: Record<string, unknown> };
  "op:workspace:pick": { request: WorkspacePickRequest; response: Record<string, unknown> };
  "op:workspace:pick:cancel": { request: WorkspacePickCancelRequest; response: Record<string, unknown> };

  "op:file-roots:list": { request: Record<string, never>; response: FileRootsResponse };
  "op:file-roots:add": { request: FileRootsAddRequest; response: Record<string, unknown> };
  "op:file-roots:remove": { request: FileRootsRemoveRequest; response: Record<string, unknown> };

  "op:system:pick-files": { request: SystemPickFilesRequest; response: Record<string, unknown> };
  "op:system:open": { request: SystemOpenRequest; response: Record<string, unknown> };
  "op:system:reveal": { request: SystemRevealRequest; response: Record<string, unknown> };
}

export type ChannelRequest<C extends DesktopChannelId> = DesktopChannelProtocol[C]["request"];
export type ChannelResponse<C extends DesktopChannelId> = DesktopChannelProtocol[C]["response"];

// ============================================================================
// 事件推送通道（op:event）：SSE 的桌面替代。事件桥批次（F3 前置）落地生产侧。
// ============================================================================

export const EVENT_PUSH_CHANNEL = "op:event";

/** doc 实时预览变化事件类型（F4-4：main/ipc/doc-watch.ts 推送；event-stream.ts 按非对话流帧过滤）。 */
export const DOC_WATCH_EVENT_TYPE = "op:doc-watch";

/** 内置浏览器帧流事件类型（F6-2：main/ipc/browser-direct.ts watch 注册表经 subscribeBrowser
 *  桥推；event-stream.ts 按非对话流帧过滤）。data 形态 { client, thread, event, payload }，
 *  event/payload 对齐旧 SSE 消息 {type, data} 语义。 */
export const BROWSER_STREAM_EVENT_TYPE = "op:browser-stream";

/**
 * 对话流事件信封（server/agent.mjs emit 的通道事件原样转发）。
 * type 取值以 event-registry 登记的事件类型为准；`canonical` 为 U8 规范化视图（flag 开启时附带）。
 */
export interface DesktopEvent {
  /** 通道内序号（对话流为 id，持久事件流为 seq；事件桥统一为该字段） */
  id?: number;
  seq?: number;
  type: string;
  at?: string;
  streamId?: string;
  protocolVersion?: number;
  data: Record<string, unknown>;
  canonical?: unknown;
  [key: string]: unknown;
}

// ============================================================================
// 编译期不变量
// ============================================================================

// 通道协议映射必须与通道清单键集完全一致（多/少键都在这里编译失败）。
type _ProtocolCoversChannels =
  [Exclude<keyof DesktopChannelProtocol, DesktopChannelId>] extends [never]
  ? [Exclude<DesktopChannelId, keyof DesktopChannelProtocol>] extends [never]
    ? true
    : never
  : never;
const _protocolCoversChannels: _ProtocolCoversChannels = true;

// 每个通道的 request 类型必须兼容 InvokeEnvelope（转发器按信封组装 HTTP）。
type _EnvelopeCheck = {
  [C in DesktopChannelId]: ChannelRequest<C> extends InvokeEnvelope ? true : never;
}[DesktopChannelId];
const _envelopeCheck: _EnvelopeCheck = true;
