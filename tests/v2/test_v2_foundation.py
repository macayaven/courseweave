import json
from copy import deepcopy

import pytest
from pydantic import ValidationError

from courseweave.contracts import CourseManifest
from courseweave.contracts.records import Coordinate, TextValue, EvidenceValue, AttestationValue, RecordSubmission
from courseweave.engine import (
    parse_manifest_data, serialize_manifest, validate_runnable, ManifestValidationError,
    requirement_digest, curriculum_digest, bind_record, evaluate_progress, effective_teacher_policy,
)
from test_v2_models import _manifest
from test_v2_learning import learning


def course():
    data = _manifest()
    data['modules'][0]['phases'][0]['surfaces'] = [{'id': 'lesson', 'type': 'markdown', 'purpose': 'primary', 'label': 'Lesson', 'path': 'lesson.md'}]
    return data


def coord(req='prediction', phase='predict'):
    return Coordinate(module_id='intro', phase_id=phase, requirement_id=req)


def test_draft_vs_runnable_and_empty_requirements(tmp_path):
    data = course(); data.update(modules=[], entry_module_id=None)
    draft = parse_manifest_data(data, tmp_path)
    assert json.loads(serialize_manifest(draft))['entry_module_id'] is None
    with pytest.raises(ManifestValidationError): validate_runnable(draft, tmp_path)
    data = course(); data['modules'][0]['phases'][0]['completion']['requirements'] = []
    data['modules'][0]['phases'][0]['teacher']['access']['requires'] = []
    (tmp_path / 'lesson.md').write_text('Lesson')
    manifest = parse_manifest_data(data, tmp_path, runnable=True)
    assert evaluate_progress(manifest, [], tmp_path).required_complete == 1
    data['modules'][0]['phases'][0]['surfaces'] = []
    with pytest.raises(ManifestValidationError): parse_manifest_data(data, tmp_path, runnable=True)


@pytest.mark.parametrize('path', ['../x', 'a/../x', '/tmp/x', 'C:/x', 'a\\x', 'a//x', 'a/./x', 'x\x00', 'https://example.org'])
def test_lexical_paths_rejected_even_in_drafts(tmp_path, path):
    data = course(); data['modules'][0]['phases'][0]['surfaces'][0]['path'] = path
    with pytest.raises((ValidationError, ManifestValidationError)): parse_manifest_data(data, tmp_path)


@pytest.mark.parametrize('url', ['http://example.org', 'https://', 'https://example.org:bad', 'https://user:pass@example.org', 'https://example.org/ bad'])
def test_url_validation(tmp_path, url):
    data = course(); data['modules'][0]['phases'][0]['surfaces'] = [{'id': 'web', 'type': 'external', 'purpose': 'reference', 'label': 'Web', 'url': url}]
    with pytest.raises((ValidationError, ManifestValidationError)): parse_manifest_data(data, tmp_path)


def test_symlink_surfaces_and_artifacts_rejected(tmp_path):
    (tmp_path / 'target').write_text('Text'); (tmp_path / 'lesson.md').symlink_to(tmp_path / 'target')
    with pytest.raises(ManifestValidationError): parse_manifest_data(course(), tmp_path)
    (tmp_path / 'lesson.md').unlink(); (tmp_path / 'lesson.md').write_text('Lesson')
    data = course(); reqs = data['modules'][0]['phases'][0]['completion']['requirements']
    reqs.append({'id': 'file', 'type': 'artifact_exists', 'path': 'result', 'prompt': 'Create result.'})
    manifest = parse_manifest_data(data, tmp_path, runnable=True)
    record = bind_record(manifest, coord(), TextValue(text='I predict input first.'))
    assert not evaluate_progress(manifest, [record], tmp_path).phases[0].complete
    (tmp_path / 'result').write_text('Anything')
    assert evaluate_progress(manifest, [record], tmp_path).phases[0].complete
    (tmp_path / 'result').unlink()
    assert not evaluate_progress(manifest, [record], tmp_path).phases[0].complete
    (tmp_path / 'result').symlink_to(tmp_path / 'target')
    assert not evaluate_progress(manifest, [record], tmp_path).phases[0].complete
    with pytest.raises(ManifestValidationError): parse_manifest_data(data, tmp_path)


def test_records_and_digests_bind_substantive_content_only(tmp_path):
    data = course(); manifest = CourseManifest.model_validate(data)
    record = bind_record(manifest, coord(), TextValue(text='My attempt'))
    assert evaluate_progress(manifest, [record], tmp_path).required_complete == 1
    cosmetic = deepcopy(data); cosmetic['title'] = 'Renamed'; cosmetic['modules'][0]['title'] = 'Rename'; cosmetic['modules'][0]['phases'][0]['title'] = 'Rename'
    cosmetic['modules'][0]['phases'][0]['learning'] = learning()
    changed = CourseManifest.model_validate(cosmetic)
    assert requirement_digest(manifest, coord()) == requirement_digest(changed, coord())
    assert curriculum_digest(manifest) != curriculum_digest(changed)
    assert evaluate_progress(changed, [record], tmp_path).required_complete == 1
    cosmetic['modules'][0]['phases'][0]['completion']['requirements'][0]['prompt'] = 'New task'
    changed = CourseManifest.model_validate(cosmetic)
    result = evaluate_progress(changed, [record], tmp_path)
    assert result.required_complete == 0 and result.records[0].status == 'stale'
    orphan = record.model_copy(update={'coordinate': coord('gone')})
    fabricated = record.model_copy(update={'origin': 'assistant'})
    mismatched = record.model_copy(update={'kind': 'evidence'})
    assert [s.status for s in evaluate_progress(manifest, [orphan, fabricated, mismatched], tmp_path).records] == ['orphan', 'invalid', 'invalid']
    assert evaluate_progress(manifest, [orphan, fabricated, mismatched], tmp_path).required_complete == 0


def test_optional_excluded_denominator_and_all_requirements(tmp_path):
    data = course(); phase = data['modules'][0]['phases'][0]
    phase['completion']['requirements'].append({'id': 'confirm', 'type': 'learner_record', 'record_kind': 'attestation', 'prompt': 'Confirm.'})
    optional = deepcopy(phase); optional.update(id='optional', progress='optional')
    excluded = deepcopy(phase); excluded.update(id='excluded', progress='excluded'); excluded.pop('completion'); excluded['teacher']['access']['requires'] = []
    data['modules'][0]['phases'] += [optional, excluded]
    manifest = CourseManifest.model_validate(data)
    records = [bind_record(manifest, coord(), TextValue(text='Attempt'))]
    assert evaluate_progress(manifest, records, tmp_path).required_total == 1
    assert evaluate_progress(manifest, records, tmp_path).required_complete == 0
    records.append(bind_record(manifest, coord('confirm'), AttestationValue(attested=True)))
    result = evaluate_progress(manifest, records, tmp_path)
    assert result.required_complete == 1 and result.phases[2].complete is None


def test_values_and_server_owned_fields(tmp_path):
    manifest = CourseManifest.model_validate(course())
    with pytest.raises(ValueError): bind_record(manifest, coord(), AttestationValue(attested=True))
    with pytest.raises(ValueError): bind_record(manifest, coord('ghost'), TextValue(text='x'))
    with pytest.raises(ValidationError): TextValue(text=' ')
    with pytest.raises(ValidationError): AttestationValue(attested='true')
    with pytest.raises(ValidationError): RecordSubmission.model_validate({'coordinate': coord().model_dump(), 'value': {'text': 'x'}, 'origin': 'direct_learner'})
    EvidenceValue.model_validate({'references': [{'label': 'Attempt', 'path': 'notes/attempt.md'}, {'label': 'Docs', 'url': 'https://example.org'}]})
    with pytest.raises(ValidationError): EvidenceValue.model_validate({'references': [{'label': 'Leak', 'path': '../secret'}]})


def test_teacher_uses_policy_and_valid_same_phase_records(tmp_path):
    data = course(); manifest = CourseManifest.model_validate(data)
    assert not effective_teacher_policy(manifest, 'intro', 'predict', []).provider_callable
    record = bind_record(manifest, coord(), TextValue(text='Attempt'))
    assert effective_teacher_policy(manifest, 'intro', 'predict', [record]).provider_callable
    for experience in ['generic', 'project', 'prediction']:
        data['modules'][0]['phases'][0]['experience']['id'] = experience
        m = CourseManifest.model_validate(data)
        assert effective_teacher_policy(m, 'intro', 'predict', [record]).provider_callable
        assert not effective_teacher_policy(m, 'intro', 'predict', [record.model_copy(update={'requirement_digest': 'sha256:'+'0'*64})]).provider_callable
    for mode in ['disabled', 'observer_only']:
        phase = data['modules'][0]['phases'][0]; phase['teacher']['access'] = {'mode': mode, 'requires': []}; phase['teacher']['sharing']['allow'] = []
        assert not effective_teacher_policy(CourseManifest.model_validate(data), 'intro', 'predict', [record]).provider_callable


def test_notebook_selectors_and_runtime(tmp_path):
    data = course(); surface = {'id': 'nb', 'type': 'notebook', 'purpose': 'primary', 'label': 'Notebook', 'path': 'lesson.ipynb', 'selector': {'type': 'cell_ids', 'values': ['one']}}
    data['modules'][0]['phases'][0]['surfaces'] = [surface]
    with pytest.raises(ManifestValidationError): parse_manifest_data(data, tmp_path)
    data['runtime'] = {'type': 'jupyter', 'kernel': {'type': 'python_uv_project'}}
    notebook = {'nbformat': 4, 'nbformat_minor': 5, 'metadata': {}, 'cells': [{'id': 'one', 'cell_type': 'markdown', 'metadata': {'tags': ['a']}, 'source': ['hello']}]}
    (tmp_path / 'lesson.ipynb').write_text(json.dumps(notebook))
    parse_manifest_data(data, tmp_path, runnable=True)
    surface['selector']['values'] = ['missing']
    with pytest.raises(ManifestValidationError): parse_manifest_data(data, tmp_path, runnable=True)
    surface['selector'] = {'type': 'cell_tags', 'values': ['a'], 'match': 'all'}
    parse_manifest_data(data, tmp_path, runnable=True)
    second = deepcopy(data['modules'][0]['phases'][0]); second['id'] = 'second'; data['modules'][0]['phases'].append(second)
    with pytest.raises(ManifestValidationError): parse_manifest_data(data, tmp_path, runnable=True)


def test_false_attestation_is_a_valid_noncompleting_submission_and_does_not_open_gate(tmp_path):
    data = course(); phase = data['modules'][0]['phases'][0]
    phase['completion']['requirements'][0]['record_kind'] = 'attestation'
    manifest = CourseManifest.model_validate(data)
    record = bind_record(manifest, coord(), AttestationValue(attested=False))
    result = evaluate_progress(manifest, [record], tmp_path)
    assert result.records[0].status == 'valid' and result.required_complete == 0
    assert not effective_teacher_policy(manifest, 'intro', 'predict', [record]).provider_callable


def test_same_requirement_id_in_another_phase_cannot_open_gate(tmp_path):
    data = course(); second = deepcopy(data['modules'][0]['phases'][0]); second['id'] = 'second'
    data['modules'][0]['phases'].append(second)
    manifest = CourseManifest.model_validate(data)
    record = bind_record(manifest, coord(phase='second'), TextValue(text='Second phase attempt'))
    assert not effective_teacher_policy(manifest, 'intro', 'predict', [record]).provider_callable
    assert evaluate_progress(manifest, [record], tmp_path).required_complete == 1


def test_artifact_probe_does_not_read_contents_or_follow_directory_symlinks(tmp_path, monkeypatch):
    import os
    from courseweave.engine.paths import ordinary_file_present
    (tmp_path / 'artifact').write_bytes(b'private-content')
    def forbidden(*args, **kwargs):
        raise AssertionError('presence evaluation must never read bytes')
    monkeypatch.setattr(os, 'read', forbidden)
    assert ordinary_file_present(tmp_path, 'artifact')
    (tmp_path / 'alias').symlink_to(tmp_path, target_is_directory=True)
    assert not ordinary_file_present(tmp_path, 'alias/artifact')
    (tmp_path / 'directory').mkdir()
    assert not ordinary_file_present(tmp_path, 'directory')


def test_descriptor_swap_fails_closed(tmp_path, monkeypatch):
    import os
    from courseweave.engine.paths import ordinary_file_present
    (tmp_path / 'artifact').write_text('Before')
    (tmp_path / 'replacement').write_text('After')
    original_open = os.open
    def race(path, flags, *args, **kwargs):
        if path == 'artifact' and kwargs.get('dir_fd') is not None:
            os.replace(tmp_path / 'replacement', tmp_path / 'artifact')
        return original_open(path, flags, *args, **kwargs)
    monkeypatch.setattr('courseweave.engine.paths.safe_traversal_supported', lambda: True)
    monkeypatch.setattr(os, 'open', race)
    assert not ordinary_file_present(tmp_path, 'artifact')


def test_unsupported_safe_traversal_fails_closed(tmp_path, monkeypatch):
    from courseweave.engine.paths import ordinary_file_present
    (tmp_path / 'artifact').write_text('Present')
    monkeypatch.setattr('courseweave.engine.paths.safe_traversal_supported', lambda: False)
    assert not ordinary_file_present(tmp_path, 'artifact')


def test_remote_surfaces_are_never_fetched_and_terminal_is_never_executed(tmp_path, monkeypatch):
    import urllib.request
    import subprocess
    def forbidden(*args, **kwargs):
        raise AssertionError('unexpected side effect')
    monkeypatch.setattr(urllib.request, 'urlopen', forbidden)
    monkeypatch.setattr(subprocess, 'run', forbidden)
    data = course(); data['modules'][0]['phases'][0]['surfaces'] = [
        {'id': 'web', 'type': 'external', 'purpose': 'reference', 'label': 'Web', 'url': 'https://example.org'},
        {'id': 'terminal', 'type': 'terminal', 'purpose': 'primary', 'label': 'Terminal', 'command': ['false'], 'cwd': '.'},
    ]
    parse_manifest_data(data, tmp_path, runnable=True)


def test_lfs_pointer_is_not_runnable_video(tmp_path):
    data = course(); data['modules'][0]['phases'][0]['surfaces'] = [{'id': 'video', 'type': 'video', 'purpose': 'primary', 'label': 'Video', 'src': 'lesson.mp4'}]
    (tmp_path / 'lesson.mp4').write_bytes(b'version https://git-lfs.github.com/spec/v1\noid sha256:123\n')
    with pytest.raises(ManifestValidationError):
        parse_manifest_data(data, tmp_path, runnable=True)
