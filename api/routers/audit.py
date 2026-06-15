from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

from api.schemas import EventLogResponse, SafetySnapshotListResponse
from config import PROJECT_ROOT
from services.event_log_service import list_events
from services.safety_snapshot_service import list_safety_snapshots


router = APIRouter(prefix="/api/projects/{project_ref}", tags=["audit"])

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


@router.get("/events", response_model=EventLogResponse)
def get_events(project_ref: str) -> EventLogResponse:
    result = list_events(project_ref)
    if not result.ok:
        _error(result.status_code, result.error_code, result.message)
    return EventLogResponse(
        ok=True,
        project_ref=result.project_ref,
        events=_sanitize_payload(result.events),
        message="Event log loaded.",
    )


@router.get("/snapshots", response_model=SafetySnapshotListResponse)
def get_snapshots(project_ref: str) -> SafetySnapshotListResponse:
    result = list_safety_snapshots(project_ref)
    if not result.ok:
        _error(result.status_code, result.error_code, result.message)
    return SafetySnapshotListResponse(
        ok=True,
        project_ref=result.project_ref,
        snapshots=_sanitize_payload(result.snapshots),
        message="Safety snapshots loaded.",
    )
