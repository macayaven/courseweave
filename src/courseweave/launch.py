"""Owned-process supervision for CourseWeave's JupyterLab launch modes."""

from __future__ import annotations

import asyncio
import fcntl
import hashlib
import html
import json
import os
import re
import secrets
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Callable, Literal
from urllib.parse import quote

import uvicorn

from courseweave.api import create_app

_HOST = "127.0.0.1"
_JUPYTER_BASE_URL = "/courseweave/"
_SAFE_ENVIRONMENT_KEYS = (
    "HOME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LOGNAME",
    "PATH",
    "SHELL",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
    "TMPDIR",
    "USER",
)
_TOKEN_QUERY = re.compile(r"([?&](?:token|auth|key)=)[^&\s\"'<>]+", re.IGNORECASE)
_AUTHORIZATION = re.compile(r"(authorization\s*:\s*)[^\r\n]+", re.IGNORECASE)


def _redact_diagnostic(message: str, secrets: tuple[str, ...]) -> str:
    redacted = _AUTHORIZATION.sub(r"\1[REDACTED]", message)
    redacted = _TOKEN_QUERY.sub(r"\1[REDACTED]", redacted)
    for secret in secrets:
        if secret:
            redacted = redacted.replace(secret, "[REDACTED]")
    return redacted


class CourseLockError(RuntimeError):
    """The per-course supervisor lock cannot be safely acquired."""


class CourseLock:
    def __init__(self, course_root: Path, *, runtime_root: Path | None = None) -> None:
        self.course_root = Path(course_root).resolve(strict=True)
        base = Path(runtime_root) if runtime_root is not None else _runtime_root()
        user_directory = base / f"courseweave-{os.getuid()}"
        lock_directory = user_directory / "locks"
        digest = hashlib.sha256(str(self.course_root).encode("utf-8")).hexdigest()
        self.path = lock_directory / f"{digest}.lock"
        self._fd: int | None = None

    def acquire(self) -> CourseLock:
        if self._fd is not None:
            return self
        user_fd: int | None = None
        lock_dir_fd: int | None = None
        file_fd: int | None = None
        try:
            user_fd = _private_directory(self.path.parent.parent)
            lock_dir_fd = _private_directory_at(user_fd, "locks")
            file_fd = _private_lock_file(lock_dir_fd, self.path.name)
            try:
                fcntl.flock(file_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise CourseLockError(
                    "CourseWeave is already running for this course."
                ) from exc
            self._fd = file_fd
            file_fd = None
            return self
        except CourseLockError:
            raise
        except OSError as exc:
            raise CourseLockError(
                "CourseWeave could not create a secure per-course runtime lock."
            ) from exc
        finally:
            if file_fd is not None:
                os.close(file_fd)
            if lock_dir_fd is not None:
                os.close(lock_dir_fd)
            if user_fd is not None:
                os.close(user_fd)

    def release(self) -> None:
        if self._fd is None:
            return
        file_fd, self._fd = self._fd, None
        # Closing only this descriptor preserves an inherited flock in an
        # unconfirmed owned child; the final holder's close releases it.
        os.close(file_fd)

    def fileno(self) -> int:
        if self._fd is None:
            raise CourseLockError("CourseWeave runtime lock is not acquired.")
        return self._fd

    def __enter__(self) -> CourseLock:
        return self.acquire()

    def __exit__(self, *_exc: object) -> None:
        self.release()


def _runtime_root() -> Path:
    configured = os.environ.get("XDG_RUNTIME_DIR")
    return Path(configured) if configured else Path(tempfile.gettempdir())


def _directory_flags() -> int:
    return os.O_RDONLY | os.O_CLOEXEC | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0)


def _validate_private_directory(fd: int) -> None:
    metadata = os.fstat(fd)
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or metadata.st_uid != os.getuid()
        or stat.S_IMODE(metadata.st_mode) != 0o700
    ):
        raise CourseLockError(
            "CourseWeave requires a user-owned runtime directory with mode 0700."
        )


def _private_directory(path: Path) -> int:
    try:
        os.mkdir(path, 0o700)
    except FileExistsError:
        pass
    fd = os.open(path, _directory_flags())
    try:
        _validate_private_directory(fd)
    except BaseException:
        os.close(fd)
        raise
    return fd


def _private_directory_at(parent_fd: int, name: str) -> int:
    try:
        os.mkdir(name, 0o700, dir_fd=parent_fd)
    except FileExistsError:
        pass
    fd = os.open(name, _directory_flags(), dir_fd=parent_fd)
    try:
        _validate_private_directory(fd)
    except BaseException:
        os.close(fd)
        raise
    return fd


def _private_lock_file(directory_fd: int, name: str) -> int:
    flags = os.O_RDWR | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)
    created = False
    try:
        fd = os.open(name, flags | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=directory_fd)
        created = True
    except FileExistsError:
        fd = os.open(name, flags, dir_fd=directory_fd)
    try:
        if created:
            os.fchmod(fd, 0o600)
        metadata = os.fstat(fd)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != os.getuid()
            or stat.S_IMODE(metadata.st_mode) != 0o600
        ):
            raise CourseLockError(
                "CourseWeave requires a secure user-owned lock file with mode 0600."
            )
    except BaseException:
        os.close(fd)
        raise
    return fd


def reserve_listener(port: int, *, socket_factory: Any = socket.socket) -> Any:
    listener = socket_factory(socket.AF_INET, socket.SOCK_STREAM)
    try:
        listener.bind(("127.0.0.1", port))
    except BaseException:
        listener.close()
        raise
    return listener


async def serve_on_reserved_socket(server: Any, listener: Any) -> None:
    await server.serve(sockets=[listener])


def _make_api_server(application: Any, port: int) -> uvicorn.Server:
    config = uvicorn.Config(
        application,
        host=_HOST,
        port=port,
        log_level="warning",
        access_log=False,
    )
    return uvicorn.Server(config)


def _course_ready(url: str, capability_token: str) -> bool:
    request = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {capability_token}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=0.5) as response:
            response.read(1)
            return 200 <= response.status < 500 and response.status != 403
    except urllib.error.HTTPError as exc:
        return 400 <= exc.code < 500 and exc.code != 403
    except (OSError, urllib.error.URLError):
        return False


class _PageConfigParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self._inside = False
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "script" and dict(attrs).get("id") == "jupyter-config-data":
            self._inside = True

    def handle_endtag(self, tag: str) -> None:
        if tag == "script":
            self._inside = False

    def handle_data(self, data: str) -> None:
        if self._inside:
            self.parts.append(data)


def _read_json_response(request: urllib.request.Request) -> tuple[int, bytes]:
    with urllib.request.urlopen(request, timeout=0.75) as response:
        body = response.read(8 * 1024 * 1024 + 1)
        if len(body) > 8 * 1024 * 1024:
            raise ValueError("response too large")
        return response.status, body


def _jupyter_ready(
    base_url: str,
    jupyter_token: str,
    runtime_id: str,
    capability_token: str,
    service_url: str,
    mode: Literal["learn", "author"],
) -> bool:
    auth = {"Authorization": f"token {jupyter_token}"}
    try:
        status, page = _read_json_response(
            urllib.request.Request(f"{base_url}lab", headers=auth)
        )
        if status != 200 or capability_token.encode() in page:
            return False
        parser = _PageConfigParser()
        parser.feed(page.decode("utf-8"))
        page_config = json.loads(html.unescape("".join(parser.parts)))
        if not isinstance(page_config, dict):
            return False
        if page_config.get("token") != jupyter_token:
            return False
        if {
            key: page_config.get(key)
            for key in (
                "courseweaveServiceUrl",
                "courseweaveRuntimeId",
                "courseweaveLaunchMode",
            )
        } != {
            "courseweaveServiceUrl": service_url,
            "courseweaveRuntimeId": runtime_id,
            "courseweaveLaunchMode": mode,
        }:
            return False
        runtime_headers = {
            **auth,
            "X-CourseWeave-Runtime-ID": runtime_id,
        }
        status, runtime = _read_json_response(
            urllib.request.Request(
                f"{base_url}courseweave/runtime", headers=runtime_headers
            )
        )
        if status != 200:
            return False
        return json.loads(runtime) == {
            "serviceOrigin": service_url,
            "capabilityToken": capability_token,
        }
    except (
        OSError,
        ValueError,
        UnicodeDecodeError,
        json.JSONDecodeError,
        urllib.error.URLError,
    ):
        return False


def _reserve_jupyter_port() -> int:
    """Choose a loopback port with the narrow residual allowed by Jupyter's CLI.

    Jupyter Server 2.21 has no public inherited-listener CLI contract, so its
    fixed port is reserved, read, and released immediately before the exact
    ``Popen`` call. ``port_retries=0`` makes any race fail closed.
    """

    listener = reserve_listener(0)
    try:
        return int(listener.getsockname()[1])
    finally:
        listener.close()


def _default_error_sink(message: str) -> None:
    print(message, file=sys.stderr)


class _LaunchFailure(RuntimeError):
    def __init__(self, exit_code: int = 1) -> None:
        super().__init__("supervised launch failed")
        self.exit_code = exit_code


def _normalized_exit_code(exit_code: int, *, early: bool = False) -> int:
    if exit_code < 0:
        return 128 + abs(exit_code)
    if early and exit_code == 0:
        return 1
    return exit_code


class LaunchSupervisor:
    """Coordinate the local API, authenticated JupyterLab, and browser."""

    def __init__(
        self,
        course_root: Path,
        *,
        port: int = 8765,
        mode: Literal["learn", "author"] = "learn",
        lock_factory: Callable[[Path], Any] = CourseLock,
        listener_factory: Callable[[int], Any] = reserve_listener,
        api_server_factory: Callable[[Any, int], Any] = _make_api_server,
        process_factory: Callable[..., Any] = subprocess.Popen,
        browser_opener: Callable[[str], bool] = webbrowser.open,
        course_ready: Callable[[str, str], bool] = _course_ready,
        jupyter_ready: Callable[..., bool] = _jupyter_ready,
        jupyter_port_factory: Callable[[], int] = _reserve_jupyter_port,
        secret_factory: Callable[[int], str] = secrets.token_urlsafe,
        signal_api: Any = signal,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
        error_sink: Callable[[str], None] = _default_error_sink,
        readiness_timeout: float = 30.0,
        shutdown_timeout: float = 10.0,
    ) -> None:
        self.course_root = Path(course_root).resolve(strict=True)
        if not self.course_root.is_dir():
            raise ValueError("course_root must be a directory")
        if mode not in {"learn", "author"}:
            raise ValueError("mode must be learn or author")
        self.port = port
        self.mode = mode
        self._lock_factory = lock_factory
        self._listener_factory = listener_factory
        self._api_server_factory = api_server_factory
        self._process_factory = process_factory
        self._browser_opener = browser_opener
        self._course_ready = course_ready
        self._jupyter_ready = jupyter_ready
        self._jupyter_port_factory = jupyter_port_factory
        self._secret_factory = secret_factory
        self._signal_api = signal_api
        self._clock = clock
        self._sleep = sleep
        self._error_sink = error_sink
        self._readiness_timeout = readiness_timeout
        self._shutdown_timeout = shutdown_timeout
        self._lock: Any | None = None
        self._listener: Any | None = None
        self._listener_close_attempted = False
        self._listener_close_confirmed = False
        self._api_server: Any | None = None
        self._api_thread: threading.Thread | None = None
        self._api_started = threading.Event()
        self._api_stopped = threading.Event()
        self._api_failed = False
        self._jupyter_process: Any | None = None
        self._jupyter_shutdown_attempted = False
        self._output_threads: list[threading.Thread] = []
        self._temporary_directory: tempfile.TemporaryDirectory[str] | None = None
        self._child_environment: dict[str, str] | None = None
        self._requested_signal: int | None = None
        self._previous_handlers: dict[int, Any] = {}
        self._lock_release_attempted = False
        self._temporary_cleanup_attempted = False
        self._reported_error = False
        self.capability_token: str | None = None
        self.jupyter_token: str | None = None
        self.runtime_id: str | None = None

    def run(self) -> int:
        exit_code = 1
        try:
            self._install_signal_handlers()
            self._lock = self._lock_factory(self.course_root)
            self._lock.acquire()
            self._listener = self._listener_factory(self.port)
            api_port = int(self._listener.getsockname()[1])
            service_url = f"http://{_HOST}:{api_port}"
            self.capability_token = self._secret_factory(32)
            application = create_app(
                self.course_root, capability_token=self.capability_token
            )
            self._api_server = self._api_server_factory(application, api_port)
            self._start_api()
            self._wait_for_course(f"{service_url}/api/course")

            self.jupyter_token = self._secret_factory(32)
            self.runtime_id = self._secret_factory(32)
            self._temporary_directory = tempfile.TemporaryDirectory(
                prefix="courseweave-jupyter-"
            )
            runtime_root = Path(self._temporary_directory.name)
            config_dir = runtime_root / "config"
            jupyter_runtime_dir = runtime_root / "runtime"
            config_dir.mkdir(mode=0o700)
            jupyter_runtime_dir.mkdir(mode=0o700)
            self._child_environment = self._build_child_environment(
                service_url, config_dir, jupyter_runtime_dir
            )
            jupyter_port = self._jupyter_port_factory()
            jupyter_url = f"http://{_HOST}:{jupyter_port}{_JUPYTER_BASE_URL}"
            argv = self._build_jupyter_argv(jupyter_port)
            self._jupyter_process = self._process_factory(
                argv,
                cwd=self.course_root,
                env=self._child_environment,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                shell=False,
                start_new_session=False,
                pass_fds=(self._lock.fileno(),),
            )
            self._start_output_drains()
            self._wait_for_jupyter(jupyter_url, service_url)
            if self._requested_signal is not None:
                exit_code = 128 + self._requested_signal
            else:
                bootstrap_url = (
                    f"{jupyter_url}lab?token={quote(self.jupyter_token, safe='')}"
                )
                try:
                    opened = self._browser_opener(bootstrap_url)
                finally:
                    bootstrap_url = ""
                if not opened:
                    raise _LaunchFailure()
                exit_code = self._wait_for_exit()
        except _LaunchFailure as exc:
            exit_code = exc.exit_code
            if self._requested_signal is None:
                self._report_failure()
        except Exception:
            self._report_failure()
        finally:
            cleanup_ok = self._cleanup()
        if not cleanup_ok:
            if exit_code == 0:
                exit_code = 1
            self._report_failure()
        return exit_code

    def _build_child_environment(
        self, service_url: str, config_dir: Path, runtime_dir: Path
    ) -> dict[str, str]:
        assert self.capability_token is not None
        assert self.jupyter_token is not None
        assert self.runtime_id is not None
        environment = {
            key: os.environ[key]
            for key in _SAFE_ENVIRONMENT_KEYS
            if os.environ.get(key)
        }
        environment.update(
            {
                "COURSEWEAVE_URL": service_url,
                "COURSEWEAVE_CAPABILITY_TOKEN": self.capability_token,
                "COURSEWEAVE_RUNTIME_ID": self.runtime_id,
                "COURSEWEAVE_LAUNCH_MODE": self.mode,
                "JUPYTER_TOKEN": self.jupyter_token,
                "JUPYTER_CONFIG_DIR": str(config_dir),
                "JUPYTER_RUNTIME_DIR": str(runtime_dir),
                "PYTHONNOUSERSITE": "1",
            }
        )
        return environment

    def _build_jupyter_argv(self, port: int) -> list[str]:
        return [
            sys.executable,
            "-m",
            "jupyterlab",
            f"--ServerApp.ip={_HOST}",
            f"--ServerApp.port={port}",
            "--ServerApp.port_retries=0",
            f"--ServerApp.root_dir={self.course_root}",
            f"--ServerApp.base_url={_JUPYTER_BASE_URL}",
            "--ServerApp.default_url=/lab",
            "--ServerApp.open_browser=False",
            "--ServerApp.allow_remote_access=False",
            "--ServerApp.use_redirect_file=False",
            "--ServerApp.jpserver_extensions=courseweave.jupyter_runtime=True",
        ]

    def _install_signal_handlers(self) -> None:
        for signum in (signal.SIGINT, signal.SIGTERM):
            self._previous_handlers[signum] = self._signal_api.getsignal(signum)
            self._signal_api.signal(signum, self._request_stop)

    def _restore_signal_handlers(self) -> bool:
        restored = True
        for signum, handler in list(self._previous_handlers.items()):
            try:
                self._signal_api.signal(signum, handler)
            except BaseException:
                restored = False
            else:
                self._previous_handlers.pop(signum, None)
        return restored

    def _request_stop(self, signum: int, _frame: object) -> None:
        if self._requested_signal is None:
            self._requested_signal = signum

    def _start_api(self) -> None:
        def run_api() -> None:
            self._api_started.set()
            try:
                asyncio.run(serve_on_reserved_socket(self._api_server, self._listener))
            except BaseException:
                self._api_failed = True
            finally:
                self._api_stopped.set()

        self._api_thread = threading.Thread(
            target=run_api, name="courseweave-api", daemon=False
        )
        self._api_thread.start()
        self._api_started.wait(timeout=self._readiness_timeout)

    def _wait_for_course(self, url: str) -> None:
        assert self.capability_token is not None
        deadline = self._clock() + self._readiness_timeout
        while self._clock() < deadline:
            if self._requested_signal is not None:
                raise _LaunchFailure(128 + self._requested_signal)
            if self._api_failed:
                raise _LaunchFailure()
            try:
                ready = self._course_ready(url, self.capability_token)
            except BaseException:
                ready = False
            self._api_stopped.wait(timeout=0.001)
            if self._api_stopped.is_set():
                raise _LaunchFailure()
            if ready:
                return
            self._sleep(0.05)
        raise _LaunchFailure()

    def _wait_for_jupyter(self, jupyter_url: str, service_url: str) -> None:
        assert self.jupyter_token is not None
        assert self.runtime_id is not None
        assert self.capability_token is not None
        deadline = self._clock() + self._readiness_timeout
        while self._clock() < deadline:
            if self._requested_signal is not None:
                raise _LaunchFailure(128 + self._requested_signal)
            if self._api_failed:
                raise _LaunchFailure()
            if self._api_stopped.is_set():
                raise _LaunchFailure()
            child_exit = self._jupyter_process.poll()
            if child_exit is not None:
                raise _LaunchFailure(
                    _normalized_exit_code(child_exit, early=True)
                )
            try:
                ready = self._jupyter_ready(
                    jupyter_url,
                    self.jupyter_token,
                    self.runtime_id,
                    self.capability_token,
                    service_url,
                    self.mode,
                )
            except BaseException:
                ready = False
            if ready:
                return
            self._sleep(0.05)
        raise _LaunchFailure()

    def _wait_for_exit(self) -> int:
        while True:
            if self._requested_signal is not None:
                return 128 + self._requested_signal
            if self._api_failed:
                raise _LaunchFailure()
            if self._api_stopped.is_set():
                raise _LaunchFailure()
            child_exit = self._jupyter_process.poll()
            if child_exit is not None:
                return _normalized_exit_code(child_exit)
            self._sleep(0.1)

    def _start_output_drains(self) -> None:
        for name in ("stdout", "stderr"):
            stream = getattr(self._jupyter_process, name, None)
            if stream is None:
                continue
            thread = threading.Thread(
                target=self._drain_output,
                args=(stream,),
                name=f"courseweave-jupyter-{name}",
                daemon=False,
            )
            thread.start()
            self._output_threads.append(thread)

    def _drain_output(self, stream: Any) -> None:
        while True:
            try:
                chunk = stream.read(64 * 1024)
                if not chunk:
                    return
                if isinstance(chunk, bytes):
                    chunk = chunk.decode("utf-8", errors="replace")
                _redact_diagnostic(
                    chunk,
                    tuple(
                        value
                        for value in (self.capability_token, self.jupyter_token)
                        if value is not None
                    ),
                )
            except BaseException:
                return

    def _report_failure(self) -> None:
        if self._reported_error:
            return
        self._reported_error = True
        try:
            self._error_sink(
                "CourseWeave could not start the workspace. Check the course root, "
                "requested port, and JupyterLab installation, then retry."
            )
        except BaseException:
            pass

    def _cleanup(self) -> bool:
        cleanup_ok = True
        try:
            jupyter_stopped, stage_ok = self._stop_jupyter()
        except BaseException:
            jupyter_stopped, stage_ok = False, False
        cleanup_ok = cleanup_ok and stage_ok

        try:
            api_stopped, stage_ok = self._stop_api()
        except BaseException:
            api_stopped, stage_ok = False, False
        cleanup_ok = cleanup_ok and stage_ok

        try:
            listener_closed, stage_ok = self._close_listener()
        except BaseException:
            listener_closed, stage_ok = False, False
        cleanup_ok = cleanup_ok and stage_ok

        safe_to_unlock = jupyter_stopped and api_stopped and listener_closed
        if self._lock is not None:
            if safe_to_unlock and not self._lock_release_attempted:
                self._lock_release_attempted = True
                try:
                    self._lock.release()
                except BaseException:
                    cleanup_ok = False
                else:
                    self._lock = None
            else:
                cleanup_ok = False

        if self._temporary_directory is not None:
            if jupyter_stopped and not self._temporary_cleanup_attempted:
                self._temporary_cleanup_attempted = True
                try:
                    self._temporary_directory.cleanup()
                except BaseException:
                    cleanup_ok = False
                else:
                    self._temporary_directory = None
            else:
                cleanup_ok = False

        if self._child_environment is not None:
            environment, self._child_environment = self._child_environment, None
            try:
                environment.clear()
            except BaseException:
                cleanup_ok = False
        for name in ("capability_token", "jupyter_token", "runtime_id"):
            try:
                setattr(self, name, None)
            except BaseException:
                cleanup_ok = False
        try:
            handlers_restored = self._restore_signal_handlers()
        except BaseException:
            handlers_restored = False
        return cleanup_ok and handlers_restored

    def _stop_jupyter(self) -> tuple[bool, bool]:
        process = self._jupyter_process
        cleanup_ok = True
        process_stopped = process is None
        if process is not None:
            try:
                process_stopped = process.poll() is not None
            except BaseException:
                cleanup_ok = False
                process_stopped = False
            if not process_stopped and not self._jupyter_shutdown_attempted:
                self._jupyter_shutdown_attempted = True
                try:
                    process.terminate()
                except BaseException:
                    cleanup_ok = False
                try:
                    process.wait(timeout=self._shutdown_timeout)
                except subprocess.TimeoutExpired:
                    pass
                except BaseException:
                    cleanup_ok = False
                else:
                    process_stopped = True
                if not process_stopped:
                    try:
                        process.kill()
                    except BaseException:
                        cleanup_ok = False
                    try:
                        process.wait(timeout=self._shutdown_timeout)
                    except BaseException:
                        cleanup_ok = False
                    else:
                        process_stopped = True
            if process_stopped:
                self._jupyter_process = None
            else:
                cleanup_ok = False

        remaining_threads: list[threading.Thread] = []
        for thread in self._output_threads:
            try:
                thread.join(timeout=self._shutdown_timeout)
            except BaseException:
                cleanup_ok = False
            try:
                thread_alive = thread.is_alive()
            except BaseException:
                cleanup_ok = False
                thread_alive = True
            if thread_alive:
                cleanup_ok = False
                remaining_threads.append(thread)
        self._output_threads = remaining_threads
        return process_stopped, cleanup_ok

    def _stop_api(self) -> tuple[bool, bool]:
        cleanup_ok = True
        if self._api_server is not None:
            try:
                should_request_stop = not self._api_server.should_exit
            except BaseException:
                cleanup_ok = False
                should_request_stop = True
            if should_request_stop:
                try:
                    self._api_server.should_exit = True
                except BaseException:
                    cleanup_ok = False
        api_stopped = self._api_thread is None
        if self._api_thread is not None:
            try:
                self._api_thread.join(timeout=self._shutdown_timeout)
            except BaseException:
                cleanup_ok = False
            try:
                api_stopped = not self._api_thread.is_alive()
            except BaseException:
                cleanup_ok = False
                api_stopped = False
        if api_stopped:
            self._api_thread = None
            self._api_server = None
        else:
            cleanup_ok = False
        return api_stopped, cleanup_ok

    def _close_listener(self) -> tuple[bool, bool]:
        if self._listener is None:
            self._listener_close_confirmed = True
            return True, True
        if self._listener_close_attempted:
            return self._listener_close_confirmed, self._listener_close_confirmed
        cleanup_ok = True
        try:
            open_listener = self._listener.fileno() >= 0
        except BaseException:
            cleanup_ok = False
            open_listener = True
        if not open_listener:
            self._listener = None
            self._listener_close_confirmed = True
            return True, cleanup_ok
        self._listener_close_attempted = True
        try:
            self._listener.close()
        except BaseException:
            return False, False
        self._listener = None
        self._listener_close_confirmed = True
        return True, cleanup_ok
