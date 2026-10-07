export type CapabilityPolicy = {
  version: 1; source: 'official_catalog' | 'user_override'; token_field: 'max_tokens' | 'max_completion_tokens';
  temperature: 'omit' | 'range' | 'fixed'; temperature_min: number; temperature_max: number; temperature_fixed: number;
  stream_usage: boolean; structured: 'json_schema' | 'json_object' | 'prompt_only' | 'unsupported';
};
export type ConnectionSnapshot = {
  profile_id: string; revision: number; preset: string; protocol: 'chat_completions' | 'messages' | 'seedream_images' | 'openai_images' | 'gemini_images' | 'qwen_images'; base_url: string;
  model: string; policy: CapabilityPolicy; auth_mode: 'key' | 'none'; destination_fingerprint: string; execution_fingerprint: string;
};
export type ConnectionGuard = { profile_id: string; epoch: number; destination_fingerprint: string; key_version: string };
export type ConnectionProfile = { id: string; name: string; enabled: boolean; deleted: boolean; epoch: number; key_version: string;
  head: number; revisions: ConnectionSnapshot[]; draft?: ConnectionSnapshot;
  models?: Array<{ id: string; name: string }>; test?: { revision: number; key_version: string; at: string; result: Record<string, unknown> };
};
export type ProviderPreset = { id: string; name: string; protocol: ConnectionSnapshot['protocol']; url: string; policy: CapabilityPolicy; regions?: Array<{ id: string; name: string; url: string }> };
export type ProviderCapabilities = { protocol_version: number; providers: ProviderPreset[]; supported_protocols: string[]; image_providers?: Array<Omit<ProviderPreset, 'policy'> & { policy?: CapabilityPolicy; model?: string; default_model?: string; models?: Array<{ id: string; name: string }> }>; stream_operations?: string[]; planning_stream_version?: number };
export const LEGACY_CONNECTION = 'legacy-deepseek';
