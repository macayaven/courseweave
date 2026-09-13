"""Course interpreter selection and supervised startup credential custody."""
import json
import os
import sys
from pathlib import Path

import pytest
from typer.testing import CliRunner

from courseweave.cli import app
from courseweave.launch import LaunchSupervisor
from courseweave.jupyter_runtime import _load_jupyter_server_extension
from test_jupyter_runtime import _FakeServerApp, valid_environment
from jupyter_server.auth.identity import IdentityProvider


@pytest.mark.parametrize('command', ['launch', 'author'])
def test_cli_preserves_explicit_venv_interpreter(tmp_path, monkeypatch, command):
    python = tmp_path / 'course venv' / 'bin' / 'python'
    python.parent.mkdir(parents=True)
    python.symlink_to(sys.executable)
    calls = []
    class Supervisor:
        def __init__(self, root, **kwargs): calls.append(kwargs)
        def run(self): return 0
    monkeypatch.setattr('courseweave.cli.LaunchSupervisor', Supervisor)
    result = CliRunner().invoke(app, [command, '--course-root', str(tmp_path), '--kernel-python', str(python)])
    assert result.exit_code == 0, result.output
    assert str(calls[0]['kernel_python']) == str(python)


def test_course_kernel_spec_is_only_allowed_default_and_preserves_symlink(tmp_path):
    python = tmp_path / 'course venv' / 'bin' / 'python'
    python.parent.mkdir(parents=True)
    python.symlink_to(sys.executable)
    (python.parent.parent / 'pyvenv.cfg').write_text((Path(sys.prefix) / 'pyvenv.cfg').read_text())
    (python.parent.parent / 'lib').symlink_to(Path(sys.prefix) / 'lib', target_is_directory=True)
    supervisor = LaunchSupervisor(tmp_path, kernel_python=python)
    kernel_root = tmp_path / 'owned kernels'
    supervisor._prepare_course_kernel(kernel_root)
    spec = json.loads((kernel_root / 'python3' / 'kernel.json').read_text())
    assert spec['argv'] == [str(python), '-m', 'ipykernel_launcher', '-f', '{connection_file}']
    assert 'env' not in spec
    argv = supervisor._build_jupyter_argv(43210)
    assert '--KernelSpecManager.ensure_native_kernel=False' in argv
    assert '--KernelSpecManager.allowed_kernelspecs=["python3"]' in argv
    assert '--MappingKernelManager.default_kernel_name=python3' in argv
    assert '--ServerApp.kernel_spec_manager_class=courseweave.jupyter_runtime.CourseKernelSpecManager' in argv
    assert '--CourseKernelSpecManager.course_kernel_dir=' + str(kernel_root) in argv


def test_kernel_interpreter_requires_ipykernel_before_start(tmp_path):
    python = tmp_path / 'not-python'
    python.write_text('#!/bin/sh\nexit 9\n')
    python.chmod(0o700)
    with pytest.raises(ValueError, match='ipykernel'):
        LaunchSupervisor(tmp_path, kernel_python=python)


def test_extension_captures_lazy_login_token_then_removes_startup_credentials(monkeypatch):
    for key, value in valid_environment().items(): monkeypatch.setenv(key, value)
    monkeypatch.setenv('JUPYTER_TOKEN', 'synthetic-login-token')
    server = _FakeServerApp()
    server.identity_provider = IdentityProvider()
    assert 'token' not in server.identity_provider._trait_values
    _load_jupyter_server_extension(server)
    assert server.identity_provider.token == 'synthetic-login-token'
    assert server.web_app.settings['courseweave_runtime_settings'] is not None
    assert 'COURSEWEAVE_CAPABILITY_TOKEN' not in os.environ
    assert 'JUPYTER_TOKEN' not in os.environ


def test_actual_jupyter_manager_uses_owned_spec_and_never_falls_back(tmp_path, monkeypatch):
    from traitlets.config import Application
    from traitlets.utils.importstring import import_item
    from jupyter_client.kernelspec import NoSuchKernel
    import shutil
    supervisor = LaunchSupervisor(tmp_path, kernel_python=Path(sys.executable))
    owned = tmp_path/'owned'; supervisor._prepare_course_kernel(owned)
    foreign = tmp_path/'foreign/kernels/python3';foreign.mkdir(parents=True)
    (foreign/'kernel.json').write_text(json.dumps({'argv':['wrong-python'],'display_name':'Wrong','language':'python'}))
    monkeypatch.setenv('JUPYTER_PATH',str(tmp_path/'foreign'))
    application = Application()
    application.parse_command_line(supervisor._build_jupyter_argv(54321)[3:])
    manager_type = application.config.ServerApp.get('kernel_spec_manager_class', 'jupyter_client.kernelspec.KernelSpecManager')
    manager = import_item(manager_type)(config=application.config)
    assert manager.get_kernel_spec('python3').argv[0] == sys.executable
    assert manager.find_kernel_specs() == {'python3':str(owned/'python3')}
    shutil.rmtree(owned/'python3')
    assert manager.find_kernel_specs() == {}
    with pytest.raises(NoSuchKernel):manager.get_kernel_spec('python3')
