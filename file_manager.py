from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any

from config import DOCS_DIR, OUTPUT_DIR
from project_context import (
    CHARACTERS_NAME,
    CHAPTER_INDEX_NAME,
    OUTLINE_NAME,
    PROJECT_CONFIG_NAME,
    SETTING_EXPANSION_NAME,
    UNNAMED_PROJECT_TITLE,
    get_project_context,
    sanitize_project_title,
)


def get_project_dir(title: str) -> Path:
    return get_project_context(title).project_dir


def ensure_directories() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    DOCS_DIR.mkdir(parents=True, exist_ok=True)


def ensure_project_dirs(title: str) -> dict[str, Path]:
    ensure_directories()
    ctx = get_project_context(title)
    ctx.ensure_project_dirs()

    return {
        "project": ctx.project_dir,
        "chapters": ctx.chapters_dir,
        "summaries": ctx.summaries_dir,
    }


def list_project_titles() -> list[str]:
    ensure_directories()
    return sorted(path.name for path in OUTPUT_DIR.iterdir() if path.is_dir())


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
    dirs = ensure_project_dirs(title)
    data = dict(config_data)
    data["updated_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    path = dirs["project"] / PROJECT_CONFIG_NAME
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def load_project_config(title: str) -> dict[str, Any] | None:
    ensure_directories()
    path = get_project_context(title).config_path
    if not path.exists():
        return None

    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"{path} 格式不正确，请检查 JSON 内容。") from exc


def save_outline(title: str, content: str) -> Path:
    ctx = get_project_context(title)
    ctx.ensure_project_dirs()
    return _write_text(_resolve_unique_path(ctx.outline_path), content)


def read_outline(title: str) -> str:
    path = get_project_context(title).outline_path
    return _read_text(path) if path.exists() else ""


def read_latest_outline(title: str) -> tuple[str, Path] | tuple[None, None]:
    project_dir = get_project_context(title).project_dir
    files = [path for path in project_dir.glob("novel_outline*.md") if path.is_file()]
    if not files:
        return None, None
    path = max(files, key=lambda item: (_version_from_stem(item.stem), item.stat().st_mtime))
    return _read_text(path), path


def save_characters(title: str, content: str) -> Path:
    ctx = get_project_context(title)
    ctx.ensure_project_dirs()
    return _write_text(_resolve_unique_path(ctx.characters_path), content)


def read_characters(title: str) -> str:
    path = get_project_context(title).characters_path
    return _read_text(path) if path.exists() else ""


def read_latest_characters(title: str) -> tuple[str, Path] | tuple[None, None]:
    project_dir = get_project_context(title).project_dir
    files = [path for path in project_dir.glob("characters*.md") if path.is_file()]
    if not files:
        return None, None
    path = max(files, key=lambda item: (_version_from_stem(item.stem), item.stat().st_mtime))
    return _read_text(path), path


def save_chapter(title: str, chapter_number: int, content: str) -> Path:
    ctx = get_project_context(title)
    ctx.ensure_project_dirs()
    path = ctx.get_chapter_path(chapter_number)
    return _write_text(_resolve_unique_path(path), content)


def list_chapter_files(title: str) -> list[Path]:
    chapters_dir = get_project_context(title).chapters_dir
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
    ctx = get_project_context(title)
    ctx.ensure_project_dirs()
    path = ctx.get_summary_path(chapter_number)
    return _write_text(_resolve_unique_path(path), summary)


def read_all_summaries(title: str, before_chapter: int | None = None) -> str:
    summaries_dir = get_project_context(title).summaries_dir
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
    ctx = get_project_context(title)
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
    ctx = get_project_context(title)
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
