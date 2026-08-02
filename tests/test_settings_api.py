from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from api.main import app
import config_manager


class SettingsApiTests(unittest.TestCase):
    def setUp(self):
        # 用临时 .env 目录隔离，避免污染真实 .env
        self.temp_dir = tempfile.TemporaryDirectory()
        self.fake_env = Path(self.temp_dir.name) / ".env"
        self.fake_env.write_text(
            "DEEPSEEK_API_KEY=sk-valid_key_1234567890123456\n"
            "DEFAULT_MODEL=deepseek-v4-flash\n"
            "DEEPSEEK_BASE_URL=https://api.deepseek.com\n",
            encoding="utf-8",
        )
        self.client = TestClient(app)
        self.env_patcher = patch("config_manager.get_env_path", return_value=self.fake_env)
        self.env_patcher.start()

    def tearDown(self):
        self.env_patcher.stop()
        # 清理 update_env_value 写入的进程环境变量，避免测试间泄漏
        import os

        os.environ.pop("DEEPSEEK_API_KEY", None)
        os.environ.pop("DEFAULT_MODEL", None)
        os.environ.pop("DEEPSEEK_BASE_URL", None)
        self.client.close()
        self.temp_dir.cleanup()

    def test_get_status_does_not_leak_key(self):
        response = self.client.get("/api/settings/api-config")
        self.assertEqual(response.status_code, 200, response.text)
        body = response.text
        self.assertNotIn("sk-", body, "响应不应包含明文 API Key")
        payload = response.json()
        self.assertTrue(payload["configured"])
        self.assertEqual(payload["source"], ".env")

    def test_save_without_key_preserves_existing(self):
        # require_api_key=false：留空 Key 允许只改模型/Base URL（保留现有 Key）
        response = self.client.post(
            "/api/settings/api-config",
            json={"api_key": "", "default_model": "deepseek-v4-pro", "base_url": "", "require_api_key": False},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["ok"])
        env_text = self.fake_env.read_text(encoding="utf-8")
        self.assertIn("sk-valid_key_1234567890123456", env_text, "现有 Key 应保留")

    def test_save_with_valid_key(self):
        response = self.client.post(
            "/api/settings/api-config",
            json={"api_key": "sk-new_key_9876543210987654", "default_model": "deepseek-v4-flash", "base_url": ""},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["ok"])
        env_text = self.fake_env.read_text(encoding="utf-8")
        self.assertIn("sk-new_key_9876543210987654", env_text)

    def test_save_with_weak_key_rejected(self):
        response = self.client.post(
            "/api/settings/api-config",
            json={"api_key": "abc123", "default_model": "deepseek-v4-flash", "base_url": ""},
        )
        self.assertEqual(response.status_code, 400, response.text)
        payload = response.json()
        self.assertEqual(payload["error"]["code"], "api_config_invalid")

    def test_save_with_placeholder_rejected(self):
        response = self.client.post(
            "/api/settings/api-config",
            json={"api_key": "your_api_key_here", "default_model": "deepseek-v4-flash", "base_url": ""},
        )
        self.assertEqual(response.status_code, 400, response.text)

    def test_save_without_key_and_no_existing_rejected(self):
        # 没有任何 Key 且留空 → 应拒绝
        self.fake_env.write_text(
            "DEEPSEEK_API_KEY=\nDEFAULT_MODEL=deepseek-v4-flash\nDEEPSEEK_BASE_URL=https://api.deepseek.com\n",
            encoding="utf-8",
        )
        response = self.client.post(
            "/api/settings/api-config",
            json={"api_key": "", "default_model": "deepseek-v4-flash", "base_url": "", "require_api_key": False},
        )
        self.assertEqual(response.status_code, 400, response.text)

    def test_test_connection_endpoint(self):
        with patch("api.routers.settings.test_api_connection", return_value=(True, "连接成功")) as mock_test:
            response = self.client.post(
                "/api/settings/api-config/test",
                json={"api_key": "sk-test_connection_key_12345678", "model": "deepseek-v4-flash"},
            )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["ok"])
        mock_test.assert_called_once()


if __name__ == "__main__":
    unittest.main()
