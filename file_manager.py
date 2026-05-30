from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from config import DOCS_DIR
from project_context import (
    CHARACTERS_NAME,
    CHAPTER_INDEX_NAME,
    LEGACY_STORAGE_KIND,
    OUTLINE_NAME,
    PROJECT_CONFIG_NAME,
    ProjectContext,
    SETTING_EXPANSION_NAME,
    UNNAMED_PROJECT_TITLE,
    WORKSPACE_STORAGE_KIND,
    create_workspace_book,
    get_books_root,
    get_outputs_root,
    get_project_context,
    read_book_metadata,
    sanitize_project_title,
    update_book_metadata_timestamp,
    write_book_metadata,
)


@dataclass(frozen=True)
class ProjectRecord:
    ref: str
    kind: str
    title: str
    project_dir: Path
    book_id: str | None = None
    legacy_dir_name: str | None = None
    created_at: str | None = None
    updated_at: str | None = None


def get_project_dir(title: str) -> Path:
    return _get_project_context(title).project_dir


def ensure_directories() -> None:
    get_outputs_root().mkdir(parents=True, exist_ok=True)
    DOCS_DIR.mkdir(parents=True, exist_ok=True)


def ensure_project_dirs(title: str) -> dict[str, Path]:
    ensure_directories()
    ctx = _get_project_context(title)
    ctx.ensure_project_dirs()

    return {
        "project": ctx.project_dir,
        "chapters": ctx.chapters_dir,
        "summaries": ctx.summaries_dir,
    }


def list_project_titles() -> list[str]:
    ensure_directories()
    return sorted(path.name for path in get_outputs_root().iterdir() if path.is_dir())


def project_ref_from_legacy_title(title: str) -> str:
    return f"legacy:{sanitize_project_title(title)}"


def parse_project_ref(project_ref: str) -> tuple[str, str]:
    ref = str(project_ref or "").strip()
    if ":" not in ref:
        raise ValueError(f"Invalid project_ref, expected '<kind>:<id>': {project_ref}")

    kind, value = ref.split(":", 1)
    kind = kind.strip()
    value = value.strip()
    if not value:
        raise ValueError(f"Invalid project_ref, missing identifier: {project_ref}")
    if kind not in {"legacy", "book"}:
        raise ValueError(f"Unsupported project_ref kind '{kind}': {project_ref}")

    return kind, value


def resolve_project_context(
    project_ref: str,
    outputs_root: Path | None = None,
    books_root: Path | None = None,
) -> ProjectContext:
    kind, value = parse_project_ref(project_ref)

    if kind == "legacy":
        root = Path(outputs_root) if outputs_root is not None else get_outputs_root()
        ctx = ProjectContext.from_title(value, outputs_root=root)
        if not ctx.project_dir.exists():
            raise FileNotFoundError(f"Legacy project not found: {ctx.project_dir}")
        return ctx

    root = Path(books_root) if books_root is not None else get_books_root()
    return ProjectContext.from_book_id(value, books_root=root)


def _is_project_ref(value: str) -> bool:
    ref = str(value or "").strip()
    return ref.startswith("book:") or ref.startswith("legacy:")


def _get_project_context(project_key: str) -> ProjectContext:
    if _is_project_ref(project_key):
        return resolve_project_context(project_key)
    return get_project_context(project_key)


def project_ref_from_context(ctx: ProjectContext) -> str:
    if ctx.storage_kind == WORKSPACE_STORAGE_KIND and ctx.book_id:
        return f"book:{ctx.book_id}"
    if ctx.storage_kind == LEGACY_STORAGE_KIND and ctx.legacy_dir_name:
        return f"legacy:{ctx.legacy_dir_name}"
    raise ValueError("ProjectContext does not contain enough identity data.")


def create_workspace_project(title: str, books_root: Path | None = None) -> ProjectContext:
    if books_root is None:
        return create_workspace_book(title)
    return create_workspace_book(title, books_root=books_root)


def _sync_book_metadata_from_config(ctx: ProjectContext, config_data: dict[str, Any]) -> None:
    title = str(config_data.get("title") or "").strip()
    if not title:
        return

    metadata = read_book_metadata(ctx.project_dir)
    metadata = update_book_metadata_timestamp({**metadata, "title": title})
    write_book_metadata(ctx.project_dir, metadata)


def _timestamp_from_path(path: Path) -> str | None:
    try:
        return datetime.fromtimestamp(path.stat().st_mtime).astimezone().isoformat(timespec="seconds")
    except OSError:
        return None


def _read_legacy_project_config(project_dir: Path) -> dict[str, Any]:
    path = project_dir / PROJECT_CONFIG_NAME
    if not path.exists():
        return {}

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def _list_legacy_projects(outputs_root: Path) -> list[ProjectRecord]:
    if not outputs_root.exists():
        return []

    records: list[ProjectRecord] = []
    for path in outputs_root.iterdir():
        if not path.is_dir() or path.name.startswith(".") or path.name == "__pycache__":
            continue

        config = _read_legacy_project_config(path)
        title = str(config.get("title") or "").strip() or path.name
        updated_at = str(config.get("updated_at") or "").strip() or _timestamp_from_path(path)
        records.append(
            ProjectRecord(
                ref=f"legacy:{path.name}",
                kind=LEGACY_STORAGE_KIND,
                title=title,
                project_dir=path,
                legacy_dir_name=path.name,
                updated_at=updated_at,
            )
        )

    return records


def _list_workspace_projects(books_root: Path) -> list[ProjectRecord]:
    if not books_root.exists():
        return []

    records: list[ProjectRecord] = []
    for path in books_root.iterdir():
        if not path.is_dir() or path.name.startswith(".") or path.name == "__pycache__":
            continue

        try:
            metadata = read_book_metadata(path)
        except (FileNotFoundError, ValueError):
            continue

        book_id = str(metadata["book_id"])
        if book_id != path.name:
            continue

        records.append(
            ProjectRecord(
                ref=f"book:{book_id}",
                kind=WORKSPACE_STORAGE_KIND,
                title=str(metadata["title"]).strip(),
                project_dir=path,
                book_id=book_id,
                created_at=str(metadata.get("created_at") or "").strip() or None,
                updated_at=str(metadata.get("updated_at") or "").strip() or _timestamp_from_path(path),
            )
        )

    return records


def list_projects(
    outputs_root: Path | None = None,
    books_root: Path | None = None,
) -> list[ProjectRecord]:
    if outputs_root is None:
        ensure_directories()
    resolved_outputs_root = Path(outputs_root) if outputs_root is not None else get_outputs_root()
    resolved_books_root = Path(books_root) if books_root is not None else get_books_root()

    records = _list_legacy_projects(resolved_outputs_root)
    records.extend(_list_workspace_projects(resolved_books_root))

    return sorted(
        records,
        key=lambda record: (
            record.updated_at or "",
            record.title.casefold(),
            record.ref,
        ),
        reverse=True,
    )


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _write_text(path: Path, content: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


def _resolve_unique_path(path: Path) -> Path:
    if not path.exists():
        return path

    counter = 2
    while True:
        candidate = path.with_name(f"{path.stem}_v{counter}{path.suffix}")
        if not candidate.exists():
            return candidate
        counter += 1


def _version_from_stem(stem: str) -> int:
    match = re.search(r"_v(\d+)$", stem)
    return int(match.group(1)) if match else 1


def _chapter_number_from_path(path: Path) -> int | None:
    match = re.match(r"^chapter_(\d+)(?:_v\d+)?\.md$", path.name)
    if not match:
        return None
    return int(match.group(1))


def _chapter_sort_key(path: Path) -> tuple[int, int, float]:
    chapter_number = _chapter_number_from_path(path) or 0
    return chapter_number, _version_from_stem(path.stem), path.stat().st_mtime


def _summary_number_from_path(path: Path) -> int | None:
    match = re.match(r"^chapter_(\d+)_summary(?:_v\d+)?\.md$", path.name)
    if not match:
        return None
    return int(match.group(1))


def _summary_sort_key(path: Path) -> tuple[int, int, float]:
    chapter_number = _summary_number_from_path(path) or 0
    return chapter_number, _version_from_stem(path.stem), path.stat().st_mtime


def save_project_config(title: str, config_data: dict[str, Any]) -> Path:
    ctx = _get_project_context(title)
    ctx.ensure_project_dirs()
    data = dict(config_data)
    data["updated_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    path = ctx.config_path
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    if ctx.storage_kind == WORKSPACE_STORAGE_KIND:
        _sync_book_metadata_from_config(ctx, data)
    return path


def load_project_config(title: str) -> dict[str, Any] | None:
    ensure_directories()
    path = _get_project_context(title).config_path
    if not path.exists():
        return None

    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"{path} 格式不正确，请检查 JSON 内容。") from exc


def save_outline(title: str, content: str) -> Path:
    ctx = _get_project_context(title)
    ctx.ensure_project_dirs()
    return _write_text(_resolve_unique_path(ctx.outline_path), content)


def read_outline(title: str) -> str:
    path = _get_project_context(title).outline_path
    return _read_text(path) if path.exists() else ""


def read_latest_outline(title: str) -> tuple[str, Path] | tuple[None, None]:
    project_dir = _get_project_context(title).project_dir
    files = [path for path in project_dir.glob("novel_outline*.md") if path.is_file()]
    if not files:
        return None, None
    path = max(files, key=lambda item: (_version_from_stem(item.stem), item.stat().st_mtime))
    return _read_text(path), path


def save_characters(title: str, content: str) -> Path:
    ctx = _get_project_context(title)
    ctx.ensure_project_dirs()
    return _write_text(_resolve_unique_path(ctx.characters_path), content)


def read_characters(title: str) -> str:
    path = _get_project_context(title).characters_path
    return _read_text(path) if path.exists() else ""


def read_latest_characters(title: str) -> tuple[str, Path] | tuple[None, None]:
    project_dir = _get_project_context(title).project_dir
    files = [path for path in project_dir.glob("characters*.md") if path.is_file()]
    if not files:
        return None, None
    path = max(files, key=lambda item: (_version_from_stem(item.stem), item.stat().st_mtime))
    return _read_text(path), path


def save_chapter(title: str, chapter_number: int, content: str) -> Path:
    ctx = _get_project_context(title)
    ctx.ensure_project_dirs()
    path = ctx.get_chapter_path(chapter_number)
    return _write_text(_resolve_unique_path(path), content)


def list_chapter_files(title: str) -> list[Path]:
    chapters_dir = _get_project_context(title).chapters_dir
    if not chapters_dir.exists():
        return []

    files = [
        path
        for path in chapters_dir.glob("chapter_*.md")
        if path.is_file() and _chapter_number_from_path(path) is not None
    ]
    return sorted(files, key=_chapter_sort_key)


def read_chapter(title: str, chapter_number: int) -> tuple[str, Path] | tuple[None, None]:
    chapter_number = int(chapter_number)
    files = [
        path
        for path in list_chapter_files(title)
        if _chapter_number_from_path(path) == chapter_number
    ]
    if not files:
        return None, None

    path = max(files, key=lambda item: (_version_from_stem(item.stem), item.stat().st_mtime))
    return _read_text(path), path


def read_previous_chapter(title: str, chapter_number: int) -> tuple[str, Path] | tuple[None, None]:
    previous_number = int(chapter_number) - 1
    if previous_number < 1:
        return None, None

    return read_chapter(title, previous_number)


def find_latest_chapter(title: str) -> tuple[int, Path] | tuple[None, None]:
    files = list_chapter_files(title)
    if not files:
        return None, None

    latest_number = max(_chapter_number_from_path(path) or 0 for path in files)
    latest_files = [path for path in files if _chapter_number_from_path(path) == latest_number]
    path = max(latest_files, key=lambda item: (_version_from_stem(item.stem), item.stat().st_mtime))
    return latest_number, path


def save_summary(title: str, chapter_number: int, summary: str) -> Path:
    ctx = _get_project_context(title)
    ctx.ensure_project_dirs()
    path = ctx.get_summary_path(chapter_number)
    return _write_text(_resolve_unique_path(path), summary)


def read_all_summaries(title: str, before_chapter: int | None = None) -> str:
    summaries_dir = _get_project_context(title).summaries_dir
    if not summaries_dir.exists():
        return ""

    files = [
        path
        for path in summaries_dir.glob("chapter_*_summary*.md")
        if path.is_file() and _summary_number_from_path(path) is not None
    ]
    if before_chapter is not None:
        files = [
            path
            for path in files
            if (_summary_number_from_path(path) or 0) < int(before_chapter)
        ]

    parts = []
    for path in sorted(files, key=_summary_sort_key):
        parts.append(f"### {path.stem}\n{_read_text(path).strip()}")

    return "\n\n".join(parts)


def read_history_summaries(title: str, before_chapter: int | None = None) -> str:
    return read_all_summaries(title, before_chapter=before_chapter)


def update_chapter_index(
    title: str,
    chapter_number: int,
    chapter_title: str,
    chapter_path: Path,
    model: str,
    summary: str,
    created_at: str | None = None,
) -> Path:
    ctx = _get_project_context(title)
    ctx.ensure_project_dirs()
    path = ctx.chapter_index_path
    created_at = created_at or datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    chapter_title = " ".join((chapter_title or "未命名章节").split()).replace("|", "/")
    summary = " ".join((summary or "摘要生成失败，需手动补充。").split())
    summary = summary.replace("|", "/")
    try:
        display_path = chapter_path.relative_to(ctx.project_dir).as_posix()
    except ValueError:
        display_path = chapter_path.name

    if not path.exists():
        header = "# 章节索引\n\n| 章节 | 标题 | 文件 | 生成时间 | 正文模型 | 摘要 |\n| --- | --- | --- | --- | --- | --- |\n"
        path.write_text(header, encoding="utf-8")
    elif "| 标题 |" not in path.read_text(encoding="utf-8"):
        with path.open("a", encoding="utf-8") as file:
            file.write("\n\n## 新索引格式\n\n| 章节 | 标题 | 文件 | 生成时间 | 模型 | 摘要 |\n| --- | --- | --- | --- | --- | --- |\n")

    row = (
        f"| 第 {int(chapter_number)} 章 | {chapter_title} | {display_path} | {created_at} | "
        f"{model} | {summary} |\n"
    )
    with path.open("a", encoding="utf-8") as file:
        file.write(row)

    return path


def save_setting_expansion(title: str, raw_story_idea: str, expanded_data: dict[str, Any]) -> Path:
    ctx = _get_project_context(title)
    ctx.ensure_project_dirs()
    path = ctx.setting_expansion_path
    data = {
        "raw_story_idea": raw_story_idea,
        "expanded": expanded_data,
    }
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def save_edited_result(title: str, original_file_path: str | Path, edited_content: str) -> Path:
    ensure_project_dirs(title)
    original_path = Path(original_file_path)
    suffix = original_path.suffix or ".md"
    edited_path = original_path.with_name(f"{original_path.stem}_edited{suffix}")
    return _write_text(_resolve_unique_path(edited_path), edited_content)
