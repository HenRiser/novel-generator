from __future__ import annotations

import json
import re
import secrets
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from deepseek_client import DeepSeekClientError, generate_text
from file_manager import read_latest_characters, read_latest_outline, resolve_project_context
from project_context import WORKSPACE_STORAGE_KIND

from .ai_run_service import create_ai_run_record_best_effort
from .event_log_service import append_event_best_effort
from .narrative_graph_service import load_narrative_graph
from .prompt_profile_service import build_prompt_profile
from .project_service import load_project_detail
from .reader_service import read_chapter_for_display


DOCUMENT_VERSION = 1
MEMORY_DIR_NAME = "memory"
LOGS_DIR_NAME = "logs"
STORY_DELTAS_NAME = "story_deltas.json"
KNOWLEDGE_DRAFTS_NAME = "knowledge_drafts.json"
STORY_DELTA_FAILURES_DIR_NAME = "story_delta_failures"
DEFAULT_STORY_DELTA = {
    "new_characters": [],
    "character_updates": [],
    "new_scenes": [],
    "new_items": [],
    "new_events": [],
    "foreshadowing_updates": [],
    "relationship_updates": [],
    "world_fact_updates": [],
}
DEFAULT_NEXT_CHAPTER_PROPOSAL = {
    "target_chapter_number": 0,
    "suggested_goal": "",
    "suggested_scenes": [],
    "suggested_conflicts": [],
    "suggested_foreshadowing_moves": [],
    "suggested_new_nodes": [],
    "suggested_new_edges": [],
    "suggested_plot_directions": [],
    "risks": [],
}
ALLOWED_OPERATIONS = {
    "create_character_card",
    "update_character_card",
    "create_node",
    "update_node",
    "create_edge",
    "update_edge",
    "create_plot_direction",
    "create_world_fact",
    "create_foreshadowing",
    "update_foreshadowing",
    "merge_suggestion",
}
ALLOWED_STATUSES = {"pending_review", "accepted", "rejected", "failed", "superseded"}
OPERATION_TO_NODE_TYPE = {
    "create_world_fact": "world_fact",
    "create_foreshadowing": "foreshadowing",
    "create_plot_direction": "plot_direction",
    "create_character_card": "character",
}
EDGE_TYPES = {
    "appears_in",
    "causes",
    "leads_to",
    "reveals",
    "foreshadows",
    "monitors",
    "constrains",
    "protects",
    "threatens",
    "located_at",
    "related_to",
    "changes_status_of",
}
LAYERS = {"core", "major", "detail", "background"}


@dataclass(frozen=True)
class StoryDeltaResult:
    ok: bool
    project_ref: str = ""
    chapter_number: int = 0
    story_delta: dict[str, Any] = field(default_factory=dict)
    next_chapter_proposal: dict[str, Any] = field(default_factory=dict)
    knowledge_draft: dict[str, Any] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)
    message: str = ""
    story_delta_item: dict[str, Any] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class StoryDeltaParseResult:
    data: dict[str, Any] | None = None
    error: str = ""
    json_text: str = ""


@dataclass(frozen=True)
class StoryDeltaListResult:
    ok: bool
    project_ref: str = ""
    items: list[dict[str, Any]] = field(default_factory=list)
    drafts: list[dict[str, Any]] = field(default_factory=list)
    draft: dict[str, Any] = field(default_factory=dict)
    message: str = ""


def _timestamp() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _clean_text(value: Any) -> str:
    return str(value or "").strip()


def _safe_id(prefix: str) -> str:
    stamp = datetime.now().astimezone().strftime("%Y%m%d_%H%M%S")
    return f"{prefix}_{stamp}_{secrets.token_hex(3)}"


def _safe_provided_id(value: Any) -> str:
    text = _clean_text(value)
    if not text:
        return ""
    return re.sub(r"[^A-Za-z0-9_:-]+", "_", text).strip("_")[:120]


def _workspace_context(project_ref: str) -> tuple[Any | None, str]:
    ref = _clean_text(project_ref)
    if not ref:
        return None, "Unknown project_ref."
    try:
        ctx = resolve_project_context(ref)
    except (FileNotFoundError, ValueError) as exc:
        return None, str(exc) or "Unknown project_ref."
    if ctx.storage_kind != WORKSPACE_STORAGE_KIND:
        return None, "Story Delta is only supported for workspace book projects."
    return ctx, ""


def _memory_dir(ctx: Any) -> Path:
    return ctx.project_dir / MEMORY_DIR_NAME


def _story_deltas_path(ctx: Any) -> Path:
    return _memory_dir(ctx) / STORY_DELTAS_NAME


def _knowledge_drafts_path(ctx: Any) -> Path:
    return _memory_dir(ctx) / KNOWLEDGE_DRAFTS_NAME


def _story_delta_failures_dir(ctx: Any) -> Path:
    return ctx.project_dir / LOGS_DIR_NAME / STORY_DELTA_FAILURES_DIR_NAME


def _story_delta_failure_ref(failure_id: str) -> str:
    return f"{LOGS_DIR_NAME}/{STORY_DELTA_FAILURES_DIR_NAME}/{failure_id}.json"


def _read_json(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"{path.name} is not valid JSON.") from exc
    if not isinstance(data, dict):
        raise ValueError(f"{path.name} must be a JSON object.")
    return data


def _write_json_atomic(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(f".{path.name}.{secrets.token_hex(4)}.tmp")
    temp_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    temp_path.replace(path)


def _redact_sensitive_text(text: Any) -> str:
    value = str(text or "")
    value = re.sub(
        r"(?i)(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;)}\]]+",
        r"\1[redacted]",
        value,
    )
    value = re.sub(r"(?i)(bearer\s+)[A-Za-z0-9._\-]+", r"\1[redacted]", value)
    value = re.sub(r"(?i)(api[-_ ]?key\s*[:=]\s*)[^\s,;)}\]]+", r"\1[redacted]", value)
    return value


def _save_story_delta_failure(
    ctx: Any,
    project_ref: str,
    chapter_number: int,
    stage: str,
    parse_error: str,
    raw_output: str,
    model: str | None,
) -> tuple[str, str]:
    failure_id = _safe_id("story_delta_failure")
    artifact = {
        "version": DOCUMENT_VERSION,
        "id": failure_id,
        "project_ref": project_ref,
        "chapter_number": chapter_number,
        "stage": _clean_text(stage),
        "parse_error": _clean_text(parse_error),
        "raw_output": _redact_sensitive_text(raw_output),
        "model": _clean_text(model) or None,
        "created_at": _timestamp(),
    }
    try:
        _write_json_atomic(_story_delta_failures_dir(ctx) / f"{failure_id}.json", artifact)
    except (OSError, ValueError) as exc:
        return "", f"Story Delta failure artifact save failed: {exc}"
    return _story_delta_failure_ref(failure_id), ""


def _empty_story_deltas(project_ref: str, created_at: str | None = None) -> dict[str, Any]:
    now = _timestamp()
    return {
        "version": DOCUMENT_VERSION,
        "metadata": {
            "project_ref": project_ref,
            "created_at": created_at or now,
            "updated_at": now,
        },
        "items": [],
    }


def _empty_knowledge_drafts(project_ref: str, created_at: str | None = None) -> dict[str, Any]:
    now = _timestamp()
    return {
        "version": DOCUMENT_VERSION,
        "metadata": {
            "project_ref": project_ref,
            "created_at": created_at or now,
            "updated_at": now,
        },
        "drafts": [],
    }


def _normalize_story_deltas_document(data: dict[str, Any] | None, project_ref: str) -> dict[str, Any]:
    if data is None:
        return _empty_story_deltas(project_ref)
    document = dict(data)
    document["version"] = DOCUMENT_VERSION
    metadata = dict(document.get("metadata") if isinstance(document.get("metadata"), dict) else {})
    metadata["project_ref"] = project_ref
    metadata.setdefault("created_at", _timestamp())
    metadata.setdefault("updated_at", metadata["created_at"])
    document["metadata"] = metadata
    items = document.get("items")
    document["items"] = list(items) if isinstance(items, list) else []
    return document


def _normalize_knowledge_drafts_document(data: dict[str, Any] | None, project_ref: str) -> dict[str, Any]:
    if data is None:
        return _empty_knowledge_drafts(project_ref)
    document = dict(data)
    document["version"] = DOCUMENT_VERSION
    metadata = dict(document.get("metadata") if isinstance(document.get("metadata"), dict) else {})
    metadata["project_ref"] = project_ref
    metadata.setdefault("created_at", _timestamp())
    metadata.setdefault("updated_at", metadata["created_at"])
    document["metadata"] = metadata
    drafts = document.get("drafts")
    document["drafts"] = list(drafts) if isinstance(drafts, list) else []
    return document


def _update_metadata(document: dict[str, Any]) -> None:
    now = _timestamp()
    metadata = dict(document.get("metadata") if isinstance(document.get("metadata"), dict) else {})
    metadata.setdefault("created_at", now)
    metadata["updated_at"] = now
    document["metadata"] = metadata


def _list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_bool(value: Any, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"1", "true", "yes", "on"}:
            return True
        if lowered in {"0", "false", "no", "off"}:
            return False
    return bool(value)


def _story_delta_max_tokens(project_config: dict[str, Any]) -> int:
    try:
        return max(4000, min(int(project_config.get("max_tokens") or 8000), 12000))
    except (TypeError, ValueError):
        return 8000


def _validate_chapter_number(value: Any) -> tuple[int, str]:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return 0, "chapter_number must be a positive integer."
    if number < 1:
        return number, "chapter_number must be a positive integer."
    return number, ""


def _truncate(text: str, limit: int) -> str:
    safe = _clean_text(text)
    if len(safe) <= limit:
        return safe
    return f"{safe[:limit].rstrip()}\n...[truncated]"


def _latest_summary_path(ctx: Any, chapter_number: int) -> Path | None:
    if not ctx.summaries_dir.exists():
        return None
    pattern = f"chapter_{chapter_number:03d}_summary*.md"
    files = [path for path in ctx.summaries_dir.glob(pattern) if path.is_file()]
    if not files:
        return None
    return max(files, key=lambda item: item.stat().st_mtime)


def _load_summary(ctx: Any, chapter_number: int) -> tuple[str, str]:
    path = _latest_summary_path(ctx, chapter_number)
    if path is None:
        return "", ""
    try:
        return path.read_text(encoding="utf-8"), path.name
    except OSError:
        return "", path.name


def _graph_summary(project_ref: str) -> str:
    result = load_narrative_graph(project_ref)
    if not result.ok:
        return f"Narrative Graph unavailable: {result.message}"
    graph = _dict(result.graph.get("graph"))
    nodes = [node for node in _list(graph.get("nodes")) if isinstance(node, dict)]
    edges = [edge for edge in _list(graph.get("edges")) if isinstance(edge, dict)]
    lines = [f"nodes={len(nodes)}, edges={len(edges)}"]
    for node in nodes[:20]:
        lines.append(
            "- node: "
            f"{_clean_text(node.get('id'))} | {_clean_text(node.get('type'))} | "
            f"{_clean_text(node.get('label'))} | importance {_clean_text(node.get('importance'))} | "
            f"status {_clean_text(node.get('status'))} | summary {_truncate(_clean_text(node.get('summary')), 180)}"
        )
    for edge in edges[:20]:
        lines.append(
            "- edge: "
            f"{_clean_text(edge.get('source'))} --{_clean_text(edge.get('label')) or _clean_text(edge.get('type'))}--> "
            f"{_clean_text(edge.get('target'))} | summary {_truncate(_clean_text(edge.get('summary')), 160)}"
        )
    return "\n".join(lines)


def _extract_config_text(project_config: dict[str, Any]) -> str:
    options = _dict(project_config.get("setting_generation_options"))
    fields = {
        "title": project_config.get("title"),
        "genre": project_config.get("genre"),
        "style": project_config.get("style"),
        "writing_mode": options.get("writing_mode"),
        "expected_chapters": options.get("expected_chapters"),
        "seed_prompt": project_config.get("seed_prompt") or project_config.get("story_seed"),
    }
    return "\n".join(f"{key}: {_clean_text(value)}" for key, value in fields.items() if _clean_text(value))


def build_story_delta_prompt(
    project_ref: str,
    chapter_number: int,
    project_config: dict[str, Any],
    chapter_content: str,
    chapter_summary: str = "",
    context_pack_summary: str = "",
) -> list[dict[str, str]]:
    outline, _ = read_latest_outline(project_ref)
    characters, _ = read_latest_characters(project_ref)
    target_chapter_number = int(chapter_number) + 1
    system_prompt = (
        "You are a story continuity analyst. You are not continuing the prose. "
        "Analyze an already generated chapter and return exactly one valid JSON object. "
        "Do not output Markdown, code fences, comments, explanations, or any text outside JSON. "
        "Use strict JSON syntax: double-quote every string, escape internal double quotes, "
        "put commas between all array items and object fields, and never use trailing commas. "
        "Do not treat next-chapter plans as facts that already happened. "
        "All candidate changes must require user review."
    )
    user_prompt = f"""
Analyze chapter {chapter_number} and return a single JSON object with this shape:
{{
  "story_delta": {{
    "new_characters": [],
    "character_updates": [],
    "new_scenes": [],
    "new_items": [],
    "new_events": [],
    "foreshadowing_updates": [],
    "relationship_updates": [],
    "world_fact_updates": []
  }},
  "next_chapter_proposal": {{
    "target_chapter_number": {target_chapter_number},
    "suggested_goal": "",
    "suggested_scenes": [],
    "suggested_conflicts": [],
    "suggested_foreshadowing_moves": [],
    "suggested_new_nodes": [],
    "suggested_new_edges": [],
    "suggested_plot_directions": [],
    "risks": []
  }},
  "candidate_changes": [
    {{
      "id": "change_1",
      "operation": "create_node",
      "target": "narrative_graph",
      "source": "story_delta",
      "confidence": 0.5,
      "requires_review": true,
      "evidence": "quote or concise evidence from chapter text",
      "payload": {{
        "type": "event",
        "label": "",
        "summary": "",
        "importance": 5,
        "layer": "major",
        "status": "confirmed"
      }}
    }}
  ],
  "warnings": []
}}

Rules:
- Output exactly one JSON object and nothing else.
- Do not wrap the JSON in Markdown or a code fence.
- Do not add comments, trailing commas, Python literals, or prose outside the JSON object.
- Every string must use double quotes, and double quotes inside strings must be escaped.
- Every array item and object field must be separated by a comma.
- story_delta describes facts that actually happened in chapter {chapter_number}.
- next_chapter_proposal describes proposed planning for chapter {target_chapter_number}; it is not confirmed canon.
- Put uncertain facts in warnings, not in story_delta.
- New characters must include evidence.
- Foreshadowing status changes must use introduced, reinforced, partially_revealed, revealed, or unresolved.
- Candidate operations should be create_node or create_edge only.
- Do not output create_character_card, update_character_card, create_world_fact, create_foreshadowing, update_foreshadowing, create_plot_direction, update_node, update_edge, or merge_suggestion.
- If a world fact, foreshadowing, plot direction, character state, or relationship note should be remembered, map it to create_node instead:
  - world fact -> create_node payload.type="world_fact"
  - foreshadowing -> create_node payload.type="foreshadowing"
  - plot direction -> create_node payload.type="plot_direction"
  - character card or character state -> create_node payload.type="character" or payload.type="relationship_note"
- create_node payloads must use "type"; do not use "node_type".
- create_node payloads should include label, summary, importance, layer, and status or suggested_status.
- When you create multiple nodes with clear relationships, add 1-3 high-confidence create_edge changes.
- create_edge payloads should use simple edge types: appears_in, causes, leads_to, reveals, foreshadows, monitors, constrains, protects, threatens, located_at, related_to, changes_status_of.
- create_edge payloads must include type, label, summary, importance, layer, and either source/target for existing graph node ids or source_change_id/target_change_id for nodes created in this same candidate_changes array.
- If an edge connects two nodes created in this same response, set source_change_id and target_change_id to the candidate change ids of those create_node records.
- Do not use source_label or target_label as merge identifiers.
- Do not generate edges with endpoints you cannot identify.
- Do not propose delete operations.
- Every candidate change must include a stable id like "change_1", requires_review=true, and evidence or rationale.
- Keep candidate_changes focused and concise; prefer 3-8 high-value changes rather than many low-value records.
- Create at most 5 create_node changes.
- Keep payload text concise. Do not copy long chapter passages into payload.
- Candidate payloads for next chapter proposals should use suggested_status="planned".
- Candidate payloads for facts directly stated in this chapter should use suggested_status="confirmed".

Uncertainty status guard:
- The summary wording and status must agree.
- If a candidate summary contains uncertainty markers such as 可能, 怀疑, 暗示, 似乎, 疑似, 尚未明确, 未证实, 间接表明, 线索指向, 可能关联, 推测, 猜测, 无法确认, or English markers like possible, suspected, hinted, implied, unconfirmed, unclear, indirectly suggests, or possible link, the candidate should usually NOT use status="confirmed".
- Use confirmed only for facts directly stated by the chapter text.
- Prefer unresolved for unanswered clues, possible links, indirect evidence, or facts that remain uncertain.
- Prefer introduced for newly introduced concepts, people, organizations, clues, or artifacts that are present but not fully explained.
- Prefer partially_revealed for information that is partly disclosed but not fully confirmed.
- Prefer active for ongoing states, open threads, or continuing relationships.
- Use planned only for future-facing setup or suggested future direction.
- confirmed is appropriate when the chapter directly states a fact, for example: 张建国的死亡证明日期是2004年9月17日; 张望舒被登记为时间连续者; someone gives 张望舒 a document numbered GA-2001-0923.
- confirmed is NOT appropriate when the chapter only hints that a file may be related to a death, a character suspects an organization is involved, a record is missing/damaged/marked but its meaning is unclear, a clue points toward a person but the person's role is not confirmed, or a character feels that two events may be connected.
- If the summary says 可能, 疑似, 暗示, 尚未明确, or 线索指向, do not mark it confirmed.
- If the status is confirmed, write the summary as a directly stated fact and ensure the chapter explicitly supports it.
- Do not use confirmed merely because a clue is important. A clue can be important and still be unresolved, introduced, partially_revealed, or active.
- Do not use high importance to compensate for uncertainty.

Evidence grounding and fact-compression guard:
- Only create candidate changes from facts explicitly supported by the chapter text.
- Do not upgrade hints, suspicions, indirect evidence, emotional impressions, or character guesses into confirmed facts.
- If the chapter only implies something, preserve that uncertainty in the candidate summary and status.
- Use confirmed only when the chapter text directly states the fact.
- For indirect evidence, unanswered clues, partial records, suspicious coincidences, or character speculation, use an existing non-confirmed status if supported by the payload type, such as unresolved, introduced, partially_revealed, active, or planned.
- If no precise uncertainty status fits, keep the summary wording uncertain and choose a lower importance.
- Do not rewrite or substitute disease names, dates, years, death causes, death timing, voting timing, investigation targets, organization actions, or causality.
- If the chapter says 肝硬化, do not summarize it as 肝癌.
- If the chapter says a vote happened after 1987, do not summarize it as happening in 1978.
- If the chapter suggests a possible link to father's death, do not summarize it as confirmed death causality.
- If the chapter says an accident investigation occurred, do not turn it into a confirmed operation behind another death.
- Do not create a causal relationship unless the chapter explicitly states causality.
- If the text only places two events near each other, or a character suspects a connection, summarize it as a clue or possible link, not as confirmed cause.
- Uncertain or inferred facts should usually have lower importance than confirmed irreversible facts.
- Do not use high importance to compensate for weak evidence.

Importance rubric:
- Importance scale:
  - 1-3: Minor detail. Useful for local flavor, but unlikely to affect future chapters.
  - 4-5: Useful continuity fact. May help local continuity but is not a major constraint.
  - 6-7: Significant story asset. Likely to matter again, but can remain normal context.
  - 8-9: Major continuity constraint. Should be rare. Affects future plot, identity, irreversible events, key relationships, or world rules.
  - 10: Foundational canon. Extremely rare. Only for central irreversible facts that would break the story if changed.
- Most candidate_changes should fall between 4 and 7.
- confirmed is not the same as high importance. Do not mark every confirmed fact as 8+.
- Use 8+ only when the information should become a hard continuity constraint in future generation.
- Dates, death/survival states, identity status, organization affiliation, and major causality can be 8+ only if they are important to future continuity.
- Ordinary scene events, one-time interactions, minor observations, and local emotional beats should usually be 4-6.
- create_edge importance should reflect the importance of the relationship itself, not merely the importance of source/target nodes.
- If uncertain, choose the lower reasonable importance.

Project config:
{_truncate(_extract_config_text(project_config), 3000)}

Existing outline summary:
{_truncate(outline or "", 3000)}

Existing character cards summary:
{_truncate(characters or "", 3000)}

Narrative Graph summary:
{_truncate(_graph_summary(project_ref), 5000)}

Context Pack summary:
{_truncate(context_pack_summary, 3000) or "No Context Pack summary provided."}

Chapter summary:
{_truncate(chapter_summary, 2000) or "No chapter summary found."}

Chapter text:
{_truncate(chapter_content, 14000)}
""".strip()
    return [{"role": "system", "content": system_prompt}, {"role": "user", "content": user_prompt}]


def _dry_run_response(chapter_number: int, chapter_content: str, include_next: bool) -> dict[str, Any]:
    first_line = next((line.strip("# ").strip() for line in chapter_content.splitlines() if line.strip()), "")
    evidence = _truncate(first_line or f"Chapter {chapter_number} exists and can be analyzed.", 240)
    next_chapter = int(chapter_number) + 1
    return {
        "story_delta": {
            **DEFAULT_STORY_DELTA,
            "new_events": [
                {
                    "label": f"Chapter {chapter_number} analysis placeholder",
                    "summary": "Dry-run placeholder generated without calling the model.",
                    "evidence": evidence,
                    "suggested_status": "confirmed",
                }
            ],
        },
        "next_chapter_proposal": {
            **DEFAULT_NEXT_CHAPTER_PROPOSAL,
            "target_chapter_number": next_chapter,
            "suggested_goal": f"Review chapter {chapter_number} outcomes before drafting chapter {next_chapter}.",
            "risks": ["Dry-run result is a local placeholder, not model analysis."],
        }
        if include_next
        else {**DEFAULT_NEXT_CHAPTER_PROPOSAL, "target_chapter_number": next_chapter},
        "candidate_changes": [
            {
                "operation": "create_plot_direction",
                "target": "narrative_graph",
                "source": "next_chapter_proposal",
                "confidence": 0.1,
                "requires_review": True,
                "rationale": "Dry-run placeholder confirms the draft pipeline without calling DeepSeek.",
                "payload": {
                    "label": f"Dry-run next chapter direction after chapter {chapter_number}",
                    "summary": f"Prepare a reviewed plan for chapter {next_chapter}.",
                    "suggested_status": "planned",
                },
            }
        ],
        "warnings": ["Dry-run mode used. No DeepSeek call was made."],
    }


def _strip_markdown_code_fence(text: str) -> str:
    cleaned = _clean_text(text)
    fenced = re.search(r"```(?:json)?\s*(.*?)```", cleaned, flags=re.IGNORECASE | re.DOTALL)
    if fenced:
        return fenced.group(1).strip()
    return cleaned


def _extract_json_object(text: str) -> str:
    cleaned = _strip_markdown_code_fence(text)
    start = cleaned.find("{")
    if start < 0:
        return ""

    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(cleaned)):
        char = cleaned[index]
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
                return cleaned[start : index + 1].strip()

    end = cleaned.rfind("}")
    if end > start:
        return cleaned[start : end + 1].strip()
    return cleaned[start:].strip()


def _repair_common_json_issues(text: str) -> str:
    repaired = _extract_json_object(text)
    repaired = repaired.lstrip("\ufeff")
    repaired = re.sub(r",\s*([}\]])", r"\1", repaired)
    repaired = re.sub(r"\bTrue\b", "true", repaired)
    repaired = re.sub(r"\bFalse\b", "false", repaired)
    repaired = re.sub(r"\bNone\b", "null", repaired)
    return repaired


def _parse_story_delta_json(raw_text: str) -> StoryDeltaParseResult:
    text = _repair_common_json_issues(raw_text)
    if not text:
        return StoryDeltaParseResult(error="Model response did not contain a JSON object.")
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        return StoryDeltaParseResult(
            error=f"Story Delta JSON parse failed: {exc.msg} at line {exc.lineno}, column {exc.colno}.",
            json_text=text,
        )
    if not isinstance(data, dict):
        return StoryDeltaParseResult(error="Story Delta response must be a JSON object.", json_text=text)
    return StoryDeltaParseResult(data=data, json_text=text)


def parse_story_delta_response(raw_text: str) -> tuple[dict[str, Any] | None, str]:
    result = _parse_story_delta_json(raw_text)
    return result.data, result.error


def build_story_delta_json_repair_prompt(raw_output: str, parse_error: str) -> list[dict[str, str]]:
    system_prompt = (
        "You repair malformed JSON only. Do not analyze the story again. "
        "Return exactly one valid JSON object and no Markdown, code fences, comments, or explanations."
    )
    user_prompt = f"""
Repair the following Story Delta model output into strict valid JSON.

Rules:
- Do not add new story facts.
- Do not remove existing story facts.
- Only fix JSON syntax, field structure, missing commas, invalid quotes, invalid literals, or Markdown wrapping.
- Output one JSON object with top-level keys: story_delta, next_chapter_proposal, candidate_changes, warnings.
- Use double quotes for all strings.
- Escape internal double quotes inside strings.
- Use commas between all array items and object fields.
- Do not use trailing commas.
- Do not output any text outside the JSON object.
- If the malformed output was truncated, preserve complete data that is present, close the JSON safely, and add a warning noting truncation.
- The first character of your response must be {{ and the last character must be }}.

Parser error:
{_truncate(parse_error, 500)}

Malformed output:
{_truncate(raw_output, 24000)}
""".strip()
    return [{"role": "system", "content": system_prompt}, {"role": "user", "content": user_prompt}]


def _parse_or_repair_story_delta_response(
    ctx: Any,
    project_ref: str,
    chapter_number: int,
    raw_output: str,
    model: str | None,
    max_tokens: int,
) -> tuple[dict[str, Any] | None, dict[str, Any], str]:
    initial = _parse_story_delta_json(raw_output)
    metadata: dict[str, Any] = {
        "parse_status": "success" if initial.data is not None else "failed",
        "repair_used": False,
        "failure_ref": None,
        "repair_failure_ref": None,
    }
    if initial.data is not None:
        return initial.data, metadata, ""

    failure_ref, failure_save_error = _save_story_delta_failure(
        ctx=ctx,
        project_ref=project_ref,
        chapter_number=chapter_number,
        stage="initial_parse",
        parse_error=initial.error,
        raw_output=raw_output,
        model=model,
    )
    if failure_ref:
        metadata["failure_ref"] = failure_ref
    if failure_save_error:
        metadata["failure_artifact_error"] = failure_save_error

    repair_messages = build_story_delta_json_repair_prompt(raw_output, initial.error)
    try:
        repair_output = generate_text(
            messages=repair_messages,
            model=model,
            temperature=0,
            max_tokens=max_tokens,
        )
    except DeepSeekClientError as exc:
        error_parts = [f"Story Delta JSON parse failed and repair request failed: {exc}"]
        if failure_ref:
            error_parts.append(f"failure_ref={failure_ref}")
        return None, metadata, " ".join(error_parts)
    except Exception as exc:
        error_parts = [f"Story Delta JSON parse failed and repair failed: {exc}"]
        if failure_ref:
            error_parts.append(f"failure_ref={failure_ref}")
        return None, metadata, " ".join(error_parts)

    repaired = _parse_story_delta_json(repair_output)
    if repaired.data is not None:
        metadata["parse_status"] = "success"
        metadata["repair_used"] = True
        return repaired.data, metadata, ""

    repair_failure_ref, repair_failure_save_error = _save_story_delta_failure(
        ctx=ctx,
        project_ref=project_ref,
        chapter_number=chapter_number,
        stage="repair_parse",
        parse_error=repaired.error,
        raw_output=repair_output,
        model=model,
    )
    if repair_failure_ref:
        metadata["repair_failure_ref"] = repair_failure_ref
    if repair_failure_save_error:
        metadata["repair_failure_artifact_error"] = repair_failure_save_error

    error_parts = [f"{initial.error} Repair also failed: {repaired.error}"]
    if failure_ref:
        error_parts.append(f"failure_ref={failure_ref}")
    if repair_failure_ref:
        error_parts.append(f"repair_failure_ref={repair_failure_ref}")
    return None, metadata, " ".join(error_parts)


def _string_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [_clean_text(item) for item in value if _clean_text(item)]
    if isinstance(value, str) and value.strip():
        return [value.strip()]
    return []


def normalize_story_delta(data: dict[str, Any], chapter_number: int, include_next: bool) -> tuple[dict[str, Any], dict[str, Any], list[dict[str, Any]], list[str]]:
    warnings = _string_list(data.get("warnings"))
    raw_delta = _dict(data.get("story_delta"))
    story_delta = {key: _list(raw_delta.get(key)) for key in DEFAULT_STORY_DELTA}

    for item in story_delta["new_characters"]:
        if isinstance(item, dict) and not (_clean_text(item.get("evidence")) or _clean_text(item.get("rationale"))):
            warnings.append("A new character entry was missing evidence and requires extra review.")
            item["rationale"] = "Model omitted evidence; reviewer must confirm before merge."

    raw_proposal = _dict(data.get("next_chapter_proposal"))
    next_proposal: dict[str, Any] = {}
    for key, default in DEFAULT_NEXT_CHAPTER_PROPOSAL.items():
        value = raw_proposal.get(key, default)
        next_proposal[key] = _list(value) if isinstance(default, list) else value
    try:
        target = int(next_proposal.get("target_chapter_number") or int(chapter_number) + 1)
    except (TypeError, ValueError):
        target = int(chapter_number) + 1
    next_proposal["target_chapter_number"] = target
    if not include_next:
        next_proposal = {**DEFAULT_NEXT_CHAPTER_PROPOSAL, "target_chapter_number": target}

    raw_changes = data.get("candidate_changes")
    candidate_changes = [item for item in _list(raw_changes) if isinstance(item, dict)]
    return story_delta, next_proposal, candidate_changes, warnings


def _confidence(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    if parsed < 0 or parsed > 1:
        return None
    return parsed


def _candidate_change(
    operation: str,
    target: str,
    source: str,
    payload: dict[str, Any],
    evidence: str = "",
    rationale: str = "",
    confidence: float | None = None,
    change_id: str = "",
) -> dict[str, Any]:
    change: dict[str, Any] = {
        "id": _safe_provided_id(change_id) or _safe_id("change"),
        "operation": operation,
        "target": target,
        "source": source if source in {"story_delta", "next_chapter_proposal"} else "story_delta",
        "requires_review": True,
        "payload": dict(payload),
    }
    if confidence is not None:
        change["confidence"] = confidence
    if evidence:
        change["evidence"] = evidence
    else:
        change["rationale"] = rationale or "Candidate requires manual review before merge."
    return change


def _first_text(*values: Any) -> str:
    for value in values:
        text = _clean_text(value)
        if text:
            return text
    return ""


def _normalized_importance(value: Any, default: int) -> int:
    if value in (None, "") or isinstance(value, bool):
        return default
    try:
        parsed = int(float(value))
    except (TypeError, ValueError, OverflowError):
        return default
    return min(10, max(1, parsed))


def _normalized_layer(value: Any, default: str) -> str:
    layer = _clean_text(value)
    return layer if layer in LAYERS else default


def _normalize_node_candidate_payload(payload: dict[str, Any], forced_type: str = "") -> dict[str, Any]:
    normalized = dict(payload)
    node_type = _clean_text(forced_type) or _clean_text(normalized.get("type")) or _clean_text(normalized.get("node_type"))
    if node_type:
        normalized["type"] = node_type
    normalized.pop("node_type", None)

    label = _first_text(
        normalized.get("label"),
        normalized.get("name"),
        normalized.get("character_name"),
        normalized.get("fact"),
        normalized.get("foreshadowing"),
        normalized.get("direction"),
        normalized.get("title"),
    )
    if label:
        normalized["label"] = _truncate(label, 120)

    summary = _first_text(
        normalized.get("summary"),
        normalized.get("description"),
        normalized.get("changes"),
        normalized.get("change"),
        normalized.get("fact"),
        normalized.get("evidence"),
    )
    if summary:
        normalized["summary"] = _truncate(summary, 500)

    default_importance = 6 if node_type == "world_fact" else 5
    default_layer = "major" if node_type in {"foreshadowing", "plot_direction", "world_fact", "event"} else "detail"
    normalized["importance"] = _normalized_importance(normalized.get("importance"), default_importance)
    normalized["layer"] = _normalized_layer(normalized.get("layer"), default_layer)
    return normalized


def _normalize_edge_endpoint_refs(payload: dict[str, Any]) -> None:
    for endpoint in ("source", "target"):
        node_id_key = f"{endpoint}_node_id"
        if not _clean_text(payload.get(endpoint)) and _clean_text(payload.get(node_id_key)):
            payload[endpoint] = _clean_text(payload.get(node_id_key))
        change_id_key = f"{endpoint}_change_id"
        if _clean_text(payload.get(change_id_key)):
            payload[change_id_key] = _safe_provided_id(payload.get(change_id_key))


def _normalize_edge_candidate_payload(payload: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(payload)
    _normalize_edge_endpoint_refs(normalized)

    edge_type = _clean_text(normalized.get("type")) or "related_to"
    if edge_type not in EDGE_TYPES:
        edge_type = "related_to"
    normalized["type"] = edge_type

    label = _first_text(normalized.get("label"), normalized.get("description"), normalized.get("summary"), edge_type)
    normalized["label"] = _truncate(label.replace("_", " "), 120)

    summary = _first_text(normalized.get("summary"), normalized.get("description"), normalized.get("change"), normalized.get("evidence"))
    if summary:
        normalized["summary"] = _truncate(summary, 500)

    normalized["importance"] = _normalized_importance(normalized.get("importance"), 5)
    normalized["layer"] = _normalized_layer(normalized.get("layer"), "detail")
    return normalized


def _normalize_candidate_operation_and_payload(
    operation: str,
    payload: dict[str, Any],
    warnings: list[str],
) -> tuple[str, dict[str, Any]] | None:
    if operation in OPERATION_TO_NODE_TYPE:
        mapped_type = OPERATION_TO_NODE_TYPE[operation]
        warnings.append(f"Mapped {operation} candidate to create_node type={mapped_type}.")
        return "create_node", _normalize_node_candidate_payload(payload, mapped_type)
    if operation == "create_node":
        return "create_node", _normalize_node_candidate_payload(payload)
    if operation == "create_edge":
        return "create_edge", _normalize_edge_candidate_payload(payload)
    if operation in ALLOWED_OPERATIONS:
        return operation, dict(payload)
    warnings.append(f"Skipped unsupported candidate operation: {operation or '[empty]'}")
    return None


def _normalize_candidate_change(change: dict[str, Any], warnings: list[str]) -> dict[str, Any] | None:
    operation = _clean_text(change.get("operation"))
    payload = _dict(change.get("payload"))
    normalized_operation = _normalize_candidate_operation_and_payload(operation, payload, warnings)
    if normalized_operation is None:
        return None
    operation, payload = normalized_operation
    source = _clean_text(change.get("source")) or "story_delta"
    if source not in {"story_delta", "next_chapter_proposal"}:
        source = "story_delta"
    evidence = _clean_text(change.get("evidence"))
    rationale = _clean_text(change.get("rationale"))
    if not evidence and not rationale:
        warnings.append(f"Candidate change {operation} lacked evidence/rationale and was marked for extra review.")
        rationale = "Model omitted evidence; reviewer must confirm before merge."
    target = _clean_text(change.get("target")) or "narrative_graph"
    if operation in {"create_node", "create_edge"}:
        target = "narrative_graph"
    normalized = _candidate_change(
        operation=operation,
        target=target,
        source=source,
        payload=payload,
        evidence=evidence,
        rationale=rationale,
        confidence=_confidence(change.get("confidence")),
        change_id=_clean_text(change.get("id")),
    )
    normalized["requires_review"] = True
    return normalized


def _derive_changes_from_delta(story_delta: dict[str, Any], next_proposal: dict[str, Any]) -> list[dict[str, Any]]:
    changes: list[dict[str, Any]] = []
    for item in _list(story_delta.get("new_characters")):
        if isinstance(item, dict):
            label = _clean_text(item.get("label") or item.get("name"))
            changes.append(
                _candidate_change(
                    "create_node",
                    "narrative_graph",
                    "story_delta",
                    _normalize_node_candidate_payload({**item, "type": "character", "label": label, "suggested_status": "confirmed"}),
                    evidence=_clean_text(item.get("evidence")),
                    rationale=f"New character candidate: {label}",
                )
            )
    for item in _list(story_delta.get("character_updates")):
        if isinstance(item, dict):
            character = _clean_text(item.get("character") or item.get("name") or item.get("label"))
            changes.append(
                _candidate_change(
                    "create_node",
                    "narrative_graph",
                    "story_delta",
                    _normalize_node_candidate_payload(
                        {
                            **item,
                            "type": "relationship_note",
                            "label": f"{character} 状态变化" if character else _clean_text(item.get("label")),
                            "suggested_status": "confirmed",
                        }
                    ),
                    evidence=_clean_text(item.get("evidence")),
                    rationale="Character update candidate from chapter facts.",
                )
            )
    node_sources = [
        ("new_scenes", "scene"),
        ("new_items", "item"),
        ("new_events", "event"),
        ("world_fact_updates", "world_fact"),
        ("foreshadowing_updates", "foreshadowing"),
    ]
    for key, node_type in node_sources:
        for item in _list(story_delta.get(key)):
            if isinstance(item, dict):
                changes.append(
                    _candidate_change(
                        "create_node",
                        "narrative_graph",
                        "story_delta",
                        _normalize_node_candidate_payload(
                            {**item, "type": item.get("type") or node_type, "suggested_status": "confirmed"},
                            node_type,
                        ),
                        evidence=_clean_text(item.get("evidence")),
                        rationale=f"{node_type} candidate from chapter facts.",
                    )
                )
    for item in _list(story_delta.get("relationship_updates")):
        if isinstance(item, dict):
            label = _clean_text(item.get("label"))
            if not label:
                characters = item.get("characters")
                if isinstance(characters, list):
                    names = [_clean_text(name) for name in characters if _clean_text(name)]
                    label = " / ".join(names[:3])
            if not label:
                label = "Relationship note"
            changes.append(
                _candidate_change(
                    "create_node",
                    "narrative_graph",
                    "story_delta",
                    _normalize_node_candidate_payload(
                        {**item, "type": "relationship_note", "label": label, "suggested_status": "confirmed"},
                        "relationship_note",
                    ),
                    evidence=_clean_text(item.get("evidence")),
                    rationale="Relationship candidate from chapter facts.",
                )
            )
    for item in _list(next_proposal.get("suggested_new_nodes")):
        if isinstance(item, dict):
            changes.append(
                _candidate_change(
                    "create_node",
                    "narrative_graph",
                    "next_chapter_proposal",
                    _normalize_node_candidate_payload({**item, "suggested_status": "planned"}),
                    rationale=_clean_text(item.get("rationale")) or "Suggested node for next chapter planning.",
                )
            )
    for item in _list(next_proposal.get("suggested_new_edges")):
        if isinstance(item, dict):
            changes.append(
                _candidate_change(
                    "create_edge",
                    "narrative_graph",
                    "next_chapter_proposal",
                    _normalize_edge_candidate_payload({**item, "suggested_status": "planned"}),
                    rationale=_clean_text(item.get("rationale")) or "Suggested edge for next chapter planning.",
                )
            )
    for item in _list(next_proposal.get("suggested_plot_directions")):
        if isinstance(item, dict):
            changes.append(
                _candidate_change(
                    "create_node",
                    "narrative_graph",
                    "next_chapter_proposal",
                    _normalize_node_candidate_payload(
                        {**item, "type": "plot_direction", "suggested_status": "planned"},
                        "plot_direction",
                    ),
                    rationale=_clean_text(item.get("rationale")) or "Suggested plot direction for next chapter planning.",
                )
            )
    return changes


def _dedupe_candidate_change_ids(changes: list[dict[str, Any]], namespace: str = "") -> list[dict[str, Any]]:
    seen: set[str] = set()
    id_map: dict[str, str] = {}
    result: list[dict[str, Any]] = []
    safe_namespace = _safe_provided_id(namespace)
    for change in changes:
        original = _safe_provided_id(change.get("id")) or _safe_id("change")
        current = original
        if safe_namespace and not current.startswith(f"{safe_namespace}_"):
            current = f"{safe_namespace}_{current}"
        base_current = current
        suffix = 2
        while current in seen:
            current = f"{base_current}_{suffix}"
            suffix += 1
        seen.add(current)
        if original != current:
            id_map[original] = current
        normalized = dict(change)
        normalized["id"] = current
        result.append(normalized)

    if id_map:
        for change in result:
            if _clean_text(change.get("operation")) != "create_edge":
                continue
            payload = dict(change.get("payload") if isinstance(change.get("payload"), dict) else {})
            changed = False
            for key in ("source_change_id", "target_change_id"):
                ref = _safe_provided_id(payload.get(key))
                if ref in id_map:
                    payload[key] = id_map[ref]
                    changed = True
            if changed:
                change["payload"] = payload
    return result


def build_knowledge_draft(
    chapter_number: int,
    source_delta_id: str,
    story_delta: dict[str, Any],
    next_proposal: dict[str, Any],
    candidate_changes: list[dict[str, Any]],
    warnings: list[str],
) -> dict[str, Any]:
    draft_id = _safe_id(f"draft_chapter_{int(chapter_number):03d}")
    normalized_changes: list[dict[str, Any]] = []
    for change in candidate_changes:
        normalized = _normalize_candidate_change(change, warnings)
        if normalized is not None:
            normalized_changes.append(normalized)
    if not normalized_changes:
        normalized_changes.extend(_derive_changes_from_delta(story_delta, next_proposal))
    normalized_changes = _dedupe_candidate_change_ids(normalized_changes, draft_id)
    return {
        "id": draft_id,
        "chapter_number": int(chapter_number),
        "source_delta_id": source_delta_id,
        "status": "pending_review",
        "candidate_changes": normalized_changes,
        "created_at": _timestamp(),
    }


def save_story_delta(project_ref: str, item: dict[str, Any]) -> StoryDeltaListResult:
    ctx, message = _workspace_context(project_ref)
    if ctx is None:
        return StoryDeltaListResult(False, project_ref=project_ref, message=message)
    try:
        document = _normalize_story_deltas_document(_read_json(_story_deltas_path(ctx)), project_ref)
        document["items"].append(dict(item))
        _update_metadata(document)
        _write_json_atomic(_story_deltas_path(ctx), document)
    except (OSError, ValueError) as exc:
        return StoryDeltaListResult(False, project_ref=project_ref, message=f"Story Delta save failed: {exc}")
    return StoryDeltaListResult(True, project_ref=project_ref, items=document["items"])


def save_knowledge_draft(project_ref: str, draft: dict[str, Any]) -> StoryDeltaListResult:
    ctx, message = _workspace_context(project_ref)
    if ctx is None:
        return StoryDeltaListResult(False, project_ref=project_ref, message=message)
    try:
        document = _normalize_knowledge_drafts_document(_read_json(_knowledge_drafts_path(ctx)), project_ref)
        document["drafts"].append(dict(draft))
        _update_metadata(document)
        _write_json_atomic(_knowledge_drafts_path(ctx), document)
    except (OSError, ValueError) as exc:
        return StoryDeltaListResult(False, project_ref=project_ref, message=f"Knowledge Draft save failed: {exc}")
    return StoryDeltaListResult(True, project_ref=project_ref, drafts=document["drafts"])


def analyze_chapter_delta(project_ref: str, chapter_number: Any, request: dict[str, Any]) -> StoryDeltaResult:
    number, error = _validate_chapter_number(chapter_number)
    if error:
        return StoryDeltaResult(False, project_ref=project_ref, chapter_number=number, message=error)
    ctx, message = _workspace_context(project_ref)
    if ctx is None:
        return StoryDeltaResult(False, project_ref=project_ref, chapter_number=number, message=message)

    include_next = _as_bool(request.get("include_next_chapter_proposal"), True)
    include_draft = _as_bool(request.get("include_knowledge_draft"), True)
    dry_run = _as_bool(request.get("dry_run"), False)
    mock_response = request.get("mock_response")
    context_pack_summary = _clean_text(request.get("context_pack_summary"))

    detail = load_project_detail(project_ref)
    if not detail.ok:
        return StoryDeltaResult(False, project_ref=project_ref, chapter_number=number, message=detail.message or "Project config was not found.")
    project_config = dict(detail.config if isinstance(detail.config, dict) else {})

    chapter = read_chapter_for_display(project_ref, number)
    if not chapter.ok:
        return StoryDeltaResult(False, project_ref=project_ref, chapter_number=number, message=chapter.message or f"Chapter {number} was not found.")
    chapter_summary, summary_file = _load_summary(ctx, number)
    model = _clean_text(project_config.get("model")) or None
    resolved_max_tokens = _story_delta_max_tokens(project_config)
    analysis_messages: list[dict[str, str]] | None = None
    analysis_status = "success"
    parse_metadata: dict[str, Any] = {
        "parse_status": "success",
        "repair_used": False,
        "failure_ref": None,
        "repair_failure_ref": None,
    }

    if mock_response not in (None, ""):
        analysis_status = "mocked"
        raw_payload = mock_response if isinstance(mock_response, dict) else None
        if raw_payload is None:
            raw_payload, parse_error = parse_story_delta_response(str(mock_response))
            if parse_error:
                return StoryDeltaResult(False, project_ref=project_ref, chapter_number=number, message=parse_error)
    elif dry_run:
        analysis_status = "dry_run"
        raw_payload = _dry_run_response(number, chapter.content, include_next)
    else:
        messages = build_story_delta_prompt(
            project_ref=project_ref,
            chapter_number=number,
            project_config=project_config,
            chapter_content=chapter.content,
            chapter_summary=chapter_summary,
            context_pack_summary=context_pack_summary,
        )
        analysis_messages = messages
        try:
            analysis_text = generate_text(
                messages=messages,
                model=model,
                temperature=0.2,
                max_tokens=resolved_max_tokens,
            )
        except DeepSeekClientError as exc:
            return StoryDeltaResult(False, project_ref=project_ref, chapter_number=number, message=str(exc))
        except Exception as exc:
            return StoryDeltaResult(False, project_ref=project_ref, chapter_number=number, message=f"Story Delta analysis failed: {exc}")
        raw_payload, parse_metadata, parse_error = _parse_or_repair_story_delta_response(
            ctx=ctx,
            project_ref=project_ref,
            chapter_number=number,
            raw_output=analysis_text,
            model=model,
            max_tokens=resolved_max_tokens,
        )
        if parse_error:
            return StoryDeltaResult(
                False,
                project_ref=project_ref,
                chapter_number=number,
                message=parse_error,
                metadata=parse_metadata,
            )

    story_delta, next_proposal, candidate_changes, warnings = normalize_story_delta(raw_payload or {}, number, include_next)
    delta_id = _safe_id(f"delta_chapter_{number:03d}")
    created_at = _timestamp()
    story_delta_item = {
        "id": delta_id,
        "chapter_number": number,
        "source": {
            "source_type": "chapter",
            "source_ref": f"chapter_{number:03d}",
            "chapter_file": Path(chapter.filename).name,
            "summary_file": summary_file,
        },
        "status": "pending_review",
        "story_delta": story_delta,
        "next_chapter_proposal": next_proposal,
        "warnings": warnings,
        "metadata": parse_metadata,
        "created_at": created_at,
    }
    save_delta_result = save_story_delta(project_ref, story_delta_item)
    if not save_delta_result.ok:
        return StoryDeltaResult(False, project_ref=project_ref, chapter_number=number, message=save_delta_result.message)

    knowledge_draft: dict[str, Any] = {}
    if include_draft:
        knowledge_draft = build_knowledge_draft(
            chapter_number=number,
            source_delta_id=delta_id,
            story_delta=story_delta,
            next_proposal=next_proposal,
            candidate_changes=candidate_changes,
            warnings=warnings,
        )
        draft_result = save_knowledge_draft(project_ref, knowledge_draft)
        if not draft_result.ok:
            return StoryDeltaResult(False, project_ref=project_ref, chapter_number=number, message=draft_result.message)

    changed_targets = ["memory/story_deltas.json"]
    if include_draft:
        changed_targets.append("memory/knowledge_drafts.json")
    ai_run_result = create_ai_run_record_best_effort(
        project_ref=project_ref,
        run_type="story_delta_analysis",
        chapter_number=number,
        model=model,
        temperature=0.2,
        max_tokens=resolved_max_tokens,
        prompt_profile=build_prompt_profile("story_delta_analysis", analysis_messages),
        context={
            "context_pack_id": None,
            "included_node_ids": [],
            "included_edge_ids": [],
            "outline_refs": [],
            "summary_refs": [summary_file] if summary_file else [],
            "chapter_refs": [Path(chapter.filename).name],
            "metadata": {
                "context_pack_summary_present": bool(context_pack_summary),
                "include_next_chapter_proposal": include_next,
                "include_knowledge_draft": include_draft,
                "parse_status": parse_metadata.get("parse_status"),
                "repair_used": bool(parse_metadata.get("repair_used")),
            },
        },
        result={
            "status": analysis_status,
            "output_ref": "memory/story_deltas.json",
            "finish_reason": None,
            "error": None,
            "metadata": {
                "story_delta_id": delta_id,
                "knowledge_draft_id": knowledge_draft.get("id") if isinstance(knowledge_draft, dict) else None,
                "parse_status": parse_metadata.get("parse_status"),
                "repair_used": bool(parse_metadata.get("repair_used")),
                "failure_ref": parse_metadata.get("failure_ref"),
                "repair_failure_ref": parse_metadata.get("repair_failure_ref"),
            },
        },
    )
    ai_run_id = ai_run_result.run_id if ai_run_result.ok else None
    append_event_best_effort(
        project_ref=project_ref,
        event_type="story_delta_analyzed",
        summary=f"Story Delta analyzed for chapter {number}.",
        chapter_number=number,
        source={
            "story_delta_id": delta_id,
            "knowledge_draft_id": knowledge_draft.get("id") if isinstance(knowledge_draft, dict) else None,
            "include_knowledge_draft": include_draft,
            "ai_run_id": ai_run_id,
            "parse_status": parse_metadata.get("parse_status"),
            "repair_used": bool(parse_metadata.get("repair_used")),
            "failure_ref": parse_metadata.get("failure_ref"),
        },
        changed_targets=changed_targets,
    )

    return StoryDeltaResult(
        True,
        project_ref=project_ref,
        chapter_number=number,
        story_delta=story_delta,
        next_chapter_proposal=next_proposal,
        knowledge_draft=knowledge_draft,
        warnings=warnings,
        message="Story Delta analysis saved.",
        story_delta_item=story_delta_item,
        metadata=parse_metadata,
    )


def list_story_deltas(project_ref: str) -> StoryDeltaListResult:
    ctx, message = _workspace_context(project_ref)
    if ctx is None:
        return StoryDeltaListResult(False, project_ref=project_ref, message=message)
    try:
        document = _normalize_story_deltas_document(_read_json(_story_deltas_path(ctx)), project_ref)
    except (OSError, ValueError) as exc:
        return StoryDeltaListResult(False, project_ref=project_ref, message=f"Story Delta read failed: {exc}")
    return StoryDeltaListResult(True, project_ref=project_ref, items=document["items"])


def list_knowledge_drafts(project_ref: str) -> StoryDeltaListResult:
    ctx, message = _workspace_context(project_ref)
    if ctx is None:
        return StoryDeltaListResult(False, project_ref=project_ref, message=message)
    try:
        document = _normalize_knowledge_drafts_document(_read_json(_knowledge_drafts_path(ctx)), project_ref)
    except (OSError, ValueError) as exc:
        return StoryDeltaListResult(False, project_ref=project_ref, message=f"Knowledge Draft read failed: {exc}")
    return StoryDeltaListResult(True, project_ref=project_ref, drafts=document["drafts"])


def get_knowledge_draft(project_ref: str, draft_id: str) -> StoryDeltaListResult:
    result = list_knowledge_drafts(project_ref)
    if not result.ok:
        return result
    wanted = _clean_text(draft_id)
    for draft in result.drafts:
        if isinstance(draft, dict) and _clean_text(draft.get("id")) == wanted:
            return StoryDeltaListResult(True, project_ref=result.project_ref, draft=draft)
    return StoryDeltaListResult(False, project_ref=result.project_ref, message="Knowledge Draft not found.")
