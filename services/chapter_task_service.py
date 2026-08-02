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
from .common import resolve_workspace_context, clean_text, timestamp, write_json_atomic


DOCUMENT_VERSION = 1
PLANNING_DIR_NAME = "planning"
TASK_SHEETS_NAME = "chapter_task_sheets.json"
TASK_STATUSES = {"draft", "approved", "superseded"}
TASK_ID_PATTERN = re.compile(r"^task_chapter_(\d{3,})_[0-9a-f]{8}$")
CHAPTER_FUNCTIONS = {
    "relationship_progress",
    "emotional_aftermath",
    "action_progress",
    "information_reveal",
    "foreshadowing_setup",
    "foreshadowing_payoff",
    "reward_delivery",
    "suspense_maintenance",
    "transition",
}
INTENSITIES = {"low", "medium", "high"}
CANON_BUDGETS = {"none", "minor", "normal"}
NONE_BUDGET_INCOMPATIBLE_FUNCTIONS = {"information_reveal", "foreshadowing_setup"}
LIST_FIELDS = {
    "secondary_functions",
    "must_carry",
    "allowed_advances",
    "forbidden_advances",
    "required_characters",
    "allowed_scene_types",
    "forbidden_scene_drivers",
}
TEXT_FIELDS = {
    "relationship_goal",
    "decision_goal",
    "ending_state",
    "notes",
}
EDITABLE_FIELDS = {
    "primary_function",
    "secondary_functions",
    "intensity",
    "canon_budget",
    "must_carry",
    "allowed_advances",
    "forbidden_advances",
    "required_characters",
    "relationship_goal",
    "decision_goal",
    "allowed_scene_types",
    "forbidden_scene_drivers",
    "ending_state",
    "notes",
}
LOW_NONE_ALLOWED_SCENE_DRIVERS = [
    "人物低强度对话",
    "情绪消化",
    "信任协商",
    "日常动作",
    "短距离移动",
    "对已知事实的主观反应",
    "已知事实产生的现实后果",
    "一个不释放新正典的小决定",
]
LOW_NONE_FORBIDDEN_SCENE_DRIVERS = [
    "阅读或解码材料",
    "打开档案",
    "发现新纸条、照片、编号、证物或隐藏夹层",
    "从既有材料中释放新的正典信息",
    "引入新的组织秘密",
    "推进终局真相",
    "用新谜团代替人物与情绪推进",
]
FUNCTION_SCENE_DRIVERS = {
    "relationship_progress": "通过对话、行动和选择推进人物关系",
    "emotional_aftermath": "让人物消化既有事件造成的情绪后果",
    "action_progress": "通过明确行动推进当前目标",
    "information_reveal": "在正典预算内释放任务单明确允许的信息",
    "foreshadowing_setup": "设置不超出任务单范围的伏笔",
    "foreshadowing_payoff": "回收任务单明确指定的既有伏笔",
    "reward_delivery": "兑现已铺垫的情节或情绪回报",
    "suspense_maintenance": "用既有不确定性维持悬念",
    "transition": "完成地点、关系、目标或阶段之间的过渡",
}


@dataclass(frozen=True)
class ChapterTaskResult:
    ok: bool
    project_ref: str = ""
    chapter_number: int = 0
    task: dict[str, Any] | None = None
    approved: dict[str, Any] | None = None
    latest_draft: dict[str, Any] | None = None
    history: list[dict[str, Any]] = field(default_factory=list)
    contract: str = ""
    relative_path: str = ""
    message: str = ""
    status_code: int = 400
    error_code: str = "chapter_task_error"






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
    return resolve_workspace_context(
        project_ref,
        books_root=books_root,
        resolve=resolve_project_context,
        storage_message='Chapter Task Sheets are only supported for workspace book projects.',
        storage_error_code='chapter_task_unsupported_project',
    )


def _task_path(ctx: Any) -> Path:
    return ctx.project_dir / PLANNING_DIR_NAME / TASK_SHEETS_NAME


def _relative_path() -> str:
    return f"{PLANNING_DIR_NAME}/{TASK_SHEETS_NAME}"


def _empty_document() -> dict[str, Any]:
    return {"version": DOCUMENT_VERSION, "tasks": []}


def _read_document(path: Path) -> dict[str, Any]:
    if not path.exists():
        return _empty_document()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"{path.name} is not valid JSON.") from exc
    if not isinstance(data, dict) or data.get("version") != DOCUMENT_VERSION:
        raise ValueError(f"{path.name} has an unsupported document version.")
    tasks = data.get("tasks")
    if not isinstance(tasks, list) or any(not isinstance(task, dict) for task in tasks):
        raise ValueError(f"{path.name} tasks must be a list of objects.")
    approved_chapters: set[int] = set()
    for task in tasks:
        number, message = _chapter_number(task.get("chapter_number"))
        if message:
            raise ValueError(f"{path.name} contains an invalid task chapter_number.")
        revision, message = _chapter_number(task.get("revision"))
        if message:
            raise ValueError(f"{path.name} contains an invalid task revision.")
        status = task.get("status")
        if status not in TASK_STATUSES:
            raise ValueError(f"{path.name} contains an invalid task status.")
        task_id = clean_text(task.get("id"))
        match = TASK_ID_PATTERN.fullmatch(task_id)
        if match is None or int(match.group(1)) != number:
            raise ValueError(f"{path.name} contains an invalid task id.")
        if task.get("primary_function") not in CHAPTER_FUNCTIONS:
            raise ValueError(f"{path.name} contains an invalid primary_function.")
        secondary_functions = task.get("secondary_functions")
        if not isinstance(secondary_functions, list) or any(
            item not in CHAPTER_FUNCTIONS for item in secondary_functions
        ):
            raise ValueError(f"{path.name} contains invalid secondary_functions.")
        if task.get("intensity") not in INTENSITIES:
            raise ValueError(f"{path.name} contains an invalid intensity.")
        if task.get("canon_budget") not in CANON_BUDGETS:
            raise ValueError(f"{path.name} contains an invalid canon_budget.")
        for field_name in LIST_FIELDS - {"secondary_functions"}:
            value = task.get(field_name)
            if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
                raise ValueError(f"{path.name} contains an invalid {field_name}.")
        for field_name in TEXT_FIELDS:
            if not isinstance(task.get(field_name), str):
                raise ValueError(f"{path.name} contains an invalid {field_name}.")
        consistency_message = _cross_field_consistency_error(task)
        if consistency_message:
            raise ValueError(f"{path.name} contains an invalid task contract: {consistency_message}")
        if status == "approved":
            if number in approved_chapters:
                raise ValueError(f"{path.name} contains more than one approved revision for chapter {number}.")
            approved_chapters.add(number)
        if revision < 1:
            raise ValueError(f"{path.name} contains an invalid task revision.")
    return {"version": DOCUMENT_VERSION, "tasks": [dict(task) for task in tasks]}




def _safe_task_id(chapter_number: int) -> str:
    return f"task_chapter_{chapter_number:03d}_{secrets.token_hex(4)}"


def _string_list(value: Any, field_name: str) -> tuple[list[str], str]:
    if value is None:
        return [], ""
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
    return result, ""


def _comparison_key(value: Any) -> str:
    return clean_text(value).casefold()


def _advance_conflicts(
    allowed_advances: list[str],
    forbidden_advances: list[str],
) -> list[str]:
    forbidden_keys = {_comparison_key(item) for item in forbidden_advances if _comparison_key(item)}
    conflicts: list[str] = []
    seen: set[str] = set()
    for item in allowed_advances:
        key = _comparison_key(item)
        if key and key in forbidden_keys and key not in seen:
            seen.add(key)
            conflicts.append(clean_text(item))
    return conflicts


def _cross_field_consistency_error(task: dict[str, Any]) -> str:
    primary_function = clean_text(task.get("primary_function"))
    secondary_functions = list(task.get("secondary_functions") or [])
    canon_budget = clean_text(task.get("canon_budget"))

    if primary_function in secondary_functions:
        return (
            f"secondary_functions cannot contain primary_function '{primary_function}'. "
            "Choose distinct primary and secondary chapter functions."
        )

    if canon_budget == "none":
        if primary_function in NONE_BUDGET_INCOMPATIBLE_FUNCTIONS:
            return (
                f"primary_function '{primary_function}' is incompatible with canon_budget 'none'. "
                "Change the chapter function or raise canon_budget."
            )
        incompatible_secondary = [
            item for item in secondary_functions if item in NONE_BUDGET_INCOMPATIBLE_FUNCTIONS
        ]
        if incompatible_secondary:
            return (
                "secondary_functions contains "
                f"'{incompatible_secondary[0]}', which is incompatible with canon_budget 'none'. "
                "Change the chapter function or raise canon_budget."
            )

    conflicts = _advance_conflicts(
        list(task.get("allowed_advances") or []),
        list(task.get("forbidden_advances") or []),
    )
    if conflicts:
        return (
            "allowed_advances and forbidden_advances contain the same normalized item(s): "
            f"{', '.join(conflicts)}. Remove the conflict from one list."
        )
    return ""


def _validate_payload(payload: Any) -> tuple[dict[str, Any] | None, str]:
    if not isinstance(payload, dict):
        return None, "Chapter task payload must be a JSON object."
    unknown = set(payload) - EDITABLE_FIELDS - {"id", "revision", "status", "chapter_number"}
    if unknown:
        return None, f"Unsupported chapter task fields: {', '.join(sorted(unknown))}."
    if "status" in payload and payload.get("status") not in {None, "", "draft"}:
        return None, "Draft save cannot create approved or superseded status."
    if "chapter_number" in payload:
        number, message = _chapter_number(payload.get("chapter_number"))
        if message:
            return None, message
        normalized_chapter_number = number
    else:
        normalized_chapter_number = None

    primary_function = clean_text(payload.get("primary_function"))
    if primary_function not in CHAPTER_FUNCTIONS:
        return None, "primary_function is invalid."

    secondary_functions, message = _string_list(payload.get("secondary_functions"), "secondary_functions")
    if message:
        return None, message
    if any(item not in CHAPTER_FUNCTIONS for item in secondary_functions):
        return None, "secondary_functions contains an invalid value."

    intensity = clean_text(payload.get("intensity"))
    if intensity not in INTENSITIES:
        return None, "intensity is invalid."

    canon_budget = clean_text(payload.get("canon_budget"))
    if canon_budget not in CANON_BUDGETS:
        return None, "canon_budget is invalid."

    normalized: dict[str, Any] = {
        "primary_function": primary_function,
        "secondary_functions": secondary_functions,
        "intensity": intensity,
        "canon_budget": canon_budget,
    }
    if normalized_chapter_number is not None:
        normalized["chapter_number"] = normalized_chapter_number
    for field_name in LIST_FIELDS - {"secondary_functions"}:
        normalized[field_name], message = _string_list(payload.get(field_name), field_name)
        if message:
            return None, message
    for field_name in TEXT_FIELDS:
        value = payload.get(field_name)
        if value is not None and not isinstance(value, str):
            return None, f"{field_name} must be a string."
        normalized[field_name] = clean_text(value)
    message = _cross_field_consistency_error(normalized)
    if message:
        return None, message
    return normalized, ""


def _task_history(tasks: list[dict[str, Any]], chapter_number: int) -> list[dict[str, Any]]:
    history = [dict(task) for task in tasks if task.get("chapter_number") == chapter_number]
    history.sort(key=lambda task: int(task.get("revision") or 0), reverse=True)
    return history


def _selection(history: list[dict[str, Any]]) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    approved = next((dict(task) for task in history if task.get("status") == "approved"), None)
    latest_draft = next((dict(task) for task in history if task.get("status") == "draft"), None)
    return approved, latest_draft


def _result_from_document(
    project_ref: str,
    chapter_number: int,
    document: dict[str, Any],
    message: str = "",
) -> ChapterTaskResult:
    history = _task_history(document["tasks"], chapter_number)
    approved, latest_draft = _selection(history)
    return ChapterTaskResult(
        True,
        project_ref=project_ref,
        chapter_number=chapter_number,
        approved=approved,
        latest_draft=latest_draft,
        history=history,
        relative_path=_relative_path(),
        message=message,
        status_code=200,
        error_code="",
    )


def _error(
    project_ref: str,
    chapter_number: int,
    message: str,
    code: str,
    status_code: int = 400,
) -> ChapterTaskResult:
    return ChapterTaskResult(
        False,
        project_ref=project_ref,
        chapter_number=chapter_number,
        message=message,
        error_code=code,
        status_code=status_code,
    )


def get_chapter_tasks(
    project_ref: str,
    chapter_number: Any,
    books_root: Path | None = None,
) -> ChapterTaskResult:
    number, message = _chapter_number(chapter_number)
    if message:
        return _error(project_ref, 0, message, "chapter_task_invalid")
    ctx, message, status_code, error_code = _workspace_context(project_ref, books_root=books_root)
    if ctx is None:
        return _error(project_ref, number, message, error_code, status_code)
    try:
        document = _read_document(_task_path(ctx))
    except (OSError, ValueError) as exc:
        return _error(project_ref, number, str(exc), "chapter_task_read_failed")
    return _result_from_document(project_ref, number, document, "Chapter Task Sheet loaded.")


def save_chapter_task_draft(
    project_ref: str,
    chapter_number: Any,
    payload: Any,
    books_root: Path | None = None,
) -> ChapterTaskResult:
    number, message = _chapter_number(chapter_number)
    if message:
        return _error(project_ref, 0, message, "chapter_task_invalid")
    normalized, message = _validate_payload(payload)
    if normalized is None:
        return _error(project_ref, number, message, "chapter_task_invalid")
    if normalized.get("chapter_number") not in {None, number}:
        return _error(project_ref, number, "Task chapter_number does not match the route.", "chapter_task_chapter_mismatch")

    ctx, message, status_code, error_code = _workspace_context(project_ref, books_root=books_root)
    if ctx is None:
        return _error(project_ref, number, message, error_code, status_code)
    path = _task_path(ctx)
    try:
        document = _read_document(path)
    except (OSError, ValueError) as exc:
        return _error(project_ref, number, str(exc), "chapter_task_read_failed")

    tasks = document["tasks"]
    history = _task_history(tasks, number)
    approved, latest_draft = _selection(history)
    requested_id = clean_text(payload.get("id")) if isinstance(payload, dict) else ""
    requested_revision = payload.get("revision") if isinstance(payload, dict) else None
    if requested_id and not history:
        return _error(
            project_ref,
            number,
            "Task id does not belong to this project or chapter.",
            "chapter_task_not_found",
            404,
        )
    if requested_id and history and not any(task.get("id") == requested_id for task in history):
        return _error(project_ref, number, "Task id does not belong to this chapter.", "chapter_task_chapter_mismatch")

    now = timestamp()
    if latest_draft is not None:
        if requested_id and requested_id != latest_draft.get("id"):
            return _error(project_ref, number, "Task id does not match the current draft.", "chapter_task_conflict", 409)
        if requested_revision not in {None, "", latest_draft.get("revision")}:
            return _error(project_ref, number, "Task revision does not match the current draft.", "chapter_task_conflict", 409)
        updated = {
            **latest_draft,
            **normalized,
            "chapter_number": number,
            "status": "draft",
            "updated_at": now,
            "approved_at": None,
            "superseded_at": None,
        }
        for index, task in enumerate(tasks):
            if task.get("id") == latest_draft.get("id") and task.get("revision") == latest_draft.get("revision"):
                tasks[index] = updated
                break
        saved_task = updated
    else:
        if approved is not None:
            task_id = clean_text(approved.get("id"))
            revision = int(approved.get("revision") or 0) + 1
            base = {field_name: approved.get(field_name) for field_name in EDITABLE_FIELDS}
        else:
            task_id = _safe_task_id(number)
            revision = 1
            base = {}
        if requested_revision not in {None, "", revision}:
            return _error(project_ref, number, "Task revision does not match the next draft revision.", "chapter_task_conflict", 409)
        saved_task = {
            "id": task_id,
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
        tasks.append(saved_task)

    try:
        write_json_atomic(path, document)
    except OSError as exc:
        return _error(project_ref, number, f"Chapter task write failed: {exc}", "chapter_task_write_failed")
    result = _result_from_document(project_ref, number, document, "Chapter Task Sheet draft saved.")
    return ChapterTaskResult(**{**result.__dict__, "task": dict(saved_task)})


def approve_chapter_task(
    project_ref: str,
    chapter_number: Any,
    task_id: Any = None,
    revision: Any = None,
    books_root: Path | None = None,
) -> ChapterTaskResult:
    number, message = _chapter_number(chapter_number)
    if message:
        return _error(project_ref, 0, message, "chapter_task_invalid")
    clean_id = clean_text(task_id)
    if not clean_id and revision in {None, ""}:
        return _error(project_ref, number, "Approval requires task_id or revision.", "chapter_task_invalid")
    clean_revision: int | None = None
    if revision not in {None, ""}:
        clean_revision, message = _chapter_number(revision)
        if message:
            return _error(project_ref, number, "revision must be a positive integer.", "chapter_task_invalid")

    ctx, message, status_code, error_code = _workspace_context(project_ref, books_root=books_root)
    if ctx is None:
        return _error(project_ref, number, message, error_code, status_code)
    path = _task_path(ctx)
    try:
        document = _read_document(path)
    except (OSError, ValueError) as exc:
        return _error(project_ref, number, str(exc), "chapter_task_read_failed")

    history = _task_history(document["tasks"], number)
    target = next(
        (
            task
            for task in history
            if task.get("status") == "draft"
            and (not clean_id or task.get("id") == clean_id)
            and (clean_revision is None or task.get("revision") == clean_revision)
        ),
        None,
    )
    if target is None:
        return _error(project_ref, number, "Requested draft revision was not found.", "chapter_task_not_found", 404)

    now = timestamp()
    approved_task: dict[str, Any] | None = None
    for index, task in enumerate(document["tasks"]):
        if task.get("chapter_number") != number:
            continue
        if task.get("status") == "approved":
            document["tasks"][index] = {
                **task,
                "status": "superseded",
                "updated_at": now,
                "superseded_at": now,
            }
        if task.get("id") == target.get("id") and task.get("revision") == target.get("revision"):
            approved_task = {
                **task,
                "status": "approved",
                "updated_at": now,
                "approved_at": now,
                "superseded_at": None,
            }
            document["tasks"][index] = approved_task

    try:
        write_json_atomic(path, document)
    except OSError as exc:
        return _error(project_ref, number, f"Chapter task write failed: {exc}", "chapter_task_write_failed")
    result = _result_from_document(project_ref, number, document, "Chapter Task Sheet approved.")
    return ChapterTaskResult(**{**result.__dict__, "task": dict(approved_task or {})})


def resolve_approved_chapter_task(
    project_ref: str,
    chapter_number: Any,
    task_id: Any = None,
    books_root: Path | None = None,
) -> ChapterTaskResult:
    result = get_chapter_tasks(project_ref, chapter_number, books_root=books_root)
    if not result.ok:
        return result
    clean_id = clean_text(task_id)
    approved = result.approved
    if clean_id:
        matching = [task for task in result.history if task.get("id") == clean_id]
        if not matching:
            return _error(
                project_ref,
                result.chapter_number,
                "chapter_task_id does not belong to this project or chapter.",
                "chapter_task_not_found",
                404,
            )
        approved = next((task for task in matching if task.get("status") == "approved"), None)
        if approved is None:
            return _error(
                project_ref,
                result.chapter_number,
                "chapter_task_id is not an approved revision.",
                "chapter_task_not_approved",
                400,
            )
    if approved is None:
        if clean_id:
            return _error(
                project_ref,
                result.chapter_number,
                "chapter_task_id is not an approved revision.",
                "chapter_task_not_approved",
                400,
            )
        return ChapterTaskResult(
            True,
            project_ref=project_ref,
            chapter_number=result.chapter_number,
            relative_path=result.relative_path,
            message="No approved Chapter Task Sheet exists.",
            status_code=200,
            error_code="",
        )
    contract = derive_allowed_scene_contract(approved)
    return ChapterTaskResult(
        True,
        project_ref=project_ref,
        chapter_number=result.chapter_number,
        task=dict(approved),
        approved=dict(approved),
        history=result.history,
        contract=contract,
        relative_path=result.relative_path,
        message="Approved Chapter Task Sheet loaded.",
        status_code=200,
        error_code="",
    )


def derive_allowed_scene_contract(task: dict[str, Any]) -> str:
    if not isinstance(task, dict) or task.get("status") != "approved":
        raise ValueError("Allowed Scene Contract requires an approved Chapter Task Sheet.")
    primary_function = clean_text(task.get("primary_function"))
    secondary_functions = [
        clean_text(item)
        for item in task.get("secondary_functions", [])
        if clean_text(item) in CHAPTER_FUNCTIONS
    ]
    intensity = clean_text(task.get("intensity"))
    canon_budget = clean_text(task.get("canon_budget"))
    if primary_function not in CHAPTER_FUNCTIONS or intensity not in INTENSITIES or canon_budget not in CANON_BUDGETS:
        raise ValueError("Approved Chapter Task Sheet contains invalid enums.")
    consistency_message = _cross_field_consistency_error(task)
    if consistency_message:
        raise ValueError(f"Approved Chapter Task Sheet is inconsistent: {consistency_message}")

    functions = [primary_function, *secondary_functions]
    allowed = []
    for item in functions:
        if item == "foreshadowing_payoff" and canon_budget == "none":
            allowed.append("兑现既有关系、情绪或现实后果")
        elif item in FUNCTION_SCENE_DRIVERS:
            allowed.append(FUNCTION_SCENE_DRIVERS[item])
    forbidden: list[str] = []
    if intensity == "low" and canon_budget == "none":
        allowed = [*LOW_NONE_ALLOWED_SCENE_DRIVERS, *allowed]
        forbidden.extend(LOW_NONE_FORBIDDEN_SCENE_DRIVERS)
    if canon_budget == "none":
        allowed = [
            "零新正典：允许推进关系、情绪、选择和已确认事实产生的现实后果",
            *allowed,
        ]
        forbidden.extend(
            [
                "揭示新的正典事实、身份、因果、证据或终局答案",
                "引入新的组织秘密或用新谜团代替人物与情绪推进",
                "用材料解读制造新的核心证据",
            ]
        )
    elif canon_budget == "minor":
        forbidden.append("释放改变主线因果或终局真相的重大新正典")

    allowed.extend(clean_text(item) for item in task.get("allowed_scene_types", []) if clean_text(item))
    forbidden.extend(clean_text(item) for item in task.get("forbidden_scene_drivers", []) if clean_text(item))

    def unique(items: list[str]) -> list[str]:
        return list(dict.fromkeys(item for item in items if item))

    allowed = unique(allowed)
    forbidden = unique(forbidden)
    lines = [
        "### Derived Allowed Scene Contract",
        "",
        f"- Source task: {task.get('id')} revision {task.get('revision')} ({task.get('status')})",
        f"- Intensity: {intensity}",
        f"- Canon budget: {canon_budget}",
        "",
        "允许的场景驱动力：",
        *[f"- {item}" for item in allowed],
        "",
        "禁止作为主要场景驱动力：",
        *[f"- {item}" for item in forbidden],
        "",
        "合同执行规则：",
        "- 只能在任务单允许范围内推进；不得把禁止项改写成次要动作来规避合同。",
        "- 已知事实可以产生主观反应和现实后果，但不得借此释放未批准的新正典。",
        "- 本合同低于 Hard Continuity Constraints，高于历史大纲、人物卡和通用悬念要求。",
    ]
    if canon_budget == "none" and "foreshadowing_payoff" in functions:
        lines.append(
            "- 伏笔回收只能兑现已经确认的信息所产生的关系、情绪或现实后果；"
            "不得揭示新的正典事实、身份、因果、证据或终局答案。"
        )
    return "\n".join(lines).strip()


def format_approved_task_for_prompt(task: dict[str, Any]) -> str:
    if not isinstance(task, dict) or task.get("status") != "approved":
        raise ValueError("Prompt formatting requires an approved Chapter Task Sheet.")

    def list_text(field_name: str) -> str:
        values = [clean_text(item) for item in task.get(field_name, []) if clean_text(item)]
        return "；".join(values) if values else "无"

    return "\n".join(
        [
            "### Approved Chapter Task Sheet",
            "",
            f"- id: {task.get('id')}",
            f"- chapter_number: {task.get('chapter_number')}",
            f"- revision: {task.get('revision')}",
            f"- status: {task.get('status')}",
            f"- primary_function: {task.get('primary_function')}",
            f"- secondary_functions: {list_text('secondary_functions')}",
            f"- intensity: {task.get('intensity')}",
            f"- canon_budget: {task.get('canon_budget')}",
            f"- must_carry: {list_text('must_carry')}",
            f"- allowed_advances: {list_text('allowed_advances')}",
            f"- forbidden_advances: {list_text('forbidden_advances')}",
            f"- required_characters: {list_text('required_characters')}",
            f"- relationship_goal: {clean_text(task.get('relationship_goal')) or '无'}",
            f"- decision_goal: {clean_text(task.get('decision_goal')) or '无'}",
            f"- allowed_scene_types: {list_text('allowed_scene_types')}",
            f"- forbidden_scene_drivers: {list_text('forbidden_scene_drivers')}",
            f"- ending_state: {clean_text(task.get('ending_state')) or '无'}",
            f"- notes: {clean_text(task.get('notes')) or '无'}",
        ]
    )