/**
 * 领域工作流注册表（声明式加载 + 结构校验）。
 *
 * 逐行等价迁移自 server/workflow-registry.mjs（S3-12，绞杀者分域 S3 批次，零依赖六域批）。
 *
 * 定位（Qoder 对标 §4.4）：只做「扫描工作流目录 → 校验声明结构 → 提供只读查询」，
 * **不新建编排引擎**。治理动作全部委托既有模块：
 *   budget    → server/run-budget.mjs
 *   approval  → server/approval-policy.mjs（阶段 approval=true 时派发 tool_approval_request）
 *   artifacts → server/artifact-management.mjs（核对产物契约）
 *   硬约束     → workflow-validation.ts（preflight 检查器，同批）
 *
 * 声明结构（字段齐全才可通过校验）：
 *   id / title / budget{maxTurns,maxToolCalls,maxWallMs} / tools[] / preflight[]
 *   / stages[{id,title,approval?}] / artifacts[{id,title,kind,required}]
 *
 * 路径锚定：旧侧 目录=__dirname(server/)/工作流——TS 侧 PROJECT_DIR 直绑
 * workspace-paths（仓库根锚点，S3-10 tpl 先例），<项目根>/server/工作流 数学等价；
 * 目录缺失时懒加载返回空表（基线仓库不含该目录，与旧侧行为一致）。
 * 声明文件为运行时数据（*.mjs 动态导入），不属转录面，新旧侧加载同一物理文件。
 * 当前消费面：旧 index.mjs L2541/L2566 动态 import，随流量切换批退役。
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PROJECT_DIR } from "./workspace-paths";

const 目录 = path.join(PROJECT_DIR, "server", "工作流");
const 编号形态 = /^[a-z][a-z0-9-]*$/;

/** 已知的 preflight 检查器名称（与 workflow-validation.ts 一一对应）。 */
export const 已知预检项 = Object.freeze(["geoRange", "recordCount", "writeBackGuard", "artifactRoot"]);
const 预检项集合 = new Set<string>(已知预检项);
/** 已知的产物类型（仅用于声明校验，不限制产物落盘形态）。 */
export const 已知产物类型 = Object.freeze(["data", "map", "table", "list", "doc", "mark", "check", "config", "report", "figure"]);
const 产物类型集合 = new Set<string>(已知产物类型);

function 取文本(value: any): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}
function 是正整数(value: any): boolean {
  return Number.isInteger(value) && value > 0;
}

/**
 * 校验单个工作流声明（纯函数，不抛错）。
 */
export function 校验工作流(声明: any): { ok: boolean; 错误: string[]; 声明: any } {
  const 错误: string[] = [];
  if (!声明 || typeof 声明 !== "object" || Array.isArray(声明)) {
    return { ok: false, 错误: ["声明必须是对象"], 声明: null };
  }
  const id = 取文本(声明.id);
  if (!id) 错误.push("缺少 id");
  else if (!编号形态.test(id)) 错误.push(`id 形态非法（应形如 od-demand-analysis）：${id}`);
  if (!取文本(声明.title)) 错误.push("缺少 title");
  if (!取文本(声明.description)) 错误.push("缺少 description");

  const budget = 声明.budget;
  if (!budget || typeof budget !== "object" || Array.isArray(budget)) {
    错误.push("缺少 budget");
  } else {
    for (const 键 of ["maxTurns", "maxToolCalls", "maxWallMs"]) {
      if (!是正整数(budget[键])) 错误.push(`budget.${键} 必须是正整数`);
    }
  }

  if (!Array.isArray(声明.tools) || !声明.tools.length) 错误.push("tools 必须是非空数组");
  else {
    const 去重 = new Set<string>();
    for (const 工具 of 声明.tools) {
      const 名 = 取文本(工具);
      if (!名) 错误.push("tools 含空工具名");
      else if (去重.has(名)) 错误.push(`tools 重复：${名}`);
      else 去重.add(名);
    }
  }

  if (!Array.isArray(声明.preflight)) 错误.push("preflight 必须是数组");
  else {
    for (const 项 of 声明.preflight) {
      if (!预检项集合.has(项)) 错误.push(`preflight 未知检查项：${项}`);
    }
  }

  校验阶段列表(声明.stages, 错误);

  if (!Array.isArray(声明.artifacts) || !声明.artifacts.length) 错误.push("artifacts 必须是非空数组");
  else {
    const 已见 = new Set<string>();
    for (const 产物 of 声明.artifacts || []) {
      const 名 = 取文本(产物?.id);
      if (!名) 错误.push("artifacts 含缺失 id 的条目");
      else if (已见.has(名)) 错误.push(`artifacts 重复：${名}`);
      else 已见.add(名);
      if (!取文本(产物?.title)) 错误.push(`artifacts ${名 || "?"} 缺少 title`);
      if (!产物类型集合.has(产物?.kind)) 错误.push(`artifacts ${名 || "?"} 未知 kind：${产物?.kind}`);
      if (typeof 产物?.required !== "boolean") 错误.push(`artifacts ${名 || "?"} required 必须是布尔`);
    }
  }

  return { ok: 错误.length === 0, 错误, 声明: 错误.length ? null : 声明 };
}

function 校验阶段列表(阶段列表: any, 错误: string[]): void {
  if (!Array.isArray(阶段列表) || !阶段列表.length) {
    错误.push("stages 必须是非空数组");
    return;
  }
  const 已见 = new Set<string>();
  for (const 阶段 of 阶段列表) {
    const 名 = 取文本(阶段?.id);
    if (!名) 错误.push("stages 含缺失 id 的条目");
    else if (已见.has(名)) 错误.push(`stages 重复：${名}`);
    else 已见.add(名);
    if (!取文本(阶段?.title)) 错误.push(`stages ${名 || "?"} 缺少 title`);
    if (阶段?.approval !== undefined && typeof 阶段.approval !== "boolean") 错误.push(`stages ${名 || "?"} approval 必须是布尔`);
  }
}

let 缓存: Promise<any[]> | null = null;

/**
 * 懒加载声明表（首次调用时读取目录并动态导入）。
 * 刻意不在模块加载期读取：声明非法时只在「真正使用」时报错并降级，
 * 不影响服务启动与基线路径（开关关闭时调用方根本不会 import 本模块）。
 */
async function 加载声明表(): Promise<any[]> {
  if (缓存) return 缓存;
  缓存 = (async () => {
    const 表: any[] = [];
    if (!fs.existsSync(目录)) return 表;
    const 文件列表 = fs.readdirSync(目录).filter((名) => 名.endsWith(".mjs")).sort();
    for (const 文件名 of 文件列表) {
      const 模块: any = await import(pathToFileURL(path.join(目录, 文件名)).href);
      const 结论 = 校验工作流(模块?.default);
      if (!结论.ok) throw new Error(`工作流声明非法（${文件名}）：${结论.错误.join("；")}`);
      表.push(Object.freeze({ ...模块.default, 文件: 文件名 }));
    }
    const 编号集合 = new Set<string>();
    for (const 声明 of 表) {
      if (编号集合.has(声明.id)) throw new Error(`工作流 id 重复：${声明.id}`);
      编号集合.add(声明.id);
    }
    return 表;
  })();
  return 缓存;
}

/** 列出全部领域工作流声明（只读副本）。 */
export async function 列出工作流(): Promise<any[]> {
  return (await 加载声明表()).map((项) => ({ ...项 }));
}

/** 按 id 取工作流声明，未命中返回 null。 */
export async function 取工作流(id: any): Promise<any> {
  const 目标 = 取文本(id);
  const 命中 = (await 加载声明表()).find((项) => 项.id === 目标);
  return 命中 ? { ...命中 } : null;
}

/** 注册表概览（供诊断面板 / 契约测试断言）。 */
export async function 注册表概览(): Promise<any> {
  const 表 = await 加载声明表();
  return {
    total: 表.length,
    ids: 表.map((项) => 项.id),
    已知预检项: [...已知预检项],
    声明文件目录: "server/workflows",
  };
}
