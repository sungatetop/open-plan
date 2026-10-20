---
title: Electron一体化TypeScript重构方案
summary: 将 server 功能收进 Electron Node 侧后端、前端以 TS+React 重建为 Electron 界面的完整重构设计：目录结构、IPC 协议、TS 迁移策略、功能等价守护与 R0-R6 里程碑
keywords: [Electron, TypeScript, React, 重构方案, IPC, monorepo, 功能等价]
status: in-progress
date: 2026-10-19
---

# Electron 一体化 TypeScript 重构方案

> 决策依据：[BRD-009-Electron一体化与TypeScript全面重构](../decisions/BRD-009-Electron一体化与TypeScript全面重构.md)（取代 BRD-008 sidecar 路线）。基线 v0.11.55。

## 1. 架构立场：Electron = 前后端一体

Electron 的 Node 侧（主进程）**就是后端运行时**——现有 Express server 的全部能力（Agent 会话、Pi SDK、地图分析、Office 引擎、知识库、工作流）直接在 Electron 内承载，不需要独立服务进程、不需要端口监听：

```
┌────────────────────────── Electron 应用（electron/）──────────────────────────┐
│                                                                              │
│  主进程 main/（Node 侧 = 应用后端）                                            │
│  ├─ 后端服务 backend/：由 server/ 76 个 JS 模块 TS 化迁入                      │
│  │    agent · map · office · kb · workflow · runtime(事件/运行/预算) · pi …   │
│  ├─ ipc/：IPC 路由层（请求/响应 + 事件推送，取代 HTTP/SSE）                     │
│  ├─ platform/：窗口/托盘/更新/文件对话框/WebContentsView 浏览器宿主             │
│  └─ 按需隔离：officecli 子进程、空间分析等重计算可落 utilityProcess（实现细节）  │
│            ↕ contextBridge（preload 仅暴露 typed api）                        │
│  渲染进程 renderer/（前端 = Electron 界面）                                    │
│  └─ TS + React 重建：由 client/ 54 组件 + 19 纯函数分域迁移                    │
│                                                                              │
│  shared/：前后端共享类型与协议（事件 schema = 单一事实源）                       │
└──────────────────────────────────────────────────────────────────────────────┘
```

与上一版（BRD-008 sidecar）的本质差异：

| 维度 | BRD-008 sidecar | 本方案 |
|---|---|---|
| 后端形态 | 独立 Node 进程 + Express :3002 | Electron Node 侧内嵌，无端口暴露 |
| 通信 | HTTP/SSE | IPC（invoke + 事件推送） |
| 前端 | 复用 JS client/ | TS + React 重建 |
| 类型 | 无（JS） | TS strict 全栈 + typebox 协议类型打通 |
| 迁移方式 | 不改代码 | 绞杀者式分域迁移，功能等价验收 |

**技术栈**：Electron 33+ · TypeScript 5 strict · React 18 · Vite 5（electron-vite 统一 main/preload/renderer 构建）· typebox（协议 schema，项目已有依赖）· vitest（测试）· electron-builder（NSIS 打包）· electron-updater。

## 2. 目录结构（新建 electron/，monorepo）

```
electron/
├── package.json              独立包（electron-builder / electron-vite / vitest）
├── tsconfig.json             TS strict 基座（含 strict: true, noUncheckedIndexedAccess）
├── electron-builder.yml
├── src/
│   ├── shared/               ── 前后端共享（协议单一事实源）──
│   │   ├── protocol/             事件/请求/响应 schema（typebox → Static 类型）
│   │   │   ├── events.ts             115 种事件（从 server/event-registry.mjs 迁移）
│   │   │   ├── channels.ts           IPC 通道名与负载类型（对齐现有 REST 路由族）
│   │   │   └── domain/               各域 DTO（map/office/kb/run/artifact…）
│   │   └── utils/                共享纯函数（坐标校验、OD 校验等）
│   ├── main/                 ── Node 侧后端 + 平台 ──
│   │   ├── index.ts              入口：app 生命周期/单实例锁/窗口
│   │   ├── backend/              业务后端（server/ 逐域 TS 化迁入）
│   │   │   ├── runtime/              event-registry(115 种)·event-storage·run-trace·run-budget·artifact-*
│   │   │   ├── agent/                agent 会话·subagent-orchestrator·approval-policy·command-safety-policy
│   │   │   ├── office/               office·doc-engine·office-params·native-files
│   │   │   ├── map/                  map·map-visualization·map-analysis·layer-repository·spatial-analysis·traffic-sources…
│   │   │   ├── kb/                   kb·记忆
│   │   │   ├── workflow/             workflow-registry·workflows
│   │   │   ├── pi/                   pi-runtime·pi-config·provider-catalog·models-dev-catalog
│   │   │   └── net/                  builtin-browser(CDP 保留)·web-search·web-reader·mcp-management
│   │   ├── ipc/                  IPC 路由注册（typed handler，按域分文件）
│   │   │   └── push.ts               后端 → 渲染事件推送（对齐事件注册表）
│   │   ├── platform/             窗口/托盘/自启/更新/文件对话框/WebContentsView 宿主
│   │   └── workspace/            工作区管理（workspace.mjs 迁入）
│   ├── preload/
│   │   └── index.ts              contextBridge：window.opApi（typed，最小面）
│   └── renderer/             ── 前端（TS + React 重建）──
│       ├── index.tsx · App.tsx       骨架/路由/模式分派（三栏/知识库/模板库/设置）
│       ├── layout/                   标题栏/三栏布局/主题（ThemeProvider TS 化）
│       ├── domains/                  按业务域组织（对齐后端域）
│       │   ├── chat/                     ChatPanel 系（对话流/审批卡/结论卡/模型选择）
│       │   ├── doc/                      DocViewer 系
│       │   ├── map/                      MapPanel 系
│       │   ├── kb/                       KnowledgeBase 系
│       │   ├── task/                     TaskCenter/SubagentDetailPanel
│       │   └── workspace/                SessionSidebar/AgentMarket/WorkflowLauncher/Settings
│       ├── shared/                   19 个纯函数模块 TS 化迁入（run-trace/stream-budget/event-display/layer-registry…）
│       └── api/                      ipc-client.ts（invoke 封装 + 事件订阅 + 连接状态）
└── tests/                    vitest（从 scripts/*.mjs 渐进迁移）
```

旧 `client/`、`server/` 在迁移期原样保留并行运行，按域退役（§5）。

## 3. 通信协议设计（IPC 取代 HTTP/SSE）

### 3.1 双通道模型

```ts
// shared/protocol/channels.ts —— 通道与负载强类型
export const Channels = {
  // 请求/响应（对齐现有 REST 路由族，一比一映射）
  "agent:prompt":      Request<AgentPromptInput, AgentPromptResult>,
  "agent:abort":       Request<AbortInput, AbortResult>,
  "doc:open":          Request<{ file: string }, DocPayload>,
  "map:editLayer":     Request<MapEditInput, MapEditResult>,
  "kb:search":         Request<KbSearchInput, KbSearchResult>,
  "workflow:launch":   Request<WorkflowLaunchInput, WorkflowLaunchResult>,
  // …207 个 REST 路由按域归并为 ~40 个通道族
} as const;

// 后端 → 渲染事件推送（负载沿用 event-registry 115 种 schema，语义零变化）
export type PushEvent = Static<typeof EventRegistrySchema>;
```

- **请求/响应**：`ipcMain.handle` + preload 暴露 `opApi.invoke(channel, payload)`，全链路类型推导（通道名 → 输入/输出类型）。
- **事件推送**：取代 SSE——后端 `push.ts` 按事件注册表 schema 校验后 `webContents.send("op:event", evt)`；前端 `api/onEvent` 订阅。**115 种事件的名称/负载/语义保持不变**，前端消费代码迁移时协议零改动。
- **流式 token**：SSE 的 token 流 → IPC 事件流（同通道高频推送）；实测 IPC 吞吐远超需求（同机进程内），流预算/去重逻辑（stream-budget.ts）保留。

### 3.2 过渡期兼容模式

迁移期业务后端保留一个可选 Express 挂载（`main/backend/legacy-http.ts`，仅绑定 127.0.0.1、仅迁移期用于让**旧 client/ 直接跑进 Electron 壳**做等价对照）；新 renderer 只走 IPC。旧 HTTP 层在新前端完成迁移后退役。

## 4. TypeScript 迁移策略

### 4.1 协议先行（类型单一事实源）

1. `shared/protocol/events.ts`：把 `server/event-registry.mjs` 的 115 种 typebox schema 迁为 TS 模块，导出 `Static<>` 类型——**schema 即类型，前后端共用**。
2. `channels.ts` 的 40 个通道族类型与 REST 路由参数一一对照评审（防漏迁）。
3. Pi SDK 无官方类型：`src/main/backend/pi/pi.d.ts` 自补声明（按 1.1.0 导出面），后续独立成包。

### 4.2 后端 JS → TS（server/ 76 模块，按域绞杀）

顺序（依赖从少到多）：

| 批次 | 域 | 模块 | 风险 |
|---|---|---|---|
| B1 | runtime | event-registry/event-protocol/event-normalization/event-storage/run-trace/run-budget/turn-budget | 低（schema 已有） |
| B2 | kb + workspace + 记忆 | kb/workspace/memory-* | 低 |
| B3 | workflow | workflow-registry/workflow-validation/workflows | 低 |
| B4 | office | office/doc-engine/office-params/native-files | 中（officecli 交互） |
| B5 | map | map 族 9 模块 | 中（geojson 类型建模） |
| B6 | agent + pi | agent/subagent-orchestrator/pi-runtime/… | **高（核心链路，最后迁）** |

每批做法：`.ts` 改写（逻辑不变）→ typebox DTO 接 IPC 层 → 对应回归测试通过 → 下一批。**迁过的模块旧 JS 即删**（git 历史兜底），不留双轨。

### 4.3 前端 JS → TS（client/ → renderer/，按域绞杀）

| 批次 | 内容 | 依据 |
|---|---|---|
| F1 | 19 个纯函数模块 TS 化 | 有静态回归测试守护，零 UI 依赖，直接迁 |
| F2 | App 骨架 + 布局 + 主题 + api/ipc-client | 新写（TS 范本），确立领域目录约定 |
| F3 | chat 域（对话流核心链路） | 最复杂域先攻，协议类型已在 B1 就绪 |
| F4 | doc + task 域 | 与 chat 协同验证 |
| F5 | map + kb 域 | 依赖 B5/B2 后端类型 |
| F6 | workspace/settings/market 等外围 | 收尾 |

### 4.4 工程守护

- tsconfig `strict: true` + `noUncheckedIndexedAccess`；ESLint（typescript-eslint strict + react-hooks）。
- 测试：vitest 承接——`scripts/*.mjs` 中 16 项 CI 回归逐批迁为 vitest（先迁 F1 纯函数测试，再迁后端域测试）；`npm run verify` 冒烟在 IPC 形态下重写为 electron 启动冒烟。
- CI 增加桌面 job：electron-builder 打包冒烟 + vitest 全量。

## 5. 功能等价验收（绞杀者的准入准出）

**每个域迁移完成必须同时满足**（准入切换、准出退役）：

1. 该域全部回归测试在 TS 形态下通过（vitest）。
2. 等价对照清单核对：对照 `REQUIREMENTS.md` R1-R14 中该域需求逐条验收——**功能与逻辑一致或更优，不允许静默减配**。
3. 事件协议兼容：该域事件在 event-registry schema 校验通过（新旧负载 diff 为空）。
4. 双形态冒烟：新 renderer 走 IPC、旧 client 走 legacy-http 各跑一遍该域主流程。
5. 评审确认后：新形态设为默认；旧代码删除（一个域一个 PR，可回滚）。

## 6. 里程碑（R0-R6）

| 阶段 | 内容 | 验收门槛 |
|---|---|---|
| **R0 脚手架** | electron/ monorepo + electron-vite + tsconfig strict + vitest + CI 桌面 job | 空壳应用打包安装可运行；CI 绿 |
| **R1 等价壳** | main + preload + legacy-http 挂载旧 server + 加载旧 client/ | 旧前端在 Electron 内全功能可跑（与浏览器形态等价）——功能基线 |
| **R2 协议基座** | shared/protocol 全量（115 事件 + 40 通道族）+ B1 runtime 域 TS + F1 纯函数 TS | 协议类型编译通过；runtime 域回归通过 |
| **R3 对话链路** | B6 agent/pi 域 TS + F3 chat 域（新 renderer 首个域） | 新界面完成一次完整 Agent 任务（含审批/产物/结论卡），事件协议 diff 为空 |
| **R4 内容域** | B2/B3/B4 + F4（kb/workspace/workflow/office + doc/task） | 各域等价验收（§5）逐域通过 |
| **R5 地图与外围** | B5 + F5/F6（map 域 + 外围界面） | map 域等价验收；全界面 TS 化完成 |
| **R6 收口** | 退役 client/ + server/ 旧 HTTP 层 + 测试全量 vitest + 打包分发打磨 | 根目录仅剩 electron/；`npm run verify` 等价物全绿；NSIS 安装包交付 |

依赖关系：R1 可立即启动（不等 TS）；R2 起协议与 runtime 先行；R3 是最大风险点（agent 域 + chat 域同时迁移），需要单独排期与充分冒烟。

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| 工程量大（76+54+19 模块） | 绞杀者分批 + 每批独立 PR 可回退；R1 先拿到"可用桌面端"保底 |
| agent 域重构引入核心链路回归 | B6/F3 放最后且单独排期；迁移期间冻结该域新功能（转正轮并行不受影响） |
| Pi SDK 无类型 | 自补 .d.ts 独立维护；SDK 升级时类型随版本校验 |
| 事件推送从 SSE → IPC 的隐性差异（背压/顺序/断连语义） | stream-budget 逻辑保留；断连语义改为窗口生命周期内承诺（无网络断连）；推送前 schema 校验 |
| 迁移期双前端心智负担 | legacy-http 仅迁移期存在且有删除里程碑（R6）；域切换后旧代码即删不留双轨 |
| officecli/内置浏览器等子进程管理变化 | 子进程管理归 main/platform，接口不变；CDP 通道保留为网页端历史兼容 |

## 8. 与既有文档的关系

- **取代**：BRD-008 sidecar 路线及 `2026-10-19-Electron桌面端架构优化方案.md`（该文的选型论证、安全边界、WebContentsView 设计被本文继承）。
- **保留**：BRD-001 Pi 内核不换；BRD-002 单仓库共享核心；BRD-003 flag 门控；BRD-005 事件注册表治理（schema 成为 TS 类型源）；多用户三步走与三层隔离结论。
- **后续**：`docs/plans/2026-10-19-001` 阶段二 D2 事项更新为 R0-R6 里程碑（已同步）。
