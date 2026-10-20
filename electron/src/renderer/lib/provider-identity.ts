/**
 * 供应商标识：id → 中文标签 + 品牌图形 key（图形由 Icon.jsx 的 ProviderIcon 渲染）。
 *
 * 品牌矢量见 components/SupplierBrandGraphics.js（simple-icons，CC0）；
 * 没有品牌图形的供应商走首字母色块兜底（icon 保持 "custom"）。
 *
 * 与 client/src/provider-identity.js 逐函数等价（tests/f1-provider-identity-parity.test.ts 对拍强制）。
 */
interface ProviderInfo { label: string; icon: string; }

const 供应商标识: Record<string, ProviderInfo> = {
  anthropic: { label: "Anthropic", icon: "anthropic" },
  openai: { label: "OpenAI", icon: "openai" },
  "openai-codex": { label: "OpenAI Codex", icon: "openai" },
  google: { label: "Google Gemini", icon: "gemini" },
  "google-vertex": { label: "Google Vertex AI", icon: "googlecloud" },
  deepseek: { label: "DeepSeek", icon: "deepseek" },
  xai: { label: "xAI", icon: "xai" },
  mistral: { label: "Mistral", icon: "mistral" },
  meta: { label: "Meta", icon: "meta" },
  nvidia: { label: "NVIDIA", icon: "nvidia" },
  openrouter: { label: "OpenRouter", icon: "openrouter" },
  huggingface: { label: "Hugging Face", icon: "huggingface" },
  cloudflare: { label: "Cloudflare", icon: "cloudflare" },
  "cloudflare-ai-gateway": { label: "Cloudflare AI Gateway", icon: "cloudflare" },
  "cloudflare-workers-ai": { label: "Cloudflare Workers AI", icon: "cloudflare" },
  "vercel-ai-gateway": { label: "Vercel AI Gateway", icon: "vercel" },
  "amazon-bedrock": { label: "Amazon Bedrock", icon: "bedrock" },
  azure: { label: "Azure OpenAI", icon: "azure" },
  opencode: { label: "OpenCode Zen", icon: "opencode" },
  "opencode-go": { label: "OpenCode Go", icon: "opencode" },
  minimax: { label: "MiniMax", icon: "minimax" },
  "minimax-cn": { label: "MiniMax CN", icon: "minimax" },
  moonshotai: { label: "Moonshot AI", icon: "moonshot" },
  "moonshotai-cn": { label: "Moonshot AI CN", icon: "moonshot" },
  "kimi-coding": { label: "Kimi For Coding", icon: "kimi" },
  qwen: { label: "Qwen", icon: "qwen" },
  "qwen-token-plan": { label: "Qwen Token Plan", icon: "qwen" },
  "qwen-token-plan-cn": { label: "Qwen Token Plan CN", icon: "qwen" },
  "qwen-token-plan-individual": { label: "Qwen Token Plan Individual", icon: "qwen" },
  xiaomi: { label: "Xiaomi MiMo", icon: "xiaomi" },
  "xiaomi-token-plan-cn": { label: "Xiaomi MiMo CN", icon: "xiaomi" },
  "xiaomi-token-plan-ams": { label: "Xiaomi MiMo AMS", icon: "xiaomi" },
  "xiaomi-token-plan-sgp": { label: "Xiaomi MiMo SGP", icon: "xiaomi" },
  zai: { label: "Z.AI", icon: "zhipu" },
  "zai-coding-cn": { label: "Z.AI Coding CN", icon: "zhipu" },
  "command-code": { label: "Command Code", icon: "commandcode" },
  "command-code-anthropic": { label: "Command Code", icon: "commandcode" },
  groq: { label: "Groq", icon: "custom" },
  cerebras: { label: "Cerebras", icon: "custom" },
  together: { label: "Together AI", icon: "custom" },
  fireworks: { label: "Fireworks", icon: "custom" },
  baseten: { label: "Baseten", icon: "custom" },
  "ant-ling": { label: "Ant Ling", icon: "custom" },
  typesafe: { label: "TypeSafe", icon: "custom" },
  radius: { label: "Radius", icon: "custom" },
  ollama: { label: "Ollama", icon: "ollama" },
};

/** 供应商 id 的展示信息；未知供应商返回 id 本身 + 首字母兜底。 */
export function providerIdentity(id: unknown): { id: string; label: string; icon: string } {
  const key = String(id || "").trim();
  const known = 供应商标识[key.toLowerCase()];
  return known ? { id: key, ...known } : { id: key, label: key || "自定义供应商", icon: "custom" };
}

export function providerLabel(id: unknown): string {
  return providerIdentity(id).label;
}

export function providerIconKey(id: unknown): string {
  return providerIdentity(id).icon;
}

export default 供应商标识;
