from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

from api.schemas import (
    KnowledgeDraftChangeAcceptRequest,
    KnowledgeDraftChangeRejectRequest,
    KnowledgeDraftChangeReviewResponse,
    KnowledgeDraftListResponse,
    KnowledgeDraftResponse,
)
from config import PROJECT_ROOT
from services.knowledge_draft_service import (
    accept_candidate_change,
    get_knowledge_draft,
    list_knowledge_drafts,
    reject_candidate_change,
)


router = APIRouter(prefix="/api/projects/{project_ref}/knowledge-drafts", tags=["knowledge-drafts"])

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


@router.get("", response_model=KnowledgeDraftListResponse)
def get_knowledge_drafts(project_ref: str) -> KnowledgeDraftListResponse:
    result = list_knowledge_drafts(project_ref)
    if not result.ok:
        _error(result.status_code, result.error_code, result.message)
    return KnowledgeDraftListResponse(
        ok=True,
        project_ref=result.project_ref,
        drafts=_sanitize_payload(result.drafts),
        message="Knowledge Draft list loaded.",
    )


@router.get("/{draft_id}", response_model=KnowledgeDraftResponse)
def get_knowledge_draft_by_id(project_ref: str, draft_id: str) -> KnowledgeDraftResponse:
    result = get_knowledge_draft(project_ref, draft_id)
    if not result.ok:
        _error(result.status_code, result.error_code, result.message)
    return KnowledgeDraftResponse(
        ok=True,
        project_ref=result.project_ref,
        draft=_sanitize_payload(result.draft),
        message="Knowledge Draft loaded.",
    )


@router.post("/{draft_id}/changes/{change_id}/accept", response_model=KnowledgeDraftChangeReviewResponse)
def accept_knowledge_draft_change(
    project_ref: str,
    draft_id: str,
    change_id: str,
    request: KnowledgeDraftChangeAcceptRequest | None = None,
) -> KnowledgeDraftChangeReviewResponse:
    payload = request or KnowledgeDraftChangeAcceptRequest()
    result = accept_candidate_change(project_ref, draft_id, change_id, payload.model_dump(exclude_unset=True))
    if not result.ok:
        _error(result.status_code, result.error_code, result.message)
    return KnowledgeDraftChangeReviewResponse(
        ok=True,
        project_ref=result.project_ref,
        draft=_sanitize_payload(result.draft),
        change=_sanitize_payload(result.change),
        graph=_sanitize_payload(result.graph),
        views=_sanitize_payload(result.views),
        node=_sanitize_payload(result.node),
        edge=_sanitize_payload(result.edge),
        message=result.message,
    )


@router.post("/{draft_id}/changes/{change_id}/reject", response_model=KnowledgeDraftChangeReviewResponse)
def reject_knowledge_draft_change(
    project_ref: str,
    draft_id: str,
    change_id: str,
    request: KnowledgeDraftChangeRejectRequest | None = None,
) -> KnowledgeDraftChangeReviewResponse:
    payload = request or KnowledgeDraftChangeRejectRequest()
    result = reject_candidate_change(project_ref, draft_id, change_id, payload.model_dump(exclude_unset=True))
    if not result.ok:
        _error(result.status_code, result.error_code, result.message)
    return KnowledgeDraftChangeReviewResponse(
        ok=True,
        project_ref=result.project_ref,
        draft=_sanitize_payload(result.draft),
        change=_sanitize_payload(result.change),
        graph={},
        views={},
        node=None,
        edge=None,
        message=result.message,
    )
