from __future__ import annotations

import json
import re
import secrets
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from config import BOOKS_DIR, OUTPUT_DIR, WORKSPACE_DIR


UNNAMED_PROJECT_TITLE = "未命名小说"
PROJECT_CONFIG_NAME = "project_config.json"
OUTLINE_NAME = "novel_outline.md"
CHARACTERS_NAME = "characters.md"
CHAPTER_INDEX_NAME = "chapter_index.md"
SETTING_EXPANSION_NAME = "setting_expansion_latest.json"
BOOK_METADATA_NAME = "book.json"
BOOK_METADATA_SCHEMA_VERSION = 1
BOOK_LAYOUT_VERSION = 1
LEGACY_STORAGE_KIND = "legacy"
WORKSPACE_STORAGE_KIND = "workspace"
BOOK_ID_PATTERN = re.compile(r"^bk_\d{8}_\d{6}_[0-9a-f]{8}$")


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


def get_workspace_root() -> Path:
    return Path(WORKSPACE_DIR)


def get_books_root() -> Path:
    return Path(BOOKS_DIR)


def ensure_workspace_dirs() -> None:
    get_books_root().mkdir(parents=True, exist_ok=True)


def _metadata_timestamp() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def generate_book_id(books_root: Path | None = None) -> str:
    root = Path(books_root) if books_root is not None else None

    for _ in range(1000):
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        book_id = f"bk_{timestamp}_{secrets.token_hex(4)}"
        if root is None or not (root / book_id).exists():
            return book_id

    raise RuntimeError("Unable to generate a unique book_id after 1000 attempts.")


def validate_book_id(book_id: str) -> bool:
    return bool(BOOK_ID_PATTERN.match(str(book_id or "")))


def create_book_metadata(
    title: str,
    book_id: str | None = None,
    source: dict | None = None,
) -> dict:
    resolved_book_id = book_id or generate_book_id()
    if not validate_book_id(resolved_book_id):
        raise ValueError(f"Invalid book_id: {resolved_book_id}")
    if source is not None and not isinstance(source, dict):
        raise ValueError("Book metadata source must be a dict when provided.")

    timestamp = _metadata_timestamp()
    return {
        "schema_version": BOOK_METADATA_SCHEMA_VERSION,
        "book_id": resolved_book_id,
        "title": str(title or "").strip() or UNNAMED_PROJECT_TITLE,
        "created_at": timestamp,
        "updated_at": timestamp,
        "storage": {
            "kind": WORKSPACE_STORAGE_KIND,
            "layout_version": BOOK_LAYOUT_VERSION,
        },
        "source": dict(source) if source is not None else {"kind": "new"},
        "title_history": [],
    }


def validate_book_metadata(metadata: dict) -> tuple[bool, str]:
    if not isinstance(metadata, dict):
        return False, "Book metadata must be a JSON object."
    if metadata.get("schema_version") != BOOK_METADATA_SCHEMA_VERSION:
        return False, "Unsupported book metadata schema_version."
    book_id = metadata.get("book_id")
    if not isinstance(book_id, str) or not validate_book_id(book_id):
        return False, "Book metadata has an invalid book_id."
    title = metadata.get("title")
    if not isinstance(title, str) or not title.strip():
        return False, "Book metadata title must be a non-empty string."
    storage = metadata.get("storage")
    if not isinstance(storage, dict):
        return False, "Book metadata storage must be an object."
    if storage.get("kind") != WORKSPACE_STORAGE_KIND:
        return False, "Book metadata storage.kind must be workspace."
    return True, ""


def read_book_metadata(book_dir: Path) -> dict:
    path = Path(book_dir) / BOOK_METADATA_NAME
    if not path.exists():
        raise FileNotFoundError(f"Book metadata not found: {path}")

    try:
        metadata = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"Book metadata is not valid JSON: {path}") from exc

    is_valid, message = validate_book_metadata(metadata)
    if not is_valid:
        raise ValueError(f"Invalid book metadata at {path}: {message}")
    return metadata


def write_book_metadata(book_dir: Path, metadata: dict) -> None:
    is_valid, message = validate_book_metadata(metadata)
    if not is_valid:
        raise ValueError(f"Invalid book metadata: {message}")

    path = Path(book_dir) / BOOK_METADATA_NAME
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")


def update_book_metadata_timestamp(metadata: dict) -> dict:
    updated = dict(metadata)
    updated["updated_at"] = _metadata_timestamp()
    return updated


@dataclass(frozen=True)
class ProjectContext:
    title: str
    project_dir: Path
    safe_title: str
    storage_kind: str = LEGACY_STORAGE_KIND
    outputs_root: Path | None = None
    workspace_root: Path | None = None
    books_root: Path | None = None
    book_id: str | None = None
    legacy_dir_name: str | None = None

    @classmethod
    def from_title(cls, title: str, outputs_root: Path = OUTPUT_DIR) -> "ProjectContext":
        safe_title = sanitize_project_title(title)
        root = Path(outputs_root)
        return cls(
            title=str(title or "").strip(),
            project_dir=root / safe_title,
            safe_title=safe_title,
            storage_kind=LEGACY_STORAGE_KIND,
            outputs_root=root,
            legacy_dir_name=safe_title,
        )

    @classmethod
    def from_book_id(cls, book_id: str, books_root: Path = BOOKS_DIR) -> "ProjectContext":
        if not validate_book_id(book_id):
            raise ValueError(f"Invalid book_id: {book_id}")

        root = Path(books_root)
        project_dir = root / book_id
        metadata = read_book_metadata(project_dir)
        metadata_book_id = metadata["book_id"]
        if metadata_book_id != book_id:
            raise ValueError(
                f"Book metadata book_id mismatch: expected {book_id}, got {metadata_book_id}"
            )

        return cls(
            title=str(metadata["title"]).strip(),
            project_dir=project_dir,
            safe_title=book_id,
            storage_kind=WORKSPACE_STORAGE_KIND,
            workspace_root=root.parent,
            books_root=root,
            book_id=book_id,
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
        if self.storage_kind == LEGACY_STORAGE_KIND and self.outputs_root is not None:
            self.outputs_root.mkdir(parents=True, exist_ok=True)
        if self.storage_kind == WORKSPACE_STORAGE_KIND and self.books_root is not None:
            self.books_root.mkdir(parents=True, exist_ok=True)
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


def get_workspace_project_context(book_id: str) -> ProjectContext:
    return ProjectContext.from_book_id(book_id)


def create_workspace_book(title: str, books_root: Path = BOOKS_DIR) -> ProjectContext:
    root = Path(books_root)
    book_id = generate_book_id(root)
    project_dir = root / book_id
    metadata = create_book_metadata(title, book_id=book_id)
    write_book_metadata(project_dir, metadata)

    ctx = ProjectContext.from_book_id(book_id, books_root=root)
    ctx.ensure_project_dirs()
    return ctx


def get_outputs_root() -> Path:
    return Path(OUTPUT_DIR)
