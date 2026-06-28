from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Path

from api.schemas import ChapterFunctionReviewResponse
from services.chapter_function_review_service import list_chapter_function_reviews


router = APIRouter(prefix="/api/projects/{project_ref}/chapters", tags=["chapter-function-reviews"])
ChapterNumber = Annotated[int, Path(gt=0)]


def _error(status_code: int, code: str, message: str) -> None:
    raise HTTPException(
        status_code=status_code,
        detail={"error": {"code": code, "message": message}},
    )


def _response(result: Any) -> ChapterFunctionReviewResponse:
    if not result.ok:
        _error(result.status_code, result.error_code, result.message)
    return ChapterFunctionReviewResponse(
        ok=True,
        project_ref=result.project_ref,
        chapter_number=result.chapter_number,
        latest=result.latest,
        history=result.history,
        message=result.message,
    )


@router.get("/{chapter_number}/function-review", response_model=ChapterFunctionReviewResponse)
def get_chapter_function_review(
    project_ref: str,
    chapter_number: ChapterNumber,
) -> ChapterFunctionReviewResponse:
    return _response(list_chapter_function_reviews(project_ref, chapter_number))
