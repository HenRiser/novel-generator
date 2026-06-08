from __future__ import annotations

import re
from pathlib import Path

from export_service import build_single_chapter_txt, extract_display_title
from file_manager import resolve_project_context

from .schemas import ExportPayload, ReaderChapterContent, ReaderChapterItem, ReaderProjectSnapshot


def _safe_download_filename(name: str) -> str:
    safe_name = re.sub(r'[<>:"/\\|?*\s]+', "_", str(name or "").strip())
    safe_name = safe_name.strip("._")
    return safe_name or "未命名小说"


def _chapter_number_from_path(path: Path) -> int | None:
    match = re.match(r"^chapter_(\d+)(?:_v\d+)?\.md$", path.name)
    return int(match.group(1)) if match else None


def _chapter_version_from_path(path: Path) -> int:
    match = re.search(r"_v(\d+)$", path.stem)
    return int(match.group(1)) if match else 1


def _chapter_sort_key(path: Path) -> tuple[int, int, float]:
    return (
        _chapter_number_from_path(path) or 0,
        _chapter_version_from_path(path),
        path.stat().st_mtime,
    )


def _list_chapter_files(
    project_ref: str,
    outputs_root: Path | None = None,
    books_root: Path | None = None,
) -> list[Path]:
    ctx = resolve_project_context(project_ref, outputs_root=outputs_root, books_root=books_root)
    if not ctx.chapters_dir.exists():
        return []

    files = [
        path
        for path in ctx.chapters_dir.glob("chapter_*.md")
        if path.is_file() and _chapter_number_from_path(path) is not None
    ]
    return sorted(files, key=_chapter_sort_key)


def _latest_chapter_path(
    project_ref: str,
    chapter_number: int,
    outputs_root: Path | None = None,
    books_root: Path | None = None,
) -> Path | None:
    chapter_number = int(chapter_number)
    files = [
        path
        for path in _list_chapter_files(project_ref, outputs_root=outputs_root, books_root=books_root)
        if _chapter_number_from_path(path) == chapter_number
    ]
    if not files:
        return None
    return max(files, key=lambda item: (_chapter_version_from_path(item), item.stat().st_mtime))


def resolve_reader_display_title(
    project_ref: str,
    project_title: str = "",
    outputs_root: Path | None = None,
    books_root: Path | None = None,
) -> str:
    title = str(project_title or "").strip()
    if title:
        return title

    try:
        ctx = resolve_project_context(project_ref, outputs_root=outputs_root, books_root=books_root)
    except (FileNotFoundError, ValueError):
        return ""
    return str(ctx.title or "").strip()


def list_reader_chapters(
    project_ref: str,
    outputs_root: Path | None = None,
    books_root: Path | None = None,
) -> list[ReaderChapterItem]:
    ref = str(project_ref or "").strip()
    if not ref:
        return []

    chapter_numbers = sorted(
        {
            chapter_number
            for path in _list_chapter_files(ref, outputs_root=outputs_root, books_root=books_root)
            if (chapter_number := _chapter_number_from_path(path)) is not None
        }
    )

    items: list[ReaderChapterItem] = []
    for chapter_number in chapter_numbers:
        chapter = read_chapter_for_display(
            ref,
            chapter_number,
            outputs_root=outputs_root,
            books_root=books_root,
        )
        if not chapter.ok:
            continue
        path = Path(chapter.path)
        version = _chapter_version_from_path(path)
        items.append(
            ReaderChapterItem(
                chapter_number=int(chapter_number),
                title=chapter.title,
                filename=chapter.filename,
                path=chapter.path,
                is_version=version > 1,
                version=version,
                display_label=chapter.title,
            )
        )
    return items


def build_reader_project_snapshot(
    project_ref: str,
    project_title: str = "",
    outputs_root: Path | None = None,
    books_root: Path | None = None,
) -> ReaderProjectSnapshot:
    ref = str(project_ref or "").strip()
    if not ref:
        return ReaderProjectSnapshot(False, message="当前还没有已保存项目。")

    try:
        display_title = resolve_reader_display_title(
            ref,
            project_title=project_title,
            outputs_root=outputs_root,
            books_root=books_root,
        )
        chapters = list_reader_chapters(ref, outputs_root=outputs_root, books_root=books_root)
    except (FileNotFoundError, ValueError, OSError) as exc:
        return ReaderProjectSnapshot(False, project_ref=ref, message=f"阅读中心读取失败：{exc}")

    return ReaderProjectSnapshot(
        True,
        project_ref=ref,
        display_title=display_title,
        chapters=chapters,
        message="" if chapters else "当前项目还没有章节，请先生成章节。",
    )


def read_chapter_for_display(
    project_ref: str,
    chapter_number: int,
    outputs_root: Path | None = None,
    books_root: Path | None = None,
) -> ReaderChapterContent:
    ref = str(project_ref or "").strip()
    if not ref:
        return ReaderChapterContent(False, message="当前还没有已保存项目。")

    try:
        number = int(chapter_number)
        path = _latest_chapter_path(ref, number, outputs_root=outputs_root, books_root=books_root)
        if path is None:
            return ReaderChapterContent(False, chapter_number=number, message=f"未找到第 {number} 章正文。")

        content = path.read_text(encoding="utf-8")
        title = extract_display_title(content, number)
        return ReaderChapterContent(
            True,
            chapter_number=number,
            title=title,
            filename=path.name,
            path=str(path),
            content=content,
        )
    except (TypeError, ValueError) as exc:
        return ReaderChapterContent(False, message=f"章节编号无效：{exc}")
    except OSError as exc:
        return ReaderChapterContent(False, message=f"章节读取失败：{exc}")


def build_single_chapter_export_payload(
    project_ref: str,
    chapter_number: int,
    project_title: str = "",
    outputs_root: Path | None = None,
    books_root: Path | None = None,
) -> ExportPayload:
    chapter = read_chapter_for_display(
        project_ref,
        chapter_number,
        outputs_root=outputs_root,
        books_root=books_root,
    )
    if not chapter.ok:
        return ExportPayload(False, message=chapter.message)

    display_title = resolve_reader_display_title(
        project_ref,
        project_title=project_title,
        outputs_root=outputs_root,
        books_root=books_root,
    )
    safe_project_name = _safe_download_filename(display_title)
    return ExportPayload(
        True,
        filename=f"{safe_project_name}_chapter_{chapter.chapter_number:03d}.txt",
        content=build_single_chapter_txt(chapter.title, chapter.content),
    )


def build_full_book_export_payload(
    project_ref: str,
    project_title: str = "",
    outputs_root: Path | None = None,
    books_root: Path | None = None,
) -> ExportPayload:
    ref = str(project_ref or "").strip()
    if not ref:
        return ExportPayload(False, message="当前还没有已保存项目。")

    try:
        display_title = resolve_reader_display_title(
            ref,
            project_title=project_title,
            outputs_root=outputs_root,
            books_root=books_root,
        )
        chapters = list_reader_chapters(ref, outputs_root=outputs_root, books_root=books_root)
        if not chapters:
            return ExportPayload(False, message="当前项目还没有章节，请先生成章节。")

        parts = [display_title or "未命名小说"]
        for item in chapters:
            chapter = read_chapter_for_display(
                ref,
                item.chapter_number,
                outputs_root=outputs_root,
                books_root=books_root,
            )
            if chapter.ok:
                parts.append(build_single_chapter_txt(chapter.title, chapter.content).strip())

        content = "\n\n".join(part for part in parts if part).strip()
        if not content:
            return ExportPayload(False, message="全书导出内容为空。")

        safe_project_name = _safe_download_filename(display_title)
        return ExportPayload(True, filename=f"{safe_project_name}_全文.txt", content=f"{content}\n")
    except (FileNotFoundError, ValueError, OSError) as exc:
        return ExportPayload(False, message=f"全书导出失败：{exc}")
