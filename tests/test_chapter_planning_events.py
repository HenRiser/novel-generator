from __future__ import annotations

import copy
import json
import unittest
from pathlib import Path

from services.chapter_planning_events import JS_SAFE, PlanningEventContract, planning_event_schema
from structured_schemas import PLANNING_SCENE, PLANNING_TASK
from tests.test_chapter_planning_contract import candidate

FIXTURE = Path(__file__).with_name("fixtures") / "chapter-planning-events.json"
IDENTITY = {"run_id": "run-1", "step_id": "step-1", "attempt_id": "attempt-1", "input_revision": 3,
            "protocol_version": 2, "request_fingerprint": "a" * 64, "destination_fingerprint": "b" * 64,
            "execution_fingerprint": "c" * 64}
NODES = ["context_pack", "initial_proposal", "validate"]


def base_events(kind, identity=IDENTITY, chapter_number=2, result=None, metrics=None):
    result = copy.deepcopy(result or {"graph_version": "chapter-planning-v1", "chapter_number": chapter_number,
        "status": "draft_ready", **candidate(), "issues": [], "repair_count": 0, "nodes": NODES,
        "excluded_records": 0, "warnings": []})
    metrics = copy.deepcopy(metrics or {"operation": "plan_chapter", "protocol_version": 2, "elapsed_ms": 100})
    error = {"type": "error", "code": "provider_error", "message": "Planning failed.", "status": 502}
    rows = [error] if kind == "error_before" else [{"type": "started"}]
    if kind == "error_during":
        rows += [{"type": "progress", "node": "context_pack", "visit": 1, "status": "started", "elapsed_ms": 0}, error]
    elif kind == "failed_node":
        rows += [{"type": "progress", "node": "context_pack", "visit": 1, "status": "started", "elapsed_ms": 1},
                 {"type": "progress", "node": "context_pack", "visit": 1, "status": "failed", "elapsed_ms": 2}, error]
    elif kind in {"normal", "repair"}:
        nodes = NODES + (["repair_once", "validate"] if kind == "repair" else [])
        visits = {}
        for node in nodes:
            visits[node] = visits.get(node, 0) + 1
            for status in ("started", "finished"):
                rows.append({"type": "progress", "node": node, "visit": visits[node], "status": status, "elapsed_ms": len(rows)})
        result["nodes"] = nodes
        result["repair_count"] = int(kind == "repair")
        if "call_count" in metrics:
            metrics["call_count"] = 2 if kind == "repair" else 1
        if "repair_used" in metrics:
            metrics["repair_used"] = kind == "repair"
        rows.append({"type": "done", "result": result, "metrics": metrics})
    return [{**copy.deepcopy(identity), "event_version": 1, "seq": index + 1, "chapter_number": chapter_number, **row}
            for index, row in enumerate(rows)]


def mutate(events, changes):
    for change in changes:
        current = events[change["index"]]
        path = change["path"]
        for key in path[:-1]:
            current = current[key]
        if change.get("remove"):
            del current[path[-1]]
        else:
            current[path[-1]] = copy.deepcopy(change["value"])


class PlanningEventContractTests(unittest.TestCase):
    def test_shared_casebook(self):
        self.assertTrue(FIXTURE.exists(), "Shared planning event casebook is required.")
        book = json.loads(FIXTURE.read_text(encoding="utf-8"))
        for case in book["cases"]:
            with self.subTest(case=case["name"]):
                events = base_events(case["kind"], book["identity"], book["chapter_number"], book["result"], book["metrics"])
                mutate(events, case.get("mutations", []))
                if case.get("drop_last"):
                    events.pop()
                if "append_index" in case:
                    extra = copy.deepcopy(events[case["append_index"]])
                    extra["seq"] = len(events) + 1
                    events.append(extra)
                contract = PlanningEventContract(book["identity"], book["chapter_number"])
                accepted = True
                try:
                    for event in events:
                        contract.accept(event)
                except ValueError:
                    accepted = False
                self.assertEqual(accepted, case["accept"])
                complete = False
                if accepted:
                    try:
                        contract.finish()
                        complete = True
                    except ValueError:
                        pass
                self.assertEqual(complete, case["complete"])

    def test_normal_and_repaired_results_and_author_decision(self):
        for kind in ("normal", "repair"):
            rows = base_events(kind)
            contract = PlanningEventContract(IDENTITY, 2)
            for row in rows:
                contract.accept(row)
            self.assertEqual(contract.finish(), rows[-1]["result"])
            with self.assertRaises(ValueError):
                contract.accept(rows[-1])
        rows = base_events("repair")
        rows[-1]["result"].update(status="needs_user_decision", task_payload=None, scene_proposal=None,
                                  issues=[{"code": "invalid_json", "path": "candidate", "message": "Please review."}])
        contract = PlanningEventContract(IDENTITY, 2)
        for row in rows:
            contract.accept(row)
        self.assertEqual(contract.finish()["status"], "needs_user_decision")

    def test_error_and_eof_never_return_a_result(self):
        for kind in ("error_before", "error_during"):
            contract = PlanningEventContract(IDENTITY, 2)
            rows = base_events(kind)
            for row in rows:
                contract.accept(row)
            with self.assertRaises(ValueError):
                contract.finish()
            with self.assertRaises(ValueError):
                contract.accept(rows[-1])
        contract = PlanningEventContract(IDENTITY, 2)
        for row in base_events("normal")[:-1]:
            contract.accept(row)
        with self.assertRaises(ValueError):
            contract.finish()

    def test_failed_node_only_allows_error(self):
        rows = base_events("error_during")
        failed = {**rows[1], "seq": 3, "status": "failed", "elapsed_ms": 1}
        contract = PlanningEventContract(IDENTITY, 2)
        for row in [*rows[:2], failed]:
            contract.accept(row)
        with self.assertRaises(ValueError):
            contract.accept({**rows[1], "seq": 4})
        contract.accept({**rows[-1], "seq": 4})
        with self.assertRaises(ValueError):
            contract.finish()

    def test_non_json_numbers_and_booleans_cannot_pass_numeric_fields(self):
        for value in (float("nan"), float("inf"), float("-inf"), -1, JS_SAFE + 1, 10**400, True):
            for index, path in ((1, ["elapsed_ms"]), (-1, ["metrics", "elapsed_ms"]), (-1, ["metrics", "prompt_tokens"])):
                with self.subTest(value=value, path=path):
                    rows = base_events("normal")
                    mutate(rows, [{"index": index, "path": path, "value": value}])
                    contract = PlanningEventContract(IDENTITY, 2)
                    with self.assertRaises(ValueError):
                        for row in rows:
                            contract.accept(row)

    def test_constructor_and_input_copies(self):
        for field, value in (("input_revision", True), ("protocol_version", True), ("run_id", "bad\n"),
                             ("request_fingerprint", "A" * 64), ("input_revision", JS_SAFE + 1)):
            expected = {**IDENTITY, field: value}
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                PlanningEventContract(expected, 2)
        for chapter in (True, 0, 1.5, JS_SAFE + 1):
            with self.subTest(chapter=chapter), self.assertRaises(ValueError):
                PlanningEventContract(IDENTITY, chapter)
        expected = copy.deepcopy(IDENTITY)
        contract = PlanningEventContract(expected, 2)
        expected["run_id"] = "changed"
        rows = base_events("normal")
        for row in rows:
            contract.accept(row)
        rows[-1]["result"]["warnings"].append("changed")
        first = contract.finish()
        first["warnings"].append("changed again")
        self.assertEqual(contract.finish()["warnings"], [])

    def test_integral_json_numbers_match_javascript_and_schema(self):
        expected = {**IDENTITY, "input_revision": 3.0, "protocol_version": 2.0}
        contract = PlanningEventContract(expected, 2.0)
        rows = base_events("normal", expected)
        for row in rows:
            row.update(event_version=1.0, seq=float(row["seq"]), chapter_number=2.0)
            if row["type"] == "progress":
                row["visit"] = float(row["visit"])
            if row["type"] == "done":
                row["result"].update(repair_count=0.0, excluded_records=0.0)
                row["metrics"].update(protocol_version=2.0, call_count=1.0)
            contract.accept(row)
        self.assertEqual(contract.finish()["chapter_number"], 2)

    def test_schema_is_serializable_and_does_not_mutate_model_shapes(self):
        task, scene = copy.deepcopy(PLANNING_TASK), copy.deepcopy(PLANNING_SCENE)
        schema = planning_event_schema()
        self.assertEqual(len(schema["oneOf"]), 4)
        self.assertTrue(all(frame["additionalProperties"] is False for frame in schema["oneOf"]))
        self.assertEqual(json.loads(json.dumps(schema)), schema)
        schema["oneOf"][0]["properties"]["seq"]["maximum"] = 0
        self.assertEqual(planning_event_schema()["oneOf"][0]["properties"]["seq"]["maximum"], 34)
        self.assertEqual((PLANNING_TASK, PLANNING_SCENE), (task, scene))

    def test_published_schema_and_examples_match_the_contract(self):
        docs = Path(__file__).resolve().parents[1] / "docs"
        schema = json.loads((docs / "chapter-planning-events.schema.json").read_text(encoding="utf-8"))
        self.assertEqual(schema, planning_event_schema())
        examples = json.loads((docs / "chapter-planning-events.examples.json").read_text(encoding="utf-8"))
        for kind in ("normal", "repair", "error_before", "error_during", "failed_node"):
            with self.subTest(kind=kind):
                contract = PlanningEventContract(examples["identity"], examples["chapter_number"])
                for row in examples[kind]:
                    contract.accept(row)
                if kind in ("normal", "repair"):
                    self.assertEqual(contract.finish(), examples[kind][-1]["result"])
                else:
                    with self.assertRaises(ValueError):
                        contract.finish()

    def test_error_message_limit_counts_unicode_code_points(self):
        for size in (500, 501):
            row = base_events("error_before")[0]
            row["message"] = "\U0001f642" * size
            contract = PlanningEventContract(IDENTITY, 2)
            if size == 500:
                contract.accept(row)
            else:
                with self.assertRaises(ValueError):
                    contract.accept(row)
