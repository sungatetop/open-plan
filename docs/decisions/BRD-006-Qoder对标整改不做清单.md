---
title: BRD-006 Qoder对标整改不做清单
summary: 对标整改的边界：不改 Pi 内核、不做皮肤引擎、不改手写 SSE 解析、不引入 subagent/plan mode
keywords: [ADR, 不做清单, Qoder, 对标, 边界]
status: done
date: 2026-10-19
---

# BRD-006 Qoder 对标整改"不做清单"

- 状态：已定稿（2026-10-18，Qoder 对标整改计划 §0.3）
- 出处：`docs/plans/2026-10-18-001-Qoder对标整改与交通规划Harness迭代修改计划.md`

## 背景

Qoder 逆向报告提出 18 项能力偏差，若全盘对标会造成内核侵入与工程失控。

## 决策（明确不做）

1. **不改 Pi 内核**（与 BRD-001 一致）。
2. **不做通用皮肤/主题引擎**——只做暗/亮双主题 + Qoder 视觉层 opt-in（BRD-003 门控）。
3. **不重写手写 SSE 解析层**——已有流预算与去重防护（stream-budget）。
4. **不引入 Pi 原生 subagent / plan mode**——能力走 skill 与前端工作流（产品已有 subagent-orchestrator 自研编排）。

## 后果

- 正面：整改范围可控，18 项偏差逐项判定可引入性（P1-9~P1-17、P2-7~P2-10 为可引入集）。
- 代价：部分对标项放弃，以文档记录理由避免重复争论。
