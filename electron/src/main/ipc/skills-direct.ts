/**
 * 技能域通道直调器（F6-1）：op:skills:* 3 条通道 → 进程内直调技能目录编排
 * （server/index.mjs L2525-2527 / L2683-2737 逐点转录；行号锚点均指 server/index.mjs）。
 *
 *   - op:skills:list（L2525-2527）：{ skills: scanSkills() }；
 *   - op:skills:export（L2683-2710）：scanSkills() 内按 name 线性查找 → !skill 404
 *     { error:"skill not found" } → 读 SKILL.md（utf8）+ 同目录其余文件（base64，
 *     仅 isFile 且排除 SKILL.md）→ { ok:true, skill:{ name, description, content, extra } }；
 *     catch → 500 { error: e.message }（message 非 Error 形态时为 undefined，JSON 序列化
 *     丢弃该字段——保真透传，不做 String() 补齐）；
 *   - op:skills:import（L2713-2737）：!name||!content 400 / 名称白名单 /^[a-z0-9-]+$/
 *     400 → 目标目录 join(AGENT_DIR,"skills",name) mkdir recursive → SKILL.md 无
 *     frontmatter 时补 `---\nname/description---` 头 → 写辅助文件（文件名含
 *     \\/:*?"<>| 的跳过）→ { ok:true, name }；catch → 500 { error: e.message }。
 *
 * 数据源：backend/agent/skills-catalog.ts 的 scanSkills（cache 30s TTL，与 server
 * scanSkills 同语义）；AGENT_DIR 语义沿 skills-catalog 的 import（backend/workspace）。
 *
 * 门控：OP_DESKTOP_SKILLS_DIRECT 且 OP_DESKTOP_AGENT_DOMAIN 双门控（S4 语义：未设置=
 * 默认启用，=0 显式回滚）。本模块不 import electron（纯逻辑，vitest 可直接测）；
 * 注册入口在 main/index.ts。
 */
import path from "node:path";
import type { InvokeEnvelope, InvokeResult } from "../../shared/protocol/channels";

/** 技能域编排的跨域依赖（生产接线传 skills-catalog 真实模块 + node:fs，测试注入桩）。 */
export interface SkillsDirectDeps {
  /** 技能目录扫描（backend/agent/skills-catalog.ts scanSkills，含 30s 缓存） */
  scanSkills: () => Array<Record<string, unknown>>;
  /** 用户技能根目录（server AGENT_DIR 语义，import 目标 = path.join(dir, "skills", name)） */
  agentDir: string;
  /** 文件系统注入（与 map-direct dirProbe 同惯例；生产传 node:fs） */
  fs: {
    readFileSync: (path: string, encoding: "utf8" | "base64") => string;
    readdirSync: (path: string, options: { withFileTypes: true }) => Array<{ name: string; isFile: () => boolean }>;
    mkdirSync: (path: string, options: { recursive: true }) => void;
    writeFileSync: (path: string, data: string | Buffer) => void;
  };
}

/** 技能域直调 invoke 通道清单（与 DESKTOP_CHANNELS 对应路由一致）。 */
export const SKILLS_DIRECT_CHANNELS = [
  "op:skills:list",
  "op:skills:export",
  "op:skills:import"
] as const;

export type SkillsDirectChannel = (typeof SKILLS_DIRECT_CHANNELS)[number];

const ok = (data: unknown): InvokeResult<unknown> => ({ ok: true, status: 200, data });
const fail = (status: number, data: unknown): InvokeResult<unknown> => ({ ok: false, status, data } as InvokeResult<unknown>);

const bodyOf = (payload: InvokeEnvelope): Record<string, any> => (payload.body ?? {}) as Record<string, any>;

/** GET /api/skills（L2525-2527 逐点转录）。 */
function invokeList(deps: SkillsDirectDeps): InvokeResult<unknown> {
  return ok({ skills: deps.scanSkills() });
}

/** POST /api/skills/export（L2683-2710 逐点转录：!skill 404 → 读 SKILL.md + 辅助文件
 * base64 → catch 500 { error: e.message } 保真透传）。 */
function invokeExport(payload: InvokeEnvelope, deps: SkillsDirectDeps): InvokeResult<unknown> {
  const { name } = bodyOf(payload);
  const skills = deps.scanSkills();
  const skill = skills.find((s) => s.name === name);
  if (!skill) return fail(404, { error: "skill not found" });
  try {
    const skillPath = String(skill.path ?? "");
    const content = deps.fs.readFileSync(path.join(skillPath, "SKILL.md"), "utf8");
    // 附带同目录的其他辅助文件（脚本等）
    const extra: Record<string, string> = {};
    for (const e of deps.fs.readdirSync(skillPath, { withFileTypes: true })) {
      if (e.isFile() && e.name !== "SKILL.md") {
        extra[e.name] = deps.fs.readFileSync(path.join(skillPath, e.name), "base64");
      }
    }
    return ok({
      ok: true,
      skill: {
        name: skill.name,
        description: skill.description,
        content: Buffer.from(content).toString("base64"),
        extra
      }
    });
  } catch (e) {
    const err = e as { message?: unknown };
    return fail(500, { error: (err ?? {}).message });
  }
}

/** POST /api/skills/import（L2713-2737 逐点转录：必填/白名单 400 → mkdir → frontmatter
 * 补头 → 辅助文件写入（非法文件名跳过）→ { ok, name }；catch 500 { error }）。 */
function invokeImport(payload: InvokeEnvelope, deps: SkillsDirectDeps): InvokeResult<unknown> {
  const { name, description, content, extra } = bodyOf(payload);
  if (!name || !content) return fail(400, { error: "name and content required" });
  // 安全校验：只允许合法 skill 名
  if (!/^[a-z0-9-]+$/.test(String(name))) return fail(400, { error: "invalid skill name (小写字母/数字/连字符)" });
  const targetDir = path.join(deps.agentDir, "skills", String(name));
  try {
    deps.fs.mkdirSync(targetDir, { recursive: true });
    // 写入 SKILL.md（带 frontmatter）
    const body = Buffer.from(String(content), "base64").toString("utf8");
    let skillContent = body;
    if (!body.startsWith("---")) {
      skillContent = `---\nname: ${name}\ndescription: ${description || name}\n---\n\n` + body;
    }
    deps.fs.writeFileSync(path.join(targetDir, "SKILL.md"), skillContent);
    // 写入辅助文件
    for (const [fname, b64] of Object.entries(extra || {})) {
      if (/[\\/:*?"<>|]/.test(fname)) continue;
      deps.fs.writeFileSync(path.join(targetDir, fname), Buffer.from(String(b64), "base64"));
    }
    return ok({ ok: true, name });
  } catch (e) {
    const err = e as { message?: unknown };
    return fail(500, { error: (err ?? {}).message });
  }
}

/**
 * 技能域直调分发入口：ipcMain.handle 注册侧调用（main/index.ts registerSkillsDirectInvokers）。
 * 全部路由均有 try/catch 或纯同步域调用，异常面与 server 一致。
 */
export function invokeSkillsDirect(
  channel: string,
  payload: InvokeEnvelope | undefined,
  deps: SkillsDirectDeps
): InvokeResult<unknown> {
  const envelope: InvokeEnvelope = payload ?? {};
  switch (channel as SkillsDirectChannel) {
    case "op:skills:list":
      return invokeList(deps);
    case "op:skills:export":
      return invokeExport(envelope, deps);
    case "op:skills:import":
      return invokeImport(envelope, deps);
    default:
      return fail(404, { error: `unknown channel: ${channel}` });
  }
}
