from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))

from server.services import ai_provider  # noqa: E402
from server.services.ai_provider import (  # noqa: E402
    REASONING_RETRY_EXTRA_TOKENS,
    AIProviderConfig,
    call_chat_completion,
    call_plain_chat,
    completion_problem,
    get_ai_providers,
    split_thinking,
)


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

    def test_background_model_goes_first_for_background_jobs(self) -> None:
        with patch.dict(os.environ, {
            "MEMENTO_AI_API_KEY": "primary-key",
            "MEMENTO_AI_MODEL": "glm-5.2",
            "MEMENTO_AI_BACKGROUND_MODEL": "deepseek-v4.1-flash",
        }, clear=True):
            background = get_ai_providers(background=True)
            self.assertEqual([p.model for p in background][:3], ["deepseek-v4.1-flash", "glm-5.2", "qwen3.8-27b"])
            self.assertEqual(background[0].api_key, "primary-key")
            self.assertEqual(get_ai_providers()[0].model, "glm-5.2")  # interactive calls unchanged

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


def _completion(content: str | None, finish: str = "stop", reasoning: str | None = None, tool_calls=None) -> dict:
    msg: dict = {"role": "assistant", "content": content}
    if reasoning is not None:
        msg["reasoning_content"] = reasoning
    if tool_calls:
        msg["tool_calls"] = tool_calls
    return {"choices": [{"message": msg, "finish_reason": finish}], "usage": {}}


class _FakeResponse:
    def __init__(self, payload: dict, status_code: int = 200) -> None:
        self.status_code = status_code
        self._payload = payload
        self.text = json.dumps(payload)

    def json(self) -> dict:
        return self._payload


def _fake_client(responses: list[dict], calls: list[tuple[str, dict]]):
    class FakeClient:
        def __init__(self, *args, **kwargs) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc) -> None:
            return None

        async def post(self, url: str, headers=None, json=None):
            calls.append((url, json))
            item = responses.pop(0) if len(responses) > 1 else (responses[0] if responses else ({"error": "empty"}, 500))
            if isinstance(item, tuple):
                return _FakeResponse(item[0], status_code=item[1])
            return _FakeResponse(item)

    return FakeClient


class CompletionProblemTests(unittest.TestCase):
    def test_answer_is_fine(self) -> None:
        self.assertIsNone(completion_problem(_completion("### 沟通\n- 始终用中文回复")))

    def test_tool_calls_without_content_are_fine(self) -> None:
        self.assertIsNone(completion_problem(_completion(None, tool_calls=[{"id": "t1"}])))

    def test_reasoning_ran_out_of_tokens(self) -> None:
        data = _completion("", finish="length", reasoning="让我先想想用户的偏好……")
        self.assertEqual(completion_problem(data), "reasoning_exhausted")

    def test_inline_think_cut_off(self) -> None:
        self.assertEqual(completion_problem(_completion("<think>还在想", finish="length")), "reasoning_exhausted")

    def test_plain_length_cut_is_callers_cap(self) -> None:
        self.assertIsNone(completion_problem(_completion("被截断的回答", finish="length")))

    def test_empty_answer(self) -> None:
        self.assertEqual(completion_problem(_completion("<think>想完了</think>")), "empty")
        self.assertEqual(completion_problem({"choices": []}), "empty")


class CallChatCompletionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        ai_provider._THINKING_SWITCH_REJECTED.clear()
        recorder = patch("server.services.ai_provider.ai_health.record_call", new=AsyncMock())
        self.recorded = recorder.start()
        self.addCleanup(recorder.stop)
        sleep_patch = patch("server.services.ai_provider.asyncio.sleep", new_callable=AsyncMock)
        self.sleep_mock = sleep_patch.start()
        self.addCleanup(sleep_patch.stop)

    def outcomes(self) -> list[str]:
        return [c.args[1] for c in self.recorded.await_args_list]

    async def test_retries_with_more_tokens_when_reasoning_exhausts_budget(self) -> None:
        calls: list[tuple[str, dict]] = []
        responses = [
            _completion("", finish="length", reasoning="思考……"),
            _completion("### 沟通\n- 始终用中文回复", reasoning="思考……"),
        ]
        providers = [AIProviderConfig("primary", "https://a.example/v1", "k1", "m1")]
        with patch("server.services.ai_provider.get_ai_providers", return_value=providers), \
                patch("server.services.ai_provider.httpx.AsyncClient", _fake_client(responses, calls)):
            data, used = await call_chat_completion([{"role": "user", "content": "hi"}], max_tokens=1500)
        self.assertEqual(used.name, "primary")
        self.assertEqual([body["max_tokens"] for _, body in calls], [1500, 1500 + REASONING_RETRY_EXTRA_TOKENS])
        self.assertEqual(self.outcomes(), ["ok"])
        self.assertEqual(self.recorded.await_args.kwargs["failures"][0]["reason"], "reasoning_retry")
        self.assertEqual(data["choices"][0]["message"]["content"], "### 沟通\n- 始终用中文回复")

    async def test_empty_answer_falls_through_to_next_provider(self) -> None:
        calls: list[tuple[str, dict]] = []
        responses = [_completion(""), _completion("ok")]
        providers = [
            AIProviderConfig("primary", "https://a.example/v1", "k1", "m1"),
            AIProviderConfig("backup", "https://b.example/v1", "k2", "m2"),
        ]
        with patch("server.services.ai_provider.get_ai_providers", return_value=providers), \
                patch("server.services.ai_provider.httpx.AsyncClient", _fake_client(responses, calls)):
            text = await call_plain_chat([{"role": "user", "content": "hi"}])
        self.assertEqual(text, "ok")
        self.assertEqual([url for url, _ in calls], [
            "https://a.example/v1/chat/completions",
            "https://b.example/v1/chat/completions",
        ])
        self.assertEqual(self.outcomes(), ["fallback"])
        failures = self.recorded.await_args.kwargs["failures"]
        self.assertEqual([(f["provider"], f["reason"]) for f in failures], [("primary", "empty")])

    async def test_all_providers_failing_is_recorded(self) -> None:
        calls: list[tuple[str, dict]] = []
        responses = [({"error": "busy"}, 503)]
        providers = [AIProviderConfig("primary", "https://a.example/v1", "k1", "m1")]
        with patch("server.services.ai_provider.get_ai_providers", return_value=providers), \
                patch("server.services.ai_provider.httpx.AsyncClient", _fake_client(responses, calls)):
            with self.assertRaises(RuntimeError):
                await call_chat_completion([{"role": "user", "content": "hi"}])
        self.assertEqual(self.outcomes(), ["failed"])
        self.assertEqual(self.recorded.await_args.args[0], "interactive")
        self.assertEqual(self.recorded.await_args.kwargs["failures"][0]["reason"], "server_error")

    async def test_rate_limit_503_retries_and_succeeds(self) -> None:
        calls: list[tuple[str, dict]] = []
        responses = [({"error": "busy"}, 503), _completion("hello after retry")]
        providers = [AIProviderConfig("primary", "https://a.example/v1", "k1", "m1")]
        with patch("server.services.ai_provider.get_ai_providers", return_value=providers), \
                patch("server.services.ai_provider.httpx.AsyncClient", _fake_client(responses, calls)):
            text = await call_plain_chat([{"role": "user", "content": "hi"}])
        self.assertEqual(text, "hello after retry")
        self.assertEqual(len(calls), 2)
        self.assertEqual(self.outcomes(), ["ok"])

    async def test_background_calls_switch_thinking_off(self) -> None:
        calls: list[tuple[str, dict]] = []
        providers = [AIProviderConfig("primary", "https://a.example/v1", "k1", "m1")]
        with patch("server.services.ai_provider.get_ai_providers", return_value=providers), \
                patch("server.services.ai_provider.httpx.AsyncClient", _fake_client([_completion("ok"), _completion("ok")], calls)):
            await call_plain_chat([{"role": "user", "content": "hi"}])
            await call_chat_completion([{"role": "user", "content": "hi"}])
        self.assertEqual(calls[0][1]["thinking"], {"type": "disabled"})
        self.assertNotIn("thinking", calls[1][1])  # interactive calls keep the model's default

    async def test_provider_rejecting_the_switch_is_retried_without_it_and_remembered(self) -> None:
        calls: list[tuple[str, dict]] = []
        responses = [({"error": "unknown field thinking"}, 400), _completion("ok"), _completion("again")]
        providers = [AIProviderConfig("primary", "https://a.example/v1", "k1", "m1")]
        with patch("server.services.ai_provider.get_ai_providers", return_value=providers), \
                patch("server.services.ai_provider.httpx.AsyncClient", _fake_client(responses, calls)):
            self.assertEqual(await call_plain_chat([{"role": "user", "content": "hi"}]), "ok")
            self.assertEqual(await call_plain_chat([{"role": "user", "content": "hi"}]), "again")
        self.assertEqual(["thinking" in body for _, body in calls], [True, False, False])

    async def test_unrelated_bad_request_does_not_blacklist_the_switch(self) -> None:
        calls: list[tuple[str, dict]] = []
        responses = [({"error": "context too long"}, 400), ({"error": "context too long"}, 400)]
        providers = [AIProviderConfig("primary", "https://a.example/v1", "k1", "m1")]
        with patch("server.services.ai_provider.get_ai_providers", return_value=providers), \
                patch("server.services.ai_provider.httpx.AsyncClient", _fake_client(responses, calls)):
            self.assertIsNone(await call_plain_chat([{"role": "user", "content": "hi"}]))
        self.assertEqual(len(calls), 2)
        self.assertEqual(ai_provider._THINKING_SWITCH_REJECTED, set())


if __name__ == "__main__":
    unittest.main()
