---
title: BRD-008 桌面端回归Electron架构
summary: （已被 BRD-009 取代）Electron 壳 + React 复用 + sidecar 服务端；其选型论证与安全结论被 BRD-009 继承，sidecar/JS 复用路线升级为一体化 + TS 重构
keywords: [ADR, Electron, 桌面端, React, sidecar, 已被取代]
status: deprecated
date: 2026-10-19
---

# BRD-008 桌面端回归 Electron 架构

> **状态：已被取代（superseded）**——sidecar 复用与 JS 前端路线升级为 [BRD-009-Electron一体化与TypeScript全面重构](BRD-009-Electron一体化与TypeScript全面重构.md)（2026-10-19）。本文的选型论证（WebContentsView/同栈/资产复用）、安全边界结论（contextIsolation、API Key 不出服务端）继续有效并已并入 BRD-009；sidecar 独立进程形态由 utilityProcess 业务核取代。

- 原状态：已定稿（2026-10-19，取代 BRD-007 的 Tauri 路线）
- 出处：`docs/solutions/2026-10-19-Electron桌面端架构优化方案.md`；历史资产：`docs/plans/2026-08-21-001`、`docs/plans/2026-09-20-001`

## 背景

BRD-007 曾将桌面端收敛为 Tauri 2 壳。修正决策依据：

1. **内置浏览器**：产品的地图/办公场景需要一个真正可用的内置浏览器。Electron `WebContentsView` 原生提供真实页面表面（标签、下载、权限、焦点、文本选择），而 Tauri 的 webview 由系统 WebView2 承担、多视图管理与 CDP 级控制不如 Electron 成熟（2026-09-20 计划的核心论证继续成立）。
2. **同栈优势**：服务端是 Node/Express，Electron 主进程同为 Node，sidecar 直接 `spawn` 现有 `server/index.mjs`，无需交叉运行时捆绑；Tauri（Rust）反而引入异构工具链。
3. **历史资产**：两份既有 Electron 计划（预加载桥、版本化 IPC、Runtime Adapter、权限策略设计）可直接复活，Tauri POC 资产作废成本低。
4. **生态**：electron-builder / electron-updater 的 Windows NSIS + 自动更新链路成熟。

## 决策

1. 桌面端壳采用 **Electron**（Windows 优先），渲染层**复用现有 React 应用**（client/ 构建产物），不复制业务代码。
2. **sidecar 模式**：主进程 spawn Node 运行现有 Express 服务（:3002），渲染窗口加载本机服务地址；服务生命周期由主进程托管（健康检查/崩溃重启/优雅退出）。
3. **平台能力走版本化 IPC**（contextBridge 预加载桥，`window.opDesktop`），网页端继续走 HTTP/SSE；业务协议（事件注册表）两端共享。
4. **内置浏览器升级**：由 CDP 截图流升级为 `WebContentsView` 原生承载（Agent 自动化与人工浏览共用）。
5. API Key、文件权限全部留在主进程与服务端，渲染进程 `contextIsolation: true`、`nodeIntegration: false`。
6. 打包 electron-builder（NSIS），officecli 与 Node 运行时随安装器分发，electron-updater 自动更新。

## 后果

- 正面：内置浏览器体验质变；同栈开发/调试；既有 Electron 设计资产复活；React 复用零迁移。
- 代价：安装体积大于 Tauri（~150MB 级）；需自管 Chromium 安全补丁节奏。
- 与 BRD-002 关系：继承"单主仓库共享核心"原则，分壳方式回到 Electron。
- 与 BRD-007 关系：`FEATURE_CLOUD` 门控、多用户三步走（内网先行）、三层隔离（用户→工作区→运行时）三项结论**继续有效**，仅壳技术从 Tauri 换回 Electron。

## 实施入口

详细设计与里程碑（E1-E5）见 `docs/solutions/2026-10-19-Electron桌面端架构优化方案.md`。
