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
class GenerationResult:
    ok: bool
    content: str = ""
    title: str = ""
    message: str = ""
    output_path: str = ""
    summary_path: str = ""
    index_path: str = ""


@dataclass(frozen=True)
class ChapterGenerationResult:
    ok: bool
    chapter_number: int = 0
    title: str = ""
    content: str = ""
    chapter_path: str = ""
    summary: str = ""
    summary_path: str = ""
    index_path: str = ""
    message: str = ""
    notices: list[str] = field(default_factory=list)
    title_error: str | None = None
    summary_error: str | None = None
    chapter_model: str = ""
    chapter_title_model: str = ""
    summary_model: str = ""

    def to_legacy_dict(self) -> dict[str, Any]:
        return {
            "chapter_number": self.chapter_number,
            "chapter_title": self.title,
            "chapter_model": self.chapter_model,
            "chapter_title_model": self.chapter_title_model,
            "summary_model": self.summary_model,
            "chapter_path": self.chapter_path,
            "summary": self.summary,
            "summary_path": self.summary_path,
            "content": self.content,
            "notices": list(self.notices),
            "title_error": self.title_error,
            "summary_error": self.summary_error,
            "index_path": self.index_path,
            "error": None if self.ok else self.message,
        }


@dataclass(frozen=True)
class OutlineCharacterGenerationResult:
    ok: bool
    outline_path: str = ""
    characters_path: str = ""
    outline_content: str = ""
    characters_content: str = ""
    message: str = ""
    outline_model: str = ""
    characters_model: str = ""


@dataclass(frozen=True)
class BatchChapterItemResult:
    chapter_number: int
    ok: bool
    chapter_path: str = ""
    title: str = ""
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


@dataclass(frozen=True)
class ReaderChapterItem:
    chapter_number: int
    title: str
    filename: str
    path: str
    is_version: bool = False
    version: int = 1
    display_label: str = ""


@dataclass(frozen=True)
class ReaderChapterContent:
    ok: bool
    chapter_number: int = 0
    title: str = ""
    filename: str = ""
    path: str = ""
    content: str = ""
    message: str = ""


@dataclass(frozen=True)
class ExportPayload:
    ok: bool
    filename: str = ""
    content: str = ""
    message: str = ""


@dataclass(frozen=True)
class ReaderProjectSnapshot:
    ok: bool
    project_ref: str = ""
    display_title: str = ""
    chapters: list[ReaderChapterItem] = field(default_factory=list)
    message: str = ""
