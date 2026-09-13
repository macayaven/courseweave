"""The local pilot launcher binds receipts and requires explicit provider selection."""
from pathlib import Path
import importlib.machinery
import importlib.util
import json
import os
import hashlib
import pytest
import sys

ROOT = Path(__file__).resolve().parents[1]


def launcher():
    loader = importlib.machinery.SourceFileLoader('pilot_launcher', str(ROOT / 'scripts/pilot'))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(ROOT / "scripts"))
    try:
        loader.exec_module(module)
    finally:
        sys.path.pop(0)
    return module


def test_default_launch_does_not_inherit_provider_secrets(monkeypatch):
    pilot = launcher()
    monkeypatch.setenv('OPENAI_API_KEY', 'unrelated-synthetic-provider-secret')
    monkeypatch.setenv('ANTHROPIC_API_KEY', 'unrelated-anthropic-secret')
    monkeypatch.setenv('COURSEWEAVE_PROVIDER', 'openai')
    monkeypatch.setenv('AGENT_KB_LITELLM_KEY', 'unrelated-synthetic-gateway-secret')
    monkeypatch.setenv('COURSEWEAVE_CAPABILITY_TOKEN', 'unrelated-capability')
    environment, assistant = pilot.student_environment(
        no_provider=False, provider_env=False, provider=None, model=None, base_url=None,
    )
    assert not any(key in environment for key in (
        'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'AGENT_KB_LITELLM_KEY',
        'COURSEWEAVE_CAPABILITY_TOKEN',
    ))
    assert 'COURSEWEAVE_PROVIDER' not in environment
    assert 'off' in assistant


@pytest.mark.parametrize('provider', ['openai', 'anthropic'])
def test_provider_environment_is_used_only_after_explicit_selection(monkeypatch, provider):
    pilot = launcher()
    prefix = provider.upper()
    other = 'ANTHROPIC' if provider == 'openai' else 'OPENAI'
    monkeypatch.setenv('COURSEWEAVE_PROVIDER', provider)
    monkeypatch.setenv(f'{prefix}_MODEL', 'explicit-model')
    monkeypatch.setenv(f'{prefix}_API_KEY', 'explicit-synthetic-key')
    monkeypatch.setenv(f'{other}_API_KEY', 'unrelated-provider-key')
    environment, assistant = pilot.student_environment(
        no_provider=False, provider_env=True, provider=None, model=None, base_url=None,
    )
    assert environment[f'{prefix}_API_KEY'] == 'explicit-synthetic-key'
    assert environment[f'{prefix}_MODEL'] == 'explicit-model'
    assert environment['COURSEWEAVE_PROVIDER_PROFILE'] == 'text-only-v1'
    assert f'{other}_API_KEY' not in environment
    assert 'configured' in assistant


def test_launcher_binds_artifact_and_interpreters_and_preserves_venv_argv(tmp_path, monkeypatch):
    pilot = launcher()
    owned=tmp_path/'.pilot';owned.mkdir()
    wheel=owned/'courseweave.whl';wheel.write_bytes(b'synthetic wheel')
    platform=owned/'runtime/bin/python';platform.parent.mkdir(parents=True);platform.symlink_to('/usr/bin/python3')
    course=tmp_path/'course';course.mkdir()
    kernel=course/'.venv/bin/python';kernel.parent.mkdir(parents=True);kernel.symlink_to('/usr/bin/python3')
    receipt={'wheel':'courseweave.whl','wheel_sha256':hashlib.sha256(wheel.read_bytes()).hexdigest(), 'platform_python':str(platform),'course_root':str(course),'kernel_python':str(kernel)}
    (owned/'receipt.json').write_text(json.dumps(receipt))
    calls=[]
    monkeypatch.setattr(os,'execve',lambda *args:calls.append(args))
    pilot.main(['--no-provider'], root=tmp_path)
    executable,argv,env=calls[0]
    assert executable == str(platform)
    assert argv == [str(platform),'-I','-m','courseweave','launch','--course-root',str(course),'--kernel-python',str(kernel),'--state-dir',str(owned/'user-state'),'--port','8765']
    assert 'OPENAI_API_KEY' not in env
    wheel.write_bytes(b'wrong wheel')
    with pytest.raises(ValueError,match='artifact'):pilot.main(['--no-provider'],root=tmp_path)
    assert len(calls)==1
