from __future__ import annotations

from typing import Any

from config import MAX_PREVIOUS_CHAPTER_CHARS, MAX_REFERENCE_CHARS, MAX_SUMMARIES_CHARS


GLOBAL_SYSTEM_PROMPT = (
    "你是一名专业小说创作助手，擅长根据用户给定的题材、人物、世界观和叙事风格创作长篇小说。"
    "你必须严格遵守用户设定，保持人物性格一致、世界观规则一致、叙事节奏稳定。"
    "不要自称 AI，不要解释创作过程，直接输出作品内容。"
    "除非用户明确要求，否则不要输出分析、说明或与作品无关的列表。"
)


SETTING_EXPANSION_SYSTEM_PROMPT = (
    "你是一名小说设定开发助手，擅长将用户白话、不完整、松散的故事想法，"
    "扩写为结构化、可直接用于长篇小说创作的设定。"
    "你必须保留用户原始想法的核心，不要随意改题材、主角目标和核心矛盾。"
    "你可以补充合理细节，但不能覆盖用户明确给出的设定。"
    "当用户没有明确给出小说标题时，你需要根据故事题材、主角目标、世界观关键词和核心冲突，"
    "生成多个不同风格的小说标题候选，并选择一个最适合作为推荐标题。"
    "请只输出严格 JSON，不要输出 Markdown，不要输出解释。"
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


def build_expand_setting_prompt(
    raw_story_idea: str,
    detail_level: str,
    supplement_characters: bool,
    supplement_conflict: bool,
    supplement_world_rules: bool,
) -> list[dict[str, str]]:
    detail_level = _clean(detail_level) or "中"
    if detail_level not in {"低", "中", "高"}:
        detail_level = "中"

    detail_guidance = {
        "低": "每个字段约 150-250 字。",
        "中": "每个字段约 300-500 字。",
        "高": "每个字段约 600-900 字。",
    }
    character_guidance = (
        "supporting_characters_setting 至少包含 3 个重要配角。"
        if supplement_characters
        else "supporting_characters_setting 只输出 1-2 个最必要配角，不主动扩展庞大角色群。"
    )
    conflict_guidance = (
        "core_conflict 可以补充合理的反派、阻力、选择困境和长期推进方向。"
        if supplement_conflict
        else "core_conflict 只整理用户已提供的冲突，不主动增加复杂反转。"
    )
    world_guidance = (
        "world_setting 可以补充合理的世界规则、社会规则、技术或魔法限制。"
        if supplement_world_rules
        else "world_setting 只整理背景，不主动增加复杂规则。"
    )

    user_prompt = f"""
根据用户输入的白话设定，生成以下 JSON 字段：

{{
  "title_candidates": ["标题1", "标题2", "标题3", "标题4", "标题5"],
  "recommended_title": "推荐标题",
  "protagonist_setting": "...",
  "supporting_characters_setting": "...",
  "world_setting": "...",
  "core_conflict": "..."
}}

## 用户白话设定
{_clean(raw_story_idea)}

## 扩写详细程度
{detail_level}：{detail_guidance[detail_level]}

## 开关要求
- 是否补充配角：{supplement_characters}。{character_guidance}
- 是否补充核心冲突：{supplement_conflict}。{conflict_guidance}
- 是否补充世界规则：{supplement_world_rules}。{world_guidance}

## 标题字段要求

1. title_candidates
- 必须是字符串数组。
- 至少 5 个标题。
- 每个标题不超过 15 个中文字符，除非是网文风长标题。
- 5 个标题需要体现不同风格，例如短标题、网文风标题、文艺风标题、科幻或类型感强的标题、悬念感标题。
- 尽量避免“未命名小说”“我的小说”“故事标题”等占位标题。
- 尽量避免过于通用的标题。
- 标题要能体现小说的核心卖点。

2. recommended_title
- 必须是字符串。
- 必须从 title_candidates 中选择一个。
- 如果用户原始输入明确包含标题，则优先使用用户给定标题。
- 如果用户原始输入没有标题，则选择最贴合题材和主线冲突的标题。

## 设定字段要求

1. protagonist_setting
- 包含姓名
- 年龄
- 身份
- 外貌特征
- 性格
- 核心能力
- 过去经历
- 目标
- 恐惧
- 隐藏秘密
- 说话风格

2. supporting_characters_setting
- 每个配角包含：
  - 姓名
  - 身份
  - 外貌
  - 性格
  - 能力或作用
  - 与主角关系
  - 隐藏秘密
- 如果用户明确说不需要配角，则可以减少数量。

3. world_setting
- 包含时代背景
- 地点
- 社会结构
- 科技或魔法规则
- 阶层矛盾
- 日常生活状态
- 禁忌或限制
- 核心主题

4. core_conflict
- 包含表层冲突
- 深层冲突
- 反派或阻力来源
- 主角必须做出的选择
- 失败代价
- 长篇连载推进方向

## JSON 输出要求
1. 必须是合法 JSON。
2. 不要使用 Markdown 代码块。
3. 不要在 JSON 前后添加解释。
4. 字段名必须完全一致：
   - title_candidates
   - recommended_title
   - protagonist_setting
   - supporting_characters_setting
   - world_setting
   - core_conflict
5. title_candidates 使用字符串数组。
6. recommended_title 和四个设定字段使用字符串，不要使用对象，方便直接填入页面文本框。
7. 字符串内部可以使用换行符。
8. 如果用户原始描述中信息不足，请合理补充，但不要偏离原意。
"""
    return [
        {"role": "system", "content": SETTING_EXPANSION_SYSTEM_PROMPT},
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
