---
title: BRD-001 Pi 内嵌运行时不换内核
summary: 采纳 Pi Agent SDK 作为进程内运行时内核，且长期不替换内核——先收敛短板、建内核接缝、DSH 仅作可选第二内核
keywords: [ADR, Pi Agent SDK, 运行时, 内核, Harness]
status: done
date: 2026-10-19
---

# BRD-001 Pi 内嵌运行时，不换内核

- 状态：已定稿（2026-08-21 首次决策，2026-10-15 复核收敛）
- 出处：`docs/plans/2026-08-21-001-重构-桌面端智能体内核落地计划.md`、`docs/plans/2026-10-15-自研Harness对标分析与优化落地计划.md`

## 背景

产品需要 Agent 运行时（会话、模型目录、工具、技能、事件流）。可选路线：自研 Agent loop、引入 OMP/Bun 全量运行时、或内嵌 Pi Agent SDK。当时 Pi 0.83.0 已在用且具备 createAgentSession / ModelRuntime / SessionManager / customTools 全链路。

## 决策

1. **Pi 作为内置运行时**，进程内嵌入，不复制 Pi 源码。
2. Open Plan 自定义 Runtime Adapter、Agent Profile、插件清单与权限策略，Pi 只是第一个实现（隔离升级风险）。
3. **长期不换内核**（2026-10-15 对标 DSH/Claude Code/Codex 等 7 个 Harness 后复核）：产品定位是"领域专家工作台"，与通用 Harness 互补；演进路径为「收敛短板 → 内核接缝（seam）→ DSH 仅作可选第二内核」，不做运行时替换。
4. 不引入 Pi 原生 subagent / plan mode；新能力优先做 skill 与前端工作流。

## 后果

- 正面：内核能力免费获得（会话树、模型目录、技能发现），产品精力集中于领域能力。
- 代价：受 Pi 版本节奏约束，必须锁定依赖并通过适配层隔离（当前 1.1.0）。
- 守护：Agent 链路模块（agent.mjs / pi-runtime.mjs）是唯一允许 import Pi SDK 的边界。

## 现状

- 已生效：全库统一经 Pi SDK 会话链路；U1-U11 优化均基于 SDK 原生能力（见 BRD-004）。
- 待办：内核接缝（seam）尚未显式建模；OMP models.yml 只读导入适配留后续。
