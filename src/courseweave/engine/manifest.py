"""Pure parsing/serialization plus explicit structural and runnable validation."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from pydantic import ValidationError

from courseweave.contracts import CourseManifest
from courseweave.contracts.models import ArtifactExistsRequirement, NotebookSurface, TerminalSurface, VideoSurface
from .paths import PathValidationError, probe_path, read_jailed


class ManifestValidationError(ValueError):
    """Public redacted errors; never include submitted values or absolute paths."""
    def __init__(self, message: str, *, issues: list[dict[str, str]] | None = None):
        super().__init__(message)
        self.issues = issues or []


def _issue(pointer: str, code: str) -> dict[str, str]:
    return {'path': pointer, 'code': code, 'message': 'The manifest field or local source is invalid.'}


def _raise(issues: list[dict[str, str]]) -> None:
    if issues:
        raise ManifestValidationError('Manifest validation failed.', issues=sorted(issues, key=lambda i: (i['path'], i['code'])))


def _address_parts(data, location):
    """Skip synthetic discriminated-union labels while retaining missing fields."""
    current = data
    result = []
    for part in location:
        if isinstance(current, dict):
            if part not in current and part in {current.get("type"), "TextValue", "EvidenceValue", "AttestationValue"}:
                continue
            result.append(part)
            current = current.get(part)
        elif isinstance(current, list) and isinstance(part, int) and part < len(current):
            result.append(part); current = current[part]
        else:
            result.append(part); current = None
    return result


def _error_location(data, error):
    parts = _address_parts(data, error['loc'])
    message = error.get('msg', '')
    if 'entry module' in message:
        return ['entry_module_id']
    if 'ids must be unique' in message or 'surface ids' in message:
        if not parts and 'module ids' in message:
            parts = ['modules']
        current = data
        for part in parts:
            current = current[part]
        if isinstance(current, dict) and 'surfaces' in current:
            parts = [*parts, 'surfaces']; current = current['surfaces']
        if isinstance(current, list):
            seen = set()
            for index, item in enumerate(current):
                identifier = item.get('id') if isinstance(item, dict) else None
                if identifier in seen:
                    return [*parts, index, 'id']
                seen.add(identifier)
    return parts


def parse_manifest_data(data: object, course_root: Path | None = None, *, runnable: bool = False) -> CourseManifest:
    try:
        manifest = CourseManifest.model_validate(data)
    except ValidationError as exc:
        issues = [_issue('/' + '/'.join(str(p).replace('~', '~0').replace('/', '~1') for p in _error_location(data, error)), 'contract_invalid') for error in exc.errors()]
        if isinstance(data, dict) and data.get('schema_version') == 1:
            raise ManifestValidationError('Schema v1 requires explicit copy-producing migration: courseweave migrate --source courseweave.json (preview), then --apply --output courseweave.v2.json.', issues=issues) from None
        raise ManifestValidationError('Manifest contract is invalid.', issues=issues) from None
    if course_root is not None:
        validate_paths(manifest, course_root)
    if runnable:
        if course_root is None:
            raise ValueError('runnable validation requires a course root')
        validate_runnable(manifest, course_root)
    return manifest


def parse_manifest_bytes(raw_bytes: bytes, course_root: Path | None = None, *, runnable: bool = False) -> CourseManifest:
    try:
        data = json.loads(raw_bytes)
    except (UnicodeDecodeError, ValueError):
        raise ManifestValidationError('Manifest JSON is invalid.') from None
    return parse_manifest_data(data, course_root, runnable=runnable)


def serialize_manifest(manifest: CourseManifest) -> bytes:
    data = manifest.model_dump(mode='json', exclude_none=True)
    # Required nullable field must remain present for an empty author draft.
    data['entry_module_id'] = manifest.entry_module_id
    return (json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False) + '\n').encode('utf-8')


def manifest_etag(raw_bytes: bytes) -> str:
    return 'sha256:' + hashlib.sha256(raw_bytes).hexdigest()


def _local_sources(manifest):
    for mi, module in enumerate(manifest.modules):
        for pi, phase in enumerate(module.phases):
            prefix = f'/modules/{mi}/phases/{pi}'
            for si, surface in enumerate(phase.surfaces):
                base = f'{prefix}/surfaces/{si}'
                if isinstance(surface, TerminalSurface):
                    yield surface.cwd, True, f'{base}/cwd', surface, (module.id, phase.id)
                elif isinstance(surface, VideoSurface):
                    if not surface.src.startswith('https://'):
                        yield surface.src, False, f'{base}/src', surface, (module.id, phase.id)
                elif hasattr(surface, 'path'):
                    yield surface.path, False, f'{base}/path', surface, (module.id, phase.id)
            if phase.completion is not None:
                for ri, requirement in enumerate(phase.completion.requirements):
                    if isinstance(requirement, ArtifactExistsRequirement):
                        yield requirement.path, False, f'{prefix}/completion/requirements/{ri}/path', requirement, (module.id, phase.id)


def validate_paths(manifest: CourseManifest, course_root: Path) -> None:
    """Drafts may name missing files; existing symlinks/wrong types fail closed."""
    issues = []
    for path, directory, pointer, _, _ in _local_sources(manifest):
        code = probe_path(course_root, path, directory=directory)
        if code is not None and code != 'source_missing':
            issues.append(_issue(pointer, code))
    _raise(issues)


def _selected_cells(root: Path, surface: NotebookSurface) -> set[int]:
    try:
        notebook = json.loads(read_jailed(root, surface.path, max_bytes=16 * 1024 * 1024))
        if not isinstance(notebook, dict) or notebook.get('nbformat') != 4 or not isinstance(notebook.get('cells'), list):
            raise ValueError()
        cells = notebook['cells']
        ids = []
        for cell in cells:
            if not isinstance(cell, dict) or cell.get('cell_type') not in {'markdown', 'code', 'raw'} or not isinstance(cell.get('metadata', {}), dict):
                raise ValueError()
            identifier = cell.get('id')
            if identifier is not None:
                if not isinstance(identifier, str) or not identifier:
                    raise ValueError()
                ids.append(identifier)
            tags = cell.get('metadata', {}).get('tags', [])
            if not isinstance(tags, list) or any(not isinstance(t, str) for t in tags):
                raise ValueError()
        if len(set(ids)) != len(ids):
            raise ValueError()
    except (ValueError, UnicodeDecodeError, TypeError):
        raise PathValidationError('notebook_invalid') from None
    selector = surface.selector
    if selector.type == 'whole_notebook':
        return set(range(len(cells)))
    if selector.type == 'cell_ids':
        if not set(selector.values).issubset(ids):
            raise PathValidationError('notebook_selector_unmatched')
        return {i for i, c in enumerate(cells) if c.get('id') in selector.values}
    values = set(selector.values)
    selected = {i for i, c in enumerate(cells) if (values.issubset(c.get('metadata', {}).get('tags', [])) if selector.match == 'all' else bool(values.intersection(c.get('metadata', {}).get('tags', []))))}
    if not selected:
        raise PathValidationError('notebook_selector_unmatched')
    return selected


def validate_runnable(manifest: CourseManifest, course_root: Path) -> None:
    """Require entry content, readable local sources, and unambiguous selectors.

    An empty requirement list means no task-specific submission is required.
    Its phase still needs authored content to be a meaningful runnable entry.
    """
    issues = []
    entry = next((m for m in manifest.modules if m.id == manifest.entry_module_id), None)
    if entry is None or not entry.phases or not entry.phases[0].surfaces:
        issues.append(_issue('/entry_module_id', 'entry_content_required'))
    selections: dict[str, list[tuple[tuple[str, str], set[int]]]] = {}
    for path, directory, pointer, source, coordinate in _local_sources(manifest):
        code = probe_path(course_root, path, directory=directory)
        if isinstance(source, ArtifactExistsRequirement) and code == 'source_missing':
            continue
        if code is not None:
            issues.append(_issue(pointer, code)); continue
        try:
            if isinstance(source, NotebookSurface):
                selected = _selected_cells(course_root, source)
                if not selected:
                    raise PathValidationError('notebook_selector_unmatched')
                previous = selections.setdefault(path, [])
                if any(other != coordinate and bool(selected & cells) for other, cells in previous):
                    issues.append(_issue(pointer, 'phase_context_ambiguous'))
                previous.append((coordinate, selected))
            elif isinstance(source, VideoSurface):
                # Only inspect the prefix, without requiring a full media read.
                from .paths import open_jailed
                import os
                with open_jailed(course_root, path) as fd:
                    if os.read(fd, 43).startswith(b'version https://git-lfs.github.com/spec/v1\n'):
                        issues.append(_issue(pointer, 'lfs_pointer'))
        except PathValidationError as exc:
            issues.append(_issue(pointer, exc.code))
    _raise(issues)
