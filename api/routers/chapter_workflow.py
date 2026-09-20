from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, HTTPException, Path
from pydantic import BaseModel, Field

from api.generation_state import get_generation_status
from api.routers.generation import (
    _ensure_chapter_assets_ready, _ensure_model_configured,
    _ensure_outline_character_ready, _load_project_config_or_error,
    _request_max_tokens, _request_model, _request_temperature,
)
from services.batch_generation_service import (
    get_batch_generation_status, request_batch_stop, run_batch_generation,
    start_batch_generation,
)
from services.chapter_workflow_service import (
    WorkflowError, chapter_generation_blockers, confirm_chapter, get_chapter_workflow,
    project_workflow_lock, run_confirmed_chapter_tasks,
)


router = APIRouter(prefix="/api/projects", tags=["chapter-workflow"])
ChapterNumber = Annotated[int, Path(gt=0)]


class ConfirmChapterRequest(BaseModel):
    content: str = Field(min_length=1, max_length=120000)
    expected_revision: str = Field(min_length=1, max_length=200)


class BatchGenerationRequest(BaseModel):
    start_chapter: int = Field(ge=1)
    end_chapter: int = Field(ge=1)
    model: str | None = None
    temperature: float | None = Field(default=None, ge=0, le=2)
    max_tokens: int | None = Field(default=None, ge=512, le=32768)


def ensure_project_not_generating(project_ref: str) -> None:
    active = get_generation_status()
    if active["running"] and active["project_ref"] == project_ref:
        raise WorkflowError("本项目正在生成正文，请等待当前任务结束后再修改。", "generation_running", 409)


@router.get("/{project_ref}/chapters/{chapter_number}/workflow")
def chapter_workflow(project_ref: str, chapter_number: ChapterNumber):
    state = get_chapter_workflow(project_ref, chapter_number)
    active = get_generation_status()
    if active["running"] and active["project_ref"] == project_ref:
        state["editable"] = False
        if not state["lock_reason"]:
            state["lock_reason"] = "本项目正在生成正文，暂时不能修改。"
    return state


@router.get("/{project_ref}/chapters/{chapter_number}/generation-readiness")
def chapter_generation_readiness(project_ref: str, chapter_number: ChapterNumber):
    config = _load_project_config_or_error(project_ref)
    blockers = []
    active = get_generation_status()
    if active["running"]:
        owner = "当前项目" if active["project_ref"] == project_ref else "其他项目"
        blockers.append({"code": "generation_running", "message": f"{owner}已有生成任务运行，请等待该任务结束。", "action": "wait"})
    checks = (
        (lambda: _ensure_outline_character_ready(config), "project_config_incomplete", "小说设定尚未补全。请先补全设定后生成大纲与人物卡。", "project_settings"),
        (lambda: _ensure_chapter_assets_ready(project_ref), "setting_assets_missing", "还缺少大纲或人物卡，生成后即可开始正文。", "generate_assets"),
        (_ensure_model_configured, "model_config_missing", "尚未配置模型连接，请先在偏好设置中完成配置。", "model_settings"),
    )
    for check, code, message, action in checks:
        try:
            check()
        except HTTPException as exc:
            detail = exc.detail if isinstance(exc.detail, dict) else {}
            if detail.get("error", {}).get("code") != code:
                raise
            if code == "project_config_incomplete":
                message = detail["error"].get("message") or message
            blockers.append({"code": code, "message": message, "action": action})
    blockers.extend(chapter_generation_blockers(project_ref, chapter_number))
    return {
        "project_ref": project_ref, "chapter_number": chapter_number,
        "ready": not blockers, "blockers": blockers,
        "can_generate_assets": not any(item["code"] in {"generation_running", "project_config_incomplete", "model_config_missing"} for item in blockers),
    }


@router.post("/{project_ref}/chapters/{chapter_number}/confirm", status_code=202)
def confirm_project_chapter(
    project_ref: str, chapter_number: ChapterNumber,
    payload: ConfirmChapterRequest, background_tasks: BackgroundTasks,
):
    with project_workflow_lock(project_ref):
        ensure_project_not_generating(project_ref)
        _ensure_model_configured()
        state = confirm_chapter(project_ref, chapter_number, payload.content, payload.expected_revision)
        if state["summary_status"] == "pending":
            background_tasks.add_task(run_confirmed_chapter_tasks, project_ref, chapter_number, state["revision"])
        return state


@router.get("/{project_ref}/generation/batch")
def batch_generation_status(project_ref: str):
    return get_batch_generation_status(project_ref)


@router.post("/{project_ref}/generation/batch", status_code=202)
def generate_batch(
    project_ref: str, payload: BatchGenerationRequest, background_tasks: BackgroundTasks,
):
    config = _load_project_config_or_error(project_ref)
    _ensure_outline_character_ready(config)
    _ensure_chapter_assets_ready(project_ref)
    _ensure_model_configured()
    state = start_batch_generation(
        project_ref, payload.start_chapter, payload.end_chapter,
        _request_model(payload.model), _request_temperature(payload.temperature),
        _request_max_tokens(payload.max_tokens),
    )
    background_tasks.add_task(run_batch_generation, project_ref, state["id"])
    return state


@router.post("/{project_ref}/generation/batch/stop")
def stop_batch_generation(project_ref: str):
    return request_batch_stop(project_ref)
