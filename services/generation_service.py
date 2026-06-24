from __future__ import annotations

from pathlib import Path
from typing import Any, Iterator

from deepseek_client import DeepSeekClientError, generate_text, stream_generate_text
from file_manager import (
    read_history_summaries,
    read_latest_characters,
    read_latest_outline,
    read_previous_chapter,
    save_chapter,
    save_characters,
    save_outline,
    save_summary,
    update_chapter_index,
)
from prompt_templates import (
    build_chapter_prompt,
    build_character_prompt,
    build_low_intensity_chapter_constraints_prompt,
    build_outline_prompt,
    build_summary_prompt,
)

from .chapter_service import extract_chapter_title
from .ai_run_service import create_ai_run_record_best_effort
from .consistency_check_service import check_generated_chapter_consistency
from .event_log_service import append_event_best_effort
from .prompt_profile_service import build_prompt_profile
from .schemas import ChapterGenerationResult, OutlineCharacterGenerationResult


OUTLINE_MODE = "outline"
CHARACTER_MODE = "character"
CHAPTER_MODE = "chapter"
UNTITLED_CHAPTER = "Untitled chapter"
CHAPTER_GOAL_PREFIXES = (
    "Chapter goal:",
    "Chapter goal：",
    "章节目标:",
    "章节目标：",
    "章节目标文本:",
    "章节目标文本：",
)
LOW_INTENSITY_GOAL_MARKERS = (
    "低强度",
    "低烈度",
    "情绪消化",
    "行动缓冲",
    "过渡章节",
    "不新增设定",
    "不新增档案",
    "不新增编号",
    "不新增纸条",
    "不新增正典",
    "不要引入新档案",
    "不要引入新编号",
    "不要推进终局",
    "不要揭示大型设定",
    "不要堆设定",
    "不揭示新信息",
    "不要揭示新信息",
    "不释放新信息",
    "不要释放新信息",
    "low-intensity",
    "low intensity",
    "no new canon",
    "no new archive",
    "no new file",
    "no new revelation",
)
LOW_INTENSITY_NEGATION_MARKERS = ("不要低强度", "不低强度")


def _model(task_models: dict[str, str], key: str) -> str:
    return str((task_models or {}).get(key) or "").strip()


def _chapter_failure(
    chapter_number: int,
    message: str,
    task_models: dict[str, str] | None = None,
    notices: list[str] | None = None,
) -> ChapterGenerationResult:
    task_models = task_models or {}
    chapter_model = _model(task_models, "chapter")
    summary_model = _model(task_models, "summary")
    return ChapterGenerationResult(
        False,
        chapter_number=int(chapter_number or 0),
        title=UNTITLED_CHAPTER,
        message=message,
        notices=list(notices or []),
        chapter_model=chapter_model,
        chapter_title_model=chapter_model,
        summary_model=summary_model,
    )


def _extract_chapter_goal_from_narrative_context(narrative_context_text: str | None) -> str:
    for raw_line in str(narrative_context_text or "").splitlines():
        line = raw_line.strip()
        normalized = line.casefold()
        for prefix in CHAPTER_GOAL_PREFIXES:
            if normalized.startswith(prefix.casefold()):
                return line[len(prefix) :].strip()
    return ""


def _is_low_intensity_chapter_goal(chapter_goal: str) -> bool:
    goal = str(chapter_goal or "").strip()
    if not goal:
        return False
    compact_goal = "".join(goal.split()).casefold()
    if any("".join(marker.split()).casefold() in compact_goal for marker in LOW_INTENSITY_NEGATION_MARKERS):
        return False
    return any("".join(marker.split()).casefold() in compact_goal for marker in LOW_INTENSITY_GOAL_MARKERS)


def build_generation_messages(
    project_ref: str,
    mode: str,
    project_config: dict[str, Any],
    chapter_number: int,
    use_previous_context: bool,
    narrative_context_text: str | None = None,
) -> tuple[list[dict[str, str]], list[str]]:
    notices: list[str] = []

    if mode == OUTLINE_MODE:
        return build_outline_prompt(project_config), notices

    if mode == CHARACTER_MODE:
        return build_character_prompt(project_config), notices

    outline, outline_path = (None, None)
    characters, characters_path = (None, None)
    previous_chapter = None
    previous_path = None
    summaries = ""

    if project_ref:
        outline, outline_path = read_latest_outline(project_ref)
        characters, characters_path = read_latest_characters(project_ref)
        summaries = read_history_summaries(project_ref, before_chapter=chapter_number)

    if outline_path:
        notices.append(f"Loaded outline context: {outline_path.name}")
    if characters_path:
        notices.append(f"Loaded character context: {characters_path.name}")
    if summaries:
        notices.append("Loaded historical chapter summaries.")

    if use_previous_context:
        if project_ref:
            previous_chapter, previous_path = read_previous_chapter(project_ref, chapter_number)
        if previous_path:
            notices.append(f"Loaded previous chapter context: {previous_path.name}")
        else:
            notices.append("Previous chapter context was not found; using settings, outline, characters, and summaries only.")

    messages = build_chapter_prompt(
        project_config=project_config,
        chapter_number=chapter_number,
        outline=outline,
        characters=characters,
        previous_chapter=previous_chapter,
        summaries=summaries,
    )
    context_text = str(narrative_context_text or "").strip()
    if context_text:
        messages = _append_user_context(messages, context_text)
        notices.append("Loaded Narrative Context Pack.")
        chapter_goal = _extract_chapter_goal_from_narrative_context(context_text)
        if _is_low_intensity_chapter_goal(chapter_goal):
            messages = _append_user_context(messages, build_low_intensity_chapter_constraints_prompt(chapter_goal))
    return messages, notices


def _append_user_context(messages: list[dict[str, str]], context_text: str) -> list[dict[str, str]]:
    updated = [dict(message) for message in messages]
    for index in range(len(updated) - 1, -1, -1):
        if updated[index].get("role") == "user":
            updated[index]["content"] = f"{updated[index].get('content', '').rstrip()}\n\n{context_text}"
            return updated
    updated.append({"role": "user", "content": context_text})
    return updated


def _chapter_ai_run_metadata(
    messages: list[dict[str, str]],
    temperature: Any,
    max_tokens: Any,
    use_previous_context: bool,
    narrative_context_text: str | None,
) -> dict[str, Any]:
    return {
        "messages": [dict(message) for message in messages],
        "temperature": temperature,
        "max_tokens": int(max_tokens),
        "context": {
            "context_pack_id": None,
            "included_node_ids": [],
            "included_edge_ids": [],
            "outline_refs": [],
            "summary_refs": [],
            "chapter_refs": [],
            "metadata": {
                "use_previous_context": bool(use_previous_context),
                "narrative_context_attached": bool(str(narrative_context_text or "").strip()),
            },
        },
    }


def generate_outline_and_characters(
    project_ref: str,
    project_config: dict[str, Any],
    task_models: dict[str, str],
    temperature: float,
    max_tokens: int,
) -> OutlineCharacterGenerationResult:
    ref = str(project_ref or "").strip()
    if not ref:
        return OutlineCharacterGenerationResult(False, message="Project reference is required.")

    outline_model = _model(task_models, "outline")
    characters_model = _model(task_models, "character")
    if not outline_model:
        return OutlineCharacterGenerationResult(False, message="Outline model is required.")
    if not characters_model:
        return OutlineCharacterGenerationResult(False, message="Character model is required.")

    try:
        outline = generate_text(
            messages=build_outline_prompt(project_config),
            model=outline_model,
            temperature=temperature,
            max_tokens=int(max_tokens),
        )
        outline_path = save_outline(ref, outline)

        characters = generate_text(
            messages=build_character_prompt(project_config),
            model=characters_model,
            temperature=temperature,
            max_tokens=int(max_tokens),
        )
        characters_path = save_characters(ref, characters)
    except DeepSeekClientError as exc:
        return OutlineCharacterGenerationResult(False, message=str(exc), outline_model=outline_model, characters_model=characters_model)
    except Exception as exc:
        return OutlineCharacterGenerationResult(
            False,
            message=f"Setting asset generation failed: {exc}",
            outline_model=outline_model,
            characters_model=characters_model,
        )

    return OutlineCharacterGenerationResult(
        True,
        outline_path=str(outline_path),
        characters_path=str(characters_path),
        outline_content=outline,
        characters_content=characters,
        outline_model=outline_model,
        characters_model=characters_model,
    )


def _validate_chapter_request(
    project_ref: str,
    chapter_number: int,
    task_models: dict[str, str],
) -> tuple[bool, int, str, str]:
    try:
        number = int(chapter_number)
    except (TypeError, ValueError):
        return False, 0, "", "Chapter number must be a positive integer."
    if number < 1:
        return False, number, "", "Chapter number must be a positive integer."

    ref = str(project_ref or "").strip()
    if not ref:
        return False, number, "", "Project reference is required."

    if not _model(task_models, "chapter"):
        return False, number, ref, "Chapter model is required."
    if not _model(task_models, "summary"):
        return False, number, ref, "Summary model is required."

    return True, number, ref, ""


def _finalize_generated_chapter(
    project_ref: str,
    chapter_number: int,
    chapter_content: str,
    task_models: dict[str, str],
    notices: list[str] | None = None,
    ai_run_metadata: dict[str, Any] | None = None,
    narrative_context_text: str | None = None,
) -> ChapterGenerationResult:
    notices = list(notices or [])
    chapter_model = _model(task_models, "chapter")
    summary_model = _model(task_models, "summary")
    chapter_title_model = chapter_model
    chapter_title = extract_chapter_title(chapter_content)

    try:
        chapter_path = save_chapter(project_ref, chapter_number, chapter_content)
    except Exception as exc:
        return ChapterGenerationResult(
            False,
            chapter_number=chapter_number,
            title=chapter_title,
            content=chapter_content,
            notices=notices,
            message=f"Chapter save failed: {exc}",
            chapter_model=chapter_model,
            chapter_title_model=chapter_title_model,
            summary_model=summary_model,
        )

    summary = ""
    summary_path = ""
    summary_error = None
    try:
        summary_messages = build_summary_prompt(chapter_content, chapter_number)
        summary = generate_text(
            messages=summary_messages,
            model=summary_model,
            temperature=0.2,
            max_tokens=512,
        )
        summary_path = str(save_summary(project_ref, chapter_number, summary))
    except DeepSeekClientError as exc:
        summary_error = str(exc)
    except Exception as exc:
        summary_error = f"Summary save failed: {exc}"

    try:
        index_path = update_chapter_index(
            title=project_ref,
            chapter_number=chapter_number,
            chapter_title=chapter_title,
            chapter_path=Path(chapter_path),
            model=chapter_model,
            summary=summary,
        )
    except Exception as exc:
        return ChapterGenerationResult(
            False,
            chapter_number=chapter_number,
            title=chapter_title,
            content=chapter_content,
            chapter_path=str(chapter_path),
            summary=summary,
            summary_path=summary_path,
            notices=notices,
            summary_error=summary_error,
            message=f"Chapter index update failed: {exc}",
            chapter_model=chapter_model,
            chapter_title_model=chapter_title_model,
            summary_model=summary_model,
        )

    ai_run_id = None
    if isinstance(ai_run_metadata, dict):
        ai_run_result = create_ai_run_record_best_effort(
            project_ref=project_ref,
            run_type="chapter_generation",
            chapter_number=chapter_number,
            model=chapter_model,
            temperature=ai_run_metadata.get("temperature"),
            max_tokens=ai_run_metadata.get("max_tokens"),
            prompt_profile=build_prompt_profile("chapter_generation", ai_run_metadata.get("messages")),
            context=ai_run_metadata.get("context"),
            result={
                "status": "success",
                "output_ref": f"chapters/{Path(chapter_path).name}",
                "finish_reason": None,
                "error": None,
                "metadata": {
                    "summary_file": Path(summary_path).name if summary_path else None,
                    "index_file": Path(index_path).name,
                },
            },
        )
        if ai_run_result.ok:
            ai_run_id = ai_run_result.run_id

    changed_targets = [f"chapters/{Path(chapter_path).name}", Path(index_path).name]
    if summary_path:
        changed_targets.insert(1, f"summaries/{Path(summary_path).name}")
    append_event_best_effort(
        project_ref=project_ref,
        event_type="chapter_generated",
        summary=f"Generated chapter {chapter_number}: {chapter_title}",
        chapter_number=chapter_number,
        source={
            "chapter_file": Path(chapter_path).name,
            "summary_file": Path(summary_path).name if summary_path else None,
            "index_file": Path(index_path).name,
            "summary_error": summary_error,
            "ai_run_id": ai_run_id,
        },
        changed_targets=changed_targets,
    )

    try:
        consistency_warnings = check_generated_chapter_consistency(chapter_content, narrative_context_text)
    except Exception:
        consistency_warnings = []

    return ChapterGenerationResult(
        True,
        chapter_number=chapter_number,
        title=chapter_title,
        content=chapter_content,
        chapter_path=str(chapter_path),
        summary=summary,
        summary_path=summary_path,
        index_path=str(index_path),
        notices=notices,
        summary_error=summary_error,
        chapter_model=chapter_model,
        chapter_title_model=chapter_title_model,
        summary_model=summary_model,
        consistency_warnings=consistency_warnings,
    )


def _stream_error_event(
    message: str,
    chapter_number: int = 0,
    partial_length: int = 0,
    code: str = "generation_failed",
) -> dict[str, Any]:
    return {
        "type": "error",
        "ok": False,
        "code": code,
        "chapter_number": int(chapter_number or 0),
        "message": str(message or "Chapter generation failed."),
        "partial_length": int(partial_length or 0),
    }


def _stream_done_event(result: ChapterGenerationResult) -> dict[str, Any]:
    event: dict[str, Any] = {
        "type": "done",
        "ok": True,
        "chapter_number": result.chapter_number,
        "title": result.title,
        "chapter_file": Path(result.chapter_path).name if result.chapter_path else "",
        "summary_file": Path(result.summary_path).name if result.summary_path else "",
        "index_file": Path(result.index_path).name if result.index_path else "",
        "message": "Chapter generated.",
    }
    if result.summary_error:
        event["summary_error"] = result.summary_error
    if result.consistency_warnings:
        event["consistency_warnings"] = list(result.consistency_warnings)
    return event


def generate_single_chapter(
    project_ref: str,
    chapter_number: int,
    project_config: dict[str, Any],
    task_models: dict[str, str],
    temperature: float,
    max_tokens: int,
    use_previous_context: bool,
    narrative_context_text: str | None = None,
) -> ChapterGenerationResult:
    valid, number, ref, validation_message = _validate_chapter_request(project_ref, chapter_number, task_models)
    if not valid:
        return _chapter_failure(number, validation_message, task_models)

    chapter_model = _model(task_models, "chapter")

    try:
        messages, notices = build_generation_messages(
            project_ref=ref,
            mode=CHAPTER_MODE,
            project_config=project_config,
            chapter_number=number,
            use_previous_context=use_previous_context,
            narrative_context_text=narrative_context_text,
        )
        chapter_content = generate_text(
            messages=messages,
            model=chapter_model,
            temperature=temperature,
            max_tokens=int(max_tokens),
        )
        ai_run_metadata = _chapter_ai_run_metadata(
            messages,
            temperature,
            max_tokens,
            use_previous_context,
            narrative_context_text,
        )
    except DeepSeekClientError as exc:
        return _chapter_failure(number, str(exc), task_models)
    except Exception as exc:
        return _chapter_failure(number, f"Chapter generation failed: {exc}", task_models)

    return _finalize_generated_chapter(
        ref,
        number,
        chapter_content,
        task_models,
        notices,
        ai_run_metadata,
        narrative_context_text,
    )


def stream_generate_single_chapter(
    project_ref: str,
    chapter_number: int,
    project_config: dict[str, Any],
    task_models: dict[str, str],
    temperature: float,
    max_tokens: int,
    use_previous_context: bool,
    narrative_context_text: str | None = None,
) -> Iterator[dict[str, Any]]:
    valid, number, ref, validation_message = _validate_chapter_request(project_ref, chapter_number, task_models)
    if not valid:
        yield _stream_error_event(validation_message, number, code="invalid_request")
        return

    chapter_model = _model(task_models, "chapter")
    chunks: list[str] = []

    try:
        messages, notices = build_generation_messages(
            project_ref=ref,
            mode=CHAPTER_MODE,
            project_config=project_config,
            chapter_number=number,
            use_previous_context=use_previous_context,
            narrative_context_text=narrative_context_text,
        )
        for delta in stream_generate_text(
            messages=messages,
            model=chapter_model,
            temperature=temperature,
            max_tokens=int(max_tokens),
        ):
            chunks.append(delta)
            yield {"type": "delta", "text": delta}
    except DeepSeekClientError as exc:
        yield _stream_error_event(str(exc), number, partial_length=len("".join(chunks)))
        return
    except Exception as exc:
        yield _stream_error_event(f"Chapter generation failed: {exc}", number, partial_length=len("".join(chunks)))
        return

    chapter_content = "".join(chunks).strip()
    if not chapter_content:
        yield _stream_error_event(
            "Model returned empty content. Adjust the prompt or try again later.",
            number,
            partial_length=0,
        )
        return

    ai_run_metadata = _chapter_ai_run_metadata(
        messages,
        temperature,
        max_tokens,
        use_previous_context,
        narrative_context_text,
    )
    result = _finalize_generated_chapter(
        ref,
        number,
        chapter_content,
        task_models,
        notices,
        ai_run_metadata,
        narrative_context_text,
    )
    if not result.ok:
        yield _stream_error_event(result.message, number, partial_length=len(chapter_content))
        return

    yield _stream_done_event(result)
