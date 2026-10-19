---
title: 调研：Claude 幻灯片 / Claude Design / GitHub REA —— 与「规聚 · OpenPlan」的可参考点
summary: 1. Claude 的幻灯片能力不是一个入口，而是四层：① claude.ai 沙箱文件生成（2025-09 起）；② Artifacts 体系内的 Clau…
keywords: [调研, Claude幻灯片与Claude, Design及REA项目, references]
status: done
date: 2026-10-12
---

# 调研：Claude 幻灯片 / Claude Design / GitHub REA —— 与「规聚 · OpenPlan」的可参考点

- 日期：2026-10-12
- 方法：三路并行 web 调研（Claude 幻灯片、Claude Design、GitHub REA）+ 对关键结论人工抽查复核（官方产品页、`anthropics/skills` 原文、GitHub API、许可证原文）
- 置信度标注约定：**【已复核】**=本人直接抓取官方页面/接口核实；**【子代理调研】**=子代理抓取并附来源，未逐条二次复核；**【未验证】**=未找到官方来源

---

## TL;DR

1. **Claude 的幻灯片能力不是一个入口，而是四层**：① claude.ai 沙箱文件生成（2025-09 起）；② Artifacts 体系内的 **Claude Slides**（2026-09-16 上线，2026-10-08 起全计划含 Free 可用）；③ Microsoft 365 插件 **Claude for PowerPoint**（2026-05-07 GA）；④ Agent 侧（Cowork / Claude Code）用 **skills** 复用同一套文档能力——**规聚仓库里已经装着这套技能**（`.claude/skills/pptx`，2026-07-02 从 `anthropics/skills` 装入）。
2. **官方 pptx skill 的技术主线**：新建用 `pptxgenjs`、改模板用 unzip→改 XML→zip；**html2pptx 路线已被官方弃用删除（2026-02-04）**；质量靠"内容 QA → 文件校验（validate.py）→ 渲染出图逐页看"三连。另有成体系的**反「AI 味」设计硬规则**（色板/字号/禁用清单/字体安全清单）。
3. **Claude Design 是 Anthropic Labs 2026-04 发布的正式产品**（现已并入 Claude 任意对话）：设计系统导入（GitHub/设计文件/代码库）→ 输出前自动按你的设计系统校正 → 画布编辑（元素评论/改文案/间距色彩滑杆/拖拽对齐）→ 导出 PPTX/PDF/HTML；连接 Adobe/Canva/Gamma/Miro 等。
4. **规聚的底子比想象中厚**：36 主题/31 版式/27 CSS 动画/20 个 canvas FX 的 HTML PPT 体系（含演讲者模式）、318 套模板、officecli 精准改文档、产物验证/成果验收脚本链。**主要缺口**：HTML deck ↔ 可编辑 PPTX/PDF 的导出管线、deck 级视觉 QA 闭环（溢出/重叠检测）、设计系统（品牌 token）注入、单页选区编辑交互。
5. **REA = [`morluto/rea`](https://github.com/morluto/rea)「Reverse Engineer Anything」**：让 coding agent 无源码逆向软件（原生二进制/Electron/网页/APK）的 MCP server + CLI，**110,828 stars、MIT、TypeScript，2026-10-08 曾登顶 GitHub Trending**。与办公/幻灯片赛道无关；对你更现实的用法是"逆向竞品桌面应用"。`npx rea-agents setup` 即装。注意仿冒仓库与安全边界（原文自述"这不是沙箱"）。
6. **一个需要尽快处理的合规点**：`.claude/skills/pptx|docx|xlsx` 随公共仓库分发，而上游许可证明文限制"向第三方分发/转授权、在服务之外保留副本"。详见 §1.5-F。

---

## 一、Claude 的幻灯片能力（2026-10 现状）

### 1.1 四个入口

| # | 入口 | 是什么 | 关键时间 | 核心能力 | 来源 |
|---|------|--------|----------|----------|------|
| 1 | claude.ai / Desktop / Mobile **文件创建** | 沙箱容器里执行代码生成 `.xlsx/.pptx/.docx/PDF`，可下载或存 Google Drive | 2025-09-09 预览；2025-10-21 付费计划 GA；2026-08 起全计划 | 自然语言触发（"把这份 Word 转成演示"）；**单文件 30MB** 上限；创建文件比聊天更耗额度 | claude.com/resources/articles/create-files；support.claude.com/articles/12111783 |
| 2 | **Claude Slides**（Artifacts 体系） | 与 Claude Docs 同批上线；Cowork 与 chat 合并为同一个 Claude | 2026-09-16 上线；**2026-10-08 出 beta、全计划（含 Free）**；Enterprise 2026-10-15 默认开 | 从已有报告/文件生成 deck、改单页、**直接从 Claude 演示**、导出 **PowerPoint / Google Slides（可编辑）/ PDF**；官方称已累计 4500 万+ docs/decks/designs | claude.com/resources/articles/cowork-is-now-claude；…/dashboards-and-motion；claude.com/product/design【已复核】 |
| 3 | **Claude for PowerPoint**（M365 插件） | Excel/PowerPoint/Word 2026-05-07 GA，Outlook beta | 2026-03-11 增强公告（跨文件共享上下文、**插件内 Skills**）；2026-05-07 GA | **在你的模板里建页、只改选中内容、生成原生图表与图示（非图片）**；继承 slide master、标题样式、编号【已复核】 | claude.com/claude-for-microsoft-365；claude.com/resources/articles/claude-excel-powerpoint-updates |
| 4 | **Agent 侧**：Cowork / Claude Code | Cowork 2026-01 上线、2026-04-09 GA；云端沙箱、子代理、定时任务、Manual/Auto/Skip 三种权限模式；Claude Code 通过 document-skills 插件获得同一套能力 | — | 复用 pptx/docx/xlsx/pdf skills；Cowork 产物可交给 Claude for Excel/PowerPoint 继续编辑 | support.claude.com/articles/13345190；github.com/anthropics/skills |

补充：
- **Claude for Google Workspace（2026-10-06 beta）**：Slides 侧边栏用 **deck 自身的 layouts/themes** 建新页，并**自检并标出重叠、出界、难读的文字**；两档审批 "Ask before edits / Accept all edits"。【子代理调研】
- API 侧：2026-08-20 computer use / **Skills API** / Files API GA——自建 skill 可在服务端沙箱运行并"return finished files"。【子代理调研】

### 1.2 `anthropics/skills` 的 pptx skill 机制（重点）

**【已复核】**（直接抓取当前 main 分支 SKILL.md）：

| 任务 | 官方指定路径 |
|------|--------------|
| **新建** deck | 写 `pptxgenjs` 脚本生成 |
| **编辑/套模板** | unzip → 改 `ppt/slides/slideN.xml` → 从目录内 zip |
| **读取** | `markitdown deck.pptx`（分页文本）+ `scripts/thumbnail.py`（缩略图网格） |

- **html2pptx 已死**：2026-02-04 曾被打包进 skill（PR #330），**同一天 11 分钟后被删除**（PR #331，"Delete deprecated html2pptx.tgz dependency"）；当前 SKILL.md **完全不含 html2pptx 字样**，也不依赖 Playwright。【子代理调研+已复核】
- 依赖：`pptxgenjs`(npm) / `markitdown` / `Pillow` / `defusedxml` / `lxml` / **LibreOffice**（经 `scripts/office/soffice.py` 包装）/ **`pdftoppm`**（Poppler）。
- 已知边界（SKILL.md 明写）：**渐变填充不支持**（用渐变图片）；python-pptx 三不做（不能复制 slide、`text_frame.text=` 会丢格式、读不了模板常用 SVG/EMF）；pptxgenjs 坑清单（hex 不能带 `#`、shadow offset 必须 ≥0、组合图缺轴会被 PowerPoint 判损坏、**绝不可重排 `<p:presentation>` 子元素顺序**）；模板槽位 ≠ 数据条数时整组删。
- **QA 三连（官方标注 Required）**：
  1. 内容 QA：`markitdown output.pptx` 查漏；模板场景 grep 占位符残留（`XXX|lorem|TODO|[insert`）；
  2. 文件 QA：`python scripts/office/validate.py output.pptx [--original 模板.pptx]`（XSD/关系/图表/slide 级检查，模板场景基线化，模板自身错误不算用户头上）；
  3. 视觉 QA：`soffice → PDF → pdftoppm -jpeg -r 150` **逐页出图，每一页都看**；官方建议交给无偏见的 subagent 看图；**第一检查项 = 文字溢出/截断**。
- **设计硬规则**（质量差异的主要来源）：10 套命名色板；**一个主色占 60-70%**；深/浅"三明治"结构；每页必须有视觉元素；字号表（标题 36-44pt / 小节 20-24 / 正文 14-16 / 注释 10-12）；**禁用清单**：标题下划线、任何装饰性色条、默认蓝、米色背景、纯文字页、溢出；**字体安全清单**：safe = Arial/Calibri/Cambria/Times New Roman/Courier New/Bookman Old Style/Century Schoolbook；QA 不可靠 = Georgia/Trebuchet MS/Impact/Arial Black/Garamond/Consolas/Palatino；**绝不用 Aptos**。
- 模板格式：`.potx/.dotx/.xltx` 支持、解压拒绝 symlink/路径穿越（2026-07-17 PR #1447 大更新）。【子代理调研】
- **许可证**：document 4 个技能（docx/pptx/xlsx/pdf）为 **source-available（Proprietary）**，非开源。LICENSE.txt 明文（抓取摘要）：不得 "Distribute, sublicense, or transfer these materials to any third party"，不得 "Extract these materials from the Services or retain copies of these materials outside the Services"；使用受你与 Anthropic 的服务协议约束。【已复核摘要，非法律意见】

### 1.3 关键时间线（精选）

| 日期 | 事件 |
|------|------|
| 2025-09-09 | claude.ai 文件创建预览（pptx/docx/xlsx/pdf） |
| 2025-10-16 | **Agent Skills 发布**（文档能力即由 skills 驱动；渐进披露机制） |
| 2025-10-21 | 文件创建付费计划 GA |
| 2025-12-18 | Agent Skills 成为开放标准 |
| 2026-01 | Claude Cowork 上线（措辞来自官方 2026-07 文章 "Since we launched … in January"） |
| 2026-02-04 | pptx skill：html2pptx 打包 → 同日删除（deprecated） |
| 2026-03-11 | Claude for Excel/Word/PowerPoint 增强：跨文件上下文、**Skills 进插件** |
| 2026-04-09 | Cowork GA（全付费计划）+ 企业治理（RBAC/OTEL/Analytics API） |
| 2026-05-07 | **Excel/PowerPoint/Word GA**，Outlook beta，四应用联动 |
| 2026-07-17 | document skills 大更新（.potx/.dotx/.xltx、zip/unzip 化、安全解压） |
| 2026-08-20 | computer use / **Skills API / Files API** GA |
| **2026-09-16** | **Claude Slides / Claude Docs 上线**；Design 进入任意对话 |
| 2026-10-06 | Claude for Google Workspace beta（Docs/Sheets/**Slides**） |
| **2026-10-08** | **Docs/Slides/Design 出 beta、全计划可用**；Dashboards/Motion beta；累计 4500 万+ 产出 |

### 1.4 与规聚仓库的现状对照

**已经具备的资产**（本次盘点）：

| 资产 | 位置 | 说明 |
|------|------|------|
| Anthropic 同款 pptx/docx/xlsx 技能 | `.claude/skills/pptx`、`docx`、`xlsx` | `openskills` 于 2026-07-02 从 `anthropics/skills` 装入（`.openskills.json` 有出处）；含 `pptxgenjs.md`/`editing.md`/`validate.py`/`thumbnail.py`/全套 XSD |
| SVG→PPTX 转换管线 | `.claude/skills/ultimate-ppt-master-skill` | `svg_to_pptx`（DrawingML 生成）、模板导入、pptx 动画脚本、SVG 质量检查 |
| 旧版 html2pptx 与 PPT 检查脚本 | `.claude/skills/zl-office-academic-skill` | `html2pptx.js`（上游已弃用版本）、`inspect_pptx_overflow.ps1`（溢出检查）、`export_pptx_png.ps1` |
| HTML PPT Studio | `templates/opendesign/html-ppt`（上游 lewislulu/html-ppt-skill） | **36 主题、15 套完整 deck、31 单页版式、27 CSS 动画、20 个 canvas FX、演讲者模式（磁贴卡片 + 双窗 postMessage 同步 + 逐字稿）、Chromium PNG 导出、token 化设计系统 `assets/base.css`** |
| 其他 deck 模板 | `guizang-ppt`、~40 套 `html-ppt-zhangzara-*`、`ib-pitch-book` 等 | 模板库共计 318+，支持 @ 到对话 |
| 客户端预览 | `client/src/components/PptxViewer.jsx`（pptxjs）、`DocViewer.jsx`、`TemplateLibrary.jsx` | pptx 保真渲染、批注点选定位 |
| 服务端验收链路 | `server/office.mjs`（officecli）、`产物验证.mjs`、`成果验收.mjs`、`文件差异.mjs`、`runs.mjs`、`task.mjs` | 已有 run/task 产物追踪与"验收"概念 |

**差距 A：HTML deck ↔ PPTX/PDF 没有打通（最高价值缺口）**

现状：模板与生成物是 HTML deck（可演示、有动画、有演讲者模式），但对外交付通常要 `.pptx`；两条线之间没有导出管线。而官方已经用脚投票：**html2pptx 路线弃用**（保真与可编辑性难两全），主线是 pptxgenjs 原生生成 + OOXML 直改 + 渲染 QA。

建议明确两种导出，产品上让用户选：
1. **"可编辑"路线（推荐主线）**：内容/大纲 → `pptxgenjs` 原生生成（规聚已装该技能）→ validate + 逐页出图 QA。产出原生可编辑 PPT、原生图表；模板支持走 `.potx`/用户模板。适合"要交回给同事继续改"的正式汇报。
2. **"高保真"路线**：HTML deck → 逐页渲染（已有 Chromium PNG 导出脚本；或 SVG → `svg_to_pptx`）→ 包装为 PPT/PDF。视觉 100% 还原但基本不可编辑。适合分发/存档/评审定格版。
   - 不要在旧 `html2pptx.js` 上继续投入（上游已删，是死路）。

**差距 B：deck 级视觉 QA 未闭环**

office 文档侧已有"产物验证/成果验收"，但 deck 没有对齐官方三连。建议：
- 新增 deck 验收脚本（如 `scripts/deck验收.mjs`）：渲染 → 逐页出图 → **交给独立子代理看图**（官方经验：作者看图会"看到期望的而不是实际渲染的"）→ 输出缺陷清单（文字溢出/截断优先、元素重叠、页脚冲突、间距不均、低对比、模板装饰错位）；
- 复用/移植 `zl-office-academic-skill` 里的溢出检查思路；把"decks 交付前必须逐页看图"写成平台规则注入技能。

**差距 C：设计品味规则没有硬约束**

规聚有 36 主题（选择问题已解决），但缺"怎么用不出丑"的硬规则。建议把 §1.2 的禁用清单/字号表/60-70% 主色/字体安全清单落成 html-ppt 与 pptx 技能里的 authoring checklist；必要时引入 theme-factory 式「展示主题 → 用户确认 → 应用 → 对比度检查」的确认闭环。【子代理调研：theme-factory 技能即此机制】

**差距 D：模板/母版不是一等公民**

对齐 Claude for PowerPoint 的"在你的模板里建页"，补齐：用户上传 `.potx/.pptx` 模板 → `thumbnail.py` 分析 → 编辑路径（unpack→改 XML→clean→pack→`validate --original`）；officecli 侧同理支持"在用户模板上精准改"。规聚"模板库 @ 对话"已有入口，缺"用户自带模板"这一条。

**差距 E：选区感受的编辑交互**

官方三处都在做"改小的、改局部的"：Claude for PowerPoint 只改选中内容；Google Slides 两档审批；Cowork 三档权限。规聚的 `ask_user`、DocViewer 批注点选定位已是同思路，建议扩展到 deck 预览：点某页/某元素 → "改这一页/这块" → agent 走精准编辑 → 写操作前出确认卡。

**差距 F：技能同步与许可证（合规风险，建议优先处理）**

- **版本落后**：装入时点为 2026-07-02，上游 2026-07 中旬有较大更新（模板格式支持、解压安全）。建议重装/同步。
- **分发条款**：上游 document skills 为 source-available，LICENSE.txt 限制"分发/转授权给第三方"与"在服务之外保留副本"；而规聚最近一次提交明确"**技能随仓库分发**"，仓库为公开 GitHub 仓库（oscarkincanland/open-plan）。建议尽快评估三选一：① 从仓库移除这几套技能、改为安装引导（`npx skills add anthropics/skills` / Claude Code 插件市场）；② 取得 Anthropic 授权；③ 若维持现状，至少确认 LICENSE.txt 完整随附并可追溯出处（zhangzara 系列模板各自带 LICENSE 已是好范例）。另：`zl-office-academic-skill` 内嵌旧版 html2pptx / ooxml 脚本，建议一并核对血缘与许可。（本文非法律意见。）

---

## 二、Claude Design：是什么、有哪些功能

### 2.1 判定结论

**Claude Design 是 Anthropic Labs 发布的正式产品**（不是某个能力的别称）：公告《Introducing Claude Design by Anthropic Labs》，作为 research preview 面向 Pro/Max/Team/Enterprise，由 Opus 4.7 驱动；其后并入 Claude 主产品，**现在任意对话、Claude Code、Artifacts 标签页都能用**；独立站 `claude.ai/design` 将于 **2026-12-14 关闭**。【公告 URL：anthropic.com/news/claude-design-anthropic-labs，日期 2026-04-17 来自搜索页标注（未验证）；产品页与帮助中心已复核】

### 2.2 功能清单【产品页已复核】

| 维度 | 内容 |
|------|------|
| **输入** | 提示词；上传图片/DOCX/PPTX/XLSX；代码库；网页捕获；从已有报告/文件起步 |
| **设计系统** | 从 **GitHub、设计文件、本地代码库**导入（支持多套）；**输出前先按你的设计系统自查并修正**；管理员可"锁定团队到单一已批准设计系统"；Settings > Design Systems 管理 |
| **编辑** | 元素评论、直接改文案、**Claude 生成的间距/色彩滑杆**、拖拽/缩放/对齐；画布编辑 |
| **导出** | **PPTX / PDF / HTML**；handoff bundle 交给 Claude Code |
| **连接器** | Adobe、Canva、Gamma、Lovable、Miro、Replit、Vercel、Wix（产品页列举；Adobe/Canva/Figma/Miro 已在 marketplace 核实） |
| **计划** | Claude Design/Slides/Docs 计入所有计划（含 Free）；Dashboards beta（付费）；Motion beta（Team/Enterprise，输出 MP4） |
| **安全/隔离** | 预览跑在**独立内容域的 sandboxed iframe**，短时签名令牌，按分享权限实时复核；Artifacts 单件 20MB、仅文本；默认私有，Team/Enterprise 外链有开关；组织级 artifact 模板、CMEK |

### 2.3 生态相关能力（设计线）

- **Claude Code**：`/design`、`/design-sync`（设计系统同步）；Figma Dev Mode **MCP** 官方支持 Claude Code/Desktop（可读写 Figma Design/FigJam/**Slides** 原生内容）。
- **技能**（`anthropics/skills`，19 个目录已核实）：`canvas-design`（设计哲学→PNG/PDF 美术）、`frontend-design`（两遍法：先 token+ASCII wireframe 再写代码；反 AI 默认审美黑名单）、`web-artifacts-builder`（React+TS+Vite+Tailwind+shadcn → 单文件 bundle.html）、`theme-factory`（10 套主题 + 展示确认流）、`brand-guidelines`（VI 色/字规范）、`webapp-testing`（Playwright 渲染验证）。
- 产物判定标准（官方）：**显著且自包含（通常 >15 行）、可被编辑/复用、脱离对话可独立存在**才算 artifact。

### 2.4 对规聚的借鉴（映射到现有模块）

1. **设计系统作为一等输入**：规聚已有 token 化 `base.css`（html-ppt）与 36 主题 → 升级为"品牌包"（色/字/间距/组件 token + 从用户已有成果反推 + 生成前载入 + 输出前自校验），对齐"没有设计系统时输出 functional but generic"的官方结论。
2. **两遍式设计生成**：先出 token+版式方案并自检"是否像模板默认"，再出稿——规聚的 `axi-front-design` 技能与官方 `frontend-design` 同构，可把黑名单规则（紫渐变/奶油底/均匀圆角卡等）直接变成校验项。
3. **画布编辑三通道**（对话改结构 / 评论改元素 / 滑杆拖拽改视觉）→ 未来 deck 编辑器的交互基线；比"重新出整稿"体验好得多，且规聚已有 iframe 预览与批注定位基础。
4. **分享与隔离模型**：默认私有、组织级模板、sandboxed iframe + 签名 token 渲染 agent 生成的 HTML——直接对接《多用户隔离与桌面端路线梳理》和《上线部署项目实施计划》两篇既有文档。
5. **产物生命周期**：把 deck/design 定义为一级产物类型（规聚已有 `client/src/产物类型.js` 与产物归属链路），并参考"Artifacts 计入所有计划额度"做配额设计。

---

## 三、GitHub 上的 REA 项目

### 3.1 结论与核实数据

**REA = [`morluto/rea`](https://github.com/morluto/rea)（"Reverse Engineer Anything"，中文 README 译"逆向一切"）**。【数据经 GitHub API 已复核，抓取于 2026-10-12】

| 项 | 值 |
|----|-----|
| 全名 / 描述 | `morluto/rea` — "Reverse engineer anything with agents, from app behavior down to native binaries." |
| 星数 / Fork | **110,828** / 24,650（当天仍在快速增长） |
| 语言 / 许可 | TypeScript / **MIT** |
| 创建 / 最近推送 | 2026-04-14 / 2026-10-12（非常活跃） |
| 官网 | https://rea.tools （中文版 https://rea.tools/zh-CN/ ） |
| Topics | mcp、model-context-protocol、reverse-engineering、claude-code、ghidra、decompiler、ctf、ai-agents… |
| npm | 包名 `rea-agents`（6.x；Node ^22.19 / ^24.11 / >=26） |
| 热度事件 | 2026-10-08 登顶 GitHub Trending #1；README 19 语言、含中文；中文社区已有专门调研仓（[ringozzt/rea-research](https://github.com/ringozzt/rea-research)） |

### 3.2 它是干什么的

**MCP server + CLI**，让 AI coding agent 在**没有源码**的情况下检查软件（原生二进制 / Electron / 网页 / APK / .NET / 固件 / WASM / EVM 字节码等），解释功能如何实现，并带着证据在你的项目里重建该功能。

- 核心机制：**编排层 + 统一证据契约**——每个工具结果返回 `result + evidence_id + limitations`，可引用、导出、比较（`compare_functions`）。
- **它不是反编译器**：原生二进制分析 100% 调用你自备的 Hopper / Ghidra / IDA；静态 JS / .NET 分析不需要这些引擎。
- 分析在本地进行（二进制不上传），但工具结果会经 agent 流向模型供应商。

### 3.3 怎么用（命令均来自官方 README/安装文档）

```bash
# 1) 一键注册进你的 AI 智能体（先展示变更计划、需你批准；自动备份已有配置）
npx rea-agents setup            # 明确用最新版：npx rea-agents@latest setup

# 2) 重启智能体后自然语言提任务，例如：
#    「弄清 Notes 应用的搜索功能如何工作，展示证据，并为我的项目实现类似功能。」

# 3) 终端 CLI 直接用（静态 JS 分析不需要原生引擎）
npx -y rea-agents@latest analyze-javascript-application /absolute/path/to/app --json

# 4) 常用则全局安装，得到 rea 命令
npm install --global rea-agents
rea --help
rea doctor --client pi --json   # 诊断某客户端的注册与引擎就绪情况

# 5) 只装技能、不注册 MCP
npx skills add morluto/rea --skill reverse-engineer-anything
```

- `setup` 支持 17 种客户端（Claude Code、Claude Desktop、Codex、Cursor、Gemini CLI、Windsurf、OpenCode、VS Code…）；单客户端可用 `rea setup --client X --dry-run --json` 先看计划再 `--yes` 批准。
- 官方 showcase 有一个 **Notion（Electron 剪贴板桥）**案例：追踪 preload → IPC → 主进程链路——正对应"逆向竞品桌面应用"的用法。

### 3.4 注意事项

1. **仿冒仓库**：搜索"REA"会碰到 `rea-tools/rea`、`ReverseEngineerAnything/REA` 等"免费下载"钓鱼仓（几十星、创建于 2026-10-10 后）。只从 `morluto/rea`、`rea.tools`、npm `rea-agents` 获取；官方 README 声明未发行也未背书任何代币。
2. **安全边界**：SECURITY.md 原文写明 "This is not a sandbox"；分析不可信目标建议隔离 VM；对专有二进制分析前注意结果会发给模型供应商。
3. **热度 ≠ 采用率**：第三方中文调研指出当时 npm 周下载仅约 1.3k，星增长含大量围观成分（数据随时间变化，仅作参考）。

### 3.5 备选含义（如果看到的不是上面那个）

| 候选 | 特征 | 何时是它 |
|------|------|----------|
| **Resource-Event-Agent**（经济本体）：[h-REA/hREA](https://github.com/h-REA/hREA)（~164★，Rust+Holochain）、[valueflows/valueflows](https://github.com/valueflows/valueflows) | 供应链/记账/本体/去中心化经济 | 看到这些词才相关 |
| [facebookresearch/ReAgent](https://github.com/facebookresearch/ReAgent)（~3.7k★） | 强化学习/上下文赌博机平台（全名 ReAgent） | 看到 RL/PyTorch 才相关 |

### 3.6 与规聚的关系

REA 与"生成幻灯片/设计"无关，它解决的是另一个问题：**在看不到源码的情况下理解一个软件怎么实现，然后照着重建**。对规聚的实际用途：
- 逆向研究现成的 Electron 办公/设计类应用（如官方 showcase 的 Notion 案例），为自研 deck 编辑器、导出管线、画布交互收集实现路径；
- 作为"竞品功能拆解 → 自研落地"的开发期工具，而不是产品内组件。

---

## 四、主要来源

**Claude 幻灯片**
- https://claude.com/resources/articles/create-files ；https://support.claude.com/en/articles/12111783-create-and-edit-files-with-claude
- https://claude.com/resources/articles/cowork-is-now-claude ；https://claude.com/resources/articles/dashboards-and-motion ；https://claude.com/features/artifacts
- https://claude.com/claude-for-microsoft-365 ；https://support.claude.com/en/articles/13521390-use-claude-in-powerpoint ；https://claude.com/resources/articles/claude-excel-powerpoint-updates ；…/collaborate-with-claude-across-excel-powerpoint-word-and-outlook
- https://claude.com/resources/articles/claude-now-works-in-google-docs-sheets-and-slides ；https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork
- https://github.com/anthropics/skills （pptx SKILL.md / LICENSE.txt / PR #330、#331、#1447）

**Claude Design**
- https://www.anthropic.com/news/claude-design-anthropic-labs ；https://claude.com/product/design 【已复核】
- https://support.claude.com/en/articles/14604416-get-started-with-claude-design ；…/17440474-migrate-from-standalone-claude-design-to-claude ；…/14604406-claude-design-admin-guide-for-team-and-enterprise-plans
- https://help.figma.com/hc/en-us/articles/32132100833559 （Figma Dev Mode MCP）；https://code.claude.com/docs/en/best-practices

**REA**
- https://github.com/morluto/rea ；https://raw.githubusercontent.com/morluto/rea/main/README_zh.md ；https://api.github.com/repos/morluto/rea 【已复核】
- https://rea.tools/zh-CN/ ；https://registry.npmjs.org/rea-agents ；https://github.com/ringozzt/rea-research

**规聚仓库（本文引用）**
- `.claude/skills/pptx/.openskills.json`、`SKILL.md`；`.claude/skills/zl-office-academic-skill/**`；`.claude/skills/ultimate-ppt-master-skill/**`
- `templates/opendesign/html-ppt/SKILL.md`；`templates/opendesign/guizang-ppt/**`
- `server/产物验证.mjs`、`server/成果验收.mjs`、`server/office.mjs`；`client/src/components/PptxViewer.jsx`

---

## 五、未验证项与置信度说明

1. Claude Design 公告日期 2026-04-17 来自搜索页标注（公告页正文无日期）；独立站首发日期、从"Pro 起"扩到"全计划"的确切日期未见官方公告。
2. Cowork "2026-01 上线"来自官方文章的措辞推断；Claude for Excel/PowerPoint 首次 beta 日期不可考（最早明文是 2026-03-11）。
3. pptx skill 的 PR 细节（#330/#331/#1447）为子代理调研；其中"当前 SKILL.md 无 html2pptx、QA 三连、设计规则、依赖清单"已由本人抽查复核。
4. Gamma/Lovable/Replit/Vercel/Wix 连接器仅产品页列举，marketplace 未确认。
5. 星数/npm 版本为 2026-10-12 抓取快照。
6. 许可证部分为对页面文字模型的转述摘要，**不构成法律意见**；对外分发前请以 LICENSE.txt 原文与自己的法务判断为准。
