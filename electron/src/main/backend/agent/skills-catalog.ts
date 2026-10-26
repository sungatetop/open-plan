/**
 * Skills 目录扫描与预检（S3-3，自 server/index.mjs L2403-2522 逐行转录）。
 *
 * scanSkills 在每次 prompt admission 都会被调用；技能目录内容在会话期间基本不变，
 * 用根目录 mtime 签名 + 短 TTL 缓存，避免每轮读取数百个 SKILL.md 拖慢首字节。
 * 与 skill-search.ts（agent.mjs L290-334 的 Chat 本地检索，无缓存、path 指向文件）
 * 是两套面：本模块是 index.mjs 的 admission 扫描面（缓存 + 分类 + 目录路径）。
 *
 * 根目录锚点与 server SKILL_ROOTS 同构：AGENT_DIR/PROJECT_DIR 经 backend/workspace
 * 模块解析（B6-4），与 sidecar 进程指向同一组目录，跨实例扫描结果即时一致。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENT_DIR, PROJECT_DIR } from "../workspace";
import { getWorkflow } from "./workflows";

// ---------- 分类（server/index.mjs L2403-2421） ----------

// 交通规划工程师工作台：按技能用途分类
const SKILL_CATEGORIES: Array<{ id: string; label: string; keywords: string[] }> = [
  { id: "traffic", label: "交通规划", keywords: ["交通", "规划", "公交", "OD", "traffic", "transport", "出行", "客流", "公路", "物流", "枢纽"] },
  { id: "doc", label: "文档报告", keywords: ["报告", "论文", "公文", "规划报告", "work report", "撰写", "公文", "汇报", "研究报告", "论文"] },
  { id: "chart", label: "图表可视化", keywords: ["图表", "chart", "图", "可视化", "地图", "infographic", "ECharts", "diagram", "dashboard"] },
  { id: "image", label: "图像生成", keywords: ["图像", "image", "配图", "封面", "图片", "生成图片", "illustrat", "poster", "封面图"] },
  { id: "media", label: "媒体内容", keywords: ["视频", "音频", "配音", "TTS", "字幕", "脚本", "slide", "PPT", "抖音", "小红书"] },
  { id: "office", label: "Office办公", keywords: ["office", "officecli", "Excel", "Word", "PPTX", "docx", "xlsx", "表格"] },
  { id: "dev", label: "开发工具", keywords: ["代码", "开发", "debug", "test", "git", "部署", "browser", "agent", "skill", "workflow", "playwright"] },
  { id: "research", label: "搜索研究", keywords: ["搜索", "搜索", "文献", "research", "调研", "知识库", "论文"] },
  { id: "other", label: "其他", keywords: [] },
];

export function classifySkill(name: unknown, desc = ""): string {
  const text = `${name} ${desc}`.toLowerCase();
  for (const cat of SKILL_CATEGORIES) {
    if (cat.keywords.some((k) => text.includes(k.toLowerCase()))) return cat.id;
  }
  return "other";
}

// ---------- 根目录与缓存（server/index.mjs L2423-2445） ----------

export interface SkillCatalogEntry {
  name: string;
  description: string;
  path: string;
  source: string;
  category: string;
}

// 扫描用户所有 skills 目录（含 .pi/agent/skills、.agents/skills、项目 .agents/skills）
export function skillRoots(): string[] {
  return [
    path.join(AGENT_DIR, "skills"),
    path.join(process.env.USERPROFILE || os.homedir(), ".agents", "skills"),
    path.join(process.env.USERPROFILE || os.homedir(), ".claude", "skills"),
    path.join(PROJECT_DIR, ".agents", "skills"),
    path.join(PROJECT_DIR, ".pi", "skills"),
    path.join(PROJECT_DIR, ".claude", "skills"),
    // 用户实际工作根目录（项目目录的上一级）的 .claude skills：相对推导，避免写死某台机器的路径
    path.resolve(PROJECT_DIR, "..", ".claude", "skills"),
  ];
}

const SKILLS_CACHE_TTL_MS = 30000;

interface SkillsCacheState {
  signature: string;
  results: SkillCatalogEntry[] | null;
  expiresAt: number;
}

let skillsCache: SkillsCacheState = { signature: "", results: null, expiresAt: 0 };

function skillsRootSignature(): string {
  let sig = "";
  for (const root of skillRoots()) {
    try { sig += `${root}:${fs.statSync(root).mtimeMs};`; } catch { sig += `${root}:missing;`; }
  }
  return sig;
}

// ---------- 扫描（server/index.mjs L2447-2486） ----------

export function scanSkills(): SkillCatalogEntry[] {
  const nowMs = Date.now();
  const signature = skillsRootSignature();
  if (skillsCache.results && skillsCache.signature === signature && nowMs < skillsCache.expiresAt) {
    return skillsCache.results;
  }
  const out: SkillCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const root of skillRoots()) {
    if (!fs.existsSync(root)) continue;
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const skillDir = path.join(root, e.name);
      const skillFile = path.join(skillDir, "SKILL.md");
      if (!fs.existsSync(skillFile)) continue;
      if (seen.has(e.name)) continue;
      seen.add(e.name);
      // 解析 frontmatter 里的 description
      let desc = "";
      try {
        const content = fs.readFileSync(skillFile, "utf8");
        const m = content.match(/^---\s*\n([\s\S]*?)\n---/);
        if (m) {
          const dm = m[1]?.match(/description:\s*["']?([^"'\n]+)/);
          if (dm) desc = dm[1]?.trim() || "";
        }
      } catch { /* server 同款静默 */ }
      out.push({
        name: e.name,
        description: desc,
        path: skillDir,
        source: root.includes(".agents") ? "agents" : root.includes(".pi") ? "pi" : "pi-agent",
        category: classifySkill(e.name, desc),
      });
    }
  }
  const sorted = out.sort((a, b) => a.name.localeCompare(b.name));
  skillsCache = { signature, results: sorted, expiresAt: nowMs + SKILLS_CACHE_TTL_MS };
  return sorted;
}

/** 测试注入面：重置模块级缓存（server 同名状态为闭包内变量，不可从外部重置）。 */
export function resetSkillsCacheForTest(): void {
  skillsCache = { signature: "", results: null, expiresAt: 0 };
}

// ---------- 预检（server/index.mjs L2488-2522） ----------

export interface SkillPreflightCheck {
  name: string;
  ok: boolean;
  status: "missing" | "ready" | "invalid";
  path?: string;
  checks?: { directory: boolean; file: boolean; readable: boolean; nonEmpty: boolean };
  message: string;
}

export interface SkillPreflightResult {
  ok: boolean;
  workflow: { id: unknown; name?: unknown; valid: unknown } | null;
  required: string[];
  checks: SkillPreflightCheck[];
  missing: string[];
  message: string;
}

function preflightSkill(name: unknown, skills: SkillCatalogEntry[] = scanSkills()): SkillPreflightCheck {
  const cleanName = String(name || "").trim();
  const skill = skills.find((item) => item.name === cleanName);
  if (!skill) return { name: cleanName, ok: false, status: "missing", message: "未找到该 skill" };
  const skillFile = path.join(skill.path, "SKILL.md");
  const checks = { directory: false, file: false, readable: false, nonEmpty: false };
  try {
    checks.directory = fs.statSync(skill.path).isDirectory();
    checks.file = fs.statSync(skillFile).isFile();
    if (checks.file) {
      const content = fs.readFileSync(skillFile, "utf8");
      checks.readable = true;
      checks.nonEmpty = Boolean(content.trim());
    }
  } catch { /* server 同款静默 */ }
  const ok = checks.directory && checks.file && checks.readable && checks.nonEmpty;
  return { name: cleanName, ok, status: ok ? "ready" : "invalid", path: skill.path, checks, message: ok ? "SKILL.md 可读取" : "SKILL.md 不存在、不可读取或为空" };
}

export function preflightSkills(
  { workflowId = null, requestedSkills = [], skills = scanSkills() }:
  { workflowId?: unknown; requestedSkills?: unknown[]; skills?: SkillCatalogEntry[] } = {}
): SkillPreflightResult {
  const workflow = workflowId ? getWorkflow(workflowId, skills) : null;
  const requested = Array.isArray(requestedSkills) ? requestedSkills : [];
  const names = [...new Set([...(Array.isArray(workflow?.skills) ? workflow.skills : []), ...requested].map((name) => String(typeof name === "object" ? (name as { name?: unknown })?.name : name || "").trim()).filter(Boolean))] as string[];
  const checks = names.map((name) => preflightSkill(name, skills));
  const workflowMissing: string[] = workflowId && !workflow ? [`工作流不存在：${workflowId}`] : (workflow?.missing || []) as string[];
  const ok = !workflowMissing.length && checks.every((item) => item.ok);
  const failedNames = [...new Set([...workflowMissing, ...checks.filter((item) => !item.ok).map((item) => item.name)])];
  return {
    ok,
    workflow: workflow ? { id: workflow.id, name: workflow.name, valid: workflow.valid } : (workflowId ? { id: workflowId, valid: false } : null),
    required: names,
    checks,
    missing: failedNames,
    message: ok ? "Skills 预检通过" : `Skills 预检未通过：${failedNames.join("、")}`,
  };
}
