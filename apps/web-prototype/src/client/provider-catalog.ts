export interface RuntimeProvider {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  availableApis: string[];
  models: { id: string; name: string; api: string; baseUrl?: string; contextWindow?: number; maxTokens?: number; input?: ("text" | "image")[]; reasoning?: boolean; thinkingLevels?: string[]; enabled: boolean; custom: boolean }[];
  auth: { type: "api_key" | "oauth"; label: string }[];
  baseUrlRestriction?: string;
  configured: boolean;
  custom: boolean;
  region?: string;
}

export interface ProviderPresentation {
  name: string;
  category: "cloud" | "other";
  mark: string;
  logoDomain: string;
}

export const PROVIDER_PRESENTATION: Record<string, ProviderPresentation> = {
  "amazon-bedrock": { name: "Amazon Bedrock", category: "cloud", mark: "AWS", logoDomain: "aws.amazon.com" },
  azure: { name: "Azure", category: "cloud", mark: "A", logoDomain: "azure.microsoft.com" },
  "cloudflare-workers-ai": { name: "Cloudflare Workers AI", category: "cloud", mark: "☁", logoDomain: "cloudflare.com" },
  "google-vertex": { name: "Google Vertex AI", category: "cloud", mark: "G", logoDomain: "cloud.google.com" },
  "ant-ling": { name: "Ant Ling", category: "other", mark: "蚂", logoDomain: "ant-ling.com" },
  anthropic: { name: "Anthropic", category: "other", mark: "A", logoDomain: "anthropic.com" },
  baseten: { name: "Baseten", category: "other", mark: "B", logoDomain: "baseten.co" },
  cerebras: { name: "Cerebras", category: "other", mark: "C", logoDomain: "cerebras.ai" },
  "cloudflare-ai-gateway": { name: "Cloudflare AI Gateway", category: "other", mark: "CF", logoDomain: "cloudflare.com" },
  deepseek: { name: "DeepSeek", category: "other", mark: "D", logoDomain: "deepseek.com" },
  fireworks: { name: "Fireworks", category: "other", mark: "F", logoDomain: "fireworks.ai" },
  "github-copilot": { name: "GitHub Copilot", category: "other", mark: "GH", logoDomain: "github.com" },
  google: { name: "Google AI Studio", category: "other", mark: "G", logoDomain: "ai.google.dev" },
  groq: { name: "Groq", category: "other", mark: "G", logoDomain: "groq.com" },
  huggingface: { name: "Hugging Face", category: "other", mark: "HF", logoDomain: "huggingface.co" },
  "kimi-coding": { name: "Kimi Coding", category: "other", mark: "K", logoDomain: "kimi.com" },
  meta: { name: "Meta", category: "other", mark: "∞", logoDomain: "meta.ai" },
  minimax: { name: "MiniMax", category: "other", mark: "M", logoDomain: "minimax.io" },
  "minimax-cn": { name: "MiniMax（中国）", category: "other", mark: "M", logoDomain: "minimaxi.com" },
  mistral: { name: "Mistral", category: "other", mark: "M", logoDomain: "mistral.ai" },
  moonshotai: { name: "Moonshot AI", category: "other", mark: "月", logoDomain: "moonshot.ai" },
  "moonshotai-cn": { name: "Moonshot AI（中国）", category: "other", mark: "月", logoDomain: "moonshot.cn" },
  nvidia: { name: "NVIDIA", category: "other", mark: "N", logoDomain: "nvidia.com" },
  openai: { name: "OpenAI", category: "other", mark: "◎", logoDomain: "openai.com" },
  "openai-codex": { name: "OpenAI Codex (legacy)", category: "other", mark: "◉", logoDomain: "openai.com" },
  opencode: { name: "OpenCode Zen", category: "other", mark: "OC", logoDomain: "opencode.ai" },
  "opencode-go": { name: "OpenCode Go", category: "other", mark: "OC", logoDomain: "opencode.ai" },
  openrouter: { name: "OpenRouter", category: "other", mark: "OR", logoDomain: "openrouter.ai" },
  "qwen-token-plan": { name: "Qwen Token Plan", category: "other", mark: "通", logoDomain: "qwen.ai" },
  "qwen-token-plan-cn": { name: "Qwen Token Plan（中国）", category: "other", mark: "通", logoDomain: "qwen.aliyun.com" },
  "qwen-token-plan-individual": { name: "Qwen Token Plan Individual", category: "other", mark: "通", logoDomain: "qwen.ai" },
  radius: { name: "Radius", category: "other", mark: "R", logoDomain: "radius.xyz" },
  together: { name: "Together", category: "other", mark: "T", logoDomain: "together.ai" },
  typesafe: { name: "TypeSafe", category: "other", mark: "TS", logoDomain: "typesafe.ai" },
  "vercel-ai-gateway": { name: "Vercel AI Gateway", category: "other", mark: "▲", logoDomain: "vercel.com" },
  xai: { name: "xAI", category: "other", mark: "x", logoDomain: "x.ai" },
  xiaomi: { name: "Xiaomi", category: "other", mark: "mi", logoDomain: "xiaomimimo.com" },
  "xiaomi-token-plan-ams": { name: "Xiaomi Token Plan Amsterdam", category: "other", mark: "mi", logoDomain: "xiaomimimo.com" },
  "xiaomi-token-plan-cn": { name: "Xiaomi Token Plan China", category: "other", mark: "mi", logoDomain: "xiaomimimo.com" },
  "xiaomi-token-plan-sgp": { name: "Xiaomi Token Plan Singapore", category: "other", mark: "mi", logoDomain: "xiaomimimo.com" },
  zai: { name: "Z.AI", category: "other", mark: "Z", logoDomain: "z.ai" },
  "zai-coding-cn": { name: "Z.AI Coding（中国）", category: "other", mark: "Z", logoDomain: "bigmodel.cn" },
};

export const PI_COMPATIBLE_APIS = [
  { id: "openai-completions", label: "OpenAI Chat Completions" },
  { id: "openai-responses", label: "OpenAI Responses" },
  { id: "anthropic-messages", label: "Anthropic Messages" },
  { id: "google-generative-ai", label: "Google Generative AI" },
  { id: "google-vertex", label: "Google Vertex AI" },
  { id: "azure-openai-responses", label: "Azure OpenAI Responses" },
  { id: "bedrock-converse-stream", label: "Amazon Bedrock Converse" },
  { id: "mistral-conversations", label: "Mistral Conversations" },
  { id: "openai-codex-responses", label: "OpenAI Codex Responses" },
  { id: "pi-messages", label: "Pi Messages" },
] as const;

export const CLOUD_PROVIDER_IDS = ["amazon-bedrock", "azure", "cloudflare-workers-ai", "google-vertex"] as const;

export const providerPresentation = (provider: RuntimeProvider): ProviderPresentation => PROVIDER_PRESENTATION[provider.id] ?? {
  name: provider.name || provider.id,
  category: "other",
  mark: provider.name.slice(0, 2).toUpperCase() || "AI",
  logoDomain: (() => { try { return new URL(provider.baseUrl).hostname; } catch { return ""; } })(),
};
