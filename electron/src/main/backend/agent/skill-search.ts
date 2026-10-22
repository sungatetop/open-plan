/**
 * Chat 的 Skills 本地检索（B6-6-2，自 server/agent.mjs L290-334 逐行转录）。
 *
 * 只读本地 SKILL.md，不把目录扫描交给模型自行猜路径：既能复用 Pi/Agents 的技能目录，
 * 也避免外部路径被 read 工具误用。AGENT_DIR/PROJECT_DIR 由 workspace 模块锚定（B6-4）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENT_DIR, PROJECT_DIR } from "../workspace";

export interface LocalSkill {
  name: string;
  description: string;
  path: string;
  source: string;
}

export function localSkillRoots(): string[] {
  return [
    path.join(AGENT_DIR, "skills"),
    path.join(process.env.USERPROFILE || os.homedir(), ".agents", "skills"),
    path.join(process.env.USERPROFILE || os.homedir(), ".claude", "skills"),
    path.join(PROJECT_DIR, ".agents", "skills"),
    path.join(PROJECT_DIR, ".pi", "skills"),
    path.join(PROJECT_DIR, ".claude", "skills"),
    // 工作根目录（项目目录的上一级）下的 .claude/skills：用相对推导而不是写死某台机器的路径
    path.resolve(PROJECT_DIR, "..", ".claude", "skills"),
  ];
}

export function localSkillCatalog(): LocalSkill[] {
  const result: LocalSkill[] = [];
  const seen = new Set<string>();
  for (const root of localSkillRoots()) {
    if (!fs.existsSync(root)) continue;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || seen.has(entry.name)) continue;
      const file = path.join(root, entry.name, "SKILL.md");
      if (!fs.existsSync(file)) continue;
      let content = "";
      try { content = fs.readFileSync(file, "utf8"); } catch { continue; }
      const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---/);
      const description = frontmatter?.[1]?.match(/description:\s*["']?([^"'\n]+)/)?.[1]?.trim() || "";
      seen.add(entry.name);
      result.push({ name: entry.name, description, path: file, source: root.includes(".agents") ? "agents" : root.includes(".pi") ? "pi" : "pi-agent" });
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

export function searchLocalSkills(query = "", limit = 12): LocalSkill[] {
  const words = String(query || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  const skills = localSkillCatalog();
  const matched = words.length
    ? skills.filter((skill) => words.every((word) => `${skill.name} ${skill.description}`.toLowerCase().includes(word)))
    : skills;
  return matched.slice(0, Math.max(1, Math.min(30, Number(limit) || 12)));
}
