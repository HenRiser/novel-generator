import { API_BASE_URL, safePublicMessage } from './api';
import { inspectCoverBlob } from './coverStorage';
import { isImageProtocol } from './imageConnections';
import { requestFingerprint, type ConnectionLease } from './providerConnections';

export type ImageData = { mime_type: 'image/png' | 'image/jpeg' | 'image/webp'; data_base64: string; width: number; height: number };
export type ImageResult = { image: ImageData; model: string; usage?: Record<string, unknown> };
export type ImageModelsResult = { models: Array<{ id: string; name: string }>; catalog_supported?: boolean; truncated?: boolean };
export type ImageInput = { prompt: string; size: '2K'; image?: Pick<ImageData, 'mime_type' | 'data_base64'> };
const MAX_IMAGE_BYTES = 8 * 1024 * 1024, MAX_JSON_BYTES = 12 * 1024 * 1024;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => { signal.removeEventListener('abort', aborted); reject(signal.reason); };
    pending.then(value => { signal.removeEventListener('abort', aborted); resolve(value); }, error => { signal.removeEventListener('abort', aborted); reject(error); });
    signal.addEventListener('abort', aborted, { once: true }); if (signal.aborted) aborted();
  });
}

async function imageBlob(value: unknown): Promise<{ blob: Blob; dimensions: Awaited<ReturnType<typeof inspectCoverBlob>> }> {
  if (!record(value) || typeof value.mime_type !== 'string' || !['image/png', 'image/jpeg', 'image/webp'].includes(value.mime_type) || typeof value.data_base64 !== 'string'
    || !value.data_base64 || value.data_base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || value.data_base64.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data_base64)) throw new Error('图片数据格式无效或超过 8 MiB。');
  const binary = atob(value.data_base64);
  if (binary.length > MAX_IMAGE_BYTES || btoa(binary) !== value.data_base64) throw new Error('图片数据格式无效或超过 8 MiB。');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < bytes.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: value.mime_type as string });
  return { blob, dimensions: await inspectCoverBlob(blob) };
}
async function responseJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length && Number(length) > MAX_JSON_BYTES) { void response.body?.cancel().catch(() => undefined); throw new Error('图片响应超过大小限制，未应用结果。'); }
  if (!response.body) throw new Error('图片响应为空，未应用结果。');
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, body = '';
  try {
    while (true) {
      const { value, done } = await abortable(reader.read(), signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_JSON_BYTES) throw new Error('图片响应超过大小限制，未应用结果。');
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    try { return JSON.parse(body); } catch { throw new Error('图片响应不是完整合法的 JSON，未应用结果。'); }
  } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
export function requestImage(operation: 'generate' | 'edit', input: ImageInput, lease: ConnectionLease, signal?: AbortSignal): Promise<ImageResult>;
export function requestImage(operation: 'models', input: Record<string, never>, lease: ConnectionLease, signal?: AbortSignal): Promise<ImageModelsResult>;
export async function requestImage(operation: 'generate' | 'edit' | 'models', input: ImageInput | Record<string, never>, lease: ConnectionLease, signal?: AbortSignal): Promise<ImageResult | ImageModelsResult> {
  if (!['generate', 'edit', 'models'].includes(operation) || !isImageProtocol(lease.snapshot.protocol)) throw new Error('请选择图片连接。');
  const snapshot = structuredClone(lease.snapshot), active = AbortSignal.any([lease.signal, AbortSignal.timeout(190000), ...(signal ? [signal] : [])]);
  const check = async () => { active.throwIfAborted(); await abortable(lease.check(), active); active.throwIfAborted(); };
  await check();
  if (operation !== 'models') {
    const request = input as ImageInput;
    if (typeof request.prompt !== 'string' || !request.prompt.trim() || request.prompt.length > 6000 || request.size !== '2K' || !snapshot.model) throw new Error('请输入 1–6000 字符的图片描述，并选择模型。');
    if (operation === 'generate' && request.image || operation === 'edit' && !request.image) throw new Error('修改图片需要原图；生成新图不应携带原图。');
    if (request.image) await abortable(imageBlob(request.image), active);
  }
  await check();
  const identity = { run_id: crypto.randomUUID(), step_id: crypto.randomUUID(), attempt_id: crypto.randomUUID(), input_revision: 0,
    request_fingerprint: await requestFingerprint(snapshot, operation, input) };
  const body = JSON.stringify({ ...identity, protocol_version: 2, connection: snapshot, credentials: { api_key: lease.apiKey }, input });
  if (new TextEncoder().encode(body).byteLength > MAX_JSON_BYTES) throw new Error('图片请求超过大小限制，请缩小原图。');
  await check();
  let response: Response, payload: unknown;
  try {
    response = await abortable(fetch(`${API_BASE_URL}/api/compute/images/${operation}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body, signal: active, cache: 'no-store' }), active);
    payload = await responseJson(response, active);
  } catch (error) {
    active.throwIfAborted();
    if (error instanceof TypeError) throw new Error(operation === 'models' ? '无法读取图片模型目录，请检查连接后重试。' : '图片连接中断，结果未确认。请手动检查；再次生成可能计费。');
    throw error;
  }
  await check();
  if (!response.ok) throw new Error(safePublicMessage(record(payload) && record(payload.error) ? payload.error.message : undefined, `图片请求失败（${response.status}）。请手动重试，生图请求可能已经计费。`));
  if (!record(payload) || payload.protocol_version !== 2 || payload.destination_fingerprint !== snapshot.destination_fingerprint || payload.execution_fingerprint !== snapshot.execution_fingerprint
    || (Object.keys(identity) as Array<keyof typeof identity>).some(k => payload[k] !== identity[k]) || !record(payload.result)) throw new Error('图片结果与当前任务版本不匹配，未应用结果。');
  const result = payload.result;
  if (operation === 'models') {
    if (!Array.isArray(result.models) || result.models.length > 1000 || !result.models.every(m => record(m) && typeof m.id === 'string' && !!m.id.trim() && m.id.length <= 256 && typeof m.name === 'string' && m.name.length <= 256)
      || result.catalog_supported !== undefined && typeof result.catalog_supported !== 'boolean') throw new Error('图片模型列表格式无效。');
    return result as ImageModelsResult;
  }
  const { dimensions } = await abortable(imageBlob(result.image), active);
  if (!record(result.image) || result.image.width !== dimensions.width || result.image.height !== dimensions.height || typeof result.model !== 'string' || result.model !== snapshot.model
    || result.usage !== undefined && !record(result.usage)) throw new Error('图片结果的尺寸或模型信息无效，未应用结果。');
  await check(); return result as ImageResult;
}
