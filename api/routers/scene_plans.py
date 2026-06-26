from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Path

from api.schemas import ScenePlanApproveRequest, ScenePlanDraftRequest, ScenePlanResponse
from services.scene_plan_service import (
    approve_scene_plan,
    get_scene_plans,
    save_scene_plan_draft,
)


router = APIRouter(prefix="/api/projects/{project_ref}/scene-plans", tags=["scene-plans"])
ChapterNumber = Annotated[int, Path(gt=0)]


def _error(status_code: int, code: str, message: str) -> None:
    raise HTTPException(
        status_code=status_code,
        detail={"error": {"code": code, "message": message}},
    )


def _response(result: Any) -> ScenePlanResponse:
    if not result.ok:
        _error(result.status_code, result.error_code, result.message)
    return ScenePlanResponse(
        ok=True,
        project_ref=result.project_ref,
        chapter_number=result.chapter_number,
        plan=result.plan,
        approved=result.approved,
        latest_draft=result.latest_draft,
        history=result.history,
        current_approved_chapter_task=result.current_approved_chapter_task,
        message=result.message,
    )


@router.get("/{chapter_number}", response_model=ScenePlanResponse)
def get_scene_plan(
    project_ref: str,
    chapter_number: ChapterNumber,
) -> ScenePlanResponse:
    return _response(get_scene_plans(project_ref, chapter_number))


@router.post("/{chapter_number}", response_model=ScenePlanResponse)
def save_scene_plan(
    project_ref: str,
    chapter_number: ChapterNumber,
    request: ScenePlanDraftRequest,
) -> ScenePlanResponse:
    return _response(
        save_scene_plan_draft(
            project_ref,
            chapter_number,
            request.model_dump(exclude_unset=True),
        )
    )


@router.post("/{chapter_number}/approve", response_model=ScenePlanResponse)
def approve_scene_plan_draft(
    project_ref: str,
    chapter_number: ChapterNumber,
    request: ScenePlanApproveRequest,
) -> ScenePlanResponse:
    return _response(
        approve_scene_plan(
            project_ref,
            chapter_number,
            scene_plan_id=request.scene_plan_id,
            revision=request.revision,
        )
    )
