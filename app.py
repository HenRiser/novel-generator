from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

import streamlit as st
import streamlit.components.v1 as components

from config import DEFAULT_MODEL, DEFAULT_MODEL_SETTINGS, DEEPSEEK_MODELS, OUTPUT_DIR, PROJECT_ROOT
from config_manager import (
    get_api_key_status,
    get_available_models,
    get_current_default_model,
    has_api_key,
    resolve_selected_model,
    save_api_config,
    test_api_connection,
)
from deepseek_client import DeepSeekClientError, generate_text
from export_service import (
    build_full_novel_txt,
    build_reader_html,
    build_single_chapter_txt,
    get_ordered_chapters,
    read_chapter_for_reader,
)
from generation_config import (
    GENRE_OPTIONS as SETTING_GENRE_OPTIONS,
    OUTLINE_GRANULARITY_OPTIONS,
    PLOT_DENSITY_OPTIONS,
    NARRATIVE_PACE_OPTIONS,
    WORLD_COMPLEXITY_OPTIONS,
    CHARACTER_SCALE_OPTIONS,
    WRITING_MODE_OPTIONS,
    WRITING_STYLE_OPTIONS as SETTING_WRITING_STYLE_OPTIONS,
    normalize_setting_options,
    setting_options_to_dict,
)
from file_manager import (
    ensure_directories,
    find_latest_chapter,
    get_project_dir,
    list_chapter_files,
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
LEGACY_MODEL_MAP = {
    "deepseek-chat": "deepseek-v4-flash",
    "deepseek-reasoner": "deepseek-v4-pro",
    "deepseek-coder": "deepseek-v4-flash",
}
TASK_MODEL_KEYS = {
    "setting_expansion": ("setting_expansion_model", "custom_setting_expansion_model"),
    "outline": ("outline_model", "custom_outline_model"),
    "character": ("character_model", "custom_character_model"),
    "chapter": ("chapter_model", "custom_chapter_model"),
    "chapter_title": ("chapter_title_model", "custom_chapter_title_model"),
    "summary": ("summary_model", "custom_summary_model"),
}


def _normalize_model_name(model_name: Any) -> str:
    model_name = str(model_name or "").strip()
    return LEGACY_MODEL_MAP.get(model_name, model_name)


def normalize_model_settings(raw_settings: Any) -> dict[str, Any]:
    raw_settings = raw_settings if isinstance(raw_settings, dict) else {}
    settings = dict(DEFAULT_MODEL_SETTINGS)
    settings["use_unified_model"] = bool(raw_settings.get("use_unified_model", settings["use_unified_model"]))

    model_keys = ["unified_model"] + [model_key for model_key, _ in TASK_MODEL_KEYS.values()]
    for model_key in model_keys:
        custom_key = f"custom_{model_key}"
        raw_choice = _normalize_model_name(raw_settings.get(model_key, settings[model_key]))
        raw_custom = _normalize_model_name(raw_settings.get(custom_key, settings.get(custom_key, "")))

        if raw_choice in DEEPSEEK_MODELS:
            settings[model_key] = raw_choice
            settings[custom_key] = raw_custom
        elif raw_choice:
            settings[model_key] = "custom"
            settings[custom_key] = raw_custom or raw_choice
        else:
            settings[model_key] = DEFAULT_MODEL
            settings[custom_key] = raw_custom

    return settings


def resolve_model(model_choice: str, custom_model: str, fallback: str = DEFAULT_MODEL) -> str:
    model_choice = _normalize_model_name(model_choice)
    custom_model = _normalize_model_name(custom_model)
    fallback = _normalize_model_name(fallback) or DEFAULT_MODEL

    if model_choice != "custom":
        return model_choice or fallback
    return custom_model.strip() or fallback


def _model_choice_from_model(model_name: str) -> tuple[str, str]:
    model_name = _normalize_model_name(model_name)
    if model_name in DEEPSEEK_MODELS and model_name != "custom":
        return model_name, ""
    return "custom", model_name if model_name else ""


def get_task_models_from_state() -> dict[str, str]:
    if st.session_state.get("use_unified_model", True):
        unified_model = resolve_model(
            st.session_state.get("unified_model", DEFAULT_MODEL),
            st.session_state.get("custom_unified_model", ""),
        )
        return {task_name: unified_model for task_name in TASK_MODEL_KEYS}

    return {
        task_name: resolve_model(
            st.session_state.get(model_key, DEFAULT_MODEL),
            st.session_state.get(custom_key, ""),
        )
        for task_name, (model_key, custom_key) in TASK_MODEL_KEYS.items()
    }


def _model_settings_from_state() -> dict[str, Any]:
    settings = {}
    for key in DEFAULT_MODEL_SETTINGS:
        value = st.session_state.get(key, DEFAULT_MODEL_SETTINGS[key])
        settings[key] = _normalize_model_name(value) if isinstance(value, str) else bool(value)
    return normalize_model_settings(settings)


def _load_model_settings_to_session(raw_settings: Any) -> None:
    for key, value in normalize_model_settings(raw_settings).items():
        st.session_state[key] = value


def _model_for_mode(mode: str, task_models: dict[str, str]) -> str:
    if mode == OUTLINE_MODE:
        return task_models["outline"]
    if mode == CHARACTER_MODE:
        return task_models["character"]
    return task_models["chapter"]


def _render_model_choice(label: str, model_key: str, custom_key: str) -> None:
    st.selectbox(label, DEEPSEEK_MODELS, key=model_key)
    if st.session_state.get(model_key) == "custom":
        st.text_input(f"自定义{label}", key=custom_key)
        if not st.session_state.get(custom_key, "").strip():
            st.warning(f"{label}已选择 custom，但未填写自定义模型名，将使用 {DEFAULT_MODEL}。")


def _is_api_key_configured() -> bool:
    return has_api_key()


def _status_text(exists: bool) -> str:
    return "已找到" if exists else "未找到"


def _render_environment_status() -> None:
    env_path = PROJECT_ROOT / ".env"
    venv_path = PROJECT_ROOT / ".venv"
    outputs_exists = OUTPUT_DIR.exists()
    api_status = get_api_key_status()
    api_key_configured = bool(api_status["configured"])

    st.header("环境状态")
    st.caption(f"项目根目录：{PROJECT_ROOT}")
    st.write(f"- .env：{_status_text(env_path.exists())}")
    st.write(f"- API Key：{'已配置' if api_key_configured else '未配置'}")
    st.write(f"- 默认模型：{api_status['default_model']}")
    st.write(f"- outputs：{'已找到' if outputs_exists else '自动创建'}")
    st.write(f"- 虚拟环境：{_status_text(venv_path.exists())}")
    st.write("- Streamlit：已启动")

    if not api_key_configured:
        st.warning("未检测到 DEEPSEEK_API_KEY。请打开 Quick Start 配置 DeepSeek API Key。")


def _apply_default_model_to_session(model_name: str) -> None:
    model_choice, custom_model = _model_choice_from_model(model_name)
    st.session_state.use_unified_model = True
    st.session_state.unified_model = model_choice
    st.session_state.custom_unified_model = custom_model

    for model_key, custom_key in TASK_MODEL_KEYS.values():
        st.session_state[model_key] = model_choice
        st.session_state[custom_key] = custom_model


def _render_help_content() -> None:
    st.markdown(
        """
### API Key 配置

本项目是本地单用户工具。DeepSeek API Key 默认保存到项目根目录的 `.env`，页面不会显示已有 Key 明文；需要更换时重新打开 Quick Start，输入新 Key 并保存。

### 模型选择

- `deepseek-v4-flash`：默认选项，优先速度和成本。
- `deepseek-v4-pro`：优先质量，适合复杂设定、大纲和长上下文任务。
- `custom`：自行输入模型名，测试和生成时会直接传给 DeepSeek API。

### 第一本小说快速流程

1. 输入小说标题。
2. 输入白话设定。
3. 选择小说类型和写作风格。
4. 点击白话扩写。
5. 生成大纲。
6. 生成人物卡。
7. 生成第 1 章。
8. 使用一键继续下一章。

### 文件位置

生成结果保存在 `outputs/小说标题/`，包含 `project_config.json`、大纲、人物卡、章节、摘要和章节索引。当前版本没有引入数据库，也不会把 API Key 写入 `project_config.json`。

### 常见问题

- API Key 未配置：打开 Quick Start，在密码输入框填写 DeepSeek API Key 后保存。
- 修改 API Key：重新打开 Quick Start，输入新 Key 并保存覆盖本地 `.env`。
- 连接测试失败：检查 Key 是否有效、模型名是否正确，以及本机网络或代理是否能访问 DeepSeek。
- 重新打开 Quick Start：使用侧边栏的“打开 Quick Start / Help”按钮。
- `.env` 在哪里：位于项目根目录 `D:\\vibecoding\\novel-generator\\.env`，已被 Git 忽略。
"""
    )


def _render_quick_start_wizard() -> None:
    api_status = get_api_key_status()
    models = get_available_models()
    current_model = get_current_default_model()
    default_choice, default_custom = _model_choice_from_model(current_model)

    if st.session_state.get("quick_start_model_choice") not in models:
        st.session_state.quick_start_model_choice = default_choice
    st.session_state.setdefault("quick_start_custom_model", default_custom)

    st.subheader("Quick Start Wizard")
    st.caption("配置 DeepSeek API Key、默认模型并做一次最小连接测试。")

    tab_welcome, tab_api, tab_model, tab_test, tab_save, tab_help = st.tabs(
        ["1 欢迎", "2 API Key", "3 模型", "4 连接测试", "5 保存", "6 教程"]
    )

    with tab_welcome:
        st.write("这是本地优先的 AI 小说生成工具，面向单用户本地运行。")
        st.write("你需要使用自己的 DeepSeek API Key。API Key 会保存到本地 `.env`，不会写入 Git、页面明文或项目配置文件。")

    with tab_api:
        if api_status["configured"]:
            st.success("本地已配置 API Key。页面不会显示已有 Key 明文。")
        else:
            st.warning("尚未检测到可用的 DeepSeek API Key。")

        st.text_input(
            "DeepSeek API Key",
            key="quick_start_api_key",
            type="password",
            placeholder="输入新的 API Key；已有 Key 不会明文回显",
        )

    with tab_model:
        st.selectbox("默认模型", models, key="quick_start_model_choice")
        if st.session_state.quick_start_model_choice == "custom":
            st.text_input(
                "自定义模型名",
                key="quick_start_custom_model",
                placeholder="例如：deepseek-v4-flash",
            )

        selected_model = resolve_selected_model(
            st.session_state.quick_start_model_choice,
            st.session_state.get("quick_start_custom_model", ""),
        )
        st.info(f"当前将使用模型：{selected_model}")

    with tab_test:
        selected_model = resolve_selected_model(
            st.session_state.quick_start_model_choice,
            st.session_state.get("quick_start_custom_model", ""),
        )
        if st.button("测试连接", use_container_width=True):
            with st.spinner("正在测试 DeepSeek 连接..."):
                ok, message = test_api_connection(
                    api_key=st.session_state.get("quick_start_api_key", ""),
                    model=selected_model,
                )
            st.session_state.quick_start_connection_ok = ok
            st.session_state.quick_start_connection_message = message

        if st.session_state.get("quick_start_connection_message"):
            if st.session_state.get("quick_start_connection_ok"):
                st.success(st.session_state.quick_start_connection_message)
            else:
                st.error(st.session_state.quick_start_connection_message)

        st.caption("如果输入框为空但本地 `.env` 已配置 API Key，将使用本地 Key 做测试；失败不会保存配置。")

    with tab_save:
        st.write("保存会更新本地 `.env` 中的 `DEEPSEEK_API_KEY` 和 `DEFAULT_MODEL`，不会删除其他字段。")
        if st.button("保存 API 与模型配置", type="primary", use_container_width=True):
            api_key = st.session_state.get("quick_start_api_key", "").strip()
            if not api_key:
                st.warning("保存配置需要重新输入 API Key；已有 Key 不会明文回显。")
            else:
                try:
                    saved_model = save_api_config(
                        api_key=api_key,
                        default_model=st.session_state.quick_start_model_choice,
                        custom_model=st.session_state.get("quick_start_custom_model", ""),
                    )
                except ValueError as exc:
                    st.error(str(exc))
                else:
                    _apply_default_model_to_session(saved_model)
                    st.session_state.show_quick_start = False
                    st.session_state.quick_start_connection_message = ""
                    st.success("配置已保存到本地 .env，页面将刷新以使用新配置。")
                    st.rerun()

        if api_status["configured"] and st.button("完成并进入主界面", use_container_width=True):
            st.session_state.show_quick_start = False
            st.rerun()

    with tab_help:
        _render_help_content()


def _count_summary_files(project_dir: Path) -> int:
    summaries_dir = project_dir / "summaries"
    if not summaries_dir.exists():
        return 0
    return len([path for path in summaries_dir.glob("chapter_*_summary*.md") if path.is_file()])


def _render_project_status(project_title: str) -> None:
    project_dir = get_project_dir(project_title)
    st.header("当前项目状态")
    st.write(f"- 小说标题：{project_title}")
    st.write(f"- 项目目录：{project_dir}")
    st.write(f"- 项目配置：{'已保存' if (project_dir / 'project_config.json').exists() else '未保存'}")
    st.write(f"- 小说大纲：{'已生成' if (project_dir / 'novel_outline.md').exists() else '未生成'}")
    st.write(f"- 人物卡：{'已生成' if (project_dir / 'characters.md').exists() else '未生成'}")
    st.write(f"- 章节数量：{len(list_chapter_files(project_title))}")
    st.write(f"- 摘要数量：{_count_summary_files(project_dir)}")
    st.write(f"- 章节索引：{'已生成' if (project_dir / 'chapter_index.md').exists() else '未生成'}")

    if st.button("打开当前小说输出目录", use_container_width=True):
        try:
            project_dir.mkdir(parents=True, exist_ok=True)
            startfile = getattr(os, "startfile", None)
            if startfile is None:
                raise OSError("当前系统不支持 os.startfile")
            startfile(str(project_dir))
        except Exception:
            st.warning("当前运行环境无法直接打开你本机文件夹。可以使用“导出与阅读”区域在线阅读或下载 TXT。")
            st.caption(f"服务器/本地项目路径：{project_dir}")
        else:
            st.success("已打开当前小说输出目录。")


def _safe_download_filename(name: str) -> str:
    safe_name = re.sub(r'[<>:"/\\|?*\s]+', "_", str(name or "").strip())
    safe_name = safe_name.strip("._")
    return safe_name or "未命名小说"


def _render_reader_nav(numbers: list[int], current_index: int, key_prefix: str) -> None:
    prev_col, next_col = st.columns(2)
    with prev_col:
        if st.button("上一章", disabled=current_index <= 0, use_container_width=True, key=f"{key_prefix}_prev"):
            st.session_state.reader_center_expanded = True
            st.session_state.reader_should_scroll_top = True
            st.session_state.reader_chapter_number = numbers[current_index - 1]
            st.rerun()
    with next_col:
        if st.button(
            "下一章",
            disabled=current_index >= len(numbers) - 1,
            use_container_width=True,
            key=f"{key_prefix}_next",
        ):
            st.session_state.reader_center_expanded = True
            st.session_state.reader_should_scroll_top = True
            st.session_state.reader_chapter_number = numbers[current_index + 1]
            st.rerun()


def _render_reader_export_center(project_title: str) -> None:
    with st.expander("导出与阅读", expanded=bool(st.session_state.get("reader_center_expanded", False))):
        chapters = get_ordered_chapters(project_title)
        if not chapters:
            st.info("当前项目还没有章节，请先生成章节。")
            return

        st.markdown('<div id="reader-top"></div>', unsafe_allow_html=True)
        st.markdown("[回到阅读区顶部](#reader-top)")

        numbers = [int(chapter["chapter_number"]) for chapter in chapters]
        labels = {int(chapter["chapter_number"]): str(chapter["title"]) for chapter in chapters}
        current_number = int(st.session_state.get("reader_chapter_number", numbers[0]))
        if current_number not in numbers:
            current_number = numbers[0]
            st.session_state.reader_chapter_number = current_number

        selected_number = st.selectbox(
            "选择章节",
            numbers,
            index=numbers.index(current_number),
            format_func=lambda number: labels.get(int(number), f"第 {int(number)} 章"),
        )
        current_number = int(selected_number)
        if current_number != st.session_state.get("reader_chapter_number"):
            st.session_state.reader_should_scroll_top = True
        st.session_state.reader_chapter_number = current_number
        current_index = numbers.index(current_number)

        _render_reader_nav(numbers, current_index, "reader_top")

        try:
            chapter = read_chapter_for_reader(project_title, current_number)
        except FileNotFoundError as exc:
            st.warning(str(exc))
            return

        reader_html = build_reader_html(chapter["title"], chapter["content"])
        st.markdown(reader_html, unsafe_allow_html=True)
        if st.session_state.get("reader_should_scroll_top"):
            components.html(
                """
<script>
const readerTop = window.parent.document.getElementById("reader-top");
if (readerTop) {
  readerTop.scrollIntoView({ behavior: "smooth", block: "start" });
}
</script>
""",
                height=0,
            )
            st.session_state.reader_should_scroll_top = False

        _render_reader_nav(numbers, current_index, "reader_bottom")

        safe_project_name = _safe_download_filename(project_title)
        current_txt = build_single_chapter_txt(chapter["title"], chapter["content"])
        st.download_button(
            "下载当前章节 TXT",
            data=current_txt,
            file_name=f"{safe_project_name}_chapter_{current_number:03d}.txt",
            mime="text/plain",
            use_container_width=True,
        )

        full_txt = build_full_novel_txt(project_title)
        st.download_button(
            "下载整本正文 TXT",
            data=full_txt,
            file_name=f"{safe_project_name}_全文.txt",
            mime="text/plain",
            disabled=not bool(full_txt.strip()),
            use_container_width=True,
        )


def _init_session_state() -> None:
    default_model = get_current_default_model()
    default_model_choice, default_custom_model = _model_choice_from_model(default_model)
    default_model_settings = dict(DEFAULT_MODEL_SETTINGS)
    default_model_settings["unified_model"] = default_model_choice
    default_model_settings["custom_unified_model"] = default_custom_model
    for model_key, custom_key in TASK_MODEL_KEYS.values():
        default_model_settings[model_key] = default_model_choice
        default_model_settings[custom_key] = default_custom_model

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
        "current_model_info": {},
        "reader_center_expanded": False,
        "reader_chapter_number": 1,
        "reader_should_scroll_top": False,
        "setting_generation_genre": "赛博朋克",
        "custom_setting_generation_genre": "",
        "setting_generation_writing_style": "阴郁电影感",
        "custom_setting_generation_writing_style": "",
        "setting_generation_writing_mode": "长篇连载",
        "setting_expected_chapters": 12,
        "setting_plot_density": "中：平衡",
        "setting_narrative_pace": "中",
        "setting_world_complexity": "中",
        "setting_character_scale": "中等角色群",
        "setting_outline_granularity": "标准",
        "setting_extra_requirements": "",
        "show_quick_start": False,
        "quick_start_api_key": "",
        "quick_start_model_choice": default_model_choice,
        "quick_start_custom_model": default_custom_model,
        "quick_start_connection_ok": False,
        "quick_start_connection_message": "",
    }
    defaults.update(default_model_settings)
    for key, value in defaults.items():
        st.session_state.setdefault(key, value)

    normalized_settings = normalize_model_settings(
        {key: st.session_state.get(key) for key in DEFAULT_MODEL_SETTINGS}
    )
    for key, value in normalized_settings.items():
        st.session_state[key] = value


def _effective_choice(choice: str, custom_value: str) -> str:
    if choice == "自定义":
        return custom_value.strip() or "自定义"
    return choice


def _effective_setting_choice(choice: str, custom_value: str, default: str) -> str:
    if choice == "自定义":
        return custom_value.strip() or default
    return choice or default


def _setting_choice_from_value(value: Any, options: list[str], default: str) -> tuple[str, str]:
    value = str(value or "").strip()
    if value in options:
        return value, ""
    if value:
        return "自定义", value
    return default, ""


def _setting_generation_options_from_state() -> dict[str, Any]:
    raw_options = {
        "genre": _effective_setting_choice(
            st.session_state.setting_generation_genre,
            st.session_state.custom_setting_generation_genre,
            "赛博朋克",
        ),
        "writing_style": _effective_setting_choice(
            st.session_state.setting_generation_writing_style,
            st.session_state.custom_setting_generation_writing_style,
            "阴郁电影感",
        ),
        "writing_mode": st.session_state.setting_generation_writing_mode,
        "expected_chapters": int(st.session_state.setting_expected_chapters),
        "plot_density": st.session_state.setting_plot_density,
        "narrative_pace": st.session_state.setting_narrative_pace,
        "world_complexity": st.session_state.setting_world_complexity,
        "character_scale": st.session_state.setting_character_scale,
        "outline_granularity": st.session_state.setting_outline_granularity,
        "extra_requirements": st.session_state.setting_extra_requirements.strip(),
    }
    return setting_options_to_dict(raw_options)


def _load_setting_generation_options_to_session(raw_options: Any) -> None:
    options = normalize_setting_options(raw_options)
    genre_choice, custom_genre = _setting_choice_from_value(options.genre, SETTING_GENRE_OPTIONS, "赛博朋克")
    style_choice, custom_style = _setting_choice_from_value(
        options.writing_style,
        SETTING_WRITING_STYLE_OPTIONS,
        "阴郁电影感",
    )

    st.session_state.setting_generation_genre = genre_choice
    st.session_state.custom_setting_generation_genre = custom_genre
    st.session_state.setting_generation_writing_style = style_choice
    st.session_state.custom_setting_generation_writing_style = custom_style
    st.session_state.setting_generation_writing_mode = options.writing_mode
    st.session_state.setting_expected_chapters = options.expected_chapters
    st.session_state.setting_plot_density = options.plot_density
    st.session_state.setting_narrative_pace = options.narrative_pace
    st.session_state.setting_world_complexity = options.world_complexity
    st.session_state.setting_character_scale = options.character_scale
    st.session_state.setting_outline_granularity = options.outline_granularity
    st.session_state.setting_extra_requirements = options.extra_requirements


def _render_setting_generation_config() -> None:
    st.subheader("设定配置")
    quick_cols = st.columns(4)
    with quick_cols[0]:
        st.selectbox("小说类型", SETTING_GENRE_OPTIONS, key="setting_generation_genre")
    with quick_cols[1]:
        st.selectbox("写作风格", SETTING_WRITING_STYLE_OPTIONS, key="setting_generation_writing_style")
    with quick_cols[2]:
        st.selectbox("写作模式", WRITING_MODE_OPTIONS, key="setting_generation_writing_mode")
    with quick_cols[3]:
        st.number_input("期望章节数", min_value=1, max_value=200, step=1, key="setting_expected_chapters")

    custom_cols = st.columns(2)
    if st.session_state.setting_generation_genre == "自定义":
        with custom_cols[0]:
            st.text_input("自定义小说类型", key="custom_setting_generation_genre")
    if st.session_state.setting_generation_writing_style == "自定义":
        with custom_cols[1]:
            st.text_input("自定义写作风格", key="custom_setting_generation_writing_style")

    expected_chapters = int(st.session_state.setting_expected_chapters)
    if expected_chapters <= 5 and st.session_state.setting_generation_writing_mode == "长篇连载":
        st.warning("期望章节数较少，将优先按短篇/单章结构处理。")
    if expected_chapters > 40 and st.session_state.setting_generation_writing_mode == "单章完整故事":
        st.warning("期望章节数较多，将优先按长篇连载结构处理。")

    with st.expander("高级配置", expanded=False):
        advanced_col1, advanced_col2, advanced_col3 = st.columns(3)
        with advanced_col1:
            st.selectbox("剧情密度", PLOT_DENSITY_OPTIONS, key="setting_plot_density")
            st.selectbox("叙事节奏", NARRATIVE_PACE_OPTIONS, key="setting_narrative_pace")
        with advanced_col2:
            st.selectbox("世界观复杂度", WORLD_COMPLEXITY_OPTIONS, key="setting_world_complexity")
            st.selectbox("角色规模", CHARACTER_SCALE_OPTIONS, key="setting_character_scale")
        with advanced_col3:
            st.selectbox("大纲粒度", OUTLINE_GRANULARITY_OPTIONS, key="setting_outline_granularity")
            st.selectbox("扩写详细程度", EXPAND_DETAIL_OPTIONS, key="expand_detail_level")

        supplement_col1, supplement_col2, supplement_col3 = st.columns(3)
        with supplement_col1:
            st.checkbox("是否补充配角", key="supplement_characters")
        with supplement_col2:
            st.checkbox("是否补充核心冲突", key="supplement_conflict")
        with supplement_col3:
            st.checkbox("是否补充世界规则", key="supplement_world_rules")

        st.text_area(
            "额外创作要求",
            key="setting_extra_requirements",
            height=90,
            placeholder="可填写禁用内容、偏好桥段、叙事禁忌或特定参考方向。",
        )


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
        "model_settings": _model_settings_from_state(),
        "setting_generation_options": _setting_generation_options_from_state(),
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
    _load_model_settings_to_session(config.get("model_settings", DEFAULT_MODEL_SETTINGS))
    _load_setting_generation_options_to_session(config.get("setting_generation_options", {}))


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


def _set_current_model_info(model_info: dict[str, str]) -> None:
    st.session_state.current_model_info = model_info


def generate_single_chapter_workflow(
    project_title: str,
    chapter_number: int,
    form_data: dict[str, Any],
    task_models: dict[str, str],
    temperature: float,
    max_tokens: int,
    use_previous_context: bool,
) -> dict[str, Any]:
    chapter_model = task_models["chapter"]
    chapter_title_model = chapter_model
    summary_model = task_models["summary"]
    result: dict[str, Any] = {
        "chapter_number": int(chapter_number),
        "chapter_title": "未命名章节",
        "chapter_model": chapter_model,
        "chapter_title_model": chapter_title_model,
        "summary_model": summary_model,
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
            model=chapter_model,
            temperature=temperature,
            max_tokens=int(max_tokens),
        )
    except DeepSeekClientError as exc:
        result["error"] = str(exc)
        return result

    chapter_title = extract_chapter_title(chapter_content)
    final_content = chapter_content
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
            model=summary_model,
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
            model=chapter_model,
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
        _set_current_model_info(
            {
                "正文模型": result.get("chapter_model", ""),
                "标题模型": result.get("chapter_title_model", ""),
                "摘要模型": result.get("summary_model", ""),
            }
        )

    if result.get("error"):
        st.error(f"第 {chapter_number} 章生成流程失败：{result['error']}")
        return False

    st.success(f"第 {chapter_number} 章生成成功，已保存：{chapter_path}")
    st.info(f"章节标题：{chapter_title}")
    st.info(
        "使用模型："
        f"正文 {result.get('chapter_model')}，"
        f"标题 {result.get('chapter_title_model')}，"
        f"摘要 {result.get('summary_model')}"
    )
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
    task_models: dict[str, str],
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
                task_models=task_models,
                temperature=temperature,
                max_tokens=int(max_tokens),
                use_previous_context=use_previous_context,
            )
        return _show_chapter_workflow_result(chapter_result)

    with st.spinner("正在请求 DeepSeek 生成内容..."):
        try:
            selected_model = _model_for_mode(mode, task_models)
            result = generate_text(
                messages=messages,
                model=selected_model,
                temperature=temperature,
                max_tokens=int(max_tokens),
            )
        except DeepSeekClientError as exc:
            st.error(str(exc))
            return False

    saved_path = _save_result(title, mode, result, chapter_number)
    _save_pending_setting_expansion(title)
    _set_current_result(result, saved_path)
    _set_current_model_info({"使用模型": selected_model})
    st.success(f"生成成功，已保存：{saved_path}")
    st.info(f"使用模型：{selected_model}")

    return True


def main() -> None:
    st.set_page_config(page_title="AI 小说生成器", layout="wide")
    ensure_directories()
    _init_session_state()

    st.title("AI 小说生成器")
    st.caption("本地运行的轻量小说创作工具：大纲、人物卡、章节正文、续写和上下文管理。")

    api_key_configured = _is_api_key_configured()
    if not api_key_configured:
        st.warning("未检测到 DeepSeek API Key。请先完成 Quick Start 配置后再调用生成。")
        _render_quick_start_wizard()
    elif st.session_state.get("show_quick_start"):
        _render_quick_start_wizard()

    with st.sidebar:
        st.header("生成参数")
        temperature = st.slider("temperature", min_value=0.0, max_value=2.0, value=0.7, step=0.05)
        max_tokens = st.number_input("max_tokens", min_value=512, max_value=32768, value=4000, step=256)
        use_previous_context = st.checkbox("使用上一章上下文", value=True)
        project_options = [""] + list_project_titles()
        selected_project = st.selectbox("选择已有小说项目", project_options, key="selected_project_title")

    with st.sidebar:
        st.header("帮助 / Quick Start")
        if st.button("打开 Quick Start / Help", use_container_width=True):
            st.session_state.show_quick_start = True
            st.rerun()
        with st.expander("Docs / Help", expanded=False):
            _render_help_content()

    if selected_project and (
        st.session_state.selected_project_applied != selected_project or st.session_state.title != selected_project
    ):
        st.session_state.title = selected_project
        st.session_state.selected_project_applied = selected_project

    with st.sidebar:
        _render_environment_status()
        _render_project_status(_current_project_title())

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

    _render_reader_export_center(_current_project_title())

    with st.sidebar:
        st.header("模型设置")
        st.checkbox("使用统一模型", key="use_unified_model")
        if st.session_state.use_unified_model:
            _render_model_choice("统一模型", "unified_model", "custom_unified_model")
        else:
            _render_model_choice("设定扩写模型", "setting_expansion_model", "custom_setting_expansion_model")
            _render_model_choice("大纲生成模型", "outline_model", "custom_outline_model")
            _render_model_choice("人物卡生成模型", "character_model", "custom_character_model")
            _render_model_choice("章节正文生成模型", "chapter_model", "custom_chapter_model")
            _render_model_choice("章节标题生成模型", "chapter_title_model", "custom_chapter_title_model")
            _render_model_choice("章节摘要生成模型", "summary_model", "custom_summary_model")

    task_models = get_task_models_from_state()

    st.subheader("白话设定自动扩写")
    st.text_area(
        "输入你的白话设定",
        key="raw_story_idea",
        height=120,
        placeholder="例如：我想写一个赛博朋克故事，主角是失忆黑客，妹妹失踪了，城市被大公司控制，记忆可以被修改，主角要查真相。",
    )

    _render_setting_generation_config()

    expand_messages = build_expand_setting_prompt(
        raw_story_idea=st.session_state.raw_story_idea,
        detail_level=st.session_state.expand_detail_level,
        supplement_characters=st.session_state.supplement_characters,
        supplement_conflict=st.session_state.supplement_conflict,
        supplement_world_rules=st.session_state.supplement_world_rules,
        setting_options=_setting_generation_options_from_state(),
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
                st.info(f"使用模型：{task_models['setting_expansion']}")
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
                        model=task_models["setting_expansion"],
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
                    st.info(f"设定扩写模型：{task_models['setting_expansion']}")

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
            if mode == CHAPTER_MODE:
                st.info(
                    "本次任务模型："
                    f"章节正文 {task_models['chapter']}，"
                    f"章节标题 {task_models['chapter_title']}，"
                    f"章节摘要 {task_models['summary']}"
                )
            else:
                st.info(f"本次任务模型：{_model_for_mode(mode, task_models)}")
            st.json(messages, expanded=False)
            st.text_area("可复制 Prompt", value=_format_messages_for_preview(messages), height=420)

    if generate_clicked:
        _generate_and_save(
            title=project_title,
            mode=mode,
            messages=messages,
            task_models=task_models,
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
                task_models=task_models,
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
                        task_models=task_models,
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
                    st.write(
                        "使用模型："
                        f"正文 {batch_result['chapter_model']}，"
                        f"标题 {batch_result['chapter_title_model']}，"
                        f"摘要 {batch_result['summary_model']}"
                    )
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
                    st.write(
                        f"第 {item['chapter_number']} 章：{item['chapter_title']}，"
                        f"正文模型 {item['chapter_model']}，{item['chapter_path']}"
                    )
            if failed_result:
                st.warning(
                    f"批量生成已停止：第 {failed_result['chapter_number']} 章失败。"
                    f"已成功生成 {len(successful_results)} 章。"
                )

    if st.session_state.current_result:
        st.subheader("当前生成结果")
        if st.session_state.current_model_info:
            st.caption(
                "；".join(
                    f"{name}：{model_name}"
                    for name, model_name in st.session_state.current_model_info.items()
                    if model_name
                )
            )
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
