from __future__ import annotations

import json
import re
import secrets
from datetime import datetime
from pathlib import Path
from typing import Any

from file_manager import resolve_project_context
from project_context import WORKSPACE_STORAGE_KIND

from .schemas import NarrativeGraphResult


GRAPH_VERSION = 1
MEMORY_DIR_NAME = "memory"
NARRATIVE_GRAPH_NAME = "narrative_graph.json"
GRAPH_VIEWS_NAME = "graph_views.json"
NODE_TYPES = {
    "character",
    "scene",
    "item",
    "foreshadowing",
    "relationship_note",
    "plot_direction",
    "world_fact",
    "event",
    "organization",
}
TAG_CATEGORIES = {"plot_scope", "organization", "narrative_function", "theme", "custom"}
LAYERS = {"core", "major", "detail", "background"}
DEFAULT_NODE_IMPORTANCE = {
    "character": 5,
    "scene": 5,
    "item": 5,
    "foreshadowing": 7,
    "relationship_note": 5,
    "plot_direction": 7,
    "world_fact": 6,
    "event": 5,
    "organization": 5,
}


def _timestamp() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _memory_dir(ctx: Any) -> Path:
    return ctx.project_dir / MEMORY_DIR_NAME


def _graph_path(ctx: Any) -> Path:
    return _memory_dir(ctx) / NARRATIVE_GRAPH_NAME


def _views_path(ctx: Any) -> Path:
    return _memory_dir(ctx) / GRAPH_VIEWS_NAME


def _workspace_context(project_ref: str) -> tuple[Any | None, str]:
    ref = str(project_ref or "").strip()
    if not ref:
        return None, "Unknown project_ref."
    try:
        ctx = resolve_project_context(ref)
    except (FileNotFoundError, ValueError) as exc:
        return None, str(exc) or "Unknown project_ref."
    if ctx.storage_kind != WORKSPACE_STORAGE_KIND:
        return None, "Narrative graph is only supported for workspace book projects."
    return ctx, ""


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


def _empty_graph(project_ref: str, created_at: str | None = None) -> dict[str, Any]:
    now = _timestamp()
    return {
        "version": GRAPH_VERSION,
        "metadata": {
            "project_ref": project_ref,
            "created_at": created_at or now,
            "updated_at": now,
        },
        "tag_registry": {},
        "graph": {
            "nodes": [],
            "edges": [],
        },
    }


def _default_views(project_ref: str, created_at: str | None = None) -> dict[str, Any]:
    now = _timestamp()
    return {
        "version": GRAPH_VERSION,
        "metadata": {
            "project_ref": project_ref,
            "created_at": created_at or now,
            "updated_at": now,
        },
        "views": [
            {
                "id": "view_default",
                "name": "默认视图",
                "filter": {
                    "min_importance": 1,
                    "types": [],
                },
                "layout": {},
            }
        ],
    }


def _normalize_graph_document(data: dict[str, Any] | None, project_ref: str) -> dict[str, Any]:
    if data is None:
        return _empty_graph(project_ref)

    document = dict(data)
    document["version"] = GRAPH_VERSION

    metadata = document.get("metadata")
    metadata = dict(metadata) if isinstance(metadata, dict) else {}
    metadata["project_ref"] = project_ref
    metadata.setdefault("created_at", _timestamp())
    metadata.setdefault("updated_at", metadata["created_at"])
    document["metadata"] = metadata

    tag_registry = document.get("tag_registry")
    document["tag_registry"] = dict(tag_registry) if isinstance(tag_registry, dict) else {}

    graph = document.get("graph")
    graph = dict(graph) if isinstance(graph, dict) else {}
    nodes = graph.get("nodes")
    edges = graph.get("edges")
    graph["nodes"] = list(nodes) if isinstance(nodes, list) else []
    graph["edges"] = list(edges) if isinstance(edges, list) else []
    document["graph"] = graph
    return document


def _normalize_views_document(data: dict[str, Any] | None, project_ref: str) -> dict[str, Any]:
    if data is None:
        return _default_views(project_ref)

    document = dict(data)
    document["version"] = GRAPH_VERSION
    metadata = document.get("metadata")
    metadata = dict(metadata) if isinstance(metadata, dict) else {}
    metadata["project_ref"] = project_ref
    metadata.setdefault("created_at", _timestamp())
    metadata.setdefault("updated_at", metadata["created_at"])
    document["metadata"] = metadata
    views = document.get("views")
    document["views"] = list(views) if isinstance(views, list) else _default_views(project_ref)["views"]
    return document


def _load_documents(project_ref: str) -> tuple[dict[str, Any], dict[str, Any]]:
    ctx, message = _workspace_context(project_ref)
    if ctx is None:
        raise ValueError(message)
    graph = _normalize_graph_document(_read_json(_graph_path(ctx)), project_ref)
    views = _normalize_views_document(_read_json(_views_path(ctx)), project_ref)
    return graph, views


def _save_documents(ctx: Any, graph: dict[str, Any], views: dict[str, Any] | None = None) -> None:
    now = _timestamp()
    graph_metadata = dict(graph.get("metadata") if isinstance(graph.get("metadata"), dict) else {})
    graph_metadata.setdefault("created_at", now)
    graph_metadata["updated_at"] = now
    graph["metadata"] = graph_metadata
    _write_json_atomic(_graph_path(ctx), graph)

    if views is not None:
        views_metadata = dict(views.get("metadata") if isinstance(views.get("metadata"), dict) else {})
        views_metadata.setdefault("created_at", now)
        views_metadata["updated_at"] = now
        views["metadata"] = views_metadata
        _write_json_atomic(_views_path(ctx), views)


def _clean_text(value: Any) -> str:
    return str(value or "").strip()


def _string_list(value: Any) -> list[str] | None:
    if value is None or value == "":
        return []
    if isinstance(value, str):
        raw_items = value.split(",")
    elif isinstance(value, list):
        raw_items = value
    else:
        return None

    result: list[str] = []
    seen: set[str] = set()
    for item in raw_items:
        text = _clean_text(item)
        if text and text not in seen:
            seen.add(text)
            result.append(text)
    return result


def _importance(value: Any, default: int) -> int | None:
    if value is None or value == "":
        return default
    if isinstance(value, bool):
        return None
    if isinstance(value, float) and not value.is_integer():
        return None
    try:
        importance = int(value)
    except (TypeError, ValueError):
        return None
    return importance if 1 <= importance <= 10 else None


def _layer(value: Any) -> str | None:
    layer = _clean_text(value) or "detail"
    return layer if layer in LAYERS else None


def _properties(value: Any) -> dict[str, Any] | None:
    if value is None or value == "":
        return {}
    return dict(value) if isinstance(value, dict) else None


def _node_ids(graph: dict[str, Any]) -> set[str]:
    nodes = graph.get("graph", {}).get("nodes", [])
    return {
        str(node.get("id"))
        for node in nodes
        if isinstance(node, dict) and str(node.get("id") or "").strip()
    }


def _edge_ids(graph: dict[str, Any]) -> set[str]:
    edges = graph.get("graph", {}).get("edges", [])
    return {
        str(edge.get("id"))
        for edge in edges
        if isinstance(edge, dict) and str(edge.get("id") or "").strip()
    }


def _generate_id(prefix: str, existing_ids: set[str]) -> str:
    safe_prefix = re.sub(r"[^A-Za-z0-9_]+", "_", prefix).strip("_") or "entity"
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    for _ in range(1000):
        candidate = f"{safe_prefix}_{timestamp}_{secrets.token_hex(3)}"
        if candidate not in existing_ids:
            return candidate
    raise RuntimeError("Unable to generate a unique graph id.")


def _active_tag_names(graph: dict[str, Any]) -> set[str]:
    registry = graph.get("tag_registry")
    if not isinstance(registry, dict):
        return set()
    return {
        str(name)
        for name, entry in registry.items()
        if isinstance(entry, dict) and str(entry.get("status") or "active").strip() == "active"
    }


def load_narrative_graph(project_ref: str) -> NarrativeGraphResult:
    try:
        graph, views = _load_documents(project_ref)
    except (OSError, ValueError) as exc:
        return NarrativeGraphResult(False, project_ref=project_ref, message=str(exc))
    return NarrativeGraphResult(True, project_ref=project_ref, graph=graph, views=views)


def load_graph_views(project_ref: str) -> NarrativeGraphResult:
    return load_narrative_graph(project_ref)


def save_narrative_graph(project_ref: str, graph: dict[str, Any]) -> NarrativeGraphResult:
    ctx, message = _workspace_context(project_ref)
    if ctx is None:
        return NarrativeGraphResult(False, project_ref=project_ref, message=message)
    try:
        views = _normalize_views_document(_read_json(_views_path(ctx)), project_ref)
        document = _normalize_graph_document(graph, project_ref)
        _save_documents(ctx, document, views)
    except (OSError, ValueError) as exc:
        return NarrativeGraphResult(False, project_ref=project_ref, message=str(exc))
    return NarrativeGraphResult(True, project_ref=project_ref, graph=document, views=views)


def save_graph_views(project_ref: str, views: dict[str, Any]) -> NarrativeGraphResult:
    ctx, message = _workspace_context(project_ref)
    if ctx is None:
        return NarrativeGraphResult(False, project_ref=project_ref, message=message)
    try:
        graph = _normalize_graph_document(_read_json(_graph_path(ctx)), project_ref)
        document = _normalize_views_document(views, project_ref)
        _save_documents(ctx, graph, document)
    except (OSError, ValueError) as exc:
        return NarrativeGraphResult(False, project_ref=project_ref, message=str(exc))
    return NarrativeGraphResult(True, project_ref=project_ref, graph=graph, views=document)


def add_graph_tag(project_ref: str, tag_payload: dict[str, Any]) -> NarrativeGraphResult:
    ctx, message = _workspace_context(project_ref)
    if ctx is None:
        return NarrativeGraphResult(False, project_ref=project_ref, message=message)
    try:
        graph = _normalize_graph_document(_read_json(_graph_path(ctx)), project_ref)
        views = _normalize_views_document(_read_json(_views_path(ctx)), project_ref)
    except (OSError, ValueError) as exc:
        return NarrativeGraphResult(False, project_ref=project_ref, message=str(exc))

    name = _clean_text(tag_payload.get("name"))
    if not name:
        return NarrativeGraphResult(False, project_ref=project_ref, message="Tag name cannot be empty.")
    registry = graph["tag_registry"]
    if name in registry:
        return NarrativeGraphResult(False, project_ref=project_ref, message="Tag already exists in tag_registry.")

    category = _clean_text(tag_payload.get("category")) or "custom"
    if category not in TAG_CATEGORIES:
        return NarrativeGraphResult(False, project_ref=project_ref, message="Tag category is invalid.")

    aliases = _string_list(tag_payload.get("aliases"))
    if aliases is None:
        return NarrativeGraphResult(False, project_ref=project_ref, message="Tag aliases must be a string array.")

    tag = {
        "category": category,
        "description": _clean_text(tag_payload.get("description")),
        "aliases": aliases,
        "status": "active",
    }
    registry[name] = tag

    try:
        _save_documents(ctx, graph, views)
    except OSError as exc:
        return NarrativeGraphResult(False, project_ref=project_ref, message=str(exc))

    return NarrativeGraphResult(True, project_ref=project_ref, graph=graph, views=views, tag={name: tag}, message="Tag saved.")


def add_graph_node(project_ref: str, node_payload: dict[str, Any]) -> NarrativeGraphResult:
    ctx, message = _workspace_context(project_ref)
    if ctx is None:
        return NarrativeGraphResult(False, project_ref=project_ref, message=message)
    try:
        graph = _normalize_graph_document(_read_json(_graph_path(ctx)), project_ref)
        views = _normalize_views_document(_read_json(_views_path(ctx)), project_ref)
    except (OSError, ValueError) as exc:
        return NarrativeGraphResult(False, project_ref=project_ref, message=str(exc))

    node_type = _clean_text(node_payload.get("type")) or "character"
    if node_type not in NODE_TYPES:
        return NarrativeGraphResult(False, project_ref=project_ref, message="Node type is invalid.")

    label = _clean_text(node_payload.get("label"))
    if not label:
        return NarrativeGraphResult(False, project_ref=project_ref, message="Node label cannot be empty.")

    aliases = _string_list(node_payload.get("aliases"))
    if aliases is None:
        return NarrativeGraphResult(False, project_ref=project_ref, message="Node aliases must be a string array.")

    tags = _string_list(node_payload.get("tags"))
    if tags is None:
        return NarrativeGraphResult(False, project_ref=project_ref, message="Node tags must be a string array.")
    unknown_tags = [tag for tag in tags if tag not in _active_tag_names(graph)]
    if unknown_tags:
        return NarrativeGraphResult(False, project_ref=project_ref, message="Tag does not exist in tag_registry.")

    importance = _importance(node_payload.get("importance"), DEFAULT_NODE_IMPORTANCE[node_type])
    if importance is None:
        return NarrativeGraphResult(False, project_ref=project_ref, message="importance must be between 1 and 10.")

    layer = _layer(node_payload.get("layer"))
    if layer is None:
        return NarrativeGraphResult(False, project_ref=project_ref, message="layer must be core, major, detail, or background.")

    properties = _properties(node_payload.get("properties"))
    if properties is None:
        return NarrativeGraphResult(False, project_ref=project_ref, message="properties must be a JSON object.")

    parent_id = _clean_text(node_payload.get("parent_id")) or None
    if parent_id is not None and parent_id not in _node_ids(graph):
        return NarrativeGraphResult(False, project_ref=project_ref, message="parent_id node does not exist.")

    existing_ids = _node_ids(graph)
    node = {
        "id": _generate_id(f"node_{node_type}", existing_ids),
        "type": node_type,
        "label": label,
        "aliases": aliases,
        "summary": _clean_text(node_payload.get("summary")),
        "importance": importance,
        "layer": layer,
        "parent_id": parent_id,
        "status": _clean_text(node_payload.get("status")) or "active",
        "tags": tags,
        "properties": properties,
        "notes": _clean_text(node_payload.get("notes")),
        "source": {
            "created_by": "user",
            "introduced_in": None,
            "last_updated_in": None,
        },
    }
    graph["graph"]["nodes"].append(node)

    try:
        _save_documents(ctx, graph, views)
    except OSError as exc:
        return NarrativeGraphResult(False, project_ref=project_ref, message=str(exc))

    return NarrativeGraphResult(True, project_ref=project_ref, graph=graph, views=views, node=node, message="Node saved.")


def add_graph_edge(project_ref: str, edge_payload: dict[str, Any]) -> NarrativeGraphResult:
    ctx, message = _workspace_context(project_ref)
    if ctx is None:
        return NarrativeGraphResult(False, project_ref=project_ref, message=message)
    try:
        graph = _normalize_graph_document(_read_json(_graph_path(ctx)), project_ref)
        views = _normalize_views_document(_read_json(_views_path(ctx)), project_ref)
    except (OSError, ValueError) as exc:
        return NarrativeGraphResult(False, project_ref=project_ref, message=str(exc))

    node_ids = _node_ids(graph)
    source = _clean_text(edge_payload.get("source"))
    target = _clean_text(edge_payload.get("target"))
    if source not in node_ids:
        return NarrativeGraphResult(False, project_ref=project_ref, message="Source node does not exist.")
    if target not in node_ids:
        return NarrativeGraphResult(False, project_ref=project_ref, message="Target node does not exist.")
    if source == target:
        return NarrativeGraphResult(False, project_ref=project_ref, message="Edge source and target cannot be the same node.")

    edge_type = _clean_text(edge_payload.get("type"))
    if not edge_type or len(edge_type) > 80:
        return NarrativeGraphResult(False, project_ref=project_ref, message="Edge type must be 1 to 80 characters.")

    label = _clean_text(edge_payload.get("label"))
    if not label:
        return NarrativeGraphResult(False, project_ref=project_ref, message="Edge label cannot be empty.")

    importance = _importance(edge_payload.get("importance"), 5)
    if importance is None:
        return NarrativeGraphResult(False, project_ref=project_ref, message="importance must be between 1 and 10.")

    layer = _layer(edge_payload.get("layer"))
    if layer is None:
        return NarrativeGraphResult(False, project_ref=project_ref, message="layer must be core, major, detail, or background.")

    properties = _properties(edge_payload.get("properties"))
    if properties is None:
        return NarrativeGraphResult(False, project_ref=project_ref, message="properties must be a JSON object.")

    edge = {
        "id": _generate_id(f"edge_{edge_type}", _edge_ids(graph)),
        "source": source,
        "target": target,
        "type": edge_type,
        "label": label,
        "summary": _clean_text(edge_payload.get("summary")),
        "importance": importance,
        "layer": layer,
        "status": _clean_text(edge_payload.get("status")) or "active",
        "properties": properties,
        "notes": _clean_text(edge_payload.get("notes")),
        "source_info": {
            "created_by": "user",
            "introduced_in": None,
            "last_updated_in": None,
        },
    }
    graph["graph"]["edges"].append(edge)

    try:
        _save_documents(ctx, graph, views)
    except OSError as exc:
        return NarrativeGraphResult(False, project_ref=project_ref, message=str(exc))

    return NarrativeGraphResult(True, project_ref=project_ref, graph=graph, views=views, edge=edge, message="Edge saved.")


def get_entity_context(project_ref: str, entity_type: str, entity_id: str) -> NarrativeGraphResult:
    result = load_narrative_graph(project_ref)
    if not result.ok:
        return result

    graph_data = result.graph.get("graph", {})
    nodes = [node for node in graph_data.get("nodes", []) if isinstance(node, dict)]
    edges = [edge for edge in graph_data.get("edges", []) if isinstance(edge, dict)]
    if entity_type == "node":
        node = next((item for item in nodes if item.get("id") == entity_id), None)
        if node is None:
            return NarrativeGraphResult(False, project_ref=project_ref, message="Node not found.")
        return NarrativeGraphResult(True, project_ref=project_ref, graph=result.graph, views=result.views, node=node)
    if entity_type == "edge":
        edge = next((item for item in edges if item.get("id") == entity_id), None)
        if edge is None:
            return NarrativeGraphResult(False, project_ref=project_ref, message="Edge not found.")
        return NarrativeGraphResult(True, project_ref=project_ref, graph=result.graph, views=result.views, edge=edge)
    return NarrativeGraphResult(False, project_ref=project_ref, message="entity_type must be node or edge.")
