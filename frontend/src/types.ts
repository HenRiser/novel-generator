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
