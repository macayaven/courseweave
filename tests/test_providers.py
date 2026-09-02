"""Behavior tests for explicit, local-only provider adapters.

Every test uses a loopback HTTP stub.  The production defect each test catches
is stated immediately before its body so the intended behavior is independent
of the adapter implementation.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
import httpx
import httpx2
from typer.testing import CliRunner

from courseweave.cli import app
from courseweave.providers import ProviderConfig, create_model


class _StubHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self) -> None:  # noqa: N802 - HTTP handler API
        self.server.requests.append(  # type: ignore[attr-defined]
            {
                "path": self.path,
                "headers": dict(self.headers),
                "body": json.loads(self.rfile.read(int(self.headers["content-length"]))),
            }
        )
        mode = self.server.mode  # type: ignore[attr-defined]
        if mode == "auth_failure":
            self._send(401, {"error": {"message": "bad key secret-test-key"}})
        elif mode == "unsupported":
            self._send(400, {"error": {"message": "tool calling unsupported"}})
        elif mode == "malformed":
            self._raw(200, b"not-json")
        elif mode == "timeout":
            time.sleep(0.2)
        elif self.path.split("?", 1)[0] == "/v1/chat/completions":
            if self.server.requests[-1]["body"]["stream"]:  # type: ignore[attr-defined]
                self._sse(
                    'data: {"choices":[{"delta":{"content":"hello "}}]}\n\n'
                    'data: {"choices":[{"delta":{"content":"world"},"finish_reason":"stop"}]}\n\n'
                    "data: [DONE]\n\n"
                )
            else:
                self._send(
                    200,
                    {
                        "id": "chatcmpl-stub",
                        "object": "chat.completion",
                        "created": 1,
                        "model": "stub-model",
                        "choices": [{"index": 0, "message": {"role": "assistant", "content": "hello"}, "finish_reason": "stop"}],
                        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
                    },
                )
            
        elif self.path.split("?", 1)[0] == "/v1/messages":
            if self.server.requests[-1]["body"]["stream"]:  # type: ignore[attr-defined]
                self._sse(
                    'event: message_start\n'
                    'data: {"type":"message_start","message":{"id":"msg-stub","type":"message","role":"assistant","model":"stub-model","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n'
                    'event: content_block_start\n'
                    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'
                    'event: content_block_delta\n'
                    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello world"}}\n\n'
                    'event: content_block_stop\n'
                    'data: {"type":"content_block_stop","index":0}\n\n'
                    'event: message_delta\n'
                    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}\n\n'
                    'event: message_stop\n'
                    'data: {"type":"message_stop"}\n\n'
                )
            else:
                self._send(
                    200,
                    {"id": "msg-stub", "type": "message", "role": "assistant", "model": "stub-model", "content": [{"type": "text", "text": "hello"}], "stop_reason": "end_turn", "stop_sequence": None, "usage": {"input_tokens": 1, "output_tokens": 1}},
                )
        else:
            self._send(404, {"error": "unexpected path"})

    def log_message(self, _format: str, *_args: object) -> None:
        pass

    def _send(self, status: int, body: object) -> None:
        self._raw(status, json.dumps(body).encode())

    def _raw(self, status: int, body: bytes) -> None:
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _sse(self, body: str) -> None:
        encoded = body.encode()
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


@contextmanager
def provider_stub(mode: str = "ok") -> Iterator[ThreadingHTTPServer]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), _StubHandler)
    server.requests = []  # type: ignore[attr-defined]
    server.mode = mode  # type: ignore[attr-defined]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        thread.join()
        server.server_close()


def config(provider: str, base_url: str, **overrides: object) -> ProviderConfig:
    values = {
        "COURSEWEAVE_PROVIDER": provider,
        f"{provider.upper()}_MODEL": "stub-model",
        f"{provider.upper()}_BASE_URL": base_url,
        f"{provider.upper()}_API_KEY": "secret-test-key",
    }
    values.update(overrides)
    return ProviderConfig.from_mapping(values)


def stub_base_url(provider: str, server: ThreadingHTTPServer) -> str:
    root = f"http://127.0.0.1:{server.server_port}"
    return f"{root}/v1" if provider == "openai" else root


@pytest.mark.parametrize("provider,path", [("openai", "/v1/chat/completions"), ("anthropic", "/v1/messages")])
def test_custom_base_url_routes_each_provider_to_its_local_protocol(provider: str, path: str) -> None:
    # Defect caught: provider construction ignores the explicit custom base URL.
    with provider_stub() as server:
        result = create_model(config(provider, stub_base_url(provider, server)))
        response = result.adapter.complete_sync("Say hello")
    assert response.status == "ok"
    assert response.content == "hello"
    assert server.requests[0]["path"].split("?", 1)[0] == path  # type: ignore[attr-defined]


@pytest.mark.parametrize("provider", ["openai", "anthropic"])
def test_each_provider_streams_from_its_local_stub(provider: str) -> None:
    # Defect caught: streaming bypasses the configured model adapter or loses text deltas.
    with provider_stub() as server:
        result = create_model(config(provider, stub_base_url(provider, server)))
        response = result.adapter.complete_sync("Say hello", stream=True)
    assert response.status == "ok"
    assert response.content == "hello world"
    assert server.requests[0]["body"]["stream"] is True  # type: ignore[attr-defined]


@pytest.mark.parametrize("provider", ["openai", "anthropic"])
def test_authentication_failure_is_typed_and_redacted(provider: str) -> None:
    # Defect caught: upstream authentication details leak through a provider error.
    with provider_stub("auth_failure") as server:
        result = create_model(config(provider, stub_base_url(provider, server)))
        response = result.adapter.complete_sync("Say hello")
    assert response.status == "provider_error"
    assert response.failure.kind == "authentication"
    assert "secret-test-key" not in response.failure.message
    assert "secret-test-key" not in repr(response)


@pytest.mark.parametrize("provider", ["openai", "anthropic"])
def test_timeout_is_typed_and_redacted(provider: str) -> None:
    # Defect caught: a provider timeout crashes instead of producing a safe provider result.
    with provider_stub("timeout") as server:
        result = create_model(config(provider, stub_base_url(provider, server), timeout_seconds=0.01))
        response = result.adapter.complete_sync("Say hello")
    assert response.status == "provider_error"
    assert response.failure.kind == "timeout"
    assert "secret-test-key" not in response.failure.message


@pytest.mark.parametrize("provider", ["openai", "anthropic"])
def test_malformed_provider_response_is_typed_and_redacted(provider: str) -> None:
    # Defect caught: malformed upstream JSON escapes as an untyped exception.
    with provider_stub("malformed") as server:
        result = create_model(config(provider, stub_base_url(provider, server)))
        response = result.adapter.complete_sync("Say hello")
    assert response.status == "provider_error"
    assert response.failure.kind == "malformed_response"
    assert "secret-test-key" not in response.failure.message


@pytest.mark.parametrize("provider", ["openai", "anthropic"])
def test_unsupported_provider_behavior_is_typed_and_redacted(provider: str) -> None:
    # Defect caught: an unsupported upstream capability escapes as an untyped error.
    with provider_stub("unsupported") as server:
        result = create_model(config(provider, stub_base_url(provider, server)))
        response = result.adapter.complete_sync("Say hello")
    assert response.status == "provider_error"
    assert response.failure.kind == "unsupported"
    assert "secret-test-key" not in response.failure.message


def test_missing_configuration_is_a_structured_not_configured_result() -> None:
    # Defect caught: incomplete environment configuration raises while the course should remain usable.
    result = create_model(ProviderConfig.from_mapping({"COURSEWEAVE_PROVIDER": "openai"}))
    assert result.status == "not_configured"
    assert result.adapter is None
    assert result.missing == ("OPENAI_MODEL", "OPENAI_API_KEY")


@pytest.mark.parametrize(
    "client_module,provider_host",
    [(httpx, "api.openai.com"), (httpx2, "api.anthropic.com")],
)
def test_global_provider_guard_blocks_each_hosted_provider_async(
    client_module, provider_host: str
) -> None:
    # Defect caught: either provider's async SDK client can reach its hosted endpoint.
    async def request_hosted_endpoint() -> None:
        async with client_module.AsyncClient() as client:
            await client.get(f"https://{provider_host}/v1/models")

    with pytest.raises(AssertionError, match="loopback-only"):
        asyncio.run(request_hosted_endpoint())


@pytest.mark.parametrize("client_module", [httpx, httpx2])
def test_global_provider_guard_blocks_non_loopback_custom_endpoint_sync(
    client_module,
) -> None:
    # Defect caught: a synchronous SDK path can send a custom remote base URL.
    transport = client_module.MockTransport(lambda _request: client_module.Response(200))
    with client_module.Client(transport=transport) as client:
        with pytest.raises(AssertionError, match="loopback-only"):
            client.get("https://custom-provider.invalid/v1/models")


@pytest.mark.parametrize("client_module", [httpx, httpx2])
def test_global_provider_guard_blocks_non_loopback_custom_endpoint_async(
    client_module,
) -> None:
    # Defect caught: an async SDK path can send a custom remote base URL.
    transport = client_module.MockTransport(lambda _request: client_module.Response(200))

    async def request_custom_endpoint() -> None:
        async with client_module.AsyncClient(transport=transport) as client:
            await client.get("https://custom-provider.invalid/v1/models")

    with pytest.raises(AssertionError, match="loopback-only"):
        asyncio.run(request_custom_endpoint())


def test_doctor_redacts_provider_credentials(tmp_path) -> None:
    # Defect caught: diagnostic output prints a credential value.
    runner = CliRunner()
    result = runner.invoke(
        app,
        ["doctor", "--course-root", str(tmp_path)],
        env={
            "COURSEWEAVE_PROVIDER": "openai",
            "OPENAI_MODEL": "gpt-stub",
            "OPENAI_BASE_URL": "http://127.0.0.1:9999/v1",
            "OPENAI_API_KEY": "secret-test-key",
        },
    )
    assert result.exit_code == 0
    assert "provider: openai" in result.output
    assert "model: gpt-stub" in result.output
    assert "base_url: SET" in result.output
    assert "credential: SET" in result.output
    assert "secret-test-key" not in result.output
