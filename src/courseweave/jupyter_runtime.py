"""Authenticated Jupyter Server relays for the in-memory launch capability."""

from __future__ import annotations

import hmac
import ipaddress
import json
import os
import re
import signal
import stat
from pathlib import Path
from dataclasses import dataclass
from typing import Any, Literal, Mapping
from urllib.parse import urlsplit

from jupyter_client.kernelspec import KernelSpec, KernelSpecManager, NoSuchKernel
from traitlets import Unicode
from jupyter_server.base.handlers import APIHandler
from jupyter_server.auth.decorator import authorized
from jupyter_server.utils import url_path_join
from pydantic import ValidationError
from tornado import web
from tornado.httpclient import AsyncHTTPClient, HTTPRequest, HTTPResponse
from tornado.httputil import HTTPHeaders
from tornado.ioloop import PeriodicCallback

from .models import WorkspaceContext
from .reader import read_reader_file

CONTEXT_BODY_LIMIT = 1024 * 1024
_SETTINGS_KEY = "courseweave_runtime_settings"
_HTTP_CLIENT_KEY = "courseweave_http_client"
_PAGE_CONFIG_KEYS = (
    "courseweaveServiceUrl",
    "courseweaveRuntimeId",
    "courseweaveLaunchMode",
)
_SERVER_INFO_GUARD = "_courseweave_server_info_guard_installed"
_SUPERVISED_ENVIRONMENT_KEYS = (
    "COURSEWEAVE_URL",
    "COURSEWEAVE_CAPABILITY_TOKEN",
    "COURSEWEAVE_RUNTIME_ID",
    "COURSEWEAVE_LAUNCH_MODE",
    "COURSEWEAVE_PARENT_PID",
)
_JSON_CONTENT_TYPE = re.compile(
    r'application/json(?:[ \t]*;[ \t]*charset[ \t]*=[ \t]*(?:utf-8|"utf-8"))?[ \t]*',
    re.IGNORECASE | re.ASCII,
)
_COURSE_ETAG = re.compile(r'(?:""|"[0-9a-f]{64}")')



class CourseKernelSpecManager(KernelSpecManager):
    """An explicit launch can see only its supervisor-owned course kernel.

    Jupyter Client's kernel_dirs trait is deliberately not CLI-configurable.
    Set the instance property through this narrow supported manager-class hook.
    """
    course_kernel_dir = Unicode(config=True)

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        root = Path(self.course_kernel_dir)
        if not self.course_kernel_dir or not root.is_absolute():
            raise ValueError("A private owned course kernel directory is required")
        fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0))
        try:
            metadata = os.fstat(fd)
            if metadata.st_uid != os.getuid() or stat.S_IMODE(metadata.st_mode) != 0o700:
                raise ValueError("A private owned course kernel directory is required")
        finally:
            os.close(fd)
        self.kernel_dirs = [str(root)]
        self.ensure_native_kernel = False
        self.allowed_kernelspecs = {"python3"}

    def get_kernel_spec(self, kernel_name: str) -> KernelSpec:
        # The base implementation falls back to ipykernel RESOURCES even when
        # ensure_native_kernel=False. Load only the owned spec through its public
        # constructor, including when the requested name is the native python3.
        if kernel_name != "python3":
            raise NoSuchKernel(kernel_name)
        try:
            return self.kernel_spec_class.from_resource_dir(str(Path(self.course_kernel_dir) / "python3"))
        except (OSError, ValueError):
            raise NoSuchKernel(kernel_name) from None

def _bounded_nonblank(value: str | None, maximum: int) -> bool:
    return (
        isinstance(value, str)
        and 0 < len(value) <= maximum
        and value.strip() == value
    )


def _canonical_loopback_origin(value: str | None) -> str | None:
    if not _bounded_nonblank(value, 2048):
        return None
    assert value is not None
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError:
        return None
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path
        or parsed.query
        or parsed.fragment
        or parsed.hostname is None
    ):
        return None
    hostname = parsed.hostname.lower()
    if hostname != "localhost":
        try:
            if not ipaddress.ip_address(hostname).is_loopback:
                return None
        except ValueError:
            return None
    rendered_host = f"[{hostname}]" if ":" in hostname else hostname
    origin = f"{parsed.scheme}://{rendered_host}"
    default_port = 80 if parsed.scheme == "http" else 443
    if port is not None and port != default_port:
        origin = f"{origin}:{port}"
    return origin if hmac.compare_digest(origin, value) else None


@dataclass(frozen=True)
class RuntimeSettings:
    """Validated process-local launch settings; the capability stays here."""

    service_url: str
    capability_token: str
    runtime_id: str
    launch_mode: Literal["learn", "author"]

    @classmethod
    def from_environ(cls, environment: Mapping[str, str]) -> RuntimeSettings | None:
        service_url = _canonical_loopback_origin(environment.get("COURSEWEAVE_URL"))
        capability_token = environment.get("COURSEWEAVE_CAPABILITY_TOKEN")
        runtime_id = environment.get("COURSEWEAVE_RUNTIME_ID")
        launch_mode = environment.get("COURSEWEAVE_LAUNCH_MODE")
        if (
            service_url is None
            or not _bounded_nonblank(capability_token, 4096)
            or not _bounded_nonblank(runtime_id, 240)
            or launch_mode not in {"learn", "author"}
        ):
            return None
        assert capability_token is not None
        assert runtime_id is not None
        return cls(
            service_url=service_url,
            capability_token=capability_token,
            runtime_id=runtime_id,
            launch_mode=launch_mode,
        )

    @property
    def page_config(self) -> dict[str, str]:
        """Return the complete CourseWeave PageConfig allowlist."""

        return {
            "courseweaveServiceUrl": self.service_url,
            "courseweaveRuntimeId": self.runtime_id,
            "courseweaveLaunchMode": self.launch_mode,
        }


def _contains_secret(value: Any, secret: str) -> bool:
    if isinstance(value, str):
        return secret in value
    if isinstance(value, list):
        return any(_contains_secret(item, secret) for item in value)
    if isinstance(value, dict):
        return any(
            _contains_secret(key, secret) or _contains_secret(item, secret)
            for key, item in value.items()
        )
    return False


def _is_json_content_type(value: str | None) -> bool:
    return value is not None and _JSON_CONTENT_TYPE.fullmatch(value) is not None


def _is_safe_course_etag(value: str | None, capability_token: str) -> bool:
    return (
        value is not None
        and not _contains_secret(value, capability_token)
        and _COURSE_ETAG.fullmatch(value) is not None
    )


class _CourseWeaveRelayHandler(APIHandler):
    """Common same-origin handler behavior without browser CORS."""

    def set_default_headers(self) -> None:
        super().set_default_headers()
        self.set_header("Cache-Control", "no-store")
        for name in (
            "Access-Control-Allow-Origin",
            "Access-Control-Allow-Credentials",
            "Access-Control-Allow-Headers",
            "Access-Control-Allow-Methods",
        ):
            self.clear_header(name)

    def set_cors_headers(self) -> None:
        """These relays are deliberately same-origin only."""

    def _runtime_settings(self) -> RuntimeSettings | None:
        value = self.settings.get(_SETTINGS_KEY)
        return value if isinstance(value, RuntimeSettings) else None

    def _fail(self, status: int, code: str, message: str) -> None:
        self.set_status(status)
        self.finish({"code": code, "message": message, "details": {}})

    def _reject_query_or_body(self) -> bool:
        if self.request.query or self.request.body:
            self._fail(400, "validation_error", "The relay request is invalid.")
            return True
        return False

    async def _fetch_upstream(
        self,
        method: Literal["GET", "POST"],
        path: str,
        *,
        body: bytes | None = None,
    ) -> HTTPResponse | None:
        settings = self._runtime_settings()
        if settings is None:
            self._fail(503, "runtime_unavailable", "CourseWeave runtime is unavailable.")
            return None
        headers = HTTPHeaders(
            {
                "Authorization": f"Bearer {settings.capability_token}",
                "Accept": "application/json",
            }
        )
        if body is not None:
            headers["Content-Type"] = "application/json"
        request = HTTPRequest(
            url=f"{settings.service_url}{path}",
            method=method,
            headers=headers,
            body=body,
            follow_redirects=False,
            request_timeout=10,
        )
        client = self.settings.get(_HTTP_CLIENT_KEY)
        if client is None:
            client = AsyncHTTPClient()
        try:
            return await client.fetch(request, raise_error=False)
        except Exception:
            self._fail(502, "relay_failed", "CourseWeave could not complete the request.")
            return None

    def _finish_upstream(self, response: HTTPResponse, *, copy_etag: bool = False) -> None:
        settings = self._runtime_settings()
        if settings is None:
            self._fail(503, "runtime_unavailable", "CourseWeave runtime is unavailable.")
            return
        if not _is_json_content_type(response.headers.get("Content-Type")):
            self._fail(502, "invalid_relay_response", "CourseWeave returned an invalid response.")
            return
        try:
            payload = json.loads(response.body)
        except (UnicodeDecodeError, json.JSONDecodeError, TypeError):
            self._fail(502, "invalid_relay_response", "CourseWeave returned an invalid response.")
            return
        if _contains_secret(payload, settings.capability_token):
            self._fail(502, "invalid_relay_response", "CourseWeave returned an invalid response.")
            return
        etag: str | None = None
        if copy_etag and 200 <= response.code < 300:
            candidate = response.headers.get("ETag")
            if not _is_safe_course_etag(candidate, settings.capability_token):
                self._fail(502, "invalid_relay_response", "CourseWeave returned an invalid response.")
                return
            etag = candidate
        self.set_status(response.code)
        if etag is not None:
            self.set_header("ETag", etag)
        self.finish(payload)


class CourseWeaveReaderHandler(APIHandler):
    """Authenticated, jailed course content with no executable document context.

    Jupyter's generic /files CSP gives HTML an opaque origin. This separate
    course-bound route keeps local image authentication and approved link
    interception usable while both CSP and the embedding frame disable scripts.
    """
    auth_resource = "contents"

    def initialize(self, course_root: str) -> None:
        self.course_root = Path(course_root)

    @property
    def content_security_policy(self) -> str:
        return ("default-src 'none'; frame-ancestors 'self'; sandbox allow-same-origin; "
                "script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
                "font-src 'self' data:; form-action 'none'; base-uri 'none'")

    def set_cors_headers(self) -> None:
        """Reader content is same-origin only."""

    @web.authenticated
    @authorized
    def get(self, path: str, include_body: bool = True) -> None:
        self.check_xsrf_cookie()
        if self.request.query or self.request.body:
            raise web.HTTPError(400, "Invalid reader request")
        try:
            data, media_type = read_reader_file(self.course_root, path)
        except (OSError, ValueError, UnicodeError):
            raise web.HTTPError(404, "Course reader content unavailable") from None
        self.set_header("Cache-Control", "no-store")
        self.set_header("X-Content-Type-Options", "nosniff")
        self.set_header("Content-Type", media_type)
        self.set_header("Content-Length", str(len(data)))
        self.finish(data if include_body else b"", set_content_type=media_type)

    @web.authenticated
    @authorized
    def head(self, path: str) -> None:
        self.get(path, include_body=False)


class CourseWeaveRuntimeHandler(_CourseWeaveRelayHandler):
    @web.authenticated
    async def get(self) -> None:
        if self._reject_query_or_body():
            return
        settings = self._runtime_settings()
        if settings is None:
            self._fail(503, "runtime_unavailable", "CourseWeave runtime is unavailable.")
            return
        provided = self.request.headers.get("X-CourseWeave-Runtime-ID", "")
        if not hmac.compare_digest(provided.encode(), settings.runtime_id.encode()):
            self._fail(403, "forbidden", "A valid runtime ID is required.")
            return
        self.finish(
            {
                "serviceOrigin": settings.service_url,
                "capabilityToken": settings.capability_token,
            }
        )


class CourseWeaveCourseRelayHandler(_CourseWeaveRelayHandler):
    @web.authenticated
    async def get(self) -> None:
        if self._reject_query_or_body():
            return
        response = await self._fetch_upstream("GET", "/api/course")
        if response is not None:
            self._finish_upstream(response, copy_etag=True)


class CourseWeaveContextRelayHandler(_CourseWeaveRelayHandler):
    @web.authenticated
    async def post(self) -> None:
        if self.request.query:
            self._fail(400, "validation_error", "The relay request is invalid.")
            return
        raw = self.request.body
        if len(raw) > CONTEXT_BODY_LIMIT:
            self._fail(413, "validation_error", "The context metadata exceeds the limit.")
            return
        try:
            context = WorkspaceContext.model_validate_json(raw)
        except ValidationError:
            self._fail(422, "validation_error", "The context metadata is invalid.")
            return
        body = context.model_dump_json().encode("utf-8")
        response = await self._fetch_upstream("POST", "/api/context", body=body)
        if response is not None:
            self._finish_upstream(response)


def _jupyter_server_extension_points() -> list[dict[str, str]]:
    return [{"module": "courseweave.jupyter_runtime"}]


def _guard_jupyter_runtime_files(serverapp: Any) -> None:
    """Keep Jupyter's authentication token out of runtime files."""

    serverapp.no_browser_open_file = True
    if getattr(serverapp, _SERVER_INFO_GUARD, False):
        return
    original_server_info = serverapp.server_info

    def redacted_server_info() -> dict[str, Any]:
        info = dict(original_server_info())
        info["token"] = ""
        return info

    serverapp.server_info = redacted_server_info
    setattr(serverapp, _SERVER_INFO_GUARD, True)


def _watch_supervisor(parent_pid: str | None):
    """End this Jupyter server if its owning supervisor dies unexpectedly.

    The OS parent relationship cannot silently attach to a reused PID. SIGTERM
    uses Jupyter's existing shutdown path, including its own notebook kernels.
    """
    if parent_pid is None:
        return None
    if not re.fullmatch(r'[1-9][0-9]{0,9}', parent_pid) or int(parent_pid) < 2:
        raise ValueError('Invalid CourseWeave parent process identity.')
    expected = int(parent_pid)

    def check_parent():
        if os.getppid() != expected:
            watch.stop()
            os.kill(os.getpid(), signal.SIGTERM)

    watch = PeriodicCallback(check_parent, 500)
    watch.start()
    return watch


def _load_jupyter_server_extension(serverapp: Any) -> None:
    """Load using only public Jupyter Server 2.21 extension contracts."""

    # A partial supervised environment must fail without first persisting the
    # standard Jupyter token. Generic, non-CourseWeave Jupyter use is unchanged.
    if any(key in os.environ for key in _SUPERVISED_ENVIRONMENT_KEYS):
        _guard_jupyter_runtime_files(serverapp)
    settings = RuntimeSettings.from_environ(os.environ)
    parent_pid = os.environ.get('COURSEWEAVE_PARENT_PID')
    if any(key in os.environ for key in _SUPERVISED_ENVIRONMENT_KEYS):
        # IdentityProvider reads JUPYTER_TOKEN lazily. Capture it before clearing
        # startup custody so authentication survives and new kernels inherit none.
        _ = serverapp.identity_provider.token
        for key in (*_SUPERVISED_ENVIRONMENT_KEYS, "JUPYTER_TOKEN"):
            os.environ.pop(key, None)
    web_app = serverapp.web_app
    if settings is not None and parent_pid is not None:
        web_app.settings['courseweave_parent_watch'] = _watch_supervisor(parent_pid)
    web_app.settings[_SETTINGS_KEY] = settings
    page_config = web_app.settings.setdefault("page_config_data", {})
    for key in _PAGE_CONFIG_KEYS:
        page_config.pop(key, None)
    if settings is not None:
        page_config.update(settings.page_config)
    handlers = [
        (
            url_path_join(serverapp.base_url, "courseweave", "runtime"),
            CourseWeaveRuntimeHandler,
        ),
        (
            url_path_join(serverapp.base_url, "courseweave", "course"),
            CourseWeaveCourseRelayHandler,
        ),
        (
            url_path_join(serverapp.base_url, "courseweave", "context"),
            CourseWeaveContextRelayHandler,
        ),
    ]
    if settings is not None:
        handlers.append((url_path_join(serverapp.base_url, "courseweave", "reader", "(.*)"), CourseWeaveReaderHandler, {"course_root": str(serverapp.root_dir)}))
    web_app.add_handlers(".*$", handlers)
