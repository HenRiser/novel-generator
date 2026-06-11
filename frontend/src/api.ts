import type {
  ChapterContent,
  ChapterGenerationResponse,
  ChapterSummary,
  ChapterStreamDoneEvent,
  ChapterStreamErrorEvent,
  ChapterStreamEvent,
  ChapterStreamHandlers,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

export function safePublicMessage(message: unknown, fallback: string): string {
  let text = typeof message === "string" ? message.trim() : "";
  if (!text) {
    return fallback;
  }

  if (/Traceback\s*\(/i.test(text) || /\n\s*File\s+["']/.test(text)) {
    return fallback;
  }

  text = text.replace(/[A-Za-z]:[\\/][^\s"'<>]+/g, "[local path]");
  text = text.replace(/\/h(?:ome)[^\s"'<>]*/g, "[local path]");
  text = text.replace(/(api[\s_-]*key|token|secret|credential)\s*[:=]\s*["']?[^"'\s,;]+/gi, "$1=[hidden]");
  return text.replace(/\s+/g, " ").trim() || fallback;
}

function messageFromValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (isRecord(value) && typeof value.message === "string") {
    return value.message;
  }
  return "";
}

function errorObjectFromPayload(payload: unknown): unknown {
  if (!isRecord(payload)) {
    return null;
  }
  if ("error" in payload) {
    return payload.error;
  }
  if ("detail" in payload) {
    const detail = payload.detail;
    if (isRecord(detail) && "error" in detail) {
      return detail.error;
    }
  }
  return null;
}

function errorMessageFromPayload(payload: unknown, fallback: string): string {
  const candidates: unknown[] = [errorObjectFromPayload(payload)];
  if (isRecord(payload)) {
    candidates.push(payload.message);
    candidates.push(payload.detail);
    if (isRecord(payload.detail)) {
      candidates.push(payload.detail.message);
      candidates.push(payload.detail.error);
    }
    candidates.push(payload.error);
  }

  for (const candidate of candidates) {
    const message = messageFromValue(candidate);
    if (message) {
      return safePublicMessage(message, fallback);
    }
  }

  return fallback;
}

function errorCodeFromPayload(payload: unknown): string {
  const candidates: unknown[] = [errorObjectFromPayload(payload)];
  if (isRecord(payload)) {
    candidates.push(payload);
    candidates.push(payload.error);
    candidates.push(payload.detail);
    if (isRecord(payload.detail)) {
      candidates.push(payload.detail.error);
    }
  }

  for (const candidate of candidates) {
    if (isRecord(candidate) && typeof candidate.code === "string") {
      return candidate.code;
    }
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
    throw new Error(safePublicMessage(error instanceof Error ? error.message : "", "API request failed."));
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

function isStreamEvent(payload: unknown): payload is ChapterStreamEvent {
  return Boolean(payload && typeof payload === "object" && "type" in payload);
}

function streamErrorFromEvent(event: ChapterStreamErrorEvent): ApiRequestError {
  return new ApiRequestError(
    safePublicMessage(event.message, "Chapter streaming generation failed."),
    200,
    event.code || "generation_failed",
  );
}

function handleStreamLine(
  line: string,
  handlers: ChapterStreamHandlers,
): ChapterStreamDoneEvent | ChapterStreamErrorEvent | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(safePublicMessage(error instanceof Error ? error.message : "", "Invalid streaming response."));
  }

  if (!isStreamEvent(payload)) {
    throw new Error("Invalid streaming response event.");
  }

  if (payload.type === "delta") {
    if (payload.text) {
      handlers.onDelta?.(payload.text);
    }
    return null;
  }

  if (payload.type === "done") {
    handlers.onDone?.(payload);
    return payload;
  }

  handlers.onError?.(payload);
  return payload;
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

export async function generateChapterStream(
  projectRef: string,
  chapterNumber: number,
  request: GenerationRequest,
  handlers: ChapterStreamHandlers = {},
): Promise<ChapterStreamDoneEvent> {
  let response: Response;
  try {
    response = await fetch(
      `${API_BASE_URL}/api/projects/${projectPath(projectRef)}/chapters/${chapterNumber}/generate/stream`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/x-ndjson",
        },
        body: JSON.stringify(request),
      },
    );
  } catch (error) {
    throw new Error(safePublicMessage(error instanceof Error ? error.message : "", "API request failed."));
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

  if (!response.body) {
    throw new Error("Streaming response body is not available.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let doneEvent: ChapterStreamDoneEvent | null = null;
  let errorEvent: ChapterStreamErrorEvent | null = null;

  function consumeBuffer(final = false) {
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      const event = handleStreamLine(line, handlers);
      if (event?.type === "done") {
        doneEvent = event;
      }
      if (event?.type === "error") {
        errorEvent = event;
      }
      newlineIndex = buffer.indexOf("\n");
    }

    if (final && buffer.trim()) {
      const event = handleStreamLine(buffer, handlers);
      if (event?.type === "done") {
        doneEvent = event;
      }
      if (event?.type === "error") {
        errorEvent = event;
      }
      buffer = "";
    }
  }

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    consumeBuffer();
    if (errorEvent) {
      throw streamErrorFromEvent(errorEvent);
    }
  }

  buffer += decoder.decode();
  consumeBuffer(true);

  if (errorEvent) {
    throw streamErrorFromEvent(errorEvent);
  }
  if (!doneEvent) {
    throw new Error("Streaming response ended before a done event.");
  }

  return doneEvent;
}
