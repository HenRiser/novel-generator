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

from .chapter_task_service import get_chapter_tasks


DOCUMENT_VERSION = 1
PLANNING_DIR_NAME = "planning"
SCENE_PLANS_NAME = "scene_plans.json"
SCENE_PLAN_STATUSES = {"draft", "approved", "superseded"}
SCENE_PLAN_ID_PATTERN = re.compile(r"^scene_plan_chapter_(\d{3,})_[0-9a-f]{8}$")
SCENE_FUNCTIONS_FORBIDDEN_WITH_NONE = {
    "information_reveal",
    "evidence_discovery",
    "archive_analysis",
    "clue_decoding",
}
NO_NEW_CANON_MARKERS = {
    "不释放新正典信息",
    "不得释放新正典信息",
    "零新正典",
    "no new canon",
    "no new canonical information",
}
SCENE_TEXT_FIELDS = {"title", "location", "scene_function", "emotional_shift", "ending_state"}
SCENE_LIST_FIELDS = {"participants", "allowed_information", "forbidden_information"}
EDITABLE_FIELDS = {
    "source_chapter_task_id",
    "source_chapter_task_revision",
    "scenes",
}


@dataclass(frozen=True)
class ScenePlanResult:
    ok: bool
    project_ref: str = ""
    chapter_number: int = 0
    plan: dict[str, Any] | None = None
    approved: dict[str, Any] | None = None
    latest_draft: dict[str, Any] | None = None
    history: list[dict[str, Any]] = field(default_factory=list)
    current_approved_chapter_task: dict[str, Any] | None = None
    prompt: str = ""
    relative_path: str = ""
    message: str = ""
    status_code: int = 400
    error_code: str = "scene_plan_error"


def _timestamp() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _clean_text(value: Any) -> str:
    return str(value or "").strip()


def _comparison_key(value: Any) -> str:
    return _clean_text(value).casefold()


def _chapter_number(value: Any) -> tuple[int, str]:
    if isinstance(value, bool):
        return 0, "Chapter number must be a positive integer."
    try:
        number = int(value)
    except (TypeError, ValueError):
        return 0, "Chapter number must be a positive integer."
    if number < 1 or str(value).strip() != str(number):
        return 0, "Chapter number must be a positive integer."
    return number, ""


def _workspace_context(
    project_ref: str,
    books_root: Path | None = None,
) -> tuple[Any | None, str, int, str]:
    ref = _clean_text(project_ref)
    if not ref:
        return None, "Unknown project_ref.", 404, "project_not_found"
    try:
        ctx = resolve_project_context(ref, books_root=books_root)
    except FileNotFoundError:
        return None, "Project not found.", 404, "project_not_found"
    except ValueError as exc:
        return None, str(exc) or "Unknown project_ref.", 404, "project_not_found"
    if ctx.storage_kind != WORKSPACE_STORAGE_KIND:
        return (
            None,
            "Scene Plans are only supported for workspace book projects.",
            400,
            "scene_plan_unsupported_project",
        )
    return ctx, "", 200, ""


def _project_id(ctx: Any, project_ref: str) -> str:
    return _clean_text(getattr(ctx, "book_id", "")) or _clean_text(project_ref)


def _scene_plan_path(ctx: Any) -> Path:
    return ctx.project_dir / PLANNING_DIR_NAME / SCENE_PLANS_NAME


def _relative_path() -> str:
    return f"{PLANNING_DIR_NAME}/{SCENE_PLANS_NAME}"


def _empty_document() -> dict[str, Any]:
    return {"version": DOCUMENT_VERSION, "items": []}


def _write_document_atomic(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(f".{path.name}.{secrets.token_hex(4)}.tmp")
    temp_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    temp_path.replace(path)


def _safe_plan_id(chapter_number: int) -> str:
    return f"scene_plan_chapter_{chapter_number:03d}_{secrets.token_hex(4)}"


def _string_list(value: Any, field_name: str, *, required: bool = False) -> tuple[list[str], str]:
    if value is None:
        return [], f"{field_name} must contain at least one item." if required else ""
    if not isinstance(value, list):
        return [], f"{field_name} must be a list of strings."
    result: list[str] = []
    seen: set[str] = set()
    for item in value:
        if not isinstance(item, str):
            return [], f"{field_name} must be a list of strings."
        text = item.strip()
        if text and text not in seen:
            seen.add(text)
            result.append(text)
    if required and not result:
        return [], f"{field_name} must contain at least one item."
    return result, ""


def _no_new_canon_key(value: Any) -> str:
    return re.sub(r"[\s，。；;,.、:：!！?？\-—_]+", "", _clean_text(value).casefold())


def _has_no_new_canon_marker(items: list[str]) -> bool:
    normalized_items = [_no_new_canon_key(item) for item in items]
    normalized_markers = [_no_new_canon_key(marker) for marker in NO_NEW_CANON_MARKERS]
    return any(
        marker and any(marker in item for item in normalized_items)
        for marker in normalized_markers
    )


def _validate_scene(raw_scene: Any, expected_scene_no: int) -> tuple[dict[str, Any] | None, str]:
    if not isinstance(raw_scene, dict):
        return None, "Each scene must be a JSON object."
    unknown = set(raw_scene) - {"scene_no"} - SCENE_TEXT_FIELDS - SCENE_LIST_FIELDS
    if unknown:
        return None, f"Unsupported scene fields: {', '.join(sorted(unknown))}."

    scene_no, message = _chapter_number(raw_scene.get("scene_no"))
    if message:
        return None, "scene_no must be a positive integer."
    if scene_no != expected_scene_no:
        return None, "scene_no must start at 1 and increase continuously."

    scene: dict[str, Any] = {"scene_no": scene_no}
    for field_name in sorted(SCENE_TEXT_FIELDS):
        text = _clean_text(raw_scene.get(field_name))
        if not text:
            return None, f"{field_name} cannot be empty."
        scene[field_name] = text

    for field_name in sorted(SCENE_LIST_FIELDS):
        values, message = _string_list(raw_scene.get(field_name), field_name, required=True)
        if message:
            return None, message
        scene[field_name] = values
    return scene, ""


def _validate_scenes(value: Any) -> tuple[list[dict[str, Any]], str]:
    if not isinstance(value, list):
        return [], "scenes must be a list."
    if len(value) < 2 or len(value) > 4:
        return [], "scenes must contain 2 to 4 scenes."
    scenes: list[dict[str, Any]] = []
    for index, raw_scene in enumerate(value, start=1):
        scene, message = _validate_scene(raw_scene, index)
        if message:
            return [], message
        scenes.append(scene or {})
    return scenes, ""


def _validate_payload(payload: Any) -> tuple[dict[str, Any] | None, str]:
    if not isinstance(payload, dict):
        return None, "Scene Plan payload must be a JSON object."
    unknown = set(payload) - EDITABLE_FIELDS - {"id", "revision", "status", "chapter_number"}
    if unknown:
        return None, f"Unsupported Scene Plan fields: {', '.join(sorted(unknown))}."
    if "status" in payload and payload.get("status") not in {None, "", "draft"}:
        return None, "Draft save cannot create approved or superseded status."

    normalized: dict[str, Any] = {}
    if "chapter_number" in payload:
        number, message = _chapter_number(payload.get("chapter_number"))
        if message:
            return None, message
        normalized["chapter_number"] = number

    source_task_id = _clean_text(payload.get("source_chapter_task_id"))
    normalized["source_chapter_task_id"] = source_task_id or None
    source_revision = payload.get("source_chapter_task_revision")
    if source_revision in {None, ""}:
        normalized["source_chapter_task_revision"] = None
    else:
        revision, message = _chapter_number(source_revision)
        if message:
            return None, "source_chapter_task_revision must be a positive integer."
        normalized["source_chapter_task_revision"] = revision
        if not source_task_id:
            return None, "source_chapter_task_revision requires source_chapter_task_id."

    scenes, message = _validate_scenes(payload.get("scenes"))
    if message:
        return None, message
    normalized["scenes"] = scenes
    return normalized, ""


def _validate_document_item(plan: dict[str, Any], path_name: str) -> None:
    number, message = _chapter_number(plan.get("chapter_number"))
    if message:
        raise ValueError(f"{path_name} contains an invalid Scene Plan chapter_number.")
    revision, message = _chapter_number(plan.get("revision"))
    if message:
        raise ValueError(f"{path_name} contains an invalid Scene Plan revision.")
    if plan.get("status") not in SCENE_PLAN_STATUSES:
        raise ValueError(f"{path_name} contains an invalid Scene Plan status.")
    plan_id = _clean_text(plan.get("id"))
    match = SCENE_PLAN_ID_PATTERN.fullmatch(plan_id)
    if match is None or int(match.group(1)) != number:
        raise ValueError(f"{path_name} contains an invalid Scene Plan id.")
    if not isinstance(plan.get("project_id"), str) or not _clean_text(plan.get("project_id")):
        raise ValueError(f"{path_name} contains an invalid project_id.")
    source_task_id = plan.get("source_chapter_task_id")
    if source_task_id is not None and not isinstance(source_task_id, str):
        raise ValueError(f"{path_name} contains an invalid source_chapter_task_id.")
    if plan.get("source_chapter_task_revision") is not None:
        _, message = _chapter_number(plan.get("source_chapter_task_revision"))
        if message:
            raise ValueError(f"{path_name} contains an invalid source_chapter_task_revision.")
    scenes, message = _validate_scenes(plan.get("scenes"))
    if message:
        raise ValueError(f"{path_name} contains an invalid Scene Plan: {message}")
    plan["scenes"] = scenes
    if not isinstance(plan.get("created_at"), str) or not isinstance(plan.get("updated_at"), str):
        raise ValueError(f"{path_name} contains invalid timestamps.")


def _read_document(path: Path) -> dict[str, Any]:
    if not path.exists():
        return _empty_document()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"{path.name} is not valid JSON.") from exc
    if not isinstance(data, dict) or data.get("version") != DOCUMENT_VERSION:
        raise ValueError(f"{path.name} has an unsupported document version.")
    items = data.get("items")
    if not isinstance(items, list) or any(not isinstance(item, dict) for item in items):
        raise ValueError(f"{path.name} items must be a list of objects.")

    approved_chapters: set[int] = set()
    normalized_items: list[dict[str, Any]] = []
    for item in items:
        plan = dict(item)
        _validate_document_item(plan, path.name)
        number = int(plan.get("chapter_number") or 0)
        if plan.get("status") == "approved":
            if number in approved_chapters:
                raise ValueError(f"{path.name} contains more than one approved Scene Plan for chapter {number}.")
            approved_chapters.add(number)
        normalized_items.append(plan)
    return {"version": DOCUMENT_VERSION, "items": normalized_items}


def _read_project_document(ctx: Any, project_ref: str) -> dict[str, Any]:
    document = _read_document(_scene_plan_path(ctx))
    expected_project_id = _project_id(ctx, project_ref)
    for plan in document["items"]:
        if plan.get("project_id") != expected_project_id:
            raise ValueError(f"{SCENE_PLANS_NAME} contains a Scene Plan for a different project.")
    return document


def _plan_history(items: list[dict[str, Any]], chapter_number: int) -> list[dict[str, Any]]:
    history = [dict(item) for item in items if item.get("chapter_number") == chapter_number]
    history.sort(key=lambda item: int(item.get("revision") or 0), reverse=True)
    return history


def _selection(history: list[dict[str, Any]]) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    approved = next((dict(plan) for plan in history if plan.get("status") == "approved"), None)
    latest_draft = next((dict(plan) for plan in history if plan.get("status") == "draft"), None)
    return approved, latest_draft


def _error(
    project_ref: str,
    chapter_number: int,
    message: str,
    code: str,
    status_code: int = 400,
) -> ScenePlanResult:
    return ScenePlanResult(
        False,
        project_ref=project_ref,
        chapter_number=chapter_number,
        message=message,
        error_code=code,
        status_code=status_code,
    )


def _current_chapter_task(
    project_ref: str,
    chapter_number: int,
    books_root: Path | None = None,
) -> tuple[Any | None, str]:
    task_result = get_chapter_tasks(project_ref, chapter_number, books_root=books_root)
    if not task_result.ok:
        return None, task_result.message
    return task_result, ""


def _matched_source_task(plan: dict[str, Any], task_result: Any | None) -> tuple[dict[str, Any] | None, str]:
    source_task_id = _clean_text(plan.get("source_chapter_task_id"))
    source_revision = plan.get("source_chapter_task_revision")
    if not source_task_id:
        return None, ""
    if task_result is None:
        return None, "source_chapter_task_id cannot be validated because Chapter Task Sheets could not be loaded."

    matching = [task for task in task_result.history if task.get("id") == source_task_id]
    if not matching:
        return None, "source_chapter_task_id does not belong to this project or chapter."
    if source_revision not in {None, ""}:
        matching = [task for task in matching if task.get("revision") == source_revision]
        if not matching:
            return None, "source_chapter_task_revision does not match source_chapter_task_id."

    approved = next((task for task in matching if task.get("status") == "approved"), None)
    if approved is not None:
        return dict(approved), ""
    status = _clean_text(matching[0].get("status"))
    if status == "draft":
        return None, "Scene Plan cannot bind a draft Chapter Task Sheet."
    if status == "superseded":
        return None, "Scene Plan cannot bind a superseded Chapter Task Sheet."
    return None, "Scene Plan source Chapter Task Sheet must be approved."


def _advance_conflicts(left: list[str], right: list[str]) -> list[str]:
    right_keys = {_comparison_key(item) for item in right if _comparison_key(item)}
    conflicts: list[str] = []
    seen: set[str] = set()
    for item in left:
        key = _comparison_key(item)
        if key and key in right_keys and key not in seen:
            conflicts.append(_clean_text(item))
            seen.add(key)
    return conflicts


def _validate_plan_against_task(plan: dict[str, Any], task_result: Any | None) -> tuple[dict[str, Any] | None, str]:
    source_task, message = _matched_source_task(plan, task_result)
    if message:
        return None, message
    active_task = source_task or (dict(task_result.approved) if task_result and task_result.approved else None)
    if active_task is None:
        return None, ""

    canon_budget = _clean_text(active_task.get("canon_budget"))
    if canon_budget == "none":
        for scene in plan.get("scenes", []):
            scene_function = _clean_text(scene.get("scene_function"))
            if scene_function in SCENE_FUNCTIONS_FORBIDDEN_WITH_NONE:
                return (
                    active_task,
                    f"scene_function '{scene_function}' is incompatible with canon_budget 'none'. "
                    "Change the Scene Plan function or raise the Chapter Task canon budget.",
                )
            if not _has_no_new_canon_marker(list(scene.get("forbidden_information") or [])):
                return (
                    active_task,
                    "canon_budget 'none' requires every scene forbidden_information to include "
                    "'不释放新正典信息' or an equivalent no-new-canon marker.",
                )

    task_forbidden = list(active_task.get("forbidden_advances") or [])
    task_allowed = list(active_task.get("allowed_advances") or [])
    scene_allowed: list[str] = []
    scene_forbidden: list[str] = []
    for scene in plan.get("scenes", []):
        scene_allowed.extend(list(scene.get("allowed_information") or []))
        scene_forbidden.extend(list(scene.get("forbidden_information") or []))
    conflicts = _advance_conflicts(scene_allowed, task_forbidden)
    if conflicts:
        return (
            active_task,
            "Scene Plan allowed_information conflicts with Chapter Task forbidden_advances: "
            f"{', '.join(conflicts)}.",
        )
    conflicts = _advance_conflicts(scene_forbidden, task_allowed)
    if conflicts:
        return (
            active_task,
            "Scene Plan forbidden_information conflicts with Chapter Task allowed_advances: "
            f"{', '.join(conflicts)}.",
        )
    return active_task, ""


def _result_from_document(
    project_ref: str,
    chapter_number: int,
    document: dict[str, Any],
    current_approved_chapter_task: dict[str, Any] | None = None,
    message: str = "",
) -> ScenePlanResult:
    history = _plan_history(document["items"], chapter_number)
    approved, latest_draft = _selection(history)
    return ScenePlanResult(
        True,
        project_ref=project_ref,
        chapter_number=chapter_number,
        approved=approved,
        latest_draft=latest_draft,
        history=history,
        current_approved_chapter_task=dict(current_approved_chapter_task) if current_approved_chapter_task else None,
        relative_path=_relative_path(),
        message=message,
        status_code=200,
        error_code="",
    )


def get_scene_plans(
    project_ref: str,
    chapter_number: Any,
    books_root: Path | None = None,
) -> ScenePlanResult:
    number, message = _chapter_number(chapter_number)
    if message:
        return _error(project_ref, 0, message, "scene_plan_invalid")
    ctx, message, status_code, error_code = _workspace_context(project_ref, books_root=books_root)
    if ctx is None:
        return _error(project_ref, number, message, error_code, status_code)
    try:
        document = _read_project_document(ctx, project_ref)
    except (OSError, ValueError) as exc:
        return _error(project_ref, number, str(exc), "scene_plan_read_failed")
    task_result, message = _current_chapter_task(project_ref, number, books_root=books_root)
    if message:
        return _error(project_ref, number, message, "scene_plan_task_read_failed")
    return _result_from_document(
        project_ref,
        number,
        document,
        current_approved_chapter_task=task_result.approved if task_result else None,
        message="Scene Plan loaded.",
    )


def save_scene_plan_draft(
    project_ref: str,
    chapter_number: Any,
    payload: Any,
    books_root: Path | None = None,
) -> ScenePlanResult:
    number, message = _chapter_number(chapter_number)
    if message:
        return _error(project_ref, 0, message, "scene_plan_invalid")
    normalized, message = _validate_payload(payload)
    if normalized is None:
        return _error(project_ref, number, message, "scene_plan_invalid")
    if normalized.get("chapter_number") not in {None, number}:
        return _error(project_ref, number, "Scene Plan chapter_number does not match the route.", "scene_plan_chapter_mismatch")

    ctx, message, status_code, error_code = _workspace_context(project_ref, books_root=books_root)
    if ctx is None:
        return _error(project_ref, number, message, error_code, status_code)
    path = _scene_plan_path(ctx)
    try:
        document = _read_project_document(ctx, project_ref)
    except (OSError, ValueError) as exc:
        return _error(project_ref, number, str(exc), "scene_plan_read_failed")
    task_result, message = _current_chapter_task(project_ref, number, books_root=books_root)
    if message:
        return _error(project_ref, number, message, "scene_plan_task_read_failed")

    items = document["items"]
    history = _plan_history(items, number)
    approved, latest_draft = _selection(history)
    requested_id = _clean_text(payload.get("id")) if isinstance(payload, dict) else ""
    requested_revision = payload.get("revision") if isinstance(payload, dict) else None
    if requested_id and not history:
        return _error(
            project_ref,
            number,
            "Scene Plan id does not belong to this project or chapter.",
            "scene_plan_not_found",
            404,
        )
    if requested_id and history and not any(plan.get("id") == requested_id for plan in history):
        return _error(project_ref, number, "Scene Plan id does not belong to this chapter.", "scene_plan_chapter_mismatch")

    now = _timestamp()
    if latest_draft is not None:
        if requested_id and requested_id != latest_draft.get("id"):
            return _error(project_ref, number, "Scene Plan id does not match the current draft.", "scene_plan_conflict", 409)
        if requested_revision not in {None, "", latest_draft.get("revision")}:
            return _error(project_ref, number, "Scene Plan revision does not match the current draft.", "scene_plan_conflict", 409)
        saved_plan = {
            **latest_draft,
            **normalized,
            "project_id": _project_id(ctx, project_ref),
            "chapter_number": number,
            "status": "draft",
            "updated_at": now,
            "approved_at": None,
            "superseded_at": None,
        }
        _, message = _validate_plan_against_task(saved_plan, task_result)
        if message:
            return _error(project_ref, number, message, "scene_plan_invalid")
        for index, plan in enumerate(items):
            if plan.get("id") == latest_draft.get("id") and plan.get("revision") == latest_draft.get("revision"):
                items[index] = saved_plan
                break
    else:
        if approved is not None:
            plan_id = _safe_plan_id(number)
            revision = int(approved.get("revision") or 0) + 1
            base = {field_name: approved.get(field_name) for field_name in EDITABLE_FIELDS}
        else:
            plan_id = _safe_plan_id(number)
            revision = 1
            base = {}
        if requested_revision not in {None, "", revision}:
            return _error(project_ref, number, "Scene Plan revision does not match the next draft revision.", "scene_plan_conflict", 409)
        saved_plan = {
            "id": plan_id,
            "project_id": _project_id(ctx, project_ref),
            "chapter_number": number,
            "revision": revision,
            "status": "draft",
            **base,
            **normalized,
            "created_at": now,
            "updated_at": now,
            "approved_at": None,
            "superseded_at": None,
        }
        _, message = _validate_plan_against_task(saved_plan, task_result)
        if message:
            return _error(project_ref, number, message, "scene_plan_invalid")
        items.append(saved_plan)

    try:
        _write_document_atomic(path, document)
    except OSError as exc:
        return _error(project_ref, number, f"Scene Plan write failed: {exc}", "scene_plan_write_failed")
    result = _result_from_document(
        project_ref,
        number,
        document,
        current_approved_chapter_task=task_result.approved if task_result else None,
        message="Scene Plan draft saved.",
    )
    return ScenePlanResult(**{**result.__dict__, "plan": dict(saved_plan)})


def approve_scene_plan(
    project_ref: str,
    chapter_number: Any,
    scene_plan_id: Any = None,
    revision: Any = None,
    books_root: Path | None = None,
) -> ScenePlanResult:
    number, message = _chapter_number(chapter_number)
    if message:
        return _error(project_ref, 0, message, "scene_plan_invalid")
    clean_id = _clean_text(scene_plan_id)
    if not clean_id and revision in {None, ""}:
        return _error(project_ref, number, "Approval requires scene_plan_id or revision.", "scene_plan_invalid")
    clean_revision: int | None = None
    if revision not in {None, ""}:
        clean_revision, message = _chapter_number(revision)
        if message:
            return _error(project_ref, number, "revision must be a positive integer.", "scene_plan_invalid")

    ctx, message, status_code, error_code = _workspace_context(project_ref, books_root=books_root)
    if ctx is None:
        return _error(project_ref, number, message, error_code, status_code)
    path = _scene_plan_path(ctx)
    try:
        document = _read_project_document(ctx, project_ref)
    except (OSError, ValueError) as exc:
        return _error(project_ref, number, str(exc), "scene_plan_read_failed")
    task_result, message = _current_chapter_task(project_ref, number, books_root=books_root)
    if message:
        return _error(project_ref, number, message, "scene_plan_task_read_failed")

    history = _plan_history(document["items"], number)
    target = next(
        (
            plan
            for plan in history
            if plan.get("status") == "draft"
            and (not clean_id or plan.get("id") == clean_id)
            and (clean_revision is None or plan.get("revision") == clean_revision)
        ),
        None,
    )
    if target is None:
        return _error(project_ref, number, "Requested draft Scene Plan was not found.", "scene_plan_not_found", 404)
    _, message = _validate_plan_against_task(target, task_result)
    if message:
        return _error(project_ref, number, message, "scene_plan_invalid")

    now = _timestamp()
    approved_plan: dict[str, Any] | None = None
    for index, plan in enumerate(document["items"]):
        if plan.get("chapter_number") != number:
            continue
        if plan.get("status") == "approved":
            document["items"][index] = {
                **plan,
                "status": "superseded",
                "updated_at": now,
                "superseded_at": now,
            }
        if plan.get("id") == target.get("id") and plan.get("revision") == target.get("revision"):
            approved_plan = {
                **plan,
                "status": "approved",
                "updated_at": now,
                "approved_at": now,
                "superseded_at": None,
            }
            document["items"][index] = approved_plan

    try:
        _write_document_atomic(path, document)
    except OSError as exc:
        return _error(project_ref, number, f"Scene Plan write failed: {exc}", "scene_plan_write_failed")
    result = _result_from_document(
        project_ref,
        number,
        document,
        current_approved_chapter_task=task_result.approved if task_result else None,
        message="Scene Plan approved.",
    )
    return ScenePlanResult(**{**result.__dict__, "plan": dict(approved_plan or {})})


def resolve_approved_scene_plan(
    project_ref: str,
    chapter_number: Any,
    scene_plan_id: Any = None,
    chapter_task: dict[str, Any] | None = None,
    require_task_binding: bool = False,
    books_root: Path | None = None,
) -> ScenePlanResult:
    clean_id = _clean_text(scene_plan_id)
    if not clean_id:
        return ScenePlanResult(
            True,
            project_ref=project_ref,
            chapter_number=int(chapter_number or 0),
            relative_path=_relative_path(),
            message="No approved Scene Plan requested.",
            status_code=200,
            error_code="",
        )
    result = get_scene_plans(project_ref, chapter_number, books_root=books_root)
    if not result.ok:
        return result

    matching = [plan for plan in result.history if plan.get("id") == clean_id]
    if not matching:
        return _error(
            project_ref,
            result.chapter_number,
            "scene_plan_id does not belong to this project or chapter.",
            "scene_plan_not_found",
            404,
        )
    approved = next((plan for plan in matching if plan.get("status") == "approved"), None)
    if approved is None:
        return _error(
            project_ref,
            result.chapter_number,
            "scene_plan_id is not an approved revision.",
            "scene_plan_not_approved",
            400,
        )

    if chapter_task is not None:
        source_task_id = _clean_text(approved.get("source_chapter_task_id"))
        source_revision = approved.get("source_chapter_task_revision")
        if not source_task_id:
            if require_task_binding:
                return _error(
                    project_ref,
                    result.chapter_number,
                    "scene_plan_id is not bound to the requested Chapter Task Sheet.",
                    "scene_plan_task_mismatch",
                    400,
                )
        elif (
            source_task_id != _clean_text(chapter_task.get("id"))
            or source_revision != chapter_task.get("revision")
        ):
            return _error(
                project_ref,
                result.chapter_number,
                "Scene Plan source Chapter Task Sheet does not match the generation Chapter Task Sheet.",
                "scene_plan_task_mismatch",
                400,
            )

    prompt = format_approved_scene_plan_for_prompt(approved)
    return ScenePlanResult(
        True,
        project_ref=project_ref,
        chapter_number=result.chapter_number,
        plan=dict(approved),
        approved=dict(approved),
        history=result.history,
        current_approved_chapter_task=result.current_approved_chapter_task,
        prompt=prompt,
        relative_path=result.relative_path,
        message="Approved Scene Plan loaded.",
        status_code=200,
        error_code="",
    )


def format_approved_scene_plan_for_prompt(plan: dict[str, Any]) -> str:
    if not isinstance(plan, dict) or plan.get("status") != "approved":
        raise ValueError("Prompt formatting requires an approved Scene Plan.")

    lines = [
        "### Approved Scene Plan",
        "",
        "You must write the chapter according to the approved Scene Plan.",
        "Do not add extra scenes beyond the approved Scene Plan.",
        "Do not use forbidden information in any scene.",
        (
            "If a scene cannot progress without revealing forbidden information, write emotional aftermath, "
            "relationship dialogue, or a low-intensity decision instead."
        ),
        "",
        "必须按 approved Scene Plan 写作；不得增加计划外场景；不得使用每个场景的 forbidden information；"
        "如果无法在不泄露禁止信息的情况下推进，就改写情绪余波、人物关系对话或低强度选择。",
        "",
        f"- id: {plan.get('id')}",
        f"- chapter_number: {plan.get('chapter_number')}",
        f"- revision: {plan.get('revision')}",
        f"- status: {plan.get('status')}",
        f"- source_chapter_task_id: {plan.get('source_chapter_task_id') or 'none'}",
        f"- source_chapter_task_revision: {plan.get('source_chapter_task_revision') or 'none'}",
        "",
    ]
    for scene in plan.get("scenes", []):
        lines.extend(
            [
                f"#### Scene {scene.get('scene_no')}: {_clean_text(scene.get('title'))}",
                f"- location: {_clean_text(scene.get('location'))}",
                f"- participants: {'; '.join(scene.get('participants') or [])}",
                f"- scene_function: {_clean_text(scene.get('scene_function'))}",
                f"- allowed_information: {'; '.join(scene.get('allowed_information') or [])}",
                f"- forbidden_information: {'; '.join(scene.get('forbidden_information') or [])}",
                f"- emotional_shift: {_clean_text(scene.get('emotional_shift'))}",
                f"- ending_state: {_clean_text(scene.get('ending_state'))}",
                "",
            ]
        )
    return "\n".join(lines).strip()
