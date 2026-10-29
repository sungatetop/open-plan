/**
 * B2-5 memory-admission 域：evaluateMemoryCandidate / normalizeMemoryText。
 *
 * R6-7a 对拍退役改写：旧侧 server/memory-admission.mjs 物理路径动态 import
 * （pathToFileURL）随 server/ 退役删除（等价性已在 B2-5 批对拍验收冻结），仅保留
 * modern 静态 import src/main/backend/memory-admission.ts 的同一套绝对断言。
 * 零依赖纯函数（无模块级状态、无 env 锚点、无文件 IO）→ 无需 stubEnv/tmp 隔离。
 */
import { describe, expect, it } from "vitest";
import * as modern from "../src/main/backend/memory-admission";

interface EvalResult {
  ok: boolean;
  code: string;
  reason: string;
}

/** 同入参单侧执行，返回结果供断言。 */
function evaluate(input?: Record<string, any>): EvalResult {
  return modern.evaluateMemoryCandidate(input);
}

describe("B2-5 memory-admission：normalizeMemoryText", () => {
  it("归一族：空白/标点移除 + 小写归一（绝对断言）", () => {
    const samples = [
      "修复了 登录页面的，焦点丢失问题！",
      "  Fix\tBUG\nTEST  ",
      "ABC_def-ghi（括号）【方】\"引号\"",
      "多行\n\n文本\t混合   空白",
      "",
    ];
    expect(modern.normalizeMemoryText(samples[0])).toBe("修复了登录页面的焦点丢失问题");
    expect(modern.normalizeMemoryText(samples[1])).toBe("fixbugtest");
    for (const sample of samples.slice(2)) {
      expect(typeof modern.normalizeMemoryText(sample)).toBe("string");
    }
    expect(modern.normalizeMemoryText()).toBe("");
  });
});

describe("B2-5 memory-admission：长度门槛（TOO_SHORT/TOO_LONG）", () => {
  it("TOO_SHORT：5/6 字符边界 + 无参默认", () => {
    expect(evaluate({ content: "abcde" }).code).toBe("TOO_SHORT");
    expect(evaluate({ content: "abcdef" }).code).toBe("OK");
    expect(evaluate()).toEqual({ ok: false, code: "TOO_SHORT", reason: "内容过短，无法构成可复用事实" });
    expect(evaluate({ content: "abcde" }).reason).toBe("内容过短，无法构成可复用事实");
  });

  it("TOO_LONG：220/221 字符边界", () => {
    expect(evaluate({ content: "a".repeat(220) }).code).toBe("OK");
    const tooLong = evaluate({ content: "a".repeat(221) });
    expect(tooLong.code).toBe("TOO_LONG");
    expect(tooLong.ok).toBe(false);
    expect(tooLong.reason).toBe("单条记忆须为原子事实（≤220 字），请拆分后重新提交");
  });
});

describe("B2-5 memory-admission：SENSITIVE 门槛", () => {
  it("凭据族：api_key / sk- / bearer / access_token / secret", () => {
    for (const content of [
      "配置了 api_key=xxxxxxxx 存入环境",
      "密钥 sk-abcdefghijkl（12 位以上）",
      "请求头带 bearer abc123 凭证",
      "access_token 过期需要刷新",
      "secret 存放在配置文件里",
    ]) {
      expect(evaluate({ content }).code).toBe("SENSITIVE");
    }
  });

  it("敏感个人信息族：密码/身份证/银行卡/手机号/验证码", () => {
    for (const content of [
      "用户的密码需要加密存储",
      "身份证号不能写入日志",
      "银行卡余额查询接口",
      "手机号用于登录验证",
      "输入验证码完成注册",
    ]) {
      expect(evaluate({ content }).code).toBe("SENSITIVE");
    }
    expect(evaluate({ content: "配置了 api_key=xxx，且属于当前环境的临时状态" }).code).toBe("SENSITIVE");
  });
});

describe("B2-5 memory-admission：TEMPORARY 门槛", () => {
  it("短期环境状态族（绝对断言）", () => {
    for (const content of [
      "当前环境缺少构建工具",
      "无外网导致依赖安装失败",
      "写入日志报 EPERM 错误",
      "文件被占用 sharing violation",
      "installed failed 需要重试",
      "刚才的命令执行超时",
    ]) {
      expect(evaluate({ content }).code).toBe("TEMPORARY");
    }
    expect(evaluate({ content: "当前环境缺少构建工具，同时涉及 .oaw\\ 目录" }).code).toBe("TEMPORARY");
  });
});

describe("B2-5 memory-admission：HARNESS_INTERNAL 门槛", () => {
  it("内部实现细节族", () => {
    for (const content of [
      "写入 .oaw\\memory-proposals 的流程",
      "memory-proposals.json 的结构变更",
      "SSE 重连游标需要持久化",
      "EventSource 断线后自动恢复",
      "open-plan 项目的构建脚本",
      "open plan 仓库的目录约定",
    ]) {
      expect(evaluate({ content }).code).toBe("HARNESS_INTERNAL");
    }
  });

  it("门槛顺序：HARNESS_INTERNAL 先于 NOT_DURABLE", () => {
    expect(evaluate({ content: "测试 .oaw\\ 目录写入" }).code).toBe("HARNESS_INTERNAL");
  });
});

describe("B2-5 memory-admission：NOT_DURABLE 门槛", () => {
  it("存疑前缀族", () => {
    for (const content of [
      "测试通过了全部用例",
      "验证一下导出功能",
      "试了三种参数组合",
    ]) {
      expect(evaluate({ content }).code).toBe("NOT_DURABLE");
    }
    expect(evaluate({ content: "回归测试覆盖了导出功能" }).code).toBe("OK");
  });
});

describe("B2-5 memory-admission：OTHER_WORKSPACE 门槛", () => {
  it("触发：盘符路径指向其他工作区", () => {
    const result = evaluate({ content: "改动落在 D:\\other-proj\\src 目录", workspace: "d:\\open-plan" });
    expect(result.code).toBe("OTHER_WORKSPACE");
    expect(result.reason).toBe("内容指向其他工作区（D:\\other-proj\\src），与当前项目无实体关联");
  });

  it("不触发：workspace 为空 / 路径含当前工作区名 / 盘符后不足 4 字符", () => {
    expect(evaluate({ content: "改动落在 D:\\other-proj\\src 目录", workspace: "" }).code).toBe("OK");
    expect(evaluate({ content: "改动落在 D:\\open-plan\\server 目录", workspace: "d:\\open-plan" }).code).toBe("OK");
    expect(evaluate({ content: "在 D:\\ab 目录下操作", workspace: "d:\\open-plan" }).code).toBe("OK");
  });

  it("不触发：normalizeMemoryText 兜底（workspace 归一后包含路径）", () => {
    // wsName="more" 不在路径中，但 workspace 归一串包含 otherProject 归一串 → 兜底放行
    expect(evaluate({ content: "数据在 E:\\proj\\x 下", workspace: "E:\\proj\\x\\more" }).code).toBe("OK");
  });
});

describe("B2-5 memory-admission：DUPLICATE 门槛", () => {
  it("归一全等：空白/标点差异不算新内容", () => {
    const result = evaluate({
      content: "修复了 登录页面的，焦点丢失问题！",
      existing: [{ content: "修复了登录页面的焦点丢失问题" }],
    });
    expect(result.code).toBe("DUPLICATE");
    expect(result.reason).toBe("与已有记忆重复或高度重叠：修复了登录页面的焦点丢失问题…");
  });

  it("包含重叠（双向）：仅归一后 >8 字符才启用", () => {
    // 超集方向：existing 包含候选
    expect(evaluate({
      content: "桌面端重构采用绞杀者模式分域推进",
      existing: [{ content: "桌面端重构采用绞杀者模式分域推进策略与验收口径" }],
    }).code).toBe("DUPLICATE");
    // 子集方向（statement 字段）：候选包含 existing
    expect(evaluate({
      content: "桌面端重构采用绞杀者模式分域推进的完整策略",
      existing: [{ statement: "桌面端重构采用绞杀者模式分域推进" }],
    }).code).toBe("DUPLICATE");
    // 8 字符边界：不启用重叠判定
    expect(evaluate({ content: "abcdefgh", existing: [{ content: "abcdefghij" }] }).code).toBe("OK");
  });

  it("existing 防御：非数组 / item 缺字段 / 归一为空均跳过", () => {
    expect(evaluate({ content: "完成了 B2-5 批次的全部验收工作", existing: "not-array" }).code).toBe("OK");
    expect(evaluate({ content: "完成了 B2-5 批次的全部验收工作", existing: [{}, { content: "" }, { statement: null }] }).code).toBe("OK");
  });

  it("reason 截断：既有内容超 40 字符截取前 40 位", () => {
    const longText = "桌面端重构采用绞杀者模式分域推进策略并且这一条内容足够长超过了四十个字符的阈值用于验证截断行为";
    const result = evaluate({ content: longText.slice(0, 20), existing: [{ content: longText }] });
    expect(result.code).toBe("DUPLICATE");
    expect(result.reason).toBe(`与已有记忆重复或高度重叠：${longText.slice(0, 40)}…`);
  });
});

describe("B2-5 memory-admission：OK 通过与未使用形参", () => {
  it("普通合规内容 OK；category 形参不影响判定", () => {
    const content = "完成了 B2-5 批次的全部验收工作";
    expect(evaluate({ content, category: "lesson", workspace: "d:\\open-plan", existing: [] })).toEqual({
      ok: true,
      code: "OK",
      reason: "",
    });
    expect(evaluate({ content, category: "insight" }).code).toBe("OK");
  });
});
