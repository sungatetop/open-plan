#!/usr/bin/env node
/**
 * 从 Pi SDK 的内置目录里提取"全部供应商 + 全部模型能力"，固化成 electron/resources/pi-builtin-providers.json。
 *
 * 为什么需要：Pi 内置 30+ 供应商（含 baseUrl / 协议 / 模型 / 上下文窗口 / 是否支持图片），
 * 而工作台此前只显示"已配置"的那几个，其余要用户手填 Base URL 并逐个配模型能力。
 * 这里把内置目录一次性取出来，界面就能"一键添加 + 能力自动带出"。
 *
 * 数据来源：node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks/chunk-*.js
 * （SDK 把各供应商的 default 目录打包成 `var <name>_default={"<api>":{"chat:<id>":{...}}}`）
 *
 * 用法: node scripts/tools/extract-pi-provider-catalog.mjs [--check]
 *   --check 只报告差异（供应商/模型数量变化），不写文件（CI 用）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE_DIR = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "chunks");
const OUT_FILE = path.join(ROOT, "electron", "resources", "pi-builtin-providers.json");

function findBundleFiles() {
  if (!fs.existsSync(BUNDLE_DIR)) return [];
  return fs.readdirSync(BUNDLE_DIR).filter((n) => n.endsWith(".js")).map((n) => path.join(BUNDLE_DIR, n));
}

/** 从 bundle 里抓 `<provider>_default={...}` 定义块（花括号配平） */
function extractProviderBlocks(source) {
  const blocks = [];
  const re = /var\s+([a-z0-9_]+)_default\s*=\s*\{/g;
  let match;
  while ((match = re.exec(source))) {
    const name = match[1];
    const start = match.index + match[0].length - 1;
    let depth = 0;
    let end = start;
    for (let i = start; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    blocks.push({ name, text: source.slice(start, end) });
  }
  return blocks;
}

/** 压缩后的数字可能写成 1e6 / 2.5e5 / 384e3，必须按指数解析，否则上下文窗口会变成 1 */
function parseCompactNumber(text) {
  if (text === undefined || text === null || text === "") return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}
const NUMBER_PATTERN = "(-?[0-9]+(?:\\.[0-9]+)?(?:e[+-]?[0-9]+)?)";

/** 从块里逐条抽出模型定义（按 `{id:"` 切块，字段顺序在 bundle 里并不统一） */
function extractModels(blockText) {
  const models = [];
  const starts = [];
  const re = /\{id:"([^"]+)"/g;
  let match;
  while ((match = re.exec(blockText))) starts.push({ id: match[1], at: match.index });
  for (let i = 0; i < starts.length; i += 1) {
    const { id, at } = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1].at : Math.min(blockText.length, at + 1500);
    const chunk = blockText.slice(at, end);
    const provider = (chunk.match(/provider:"([^"]+)"/) || [])[1];
    if (!provider) continue;
    const name = (chunk.match(/name:"([^"]*)"/) || [])[1] || id;
    const api = (chunk.match(/api:"([^"]+)"/) || [])[1] || "";
    const baseUrl = (chunk.match(/baseUrl:"([^"]*)"/) || [])[1] || "";
    const inputMatch = chunk.match(/input:\[([^\]]*)\]/);
    const ctxMatch = chunk.match(new RegExp(`contextWindow:${NUMBER_PATTERN}`, "i"));
    const maxTokensMatch = chunk.match(new RegExp(`maxTokens:${NUMBER_PATTERN}`, "i"));
    const costMatch = chunk.match(new RegExp(`cost:\\{input:${NUMBER_PATTERN},output:${NUMBER_PATTERN}`, "i"));
    models.push({
      id,
      name,
      provider,
      api,
      baseUrl,
      contextWindow: parseCompactNumber(ctxMatch && ctxMatch[1]),
      maxTokens: parseCompactNumber(maxTokensMatch && maxTokensMatch[1]),
      vision: /"image"/.test(inputMatch ? inputMatch[1] : ""),
      reasoning: /reasoning:!0/.test(chunk),
      cost: costMatch ? { input: parseCompactNumber(costMatch[1]), output: parseCompactNumber(costMatch[2]) } : null,
    });
  }
  return models;
}

/**
 * 登录方式：Pi 在 `createProvider({id:"…", auth:{ apiKey:…, oauth:lazyOAuth({…}) }})` 里声明。
 * 这是权威来源——不要再按关键字邻近猜测（窗口法会把 minimax-cn、ant-ling 这类误判成支持账号登录）。
 */
function extractAuthMethods(source) {
  const methods = new Map();
  const starts = [];
  const re = /createProvider\(\{id:"([^"]+)"/g;
  let match;
  while ((match = re.exec(source))) starts.push({ id: match[1], at: match.index });
  for (let i = 0; i < starts.length; i += 1) {
    const { id, at } = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1].at : Math.min(source.length, at + 6000);
    const block = source.slice(at, end);
    const authAt = block.indexOf("auth:{");
    if (authAt < 0) continue;
    // auth 块到 models: 之前结束（models 之后是模型清单，不是认证声明）
    const authEnd = block.indexOf("models:", authAt);
    const auth = block.slice(authAt, authEnd > 0 ? authEnd : authAt + 1200);
    const oauthMatch = auth.match(/oauth:lazyOAuth\(\{name:"([^"]+)"/);
    const oauthBlock = auth.match(/oauth:lazyOAuth\(\{([^}]*)\}/);
    const apiKeyMatch = auth.match(/apiKey:(\w+)\(("([^"]*)")?(?:,\s*\[([^\]]*)\])?\)/);
    methods.set(id, {
      name: (block.match(/createProvider\(\{id:"[^"]+",name:"([^"]+)"/) || [])[1] || null,
      apiKey: apiKeyMatch
        ? {
            name: apiKeyMatch[3] || "API key",
            envVars: apiKeyMatch[4] ? [...apiKeyMatch[4].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [],
          }
        : null,
      oauth: oauthMatch
        ? {
            name: oauthMatch[1],
            isSubscription: /isSubscription:!0/.test(oauthBlock ? oauthBlock[1] : ""),
            loginLabel: (auth.match(/loginLabel:"([^"]+)"/) || [])[1] || null,
          }
        : null,
    });
  }
  return methods;
}

function build() {
  const providers = new Map();
  const bundleTexts = [];
  const authMethods = new Map();
  for (const file of findBundleFiles()) {
    let source = "";
    try { source = fs.readFileSync(file, "utf8"); } catch { continue; }
    bundleTexts.push(source);
    for (const [id, methods] of extractAuthMethods(source)) authMethods.set(id, methods);
    for (const block of extractProviderBlocks(source)) {
      for (const model of extractModels(block.text)) {
        const entry = providers.get(model.provider) || {
          id: model.provider,
          api: model.api,
          baseUrl: model.baseUrl,
          models: [],
        };
        if (!entry.baseUrl && model.baseUrl) entry.baseUrl = model.baseUrl;
        if (!entry.models.some((m) => m.id === model.id)) entry.models.push(model);
        providers.set(model.provider, entry);
      }
    }
  }
  // Radius 是"运行时注册"的网关型供应商（/login radius 后模型从网关目录拉取），
  // 不在静态 createProvider 列表里，单独补一条。
  authMethods.set("radius", {
    apiKey: { name: "Radius API key", envVars: ["RADIUS_API_KEY"] },
    oauth: { name: "Radius", isSubscription: false, loginLabel: null },
  });
  for (const entry of providers.values()) {
    const methods = authMethods.get(entry.id) || { apiKey: null, oauth: null };
    entry.name = methods.name || entry.id;
    entry.auth = {
      apiKey: methods.apiKey,
      oauth: methods.oauth,
    };
  }
  const list = [...providers.values()]
    .map((p) => ({ ...p, models: p.models.sort((a, b) => a.id.localeCompare(b.id)) }))
    .sort((a, b) => b.models.length - a.models.length || a.id.localeCompare(b.id));
  const loginOnly = [...authMethods.keys()].filter((id) => !providers.has(id));
  return { list, loginOnly };
}

const { list: providers, loginOnly } = build();
const modelCount = providers.reduce((n, p) => n + p.models.length, 0);
const summary = `供应商 ${providers.length} 个 / 模型 ${modelCount} 个`;
console.log(summary);
console.log(providers.slice(0, 12).map((p) => `  ${p.id.padEnd(24)} ${String(p.models.length).padStart(3)} 模型  ${p.api.padEnd(20)} ${p.baseUrl}`).join("\n"));
const oauthIds = providers.filter((p) => p.auth.oauth).map((p) => p.id);
console.log(`支持账号登录 ${oauthIds.length} 个: ${oauthIds.join(", ")}`);
console.log(`仅登录态（无静态模型）: ${loginOnly.join(", ") || "无"}`);
const sample = providers.find((p) => p.id === "deepseek");
if (sample) {
  const m = sample.models[0];
  console.log(`样例 ${sample.id}/${m.id}: contextWindow=${m.contextWindow} maxTokens=${m.maxTokens} vision=${m.vision}`);
}

if (process.argv.includes("--check")) {
  const current = fs.existsSync(OUT_FILE) ? JSON.parse(fs.readFileSync(OUT_FILE, "utf8")) : null;
  const same = current && current.providers?.length === providers.length
    && current.providers.reduce((n, p) => n + p.models.length, 0) === modelCount
    && current.providers.filter((p) => p.auth?.oauth).length === oauthIds.length;
  console.log(same ? "与已固化目录一致 ✓" : "与已固化目录不一致（需要重新生成）");
  process.exit(same ? 0 : 1);
}

fs.writeFileSync(OUT_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), source: "pi-coding-agent dist bundle", loginOnly, providers }, null, 1), "utf8");
console.log(`已写入 ${path.relative(ROOT, OUT_FILE)}（${(fs.statSync(OUT_FILE).size / 1024).toFixed(0)}KB）`);
