/**
 * 记忆准入（B2-5，逐行等价迁移自 server/memory-admission.mjs）。
 *
 * 在候选进入待审核队列前执行确定性质量门槛：过短/超长/疑似敏感/临时环境状态/
 * Harness 内部实现/存疑前缀/其他工作区路径/与既有记忆重复。可解释硬规则第一道
 * 过滤，通过者仍需用户审核才能真正写入（approveMemoryProposal，memory-management 域）。
 *
 * 零依赖纯函数（无模块级状态、无 env 锚点、无文件 IO）。B2-5 起装配层
 * evaluateMemoryCandidate 由本模块直绑（旧过渡桥退役）；旧 .mjs 本体保留至域退役。
 */

const SENSITIVE_PATTERNS = [
  /(?:api[_-]?key|access[_-]?token|secret|bearer\s+[a-z0-9]|sk-[a-z0-9]{12,})/i,
  /(?:密码|凭据|私钥|身份证|银行卡|手机号|验证码)/,
];

// 短期环境状态：属于 Run/会话诊断，不进入长期记忆
const TEMPORARY_PATTERNS = [
  /当前环境/, /暂无网络/, /无外网/, /网络不可达/, /沙箱/, /权限不足/, /\bEPERM\b/i, /\bEACCES\b/i,
  /缓存为空/, /临时目录/, /本次会话/, /本轮任务/, /刚才/, /目前(?:看|只能|还不)/,
  /sharing violation/i, /install(?:ed)? failed/i,
];

// 与本项目无实体关联的内部实现细节
const HARNESS_INTERNAL_PATTERNS = [
  /\.oaw[\\/]/i, /memory-proposals\.json/i, /(?:SSE|EventSource)\s*(?:重连|游标|断线)/,
  /open[- ]plan\s*(?:项目|仓库|代码)/i,
];

const QUESTIONABLE_PREFIXES = [/^测试/, /^验证一下/, /^试了/];

/** 归一化文本：用于重复检测（空白、标点差异不算新内容）。 */
export function normalizeMemoryText(text = "") {
  return String(text || "")
    .replace(/\s+/g, "")
    .replace(/[，。；：、！？,.;:!?"'“”‘’()（）\[\]【】]/g, "")
    .toLowerCase();
}

/**
 * 评估一条记忆候选。
 * @returns {{ ok: boolean, code: string, reason: string }}
 */
export function evaluateMemoryCandidate({ content = "", category = "", workspace = "", existing = [] }: Record<string, any> = {}) {
  const text = String(content || "").trim();
  if (text.length < 6) {
    return { ok: false, code: "TOO_SHORT", reason: "内容过短，无法构成可复用事实" };
  }
  if (text.length > 220) {
    return { ok: false, code: "TOO_LONG", reason: "单条记忆须为原子事实（≤220 字），请拆分后重新提交" };
  }
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(text)) return { ok: false, code: "SENSITIVE", reason: "包含疑似凭据/敏感个人信息，禁止写入长期记忆" };
  }
  for (const pattern of TEMPORARY_PATTERNS) {
    if (pattern.test(text)) return { ok: false, code: "TEMPORARY", reason: "属于临时环境状态，应留在本轮 Run 诊断中，不具备长期价值" };
  }
  for (const pattern of HARNESS_INTERNAL_PATTERNS) {
    if (pattern.test(text)) return { ok: false, code: "HARNESS_INTERNAL", reason: "属于工具/运行时内部实现细节，升级后即失效" };
  }
  for (const pattern of QUESTIONABLE_PREFIXES) {
    if (pattern.test(text)) return { ok: false, code: "NOT_DURABLE", reason: "描述的是本次操作过程，不是稳定结论" };
  }
  // 项目边界：其他项目的路径/名称不应写入当前项目记忆
  const wsName = String(workspace || "").split(/[\\/]/).filter(Boolean).pop() || "";
  const otherProject = /([A-Za-z]:\\[^\s，。]{4,})/.exec(text)?.[1] || "";
  if (otherProject && wsName && !otherProject.toLowerCase().includes(wsName.toLowerCase()) && !normalizeMemoryText(workspace).includes(normalizeMemoryText(otherProject))) {
    return { ok: false, code: "OTHER_WORKSPACE", reason: `内容指向其他工作区（${otherProject}），与当前项目无实体关联` };
  }
  const normalized = normalizeMemoryText(text);
  const duplicate = (Array.isArray(existing) ? existing : []).find((item) => {
    const other = normalizeMemoryText(item?.content || item?.statement || "");
    if (!other) return false;
    return other === normalized || (normalized.length > 8 && (other.includes(normalized) || normalized.includes(other)));
  });
  if (duplicate) {
    return {
      ok: false,
      code: "DUPLICATE",
      reason: `与已有记忆重复或高度重叠：${String(duplicate.content || duplicate.statement || "").slice(0, 40)}…`,
    };
  }
  return { ok: true, code: "OK", reason: "" };
}
