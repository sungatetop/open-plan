/**
 * 智能体管理（agent-management.ts，S3-13 转录）。
 *
 * 逐行等价迁移自 server/agent-management.mjs；消费面：旧 index.mjs L30
 * （listAgents/createAgent/updateAgent/deleteAgent）。PROJECT_DIR 直绑 workspace-paths
 * 锚点（S3-12 先例），OAW_AGENTS_FILE env 优先锚定保持模块加载期求值语义。
 * 注意：当前仅对拍覆盖、未装配运行时；旧 JS 实现保留至域退役。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PROJECT_DIR } from "./workspace-paths";
import { atomicWriteJson, ensureDirectory } from "./persistence-utils";

const AGENTS_FILE = process.env.OAW_AGENTS_FILE || path.join(PROJECT_DIR, ".oaw", "agents.json");

export const BUILTIN_AGENTS = Object.freeze([
  {
    id: "agent-gongwen",
    name: "公文报告编制助手",
    icon: "doc",
    description: "按公文/报告版面规范撰写政府公文、汇报材料、规划报告，输出规范 .docx",
    skills: ["gongwen-banmian", "traffic-report-briefing", "traffic-report-comprehensive", "md-to-docx"],
    inputs: ["主题/事由", "已有素材或参考文件", "篇幅与格式要求"],
    outputs: ["规范 .docx 公文或报告"],
    prompt: "你现在是公文报告编制助手：请按公文版面规范撰写/修订公文或报告，输出规范 .docx，注意标题层级、字体字号、段落格式与附件清单。",
    color: "#b7791f",
    builtin: true,
  },
  {
    id: "agent-map",
    name: "地图可视化助手",
    icon: "locate",
    description: "OD 期望线、站点分布、流向图、等时圈等交通地图可视化，单文件 HTML 开箱即用",
    skills: ["traffic-map-template", "od-workflow", "transport-chart-geospatial", "tanstack-charts-overview"],
    inputs: ["OD/站点/客流数据（表格或 GeoJSON）", "分析口径与范围"],
    outputs: ["单文件 HTML 交通专题地图"],
    prompt: "你现在是地图可视化助手：基于数据生成交通专题地图（OD期望线/站点/热力/等时圈等），输出单文件 HTML，使用 MapTiler 卫星底图，注意坐标系为中国范围。",
    color: "#2a8c82",
    builtin: true,
  },
  {
    id: "agent-review",
    name: "文本审查助手",
    icon: "search",
    description: "公文/报告/论文的错别字、语病、格式、术语一致性、逻辑结构审查",
    skills: ["huashu-proofreading", "humanizer-zh", "every-style-editor", "text-summarizer"],
    inputs: ["待审文本或文档", "审查重点（可选）"],
    outputs: ["审查意见清单（位置 + 建议）"],
    prompt: "你现在是文本审查助手：逐段审查文本的错别字/语病/格式/术语一致性/逻辑结构，输出审查意见清单（问题位置+修改建议），不直接改稿。",
    color: "#5c7a1f",
    builtin: true,
  },
  {
    id: "agent-data",
    name: "数据分析及可视化助手",
    icon: "xls",
    description: "Excel/OD/客流数据统计分析、图表生成（ECharts）、报告输出",
    skills: ["huashu-data-pro", "od-workflow", "traffic-charts-template", "echarts-pie-charts"],
    inputs: ["数据表格（xlsx/csv）", "分析目标"],
    outputs: ["统计结论 + ECharts 图表 HTML"],
    prompt: "你现在是数据分析及可视化助手：对表格/OD/客流数据做统计分析，验证数据完整性，生成 ECharts 图表与结论性分析，输出图表 HTML 与说明。",
    color: "#2a8c82",
    builtin: true,
  },
]);

// 自定义智能体为用户落盘 JSON 的自由形态（对拍含缺字段/假内置 id 等防御形态），保持 any 面
function readCustomAgents(): any[] {
  try {
    const value = JSON.parse(fs.readFileSync(AGENTS_FILE, "utf8"));
    return Array.isArray(value) ? value.filter((item: any) => item && item.id && !BUILTIN_AGENTS.some((builtin) => builtin.id === item.id)) : [];
  } catch {
    return [];
  }
}

function saveCustomAgents(agents: any[]) {
  ensureDirectory(path.dirname(AGENTS_FILE));
  atomicWriteJson(AGENTS_FILE, agents);
}

function cleanAgent(input: any = {}, previous: any = {}): { ok: boolean; error?: string; agent?: any } {
  const name = String(input.name ?? previous.name ?? "").trim();
  const description = String(input.description ?? previous.description ?? "").trim();
  const prompt = String(input.prompt ?? previous.prompt ?? "").trim();
  const skills = [...new Set((Array.isArray(input.skills) ? input.skills : previous.skills || [])
    .map((item: any) => String(typeof item === "object" ? item?.name : item || "").trim()).filter(Boolean))];
  if (!name) return { ok: false, error: "智能体名称不能为空" };
  if (!prompt) return { ok: false, error: "智能体指令不能为空" };
  if (name.length > 80 || description.length > 300 || prompt.length > 8000 || skills.length > 30) return { ok: false, error: "智能体配置超出长度限制" };
  return {
    ok: true,
    agent: {
      id: String(input.id ?? previous.id ?? `agent-${crypto.randomUUID()}`),
      name,
      icon: String(input.icon ?? previous.icon ?? "robot"),
      description,
      skills,
      prompt,
      color: String(input.color ?? previous.color ?? "#638e2d"),
      builtin: false,
      updatedAt: new Date().toISOString(),
    },
  };
}

export function listAgents(): any[] {
  return [...BUILTIN_AGENTS.map((item) => ({ ...item })), ...readCustomAgents()];
}

export function createAgent(input: any = {}): { ok: boolean; error?: string; agent?: any } {
  const result = cleanAgent(input);
  if (!result.ok) return result;
  const custom = readCustomAgents();
  custom.push(result.agent);
  saveCustomAgents(custom);
  return { ok: true, agent: result.agent };
}

export function updateAgent(id: any, patch: any = {}): { ok: boolean; error?: string; agent?: any } {
  const custom = readCustomAgents();
  const index = custom.findIndex((item) => item.id === String(id || ""));
  if (index < 0) return { ok: false, error: "自定义智能体不存在或内置智能体不可编辑" };
  const result = cleanAgent({ ...patch, id: custom[index]!.id }, custom[index]);
  if (!result.ok) return result;
  custom[index] = result.agent;
  saveCustomAgents(custom);
  return { ok: true, agent: result.agent };
}

export function deleteAgent(id: any): { ok: boolean; error?: string; id?: string } {
  const target = String(id || "");
  if (BUILTIN_AGENTS.some((item) => item.id === target)) return { ok: false, error: "内置智能体不可删除" };
  const custom = readCustomAgents();
  const next = custom.filter((item) => item.id !== target);
  if (next.length === custom.length) return { ok: false, error: "自定义智能体不存在" };
  saveCustomAgents(next);
  return { ok: true, id: target };
}
