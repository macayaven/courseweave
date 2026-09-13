#!/usr/bin/env python3
"""Standalone student release entry point; only the Python standard library."""
from __future__ import annotations

import argparse
import fcntl
import getpass
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import pwd
import re
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
from urllib.parse import urlsplit, urlunsplit
import warnings

SAFE_ENV = ('HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LOGNAME', 'PATH', 'SHELL',
            'SSL_CERT_DIR', 'SSL_CERT_FILE', 'TMPDIR', 'USER', 'BROWSER')
SAFE_VERSION = re.compile(r'[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*')


class PilotError(ValueError):
    """An actionable student-facing error, safe to print."""


def clean_environment() -> dict[str, str]:
    return {key: os.environ[key] for key in SAFE_ENV if key in os.environ}


def student_environment(*, no_provider: bool, provider_env: bool,
                        provider: str | None, model: str | None,
                        base_url: str | None):
    environment = clean_environment()
    if provider_env:
        selected = os.environ.get('COURSEWEAVE_PROVIDER', '').strip()
        if selected not in ('openai', 'anthropic'):
            raise PilotError('--provider-env requires COURSEWEAVE_PROVIDER=openai or anthropic. See README.md.')
        prefix = selected.upper()
        for key in (f'{prefix}_MODEL', f'{prefix}_API_KEY'):
            if not os.environ.get(key, '').strip():
                raise PilotError(f'--provider-env requires {key} in this terminal. See README.md.')
            environment[key] = os.environ[key]
        for key in (f'{prefix}_BASE_URL', 'COURSEWEAVE_PROVIDER_TIMEOUT_SECONDS',
                    'COURSEWEAVE_PROVIDER_RUN_TIMEOUT_SECONDS', 'COURSEWEAVE_PROVIDER_MAX_OUTPUT_TOKENS'):
            if key in os.environ:
                environment[key] = os.environ[key]
        environment.update(COURSEWEAVE_PROVIDER=selected, COURSEWEAVE_PROVIDER_PROFILE='text-only-v1')
        return environment, 'configured from this terminal; connection is checked when you ask a question'
    if provider:
        if not model or not model.strip():
            raise PilotError('--provider requires --model. See README.md for examples.')
        if not sys.stdin.isatty():
            raise PilotError('--provider securely prompts for an API key and requires an interactive terminal. Use --provider-env for automation.')
        try:
            with warnings.catch_warnings():
                warnings.simplefilter('error', getpass.GetPassWarning)
                key = getpass.getpass(f'{provider.title()} API key (input hidden): ')
        except getpass.GetPassWarning:
            raise PilotError('CourseWeave could not guarantee hidden API-key input. Use a terminal with hidden input support or --provider-env.') from None
        except EOFError:
            raise PilotError('CourseWeave could not securely prompt for an API key. Use an interactive terminal or --provider-env.') from None
        if not key.strip():
            raise PilotError('No API key was entered. Start again or use --no-provider.')
        prefix = provider.upper()
        environment.update({
            'COURSEWEAVE_PROVIDER': provider,
            'COURSEWEAVE_PROVIDER_PROFILE': 'text-only-v1',
            f'{prefix}_MODEL': model.strip(),
            f'{prefix}_API_KEY': key,
        })
        if base_url:
            environment[f'{prefix}_BASE_URL'] = base_url
        return environment, f'{provider} configured for this launch; connection is checked when you ask a question'
    return environment, 'off — reading, notebooks and self-checks remain available'


def safe_course_version(value) -> str:
    if not isinstance(value, str) or len(value) > 64 or not SAFE_VERSION.fullmatch(value):
        raise PilotError('This student release has a missing or unsafe course version. Use a fresh complete release.')
    return value


def local_path(path: Path, label: str) -> Path:
    resolved = path.expanduser().absolute().resolve(strict=False)
    homes = [Path.home()]
    try:
        homes.append(Path(pwd.getpwuid(os.getuid()).pw_dir))
    except (KeyError, OSError):
        pass
    for home in homes:
        try:
            relative = resolved.relative_to(home.expanduser().absolute().resolve(strict=False))
        except ValueError:
            continue
        parts = relative.parts
        in_icloud = len(parts) >= 2 and parts[:2] == ('Library', 'Mobile Documents')
        in_google_drive = (
            len(parts) >= 3 and parts[:2] == ('Library', 'CloudStorage')
            and parts[2].startswith('GoogleDrive-')
        )
        if in_icloud or in_google_drive:
            raise PilotError(f'The {label} resolves inside cloud-synced storage. Choose a nonsynced local location.')
    return resolved


def owned_path(home: Path, name: str) -> Path:
    path = home / name
    if path.resolve(strict=False) != path.absolute():
        raise PilotError(f'The study folder {name} path is a redirected link. Remove the link or choose a different --home; nothing was changed.')
    return path


def load_release(root: Path) -> dict:
    try:
        data = json.loads((root / 'release.json').read_text())
        if not isinstance(data, dict) or data['format_version'] != 1:
            raise ValueError()
        safe_course_version(data.get('course_version'))
        for key in ('wheel', 'course', 'constraints'):
            item = data['files'][key]
            name = item['path']
            if not isinstance(name, str) or Path(name).name != name or name in ('', '.', '..'):
                raise ValueError()
            path = root / name
            if path.is_symlink() or not path.is_file():
                raise ValueError()
            if hashlib.sha256(path.read_bytes()).hexdigest() != item['sha256']:
                raise PilotError(f'The release is damaged ({name} hash mismatch). Use a fresh copy of the release; your study files are separate.')
        return data
    except PilotError:
        raise
    except (OSError, ValueError, KeyError, TypeError):
        raise PilotError('This student release is incomplete. Keep the Start command, student_pilot.py, release.json and artifact files together.') from None


def prepare_course(root: Path, data: dict, home: Path) -> Path:
    course = owned_path(home, 'course')
    digest = data['files']['course']['sha256']
    marker = course / '.student-course.json'
    if course.exists():
        try:
            same = json.loads(marker.read_text())['archive_sha256'] == digest
        except (OSError, ValueError, KeyError, TypeError):
            same = False
        if not same:
            raise PilotError('This study folder contains a different course edition or unrecognized files. Nothing was replaced. Keep it and select a new folder with --home for the new edition.')
        return course
    stage = Path(tempfile.mkdtemp(prefix='.course-setup-', dir=home))
    try:
        with tarfile.open(root / data['files']['course']['path']) as archive:
            members = archive.getmembers()
            for member in members:
                path = PurePosixPath(member.name)
                if path.is_absolute() or '..' in path.parts or not (member.isfile() or member.isdir()):
                    raise PilotError('The course archive contains an unsafe path or link. Use a fresh release.')
            for member in members:
                target = stage / member.name
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with archive.extractfile(member) as source, target.open('wb') as destination:
                        shutil.copyfileobj(source, destination)
                    target.chmod(0o700 if member.mode & 0o111 else 0o600)
        if not (stage / 'courseweave.json').is_file():
            raise PilotError('The course archive has no course manifest. Use a complete release.')
        (stage / '.student-course.json').write_text(json.dumps({'archive_sha256': digest, 'course_commit': data['course_commit']}) + '\n')
        stage.rename(course)
        return course
    except tarfile.TarError:
        raise PilotError('The course archive could not be read. Use a fresh release.') from None
    finally:
        if stage.exists():
            shutil.rmtree(stage)


def runtime_paths(data: dict, home: Path):
    identity = data['files']['wheel']['sha256'][:16] + '-' + data['files']['constraints']['sha256'][:16]
    owned_path(home, 'runtimes')
    relative = f'runtimes/{identity}'
    runtime = owned_path(home, relative)
    owned_path(home, f'{relative}/platform')
    platform_bin = owned_path(home, f'{relative}/platform/bin')
    owned_path(home, f'{relative}/kernel')
    kernel_bin = owned_path(home, f'{relative}/kernel/bin')
    owned_path(home, f'{relative}/ready.json')
    return runtime, platform_bin / 'python', kernel_bin / 'python'


def setup_environment():
    environment = clean_environment()
    environment.update(UV_LINK_MODE='copy', UV_NO_PROGRESS='1', UV_PYTHON_DOWNLOADS='automatic')
    return environment


def run_setup(command: list[str], label: str):
    try:
        result = subprocess.run(command, env=setup_environment(), stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=600)
    except (OSError, subprocess.TimeoutExpired):
        raise PilotError(f'{label} could not finish. Check internet access and available disk space, then start again. Saved course work is preserved.') from None
    if result.returncode:
        def public_url(match):
            try:
                url = urlsplit(match.group())
                return urlunsplit((url.scheme, url.hostname or '[host]', url.path, '', ''))
            except ValueError:
                return '[redacted URL]'
        diagnostic = re.sub(r'https?://[^\s<>"\']+', public_url, result.stderr.decode('utf-8', errors='replace'))
        lines = [line.strip() for line in diagnostic.splitlines() if line.strip()]
        cause = next((line for line in lines if line.lower().startswith('error:')), lines[-1] if lines else 'The setup command failed.')[:600]
        raise PilotError(f'{label} failed (exit {result.returncode}). {cause}\nCorrect the reported issue, then start again. Saved course work is preserved.')


def runtime_ready(data: dict, home: Path) -> bool:
    runtime, platform, kernel = runtime_paths(data, home)
    if not (runtime / 'ready.json').is_file() or not platform.is_file() or not kernel.is_file():
        return False
    probes = [
        (platform, 'import courseweave.contracts, jupyterlab; from typing import get_args; assert get_args(courseweave.contracts.CourseManifest.model_fields["schema_version"].annotation) == (2,)'),
        (kernel, 'import ipykernel; import importlib.util; assert importlib.util.find_spec("courseweave") is None'),
    ]
    for python, code in probes:
        try:
            result = subprocess.run([str(python), '-I', '-c', code], env=setup_environment(),
                                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
        except (OSError, subprocess.TimeoutExpired):
            return False
        if result.returncode:
            return False
    return True


def course_ready(data: dict, home: Path) -> bool:
    course = home / 'course'
    try:
        if json.loads((course / '.student-course.json').read_text())['archive_sha256'] != data['files']['course']['sha256']:
            return False
        if not (course / 'courseweave.json').is_file():
            return False
        _, platform, _ = runtime_paths(data, home)
        result = subprocess.run([str(platform), '-I', '-m', 'courseweave', 'validate', '--course-root', str(course)],
                                env=setup_environment(), stdin=subprocess.DEVNULL,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
        return result.returncode == 0
    except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired):
        return False


def ensure_runtime(root: Path, data: dict, home: Path, uv: str):
    runtime, platform, kernel = runtime_paths(data, home)
    if runtime_ready(data, home):
        return platform, kernel
    runtime.mkdir(parents=True, exist_ok=True)
    constraints = root / data['files']['constraints']['path']
    print('Setting up CourseWeave. First setup needs internet; later starts reuse these environments.', flush=True)
    for number, python, version, packages in (
        (1, platform, '3.11', [(root / data['files']['wheel']['path']).absolute().as_uri(), 'jupyterlab==4.6.3']),
        (2, kernel, '3.12', ['ipykernel==7.3.0']),
    ):
        print(f'  {number}/3 Preparing {"application" if number == 1 else "notebook"} environment…', flush=True)
        if not python.is_file():
            run_setup([uv, '--no-config', 'venv', '--python', version, str(python.parent.parent)], 'Python setup')
        # uv treats constraint inputs as requirement sources: encode spaces in a file URI.
        run_setup([uv, '--no-config', 'pip', 'install', '--python', str(python), '--constraint', constraints.absolute().as_uri(), *packages], 'Dependency installation')
    (runtime / 'ready.json').write_text(json.dumps({'wheel_sha256': data['files']['wheel']['sha256']}) + '\n')
    if not runtime_ready(data, home):
        (runtime / 'ready.json').unlink(missing_ok=True)
        raise PilotError('The installed application or notebook environment failed its check. Run the Start command again to repair setup.')
    print('  3/3 Application and notebook environments checked.', flush=True)
    return platform, kernel


def default_home(course_version: str) -> Path:
    if sys.platform == 'darwin':
        return Path.home() / f'Library/Application Support/CourseWeave/Agent Harness Path v{course_version}'
    configured = os.environ.get('XDG_DATA_HOME', '')
    data_home = Path(configured).expanduser() if configured else Path.home() / '.local/share'
    if not data_home.is_absolute():
        data_home = Path.home() / '.local/share'
    return data_home / f'courseweave/agent-harness-path-v{course_version}'


def main(argv=None, *, root=None) -> int:
    parser = argparse.ArgumentParser(description='CourseWeave student pilot — S01–S14. Run without arguments to prepare the full course and start.')
    parser.add_argument('command', nargs='?', default='start', choices=['start', 'setup', 'check', 'inspect', 'export', 'reset'])
    parser.add_argument('--home', type=Path, help='Study folder; contains your course, learning records and private runtimes.')
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--no-provider', action='store_true', help='Read and practise without accessing any assistant credentials.')
    modes.add_argument('--provider-env', action='store_true', help='Use the provider variables explicitly exported in this terminal; .env files are not loaded.')
    modes.add_argument('--provider', choices=['openai', 'anthropic'], help='Prompt securely for this provider API key for the current launch.')
    parser.add_argument('--model', help='Provider model name; required with --provider.')
    parser.add_argument('--base-url', help='Optional OpenAI-compatible or Anthropic gateway base URL; only with --provider.')
    parser.add_argument('--port', type=int, default=8765, help='Local service port; use 8766 if 8765 is occupied.')
    parser.add_argument('--output', type=Path, help='New file for a learning-record export.')
    parser.add_argument('--confirm', action='store_true', help='Confirm resetting learning memory; saved notebooks are kept.')
    args = parser.parse_args(argv)
    try:
        root = local_path(Path(root) if root else Path(__file__).resolve().parent, 'release bundle')
        data = load_release(root)
        home = local_path(args.home or default_home(data['course_version']), 'study folder')
        if args.provider and not args.model:
            raise PilotError('--provider requires --model. See README.md for examples.')
        if not args.provider and (args.model is not None or args.base_url is not None):
            raise PilotError('--model and --base-url may only be used with --provider.')
        if not 1024 <= args.port <= 65535:
            raise PilotError('--port must be between 1024 and 65535.')
        if args.command == 'reset' and not args.confirm:
            raise PilotError('Reset clears learning records and preferences, keeping saved notebooks. Export first if needed, then repeat with --confirm. Stop the course before resetting.')
        if args.command == 'export' and args.output is None:
            raise PilotError('Export needs --output pointing to a new file on nonsynced local storage. See the example in README.md.')
        if args.output is not None:
            args.output = local_path(args.output, 'export destination')
        environment, assistant = student_environment(
            no_provider=args.no_provider,
            provider_env=args.provider_env,
            provider=args.provider,
            model=args.model,
            base_url=args.base_url,
        ) if args.command in ('start', 'check') else (setup_environment(), 'not used')
        if args.command == 'check':
            ready = runtime_ready(data, home)
            course_ok = ready and course_ready(data, home)
            course_status = 'validated' if course_ok else ('needs attention — keep your saved work; see README.md' if (home / 'course').exists() else 'not installed — run the Start command')
            print(f'Release files: verified\nApplication: {"installed" if ready else "not installed — run the Start command"}\nCourse: {course_status}\nStudy folder: {home}\nAssistant: {assistant}')
            return 0 if course_ok else 2
        if args.command == 'start':
            with socket.socket() as listener:
                # Match the server's restart semantics: old TIME_WAIT connections
                # are reusable; an active listener still prevents this bind.
                listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                try:
                    listener.bind(('127.0.0.1', args.port))
                except OSError:
                    raise PilotError(f'Port {args.port} is already in use. If the course is open, use that browser window. Otherwise stop it with Ctrl-C, or start with --port {args.port + 1 if args.port < 65535 else 8765}.') from None
        uv = shutil.which('uv')
        if not uv:
            raise PilotError('Setup needs uv. Install it from https://docs.astral.sh/uv/getting-started/installation/ and run the Start command again.')
        home.mkdir(parents=True, exist_ok=True, mode=0o700)
        for name in ('course', 'runtimes', 'state', '.setup.lock'):
            owned_path(home, name)
        fd = os.open(owned_path(home, '.setup.lock'), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise PilotError('Another CourseWeave setup is running for this study folder. Wait for it to finish, then start again.') from None
            platform, kernel = ensure_runtime(root, data, home, uv)
            course = prepare_course(root, data, home)
        if args.command == 'setup':
            print(f'Setup complete. Run the Start command to open your course.\nStudy folder: {home}')
            return 0
        command = [str(platform), '-I', '-m', 'courseweave']
        if args.command == 'start':
            command += ['launch', '--course-root', str(course), '--kernel-python', str(kernel), '--state-dir', str(owned_path(home, 'state')), '--port', str(args.port)]
            print(f'\nOpening your course in the browser…\nAssistant: {assistant}\nStudy folder: {home}\nStart with “Read and trace the theory”. Save notebooks with Ctrl/Cmd-S.\nKeep this terminal open; Ctrl-C stops the course. Use the same Start command to resume.\n', flush=True)
        else:
            command += ['state', args.command, '--course-root', str(course), '--state-dir', str(owned_path(home, 'state'))]
            if args.command == 'export':
                command += ['--output', str(args.output)]
        os.execve(str(platform), command, environment)
        return 0
    except (PilotError, ValueError, OSError) as error:
        print(f'CourseWeave: {error}', file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print('\nSetup stopped. Your saved work is intact; run the same command to retry.', file=sys.stderr)
        return 130


if __name__ == '__main__':
    raise SystemExit(main())
