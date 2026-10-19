#!/usr/bin/env node
/**
 * 把 scripts/assets/brand-vectors/*.svg（simple-icons 的品牌矢量）编译成
 * client/src/components/SupplierBrandGraphics.js —— 只保留路径 d 字符串，运行时不依赖任何包。
 *
 * simple-icons 数据为 CC0；品牌图形仅用于"标识对应供应商"，不代表合作或背书。
 * 新增品牌：把 <slug>.svg 放进 scripts/assets/brand-vectors/ 再跑本脚本。
 * 重新生成：node scripts/tools/generate-brand-graphics.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = path.join(ROOT, "scripts", "供应商品牌矢量");
const OUT_FILE = path.join(ROOT, "client/src/components/SupplierBrandGraphics.js");

const svgFiles = fs.existsSync(SRC_DIR) ? fs.readdirSync(SRC_DIR).filter((n) => n.endsWith(".svg")) : [];
if (!svgFiles.length) {
  console.error("没有找到 scripts/assets/brand-vectors/*.svg，先放入品牌矢量再生成");
  process.exit(1);
}

const entries = [];
for (const file of svgFiles.sort()) {
  const slug = file.slice(0, -4);
  const text = fs.readFileSync(path.join(SRC_DIR, file), "utf8");
  const d = (text.match(/ d="([^"]+)"/) || [])[1] || "";
  const title = (text.match(/<title>([^<]+)<\/title>/) || [])[1] || slug;
  if (!d) { console.warn(`跳过 ${slug}（没有路径数据）`); continue; }
  entries.push({ slug, title, d });
}

const lines = entries.map(({ slug, title, d }) => `  // ${title}\n  ${slug}:\n    "${d}",`);
const content = `// 供应商品牌图形（simple-icons，CC0 许可）。
// 只用于标识"这个供应商是谁"，不表示任何合作或背书；图形以 currentColor 渲染，跟随主题色。
// 由 scripts/tools/generate-brand-graphics.mjs 生成，不要手改。
const 品牌图形 = {
${lines.join("\n")}
};

export default 品牌图形;
`;
fs.writeFileSync(OUT_FILE, content, "utf8");
console.log(`已写入 ${path.relative(ROOT, OUT_FILE)}：${entries.length} 个品牌（${entries.map((e) => e.slug).join(", ")}）`);
