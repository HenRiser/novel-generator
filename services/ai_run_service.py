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
from .common import clean_text, read_json, resolve_workspace_context, timestamp, write_json_atomic


AI_RUN_VERSION = 1
LOGS_DIR_NAME = "logs"
AI_RUNS_DIR_NAME = "ai_runs"
PROMPT_PREVIEW_LIMIT = 800
SENSITIVE_KEY_PARTS = ("api_key", "apikey", "password", "secret")
SENSITIVE_EXACT_KEYS = ("token", "access_token", "refresh_token", "auth_token", "bearer_token")


@dataclass(frozen=True)
class AIRunResult:
    ok: bool
    project_ref: str = ""
    run_id: str = ""
    run: dict[str, Any] = field(default_factory=dict)
    runs: list[dict[str, Any]] = field(default_factory=list)
    message: str = ""
    status_code: int = 400
    error_code: str = "ai_run_error"






def _safe_id(prefix: str = "run") -> str:
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe_prefix = re.sub(r"[^A-Za-z0-9_]+", "_", clean_text(prefix)).strip("_") or "run"
    return f"{safe_prefix}_{timestamp}_{secrets.token_hex(4)}"


def _workspace_context(project_ref: str) -> tuple[Any | None, str]:
    ctx, message, _status, _code = resolve_workspace_context(
        project_ref,
        resolve=resolve_project_context,
    storage_message='AI Run Provenance is only supported for workspace book projects.',
    )
    return ctx, message


def _ai_runs_dir(ctx: Any) -> Path:
    return ctx.project_dir / LOGS_DIR_NAME / AI_RUNS_DIR_NAME


def _run_path(ctx: Any, run_id: str) -> Path:
    return _ai_runs_dir(ctx) / f"{run_id}.json"






def _sanitize_string(value: str) -> str:
    text = str(value or "")
    stripped = text.strip()
    if stripped and (Path(stripped).is_absolute() or re.match(r"^[A-Za-z]:[\\/]", stripped)):
        return Path(stripped).name or "[absolute_path]"
    return text


def sanitize_ai_run(value: Any) -> Any:
    if isinstance(value, dict):
        sanitized: dict[str, Any] = {}
        for key, item in value.items():
            lowered_key = str(key).lower()
            if lowered_key in SENSITIVE_EXACT_KEYS or any(part in lowered_key for part in SENSITIVE_KEY_PARTS):
                sanitized[key] = "[redacted]"
                continue
            if lowered_key == "prompt_preview":
                sanitized[key] = _sanitize_string(str(item or ""))[:PROMPT_PREVIEW_LIMIT]
                continue
            sanitized[key] = sanitize_ai_run(item)
        return sanitized
    if isinstance(value, list):
        return [sanitize_ai_run(item) for item in value]
    if isinstance(value, Path):
        return value.name
    if isinstance(value, str):
        return _sanitize_string(value)
    return value


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    result: list[str] = []
    seen: set[str] = set()
    for item in value:
        text = clean_text(item).replace("\\", "/")
        if not text or Path(text).is_absolute() or ".." in Path(text).parts or text in seen:
            continue
        seen.add(text)
        result.append(text)
    return result


def _normalize_context(context: Any) -> dict[str, Any]:
    source = dict(context) if isinstance(context, dict) else {}
    return {
        "context_pack_id": clean_text(source.get("context_pack_id")) or None,
        "included_node_ids": _string_list(source.get("included_node_ids")),
        "included_edge_ids": _string_list(source.get("included_edge_ids")),
        "outline_refs": _string_list(source.get("outline_refs")),
        "summary_refs": _string_list(source.get("summary_refs")),
        "chapter_refs": _string_list(source.get("chapter_refs")),
        "metadata": sanitize_ai_run(source.get("metadata") if isinstance(source.get("metadata"), dict) else {}),
    }


def _normalize_result(result: Any) -> dict[str, Any]:
    source = dict(result) if isinstance(result, dict) else {}
    output_ref = clean_text(source.get("output_ref")).replace("\\", "/")
    if Path(output_ref).is_absolute() or ".." in Path(output_ref).parts:
        output_ref = Path(output_ref).name
    return {
        "status": clean_text(source.get("status")) or "success",
        "output_ref": output_ref or None,
        "finish_reason": clean_text(source.get("finish_reason")) or None,
        "error": clean_text(source.get("error")) or None,
        "metadata": sanitize_ai_run(source.get("metadata") if isinstance(source.get("metadata"), dict) else {}),
    }


def _error_result(project_ref: str, message: str, code: str, status_code: int = 400) -> AIRunResult:
    return AIRunResult(
        False,
        project_ref=project_ref,
        message=message,
        error_code=code,
        status_code=status_code,
    )


def create_ai_run_record(
    project_ref: str,
    run_type: str,
    model: str | None,
    temperature: Any,
    max_tokens: Any,
    prompt_profile: dict[str, Any],
    context: dict[str, Any] | None = None,
    result: dict[str, Any] | None = None,
    chapter_number: int | None = None,
    event_id: str | None = None,
) -> AIRunResult:
    ctx, message = _workspace_context(project_ref)
    if ctx is None:
        return _error_result(
            project_ref,
            message,
            "ai_run_unsupported_project" if "only supported" in message else "ai_run_unavailable",
            400,
        )

    run_id = _safe_id("run")
    run = {
        "version": AI_RUN_VERSION,
        "id": run_id,
        "run_type": clean_text(run_type),
        "project_ref": project_ref,
        "chapter_number": chapter_number if isinstance(chapter_number, int) and chapter_number > 0 else None,
        "model": clean_text(model) or None,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "prompt_profile": sanitize_ai_run(prompt_profile),
        "context": _normalize_context(context),
        "result": _normalize_result(result),
        "event_id": clean_text(event_id) or None,
        "created_at": timestamp(),
    }

    try:
        write_json_atomic(_run_path(ctx, run_id), sanitize_ai_run(run))
    except (OSError, ValueError) as exc:
        return _error_result(project_ref, f"AI run write failed: {exc}", "ai_run_write_failed", 400)
    return AIRunResult(True, project_ref=project_ref, run_id=run_id, run=run, message="AI run recorded.")


def create_ai_run_record_best_effort(*args: Any, **kwargs: Any) -> AIRunResult:
    try:
        return create_ai_run_record(*args, **kwargs)
    except Exception as exc:
        return AIRunResult(False, message=f"AI run write failed: {exc}", error_code="ai_run_write_failed")


def list_ai_runs(project_ref: str, limit: int = 50) -> AIRunResult:
    ctx, message = _workspace_context(project_ref)
    if ctx is None:
        return _error_result(
            project_ref,
            message,
            "ai_run_unsupported_project" if "only supported" in message else "ai_run_unavailable",
            400,
        )

    runs: list[dict[str, Any]] = []
    root = _ai_runs_dir(ctx)
    if not root.exists():
        return AIRunResult(True, project_ref=project_ref, runs=[])

    try:
        for path in root.glob("*.json"):
            if path.name == "index.json":
                continue
            data = read_json(path)
            if isinstance(data, dict):
                runs.append(sanitize_ai_run(data))
    except (OSError, ValueError) as exc:
        return _error_result(project_ref, f"AI run read failed: {exc}", "ai_run_read_failed", 400)

    runs.sort(key=lambda item: clean_text(item.get("created_at")), reverse=True)
    safe_limit = max(1, min(int(limit or 50), 200))
    return AIRunResult(True, project_ref=project_ref, runs=runs[:safe_limit])


def get_ai_run(project_ref: str, run_id: str) -> AIRunResult:
    ctx, message = _workspace_context(project_ref)
    if ctx is None:
        return _error_result(
            project_ref,
            message,
            "ai_run_unsupported_project" if "only supported" in message else "ai_run_unavailable",
            400,
        )
    clean_id = clean_text(run_id)
    if not clean_id or "/" in clean_id or "\\" in clean_id or ".." in clean_id:
        return _error_result(project_ref, "AI run not found.", "ai_run_not_found", 404)
    try:
        data = read_json(_run_path(ctx, clean_id))
    except (OSError, ValueError) as exc:
        return _error_result(project_ref, f"AI run read failed: {exc}", "ai_run_read_failed", 400)
    if not isinstance(data, dict):
        return _error_result(project_ref, "AI run not found.", "ai_run_not_found", 404)
    return AIRunResult(True, project_ref=project_ref, run_id=clean_id, run=sanitize_ai_run(data))