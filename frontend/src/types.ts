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
