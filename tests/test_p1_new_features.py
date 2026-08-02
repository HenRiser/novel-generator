from __future__ import annotations



import json

import tempfile

import unittest

from pathlib import Path

from unittest.mock import patch



from fastapi.testclient import TestClient



from api.main import app

from project_context import create_workspace_book

from services.narrative_graph_service import (

    _import_character_nodes,

    _import_world_fact_nodes,

    import_assets_to_graph,

    load_narrative_graph,

)





SAMPLE_OUTLINE = """# 小说总纲



## 一句话卖点



少女在废弃剧场地下发现会说话的镜子。



## 世界观设定



**灰剧场（舞台之下）**：废弃剧场的地下隐藏着一座完整的旧城。



**镜城规则**：镜子是城市与地面的唯一接口，镜子碎裂则通道关闭。



## 主要人物



- **林雾（十七岁）**：在剧场后台长大的少女，听觉异常敏锐。

- **老守门人（六十岁）**：剧场看门人，知道地下城的秘密，抚养林雾长大。

- **陈默（二十四岁）**：城市监测局科员，调查剧场异常信号。



## 主线冲突



林雾必须在"唤醒城市"与"维持地面稳定"之间做出选择。

"""





class ProjectDeleteApiTests(unittest.TestCase):

    def setUp(self):

        self.temp_dir = tempfile.TemporaryDirectory()

        self.books_root = Path(self.temp_dir.name) / "books"

        self.book = create_workspace_book("Delete Test", books_root=self.books_root)

        self.project_ref = f"book:{self.book.book_id}"

        self.client = TestClient(app)

        # 路由模块 import 的是 services.project_service 的函数名

        self.delete_patcher = patch(

            "api.routers.projects.delete_workspace_project",

            side_effect=self._delete_workspace_project,

        )

        self.delete_patcher.start()



    def tearDown(self):

        self.delete_patcher.stop()

        self.client.close()

        self.temp_dir.cleanup()



    def _delete_workspace_project(self, project_ref: str, **_kwargs):

        if project_ref == self.project_ref:

            return True, "Project deleted."

        return False, "Project not found."



    def test_delete_project_success(self):

        response = self.client.delete(f"/api/projects/{self.project_ref}")

        self.assertEqual(response.status_code, 200, response.text)

        payload = response.json()

        self.assertTrue(payload["ok"])

        self.assertEqual(payload["project_ref"], self.project_ref)



    def test_delete_project_not_found(self):

        response = self.client.delete("/api/projects/book:missing_123456_abcdef")

        self.assertEqual(response.status_code, 404)

        payload = response.json()

        self.assertEqual(payload["error"]["code"], "project_delete_failed")





class ContinueSaveApiTests(unittest.TestCase):

    def setUp(self):

        self.temp_dir = tempfile.TemporaryDirectory()

        self.books_root = Path(self.temp_dir.name) / "books"

        self.book = create_workspace_book("Continue Save Test", books_root=self.books_root)

        self.project_ref = f"book:{self.book.book_id}"

        self.client = TestClient(app)

        self.context_patcher = patch(

            "api.routers.continue_writing.resolve_workspace_context",

            return_value=(self.book, "", 200, ""),

        )

        self.context_patcher.start()



    def tearDown(self):

        self.context_patcher.stop()

        self.client.close()

        self.temp_dir.cleanup()



    def _save_url(self, chapter_number: int = 1) -> str:

        return f"/api/projects/{self.project_ref}/chapters/{chapter_number}/continue/save"



    def test_save_continue_append(self):

        with (

            patch("api.routers.continue_writing.read_chapter", return_value=("第一章：夜色降临。", None)),

            patch("api.routers.continue_writing.save_chapter") as mock_save,

            patch("api.routers.continue_writing.update_chapter_index") as mock_index,

        ):

            mock_save.return_value = Path("chapter_001.md")

            response = self.client.post(

                self._save_url(),

                json={"content": "她听见镜子里的声音。", "mode": "append"},

            )

        self.assertEqual(response.status_code, 200, response.text)

        payload = response.json()

        self.assertTrue(payload["ok"])

        # append 模式应合并正文

        mock_save.assert_called_once()

        merged_content = mock_save.call_args.args[2]

        self.assertIn("第一章：夜色降临。", merged_content)

        self.assertIn("她听见镜子里的声音。", merged_content)

        mock_index.assert_called_once()



    def test_save_continue_replace(self):

        with (

            patch("api.routers.continue_writing.read_chapter", return_value=("旧内容", None)),

            patch("api.routers.continue_writing.save_chapter") as mock_save,

            patch("api.routers.continue_writing.update_chapter_index"),

        ):

            mock_save.return_value = Path("chapter_001.md")

            response = self.client.post(

                self._save_url(),

                json={"content": "全新内容", "mode": "replace"},

            )

        self.assertEqual(response.status_code, 200, response.text)

        payload = response.json()

        self.assertTrue(payload["ok"])

        # replace 模式直接覆盖

        mock_save.assert_called_once()

        saved_content = mock_save.call_args.args[2]

        self.assertEqual(saved_content, "全新内容")



    def test_save_continue_empty_content_rejected(self):

        response = self.client.post(

            self._save_url(),

            json={"content": "   ", "mode": "append"},

        )

        self.assertEqual(response.status_code, 400)



    def test_save_continue_invalid_mode_rejected(self):

        response = self.client.post(

            self._save_url(),

            json={"content": "内容", "mode": "overwrite"},

        )

        # 项目统一了请求校验错误码（RequestValidationError → 400 invalid_request）

        self.assertEqual(response.status_code, 400)

        payload = response.json()

        self.assertEqual(payload["error"]["code"], "invalid_request")





class OutlineImportTests(unittest.TestCase):

    def setUp(self):

        self.temp_dir = tempfile.TemporaryDirectory()

        self.books_root = Path(self.temp_dir.name) / "books"

        self.book = create_workspace_book("Import Test", books_root=self.books_root)

        self.project_ref = f"book:{self.book.book_id}"

        self.resolve_patcher = patch(

            "services.narrative_graph_service.resolve_project_context",

            return_value=self.book,

        )

        self.resolve_patcher.start()



    def tearDown(self):

        self.resolve_patcher.stop()

        self.temp_dir.cleanup()



    def test_character_parsing(self):

        added: list[dict] = []

        skipped: list[str] = []



        def add_if_new(label, node_type, summary):

            added.append({"label": label, "type": node_type, "summary": summary})



        _import_character_nodes(SAMPLE_OUTLINE, add_if_new)

        labels = [item["label"] for item in added]

        self.assertIn("林雾", labels)

        self.assertIn("老守门人", labels)

        self.assertIn("陈默", labels)

        # 名称去年龄后缀

        self.assertTrue(all(item["type"] == "character" for item in added))

        self.assertEqual(len(added), 3)



    def test_world_fact_parsing(self):

        added: list[dict] = []

        skipped: list[str] = []



        def add_if_new(label, node_type, summary):

            added.append({"label": label, "type": node_type, "summary": summary})



        _import_world_fact_nodes(SAMPLE_OUTLINE, add_if_new)

        labels = [item["label"] for item in added]

        self.assertIn("灰剧场（舞台之下）", labels)

        self.assertIn("镜城规则", labels)

        self.assertTrue(all(item["type"] == "world_fact" for item in added))



    def test_import_assets_to_graph(self):

        # 先写入大纲文件

        outline_path = self.book.project_dir / "novel_outline.md"

        outline_path.write_text(SAMPLE_OUTLINE, encoding="utf-8")



        result = import_assets_to_graph(self.project_ref)

        self.assertTrue(result.ok, result.message)

        self.assertIsNotNone(result.graph)

        nodes = result.graph["graph"]["nodes"]

        labels = [node.get("label") for node in nodes]

        self.assertIn("林雾", labels)

        self.assertIn("灰剧场（舞台之下）", labels)

        # 节点带来源标记

        character_node = next(n for n in nodes if n.get("label") == "林雾")

        self.assertEqual(character_node["source"]["created_by"], "outline_import")



        # 幂等：再次导入应全部跳过

        result2 = import_assets_to_graph(self.project_ref)

        self.assertTrue(result2.ok, result2.message)

        self.assertIn("skipped", result2.message)



    def test_import_without_outline_fails(self):

        result = import_assets_to_graph(self.project_ref)

        self.assertFalse(result.ok)

        self.assertIn("outline", result.message.lower())



    def test_import_saves_graph_file(self):

        outline_path = self.book.project_dir / "novel_outline.md"

        outline_path.write_text(SAMPLE_OUTLINE, encoding="utf-8")



        import_assets_to_graph(self.project_ref)

        loaded = load_narrative_graph(self.project_ref)

        self.assertTrue(loaded.ok)

        labels = [node.get("label") for node in loaded.graph["graph"]["nodes"]]

        self.assertGreaterEqual(len(labels), 5)





if __name__ == "__main__":

    unittest.main()

