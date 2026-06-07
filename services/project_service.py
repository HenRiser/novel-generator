from __future__ import annotations

from typing import Any

from .schemas import ValidationResult


REQUIRED_STORY_SETTING_FIELDS = {
    "protagonist": "主角设定",
    "supporting_characters": "重要配角设定",
    "worldview": "世界观设定",
    "core_conflict": "故事核心冲突",
}
BASIC_CONFIG_FIELDS = {
    "genre": "小说类型",
    "style": "写作风格",
    "word_count_range": "单章字数范围",
}


def is_placeholder_title(title: Any) -> bool:
    cleaned = str(title or "").strip()
    return not cleaned or cleaned == "未命名小说"


def missing_story_setting_labels(project_config: dict[str, Any]) -> list[str]:
    return [
        label
        for key, label in REQUIRED_STORY_SETTING_FIELDS.items()
        if not str(project_config.get(key) or "").strip()
    ]


def missing_basic_config_label(project_config: dict[str, Any]) -> str:
    for key, label in BASIC_CONFIG_FIELDS.items():
        if not str(project_config.get(key) or "").strip():
            return label
    return ""


def validate_project_config_ready(project_config: dict[str, Any]) -> ValidationResult:
    if is_placeholder_title(project_config.get("title")):
        return ValidationResult(
            False,
            "请先填写小说标题，并完成设定输入或在“小说设定”区域补全必要内容后再保存项目配置。",
        )

    missing_settings = missing_story_setting_labels(project_config)
    if missing_settings:
        return ValidationResult(
            False,
            "请先填写小说标题，并完成设定输入或在“小说设定”区域补全必要内容后再保存项目配置。"
            f"缺少：{'、'.join(missing_settings)}。",
        )

    missing_basic = missing_basic_config_label(project_config)
    if missing_basic:
        return ValidationResult(False, f"请先补全{missing_basic}后再保存项目配置。")

    return ValidationResult(True)


def validate_story_settings_ready(project_config: dict[str, Any], message: str) -> ValidationResult:
    missing_settings = missing_story_setting_labels(project_config)
    if missing_settings:
        return ValidationResult(False, f"{message}缺少：{'、'.join(missing_settings)}。")

    missing_basic = missing_basic_config_label(project_config)
    if missing_basic:
        return ValidationResult(False, f"请先补全{missing_basic}。")

    return ValidationResult(True)


def validate_setting_assets_ready(project_config: dict[str, Any]) -> ValidationResult:
    if is_placeholder_title(project_config.get("title")):
        return ValidationResult(False, "请先填写小说标题并补全小说设定后再保存设定资产。")
    return validate_story_settings_ready(project_config, "请先补全小说设定后再保存设定资产。")


def validate_outline_character_ready(project_config: dict[str, Any]) -> ValidationResult:
    if is_placeholder_title(project_config.get("title")):
        return ValidationResult(False, "请先填写小说标题并完成小说设定后再生成大纲与人物卡。")
    return validate_story_settings_ready(project_config, "请先完成小说设定后再生成大纲与人物卡。")
