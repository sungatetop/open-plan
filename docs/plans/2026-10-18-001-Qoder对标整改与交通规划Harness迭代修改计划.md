---
title: Qoder 对标整改与交通规划 Harness 迭代修改计划
summary: "面向执行者： 本计划自包含，按顺序执行即可。每个任务带 - [ ] 复选框，完成即勾选；每阶段结束同步更新 变更日志.md。"
keywords: [Qoder对标整改与交通规划Harness迭代修改计划, plans]
status: done
date: 2026-10-18
---

# Qoder 对标整改与交通规划 Harness 迭代修改计划

> **面向执行者：** 本计划自包含，按顺序执行即可。每个任务带 `- [ ]` 复选框，完成即勾选；每阶段结束同步更新 `变更日志.md`。
> **唯一依据：** `Qoder对标评审与交通规划Harness方案.html`（下称"对标报告"）。本计划是该报告 §2（P0–P2 建议）、§3（设计令牌与组件规范）、§4（交通规划 Harness 方案）、§5（M1–M5 路线图）、§6（风险与不做清单）的**可执行化拆解**，不引入报告之外的任何新目标。
> **团队假设：** 1 后端 + 1 前端 + 0.5 测试（可兼任）。时间以工作日（D）计；人力变化时按比例伸缩，**阶段顺序与质量门禁不变**。

**目标：** 在不改变规聚既有产品形态与能力边界的前提下，把对标报告识别出的传输层 / 事件层 / 编排层 / 前端视觉四类偏差逐项收敛，并将交通规划领域工作流沉淀为声明式 Harness 契约。

**架构：** 维持"Express 单服务 + React SPA + Pi SDK 进程内调用 + officecli"的现有骨架不动；改动集中在 L2 治理层（`server/`）与 L4 工作台 UI（`client/src/`）两侧，L1 适配层仅做薄壳收口，L0（Pi SDK 1.1.0）**不改内核**。

**技术栈：** Node 22 + Express 5 + Pi Agent SDK 1.1.0、React 18 + Vite 5、officecli 1.0.156、MapLibre GL、typebox（Pi 已依赖，用于事件负载校验）。

**基线：** v0.11.55（`master`，HEAD `1b17294e`）。现有 68 个 `test:*` 脚本 + `npm run verify`（语法 + Vite 构建 + API 冒烟）作为回归基线。

**范围与合规声明：**
1. 本计划的每一项改动均可追溯到对标报告的具体条目（见 §1.4 追溯矩阵），**不新增任何报告之外的功能**。
2. **不新增产品形态**：不新增独立应用、不新增独立前端工程、不新增后端服务、不引入新框架。
3. **不做清单**（对标报告 §6.2，本计划全程遵守）：不采用 Qoder 皮肤引擎（6 Flavor × N Swatch）；不把对话流改为手写 SSE 解析；不修改 Pi 内核、不引入官方不存在的 subagent / plan mode；不追求复刻 Qoder 界面，只对齐视觉语言与交互范式。
4. **命名合规**：所有新增文件按 `AGENT.MD` 强制中文命名（代码文件按语言惯例）。对标报告中出现的 `server/workflow/*.mjs`、`ExecutionHandle` 等命名在落地时统一改为中文文件名 + 中文导出别名，见 §4。

---

## 〇、预设需求与规则基线对齐（逐条）

本章回应"逐条梳理对齐现有 open plan 的全部预设需求、已定义的功能边界、已落地实现的模块和已约定的规则约束"，作为偏差判定与"不得超出预设范围"的比对基准。

### 0.1 功能需求对齐（依据 `REQUIREMENTS.md`）

| 编号 | 预设需求 | 已落地实现落点 | 本计划是否触及 |
|---|---|---|---|
| R1 | Office 文档查看与编辑（docx/xlsx/pptx/md/txt/csv/json） | `client/src/components/DocViewer.jsx`、`DocxViewer.jsx`、`PptxViewer.jsx`、`ExcelGrid.jsx`、`server/文档引擎.mjs` | 否（仅 P1-7 令牌换色会影响样式） |
| R2 | AI Agent 对话协作（officecli 工具 / skills / 30+ 模型 / 推理三档） | `server/agent.mjs`、`server/Pi运行时管理.mjs`、`client/src/components/ChatPanel.jsx` | **是**（P0-1、P0-2、P0-3、P1-1/P1-3/P1-4） |
| R3 | 对话流完整展示（思考过程 / 工具卡片 / 流式 / PlanBoard / 总结条） | `ChatPanel.jsx`、`client/src/运行展示投影.js`、`client/src/事件展示.js` | **是**（P1-8 对象栏、§3.3 组件规范） |
| R4 | 文件上下文自动注入 | `ChatPanel.jsx`（`[当前打开文件]` 注入） | 否 |
| R5 | 会话历史管理（列表 / 过滤 / fork / 恢复） | `client/src/components/SessionSidebar.jsx`、`server/index.mjs` `/api/sessions*` | 否 |
| R6 | 智能体广场与技能体系 | `client/src/components/AgentMarket.jsx`、`SkillsManager.jsx`、`server/工作流*.mjs` | **是**（§4 领域工作流扩展既有技能集合，不新建体系） |
| R7 | 文档批注与修订 | `CommentMarker.jsx`、`server/文档引擎.mjs` | 否 |
| R8 | 个性化与主题（统一图标 / 暗亮双主题 / 头像 / 滚动条） | `Icon.jsx`、`theme.jsx`、`client/src/styles.css` | **是**（P0-4、P1-7、P2-4、P2-6） |
| R9 | 知识库（Obsidian 风格 / 图谱 / IMA / @ 引用） | `KnowledgeBase.jsx`、`KnowledgeGraph.jsx`、`server/kb.mjs` | 否 |

### 0.2 非功能需求与规则约束

| 约束 | 出处 | 本计划的遵守方式 |
|---|---|---|
| 中文界面 / 中文文件名 | `REQUIREMENTS.md`、`AGENT.MD` §命名规范 | 新增文件全部中文命名（§4 已逐条落实） |
| 每轮 `npm run verify` 通过才提交；提交信息 `类型: 描述` | `AGENT.MD` §开发工作流 | 每阶段 DoD 第一条（§5） |
| 每次请求形成 TaskEnvelope；完成后固定总结（来源/文件/产物/假设/下一步） | `AGENT.MD` §对话与界面约定 | P0-3 中断排空、P1-1 执行句柄均以 TaskEnvelope 为契约基础 |
| 坐标校验：经度 73–135°E、纬度 18–54°N，超范围立即报警 | `AGENT.MD` §坐标与数据校验 | §4.3 硬约束 `geoRange`（→ `geo_out_of_range` 事件） |
| OD/客流数据：记录数 expected vs actual 不完整不继续 | `AGENT.MD` §坐标与数据校验 | §4.3 硬约束 `recordCount`（→ `data_integrity_failed` 事件） |
| 创作模式产物必须写入 `office-workspace` | `AGENT.MD` §已知坑 | §4.3 硬约束 `artifactRoot`（复用 `snapshotWorkspace`） |
| 新增事件类型必须登记 `事件注册表.mjs`，否则 `test:pi-iteration` 失败 | `AGENT.MD` + `scripts/事件注册表测试.mjs` | §3 已逐项标注"是否需登记事件" |
| 简单优先 / 最小侵入 / 不顺手重构 | `AGENT.MD` §编码准则 | 每项任务限定"仅改必须改的"，§4 锁定改动面 |
| SSE 断线自动重连（现 3 秒重试） | `REQUIREMENTS.md` §非功能需求 | P0-1 在此基础上加抖动与错误分类，**不改变"自动重连"这一预设行为** |

### 0.3 功能边界与不做清单

| 边界 | 结论 | 出处 |
|---|---|---|
| Pi 内核 | 不改；不依赖官方不存在的 subagent / plan mode | `AGENT.MD` §pi agent 能力边界、对标报告 §4.6 |
| 多技能协作 | 继续走"技能集合 + 智能体广场 + 前端工作流"模拟 | 同上 |
| 主题体系 | 只做暗/亮双主题 + `color-mix` 派生手法，**不做**多皮肤引擎 | 对标报告 §1.4、§6.2 |
| SSE 传输 | 保留原生 `EventSource`，**不改为手写解析** | 对标报告 §2.1 帧格式判定、§6.2 |
| 视觉对齐 | 只对齐视觉语言与交互范式，**不追求复刻 Qoder 界面** | 对标报告 §6.2 |
| 运行记录位置 | `.oaw/runs/` 已在 `.gitignore`，不得提交 | `AGENT.MD` §已知坑 |

### 0.4 已落地模块盘点（改造所依附的既有资产）

| 层 | 模块 | 角色 |
|---|---|---|
| 传输 | `server/index.mjs`（4 条 SSE 端点）、`server/流连接.mjs`、`client/src/长连接预算.js`、`ChatPanel.jsx`（@1520–1666 建连/握手/游标/代际/退避/看门狗） | P0-1 / P0-2 / P1-5 / P1-6 与 P1-3 的改造落点 |
| 事件 | `server/事件注册表.mjs`（130+ 类型，双标记）、`server/事件存储.mjs`、`client/src/事件展示.js`、`运行轨迹.js`、`运行展示投影.js`、`首字延迟埋点.js` + `server/首字延迟.mjs` | P1-2 schema 校验、P2-1 缺号告警、P2-5 遥测的落点 |
| 编排 | `server/runs.mjs`、`task.mjs`、`子代理编排器.mjs`、`编辑流水线.mjs`、`审批策略.mjs`、`运行预算.mjs`、`agent.mjs`、`Pi运行时管理.mjs` | P0-3 中断排空、P1-1 执行句柄、P1-4 owner 的落点 |
| 成果 | `server/成果管理.mjs`、`/api/runs/:id/artifacts`、`/api/runs/:id/rollback` | §4.5 成果验收台直接复用 |
| 前端 | `DESIGN.md`、`client/src/styles.css`（429 KB）、`Icon.jsx`、`theme.jsx`、`供应商标识.js`、`供应商品牌图形.js` | P0-4 / P1-7 / P2-4 / P2-6 的落点 |
| 质量 | 68 个 `test:*` 脚本 + `npm run verify` | 测试计划（`2026-10-18-002`）的回归基线 |

---

## 一、偏差项清单与分级

分级口径沿用对标报告的 P0/P1/P2 判定，**不新增、不上调、不下调**。共 18 项偏差 + 1 项工程前置项。

### 1.1 P0 · 正确性与体验硬伤（4 项）

| 编号 | 偏差项 | 现状（实测落点） | 目标 | 报告依据 |
|---|---|---|---|---|
| **P0-1** | 重连退避无抖动、无错误分类、封顶过短 | `ChatPanel.jsx`：`retryDelay = Math.min(5000, retryDelay*2)`，无 jitter、无 429/5xx 分类 | 指数退避 800ms→30s 封顶 + 0.5~1.0× 抖动 + `network/server/rate` 分类，`Retry-After` 优先 | §1.1 重连退避（缺口）、§2.1 P0-1 |
| **P0-2** | 对话流无读取体积护栏与背压 | `/api/agent/stream` 直接 `res.write`，无 `drain` 处理、单帧无上限；仅浏览器帧流有 `pendingEvents` + 背压 | 对话流复用背压泵；`tool_output` 单帧 ≤256 KB 超出切分 `tool_output_delta`；计入 `noteStreamWrite` 字节账 | §1.1 背压（部分）、§2.1 P0-2 |
| **P0-3** | 缺"中断后残余消息排空"语义 | 仅靠客户端 `generation` / `connectionSerial` 守卫过滤，中断时在途 `token/tool_output` 可能被丢弃或污染下一轮 | 服务端 Run 状态机引入 `draining` 阶段 + `run_draining` 事件 + 1.5s 排空窗口，结束发 `aborted{drained:true}` | §1.3 轮次状态机（缺口）、§2.1 P0-3 |
| **P0-4** | 视觉基调与 Codex/Qoder 不匹配 | `--body-bg #1a1a2e`（偏蓝紫）、`--accent #8abeb7`（青绿）、全站等宽字体 | 中性灰阶打底（`#0b0b0b/#141414/#181818`）+ Nord 冷蓝强调（`#81A1C1/#88C0D0`）+ 语义三色统一 + 正文系统 sans | §1.4 基础色板/强调色/字体（缺口）、§2.1 P0-4、§3.1 |

### 1.2 P1 · 架构收口（8 项）

| 编号 | 偏差项 | 现状 | 目标 | 报告依据 |
|---|---|---|---|---|
| **P1-1** | 执行契约未抽象为统一接口，缺 `availability` 三态 | Run 生命周期（`run_admitting→run_started→run_finished`）+ 检查点 + 恢复（`run_recovered`）散落在 `runs.mjs` / `agent.mjs` / `Pi运行时管理.mjs` | 新增 `server/执行句柄.mjs` 收敛为统一契约（`执行/中断/响应交互/释放/订阅/可用性/能力`），`index.mjs` 路由改薄壳 | §1.3 执行契约（部分）、§2.2 P1-1 |
| **P1-2** | 事件负载无 schema 级校验 | 仅校验事件类型是否在注册表 | `事件注册表.mjs` 每条增加可选 `schema`（typebox）；生产 `warn`、测试 `throw` | §1.1 消息结构校验（缺口）、§2.2 P1-2 |
| **P1-3** | "先订阅后发送"未强制 | 发送走独立 POST，靠事件存储回放兜底 | 以 `connected` 握手为门禁（复用已有 `streamReadyRef`），在提交路径上强制 gate | §1.1 建连与握手（已达但未强制）、§2.2 P1-3 |
| **P1-4** | 交互（HITL）缺 owner 归属与迁移 | `ask_user` / `tool_approval_request` 载荷无 owner；多子代理并发时前端无法判断归属 | 载荷补 `owner:{kind:"turn"\|"subagent"\|"session", id}`；子代理启动发 `interaction_owner_changed`；前端在子代理卡片内联渲染 | §1.3 人工交互（部分）、§2.2 P1-4 |
| **P1-5** | 服务端流无配额与"满则拒绝" | `registerServerStream` 同键去重 + 写入计量，无全局配额 | `流连接.mjs` 增按 `path` 配额表，超限 `503 + code:"STREAM_QUOTA_EXCEEDED"` | §1.1 连接预算（部分）、§2.2 P1-5 |
| **P1-6** | 陈旧流服务端不停摆 | 同键新连接接管后，旧流仍被推送，仅靠客户端断开 | 检测到接管即标记旧流 `stale` 并停止推送 | §1.2 分发机制（部分）、§2.2 P1-6 |
| **P1-7** | 设计令牌未三层化 | 单层 17 个 CSS 变量直写 `:root`，429 KB 样式直写色值 | `基础色阶 → 语义 token → 组件变量` 三层；旧变量保留为别名一个版本 | §1.4 设计令牌（缺口）、§2.2 P1-7、§3.1 |
| **P1-8** | 缺对象计数徽标与右侧对象分组栏 | 产出/来源/记忆已在别处以面板存在，未收拢为统一"本轮对象"栏 | 执行流折叠条增 `+N` 徽标；新增右侧「本轮对象」栏，分组对齐 Qoder：产出/来源/技能与 MCP/网页查阅/记忆 + 环境信息 + 后台进程 | §1.4 对话流执行块（部分）、§2.2 P1-8、§3.3 ⑤ |

### 1.3 P2 · 打磨（6 项）

| 编号 | 偏差项 | 目标 | 报告依据 |
|---|---|---|---|
| **P2-1** | 事件缺号无告警 | 客户端发现 `seq` 跳变即上报，暴露被 `lifecycle` 淘汰策略静默丢弃的帧 | §1.1 顺序保证（P2）、§2.3 P2-1 |
| **P2-2** | 心跳间隔不可配 | 心跳间隔支持配置（低功耗 / 远程 SSH 场景放宽） | §1.1 心跳与半开检测（P2）、§2.3 P2-2 |
| **P2-3** | 取消后无 `still_queued` 回执 | 取消返回"仍排队的轮次数量"，前端区分"已停"与"排队中已停" | §1.3 中断与取消（部分）、§2.3 P2-3 |
| **P2-4** | 无视觉特效开关 | `:root[data-visual-effects="off"]` 去 `backdrop-filter` / 位移 / 模糊 | §1.4 动效（部分）、§2.3 P2-4、§3.3 ⑥ |
| **P2-5** | 事件量级无遥测 | 按事件类型统计发送量 / 淘汰量，纳入诊断面板 | §1.2 事件计数/遥测（P2）、§2.3 P2-5 |
| **P2-6** | 无对比度审计自动化 | WCAG AA 对比度审计并入 `test:a11y` | §1.4 可访问性（P2）、§2.3 P2-6 |

### 1.4 追溯矩阵（偏差项 ↔ 报告条目 ↔ 需求编号）

| 偏差项 | 报告章节 | 关联既有需求 | 阶段 |
|---|---|---|---|
| P0-1 | §1.1 / §2.1 P0-1 | R2、非功能-SSE 重连 | M1 |
| P0-2 | §1.1 / §2.1 P0-2 | R2、R3 | M1 |
| P0-3 | §1.3 / §2.1 P0-3 | R2、AGENT.MD TaskEnvelope | M1 |
| P0-4 | §1.4 / §2.1 P0-4 / §3.1 | R8 | M1 |
| P1-1 | §1.3 / §2.2 P1-1 | R2 | M2 |
| P1-2 | §1.1 / §2.2 P1-2 | R3 | M2 |
| P1-3 | §1.1 / §2.2 P1-3 | R2 | M2 |
| P1-4 | §1.3 / §2.2 P1-4 | R2、R3 | M2 |
| P1-5 | §1.1 / §2.2 P1-5 | R2 | M2 |
| P1-6 | §1.2 / §2.2 P1-6 | R3 | M2 |
| P1-7 | §1.4 / §2.2 P1-7 / §3.1 | R8 | M3 |
| P1-8 | §1.4 / §2.2 P1-8 / §3.3 ⑤ | R3、R6 | M3 |
| P2-1…P2-6 | §2.3 | R3、R8 | M5 |
| §4 领域工作流 | §4.1–§4.6 | R6、R9、AGENT.MD 数据校验 | M4 |
| §4.5 工作台 | §4.5 | R3、R6 | M4 / M5 |

---

## 二、阶段划分与时间节点

阶段编号沿用对标报告 §5 的 M1–M5，**不重排、不合并、不拆分**。

| 阶段 | 内容 | 时间 | 里程碑交付物 | 门禁 | 责任主体 |
|---|---|---|---|---|---|
| **M0 基线收口** | 未提交改动收口 + 全绿基线 + 本计划评审签字 | D1–D3 | `git status` 干净、`npm run verify` 全绿 | G0 | 后端+前端 |
| **M1 传输与视觉硬伤** | P0-1 退避抖动 · P0-2 体积护栏与背压 · P0-3 中断排空 · P0-4 视觉令牌 | D4–D18 | 4 项 P0 全部落地 | G1 | 前端主、后端辅 |
| **M2 架构收口** | P1-1 执行句柄 · P1-2 schema 校验 · P1-3 先订阅后发送 · P1-4 owner 归属 · P1-5 服务端配额 · P1-6 陈旧流停摆 | D19–D36 | 6 项 P1 落地，新增契约测试全绿 | G2 | 后端主、前端辅 |
| **M3 对象栏与视觉收口** | P1-7 令牌三层化 · P1-8 右侧对象栏 · §3.3 组件规范（HITL 卡片 / 状态点 / `+N` 徽标） | D37–D48 | 工作台视觉对齐完成 | G3 | 前端 |
| **M4 领域工作流** | §4.3 六个交通规划工作流 + §4.4 DSL + preflight 硬约束 + §4.5 启动器/阶段条 | D49–D66 | 工作流契约测试全绿 + 真实场景回归 | G4 | 后端主、前端辅 |
| **M5 Harness 化收尾** | §4.5 成果验收台 · 地图↔对话联动 · P2-1…P2-6 | D67–D78 | 全量验收通过 | G5 | 全员 |

**进度跟踪机制：**
- 每任务完成 → 勾选本文件复选框 + `变更日志.md` 记一行（格式 `类型: 描述`）。
- 每阶段末（G 门）开 30 分钟评审：对照 §5 该阶段 DoD 逐条打勾，未过项进入测试计划的缺陷闭环流程。
- 每周五更新一次里程碑表，红黄绿标注。
- 里程碑延误 >2 天触发 §7 风险预案 R0。

**关键路径：** `M0 → M1(P0-2) → M2(P1-1) → M4(§4.3/§4.4) → M5`。
P0-2（背压）与 P1-1（执行句柄）是强依赖前置：§4 领域工作流的预算门、审批点、产物契约必须挂在统一执行句柄与背压通路之上，**不得并行跳过**。

---

## 三、任务拆解（输入 / 执行标准 / 输出 / 依赖 / 验证）

> 约定：每个任务完成即 `npm run verify` + commit（`AGENT.MD` §开发工作流）。标注「需登记事件」的任务，必须在同一提交内更新 `server/事件注册表.mjs`，否则 `test:pi-iteration` 必失败。

### M0 基线收口（D1–D3）

- [ ] **T0.1 未提交变更收口**
  - 输入：当前工作区改动 —— 已暂存 9 文件（`client/src/api.js`、`ChatPanel.jsx`、`SettingsPanel.jsx`、`供应商库.jsx`、`长连接预算.js`、`office-workspace/maps/zhejiang-map/map.config.json`、`style.json`、`server/index.mjs`、`供应商目录.mjs`）；未暂存 6 文件（`ChatPanel.jsx`、`styles.css`、`package-lock.json`、`server/agent.mjs`、`内置浏览器.mjs`、`编辑流水线.mjs`）；未跟踪 `server/模型目录dev.mjs`、`server/models-dev-目录.json`、`docs/记忆与供应商问题诊断与修复方案.md`。
  - 执行标准：先确认未跟踪文件是否需要入库（`models-dev-目录.json` 为缓存，若体积大可入 `.gitignore`）；按主题拆分提交：`feat: models.dev 供应商目录接入`、`fix: SSE 优雅收流消除 ERR_ABORTED`、`fix: ask_user 超时卡片失效`、`fix: 内置浏览器就绪等待`、`fix: 编辑流水线 Writer 预算与解析诊断`、`chore: 地图图层可见性调整`。
  - 依赖：无（**全部后续任务的前置**）
  - 输出：`git status` 干净、已推送 origin
  - 验证：`npm run verify` 退出码 0；`git log --oneline -6` 见上述提交
  - 🟡 **2026-10-18 部分完成（保持未勾选）**：**本计划自身的改动已按批次收口**——`71990230`（六批：P0/P1/P2 + 领域工作流 + 对象栏）、`85689513`（§3.3 组件交互规范）、本批次（T0.2 基线数据 + `workflow-ui` 断言修正）。工作区**剩余**改动属**另一条工作线**（`models.dev` 供应商目录刷新 + 内置浏览器就绪等待 + 编辑流水线），未纳入本计划范围，按「不混提交」原则保持未提交，待其自行收口；`npm run verify` 里唯一失败项仍是基线既有问题（Office 路由未识别）。

- [x] **T0.2 全绿基线固化**
  - 输入：68 个 `test:*` 脚本
  - 执行标准：串行跑一遍全量脚本，记录失败项与失败原因；把与本次改造无关的历史失败登记为"已知遗留"，写入 §7 风险表；`--live` 类脚本（`test:browser:live`、`test:map-layers:live`、`test:map-visual:live`、`test:map-chat:live`）单独标记为"需人工触发"
  - 依赖：T0.1
  - 输出：`docs/plans/2026-10-18-002-...` 所需的全量回归基线数据（首轮结果表）
  - 验证：基线结果表落入测试计划 §5
  - ✅ **2026-10-18 达成**：76 个 `test:*` 自动执行 72 个 → **通过 58 / 失败 14**；4 个 `:live` 标记为需人工触发。用 `git worktree` 在优化前基线提交 `1b17294e` 上逐条重跑失败脚本，**13 项以完全相同断言失败**（含 `test:perf-budget` 的「持续动画 19 种 > 预算 18 种」），已登记为「已知遗留」并写入本文档 §7.1；第 14 项（`test:workflow-ui`）为本计划新增脚本的断言范围写错，已修正为「只切到下一个同级横幅」，修正后 8/8 通过。结果表见 `docs/plans/2026-10-18-002-...md` §5.1。

- [ ] **T0.3 改动面锁定评审**
  - 🟡 **2026-10-18 证据已备、待签字**：核对结论与 6 项偏差见文末「T0.3 改动面锁定评审」；本节由你确认后勾选。
  - 输入：本计划 §4 文件结构总览
  - 执行标准：对照对标报告逐条确认 18 项偏差 + §4 工作流的落点文件，确认无新增工程/服务/框架；签字
  - 依赖：T0.1
  - 输出：评审结论（可附在本文档末尾"评审记录"）
  - 验证：§9 合规校验表逐条可判定

### M1 传输与视觉硬伤（D4–D18）

- [ ] **P0-1 重连退避加入抖动 + 错误分类**
  - 输入：`client/src/components/ChatPanel.jsx`（`retryDelay` 计算处）
  - 执行标准：
    1. 抽出 `nextDelay(attempt, kind)`：`exp = min(30000, 800 * 2**attempt)`，`jitter = 0.5 + Math.random()*0.5`，`kind==="rate"` 时下限 5000。
    2. 错误分类：SSE `error` 事件后无法读状态码，改由**服务端在 `503/429` 响应头带 `Retry-After`**（与 P1-5 配额拒绝配套），前端解析后优先采用；无头部时按 `network` 处理。
    3. 保留"`connected` 成功后才复位退避"的既有行为（避免冷启动高频重连）。
  - 依赖：**P1-5 的 `Retry-After` 为弱依赖**（无头时按 network 分支仍可工作）
  - 输出：改造后的 `ChatPanel.jsx`；退避参数集中为一个常量对象便于测试断言
  - 验证：`test:sse-protocol` 全绿；新增 `scripts/SSE退避抖动测试.mjs`（断言时间序列非等间隔、封顶 30s、`rate` 下限 5000）

- [ ] **P0-2 对话流读取体积护栏与背压**
  - 输入：`server/index.mjs`（`/api/agent/stream` 写入处）、`server/流连接.mjs`（`noteStreamWrite`）、`client/src/长连接预算.js`
  - 执行标准：
    1. 把浏览器帧流已实现的 `pendingEvents` + `writable`/`drain` 泵**抽为公用**（落在 `server/流连接.mjs`），对话流复用。
    2. `tool_output` 分片：单帧 ≤256 KB，超出切分为 `tool_output_delta`（**需在 `事件注册表.mjs` 登记**，`lifecycle:false`）。
    3. 累计字节计入 `noteStreamWrite`，`/api/agent/events/state` 可见字节计量。
  - 依赖：T0.1
  - 输出：`server/流连接.mjs` 新增导出（背压泵 + 分片器）；`server/index.mjs` 对话流接线
  - 验证：`test:stream-budget` 全绿；`test:perf-budget` 全绿；新增 `scripts/对话流背压测试.mjs`（构造 >2 MB 工具输出，断言无 OOM、分片数正确、字节账一致）
  - 🟡 **2026-10-18 部分落地（保持未勾选）**：① 背压（FIFO 队列 + `drain` 泵 + 排队字节上限）已在批一交付，但**未**按原文「抽为公用模块」——仍是对话流端点自带实现；② **大帧分片已交付（第四批）**：`流连接.mjs` 的纯函数 `按字节切分` / `工具输出分片` / `工具输出帧上限` + `agent.mjs` 的 `emitToolOutput`（开关关闭时逐字走基线 `emit("tool_output", payload)`），增量事件 `tool_output_delta` 已登记为 `lifecycle:false/persist:false`，前端 `ChatPanel.jsx` 与 `运行轨迹.js` 以同分支 fallthrough 兼容；③ 累计字节经 `noteStreamWrite` 计入字节账（既有）。
  - ✅ **验证**：新增 `test:stream-split` 13/13（上限边界 / 多字节不被劈开 / 拼接可还原 / 未超限时对象原样透传 / >2 MB 不抛错 / 埋点收口 / 开关管线实测）；`test:event-registry`（114 种）、`test:stream-budget`、`test:sse-protocol`、`test:pi-iteration` 通过；`npm run verify` 中 `vite build` 成功、冒烟 39/40（唯一失败为基线既有问题）。
  - ⚠️ **未验**：真实产生 >256 KiB 工具输出的端到端切分（需一次真实大输出 Run）；本轮以纯函数 + 开关管线实测覆盖。

- [ ] **P0-3 轮次"中断排空"语义**
  - 输入：`server/runs.mjs`（Run 状态机）、`server/事件注册表.mjs`
  - 执行标准：
    1. `abort(runId, reason)` 置 `run.phase = "draining"`，`drainUntil = now + 1500`，发 `run_draining` 事件（**需登记**）。
    2. `draining` 期间不再接受新输入，但继续投递在途消息。
    3. 排空结束发 `aborted{ runId, drained: true }`；超窗强制结束并 `drained:false`。
    4. 前端在 `draining` 期间显示"正在收尾"，`generation` 守卫继续生效（作为第二层防护，不再作为唯一手段）。
  - 依赖：P0-2（共用投递通路，顺序执行更稳）
  - 输出：`runs.mjs` 三态边界；`事件注册表.mjs` 新条目；`ChatPanel.jsx` 收尾态渲染
  - 验证：`test:run-trace`、`test:event-registry`、`test:pi-iteration` 全绿；新增 `scripts/中断排空测试.mjs`（中断瞬间持续产出 token 的场景，断言时间线无"半句话"被下一轮吞并）
  - 🟡 **2026-10-18 部分落地（保持未勾选）**：服务端有界排空（`emitAbortedOnce`：先 `run_draining` → 静默 300ms / 上限 1500ms → `aborted{drained}`，幂等令牌先置位）与**前端收尾态**（`ChatPanel.jsx` 的 `case "run_draining"`，开关打开时状态行显示「正在收尾（投递在途消息）」，不改 `runState.status`）均已交付；**未做**执行标准第 2 条「`draining` 期间不再接受新输入」（会话准入属核心链路）。
  - ✅ **验证**：新增 `test:abort-drain`（8 例）通过；`test:event-registry`（113 种）、`test:pi-iteration`、`test:sse-protocol` 通过。

- [ ] **P0-4 视觉基调对齐（中性灰阶 + 系统 sans + 蓝系强调）**
  - 输入：`DESIGN.md` §设计规范、`client/src/styles.css` 顶部 `:root` 块
  - 执行标准：
    1. 在 `styles.css` 顶部**新增**令牌块，按对标报告 §3.1 落值：灰阶 `--op-gray-000…900`、语义 `--body-bg/--panel-bg/--panel2-bg/--surface/--border/--text/--muted/--dim/--selected`、强调 `--accent #81a1c1` / `--accent-hi #87a6c4` / `--accent-2 #88c0d0`、语义三色 `--success #3fa266` / `--error #e34671` / `--warning #f1b467`、用户气泡 `--user-bg #1d2733`。
    2. **旧变量名保留为别名**指向新令牌，避免一次性重写 429 KB 样式。
    3. `font-family` 拆为 `--font-sans`（正文）与 `--font-mono`（代码/路径/参数/数字）；按 §3.2 排版表落实字号行高。
    4. 暗/亮双主题同步（亮色按 §3.1 亮色块）。
    5. 分隔线统一改为低透明度前景色（`#f0f0f01a`）。
  - 依赖：无
  - 输出：`styles.css` 令牌块 + 别名；`DESIGN.md` §设计规范同步更新；`client/src/theme.jsx` 无需改（`data-theme` 机制不变）
  - 验证：`test:motion`、`test:a11y`、`test:icons` 全绿；`npm run build` 成功；新增 `scripts/设计令牌一致性测试.mjs`（断言 `:root` 令牌齐全、旧变量别名指向正确、无硬编码 `#1a1a2e`/`#16162a`/`#8abeb7` 残留于 `:root` 之外的语义层）；人工比对截图：主色偏差 ΔE < 3、页面平均色相饱和度 < 8%

### M2 架构收口（D19–D36）

- [ ] **P1-1 抽出统一执行句柄契约**
  - 输入：`server/runs.mjs`、`server/agent.mjs`、`server/Pi运行时管理.mjs`、`server/index.mjs`
  - 执行标准：新增 `server/执行句柄.mjs`，导出统一契约：`执行(prompt, ctx)` / `中断(runId, reason)` / `响应交互(id, answer)` / `释放(sessionId)` / `订阅(listener)` / `可用性()` → `ready|busy|disconnected` / `能力()`。`index.mjs` 相关路由改为薄壳（只做参数校验与响应封装），业务逻辑下沉到句柄。
  - 依赖：**P0-3（draining 属于句柄状态机的一部分）**
  - 输出：`server/执行句柄.mjs`；`index.mjs` 路由瘦身
  - 验证：`test:main-flow`、`test:cross-layer`、`test:pi-iteration` 全绿；新增 `scripts/执行句柄契约测试.mjs`（断言 7 个方法存在、`可用性()` 三态可达、`中断` 后可再次 `执行`）

- [ ] **P1-2 事件负载 schema 校验**
  - 输入：`server/事件注册表.mjs`（130+ 类型）、`scripts/能力契约测试.mjs`（复用其模式）
  - 执行标准：
    1. 每条事件增加**可选** `schema`（typebox，Pi 已依赖）。首批只覆盖本次新增/改动的事件（`run_draining`、`tool_output_delta`、`interaction_owner_changed`、`stream_quota_rejected`）与 4 个 HITL/终态事件，其余留空，避免一次性铺开。
    2. 生产 `warn`（写诊断日志），测试环境 `throw`。
    3. 环境开关沿用现有 `运行开关.js` 风格（默认关，`OAW_EVENT_SCHEMA=strict` 开）。
  - 依赖：P0-2、P0-3（先有新事件再有 schema）
  - 输出：`事件注册表.mjs` 结构扩展；校验函数落在 `server/事件存储.mjs` 写入路径
  - 验证：`test:event-registry`、`test:pi-iteration` 全绿；新增 `scripts/事件负载校验测试.mjs`（构造非法负载断言 `strict` 下抛错、默认下仅 warn）
  - 🟡 **2026-10-19 部分落地（保持未勾选）**：机制已交付（`validateEventPayload()` 纯函数 + `appendEvent` 门控调用 + 违规计数经 `eventStoreInfo().schemaViolations` 只读暴露），**首批 8 个事件已声明 `schema`**，字段逐条核对过全部发射点、可空字段不进校验；新增 `scripts/事件负载校验测试.mjs`（`npm run test:event-payload`，11 例：语义 / 覆盖防回退 / 防过严 / 发射点静态契约 / 接线 / 子进程 A-B）。
  - 🟡 **与原文口径的差异**：① 未用 typebox，改为零新增依赖的手写 schema（`required` + `types`）；② 开关名用 `OAW_EVENT_SCHEMA_CHECK`（默认关），**只告警 + 计数、不抛错也不阻断**，比原文「测试环境 throw」更保守；③ 原文候选的 `stream_quota_rejected` 并不存在为事件（P1-5 在 HTTP 层拒绝），故未纳入。

- [ ] **P1-3 "先订阅后发送"固化**
  - 输入：`client/src/components/ChatPanel.jsx`（已有 `streamReadyRef`；提交路径）
  - 执行标准：以 `connected` 握手为门禁——`streamReadyRef.current === false` 时提交按钮置为不可用并提示"正在建立事件通道"；握手成功后解锁；重连期间重新加锁。**不改变"发送走独立 POST"的既有架构**。
  - 依赖：无
  - 输出：`ChatPanel.jsx` 提交门禁
  - 验证：`test:chat-flow` 全绿；`test:sse-protocol` 全绿；新增断言并入 `scripts/对话流背压测试.mjs` 或独立 `scripts/先订阅后发送测试.mjs`（断言未握手时提交被拒、握手后放行）

- [ ] **P1-4 交互归属 owner**
  - 输入：`server/agent.mjs`（`ask_user` 事件载荷）、`server/审批策略.mjs`、`server/子代理编排器.mjs`
  - 执行标准：
    1. `ask_user` / `tool_approval_request` 载荷补 `owner:{kind,id}`；`kind ∈ {turn, subagent, session}`。
    2. 子代理启动时发 `interaction_owner_changed`（**需登记**）。
    3. 前端 `ChatPanel.jsx` 依 owner 把 HITL 卡片内联到**产生它的归属节点**（子代理卡片内），而非全局弹窗。
  - 依赖：P1-1（句柄统一后 owner 才有稳定 id 来源）
  - 输出：`agent.mjs` 载荷、`事件注册表.mjs` 新条目、`ChatPanel.jsx` + `子代理详情面板.jsx` 内联渲染
  - 验证：`test:approval`、`test:subagent-trace`、`test:subagent-orchestrator` 全绿；新增 `scripts/交互归属测试.mjs`（三 owner 形态各一例，断言前端归属节点正确）
  - 🟡 **2026-10-18 部分落地（保持未勾选）**：① 载荷侧——`审批策略.mjs` 的 `normalizeOwner()` + `requireToolApproval` 可选 `owner`（合法才附加，未传=基线键集合）；② 来源侧——worker 子代理 `write` 审批带 `{kind:"subagent", id:childId}`，子代理启动发 `interaction_owner_changed`（子代理事件通道），`ask_user` 带 `{kind:"turn", id:activeRunId}`（无 Run 时降级 `session`）；③ 前端——`ask`/`approval` 卡片记录 `block.owner` 并由 `交互归属文案()` 渲染「来自子代理 / 本轮任务 / 会话」标签；全部由开关 `OAW_QODER_INTERACTION_OWNER` 门控（默认关）。**未做**：把卡片**内联到子代理卡片内**（执行标准第 3 条的「而非全局弹窗」部分，属渲染核心链路），以及 worker 子代理 `officecli` 审批的归属。
  - ✅ **验证**：新增 `test:interaction-owner` **10/10**（真实调用 `requireToolApproval` 断言载荷：无 owner 时键集合与基线逐字一致 / 三态归属均进入载荷 / 非法归属一律丢弃；另含开关管线实测）；`test:approval`、`test:subagent-orchestrator`、`test:subagent-trace`、`test:event-registry`（115 种）、`test:pi-iteration`、`test:a11y` 通过；`npm run verify` 中 `vite build` 成功、冒烟 39/40（唯一失败为基线既有问题）。
  - ⚠️ 与原文依赖口径的差异：原文标「依赖 P1-1（句柄统一后 owner 才有稳定 id 来源）」，本轮未启动 P1-1，owner id 直接取既有 `childId` / `activeRunId` / `clientId`。

- [ ] **P1-5 服务端流配额与满则拒绝**
  - 输入：`server/流连接.mjs`（`registerServerStream`）、`server/index.mjs`
  - 执行标准：
    1. 按 `path` 建配额表：`agent/stream:8`、`browser/stream:4`、`memory/stream:4`、`events:4`（阈值可经环境变量覆盖）。
    2. 超限返回 `503` + `code:"STREAM_QUOTA_EXCEEDED"` + `Retry-After` 头（与 P0-1 配套）。
    3. 对话流保留 essential 优先级，配额满时优先拒绝低优先级通道。
  - 依赖：无（与 P0-1 互为支撑）
  - 输出：`流连接.mjs` 配额表 + 拒绝分支；`index.mjs` 四处端点接线
  - 验证：`test:stream-budget` 全绿；新增 `scripts/流配额测试.mjs`（超限断言 503 + code + 头；释放后可再建）

- [ ] **P1-6 陈旧流服务端停摆**
  - 输入：`server/流连接.mjs`
  - 执行标准：同键新连接接管时，将旧流标记 `stale` 并从推送集合摘除（保留引用以便 `closeServerStreams` 统一收束）；停摆时不计入写入计量。
  - 依赖：P1-5（共用连接登记结构）
  - 输出：`流连接.mjs` 接管逻辑
  - 验证：`test:stream-budget` 全绿；新增断言并入 `scripts/流配额测试.mjs`（同键二次建连后，断言旧流不再收到新事件）

### M3 对象栏与视觉收口（D37–D48）

- [ ] **P1-7 设计令牌三层化**
  - 输入：M1 已建的令牌块、`client/src/styles.css`、`DESIGN.md`
  - 执行标准：在 M1 令牌块基础上补齐三层——`--op-gray-*`（基础色阶）→ `--body-bg/--fg/--accent/--border`（语义）→ 组件变量；按主题域**分批**替换硬编码色值（顺序：对话区 → 文档区 → 地图区 → 设置区），每批跑一次 `test:a11y`。
  - 依赖：**P0-4（令牌块已存在）**
  - 输出：`styles.css` 三层结构 + 四批替换提交
  - 验证：`test:a11y`、`test:motion` 每批全绿；`scripts/设计令牌一致性测试.mjs` 断言无新增硬编码色值
  - 🟡 **2026-10-18 部分落地（保持未勾选）**：① 三层结构——在 P0-4 的 opt-in 令牌块内补齐「基础色阶 `--op-gray-000…900`（13 阶）+ 强调/语义色阶 → 语义令牌（全部引用基础层）→ 组件变量 `--op-comp-*`」，旧灰阶名 `--oaw-gray-*` 保留为别名；② 守护——新增 `scripts/设计令牌一致性测试.mjs`（`npm run test:design-tokens`，16 例），含**零视觉变化证明**（逐名解析 `var()` 链断言最终色值与交付时一致）与**硬编码色值棘轮**（393 处 / 129 种，只能减不能增）。改动**严格限定在两个 opt-in 块内**，基线 `:root` 与 `[data-theme="light"]` 未改一字。
  - 🟡 **未做（有证据的刻意不执行）**：执行标准第 2 条的「按主题域分批替换硬编码色值」（对话区 → 文档区 → 地图区 → 设置区）。扫描得 393 处 / 129 种硬编码色值，其中 11 种 / 111 处可 1:1 映射到 `:root` 令牌，但同名令牌在**亮色主题下取值不同**（如 `--text` 亮色为 `#2d3142`），且文件内不存在 `[data-theme="dark"]` 作用域块——任何 literal→token 替换都会改变亮色渲染外观，与「不改核心外观」冲突。迁移清单已由测试打印留存，待逐条人工决策后单独开批。
  - ✅ **验证**：`test:design-tokens` **16/16**；`test:a11y`（含 4 套主题对比度审计）、`test:motion`、`test:icons` 通过；`vite build` 成功且 `client/dist/assets/index-*.css`（约 345 KB）内含 `--op-gray-900` / `--op-comp-chat-bg`；`npm run verify` 冒烟 39/40（唯一失败为基线既有问题「Office 路由未识别」）。

- [ ] **P1-8 本轮对象栏（右侧）**
  - 输入：`server/成果管理.mjs`、`client/src/运行轨迹.js`、`client/src/运行展示投影.js`、`ChatPanel.jsx`
  - 执行标准：
    1. 执行流折叠条右上增 `+N` 对象计数徽标（本轮新增产出/来源/记忆条目数），点击展开右侧栏。
    2. 新增 `client/src/components/对象栏.jsx`，分组对齐 Qoder 命名：**产出 / 来源 / 技能与 MCP / 网页查阅 / 记忆**；顶部含**环境信息**块（工作区 / 分支 / 本地服务），**后台进程**独立分组（含停止/展开命令）。
    3. 数据源全部复用既有接口，**不新增后端端点**（产出走 `成果管理.mjs`；来源走运行轨迹归约；技能与 MCP 走既有技能/集成注册；网页查阅走 `server/内置浏览器.mjs` 状态；记忆走记忆模块）。
    4. 与既有面板（产物面板 / 记忆 Tab）**共用同一数据源不重复渲染**，右侧栏是聚合视图。
  - 依赖：P1-4（owner 归属决定分组归属）
  - 输出：`对象栏.jsx`、`ChatPanel.jsx` 徽标接线
  - 验证：`test:artifacts`、`test:run-view`、`test:main-flow` 全绿；新增 `scripts/对象栏聚合测试.mjs`（断言五分组计数与后端数据一致、空态正确）

- [ ] **§3.3 组件交互规范落地**
  - 输入：对标报告 §3.3 ①–⑥、`client/src/styles.css`
  - 执行标准：
    1. ① 执行流折叠条高 32px + 左侧状态点（running 蓝呼吸 / waiting-user 琥珀 / completed 绿 / failed 红 / interrupted 灰）；折叠显示"当前步骤 n/N · 耗时"；键盘 `Alt+↑/↓` 跳步骤、`Esc` 收起。
    2. ② 思考块：左侧 2px 竖线用 `--accent` 22% 透明；用户上滚即锁定不抢滚动；结束折叠为"思考了 Ns"。
    3. ③ 工具卡片：状态色**仅**用于左侧 3px 边条与状态点，卡片本体保持中性。
    4. ④ HITL 卡片三形态（approval / question / plan）+ 选项按钮主操作右置、危险操作红描边、快捷键 `1/2/3`（复用现有 `ask_user` 超时卡片实现）。
    5. ⑥ 动效 token：`--dur-fast 120ms / --dur-base 200ms / --dur-slow 320ms` + `--ease-out`；仅对 `transform/opacity` 动画。
  - 依赖：P0-4、P1-7
  - 输出：`styles.css` + `ChatPanel.jsx` 交互
  - 验证：`test:motion`、`test:a11y`、`test:chat-flow` 全绿
  - 🟡 **2026-10-18 部分落地（保持未勾选）**：① 状态点五态（运行=强调蓝+复用既有 `dot-breathe-soft` 呼吸 / 完成=绿 / 降级=琥珀 / 失败=红 / 无状态=中性灰；折叠条 32px 与「当前步骤 n/N · 耗时」沿用基线既有实现）② 思考块左竖线 3px→2px、强调色 22%（hover 45%）③ 工具卡片状态色只留左侧 3px 边条与状态图标、本体中性 ④ 审批卡左侧形态条 + 拒绝按钮红描边 ⑥ 动效令牌 `--dur-fast/--dur-base/--dur-slow` + `--ease-out`（暗/亮 opt-in 块内同值）——**全部限定在 `:root[data-oaw-style="qoder"]` 作用域**，沿用 P0-4/P1-7 的 `OAW_QODER_STYLE`（默认关），关闭后基线逐字不变。
  - 🟡 **未做（需改 JS，属渲染核心链路）**：① 键盘 `Alt+↑/↓` 跳步骤与 `Esc` 收起、② 思考块「用户上滚即锁定不抢滚动」、④ HITL 选项 `1/2/3` 快捷键与「主操作右置」（CSS `order` 反转视觉顺序会与 DOM 焦点顺序不一致，属 WCAG 2.4.3 风险，故不做）；④ 的「plan 形态」在现有卡片族中没有对应实现，未凭空新建。
  - ✅ **验证**：新增 `scripts/组件交互规范测试.mjs`（`npm run test:component-spec`，**10/10**）；`test:motion`、`test:a11y`、`test:icons`、`test:design-tokens` 通过；`vite build` 成功且产物 CSS 内含新段规则。

### M4 领域工作流（D49–D66）

- [x] **M4.1 工作流注册表与 DSL 加载器**
  - ✅ 2026-10-18 落地：`server/工作流注册表.mjs`（扫描 `server/工作流/*.mjs`、校验 `id/title/budget/tools/preflight/stages/artifacts`、导出 `列出工作流()` / `取工作流(id)` / `校验工作流()` / `注册表概览()`）；懒加载、不新建编排引擎；开关 `OAW_DOMAIN_WORKFLOWS` 默认关。
  - 验证：`scripts/工作流契约测试.mjs`（npm `test:workflow-contract`）**11/11 通过**。
  - 输入：对标报告 §4.4 DSL 形态、`server/工作流.mjs`（既有声明式技能工作流）、`server/运行预算.mjs`、`server/成果管理.mjs`、`server/审批策略.mjs`
  - 执行标准：
    1. 新增 `server/工作流注册表.mjs`：扫描 `server/工作流/*.mjs` 目录，校验声明结构（`id/title/budget/tools/preflight/stages/artifacts`），导出 `列出工作流()` / `取工作流(id)` / `校验工作流()`。
    2. **不新建编排引擎**：治理动作全部委托既有模块——`budget → 运行预算.mjs`、`approval:true 阶段 → 审批策略.mjs` 派发 `tool_approval_request`、`artifacts → 成果管理.mjs` 核对、阶段事件复用既有 `pipeline_*` 事件族。
    3. 目录与文件名遵守 `AGENT.MD` 中文命名（对标报告写作 `server/workflow/*.mjs`，落地改为 `server/工作流/`）。
  - 依赖：**P1-1（执行句柄）为强依赖**
  - 输出：`server/工作流注册表.mjs`、`server/工作流/` 目录
  - 验证：`test:capability-contract` 全绿；新增 `scripts/工作流契约测试.mjs`（断言六个声明可加载、字段齐全、非法声明被拒）

- [x] **M4.2 六个交通规划工作流声明**
  - 输入：对标报告 §4.3 表
  - 执行标准：按 §4.3 逐条落地六个声明文件（工具白名单沿用表中列出的既有工具名，**不新增工具**）：
    | 文件 | 工作流 | 阶段 | 产物契约 |
    |---|---|---|---|
    | `server/工作流/OD需求分析.mjs` | OD 需求分析 | 数据校验→矩阵构建→指标计算→可视化→结论 | OD 矩阵（校验记录数一致）/ 客流热力图 / 指标表 |
    | `server/工作流/路网评估.mjs` | 路网评估 | 数据装配→指标计算→拥堵识别→分级→报告 | 路网密度饱和度图层 / 拥堵清单 / 评估报告 docx |
    | `server/工作流/可达性分析.mjs` | 可达性分析 | 起终点确认→等时圈→覆盖率→地图→结论 | 等时圈 GeoJSON / 覆盖率表 / 专题图 |
    | `server/工作流/规范符合性审查.mjs` | 规范符合性审查 | 材料识别→规范检索→逐条比对→问题清单→批注写回（需确认） | 问题清单 / 批注标记 / 审查意见 docx |
    | `server/工作流/报告编排.mjs` | 报告编排 | 大纲→素材→分章→图表→排版→质检 | 多章 docx/pptx / 图表附件 / 目录页码一致 |
    | `server/工作流/数据源接入.mjs` | 数据源接入 | 源探测→字段映射→坐标校验→试导入→固化适配器 | 适配器配置 / 字段映射表 / 坐标校验报告 |
  - 依赖：M4.1
  - 输出：六个声明文件
  - 验证：`scripts/工作流契约测试.mjs` 六个全绿；`test:main-flow` 全绿
  - ✅ **2026-10-18 落地**：`server/工作流/` 下六个声明（`OD需求分析.mjs` / `路网评估.mjs` / `可达性分析.mjs` / `规范符合性审查.mjs` / `报告编排.mjs` / `数据源接入.mjs`），阶段与产物契约对齐 §4.3 表；工具白名单全部取自既有工具名（**未新增工具**）；`规范符合性审查` 的批注写回阶段 `approval:true`。
  - ✅ **验证**：`test:workflow-contract` 六个声明全部加载且字段齐全（11/11 通过）。

- [x] **M4.3 领域硬约束进 Harness（不进提示词）**
  - 输入：`AGENT.MD` §坐标与数据校验、`server/工作流注册表.mjs` preflight 机制、`server/事件注册表.mjs`
  - 执行标准：实现四个硬约束检查器并在 preflight 失败时**硬阻断**：
    | 检查 | 行为 | 事件（需登记） |
    |---|---|---|
    | `geoRange` | 经度 73–135°E、纬度 18–54°N，超范围立即阻断 | `geo_out_of_range` |
    | `recordCount` | OD/客流 `expected vs actual` 不等则不继续 | `data_integrity_failed` |
    | `writeBackGuard` | 任何 officecli 写回先触发 `review_waiting_confirmation`（复用现有事件） | 复用 |
    | `artifactRoot` | 产物必须落在 `office-workspace`，否则阻断（复用 `snapshotWorkspace` 判定） | `artifact_root_violation` |
  - 依赖：M4.1
  - 输出：`server/工作流校验.mjs`（前置检查器集合）
  - 验证：新增 `scripts/领域硬约束测试.mjs`（四类越界各一例，断言阻断 + 事件 + 无副作用）
  - ✅ **2026-10-18 落地**：`server/工作流校验.mjs` 四个纯函数检查器（`geoRange` / `recordCount` / `writeBackGuard` / `artifactRoot`）+ `运行预检()` 聚合 + `检查工具权限()`；四个新事件已登记（`geo_out_of_range` / `data_integrity_failed` / `artifact_root_violation` / `preflight_skipped`）；支持「显式跳过校验」降级分支留痕。
  - ✅ **验证**：`test:domain-guard` 12/12、`test:event-registry`（113 种）、`test:pi-iteration` 全通过；`npm run verify` 的 `vite build` 成功、冒烟 39/40（唯一失败为基线既有问题）。
  - ⚠️ **未接**：把检查器挂到运行链路的执行侧接线依赖 M4 前置的 P1-1 执行句柄（P1-1 未启动）。

- [ ] **M4.4 前端启动器与阶段条**
  - 输入：对标报告 §4.5 前两卡、`client/src/components/ChatPanel.jsx`、既有 `GET /api/workflows`
  - 执行标准：
    1. 输入区上方"工作流"选择条（数据来自既有 `GET /api/workflows`，扩展为同时返回声明式工作流）；选中后预置工具白名单与预算档。
    2. 显示**预检结果**（坐标范围、记录数一致性 红/绿点）。
    3. **预算可视化**：剩余轮次/工具调用，接近软预算变琥珀（数据来自既有 `运行预算.mjs` 的 `run_budget_notice`）。
    4. **阶段条**：横向阶段格三态（未开始/进行中/完成），点击展开该阶段产物；失败显示原因 + "重试该阶段"（复用 `retryRun`）；**与对话流折叠块共享同一事件源，不重复渲染**。
  - 依赖：M4.1、P1-8
  - 输出：新增 `client/src/components/工作流启动器.jsx`、`client/src/components/阶段条.jsx`
  - 验证：`test:main-flow`、`test:task-center`、`test:perf-budget` 全绿；新增 `scripts/工作流界面接线测试.mjs`（断言事件源唯一、预检点态正确）
  - 🟡 **2026-10-18 部分落地（保持未勾选）**：已交付**只读版**——`client/src/components/工作流启动器.jsx`（工作流选择条 + 描述/预算档/前置硬约束 + 工具白名单 + 产物契约 + 预检试算与红绿点）与 `client/src/components/阶段条.jsx`（三态阶段格），接进右侧工作区画布第四页签（开关 `OAW_DOMAIN_WORKFLOWS`，关闭时不渲染任何入口；服务端只读预检端点关闭时 404）；**未交付**：预算「剩余轮次/工具调用」实时值、阶段条点击展开该阶段产物、失败重试（`retryRun`）、以及「与对话流折叠块共享同一事件源」——这些都需要运行期数据，依赖执行侧接线。
  - ✅ **验证**：`test:workflow-ui` 8/8（含「开关关闭 = 基线不变」三项不变式与跨层字段契约）、`test:icons` / `test:a11y` / `test:motion` 通过；运行时 A/B：开关开 = `workflows:4 + domain:6` 且预检端点 200，开关关 = 仅 `workflows` 且预检端点 404。

### M5 Harness 化收尾（D67–D78）

- [ ] **M5.1 成果验收台**
  - 输入：`server/成果管理.mjs`、`/api/runs/:id/artifacts`、`/api/runs/:id/rollback`
  - 执行标准：新增 `client/src/components/成果验收台.jsx` —— 按 `artifacts` 契约展示核对结果（必需项缺失标红）；每项支持预览/采纳/打回，采纳写 `POST /api/runs/:id/artifacts/:id/accept`；回滚入口复用既有 `rollbackRun` / `rollbackPublishedArtifact`。
  - 依赖：M4.2
  - 输出：`成果验收台.jsx`
  - 验证：`test:artifacts`、`test:gis-e2e` 全绿；新增 `scripts/成果验收台测试.mjs`（缺失必需项标红、采纳/打回状态流转）
  - ❌ **2026-10-18 评估后不实施**：既有 `client/src/components/工作产物面板.jsx` 已覆盖本任务全部操作面（逐产物验收状态 / 人工确认→`accept` / 固定→`publish` / 回滚→`rollbackPublishedArtifact`），且已消费 `GET /api/runs/:id/acceptance`；新建独立面板会造成**同一数据源重复渲染**（违反 §1.4 与 §6 的不重复原则）。其唯一增量「按工作流 artifacts 契约核对、必需项缺失标红」依赖 Run ↔ 工作流声明的绑定，而执行侧接线尚未交付（强依赖 P1-1），此时只能启发式猜测，结论不可解释。**待执行侧接线交付后再评估。**

- [ ] **M5.2 地图 ↔ 对话联动**
  - 输入：`client/src/components/MapViewer.jsx`、`/api/context/resolve`、`client/src/图层注册表.js`
  - 执行标准：对话中产生的图层/等时圈/热力图自动进入右侧对象栏「产出」，点击在地图定位；地图当前视域（bbox）作为上下文注入下一轮；只读与临时层标记清晰（保持 `test:map-readonly` 语义）。
  - 依赖：P1-8、M4.2
  - 输出：`对象栏.jsx` 地图定位接线、`MapViewer.jsx` bbox 上报
  - 验证：`test:map-readonly`、`test:map-chat`、`test:map-visual` 全绿

- [ ] **M5.3 P2 六项打磨**
  - 执行标准：
    | 编号 | 落点 | 要点 |
    |---|---|---|
    | P2-1 缺号告警 | `client/src/运行轨迹.js` + `事件注册表.mjs` | `seq` 跳变上报 `seq_gap_detected`（**需登记**），不改变淘汰策略 |
    | P2-2 心跳可配 | `server/index.mjs` / `流连接.mjs` | 环境变量 `OAW_STREAM_HEARTBEAT_MS`，默认沿用现值（对话 5s / 事件 15s） |
    | P2-3 `still_queued` 回执 | `/api/agent/abort`、`/api/runs/:id/cancel` | 取消响应体增 `stillQueued: n`；前端区分"已停/排队中已停" |
    | P2-4 视觉特效开关 | `theme.jsx` + `styles.css` | `:root[data-visual-effects="off"]` 去 `backdrop-filter`/位移/模糊，并在设置面板暴露开关 |
    | P2-5 事件量级遥测 | `server/事件存储.mjs` + 诊断面板 | 按类型统计发送量/淘汰量，`registrySummary()` 扩展 |
    | P2-6 对比度审计 | `scripts/无障碍与窄屏测试.mjs` | 增 WCAG AA 对比度断言，纳入 `test:a11y` |
  - 依赖：M1–M4 全部完成
  - 输出：六项改动
  - 验证：`test:a11y`、`test:sse-protocol`、`test:event-registry`、`test:pi-iteration` 全绿；新增 `scripts/视觉特效开关测试.mjs`、`scripts/事件缺号告警测试.mjs`

---

## 四、文件结构总览（改动面锁定）

| 文件/目录 | 动作 | 职责 | 阶段 |
|---|---|---|---|
| `client/src/components/ChatPanel.jsx` | 修改 | 退避抖动与错误分类、提交门禁、收尾态、HITL 内联、`+N` 徽标 | M1/M2/M3 |
| `server/流连接.mjs` | 修改 | 背压泵与分片器、按 path 配额、陈旧流停摆、`Retry-After` | M1/M2 |
| `server/index.mjs` | 修改 | 对话流接线、配额拒绝分支、心跳可配、`still_queued`、路由薄壳化 | M1–M5 |
| `server/runs.mjs` | 修改 | Run 状态机增 `draining` 三态边界 | M1 |
| `server/事件注册表.mjs` | 修改 | 新增 `run_draining` / `tool_output_delta` / `interaction_owner_changed` / `geo_out_of_range` / `data_integrity_failed` / `artifact_root_violation` / `seq_gap_detected`；可选 `schema` 字段 | M1–M5 |
| `server/事件存储.mjs` | 修改 | schema 校验挂载点、量级遥测 | M2/M5 |
| `server/执行句柄.mjs` | **新建** | 统一执行契约（`AGENT.MD` 中文命名） | M2 |
| `server/agent.mjs` | 修改 | `ask_user` 载荷补 `owner` | M2 |
| `server/审批策略.mjs` | 修改 | 按 owner 派发、写回保护钩子 | M2/M4 |
| `server/工作流注册表.mjs` | **新建** | 声明式工作流加载与校验 | M4 |
| `server/工作流/OD需求分析.mjs` 等 6 个 | **新建** | 领域工作流声明 | M4 |
| `server/工作流校验.mjs` | **新建** | preflight 硬约束检查器 | M4 |
| `client/src/components/对象栏.jsx` | **新建** | 本轮对象聚合栏（五分组 + 环境信息 + 后台进程） | M3 |
| `client/src/components/工作流启动器.jsx` | **新建** | 工作流选择条 + 预检 + 预算可视化 | M4 |
| `client/src/components/阶段条.jsx` | **新建** | 阶段三态 + 重试 | M4 |
| `client/src/components/成果验收台.jsx` | **新建** | artifacts 契约核对 + 采纳/打回 | M5 |
| `client/src/styles.css` | 修改 | 令牌三层化、组件规范、视觉特效开关 | M1/M3/M5 |
| `client/src/theme.jsx` | 修改 | `data-visual-effects` 开关 | M5 |
| `client/src/运行轨迹.js` | 修改 | 缺号告警 | M5 |
| `client/src/components/MapViewer.jsx` | 修改 | bbox 上报 | M5 |
| `DESIGN.md` | 修改 | 令牌基线与字体规范同步 | M1/M3 |
| `server/模型目录dev.mjs`、`server/供应商目录.mjs` | 修改 | T0.1 收口（已在工作区，非本计划新增） | M0 |
| `scripts/`（~14 个中文命名测试脚本） | **新建** | 见测试计划 §4 | M0–M5 |
| `变更日志.md` | 修改 | 每阶段一条 | M0–M5 |

**改动面边界声明：** 上表之外的文件不改。不新增 `server/` 之外的进程、不新增前端工程、不新增构建配置、不新增第三方依赖（typebox 为 Pi SDK 既有依赖）。

---

## 五、验收标准（每阶段 DoD）

一个阶段算完成，必须**同时**满足：

1. **构建**：`npm run build` 成功；`npm run verify` 退出码 0。
2. **回归**：该阶段涉及模块对应的既有 `test:*` 脚本全绿（映射见 `2026-10-18-002-...` §5）。
3. **专项**：该阶段新增的 `scripts/*测试.mjs` 全绿。
4. **事件合规**：新增事件类型已登记，`test:pi-iteration` 通过。
5. **文档**：本文档该阶段复选框逐条勾选；`变更日志.md` 已记录本次改了哪些既有行为。
6. **回滚**：确认回滚路径可用（小改动说明即可，大改动需实测）。

### G 门禁（阶段末评审用）

| 门 | 判定条件 |
|---|---|
| **G0** | `git status` 干净；全量回归基线结果成表；改动面评审签字 |
| **G1** | 4 项 P0 全绿；`test:sse-protocol` / `test:chat-flow` / `test:a11y` / `test:motion` 通过；人工视觉比对通过 |
| **G2** | 6 项 P1 全绿；`test:pi-iteration` 全绿；新增执行句柄契约测试与流配额测试通过 |
| **G3** | `test:main-flow` / `test:approval` / `test:task-center` 通过；窄屏适配无错乱 |
| **G4** | 工作流契约测试全绿；六工作流各跑通一次真实场景；`test:gis-e2e` 通过 |
| **G5** | `test:artifacts` / `test:map-chat` / `test:perf-budget` 通过；P2 六项专项测试通过；全量回归 100% |

---

## 六、依赖与关键路径

```
T0.1 ─┬─ P0-4 ─┬─ P1-7 ─┬─ §3.3 ─┐
      │        │        │        │
      ├─ P0-1 ─┴─ P1-5 ─┬─ P1-6   │
      ├─ P0-2 ─┬─ P1-1 ─┼─ P1-4 ──┼─ P1-8 ─┬─ M4.1 ─ M4.2 ─┬─ M5.1
      │        │        │         │        │              ├─ M5.2
      │        └─ P0-3 ─┘         │        └─ M4.4 ───────┘
      └─ P1-2 ────────── P2-5     └─ M4.3
```

**强依赖（不得插队）：**
- `P0-2 → P0-3`：共用投递通路，先有背压再谈排空。
- `P0-3 → P1-1`：`draining` 是执行句柄状态机的一部分。
- `P1-1 → M4.1`：领域工作流的预算门/审批点/产物契约必须挂在统一句柄上。
- `P0-4 → P1-7`：先有令牌块，才能谈三层化。
- `P1-4 → P1-8`：owner 归属决定对象栏的分组归属与内联位置。

**弱依赖（可并行，缺失时有降级分支）：**
- `P1-5 → P0-1`：无 `Retry-After` 头时按 `network` 分支退避。
- `P1-8 → M4.4`：阶段条先独立渲染，对象栏接入后再联动。

---

## 七、风险与不做清单

### 7.1 风险（沿用对标报告 §6.1，补充本计划实测风险）

| 风险 | 说明 | 缓解 | 责任阶段 |
|---|---|---|---|
| 视觉令牌全站替换引发回归 | 429 KB 样式直写色值 | 新增令牌块 + 旧变量别名；分主题域四批替换；每批跑 `test:a11y` | M1/M3 |
| 中断排空改变时序 | 新增 `draining` 阶段可能让前端误判"卡住" | draining 期间发心跳并显示"正在收尾"；窗口上限 1.5s 强制结束 | M1 |
| 背压分片破坏既有事件消费 | `tool_output` → `tool_output_delta` 是新事件，老前端不认识 | 新事件登记为 `lifecycle:false`；前端归约层保持向后兼容（无 `delta` 时按原样处理） | M1 |
| 服务端配额影响多标签页 | 配额过紧会拒绝正常使用 | 配额按 `path` 分级，对话流保留 essential 优先；拒绝时返回可读原因 + `Retry-After` | M2 |
| 领域 preflight 过严 | 坐标/记录数硬阻断可能挡住合法的探索性任务 | 提供"继续（跳过校验）"显式确认，并记 `preflight_skipped` 事件留痕 | M4 |
| 工作流 DSL 过度设计 | 抽象过重反而拖慢新增场景 | DSL 保持声明式、无逻辑分支；复杂逻辑一律下沉到工具实现 | M4 |
| 事件 schema 铺开过大 | 130+ 事件全量补 schema 会拖垮进度 | 首批只覆盖新增/改动事件 + 4 个 HITL/终态事件，其余留空 | M2 |
| **历史遗留测试失败** | 76 个 `test:*` 自动执行 72 个（4 个 `:live` 需人工触发）：**通过 58 / 失败 14**，其中 **13 项在优化前基线提交 `1b17294e` 上逐条复现同样失败**（清单见测试计划 §5.1） | T0.2 先跑基线并登记为"已知遗留"，不计入本计划门禁 | M0 |
| **未提交改动与改造冲突** | 工作区已有 15 个文件改动（含 `ChatPanel.jsx`、`styles.css`、`server/index.mjs` 三个改造热点） | T0.1 必须先收口，**未收口不得开始 M1** | M0 |

**风险预案 R0：** 里程碑延误 >2 天 → 冻结该阶段的非必要项（P2 项全部可延后至 M5），保证 P0/P1 关键路径不断。

### 7.2 不做清单（对标报告 §6.2 + `AGENT.MD` 边界，全程遵守）

- **不**采用 Qoder 皮肤引擎（6 Flavor × N Swatch）；只吸收其 `color-mix()` 派生手法。
- **不**把对话流改为手写 SSE 解析；保留原生 `EventSource`。
- **不**修改 Pi 内核；**不**引入官方不存在的 subagent / plan mode。
- **不**追求复刻 Qoder 界面；保留项目已有强项（子代理契约含对抗式核验、运行预算、事件注册表、成果验收），只对齐视觉语言与交互范式。
- **不**新增独立应用/前端工程/后端服务/构建配置/第三方依赖。
- **不**把 `.oaw/runs/` 纳入提交（已 `.gitignore`）。

---

## 八、变更日志与提交规范

- 每个任务完成：勾选本文档复选框 + `变更日志.md` 追加一行，写明**改了什么 + 影响哪些既有行为**。
- 提交信息格式：`类型: 描述`（`feat` / `fix` / `docs` / `chore`），单提交单一主题。
- 新增事件类型必须与使用它的代码**同一提交**，否则 `test:pi-iteration` 必失败。
- 每阶段末在 `变更日志.md` 记一条阶段小结（对应 G 门结论）。

---

## 九、合规校验（"不得超出原有预设范围"的自证）

| 校验项 | 结论 | 判定依据 |
|---|---|---|
| 是否引入报告之外的新目标？ | 否 | §1.4 追溯矩阵，18 项偏差 + §4 全部可回指报告章节 |
| 是否新增产品形态？ | 否 | §4 改动面锁定，无新工程/新服务/新框架/新依赖 |
| 是否违反 `AGENT.MD` 中文命名？ | 否 | 报告中的 `server/workflow/*.mjs`、`ExecutionHandle` 在 §4 已改为中文命名 |
| 是否触碰 Pi 能力边界？ | 否 | §7.2 不做清单；多技能协作仍走既有"技能集合 + 前端工作流" |
| 是否改变既有需求行为？ | 仅 P0-1 与 P2-2 触及既有行为，且均为**预设行为的增强**（"自动重连"保留，"心跳间隔"默认值不变） | §0.2 对照表 |
| 是否有不可回滚项？ | 否 | 令牌采用"新增 + 别名"；新事件为增量；工作流为新增目录 | §7.1 |

---

## 评审记录

| 日期 | 参与 | 结论 | 备注 |
|---|---|---|---|
| 2026-10-18 | — | 待评审 | 本文档由 `Qoder对标评审与交通规划Harness方案.html` 拆解生成，配套测试计划见 `docs/plans/2026-10-18-002-Qoder对标整改迭代测试计划.md` |
| 2026-10-18 | 自动核对（待你签字） | T0.3 改动面与边界**核对通过**（6 项偏差已逐条记录；文档待补项 `DESIGN.md` 已于同日闭环） | 核对范围 `1b17294e..HEAD` 三个提交；详见下方「T0.3 改动面锁定评审」 |

### T0.3 改动面锁定评审（2026-10-18 自动核对）

**核对对象：** `1b17294e..HEAD`（`71990230` 六批 + `85689513` §3.3 + `ebb819d7` T0.2）共 **41 个文件**，全部落在 `client/src/`、`server/`、`scripts/`、`docs/plans/` 与根目录两个文件（`package.json`、`变更日志.md`）。

**§4 边界声明逐条核对：**

| 边界声明 | 核对结果 | 证据 |
|---|---|---|
| 不新增 `server/` 之外的进程 / 服务 | 通过 | 改动面无新入口、无 `scripts/服务监督.mjs` 变更 |
| 不新增前端工程 / 构建配置 | 通过 | `client/` 只有 `src/**` 改动；`vite.config.js` 未动 |
| 不新增第三方依赖 | 通过 | `package.json` 仅新增 8 条 `test:*` 脚本；`package-lock.json` 未改 |
| 改动面锁定在 §4 表内 | 见下表：6 项差异 + 6 类同性质文件 | `git diff --name-status 1b17294e..HEAD` |

**与 §4 文件表的差异（逐条核对理由）：**

| 差异 | 说明 |
|---|---|
| §4 列了但未改 `server/runs.mjs` | P0-3 的服务端有界排空落在 `server/agent.mjs`（`emitAbortedOnce`），Run 状态机本身无需改，`draining` 仅作为事件态呈现 |
| §4 列了但未改 `client/src/theme.jsx` | P2-4 的 `data-visual-effects` 打标实际落在 `client/src/App.jsx`，语义相同 |
| §4 列了但未新建 `server/执行句柄.mjs` | P1-1 未启动（会动 `runs.mjs`/`agent.mjs`/`Pi运行时管理.mjs` 的对外能力，属核心链路，待你确认） |
| §4 列了但未新建 `client/src/components/成果验收台.jsx` | M5.1 评估后**不实施**：既有「工作产物面板」已覆盖逐产物验收/采纳/固定/回滚并消费 `GET /api/runs/:id/acceptance`，新建即重复渲染 |
| §4 列了但未改 `client/src/components/MapViewer.jsx` | M5.2 地图↔对话联动未启动（会动地图组件） |
| §4 的 `DESIGN.md` | **已补（2026-10-18）**：新增「设计令牌三层结构」「Qoder 视觉层（opt-in · 默认关）」「排版与字体（现状）」三节，并给旧「字体」小节加现状注（**原内容一字未删改，只追加**）；同时把「拆 `--font-sans` / `--font-mono` 令牌」登记为需确认项 |
| §4 未列但已改（同性质） | `client/src/App.jsx`（画布页签/开关打标）、`client/src/api.js`（复用既有只读端点封装）、`client/src/运行开关.js`、`client/src/长连接预算.js`（缺号记录）、`client/src/事件展示.js`、`client/src/对象聚合.js`（对象栏纯函数）、`scripts/无障碍与窄屏测试.mjs`、`scripts/动效治理测试.mjs` |

**结论：** 改动面落在计划范围内，**无新增工程 / 服务 / 框架 / 第三方依赖**；6 项偏差中 5 项为「未启动 / 不实施 / 落点不同」，1 项为文档待补（`DESIGN.md`）**已于同日补齐**。**T0.3 待你签字确认后再勾选。**
