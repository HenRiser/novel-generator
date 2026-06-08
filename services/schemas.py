from __future__ import annotations

from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class ValidationResult:
    ok: bool
    message: str = ""


@dataclass(frozen=True)
class SettingExpansionResult:
    title_candidates: list[str]
    recommended_title: str
    protagonist_setting: str
    supporting_characters_setting: str
    world_setting: str
    core_conflict: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class BatchPlanResult:
    ok: bool
    chapter_numbers: list[int]
    message: str = ""


@dataclass(frozen=True)
class ProjectSummary:
    project_ref: str
    title: str
    storage_type: str
    updated_at: str = ""
    description: str = ""


@dataclass(frozen=True)
class ProjectLoadResult:
    ok: bool
    project_ref: str = ""
    title: str = ""
    config: dict[str, Any] | None = None
    project_dir: Path | None = None
    message: str = ""
    error: bool = False


@dataclass(frozen=True)
class ProjectSaveResult:
    ok: bool
    project_ref: str = ""
    path: Path | None = None
    result_paths: list[Path] = field(default_factory=list)
    message: str = ""


@dataclass(frozen=True)
class ProjectDirectoryResult:
    ok: bool
    project_ref: str = ""
    title: str = ""
    storage_type: str = ""
    path: Path | None = None
    message: str = ""
