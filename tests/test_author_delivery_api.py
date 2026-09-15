import pytest
from fastapi.testclient import TestClient
from courseweave.api import create_app
from test_author_delivery import delivery_project, export_request


def test_delivery_requires_reviewed_inventory_and_retains_exact_receipt(delivery_project, tmp_path):
    project = delivery_project
    app = create_app(project.course_root, author_project=project,
        state_dir=project.state_root / 'transactions', capability_token='export-test')
    with TestClient(app, headers={'Authorization': 'Bearer export-test'}) as client:
        plan = client.get('/api/author/delivery')
        assert plan.status_code == 200, plan.text
        body = export_request(project).model_dump(mode='json') | {'destination': str(tmp_path / 'new.tar')}
        response = client.post('/api/author/exports', json=body)
        assert response.status_code == 201, response.text
        receipt = response.json()
        assert receipt['compatibility']['passed']
        assert client.get('/api/author/exports').json()['exports'] == [receipt]
        assert client.post('/api/author/exports', json=body).status_code == 409
        assert client.post('/api/author/exports', json={'destination': str(tmp_path / 'unreviewed.tar')}).status_code == 422
    with TestClient(app, headers={'Authorization': 'Bearer export-test'}) as client:
        assert client.get('/api/author/exports').json()['exports'][0]['package_sha256'] == receipt['package_sha256']


@pytest.mark.parametrize('method,path', [('GET', '/api/author/delivery'), ('GET', '/api/author/exports'), ('POST', '/api/author/exports')])
def test_student_has_no_private_delivery_authority(delivery_project, method, path):
    app = create_app(delivery_project.course_root, capability_token='student-export-test')
    with TestClient(app, headers={'Authorization': 'Bearer student-export-test'}) as client:
        assert client.request(method, path, json={} if method == 'POST' else None).status_code == 403
