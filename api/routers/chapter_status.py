from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

from api.schemas import (
    ChapterStatusOverviewResponse,
    ChapterStatusResponse,
    WorkflowGuardCheckRequest,
    WorkflowGuardCheckResponse,
)
from config import PROJECT_ROOT
from services.chapter_status_service import (
    check_workflow_guard,
    get_chapter_status,
    list_chapter_statuses,
)


router = APIRouter(prefix="/api/projects/{project_ref}", tags=["chapter-status"])

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


@router.get("/chapters/{chapter_number}/status", response_model=ChapterStatusResponse)
def get_project_chapter_status(project_ref: str, chapter_number: int) -> ChapterStatusResponse:
    result = get_chapter_status(project_ref, chapter_number)
    if not result.ok:
        _error(result.status_code, result.error_code, result.message)
    return ChapterStatusResponse(
        ok=True,
        project_ref=result.project_ref,
        chapter_status=_sanitize_payload(result.chapter_status),
        message="Chapter status loaded.",
    )


@router.get("/chapter-status", response_model=ChapterStatusOverviewResponse)
def get_project_chapter_status_overview(project_ref: str) -> ChapterStatusOverviewResponse:
    result = list_chapter_statuses(project_ref)
    if not result.ok:
        _error(result.status_code, result.error_code, result.message)
    return ChapterStatusOverviewResponse(
        ok=True,
        project_ref=result.project_ref,
        chapters=_sanitize_payload(result.chapters),
        summary=_sanitize_payload(result.summary),
        message="Chapter status overview loaded.",
    )


@router.post("/workflow-guard/check", response_model=WorkflowGuardCheckResponse)
def check_project_workflow_guard(
    project_ref: str,
    request: WorkflowGuardCheckRequest,
) -> WorkflowGuardCheckResponse:
    result = check_workflow_guard(project_ref, request.model_dump(exclude_unset=True))
    if not result.ok:
        _error(result.status_code, result.error_code, result.message)
    guard = _sanitize_payload(result.guard)
    return WorkflowGuardCheckResponse(
        ok=True,
        project_ref=result.project_ref,
        action=str(guard.get("action") or ""),
        chapter_number=int(guard.get("chapter_number") or 0),
        blocking=bool(guard.get("blocking")),
        warnings=guard.get("warnings") if isinstance(guard.get("warnings"), list) else [],
        suggested_actions=guard.get("suggested_actions") if isinstance(guard.get("suggested_actions"), list) else [],
        message="Workflow guard checked.",
    )
