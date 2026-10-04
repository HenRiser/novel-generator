from __future__ import annotations

import asyncio
import copy
import json
import unittest
from contextlib import ExitStack
from contextvars import ContextVar
from unittest.mock import AsyncMock, MagicMock, patch

from anyio import CancelScope
from langchain_core.tracers.context import tracing_v2_callback_var, tracing_v2_enabled
from langgraph.errors import NodeCancelledError
from langgraph.graph.state import CompiledStateGraph
from langsmith import tracing_context
from langsmith.run_helpers import get_tracing_context
from langsmith.run_trees import RunTree

from deepseek_client import DeepSeekClientError
from services import chapter_planning_service as service
from tests.test_chapter_planning_contract import candidate, document, node, planning_input

RESULT_FIELDS = {"graph_version", "chapter_number", "status", "task_payload", "scene_proposal", "issues",
                 "repair_count", "nodes", "excluded_records", "warnings"}
CALLER_SECRET = ContextVar("planning_test_caller_secret", default="unset")


def encoded(proposal=None):
    return json.dumps(candidate() if proposal is None else proposal, ensure_ascii=False)


def bad_budget():
    proposal = candidate()
    proposal["task_payload"]["canon_budget"] = "normal"
    return proposal


def network_tripwires(stack):
    return [stack.enter_context(patch(target, side_effect=AssertionError("Unexpected network request during planning")))
            for target in ("httpx.Client.send", "httpx.AsyncClient.send", "httpx2.Client.send",
                           "httpx2.AsyncClient.send", "requests.Session.request")]


class ChapterPlanningServiceTests(unittest.IsolatedAsyncioTestCase):
    def assert_result(self, result, status, repair_count):
        self.assertEqual(set(result), RESULT_FIELDS)
        self.assertEqual(result["graph_version"], "chapter-planning-v1")
        self.assertEqual(result["chapter_number"], 2)
        self.assertEqual(result["status"], status)
        self.assertEqual(result["repair_count"], repair_count)
        self.assertIsInstance(result["nodes"], list)
        self.assertTrue(all(isinstance(name, str) for name in result["nodes"]))
        self.assertIsInstance(result["warnings"], list)
        self.assertTrue(all(isinstance(warning, str) for warning in result["warnings"]))
        self.assertNotIn("approved", json.dumps(result))

    async def test_valid_candidate_uses_one_call_and_preserves_input(self):
        data = planning_input()
        before = copy.deepcopy(data)
        model = AsyncMock(return_value=encoded())
        result = await service.plan_chapter(data, model)
        self.assert_result(result, "draft_ready", 0)
        self.assertEqual(result["issues"], [])
        self.assertEqual(result["task_payload"], candidate()["task_payload"])
        self.assertEqual(result["scene_proposal"], candidate()["scene_proposal"])
        self.assertEqual(model.await_count, 1)
        self.assertEqual(model.call_args.kwargs, {"temperature": .3, "max_tokens": 4000, "json_mode": True})
        prompt = json.loads(model.call_args.args[0][1]["content"])
        self.assertEqual(prompt["explicit_constraints"], data["constraints"])
        self.assertEqual(prompt["confirmed_prefix"], data["prefix"])
        self.assertEqual(data, before)

    async def test_one_directed_repair_keeps_the_same_frozen_context(self):
        data = planning_input()
        model = AsyncMock(side_effect=[encoded(bad_budget()), encoded()])
        result = await service.plan_chapter(data, model)
        self.assert_result(result, "draft_ready", 1)
        self.assertEqual(model.await_count, 2)
        initial, repaired = model.call_args_list
        self.assertEqual(initial.kwargs, {"temperature": .3, "max_tokens": 4000, "json_mode": True})
        self.assertEqual(repaired.kwargs, {"temperature": .1, "max_tokens": 4000, "json_mode": True})
        self.assertEqual(initial.args[0], repaired.args[0][:-1])
        self.assertIn("canon_budget_changed", repaired.args[0][-1]["content"])
        self.assertEqual(json.loads(repaired.args[0][1]["content"])["explicit_constraints"], data["constraints"])

    async def test_same_scene_information_conflict_uses_the_repair_budget(self):
        proposal = candidate()
        proposal["scene_proposal"]["scenes"][0]["allowed_information"].append("发现备用钥匙")
        proposal["scene_proposal"]["scenes"][0]["forbidden_information"].append("发现备用钥匙")
        model = AsyncMock(side_effect=[encoded(proposal), encoded()])
        result = await service.plan_chapter(planning_input(), model)
        self.assert_result(result, "draft_ready", 1)
        self.assertEqual(model.await_count, 2)
        self.assertIn("forbidden_information", model.call_args_list[1].args[0][-1]["content"])

    async def test_second_invalid_candidate_stops_for_author_decision(self):
        model = AsyncMock(return_value=encoded(bad_budget()))
        result = await service.plan_chapter(planning_input(), model)
        self.assert_result(result, "needs_user_decision", 1)
        self.assertEqual(model.await_count, 2)
        self.assertIn("canon_budget_changed", [issue["code"] for issue in result["issues"]])

    async def test_two_invalid_json_outputs_keep_safe_issues_and_no_raw_state(self):
        raw = "RAW_PROVIDER_SENTINEL containing an invalid response and sk-FAKE_KEY_SENTINEL"
        model = AsyncMock(return_value=raw)
        states = []
        original = CompiledStateGraph.ainvoke

        async def capture(graph, initial, config=None, **kwargs):
            states.append(copy.deepcopy(initial))
            final = await original(graph, initial, config, **kwargs)
            states.append(copy.deepcopy(final))
            return final

        with patch.object(CompiledStateGraph, "ainvoke", capture):
            result = await service.plan_chapter(planning_input(), model)
        self.assert_result(result, "needs_user_decision", 1)
        self.assertEqual(model.await_count, 2)
        self.assertIsNone(result["task_payload"])
        self.assertIsNone(result["scene_proposal"])
        self.assertEqual([issue["code"] for issue in result["issues"]], ["invalid_json"])
        for value in [result, *states]:
            serialized = json.dumps(value, ensure_ascii=False)
            self.assertNotIn("RAW_PROVIDER_SENTINEL", serialized)
            self.assertNotIn("FAKE_KEY_SENTINEL", serialized)

    async def test_empty_and_approval_metadata_candidates_are_not_applied(self):
        forged = {**candidate(), "status": "approved", "api_key": "EXTRA_OUTPUT_SECRET_SENTINEL"}
        for raw in (encoded({}), encoded(forged)):
            with self.subTest(raw=raw):
                model = AsyncMock(return_value=raw)
                result = await service.plan_chapter(planning_input(), model)
                self.assert_result(result, "needs_user_decision", 1)
                self.assertEqual(model.await_count, 2)
                self.assertIsNone(result["task_payload"])
                self.assertIsNone(result["scene_proposal"])
                self.assertNotIn("EXTRA_OUTPUT_SECRET_SENTINEL", json.dumps(result))

    async def test_unknown_json_fields_are_projected_before_every_state_update(self):
        injections = [
            lambda proposal, fields: proposal.update(fields),
            lambda proposal, fields: proposal["task_payload"].update(fields),
            lambda proposal, fields: proposal["scene_proposal"].update(fields),
            lambda proposal, fields: proposal["scene_proposal"]["scenes"][0].update(fields),
        ]
        for index, inject in enumerate(injections):
            with self.subTest(location=index):
                proposal = candidate()
                sentinel = f"UNKNOWN_STATE_SECRET_SENTINEL_{index}"
                fields = {"api_key": sentinel, "private_archive": {"future_text": sentinel},
                          "credentials": {"api_key": sentinel}}
                inject(proposal, fields)
                model = AsyncMock(return_value=encoded(proposal))
                states = []
                original_invoke, original_stream = CompiledStateGraph.ainvoke, CompiledStateGraph.astream

                async def capture_invoke(graph, initial, config=None, **kwargs):
                    states.append(copy.deepcopy(initial))
                    final = await original_invoke(graph, initial, config, **kwargs)
                    states.append(copy.deepcopy(final))
                    return final

                async def capture_stream(graph, *args, **kwargs):
                    async for state in original_stream(graph, *args, **kwargs):
                        payload = state[-1] if isinstance(state, tuple) else state
                        if isinstance(payload, dict):
                            states.append(copy.deepcopy(payload))
                        yield state

                with patch.object(CompiledStateGraph, "ainvoke", capture_invoke), patch.object(CompiledStateGraph, "astream", capture_stream):
                    result = await service.plan_chapter(planning_input(), model)
                self.assert_result(result, "needs_user_decision", 1)
                self.assertEqual(model.await_count, 2)
                self.assertIn("invalid_fields", [issue["code"] for issue in result["issues"]])
                self.assertTrue(any(state.get("calls") == 1 for state in states))
                self.assertTrue(any(state.get("calls") == 2 for state in states))
                self.assertIn("repair_once", result["nodes"])
                for value in [*states, result, model.call_args_list[1].args[0]]:
                    serialized = json.dumps(value, ensure_ascii=False)
                    self.assertNotIn(sentinel, serialized)
                    self.assertNotIn('"api_key"', serialized)
                    self.assertNotIn('"private_archive"', serialized)
                    self.assertNotIn('"credentials"', serialized)
                for state in states:
                    if "candidate" in state:
                        self.assertEqual(set(state["candidate"]), {"task_payload", "scene_proposal"})

    async def test_provider_failure_never_triggers_a_repair(self):
        for error in (ConnectionError("network interrupted"), DeepSeekClientError("quota exhausted"),
                      DeepSeekClientError("output truncated"), asyncio.TimeoutError("model deadline")):
            with self.subTest(error=type(error).__name__, message=str(error)):
                model = AsyncMock(side_effect=error)
                with self.assertRaises(type(error)):
                    await service.plan_chapter(planning_input(), model)
                self.assertEqual(model.await_count, 1)

    async def test_invalid_input_never_calls_the_model(self):
        for mutate in (lambda data: data.update(chapter_number=1),
                       lambda data: data["prefix"][0].update(status="awaiting_confirmation"),
                       lambda data: data.update(credentials={"api_key": "MUST_NOT_BE_USED"})):
            with self.subTest(mutate=mutate):
                data = planning_input()
                mutate(data)
                model = AsyncMock(return_value=encoded())
                with self.assertRaises(ValueError):
                    await service.plan_chapter(data, model)
                model.assert_not_awaited()

    async def test_cancel_waits_for_upstream_cleanup(self):
        started, cleaned = asyncio.Event(), asyncio.Event()

        async def model(*args, **kwargs):
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                await asyncio.sleep(.01)
                cleaned.set()

        invocation = asyncio.create_task(service.plan_chapter(planning_input(), model))
        await asyncio.wait_for(started.wait(), 2)
        invocation.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await invocation
        self.assertTrue(cleaned.is_set())

    async def test_shared_timeout_cancels_second_call_and_awaits_cleanup(self):
        calls = 0
        second_started, cleaned = asyncio.Event(), asyncio.Event()
        invocation_started = asyncio.Event()
        clock = {}
        original_invoke = service._isolated_invoke

        async def capture_start(*args, **kwargs):
            clock["start"] = service.monotonic()
            invocation_started.set()
            return await original_invoke(*args, **kwargs)

        async def model(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                await asyncio.sleep(.3)
                return encoded(bad_budget())
            second_started.set()
            try:
                await asyncio.Event().wait()
            finally:
                await asyncio.sleep(.01)
                cleaned.set()

        with patch.object(service, "MAX_PLANNING_SECONDS", .8), patch.object(service, "_isolated_invoke", capture_start):
            invocation = asyncio.create_task(service.plan_chapter(planning_input(), model))
            try:
                await asyncio.wait_for(invocation_started.wait(), 2)
                await asyncio.wait_for(second_started.wait(), 1)
                finished, _ = await asyncio.wait({invocation}, timeout=max(0, clock["start"] + .95 - service.monotonic()))
                self.assertIn(invocation, finished, "The second call must not reset the shared timeout budget.")
                with self.assertRaises(asyncio.TimeoutError):
                    await invocation
            finally:
                if not invocation.done():
                    invocation.cancel()
                await asyncio.gather(invocation, return_exceptions=True)
        self.assertEqual(calls, 2)
        self.assertTrue(second_started.is_set())
        self.assertTrue(cleaned.is_set())

    async def test_future_unreviewed_archives_and_metadata_do_not_enter_prompt(self):
        imported = {"kind": "source_fact", "chapter_number": 1, "reviewed": True}
        data = planning_input()
        data["graph"] = document([
            node("confirmed", imported, summary="SAFE_REVIEWED_FACT", importance=9,
                 properties={"archive": {"text": "ARCHIVE_SENTINEL"}, "credentials": {"api_key": "PROPERTY_KEY_SENTINEL"}}),
            node("future", {**imported, "chapter_number": 2}, summary="FUTURE_SECRET_SENTINEL"),
            node("unreviewed", {**imported, "reviewed": False}, summary="UNREVIEWED_SECRET_SENTINEL"),
        ])
        data["graph"]["metadata"] = {"future": "METADATA_SECRET_SENTINEL"}
        data["graph"]["tag_registry"] = {"secret": {"description": "TAG_SECRET_SENTINEL"}}
        model = AsyncMock(return_value=encoded())
        result = await service.plan_chapter(data, model)
        prompt = json.dumps(model.call_args.args[0], ensure_ascii=False)
        self.assertIn("SAFE_REVIEWED_FACT", prompt)
        for secret in ("ARCHIVE_SENTINEL", "PROPERTY_KEY_SENTINEL", "FUTURE_SECRET_SENTINEL", "UNREVIEWED_SECRET_SENTINEL",
                       "METADATA_SECRET_SENTINEL", "TAG_SECRET_SENTINEL"):
            self.assertNotIn(secret, prompt)
            self.assertNotIn(secret, json.dumps(result))
        self.assertEqual(result["excluded_records"], 2)

    async def test_environment_trace_is_disabled_without_any_network_or_persistors(self):
        compiled = []
        original_compile = service.StateGraph.compile

        def capture_compile(builder, *args, **kwargs):
            graph = original_compile(builder, *args, **kwargs)
            compiled.append(graph)
            return graph

        async def model(*args, **kwargs):
            context = get_tracing_context()
            self.assertIs(context["enabled"], False)
            self.assertIsNone(context["parent"])
            return encoded()

        with ExitStack() as stack:
            stack.enter_context(patch.dict("os.environ", {"LANGSMITH_TRACING": "true", "LANGCHAIN_TRACING_V2": "true",
                                                        "LANGSMITH_API_KEY": "FAKE_TRACE_KEY"}))
            tripwires = network_tripwires(stack)
            tracer_constructor = stack.enter_context(patch("langchain_core.tracers.langchain.LangChainTracer.__init__",
                                                          side_effect=AssertionError("Unexpected tracer construction")))
            stack.enter_context(patch.object(service.StateGraph, "compile", capture_compile))
            result = await service.plan_chapter(planning_input(), model)
            await asyncio.sleep(.02)
            for network in tripwires:
                network.assert_not_called()
            tracer_constructor.assert_not_called()
        self.assert_result(result, "draft_ready", 0)
        self.assertEqual(len(compiled), 1)
        self.assertIsNone(compiled[0].checkpointer)
        self.assertIsNone(compiled[0].store)
        self.assertIsNone(compiled[0].cache)

    async def test_parent_trace_callbacks_and_credentials_are_isolated_between_concurrent_plans(self):
        client = MagicMock(name="parent_trace_client")
        parent = RunTree(name="existing_parent", inputs={}, ls_client=client,
                         extra={"metadata": {"secret": "PARENT_TRACE_SECRET_SENTINEL"}})
        seen_prompts, states, configs = [], [], []
        entered, ready = 0, asyncio.Event()
        original = CompiledStateGraph.ainvoke

        async def capture(graph, initial, config=None, **kwargs):
            configs.append(copy.deepcopy(config))
            states.append(copy.deepcopy(initial))
            final = await original(graph, initial, config, **kwargs)
            states.append(copy.deepcopy(final))
            return final

        def caller(marker):
            key = "CLOSURE_KEY_SECRET_SENTINEL"

            async def model(messages, **kwargs):
                nonlocal entered
                self.assertTrue(key)
                self.assertIs(get_tracing_context()["enabled"], False)
                self.assertIsNone(get_tracing_context()["parent"])
                self.assertIsNone(tracing_v2_callback_var.get())
                self.assertEqual(CALLER_SECRET.get(), "unset")
                seen_prompts.append((marker, json.dumps(messages, ensure_ascii=False)))
                entered += 1
                if entered == 2:
                    ready.set()
                await asyncio.wait_for(ready.wait(), 2)
                proposal = candidate()
                proposal["task_payload"]["notes"] = marker
                return encoded(proposal)

            return model

        token = CALLER_SECRET.set("CALLER_CONTEXT_SECRET_SENTINEL")
        try:
            with ExitStack() as stack:
                stack.enter_context(patch.dict("os.environ", {"LANGSMITH_TRACING": "true", "LANGCHAIN_TRACING_V2": "true",
                                                            "LANGSMITH_API_KEY": "FAKE_TRACE_KEY"}))
                tripwires = network_tripwires(stack)
                stack.enter_context(tracing_v2_enabled(client=client, tags=["PARENT_TAG_SECRET_SENTINEL"]))
                stack.enter_context(tracing_context(enabled=True, parent=parent, client=client))
                client.reset_mock()
                tracer_constructor = stack.enter_context(patch("langchain_core.tracers.langchain.LangChainTracer.__init__",
                                                              side_effect=AssertionError("Unexpected child tracer construction")))
                stack.enter_context(patch.object(CompiledStateGraph, "ainvoke", capture))
                inputs = [planning_input(), planning_input()]
                inputs[0]["author_intent"], inputs[1]["author_intent"] = "REQUEST_A_SENTINEL", "REQUEST_B_SENTINEL"
                outputs = await asyncio.gather(service.plan_chapter(inputs[0], caller("REQUEST_A_SENTINEL")),
                                               service.plan_chapter(inputs[1], caller("REQUEST_B_SENTINEL")))
                self.assertIs(get_tracing_context()["enabled"], True)
                self.assertIs(get_tracing_context()["parent"], parent)
                self.assertIsNotNone(tracing_v2_callback_var.get())
                await asyncio.sleep(.02)
                for network in tripwires:
                    network.assert_not_called()
                tracer_constructor.assert_not_called()
                self.assertEqual(client.mock_calls, [])
        finally:
            CALLER_SECRET.reset(token)
        self.assertEqual([output["task_payload"]["notes"] for output in outputs], ["REQUEST_A_SENTINEL", "REQUEST_B_SENTINEL"])
        for marker, prompt in seen_prompts:
            self.assertIn(marker, prompt)
            self.assertNotIn("REQUEST_B_SENTINEL" if marker == "REQUEST_A_SENTINEL" else "REQUEST_A_SENTINEL", prompt)
        for config in configs:
            self.assertEqual(config["callbacks"], [])
            self.assertEqual(config["metadata"], {})
        for value in [*states, *configs, *outputs]:
            serialized = json.dumps(value, ensure_ascii=False)
            for secret in ("CLOSURE_KEY_SECRET_SENTINEL", "CALLER_CONTEXT_SECRET_SENTINEL", "PARENT_TRACE_SECRET_SENTINEL", "PARENT_TAG_SECRET_SENTINEL"):
                self.assertNotIn(secret, serialized)
        client.create_run.assert_not_called()
        client.update_run.assert_not_called()

    async def test_stream_matches_json_with_one_graph_and_no_second_invoke(self):
        for replies in ([encoded()], [encoded(bad_budget()), encoded()], [encoded(bad_budget()), encoded(bad_budget())]):
            with self.subTest(calls=len(replies)):
                expected = await service.plan_chapter(planning_input(), AsyncMock(side_effect=replies))
                model = AsyncMock(side_effect=replies)
                compiled = []
                original_compile = service.StateGraph.compile

                def capture_compile(builder, *args, **kwargs):
                    graph = original_compile(builder, *args, **kwargs)
                    compiled.append(graph)
                    return graph

                with patch.object(service.StateGraph, "compile", capture_compile), \
                     patch.object(CompiledStateGraph, "ainvoke", side_effect=AssertionError("Stream must not reinvoke the graph")):
                    rows = [row async for row in service.stream_plan_chapter(planning_input(), model)]
                self.assertEqual(rows[-1], {"type": "done", "result": expected})
                self.assertEqual(model.await_count, len(replies))
                self.assertEqual(len(compiled), 1)
                self.assertIsNone(compiled[0].checkpointer)
                self.assertIsNone(compiled[0].cache)
                path = ["context_pack", "initial_proposal", "validate"] + (["repair_once", "validate"] if len(replies) == 2 else [])
                visits, wanted = {}, []
                for node_name in path:
                    visits[node_name] = visits.get(node_name, 0) + 1
                    wanted += [(node_name, visits[node_name], phase) for phase in ("started", "finished")]
                self.assertEqual([(row["node"], row["visit"], row["status"]) for row in rows[:-1]], wanted)
                times = [row["elapsed_ms"] for row in rows[:-1]]
                self.assertEqual(times, sorted(times))
                for row in rows[:-1]:
                    self.assertEqual(set(row), {"type", "node", "visit", "status", "elapsed_ms"})

    async def test_stream_progress_precedes_result_and_close_waits_for_model_cleanup(self):
        entered, cleaned = asyncio.Event(), asyncio.Event()

        async def model(*args, **kwargs):
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                await asyncio.sleep(.01)
                cleaned.set()

        stream = service.stream_plan_chapter(planning_input(), model)
        rows = []
        while True:
            row = await asyncio.wait_for(stream.__anext__(), 2)
            rows.append(row)
            if row["node"] == "initial_proposal" and row["status"] == "started":
                break
        await asyncio.wait_for(entered.wait(), 2)
        self.assertFalse(cleaned.is_set())
        self.assertFalse(any(row["type"] == "done" for row in rows))
        await asyncio.wait_for(stream.aclose(), 2)
        self.assertTrue(cleaned.is_set())

    async def test_stream_deadline_and_repeated_transport_cancel_preserve_cleanup(self):
        cleanup_started, cleaned = asyncio.Event(), asyncio.Event()

        async def model(*args, **kwargs):
            try:
                await asyncio.Event().wait()
            finally:
                cleanup_started.set()
                await asyncio.sleep(.03)
                cleaned.set()

        start = service.monotonic()

        async def collect():
            return [row async for row in service.stream_plan_chapter(planning_input(), model, started_at=start, deadline=start + .2)]

        consumer = asyncio.create_task(collect())
        try:
            await asyncio.wait_for(cleanup_started.wait(), 2)
            consumer.cancel()
            await asyncio.sleep(.005)
            consumer.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await consumer
            self.assertTrue(cleaned.is_set())
        finally:
            if not consumer.done():
                consumer.cancel()
            await asyncio.gather(consumer, return_exceptions=True)

    async def test_stream_close_inside_cancelled_anyio_scope_waits_for_cleanup(self):
        entered, cleaned = asyncio.Event(), asyncio.Event()

        async def model(*args, **kwargs):
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                await asyncio.sleep(.01)
                cleaned.set()

        stream = service.stream_plan_chapter(planning_input(), model)
        while True:
            row = await asyncio.wait_for(stream.__anext__(), 2)
            if row["node"] == "initial_proposal" and row["status"] == "started":
                break
        await asyncio.wait_for(entered.wait(), 2)
        with CancelScope() as scope:
            scope.cancel()
            await stream.aclose()
        self.assertTrue(cleaned.is_set())

    async def test_stream_shared_deadline_cleans_second_call_without_a_third(self):
        calls = 0
        second_started, cleaned = asyncio.Event(), asyncio.Event()

        async def model(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                await asyncio.sleep(.3)
                return encoded(bad_budget())
            second_started.set()
            try:
                await asyncio.Event().wait()
            finally:
                await asyncio.sleep(.01)
                cleaned.set()

        start = service.monotonic()

        async def collect():
            return [row async for row in service.stream_plan_chapter(planning_input(), model, started_at=start, deadline=start + .8)]

        invocation = asyncio.create_task(collect())
        try:
            await asyncio.wait_for(second_started.wait(), 1)
            finished, _ = await asyncio.wait({invocation}, timeout=max(0, start + .95 - service.monotonic()))
            self.assertIn(invocation, finished, "The second call must use the original absolute deadline.")
            with self.assertRaises(asyncio.TimeoutError):
                await invocation
        finally:
            if not invocation.done():
                invocation.cancel()
            await asyncio.gather(invocation, return_exceptions=True)
        self.assertEqual(calls, 2)
        self.assertTrue(second_started.is_set())
        self.assertTrue(cleaned.is_set())
        model = AsyncMock(return_value=encoded())
        with self.assertRaises(asyncio.TimeoutError):
            _ = [row async for row in service.stream_plan_chapter(planning_input(), model, started_at=start, deadline=start)]
        model.assert_not_awaited()

    async def test_stream_input_errors_and_provider_cancel_do_not_hang_or_retry(self):
        data = planning_input()
        data["chapter_number"] = 1
        model = AsyncMock(return_value=encoded())
        with self.assertRaises(ValueError):
            _ = [row async for row in service.stream_plan_chapter(data, model)]
        model.assert_not_awaited()

        async def collect(caller):
            return [row async for row in service.stream_plan_chapter(planning_input(), caller)]

        for error in (ConnectionError("PROVIDER_RAW_ERROR_SENTINEL"), DeepSeekClientError("output truncated"), asyncio.CancelledError()):
            with self.subTest(error=type(error).__name__):
                caller = AsyncMock(side_effect=error)
                with self.assertRaises(type(error)):
                    await asyncio.wait_for(collect(caller), 2)
                self.assertEqual(caller.await_count, 1)

    async def test_wrapped_node_cancel_propagates_after_cleanup_without_retry(self):
        for transport in ("json", "stream"):
            with self.subTest(transport=transport):
                entered, cleaned = asyncio.Event(), asyncio.Event()
                rows = []

                async def model(*args, **kwargs):
                    entered.set()
                    try:
                        raise NodeCancelledError("initial_proposal")
                    finally:
                        await asyncio.sleep(.01)
                        cleaned.set()

                caller = AsyncMock(side_effect=model)

                async def collect():
                    try:
                        if transport == "json":
                            await service.plan_chapter(planning_input(), caller)
                        else:
                            async for row in service.stream_plan_chapter(planning_input(), caller):
                                rows.append(row)
                    except asyncio.CancelledError:
                        self.assertTrue(cleaned.is_set(), "Model cleanup must finish before cancellation reaches the caller.")
                        raise

                with self.assertRaises(asyncio.CancelledError):
                    await asyncio.wait_for(collect(), 2)
                self.assertTrue(entered.is_set())
                self.assertTrue(cleaned.is_set())
                caller.assert_awaited_once()
                self.assertFalse(any(row["type"] == "done" or row.get("node") == "repair_once" for row in rows))

    async def test_stream_projects_task_payloads_and_invalid_model_fields(self):
        proposal = {**candidate(), "credentials": {"api_key": "RAW_STATE_SECRET_SENTINEL"}}
        data = planning_input()
        data["author_intent"] = "PRIVATE_INTENT_SENTINEL"
        model = AsyncMock(return_value=encoded(proposal))
        rows = [row async for row in service.stream_plan_chapter(data, model)]
        self.assertEqual(rows[-1]["result"]["status"], "needs_user_decision")
        self.assertEqual(model.await_count, 2)
        serialized = json.dumps(rows)
        for marker in ("RAW_STATE_SECRET_SENTINEL", "PRIVATE_INTENT_SENTINEL", "frozen_context", "interrupts", "triggers"):
            self.assertNotIn(marker, serialized)

    async def test_stream_environment_parent_context_and_concurrent_runs_are_isolated(self):
        client = MagicMock(name="stream_parent_trace_client")
        parent = RunTree(name="stream_parent", inputs={}, ls_client=client)
        entered, ready = 0, asyncio.Event()
        seen, configs = [], []
        original = CompiledStateGraph.astream

        async def capture(graph, initial, config=None, **kwargs):
            configs.append(copy.deepcopy(config))
            async for chunk in original(graph, initial, config, **kwargs):
                yield chunk

        def caller(marker):
            async def model(messages, **kwargs):
                nonlocal entered
                self.assertIs(get_tracing_context()["enabled"], False)
                self.assertIsNone(get_tracing_context()["parent"])
                self.assertIsNone(tracing_v2_callback_var.get())
                self.assertEqual(CALLER_SECRET.get(), "unset")
                seen.append((marker, json.dumps(messages)))
                entered += 1
                if entered == 2:
                    ready.set()
                await asyncio.wait_for(ready.wait(), 2)
                proposal = candidate()
                proposal["task_payload"]["notes"] = marker
                return encoded(proposal)
            return model

        async def collect(marker):
            data = planning_input()
            data["author_intent"] = marker
            return [row async for row in service.stream_plan_chapter(data, caller(marker))]

        token = CALLER_SECRET.set("CALLER_CONTEXT_SECRET_SENTINEL")
        try:
            with ExitStack() as stack:
                stack.enter_context(patch.dict("os.environ", {"LANGSMITH_TRACING": "true", "LANGCHAIN_TRACING_V2": "true", "LANGSMITH_API_KEY": "FAKE_TRACE_KEY"}))
                tripwires = network_tripwires(stack)
                stack.enter_context(tracing_v2_enabled(client=client, tags=["PARENT_TAG_SECRET_SENTINEL"]))
                stack.enter_context(tracing_context(enabled=True, parent=parent, client=client))
                client.reset_mock()
                tracer_constructor = stack.enter_context(patch("langchain_core.tracers.langchain.LangChainTracer.__init__", side_effect=AssertionError("Unexpected child tracer")))
                stack.enter_context(patch.object(CompiledStateGraph, "astream", capture))
                rows = await asyncio.gather(collect("STREAM_A_SENTINEL"), collect("STREAM_B_SENTINEL"))
                self.assertIs(get_tracing_context()["enabled"], True)
                self.assertIs(get_tracing_context()["parent"], parent)
                await asyncio.sleep(.02)
                for network in tripwires:
                    network.assert_not_called()
                tracer_constructor.assert_not_called()
                self.assertEqual(client.mock_calls, [])
        finally:
            CALLER_SECRET.reset(token)
        self.assertEqual([items[-1]["result"]["task_payload"]["notes"] for items in rows], ["STREAM_A_SENTINEL", "STREAM_B_SENTINEL"])
        for marker, prompt in seen:
            self.assertIn(marker, prompt)
            self.assertNotIn("STREAM_B_SENTINEL" if marker == "STREAM_A_SENTINEL" else "STREAM_A_SENTINEL", prompt)
        for config in configs:
            self.assertEqual(config["callbacks"], [])
            self.assertEqual(config["metadata"], {})
        serialized = json.dumps([rows, configs])
        self.assertNotIn("CALLER_CONTEXT_SECRET_SENTINEL", serialized)
        self.assertNotIn("PARENT_TAG_SECRET_SENTINEL", serialized)


if __name__ == "__main__":
    unittest.main()
