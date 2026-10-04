import { API_BASE_URL, safePublicMessage } from './api';
import { acquireConnection, resolveConnection, requestFingerprint, type ConnectionLease } from './providerConnections';
import { PlanningEventContract, type PlanningEvent, type PlanningProgress } from './planningStreamContract';

export type ComputeIdentity = { run_id: string; step_id: string; attempt_id: string; input_revision: number; request_fingerprint?: string };
export type ComputeResult = { result: Record<string, unknown>; metrics: Record<string, unknown> };
export const MODEL_OPERATIONS = new Set(['connection_test', 'list_models', 'expand_setting', 'generate_outline', 'generate_characters', 'generate_chapter', 'continue_chapter', 'summarize_chapter', 'story_delta', 'import_chapter', 'import_synthesis', 'plan_chapter']);
const TIMEOUT_MS = 190_000; // Server: 120 s per model call, 180 s per step, plus transport allowance.
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function newIdentity(input_revision = 0): ComputeIdentity {
  return { run_id: crypto.randomUUID(), step_id: crypto.randomUUID(), attempt_id: crypto.randomUUID(), input_revision };
}

/** Credential-free checkpoints use the exact snapshot captured before this preflight. */
export function prepareCompute(operation: string, input: Record<string, unknown>, identity: ComputeIdentity, lease?: ConnectionLease): string {
  const modelCall = MODEL_OPERATIONS.has(operation);
  if (modelCall && !lease) throw new Error('模型请求缺少已绑定连接。');
  if (lease) {
    if(operation!=='list_models'&&!lease.snapshot.model)throw new Error('请选择或输入模型ID。');
    const structured = ['expand_setting','story_delta','import_chapter','import_synthesis','plan_chapter'].includes(operation) || (operation === 'summarize_chapter' && input.review_scope === 'semantic_and_rules');
    if (structured && lease.snapshot.policy.structured === 'unsupported') throw new Error('此模型尚未启用结构化输出，请在连接能力设置中选择模式。');
    lease.signal.throwIfAborted();
  }
  const body = JSON.stringify({ ...identity, ...(lease ? {protocol_version:2,connection:lease.snapshot} : {}), credentials: lease ? {api_key:lease.apiKey} : {}, input });
  if (new TextEncoder().encode(body).byteLength > 1024 * 1024) throw new Error('本次计算上下文超过 1 MiB，请缩小输入范围。');
  return body;
}
async function leaseFor(operation:string,input:Record<string,unknown>,signal?:AbortSignal,temporaryKey?:string){
  if(!MODEL_OPERATIONS.has(operation))return undefined;
  const request=input.request as Record<string,unknown>|undefined,config=input.config as Record<string,unknown>|undefined;
  const connection=await resolveConnection(typeof config?.connection_id==='string'?config.connection_id:undefined,typeof request?.model==='string'?request.model:typeof config?.model==='string'?config.model:undefined);
  return acquireConnection(connection,signal,temporaryKey);
}

async function send(operation: string, input: Record<string, unknown>, identity: ComputeIdentity, signal?: AbortSignal, stream = false, lease?: ConnectionLease): Promise<Response> {
  signal?.throwIfAborted();
  if(lease){await lease.check();signal=signal?AbortSignal.any([signal,lease.signal]):lease.signal;}
  if(lease) identity.request_fingerprint = await requestFingerprint(lease.snapshot,operation,input);
  const body = prepareCompute(operation, input, identity, lease);
  const response = await fetch(`${API_BASE_URL}/api/compute/${operation}${stream ? '/stream' : ''}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: stream ? 'application/x-ndjson' : 'application/json' },
    body, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS), cache: 'no-store',
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(safePublicMessage(payload?.error?.message, `计算失败（${response.status}），已保存的数据保留。`));
  }
  return response;
}

function verifyIdentity(payload: unknown, identity: ComputeIdentity, lease?: ConnectionLease): asserts payload is Record<string, unknown> {
  if (!record(payload) || (lease && (payload.request_fingerprint!==identity.request_fingerprint || payload.protocol_version!==2 || payload.destination_fingerprint!==lease.snapshot.destination_fingerprint || payload.execution_fingerprint!==lease.snapshot.execution_fingerprint)) || (['run_id', 'step_id', 'attempt_id', 'input_revision'] as const).some(key => payload[key] !== identity[key])) throw new Error('计算结果与当前任务版本不匹配，未保存。');
}
function verified(payload: unknown, identity: ComputeIdentity, lease?: ConnectionLease): ComputeResult {
  verifyIdentity(payload, identity, lease);
  if (!record(payload.result)) throw new Error('计算结果格式不完整，未保存。');
  return { result: payload.result, metrics: record(payload.metrics) ? payload.metrics : {} };
}

export async function compute(operation: string, input: Record<string, unknown>, identity = newIdentity(), signal?: AbortSignal, apiKey?: string, bound?: ConnectionLease): Promise<ComputeResult> {
  const lease=bound||await leaseFor(operation,input,signal,apiKey);
  try { const result=verified(await (await send(operation,input,identity,signal,false,lease)).json(),identity,lease);await lease?.check();return result; }
  finally {if(!bound)lease?.close();}
}

export async function computeStream(operation: string, input: Record<string, unknown>, identity: ComputeIdentity,
  handlers: { onStarted?: (context: Record<string, unknown>) => Promise<void>; onDelta?: (text: string) => void | Promise<void>; onReasoning?: (text: string) => void }, signal?: AbortSignal, bound?: ConnectionLease): Promise<ComputeResult> {
  const lease=bound||await leaseFor(operation,input,signal);
  try {
  const response = await send(operation, input, identity, signal, true, lease);
  if (!response.body) throw new Error('流式响应不可用。');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', started = false;
  let completed: ComputeResult | undefined;
  async function line(text: string) {
    if (!text.trim()) return;
    const event: unknown = JSON.parse(text);
    verifyIdentity(event, identity, lease); // Validate every fragment before preview/checkpoint writes.
    if (completed) throw new Error('完成事件之后收到额外结果。');
    if (event.type === 'error') throw new Error(safePublicMessage(event.message, '计算中断，请手动重试。'));
    if (event.type === 'started') {
      if (started) throw new Error('收到重复的开始事件。');
      started = true; await handlers.onStarted?.(record(event.frozen_context) ? event.frozen_context : {}); return;
    }
    if (!started) throw new Error('流式响应缺少开始事件。');
    if (event.type === 'delta' && typeof event.text === 'string') await handlers.onDelta?.(event.text);
    else if (event.type === 'reasoning' && typeof event.text === 'string') handlers.onReasoning?.(event.text);
    else if (event.type === 'done') completed = verified(event, identity, lease);
    else throw new Error('未知的流式事件。');
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) { await line(buffer.slice(0, index)); buffer = buffer.slice(index + 1); }
      if (done) break;
    }
    if (buffer.trim()) await line(buffer);
    if (!completed) throw new Error('连接提前结束，结果未知。手动重试可能再次计费。');
    await lease?.check(); return completed;
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  } finally { if(!bound)lease?.close(); }
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => { signal.removeEventListener('abort', aborted); reject(signal.reason); };
    pending.then(value => { signal.removeEventListener('abort', aborted); resolve(value); },
      error => { signal.removeEventListener('abort', aborted); reject(error); });
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

/** Planning has its own event contract; only normal EOF can return a candidate. */
export async function computePlanningStream(input: Record<string, unknown>, identity: ComputeIdentity,
  handlers: { onProgress?: (progress: Readonly<PlanningProgress>, active: AbortSignal) => void | Promise<void> } = {}, signal?: AbortSignal, bound?: ConnectionLease): Promise<ComputeResult> {
  const chapterNumber = input.chapter_number;
  if (typeof chapterNumber !== 'number' || !Number.isSafeInteger(chapterNumber) || chapterNumber < 1) throw new Error('策划目标章节无效。');
  const requestIdentity = { ...identity };
  const controller = new AbortController();
  const lifetime = AbortSignal.any([controller.signal, AbortSignal.timeout(TIMEOUT_MS), ...(signal ? [signal] : [])]);
  let lease = bound;
  try {
    lifetime.throwIfAborted();
    if (!lease) {
      const acquisition = leaseFor('plan_chapter', input, lifetime);
      try { lease = await abortable(acquisition, lifetime); }
      catch (error) { void acquisition.then(late => late?.close(), () => undefined); throw error; }
    }
    if (!lease) throw new Error('策划请求缺少已绑定连接。');
    const active = AbortSignal.any([lifetime, lease.signal]);
    async function check() {
      active.throwIfAborted();
      await abortable(lease!.check(), active);
      active.throwIfAborted();
    }
    const destination = lease.snapshot.destination_fingerprint, execution = lease.snapshot.execution_fingerprint;
    await check();
    const response = await abortable(send('plan_chapter', input, requestIdentity, active, true, lease), active);
    await check();
    if (!response.body) throw new Error('策划流式响应格式无效。');
    const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
    try {
      if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/x-ndjson') throw new Error('策划流式响应格式无效。');
      const parser = new PlanningEventContract({ ...requestIdentity, protocol_version: 2, request_fingerprint: requestIdentity.request_fingerprint!,
        destination_fingerprint: destination, execution_fingerprint: execution }, chapterNumber);
      let buffer = '', receivedBytes = 0;
      let metrics: Record<string, unknown> | undefined;
      async function line(text: string) {
        await check();
        if (!text.trim() || text.length > 1024 * 1024) throw new Error('策划事件为空或超过大小限制。');
        let value: unknown;
        try { value = JSON.parse(text); } catch { throw new Error('策划流式事件不是完整合法的 JSON，未应用结果。'); }
        parser.accept(value);
        await check();
        const event = value as PlanningEvent;
        if (event.type === 'error') throw new Error(safePublicMessage(event.message, '策划中断，请手动重试。'));
        if (event.type === 'progress' && handlers.onProgress) {
          const progress = Object.freeze({ event_version: event.event_version, seq: event.seq, chapter_number: event.chapter_number,
            type: event.type, node: event.node, visit: event.visit, status: event.status, elapsed_ms: event.elapsed_ms });
          await abortable(Promise.resolve().then(() => { active.throwIfAborted(); return handlers.onProgress!(progress, active); }), active);
          await check();
        } else if (event.type === 'done') metrics = structuredClone(event.metrics);
      }
      while (true) {
        await check();
        const { value, done } = await abortable(reader.read(), active);
        active.throwIfAborted();
        if (value) receivedBytes += value.byteLength;
        if (receivedBytes > 2 * 1024 * 1024) throw new Error('策划响应超过 2 MiB，未应用结果。');
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf('\n')) >= 0) {
          await line(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
        }
        if (buffer.length > 1024 * 1024) throw new Error('策划事件超过大小限制。');
        if (done) break;
      }
      if (buffer) await line(buffer);
      const result = parser.finish();
      await check();
      active.throwIfAborted();
      return { result: result as unknown as Record<string, unknown>, metrics: metrics! };
    } finally {
      // A hostile underlying cancel promise must not hold the reader or connection open.
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } finally { controller.abort(); if (!bound) lease?.close(); }
}
