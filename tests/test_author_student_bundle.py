import hashlib
import json
import zipfile
import pytest
from fastapi.testclient import TestClient
from courseweave.api import create_app
from courseweave.author.project import ProjectError
from courseweave.author.quality import student_profile
from test_author_delivery import delivery_project, export_request


@pytest.fixture
def runtime_catalog(tmp_path):
    root = tmp_path / 'runtime-inputs'; root.mkdir()
    wheel = root / 'courseweave-0.2.0-py3-none-any.whl'
    # Contract-only wheel: installed behavior uses separately built real inputs.
    with zipfile.ZipFile(wheel, 'w') as archive:
        archive.writestr('courseweave-0.2.0.dist-info/METADATA', 'Metadata-Version: 2.1\nName: courseweave\nVersion: 0.2.0\n')
    constraints = root / 'requirements.txt'; constraints.write_text('ipykernel==7.3.0\n')
    path = root / 'student-inputs.json'
    path.write_text(json.dumps({'format': 'courseweave-student-inputs-v1', 'runtimes': {'0.2.0': {
        'wheel': wheel.name, 'wheel_sha256': hashlib.sha256(wheel.read_bytes()).hexdigest(),
        'constraints': constraints.name, 'constraints_sha256': hashlib.sha256(constraints.read_bytes()).hexdigest(),
    }}}))
    return path


def test_author_bundles_only_saved_export_with_selected_verified_runtime(delivery_project, runtime_catalog, tmp_path):
    from courseweave.author.delivery import export_course, build_student_handoff
    project = delivery_project
    receipt = export_course(project, tmp_path / 'ready.tar', student_profile(), export_request(project))
    result = build_student_handoff(project, receipt.export_id, tmp_path / 'Student practice', runtime_catalog, '0.2.0')
    assert result['package_sha256'] == receipt.package_sha256 and result['student_version'] == '0.2.0'
    assert (tmp_path / 'Student practice' / 'release.json').is_file()
    assert json.loads((project.state_root / 'bundles' / (result['bundle_id'] + '.json')).read_text()) == result
    with pytest.raises(ProjectError):
        build_student_handoff(project, receipt.export_id, tmp_path / 'missing-version', runtime_catalog, '0.3.0')
    assert not (tmp_path / 'missing-version').exists()


@pytest.mark.parametrize('broken', ['wheel-hash', 'version', 'course'])
def test_changed_runtime_or_export_inputs_block_before_bundle_writes(delivery_project, runtime_catalog, tmp_path, broken):
    from courseweave.author.delivery import export_course, build_student_handoff
    receipt = export_course(delivery_project, tmp_path / 'ready.tar', student_profile(), export_request(delivery_project))
    if broken == 'wheel-hash':
        (runtime_catalog.parent / 'courseweave-0.2.0-py3-none-any.whl').write_bytes(b'changed wheel')
    elif broken == 'version':
        data = json.loads(runtime_catalog.read_text()); data['runtimes']['0.3.0'] = data['runtimes'].pop('0.2.0'); runtime_catalog.write_text(json.dumps(data))
    else:
        receipt.destination.write_bytes(b'changed archive')
    with pytest.raises(ProjectError):
        build_student_handoff(delivery_project, receipt.export_id, tmp_path / 'blocked-bundle', runtime_catalog, '0.3.0' if broken == 'version' else '0.2.0')
    assert not (tmp_path / 'blocked-bundle').exists()


def test_bundle_api_reuses_project_authority_and_configured_runtime_catalog(delivery_project, runtime_catalog, tmp_path):
    project = delivery_project
    app = create_app(project.course_root, author_project=project, author_student_inputs=runtime_catalog,
        state_dir=project.state_root / 'transactions', capability_token='bundle-test')
    with TestClient(app, headers={'Authorization': 'Bearer bundle-test'}) as client:
        assert client.get('/api/author/delivery').json()['student_runtimes'] == ['0.2.0']
        receipt = client.post('/api/author/exports', json=export_request(project).model_dump(mode='json') | {'destination': str(tmp_path / 'ready.tar')}).json()
        response = client.post('/api/author/student-bundles', json={'export_id': receipt['export_id'], 'destination': str(tmp_path / 'Student bundle'), 'student_version': '0.2.0'})
        assert response.status_code == 201, response.text
        assert response.json()['package_sha256'] == receipt['package_sha256']
        assert client.post('/api/author/student-bundles', json={'export_id': receipt['export_id'], 'wheel': '/unreviewed.whl'}).status_code == 422
