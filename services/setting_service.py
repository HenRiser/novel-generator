from __future__ import annotations

import json
import re
from typing import Any

from .schemas import SettingExpansionResult


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


def strip_json_code_fence(raw_text: str) -> str:
    text = (raw_text or "").strip()
    match = re.search(r"```(?:json|JSON)?\s*(.*?)\s*```", text, flags=re.DOTALL)
    if match:
        return match.group(1).strip()
    text = re.sub(r"^\s*```(?:json|JSON)?\s*", "", text)
    text = re.sub(r"\s*```\s*$", "", text)
    return text.strip()


def normalize_json_punctuation(raw_text: str) -> str:
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


def extract_json_object(raw_text: str) -> str:
    text = normalize_json_punctuation(strip_json_code_fence(raw_text))
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


def repair_common_json_issues(json_text: str) -> str:
    repaired = normalize_json_punctuation(strip_json_code_fence(json_text))
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
    for candidate in (raw_text, strip_json_code_fence(raw_text)):
        if candidate and candidate not in candidates:
            candidates.append(candidate)

    extracted = extract_json_object(raw_text)
    if extracted not in candidates:
        candidates.append(extracted)

    repaired = repair_common_json_issues(extracted)
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


def coerce_title_candidates(value: Any) -> list[str]:
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


def parse_setting_expansion_response(raw_text: str) -> SettingExpansionResult:
    data = parse_model_json_response(raw_text)

    missing_fields = [field for field in REQUIRED_SETTING_EXPANSION_SCHEMA_FIELDS if field not in data]
    if missing_fields:
        raise ValueError(f"JSON 字段缺失：{', '.join(missing_fields)}")

    recommended_title = data["recommended_title"]
    if not isinstance(recommended_title, str) or not recommended_title.strip():
        raise ValueError("JSON 字段为空：recommended_title 必须是非空字符串。")

    parsed: dict[str, str] = {}
    for field in REQUIRED_SETTING_EXPANSION_FIELDS:
        value = data[field]
        if not isinstance(value, str):
            raise ValueError(f"JSON 字段类型错误：{field} 必须是字符串。")
        if not value.strip():
            raise ValueError(f"JSON 字段为空：{field} 不能为空。")
        parsed[field] = value.strip()

    return SettingExpansionResult(
        title_candidates=coerce_title_candidates(data["title_candidates"]),
        recommended_title=recommended_title.strip(),
        protagonist_setting=parsed["protagonist_setting"],
        supporting_characters_setting=parsed["supporting_characters_setting"],
        world_setting=parsed["world_setting"],
        core_conflict=parsed["core_conflict"],
    )
