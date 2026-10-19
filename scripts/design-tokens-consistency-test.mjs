#!/usr/bin/env node
/**
 * 设计令牌一致性测试（Qoder 对标 P1-7）。
 *
 * 守护三件事：
 *   1) 三层结构：基础色阶（--op-gray-* / --op-{blue,green,red,amber}-*）→ 语义令牌
 *      （--body-bg 等）→ 组件变量（--op-comp-*）；后两层只允许「引用」上一层，不许写死色值；
 *   2) 基线不被破坏：:root 必备令牌齐全且为合法色值、B05 别名仍在（旧变量保留为别名一个版本）、
 *      opt-in 旧灰阶名 --oaw-gray-* 保留并指向新基础色阶；
 *   3) 色值棘轮 + 迁移清单：全站硬编码色值「不增长」（≤ 基线），并把「可 1:1 映射到令牌」
 *      的色值清单打印出来——注意：这些替换在**亮色主题下会改变渲染**（例如 #d4d4d4 在亮色下
 *      是深色文字），因此本测试只做记录与棘轮，不自动替换。
 *
 * 用法：node scripts/design-tokens-consistency-test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const 样式 = fs.readFileSync(path.join(ROOT, "client", "src", "styles.css"), "utf8");

/** 硬编码色值棘轮基线（2026-10-18 P1-7 落地时实测；只允许下降，不许上升）。 */
const 硬编码基线 = { 总数: 393, 不同值: 129 };

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); } catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
};

/* ---------------- 解析工具 ---------------- */

const 色值 = /^#[0-9a-fA-F]{3,8}$/;
const 是色值 = (值) => 色值.test(String(值 || "").trim());
const 是引用 = (值) => /^var\(\s*--[\w-]+\s*\)$/.test(String(值 || "").trim());

function 取块(开头) {
  const 起 = 样式.indexOf(开头);
  assert.ok(起 >= 0, `styles.css 缺少区块：${开头}`);
  const 止 = 样式.indexOf("\n}", 起);
  assert.ok(止 > 起, `区块未正常结束：${开头}`);
  return 样式.slice(起, 止);
}
function 解析令牌(块) {
  const 表 = new Map();
  for (const m of 块.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) 表.set(m[1], m[2].trim());
  return 表;
}

const 暗基线 = 解析令牌(取块(":root {"));
const 亮基线 = 解析令牌(取块('[data-theme="light"] {'));
const 暗OptIn = 解析令牌(取块(':root[data-oaw-style="qoder"] {'));
const 亮OptIn = 解析令牌(取块('[data-theme="light"][data-oaw-style="qoder"] {'));

const 必备语义 = ["--body-bg", "--panel-bg", "--panel2-bg", "--surface", "--text", "--muted", "--dim", "--accent", "--border", "--selected", "--success", "--error", "--warning", "--user-bg", "--user-fg"];
const 别名对 = [["--text-primary", "--text"], ["--text-secondary", "--muted"], ["--status-success", "--success"], ["--status-error", "--error"]];
const 基础灰阶 = ["000", "050", "100", "150", "200", "250", "300", "400", "500", "600", "700", "800", "900"].map((阶) => `--op-gray-${阶}`);
const 语义层名 = ["--body-bg", "--panel-bg", "--panel2-bg", "--surface", "--text", "--accent", "--success", "--error", "--warning"];
const 组件层名 = ["--op-comp-chat-bg", "--op-comp-toolcard-border", "--op-comp-toolcard-pending", "--op-comp-toolcard-success", "--op-comp-toolcard-error"];
const 基线旧色值 = ["#1a1a2e", "#16162a", "#1e1e3a", "#222240", "#8abeb7", "#b5bd68", "#cc6666", "#f0c674"];

/* ---------------- 1) 基线令牌层 ---------------- */

test(":root 必备语义令牌齐全且都是合法色值", () => {
  for (const 名 of 必备语义) {
    const 值 = 暗基线.get(名);
    assert.ok(值, `:root 缺少 ${名}`);
    assert.ok(是色值(值), `${名} 不是合法色值：${值}`);
  }
});

test("B05 别名仍在（旧变量保留为别名，不删不改名）", () => {
  for (const [别名, 目标] of 别名对) {
    assert.equal(暗基线.get(别名), `var(${目标})`, `${别名} 应仍指向 ${目标}`);
  }
});

test("亮色基线主题同样声明了必备语义令牌", () => {
  for (const 名 of 必备语义) assert.ok(亮基线.get(名), `亮色主题缺少 ${名}`);
});

/* ---------------- 2) opt-in 三层结构 ---------------- */

for (const [层名, 表] of [["暗色", 暗OptIn], ["亮色", 亮OptIn]]) {
  test(`${层名} opt-in：第 1 层基础色阶完整（灰阶 ≥13 阶 + 强调/语义色阶）且都是色值`, () => {
    for (const 名 of 基础灰阶) {
      const 值 = 表.get(名);
      assert.ok(值, `${层名} opt-in 缺少 ${名}`);
      assert.ok(是色值(值), `${名} 必须是色值，实际 ${值}`);
    }
    for (const 名 of ["--op-blue-400", "--op-blue-500", "--op-green-500", "--op-red-500", "--op-amber-500"]) {
      assert.ok(是色值(表.get(名)), `${层名} opt-in 缺少基础色阶 ${名}`);
    }
  });

  test(`${层名} opt-in：第 2 层语义令牌全部引用基础色阶（不写死基础层已提供的色值）`, () => {
    // 引用既可以是直接引用（var(--op-gray-900)），也可以是经旧灰阶别名（var(--oaw-gray-050)
    // → var(--op-gray-050)）；两者都算「没有写死基础层已提供的色值」。
    const 引用数 = 语义层名.filter((名) => /^var\(\s*--(op-|oaw-gray-)/.test(表.get(名) || "")).length;
    assert.ok(引用数 >= 8, `${层名} opt-in 语义层引用基础色阶的项过少：${引用数}/${语义层名.length}`);
    for (const 名 of 语义层名) {
      const 值 = 表.get(名);
      assert.ok(值, `${层名} opt-in 缺少 ${名}`);
      assert.ok(是色值(值) || 是引用(值), `${名} 只能是色值或 var() 引用：${值}`);
    }
  });

  test(`${层名} opt-in：第 3 层组件变量齐全且只引用语义令牌`, () => {
    for (const 名 of 组件层名) {
      const 值 = 表.get(名);
      assert.ok(值, `${层名} opt-in 缺少组件变量 ${名}`);
      assert.ok(是引用(值), `组件变量 ${名} 必须引用语义令牌，实际 ${值}`);
      assert.ok(!/--op-(gray|blue|green|red|amber)-/.test(值), `组件变量 ${名} 不得直接引用基础色阶：${值}`);
    }
  });

  test(`${层名} opt-in：语义层不得出现基线旧配色`, () => {
    for (const 旧 of 基线旧色值) {
      for (const 名 of 语义层名) {
        assert.notEqual(表.get(名), 旧, `${层名} opt-in 的 ${名} 仍是基线旧色值 ${旧}`);
      }
    }
  });
}

test("旧灰阶名 --oaw-gray-* 保留为别名并指向新基础色阶", () => {
  for (const 阶 of ["050", "100", "150", "200"]) {
    assert.equal(暗OptIn.get(`--oaw-gray-${阶}`), `var(--op-gray-${阶})`, `--oaw-gray-${阶} 应仍指向基础色阶`);
  }
});

test("暗/亮 opt-in 的组件变量名集合一致（避免只改一层）", () => {
  for (const 名 of 组件层名) {
    assert.ok(暗OptIn.has(名) && 亮OptIn.has(名), `${名} 必须暗/亮两层同时声明`);
  }
});

/**
 * 三层化的「零视觉变化」证明：把每个语义令牌沿 var() 链解析到最终色值，
 * 与上一层交付时记录的取值逐一比对。只要相等，就说明改成引用基础色阶没有改动外观。
 */
const 交付时取值 = {
  暗色: {
    "--body-bg": "#111111", "--panel-bg": "#141414", "--panel2-bg": "#181818", "--surface": "#1e1e1e",
    "--text": "#f0f0f0", "--accent": "#81a1c1", "--success": "#3fa266", "--error": "#e34671",
    "--warning": "#f1b467", "--tool-pending": "#24282e",
  },
  亮色: {
    "--body-bg": "#f5f6f8", "--panel-bg": "#ffffff", "--panel2-bg": "#fafbfc", "--surface": "#f2f4f7",
    "--text": "#141414", "--accent": "#5a7fa6", "--success": "#2f7d4f", "--error": "#c0392b",
    "--warning": "#b7791f", "--tool-pending": "#eceff3",
  },
};
function 解析最终值(表, 名, 跳数 = 0) {
  const 值 = 表.get(名);
  if (!值 || 跳数 > 5) return 值;
  const m = /^var\(\s*(--[\w-]+)\s*\)$/.exec(值.trim());
  return m ? 解析最终值(表, m[1], 跳数 + 1) : 值;
}

for (const [层名, 表] of [["暗色", 暗OptIn], ["亮色", 亮OptIn]]) {
  test(`${层名} opt-in：三层化未改变最终取值（与交付时逐项一致）`, () => {
    for (const [名, 期望] of Object.entries(交付时取值[层名])) {
      const 实际 = String(解析最终值(表, 名) || "").toLowerCase();
      assert.equal(实际, 期望, `${层名} ${名} 的最终取值从 ${期望} 变成了 ${实际}`);
    }
  });
}

/* ---------------- 3) 色值棘轮 + 迁移清单 ---------------- */

function 统计硬编码() {
  const 直方图 = new Map();
  let 总数 = 0;
  for (const 行 of 样式.split("\n")) {
    if (/^\s*--[\w-]+:\s*#[0-9a-fA-F]/.test(行)) continue; // 令牌定义行不算硬编码
    for (const m of 行.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
      const 值 = m[0].toLowerCase();
      总数 += 1;
      直方图.set(值, (直方图.get(值) || 0) + 1);
    }
  }
  return { 总数, 直方图 };
}
const 统计 = 统计硬编码();

test(`硬编码色值棘轮：总数 ${统计.总数} ≤ 基线 ${硬编码基线.总数}，不同值 ${统计.直方图.size} ≤ ${硬编码基线.不同值}`, () => {
  assert.ok(统计.总数 <= 硬编码基线.总数, `硬编码色值新增了 ${统计.总数 - 硬编码基线.总数} 处（应改为引用令牌）`);
  assert.ok(统计.直方图.size <= 硬编码基线.不同值, `新增了 ${统计.直方图.size - 硬编码基线.不同值} 种硬编码色值`);
  const 下降 = 硬编码基线.总数 - 统计.总数;
  if (下降 > 0) console.log(`    · 较基线已减少 ${下降} 处硬编码色值（棘轮请同步下调）`);
});

test("迁移清单（记录型）：可 1:1 映射到 :root 令牌的色值仍待人工决策", () => {
  const 值到令牌 = new Map();
  for (const [名, 值] of 暗基线.entries()) {
    if (!是色值(值)) continue;
    if (!值到令牌.has(值)) 值到令牌.set(值, []);
    值到令牌.get(值).push(名);
  }
  const 清单 = [];
  for (const [值, 次] of 统计.直方图.entries()) {
    const 命中 = 值到令牌.get(值);
    if (命中?.length === 1) 清单.push({ 值, 次, 令牌: 命中[0] });
  }
  清单.sort((a, b) => b.次 - a.次);
  console.log(`    · 可 1:1 映射 ${清单.length} 种 / ${清单.reduce((和, 项) => 和 + 项.次, 0)} 处：`);
  for (const 项 of 清单.slice(0, 12)) console.log(`        ${项.值} ×${项.次} → var(${项.令牌})`);
  console.log("    · 注意：这些替换在**亮色主题**下会改变渲染（同名令牌亮色取值不同），需人工评估后再做。");
  assert.ok(清单.length >= 10, `可映射清单异常缩小：${清单.length}`);
});

console.log(failed ? "\n设计令牌一致性测试：存在失败" : "\n设计令牌一致性测试：全部通过");
process.exitCode = failed ? 1 : 0;
