from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path
from typing import Any

import streamlit as st
import streamlit.components.v1 as components

from config import DEFAULT_MODEL, DEFAULT_MODEL_SETTINGS, DEEPSEEK_MODELS, PROJECT_ROOT
from config_manager import (
    get_api_key_status,
    get_available_models,
    get_current_base_url,
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
    OUTLINE_GRANULARITY_OPTIONS,
    PLOT_DENSITY_OPTIONS,
    NARRATIVE_PACE_OPTIONS,
    WORLD_COMPLEXITY_OPTIONS,
    CHARACTER_SCALE_OPTIONS,
    WRITING_MODE_OPTIONS,
    infer_story_scale,
    normalize_setting_options,
    setting_options_to_dict,
)
from file_manager import (
    create_workspace_project,
    ensure_directories,
    find_latest_chapter,
    list_chapter_files,
    list_projects,
    load_project_config,
    project_ref_from_context,
    read_history_summaries,
    read_latest_characters,
    read_latest_outline,
    read_previous_chapter,
    resolve_project_context,
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
from project_context import get_books_root, get_outputs_root
from ui_options import CUSTOM_OPTION, GENRE_OPTIONS, WRITING_STYLE_OPTIONS


STYLE_OPTIONS = WRITING_STYLE_OPTIONS
OUTLINE_MODE = "outline"
CHARACTER_MODE = "character"
CHAPTER_MODE = "chapter"
BATCH_MAX_CHAPTERS = 5
GENERATION_DUPLICATE_WINDOW_SECONDS = 3.0
EXPAND_DETAIL_OPTIONS = ["低", "中", "高"]
REQUIRED_SETTING_EXPANSION_FIELDS = [
    "protagonist_setting",
    "supporting_characters_setting",
    "world_setting",
    "core_conflict",
]
REQUIRED_SETTING_EXPANSION_SCHEMA_FIELDS = [
    "title_candidates",
    "recommended_title",
    *REQUIRED_SETTING_EXPANSION_FIELDS,
]
REQUIRED_STORY_SETTING_FIELDS = {
    "protagonist": "主角设定",
    "supporting_characters": "重要配角设定",
    "worldview": "世界观设定",
    "core_conflict": "故事核心冲突",
}
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
    outputs_exists = get_outputs_root().exists()
    books_exists = get_books_root().exists()
    api_status = get_api_key_status()
    api_key_configured = bool(api_status["configured"])

    st.header("环境状态")
    st.caption(f"项目根目录：{PROJECT_ROOT}")
    st.write(f"- .env：{_status_text(env_path.exists())}")
    st.write(f"- API Key：{'已配置' if api_key_configured else '未配置'}")
    st.write(f"- 默认模型：{api_status['default_model']}")
    st.write(f"- workspace/books：{'已找到' if books_exists else '首次保存时创建'}")
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
2. 输入故事设定、灵感或企划内容。
3. 选择小说类型和写作风格。
4. 点击整理并扩写设定。
5. 生成 / 更新大纲与人物卡。
6. 生成第 1 章。
7. 使用一键继续下一章。

### 文件位置

新项目生成结果保存在 `workspace/books/{book_id}/`，旧 `outputs/小说标题/` 项目仍会兼容读写。项目目录包含 `project_config.json`、大纲、人物卡、章节、摘要和章节索引。当前版本没有引入数据库，也不会把 API Key 写入 `project_config.json`。

### 常见问题

- API Key 未配置：打开 Quick Start，在密码输入框填写 DeepSeek API Key 后保存。
- 修改 API Key / Base URL / 默认模型：使用侧边栏“API / 模型设置”，或重新打开 Quick Start。
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
    st.session_state.setdefault("quick_start_base_url", get_current_base_url())

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
        st.text_input(
            "Base URL",
            key="quick_start_base_url",
            placeholder="https://api.deepseek.com",
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
                        base_url=st.session_state.get("quick_start_base_url", ""),
                    )
                except (FileNotFoundError, ValueError) as exc:
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


def _render_api_model_settings_panel() -> None:
    api_status = get_api_key_status()
    models = get_available_models()

    if st.session_state.get("api_settings_model_choice") not in models:
        choice, custom = _model_choice_from_model(get_current_default_model())
        st.session_state.api_settings_model_choice = choice
        st.session_state.api_settings_custom_model = custom
    st.session_state.setdefault("api_settings_base_url", get_current_base_url())
    st.session_state.setdefault("api_settings_api_key", "")

    st.text_input(
        "DeepSeek API Key",
        key="api_settings_api_key",
        type="password",
        placeholder="输入新的 API Key；已有 Key 不会明文回显",
    )
    st.text_input(
        "Base URL",
        key="api_settings_base_url",
        placeholder="https://api.deepseek.com",
    )
    st.selectbox("默认模型", models, key="api_settings_model_choice")
    if st.session_state.api_settings_model_choice == "custom":
        st.text_input(
            "自定义模型名",
            key="api_settings_custom_model",
            placeholder="例如：deepseek-v4-flash",
        )

    selected_model = resolve_selected_model(
        st.session_state.api_settings_model_choice,
        st.session_state.get("api_settings_custom_model", ""),
    )
    st.caption(f"当前本地配置：API Key {'已配置' if api_status['configured'] else '未配置'}；默认模型 {api_status['default_model']}")
    st.caption(f"将保存：Base URL {st.session_state.api_settings_base_url.strip() or get_current_base_url()}；默认模型 {selected_model}")

    test_col, save_col = st.columns(2)
    with test_col:
        if st.button("测试连接", use_container_width=True):
            st.info("本阶段未执行真实 DeepSeek 请求；已保留连接测试入口。")
    with save_col:
        if st.button("保存配置", type="primary", use_container_width=True):
            try:
                saved_model = save_api_config(
                    api_key=st.session_state.get("api_settings_api_key", ""),
                    default_model=st.session_state.api_settings_model_choice,
                    custom_model=st.session_state.get("api_settings_custom_model", ""),
                    base_url=st.session_state.get("api_settings_base_url", ""),
                    require_api_key=False,
                )
            except (FileNotFoundError, ValueError) as exc:
                st.error(str(exc))
            else:
                _apply_default_model_to_session(saved_model)
                st.success("API / 模型配置已保存到本地 .env。")
                st.rerun()


def _count_summary_files(summaries_dir: Path) -> int:
    if not summaries_dir.exists():
        return 0
    return len([path for path in summaries_dir.glob("chapter_*_summary*.md") if path.is_file()])


def _current_project_ref() -> str:
    return str(st.session_state.get("current_project_ref") or "").strip()


def _set_current_project(ref: str, title: str) -> None:
    st.session_state.current_project_ref = ref
    st.session_state.current_project_title = title


def _ensure_current_project_ref() -> str:
    current_ref = _current_project_ref()
    if current_ref:
        return current_ref

    ctx = create_workspace_project(_current_project_title())
    project_ref = project_ref_from_context(ctx)
    _set_current_project(project_ref, ctx.title)
    return project_ref


def _project_option_label(project_ref: str, project_map: dict) -> str:
    if not project_ref:
        return ""
    record = project_map.get(project_ref)
    if record is None:
        return project_ref
    return f"{record.title} [{record.kind}]"


def _open_project_directory(project_dir: Path) -> tuple[bool, str]:
    if not project_dir.exists():
        return False, f"项目目录不存在：{project_dir}"
    startfile = getattr(os, "startfile", None)
    if startfile is None:
        return False, "当前系统不支持直接打开文件夹。"
    try:
        startfile(str(project_dir))
    except Exception as exc:
        return False, f"无法打开项目目录：{exc}"
    return True, "已打开当前项目目录。"


def _render_open_project_button(project_dir: Path, key: str) -> None:
    if st.button("打开当前项目目录", use_container_width=True, key=key):
        ok, message = _open_project_directory(project_dir)
        if ok:
            st.success(message)
        else:
            st.warning(message)
            st.caption(f"项目路径：{project_dir}")


def _render_sidebar_project_summary(project_ref: str, project_title: str) -> None:
    st.header("当前项目")
    st.write(project_title)
    if not project_ref:
        st.caption("尚未创建。首次保存或生成时会创建到 workspace/books/{book_id}/。")
        st.button("打开当前项目目录", use_container_width=True, disabled=True, key="open_project_summary_disabled")
        return

    try:
        ctx = resolve_project_context(project_ref)
    except (FileNotFoundError, ValueError) as exc:
        st.warning(f"当前项目读取失败：{exc}")
        return

    st.caption("workspace 项目" if ctx.storage_kind == "workspace" else "legacy outputs 项目")
    _render_open_project_button(ctx.project_dir, "open_project_summary")


def _render_project_status(project_ref: str, project_title: str) -> None:
    try:
        ctx = resolve_project_context(project_ref) if project_ref else None
    except (FileNotFoundError, ValueError) as exc:
        st.warning(f"当前项目读取失败：{exc}")
        ctx = None
    st.header("当前项目状态")
    st.write(f"- 小说标题：{project_title}")
    if ctx is None:
        st.write("- 项目身份：尚未创建")
        st.write("- 项目目录：首次保存或生成时将创建到 workspace/books/{book_id}/")
        st.write("- 项目配置：未保存")
        st.write("- 小说大纲：未生成")
        st.write("- 人物卡：未生成")
        st.write("- 章节数量：0")
        st.write("- 摘要数量：0")
        st.write("- 章节索引：未生成")
        st.button("打开当前项目目录", use_container_width=True, disabled=True)
        return

    project_dir = ctx.project_dir
    st.write(f"- 项目身份：{project_ref}")
    st.write(f"- 项目目录：{project_dir}")
    st.write(f"- 项目配置：{'已保存' if ctx.config_path.exists() else '未保存'}")
    st.write(f"- 小说大纲：{'已生成' if ctx.outline_path.exists() else '未生成'}")
    st.write(f"- 人物卡：{'已生成' if ctx.characters_path.exists() else '未生成'}")
    st.write(f"- 章节数量：{len(list_chapter_files(project_ref))}")
    st.write(f"- 摘要数量：{_count_summary_files(ctx.summaries_dir)}")
    st.write(f"- 章节索引：{'已生成' if ctx.chapter_index_path.exists() else '未生成'}")

    _render_open_project_button(project_dir, "open_project_debug")


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


def _mark_reader_refresh(chapter_number: int | None = None) -> None:
    st.session_state.reader_center_expanded = True
    st.session_state.reader_needs_refresh = True
    if chapter_number is not None:
        st.session_state.reader_selected_chapter = int(chapter_number)
        st.session_state.reader_chapter_number = int(chapter_number)


def _render_reader_export_center(project_ref: str, project_title: str) -> None:
    with st.expander("导出与阅读", expanded=bool(st.session_state.get("reader_center_expanded", False))):
        if not project_ref:
            st.info("当前项目还没有章节，请先保存项目或生成章节。")
            return

        chapters = get_ordered_chapters(project_ref)
        if st.session_state.get("reader_needs_refresh") and not chapters:
            st.session_state.reader_needs_refresh = False
            st.session_state.reader_selected_chapter = None
        if not chapters:
            st.info("当前项目还没有章节，请先生成章节。")
            return

        st.markdown('<div id="reader-top"></div>', unsafe_allow_html=True)
        st.markdown("[回到阅读区顶部](#reader-top)")

        numbers = [int(chapter["chapter_number"]) for chapter in chapters]
        labels = {int(chapter["chapter_number"]): str(chapter["title"]) for chapter in chapters}
        current_number = int(st.session_state.get("reader_chapter_number", numbers[-1]))
        if st.session_state.get("reader_needs_refresh"):
            try:
                requested_number = int(st.session_state.get("reader_selected_chapter"))
            except (TypeError, ValueError):
                requested_number = None
            current_number = int(requested_number) if requested_number in numbers else numbers[-1]
            st.session_state.reader_needs_refresh = False
            st.session_state.reader_selected_chapter = None
        if current_number not in numbers:
            current_number = numbers[-1]
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
            chapter = read_chapter_for_reader(project_ref, current_number)
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

        full_txt = build_full_novel_txt(project_ref, display_title=project_title)
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
        "current_project_ref": "",
        "current_project_title": "",
        "selected_project_ref": "",
        "selected_project_applied": "",
        "pending_project_config": None,
        "project_config_load_message": "",
        "project_loaded": False,
        "show_raw_setting_input": True,
        "is_generating_chapter": False,
        "active_chapter_generation_signature": "",
        "last_chapter_generation_signature": "",
        "last_chapter_generation_completed_at": 0.0,
        "current_result": "",
        "current_file_name": "generated.md",
        "current_saved_path": "",
        "editable_result": "",
        "editable_source_path": "",
        "edited_saved_path": "",
        "start_chapter_number": 1,
        "end_chapter_number": 3,
        "current_model_info": {},
        "reader_center_expanded": False,
        "reader_chapter_number": 1,
        "reader_should_scroll_top": False,
        "reader_needs_refresh": False,
        "reader_selected_chapter": None,
        "setting_generation_genre": "赛博朋克",
        "custom_setting_generation_genre": "",
        "setting_generation_writing_style": "阴郁电影感",
        "custom_setting_generation_writing_style": "",
        "setting_generation_writing_mode": "电影式长剧情",
        "setting_expected_chapters": 12,
        "setting_plot_density": "中：平衡",
        "setting_narrative_pace": "中",
        "setting_world_complexity": "中",
        "setting_character_scale": "中等角色群",
        "setting_outline_granularity": "标准",
        "setting_extra_requirements": "",
        "show_quick_start": False,
        "quick_start_api_key": "",
        "quick_start_base_url": get_current_base_url(),
        "quick_start_model_choice": default_model_choice,
        "quick_start_custom_model": default_custom_model,
        "quick_start_connection_ok": False,
        "quick_start_connection_message": "",
        "show_api_model_settings": False,
        "api_settings_api_key": "",
        "api_settings_base_url": get_current_base_url(),
        "api_settings_model_choice": default_model_choice,
        "api_settings_custom_model": default_custom_model,
    }
    defaults.update(default_model_settings)
    for key, value in defaults.items():
        st.session_state.setdefault(key, value)

    normalized_settings = normalize_model_settings(
        {key: st.session_state.get(key) for key in DEFAULT_MODEL_SETTINGS}
    )
    for key, value in normalized_settings.items():
        st.session_state[key] = value
    _sync_genre_style_widget_state()


def _effective_choice(choice: str, custom_value: str) -> str:
    if choice == CUSTOM_OPTION:
        return custom_value.strip()
    return choice


def _effective_setting_choice(choice: str, custom_value: str, default: str) -> str:
    if choice == CUSTOM_OPTION:
        return custom_value.strip() or default
    return choice or default


def _setting_choice_from_value(value: Any, options: list[str], default: str) -> tuple[str, str]:
    value = str(value or "").strip()
    if value in options:
        return value, ""
    if value:
        return CUSTOM_OPTION, value
    return default, ""


def _normalize_option_pair(option_value: Any, custom_value: Any, options: list[str]) -> tuple[str, str]:
    option = str(option_value or "").strip()
    custom = str(custom_value or "").strip()
    if option in options:
        return option, custom if option == CUSTOM_OPTION else ""
    if option:
        return CUSTOM_OPTION, option
    return options[0], ""


def _sync_genre_style_widget_state() -> None:
    genre, custom_genre = _normalize_option_pair(
        st.session_state.get("genre"),
        st.session_state.get("custom_genre"),
        GENRE_OPTIONS,
    )
    writing_style, custom_style = _normalize_option_pair(
        st.session_state.get("writing_style"),
        st.session_state.get("custom_style"),
        STYLE_OPTIONS,
    )
    st.session_state.genre = genre
    st.session_state.custom_genre = custom_genre
    st.session_state.writing_style = writing_style
    st.session_state.custom_style = custom_style
    _copy_genre_style_to_widgets()


def _copy_genre_style_to_widgets() -> None:
    for prefix in ("setting_generation", "project_setting"):
        st.session_state[f"{prefix}_genre"] = st.session_state.genre
        st.session_state[f"{prefix}_custom_genre"] = st.session_state.custom_genre
        st.session_state[f"{prefix}_writing_style"] = st.session_state.writing_style
        st.session_state[f"{prefix}_custom_style"] = st.session_state.custom_style


def _apply_genre_style_from_widget(prefix: str) -> None:
    genre, custom_genre = _normalize_option_pair(
        st.session_state.get(f"{prefix}_genre"),
        st.session_state.get(f"{prefix}_custom_genre"),
        GENRE_OPTIONS,
    )
    writing_style, custom_style = _normalize_option_pair(
        st.session_state.get(f"{prefix}_writing_style"),
        st.session_state.get(f"{prefix}_custom_style"),
        STYLE_OPTIONS,
    )
    st.session_state.genre = genre
    st.session_state.custom_genre = custom_genre
    st.session_state.writing_style = writing_style
    st.session_state.custom_style = custom_style
    _copy_genre_style_to_widgets()


def _render_genre_style_controls(prefix: str) -> None:
    cols = st.columns(2)
    with cols[0]:
        st.selectbox(
            "小说类型",
            GENRE_OPTIONS,
            key=f"{prefix}_genre",
            on_change=_apply_genre_style_from_widget,
            args=(prefix,),
        )
        if st.session_state.get(f"{prefix}_genre") == CUSTOM_OPTION:
            st.text_input(
                "自定义小说类型",
                key=f"{prefix}_custom_genre",
                on_change=_apply_genre_style_from_widget,
                args=(prefix,),
            )
    with cols[1]:
        st.selectbox(
            "写作风格",
            STYLE_OPTIONS,
            key=f"{prefix}_writing_style",
            on_change=_apply_genre_style_from_widget,
            args=(prefix,),
        )
        if st.session_state.get(f"{prefix}_writing_style") == CUSTOM_OPTION:
            st.text_input(
                "自定义写作风格",
                key=f"{prefix}_custom_style",
                on_change=_apply_genre_style_from_widget,
                args=(prefix,),
            )


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
    genre_choice, custom_genre = _setting_choice_from_value(options.genre, GENRE_OPTIONS, "赛博朋克")
    style_choice, custom_style = _setting_choice_from_value(
        options.writing_style,
        STYLE_OPTIONS,
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
    if st.session_state.setting_generation_writing_mode not in WRITING_MODE_OPTIONS:
        st.session_state.setting_generation_writing_mode = normalize_setting_options(
            {"writing_mode": st.session_state.setting_generation_writing_mode}
        ).writing_mode
    quick_cols = st.columns(4)
    with quick_cols[0]:
        st.selectbox(
            "小说类型",
            GENRE_OPTIONS,
            key="setting_generation_genre",
            on_change=_apply_genre_style_from_widget,
            args=("setting_generation",),
        )
    with quick_cols[1]:
        st.selectbox(
            "写作风格",
            STYLE_OPTIONS,
            key="setting_generation_writing_style",
            on_change=_apply_genre_style_from_widget,
            args=("setting_generation",),
        )
    with quick_cols[2]:
        st.selectbox("写作模式", WRITING_MODE_OPTIONS, key="setting_generation_writing_mode")
    with quick_cols[3]:
        st.number_input("期望章节数", min_value=1, max_value=200, step=1, key="setting_expected_chapters")

    custom_cols = st.columns(2)
    if st.session_state.setting_generation_genre == CUSTOM_OPTION:
        with custom_cols[0]:
            st.text_input(
                "自定义小说类型",
                key="custom_setting_generation_genre",
                on_change=_apply_genre_style_from_widget,
                args=("setting_generation",),
            )
    if st.session_state.setting_generation_writing_style == CUSTOM_OPTION:
        with custom_cols[1]:
            st.text_input(
                "自定义写作风格",
                key="custom_setting_generation_writing_style",
                on_change=_apply_genre_style_from_widget,
                args=("setting_generation",),
            )

    expected_chapters = int(st.session_state.setting_expected_chapters)
    story_scale = infer_story_scale(expected_chapters)["scale"]
    st.caption(f"篇幅类型将根据期望章节数自动推导：{story_scale}")

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
        "genre": _effective_choice(st.session_state.genre, st.session_state.custom_genre) or GENRE_OPTIONS[0],
        "genre_option": st.session_state.genre,
        "custom_genre": st.session_state.custom_genre.strip(),
        "style": _effective_choice(st.session_state.writing_style, st.session_state.custom_style) or STYLE_OPTIONS[0],
        "style_option": st.session_state.writing_style,
        "custom_style": st.session_state.custom_style.strip(),
        "protagonist": st.session_state.protagonist_setting.strip(),
        "supporting_characters": st.session_state.supporting_characters_setting.strip(),
        "worldview": st.session_state.world_setting.strip(),
        "core_conflict": st.session_state.core_conflict.strip(),
        "word_count_range": st.session_state.chapter_word_range.strip(),
        "extra_requirements": st.session_state.extra_requirements.strip(),
        "model_settings": _model_settings_from_state(),
        "setting_generation_options": _setting_generation_options_from_state(),
    }


def _is_placeholder_title(title: Any) -> bool:
    cleaned = str(title or "").strip()
    return not cleaned or cleaned == "未命名小说"


def _missing_story_setting_labels(project_config: dict[str, Any]) -> list[str]:
    return [
        label
        for key, label in REQUIRED_STORY_SETTING_FIELDS.items()
        if not str(project_config.get(key) or "").strip()
    ]


def _missing_basic_config_label(project_config: dict[str, Any]) -> str:
    for key, label in {"genre": "小说类型", "style": "写作风格", "word_count_range": "单章字数范围"}.items():
        if not str(project_config.get(key) or "").strip():
            return label
    return ""


def _validate_project_config_ready(project_config: dict[str, Any]) -> tuple[bool, str]:
    if _is_placeholder_title(project_config.get("title")):
        return False, "请先填写小说标题，并完成设定输入或在“小说设定”区域补全必要内容后再保存项目配置。"

    missing_settings = _missing_story_setting_labels(project_config)
    if missing_settings:
        return (
            False,
            "请先填写小说标题，并完成设定输入或在“小说设定”区域补全必要内容后再保存项目配置。"
            f"缺少：{'、'.join(missing_settings)}。",
        )

    missing_basic = _missing_basic_config_label(project_config)
    if missing_basic:
        return False, f"请先补全{missing_basic}后再保存项目配置。"

    return True, ""


def _validate_story_settings_ready(project_config: dict[str, Any], message: str) -> tuple[bool, str]:
    missing_settings = _missing_story_setting_labels(project_config)
    if missing_settings:
        return False, f"{message}缺少：{'、'.join(missing_settings)}。"

    missing_basic = _missing_basic_config_label(project_config)
    if missing_basic:
        return False, f"请先补全{missing_basic}。"

    return True, ""


def _validate_setting_assets_ready(project_config: dict[str, Any]) -> tuple[bool, str]:
    if _is_placeholder_title(project_config.get("title")):
        return False, "请先填写小说标题并补全小说设定后再保存设定资产。"
    return _validate_story_settings_ready(project_config, "请先补全小说设定后再保存设定资产。")


def _validate_outline_character_generation_ready(project_config: dict[str, Any]) -> tuple[bool, str]:
    if _is_placeholder_title(project_config.get("title")):
        return False, "请先填写小说标题并完成小说设定后再生成大纲与人物卡。"
    return _validate_story_settings_ready(project_config, "请先完成小说设定后再生成大纲与人物卡。")


def _load_config_to_session(config: dict[str, Any]) -> None:
    """Apply a saved config before any widgets using these keys are instantiated."""
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
    st.session_state.chapter_word_range = config.get("word_count_range", "3000-5000 字")
    st.session_state.extra_requirements = config.get("extra_requirements", "")
    _load_model_settings_to_session(config.get("model_settings", DEFAULT_MODEL_SETTINGS))
    _load_setting_generation_options_to_session(config.get("setting_generation_options", {}))
    _sync_genre_style_widget_state()


def _queue_project_config_load(config: dict[str, Any]) -> None:
    st.session_state.pending_project_config = dict(config)


def _consume_pending_project_config() -> None:
    config = st.session_state.get("pending_project_config")
    if not isinstance(config, dict):
        return

    _load_config_to_session(config)
    loaded_title = str(config.get("title") or "").strip()
    if loaded_title:
        st.session_state.current_project_title = loaded_title
    st.session_state.project_loaded = True
    st.session_state.show_raw_setting_input = False
    st.session_state.project_config_load_message = "项目配置已加载。"
    st.session_state.pending_project_config = None


def _load_choice(option_value: Any, final_value: Any, custom_value: Any, options: list[str]) -> tuple[str, str]:
    option_value = str(option_value or "").strip()
    final_value = str(final_value or "").strip()
    custom_value = str(custom_value or "").strip()

    if option_value in options:
        return option_value, custom_value
    if final_value in options:
        return final_value, custom_value
    if final_value:
        return CUSTOM_OPTION, custom_value or final_value
    return options[0], custom_value


def _current_project_title() -> str:
    current_title = str(st.session_state.get("current_project_title", "") or "").strip()
    if current_title:
        return current_title
    return str(st.session_state.get("title", "") or "").strip() or "未命名小说"


def _format_messages_for_preview(messages: list[dict[str, str]]) -> str:
    parts = []
    for message in messages:
        role = message.get("role", "unknown")
        content = message.get("content", "")
        parts.append(f"## {role}\n\n{content}")
    return "\n\n---\n\n".join(parts)


def _save_pending_setting_expansion(project_key: str) -> Path | None:
    expanded_data = st.session_state.get("last_setting_expansion_data")
    raw_story_idea = st.session_state.get("last_raw_story_idea", "")
    if not raw_story_idea or not isinstance(expanded_data, dict) or not expanded_data:
        return None

    return save_setting_expansion(project_key, raw_story_idea, expanded_data)


def _strip_json_code_fence(raw_text: str) -> str:
    text = (raw_text or "").strip()
    match = re.search(r"```(?:json|JSON)?\s*(.*?)\s*```", text, flags=re.DOTALL)
    if match:
        return match.group(1).strip()
    text = re.sub(r"^\s*```(?:json|JSON)?\s*", "", text)
    text = re.sub(r"\s*```\s*$", "", text)
    return text.strip()


def _normalize_json_punctuation(raw_text: str) -> str:
    return (raw_text or "").translate(
        str.maketrans(
            {
                "｛": "{",
                "｝": "}",
                "［": "[",
                "］": "]",
                "“": '"',
                "”": '"',
                "＂": '"',
                "：": ":",
                "，": ",",
                "‘": "'",
                "’": "'",
            }
        )
    )


def _extract_json_object(raw_text: str) -> str:
    text = _normalize_json_punctuation(_strip_json_code_fence(raw_text))
    start = text.find("{")
    if start == -1:
        raise ValueError("JSON 解析失败：返回内容中没有找到 JSON 对象。")

    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(text)):
        char = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue

        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text[start : index + 1].strip()

    end = text.rfind("}")
    if end > start:
        return text[start : end + 1].strip()
    raise ValueError("JSON 解析失败：返回内容中没有找到完整的 JSON 对象。")


def _repair_common_json_issues(json_text: str) -> str:
    repaired = _normalize_json_punctuation(_strip_json_code_fence(json_text))
    repaired = repaired.replace("\ufeff", "").replace("\u00a0", " ")
    repaired = re.sub(r",\s*([}\]])", r"\1", repaired)
    repaired = re.sub(
        r'([}\]"])\s*(?:\r?\n)+\s*("(?=[A-Za-z_][A-Za-z0-9_]*"\s*:))',
        r"\1,\n  \2",
        repaired,
    )
    repaired = re.sub(
        r'([}\]"])\s+("(?=[A-Za-z_][A-Za-z0-9_]*"\s*:))',
        r"\1, \2",
        repaired,
    )
    return repaired.strip()


def parse_model_json_response(raw_text: str) -> dict[str, Any]:
    raw_text = (raw_text or "").strip()
    if not raw_text:
        raise ValueError("模型返回内容为空，无法解析 JSON。")

    candidates: list[str] = []
    for candidate in (raw_text, _strip_json_code_fence(raw_text)):
        if candidate and candidate not in candidates:
            candidates.append(candidate)

    extracted = _extract_json_object(raw_text)
    if extracted not in candidates:
        candidates.append(extracted)

    repaired = _repair_common_json_issues(extracted)
    if repaired not in candidates:
        candidates.append(repaired)

    last_error: json.JSONDecodeError | None = None
    for candidate in candidates:
        try:
            data = json.loads(candidate)
        except json.JSONDecodeError as exc:
            last_error = exc
            continue
        if not isinstance(data, dict):
            raise ValueError("JSON 解析失败：返回结果不是 JSON 对象。")
        return data

    detail = f"最后错误：{last_error}" if last_error else ""
    raise ValueError(f"JSON 解析失败：模型返回的设定不是合法 JSON，系统已尝试提取和轻量修复但仍无法解析。{detail}")


def _coerce_title_candidates(value: Any) -> list[str]:
    if isinstance(value, list):
        candidates = value
    elif isinstance(value, str):
        candidates = re.split(r"[\n,，、;；]+", value)
    else:
        raise ValueError("JSON 字段类型错误：title_candidates 必须是字符串数组。")

    titles = [str(title).strip().strip('"“”') for title in candidates if str(title).strip()]
    if not titles:
        raise ValueError("JSON 字段为空：title_candidates 至少需要一个标题候选。")
    return titles


def parse_setting_expansion_response(raw_text: str) -> dict[str, Any]:
    data = parse_model_json_response(raw_text)

    missing_fields = [field for field in REQUIRED_SETTING_EXPANSION_SCHEMA_FIELDS if field not in data]
    if missing_fields:
        raise ValueError(f"JSON 字段缺失：{', '.join(missing_fields)}")

    parsed: dict[str, Any] = {
        "title_candidates": _coerce_title_candidates(data["title_candidates"]),
    }

    recommended_title = data["recommended_title"]
    if not isinstance(recommended_title, str) or not recommended_title.strip():
        raise ValueError("JSON 字段为空：recommended_title 必须是非空字符串。")
    parsed["recommended_title"] = recommended_title.strip()

    for field in REQUIRED_SETTING_EXPANSION_FIELDS:
        value = data[field]
        if not isinstance(value, str):
            raise ValueError(f"JSON 字段类型错误：{field} 必须是字符串。")
        if not value.strip():
            raise ValueError(f"JSON 字段为空：{field} 不能为空。")
        parsed[field] = value.strip()

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


def _build_messages(project_key: str, mode: str, project_config: dict[str, Any], chapter_number: int, use_previous_context: bool) -> tuple[list[dict[str, str]], list[str]]:
    notices = []

    if mode == OUTLINE_MODE:
        return build_outline_prompt(project_config), notices

    if mode == CHARACTER_MODE:
        return build_character_prompt(project_config), notices

    outline, outline_path = (None, None)
    characters, characters_path = (None, None)
    previous_chapter = None
    previous_path = None
    summaries = ""

    if project_key:
        outline, outline_path = read_latest_outline(project_key)
        characters, characters_path = read_latest_characters(project_key)
        summaries = read_history_summaries(project_key, before_chapter=chapter_number)

    if outline_path:
        notices.append(f"已加入大纲上下文：{outline_path.name}")
    if characters_path:
        notices.append(f"已加入人物卡上下文：{characters_path.name}")
    if summaries:
        notices.append("已加入历史章节摘要。")

    if use_previous_context:
        if project_key:
            previous_chapter, previous_path = read_previous_chapter(project_key, chapter_number)
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


def _save_result(project_key: str, mode: str, content: str, chapter_number: int) -> Path:
    if mode == OUTLINE_MODE:
        return save_outline(project_key, content)
    if mode == CHARACTER_MODE:
        return save_characters(project_key, content)
    return save_chapter(project_key, chapter_number, content)


def _generate_setting_assets(
    project_key: str,
    project_config: dict[str, Any],
    task_models: dict[str, str],
    temperature: float,
    max_tokens: int,
) -> bool:
    try:
        outline = generate_text(
            messages=build_outline_prompt(project_config),
            model=task_models["outline"],
            temperature=temperature,
            max_tokens=int(max_tokens),
        )
        outline_path = save_outline(project_key, outline)

        characters = generate_text(
            messages=build_character_prompt(project_config),
            model=task_models["character"],
            temperature=temperature,
            max_tokens=int(max_tokens),
        )
        characters_path = save_characters(project_key, characters)
        _save_pending_setting_expansion(project_key)
    except DeepSeekClientError as exc:
        st.error(str(exc))
        return False
    except Exception as exc:
        st.error(f"设定资产保存失败：{exc}")
        return False

    st.success("大纲与人物卡已生成并保存。")
    st.info(f"大纲：{outline_path}")
    st.info(f"人物卡：{characters_path}")
    st.info(f"使用模型：大纲 {task_models['outline']}，人物卡 {task_models['character']}")
    with st.expander("本次生成的大纲", expanded=True):
        st.markdown(outline)
    with st.expander("本次生成的人物卡", expanded=False):
        st.markdown(characters)
    return True


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
    project_key: str,
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
            project_key=project_key,
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
        chapter_path = save_chapter(project_key, int(chapter_number), final_content)
        _save_pending_setting_expansion(project_key)
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
        summary_path = save_summary(project_key, int(chapter_number), summary)
        result["summary"] = summary
        result["summary_path"] = str(summary_path)
    except DeepSeekClientError as exc:
        result["summary_error"] = str(exc)
    except Exception as exc:
        result["summary_error"] = f"摘要保存失败：{exc}"

    try:
        index_path = update_chapter_index(
            title=project_key,
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

    _mark_reader_refresh(int(chapter_number))
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


def _plan_batch_chapters(project_key: str) -> tuple[list[int], str | None]:
    latest_chapter_number, _ = find_latest_chapter(project_key)
    latest_chapter_number = int(latest_chapter_number or 0)
    expected_start = latest_chapter_number + 1 if latest_chapter_number else 1
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


def _validate_chapter_generation_ready(project_ref: str, project_config: dict[str, Any]) -> tuple[bool, str]:
    if not project_ref:
        return False, "请先保存项目配置，或生成 / 更新大纲与人物卡，创建当前小说项目后再生成正文。"

    try:
        ctx = resolve_project_context(project_ref)
    except (FileNotFoundError, ValueError) as exc:
        return False, f"当前项目无效，无法生成正文：{exc}"

    if _is_placeholder_title(project_config.get("title")):
        return False, "请先填写小说标题，并保存项目配置后再生成正文。"

    missing_fields = _missing_story_setting_labels(project_config)

    if missing_fields:
        return (
            False,
            "请先完成设定输入与智能扩写，或在“小说设定”区域补全必要设定后再生成正文。"
            f"缺少：{'、'.join(missing_fields)}。",
        )

    missing_basic = _missing_basic_config_label(project_config)
    if missing_basic:
        return False, f"请先补全{missing_basic}后再生成正文。"

    _, outline_path = read_latest_outline(project_ref)
    _, characters_path = read_latest_characters(project_ref)
    has_saved_setting_asset = ctx.config_path.exists() or bool(outline_path) or bool(characters_path)
    if not has_saved_setting_asset:
        return False, "请先保存项目配置，或生成 / 更新大纲与人物卡，确保有可用于章节正文生成的设定资产。"

    return True, ""


def _chapter_generation_signature(action: str, project_ref: str, chapter_numbers: list[int]) -> str:
    chapters = ",".join(str(int(number)) for number in chapter_numbers)
    return f"{action}:{project_ref}:{chapters}"


def _begin_chapter_generation(signature: str) -> bool:
    if st.session_state.get("is_generating_chapter"):
        st.warning("当前已有章节生成任务正在进行，请等待完成后再操作。")
        return False

    now = time.monotonic()
    last_signature = st.session_state.get("last_chapter_generation_signature", "")
    last_completed_at = float(st.session_state.get("last_chapter_generation_completed_at", 0.0) or 0.0)
    if last_signature == signature and now - last_completed_at < GENERATION_DUPLICATE_WINDOW_SECONDS:
        st.warning("刚刚已经处理过同一次章节生成请求，请稍后再重复生成。")
        return False

    st.session_state.is_generating_chapter = True
    st.session_state.active_chapter_generation_signature = signature
    return True


def _end_chapter_generation() -> None:
    signature = st.session_state.get("active_chapter_generation_signature", "")
    if signature:
        st.session_state.last_chapter_generation_signature = signature
        st.session_state.last_chapter_generation_completed_at = time.monotonic()
    st.session_state.active_chapter_generation_signature = ""
    st.session_state.is_generating_chapter = False


def _generate_and_save(
    project_key: str,
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
                project_key=project_key,
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

    saved_path = _save_result(project_key, mode, result, chapter_number)
    _save_pending_setting_expansion(project_key)
    _set_current_result(result, saved_path)
    _set_current_model_info({"使用模型": selected_model})
    st.success(f"生成成功，已保存：{saved_path}")
    st.info(f"使用模型：{selected_model}")

    return True


def main() -> None:
    st.set_page_config(page_title="AI 小说生成器", layout="wide")
    ensure_directories()
    _init_session_state()
    _consume_pending_project_config()

    st.title("AI 小说生成器")
    st.caption("本地运行的轻量小说创作工具：大纲、人物卡、章节正文、续写和上下文管理。")
    if st.session_state.get("project_config_load_message"):
        st.success(st.session_state.project_config_load_message)
        st.session_state.project_config_load_message = ""

    api_key_configured = _is_api_key_configured()
    if not api_key_configured:
        st.warning("未检测到 DeepSeek API Key。请先完成 Quick Start 配置后再调用生成。")
        _render_quick_start_wizard()
    elif st.session_state.get("show_quick_start"):
        _render_quick_start_wizard()

    with st.sidebar:
        st.header("当前项目")
        project_records = list_projects()
        project_map = {record.ref: record for record in project_records}
        project_options = [""] + [record.ref for record in project_records]
        if st.session_state.selected_project_ref not in project_options:
            st.session_state.selected_project_ref = ""
        selected_project_ref = st.selectbox(
            "选择已有小说项目",
            project_options,
            key="selected_project_ref",
            format_func=lambda ref: _project_option_label(ref, project_map),
        )

    if selected_project_ref and st.session_state.selected_project_applied != selected_project_ref:
        try:
            selected_ctx = resolve_project_context(selected_project_ref)
        except (FileNotFoundError, ValueError) as exc:
            st.warning(f"项目读取失败：{exc}")
        else:
            _set_current_project(selected_project_ref, selected_ctx.title)
            st.session_state.selected_project_applied = selected_project_ref
            st.session_state.project_loaded = False
            st.session_state.show_raw_setting_input = True
    elif not selected_project_ref and st.session_state.selected_project_applied:
        st.session_state.current_project_ref = ""
        st.session_state.current_project_title = ""
        st.session_state.selected_project_applied = ""
        st.session_state.project_loaded = False
        st.session_state.show_raw_setting_input = True

    with st.sidebar:
        _render_sidebar_project_summary(_current_project_ref(), _current_project_title())

        st.header("生成参数")
        temperature = st.slider("temperature", min_value=0.0, max_value=2.0, value=0.7, step=0.05)
        max_tokens = st.number_input("max_tokens", min_value=512, max_value=32768, value=4000, step=256)
        use_previous_context = st.checkbox("使用上一章上下文", value=True)

        st.header("模型")
        st.caption(f"默认模型：{get_current_default_model()}")
        if st.button("API / 模型设置", use_container_width=True):
            st.session_state.show_api_model_settings = not st.session_state.show_api_model_settings
        if st.session_state.show_api_model_settings:
            with st.expander("API / 模型设置", expanded=True):
                _render_api_model_settings_panel()

        with st.expander("任务模型选择", expanded=False):
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

        st.header("快速操作")
        if st.button("打开 Quick Start / Help", use_container_width=True):
            st.session_state.show_quick_start = True
            st.rerun()
        with st.expander("Docs / Help", expanded=False):
            _render_help_content()

        with st.expander("高级状态 / 调试信息", expanded=False):
            _render_environment_status()
            _render_project_status(_current_project_ref(), _current_project_title())

    load_col, save_col = st.columns(2)
    with load_col:
        if st.button("加载项目配置", use_container_width=True):
            project_ref = _current_project_ref()
            if not project_ref:
                st.info("当前还没有已保存项目，请先保存项目配置或生成内容。")
            else:
                try:
                    config = load_project_config(project_ref)
                except (FileNotFoundError, ValueError) as exc:
                    st.error(str(exc))
                else:
                    if config is None:
                        st.info(f"还没有找到当前小说项目的 project_config.json：{resolve_project_context(project_ref).project_dir}")
                    else:
                        _queue_project_config_load(config)
                        st.rerun()

    with save_col:
        if st.button("保存项目配置", use_container_width=True):
            project_config_to_save = _collect_project_config()
            ready, message = _validate_project_config_ready(project_config_to_save)
            if not ready:
                st.warning(message)
            else:
                project_ref = _ensure_current_project_ref()
                path = save_project_config(project_ref, project_config_to_save)
                st.success(f"项目配置已保存：{path}")
                expansion_path = _save_pending_setting_expansion(project_ref)
                if expansion_path:
                    st.info(f"最近一次设定扩写已保存：{expansion_path}")

    reader_placeholder = st.empty()

    task_models = get_task_models_from_state()

    preview_expand_clicked = False
    expand_and_fill_clicked = False
    expand_messages: list[dict[str, str]] = []

    st.subheader("设定输入与智能扩写")
    if st.session_state.project_loaded and not st.session_state.show_raw_setting_input:
        st.info(
            "当前项目已加载扩写后的小说设定。如需修改，请在“小说设定”区域编辑；"
            "如需重新扩写，可展开“重新输入原始设定”。"
        )
        setting_loaded_col1, setting_loaded_col2 = st.columns(2)
        with setting_loaded_col1:
            if st.button("查看 / 编辑当前小说设定", use_container_width=True):
                st.info("请在下方“小说设定”区域直接编辑当前项目设定。")
        with setting_loaded_col2:
            if st.button("重新输入原始设定并扩写", use_container_width=True):
                st.session_state.show_raw_setting_input = True
                st.rerun()

    if not st.session_state.project_loaded or st.session_state.show_raw_setting_input:
        if st.session_state.project_loaded:
            st.caption("重新扩写会把新的结构化设定填入下方“小说设定”区域；不会删除已有项目文件。")
        st.text_area(
            "故事设定 / 灵感 / 企划内容",
            key="raw_story_idea",
            height=120,
            placeholder=(
                "可以输入一句话脑洞，也可以粘贴较完整的人物、世界观、剧情冲突等设定。"
                "系统会结合小说类型、写作风格、写作模式和期望章节数，自动整理、补全并拆分为主角、配角、世界观和核心冲突。"
            ),
            help="支持输入简短白话，也支持粘贴较完整的设定文档或小说企划。",
        )
        st.caption(
            "支持输入简短白话，也支持粘贴较完整的设定文档。系统会根据下方配置自动整理、补全并拆分为项目所需的结构化设定。"
        )

        _render_setting_generation_config()

        expand_messages = build_expand_setting_prompt(
            raw_story_idea=st.session_state.raw_story_idea,
            genre=_effective_choice(st.session_state.genre, st.session_state.custom_genre),
            writing_style=_effective_choice(st.session_state.writing_style, st.session_state.custom_style),
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
            expand_and_fill_clicked = st.button("整理并扩写设定", use_container_width=True)

    if preview_expand_clicked:
        if not st.session_state.raw_story_idea.strip():
            st.warning("请先输入故事设定、灵感或企划内容。")
        else:
            with st.expander("设定扩写 messages 预览", expanded=True):
                st.info(f"使用模型：{task_models['setting_expansion']}")
                st.json(expand_messages, expanded=False)
                st.text_area("可复制设定扩写 Prompt", value=_format_messages_for_preview(expand_messages), height=420)

    if expand_and_fill_clicked:
        if not st.session_state.raw_story_idea.strip():
            st.warning("请先输入故事设定、灵感或企划内容。")
        else:
            with st.spinner("正在整理、补全并拆分设定..."):
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
                        st.success(f"已根据设定内容自动生成并填入推荐标题：{auto_title}")
                    elif title_candidates:
                        st.info("检测到你已有小说标题，未自动覆盖；可从标题候选中手动选择。")

                    st.success("设定已整理、扩写并填入")
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
    current_ref_for_caption = _current_project_ref()
    if current_ref_for_caption:
        try:
            current_ctx_for_caption = resolve_project_context(current_ref_for_caption)
        except (FileNotFoundError, ValueError) as exc:
            st.caption(f"当前项目目录：无法读取当前项目（{exc}）")
        else:
            st.caption(f"当前项目目录：{current_ctx_for_caption.project_dir}")
    else:
        st.caption("当前项目目录：首次保存或生成时将创建到 workspace/books/{book_id}/")

    _render_genre_style_controls("project_setting")

    st.text_area("主角设定", key="protagonist_setting", height=110)
    st.text_area("重要配角设定", key="supporting_characters_setting", height=110)
    st.text_area("世界观设定", key="world_setting", height=130)
    st.text_area("故事核心冲突", key="core_conflict", height=100)

    st.text_input("单章字数范围", key="chapter_word_range")

    st.text_area(
        "额外要求",
        key="extra_requirements",
        height=120,
        placeholder="例如：第三人称、多对话、节奏快、禁止出现的内容、希望出现的桥段。",
    )

    project_ref = _current_project_ref()
    project_config = _collect_project_config()
    st.subheader("小说设定 / 大纲与人物")
    st.caption("大纲和人物卡是正文生成前的设定资产；保存、生成和章节正文创作都会先检查必要设定。")
    asset_col1, asset_col2, asset_col3, asset_col4 = st.columns(4)
    with asset_col1:
        generate_assets_clicked = st.button("生成 / 更新大纲与人物卡", use_container_width=True)
    with asset_col2:
        view_outline_clicked = st.button("查看大纲", use_container_width=True)
    with asset_col3:
        view_characters_clicked = st.button("查看人物卡", use_container_width=True)
    with asset_col4:
        save_setting_assets_clicked = st.button("保存设定资产", use_container_width=True)

    if save_setting_assets_clicked:
        ready, message = _validate_setting_assets_ready(project_config)
        if not ready:
            st.warning(message)
        else:
            project_ref = _ensure_current_project_ref()
            config_path = save_project_config(project_ref, project_config)
            expansion_path = _save_pending_setting_expansion(project_ref)
            st.success(f"设定资产已保存：{config_path}")
            if expansion_path:
                st.info(f"设定扩写结果已保存：{expansion_path}")

    if generate_assets_clicked:
        ready, message = _validate_outline_character_generation_ready(project_config)
        if not ready:
            st.warning(message)
        else:
            project_ref = _ensure_current_project_ref()
            save_project_config(project_ref, project_config)
            with st.spinner("正在生成大纲与人物卡..."):
                _generate_setting_assets(
                    project_key=project_ref,
                    project_config=project_config,
                    task_models=task_models,
                    temperature=temperature,
                    max_tokens=int(max_tokens),
                )

    if view_outline_clicked:
        if not project_ref:
            st.info("当前还没有已保存项目，请先保存设定资产或生成内容。")
        else:
            outline, outline_path = read_latest_outline(project_ref)
            if outline_path:
                with st.expander(f"大纲：{outline_path.name}", expanded=True):
                    st.markdown(outline)
            else:
                st.info("当前项目还没有大纲。")

    if view_characters_clicked:
        if not project_ref:
            st.info("当前还没有已保存项目，请先保存设定资产或生成内容。")
        else:
            characters, characters_path = read_latest_characters(project_ref)
            if characters_path:
                with st.expander(f"人物卡：{characters_path.name}", expanded=True):
                    st.markdown(characters)
            else:
                st.info("当前项目还没有人物卡。")

    project_ref = _current_project_ref()
    latest_chapter_number = 0
    latest_chapter_path = None
    if project_ref:
        latest_chapter_number, latest_chapter_path = find_latest_chapter(project_ref)
        latest_chapter_number = int(latest_chapter_number or 0)
    recommended_next_chapter = latest_chapter_number + 1

    st.subheader("章节创作")
    st.write(f"当前最新章节：{'第 ' + str(latest_chapter_number) + ' 章' if latest_chapter_path else '暂无'}")
    st.write(f"推荐下一章：第 {recommended_next_chapter} 章")

    continue_clicked = st.button("一键继续下一章", type="primary", use_container_width=True)
    st.caption("一键继续会扫描当前项目已有章节，并生成最大章节号 + 1。")

    chapter_col, batch_col = st.columns(2)
    with chapter_col:
        st.markdown("#### 指定章节")
        st.number_input("指定章节编号", min_value=1, step=1, key="chapter_number")
        st.caption("如同编号章节已存在，会自动保存为新版本文件，不会覆盖原文件。")
        generate_clicked = st.button("生成指定章节", use_container_width=True)

    with batch_col:
        st.markdown("#### 批量章节")
        batch_start_col, batch_end_col = st.columns(2)
        with batch_start_col:
            st.number_input("起始章节", min_value=1, step=1, key="start_chapter_number")
        with batch_end_col:
            st.number_input("结束章节", min_value=1, step=1, key="end_chapter_number")
        st.caption("批量生成会从当前最新章节的下一章开始，避免跳章。")
        batch_clicked = st.button("批量生成章节", use_container_width=True)

    chapter_number = int(st.session_state.chapter_number)
    preview_clicked = st.button("预览 Prompt", use_container_width=True)

    if preview_clicked:
        ready, message = _validate_chapter_generation_ready(project_ref, project_config)
        if not ready:
            st.warning(message)
        else:
            messages, notices = _build_messages(project_ref, CHAPTER_MODE, project_config, chapter_number, use_previous_context)
            if notices:
                with st.expander("本次上下文提示", expanded=False):
                    for notice in notices:
                        st.write(notice)
            with st.expander("章节正文 messages 预览", expanded=True):
                st.info(
                    "本次任务模型："
                    f"章节正文 {task_models['chapter']}，"
                    f"章节标题 {task_models['chapter_title']}，"
                    f"章节摘要 {task_models['summary']}"
                )
                st.json(messages, expanded=False)
                st.text_area("可复制 Prompt", value=_format_messages_for_preview(messages), height=420)

    if generate_clicked:
        ready, message = _validate_chapter_generation_ready(project_ref, project_config)
        if not ready:
            st.warning(message)
        else:
            signature = _chapter_generation_signature("specified", project_ref, [chapter_number])
            if _begin_chapter_generation(signature):
                try:
                    messages, notices = _build_messages(project_ref, CHAPTER_MODE, project_config, chapter_number, use_previous_context)
                    if notices:
                        with st.expander("本次上下文提示", expanded=False):
                            for notice in notices:
                                st.write(notice)
                    _generate_and_save(
                        project_key=project_ref,
                        mode=CHAPTER_MODE,
                        messages=messages,
                        task_models=task_models,
                        temperature=temperature,
                        max_tokens=int(max_tokens),
                        chapter_number=chapter_number,
                        project_config=project_config,
                        use_previous_context=use_previous_context,
                    )
                finally:
                    _end_chapter_generation()

    if continue_clicked:
        continue_project_config = project_config
        if project_ref:
            try:
                saved_project_config = load_project_config(project_ref)
            except (FileNotFoundError, ValueError) as exc:
                st.warning(f"项目配置读取失败，将使用页面当前设定：{exc}")
            else:
                if saved_project_config:
                    continue_project_config = saved_project_config
                    st.info(f"已读取当前小说项目配置：{resolve_project_context(project_ref).project_dir}")
                else:
                    st.info("未找到当前小说项目的 project_config.json，将使用页面当前设定。")

        ready, message = _validate_chapter_generation_ready(project_ref, continue_project_config)
        if not ready:
            st.warning(message)
        else:
            latest_chapter_number, latest_chapter_path = find_latest_chapter(project_ref)
            next_chapter_number = int(latest_chapter_number or 0) + 1
            signature = _chapter_generation_signature("continue", project_ref, [next_chapter_number])
            if _begin_chapter_generation(signature):
                try:
                    continue_messages, continue_notices = _build_messages(
                        project_key=project_ref,
                        mode=CHAPTER_MODE,
                        project_config=continue_project_config,
                        chapter_number=next_chapter_number,
                        use_previous_context=True,
                    )
                    if latest_chapter_path:
                        st.info(
                            f"将从 {latest_chapter_path.name} 继续生成第 {next_chapter_number} 章，"
                            "并已自动启用上一章上下文。"
                        )
                    else:
                        st.info("当前项目还没有章节，将生成第 1 章。")
                    if continue_notices:
                        with st.expander("一键继续使用的上下文", expanded=False):
                            for notice in continue_notices:
                                st.write(notice)

                    _generate_and_save(
                        project_key=project_ref,
                        mode=CHAPTER_MODE,
                        messages=continue_messages,
                        task_models=task_models,
                        temperature=temperature,
                        max_tokens=int(max_tokens),
                        chapter_number=next_chapter_number,
                        project_config=continue_project_config,
                        use_previous_context=True,
                    )
                finally:
                    _end_chapter_generation()

    if batch_clicked:
        ready, message = _validate_chapter_generation_ready(project_ref, project_config)
        if not ready:
            st.warning(message)
        else:
            chapters_to_generate, batch_error = _plan_batch_chapters(project_ref)
            if batch_error:
                st.warning(batch_error)
            else:
                signature = _chapter_generation_signature("batch", project_ref, chapters_to_generate)
                if _begin_chapter_generation(signature):
                    try:
                        st.info(f"将按顺序生成：{', '.join(f'第 {number} 章' for number in chapters_to_generate)}")
                        progress = st.progress(0)
                        successful_results: list[dict[str, Any]] = []
                        failed_result: dict[str, Any] | None = None

                        for index, batch_chapter_number in enumerate(chapters_to_generate, start=1):
                            with st.status(f"正在生成第 {batch_chapter_number} 章", expanded=True) as status:
                                batch_result = generate_single_chapter_workflow(
                                    project_key=project_ref,
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
                            _mark_reader_refresh(int(last_result["chapter_number"]))
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
                    finally:
                        _end_chapter_generation()

    with reader_placeholder.container():
        _render_reader_export_center(_current_project_ref(), _current_project_title())

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
            elif not _current_project_ref():
                st.warning("当前还没有已保存项目，无法保存编辑后的版本。")
            else:
                edited_path = save_edited_result(
                    _current_project_ref(),
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
