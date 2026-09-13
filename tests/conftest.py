"""Test-wide safeguards for model-provider traffic.

Provider adapter tests use local loopback stub servers.  A real OpenAI or
Anthropic endpoint is always a test failure, even when a test accidentally
inherits credentials from the developer environment.
"""

from __future__ import annotations

import ipaddress

import pytest


@pytest.fixture(autouse=True)
def block_real_model_providers(monkeypatch: pytest.MonkeyPatch) -> None:
    """Allow HTTP client traffic only to loopback or in-process test transports."""
    import httpx
    import httpx2

    def allow_request(client, request) -> bool:
        if type(getattr(client, "_transport", None)).__module__.startswith(
            ("starlette.testclient", "httpx._transports.asgi")
        ):
            return True
        host = request.url.host
        if host == "localhost":
            return True
        try:
            return ipaddress.ip_address(host).is_loopback
        except ValueError:
            return False

    def guarded_async_send(original_send):
        async def send(self, request, *args, **kwargs):
            if not allow_request(self, request):
                raise AssertionError("Tests use loopback-only HTTP transport")
            return await original_send(self, request, *args, **kwargs)

        return send

    def guarded_sync_send(original_send):
        def send(self, request, *args, **kwargs):
            if not allow_request(self, request):
                raise AssertionError("Tests use loopback-only HTTP transport")
            return original_send(self, request, *args, **kwargs)

        return send

    for client_type in (httpx.AsyncClient, httpx2.AsyncClient):
        original_send = client_type.send
        monkeypatch.setattr(client_type, "send", guarded_async_send(original_send))
    for client_type in (httpx.Client, httpx2.Client):
        original_send = client_type.send
        monkeypatch.setattr(client_type, "send", guarded_sync_send(original_send))

@pytest.fixture(autouse=True)
def isolated_personal_state(tmp_path, monkeypatch):
    monkeypatch.setenv('COURSEWEAVE_STATE_HOME', str(tmp_path.parent / ('personal-state-' + tmp_path.name)))
