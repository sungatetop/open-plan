---
title: "Harness 优化与 DSH 适配：正式落地执行方案（含评审记录）"
summary: "第 1-2 周 P0 批次：运行开关.mjs → U1 → U8 → U2 → U3（每项：spike → 实现 → 验收脚本 → 合入）"
keywords: [Harness优化与DSH适配正式落地执行方案, solutions]
status: done
date: 2026-10-15
---

# Harness 优化与 DSH 适配：正式落地执行方案（含评审记录）

- 日期：2026-10-15
- 性质：**第三阶段产出**——前两阶段方案的正式评审记录、迭代修正追踪、以及最终确认的落地执行方案
- 评审对象：
  - [第一阶段：基于 PI SDK 原生能力的优化方案](./2026-10-15-PI-SDK原生能力优化方案.md)（下称《优化方案》）
  - [第二阶段：DSH 内核最小侵入适配方案与改动清单](./2026-10-15-DSH内核最小侵入适配方案.md)（下称《适配方案》）
- 评审方式：独立技术评审（未参与方案编写的审查角色，对文档关键声明逐项做代码/类型定义实证核对），评审依据含 `node_modules/@earendil-works/pi-coding-agent/dist/*.d.ts` 与 `server/` 实际代码

---

## 1. 评审记录（全维度）

### 1.1 评审意见汇总表

| 编号 | 维度 | 严重度 | 意见 | 处置 |
|---|---|---|---|---|
| R1 | DSH 适配兼容性 | **阻断** | C6 写错函数位置与分派时序：`executeAgentRun` 实际定义于 `index.mjs:3875`（非导出），非 `agent.mjs`；且 admission→beginRun→planTaskCapabilities→officecli 预检→capability_plan 全部发生在 executeAgentRun 调用之前。"分派在所有现有逻辑之前 return"原描述不成立；dshExecuteRun 复用 beginRun 会双建档 | ✅ 已修正：分派闸门上移至 POST handler 内 `beginRun` 之前；dshExecuteRun 只做 recordRunEvent/finishRun，不重复 beginRun |
| R2 | DSH 适配兼容性 | 重要 | DSH 路径 `capabilityPlan` 语义未定义，会携带 Pi 专有语义误导前端/审计 | ✅ 已修正：C2 明确 DSH 简化契约（provider="dsh"、routing.officecli="none"），纳入 A3 断言 |
| R3 | DSH 适配兼容性 | 重要 | kernelId=dsh 携带 task/workflow 时任务中心/editorial_pipeline 静默失效 | ✅ 已修正：C4/C6 增加该组合返回 400，与 flag off 同口径，纳入 A2 断言 |
| R4 | DSH 适配兼容性 | 重要 | DSH 自身审批/权限策略未配置，headless 自动批准会绕过工作台审批写同一工作区 | ✅ 已修正：C2 明确 DSH 强制确认模式 + 工作区目录锁定 + 审批事件桥接（转现有 tool_approval_request），纳入 A3 断言 |
| R5 | 技术合理性 | 重要 | `wrapRegisteredTools` 签名为 `(RegisteredTool[], ExtensionRunner)`，仅作用于扩展注册工具，不能包装 `customTools` 注入路径 | ✅ 已修正：U2 删去包装法，统一走 `ToolCallEvent`/`CustomToolCallEvent`（单工具拒绝语义 `ToolCallEventResult{block,reason,terminate}` 已实证） |
| R6 | 技术合理性 | 重要 | U5 全量 sidecar 可静态判 No-Go：`RpcCommand` 全集（rpc-types.d.ts L14-125）不含 customTools 注册与 setActiveToolsByName | ✅ 已修正：U5 降级为"bash 侧车执行 + 侧车基建"缩水路径，全量 sidecar 转 spike 项；侧车基建仍复用于 DSH 适配 |
| R7 | 性能收益 | 重要 | 多数收益声明无可测指标 | ✅ 已修正：统一验收基线为每个 U 项定义可测指标（U1 偏差分布 / U2 hard 模式 Run 续跑通过率 / U3 投影一致性断言 / U6 压缩失败可见率 / U5 首包延迟预算） |
| R8 | 风险可控性 | 建议 | 三条 feature flag 的实现位置与下发链路未指明；U3/U4/U10 spike 失败降级出口不显式 | ✅ 已修正：统一由新增 `server/运行开关.mjs` 读取并经 `/api/status` 下发；spike 失败 = 关闭该项并记录结论，不带病合入 |
| R9 | 技术合理性 | 建议 | 两处 API 名称有出入：`getPendingMessages()` 实为 `pendingMessageCount` + 只读 getter；`ProjectTrustDecision` 为三态 boolean\|null，不支持多级信任映射 | ✅ 已修正：U7/U9 按真实 API 重述，U9 收敛为"首次打开信任位"单一场景 |
| R10 | 技术合理性 | 建议 | SDK `EventBus` 为 8 行同步 pub/sub，"可插拔总线"价值有限；事件转译层行数估计偏小（实际 ≥400 行） | ✅ 已修正：U8 将 EventBus 降为可选组成，行数修正，改造按事件类型分批灰度 |

### 1.2 评审实证记录（关键抽查项）

| 声明 | 实证结果 | 结论 |
|---|---|---|
| `navigateTree(targetId,{summarize,label})` | agent-session.d.ts L850，注释与引文一致 | 属实 |
| `getContextUsage()` | agent-session.d.ts L874 | 属实 |
| `shouldCompact/calculateContextTokens` 等 | compaction.d.ts 行号逐一命中 | 属实 |
| `wrapRegisteredTools` 可包装 customTools | 签名 `(RegisteredTool[], ExtensionRunner)` | **有出入 → 已修正（R5）** |
| `ToolCallEvent` 单工具拦截 | types.d.ts L1065-1073 `{block,reason,terminate}` | 属实 |
| `BashSpawnHook`/`executeBash operations` | tools/index.d.ts、agent-session.d.ts L810 | 属实 |
| RPC 命令覆盖 customTools | rpc-types.d.ts L14-125 无此类命令 | **不支持 → 已修正（R6）** |
| noExtensions 仅子会话禁用（扩展方案可行前提） | agent.mjs:2527 子会话禁用 / 983 主会话未禁用 | 属实 |
| `executeAgentRun` 位于 agent.mjs | 实际在 index.mjs:3875 | **不属实 → 已修正（R1）** |
| C4 位置 index.mjs L3987 | 命中 | 属实 |
| runs.mjs beginRun/recordRunEvent/finishRun | L551/L680/L906 | 属实 |

### 1.3 评审总体结论

- **第一阶段方案**：11 项 SDK 能力声明抽查 9 项属实、2 项有出入（均已修正）；"基于 Pi SDK 原生能力、零新增依赖"的约束经核验成立；可行性与成本估算合理。
- **第二阶段方案**：改动面确实克制（事件层/数据层零改动成立），但"最小"边界原画在事件层而漏了**请求预处理层**（R1-R4 共同指向）——修正后 V1 边界明确为"Chat 基本链路 + 请求预处理层显式分流 + DSH 侧审批强制确认"。
- **放行意见**：修正后的两份方案**通过评审，进入落地**。条件：Spike 闸门（适配方案 §4.1 五项）不通过则触发降级路径，不硬推。

---

## 2. 迭代修正追踪

| 文档 | 修正处 | 对应意见 |
|---|---|---|
| 《优化方案》 | §0 结论摘要第 3 点（U5 降级表述） | R6 |
| 《优化方案》 | U2 实现步骤（删包装法、统一 ToolCallEvent、扩展加载失败告警） | R5 + 评审补充 |
| 《优化方案》 | U4 实现步骤（PowerShellSpawnHook 同步覆盖） | 评审补充 |
| 《优化方案》 | U5 整节重写（缩水路径 + 崩溃恢复衔接） | R6 + 评审补充 |
| 《优化方案》 | U7/U9 API 名称与语义修正 | R9 |
| 《优化方案》 | U8 EventBus 降级为可选、行数修正、分批灰度 | R10 |
| 《优化方案》 | §5 统一风险（flag 管道、spike 失败出口）与验收基线（可测指标） | R7/R8 |
| 《适配方案》 | §1 架构图（分派闸门位置与时序） | R1 |
| 《适配方案》 | C2（简化契约 + 审批配置，规模 260→300 行） | R2/R4 |
| 《适配方案》 | C4/C6 重写（index.mjs 分派、不重复 beginRun、task/workflow 400） | R1/R3 |
| 《适配方案》 | §4.2 验收断言（A2/A3 扩充） | R2/R3/R4 |
| 《适配方案》 | 改动总量更新（C6 不再触碰 agent.mjs） | R1 |

---

## 3. 最终确认的落地执行方案

### 3.1 执行总纲

```
第 1-2 周   P0 批次：运行开关.mjs → U1 → U8 → U2 → U3（每项：spike → 实现 → 验收脚本 → 合入）
第 3-4 周   P1 批次：U5（bash 侧车）→ U4 → U6
第 5 周     P2 批次：U7 → U11 → U9 → U10（spike 决定去留）
第 6 周     DSH Spike 闸门：适配方案 §4.1 五项验证 → Go/No-Go
第 7-8 周   DSH 适配实施（仅 Go）：C1/C2/C3 新文件 → C4-C8 受控修改 → C9 验收
第 9 周     终验：A1-A6 全量验收 + 全部 test:* 回归 + 评测报告
```

### 3.2 里程碑与闸门

| 里程碑 | 时点 | 闸门条件 | 未通过动作 |
|---|---|---|---|
| M1 P0 批次完成 | 第 2 周末 | U1/U2/U3/U8 验收脚本全绿 + 默认配置行为零变化 | 单项回退，不带病合入 |
| M2 P1 批次完成 | 第 4 周末 | U5/U4/U6 验收全绿（U5 含延迟预算实测） | 同上 |
| M3 P2 批次完成 | 第 5 周末 | U7/U9/U11 合入；U10 spike 结论明确（做或不做） | 同上 |
| M4 DSH Go/No-Go | 第 6 周末 | Spike 5/5 通过 | No-Go 则冻结 DSH 适配，保留 C1/C3/C8 骨架，转入季度重评 |
| M5 DSH 适配完成 | 第 8 周末 | A1-A6 全绿（A1 行为零变化为最高优先） | A1 失败即整体回滚（单提交 revert） |
| M6 终验 | 第 9 周末 | 近 50 个 test:* 全绿 + 双内核评测报告出具 | 按报告决定 DSH 默认关闭或继续实验 |

### 3.3 交付物清单

| 类别 | 交付物 |
|---|---|
| 方案文档 | 《优化方案》《适配方案》本文档（评审记录 + 修正追踪 + 执行总纲） |
| 后端新模块 | `server/运行开关.mjs`、`server/事件规范化.mjs`、`server/Pi把关扩展.mjs`、`server/内核侧车.mjs`、`server/内核注册表.mjs`、`server/DshKernelAdapter.mjs` |
| 后端修改 | `Pi运行时管理.mjs`（U1/U3 透传）、`agent.mjs`（U1/U6/U7 接线、U8 转译分批）、`index.mjs`（C4/C5/C6 分派闸门）、`事件注册表.mjs`（context_usage/tool_gate_denied/compaction_* 登记） |
| 前端修改 | `ChatPanel.jsx`（上下文精确值/门禁拒绝态/压缩节点/待投递徽标）、`SettingsPanel.jsx`（内核徽标与选择器）、`运行轨迹.js`（分支链/压缩节点）、`api.js`（kernelId 透传） |
| 测试 | `优化项U1-U11验收.mjs`（按实际合入项）、`scripts/DSH适配验收.mjs`、转译层快照测试、`package.json` 零新增依赖 diff 审查 |
| Spike | `scripts/spike-tool-gate.mjs`（U2）、`scripts/spike-tree-nav.mjs`（U3）、`scripts/spike-dsh-*.mjs`（五项闸门） |
| 报告 | M6 终验报告（含 U1 偏差分布、U5 延迟实测、双内核对比数据） |

### 3.4 不变式承诺（评审确认后冻结）

1. 默认配置（全部 flag off）下行为与当前基线**完全一致**；
2. Pi 主执行路径（planTaskCapabilities → 预检 → capability_plan → executeAgentRun）在 DSH 分派之外**零改动**；
3. 事件注册表/SSE 协议/前端投影契约**不破坏**（新增类型仅按既有登记流程追加）；
4. 全程**零新增 npm 依赖**；
5. 每个改动独立提交、单提交可 revert；
6. DSH 相关一切能力均在 `OAW_DSH_KERNEL` 开关之后，关闭即等于不存在。

### 3.5 遗留事项与后续观察点

| 事项 | 处置 |
|---|---|
| 全量 Pi sidecar（会话整体进程隔离） | 依赖 SDK RPC 增加 customTools 注册命令，列入 SDK 升级观察项 |
| DSH 业务工具桥接（MCP server 模式） | V2 评估项：需将 Office/KB/地图工具包装为 MCP server，改动面另评 |
| DSH RC 破坏性变更 | 每次升级重跑五项 Spike；版本锁定策略不变 |
| OS 级沙箱 | V1 交付应用级进程隔离（bash 侧车）；OS 级依赖 DSH `ctx.sandbox` Windows 可用性（Spike S4 覆盖），如实标注边界 |
