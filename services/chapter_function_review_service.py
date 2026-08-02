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


REVIEW_VERSION = 1
REVIEW_TYPE = "no_reveal_compliance"
LOGS_DIR_NAME = "logs"
REVIEWS_DIR_NAME = "chapter_function_reviews"
VERDICTS = {"pass", "warn", "fail", "not_applicable"}
NEGATION_MARKERS = (
    "不",
    "没有",
    "别",
    "不再",
    "暂不",
    "停止",
    "收起",
    "放下",
    "不处理",
    "不打开",
    "不阅读",
    "不解析",
    "no ",
    "not ",
    "without ",
)
ACTION_TERMS = (
    "打开",
    "翻到",
    "读取",
    "查到",
    "发现",
    "揭示",
    "证明",
    "露出",
    "抬头印着",
    "核对",
    "解析",
    "告诉你一件事",
    "open",
    "read",
    "decode",
    "discover",
    "reveal",
    "prove",
)
NO_REVEAL_FORBIDDEN_MARKERS = (
    "no new canon",
    "no new canonical information",
    "不释放新正典信息",
    "不得释放新正典信息",
    "零新正典",
    "不读档案",
    "不看照片",
    "不解析编号",
    "不发现新证据",
    "不释放新线索",
    "no new evidence",
    "no files",
    "no photos",
    "no code",
    "no archive",
)
LOW_NO_REVEAL_CONTRACT_MARKERS = (
    "canon_budget=none",
    "零新正典",
    "不释放新正典",
    "禁止新事实",
    "禁止新身份",
    "禁止新因果",
    "禁止新证据",
    "no new canon",
    "no-reveal",
)

CATEGORY_TERMS: dict[str, tuple[str, ...]] = {
    "archive_or_records": (
        "档案",
        "档案室",
        "库房",
        "归档",
        "考勤记录",
        "考勤统计表",
        "财务凭证",
        "登记簿",
        "封条",
        "archive",
        "record",
        "attendance record",
    ),
    "number_or_code_analysis": (
        "编号",
        "解析",
        "核对编号",
        "第197页",
        "197",
        "GA-",
        "日期编号",
        "代码",
        "code",
        "serial",
    ),
    "photo_or_material_evidence": (
        "照片",
        "纸条",
        "教材",
        "夹层",
        "硬盘",
        "打印纸",
        "证据",
        "线索",
        "photo",
        "note",
        "evidence",
        "clue",
    ),
    "organization_reveal": (
        "管理局",
        "观察处",
        "特勤处",
        "组织",
        "部门抬头",
        "bureau",
        "agency",
        "department",
    ),
    "reveal_action": ACTION_TERMS,
    "new_hook": (
        "明天我要告诉你",
        "为什么会",
        "真相",
        "同一个档案",
        "还有一件事",
        "不是新线索",
        "tomorrow I will tell you",
        "the truth",
        "one more thing",
    ),
}

MATERIAL_CATEGORIES = {
    "archive_or_records",
    "number_or_code_analysis",
    "photo_or_material_evidence",
}


@dataclass(frozen=True)
class ChapterFunctionReviewResult:
    ok: bool
    project_ref: str = ""
    chapter_number: int = 0
    review: dict[str, Any] | None = None
    latest: dict[str, Any] | None = None
    history: list[dict[str, Any]] = field(default_factory=list)
    message: str = ""
    status_code: int = 400
    error_code: str = "chapter_function_review_error"




def _safe_review_id() -> str:
    return f"review_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{secrets.token_hex(4)}"




def _compact(value: Any) -> str:
    return re.sub(r"[\s，。；;,.、:：!！?？\"'“”‘’（）()\[\]{}<>《》\-—_]+", "", clean_text(value).casefold())


def _workspace_context(
    project_ref: str,
    books_root: Path | None = None,
) -> tuple[Any | None, str, int, str]:
    return resolve_workspace_context(
        project_ref,
        books_root=books_root,
        resolve=resolve_project_context,
        storage_message='Chapter Function Reviews are only supported for workspace book projects.',
        storage_error_code='chapter_function_review_unsupported_project',
    )


def _reviews_dir(ctx: Any) -> Path:
    return ctx.project_dir / LOGS_DIR_NAME / REVIEWS_DIR_NAME


def _review_path(ctx: Any, review_id: str) -> Path:
    return _reviews_dir(ctx) / f"{review_id}.json"


def _write_json_atomic(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(f".{path.name}.{secrets.token_hex(4)}.tmp")
    temp_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    temp_path.replace(path)


def _read_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"{path.name} is not valid JSON.") from exc
    if not isinstance(data, dict):
        raise ValueError(f"{path.name} must be a JSON object.")
    return data


def _chapter_number(value: Any) -> tuple[int, str]:
    if isinstance(value, bool):
        return 0, "Chapter number must be a positive integer."
    try:
        number = int(value)
    except (TypeError, ValueError):
        return 0, "Chapter number must be a positive integer."
    if number < 1:
        return 0, "Chapter number must be a positive integer."
    return number, ""


def _project_id(ctx: Any, project_ref: str) -> str:
    return clean_text(getattr(ctx, "book_id", "")) or clean_text(project_ref).split(":", 1)[-1]


def _relative_chapter_path(ctx: Any, chapter_path: str | Path | None, chapter_number: int) -> str:
    if chapter_path:
        path = Path(str(chapter_path))
        try:
            if path.is_absolute():
                return path.relative_to(ctx.project_dir).as_posix()
        except ValueError:
            return path.name
        normalized = str(chapter_path).replace("\\", "/").strip()
        if normalized and not Path(normalized).is_absolute() and ".." not in Path(normalized).parts:
            return normalized
        return path.name
    return f"chapters/chapter_{chapter_number:03d}.md"


def _review_summary(verdict: str, violations: list[dict[str, Any]]) -> str:
    if verdict == "not_applicable":
        return "No no-reveal review was required for this chapter."
    if not violations:
        return "Generated chapter did not match deterministic no-reveal violation rules."
    categories = ", ".join(sorted({str(item.get("category") or "") for item in violations if item.get("category")}))
    if verdict == "fail":
        return f"Generated chapter violates no-reveal constraints. Categories: {categories}."
    return f"Generated chapter contains no-reveal risk markers. Categories: {categories}."


def _forbidden_information(scene_plan: dict[str, Any] | None) -> list[str]:
    if not isinstance(scene_plan, dict):
        return []
    result: list[str] = []
    scenes = scene_plan.get("scenes")
    if not isinstance(scenes, list):
        return result
    for scene in scenes:
        if not isinstance(scene, dict):
            continue
        items = scene.get("forbidden_information")
        if not isinstance(items, list):
            continue
        for item in items:
            text = clean_text(item)
            if text:
                result.append(text)
    return result


def _has_no_reveal_forbidden_information(scene_plan: dict[str, Any] | None) -> bool:
    compact_items = [_compact(item) for item in _forbidden_information(scene_plan)]
    compact_markers = [_compact(marker) for marker in NO_REVEAL_FORBIDDEN_MARKERS]
    return any(marker and any(marker in item for item in compact_items) for marker in compact_markers)


def _has_low_no_reveal_contract(allowed_scene_contract: str | None) -> bool:
    contract = _compact(allowed_scene_contract)
    if not contract:
        return False
    return any(_compact(marker) in contract for marker in LOW_NO_REVEAL_CONTRACT_MARKERS)


def should_run_no_reveal_review(
    chapter_task: dict[str, Any] | None = None,
    allowed_scene_contract: str | None = None,
    scene_plan: dict[str, Any] | None = None,
) -> bool:
    if isinstance(chapter_task, dict) and chapter_task.get("status") == "approved":
        if clean_text(chapter_task.get("canon_budget")).casefold() == "none":
            return True
    if isinstance(scene_plan, dict) and scene_plan.get("status") == "approved":
        if _has_no_reveal_forbidden_information(scene_plan):
            return True
    return _has_low_no_reveal_contract(allowed_scene_contract)


def _source_rules_for_category(
    category: str,
    chapter_task: dict[str, Any] | None,
    allowed_scene_contract: str | None,
    scene_plan: dict[str, Any] | None,
) -> list[str]:
    rules: list[str] = []
    if isinstance(chapter_task, dict) and clean_text(chapter_task.get("canon_budget")).casefold() == "none":
        rules.append("Chapter Task Sheet: canon_budget=none")
    if _has_low_no_reveal_contract(allowed_scene_contract):
        rules.append("Allowed Scene Contract: low-intensity no-reveal")

    forbidden = _forbidden_information(scene_plan)
    category_terms = CATEGORY_TERMS.get(category, ())
    for item in forbidden:
        item_key = _compact(item)
        if not item_key:
            continue
        generic_no_canon = any(_compact(marker) in item_key for marker in NO_REVEAL_FORBIDDEN_MARKERS)
        explicit_category = any(_compact(term) and _compact(term) in item_key for term in category_terms)
        if generic_no_canon or explicit_category:
            rules.append(f"Scene Plan forbidden_information: {item}")
    return rules or ["No-Reveal Compliance Gate deterministic rule"]


def _iter_term_matches(text: str, term: str) -> list[tuple[int, int]]:
    if not term:
        return []
    if re.search(r"[A-Za-z]", term):
        matches = []
        lowered_text = text.casefold()
        lowered_term = term.casefold()
        start = lowered_text.find(lowered_term)
        while start >= 0:
            matches.append((start, start + len(term)))
            start = lowered_text.find(lowered_term, start + max(1, len(term)))
        return matches
    matches = []
    start = text.find(term)
    while start >= 0:
        matches.append((start, start + len(term)))
        start = text.find(term, start + max(1, len(term)))
    return matches


def _snippet(text: str, start: int, end: int, radius: int = 36) -> str:
    left = max(0, start - radius)
    right = min(len(text), end + radius)
    return text[left:right].replace("\r", "").replace("\n", " ").strip()


def _has_negation_near(text: str, start: int, end: int) -> bool:
    window = text[max(0, start - 12) : min(len(text), end + 12)].casefold()
    compact_window = _compact(window)
    return any(marker.casefold() in window or _compact(marker) in compact_window for marker in NEGATION_MARKERS)


def _has_action(snippet: str) -> bool:
    lowered = snippet.casefold()
    compact_snippet = _compact(snippet)
    return any(term.casefold() in lowered or _compact(term) in compact_snippet for term in ACTION_TERMS)


def _is_end_hook(text: str, start: int) -> bool:
    return start >= max(0, len(text) - 600)


def _violation_key(category: str, severity: str, source_rule: str, evidence: str) -> tuple[str, str, str, str]:
    return (category, severity, source_rule, evidence)


def evaluate_no_reveal_text(
    chapter_text: str,
    chapter_task: dict[str, Any] | None = None,
    allowed_scene_contract: str | None = None,
    scene_plan: dict[str, Any] | None = None,
) -> dict[str, Any]:
    text = clean_text(chapter_text)
    violations: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str, str]] = set()

    for category, terms in CATEGORY_TERMS.items():
        for term in terms:
            for start, end in _iter_term_matches(text, term):
                evidence = _snippet(text, start, end)
                negated = _has_negation_near(text, start, end)
                has_action = _has_action(evidence)
                severity = "fail"
                if negated and not ("抬头印着" in evidence or "核对编号" in evidence or "考勤统计表" in evidence):
                    severity = "warn"
                if category == "new_hook":
                    severity = "fail" if _is_end_hook(text, start) else "warn"
                if category == "reveal_action" and not has_action:
                    severity = "warn"
                if category in MATERIAL_CATEGORIES and has_action and not negated:
                    severity = "fail"
                for source_rule in _source_rules_for_category(category, chapter_task, allowed_scene_contract, scene_plan):
                    key = _violation_key(category, severity, source_rule, evidence)
                    if key in seen:
                        continue
                    seen.add(key)
                    violations.append(
                        {
                            "category": category,
                            "severity": severity,
                            "matched_terms": [term],
                            "evidence": evidence,
                            "source_rule": source_rule,
                        }
                    )

    fail_violations = [item for item in violations if item.get("severity") == "fail"]
    fail_categories = {str(item.get("category")) for item in fail_violations}
    categories = sorted({str(item.get("category")) for item in violations if item.get("category")})

    if fail_violations:
        verdict = "fail"
        score = 5 if len(fail_categories) >= 2 else 4
    elif violations:
        verdict = "warn"
        score = 2
    else:
        verdict = "pass"
        score = 0

    return {
        "verdict": verdict,
        "score": score,
        "categories": categories,
        "violations": violations,
        "summary": _review_summary(verdict, violations),
    }


def create_no_reveal_compliance_review(
    project_ref: str,
    chapter_number: int,
    chapter_text: str,
    chapter_path: str | Path | None = None,
    ai_run_id: str | None = None,
    chapter_task: dict[str, Any] | None = None,
    allowed_scene_contract: str | None = None,
    scene_plan: dict[str, Any] | None = None,
    books_root: Path | None = None,
) -> ChapterFunctionReviewResult:
    number, message = _chapter_number(chapter_number)
    if message:
        return ChapterFunctionReviewResult(False, project_ref=project_ref, message=message, error_code="invalid_chapter_number")

    if not should_run_no_reveal_review(chapter_task, allowed_scene_contract, scene_plan):
        review = {
            "type": REVIEW_TYPE,
            "chapter_number": number,
            "verdict": "not_applicable",
            "score": 0,
            "categories": [],
            "violations": [],
            "summary": "No no-reveal review trigger matched.",
        }
        return ChapterFunctionReviewResult(
            True,
            project_ref=project_ref,
            chapter_number=number,
            review=review,
            message="No-Reveal Compliance Gate not applicable.",
        )

    ctx, message, status_code, error_code = _workspace_context(project_ref, books_root=books_root)
    if ctx is None:
        return ChapterFunctionReviewResult(
            False,
            project_ref=project_ref,
            chapter_number=number,
            message=message,
            status_code=status_code,
            error_code=error_code,
        )

    evaluation = evaluate_no_reveal_text(
        chapter_text,
        chapter_task=chapter_task,
        allowed_scene_contract=allowed_scene_contract,
        scene_plan=scene_plan,
    )
    review_id = _safe_review_id()
    review = {
        "version": REVIEW_VERSION,
        "id": review_id,
        "type": REVIEW_TYPE,
        "project_id": _project_id(ctx, project_ref),
        "project_ref": project_ref,
        "chapter_number": number,
        "chapter_path": _relative_chapter_path(ctx, chapter_path, number),
        "ai_run_id": clean_text(ai_run_id) or None,
        "chapter_task": {
            "id": chapter_task.get("id") if isinstance(chapter_task, dict) else None,
            "revision": chapter_task.get("revision") if isinstance(chapter_task, dict) else None,
            "status": chapter_task.get("status") if isinstance(chapter_task, dict) else None,
            "canon_budget": chapter_task.get("canon_budget") if isinstance(chapter_task, dict) else None,
        },
        "scene_plan": {
            "id": scene_plan.get("id") if isinstance(scene_plan, dict) else None,
            "revision": scene_plan.get("revision") if isinstance(scene_plan, dict) else None,
            "status": scene_plan.get("status") if isinstance(scene_plan, dict) else None,
        },
        "verdict": evaluation["verdict"],
        "score": evaluation["score"],
        "categories": evaluation["categories"],
        "violations": evaluation["violations"],
        "summary": evaluation["summary"],
        "created_at": timestamp(timespec="microseconds"),
    }

    try:
        _write_json_atomic(_review_path(ctx, review_id), review)
    except OSError as exc:
        return ChapterFunctionReviewResult(
            False,
            project_ref=project_ref,
            chapter_number=number,
            message=f"Chapter Function Review write failed: {exc}",
            status_code=400,
            error_code="chapter_function_review_write_failed",
        )
    return ChapterFunctionReviewResult(
        True,
        project_ref=project_ref,
        chapter_number=number,
        review=review,
        latest=review,
        history=[review],
        message="No-Reveal Compliance Gate review created.",
    )


def list_chapter_function_reviews(
    project_ref: str,
    chapter_number: int,
    books_root: Path | None = None,
) -> ChapterFunctionReviewResult:
    number, message = _chapter_number(chapter_number)
    if message:
        return ChapterFunctionReviewResult(False, project_ref=project_ref, message=message, error_code="invalid_chapter_number")

    ctx, message, status_code, error_code = _workspace_context(project_ref, books_root=books_root)
    if ctx is None:
        return ChapterFunctionReviewResult(
            False,
            project_ref=project_ref,
            chapter_number=number,
            message=message,
            status_code=status_code,
            error_code=error_code,
        )

    history: list[dict[str, Any]] = []
    root = _reviews_dir(ctx)
    if root.exists():
        try:
            for path in root.glob("*.json"):
                data = _read_json(path)
                if data.get("type") == REVIEW_TYPE and int(data.get("chapter_number") or 0) == number:
                    history.append(data)
        except (OSError, ValueError) as exc:
            return ChapterFunctionReviewResult(
                False,
                project_ref=project_ref,
                chapter_number=number,
                message=f"Chapter Function Review read failed: {exc}",
                status_code=400,
                error_code="chapter_function_review_read_failed",
            )
    history.sort(key=lambda item: (clean_text(item.get("created_at")), clean_text(item.get("id"))), reverse=True)
    return ChapterFunctionReviewResult(
        True,
        project_ref=project_ref,
        chapter_number=number,
        latest=history[0] if history else None,
        history=history,
        message="Chapter Function Reviews loaded.",
    )