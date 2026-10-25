/**
 * B2-6 file-permission-error 域对拍：normalizeWorkspaceWriteError / normalizeOfficeFailure /
 * workspaceWriteHttpStatus。
 *
 * 零依赖纯函数（无模块级状态、无 env 锚点、无文件 IO）→ 免 stubEnv/tmp 隔离（B2-5
 * 简化形态）：旧侧物理路径动态 import（pathToFileURL，与生产过渡桥同一加载形态）、
 * 新侧静态 import TS 模块；逐用例同入参双侧执行（输入对象只读、双侧共享安全），Error
 * 输出逐字段比对（message/code/cause/args——toEqual 对 Error 自定义属性语义有歧义，
 * 不做整对象比对），值输出直接 toEqual；并附绝对断言锚定语义（防双侧同漂）。
 */
import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as modern from "../src/main/backend/file-permission-error";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "../..");

const legacy = (await import(
  pathToFileURL(path.join(PROJECT_ROOT, "server", "file-permission-error.mjs")).href
)) as unknown as typeof modern;

/** Error 输出逐字段比对（旧新两侧）。 */
function compareErrors(oldOut: Error, newOut: Error): void {
  expect(newOut instanceof Error).toBe(true);
  expect(oldOut instanceof Error).toBe(true);
  expect(newOut.message).toBe(oldOut.message);
  expect((newOut as any).code).toBe((oldOut as any).code);
  expect((newOut as any).cause).toBe((oldOut as any).cause);
  expect((newOut as any).args).toEqual((oldOut as any).args);
}

describe("B2-6 对拍：normalizeWorkspaceWriteError", () => {
  /** 双侧同入参执行 + 逐字段比对，返回新侧结果。 */
  function both(error: any, fallbackMessage?: string) {
    const oldOut = fallbackMessage === undefined
      ? legacy.normalizeWorkspaceWriteError(error)
      : legacy.normalizeWorkspaceWriteError(error, fallbackMessage);
    const newOut = fallbackMessage === undefined
      ? modern.normalizeWorkspaceWriteError(error)
      : modern.normalizeWorkspaceWriteError(error, fallbackMessage);
    compareErrors(oldOut, newOut);
    return newOut as Error & { code?: string; cause?: string };
  }

  it("EBUSY code（含小写归一）→ OFFICE_DOCUMENT_LOCKED + cause + 400 截断", () => {
    for (const code of ["EBUSY", "ebusy"]) {
      expect(both({ code, message: "写入冲突" }).code).toBe("OFFICE_DOCUMENT_LOCKED");
    }
    const longRaw = "长".repeat(500);
    const out = both({ code: "EBUSY", message: longRaw });
    expect(out.message).toContain(longRaw.slice(0, 400));
    expect(out.message).not.toContain(longRaw.slice(0, 401));
    expect(out.cause).toBe(longRaw);
  });

  it("LOCKED_FILE_PATTERN 消息族（sharing violation/another process/占用/锁定）", () => {
    for (const message of [
      "delete failed: sharing violation",
      "file is used by another process",
      "目标文件被另一个进程锁定",
      "文件正被占用，无法写入",
      "error_sharing_violation 32",
    ]) {
      expect(both(new Error(message)).code).toBe("OFFICE_DOCUMENT_LOCKED");
    }
    expect(both(new Error("sharing violation")).message).toContain("目标文件正被其他程序占用");
  });

  it("EPERM/EACCES code → WORKSPACE_PERMISSION_DENIED", () => {
    for (const code of ["EPERM", "EACCES"]) {
      expect(both({ code, message: "写失败" }).code).toBe("WORKSPACE_PERMISSION_DENIED");
    }
    expect(both(new Error("权限不足")).message).toContain("操作系统拒绝了当前规聚服务进程对目标的写操作");
  });

  it("PERMISSION_PATTERN 消息族（permission denied/access denied/拒绝访问/没有权限）", () => {
    for (const message of [
      "operation not permitted",
      "open EACCES: permission denied",
      "access to the path D:\\x is denied",
      "Access to the file was denied",
      "拒绝访问目标目录",
      "没有权限写入该文件",
    ]) {
      expect(both(new Error(message)).code).toBe("WORKSPACE_PERMISSION_DENIED");
    }
  });

  it("无码无匹配的 Error 原样返回（同一引用）", () => {
    const input = new Error("普通业务失败");
    const oldOut = legacy.normalizeWorkspaceWriteError(input);
    const newOut = modern.normalizeWorkspaceWriteError(input);
    expect(oldOut).toBe(input);
    expect(newOut).toBe(input);
  });

  it("字符串/对象 error → WORKSPACE_FILE_OPERATION_FAILED 包装；fallbackMessage 默认与自定义", () => {
    expect(both("字符串失败").code).toBe("WORKSPACE_FILE_OPERATION_FAILED");
    expect(both("字符串失败").message).toBe("字符串失败");
    expect(both(null).message).toBe("工作区文件操作失败");
    expect(both(null, "自定义兜底").message).toBe("自定义兜底");
    expect(both(undefined, "自定义兜底").code).toBe("WORKSPACE_FILE_OPERATION_FAILED");
    expect(both({}).message).toBe("[object Object]");
  });
});

describe("B2-6 对拍：normalizeOfficeFailure", () => {
  /** 双侧同入参执行 + 逐字段比对，返回新侧结果。 */
  function both(error?: any, args?: any[], result?: any) {
    const oldOut = legacy.normalizeOfficeFailure(error, args, result);
    const newOut = modern.normalizeOfficeFailure(error, args, result);
    compareErrors(oldOut, newOut);
    return newOut as Error & { code?: string; args?: string[] };
  }

  it("多源消息聚合去重 + OFFICECLI_FAILED 兜底 + args 透传", () => {
    const out = both(
      new Error("第一步失败"),
      ["a.docx", "out/"],
      { stderr: "第一步失败", text: "第二步失败", json: { detail: "第三步失败" } },
    );
    expect(out.code).toBe("OFFICECLI_FAILED");
    expect(out.message).toBe("第一步失败\n第二步失败\n第三步失败");
    expect((out as any).args).toEqual(["a.docx", "out/"]);
  });

  it("JSON 字符串解析：message 为 JSON 时提取内层 error 与 code（EACCES → WORKSPACE_PERMISSION_DENIED + args）", () => {
    const out = both(new Error('{"error":"内层失败消息","code":"EACCES"}'), ["f.docx"]);
    expect(out.code).toBe("WORKSPACE_PERMISSION_DENIED");
    expect(out.message).toContain("内层失败消息");
    expect((out as any).args).toEqual(["f.docx"]);
  });

  it("codes 提取：result.json 携带 EBUSY → OFFICE_DOCUMENT_LOCKED", () => {
    const out = both(new Error("保存失败"), [], { json: { code: "EBUSY" } });
    expect(out.code).toBe("OFFICE_DOCUMENT_LOCKED");
    expect((out as any).args).toEqual([]);
  });

  it("error.code 优先透传：非匹配码时返回原 error（同一引用）", () => {
    const input = new Error("自定义域失败") as Error & { code?: string };
    input.code = "CUSTOM_CODE";
    const oldOut = legacy.normalizeOfficeFailure(input, []);
    const newOut = modern.normalizeOfficeFailure(input, []);
    expect(oldOut).toBe(input);
    expect(newOut).toBe(input);
  });

  it("args 截断 8；空输入兜底 OFFICECLI_FAILED；result.json.results 数组 32 条上限", () => {
    expect(((both(new Error("x"), Array.from({ length: 10 }, (_, i) => `arg${i}`)) as any).args)).toHaveLength(8);
    const empty = both();
    expect(empty.code).toBe("OFFICECLI_FAILED");
    expect(empty.message).toBe("Office CLI 执行失败");
    expect((empty as any).args).toEqual([]);
    const capped = both(undefined, [], { json: { results: Array.from({ length: 40 }, (_, i) => `消息${i + 1}`) } });
    expect(capped.message).toContain("消息32");
    expect(capped.message).not.toContain("消息33");
  });

  it("深度截断：嵌套 data 链字符串条目 depth 8 仍收集、depth 9 停止", () => {
    // collect 入口为 error.message（对象在 depth n，其内字符串在 depth n+1）
    let deep7: any = { message: "边界层数据" };
    for (let i = 0; i < 7; i++) deep7 = { data: deep7 };
    expect(both({ message: deep7 }).message).toContain("边界层数据");
    let deep8: any = { message: "超层数据" };
    for (let i = 0; i < 8; i++) deep8 = { data: deep8 };
    expect(both({ message: deep8 }).message).not.toContain("超层数据");
  });
});

describe("B2-6 对拍：workspaceWriteHttpStatus", () => {
  it("全码映射族 + 兜底 500（双侧一致 + 绝对断言）", () => {
    const cases: Array<[string | null | undefined, number]> = [
      ["WRITE_CONFLICT", 409],
      ["OFFICE_DOCUMENT_LOCKED", 409],
      ["WRITE_SCOPE_ERROR", 400],
      ["WORKSPACE_INVALID", 400],
      ["MEMORY_WRITE_REQUIRES_PROPOSAL", 400],
      ["WORKSPACE_PERMISSION_DENIED", 403],
      ["EPERM", 403],
      ["EACCES", 403],
      ["WORKSPACE_WRITE_UNAVAILABLE", 503],
      ["UNKNOWN_CODE", 500],
      [null, 500],
      [undefined, 500],
    ];
    for (const [code, expected] of cases) {
      const input = code === null || code === undefined ? code : { code };
      expect(modern.workspaceWriteHttpStatus(input)).toBe(legacy.workspaceWriteHttpStatus(input));
      expect(modern.workspaceWriteHttpStatus(input)).toBe(expected);
    }
  });
});
