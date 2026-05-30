from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from config import OUTPUT_DIR


UNNAMED_PROJECT_TITLE = "未命名小说"
PROJECT_CONFIG_NAME = "project_config.json"
OUTLINE_NAME = "novel_outline.md"
CHARACTERS_NAME = "characters.md"
CHAPTER_INDEX_NAME = "chapter_index.md"
SETTING_EXPANSION_NAME = "setting_expansion_latest.json"


def sanitize_project_title(title: str) -> str:
    safe_title = str(title or "").strip()
    safe_title = re.sub(r'[<>:"/\\|?*]', "_", safe_title)
    safe_title = re.sub(r"\s+", " ", safe_title).strip()
    safe_title = safe_title.strip(" .")

    if not safe_title or safe_title in {".", ".."}:
        safe_title = UNNAMED_PROJECT_TITLE

    safe_title = safe_title[:80].strip(" .")
    if not safe_title or safe_title in {".", ".."}:
        return UNNAMED_PROJECT_TITLE

    return safe_title


@dataclass(frozen=True)
class ProjectContext:
    title: str
    outputs_root: Path
    project_dir: Path
    safe_title: str

    @classmethod
    def from_title(cls, title: str, outputs_root: Path = OUTPUT_DIR) -> "ProjectContext":
        safe_title = sanitize_project_title(title)
        root = Path(outputs_root)
        return cls(
            title=str(title or "").strip(),
            outputs_root=root,
            project_dir=root / safe_title,
            safe_title=safe_title,
        )

    @property
    def sanitized_title(self) -> str:
        return self.safe_title

    @property
    def config_path(self) -> Path:
        return self.project_dir / PROJECT_CONFIG_NAME

    @property
    def chapters_dir(self) -> Path:
        return self.project_dir / "chapters"

    @property
    def summaries_dir(self) -> Path:
        return self.project_dir / "summaries"

    @property
    def exports_dir(self) -> Path:
        return self.project_dir / "exports"

    @property
    def logs_dir(self) -> Path:
        return self.project_dir / "logs"

    @property
    def chapter_index_path(self) -> Path:
        return self.project_dir / CHAPTER_INDEX_NAME

    @property
    def outline_path(self) -> Path:
        return self.project_dir / OUTLINE_NAME

    @property
    def characters_path(self) -> Path:
        return self.project_dir / CHARACTERS_NAME

    @property
    def setting_expansion_path(self) -> Path:
        return self.project_dir / SETTING_EXPANSION_NAME

    def ensure_project_dirs(self) -> None:
        self.outputs_root.mkdir(parents=True, exist_ok=True)
        self.project_dir.mkdir(parents=True, exist_ok=True)
        self.chapters_dir.mkdir(parents=True, exist_ok=True)
        self.summaries_dir.mkdir(parents=True, exist_ok=True)

    def get_chapter_path(self, chapter_number: int, version: int | None = None) -> Path:
        chapter_number = max(1, int(chapter_number))
        suffix = f"_v{int(version)}" if version and int(version) > 1 else ""
        return self.chapters_dir / f"chapter_{chapter_number:03d}{suffix}.md"

    def get_summary_path(self, chapter_number: int, version: int | None = None) -> Path:
        chapter_number = max(1, int(chapter_number))
        suffix = f"_v{int(version)}" if version and int(version) > 1 else ""
        return self.summaries_dir / f"chapter_{chapter_number:03d}_summary{suffix}.md"

    def exists(self) -> bool:
        return self.project_dir.exists()


def get_project_context(title: str) -> ProjectContext:
    return ProjectContext.from_title(title)


def get_outputs_root() -> Path:
    return Path(OUTPUT_DIR)
