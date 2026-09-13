"""Task 1 deterministic metadata-only context behavior."""

from __future__ import annotations


from copy import deepcopy
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from courseweave.api import create_app
from courseweave.context import (
    ContextConflictError,
    ContextRegistry,
    StaleContextError,
    resolve_context,
)
from courseweave.manifest import manifest_bytes, parse_manifest_data
from courseweave.models import ResolutionState, WorkspaceContext

TOKEN = "context-capability-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}

CONTEXT_MANIFEST = {'schema_version': 2,
 'id': 'context-course',
 'title': 'Context Course',
 'description': '',
 'entry_module_id': 'alpha',
 'runtime': {'type': 'jupyter', 'kernel': {'type': 'python_uv_project'}},
 'policies': {'content_sharing': 'explicit_only',
              'allowed_share_kinds': ['cell', 'output', 'selection'],
              'max_shared_chars': 8192,
              'allowed_proposal_types': [],
              'durable_mutation': 'proposal_or_direct_student_action',
              'terminal_execution': 'student_only',
              'conversation_memory': 'session_only',
              'workspace_write_globs': []},
 'modules': [{'id': 'alpha',
              'title': 'Alpha',
              'description': '',
              'phases': [{'id': 'entry',
                          'title': 'Entry',
                          'progress': 'required',
                          'experience': {'type': 'builtin', 'id': 'orientation'},
                          'surfaces': [{'id': 'entry-doc',
                                        'purpose': 'primary',
                                        'type': 'markdown',
                                        'label': 'entry-doc',
                                        'path': 'lesson.md'}],
                          'completion': {'requirements': [{'id': 'acknowledgement',
                                                           'type': 'learner_record',
                                                           'record_kind': 'attestation',
                                                           'prompt': 'Confirm completion of '
                                                                     'Entry.'}]},
                          'teacher': {'access': {'mode': 'available', 'requires': []},
                                      'guidance': {'style': {'type': 'builtin', 'id': 'orienting'},
                                                   'hint_level': 'gentle'},
                                      'sharing': {'allow': ['selection']},
                                      'proposals': {'allow': []}}},
                         {'id': 'cell-one',
                          'title': 'Cell One',
                          'progress': 'required',
                          'experience': {'type': 'builtin', 'id': 'prediction'},
                          'surfaces': [{'id': 'shared-notebook-cell-one',
                                        'purpose': 'supporting',
                                        'type': 'notebook',
                                        'label': 'shared-notebook-cell-one',
                                        'path': 'notebooks/shared.ipynb',
                                        'selector': {'type': 'cell_ids',
                                                     'values': ['real-cell-one']}},
                                       {'id': 'shared-notebook-cell-one-tags',
                                        'purpose': 'supporting',
                                        'type': 'notebook',
                                        'label': 'shared-notebook-cell-one-tags',
                                        'path': 'notebooks/shared.ipynb',
                                        'selector': {'type': 'cell_tags',
                                                     'values': ['first-tag'],
                                                     'match': 'any'}}],
                          'completion': {'requirements': [{'id': 'acknowledgement',
                                                           'type': 'learner_record',
                                                           'record_kind': 'attestation',
                                                           'prompt': 'Confirm completion of Cell '
                                                                     'One.'}]},
                          'teacher': {'access': {'mode': 'available', 'requires': []},
                                      'guidance': {'style': {'type': 'builtin', 'id': 'socratic'},
                                                   'hint_level': 'graduated'},
                                      'sharing': {'allow': ['cell', 'output']},
                                      'proposals': {'allow': []}}},
                         {'id': 'cell-two',
                          'title': 'Cell Two',
                          'progress': 'required',
                          'experience': {'type': 'builtin', 'id': 'experiment'},
                          'surfaces': [{'id': 'shared-notebook-cell-two',
                                        'purpose': 'supporting',
                                        'type': 'notebook',
                                        'label': 'shared-notebook-cell-two',
                                        'path': 'notebooks/shared.ipynb',
                                        'selector': {'type': 'cell_ids',
                                                     'values': ['real-cell-two']}},
                                       {'id': 'shared-notebook-cell-two-tags',
                                        'purpose': 'supporting',
                                        'type': 'notebook',
                                        'label': 'shared-notebook-cell-two-tags',
                                        'path': 'notebooks/shared.ipynb',
                                        'selector': {'type': 'cell_tags',
                                                     'values': ['second-tag'],
                                                     'match': 'any'}}],
                          'completion': {'requirements': [{'id': 'acknowledgement',
                                                           'type': 'learner_record',
                                                           'record_kind': 'attestation',
                                                           'prompt': 'Confirm completion of Cell '
                                                                     'Two.'}]},
                          'teacher': {'access': {'mode': 'available', 'requires': []},
                                      'guidance': {'style': {'type': 'builtin', 'id': 'debugging'},
                                                   'hint_level': 'graduated'},
                                      'sharing': {'allow': ['cell', 'output']},
                                      'proposals': {'allow': []}}},
                         {'id': 'video-a',
                          'title': 'Video A',
                          'progress': 'required',
                          'experience': {'type': 'builtin', 'id': 'media'},
                          'surfaces': [{'id': 'video-segment-a',
                                        'purpose': 'primary',
                                        'type': 'video',
                                        'label': 'video-segment-a',
                                        'src': 'media/shared.mp4',
                                        'start_seconds': 0,
                                        'end_seconds': 10}],
                          'completion': {'requirements': [{'id': 'acknowledgement',
                                                           'type': 'learner_record',
                                                           'record_kind': 'attestation',
                                                           'prompt': 'Confirm completion of Video '
                                                                     'A.'}]},
                          'teacher': {'access': {'mode': 'available', 'requires': []},
                                      'guidance': {'style': {'type': 'builtin',
                                                             'id': 'explanatory'},
                                                   'hint_level': 'none'},
                                      'sharing': {'allow': []},
                                      'proposals': {'allow': []}}},
                         {'id': 'video-b',
                          'title': 'Video B',
                          'progress': 'required',
                          'experience': {'type': 'builtin', 'id': 'media'},
                          'surfaces': [{'id': 'video-segment-b',
                                        'purpose': 'primary',
                                        'type': 'video',
                                        'label': 'video-segment-b',
                                        'src': 'media/shared.mp4',
                                        'start_seconds': 10,
                                        'end_seconds': 20}],
                          'completion': {'requirements': [{'id': 'acknowledgement',
                                                           'type': 'learner_record',
                                                           'record_kind': 'attestation',
                                                           'prompt': 'Confirm completion of Video '
                                                                     'B.'}]},
                          'teacher': {'access': {'mode': 'available', 'requires': []},
                                      'guidance': {'style': {'type': 'builtin',
                                                             'id': 'explanatory'},
                                                   'hint_level': 'none'},
                                      'sharing': {'allow': []},
                                      'proposals': {'allow': []}}},
                         {'id': 'terminal',
                          'title': 'Terminal',
                          'progress': 'required',
                          'experience': {'type': 'builtin', 'id': 'practice'},
                          'surfaces': [{'id': 'run-tests',
                                        'purpose': 'supporting',
                                        'type': 'terminal',
                                        'label': 'Run tests',
                                        'command': ['uv', 'run', 'pytest'],
                                        'cwd': '.'}],
                          'completion': {'requirements': [{'id': 'acknowledgement',
                                                           'type': 'learner_record',
                                                           'record_kind': 'attestation',
                                                           'prompt': 'Confirm completion of '
                                                                     'Terminal.'}]},
                          'teacher': {'access': {'mode': 'available', 'requires': []},
                                      'guidance': {'style': {'type': 'builtin', 'id': 'debugging'},
                                                   'hint_level': 'graduated'},
                                      'sharing': {'allow': ['output']},
                                      'proposals': {'allow': []}}}]},
             {'id': 'beta',
              'title': 'Beta',
              'description': '',
              'phases': [{'id': 'beta-source',
                          'title': 'Beta source',
                          'progress': 'required',
                          'experience': {'type': 'builtin', 'id': 'review'},
                          'surfaces': [{'id': 'beta-source-file',
                                        'purpose': 'primary',
                                        'type': 'source',
                                        'label': 'beta-source-file',
                                        'path': 'src/beta.py'}],
                          'completion': {'requirements': [{'id': 'acknowledgement',
                                                           'type': 'learner_record',
                                                           'record_kind': 'attestation',
                                                           'prompt': 'Confirm completion of Beta '
                                                                     'source.'}]},
                          'teacher': {'access': {'mode': 'available', 'requires': []},
                                      'guidance': {'style': {'type': 'builtin', 'id': 'reviewing'},
                                                   'hint_level': 'full'},
                                      'sharing': {'allow': ['selection']},
                                      'proposals': {'allow': []}}}]}]}


def _context(**changes: object) -> WorkspaceContext:
    data: dict[str, object] = {
        "source_id": "jupyter-window-one",
        "sequence": 1,
        "active_path": None,
        "active_cell_id": None,
        "active_cell_tags": [],
        "surface_kind": None,
        "explicit_module_id": None,
        "explicit_phase_id": None,
        "video_seconds": None,
        "terminal_surface_id": None,
    }
    data.update(changes)
    return WorkspaceContext.model_validate(data)


@pytest.fixture
def manifest(tmp_path: Path):
    return parse_manifest_data(CONTEXT_MANIFEST, tmp_path)


class TestPureResolutionPrecedence:
    def test_explicit_valid_phase_wins_over_all_automatic_metadata(self, manifest) -> None:
        result = resolve_context(
            manifest,
            ResolutionState(last_module_id="alpha", last_phase_id="cell-two"),
            _context(
                explicit_module_id="beta",
                explicit_phase_id="beta-source",
                active_path="notebooks/shared.ipynb",
                active_cell_id="real-cell-one",
            ),
        )
        assert result.model_dump() == {
            "module_id": "beta",
            "phase_id": "beta-source",
            "surface_id": None,
            "reason": "explicit_phase",
        }

    def test_real_notebook_cell_id_precedes_tag_and_repeated_path(self, manifest) -> None:
        result = resolve_context(
            manifest,
            ResolutionState(),
            _context(
                active_path="notebooks/shared.ipynb",
                active_cell_id="real-cell-two",
                active_cell_tags=["first-tag"],
            ),
        )
        assert (result.phase_id, result.surface_id, result.reason) == (
            "cell-two",
            "shared-notebook-cell-two",
            "cell_id",
        )

    def test_notebook_tag_precedes_plain_repeated_path(self, manifest) -> None:
        result = resolve_context(
            manifest,
            ResolutionState(last_module_id="alpha", last_phase_id="cell-one"),
            _context(
                active_path="notebooks/shared.ipynb",
                active_cell_tags=["second-tag"],
            ),
        )
        assert (result.phase_id, result.reason) == ("cell-two", "cell_tag")

    @pytest.mark.parametrize(
        ("seconds", "expected_phase"),
        [(0.0, "video-a"), (9.999, "video-a"), (10.0, "video-b"), (19.999, "video-b")],
    )
    def test_video_segments_use_start_inclusive_end_exclusive_boundaries(
        self, manifest, seconds: float, expected_phase: str
    ) -> None:
        result = resolve_context(
            manifest,
            ResolutionState(),
            _context(active_path="media/shared.mp4", video_seconds=seconds),
        )
        assert (result.phase_id, result.reason) == (expected_phase, "video_segment")

    def test_exact_repeated_path_prefers_current_matching_phase(self, manifest) -> None:
        result = resolve_context(
            manifest,
            ResolutionState(last_module_id="alpha", last_phase_id="cell-two"),
            _context(active_path="notebooks/shared.ipynb"),
        )
        assert (result.phase_id, result.reason) == ("cell-two", "active_path")

    def test_exact_repeated_path_falls_back_to_manifest_order(self, manifest) -> None:
        result = resolve_context(
            manifest,
            ResolutionState(),
            _context(active_path="notebooks/shared.ipynb"),
        )
        assert (result.phase_id, result.reason) == ("cell-one", "active_path")

    def test_terminal_surface_id_matches_inside_current_module(self, manifest) -> None:
        result = resolve_context(
            manifest,
            ResolutionState(last_module_id="alpha", last_phase_id="entry"),
            _context(terminal_surface_id="run-tests"),
        )
        assert (result.phase_id, result.surface_id, result.reason) == (
            "terminal",
            "run-tests",
            "terminal_surface",
        )

    def test_surface_kind_matches_inside_explicit_current_module(self, manifest) -> None:
        result = resolve_context(
            manifest,
            ResolutionState(last_module_id="alpha", last_phase_id="entry"),
            _context(explicit_module_id="beta", surface_kind="source"),
        )
        assert (result.module_id, result.phase_id, result.reason) == (
            "beta",
            "beta-source",
            "surface_kind",
        )

    def test_unknown_file_uses_last_session_phase_then_entry(self, manifest) -> None:
        with_last = resolve_context(
            manifest,
            ResolutionState(last_module_id="alpha", last_phase_id="cell-two"),
            _context(active_path="unknown/file.py"),
        )
        assert (with_last.phase_id, with_last.reason) == ("cell-two", "last_phase")

        without_last = resolve_context(
            manifest, ResolutionState(), _context(active_path="unknown/file.py")
        )
        assert (without_last.module_id, without_last.phase_id, without_last.reason) == (
            "alpha",
            "entry",
            "entry_phase",
        )

    def test_empty_course_resolves_to_no_phase(self, tmp_path: Path) -> None:
        empty = deepcopy(CONTEXT_MANIFEST)
        empty["entry_module_id"] = None
        empty["modules"] = []
        manifest = parse_manifest_data(empty, tmp_path)
        result = resolve_context(manifest, ResolutionState(), _context())
        assert result.model_dump() == {
            "module_id": None,
            "phase_id": None,
            "surface_id": None,
            "reason": "empty_course",
        }


class TestMetadataOnlyAndOrdering:
    @pytest.mark.parametrize(
        "forbidden_field",
        ["selection", "content", "cell_content", "output", "terminal_output", "credentials"],
    )
    def test_automatic_context_rejects_content_fields(self, forbidden_field: str) -> None:
        data = _context().model_dump()
        data[forbidden_field] = "must not enter automatic context"
        with pytest.raises(ValidationError):
            WorkspaceContext.model_validate(data)

    def test_sources_order_independently_and_equal_identical_is_idempotent(
        self, manifest
    ) -> None:
        registry = ContextRegistry(manifest)
        a = registry.submit(_context(source_id="source-a", sequence=0))
        b = registry.submit(_context(source_id="source-b", sequence=0))
        replay = registry.submit(_context(source_id="source-a", sequence=0))
        assert a == replay
        assert a.reason == "entry_phase"
        assert b.reason == "entry_phase"
        assert registry.get("source-a").context.sequence == 0
        assert registry.get("source-b").context.sequence == 0

    def test_higher_replaces_lower_is_stale_equal_different_conflicts(
        self, manifest
    ) -> None:
        registry = ContextRegistry(manifest)
        registry.submit(
            _context(
                source_id="source-a",
                sequence=5,
                active_path="notebooks/shared.ipynb",
                active_cell_id="real-cell-one",
            )
        )
        replaced = registry.submit(
            _context(
                source_id="source-a",
                sequence=6,
                active_path="notebooks/shared.ipynb",
                active_cell_id="real-cell-two",
            )
        )
        assert replaced.phase_id == "cell-two"

        with pytest.raises(StaleContextError):
            registry.submit(_context(source_id="source-a", sequence=4))
        with pytest.raises(ContextConflictError):
            registry.submit(
                _context(
                    source_id="source-a",
                    sequence=6,
                    active_path="notebooks/shared.ipynb",
                    active_cell_id="real-cell-one",
                )
            )

    def test_new_registry_models_reload_and_allows_sequence_reset(self, manifest) -> None:
        before_reload = ContextRegistry(manifest)
        before_reload.submit(_context(source_id="source-a", sequence=99))
        after_reload = ContextRegistry(manifest)
        result = after_reload.submit(_context(source_id="source-a", sequence=0))
        assert result.reason == "entry_phase"
        assert after_reload.get("source-a").context.sequence == 0


class TestContextAPI:
    def _client(self, tmp_path: Path) -> TestClient:
        manifest = parse_manifest_data(CONTEXT_MANIFEST, tmp_path)
        (tmp_path / "courseweave.json").write_bytes(manifest_bytes(manifest))
        return TestClient(create_app(tmp_path, capability_token=TOKEN))

    def test_post_and_get_context_are_authenticated_and_metadata_only(
        self, tmp_path: Path
    ) -> None:
        client = self._client(tmp_path)
        payload = _context(
            source_id="api-source",
            sequence=0,
            active_path="notebooks/shared.ipynb",
            active_cell_id="real-cell-two",
        ).model_dump(mode="json")
        posted = client.post("/api/context", headers=AUTH, json=payload)
        assert posted.status_code == 200
        assert posted.json() == {
            "module_id": "alpha",
            "phase_id": "cell-two",
            "surface_id": "shared-notebook-cell-two",
            "reason": "cell_id",
        }
        current = client.get(
            "/api/context", headers=AUTH, params={"source_id": "api-source"}
        )
        assert current.status_code == 200
        assert current.json() == {
            "context": payload,
            "resolved": posted.json(),
        }

    def test_context_api_returns_stale_conflict_not_found_and_validation_envelopes(
        self, tmp_path: Path
    ) -> None:
        client = self._client(tmp_path)
        accepted = _context(source_id="api-source", sequence=2).model_dump(mode="json")
        assert client.post("/api/context", headers=AUTH, json=accepted).status_code == 200

        stale = deepcopy(accepted)
        stale["sequence"] = 1
        stale_response = client.post("/api/context", headers=AUTH, json=stale)
        assert stale_response.status_code == 409
        assert stale_response.json()["code"] == "stale_context"

        conflict = deepcopy(accepted)
        conflict["active_path"] = "different.py"
        conflict_response = client.post("/api/context", headers=AUTH, json=conflict)
        assert conflict_response.status_code == 409
        assert conflict_response.json()["code"] == "context_conflict"

        missing = client.get(
            "/api/context", headers=AUTH, params={"source_id": "missing-source"}
        )
        assert missing.status_code == 404
        assert missing.json()["code"] == "not_found"

        invalid = deepcopy(accepted)
        invalid["selection"] = "secret source text"
        invalid_response = client.post("/api/context", headers=AUTH, json=invalid)
        assert invalid_response.status_code == 422
        assert invalid_response.json()["code"] == "validation_error"
        assert "secret source text" not in invalid_response.text

    @pytest.mark.parametrize("params", [{}, {"source_id": ""}])
    def test_get_context_query_validation_uses_normative_error_envelope(
        self, tmp_path: Path, params: dict[str, str]
    ) -> None:
        client = self._client(tmp_path)
        response = client.get("/api/context", headers=AUTH, params=params)
        assert response.status_code == 422
        assert response.json() == {
            "code": "validation_error",
            "message": "The request is invalid.",
            "details": {},
        }
