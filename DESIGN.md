---
title: Open Plan 设计文档
summary: 规聚 v0.11.55 基线的产品定位、设计目标、业务能力域与总体架构设计
keywords: [规聚, Open Plan, 设计目标, 总体架构, 业务能力, Pi Agent, 地图 GIS]
status: done
date: 2026-10-19
---

# Open Plan - 设计文档

当前基线：**v0.11.55**（package.json `0.11.55`，变更日志最新已发布条目 v0.11.55 / 2026-10-15，其后为 10 批未发布的 Qoder 对标优化，全部由运行开关控制、默认关闭）。

> 术语：规聚（Open Plan）=「规划 + 聚集」。本文回答"产品是什么、为什么这样设计、整体长什么样"；模块级接口契约见 `docs/module-design/`，历史决策依据见 `docs/decisions/`。

## 1. 产品定位与设计目标

### 1.1 一句话定位

面向交通规划工程师的 AI 一体化工作台：把 Office 文档、知识库、地图 GIS、模板库与 AI Agent 协作聚到同一个 Web 工作台，让工程师用自然语言驱动文档编制、数据分析与地图可视化的完整工作流。

### 1.2 设计目标

1. **领域优先**：一切能力围绕交通规划工程师的真实工作流（现状调研 → 数据分析 → 方案编制 → 图纸/地图 → 汇报材料），而不是通用聊天壳。
2. **Agent 与人对等协作**：Agent 能读写的，人也能在界面上做（反之亦然）——Agent 的文档修改实时反映到预览，人的批注 Agent 可读；UI 操作与 Agent 工具保持能力对等。
3. **过程可信**：每轮任务有 TaskEnvelope、run manifest、产物归属与回滚；结论必须可溯源（来源/修改/产物/假设/下一步五要素固定总结）。
4. **稳定优先于新功能**：事件注册表统一治理、SSE 流预算与去重、断线自愈、工作区隔离；回归测试即脚本（`node scripts/*.mjs`）纳入 CI。
5. **渐进演进不换内核**：Pi Agent SDK 为运行时内核，自研能力以适配层与 feature flag 渐进叠加，保持可回滚（见 BRD-001 / BRD-003）。

### 1.3 非目标（不做清单）

- 不修改 Pi 内核、不复制 Pi 源码；不引入 Pi 原生 subagent / plan mode（能力走 skill 与前端工作流）。
- 不做通用皮肤/主题引擎（只做暗/亮两主题 + Qoder 视觉层 opt-in）。
- 不重写手写 SSE 解析层（已有流预算与去重防护）。
- 第一阶段不做云端 SaaS 多租户（先内网多用户，见 BRD-006）。

## 2. 业务目标与能力域

产品能力分为六大域（业务需求的逐条定义见 `REQUIREMENTS.md`）：

| 能力域 | 业务目标 | 关键载体 |
|---|---|---|
| 文档办公 | Word/PPT/Excel 高保真查看与编辑，批注精确定位与修订痕迹，支撑报告编制日常 | DocViewer 系、office/doc-engine、officecli |
| AI 协作 | 90+ 模型可切换、流式对话、任务进度卡、ask_user 主动询问、办公/开发双模式 | ChatPanel、agent.mjs、pi-runtime |
| 知识库 | Obsidian 风格三视图（浏览/思维图谱/脑图）、加权全文检索、双向链接、@ 引用分析 | KnowledgeBase 系、kb.mjs |
| 地图 GIS | MapLibre 矢量瓦片地图 + QGIS 风格图层管理 + Agent 驱动的地图编辑与分析（等时圈/OD/网络分配） | MapPanel 系、map-* 模块族 |
| 模板库 | 318 个模板（含 106 个 OpenDesign HTML PPT），报告/汇报材料速成 | TemplateLibrary、templates/ |
| 记忆与智能 | AGENTS.md + 分层记忆、memory_update 建议-确认、智能体广场、声明式领域工作流 | memory-*、workflow-registry、AgentMarket |

## 3. 总体架构

```
浏览器 (React 18 SPA, Vite 5)
─────────────────────────────────────────────────────
 三栏办公布局（默认）           知识库全屏模式
 ├ SessionSidebar 左栏          ├ 目录树/搜索/IMA 云端
 ├ DocViewer 中栏（文档/地图/    ├ Markdown 预览 + G6 知识图谱
 │  任务中心/产物面板分派）      └ 文档信息面板（双链/反链/标签）
 └ ChatPanel 右栏（对话流/工具
    卡片/审批/进度/结论卡）
─────────────────────────────────────────────────────
        │ REST (POST/GET)   SSE (GET /api/agent/stream)
        ▼
Express 5 服务端 (localhost:3002, Node ≥ 22)
─────────────────────────────────────────────────────
 路由编排层   index.mjs（≈207 个路由注册点）
 会话/Agent   agent.mjs · subagent-orchestrator · approval-policy · command-safety-policy
 事件流       event-registry(115 种) · event-protocol · event-normalization
             event-storage · stream-connection（预算/去重/自愈）
 运行与产物   runs · run-trace · run-budget · turn-budget · artifact-credibility/rollback
 地图 GIS     map · map-visualization · map-analysis · map-report
             map-template · layer-repository · spatial-analysis · traffic-sources · batch-export
 Office       office · doc-engine · office-params · native-files
 知识库       kb.mjs（kb.json 配置 · 本地索引 · IMA 代理）
 工作流       workflow-registry · workflow-validation · workflows/
 Pi 配置      pi-runtime · pi-config · pi-network-proxy · provider-catalog · models-dev-catalog
 其他         builtin-browser · web-search · web-reader · mcp-management · memory-*
─────────────────────────────────────────────────────
        │ 进程内 SDK 调用
        ▼
Pi Agent SDK (@earendil-works/pi-coding-agent 1.1.0)
 createAgentSession · ModelRuntime · SessionManager · DefaultResourceLoader
 自定义工具族：officecli · kb_search/kb_read · map_read/map_edit/map_import/map_analyze…
```

要点：

- **单进程 Express 承载全部业务**，Pi SDK 进程内嵌入，API Key 与文件权限不出服务端。
- **所有对外事件经事件注册表**（event-registry）注册与校验，前端按注册表消费，杜绝协议漂移（115 种事件有一致性回归守护）。
- **工作区（office-workspace/）是默认运行时数据目录**，可切换、可校验，会话/产物/地图项目均落工作区。

## 4. 前端结构（client/src/）

- `App.jsx` + 19 个纯函数模块：`run-trace.js`（轨迹归约）、`run-display-projection.js`（运行展示投影）、`stream-budget.js`（流预算）、`layer-registry.js`（图层注册表）、`event-display.js`（事件展示映射）、`persist-ui.js` 等——**展示逻辑与组件分离，纯函数可回归测试**。
- `components/` 54 个组件，按域分组：
  - 对话流：ChatPanel（折叠/结论内嵌/审批卡/模型选择）及其子卡
  - 文档：DocViewer / DocxViewer / PptxViewer / ExcelGrid / MarkdownBody / CommentMarker
  - 地图：MapPanel / MapViewer / 可视面板（图层/属性表/测量/等时圈）
  - 任务与产物：TaskCenter / 任务进度卡 / SubagentDetailPanel
  - 入口与配置：SessionSidebar / AgentMarket / WorkflowLauncher / SettingsPanel / ProviderLibrary
- 状态无全局 store，组件内 state + 纯函数投影；SSE 事件按 event-registry 白名单消费。

## 5. 通信机制

### 5.1 会话链路

1. `POST /api/agent/prompt` 发送指令（含附件）→ 服务端创建/复用 Agent 会话。
2. `GET /api/agent/stream` SSE 长连接推送事件流（token/thinking/tool/审批/产物/结论…，全量 115 种见 event-registry）。
3. `GET /api/agent/abort` 中断（结果回传 runId，带 stillQueued 语义，10 秒确认窗兜底）。
4. 流侧防护：`stream-budget.js` 预算与去重，切工作区/切会话不卡死。

### 5.2 路由族（按域概述）

`/api/files*`、`/api/doc/:file*`（正则路由兼容中文文件名）、`/api/office`、`/api/sessions*`、`/api/runs*`、`/api/workflows*` 与 `/api/domain-workflows*`、`/api/models*`、`/api/skills*`、`/api/workspaces*`、`/api/agent*`、`/api/kb/*`、`/api/templates*`、`/api/map*`、`/api/memory*`、`/api/agents*`（子代理）、`/api/browser*`（内置浏览器）、`/api/status`（健康检查 + runtimeFlags）。

完整路由表以 `server/index.mjs` 为准（≈207 个注册点），模块级契约在 `docs/module-design/` 逐域补充。

## 6. 关键设计

### 6.1 Agent 会话与工具

- `createAgentSession()` 常驻会话；每轮注入 TaskEnvelope、当前工作区、分层记忆与 KB 使用说明；完成后要求五要素固定总结（来源/修改/产物/假设/下一步）。
- 工具族：officecli（文档）、kb_search/kb_read（知识库）、map_read/map_edit/map_import/map_analyze/map_template（地图）、web-search/web-reader（联网）、builtin-browser（浏览器）。
- 审批：approval-policy 按工具风险分级；高危命令经 command-safety-policy 拦截。

### 6.2 事件注册表（治理核心）

- 所有 SSE 事件在 `server/event-registry.mjs` 注册（名称/负载 schema/语义），共 115 种。
- `scripts/event-registry-test.mjs` 守护注册表一致性；前端 `event-display.js` 按事件映射展示形态。
- 新增事件必须先注册再使用——这是"稳定优先"目标的落点。

### 6.3 运行与产物可信度

- run manifest 记录每轮的执行轨迹（run-trace 归约：工具聚合/完成语义/每轮用时与 token）。
- 产物带归属分层（agent 产物 vs 会话衍生），支持显式回滚与固定口径（artifact-credibility/rollback）。
- 预算双轨：run-budget（运行级）与 turn-budget（轮次级）控制 token/时长。

### 6.4 地图 Agent 化

- 阶段 0-5 演进：只读能力与临时层 → 图层模型（归属/选择器/审批/分组）→ 面板收敛 → 对话栏适配 → 交通数据源与可视化描述符。
- Agent 通过 map_* 工具读写图层；可视化描述符统一驱动前端渲染；地图项目落工作区 `maps/`。

### 6.5 内置浏览器与联网

- builtin-browser：headless Edge/Chrome 经 CDP 截图流 + 用户坐标接管 + Agent 操作队列。
- web-search/web-reader 提供检索与正文抽取；MCP 管理支持外部工具接入。

## 7. 设计规范

### 配色（pi dark 主题，默认）
```
:root (dark):
--body-bg:   #1a1a2e   --panel-bg:  #16162a
--panel2-bg: #1e1e3a   --surface:   #222240
--text:      #d4d4d4   --muted:     #808080
--dim:       #666666   --accent:    #8abeb7
--border:    #3a3a5c   --selected:  #3a3a4a
--error:     #cc6666   --success:   #b5bd68
--warning:   #f0c674   --user-bg:   #2a3a3a
```

### 亮色主题（[data-theme="light"]）
```
--body-bg:   #f5f6fa   --panel-bg:  #ffffff
--panel2-bg: #eef0f6   --surface:   #e4e7f0
--text:      #2d3142   --muted:     #5c6270
--dim:       #8a8fa3   --accent:    #2a8c82
--border:    #d4d8e4   --selected:  #dfe4ee
--error:     #c0392b   --success:   #5c7a1f
--warning:   #b7791f   --user-bg:   #e6f0ee
```
主题切换：ThemeProvider（theme.jsx），`document.documentElement.setAttribute("data-theme", ...)`，localStorage key `oaw_theme`。

### 设计令牌三层结构（2026-10-18 起）
后两层只允许引用上一层；新增颜色必须落到令牌层，不得在规则里直写色值——由一致性测试的「硬编码色值棘轮」守护（当前 393 处 / 129 种，只允许下降）。

第 1 层 · 基础色阶（只声明取值，不带语义）
```
--op-gray-000 → --op-gray-900   共 13 阶（暗色方向 000 最暗、900 最亮）
--op-blue-400/500/600   --op-green-500   --op-red-500   --op-amber-500
```

第 2 层 · 语义令牌（只引用基础色阶 / 前景透明度，不写死基础层已提供的色值）
```
--body-bg  --panel-bg  --panel2-bg  --surface  --text  --muted  --dim
--border  --selected  --accent  --accent-hi  --success  --error  --warning
--user-bg  --user-fg      （成对声明：无障碍测试会校验配对）
```

第 3 层 · 组件变量（组件只消费本层）
```
--op-comp-chat-bg  --op-comp-toolcard-border
--op-comp-toolcard-pending  --op-comp-toolcard-success  --op-comp-toolcard-error
```

以上三层**目前只存在于 Qoder 视觉层**（见下节）；默认主题仍使用本文档上方「配色 / 亮色主题」两节的取值。

### Qoder 视觉层（opt-in · 默认关）
- **生效条件**：`<html data-oaw-style="qoder">`；由运行开关 `qoderStyle` / `OAW_QODER_STYLE` 控制，**默认关闭**——关闭时外观逐像素回到 pi-dark 基线（只「覆盖」变量取值，不删不改名任何既有规则）。
- **内容**：整站配色（中性灰阶打底 + 单一冷蓝强调 + 语义三色统一饱和）；令牌三层结构；组件交互规范（执行流状态点五态、思考块左竖线、工具卡片状态色边条、审批卡形态条）。
- **动效令牌**：`--dur-fast 120ms / --dur-base 200ms / --dur-slow 320ms / --ease-out`，只作用于 `transform` / `opacity`；动效闸门（`data-reduce-motion` / `data-motion-level="off"`）可强制覆盖。
- **回滚**：开关级 / 单文件级 / 整站级三层，见 `docs/plans/2026-10-18-004-Qoder优化开关与回滚说明.md`。

### 排版与字体（现状 · 2026-10-18 核对）
- 正文：系统 sans 栈 —— `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif`。
- 代码 / 路径 / 参数 / 数字：等宽栈 —— `ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, monospace`。
- **待办（需确认）**：`--font-sans` / `--font-mono` 令牌化尚未做（要改基线 `body` 字体声明行，改动等确认）。

## 8. 文档索引

| 主题 | 文档 |
|---|---|
| 需求基线 | `REQUIREMENTS.md` |
| 架构总览（数据流/事件治理/目录模型） | `docs/module-design/架构总览.md` |
| 关键决策（ADR） | `docs/decisions/BRD-001-*.md` 起 |
| 演进路线与后续计划 | `docs/plans/2026-10-19-001-规聚产品基线与后续开发路线.md` |
| 版本演进明细 | `变更日志.md` |
| 开发代理约束 | `AGENT.MD` |
