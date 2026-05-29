from __future__ import annotations

import html
import re
from pathlib import Path

from file_manager import list_chapter_files, read_chapter


def _chapter_number_from_filename(path: Path) -> int | None:
    match = re.match(r"^chapter_(\d+)(?:_v\d+)?\.md$", path.name)
    if not match:
        return None
    return int(match.group(1))


def _strip_heading_marker(line: str) -> str:
    return re.sub(r"^\s*#{1,6}\s*", "", line).strip()


def _is_display_title_line(line: str, chapter_number: int | None = None) -> bool:
    stripped = _strip_heading_marker(line)
    if chapter_number is not None:
        pattern = rf"^第\s*{int(chapter_number)}\s*章(?:\s*[：:].*)?$"
        if re.match(pattern, stripped):
            return True
    return bool(re.match(r"^第\s*[\d零一二三四五六七八九十百千万]+\s*章(?:\s*[：:].*)?$", stripped))


def _split_first_display_title(text: str, chapter_number: int) -> tuple[str | None, str]:
    lines = (text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    for index, line in enumerate(lines):
        if not line.strip():
            continue
        if _is_display_title_line(line, chapter_number):
            title = _strip_heading_marker(line)
            remaining = "\n".join(lines[:index] + lines[index + 1 :]).strip()
            return title, remaining
        break
    return None, text or ""


def extract_display_title(chapter_content: str, chapter_number: int) -> str:
    title, _ = _split_first_display_title(chapter_content, chapter_number)
    return title or f"第 {int(chapter_number)} 章"


def get_ordered_chapters(project_title: str) -> list[dict]:
    chapter_numbers = sorted(
        {
            chapter_number
            for path in list_chapter_files(project_title)
            if (chapter_number := _chapter_number_from_filename(path)) is not None
        }
    )

    chapters = []
    for chapter_number in chapter_numbers:
        content, path = read_chapter(project_title, chapter_number)
        if content is None or path is None:
            continue
        chapters.append(
            {
                "chapter_number": chapter_number,
                "title": extract_display_title(content, chapter_number),
                "path": path,
                "filename": path.name,
            }
        )
    return chapters


def read_chapter_for_reader(project_title: str, chapter_number: int) -> dict:
    content, path = read_chapter(project_title, chapter_number)
    if content is None or path is None:
        raise FileNotFoundError(f"未找到第 {int(chapter_number)} 章正文。")

    return {
        "chapter_number": int(chapter_number),
        "title": extract_display_title(content, int(chapter_number)),
        "content": content,
        "path": str(path),
    }


def markdown_like_to_readable_html(text: str) -> str:
    lines = (text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    parts: list[str] = []
    paragraph: list[str] = []
    first_content_seen = False

    def flush_paragraph() -> None:
        if not paragraph:
            return
        safe_text = html.escape("\n".join(paragraph).strip()).replace("\n", "<br>")
        if safe_text:
            parts.append(f"<p>{safe_text}</p>")
        paragraph.clear()

    for line in lines:
        stripped = line.strip()
        if not stripped:
            flush_paragraph()
            continue

        if not first_content_seen and _is_display_title_line(stripped):
            flush_paragraph()
            parts.append(f"<h2>{html.escape(_strip_heading_marker(stripped))}</h2>")
            first_content_seen = True
            continue

        first_content_seen = True
        paragraph.append(stripped)

    flush_paragraph()
    return "\n".join(parts)


def build_reader_html(chapter_title: str, chapter_content: str) -> str:
    body_html = markdown_like_to_readable_html(chapter_content)
    title_html = ""
    if not _is_display_title_line(next((line for line in chapter_content.splitlines() if line.strip()), "")):
        title_html = f"<h2>{html.escape(chapter_title)}</h2>"

    return f"""
<style>
.reader-shell {{
    max-width: 760px;
    margin: 0 auto 1rem auto;
    padding: 1.2rem 1rem;
    background: #ffffff;
    color: #242424;
    border: 1px solid #e7e3dc;
    border-radius: 8px;
}}
.reader-shell h2 {{
    margin: 0.4rem 0 1.3rem;
    text-align: center;
    font-size: 1.45rem;
    line-height: 1.45;
    font-weight: 700;
}}
.reader-shell p {{
    margin: 0 0 1.05rem;
    font-size: 1.05rem;
    line-height: 1.85;
    text-indent: 2em;
    overflow-wrap: anywhere;
}}
@media (max-width: 640px) {{
    .reader-shell {{
        padding: 1rem 0.85rem;
        border-left: 0;
        border-right: 0;
        border-radius: 0;
    }}
    .reader-shell h2 {{
        font-size: 1.25rem;
    }}
    .reader-shell p {{
        font-size: 1rem;
        line-height: 1.8;
    }}
}}
</style>
<article class="reader-shell">
{title_html}
{body_html}
</article>
""".strip()


def build_single_chapter_txt(chapter_title: str, chapter_content: str) -> str:
    _, body = _split_first_display_title(chapter_content, 0)
    title = _strip_heading_marker(chapter_title).strip()
    body = body.strip()
    return f"{title}\n\n{body}\n" if body else f"{title}\n"


def build_full_novel_txt(project_title: str) -> str:
    chapters = get_ordered_chapters(project_title)
    if not chapters:
        return ""

    parts = [project_title.strip() or "未命名小说"]
    for chapter in chapters:
        chapter_data = read_chapter_for_reader(project_title, int(chapter["chapter_number"]))
        parts.append(build_single_chapter_txt(chapter_data["title"], chapter_data["content"]).strip())

    return "\n\n".join(part for part in parts if part).strip() + "\n"
