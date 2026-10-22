# 项目规则（Project Rules）

## 1. 文档管理规范

### 1.1 存放位置

所有文档统一存放在 `docs/` 目录下，按类别建立子文件夹，禁止将正式文档散落在项目根目录或其他位置。

| 类别 | 目录 | 内容 |
|---|---|---|
| 方案文档 | `docs/solutions/` | 实施方案 / 设计方案 / 改造方案 / 路线图方案 / 线框图 |
| 决策文档 | `docs/decisions/` | 技术选型 ADR（编号 `BRD-001-xxx.md`） |
| 模块设计 | `docs/module-design/` | 各模块详细设计（接口 / 契约 / 数据模型） |
| 参考资料 | `docs/references/` | 调研、外部对标、接入指南、契约、示例副本；汇报材料（口播稿 / docx）存 `references/汇报材料/`，界面原型 HTML 存 `references/prototypes/` |
| 计划与执行记录 | `docs/plans/` | ImplementationPlan / 迭代计划 / 执行记录；新文档命名 `YYYY-MM-DD-NNN-主题.md`，历史文档保留原名 |
| 报告 | `docs/reports/` | 交付报告 / 验证报告 / 诊断报告 / 分析报告 / 评审结论 / 复盘 |
| 数据 | `docs/data/` | 文档配套数据、静态数据集副本、GIS 数据归档（`provincial-gis/` 原始 shp/gdb 归档、`zhejiang-osm/` OSM 分析产物）；大产物文件按 `.gitignore` 排除入库 |
| 审计资产 | `docs/audits/`、`docs/*审查截图/` | 审计过程文档及其截图 / JSON 测量资产，保持原位 |

`docs/` 根目录只允许存放子目录与 `docs/README.md`（分类导航索引），不允许再新增散落文档。

### 1.2 YAML frontmatter（强制）

每个 Markdown 文档头部必须包含 YAML frontmatter，字段包括 `title` / `summary` / `keywords` / `status` / `date`，缺一不可（HTML 原型不受此约束）。

```yaml
---
title: 文档标题
summary: 一句话概述文档内容
keywords: [关键词1, 关键词2, 关键词3]
status: draft        # draft | in-progress | done | deprecated
date: 2026-10-19
---
```

字段说明：

- `title`：文档标题，与正文 H1 保持一致
- `summary`：一句话概述，便于检索与汇总
- `keywords`：检索关键词列表（数组）
- `status`：文档状态，取值 `draft`（草稿）/ `in-progress`（编写中）/ `done`（已定稿）/ `deprecated`（已废弃）
- `date`：创建日期，格式 `YYYY-MM-DD`

### 1.3 决策文档编号

`docs/decisions/` 下的 ADR 按序号编号，格式为 `BRD-001-xxx.md`（`xxx` 为短横线分隔的主题描述），序号递增，不复用、不跳号。

## 2. 根目录整洁规范

项目根目录只允许以下内容，其余一律归位：

| 类型 | 允许项 |
|---|---|
| 工程配置 | `package.json`、`package-lock.json`、`.gitignore`、`.gitattributes`、`.file-roots.json`、`.github/`、`.vscode/`、`.trae/`、`.claude/`、`.superpowers/` |
| 顶层文档 | `README.md`、`REQUIREMENTS.md`、`DESIGN.md`、`AGENT.MD`、`变更日志.md`（唯一豁免的常驻活文档） |
| 运行时配置 | `kb.json`（`server/kb.mjs` 从项目根读取，等同配置文件） |
| 运行时数据 | `.oaw/`（Office Agent Workspace 运行时数据）、`.规聚会话/`（会话运行时数据）、`.agent-context.md`（Office 上下文，运行时生成）；三者均已 gitignore，不入库 |
| 代码目录 | `client/`、`server/`、`scripts/`、`electron/`（桌面端一体化 monorepo，BRD-009） |
| 内容与数据目录 | `templates/`、`docs/`、`designs/`、`office-workspace/`（服务运行时默认工作区，路径被产品代码引用，勿随意改名；`maps/` 下为运行时地图项目数据） |

禁止在根目录新增：临时文件（`_t.txt`、`*.bak` 等）、脚本（入 `scripts/`）、文档（入 `docs/`）、数据 JSON（随所属脚本或入运行时配置）。

## 3. 脚本管理规范

- `scripts/` 根目录：仅存放 `package.json` 直接引用的回归测试与运维脚本（测试即脚本，`node scripts/*.mjs`），保持现状不挪动
- `scripts/ops/`：服务启停（.ps1）、工作区批注、文档维护等运维脚本
- `scripts/reporting/`：汇报 / 视频 / 口播稿生产脚本，配套数据放 `scripts/reporting/data/`
- 根 `package.json` 的 `desktop:*` 系列命令（dev / build / typecheck / test / smoke）统一代理到 `electron/`（`npm --prefix electron run ...`）；桌面端自有脚本放 `electron/scripts/`，不在 `scripts/` 新增桌面端脚本
- 新增脚本按上述归入子目录；确需被 `package.json` 引用时才可放 `scripts/` 根目录
- 脚本内引用项目根路径时统一用 `path.resolve(__dirname, ...)` 锚定，不依赖当前工作目录

## 4. 桌面端架构规范（BRD-009 现行）

- `electron/` 为桌面端唯一演进方向，结构：`src/main`（Node 侧后端，承载全部领域服务，不监听端口）、`src/preload`（contextBridge 桥接）、`src/renderer`（TS + React 前端）、`src/shared`（跨层共享：`protocol/` 为 115 事件注册表单一事实源，`runtime/` 为纯函数域）
- 全仓 TypeScript strict；协议以 typebox schema → TS 类型打通，禁止在 TS 侧另立协议副本
- 前后端经 IPC 通信（事件推送沿用 event-registry 协议），桌面端新代码禁止引入 HTTP/SSE 通道
- 迁移采用绞杀者模式分域推进（后端 B1-B6 / 前端 F1-F6 / 基建 R0-R6）：每迁移一个域须先通过功能等价验收（跨仓对拍 + 既有回归基线）再切换；迁移期旧 `client/`、`server/` 共存，按域吞并后退役
- 桌面端验收命令：`npm run desktop:typecheck`、`desktop:build`、`desktop:test`（vitest）、`desktop:smoke`

## 5. 提交规则（Git Commit）

### 5.1 提交信息格式

- 采用 Conventional Commits：`type(scope): 中文主题行`
- 允许的 type：`feat` / `fix` / `perf` / `docs` / `test` / `chore` / `ci` / `release` / `merge`
- scope 用小写英文域名（如 `agent`、`ui`、`gis`、`events`、`qoder`、`ops`、`providers`、`plans`、`test`、`ci`），无明确归属可省略
- 主题行用中文、一句话讲清"做了什么"；版本收口可带版本号，开关类改动可带 flag 名（如 `OAW_REPLAY_RECOVER 默认关`）

### 5.2 提交正文（Body）

- 以 `-` 分点列出关键改动，一条一个事实；引用方案/决策文档时写明路径
- 涉及代码或测试的提交必须带「验证」段：列出实际执行的测试命令与结果（如 `test:event-payload 11/11`、`desktop:smoke SMOKE_OK`），不得凭空宣称
- 有意不做的事项写入「未做」段，避免后人误判遗漏；已知基线既有失败需显式标注"基线既有"
- 提交前至少跑改动面相关的 `test:*` 回归；桌面端改动跑 `desktop:typecheck` + `desktop:test` + `desktop:smoke`；纯文档改动可免测试但需在 body 声明

### 5.3 提交粒度与拆分

- 一条提交只收口一条工作线；跨线改动分开提交，未纳入的留置改动需在 body 中显式说明
- 分阶段实施按阶段逐个提交，每阶段附简要总结，不积攒大杂烩提交
- 纯文档改动用 `docs` 前缀单独提交，不与代码混提
- 版本收口用 `release` / `chore(release)` 提交，同步 `变更日志.md` 与 README 版本号

### 5.4 禁止项

- 禁止提交密钥/凭据类文件（`.env`、`credentials.json` 等）
- 禁止提交临时文件与运行时产物（`_t.txt`、`*.bak`、`_smoke_*.log`、`_svc_*.log` 等）
- 禁止 `--no-verify` 跳过钩子、禁止对主干 force push
- 大体积产物按 `.gitignore` 排除（如 `docs/data/` 下大文件、`models-dev` 目录缓存）

## 6. Agent 测试环境（大模型供应商）

Agent 功能测试（如 smoke / 联调 / 冒烟中需真实调用大模型的场景）统一使用以下供应商配置：

- Base URL：`http://172.17.114.48/v1`
- API Key：`sk-1aRDVo5ep3kD_HxY5Orz588rNYiV5E6IrTZn7KU4ksE`

说明：该端点仅限内网测试使用，不得用于生产配置或提交到任何凭据类文件。
