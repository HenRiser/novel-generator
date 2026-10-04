import { MAX_PLANNING_PROGRESS, PlanningEventContract, type PlanningProgress } from './planningStreamContract';

export type PlanningTraceEntry = Pick<PlanningProgress, 'event_version' | 'seq' | 'node' | 'visit' | 'status' | 'elapsed_ms'>;
const FIELDS = ['event_version', 'seq', 'node', 'visit', 'status', 'elapsed_ms'] as const;
const IDENTITY = { run_id: 'local-trace', step_id: 'local-trace', attempt_id: 'local-trace', input_revision: 0,
  protocol_version: 2 as const, request_fingerprint: '0'.repeat(64), destination_fingerprint: '0'.repeat(64), execution_fingerprint: '0'.repeat(64) };

export function planningTraceEntry(progress: Readonly<PlanningTraceEntry>): PlanningTraceEntry {
  return { event_version: progress.event_version, seq: progress.seq, node: progress.node,
    visit: progress.visit, status: progress.status, elapsed_ms: progress.elapsed_ms };
}

/** Diagnostic prefixes use the same FSM as the wire, with a local-only synthetic envelope. */
export function readPlanningTrace(value: unknown): { entries: PlanningTraceEntry[]; invalid: boolean } {
  if (value === undefined) return { entries: [], invalid: false };
  if (!Array.isArray(value) || value.length > MAX_PLANNING_PROGRESS) return { entries: [], invalid: true };
  const contract = new PlanningEventContract(IDENTITY, 1), entries: PlanningTraceEntry[] = [];
  contract.accept({ ...IDENTITY, type: 'started', event_version: 1, chapter_number: 1, seq: 1 });
  try {
    for (const entry of value) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).length !== FIELDS.length ||
        !FIELDS.every(field => Object.prototype.hasOwnProperty.call(entry, field))) throw new Error('Invalid trace shape');
      contract.accept({ ...IDENTITY, type: 'progress', chapter_number: 1, ...entry });
      entries.push(planningTraceEntry(entry as PlanningTraceEntry));
    }
    return { entries, invalid: false };
  } catch { return { entries: [], invalid: true }; }
}
