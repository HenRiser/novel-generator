from __future__ import annotations

import secrets
from threading import Lock
from typing import Any

from api.generation_state import complete_generation_task, fail_generation_task, start_generation_task
from file_manager import find_latest_chapter, resolve_project_context
from services.chapter_service import plan_batch_chapters
from services.chapter_task_service import resolve_approved_chapter_task
from services.chapter_workflow_service import (
    WorkflowError, confirm_chapter, ensure_chapter_editable, get_chapter_workflow,
    prepare_next_chapter, project_workflow_lock, run_confirmed_chapter_tasks,
)
from services.common import read_json, timestamp, write_json_atomic
from services.context_pack_service import build_context_pack
from services.generation_service import generate_single_chapter
from services.project_service import load_project_detail
from services.scene_plan_service import get_scene_plans, resolve_approved_scene_plan


MAX_BATCH_CHAPTERS = 10
_active_jobs: set[tuple[str, str]] = set()
_executing_jobs: set[tuple[str, str]] = set()
_worker_lock = Lock()


def _state_path(project_ref: str):
    try:
        ctx = resolve_project_context(project_ref)
        if not ctx.project_dir.is_dir():
            raise FileNotFoundError
    except (ValueError, FileNotFoundError):
        raise WorkflowError("项目不存在。", "project_not_found", 404)
    return ctx.project_dir / "logs" / "batch_generation.json"


def _idle() -> dict[str, Any]:
    return {"id": "", "status": "idle", "start_chapter": 0, "end_chapter": 0,
            "current_chapter": None, "completed_chapters": [], "message": "",
            "error": "", "stage": ""}


def _read(project_ref: str) -> dict[str, Any]:
    path = _state_path(project_ref)
    return read_json(path) if path.exists() else _idle()


def _write(project_ref: str, state: dict[str, Any]) -> None:
    state["updated_at"] = timestamp()
    write_json_atomic(_state_path(project_ref), state)


def _public(state: dict[str, Any]) -> dict[str, Any]:
    return {key: state.get(key, default) for key, default in _idle().items()}


def get_batch_generation_status(project_ref: str) -> dict[str, Any]:
    with project_workflow_lock(project_ref):
        state = _read(project_ref)
        if state["status"] in {"running", "stopping"} and (project_ref, state["id"]) not in _active_jobs:
            state.update(status="failed", stage="interrupted", error="服务已重启，连续生成已中断。已保存的章节仍保留，请检查后继续。")
            _write(project_ref, state)
        return _public(state)


def start_batch_generation(
    project_ref: str, start_chapter: int, end_chapter: int,
    model: str, temperature: float = 0.7, max_tokens: int = 16384,
) -> dict[str, Any]:
    with project_workflow_lock(project_ref):
        _state_path(project_ref)
        latest, _ = find_latest_chapter(project_ref)
        plan = plan_batch_chapters(latest, start_chapter, end_chapter, MAX_BATCH_CHAPTERS)
        if not plan.ok:
            raise WorkflowError(plan.message, "batch_invalid", 400)
        if not start_generation_task("batch", project_ref, f"chapters_{start_chapter}_{end_chapter}"):
            raise WorkflowError("已有正文生成任务正在运行。", "generation_running", 409)
        job_id = secrets.token_hex(12)
        try:
            # Validate before accepting, and freeze the already-used preceding prose.
            ensure_chapter_editable(project_ref, start_chapter)
            prepare_next_chapter(project_ref, start_chapter)
            state = {**_idle(), "id": job_id, "status": "running", "stage": "queued",
                     "start_chapter": start_chapter, "end_chapter": end_chapter,
                     "model": model, "temperature": temperature, "max_tokens": max_tokens,
                     "message": "连续生成已开始，每章完成摘要后再推进。", "stop_requested": False}
            _active_jobs.add((project_ref, job_id))
            _write(project_ref, state)
            return _public(state)
        except Exception:
            _active_jobs.discard((project_ref, job_id))
            fail_generation_task("连续生成未能启动。")
            raise


def request_batch_stop(project_ref: str) -> dict[str, Any]:
    with project_workflow_lock(project_ref):
        state = _read(project_ref)
        if state["status"] in {"running", "stopping"}:
            state.update(status="stopping", stop_requested=True, message="将在当前章节及摘要完成后停止。")
            _write(project_ref, state)
        return _public(state)


def _chapter_inputs(project_ref: str, chapter_number: int) -> dict[str, Any]:
    if not project_ref.startswith("book:"):
        return {}
    task = resolve_approved_chapter_task(project_ref, chapter_number)
    if not task.ok:
        raise WorkflowError(task.message, task.error_code, task.status_code)
    plans = get_scene_plans(project_ref, chapter_number)
    if not plans.ok:
        raise WorkflowError(plans.message, plans.error_code, plans.status_code)
    approved = plans.approved
    plan = None
    if approved:
        plan = resolve_approved_scene_plan(
            project_ref, chapter_number, scene_plan_id=approved["id"],
            chapter_task=task.task, require_task_binding=bool(task.task),
        )
        if not plan.ok:
            raise WorkflowError(plan.message, plan.error_code, plan.status_code)
    context = build_context_pack(project_ref, {"chapter_number": chapter_number})
    if not context.ok:
        raise WorkflowError(context.message, "context_pack_failed", 400)
    return {"narrative_context_text": context.prompt_text,
            "chapter_task": task.task, "allowed_scene_contract": task.contract,
            "chapter_task_relative_path": task.relative_path,
            "scene_plan": plan.plan if plan else None,
            "scene_plan_relative_path": plan.relative_path if plan else None}


def run_batch_generation(project_ref: str, job_id: str) -> None:
    key = (project_ref, job_id)
    # Claim without reading project files: even a deleted project must release its reservation.
    with _worker_lock:
        if key not in _active_jobs or key in _executing_jobs:
            return
        _executing_jobs.add(key)
    state = {**_idle(), "id": job_id}
    try:
        with project_workflow_lock(project_ref):
            state = _read(project_ref)
            if state["id"] != job_id:
                raise WorkflowError("连续生成任务记录已变更，任务已停止。", "batch_state_changed")
        detail = load_project_detail(project_ref)
        if not detail.ok or not isinstance(detail.config, dict):
            raise WorkflowError("无法读取项目设定。", "project_config_missing", 400)
        for number in range(state["start_chapter"], state["end_chapter"] + 1):
            with project_workflow_lock(project_ref):
                state = _read(project_ref)
                if state.get("stop_requested"):
                    state.update(status="stopped", stage="stopped", message="已在章节边界停止，已完成内容保留。")
                    _write(project_ref, state)
                    complete_generation_task(_public(state))
                    return
                inputs = _chapter_inputs(project_ref, number)
                ensure_chapter_editable(project_ref, number)
                prepare_next_chapter(project_ref, number)
                state.update(current_chapter=number, stage="generating", message=f"正在生成第 {number} 章正文。")
                _write(project_ref, state)
            result = generate_single_chapter(
                project_ref=project_ref, chapter_number=number, project_config=detail.config,
                task_models={name: state["model"] for name in ("chapter", "summary")},
                temperature=state["temperature"], max_tokens=state["max_tokens"],
                use_previous_context=True, defer_summary=True, **inputs,
            )
            if not result.ok:
                # Provider errors can include credentials or local paths. Keep the public error bounded.
                raise WorkflowError(f"第 {number} 章正文生成失败，已停止。请检查模型配置后重试。", "generation_failed", 500)
            with project_workflow_lock(project_ref):
                state = _read(project_ref)
                state.update(stage="summarizing", message=f"第 {number} 章正文已保存，正在生成摘要。")
                _write(project_ref, state)
                workflow = get_chapter_workflow(project_ref, number)
                confirmed = confirm_chapter(project_ref, number, workflow["content"], workflow["revision"])
            run_confirmed_chapter_tasks(project_ref, number, confirmed["revision"])
            with project_workflow_lock(project_ref):
                workflow = get_chapter_workflow(project_ref, number)
                if workflow["summary_status"] != "ready":
                    raise WorkflowError(f"第 {number} 章摘要未完成，连续生成已停止。请在手稿中重试摘要。", "summary_failed", 409)
                state = _read(project_ref)
                state["completed_chapters"].append(number)
                _write(project_ref, state)
        with project_workflow_lock(project_ref):
            state = _read(project_ref)
            state.update(status="completed", stage="completed", message="连续生成已完成。最后一章仍可修改，前章已锁定。")
            _write(project_ref, state)
        complete_generation_task(_public(state))
    except Exception as exc:
        message = exc.message if isinstance(exc, WorkflowError) else "连续生成意外中断，已保存的章节保留。"
        failure = dict(status="failed", stage="failed", error=message, message="连续生成已停止。")
        state.update(failure)
        try:
            with project_workflow_lock(project_ref):
                persisted = _read(project_ref)
                if persisted["id"] == job_id:
                    persisted.update(failure)
                    _write(project_ref, persisted)
                    state = persisted
        except Exception:
            # Disk failure must not leave all future generation blocked by this job.
            pass
        fail_generation_task(message, _public(state))
    finally:
        with _worker_lock:
            _active_jobs.discard(key)
            _executing_jobs.discard(key)
