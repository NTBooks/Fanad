// The LLM provider catalog — the single source of truth for the server's cloud gating (routes/api.js),
// and served to the web client via /api/config so the Settings dropdown stops hardcoding its own copy.
// `cloud: true` providers are gated behind LLM_ALLOW_CLOUD; locals carry a default base URL for the form.
export const PROVIDERS = [
  { id: 'lmstudio', label: 'LM Studio (local — recommended)', cloud: false, defaultUrl: 'http://127.0.0.1:1234/v1' },
  { id: 'ollama', label: 'Ollama (local)', cloud: false, defaultUrl: 'http://127.0.0.1:11434/v1' },
  { id: 'openai', label: 'ChatGPT (OpenAI)', cloud: true },
  { id: 'gemini', label: 'Gemini (Google)', cloud: true },
  { id: 'anthropic', label: 'Claude (Anthropic)', cloud: true },
];

export const CLOUD_PROVIDER_IDS = PROVIDERS.filter((p) => p.cloud).map((p) => p.id);
export const LOCAL_PROVIDER_URLS = Object.fromEntries(
  PROVIDERS.filter((p) => !p.cloud && p.defaultUrl).map((p) => [p.id, p.defaultUrl]),
);
