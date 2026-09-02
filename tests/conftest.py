"""Test-wide safeguards for model-provider traffic.

Provider adapter tests use local loopback stub servers.  A real OpenAI or
Anthropic endpoint is always a test failure, even when a test accidentally
inherits credentials from the developer environment.
"""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def block_real_model_providers(monkeypatch: pytest.MonkeyPatch) -> None:
    """Reject direct traffic to the two hosted provider domains."""
    import httpx
    import httpx2

    for client_type in (httpx.AsyncClient, httpx2.AsyncClient):
        original_send = client_type.send

        async def guarded_send(self, request, *args, _send=original_send, **kwargs):
            if request.url.host in {"api.openai.com", "api.anthropic.com"}:
                raise AssertionError("Tests must not call a real model provider")
            return await _send(self, request, *args, **kwargs)

        monkeypatch.setattr(client_type, "send", guarded_send)
