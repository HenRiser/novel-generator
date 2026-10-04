import type { LocalProject } from './localTypes';
import type { ChapterTaskDraftRequest, ScenePlanDraftRequest } from './types';

export type PlanningRequest = { author_intent: string; canon_budget: 'none' | 'minor' | 'normal'; required_characters: string[]; forbidden_advances: string[] };
export type PlanningResult = {
  graph_version: string; chapter_number: number; status: 'draft_ready' | 'needs_user_decision';
  task_payload: Required<Omit<ChapterTaskDraftRequest, 'id' | 'revision'>> | null;
  scene_proposal: Pick<ScenePlanDraftRequest, 'scenes'> | null;
  issues: Array<{ code: string; path: string; message: string }>; repair_count: number;
  nodes: string[]; excluded_records: number; warnings: string[];
};
export const TASK_FIELDS = ['primary_function', 'secondary_functions', 'intensity', 'canon_budget', 'must_carry', 'allowed_advances', 'forbidden_advances', 'required_characters', 'relationship_goal', 'decision_goal', 'allowed_scene_types', 'forbidden_scene_drivers', 'ending_state', 'notes'] as const;
export const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');
// JavaScript trim omits NEL/control separators and includes BOM; match Python strip.
const PYTHON_SPACE = '[\\u0009-\\u000d\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const stripPattern = new RegExp(`^${PYTHON_SPACE}+|${PYTHON_SPACE}+$`, 'g');
const strip = (v: string) => v.replace(stripPattern, '');

function provenance(value: unknown, prefix: number): Record<string, unknown> | undefined {
  if (!record(value) || value.candidate_source === 'next_chapter_proposal') return;
  const chapter = value.chapter_number;
  if (chapter != null && (typeof chapter !== 'number' || !Number.isInteger(chapter) || chapter < 1)) return;
  const reference = (v: unknown) => v == null ? null : typeof v === 'string' && /^chapter_\d+$/.test(v) && Number(v.slice(8)) > 0 ? Number(v.slice(8)) : undefined;
  const introduced = reference(value.introduced_in), updated = reference(value.last_updated_in);
  if (introduced === undefined || updated === undefined || (chapter != null && introduced != null && chapter !== introduced)) return;
  if (value.created_by === 'user' && chapter == null && introduced == null && updated == null) return { created_by: 'user', introduced_in: null, last_updated_in: null };
  const number = chapter ?? introduced;
  if (typeof number !== 'number' || number > prefix || (introduced != null && introduced > prefix) || (updated != null && updated > prefix)) return;
  const imported = value.reviewed === true && typeof value.kind === 'string' && ['source_fact', 'user_setting'].includes(value.kind);
  const reviewed = value.created_by === 'knowledge_draft_review';
  if (!imported && !reviewed) return;
  return { chapter_number: number, ...(imported ? { kind: value.kind, reviewed: true } : {}),
    ...(reviewed ? { created_by: 'knowledge_draft_review' } : {}),
    ...(introduced != null ? { introduced_in: value.introduced_in } : {}), ...(updated != null ? { last_updated_in: value.last_updated_in } : {}) };
}

/** Mirror the server's conservative projection before uploading anything. */
export function filterPlanningGraph(document: LocalProject['graph'], prefix: number) {
  const nodes: Record<string, unknown>[] = [], edges: Record<string, unknown>[] = [];
  const nodeIds = new Set<string>(), edgeIds = new Set<string>();
  let excluded = 0;
  for (const [kind, rows] of Object.entries({ nodes: document.graph.nodes, edges: document.graph.edges })) {
    const edge = kind === 'edges';
    for (const row of rows) {
      if (!record(row)) { excluded++; continue; }
      const r = row as unknown as Record<string, unknown>;
      const source = provenance(r[edge ? 'source_info' : 'source'], prefix), ids = edge ? edgeIds : nodeIds;
      const status = r.status === undefined ? '' : r.status;
      if (!source || typeof r.id !== 'string' || !strip(r.id) || ids.has(r.id) || typeof status !== 'string' || strip(status).toLowerCase() === 'planned' ||
        (edge && (typeof r.source !== 'string' || typeof r.target !== 'string' || !nodeIds.has(r.source) || !nodeIds.has(r.target)))) { excluded++; continue; }
      const safe: Record<string, unknown> = Object.fromEntries(['id', 'type', 'label', 'summary', 'layer', 'status', 'notes'].filter(k => typeof r[k] === 'string').map(k => [k, r[k]]));
      safe.importance = typeof r.importance === 'number' && Number.isInteger(r.importance) && r.importance >= 1 && r.importance <= 10 ? r.importance : 5;
      safe.properties = {};
      if (edge) Object.assign(safe, { source: r.source, target: r.target, source_info: source });
      else Object.assign(safe, { aliases: Array.isArray(r.aliases) ? r.aliases.filter(x => typeof x === 'string') : [], tags: Array.isArray(r.tags) ? r.tags.filter(x => typeof x === 'string') : [], source });
      (edge ? edges : nodes).push(safe); ids.add(r.id);
    }
  }
  return { graph: { version: 1, graph: { nodes, edges } }, excluded_records: excluded };
}

export function buildPlanningInput(p: LocalProject, number: number, request: PlanningRequest): Record<string, unknown> {
  if (!Number.isSafeInteger(number) || number < 1 || p.chapters[number]) throw new Error('只能策划尚未生成的下一章。');
  const chapters = Object.values(p.chapters).sort((a, b) => a.chapter_number - b.chapter_number);
  if (chapters.length !== number - 1 || chapters.some((c, i) => c.chapter_number !== i + 1)) throw new Error('只能策划连续已确认前文的下一章，不能跳章。');
  if (chapters.some(c => c.workflow.status !== 'confirmed' || c.workflow.summary_status !== 'ready' || !c.workflow.summary.trim() || !c.content.trim())) throw new Error('请先确认前文，并等待摘要完成。');
  if (typeof request.author_intent !== 'string' || !request.author_intent.trim() || !['none', 'minor', 'normal'].includes(request.canon_budget) || !strings(request.required_characters) || !strings(request.forbidden_advances)) throw new Error('请填写本章意图与有效的策划约束。');
  const list = (v: string[]) => [...new Set(v.map(x => x.trim()).filter(Boolean))];
  const selected = filterPlanningGraph(p.graph, number - 1);
  return { project_ref: p.project_ref, chapter_number: number, author_intent: request.author_intent.trim(),
    constraints: { canon_budget: request.canon_budget, required_characters: list(request.required_characters), forbidden_advances: list(request.forbidden_advances) },
    setting: Object.fromEntries(['protagonist', 'supporting_characters', 'worldview', 'core_conflict', 'genre', 'style'].map(k => [k, typeof p.config[k] === 'string' ? p.config[k].trim() : ''])),
    prefix: chapters.map((c, i) => ({ chapter_number: c.chapter_number, revision: c.revision, status: c.workflow.status, summary_status: c.workflow.summary_status, summary: c.workflow.summary, content: i === chapters.length - 1 ? c.content : '' })),
    graph: selected.graph, excluded_records: selected.excluded_records };
}

export function validatePlanningResult(v: unknown, number: number): asserts v is PlanningResult {
  const fieldsMatch = (value: Record<string, unknown>, fields: readonly string[]) => Object.keys(value).length === fields.length && fields.every(k => Object.prototype.hasOwnProperty.call(value, k));
  const taskLists = ['secondary_functions', 'must_carry', 'allowed_advances', 'forbidden_advances', 'required_characters', 'allowed_scene_types', 'forbidden_scene_drivers'];
  const sceneTexts = ['title', 'location', 'scene_function', 'emotional_shift', 'ending_state'], sceneLists = ['participants', 'allowed_information', 'forbidden_information'];
  const taskShape = (t: unknown) => t === null || (record(t) && fieldsMatch(t, TASK_FIELDS) && TASK_FIELDS.every(k => taskLists.includes(k) ? strings(t[k]) : typeof t[k] === 'string'));
  const sceneShape = (p: unknown) => p === null || (record(p) && fieldsMatch(p, ['scenes']) && Array.isArray(p.scenes) && p.scenes.length >= 2 && p.scenes.length <= 4 && p.scenes.every((s, i) =>
    record(s) && fieldsMatch(s, ['scene_no', ...sceneTexts, ...sceneLists]) && s.scene_no === i + 1 && sceneTexts.every(k => typeof s[k] === 'string') && sceneLists.every(k => strings(s[k]))));
  if (!record(v) || v.graph_version !== 'chapter-planning-v1' || v.chapter_number !== number || !['draft_ready', 'needs_user_decision'].includes(String(v.status)) ||
    ![0, 1].includes(Number(v.repair_count)) || typeof v.repair_count !== 'number' || !Number.isSafeInteger(v.excluded_records) || Number(v.excluded_records) < 0 ||
    !strings(v.nodes) || !strings(v.warnings) || !Array.isArray(v.issues) || v.issues.some(x => !record(x) || ['code', 'path', 'message'].some(k => typeof x[k] !== 'string')) ||
    !taskShape(v.task_payload) || !sceneShape(v.scene_proposal) ||
    (v.status === 'draft_ready' && (v.issues.length || !v.task_payload || !v.scene_proposal))) throw new Error('策划结果结构或版本无效，未应用。');
}
