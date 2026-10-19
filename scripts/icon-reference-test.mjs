#!/usr/bin/env node
/**
 * Icon 引用断言（P2 小项）：所有 <Icon name="..."/> 引用必须存在于 Icon.jsx 的图标表。
 *
 * 背景：Icon name 写错时运行期静默渲染空 SVG（不报错），只能靠肉眼发现。
 * 本脚本供 build 前跑（npm run prebuild 或 test:icons），断言失败退出码 1。
 *
 * 覆盖两类写法：
 *   <Icon name="loading" />            —— 字符串字面量
 *   <Icon name={x ? "a" : "b"} />      —— 表达式内的全部字符串字面量
 *
 * 运行：node scripts/icon-reference-test.mjs
 */
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const iconFile = path.join(root, "client", "src", "components", "Icon.jsx");

// 1) 收集图标表 key（Icon.jsx 内两空格缩进的 `key: (` 定义）
const iconSrc = fs.readFileSync(iconFile, "utf8");
const defined = new Set();
const duplicates = new Set();
for (const match of iconSrc.matchAll(/^[ ]{2}([A-Za-z][\w-]*): \(/gm)) {
  const key = match[1];
  if (defined.has(key)) duplicates.add(key);
  defined.add(key);
}
if (!defined.size) {
  console.error("✗ Icon.jsx 中没有解析到任何图标定义（正则与文件结构不符，请检查）");
  process.exit(1);
}

// 2) 扫描所有 JSX 对 Icon 的引用
function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.isFile() && /\.jsx$/.test(entry.name)) yield p;
  }
}

const usage = new Map(); // name → [file:line]
let files = 0;
let references = 0;
for (const file of walk(path.join(root, "client", "src"))) {
  files += 1;
  const src = fs.readFileSync(file, "utf8");
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    for (const match of lines[i].matchAll(/<Icon\b[^>]*?name=(?:"([\w-]+)"|\{([^}]*)\})/g)) {
      // {…} 表达式只取三元结果的字面量（?/: 之后）；比较分支里的字面量（=== "x"）不是图标名。
      const names = match[1] ? [match[1]] : [...String(match[2] || "").matchAll(/[?:]\s*"([\w-]+)"/g)].map((m) => m[1]);
      for (const name of names) {
        references += 1;
        if (!defined.has(name)) {
          const loc = `${path.relative(root, file)}:${i + 1}`;
          if (!usage.has(name)) usage.set(name, []);
          usage.get(name).push(loc);
        }
      }
    }
  }
}

// 3) 报告
console.log(`▶ Icon 断言：${defined.size} 个已定义图标 / ${files} 个 JSX 文件 / ${references} 处引用`);
if (duplicates.size) {
  console.error(`✗ Icon.jsx 存在重复定义：${[...duplicates].join("、")}`);
  process.exitCode = 1;
}
if (usage.size) {
  console.error("✗ 以下图标名未在 Icon.jsx 中定义（运行期会静默渲染空白）：");
  for (const [name, locs] of usage) {
    console.error(`    ${name} ← ${locs.slice(0, 3).join(", ")}${locs.length > 3 ? ` 等 ${locs.length} 处` : ""}`);
  }
  process.exitCode = 1;
} else {
  console.log("Icon 引用断言：通过（无未定义引用、无重复定义）");
}
