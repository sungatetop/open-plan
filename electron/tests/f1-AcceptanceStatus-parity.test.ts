import { describe, it, expect } from "vitest";
import { artifactAcceptanceText, acceptanceSummaryText, artifactStatusInfo } from "../src/renderer/lib/AcceptanceStatus";

const serverModule = await import("../../client/src/components/AcceptanceStatus.js");
const server = serverModule as unknown as {
  artifactAcceptanceText: typeof artifactAcceptanceText;
  acceptanceSummaryText: typeof acceptanceSummaryText;
  artifactStatusInfo: typeof artifactStatusInfo;
};

describe("AcceptanceStatus TS 版与 client 版等价（对拍）", () => {
  it("artifactAcceptanceText：已知/未知状态一致", () => {
    const cases: unknown[] = ["passed", "manual_review", "warning", "failed", "not_checked", "", "weird", 123, null, undefined, {}];
    for (const c of cases) {
      expect(artifactAcceptanceText(c)).toBe(server.artifactAcceptanceText(c));
    }
    expect(artifactAcceptanceText("passed")).toBe("格式通过");
    expect(artifactAcceptanceText("warning")).toBe("格式通过（有提示）");
    expect(artifactAcceptanceText(undefined)).toBe("未检查");
  });

  it("acceptanceSummaryText：状态 × runStatus 全组合一致", () => {
    const statuses: unknown[] = ["passed", "manual_review", "failed", "warning", undefined, null, "", 0];
    const runs: unknown[] = ["completed", "failed", "running", undefined, null, "", 0];
    for (const s of statuses) {
      for (const r of runs) {
        expect(acceptanceSummaryText(s, r)).toBe(server.acceptanceSummaryText(s, r));
      }
    }
    expect(acceptanceSummaryText("passed", "completed")).toBe("文件格式验收通过");
    expect(acceptanceSummaryText("passed", "failed")).toBe("文件格式验收通过 · 任务未成功结束");
    expect(acceptanceSummaryText("passed", "")).toBe("文件格式验收通过"); // 空串 falsy → 不加后缀
    expect(acceptanceSummaryText(undefined, "completed")).toBe("文件格式未检查");
    expect(acceptanceSummaryText("manual_review", "running")).toBe("文件格式待人工确认 · 任务未成功结束");
    expect(acceptanceSummaryText("failed", 0)).toBe("文件格式验收失败"); // 0 falsy → 不加后缀
  });

  it("artifactStatusInfo：各分支一致（含优先级与异型输入）", () => {
    const cases: Array<Parameters<typeof artifactStatusInfo>[0]> = [
      undefined,
      {},
      { publication: { version: 3 } },
      { publication: { version: 3 }, resultStatus: "failed" }, // publication 分支最优先
      { publication: 5 }, // 真值非对象 → vundefined
      { publication: "" }, // falsy → 走后续分支
      { result: { readyToPublish: true }, runStatus: "completed", resultStatus: "passed" },
      { result: { readyToPublish: true }, runStatus: "completed", resultStatus: undefined },
      { result: { readyToPublish: true }, runStatus: "failed" },
      { result: { readyToPublish: 1 }, runStatus: "running" },
      { result: { readyToPublish: "yes" }, runStatus: "completed" }, // 真值字符串同样视为 ready
      { result: { readyToPublish: false }, runStatus: "completed" },
      { resultStatus: "failed" },
      { resultStatus: "failed", result: { readyToPublish: true }, runStatus: "completed" }, // failed 优先于 ready
      { resultStatus: "accepted" },
      { resultStatus: "accepted", result: { readyToPublish: true }, runStatus: "completed" }, // failed > ready > accepted
      { result: null, runStatus: "completed" },
      { resultStatus: "" },
      { resultStatus: "not_checked", runStatus: "completed" },
    ];
    for (const c of cases) {
      expect(artifactStatusInfo(c)).toEqual(server.artifactStatusInfo(c));
    }
    expect(artifactStatusInfo()).toEqual({ label: "待验收", tone: "", hint: "尚未完成验收。", canPublish: false });
    expect(artifactStatusInfo({ publication: { version: 2 } }))
      .toEqual({ label: "v2 已固定", tone: "published", hint: "已固定为正式成果；如需替换请先回滚。", canPublish: false });
    expect(artifactStatusInfo({ result: { readyToPublish: true }, runStatus: "completed" }))
      .toEqual({ label: "待固定", tone: "ready", hint: "文件格式验收通过且任务已成功结束，可固定为正式成果。", canPublish: true });
    expect(artifactStatusInfo({ result: { readyToPublish: true }, runStatus: "failed" }))
      .toEqual({ label: "格式通过 · 任务未完成", tone: "warn", hint: "文件本身通过格式验收，但所属任务未成功结束，暂不可固定。", canPublish: false });
    expect(artifactStatusInfo({ result: { readyToPublish: true }, runStatus: "running" }))
      .toEqual({ label: "格式通过 · 任务未完成", tone: "warn", hint: "文件本身通过格式验收，但所属任务未成功结束，暂不可固定。", canPublish: false });
    expect(artifactStatusInfo({ resultStatus: "accepted" }))
      .toEqual({ label: "已人工确认", tone: "", hint: "已人工确认；固定为正式成果仍需格式验收通过。", canPublish: false });
  });

  it("artifactStatusInfo(null) 两侧同样抛错（解构 null）", () => {
    expect(() => artifactStatusInfo(null as never)).toThrow();
    expect(() => server.artifactStatusInfo(null as never)).toThrow();
  });
});
