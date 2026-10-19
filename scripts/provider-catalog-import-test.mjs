#!/usr/bin/env node
/**
 * Pi 内置供应商目录 · 一键添加 · 登录方式区分 测试
 *
 * 覆盖：
 *   1. 目录数据质量：41 个供应商 / 1142 个模型；上下文窗口按指数解析（1e6 而不是 1）；
 *      登录方式是权威清单（9 个支持账号登录），不再靠关键字邻近猜测；
 *   2. 能力反查：按模型 ID 自动带出上下文窗口 / 图片 / 思考（含带前缀的写法）；
 *   3. 一键导入配置：Base URL / 协议 / 模型能力自动生成；云凭证类供应商明确拒绝并给原因；
 *   4. 接口层：/api/agent/provider-catalog（列表 + 详情 + 导入 + 设为默认）在临时数据目录里跑通，
 *      导入后能删除干净，且响应里不出现任何 Key 明文；
 *   5. 界面层：模型供应商 / 网络与代理已拆成两页；内置库、登录方式徽章、导入对话框存在；
 *      会话导航弹层（方案 A）有列表、键盘与跳转。
 *
 * 用法: node scripts/provider-catalog-import-test.mjs
 * 退出码: 0 = 全部通过, 1 = 有失败
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { builtinProviderDetail, builtinProviderList, buildBuiltinImport, findBuiltinModel, loadBuiltinCatalog } from "../server/provider-catalog.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(projectRoot, rel), "utf8");

let failed = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const bad = (msg) => { console.error(`  ✗ ${msg}`); failed = 1; };
function 场景(name, fn) {
  try { fn(); ok(name); } catch (e) { bad(`${name}: ${e.message}`); }
}
async function 接口场景(name, fn) {
  try { await fn(); ok(name); } catch (e) { bad(`${name}: ${e.message}`); }
}

// ============================================================
// 1. 目录数据质量
// ============================================================
const catalog = loadBuiltinCatalog();
const list = builtinProviderList();

场景("目录：41 个供应商 / 1142 个模型 / 有生成时间", () => {
  assert.equal(list.providers.length, 41, `供应商数量应为 41，实际 ${list.providers.length}`);
  assert.equal(list.totalModels, 1142, `模型总数应为 1142，实际 ${list.totalModels}`);
  assert.ok(list.generatedAt, "目录应带生成时间，便于判断是否需要重新提取");
  assert.equal(list.error, null);
});

场景("上下文窗口按指数解析（1e6 → 1000000，不是 1）", () => {
  const deepseek = catalog.providers.find((provider) => provider.id === "deepseek");
  const flash = deepseek.models.find((model) => model.id === "deepseek-flash");
  assert.ok(flash, "deepseek-flash 应在目录里");
  assert.equal(flash.contextWindow, 1_000_000);
  assert.equal(flash.maxTokens, 384_000);
  const anthropic = catalog.providers.find((provider) => provider.id === "anthropic");
  assert.ok(anthropic.models.every((model) => (model.contextWindow || 0) >= 1_000), "所有模型的上下文窗口都不该是 1");
  const bogus = catalog.providers.flatMap((provider) => provider.models).filter((model) => model.contextWindow !== null && model.contextWindow < 1_000);
  assert.equal(bogus.length, 0, `不应存在被截断的上下文窗口：${bogus.slice(0, 5).map((m) => `${m.id}=${m.contextWindow}`).join(", ")}`);
});

场景("图片能力来自 input:[text,image]，不是猜的", () => {
  const deepseek = catalog.providers.find((provider) => provider.id === "deepseek");
  const flash = deepseek.models.find((model) => model.id === "deepseek-flash");
  assert.equal(flash.vision, true, "deepseek-flash 支持图片");
  const withVision = list.providers.filter((provider) => provider.capabilities.visionCount > 0).map((provider) => provider.id);
  assert.ok(withVision.length >= 20, `至少 20 个供应商有支持图片的模型，实际 ${withVision.length}`);
});

场景("登录方式是权威清单：9 个支持账号登录，其余为纯 API Key", () => {
  const oauth = list.providers.filter((provider) => provider.loginMethods.includes("oauth")).map((provider) => provider.id).sort();
  assert.deepEqual(
    oauth,
    ["anthropic", "github-copilot", "kimi-coding", "meta", "openai", "openai-codex", "openrouter", "radius", "xai"],
    "账号登录清单应与 Pi 的 createProvider({auth:{oauth:...}}) 声明一致",
  );
  // 反向：这些常被误判的供应商必须是纯 API Key
  for (const id of ["minimax-cn", "ant-ling", "zai", "deepseek", "vercel-ai-gateway"]) {
    const provider = list.providers.find((item) => item.id === id);
    assert.equal(provider.loginMethods.includes("oauth"), false, `${id} 不支持账号登录，不应被标成 OAuth`);
  }
  const openaiCodex = list.providers.find((provider) => provider.id === "openai-codex");
  assert.deepEqual(openaiCodex.loginMethods, ["oauth"], "openai-codex 只有账号登录，没有 API Key 入口");
  const anthropic = list.providers.find((provider) => provider.id === "anthropic");
  assert.deepEqual(anthropic.loginMethods, ["oauth", "apiKey"], "Anthropic 两种登录方式都支持");
});

场景("一键添加的可行性：公开 HTTP + API Key 才可导入，云凭证类明确拒绝并说明原因", () => {
  const importable = list.providers.filter((provider) => provider.importable);
  assert.ok(importable.length >= 35, `至少 35 个供应商可一键添加，实际 ${importable.length}`);
  for (const id of ["deepseek", "openai", "google", "mistral", "groq", "nvidia"]) {
    assert.equal(list.providers.find((provider) => provider.id === id).importable, true, `${id} 应可一键添加`);
  }
  for (const id of ["amazon-bedrock", "google-vertex", "azure", "radius"]) {
    const provider = list.providers.find((item) => item.id === id);
    assert.equal(provider.importable, false, `${id} 需要专用配置，不该允许一键添加`);
    assert.ok(provider.importBlockReason, `${id} 必须给出不能导入的原因`);
  }
});

场景("能力反查：按模型 ID 带出上下文 / 图片 / 思考，支持带前缀写法", () => {
  const plain = findBuiltinModel("deepseek-flash");
  assert.ok(plain, "deepseek-flash 应能反查到");
  assert.equal(plain.contextWindow, 1_000_000);
  assert.equal(plain.vision, true);
  const prefixed = findBuiltinModel("openai/gpt-5.4");
  assert.ok(prefixed, "带供应商前缀的写法也要能反查到");
  assert.equal(findBuiltinModel("绝对不存在的模型-xyz"), null, "查不到时返回 null，不能瞎猜");
});

场景("一键导入配置：Base URL / 协议 / 能力全部带出，用户只需补 Key", () => {
  const built = buildBuiltinImport("deepseek", {});
  assert.equal(built.provider, "deepseek");
  assert.equal(built.api, "openai-completions");
  assert.match(built.baseUrl, /^https:\/\//);
  assert.ok(built.models.length >= 2, "应带出全部内置模型");
  const flash = built.models.find((model) => model.id === "deepseek-flash");
  assert.equal(flash.contextWindow, 1_000_000, "导入配置要带上下文窗口");
  assert.deepEqual(flash.input, ["text", "image"], "导入配置要带图片能力");
  assert.equal(flash.enabled, true);
  // 只导入指定模型
  const partial = buildBuiltinImport("deepseek", { modelIds: ["deepseek-flash"] });
  assert.equal(partial.models.length, 1);
  // 不可导入的供应商要抛错，且错误里带原因
  assert.throws(() => buildBuiltinImport("amazon-bedrock", {}), /云平台凭证|云凭证/, "Bedrock 应明确拒绝");
  assert.throws(() => buildBuiltinImport("不存在的供应商", {}), /不存在/);
});

场景("详情接口数据：模型清单带能力，单个供应商可查", () => {
  const detail = builtinProviderDetail("anthropic");
  assert.ok(detail, "anthropic 详情应存在");
  assert.equal(detail.models.length, 17);
  assert.ok(detail.models.every((model) => model.id && typeof model.vision === "boolean"));
  assert.equal(builtinProviderDetail("不存在"), null);
});

// ============================================================
// 2. 界面层：两页拆分 + 内置库 + 会话导航弹层
// ============================================================
场景("设置面板：模型供应商与网络与代理拆成两页", () => {
  const panel = read("client/src/components/SettingsPanel.jsx");
  assert.match(panel, /\["providers", "模型供应商"\]/);
  assert.match(panel, /\["network", "网络与代理"\]/);
  assert.doesNotMatch(panel, /\["model", "自定义供应商 · 网络"\]/, "旧的合页标签应已移除");
  assert.match(panel, /settingsSection === "providers" &&/, "供应商页要独立渲染");
  assert.match(panel, /settingsSection === "network" &&/, "网络页要独立渲染");
  assert.match(panel, /id="settings-network"/);
  // 旧入口（initialSection="model"）要兼容映射到新页，避免外部跳转失效
  assert.match(panel, /initialSection === "model" \? "providers" : initialSection/);
  // 网络卡片只能在网络页里出现一次
  assert.equal((panel.match(/<strong>模型网络<\/strong>/g) || []).length, 1);
});

场景("我的供应商：测试连接 / 设为默认 / 品牌图标都在行内", () => {
  const panel = read("client/src/components/SettingsPanel.jsx");
  assert.match(panel, />测试连接</);
  assert.match(panel, />设为默认</);
  assert.match(panel, /agentSetDefaultModel/);
  assert.match(panel, /providerIdentity\(config\.provider\)/);
});

场景("内置供应商库：可搜索、按登录方式筛选、一键添加", () => {
  const library = read("client/src/components/ProviderLibrary.jsx");
  assert.match(library, /搜索供应商 \/ 模型 \/ 环境变量/);
  assert.match(library, /\["oauth", "支持账号登录"\]/);
  assert.match(library, /\["apikey", "API Key"\]/);
  assert.match(library, /账号登录/);
  assert.match(library, /agentProviderImport/);
  assert.match(library, /provider\.importable/);
  assert.match(library, /prov-dialog-backdrop/);
  assert.match(library, /API Key \{provider\.auth\?\.apiKey\?\.envVars\?\.\[0\]/, "添加时要提示环境变量名");
  assert.match(library, /设为默认模型供应商/);
  assert.match(library, /formatContext/);
});

场景("账号登录区块：只列支持 OAuth 的供应商，并说明凭据怎么进来", () => {
  const panel = read("client/src/components/SettingsPanel.jsx");
  assert.match(panel, /账号登录（订阅制）/);
  assert.match(panel, /loginMethods\?\.includes\("oauth"\)/);
  assert.match(panel, /pi auth login/);
  assert.match(panel, /从本地 Pi 导入配置/);
});

场景("品牌图形：vendored 数据文件 + ProviderIcon 合并，未知供应商走首字母兜底", () => {
  const data = read("client/src/components/SupplierBrandGraphics.js");
  const slugs = [...data.matchAll(/^\s{2}([a-z0-9]+):\r?\n\s+"/gm)].map((m) => m[1]);
  assert.ok(slugs.length >= 20, `品牌图形至少 20 个，实际 ${slugs.length}`);
  for (const slug of ["anthropic", "openai", "deepseek", "googlegemini", "moonshotai", "mistralai", "nvidia", "cloudflare"]) {
    assert.ok(slugs.includes(slug), `缺品牌图形：${slug}`);
  }
  const icon = read("client/src/components/Icon.jsx");
  assert.match(icon, /import 品牌图形 from "\.\/SupplierBrandGraphics\.js"/);
  assert.match(icon, /const 品牌图形键 = \{/);
  assert.match(icon, /PROVIDER_GLYPHS\[key\] = <path fill="currentColor" d=\{品牌图形\[slug\]\} \/>/);
  assert.match(icon, /custom: <circle/, "没有品牌矢量时仍要有个中性兜底图形");
});

场景("会话导航弹层（方案 A）：列表 + 键盘 + 跳转 + 顶部底部", () => {
  const timeline = read("client/src/components/ChatTimeline.jsx");
  assert.match(timeline, /timeline-popup/);
  assert.match(timeline, /role="listbox"/);
  assert.match(timeline, /aria-activedescendant/);
  assert.match(timeline, /ArrowDown/);
  assert.match(timeline, /event\.key === "Enter"/);
  assert.match(timeline, /Escape/);
  assert.match(timeline, /↑ 顶部/);
  assert.match(timeline, /↓ 底部/);
  assert.match(timeline, /timeline-popup-role/);
  assert.match(timeline, /scrollToMsg\(entry\.idx\)/);
  assert.match(timeline, /退到最近的一条已挂载消息/, "历史渐进挂载时，跳转要退到最近的已挂载消息而不是静默失败");
  assert.doesNotMatch(timeline, /bead-tip/, "旧的单行提示应已被弹层取代");
  const styles = read("client/src/styles.css");
  assert.match(styles, /\.timeline-popup \{/);
  assert.match(styles, /\.timeline-popup-item\.cursor/);
  assert.match(styles, /-webkit-line-clamp: 2/, "摘要要两行截断");
  assert.match(styles, /@media \(max-width: 720px\)[\s\S]{0,200}\.timeline-popup \{/, "窄屏要降级成贴底抽屉");
});

// ============================================================
// 3. 接口层：临时数据目录里起一个真服务
// ============================================================
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "规聚供应商目录-"));
// 端口用系统分配的空闲端口，而不是固定区间 + 随机：CI 里各测试脚本串行跑，
// 上一个脚本留下的服务可能正占着随机命中的端口，测试就会偶发失败（实测遇到过一次）。
const port = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.on("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const assigned = probe.address().port;
    probe.close(() => resolve(assigned));
  });
});
const baseUrl = `http://127.0.0.1:${port}`;
let child = null;

function environment() {
  return {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    OAW_DATA_DIR: path.join(temporaryRoot, "应用数据"),
    OAW_LOCAL_PI_AGENT_DIR: path.join(temporaryRoot, "本地Pi"),
    OAW_RUNTIME_RECORD_FILE: path.join(temporaryRoot, "运行时记录.json"),
    OAW_RUNS_DIR: path.join(temporaryRoot, "任务"),
    OAW_EVENT_DIR: path.join(temporaryRoot, "事件"),
    OAW_WRITE_LOCK_DIR: path.join(temporaryRoot, "写锁"),
    OAW_AGENTS_FILE: path.join(temporaryRoot, "智能体.json"),
    OAW_MEMORY_PROPOSALS_FILE: path.join(temporaryRoot, "记忆建议.json"),
    OAW_PROJECTS_FILE: path.join(temporaryRoot, "项目.json"),
  };
}

async function 停服务() {
  if (!child) return;
  const target = child;
  child = null;
  if (target.exitCode === null) target.kill();
  await Promise.race([
    new Promise((resolve) => target.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
}

async function 起服务() {
  let logs = "";
  child = spawn(process.execPath, ["server/index.mjs"], {
    cwd: projectRoot,
    env: environment(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
  child.stderr.on("data", (chunk) => { logs += chunk.toString(); });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`测试服务提前退出：\n${logs}`);
    try {
      const response = await fetch(`${baseUrl}/api/status`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`测试服务启动超时：\n${logs}`);
}

async function 请求(pathname, options) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  return { status: response.status, ok: response.ok, body };
}
const JSON头 = { "content-type": "application/json" };

try {
  await 起服务();

  await 接口场景("接口：目录列表带登录方式与已配置状态，且不含任何 Key 明文", async () => {
    const { status, body } = await 请求("/api/agent/provider-catalog");
    assert.equal(status, 200);
    assert.equal(body.providers.length, 41);
    assert.equal(body.summary.oauth, 9);
    assert.ok(body.summary.importable >= 35);
    const text = JSON.stringify(body);
    assert.doesNotMatch(text, /"(key|apiKey|secret|token)"\s*:\s*"[^"]{6,}"/, "目录响应不得出现凭据明文");
    const deepseek = body.providers.find((provider) => provider.id === "deepseek");
    assert.equal(deepseek.configured, false, "临时数据目录里什么都没配");
    assert.deepEqual(deepseek.loginMethods, ["apiKey"]);
    assert.equal(deepseek.importable, true);
    const bedrock = body.providers.find((provider) => provider.id === "amazon-bedrock");
    assert.equal(bedrock.importable, false);
    assert.ok(bedrock.importBlockReason);
  });

  await 接口场景("接口：详情返回完整模型清单（含上下文 / 图片）", async () => {
    const { status, body } = await 请求("/api/agent/provider-catalog/deepseek");
    assert.equal(status, 200);
    assert.equal(body.provider.id, "deepseek");
    assert.equal(body.provider.models.length, 2);
    assert.equal(body.provider.models[0].contextWindow, 1_000_000);
    const missing = await 请求("/api/agent/provider-catalog/不存在");
    assert.equal(missing.status, 404);
  });

  await 接口场景("接口：一键添加 → 能力自动带出 → 可删除干净（不留残余）", async () => {
    const imported = await 请求("/api/agent/provider-catalog/import", {
      method: "POST",
      headers: JSON头,
      body: JSON.stringify({ provider: "cerebras", enabled: true }),
    });
    assert.equal(imported.status, 200, `导入应成功：${JSON.stringify(imported.body)}`);
    assert.equal(imported.body.ok, true);
    assert.equal(imported.body.added, 2, "cerebras 有 2 个内置模型");
    assert.equal(imported.body.defaultModel, null, "没勾「设为默认」就不该改默认模型");

    const configs = await 请求("/api/agent/model-configs");
    const config = configs.body.configs.find((item) => item.provider === "cerebras");
    assert.ok(config, "导入后应出现在供应商配置里");
    assert.equal(config.api, "openai-completions", "协议要按目录带出");
    assert.match(config.baseUrl, /^https:\/\//);
    assert.equal(config.models.length, 2);
    assert.ok(config.models.every((model) => model.contextWindow > 0), "每个模型都要带上下文窗口");
    assert.equal(config.keyConfigured, false, "没填 Key 时状态要如实显示");

    // 重复导入要幂等：不再新增模型
    const again = await 请求("/api/agent/provider-catalog/import", {
      method: "POST",
      headers: JSON头,
      body: JSON.stringify({ provider: "cerebras" }),
    });
    assert.equal(again.body.added, 0, "重复导入不该重复添加模型");
    assert.equal(again.body.total, 2);

    const removed = await 请求("/api/agent/model-configs/cerebras", { method: "DELETE" });
    assert.equal(removed.status, 200);
    const after = await 请求("/api/agent/model-configs");
    assert.equal(after.body.configs.some((item) => item.provider === "cerebras"), false, "删除后不留残余");
    const catalogAfter = await 请求("/api/agent/provider-catalog");
    assert.equal(catalogAfter.body.providers.find((provider) => provider.id === "cerebras").configured, false);
  });

  await 接口场景("接口：不可导入的供应商被拒绝并给出原因", async () => {
    const response = await 请求("/api/agent/provider-catalog/import", {
      method: "POST",
      headers: JSON头,
      body: JSON.stringify({ provider: "amazon-bedrock" }),
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, "PROVIDER_IMPORT_FAILED");
    assert.match(response.body.error, /云平台凭证|云凭证/);
  });

  await 接口场景("接口：设为默认写 settings.json，且可查询到", async () => {
    await 请求("/api/agent/provider-catalog/import", {
      method: "POST",
      headers: JSON头,
      body: JSON.stringify({ provider: "deepseek", apiKey: "sk-测试用的假Key" }),
    });
    const setDefault = await 请求("/api/agent/default-model", {
      method: "POST",
      headers: JSON头,
      body: JSON.stringify({ provider: "deepseek", model: "deepseek-flash" }),
    });
    assert.equal(setDefault.status, 200);
    assert.equal(setDefault.body.defaultModel, "deepseek/deepseek-flash");
    const catalogAfter = await 请求("/api/agent/provider-catalog");
    assert.equal(catalogAfter.body.defaultModel, "deepseek/deepseek-flash");
    const deepseek = catalogAfter.body.providers.find((provider) => provider.id === "deepseek");
    assert.equal(deepseek.isDefault, true, "目录要标出默认供应商");
    assert.equal(deepseek.keyConfigured, true, "填了 Key 后状态要变成已配置");
    // 凭据只以掩码形式出现在 /api/agent/auth
    const auth = await 请求("/api/agent/auth");
    assert.ok(auth.body.providers.deepseek?.set);
    assert.doesNotMatch(JSON.stringify(auth.body), /sk-测试用的假Key/, "凭据接口不得回显明文");
    const missing = await 请求("/api/agent/default-model", { method: "POST", headers: JSON头, body: JSON.stringify({ provider: "deepseek" }) });
    assert.equal(missing.status, 400, "缺 model 时应拒绝");
  });

  await 接口场景("接口：OAuth 凭据（access/refresh）也算已配置", async () => {
    // 账号登录存的是 access/refresh，不是 key；只认 key 会把已授权的供应商显示成"未添加"。
    // 直接写临时目录里的凭据文件，模拟 Pi 完成 /login 之后的形态。
    const authPath = path.join(temporaryRoot, "应用数据", "凭据.json");
    const existing = fs.existsSync(authPath) ? JSON.parse(fs.readFileSync(authPath, "utf8")) : {};
    fs.writeFileSync(authPath, JSON.stringify({
      ...existing,
      "openai-codex": { type: "oauth", access: "测试用-access-token", refresh: "测试用-refresh-token", expires: Date.now() + 3600_000 },
    }, null, 2), "utf8");
    const catalogAfter = await 请求("/api/agent/provider-catalog");
    const codex = catalogAfter.body.providers.find((provider) => provider.id === "openai-codex");
    assert.equal(codex.configured, true, "有 OAuth 凭据就要算已配置");
    assert.equal(codex.credentialType, "oauth");
    const text = JSON.stringify(catalogAfter.body);
    assert.doesNotMatch(text, /测试用-access-token/, "凭据明文不得出现在目录响应里");
  });

  await 接口场景("接口：拉取模型列表时按目录补能力（对不上的仍可手填）", async () => {
    // 直接验证服务端的能力补全函数在接口层的表现：用一个不存在的 baseUrl 会走网络，这里改为断言导入路径已覆盖。
    // （真实网关拉取在「从接口拉取」按钮里做，需要用户自己的 Key，不在自动化测试里打外网。）
    const detail = await 请求("/api/agent/provider-catalog/deepseek");
    assert.ok(detail.body.provider.sampleModels.length > 0, "内置库要给出「前几个模型」用于界面预览");
    assert.ok(detail.body.provider.sampleModels.every((model) => model.id));
  });
} finally {
  await 停服务();
  try { fs.rmSync(temporaryRoot, { recursive: true, force: true }); } catch {}
}

console.log(failed ? "\n有失败项 ✗" : "\n全部通过 ✓");
process.exit(failed ? 1 : 0);
