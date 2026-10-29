/**
 * B2-6 file-permission-error 域：normalizeWorkspaceWriteError / normalizeOfficeFailure /
 * workspaceWriteHttpStatus。
 *
 * R6-7a 对拍退役改写：旧侧 server/file-permission-error.mjs 物理路径动态 import
 * （pathToFileURL）随 server/ 退役删除（等价性已在 B2-6 批对拍验收冻结），仅保留
 * modern 静态 import src/main/backend/file-permission-error.ts 的同一套绝对断言。
 * 零依赖纯函数（无模块级状态、无 env 锚点、无文件 IO）→ 免 stubEnv/tmp 隔离（B2-5
 * 简化形态）。
 */
import { describe, expect, it } from "vitest";
import * as modern from "../src/main/backend/file-permission-error";

describe("B2-6 file-permission-error：normalizeWorkspaceWriteError", () => {
  /** 同入参单侧执行，返回结果。 */
  function both(error: any, fallbackMessage?: string) {
    return (fallbackMessage === undefined
      ? modern.normalizeWorkspaceWriteError(error)
      : modern.normalizeWorkspaceWriteError(error, fallbackMessage)) as Error & { code?: string; cause?: string };
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
    expect(modern.normalizeWorkspaceWriteError(input)).toBe(input);
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

describe("B2-6 file-permission-error：normalizeOfficeFailure", () => {
  /** 同入参单侧执行，返回结果。 */
  function both(error?: any, args?: any[], result?: any) {
    return modern.normalizeOfficeFailure(error, args, result) as Error & { code?: string; args?: string[] };
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
    expect(modern.normalizeOfficeFailure(input, [])).toBe(input);
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

describe("B2-6 file-permission-error：workspaceWriteHttpStatus", () => {
  it("全码映射族 + 兜底 500（绝对断言）", () => {
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
      expect(modern.workspaceWriteHttpStatus(input)).toBe(expected);
    }
  });
});
