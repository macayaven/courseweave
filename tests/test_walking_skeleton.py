"""Behavior tests for the Task 0 walking skeleton.

These tests pin the minimum coherent CourseWeave service:

- ``create_app()`` exposes ``GET /api/health`` guarded by the per-launch
  capability token (``Authorization: Bearer <token>``) and rejects missing or
  wrong tokens with the normative error envelope from ``docs/contracts/api.md``.
- ``/learn/`` serves the static learner placeholder without a token: only
  ``/api/*`` requires the bearer token; the application shell is public.
- ``courseweave serve`` holds the capability token in process memory only:
  the token may arrive via the ``COURSEWEAVE_CAPABILITY_TOKEN`` environment
  seam, and it must never be written to disk or printed (SDD fix round 1).
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

from fastapi.testclient import TestClient

from courseweave.api import create_app

VALID_TOKEN = "test-capability-token-0123456789"
SERVE_ENV_TOKEN = "task0-fix-round-env-token-452cf7a9"


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


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def _request(port: int, token: str | None) -> tuple[int, bytes]:
    request = urllib.request.Request(f"http://127.0.0.1:{port}/api/health")
    if token is not None:
        request.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=2) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


class TestServeTokenCustody:
    def test_environment_token_is_used_and_never_persisted_or_printed(
        self, tmp_path: Path
    ) -> None:
        port = _free_port()
        env = {**os.environ, "COURSEWEAVE_CAPABILITY_TOKEN": SERVE_ENV_TOKEN}
        with tempfile.NamedTemporaryFile() as server_log:
            process = subprocess.Popen(
                [
                    sys.executable,
                    "-m",
                    "courseweave",
                    "serve",
                    "--course-root",
                    str(tmp_path),
                    "--port",
                    str(port),
                ],
                env=env,
                stdout=server_log,
                stderr=subprocess.STDOUT,
            )
            try:
                status: int | None = None
                deadline = time.monotonic() + 30.0
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        raise AssertionError(
                            f"serve exited early with code {process.returncode}"
                        )
                    try:
                        status, _ = _request(port, SERVE_ENV_TOKEN)
                    except (urllib.error.URLError, ConnectionError, OSError):
                        status = None
                    if status == 200:
                        break
                    time.sleep(0.2)
                assert status == 200, (
                    "service did not become healthy with the environment token"
                )
                assert _request(port, None)[0] == 403

                assert not (tmp_path / ".courseweave").exists(), (
                    "serve must not create .courseweave runtime files"
                )
                for path in sorted(p for p in tmp_path.rglob("*") if p.is_file()):
                    assert SERVE_ENV_TOKEN.encode() not in path.read_bytes(), (
                        f"capability token leaked to {path}"
                    )

                server_log.seek(0)
                assert SERVE_ENV_TOKEN.encode() not in server_log.read(), (
                    "capability token leaked to serve output"
                )
            finally:
                process.terminate()
                process.wait(timeout=10)
