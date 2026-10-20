---
title: 文档中心索引
summary: docs/ 目录分类导航：计划、方案、决策、模块设计、参考、报告与审计资产的存放规则和入口。
keywords: [文档索引, 分类导航, docs, 规范]
status: done
date: 2026-10-19
---

# 文档中心索引

本目录是项目唯一文档区。分类规则见 [.trae/rules/project_rules.md](../.trae/rules/project_rules.md) §1，要点：

- 每个 Markdown 文档头部必须有 YAML frontmatter（title / summary / keywords / status / date）
- 新增计划文档命名 `YYYY-MM-DD-NNN-主题.md`；决策 ADR 命名 `BRD-001-xxx.md`
- `docs/` 根目录不再新增散落文档

## 分类导航

| 目录 | 内容 | 现状 |
|---|---|---|
| [plans/](plans/) | 实施计划 / 迭代计划 / 执行记录 | 47 篇，含 `assets/` 配图 |
| [solutions/](solutions/) | 实施方案 / 设计方案 / 适配与落地方案 / 线框图 | 19 篇 |
| [decisions/](decisions/) | 技术选型 ADR（`BRD-001-xxx.md`）：运行时内核/双壳/feature-flag/事件治理/桌面端路线等 9 条关键决策（BRD-007/008 已被 BRD-009 取代） | 9 篇 |
| [module-design/](module-design/) | 各模块详细设计（接口 / 契约 / 数据模型） | 1 篇（架构总览） |
| [references/](references/) | 调研、外部对标、接入指南、契约、示例副本 | 6 篇 |
| [references/汇报材料/](references/汇报材料/) | 口播稿与汇报 docx | 2 份 |
| [references/prototypes/](references/prototypes/) | 界面原型 / 动效演示 HTML | 3 份 |
| [references/zhejiang-osm/](references/zhejiang-osm/) | 浙江 OSM 路网调研 / 等时圈 demo（管线脚本在 `scripts/tools/zhejiang-osm/`） | 3 份 |
| [reports/](reports/) | 交付报告 / 验证报告 / 诊断报告 / 评审结论 / 复盘 | 14 篇 |
| [data/](data/) | 数据归档：`provincial-gis/` 原始 shp/gdb、`zhejiang-osm/` OSM 分析产物（大文件按 .gitignore 排除） | 33+ 份 |
| [audits/](audits/) | 审计过程文档与截图资产 | 1 组 |
| [交互审查截图/](交互审查截图/)、[图标审查截图/](图标审查截图/) | 审查截图与测量 JSON 资产 | 29 份 |

## 常用入口

- 项目总览：[README.md](../README.md)
- 需求与设计：[REQUIREMENTS.md](../REQUIREMENTS.md)（R1-R14）、[DESIGN.md](../DESIGN.md)（设计目标/总体架构）
- 架构与决策：[module-design/架构总览.md](module-design/架构总览.md)、[decisions/](decisions/) ADR 系列
- 后续开发路线：[plans/2026-10-19-001-规聚产品基线与后续开发路线.md](plans/2026-10-19-001-规聚产品基线与后续开发路线.md)
- 变更记录：[变更日志.md](../变更日志.md)
- 版本管理：[plans/版本管理计划.md](plans/版本管理计划.md)
