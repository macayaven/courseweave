"""Behavior tests for the Task 0 walking skeleton.

These tests pin the minimum coherent CourseWeave service before any of it is
implemented:

- ``create_app()`` exposes ``GET /api/health`` guarded by the per-launch
  capability token (``Authorization: Bearer <token>``) and rejects missing or
  wrong tokens with the normative error envelope from ``docs/contracts/api.md``.
- ``/learn/`` serves the static learner placeholder without a token: only
  ``/api/*`` requires the bearer token; the application shell is public.
"""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from courseweave.api import create_app

VALID_TOKEN = "test-capability-token-0123456789"


def _client(tmp_path: Path, **kwargs) -> tuple[TestClient, str]:
    app = create_app(tmp_path, **kwargs)
    return TestClient(app), app.state.capability_token


class TestHealthAuthentication:
    def test_missing_token_is_rejected(self, tmp_path: Path) -> None:
        client, _ = _client(tmp_path)
        response = client.get("/api/health")
        assert response.status_code == 403
        body = response.json()
        assert body["code"] == "forbidden"
        assert isinstance(body["message"], str) and body["message"]
        assert body["details"] == {}

    def test_wrong_token_is_rejected(self, tmp_path: Path) -> None:
        client, _ = _client(tmp_path)
        response = client.get(
            "/api/health", headers={"Authorization": "Bearer not-the-token"}
        )
        assert response.status_code == 403
        assert response.json()["code"] == "forbidden"

    def test_malformed_authorization_header_is_rejected(self, tmp_path: Path) -> None:
        client, token = _client(tmp_path)
        for header in (token, f"Basic {token}", f"Bearer  {token}"):
            response = client.get("/api/health", headers={"Authorization": header})
            assert response.status_code == 403, header

    def test_valid_token_is_accepted(self, tmp_path: Path) -> None:
        client, token = _client(tmp_path)
        response = client.get(
            "/api/health", headers={"Authorization": f"Bearer {token}"}
        )
        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "ok"
        assert body["service"] == "courseweave"

    def test_explicit_capability_token_is_honored(self, tmp_path: Path) -> None:
        client, token = _client(tmp_path, capability_token=VALID_TOKEN)
        assert token == VALID_TOKEN
        response = client.get(
            "/api/health", headers={"Authorization": f"Bearer {VALID_TOKEN}"}
        )
        assert response.status_code == 200

    def test_generated_capability_tokens_are_per_launch(self, tmp_path: Path) -> None:
        _, token_a = _client(tmp_path)
        _, token_b = _client(tmp_path)
        assert token_a and token_b and token_a != token_b


class TestLearnPlaceholder:
    def test_learn_served_without_token(self, tmp_path: Path) -> None:
        client, _ = _client(tmp_path)
        response = client.get("/learn/")
        assert response.status_code == 200
        assert "text/html" in response.headers["content-type"]
        assert "CourseWeave" in response.text

    def test_learn_index_is_the_placeholder_shell(self, tmp_path: Path) -> None:
        client, _ = _client(tmp_path)
        response = client.get("/learn/")
        assert response.status_code == 200
        assert "CourseWeave Learn" in response.text
