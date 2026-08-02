from __future__ import annotations

import json
import re
import secrets
import shutil
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from file_manager import resolve_project_context
from project_context import WORKSPACE_STORAGE_KIND

from .event_log_service import append_event_best_effort
from .common import clean_text, read_json, resolve_workspace_context, timestamp, write_json_atomic


SNAPSHOT_VERSION = 1
SNAPSHOTS_DIR_NAME = "snapshots"
DEFAULT_SNAPSHOT_FILES = [
    "memory/narrative_graph.json",
    "memory/knowledge_drafts.json",
]
SENSITIVE_KEY_PARTS = ("api_key", "apikey", "password", "secret")
SENSITIVE_EXACT_KEYS = ("token", "access_token", "refresh_token", "auth_token", "bearer_token")


@dataclass(frozen=True)
class SafetySnapshotResult:
    ok: bool
    project_ref: str = ""
    snapshot_id: str = ""
    manifest: dict[str, Any] = field(default_factory=dict)
    snapshots: list[dict[str, Any]] = field(default_factory=list)
    message: str = ""
    status_code: int = 400
    error_code: str = "safety_snapshot_error"






def _safe_id(reason: str) -> str:
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe_reason = re.sub(r"[^A-Za-z0-9_]+", "_", clean_text(reason)).strip("_") or "snapshot"
    safe_reason = safe_reason[:60]
    return f"snapshot_{timestamp}_{safe_reason}_{secrets.token_hex(4)}"


def _workspace_context(project_ref: str) -> tuple[Any | None, str]:
    ctx, message, _status, _code = resolve_workspace_context(
        project_ref,
        resolve=resolve_project_context,
    storage_message='Safety snapshots are only supported for workspace book projects.',
    )
    return ctx, message


def _snapshots_dir(ctx: Any) -> Path:
    return ctx.project_dir / SNAPSHOTS_DIR_NAME






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


def _valid_relative_path(value: str) -> str:
    text = clean_text(value).replace("\\", "/")
    if not text or Path(text).is_absolute() or ".." in Path(text).parts:
        return ""
    return text


def _error_result(project_ref: str, message: str, code: str, status_code: int = 400) -> SafetySnapshotResult:
    return SafetySnapshotResult(
        False,
        project_ref=project_ref,
        message=message,
        error_code=code,
        status_code=status_code,
    )


def create_safety_snapshot(
    project_ref: str,
    reason: str,
    source: dict[str, Any] | None = None,
    files: list[str] | None = None,
) -> SafetySnapshotResult:
    ctx, message = _workspace_context(project_ref)
    if ctx is None:
        return _error_result(
            project_ref,
            message,
            "safety_snapshot_unsupported_project" if "only supported" in message else "safety_snapshot_unavailable",
            400,
        )

    clean_reason = clean_text(reason) or "manual_snapshot"
    snapshot_id = _safe_id(clean_reason)
    snapshot_dir = _snapshots_dir(ctx) / snapshot_id
    copied_files: list[str] = []
    skipped_files: list[str] = []
    requested_files = files if isinstance(files, list) else DEFAULT_SNAPSHOT_FILES

    try:
        snapshot_dir.mkdir(parents=True, exist_ok=False)
        for item in requested_files:
            relative_path = _valid_relative_path(item)
            if not relative_path:
                continue
            source_path = ctx.project_dir / Path(relative_path)
            if not source_path.exists() or not source_path.is_file():
                skipped_files.append(relative_path)
                continue
            target_path = snapshot_dir / Path(relative_path)
            target_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source_path, target_path)
            copied_files.append(relative_path)

        manifest = {
            "version": SNAPSHOT_VERSION,
            "id": snapshot_id,
            "reason": clean_reason,
            "project_ref": project_ref,
            "source": _sanitize_payload(source if isinstance(source, dict) else {}),
            "files": copied_files,
            "skipped_files": skipped_files,
            "created_at": timestamp(),
        }
        write_json_atomic(snapshot_dir / "manifest.json", manifest)
    except (OSError, ValueError) as exc:
        return _error_result(project_ref, f"Safety snapshot failed: {exc}", "safety_snapshot_write_failed", 400)

    append_event_best_effort(
        project_ref=project_ref,
        event_type="snapshot_created",
        summary=f"Created safety snapshot: {clean_reason}",
        source=manifest["source"],
        changed_targets=[f"snapshots/{snapshot_id}/manifest.json"],
        snapshot_id=snapshot_id,
    )

    return SafetySnapshotResult(
        True,
        project_ref=project_ref,
        snapshot_id=snapshot_id,
        manifest=manifest,
        message="Safety snapshot created.",
    )


def list_safety_snapshots(project_ref: str) -> SafetySnapshotResult:
    ctx, message = _workspace_context(project_ref)
    if ctx is None:
        return _error_result(
            project_ref,
            message,
            "safety_snapshot_unsupported_project" if "only supported" in message else "safety_snapshot_unavailable",
            400,
        )

    snapshots: list[dict[str, Any]] = []
    root = _snapshots_dir(ctx)
    if not root.exists():
        return SafetySnapshotResult(True, project_ref=project_ref, snapshots=[])

    try:
        for path in root.iterdir():
            if not path.is_dir():
                continue
            manifest = read_json(path / "manifest.json")
            if not isinstance(manifest, dict):
                continue
            snapshots.append(_sanitize_payload(manifest))
    except (OSError, ValueError) as exc:
        return _error_result(project_ref, f"Safety snapshot read failed: {exc}", "safety_snapshot_read_failed", 400)

    snapshots.sort(key=lambda item: clean_text(item.get("created_at")), reverse=True)
    return SafetySnapshotResult(True, project_ref=project_ref, snapshots=snapshots)