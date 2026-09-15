#!/usr/bin/env python3
"""Standalone Author setup and launch, using the existing Student setup helpers."""
from __future__ import annotations

import argparse
import fcntl
import getpass
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import warnings

if __package__:
    from . import student_launcher as common
else:
    # Isolated Python excludes the script directory from sys.path. Load only the
    # bundled, named standard-library helper; never search the working directory.
    import importlib.util
    spec = importlib.util.spec_from_file_location('courseweave_launcher_support', Path(__file__).with_name('student_launcher.py'))
    common = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(common)

VERSION = '0.3.0'
FILE_KINDS = {'wheel', 'student_wheel', 'constraints', 'source', 'author_launcher',
              'student_launcher', 'start', 'readme', 'license', 'third_party', 'student_inputs'}


def local_path(path: Path, label: str) -> Path:
    original = Path(os.path.abspath(path.expanduser()))
    resolved = common.local_path(original, label)
    if original != resolved or 'Mobile Documents' in resolved.parts or any(p.startswith('GoogleDrive-') for p in resolved.parts):
        raise common.PilotError(f'The {label} must be a real directory on nonsynced local storage, without redirected links.')
    if any(resolved.is_relative_to(Path.home() / name) for name in ('Desktop', 'Documents')):
        raise common.PilotError(f'Choose a {label} outside Desktop, Documents and cloud Drive.')
    return resolved


def load_release(root: Path) -> dict:
    try:
        marker = root / 'release.json'
        if marker.is_symlink() or marker.stat().st_size > 64 * 1024:
            raise ValueError()
        data = json.loads(marker.read_text())
        if data['format'] != 'courseweave-author-release-v1' or data['application_version'] != VERSION or set(data['files']) != FILE_KINDS:
            raise ValueError()
        for item in data['files'].values():
            name = item['path']
            if not isinstance(name, str) or Path(name).name != name or name in ('', '.', '..'):
                raise ValueError()
            path = root / name
            if path.is_symlink() or not path.is_file() or path.stat().st_size > 512 * 1024 * 1024:
                raise ValueError()
            with path.open('rb') as stream:
                if hashlib.file_digest(stream, 'sha256').hexdigest() != item['sha256']:
                    raise common.PilotError('This Author release is damaged. Use a fresh complete copy; your Author workspace is separate.')
        return data
    except common.PilotError:
        raise
    except (ValueError, OSError, KeyError, TypeError):
        raise common.PilotError('This Author release is incomplete. Keep Start Author.command, release.json and all bundled files together.') from None


def default_home(data: dict) -> Path:
    base = Path.home() / ('Library/Application Support/CourseWeave' if sys.platform == 'darwin' else '.local/share/courseweave')
    return base / f'author-v{VERSION}-{data["files"]["wheel"]["sha256"][:16]}'


def runtime_paths(data: dict, home: Path):
    identity = '-'.join(data['files'][key]['sha256'][:16] for key in ('wheel', 'constraints'))
    base = 'runtimes/' + identity
    for name in ('runtimes', base, base + '/platform', base + '/platform/bin', base + '/kernel', base + '/kernel/bin', base + '/ready.json'):
        common.owned_path(home, name)
    return home / base, home / base / 'platform/bin/python', home / base / 'kernel/bin/python'


def probe_runtime(platform: Path, kernel: Path) -> bool:
    probes = [(platform, 'import courseweave, courseweave.author.api, jupyterlab; assert courseweave.__version__ == "0.3.0"'),
              (kernel, 'import ipykernel, importlib.util; assert importlib.util.find_spec("courseweave") is None')]
    for python, code in probes:
        try:
            result = subprocess.run([str(python), '-I', '-c', code], env=common.setup_environment(),
                                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
        except (OSError, subprocess.TimeoutExpired):
            return False
        if result.returncode:
            return False
    return True


def runtime_ready(data: dict, home: Path) -> bool:
    runtime, platform, kernel = runtime_paths(data, home)
    try:
        ready = json.loads((runtime / 'ready.json').read_text())
        return ready == {'wheel_sha256': data['files']['wheel']['sha256'], 'constraints_sha256': data['files']['constraints']['sha256']} and probe_runtime(platform, kernel)
    except (OSError, ValueError):
        return False


def ensure_runtime(root: Path, data: dict, home: Path, uv: str):
    runtime, platform, kernel = runtime_paths(data, home)
    if runtime_ready(data, home):
        return platform, kernel
    runtime.mkdir(parents=True, exist_ok=True)
    constraints = (root / data['files']['constraints']['path']).as_uri()
    print('Preparing separate Author and notebook environments. First setup needs internet.', flush=True)
    for python, version, packages in [(platform, '3.11', [(root / data['files']['wheel']['path']).as_uri(), 'jupyterlab==4.6.3']),
                                      (kernel, '3.12', ['ipykernel==7.3.0'])]:
        if not python.is_file():
            common.run_setup([uv, '--no-config', 'venv', '--python', version, str(python.parent.parent)], 'Author Python setup')
        common.run_setup([uv, '--no-config', 'pip', 'install', '--python', str(python), '--constraint', constraints, *packages], 'Author dependency installation')
    if not probe_runtime(platform, kernel):
        raise common.PilotError('The Author or isolated notebook runtime failed its check. Run setup again; saved projects are preserved.')
    ready = {'wheel_sha256': data['files']['wheel']['sha256'], 'constraints_sha256': data['files']['constraints']['sha256']}
    # A failed/partial marker cannot pass runtime_ready and is safe to retry.
    with (runtime / 'ready.json').open('w') as stream:
        json.dump(ready, stream); stream.flush(); os.fsync(stream.fileno())
    return platform, kernel


def check_home(home: Path, data: dict, *, create: bool) -> None:
    marker = common.owned_path(home, '.author-home.json')
    expected = {'format': 'courseweave-author-home-v1', 'wheel_sha256': data['files']['wheel']['sha256']}
    if marker.exists():
        try:
            if json.loads(marker.read_text()) != expected:
                raise ValueError()
        except (OSError, ValueError):
            raise common.PilotError('This home belongs to another Author build or is incomplete. Choose a new --home and restore an inspected backup there.') from None
    elif home.exists() and any(home.iterdir()):
        raise common.PilotError('This folder contains unrelated work. Choose a new empty Author home; nothing was changed.')
    elif create:
        home.mkdir(parents=True, exist_ok=True, mode=0o700)
        with marker.open('x') as stream:
            json.dump(expected, stream); stream.flush(); os.fsync(stream.fileno())


def environment(args):
    result, model_status = common.student_environment(no_provider=args.no_provider, provider_env=args.provider_env,
        provider=args.provider, model=args.model, base_url=args.base_url)
    search_status = 'off'
    if args.search_key_env:
        key = os.environ.get('BRAVE_SEARCH_API_KEY', '')
        if not key.strip():
            raise common.PilotError('--search-key-env requires BRAVE_SEARCH_API_KEY in this terminal. No .env file is loaded.')
        result['BRAVE_SEARCH_API_KEY'] = key; search_status = 'configured; each discovery/fetch still requires an explicit action'
    elif args.search_key:
        if not sys.stdin.isatty():
            raise common.PilotError('--search-key requires an interactive terminal with hidden input. Use --search-key-env for automation.')
        try:
            with warnings.catch_warnings():
                warnings.simplefilter('error', getpass.GetPassWarning)
                key = getpass.getpass('Brave Search API key (input hidden): ')
        except (getpass.GetPassWarning, EOFError):
            raise common.PilotError('Could not obtain hidden search-key input. Use a terminal with hidden input support.') from None
        if not key.strip():
            raise common.PilotError('No search key was entered. Start again with a key or omit --search-key.')
        result['BRAVE_SEARCH_API_KEY'] = key; search_status = 'configured; each discovery/fetch still requires an explicit action'
    if os.environ.get('UV_CACHE_DIR'):
        result['UV_CACHE_DIR'] = str(local_path(Path(os.environ['UV_CACHE_DIR']), 'dependency cache'))
    return result, model_status, search_status


def main(argv=None, *, root=None) -> int:
    parser = argparse.ArgumentParser(description='CourseWeave Author. Start creates or resumes a private Author workspace.')
    parser.add_argument('command', nargs='?', default='start', choices=['start', 'setup', 'check'])
    parser.add_argument('--home', type=Path, help='Separate Author home for projects, previews and private runtimes.')
    parser.add_argument('--port', type=int, default=8767)
    model = parser.add_mutually_exclusive_group()
    model.add_argument('--no-provider', action='store_true')
    model.add_argument('--provider-env', action='store_true')
    model.add_argument('--provider', choices=['openai', 'anthropic'])
    parser.add_argument('--model'); parser.add_argument('--base-url')
    search = parser.add_mutually_exclusive_group()
    search.add_argument('--search-key', action='store_true', help='Prompt for a Brave Search API key for this launch.')
    search.add_argument('--search-key-env', action='store_true', help='Explicitly use BRAVE_SEARCH_API_KEY from this terminal.')
    args = parser.parse_args(argv)
    try:
        root = local_path(Path(root) if root else Path(__file__).parent, 'release bundle')
        data = load_release(root)
        home = local_path(args.home or default_home(data), 'Author home')
        check_home(home, data, create=False)
        if args.provider and not args.model or not args.provider and (args.model is not None or args.base_url is not None):
            raise common.PilotError('Use --provider with --model; --base-url is optional with --provider. See README.md.')
        if not 1024 <= args.port <= 65535:
            raise common.PilotError('--port must be between 1024 and 65535.')
        if args.command == 'check':
            ready = runtime_ready(data, home)
            print(f'Release files: verified\nAuthor runtime: {"installed" if ready else "not installed — run setup"}\nAuthor home: {home}\nModel/search credentials: not used by check')
            return 0 if ready else 2
        if args.command == 'start':
            with socket.socket() as listener:
                listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                try:
                    listener.bind(('127.0.0.1', args.port))
                except OSError:
                    raise common.PilotError(f'Port {args.port} is occupied. Use the existing session or choose another --port.') from None
            env, model_status, search_status = environment(args)
        uv = shutil.which('uv')
        if not uv:
            raise common.PilotError('Install uv from https://docs.astral.sh/uv/getting-started/installation/ and start again.')
        check_home(home, data, create=True)
        for name in ('workspace', 'runtimes', '.setup.lock'):
            common.owned_path(home, name)
        fd = os.open(home / '.setup.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise common.PilotError('Another setup is running for this Author home. Wait for it to finish, then start again.') from None
            platform, kernel = ensure_runtime(root, data, home, uv)
        if args.command == 'setup':
            print(f'Author setup complete. Open Start Author.command to begin.\nAuthor home: {home}')
            return 0
        command = [str(platform), '-I', '-m', 'courseweave', 'author', '--home', str(home / 'workspace'),
                   '--kernel-python', str(kernel), '--student-inputs', str(root / data['files']['student_inputs']['path']), '--port', str(args.port)]
        print(f'Opening CourseWeave Author…\nAuthor home: {home}\nAssistant: {model_status}\nSearch: {search_status}\nKeep this terminal open. Ctrl-C stops this session; saved projects remain.', flush=True)
        os.execve(str(platform), command, env)
        return 0
    except (common.PilotError, ValueError, OSError) as error:
        print(f'CourseWeave Author: {error}', file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print('\nSetup stopped. Saved projects remain; run the same Start command to retry.', file=sys.stderr)
        return 130


if __name__ == '__main__':
    raise SystemExit(main())
