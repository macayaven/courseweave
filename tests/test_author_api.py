"""Contract tests for the narrow, non-mutating Author boundary."""

from __future__ import annotations

import copy
import json
from pathlib import Path

from fastapi.testclient import TestClient

from courseweave.api import create_app
from courseweave.manifest import manifest_bytes, parse_manifest_data
from courseweave.store import CourseStore

TOKEN = "author-test-capability"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


def manifest() -> dict:
    return {
        "schema_version": 1,
        "id": "author-course",
        "title": "Author Course",
        "description": "",
        "entry_module_id": "module-one",
        "policies": {
            "content_sharing": "explicit_only",
            "durable_mutation": "proposal_or_direct_student_action",
            "terminal_execution": "student_only",
            "conversation_memory": "session_only",
            "max_shared_chars": 8192,
            "workspace_write_globs": [],
        },
        "modules": [{
            "id": "module-one", "title": "Module one", "description": "",
            "phases": [{
                "id": "read-one", "title": "Read", "kind": "read",
                "teacher_mode": "reading_companion", "surfaces": [{
                    "id": "lesson", "type": "markdown", "role": "primary", "path": "lesson.md",
                }],
                "completion": {"type": "manual"},
                "capabilities": {"chat": True, "hint_level": "none", "share_selection": False,
                    "share_cell": False, "share_output": False, "create_profile_proposal": False,
                    "create_course_proposal": False, "create_workspace_proposal": False},
            }],
        }],
    }


def client(root: Path) -> TestClient:
    return TestClient(create_app(root, capability_token=TOKEN))


def test_missing_manifest_get_and_validation_are_read_only(tmp_path: Path) -> None:
    app = client(tmp_path)
    response = app.get("/api/course", headers=AUTH)
    assert response.status_code == 200
    assert response.headers["etag"] == '""'
    before = sorted(path.relative_to(tmp_path) for path in tmp_path.rglob("*"))

    validated = app.post("/api/author/validate", headers=AUTH, json={"manifest": response.json(), "mode": "structural"})

    assert validated.status_code == 200
    assert validated.json()["formatted_json"] == response.text
    assert sorted(path.relative_to(tmp_path) for path in tmp_path.rglob("*")) == before
    assert not (tmp_path / "courseweave.json").exists()
    assert not (tmp_path / ".courseweave").exists()


def test_validate_returns_stable_secret_safe_path_code_issues_and_never_writes(tmp_path: Path) -> None:
    draft = manifest()
    draft["entry_module_id"] = "not-a-module"
    draft["modules"][0]["phases"][0]["surfaces"][0]["path"] = "../../secret-token-value"
    before = sorted(path.relative_to(tmp_path) for path in tmp_path.rglob("*"))

    response = client(tmp_path).post("/api/author/validate", headers=AUTH, json={"manifest": draft, "mode": "structural"})

    assert response.status_code == 422
    issues = response.json()["details"]["issues"]
    assert issues == sorted(issues, key=lambda issue: (issue["path"], issue["code"], issue["message"]))
    assert all(set(issue) == {"path", "code", "message"} for issue in issues)
    assert all("secret-token-value" not in json.dumps(issue) for issue in issues)
    assert sorted(path.relative_to(tmp_path) for path in tmp_path.rglob("*")) == before


def test_runnable_validation_uses_local_evidence_without_remote_fetch(tmp_path: Path) -> None:
    draft = manifest()
    draft["modules"][0]["phases"][0]["surfaces"][0]["path"] = "missing.md"
    remote = copy.deepcopy(draft)
    remote["modules"][0]["phases"][0]["surfaces"][0] = {
        "id": "remote", "type": "video", "role": "primary", "url": "https://example.invalid/video.mp4"
    }
    app = client(tmp_path)
    missing = app.post("/api/author/validate", headers=AUTH, json={"manifest": draft, "mode": "runnable"})
    assert missing.status_code == 422
    assert missing.json()["details"]["issues"][0]["code"] == "missing_artifact"
    assert app.post("/api/author/validate", headers=AUTH, json={"manifest": remote, "mode": "runnable"}).status_code == 200


def test_validation_route_has_exact_auth_and_request_contract(tmp_path: Path) -> None:
    app = client(tmp_path)
    assert app.post("/api/author/validate", json={"manifest": manifest(), "mode": "structural"}).status_code == 403
    assert app.post("/api/author/validate", headers=AUTH, json={"manifest": manifest(), "mode": "other"}).status_code == 422
    assert app.post("/api/author/validate", headers=AUTH, json=[]).status_code == 422
    assert app.get("/api/author/validate", headers=AUTH).status_code == 405


def test_missing_manifest_replace_keeps_null_cas_and_is_exactly_once(tmp_path: Path) -> None:
    request = {"id": "initial-course", "type": "manifest_replace", "origin": "teacher_suggested",
               "summary": "Create the course", "target": "courseweave.json", "payload": {"manifest": manifest()}, "target_hash": None}
    store = CourseStore(tmp_path)
    proposal = store.create_proposal(request, "create")
    assert proposal.target_hash is None
    accepted = store.accept_proposal(proposal.id, proposal.revision, "accept")
    replay = store.accept_proposal(proposal.id, proposal.revision, "accept")
    assert accepted == replay
    assert (tmp_path / "courseweave.json").read_bytes() == manifest_bytes(parse_manifest_data(manifest(), tmp_path))
