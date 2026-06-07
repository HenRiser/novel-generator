from __future__ import annotations

from dataclasses import asdict, dataclass
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
