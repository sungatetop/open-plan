/**
 * officecli 工具参数处理（B2-7，逐行等价迁移自 server/office-params.mjs）。
 *
 * 这些细节都踩过坑——模型照抄说明里的转义引号会被切坏、暂存文件引用写成 key=value
 * 时物化不出来、officecli 不会创建输出目录。
 *
 * parseOfficeArgs/collectReferencedPaths 零 IO；ensureOfficeOutputDirs 按需在
 * workspace 内 mkdirSync（无模块级状态、无 env 锚点）。B2-7 起装配层 parseArgs/
 * collectReferencedPaths/ensureOfficeOutputDirs 三键由本模块直绑（旧过渡桥退役）；
 * 旧 .mjs 本体保留至域退役。
 */
import fs from "node:fs";
import path from "node:path";

// 模型经常照抄说明里的转义写法（--prop author=\"规聚 Agent\"）。普通正则分词会把
// author=\"规聚 和 Agent\" 切成两个 token，officecli 就报 Invalid --prop 'Agent"': expected key=value
//（实测发生过）。这里手写分词：普通引号与反斜杠转义引号都当引号分隔符，且丢掉多余的反斜杠。
export function parseOfficeArgs(input: any): string[] {
  const text = String(input || "");
  const args: string[] = [];
  let current = "";
  let quote: string | null = null;
  let started = false;
  const flush = (): void => {
    if (started) args.push(current);
    current = "";
    started = false;
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (ch === "\\" && (next === '"' || next === "'")) {
      if (quote === next) quote = null;
      else if (!quote) { quote = next; started = true; }
      else current += next;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (quote === ch) quote = null;
      else if (!quote) { quote = ch; started = true; }
      else current += ch;
      continue;
    }
    if (!quote && /\s/.test(ch)) { flush(); continue; }
    current += ch;
    started = true;
  }
  flush();
  return joinPropValues(args);
}

// 模型也常把带空格的 prop 值裸写（--prop author=规聚 Agent，不加引号）。
// officecli 的一个 --prop 只吃一个参数，被空格切开就会报 Invalid --prop 'Agent': expected key=value（实测发生过）。
// 这里把 --prop 之后"不像新选项、也不像 key=value"的 token 并回同一个值。
function joinPropValues(args: any[] = []): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = String(args[i]);
    if (token !== "--prop" || i + 1 >= args.length) { out.push(args[i]); continue; }
    let value = String(args[i + 1]);
    i += 1;
    while (i + 1 < args.length) {
      const next = String(args[i + 1]);
      if (next.startsWith("-") || next.includes("=")) break;
      value += ` ${next}`;
      i += 1;
    }
    out.push(token, value);
  }
  return out;
}

// 参数里引用的文件可能写成 key=value（--prop src=报告.md、--prop path=数据.json），
// 也可能带引号残留。先剥掉 key= 前缀再判断，否则物化时会去找一个叫 "src=报告.md" 的路径，
// 暂存文件永远物化不出来，officecli 报 "markdown source file not found"（实测发生过）。
export function collectReferencedPaths(args: any[] = []): string[] {
  const out: string[] = [];
  const stripKey = (value: any): string => {
    const text = String(value || "").trim();
    const match = text.match(/^[A-Za-z_][A-Za-z0-9_-]{0,24}=(.+)$/);
    return match ? match[1]!.trim() : text;
  };
  const looksLikePath = (value: any): boolean => {
    const text = stripKey(value);
    if (!text || text.startsWith("-") || text.startsWith("/") || /^[A-Za-z]:[\\/]/.test(text)) return false;
    return /\.(docx|xlsx|pptx|json|md|markdown|txt|csv|xml|html|png|jpe?g|pbf)$/i.test(text);
  };
  (Array.isArray(args) ? args : []).forEach((token: any, index: number) => {
    if (String(token) === "--input") {
      const next = args[index + 1];
      if (next) out.push(stripKey(next));
      return;
    }
    if (looksLikePath(token)) out.push(stripKey(token));
  });
  return [...new Set(out)];
}

// officecli 不会创建输出目录（实测：-o .work/review.html 报 Could not find a part of the path）。
// 调用前按 -o/--output 的目标把父目录建好，避免"目录不存在"这种无意义的失败。
export function ensureOfficeOutputDirs(args: any[] = [], workspace = ""): string[] {
  const created: string[] = [];
  const list = Array.isArray(args) ? args : [];
  for (let index = 0; index < list.length; index += 1) {
    const token = String(list[index]);
    let target = "";
    if (token === "-o" || token === "--output") target = String(list[index + 1] || "");
    else if (token.startsWith("--output=")) target = token.slice("--output=".length);
    if (!target) continue;
    const text = target.trim();
    if (!text || text.startsWith("/") || /^[A-Za-z]:[\\/]/.test(text) || text.includes("..")) continue;
    const root = path.resolve(workspace);
    const dir = path.dirname(path.resolve(root, text));
    if (dir !== root && !dir.startsWith(root + path.sep)) continue;
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        created.push(path.relative(root, dir).replace(/\\/g, "/"));
      }
    } catch {}
  }
  return created;
}
