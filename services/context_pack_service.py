from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from .narrative_graph_service import load_narrative_graph


DEFAULT_MIN_IMPORTANCE = 5
DEFAULT_MAX_NODES = 20
DEFAULT_MAX_EDGES = 30
HARD_CONSTRAINT_MIN_IMPORTANCE = 8
MAX_PROMPT_ITEMS_PER_SECTION = 20
UNRESOLVED_FORESHADOWING_STATUSES = {"unresolved", "foreshadowed", "active"}
SECTION_BY_TYPE = {
    "character": "characters",
    "scene": "scenes",
    "item": "items",
    "foreshadowing": "foreshadowing",
    "plot_direction": "plot_directions",
    "world_fact": "world_facts",
    "event": "events",
    "organization": "organizations",
}
PROMPT_SECTION_TITLES = [
    ("Core Facts", "core_facts"),
    ("Characters", "characters"),
    ("Scenes", "scenes"),
    ("Items", "items"),
    ("Foreshadowing", "foreshadowing"),
    ("Plot Directions", "plot_directions"),
    ("World Facts", "world_facts"),
    ("Events", "events"),
    ("Organizations", "organizations"),
]


@dataclass(frozen=True)
class ContextPackResult:
    ok: bool
    project_ref: str = ""
    context_pack: dict[str, Any] = field(default_factory=dict)
    prompt_text: str = ""
    message: str = ""


def _clean_text(value: Any) -> str:
    return str(value or "").strip()


def _as_int(value: Any, default: int) -> int | None:
    if value is None or value == "":
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


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


def _validate_request(request: dict[str, Any]) -> tuple[dict[str, Any] | None, str]:
    chapter_number = _as_int(request.get("chapter_number"), 1)
    if chapter_number is None or chapter_number < 1:
        return None, "chapter_number must be a positive integer."

    min_importance = _as_int(request.get("min_importance"), DEFAULT_MIN_IMPORTANCE)
    if min_importance is None or min_importance < 1 or min_importance > 10:
        return None, "min_importance must be between 1 and 10."

    max_nodes = _as_int(request.get("max_nodes"), DEFAULT_MAX_NODES)
    if max_nodes is None or max_nodes < 1 or max_nodes > 100:
        return None, "max_nodes must be between 1 and 100."

    max_edges = _as_int(request.get("max_edges"), DEFAULT_MAX_EDGES)
    if max_edges is None or max_edges < 0 or max_edges > 200:
        return None, "max_edges must be between 0 and 200."

    return {
        "chapter_number": chapter_number,
        "chapter_goal": _clean_text(request.get("chapter_goal")),
        "min_importance": min_importance,
        "max_nodes": max_nodes,
        "max_edges": max_edges,
        "include_unresolved_foreshadowing": _as_bool(request.get("include_unresolved_foreshadowing"), True),
        "include_neighbors": _as_bool(request.get("include_neighbors"), True),
    }, ""


def _list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _importance(value: Any) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return 1
    return max(1, min(10, parsed))


def _tokenize(text: str) -> list[str]:
    normalized = text.lower()
    raw = re.findall(r"[\w\u4e00-\u9fff]+", normalized)
    seen: set[str] = set()
    result: list[str] = []
    for item in raw:
        if len(item) <= 1 and not re.search(r"[\u4e00-\u9fff]", item):
            continue
        if item not in seen:
            seen.add(item)
            result.append(item)
    return result


def _string_values(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        result: list[str] = []
        for item in value:
            result.extend(_string_values(item))
        return result
    if isinstance(value, dict):
        result: list[str] = []
        for item in value.values():
            result.extend(_string_values(item))
        return result
    return []


def _tag_text(tag_name: str, tag_entry: Any) -> str:
    entry = _dict(tag_entry)
    aliases = " ".join(str(item) for item in _list(entry.get("aliases")))
    return " ".join([tag_name, aliases, _clean_text(entry.get("description"))]).lower()


def _match_score(
    tokens: list[str],
    values: list[str],
    weight: int,
    reason: str,
    reasons: set[str],
) -> int:
    if not tokens:
        return 0
    haystack = " ".join(_clean_text(value).lower() for value in values if _clean_text(value))
    if not haystack:
        return 0
    matched = [token for token in tokens if token in haystack]
    if not matched:
        return 0
    reasons.add(reason)
    return weight * len(matched)


def _score_node(
    node: dict[str, Any],
    tokens: list[str],
    tag_registry: dict[str, Any],
    include_unresolved_foreshadowing: bool,
) -> tuple[int, list[str]]:
    reasons: set[str] = set()
    importance = _importance(node.get("importance"))
    node_type = _clean_text(node.get("type"))
    status = _clean_text(node.get("status")).lower()

    score = importance * 4
    if importance >= 8:
        score += 25
        reasons.add("high_importance")

    if (
        include_unresolved_foreshadowing
        and node_type == "foreshadowing"
        and status in UNRESOLVED_FORESHADOWING_STATUSES
    ):
        score += 35
        reasons.add("unresolved_foreshadowing")

    tags = [str(item) for item in _list(node.get("tags"))]
    tag_values = [_tag_text(tag, tag_registry.get(tag)) for tag in tags]

    score += _match_score(tokens, [_clean_text(node.get("label"))], 45, "label", reasons)
    score += _match_score(tokens, [str(item) for item in _list(node.get("aliases"))], 40, "alias", reasons)
    score += _match_score(tokens, tags + tag_values, 32, "tag", reasons)
    score += _match_score(tokens, [_clean_text(node.get("summary")), _clean_text(node.get("notes"))], 22, "summary_or_note", reasons)
    score += _match_score(tokens, _string_values(node.get("properties")), 12, "property", reasons)
    return score, sorted(reasons)


def _score_edge(edge: dict[str, Any], tokens: list[str]) -> tuple[int, list[str]]:
    reasons: set[str] = set()
    importance = _importance(edge.get("importance"))
    score = importance * 3
    if importance >= 8:
        score += 20
        reasons.add("high_importance")
    score += _match_score(tokens, [_clean_text(edge.get("label")), _clean_text(edge.get("type"))], 35, "label_or_type", reasons)
    score += _match_score(tokens, [_clean_text(edge.get("summary")), _clean_text(edge.get("notes"))], 18, "summary_or_note", reasons)
    score += _match_score(tokens, _string_values(edge.get("properties")), 10, "property", reasons)
    return score, sorted(reasons)


def _node_payload(node: dict[str, Any], score: int, reasons: list[str]) -> dict[str, Any]:
    return {
        "id": _clean_text(node.get("id")),
        "type": _clean_text(node.get("type")),
        "label": _clean_text(node.get("label")),
        "aliases": [str(item) for item in _list(node.get("aliases"))],
        "summary": _clean_text(node.get("summary")),
        "importance": _importance(node.get("importance")),
        "layer": _clean_text(node.get("layer")) or "detail",
        "parent_id": node.get("parent_id") if node.get("parent_id") else None,
        "status": _clean_text(node.get("status")) or "active",
        "tags": [str(item) for item in _list(node.get("tags"))],
        "properties": _dict(node.get("properties")),
        "notes": _clean_text(node.get("notes")),
        "score": int(score),
        "reasons": list(reasons),
    }


def _edge_payload(
    edge: dict[str, Any],
    score: int,
    reasons: list[str],
    node_labels: dict[str, str],
) -> dict[str, Any]:
    source = _clean_text(edge.get("source"))
    target = _clean_text(edge.get("target"))
    return {
        "id": _clean_text(edge.get("id")),
        "source": source,
        "target": target,
        "source_label": node_labels.get(source, source),
        "target_label": node_labels.get(target, target),
        "type": _clean_text(edge.get("type")),
        "label": _clean_text(edge.get("label")),
        "summary": _clean_text(edge.get("summary")),
        "importance": _importance(edge.get("importance")),
        "layer": _clean_text(edge.get("layer")) or "detail",
        "status": _clean_text(edge.get("status")) or "active",
        "properties": _dict(edge.get("properties")),
        "notes": _clean_text(edge.get("notes")),
        "score": int(score),
        "reasons": list(reasons),
    }


def _empty_sections() -> dict[str, list[dict[str, Any]]]:
    return {
        "core_facts": [],
        "characters": [],
        "scenes": [],
        "items": [],
        "foreshadowing": [],
        "plot_directions": [],
        "world_facts": [],
        "events": [],
        "organizations": [],
        "relationships": [],
    }


def _build_sections(nodes: list[dict[str, Any]], edges: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    sections = _empty_sections()
    for node in nodes:
        if node.get("layer") == "core":
            sections["core_facts"].append(node)
        section = SECTION_BY_TYPE.get(_clean_text(node.get("type")))
        if section:
            sections[section].append(node)
    sections["relationships"] = list(edges)
    return sections


def _sort_scored(items: list[tuple[dict[str, Any], int, list[str]]]) -> list[tuple[dict[str, Any], int, list[str]]]:
    return sorted(
        items,
        key=lambda item: (
            int(item[1]),
            _importance(item[0].get("importance")),
            _clean_text(item[0].get("label")),
        ),
        reverse=True,
    )


def build_context_pack(project_ref: str, request: dict[str, Any]) -> ContextPackResult:
    options, error = _validate_request(request)
    if options is None:
        return ContextPackResult(False, project_ref=project_ref, message=error)

    graph_result = load_narrative_graph(project_ref)
    if not graph_result.ok:
        return ContextPackResult(False, project_ref=project_ref, message=graph_result.message)

    graph = _dict(graph_result.graph.get("graph"))
    nodes = [node for node in _list(graph.get("nodes")) if isinstance(node, dict)]
    edges = [edge for edge in _list(graph.get("edges")) if isinstance(edge, dict)]
    tag_registry = _dict(graph_result.graph.get("tag_registry"))
    node_by_id = {_clean_text(node.get("id")): node for node in nodes if _clean_text(node.get("id"))}
    node_labels = {node_id: _clean_text(node.get("label")) or node_id for node_id, node in node_by_id.items()}
    tokens = _tokenize(options["chapter_goal"])
    warnings: list[str] = []

    if not nodes and not edges:
        warnings.append("Narrative graph is empty. Add characters, scenes, items, foreshadowing, or world facts in the Library page.")
    if not tokens:
        warnings.append("chapter_goal is empty. Context pack selection will only use high-importance and unresolved foreshadowing signals.")

    node_scores: dict[str, tuple[dict[str, Any], int, list[str]]] = {}
    seed_ids: set[str] = set()
    min_importance = int(options["min_importance"])

    for node in nodes:
        node_id = _clean_text(node.get("id"))
        if not node_id or _importance(node.get("importance")) < min_importance:
            continue
        score, reasons = _score_node(
            node,
            tokens,
            tag_registry,
            bool(options["include_unresolved_foreshadowing"]),
        )
        has_goal_match = any(reason in reasons for reason in {"label", "alias", "tag", "summary_or_note", "property"})
        has_priority_signal = any(reason in reasons for reason in {"high_importance", "unresolved_foreshadowing"})
        if has_goal_match or has_priority_signal:
            node_scores[node_id] = (node, score, reasons)
            seed_ids.add(node_id)

    if options["include_neighbors"] and seed_ids:
        for edge in edges:
            source = _clean_text(edge.get("source"))
            target = _clean_text(edge.get("target"))
            if source not in seed_ids and target not in seed_ids:
                continue
            for neighbor_id in (source, target):
                if neighbor_id in node_scores or neighbor_id not in node_by_id:
                    continue
                neighbor = node_by_id[neighbor_id]
                if _importance(neighbor.get("importance")) < min_importance:
                    continue
                edge_score, _ = _score_edge(edge, tokens)
                score = edge_score + _importance(neighbor.get("importance")) * 4 + 18
                node_scores[neighbor_id] = (neighbor, score, ["neighbor"])

    scored_nodes = _sort_scored(list(node_scores.values()))
    truncated_nodes = max(0, len(scored_nodes) - int(options["max_nodes"]))
    selected_node_tuples = scored_nodes[: int(options["max_nodes"])]
    selected_ids = {_clean_text(item[0].get("id")) for item in selected_node_tuples}

    edge_scores: list[tuple[dict[str, Any], int, list[str]]] = []
    for edge in edges:
        source = _clean_text(edge.get("source"))
        target = _clean_text(edge.get("target"))
        if not source or not target or source not in selected_ids or target not in selected_ids:
            continue
        score, reasons = _score_edge(edge, tokens)
        score += 30
        reasons = sorted(set(reasons + ["selected_node_relation"]))
        edge_scores.append((edge, score, reasons))

    edge_scores = _sort_scored(edge_scores)
    truncated_edges = max(0, len(edge_scores) - int(options["max_edges"]))
    selected_edge_tuples = edge_scores[: int(options["max_edges"])]

    selected_nodes = [_node_payload(node, score, reasons) for node, score, reasons in selected_node_tuples]
    selected_edges = [_edge_payload(edge, score, reasons, node_labels) for edge, score, reasons in selected_edge_tuples]

    if nodes and not selected_nodes:
        warnings.append("No graph nodes matched the current chapter goal and options.")
    if truncated_nodes:
        warnings.append(f"Node results were truncated by max_nodes: {truncated_nodes} node(s) omitted.")
    if truncated_edges:
        warnings.append(f"Edge results were truncated by max_edges: {truncated_edges} edge(s) omitted.")

    context_pack = {
        "project_ref": graph_result.project_ref,
        "chapter_number": int(options["chapter_number"]),
        "chapter_goal": options["chapter_goal"],
        "options": {
            "min_importance": int(options["min_importance"]),
            "max_nodes": int(options["max_nodes"]),
            "max_edges": int(options["max_edges"]),
            "include_unresolved_foreshadowing": bool(options["include_unresolved_foreshadowing"]),
            "include_neighbors": bool(options["include_neighbors"]),
        },
        "selected_nodes": selected_nodes,
        "selected_edges": selected_edges,
        "sections": _build_sections(selected_nodes, selected_edges),
        "stats": {
            "nodes_considered": len(nodes),
            "nodes_selected": len(selected_nodes),
            "edges_considered": len(edges),
            "edges_selected": len(selected_edges),
            "truncated_nodes": truncated_nodes,
            "truncated_edges": truncated_edges,
        },
        "warnings": warnings,
    }
    return ContextPackResult(
        True,
        project_ref=graph_result.project_ref,
        context_pack=context_pack,
        prompt_text=render_context_pack_for_prompt(context_pack),
        message="Context pack preview built.",
    )


def _compact_properties(node_type: str, properties: dict[str, Any]) -> list[str]:
    keys_by_type = {
        "item": ["current_location", "availability_status", "defined_functions", "narrative_functions"],
        "scene": ["layout", "atmosphere", "narrative_functions", "scene_rules"],
        "foreshadowing": ["setup", "payoff_plan", "status", "related_chapters"],
        "plot_direction": ["direction", "priority", "related_characters", "related_scenes"],
        "world_fact": ["fact", "scope", "source_of_truth"],
    }
    keys = keys_by_type.get(node_type, [])
    lines: list[str] = []
    for key in keys:
        value = properties.get(key)
        if value in (None, "", [], {}):
            continue
        if isinstance(value, list):
            text = ", ".join(_clean_text(item) for item in value if _clean_text(item))
        else:
            text = _clean_text(value)
        if text:
            lines.append(f"{key}: {text}")
    return lines


def _render_node_line(node: dict[str, Any]) -> list[str]:
    label = _clean_text(node.get("label")) or _clean_text(node.get("id"))
    header = f"- {label} | importance {node.get('importance')} | status {node.get('status')}"
    lines = [header]
    summary = _clean_text(node.get("summary"))
    if summary:
        lines.append(f"  Summary: {summary}")
    tags = [str(item) for item in _list(node.get("tags"))]
    if tags:
        lines.append(f"  Tags: {', '.join(tags)}")
    for item in _compact_properties(_clean_text(node.get("type")), _dict(node.get("properties"))):
        lines.append(f"  {item}")
    notes = _clean_text(node.get("notes"))
    if notes:
        lines.append(f"  Notes: {notes}")
    return lines


def _render_edge_line(edge: dict[str, Any]) -> list[str]:
    source = _clean_text(edge.get("source_label")) or _clean_text(edge.get("source"))
    target = _clean_text(edge.get("target_label")) or _clean_text(edge.get("target"))
    label = _clean_text(edge.get("label")) or _clean_text(edge.get("type")) or "related_to"
    lines = [f"- {source} --{label}--> {target} | importance {edge.get('importance')} | status {edge.get('status')}"]
    summary = _clean_text(edge.get("summary"))
    if summary:
        lines.append(f"  Summary: {summary}")
    notes = _clean_text(edge.get("notes"))
    if notes:
        lines.append(f"  Notes: {notes}")
    return lines


def _is_confirmed_item(item: dict[str, Any]) -> bool:
    return _clean_text(item.get("status")).lower() == "confirmed"


def _is_hard_constraint_item(item: dict[str, Any]) -> bool:
    return _is_confirmed_item(item) and _importance(item.get("importance")) >= HARD_CONSTRAINT_MIN_IMPORTANCE


def _render_hard_constraints(
    lines: list[str],
    nodes: list[dict[str, Any]],
    edges: list[dict[str, Any]],
) -> None:
    lines.extend(
        [
            "",
            "### Hard Continuity Constraints",
            "Treat these records as canon. Do not rewrite their dates, life/death state, identity state, organization affiliation, or causal relationships.",
            "If the chapter needs to work around one of these constraints, preserve the constraint or leave uncertain details unstated.",
        ]
    )
    if not nodes and not edges:
        lines.append("- No selected confirmed high-importance records met the hard-constraint threshold.")
        return

    for node in nodes[:MAX_PROMPT_ITEMS_PER_SECTION]:
        lines.extend(_render_node_line(node))
    if edges:
        lines.extend(["", "#### Relationships"])
    for edge in edges[:MAX_PROMPT_ITEMS_PER_SECTION]:
        lines.extend(_render_edge_line(edge))


def _render_context_layer(
    lines: list[str],
    title: str,
    intro: str,
    nodes: list[dict[str, Any]],
    edges: list[dict[str, Any]],
) -> None:
    if not nodes and not edges:
        return

    sections = _build_sections(nodes, edges)
    lines.extend(["", f"### {title}", intro])
    for section_title, key in PROMPT_SECTION_TITLES:
        items = [item for item in _list(sections.get(key)) if isinstance(item, dict)]
        if not items:
            continue
        lines.extend(["", f"#### {section_title}"])
        for item in items[:MAX_PROMPT_ITEMS_PER_SECTION]:
            lines.extend(_render_node_line(item))

    relationships = [item for item in _list(sections.get("relationships")) if isinstance(item, dict)]
    if relationships:
        lines.extend(["", "#### Relationships"])
        for item in relationships[:MAX_PROMPT_ITEMS_PER_SECTION]:
            lines.extend(_render_edge_line(item))


def render_context_pack_for_prompt(context_pack: dict[str, Any]) -> str:
    nodes = _list(context_pack.get("selected_nodes"))
    edges = _list(context_pack.get("selected_edges"))
    if not nodes and not edges:
        return ""

    selected_nodes = [node for node in nodes if isinstance(node, dict)]
    selected_edges = [edge for edge in edges if isinstance(edge, dict)]
    hard_nodes = [node for node in selected_nodes if _is_hard_constraint_item(node)]
    hard_edges = [edge for edge in selected_edges if _is_hard_constraint_item(edge)]
    confirmed_nodes = [node for node in selected_nodes if _is_confirmed_item(node) and not _is_hard_constraint_item(node)]
    confirmed_edges = [edge for edge in selected_edges if _is_confirmed_item(edge) and not _is_hard_constraint_item(edge)]
    background_nodes = [node for node in selected_nodes if not _is_confirmed_item(node)]
    background_edges = [edge for edge in selected_edges if not _is_confirmed_item(edge)]
    lines = [
        "## Narrative Context Pack",
        "",
        "These structured notes are selected from the user's story graph. Use them to preserve continuity.",
        "Priority order: Hard Continuity Constraints > Confirmed Facts > Background Context.",
    ]
    chapter_goal = _clean_text(context_pack.get("chapter_goal"))
    if chapter_goal:
        lines.extend(["", f"Chapter goal: {chapter_goal}"])

    _render_hard_constraints(lines, hard_nodes, hard_edges)
    _render_context_layer(
        lines,
        "Confirmed Facts",
        "These confirmed records support continuity but are below the hard-constraint threshold.",
        confirmed_nodes,
        confirmed_edges,
    )
    _render_context_layer(
        lines,
        "Background Context",
        "These records provide useful context, direction, or unresolved material. Use them flexibly and do not treat them as immutable facts.",
        background_nodes,
        background_edges,
    )

    return "\n".join(lines).strip()
