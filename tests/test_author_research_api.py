"""Real Author routing with synthetic network adapters; no external requests."""
from pathlib import Path
import threading
import time

from fastapi.testclient import TestClient
from courseweave.api import create_app


def client(tmp_path):
    app = create_app(capability_token="author-research-test", author_home=tmp_path / "home")
    client = TestClient(app)
    auth = {"Authorization": "Bearer author-research-test"}
    for project in ("one", "two"):
        assert client.post("/api/author/projects", headers=auth, json={"project_id": project, "selected_paths": []}).status_code == 201
    return client, {**auth, "X-CourseWeave-Project": "one"}


def request():
    return {"network_enabled": True, "policy": {"mode": "allow_only", "allow": [{"origin": "https://docs.example.org"}]},
        "urls": ["https://docs.example.org/course"]}


def test_network_off_and_separate_connector_status_never_call_transport(tmp_path, monkeypatch):
    from courseweave.author import sources
    calls = []
    monkeypatch.setattr(sources.PublicHttpsTransport, "get", lambda *args, **kwargs: calls.append(args))
    monkeypatch.delenv("BRAVE_SEARCH_API_KEY", raising=False)
    c, auth = client(tmp_path)
    status = c.get("/api/author/research", headers=auth)
    assert status.status_code == 200 and status.json()["network_enabled"] is False and status.json()["brave_configured"] is False
    assert c.post("/api/author/research", headers=auth, json={**request(), "network_enabled": False}).status_code == 422
    assert c.post("/api/author/research", headers=auth, json={**request(), "urls": request()["urls"] * 6}).status_code == 422
    assert not calls


def test_fetched_source_report_and_excerpt_are_project_bound_and_restartable(tmp_path, monkeypatch):
    from courseweave.author import sources
    monkeypatch.setattr(sources.PublicHttpsTransport, "get", lambda *args, **kwargs: sources.HttpResult(200,
        {"content-type": "text/html"}, b"<title>Python checks</title><p>Inspect each row.</p>"))
    c, auth = client(tmp_path)
    response = c.post("/api/author/research", headers=auth, json=request())
    assert response.status_code == 200, response.text
    report = response.json()
    assert report["status"] == "complete" and "content" not in report["fetches"][0]
    record, = c.get("/api/author/sources", headers=auth).json()["sources"]
    assert record["status"] == "candidate" and record["redistribution"] == "undecided"
    url = f'/api/author/sources/{record["source_id"]}/text?revision={record["revision"]}'
    assert c.get(url, headers=auth).json()["text"] == "Inspect each row.\n"
    other = {**auth, "X-CourseWeave-Project": "two"}
    assert c.get(url, headers=other).status_code == 409
    assert c.get(f'/api/author/research/reports/{report["report_id"]}', headers=other).status_code == 409
    restarted = TestClient(create_app(capability_token="author-research-test", author_home=tmp_path / "home"))
    listing = restarted.get("/api/author/research/reports", headers=auth).json()
    assert listing["reports"][0]["report_id"] == report["report_id"]
    assert restarted.get(f'/api/author/research/reports/{report["report_id"]}', headers=auth).json() == report


def test_offline_reference_import_copies_only_to_private_sources(tmp_path):
    c, auth = client(tmp_path)
    path = tmp_path / "reference.md"
    path.write_text("Reference content, deliberately selected.")
    response = c.post("/api/author/sources/import", headers=auth, json={"path": str(path)})
    assert response.status_code == 201, response.text
    source = response.json()
    assert source["policy_decision"] == "local" and source["intended_use"] == "author_reference"
    assert path.read_text() == "Reference content, deliberately selected."
    course = tmp_path / "home/projects/one/course"
    assert not (course / "reference.md").exists()
    assert c.get(f'/api/author/sources/{source["source_id"]}/text?revision=99', headers=auth).status_code == 409


def test_one_active_run_can_be_cancelled_and_does_not_cross_projects(tmp_path, monkeypatch):
    from courseweave.author import sources
    entered, calls = threading.Event(), []
    def slow_fetch(self, url, control, **kwargs):
        calls.append(url)
        entered.set()
        while True:
            control.check()
            time.sleep(0.01)
    monkeypatch.setattr(sources.PublicHttpsTransport, "get", slow_fetch)
    c, auth = client(tmp_path)
    responses = []
    worker = threading.Thread(target=lambda: responses.append(c.post("/api/author/research", headers=auth, json=request())))
    worker.start()
    try:
        assert entered.wait(2)
        other = {**auth, "X-CourseWeave-Project": "two"}
        assert c.post("/api/author/research", headers=other, json=request()).status_code == 409
        assert c.post("/api/author/research/cancel", headers=other, json={}).status_code == 409
        assert c.post("/api/author/research/cancel", headers=auth, json={}).status_code == 202
        worker.join(3)
        assert not worker.is_alive() and responses[0].json()["status"] == "cancelled"
        assert len(calls) == 1 and not c.get("/api/author/sources", headers=auth).json()["sources"]
    finally:
        c.post("/api/author/research/cancel", headers=auth, json={})
        worker.join(3)


def test_student_capability_cannot_start_research_or_import_references(tmp_path):
    c = TestClient(create_app(tmp_path, capability_token="student"))
    auth = {"Authorization": "Bearer student"}
    assert c.get("/api/author/research", headers=auth).status_code == 403
    assert c.post("/api/author/research", headers=auth, json=request()).status_code == 403
    assert c.post("/api/author/sources/import", headers=auth, json={"path": str(tmp_path / "file")}).status_code == 403
