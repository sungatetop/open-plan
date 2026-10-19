/**
 * 领域硬约束检查器（preflight）——交通规划数据的硬约束进 Harness，不进提示词。
 *
 * 依据（AGENT.MD §坐标与数据校验）：
 *   - 中国坐标范围：经度 73–135°E、纬度 18–54°N，转换后超范围立即报警；
 *   - OD/客流数据导入后：验证记录数（expected vs actual），不完整不继续；
 *   - 创作模式产物必须写入 office-workspace；
 *   - 任何 officecli 写回先经用户确认（复用既有 review_waiting_confirmation）。
 *
 * 本模块只有纯函数：不抛错、不做 I/O、不落盘、不发事件。检查结果里带
 * `事件类型`，由调用方（执行侧）决定发事件与硬阻断，便于单测直接断言。
 */
import path from "node:path";
import { getWorkspace, isInside } from "./workspace.mjs";

/** 中国坐标范围（含边界）。 */
export const 经度范围 = Object.freeze([73, 135]);
export const 纬度范围 = Object.freeze([18, 54]);

/** 视为「写回既有资产」的工具：调用前必须确认。 */
const 写回类工具 = new Set(["officecli", "write", "edit", "map_edit", "map_import", "map_save_analysis", "review_source_apply"]);

function 取数值(value) {
  const 数 = Number(value);
  return Number.isFinite(数) ? 数 : null;
}

/** 归一化坐标点：支持 {经度,纬度} / {lon,lat} / {lng,lat} / [lon,lat]。 */
function 归一化点(项) {
  if (Array.isArray(项)) return { 经度: 取数值(项[0]), 纬度: 取数值(项[1]) };
  if (项 && typeof 项 === "object") {
    return {
      经度: 取数值(项.经度 ?? 项.lon ?? 项.lng ?? 项.longitude),
      纬度: 取数值(项.纬度 ?? 项.lat ?? 项.latitude),
    };
  }
  return { 经度: null, 纬度: null };
}

/**
 * geoRange：坐标范围硬约束。
 * @returns {{ok:boolean, 检查项:string, 事件类型:string, 违规:Array, 统计:object, 摘要:string}}
 */
export function 检查坐标范围(点集合 = [], 选项 = {}) {
  const 经界 = Array.isArray(选项.经度范围) ? 选项.经度范围 : 经度范围;
  const 纬界 = Array.isArray(选项.纬度范围) ? 选项.纬度范围 : 纬度范围;
  const 列表 = Array.isArray(点集合) ? 点集合 : [];
  const 违规 = [];
  列表.forEach((项, 索引) => {
    const { 经度, 纬度 } = 归一化点(项);
    if (经度 === null || 纬度 === null) {
      违规.push({ 索引, 经度, 纬度, 原因: "坐标缺失或非数值" });
      return;
    }
    if (经度 < 经界[0] || 经度 > 经界[1]) 违规.push({ 索引, 经度, 纬度, 原因: `经度超出 ${经界[0]}–${经界[1]}°E` });
    else if (纬度 < 纬界[0] || 纬度 > 纬界[1]) 违规.push({ 索引, 经度, 纬度, 原因: `纬度超出 ${纬界[0]}–${纬界[1]}°N` });
  });
  const ok = 违规.length === 0;
  return {
    ok,
    检查项: "geoRange",
    事件类型: "geo_out_of_range",
    违规,
    统计: { 总数: 列表.length, 越界数: 违规.length },
    摘要: 列表.length === 0 ? "无坐标数据，跳过范围检查" : ok ? `坐标范围检查通过（${列表.length} 点）` : `坐标越界 ${违规.length} 处，已阻断`,
  };
}

/**
 * recordCount：记录数一致性硬约束（expected vs actual，不完整不继续）。
 */
export function 检查记录数({ 声明数, 实际数, 名称 = "记录集" } = {}) {
  const 期望 = 取数值(声明数);
  const 实际 = 取数值(实际数);
  const 违规 = [];
  if (期望 === null || 实际 === null) 违规.push({ 原因: "记录数缺失或非数值" });
  else {
    if (实际 <= 0) 违规.push({ 原因: `${名称} 无有效记录` });
    else if (期望 !== 实际) 违规.push({ 原因: `记录数不一致：声明 ${期望} / 实际 ${实际}` });
  }
  const ok = 违规.length === 0;
  return {
    ok,
    检查项: "recordCount",
    事件类型: "data_integrity_failed",
    违规,
    统计: { 声明数: 期望, 实际数: 实际 },
    摘要: ok ? `${名称} 记录数一致（${实际}）` : `${名称} 记录数校验未通过，已阻断`,
  };
}

/**
 * writeBackGuard：写回保护（任何写回既有资产的调用先经用户确认）。
 */
export function 检查写回保护({ 工具, 已确认 = false, 目标 = "" } = {}) {
  const 名 = String(工具 || "").trim();
  const 需要确认 = 写回类工具.has(名);
  const ok = !需要确认 || 已确认 === true;
  return {
    ok,
    检查项: "writeBackGuard",
    事件类型: "review_waiting_confirmation",
    需要确认,
    违规: ok ? [] : [{ 原因: `写回工具 ${名} 未经用户确认`, 工具: 名, 目标 }],
    统计: { 工具: 名, 已确认: 已确认 === true },
    摘要: !需要确认 ? `工具 ${名 || "?"} 非写回类，无需确认` : ok ? `写回已确认（${名}）` : `写回待确认（${名}），已阻断`,
  };
}

/**
 * artifactRoot：产物根校验（产物必须落在工作区内）。
 */
export function 检查产物根(路径值, 选项 = {}) {
  const 根目录 = path.resolve(String(选项.产物根目录 || getWorkspace() || ""));
  const 目标 = String(路径值 || "").trim();
  const 违规 = [];
  let ok = false;
  if (!目标) 违规.push({ 原因: "缺少产物路径" });
  else {
    const 绝对路径 = path.resolve(根目录, 目标);
    ok = isInside(根目录, 绝对路径);
    if (!ok) 违规.push({ 原因: "产物路径不在工作区内", 目标: 绝对路径, 根目录 });
  }
  return {
    ok,
    检查项: "artifactRoot",
    事件类型: "artifact_root_violation",
    违规,
    统计: { 根目录, 目标 },
    摘要: ok ? "产物落在工作区内" : "产物路径越出工作区，已阻断",
  };
}

const 检查器表 = Object.freeze({
  geoRange: (上下文) => 检查坐标范围(上下文.坐标点, 上下文.坐标选项 || {}),
  recordCount: (上下文) => 检查记录数(上下文.记录数 || {}),
  writeBackGuard: (上下文) => 检查写回保护(上下文.写回 || {}),
  artifactRoot: (上下文) => 检查产物根(上下文.产物路径, 上下文.产物选项 || {}),
});

/** 全部检查器名称（与注册表 已知预检项 一致）。 */
export const 检查器名称 = Object.freeze(Object.keys(检查器表));

/**
 * 运行工作流声明的 preflight 检查集合。
 * @param {{preflight?:string[]}} 工作流
 * @param {object} 上下文   坐标点 / 记录数 / 写回 / 产物路径
 * @param {{跳过校验?:boolean}} 选项  跳过校验为用户显式确认（风险预案，需留痕）
 */
export function 运行预检(工作流 = {}, 上下文 = {}, 选项 = {}) {
  const 检查项列表 = Array.isArray(工作流.preflight) ? 工作流.preflight.filter((项) => 检查器表[项]) : [];
  if (选项.跳过校验 === true) {
    return {
      ok: true,
      跳过: true,
      检查结果: [],
      失败项: [],
      阻断事件: ["preflight_skipped"],
      摘要: "用户显式跳过 preflight 校验（需留痕）",
    };
  }
  const 检查结果 = 检查项列表.map((项) => 检查器表[项](上下文));
  const 失败项 = 检查结果.filter((项) => !项.ok);
  return {
    ok: 失败项.length === 0,
    跳过: false,
    检查结果,
    失败项,
    阻断事件: 失败项.map((项) => 项.事件类型),
    摘要: 失败项.length === 0 ? `preflight 全部通过（${检查结果.length} 项）` : `preflight 未通过：${失败项.map((项) => 项.摘要).join("；")}`,
  };
}

/** 工具白名单判定：工作流只允许使用声明过的工具。 */
export function 检查工具权限(工作流 = {}, 工具名 = "") {
  const 白名单 = Array.isArray(工作流.tools) ? 工作流.tools : [];
  return 白名单.includes(String(工具名 || "").trim());
}
