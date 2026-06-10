from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime
from threading import Lock
from typing import Any


@dataclass
class ApiGenerationState:
    running: bool = False
    task_type: str = ""
    project_ref: str = ""
    target: str = ""
    started_at: str = ""
    finished_at: str = ""
    last_result: dict[str, Any] | None = None
    last_error: str = ""


_state = ApiGenerationState()
_lock = Lock()


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def get_generation_status() -> dict[str, Any]:
    with _lock:
        return asdict(_state)


def start_generation_task(task_type: str, project_ref: str, target: str) -> bool:
    with _lock:
        if _state.running:
            return False

        _state.running = True
        _state.task_type = str(task_type or "")
        _state.project_ref = str(project_ref or "")
        _state.target = str(target or "")
        _state.started_at = _now_iso()
        _state.finished_at = ""
        _state.last_result = None
        _state.last_error = ""
        return True


def complete_generation_task(result: dict[str, Any] | None = None) -> None:
    with _lock:
        _state.running = False
        _state.finished_at = _now_iso()
        _state.last_result = dict(result or {})
        _state.last_error = ""


def fail_generation_task(message: str, result: dict[str, Any] | None = None) -> None:
    with _lock:
        _state.running = False
        _state.finished_at = _now_iso()
        _state.last_result = dict(result or {}) if result else None
        _state.last_error = str(message or "")
