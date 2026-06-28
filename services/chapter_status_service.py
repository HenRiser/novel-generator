from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from file_manager import resolve_project_context
from project_context import WORKSPACE_STORAGE_KIND

from .ai_run_service import list_ai_runs
from .event_log_service import list_events


MEMORY_DIR_NAME = "memory"
STORY_DELTAS_NAME = "story_deltas.json"
KNOWLEDGE_DRAFTS_NAME = "knowledge_drafts.json"
CHAPTER_FUNCTION_REVIEWS_DIR_NAME = "chapter_function_reviews"
NO_REVEAL_REVIEW_TYPE = "no_reveal_compliance"
SUPPORTED_GUARD_ACTIONS = {"generate_chapter"}
REVIEWABLE_OPERATIONS = {"create_node", "create_edge"}
CHANGE_STATUSES = ("pending_review", "accepted", "rejected", "failed", "superseded")


@dataclass(frozen=True)
class ChapterStatusResult:
    ok: bool
    project_ref: str = ""
    chapter_status: dict[str, Any] = field(default_factory=dict)
    chapters: list[dict[str, Any]] = field(default_factory=list)
    summary: dict[str, Any] = field(default_factory=dict)
    guard: dict[str, Any] = field(default_factory=dict)
    message: str = ""
    status_code: int = 400
    error_code: str = "chapter_status_error"


def _clean_text(value: Any) -> str:
    return str(value or "").strip()


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
        return None, "Chapter Status is only supported for workspace book projects."
    return ctx, ""


def _error_result(project_ref: str, message: str, code: str, status_code: int = 400) -> ChapterStatusResult:
    return ChapterStatusResult(
        False,
        project_ref=project_ref,
        message=message,
        error_code=code,
        status_code=status_code,
    )


def _read_json(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"{path.name} is not valid JSON.") from exc
    return data if isinstance(data, dict) else {}


def _chapter_number_from_path(path: Path) -> int | None:
    match = re.match(r"^chapter_(\d+)(?:_v\d+)?\.md$", path.name)
    return int(match.group(1)) if match else None


def _chapter_version_from_path(path: Path) -> int:
    match = re.search(r"_v(\d+)$", path.stem)
    return int(match.group(1)) if match else 1


def _relative_path(ctx: Any, path: Path) -> str:
    try:
        return path.resolve().relative_to(ctx.project_dir.resolve()).as_posix()
    except ValueError:
        return path.name


def _latest_chapter_files(ctx: Any) -> dict[int, Path]:
    if not ctx.chapters_dir.exists():
        return {}
    grouped: dict[int, list[Path]] = {}
    for path in ctx.chapters_dir.glob("chapter_*.md"):
        if not path.is_file():
            continue
        number = _chapter_number_from_path(path)
        if number is not None:
            grouped.setdefault(number, []).append(path)
    return {
        number: max(files, key=lambda item: (_chapter_version_from_path(item), item.stat().st_mtime))
        for number, files in grouped.items()
    }


def _memory_dir(ctx: Any) -> Path:
    return ctx.project_dir / MEMORY_DIR_NAME


def _story_delta_items(ctx: Any) -> list[dict[str, Any]]:
    document = _read_json(_memory_dir(ctx) / STORY_DELTAS_NAME) or {}
    items = document.get("items")
    return [item for item in items if isinstance(item, dict)] if isinstance(items, list) else []


def _knowledge_drafts(ctx: Any) -> list[dict[str, Any]]:
    document = _read_json(_memory_dir(ctx) / KNOWLEDGE_DRAFTS_NAME) or {}
    drafts = document.get("drafts")
    return [draft for draft in drafts if isinstance(draft, dict)] if isinstance(drafts, list) else []


def _as_chapter_number(value: Any) -> int | None:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def _function_review_items(ctx: Any) -> list[dict[str, Any]]:
    root = ctx.logs_dir / CHAPTER_FUNCTION_REVIEWS_DIR_NAME
    if not root.exists():
        return []
    items: list[dict[str, Any]] = []
    for path in root.glob("*.json"):
        data = _read_json(path) or {}
        if data.get("type") == NO_REVEAL_REVIEW_TYPE:
            items.append(data)
    return items


def _function_review_summary(review: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(review, dict):
        return None
    categories = review.get("categories")
    if not isinstance(categories, list):
        categories = []
    try:
        score = int(review.get("score") or 0)
    except (TypeError, ValueError):
        score = 0
    return {
        "id": _clean_text(review.get("id")),
        "type": _clean_text(review.get("type")),
        "verdict": _clean_text(review.get("verdict")),
        "score": score,
        "categories": [_clean_text(item) for item in categories if _clean_text(item)],
        "created_at": _clean_text(review.get("created_at")),
        "ai_run_id": _clean_text(review.get("ai_run_id")),
    }


def _latest_function_review(reviews: list[dict[str, Any]], chapter_number: int) -> dict[str, Any] | None:
    candidates = [
        item
        for item in reviews
        if _as_chapter_number(item.get("chapter_number")) == chapter_number
    ]
    candidates.sort(key=lambda item: (_clean_text(item.get("created_at")), _clean_text(item.get("id"))), reverse=True)
    return _function_review_summary(candidates[0]) if candidates else None


def _items_for_chapter(items: list[dict[str, Any]], chapter_number: int) -> list[dict[str, Any]]:
    return [item for item in items if _as_chapter_number(item.get("chapter_number")) == chapter_number]


def _events_for_chapter(events: list[dict[str, Any]], chapter_number: int, event_type: str) -> list[dict[str, Any]]:
    return [
        event
        for event in events
        if isinstance(event, dict)
        and _clean_text(event.get("type")) == event_type
        and _as_chapter_number(event.get("chapter_number")) == chapter_number
    ]


def _runs_for_chapter(runs: list[dict[str, Any]], chapter_number: int, run_type: str) -> list[dict[str, Any]]:
    return [
        run
        for run in runs
        if isinstance(run, dict)
        and _clean_text(run.get("run_type")) == run_type
        and _as_chapter_number(run.get("chapter_number")) == chapter_number
    ]


def _change_counts(drafts: list[dict[str, Any]]) -> dict[str, int]:
    counts = {status: 0 for status in CHANGE_STATUSES}
    counts["unsupported"] = 0
    counts["total"] = 0
    for draft in drafts:
        changes = draft.get("candidate_changes")
        if not isinstance(changes, list):
            continue
        for change in changes:
            if not isinstance(change, dict):
                continue
            counts["total"] += 1
            status = _clean_text(change.get("status")) or "pending_review"
            if status not in counts:
                status = "pending_review"
            counts[status] += 1
            if _clean_text(change.get("operation")) not in REVIEWABLE_OPERATIONS:
                counts["unsupported"] += 1
    return counts


def _knowledge_status(counts: dict[str, int], draft_count: int) -> str:
    if draft_count == 0 or counts["total"] == 0:
        return "none"
    if counts["pending_review"] > 0 and counts["pending_review"] == counts["total"]:
        return "pending_review"
    if counts["failed"] > 0 and counts["pending_review"] == 0:
        return "failed"
    if counts["pending_review"] > 0 or counts["failed"] > 0:
        return "partial"
    return "completed"


def _review_status(counts: dict[str, int]) -> str:
    if counts["total"] == 0:
        return "not_applicable"
    if counts["pending_review"] == counts["total"]:
        return "pending"
    if counts["pending_review"] > 0 or counts["failed"] > 0:
        return "partial"
    return "completed"


def _warning(code: str, severity: str, message: str) -> dict[str, str]:
    return {"code": code, "severity": severity, "message": message}


def _chapter_status(
    project_ref: str,
    ctx: Any,
    chapter_number: int,
    chapter_files: dict[int, Path],
    story_deltas: list[dict[str, Any]],
    drafts: list[dict[str, Any]],
    events: list[dict[str, Any]],
    ai_runs: list[dict[str, Any]],
    function_reviews: list[dict[str, Any]],
) -> dict[str, Any]:
    chapter_path = chapter_files.get(chapter_number)
    chapter_exists = chapter_path is not None
    chapter_ref = _relative_path(ctx, chapter_path) if chapter_path else None

    chapter_deltas = _items_for_chapter(story_deltas, chapter_number)
    chapter_drafts = _items_for_chapter(drafts, chapter_number)
    counts = _change_counts(chapter_drafts)
    story_delta_events = _events_for_chapter(events, chapter_number, "story_delta_analyzed")
    generated_events = _events_for_chapter(events, chapter_number, "chapter_generated")
    accepted_events = _events_for_chapter(events, chapter_number, "knowledge_draft_change_accepted")
    rejected_events = _events_for_chapter(events, chapter_number, "knowledge_draft_change_rejected")
    chapter_generation_runs = _runs_for_chapter(ai_runs, chapter_number, "chapter_generation")
    story_delta_runs = _runs_for_chapter(ai_runs, chapter_number, "story_delta_analysis")
    latest_function_review = _latest_function_review(function_reviews, chapter_number)
    latest_review_verdict = _clean_text(latest_function_review.get("verdict") if latest_function_review else "").casefold()

    warnings: list[dict[str, str]] = []
    next_actions: list[str] = []
    if latest_review_verdict == "fail":
        warnings.append(_warning(
            "no_reveal_review_failed",
            "warning",
            "The latest No-Reveal review failed. This chapter needs manual review before being treated as trusted context.",
        ))
        next_actions.extend([
            "当前章节 No-Reveal 审核失败，请人工复核。",
            "不建议直接进入下一章。",
            "不建议将本章作为可信上下文继续推进，除非你确认接受风险。",
        ])
    elif latest_review_verdict == "warn":
        warnings.append(_warning(
            "no_reveal_review_warn",
            "warning",
            "The latest No-Reveal review has warnings.",
        ))
        next_actions.append("当前章节存在 No-Reveal 风险，请快速复核 evidence。")
    if chapter_exists and not chapter_deltas:
        warnings.append(_warning(
            "story_delta_missing",
            "warning",
            "This chapter has prose but no Story Delta analysis yet.",
        ))
        next_actions.append("Run Story Delta analysis for this chapter.")
    if counts["pending_review"] > 0:
        warnings.append(_warning(
            "knowledge_draft_pending",
            "warning",
            "This chapter has pending Knowledge Draft changes.",
        ))
        next_actions.append("Review pending Knowledge Draft changes.")
    if chapter_deltas and not story_delta_runs:
        warnings.append(_warning(
            "story_delta_provenance_missing",
            "info",
            "Story Delta exists, but no story_delta_analysis AI Run provenance was found.",
        ))
    warnings.append(_warning(
        "context_pack_freshness_unknown",
        "info",
        "No persisted context pack freshness metadata is available.",
    ))

    return {
        "chapter_number": chapter_number,
        "chapter": {
            "exists": chapter_exists,
            "ref": chapter_ref,
        },
        "story_delta": {
            "status": "analyzed" if chapter_deltas else "missing",
            "delta_ids": [_clean_text(item.get("id")) for item in chapter_deltas if _clean_text(item.get("id"))],
            "event_ids": [_clean_text(event.get("id")) for event in story_delta_events if _clean_text(event.get("id"))],
            "ai_run_ids": [_clean_text(run.get("id")) for run in story_delta_runs if _clean_text(run.get("id"))],
        },
        "knowledge_drafts": {
            "status": _knowledge_status(counts, len(chapter_drafts)),
            "draft_ids": [_clean_text(draft.get("id")) for draft in chapter_drafts if _clean_text(draft.get("id"))],
            "counts": counts,
        },
        "review": {
            "status": _review_status(counts),
            "pending_count": counts["pending_review"],
            "accepted_count": counts["accepted"],
            "rejected_count": counts["rejected"],
            "failed_count": counts["failed"],
        },
        "ai_runs": {
            "chapter_generation": [_clean_text(run.get("id")) for run in chapter_generation_runs if _clean_text(run.get("id"))],
            "story_delta_analysis": [_clean_text(run.get("id")) for run in story_delta_runs if _clean_text(run.get("id"))],
        },
        "events": {
            "chapter_generated": [_clean_text(event.get("id")) for event in generated_events if _clean_text(event.get("id"))],
            "story_delta_analyzed": [_clean_text(event.get("id")) for event in story_delta_events if _clean_text(event.get("id"))],
            "knowledge_draft_change_accepted": [_clean_text(event.get("id")) for event in accepted_events if _clean_text(event.get("id"))],
            "knowledge_draft_change_rejected": [_clean_text(event.get("id")) for event in rejected_events if _clean_text(event.get("id"))],
        },
        "context_pack": {
            "status": "unknown",
            "message": "No persisted context pack freshness metadata is available.",
        },
        "latest_function_review": latest_function_review,
        "warnings": warnings,
        "next_actions": next_actions,
    }


def _load_sources(project_ref: str) -> tuple[Any | None, dict[str, Any], str]:
    ctx, message = _workspace_context(project_ref)
    if ctx is None:
        return None, {}, message
    try:
        events_result = list_events(project_ref)
        runs_result = list_ai_runs(project_ref, limit=200)
        sources = {
            "chapter_files": _latest_chapter_files(ctx),
            "story_deltas": _story_delta_items(ctx),
            "drafts": _knowledge_drafts(ctx),
            "events": events_result.events if events_result.ok else [],
            "ai_runs": runs_result.runs if runs_result.ok else [],
            "function_reviews": _function_review_items(ctx),
        }
    except (OSError, ValueError) as exc:
        return ctx, {}, f"Chapter status read failed: {exc}"
    return ctx, sources, ""


def get_chapter_status(project_ref: str, chapter_number: Any) -> ChapterStatusResult:
    number = _as_chapter_number(chapter_number)
    if number is None:
        return _error_result(project_ref, "chapter_number must be a positive integer.", "chapter_status_invalid_chapter", 400)
    ctx, sources, message = _load_sources(project_ref)
    if ctx is None:
        return _error_result(
            project_ref,
            message,
            "chapter_status_unsupported_project" if "only supported" in message else "chapter_status_unavailable",
            400,
        )
    if not sources:
        return _error_result(project_ref, message, "chapter_status_unavailable", 400)
    status = _chapter_status(project_ref, ctx, number, **sources)
    return ChapterStatusResult(True, project_ref=project_ref, chapter_status=status)


def list_chapter_statuses(project_ref: str) -> ChapterStatusResult:
    ctx, sources, message = _load_sources(project_ref)
    if ctx is None:
        return _error_result(
            project_ref,
            message,
            "chapter_status_unsupported_project" if "only supported" in message else "chapter_status_unavailable",
            400,
        )
    if not sources:
        return _error_result(project_ref, message, "chapter_status_unavailable", 400)

    chapter_numbers: set[int] = set(sources["chapter_files"].keys())
    for item in sources["story_deltas"]:
        number = _as_chapter_number(item.get("chapter_number"))
        if number:
            chapter_numbers.add(number)
    for draft in sources["drafts"]:
        number = _as_chapter_number(draft.get("chapter_number"))
        if number:
            chapter_numbers.add(number)
    for event in sources["events"]:
        number = _as_chapter_number(event.get("chapter_number"))
        if number:
            chapter_numbers.add(number)
    for run in sources["ai_runs"]:
        number = _as_chapter_number(run.get("chapter_number"))
        if number:
            chapter_numbers.add(number)
    for review in sources["function_reviews"]:
        number = _as_chapter_number(review.get("chapter_number"))
        if number:
            chapter_numbers.add(number)

    chapters = [
        _chapter_status(project_ref, ctx, number, **sources)
        for number in sorted(chapter_numbers)
    ]
    summary = {
        "generated_chapters": sum(1 for chapter in chapters if chapter["chapter"]["exists"]),
        "chapters_with_story_delta": sum(1 for chapter in chapters if chapter["story_delta"]["status"] == "analyzed"),
        "chapters_with_pending_drafts": sum(1 for chapter in chapters if chapter["knowledge_drafts"]["counts"]["pending_review"] > 0),
        "chapters_with_failed_function_review": sum(
            1
            for chapter in chapters
            if (chapter.get("latest_function_review") or {}).get("verdict") == "fail"
        ),
        "total_pending_draft_changes": sum(chapter["knowledge_drafts"]["counts"]["pending_review"] for chapter in chapters),
    }
    return ChapterStatusResult(True, project_ref=project_ref, chapters=chapters, summary=summary)


def check_workflow_guard(project_ref: str, request: dict[str, Any]) -> ChapterStatusResult:
    action = _clean_text(request.get("action") if isinstance(request, dict) else "")
    if action not in SUPPORTED_GUARD_ACTIONS:
        return _error_result(project_ref, "Unsupported workflow guard action.", "workflow_guard_action_unsupported", 400)
    chapter_number = _as_chapter_number(request.get("chapter_number") if isinstance(request, dict) else None)
    if chapter_number is None:
        return _error_result(project_ref, "chapter_number must be a positive integer.", "workflow_guard_invalid_chapter", 400)

    current_result = get_chapter_status(project_ref, chapter_number)
    if not current_result.ok:
        return current_result
    warnings: list[dict[str, str]] = []
    suggested_actions: list[str] = []
    current = current_result.chapter_status
    if current["chapter"]["exists"]:
        warnings.append(_warning(
            "target_chapter_exists",
            "warning",
            "The target chapter already has prose. Continuing may create a new version under the current save rules.",
        ))
        suggested_actions.append("Review the existing chapter before generating again.")

    previous_number = chapter_number - 1
    if previous_number >= 1:
        previous_result = get_chapter_status(project_ref, previous_number)
        if previous_result.ok:
            previous = previous_result.chapter_status
            if previous["chapter"]["exists"] and previous["story_delta"]["status"] == "missing":
                warnings.append(_warning(
                    "previous_story_delta_missing",
                    "warning",
                    "The previous chapter has prose but no Story Delta analysis.",
                ))
                suggested_actions.append("Run Story Delta analysis for the previous chapter.")
            if previous["knowledge_drafts"]["counts"]["pending_review"] > 0:
                warnings.append(_warning(
                    "previous_pending_knowledge_draft",
                    "warning",
                    "The previous chapter still has pending Knowledge Draft changes.",
                ))
                suggested_actions.append("Review pending Knowledge Draft changes from the previous chapter.")
            if previous["story_delta"]["status"] == "analyzed" and not previous["ai_runs"]["story_delta_analysis"]:
                warnings.append(_warning(
                    "previous_story_delta_provenance_missing",
                    "warning",
                    "The previous chapter has Story Delta data but no story_delta_analysis AI Run provenance.",
                ))
            previous_review = previous.get("latest_function_review") or {}
            if previous_review.get("verdict") == "fail":
                warnings.append(_warning(
                    "previous_no_reveal_review_failed",
                    "warning",
                    "The previous chapter failed No-Reveal review. Do not treat it as trusted context without manual review.",
                ))
                suggested_actions.append("Manually review the previous chapter No-Reveal evidence before generating the next chapter.")

    warnings.append(_warning(
        "context_pack_freshness_unknown",
        "info",
        "Context Pack freshness cannot be verified because no persisted freshness metadata is available.",
    ))

    guard = {
        "ok": True,
        "project_ref": project_ref,
        "action": action,
        "chapter_number": chapter_number,
        "blocking": False,
        "warnings": warnings,
        "suggested_actions": suggested_actions,
    }
    return ChapterStatusResult(True, project_ref=project_ref, guard=guard)
