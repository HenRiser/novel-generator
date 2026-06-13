from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

from api.schemas import (
    NarrativeGraphEdgeRequest,
    NarrativeGraphEdgeResponse,
    NarrativeGraphNodeRequest,
    NarrativeGraphNodeResponse,
    NarrativeGraphResponse,
    NarrativeGraphTagRequest,
    NarrativeGraphTagResponse,
)
from config import PROJECT_ROOT
from services.narrative_graph_service import (
    add_graph_edge,
    add_graph_node,
    add_graph_tag,
    load_narrative_graph,
)


router = APIRouter(prefix="/api/projects/{project_ref}/narrative-graph", tags=["narrative-graph"])

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
    return value


def _status_for_message(message: str) -> int:
    lowered = message.lower()
    if "not found" in lowered or "unknown project_ref" in lowered:
        return 404
    return 400


@router.get("", response_model=NarrativeGraphResponse)
def get_narrative_graph(project_ref: str) -> NarrativeGraphResponse:
    result = load_narrative_graph(project_ref)
    if not result.ok:
        _error(_status_for_message(result.message), "narrative_graph_unavailable", result.message)
    return NarrativeGraphResponse(
        ok=True,
        project_ref=result.project_ref,
        graph=_sanitize_payload(result.graph),
        views=_sanitize_payload(result.views),
        message=result.message,
    )


@router.post("/tags", response_model=NarrativeGraphTagResponse)
def create_narrative_graph_tag(
    project_ref: str,
    request: NarrativeGraphTagRequest,
) -> NarrativeGraphTagResponse:
    result = add_graph_tag(project_ref, request.model_dump())
    if not result.ok:
        _error(_status_for_message(result.message), "narrative_graph_tag_invalid", result.message)
    return NarrativeGraphTagResponse(
        ok=True,
        project_ref=result.project_ref,
        graph=_sanitize_payload(result.graph),
        views=_sanitize_payload(result.views),
        tag=_sanitize_payload(result.tag or {}),
        message=result.message,
    )


@router.post("/nodes", response_model=NarrativeGraphNodeResponse)
def create_narrative_graph_node(
    project_ref: str,
    request: NarrativeGraphNodeRequest,
) -> NarrativeGraphNodeResponse:
    result = add_graph_node(project_ref, request.model_dump())
    if not result.ok:
        _error(_status_for_message(result.message), "narrative_graph_node_invalid", result.message)
    return NarrativeGraphNodeResponse(
        ok=True,
        project_ref=result.project_ref,
        graph=_sanitize_payload(result.graph),
        views=_sanitize_payload(result.views),
        node=_sanitize_payload(result.node or {}),
        message=result.message,
    )


@router.post("/edges", response_model=NarrativeGraphEdgeResponse)
def create_narrative_graph_edge(
    project_ref: str,
    request: NarrativeGraphEdgeRequest,
) -> NarrativeGraphEdgeResponse:
    result = add_graph_edge(project_ref, request.model_dump())
    if not result.ok:
        _error(_status_for_message(result.message), "narrative_graph_edge_invalid", result.message)
    return NarrativeGraphEdgeResponse(
        ok=True,
        project_ref=result.project_ref,
        graph=_sanitize_payload(result.graph),
        views=_sanitize_payload(result.views),
        edge=_sanitize_payload(result.edge or {}),
        message=result.message,
    )
