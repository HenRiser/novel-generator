import { API_BASE_URL, safePublicMessage } from './api';
import { inspectCoverBlob } from './coverStorage';
import { isImageProtocol } from './imageConnections';
import { requestFingerprint, type ConnectionLease } from './providerConnections';
import type { CoverStyleId, CoverEditKind } from './providerTypes';

export type ImageData = { mime_type: 'image/png' | 'image/jpeg' | 'image/webp'; data_base64: string; width: number; height: number };
export type CoverImageResult = { image: ImageData; model: string; style_id: CoverStyleId; template_version: 1; text_model: string };
export type ImageModelsResult = { models: Array<{ id: string; name: string }>; catalog_supported?: boolean; truncated?: boolean };
export type CoverImageInput = { source: { idea: string; characters: string }; style_id: CoverStyleId; count: 1 | 2 | 4; size: '2K'; image?: Pick<ImageData, 'mime_type' | 'data_base64'>; edit_kind?: CoverEditKind };
export type CoverImageHandlers = { onProgress?: (stage: 'text' | 'image', index: number, requested: number) => void; onImage: (result: CoverImageResult, index: number) => Promise<void> };
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
export async function requestImage(operation: 'models', input: Record<string, never>, lease: ConnectionLease, signal?: AbortSignal): Promise<ImageModelsResult> {
  if (operation !== 'models') throw new Error('请使用受控封面生成，旧图片接口已停用。');
  if (!isImageProtocol(lease.snapshot.protocol)) throw new Error('请选择图片连接。');
  const snapshot = structuredClone(lease.snapshot), active = AbortSignal.any([lease.signal, AbortSignal.timeout(190000), ...(signal ? [signal] : [])]);
  const check = async () => { active.throwIfAborted(); await abortable(lease.check(), active); active.throwIfAborted(); };
  await check();
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
    if (error instanceof TypeError) throw new Error('无法读取图片模型目录，请检查连接后重试。');
    throw error;
  }
  await check();
  if (!response.ok) throw new Error(safePublicMessage(record(payload) && record(payload.error) ? payload.error.message : undefined, `图片请求失败（${response.status}）。请手动重试，生图请求可能已经计费。`));
  if (!record(payload) || payload.protocol_version !== 2 || payload.destination_fingerprint !== snapshot.destination_fingerprint || payload.execution_fingerprint !== snapshot.execution_fingerprint
    || (Object.keys(identity) as Array<keyof typeof identity>).some(k => payload[k] !== identity[k]) || !record(payload.result)) throw new Error('图片结果与当前任务版本不匹配，未应用结果。');
  const result = payload.result;
  if (!Array.isArray(result.models) || result.models.length > 1000 || !result.models.every(m => record(m) && typeof m.id === 'string' && !!m.id.trim() && m.id.length <= 256 && typeof m.name === 'string' && m.name.length <= 256)
    || result.catalog_supported !== undefined && typeof result.catalog_supported !== 'boolean') throw new Error('图片模型列表格式无效。');
  return result as ImageModelsResult;
}

/** Each candidate is validated and saved before the next event is consumed. */
export async function requestCoverImages(input: CoverImageInput, imageLease: ConnectionLease, textLease: ConnectionLease, handlers: CoverImageHandlers, signal?: AbortSignal): Promise<{ completed: number; requested: number }> {
  const image = structuredClone(imageLease.snapshot), text = structuredClone(textLease.snapshot), frozen = structuredClone(input);
  const operation = frozen.image ? 'cover_edit' : 'cover_generate';
  const active = AbortSignal.any([imageLease.signal, textLease.signal, AbortSignal.timeout(120000 * (frozen.count + 1) + 60000), ...(signal ? [signal] : [])]);
  const check = async () => { active.throwIfAborted(); await abortable(Promise.all([imageLease.check(), textLease.check()]), active); active.throwIfAborted(); };
  await check();
  if (!isImageProtocol(image.protocol) || !image.model || !['chat_completions', 'messages'].includes(text.protocol) || !text.model) throw new Error('请选择可用的图片连接和文字连接。');
  const allowed = ['source', 'style_id', 'count', 'size', 'image', 'edit_kind'];
  if (!record(frozen) || Object.keys(frozen).some(key => !allowed.includes(key)) || !record(frozen.source) || Object.keys(frozen.source).sort().join(',') !== 'characters,idea'
    || typeof frozen.source.idea !== 'string' || typeof frozen.source.characters !== 'string' || !frozen.source.idea.trim() || frozen.source.idea.length > 6000 || frozen.source.characters.length > 12000
    || !['cinematic', 'ink', 'anime', 'fantasy', 'minimal'].includes(frozen.style_id) || ![1, 2, 4].includes(frozen.count) || frozen.size !== '2K') throw new Error('请保存白话设定，并选择封面风格和 1、2 或 4 张候选。白话设定限 6000 字，人物卡限 12000 字。');
  if (operation === 'cover_edit' ? !['restyle', 'simplify_background', 'lighting'].includes(frozen.edit_kind || '') : frozen.edit_kind !== undefined) throw new Error('请选择原图的修改目标。');
  if (frozen.image) {
    if (!record(frozen.image) || Object.keys(frozen.image).sort().join(',') !== 'data_base64,mime_type') throw new Error('修改封面需要有效原图。');
    await abortable(imageBlob(frozen.image), active);
  }
  const wireInput = { ...frozen, text_connection: text };
  const identity = { run_id: crypto.randomUUID(), step_id: crypto.randomUUID(), attempt_id: crypto.randomUUID(), input_revision: 0, protocol_version: 2,
    request_fingerprint: await requestFingerprint(image, operation, wireInput) };
  const expected = { ...identity, destination_fingerprint: image.destination_fingerprint, execution_fingerprint: image.execution_fingerprint,
    text_destination_fingerprint: text.destination_fingerprint, text_execution_fingerprint: text.execution_fingerprint };
  const body = JSON.stringify({ ...identity, connection: image, credentials: { api_key: imageLease.apiKey, text_api_key: textLease.apiKey }, input: wireInput });
  if (new TextEncoder().encode(body).byteLength > MAX_JSON_BYTES) throw new Error('图片请求超过大小限制，请缩小原图。');
  await check();
  let response: Response;
  try { response = await abortable(fetch(`${API_BASE_URL}/api/compute/images/cover/${frozen.image ? 'edit' : 'generate'}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body, signal: active, cache: 'no-store' }), active); }
  catch (error) { active.throwIfAborted(); if (error instanceof TypeError) throw new Error('图片连接中断，结果未确认。再次生成可能计费。'); throw error; }
  if (!response.ok) {
    const payload = await responseJson(response, active); await check();
    throw new Error(safePublicMessage(record(payload) && record(payload.error) ? payload.error.message : undefined, `封面请求失败（${response.status}），不会自动重试。`));
  }
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/x-ndjson') || !response.body) throw new Error('封面响应格式无效，未应用结果。');
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', bytes = 0, seq = 0, completed = 0, phase: 'initial' | 'started' | 'text' | 'ready' | 'image' | 'done' = 'initial';
  const event = async (line: string) => {
    if (new TextEncoder().encode(line).byteLength > MAX_JSON_BYTES) throw new Error('封面响应单行超过大小限制。');
    let value: unknown; try { value = JSON.parse(line); } catch { throw new Error('封面响应不是合法的逐行数据。'); }
    await check();
    if (!record(value) || value.event_version !== 1 || value.seq !== ++seq || Object.entries(expected).some(([key, expectedValue]) => value[key] !== expectedValue)) throw new Error('封面结果与当前任务版本不匹配，未应用结果。');
    const kind = value.type;
    const fields: Record<string, string[]> = { started: ['requested'], text_started: [], text_done: [], image_started: ['index'], image: ['index', 'result'], done: ['completed', 'requested'], error: ['code', 'message', 'status', 'completed', 'requested'] };
    if (typeof kind !== 'string' || !Object.prototype.hasOwnProperty.call(fields, kind) || Object.keys(value).some(key => ![...Object.keys(expected), 'event_version', 'seq', 'type', ...fields[kind]].includes(key))) throw new Error('封面响应包含未支持的数据，未应用结果。');
    if (kind === 'started' && phase === 'initial' && value.requested === frozen.count) phase = 'started';
    else if (kind === 'text_started' && phase === 'started') { phase = 'text'; handlers.onProgress?.('text', 0, frozen.count); }
    else if (kind === 'text_done' && phase === 'text') phase = 'ready';
    else if (kind === 'image_started' && phase === 'ready' && value.index === completed && completed < frozen.count) { phase = 'image'; handlers.onProgress?.('image', completed, frozen.count); }
    else if (kind === 'image' && phase === 'image' && value.index === completed && record(value.result)) {
      const result = value.result;
      if (Object.keys(result).sort().join(',') !== 'image,model,style_id,template_version,text_model' || result.model !== image.model || result.text_model !== text.model || result.style_id !== frozen.style_id || result.template_version !== 1) throw new Error('图片结果的模型或风格信息无效，未应用结果。');
      const { dimensions } = await abortable(imageBlob(result.image), active);
      if (!record(result.image) || Object.keys(result.image).sort().join(',') !== 'data_base64,height,mime_type,width' || result.image.width !== dimensions.width || result.image.height !== dimensions.height) throw new Error('图片结果的尺寸信息无效，未应用结果。');
      // Let an accepted local save finish before reporting cancellation; it cannot overwrite the later failure state.
      await check(); await handlers.onImage(result as CoverImageResult, completed); completed++; await check(); phase = 'ready';
    } else if (kind === 'done' && phase === 'ready' && value.completed === completed && completed === frozen.count && value.requested === frozen.count) phase = 'done';
    else if (kind === 'error' && phase !== 'initial' && phase !== 'done' && value.completed === completed && value.requested === frozen.count && typeof value.code === 'string' && typeof value.status === 'number') {
      throw new Error(safePublicMessage(value.message, `封面生成中断，已保存 ${completed}/${frozen.count} 张；不会自动重试。`));
    } else throw new Error('封面响应的阶段或图片顺序无效，已保存的候选会保留。');
  };
  try {
    while (true) {
      const next = await abortable(reader.read(), active);
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 48 * 1024 * 1024) throw new Error('封面响应总量超过大小限制。');
      buffer += decoder.decode(next.value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, newline).replace(/\r$/, ''); buffer = buffer.slice(newline + 1); if (!line) throw new Error('封面响应包含空事件。'); await event(line); }
      if (buffer.length > MAX_JSON_BYTES) throw new Error('封面响应单行超过大小限制。');
    }
    buffer += decoder.decode();
    if (buffer) await event(buffer);
    await check(); if ((phase as string) !== 'done') throw new Error(`封面连接提前结束，已保存 ${completed}/${frozen.count} 张；不会自动重试。`);
    return { completed, requested: frozen.count };
  } catch (error) { active.throwIfAborted(); if (error instanceof TypeError) throw new Error(`图片连接中断，已保存 ${completed}/${frozen.count} 张；再次生成可能计费。`); throw error; }
  finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
