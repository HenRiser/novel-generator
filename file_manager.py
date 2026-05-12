from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any

from config import (
    CHARACTERS_FILE,
    CHAPTER_INDEX_FILE,
    DOCS_DIR,
    OUTPUT_DIR,
    OUTLINE_FILE,
    PROJECT_CONFIG_FILE,
    SUMMARY_DIR,
)


def ensure_directories() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    SUMMARY_DIR.mkdir(parents=True, exist_ok=True)
    DOCS_DIR.mkdir(parents=True, exist_ok=True)


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


def _latest_matching_file(pattern: str, directory: Path = OUTPUT_DIR) -> Path | None:
    files = [path for path in directory.glob(pattern) if path.is_file()]
    if not files:
        return None
    return max(files, key=lambda item: item.stat().st_mtime)


def _chapter_number_from_path(path: Path) -> int | None:
    match = re.match(r"^chapter_(\d+)(?:_v\d+)?\.md$", path.name)
    if not match:
        return None
    return int(match.group(1))


def list_chapter_files() -> list[tuple[int, Path]]:
    """Return chapter markdown files in outputs, including versioned chapter files."""
    ensure_directories()
    chapters = []
    for path in OUTPUT_DIR.glob("chapter_*.md"):
        if not path.is_file():
            continue
        chapter_number = _chapter_number_from_path(path)
        if chapter_number is not None:
            chapters.append((chapter_number, path))

    return sorted(chapters, key=lambda item: (item[0], item[1].stat().st_mtime))


def find_latest_chapter() -> tuple[int, Path] | tuple[None, None]:
    chapters = list_chapter_files()
    if not chapters:
        return None, None

    latest_number = max(chapter_number for chapter_number, _ in chapters)
    latest_paths = [path for chapter_number, path in chapters if chapter_number == latest_number]
    return latest_number, max(latest_paths, key=lambda item: item.stat().st_mtime)


def save_outline(content: str) -> Path:
    ensure_directories()
    return _write_text(_resolve_unique_path(OUTLINE_FILE), content)


def save_characters(content: str) -> Path:
    ensure_directories()
    return _write_text(_resolve_unique_path(CHARACTERS_FILE), content)


def save_chapter(chapter_number: int, content: str) -> Path:
    ensure_directories()
    chapter_number = max(1, int(chapter_number))
    path = OUTPUT_DIR / f"chapter_{chapter_number:03d}.md"
    return _write_text(_resolve_unique_path(path), content)


def save_summary(chapter_number: int, content: str) -> Path:
    ensure_directories()
    chapter_number = max(1, int(chapter_number))
    path = SUMMARY_DIR / f"chapter_{chapter_number:03d}_summary.md"
    return _write_text(_resolve_unique_path(path), content)


def save_edited_result(original_file_path: str | Path, edited_content: str) -> Path:
    ensure_directories()
    original_path = Path(original_file_path)
    suffix = original_path.suffix or ".md"
    edited_path = OUTPUT_DIR / f"{original_path.stem}_edited{suffix}"
    return _write_text(_resolve_unique_path(edited_path), edited_content)


def save_project_config(project_config: dict[str, Any]) -> Path:
    ensure_directories()
    data = dict(project_config)
    data["updated_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    PROJECT_CONFIG_FILE.write_text(
        json.dumps(data, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return PROJECT_CONFIG_FILE


def load_project_config() -> dict[str, Any] | None:
    ensure_directories()
    if not PROJECT_CONFIG_FILE.exists():
        return None

    try:
        return json.loads(PROJECT_CONFIG_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError("project_config.json 格式不正确，请检查 JSON 内容。") from exc


def read_latest_outline() -> tuple[str, Path] | tuple[None, None]:
    path = _latest_matching_file("novel_outline*.md")
    if not path:
        return None, None
    return _read_text(path), path


def read_latest_characters() -> tuple[str, Path] | tuple[None, None]:
    path = _latest_matching_file("characters*.md")
    if not path:
        return None, None
    return _read_text(path), path


def read_previous_chapter(chapter_number: int) -> tuple[str, Path] | tuple[None, None]:
    previous_number = int(chapter_number) - 1
    if previous_number < 1:
        return None, None

    paths = [
        path
        for found_number, path in list_chapter_files()
        if found_number == previous_number
    ]
    if not paths:
        return None, None

    path = max(paths, key=lambda item: item.stat().st_mtime)
    return _read_text(path), path


def _summary_sort_key(path: Path) -> tuple[int, float]:
    match = re.search(r"chapter_(\d+)_summary", path.name)
    chapter_number = int(match.group(1)) if match else 0
    return chapter_number, path.stat().st_mtime


def read_history_summaries(before_chapter: int | None = None) -> str:
    ensure_directories()
    files = [path for path in SUMMARY_DIR.glob("chapter_*_summary*.md") if path.is_file()]
    if before_chapter is not None:
        filtered = []
        for path in files:
            match = re.search(r"chapter_(\d+)_summary", path.name)
            if match and int(match.group(1)) < int(before_chapter):
                filtered.append(path)
        files = filtered

    parts = []
    for path in sorted(files, key=_summary_sort_key):
        parts.append(f"### {path.stem}\n{_read_text(path).strip()}")

    return "\n\n".join(parts)


def update_chapter_index(
    chapter_number: int,
    chapter_file: Path,
    model: str,
    summary: str,
    created_at: str | None = None,
) -> Path:
    ensure_directories()
    created_at = created_at or datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    summary = " ".join((summary or "摘要生成失败，需手动补充。").split())

    if not CHAPTER_INDEX_FILE.exists():
        header = "# 章节索引\n\n| 章节 | 文件名 | 生成时间 | 使用模型 | 章节摘要 |\n| --- | --- | --- | --- | --- |\n"
        CHAPTER_INDEX_FILE.write_text(header, encoding="utf-8")

    row = (
        f"| 第 {int(chapter_number)} 章 | {chapter_file.name} | {created_at} | "
        f"{model} | {summary.replace('|', '/')} |\n"
    )
    with CHAPTER_INDEX_FILE.open("a", encoding="utf-8") as file:
        file.write(row)

    return CHAPTER_INDEX_FILE
