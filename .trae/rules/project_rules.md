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
| 代码目录 | `client/`、`server/`、`scripts/` |
| 内容与数据目录 | `templates/`、`docs/`、`designs/`、`office-workspace/`（服务运行时默认工作区，路径被产品代码引用，勿随意改名；`maps/` 下为运行时地图项目数据） |

禁止在根目录新增：临时文件（`_t.txt`、`*.bak` 等）、脚本（入 `scripts/`）、文档（入 `docs/`）、数据 JSON（随所属脚本或入运行时配置）。

## 3. 脚本管理规范

- `scripts/` 根目录：仅存放 `package.json` 直接引用的回归测试与运维脚本（测试即脚本，`node scripts/*.mjs`），保持现状不挪动
- `scripts/ops/`：服务启停（.ps1）、工作区批注、文档维护等运维脚本
- `scripts/reporting/`：汇报 / 视频 / 口播稿生产脚本，配套数据放 `scripts/reporting/data/`
- 新增脚本按上述归入子目录；确需被 `package.json` 引用时才可放 `scripts/` 根目录
- 脚本内引用项目根路径时统一用 `path.resolve(__dirname, ...)` 锚定，不依赖当前工作目录
