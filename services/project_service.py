from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any

from file_manager import (
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
    ProjectDirectoryResult,
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
