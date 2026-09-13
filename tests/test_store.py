from __future__ import annotations


import hashlib
import json
import sqlite3
from copy import deepcopy
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from courseweave.api import create_app
from courseweave.manifest import load_manifest
from courseweave.store import (
    CourseStore,
    IdempotencyConflictError,
    InvalidProposalError,
    ProposalConflictError,
    ProposalNotFoundError,
    RevisionMismatchError,
    StoreCorruptError,
    TargetChangedError,
)

TOKEN = "task-two-test-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


def _manifest_data(*, write_globs: list[str] | None = None) -> dict:
    data = {'schema_version': 2,
     'id': 'store-course',
     'title': 'Store Course',
     'description': '',
     'entry_module_id': 'module-one',
     'policies': {'content_sharing': 'explicit_only',
                  'allowed_share_kinds': ['selection'],
                  'max_shared_chars': 8192,
                  'allowed_proposal_types': ['course', 'profile', 'workspace'],
                  'durable_mutation': 'proposal_or_direct_student_action',
                  'terminal_execution': 'student_only',
                  'conversation_memory': 'session_only',
                  'workspace_write_globs': ['work/*.txt']},
     'modules': [{'id': 'module-one',
                  'title': 'Module One',
                  'description': '',
                  'phases': [{'id': 'predict',
                              'title': 'Predict',
                              'progress': 'required',
                              'experience': {'type': 'builtin', 'id': 'prediction'},
                              'surfaces': [{'id': 'lesson',
                                            'purpose': 'primary',
                                            'type': 'markdown',
                                            'label': 'lesson',
                                            'path': 'lesson.md'}],
                              'completion': {'requirements': [{'id': 'prediction-one',
                                                               'type': 'learner_record',
                                                               'record_kind': 'text',
                                                               'prompt': 'Record your prediction for '
                                                                         'Predict.'},
                                                              {'id': 'reflection-one',
                                                               'type': 'learner_record',
                                                               'record_kind': 'text',
                                                               'prompt': 'Reflect on the result.'},
                                                              {'id': 'receipt-one',
                                                               'type': 'learner_record',
                                                               'record_kind': 'evidence',
                                                               'prompt': 'Record evidence.'},
                                                              {'id': 'completion-one',
                                                               'type': 'learner_record',
                                                               'record_kind': 'attestation',
                                                               'prompt': 'Acknowledge this '
                                                                         'activity.'}]},
                              'teacher': {'access': {'mode': 'available',
                                                     'requires': ['prediction-one']},
                                          'guidance': {'style': {'type': 'builtin', 'id': 'socratic'},
                                                       'hint_level': 'gentle'},
                                          'sharing': {'allow': ['selection']},
                                          'proposals': {'allow': ['profile',
                                                                  'course',
                                                                  'workspace']}}}]}]}
    data['policies']['workspace_write_globs'] = write_globs or ['work/*.txt']
    return data


@pytest.fixture
def course_root(tmp_path: Path) -> Path:
    (tmp_path / "lesson.md").write_text("# Lesson\n", encoding="utf-8")
    (tmp_path / "work").mkdir()
    (tmp_path / "courseweave.json").write_text(
        json.dumps(_manifest_data(), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return tmp_path


def _record(requirement_id, value):
    from courseweave.contracts import CourseManifest
    from courseweave.engine import curriculum_digest
    return {'type':'put_record','coordinate':{'module_id':'module-one','phase_id':'predict','requirement_id':requirement_id},
            'value':value, 'curriculum_digest':curriculum_digest(CourseManifest.model_validate(_manifest_data()))}


def _prediction(text: str = 'The loop keeps the state.') -> dict:
    return _record('prediction-one', {'text':text})


def _reflection(text: str = 'The API is stateless.') -> dict:
    return _record('reflection-one', {'text':text})


def _workspace_request(
    root: Path, *, content: str = "after\n", proposal_id: str = "workspace-one"
) -> dict:
    target = root / "work" / "answer.txt"
    before_hash = (
        hashlib.sha256(target.read_bytes()).hexdigest()
        if target.is_file()
        else None
    )
    return {
        "id": proposal_id,
        "type": "workspace_file_replace",
        "origin": "teacher_suggested",
        "summary": "Replace the learner answer",
        "target": {"path": "work/answer.txt"},
        "payload": {"content": content, "diff": "-before\n+after\n"},
        "target_hash": before_hash,
    }


class TestLearnerState:
    def test_initial_state_is_empty_and_does_not_store_navigation(
        self, course_root: Path
    ) -> None:
        state = CourseStore(course_root).get_state()
        assert state.model_dump(mode="json") == {
            'schema_version':2, 'course_id':'store-course',
            'root_fingerprint':hashlib.sha256(str(course_root.resolve()).encode()).hexdigest(),
            'revision':0, 'records':[], 'imports':[], 'attempts':[],
            'preferences':{'enabled':False,'explanation':'balanced','practice':'standard'},
            'time_budget_minutes':None, 'profile':{}, 'audit':[]}
        db = CourseStore(course_root).db_path
        assert not (course_root / '.courseweave').exists()
        assert db.is_file()
        db_text = db.read_bytes().lower()
        for forbidden in (b"active_path", b"chat_history", b"shared_excerpt"):
            assert forbidden not in db_text

    def test_every_direct_operation_updates_only_its_record_and_one_revision(
        self, course_root: Path
    ) -> None:
        store = CourseStore(course_root)
        state = store.apply_state(_prediction(), 0, "prediction-key")
        assert state.revision == 1
        assert state.records[0].value.text.startswith(
            "The loop"
        )

        state = store.apply_state(_reflection(), 1, "reflection-key")
        assert state.revision == 2
        assert len([r for r in state.records if r.coordinate.requirement_id == "prediction-one"]) == 1
        assert state.records[1].value.text.startswith(
            "The API"
        )

        state = store.apply_state(
            _record('receipt-one', {'references':[{'label':'Result','path':'work/result.txt'}],'note':'Reopenable'}),
            2,
            "evidence-key",
        )
        assert state.revision == 3
        assert state.records[2].value.references[0].path == (
            "work/result.txt"
        )

        state = store.apply_state(
            _record('completion-one', {'attested':True}),
            3,
            "complete-key",
        )
        assert state.revision == 4
        assert state.records[3].coordinate.requirement_id == "completion-one"
        assert state.records[3].value.attested

        state = store.apply_state(
            {"type": "set_time_budget", "minutes": 45},
            4,
            "budget-key",
        )
        assert state.revision == 5
        assert state.time_budget_minutes == 45

    def test_repeated_record_replaces_only_same_semantic_key(
        self, course_root: Path
    ) -> None:
        store = CourseStore(course_root)
        first = store.apply_state(_prediction("first"), 0, "first-key")
        second = store.apply_state(_prediction("second"), first.revision, "second-key")
        assert second.revision == 2
        assert [r.coordinate.requirement_id for r in second.records] == ["prediction-one"]
        assert second.records[0].value.text == "second"

    def test_revision_and_idempotency_contract(self, course_root: Path) -> None:
        store = CourseStore(course_root)
        first = store.apply_state(_prediction(), 0, "same-key")
        replay = store.apply_state(_prediction(), 0, "same-key")
        assert replay == first

        with pytest.raises(IdempotencyConflictError):
            store.apply_state(_prediction("different"), 1, "same-key")
        with pytest.raises(RevisionMismatchError):
            store.apply_state(_reflection(), 0, "stale-key")
        assert store.get_state() == first

    @pytest.mark.parametrize("minutes", [0, 1441])
    def test_invalid_time_budget_is_rejected(
        self, course_root: Path, minutes: int
    ) -> None:
        with pytest.raises(InvalidProposalError):
            CourseStore(course_root).apply_state(
                {"type": "set_time_budget", "minutes": minutes},
                0,
                f"budget-{minutes}",
            )

    def test_profile_is_not_a_direct_state_operation(self, course_root: Path) -> None:
        with pytest.raises(InvalidProposalError):
            CourseStore(course_root).apply_state(
                {"type": "set_profile", "strength": "debugging"},
                0,
                "profile-direct",
            )


class TestProposalLifecycle:
    def test_create_edit_reject_preserves_immutable_revisions(
        self, course_root: Path
    ) -> None:
        store = CourseStore(course_root)
        created = store.create_proposal(
            {
                "id": "profile-one",
                "type": "profile_patch",
                "origin": "teacher_suggested",
                "summary": "Remember the preferred pace",
                "target": "learner_profile",
                "payload": {"changes": {"explanation": "detailed"}},
                "target_hash": None,
            },
            "create-profile",
        )
        assert (created.revision, created.status) == (1, "pending")

        edited = store.edit_proposal(
            "profile-one",
            1,
            {
                "summary": "Remember the accepted pace",
                "payload": {"changes": {"explanation": "balanced"}},
            },
            "edit-profile",
        )
        assert (edited.revision, edited.status) == (2, "pending")
        history = store.proposal_history("profile-one")
        assert [(item.revision, item.status) for item in history] == [
            (1, "superseded"),
            (2, "pending"),
        ]

        rejected = store.reject_proposal(
            "profile-one", 2, "reject-profile"
        )
        assert rejected.status == "rejected"
        with pytest.raises(ProposalConflictError):
            store.reject_proposal("profile-one", 2, "reject-again")

    def test_create_and_accept_are_idempotent(self, course_root: Path) -> None:
        store = CourseStore(course_root)
        request = {
            "id": "profile-one",
            "type": "profile_patch",
            "origin": "teacher_suggested",
            "summary": "Remember preference",
            "target": "learner_profile",
            "payload": {"changes": {"practice": "extra"}},
            "target_hash": None,
        }
        created = store.create_proposal(request, "create-profile")
        assert store.create_proposal(request, "create-profile") == created
        with pytest.raises(IdempotencyConflictError):
            changed = deepcopy(request)
            changed["summary"] = "Different"
            store.create_proposal(changed, "create-profile")

        store.apply_state({"type":"set_preferences","preferences":{"enabled":True}}, 0, "consent")
        accepted = store.accept_proposal(
            "profile-one", 1, "accept-profile"
        )
        replay = store.accept_proposal("profile-one", 1, "accept-profile")
        assert replay == accepted
        state = store.get_state()
        assert state.revision == 2
        assert state.preferences.practice == "extra"
        assert state.profile == {}
        assert len(state.audit) == 1

    def test_stale_and_missing_proposal_revisions_are_distinct(
        self, course_root: Path
    ) -> None:
        store = CourseStore(course_root)
        store.create_proposal(
            {
                "id": "profile-one",
                "type": "profile_patch",
                "origin": "teacher_suggested",
                "summary": "Remember preference",
                "target": "learner_profile",
                "payload": {"changes": {"explanation": "balanced"}},
                "target_hash": None,
            },
            "create-profile",
        )
        with pytest.raises(RevisionMismatchError):
            store.edit_proposal(
                "profile-one",
                99,
                {"summary": "Stale"},
                "stale-edit",
            )
        with pytest.raises(ProposalNotFoundError):
            store.accept_proposal("missing", 1, "missing-accept")

    def test_model_phase_record_proposals_are_rejected_without_mutation(self, course_root):
        store = CourseStore(course_root)
        with pytest.raises(InvalidProposalError):
            store.create_proposal({'id':'phase-one','type':'phase_record','origin':'teacher_suggested',
                'summary':'Record prediction','target':'learner_state','payload':{'operation':_prediction()},'target_hash':None}, 'create-phase')
        assert store.get_state().revision == 0
        assert store.get_state().records == ()
        assert store.list_proposals() == []

    @pytest.mark.parametrize(
        "changes",
        [
            {"nested": {"not": "a scalar"}},
            {"nested-list": [["not", "flat"]]},
        ],
    )
    def test_profile_patch_accepts_only_scalars_or_flat_scalar_lists(
        self, course_root: Path, changes: dict
    ) -> None:
        with pytest.raises(InvalidProposalError):
            CourseStore(course_root).create_proposal(
                {
                    "id": "profile-invalid",
                    "type": "profile_patch",
                    "origin": "teacher_suggested",
                    "summary": "Invalid inferred profile",
                    "target": "learner_profile",
                    "payload": {"changes": changes},
                    "target_hash": None,
                },
                "invalid-profile",
            )


class TestWorkspaceProposals:
    def test_reject_is_byte_identical(self, course_root: Path) -> None:
        target = course_root / "work" / "answer.txt"
        target.write_text("before\n", encoding="utf-8")
        store = CourseStore(course_root)
        store.create_proposal(_workspace_request(course_root), "create-work")
        before = target.read_bytes()
        store.reject_proposal("workspace-one", 1, "reject-work")
        assert target.read_bytes() == before

    def test_accept_replaces_once_and_second_accept_replays(
        self, course_root: Path
    ) -> None:
        target = course_root / "work" / "answer.txt"
        target.write_text("before\n", encoding="utf-8")
        store = CourseStore(course_root)
        store.create_proposal(_workspace_request(course_root), "create-work")
        accepted = store.accept_proposal("workspace-one", 1, "accept-work")
        assert target.read_text(encoding="utf-8") == "after\n"
        assert accepted.status == "accepted"
        replay = store.accept_proposal("workspace-one", 1, "accept-work")
        assert replay == accepted
        assert len(store.get_state().audit) == 1

    def test_external_target_change_blocks_accept(self, course_root: Path) -> None:
        target = course_root / "work" / "answer.txt"
        target.write_text("before\n", encoding="utf-8")
        store = CourseStore(course_root)
        store.create_proposal(_workspace_request(course_root), "create-work")
        target.write_text("external\n", encoding="utf-8")
        with pytest.raises(TargetChangedError):
            store.accept_proposal("workspace-one", 1, "accept-work")
        assert target.read_text(encoding="utf-8") == "external\n"

    @pytest.mark.parametrize(
        "kind",
        ["outside-glob", "binary", "lfs", "symlink", "directory", "too-large"],
    )
    def test_unsafe_targets_are_refused(
        self, course_root: Path, tmp_path: Path, kind: str
    ) -> None:
        path = course_root / "work" / "answer.txt"
        if kind == "outside-glob":
            request = _workspace_request(course_root)
            request["target"] = {"path": "lesson.md"}
        elif kind == "binary":
            path.write_bytes(b"\x00binary")
            request = _workspace_request(course_root)
        elif kind == "lfs":
            path.write_text(
                "version https://git-lfs.github.com/spec/v1\n"
                "oid sha256:abc\nsize 10\n",
                encoding="utf-8",
            )
            request = _workspace_request(course_root)
        elif kind == "symlink":
            outside = tmp_path / "outside.txt"
            outside.write_text("outside\n", encoding="utf-8")
            path.symlink_to(outside)
            request = _workspace_request(course_root)
        elif kind == "directory":
            path.mkdir()
            request = _workspace_request(course_root)
        else:
            path.write_text("x" * (1024 * 1024 + 1), encoding="utf-8")
            request = _workspace_request(course_root)

        store = CourseStore(course_root)
        with pytest.raises(InvalidProposalError):
            store.create_proposal(request, f"unsafe-{kind}")


class TestManifestProposal:
    def test_missing_manifest_replace_can_edit_reject_then_accept_once(self, tmp_path: Path) -> None:
        store = CourseStore(tmp_path, course_id="store-course")
        initial = _manifest_data()
        initial["title"] = "Initial Course"
        request = {
            "id": "missing-manifest",
            "type": "manifest_replace",
            "origin": "teacher_suggested",
            "summary": "Create an initial course",
            "target": "courseweave.json",
            "payload": {"manifest": initial},
            "target_hash": None,
        }
        proposal = store.create_proposal(request, "missing-create")
        assert proposal.target_hash is None
        rejected = store.reject_proposal(proposal.id, proposal.revision, "missing-reject")
        assert rejected.status == "rejected"
        assert not (tmp_path / "courseweave.json").exists()

        proposal = store.create_proposal({**request, "id": "missing-manifest-edited"}, "missing-create-edited")
        edited_manifest = _manifest_data()
        edited_manifest["title"] = "Edited Initial Course"
        edited = store.edit_proposal(
            proposal.id,
            proposal.revision,
            {"payload": {"manifest": edited_manifest}, "target_hash": None},
            "missing-edit",
        )
        accepted = store.accept_proposal(edited.id, edited.revision, "missing-accept")
        replay = store.accept_proposal(edited.id, edited.revision, "missing-accept")
        assert accepted == replay
        assert load_manifest(tmp_path).title == "Edited Initial Course"
        assert [item for item in store.get_state().audit if item.status == "accepted"] == [
            store.get_state().audit[-1]
        ]

    def test_manifest_replace_uses_exact_target_hash(self, course_root: Path) -> None:
        store = CourseStore(course_root)
        current = (course_root / "courseweave.json").read_bytes()
        changed = _manifest_data()
        changed["title"] = "Changed Course"
        store.create_proposal(
            {
                "id": "manifest-one",
                "type": "manifest_replace",
                "origin": "teacher_suggested",
                "summary": "Rename the course",
                "target": "courseweave.json",
                "payload": {"manifest": changed},
                "target_hash": hashlib.sha256(current).hexdigest(),
            },
            "create-manifest",
        )
        store.accept_proposal("manifest-one", 1, "accept-manifest")
        assert load_manifest(course_root).title == "Changed Course"


class TestCrashRecovery:
    def test_crash_before_intent_leaves_pending_proposal_and_target_untouched(
        self, course_root: Path
    ) -> None:
        target = course_root / "work" / "answer.txt"
        target.write_text("before\n", encoding="utf-8")

        def crash(point: str) -> None:
            if point == "before_intent":
                raise RuntimeError("injected crash before intent")

        store = CourseStore(course_root, crash_hook=crash)
        store.create_proposal(_workspace_request(course_root), "create-before-intent")
        with pytest.raises(RuntimeError, match="before intent"):
            store.accept_proposal("workspace-one", 1, "accept-before-intent")

        restarted = CourseStore(course_root)
        assert restarted.recover() == []
        assert restarted.list_proposals()[0].status == "pending"
        assert target.read_text(encoding="utf-8") == "before\n"

    @pytest.mark.parametrize(
        ("stage", "expected_status", "expected_text"),
        [
            ("after_intent", "failed", "before\n"),
            ("after_replace", "accepted", "after\n"),
            ("before_finalize", "accepted", "after\n"),
        ],
    )
    def test_recovery_is_exactly_once(
        self,
        course_root: Path,
        stage: str,
        expected_status: str,
        expected_text: str,
    ) -> None:
        target = course_root / "work" / "answer.txt"
        target.write_text("before\n", encoding="utf-8")

        def crash(point: str) -> None:
            if point == stage:
                raise RuntimeError(f"injected crash at {stage}")

        store = CourseStore(course_root, crash_hook=crash)
        store.create_proposal(_workspace_request(course_root), f"create-{stage}")
        with pytest.raises(RuntimeError, match="injected crash"):
            store.accept_proposal("workspace-one", 1, f"accept-{stage}")

        restarted = CourseStore(course_root)
        latest = restarted.list_proposals()[0]
        assert latest.status == expected_status
        assert target.read_text(encoding="utf-8") == expected_text
        assert restarted.recover() == []


class TestStateAndProposalAPI:
    def test_state_and_proposal_routes_use_common_contract(
        self, course_root: Path
    ) -> None:
        client = TestClient(create_app(course_root, capability_token=TOKEN))
        state = client.get("/api/state", headers=AUTH)
        assert state.status_code == 200
        assert state.json()["revision"] == 0

        patched = client.patch(
            "/api/state",
            headers={**AUTH, "Idempotency-Key": "api-prediction"},
            json={
                "expected_revision": 0,
                "origin": "student_requested",
                "operation": _prediction(),
            },
        )
        assert patched.status_code == 200
        assert patched.json()["revision"] == 1

        proposal = client.post(
            "/api/proposals",
            headers={**AUTH, "Idempotency-Key": "api-create-proposal"},
            json={
                "id": "api-profile",
                "type": "profile_patch",
                "origin": "student_requested",
                "summary": "Remember pace",
                "target": "learner_profile",
                "payload": {"changes": {"explanation": "balanced"}},
                "target_hash": None,
            },
        )
        assert proposal.status_code == 201
        consent = client.patch('/api/state', headers={**AUTH, 'Idempotency-Key':'consent'}, json={'origin':'student_requested','expected_revision':1,'operation':{'type':'set_preferences','preferences':{'enabled':True}}})
        assert consent.status_code == 200
        accepted = client.post(
            "/api/proposals/api-profile/accept",
            headers={**AUTH, "Idempotency-Key": "api-accept-proposal"},
            json={"expected_revision": 1},
        )
        assert accepted.status_code == 200
        assert client.get("/api/state", headers=AUTH).json()["preferences"] == {
            "enabled": True, "explanation": "balanced", "practice": "standard"
        }

    def test_api_conflicts_are_sanitized(self, course_root: Path) -> None:
        client = TestClient(create_app(course_root, capability_token=TOKEN))
        response = client.patch(
            "/api/state",
            headers={**AUTH, "Idempotency-Key": "stale-state"},
            json={
                "expected_revision": 99,
                "origin": "student_requested",
                "operation": _prediction(),
            },
        )
        assert response.status_code == 409
        assert response.json() == {
            "code": "revision_mismatch",
            "message": "The learner state changed; reload before saving.",
            "details": {},
        }

    def test_edit_list_and_reject_routes_share_the_proposal_lifecycle(
        self, course_root: Path
    ) -> None:
        client = TestClient(create_app(course_root, capability_token=TOKEN))
        created = client.post(
            "/api/proposals",
            headers={**AUTH, "Idempotency-Key": "create-editable"},
            json={
                "id": "editable",
                "type": "profile_patch",
                "origin": "student_requested",
                "summary": "Initial",
                "target": "learner_profile",
                "payload": {"changes": {"explanation": "detailed"}},
                "target_hash": None,
            },
        )
        assert created.status_code == 201
        edited = client.post(
            "/api/proposals/editable/edit",
            headers={**AUTH, "Idempotency-Key": "edit-editable"},
            json={
                "expected_revision": 1,
                "request": {
                    "summary": "Edited",
                    "payload": {"changes": {"explanation": "balanced"}},
                },
            },
        )
        assert (edited.status_code, edited.json()["revision"]) == (200, 2)
        listed = client.get("/api/proposals", headers=AUTH)
        assert [(item["id"], item["revision"]) for item in listed.json()] == [
            ("editable", 2)
        ]
        rejected = client.post(
            "/api/proposals/editable/reject",
            headers={**AUTH, "Idempotency-Key": "reject-editable"},
            json={"expected_revision": 2},
        )
        assert (rejected.status_code, rejected.json()["status"]) == (200, "rejected")

    @pytest.mark.parametrize("path", ["/api/state", "/api/proposals"])
    def test_unconfigured_store_routes_use_not_configured_envelope(
        self, path: str
    ) -> None:
        client = TestClient(create_app(None, capability_token=TOKEN))
        response = client.get(path, headers=AUTH)
        assert response.status_code == 409
        assert response.json() == {
            "code": "not_configured",
            "message": "No course root is configured.",
            "details": {},
        }


def test_sqlite_contains_no_ephemeral_or_provider_columns(course_root: Path) -> None:
    store = CourseStore(course_root)
    store.get_state()
    db = CourseStore(course_root).db_path
    with sqlite3.connect(db) as connection:
        schema = "\n".join(
            row[0]
            for row in connection.execute(
                "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL"
            )
        ).lower()
    for forbidden in (
        "active_path",
        "chat_history",
        "shared_excerpt",
        "api_key",
        "provider_settings",
    ):
        assert forbidden not in schema


def test_corrupt_learner_state_is_preserved_and_reported(
    course_root: Path,
) -> None:
    CourseStore(course_root)
    db = CourseStore(course_root).db_path
    with sqlite3.connect(db) as connection:
        connection.execute(
            "UPDATE learner_state SET json = ? WHERE singleton = 1",
            ('{"revision":"not-an-integer"}',),
        )
        connection.commit()
    before = db.read_bytes()
    with pytest.raises(StoreCorruptError):
        CourseStore(course_root).get_state()
    assert db.read_bytes() == before
