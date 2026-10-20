import { describe, it, expect } from "vitest";
import {
  TASK_MODES,
  normalizeTaskMode,
  modeLabel,
  modeDescription,
  toolPolicyForMode,
  planTaskCapabilities,
  createTaskEnvelope,
  taskSummary
} from "../src/shared/runtime/task";

const serverModule = await import("../../server/task.mjs");
const server = serverModule as unknown as typeof import("../src/shared/runtime/task");

describe("task TS 版与 server 版等价（对拍）", () => {
  it("模式常量与归一化矩阵一致", () => {
    expect([...TASK_MODES]).toEqual([...server.TASK_MODES]);
    const cases = ["agent", "CHAT", " office ", "review", "bogus", undefined, null, ""];
    for (const input of cases) {
      expect(normalizeTaskMode(input)).toBe(server.normalizeTaskMode(input));
      expect(modeLabel(input)).toBe(server.modeLabel(input));
      expect(modeDescription(input)).toBe(server.modeDescription(input));
      expect(toolPolicyForMode(input)).toEqual(server.toolPolicyForMode(input));
    }
  });

  it("toolPolicyForMode 四模式工具白名单一致", () => {
    for (const mode of ["chat", "office", "agent", "review"]) {
      expect(toolPolicyForMode(mode)).toEqual(server.toolPolicyForMode(mode));
    }
  });

  it("planTaskCapabilities 意图矩阵一致", () => {
    const cases: Parameters<typeof planTaskCapabilities>[0][] = [
      {},
      { text: "帮我看看这个地图图层的空间分析", task: { mode: "chat" } },
      { text: "修改文档 排版这份 报告.docx", task: { mode: "agent" } },
      { text: "生成一个word文档汇报", task: { mode: "agent" } },
      { text: "把 docx 里的表格整理一下", task: { mode: "chat" } },
      { text: "审查这份材料", task: { mode: "review" }, attachments: [{ name: "方案.docx" }, "notes.md"] },
      { text: "按 @工作流[OD分析] 执行", task: { mode: "agent", workflowId: "wf_od" } },
      { text: "检索一下知识库", task: { mode: "chat" }, references: [{ kind: "knowledge", target: "kb://a" }] },
      { text: "生成图纸", task: { mode: "agent", currentFile: "plans/maps/现状.geojson" } },
      { text: "导出成果", task: { mode: "office" }, references: [{ kind: "file", target: "d:/w/总结.xlsx" }] }
    ];
    for (const input of cases) {
      expect(planTaskCapabilities(input)).toEqual(server.planTaskCapabilities(input));
    }
  });

  it("createTaskEnvelope 字段与默认值一致（id/createdAt 模式校验）", () => {
    const full = {
      id: "task_x",
      text: "目标文本",
      mode: "chat",
      workflowId: "wf1",
      recoveryOf: "run1",
      recoveryAction: "resume",
      projectId: "p1",
      mapProject: "m1",
      agentProfile: "规划 Agent",
      projectSettings: { profilePolicy: { allowBash: false } },
      workspaceId: "w1",
      threadId: "t1",
      currentFile: "a.md",
      references: [{ id: "r1", kind: "file", target: "a.docx", status: "ok", extra: "dropped" }],
      constraints: ["c1"],
      output: { format: "docx", saveToWorkspace: true, requireSources: false },
      createdAt: "2026-01-01T00:00:00Z"
    };
    expect(createTaskEnvelope(full)).toEqual(server.createTaskEnvelope(full));
    // 空入参的 id/createdAt 由运行时生成（两侧调用必然不同），剥离后比较其余字段
    const stripGenerated = (envelope: Record<string, unknown>) => {
      const clone = { ...envelope };
      delete clone.id;
      delete clone.createdAt;
      return clone;
    };
    expect(stripGenerated(createTaskEnvelope({}) as unknown as Record<string, unknown>)).toEqual(stripGenerated(server.createTaskEnvelope({}) as unknown as Record<string, unknown>));
    const tsEnvelope = createTaskEnvelope({});
    expect(tsEnvelope.id).toMatch(/^task_[0-9a-f-]{36}$/);
    expect(typeof tsEnvelope.createdAt).toBe("string");
    expect(tsEnvelope.agentProfile).toBe("通用 Agent");
    const chatEnvelope = createTaskEnvelope({ mode: "chat" });
    expect(chatEnvelope.output.saveToWorkspace).toBe(false);
    expect(chatEnvelope.modeLabel).toBe("Chat");
    const fallback = createTaskEnvelope({ projectSettings: { profilePolicy: { x: 1 } } });
    expect(fallback.profilePolicy).toEqual({ x: 1 });
  });

  it("taskSummary 各形态一致", () => {
    expect(taskSummary(null)).toBe("");
    expect(taskSummary(undefined)).toBe("");
    const base = { goal: "做一张图", mode: "chat", modeLabel: "", workflowId: "wf1", currentFile: "a.md", mapProject: "m1", references: [{ id: "r1" }], capabilityPlan: { routing: { map: "read_only" } } };
    expect(taskSummary(base)).toBe(server.taskSummary(base));
    expect(taskSummary(base)).toContain("地图能力（只读）");
    expect(taskSummary(base)).toContain("引用：1 项");
    const rw = { ...base, mode: "agent", capabilityPlan: { routing: { map: "read_write" } } };
    expect(taskSummary(rw)).toBe(server.taskSummary(rw));
    expect(taskSummary(rw)).toContain("地图能力：");
    const none = { ...base, capabilityPlan: null };
    expect(taskSummary(none)).toBe(server.taskSummary(none));
    const chatBoundary = { mode: "chat", goal: "x" };
    expect(taskSummary(chatBoundary)).toBe(server.taskSummary(chatBoundary));
    expect(taskSummary(chatBoundary)).toContain("边界：只读检索");
  });
});
