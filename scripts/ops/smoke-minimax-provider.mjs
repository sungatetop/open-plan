#!/usr/bin/env node
/**
 * MiniMax 供应商冒烟（一次性）：经 Pi ModelRuntime（与 Agent 生产同链路）真实调用
 * MiniMax-M3，验证「配置 → 凭据 → 完整请求链路」打通。
 *
 * 用法: MINIMAX_API_KEY=sk-cp-... node scripts/ops/smoke-minimax-provider.mjs
 * Key 仅经环境变量传入，不入库、不写文件。
 *
 * 链路复刻 backend/agent/pi-runtime.ts probeModel（L566-592）：
 * ModelRuntime.create({ modelsPath, credentials }) → getModel(provider, id) → completeSimple
 * 参数与生产一致：maxRetries=0 / maxTokens=16 / anthropic-messages → reasoning="low"。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROVIDER = "minimax";
const MODEL_ID = "MiniMax-M3";
const BASE_URL = "https://api.minimaxi.com/anthropic"; // Anthropic 兼容端点（/anthropic/v1/messages）

const key = String(process.env.MINIMAX_API_KEY || "").trim();
assert.ok(key, "缺少 MINIMAX_API_KEY 环境变量");

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-minimax-"));
try {
  // models.json 供应商块（形态对齐 provider-catalog buildBuiltinImport）
  const modelsConfig = {
    providers: {
      [PROVIDER]: {
        provider: PROVIDER,
        name: "MiniMax",
        api: "anthropic-messages",
        baseUrl: BASE_URL,
        enabled: true,
        models: [{
          id: MODEL_ID,
          name: MODEL_ID,
          contextWindow: 200000,
          reasoning: true,
          input: ["text"],
          enabled: true,
        }],
      },
    },
  };
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify(modelsConfig, null, 2));

  const auth = { [PROVIDER]: { type: "api_key", key } };
  const credentials = {
    read: async (provider) => auth[provider],
    list: async () => Object.entries(auth).map(([providerId, value]) => ({ providerId, type: value?.type })),
    modify: async (provider, fn) => { auth[provider] = await fn(auth[provider]); return auth[provider]; },
  };

  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const runtime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
    modelsStorePath: path.join(agentDir, "models-store.json"),
    credentials,
  });

  const model = runtime.getModel(PROVIDER, MODEL_ID);
  assert.ok(model, `模型未找到：${PROVIDER}/${MODEL_ID}`);
  console.log(`模型对象 OK：${PROVIDER}/${MODEL_ID}（api=${model.api}, baseUrl=${model.baseUrl}）`);

  const startedAt = Date.now();
  const response = await runtime.completeSimple(model, {
    messages: [{ role: "user", content: "Reply with OK only.", timestamp: Date.now() }],
  }, {
    timeoutMs: 30000,
    maxRetries: 0,
    maxRetryDelayMs: 1000,
    reasoning: "low", // anthropic-messages 必须给思考预算，否则 max_tokens=null 被网关拒绝
    maxTokens: 16,
    sessionId: `probe-${Date.now()}`,
  });

  assert.ok(!(response?.stopReason === "error" || response?.errorMessage),
    `模型返回错误：${response?.errorMessage || response?.stopReason}`);

  const text = (response?.content || [])
    .filter((item) => item?.type === "text")
    .map((item) => item.text || "").join("").trim();
  const usage = response?.usage || {};
  const elapsed = Date.now() - startedAt;
  console.log(`响应 OK：${JSON.stringify(text)}（${elapsed}ms，in=${usage.input?.tokens ?? "?"} out=${usage.output?.tokens ?? "?"}）`);
  assert.equal(text, "OK", `响应内容非预期：${text}`);
  console.log("\n===== MINIMAX SMOKE PASSED =====");
} finally {
  fs.rmSync(agentDir, { recursive: true, force: true });
}
