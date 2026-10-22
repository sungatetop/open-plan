/**
 * 工作区记忆分层读取（B6-6-2，自 server/agent.mjs L758-810 逐行转录）。
 *
 * 规则（AGENTS.md）优先；memory/*.md 按「## 标题」分类（规则/偏好/项目/经验），
 * 无标题时按文件名关键词归类，其余进 other；注入时按预算截断。
 * workspace 参数缺省回落当前工作区（getWorkspace，B6-4）。
 */
import fs from "node:fs";
import path from "node:path";
import { getWorkspace, normalizeWorkspace } from "../workspace";

export interface MemoryOtherEntry {
  file: string;
  content: string;
}

export interface MemoryLayers {
  rules: string;
  project: string;
  preferences: string;
  lessons: string;
  other: MemoryOtherEntry[];
}

/** 分层读取工作区记忆：规则优先，偏好/项目知识/经验再按预算注入。 */
export function readMemoryLayers(workspace = getWorkspace()): MemoryLayers {
  const layers: MemoryLayers = { rules: "", project: "", preferences: "", lessons: "", other: [] };
  try {
    const ws = normalizeWorkspace(workspace) || normalizeWorkspace(getWorkspace());
    if (!ws) return layers;
    const read = (file: string, max = 1800): string => {
      try { return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().slice(0, max) : ""; } catch { return ""; }
    };
    layers.rules = read(path.join(ws, "AGENTS.md"), 1800);
    const memDir = path.join(ws, "memory");
    if (fs.existsSync(memDir)) {
      for (const f of fs.readdirSync(memDir).filter((x) => x.endsWith(".md"))) {
        const content = read(path.join(memDir, f), 1800);
        if (!content) continue;
        const add = (bucket: "rules" | "project" | "preferences" | "lessons", value: string) => { layers[bucket] += `\n${value}`; };
        const sectionMatches = [...content.matchAll(/^##\s+(.+)\s*$/gm)];
        if (sectionMatches.length > 0) {
          sectionMatches.forEach((match, index) => {
            const title = match[1]!.trim();
            const start = match.index! + match[0].length;
            const end = sectionMatches[index + 1]?.index ?? content.length;
            const body = content.slice(start, end).trim();
            if (!body) return;
            if (/规则|准则/i.test(title)) add("rules", `### ${title}\n${body}`);
            else if (/偏好|preference/i.test(title)) add("preferences", `### ${title}\n${body}`);
            else if (/项目信息|项目事实|项目状态|project/i.test(title)) add("project", `### ${title}\n${body}`);
            else if (/经验|教训|lesson/i.test(title)) add("lessons", `### ${title}\n${body}`);
            else layers.other.push({ file: `${f} / ${title}`, content: body });
          });
        } else {
          const key = f.toLowerCase();
          if (key.includes("preference") || key.includes("用户偏好")) add("preferences", content);
          else if (key.includes("project") || key.includes("项目信息")) add("project", content);
          else if (key.includes("lesson") || key.includes("经验教训")) add("lessons", content);
          else layers.other.push({ file: f, content });
        }
      }
    }
  } catch {}
  return layers;
}

export function readMemoryContext(workspace = getWorkspace()): string {
  const layers = readMemoryLayers(workspace);
  return [
    layers.rules && `## 工作区准则（AGENTS.md）\n${layers.rules}`,
    layers.project && `## 项目信息\n${layers.project.slice(0, 900)}`,
    layers.preferences && `## 用户偏好\n${layers.preferences.slice(0, 900)}`,
    layers.lessons && `## 经验教训\n${layers.lessons.slice(0, 900)}`,
    ...layers.other.map((x) => `## 记忆：${x.file}\n${x.content.slice(0, 600)}`),
  ].filter(Boolean).join("\n\n").slice(0, 2800);
}
