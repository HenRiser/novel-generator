from __future__ import annotations

import json
import shutil
from datetime import datetime
from math import isfinite
from pathlib import Path
from typing import Any

from file_manager import (
    create_workspace_project as file_create_workspace_project,
    list_projects as list_project_records,
    load_project_config as file_load_project_config,
    resolve_project_context,
    save_project_config as file_save_project_config,
    save_setting_expansion as file_save_setting_expansion,
)
from project_context import (
    WORKSPACE_STORAGE_KIND,
    read_book_metadata,
    update_book_metadata_timestamp,
    write_book_metadata,
)

from .schemas import (
    ProjectCreateResult,
    ProjectDirectoryResult,
    ProjectGenerationSettingsResult,
    ProjectLoadResult,
    ProjectSaveResult,
    ProjectSummary,
    ValidationResult,
)


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
CREATE_TITLE_MAX_LENGTH = 80
CREATE_SEED_PROMPT_MAX_LENGTH = 4000
CREATE_OPTIONAL_TEXT_MAX_LENGTH = 200
CREATE_PROJECT_MODEL_CHOICES = {"deepseek-v4-flash", "deepseek-v4-pro"}
DEFAULT_CREATE_PROJECT_MODEL = "deepseek-v4-flash"
DEFAULT_CREATE_PROJECT_MAX_TOKENS = 4000
DEFAULT_CREATE_PROJECT_TEMPERATURE = 0.7
GENERATION_MAX_TOKENS_MIN = 512
GENERATION_MAX_TOKENS_MAX = 32768
GENERATION_TEMPERATURE_MIN = 0.0
GENERATION_TEMPERATURE_MAX = 2.0
DEFAULT_CREATE_PROJECT_WORD_COUNT_RANGE = "3000-5000 字"


def _clean_create_text(value: Any) -> str:
    return str(value or "").strip()


def _coerce_optional_int(value: Any, default: int) -> int | None:
    if value is None or value == "":
        return default
    try:
        coerced = int(value)
    except (TypeError, ValueError):
        return None
    return coerced


def _coerce_optional_float(value: Any, default: float) -> float | None:
    if value is None or value == "":
        return default
    try:
        coerced = float(value)
    except (TypeError, ValueError):
        return None
    return coerced


def _coerce_generation_max_tokens(value: Any) -> int | None:
    if value is None or value == "" or isinstance(value, bool):
        return None
    if isinstance(value, float) and not value.is_integer():
        return None
    try:
        coerced = int(value)
    except (TypeError, ValueError):
        return None
    return coerced


def _coerce_generation_temperature(value: Any) -> float | None:
    if value is None or value == "" or isinstance(value, bool):
        return None
    try:
        coerced = float(value)
    except (TypeError, ValueError):
        return None
    return coerced if isfinite(coerced) else None


def _workspace_support_dirs(ctx: Any) -> list[Path]:
    return [
        ctx.project_dir / "settings",
        ctx.project_dir / "outline",
        ctx.chapters_dir,
        ctx.summaries_dir,
        ctx.project_dir / "preferences",
        ctx.project_dir / "revisions",
        ctx.exports_dir,
        ctx.logs_dir,
    ]


def _build_created_project_config(
    title: str,
    seed_prompt: str,
    genre: str,
    style: str,
    model: str,
    max_tokens: int,
    temperature: float,
) -> dict[str, Any]:
    story_seed = seed_prompt.strip()
    return {
        "title": title,
        "genre": genre or "未指定",
        "style": style or "未指定",
        "word_count_range": DEFAULT_CREATE_PROJECT_WORD_COUNT_RANGE,
        "protagonist": story_seed,
        "supporting_characters": story_seed,
        "worldview": story_seed,
        "core_conflict": story_seed,
        "extra_requirements": story_seed,
        "seed_prompt": story_seed,
        "model": model,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "setting_generation_options": {
            "writing_mode": "电影式长剧情",
            "expected_chapters": 12,
        },
        "created_from": "react",
        "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
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


def build_project_summary(record: Any) -> ProjectSummary:
    project_ref = str(getattr(record, "ref", "") or "").strip()
    title = str(getattr(record, "title", "") or "").strip()
    storage_type = str(getattr(record, "kind", "") or "").strip()
    updated_at = str(getattr(record, "updated_at", "") or "").strip()
    description = f"{title} [{storage_type}]" if title and storage_type else project_ref
    return ProjectSummary(
        project_ref=project_ref,
        title=title,
        storage_type=storage_type,
        updated_at=updated_at,
        description=description,
    )


def list_project_summaries(
    outputs_root: Path | None = None,
    books_root: Path | None = None,
) -> list[ProjectSummary]:
    return [
        build_project_summary(record)
        for record in list_project_records(outputs_root=outputs_root, books_root=books_root)
    ]


def create_workspace_project(
    title: Any,
    seed_prompt: Any,
    genre: Any = "",
    style: Any = "",
    model: Any = None,
    max_tokens: Any = None,
    temperature: Any = None,
    books_root: Path | None = None,
) -> ProjectCreateResult:
    cleaned_title = _clean_create_text(title)
    cleaned_seed_prompt = _clean_create_text(seed_prompt)
    cleaned_genre = _clean_create_text(genre)
    cleaned_style = _clean_create_text(style)
    cleaned_model = _clean_create_text(model) or DEFAULT_CREATE_PROJECT_MODEL

    if not cleaned_title:
        return ProjectCreateResult(False, message="小说标题不能为空。")
    if len(cleaned_title) > CREATE_TITLE_MAX_LENGTH:
        return ProjectCreateResult(False, message=f"小说标题不能超过 {CREATE_TITLE_MAX_LENGTH} 个字符。")
    if not cleaned_seed_prompt:
        return ProjectCreateResult(False, message="一句话设定 / 创作种子不能为空。")
    if len(cleaned_seed_prompt) > CREATE_SEED_PROMPT_MAX_LENGTH:
        return ProjectCreateResult(False, message=f"创作种子不能超过 {CREATE_SEED_PROMPT_MAX_LENGTH} 个字符。")
    if len(cleaned_genre) > CREATE_OPTIONAL_TEXT_MAX_LENGTH:
        return ProjectCreateResult(False, message=f"题材不能超过 {CREATE_OPTIONAL_TEXT_MAX_LENGTH} 个字符。")
    if len(cleaned_style) > CREATE_OPTIONAL_TEXT_MAX_LENGTH:
        return ProjectCreateResult(False, message=f"风格不能超过 {CREATE_OPTIONAL_TEXT_MAX_LENGTH} 个字符。")
    if cleaned_model not in CREATE_PROJECT_MODEL_CHOICES:
        return ProjectCreateResult(False, message="模型只能选择 deepseek-v4-flash 或 deepseek-v4-pro。")

    resolved_max_tokens = _coerce_optional_int(max_tokens, DEFAULT_CREATE_PROJECT_MAX_TOKENS)
    if resolved_max_tokens is None or resolved_max_tokens < 512 or resolved_max_tokens > 32768:
        return ProjectCreateResult(False, message="max_tokens 必须是 512 到 32768 之间的整数。")

    resolved_temperature = _coerce_optional_float(temperature, DEFAULT_CREATE_PROJECT_TEMPERATURE)
    if resolved_temperature is None or resolved_temperature < 0 or resolved_temperature > 2:
        return ProjectCreateResult(False, message="temperature 必须是 0 到 2 之间的数字。")

    ctx = None
    try:
        ctx = file_create_workspace_project(cleaned_title, books_root=books_root)
        for path in _workspace_support_dirs(ctx):
            path.mkdir(parents=True, exist_ok=True)

        project_ref = f"book:{ctx.book_id}"
        project_config = _build_created_project_config(
            cleaned_title,
            cleaned_seed_prompt,
            cleaned_genre,
            cleaned_style,
            cleaned_model,
            resolved_max_tokens,
            resolved_temperature,
        )
        _save_project_config(project_ref, project_config, books_root=books_root)
        _save_setting_expansion(
            project_ref,
            cleaned_seed_prompt,
            {
                "seed_prompt": cleaned_seed_prompt,
                "genre": cleaned_genre,
                "style": cleaned_style,
            },
            books_root=books_root,
        )
    except (OSError, RuntimeError, ValueError) as exc:
        if ctx is not None and ctx.project_dir.exists():
            shutil.rmtree(ctx.project_dir, ignore_errors=True)
        return ProjectCreateResult(False, title=cleaned_title, message=f"项目创建失败：{exc}")

    return ProjectCreateResult(
        True,
        project_ref=project_ref,
        title=cleaned_title,
        message="Project created.",
    )


def project_summary_label(project_ref: str, project_map: dict[str, ProjectSummary]) -> str:
    ref = str(project_ref or "").strip()
    if not ref:
        return ""
    summary = project_map.get(ref)
    if summary is None:
        return ref
    return summary.description or summary.title or ref


def _has_custom_roots(outputs_root: Path | None, books_root: Path | None) -> bool:
    return outputs_root is not None or books_root is not None


def _save_project_config(
    project_ref: str,
    project_config: dict[str, Any],
    outputs_root: Path | None = None,
    books_root: Path | None = None,
) -> Path:
    if not _has_custom_roots(outputs_root, books_root):
        return file_save_project_config(project_ref, project_config)

    ctx = resolve_project_context(project_ref, outputs_root=outputs_root, books_root=books_root)
    ctx.ensure_project_dirs()
    data = dict(project_config)
    data["updated_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    path = ctx.config_path
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    if ctx.storage_kind == WORKSPACE_STORAGE_KIND:
        title = str(data.get("title") or "").strip()
        if title:
            metadata = read_book_metadata(ctx.project_dir)
            metadata = update_book_metadata_timestamp({**metadata, "title": title})
            write_book_metadata(ctx.project_dir, metadata)

    return path


def _load_project_config(
    project_ref: str,
    outputs_root: Path | None = None,
    books_root: Path | None = None,
) -> dict[str, Any] | None:
    if not _has_custom_roots(outputs_root, books_root):
        return file_load_project_config(project_ref)

    ctx = resolve_project_context(project_ref, outputs_root=outputs_root, books_root=books_root)
    path = ctx.config_path
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"{path} 格式不正确，请检查 JSON 内容。") from exc
    return data if isinstance(data, dict) else None


def _save_setting_expansion(
    project_ref: str,
    raw_story_idea: str,
    expanded_data: dict[str, Any],
    outputs_root: Path | None = None,
    books_root: Path | None = None,
) -> Path:
    if not _has_custom_roots(outputs_root, books_root):
        return file_save_setting_expansion(project_ref, raw_story_idea, expanded_data)

    ctx = resolve_project_context(project_ref, outputs_root=outputs_root, books_root=books_root)
    ctx.ensure_project_dirs()
    path = ctx.setting_expansion_path
    data = {
        "raw_story_idea": raw_story_idea,
        "expanded": expanded_data,
    }
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def load_project_detail(
    project_ref: str,
    outputs_root: Path | None = None,
    books_root: Path | None = None,
) -> ProjectLoadResult:
    ref = str(project_ref or "").strip()
    if not ref:
        return ProjectLoadResult(False, message="当前还没有已保存项目。", error=False)

    try:
        ctx = resolve_project_context(ref, outputs_root=outputs_root, books_root=books_root)
        config = _load_project_config(ref, outputs_root=outputs_root, books_root=books_root)
    except (FileNotFoundError, ValueError) as exc:
        return ProjectLoadResult(False, project_ref=ref, message=str(exc), error=True)

    if config is None:
        return ProjectLoadResult(
            False,
            project_ref=ref,
            title=ctx.title,
            project_dir=ctx.project_dir,
            message=f"还没有找到当前小说项目的 project_config.json：{ctx.project_dir}",
            error=False,
        )

    return ProjectLoadResult(
        True,
        project_ref=ref,
        title=str(config.get("title") or ctx.title or "").strip(),
        config=config,
        project_dir=ctx.project_dir,
    )


def save_project_configuration(
    project_ref: str,
    project_config: dict[str, Any],
    outputs_root: Path | None = None,
    books_root: Path | None = None,
) -> ProjectSaveResult:
    ref = str(project_ref or "").strip()
    if not ref:
        return ProjectSaveResult(False, message="当前还没有有效项目，无法保存项目配置。")

    validation = validate_project_config_ready(project_config)
    if not validation.ok:
        return ProjectSaveResult(False, project_ref=ref, message=validation.message)

    try:
        path = _save_project_config(ref, dict(project_config), outputs_root=outputs_root, books_root=books_root)
    except (OSError, FileNotFoundError, ValueError) as exc:
        return ProjectSaveResult(False, project_ref=ref, message=f"项目配置保存失败：{exc}")

    return ProjectSaveResult(True, project_ref=ref, path=path, result_paths=[path])


def update_generation_settings(
    project_ref: str,
    model: Any,
    max_tokens: Any,
    temperature: Any,
    outputs_root: Path | None = None,
    books_root: Path | None = None,
) -> ProjectGenerationSettingsResult:
    ref = str(project_ref or "").strip()
    if not ref:
        return ProjectGenerationSettingsResult(False, message="Project ref is required.")

    cleaned_model = _clean_create_text(model)
    if cleaned_model not in CREATE_PROJECT_MODEL_CHOICES:
        return ProjectGenerationSettingsResult(
            False,
            project_ref=ref,
            message="model must be deepseek-v4-flash or deepseek-v4-pro.",
        )

    resolved_max_tokens = _coerce_generation_max_tokens(max_tokens)
    if (
        resolved_max_tokens is None
        or resolved_max_tokens < GENERATION_MAX_TOKENS_MIN
        or resolved_max_tokens > GENERATION_MAX_TOKENS_MAX
    ):
        return ProjectGenerationSettingsResult(
            False,
            project_ref=ref,
            message=(
                f"max_tokens must be an integer between {GENERATION_MAX_TOKENS_MIN} "
                f"and {GENERATION_MAX_TOKENS_MAX}."
            ),
        )

    resolved_temperature = _coerce_generation_temperature(temperature)
    if (
        resolved_temperature is None
        or resolved_temperature < GENERATION_TEMPERATURE_MIN
        or resolved_temperature > GENERATION_TEMPERATURE_MAX
    ):
        return ProjectGenerationSettingsResult(
            False,
            project_ref=ref,
            message=(
                f"temperature must be a number between {GENERATION_TEMPERATURE_MIN:g} "
                f"and {GENERATION_TEMPERATURE_MAX:g}."
            ),
        )

    try:
        ctx = resolve_project_context(ref, outputs_root=outputs_root, books_root=books_root)
    except (FileNotFoundError, ValueError) as exc:
        return ProjectGenerationSettingsResult(False, project_ref=ref, message=str(exc))

    if ctx.storage_kind != WORKSPACE_STORAGE_KIND:
        return ProjectGenerationSettingsResult(
            False,
            project_ref=ref,
            message="Generation settings can only be saved for workspace projects.",
        )

    try:
        project_config = _load_project_config(ref, outputs_root=outputs_root, books_root=books_root)
    except (FileNotFoundError, ValueError) as exc:
        return ProjectGenerationSettingsResult(False, project_ref=ref, message=str(exc))
    if project_config is None:
        return ProjectGenerationSettingsResult(
            False,
            project_ref=ref,
            message="Project config was not found.",
        )

    updated_config = dict(project_config)
    updated_config["model"] = cleaned_model
    updated_config["max_tokens"] = resolved_max_tokens
    updated_config["temperature"] = resolved_temperature

    try:
        path = _save_project_config(ref, updated_config, outputs_root=outputs_root, books_root=books_root)
    except (OSError, FileNotFoundError, ValueError) as exc:
        return ProjectGenerationSettingsResult(False, project_ref=ref, message=f"Generation settings save failed: {exc}")

    return ProjectGenerationSettingsResult(
        True,
        project_ref=ref,
        path=path,
        config={
            "model": cleaned_model,
            "max_tokens": resolved_max_tokens,
            "temperature": resolved_temperature,
        },
        message="Generation settings saved.",
    )


def save_setting_assets(
    project_ref: str,
    project_config: dict[str, Any],
    raw_story_idea: str = "",
    expanded_data: dict[str, Any] | None = None,
    outputs_root: Path | None = None,
    books_root: Path | None = None,
) -> ProjectSaveResult:
    ref = str(project_ref or "").strip()
    if not ref:
        return ProjectSaveResult(False, message="当前还没有有效项目，无法保存设定资产。")

    validation = validate_setting_assets_ready(project_config)
    if not validation.ok:
        return ProjectSaveResult(False, project_ref=ref, message=validation.message)

    try:
        config_path = _save_project_config(ref, dict(project_config), outputs_root=outputs_root, books_root=books_root)
        result_paths = [config_path]
        raw_text = str(raw_story_idea or "").strip()
        if raw_text and isinstance(expanded_data, dict) and expanded_data:
            expansion_path = _save_setting_expansion(
                ref,
                raw_text,
                dict(expanded_data),
                outputs_root=outputs_root,
                books_root=books_root,
            )
            result_paths.append(expansion_path)
    except (OSError, FileNotFoundError, ValueError) as exc:
        return ProjectSaveResult(False, project_ref=ref, message=f"设定资产保存失败：{exc}")

    return ProjectSaveResult(True, project_ref=ref, path=config_path, result_paths=result_paths)


def resolve_project_directory(
    project_ref: str,
    outputs_root: Path | None = None,
    books_root: Path | None = None,
) -> ProjectDirectoryResult:
    ref = str(project_ref or "").strip()
    if not ref:
        return ProjectDirectoryResult(False, message="当前还没有已保存项目。")

    try:
        ctx = resolve_project_context(ref, outputs_root=outputs_root, books_root=books_root)
    except (FileNotFoundError, ValueError) as exc:
        return ProjectDirectoryResult(False, project_ref=ref, message=f"当前项目读取失败：{exc}")

    return ProjectDirectoryResult(
        True,
        project_ref=ref,
        title=ctx.title,
        storage_type=ctx.storage_kind,
        path=ctx.project_dir,
    )


def validate_outline_character_ready(project_config: dict[str, Any]) -> ValidationResult:
    if is_placeholder_title(project_config.get("title")):
        return ValidationResult(False, "请先填写小说标题并完成小说设定后再生成大纲与人物卡。")
    return validate_story_settings_ready(project_config, "请先完成小说设定后再生成大纲与人物卡。")
