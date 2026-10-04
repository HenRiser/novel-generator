import type { ComputeIdentity } from './computeClient';
import { validatePlanningResult, type PlanningResult } from './planningInput';

export const PLANNING_EVENT_VERSION = 1;
export const MAX_PLANNING_PROGRESS = 32;
export const PLANNING_NODES = ['context_pack', 'initial_proposal', 'validate', 'repair_once'] as const;
export type PlanningNode = typeof PLANNING_NODES[number];
export type PlanningEventIdentity = ComputeIdentity & {
  protocol_version: 2; request_fingerprint: string; destination_fingerprint: string; execution_fingerprint: string;
};
export type PlanningProgress = {
  event_version: 1; seq: number; chapter_number: number; type: 'progress';
  node: PlanningNode; visit: number; status: 'started' | 'finished' | 'failed'; elapsed_ms: number;
};
type Envelope = PlanningEventIdentity & { event_version: 1; seq: number; chapter_number: number };
export type PlanningEvent = Envelope & (
  { type: 'started' } | PlanningProgress |
  { type: 'done'; result: PlanningResult; metrics: Record<string, unknown> } |
  { type: 'error'; code: string; message: string; status: number }
);

const IDENTITY_FIELDS = ['run_id', 'step_id', 'attempt_id', 'input_revision', 'protocol_version', 'request_fingerprint', 'destination_fingerprint', 'execution_fingerprint'] as const;
const BASE_FIELDS = [...IDENTITY_FIELDS, 'event_version', 'seq', 'chapter_number', 'type'];
const PATH = ['context_pack', 'initial_proposal', 'validate', 'repair_once', 'validate'] as const;
const RESULT_FIELDS = ['graph_version', 'chapter_number', 'status', 'task_payload', 'scene_proposal', 'issues', 'repair_count', 'nodes', 'excluded_records', 'warnings'];
const TOKEN_FIELDS = ['prompt_tokens', 'completion_tokens', 'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens', 'reasoning_tokens'];
const TIME_FIELDS = ['first_content_ms', 'body_complete_ms'];
const METRIC_FIELDS = ['operation', 'protocol_version', 'elapsed_ms', 'call_count', ...TOKEN_FIELDS, ...TIME_FIELDS, 'repair_used'];
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, fields: readonly string[]) => Object.keys(v).length === fields.length && fields.every(k => Object.prototype.hasOwnProperty.call(v, k));
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const elapsed = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
function invalid(): never { throw new Error('策划事件违反版本、身份或执行顺序契约，未应用结果。'); }

/** Select before sending; this does not authorize retrying an unknown result. */
export function selectPlanningTransport(capabilities: unknown): 'json' | 'stream' {
  return record(capabilities) && capabilities.protocol_version === 2 && capabilities.planning_stream_version === PLANNING_EVENT_VERSION &&
    Array.isArray(capabilities.stream_operations) && capabilities.stream_operations.every(x => typeof x === 'string') &&
    capabilities.stream_operations.includes('plan_chapter') ? 'stream' : 'json';
}

function validateIdentity(value: unknown): asserts value is PlanningEventIdentity {
  if (!record(value) || !exact(value, IDENTITY_FIELDS) || value.protocol_version !== 2 || !integer(value.input_revision) ||
    !['run_id', 'step_id', 'attempt_id'].every(k => typeof value[k] === 'string' && /^[A-Za-z0-9._:-]{1,128}(?![\s\S])/.test(value[k] as string)) ||
    !['request_fingerprint', 'destination_fingerprint', 'execution_fingerprint'].every(k => typeof value[k] === 'string' && /^[a-f0-9]{64}(?![\s\S])/.test(value[k] as string))) invalid();
}

function validateMetrics(value: unknown, repaired: boolean, lastElapsed: number) {
  if (!record(value) || Object.keys(value).some(k => !METRIC_FIELDS.includes(k)) || value.operation !== 'plan_chapter' || value.protocol_version !== 2 || !elapsed(value.elapsed_ms) || value.elapsed_ms < lastElapsed) invalid();
  if ('call_count' in value && value.call_count !== (repaired ? 2 : 1)) invalid();
  if ('repair_used' in value && value.repair_used !== repaired) invalid();
  for (const field of TOKEN_FIELDS) if (field in value && value[field] !== null && !integer(value[field])) invalid();
  for (const field of TIME_FIELDS) if (field in value && value[field] !== null && !elapsed(value[field])) invalid();
}

/** Pure contract only. Network, persistence, approval and cancellation remain caller responsibilities. */
export class PlanningEventContract {
  private readonly identity: PlanningEventIdentity;
  private readonly chapterNumber: number;
  private sequence = 0;
  private started = false;
  private terminal: '' | 'done' | 'error' = '';
  private active: { node: PlanningNode; visit: number } | null = null;
  private failed = false;
  private completed: PlanningNode[] = [];
  private progressCount = 0;
  private lastElapsed = 0;
  private result?: PlanningResult;

  constructor(identity: PlanningEventIdentity, chapterNumber: number) {
    validateIdentity(identity);
    if (!integer(chapterNumber, 1)) invalid();
    this.identity = { ...identity }; this.chapterNumber = chapterNumber;
  }

  accept(value: unknown): void {
    if (!record(value) || this.terminal || value.event_version !== PLANNING_EVENT_VERSION || !integer(value.seq, 1, MAX_PLANNING_PROGRESS + 2) ||
      value.seq !== this.sequence + 1 || value.chapter_number !== this.chapterNumber || IDENTITY_FIELDS.some(k => value[k] !== this.identity[k])) invalid();
    const additional = value.type === 'started' ? [] : value.type === 'progress' ? ['node', 'visit', 'status', 'elapsed_ms'] :
      value.type === 'done' ? ['result', 'metrics'] : value.type === 'error' ? ['code', 'message', 'status'] : null;
    if (!additional || !exact(value, [...BASE_FIELDS, ...additional])) invalid();
    if (value.type === 'error') {
      if (typeof value.code !== 'string' || !/^[A-Za-z0-9._:-]{1,80}(?![\s\S])/.test(value.code) || typeof value.message !== 'string' ||
        Array.from(value.message).length > 500 || !integer(value.status, 400, 599)) invalid();
      this.terminal = 'error';
    } else if (value.type === 'started') {
      if (this.started || this.sequence !== 0) invalid();
      this.started = true;
    } else {
      if (!this.started || this.failed) {
        // A failed node may only be followed by the terminal error handled above.
        invalid();
      }
      if (value.type === 'progress') {
        if (!PLANNING_NODES.includes(value.node as PlanningNode) || !integer(value.visit, 1, 2) || !elapsed(value.elapsed_ms) ||
          value.elapsed_ms < this.lastElapsed || this.progressCount >= MAX_PLANNING_PROGRESS || typeof value.status !== 'string' || !['started', 'finished', 'failed'].includes(value.status)) invalid();
        const node = value.node as PlanningNode, visit = value.visit;
        if (value.status === 'started') {
          const index = this.completed.length;
          if (this.active || node !== PATH[index] || visit !== (index === 4 ? 2 : 1)) invalid();
          this.active = { node, visit };
        } else {
          if (!this.active || node !== this.active.node || visit !== this.active.visit) invalid();
          if (value.status === 'finished') this.completed.push(node);
          else this.failed = true;
          this.active = null;
        }
        this.progressCount++; this.lastElapsed = value.elapsed_ms;
      } else {
        if (this.active || ![3, 5].includes(this.completed.length) || !record(value.result) || !exact(value.result, RESULT_FIELDS)) invalid();
        validatePlanningResult(value.result, this.chapterNumber);
        if (value.result.issues.some(issue => !exact(issue as unknown as Record<string, unknown>, ['code', 'path', 'message']))) invalid();
        const repaired = this.completed.length === 5;
        if (value.result.repair_count !== (repaired ? 1 : 0) || JSON.stringify(value.result.nodes) !== JSON.stringify(this.completed) ||
          (value.result.status === 'needs_user_decision' && (!repaired || !value.result.issues.length))) invalid();
        validateMetrics(value.metrics, repaired, this.lastElapsed);
        this.result = structuredClone(value.result); this.terminal = 'done';
      }
    }
    this.sequence = value.seq;
  }

  /** Call only at normal EOF; a returned candidate has not been persisted or approved. */
  finish(): PlanningResult {
    if (this.terminal !== 'done' || !this.result) throw new Error('策划未正常完成，结果未知或失败；手动重试可能再次计费。');
    return structuredClone(this.result);
  }
}
