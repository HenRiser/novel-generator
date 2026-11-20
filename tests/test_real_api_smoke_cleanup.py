import io
import shutil
import unittest
from contextlib import ExitStack, redirect_stdout
from functools import partial
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from fastapi.testclient import TestClient

import real_api_test as smoke
from api.main import app
from services.project_service import create_workspace_project


class SmokeCleanupTests(unittest.TestCase):
    def setUp(self):
        stack = ExitStack()
        self.addCleanup(stack.close)
        root = Path(stack.enter_context(TemporaryDirectory()))
        self.books = root / "books"
        self.books.mkdir()
        self.sentinel = self.books / "keep.txt"
        self.sentinel.write_text("existing data", encoding="utf-8")
        stack.enter_context(patch("project_context.BOOKS_DIR", self.books))
        stack.enter_context(patch("project_context.OUTPUT_DIR", root / "outputs"))
        stack.enter_context(patch("api.routers.projects.create_workspace_project",
                                  partial(create_workspace_project, books_root=self.books)))
        stack.enter_context(patch("api.main.PUBLIC_MODE", False))
        stack.enter_context(patch.multiple(smoke, PASS=0, FAIL=0, FAILURES=[]))
        stack.enter_context(redirect_stdout(io.StringIO()))
        client = stack.enter_context(TestClient(app))

        def local_request(method, path, body=None):
            response = client.request(method, path, json=body)
            return response.status_code, response.json()

        # A regression must never let this test delete the root or leave its temporary book library.
        rmtree = shutil.rmtree

        def remove_test_book(path, **kwargs):
            self.assertEqual(Path(path).resolve().parent, self.books)
            return rmtree(path, **kwargs)

        self.remove = stack.enter_context(patch("shutil.rmtree", side_effect=remove_test_book))
        self.req = stack.enter_context(patch.object(smoke, "req", side_effect=local_request))
        self.exercise = stack.enter_context(patch.object(smoke, "exercise_project"))

    def test_success_deletes_only_the_book_created_by_this_run(self):
        self.assertEqual(smoke.main(), 0)
        ref = self.exercise.call_args.args[0]
        self.remove.assert_called_once()
        self.assertEqual(Path(self.remove.call_args.args[0]), self.books / ref.removeprefix("book:"))
        self.assertEqual(list(self.books.iterdir()), [self.sentinel])

    def test_nonempty_library_aborts_before_creation(self):
        self.req("POST", "/api/projects", {"title": "保留的作品", "seed_prompt": "示例"})
        self.req.reset_mock()
        self.assertEqual(smoke.main(), 1)
        self.assertEqual([c.args[0] for c in self.req.call_args_list], ["GET", "GET"])
        self.exercise.assert_not_called()
        self.remove.assert_not_called()

    def test_failed_creation_or_invalid_ref_stops_before_project_requests(self):
        for status, ref in ((400, None), (200, ""), (200, "book:"), (200, "book:.."),
                            (200, "legacy:other"), (200, "book:bk_20261121_010203_00112233/..")):
            with self.subTest(status=status, ref=ref):
                def request(method, path, body=None):
                    if path == "/api/health":
                        return 200, {"status": "ok"}
                    self.assertEqual(path, "/api/projects")
                    if method == "GET":
                        return 200, []
                    self.assertEqual(method, "POST")
                    return status, {"ok": status == 200, "title": body["title"], "project_ref": ref}

                self.req.side_effect = request
                self.assertEqual(smoke.main(), 1)
                self.exercise.assert_not_called()
                self.remove.assert_not_called()

    def test_ownership_is_rechecked_before_deletion(self):
        local_request = self.req.side_effect

        def rename_after_exercise(method, path, body=None):
            code, data = local_request(method, path, body)
            if method == "GET" and path.startswith("/api/projects/") and self.exercise.called:
                data["title"] = "另一个项目"
            return code, data

        self.req.side_effect = rename_after_exercise
        self.assertEqual(smoke.main(), 1)
        self.exercise.assert_called_once()
        self.assertNotIn("DELETE", [c.args[0] for c in self.req.call_args_list])
        self.remove.assert_not_called()

    def test_delete_failure_preserves_the_project_for_inspection(self):
        self.remove.side_effect = PermissionError("simulated deletion failure")
        self.assertEqual(smoke.main(), 1)
        self.remove.assert_called_once()
        ref = self.exercise.call_args.args[0]
        self.assertTrue((self.books / ref.removeprefix("book:") / "book.json").is_file())
        self.assertTrue(self.sentinel.is_file())

    def test_failed_workflow_still_cleans_up_owned_project(self):
        self.exercise.side_effect = RuntimeError("simulated generation failure")
        with self.assertRaisesRegex(RuntimeError, "simulated generation failure"):
            smoke.main()
        self.assertEqual(list(self.books.iterdir()), [self.sentinel])
