from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

from api.schemas import ContextPackPreviewRequest, ContextPackPreviewResponse
from config import PROJECT_ROOT
from services.context_pack_service import build_context_pack


router = APIRouter(prefix="/api/projects/{project_ref}/context-pack", tags=["context-pack"])

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
    if "not found" in lowered or "unknown project_ref" in lowered:
        return 404
    return 400


@router.post("/preview", response_model=ContextPackPreviewResponse)
def preview_context_pack(
    project_ref: str,
    request: ContextPackPreviewRequest,
) -> ContextPackPreviewResponse:
    result = build_context_pack(project_ref, request.model_dump(exclude_unset=True))
    if not result.ok:
        _error(_status_for_message(result.message), "context_pack_unavailable", result.message)
    return ContextPackPreviewResponse(
        ok=True,
        project_ref=result.project_ref,
        context_pack=_sanitize_payload(result.context_pack),
        prompt_text=_sanitize_payload(result.prompt_text),
        message=result.message,
    )
