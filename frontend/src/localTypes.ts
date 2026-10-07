import type { ConnectionSnapshot, ConnectionGuard } from './providerTypes';
import type { PlanningTraceEntry } from './planningTrace';
import type { CoverState } from './coverTypes';
import type { BatchGenerationRequest, BatchGenerationStatus, ChapterTaskResponse, ChapterWorkflow, KnowledgeDraft, NarrativeGraphDocument, NarrativeGraphViewsDocument, NoRevealReview, ScenePlanResponse } from './types';

export type LocalRun = {
  planning_trace?: PlanningTraceEntry[];
  planning_trace_invalid?: boolean;
  planning_application?: { source_fingerprint: string; task_id: string; task_revision: number; scene_plan_id?: string; scene_plan_revision?: number };
  connection?: ConnectionSnapshot; connection_guard?: ConnectionGuard;
  run_id: string; step_id: string; attempt_id: string; operation: string;
  input_revision: number; status: 'running' | 'completed' | 'interrupted' | 'failed' | 'discarded';
  chapter_number?: number; partial: string; error: string; started_at: string;
  frozen_context?: Record<string, unknown>;
  attempt_history?: Array<{ attempt_id: string; partial: string; error: string; result?: Record<string, unknown> }>;
  input: Record<string, unknown>; result?: Record<string, unknown>; metrics?: Record<string, unknown>; result_revision?: number;
};
export type LocalChapter = {
  summary_connection?: ConnectionSnapshot;
  connection?: ConnectionSnapshot;
  chapter_number: number; title: string; filename: string; content: string;
  revision: string; versions: Array<{ revision: string; content: string; title: string; filename: string }>;
  workflow: ChapterWorkflow; source_locked?: boolean;
  frozen_context?: Record<string, unknown>; confirmation_base_revision?: string;
};
export type LocalProject = {
  schema_version: 2; project_ref: string; revision: number; title: string; updated_at: string;
  cover?: CoverState;
  config: Record<string, unknown>;
  assets: { outline: string; characters: string; setting_expansion: string };
  chapters: Record<string, LocalChapter>;
  graph: NarrativeGraphDocument; views: NarrativeGraphViewsDocument;
  chapter_tasks: Record<string, ChapterTaskResponse>; scene_plans: Record<string, ScenePlanResponse>;
  knowledge_drafts: KnowledgeDraft[]; story_deltas: Array<Record<string, unknown>>;
  reviews: Record<string, NoRevealReview[]>;
  events: Array<Record<string, unknown>>; snapshots: Array<Record<string, unknown>>;
  ai_runs: Array<Record<string, unknown>>; runs: LocalRun[];
  batch: BatchGenerationStatus & { request?: BatchGenerationRequest; input_revision?: number; connection?: ConnectionSnapshot; connection_guard?: ConnectionGuard };
  source?: Record<string, unknown>;
};

export function emptyProject(title: string, config: Record<string, unknown> = {}): LocalProject {
  const project_ref = `book:bk_${crypto.randomUUID().replace(/-/g, '')}`;
  return {
    schema_version: 2, project_ref, revision: 0, title, updated_at: new Date().toISOString(),
    config: { title, connection_id: 'legacy-deepseek', model: 'deepseek-v4-flash', max_tokens: 4000, temperature: 0.7, genre: '', style: '', word_count_range: '3000-5000', ...config },
    assets: { outline: '', characters: '', setting_expansion: '' }, chapters: {},
    graph: { version: 1, metadata: {}, tag_registry: {}, graph: { nodes: [], edges: [] } },
    views: { version: 1, metadata: {}, views: [] }, chapter_tasks: {}, scene_plans: {},
    knowledge_drafts: [], story_deltas: [], reviews: {}, events: [], snapshots: [], ai_runs: [], runs: [],
    batch: { id: '', status: 'idle', start_chapter: 0, end_chapter: 0, current_chapter: null, completed_chapters: [], message: '', error: '', stage: 'idle' },
  };
}
