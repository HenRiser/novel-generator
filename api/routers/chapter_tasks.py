from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Path

from api.schemas import ChapterTaskApproveRequest, ChapterTaskDraftRequest, ChapterTaskResponse
from services.chapter_task_service import (
    approve_chapter_task,
    get_chapter_tasks,
    save_chapter_task_draft,
)


router = APIRouter(prefix="/api/projects/{project_ref}/chapter-tasks", tags=["chapter-tasks"])
ChapterNumber = Annotated[int, Path(gt=0)]


def _error(status_code: int, code: str, message: str) -> None:
    raise HTTPException(
        status_code=status_code,
        detail={"error": {"code": code, "message": message}},
    )


def _response(result: Any) -> ChapterTaskResponse:
    if not result.ok:
        _error(result.status_code, result.error_code, result.message)
    return ChapterTaskResponse(
        ok=True,
        project_ref=result.project_ref,
        chapter_number=result.chapter_number,
        task=result.task,
        approved=result.approved,
        latest_draft=result.latest_draft,
        history=result.history,
        message=result.message,
    )


@router.get("/{chapter_number}", response_model=ChapterTaskResponse)
def get_chapter_task_sheet(
    project_ref: str,
    chapter_number: ChapterNumber,
) -> ChapterTaskResponse:
    return _response(get_chapter_tasks(project_ref, chapter_number))


@router.post("/{chapter_number}", response_model=ChapterTaskResponse)
def save_chapter_task_sheet_draft(
    project_ref: str,
    chapter_number: ChapterNumber,
    request: ChapterTaskDraftRequest,
) -> ChapterTaskResponse:
    return _response(
        save_chapter_task_draft(
            project_ref,
            chapter_number,
            request.model_dump(exclude_unset=True),
        )
    )


@router.post("/{chapter_number}/approve", response_model=ChapterTaskResponse)
def approve_chapter_task_sheet(
    project_ref: str,
    chapter_number: ChapterNumber,
    request: ChapterTaskApproveRequest,
) -> ChapterTaskResponse:
    return _response(
        approve_chapter_task(
            project_ref,
            chapter_number,
            task_id=request.task_id,
            revision=request.revision,
        )
    )
