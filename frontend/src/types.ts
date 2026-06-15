export type HealthResponse = {
  status: string;
};

export type ProjectSummary = {
  project_ref: string;
  title: string;
  storage_type: string;
  updated_at: string;
  description: string;
};

export type ProjectDetail = {
  project_ref: string;
  title: string;
  config: Record<string, unknown>;
};

export type CreateProjectRequest = {
  title: string;
  seedPrompt: string;
  genre?: string;
  style?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
};

export type CreateProjectResponse = {
  ok: boolean;
  project_ref: string;
  title: string;
  message: string;
};

export type ProjectOnboardingState = "empty" | "needs_assets" | "ready_for_first_chapter" | "chapters_ready";

export type ChapterSummary = {
  chapter_number: number;
  title: string;
  filename: string;
  is_version: boolean;
  version: number;
  display_label: string;
};

export type ChapterContent = {
  chapter_number: number;
  title: string;
  filename: string;
  content: string;
};

export type WorkflowGuardWarning = {
  code: string;
  severity: string;
  message: string;
};

export type ChapterStatusCounts = {
  pending_review: number;
  accepted: number;
  rejected: number;
  failed: number;
  superseded: number;
  unsupported: number;
  total: number;
};

export type ChapterStatus = {
  chapter_number: number;
  chapter: {
    exists: boolean;
    ref: string | null;
  };
  story_delta: {
    status: string;
    delta_ids: string[];
    event_ids: string[];
    ai_run_ids: string[];
  };
  knowledge_drafts: {
    status: string;
    draft_ids: string[];
    counts: ChapterStatusCounts;
  };
  review: {
    status: string;
    pending_count: number;
    accepted_count: number;
    rejected_count: number;
    failed_count: number;
  };
  ai_runs: {
    chapter_generation: string[];
    story_delta_analysis: string[];
  };
  events: {
    chapter_generated: string[];
    story_delta_analyzed: string[];
    knowledge_draft_change_accepted: string[];
    knowledge_draft_change_rejected: string[];
  };
  context_pack: {
    status: string;
    message: string;
  };
  warnings: WorkflowGuardWarning[];
  next_actions: string[];
};

export type ChapterStatusResponse = {
  ok: boolean;
  project_ref: string;
  chapter_status: ChapterStatus;
  message: string;
};

export type WorkflowGuardCheckRequest = {
  action: "generate_chapter";
  chapter_number: number;
};

export type WorkflowGuardCheckResponse = {
  ok: boolean;
  project_ref: string;
  action: string;
  chapter_number: number;
  blocking: boolean;
  warnings: WorkflowGuardWarning[];
  suggested_actions: string[];
  message: string;
};

export type ApiStatus = "loading" | "online" | "offline";

export type GenerationStatus = {
  running: boolean;
  task_type: string;
  project_ref: string;
  target: string;
  started_at: string;
  finished_at: string;
  last_result: Record<string, unknown> | null;
  last_error: string;
};

export type GenerationRequest = {
  model: string;
  max_tokens: number;
  temperature: number;
  narrative_context_text?: string;
};

export type GenerationSettingsRequest = {
  model: "deepseek-v4-flash" | "deepseek-v4-pro";
  max_tokens: number;
  temperature: number;
};

export type GenerationSettingsResponse = {
  ok: boolean;
  project_ref: string;
  config: {
    model: string;
    max_tokens: number;
    temperature: number;
  };
  message: string;
};

export type NarrativeGraphLayer = "core" | "major" | "detail" | "background";

export type NarrativeGraphNodeType =
  | "character"
  | "scene"
  | "item"
  | "foreshadowing"
  | "relationship_note"
  | "plot_direction"
  | "world_fact"
  | "event"
  | "organization";

export type NarrativeGraphTagCategory =
  | "plot_scope"
  | "organization"
  | "narrative_function"
  | "theme"
  | "custom";

export type NarrativeGraphTagEntry = {
  category: NarrativeGraphTagCategory | string;
  description: string;
  aliases: string[];
  status: string;
};

export type NarrativeGraphNode = {
  id: string;
  type: NarrativeGraphNodeType | string;
  label: string;
  aliases: string[];
  summary: string;
  importance: number;
  layer: NarrativeGraphLayer | string;
  parent_id: string | null;
  status: string;
  tags: string[];
  properties: Record<string, unknown>;
  notes: string;
  source?: Record<string, unknown>;
};

export type NarrativeGraphEdge = {
  id: string;
  source: string;
  target: string;
  type: string;
  label: string;
  summary: string;
  importance: number;
  layer: NarrativeGraphLayer | string;
  status: string;
  properties: Record<string, unknown>;
  notes: string;
  source_info?: Record<string, unknown>;
};

export type NarrativeGraphDocument = {
  version: number;
  metadata: Record<string, unknown>;
  tag_registry: Record<string, NarrativeGraphTagEntry>;
  graph: {
    nodes: NarrativeGraphNode[];
    edges: NarrativeGraphEdge[];
  };
};

export type NarrativeGraphViewsDocument = {
  version: number;
  metadata: Record<string, unknown>;
  views: Array<Record<string, unknown>>;
};

export type NarrativeGraphResponse = {
  ok: boolean;
  project_ref: string;
  graph: NarrativeGraphDocument;
  views: NarrativeGraphViewsDocument;
  message: string;
};

export type NarrativeGraphTagRequest = {
  name: string;
  category: NarrativeGraphTagCategory;
  description: string;
  aliases: string[];
};

export type NarrativeGraphTagUpdateRequest = {
  category?: NarrativeGraphTagCategory;
  description?: string;
  aliases?: string[];
  status?: string;
};

export type NarrativeGraphTagResponse = NarrativeGraphResponse & {
  tag: Record<string, NarrativeGraphTagEntry>;
};

export type NarrativeGraphNodeRequest = {
  type: NarrativeGraphNodeType;
  label: string;
  aliases: string[];
  summary: string;
  importance: number;
  layer: NarrativeGraphLayer;
  parent_id?: string | null;
  status: string;
  tags: string[];
  properties: Record<string, unknown>;
  notes: string;
};

export type NarrativeGraphNodeResponse = NarrativeGraphResponse & {
  node: NarrativeGraphNode;
};

export type NarrativeGraphEdgeRequest = {
  source: string;
  target: string;
  type: string;
  label: string;
  summary: string;
  importance: number;
  layer: NarrativeGraphLayer;
  status: string;
  properties: Record<string, unknown>;
  notes: string;
};

export type NarrativeGraphEdgeResponse = NarrativeGraphResponse & {
  edge: NarrativeGraphEdge;
};

export type NarrativeGraphNodeDeleteOptions = {
  deleteEdges?: boolean;
};

export type ContextPackNode = NarrativeGraphNode & {
  score: number;
  reasons: string[];
};

export type ContextPackEdge = NarrativeGraphEdge & {
  source_label: string;
  target_label: string;
  score: number;
  reasons: string[];
};

export type ContextPackSections = {
  core_facts: ContextPackNode[];
  characters: ContextPackNode[];
  scenes: ContextPackNode[];
  items: ContextPackNode[];
  foreshadowing: ContextPackNode[];
  plot_directions: ContextPackNode[];
  world_facts: ContextPackNode[];
  events: ContextPackNode[];
  organizations: ContextPackNode[];
  relationships: ContextPackEdge[];
};

export type ContextPackStats = {
  nodes_considered: number;
  nodes_selected: number;
  edges_considered: number;
  edges_selected: number;
  truncated_nodes: number;
  truncated_edges: number;
};

export type ContextPack = {
  project_ref: string;
  chapter_number: number;
  chapter_goal: string;
  options: {
    min_importance: number;
    max_nodes: number;
    max_edges: number;
    include_unresolved_foreshadowing: boolean;
    include_neighbors: boolean;
  };
  selected_nodes: ContextPackNode[];
  selected_edges: ContextPackEdge[];
  sections: ContextPackSections;
  stats: ContextPackStats;
  warnings: string[];
};

export type ContextPackPreviewRequest = {
  chapter_number: number;
  chapter_goal: string;
  min_importance: number;
  max_nodes: number;
  max_edges: number;
  include_unresolved_foreshadowing: boolean;
  include_neighbors: boolean;
};

export type ContextPackPreviewResponse = {
  ok: boolean;
  project_ref: string;
  context_pack: ContextPack;
  prompt_text: string;
  message: string;
};

export type StoryDelta = {
  new_characters: Array<Record<string, unknown>>;
  character_updates: Array<Record<string, unknown>>;
  new_scenes: Array<Record<string, unknown>>;
  new_items: Array<Record<string, unknown>>;
  new_events: Array<Record<string, unknown>>;
  foreshadowing_updates: Array<Record<string, unknown>>;
  relationship_updates: Array<Record<string, unknown>>;
  world_fact_updates: Array<Record<string, unknown>>;
};

export type NextChapterProposal = {
  target_chapter_number: number;
  suggested_goal: string;
  suggested_scenes: Array<Record<string, unknown>>;
  suggested_conflicts: Array<Record<string, unknown>>;
  suggested_foreshadowing_moves: Array<Record<string, unknown>>;
  suggested_new_nodes: Array<Record<string, unknown>>;
  suggested_new_edges: Array<Record<string, unknown>>;
  suggested_plot_directions: Array<Record<string, unknown>>;
  risks: Array<unknown>;
};

export type CandidateChange = {
  id: string;
  operation: string;
  target: string;
  source: "story_delta" | "next_chapter_proposal" | string;
  status?: "pending_review" | "accepted" | "rejected" | "failed" | "superseded" | string;
  confidence?: number;
  requires_review: boolean;
  evidence?: string;
  rationale?: string;
  payload: Record<string, unknown>;
  reviewed_at?: string | null;
  reviewed_by?: string | null;
  review_note?: string;
  result?: {
    created_node_id?: string | null;
    created_edge_id?: string | null;
    error?: string | null;
  };
};

export type KnowledgeDraft = {
  id: string;
  chapter_number: number;
  source_delta_id: string;
  status: "pending_review" | "accepted" | "rejected" | "superseded" | string;
  candidate_changes: CandidateChange[];
  created_at: string;
};

export type StoryDeltaAnalyzeRequest = {
  include_next_chapter_proposal: boolean;
  include_knowledge_draft: boolean;
  dry_run: boolean;
  mock_response?: unknown;
  context_pack_summary?: string;
};

export type StoryDeltaAnalyzeResponse = {
  ok: boolean;
  project_ref: string;
  chapter_number: number;
  story_delta: StoryDelta;
  next_chapter_proposal: NextChapterProposal;
  knowledge_draft: KnowledgeDraft;
  warnings: string[];
  message: string;
  metadata: Record<string, unknown>;
};

export type StoryDeltaListResponse = {
  ok: boolean;
  project_ref: string;
  items: Array<Record<string, unknown>>;
  message: string;
};

export type KnowledgeDraftListResponse = {
  ok: boolean;
  project_ref: string;
  drafts: KnowledgeDraft[];
  message: string;
};

export type KnowledgeDraftResponse = {
  ok: boolean;
  project_ref: string;
  draft: KnowledgeDraft;
  message: string;
};

export type AcceptKnowledgeDraftChangeRequest = {
  review_note?: string;
  payload_override?: Record<string, unknown> | null;
};

export type RejectKnowledgeDraftChangeRequest = {
  review_note?: string;
};

export type KnowledgeDraftChangeReviewResponse = {
  ok: boolean;
  project_ref: string;
  draft: KnowledgeDraft;
  change: CandidateChange;
  graph?: NarrativeGraphDocument;
  views?: NarrativeGraphViewsDocument;
  node?: NarrativeGraphNode | null;
  edge?: NarrativeGraphEdge | null;
  message: string;
};

export type OutlineCharactersGenerationResponse = {
  ok: boolean;
  outline_file: string;
  characters_file: string;
  message: string;
};

export type ChapterGenerationResponse = {
  ok: boolean;
  chapter_number: number;
  title: string;
  chapter_file: string;
  summary_file: string;
  index_file?: string;
  message: string;
};

export type ChapterStreamDeltaEvent = {
  type: "delta";
  text: string;
};

export type ChapterStreamDoneEvent = {
  type: "done";
  ok: true;
  chapter_number: number;
  title: string;
  chapter_file: string;
  summary_file: string;
  index_file?: string;
  message: string;
  summary_error?: string;
};

export type ChapterStreamErrorEvent = {
  type: "error";
  ok: false;
  code?: string;
  chapter_number?: number;
  message: string;
  partial_length?: number;
};

export type ChapterStreamEvent =
  | ChapterStreamDeltaEvent
  | ChapterStreamDoneEvent
  | ChapterStreamErrorEvent;

export type ChapterStreamHandlers = {
  onDelta?: (text: string) => void;
  onDone?: (result: ChapterStreamDoneEvent) => void;
  onError?: (error: ChapterStreamErrorEvent) => void;
};
