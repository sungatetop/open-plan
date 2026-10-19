#!/usr/bin/env node
/**
 * 补齐 docs/ 下所有 Markdown 文档的 YAML frontmatter
 * （title / summary / keywords / status / date）。
 *
 * 规则见 .trae/rules/project_rules.md §1.2：
 * - 已有 frontmatter 的文件跳过
 * - title 取正文首个 H1，否则用文件名
 * - summary 取首个正文段落（去 Markdown 标记，截断 80 字符）
 * - keywords 取文件名分词 + 所属目录类别，取前 6 个
 * - status 默认 done（存量文档均为已交付产物）
 * - date 取文件名中的日期，否则取文件创建日期
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOCS_DIR = path.join(ROOT, 'docs');
const STOP_TOKENS = new Set(['md', 'doc', 'docx', 'v2', 'v3', 'g3']);

function walkMd(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkMd(full));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) out.push(full);
  }
  return out;
}

function firstDateInName(name) {
  const iso = name.match(/20\d{2}-\d{2}-\d{2}/);
  if (iso) return iso[0];
  const compact = name.match(/20\d{6}/);
  if (compact) return `${compact[0].slice(0, 4)}-${compact[0].slice(4, 6)}-${compact[0].slice(6, 8)}`;
  return null;
}

function stripMd(line) {
  return line
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function yamlScalar(text) {
  if (/^[\w\u4e00-\u9fff][^:#"']*[\w\u4e00-\u9fff.…]$|^[\w\u4e00-\u9fff]+$/.test(text)) return text;
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function buildFrontmatter(relPath, content, stat) {
  const lines = content.replace(/\r/g, '').split('\n');

  // 首个 H1 作为 title
  let title = path.basename(relPath, '.md');
  const h1 = lines.find((l) => /^#\s+\S/.test(l.trim()));
  if (h1) title = stripMd(h1.trim().slice(1).trim());

  // 首个非标题、非列表、非表格、非代码的正文行作为 summary
  let summary = '';
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (/^#|^[-*+]\s|^\||^```|^!\[|^<|^---$/.test(t)) continue;
    summary = stripMd(t);
    if (summary) break;
  }
  if (summary.length > 80) summary = `${summary.slice(0, 79)}…`;

  // keywords：文件名分词 + 目录类别
  const tokens = path.basename(relPath, '.md')
    .split(/[-_\s]+/)
    .map((t) => t.trim())
    .filter((t) => t && !STOP_TOKENS.has(t.toLowerCase()) && !/^20\d{2,8}$/.test(t) && !/^\d+$/.test(t));
  const category = path.dirname(relPath).split(path.sep).filter(Boolean)[0] || 'docs';
  const keywords = [...new Set([...tokens, category])].slice(0, 6);

  const date = firstDateInName(path.basename(relPath)) || stat.birthtime.toISOString().slice(0, 10);

  return [
    '---',
    `title: ${yamlScalar(title)}`,
    `summary: ${yamlScalar(summary || title)}`,
    `keywords: [${keywords.join(', ')}]`,
    'status: done',
    `date: ${date}`,
    '---',
    '',
  ].join('\n');
}

const files = walkMd(DOCS_DIR);
let added = 0;
let skipped = 0;
for (const file of files) {
  const raw = fs.readFileSync(file, 'utf8');
  if (raw.startsWith('---')) { skipped++; continue; }
  const rel = path.relative(DOCS_DIR, file);
  const block = buildFrontmatter(rel, raw, fs.statSync(file));
  fs.writeFileSync(file, `${block}\n${raw}`, 'utf8');
  added++;
}
console.log(`frontmatter: added ${added}, skipped ${skipped} (already had), total ${files.length}`);
