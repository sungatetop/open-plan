/**
 * 运行开关（优化项统一 feature flag 管道）。
 *
 * 评审 R8 约束：所有优化项的开关统一由本模块读取（env 解析 + 默认值 + 只读快照），
 * 禁止各业务模块直读 process.env，避免开关语义分叉；快照经 /api/status 下发前端。
 *
 * 开关语义：
 *   - 每个开关只影响对应优化项的新路径；off（默认）时代码路径与历史基线行为一致。
 *   - 取值：环境变量命中 "1"/"true"/"on"（不区分大小写）视为开启，其余视为关闭。
 */

const TRUTHY = new Set(["1", "true", "on", "yes"]);

function readFlag(name) {
  const raw = String(process.env?.[name] ?? "").trim().toLowerCase();
  return TRUTHY.has(raw);
}

function readPositiveInt(name, fallback) {
  const raw = Number.parseInt(String(process.env?.[name] ?? ""), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** 逗号/分号分隔的字符串列表（B5 域名白名单等配置型开关）。 */
function readStringList(name) {
  return String(process.env?.[name] ?? "")
    .split(/[,，;；\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

/* ===== Qoder 对标优化开关族（报告：Qoder对标评审与交通规划Harness方案）=====
   全部默认关 = 与历史基线行为完全一致；OAW_QODER_ALIGN=1 可一键打开整族用于预览，
   关掉即整体回滚，无需改代码、无残留。 */
const QODER_ALIGN = readFlag("OAW_QODER_ALIGN");

/** 只读快照：进程内唯一事实。模块加载时解析一次（服务生命周期内不热更）。 */
export const RUNTIME_FLAGS = Object.freeze({
  /** U2+U6：Pi 把关扩展（ToolCallEvent 单工具拦截 + 压缩生命周期事件增强） */
  piToolGateExtension: readFlag("OAW_PI_TOOL_GATE"),
  /** U5：bash 侧车执行（operations 派发到子进程） */
  piBashSidecar: readFlag("OAW_PI_SIDECAR"),
  /** U8：事件规范化管道（normalizePiEvent 接入 emit 前置） */
  eventNormalize: readFlag("OAW_EVENT_NORMALIZE"),
  /** U9：新工作区首次打开信任位（ProjectTrustStore 薄封装） */
  projectTrustGate: readFlag("OAW_PROJECT_TRUST_GATE"),
  /** U10：供应商提示词缓存保活（Pi 原生 CacheWarmer，streaming 模式：Run 进行中保活） */
  cacheWarming: readFlag("OAW_CACHE_WARMING"),
  /** U5 侧车空闲回收时间（毫秒，默认 10 分钟） */
  piBashSidecarIdleMs: readPositiveInt("OAW_PI_SIDECAR_IDLE_MS", 10 * 60 * 1000),
  /** 交互优化 P1：staged 产物在任务运行中即对产物面板可见（默认关：保持 run_finished 后可见） */
  stagedVisible: readFlag("OAW_STAGED_VISIBLE"),
  /** 交互优化 P2：run_finished 智能自动切产物页签（默认关） */
  autoTab: readFlag("OAW_AUTO_TAB"),
  /** 交互优化 P3：浏览器手关后对话侧活动徽标（默认关） */
  browserBadge: readFlag("OAW_BROWSER_BADGE"),
  /** 交互优化 P7：窄屏开浏览器记忆/恢复预览栏状态（默认关） */
  narrowRestore: readFlag("OAW_NARROW_RESTORE"),
  /** 交互优化 P8：浏览器帧流重连中与工具成功的对账提示（默认关） */
  reconcileHint: readFlag("OAW_RECONCILE_HINT"),
  /** 前端反馈基座：toast/confirmDialog 替代原生 alert/confirm（默认关=原生回退） */
  feedbackV2: readFlag("OAW_FEEDBACK_V2"),
  /** 浏览器 B3：面板不可见时自适应/暂停 screencast 推流（默认关） */
  browserAdaptiveStream: readFlag("OAW_BROWSER_ADAPTIVE_STREAM"),
  /** 浏览器 B4：整页截图与 PDF 导出底座（默认关） */
  browserFullpage: readFlag("OAW_BROWSER_FULLPAGE"),
  /** 浏览器 B5：导航 URL 防护（file:// 拒绝 + 域名白名单，默认关） */
  browserUrlGuard: readFlag("OAW_BROWSER_URL_GUARD"),
  /** B5 白名单配置：域名列表（留空 = 放行全部 http/https；子域名自动匹配） */
  browserUrlAllowlist: readStringList("OAW_BROWSER_URL_ALLOWLIST"),
  /** 会话恢复 A3：busy 看门狗（busy 期间超时无 Pi 事件活动则强制放行，默认关） */
  agentBusyWatchdog: readFlag("OAW_BUSY_WATCHDOG"),
  /** A3 阈值：busy 无事件活动多久后放行（毫秒，默认 15 分钟） */
  agentBusyWatchdogMs: readPositiveInt("OAW_BUSY_WATCHDOG_MS", 15 * 60 * 1000),
  /** 会话恢复 A2：恢复遇忙时前端自动等待任务结束后重试（默认关） */
  resumeAutoRetry: readFlag("OAW_RESUME_AUTO_RETRY"),
  /** GIS G1：空间分析算子（buffer/spatial_filter/bbox_clip，默认关） */
  spatialAnalysis: readFlag("OAW_SPATIAL_ANALYSIS"),
  /** GIS G8：地图分析报告一键成文（/api/map/report + 面板按钮，默认关） */
  mapReport: readFlag("OAW_MAP_REPORT"),
  /** GIS G7：批量导出队列（多项目×多图层×多尺寸×PNG/PDF，默认关；PDF/截图复用 B4 底座） */
  mapExport: readFlag("OAW_MAP_EXPORT"),
  /** GIS G2：外部数据适配器（live-traffic-api / sql-database，默认关） */
  dataAdapters: readFlag("OAW_DATA_ADAPTERS"),
  /** GIS G3：高德 MCP 桥（mcp.amap.com 官方 ?key= 协议豁免 + 预置模板，默认关） */
  amapMcpBridge: readFlag("OAW_AMAP_MCP_BRIDGE"),
  /** GIS G9：地图项目打包 zip 归档导出（默认关） */
  mapPack: readFlag("OAW_MAP_PACK"),
  /** GIS G5：场景化分析模板（v1 仅 OD 通勤分析，默认关） */
  mapTemplates: readFlag("OAW_MAP_TEMPLATES"),
  /** GIS G10-v1：视图书签（视角收藏与一键恢复，默认关） */
  mapBookmarks: readFlag("OAW_MAP_BOOKMARKS"),
  /** 会话恢复 A4：运行中刷新恢复（冷启动探测 LIVE Run + Run 起点整段回放 + 恢复内容新建气泡，默认关） */
  replayRecover: readFlag("OAW_REPLAY_RECOVER"),
  /** Qoder 对标总开关：打开后整族优化项生效（默认关；关掉即整体回滚） */
  qoderAlign: QODER_ALIGN,
  /** Qoder P0-1：SSE 重连退避加入抖动与退避上限放宽（默认关 = 基线固定倍增 500ms→5s 封顶） */
  qoderSseBackoff: readFlag("OAW_QODER_SSE_BACKOFF") || QODER_ALIGN,
  /** Qoder P0-4：Qoder/Codex 视觉令牌层（默认关 = pi-dark 基线配色；打开即整站换色，关掉零残留） */
  qoderStyle: readFlag("OAW_QODER_STYLE") || QODER_ALIGN,
  /** Qoder P0-2：对话流有界有序背压（默认关 = 基线直接 res.write，写不进去时由 Node 内部无上限缓冲） */
  qoderSseBackpressure: readFlag("OAW_QODER_SSE_BACKPRESSURE") || QODER_ALIGN,
  /** Qoder P0-2 队列上限（字节，默认 4 MiB）：排队字节超过即收束连接，交由重连回放补齐 */
  qoderSseQueueMaxBytes: readPositiveInt("OAW_QODER_SSE_QUEUE_MAX_BYTES", 4 * 1024 * 1024),
  /** Qoder P0-3：中断后残余消息排空（默认关 = 基线立即发 aborted，不等在途消息） */
  qoderDrainOnAbort: readFlag("OAW_QODER_DRAIN_ON_ABORT") || QODER_ALIGN,
  /** Qoder P0-3 排空上限（毫秒，默认 1500）：超过即强制发 aborted，避免中断收尾被无限拖长 */
  qoderDrainMaxMs: readPositiveInt("OAW_QODER_DRAIN_MAX_MS", 1500),
  /** Qoder P0-3 静默判定（毫秒，默认 300）：通道持续静默这么久即视为在途消息已排空 */
  qoderDrainQuietMs: readPositiveInt("OAW_QODER_DRAIN_QUIET_MS", 300),
  /* ===== P2 打磨层（均为配置型开关，不设环境变量时行为与基线完全一致）===== */
  /** P2-2：对话流 SSE 心跳间隔（毫秒，默认 = 基线 5000；前端看门狗会按它派生） */
  heartbeatChatMs: readPositiveInt("OAW_HEARTBEAT_CHAT_MS", 5000),
  /** P2-2：事件流 SSE 心跳间隔（毫秒，默认 = 基线 15000） */
  heartbeatEventsMs: readPositiveInt("OAW_HEARTBEAT_EVENTS_MS", 15000),
  /** P2-2：浏览器帧流心跳间隔（毫秒，默认 = 基线 15000） */
  heartbeatBrowserMs: readPositiveInt("OAW_HEARTBEAT_BROWSER_MS", 15000),
  /** P2-4：视觉特效降级（默认关 = 保留背景模糊与动画；打开则去模糊、去长动效） */
  visualEffectsOff: readFlag("OAW_VISUAL_EFFECTS_OFF"),
  /** P2-1：SSE 事件缺号告警（默认关 = 不记录游标跳变；打开则在缺号时记入长连接诊断） */
  qoderSeqGapAlert: readFlag("OAW_QODER_SEQ_GAP_ALERT") || QODER_ALIGN,
  /* ===== P1 架构收口（可开关化部分）===== */
  /** P1-5：服务端按 path 的连接配额（默认关 = 不检查，行为与基线一致；打开则超限返回 503 + Retry-After） */
  streamQuota: readFlag("OAW_STREAM_QUOTA") || QODER_ALIGN,
  /** P1-5 拒绝时的 Retry-After 秒数（默认 5） */
  streamQuotaRetryAfterSeconds: readPositiveInt("OAW_STREAM_QUOTA_RETRY_AFTER_S", 5),
  /** P1-2：事件负载结构校验（默认关 = 不校验；打开则只告警并计数，不改变落盘与投递行为） */
  eventSchemaCheck: readFlag("OAW_EVENT_SCHEMA_CHECK") || QODER_ALIGN,
  /** P1-8：右侧对象栏（本轮对象聚合：产出/来源/技能与 MCP/网页查阅/记忆 + 环境信息 + 后台进程） */
  qoderObjectBar: readFlag("OAW_QODER_OBJECT_BAR") || QODER_ALIGN,
  /** §4：声明式交通规划领域工作流（注册表 + 六个声明 + preflight 硬约束，默认关 = 不加载也不下发） */
  domainWorkflows: readFlag("OAW_DOMAIN_WORKFLOWS") || QODER_ALIGN,
  /** Qoder P0-2：超大 tool_output 单帧切分（默认关 = 原样单帧下发，与基线逐字一致） */
  qoderToolOutputSplit: readFlag("OAW_QODER_TOOL_OUTPUT_SPLIT") || QODER_ALIGN,
  /** Qoder P0-2 单帧上限（字节，默认 256 KiB）：超过即切为 tool_output_delta 增量帧 */
  qoderToolOutputFrameMaxBytes: readPositiveInt("OAW_QODER_TOOL_OUTPUT_FRAME_MAX_BYTES", 256 * 1024),
  /** P1-4：交互（HITL）归属——ask_user / tool_approval_request 载荷附带 owner{kind,id}（默认关 = 载荷与基线逐字一致） */
  qoderInteractionOwner: readFlag("OAW_QODER_INTERACTION_OWNER") || QODER_ALIGN,
});

/** /api/status 下发形态：布尔与数值分开，前端只读布尔位。 */
export function runtimeFlagsSnapshot() {
  return {
    piToolGateExtension: RUNTIME_FLAGS.piToolGateExtension,
    piBashSidecar: RUNTIME_FLAGS.piBashSidecar,
    eventNormalize: RUNTIME_FLAGS.eventNormalize,
    projectTrustGate: RUNTIME_FLAGS.projectTrustGate,
    cacheWarming: RUNTIME_FLAGS.cacheWarming,
    stagedVisible: RUNTIME_FLAGS.stagedVisible,
    autoTab: RUNTIME_FLAGS.autoTab,
    browserBadge: RUNTIME_FLAGS.browserBadge,
    narrowRestore: RUNTIME_FLAGS.narrowRestore,
    reconcileHint: RUNTIME_FLAGS.reconcileHint,
    feedbackV2: RUNTIME_FLAGS.feedbackV2,
    browserAdaptiveStream: RUNTIME_FLAGS.browserAdaptiveStream,
    browserFullpage: RUNTIME_FLAGS.browserFullpage,
    browserUrlGuard: RUNTIME_FLAGS.browserUrlGuard,
    agentBusyWatchdog: RUNTIME_FLAGS.agentBusyWatchdog,
    resumeAutoRetry: RUNTIME_FLAGS.resumeAutoRetry,
    spatialAnalysis: RUNTIME_FLAGS.spatialAnalysis,
    mapReport: RUNTIME_FLAGS.mapReport,
    mapExport: RUNTIME_FLAGS.mapExport,
    dataAdapters: RUNTIME_FLAGS.dataAdapters,
    amapMcpBridge: RUNTIME_FLAGS.amapMcpBridge,
    mapPack: RUNTIME_FLAGS.mapPack,
    mapTemplates: RUNTIME_FLAGS.mapTemplates,
    mapBookmarks: RUNTIME_FLAGS.mapBookmarks,
    replayRecover: RUNTIME_FLAGS.replayRecover,
    qoderAlign: RUNTIME_FLAGS.qoderAlign,
    qoderSseBackoff: RUNTIME_FLAGS.qoderSseBackoff,
    qoderStyle: RUNTIME_FLAGS.qoderStyle,
    qoderSseBackpressure: RUNTIME_FLAGS.qoderSseBackpressure,
    qoderDrainOnAbort: RUNTIME_FLAGS.qoderDrainOnAbort,
    visualEffectsOff: RUNTIME_FLAGS.visualEffectsOff,
    qoderSeqGapAlert: RUNTIME_FLAGS.qoderSeqGapAlert,
    streamQuota: RUNTIME_FLAGS.streamQuota,
    eventSchemaCheck: RUNTIME_FLAGS.eventSchemaCheck,
    qoderObjectBar: RUNTIME_FLAGS.qoderObjectBar,
    domainWorkflows: RUNTIME_FLAGS.domainWorkflows,
    qoderToolOutputSplit: RUNTIME_FLAGS.qoderToolOutputSplit,
    qoderInteractionOwner: RUNTIME_FLAGS.qoderInteractionOwner,
    // 数值位：前端 numberFlag() 读取（心跳间隔需下发给前端派生看门狗阈值）。
    heartbeatChatMs: RUNTIME_FLAGS.heartbeatChatMs,
    heartbeatEventsMs: RUNTIME_FLAGS.heartbeatEventsMs,
    heartbeatBrowserMs: RUNTIME_FLAGS.heartbeatBrowserMs,
  };
}
