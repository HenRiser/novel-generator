from __future__ import annotations

from pathlib import Path
from typing import Any

import streamlit as st

from config import DEFAULT_MODEL
from deepseek_client import DeepSeekClientError, generate_text
from file_manager import (
    ensure_directories,
    find_latest_chapter,
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
    save_summary,
    update_chapter_index,
)
from prompt_templates import (
    build_chapter_prompt,
    build_character_prompt,
    build_outline_prompt,
    build_summary_prompt,
)


GENRE_OPTIONS = ["玄幻", "科幻", "悬疑", "校园", "都市", "赛博朋克", "克苏鲁", "武侠", "奇幻", "自定义"]
STYLE_OPTIONS = ["热血", "冷峻", "轻松", "黑暗", "文艺", "网文爽文", "日式轻小说", "细腻现实主义", "自定义"]
MODE_OPTIONS = ["生成小说大纲", "生成人物卡", "生成指定章节正文"]


def _init_session_state() -> None:
    defaults = {
        "title": "",
        "genre": "玄幻",
        "custom_genre": "",
        "style": "热血",
        "custom_style": "",
        "protagonist": "",
        "supporting_characters": "",
        "worldview": "",
        "core_conflict": "",
        "target_readers": "",
        "word_count_range": "3000-5000 字",
        "chapter_number": 1,
        "extra_requirements": "",
        "current_result": "",
        "current_file_name": "generated.md",
        "current_saved_path": "",
        "editable_result": "",
        "editable_source_path": "",
        "edited_saved_path": "",
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
        "style": _effective_choice(st.session_state.style, st.session_state.custom_style),
        "style_option": st.session_state.style,
        "custom_style": st.session_state.custom_style.strip(),
        "protagonist": st.session_state.protagonist.strip(),
        "supporting_characters": st.session_state.supporting_characters.strip(),
        "worldview": st.session_state.worldview.strip(),
        "core_conflict": st.session_state.core_conflict.strip(),
        "target_readers": st.session_state.target_readers.strip(),
        "word_count_range": st.session_state.word_count_range.strip(),
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
    st.session_state.style, st.session_state.custom_style = _load_choice(
        config.get("style_option"),
        config.get("style"),
        config.get("custom_style"),
        STYLE_OPTIONS,
    )
    st.session_state.protagonist = config.get("protagonist", "")
    st.session_state.supporting_characters = config.get("supporting_characters", "")
    st.session_state.worldview = config.get("worldview", "")
    st.session_state.core_conflict = config.get("core_conflict", "")
    st.session_state.target_readers = config.get("target_readers", "")
    st.session_state.word_count_range = config.get("word_count_range", "3000-5000 字")
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


def _format_messages_for_preview(messages: list[dict[str, str]]) -> str:
    parts = []
    for message in messages:
        role = message.get("role", "unknown")
        content = message.get("content", "")
        parts.append(f"## {role}\n\n{content}")
    return "\n\n---\n\n".join(parts)


def _build_messages(mode: str, project_config: dict[str, Any], chapter_number: int, use_previous_context: bool) -> tuple[list[dict[str, str]], list[str]]:
    notices = []

    if mode == "生成小说大纲":
        return build_outline_prompt(project_config), notices

    if mode == "生成人物卡":
        return build_character_prompt(project_config), notices

    outline, outline_path = read_latest_outline()
    characters, characters_path = read_latest_characters()
    previous_chapter = None
    previous_path = None
    summaries = read_history_summaries(before_chapter=chapter_number)

    if outline_path:
        notices.append(f"已加入大纲上下文：{outline_path.name}")
    if characters_path:
        notices.append(f"已加入人物卡上下文：{characters_path.name}")
    if summaries:
        notices.append("已加入历史章节摘要。")

    if use_previous_context:
        previous_chapter, previous_path = read_previous_chapter(chapter_number)
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


def _save_result(mode: str, content: str, chapter_number: int) -> Path:
    if mode == "生成小说大纲":
        return save_outline(content)
    if mode == "生成人物卡":
        return save_characters(content)
    return save_chapter(chapter_number, content)


def _generate_and_save(
    mode: str,
    messages: list[dict[str, str]],
    model: str,
    temperature: float,
    max_tokens: int,
    chapter_number: int,
) -> bool:
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

    saved_path = _save_result(mode, result, chapter_number)
    st.session_state.current_result = result
    st.session_state.current_file_name = saved_path.name
    st.session_state.current_saved_path = str(saved_path)
    st.session_state.editable_result = result
    st.session_state.editable_source_path = str(saved_path)
    st.session_state.edited_saved_path = ""
    st.success(f"生成成功，已保存：{saved_path}")

    if mode == "生成指定章节正文":
        summary = ""
        try:
            summary_messages = build_summary_prompt(result, chapter_number)
            summary = generate_text(
                messages=summary_messages,
                model=model,
                temperature=0.2,
                max_tokens=512,
            )
            summary_path = save_summary(chapter_number, summary)
            st.info(f"章节摘要已保存：{summary_path}")
        except DeepSeekClientError as exc:
            st.warning(f"章节正文已保存，但摘要生成失败：{exc}")

        index_path = update_chapter_index(
            chapter_number=chapter_number,
            chapter_file=saved_path,
            model=model,
            summary=summary,
        )
        st.info(f"章节索引已更新：{index_path}")

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

    load_col, save_col = st.columns(2)
    with load_col:
        if st.button("加载项目配置", use_container_width=True):
            try:
                config = load_project_config()
            except ValueError as exc:
                st.error(str(exc))
            else:
                if config is None:
                    st.info("还没有找到 outputs/project_config.json。")
                else:
                    _load_config_to_session(config)
                    st.success("项目配置已加载。")
                    st.rerun()

    with save_col:
        if st.button("保存项目配置", use_container_width=True):
            path = save_project_config(_collect_project_config())
            st.success(f"项目配置已保存：{path}")

    st.subheader("小说设定")
    st.text_input("小说标题", key="title")

    col1, col2 = st.columns(2)
    with col1:
        st.selectbox("小说类型", GENRE_OPTIONS, key="genre")
        if st.session_state.genre == "自定义":
            st.text_input("自定义小说类型", key="custom_genre")
    with col2:
        st.selectbox("写作风格", STYLE_OPTIONS, key="style")
        if st.session_state.style == "自定义":
            st.text_input("自定义写作风格", key="custom_style")

    st.text_area("主角设定", key="protagonist", height=110)
    st.text_area("重要配角设定", key="supporting_characters", height=110)
    st.text_area("世界观设定", key="worldview", height=130)
    st.text_area("故事核心冲突", key="core_conflict", height=100)

    col3, col4 = st.columns(2)
    with col3:
        st.text_input("目标读者", key="target_readers")
        st.text_input("单章字数范围", key="word_count_range")
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

    project_config = _collect_project_config()
    chapter_number = int(st.session_state.chapter_number)
    messages, notices = _build_messages(mode, project_config, chapter_number, use_previous_context)

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
            mode=mode,
            messages=messages,
            model=model,
            temperature=temperature,
            max_tokens=int(max_tokens),
            chapter_number=chapter_number,
        )

    if continue_clicked:
        latest_chapter_number, latest_chapter_path = find_latest_chapter()
        if latest_chapter_path is None:
            st.warning("未找到任何历史章节，请先生成第 1 章。")
        else:
            next_chapter_number = latest_chapter_number + 1
            continue_project_config = project_config

            try:
                saved_project_config = load_project_config()
            except ValueError as exc:
                st.warning(f"项目配置读取失败，将使用页面当前设定：{exc}")
            else:
                if saved_project_config:
                    continue_project_config = saved_project_config
                    st.info("已读取 outputs/project_config.json。")
                else:
                    st.info("未找到 outputs/project_config.json，将使用页面当前设定。")

            continue_messages, continue_notices = _build_messages(
                mode="生成指定章节正文",
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
                mode="生成指定章节正文",
                messages=continue_messages,
                model=model,
                temperature=temperature,
                max_tokens=int(max_tokens),
                chapter_number=next_chapter_number,
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
