"""Contract tests for the narrow, non-mutating Author boundary."""

from __future__ import annotations

import copy
import concurrent.futures
import hashlib
import json
import socket
import threading
from pathlib import Path

import pytest
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


def test_missing_manifest_proposal_listing_is_read_only_without_store_construction(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    before = sorted(path.relative_to(tmp_path) for path in tmp_path.rglob("*"))

    class ConstructionTripwire:
        def __init__(self, *_args, **_kwargs) -> None:
            raise AssertionError("empty Author startup must not construct CourseStore")

    monkeypatch.setattr("courseweave.api.CourseStore", ConstructionTripwire)
    response = client(tmp_path).get("/api/proposals", headers=AUTH)

    assert response.status_code == 200
    assert response.json() == []
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


def _issue_paths(response) -> dict[str, str]:
    assert response.status_code == 422
    return {issue["path"]: issue["code"] for issue in response.json()["details"]["issues"]}


def test_structural_issues_are_field_addressable_for_required_union_and_model_rules(tmp_path: Path) -> None:
    app = client(tmp_path)
    missing_title = manifest()
    del missing_title["title"]
    response = app.post("/api/author/validate", headers=AUTH, json={"manifest": missing_title, "mode": "structural"})
    assert _issue_paths(response)["/title"] == "schema_validation"

    bad_surface = manifest()
    bad_surface["modules"][0]["phases"][0]["surfaces"][0]["path"] = "../secret-looking-value"
    response = app.post("/api/author/validate", headers=AUTH, json={"manifest": bad_surface, "mode": "structural"})
    assert _issue_paths(response)["/modules/0/phases/0/surfaces/0/path"] == "schema_validation"

    duplicate = manifest()
    duplicate["modules"].append(copy.deepcopy(duplicate["modules"][0]))
    response = app.post("/api/author/validate", headers=AUTH, json={"manifest": duplicate, "mode": "structural"})
    assert _issue_paths(response)["/modules/1/id"] == "schema_validation"

    bad_entry = manifest()
    bad_entry["entry_module_id"] = "missing-module"
    response = app.post("/api/author/validate", headers=AUTH, json={"manifest": bad_entry, "mode": "structural"})
    assert _issue_paths(response)["/entry_module_id"] == "schema_validation"


def test_schema_version_and_malformed_field_type_have_safe_pointers(tmp_path: Path) -> None:
    app = client(tmp_path)
    unsupported = manifest()
    unsupported["schema_version"] = 2
    response = app.post("/api/author/validate", headers=AUTH, json={"manifest": unsupported, "mode": "structural"})
    assert _issue_paths(response) == {"/schema_version": "schema_validation"}

    malformed = manifest()
    malformed["policies"]["max_shared_chars"] = "not-a-number"
    response = app.post("/api/author/validate", headers=AUTH, json={"manifest": malformed, "mode": "structural"})
    assert _issue_paths(response)["/policies/max_shared_chars"] == "schema_validation"


def test_runnable_collects_all_local_diagnostics_and_allows_future_completion(tmp_path: Path) -> None:
    draft = manifest()
    phase = draft["modules"][0]["phases"][0]
    phase["surfaces"] = [
        {"id": "missing", "type": "markdown", "role": "primary", "path": "missing.md"},
        {"id": "terminal", "type": "terminal", "role": "exercise", "label": "Run", "argv": ["echo"], "cwd": "missing-cwd"},
        {"id": "video", "type": "video", "role": "reference", "path": "video.mp4"},
    ]
    (tmp_path / "video.mp4").write_bytes(b"version https://git-lfs.github.com/spec/v1\n")
    phase["completion"] = {"type": "artifact_exists", "record_id": "future", "path": "future.json"}
    response = client(tmp_path).post("/api/author/validate", headers=AUTH, json={"manifest": draft, "mode": "runnable"})
    assert _issue_paths(response) == {
        "/modules/0/phases/0/surfaces/0/path": "missing_artifact",
        "/modules/0/phases/0/surfaces/1/cwd": "invalid_terminal_cwd",
        "/modules/0/phases/0/surfaces/2/path": "lfs_pointer",
    }


def test_validation_path_symlink_and_remote_url_are_safe_and_network_free(tmp_path: Path, monkeypatch) -> None:
    root = tmp_path / "course"
    root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (root / "escaped").symlink_to(outside, target_is_directory=True)
    draft = manifest()
    draft["modules"][0]["phases"][0]["surfaces"][0]["path"] = "escaped/private.txt"
    response = client(root).post("/api/author/validate", headers=AUTH, json={"manifest": draft, "mode": "structural"})
    assert _issue_paths(response) == {"/modules/0/phases/0/surfaces/0/path": "path_escape"}

    def no_network(*_args, **_kwargs):
        raise AssertionError("validation must not make an outbound network request")

    monkeypatch.setattr(socket, "create_connection", no_network)
    remote = manifest()
    remote["modules"][0]["phases"][0]["surfaces"][0] = {
        "id": "remote", "type": "video", "role": "primary", "url": "https://network-tripwire.example/video.mp4"
    }
    assert client(root).post("/api/author/validate", headers=AUTH, json={"manifest": remote, "mode": "runnable"}).status_code == 200


def test_validation_boundary_rejects_bad_auth_cors_and_large_body_without_state_change(tmp_path: Path) -> None:
    raw = manifest_bytes(parse_manifest_data(manifest(), tmp_path))
    (tmp_path / "courseweave.json").write_bytes(raw)
    store = CourseStore(tmp_path)
    before = {
        "manifest": (tmp_path / "courseweave.json").read_bytes(),
        "mtime": (tmp_path / "courseweave.json").stat().st_mtime_ns,
        "state": store.get_state().model_dump(mode="json"),
        "proposals": store.list_proposals(),
    }
    app = client(tmp_path)
    assert app.post("/api/author/validate", headers={"Authorization": "Bearer wrong"}, json={"manifest": manifest(), "mode": "structural"}).status_code == 403
    cors = app.options("/api/author/validate", headers={**AUTH, "Origin": "https://cross-origin.example", "Access-Control-Request-Method": "POST"})
    assert cors.status_code == 405
    assert "access-control-allow-origin" not in cors.headers
    oversized = app.post("/api/author/validate", headers={**AUTH, "Content-Type": "application/json"}, content=b"x" * (1024 * 1024 + 1))
    assert oversized.status_code == 413
    assert (tmp_path / "courseweave.json").read_bytes() == before["manifest"]
    assert (tmp_path / "courseweave.json").stat().st_mtime_ns == before["mtime"]
    assert store.get_state().model_dump(mode="json") == before["state"]
    assert store.list_proposals() == before["proposals"]


def test_author_manifest_review_rejects_exact_bytes_then_edits_and_accepts_once(tmp_path: Path) -> None:
    before = manifest_bytes(parse_manifest_data(manifest(), tmp_path))
    (tmp_path / "courseweave.json").write_bytes(before)
    store = CourseStore(tmp_path)
    proposed = manifest()
    proposed["title"] = "Teacher title"
    pending = store.create_proposal(
        {
            "id": "author-review",
            "type": "manifest_replace",
            "origin": "teacher_suggested",
            "summary": "Improve course title",
            "target": "courseweave.json",
            "payload": {"manifest": proposed},
            "target_hash": hashlib.sha256(before).hexdigest(),
        },
        "seed-author-review",
    )
    app = client(tmp_path)

    rejected = app.post(
        f"/api/proposals/{pending.id}/reject",
        headers={**AUTH, "Idempotency-Key": "reject-author-review"},
        json={"expected_revision": pending.revision},
    )
    assert rejected.status_code == 200
    assert (tmp_path / "courseweave.json").read_bytes() == before

    second = store.create_proposal(
        {
            "id": "author-accept",
            "type": "manifest_replace",
            "origin": "teacher_suggested",
            "summary": "Improve course title",
            "target": "courseweave.json",
            "payload": {"manifest": proposed},
            "target_hash": hashlib.sha256(before).hexdigest(),
        },
        "seed-author-accept",
    )
    edited = manifest()
    edited["title"] = "Author edited title"
    update = app.post(
        f"/api/proposals/{second.id}/edit",
        headers={**AUTH, "Idempotency-Key": "edit-author-review"},
        json={
            "expected_revision": second.revision,
            "request": {
                "payload": {"manifest": edited},
                "target_hash": hashlib.sha256(before).hexdigest(),
            },
        },
    )
    assert update.status_code == 200
    revision = update.json()["revision"]
    accepted = app.post(
        f"/api/proposals/{second.id}/accept",
        headers={**AUTH, "Idempotency-Key": "accept-author-review"},
        json={"expected_revision": revision},
    )
    replay = app.post(
        f"/api/proposals/{second.id}/accept",
        headers={**AUTH, "Idempotency-Key": "accept-author-review"},
        json={"expected_revision": revision},
    )
    assert accepted.status_code == replay.status_code == 200
    assert accepted.json() == replay.json()
    history = store.proposal_history(second.id)
    assert [item.status for item in history] == ["superseded", "accepted"]
    assert len([item for item in store.get_state().audit if item.proposal_id == second.id and item.status == "accepted"]) == 1
    assert (tmp_path / "courseweave.json").read_bytes() == manifest_bytes(parse_manifest_data(edited, tmp_path))


def test_author_proposal_accept_races_a_direct_save_without_stale_application(tmp_path: Path) -> None:
    before = manifest_bytes(parse_manifest_data(manifest(), tmp_path))
    (tmp_path / "courseweave.json").write_bytes(before)
    store = CourseStore(tmp_path)
    proposed = manifest()
    proposed["title"] = "Stale proposal"
    pending = store.create_proposal(
        {
            "id": "author-stale",
            "type": "manifest_replace",
            "origin": "teacher_suggested",
            "summary": "Stale proposal",
            "target": "courseweave.json",
            "payload": {"manifest": proposed},
            "target_hash": hashlib.sha256(before).hexdigest(),
        },
        "seed-author-stale",
    )
    direct = manifest()
    direct["title"] = "Direct author save"
    initial_etag = f'"{hashlib.sha256(before).hexdigest()}"'
    start = threading.Barrier(2)
    executor = concurrent.futures.ThreadPoolExecutor(max_workers=2)

    def accept() -> str:
        try:
            start.wait()
            return CourseStore(tmp_path).accept_proposal(pending.id, pending.revision, "race-accept").status
        except Exception as exc:  # noqa: BLE001 - the status proves the loser did not apply stale bytes
            return type(exc).__name__

    def save() -> str:
        try:
            start.wait()
            return CourseStore(tmp_path).save_course_manifest(
                parse_manifest_data(direct, tmp_path), initial_etag, "race-save"
            ).manifest.title
        except Exception as exc:  # noqa: BLE001 - the status proves the loser lost CAS
            return type(exc).__name__

    try:
        accept_future = executor.submit(accept)
        save_future = executor.submit(save)
        results = [accept_future.result(), save_future.result()]
    finally:
        executor.shutdown(wait=True)

    final = (tmp_path / "courseweave.json").read_bytes()
    accepted = [item for item in store.get_state().audit if item.proposal_id == pending.id and item.status == "accepted"]
    assert sum(result in {"accepted", "Direct author save"} for result in results) == 1
    assert final in {
        manifest_bytes(parse_manifest_data(proposed, tmp_path)),
        manifest_bytes(parse_manifest_data(direct, tmp_path)),
    }
    assert len(accepted) == (1 if final == manifest_bytes(parse_manifest_data(proposed, tmp_path)) else 0)
