from __future__ import annotations

import re
from typing import Any

from .schemas import BatchPlanResult


def clean_chapter_title(raw_title: str) -> str:
    title = (raw_title or "").strip()
    if not title:
        return "未命名章节"

    title = next((line.strip() for line in title.splitlines() if line.strip()), "")
    title = re.sub(r"^```(?:\w+)?", "", title).strip()
    title = title.strip("`#*_ \t\r\n")
    title = title.strip("\"'“”‘’《》「」『』")
    title = re.sub(r"^第\s*[零一二三四五六七八九十百千万\d]+\s*章\s*[:：、.\-\s]*", "", title)
    title = re.sub(r"^章节标题\s*[:：]\s*", "", title).strip()
    title = re.sub(r"\s+", " ", title).strip()
    title = title.strip("\"'“”‘’《》「」『』`#*_ ")

    if not title:
        return "未命名章节"
    if len(title) > 30:
        title = title[:30].rstrip()
    return title or "未命名章节"


def apply_chapter_heading(chapter_content: str, chapter_number: int, chapter_title: str) -> str:
    chapter_number = max(1, int(chapter_number))
    chapter_title = clean_chapter_title(chapter_title)
    heading = f"# 第 {chapter_number} 章：{chapter_title}"
    content = (chapter_content or "").lstrip()
    if not content:
        return f"{heading}\n"

    lines = content.splitlines()
    first_line = lines[0].strip() if lines else ""
    heading_pattern = r"^#{0,6}\s*第\s*[零一二三四五六七八九十百千万\d]+\s*章(?:\s*[:：、.\-].*|\s+.*)?$"
    if re.match(heading_pattern, first_line):
        body = "\n".join(lines[1:]).lstrip("\n")
        return f"{heading}\n\n{body}".rstrip() + "\n"

    return f"{heading}\n\n{content}".rstrip() + "\n"


def extract_chapter_title(chapter_content: str) -> str:
    for line in (chapter_content or "").splitlines():
        line = line.strip()
        if not line:
            continue
        match = re.match(
            r"^#{0,6}\s*第\s*[零一二三四五六七八九十百千万\d]+\s*章\s*[:：、.\-\s]+(.+)$",
            line,
        )
        if match:
            return clean_chapter_title(match.group(1))
        break
    return "未命名章节"


def build_chapter_generation_signature(action: str, project_ref: str, chapter_numbers: list[int]) -> str:
    chapters = ",".join(str(int(number)) for number in chapter_numbers)
    return f"{action}:{project_ref}:{chapters}"


def plan_batch_chapters(
    latest_chapter_number: Any,
    start_chapter_number: Any,
    end_chapter_number: Any,
    max_chapters: int,
) -> BatchPlanResult:
    try:
        latest = int(latest_chapter_number or 0)
        start = int(start_chapter_number)
        end = int(end_chapter_number)
    except (TypeError, ValueError):
        return BatchPlanResult(False, [], "章节号必须是正整数。")

    if start < 1 or end < 1:
        return BatchPlanResult(False, [], "章节号必须是正整数。")

    latest = max(0, latest)
    expected_start = latest + 1 if latest else 1
    if end < start:
        return BatchPlanResult(False, [], "结束章节号不能小于起始章节号。")
    if start != expected_start:
        return BatchPlanResult(False, [], f"为避免跳章，起始章节必须是第 {expected_start} 章。")

    chapters = list(range(start, end + 1))
    if len(chapters) > int(max_chapters):
        return BatchPlanResult(False, [], f"一次最多生成 {int(max_chapters)} 章，请缩小范围。")
    if not chapters:
        return BatchPlanResult(False, [], "没有需要生成的章节。")
    return BatchPlanResult(True, chapters)
