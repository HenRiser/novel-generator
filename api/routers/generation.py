from __future__ import annotations

import json
from pathlib import Path as FilePath
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Path
from fastapi.responses import StreamingResponse

from api.generation_state import (
    complete_generation_task,
    fail_generation_task,
    get_generation_status,
    start_generation_task,
)
from api.schemas import GenerateChapterRequest, GenerateOutlineCharactersRequest
from config import PROJECT_ROOT
from config_manager import get_current_default_model, has_api_key
from file_manager import read_latest_characters, read_latest_outline
from generation_config import setting_options_to_dict
from services.generation_service import (
    generate_outline_and_characters,
    generate_single_chapter,
    stream_generate_single_chapter,
)
from services.project_service import load_project_detail, validate_outline_character_ready


router = APIRouter(prefix="/api", tags=["generation"])
ChapterNumber = Annotated[int, Path(gt=0)]

DEFAULT_TEMPERATURE = 0.7
DEFAULT_MAX_TOKENS = 4000
TASK_MODEL_KEYS = ("outline", "character", "chapter", "chapter_title", "summary")
PROJECT_ROOT_TEXT = str(PROJECT_ROOT)


def _error(status_code: int, code: str, message: str) -> None:
    raise HTTPException(
        status_code=status_code,
        detail={"error": {"code": code, "message": message}},
    )


def public_file_name(path_or_name: str) -> str:
    value = str(path_or_name or "").strip()
    return FilePath(value.replace("\\", "/")).name if value else ""


def public_message(message: str) -> str:
    text = str(message or "")
    if PROJECT_ROOT_TEXT and PROJECT_ROOT_TEXT in text:
        text = text.replace(PROJECT_ROOT_TEXT, "[project_root]")
    normalized_root = PROJECT_ROOT_TEXT.replace("\\", "/")
    if normalized_root and normalized_root in text:
        text = text.replace(normalized_root, "[project_root]")
    return text


def _request_model(model: str | None) -> str:
    return str(model or "").strip() or get_current_default_model()


def _request_max_tokens(max_tokens: int | None) -> int:
    return int(max_tokens or DEFAULT_MAX_TOKENS)


def _request_temperature(temperature: float | None) -> float:
    return float(DEFAULT_TEMPERATURE if temperature is None else temperature)


def _task_models(model: str) -> dict[str, str]:
    return {key: model for key in TASK_MODEL_KEYS}


def _load_project_config_or_error(project_ref: str) -> dict[str, Any]:
    detail = load_project_detail(project_ref)
    if not detail.ok:
        _error(404, "project_not_found", "Project not found or unreadable.")

    config = detail.config if isinstance(detail.config, dict) else None
    if config is None:
        _error(400, "project_config_missing", "Project config was not found.")

    return dict(config)


def _ensure_model_configured() -> None:
    if not has_api_key():
        _error(
            400,
            "model_config_missing",
            "Model config is missing. Configure the API key in the local settings panel or environment config before generation.",
        )


def _ensure_outline_character_ready(project_config: dict[str, Any]) -> None:
    validation = validate_outline_character_ready(project_config)
    if not validation.ok:
        _error(400, "project_config_incomplete", validation.message or "Project config is incomplete.")


def _ensure_chapter_assets_ready(project_ref: str) -> None:
    _, outline_path = read_latest_outline(project_ref)
    _, characters_path = read_latest_characters(project_ref)
    if not outline_path or not characters_path:
        _error(
            400,
            "setting_assets_missing",
            "Outline and characters are missing. Generate outline and characters before chapter generation.",
        )


def _with_optional_writing_mode(project_config: dict[str, Any], writing_mode: str | None) -> dict[str, Any]:
    mode = str(writing_mode or "").strip()
    if not mode:
        return project_config

    updated = dict(project_config)
    raw_options = updated.get("setting_generation_options")
    options = setting_options_to_dict(raw_options if isinstance(raw_options, dict) else {})
    options["writing_mode"] = mode
    updated["setting_generation_options"] = options
    return updated


def _outline_response(result: Any) -> dict[str, Any]:
    return {
        "ok": True,
        "outline_file": public_file_name(result.outline_path),
        "characters_file": public_file_name(result.characters_path),
        "message": "Outline and characters generated.",
    }


def _chapter_response(result: Any) -> dict[str, Any]:
    response = {
        "ok": True,
        "chapter_number": result.chapter_number,
        "title": result.title,
        "chapter_file": public_file_name(result.chapter_path),
        "summary_file": public_file_name(result.summary_path),
        "index_file": public_file_name(result.index_path),
        "message": "Chapter generated.",
    }
    if result.summary_error:
        response["summary_error"] = public_message(result.summary_error)
    return response


def _json_line(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"


def _public_stream_event(event: dict[str, Any]) -> dict[str, Any]:
    event_type = str(event.get("type") or "")
    if event_type == "delta":
        return {
            "type": "delta",
            "text": str(event.get("text") or ""),
        }

    if event_type == "done":
        response = {
            "type": "done",
            "ok": True,
            "chapter_number": int(event.get("chapter_number") or 0),
            "title": str(event.get("title") or ""),
            "chapter_file": public_file_name(str(event.get("chapter_file") or event.get("chapter_path") or "")),
            "summary_file": public_file_name(str(event.get("summary_file") or event.get("summary_path") or "")),
            "index_file": public_file_name(str(event.get("index_file") or event.get("index_path") or "")),
            "message": public_message(str(event.get("message") or "Chapter generated.")),
        }
        if event.get("summary_error"):
            response["summary_error"] = public_message(str(event["summary_error"]))
        return response

    message = public_message(str(event.get("message") or "Chapter generation failed."))
    return {
        "type": "error",
        "ok": False,
        "code": str(event.get("code") or "generation_failed"),
        "chapter_number": int(event.get("chapter_number") or 0),
        "message": message,
        "partial_length": int(event.get("partial_length") or 0),
    }


def _generation_state_payload(event: dict[str, Any]) -> dict[str, Any]:
    if event.get("type") == "done":
        payload = dict(event)
        payload.pop("type", None)
        return payload

    return {
        "ok": False,
        "chapter_number": int(event.get("chapter_number") or 0),
        "message": public_message(str(event.get("message") or "")),
        "partial_length": int(event.get("partial_length") or 0),
    }


@router.get("/generation/status")
def generation_status() -> dict[str, Any]:
    return get_generation_status()


@router.post("/projects/{project_ref}/outline-characters/generate")
def generate_project_outline_characters(
    project_ref: str,
    payload: GenerateOutlineCharactersRequest | None = None,
) -> dict[str, Any]:
    payload = payload or GenerateOutlineCharactersRequest()
    project_config = _load_project_config_or_error(project_ref)
    _ensure_outline_character_ready(project_config)
    _ensure_model_configured()

    if not start_generation_task("outline_characters", project_ref, "outline-characters"):
        _error(409, "generation_running", "Another API generation task is already running.")

    try:
        result = generate_outline_and_characters(
            project_ref=project_ref,
            project_config=project_config,
            task_models=_task_models(_request_model(payload.model)),
            temperature=_request_temperature(payload.temperature),
            max_tokens=_request_max_tokens(payload.max_tokens),
        )
        if not result.ok:
            message = public_message(result.message)
            failure = {"ok": False, "message": message}
            fail_generation_task(message, failure)
            _error(500, "generation_failed", message or "Outline and character generation failed.")

        response = _outline_response(result)
        complete_generation_task(response)
        return response
    except HTTPException:
        raise
    except Exception as exc:
        message = public_message(str(exc) or "Outline and character generation failed.")
        fail_generation_task(message)
        _error(500, "generation_failed", message)


@router.post("/projects/{project_ref}/chapters/{chapter_number}/generate")
def generate_project_chapter(
    project_ref: str,
    chapter_number: ChapterNumber,
    payload: GenerateChapterRequest | None = None,
) -> dict[str, Any]:
    payload = payload or GenerateChapterRequest()
    project_config = _load_project_config_or_error(project_ref)
    _ensure_outline_character_ready(project_config)
    _ensure_chapter_assets_ready(project_ref)
    _ensure_model_configured()
    project_config = _with_optional_writing_mode(project_config, payload.writing_mode)

    if not start_generation_task("chapter", project_ref, f"chapter_{chapter_number:03d}"):
        _error(409, "generation_running", "Another API generation task is already running.")

    try:
        result = generate_single_chapter(
            project_ref=project_ref,
            chapter_number=chapter_number,
            project_config=project_config,
            task_models=_task_models(_request_model(payload.model)),
            temperature=_request_temperature(payload.temperature),
            max_tokens=_request_max_tokens(payload.max_tokens),
            use_previous_context=True,
        )
        if not result.ok:
            message = public_message(result.message)
            failure = {
                "ok": False,
                "chapter_number": chapter_number,
                "message": message,
            }
            fail_generation_task(message, failure)
            _error(500, "generation_failed", message or "Chapter generation failed.")

        response = _chapter_response(result)
        complete_generation_task(response)
        return response
    except HTTPException:
        raise
    except Exception as exc:
        message = public_message(str(exc) or "Chapter generation failed.")
        fail_generation_task(message)
        _error(500, "generation_failed", message)


@router.post("/projects/{project_ref}/chapters/{chapter_number}/generate/stream")
def generate_project_chapter_stream(
    project_ref: str,
    chapter_number: ChapterNumber,
    payload: GenerateChapterRequest | None = None,
) -> StreamingResponse:
    payload = payload or GenerateChapterRequest()
    project_config = _load_project_config_or_error(project_ref)
    _ensure_outline_character_ready(project_config)
    _ensure_chapter_assets_ready(project_ref)
    _ensure_model_configured()
    project_config = _with_optional_writing_mode(project_config, payload.writing_mode)

    if not start_generation_task("chapter_stream", project_ref, f"chapter_{chapter_number:03d}"):
        _error(409, "generation_running", "Another API generation task is already running.")

    task_models = _task_models(_request_model(payload.model))
    max_tokens = _request_max_tokens(payload.max_tokens)
    temperature = _request_temperature(payload.temperature)

    def stream_events():
        terminal_event_seen = False
        partial_length = 0
        try:
            for event in stream_generate_single_chapter(
                project_ref=project_ref,
                chapter_number=chapter_number,
                project_config=project_config,
                task_models=task_models,
                temperature=temperature,
                max_tokens=max_tokens,
                use_previous_context=True,
            ):
                public_event = _public_stream_event(event)
                if public_event["type"] == "delta":
                    partial_length += len(str(public_event.get("text") or ""))
                elif public_event["type"] == "done":
                    terminal_event_seen = True
                    complete_generation_task(_generation_state_payload(public_event))
                elif public_event["type"] == "error":
                    terminal_event_seen = True
                    fail_generation_task(
                        str(public_event.get("message") or "Chapter generation failed."),
                        _generation_state_payload(public_event),
                    )
                yield _json_line(public_event)

            if not terminal_event_seen:
                message = "Chapter streaming ended before completion."
                error_event = {
                    "type": "error",
                    "ok": False,
                    "code": "generation_failed",
                    "chapter_number": chapter_number,
                    "message": message,
                    "partial_length": partial_length,
                }
                fail_generation_task(message, _generation_state_payload(error_event))
                yield _json_line(error_event)
        except GeneratorExit:
            if not terminal_event_seen:
                message = "Chapter streaming request was interrupted by the client."
                fail_generation_task(
                    message,
                    {
                        "ok": False,
                        "chapter_number": chapter_number,
                        "message": message,
                        "partial_length": partial_length,
                    },
                )
            raise
        except Exception as exc:
            message = public_message(str(exc) or "Chapter streaming failed.")
            error_event = {
                "type": "error",
                "ok": False,
                "code": "generation_failed",
                "chapter_number": chapter_number,
                "message": message,
                "partial_length": partial_length,
            }
            fail_generation_task(message, _generation_state_payload(error_event))
            yield _json_line(error_event)

    return StreamingResponse(
        stream_events(),
        media_type="application/x-ndjson; charset=utf-8",
    )
