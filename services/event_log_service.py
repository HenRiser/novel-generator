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


EVENT_LOG_VERSION = 1
HISTORY_DIR_NAME = "history"
EVENTS_NAME = "events.json"
ALLOWED_EVENT_TYPES = {
    "chapter_generated",
    "story_delta_analyzed",
    "knowledge_draft_change_accepted",
    "knowledge_draft_change_rejected",
    "narrative_graph_node_created",
    "narrative_graph_node_updated",
    "narrative_graph_node_deleted",
    "narrative_graph_edge_created",
    "narrative_graph_edge_updated",
    "narrative_graph_edge_deleted",
    "narrative_graph_tag_created",
    "narrative_graph_tag_updated",
    "narrative_graph_tag_deleted",
    "snapshot_created",
}
SENSITIVE_KEY_PARTS = ("api_key", "apikey", "password", "secret")
SENSITIVE_EXACT_KEYS = ("token", "access_token", "refresh_token", "auth_token", "bearer_token")


@dataclass(frozen=True)
class EventLogResult:
    ok: bool
    project_ref: str = ""
    events: list[dict[str, Any]] = field(default_factory=list)
    event: dict[str, Any] = field(default_factory=dict)
    message: str = ""
    status_code: int = 400
    error_code: str = "event_log_error"


def _timestamp() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _clean_text(value: Any) -> str:
    return str(value or "").strip()


def _safe_id(prefix: str) -> str:
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe_prefix = re.sub(r"[^A-Za-z0-9_]+", "_", _clean_text(prefix)).strip("_") or "event"
    return f"{safe_prefix}_{timestamp}_{secrets.token_hex(4)}"


def _workspace_context(project_ref: str) -> tuple[Any | None, str]:
    ref = _clean_text(project_ref)
    if not ref:
        return None, "Unknown project_ref."
    try:
        ctx = resolve_project_context(ref)
    except FileNotFoundError:
        return None, "Project not found."
    except ValueError as exc:
        return None, str(exc) or "Unknown project_ref."
    if ctx.storage_kind != WORKSPACE_STORAGE_KIND:
        return None, "Event log is only supported for workspace book projects."
    return ctx, ""


def _events_path(ctx: Any) -> Path:
    return ctx.project_dir / HISTORY_DIR_NAME / EVENTS_NAME


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


def _empty_event_log(project_ref: str) -> dict[str, Any]:
    return {
        "version": EVENT_LOG_VERSION,
        "project_ref": project_ref,
        "events": [],
    }


def _normalize_event_log(data: dict[str, Any] | None, project_ref: str) -> dict[str, Any]:
    if data is None:
        return _empty_event_log(project_ref)
    document = dict(data)
    document["version"] = EVENT_LOG_VERSION
    document["project_ref"] = project_ref
    events = document.get("events")
    document["events"] = [
        _sanitize_payload(event)
        for event in events
        if isinstance(event, dict)
    ] if isinstance(events, list) else []
    return document


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
    if isinstance(value, Path):
        return value.name
    if isinstance(value, str):
        text = value.strip()
        if text and (Path(text).is_absolute() or re.match(r"^[A-Za-z]:[\\/]", text)):
            return Path(text).name or "[absolute_path]"
    return value


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    result: list[str] = []
    seen: set[str] = set()
    for item in value:
        text = _clean_text(item).replace("\\", "/")
        if not text or Path(text).is_absolute() or text in seen:
            continue
        seen.add(text)
        result.append(text)
    return result


def _error_result(project_ref: str, message: str, code: str, status_code: int = 400) -> EventLogResult:
    return EventLogResult(
        False,
        project_ref=project_ref,
        message=message,
        error_code=code,
        status_code=status_code,
    )


def list_events(project_ref: str) -> EventLogResult:
    ctx, message = _workspace_context(project_ref)
    if ctx is None:
        return _error_result(
            project_ref,
            message,
            "event_log_unsupported_project" if "only supported" in message else "event_log_unavailable",
            400,
        )
    try:
        document = _normalize_event_log(_read_json(_events_path(ctx)), project_ref)
    except (OSError, ValueError) as exc:
        return _error_result(project_ref, f"Event log read failed: {exc}", "event_log_read_failed", 400)
    return EventLogResult(True, project_ref=project_ref, events=document["events"])


def append_event(
    project_ref: str,
    event_type: str,
    summary: str = "",
    chapter_number: int | None = None,
    source: dict[str, Any] | None = None,
    changed_targets: list[str] | None = None,
    snapshot_id: str | None = None,
) -> EventLogResult:
    ctx, message = _workspace_context(project_ref)
    if ctx is None:
        return _error_result(
            project_ref,
            message,
            "event_log_unsupported_project" if "only supported" in message else "event_log_unavailable",
            400,
        )

    clean_type = _clean_text(event_type)
    if clean_type not in ALLOWED_EVENT_TYPES:
        return _error_result(project_ref, "Event type is not supported.", "event_log_type_unsupported", 400)

    event = {
        "id": _safe_id("event"),
        "type": clean_type,
        "project_ref": project_ref,
        "chapter_number": chapter_number if isinstance(chapter_number, int) and chapter_number > 0 else None,
        "summary": _clean_text(summary),
        "source": _sanitize_payload(source if isinstance(source, dict) else {}),
        "changed_targets": _string_list(changed_targets or []),
        "snapshot_id": _clean_text(snapshot_id) or None,
        "created_at": _timestamp(),
    }

    try:
        document = _normalize_event_log(_read_json(_events_path(ctx)), project_ref)
        document["events"].append(event)
        _write_json_atomic(_events_path(ctx), document)
    except (OSError, ValueError) as exc:
        return _error_result(project_ref, f"Event log write failed: {exc}", "event_log_write_failed", 400)

    return EventLogResult(True, project_ref=project_ref, events=document["events"], event=event, message="Event appended.")


def append_event_best_effort(
    project_ref: str,
    event_type: str,
    summary: str = "",
    chapter_number: int | None = None,
    source: dict[str, Any] | None = None,
    changed_targets: list[str] | None = None,
    snapshot_id: str | None = None,
) -> None:
    try:
        append_event(
            project_ref=project_ref,
            event_type=event_type,
            summary=summary,
            chapter_number=chapter_number,
            source=source,
            changed_targets=changed_targets,
            snapshot_id=snapshot_id,
        )
    except Exception:
        return
