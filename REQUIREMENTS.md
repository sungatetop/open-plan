---
title: Open Plan 需求文档
summary: 规聚 v0.11.55 基线的核心需求、非功能需求与技术约束，覆盖 R1-R14 能力域
keywords: [规聚, Open Plan, 需求, 功能需求, 版本矩阵]
status: done
date: 2026-10-19
---

# Open Plan - 需求文档

## 项目概述
基于 Pi Agent SDK 和 officecli 的 Web 端 Office 文档查看/编辑 + AI Agent 协作工具，面向交通规划工程师的日常办公场景。

当前基线：**v0.11.55**（变更日志最新已发布条目；其后为 10 批未发布的 Qoder 对标优化，全部由运行开关控制、默认关闭）

> 历史基线 v0.8.34 的需求（R1-R9）全部继续有效；v0.9-v0.11 新增能力以 R10-R14 补充。

## 核心需求

### R1. Office 文档查看与编辑
- 支持 .docx / .xlsx / .pptx / .md / .html / .txt / .csv / .json 文件上传、删除
- **Word（docx-preview 高保真渲染）**：分页/表格/图片/样式完整还原，支持渲染文档内批注（`renderComments`）与修订痕迹（`renderChanges`），可切换开关
- **PPT（pptxviewjs Canvas 渲染）**：支持翻页/跳页/页码导航
- **Excel（x-spreadsheet 可编辑表格）**：多 sheet 查看、直接修改单元格并保存（保存后自动刷新预览）
- **MD/文本**：GFM 渲染（公式 KaTeX/代码高亮/标题锚点）+ 左侧目录浮窗定位
- 新增 `/api/doc/:file/raw` 原始文件流接口，兼容中文文件名（正则路由）

### R2. AI Agent 对话协作
- 通过右侧聊天面板与 Pi Agent 对话
- Agent 可通过 officecli 工具读取、修改 Office 文档
- 支持所有 Pi Agent 能力：skills、插件、工具、图片输入
- 90+ 模型可切换，视觉模型支持图片理解（`[V]` 标记）
- **推理强度三档**：⚡快速 / ⚖标准 / 🧠深度（映射 pi `setThinkingLevel`）

### R3. 对话流完整展示
- **思考过程**：显示 agent 的推理过程（可折叠，默认展开实时可见）
- **工具调用详情**：显示 bash/officecli/read 等工具的输入参数和执行结果（可折叠展开，状态着色 pending/success/error）
- **流式输出**：实时显示 agent 回复（rAF 节流渲染）
- **工作计划展示板（PlanBoard）**：自动解析 agent 回复中的 `- [ ] / - [x]` 任务列表为可勾选任务板，带进度条
- **对话总结条**：本轮对话产物清单，文件名可点击在中间区打开

### R4. 文件上下文自动注入
- 用户打开文件后，发送消息时自动附加 `[当前打开文件: xxx]` 上下文
- Agent 知道用户正在看哪个文件，可以直接定位操作

### R5. 会话历史管理
- 会话列表：按时间倒序，支持重命名和删除
- 文件/历史标签页切换；历史按当前文档过滤（「当前文档」按钮）
- 最近会话栏：对话面板顶部显示最近 5 条会话，点击直接加载
- 兼容 pi v3 格式历史会话（header/session 字段）

### R6. 智能体广场与技能体系
- **智能体广场（AgentMarket）**：4 个面向交通规划工程师的专用助手（公文报告编制 / 地图可视化 / 文本审查 / 数据分析可视化），一键 @ 到对话栏（角色指令 + 依赖技能）
- **技能广场分类**：按交通规划/文档报告/图表可视化/图像生成/媒体内容/Office办公/开发工具/搜索研究分类展示
- **技能集合（工作流）**：预置组合工作流（规划报告全流程 / OD数据分析 / 公交规划专项 / 汇报材料速成），一键启动
- 技能管理弹层：@调用、导入、导出 skills

### R7. 文档批注与修订
- **Word 式批注（docx/md/txt）**：点击批注 → 定位段落 + 整段黄底高亮 + 段落旁编号徽标 + 滚动居中；关键词从批注指令匹配正文，失败回退首段
- **批注面板**：手动刷新按钮，文件修改后自动重新拉取
- **修订痕迹**：docx 通过 docx-preview `renderChanges` 显示（R1 中可切换）

### R8. 个性化与主题
- 统一图标库（线性 SVG，替换全部散落 emoji/字母图标）
- 多主题：暗色（默认）+ 亮色，顶部栏一键切换，localStorage 记忆（`oaw_theme`）
- 用户/Agent 圆形头像（用户蓝色系、agent 青绿色）
- 全局滚动条统一风格（8px、圆角、hover 高亮，CSS 变量适配暗/亮主题）

### R9. 知识库（Obsidian 风格）
- **独立全屏模式**：顶部栏「知识库」按钮切换进入，与三栏办公布局互斥
- **文件树浏览**：配置根目录（kb.json）下的递归 .md 文件树，点击预览，搜索结果列表，目录展开/收起
- **Markdown 预览**：复用 MarkdownBody 渲染文档内容，右侧信息面板显示双向链接（`[[wikilink]]`）、反向链接、标签、标题结构
- **知识图谱（思维图谱）**：基于 antv G6 v5 力导向图，节点=文档/标签/目录，边=内容相似度（自动 bigram 重叠）/双向链接/标签关系/目录归属；可选开关，点击节点联动预览，图例/缩放/拖拽
- **本地索引服务**：解析 frontmatter/title/tags/[[wikilink]]/内联 #tag，建全文子串索引（加权打分：标题×10/标签×6/标题行×4/正文×1）；增量缓存（mtime+size 复用）
- **IMA 云端知识库（可选）**：通过腾讯 ima OpenAPI 连接云端知识库（凭证配置后自动激活），支持知识库列表/搜索/读取原文/笔记正文；未配置或凭证失效时显示引导提示
- **@ 引用分析**：知识库文档「到对话」按钮插入 `@知识库[路径@根目录名]`，agent 通过 `kb_search`/`kb_read` 自定义工具检索并读取全文后分析
- **根目录管理**：前端支持添加/移除知识库根目录（不删除原文件），kb.json 持久化配置

### R10. 地图 GIS 与 Agent 驱动的地图分析
- MapLibre + 矢量瓦片底图，浙江交通主题图层（路网/枢纽/OD/收费站等）
- QGIS 风格图层面板：图层分组/归属/选择器/审批、属性表、测量、等时圈分析
- SHP/GeoJSON/CSV 导入；OD 期望线、网络分配报告可视化
- Agent 通过 map_read / map_edit / map_import / map_analyze / map_save_analysis / map_clear_analysis / map_template 工具读写地图与分析
- 可视化描述符统一驱动前端渲染；地图项目（layers/style/config）落工作区 `maps/`

### R11. 任务运行与产物可信度
- TaskEnvelope + run manifest：每轮执行轨迹（工具聚合/完成语义/每轮用时与 token）
- 产物归属分层（Agent 产物 vs 会话衍生）、产物 diff 与显式回滚
- run-budget / turn-budget 双轨预算；对话流过程折叠、结论内嵌、任务进度卡
- 任务中心（TaskCenter）集中查看运行记录与子代理执行详情

### R12. 模型与供应商管理
- 90+ 模型目录（models-dev-catalog）、供应商凭据管理（provider-catalog 一键导入）
- Pi 配置独立（pi-config/pi-network-proxy 网络适配）、模型诊断接口与真实回归
- 模型区分三态：目录存在 / 已配置凭据 / 当前可调用

### R13. 内置浏览器与联网能力
- builtin-browser：headless 浏览器 CDP 截图流 + 用户坐标接管 + Agent 操作队列 + 临时层提示
- web-search / web-reader 联网检索与正文抽取
- MCP 管理与外部工具接入（mcp-management）

### R14. 领域工作流 Harness 与事件治理
- 声明式领域工作流（workflow-registry/workflows/）+ 技能依赖校验 + WorkflowLauncher 一键启动
- 事件注册表统一治理：115 种 SSE 事件先注册再使用，一致性回归守护
- 子代理编排（subagent-orchestrator）与审批策略（approval-policy）、命令安全策略（command-safety-policy）

## 非功能需求
- 中文界面
- 三栏可拖拽布局（Resizer）
- 全局错误边界：组件渲染异常显示友好错误页，不白屏
- SSE 断线自动重连（3 秒重试）
- 暗色主题（pi 风格等宽字体）

## 技术约束
- Pi Agent SDK（@earendil-works/pi-coding-agent **1.1.0**，进程内嵌入，不暴露到渲染进程）
- officecli（v1.0.143，本地安装）
- Node.js >= 22 + React 18 + Vite 5 + Express 5（服务端口 3002）
- **docx-preview**（Word 高保真渲染，renderComments/renderChanges）
- **pptxviewjs**（PPT Canvas 渲染）
- **@antv/g6 ^5.1.1**（知识图谱力导向图，Canvas 渲染）
- 运行开关（runtimeFlags）门控一切新行为，默认关闭（见 BRD-003）

## 版本完成矩阵

> 完整明细见 `变更日志.md`（136 个版本条目），此处仅列主线。

| 版本段 | 主题 | 状态 |
|--------|------|------|
| v0.1-v0.3 | 初版对话流/工作区/会话历史 → 批注定位/图标库/主题/智能体广场/PlanBoard | 已发布 |
| v0.4-v0.6 | 顶部工具栏 → Office Viewer 集成 → 知识库全屏（Obsidian 风格/G6 图谱/IMA） | 已发布 |
| v0.7-v0.8 | 地图面板与 GIS 编辑 → 品牌重塑「规聚」/ask_user/知识图谱增强/TaskEnvelope 基线（v0.8.34） | 已发布 |
| v0.9 | 会话恢复、地图稳定性、任务中心、模式收敛、事件持久化、成果固定、模型诊断与真实回归 | 已发布 |
| v0.10 | 三栏工作台迁移、Pi 网络适配与配置独立 | 已发布 |
| v0.11.3-v0.11.30 | 事件注册表/归档、进度叙事、内置浏览器 | 已发布 |
| v0.11.31-v0.11.55 | 对话流折叠/结论/token 统计、地图 Agent 化（阶段 0-5）、首字提速 4.6s→0.4s、会话状态修复 | 已发布 |
| 未发布批次 | Qoder 对标优化第一~十批（领域工作流 Harness/流分片/交互归属/设计令牌三层化/组件交互规范/事件 schema 覆盖），全部 opt-in 默认关 | 已完成开发，待转正 |
