from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import streamlit as st

from config import DEFAULT_MODEL
from deepseek_client import DeepSeekClientError, generate_text
from file_manager import (
    ensure_directories,
    find_latest_chapter,
    get_project_dir,
    list_project_titles,
    load_project_config,
    read_history_summaries,
    read_latest_characters,
    read_latest_outline,
    read_previous_chapter,
    save_chapter,
    save_characters,
    save_edited_result,
    save_outline,
    save_project_config,
    save_setting_expansion,
    save_summary,
    update_chapter_index,
)
from prompt_templates import (
    build_chapter_prompt,
    build_chapter_title_prompt,
    build_character_prompt,
    build_expand_setting_prompt,
    build_outline_prompt,
    build_summary_prompt,
)


GENRE_OPTIONS = ["玄幻", "科幻", "悬疑", "校园", "都市", "赛博朋克", "克苏鲁", "武侠", "奇幻", "自定义"]
STYLE_OPTIONS = ["热血", "冷峻", "轻松", "黑暗", "文艺", "网文爽文", "日式轻小说", "细腻现实主义", "自定义"]
MODE_OPTIONS = ["生成小说大纲", "生成人物卡", "生成指定章节正文"]
OUTLINE_MODE = MODE_OPTIONS[0]
CHARACTER_MODE = MODE_OPTIONS[1]
CHAPTER_MODE = MODE_OPTIONS[2]
BATCH_MODE_CONTINUE_TO_TARGET = "自动续写到第 N 章"
BATCH_MODE_RANGE = "生成指定章节范围"
BATCH_MAX_CHAPTERS = 5
EXPAND_DETAIL_OPTIONS = ["低", "中", "高"]
REQUIRED_SETTING_EXPANSION_FIELDS = [
    "protagonist_setting",
    "supporting_characters_setting",
    "world_setting",
    "core_conflict",
]


def _init_session_state() -> None:
    defaults = {
        "title": "",
        "genre": "玄幻",
        "custom_genre": "",
        "writing_style": "热血",
        "custom_style": "",
        "protagonist_setting": "",
        "supporting_characters_setting": "",
        "world_setting": "",
        "core_conflict": "",
        "target_readers": "",
        "chapter_word_range": "3000-5000 字",
        "chapter_number": 1,
        "extra_requirements": "",
        "raw_story_idea": "",
        "expand_detail_level": "中",
        "supplement_characters": True,
        "supplement_conflict": True,
        "supplement_world_rules": True,
        "title_candidates": [],
        "recommended_title": "",
        "selected_title_candidate": "",
        "last_raw_story_idea": "",
        "last_setting_expansion_data": {},
        "selected_project_title": "",
        "selected_project_applied": "",
        "current_result": "",
        "current_file_name": "generated.md",
        "current_saved_path": "",
        "editable_result": "",
        "editable_source_path": "",
        "edited_saved_path": "",
        "batch_generation_mode": BATCH_MODE_CONTINUE_TO_TARGET,
        "target_chapter_number": 3,
        "start_chapter_number": 1,
        "end_chapter_number": 3,
    }
    for key, value in defaults.items():
        st.session_state.setdefault(key, value)


def _effective_choice(choice: str, custom_value: str) -> str:
    if choice == "自定义":
        return custom_value.strip() or "自定义"
    return choice


def _collect_project_config() -> dict[str, Any]:
    return {
        "title": st.session_state.title.strip() or "未命名小说",
        "genre": _effective_choice(st.session_state.genre, st.session_state.custom_genre),
        "genre_option": st.session_state.genre,
        "custom_genre": st.session_state.custom_genre.strip(),
        "style": _effective_choice(st.session_state.writing_style, st.session_state.custom_style),
        "style_option": st.session_state.writing_style,
        "custom_style": st.session_state.custom_style.strip(),
        "protagonist": st.session_state.protagonist_setting.strip(),
        "supporting_characters": st.session_state.supporting_characters_setting.strip(),
        "worldview": st.session_state.world_setting.strip(),
        "core_conflict": st.session_state.core_conflict.strip(),
        "target_readers": st.session_state.target_readers.strip(),
        "word_count_range": st.session_state.chapter_word_range.strip(),
        "extra_requirements": st.session_state.extra_requirements.strip(),
    }


def _load_config_to_session(config: dict[str, Any]) -> None:
    st.session_state.title = config.get("title", "")
    st.session_state.genre, st.session_state.custom_genre = _load_choice(
        config.get("genre_option"),
        config.get("genre"),
        config.get("custom_genre"),
        GENRE_OPTIONS,
    )
    st.session_state.writing_style, st.session_state.custom_style = _load_choice(
        config.get("style_option"),
        config.get("style"),
        config.get("custom_style"),
        STYLE_OPTIONS,
    )
    st.session_state.protagonist_setting = config.get("protagonist", "")
    st.session_state.supporting_characters_setting = config.get("supporting_characters", "")
    st.session_state.world_setting = config.get("worldview", "")
    st.session_state.core_conflict = config.get("core_conflict", "")
    st.session_state.target_readers = config.get("target_readers", "")
    st.session_state.chapter_word_range = config.get("word_count_range", "3000-5000 字")
    st.session_state.extra_requirements = config.get("extra_requirements", "")


def _load_choice(option_value: Any, final_value: Any, custom_value: Any, options: list[str]) -> tuple[str, str]:
    option_value = str(option_value or "").strip()
    final_value = str(final_value or "").strip()
    custom_value = str(custom_value or "").strip()

    if option_value in options:
        return option_value, custom_value
    if final_value in options:
        return final_value, custom_value
    if final_value:
        return "自定义", custom_value or final_value
    return options[0], custom_value


def _current_project_title() -> str:
    return st.session_state.title.strip() or "未命名小说"


def _format_messages_for_preview(messages: list[dict[str, str]]) -> str:
    parts = []
    for message in messages:
        role = message.get("role", "unknown")
        content = message.get("content", "")
        parts.append(f"## {role}\n\n{content}")
    return "\n\n---\n\n".join(parts)


def _save_pending_setting_expansion(title: str) -> Path | None:
    expanded_data = st.session_state.get("last_setting_expansion_data")
    raw_story_idea = st.session_state.get("last_raw_story_idea", "")
    if not raw_story_idea or not isinstance(expanded_data, dict) or not expanded_data:
        return None

    return save_setting_expansion(title, raw_story_idea, expanded_data)


def parse_setting_expansion_response(raw_text: str) -> dict[str, Any]:
    raw_text = (raw_text or "").strip()
    if not raw_text:
        raise ValueError("模型返回内容为空，无法解析 JSON。")

    try:
        data = json.loads(raw_text)
    except json.JSONDecodeError:
        start = raw_text.find("{")
        end = raw_text.rfind("}")
        if start == -1 or end == -1 or end <= start:
            raise ValueError("JSON 解析失败：返回内容中没有找到完整的 JSON 对象。")
        try:
            data = json.loads(raw_text[start : end + 1])
        except json.JSONDecodeError as exc:
            raise ValueError(f"JSON 解析失败：{exc}") from exc

    if not isinstance(data, dict):
        raise ValueError("JSON 解析失败：返回结果不是 JSON 对象。")

    missing_fields = [field for field in REQUIRED_SETTING_EXPANSION_FIELDS if field not in data]
    if missing_fields:
        raise ValueError(f"JSON 字段缺失：{', '.join(missing_fields)}")

    parsed: dict[str, Any] = {}
    for field in REQUIRED_SETTING_EXPANSION_FIELDS:
        value = data[field]
        if not isinstance(value, str):
            raise ValueError(f"JSON 字段类型错误：{field} 必须是字符串。")
        parsed[field] = value.strip()

    title_candidates = data.get("title_candidates", [])
    if not isinstance(title_candidates, list):
        title_candidates = []
    parsed["title_candidates"] = [
        str(title).strip()
        for title in title_candidates
        if isinstance(title, str) and title.strip()
    ]

    recommended_title = data.get("recommended_title", "")
    parsed["recommended_title"] = recommended_title.strip() if isinstance(recommended_title, str) else ""

    return parsed


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


def _build_messages(title: str, mode: str, project_config: dict[str, Any], chapter_number: int, use_previous_context: bool) -> tuple[list[dict[str, str]], list[str]]:
    notices = []

    if mode == OUTLINE_MODE:
        return build_outline_prompt(project_config), notices

    if mode == CHARACTER_MODE:
        return build_character_prompt(project_config), notices

    outline, outline_path = read_latest_outline(title)
    characters, characters_path = read_latest_characters(title)
    previous_chapter = None
    previous_path = None
    summaries = read_history_summaries(title, before_chapter=chapter_number)

    if outline_path:
        notices.append(f"已加入大纲上下文：{outline_path.name}")
    if characters_path:
        notices.append(f"已加入人物卡上下文：{characters_path.name}")
    if summaries:
        notices.append("已加入历史章节摘要。")

    if use_previous_context:
        previous_chapter, previous_path = read_previous_chapter(title, chapter_number)
        if previous_path:
            notices.append(f"已加入上一章正文：{previous_path.name}")
        else:
            notices.append("未找到上一章正文，将仅使用设定、大纲、人物卡和摘要生成。")

    messages = build_chapter_prompt(
        project_config=project_config,
        chapter_number=chapter_number,
        outline=outline,
        characters=characters,
        previous_chapter=previous_chapter,
        summaries=summaries,
    )
    return messages, notices


def _save_result(title: str, mode: str, content: str, chapter_number: int) -> Path:
    if mode == OUTLINE_MODE:
        return save_outline(title, content)
    if mode == CHARACTER_MODE:
        return save_characters(title, content)
    return save_chapter(title, chapter_number, content)


def _set_current_result(content: str, saved_path: Path) -> None:
    st.session_state.current_result = content
    st.session_state.current_file_name = saved_path.name
    st.session_state.current_saved_path = str(saved_path)
    st.session_state.editable_result = content
    st.session_state.editable_source_path = str(saved_path)
    st.session_state.edited_saved_path = ""


def generate_single_chapter_workflow(
    project_title: str,
    chapter_number: int,
    form_data: dict[str, Any],
    model: str,
    temperature: float,
    max_tokens: int,
    use_previous_context: bool,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "chapter_number": int(chapter_number),
        "chapter_title": "未命名章节",
        "chapter_path": "",
        "summary": "",
        "summary_path": "",
        "content": "",
        "notices": [],
        "title_error": None,
        "summary_error": None,
        "index_path": "",
        "error": None,
    }

    try:
        messages, notices = _build_messages(
            title=project_title,
            mode=CHAPTER_MODE,
            project_config=form_data,
            chapter_number=int(chapter_number),
            use_previous_context=use_previous_context,
        )
        result["notices"] = notices
        chapter_content = generate_text(
            messages=messages,
            model=model,
            temperature=temperature,
            max_tokens=int(max_tokens),
        )
    except DeepSeekClientError as exc:
        result["error"] = str(exc)
        return result

    try:
        title_messages = build_chapter_title_prompt(
            chapter_number=int(chapter_number),
            chapter_content=chapter_content,
            genre=form_data.get("genre", ""),
            writing_style=form_data.get("style", ""),
            core_conflict=form_data.get("core_conflict", ""),
        )
        raw_title = generate_text(
            messages=title_messages,
            model=model,
            temperature=min(float(temperature), 0.7),
            max_tokens=128,
        )
        chapter_title = clean_chapter_title(raw_title)
    except DeepSeekClientError as exc:
        chapter_title = "未命名章节"
        result["title_error"] = str(exc)

    final_content = apply_chapter_heading(chapter_content, int(chapter_number), chapter_title)
    result["chapter_title"] = chapter_title
    result["content"] = final_content

    try:
        chapter_path = save_chapter(project_title, int(chapter_number), final_content)
        _save_pending_setting_expansion(project_title)
    except Exception as exc:
        result["error"] = f"章节保存失败：{exc}"
        return result

    result["chapter_path"] = str(chapter_path)

    try:
        summary_messages = build_summary_prompt(final_content, int(chapter_number))
        summary = generate_text(
            messages=summary_messages,
            model=model,
            temperature=0.2,
            max_tokens=512,
        )
        summary_path = save_summary(project_title, int(chapter_number), summary)
        result["summary"] = summary
        result["summary_path"] = str(summary_path)
    except DeepSeekClientError as exc:
        result["summary_error"] = str(exc)
    except Exception as exc:
        result["summary_error"] = f"摘要保存失败：{exc}"

    try:
        index_path = update_chapter_index(
            title=project_title,
            chapter_number=int(chapter_number),
            chapter_title=chapter_title,
            chapter_path=Path(chapter_path),
            model=model,
            summary=result["summary"],
        )
        result["index_path"] = str(index_path)
    except Exception as exc:
        result["error"] = f"章节索引更新失败：{exc}"

    return result


def _show_chapter_workflow_result(result: dict[str, Any]) -> bool:
    chapter_number = result.get("chapter_number")
    chapter_title = result.get("chapter_title") or "未命名章节"
    chapter_path = result.get("chapter_path")

    if chapter_path and result.get("content"):
        _set_current_result(result["content"], Path(chapter_path))

    if result.get("error"):
        st.error(f"第 {chapter_number} 章生成流程失败：{result['error']}")
        return False

    st.success(f"第 {chapter_number} 章生成成功，已保存：{chapter_path}")
    st.info(f"章节标题：{chapter_title}")
    if result.get("title_error"):
        st.warning(f"章节标题生成失败，已使用兜底标题：{result['title_error']}")
    if result.get("summary_path"):
        st.info(f"章节摘要已保存：{result['summary_path']}")
    elif result.get("summary_error"):
        st.warning(f"章节正文已保存，但摘要生成失败：{result['summary_error']}")
    if result.get("index_path"):
        st.info(f"章节索引已更新：{result['index_path']}")
    return True


def _plan_batch_chapters(project_title: str) -> tuple[list[int], str | None]:
    latest_chapter_number, _ = find_latest_chapter(project_title)
    latest_chapter_number = int(latest_chapter_number or 0)
    expected_start = latest_chapter_number + 1 if latest_chapter_number else 1
    batch_mode = st.session_state.batch_generation_mode

    if batch_mode == BATCH_MODE_CONTINUE_TO_TARGET:
        target = int(st.session_state.target_chapter_number)
        if target < expected_start:
            return [], f"当前最新章节是第 {latest_chapter_number} 章，目标章节号必须至少为第 {expected_start} 章。"
        chapters = list(range(expected_start, target + 1))
    else:
        start = int(st.session_state.start_chapter_number)
        end = int(st.session_state.end_chapter_number)
        if end < start:
            return [], "结束章节号不能小于起始章节号。"
        if start != expected_start:
            return [], f"为避免跳章，起始章节必须是第 {expected_start} 章。"
        chapters = list(range(start, end + 1))

    if len(chapters) > BATCH_MAX_CHAPTERS:
        return [], f"一次最多生成 {BATCH_MAX_CHAPTERS} 章，请缩小范围。"
    if not chapters:
        return [], "没有需要生成的章节。"
    return chapters, None


def _generate_and_save(
    title: str,
    mode: str,
    messages: list[dict[str, str]],
    model: str,
    temperature: float,
    max_tokens: int,
    chapter_number: int,
    project_config: dict[str, Any] | None = None,
    use_previous_context: bool = False,
) -> bool:
    if mode == CHAPTER_MODE:
        with st.spinner("正在生成章节正文、章节标题和摘要..."):
            chapter_result = generate_single_chapter_workflow(
                project_title=title,
                chapter_number=chapter_number,
                form_data=project_config or _collect_project_config(),
                model=model,
                temperature=temperature,
                max_tokens=int(max_tokens),
                use_previous_context=use_previous_context,
            )
        return _show_chapter_workflow_result(chapter_result)

    with st.spinner("正在请求 DeepSeek 生成内容..."):
        try:
            result = generate_text(
                messages=messages,
                model=model,
                temperature=temperature,
                max_tokens=int(max_tokens),
            )
        except DeepSeekClientError as exc:
            st.error(str(exc))
            return False

    saved_path = _save_result(title, mode, result, chapter_number)
    _save_pending_setting_expansion(title)
    _set_current_result(result, saved_path)
    st.success(f"生成成功，已保存：{saved_path}")

    return True


def main() -> None:
    st.set_page_config(page_title="AI 小说生成器", layout="wide")
    ensure_directories()
    _init_session_state()

    st.title("AI 小说生成器")
    st.caption("本地运行的轻量小说创作工具：大纲、人物卡、章节正文、续写和上下文管理。")

    with st.sidebar:
        st.header("生成参数")
        model = st.text_input("model", value=DEFAULT_MODEL)
        temperature = st.slider("temperature", min_value=0.0, max_value=2.0, value=0.7, step=0.05)
        max_tokens = st.number_input("max_tokens", min_value=512, max_value=32768, value=4000, step=256)
        use_previous_context = st.checkbox("使用上一章上下文", value=True)
        project_options = [""] + list_project_titles()
        selected_project = st.selectbox("选择已有小说项目", project_options, key="selected_project_title")

    if selected_project and st.session_state.selected_project_applied != selected_project:
        st.session_state.title = selected_project
        st.session_state.selected_project_applied = selected_project

    load_col, save_col = st.columns(2)
    with load_col:
        if st.button("加载项目配置", use_container_width=True):
            try:
                config = load_project_config(_current_project_title())
            except ValueError as exc:
                st.error(str(exc))
            else:
                if config is None:
                    st.info(f"还没有找到当前小说项目的 project_config.json：{get_project_dir(_current_project_title())}")
                else:
                    _load_config_to_session(config)
                    st.success("项目配置已加载。")
                    st.rerun()

    with save_col:
        if st.button("保存项目配置", use_container_width=True):
            path = save_project_config(_current_project_title(), _collect_project_config())
            st.success(f"项目配置已保存：{path}")
            expansion_path = _save_pending_setting_expansion(_current_project_title())
            if expansion_path:
                st.info(f"最近一次设定扩写已保存：{expansion_path}")

    st.subheader("白话设定自动扩写")
    st.text_area(
        "输入你的白话设定",
        key="raw_story_idea",
        height=120,
        placeholder="例如：我想写一个赛博朋克故事，主角是失忆黑客，妹妹失踪了，城市被大公司控制，记忆可以被修改，主角要查真相。",
    )

    expand_col1, expand_col2, expand_col3, expand_col4 = st.columns(4)
    with expand_col1:
        st.selectbox("扩写详细程度", EXPAND_DETAIL_OPTIONS, key="expand_detail_level")
    with expand_col2:
        st.checkbox("是否补充配角", key="supplement_characters")
    with expand_col3:
        st.checkbox("是否补充核心冲突", key="supplement_conflict")
    with expand_col4:
        st.checkbox("是否补充世界规则", key="supplement_world_rules")

    expand_messages = build_expand_setting_prompt(
        raw_story_idea=st.session_state.raw_story_idea,
        detail_level=st.session_state.expand_detail_level,
        supplement_characters=st.session_state.supplement_characters,
        supplement_conflict=st.session_state.supplement_conflict,
        supplement_world_rules=st.session_state.supplement_world_rules,
    )

    expand_action_col1, expand_action_col2 = st.columns(2)
    with expand_action_col1:
        preview_expand_clicked = st.button("预览设定扩写 Prompt", use_container_width=True)
    with expand_action_col2:
        expand_and_fill_clicked = st.button("自动扩写并填入设定", use_container_width=True)

    if preview_expand_clicked:
        if not st.session_state.raw_story_idea.strip():
            st.warning("请先输入白话设定。")
        else:
            with st.expander("设定扩写 messages 预览", expanded=True):
                st.json(expand_messages, expanded=False)
                st.text_area("可复制设定扩写 Prompt", value=_format_messages_for_preview(expand_messages), height=420)

    if expand_and_fill_clicked:
        if not st.session_state.raw_story_idea.strip():
            st.warning("请先输入白话设定。")
        else:
            with st.spinner("正在扩写并拆分设定..."):
                try:
                    raw_response = generate_text(
                        messages=expand_messages,
                        model=model,
                        temperature=temperature,
                        max_tokens=int(max_tokens),
                    )
                    expanded_data = parse_setting_expansion_response(raw_response)
                except DeepSeekClientError as exc:
                    st.error(str(exc))
                except ValueError as exc:
                    st.error(str(exc))
                    if "raw_response" in locals():
                        st.text_area("模型原始返回内容", value=raw_response, height=260)
                else:
                    st.session_state.protagonist_setting = expanded_data["protagonist_setting"]
                    st.session_state.supporting_characters_setting = expanded_data["supporting_characters_setting"]
                    st.session_state.world_setting = expanded_data["world_setting"]
                    st.session_state.core_conflict = expanded_data["core_conflict"]
                    title_candidates = expanded_data.get("title_candidates", [])
                    recommended_title = expanded_data.get("recommended_title", "")
                    st.session_state.title_candidates = title_candidates
                    st.session_state.recommended_title = recommended_title
                    st.session_state.last_raw_story_idea = st.session_state.raw_story_idea
                    st.session_state.last_setting_expansion_data = expanded_data

                    current_title = st.session_state.title.strip()
                    should_fill_title = not current_title or current_title == "未命名小说"
                    if should_fill_title:
                        auto_title = recommended_title or (title_candidates[0] if title_candidates else "未命名小说")
                        st.session_state.title = auto_title
                        st.success(f"已根据白话设定自动生成并填入推荐标题：{auto_title}")
                    elif title_candidates:
                        st.info("检测到你已有小说标题，未自动覆盖；可从标题候选中手动选择。")

                    st.success("设定已扩写并填入")

    if st.session_state.title_candidates:
        st.write("标题候选：")
        st.write("、".join(st.session_state.title_candidates))
        # Title candidates are display-only. They must not create project directories.
        if st.session_state.selected_title_candidate not in st.session_state.title_candidates:
            st.session_state.selected_title_candidate = st.session_state.title_candidates[0]
        title_select_col, title_button_col = st.columns([3, 1])
        with title_select_col:
            st.selectbox("从候选标题中选择", st.session_state.title_candidates, key="selected_title_candidate")
        with title_button_col:
            if st.button("使用该标题", use_container_width=True):
                st.session_state.title = st.session_state.selected_title_candidate
                st.success(f"已使用标题：{st.session_state.selected_title_candidate}")

    st.subheader("小说设定")
    st.text_input("小说标题", key="title")
    st.caption(f"当前项目目录：{get_project_dir(_current_project_title())}")

    col1, col2 = st.columns(2)
    with col1:
        st.selectbox("小说类型", GENRE_OPTIONS, key="genre")
        if st.session_state.genre == "自定义":
            st.text_input("自定义小说类型", key="custom_genre")
    with col2:
        st.selectbox("写作风格", STYLE_OPTIONS, key="writing_style")
        if st.session_state.writing_style == "自定义":
            st.text_input("自定义写作风格", key="custom_style")

    st.text_area("主角设定", key="protagonist_setting", height=110)
    st.text_area("重要配角设定", key="supporting_characters_setting", height=110)
    st.text_area("世界观设定", key="world_setting", height=130)
    st.text_area("故事核心冲突", key="core_conflict", height=100)

    col3, col4 = st.columns(2)
    with col3:
        st.text_input("目标读者", key="target_readers")
        st.text_input("单章字数范围", key="chapter_word_range")
    with col4:
        st.number_input("想生成的章节编号", min_value=1, step=1, key="chapter_number")

    st.text_area(
        "额外要求",
        key="extra_requirements",
        height=120,
        placeholder="例如：第三人称、多对话、节奏快、禁止出现的内容、希望出现的桥段。",
    )

    st.subheader("生成模式")
    mode = st.radio("选择要生成的内容", MODE_OPTIONS, horizontal=True)

    project_title = _current_project_title()
    project_config = _collect_project_config()
    chapter_number = int(st.session_state.chapter_number)
    messages, notices = _build_messages(project_title, mode, project_config, chapter_number, use_previous_context)

    action_col1, action_col2, action_col3 = st.columns(3)
    with action_col1:
        preview_clicked = st.button("预览 Prompt", use_container_width=True)
    with action_col2:
        generate_clicked = st.button("开始生成", type="primary", use_container_width=True)
    with action_col3:
        continue_clicked = st.button("一键继续下一章", use_container_width=True)

    if notices:
        with st.expander("本次上下文提示", expanded=False):
            for notice in notices:
                st.write(notice)

    if preview_clicked:
        with st.expander("完整 messages 预览", expanded=True):
            st.json(messages, expanded=False)
            st.text_area("可复制 Prompt", value=_format_messages_for_preview(messages), height=420)

    if generate_clicked:
        _generate_and_save(
            title=project_title,
            mode=mode,
            messages=messages,
            model=model,
            temperature=temperature,
            max_tokens=int(max_tokens),
            chapter_number=chapter_number,
            project_config=project_config,
            use_previous_context=use_previous_context,
        )

    if continue_clicked:
        latest_chapter_number, latest_chapter_path = find_latest_chapter(project_title)
        if latest_chapter_path is None:
            st.warning("当前小说项目还没有章节，请先生成第 1 章。")
        else:
            next_chapter_number = latest_chapter_number + 1
            continue_project_config = project_config

            try:
                saved_project_config = load_project_config(project_title)
            except ValueError as exc:
                st.warning(f"项目配置读取失败，将使用页面当前设定：{exc}")
            else:
                if saved_project_config:
                    continue_project_config = saved_project_config
                    st.info(f"已读取当前小说项目配置：{get_project_dir(project_title)}")
                else:
                    st.info("未找到当前小说项目的 project_config.json，将使用页面当前设定。")

            continue_messages, continue_notices = _build_messages(
                title=project_title,
                mode=CHAPTER_MODE,
                project_config=continue_project_config,
                chapter_number=next_chapter_number,
                use_previous_context=True,
            )
            st.info(
                f"将从 {latest_chapter_path.name} 继续生成第 {next_chapter_number} 章，"
                "并已自动启用上一章上下文。"
            )
            if continue_notices:
                with st.expander("一键继续使用的上下文", expanded=False):
                    for notice in continue_notices:
                        st.write(notice)

            _generate_and_save(
                title=project_title,
                mode=CHAPTER_MODE,
                messages=continue_messages,
                model=model,
                temperature=temperature,
                max_tokens=int(max_tokens),
                chapter_number=next_chapter_number,
                project_config=continue_project_config,
                use_previous_context=True,
            )

    st.subheader("批量章节生成")
    batch_mode = st.selectbox(
        "批量生成模式",
        [BATCH_MODE_CONTINUE_TO_TARGET, BATCH_MODE_RANGE],
        key="batch_generation_mode",
    )
    if batch_mode == BATCH_MODE_CONTINUE_TO_TARGET:
        st.number_input("目标章节号", min_value=1, step=1, key="target_chapter_number")
    else:
        batch_start_col, batch_end_col = st.columns(2)
        with batch_start_col:
            st.number_input("起始章节号", min_value=1, step=1, key="start_chapter_number")
        with batch_end_col:
            st.number_input("结束章节号", min_value=1, step=1, key="end_chapter_number")

    batch_clicked = st.button("批量生成章节", use_container_width=True)
    if batch_clicked:
        chapters_to_generate, batch_error = _plan_batch_chapters(project_title)
        if batch_error:
            st.warning(batch_error)
        else:
            st.info(f"将按顺序生成：{', '.join(f'第 {number} 章' for number in chapters_to_generate)}")
            progress = st.progress(0)
            successful_results: list[dict[str, Any]] = []
            failed_result: dict[str, Any] | None = None

            for index, batch_chapter_number in enumerate(chapters_to_generate, start=1):
                with st.status(f"正在生成第 {batch_chapter_number} 章", expanded=True) as status:
                    batch_result = generate_single_chapter_workflow(
                        project_title=project_title,
                        chapter_number=batch_chapter_number,
                        form_data=project_config,
                        model=model,
                        temperature=temperature,
                        max_tokens=int(max_tokens),
                        use_previous_context=True,
                    )
                    if batch_result.get("error"):
                        failed_result = batch_result
                        status.update(label=f"第 {batch_chapter_number} 章生成失败", state="error")
                        st.error(batch_result["error"])
                        break

                    successful_results.append(batch_result)
                    status.update(label=f"第 {batch_chapter_number} 章生成成功", state="complete")
                    st.write(f"章节标题：{batch_result['chapter_title']}")
                    st.write(f"保存路径：{batch_result['chapter_path']}")
                    if batch_result.get("summary_path"):
                        st.write(f"摘要已保存：{batch_result['summary_path']}")
                    elif batch_result.get("summary_error"):
                        st.warning(f"摘要生成失败：{batch_result['summary_error']}")

                progress.progress(index / len(chapters_to_generate))

            if successful_results:
                last_result = successful_results[-1]
                _set_current_result(last_result["content"], Path(last_result["chapter_path"]))
                st.success(f"批量生成完成：成功生成 {len(successful_results)} 章。")
                for item in successful_results:
                    st.write(f"第 {item['chapter_number']} 章：{item['chapter_title']}，{item['chapter_path']}")
            if failed_result:
                st.warning(
                    f"批量生成已停止：第 {failed_result['chapter_number']} 章失败。"
                    f"已成功生成 {len(successful_results)} 章。"
                )

    if st.session_state.current_result:
        st.subheader("当前生成结果")
        st.markdown(st.session_state.current_result)

        st.subheader("编辑生成结果")
        st.text_area(
            "可编辑 Markdown",
            key="editable_result",
            height=420,
        )

        if st.button("保存编辑后的版本", use_container_width=True):
            if not st.session_state.editable_source_path:
                st.warning("还没有可保存的原始生成文件，请先生成内容。")
            elif not st.session_state.editable_result.strip():
                st.warning("编辑内容为空，未保存。")
            else:
                edited_path = save_edited_result(
                    project_title,
                    st.session_state.editable_source_path,
                    st.session_state.editable_result,
                )
                st.session_state.edited_saved_path = str(edited_path)
                st.success(f"编辑后的版本已保存：{edited_path}")

        if st.session_state.edited_saved_path:
            st.caption(f"最近编辑版保存路径：{st.session_state.edited_saved_path}")

        st.download_button(
            "下载当前生成结果为 md 文件",
            data=st.session_state.current_result,
            file_name=st.session_state.current_file_name,
            mime="text/markdown",
            use_container_width=True,
        )

        if st.session_state.current_saved_path:
            st.caption(f"最近保存路径：{st.session_state.current_saved_path}")


if __name__ == "__main__":
    main()
