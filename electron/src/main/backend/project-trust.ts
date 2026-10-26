/**
 * U9：项目信任薄封装（Pi SDK 原生 ProjectTrustStore 的最小接入）（S3-13 转录）。
 *
 * 逐行等价迁移自 server/project-trust.mjs；消费面：旧 index.mjs L22
 * （workspaceTrustSummary/setWorkspaceTrust，GET /api/agent/workspace-trust 与显式写信任位）。
 * AGENT_DIR 直绑 TS pi-config-management（workspace.ts 同源先例）；RUNTIME_FLAGS 直绑本批
 * feature-flags.ts。注意：当前仅对拍覆盖、未装配运行时；旧 JS 实现保留至域退役。
 *
 * 评审 R9 后的收敛定位：ProjectTrustDecision 为三态 boolean|null，SDK 不支持
 * 多级信任映射。本模块只做"首次打开工作区"单一场景：
 *   - 读取：工作区是否已被信任（get 三态）+ 是否存在需信任门禁的项目资源
 *     （hasTrustRequiringProjectResources）；
 *   - 写入：仅在 OAW_PROJECT_TRUST_GATE=on 时允许显式设置信任位。
 *
 * 与 approval-policy 的关系：不动存量审批判定；未信任工作区的行为由调用方
 * （前端提示 / 后续审批联动）决定，本模块只承载 SDK 信任位这一事实来源。
 */
import { ProjectTrustStore, hasTrustRequiringProjectResources } from "@earendil-works/pi-coding-agent";
import { AGENT_DIR } from "./agent/pi-config-management";
import { RUNTIME_FLAGS } from "./feature-flags";

let sharedStore: ProjectTrustStore | null = null;

function store(): ProjectTrustStore {
  if (!sharedStore) sharedStore = new ProjectTrustStore(AGENT_DIR);
  return sharedStore;
}

/** 三态信任读取：true=已信任 / false=已拒绝 / null=未判定。 */
export function workspaceTrustDecision(cwd: string): boolean | null {
  try {
    return store().get(cwd) ?? null;
  } catch {
    return null;
  }
}

/** 工作区是否存在需信任门禁的项目资源（cwd/.pi 下的 trust-requiring 条目等）。 */
export function workspaceRequiresTrustGate(cwd: string): boolean {
  try {
    return hasTrustRequiringProjectResources(cwd) === true;
  } catch {
    return false;
  }
}

/** 诊断汇总（GET /api/agent/workspace-trust 用）。 */
export function workspaceTrustSummary(cwd: string) {
  return {
    cwd,
    decision: workspaceTrustDecision(cwd),
    requiresGate: workspaceRequiresTrustGate(cwd),
    flagEnabled: RUNTIME_FLAGS.projectTrustGate,
  };
}

/** 显式设置信任位。flag off（默认）时拒绝写入，防止绕过统一开关管道。 */
export function setWorkspaceTrust(cwd: string, trusted: unknown) {
  if (!RUNTIME_FLAGS.projectTrustGate) {
    throw new Error("项目信任写入未启用（OAW_PROJECT_TRUST_GATE=off）");
  }
  store().set(cwd, trusted === true);
  return workspaceTrustSummary(cwd);
}
