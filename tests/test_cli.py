"""Behavioral tests for supervised CourseWeave/Jupyter launch commands."""

from __future__ import annotations

import asyncio
import gc
import hashlib
import io
import json
import os
import select
import shutil
import signal
import socket
import stat
import subprocess
import threading
import time
import urllib.request
import weakref
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from courseweave.cli import app
from courseweave.launch import (
    CourseLock,
    CourseLockError,
    LaunchSupervisor,
    _redact_diagnostic,
    reserve_listener,
    serve_on_reserved_socket,
)


def test_help_lists_both_supervised_jupyter_modes_and_preserves_commands() -> None:
    result = CliRunner().invoke(app, ["--help"])

    assert result.exit_code == 0
    for command in ("doctor", "serve", "launch", "author", "validate"):
        assert command in result.stdout


def test_validate_reports_only_safe_counts_for_runnable_course_with_spaces(
    tmp_path: Path,
) -> None:
    # Defect caught: validation rejects a quoted/spaced path, exposes course
    # content, or writes learner/runtime state while checking the manifest.
    source = Path(__file__).parents[1] / "examples" / "cli-course"
    course = tmp_path / "runnable course with spaces"
    shutil.copytree(source, course)
    before = {
        path.relative_to(course): path.read_bytes()
        for path in course.rglob("*")
        if path.is_file()
    }

    result = CliRunner().invoke(
        app, ["validate", "--course-root", str(course)]
    )

    assert result.exit_code == 0
    assert result.output == (
        "Course manifest is valid: modules=1 phases=2 surfaces=2.\n"
    )
    assert "CLI Course" not in result.output
    assert "lesson.md" not in result.output
    assert not (course / ".courseweave").exists()
    assert {
        path.relative_to(course): path.read_bytes()
        for path in course.rglob("*")
        if path.is_file()
    } == before


@pytest.mark.parametrize("failure", ["schema", "unrunnable"])
def test_validate_rejects_invalid_course_without_manifest_details(
    tmp_path: Path, failure: str
) -> None:
    # Defect caught: CLI validation prints raw schema/path details or performs
    # only structural validation instead of canonical runnable validation.
    source = Path(__file__).parents[1] / "examples" / "cli-course"
    course = tmp_path / f"invalid course {failure}"
    shutil.copytree(source, course)
    manifest_path = course / "courseweave.json"
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    if failure == "schema":
        data["credential-like-sentinel"] = "raw-manifest-secret"
    else:
        data["modules"][0]["phases"][0]["surfaces"][0]["path"] = (
            "secret-missing-surface.md"
        )
    manifest_path.write_text(json.dumps(data), encoding="utf-8")
    before = manifest_path.read_bytes()

    result = CliRunner().invoke(
        app, ["validate", "--course-root", str(course)]
    )

    assert result.exit_code == 1
    assert result.output == "Course manifest is invalid or not runnable.\n"
    assert "Traceback" not in result.output
    assert "credential-like-sentinel" not in result.output
    assert "raw-manifest-secret" not in result.output
    assert "secret-missing-surface.md" not in result.output
    assert manifest_path.read_bytes() == before
    assert not (course / ".courseweave").exists()


def test_validate_missing_manifest_is_safe_and_creates_no_course_files(
    tmp_path: Path,
) -> None:
    # Defect caught: validation turns a missing manifest into an implicit draft
    # or learner-state directory, or exposes the supplied course path.
    course = tmp_path / "empty course secret-path-marker"
    course.mkdir()

    result = CliRunner().invoke(
        app, ["validate", "--course-root", str(course)]
    )

    assert result.exit_code == 1
    assert result.output == "Course manifest not found.\n"
    assert "Traceback" not in result.output
    assert "secret-path-marker" not in result.output
    assert list(course.iterdir()) == []
    assert not (course / "courseweave.json").exists()
    assert not (course / ".courseweave").exists()


def test_validate_rejects_unreadable_manifest_path_without_os_details(
    tmp_path: Path,
) -> None:
    # Defect caught: an unusual manifest filesystem object escapes the
    # validation boundary with an OS exception or identifying path details.
    course = tmp_path / "course with unreadable manifest sentinel"
    course.mkdir()
    manifest_path = course / "courseweave.json"
    manifest_path.mkdir()

    result = CliRunner().invoke(
        app, ["validate", "--course-root", str(course)]
    )

    assert result.exit_code == 1
    assert result.output == "Course manifest could not be read.\n"
    assert "Traceback" not in result.output
    assert "unreadable manifest sentinel" not in result.output
    assert manifest_path.is_dir()
    assert not (course / ".courseweave").exists()


def test_validate_handles_root_inspection_os_error_without_details(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Defect caught: root inspection raises before the manifest error boundary
    # and exposes an OS exception containing a sensitive path or detail.
    course = tmp_path / "secret-inspection-root"
    original_is_dir = Path.is_dir

    def failing_is_dir(path: Path) -> bool:
        if path == course.resolve():
            raise PermissionError(
                "secret-inspection-detail",
                str(course),
            )
        return original_is_dir(path)

    monkeypatch.setattr(Path, "is_dir", failing_is_dir)
    result = CliRunner().invoke(
        app, ["validate", "--course-root", str(course)]
    )

    assert result.exit_code == 1
    assert result.output == "Course root could not be inspected.\n"
    assert "Traceback" not in result.output
    assert "PermissionError" not in result.output
    assert "secret-inspection" not in result.output


@pytest.mark.parametrize("kind", ["missing", "file"])
def test_validate_rejects_non_directory_root_with_constant_safe_error(
    tmp_path: Path, kind: str
) -> None:
    # Defect caught: Typer's path conversion echoes a sensitive invalid path or
    # the loader raises an unhandled filesystem exception with a traceback.
    course = tmp_path / f"secret-invalid-root-{kind}"
    if kind == "file":
        course.write_text("unchanged", encoding="utf-8")

    result = CliRunner().invoke(
        app, ["validate", "--course-root", str(course)]
    )

    assert result.exit_code == 1
    assert result.output == "Course root is not a directory.\n"
    assert "Traceback" not in result.output
    assert "secret-invalid-root" not in result.output
    if kind == "missing":
        assert not course.exists()
    else:
        assert course.read_text(encoding="utf-8") == "unchanged"


def test_installed_console_entrypoint_exposes_and_executes_validate(
    tmp_path: Path,
) -> None:
    # Defect caught: project metadata declares a console script whose installed
    # executable does not expose or execute the validate command.
    source = Path(__file__).parents[1] / "examples" / "cli-course"
    course = tmp_path / "installed entrypoint course"
    shutil.copytree(source, course)
    entrypoint = Path(os.sys.executable).with_name("courseweave")
    assert entrypoint.is_file()

    help_result = subprocess.run(
        [str(entrypoint), "--help"],
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )
    result = subprocess.run(
        [str(entrypoint), "validate", "--course-root", str(course)],
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )

    assert help_result.returncode == 0
    assert "validate" in help_result.stdout
    assert result.returncode == 0
    assert result.stdout == (
        "Course manifest is valid: modules=1 phases=2 surfaces=2.\n"
    )
    assert result.stderr == ""
    assert not (course / ".courseweave").exists()


def test_course_lock_uses_canonical_host_runtime_key_and_stale_file_is_reusable(
    tmp_path: Path,
) -> None:
    course = tmp_path / "course with spaces"
    course.mkdir()
    alias = tmp_path / "course-alias"
    alias.symlink_to(course, target_is_directory=True)
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    before = sorted(path.relative_to(course) for path in course.rglob("*"))

    first = CourseLock(course, runtime_root=runtime)
    expected_key = hashlib.sha256(str(course.resolve()).encode("utf-8")).hexdigest()
    assert first.path.name == f"{expected_key}.lock"
    assert course.resolve() not in first.path.parents

    first.acquire()
    try:
        assert stat.S_IMODE(first.path.parent.parent.stat().st_mode) == 0o700
        assert stat.S_IMODE(first.path.parent.stat().st_mode) == 0o700
        assert stat.S_IMODE(first.path.stat().st_mode) == 0o600
        with pytest.raises(CourseLockError, match="already running"):
            CourseLock(alias, runtime_root=runtime).acquire()
    finally:
        first.release()
        first.release()

    stale = CourseLock(alias, runtime_root=runtime)
    stale.acquire()
    stale.release()
    assert sorted(path.relative_to(course) for path in course.rglob("*")) == before


def test_course_lock_refuses_a_symlink_lock_file(tmp_path: Path) -> None:
    course = tmp_path / "course"
    course.mkdir()
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    seed = CourseLock(course, runtime_root=runtime)
    seed.acquire()
    seed.release()
    seed.path.unlink()
    outside = tmp_path / "outside"
    outside.write_text("unchanged", encoding="utf-8")
    seed.path.symlink_to(outside)

    with pytest.raises(CourseLockError, match="secure"):
        CourseLock(course, runtime_root=runtime).acquire()
    assert outside.read_text(encoding="utf-8") == "unchanged"


def test_child_inherited_lock_fd_holds_contention_until_child_exit(
    tmp_path: Path,
) -> None:
    course = tmp_path / "course"
    course.mkdir()
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    owner = CourseLock(course, runtime_root=runtime).acquire()
    child = subprocess.Popen(
        [
            os.sys.executable,
            "-c",
            (
                "import os,sys; "
                "os.fstat(int(sys.argv[1])); "
                "sys.stdout.write('ready\\n'); sys.stdout.flush(); "
                "sys.stdin.buffer.read(1)"
            ),
            str(owner.fileno()),
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        pass_fds=(owner.fileno(),),
    )
    contender = CourseLock(course, runtime_root=runtime)
    try:
        assert child.stdout is not None
        readable, _, _ = select.select([child.stdout], [], [], 5.0)
        assert readable
        assert child.stdout.readline() == b"ready\n"

        owner.release()
        try:
            with pytest.raises(CourseLockError, match="already running"):
                contender.acquire()
        finally:
            contender.release()

        assert child.stdin is not None
        child.communicate(input=b"x", timeout=5.0)
        assert child.returncode == 0

        after_exit = CourseLock(course, runtime_root=runtime).acquire()
        after_exit.release()
    finally:
        owner.release()
        if child.poll() is None:
            child.kill()
            child.wait(timeout=5.0)


class _FakeSocket:
    def __init__(self, *, fail_bind: bool = False) -> None:
        self.fail_bind = fail_bind
        self.bound: tuple[str, int] | None = None
        self.close_calls = 0

    def bind(self, address: tuple[str, int]) -> None:
        self.bound = address
        if self.fail_bind:
            raise OSError("occupied")

    def close(self) -> None:
        self.close_calls += 1


def test_listener_reservation_binds_exact_loopback_and_closes_failed_socket() -> None:
    created: list[_FakeSocket] = []

    def factory(family: int, kind: int) -> _FakeSocket:
        assert (family, kind) == (socket.AF_INET, socket.SOCK_STREAM)
        value = _FakeSocket(fail_bind=len(created) == 1)
        created.append(value)
        return value

    listener = reserve_listener(43123, socket_factory=factory)
    assert listener is created[0]
    assert listener.bound == ("127.0.0.1", 43123)
    assert listener.close_calls == 0

    with pytest.raises(OSError, match="occupied"):
        reserve_listener(43124, socket_factory=factory)
    assert created[1].bound == ("127.0.0.1", 43124)
    assert created[1].close_calls == 1


def test_uvicorn_serve_receives_the_identical_reserved_socket() -> None:
    listener = object()

    class FakeServer:
        seen: list[object] | None = None

        async def serve(self, *, sockets: list[object]) -> None:
            self.seen = sockets

    server = FakeServer()
    asyncio.run(serve_on_reserved_socket(server, listener))

    assert server.seen is not None
    assert len(server.seen) == 1
    assert server.seen[0] is listener


class _SupervisorLock:
    def __init__(self, events: list[str]) -> None:
        self.events = events
        self.release_calls = 0

    def acquire(self) -> _SupervisorLock:
        self.events.append("lock.acquire")
        return self

    def release(self) -> None:
        self.release_calls += 1
        self.events.append("lock.release")

    def fileno(self) -> int:
        return 73


class _SupervisorSocket:
    def __init__(self, events: list[str], port: int) -> None:
        self.events = events
        self.port = port
        self.close_calls = 0
        self._closed = False

    def getsockname(self) -> tuple[str, int]:
        return ("127.0.0.1", self.port)

    def fileno(self) -> int:
        return -1 if self._closed else 41

    def close(self) -> None:
        if not self._closed:
            self._closed = True
            self.close_calls += 1
            self.events.append("listener.close")


class _SupervisorServer:
    def __init__(
        self,
        events: list[str],
        listener: _SupervisorSocket,
        *,
        fail: bool = False,
    ) -> None:
        self.events = events
        self.listener = listener
        self.fail = fail
        self._should_exit = False
        self.seen: list[Any] | None = None

    @property
    def should_exit(self) -> bool:
        return self._should_exit

    @should_exit.setter
    def should_exit(self, value: bool) -> None:
        self._should_exit = value
        if value:
            self.events.append("api.stop")

    async def serve(self, *, sockets: list[Any]) -> None:
        self.seen = sockets
        self.events.append("api.serve")
        if self.fail:
            raise RuntimeError("api failed with secret-looking-value")
        while not self.should_exit:
            await asyncio.sleep(0.001)
        self.listener.close()


class _SupervisorProcess:
    def __init__(
        self,
        events: list[str],
        *,
        initial_returncode: int | None = None,
        output: bytes = b"",
    ) -> None:
        self.events = events
        self.returncode = initial_returncode
        self.stdout = io.BytesIO(output)
        self.stderr = io.BytesIO(output)
        self.terminate_calls = 0
        self.kill_calls = 0

    def poll(self) -> int | None:
        return self.returncode

    def wait(self, timeout: float | None = None) -> int:
        del timeout
        if self.returncode is None:
            self.returncode = 0
        return self.returncode

    def terminate(self) -> None:
        self.terminate_calls += 1
        self.events.append("jupyter.terminate")
        self.returncode = -signal.SIGTERM

    def kill(self) -> None:
        self.kill_calls += 1
        self.events.append("jupyter.kill")
        self.returncode = -signal.SIGKILL


class _UnstoppableProcess(_SupervisorProcess):
    def __init__(
        self,
        events: list[str],
        *,
        second_wait_error: BaseException,
        kill_error: BaseException | None = None,
        terminate_error: BaseException | None = None,
    ) -> None:
        super().__init__(events)
        self.second_wait_error = second_wait_error
        self.kill_error = kill_error
        self.terminate_error = terminate_error
        self.wait_calls = 0

    def wait(self, timeout: float | None = None) -> int:
        self.wait_calls += 1
        if self.wait_calls == 1:
            raise subprocess.TimeoutExpired("jupyterlab", timeout)
        raise self.second_wait_error

    def terminate(self) -> None:
        self.terminate_calls += 1
        self.events.append("jupyter.terminate")
        if self.terminate_error is not None:
            raise self.terminate_error

    def kill(self) -> None:
        self.kill_calls += 1
        self.events.append("jupyter.kill")
        if self.kill_error is not None:
            raise self.kill_error


class _FakeSignals:
    def __init__(self) -> None:
        self.handlers: dict[int, Any] = {}
        self.restored: list[int] = []

    def getsignal(self, signum: int) -> str:
        return f"previous-{signum}"

    def signal(self, signum: int, handler: Any) -> None:
        if isinstance(handler, str):
            self.restored.append(signum)
        else:
            self.handlers[signum] = handler


class _Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        self.now += 0.05
        return self.now


def _supervisor_fixture(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    api_fail: bool = False,
    process_returncode: int | None = None,
    course_ready: Any = None,
    jupyter_ready: Any = None,
    browser: Any = None,
    process_builder: Any = None,
) -> tuple[LaunchSupervisor, dict[str, Any]]:
    course = tmp_path / "course root with spaces"
    course.mkdir()
    events: list[str] = []
    lock = _SupervisorLock(events)
    listener = _SupervisorSocket(events, 43123)
    server = _SupervisorServer(events, listener, fail=api_fail)
    process = (
        process_builder(events)
        if process_builder is not None
        else _SupervisorProcess(
            events,
            initial_returncode=process_returncode,
            output=(b"token=owned-jupyter-secret\nowned-course-secret\n"),
        )
    )
    signals = _FakeSignals()
    secrets = iter(("owned-course-secret", "owned-jupyter-secret", "owned-runtime-id"))
    popen_calls: list[tuple[list[str], dict[str, Any]]] = []
    errors: list[str] = []
    course_calls: list[tuple[str, str]] = []
    jupyter_calls: list[tuple[Any, ...]] = []
    browser_calls: list[str] = []
    attempts = iter((False, False, True))

    def default_course_ready(url: str, token: str) -> bool:
        course_calls.append((url, token))
        return next(attempts)

    def default_jupyter_ready(*args: Any) -> bool:
        jupyter_calls.append(args)
        return True

    def default_browser(url: str) -> bool:
        browser_calls.append(url)
        process.returncode = 0
        return True

    def process_factory(argv: list[str], **kwargs: Any) -> _SupervisorProcess:
        popen_calls.append(
            (list(argv), {**kwargs, "env": dict(kwargs["env"])})
        )
        events.append("jupyter.spawn")
        return process

    monkeypatch.setenv("COURSEWEAVE_UNTRUSTED_PARENT_VALUE", "must-not-inherit")
    supervisor = LaunchSupervisor(
        course,
        port=43123,
        mode="author",
        lock_factory=lambda _root: lock,
        listener_factory=lambda _port: listener,
        api_server_factory=lambda _app, _port: server,
        process_factory=process_factory,
        browser_opener=browser or default_browser,
        course_ready=course_ready or default_course_ready,
        jupyter_ready=jupyter_ready or default_jupyter_ready,
        jupyter_port_factory=lambda: 45123,
        secret_factory=lambda _size: next(secrets),
        signal_api=signals,
        clock=_Clock(),
        sleep=lambda _delay: None,
        error_sink=errors.append,
        readiness_timeout=0.5,
        shutdown_timeout=0.5,
    )
    return supervisor, {
        "course": course,
        "events": events,
        "lock": lock,
        "listener": listener,
        "server": server,
        "process": process,
        "signals": signals,
        "popen_calls": popen_calls,
        "errors": errors,
        "course_calls": course_calls,
        "jupyter_calls": jupyter_calls,
        "browser_calls": browser_calls,
    }


def test_public_cli_retains_unconfirmed_child_runtime_and_lock_after_supervisor_gc(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    course = tmp_path / "course"
    course.mkdir()
    host_runtime = tmp_path / "host-runtime"
    host_runtime.mkdir()
    events: list[str] = []
    listener = _SupervisorSocket(events, 43123)
    server = _SupervisorServer(events, listener)
    errors: list[str] = []
    runtime_paths: list[tuple[Path, Path]] = []
    children: list[subprocess.Popen[bytes]] = []
    supervisor_refs: list[weakref.ReferenceType[LaunchSupervisor]] = []
    secrets = (
        "retained-course-secret",
        "retained-jupyter-secret",
        "retained-runtime-id",
    )

    def process_factory(_argv: list[str], **kwargs: Any) -> subprocess.Popen[bytes]:
        environment = kwargs["env"]
        config_dir = Path(environment["JUPYTER_CONFIG_DIR"])
        runtime_dir = Path(environment["JUPYTER_RUNTIME_DIR"])
        runtime_paths.append((config_dir, runtime_dir))
        script = (
            "import os,stat,time; from pathlib import Path; "
            "config=Path(os.environ['JUPYTER_CONFIG_DIR']); "
            "runtime=Path(os.environ['JUPYTER_RUNTIME_DIR']); "
            "assert config.is_dir() and runtime.is_dir(); "
            "assert stat.S_IMODE(config.stat().st_mode)==0o700; "
            "assert stat.S_IMODE(runtime.stat().st_mode)==0o700; "
            "(runtime/'child-ready').write_text('ready', encoding='utf-8'); "
            "os.close(1); os.close(2); "
            "time.sleep(60)"
        )
        child = subprocess.Popen(
            [os.sys.executable, "-c", script],
            cwd=kwargs["cwd"],
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=kwargs["stdout"],
            stderr=kwargs["stderr"],
            shell=False,
            start_new_session=False,
            pass_fds=kwargs["pass_fds"],
        )
        children.append(child)
        supervisor = supervisor_refs[0]()
        assert supervisor is not None
        supervisor._jupyter_shutdown_attempted = True
        return child

    def supervisor_factory(
        course_root: Path, *, port: int, mode: str
    ) -> LaunchSupervisor:
        generated_secrets = iter(secrets)
        supervisor = LaunchSupervisor(
            course_root,
            port=port,
            mode=mode,  # type: ignore[arg-type]
            lock_factory=lambda root: CourseLock(root, runtime_root=host_runtime),
            listener_factory=lambda _port: listener,
            api_server_factory=lambda _app, _port: server,
            process_factory=process_factory,
            browser_opener=lambda _url: False,
            course_ready=lambda _url, _token: True,
            jupyter_ready=lambda *_args: bool(
                runtime_paths
                and (runtime_paths[0][1] / "child-ready").is_file()
            ),
            jupyter_port_factory=lambda: 45123,
            secret_factory=lambda _size: next(generated_secrets),
            signal_api=_FakeSignals(),
            sleep=lambda _delay: time.sleep(0.01),
            error_sink=errors.append,
            readiness_timeout=5.0,
            shutdown_timeout=0.05,
        )
        supervisor_refs.append(weakref.ref(supervisor))
        return supervisor

    monkeypatch.setattr("courseweave.cli.LaunchSupervisor", supervisor_factory)
    retained_root: Path | None = None
    contender = CourseLock(course, runtime_root=host_runtime)
    try:
        result = CliRunner().invoke(
            app, ["launch", "--course-root", str(course), "--port", "43123"]
        )
        assert result.exit_code == 1
        del result
        gc.collect()

        assert len(supervisor_refs) == 1
        assert supervisor_refs[0]() is None
        assert len(runtime_paths) == 1
        config_dir, runtime_dir = runtime_paths[0]
        retained_root = config_dir.parent
        assert runtime_dir.parent == retained_root
        assert stat.S_IMODE(retained_root.stat().st_mode) == 0o700
        assert course not in retained_root.parents
        assert config_dir.is_dir()
        assert runtime_dir.is_dir()
        assert (runtime_dir / "child-ready").read_text(encoding="utf-8") == "ready"
        for path in retained_root.rglob("*"):
            if path.is_file():
                contents = path.read_bytes()
                assert all(secret.encode() not in contents for secret in secrets)

        try:
            with pytest.raises(CourseLockError, match="already running"):
                contender.acquire()
        finally:
            contender.release()

        assert len(children) == 1
        children[0].terminate()
        children[0].communicate(timeout=5.0)
        assert children[0].returncode == -signal.SIGTERM

        after_exit = CourseLock(course, runtime_root=host_runtime).acquire()
        after_exit.release()
        shutil.rmtree(retained_root)
        assert not retained_root.exists()
        retained_root = None

        assert listener.close_calls == 1
        assert "api.stop" in events
        assert errors == [
            "CourseWeave could not start the workspace. Check the course root, "
            "requested port, and JupyterLab installation, then retry."
        ]
        assert not any(
            thread.is_alive()
            and thread.name.startswith(("courseweave-api", "courseweave-jupyter-"))
            for thread in threading.enumerate()
        )
    finally:
        contender.release()
        for child in children:
            if child.poll() is None:
                child.kill()
            try:
                child.communicate(timeout=5.0)
            except subprocess.TimeoutExpired:
                child.kill()
                child.communicate(timeout=5.0)
        if retained_root is not None and retained_root.exists():
            shutil.rmtree(retained_root)
        if host_runtime.exists():
            shutil.rmtree(host_runtime)


def test_supervisor_hands_off_fd_retries_readiness_and_uses_fixed_secret_safe_child(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    supervisor, state = _supervisor_fixture(tmp_path, monkeypatch)
    before = sorted(path.relative_to(state["course"]) for path in state["course"].rglob("*"))

    assert supervisor.run() == 0

    assert state["server"].seen == [state["listener"]]
    assert state["server"].seen[0] is state["listener"]
    assert state["listener"].close_calls == 1
    assert state["lock"].release_calls == 1
    assert len(state["course_calls"]) == 3
    assert state["course_calls"][-1] == (
        "http://127.0.0.1:43123/api/course",
        "owned-course-secret",
    )
    assert len(state["popen_calls"]) == 1
    argv, kwargs = state["popen_calls"][0]
    assert argv[:3] == [os.sys.executable, "-m", "jupyterlab"]
    assert f"--ServerApp.root_dir={state['course'].resolve()}" in argv
    assert "--ServerApp.ip=127.0.0.1" in argv
    assert "--ServerApp.port=45123" in argv
    assert "--ServerApp.port_retries=0" in argv
    assert "--ServerApp.base_url=/courseweave/" in argv
    assert "--ServerApp.open_browser=False" in argv
    assert "--ServerApp.allow_remote_access=False" in argv
    assert "--ServerApp.use_redirect_file=False" in argv
    assert "--ServerApp.jpserver_extensions=courseweave.jupyter_runtime=True" in argv
    assert "--ServerApp.reraise_server_extension_failures=True" in argv
    assert not any("owned-" in item or "token=" in item for item in argv)
    assert kwargs["shell"] is False
    assert kwargs["cwd"] == state["course"].resolve()
    assert kwargs["stdin"] is subprocess.DEVNULL
    assert kwargs["stdout"] is subprocess.PIPE
    assert kwargs["stderr"] is subprocess.PIPE
    child_env = kwargs["env"]
    assert child_env["COURSEWEAVE_URL"] == "http://127.0.0.1:43123"
    assert child_env["COURSEWEAVE_CAPABILITY_TOKEN"] == "owned-course-secret"
    assert child_env["JUPYTER_TOKEN"] == "owned-jupyter-secret"
    assert child_env["COURSEWEAVE_RUNTIME_ID"] == "owned-runtime-id"
    assert child_env["COURSEWEAVE_LAUNCH_MODE"] == "author"
    assert "COURSEWEAVE_UNTRUSTED_PARENT_VALUE" not in child_env
    assert not Path(child_env["JUPYTER_RUNTIME_DIR"]).parent.exists()
    assert state["jupyter_calls"] == [
        (
            "http://127.0.0.1:45123/courseweave/",
            "owned-jupyter-secret",
            "owned-runtime-id",
            "owned-course-secret",
            "http://127.0.0.1:43123",
            "author",
        )
    ]
    assert len(state["browser_calls"]) == 1
    assert "owned-jupyter-secret" in state["browser_calls"][0]
    assert "owned-course-secret" not in state["browser_calls"][0]
    assert state["errors"] == []
    assert supervisor.capability_token is None
    assert supervisor.jupyter_token is None
    assert supervisor.runtime_id is None
    assert sorted(path.relative_to(state["course"]) for path in state["course"].rglob("*")) == before
    assert state["events"].index("jupyter.spawn") < state["events"].index("listener.close")
    assert state["events"].index("api.stop") < state["events"].index("listener.close")
    assert state["events"].index("listener.close") < state["events"].index("lock.release")
    supervisor._cleanup()
    assert state["listener"].close_calls == 1
    assert state["lock"].release_calls == 1


@pytest.mark.parametrize("command,mode", [("launch", "learn"), ("author", "author")])
def test_cli_modes_share_the_supervisor_and_propagate_status(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    command: str,
    mode: str,
) -> None:
    calls: list[tuple[Path, int, str]] = []

    class FakeSupervisor:
        def __init__(self, course_root: Path, *, port: int, mode: str) -> None:
            calls.append((course_root, port, mode))

        def run(self) -> int:
            return 23

    monkeypatch.setattr("courseweave.cli.LaunchSupervisor", FakeSupervisor)
    result = CliRunner().invoke(
        app, [command, "--course-root", str(tmp_path), "--port", "43124"]
    )

    assert result.exit_code == 23
    assert calls == [(tmp_path.resolve(), 43124, mode)]


@pytest.mark.parametrize("opener_behavior", [False, Exception("browser failure")])
def test_browser_failure_cleans_owned_resources_once_and_emits_one_safe_error(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    opener_behavior: object,
) -> None:
    def browser(_url: str) -> bool:
        if isinstance(opener_behavior, BaseException):
            raise opener_behavior
        return bool(opener_behavior)

    supervisor, state = _supervisor_fixture(tmp_path, monkeypatch, browser=browser)

    assert supervisor.run() == 1

    assert state["process"].terminate_calls == 1
    assert state["process"].kill_calls == 0
    assert state["listener"].close_calls == 1
    assert state["lock"].release_calls == 1
    assert len(state["errors"]) == 1
    assert "owned-course-secret" not in state["errors"][0]
    assert "owned-jupyter-secret" not in state["errors"][0]
    assert "?token=" not in state["errors"][0]


@pytest.mark.parametrize(
    ("second_wait_error", "terminate_error", "kill_error"),
    [
        (
            subprocess.TimeoutExpired("jupyterlab", 0.5),
            None,
            None,
        ),
        (
            RuntimeError("owned-jupyter-secret after kill"),
            RuntimeError("owned-course-secret during terminate"),
            RuntimeError("owned-jupyter-secret during kill"),
        ),
    ],
    ids=("second-timeout", "terminate-kill-and-second-wait-errors"),
)
def test_unconfirmed_jupyter_shutdown_contains_failures_and_keeps_lock_held(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    second_wait_error: BaseException,
    terminate_error: BaseException | None,
    kill_error: BaseException | None,
    capsys: pytest.CaptureFixture[str],
) -> None:
    supervisor, state = _supervisor_fixture(
        tmp_path,
        monkeypatch,
        browser=lambda _url: False,
        process_builder=lambda events: _UnstoppableProcess(
            events,
            second_wait_error=second_wait_error,
            terminate_error=terminate_error,
            kill_error=kill_error,
        ),
    )

    assert supervisor.run() == 1

    process = state["process"]
    assert process.terminate_calls == 1
    assert process.kill_calls == 1
    assert process.wait_calls == 2
    assert state["popen_calls"][0][1]["pass_fds"] == (73,)
    assert "api.stop" in state["events"]
    assert state["listener"].close_calls == 1
    assert state["lock"].release_calls == 0
    assert supervisor._jupyter_process is process
    assert supervisor._lock is state["lock"]
    assert len(state["errors"]) == 1
    assert "owned-course-secret" not in state["errors"][0]
    assert "owned-jupyter-secret" not in state["errors"][0]
    captured = capsys.readouterr()
    assert "owned-course-secret" not in captured.err
    assert "owned-jupyter-secret" not in captured.err

    supervisor._cleanup()
    assert process.terminate_calls == 1
    assert process.kill_calls == 1
    assert state["listener"].close_calls == 1
    assert state["lock"].release_calls == 0


def test_live_api_thread_downgrades_success_and_keeps_lock_held(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    supervisor, state = _supervisor_fixture(tmp_path, monkeypatch)

    class StuckApiThread:
        def __init__(self) -> None:
            self.join_calls = 0

        def join(self, timeout: float | None = None) -> None:
            del timeout
            self.join_calls += 1

        def is_alive(self) -> bool:
            return True

    api_thread = StuckApiThread()

    def start_stuck_api() -> None:
        supervisor._api_thread = api_thread  # type: ignore[assignment]
        supervisor._api_started.set()

    supervisor._start_api = start_stuck_api  # type: ignore[method-assign]

    assert supervisor.run() == 1

    assert api_thread.join_calls == 1
    assert "api.stop" in state["events"]
    assert state["listener"].close_calls == 1
    assert state["lock"].release_calls == 0
    assert supervisor._api_thread is api_thread
    assert supervisor._lock is state["lock"]
    assert len(state["errors"]) == 1
    assert "owned-course-secret" not in state["errors"][0]
    assert "owned-jupyter-secret" not in state["errors"][0]

    supervisor._cleanup()
    assert api_thread.join_calls == 2
    assert state["listener"].close_calls == 1
    assert state["lock"].release_calls == 0


def test_cleanup_step_errors_do_not_skip_later_independently_safe_actions(
    tmp_path: Path,
) -> None:
    events: list[str] = []

    class FaultingOutputThread:
        def join(self, timeout: float | None = None) -> None:
            del timeout
            events.append("output.join")
            raise RuntimeError("owned-jupyter-secret from output join")

        def is_alive(self) -> bool:
            return False

    class FaultingServer:
        @property
        def should_exit(self) -> bool:
            return False

        @should_exit.setter
        def should_exit(self, _value: bool) -> None:
            events.append("api.stop")
            raise RuntimeError("owned-course-secret from API stop")

    class FaultingApiThread:
        def join(self, timeout: float | None = None) -> None:
            del timeout
            events.append("api.join")
            raise RuntimeError("owned-jupyter-secret from API join")

        def is_alive(self) -> bool:
            return False

    class ClosingListener:
        def fileno(self) -> int:
            return 91

        def close(self) -> None:
            events.append("listener.close")

    class FaultingLock:
        def release(self) -> None:
            events.append("lock.release")
            raise RuntimeError("owned-course-secret from lock release")

    class FaultingTemporaryDirectory:
        def cleanup(self) -> None:
            events.append("temporary.cleanup")
            raise RuntimeError("owned-jupyter-secret from temporary cleanup")

    class FaultingEnvironment(dict[str, str]):
        def clear(self) -> None:
            events.append("environment.clear")
            raise RuntimeError("owned-course-secret from environment clear")

    class FaultingSignals(_FakeSignals):
        def signal(self, signum: int, handler: Any) -> None:
            if isinstance(handler, str):
                events.append(f"signal.restore.{signum}")
                if signum == signal.SIGINT:
                    raise RuntimeError("owned-jupyter-secret from signal restore")
            super().signal(signum, handler)

    supervisor = LaunchSupervisor(tmp_path, signal_api=FaultingSignals())
    process = _SupervisorProcess(events, initial_returncode=0)
    lock = FaultingLock()
    temporary = FaultingTemporaryDirectory()
    environment = FaultingEnvironment(secret="owned-course-secret")
    supervisor._jupyter_process = process
    supervisor._output_threads = [FaultingOutputThread()]  # type: ignore[list-item]
    supervisor._api_server = FaultingServer()
    supervisor._api_thread = FaultingApiThread()  # type: ignore[assignment]
    supervisor._listener = ClosingListener()
    supervisor._lock = lock
    supervisor._temporary_directory = temporary  # type: ignore[assignment]
    supervisor._child_environment = environment
    supervisor.capability_token = "owned-course-secret"
    supervisor.jupyter_token = "owned-jupyter-secret"
    supervisor.runtime_id = "owned-runtime-id"
    supervisor._previous_handlers = {
        signal.SIGINT: f"previous-{signal.SIGINT}",
        signal.SIGTERM: f"previous-{signal.SIGTERM}",
    }

    assert supervisor._cleanup() is False

    assert events == [
        "output.join",
        "api.stop",
        "api.join",
        "listener.close",
        "lock.release",
        "temporary.cleanup",
        "environment.clear",
        f"signal.restore.{signal.SIGINT}",
        f"signal.restore.{signal.SIGTERM}",
    ]
    assert supervisor._lock is lock
    assert supervisor._temporary_directory is temporary
    assert supervisor._child_environment is None
    assert supervisor.capability_token is None
    assert supervisor.jupyter_token is None
    assert supervisor.runtime_id is None
    assert signal.SIGINT in supervisor._previous_handlers
    assert signal.SIGTERM not in supervisor._previous_handlers


def test_listener_close_error_retains_lock_but_continues_secret_and_signal_cleanup(
    tmp_path: Path,
) -> None:
    events: list[str] = []

    class FaultingListener:
        def fileno(self) -> int:
            return 92

        def close(self) -> None:
            events.append("listener.close")
            raise RuntimeError("owned-jupyter-secret from listener close")

    class RecordingLock:
        release_calls = 0

        def release(self) -> None:
            self.release_calls += 1

    class RecordingTemporaryDirectory:
        def cleanup(self) -> None:
            events.append("temporary.cleanup")

    class RecordingEnvironment(dict[str, str]):
        def clear(self) -> None:
            events.append("environment.clear")
            super().clear()

    class RecordingSignals(_FakeSignals):
        def signal(self, signum: int, handler: Any) -> None:
            if isinstance(handler, str):
                events.append(f"signal.restore.{signum}")
            super().signal(signum, handler)

    signals = RecordingSignals()
    supervisor = LaunchSupervisor(tmp_path, signal_api=signals)
    lock = RecordingLock()
    supervisor._listener = FaultingListener()
    supervisor._lock = lock
    supervisor._temporary_directory = RecordingTemporaryDirectory()  # type: ignore[assignment]
    supervisor._child_environment = RecordingEnvironment(secret="owned-course-secret")
    supervisor.capability_token = "owned-course-secret"
    supervisor.jupyter_token = "owned-jupyter-secret"
    supervisor.runtime_id = "owned-runtime-id"
    supervisor._previous_handlers = {
        signal.SIGINT: f"previous-{signal.SIGINT}",
        signal.SIGTERM: f"previous-{signal.SIGTERM}",
    }

    assert supervisor._cleanup() is False

    assert lock.release_calls == 0
    assert events == [
        "listener.close",
        "temporary.cleanup",
        "environment.clear",
        f"signal.restore.{signal.SIGINT}",
        f"signal.restore.{signal.SIGTERM}",
    ]
    assert supervisor.capability_token is None
    assert supervisor.jupyter_token is None
    assert supervisor.runtime_id is None


def test_api_failure_prevents_jupyter_spawn_and_reports_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    supervisor, state = _supervisor_fixture(tmp_path, monkeypatch, api_fail=True)

    assert supervisor.run() == 1

    assert state["popen_calls"] == []
    assert state["listener"].close_calls == 1
    assert state["lock"].release_calls == 1
    assert len(state["errors"]) == 1
    assert "secret-looking-value" not in state["errors"][0]


def test_listener_setup_failure_releases_lock_without_starting_a_child(
    tmp_path: Path,
) -> None:
    events: list[str] = []
    lock = _SupervisorLock(events)
    signals = _FakeSignals()
    errors: list[str] = []

    def unavailable_listener(_port: int) -> object:
        raise OSError("unavailable with secret-looking-value")

    supervisor = LaunchSupervisor(
        tmp_path,
        lock_factory=lambda _root: lock,
        listener_factory=unavailable_listener,
        signal_api=signals,
        error_sink=errors.append,
    )

    assert supervisor.run() == 1
    assert events == ["lock.acquire", "lock.release"]
    assert lock.release_calls == 1
    assert len(errors) == 1
    assert "secret-looking-value" not in errors[0]
    assert sorted(signals.restored) == sorted((signal.SIGINT, signal.SIGTERM))


@pytest.mark.parametrize("signum", [signal.SIGINT, signal.SIGTERM])
def test_signal_stops_only_owned_handles_in_required_order(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, signum: int
) -> None:
    unrelated_events: list[str] = []

    def browser(_url: str) -> bool:
        unrelated_events.append("unrelated-still-running")
        state["signals"].handlers[signum](signum, None)
        return True

    supervisor, state = _supervisor_fixture(tmp_path, monkeypatch, browser=browser)

    assert supervisor.run() == 128 + signum

    assert unrelated_events == ["unrelated-still-running"]
    assert state["process"].terminate_calls == 1
    assert state["events"].index("jupyter.terminate") < state["events"].index("api.stop")
    assert state["events"].index("api.stop") < state["events"].index("listener.close")
    assert state["events"].index("listener.close") < state["events"].index("lock.release")
    assert sorted(state["signals"].restored) == sorted((signal.SIGINT, signal.SIGTERM))


def test_signal_during_api_readiness_is_a_clean_owned_shutdown(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    state_ref: dict[str, Any] = {}

    def interrupt_readiness(_url: str, _token: str) -> bool:
        state_ref["signals"].handlers[signal.SIGINT](signal.SIGINT, None)
        return False

    supervisor, state = _supervisor_fixture(
        tmp_path, monkeypatch, course_ready=interrupt_readiness
    )
    state_ref.update(state)

    assert supervisor.run() == 128 + signal.SIGINT
    assert state["popen_calls"] == []
    assert state["errors"] == []
    assert state["listener"].close_calls == 1
    assert state["lock"].release_calls == 1


def test_early_jupyter_exit_and_missing_hook_fail_closed_without_browser(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    exited, exited_state = _supervisor_fixture(
        tmp_path, monkeypatch, process_returncode=17
    )
    assert exited.run() == 17
    assert exited_state["browser_calls"] == []

    second_root = tmp_path / "second"
    second_root.mkdir()
    missing, missing_state = _supervisor_fixture(
        second_root,
        monkeypatch,
        jupyter_ready=lambda *_args: False,
    )
    assert missing.run() == 1
    assert missing_state["browser_calls"] == []
    assert missing_state["process"].terminate_calls == 1
    assert len(missing_state["errors"]) == 1


def test_diagnostic_redaction_covers_exact_secrets_and_token_url_variants() -> None:
    course_token = "course-secret-value"
    jupyter_token = "jupyter-secret-value"
    message = (
        "failed course-secret-value at "
        "http://127.0.0.1:9999/lab?token=jupyter-secret-value&next=%2Flab "
        "Authorization: token jupyter-secret-value"
    )

    redacted = _redact_diagnostic(message, (course_token, jupyter_token))

    assert course_token not in redacted
    assert jupyter_token not in redacted
    assert "token=[REDACTED]" in redacted
    assert "Authorization: [REDACTED]" in redacted


def test_output_capture_swallows_secret_bearing_stream_exceptions(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    supervisor = LaunchSupervisor(tmp_path)
    supervisor.capability_token = "owned-course-secret"
    supervisor.jupyter_token = "owned-jupyter-secret"

    class FailingStream:
        def read(self, _size: int) -> bytes:
            raise RuntimeError("owned-jupyter-secret")

    supervisor._drain_output(FailingStream())

    captured = capsys.readouterr()
    assert "owned-jupyter-secret" not in captured.out
    assert "owned-jupyter-secret" not in captured.err


@pytest.mark.parametrize("mode", ["learn", "author"])
def test_real_jupyter_launch_keeps_live_runtime_files_secret_free_and_relays_work(
    tmp_path: Path, mode: str,
) -> None:
    """Bounded proof of the exact Server 2.21 argv/env and extension hook."""

    errors: list[str] = []
    observations: dict[str, object] = {}
    course = tmp_path / "real course with spaces"
    course.mkdir()
    before = sorted(path.relative_to(course) for path in course.rglob("*"))

    def open_and_probe(bootstrap_url: str) -> bool:
        assert supervisor.capability_token is not None
        assert supervisor.jupyter_token is not None
        assert supervisor._temporary_directory is not None
        jupyter_base = bootstrap_url.rsplit("lab?token=", 1)[0]
        runtime_dir = Path(supervisor._temporary_directory.name) / "runtime"
        for path in runtime_dir.rglob("*"):
            if not path.is_file():
                continue
            contents = path.read_bytes()
            if (
                supervisor.capability_token.encode() in contents
                or supervisor.jupyter_token.encode() in contents
            ):
                pytest.fail(
                    "a live Jupyter runtime file retained a generated credential",
                    pytrace=False,
                )
        assert not list(runtime_dir.glob("*-open.html"))

        auth = {"Authorization": f"token {supervisor.jupyter_token}"}
        course_request = urllib.request.Request(
            f"{jupyter_base}courseweave/course", headers=auth
        )
        with urllib.request.urlopen(course_request, timeout=2) as response:
            observations["course_status"] = response.status
            observations["course_etag"] = response.headers["ETag"]
            observations["course"] = json.loads(response.read())

        context = {
            "source_id": "real-jupyter-proof",
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
        context_request = urllib.request.Request(
            f"{jupyter_base}courseweave/context",
            headers={**auth, "Content-Type": "application/json"},
            data=json.dumps(context).encode("utf-8"),
            method="POST",
        )
        with urllib.request.urlopen(context_request, timeout=2) as response:
            observations["context_status"] = response.status
            observations["context"] = json.loads(response.read())
        supervisor._request_stop(signal.SIGTERM, None)
        return True

    supervisor = LaunchSupervisor(
        course,
        port=0,
        mode=mode,  # type: ignore[arg-type]
        browser_opener=open_and_probe,
        error_sink=errors.append,
        readiness_timeout=30.0,
        shutdown_timeout=10.0,
    )

    assert supervisor.run() == 128 + signal.SIGTERM

    assert errors == []
    assert observations["course_status"] == 200
    assert observations["course_etag"] == '""'
    assert observations["course"]["schema_version"] == 1  # type: ignore[index]
    assert observations["context_status"] == 200
    assert set(observations["context"]) == {  # type: ignore[arg-type]
        "module_id",
        "phase_id",
        "surface_id",
        "reason",
    }
    assert sorted(path.relative_to(course) for path in course.rglob("*")) == before
    assert not (course / "courseweave.json").exists()
    assert not (course / ".courseweave").exists()
