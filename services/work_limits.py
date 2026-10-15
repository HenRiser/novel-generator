"""Bound supplied graph work before copying, expanding tags, or scoring."""
from __future__ import annotations

import re
from typing import Any, Iterable

from .common import clean_text

MAX_GRAPH_NODES = 2000
MAX_GRAPH_EDGES = 4000
MAX_GOAL_CHARS = 16384
MAX_GOAL_TERMS = 256
MAX_ENTITY_TERM_UNITS = 1_000_000
MAX_SEARCH_CHARS = 4_000_000
MAX_CHARACTER_TERM_UNITS = 64_000_000


class WorkloadLimitError(ValueError):
    code = "workload_too_large"
    status = 413
    message = "本次图谱或目标超出计算上限，请缩小所选图谱或目标后重试。"

    def __init__(self):
        super().__init__(self.message)


def check_graph_counts(document: Any, *, add_nodes: int = 0, add_edges: int = 0) -> tuple[int, int]:
    graph = document.get("graph", {}) if isinstance(document, dict) else {}
    graph = graph if isinstance(graph, dict) else {}
    counts = tuple(len(graph[field]) if isinstance(graph.get(field), list) else 0 for field in ("nodes", "edges"))
    if counts[0] + add_nodes > MAX_GRAPH_NODES or counts[1] + add_edges > MAX_GRAPH_EDGES:
        raise WorkloadLimitError()
    return counts


def check_goal(value: Any) -> list[str]:
    text = str(value or "")
    if len(text) > MAX_GOAL_CHARS:
        raise WorkloadLimitError()
    # Preserve the existing context scorer's lowercase, Chinese, and dedup rules.
    tokens = []
    seen = set()
    for item in re.findall(r"[\w\u4e00-\u9fff]+", text.lower()):
        if len(item) <= 1 and not re.search(r"[\u4e00-\u9fff]", item):
            continue
        if item not in seen:
            seen.add(item)
            tokens.append(item)
            if len(tokens) > MAX_GOAL_TERMS:
                raise WorkloadLimitError()
    return tokens


def _strings(value: Any) -> Iterable[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, (list, dict)):
        for item in value.values() if isinstance(value, dict) else value:
            yield from _strings(item)


def _joined_size(values: Iterable[Any]) -> int:
    sizes = (len(clean_text(value).lower()) for value in values)
    total = count = 0
    for size in sizes:
        if size:
            total += size
            count += 1
    return total + max(0, count - 1)


def check_context_workload(document: dict[str, Any], goal: Any) -> list[str]:
    node_count, edge_count = check_graph_counts(document)
    tokens = check_goal(goal)
    terms = max(1, len(tokens))
    if terms * (node_count + 2 * edge_count) > MAX_ENTITY_TERM_UNITS:
        raise WorkloadLimitError()
    graph = document.get("graph", {})
    graph = graph if isinstance(graph, dict) else {}
    registry = document.get("tag_registry", {})
    registry = registry if isinstance(registry, dict) else {}
    tag_sizes: dict[str, int] = {}
    nodes = graph.get("nodes", [])
    node_label_sizes = {clean_text(node.get("id")): len(clean_text(node.get("label")) or clean_text(node.get("id")))
                        for node in nodes if isinstance(node, dict) and clean_text(node.get("id"))} if isinstance(nodes, list) else {}
    characters = 0
    endpoint_characters = 0
    for kind, weight in (("nodes", 1), ("edges", 2)):
        records = graph.get(kind, [])
        for record in records if isinstance(records, list) else []:
            if not isinstance(record, dict):
                continue
            size = _joined_size([record.get("summary"), record.get("notes")])
            size += _joined_size(_strings(record.get("properties")))
            if kind == "edges":
                size += _joined_size([record.get("label"), record.get("type")])
                # Output expands endpoint labels per edge, including dangling-ID fallback.
                for field in ("source", "target"):
                    identifier = clean_text(record.get(field))
                    endpoint_characters += node_label_sizes.get(identifier, len(identifier))
            else:
                size += _joined_size([record.get("label")])
                aliases = record.get("aliases", [])
                size += _joined_size(str(item) for item in aliases) if isinstance(aliases, list) else 0
                tags = record.get("tags", [])
                tags = [str(item) for item in tags] if isinstance(tags, list) else []
                tag_chars = _joined_size(tags)
                for tag in tags:
                    if tag not in tag_sizes:
                        entry = registry.get(tag)
                        entry = entry if isinstance(entry, dict) else {}
                        aliases = entry.get("aliases", [])
                        aliases = aliases if isinstance(aliases, list) else []
                        # Count each reference without constructing the expanded string.
                        # The two join separators conservatively include outer whitespace.
                        tag_sizes[tag] = (len(tag.lower()) + len(clean_text(entry.get("description")).lower())
                                          + sum(len(str(item).lower()) for item in aliases)
                                          + max(0, len(aliases) - 1) + 2)
                    tag_chars += tag_sizes[tag]
                size += tag_chars + len(tags)
            characters += weight * size
            if characters + endpoint_characters > MAX_SEARCH_CHARS or terms * characters > MAX_CHARACTER_TERM_UNITS:
                raise WorkloadLimitError()
    return tokens
