"""Owned installed Student previews; course rules remain in LaunchSupervisor."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
from typing import Literal, get_args
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4
import webbrowser

from pydantic import Field, field_validator

from ..contracts.models import ClosedModel, Slug, Surface
from ..providers import ProviderConfig
from ..student_launcher import setup_environment
from .contracts import Revision, Sha256
from .content import _lock
from .delivery import build_student_handoff, read_export, student_inputs
from .project import ProjectError, atomic_bytes, checked_local_path, local_directory, read_private


class PreviewObservations(ClosedModel):
    surfaces: tuple[str, ...] = Field(max_length=7)
    actions: tuple[Literal['navigation', 'keyboard', 'notebook_run', 'notebook_save', 'prediction', 'hint',
        'native_checks', 'unaided', 'restart', 'export_reset'], ...] = Field(max_length=10)
    notes: str = Field(max_length=8000)

    @field_validator('surfaces')
    @classmethod
    def supported_surfaces(cls, values):
        types = {get_args(model.model_fields['type'].annotation)[0] for model in get_args(get_args(Surface)[0])}
        if not set(values) <= types or len(set(values)) != len(values):
            raise ValueError('Select the supported Student surface types once each.')
        return values


class PreviewRecord(ClosedModel):
    format: Literal[1] = 1
    preview_id: Slug
    project_id: Slug
    export_id: Slug
    package_sha256: Sha256
    student_version: Literal['0.2.0', '0.3.0']
    home: str = Field(max_length=4096)
    created_at: datetime
    revision: Revision = 0
    status: Literal['preparing', 'running', 'stopped', 'failed'] = 'preparing'
    files: Literal['retained', 'kept', 'discarded'] = 'retained'
    provider_mode: Literal['off', 'configured'] = 'off'
    process_id: int | None = None
    api_port: int | None = None
    jupyter_port: int | None = None
    runner_sha256: Sha256 | None = None
    error: str = Field(default='', max_length=1000)
    observations: dict | None = None


@dataclass
class _Active:
    project: object
    preview_id: str
    cancel: threading.Event = field(default_factory=threading.Event)
    thread: threading.Thread | None = None
    process: object | None = None
    channel: socket.socket | None = field(default=None, repr=False)
    url: str | None = field(default=None, repr=False)


def preview_environment(provider: ProviderConfig | None = None) -> dict[str, str]:
    environment = setup_environment()
    environment.pop('BROWSER', None)
    if provider is not None:
        if provider.missing:
            raise ProjectError('The Author model is not configured. Leave preview assistant sharing off or configure it first.')
        prefix = provider.provider.upper()
        environment.update({
            'COURSEWEAVE_PROVIDER': provider.provider, 'COURSEWEAVE_PROVIDER_PROFILE': 'text-only-v1',
            prefix + '_MODEL': provider.model, prefix + '_API_KEY': provider.api_key,
            'COURSEWEAVE_PROVIDER_MAX_INPUT_CHARS': str(provider.max_input_chars),
            'COURSEWEAVE_PROVIDER_MAX_OUTPUT_TOKENS': str(provider.max_output_tokens),
            'COURSEWEAVE_PROVIDER_RUN_TIMEOUT_SECONDS': str(provider.run_timeout_seconds),
        })
        if provider.base_url:
            environment[prefix + '_BASE_URL'] = provider.base_url
        if provider.timeout_seconds:
            environment['COURSEWEAVE_PROVIDER_TIMEOUT_SECONDS'] = str(provider.timeout_seconds)
    return environment


class PreviewManager:
    def __init__(self, root: Path, *, process_factory=subprocess.Popen, browser_opener=webbrowser.open,
                 startup_timeout=660):
        self.root = checked_local_path(root)
        self.process_factory, self.browser_opener = process_factory, browser_opener
        self.startup_timeout = startup_timeout
        self.lock = threading.RLock()
        self.active: _Active | None = None

    def _directory(self, preview_id):
        if not re.fullmatch(r'preview-[a-f0-9]{32}', preview_id):
            raise ProjectError('Choose a saved Student preview.')
        return self.root / preview_id

    def _read(self, project, preview_id):
        directory = self._directory(preview_id)
        try:
            record = PreviewRecord.model_validate_json(read_private(project.state_root,
                'previews/' + preview_id + '.json', max_bytes=64 * 1024))
            if record.project_id != project.project_id or record.preview_id != preview_id or record.home != str(directory / 'study'):
                raise ValueError()
            return record
        except ValueError:
            raise ProjectError('The saved preview record is invalid. Inspect project recovery before changing its files.') from None

    def _write(self, project, record, *, replace=False):
        atomic_bytes(project.state_root / 'previews' / (record.preview_id + '.json'),
            (record.model_dump_json(indent=2) + '\n').encode(), replace=replace)
        return record.model_dump(mode='json')

    def _update(self, project, preview_id, *, expected_revision=None, **values):
        with self.lock, _lock(project):
            record = self._read(project, preview_id)
            if expected_revision is not None and record.revision != expected_revision:
                raise ProjectError('Preview record changed. Reload before saving this revision.')
            return self._write(project, PreviewRecord.model_validate(record.model_dump() |
                values | {'revision': record.revision + 1}), replace=True)

    def read(self, project, preview_id):
        with self.lock:
            return self._read(project, preview_id).model_dump(mode='json')

    def list(self, project, *, offset=0):
        with self.lock, local_directory(project.state_root / 'previews', create=True) as fd:
            names = os.listdir(fd)
            if len(names) > 200:
                raise ProjectError('Preview record limit exceeded. Archive this author project.')
            records = [self._read(project, n[:-5]) for n in names if n.endswith('.json')]
            records.sort(key=lambda r: r.created_at, reverse=True)
            return {'previews': [r.model_dump(mode='json') for r in records[offset:offset+20]],
                'next_offset': offset+20 if offset+20 < len(records) else None}

    def start(self, project, export_id, catalog_path, version, *, provider=None):
        environment = preview_environment(provider)
        with self.lock:
            if self.active is not None:
                raise ProjectError('A Student preview is active. Stop it before preparing another.')
            receipt = read_export(project, export_id)
            if receipt.kind != 'student_handoff' or not receipt.compatibility.passed:
                raise ProjectError('Student preview needs a saved standard export without deterministic errors.')
            if version not in student_inputs(catalog_path).runtimes:
                raise ProjectError('Choose a configured Student runtime.')
            if self.root.is_relative_to(project.course_root.parent):
                raise ProjectError('Student preview files must be separate from the author project.')
            if self.list(project)['next_offset'] is not None:
                with local_directory(project.state_root / 'previews') as fd:
                    if len(os.listdir(fd)) >= 200:
                        raise ProjectError('Preview record limit reached. Archive this author project.')
            preview_id = 'preview-' + uuid4().hex
            directory = self._directory(preview_id)
            with local_directory(directory, create=True):
                pass
            atomic_bytes(directory / 'owner.json', json.dumps({'format': 1, 'preview_id': preview_id,
                'project_id': project.project_id}).encode())
            record = PreviewRecord(preview_id=preview_id, project_id=project.project_id, export_id=export_id,
                package_sha256=receipt.package_sha256, student_version=version, home=str(directory / 'study'),
                created_at=datetime.now(timezone.utc), provider_mode='configured' if provider else 'off')
            result = self._write(project, record)
            active = self.active = _Active(project, preview_id)
            active.thread = threading.Thread(target=self._run,
                args=(active, catalog_path, version, environment), name='courseweave-student-preview', daemon=True)
            active.thread.start()
            return result

    def _run(self, active, catalog_path, version, environment):
        project, preview_id = active.project, active.preview_id
        peer = None
        try:
            record = self.read(project, preview_id)
            directory = self._directory(preview_id)
            build_student_handoff(project, record['export_id'], directory / 'bundle', catalog_path, version)
            if active.cancel.is_set():
                return
            channel, peer = socket.socketpair()
            active.channel = channel
            channel.settimeout(.25)
            runner = Path(__file__).parent.parent / 'student_preview.py'
            active.process = self.process_factory([sys.executable, '-I', str(runner), str(directory / 'bundle'),
                record['home'], str(peer.fileno()), preview_id], env=environment, cwd=directory,
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                start_new_session=True, pass_fds=(peer.fileno(),))
            environment.clear()
            peer.close();peer = None
            self._update(project, preview_id, process_id=active.process.pid,
                runner_sha256=hashlib.sha256(runner.read_bytes()).hexdigest())
            deadline, received = time.monotonic() + self.startup_timeout, bytearray()
            while b'\n' not in received:
                if active.cancel.is_set():
                    return
                if time.monotonic() >= deadline or active.process.poll() is not None:
                    raise ProjectError('Student preview setup did not finish. Check the release inputs, internet access and free disk space; the test files are retained.')
                try:
                    chunk = channel.recv(4096)
                except socket.timeout:
                    continue
                if not chunk or len(received) + len(chunk) > 8192:
                    raise ProjectError('Student preview did not return valid readiness information.')
                received.extend(chunk)
            info = json.loads(received.split(b'\n')[0])
            url = urlsplit(info['url'])
            query = parse_qs(url.query, strict_parsing=True)
            if (url.scheme != 'http' or url.hostname != '127.0.0.1' or url.username or url.password or
                url.path != '/courseweave/lab' or url.fragment or not url.port or
                set(query) != {'token'} or len(query['token']) != 1 or not 16 <= len(query['token'][0]) <= 1024 or
                info['student_version'] != version or type(info['api_port']) is not int or not 1024 <= info['api_port'] <= 65535):
                raise ValueError()
            active.url = info['url']
            api_port = info['api_port']
            received.clear();info.clear()
            self._update(project, preview_id, status='running', api_port=api_port, jupyter_port=url.port)
            while not active.cancel.wait(.25):
                if active.process.poll() is not None:
                    if active.process.returncode:
                        raise ProjectError('Student preview stopped unexpectedly. Its files are retained; inspect them before starting another preview.')
                    return
        except ProjectError as exc:
            self._update(project, preview_id, status='failed', error=str(exc))
        except Exception:
            self._update(project, preview_id, status='failed', error='Student preview could not start safely. Its test files are retained; inspect the release inputs and try a new preview.')
        finally:
            environment.clear()
            if peer is not None:
                peer.close()
            stopped = self._terminate(active)
            with self.lock:
                active.url = None
                if stopped:
                    record = self._read(project, preview_id)
                    if record.status != 'failed':
                        self._update(project, preview_id, status='stopped')
                    if self.active is active:
                        self.active = None
                else:
                    self._update(project, preview_id, status='failed', error='Preview cleanup is incomplete. Its owned process remains recorded; retry Stop before changing its files.')

    def _terminate(self, active):
        if active.channel is not None:
            try:
                active.channel.sendall(b's')
            except OSError:
                pass
            active.channel.close();active.channel = None
        process = active.process
        if process is None:
            return True
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            if process.poll() is None and os.getpgid(process.pid) == process.pid:
                os.killpg(process.pid, signal.SIGKILL)
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                return False
        return process.poll() is not None

    def open(self, project, preview_id):
        with self.lock:
            self._read(project, preview_id)
            active = self.active
            if active is None or active.project.project_id != project.project_id or active.preview_id != preview_id or not active.url:
                raise ProjectError('This preview is not running. Prepare a new preview from a saved export.')
            if not self.browser_opener(active.url):
                raise ProjectError('The browser could not open Student preview. Retry Open after checking your browser.')
            return {'opened': True}

    def stop(self, project, preview_id):
        with self.lock:
            self._read(project, preview_id)
            active = self.active
            if active is None or active.project.project_id != project.project_id or active.preview_id != preview_id:
                return self.read(project, preview_id)
            active.cancel.set()
        active.thread.join(timeout=20)
        if active.thread.is_alive():
            raise ProjectError('Preview preparation is still stopping. Its files are retained; retry Stop shortly.')
        if self.active is active:
            with self.lock:
                if self._terminate(active):
                    self.active = None
        return self.read(project, preview_id)

    def observe(self, project, preview_id, revision, observations):
        with self.lock:
            record = self._read(project, preview_id)
            if record.revision != revision:
                raise ProjectError('Preview record changed. Reload before saving observations.')
            try:
                value = PreviewObservations.model_validate(observations)
            except ValueError:
                raise ProjectError('Record only the surfaces and actions you actually checked, with bounded notes.') from None
            return self._update(project, preview_id, expected_revision=revision, observations=value.model_dump(mode='json') |
                {'category': 'author_reported', 'saved_at': datetime.now(timezone.utc).isoformat()})

    def keep(self, project, preview_id, revision):
        with self.lock:
            record = self._read(project, preview_id)
            if record.revision != revision or record.files == 'discarded':
                raise ProjectError('Preview record changed. Reload before keeping these files.')
            return self._update(project, preview_id, expected_revision=revision, files='kept')

    def discard(self, project, preview_id, revision):
        with self.lock:
            record = self._read(project, preview_id)
            if record.revision != revision or record.status in {'preparing', 'running'} or (self.active and self.active.preview_id == preview_id):
                raise ProjectError('Stop this preview and reload its record before discarding its files.')
            directory = self._directory(preview_id)
            if record.files == 'discarded':
                return record.model_dump(mode='json')
            expected = {'format': 1, 'preview_id': preview_id, 'project_id': project.project_id}
            if json.loads(read_private(directory, 'owner.json', max_bytes=1024)) != expected:
                raise ProjectError('Preview ownership marker changed. No files were discarded.')
            with local_directory(self.root) as fd:
                shutil.rmtree(preview_id, dir_fd=fd)
            return self._update(project, preview_id, expected_revision=revision, files='discarded')

    def close(self):
        active = self.active
        if active is not None:
            self.stop(active.project, active.preview_id)
