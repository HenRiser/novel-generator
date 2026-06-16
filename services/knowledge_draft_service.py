from __future__ import annotations

import json
import re
import secrets
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from file_manager import resolve_project_context
from project_context import WORKSPACE_STORAGE_KIND

from .event_log_service import append_event_best_effort
from .narrative_graph_service import (
    NODE_TYPES,
    build_graph_edge_for_create,
    build_graph_node_for_create,
    graph_node_ids,
    load_graph_documents_for_review,
    save_graph_documents_for_review,
)
from .safety_snapshot_service import create_safety_snapshot


DOCUMENT_VERSION = 1
MEMORY_DIR_NAME = "memory"
KNOWLEDGE_DRAFTS_NAME = "knowledge_drafts.json"
SUPPORTED_ACCEPT_OPERATIONS = {"create_node", "create_edge"}
CHANGE_STATUSES = {"pending_review", "accepted", "rejected", "failed", "superseded"}
TERMINAL_CHANGE_STATUSES = {"accepted", "rejected", "superseded"}
REVIEWED_BY = "user"


@dataclass(frozen=True)
class KnowledgeDraftReviewResult:
    ok: bool
    project_ref: str = ""
    drafts: list[dict[str, Any]] = field(default_factory=list)
    draft: dict[str, Any] = field(default_factory=dict)
    change: dict[str, Any] = field(default_factory=dict)
    graph: dict[str, Any] = field(default_factory=dict)
    views: dict[str, Any] = field(default_factory=dict)
    node: dict[str, Any] | None = None
    edge: dict[str, Any] | None = None
    message: str = ""
    status_code: int = 400
    error_code: str = "knowledge_draft_error"


def _timestamp() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _clean_text(value: Any) -> str:
    return str(value or "").strip()


def _workspace_context(project_ref: str) -> tuple[Any | None, str]:
    ref = _clean_text(project_ref)
    if not ref:
        return None, "Unknown project_ref."
    try:
        ctx = resolve_project_context(ref)
    except (FileNotFoundError, ValueError) as exc:
        return None, str(exc) or "Unknown project_ref."
    if ctx.storage_kind != WORKSPACE_STORAGE_KIND:
        return None, "Knowledge Draft review is only supported for workspace book projects."
    return ctx, ""


def _memory_dir(ctx: Any) -> Path:
    return ctx.project_dir / MEMORY_DIR_NAME


def _knowledge_drafts_path(ctx: Any) -> Path:
    return _memory_dir(ctx) / KNOWLEDGE_DRAFTS_NAME


def _read_json(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"{path.name} is not valid JSON.") from exc
    if not isinstance(data, dict):
        raise ValueError(f"{path.name} must be a JSON object.")
    return data


def _write_json_atomic(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(f".{path.name}.{secrets.token_hex(4)}.tmp")
    temp_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    temp_path.replace(path)


def _empty_knowledge_drafts(project_ref: str, created_at: str | None = None) -> dict[str, Any]:
    now = _timestamp()
    return {
        "version": DOCUMENT_VERSION,
        "metadata": {
            "project_ref": project_ref,
            "created_at": created_at or now,
            "updated_at": now,
        },
        "drafts": [],
    }


def _normalize_result(value: Any) -> dict[str, Any]:
    result = dict(value) if isinstance(value, dict) else {}
    result.setdefault("created_node_id", None)
    result.setdefault("created_edge_id", None)
    result.setdefault("error", None)
    return result


def _normalize_payload_for_operation(operation: str, payload: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(payload)
    if operation == "create_node":
        node_type = _clean_text(normalized.get("type")) or _clean_text(normalized.get("node_type"))
        if node_type:
            normalized["type"] = node_type
        normalized.pop("node_type", None)
        if not _clean_text(normalized.get("summary")) and _clean_text(normalized.get("description")):
            normalized["summary"] = _clean_text(normalized.get("description"))
    elif operation == "create_edge":
        for endpoint in ("source", "target"):
            node_id_key = f"{endpoint}_node_id"
            if not _clean_text(normalized.get(endpoint)) and _clean_text(normalized.get(node_id_key)):
                normalized[endpoint] = _clean_text(normalized.get(node_id_key))
        if not _clean_text(normalized.get("label")):
            normalized["label"] = (
                _clean_text(normalized.get("description"))
                or _clean_text(normalized.get("summary"))
                or _clean_text(normalized.get("type"))
            )
        if not _clean_text(normalized.get("summary")) and _clean_text(normalized.get("description")):
            normalized["summary"] = _clean_text(normalized.get("description"))
    return normalized


def normalize_candidate_change(change: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(change)
    status = _clean_text(normalized.get("status")) or "pending_review"
    if status not in CHANGE_STATUSES:
        status = "pending_review"
    normalized["status"] = status
    normalized["requires_review"] = True
    normalized.setdefault("reviewed_at", None)
    normalized.setdefault("reviewed_by", None)
    normalized.setdefault("review_note", "")
    normalized["result"] = _normalize_result(normalized.get("result"))
    payload = normalized.get("payload")
    if isinstance(payload, dict):
        normalized["payload"] = _normalize_payload_for_operation(_clean_text(normalized.get("operation")), payload)
    else:
        normalized["payload"] = payload
    return normalized


def aggregate_draft_status(draft: dict[str, Any]) -> str:
    changes = [
        change
        for change in draft.get("candidate_changes", [])
        if isinstance(change, dict)
    ]
    statuses = [
        _clean_text(change.get("status")) or "pending_review"
        for change in changes
    ]
    statuses = [status if status in CHANGE_STATUSES else "pending_review" for status in statuses]
    if not statuses:
        return _clean_text(draft.get("status")) or "pending_review"
    if all(status == "pending_review" for status in statuses):
        return "pending_review"
    if all(status == "accepted" for status in statuses):
        return "accepted"
    if all(status == "rejected" for status in statuses):
        return "rejected"
    if any(status in {"pending_review", "failed"} for status in statuses):
        return "partially_reviewed"
    return "completed"


def _normalize_draft(draft: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(draft)
    raw_changes = normalized.get("candidate_changes")
    normalized["candidate_changes"] = [
        normalize_candidate_change(change)
        for change in raw_changes
        if isinstance(change, dict)
    ] if isinstance(raw_changes, list) else []
    normalized["status"] = aggregate_draft_status(normalized)
    return normalized


def _normalize_knowledge_drafts_document(data: dict[str, Any] | None, project_ref: str) -> dict[str, Any]:
    if data is None:
        return _empty_knowledge_drafts(project_ref)
    document = dict(data)
    document["version"] = DOCUMENT_VERSION
    metadata = dict(document.get("metadata") if isinstance(document.get("metadata"), dict) else {})
    metadata["project_ref"] = project_ref
    metadata.setdefault("created_at", _timestamp())
    metadata.setdefault("updated_at", metadata["created_at"])
    document["metadata"] = metadata
    raw_drafts = document.get("drafts")
    document["drafts"] = [
        _normalize_draft(draft)
        for draft in raw_drafts
        if isinstance(draft, dict)
    ] if isinstance(raw_drafts, list) else []
    return document


def _update_metadata(document: dict[str, Any]) -> None:
    now = _timestamp()
    metadata = dict(document.get("metadata") if isinstance(document.get("metadata"), dict) else {})
    metadata.setdefault("created_at", now)
    metadata["updated_at"] = now
    document["metadata"] = metadata


def _load_document(project_ref: str) -> tuple[Any | None, dict[str, Any] | None, str]:
    ctx, message = _workspace_context(project_ref)
    if ctx is None:
        return None, None, message
    try:
        document = _normalize_knowledge_drafts_document(
            _read_json(_knowledge_drafts_path(ctx)),
            project_ref,
        )
    except (OSError, ValueError) as exc:
        return None, None, f"Knowledge Draft read failed: {exc}"
    return ctx, document, ""


def _save_document(ctx: Any, document: dict[str, Any]) -> None:
    _update_metadata(document)
    _write_json_atomic(_knowledge_drafts_path(ctx), document)


def _find_draft_index(document: dict[str, Any], draft_id: str) -> int | None:
    wanted = _clean_text(draft_id)
    for index, draft in enumerate(document.get("drafts", [])):
        if isinstance(draft, dict) and _clean_text(draft.get("id")) == wanted:
            return index
    return None


def _find_change_index(draft: dict[str, Any], change_id: str) -> int | None:
    wanted = _clean_text(change_id)
    for index, change in enumerate(draft.get("candidate_changes", [])):
        if isinstance(change, dict) and _clean_text(change.get("id")) == wanted:
            return index
    return None


def _safe_graph_id(kind: str, change_id: str) -> str:
    safe_change_id = re.sub(r"[^A-Za-z0-9_]+", "_", _clean_text(change_id)).strip("_") or "change"
    return f"{kind}_from_{safe_change_id}"


def _chapter_number(draft: dict[str, Any]) -> int | None:
    try:
        value = int(draft.get("chapter_number"))
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def _review_source_info(draft: dict[str, Any], change: dict[str, Any]) -> dict[str, Any]:
    chapter_number = _chapter_number(draft)
    introduced_in = f"chapter_{chapter_number:03d}" if chapter_number is not None else None
    return {
        "created_by": "knowledge_draft_review",
        "introduced_in": introduced_in,
        "last_updated_in": None,
        "draft_id": _clean_text(draft.get("id")),
        "candidate_change_id": _clean_text(change.get("id")),
        "source_delta_id": _clean_text(draft.get("source_delta_id")) or None,
        "chapter_number": chapter_number,
        "candidate_source": _clean_text(change.get("source")) or None,
    }


def _review_info_from_entity(entity: dict[str, Any]) -> dict[str, Any]:
    for key in ("source", "source_info"):
        value = entity.get(key)
        if isinstance(value, dict):
            return value
    properties = entity.get("properties")
    if isinstance(properties, dict) and isinstance(properties.get("_review"), dict):
        return properties["_review"]
    return {}


def _review_matches(entity: dict[str, Any], draft_id: str, change_id: str) -> bool:
    info = _review_info_from_entity(entity)
    return (
        _clean_text(info.get("created_by")) == "knowledge_draft_review"
        and _clean_text(info.get("draft_id")) == _clean_text(draft_id)
        and _clean_text(info.get("candidate_change_id")) == _clean_text(change_id)
    )


def _find_existing_review_entity(
    graph: dict[str, Any],
    entity_kind: str,
    draft_id: str,
    change_id: str,
) -> dict[str, Any] | None:
    graph_data = graph.get("graph") if isinstance(graph.get("graph"), dict) else {}
    key = "nodes" if entity_kind == "node" else "edges"
    for entity in graph_data.get(key, []):
        if isinstance(entity, dict) and _review_matches(entity, draft_id, change_id):
            return entity
    return None


def _find_entity_by_id(graph: dict[str, Any], entity_kind: str, entity_id: str) -> dict[str, Any] | None:
    graph_data = graph.get("graph") if isinstance(graph.get("graph"), dict) else {}
    key = "nodes" if entity_kind == "node" else "edges"
    for entity in graph_data.get(key, []):
        if isinstance(entity, dict) and _clean_text(entity.get("id")) == _clean_text(entity_id):
            return entity
    return None


def _resolved_status(payload: dict[str, Any], change: dict[str, Any]) -> str:
    payload_status = _clean_text(payload.get("status"))
    if payload_status:
        return payload_status
    suggested_status = _clean_text(payload.get("suggested_status"))
    if suggested_status:
        return suggested_status
    source = _clean_text(change.get("source"))
    if source == "story_delta":
        return "confirmed"
    if source == "next_chapter_proposal":
        return "planned"
    return "active"


def _payload_for_graph(payload: dict[str, Any], change: dict[str, Any]) -> dict[str, Any]:
    graph_payload = dict(payload)
    graph_payload.pop("suggested_status", None)
    graph_payload.pop("node_type", None)
    graph_payload.pop("source_node_id", None)
    graph_payload.pop("target_node_id", None)
    if not _clean_text(graph_payload.get("summary")) and _clean_text(payload.get("description")):
        graph_payload["summary"] = _clean_text(payload.get("description"))
    graph_payload["status"] = _resolved_status(payload, change)
    return graph_payload


def _result_with_entity(entity_kind: str, entity_id: str, error: str | None = None) -> dict[str, Any]:
    return {
        "created_node_id": entity_id if entity_kind == "node" else None,
        "created_edge_id": entity_id if entity_kind == "edge" else None,
        "error": error,
    }


def _mark_change_accepted(
    draft: dict[str, Any],
    change_index: int,
    entity_kind: str,
    entity_id: str,
    review_note: str,
) -> dict[str, Any]:
    changes = draft["candidate_changes"]
    change = dict(changes[change_index])
    change["status"] = "accepted"
    change["reviewed_at"] = _timestamp()
    change["reviewed_by"] = REVIEWED_BY
    change["review_note"] = review_note
    change["requires_review"] = True
    change["result"] = _result_with_entity(entity_kind, entity_id)
    changes[change_index] = change
    draft["status"] = aggregate_draft_status(draft)
    return change


def _mark_change_rejected(draft: dict[str, Any], change_index: int, review_note: str) -> dict[str, Any]:
    changes = draft["candidate_changes"]
    change = dict(changes[change_index])
    change["status"] = "rejected"
    change["reviewed_at"] = _timestamp()
    change["reviewed_by"] = REVIEWED_BY
    change["review_note"] = review_note
    change["requires_review"] = True
    change["result"] = {
        "created_node_id": None,
        "created_edge_id": None,
        "error": None,
    }
    changes[change_index] = change
    draft["status"] = aggregate_draft_status(draft)
    return change


def _error_result(
    project_ref: str,
    message: str,
    code: str,
    status_code: int = 400,
) -> KnowledgeDraftReviewResult:
    return KnowledgeDraftReviewResult(
        False,
        project_ref=project_ref,
        message=message,
        error_code=code,
        status_code=status_code,
    )


def _load_draft_and_change(
    project_ref: str,
    draft_id: str,
    change_id: str,
) -> tuple[Any | None, dict[str, Any] | None, int | None, int | None, KnowledgeDraftReviewResult | None]:
    ctx, document, message = _load_document(project_ref)
    if ctx is None or document is None:
        return None, None, None, None, _error_result(
            project_ref,
            message,
            "knowledge_draft_unsupported_project" if "only supported" in message else "knowledge_draft_unavailable",
            400,
        )

    draft_index = _find_draft_index(document, draft_id)
    if draft_index is None:
        return ctx, document, None, None, _error_result(
            project_ref,
            "Knowledge Draft not found.",
            "knowledge_draft_not_found",
            404,
        )

    draft = document["drafts"][draft_index]
    change_index = _find_change_index(draft, change_id)
    if change_index is None:
        return ctx, document, draft_index, None, _error_result(
            project_ref,
            "Candidate change not found.",
            "knowledge_draft_change_not_found",
            404,
        )

    return ctx, document, draft_index, change_index, None


def list_knowledge_drafts(project_ref: str) -> KnowledgeDraftReviewResult:
    _ctx, document, message = _load_document(project_ref)
    if document is None:
        return _error_result(
            project_ref,
            message,
            "knowledge_draft_unsupported_project" if "only supported" in message else "knowledge_draft_unavailable",
            400,
        )
    return KnowledgeDraftReviewResult(True, project_ref=project_ref, drafts=document["drafts"])


def get_knowledge_draft(project_ref: str, draft_id: str) -> KnowledgeDraftReviewResult:
    _ctx, document, message = _load_document(project_ref)
    if document is None:
        return _error_result(
            project_ref,
            message,
            "knowledge_draft_unsupported_project" if "only supported" in message else "knowledge_draft_unavailable",
            400,
        )
    draft_index = _find_draft_index(document, draft_id)
    if draft_index is None:
        return _error_result(
            project_ref,
            "Knowledge Draft not found.",
            "knowledge_draft_not_found",
            404,
        )
    return KnowledgeDraftReviewResult(True, project_ref=project_ref, draft=document["drafts"][draft_index])


def _payload_from_request(change: dict[str, Any], request: dict[str, Any]) -> tuple[dict[str, Any] | None, str]:
    override = request.get("payload_override")
    operation = _clean_text(change.get("operation"))
    if override is not None:
        if not isinstance(override, dict):
            return None, "payload_override must be a JSON object when provided."
        return _normalize_payload_for_operation(operation, override), ""
    payload = change.get("payload")
    if not isinstance(payload, dict):
        return None, "Candidate payload must be a JSON object."
    return _normalize_payload_for_operation(operation, payload), ""


def _validate_common_accept(change: dict[str, Any], payload: dict[str, Any]) -> str:
    if _clean_text(change.get("target")) != "narrative_graph":
        return "Candidate target must be narrative_graph."
    if not isinstance(payload, dict):
        return "Candidate payload must be a JSON object."
    return ""


def _build_node_from_change(
    graph: dict[str, Any],
    draft: dict[str, Any],
    change: dict[str, Any],
    payload: dict[str, Any],
) -> tuple[dict[str, Any] | None, str, str]:
    label = _clean_text(payload.get("label"))
    if not label:
        return None, "", "Node label cannot be empty."
    node_type = _clean_text(payload.get("type")) or _clean_text(payload.get("node_type"))
    if not node_type:
        return None, "", "Node type cannot be empty."
    if node_type not in NODE_TYPES:
        return None, "", "Node type is invalid."

    node_id = _safe_graph_id("node", _clean_text(change.get("id")))
    existing = _find_existing_review_entity(graph, "node", _clean_text(draft.get("id")), _clean_text(change.get("id")))
    if existing is not None:
        return existing, _clean_text(existing.get("id")), ""
    conflict = _find_entity_by_id(graph, "node", node_id)
    if conflict is not None:
        return None, node_id, "Node id already exists for a different review change."

    graph_payload = _payload_for_graph(payload, change)
    node, error = build_graph_node_for_create(
        graph,
        graph_payload,
        node_id,
        source=_review_source_info(draft, change),
    )
    return node, node_id, error


def _resolve_edge_endpoint(
    graph: dict[str, Any],
    draft: dict[str, Any],
    payload: dict[str, Any],
    endpoint_key: str,
) -> tuple[str, str]:
    node_ids = graph_node_ids(graph)
    direct = _clean_text(payload.get(endpoint_key)) or _clean_text(payload.get(f"{endpoint_key}_node_id"))
    if direct:
        if direct in node_ids:
            return direct, ""
        return "", f"{endpoint_key} node does not exist: {direct}."

    change_ref = _clean_text(payload.get(f"{endpoint_key}_change_id"))
    if change_ref:
        for change in draft.get("candidate_changes", []):
            if not isinstance(change, dict) or _clean_text(change.get("id")) != change_ref:
                continue
            if _clean_text(change.get("operation")) != "create_node":
                return "", f"{endpoint_key}_change_id must reference a create_node change."
            if _clean_text(change.get("status")) != "accepted":
                return "", f"{endpoint_key}_change_id must reference an accepted create_node change."
            created_node_id = _clean_text(_normalize_result(change.get("result")).get("created_node_id"))
            if not created_node_id:
                return "", f"{endpoint_key}_change_id does not have result.created_node_id."
            if created_node_id not in node_ids:
                return "", f"{endpoint_key}_change_id points to a node that is not in the formal graph."
            return created_node_id, ""
        return "", f"{endpoint_key}_change_id was not found in this draft."

    label_key = f"{endpoint_key}_label"
    if _clean_text(payload.get(label_key)):
        return "", f"{label_key} cannot be merged automatically; accept the node first and use {endpoint_key}_change_id."
    return "", f"{endpoint_key} must be an existing node id or an accepted {endpoint_key}_change_id."


def _build_edge_from_change(
    graph: dict[str, Any],
    draft: dict[str, Any],
    change: dict[str, Any],
    payload: dict[str, Any],
) -> tuple[dict[str, Any] | None, str, str]:
    source, source_error = _resolve_edge_endpoint(graph, draft, payload, "source")
    if source_error:
        return None, "", source_error
    target, target_error = _resolve_edge_endpoint(graph, draft, payload, "target")
    if target_error:
        return None, "", target_error
    if source == target:
        return None, "", "Edge source and target cannot be the same node."

    edge_type = _clean_text(payload.get("type"))
    if not edge_type:
        return None, "", "Edge type cannot be empty."
    if not _clean_text(payload.get("label")):
        payload["label"] = (
            _clean_text(payload.get("description"))
            or _clean_text(payload.get("summary"))
            or edge_type
        )
    if not _clean_text(payload.get("label")):
        return None, "", "Edge label cannot be empty."

    edge_id = _safe_graph_id("edge", _clean_text(change.get("id")))
    existing = _find_existing_review_entity(graph, "edge", _clean_text(draft.get("id")), _clean_text(change.get("id")))
    if existing is not None:
        return existing, _clean_text(existing.get("id")), ""
    conflict = _find_entity_by_id(graph, "edge", edge_id)
    if conflict is not None:
        return None, edge_id, "Edge id already exists for a different review change."

    graph_payload = _payload_for_graph(payload, change)
    graph_payload["source"] = source
    graph_payload["target"] = target
    graph_payload.pop("source_label", None)
    graph_payload.pop("target_label", None)
    graph_payload.pop("source_node_id", None)
    graph_payload.pop("target_node_id", None)
    graph_payload.pop("source_change_id", None)
    graph_payload.pop("target_change_id", None)
    edge, error = build_graph_edge_for_create(
        graph,
        graph_payload,
        edge_id,
        source_info=_review_source_info(draft, change),
    )
    return edge, edge_id, error


def accept_candidate_change(
    project_ref: str,
    draft_id: str,
    change_id: str,
    request: dict[str, Any] | None = None,
) -> KnowledgeDraftReviewResult:
    payload_request = dict(request) if isinstance(request, dict) else {}
    review_note = _clean_text(payload_request.get("review_note"))
    ctx, document, draft_index, change_index, error = _load_draft_and_change(project_ref, draft_id, change_id)
    if error is not None:
        return error
    assert ctx is not None and document is not None and draft_index is not None and change_index is not None

    draft = document["drafts"][draft_index]
    change = draft["candidate_changes"][change_index]
    status = _clean_text(change.get("status")) or "pending_review"
    if status in TERMINAL_CHANGE_STATUSES:
        return _error_result(
            project_ref,
            f"Candidate change is already {status}.",
            "knowledge_draft_change_already_reviewed",
            409,
        )
    operation = _clean_text(change.get("operation"))
    if operation not in SUPPORTED_ACCEPT_OPERATIONS:
        return _error_result(
            project_ref,
            f"Candidate operation '{operation or '[empty]'}' is not supported for merge.",
            "knowledge_draft_operation_unsupported",
            400,
        )

    payload, payload_error = _payload_from_request(change, payload_request)
    if payload is None:
        return _error_result(project_ref, payload_error, "knowledge_draft_payload_invalid", 400)
    common_error = _validate_common_accept(change, payload)
    if common_error:
        return _error_result(project_ref, common_error, "knowledge_draft_change_invalid", 400)

    graph_result = load_graph_documents_for_review(project_ref)
    if not graph_result.ok:
        return _error_result(project_ref, graph_result.message, "narrative_graph_unavailable", 400)
    graph = graph_result.graph
    views = graph_result.views

    entity_kind = "node" if operation == "create_node" else "edge"
    recovered_before = _find_existing_review_entity(
        graph,
        entity_kind,
        _clean_text(draft.get("id")),
        _clean_text(change.get("id")),
    ) is not None

    if operation == "create_node":
        entity, entity_id, build_error = _build_node_from_change(graph, draft, change, payload)
    else:
        entity, entity_id, build_error = _build_edge_from_change(graph, draft, change, payload)

    if build_error:
        code = "knowledge_draft_duplicate_graph_id" if "already exists" in build_error else "knowledge_draft_change_invalid"
        status_code = 409 if code == "knowledge_draft_duplicate_graph_id" else 400
        return _error_result(project_ref, build_error, code, status_code)
    if entity is None or not entity_id:
        return _error_result(project_ref, "Candidate change could not be converted.", "knowledge_draft_change_invalid", 400)

    snapshot_result = create_safety_snapshot(
        project_ref=project_ref,
        reason="before_accept_knowledge_draft_change",
        source={
            "draft_id": _clean_text(draft.get("id")),
            "candidate_change_id": _clean_text(change.get("id")),
            "operation": operation,
        },
    )
    if not snapshot_result.ok:
        return _error_result(project_ref, snapshot_result.message, snapshot_result.error_code, snapshot_result.status_code)

    if not recovered_before:
        graph.setdefault("graph", {}).setdefault("nodes" if entity_kind == "node" else "edges", []).append(entity)

    reviewed_change = _mark_change_accepted(draft, change_index, entity_kind, entity_id, review_note)
    document["drafts"][draft_index] = draft

    if not recovered_before:
        graph_save_result = save_graph_documents_for_review(project_ref, graph, views)
        if not graph_save_result.ok:
            return _error_result(project_ref, graph_save_result.message, "narrative_graph_write_failed", 400)
        graph = graph_save_result.graph
        views = graph_save_result.views

    try:
        _save_document(ctx, document)
    except (OSError, ValueError) as exc:
        return _error_result(
            project_ref,
            f"Knowledge Draft write failed after graph update: {exc}",
            "knowledge_draft_write_failed",
            400,
        )

    changed_targets = ["memory/knowledge_drafts.json"]
    if not recovered_before:
        changed_targets.insert(0, "memory/narrative_graph.json")
    append_event_best_effort(
        project_ref=project_ref,
        event_type="knowledge_draft_change_accepted",
        summary=f"Accepted {operation}: {entity_id}",
        chapter_number=_chapter_number(draft),
        source={
            "draft_id": _clean_text(draft.get("id")),
            "candidate_change_id": _clean_text(change.get("id")),
            "operation": operation,
            "created_node_id": entity_id if entity_kind == "node" else None,
            "created_edge_id": entity_id if entity_kind == "edge" else None,
        },
        changed_targets=changed_targets,
        snapshot_id=snapshot_result.snapshot_id,
    )

    return KnowledgeDraftReviewResult(
        True,
        project_ref=project_ref,
        draft=draft,
        change=reviewed_change,
        graph=graph,
        views=views,
        node=entity if entity_kind == "node" else None,
        edge=entity if entity_kind == "edge" else None,
        message="Candidate change accepted.",
    )


def reject_candidate_change(
    project_ref: str,
    draft_id: str,
    change_id: str,
    request: dict[str, Any] | None = None,
) -> KnowledgeDraftReviewResult:
    payload_request = dict(request) if isinstance(request, dict) else {}
    review_note = _clean_text(payload_request.get("review_note"))
    ctx, document, draft_index, change_index, error = _load_draft_and_change(project_ref, draft_id, change_id)
    if error is not None:
        return error
    assert ctx is not None and document is not None and draft_index is not None and change_index is not None

    draft = document["drafts"][draft_index]
    change = draft["candidate_changes"][change_index]
    status = _clean_text(change.get("status")) or "pending_review"
    if status in TERMINAL_CHANGE_STATUSES:
        return _error_result(
            project_ref,
            f"Candidate change is already {status}.",
            "knowledge_draft_change_already_reviewed",
            409,
        )

    reviewed_change = _mark_change_rejected(draft, change_index, review_note)
    document["drafts"][draft_index] = draft
    try:
        _save_document(ctx, document)
    except (OSError, ValueError) as exc:
        return _error_result(project_ref, f"Knowledge Draft write failed: {exc}", "knowledge_draft_write_failed", 400)

    append_event_best_effort(
        project_ref=project_ref,
        event_type="knowledge_draft_change_rejected",
        summary=f"Rejected candidate change: {_clean_text(change.get('id'))}",
        chapter_number=_chapter_number(draft),
        source={
            "draft_id": _clean_text(draft.get("id")),
            "candidate_change_id": _clean_text(change.get("id")),
            "operation": _clean_text(change.get("operation")),
        },
        changed_targets=["memory/knowledge_drafts.json"],
        snapshot_id=None,
    )

    return KnowledgeDraftReviewResult(
        True,
        project_ref=project_ref,
        draft=draft,
        change=reviewed_change,
        message="Candidate change rejected.",
    )
