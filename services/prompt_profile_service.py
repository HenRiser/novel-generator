from __future__ import annotations

import hashlib
import json
import re
from typing import Any
from .common import clean_text


PROMPT_PREVIEW_LIMIT = 800
PROMPT_PROFILES = {
    "chapter_generation": {
        "profile_id": "chapter_generation_v1",
        "template_name": "chapter_generation",
        "template_version": "v1",
        "description": "Chapter generation prompt with optional Narrative Context Pack.",
    },
    "story_delta_analysis": {
        "profile_id": "story_delta_analysis_v1",
        "template_name": "story_delta_analysis",
        "template_version": "v1",
        "description": "Story Delta analysis prompt that may also produce Next Chapter Proposal and Knowledge Draft candidates.",
    },
}
SENSITIVE_LINE_PATTERN = re.compile(
    r"(api[_-]?key|openai[_-]?api[_-]?key|deepseek[_-]?api[_-]?key|password|secret|token)",
    re.IGNORECASE,
)




def get_prompt_profile(run_type: str) -> dict[str, Any]:
    profile = PROMPT_PROFILES.get(clean_text(run_type))
    if profile is None:
        return {
            "profile_id": f"{clean_text(run_type) or 'unknown'}_v1",
            "template_name": clean_text(run_type) or "unknown",
            "template_version": "v1",
            "description": "",
        }
    return dict(profile)


def _messages_to_text(messages: Any) -> str:
    if not isinstance(messages, list) or not messages:
        return ""
    parts: list[str] = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = clean_text(message.get("role")) or "message"
        content = clean_text(message.get("content"))
        if content:
            parts.append(f"{role}: {content}")
    return "\n\n".join(parts).strip()


def _redact_sensitive_lines(text: str) -> str:
    safe_lines: list[str] = []
    for line in str(text or "").splitlines():
        safe_lines.append("[redacted sensitive prompt line]" if SENSITIVE_LINE_PATTERN.search(line) else line)
    return "\n".join(safe_lines).strip()


def build_prompt_profile(run_type: str, messages: Any) -> dict[str, Any]:
    profile = get_prompt_profile(run_type)
    prompt_text = _messages_to_text(messages)
    if prompt_text:
        canonical = json.dumps(prompt_text, ensure_ascii=False, sort_keys=True)
        profile["prompt_hash"] = f"sha256:{hashlib.sha256(canonical.encode('utf-8')).hexdigest()}"
        preview = _redact_sensitive_lines(prompt_text)
        profile["prompt_preview"] = preview[:PROMPT_PREVIEW_LIMIT]
    else:
        profile["prompt_hash"] = None
        profile["prompt_preview"] = ""
    return profile