"""Review persistence uses the completed Author reply and private project authority."""
import json

import pytest
from fastapi.testclient import TestClient

from courseweave.api import create_app
from test_author_assistant import api, project, preview, send, draft_from, reply


def completed_review(client, model, project):
    model.custom_output_text = reply(change=None, findings=[{"claim_id": "gap", "judgment": "insufficient",
        "explanation": "The selected reference does not establish this claim.", "evidence": []}])
    output = draft_from(send(client, preview(client, project), action="review"))
    return f"/api/author/assistant/drafts/{output['draft_id']}/save-review"


def test_completed_reply_needs_explicit_idempotent_save_and_survives_session_end(api, project):
    client, app, model = api
    path = completed_review(client, model, project)
    assert client.get("/api/author/reviews").json()["reports"] == []
    saved = client.post(path, json={})
    assert saved.status_code == 201, saved.text
    report = saved.json()
    assert report["findings"][0]["human_disposition"] == "unreviewed"
    assert client.post(path, json={}).json()["report_id"] == report["report_id"]
    assert len(client.get("/api/author/reviews").json()["reports"]) == 1
    client.cookies.clear()
    assert client.post(path, json={}).status_code == 409
    assert client.get("/api/author/reviews/" + report["report_id"]).json() == report
    assert not (project.state_root / "changes").exists() and model.calls == 1


def test_review_updates_exports_and_deletion_use_explicit_reviewed_revision(api, project):
    client, _, model = api
    path = completed_review(client, model, project)
    saved = client.post(path, json={}).json()
    url = "/api/author/reviews/" + saved["report_id"]
    original = (project.course_root / "courseweave.json").read_bytes()
    decision = {"revision": 0, "human_disposition": "dismissed", "reason": "The claim is outside this lesson."}
    changed = client.put(url + "/findings/gap", json=decision)
    assert changed.status_code == 200, changed.text
    assert changed.json()["revision"] == 1
    assert client.put(url + "/findings/gap", json=decision).status_code == 409
    assert client.get(url + "/export?revision=0").status_code == 409
    exported = client.get(url + "/export?revision=1")
    assert exported.status_code == 200 and "attachment" in exported.headers["Content-Disposition"]
    assert exported.json()["findings"][0]["judgment"] == "insufficient"
    assert str(project.course_root.parent.parent) not in exported.text
    assert client.request("DELETE", url, json={"reviewed_revision": 0}).status_code == 409
    assert client.request("DELETE", url, json={"reviewed_revision": 1}).status_code == 204
    assert client.get("/api/author/reviews").json()["reports"] == []
    assert client.post(path, json={}).status_code == 409  # Do not recreate a deliberately deleted report.
    assert (project.course_root / "courseweave.json").read_bytes() == original
    assert client.get("/api/author/coverage").json()["activities"][0]["progress"] == "required"
    assert model.calls == 1


@pytest.mark.parametrize("body", [{"human_disposition": "accepted"}, {"report_id": "model-id"}, {"reply": {}}])
def test_client_cannot_post_its_own_saved_review_or_human_verdict(api, project, body):
    client, _, model = api
    path = completed_review(client, model, project)
    assert client.post(path, json=body).status_code == 422
    assert client.get("/api/author/reviews").json()["reports"] == []


def test_changed_target_blocks_unsaved_report_without_extra_provider_call(api, project):
    client, _, model = api
    path = completed_review(client, model, project)
    (project.course_root / "lesson.md").write_text("A new lesson.")
    assert client.post(path, json={}).status_code == 409
    assert client.get("/api/author/reviews").json()["reports"] == []
    assert model.calls == 1


@pytest.mark.parametrize("method,path,body", [
    ("GET", "/api/author/reviews", None), ("GET", "/api/author/reviews/review-" + "a" * 32, None),
    ("GET", "/api/author/reviews/review-" + "a" * 32 + "/export?revision=0", None),
    ("PUT", "/api/author/reviews/review-" + "a" * 32 + "/findings/a", {}),
    ("DELETE", "/api/author/reviews/review-" + "a" * 32, {}),
    ("POST", "/api/author/assistant/drafts/unknown/save-review", {}),
    ("GET", "/api/author/coverage", None),
])
def test_student_launch_has_no_private_review_authority(project, method, path, body):
    app = create_app(project.course_root, capability_token="review-student")
    with TestClient(app, headers={"Authorization": "Bearer review-student"}) as client:
        assert client.request(method, path, json=body).status_code == 403
