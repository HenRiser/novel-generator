from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

from api.schemas import (
    KnowledgeDraftListResponse,
    KnowledgeDraftResponse,
    StoryDeltaAnalyzeRequest,
    StoryDeltaAnalyzeResponse,
    StoryDeltaListResponse,
)
from config import PROJECT_ROOT
from services.story_delta_service import (
    analyze_chapter_delta,
    get_knowledge_draft,
    list_knowledge_drafts,
    list_story_deltas,
)


router = APIRouter(prefix="/api/projects/{project_ref}", tags=["story-delta"])

SENSITIVE_KEY_PARTS = ("api_key", "apikey", "password", "secret")
SENSITIVE_EXACT_KEYS = ("token", "access_token", "refresh_token", "auth_token", "bearer_token")
PROJECT_ROOT_TEXT = str(PROJECT_ROOT)


def _error(status_code: int, code: str, message: str) -> None:
    raise HTTPException(
        status_code=status_code,
        detail={"error": {"code": code, "message": message}},
    )


def _sanitize_payload(value: Any) -> Any:
    if isinstance(value, dict):
        sanitized: dict[str, Any] = {}
        for key, item in value.items():
            lowered_key = str(key).lower()
            if lowered_key in SENSITIVE_EXACT_KEYS or any(part in lowered_key for part in SENSITIVE_KEY_PARTS):
                sanitized[key] = "[redacted]"
            else:
                sanitized[key] = _sanitize_payload(item)
        return sanitized
    if isinstance(value, list):
        return [_sanitize_payload(item) for item in value]
    if isinstance(value, str) and PROJECT_ROOT_TEXT and PROJECT_ROOT_TEXT in value:
        return value.replace(PROJECT_ROOT_TEXT, "[project_root]")
    normalized_root = PROJECT_ROOT_TEXT.replace("\\", "/")
    if isinstance(value, str) and normalized_root and normalized_root in value:
        return value.replace(normalized_root, "[project_root]")
    return value


def _status_for_message(message: str) -> int:
    lowered = message.lower()
    if "not found" in lowered or "unknown project_ref" in lowered or "chapter" in lowered and "not found" in lowered:
        return 404
    return 400


@router.post("/chapters/{chapter_number}/story-delta/analyze", response_model=StoryDeltaAnalyzeResponse)
def analyze_story_delta(
    project_ref: str,
    chapter_number: int,
    request: StoryDeltaAnalyzeRequest | None = None,
) -> StoryDeltaAnalyzeResponse:
    payload = request or StoryDeltaAnalyzeRequest()
    result = analyze_chapter_delta(project_ref, chapter_number, payload.model_dump(exclude_unset=True))
    if not result.ok:
        _error(_status_for_message(result.message), "story_delta_unavailable", result.message)
    return StoryDeltaAnalyzeResponse(
        ok=True,
        project_ref=result.project_ref,
        chapter_number=result.chapter_number,
        story_delta=_sanitize_payload(result.story_delta),
        next_chapter_proposal=_sanitize_payload(result.next_chapter_proposal),
        knowledge_draft=_sanitize_payload(result.knowledge_draft),
        warnings=_sanitize_payload(result.warnings),
        message=result.message,
    )


@router.get("/story-deltas", response_model=StoryDeltaListResponse)
def get_story_deltas(project_ref: str) -> StoryDeltaListResponse:
    result = list_story_deltas(project_ref)
    if not result.ok:
        _error(_status_for_message(result.message), "story_delta_unavailable", result.message)
    return StoryDeltaListResponse(
        ok=True,
        project_ref=result.project_ref,
        items=_sanitize_payload(result.items),
        message="Story Delta list loaded.",
    )


@router.get("/knowledge-drafts", response_model=KnowledgeDraftListResponse)
def get_knowledge_drafts(project_ref: str) -> KnowledgeDraftListResponse:
    result = list_knowledge_drafts(project_ref)
    if not result.ok:
        _error(_status_for_message(result.message), "knowledge_draft_unavailable", result.message)
    return KnowledgeDraftListResponse(
        ok=True,
        project_ref=result.project_ref,
        drafts=_sanitize_payload(result.drafts),
        message="Knowledge Draft list loaded.",
    )


@router.get("/knowledge-drafts/{draft_id}", response_model=KnowledgeDraftResponse)
def get_knowledge_draft_by_id(project_ref: str, draft_id: str) -> KnowledgeDraftResponse:
    result = get_knowledge_draft(project_ref, draft_id)
    if not result.ok:
        _error(_status_for_message(result.message), "knowledge_draft_unavailable", result.message)
    return KnowledgeDraftResponse(
        ok=True,
        project_ref=result.project_ref,
        draft=_sanitize_payload(result.draft),
        message="Knowledge Draft loaded.",
    )
