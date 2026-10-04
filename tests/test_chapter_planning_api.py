from __future__ import annotations

import asyncio
import json
import struct
import subprocess
import threading
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.requests import Request

from api.routers import compute as route
from provider_catalog import default_policy, digest, request_fingerprint
from services import chapter_task_service as tasks, scene_plan_service as scenes, compute_service as service
from structured_schemas import SCHEMAS, validate_schema
from tests.test_chapter_planning_contract import candidate, constraints, planning_input
from tests.test_provider_connections import connection, client_factory, response
import model_client as models

KEY = "sk-" + "p" * 32
ROOT = Path(__file__).resolve().parents[1]


def app():
    value = FastAPI()
    value.include_router(route.router)
    return value


def payload(data=None, conn=None, key=KEY, operation="plan_chapter"):
    conn = conn or connection(policy={**default_policy("custom"), "structured": "json_object"})
    data = planning_input() if data is None else data
    return {"run_id": "planner-run", "step_id": "planner-step", "attempt_id": "planner-attempt", "input_revision": 3,
            "protocol_version": 2, "connection": conn, "credentials": {"api_key": key}, "input": data,
            "request_fingerprint": request_fingerprint(conn, operation, data)}


def wire_text(text, protocol):
    if protocol == "messages":
        return response({"content": [{"type": "text", "text": text}], "stop_reason": "end_turn",
                         "usage": {"input_tokens": 11, "output_tokens": 7}})
    return response({"choices": [{"message": {"content": text}, "finish_reason": "stop"}],
                     "usage": {"prompt_tokens": 11, "completion_tokens": 7}})


class PlanningComputeApiTests(unittest.TestCase):
    def setUp(self):
        self.slots = threading.BoundedSemaphore(2)
        self.admission = patch.object(route, "_CALLS", self.slots)
        self.admission.start()
        self.addCleanup(self.admission.stop)
        self.client = TestClient(app(), raise_server_exceptions=False)
        self.addCleanup(self.client.close)

    def assert_slots_free(self):
        self.assertTrue(self.slots.acquire(False))
        self.assertTrue(self.slots.acquire(False))
        self.assertFalse(self.slots.acquire(False))
        self.slots.release()
        self.slots.release()

    def test_capabilities_include_planning_and_local_revalidation(self):
        data = self.client.get("/api/capabilities").json()
        self.assertIn("plan_chapter", data["operations"])
        self.assertIn("validate_planning_candidate", data["operations"])
        self.assertIn("plan_chapter", data["stream_operations"])
        self.assertEqual(data["planning_stream_version"], 1)
        self.assertIn("plan_chapter", service.MODEL_OPERATIONS)
        self.assertNotIn("validate_planning_candidate", service.MODEL_OPERATIONS)
        self.assertEqual(data["limits"]["max_compute_seconds"], 180)
        self.assertEqual(data["limits"]["max_concurrent_calls"], 2)

    def test_missing_key_bad_fingerprint_unknown_operation_and_invalid_input_do_not_call_model(self):
        wrong_fingerprint = payload()
        wrong_fingerprint["request_fingerprint"] = "forged"
        invalid = planning_input()
        invalid["prefix"][0]["status"] = "awaiting_confirmation"
        cases = [("plan_chapter", payload(key=""), 400), ("plan_chapter", wrong_fingerprint, 400),
                 ("plan_chapter", payload(invalid), 400), ("unrecognized_planner", payload(), 404)]
        with patch.object(service, "request_text", new_callable=AsyncMock) as model:
            for operation, body, status in cases:
                with self.subTest(operation=operation, status=status):
                    self.assertEqual(self.client.post(f"/api/compute/{operation}", json=body).status_code, status)
                    self.assert_slots_free()
            model.assert_not_awaited()

    def test_busy_planner_is_rejected_and_revalidation_still_requires_no_key(self):
        self.slots.acquire()
        self.slots.acquire()
        try:
            with patch.object(service, "request_text", new_callable=AsyncMock) as model:
                result = self.client.post("/api/compute/plan_chapter", json=payload())
                self.assertEqual(result.status_code, 429)
                self.assertEqual(result.json()["error"]["code"], "compute_busy")
                data = {"candidate": candidate(), "constraints": constraints(required_characters=["林默", "周岚", "新角色"])}
                body = {"run_id": "local", "step_id": "validate", "attempt_id": "once", "input_revision": 0,
                        "credentials": {}, "input": data}
                checked = self.client.post("/api/compute/validate_planning_candidate", json=body)
                self.assertEqual(checked.status_code, 200, checked.text)
                codes = [issue["code"] for issue in checked.json()["result"]["issues"]]
                self.assertIn("required_characters_missing", codes)
                self.assertIn("required_characters_absent", codes)
                model.assert_not_awaited()
        finally:
            self.slots.release()
            self.slots.release()

    def test_v2_wire_shapes_structured_modes_and_usage_are_preserved(self):
        cases = [("chat_completions", "json_schema"), ("chat_completions", "json_object"),
                 ("chat_completions", "prompt_only"), ("messages", "json_schema"), ("messages", "prompt_only")]
        for protocol, mode in cases:
            with self.subTest(protocol=protocol, mode=mode):
                policy = {**default_policy("custom"), "structured": mode, "temperature": "range"}
                conn = connection(protocol=protocol, policy=policy)
                seen = []

                def upstream(request):
                    seen.append(request)
                    return wire_text(json.dumps(candidate(), ensure_ascii=False), protocol)

                with patch.object(models, "_client", client_factory(upstream)):
                    result = self.client.post("/api/compute/plan_chapter", json=payload(conn=conn))
                self.assertEqual(result.status_code, 200, result.text)
                body = json.loads(seen[0].content)
                self.assertEqual(body["model"], conn["model"])
                self.assertEqual(body["max_tokens"], 4000)
                self.assertEqual(body["temperature"], .3)
                self.assertFalse(body["stream"])
                if protocol == "messages":
                    self.assertEqual(seen[0].url.path, "/v1/messages")
                    self.assertEqual(seen[0].headers["x-api-key"], KEY)
                    self.assertIsInstance(body["system"], str)
                    if mode == "json_schema":
                        self.assertEqual(body["output_config"]["format"]["schema"], SCHEMAS["plan_chapter"])
                    else:
                        self.assertNotIn("output_config", body)
                else:
                    self.assertEqual(seen[0].url.path, "/v1/chat/completions")
                    self.assertEqual(seen[0].headers["authorization"], "Bearer " + KEY)
                    if mode == "json_schema":
                        self.assertEqual(body["response_format"]["json_schema"]["schema"], SCHEMAS["plan_chapter"])
                        self.assertTrue(body["response_format"]["json_schema"]["strict"])
                    elif mode == "json_object":
                        self.assertEqual(body["response_format"], {"type": "json_object"})
                    else:
                        self.assertNotIn("response_format", body)
                returned = result.json()
                self.assertEqual(returned["request_fingerprint"], request_fingerprint(conn, "plan_chapter", planning_input()))
                self.assertEqual(returned["result"]["status"], "draft_ready")
                self.assertEqual(returned["metrics"]["call_count"], 1)
                self.assertFalse(returned["metrics"]["repair_used"])
                self.assertEqual(returned["metrics"]["prompt_tokens"], 11)
                self.assertNotIn(KEY, result.text)
                self.assert_slots_free()
        with self.assertRaises(ValueError):
            connection(protocol="messages", policy={**default_policy("custom"), "structured": "json_object"})

    def test_two_calls_merge_usage_and_report_repair_metrics(self):
        bad = candidate()
        bad["task_payload"]["canon_budget"] = "normal"
        outputs = iter([bad, candidate()])
        seen = []

        def upstream(request):
            seen.append(json.loads(request.content))
            return wire_text(json.dumps(next(outputs), ensure_ascii=False), "chat_completions")

        conn = connection(policy={**default_policy("custom"), "structured": "json_schema", "temperature": "range"})
        with patch.object(models, "_client", client_factory(upstream)):
            result = self.client.post("/api/compute/plan_chapter", json=payload(conn=conn))
        self.assertEqual(result.status_code, 200, result.text)
        data = result.json()
        self.assertEqual([body["temperature"] for body in seen], [.3, .1])
        self.assertEqual([body["max_tokens"] for body in seen], [4000, 4000])
        self.assertEqual(data["result"]["repair_count"], 1)
        self.assertEqual(data["metrics"]["call_count"], 2)
        self.assertTrue(data["metrics"]["repair_used"])
        self.assertEqual(data["metrics"]["prompt_tokens"], 22)
        self.assertEqual(data["metrics"]["completion_tokens"], 14)
        self.assert_slots_free()

    def test_unsupported_structure_fails_before_upstream_and_v1_json_mode_still_works(self):
        with patch.object(models, "_client") as network:
            result = self.client.post("/api/compute/plan_chapter", json=payload(conn=connection()))
        self.assertEqual(result.status_code, 400)
        network.assert_not_called()
        body = {"run_id": "legacy", "step_id": "plan", "attempt_id": "once", "input_revision": 0,
                "credentials": {"api_key": KEY, "model": "deepseek-v4-flash"}, "input": planning_input()}
        with patch.object(service, "legacy_request_text", AsyncMock(return_value=json.dumps(candidate()))) as model:
            legacy = self.client.post("/api/compute/plan_chapter", json=body)
        self.assertEqual(legacy.status_code, 200, legacy.text)
        self.assertEqual(model.await_count, 1)
        self.assertTrue(model.call_args.kwargs["json_mode"])
        self.assertEqual(model.call_args.kwargs["max_tokens"], 4000)
        self.assertEqual(model.call_args.args[0].api_key, KEY)
        self.assert_slots_free()


class PlanningProtocolContracts(unittest.TestCase):
    def test_strict_schema_matches_only_existing_editable_fields(self):
        schema = SCHEMAS["plan_chapter"]
        validate_schema(schema)
        self.assertEqual(set(schema["properties"]), {"task_payload", "scene_proposal"})
        task = schema["properties"]["task_payload"]
        self.assertEqual(set(task["properties"]), tasks.EDITABLE_FIELDS)
        for field, value in task["properties"].items():
            self.assertEqual(value, {"type": "array", "items": {"type": "string"}} if field in tasks.LIST_FIELDS else {"type": "string"})
        proposal = schema["properties"]["scene_proposal"]
        self.assertEqual(set(proposal["properties"]), {"scenes"})
        scene = proposal["properties"]["scenes"]["items"]
        self.assertEqual(set(scene["properties"]), scenes.SCENE_TEXT_FIELDS | scenes.SCENE_LIST_FIELDS | {"scene_no"})
        self.assertEqual(scene["properties"]["scene_no"], {"type": "integer"})

    def test_python_and_typescript_fingerprints_and_browser_preflight_match(self):
        snapshots = [connection(policy={**default_policy("custom"), "structured": "json_schema", "temperature": mode})
                     for mode in ("range", "fixed", "omit")]
        expected = []
        for conn in snapshots:
            policy = conn["policy"]
            parameters = [{"tokens": 4000, "temperature": None if policy["temperature"] == "omit" else
                           struct.pack(">d", policy["temperature_fixed"] if policy["temperature"] == "fixed" else temperature).hex()}
                          for temperature in (.3, .1)]
            value = digest(json.dumps({"execution": conn["execution_fingerprint"], "operation": "plan_chapter", "parameters": parameters},
                                      sort_keys=True, separators=(",", ":"), ensure_ascii=False))
            self.assertEqual(request_fingerprint(conn, "plan_chapter", planning_input()), value)
            expected.append(value)
        # Execute the installed TypeScript compiler's output for the actual pure browser functions.
        script = r"""
const fs=require('node:fs'),vm=require('node:vm'),{webcrypto}=require('node:crypto');
const ts=require('./frontend/node_modules/typescript');
function load(file,names){
 const source=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
 const selected=source.statements.filter(s=>s.name&&names.includes(s.name.text)||s.declarationList&&s.declarationList.declarations.some(d=>names.includes(d.name.getText(source))));
 const text=selected.map(s=>s.getText(source)).join('\n');
 const output=ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const scope={exports:{},crypto:webcrypto,TextEncoder,AbortController};vm.runInNewContext(output,scope);return scope.exports;
}
const pc=load('frontend/src/providerConnections.ts',['hash','stable','requestFingerprint']);
const compute=load('frontend/src/computeClient.ts',['MODEL_OPERATIONS','prepareCompute']);
const input=JSON.parse(fs.readFileSync(0,'utf8'));
(async()=>{
 const fingerprints=await Promise.all(input.snapshots.map(s=>pc.requestFingerprint(s,'plan_chapter',input.data)));
 let unsupported=false,missingLease=false;
 try{compute.prepareCompute('plan_chapter',input.data,{});}catch{missingLease=true;}
 const snapshot={...input.snapshots[0],policy:{...input.snapshots[0].policy,structured:'unsupported'}};
 try{compute.prepareCompute('plan_chapter',input.data,{}, {snapshot,apiKey:'FAKE',signal:new AbortController().signal});}catch{unsupported=true;}
 for(const mode of ['json_schema','json_object','prompt_only'])compute.prepareCompute('plan_chapter',input.data,{}, {snapshot:{...snapshot,policy:{...snapshot.policy,structured:mode}},apiKey:'FAKE',signal:new AbortController().signal});
 compute.prepareCompute('validate_planning_candidate',{},{});
 process.stdout.write(JSON.stringify({fingerprints,unsupported,missingLease,modelOp:compute.MODEL_OPERATIONS.has('plan_chapter'),validationIsModel:compute.MODEL_OPERATIONS.has('validate_planning_candidate')}));
})().catch(e=>{process.stderr.write(String(e));process.exitCode=1;});
"""
        run = subprocess.run(["node", "-e", script], cwd=ROOT, input=json.dumps({"snapshots": snapshots, "data": planning_input()}),
                             text=True, capture_output=True, timeout=20)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(json.loads(run.stdout), {"fingerprints": expected, "unsupported": True, "missingLease": True,
                                                 "modelOp": True, "validationIsModel": False})


class PlanningAsyncBoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def test_outer_timeout_cleans_up_upstream_and_frees_admission(self):
        slots = threading.BoundedSemaphore(2)
        cleaned = asyncio.Event()

        async def model(*args, **kwargs):
            try:
                await asyncio.Event().wait()
            finally:
                await asyncio.sleep(.01)
                cleaned.set()

        with patch.object(route, "_CALLS", slots), patch.object(route, "MAX_COMPUTE_SECONDS", .1), patch.object(service, "request_text", side_effect=model):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app()), base_url="http://test") as client:
                result = await client.post("/api/compute/plan_chapter", json=payload())
        self.assertEqual(result.status_code, 504)
        self.assertTrue(cleaned.is_set())
        self.assertTrue(slots.acquire(False))
        self.assertTrue(slots.acquire(False))
        self.assertFalse(slots.acquire(False))

    async def test_disconnect_cancels_planning_and_frees_admission(self):
        slots = threading.BoundedSemaphore(2)
        began, cleaned = asyncio.Event(), asyncio.Event()

        async def model(*args, **kwargs):
            began.set()
            try:
                await asyncio.Event().wait()
            finally:
                await asyncio.sleep(.01)
                cleaned.set()

        raw = json.dumps(payload()).encode()
        reads = 0

        async def receive():
            nonlocal reads
            reads += 1
            if reads == 1:
                return {"type": "http.request", "body": raw, "more_body": False}
            await began.wait()
            return {"type": "http.disconnect"}

        request = Request({"type": "http", "headers": [(b"content-type", b"application/json")]}, receive)
        with patch.object(route, "_CALLS", slots), patch.object(service, "request_text", side_effect=model):
            with self.assertRaises(asyncio.CancelledError):
                await route.compute_endpoint("plan_chapter", request)
        self.assertTrue(cleaned.is_set())
        self.assertTrue(slots.acquire(False))
        self.assertTrue(slots.acquire(False))
        self.assertFalse(slots.acquire(False))


if __name__ == "__main__":
    unittest.main()
