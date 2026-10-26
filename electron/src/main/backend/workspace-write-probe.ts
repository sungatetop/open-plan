/**
 * 工作区写探针与任务写权限预检（S3-3 转录）。
 *
 * - evaluateWorkspaceWrite：自 server/run-evaluation.mjs L59-84 逐行转录——创建后
 *   立即删除的临时探针验证"当前进程能不能可靠写工作区"（create-modify-readback-delete），
 *   避免把"协调器存在"误报成"工作区实际可写"。
 * - requireWorkspaceWriteForTask：自 server/index.mjs L938-953 逐行转录——prompt
 *   admission 与 continuation 恢复路径共用的写权限闸门；仅 review 模式或声明产出的
 *   任务需要写探针，探针失败统一归一为 WORKSPACE_WRITE_UNAVAILABLE（权限/文档锁定
 *   两码保留原值）。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizeWorkspaceWriteError } from "./file-permission-error";
import { withWriteLock, writeWorkspaceFile } from "./agent/write-coordination";

export interface EvaluationCheck {
  id: string;
  label: string;
  status: "passed" | "failed" | "warning";
  message: string;
  details: Record<string, unknown>;
}

function check(id: string, label: string, status: EvaluationCheck["status"], message: string, details: Record<string, unknown> = {}): EvaluationCheck {
  return { id, label, status, message, details };
}

export function evaluateWorkspaceWrite(root: string): EvaluationCheck {
  const probeFile = path.join(root, `.规聚写入探针-${process.pid}-${crypto.randomUUID()}.tmp`);
  let created = false;
  let stage = "create";
  try {
    writeWorkspaceFile({ workspace: root, targetPath: probeFile, content: "规聚工作区写入能力探针-初始", kind: "workspace_write_probe", skipExternalOverlap: true });
    created = true;
    stage = "modify";
    writeWorkspaceFile({ workspace: root, targetPath: probeFile, content: "规聚工作区写入能力探针-修改", kind: "workspace_write_probe", skipExternalOverlap: true });
    stage = "readback";
    if (fs.readFileSync(probeFile, "utf8") !== "规聚工作区写入能力探针-修改") {
      const error = new Error("写入后回读内容不一致") as Error & { code?: string };
      error.code = "WRITE_PROBE_MISMATCH";
      throw error;
    }
    stage = "delete";
    withWriteLock({ workspace: root, targetPath: probeFile, runId: `probe_${crypto.randomUUID().replaceAll("-", "")}`, kind: "workspace_write_probe", skipExternalOverlap: true }, () => fs.unlinkSync(probeFile));
    created = false;
    return check("workspace-write", "工作区写入", "passed", "当前服务进程已完成文件创建、修改、回读和删除探针", { probe: "create-modify-readback-delete", root, operations: ["create", "modify", "readback", "delete"] });
  } catch (error: any) {
    if (created) {
      try { fs.unlinkSync(probeFile); } catch { /* server 同款静默 */ }
    }
    return check("workspace-write", "工作区写入", "failed", `当前服务进程在${stage}阶段无法完成工作区探针：${error.message}`, { probe: "create-modify-readback-delete", root, stage, code: error?.code || null });
  }
}

/**
 * prompt admission 写权限闸门（server/index.mjs L938-953）。通过时返回写探针
 * 结果（会回填 capabilityPlan.workspaceWrite），不需要写或明确 saveToWorkspace=false
 * 时返回 null；失败抛出归一化错误（writeAccess 挂在错误对象上）。
 */
export function requireWorkspaceWriteForTask<T extends Record<string, any>>(capabilityPlan: T | null | undefined, workspace: string): EvaluationCheck | null {
  const reviewNeedsWorkspace = capabilityPlan?.mode === "review";
  if (
    (!reviewNeedsWorkspace && !capabilityPlan?.output?.expected) ||
    capabilityPlan.output.saveToWorkspace === false
  ) {
    return null;
  }
  const writeAccess = evaluateWorkspaceWrite(workspace);
  (capabilityPlan as Record<string, any>).workspaceWrite = writeAccess;
  if (writeAccess.status === "passed") return writeAccess;
  const failure = normalizeWorkspaceWriteError(Object.assign(new Error(writeAccess.message), { code: writeAccess.details?.code || undefined }));
  if (!["WORKSPACE_PERMISSION_DENIED", "OFFICE_DOCUMENT_LOCKED"].includes(failure.code || "")) failure.code = "WORKSPACE_WRITE_UNAVAILABLE";
  (failure as any).writeAccess = writeAccess;
  throw failure;
}
