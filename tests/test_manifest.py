"""Task 1 manifest behavior, driven by literal schema-v1 fixtures."""

from __future__ import annotations

import hashlib
import json
from copy import deepcopy
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from courseweave.api import create_app
from courseweave.manifest import (
    ETagMismatchError,
    ManifestValidationError,
    empty_manifest_draft,
    load_manifest,
    manifest_bytes,
    manifest_etag,
    parse_manifest_data,
    save_manifest,
    validate_runnable,
)

TOKEN = "task-1-capability-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}

POLICIES = {
    "content_sharing": "explicit_only",
    "durable_mutation": "proposal_or_direct_student_action",
    "terminal_execution": "student_only",
    "conversation_memory": "session_only",
    "max_shared_chars": 8192,
    "workspace_write_globs": ["work/*.py", "notes/*.md"],
}

CAPABILITIES = {
    "chat": True,
    "hint_level": "graduated",
    "share_selection": True,
    "share_cell": True,
    "share_output": False,
    "create_profile_proposal": False,
    "create_course_proposal": False,
    "create_workspace_proposal": True,
}

VALID_ALL_VARIANTS = {
    "schema_version": 1,
    "id": "all-variants",
    "title": "All manifest variants",
    "description": "A literal fixture covering every surface and completion form.",
    "entry_module_id": "module-one",
    "policies": POLICIES,
    "modules": [
        {
            "id": "module-one",
            "title": "Module One",
            "description": "",
            "phases": [
                {
                    "id": "read-html",
                    "title": "Read HTML",
                    "kind": "read",
                    "teacher_mode": "reading_companion",
                    "surfaces": [
                        {
                            "id": "lesson-html",
                            "type": "html",
                            "role": "primary",
                            "path": "lesson.html",
                        },
                        {
                            "id": "lesson-markdown",
                            "type": "markdown",
                            "role": "reference",
                            "path": "lesson.md",
                        },
                        {
                            "id": "lesson-source",
                            "type": "source",
                            "role": "evidence",
                            "path": "src/example.py",
                        },
                    ],
                    "completion": {"type": "manual"},
                    "capabilities": CAPABILITIES,
                },
                {
                    "id": "predict-notebook",
                    "title": "Predict in notebook",
                    "kind": "predict",
                    "teacher_mode": "socratic_guide",
                    "surfaces": [
                        {
                            "id": "exercise-notebook",
                            "type": "notebook",
                            "role": "exercise",
                            "path": "notebooks/exercise.ipynb",
                            "match": {
                                "cell_ids": ["cell-real-uuid"],
                                "cell_tags": ["prediction"],
                            },
                        }
                    ],
                    "completion": {
                        "type": "prediction_recorded",
                        "record_id": "prediction-one",
                    },
                    "capabilities": CAPABILITIES,
                },
                {
                    "id": "watch-local",
                    "title": "Watch local segment",
                    "kind": "watch",
                    "teacher_mode": "orienter",
                    "surfaces": [
                        {
                            "id": "local-video",
                            "type": "video",
                            "role": "primary",
                            "path": "media/lesson.mp4",
                            "start_seconds": 2.5,
                            "end_seconds": 8.0,
                        }
                    ],
                    "completion": {
                        "type": "receipt_recorded",
                        "record_id": "video-receipt",
                    },
                    "capabilities": CAPABILITIES,
                },
                {
                    "id": "watch-remote",
                    "title": "Watch remote segment",
                    "kind": "watch",
                    "teacher_mode": "orienter",
                    "surfaces": [
                        {
                            "id": "remote-video",
                            "type": "video",
                            "role": "reference",
                            "url": "https://cdn.example.test/lesson.mp4",
                            "start_seconds": 0,
                            "end_seconds": 12,
                        }
                    ],
                    "completion": {"type": "manual"},
                    "capabilities": CAPABILITIES,
                },
                {
                    "id": "lab-terminal",
                    "title": "Run the lab",
                    "kind": "lab",
                    "teacher_mode": "debugging_coach",
                    "surfaces": [
                        {
                            "id": "lab-terminal",
                            "type": "terminal",
                            "role": "exercise",
                            "label": "Run tests",
                            "argv": ["uv", "run", "pytest", "-q"],
                            "cwd": ".",
                        },
                        {
                            "id": "reference-link",
                            "type": "external",
                            "role": "reference",
                            "url": "https://docs.example.test/course",
                        },
                    ],
                    "completion": {
                        "type": "artifact_exists",
                        "record_id": "lab-artifact",
                        "path": "work/result.json",
                    },
                    "capabilities": CAPABILITIES,
                },
            ],
        }
    ],
}

EMPTY_COURSE = {
    "schema_version": 1,
    "id": "empty-course",
    "title": "Empty Course",
    "description": "",
    "entry_module_id": None,
    "policies": {
        "content_sharing": "explicit_only",
        "durable_mutation": "proposal_or_direct_student_action",
        "terminal_execution": "student_only",
        "conversation_memory": "session_only",
        "max_shared_chars": 4096,
        "workspace_write_globs": [],
    },
    "modules": [],
}


def _write_runnable_files(root: Path) -> None:
    (root / "src").mkdir()
    (root / "notebooks").mkdir()
    (root / "media").mkdir()
    (root / "work").mkdir()
    (root / "lesson.html").write_text("<h1>Lesson</h1>\n", encoding="utf-8")
    (root / "lesson.md").write_text("# Lesson\n", encoding="utf-8")
    (root / "src/example.py").write_text("answer = 42\n", encoding="utf-8")
    (root / "notebooks/exercise.ipynb").write_text("{}\n", encoding="utf-8")
    (root / "media/lesson.mp4").write_bytes(b"\x00\x00\x00\x18ftypmp42video")


class TestNormativeAndCrossRecordValidation:
    def test_literal_fixture_covers_every_surface_and_completion_variant(
        self, tmp_path: Path
    ) -> None:
        manifest = parse_manifest_data(VALID_ALL_VARIANTS, tmp_path)
        assert [surface.type for phase in manifest.modules[0].phases for surface in phase.surfaces] == [
            "html",
            "markdown",
            "source",
            "notebook",
            "video",
            "video",
            "terminal",
            "external",
        ]
        assert [phase.completion.type for phase in manifest.modules[0].phases] == [
            "manual",
            "prediction_recorded",
            "receipt_recorded",
            "manual",
            "artifact_exists",
        ]

    @pytest.mark.parametrize(
        ("mutation", "expected_fragment"),
        [
            (("module-duplicate",), "duplicate module id"),
            (("phase-duplicate",), "duplicate phase id"),
            (("surface-duplicate",), "duplicate surface id"),
            (("missing-entry",), "entry_module_id"),
            (("null-entry-with-modules",), "entry_module_id"),
            (("non-null-entry-empty",), "entry_module_id"),
        ],
    )
    def test_cross_record_invalid_fixtures_are_rejected(
        self, tmp_path: Path, mutation: tuple[str], expected_fragment: str
    ) -> None:
        data = deepcopy(VALID_ALL_VARIANTS)
        name = mutation[0]
        if name == "module-duplicate":
            data["modules"].append(deepcopy(data["modules"][0]))
        elif name == "phase-duplicate":
            data["modules"][0]["phases"].append(
                deepcopy(data["modules"][0]["phases"][0])
            )
        elif name == "surface-duplicate":
            data["modules"][0]["phases"][0]["surfaces"][1]["id"] = "lesson-html"
        elif name == "missing-entry":
            data["entry_module_id"] = "not-a-module"
        elif name == "null-entry-with-modules":
            data["entry_module_id"] = None
        elif name == "non-null-entry-empty":
            data = deepcopy(EMPTY_COURSE)
            data["entry_module_id"] = "not-a-module"

        with pytest.raises(ManifestValidationError, match=expected_fragment):
            parse_manifest_data(data, tmp_path)

    def test_empty_course_is_structurally_valid(self, tmp_path: Path) -> None:
        manifest = parse_manifest_data(EMPTY_COURSE, tmp_path)
        assert manifest.modules == []
        assert manifest.entry_module_id is None

    @pytest.mark.parametrize(
        ("change", "expected_fragment"),
        [
            ({"unexpected": True}, "Additional properties"),
            ({"schema_version": 2}, "1 was expected"),
            ({"title": "   "}, "does not match"),
            ({"id": "Not A Slug"}, "does not match"),
        ],
    )
    def test_normative_schema_rejects_unexpected_or_malformed_fields(
        self, tmp_path: Path, change: dict[str, object], expected_fragment: str
    ) -> None:
        data = deepcopy(EMPTY_COURSE)
        data.update(change)
        with pytest.raises(ManifestValidationError, match=expected_fragment):
            parse_manifest_data(data, tmp_path)

    @pytest.mark.parametrize(
        "surface",
        [
            {
                "id": "bad-video",
                "type": "video",
                "role": "primary",
                "path": "media/a.mp4",
                "url": "https://example.test/a.mp4",
            },
            {"id": "bad-video", "type": "video", "role": "primary"},
            {
                "id": "bad-video",
                "type": "video",
                "role": "primary",
                "path": "media/a.mp4",
                "start_seconds": 8,
                "end_seconds": 8,
            },
            {
                "id": "bad-video",
                "type": "video",
                "role": "primary",
                "path": "media/a.mp4",
                "start_seconds": 9,
                "end_seconds": 8,
            },
            {
                "id": "bad-video",
                "type": "video",
                "role": "primary",
                "url": "http://example.test/a.mp4",
            },
        ],
    )
    def test_video_source_ranges_and_https_are_enforced(
        self, tmp_path: Path, surface: dict[str, object]
    ) -> None:
        data = deepcopy(VALID_ALL_VARIANTS)
        data["modules"][0]["phases"][2]["surfaces"] = [surface]
        with pytest.raises(ManifestValidationError):
            parse_manifest_data(data, tmp_path)

    def test_external_surface_requires_https(self, tmp_path: Path) -> None:
        data = deepcopy(VALID_ALL_VARIANTS)
        data["modules"][0]["phases"][4]["surfaces"][1]["url"] = (
            "http://docs.example.test/course"
        )
        with pytest.raises(ManifestValidationError):
            parse_manifest_data(data, tmp_path)


class TestPathAndRunnableValidation:
    @pytest.mark.parametrize(
        "bad_path",
        ["/tmp/lesson.md", "../lesson.md", "a/../b.md", r"..\lesson.md"],
    )
    def test_absolute_and_parent_paths_are_rejected(
        self, tmp_path: Path, bad_path: str
    ) -> None:
        data = deepcopy(VALID_ALL_VARIANTS)
        data["modules"][0]["phases"][0]["surfaces"][1]["path"] = bad_path
        with pytest.raises(ManifestValidationError):
            parse_manifest_data(data, tmp_path)

    def test_existing_symlink_escape_is_rejected(self, tmp_path: Path) -> None:
        outside = tmp_path.parent / f"{tmp_path.name}-outside"
        outside.mkdir()
        (tmp_path / "escape").symlink_to(outside, target_is_directory=True)
        data = deepcopy(VALID_ALL_VARIANTS)
        data["modules"][0]["phases"][0]["surfaces"][1]["path"] = "escape/file.md"
        with pytest.raises(ManifestValidationError, match="course root"):
            parse_manifest_data(data, tmp_path)

    def test_structural_validation_allows_missing_local_files_and_future_artifact(
        self, tmp_path: Path
    ) -> None:
        manifest = parse_manifest_data(VALID_ALL_VARIANTS, tmp_path)
        assert manifest.modules[0].phases[-1].completion.path == "work/result.json"

    def test_runnable_validation_accumulates_sorted_path_issues(self, tmp_path: Path) -> None:
        data = deepcopy(VALID_ALL_VARIANTS)
        phase = data["modules"][0]["phases"][0]
        phase["surfaces"] = [
            {"id": "missing", "type": "markdown", "role": "primary", "path": "missing.md"},
            {"id": "cwd", "type": "terminal", "role": "exercise", "label": "Run", "argv": ["echo"], "cwd": "missing-cwd"},
            {"id": "lfs", "type": "video", "role": "reference", "path": "video.mp4"},
        ]
        data["modules"][0]["phases"] = [phase]
        (tmp_path / "video.mp4").write_bytes(b"version https://git-lfs.github.com/spec/v1\n")
        parsed = parse_manifest_data(data, tmp_path)

        with pytest.raises(ManifestValidationError) as raised:
            validate_runnable(parsed, tmp_path)

        assert raised.value.issues == [
            {"path": "/modules/0/phases/0/surfaces/0/path", "code": "missing_artifact", "message": "A required local surface is missing."},
            {"path": "/modules/0/phases/0/surfaces/1/cwd", "code": "invalid_terminal_cwd", "message": "A terminal working directory is required."},
            {"path": "/modules/0/phases/0/surfaces/2/path", "code": "lfs_pointer", "message": "A local video cannot be a Git LFS pointer."},
        ]

    def test_runnable_validation_requires_ordinary_local_surface_files(
        self, tmp_path: Path
    ) -> None:
        manifest = parse_manifest_data(VALID_ALL_VARIANTS, tmp_path)
        with pytest.raises(ManifestValidationError, match="lesson.html"):
            validate_runnable(manifest, tmp_path)

    def test_runnable_validation_allows_missing_future_artifact(
        self, tmp_path: Path
    ) -> None:
        _write_runnable_files(tmp_path)
        manifest = parse_manifest_data(VALID_ALL_VARIANTS, tmp_path)
        validate_runnable(manifest, tmp_path)
        assert not (tmp_path / "work/result.json").exists()

    def test_runnable_validation_rejects_git_lfs_pointer_video(
        self, tmp_path: Path
    ) -> None:
        _write_runnable_files(tmp_path)
        (tmp_path / "media/lesson.mp4").write_text(
            "version https://git-lfs.github.com/spec/v1\n"
            "oid sha256:0123456789abcdef\n"
            "size 12345\n",
            encoding="utf-8",
        )
        manifest = parse_manifest_data(VALID_ALL_VARIANTS, tmp_path)
        with pytest.raises(ManifestValidationError, match="Git LFS pointer"):
            validate_runnable(manifest, tmp_path)


class TestLoadExportAndETag:
    def test_packaged_schema_is_byte_identical_to_normative_contract(self) -> None:
        root = Path(__file__).parents[1]
        assert (root / "src/courseweave/courseweave.schema.json").read_bytes() == (
            root / "docs/contracts/courseweave.schema.json"
        ).read_bytes()

    def test_malformed_json_is_rejected(self, tmp_path: Path) -> None:
        (tmp_path / "courseweave.json").write_text('{"schema_version":', encoding="utf-8")
        with pytest.raises(ManifestValidationError, match="Malformed JSON"):
            load_manifest(tmp_path)

    def test_missing_manifest_returns_no_implicit_file(self, tmp_path: Path) -> None:
        draft = empty_manifest_draft(tmp_path)
        assert draft.schema_version == 1
        assert draft.entry_module_id is None
        assert draft.modules == []
        assert not (tmp_path / "courseweave.json").exists()

    def test_empty_draft_clamps_a_maximum_length_directory_title(
        self, tmp_path: Path
    ) -> None:
        root = tmp_path / ("a" * 255)
        draft = empty_manifest_draft(root)
        assert len(draft.id) == 80
        assert len(draft.title) == 240
        assert draft.modules == []
        assert not (root / "courseweave.json").exists()

    def test_export_is_deterministic_and_etag_hashes_exact_bytes(
        self, tmp_path: Path
    ) -> None:
        manifest = parse_manifest_data(EMPTY_COURSE, tmp_path)
        expected = (
            b'{\n'
            b'  "schema_version": 1,\n'
            b'  "id": "empty-course",\n'
            b'  "title": "Empty Course",\n'
            b'  "description": "",\n'
            b'  "entry_module_id": null,\n'
            b'  "policies": {\n'
            b'    "content_sharing": "explicit_only",\n'
            b'    "durable_mutation": "proposal_or_direct_student_action",\n'
            b'    "terminal_execution": "student_only",\n'
            b'    "conversation_memory": "session_only",\n'
            b'    "max_shared_chars": 4096,\n'
            b'    "workspace_write_globs": []\n'
            b'  },\n'
            b'  "modules": []\n'
            b'}\n'
        )
        assert manifest_bytes(manifest) == expected
        assert manifest_etag(expected) == f'"{hashlib.sha256(expected).hexdigest()}"'

    def test_save_is_compare_and_swap_and_stale_save_is_byte_identical(
        self, tmp_path: Path
    ) -> None:
        manifest = parse_manifest_data(EMPTY_COURSE, tmp_path)
        first = save_manifest(tmp_path, manifest, if_match='""')
        before = (tmp_path / "courseweave.json").read_bytes()
        assert first.etag == manifest_etag(before)

        changed_data = deepcopy(EMPTY_COURSE)
        changed_data["title"] = "Changed"
        changed = parse_manifest_data(changed_data, tmp_path)
        with pytest.raises(ETagMismatchError):
            save_manifest(tmp_path, changed, if_match='"stale"')
        assert (tmp_path / "courseweave.json").read_bytes() == before


class TestLiteralExampleCourses:
    @pytest.mark.parametrize("example_name", ["minimal-course", "cli-course"])
    def test_examples_are_saved_runnable_schema_v1_courses(
        self, example_name: str
    ) -> None:
        root = Path(__file__).parents[1] / "examples" / example_name
        manifest = load_manifest(root, runnable=True)
        assert manifest.schema_version == 1
        assert manifest.entry_module_id is not None
        assert manifest.modules[0].phases[0].surfaces[0].path == "lesson.md"

    def test_cli_example_is_structurally_distinct_from_minimal_example(self) -> None:
        examples = Path(__file__).parents[1] / "examples"
        minimal = load_manifest(examples / "minimal-course")
        cli = load_manifest(examples / "cli-course")
        assert len(minimal.modules[0].phases) == 1
        assert [surface.type for surface in cli.modules[0].phases[1].surfaces] == [
            "terminal"
        ]


class TestManifestAPI:
    def test_get_missing_manifest_returns_unsaved_empty_draft(self, tmp_path: Path) -> None:
        client = TestClient(create_app(tmp_path, capability_token=TOKEN))
        response = client.get("/api/course", headers=AUTH)
        assert response.status_code == 200
        assert response.headers["etag"] == '""'
        assert response.json()["modules"] == []
        assert response.json()["entry_module_id"] is None
        assert not (tmp_path / "courseweave.json").exists()

    def test_put_requires_headers_and_returns_normative_envelopes(
        self, tmp_path: Path
    ) -> None:
        client = TestClient(create_app(tmp_path, capability_token=TOKEN))
        response = client.put("/api/course", headers=AUTH, json=EMPTY_COURSE)
        assert response.status_code == 400
        assert response.json() == {
            "code": "validation_error",
            "message": "Manifest writes require If-Match, Idempotency-Key, and student_requested origin.",
            "details": {},
        }

    def test_put_saves_replays_same_key_and_conflicts_on_different_content(
        self, tmp_path: Path
    ) -> None:
        client = TestClient(create_app(tmp_path, capability_token=TOKEN))
        headers = {
            **AUTH,
            "If-Match": '""',
            "Idempotency-Key": "save-empty",
            "X-CourseWeave-Origin": "student_requested",
        }
        first = client.put("/api/course", headers=headers, json=EMPTY_COURSE)
        assert first.status_code == 200
        assert first.headers["etag"] == manifest_etag(
            (tmp_path / "courseweave.json").read_bytes()
        )
        replay = client.put("/api/course", headers=headers, json=EMPTY_COURSE)
        assert replay.status_code == 200
        assert replay.content == first.content
        assert replay.headers["etag"] == first.headers["etag"]

        changed = deepcopy(EMPTY_COURSE)
        changed["title"] = "Different content"
        conflict = client.put("/api/course", headers=headers, json=changed)
        assert conflict.status_code == 409
        assert conflict.json()["code"] == "idempotency_conflict"

    def test_put_rejects_stale_or_invalid_without_changing_existing_bytes(
        self, tmp_path: Path
    ) -> None:
        original = json.dumps(EMPTY_COURSE, separators=(",", ":")).encode()
        (tmp_path / "courseweave.json").write_bytes(original)
        client = TestClient(create_app(tmp_path, capability_token=TOKEN))
        changed = deepcopy(EMPTY_COURSE)
        changed["title"] = "Changed"

        stale = client.put(
            "/api/course",
            headers={
                **AUTH,
                "If-Match": '"stale"',
                "Idempotency-Key": "stale-save",
                "X-CourseWeave-Origin": "student_requested",
            },
            json=changed,
        )
        assert stale.status_code == 409
        assert stale.json()["code"] == "etag_mismatch"
        assert (tmp_path / "courseweave.json").read_bytes() == original

        changed["unexpected"] = True
        invalid = client.put(
            "/api/course",
            headers={
                **AUTH,
                "If-Match": manifest_etag(original),
                "Idempotency-Key": "invalid-save",
                "X-CourseWeave-Origin": "student_requested",
            },
            json=changed,
        )
        assert invalid.status_code == 422
        assert invalid.json()["code"] == "validation_error"
        assert (tmp_path / "courseweave.json").read_bytes() == original

    def test_put_rejects_invalid_utf8_as_malformed_json_without_mutation(
        self, tmp_path: Path
    ) -> None:
        original = json.dumps(EMPTY_COURSE, separators=(",", ":")).encode()
        (tmp_path / "courseweave.json").write_bytes(original)
        client = TestClient(create_app(tmp_path, capability_token=TOKEN))
        response = client.put(
            "/api/course",
            headers={
                **AUTH,
                "If-Match": manifest_etag(original),
                "Idempotency-Key": "invalid-utf8",
                "X-CourseWeave-Origin": "student_requested",
                "Content-Type": "application/json",
            },
            content=b"\xff",
        )
        assert response.status_code == 422
        assert response.json() == {
            "code": "validation_error",
            "message": "Malformed JSON.",
            "details": {},
        }
        assert (tmp_path / "courseweave.json").read_bytes() == original
