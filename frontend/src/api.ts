import type {
  ChapterContent,
  ChapterSummary,
  HealthResponse,
  ProjectDetail,
  ProjectSummary,
} from "./types";

export const API_BASE_URL =
  (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/+$/, "") ||
  "http://127.0.0.1:8000";

function projectPath(projectRef: string): string {
  return encodeURIComponent(projectRef);
}

function errorMessageFromPayload(payload: unknown, fallback: string): string {
  if (
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    payload.error &&
    typeof payload.error === "object" &&
    "message" in payload.error &&
    typeof payload.error.message === "string"
  ) {
    return payload.error.message;
  }

  return fallback;
}

async function apiFetch<T>(path: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`);
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
    throw new Error(errorMessageFromPayload(payload, `API request failed with ${response.status}.`));
  }

  return response.json() as Promise<T>;
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
