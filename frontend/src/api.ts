import type {
  ChapterContent,
  ChapterGenerationResponse,
  ChapterSummary,
  GenerationRequest,
  GenerationStatus,
  HealthResponse,
  OutlineCharactersGenerationResponse,
  ProjectDetail,
  ProjectSummary,
} from "./types";

export const API_BASE_URL =
  (import.meta as unknown as { readonly env?: { readonly VITE_API_BASE_URL?: string } })[
    "env"
  ]?.VITE_API_BASE_URL?.replace(/\/+$/, "") || "http://127.0.0.1:8000";

function projectPath(projectRef: string): string {
  return encodeURIComponent(projectRef);
}

function errorObjectFromPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  if ("error" in payload) {
    return payload.error;
  }
  if ("detail" in payload) {
    const detail = payload.detail;
    if (detail && typeof detail === "object" && "error" in detail) {
      return detail.error;
    }
  }
  return null;
}

function errorMessageFromPayload(payload: unknown, fallback: string): string {
  const errorObject = errorObjectFromPayload(payload);
  if (
    errorObject &&
    typeof errorObject === "object" &&
    "message" in errorObject &&
    typeof errorObject.message === "string"
  ) {
    return errorObject.message;
  }

  return fallback;
}

function errorCodeFromPayload(payload: unknown): string {
  const errorObject = errorObjectFromPayload(payload);
  if (
    errorObject &&
    typeof errorObject === "object" &&
    "code" in errorObject &&
    typeof errorObject.code === "string"
  ) {
    return errorObject.code;
  }

  return "";
}

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code = "") {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, init);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "API request failed.");
  }

  if (!response.ok) {
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    throw new ApiRequestError(
      errorMessageFromPayload(payload, `API request failed with ${response.status}.`),
      response.status,
      errorCodeFromPayload(payload),
    );
  }

  return response.json() as Promise<T>;
}

function postJson<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

export function exportFullBookUrl(projectRef: string): string {
  return `${API_BASE_URL}/api/projects/${projectPath(projectRef)}/exports/full.txt`;
}

export function exportChapterUrl(projectRef: string, chapterNumber: number): string {
  return `${API_BASE_URL}/api/projects/${projectPath(projectRef)}/exports/chapters/${chapterNumber}.txt`;
}

export function getHealth(): Promise<HealthResponse> {
  return apiFetch<HealthResponse>("/api/health");
}

export function getProjects(): Promise<ProjectSummary[]> {
  return apiFetch<ProjectSummary[]>("/api/projects");
}

export function getProject(projectRef: string): Promise<ProjectDetail> {
  return apiFetch<ProjectDetail>(`/api/projects/${projectPath(projectRef)}`);
}

export function getChapters(projectRef: string): Promise<ChapterSummary[]> {
  return apiFetch<ChapterSummary[]>(`/api/projects/${projectPath(projectRef)}/chapters`);
}

export function getChapter(projectRef: string, chapterNumber: number): Promise<ChapterContent> {
  return apiFetch<ChapterContent>(
    `/api/projects/${projectPath(projectRef)}/chapters/${chapterNumber}`,
  );
}

export function getGenerationStatus(): Promise<GenerationStatus> {
  return apiFetch<GenerationStatus>("/api/generation/status");
}

export function generateOutlineCharacters(
  projectRef: string,
  request: GenerationRequest,
): Promise<OutlineCharactersGenerationResponse> {
  return postJson<OutlineCharactersGenerationResponse>(
    `/api/projects/${projectPath(projectRef)}/outline-characters/generate`,
    request,
  );
}

export function generateChapter(
  projectRef: string,
  chapterNumber: number,
  request: GenerationRequest,
): Promise<ChapterGenerationResponse> {
  return postJson<ChapterGenerationResponse>(
    `/api/projects/${projectPath(projectRef)}/chapters/${chapterNumber}/generate`,
    request,
  );
}
