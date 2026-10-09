import { API_BASE_URL, safePublicMessage } from './api';
import { getSetting, listSettings, setSetting } from './localStore';
import { notifyConnection } from './keyVault';
import { acquireConnection, capabilities, connectionLock, defaultPolicy, getConnection, hash, stable, type ConnectionLease } from './providerConnections';
import type { ConnectionProfile, ConnectionSnapshot, ProviderPreset } from './providerTypes';

export type ImageProtocol = 'seedream_images' | 'openai_images' | 'gemini_images' | 'qwen_images';
export type ImageConnectionSnapshot = ConnectionSnapshot & { protocol: ImageProtocol };
export type ImageProviderPreset = Omit<ProviderPreset, 'protocol' | 'policy'> & { protocol: ImageProtocol; policy?: ConnectionSnapshot['policy']; default_model?: string; model?: string; models?: Array<{ id: string; name: string }> };
export const IMAGE_PRESETS: ImageProviderPreset[] = [
  { id: 'seedream', name: 'Seedream · 火山方舟', protocol: 'seedream_images', url: 'https://ark.cn-beijing.volces.com/api/v3', default_model: 'doubao-seedream-5-0-flash-260915', policy: defaultPolicy() },
  { id: 'openai', name: 'OpenAI', protocol: 'openai_images', url: 'https://api.openai.com/v1', default_model: 'gpt-image-1.5', policy: defaultPolicy() },
  { id: 'gemini', name: 'Google Gemini', protocol: 'gemini_images', url: 'https://generativelanguage.googleapis.com/v1beta', default_model: 'gemini-3.1-flash-image', policy: defaultPolicy() },
  { id: 'qwen', name: '阿里云百炼', protocol: 'qwen_images', url: 'https://dashscope.aliyuncs.com/api/v1', default_model: 'qwen-image-3.0-pro', policy: defaultPolicy() },
  { id: 'custom', name: '自定义地址', protocol: 'openai_images', url: '', default_model: '', policy: defaultPolicy() },
];
export function isImageProtocol(protocol: string): protocol is ImageProtocol { return ['seedream_images', 'openai_images', 'gemini_images', 'qwen_images'].includes(protocol); }
export function blankImageConnection(preset = IMAGE_PRESETS[0]): ImageConnectionSnapshot {
  return { profile_id: crypto.randomUUID(), revision: 1, preset: preset.id, protocol: preset.protocol, base_url: preset.url,
    model: preset.default_model ?? preset.model ?? '', policy: defaultPolicy(), auth_mode: 'key', destination_fingerprint: '', execution_fingerprint: '' };
}
export function imageSnapshot(profile: ConnectionProfile): ImageConnectionSnapshot | undefined {
  const snapshot = profile.draft || profile.revisions.find(r => r.revision === profile.head);
  return snapshot && isImageProtocol(snapshot.protocol) ? snapshot as ImageConnectionSnapshot : undefined;
}
export async function imageConnections(): Promise<ConnectionProfile[]> { return (await listSettings<ConnectionProfile>('connection:')).filter(p => !p.deleted && imageSnapshot(p)); }
export async function imageProviderPresets(signal?: AbortSignal): Promise<ImageProviderPreset[]> {
  const catalog = await capabilities(false, signal);
  const presets = (catalog.image_providers || []).filter(p => isImageProtocol(p.protocol)) as ImageProviderPreset[];
  return [...(presets.length ? presets : IMAGE_PRESETS.filter(p => p.id !== 'custom')), IMAGE_PRESETS.find(p => p.id === 'custom')!];
}
export async function defaultImageConnectionId(): Promise<string> { return await getSetting<string>('default_image_connection') || ''; }
export async function fallbackImageConnectionId(): Promise<string> { return await getSetting<string>('fallback_image_connection') || ''; }
export async function setFallbackImageConnection(id: string) {
  if (!id) { await setSetting('fallback_image_connection', ''); notifyConnection(''); return; }
  const profile = await getConnection(id), snapshot = profile.revisions.find(item => item.revision === profile.head);
  if (!profile.enabled || profile.deleted || !profile.revisions.length || snapshot?.preset !== 'seedream' || snapshot.model !== 'doubao-seedream-5-0-flash-260915') throw new Error('请先保存并启用 Seedream 5.0 Flash 图片连接。');
  await setSetting('fallback_image_connection', id); notifyConnection(id);
}
export async function setDefaultImageConnection(id: string) {
  const profile = await getConnection(id);
  if (!profile.enabled || profile.deleted || !imageSnapshot(profile) || !profile.revisions.length) throw new Error('请先保存并启用图片连接。');
  await setSetting('default_image_connection', id); notifyConnection(id);
}
export async function validateImageConnection(raw: ConnectionSnapshot, signal?: AbortSignal): Promise<ImageConnectionSnapshot> {
  if (!isImageProtocol(raw.protocol)) throw new Error('请选择图片服务商。');
  const catalog = await capabilities(true, signal);
  if (!catalog.image_providers?.some(p => p.protocol === raw.protocol)) throw new Error('当前计算服务尚未支持此图片服务商，未发送任何 Key。');
  const identity = { run_id: crypto.randomUUID(), step_id: crypto.randomUUID(), attempt_id: crypto.randomUUID(), input_revision: 0 };
  const response = await fetch(API_BASE_URL + '/api/compute/images/validate_connection', { method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
    signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]),
    body: JSON.stringify({ ...identity, protocol_version: 2, connection: raw, credentials: {}, input: {} }) });
  const body = await response.text();
  if (body.length > 64 * 1024) throw new Error('图片连接校验响应超过大小限制。');
  let payload;
  try { payload = JSON.parse(body); } catch { throw new Error('图片连接校验返回了无效结果。'); }
  if (!response.ok) throw new Error(safePublicMessage(payload?.error?.message, '图片连接地址或模型设置无效。'));
  if (payload.protocol_version !== 2 || (Object.keys(identity) as Array<keyof typeof identity>).some(k => payload[k] !== identity[k])) throw new Error('图片连接校验结果与当前配置不匹配。');
  const normalized = payload.result?.connection as ConnectionSnapshot | undefined;
  if (!normalized || normalized.profile_id !== raw.profile_id || normalized.revision !== raw.revision || normalized.protocol !== raw.protocol || normalized.preset !== raw.preset || normalized.model !== raw.model.trim()
    || normalized.auth_mode !== raw.auth_mode || JSON.stringify(stable(normalized.policy)) !== JSON.stringify(stable(defaultPolicy())) || typeof normalized.base_url !== 'string') throw new Error('图片连接校验结果格式无效。');
  let expectedUrl: URL;
  try { expectedUrl = new URL(raw.base_url.trim()); } catch { throw new Error('图片服务地址无效。'); }
  expectedUrl.hostname = expectedUrl.hostname.replace(/\.$/, '');
  if (expectedUrl.protocol !== 'https:' || expectedUrl.username || expectedUrl.password || expectedUrl.search || expectedUrl.hash || normalized.base_url !== expectedUrl.href.replace(/\/+$/, '')) throw new Error('图片连接校验返回了不同的目的地址，未保存。');
  const destination = await hash('endpoint-v1\n' + normalized.protocol + '\n' + normalized.base_url);
  const execution = await hash(JSON.stringify(stable({ destination, model: normalized.model, policy: normalized.policy, auth_mode: normalized.auth_mode })));
  if (normalized.destination_fingerprint !== destination || normalized.execution_fingerprint !== execution || payload.destination_fingerprint !== destination || payload.execution_fingerprint !== execution) throw new Error('图片连接校验指纹不匹配。');
  signal?.throwIfAborted(); return normalized as ImageConnectionSnapshot;
}
export async function saveImageConnection(name: string, raw: ConnectionSnapshot, asDraft = false): Promise<ConnectionProfile> {
  if (!name.trim() || name.length > 80) throw new Error('连接名称为 1–80 字符。');
  if (!isImageProtocol(raw.protocol)) throw new Error('请选择图片服务商。');
  return connectionLock(raw.profile_id, async () => {
    const old = await getSetting<ConnectionProfile>('connection:' + raw.profile_id);
    if (old?.deleted) throw new Error('此连接已删除，请新建连接。');
    if (old && (old.draft?.revision ?? old.head) !== raw.revision) throw new Error('连接已在另一处修改，请重新加载。');
    const candidate = { ...raw, policy: defaultPolicy(), revision: old ? old.head + 1 : 1 };
    const normalized = asDraft ? candidate : await validateImageConnection(candidate);
    if (old?.revisions.length && (normalized.base_url !== old.revisions[0].base_url || normalized.protocol !== old.revisions[0].protocol || normalized.auth_mode !== old.revisions[0].auth_mode)) throw new Error('地址变更请复制为新连接，并重新填写 Key。');
    const profile: ConnectionProfile = { ...(old || { id: raw.profile_id, epoch: 0, key_version: crypto.randomUUID(), revisions: [], deleted: false }), name: name.trim(), enabled: !asDraft && (old?.revisions.length ? old.enabled : true),
      head: asDraft ? old?.head || 0 : normalized.revision, revisions: asDraft ? old?.revisions || [] : [...(old?.revisions || []), normalized], draft: asDraft ? candidate : undefined, test: undefined };
    await setSetting('connection:' + profile.id, profile); notifyConnection(profile.id); return profile;
  });
}
export async function resolveImageConnection(id?: string, model?: string): Promise<ImageConnectionSnapshot> {
  const target = id || await defaultImageConnectionId();
  if (!target) throw new Error('请先在「偏好设置 → 图片模型连接」保存图片连接。');
  const profile = await getConnection(target), snapshot = profile.revisions.find(r => r.revision === profile.head);
  if (!profile.enabled || profile.deleted || !snapshot || !isImageProtocol(snapshot.protocol)) throw new Error('图片连接不可用，请重新选择已启用的连接。');
  return !model || model === snapshot.model ? snapshot as ImageConnectionSnapshot : validateImageConnection({ ...snapshot, model });
}
export async function resolveFallbackImageConnection(id: string): Promise<ImageConnectionSnapshot> {
  const snapshot = await resolveImageConnection(id);
  if (snapshot.preset !== 'seedream' || snapshot.protocol !== 'seedream_images' || snapshot.model !== 'doubao-seedream-5-0-flash-260915') throw new Error('兜底连接已更改，请重新选择已保存的 Seedream 5.0 Flash 连接。');
  return snapshot;
}
export async function acquireImageConnection(snapshot: ConnectionSnapshot, signal?: AbortSignal, temporaryKey?: string): Promise<ConnectionLease> {
  if (!isImageProtocol(snapshot.protocol)) throw new Error('请选择图片连接。');
  try { return await acquireConnection(snapshot, signal, temporaryKey); }
  catch (error) { throw error instanceof Error ? new Error(error.message.replace(/偏好设置 → 模型连接/g, '偏好设置 → 图片模型连接')) : error; }
}
