from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any

from config import DOCS_DIR, OUTPUT_DIR


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


def get_project_dir(title: str) -> Path:
    return OUTPUT_DIR / sanitize_project_title(title)


def ensure_directories() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    DOCS_DIR.mkdir(parents=True, exist_ok=True)


def ensure_project_dirs(title: str) -> dict[str, Path]:
    ensure_directories()
    project_dir = get_project_dir(title)
    chapters_dir = project_dir / "chapters"
    summaries_dir = project_dir / "summaries"

    project_dir.mkdir(parents=True, exist_ok=True)
    chapters_dir.mkdir(parents=True, exist_ok=True)
    summaries_dir.mkdir(parents=True, exist_ok=True)

    return {
        "project": project_dir,
        "chapters": chapters_dir,
        "summaries": summaries_dir,
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
    path = get_project_dir(title) / PROJECT_CONFIG_NAME
    if not path.exists():
        return None

    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"{path} 格式不正确，请检查 JSON 内容。") from exc


def save_outline(title: str, content: str) -> Path:
    dirs = ensure_project_dirs(title)
    return _write_text(_resolve_unique_path(dirs["project"] / OUTLINE_NAME), content)


def read_outline(title: str) -> str:
    path = get_project_dir(title) / OUTLINE_NAME
    return _read_text(path) if path.exists() else ""


def read_latest_outline(title: str) -> tuple[str, Path] | tuple[None, None]:
    project_dir = get_project_dir(title)
    files = [path for path in project_dir.glob("novel_outline*.md") if path.is_file()]
    if not files:
        return None, None
    path = max(files, key=lambda item: (_version_from_stem(item.stem), item.stat().st_mtime))
    return _read_text(path), path


def save_characters(title: str, content: str) -> Path:
    dirs = ensure_project_dirs(title)
    return _write_text(_resolve_unique_path(dirs["project"] / CHARACTERS_NAME), content)


def read_characters(title: str) -> str:
    path = get_project_dir(title) / CHARACTERS_NAME
    return _read_text(path) if path.exists() else ""


def read_latest_characters(title: str) -> tuple[str, Path] | tuple[None, None]:
    project_dir = get_project_dir(title)
    files = [path for path in project_dir.glob("characters*.md") if path.is_file()]
    if not files:
        return None, None
    path = max(files, key=lambda item: (_version_from_stem(item.stem), item.stat().st_mtime))
    return _read_text(path), path


def save_chapter(title: str, chapter_number: int, content: str) -> Path:
    dirs = ensure_project_dirs(title)
    chapter_number = max(1, int(chapter_number))
    path = dirs["chapters"] / f"chapter_{chapter_number:03d}.md"
    return _write_text(_resolve_unique_path(path), content)


def list_chapter_files(title: str) -> list[Path]:
    chapters_dir = get_project_dir(title) / "chapters"
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
    dirs = ensure_project_dirs(title)
    chapter_number = max(1, int(chapter_number))
    path = dirs["summaries"] / f"chapter_{chapter_number:03d}_summary.md"
    return _write_text(_resolve_unique_path(path), summary)


def read_all_summaries(title: str, before_chapter: int | None = None) -> str:
    summaries_dir = get_project_dir(title) / "summaries"
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
    chapter_path: Path,
    model: str,
    summary: str,
    created_at: str | None = None,
) -> Path:
    dirs = ensure_project_dirs(title)
    path = dirs["project"] / CHAPTER_INDEX_NAME
    created_at = created_at or datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    summary = " ".join((summary or "摘要生成失败，需手动补充。").split())

    if not path.exists():
        header = "# 章节索引\n\n| 章节 | 文件名 | 生成时间 | 使用模型 | 章节摘要 |\n| --- | --- | --- | --- | --- |\n"
        path.write_text(header, encoding="utf-8")

    row = (
        f"| 第 {int(chapter_number)} 章 | {chapter_path.name} | {created_at} | "
        f"{model} | {summary.replace('|', '/')} |\n"
    )
    with path.open("a", encoding="utf-8") as file:
        file.write(row)

    return path


def save_setting_expansion(title: str, raw_story_idea: str, expanded_data: dict[str, Any]) -> Path:
    dirs = ensure_project_dirs(title)
    path = dirs["project"] / SETTING_EXPANSION_NAME
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
