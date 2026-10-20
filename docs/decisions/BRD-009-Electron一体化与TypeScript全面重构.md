---
title: BRD-009 Electron一体化与TypeScript全面重构
summary: 业务核心收进 Electron（utilityProcess 业务核），前端以 TypeScript+React 重建，对现有 JS 前后端做渐进式彻底重构，功能等价或更优
keywords: [ADR, Electron, TypeScript, 重构, utilityProcess, monorepo, 功能等价]
status: done
date: 2026-10-19
---

# BRD-009 Electron 一体化与 TypeScript 全面重构

- 状态：已定稿（2026-10-19，**取代 BRD-008 的 sidecar 复用 + JS 前端路线**）
- 出处：`docs/solutions/2026-10-19-Electron一体化TypeScript重构方案.md`

## 背景

BRD-008 采用"Electron 壳 + sidecar 复用现有 JS server + 复用 JS 前端"的最小增量路线。修正方向的需求：

1. **架构收敛**：产品定位单机桌面工作台，业务核心不应以独立 HTTP 服务形态存在（端口占用/生命周期割裂/安全面暴露）；应收进 Electron 进程模型。
2. **类型化**：76 个服务端模块 + 54 个前端组件 + 19 个纯函数模块全部为 JavaScript，协议靠约定（typebox schema 已有但未与代码类型打通）；重构为 TypeScript strict 可在编译期消灭协议漂移与空值缺陷。
3. **前端即 Electron 界面**：渲染层以 TS + React 重建，摆脱历史包袱（无全局 store 约定已显疲劳、展示逻辑与组件耦合处需借重构理顺）。

## 决策

1. **后端收进 Electron**：Electron 主进程 Node 侧即应用后端，承载全部领域服务（Agent/地图/Office/知识库/工作流）——不需要独立 server 进程与端口监听；重计算或需隔离的子任务可用 utilityProcess/子进程作为实现细节。前后端经 IPC 通信（contextBridge 暴露、事件推送沿用 event-registry 协议）。
2. **TypeScript 全面重构**：electron/（main 后端 + preload + renderer 前端 + shared 协议）全部 TS strict；现有 JS 前后端按"协议类型先行 → 纯逻辑 → 路由层"顺序渐进迁移（绞杀者模式，不做停机重写）。
3. **monorepo 单仓**：`electron/` 为新架构家（后端 + 前端一体），旧 `client/` 与 `server/` 迁移期共存，按域吞并后退役。
4. **功能等价或更优**：以现有守护体系为验收基线——115 种事件注册表、16 项 CI 回归、`npm run verify` 40 项冒烟；每迁移一个域必须通过等价验收再切换。
5. 继续有效：BRD-001（Pi 内核）、BRD-002（单仓库共享核心）、BRD-003（flag 默认关）、BRD-005（事件治理）、BRD-007 继承的多用户与隔离结论。

## 后果

- 正面：类型安全覆盖全栈；进程模型与产品形态匹配（单机应用无端口暴露）；前端获得重建设计窗口；typebox schema → TS 类型单一事实源。
- 代价：数月级工程；迁移期双前端并存；Pi SDK 无官方类型需自补声明。
- 风险控制：绞杀者式分域迁移 + 每阶段功能等价验收 + 旧架构随时可回退（见方案 §8 里程碑）。

## 实施入口

详细设计（进程模型 / monorepo / TS 迁移策略 / R0-R6 里程碑）见 `docs/solutions/2026-10-19-Electron一体化TypeScript重构方案.md`。
