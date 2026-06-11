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
    build_outline_prompt,
    build_summary_prompt,
)

from .chapter_service import extract_chapter_title
from .schemas import ChapterGenerationResult, OutlineCharacterGenerationResult


OUTLINE_MODE = "outline"
CHARACTER_MODE = "character"
CHAPTER_MODE = "chapter"
UNTITLED_CHAPTER = "Untitled chapter"


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


def build_generation_messages(
    project_ref: str,
    mode: str,
    project_config: dict[str, Any],
    chapter_number: int,
    use_previous_context: bool,
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
    return messages, notices


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
    return event


def generate_single_chapter(
    project_ref: str,
    chapter_number: int,
    project_config: dict[str, Any],
    task_models: dict[str, str],
    temperature: float,
    max_tokens: int,
    use_previous_context: bool,
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
        )
        chapter_content = generate_text(
            messages=messages,
            model=chapter_model,
            temperature=temperature,
            max_tokens=int(max_tokens),
        )
    except DeepSeekClientError as exc:
        return _chapter_failure(number, str(exc), task_models)
    except Exception as exc:
        return _chapter_failure(number, f"Chapter generation failed: {exc}", task_models)

    return _finalize_generated_chapter(ref, number, chapter_content, task_models, notices)


def stream_generate_single_chapter(
    project_ref: str,
    chapter_number: int,
    project_config: dict[str, Any],
    task_models: dict[str, str],
    temperature: float,
    max_tokens: int,
    use_previous_context: bool,
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

    result = _finalize_generated_chapter(ref, number, chapter_content, task_models, notices)
    if not result.ok:
        yield _stream_error_event(result.message, number, partial_length=len(chapter_content))
        return

    yield _stream_done_event(result)
