from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
from dataclasses import dataclass, field
from io import BytesIO
from pathlib import Path
from typing import Any

import jupyter_server
import pytest
from jinja2 import Environment, FileSystemLoader
from jupyter_server.auth.authorizer import AllowAllAuthorizer
from jupyter_server.auth.identity import IdentityProvider, PasswordIdentityProvider, User
from tornado.httpclient import HTTPRequest, HTTPResponse
from tornado.httputil import HTTPHeaders
from tornado.testing import AsyncHTTPTestCase
from tornado.web import Application

from courseweave.jupyter_runtime import (
    CONTEXT_BODY_LIMIT,
    CourseWeaveContextRelayHandler,
    CourseWeaveCourseRelayHandler,
    CourseWeaveRuntimeHandler,
    CourseWeaveReaderHandler,
    RuntimeSettings,
    _jupyter_server_extension_points,
    _load_jupyter_server_extension,
)

JUPYTER_AUTH_SENTINEL = "jupyter-auth-contract-sentinel"
COURSEWEAVE_SENTINEL = "courseweave-capability-sentinel"
RUNTIME_ID = "runtime-contract-id"
SERVICE_URL = "http://127.0.0.1:8765"
VALID_COURSE_ETAG = f'"{"a" * 64}"'


def valid_environment() -> dict[str, str]:
    return {
        "COURSEWEAVE_URL": SERVICE_URL,
        "COURSEWEAVE_CAPABILITY_TOKEN": COURSEWEAVE_SENTINEL,
        "COURSEWEAVE_RUNTIME_ID": RUNTIME_ID,
        "COURSEWEAVE_LAUNCH_MODE": "learn",
    }


def test_runtime_settings_validate_exact_owned_environment() -> None:
    settings = RuntimeSettings.from_environ(valid_environment())
    assert settings == RuntimeSettings(
        service_url=SERVICE_URL,
        capability_token=COURSEWEAVE_SENTINEL,
        runtime_id=RUNTIME_ID,
        launch_mode="learn",
    )
    assert settings.page_config == {
        "courseweaveServiceUrl": SERVICE_URL,
        "courseweaveRuntimeId": RUNTIME_ID,
        "courseweaveLaunchMode": "learn",
    }
    assert COURSEWEAVE_SENTINEL not in json.dumps(settings.page_config)


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("COURSEWEAVE_URL", ""),
        ("COURSEWEAVE_URL", " https://127.0.0.1:8765"),
        ("COURSEWEAVE_URL", "http://user:secret@127.0.0.1:8765"),
        ("COURSEWEAVE_URL", "http://127.0.0.1:8765/api"),
        ("COURSEWEAVE_URL", "http://127.0.0.1:8765?token=x"),
        ("COURSEWEAVE_URL", "http://example.test:8765"),
        ("COURSEWEAVE_CAPABILITY_TOKEN", " x "),
        ("COURSEWEAVE_CAPABILITY_TOKEN", "x" * 4097),
        ("COURSEWEAVE_RUNTIME_ID", ""),
        ("COURSEWEAVE_RUNTIME_ID", "x" * 241),
        ("COURSEWEAVE_LAUNCH_MODE", "preview"),
    ],
)
def test_runtime_settings_fail_closed_for_missing_or_invalid_values(
    key: str, value: str
) -> None:
    environment = valid_environment()
    environment[key] = value
    assert RuntimeSettings.from_environ(environment) is None

    environment = valid_environment()
    del environment[key]
    assert RuntimeSettings.from_environ(environment) is None


@dataclass
class _FakeWebApp:
    settings: dict[str, Any] = field(
        default_factory=lambda: {"page_config_data": {"token": JUPYTER_AUTH_SENTINEL}}
    )
    registrations: list[tuple[str, list[tuple[Any, ...]]]] = field(default_factory=list)

    def add_handlers(self, host_pattern: str, handlers: list[tuple[Any, ...]]) -> None:
        self.registrations.append((host_pattern, handlers))


@dataclass
class _FakeServerApp:
    identity_provider: IdentityProvider = field(default_factory=IdentityProvider)
    base_url: str = "/jupyter/base/"
    root_dir: str = "/safe/course"
    web_app: _FakeWebApp = field(default_factory=_FakeWebApp)
    log: logging.Logger = field(default_factory=lambda: logging.getLogger("courseweave-test"))
    no_browser_open_file: bool = False

    def server_info(self) -> dict[str, Any]:
        return {
            "url": "http://127.0.0.1:9999/jupyter/base/",
            "token": JUPYTER_AUTH_SENTINEL,
            "root_dir": "/safe/course",
        }


def test_extension_hooks_register_base_url_handlers_and_only_three_page_values(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for key, value in valid_environment().items():
        monkeypatch.setenv(key, value)
    serverapp = _FakeServerApp()

    assert _jupyter_server_extension_points() == [
        {"module": "courseweave.jupyter_runtime"}
    ]
    _load_jupyter_server_extension(serverapp)

    page_config = serverapp.web_app.settings["page_config_data"]
    assert page_config["token"] == JUPYTER_AUTH_SENTINEL
    assert {key for key in page_config if key.startswith("courseweave")} == {
        "courseweaveServiceUrl",
        "courseweaveRuntimeId",
        "courseweaveLaunchMode",
    }
    assert COURSEWEAVE_SENTINEL not in json.dumps(page_config)
    assert serverapp.web_app.registrations == [
        (
            ".*$",
            [
                ("/jupyter/base/courseweave/runtime", CourseWeaveRuntimeHandler),
                ("/jupyter/base/courseweave/course", CourseWeaveCourseRelayHandler),
                ("/jupyter/base/courseweave/context", CourseWeaveContextRelayHandler),
                ("/jupyter/base/courseweave/reader/(.*)", CourseWeaveReaderHandler, {"course_root":"/safe/course"}),
            ],
        )
    ]


def test_extension_prevents_jupyter_token_runtime_files_without_disabling_auth(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for key, value in valid_environment().items():
        monkeypatch.setenv(key, value)
    serverapp = _FakeServerApp()

    _load_jupyter_server_extension(serverapp)

    assert serverapp.no_browser_open_file is True
    assert serverapp.web_app.settings["page_config_data"]["token"] == JUPYTER_AUTH_SENTINEL
    assert serverapp.server_info() == {
        "url": "http://127.0.0.1:9999/jupyter/base/",
        "token": "",
        "root_dir": "/safe/course",
    }


def test_invalid_environment_registers_fail_closed_handlers_without_page_values(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for key in valid_environment():
        monkeypatch.delenv(key, raising=False)
    serverapp = _FakeServerApp()
    _load_jupyter_server_extension(serverapp)
    assert not any(
        key.startswith("courseweave")
        for key in serverapp.web_app.settings["page_config_data"]
    )
    assert serverapp.web_app.settings["courseweave_runtime_settings"] is None
    assert len(serverapp.web_app.registrations[0][1]) == 3
    assert serverapp.no_browser_open_file is False
    assert serverapp.server_info()["token"] == JUPYTER_AUTH_SENTINEL


def test_partial_supervised_environment_redacts_runtime_files_before_validation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for key in valid_environment():
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("COURSEWEAVE_RUNTIME_ID", "partial-supervised-launch")
    serverapp = _FakeServerApp()

    _load_jupyter_server_extension(serverapp)

    assert serverapp.web_app.settings["courseweave_runtime_settings"] is None
    assert serverapp.no_browser_open_file is True
    assert serverapp.server_info()["token"] == ""


def test_jupyter_server_221_selects_exact_jupyter_token_identity_contract(
    tmp_path: Path,
) -> None:
    assert jupyter_server.__version__ == "2.21.0"
    script = """
import json
import os
import jupyter_server
from jupyter_server.auth.identity import PasswordIdentityProvider
from jupyter_server.serverapp import ServerApp

app = ServerApp()
app.initialize(
    [
        '--ServerApp.open_browser=False',
        '--ServerApp.allow_root=True',
        '--ServerApp.jpserver_extensions={}',
    ],
    find_extensions=False,
    new_httpserver=False,
)
print(json.dumps({
    'version': jupyter_server.__version__,
    'provider': type(app.identity_provider).__name__,
    'password_provider': isinstance(app.identity_provider, PasswordIdentityProvider),
    'matches_environment': app.identity_provider.token == os.environ['JUPYTER_TOKEN'],
}))
"""
    environment = {
        **os.environ,
        "JUPYTER_TOKEN": JUPYTER_AUTH_SENTINEL,
        "JUPYTER_CONFIG_DIR": str(tmp_path / "config"),
        "JUPYTER_DATA_DIR": str(tmp_path / "data"),
        "JUPYTER_RUNTIME_DIR": str(tmp_path / "runtime"),
    }
    completed = subprocess.run(
        [sys.executable, "-c", script],
        env=environment,
        check=True,
        capture_output=True,
        text=True,
    )
    evidence = json.loads(completed.stdout.strip().splitlines()[-1])
    assert evidence == {
        "version": "2.21.0",
        "provider": "PasswordIdentityProvider",
        "password_provider": True,
        "matches_environment": True,
    }
    assert JUPYTER_AUTH_SENTINEL not in completed.stdout
    assert JUPYTER_AUTH_SENTINEL not in completed.stderr


def test_full_rendered_page_config_keeps_jupyter_token_but_not_courseweave_capability(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for key, value in valid_environment().items():
        monkeypatch.setenv(key, value)
    serverapp = _FakeServerApp()
    _load_jupyter_server_extension(serverapp)
    templates = Path(jupyter_server.__file__).parent.parent / "jupyterlab_server" / "templates"
    environment = Environment(loader=FileSystemLoader(templates), autoescape=True)
    rendered = environment.get_template("index.html").render(
        page_config=serverapp.web_app.settings["page_config_data"],
        base_url="/jupyter/base/",
        ws_url="",
        page_title="CourseWeave test",
        css_files=[],
        js_files=[],
    )
    assert JUPYTER_AUTH_SENTINEL in rendered
    assert COURSEWEAVE_SENTINEL not in rendered


class _TrustedIdentityProvider(IdentityProvider):
    async def get_user(self, handler: Any) -> User:
        return User("courseweave-test-user")


class _FakeFetcher:
    def __init__(self) -> None:
        self.requests: list[HTTPRequest] = []
        self.status = 200
        self.body = b"{}"
        self.headers = HTTPHeaders({"Content-Type": "application/json"})
        self.error: Exception | None = None

    def respond(
        self,
        status: int,
        body: bytes,
        headers: dict[str, str] | None = None,
    ) -> None:
        self.status = status
        self.body = body
        self.headers = HTTPHeaders(
            headers if headers is not None else {"Content-Type": "application/json"}
        )
        self.error = None

    async def fetch(
        self, request: HTTPRequest, *, raise_error: bool = False
    ) -> HTTPResponse:
        self.requests.append(request)
        if self.error is not None:
            raise self.error
        return HTTPResponse(
            request,
            self.status,
            headers=self.headers,
            buffer=BytesIO(self.body),
            effective_url=request.url,
            request_time=0.001,
        )


class TestCourseWeaveJupyterHandlers(AsyncHTTPTestCase):
    def get_app(self) -> Application:
        self.fetcher = _FakeFetcher()
        self.runtime_settings = RuntimeSettings(
            service_url=SERVICE_URL,
            capability_token=COURSEWEAVE_SENTINEL,
            runtime_id=RUNTIME_ID,
            launch_mode="learn",
        )
        identity = PasswordIdentityProvider(token=JUPYTER_AUTH_SENTINEL)
        return Application(
            [
                (r"/base/courseweave/runtime", CourseWeaveRuntimeHandler),
                (r"/base/courseweave/course", CourseWeaveCourseRelayHandler),
                (r"/base/courseweave/context", CourseWeaveContextRelayHandler),
            ],
            base_url="/base/",
            login_url="/login",
            cookie_secret=b"courseweave-test-cookie-secret-32",
            identity_provider=identity,
            authorizer=AllowAllAuthorizer(identity_provider=identity),
            token=JUPYTER_AUTH_SENTINEL,
            allow_remote_access=True,
            allow_unauthenticated_access=False,
            disable_check_xsrf=False,
            xsrf_cookies=True,
            log=logging.getLogger("courseweave-handler-test"),
            courseweave_runtime_settings=self.runtime_settings,
            courseweave_http_client=self.fetcher,
        )

    @property
    def auth_headers(self) -> dict[str, str]:
        return {"Authorization": f"token {JUPYTER_AUTH_SENTINEL}"}

    def test_runtime_requires_jupyter_auth_and_exact_runtime_id(self) -> None:
        unauthenticated = self.fetch("/base/courseweave/runtime", follow_redirects=False)
        assert unauthenticated.code == 403

        missing_id = self.fetch(
            "/base/courseweave/runtime", headers=self.auth_headers
        )
        assert missing_id.code == 403

        wrong_id = self.fetch(
            "/base/courseweave/runtime",
            headers={**self.auth_headers, "X-CourseWeave-Runtime-ID": "wrong"},
        )
        assert wrong_id.code == 403

        response = self.fetch(
            "/base/courseweave/runtime",
            headers={**self.auth_headers, "X-CourseWeave-Runtime-ID": RUNTIME_ID},
        )
        assert response.code == 200
        assert json.loads(response.body) == {
            "serviceOrigin": SERVICE_URL,
            "capabilityToken": COURSEWEAVE_SENTINEL,
        }
        assert response.headers["Cache-Control"] == "no-store"
        assert "Access-Control-Allow-Origin" not in response.headers
        assert "Access-Control-Allow-Credentials" not in response.headers

    def test_runtime_fails_closed_for_query_or_missing_settings(self) -> None:
        headers = {**self.auth_headers, "X-CourseWeave-Runtime-ID": RUNTIME_ID}
        assert self.fetch("/base/courseweave/runtime?extra=1", headers=headers).code == 400
        self._app.settings["courseweave_runtime_settings"] = None
        response = self.fetch("/base/courseweave/runtime", headers=headers)
        assert response.code == 503
        assert COURSEWEAVE_SENTINEL not in response.body.decode()

    def test_course_relay_is_exact_read_only_server_side_bearer_request(self) -> None:
        course = {"schema_version": 2, "id": "course", "title": "Course"}
        self.fetcher.respond(
            200,
            json.dumps(course).encode(),
            {"Content-Type": "application/json", "ETag": VALID_COURSE_ETAG},
        )
        response = self.fetch(
            "/base/courseweave/course", headers=self.auth_headers
        )
        assert response.code == 200
        assert json.loads(response.body) == course
        assert response.headers["ETag"] == VALID_COURSE_ETAG
        assert response.headers["Cache-Control"] == "no-store"
        assert "Access-Control-Allow-Origin" not in response.headers
        assert len(self.fetcher.requests) == 1
        upstream = self.fetcher.requests[0]
        assert upstream.url == f"{SERVICE_URL}/api/course"
        assert upstream.method == "GET"
        assert upstream.headers["Authorization"] == f"Bearer {COURSEWEAVE_SENTINEL}"
        assert self.fetch(
            "/base/courseweave/course?unexpected=1", headers=self.auth_headers
        ).code == 400
        assert self.fetch(
            "/base/courseweave/course", method="POST", headers=self.auth_headers, body="{}"
        ).code == 405

    def test_course_relay_accepts_empty_draft_etag(self) -> None:
        self.fetcher.respond(
            200,
            b'{"schema_version":2,"modules":[]}',
            {"Content-Type": "application/json", "ETag": '""'},
        )
        response = self.fetch("/base/courseweave/course", headers=self.auth_headers)
        assert response.code == 200
        assert response.headers["ETag"] == '""'

    def test_upstream_json_media_type_accepts_case_and_utf8_charset(self) -> None:
        for content_type in (
            "application/json",
            "Application/JSON; Charset=UTF-8",
            'application/json; charset="utf-8"',
        ):
            with self.subTest(content_type=content_type):
                self.fetcher.respond(
                    200,
                    b'{"schema_version":2,"modules":[]}',
                    {"Content-Type": content_type, "ETag": VALID_COURSE_ETAG},
                )
                response = self.fetch(
                    "/base/courseweave/course", headers=self.auth_headers
                )
                assert response.code == 200
                assert response.headers["ETag"] == VALID_COURSE_ETAG

    def test_valid_json_with_html_media_type_is_rejected_without_passthrough(
        self,
    ) -> None:
        upstream_marker = "upstream-html-json-marker"
        self.fetcher.respond(
            200,
            json.dumps({"message": upstream_marker}).encode(),
            {
                "Content-Type": "text/html",
                "ETag": VALID_COURSE_ETAG,
                "X-Upstream-Response": upstream_marker,
            },
        )
        response = self.fetch("/base/courseweave/course", headers=self.auth_headers)
        assert response.code == 502
        assert json.loads(response.body) == {
            "code": "invalid_relay_response",
            "message": "CourseWeave returned an invalid response.",
            "details": {},
        }
        assert upstream_marker not in response.body.decode()
        assert response.headers.get("ETag") is None
        assert response.headers.get("X-Upstream-Response") is None

    def test_upstream_json_media_type_rejects_missing_suffix_and_malformed_types(
        self,
    ) -> None:
        for content_type in (
            None,
            "application/problem+json",
            "application/jsonp",
            "application/jſon",
            "application/json; charset",
            "application/json; boundary=something",
        ):
            with self.subTest(content_type=content_type):
                headers = {"ETag": VALID_COURSE_ETAG}
                if content_type is not None:
                    headers["Content-Type"] = content_type
                self.fetcher.respond(200, b'{"safe":true}', headers)
                response = self.fetch(
                    "/base/courseweave/course", headers=self.auth_headers
                )
                assert response.code == 502
                assert response.headers.get("ETag") is None
                assert json.loads(response.body)["code"] == "invalid_relay_response"

    def test_successful_course_relay_fails_closed_for_invalid_etag(self) -> None:
        digest = "a" * 64
        for label, etag in (
            ("missing", None),
            ("malformed", '"course-etag"'),
            ("unquoted", digest),
            ("weak", f'W/"{digest}"'),
            ("newline", f'"{digest}\n"'),
            ("uppercase", f'"{"A" * 64}"'),
            ("capability", f'"{COURSEWEAVE_SENTINEL}"'),
        ):
            with self.subTest(label=label):
                headers = {"Content-Type": "application/json"}
                if etag is not None:
                    headers["ETag"] = etag
                self.fetcher.respond(200, b'{"safe":true}', headers)
                response = self.fetch(
                    "/base/courseweave/course", headers=self.auth_headers
                )
                assert response.code == 502
                assert response.headers.get("ETag") is None
                assert COURSEWEAVE_SENTINEL not in response.body.decode()
                assert json.loads(response.body)["code"] == "invalid_relay_response"

    def test_course_relay_never_copies_etag_from_error_response(self) -> None:
        conflict = {
            "code": "not_configured",
            "message": "No course root is configured.",
            "details": {},
        }
        for etag in (VALID_COURSE_ETAG, f'"{COURSEWEAVE_SENTINEL}"'):
            with self.subTest(etag=etag):
                self.fetcher.respond(
                    409,
                    json.dumps(conflict).encode(),
                    {"Content-Type": "application/json", "ETag": etag},
                )
                response = self.fetch(
                    "/base/courseweave/course", headers=self.auth_headers
                )
                assert response.code == 409
                assert json.loads(response.body) == conflict
                assert response.headers.get("ETag") is None
                assert COURSEWEAVE_SENTINEL not in response.body.decode()

    def test_context_relay_validates_exact_schema_and_preserves_safe_409(self) -> None:
        conflict = {
            "code": "stale_context",
            "message": "The context sequence is stale.",
            "details": {},
        }
        self.fetcher.respond(409, json.dumps(conflict).encode())
        context = {
            "source_id": "source-1",
            "sequence": 0,
            "active_path": None,
            "active_cell_id": None,
            "active_cell_tags": [],
            "surface_kind": None,
            "explicit_module_id": None,
            "explicit_phase_id": None,
            "video_seconds": None,
            "terminal_surface_id": None,
        }
        response = self.fetch(
            "/base/courseweave/context",
            method="POST",
            headers={**self.auth_headers, "Content-Type": "application/json"},
            body=json.dumps(context),
        )
        assert response.code == 409
        assert json.loads(response.body) == conflict
        assert response.headers["Cache-Control"] == "no-store"
        assert "Access-Control-Allow-Origin" not in response.headers
        upstream = self.fetcher.requests[0]
        assert upstream.url == f"{SERVICE_URL}/api/context"
        assert upstream.method == "POST"
        assert upstream.headers["Authorization"] == f"Bearer {COURSEWEAVE_SENTINEL}"
        assert json.loads(upstream.body or b"") == context

        before = len(self.fetcher.requests)
        malformed = self.fetch(
            "/base/courseweave/context",
            method="POST",
            headers={**self.auth_headers, "Content-Type": "application/json"},
            body=json.dumps({**context, "selection": "automatic content"}),
        )
        assert malformed.code == 422
        assert len(self.fetcher.requests) == before

    def test_context_relay_caps_body_before_parsing(self) -> None:
        response = self.fetch(
            "/base/courseweave/context",
            method="POST",
            headers={**self.auth_headers, "Content-Type": "application/json"},
            body=b"x" * (CONTEXT_BODY_LIMIT + 1),
        )
        assert response.code == 413
        assert self.fetcher.requests == []

    def test_context_post_uses_jupyter_xsrf_conventions(self) -> None:
        trusted = _TrustedIdentityProvider()
        self._app.settings["identity_provider"] = trusted
        self._app.settings["authorizer"] = AllowAllAuthorizer(identity_provider=trusted)
        response = self.fetch(
            "/base/courseweave/context",
            method="POST",
            headers={"Content-Type": "application/json"},
            body="{}",
        )
        assert response.code == 403
        assert self.fetcher.requests == []

    def test_upstream_secret_body_and_network_errors_are_redacted(self) -> None:
        self.fetcher.respond(
            500,
            json.dumps({"code": "broken", "message": COURSEWEAVE_SENTINEL}).encode(),
        )
        response = self.fetch(
            "/base/courseweave/course", headers=self.auth_headers
        )
        assert response.code == 502
        assert COURSEWEAVE_SENTINEL not in response.body.decode()
        self.fetcher.error = RuntimeError(COURSEWEAVE_SENTINEL)
        response = self.fetch(
            "/base/courseweave/course", headers=self.auth_headers
        )
        assert response.code == 502
        assert COURSEWEAVE_SENTINEL not in response.body.decode()


class TestCourseWeaveReader(AsyncHTTPTestCase):
    def get_app(self):
        from tempfile import TemporaryDirectory
        from test_reader import course
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.course_root = Path(self.directory.name)
        course(self.course_root)
        identity = PasswordIdentityProvider(token=JUPYTER_AUTH_SENTINEL)
        return Application(
            [(r'/base/courseweave/reader/(.*)', CourseWeaveReaderHandler, {'course_root':str(self.course_root)})],
            base_url='/base/',login_url='/login',cookie_secret=b'courseweave-test-cookie-secret-32',
            identity_provider=identity,authorizer=AllowAllAuthorizer(identity_provider=identity),
            token=JUPYTER_AUTH_SENTINEL,allow_remote_access=True,allow_unauthenticated_access=False,
            disable_check_xsrf=False,xsrf_cookies=True,log=logging.getLogger('reader-test'))

    def test_authentication_exact_bytes_and_scripts_disabled_same_origin_csp(self):
        assert self.fetch('/base/courseweave/reader/lessons/one.html',follow_redirects=False).code==403
        response=self.fetch('/base/courseweave/reader/lessons/one.html',headers={'Authorization':f'token {JUPYTER_AUTH_SENTINEL}'})
        assert response.code==200
        assert response.body==(self.course_root/'lessons/one.html').read_bytes()
        policy=response.headers['Content-Security-Policy']
        assert "sandbox allow-same-origin" in policy and "script-src 'none'" in policy and 'allow-scripts' not in policy
        assert "default-src 'none'" in policy and "form-action 'none'" in policy and "base-uri 'none'" in policy
        assert response.headers['Cache-Control']=='no-store' and response.headers['X-Content-Type-Options']=='nosniff'
        assert 'Access-Control-Allow-Origin' not in response.headers
        assert JUPYTER_AUTH_SENTINEL.encode() not in response.body
        image=self.fetch('/base/courseweave/reader/assets/diagram.svg',headers={'Authorization':f'token {JUPYTER_AUTH_SENTINEL}'})
        assert image.code==200 and image.headers['Content-Type']=='image/svg+xml'
        assert image.body==(self.course_root/'assets/diagram.svg').read_bytes()

    def test_no_unlisted_files_query_writes_or_symlink_images(self):
        headers={'Authorization':f'token {JUPYTER_AUTH_SENTINEL}'}
        for path in ('courseweave.json','assets/unlisted.svg','lessons/not-declared.html','assets/%252e%252e/secret.svg'):
            assert self.fetch('/base/courseweave/reader/'+path,headers=headers).code==404
        assert self.fetch('/base/courseweave/reader/lessons/one.html?download=1',headers=headers).code==400
        assert self.fetch('/base/courseweave/reader/lessons/one.html',method='POST',body='{}',headers=headers).code==405
        (self.course_root/'assets/diagram.svg').unlink()
        (self.course_root/'assets/diagram.svg').symlink_to(self.course_root/'courseweave.json')
        assert self.fetch('/base/courseweave/reader/assets/diagram.svg',headers=headers).code==404
