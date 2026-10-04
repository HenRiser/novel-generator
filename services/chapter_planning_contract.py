"""Pure, credential-free contracts for optional next-chapter planning."""
from __future__ import annotations

import copy
import re
from typing import Any

from . import chapter_task_service as tasks
from . import scene_plan_service as scenes

CONSTRAINT_FIELDS = {"canon_budget", "required_characters", "forbidden_advances"}
SETTING_FIELDS = {"protagonist", "supporting_characters", "worldview", "core_conflict", "genre", "style"}
INPUT_FIELDS = {"project_ref", "chapter_number", "prefix", "author_intent", "constraints", "setting", "graph", "excluded_records"}
PREFIX_FIELDS = {"chapter_number", "revision", "status", "summary_status", "summary", "content"}
SCENE_FIELDS = {"scene_no"} | scenes.SCENE_TEXT_FIELDS | scenes.SCENE_LIST_FIELDS


def _issue(issues: list[dict[str, str]], code: str, path: str, message: str) -> None:
    issues.append({"code": code, "path": path, "message": message})


def _closed(value: Any, fields: set[str], path: str, issues: list[dict[str, str]]) -> bool:
    if not isinstance(value, dict):
        _issue(issues, "object_required", path, "Must be a JSON object.")
        return False
    if set(value) != fields:
        _issue(issues, "invalid_fields", path, "Fields must match the planning contract exactly; approval metadata is not allowed.")
        return False
    return True


def _types(value: dict[str, Any], strings: set[str], lists: set[str], path: str, issues: list[dict[str, str]]) -> bool:
    valid = True
    for field in sorted(strings):
        if not isinstance(value.get(field), str):
            _issue(issues, "invalid_type", f"{path}.{field}", "Must be a string.")
            valid = False
    for field in sorted(lists):
        items = value.get(field)
        if not isinstance(items, list) or any(not isinstance(item, str) for item in items):
            _issue(issues, "invalid_type", f"{path}.{field}", "Must be a list of strings.")
            valid = False
    return valid


def _constraints(value: Any, issues: list[dict[str, str]]) -> dict[str, Any] | None:
    if not _closed(value, CONSTRAINT_FIELDS, "constraints", issues):
        return None
    if not _types(value, {"canon_budget"}, {"required_characters", "forbidden_advances"}, "constraints", issues):
        return None
    budget = value["canon_budget"].strip()
    if budget not in tasks.CANON_BUDGETS:
        _issue(issues, "invalid_canon_budget", "constraints.canon_budget", "canon_budget is invalid.")
        return None
    return {"canon_budget": budget, **{field: tasks._string_list(value[field], field)[0]
            for field in ("required_characters", "forbidden_advances")}}


def _keys(items: list[str]) -> set[str]:
    return {item.strip().casefold() for item in items if item.strip()}


def validate_candidate(candidate: Any, constraints: Any) -> dict[str, Any]:
    """Validate editable proposals only; never create IDs or approval state."""
    issues: list[dict[str, str]] = []
    fixed = _constraints(constraints, issues)
    task = proposal = None
    if not _closed(candidate, {"task_payload", "scene_proposal"}, "candidate", issues):
        return {"task_payload": None, "scene_proposal": None, "issues": issues}
    raw_task = candidate["task_payload"]
    if _closed(raw_task, tasks.EDITABLE_FIELDS, "task_payload", issues) and _types(
        raw_task, tasks.EDITABLE_FIELDS - tasks.LIST_FIELDS, tasks.LIST_FIELDS, "task_payload", issues
    ):
        task, message = tasks._validate_payload(raw_task)
        if message:
            _issue(issues, "task_invalid", "task_payload", message)
        elif not task["ending_state"]:
            _issue(issues, "empty_ending_state", "task_payload.ending_state", "A chapter task must define a nonempty ending state.")
    raw_proposal = candidate["scene_proposal"]
    if _closed(raw_proposal, {"scenes"}, "scene_proposal", issues):
        raw_scenes = raw_proposal["scenes"]
        valid_scenes = isinstance(raw_scenes, list)
        if not valid_scenes:
            _issue(issues, "invalid_type", "scene_proposal.scenes", "Must be a list of scenes.")
        else:
            for index, scene in enumerate(raw_scenes):
                path = f"scene_proposal.scenes[{index}]"
                if not _closed(scene, SCENE_FIELDS, path, issues):
                    valid_scenes = False
                    continue
                if not _types(scene, scenes.SCENE_TEXT_FIELDS, scenes.SCENE_LIST_FIELDS, path, issues):
                    valid_scenes = False
                if type(scene["scene_no"]) is not int:
                    _issue(issues, "invalid_type", f"{path}.scene_no", "Must be an integer.")
                    valid_scenes = False
        if valid_scenes:
            normalized, message = scenes._validate_scenes(raw_scenes)
            if message:
                _issue(issues, "scene_invalid", "scene_proposal.scenes", message)
            else:
                proposal = {"scenes": normalized}
    if task is not None and fixed is not None:
        if task["canon_budget"] != fixed["canon_budget"]:
            _issue(issues, "canon_budget_changed", "task_payload.canon_budget", "Must equal the author's explicit canon budget.")
        for field in ("required_characters", "forbidden_advances"):
            missing = _keys(fixed[field]) - _keys(task[field])
            if missing:
                _issue(issues, f"{field}_missing", f"task_payload.{field}", f"Explicit constraints were omitted: {', '.join(sorted(missing))}.")
    if task is not None and proposal is not None:
        message = scenes.validate_scene_constraints(proposal, task)
        if message:
            _issue(issues, "scene_task_conflict", "scene_proposal", message)
        participants = _keys([person for scene in proposal["scenes"] for person in scene["participants"]])
        missing = _keys(task["required_characters"]) - participants
        if fixed is not None:
            missing |= _keys(fixed["required_characters"]) - participants
        if missing:
            _issue(issues, "required_characters_absent", "scene_proposal.scenes", f"Required characters must appear in a scene: {', '.join(sorted(missing))}.")
    return {"task_payload": task, "scene_proposal": proposal, "issues": issues}


def _provenance(source: Any, prefix_number: int) -> dict[str, Any] | None:
    if not isinstance(source, dict) or source.get("candidate_source") == "next_chapter_proposal":
        return None
    chapter = source.get("chapter_number")
    introduced = source.get("introduced_in")
    updated = source.get("last_updated_in")
    if chapter is not None and (type(chapter) is not int or chapter < 1):
        return None
    references: list[int] = []
    for value in (introduced, updated):
        if value is None:
            continue
        match = re.fullmatch(r"chapter_([0-9]+)", value) if isinstance(value, str) else None
        if match is None or int(match[1]) < 1:
            return None
        references.append(int(match[1]))
    introduced_number = int(introduced.removeprefix("chapter_")) if introduced is not None else None
    if chapter is not None and introduced_number is not None and chapter != introduced_number:
        return None
    if source.get("created_by") == "user" and chapter is None and not references:
        return {"created_by": "user", "introduced_in": None, "last_updated_in": None}
    number = chapter or introduced_number
    if number is None or number > prefix_number or any(value > prefix_number for value in references):
        return None
    imported = source.get("reviewed") is True and isinstance(source.get("kind"), str) and source["kind"] in {"source_fact", "user_setting"}
    reviewed = source.get("created_by") == "knowledge_draft_review"
    if not imported and not reviewed:
        return None
    safe: dict[str, Any] = {"chapter_number": number}
    if imported:
        safe.update(kind=source["kind"], reviewed=True)
    if reviewed:
        safe["created_by"] = "knowledge_draft_review"
    if introduced is not None:
        safe["introduced_in"] = introduced
    if updated is not None:
        safe["last_updated_in"] = updated
    return safe


def _project_record(record: dict[str, Any], source: dict[str, Any], edge: bool) -> dict[str, Any]:
    safe = {field: record[field] for field in ("id", "type", "label", "summary", "layer", "status", "notes")
            if isinstance(record.get(field), str)}
    safe["importance"] = record["importance"] if type(record.get("importance")) is int and 1 <= record["importance"] <= 10 else 5
    # Planning uses reviewed labels/summaries/notes; arbitrary properties may contain archives or credentials.
    safe["properties"] = {}
    if edge:
        safe.update(source=record["source"], target=record["target"], source_info=source)
    else:
        for field in ("aliases", "tags"):
            safe[field] = [item for item in record.get(field, []) if isinstance(item, str)] if isinstance(record.get(field), list) else []
        safe["source"] = source
    return safe


def filter_planning_graph(document: Any, prefix_number: int) -> tuple[dict[str, Any], int]:
    """Project proven global settings and reviewed prefix facts, never archives."""
    if type(prefix_number) is not int or prefix_number < 0:
        raise ValueError("prefix_number must be a nonnegative integer.")
    if not isinstance(document, dict) or not isinstance(document.get("graph"), dict):
        raise ValueError("graph must be a document with nodes and edges.")
    graph = document["graph"]
    if any(not isinstance(graph.get(field), list) for field in ("nodes", "edges")):
        raise ValueError("graph nodes and edges must be lists.")
    selected: dict[str, list[dict[str, Any]]] = {"nodes": [], "edges": []}
    excluded = 0
    node_ids: set[str] = set()
    edge_ids: set[str] = set()
    for kind in ("nodes", "edges"):
        edge = kind == "edges"
        for record in graph[kind]:
            source = _provenance(record.get("source_info" if edge else "source"), prefix_number) if isinstance(record, dict) else None
            identifier = record.get("id") if isinstance(record, dict) else None
            valid = source is not None and isinstance(identifier, str) and bool(identifier.strip())
            if valid:
                valid = record.get("status", "").strip().casefold() != "planned" if isinstance(record.get("status", ""), str) else False
                valid = valid and identifier not in (edge_ids if edge else node_ids)
            if valid and edge:
                valid = isinstance(record.get("source"), str) and isinstance(record.get("target"), str)
                valid = valid and record["source"] in node_ids and record["target"] in node_ids
            if not valid:
                excluded += 1
                continue
            selected[kind].append(_project_record(record, source, edge))
            (edge_ids if edge else node_ids).add(identifier)
    return {"version": 1, "graph": selected}, excluded


def validate_input(data: Any) -> tuple[dict[str, Any] | None, list[dict[str, str]]]:
    """Validate a frozen next-chapter prefix and strip unsafe graph envelopes."""
    issues: list[dict[str, str]] = []
    if not _closed(data, INPUT_FIELDS, "input", issues):
        return None, issues
    fixed = _constraints(data["constraints"], issues)
    if _types(data, {"project_ref", "author_intent"}, set(), "input", issues):
        for field in ("project_ref", "author_intent"):
            if not data[field].strip():
                _issue(issues, "empty_text", f"input.{field}", "Must not be empty.")
    setting = data["setting"]
    if _closed(setting, SETTING_FIELDS, "setting", issues):
        _types(setting, SETTING_FIELDS, set(), "setting", issues)
    prefix = data["prefix"]
    if not isinstance(prefix, list):
        _issue(issues, "invalid_type", "input.prefix", "Must be a list of confirmed chapters.")
    else:
        for index, chapter in enumerate(prefix):
            path = f"input.prefix[{index}]"
            if not _closed(chapter, PREFIX_FIELDS, path, issues):
                continue
            if type(chapter["chapter_number"]) is not int or chapter["chapter_number"] != index + 1:
                _issue(issues, "prefix_gap", f"{path}.chapter_number", "Prefix chapters must start at 1 and be continuous.")
            if not _types(chapter, PREFIX_FIELDS - {"chapter_number"}, set(), path, issues):
                continue
            if chapter["status"] != "confirmed" or chapter["summary_status"] != "ready":
                _issue(issues, "prefix_not_ready", path, "Every prefix chapter must be confirmed with a ready summary.")
            if not chapter["revision"].strip() or not chapter["summary"].strip():
                _issue(issues, "prefix_missing_context", path, "Revision and summary must not be empty.")
            if index < len(prefix) - 1 and chapter["content"] != "":
                _issue(issues, "prefix_extra_content", f"{path}.content", "Only the last confirmed chapter may include content.")
            if index == len(prefix) - 1 and not chapter["content"].strip():
                _issue(issues, "prefix_missing_content", f"{path}.content", "The last confirmed chapter must include content.")
    target = data["chapter_number"]
    if type(target) is not int or not isinstance(prefix, list) or target != len(prefix) + 1:
        _issue(issues, "invalid_target", "input.chapter_number", "Only the next chapter after the complete prefix can be planned.")
    excluded = data["excluded_records"]
    if type(excluded) is not int or excluded < 0:
        _issue(issues, "invalid_type", "input.excluded_records", "Must be a nonnegative integer.")
    safe_graph = None
    if isinstance(prefix, list):
        try:
            safe_graph, additional_excluded = filter_planning_graph(data["graph"], len(prefix))
        except ValueError as exc:
            _issue(issues, "invalid_graph", "input.graph", str(exc))
    if issues:
        return None, issues
    return {"project_ref": data["project_ref"].strip(), "chapter_number": target, "prefix": copy.deepcopy(prefix),
            "author_intent": data["author_intent"].strip(), "constraints": fixed,
            "setting": {field: setting[field].strip() for field in sorted(SETTING_FIELDS)},
            "graph": safe_graph, "excluded_records": excluded + additional_excluded}, []
