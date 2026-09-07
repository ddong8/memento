from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))

from server.services.ai_provider import get_ai_providers, AIProviderConfig, split_thinking  # noqa: E402


class AIProviderTests(unittest.TestCase):
    def test_split_thinking_with_think_tags(self) -> None:
        raw = "<think>Here is some internal thinking\nAnalyzing query...</think>Here is the final answer."
        thinking, content = split_thinking(raw)
        self.assertEqual(thinking, "Here is some internal thinking\nAnalyzing query...")
        self.assertEqual(content, "Here is the final answer.")

    def test_split_thinking_with_reasoning_param(self) -> None:
        thinking, content = split_thinking("Actual response", reasoning_content="Internal chain of thought")
        self.assertEqual(thinking, "Internal chain of thought")
        self.assertEqual(content, "Actual response")

    def test_split_thinking_unclosed_tag(self) -> None:
        raw = "<think>Still thinking and no closing tag"
        thinking, content = split_thinking(raw)
        self.assertEqual(thinking, "Still thinking and no closing tag")
        self.assertEqual(content, "")

    def test_default_fallback_provider_included(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            providers = get_ai_providers()
            # Without primary MEMENTO_AI_API_KEY, default fallback is present
            self.assertTrue(any(p.name == "oneapi_fallback" for p in providers))
            fallback = next(p for p in providers if p.name == "oneapi_fallback")
            self.assertEqual(fallback.base_url, "https://oneapi.aiphacas.com/v1")
            self.assertEqual(fallback.model, "qwen3.8-27b")

    def test_primary_and_fallback_priority_order(self) -> None:
        with patch.dict(os.environ, {
            "MEMENTO_AI_API_KEY": "primary-key-123",
            "MEMENTO_AI_BASE_URL": "https://coding.dashscope.aliyuncs.com/v1",
            "MEMENTO_AI_MODEL": "kimi-k2.5",
        }, clear=True):
            providers = get_ai_providers()
            self.assertGreaterEqual(len(providers), 2)
            self.assertEqual(providers[0].name, "primary")
            self.assertEqual(providers[0].api_key, "primary-key-123")
            self.assertEqual(providers[0].model, "kimi-k2.5")
            self.assertEqual(providers[1].name, "oneapi_fallback")
            self.assertEqual(providers[1].model, "qwen3.8-27b")

    def test_custom_providers_json(self) -> None:
        extra_json = json.dumps([
            {"name": "custom_backup", "base_url": "https://api.openai.com/v1", "api_key": "sk-custom", "model": "gpt-4o"}
        ])
        with patch.dict(os.environ, {
            "MEMENTO_AI_API_KEY": "primary-key",
            "MEMENTO_AI_PROVIDERS": extra_json,
        }, clear=True):
            providers = get_ai_providers()
            names = [p.name for p in providers]
            self.assertIn("primary", names)
            self.assertIn("oneapi_fallback", names)
            self.assertIn("custom_backup", names)
            custom = next(p for p in providers if p.name == "custom_backup")
            self.assertEqual(custom.model, "gpt-4o")


if __name__ == "__main__":
    unittest.main()
