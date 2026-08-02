from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from api.main import app
from project_context import create_workspace_book


class ProjectAssetsApiTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.books_root = Path(self.temp_dir.name) / "books"
        self.book = create_workspace_book("Assets Test", books_root=self.books_root)
        self.project_ref = f"book:{self.book.book_id}"
        self.client = TestClient(app)
        self.resolve_patcher = patch(
            "file_manager.resolve_project_context",
            return_value=self.book,
        )
        self.resolve_patcher.start()

    def tearDown(self):
        self.resolve_patcher.stop()
        self.client.close()
        self.temp_dir.cleanup()

    def _outline_url(self) -> str:
        return f"/api/projects/{self.project_ref}/assets/outline"

    def _characters_url(self) -> str:
        return f"/api/projects/{self.project_ref}/assets/characters"

    def test_outline_not_generated_returns_404(self):
        response = self.client.get(self._outline_url())
        self.assertEqual(response.status_code, 404, response.text)
        payload = response.json()
        self.assertEqual(payload["error"]["code"], "outline_not_found")

    def test_characters_not_generated_returns_404(self):
        response = self.client.get(self._characters_url())
        self.assertEqual(response.status_code, 404, response.text)
        payload = response.json()
        self.assertEqual(payload["error"]["code"], "characters_not_found")

    def test_outline_returns_content(self):
        (self.book.project_dir / "novel_outline.md").write_text("# 总纲\n\n## 主要人物\n\n- **林雾**：主角。\n", encoding="utf-8")
        response = self.client.get(self._outline_url())
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertTrue(payload["ok"])
        self.assertIn("林雾", payload["content"])
        self.assertIn("总纲", payload["content"])

    def test_characters_returns_content(self):
        (self.book.project_dir / "characters.md").write_text("# 人物设定表\n\n- 林雾：主角。\n", encoding="utf-8")
        response = self.client.get(self._characters_url())
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertTrue(payload["ok"])
        self.assertIn("林雾", payload["content"])


if __name__ == "__main__":
    unittest.main()
