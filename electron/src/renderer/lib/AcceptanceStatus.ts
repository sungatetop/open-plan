/**
 * 成果验收状态文案：统一「任务中心」与「工作产物面板」的口径。
 *
 * 关键区分（P0 可信度）：
 *   - 「文件格式验收」只说明文件本身通过/失败，不等于任务成功；
 *   - 任务未成功结束时，不得把文件标成可固定的「验收通过」；
 *   - 已固定的成果不再计入「待固定」。
 *
 * 与 client/src/components/AcceptanceStatus.js 逐函数等价（tests/f1-AcceptanceStatus-parity.test.ts 对拍强制）。
 */

/** 单个文件的格式验收状态 → 短文案。 */
export function artifactAcceptanceText(status: unknown): string {
  switch (status as string) {
    case "passed": return "格式通过";
    case "manual_review": return "待人工确认";
    case "warning": return "格式通过（有提示）";
    case "failed": return "格式失败";
    default: return "未检查";
  }
}

/** 任务级验收汇总：任务未成功结束时明确标注，避免与「任务成功」混淆。 */
export function acceptanceSummaryText(acceptanceStatus: unknown, runStatus: unknown): string {
  const base = acceptanceStatus === "passed" ? "文件格式验收通过"
    : acceptanceStatus === "manual_review" ? "文件格式待人工确认"
      : acceptanceStatus === "failed" ? "文件格式验收失败"
        : "文件格式未检查";
  return runStatus && runStatus !== "completed" ? `${base} · 任务未成功结束` : base;
}

/**
 * 产物状态标签：同时考虑「是否已固定」「格式验收」「任务是否成功」。
 * @returns {{ label: string, tone: ""|"published"|"failed"|"ready"|"warn", hint: string, canPublish: boolean }}
 */
export function artifactStatusInfo(opts: { publication?: unknown; result?: unknown; resultStatus?: unknown; runStatus?: unknown } = {}): { label: string; tone: "" | "published" | "failed" | "ready" | "warn"; hint: string; canPublish: boolean } {
  const { publication, result, resultStatus = "not_checked", runStatus } = opts;
  if (publication) {
    const pub = publication as { version?: unknown };
    return { label: `v${pub.version} 已固定`, tone: "published", hint: "已固定为正式成果；如需替换请先回滚。", canPublish: false };
  }
  const ready = Boolean((result as { readyToPublish?: unknown } | null | undefined)?.readyToPublish);
  const runDone = runStatus === "completed";
  if (resultStatus === "failed") {
    return { label: "格式验收失败", tone: "failed", hint: "文件格式验收未通过，无法固定；请修正后重新生成，或先人工确认。", canPublish: false };
  }
  if (ready && runDone) {
    return { label: "待固定", tone: "ready", hint: "文件格式验收通过且任务已成功结束，可固定为正式成果。", canPublish: true };
  }
  if (ready && !runDone) {
    return { label: "格式通过 · 任务未完成", tone: "warn", hint: "文件本身通过格式验收，但所属任务未成功结束，暂不可固定。", canPublish: false };
  }
  if (resultStatus === "accepted") {
    return { label: "已人工确认", tone: "", hint: "已人工确认；固定为正式成果仍需格式验收通过。", canPublish: false };
  }
  return { label: "待验收", tone: "", hint: "尚未完成验收。", canPublish: false };
}
