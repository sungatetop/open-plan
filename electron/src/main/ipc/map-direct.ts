/**
 * 地图域通道直调器（F5-1 项目/图层族 + F5-2 分析可视化族 + F5-3 报告导出模板族）：
 * op:map:* 43 条通道 → 进程内直调 map / layer-repository / project-pack / map-visualization /
 * cambodia-od / map-analysis / map-demo / traffic-sources / map-report / batch-export /
 * map-template / builtin-browser 域。
 *
 * 旧路径：渲染层 invoke → http-forward 转发 sidecar HTTP。本模块把 43 条通道的
 * sidecar 路由编排逐点转录为主进程内直调（行号锚点均指 server/index.mjs）：
 *
 * 项目族：
 *   - op:map:projects:list（L615-617）：{ projects }；
 *   - op:map:projects:create（L620-632）：createProject → 201；错误码
 *     MAP_PROJECT_INVALID/EXISTS/BASE_PROJECT_NOT_FOUND → 409，否则 500；
 *   - op:map:project:get（L634-645）：query.name 回退 DEFAULT_PROJECT；增补
 *     layerViews（动态 import layer-repository，失败静默不影响项目详情）；
 *   - op:map:project:export（L649-665，GIS G9）：flag mapPack 关 → 404；zip 二进制
 *     响应（HTTP 流式）→ base64 载数据架构等价替换（对齐 F4-3 doc raw 模式）；
 *   - op:map:projects:duplicate/rename/archive/delete（L668-702）：409 集合/403 保护/
 *     404 语义逐路由转录；
 * 样式配置/导入/瓦片/图层族：
 *   - op:map:style:save / config:save（L704-716）：无效输入 400；
 *   - op:map:import（L718-729）：clientError 正则（没有可导入/无效坐标/坐标不在/
 *     没有有效几何）→ 400，否则 500；
 *   - op:map:import:batch（L731-740）：items 非空数组守卫；
 *   - op:map:prepare（L743-760）：srcDir 解析到 workspace（回退 PROJECT_DIR/data）、
 *     workspace 前缀校验 + 目录存在校验 → 子进程依次跑 prepare-map-data.mjs +
 *     build-vector-tiles.mjs（cwd=PROJECT_DIR，300s 超时），输出尾截 800/500；
 *   - op:map:rebuild（L762-767）/ layer:delete（L769-773）/ layer:get（L775-779）；
 * 空间查询：
 *   - op:map:isochrone（L781-787）/ route（L790-796）：r.error → 400，响应投影
 *     center/cost/polygons、provider/distance/duration/geometry；
 * 项目命名路由族（:name 版，L5438-5506）：detail / style / config / import /
 *   rebuild-tiles / layer GET+DELETE / isochrone——与 query 版逐路由忠实转录
 *   （错误面不同：rebuild-tiles/layer:delete/isochrone 为 try/catch 500 版）；
 * 分析可视化族（F5-2）：
 *   - op:map:visual:sources（L5194-5197）：{ sources, planned }（planned 为
 *     traffic-sources PLANNED_SOURCES，server 侧每请求动态 import 取值）；
 *   - op:map:visual:get（L5201-5254）：dataset 五分支分发（适配器命中 → M2 流量/
 *     OD → 柬埔寨 → 演示），未知 dataset 400 + available 清单，catch 500；
 *   - op:map:traffic-bandwidth / od-lines / exchange-sankey / road-structure
 *     （L5510-5552）：sendMapAnalysis 语义——payload.error==="项目不存在" → 404，
 *     否则透传，catch 500；
 *   - op:map:multi-isochrone（L5533-5540）：body 解构 location/mode/ranges/rangeType
 *     整体透传，catch 500；
 *   - op:map:demo-analysis / cambodia-od / m3:*（L799-825 先注册生效段逐点转录；
 *     L5555-5585 与 L5562 为重复注册死路由，Express 先注册生效，不转录）。
 *     demo-analysis 500 信封为 { error, code, detail }（与 err500 不同，忠实转录）。
 * 报告导出模板族（F5-3）：
 *   - op:map:report（L5259-5277，GIS G8）：flag OAW_MAP_REPORT 门 404；workspace 归一
 *     回退 getWorkspace()（try 外，与 server 同形态）；buildMapReport → 投影
 *     { ok, file, fileName(basename), blocks, images }；错误 /越界|不存在/ → 400 否则 500；
 *   - op:map:export:batch:start（L5312-5361，GIS G7）：flag OAW_MAP_EXPORT 门 404 →
 *     串行锁（mapExportActiveBatch）409 → planExportJobs 计划 errors → 400 → 批次
 *     状态机落表（模块级 Map，服务重启即清空——GET 404 语义锚点）→ runExportQueue
 *     后台串行执行不阻塞响应（onProgress 快照实时写回 summary）→ 立即响应
 *     { ok, batchId, total, skipped, jobs 八字段投影 }；
 *   - op:map:export:batch:status（L5363-5379）：flag 门 404；id 空串同查无 → 404
 *     { ok:false, error:"批次不存在或服务已重启" }；响应快照白名单（error/finishedAt 缺省 ""）；
 *   - op:map:template:od-commuter（L5383-5401，GIS G5-v1）：flag OAW_MAP_TEMPLATES 门 404；
 *     runOdCommuterTemplate → { ok:true, ...result }；错误 /越界|不存在|缺少|不是 OD|没有/
 *     → 400 否则 500，信封 { ok:false, error }（与 report 的 { error } 分叉，忠实转录）；
 *   - executeExportJob（L5293-5310 路由内联执行器转录）：专用会话（map-export|batch）
 *     → 导出视图（R6-3 起离屏 BrowserWindow 加载 renderer 导出路由，deps 接线见
 *     index.ts/export-view-window.ts）→ 视口 → 45s 轮询就绪 → 页面错误探测 → PNG 截图/
 *     printToPDF → 落工作区 地图导出/（路径越界拒绝）；browser/fs/URL 经 deps 注入。
 *
 * 死路由声明（不登记通道）：/api/bus/*（routes/stops/od/stats）在 server/index.mjs
 * 有三段注册（L5720/L5860/L6113），但全部位于 L5714 `app.use("/api", 404)`
 * catch-all 之后——任何 /api/bus 请求先命中 404 中间件，路由体永不可达；旧 client
 * 亦零调用（api.js 无 /api/bus 引用）。桌面端忠实复刻"不可达"语义：不登记通道，
 * /api/bus 前缀在 EXEMPT 清单保留至 R6 退役。
 *
 * 语义差异（注释声明）：
 *   - export：HTTP zip 流式+Content-Disposition/X-Pack-Manifest 响应头 → IPC 返回
 *     { ok, fileName, manifest, buffer(base64) }；渲染层自建 blob 下载；
 *   - 无 try/catch 的路由（projects:list、layer:delete 顶层、style/config 400 判定
 *     之外、visual:sources）异常统一落 500 { error } JSON 信封——对调用方等价于
 *     "请求失败"。
 *
 * 数据源：backend/map.ts（21 函数，S3 域对拍覆盖）+ backend/layer-repository.ts
 * （listLayers）+ backend/project-pack.ts（buildProjectZip，GIS G9）+
 * backend/workspace.ts（getWorkspace/normalizeWorkspace）+ workspace-paths.ts（PROJECT_DIR）+
 * backend/map-visualization.ts（sources/adapters，F5-2）+ backend/cambodia-od.ts
 * （getCambodiaOD，visual 分支）+ backend/map-analysis.ts（createDemoAnalysis/
 * getCambodiaOD/getXinchangBus，生效路由段）+ backend/map-demo.ts（createDemoAnalysis，
 * visual 分支）+ backend/traffic-sources.ts（PLANNED_SOURCES）+
 * backend/map-report.ts（buildMapReport，F5-3 GIS G8）+ backend/batch-export.ts
 * （planExportJobs/runExportQueue，F5-3 GIS G7 计划器与队列编排）+
 * backend/map-template.ts（runOdCommuterTemplate，F5-3 GIS G5-v1）+
 * backend/builtin-browser.ts（B4 底座七函数：会话键/打开/视口/轮询/求值/截图/PDF）。
 *
 * 门控：R6-4 起恒直调（S4 期 OP_DESKTOP_MAP_DIRECT 回滚旗标随 sidecar 退役删除，
 * 流量切换评估方案 §4-S4 历史留档）。本模块不 import electron（纯逻辑，vitest 可直接测）；
 * 注册入口在 main/index.ts。
 */
import { resolve as pathResolve, join as pathJoin, basename as pathBasename } from "node:path";
import type { InvokeEnvelope, InvokeResult } from "../../shared/protocol/channels";

/** 地图项目/图层族编排的跨域依赖（生产接线传 backend 真实模块，测试注入桩）。 */
export interface MapDirectDeps {
  /** 地图项目清单（backend/map.ts listProjects） */
  listProjects: () => unknown[];
  /** 创建独立地图项目（backend/map.ts createProject，非法输入抛错带 code） */
  createProject: (input: { project?: unknown; name?: unknown; baseProject?: unknown }) => {
    config?: { project?: unknown } | null;
    style?: unknown;
    files?: unknown[];
  };
  /** 项目详情（backend/map.ts getProject，不存在返回 null） */
  getProject: (name: unknown) => Record<string, unknown> | null;
  /** 复制项目（backend/map.ts duplicateProject） */
  duplicateProject: (input: { project?: unknown; name?: unknown }) => {
    config?: { project?: unknown } | null;
  } | null;
  /** 重命名项目（backend/map.ts renameProject，保护项目抛 MAP_PROJECT_PROTECTED） */
  renameProject: (input: { project?: unknown; name?: unknown }) => {
    config?: { project?: unknown } | null;
  } | null;
  /** 归档项目（backend/map.ts archiveProject，不存在返回 null） */
  archiveProject: (name: unknown, archived: boolean) => unknown;
  /** 删除项目（backend/map.ts deleteProject，保护/不存在抛错带 code） */
  deleteProject: (name: unknown) => Record<string, unknown>;
  /** 保存 style.json（backend/map.ts saveStyle，无效返回 falsy） */
  saveStyle: (name: unknown, style: unknown) => unknown;
  /** 保存 config.json（backend/map.ts saveConfig，无效返回 falsy） */
  saveConfig: (name: unknown, config: unknown) => unknown;
  /** 导入单图层（backend/map.ts importLayer，异步；失败返回 falsy 或抛错） */
  importLayer: (name: unknown, layerId: unknown, geojson: unknown) => Promise<unknown>;
  /** 批量导入（backend/map.ts importBatch，异步） */
  importBatch: (name: unknown, items: unknown) => Promise<unknown>;
  /** 重建瓦片（backend/map.ts rebuildTiles，失败返回 falsy） */
  rebuildTiles: (name: unknown, layerIds: unknown) => unknown;
  /** 删除图层（backend/map.ts deleteLayer） */
  deleteLayer: (name: unknown, layerId: unknown) => unknown;
  /** 取图层 GeoJSON（backend/map.ts getLayer，不存在返回 null） */
  getLayer: (name: unknown, layerId: unknown) => unknown;
  /** 等时圈分析（backend/map.ts isochrone，异步；业务错误以 { error } 返回） */
  isochrone: (input: Record<string, any>) => Promise<Record<string, unknown>>;
  /** 路径规划（backend/map.ts route，异步；业务错误以 { error } 返回） */
  route: (input: Record<string, any>) => Promise<Record<string, unknown>>;
  /** 图层归属视图（backend/layer-repository.ts listLayers，同步） */
  listLayers: (project: unknown, options: { workspace: string }) => unknown;
  /** 项目打包（backend/project-pack.ts buildProjectZip，GIS G9；flag 关时不调用） */
  buildProjectZip: (input: { project: string; includeTiles: boolean }) => Promise<{
    fileName: string;
    manifest: { project: unknown };
    stats: { files: number; bytes: number };
    buffer: Buffer;
  }>;
  /** 当前工作区（backend/workspace.ts getWorkspace） */
  getWorkspace: () => string;
  /** 当前工作区地图库根（backend/workspace.ts getMapsRoot；prepare 传 CLI --maps-root） */
  getMapsRoot: () => string;
  /** 仓库根（workspace-paths.ts PROJECT_DIR，prepare 脚本 cwd 与 data 目录锚点） */
  projectDir: string;
  /** 目录探测（node:fs existsSync/statSync 的注入面，prepare 校验用） */
  dirProbe: (dir: string) => { exists: boolean; isDirectory: boolean };
  /** 子进程跑 node 脚本（prepare 用；生产接 child_process.execFile node，300s 超时） */
  runScript: (script: string, args: string[]) => Promise<{ code: number; out: string }>;
  /** OAW_MAP_PACK 开关（GIS G9 项目打包，默认关） */
  mapPackEnabled: () => boolean;

  // ---- F5-2 分析可视化族（六域：map / map-visualization / cambodia-od / map-analysis / map-demo / traffic-sources） ----
  /** M2 路网流量带宽（backend/map.ts getTrafficBandwidth） */
  getTrafficBandwidth: (name: unknown) => Record<string, unknown>;
  /** M2 OD 期望线（backend/map.ts getODLines） */
  getODLines: (name: unknown) => Record<string, unknown>;
  /** 多时距等时圈（backend/map.ts multiIsochrone，异步） */
  multiIsochrone: (input: { location?: unknown; mode?: unknown; ranges?: unknown; rangeType?: unknown }) => Promise<Record<string, unknown>>;
  /** 区域交换量桑基图（backend/map.ts getExchangeSankey） */
  getExchangeSankey: (name: unknown) => Record<string, unknown>;
  /** 路网结构统计（backend/map.ts getRoadStructure） */
  getRoadStructure: (name: unknown) => Record<string, unknown>;
  /** 已注册数据源清单（backend/map-visualization.ts listSources） */
  visualListSources: () => Array<{ id: string } & Record<string, unknown>>;
  /** 数据源适配加载（backend/map-visualization.ts loadSource，异步；{error} 为业务失败） */
  visualLoadSource: (id: unknown, params: Record<string, unknown>) => Promise<unknown>;
  /** M2 流量 → 描述符（backend/map-visualization.ts fromTrafficBandwidth） */
  fromTrafficBandwidth: (result: unknown) => unknown;
  /** M2 OD → 描述符（backend/map-visualization.ts fromOdLines） */
  fromOdLines: (result: unknown) => unknown;
  /** 柬埔寨 OD → 描述符（backend/map-visualization.ts fromCambodiaOd） */
  fromCambodiaOd: (result: unknown) => unknown;
  /** 演示分析 → 描述符（backend/map-visualization.ts fromDemoAnalysis） */
  fromDemoAnalysis: (action: unknown) => unknown;
  /** 柬埔寨 OD 数据（visual 分支 L5236：backend/cambodia-od.ts getCambodiaOD——与 map-analysis.ts 同名函数分属两模块，忠实分线） */
  cambodiaGetCambodiaOD: (input: { minFlow: unknown }) => unknown;
  /** 演示分析（生效路由 L801：backend/map-analysis.ts createDemoAnalysis，query 原始透传） */
  analysisCreateDemoAnalysis: (input: { analysis?: unknown; region?: unknown; project?: unknown; count?: unknown }) => Record<string, unknown>;
  /** 柬埔寨 OD 数据（生效路由 L806：backend/map-analysis.ts getCambodiaOD） */
  analysisGetCambodiaOD: (input: { minFlow: unknown }) => Record<string, unknown>;
  /** M3 新昌公交（生效路由 L810-825：backend/map-analysis.ts getXinchangBus("routes"|"stations"|"od"|"stats")） */
  getXinchangBus: (kind: string) => unknown;
  /** 演示分析（visual 分支 L5240：backend/map-demo.ts createDemoAnalysis——与 map-analysis.ts 同名函数分属两模块，忠实分线；region/project 原始透传不做 String 化） */
  demoCreateDemoAnalysis: (input: { analysis: string; region: unknown; project: unknown }) => unknown;
  /** 计划中数据源桩清单（backend/traffic-sources.ts PLANNED_SOURCES，Object.freeze 只读数组） */
  plannedSources: () => readonly unknown[];

  // ---- F5-3 报告导出模板族（四域：map-report / batch-export / map-template / builtin-browser + workspace/flags/fs/端口注入） ----
  /** 工作区路径归一（backend/workspace.ts normalizeWorkspace，越界返回 null） */
  normalizeWorkspace: (dir: string) => string | null;
  /** OAW_MAP_REPORT 开关（GIS G8 地图报告，默认关） */
  mapReportEnabled: () => boolean;
  /** 构建地图报告（backend/map-report.ts buildMapReport，产物落工作区） */
  buildMapReport: (options: { workspace: string; project?: unknown; title?: unknown; sections?: unknown; images?: unknown; fileName?: unknown }) => Promise<{ file: string; blocks: number; images: number }>;
  /** OAW_MAP_EXPORT 开关（GIS G7 批量导出，默认关） */
  mapExportEnabled: () => boolean;
  /** 批量导出计划器（backend/batch-export.ts planExportJobs，纯函数） */
  planExportJobs: (options: Record<string, unknown>) => { jobs: any[]; errors: string[]; skipped: unknown };
  /** 批量导出队列（backend/batch-export.ts runExportQueue：串行执行 executor 并汇总进度） */
  runExportQueue: (jobs: unknown, executor: (job: any) => Promise<{ file: string; bytes: number }>, opts?: { onProgress?: (snapshot: unknown) => void }) => Promise<any>;
  /** OAW_MAP_TEMPLATES 开关（GIS G5-v1 OD 通勤模板，默认关） */
  mapTemplatesEnabled: () => boolean;
  /** OD 通勤模板（backend/map-template.ts runOdCommuterTemplate） */
  runOdCommuterTemplate: (options: { workspace: string; path?: unknown; title?: unknown; bands?: unknown; project?: unknown; fileName?: unknown }) => Promise<Record<string, unknown>>;
  /** 内置浏览器会话键（backend/builtin-browser.ts browserSessionKey） */
  browserSessionKey: (clientId: string, threadId: string) => string;
  /** 打开浏览器会话页面（builtin-browser browserOpen） */
  browserOpen: (key: string, url: string) => Promise<unknown>;
  /** 视口调整（builtin-browser browserResize） */
  browserResize: (key: string, width: number, height: number) => Promise<unknown>;
  /** 轮询表达式就绪（builtin-browser browserWaitForExpression） */
  browserWaitForExpression: (key: string, expression: string, opts?: { timeoutMs?: number; intervalMs?: number }) => Promise<boolean>;
  /** 求值取值（builtin-browser browserEvaluateValue） */
  browserEvaluateValue: (key: string, expression: string) => Promise<unknown>;
  /** 打印 PDF（builtin-browser browserPrintToPdf） */
  browserPrintToPdf: (key: string) => Promise<{ base64?: string }>;
  /** 截图（builtin-browser browserScreenshot） */
  browserScreenshot: (key: string, options?: { format?: string }) => Promise<{ base64?: string }>;
  /** 导出视图页面 URL（R6-3 离屏窗口形态：renderer 导出路由 app/index.html?export=map，
   * dev 走 vite devUrl、打包走 file:// 产物；接线见 index.ts → export-view-window.ts） */
  exportViewUrl: (job: Record<string, any>) => string;
  /** 建目录（fs.mkdirSync recursive 的注入面） */
  ensureDir: (dir: string) => void;
  /** 写文件（fs.writeFileSync 的注入面） */
  writeFile: (file: string, data: Buffer) => void;

  // ---- F5-5 style.json 动态读通道（map 域画布层） ----
  /** 地图项目目录白名单（backend/map.ts projectDir：非法名返回 null） */
  mapProjectDir: (name: unknown) => string | null;
  /** 底图运行时注入（backend/map.ts hydrateBasemapSources：本地设置覆盖 + 非法源剔除） */
  hydrateBasemapSources: (style: unknown) => unknown;
  /** 读 style.json 文本（fs.readFileSync utf8 的注入面） */
  readStyleFile: (file: string) => string;
}

/** 地图项目/图层族直调 invoke 通道清单（与 DESKTOP_CHANNELS 对应路由一致）。 */
export const MAP_DIRECT_CHANNELS = [
  "op:map:projects:list",
  "op:map:projects:create",
  "op:map:project:get",
  "op:map:project:export",
  "op:map:projects:duplicate",
  "op:map:projects:rename",
  "op:map:projects:archive",
  "op:map:projects:delete",
  "op:map:style:save",
  "op:map:config:save",
  "op:map:import",
  "op:map:import:batch",
  "op:map:prepare",
  "op:map:rebuild",
  "op:map:layer:delete",
  "op:map:layer:get",
  "op:map:isochrone",
  "op:map:route",
  "op:map:project:detail",
  "op:map:project:style:save",
  "op:map:project:config:save",
  "op:map:project:import",
  "op:map:project:rebuild-tiles",
  "op:map:project:layer:get",
  "op:map:project:layer:delete",
  "op:map:project:isochrone",
  // ---- F5-2 分析可视化族 ----
  "op:map:visual:sources",
  "op:map:visual:get",
  "op:map:traffic-bandwidth",
  "op:map:od-lines",
  "op:map:multi-isochrone",
  "op:map:exchange-sankey",
  "op:map:road-structure",
  "op:map:demo-analysis",
  "op:map:cambodia-od",
  "op:map:m3:bus-routes",
  "op:map:m3:station-heatmap",
  "op:map:m3:od-lines",
  "op:map:m3:network-stats",
  // ---- F5-3 报告导出模板族 ----
  "op:map:report",
  "op:map:export:batch:start",
  "op:map:export:batch:status",
  "op:map:template:od-commuter",
  // ---- F5-5 style.json 动态读通道 ----
  "op:map:data:style"
] as const;

export type MapDirectChannel = (typeof MAP_DIRECT_CHANNELS)[number];

const ok = (data: unknown): InvokeResult<unknown> => ({ ok: true, status: 200, data });
const created = (data: unknown): InvokeResult<unknown> => ({ ok: true, status: 201, data });
const fail = (status: number, data: unknown): InvokeResult<unknown> => ({ ok: false, status, data }) as InvokeResult<unknown>;
const err500 = (error: unknown): InvokeResult<unknown> =>
  fail(500, { error: String((error as { message?: unknown })?.message ?? error) });

function bodyOf(payload: InvokeEnvelope): Record<string, any> {
  const body = payload.body;
  return body && typeof body === "object" ? (body as Record<string, any>) : {};
}

function queryOf(payload: InvokeEnvelope): Record<string, string | number | boolean | null | undefined> {
  return payload.query ?? {};
}

/* ------------------------------ 项目族 ------------------------------ */

/** GET /api/map/projects（server L615-617 逐点转录，无 try/catch）。 */
function invokeProjectsList(deps: MapDirectDeps): InvokeResult<unknown> {
  return ok({ projects: deps.listProjects() });
}

/** server L629/L673/L683 同款 409 错误码集合。 */
const MAP_PROJECT_CONFLICT_CODES = ["MAP_PROJECT_INVALID", "MAP_PROJECT_EXISTS", "MAP_BASE_PROJECT_NOT_FOUND"];
const MAP_PROJECT_CONFLICT_CODES_LIFECYCLE = ["MAP_PROJECT_INVALID", "MAP_PROJECT_EXISTS", "MAP_PROJECT_NOT_FOUND"];

/** POST /api/map/projects（server L620-632 逐点转录：baseProject 回退 DEFAULT_PROJECT，201/409/500）。 */
function invokeProjectsCreate(payload: InvokeEnvelope, deps: MapDirectDeps): InvokeResult<unknown> {
  try {
    const body = bodyOf(payload);
    const cr = deps.createProject({
      project: body.project,
      name: body.name,
      baseProject: body.baseProject || "zhejiang-map"
    });
    return created({
      ok: true,
      project: cr.config?.project,
      config: cr.config,
      style: cr.style,
      files: cr.files || []
    });
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    const status = MAP_PROJECT_CONFLICT_CODES.includes(String(code)) ? 409 : 500;
    return fail(status, {
      ok: false,
      error: String((e as { message?: unknown })?.message ?? e),
      code: code || "MAP_PROJECT_CREATE_FAILED"
    });
  }
}

/** GET /api/map/project（server L634-645 逐点转录：query.name 回退默认 + layerViews 增补静默）。 */
async function invokeProjectGet(payload: InvokeEnvelope, deps: MapDirectDeps): Promise<InvokeResult<unknown>> {
  const query = queryOf(payload);
  const p = deps.getProject(query.name || "zhejiang-map");
  if (!p) return fail(404, { error: "project not found" });
  try {
    const workspace = String(query.workspace || "");
    const name = (p.config as { project?: unknown } | undefined)?.project || query.name || "zhejiang-map";
    (p as Record<string, unknown>).layerViews = deps.listLayers(name, { workspace });
  } catch { /* 归属视图失败不影响项目详情 */ }
  return ok(p);
}

/** GET /api/map/project/export（server L649-665 逐点转录：flag 关 404；zip 流式 → base64 载数据）。 */
async function invokeProjectExport(payload: InvokeEnvelope, deps: MapDirectDeps): Promise<InvokeResult<unknown>> {
  if (!deps.mapPackEnabled()) return fail(404, { error: "not found" });
  try {
    const query = queryOf(payload);
    const out = await deps.buildProjectZip({
      project: String(query.name || ""),
      includeTiles: query.tiles === 1 || query.tiles === "1"
    });
    // HTTP 响应头 X-Pack-Manifest 语义 → data.manifest 字段等价承载。
    return ok({
      ok: true,
      fileName: out.fileName,
      manifest: { project: out.manifest.project, files: out.stats.files, bytes: out.stats.bytes },
      buffer: Buffer.from(out.buffer).toString("base64")
    });
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    const status = code === "MAP_PROJECT_NOT_FOUND" ? 404 : code === "MAP_PACK_TOO_LARGE" ? 413 : 500;
    return fail(status, {
      ok: false,
      error: String((e as { message?: unknown })?.message ?? e),
      code: code || "MAP_PACK_FAILED"
    });
  }
}

/** POST /api/map/projects/duplicate（server L668-676 逐点转录：201/409 集合/500）。 */
function invokeProjectsDuplicate(payload: InvokeEnvelope, deps: MapDirectDeps): InvokeResult<unknown> {
  try {
    const body = bodyOf(payload);
    const dup = deps.duplicateProject({ project: body.project, name: body.name });
    return created({ ok: true, project: dup?.config?.project, config: dup?.config });
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    const status = MAP_PROJECT_CONFLICT_CODES_LIFECYCLE.includes(String(code)) ? 409 : 500;
    return fail(status, {
      ok: false,
      error: String((e as { message?: unknown })?.message ?? e),
      code: code || "MAP_PROJECT_DUPLICATE_FAILED"
    });
  }
}

/** POST /api/map/projects/rename（server L678-686 逐点转录：409 集合 + PROTECTED 403）。 */
function invokeProjectsRename(payload: InvokeEnvelope, deps: MapDirectDeps): InvokeResult<unknown> {
  try {
    const body = bodyOf(payload);
    const renamed = deps.renameProject({ project: body.project, name: body.name });
    return ok({ ok: true, project: renamed?.config?.project, config: renamed?.config });
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    const status = MAP_PROJECT_CONFLICT_CODES_LIFECYCLE.includes(String(code))
      ? 409
      : code === "MAP_PROJECT_PROTECTED" ? 403 : 500;
    return fail(status, {
      ok: false,
      error: String((e as { message?: unknown })?.message ?? e),
      code: code || "MAP_PROJECT_RENAME_FAILED"
    });
  }
}

/** POST /api/map/projects/archive（server L688-692 逐点转录：archived !== false 默认归档，404）。 */
function invokeProjectsArchive(payload: InvokeEnvelope, deps: MapDirectDeps): InvokeResult<unknown> {
  const body = bodyOf(payload);
  const config = deps.archiveProject(body.project, body.archived !== false);
  if (!config) return fail(404, { ok: false, error: "project not found" });
  return ok({ ok: true, config });
}

/** POST /api/map/projects/delete（server L694-702 逐点转录：PROTECTED 403 / NOT_FOUND 404）。 */
function invokeProjectsDelete(payload: InvokeEnvelope, deps: MapDirectDeps): InvokeResult<unknown> {
  try {
    const result = deps.deleteProject(bodyOf(payload).project);
    return ok({ ok: true, ...result });
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    const status = code === "MAP_PROJECT_PROTECTED" ? 403 : code === "MAP_PROJECT_NOT_FOUND" ? 404 : 500;
    return fail(status, {
      ok: false,
      error: String((e as { message?: unknown })?.message ?? e),
      code: code || "MAP_PROJECT_DELETE_FAILED"
    });
  }
}

/* ------------------------ 样式配置/导入/瓦片/图层族 ------------------------ */

/** POST /api/map/style（server L704-709 逐点转录：name 回退默认，无效 400）。 */
function invokeStyleSave(payload: InvokeEnvelope, deps: MapDirectDeps): InvokeResult<unknown> {
  const { name, style } = bodyOf(payload);
  const r = deps.saveStyle(name || "zhejiang-map", style);
  if (!r) return fail(400, { error: "invalid style" });
  return ok({ ok: true });
}

/** POST /api/map/config（server L711-716 逐点转录：name 回退默认，无效 400）。 */
function invokeConfigSave(payload: InvokeEnvelope, deps: MapDirectDeps): InvokeResult<unknown> {
  const { name, config } = bodyOf(payload);
  const r = deps.saveConfig(name || "zhejiang-map", config);
  if (!r) return fail(400, { error: "invalid config" });
  return ok({ ok: true });
}

/** server L726 同款客户端错误识别正则（导入校验类错误 → 400）。 */
const IMPORT_CLIENT_ERROR = /没有可导入|无效坐标|坐标不在|没有有效几何/;

/** POST /api/map/import（server L718-729 逐点转录：geojson 守卫 + clientError 400/500）。 */
async function invokeImport(payload: InvokeEnvelope, deps: MapDirectDeps): Promise<InvokeResult<unknown>> {
  const { name, layerId, geojson } = bodyOf(payload);
  if (!geojson) return fail(400, { error: "geojson required" });
  try {
    const r = await deps.importLayer(name || "zhejiang-map", layerId, geojson);
    if (!r) return fail(400, { error: "import failed" });
    return ok(r);
  } catch (e) {
    const message = String((e as { message?: unknown })?.message ?? e);
    return fail(IMPORT_CLIENT_ERROR.test(message) ? 400 : 500, { error: message });
  }
}

/** POST /api/map/import-batch（server L731-740 逐点转录：items 非空数组守卫）。 */
async function invokeImportBatch(payload: InvokeEnvelope, deps: MapDirectDeps): Promise<InvokeResult<unknown>> {
  const { name, items } = bodyOf(payload);
  if (!Array.isArray(items) || !items.length) return fail(400, { error: "items required" });
  try {
    const r = await deps.importBatch(name || "zhejiang-map", items);
    return ok(r);
  } catch (e) {
    return err500(e);
  }
}

/** POST /api/map/prepare（server L743-760 逐点转录：src 校验 + 两脚本子进程 + 输出尾截）。 */
async function invokePrepare(payload: InvokeEnvelope, deps: MapDirectDeps): Promise<InvokeResult<unknown>> {
  const { srcDir } = bodyOf(payload);
  const ws = deps.getWorkspace();
  const src = srcDir
    ? pathResolve(ws, String(srcDir))
    : pathJoin(deps.projectDir, "data");
  if (!src.startsWith(ws) && !src.startsWith(deps.projectDir)) return fail(400, { error: "invalid dir" });
  const probe = deps.dirProbe(src);
  if (!probe.exists || !probe.isDirectory) {
    return fail(400, { error: "目录不存在: " + (srcDir || "data") + "（请先把矢量数据放入该目录）" });
  }
  // 两脚本均支持 --maps-root 覆盖默认锚（地图库跟随 2026-10-30）：按当前工作区传根
  const mapsRootArg = `--maps-root=${deps.getMapsRoot()}`;
  const p1 = await deps.runScript("scripts/tools/prepare-map-data.mjs", [src, mapsRootArg]);
  const p2 = await deps.runScript("scripts/tools/build-vector-tiles.mjs", ["--force", mapsRootArg]);
  return ok({ ok: p1.code === 0 && p2.code === 0, prepare: p1.out.slice(-800), tiles: p2.out.slice(-500) });
}

/** POST /api/map/rebuild（server L762-767 逐点转录：失败 400）。 */
function invokeRebuild(payload: InvokeEnvelope, deps: MapDirectDeps): InvokeResult<unknown> {
  const { name, layerIds } = bodyOf(payload);
  const r = deps.rebuildTiles(name || "zhejiang-map", Array.isArray(layerIds) ? layerIds : null);
  if (!r) return fail(400, { error: "rebuild failed" });
  return ok({ ok: true, layers: r });
}

/** POST /api/map/layer/delete（server L769-773 逐点转录：无 try/catch）。 */
function invokeLayerDelete(payload: InvokeEnvelope, deps: MapDirectDeps): InvokeResult<unknown> {
  const { name, layerId } = bodyOf(payload);
  return ok(deps.deleteLayer(name || "zhejiang-map", layerId));
}

/** GET /api/map/layer（server L775-779 逐点转录：404）。 */
function invokeLayerGet(payload: InvokeEnvelope, deps: MapDirectDeps): InvokeResult<unknown> {
  const query = queryOf(payload);
  const g = deps.getLayer(query.name || "zhejiang-map", query.layer);
  if (!g) return fail(404, { error: "layer not found" });
  return ok(g);
}

/* ------------------------------ 空间查询 ------------------------------ */

/** POST /api/map/isochrone（server L781-787 逐点转录：location 守卫 + r.error 400 + 投影）。 */
async function invokeIsochrone(payload: InvokeEnvelope, deps: MapDirectDeps): Promise<InvokeResult<unknown>> {
  const { location, mode, range, rangeType } = bodyOf(payload);
  if (!location) return fail(400, { error: "location required (lng,lat)" });
  const r = await deps.isochrone({ location, mode, range, rangeType });
  if (r.error) return fail(400, { error: r.error });
  return ok({ ok: true, center: r.center, cost: r.cost, polygons: r.polygons });
}

/** POST /api/map/route（server L790-796 逐点转录：from/to 守卫 + r.error 400 + 投影）。 */
async function invokeRoute(payload: InvokeEnvelope, deps: MapDirectDeps): Promise<InvokeResult<unknown>> {
  const { from, to, mode, provider } = bodyOf(payload);
  if (!from || !to) return fail(400, { error: "from/to required (lng,lat)" });
  const r = await deps.route({ from, to, mode, provider });
  if (r.error) return fail(400, { error: r.error });
  return ok({ ok: true, provider: r.provider, distance: r.distance, duration: r.duration, geometry: r.geometry });
}

/* --------------------------- 项目命名路由族（:name） --------------------------- */

/** GET /api/map/project/:name（server L5438-5442 逐点转录：params.name，404）。 */
function invokeProjectDetail(payload: InvokeEnvelope, deps: MapDirectDeps): InvokeResult<unknown> {
  const p = deps.getProject(payload.params?.name);
  if (!p) return fail(404, { error: "project not found" });
  return ok(p);
}

/** POST /api/map/project/:name/style（server L5445-5449 逐点转录：无效 400）。 */
function invokeProjectStyleSave(payload: InvokeEnvelope, deps: MapDirectDeps): InvokeResult<unknown> {
  const okFlag = deps.saveStyle(payload.params?.name, bodyOf(payload).style);
  if (!okFlag) return fail(400, { error: "invalid style" });
  return ok({ ok: true });
}

/** POST /api/map/project/:name/config（server L5452-5456 逐点转录：无效 400）。 */
function invokeProjectConfigSave(payload: InvokeEnvelope, deps: MapDirectDeps): InvokeResult<unknown> {
  const okFlag = deps.saveConfig(payload.params?.name, bodyOf(payload).config);
  if (!okFlag) return fail(400, { error: "invalid config" });
  return ok({ ok: true });
}

/** POST /api/map/project/:name/import（server L5459-5469 逐点转录：双守卫 + 500）。 */
async function invokeProjectImport(payload: InvokeEnvelope, deps: MapDirectDeps): Promise<InvokeResult<unknown>> {
  const { layerId, geojson } = bodyOf(payload);
  if (!layerId || !geojson) return fail(400, { error: "layerId and geojson required" });
  try {
    const r = await deps.importLayer(payload.params?.name, layerId, geojson);
    if (!r) return fail(400, { error: "import failed" });
    return ok(r);
  } catch (e) {
    return err500(e);
  }
}

/** POST /api/map/project/:name/rebuild-tiles（server L5472-5479 逐点转录：results 字段 + 500）。 */
function invokeProjectRebuildTiles(payload: InvokeEnvelope, deps: MapDirectDeps): InvokeResult<unknown> {
  try {
    const r = deps.rebuildTiles(payload.params?.name, null);
    return ok({ ok: true, results: r });
  } catch (e) {
    return err500(e);
  }
}

/** GET /api/map/project/:name/layer/:layerId（server L5482-5486 逐点转录：404）。 */
function invokeProjectLayerGet(payload: InvokeEnvelope, deps: MapDirectDeps): InvokeResult<unknown> {
  const g = deps.getLayer(payload.params?.name, payload.params?.layerId);
  if (!g) return fail(404, { error: "layer not found" });
  return ok(g);
}

/** DELETE /api/map/project/:name/layer/:layerId（server L5489-5496 逐点转录：500）。 */
function invokeProjectLayerDelete(payload: InvokeEnvelope, deps: MapDirectDeps): InvokeResult<unknown> {
  try {
    return ok(deps.deleteLayer(payload.params?.name, payload.params?.layerId));
  } catch (e) {
    return err500(e);
  }
}

/** POST /api/map/project/:name/isochrone（server L5499-5506 逐点转录：整体透传 + 500）。 */
async function invokeProjectIsochrone(payload: InvokeEnvelope, deps: MapDirectDeps): Promise<InvokeResult<unknown>> {
  try {
    const r = await deps.isochrone(bodyOf(payload));
    return ok(r);
  } catch (e) {
    return err500(e);
  }
}

/* --------------------------- 分析可视化族（F5-2） --------------------------- */

/** server L5510-5518 同款 sendMapAnalysis 语义：error==="项目不存在" → 404，否则透传。 */
function mapAnalysisResult(payload: unknown): InvokeResult<unknown> {
  if ((payload as { error?: unknown } | null)?.error === "项目不存在") return fail(404, payload);
  return ok(payload);
}

/** GET /api/map/visual/sources（server L5194-5197 逐点转录，无 try/catch）。 */
function invokeVisualSources(deps: MapDirectDeps): InvokeResult<unknown> {
  return ok({ sources: deps.visualListSources(), planned: deps.plannedSources() });
}

/** GET /api/map/visual（server L5201-5254 逐点转录：dataset 五分支分发 + 未知 400 + 500）。 */
async function invokeVisualGet(payload: InvokeEnvelope, deps: MapDirectDeps): Promise<InvokeResult<unknown>> {
  const query = queryOf(payload);
  const dataset = String(query.dataset || "").trim();
  const params = {
    kind: query.kind || undefined,
    path: query.path || undefined,
    measure: query.measure || undefined,
    project: query.project || undefined,
    minFlow: query.threshold || undefined,
    region: query.region || undefined,
    workspace: String(query.workspace || ""),
    // G2 外部数据适配器参数（live-traffic-api 的端点 / sql-database 的库与查询）
    url: query.url || undefined,
    db: query.db || undefined,
    sql: query.sql || undefined
  };
  try {
    // 1) 优先按数据源适配器解析（local-file / bundled-xinchang / 未来接入的源）
    const sources = deps.visualListSources();
    if (dataset && sources.some((s) => s.id === dataset)) {
      const descriptor = await deps.visualLoadSource(dataset, params);
      if ((descriptor as { error?: unknown } | null)?.error) return fail(400, descriptor);
      return ok({ descriptor });
    }
    // 2) 否则按既有数据集 id 适配（M2 / 柬埔寨 / 演示）
    if (dataset === "m2-traffic-bandwidth") {
      const r = deps.getTrafficBandwidth(params.project || "zhejiang-map");
      if (r?.error) return fail(400, r);
      return ok({ descriptor: deps.fromTrafficBandwidth(r) });
    }
    if (dataset === "m2-od-lines") {
      const r = deps.getODLines(params.project || "zhejiang-map");
      if (r?.error) return fail(400, r);
      return ok({ descriptor: deps.fromOdLines(r) });
    }
    if (dataset === "cambodia-od") {
      const r = deps.cambodiaGetCambodiaOD({ minFlow: params.minFlow });
      return ok({ descriptor: deps.fromCambodiaOd(r) });
    }
    if (dataset === "demo-analysis") {
      const action = deps.demoCreateDemoAnalysis({
        analysis: params.kind === "flow" ? "od" : params.kind === "isochrone" ? "isochrone" : "heatmap",
        region: params.region || "义乌市",
        project: params.project || "zhejiang-map"
      });
      return ok({ descriptor: deps.fromDemoAnalysis(action) });
    }
    return fail(400, {
      error: `未知 dataset：${dataset || "(空)"}`,
      available: [...sources.map((s) => s.id), "m2-traffic-bandwidth", "m2-od-lines", "cambodia-od", "demo-analysis"]
    });
  } catch (e) {
    return err500(e);
  }
}

/** GET /api/map/traffic-bandwidth（server L5521-5524 逐点转录：sendMapAnalysis 语义）。 */
function invokeTrafficBandwidth(payload: InvokeEnvelope, deps: MapDirectDeps): InvokeResult<unknown> {
  try {
    return mapAnalysisResult(deps.getTrafficBandwidth(queryOf(payload).project || "zhejiang-map"));
  } catch (e) {
    return err500(e);
  }
}

/** GET /api/map/od-lines（server L5527-5530 逐点转录：sendMapAnalysis 语义）。 */
function invokeOdLines(payload: InvokeEnvelope, deps: MapDirectDeps): InvokeResult<unknown> {
  try {
    return mapAnalysisResult(deps.getODLines(queryOf(payload).project || "zhejiang-map"));
  } catch (e) {
    return err500(e);
  }
}

/** POST /api/map/multi-isochrone（server L5533-5540 逐点转录：body 四参解构 + 透传 + 500）。 */
async function invokeMultiIsochrone(payload: InvokeEnvelope, deps: MapDirectDeps): Promise<InvokeResult<unknown>> {
  try {
    const { location, mode, ranges, rangeType } = bodyOf(payload);
    return ok(await deps.multiIsochrone({ location, mode, ranges, rangeType }));
  } catch (e) {
    return err500(e);
  }
}

/** GET /api/map/exchange-sankey（server L5543-5546 逐点转录：sendMapAnalysis 语义）。 */
function invokeExchangeSankey(payload: InvokeEnvelope, deps: MapDirectDeps): InvokeResult<unknown> {
  try {
    return mapAnalysisResult(deps.getExchangeSankey(queryOf(payload).project || "zhejiang-map"));
  } catch (e) {
    return err500(e);
  }
}

/** GET /api/map/road-structure（server L5549-5552 逐点转录：sendMapAnalysis 语义）。 */
function invokeRoadStructure(payload: InvokeEnvelope, deps: MapDirectDeps): InvokeResult<unknown> {
  try {
    return mapAnalysisResult(deps.getRoadStructure(queryOf(payload).project || "zhejiang-map"));
  } catch (e) {
    return err500(e);
  }
}

/**
 * GET /api/map/demo-analysis（server L799-803 先注册生效段逐点转录：query 原始透传
 * ——默认值由 map-analysis 域内补齐；500 信封 { error, code, detail }。
 * L5562-5566 重复注册段被 Express 先注册生效规则淘汰，不转录）。
 */
function invokeDemoAnalysis(payload: InvokeEnvelope, deps: MapDirectDeps): InvokeResult<unknown> {
  const query = queryOf(payload);
  try {
    return ok(deps.analysisCreateDemoAnalysis({
      analysis: query.analysis,
      region: query.region,
      project: query.project,
      count: query.count
    }));
  } catch (e) {
    const err = e as { message?: unknown; code?: unknown; detail?: unknown };
    return fail(500, { error: String(err.message ?? e), code: err.code ?? null, detail: err.detail ?? null });
  }
}

/** GET /api/demo/cambodia-od（server L805-808 生效段逐点转录：try/catch 500；L5555 段为死路由）。 */
function invokeCambodiaOd(payload: InvokeEnvelope, deps: MapDirectDeps): InvokeResult<unknown> {
  try {
    return ok(deps.analysisGetCambodiaOD({ minFlow: queryOf(payload).minFlow }));
  } catch (e) {
    return err500(e);
  }
}

/** GET /api/m3/bus-routes（server L810-813 生效段逐点转录：getXinchangBus("routes")；L5571 段为死路由）。 */
function invokeM3BusRoutes(deps: MapDirectDeps): InvokeResult<unknown> {
  try {
    return ok(deps.getXinchangBus("routes"));
  } catch (e) {
    return err500(e);
  }
}

/** GET /api/m3/station-heatmap（server L814-817 生效段逐点转录：getXinchangBus("stations")）。 */
function invokeM3StationHeatmap(deps: MapDirectDeps): InvokeResult<unknown> {
  try {
    return ok(deps.getXinchangBus("stations"));
  } catch (e) {
    return err500(e);
  }
}

/** GET /api/m3/od-lines（server L818-821 生效段逐点转录：getXinchangBus("od")）。 */
function invokeM3OdLines(deps: MapDirectDeps): InvokeResult<unknown> {
  try {
    return ok(deps.getXinchangBus("od"));
  } catch (e) {
    return err500(e);
  }
}

/** GET /api/m3/network-stats（server L822-825 生效段逐点转录：getXinchangBus("stats")）。 */
function invokeM3NetworkStats(deps: MapDirectDeps): InvokeResult<unknown> {
  try {
    return ok(deps.getXinchangBus("stats"));
  } catch (e) {
    return err500(e);
  }
}

/* ------------------------------ 报告导出模板族（F5-3） ------------------------------ */

/** GIS G7 批量导出批次记录（server L5328-5336 batch 字面形态转录）。 */
interface MapExportBatchRecord {
  id: string;
  status: string;
  workspace: string;
  total: number;
  skipped: unknown;
  summary: unknown;
  error?: string;
  createdAt: string;
  finishedAt?: string;
}

/** server L5283-5285 同款模块级状态：批次表 + 串行锁 + 序号（进程内存态，重启即清空
 * ——GET status 404 "批次不存在或服务已重启" 的语义锚点）。 */
const mapExportBatches = new Map<string, MapExportBatchRecord>();
let mapExportActiveBatch: string | null = null;
let mapExportSeq = 0;

/** server L5293-5310 路由内联执行器逐点转录：专用会话（map-export|batch，独立实例
 * 不干扰用户面板）→ 导出视图（R6-3 起离屏 BrowserWindow，URL 由 deps.exportViewUrl
 * 构建）→ 视口 → 45s 轮询就绪 → 页面错误探测 → PNG 截图 / printToPDF → 产物落工作区
 * 地图导出/（路径越界拒绝）。browser/fs/URL 经 deps 注入。 */
async function executeExportJob(job: Record<string, any>, workspace: string, deps: MapDirectDeps): Promise<{ file: string; bytes: number }> {
  const key = deps.browserSessionKey("map-export", "batch");
  await deps.browserOpen(key, deps.exportViewUrl(job));
  await deps.browserResize(key, job.width, job.height);
  await deps.browserWaitForExpression(key, "window.__OAW_EXPORT_READY === true", { timeoutMs: 45000 });
  const pageError = await deps.browserEvaluateValue(key, "window.__OAW_EXPORT_ERROR || ''").catch(() => "");
  if (pageError) throw new Error(`导出视图异常：${pageError}`);
  const capture = job.format === "pdf"
    ? await deps.browserPrintToPdf(key)
    : await deps.browserScreenshot(key, { format: "png" });
  const outDir = pathJoin(workspace, "地图导出");
  deps.ensureDir(outDir);
  const target = pathJoin(outDir, job.fileName);
  if (!target.startsWith(pathResolve(workspace))) throw new Error("导出产物路径越界");
  deps.writeFile(target, Buffer.from(capture.base64 || "", "base64"));
  return { file: target, bytes: Buffer.byteLength(capture.base64 || "", "base64") };
}

/** POST /api/map/report（server L5259-5277 逐点转录：flag 门 404；workspace 归一回退在
 * try 外与 server 同形态；错误 /越界|不存在/ → 400 否则 500；成功投影 file/
 * fileName(basename)/blocks/images）。 */
async function invokeReport(payload: InvokeEnvelope, deps: MapDirectDeps): Promise<InvokeResult<unknown>> {
  if (!deps.mapReportEnabled()) return fail(404, { error: "not found" });
  const body = bodyOf(payload);
  const workspace = deps.normalizeWorkspace(String(body.workspace || "")) || deps.getWorkspace();
  try {
    const result = await deps.buildMapReport({
      workspace,
      project: body.project,
      title: body.title,
      sections: body.sections,
      images: body.images,
      fileName: body.fileName
    });
    return ok({ ok: true, file: result.file, fileName: pathBasename(result.file), blocks: result.blocks, images: result.images });
  } catch (e) {
    const msg = String((e as { message?: unknown })?.message ?? e);
    return fail(/越界|不存在/.test(msg) ? 400 : 500, { error: msg });
  }
}

/** POST /api/map/export/batch（server L5312-5361 逐点转录：flag 门 404 → 串行锁 409 →
 * 计划 errors → 400 → 批次状态机落表 → runExportQueue 后台串行执行不阻塞响应
 * （onProgress 快照实时写回 summary）→ 立即响应 { ok, batchId, total, skipped, jobs 投影 }）。 */
function invokeExportBatchStart(payload: InvokeEnvelope, deps: MapDirectDeps): InvokeResult<unknown> {
  if (!deps.mapExportEnabled()) return fail(404, { error: "not found" });
  if (mapExportActiveBatch) {
    return fail(409, { ok: false, error: `已有导出批次在执行（${mapExportActiveBatch}），请等待完成后再发起` });
  }
  const body = bodyOf(payload);
  const workspace = deps.normalizeWorkspace(String(body.workspace || "")) || deps.getWorkspace();
  const plan = deps.planExportJobs({
    projects: body.projects,
    layerSets: body.layerSets,
    sizes: body.sizes,
    formats: body.formats,
    title: body.title
  });
  if (plan.errors.length) return fail(400, { ok: false, errors: plan.errors });
  const batchId = `batch-${Date.now()}-${++mapExportSeq}`;
  const batch: MapExportBatchRecord = {
    id: batchId,
    status: "running",
    workspace,
    total: plan.jobs.length,
    skipped: plan.skipped,
    summary: {
      total: plan.jobs.length,
      done: 0,
      failed: 0,
      results: plan.jobs.map((j: Record<string, unknown>) => ({ id: j.id, project: j.project, format: j.format, sizeId: j.sizeId, status: "pending" }))
    },
    createdAt: new Date().toISOString()
  };
  mapExportBatches.set(batchId, batch);
  mapExportActiveBatch = batchId;
  // 后台串行执行（不阻塞响应）；进度实时写回 batch.summary 供轮询。
  void deps
    .runExportQueue(plan.jobs, (job: Record<string, any>) => executeExportJob(job, workspace, deps), {
      onProgress: (snapshot: unknown) => { batch.summary = snapshot; }
    })
    .then((summary: Record<string, unknown>) => {
      batch.summary = summary;
      batch.status = summary.failed ? "completed-with-failures" : "completed";
      batch.finishedAt = new Date().toISOString();
    })
    .catch((e: unknown) => {
      batch.status = "failed";
      batch.error = String((e as { message?: unknown })?.message ?? e);
      batch.finishedAt = new Date().toISOString();
    })
    .finally(() => { if (mapExportActiveBatch === batchId) mapExportActiveBatch = null; });
  return ok({
    ok: true,
    batchId,
    total: plan.jobs.length,
    skipped: plan.skipped,
    jobs: plan.jobs.map(({ id, project, layers, sizeId, sizeLabel, width, height, format, fileName }: Record<string, any>) => ({ id, project, layers, sizeId, sizeLabel, width, height, format, fileName }))
  });
}

/** GET /api/map/export/batch（server L5363-5379 逐点转录：flag 门 404；id 空串同查无 →
 * 404 { ok:false, error:"批次不存在或服务已重启" }；响应快照白名单，error/finishedAt 缺省 ""）。 */
function invokeExportBatchStatus(payload: InvokeEnvelope, deps: MapDirectDeps): InvokeResult<unknown> {
  if (!deps.mapExportEnabled()) return fail(404, { error: "not found" });
  const id = String(queryOf(payload).id || "").trim();
  const batch = mapExportBatches.get(id);
  if (!batch) return fail(404, { ok: false, error: "批次不存在或服务已重启" });
  return ok({
    ok: true,
    id: batch.id,
    status: batch.status,
    total: batch.total,
    skipped: batch.skipped,
    summary: batch.summary,
    error: batch.error || "",
    createdAt: batch.createdAt,
    finishedAt: batch.finishedAt || ""
  });
}

/** POST /api/map/template/od-commuter（server L5383-5401 逐点转录：flag 门 404；错误
 * /越界|不存在|缺少|不是 OD|没有/ → 400 否则 500，信封 { ok:false, error }——与 report
 * 的 { error } 分叉，忠实转录）。 */
async function invokeTemplateOdCommuter(payload: InvokeEnvelope, deps: MapDirectDeps): Promise<InvokeResult<unknown>> {
  if (!deps.mapTemplatesEnabled()) return fail(404, { error: "not found" });
  const body = bodyOf(payload);
  const workspace = deps.normalizeWorkspace(String(body.workspace || "")) || deps.getWorkspace();
  try {
    const result = await deps.runOdCommuterTemplate({
      workspace,
      path: body.path,
      title: body.title,
      bands: body.bands,
      project: body.project,
      fileName: body.fileName
    });
    return ok({ ok: true, ...result });
  } catch (e) {
    const msg = String((e as { message?: unknown })?.message ?? e);
    return fail(/越界|不存在|缺少|不是 OD|没有/.test(msg) ? 400 : 500, { ok: false, error: msg });
  }
}

/* ------------------------------ style.json 动态读（F5-5） ------------------------------ */

/** GET /api/map/data/:project/style.json（server L592-608 动态路由逐点转录：文件缺失 404
 * { error: "style not found" }，JSON 解析失败 500，hydrate 底图注入 + 根相对瓦片 URL 绝对化）。
 * 桌面形态扩展：渲染层与 sidecar 不同源（file:// / vite dev），除 s.tiles 外将 style.glyphs
 * 与 geojson source.data 的根相对路径一并绝对化，MapLibre 资产加载可用。
 * R6-2 资产自持：已知资产前缀改写到 oaw-data:// 自定义协议（/api/map/data/* →
 * oaw-data://maps/*，/glyphs/* → oaw-data://glyphs/*，见 oaw-data-protocol.ts）；
 * 其余根相对路径保持原样（sidecar origin 兜底随 R6-4 退役）。
 * 语义差异声明：server 正则路由 ([^/]+) 对 ".." 无白名单（可达父目录，历史形态）；桌面侧
 * 沿用 map.ts projectDir 白名单收紧，非法名同 404 信封。 */
function invokeMapDataStyle(payload: InvokeEnvelope, deps: MapDirectDeps): InvokeResult<unknown> {
  const dir = deps.mapProjectDir(queryOf(payload).project);
  const file = dir ? pathJoin(dir, "style.json") : "";
  if (!file || !deps.dirProbe(file).exists) return fail(404, { error: "style not found" });
  try {
    const style = deps.hydrateBasemapSources(JSON.parse(deps.readStyleFile(file))) as Record<string, any>;
    const absolutize = (t: unknown) => {
      if (typeof t !== "string" || !t.startsWith("/")) return t;
      if (t.startsWith("/api/map/data/")) return `oaw-data://maps/${t.slice("/api/map/data/".length)}`;
      if (t.startsWith("/glyphs/")) return `oaw-data://glyphs/${t.slice("/glyphs/".length)}`;
      // 未知根相对路径：sidecar origin 兜底随 R6-4 退役，保持原样不再改写
      return t;
    };
    for (const s of Object.values(style.sources || {})) {
      if (Array.isArray((s as Record<string, unknown>)?.tiles)) {
        (s as Record<string, unknown>).tiles = ((s as Record<string, unknown>).tiles as unknown[]).map(absolutize);
      }
      if (typeof (s as Record<string, unknown>)?.data === "string") {
        (s as Record<string, unknown>).data = absolutize((s as Record<string, unknown>).data);
      }
    }
    if (typeof style.glyphs === "string") style.glyphs = absolutize(style.glyphs);
    return ok({ text: JSON.stringify(style) });
  } catch (e) {
    return err500(e);
  }
}

/* ------------------------------ 分发器 ------------------------------ */

/** 地图项目/图层族直调分发器（unknown channel → 404，与 http-forward catch-all 行为对齐）。 */
export async function invokeMapDirect(
  channel: string,
  payload: InvokeEnvelope | undefined,
  deps: MapDirectDeps
): Promise<InvokeResult<unknown>> {
  const envelope: InvokeEnvelope = payload ?? {};
  switch (channel as MapDirectChannel) {
    case "op:map:projects:list":
      return invokeProjectsList(deps);
    case "op:map:projects:create":
      return invokeProjectsCreate(envelope, deps);
    case "op:map:project:get":
      return invokeProjectGet(envelope, deps);
    case "op:map:project:export":
      return invokeProjectExport(envelope, deps);
    case "op:map:projects:duplicate":
      return invokeProjectsDuplicate(envelope, deps);
    case "op:map:projects:rename":
      return invokeProjectsRename(envelope, deps);
    case "op:map:projects:archive":
      return invokeProjectsArchive(envelope, deps);
    case "op:map:projects:delete":
      return invokeProjectsDelete(envelope, deps);
    case "op:map:style:save":
      return invokeStyleSave(envelope, deps);
    case "op:map:config:save":
      return invokeConfigSave(envelope, deps);
    case "op:map:import":
      return invokeImport(envelope, deps);
    case "op:map:import:batch":
      return invokeImportBatch(envelope, deps);
    case "op:map:prepare":
      return invokePrepare(envelope, deps);
    case "op:map:rebuild":
      return invokeRebuild(envelope, deps);
    case "op:map:layer:delete":
      return invokeLayerDelete(envelope, deps);
    case "op:map:layer:get":
      return invokeLayerGet(envelope, deps);
    case "op:map:isochrone":
      return invokeIsochrone(envelope, deps);
    case "op:map:route":
      return invokeRoute(envelope, deps);
    case "op:map:project:detail":
      return invokeProjectDetail(envelope, deps);
    case "op:map:project:style:save":
      return invokeProjectStyleSave(envelope, deps);
    case "op:map:project:config:save":
      return invokeProjectConfigSave(envelope, deps);
    case "op:map:project:import":
      return invokeProjectImport(envelope, deps);
    case "op:map:project:rebuild-tiles":
      return invokeProjectRebuildTiles(envelope, deps);
    case "op:map:project:layer:get":
      return invokeProjectLayerGet(envelope, deps);
    case "op:map:project:layer:delete":
      return invokeProjectLayerDelete(envelope, deps);
    case "op:map:project:isochrone":
      return invokeProjectIsochrone(envelope, deps);
    case "op:map:visual:sources":
      return invokeVisualSources(deps);
    case "op:map:visual:get":
      return invokeVisualGet(envelope, deps);
    case "op:map:traffic-bandwidth":
      return invokeTrafficBandwidth(envelope, deps);
    case "op:map:od-lines":
      return invokeOdLines(envelope, deps);
    case "op:map:multi-isochrone":
      return invokeMultiIsochrone(envelope, deps);
    case "op:map:exchange-sankey":
      return invokeExchangeSankey(envelope, deps);
    case "op:map:road-structure":
      return invokeRoadStructure(envelope, deps);
    case "op:map:demo-analysis":
      return invokeDemoAnalysis(envelope, deps);
    case "op:map:cambodia-od":
      return invokeCambodiaOd(envelope, deps);
    case "op:map:m3:bus-routes":
      return invokeM3BusRoutes(deps);
    case "op:map:m3:station-heatmap":
      return invokeM3StationHeatmap(deps);
    case "op:map:m3:od-lines":
      return invokeM3OdLines(deps);
    case "op:map:m3:network-stats":
      return invokeM3NetworkStats(deps);
    case "op:map:report":
      return invokeReport(envelope, deps);
    case "op:map:export:batch:start":
      return invokeExportBatchStart(envelope, deps);
    case "op:map:export:batch:status":
      return invokeExportBatchStatus(envelope, deps);
    case "op:map:template:od-commuter":
      return invokeTemplateOdCommuter(envelope, deps);
    case "op:map:data:style":
      return invokeMapDataStyle(envelope, deps);
    default:
      return fail(404, { error: `unknown channel: ${channel}` });
  }
}
