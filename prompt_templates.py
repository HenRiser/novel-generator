from __future__ import annotations

from typing import Any

from config import MAX_PREVIOUS_CHAPTER_CHARS, MAX_REFERENCE_CHARS, MAX_SUMMARIES_CHARS


GLOBAL_SYSTEM_PROMPT = (
    "你是一名专业小说创作助手，擅长根据用户给定的题材、人物、世界观和叙事风格创作长篇小说。"
    "你必须严格遵守用户设定，保持人物性格一致、世界观规则一致、叙事节奏稳定。"
    "不要自称 AI，不要解释创作过程，直接输出作品内容。"
    "除非用户明确要求，否则不要输出分析、说明或与作品无关的列表。"
)


PROJECT_FIELD_LABELS = {
    "title": "小说标题",
    "genre": "小说类型",
    "style": "写作风格",
    "protagonist": "主角设定",
    "supporting_characters": "重要配角设定",
    "worldview": "世界观设定",
    "core_conflict": "故事核心冲突",
    "target_readers": "目标读者",
    "word_count_range": "单章字数范围",
    "extra_requirements": "额外要求",
}


def _clean(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _clip(text: str | None, max_chars: int, keep_tail: bool = False) -> str:
    text = _clean(text)
    if len(text) <= max_chars:
        return text
    if keep_tail:
        return "...\n" + text[-max_chars:]
    return text[:max_chars] + "\n..."


def format_project_brief(project_config: dict[str, Any]) -> str:
    lines = []
    for key, label in PROJECT_FIELD_LABELS.items():
        value = _clean(project_config.get(key))
        if value:
            lines.append(f"- {label}：{value}")

    return "\n".join(lines) if lines else "- 用户尚未填写详细设定，请根据标题和类型补足合理内容。"


def _messages(user_prompt: str) -> list[dict[str, str]]:
    return [
        {"role": "system", "content": GLOBAL_SYSTEM_PROMPT},
        {"role": "user", "content": user_prompt.strip()},
    ]


def build_outline_prompt(project_config: dict[str, Any]) -> list[dict[str, str]]:
    project_brief = format_project_brief(project_config)
    user_prompt = f"""
请根据以下小说项目设定，生成一份适合长期连载扩展的小说总纲。

## 项目设定
{project_brief}

## 输出要求
请使用 Markdown，严格按照以下结构输出：

# 小说总纲

## 一句话卖点

## 世界观设定

## 主线冲突

## 主要人物

## 三幕式结构

## 分卷规划

## 前 10 章章节大纲

每章包含：
- 章节标题
- 本章剧情
- 冲突点
- 结尾钩子

请让设定有后续扩展空间，但不要过度复杂。
"""
    return _messages(user_prompt)


def build_character_prompt(project_config: dict[str, Any]) -> list[dict[str, str]]:
    project_brief = format_project_brief(project_config)
    user_prompt = f"""
请根据以下小说项目设定，生成主要角色与关键配角的人物设定表。

## 项目设定
{project_brief}

## 输出要求
请使用 Markdown，严格按照以下结构输出：

# 人物设定表

每个角色包含：
- 姓名
- 身份
- 外貌特征
- 性格关键词
- 核心欲望
- 核心恐惧
- 与主角关系
- 成长弧线
- 说话风格
- 隐藏秘密

请保持角色之间的欲望、矛盾和关系具有戏剧张力。
"""
    return _messages(user_prompt)


def build_chapter_prompt(
    project_config: dict[str, Any],
    chapter_number: int,
    outline: str | None = None,
    characters: str | None = None,
    previous_chapter: str | None = None,
    summaries: str | None = None,
) -> list[dict[str, str]]:
    project_brief = format_project_brief(project_config)
    chapter_number = max(1, int(chapter_number))

    context_blocks = []
    if outline:
        context_blocks.append(f"## 已有小说大纲\n{_clip(outline, MAX_REFERENCE_CHARS)}")
    if characters:
        context_blocks.append(f"## 已有人物卡\n{_clip(characters, MAX_REFERENCE_CHARS)}")
    if summaries:
        context_blocks.append(f"## 历史章节摘要\n{_clip(summaries, MAX_SUMMARIES_CHARS)}")
    if previous_chapter:
        context_blocks.append(f"## 上一章正文\n{_clip(previous_chapter, MAX_PREVIOUS_CHAPTER_CHARS, keep_tail=True)}")

    context_text = "\n\n".join(context_blocks) if context_blocks else "暂无额外上下文。"

    user_prompt = f"""
请根据以下小说项目设定和上下文，创作指定章节正文。

## 项目设定
{project_brief}

## 章节编号
第 {chapter_number} 章

## 可用上下文
{context_text}

## 正文格式
# 第 {chapter_number} 章：章节标题

## 正文要求
1. 不要输出提纲。
2. 不要解释创作思路。
3. 不要使用项目符号。
4. 保持小说正文格式。
5. 对话自然。
6. 场景描写具体。
7. 保持人物性格一致。
8. 保持世界观规则一致。
9. 章节末尾要有轻微悬念或剧情推进。
10. 尽量遵守用户给定的字数范围。
11. 如果提供了上一章内容，必须自然承接上一章结尾。
12. 不要突然引入没有铺垫的设定。
13. 不要把故事写成总结，要写成具体场景。
"""
    return _messages(user_prompt)


def build_summary_prompt(chapter_text: str, chapter_number: int | None = None) -> list[dict[str, str]]:
    chapter_label = f"第 {chapter_number} 章" if chapter_number else "本章"
    user_prompt = f"""
请为以下{chapter_label}正文生成 100 字以内摘要。

摘要必须包含：
1. 本章发生了什么。
2. 角色关系有什么变化。
3. 遗留了什么悬念。

要求：
- 不要超过 100 字。
- 不要输出无关说明。
- 只输出摘要正文。

## 章节正文
{_clip(chapter_text, 12000)}
"""
    return _messages(user_prompt)
