"""Pure v1 planning event contract; not connected to any compute endpoint."""
from __future__ import annotations

import copy
import math
import re
from typing import Any

from structured_schemas import PLANNING_SCENE, PLANNING_TASK

JS_SAFE = 2**53 - 1
IDENTITY_FIELDS = {"run_id", "step_id", "attempt_id", "input_revision", "protocol_version",
                   "request_fingerprint", "destination_fingerprint", "execution_fingerprint"}
ENVELOPE_FIELDS = IDENTITY_FIELDS | {"event_version", "seq", "chapter_number", "type"}
RESULT_FIELDS = {"graph_version", "chapter_number", "status", "task_payload", "scene_proposal",
                 "issues", "repair_count", "nodes", "excluded_records", "warnings"}
PATH = (("context_pack", 1), ("initial_proposal", 1), ("validate", 1), ("repair_once", 1), ("validate", 2))
TOKEN_FIELDS = {"prompt_tokens", "completion_tokens", "prompt_cache_hit_tokens", "prompt_cache_miss_tokens", "reasoning_tokens"}
TIME_FIELDS = {"first_content_ms", "body_complete_ms"}
METRIC_FIELDS = TOKEN_FIELDS | TIME_FIELDS | {"operation", "protocol_version", "elapsed_ms", "call_count", "repair_used"}
_ID = re.compile(r"[A-Za-z0-9._:-]{1,128}\Z", re.ASCII)
_HASH = re.compile(r"[0-9a-f]{64}\Z", re.ASCII)
_CODE = re.compile(r"[A-Za-z0-9._:-]{1,80}\Z", re.ASCII)


def _require(valid: bool) -> None:
    if not valid:
        raise ValueError("Invalid planning event contract.")


def _integer(value: Any, lower: int = 0, upper: int = JS_SAFE) -> bool:
    return type(value) in (int, float) and lower <= value <= upper and math.isfinite(value) and value == int(value)


def _number(value: Any) -> bool:
    return type(value) in (int, float) and 0 <= value <= JS_SAFE and math.isfinite(value)


def _strings(value: Any) -> bool:
    return isinstance(value, list) and all(isinstance(item, str) for item in value)


def _closed(value: Any, fields: set[str]) -> bool:
    return isinstance(value, dict) and set(value) == fields


def _identity(value: Any) -> None:
    _require(_closed(value, IDENTITY_FIELDS))
    for field in ("run_id", "step_id", "attempt_id"):
        _require(isinstance(value[field], str) and _ID.fullmatch(value[field]) is not None)
    _require(_integer(value["input_revision"]))
    _require(_integer(value["protocol_version"], 2, 2))
    for field in ("request_fingerprint", "destination_fingerprint", "execution_fingerprint"):
        _require(isinstance(value[field], str) and _HASH.fullmatch(value[field]) is not None)


def _text_shape(value: Any, schema: dict[str, Any]) -> bool:
    if not _closed(value, set(schema["properties"])):
        return False
    return all(_strings(value[key]) if shape["type"] == "array" else
               _integer(value[key], 1) if shape["type"] == "integer" else isinstance(value[key], str)
               for key, shape in schema["properties"].items())


def _result(value: Any, chapter_number: int, completed: list[tuple[str, int]]) -> None:
    _require(_closed(value, RESULT_FIELDS))
    _require(value["graph_version"] == "chapter-planning-v1")
    _require(_integer(value["chapter_number"], 1) and value["chapter_number"] == chapter_number)
    _require(isinstance(value["status"], str) and value["status"] in {"draft_ready", "needs_user_decision"})
    _require(_integer(value["repair_count"], 0, 1) and value["repair_count"] == (len(completed) == 5))
    _require(_integer(value["excluded_records"]) and _strings(value["nodes"]) and _strings(value["warnings"]))
    _require(value["nodes"] == [node for node, _ in completed])
    issues = value["issues"]
    _require(isinstance(issues, list) and all(_closed(item, {"code", "path", "message"}) and
             all(isinstance(item[key], str) for key in ("code", "path", "message")) for item in issues))
    task, proposal = value["task_payload"], value["scene_proposal"]
    _require(task is None or _text_shape(task, PLANNING_TASK))
    if proposal is not None:
        _require(_closed(proposal, {"scenes"}))
        scenes = proposal["scenes"]
        _require(isinstance(scenes, list) and 2 <= len(scenes) <= 4)
        _require(all(_text_shape(scene, PLANNING_SCENE) and scene["scene_no"] == index + 1
                     for index, scene in enumerate(scenes)))
    if value["status"] == "draft_ready":
        _require(not issues and task is not None and proposal is not None)
    else:
        _require(bool(issues) and value["repair_count"] == 1)


def _metrics(value: Any, repaired: bool, elapsed_ms: int | float) -> None:
    _require(isinstance(value, dict) and not set(value) - METRIC_FIELDS and
             {"operation", "protocol_version", "elapsed_ms"} <= set(value))
    _require(value["operation"] == "plan_chapter" and _integer(value["protocol_version"], 2, 2))
    _require(_number(value["elapsed_ms"]) and value["elapsed_ms"] >= elapsed_ms)
    for field in TOKEN_FIELDS & value.keys():
        _require(value[field] is None or _integer(value[field]))
    for field in TIME_FIELDS & value.keys():
        _require(value[field] is None or _number(value[field]))
    if "call_count" in value:
        _require(_integer(value["call_count"], 0, 2) and value["call_count"] == 1 + repaired)
    if "repair_used" in value:
        _require(type(value["repair_used"]) is bool and value["repair_used"] == repaired)


class PlanningEventContract:
    """Validate complete frames in order; finish() represents the transport EOF."""

    def __init__(self, expected: dict[str, Any], chapter_number: int):
        _identity(expected)
        _require(_integer(chapter_number, 1))
        self.expected = copy.deepcopy(expected)
        self.chapter_number = chapter_number
        self.sequence = 0
        self.started = False
        self.terminal = ""
        self.failed = False
        self.active: tuple[str, int] | None = None
        self.completed: list[tuple[str, int]] = []
        self.progress_count = 0
        self.elapsed_ms: int | float = 0
        self.result: dict[str, Any] | None = None

    def accept(self, event: Any) -> None:
        _require(isinstance(event, dict) and not self.terminal)
        extras = {"started": set(), "progress": {"node", "visit", "status", "elapsed_ms"},
                  "done": {"result", "metrics"}, "error": {"code", "message", "status"}}
        kind = event.get("type")
        _require(isinstance(kind, str) and kind in extras and _closed(event, ENVELOPE_FIELDS | extras[kind]))
        incoming_identity = {key: event[key] for key in IDENTITY_FIELDS}
        _identity(incoming_identity)
        _require(incoming_identity == self.expected)
        _require(_integer(event["event_version"], 1, 1))
        _require(_integer(event["seq"], 1, 34) and event["seq"] == self.sequence + 1)
        _require(_integer(event["chapter_number"], 1) and event["chapter_number"] == self.chapter_number)
        if kind == "started":
            _require(not self.started and self.sequence == 0)
            self.started = True
        elif kind == "error":
            _require(isinstance(event["code"], str) and _CODE.fullmatch(event["code"]) is not None)
            _require(isinstance(event["message"], str) and len(event["message"]) <= 500)
            _require(_integer(event["status"], 400, 599))
            self.terminal = "error"
        elif kind == "progress":
            _require(self.started and not self.failed and self.progress_count < 32)
            node, visit, status = event["node"], event["visit"], event["status"]
            _require(isinstance(node, str) and node in {item[0] for item in PATH})
            _require(_integer(visit, 1, 2) and (visit == 1 or node == "validate"))
            _require(isinstance(status, str) and status in {"started", "finished", "failed"})
            _require(_number(event["elapsed_ms"]) and event["elapsed_ms"] >= self.elapsed_ms)
            step = (node, visit)
            if status == "started":
                _require(self.active is None and len(self.completed) < len(PATH) and step == PATH[len(self.completed)])
                self.active = step
            else:
                _require(self.active == step)
                self.active = None
                if status == "finished":
                    self.completed.append(step)
                else:
                    self.failed = True
            self.progress_count += 1
            self.elapsed_ms = event["elapsed_ms"]
        else:
            _require(self.started and not self.failed and self.active is None and len(self.completed) in {3, 5})
            _result(event["result"], self.chapter_number, self.completed)
            _metrics(event["metrics"], len(self.completed) == 5, self.elapsed_ms)
            self.result = copy.deepcopy(event["result"])
            self.terminal = "done"
        self.sequence = event["seq"]

    def finish(self) -> dict[str, Any]:
        _require(self.terminal == "done" and self.result is not None)
        return copy.deepcopy(self.result)


def planning_event_schema() -> dict[str, Any]:
    """Schema for individual frames; cross-frame ordering is enforced above."""
    integer = {"type": "integer", "minimum": 0, "maximum": JS_SAFE}
    number = {"type": "number", "minimum": 0, "maximum": JS_SAFE}
    text = {"type": "string"}
    strings = {"type": "array", "items": text}
    common = {key: {"type": "string", "pattern": r"^[A-Za-z0-9._:-]{1,128}(?![\s\S])"} for key in ("run_id", "step_id", "attempt_id")}
    common.update({key: {"type": "string", "pattern": r"^[0-9a-f]{64}(?![\s\S])"} for key in ("request_fingerprint", "destination_fingerprint", "execution_fingerprint")})
    common.update(input_revision=integer, protocol_version={"type": "integer", "const": 2},
                  event_version={"type": "integer", "const": 1}, seq={"type": "integer", "minimum": 1, "maximum": 34},
                  chapter_number={**integer, "minimum": 1})
    task, scene = copy.deepcopy(PLANNING_TASK), copy.deepcopy(PLANNING_SCENE)
    scene["properties"]["scene_no"] = {**integer, "minimum": 1, "maximum": 4}
    issue = {"type": "object", "properties": {key: text for key in ("code", "path", "message")},
             "required": ["code", "path", "message"], "additionalProperties": False}
    result = {"graph_version": {"type": "string", "const": "chapter-planning-v1"}, "chapter_number": {**integer, "minimum": 1},
              "status": {"type": "string", "enum": ["draft_ready", "needs_user_decision"]},
              "task_payload": {"anyOf": [task, {"type": "null"}]},
              "scene_proposal": {"anyOf": [{"type": "null"}, {"type": "object", "properties": {"scenes": {"type": "array", "items": scene, "minItems": 2, "maxItems": 4}}, "required": ["scenes"], "additionalProperties": False}]},
              "issues": {"type": "array", "items": issue}, "repair_count": {"type": "integer", "enum": [0, 1]},
              "nodes": strings, "excluded_records": integer, "warnings": strings}
    metric = {key: {"anyOf": [integer, {"type": "null"}]} for key in TOKEN_FIELDS}
    metric.update({key: {"anyOf": [number, {"type": "null"}]} for key in TIME_FIELDS})
    metric.update(operation={"type": "string", "const": "plan_chapter"}, protocol_version={"type": "integer", "const": 2},
                  elapsed_ms=number, call_count={"type": "integer", "minimum": 0, "maximum": 2}, repair_used={"type": "boolean"})
    payloads = {"started": {},
                "progress": {"node": {"type": "string", "enum": list(dict(PATH))}, "visit": {"type": "integer", "enum": [1, 2]},
                             "status": {"type": "string", "enum": ["started", "finished", "failed"]}, "elapsed_ms": number},
                "done": {"result": {"type": "object", "properties": result, "required": sorted(result), "additionalProperties": False},
                         "metrics": {"type": "object", "properties": metric, "required": ["operation", "protocol_version", "elapsed_ms"], "additionalProperties": False}},
                "error": {"code": {"type": "string", "pattern": r"^[A-Za-z0-9._:-]{1,80}(?![\s\S])"}, "message": {"type": "string", "maxLength": 500},
                          "status": {"type": "integer", "minimum": 400, "maximum": 599}}}
    frames = []
    for kind, fields in payloads.items():
        properties = {**common, "type": {"type": "string", "const": kind}, **fields}
        frame = {"type": "object", "properties": properties, "required": sorted(properties), "additionalProperties": False}
        if kind == "progress":
            frame["allOf"] = [{"if": {"properties": {"node": {"enum": ["context_pack", "initial_proposal", "repair_once"]}}},
                               "then": {"properties": {"visit": {"const": 1}}}}]
        elif kind == "done":
            fields["result"]["allOf"] = [
                {"if": {"properties": {"status": {"const": "draft_ready"}}},
                 "then": {"properties": {"issues": {"maxItems": 0}, "task_payload": task,
                                         "scene_proposal": fields["result"]["properties"]["scene_proposal"]["anyOf"][1]}}},
                {"if": {"properties": {"status": {"const": "needs_user_decision"}}},
                 "then": {"properties": {"issues": {"minItems": 1}, "repair_count": {"const": 1}}}},
            ]
        frames.append(frame)
    return copy.deepcopy({"$schema": "https://json-schema.org/draft/2020-12/schema", "title": "Chapter planning NDJSON frame v1",
                          "$comment": "Frame shape only. PlanningEventContract validates sequence, target identity, visits, elapsed monotonicity and terminal result/path consistency.", "oneOf": frames})
