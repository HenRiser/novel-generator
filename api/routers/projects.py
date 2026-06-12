from __future__ import annotations

from typing import Annotated, Any
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Path
from fastapi.responses import PlainTextResponse

from api.schemas import (
    ChapterContentResponse,
    ChapterSummaryResponse,
    CreateProjectRequest,
    CreateProjectResponse,
    ProjectDetailResponse,
    ProjectSummaryResponse,
)
from config import PROJECT_ROOT
from services.project_service import create_workspace_project, list_project_summaries, load_project_detail
from services.reader_service import (
    build_full_book_export_payload,
    build_reader_project_snapshot,
    build_single_chapter_export_payload,
    read_chapter_for_display,
)


router = APIRouter(prefix="/api/projects", tags=["projects"])
ChapterNumber = Annotated[int, Path(gt=0)]

SENSITIVE_KEY_PARTS = ("api_key", "apikey", "token", "password", "secret")
PROJECT_ROOT_TEXT = str(PROJECT_ROOT)


def _error(status_code: int, code: str, message: str) -> None:
    raise HTTPException(
        status_code=status_code,
        detail={"error": {"code": code, "message": message}},
    )


def _sanitize_config(value: Any) -> Any:
    if isinstance(value, dict):
        sanitized: dict[str, Any] = {}
        for key, item in value.items():
            lowered_key = str(key).lower()
            if any(part in lowered_key for part in SENSITIVE_KEY_PARTS):
                sanitized[key] = "[redacted]"
            else:
                sanitized[key] = _sanitize_config(item)
        return sanitized

    if isinstance(value, list):
        return [_sanitize_config(item) for item in value]

    if isinstance(value, str) and PROJECT_ROOT_TEXT and PROJECT_ROOT_TEXT in value:
        return value.replace(PROJECT_ROOT_TEXT, "[project_root]")

    return value


def _content_disposition(filename: str, fallback: str) -> str:
    cleaned = str(filename or fallback).replace("\r", "").replace("\n", "").strip()
    cleaned = cleaned or fallback
    return f"attachment; filename*=UTF-8''{quote(cleaned)}"


def _project_summary_response(summary: Any) -> ProjectSummaryResponse:
    return ProjectSummaryResponse(
        project_ref=summary.project_ref,
        title=summary.title,
        storage_type=summary.storage_type,
        updated_at=summary.updated_at,
        description=summary.description,
    )


def _chapter_summary_response(chapter: Any) -> ChapterSummaryResponse:
    return ChapterSummaryResponse(
        chapter_number=chapter.chapter_number,
        title=chapter.title,
        filename=chapter.filename,
        is_version=chapter.is_version,
        version=chapter.version,
        display_label=chapter.display_label,
    )


@router.get("", response_model=list[ProjectSummaryResponse])
def list_projects() -> list[ProjectSummaryResponse]:
    return [_project_summary_response(summary) for summary in list_project_summaries()]


@router.post("", response_model=CreateProjectResponse)
def create_project(request: CreateProjectRequest) -> CreateProjectResponse:
    result = create_workspace_project(
        title=request.title,
        seed_prompt=request.seed_prompt,
        genre=request.genre,
        style=request.style,
        model=request.model,
        max_tokens=request.max_tokens,
        temperature=request.temperature,
    )
    if not result.ok:
        _error(400, "project_create_invalid", result.message or "Project creation failed.")

    return CreateProjectResponse(
        ok=True,
        project_ref=result.project_ref,
        title=result.title,
        message=result.message,
    )


@router.get("/{project_ref}", response_model=ProjectDetailResponse)
def get_project(project_ref: str) -> ProjectDetailResponse:
    result = load_project_detail(project_ref)
    if not result.ok:
        if result.error:
            _error(404, "project_not_found", "Project not found or unreadable.")
        _error(404, "project_config_not_found", "Project config was not found.")

    return ProjectDetailResponse(
        project_ref=result.project_ref,
        title=result.title,
        config=_sanitize_config(result.config or {}),
    )


@router.get("/{project_ref}/chapters", response_model=list[ChapterSummaryResponse])
def list_chapters(project_ref: str) -> list[ChapterSummaryResponse]:
    snapshot = build_reader_project_snapshot(project_ref)
    if not snapshot.ok:
        _error(404, "project_not_found", "Project not found or unreadable.")

    return [_chapter_summary_response(chapter) for chapter in snapshot.chapters]


@router.get("/{project_ref}/chapters/{chapter_number}", response_model=ChapterContentResponse)
def get_chapter(project_ref: str, chapter_number: ChapterNumber) -> ChapterContentResponse:
    chapter = read_chapter_for_display(project_ref, chapter_number)
    if not chapter.ok:
        _error(404, "chapter_not_found", "Chapter not found.")

    return ChapterContentResponse(
        chapter_number=chapter.chapter_number,
        title=chapter.title,
        filename=chapter.filename,
        content=chapter.content,
    )


@router.get("/{project_ref}/exports/full.txt", response_class=PlainTextResponse)
def export_full_book(project_ref: str) -> PlainTextResponse:
    payload = build_full_book_export_payload(project_ref)
    if not payload.ok:
        _error(404, "export_not_available", "No exportable chapter content was found.")

    return PlainTextResponse(
        payload.content,
        headers={
            "Content-Disposition": _content_disposition(payload.filename, "novel.txt"),
        },
    )


@router.get("/{project_ref}/exports/chapters/{chapter_number}.txt", response_class=PlainTextResponse)
def export_chapter(project_ref: str, chapter_number: ChapterNumber) -> PlainTextResponse:
    payload = build_single_chapter_export_payload(project_ref, chapter_number)
    if not payload.ok:
        _error(404, "chapter_not_found", "Chapter not found.")

    return PlainTextResponse(
        payload.content,
        headers={
            "Content-Disposition": _content_disposition(
                payload.filename,
                f"chapter_{chapter_number:03d}.txt",
            ),
        },
    )
